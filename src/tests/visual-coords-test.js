import assert from 'node:assert/strict';
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  await page.setContent(`
    <html>
      <head>
        <title>Visual</title>
        <style>
          body { margin: 0; }
          #spacer { height: 2200px; background: linear-gradient(#fff, #eee); }
          #target { height: 80px; background: #fdd; border: 2px solid #c00; }
        </style>
      </head>
      <body>
        <div id="spacer"></div>
        <button id="target">Target</button>
      </body>
    </html>
  `);

  // Scroll down so the target is near the viewport but not at the very top.
  await page.evaluate(() => window.scrollTo(0, 1500));
  const scrollY = await page.evaluate(() => window.scrollY);
  assert.ok(scrollY >= 1000);

  const box = await page.locator('#target').boundingBox();
  assert.ok(box);
  // Playwright boundingBox is viewport-relative; page-space y is viewport y + scrollY.
  const pageY = Math.round(box.y + scrollY);

  // The target sits after a 2200px spacer. Allow some tolerance for layout differences.
  assert.ok(pageY > 2000 && pageY < 2600);

  // Iframe regression checks:
  // 1) Playwright returns page-viewport coordinates for iframe element bounding boxes.
  // 2) Page-space conversion must add top-page scroll only (not iframe scroll).
  await page.setContent(`
    <html>
      <head>
        <style>
          body { margin: 0; }
          iframe { position: absolute; left: 700px; top: 100px; width: 400px; height: 300px; border: 0; }
        </style>
      </head>
      <body>
        <iframe id="child" srcdoc="
          <html><body style='margin:0;height:2000px'>
            <button id='inside' style='margin-left:30px;margin-top:600px;width:100px;height:50px'>Inside</button>
          </body></html>
        "></iframe>
      </body>
    </html>
  `);

  const childFrame = page.frames().find((f) => f !== page.mainFrame());
  assert.ok(childFrame);
  await childFrame.waitForSelector('#inside');
  await childFrame.evaluate(() => window.scrollTo(0, 400));
  const iframeScrollY = await childFrame.evaluate(() => window.scrollY);
  assert.ok(iframeScrollY >= 300);

  const inFrameHandle = await childFrame.$('#inside');
  assert.ok(inFrameHandle);
  const inFrameBox = await inFrameHandle.boundingBox();
  assert.ok(inFrameBox);

  const topViewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, sy: window.scrollY }));
  const frameViewport = await childFrame.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

  const intersectsTopViewport =
    inFrameBox.x < topViewport.w &&
    inFrameBox.y < topViewport.h &&
    inFrameBox.x + inFrameBox.width > 0 &&
    inFrameBox.y + inFrameBox.height > 0;
  const intersectsFrameViewport =
    inFrameBox.x < frameViewport.w &&
    inFrameBox.y < frameViewport.h &&
    inFrameBox.x + inFrameBox.width > 0 &&
    inFrameBox.y + inFrameBox.height > 0;

  // Element is visible on the top page viewport; frame-local viewport intersection is not a valid test.
  assert.equal(intersectsTopViewport, true);
  assert.equal(intersectsFrameViewport, false);

  const pageSpaceYUsingTopScroll = Math.round(inFrameBox.y + topViewport.sy);
  const pageSpaceYUsingFrameScroll = Math.round(inFrameBox.y + iframeScrollY);
  // Correct conversion uses top-page scroll, not iframe scroll.
  assert.notEqual(pageSpaceYUsingTopScroll, pageSpaceYUsingFrameScroll);

  await browser.close();
  console.log('PASS visual-coords-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
