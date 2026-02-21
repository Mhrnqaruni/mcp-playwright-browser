import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createPageManager } from './browser/pages.js';
import { takeA11ySnapshot } from './browser/snapshot.js';
import { ensureDomTracker, getDomContext, listFrames as listDomFrames, getFrameById as getDomFrameById } from './browser/dom-version.js';
import { getCaptureDefaults, listCaptureProfiles, normalizeCaptureProfile } from './browser/capture-profiles.js';
import { enforcePayloadCeiling } from './browser/payload-budget.js';
import { clickByBackendNodeId, hoverByBackendNodeId, scrollIntoViewIfNeeded, setValueByBackendNodeId } from './browser/cdp.js';
import { waitForBackendNode, waitForSelector, waitForText } from './browser/wait.js';
import { assertAllowedReadPath, assertAllowedWritePath } from './security/paths.js';
import { auditForm, fillForm } from './browser/forms.js';
import { ensureObservability, getNetworkRequest, listConsoleMessages, listNetworkRequests } from './browser/observability.js';
import {
  extractIndeedJobs,
  saveJobsToTxt,
  clickIndeedNextPage,
  detectIndeedAccessIssue,
  extractGoogleResults,
  detectGoogleBlocked,
  saveSearchResultsToTxt,
  tryAcceptGoogleConsent
} from './extractors.js';

const state = {
  browser: null,
  context: null,
  page: null, // legacy alias of the active page
  elements: new Map(),
  elementCacheContext: null,
  pageManager: createPageManager(),
  uidMaps: new WeakMap(),
  persistent: false,
  cdpConnected: false,
  cdpManaged: false,
  cdpAutoClose: false,
  chromeProcess: null,
  lastLaunch: null,
  requestSeq: 0,
  contextGeneration: 0,
  pageEventAttached: new WeakSet(),
  dialogs: [],
  dialogById: new Map(),
  dialogSeq: 0,
  downloads: [],
  downloadById: new Map(),
  downloadSeq: 0,
  popups: [],
  popupSeq: 0,
  captureProfile: 'light',
  responseBudgetBytes: 280000
};

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const TOOL_META_KEY = '__meta';
const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'switch',
  'spinbutton',
  'slider'
]);

function respond(data) {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      }
    ]
  };
}

function withToolMeta(payload, meta = {}) {
  if (!meta || typeof meta !== 'object' || Object.keys(meta).length === 0) return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...payload, [TOOL_META_KEY]: meta };
  }
  return { data: payload, [TOOL_META_KEY]: meta };
}

function extractToolMeta(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, meta: {} };
  }
  if (!Object.prototype.hasOwnProperty.call(payload, TOOL_META_KEY)) {
    return { payload, meta: {} };
  }
  const metaRaw = payload[TOOL_META_KEY];
  const meta = metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw) ? metaRaw : {};
  const cleaned = { ...payload };
  delete cleaned[TOOL_META_KEY];
  return { payload: cleaned, meta };
}

function nextRequestId() {
  state.requestSeq += 1;
  return `req-${Date.now()}-${state.requestSeq}`;
}

