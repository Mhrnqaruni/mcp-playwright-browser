import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  page: null,
  elements: new Map(),
  persistent: false,
  cdpConnected: false,
  cdpManaged: false,
  cdpAutoClose: false,
  chromeProcess: null,
  lastLaunch: null
};

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

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

function ensurePage() {
  if (!state.page) {
    throw new Error('Browser is not launched. Run browser.launch or browser.connect_cdp first.');
  }
  return state.page;
}

function clearElementCache() {
  state.elements.clear();
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
  requireProfile: parseEnvBool('MCP_REQUIRE_PROFILE', 'GEMINI_CLI_MCP_REQUIRE_PROFILE')
};

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

    const pages = state.context.pages();
    state.page = pages.length ? pages[0] : await state.context.newPage();
    if (resolvedStealth && pages.length) {
      await state.page.reload({ waitUntil: 'domcontentloaded' });
    }

    clearElementCache();

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
    const pages = state.context.pages();
    state.page = pages.length ? pages[0] : await state.context.newPage();
    state.persistent = true;
    state.cdpConnected = true;
    state.cdpManaged = false;
    state.cdpAutoClose = false;
    state.chromeProcess = null;
    clearElementCache();

    return respond({
      status: 'connected',
      endpoint: url,
      pages: pages.length
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
    const resolvedWaitMs = waitMs ?? ENV_DEFAULTS.cdpWaitMs ?? 5000;
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
    if (resolvedStealth) {
      await state.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      });
    }
    const pages = state.context.pages();
    state.page = pages.length ? pages[0] : await state.context.newPage();
    if (resolvedStealth && pages.length) {
      await state.page.reload({ waitUntil: 'domcontentloaded' });
    }

    clearElementCache();

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
    state.page = await state.context.newPage();
    clearElementCache();
    return respond({ status: 'new-page', url: state.page.url() });
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
    clearElementCache();
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
    clearElementCache();
    return respond({ url: page.url(), title: await page.title() });
  }
);

server.registerTool(
  'browser.wait',
  {
    description: 'Wait for a selector or timeout.',
    inputSchema: {
      selector: z.string().optional(),
      timeoutMs: z.number().optional(),
      ms: z.number().optional()
    }
  },
  async ({ selector, timeoutMs, ms }) => {
    const page = ensurePage();
    if (selector) {
      await page.waitForSelector(selector, { timeout: timeoutMs || 15000 });
      return respond({ status: 'selector-ready', selector });
    }
    if (typeof ms === 'number') {
      await page.waitForTimeout(ms);
      return respond({ status: 'waited', ms });
    }
    return respond({ status: 'no-op' });
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
  'browser.snapshot',
  {
    description: 'Return a snapshot of the current page (title, url, text, links).',
    inputSchema: {
      maxChars: z.number().optional(),
      maxLinks: z.number().optional()
    }
  },
  async ({ maxChars, maxLinks }) => {
    const page = ensurePage();
    const snapshot = await page.evaluate(({ maxChars, maxLinks }) => {
      const title = document.title;
      const url = window.location.href;
      const textRaw = document.body ? document.body.innerText : '';
      const text = textRaw.replace(/\s+/g, ' ').trim();
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, maxLinks || 50).map((link) => ({
        text: (link.innerText || link.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        href: link.href
      }));
      return {
        title,
        url,
        text: maxChars ? text.slice(0, maxChars) : text,
        links
      };
    }, { maxChars: maxChars || 8000, maxLinks: maxLinks || 50 });

    return respond(snapshot);
  }
);

server.registerTool(
  'browser.list',
  {
    description: 'List visible interactive elements (links, buttons, inputs).',
    inputSchema: {
      limit: z.number().optional()
    }
  },
  async ({ limit }) => {
    const page = ensurePage();
    clearElementCache();

    const elements = await page.$$('a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]');
    const items = [];
    let id = 1;

    for (const handle of elements) {
      const info = await handle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        const text = (node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('value') || '').replace(/\s+/g, ' ').trim();
        return {
          visible,
          tag: node.tagName.toLowerCase(),
          text,
          href: node.getAttribute('href') || ''
        };
      });

      if (!info.visible) continue;
      state.elements.set(id, handle);
      items.push({ id, ...info });
      id += 1;

      if (limit && items.length >= limit) break;
    }

    return respond({ count: items.length, items });
  }
);

server.registerTool(
  'browser.click',
  {
    description: 'Click an element by elementId, selector, or text.',
    inputSchema: {
      elementId: z.number().optional(),
      selector: z.string().optional(),
      text: z.string().optional()
    }
  },
  async ({ elementId, selector, text }) => {
    const page = ensurePage();

    if (elementId) {
      const handle = state.elements.get(elementId);
      if (!handle) throw new Error(`No cached element for id ${elementId}. Run browser.list again.`);
      await handle.click();
    } else if (selector) {
      await page.click(selector);
    } else if (text) {
      const locator = page.getByText(text, { exact: false });
      await locator.first().click();
    } else {
      throw new Error('Provide elementId, selector, or text to click.');
    }

    clearElementCache();
    return respond({ status: 'clicked' });
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
      clear: z.boolean().optional()
    }
  },
  async ({ text, selector, elementId, clear }) => {
    const page = ensurePage();

    if (elementId) {
      const handle = state.elements.get(elementId);
      if (!handle) throw new Error(`No cached element for id ${elementId}. Run browser.list again.`);
      if (clear) await handle.fill('');
      await handle.type(text);
    } else if (selector) {
      if (clear) await page.fill(selector, '');
      await page.type(selector, text);
    } else {
      throw new Error('Provide selector or elementId.');
    }

    return respond({ status: 'typed', textLength: text.length });
  }
);

