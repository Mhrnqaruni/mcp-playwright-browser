import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { takeA11ySnapshot } from '../browser/snapshot.js';
import { clickByBackendNodeId, setValueByBackendNodeId } from '../browser/cdp.js';

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.setContent(`
    <html>
      <head><title>UID</title></head>
      <body>
        <label for="name">Full Name</label>
        <input id="name" aria-label="Full Name" />
        <input id="cb1" type="checkbox" />
        <label for="cb1">I confirm</label>
      </body>
    </html>
  `);

  const { nodes, uidToBackend } = await takeA11ySnapshot(page, { interestingOnly: true, maxNodes: 200 });
  assert.ok(nodes.length > 0);
  assert.ok(uidToBackend.size > 0);

  const nameNode = nodes.find((n) => (n.role === 'textbox' || n.role === 'searchbox') && /full name/i.test(n.name));
  assert.ok(nameNode);
  const nameBackend = uidToBackend.get(nameNode.uid);
  assert.ok(typeof nameBackend === 'number');

  const setRes = await setValueByBackendNodeId(page, nameBackend, 'Test User');
  assert.equal(setRes.ok, true);
  const actual = await page.locator('#name').inputValue();
  assert.equal(actual, 'Test User');

  const cbNode = nodes.find((n) => n.role === 'checkbox' && /confirm/i.test(n.name));
  assert.ok(cbNode);
  const cbBackend = uidToBackend.get(cbNode.uid);
  assert.ok(typeof cbBackend === 'number');

  await clickByBackendNodeId(page, cbBackend);
  const checked = await page.locator('#cb1').isChecked();
  assert.equal(checked, true);

  await browser.close();
  console.log('PASS uid-click-fill-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

