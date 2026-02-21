import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { waitForSelector, waitForText } from '../browser/wait.js';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <head><title>Wait</title></head>
      <body>
        <div id="root"></div>
        <button id="btn" disabled>Go</button>
        <script>
          setTimeout(() => {
            const el = document.createElement('div');
            el.id = 'later';
            el.textContent = 'Hello later';
            document.getElementById('root').appendChild(el);
          }, 300);
          setTimeout(() => {
            document.getElementById('btn').disabled = false;
          }, 450);
        </script>
      </body>
    </html>
  `);

  const res1 = await waitForSelector(page, '#later', { timeoutMs: 5000, state: 'visible' });
  assert.equal(res1.status, 'ready');

  const res2 = await waitForText(page, 'Hello later', { timeoutMs: 5000, state: 'visible' });
  assert.equal(res2.status, 'ready');

  const res3 = await waitForSelector(page, '#btn', { timeoutMs: 5000, state: 'enabled' });
  assert.equal(res3.status, 'ready');
  assert.equal(await page.locator('#btn').isEnabled(), true);

  await browser.close();
  console.log('PASS wait-for-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