function unwrapToolPayload(result) {
  if (result === undefined) return {};
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    const text = result.content?.[0]?.text;
    if (typeof text !== 'string') return {};
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

function classifyErrorCode(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (!msg) return 'INTERNAL';
  if (msg.includes('timeout')) return 'TIMEOUT';
  if (msg.includes('not allowed') || msg.includes('permission') || msg.includes('forbidden')) return 'PERMISSION';
  if (
    msg.includes('stale') ||
    msg.includes('no uid map') ||
    msg.includes('unknown uid') ||
    msg.includes('run browser.list again') ||
    msg.includes('run browser.take_snapshot again')
  ) {
    return 'STALE_REF';
  }
  if (
    msg.includes('execution context was destroyed') ||
    msg.includes('target closed') ||
    msg.includes('navigation') ||
    msg.includes('net::')
  ) {
    return 'NAVIGATION';
  }
  if (
    msg.includes('not found') ||
    msg.includes('no open page') ||
    msg.includes('no element found') ||
    msg.includes('unknown requestid') ||
    msg.includes('unknown frameid')
  ) {
    return 'NOT_FOUND';
  }
  return 'INTERNAL';
}

function normalizeError(error) {
  const message = String(error?.message || error || 'Unknown error');
  const code = classifyErrorCode(error);
  const details = {};
  if (error?.name) details.name = String(error.name);
  if (error?.cause) details.cause = String(error.cause);
  return {
    code,
    message,
    ...(Object.keys(details).length ? { details } : {})
  };
}

async function getEnvelopeContext(meta = {}) {
  const page = meta.page || state.pageManager?.getActivePage?.() || state.page || null;
  if (!page) {
    return {
      page: null,
      pageId: null,
      url: null,
      title: null,
      domVersion: null,
      activeFrameId: null
    };
  }

  let frame = null;
  if (meta.frameId) {
    try {
      frame = getDomFrameById(page, meta.frameId);
    } catch {
      frame = null;
    }
  }
  if (!frame) frame = page.mainFrame();

  let pageId = null;
  try {
    pageId = state.pageManager?.getPageId?.(page) ?? null;
  } catch {
    pageId = null;
  }

  let url = null;
  let title = null;
  let domVersion = null;
  let activeFrameId = null;
  try {
    url = page.url();
  } catch {
    url = null;
  }
  try {
    if (!page.isClosed?.()) {
      title = await page.title();
    }
  } catch {
    title = null;
  }
  try {
    const ctx = getDomContext(page, frame);
    domVersion = ctx?.domVersion || null;
    activeFrameId = ctx?.frameId || null;
  } catch {
    domVersion = null;
    activeFrameId = null;
  }

  return { page, pageId, url, title, domVersion, activeFrameId };
}

async function buildEnvelope(payload, meta = {}) {
  const ctx = await getEnvelopeContext(meta);
  const base = {
    ok: Boolean(meta.ok),
    requestId: meta.requestId || nextRequestId(),
    timestamp: new Date().toISOString(),
    pageId: ctx.pageId,
    url: ctx.url,
    title: ctx.title,
    domVersion: ctx.domVersion,
    activeFrameId: ctx.activeFrameId
  };

  if (!base.ok && meta.error) {
    base.error = meta.error;
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const merged = { ...base };
    const reserveCollisionKey = (key) => {
      const raw = String(key || 'value');
      const normalized = raw.replace(/[^a-zA-Z0-9_]/g, '_');
      const candidate = `payload${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
      if (!Object.prototype.hasOwnProperty.call(merged, candidate)) return candidate;
      let i = 2;
      while (Object.prototype.hasOwnProperty.call(merged, `${candidate}_${i}`)) i += 1;
      return `${candidate}_${i}`;
    };

    for (const [key, value] of Object.entries(payload)) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        const collisionKey = reserveCollisionKey(key);
        merged[collisionKey] = value;
      } else {
        merged[key] = value;
      }
    }

    // Keep backwards compatibility for non-boolean payload "ok" values.
    if (Object.prototype.hasOwnProperty.call(payload, 'ok') && typeof payload.ok !== 'boolean') {
      merged.payloadOk = payload.ok;
    }
    return merged;
  }

  if (payload === undefined || payload === null) return base;
  return { ...base, data: payload };
}

function truncateText(text, maxChars) {
  if (!text) return '';
  const limit = typeof maxChars === 'number' ? maxChars : 0;
  if (limit <= 0 || text.length <= limit) return text;
  if (limit <= 3) return text.slice(0, limit);
  return text.slice(0, limit - 3) + '...';
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeKey(key) {
  const raw = String(key ?? '');
  if (raw === ' ') return 'Space';
  const trimmed = raw.trim();
  if (!trimmed && raw.includes(' ')) return 'Space';
  if (/^space(bar)?$/i.test(trimmed)) return 'Space';
  if (/^esc$/i.test(trimmed)) return 'Escape';
  // Playwright supports "Control+A" style combos; removing spaces makes those robust.
  return trimmed.replace(/\s*\+\s*/g, '+') || raw;
}

function normalizeCaptureDetail(detail) {
  return String(detail || 'low').toLowerCase() === 'high' ? 'high' : 'low';
}

function getActiveCaptureProfile() {
  return normalizeCaptureProfile(state.captureProfile || ENV_DEFAULTS.captureProfile || 'light');
}

function resetCaptureProfileToDefault() {
  state.captureProfile = normalizeCaptureProfile(ENV_DEFAULTS.captureProfile || 'light');
  return state.captureProfile;
}

function resolveCaptureDefaults(toolName, detail = 'low') {
  const profile = getActiveCaptureProfile();
  const normalizedDetail = normalizeCaptureDetail(detail);
  return getCaptureDefaults(profile, toolName, normalizedDetail);
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensurePage() {
  const page = state.pageManager?.getActivePage?.() || state.page;
  if (!page) {
    throw new Error('Browser is not launched. Run browser.launch or browser.connect_cdp first.');
  }
  ensureDomTracker(page);
  void ensurePageEventListeners(page);
  state.page = page;
  return page;
}

function getFrameScope(page, frame = null) {
  const target = frame || page.mainFrame();
  return target === page.mainFrame() ? page : target;
}

async function resolveFrame(page, opts = {}) {
  ensureDomTracker(page);
  const { frameId, frameSelector, timeoutMs } = opts || {};
  if (frameId) {
    const frame = getDomFrameById(page, frameId);
    if (!frame) {
      throw new Error(`Unknown frameId "${frameId}". Run browser.list_frames first.`);
    }
    return frame;
  }

  if (frameSelector) {
    const timeout = clampNumber(timeoutMs, 500, 120000, 15000);
    const locator = page.locator(frameSelector).first();
    await locator.waitFor({ state: 'attached', timeout });
    const handle = await locator.elementHandle();
    if (!handle) {
      throw new Error(`No frame element found for selector "${frameSelector}".`);
    }
    const frame = await handle.contentFrame();
    await handle.dispose();
    if (!frame) {
      throw new Error(`Selector "${frameSelector}" did not resolve to an iframe/frame element.`);
    }
    return frame;
  }

  return page.mainFrame();
}

function clearElementCache() {
  state.elements.clear();
  state.elementCacheContext = null;
}

function getElementCacheContextKey(page, frame = null) {
  const pageId = state.pageManager?.getPageId?.(page) ?? 0;
  const dom = getDomContext(page, frame);
  return `${pageId}:${dom.frameId}:${dom.frameDomVersion}`;
}

function setElementCacheContext(page, frame = null) {
  const key = getElementCacheContextKey(page, frame);
  state.elementCacheContext = key;
  return key;
}

function assertElementCacheFresh(page, frame = null) {
  const expected = getElementCacheContextKey(page, frame);
  if (!state.elementCacheContext || state.elementCacheContext !== expected) {
    throw new Error('Stale element cache detected after DOM/frame change. Run browser.list again.');
  }
  return expected;
}

function getCachedElement(page, frame, elementId) {
  const expected = assertElementCacheFresh(page, frame);
  const cached = state.elements.get(elementId);
  if (!cached) throw new Error(`No cached element for id ${elementId}. Run browser.list again.`);
  if (cached.contextKey !== expected) {
    throw new Error(`Cached element ${elementId} belongs to a stale page/frame snapshot. Run browser.list again.`);
  }
  return cached;
}

function resolveRootScopeSelector(page, frame, opts = {}) {
  const rawSelector = typeof opts.rootSelector === 'string' ? opts.rootSelector.trim() : '';
  const rootElementId = typeof opts.rootElementId === 'number' ? opts.rootElementId : null;

  if (rootElementId !== null) {
    const cached = getCachedElement(page, frame, rootElementId);
    if (!cached.selector) {
      throw new Error(`Cached root element ${rootElementId} has no selector. Re-run browser.list with includeSelectors=true.`);
    }
    return cached.selector;
  }

  return rawSelector || null;
}

function getOrCreateUidStore(page) {
  let store = state.uidMaps.get(page);
  if (!store) {
    store = { frames: new Map() };
    state.uidMaps.set(page, store);
  }
  return store;
}

function setUidMapForFrame(page, frame, uidToBackend) {
  const ctx = getDomContext(page, frame);
  const store = getOrCreateUidStore(page);
  store.frames.set(ctx.frameId, {
    createdAt: Date.now(),
    url: page.url(),
    domVersion: ctx.domVersion,
    uidToBackend
  });
  return ctx;
}

function getBackendNodeIdForUid(page, uid, frame = null) {
  const store = state.uidMaps.get(page);
  const frames = store?.frames;
  const requestedCtx = getDomContext(page, frame);
  const mainCtx = getDomContext(page, page.mainFrame());

  if (!frames) {
    throw new Error('No uid map available for this page. Run browser.take_snapshot first.');
  }

  const resolveEntry = (ctx) => {
    const entry = frames.get(ctx.frameId);
    if (!entry) return null;
    if (entry.domVersion && entry.domVersion !== ctx.domVersion) {
      throw new Error('Stale uid map detected after DOM change. Run browser.take_snapshot again.');
    }
    return entry;
  };

  let entry = resolveEntry(requestedCtx);
  if (!entry && requestedCtx.frameId !== mainCtx.frameId) {
    entry = resolveEntry(mainCtx);
  }
  if (!entry) {
    throw new Error(`No uid map available for frame "${requestedCtx.frameId}". Run browser.take_snapshot first.`);
  }

  let mapped = entry.uidToBackend?.get(uid);
  if (!mapped && requestedCtx.frameId !== mainCtx.frameId) {
    const mainEntry = resolveEntry(mainCtx);
    mapped = mainEntry?.uidToBackend?.get(uid);
  }

  const backendNodeId =
    mapped && typeof mapped === 'object' ? mapped.backendNodeId : mapped;

  if (!backendNodeId) {
    throw new Error(`Unknown uid "${uid}". Run browser.take_snapshot again and use a current uid.`);
  }
  return backendNodeId;
}

function withFrameMeta(page, frame, payload) {
  const ctx = getDomContext(page, frame);
  return withToolMeta(payload, { frameId: ctx.frameId });
}

const EXPECT_EVENT_ACTION_ALLOWLIST = new Set([
  'browser.click',
  'browser.press',
  'browser.goto',
  'browser.reload',
  'browser.back',
  'browser.forward',
  'browser.hover'
]);

function resetRuntimeQueues() {
  clearElementCache();
  state.contextGeneration += 1;
  state.uidMaps = new WeakMap();
  state.pageEventAttached = new WeakSet();
  state.dialogs = [];
  state.dialogById = new Map();
  state.dialogSeq = 0;
  state.downloads = [];
  state.downloadById = new Map();
  state.downloadSeq = 0;
  state.popups = [];
  state.popupSeq = 0;
}

function getPageIdSafe(page) {
  if (!page) return null;
  try {
    return state.pageManager?.getPageId?.(page) ?? null;
  } catch {
    return null;
  }
}

function pushBounded(queue, item, maxItems = 400) {
  queue.push(item);
  let dropped = [];
  if (queue.length > maxItems) {
    dropped = queue.splice(0, queue.length - maxItems);
  }
  return dropped;
}

async function ensurePageEventListeners(page) {
  if (!page || state.pageEventAttached.has(page)) return;
  state.pageEventAttached.add(page);
  const listenerGeneration = state.contextGeneration;

  page.on('dialog', async (dialog) => {
    if (listenerGeneration !== state.contextGeneration) return;
    state.dialogSeq += 1;
    const dialogId = `dlg-${state.dialogSeq}`;
    const entry = {
      dialogId,
      pageId: getPageIdSafe(page),
      type: String(dialog.type?.() || ''),
      message: String(dialog.message?.() || ''),
      defaultValue: String(dialog.defaultValue?.() || ''),
      createdAt: new Date().toISOString(),
      status: 'pending',
      resolution: null,
      handledAt: null,
      _dialog: dialog,
      _timer: null
    };
    state.dialogById.set(dialogId, entry);
    const dropped = pushBounded(state.dialogs, entry, 400);
    for (const stale of dropped) {
      if (stale?._timer) clearTimeout(stale._timer);
      if (stale?.dialogId) state.dialogById.delete(stale.dialogId);
    }

    const timeoutMs = 15000;
    entry._timer = setTimeout(async () => {
      if (listenerGeneration !== state.contextGeneration) return;
      if (entry.status !== 'pending') return;
      try {
        await dialog.dismiss();
        entry.status = 'auto-dismissed';
        entry.resolution = { action: 'dismiss', reason: 'timeout' };
        entry.handledAt = new Date().toISOString();
      } catch (error) {
        entry.status = 'error';
        entry.resolution = {
          action: 'dismiss',
          reason: 'timeout',
          error: String(error?.message || error || 'Failed to auto-dismiss dialog')
        };
        entry.handledAt = new Date().toISOString();
      }
    }, timeoutMs);
  });

  page.on('download', async (download) => {
    if (listenerGeneration !== state.contextGeneration) return;
    state.downloadSeq += 1;
    const downloadId = `dl-${state.downloadSeq}`;
    const item = {
      downloadId,
      pageId: getPageIdSafe(page),
      suggestedFilename: String(download.suggestedFilename?.() || ''),
      url: String(download.url?.() || ''),
      mimeType: null,
      createdAt: new Date().toISOString(),
      consumed: false,
      savedPath: null,
      _download: download
    };
    state.downloadById.set(downloadId, item);
    const dropped = pushBounded(state.downloads, item, 400);
    for (const stale of dropped) {
      if (stale?.downloadId) state.downloadById.delete(stale.downloadId);
    }
  });

  page.on('popup', async (popupPage) => {
    if (listenerGeneration !== state.contextGeneration) return;
    try {
      state.pageManager.attachPage(popupPage);
      await ensurePageEventListeners(popupPage);
      await ensureObservability(popupPage);
    } catch {
      // best effort
    }
    state.popupSeq += 1;
    pushBounded(state.popups, {
      popupId: `pop-${state.popupSeq}`,
      openerPageId: getPageIdSafe(page),
      pageId: getPageIdSafe(popupPage),
      createdAt: new Date().toISOString(),
      consumed: false,
      url: (() => {
        try {
          return popupPage.url();
        } catch {
          return '';
        }
      })()
    }, 200);
  });

  page.once('close', () => {
    state.pageEventAttached.delete(page);
  });
}

function buildUrlMatcher(pattern, regex) {
  if (!pattern) return () => true;
  if (regex) {
    let compiled;
    try {
      compiled = new RegExp(pattern);
    } catch {
      throw new Error(`Invalid regex pattern "${pattern}".`);
    }
    return (url) => compiled.test(String(url || ''));
  }
  const needle = String(pattern || '').toLowerCase();
  return (url) => String(url || '').toLowerCase().includes(needle);
}

async function runExpectAfterAction(page, afterAction) {
  if (!afterAction) return { executed: false };
  const toolName = String(afterAction.toolName || '').trim();
  if (!toolName) throw new Error('afterAction.toolName is required when afterAction is provided.');
  if (!EXPECT_EVENT_ACTION_ALLOWLIST.has(toolName)) {
    throw new Error(`afterAction.toolName "${toolName}" is not allowed.`);
  }
  const args = afterAction.args && typeof afterAction.args === 'object' ? afterAction.args : {};
  const timeout = clampNumber(args.timeoutMs, 1000, 120000, 30000);

  if (toolName === 'browser.goto') {
    if (!args.url) throw new Error('afterAction browser.goto requires args.url.');
    await page.goto(String(args.url), { waitUntil: args.waitUntil || 'domcontentloaded', timeout });
    clearElementCache();
    state.uidMaps.delete(page);
    return { executed: true, toolName };
  }

  if (toolName === 'browser.reload') {
    await page.reload({ waitUntil: args.waitUntil || 'domcontentloaded', timeout });
    clearElementCache();
    state.uidMaps.delete(page);
    return { executed: true, toolName };
  }

  if (toolName === 'browser.back') {
    await page.goBack({ waitUntil: args.waitUntil || 'domcontentloaded', timeout });
    clearElementCache();
    state.uidMaps.delete(page);
    return { executed: true, toolName };
  }

  if (toolName === 'browser.forward') {
    await page.goForward({ waitUntil: args.waitUntil || 'domcontentloaded', timeout });
    clearElementCache();
    state.uidMaps.delete(page);
    return { executed: true, toolName };
  }

  const frame = await resolveFrame(page, {
    frameId: typeof args.frameId === 'string' ? args.frameId : undefined,
    frameSelector: typeof args.frameSelector === 'string' ? args.frameSelector : undefined,
    timeoutMs: timeout
  });
  const scope = getFrameScope(page, frame);

  if (toolName === 'browser.click') {
    if (typeof args.selector === 'string' && args.selector.trim()) {
      await scope.click(args.selector, { timeout, force: Boolean(args.force) });
      clearElementCache();
      return { executed: true, toolName, frameId: getDomContext(page, frame).frameId };
    }
    if (typeof args.text === 'string' && args.text.trim()) {
      await scope.getByText(args.text, { exact: false }).first().click({ timeout, force: Boolean(args.force) });
      clearElementCache();
      return { executed: true, toolName, frameId: getDomContext(page, frame).frameId };
    }
    throw new Error('afterAction browser.click requires args.selector or args.text.');
  }

  if (toolName === 'browser.hover') {
    if (typeof args.selector === 'string' && args.selector.trim()) {
      await scope.hover(args.selector, { timeout, force: Boolean(args.force) });
      clearElementCache();
      return { executed: true, toolName, frameId: getDomContext(page, frame).frameId };
    }
    if (typeof args.text === 'string' && args.text.trim()) {
      await scope.getByText(args.text, { exact: false }).first().hover({ timeout, force: Boolean(args.force) });
      clearElementCache();
      return { executed: true, toolName, frameId: getDomContext(page, frame).frameId };
    }
    throw new Error('afterAction browser.hover requires args.selector or args.text.');
  }

  if (toolName === 'browser.press') {
    if (typeof args.selector === 'string' && args.selector.trim()) {
      await scope.focus(args.selector);
    }
    await page.keyboard.press(normalizeKey(args.key || 'Enter'));
    return { executed: true, toolName, frameId: getDomContext(page, frame).frameId };
  }

  throw new Error(`afterAction "${toolName}" is not implemented.`);
}

function getOriginOrNull(urlValue) {
  try {
    return new URL(String(urlValue || '')).origin;
  } catch {
    return null;
  }
}

function isOriginAllowed(origin, allowlist) {
  if (!origin) return false;
  const list = Array.isArray(allowlist) ? allowlist : [];
  if (!list.length) return true;

  const normalizedOrigin = origin.toLowerCase();
  for (const rawEntry of list) {
    const entry = String(rawEntry || '').trim();
    if (!entry) continue;
    if (entry === '*') return true;

    let normalizedEntry = entry.toLowerCase();
    try {
      normalizedEntry = new URL(entry).origin.toLowerCase();
    } catch {
      // Keep raw entry for exact string matching when it is not a full URL.
    }

    if (normalizedOrigin === normalizedEntry) return true;
  }
  return false;
}

function estimatePayloadBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Buffer.byteLength(String(value ?? ''), 'utf8');
  }
}

function assertPayloadWithinLimit(value, maxBytes) {
  const bytes = estimatePayloadBytes(value);
  if (bytes > maxBytes) {
    throw new Error(`Payload too large: ${bytes} bytes exceeds limit ${maxBytes}.`);
  }
  return bytes;
}

async function ensureDir(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  await fs.mkdir(dir, { recursive: true });
}

function readEnvValue(names) {
  for (const name of names) {
    if (!name) continue;
    const raw = process.env[name];
    if (raw !== undefined) return raw;
  }
  return undefined;
}

function parseEnvBool(name, altName) {
  const raw = readEnvValue([name, altName]);
  if (raw === undefined) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;
  return undefined;
}

function parseEnvNumber(name, altName) {
  const raw = readEnvValue([name, altName]);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isNaN(value) ? undefined : value;
}

function parseEnvString(name, altName) {
  const raw = readEnvValue([name, altName]);
  if (raw === undefined) return undefined;
  const value = String(raw).trim();
  return value ? value : undefined;
}

function parseEnvArgs(name, altName) {
  const raw = readEnvValue([name, altName]);
  if (!raw) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item)).filter(Boolean);
      }
    } catch {
      // fall back to split parsing
    }
  }
  return trimmed
    .split(/[;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const ENV_DEFAULTS = {
  headless: parseEnvBool('MCP_HEADLESS', 'GEMINI_CLI_MCP_HEADLESS'),
  slowMoMs: parseEnvNumber('MCP_SLOWMO_MS', 'GEMINI_CLI_MCP_SLOWMO_MS'),
  args: parseEnvArgs('MCP_ARGS', 'GEMINI_CLI_MCP_ARGS'),
  stealth: parseEnvBool('MCP_STEALTH', 'GEMINI_CLI_MCP_STEALTH'),
  channel: parseEnvString('MCP_CHANNEL', 'GEMINI_CLI_MCP_CHANNEL'),
  executablePath: parseEnvString('MCP_EXECUTABLE_PATH', 'GEMINI_CLI_MCP_EXECUTABLE_PATH'),
  userDataDir: parseEnvString('MCP_USER_DATA_DIR', 'GEMINI_CLI_MCP_USER_DATA_DIR'),
  profileDirectory: parseEnvString('MCP_PROFILE', 'GEMINI_CLI_MCP_PROFILE'),
  cdpEndpoint: parseEnvString('MCP_CDP_ENDPOINT', 'GEMINI_CLI_MCP_CDP_ENDPOINT'),
  cdpPort: parseEnvNumber('MCP_CDP_PORT', 'GEMINI_CLI_MCP_CDP_PORT'),
  cdpWaitMs: parseEnvNumber('MCP_CDP_WAIT_MS', 'GEMINI_CLI_MCP_CDP_WAIT_MS'),
  cdpAutoClose: parseEnvBool('MCP_CDP_AUTO_CLOSE', 'GEMINI_CLI_MCP_CDP_AUTO_CLOSE'),
  chromePath: parseEnvString('MCP_CHROME_PATH', 'GEMINI_CLI_MCP_CHROME_PATH'),
  forceCdp: parseEnvBool('MCP_FORCE_CDP', 'GEMINI_CLI_MCP_FORCE_CDP'),
  requireProfile: parseEnvBool('MCP_REQUIRE_PROFILE', 'GEMINI_CLI_MCP_REQUIRE_PROFILE'),
  allowEvaluate: parseEnvBool('MCP_ALLOW_EVALUATE', 'GEMINI_CLI_MCP_ALLOW_EVALUATE'),
  evaluateAllowOrigins: parseEnvArgs('MCP_EVALUATE_ALLOW_ORIGINS', 'GEMINI_CLI_MCP_EVALUATE_ALLOW_ORIGINS'),
  evaluateTimeoutMs: parseEnvNumber('MCP_EVALUATE_TIMEOUT_MS', 'GEMINI_CLI_MCP_EVALUATE_TIMEOUT_MS'),
  evaluateMaxBytes: parseEnvNumber('MCP_EVALUATE_MAX_BYTES', 'GEMINI_CLI_MCP_EVALUATE_MAX_BYTES'),
  captureProfile: parseEnvString('MCP_CAPTURE_PROFILE', 'GEMINI_CLI_MCP_CAPTURE_PROFILE'),
  maxResponseBytes: parseEnvNumber('MCP_MAX_RESPONSE_BYTES', 'GEMINI_CLI_MCP_MAX_RESPONSE_BYTES')
};

state.captureProfile = normalizeCaptureProfile(ENV_DEFAULTS.captureProfile || state.captureProfile || 'light');
state.responseBudgetBytes = clampNumber(ENV_DEFAULTS.maxResponseBytes, 32768, 2_000_000, state.responseBudgetBytes);

function hasDefaultChromeUserDataDir(userDataDir) {
  if (!userDataDir) return false;
  return /(^|\\)Google\\Chrome\\User Data(\\|$)/i.test(userDataDir);
}

function normalizeProfilePath(userDataDir, profileDirectory) {
  if (!userDataDir) {
    return { userDataDir, profileDirectory, warnings: [] };
  }
  const normalized = path.normalize(userDataDir);
  const base = path.basename(normalized);
  const warnings = [];
  const profileMatch = /^(Profile \d+|Default)$/i;
  if (profileMatch.test(base)) {
    const parent = path.dirname(normalized);
    if (profileDirectory && profileDirectory !== base) {
      warnings.push(
        `userDataDir pointed to "${base}" but profileDirectory was "${profileDirectory}". Using parent userDataDir with provided profileDirectory.`
      );
      return { userDataDir: parent, profileDirectory, warnings };
    }
    warnings.push(`userDataDir pointed to profile folder "${base}". Normalized to parent and set profileDirectory.`);
    return { userDataDir: parent, profileDirectory: base, warnings };
  }
  return { userDataDir, profileDirectory, warnings };
}

async function resolveChromePath(explicitPath) {
  if (explicitPath) return explicitPath;
  const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localAppData =
    process.env['LOCALAPPDATA'] || path.join(process.env['USERPROFILE'] || 'C:\\Users\\User', 'AppData\\Local');
  const candidates = [
    path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe')
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

function buildArgs(baseArgs, profileDirectory) {
  const args = Array.isArray(baseArgs) ? [...baseArgs] : [];
  if (profileDirectory) {
    const hasProfileArg = args.some((arg) => arg.startsWith('--profile-directory='));
    if (!hasProfileArg) {
      args.push(`--profile-directory=${profileDirectory}`);
    }
  }
  return args;
}

const server = new McpServer({
  name: 'playwright-browser',
  version: '1.0.0'
});

// Wrap every tool with a stable envelope + structured errors without rewriting each handler.
const rawRegisterTool = server.registerTool.bind(server);
server.registerTool = (name, definition, handler) =>
  rawRegisterTool(name, definition, async (args, extra) => {
    const requestId = nextRequestId();
    try {
      const result = await handler(args, extra);
      const rawPayload = unwrapToolPayload(result);
      const { payload, meta } = extractToolMeta(rawPayload);
      const wrapped = await buildEnvelope(payload, { ok: true, requestId, ...(meta || {}) });
      const budgeted = enforcePayloadCeiling(wrapped, {
        maxBytes: state.responseBudgetBytes
      });
      return respond(budgeted.payload);
    } catch (error) {
      const normalized = normalizeError(error);
      const wrapped = await buildEnvelope({ error: normalized }, { ok: false, requestId, error: normalized });
      const budgeted = enforcePayloadCeiling(wrapped, {
        maxBytes: state.responseBudgetBytes
      });
      return respond(budgeted.payload);
    }
  });

server.registerTool(
  'browser.set_capture_profile',
  {
    description: 'Set default capture profile used by snapshot/list/query tools in this session.',
    inputSchema: {
      profile: z.enum(['light', 'balanced', 'full']),
      responseBudgetBytes: z.number().optional()
    }
  },
  async ({ profile, responseBudgetBytes }) => {
    state.captureProfile = normalizeCaptureProfile(profile);
    if (typeof responseBudgetBytes === 'number') {
      state.responseBudgetBytes = clampNumber(responseBudgetBytes, 32768, 2_000_000, state.responseBudgetBytes);
    }

    return respond({
      status: 'capture-profile-set',
      profile: state.captureProfile,
      availableProfiles: listCaptureProfiles(),
      responseBudgetBytes: state.responseBudgetBytes,
      defaults: {
        snapshot: resolveCaptureDefaults('snapshot', 'low'),
        list: resolveCaptureDefaults('list', 'low'),
        queryDom: resolveCaptureDefaults('query_dom', 'low'),
        takeSnapshot: resolveCaptureDefaults('take_snapshot', 'low'),
        visualSnapshot: resolveCaptureDefaults('visual_snapshot', 'low')
      }
    });
  }
);

server.registerTool(
  'browser.get_capture_profile',
  {
    description: 'Get the active capture profile and response payload budget.',
    inputSchema: {}
  },
  async () => {
    const profile = getActiveCaptureProfile();
    return respond({
      profile,
      availableProfiles: listCaptureProfiles(),
      responseBudgetBytes: state.responseBudgetBytes,
      defaults: {
        snapshot: {
          low: resolveCaptureDefaults('snapshot', 'low'),
          high: resolveCaptureDefaults('snapshot', 'high')
        },
        list: {
          low: resolveCaptureDefaults('list', 'low'),
          high: resolveCaptureDefaults('list', 'high')
        },
        queryDom: {
          low: resolveCaptureDefaults('query_dom', 'low'),
          high: resolveCaptureDefaults('query_dom', 'high')
        },
        takeSnapshot: {
          low: resolveCaptureDefaults('take_snapshot', 'low'),
          high: resolveCaptureDefaults('take_snapshot', 'high')
        },
        visualSnapshot: {
          low: resolveCaptureDefaults('visual_snapshot', 'low'),
          high: resolveCaptureDefaults('visual_snapshot', 'high')
        }
      }
    });
  }
);

server.registerTool(
  'browser.launch',
  {
    description: 'Launch Chromium with Playwright and open a new page.',
    inputSchema: {
      headless: z.boolean().optional(),
      slowMoMs: z.number().optional(),
      args: z.array(z.string()).optional(),
      stealth: z.boolean().optional(),
      channel: z.string().optional(),
      executablePath: z.string().optional(),
      profileDirectory: z.string().optional(),
      viewport: z
        .object({
          width: z.number(),
          height: z.number()
        })
        .optional(),
      userAgent: z.string().optional(),
      userDataDir: z.string().optional()
    }
  },
  async ({
    headless,
    slowMoMs,
    viewport,
    userAgent,
    userDataDir,
    args,
    stealth,
    channel,
    executablePath,
    profileDirectory
  }) => {
    if (ENV_DEFAULTS.forceCdp) {
      throw new Error('browser.launch is disabled in CDP mode. Use browser.launch_chrome_cdp instead.');
    }
    const resolvedHeadless = headless ?? ENV_DEFAULTS.headless ?? false;
    const resolvedSlowMoMs = slowMoMs ?? ENV_DEFAULTS.slowMoMs ?? 0;
    const resolvedArgs = args ?? ENV_DEFAULTS.args ?? [];
    const resolvedStealth = stealth ?? ENV_DEFAULTS.stealth ?? false;
    const resolvedChannel = channel ?? ENV_DEFAULTS.channel;
    const resolvedExecutablePath = executablePath ?? ENV_DEFAULTS.executablePath;
    const resolvedUserDataDir = userDataDir ?? ENV_DEFAULTS.userDataDir;
    const resolvedProfileDirectory = profileDirectory ?? ENV_DEFAULTS.profileDirectory;
    const normalized = normalizeProfilePath(resolvedUserDataDir, resolvedProfileDirectory);
    const normalizedUserDataDir = normalized.userDataDir;
    const normalizedProfileDirectory = normalized.profileDirectory;

    if (resolvedChannel && resolvedExecutablePath) {
      throw new Error('Provide either channel or executablePath, not both.');
    }
    if (ENV_DEFAULTS.requireProfile && !normalizedUserDataDir) {
      throw new Error('Profile launch required but no userDataDir was provided. Check MCP_USER_DATA_DIR.');
    }
    if (normalizedProfileDirectory && !normalizedUserDataDir) {
      throw new Error('profileDirectory requires userDataDir (persistent context).');
    }
    if (normalizedUserDataDir && hasDefaultChromeUserDataDir(normalizedUserDataDir) && (resolvedChannel || resolvedExecutablePath)) {
      throw new Error(
        'Chrome blocks automation on the default "User Data" directory (Chrome 136+). Use a dedicated userDataDir (e.g. ChromeForMCP) or browser.launch_chrome_cdp.'
      );
    }
    if (state.context) {
      await state.context.close();
    } else if (state.browser) {
      await state.browser.close();
    }
    state.browser = null;
    state.context = null;
    state.page = null;
    state.persistent = false;
    state.cdpConnected = false;
    state.cdpManaged = false;
    state.cdpAutoClose = false;
    state.chromeProcess = null;
    state.pageManager.reset();
    resetRuntimeQueues();
    resetCaptureProfileToDefault();

    const launchArgs = buildArgs(resolvedArgs, normalizedProfileDirectory);
    state.lastLaunch = {
      headless: resolvedHeadless,
      slowMoMs: resolvedSlowMoMs,
      args: launchArgs,
      stealth: resolvedStealth,
      channel: resolvedChannel || null,
      executablePath: resolvedExecutablePath || null,
      userDataDir: normalizedUserDataDir || null,
      profileDirectory: normalizedProfileDirectory || null,
      userAgent: userAgent || null,
      viewport: viewport ?? DEFAULT_VIEWPORT
    };
    if (normalizedUserDataDir) {
      state.context = await chromium.launchPersistentContext(normalizedUserDataDir, {
        headless: resolvedHeadless,
        slowMo: resolvedSlowMoMs,
        viewport: viewport ?? DEFAULT_VIEWPORT,
        userAgent: userAgent || undefined,
        args: launchArgs,
        channel: resolvedChannel || undefined,
        executablePath: resolvedExecutablePath || undefined
      });
      state.browser = state.context.browser();
      state.persistent = true;
    } else {
      state.browser = await chromium.launch({
        headless: resolvedHeadless,
        slowMo: resolvedSlowMoMs,
        args: launchArgs,
        channel: resolvedChannel || undefined,
        executablePath: resolvedExecutablePath || undefined
      });

      state.context = await state.browser.newContext({
        viewport: viewport ?? DEFAULT_VIEWPORT,
        userAgent: userAgent || undefined
      });
    }

    if (resolvedStealth) {
      await state.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      });
    }

    const prePages = state.context.pages();
    await state.pageManager.attachContext(state.context);
    state.page = state.pageManager.getActivePage();
    if (resolvedStealth && prePages.length) {
      await state.page.reload({ waitUntil: 'domcontentloaded' });
    }
    // Attach CDP listeners early so console/network logs are available later for debugging.
    try {
      for (const p of state.context.pages()) {
        await ensureObservability(p);
        await ensurePageEventListeners(p);
      }
    } catch {
      // best effort
    }

    const warnings = [];
    warnings.push(...normalized.warnings);
    if (normalizedUserDataDir && hasDefaultChromeUserDataDir(normalizedUserDataDir)) {
      warnings.push(
        'Using default Chrome "User Data" may be locked if Chrome is open. Prefer a dedicated profile directory.'
      );
    }

    const browserVersion = state.browser ? state.browser.version() : null;

    return respond({
      status: 'launched',
      headless: resolvedHeadless,
      viewport: viewport ?? DEFAULT_VIEWPORT,
      persistent: state.persistent,
      browserVersion,
      channel: resolvedChannel || null,
      executablePath: resolvedExecutablePath || null,
      userDataDir: normalizedUserDataDir || null,
      profileDirectory: normalizedProfileDirectory || null,
      args: launchArgs,
      warnings
    });
  }
);

server.registerTool(
  'browser.connect_cdp',
  {
    description: 'Connect to an existing Chrome/Chromium with remote debugging enabled (CDP).',
    inputSchema: {
      endpoint: z.string().optional(),
      slowMoMs: z.number().optional()
    }
  },
  async ({ endpoint, slowMoMs }) => {
    const resolvedEndpoint =
      endpoint || ENV_DEFAULTS.cdpEndpoint || (ENV_DEFAULTS.cdpPort ? `http://127.0.0.1:${ENV_DEFAULTS.cdpPort}` : null);
    const url = resolvedEndpoint || 'http://127.0.0.1:9222';
    if (state.context) {
      await state.context.close();
    } else if (state.browser) {
      await state.browser.close();
    }

    state.browser = await chromium.connectOverCDP(url, { slowMo: slowMoMs ?? ENV_DEFAULTS.slowMoMs ?? 0 });
    const contexts = state.browser.contexts();
    state.context = contexts.length ? contexts[0] : await state.browser.newContext();
    resetRuntimeQueues();
    resetCaptureProfileToDefault();
    state.pageManager.reset();
    await state.pageManager.attachContext(state.context);
    state.page = state.pageManager.getActivePage();
    try {
      for (const p of state.context.pages()) {
        await ensureObservability(p);
        await ensurePageEventListeners(p);
      }
    } catch {
      // best effort
    }
    state.persistent = true;
    state.cdpConnected = true;
    state.cdpManaged = false;
    state.cdpAutoClose = false;
    state.chromeProcess = null;
    return respond({
      status: 'connected',
      endpoint: url,
      pages: state.context.pages().length
    });
  }
);

server.registerTool(
  'browser.launch_chrome_cdp',
  {
    description: 'Launch Chrome with remote debugging enabled and connect via CDP.',
    inputSchema: {
      chromePath: z.string().optional(),
      userDataDir: z.string().optional(),
      profileDirectory: z.string().optional(),
      port: z.number().optional(),
      args: z.array(z.string()).optional(),
      headless: z.boolean().optional(),
      slowMoMs: z.number().optional(),
      stealth: z.boolean().optional(),
      waitMs: z.number().optional(),
      autoClose: z.boolean().optional()
    }
  },
  async ({ chromePath, userDataDir, profileDirectory, port, args, headless, slowMoMs, stealth, waitMs, autoClose }) => {
    const resolvedChromePath = chromePath ?? ENV_DEFAULTS.chromePath;
    const resolvedUserDataDir = userDataDir ?? ENV_DEFAULTS.userDataDir;
    const resolvedProfileDirectory = profileDirectory ?? ENV_DEFAULTS.profileDirectory;
    const normalized = normalizeProfilePath(resolvedUserDataDir, resolvedProfileDirectory);
    const normalizedUserDataDir = normalized.userDataDir;
    const normalizedProfileDirectory = normalized.profileDirectory;
    const resolvedPort = port ?? ENV_DEFAULTS.cdpPort ?? 9222;
    const resolvedArgs = args ?? ENV_DEFAULTS.args ?? [];
    const resolvedHeadless = headless ?? ENV_DEFAULTS.headless ?? false;
    const resolvedSlowMoMs = slowMoMs ?? ENV_DEFAULTS.slowMoMs ?? 0;
    const resolvedStealth = stealth ?? ENV_DEFAULTS.stealth ?? false;
    const resolvedWaitMs = waitMs ?? ENV_DEFAULTS.cdpWaitMs ?? 20000;
    const resolvedAutoClose = autoClose ?? ENV_DEFAULTS.cdpAutoClose ?? false;

    if (normalizedProfileDirectory && !normalizedUserDataDir) {
      throw new Error('profileDirectory requires userDataDir.');
    }
    if (normalizedUserDataDir && hasDefaultChromeUserDataDir(normalizedUserDataDir)) {
      throw new Error(
        'Chrome blocks CDP automation on the default "User Data" directory (Chrome 136+). Use a dedicated userDataDir (e.g. ChromeForMCP).'
      );
    }
    if (state.context) {
      await state.context.close();
    } else if (state.browser) {
      await state.browser.close();
    }

    const resolvedChrome = await resolveChromePath(resolvedChromePath);
    if (!resolvedChrome) {
      throw new Error('Unable to locate chrome.exe. Provide chromePath explicitly.');
    }

    const cdpPort = resolvedPort;
    const dataDir = normalizedUserDataDir || path.join(process.env['LOCALAPPDATA'] || process.cwd(), 'ChromeForMCP');
    const launchArgs = buildArgs(resolvedArgs, normalizedProfileDirectory);
    if (!launchArgs.some((arg) => arg.startsWith('--remote-debugging-port='))) {
      launchArgs.push(`--remote-debugging-port=${cdpPort}`);
    }
    if (!launchArgs.some((arg) => arg.startsWith('--user-data-dir='))) {
      launchArgs.push(`--user-data-dir=${dataDir}`);
    }
    if (!resolvedHeadless) {
      const hasNewWindow = launchArgs.some((arg) => arg === '--new-window');
      const hasWindowSize = launchArgs.some((arg) => arg.startsWith('--window-size='));
      const hasStartMax = launchArgs.some((arg) => arg === '--start-maximized');
      if (!hasNewWindow) {
        launchArgs.push('--new-window');
      }
      if (!hasWindowSize && !hasStartMax) {
        launchArgs.push('--start-maximized');
      }
    }
    if (resolvedHeadless) {
      if (!launchArgs.some((arg) => arg.startsWith('--headless'))) {
        launchArgs.push('--headless=new');
      }
    }

    const chromeProcess = spawn(resolvedChrome, launchArgs, {
      detached: true,
      stdio: 'ignore'
    });
    chromeProcess.unref();

    const timeoutMs = resolvedWaitMs;
    const start = Date.now();
    let connected = false;
    let lastError = null;
    while (Date.now() - start < timeoutMs) {
      try {
        state.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { slowMo: resolvedSlowMoMs });
        connected = true;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!connected) {
      throw new Error(`Failed to connect to Chrome CDP on port ${cdpPort}. ${lastError || ''}`.trim());
    }

    state.chromeProcess = chromeProcess;
    state.cdpConnected = true;
    state.cdpManaged = true;
    state.cdpAutoClose = resolvedAutoClose;
    state.persistent = true;

    const contexts = state.browser.contexts();
    state.context = contexts.length ? contexts[0] : await state.browser.newContext();
    resetRuntimeQueues();
    resetCaptureProfileToDefault();
    state.pageManager.reset();
    if (resolvedStealth) {
      await state.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      });
    }
    const prePages = state.context.pages();
    await state.pageManager.attachContext(state.context);
    state.page = state.pageManager.getActivePage();
    if (resolvedStealth && prePages.length) {
      await state.page.reload({ waitUntil: 'domcontentloaded' });
    }
    try {
      for (const p of state.context.pages()) {
        await ensureObservability(p);
        await ensurePageEventListeners(p);
      }
    } catch {
      // best effort
    }

    const warnings = [...normalized.warnings];
    if (hasDefaultChromeUserDataDir(dataDir)) {
      warnings.push('Using default Chrome "User Data" with CDP is blocked in recent Chrome versions. Use a dedicated data dir.');
    }

    const browserVersion = state.browser ? state.browser.version() : null;

    return respond({
      status: 'launched',
      chromePath: resolvedChrome,
      endpoint: `http://127.0.0.1:${cdpPort}`,
      userDataDir: dataDir,
      persistent: true,
      browserVersion,
      profileDirectory: normalizedProfileDirectory || null,
      args: launchArgs,
      warnings
    });
  }
);

