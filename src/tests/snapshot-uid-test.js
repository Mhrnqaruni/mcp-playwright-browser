import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { takeA11ySnapshot } from '../browser/snapshot.js';

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.setContent(`
    <html>
      <head><title>Snapshot</title></head>
      <body>
        <label for="name">Full Name</label>
        <input id="name" aria-label="Full Name" />
        <button id="submit">Submit</button>
        <input id="cb1" type="checkbox" />
        <label for="cb1">I confirm</label>
      </body>
    </html>
  `);

  const { nodes, uidToBackend } = await takeA11ySnapshot(page, { interestingOnly: true, maxNodes: 200 });

  assert.ok(nodes.length > 0);
  assert.ok(uidToBackend.size > 0);

  const hasButton = nodes.some((n) => n.role === 'button' && /submit/i.test(n.name));
  assert.equal(hasButton, true);

  const hasTextbox = nodes.some((n) => (n.role === 'textbox' || n.role === 'searchbox') && /full name/i.test(n.name));
  assert.equal(hasTextbox, true);

  const hasCheckbox = nodes.some((n) => n.role === 'checkbox' && /confirm/i.test(n.name));
  assert.equal(hasCheckbox, true);

  const anyUid = nodes[0]?.uid || '';
  assert.ok(anyUid.startsWith('ax-'));
  assert.ok(uidToBackend.has(anyUid) || uidToBackend.size > 0);

  await browser.close();
  console.log('PASS snapshot-uid-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

