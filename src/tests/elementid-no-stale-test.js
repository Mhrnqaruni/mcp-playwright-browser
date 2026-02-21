import assert from 'node:assert/strict';
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  await page.setContent(`
    <html>
      <head><title>ElementId</title></head>
      <body>
        <button id="btn">Click me</button>
        <input id="cb1" type="checkbox" style="position:absolute; left:-9999px; top:0;" />
        <label for="cb1">I confirm</label>
        <script>
          window.__clicked = 0;
          document.addEventListener('click', (e) => {
            if (e && e.target && e.target.id === 'btn') window.__clicked += 1;
          });
        </script>
      </body>
    </html>
  `);

  // Mimic the server's selector-plan approach: store a selector, not a handle.
  const plan = await page.evaluate(() => {
    const escapeCss = (value) => {
      if (window.CSS && CSS.escape) return CSS.escape(value);
      return String(value || '').replace(/([ #;?%&,.+*~':"!^$\\[\\]()=>|\/@])/g, '\\\\$1');
    };
    const makeSelector = (el) => {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return `#${escapeCss(el.id)}`;
      const testId = el.getAttribute('data-testid');
      if (testId) return `[data-testid="${escapeCss(testId)}"]`;
      const aria = el.getAttribute('aria-label');
      if (aria && aria.length <= 120) return `${el.tagName.toLowerCase()}[aria-label="${escapeCss(aria)}"]`;
      const name = el.getAttribute('name');
      if (name && name.length <= 120) return `${el.tagName.toLowerCase()}[name="${escapeCss(name)}"]`;
      const role = el.getAttribute('role');
      if (role) return `${el.tagName.toLowerCase()}[role="${escapeCss(role)}"]`;
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
        let part = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((n) => n.tagName === cur.tagName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(cur) + 1;
            part += `:nth-of-type(${index})`;
          }
        }
        parts.unshift(part);
        cur = cur.parentElement;
        if (parts.length >= 6) break;
      }
      return parts.join(' > ');
    };

    return {
      btnSelector: makeSelector(document.getElementById('btn')),
      cbSelector: makeSelector(document.getElementById('cb1'))
    };
  });

  assert.equal(plan.btnSelector, '#btn');
  assert.equal(plan.cbSelector, '#cb1');

  // Rerender the button: old handles would be stale, selector-plan remains valid.
  await page.evaluate(() => {
    const old = document.getElementById('btn');
    old.remove();
    const b = document.createElement('button');
    b.id = 'btn';
    b.textContent = 'Click me';
    document.body.insertBefore(b, document.body.firstChild);
  });

  await page.locator(plan.btnSelector).click();
  const clicked = await page.evaluate(() => window.__clicked);
  assert.equal(clicked, 1);

  // Mimic the server's label-first click strategy for input[type=checkbox].
  const clickedLabel = await page.locator(plan.cbSelector).evaluate((node) => {
    const input = node;
    let label = null;
    try {
      if (input?.labels && input.labels.length) label = input.labels[0];
    } catch {
      label = null;
    }
    if (!label) {
      const id = input?.id;
      if (id && window.CSS && CSS.escape) {
        label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      }
    }
    if (!label && input?.closest) {
      label = input.closest('label');
    }
    if (label) {
      label.click();
      return true;
    }
    return false;
  });
  assert.equal(clickedLabel, true);
  assert.equal(await page.locator('#cb1').isChecked(), true);

  await browser.close();
  console.log('PASS elementid-no-stale-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

