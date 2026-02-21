// Lightweight CDP helpers (DevTools-style) built on Playwright's CDPSession.
// This keeps our MCP as a single server while enabling uid-based DOM interactions.

const sessionByPage = new WeakMap(); // Page -> CDPSession
const enabledDomainsBySession = new WeakMap(); // CDPSession -> Set(domainName)

export async function getOrCreateCdpSession(page) {
  if (!page) throw new Error('CDP requires a Playwright page.');
  const existing = sessionByPage.get(page);
  if (existing) return existing;

  const context = page.context();
  const session = await context.newCDPSession(page);
  sessionByPage.set(page, session);
  enabledDomainsBySession.set(session, new Set());

  page.once('close', async () => {
    try {
      await session.detach();
    } catch {
      // ignore
    }
    sessionByPage.delete(page);
    enabledDomainsBySession.delete(session);
  });

  return session;
}

export async function ensureCdpDomains(page, domains) {
  const session = await getOrCreateCdpSession(page);
  const enabled = enabledDomainsBySession.get(session) || new Set();

  const want = Array.isArray(domains) ? domains : [];
  for (const domain of want) {
    if (!domain) continue;
    if (enabled.has(domain)) continue;
    const method = `${domain}.enable`;
    try {
      await session.send(method);
    } catch (err) {
      const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
      throw new Error(`Failed to enable CDP domain ${domain} via ${method}: ${msg}`);
    }
    enabled.add(domain);
  }

  enabledDomainsBySession.set(session, enabled);
  return session;
}

export async function scrollIntoViewIfNeeded(page, backendNodeId) {
  if (!backendNodeId || typeof backendNodeId !== 'number') {
    throw new Error('scrollIntoViewIfNeeded requires a numeric backendNodeId.');
  }
  const session = await ensureCdpDomains(page, ['DOM']);
  try {
    await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  } catch {
    // Best-effort: some nodes can't be scrolled (detached, etc.).
  }
}

export async function resolveObjectId(page, backendNodeId) {
  if (!backendNodeId || typeof backendNodeId !== 'number') {
    throw new Error('resolveObjectId requires a numeric backendNodeId.');
  }
  const session = await ensureCdpDomains(page, ['DOM']);
  const result = await session.send('DOM.resolveNode', { backendNodeId });
  const objectId = result?.object?.objectId || null;
  if (!objectId) {
    throw new Error(`Failed to resolve backendNodeId ${backendNodeId} to a Runtime objectId.`);
  }
  return objectId;
}

export async function clickByBackendNodeId(page, backendNodeId) {
  await scrollIntoViewIfNeeded(page, backendNodeId);
  const session = await ensureCdpDomains(page, ['DOM', 'Runtime']);
  const objectId = await resolveObjectId(page, backendNodeId);

  const fn = `
    function() {
      try {
        if (this && this.scrollIntoView) this.scrollIntoView({block: 'center', inline: 'center'});
      } catch (e) {}
      try {
        if (this && typeof this.click === 'function') { this.click(); return { ok: true, via: 'click' }; }
      } catch (e) {}
      try {
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        if (this && this.dispatchEvent) { this.dispatchEvent(ev); return { ok: true, via: 'dispatchEvent' }; }
      } catch (e) {}
      return { ok: false };
    }
  `;

  const result = await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    returnByValue: true,
    awaitPromise: true
  });

  const value = result?.result?.value || null;
  if (!value || value.ok !== true) {
    throw new Error(`CDP click failed for backendNodeId ${backendNodeId}.`);
  }
  return value;
}

export async function hoverByBackendNodeId(page, backendNodeId) {
  await scrollIntoViewIfNeeded(page, backendNodeId);
  const session = await ensureCdpDomains(page, ['DOM', 'Runtime']);

  try {
    const box = await session.send('DOM.getBoxModel', { backendNodeId });
    const quad = Array.isArray(box?.model?.content) ? box.model.content : null;
    if (quad && quad.length >= 8) {
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const x = xs.reduce((a, b) => a + b, 0) / xs.length;
      const y = ys.reduce((a, b) => a + b, 0) / ys.length;
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        buttons: 0
      });
      return { ok: true, via: 'cdp-mouse', x, y };
    }
  } catch {
    // Fallback to synthetic dispatch if box model/pointer move is unavailable.
  }

  const objectId = await resolveObjectId(page, backendNodeId);

  const fn = `
    function() {
      const el = this;
      try {
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
      } catch (e) {}
      try {
        const events = ['mouseover', 'mouseenter', 'mousemove'];
        for (const type of events) {
          const ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
          if (el && typeof el.dispatchEvent === 'function') el.dispatchEvent(ev);
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }
  `;

  const result = await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    returnByValue: true,
    awaitPromise: true
  });

  const value = result?.result?.value || null;
  if (!value || value.ok !== true) {
    throw new Error(`CDP hover failed for backendNodeId ${backendNodeId}.`);
  }
  return value;
}

export async function setValueByBackendNodeId(page, backendNodeId, value) {
  await scrollIntoViewIfNeeded(page, backendNodeId);
  const session = await ensureCdpDomains(page, ['DOM', 'Runtime']);
  const objectId = await resolveObjectId(page, backendNodeId);

  const fn = `
    function(v) {
      const el = this;
      try { if (el && el.focus) el.focus(); } catch (e) {}

      const isInput = (typeof HTMLInputElement !== 'undefined') && (el instanceof HTMLInputElement);
      const isTextarea = (typeof HTMLTextAreaElement !== 'undefined') && (el instanceof HTMLTextAreaElement);
      const isSelect = (typeof HTMLSelectElement !== 'undefined') && (el instanceof HTMLSelectElement);

      if (isInput || isTextarea || isSelect) {
        try { el.value = String(v ?? ''); } catch (e) {}
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        try { return { ok: true, value: String(el.value ?? '') }; } catch (e) { return { ok: true, value: '' }; }
      }

      if (el && el.isContentEditable) {
        try { el.textContent = String(v ?? ''); } catch (e) {}
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        return { ok: true, value: String(el.textContent ?? '') };
      }

      return { ok: false, value: null };
    }
  `;

  const result = await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    arguments: [{ value: String(value ?? '') }],
    returnByValue: true,
    awaitPromise: true
  });

  const payload = result?.result?.value || null;
  if (!payload || payload.ok !== true) {
    throw new Error(`CDP set value failed for backendNodeId ${backendNodeId}.`);
  }
  return payload;
}