server.registerTool(
  'browser.new_page',
  {
    description: 'Open a new page/tab in the current context.',
    inputSchema: {}
  },
  async () => {
    if (!state.context) {
      throw new Error('Browser is not launched. Run browser.launch or browser.connect_cdp first.');
    }
    const page = await state.context.newPage();
    state.pageManager.attachPage(page);
    state.page = page;
    try {
      await ensureObservability(page);
      await ensurePageEventListeners(page);
    } catch {
      // best effort
    }
    clearElementCache();
    return respond({ status: 'new-page', url: state.page.url() });
  }
);

server.registerTool(
  'browser.list_pages',
  {
    description: 'List open pages/tabs in the current context.',
    inputSchema: {
      includeClosed: z.boolean().optional(),
      maxPages: z.number().optional()
    }
  },
  async ({ includeClosed, maxPages }) => {
    if (!state.context) {
      throw new Error('Browser is not launched. Run browser.launch or browser.connect_cdp first.');
    }
    const allPages = await state.pageManager.listPages();
    const include = includeClosed ?? false;
    const resolvedMaxPages = clampNumber(maxPages, 1, 1000, 200);
    const filtered = allPages.filter((entry) => (include ? true : !entry.closed));
    let pages = filtered.slice(0, resolvedMaxPages);
    const activePageId = state.pageManager.getActivePageId();
    if (
      typeof activePageId === 'number' &&
      !pages.some((entry) => entry.pageId === activePageId)
    ) {
      const activeEntry = filtered.find((entry) => entry.pageId === activePageId);
      if (activeEntry) {
        if (pages.length >= resolvedMaxPages && pages.length > 0) {
          pages[pages.length - 1] = activeEntry;
        } else {
          pages = [...pages, activeEntry];
        }
      }
    }
    return respond({
      activePageId,
      totalCount: allPages.length,
      count: pages.length,
      pages
    });
  }
);

server.registerTool(
  'browser.list_frames',
  {
    description: 'List frames for the active page (or a specified pageId).',
    inputSchema: {
      pageId: z.number().optional()
    }
  },
  async ({ pageId }) => {
    let page = ensurePage();
    if (typeof pageId === 'number') {
      page = state.pageManager.selectPage(pageId);
      state.page = page;
    }
    ensureDomTracker(page);
    const payload = listDomFrames(page);
    return respond(withFrameMeta(page, page.mainFrame(), {
      count: payload.frames.length,
      frames: payload.frames,
      pageDomVersion: payload.pageDomVersion,
      domVersion: payload.domVersion
    }));
  }
);

server.registerTool(
  'browser.select_page',
  {
    description: 'Select the active page/tab by pageId.',
    inputSchema: {
      pageId: z.number()
    }
  },
  async ({ pageId }) => {
    if (!state.context) {
      throw new Error('Browser is not launched. Run browser.launch or browser.connect_cdp first.');
    }
    const page = state.pageManager.selectPage(pageId);
    state.page = page;
    try {
      await ensureObservability(page);
      await ensurePageEventListeners(page);
    } catch {
      // best effort
    }
    clearElementCache();
    return respond({ status: 'selected', pageId, url: page.url() });
  }
);

server.registerTool(
  'browser.close_page',
  {
    description: 'Close a page/tab by pageId (or the active page if omitted).',
    inputSchema: {
      pageId: z.number().optional()
    }
  },
  async ({ pageId }) => {
    if (!state.context) {
      throw new Error('Browser is not launched. Run browser.launch or browser.connect_cdp first.');
    }
    const result = await state.pageManager.closePage(pageId);
    state.page = state.pageManager.getActivePage();
    clearElementCache();
    return respond({ status: 'closed-page', ...result });
  }
);

server.registerTool(
  'browser.close',
  {
    description: 'Close the current browser session.',
    inputSchema: {
      terminateChrome: z.boolean().optional()
    }
  },
  async ({ terminateChrome }) => {
    if (state.cdpConnected) {
      if (state.browser) {
        await state.browser.close();
      }
      if ((terminateChrome || state.cdpAutoClose) && state.chromeProcess?.pid) {
        try {
          process.kill(state.chromeProcess.pid);
        } catch {
          // ignore
        }
      }
    } else if (state.context) {
      await state.context.close();
    }
    state.browser = null;
    state.context = null;
    state.page = null;
    state.persistent = false;
    state.cdpConnected = false;
    state.cdpManaged = false;
    state.cdpAutoClose = false;
    state.chromeProcess = null;
    state.lastLaunch = null;
    state.pageManager.reset();
    resetRuntimeQueues();
    resetCaptureProfileToDefault();
    return respond({ status: 'closed' });
  }
);

server.registerTool(
  'browser.goto',
  {
    description: 'Navigate to a URL.',
    inputSchema: {
      url: z.string(),
      waitUntil: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ url, waitUntil, timeoutMs }) => {
    const page = ensurePage();
    await page.goto(url, {
      waitUntil: waitUntil || 'domcontentloaded',
      timeout: timeoutMs || 30000
    });
    state.uidMaps.delete(page);
    clearElementCache();
    return respond({
      url: page.url(),
      title: await page.title()
    });
  }
);

server.registerTool(
  'browser.back',
  {
    description: 'Go back in history.',
    inputSchema: {
      waitUntil: z.string().optional()
    }
  },
  async ({ waitUntil }) => {
    const page = ensurePage();
    await page.goBack({ waitUntil: waitUntil || 'domcontentloaded' });
    state.uidMaps.delete(page);
    clearElementCache();
    return respond({ url: page.url(), title: await page.title() });
  }
);

server.registerTool(
  'browser.forward',
  {
    description: 'Go forward in history.',
    inputSchema: {
      waitUntil: z.string().optional()
    }
  },
  async ({ waitUntil }) => {
    const page = ensurePage();
    await page.goForward({ waitUntil: waitUntil || 'domcontentloaded' });
    state.uidMaps.delete(page);
    clearElementCache();
    return respond({ url: page.url(), title: await page.title() });
  }
);

server.registerTool(
  'browser.reload',
  {
    description: 'Reload the current page.',
    inputSchema: {
      waitUntil: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ waitUntil, timeoutMs }) => {
    const page = ensurePage();
    const frame = page.mainFrame();
    await page.reload({
      waitUntil: waitUntil || 'domcontentloaded',
      timeout: clampNumber(timeoutMs, 1000, 300000, 30000)
    });
    state.uidMaps.delete(page);
    clearElementCache();
    return respond(withFrameMeta(page, frame, { status: 'reloaded', url: page.url(), title: await page.title() }));
  }
);

server.registerTool(
  'browser.wait',
  {
    description: 'Wait for a selector or timeout.',
    inputSchema: {
      selector: z.string().optional(),
      timeoutMs: z.number().optional(),
      ms: z.number().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional()
    }
  },
  async ({ selector, timeoutMs, ms, frameId, frameSelector }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    if (selector) {
      await scope.waitForSelector(selector, { timeout: timeoutMs || 15000 });
      return respond(withFrameMeta(page, frame, { status: 'selector-ready', selector }));
    }
    if (typeof ms === 'number') {
      await page.waitForTimeout(ms);
      return respond(withFrameMeta(page, frame, { status: 'waited', ms }));
    }
    return respond(withFrameMeta(page, frame, { status: 'no-op' }));
  }
);

server.registerTool(
  'browser.wait_for',
  {
    description: 'Wait for a selector, text, or uid to be ready. Prefer this over fixed sleeps.',
    inputSchema: {
      selector: z.string().optional(),
      text: z.string().optional(),
      exact: z.boolean().optional(),
      uid: z.string().optional(),
      timeoutMs: z.number().optional(),
      state: z.enum(['attached', 'visible', 'hidden', 'detached', 'enabled']).optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional()
    }
  },
  async ({ selector, text, exact, uid, timeoutMs, state, frameId, frameSelector }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const resolvedTimeout = clampNumber(timeoutMs, 1000, 300000, 15000);
    const resolvedState = state || 'visible';

    const modes = [Boolean(selector), Boolean(text), Boolean(uid)].filter(Boolean).length;
    if (modes !== 1) {
      throw new Error('Provide exactly one of selector, text, or uid.');
    }

    if (selector) {
      let result;
      if (frame === page.mainFrame()) {
        result = await waitForSelector(page, selector, { timeoutMs: resolvedTimeout, state: resolvedState });
      } else if (resolvedState === 'enabled') {
        const locator = frame.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: resolvedTimeout });
        const start = Date.now();
        while (Date.now() - start < resolvedTimeout) {
          try {
            if (await locator.isEnabled()) {
              result = { status: 'ready', kind: 'selector', selector, state: 'enabled' };
              break;
            }
          } catch {
            // retry
          }
          await page.waitForTimeout(100);
        }
        if (!result) throw new Error(`Timeout waiting for selector "${selector}" to become enabled (${resolvedTimeout}ms).`);
      } else {
        await frame.waitForSelector(selector, { timeout: resolvedTimeout, state: resolvedState });
        result = { status: 'ready', kind: 'selector', selector, state: resolvedState };
      }
      return respond(withFrameMeta(page, frame, result));
    }

    if (text) {
      let result;
      if (frame === page.mainFrame()) {
        result = await waitForText(page, text, { timeoutMs: resolvedTimeout, state: resolvedState, exact: exact ?? false });
      } else {
        const locator = frame.getByText(text, { exact: exact ?? false }).first();
        if (resolvedState === 'enabled') {
          await locator.waitFor({ state: 'visible', timeout: resolvedTimeout });
          const start = Date.now();
          while (Date.now() - start < resolvedTimeout) {
            try {
              if (await locator.isEnabled()) {
                result = { status: 'ready', kind: 'text', text, exact: exact ?? false, state: 'enabled' };
                break;
              }
            } catch {
              // retry
            }
            await page.waitForTimeout(100);
          }
          if (!result) throw new Error(`Timeout waiting for text "${text}" to become enabled (${resolvedTimeout}ms).`);
        } else {
          await locator.waitFor({ state: resolvedState, timeout: resolvedTimeout });
          result = { status: 'ready', kind: 'text', text, exact: exact ?? false, state: resolvedState };
        }
      }
      return respond(withFrameMeta(page, frame, result));
    }

    const backendNodeId = getBackendNodeIdForUid(page, uid, frame);
    const result = await waitForBackendNode(page, backendNodeId, { timeoutMs: resolvedTimeout });
    return respond(withFrameMeta(page, frame, { ...result, uid }));
  }
);

server.registerTool(
  'browser.list_dialogs',
  {
    description: 'List dialogs captured from the page (alert/confirm/prompt/beforeunload).',
    inputSchema: {
      pageId: z.number().optional(),
      includeHandled: z.boolean().optional()
    }
  },
  async ({ pageId, includeHandled }) => {
    const include = includeHandled ?? false;
    const items = state.dialogs
      .filter((entry) => (typeof pageId === 'number' ? entry.pageId === pageId : true))
      .filter((entry) => include || entry.status === 'pending')
      .map((entry) => ({
        dialogId: entry.dialogId,
        pageId: entry.pageId,
        type: entry.type,
        message: entry.message,
        defaultValue: entry.defaultValue,
        createdAt: entry.createdAt,
        status: entry.status,
        resolution: entry.resolution,
        handledAt: entry.handledAt
      }));
    return respond({ count: items.length, dialogs: items });
  }
);

