import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { ensureDomTracker, listFrames, getFrameById } from '../browser/dom-version.js';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <body>
        <iframe id="child" srcdoc="<html><body><button id='inside'>Inside</button></body></html>"></iframe>
      </body>
    </html>
  `);

  await page.frameLocator('#child').locator('#inside').waitFor();

  const tracker = ensureDomTracker(page);
  const framesSnapshot1 = listFrames(page);
  assert.ok(framesSnapshot1.frames.length >= 2);

  const childFrameEntry = framesSnapshot1.frames.find((f) => !f.isMainFrame);
  assert.ok(childFrameEntry);

  const childFrame = getFrameById(page, childFrameEntry.frameId);
  assert.ok(childFrame);

  const ctx1 = tracker.getDomContext(childFrame);

  await page.evaluate(() => {
    const frame = document.getElementById('child');
    frame.srcdoc = "<html><body><button id='inside2'>Inside 2</button></body></html>";
  });

  await page.frameLocator('#child').locator('#inside2').waitFor();

  const ctx2 = tracker.getDomContext(childFrame);
  assert.notEqual(ctx1.domVersion, ctx2.domVersion);
  assert.ok(ctx2.frameDomVersion > ctx1.frameDomVersion);

  await browser.close();
  console.log('PASS frame-domversion-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