server.registerTool(
  'browser.press',
  {
    description: 'Press a key, optionally focusing selector or elementId.',
    inputSchema: {
      key: z.string(),
      selector: z.string().optional(),
      elementId: z.number().optional()
    }
  },
  async ({ key, selector, elementId }) => {
    const page = ensurePage();

    if (elementId) {
      const handle = state.elements.get(elementId);
      if (!handle) throw new Error(`No cached element for id ${elementId}. Run browser.list again.`);
      await handle.focus();
    } else if (selector) {
      await page.focus(selector);
    }

    await page.keyboard.press(key);
    return respond({ status: 'pressed', key });
  }
);

server.registerTool(
  'browser.extract_text',
  {
    description: 'Extract text from a selector. Use all=true to get all matches.',
    inputSchema: {
      selector: z.string(),
      all: z.boolean().optional()
    }
  },
  async ({ selector, all }) => {
    const page = ensurePage();
    if (all) {
      const texts = await page.$$eval(selector, (nodes) => nodes.map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
      return respond({ selector, count: texts.length, texts });
    }

    const text = await page.$eval(selector, (node) => (node.textContent || '').replace(/\s+/g, ' ').trim());
    return respond({ selector, text });
  }
);

server.registerTool(
  'browser.extract_html',
  {
    description: 'Extract outerHTML from a selector.',
    inputSchema: {
      selector: z.string()
    }
  },
  async ({ selector }) => {
    const page = ensurePage();
    const html = await page.$eval(selector, (node) => node.outerHTML || '');
    return respond({ selector, html });
  }
);

server.registerTool(
  'browser.screenshot',
  {
    description: 'Save a screenshot to a path.',
    inputSchema: {
      path: z.string(),
      fullPage: z.boolean().optional()
    }
  },
  async ({ path: targetPath, fullPage }) => {
    const page = ensurePage();
    await ensureDir(targetPath);
    await page.screenshot({ path: targetPath, fullPage: fullPage ?? true });
    return respond({ status: 'saved', path: path.resolve(targetPath) });
  }
);

server.registerTool(
  'browser.visual_snapshot',
  {
    description: 'Take a screenshot and return an element map with bounding boxes for visual navigation.',
    inputSchema: {
      path: z.string(),
      fullPage: z.boolean().optional(),
      limit: z.number().optional(),
      interactiveOnly: z.boolean().optional(),
      saveMapPath: z.string().optional()
    }
  },
  async ({ path: targetPath, fullPage, limit, interactiveOnly, saveMapPath }) => {
    const page = ensurePage();
    await ensureDir(targetPath);
    await page.screenshot({ path: targetPath, fullPage: fullPage ?? true });

    clearElementCache();
    const selector = interactiveOnly === false
      ? '*'
      : 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]';

    const handles = await page.$$(selector);
    const items = [];
    let id = 1;

    for (const handle of handles) {
      const box = await handle.boundingBox();
      if (!box || box.width < 1 || box.height < 1) continue;

      const info = await handle.evaluate((node) => {
        const text = (node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('value') || '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          tag: node.tagName.toLowerCase(),
          text,
          href: node.getAttribute('href') || '',
          ariaLabel: node.getAttribute('aria-label') || ''
        };
      });

      state.elements.set(id, handle);
      items.push({
        id,
        ...info,
        bbox: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height)
        }
      });
      id += 1;

      if (limit && items.length >= limit) break;
    }

    const payload = {
      screenshotPath: path.resolve(targetPath),
      count: items.length,
      items,
      viewport: page.viewportSize()
    };

    if (saveMapPath) {
      await ensureDir(saveMapPath);
      await fs.writeFile(saveMapPath, JSON.stringify(payload, null, 2), 'utf8');
      payload.mapSavedTo = path.resolve(saveMapPath);
    }

    return respond(payload);
  }
);

server.registerTool(
  'browser.click_at',
  {
    description: 'Click at specific page coordinates (x, y). Useful for visual workflows.',
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
  'files.write_text',
  {
    description: 'Write arbitrary text to a file path.',
    inputSchema: {
      path: z.string(),
      text: z.string()
    }
  },
  async ({ path: targetPath, text }) => {
    await ensureDir(targetPath);
    await fs.writeFile(targetPath, text, 'utf8');
    return respond({ status: 'written', path: path.resolve(targetPath), length: text.length });
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
      const saved = await saveJobsToTxt(jobs, saveDir);
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
      const saved = await saveSearchResultsToTxt(results, saveDir);
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
      const saved = await saveSearchResultsToTxt(results, saveDir);
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
