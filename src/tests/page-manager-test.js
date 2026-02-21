import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createPageManager } from '../browser/pages.js';

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Create the first page before attaching the manager, mirroring typical usage.
  const page1 = await context.newPage();
  await page1.setContent('<html><head><title>One</title></head><body>one</body></html>');

  const manager = createPageManager();
  await manager.attachContext(context);

  const pages1 = await manager.listPages();
  assert.ok(pages1.length >= 1);
  assert.equal(manager.getActivePageId() !== null, true);

  const page2 = await context.newPage();
  await page2.setContent('<html><head><title>Two</title></head><body>two</body></html>');
  await delay(50); // allow context "page" event to be observed

  const pages2 = await manager.listPages();
  assert.equal(pages2.filter((p) => !p.closed).length, 2);

  const secondId = pages2.find((p) => p.title === 'Two')?.pageId;
  assert.ok(secondId);
  manager.selectPage(secondId);
  assert.equal(manager.getActivePageId(), secondId);

  await manager.closePage(secondId);
  assert.notEqual(manager.getActivePageId(), secondId);

  // Close remaining open page(s).
  const pages3 = await manager.listPages();
  for (const p of pages3) {
    if (!p.closed) {
      await manager.closePage(p.pageId);
    }
  }

  assert.equal(manager.getActivePageId(), null);

  // Context switch regression: attaching a new context must not keep stale pages
  // from the previous context, and active page selection should prefer a real tab.
  const context2 = await browser.newContext();
  await context2.newPage(); // keep one blank tab
  const fresh = await context2.newPage();
  await fresh.goto('data:text/html,<html><head><title>Fresh</title></head><body>fresh</body></html>');

  await manager.attachContext(context2);
  const pagesAfterSwitch = await manager.listPages();
  assert.equal(pagesAfterSwitch.some((p) => p.title === 'One'), false);
  assert.equal(pagesAfterSwitch.some((p) => p.title === 'Two'), false);

  const freshEntry = pagesAfterSwitch.find((p) => p.title === 'Fresh');
  assert.ok(freshEntry);
  assert.equal(manager.getActivePageId(), freshEntry.pageId);
  manager.selectPage(freshEntry.pageId);

  // Regression: closing an old-context page after switching contexts must not
  // alter activePageId in the new context (pageId values can be reused).
  await page1.close();
  await delay(50);
  assert.equal(manager.getActivePageId(), freshEntry.pageId);

  await context.close();
  await context2.close();
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
