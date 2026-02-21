import { ensureCdpDomains, getOrCreateCdpSession } from './cdp.js';

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, maxChars) {
  const text = cleanText(value);
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return text.slice(0, maxChars - 3) + '...';
}

function pushRing(arr, item, maxItems) {
  arr.push(item);
  if (arr.length > maxItems) arr.splice(0, arr.length - maxItems);
}

const observerByPage = new WeakMap(); // Page -> observer

async function getOrCreateObserver(page, opts = {}) {
  const existing = observerByPage.get(page);
  if (existing) return existing;

  const consoleLimit = clampNumber(opts.consoleLimit, 10, 2000, 200);
  const networkLimit = clampNumber(opts.networkLimit, 10, 5000, 300);

  const session = await getOrCreateCdpSession(page);
  await ensureCdpDomains(page, ['Runtime', 'Network']);

  const observer = {
    consoleLimit,
    networkLimit,
    console: [], // { ts, type, level, text }
    exceptions: [], // { ts, text, url, line, column }
    networkOrder: [], // requestId in order
    network: new Map() // requestId -> details
  };

  const addRequestId = (requestId) => {
    observer.networkOrder.push(requestId);
    if (observer.networkOrder.length > observer.networkLimit) {
      const dropCount = observer.networkOrder.length - observer.networkLimit;
      const dropped = observer.networkOrder.splice(0, dropCount);
      for (const id of dropped) observer.network.delete(id);
    }
  };

  session.on('Runtime.consoleAPICalled', (evt) => {
    const type = cleanText(evt?.type || 'log');
    const args = Array.isArray(evt?.args) ? evt.args : [];
    const texts = args
      .map((a) => {
        if (!a) return '';
        if (a.type === 'string') return String(a.value ?? '');
        if ('value' in a) return String(a.value ?? '');
        if (a.description) return String(a.description);
        return '';
      })
      .filter(Boolean);
    const text = texts.length ? texts.join(' ') : '';
    pushRing(observer.console, {
      ts: Date.now(),
      type,
      level: type,
      text: truncateText(text, 2000)
    }, observer.consoleLimit);
  });

  session.on('Runtime.exceptionThrown', (evt) => {
    const details = evt?.exceptionDetails || {};
    const text = cleanText(details?.text || details?.exception?.description || 'Exception');
    pushRing(observer.exceptions, {
      ts: Date.now(),
      text: truncateText(text, 4000),
      url: cleanText(details?.url || ''),
      line: typeof details?.lineNumber === 'number' ? details.lineNumber : null,
      column: typeof details?.columnNumber === 'number' ? details.columnNumber : null
    }, observer.consoleLimit);
  });

  session.on('Network.requestWillBeSent', (evt) => {
    const requestId = evt?.requestId;
    if (!requestId) return;
    if (!observer.network.has(requestId)) addRequestId(requestId);
    const req = evt?.request || {};
    observer.network.set(requestId, {
      requestId,
      url: cleanText(req.url || ''),
      method: cleanText(req.method || ''),
      requestHeaders: req.headers || null,
      postData: typeof req.postData === 'string' ? req.postData : null,
      ts: Date.now(),
      type: cleanText(evt?.type || ''),
      response: null,
      finished: false,
      failed: false,
      errorText: null,
      encodedDataLength: null
    });
  });

  session.on('Network.responseReceived', (evt) => {
    const requestId = evt?.requestId;
    if (!requestId) return;
    const entry = observer.network.get(requestId);
    if (!entry) return;
    const res = evt?.response || {};
    entry.response = {
      status: typeof res.status === 'number' ? res.status : null,
      statusText: cleanText(res.statusText || ''),
      mimeType: cleanText(res.mimeType || ''),
      responseHeaders: res.headers || null,
      fromDiskCache: Boolean(res.fromDiskCache),
      fromServiceWorker: Boolean(res.fromServiceWorker)
    };
  });

  session.on('Network.loadingFinished', (evt) => {
    const requestId = evt?.requestId;
    if (!requestId) return;
    const entry = observer.network.get(requestId);
    if (!entry) return;
    entry.finished = true;
    entry.encodedDataLength = typeof evt.encodedDataLength === 'number' ? evt.encodedDataLength : null;
  });

  session.on('Network.loadingFailed', (evt) => {
    const requestId = evt?.requestId;
    if (!requestId) return;
    const entry = observer.network.get(requestId);
    if (!entry) return;
    entry.failed = true;
    entry.errorText = cleanText(evt?.errorText || '');
  });

  observerByPage.set(page, observer);
  return observer;
}

export async function listConsoleMessages(page, opts = {}) {
  const observer = await getOrCreateObserver(page, opts);
  const limit = clampNumber(opts.limit, 1, observer.consoleLimit, 50);
  const merged = [...observer.console, ...observer.exceptions.map((e) => ({ ...e, level: 'exception', type: 'exception' }))];
  merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return merged.slice(-limit);
}

export async function ensureObservability(page, opts = {}) {
  await getOrCreateObserver(page, opts);
  return { status: 'enabled' };
}

export async function listNetworkRequests(page, opts = {}) {
  const observer = await getOrCreateObserver(page, opts);
  const limit = clampNumber(opts.limit, 1, observer.networkLimit, 50);
  const contains = cleanText(opts.urlContains || '').toLowerCase();

  const out = [];
  for (const requestId of observer.networkOrder) {
    const entry = observer.network.get(requestId);
    if (!entry) continue;
    if (contains && !entry.url.toLowerCase().includes(contains)) continue;
    out.push({
      requestId,
      method: entry.method,
      url: truncateText(entry.url, 300),
      status: entry.response?.status ?? null,
      failed: entry.failed,
      finished: entry.finished
    });
  }

  return out.slice(-limit);
}

export async function getNetworkRequest(page, requestId, opts = {}) {
  const observer = await getOrCreateObserver(page, opts);
  const entry = observer.network.get(requestId);
  if (!entry) throw new Error(`Unknown requestId "${requestId}".`);

  const includeBody = opts.includeBody ?? false;
  const maxBodyChars = clampNumber(opts.maxBodyChars, 0, 200000, 5000);
  let body = null;
  let bodyTruncated = false;
  let bodyBase64 = false;

  if (includeBody) {
    const session = await getOrCreateCdpSession(page);
    try {
      const res = await session.send('Network.getResponseBody', { requestId });
      bodyBase64 = Boolean(res?.base64Encoded);
      const raw = typeof res?.body === 'string' ? res.body : '';
      if (maxBodyChars > 0 && raw.length > maxBodyChars) {
        body = raw.slice(0, maxBodyChars);
        bodyTruncated = true;
      } else {
        body = raw;
      }
    } catch (err) {
      const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
      body = null;
      bodyTruncated = false;
      bodyBase64 = false;
      return {
        ...entry,
        body: null,
        bodyError: msg
      };
    }
  }

  return {
    ...entry,
    body,
    bodyTruncated,
    bodyBase64
  };
}
