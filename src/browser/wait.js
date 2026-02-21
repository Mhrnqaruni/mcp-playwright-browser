import { ensureCdpDomains } from './cdp.js';

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export async function waitForSelector(page, selector, opts = {}) {
  const timeoutMs = clampNumber(opts.timeoutMs, 1000, 300000, 15000);
  const state = opts.state || 'visible';

  if (state === 'enabled') {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await locator.isEnabled()) return { status: 'ready', kind: 'selector', selector, state: 'enabled' };
      } catch {
        // ignore and retry
      }
      await delay(100);
    }
    throw new Error(`Timeout waiting for selector "${selector}" to become enabled (${timeoutMs}ms).`);
  }

  await page.waitForSelector(selector, { timeout: timeoutMs, state });
  return { status: 'ready', kind: 'selector', selector, state };
}

export async function waitForText(page, text, opts = {}) {
  const timeoutMs = clampNumber(opts.timeoutMs, 1000, 300000, 15000);
  const state = opts.state || 'visible';
  const exact = opts.exact ?? false;

  const locator = page.getByText(text, { exact }).first();

  if (state === 'enabled') {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await locator.isEnabled()) return { status: 'ready', kind: 'text', text, exact, state: 'enabled' };
      } catch {
        // ignore and retry
      }
      await delay(100);
    }
    throw new Error(`Timeout waiting for text "${text}" to become enabled (${timeoutMs}ms).`);
  }

  await locator.waitFor({ state, timeout: timeoutMs });
  return { status: 'ready', kind: 'text', text, exact, state };
}

export async function waitForBackendNode(page, backendNodeId, opts = {}) {
  const timeoutMs = clampNumber(opts.timeoutMs, 1000, 300000, 15000);
  const pollMs = clampNumber(opts.pollMs, 50, 2000, 200);

  const session = await ensureCdpDomains(page, ['DOM']);
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await session.send('DOM.resolveNode', { backendNodeId });
      return { status: 'ready', kind: 'uid', backendNodeId };
    } catch (err) {
      lastError = err;
    }
    await delay(pollMs);
  }

  const msg = lastError && typeof lastError === 'object' && 'message' in lastError ? String(lastError.message) : String(lastError || '');
  throw new Error(`Timeout waiting for backendNodeId ${backendNodeId} (${timeoutMs}ms). ${msg}`.trim());
}

