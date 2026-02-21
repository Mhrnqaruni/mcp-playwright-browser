import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { auditForm, fillForm } from '../browser/forms.js';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <head><title>Form</title></head>
      <body>
        <form>
          <label for="full">Full Name</label>
          <input id="full" required />

          <fieldset>
            <legend>Are you comfortable working in a hybrid setting?</legend>
            <label><input type="radio" name="hybrid" value="Yes" required /> Yes</label>
            <label><input type="radio" name="hybrid" value="No" required /> No</label>
          </fieldset>

          <label for="country">Country</label>
          <select id="country" required>
            <option value="">Choose</option>
            <option value="UK">United Kingdom</option>
            <option value="MY">Malaysia</option>
          </select>

          <label><input id="confirm" type="checkbox" required /> I confirm</label>
        </form>
      </body>
    </html>
  `);

  const before = await auditForm(page, { maxItems: 50, includeSelectors: true });
  assert.equal(before.missingCount >= 3, true);
  const labels = before.missing.map((m) => m.label);
  assert.equal(labels.includes('Full Name'), true);
  assert.equal(labels.some((l) => /hybrid setting/i.test(l)), true);
  assert.equal(labels.includes('Country'), true);

  const fill = await fillForm(page, [
    { label: 'Full Name', value: 'Test User' },
    { label: 'Are you comfortable working in a hybrid setting?', kind: 'radio', value: 'Yes' },
    { label: 'Country', value: 'Malaysia' },
    { selector: '#confirm', kind: 'checkbox', value: true }
  ]);
  assert.equal(fill.failed, 0);

  const after = await auditForm(page, { maxItems: 50, includeSelectors: true });
  assert.equal(after.missingCount, 0);

  await browser.close();
  console.log('PASS form-audit-fill-test');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