server.registerTool(
  'browser.handle_dialog',
  {
    description: 'Handle a pending dialog by dialogId.',
    inputSchema: {
      dialogId: z.string(),
      action: z.enum(['accept', 'dismiss']).optional(),
      promptText: z.string().optional()
    }
  },
  async ({ dialogId, action, promptText }) => {
    const entry = state.dialogById.get(dialogId);
    if (!entry) {
      throw new Error(`Unknown dialogId "${dialogId}".`);
    }
    if (entry.status !== 'pending') {
      return respond({
        status: entry.status,
        dialogId: entry.dialogId,
        handledAt: entry.handledAt,
        resolution: entry.resolution
      });
    }

    if (entry._timer) clearTimeout(entry._timer);
    const act = action || 'dismiss';
    if (act === 'accept') {
      await entry._dialog.accept(promptText ?? undefined);
      entry.status = 'accepted';
      entry.resolution = {
        action: 'accept',
        promptText: typeof promptText === 'string' ? promptText : null
      };
    } else {
      await entry._dialog.dismiss();
      entry.status = 'dismissed';
      entry.resolution = { action: 'dismiss' };
    }
    entry.handledAt = new Date().toISOString();

    return respond({
      status: entry.status,
      dialogId: entry.dialogId,
      pageId: entry.pageId,
      handledAt: entry.handledAt
    });
  }
);

server.registerTool(
  'browser.wait_for_download',
  {
    description: 'Wait for the next download event and return its metadata.',
    inputSchema: {
      timeoutMs: z.number().optional(),
      pageId: z.number().optional(),
      peek: z.boolean().optional()
    }
  },
  async ({ timeoutMs, pageId, peek }) => {
    const timeout = clampNumber(timeoutMs, 1000, 300000, 30000);
    const shouldPeek = peek ?? false;
    const start = Date.now();

    const findMatch = () =>
      state.downloads.find((entry) => !entry.consumed && (typeof pageId === 'number' ? entry.pageId === pageId : true));

    let match = findMatch();
    while (!match && Date.now() - start < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      match = findMatch();
    }

    if (!match) {
      throw new Error(`Timeout waiting for download (${timeout}ms).`);
    }

    if (!shouldPeek) {
      match.consumed = true;
    }

    return respond({
      status: 'download-ready',
      downloadId: match.downloadId,
      pageId: match.pageId,
      suggestedFilename: match.suggestedFilename,
      url: match.url,
      mimeType: match.mimeType,
      createdAt: match.createdAt,
      consumed: match.consumed
    });
  }
);

server.registerTool(
  'browser.save_download',
  {
    description: 'Save a captured download to a path (restricted by MCP path rules).',
    inputSchema: {
      downloadId: z.string(),
      path: z.string()
    }
  },
  async ({ downloadId, path: targetPath }) => {
    const entry = state.downloadById.get(downloadId);
    if (!entry) {
      throw new Error(`Unknown downloadId "${downloadId}".`);
    }
    const absPath = await assertAllowedWritePath(targetPath);
    await ensureDir(absPath);
    await entry._download.saveAs(absPath);
    entry.savedPath = absPath;
    return respond({
      status: 'saved',
      downloadId: entry.downloadId,
      path: absPath,
      suggestedFilename: entry.suggestedFilename
    });
  }
);

server.registerTool(
  'browser.wait_for_popup',
  {
    description: 'Wait for a popup/new tab opened by page actions.',
    inputSchema: {
      timeoutMs: z.number().optional(),
      openerPageId: z.number().optional(),
      peek: z.boolean().optional(),
      select: z.boolean().optional()
    }
  },
  async ({ timeoutMs, openerPageId, peek, select }) => {
    const timeout = clampNumber(timeoutMs, 1000, 300000, 30000);
    const shouldPeek = peek ?? false;
    const shouldSelect = select ?? false;
    const start = Date.now();

    const findMatch = () =>
      state.popups.find((entry) => !entry.consumed && (typeof openerPageId === 'number' ? entry.openerPageId === openerPageId : true));

    let match = findMatch();
    while (!match && Date.now() - start < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      match = findMatch();
    }

    if (!match) {
      throw new Error(`Timeout waiting for popup (${timeout}ms).`);
    }

    if (!shouldPeek) {
      match.consumed = true;
    }

    let selected = false;
    if (shouldSelect && typeof match.pageId === 'number') {
      try {
        const popupPage = state.pageManager.selectPage(match.pageId);
        state.page = popupPage;
        selected = true;
      } catch {
        // keep metadata-only response if popup already closed
      }
    }

    return respond({
      status: 'popup-ready',
      popupId: match.popupId,
      openerPageId: match.openerPageId,
      pageId: match.pageId,
      url: match.url,
      createdAt: match.createdAt,
      consumed: match.consumed,
      selected
    });
  }
);

server.registerTool(
  'browser.expect_event',
  {
    description: 'Wait for a specific browser event, optionally running an allowlisted action first.',
    inputSchema: {
      eventType: z.enum(['navigation', 'popup', 'download', 'response', 'request']),
      pattern: z.string().optional(),
      regex: z.boolean().optional(),
      status: z.number().optional(),
      method: z.string().optional(),
      timeoutMs: z.number().optional(),
      selectPopup: z.boolean().optional(),
      afterAction: z
        .object({
          toolName: z.string(),
          args: z.record(z.string(), z.any()).optional()
        })
        .optional()
    }
  },
  async ({ eventType, pattern, regex, status, method, timeoutMs, selectPopup, afterAction }) => {
    const page = ensurePage();
    const timeout = clampNumber(timeoutMs, 1000, 300000, 30000);
    const matchesUrl = buildUrlMatcher(pattern, regex ?? false);

    let waitPromise;
    if (eventType === 'navigation') {
      if (pattern) {
        waitPromise = page.waitForURL((url) => matchesUrl(String(url || '')), { timeout });
      } else {
        waitPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout });
      }
    } else if (eventType === 'popup') {
      // Don't filter on initial URL because many popups start as about:blank then navigate.
      waitPromise = page.waitForEvent('popup', { timeout });
    } else if (eventType === 'download') {
      waitPromise = page.waitForEvent('download', {
        timeout,
        predicate: (download) => matchesUrl(download.url())
      });
    } else if (eventType === 'response') {
      waitPromise = page.waitForResponse(
        (response) =>
          matchesUrl(response.url()) && (typeof status === 'number' ? response.status() === status : true),
        { timeout }
      );
    } else {
      const methodNeedle = String(method || '').toLowerCase();
      waitPromise = page.waitForRequest(
        (request) =>
          matchesUrl(request.url()) &&
          (methodNeedle ? request.method().toLowerCase() === methodNeedle : true),
        { timeout }
      );
    }

    let afterActionResult;
    try {
      afterActionResult = await runExpectAfterAction(page, afterAction);
    } catch (error) {
      // Prevent background wait rejections when action fails.
      void waitPromise.catch(() => {});
      throw error;
    }
    const event = await waitPromise;

    if (eventType === 'navigation') {
      const payload = {
        status: 'event-matched',
        eventType,
        url: page.url(),
        responseStatus: typeof event?.status === 'function' ? event.status() : null,
        afterAction: afterActionResult
      };
      return respond(afterActionResult.frameId
        ? withToolMeta(payload, { frameId: afterActionResult.frameId })
        : withFrameMeta(page, page.mainFrame(), payload));
    }

    if (eventType === 'popup') {
      const popupPage = event;
      if (pattern) {
        await popupPage.waitForURL((url) => matchesUrl(String(url || '')), { timeout });
      }
      state.pageManager.attachPage(popupPage);
      await ensurePageEventListeners(popupPage);
      await ensureObservability(popupPage);
      const popupPageId = getPageIdSafe(popupPage);
      const shouldSelectPopup = selectPopup ?? false;
      let selectedPopup = false;
      if (shouldSelectPopup && typeof popupPageId === 'number') {
        try {
          state.page = state.pageManager.selectPage(popupPageId);
          selectedPopup = true;
        } catch {
          // ignore if popup already closed
        }
      }
      const popupRecord = [...state.popups].reverse().find((item) => item.pageId === popupPageId && !item.consumed);
      if (popupRecord) popupRecord.consumed = true;

      const payload = {
        status: 'event-matched',
        eventType,
        popupId: popupRecord?.popupId || null,
        openerPageId: popupRecord?.openerPageId ?? getPageIdSafe(page),
        pageId: popupPageId,
        url: popupPage.url(),
        selected: selectedPopup,
        afterAction: afterActionResult
      };
      return respond(withFrameMeta(page, page.mainFrame(), payload));
    }

    if (eventType === 'download') {
      const download = event;
      let entry = [...state.downloadById.values()].find((item) => item._download === download);
      if (!entry) {
        state.downloadSeq += 1;
        const downloadId = `dl-${state.downloadSeq}`;
        entry = {
          downloadId,
          pageId: getPageIdSafe(page),
          suggestedFilename: String(download.suggestedFilename?.() || ''),
          url: String(download.url?.() || ''),
          mimeType: null,
          createdAt: new Date().toISOString(),
          consumed: false,
          savedPath: null,
          _download: download
        };
        state.downloadById.set(downloadId, entry);
        const dropped = pushBounded(state.downloads, entry, 400);
        for (const stale of dropped) {
          if (stale?.downloadId) state.downloadById.delete(stale.downloadId);
        }
      }
      const payload = {
        status: 'event-matched',
        eventType,
        downloadId: entry.downloadId,
        pageId: entry.pageId,
        suggestedFilename: entry.suggestedFilename,
        url: entry.url,
        mimeType: entry.mimeType,
        afterAction: afterActionResult
      };
      return respond(withFrameMeta(page, page.mainFrame(), payload));
    }

    if (eventType === 'response') {
      const payload = {
        status: 'event-matched',
        eventType,
        url: event.url(),
        method: event.request().method(),
        statusCode: event.status(),
        ok: event.ok(),
        afterAction: afterActionResult
      };
      return respond(withFrameMeta(page, page.mainFrame(), payload));
    }

    const payload = {
      status: 'event-matched',
      eventType,
      url: event.url(),
      method: event.method(),
      resourceType: event.resourceType(),
      afterAction: afterActionResult
    };
    return respond(withFrameMeta(page, page.mainFrame(), payload));
  }
);

server.registerTool(
  'browser.get_cookies',
  {
    description: 'Get cookies from the current browser context.',
    inputSchema: {
      urls: z.array(z.string()).optional()
    }
  },
  async ({ urls }) => {
    if (!state.context) {
      throw new Error('Browser context is not available. Launch or connect first.');
    }
    const cookies = await state.context.cookies(Array.isArray(urls) && urls.length ? urls : undefined);
    return respond({ count: cookies.length, cookies });
  }
);

server.registerTool(
  'browser.set_cookies',
  {
    description: 'Set cookies in the current browser context.',
    inputSchema: {
      cookies: z.array(
        z.object({
          name: z.string(),
          value: z.string(),
          url: z.string().optional(),
          domain: z.string().optional(),
          path: z.string().optional(),
          expires: z.number().optional(),
          httpOnly: z.boolean().optional(),
          secure: z.boolean().optional(),
          sameSite: z.enum(['Strict', 'Lax', 'None']).optional()
        })
      )
    }
  },
  async ({ cookies }) => {
    if (!state.context) {
      throw new Error('Browser context is not available. Launch or connect first.');
    }
    for (const cookie of cookies) {
      if (!cookie.url && (!cookie.domain || !cookie.path)) {
        throw new Error(`Cookie "${cookie.name}" must include either url, or both domain and path.`);
      }
    }
    await state.context.addCookies(cookies);
    return respond({ status: 'cookies-set', count: cookies.length });
  }
);

server.registerTool(
  'browser.clear_cookies',
  {
    description: 'Clear all cookies in the current browser context.',
    inputSchema: {}
  },
  async () => {
    if (!state.context) {
      throw new Error('Browser context is not available. Launch or connect first.');
    }
    const before = (await state.context.cookies()).length;
    await state.context.clearCookies();
    const after = (await state.context.cookies()).length;
    return respond({ status: 'cookies-cleared', before, after });
  }
);

server.registerTool(
  'browser.export_storage_state',
  {
    description: 'Export browser storage state. Optionally save to a path.',
    inputSchema: {
      path: z.string().optional(),
      includeData: z.boolean().optional()
    }
  },
  async ({ path: targetPath, includeData }) => {
    if (!state.context) {
      throw new Error('Browser context is not available. Launch or connect first.');
    }
    const storageState = await state.context.storageState();
    let absPath = null;
    if (targetPath) {
      absPath = await assertAllowedWritePath(targetPath);
      await ensureDir(absPath);
      await fs.writeFile(absPath, JSON.stringify(storageState, null, 2), 'utf8');
    }

    const payload = {
      status: 'storage-exported',
      path: absPath,
      cookies: storageState.cookies.length,
      origins: storageState.origins.length
    };
    if (includeData ?? false) {
      payload.storageState = storageState;
    }
    return respond(payload);
  }
);

server.registerTool(
  'browser.import_storage_state',
  {
    description: 'Import storage state by creating and selecting a new browser context.',
    inputSchema: {
      path: z.string(),
      closePreviousContext: z.boolean().optional()
    }
  },
  async ({ path: sourcePath, closePreviousContext }) => {
    if (!state.browser) {
      throw new Error('Browser is not available. Launch or connect first.');
    }
    const absPath = await assertAllowedReadPath(sourcePath);
    const previousContext = state.context;

    const newContext = await state.browser.newContext({ storageState: absPath, viewport: DEFAULT_VIEWPORT });
    state.context = newContext;
    state.pageManager.reset();
    resetRuntimeQueues();
    resetCaptureProfileToDefault();
    await state.pageManager.attachContext(newContext);
    state.page = state.pageManager.getActivePage();
    try {
      for (const p of newContext.pages()) {
        await ensureObservability(p);
        await ensurePageEventListeners(p);
      }
    } catch {
      // best effort
    }

    let closedPrevious = false;
    let warning = null;
    if (closePreviousContext && previousContext && previousContext !== newContext) {
      if (state.persistent) {
        warning = 'Skipped closing previous context in persistent mode to avoid terminating the browser.';
      } else {
        try {
          await previousContext.close();
          closedPrevious = true;
        } catch {
          warning = 'Failed to close previous context; continuing with the new imported context.';
        }
      }
    }

    return respond({
      status: 'storage-imported',
      mode: 'new-context',
      path: absPath,
      pages: newContext.pages().length,
      activePageId: state.pageManager.getActivePageId(),
      closedPrevious,
      warning
    });
  }
);

server.registerTool(
  'browser.query_dom',
  {
    description: 'Safely query DOM nodes and return structured attributes/states without arbitrary JS execution.',
    inputSchema: {
      selector: z.string(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      rootSelector: z.string().optional(),
      rootElementId: z.number().optional(),
      detail: z.enum(['low', 'high']).optional(),
      timeoutMs: z.number().optional(),
      limit: z.number().optional(),
      attrs: z.array(z.string()).optional(),
      includeText: z.boolean().optional(),
      includeValue: z.boolean().optional(),
      includeBBox: z.boolean().optional(),
      includeVisibility: z.boolean().optional(),
      includeState: z.boolean().optional(),
      includeTagName: z.boolean().optional(),
      pierceShadow: z.boolean().optional(),
      maxChars: z.number().optional(),
      maxPayloadBytes: z.number().optional()
    }
  },
  async ({
    selector,
    frameId,
    frameSelector,
    rootSelector,
    rootElementId,
    detail,
    timeoutMs,
    limit,
    attrs,
    includeText,
    includeValue,
    includeBBox,
    includeVisibility,
    includeState,
    includeTagName,
    pierceShadow,
    maxChars,
    maxPayloadBytes
  }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const resolvedDetail = normalizeCaptureDetail(detail);
    const profileDefaults = resolveCaptureDefaults('query_dom', resolvedDetail);
    const resolvedRootSelector = resolveRootScopeSelector(page, frame, { rootSelector, rootElementId });
    const resolvedLimit = clampNumber(limit ?? profileDefaults.limit, 1, 500, 50);
    const resolvedMaxChars = clampNumber(maxChars ?? profileDefaults.maxChars, 20, 20000, 1200);
    const resolvedMaxPayloadBytes = clampNumber(
      maxPayloadBytes ?? profileDefaults.maxPayloadBytes,
      2048,
      2_000_000,
      250_000
    );
    const resolvedAttrs = Array.isArray(attrs) ? attrs.slice(0, 25).map((v) => String(v || '').trim()).filter(Boolean) : [];
    const resolvedIncludeText = includeText ?? profileDefaults.includeText ?? false;
    const resolvedIncludeValue = includeValue ?? profileDefaults.includeValue ?? false;
    const resolvedIncludeBBox = includeBBox ?? profileDefaults.includeBBox ?? false;
    const resolvedIncludeVisibility = includeVisibility ?? profileDefaults.includeVisibility ?? true;
    const resolvedIncludeState = includeState ?? profileDefaults.includeState ?? false;
    const resolvedIncludeTagName = includeTagName ?? profileDefaults.includeTagName ?? true;

    const queryResult = await scope.evaluate(
      ({
        selector,
        rootSelector,
        limit,
        attrs,
        includeText,
        includeValue,
        includeBBox,
        includeVisibility,
        includeState,
        includeTagName,
        pierceShadow,
        maxChars
      }) => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const trunc = (value) => {
          const text = clean(value);
          if (maxChars <= 0 || text.length <= maxChars) return text;
          if (maxChars <= 3) return text.slice(0, maxChars);
          return `${text.slice(0, maxChars - 3)}...`;
        };
        const isVisible = (el) => {
          try {
            const rect = el.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
          } catch {
            return false;
          }
        };
        const getNodes = () => {
          const root = rootSelector ? document.querySelector(rootSelector) : document;
          if (!root) {
            return {
              nodes: [],
              totalMatches: 0,
              rootFound: false
            };
          }

          if (!pierceShadow) {
            const all = Array.from(root.querySelectorAll(selector));
            return {
              nodes: all.slice(0, limit),
              totalMatches: all.length,
              rootFound: true
            };
          }
          const out = [];
          let totalMatches = 0;
          const walk = (root) => {
            if (!root) return;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let current = walker.currentNode;
            while (current) {
              let matched = false;
              try {
                matched = Boolean(current.matches && current.matches(selector));
                if (matched) {
                  totalMatches += 1;
                  if (out.length < limit) out.push(current);
                }
              } catch {
                // ignore selector-match errors
              }
              if (current.shadowRoot) walk(current.shadowRoot);
              current = walker.nextNode();
            }
          };
          walk(root);
          return {
            nodes: out.slice(0, limit),
            totalMatches,
            rootFound: true
          };
        };

        const { nodes, totalMatches, rootFound } = getNodes();
        const items = nodes.map((node) => {
          const item = {};
          if (includeTagName) item.tagName = String(node.tagName || '').toLowerCase();
          if (includeText) item.text = trunc(node.innerText || node.textContent || '');
          if (includeValue) {
            const hasValue = typeof node.value !== 'undefined';
            item.value = hasValue ? trunc(node.value) : null;
          }
          if (attrs.length) {
            const attrOut = {};
            for (const key of attrs) {
              attrOut[key] = node.getAttribute ? node.getAttribute(key) : null;
            }
            item.attrs = attrOut;
          }
          if (includeBBox) {
            try {
              const r = node.getBoundingClientRect();
              item.bbox = {
                x: Math.round((window.scrollX || 0) + r.x),
                y: Math.round((window.scrollY || 0) + r.y),
                width: Math.round(r.width),
                height: Math.round(r.height)
              };
            } catch {
              item.bbox = null;
            }
          }
          if (includeVisibility) {
            item.visible = isVisible(node);
          }
          if (includeState) {
            item.enabled = !Boolean(node.disabled);
            item.checked = Boolean(node.checked);
            item.selected = Boolean(node.selected);
          }
          return item;
        });
        return {
          totalMatches,
          nodes: items,
          rootFound
        };
      },
      {
        selector,
        rootSelector: resolvedRootSelector,
        limit: resolvedLimit,
        attrs: resolvedAttrs,
        includeText: resolvedIncludeText,
        includeValue: resolvedIncludeValue,
        includeBBox: resolvedIncludeBBox,
        includeVisibility: resolvedIncludeVisibility,
        includeState: resolvedIncludeState,
        includeTagName: resolvedIncludeTagName,
        pierceShadow: pierceShadow ?? false,
        maxChars: resolvedMaxChars
      }
    );

    if (resolvedRootSelector && queryResult.rootFound === false) {
      throw new Error(`Root selector not found for query_dom: ${resolvedRootSelector}`);
    }

    const payload = {
      selector,
      rootSelector: resolvedRootSelector,
      detail: resolvedDetail,
      profile: getActiveCaptureProfile(),
      totalMatches: queryResult.totalMatches,
      returned: queryResult.nodes.length,
      limit: resolvedLimit,
      nodes: queryResult.nodes
    };
    const payloadBytes = assertPayloadWithinLimit(payload, resolvedMaxPayloadBytes);
    payload.payloadBytes = payloadBytes;
    payload.maxPayloadBytes = resolvedMaxPayloadBytes;

    return respond(withFrameMeta(page, frame, payload));
  }
);

