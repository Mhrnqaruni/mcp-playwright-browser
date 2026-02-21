// Tracks page/frame DOM versions for stale-cache protection and stable envelopes.
// The tracker is intentionally lightweight and event-driven.

const trackerByPage = new WeakMap(); // Page -> tracker

function cleanText(value) {
  return String(value || '').trim();
}

function createTracker(page) {
  const frameToId = new WeakMap(); // Frame -> frameId
  const idToFrame = new Map(); // frameId -> Frame
  const frameVersions = new Map(); // frameId -> version
  let nextFrameSeq = 1;
  let pageDomVersion = 1;
  let attached = false;

  const ensureFrameId = (frame) => {
    if (!frame) return null;
    const existing = frameToId.get(frame);
    if (existing) return existing;

    const frameId = frame === page.mainFrame() ? 'main' : `f${nextFrameSeq++}`;
    frameToId.set(frame, frameId);
    idToFrame.set(frameId, frame);
    if (!frameVersions.has(frameId)) frameVersions.set(frameId, 1);
    return frameId;
  };

  const bumpFrame = (frame) => {
    const frameId = ensureFrameId(frame);
    if (!frameId) return null;
    const prev = frameVersions.get(frameId) || 0;
    frameVersions.set(frameId, prev + 1);
    pageDomVersion += 1;
    return frameId;
  };

  const onFrameAttached = (frame) => {
    // New frame -> new id + bump once to invalidate frame-specific caches.
    ensureFrameId(frame);
    bumpFrame(frame);
  };

  const onFrameNavigated = (frame) => {
    // Frame navigation is the most important stale-reference boundary.
    bumpFrame(frame);
  };

  const onFrameDetached = (frame) => {
    const frameId = frameToId.get(frame);
    if (frameId) {
      idToFrame.delete(frameId);
      frameVersions.delete(frameId);
    }
    pageDomVersion += 1;
  };

  const attach = () => {
    if (attached) return;
    attached = true;

    // Seed known frames at attach time.
    for (const frame of page.frames()) ensureFrameId(frame);
    // Ensure main frame always exists.
    ensureFrameId(page.mainFrame());

    page.on('frameattached', onFrameAttached);
    page.on('framenavigated', onFrameNavigated);
    page.on('framedetached', onFrameDetached);

    page.once('close', () => {
      try {
        page.off('frameattached', onFrameAttached);
        page.off('framenavigated', onFrameNavigated);
        page.off('framedetached', onFrameDetached);
      } catch {
        // ignore best-effort cleanup
      }
      trackerByPage.delete(page);
    });
  };

  const listFrames = () => {
    const out = [];
    for (const frame of page.frames()) {
      const frameId = ensureFrameId(frame);
      const parent = frame.parentFrame();
      const parentFrameId = parent ? ensureFrameId(parent) : null;
      out.push({
        frameId,
        parentFrameId,
        name: cleanText(frame.name()),
        url: cleanText(frame.url()),
        isMainFrame: frame === page.mainFrame(),
        frameDomVersion: frameVersions.get(frameId) || 1
      });
    }
    return out;
  };

  const getDomContext = (frame = null) => {
    const targetFrame = frame || page.mainFrame();
    const frameId = ensureFrameId(targetFrame) || 'main';
    const frameDomVersion = frameVersions.get(frameId) || 1;
    return {
      pageDomVersion,
      frameId,
      frameDomVersion,
      domVersion: `p${pageDomVersion}:${frameId}@${frameDomVersion}`
    };
  };

  const getFrameById = (frameId) => {
    if (!frameId) return null;
    return idToFrame.get(frameId) || null;
  };

  return {
    attach,
    listFrames,
    getFrameById,
    getDomContext,
    ensureFrameId,
    bumpFrame,
    bumpPage: () => {
      pageDomVersion += 1;
      const mainId = ensureFrameId(page.mainFrame()) || 'main';
      const prev = frameVersions.get(mainId) || 0;
      frameVersions.set(mainId, prev + 1);
      return getDomContext(page.mainFrame());
    }
  };
}

export function ensureDomTracker(page) {
  if (!page) throw new Error('ensureDomTracker requires a page.');
  let tracker = trackerByPage.get(page);
  if (!tracker) {
    tracker = createTracker(page);
    trackerByPage.set(page, tracker);
  }
  tracker.attach();
  return tracker;
}

export function getDomContext(page, frame = null) {
  const tracker = ensureDomTracker(page);
  return tracker.getDomContext(frame);
}

export function listFrames(page) {
  const tracker = ensureDomTracker(page);
  const frames = tracker.listFrames();
  const ctx = tracker.getDomContext(page.mainFrame());
  return {
    pageDomVersion: ctx.pageDomVersion,
    domVersion: ctx.domVersion,
    frames
  };
}

export function getFrameById(page, frameId) {
  const tracker = ensureDomTracker(page);
  return tracker.getFrameById(frameId);
}

