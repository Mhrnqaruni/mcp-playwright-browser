import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { takeA11ySnapshot } from '../browser/snapshot.js';
import { hoverByBackendNodeId } from '../browser/cdp.js';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <body>
        <button id="hover-target" aria-label="Hover target">Hover me</button>
        <script>
          window.__hoverCount = 0;
          const el = document.getElementById('hover-target');
          el.addEventListener('mouseover', () => { window.__hoverCount += 1; });
        </script>
      </body>
    </html>
  `);

  const { nodes, uidToBackend } = await takeA11ySnapshot(page, { interestingOnly: true, maxNodes: 100 });
  const hoverNode = nodes.find((n) => n.role === 'button' && /hover target/i.test(n.name));
  assert.ok(hoverNode);

  const backendNodeId = uidToBackend.get(hoverNode.uid);
  assert.ok(typeof backendNodeId === 'number');

  await hoverByBackendNodeId(page, backendNodeId);
  const hoverCount = await page.evaluate(() => window.__hoverCount);
  assert.ok(hoverCount >= 1);

  await browser.close();
  console.log('PASS cdp-hover-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

