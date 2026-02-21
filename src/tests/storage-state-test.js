import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addCookies([
    {
      name: 'mcp_cookie',
      value: '1',
      url: 'https://example.com'
    }
  ]);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-storage-state-'));
  const storagePath = path.join(tempDir, 'state.json');
  await context.storageState({ path: storagePath });

  const imported = await browser.newContext({ storageState: storagePath });
  const importedCookies = await imported.cookies(['https://example.com']);
  const found = importedCookies.find((cookie) => cookie.name === 'mcp_cookie' && cookie.value === '1');
  assert.ok(found);

  await imported.close();
  await context.close();
  await browser.close();
  await fs.rm(tempDir, { recursive: true, force: true });
  console.log('PASS storage-state-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

