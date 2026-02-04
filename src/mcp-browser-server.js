import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  persistent: false
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
    throw new Error('Browser is not launched. Run browser.launch first.');
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
  async ({ headless, slowMoMs, viewport, userAgent, userDataDir, args, stealth }) => {
    if (state.context) {
      await state.context.close();
    } else if (state.browser) {
      await state.browser.close();
    }
    state.browser = null;
    state.context = null;
    state.page = null;
    state.persistent = false;

    if (userDataDir) {
      state.context = await chromium.launchPersistentContext(userDataDir, {
        headless: headless ?? false,
        slowMo: slowMoMs ?? 0,
        viewport: viewport ?? DEFAULT_VIEWPORT,
        userAgent: userAgent || undefined,
        args: args || []
      });
      state.browser = state.context.browser();
      state.persistent = true;
    } else {
      state.browser = await chromium.launch({
        headless: headless ?? false,
        slowMo: slowMoMs ?? 0,
        args: args || []
      });

      state.context = await state.browser.newContext({
        viewport: viewport ?? DEFAULT_VIEWPORT,
        userAgent: userAgent || undefined
      });
    }

    if (stealth) {
      await state.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      });
    }

    const pages = state.context.pages();
    state.page = pages.length ? pages[0] : await state.context.newPage();
    if (stealth && pages.length) {
      await state.page.reload({ waitUntil: 'domcontentloaded' });
    }

    clearElementCache();

    return respond({
      status: 'launched',
      headless: headless ?? false,
      viewport: viewport ?? DEFAULT_VIEWPORT,
      persistent: state.persistent
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
    const url = endpoint || 'http://127.0.0.1:9222';
    if (state.context) {
      await state.context.close();
    } else if (state.browser) {
      await state.browser.close();
    }

    state.browser = await chromium.connectOverCDP(url, { slowMo: slowMoMs ?? 0 });
    const contexts = state.browser.contexts();
    state.context = contexts.length ? contexts[0] : await state.browser.newContext();
    const pages = state.context.pages();
    state.page = pages.length ? pages[0] : await state.context.newPage();
    state.persistent = true;
    clearElementCache();

    return respond({
      status: 'connected',
      endpoint: url,
      pages: pages.length
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
    inputSchema: {}
  },
  async () => {
    if (state.context) {
      await state.context.close();
    }
    state.browser = null;
    state.context = null;
    state.page = null;
    state.persistent = false;
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