server.registerTool(
  'browser.evaluate',
  {
    description: 'Run arbitrary JS in the page/frame context. Disabled by default; enable with MCP_ALLOW_EVALUATE=true.',
    inputSchema: {
      expression: z.string(),
      arg: z.any().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional(),
      executionTimeoutMs: z.number().optional(),
      maxOutputBytes: z.number().optional()
    }
  },
  async ({ expression, arg, frameId, frameSelector, timeoutMs, executionTimeoutMs, maxOutputBytes }) => {
    if (!(ENV_DEFAULTS.allowEvaluate ?? false)) {
      throw new Error('browser.evaluate is disabled. Set MCP_ALLOW_EVALUATE=true to enable.');
    }

    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const origin = getOriginOrNull(frame.url());
    if (!isOriginAllowed(origin, ENV_DEFAULTS.evaluateAllowOrigins)) {
      throw new Error(`Evaluate not allowed on origin "${origin}".`);
    }

    const resolvedExecutionTimeoutMs = clampNumber(executionTimeoutMs, 100, 120000, ENV_DEFAULTS.evaluateTimeoutMs ?? 5000);
    const resolvedMaxOutputBytes = clampNumber(maxOutputBytes, 256, 2_000_000, ENV_DEFAULTS.evaluateMaxBytes ?? 200_000);

    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Evaluation timeout (${resolvedExecutionTimeoutMs}ms).`)), resolvedExecutionTimeoutMs);
    });

    const evalPromise = scope.evaluate(({ expression, arg }) => {
      try {
        const source = String(expression || '').trim();
        if (!source) throw new Error('Empty expression.');

        let evaluated = null;
        try {
          const maybeFn = (0, eval)(`(${source})`);
          if (typeof maybeFn === 'function') {
            evaluated = maybeFn(arg);
          } else {
            evaluated = maybeFn;
          }
        } catch {
          evaluated = (0, eval)(source);
        }
        return { ok: true, value: evaluated };
      } catch (error) {
        return {
          ok: false,
          message: String(error && error.message ? error.message : error)
        };
      }
    }, { expression, arg });

    let evalResult;
    try {
      evalResult = await Promise.race([evalPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!evalResult || evalResult.ok !== true) {
      throw new Error(`Evaluation failed: ${evalResult?.message || 'unknown error'}`);
    }

    const payloadBytes = assertPayloadWithinLimit(evalResult.value, resolvedMaxOutputBytes);
    return respond(withFrameMeta(page, frame, {
      status: 'evaluated',
      origin,
      payloadBytes,
      maxOutputBytes: resolvedMaxOutputBytes,
      executionTimeoutMs: resolvedExecutionTimeoutMs,
      result: evalResult.value
    }));
  }
);

server.registerTool(
  'browser.get_scroll_state',
  {
    description: 'Get scroll metrics for the main page (window).',
    inputSchema: {}
  },
  async () => {
    const page = ensurePage();
    const metrics = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      const scrollTop = el.scrollTop || 0;
      const scrollHeight = el.scrollHeight || 0;
      const clientHeight = el.clientHeight || 0;
      return {
        scrollTop,
        scrollHeight,
        clientHeight,
        atBottom: scrollTop + clientHeight >= scrollHeight - 2
      };
    });
    return respond(metrics);
  }
);

server.registerTool(
  'browser.scroll_by',
  {
    description: 'Scroll the main page by a delta.',
    inputSchema: {
      dx: z.number().optional(),
      dy: z.number().optional()
    }
  },
  async ({ dx, dy }) => {
    const page = ensurePage();
    const deltaX = dx ?? 0;
    const deltaY = dy ?? 0;
    if (!deltaX && !deltaY) {
      throw new Error('Provide dx or dy for scrolling.');
    }
    const metrics = await page.evaluate(({ deltaX, deltaY }) => {
      window.scrollBy(deltaX, deltaY);
      const el = document.scrollingElement || document.documentElement;
      const scrollTop = el.scrollTop || 0;
      const scrollHeight = el.scrollHeight || 0;
      const clientHeight = el.clientHeight || 0;
      return {
        scrollTop,
        scrollHeight,
        clientHeight,
        atBottom: scrollTop + clientHeight >= scrollHeight - 2
      };
    }, { deltaX, deltaY });
    clearElementCache();
    return respond({ status: 'scrolled', ...metrics });
  }
);

server.registerTool(
  'browser.scroll_to',
  {
    description: 'Scroll the main page to an absolute position.',
    inputSchema: {
      x: z.number().optional(),
      y: z.number().optional()
    }
  },
  async ({ x, y }) => {
    const page = ensurePage();
    const targetX = x ?? 0;
    const targetY = y ?? 0;
    const metrics = await page.evaluate(({ targetX, targetY }) => {
      window.scrollTo(targetX, targetY);
      const el = document.scrollingElement || document.documentElement;
      const scrollTop = el.scrollTop || 0;
      const scrollHeight = el.scrollHeight || 0;
      const clientHeight = el.clientHeight || 0;
      return {
        scrollTop,
        scrollHeight,
        clientHeight,
        atBottom: scrollTop + clientHeight >= scrollHeight - 2
      };
    }, { targetX, targetY });
    clearElementCache();
    return respond({ status: 'scrolled', ...metrics });
  }
);

server.registerTool(
  'browser.get_scrollables',
  {
    description: 'List scrollable containers on the page.',
    inputSchema: {
      limit: z.number().optional()
    }
  },
  async ({ limit }) => {
    const page = ensurePage();
    const items = await page.evaluate(({ limit }) => {
      const maxItems = limit || 25;
      const results = [];
      const escapeCss = (value) => {
        if (window.CSS && CSS.escape) return CSS.escape(value);
        return value.replace(/([ #;?%&,.+*~':"!^$\\[\\]()=>|\/@])/g, '\\\\$1');
      };
      const makeSelector = (el) => {
        if (el.id) return `#${escapeCss(el.id)}`;
        const testId = el.getAttribute('data-testid');
        if (testId) return `[data-testid="${escapeCss(testId)}"]`;
        const aria = el.getAttribute('aria-label');
        if (aria) return `[aria-label="${escapeCss(aria)}"]`;
        const role = el.getAttribute('role');
        if (role) return `${el.tagName.toLowerCase()}[role="${escapeCss(role)}"]`;
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
          let part = node.tagName.toLowerCase();
          const siblings = Array.from(node.parentElement?.children || []).filter((n) => n.tagName === node.tagName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(node) + 1;
            part += `:nth-of-type(${index})`;
          }
          parts.unshift(part);
          node = node.parentElement;
          if (parts.length >= 5) break;
        }
        return parts.join(' > ') || el.tagName.toLowerCase();
      };

      const elements = Array.from(document.querySelectorAll('body *'));
      for (const el of elements) {
        if (results.length >= maxItems) break;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        const overflowY = style.overflowY;
        const overflowX = style.overflowX;
        const scrollableY = (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight - el.clientHeight > 2;
        const scrollableX = (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth - el.clientWidth > 2;
        if (!scrollableY && !scrollableX) continue;
        const selector = makeSelector(el);
        results.push({
          selector,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: el.className || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          role: el.getAttribute('role') || '',
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          bbox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        });
      }
      return results;
    }, { limit });
    return respond({ count: items.length, items });
  }
);

server.registerTool(
  'browser.get_container_scroll_state',
  {
    description: 'Get scroll metrics for a specific scrollable container.',
    inputSchema: {
      selector: z.string()
    }
  },
  async ({ selector }) => {
    const page = ensurePage();
    const metrics = await page.evaluate(({ selector }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const scrollTop = el.scrollTop || 0;
      const scrollHeight = el.scrollHeight || 0;
      const clientHeight = el.clientHeight || 0;
      return {
        scrollTop,
        scrollHeight,
        clientHeight,
        atBottom: scrollTop + clientHeight >= scrollHeight - 2
      };
    }, { selector });
    if (!metrics) {
      throw new Error(`No element found for selector: ${selector}`);
    }
    return respond(metrics);
  }
);

server.registerTool(
  'browser.scroll_container',
  {
    description: 'Scroll a specific container by selector.',
    inputSchema: {
      selector: z.string(),
      dx: z.number().optional(),
      dy: z.number().optional()
    }
  },
  async ({ selector, dx, dy }) => {
    const page = ensurePage();
    const deltaX = dx ?? 0;
    const deltaY = dy ?? 0;
    if (!deltaX && !deltaY) {
      throw new Error('Provide dx or dy for scrolling.');
    }
    const metrics = await page.evaluate(({ selector, deltaX, deltaY }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      el.scrollBy(deltaX, deltaY);
      const scrollTop = el.scrollTop || 0;
      const scrollHeight = el.scrollHeight || 0;
      const clientHeight = el.clientHeight || 0;
      return {
        scrollTop,
        scrollHeight,
        clientHeight,
        atBottom: scrollTop + clientHeight >= scrollHeight - 2
      };
    }, { selector, deltaX, deltaY });
    if (!metrics) {
      throw new Error(`No element found for selector: ${selector}`);
    }
    clearElementCache();
    return respond({ status: 'scrolled', ...metrics });
  }
);

