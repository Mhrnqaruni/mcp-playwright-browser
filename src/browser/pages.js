// Page manager for multi-tab workflows.
// Keeps stable numeric pageIds and tracks the active page.

export function createPageManager() {
  const pages = new Map(); // pageId -> { page, closed, createdAt }
  let pageIds = new WeakMap(); // Playwright Page -> pageId
  let nextPageId = 1;
  let activePageId = null;
  let context = null;
  let contextListenerAttached = false;
  let contextPageListener = null;

  const getPageUrl = (page) => {
    try {
      return String(page?.url?.() || '');
    } catch {
      return '';
    }
  };

  const isLikelyBlankPage = (page) => {
    const url = getPageUrl(page).toLowerCase();
    if (!url) return true;
    if (url === 'about:blank') return true;
    if (url === 'about:newtab') return true;
    if (url.startsWith('chrome://newtab')) return true;
    if (url.startsWith('chrome://new-tab-page')) return true;
    if (url.startsWith('chrome-search://local-ntp')) return true;
    if (url.startsWith('edge://newtab')) return true;
    if (url.startsWith('edge://new-tab-page')) return true;
    return false;
  };

  const findBestOpenPageId = () => {
    let bestId = null;
    let bestScore = -Infinity;
    for (const [id, entry] of pages) {
      if (entry.closed || entry.page.isClosed()) continue;
      let score = 0;
      if (!isLikelyBlankPage(entry.page)) score += 1000;
      score += entry.createdAt || 0;
      if (id === activePageId) score += 1;
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }
    return bestId;
  };

  const clearPagesState = () => {
    pages.clear();
    pageIds = new WeakMap();
    nextPageId = 1;
    activePageId = null;
  };

  const detachContextListener = () => {
    if (context && contextListenerAttached && contextPageListener && typeof context.off === 'function') {
      try {
        context.off('page', contextPageListener);
      } catch {
        // best effort
      }
    }
    contextPageListener = null;
    contextListenerAttached = false;
  };

  const attachPage = (page) => {
    if (!page) return null;
    const existingId = pageIds.get(page);
    if (existingId) return existingId;

    const pageId = nextPageId++;
    pageIds.set(page, pageId);
    pages.set(pageId, { page, closed: false, createdAt: Date.now() });

    page.once('close', () => {
      const entry = pages.get(pageId);
      // Ignore stale callbacks from previously attached contexts/pages.
      if (!entry || entry.page !== page) return;
      if (entry) entry.closed = true;
      if (activePageId === pageId) {
        activePageId = findBestOpenPageId();
      }
    });

    if (activePageId === null) {
      activePageId = pageId;
    }
    return pageId;
  };

  const attachContext = async (newContext) => {
    if (context && context !== newContext) {
      detachContextListener();
      clearPagesState();
    }

    context = newContext || null;

    if (!context) return;

    for (const page of context.pages()) {
      attachPage(page);
    }

    if (findBestOpenPageId() === null) {
      const page = await context.newPage();
      attachPage(page);
    }

    activePageId = findBestOpenPageId();

    if (!contextListenerAttached) {
      contextPageListener = (page) => {
        attachPage(page);
      };
      context.on('page', contextPageListener);
      contextListenerAttached = true;
    }
  };

  const reset = () => {
    detachContextListener();
    clearPagesState();
    context = null;
  };

  const listPages = async () => {
    const result = [];
    for (const [pageId, entry] of pages) {
      const page = entry.page;
      const closed = entry.closed || page.isClosed();
      if (closed && !entry.closed) entry.closed = true;

      let url = '';
      let title = '';
      try {
        url = page.url();
      } catch {
        url = '';
      }
      try {
        title = closed ? '' : await page.title();
      } catch {
        title = '';
      }

      result.push({
        pageId,
        active: pageId === activePageId,
        closed,
        url,
        title
      });
    }
    return result;
  };

  const getPage = (pageId) => {
    const entry = pages.get(pageId);
    if (!entry) return null;
    if (entry.closed || entry.page.isClosed()) return null;
    return entry.page;
  };

  const getPageId = (page) => {
    if (!page) return null;
    const pageId = pageIds.get(page);
    if (!pageId) return null;
    const entry = pages.get(pageId);
    if (!entry || entry.closed || entry.page.isClosed()) return null;
    return pageId;
  };

  const getActivePageId = () => activePageId;

  const getActivePage = () => {
    if (activePageId === null) return null;
    return getPage(activePageId);
  };

  const selectPage = (pageId) => {
    const page = getPage(pageId);
    if (!page) throw new Error(`No open page for pageId ${pageId}. Run browser.list_pages.`);
    activePageId = pageId;
    return page;
  };

  const closePage = async (pageId) => {
    const id = pageId ?? activePageId;
    if (id === null || id === undefined) throw new Error('No active page to close.');
    const entry = pages.get(id);
    if (!entry || entry.closed || entry.page.isClosed()) {
      throw new Error(`No open page for pageId ${id}.`);
    }
    await entry.page.close();
    entry.closed = true;
    if (activePageId === id) {
      activePageId = findBestOpenPageId();
    }
    return { closedPageId: id, activePageId };
  };

  return {
    reset,
    attachContext,
    attachPage,
    listPages,
    getPageId,
    getPage,
    getActivePage,
    getActivePageId,
    selectPage,
    closePage
  };
}
