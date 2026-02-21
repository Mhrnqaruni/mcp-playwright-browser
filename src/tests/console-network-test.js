import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { getNetworkRequest, listConsoleMessages, listNetworkRequests } from '../browser/observability.js';

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Attach CDP listeners before any page script runs.
  await listConsoleMessages(page, { limit: 1 });

  await page.route('https://example.com/api/test', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true })
    });
  });

  await page.setContent(`
    <html>
      <head><title>Obs</title></head>
      <body>
        <script>
          console.log('hello', 'world');
          fetch('https://example.com/api/test').then(r => r.json()).then(() => {
            console.log('fetch done');
          });
          setTimeout(() => { throw new Error('boom'); }, 50);
        </script>
      </body>
    </html>
  `);

  // Allow fetch + exception to fire and CDP to collect events.
  await delay(400);

  const messages = await listConsoleMessages(page, { limit: 50 });
  assert.ok(messages.some((m) => (m.text || '').includes('hello world')));
  assert.ok(messages.some((m) => (m.text || '').includes('boom') || m.type === 'exception'));

  const reqs = await listNetworkRequests(page, { limit: 50, urlContains: '/api/test' });
  assert.ok(reqs.length >= 1);
  const id = reqs[reqs.length - 1].requestId;
  assert.ok(id);

  const detail = await getNetworkRequest(page, id, { includeBody: true, maxBodyChars: 2000 });
  assert.equal(detail.response?.status, 200);
  assert.ok(typeof detail.body === 'string');
  assert.ok(detail.body.includes('"ok":true'));

  await browser.close();
  console.log('PASS console-network-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