server.registerTool(
  'browser.take_snapshot',
  {
    description: 'DevTools-style snapshot based on the accessibility tree. Returns compact nodes with uids.',
    inputSchema: {
      detail: z.enum(['low', 'high']).optional(),
      interestingOnly: z.boolean().optional(),
      interactiveOnly: z.boolean().optional(),
      visibleOnly: z.boolean().optional(),
      maxDepth: z.number().optional(),
      maxNodes: z.number().optional(),
      maxNameChars: z.number().optional(),
      query: z.string().optional(),
      includeUrlTitle: z.boolean().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({
    detail,
    interestingOnly,
    interactiveOnly,
    visibleOnly,
    maxDepth,
    maxNodes,
    maxNameChars,
    query,
    includeUrlTitle,
    frameId,
    frameSelector,
    timeoutMs
  }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const mainFrame = page.mainFrame();
    if (frame !== mainFrame) {
      throw new Error('browser.take_snapshot currently supports main-frame AX snapshots only. Omit frameId/frameSelector.');
    }
    const resolvedDetail = normalizeCaptureDetail(detail);
    const profileDefaults = resolveCaptureDefaults('take_snapshot', resolvedDetail);
    const resolvedInterestingOnly = interestingOnly ?? profileDefaults.interestingOnly ?? true;
    const resolvedInteractiveOnly = interactiveOnly ?? profileDefaults.interactiveOnly ?? false;
    const resolvedVisibleOnly = visibleOnly ?? profileDefaults.visibleOnly ?? false;
    const resolvedMaxDepth = clampNumber(maxDepth ?? profileDefaults.maxDepth, 1, 64, 24);
    const resolvedMaxNodes = clampNumber(maxNodes ?? profileDefaults.maxNodes, 1, 2000, 400);
    const resolvedMaxNameChars = clampNumber(maxNameChars ?? profileDefaults.maxNameChars, 20, 500, 120);
    const { nodes, uidToBackend, truncated: sourceTruncated } = await takeA11ySnapshot(page, {
      interestingOnly: resolvedInterestingOnly,
      maxNodes: resolvedMaxNodes,
      maxNameChars: resolvedMaxNameChars,
      query: query || null,
      maxDepth: resolvedMaxDepth
    });

    // AX snapshot is currently page-wide; keep UID map scoped to main frame context only.
    setUidMapForFrame(page, mainFrame, uidToBackend);

    let filteredNodes = nodes;
    if (resolvedInteractiveOnly) {
      filteredNodes = filteredNodes.filter((node) => INTERACTIVE_AX_ROLES.has(String(node.role || '').toLowerCase()));
    }
    if (resolvedVisibleOnly) {
      filteredNodes = filteredNodes.filter((node) => node.hidden !== true);
    }

    const payload = {
      detail: resolvedDetail,
      profile: getActiveCaptureProfile(),
      interestingOnly: resolvedInterestingOnly,
      interactiveOnly: resolvedInteractiveOnly,
      visibleOnly: resolvedVisibleOnly,
      maxDepth: resolvedMaxDepth,
      count: filteredNodes.length,
      nodes: filteredNodes,
      truncated: Boolean(sourceTruncated),
      uidMapFrameId: getDomContext(page, mainFrame).frameId
    };
    if (resolvedVisibleOnly) {
      payload.visibilityNote = 'visibleOnly filters nodes with AX hidden=true; some offscreen/inert nodes may still appear.';
    }

    if (includeUrlTitle ?? true) {
      payload.url = page.url();
      payload.title = await page.title();
    }

    return respond(withFrameMeta(page, mainFrame, payload));
  }
);

server.registerTool(
  'browser.snapshot',
  {
    description: 'Return a snapshot of the current page (title, url, text, links).',
    inputSchema: {
      detail: z.enum(['low', 'high']).optional(),
      maxChars: z.number().optional(),
      maxLinks: z.number().optional(),
      includeHeadings: z.boolean().optional(),
      includeFormsSummary: z.boolean().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ detail, maxChars, maxLinks, includeHeadings, includeFormsSummary, frameId, frameSelector, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const resolvedDetail = normalizeCaptureDetail(detail);
    const profileDefaults = resolveCaptureDefaults('snapshot', resolvedDetail);
    const resolvedMaxChars = clampNumber(maxChars ?? profileDefaults.maxChars, 0, 20000, 8000);
    const resolvedMaxLinks = clampNumber(maxLinks ?? profileDefaults.maxLinks, 0, 100, 50);
    const resolvedIncludeHeadings = includeHeadings ?? profileDefaults.includeHeadings ?? false;
    const resolvedIncludeFormsSummary = includeFormsSummary ?? profileDefaults.includeFormsSummary ?? false;
    const snapshot = await scope.evaluate(({ maxChars, maxLinks, includeHeadings, includeFormsSummary }) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const title = document.title || '';
      const textRaw = document.body ? document.body.innerText : '';
      const text = clean(textRaw);
      const textTruncated = text.length > maxChars;
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, maxLinks).map((link) => ({
        text: clean(link.innerText || link.getAttribute('aria-label') || ''),
        href: link.href
      }));
      const totalLinks = document.querySelectorAll('a[href]').length;
      const linksTruncated = totalLinks > maxLinks;

      let headings = null;
      if (includeHeadings) {
        headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .slice(0, 20)
          .map((el) => clean(el.innerText || el.textContent))
          .filter(Boolean);
      }

      let formsSummary = null;
      if (includeFormsSummary) {
        const forms = Array.from(document.querySelectorAll('form'));
        const hasFormLikeInputs = document.querySelectorAll('input, textarea, select').length > 0;
        formsSummary = {
          forms: forms.length,
          hasFormLikeInputs,
          requiredFields: Array.from(document.querySelectorAll('input[required], textarea[required], select[required]')).length
        };
      }

      return {
        title,
        text: text.slice(0, maxChars),
        links,
        textTruncated,
        linksTruncated,
        totalLinks,
        headings,
        formsSummary
      };
    }, {
      maxChars: resolvedMaxChars,
      maxLinks: resolvedMaxLinks,
      includeHeadings: resolvedIncludeHeadings,
      includeFormsSummary: resolvedIncludeFormsSummary
    });

    return respond(withFrameMeta(page, frame, {
      detail: resolvedDetail,
      profile: getActiveCaptureProfile(),
      title: snapshot.title || (frame === page.mainFrame() ? await page.title() : null),
      url: frame.url(),
      text: snapshot.text,
      links: snapshot.links,
      textTruncated: snapshot.textTruncated,
      linksTruncated: snapshot.linksTruncated,
      totalLinks: snapshot.totalLinks,
      truncated: Boolean(snapshot.textTruncated || snapshot.linksTruncated),
      ...(resolvedIncludeHeadings ? { headings: snapshot.headings || [] } : {}),
      ...(resolvedIncludeFormsSummary ? { formsSummary: snapshot.formsSummary || null } : {})
    }));
  }
);

server.registerTool(
  'browser.list',
  {
    description: 'List visible interactive elements (links, buttons, inputs). Includes role=radio/checkbox.',
    inputSchema: {
      detail: z.enum(['low', 'high']).optional(),
      limit: z.number().optional(),
      maxItems: z.number().optional(),
      maxTextChars: z.number().optional(),
      visibleOnly: z.boolean().optional(),
      interactiveOnly: z.boolean().optional(),
      viewportOnly: z.boolean().optional(),
      includeSelectors: z.boolean().optional(),
      rootSelector: z.string().optional(),
      rootElementId: z.number().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({
    detail,
    limit,
    maxItems,
    maxTextChars,
    visibleOnly,
    interactiveOnly,
    viewportOnly,
    includeSelectors,
    rootSelector,
    rootElementId,
    frameId,
    frameSelector,
    timeoutMs
  }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const resolvedDetail = normalizeCaptureDetail(detail);
    const profileDefaults = resolveCaptureDefaults('list', resolvedDetail);
    const resolvedLimit = clampNumber(maxItems ?? limit ?? profileDefaults.maxItems, 1, 500, 200);
    const resolvedMaxTextChars = clampNumber(maxTextChars ?? profileDefaults.maxTextChars, 20, 500, 160);
    const resolvedIncludeSelectors = includeSelectors ?? profileDefaults.includeSelectors ?? false;
    const resolvedVisibleOnly = visibleOnly ?? profileDefaults.visibleOnly ?? true;
    const resolvedInteractiveOnly = interactiveOnly ?? profileDefaults.interactiveOnly ?? true;
    const resolvedViewportOnly = viewportOnly ?? profileDefaults.viewportOnly ?? false;
    const resolvedRootSelector = resolveRootScopeSelector(page, frame, { rootSelector, rootElementId });
    const interactiveSelector = 'a[href], button, input, select, textarea, label[for], label[data-test-text-selectable-option__label], [role="button"], [role="link"], [onclick], [role="radio"], [role="checkbox"]';
    const baseSelector = resolvedInteractiveOnly ? interactiveSelector : '*';

    clearElementCache();
    const contextKey = setElementCacheContext(page, frame);
    let elements = [];
    if (resolvedRootSelector) {
      const root = scope.locator(resolvedRootSelector).first();
      if ((await root.count()) === 0) {
        throw new Error(`Root selector not found for list: ${resolvedRootSelector}`);
      }
      elements = await root.locator(baseSelector).elementHandles();
    } else {
      elements = await scope.$$(baseSelector);
    }

    const viewport = await scope.evaluate(() => ({
      width: window.innerWidth || 0,
      height: window.innerHeight || 0
    }));
    const items = [];
    let id = 1;
    const totalCandidates = elements.length;
    let visibleCandidates = 0;
    let viewportFilteredOut = 0;
    let acceptedCandidates = 0;

    for (const handle of elements) {
      const info = await handle.evaluate((node, maxTextChars) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';

        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const trunc = (s) => {
          const t = clean(s);
          return t.length > maxTextChars && maxTextChars > 0
            ? t.slice(0, Math.max(0, maxTextChars - 3)) + '...'
            : t;
        };

        const escapeCss = (value) => {
          if (window.CSS && CSS.escape) return CSS.escape(value);
          return String(value || '').replace(/([ #;?%&,.+*~':"!^$\\[\\]()=>|\/@])/g, '\\\\$1');
        };

        const makeSelector = (el) => {
          if (!el || el.nodeType !== 1) return '';
          if (el.id) return `#${escapeCss(el.id)}`;
          const testId = el.getAttribute('data-testid');
          if (testId) return `[data-testid="${escapeCss(testId)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria && aria.length <= 120) return `${el.tagName.toLowerCase()}[aria-label="${escapeCss(aria)}"]`;
          const name = el.getAttribute('name');
          if (name && name.length <= 120) return `${el.tagName.toLowerCase()}[name="${escapeCss(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${escapeCss(role)}"]`;

          const parts = [];
          let cur = el;
          while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
            let part = cur.tagName.toLowerCase();
            const parent = cur.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((n) => n.tagName === cur.tagName);
              if (siblings.length > 1) {
                const index = siblings.indexOf(cur) + 1;
                part += `:nth-of-type(${index})`;
              }
            }
            parts.unshift(part);
            cur = cur.parentElement;
            if (parts.length >= 6) break;
          }
          return parts.join(' > ');
        };

        const ariaLabelRaw = node.getAttribute('aria-label') || '';
        const titleRaw = node.getAttribute('title') || '';
        const roleRaw = node.getAttribute('role') || '';
        const hrefRaw = node.getAttribute('href') || '';
        const ariaCheckedRaw = node.getAttribute('aria-checked') || '';
        const tag = node.tagName.toLowerCase();
        const type = tag === 'input' ? node.getAttribute('type') || '' : '';
        const rawValue = tag === 'input' || tag === 'textarea' ? String(node.value || '') : node.getAttribute('value') || '';

        const rawText = ariaLabelRaw || node.innerText || titleRaw || rawValue;
        const selector = makeSelector(node);

        return {
          visible,
          selector,
          tag,
          role: clean(roleRaw),
          type,
          text: trunc(rawText),
          href: trunc(hrefRaw),
          ariaLabel: trunc(ariaLabelRaw),
          ariaChecked: clean(ariaCheckedRaw),
          value: trunc(rawValue),
          valueLength: rawValue.length,
          viewportBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      }, resolvedMaxTextChars);

      if (info.visible) visibleCandidates += 1;
      if (resolvedVisibleOnly && !info.visible) continue;
      if (resolvedViewportOnly) {
        const box = info.viewportBox;
        const intersectsViewport = box &&
          box.width > 0 &&
          box.height > 0 &&
          box.x < viewport.width &&
          box.y < viewport.height &&
          box.x + box.width > 0 &&
          box.y + box.height > 0;
        if (!intersectsViewport) {
          viewportFilteredOut += 1;
          continue;
        }
      }

      acceptedCandidates += 1;
      const canCollect = !resolvedLimit || items.length < resolvedLimit;
      if (!canCollect) {
        // Continue scanning to compute accurate coverage counters.
        continue;
      }

      state.elements.set(id, {
        contextKey,
        selector: info.selector || null,
        tag: info.tag,
        type: info.type,
        role: info.role,
        text: info.text,
        href: info.href,
        ariaLabel: info.ariaLabel
      });
      const outputInfo = { ...info };
      if (!resolvedIncludeSelectors) delete outputInfo.selector;
      delete outputInfo.viewportBox;
      if (resolvedDetail === 'low') {
        delete outputInfo.href;
        delete outputInfo.value;
        delete outputInfo.valueLength;
      }
      items.push({ id, ...outputInfo });
      id += 1;
    }

    const scrollMetrics = await scope.evaluate((rootSelector) => {
      const readMetrics = (el) => {
        const scrollTop = el?.scrollTop || 0;
        const scrollHeight = el?.scrollHeight || 0;
        const clientHeight = el?.clientHeight || 0;
        return {
          scrollTop,
          scrollHeight,
          clientHeight,
          atBottom: scrollTop + clientHeight >= scrollHeight - 2
        };
      };

      const docEl = document.scrollingElement || document.documentElement;
      const documentMetrics = readMetrics(docEl);
      const isScrollableContainer = (el) => {
        if (!el || el === docEl) return false;
        const style = window.getComputedStyle(el);
        const overflowY = String(style.overflowY || '');
        const overflow = /(auto|scroll|overlay)/i.test(overflowY);
        return overflow && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0;
      };

      let container = null;
      if (rootSelector) {
        const root = document.querySelector(rootSelector);
        if (isScrollableContainer(root)) {
          const metrics = readMetrics(root);
          container = {
            kind: 'root',
            ...metrics
          };
        }
      }

      if (!container) {
        let bestEl = null;
        let bestRange = 0;
        const all = document.querySelectorAll('body *');
        const cap = Math.min(all.length, 500);
        for (let i = 0; i < cap; i += 1) {
          const el = all[i];
          if (!isScrollableContainer(el)) continue;
          const range = (el.scrollHeight || 0) - (el.clientHeight || 0);
          if (range > bestRange) {
            bestRange = range;
            bestEl = el;
          }
        }
        if (bestEl) {
          container = {
            kind: 'auto',
            ...readMetrics(bestEl)
          };
        }
      }

      return {
        // Backward-compatible top-level fields (document scroll).
        scrollTop: documentMetrics.scrollTop,
        scrollHeight: documentMetrics.scrollHeight,
        clientHeight: documentMetrics.clientHeight,
        atBottom: documentMetrics.atBottom,
        // Extended metrics.
        document: documentMetrics,
        container,
        primaryScrollTarget: container && !container.atBottom ? 'container' : 'document'
      };
    }, resolvedRootSelector || null);

    const hasOffViewportCandidates = resolvedViewportOnly && viewportFilteredOut > 0;
    const containerNeedsScroll = Boolean(scrollMetrics.container && !scrollMetrics.container.atBottom);
    const needsScrollForMore = hasOffViewportCandidates && (!scrollMetrics.atBottom || containerNeedsScroll);

    return respond(withFrameMeta(page, frame, {
      detail: resolvedDetail,
      profile: getActiveCaptureProfile(),
      rootSelector: resolvedRootSelector,
      visibleOnly: resolvedVisibleOnly,
      interactiveOnly: resolvedInteractiveOnly,
      viewportOnly: resolvedViewportOnly,
      limit: resolvedLimit,
      count: items.length,
      totalCandidates,
      visibleCandidates,
      acceptedCandidates,
      viewportFilteredOut,
      hasOffViewportCandidates,
      needsScrollForMore,
      scrollState: scrollMetrics,
      truncated: Boolean(resolvedLimit && acceptedCandidates > items.length),
      coverageHint: needsScrollForMore
        ? (containerNeedsScroll
            ? 'Additional off-viewport candidates exist in a scrollable container. Scroll container and run browser.list again.'
            : 'Additional off-viewport candidates exist. Scroll and run browser.list again.')
        : null,
      items
    }));
  }
);

server.registerTool(
  'browser.hover',
  {
    description: 'Hover an element by uid, elementId, selector, or text.',
    inputSchema: {
      uid: z.string().optional(),
      elementId: z.number().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      force: z.boolean().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ uid, elementId, selector, text, frameId, frameSelector, force, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const hoverOptions = {
      force: force ?? false,
      timeout: clampNumber(timeoutMs, 1000, 120000, 30000)
    };

    if (uid) {
      const backendNodeId = getBackendNodeIdForUid(page, uid, frame);
      await hoverByBackendNodeId(page, backendNodeId);
      clearElementCache();
      return respond(withFrameMeta(page, frame, { status: 'hovered', via: 'uid', uid, changed: true }));
    }

    if (elementId) {
      const cached = getCachedElement(page, frame, elementId);
      if (cached.selector) {
        const locator = scope.locator(cached.selector).first();
        if ((await locator.count()) === 0) {
          throw new Error(`No element found for cached selector (elementId ${elementId}). Run browser.list again.`);
        }
        await locator.hover(hoverOptions);
      } else if (cached.text) {
        await scope.getByText(cached.text, { exact: false }).first().hover(hoverOptions);
      } else {
        throw new Error(`Cached element ${elementId} has no selector/text to hover. Run browser.list again.`);
      }
      clearElementCache();
      return respond(withFrameMeta(page, frame, { status: 'hovered', via: 'elementId', elementId, changed: true }));
    }

    if (selector) {
      await scope.hover(selector, hoverOptions);
      clearElementCache();
      return respond(withFrameMeta(page, frame, { status: 'hovered', via: 'selector', selector, changed: true }));
    }

    if (text) {
      await scope.getByText(text, { exact: false }).first().hover(hoverOptions);
      clearElementCache();
      return respond(withFrameMeta(page, frame, { status: 'hovered', via: 'text', text, changed: true }));
    }

    throw new Error('Provide uid, elementId, selector, or text to hover.');
  }
);

server.registerTool(
  'browser.click',
  {
    description: 'Click an element by elementId, selector, or text.',
    inputSchema: {
      uid: z.string().optional(),
      elementId: z.number().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      force: z.boolean().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ uid, elementId, selector, text, frameId, frameSelector, force, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const clickOptions = {
      force: force ?? false,
      timeout: clampNumber(timeoutMs, 1000, 120000, 30000)
    };

    if (uid) {
      const backendNodeId = getBackendNodeIdForUid(page, uid, frame);
      const result = await clickByBackendNodeId(page, backendNodeId);
      clearElementCache();
      return respond(withFrameMeta(page, frame, { status: 'clicked', via: 'uid', uid, ...result }));
    }

    if (elementId) {
      const cached = getCachedElement(page, frame, elementId);

      if (cached.selector) {
        const locator = scope.locator(cached.selector).first();
        if ((await locator.count()) === 0) {
          throw new Error(`No element found for cached selector (elementId ${elementId}). Run browser.list again.`);
        }

        // Many UIs render radios/checkboxes as obstructed inputs with a clickable <label>.
        if (cached.tag === 'input' && (cached.type === 'radio' || cached.type === 'checkbox')) {
          const clickedLabel = await locator.evaluate((node) => {
            const input = node;
            let label = null;
            try {
              if (input?.labels && input.labels.length) label = input.labels[0];
            } catch {
              label = null;
            }
            if (!label) {
              const id = input?.id;
              if (id && window.CSS && CSS.escape) {
                label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              }
            }
            if (!label && input?.closest) {
              label = input.closest('label');
            }
            if (label) {
              try { label.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
              label.click();
              return true;
            }
            return false;
          });
          if (clickedLabel) {
            clearElementCache();
            return respond(withFrameMeta(page, frame, { status: 'clicked', via: 'label', elementId }));
          }
        }

        try {
          await locator.scrollIntoViewIfNeeded();
          await locator.click(clickOptions);
        } catch (err) {
          const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
          throw new Error(`Click failed for elementId ${elementId}. Details: ${msg}`);
        }
      } else if (cached.text) {
        const locator = scope.getByText(cached.text, { exact: false }).first();
        await locator.click(clickOptions);
      } else {
        throw new Error(`Cached element ${elementId} has no selector/text to click. Run browser.list again.`);
      }
    } else if (selector) {
      try {
        await scope.click(selector, clickOptions);
      } catch (err) {
        const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
        throw new Error(`Click failed for selector "${selector}". Details: ${msg}`);
      }
    } else if (text) {
      const locator = scope.getByText(text, { exact: false });
      try {
        await locator.first().click(clickOptions);
      } catch (err) {
        const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
        throw new Error(`Click failed for text "${text}". Details: ${msg}`);
      }
    } else {
      throw new Error('Provide elementId, selector, or text to click.');
    }

    clearElementCache();
    return respond(withFrameMeta(page, frame, { status: 'clicked' }));
  }
);

server.registerTool(
  'browser.type',
  {
    description: 'Type into an input by selector or cached elementId.',
    inputSchema: {
      text: z.string(),
      selector: z.string().optional(),
      elementId: z.number().optional(),
      clear: z.boolean().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ text, selector, elementId, clear, frameId, frameSelector, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);

    if (elementId) {
      const cached = getCachedElement(page, frame, elementId);
      if (!cached.selector) throw new Error(`Cached element ${elementId} has no selector. Run browser.list again.`);
      const locator = scope.locator(cached.selector).first();
      if ((await locator.count()) === 0) throw new Error(`No element found for cached selector (elementId ${elementId}). Run browser.list again.`);
      if (clear) await locator.fill('');
      await locator.type(text);
    } else if (selector) {
      if (clear) await scope.fill(selector, '');
      await scope.type(selector, text);
    } else {
      throw new Error('Provide selector or elementId.');
    }

    return respond(withFrameMeta(page, frame, { status: 'typed', textLength: text.length }));
  }
);

server.registerTool(
  'browser.fill',
  {
    description: 'Fill an input/textarea by selector or cached elementId (sets full value).',
    inputSchema: {
      text: z.string(),
      uid: z.string().optional(),
      selector: z.string().optional(),
      elementId: z.number().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ text, uid, selector, elementId, frameId, frameSelector, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);

    if (uid) {
      const backendNodeId = getBackendNodeIdForUid(page, uid, frame);
      const payload = await setValueByBackendNodeId(page, backendNodeId, text);
      return respond(withFrameMeta(page, frame, {
        status: 'filled',
        via: 'uid',
        uid,
        textLength: text.length,
        actualLength: String(payload.value || '').length
      }));
    }

    if (elementId) {
      const cached = getCachedElement(page, frame, elementId);
      if (!cached.selector) throw new Error(`Cached element ${elementId} has no selector. Run browser.list again.`);
      const locator = scope.locator(cached.selector).first();
      if ((await locator.count()) === 0) throw new Error(`No element found for cached selector (elementId ${elementId}). Run browser.list again.`);
      await locator.fill(text);
    } else if (selector) {
      await scope.fill(selector, text);
    } else {
      throw new Error('Provide selector or elementId.');
    }

    return respond(withFrameMeta(page, frame, { status: 'filled', textLength: text.length }));
  }
);

server.registerTool(
  'browser.set_input_files',
  {
    description: 'Set files on an <input type="file"> by selector or cached elementId.',
    inputSchema: {
      paths: z.union([z.string(), z.array(z.string())]),
      selector: z.string().optional(),
      elementId: z.number().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ paths, selector, elementId, frameId, frameSelector, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const filePaths = Array.isArray(paths) ? paths : [paths];
    const resolvedPaths = [];
    for (const filePath of filePaths) {
      resolvedPaths.push(await assertAllowedReadPath(filePath));
    }

    if (elementId) {
      const cached = getCachedElement(page, frame, elementId);
      if (!cached.selector) throw new Error(`Cached element ${elementId} has no selector. Run browser.list again.`);
      const locator = scope.locator(cached.selector).first();
      if ((await locator.count()) === 0) throw new Error(`No element found for cached selector (elementId ${elementId}). Run browser.list again.`);
      await locator.setInputFiles(resolvedPaths);
    } else if (selector) {
      await scope.setInputFiles(selector, resolvedPaths);
    } else {
      throw new Error('Provide selector or elementId.');
    }

    return respond(withFrameMeta(page, frame, { status: 'files-set', count: resolvedPaths.length }));
  }
);

server.registerTool(
  'browser.scroll_to_uid',
  {
    description: 'Scroll the element identified by a uid (from browser.take_snapshot) into view.',
    inputSchema: {
      uid: z.string(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ uid, frameId, frameSelector, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const backendNodeId = getBackendNodeIdForUid(page, uid, frame);
    await scrollIntoViewIfNeeded(page, backendNodeId);
    clearElementCache();
    return respond(withFrameMeta(page, frame, { status: 'scrolled', uid }));
  }
);

server.registerTool(
  'browser.press',
  {
    description: 'Press a key, optionally focusing selector or elementId.',
    inputSchema: {
      key: z.string(),
      selector: z.string().optional(),
      elementId: z.number().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ key, selector, elementId, frameId, frameSelector, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const normalizedKey = normalizeKey(key);

    if (elementId) {
      const cached = getCachedElement(page, frame, elementId);
      if (!cached.selector) throw new Error(`Cached element ${elementId} has no selector. Run browser.list again.`);
      const locator = scope.locator(cached.selector).first();
      if ((await locator.count()) === 0) throw new Error(`No element found for cached selector (elementId ${elementId}). Run browser.list again.`);
      await locator.focus();
    } else if (selector) {
      await scope.focus(selector);
    }

    await page.keyboard.press(normalizedKey);
    return respond(withFrameMeta(page, frame, { status: 'pressed', key: normalizedKey }));
  }
);

server.registerTool(
  'browser.extract_text',
  {
    description: 'Extract text from a selector. Use all=true to get all matches.',
    inputSchema: {
      selector: z.string(),
      all: z.boolean().optional(),
      maxChars: z.number().optional(),
      limit: z.number().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ selector, all, maxChars, limit, frameId, frameSelector, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const maxCharsPerItem = clampNumber(maxChars, 0, 5000, 2000);
    const maxItems = clampNumber(limit, 1, 200, 50);
    if (all) {
      const result = await scope.$$eval(selector, (nodes, maxItems) => {
        const total = nodes.length;
        const texts = nodes
          .slice(0, maxItems)
          .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        return { total, texts };
      }, maxItems);

      const truncated = maxCharsPerItem > 0
        ? result.texts.map((t) => (t.length > maxCharsPerItem ? t.slice(0, maxCharsPerItem) : t))
        : result.texts;

      return respond(withFrameMeta(page, frame, {
        selector,
        totalMatches: result.total,
        returned: result.texts.length,
        limit: maxItems,
        maxChars: maxCharsPerItem,
        texts: truncated
      }));
    }

    const text = await scope.$eval(selector, (node) => (node.textContent || '').replace(/\s+/g, ' ').trim());
    const sliced = maxCharsPerItem > 0 && text.length > maxCharsPerItem ? text.slice(0, maxCharsPerItem) : text;
    return respond(withFrameMeta(page, frame, { selector, maxChars: maxCharsPerItem, text: sliced }));
  }
);

server.registerTool(
  'browser.extract_html',
  {
    description: 'Extract outerHTML from a selector.',
    inputSchema: {
      selector: z.string(),
      maxChars: z.number().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ selector, maxChars, frameId, frameSelector, timeoutMs }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const html = await scope.$eval(selector, (node) => node.outerHTML || '');
    const limit = clampNumber(maxChars, 0, 20000, 5000);
    const truncated = limit > 0 && html.length > limit;
    const sliced = limit === 0 ? '' : (truncated ? html.slice(0, limit) : html);
    return respond(withFrameMeta(page, frame, { selector, length: html.length, truncated, html: sliced }));
  }
);

server.registerTool(
  'browser.screenshot',
  {
    description: 'Save a screenshot to a path.',
    inputSchema: {
      path: z.string(),
      fullPage: z.boolean().optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ path: targetPath, fullPage, timeoutMs }) => {
    const page = ensurePage();
    const absPath = await assertAllowedWritePath(targetPath);
    await ensureDir(absPath);
    const resolvedFullPage = fullPage ?? true;
    const resolvedTimeout = clampNumber(timeoutMs, 1000, 300000, resolvedFullPage ? 90000 : 30000);
    await page.screenshot({ path: absPath, fullPage: resolvedFullPage, timeout: resolvedTimeout });
    return respond({ status: 'saved', path: absPath });
  }
);

server.registerTool(
  'browser.visual_snapshot',
  {
    description: 'Take a screenshot and return an element map with bounding boxes for visual navigation.',
    inputSchema: {
      path: z.string(),
      detail: z.enum(['low', 'high']).optional(),
      fullPage: z.boolean().optional(),
      viewportOnly: z.boolean().optional(),
      visibleOnly: z.boolean().optional(),
      timeoutMs: z.number().optional(),
      limit: z.number().optional(),
      maxItems: z.number().optional(),
      interactiveOnly: z.boolean().optional(),
      maxTextChars: z.number().optional(),
      includeText: z.boolean().optional(),
      includeSelectors: z.boolean().optional(),
      rootSelector: z.string().optional(),
      rootElementId: z.number().optional(),
      saveMapPath: z.string().optional(),
      frameId: z.string().optional(),
      frameSelector: z.string().optional()
    }
  },
  async ({
    path: targetPath,
    detail,
    fullPage,
    viewportOnly,
    visibleOnly,
    timeoutMs,
    limit,
    maxItems,
    interactiveOnly,
    maxTextChars,
    includeText,
    includeSelectors,
    rootSelector,
    rootElementId,
    saveMapPath,
    frameId,
    frameSelector
  }) => {
    const page = ensurePage();
    const frame = await resolveFrame(page, { frameId, frameSelector, timeoutMs });
    const scope = getFrameScope(page, frame);
    const resolvedDetail = normalizeCaptureDetail(detail);
    const profileDefaults = resolveCaptureDefaults('visual_snapshot', resolvedDetail);
    const resolvedRootSelector = resolveRootScopeSelector(page, frame, { rootSelector, rootElementId });
    const absPath = await assertAllowedWritePath(targetPath);
    await ensureDir(absPath);
    const resolvedFullPage = fullPage ?? profileDefaults.fullPage ?? false;
    const resolvedViewportOnly = viewportOnly ?? profileDefaults.viewportOnly ?? !resolvedFullPage;
    const resolvedVisibleOnly = visibleOnly ?? profileDefaults.visibleOnly ?? true;
    const resolvedInteractiveOnly = interactiveOnly ?? profileDefaults.interactiveOnly ?? true;
    const resolvedIncludeText = includeText ?? profileDefaults.includeText ?? false;
    const resolvedIncludeSelectors = includeSelectors ?? profileDefaults.includeSelectors ?? false;
    const resolvedLimit = clampNumber(maxItems ?? limit ?? profileDefaults.maxItems, 1, 500, 200);
    const resolvedMaxTextChars = clampNumber(maxTextChars ?? profileDefaults.maxTextChars, 20, 500, 160);
    const resolvedTimeout = clampNumber(timeoutMs, 1000, 300000, resolvedFullPage ? 90000 : 30000);
    await page.screenshot({ path: absPath, fullPage: resolvedFullPage, timeout: resolvedTimeout });

    // Use top-level viewport metrics for spatial filtering because Playwright boundingBox()
    // returns coordinates in the page viewport coordinate space (even for iframe elements).
    const scroll = await page.evaluate(() => ({
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0,
      innerWidth: window.innerWidth || 0,
      innerHeight: window.innerHeight || 0
    }));
    const coordSpace = resolvedFullPage ? 'page' : 'viewport';

    clearElementCache();
    const contextKey = setElementCacheContext(page, frame);
    const selector = resolvedInteractiveOnly === false
      ? '*'
      : 'a[href], button, input, select, textarea, label[for], label[data-test-text-selectable-option__label], [role="button"], [role="link"], [onclick], [role="radio"], [role="checkbox"]';

    let handles = [];
    if (resolvedRootSelector) {
      const root = scope.locator(resolvedRootSelector).first();
      if ((await root.count()) === 0) {
        throw new Error(`Root selector not found for visual_snapshot: ${resolvedRootSelector}`);
      }
      handles = await root.locator(selector).elementHandles();
    } else {
      handles = await scope.$$(selector);
    }
    const items = [];
    let id = 1;

    for (const handle of handles) {
      const box = await handle.boundingBox();
      if (!box || box.width < 1 || box.height < 1) continue;

      if (resolvedViewportOnly && box) {
        const isInViewport =
          box.x < scroll.innerWidth &&
          box.y < scroll.innerHeight &&
          box.x + box.width > 0 &&
          box.y + box.height > 0;
        if (!isInViewport) continue;
      }

      const info = await handle.evaluate((node, maxTextChars, includeText) => {
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const trunc = (s) => {
          const t = clean(s);
          return t.length > maxTextChars && maxTextChars > 0
            ? t.slice(0, Math.max(0, maxTextChars - 3)) + '...'
            : t;
        };

        const escapeCss = (value) => {
          if (window.CSS && CSS.escape) return CSS.escape(value);
          return String(value || '').replace(/([ #;?%&,.+*~':"!^$\\[\\]()=>|\/@])/g, '\\\\$1');
        };

        const makeSelector = (el) => {
          if (!el || el.nodeType !== 1) return '';
          if (el.id) return `#${escapeCss(el.id)}`;
          const testId = el.getAttribute('data-testid');
          if (testId) return `[data-testid="${escapeCss(testId)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria && aria.length <= 120) return `${el.tagName.toLowerCase()}[aria-label="${escapeCss(aria)}"]`;
          const name = el.getAttribute('name');
          if (name && name.length <= 120) return `${el.tagName.toLowerCase()}[name="${escapeCss(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${escapeCss(role)}"]`;

          const parts = [];
          let cur = el;
          while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
            let part = cur.tagName.toLowerCase();
            const parent = cur.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((n) => n.tagName === cur.tagName);
              if (siblings.length > 1) {
                const index = siblings.indexOf(cur) + 1;
                part += `:nth-of-type(${index})`;
              }
            }
            parts.unshift(part);
            cur = cur.parentElement;
            if (parts.length >= 6) break;
          }
          return parts.join(' > ');
        };

        const ariaLabelRaw = node.getAttribute('aria-label') || '';
        const titleRaw = node.getAttribute('title') || '';
        const roleRaw = node.getAttribute('role') || '';
        const hrefRaw = node.getAttribute('href') || '';
        const ariaCheckedRaw = node.getAttribute('aria-checked') || '';
        const tag = node.tagName.toLowerCase();
        const type = tag === 'input' ? node.getAttribute('type') || '' : '';
        const rawValue = tag === 'input' || tag === 'textarea' ? String(node.value || '') : node.getAttribute('value') || '';
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0;

        const rawText = ariaLabelRaw || node.innerText || titleRaw || rawValue;
        const selector = makeSelector(node);

        return {
          text: includeText ? trunc(rawText) : '',
          selector,
          tag,
          role: clean(roleRaw),
          type,
          href: trunc(hrefRaw),
          ariaLabel: trunc(ariaLabelRaw),
          ariaChecked: clean(ariaCheckedRaw),
          value: trunc(rawValue),
          valueLength: rawValue.length,
          visible
        };
      }, resolvedMaxTextChars, resolvedIncludeText);

      if (resolvedVisibleOnly && !info.visible) continue;

      state.elements.set(id, {
        contextKey,
        selector: info.selector || null,
        tag: info.tag,
        type: info.type,
        role: info.role,
        text: info.text || info.ariaLabel || '',
        href: info.href,
        ariaLabel: info.ariaLabel
      });
      const outputInfo = { ...info };
      if (!resolvedIncludeSelectors) delete outputInfo.selector;
      if (!resolvedIncludeText) delete outputInfo.text;
      if (!resolvedVisibleOnly) delete outputInfo.visible;
      if (resolvedDetail === 'low') {
        delete outputInfo.href;
        delete outputInfo.value;
        delete outputInfo.valueLength;
      }
      items.push({
        id,
        ...outputInfo,
        bbox: {
          x: Math.round(coordSpace === 'page' ? (box?.x ?? 0) + scroll.scrollX : (box?.x ?? 0)),
          y: Math.round(coordSpace === 'page' ? (box?.y ?? 0) + scroll.scrollY : (box?.y ?? 0)),
          width: Math.round(box?.width ?? 0),
          height: Math.round(box?.height ?? 0)
        }
      });
      id += 1;

      if (resolvedLimit && items.length >= resolvedLimit) break;
    }

    const payload = {
      detail: resolvedDetail,
      profile: getActiveCaptureProfile(),
      screenshotPath: absPath,
      rootSelector: resolvedRootSelector,
      fullPage: resolvedFullPage,
      viewportOnly: resolvedViewportOnly,
      visibleOnly: resolvedVisibleOnly,
      interactiveOnly: resolvedInteractiveOnly,
      includeText: resolvedIncludeText,
      count: items.length,
      totalCandidates: handles.length,
      truncated: items.length >= resolvedLimit && handles.length > items.length,
      items,
      coordSpace,
      scrollX: scroll.scrollX,
      scrollY: scroll.scrollY,
      viewport: page.viewportSize()
    };

    if (saveMapPath) {
      const absMap = await assertAllowedWritePath(saveMapPath);
      await ensureDir(absMap);
      await fs.writeFile(absMap, JSON.stringify(payload, null, 2), 'utf8');
      payload.mapSavedTo = absMap;
    }

    return respond(withFrameMeta(page, frame, payload));
  }
);

server.registerTool(
  'browser.click_at',
  {
    description: 'Click at viewport coordinates (x, y). Use browser.click_at_page for page coordinates.',
    inputSchema: {
      x: z.number(),
      y: z.number(),
      button: z.enum(['left', 'middle', 'right']).optional(),
      clickCount: z.number().optional()
    }
  },
  async ({ x, y, button, clickCount }) => {
    const page = ensurePage();
    await page.mouse.click(x, y, { button: button || 'left', clickCount: clickCount || 1 });
    clearElementCache();
    return respond({ status: 'clicked', x, y });
  }
);

server.registerTool(
  'browser.click_at_page',
  {
    description: 'Click at page coordinates (x, y). Will scroll to bring the point into view first.',
    inputSchema: {
      x: z.number(),
      y: z.number(),
      button: z.enum(['left', 'middle', 'right']).optional(),
      clickCount: z.number().optional()
    }
  },
  async ({ x, y, button, clickCount }) => {
    const page = ensurePage();
    const viewport = page.viewportSize() || { width: 0, height: 0 };

    // Scroll so the target point is roughly centered.
    const targetScrollX = Math.max(0, Math.floor(x - viewport.width / 2));
    const targetScrollY = Math.max(0, Math.floor(y - viewport.height / 2));
    await page.evaluate(({ sx, sy }) => window.scrollTo(sx, sy), { sx: targetScrollX, sy: targetScrollY });

    const scroll = await page.evaluate(() => ({
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0
    }));

    const vx = Math.round(x - scroll.scrollX);
    const vy = Math.round(y - scroll.scrollY);

    await page.mouse.click(vx, vy, { button: button || 'left', clickCount: clickCount || 1 });
    clearElementCache();
    return respond({ status: 'clicked', coordSpace: 'page', x, y, viewportX: vx, viewportY: vy });
  }
);

server.registerTool(
  'browser.form_audit',
  {
    description: 'Audit the current page for missing required form fields (generic HTML forms).',
    inputSchema: {
      maxItems: z.number().optional(),
      includeSelectors: z.boolean().optional(),
      maxLabelChars: z.number().optional()
    }
  },
  async ({ maxItems, includeSelectors, maxLabelChars }) => {
    const page = ensurePage();
    const payload = await auditForm(page, {
      maxItems,
      includeSelectors,
      maxLabelChars
    });
    return respond(payload);
  }
);

server.registerTool(
  'browser.fill_form',
  {
    description: 'Fill a set of fields by label or selector (generic HTML forms).',
    inputSchema: {
      fields: z.array(
        z.object({
          label: z.string().optional(),
          selector: z.string().optional(),
          value: z.any(),
          kind: z.enum(['text', 'textarea', 'select', 'radio', 'checkbox', 'contenteditable']).optional()
        })
      ),
      timeoutMs: z.number().optional()
    }
  },
  async ({ fields, timeoutMs }) => {
    const page = ensurePage();
    const payload = await fillForm(page, fields, { timeoutMs });
    clearElementCache();
    return respond(payload);
  }
);

server.registerTool(
  'browser.list_console_messages',
  {
    description: 'List recent console logs and exceptions captured via CDP.',
    inputSchema: {
      limit: z.number().optional()
    }
  },
  async ({ limit }) => {
    const page = ensurePage();
    const payload = await listConsoleMessages(page, { limit });
    return respond({ count: payload.length, messages: payload });
  }
);

server.registerTool(
  'browser.list_network_requests',
  {
    description: 'List recent network requests captured via CDP.',
    inputSchema: {
      limit: z.number().optional(),
      urlContains: z.string().optional()
    }
  },
  async ({ limit, urlContains }) => {
    const page = ensurePage();
    const payload = await listNetworkRequests(page, { limit, urlContains });
    return respond({ count: payload.length, requests: payload });
  }
);

server.registerTool(
  'browser.get_network_request',
  {
    description: 'Get details for a captured network request (optionally includes response body).',
    inputSchema: {
      requestId: z.string(),
      includeBody: z.boolean().optional(),
      maxBodyChars: z.number().optional(),
      saveBodyPath: z.string().optional()
    }
  },
  async ({ requestId, includeBody, maxBodyChars, saveBodyPath }) => {
    const page = ensurePage();
    const payload = await getNetworkRequest(page, requestId, { includeBody, maxBodyChars });

    if (saveBodyPath && payload.body !== null) {
      const abs = await assertAllowedWritePath(saveBodyPath);
      await ensureDir(abs);
      await fs.writeFile(abs, String(payload.body), 'utf8');
      payload.bodySavedTo = abs;
    }

    return respond(payload);
  }
);

server.registerTool(
  'forms.google_audit',
  {
    description: 'Audit a Google Form page and return compact answer state by question.',
    inputSchema: {
      maxQuestions: z.number().optional(),
      maxAnswerChars: z.number().optional()
    }
  },
  async ({ maxQuestions, maxAnswerChars }) => {
    const page = ensurePage();
    const maxQ = clampNumber(maxQuestions, 1, 500, 200);
    const maxA = clampNumber(maxAnswerChars, 20, 2000, 400);

    const payload = await page.evaluate(({ maxQ, maxA }) => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const trunc = (s) => {
        const t = clean(s);
        if (maxA <= 0 || t.length <= maxA) return t;
        if (maxA <= 3) return t.slice(0, maxA);
        return t.slice(0, maxA - 3) + '...';
      };

      const blocks = Array.from(document.querySelectorAll('.Qr7Oae')).slice(0, maxQ);
      const questions = [];

      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        const titleEl = block.querySelector('[role=heading]');
        const title = clean(titleEl?.textContent);
        if (!title) continue;

        const listbox = block.querySelector('[role=listbox], [role=combobox]');
        const textarea = block.querySelector('textarea');
        const textInput =
          block.querySelector('input[type=text], input[type=email], input[type=url], input[type=date], input:not([type])');

        const checkboxEls = Array.from(block.querySelectorAll('div[role=checkbox]'))
          .filter((el) => clean(el.getAttribute('aria-label')));
        const radioEls = Array.from(block.querySelectorAll('div[role=radio]'))
          .filter((el) => clean(el.getAttribute('aria-label')));

        const q = {
          index: questions.length + 1,
          title,
          type: 'unknown',
          answered: false,
          answer: null
        };

        if (textarea) {
          const val = textarea.value || '';
          q.type = 'textarea';
          q.answer = trunc(val);
          q.answered = clean(val).length > 0;
        } else if (listbox) {
          q.type = 'dropdown';

          // Google Forms dropdowns typically have an aria-selected option even when unanswered
          // (e.g., "Choose"). Treat placeholders as unanswered.
          const placeholders = new Set(['choose', 'select', 'choose an option', 'select an option']);
          const selectedOptions = Array.from(block.querySelectorAll('[role=option][aria-selected=true]'));
          const selectedLabels = selectedOptions
            .map((el) => clean(el.getAttribute('data-value') || el.getAttribute('aria-label') || el.textContent))
            .filter(Boolean);
          const chosen = selectedLabels.find((v) => !placeholders.has(v.toLowerCase())) || '';

          q.answer = chosen ? trunc(chosen) : null;
          q.answered = Boolean(chosen);
        } else if (checkboxEls.length > 0) {
          const selected = checkboxEls
            .filter((el) => el.getAttribute('aria-checked') === 'true')
            .map((el) => clean(el.getAttribute('aria-label')))
            .filter(Boolean);
          q.type = 'checkbox';
          q.answer = selected;
          q.answered = selected.length > 0;
        } else if (radioEls.length > 0) {
          const labels = radioEls.map((el) => clean(el.getAttribute('aria-label'))).filter(Boolean);
          const isGrid = labels.some((l) => l.includes(', response for '));
          if (isGrid) {
            const rows = Array.from(new Set(labels
              .map((l) => {
                const parts = l.split(', response for ');
                return parts.length === 2 ? clean(parts[1]) : '';
              })
              .filter(Boolean)));

            const selectedByRow = {};
            for (const row of rows) {
              const chosen = radioEls.find((el) => {
                const label = clean(el.getAttribute('aria-label'));
                return label.endsWith(`, response for ${row}`) && el.getAttribute('aria-checked') === 'true';
              });
              if (chosen) {
                const label = clean(chosen.getAttribute('aria-label'));
                const parts = label.split(', response for ');
                selectedByRow[row] = parts.length ? clean(parts[0]) : label;
              }
            }

            q.type = 'grid';
            q.answer = selectedByRow;
            q.answered = rows.length > 0 && rows.every((row) => Boolean(selectedByRow[row]));
          } else {
            const selected = radioEls.find((el) => el.getAttribute('aria-checked') === 'true');
            const selectedLabel = selected ? clean(selected.getAttribute('aria-label')) : '';
            const isLinearScale = labels.length > 0 && labels.every((l) => /^\d+$/.test(l));
            q.type = isLinearScale ? 'linear_scale' : 'radio';
            q.answer = selectedLabel || null;
            q.answered = Boolean(selectedLabel);
          }
        } else if (textInput) {
          const val = textInput.value || '';
          q.type = textInput.getAttribute('type') === 'date' ? 'date' : 'text';
          q.answer = trunc(val);
          q.answered = clean(val).length > 0;
        }

        questions.push(q);
      }

      const missing = questions.filter((q) => !q.answered).map((q) => q.title);
      return {
        url: window.location.href,
        title: document.title,
        count: questions.length,
        unansweredCount: missing.length,
        missing,
        questions
      };
    }, { maxQ, maxA });

    return respond(payload);
  }
);

server.registerTool(
  'forms.google_set_text',
  {
    description: 'Fill a Google Form text/textarea/date question by matching its title.',
    inputSchema: {
      question: z.string(),
      value: z.string(),
      match: z.enum(['contains', 'exact']).optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ question, value, match, timeoutMs }) => {
    const page = ensurePage();
    const mode = match || 'contains';
    const qPattern = mode === 'exact'
      ? new RegExp(`^\\s*${escapeRegex(question)}\\s*$`, 'i')
      : new RegExp(escapeRegex(question), 'i');

    const block = page
      .locator('div.Qr7Oae')
      .filter({ has: page.locator('[role=heading]').filter({ hasText: qPattern }) })
      .first();

    if ((await block.count()) === 0) {
      throw new Error(`Google Form question not found: ${question}`);
    }

    const field = block.locator('textarea, input[type=text], input[type=email], input[type=url], input[type=date], input:not([type])').first();
    await field.scrollIntoViewIfNeeded();
    await field.fill(value, { timeout: timeoutMs || 30000 });
    const actual = await field.inputValue();

    return respond({
      status: 'filled',
      question,
      valueLength: value.length,
      actualLength: actual.length
    });
  }
);

server.registerTool(
  'forms.google_set_dropdown',
  {
    description: 'Select a Google Form dropdown option by matching its question title.',
    inputSchema: {
      question: z.string(),
      option: z.string(),
      match: z.enum(['contains', 'exact']).optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ question, option, match, timeoutMs }) => {
    const page = ensurePage();
    const mode = match || 'contains';
    const qPattern = mode === 'exact'
      ? new RegExp(`^\\s*${escapeRegex(question)}\\s*$`, 'i')
      : new RegExp(escapeRegex(question), 'i');

    const block = page
      .locator('div.Qr7Oae')
      .filter({ has: page.locator('[role=heading]').filter({ hasText: qPattern }) })
      .first();

    if ((await block.count()) === 0) {
      throw new Error(`Google Form dropdown question not found: ${question}`);
    }

    const listbox = block.locator('[role=listbox], [role=combobox]').first();
    await listbox.scrollIntoViewIfNeeded();
    await listbox.click({ timeout: timeoutMs || 30000 });

    // The page may contain multiple hidden dropdown option lists. Click the first visible match.
    const desiredOptions = page.getByRole('option', { name: option, exact: true });
    const deadline = Date.now() + (timeoutMs || 30000);
    let clicked = false;
    let matches = 0;

    while (!clicked && Date.now() < deadline) {
      matches = await desiredOptions.count();
      for (let i = 0; i < matches; i += 1) {
        const candidate = desiredOptions.nth(i);
        if (await candidate.isVisible()) {
          await candidate.click({ timeout: timeoutMs || 30000 });
          clicked = true;
          break;
        }
      }
      if (!clicked) await page.waitForTimeout(100);
    }

    if (!clicked) {
      throw new Error(`Dropdown option not visible: ${option} (matches=${matches})`);
    }

    // Determine the actual selected option. Google Forms often keeps a placeholder like "Choose"
    // selected; ignore placeholders when deciding if the dropdown is answered.
    const placeholders = new Set(['choose', 'select', 'choose an option', 'select an option']);
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const desired = clean(option);

    const selectedLabels = (await block.locator('[role=option][aria-selected=true]').allTextContents())
      .map(clean)
      .filter(Boolean);
    const chosen = selectedLabels.find((v) => !placeholders.has(v.toLowerCase())) || '';
    const ok = Boolean(chosen) && chosen.toLowerCase() === desired.toLowerCase();

    return respond({
      status: ok ? 'selected' : 'failed',
      question,
      option,
      chosen,
      selectedLabels: selectedLabels.slice(0, 10)
    });
  }
);

server.registerTool(
  'forms.google_set_checkbox',
  {
    description: 'Set a Google Form checkbox option by question title and option label (idempotent).',
    inputSchema: {
      question: z.string(),
      option: z.string(),
      checked: z.boolean().optional(),
      match: z.enum(['contains', 'exact']).optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ question, option, checked, match, timeoutMs }) => {
    const page = ensurePage();
    const desired = checked ?? true;
    const mode = match || 'contains';
    const qPattern = mode === 'exact'
      ? new RegExp(`^\\s*${escapeRegex(question)}\\s*$`, 'i')
      : new RegExp(escapeRegex(question), 'i');

    const block = page
      .locator('div.Qr7Oae')
      .filter({ has: page.locator('[role=heading]').filter({ hasText: qPattern }) })
      .first();

    if ((await block.count()) === 0) {
      throw new Error(`Google Form checkbox question not found: ${question}`);
    }

    const cb = block.getByRole('checkbox', { name: option, exact: true }).first();
    await cb.scrollIntoViewIfNeeded();
    const before = (await cb.getAttribute('aria-checked')) || 'false';
    const want = desired ? 'true' : 'false';
    if (before !== want) {
      await cb.click({ timeout: timeoutMs || 30000 });
    }
    const after = (await cb.getAttribute('aria-checked')) || 'false';

    return respond({
      status: after === want ? 'set' : 'failed',
      question,
      option,
      desired,
      before,
      after
    });
  }
);

server.registerTool(
  'forms.google_set_radio',
  {
    description: 'Select a Google Form radio/linear-scale option by question title and option label.',
    inputSchema: {
      question: z.string(),
      option: z.string(),
      match: z.enum(['contains', 'exact']).optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ question, option, match, timeoutMs }) => {
    const page = ensurePage();
    const mode = match || 'contains';
    const qPattern = mode === 'exact'
      ? new RegExp(`^\\s*${escapeRegex(question)}\\s*$`, 'i')
      : new RegExp(escapeRegex(question), 'i');

    const block = page
      .locator('div.Qr7Oae')
      .filter({ has: page.locator('[role=heading]').filter({ hasText: qPattern }) })
      .first();

    if ((await block.count()) === 0) {
      throw new Error(`Google Form radio question not found: ${question}`);
    }

    const radio = block.getByRole('radio', { name: option, exact: true }).first();
    await radio.scrollIntoViewIfNeeded();
    await radio.click({ timeout: timeoutMs || 30000 });
    const after = (await radio.getAttribute('aria-checked')) || 'false';

    return respond({
      status: after === 'true' ? 'selected' : 'failed',
      question,
      option,
      ariaChecked: after
    });
  }
);

server.registerTool(
  'forms.google_set_grid',
  {
    description: 'Select a Google Form multiple-choice grid cell by row and column values.',
    inputSchema: {
      question: z.string(),
      row: z.string(),
      column: z.string(),
      match: z.enum(['contains', 'exact']).optional(),
      timeoutMs: z.number().optional()
    }
  },
  async ({ question, row, column, match, timeoutMs }) => {
    const page = ensurePage();
    const mode = match || 'contains';
    const qPattern = mode === 'exact'
      ? new RegExp(`^\\s*${escapeRegex(question)}\\s*$`, 'i')
      : new RegExp(escapeRegex(question), 'i');

    const block = page
      .locator('div.Qr7Oae')
      .filter({ has: page.locator('[role=heading]').filter({ hasText: qPattern }) })
      .first();

    if ((await block.count()) === 0) {
      throw new Error(`Google Form grid question not found: ${question}`);
    }

    const cellLabel = `${column}, response for ${row}`;
    const radio = block.getByRole('radio', { name: cellLabel, exact: true }).first();
    await radio.scrollIntoViewIfNeeded();
    await radio.click({ timeout: timeoutMs || 30000 });
    const after = (await radio.getAttribute('aria-checked')) || 'false';

    return respond({
      status: after === 'true' ? 'selected' : 'failed',
      question,
      row,
      column,
      cellLabel,
      ariaChecked: after
    });
  }
);

server.registerTool(
  'files.read_text',
  {
    description: 'Read text from a file path (restricted to Applied Jobs and Auto output/logs).',
    inputSchema: {
      path: z.string(),
      maxChars: z.number().optional()
    }
  },
  async ({ path: targetPath, maxChars }) => {
    const absPath = await assertAllowedReadPath(targetPath);

    const stat = await fs.stat(absPath);
    const maxBytes = 2 * 1024 * 1024;
    if (stat.size > maxBytes) {
      throw new Error(`File too large to read (${stat.size} bytes). Limit is ${maxBytes} bytes.`);
    }

    const ext = path.extname(absPath).toLowerCase();
    const binaryExts = new Set([
      '.pdf',
      '.doc',
      '.docx',
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.gif',
      '.zip',
      '.rar',
      '.7z'
    ]);
    if (binaryExts.has(ext)) {
      if (ext === '.pdf') {
        throw new Error(`"${absPath}" is a PDF (binary). Use files.read_pdf_text or provide a CV.md/CV.txt instead.`);
      }
      throw new Error(`"${absPath}" is a binary file (${ext}). Provide a text version (.md/.txt) instead.`);
    }

    const text = await fs.readFile(absPath, 'utf8');
    const limit = clampNumber(maxChars, 0, 20000, 20000);
    const truncated = text.length > limit;
    const sliced = truncated ? text.slice(0, limit) : text;

    return respond({
      status: 'read',
      path: absPath,
      length: text.length,
      truncated,
      text: sliced
    });
  }
);

server.registerTool(
  'files.read_pdf_text',
  {
    description: 'Extract text from a PDF file (restricted to Applied Jobs and Auto output/logs).',
    inputSchema: {
      path: z.string(),
      maxChars: z.number().optional()
    }
  },
  async ({ path: targetPath, maxChars }) => {
    const absPath = await assertAllowedReadPath(targetPath);
    const ext = path.extname(absPath).toLowerCase();
    if (ext !== '.pdf') {
      throw new Error(`Not a PDF: ${absPath}`);
    }

    const stat = await fs.stat(absPath);
    const maxBytes = 10 * 1024 * 1024;
    if (stat.size > maxBytes) {
      throw new Error(`PDF too large (${stat.size} bytes). Limit is ${maxBytes} bytes.`);
    }

    const data = await fs.readFile(absPath);
    let pdfParse;
    try {
      const mod = await import('pdf-parse');
      pdfParse = mod?.default || mod;
    } catch (err) {
      const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
      throw new Error(`PDF parsing dependency is missing or failed to load. Install "pdf-parse". Details: ${msg}`);
    }

    const result = await pdfParse(data);
    const raw = String(result?.text || '');
    const cleaned = raw.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    const limit = clampNumber(maxChars, 0, 20000, 20000);
    const truncated = cleaned.length > limit;
    const sliced = truncated ? cleaned.slice(0, limit) : cleaned;

    return respond({
      status: 'read',
      path: absPath,
      pages: result?.numpages ?? null,
      length: cleaned.length,
      truncated,
      text: sliced
    });
  }
);

server.registerTool(
  'files.list_dir',
  {
    description: 'List files in an allowed directory (Applied Jobs, Auto/output, Auto/logs).',
    inputSchema: {
      path: z.string(),
      pattern: z.string().optional(),
      recursive: z.boolean().optional(),
      maxDepth: z.number().optional(),
      limit: z.number().optional(),
      includeDirs: z.boolean().optional()
    }
  },
  async ({ path: targetPath, pattern, recursive, maxDepth, limit, includeDirs }) => {
    const absPath = await assertAllowedReadPath(targetPath);
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${absPath}`);
    }

    const wantRecursive = recursive ?? false;
    const depthLimit = wantRecursive ? clampNumber(maxDepth, 0, 10, 2) : 0;
    const maxItems = clampNumber(limit, 1, 2000, 200);
    const includeDirectories = includeDirs ?? false;

    let matcher = null;
    if (pattern) {
      // Treat pattern as a glob (supports * and ?). Match against basename.
      const escaped = escapeRegex(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
      matcher = new RegExp(`^${escaped}$`, 'i');
    }

    const items = [];
    const walk = async (dir, depth) => {
      if (items.length >= maxItems) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (items.length >= maxItems) return;
        const full = path.join(dir, entry.name);
        const rel = path.relative(absPath, full);
        const isDir = entry.isDirectory();
        const isFile = entry.isFile();

        if (matcher && !matcher.test(entry.name)) {
          if (isDir && depth < depthLimit) {
            await walk(full, depth + 1);
          }
          continue;
        }

        if (isFile || (isDir && includeDirectories)) {
          let size = null;
          if (isFile) {
            try {
              const s = await fs.stat(full);
              size = s.size;
            } catch {
              size = null;
            }
          }
          items.push({
            relPath: rel.replace(/\\/g, '/'),
            name: entry.name,
            kind: isDir ? 'dir' : 'file',
            sizeBytes: size
          });
        }

        if (isDir && depth < depthLimit) {
          await walk(full, depth + 1);
        }
      }
    };

    await walk(absPath, 0);

    return respond({
      status: 'listed',
      path: absPath,
      recursive: wantRecursive,
      maxDepth: depthLimit,
      pattern: pattern || null,
      count: items.length,
      items
    });
  }
);

server.registerTool(
  'files.write_text',
  {
    description: 'Write arbitrary text to a file path.',
    inputSchema: {
      path: z.string(),
      text: z.string()
    }
  },
  async ({ path: targetPath, text }) => {
    const absPath = await assertAllowedWritePath(targetPath);
    await ensureDir(absPath);
    await fs.writeFile(absPath, text, 'utf8');
    return respond({ status: 'written', path: absPath, length: text.length });
  }
);

server.registerTool(
  'jobs.extract_indeed',
  {
    description: 'Extract jobs from an Indeed search results page. Optionally save each job to a .txt file.',
    inputSchema: {
      limit: z.number().optional(),
      saveDir: z.string().optional()
    }
  },
  async ({ limit, saveDir }) => {
    const page = ensurePage();
    const access = await detectIndeedAccessIssue(page);
    if (access.blocked || access.authRequired) {
      return respond({
        blocked: access.blocked,
        authRequired: access.authRequired,
        message:
          access.message ||
          'Indeed access issue detected. Try headful mode, a logged-in profile, or a different network/IP.'
      });
    }
    const jobs = await extractIndeedJobs(page, { limit: limit || 20 });
    const result = { count: jobs.length, jobs };

    if (saveDir) {
      const absDir = await assertAllowedWritePath(saveDir);
      const saved = await saveJobsToTxt(jobs, absDir);
      return respond({ ...result, saved });
    }

    return respond(result);
  }
);

server.registerTool(
  'jobs.indeed_next_page',
  {
    description: 'Go to the next Indeed results page (direct URL by default, with optional click mode).',
    inputSchema: {
      mode: z.enum(['direct', 'click', 'auto']).optional()
    }
  },
  async ({ mode }) => {
    const page = ensurePage();
    const navigationMode = mode || 'direct';

    const tryDirect = async () => {
      const currentUrl = new URL(page.url());
      const currentStart = Number.parseInt(currentUrl.searchParams.get('start') || '0', 10);
      const nextStart = Number.isNaN(currentStart) ? 10 : currentStart + 10;
      currentUrl.searchParams.set('start', String(nextStart));
      await page.goto(currentUrl.toString(), { waitUntil: 'domcontentloaded' });
      clearElementCache();
      return respond({ clicked: false, navigated: true, url: page.url(), start: nextStart });
    };

    const tryClick = async () => {
      const clicked = await clickIndeedNextPage(page);
      if (clicked) {
        await page.waitForLoadState('domcontentloaded');
        clearElementCache();
        return respond({ clicked, url: page.url() });
      }
      return null;
    };

    if (navigationMode === 'direct') {
      return await tryDirect();
    }

    if (navigationMode === 'click') {
      const result = await tryClick();
      if (result) return result;
      return respond({ clicked: false, navigated: false, url: page.url() });
    }

    // auto: direct first, then click
    try {
      return await tryDirect();
    } catch {
      const result = await tryClick();
      if (result) return result;
      return respond({ clicked: false, navigated: false, url: page.url() });
    }
  }
);

server.registerTool(
  'search.extract_google',
  {
    description: 'Extract standard Google search results from the current page. Optionally save to .txt files.',
    inputSchema: {
      limit: z.number().optional(),
      saveDir: z.string().optional()
    }
  },
  async ({ limit, saveDir }) => {
    const page = ensurePage();
    const blocked = await detectGoogleBlocked(page);
    if (blocked) {
      return respond({
        blocked: true,
        message: 'Google flagged this session as unusual traffic. Try headful mode or a different network/IP.'
      });
    }
    const results = await extractGoogleResults(page, { limit: limit || 10 });
    const payload = { count: results.length, results };

    if (saveDir) {
      const absDir = await assertAllowedWritePath(saveDir);
      const saved = await saveSearchResultsToTxt(results, absDir);
      return respond({ ...payload, saved });
    }

    return respond(payload);
  }
);

server.registerTool(
  'search.google',
  {
    description: 'Search Google and extract results for a query. Optionally save to .txt files.',
    inputSchema: {
      query: z.string(),
      limit: z.number().optional(),
      saveDir: z.string().optional()
    }
  },
  async ({ query, limit, saveDir }) => {
    const page = ensurePage();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await tryAcceptGoogleConsent(page);
    const blocked = await detectGoogleBlocked(page);
    if (blocked) {
      return respond({
        blocked: true,
        message: 'Google flagged this session as unusual traffic. Try headful mode or a different network/IP.'
      });
    }

    const results = await extractGoogleResults(page, { limit: limit || 10 });
    const payload = { query, count: results.length, results };

    if (saveDir) {
      const absDir = await assertAllowedWritePath(saveDir);
      const saved = await saveSearchResultsToTxt(results, absDir);
      return respond({ ...payload, saved });
    }

    return respond(payload);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('MCP Playwright browser server running...');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
