function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export async function auditForm(page, opts = {}) {
  const maxItems = clampNumber(opts.maxItems, 1, 1000, 200);
  const includeSelectors = opts.includeSelectors ?? true;
  const maxLabelChars = clampNumber(opts.maxLabelChars, 20, 500, 180);

  return await page.evaluate(({ maxItems, includeSelectors, maxLabelChars }) => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const trunc = (s) => {
      const t = clean(s);
      if (maxLabelChars <= 0 || t.length <= maxLabelChars) return t;
      if (maxLabelChars <= 3) return t.slice(0, maxLabelChars);
      return t.slice(0, maxLabelChars - 3) + '...';
    };

    const escapeCss = (value) => {
      if (window.CSS && CSS.escape) return CSS.escape(value);
      return String(value || '').replace(/([ #;?%&,.+*~':"!^$\\[\\]()=>|\/@])/g, '\\\\$1');
    };

    const makeSelectorHint = (el) => {
      if (!includeSelectors) return null;
      if (!el || el.nodeType !== 1) return null;
      if (el.id) return `#${escapeCss(el.id)}`;
      const name = el.getAttribute('name');
      if (name && name.length <= 120) return `${el.tagName.toLowerCase()}[name="${escapeCss(name)}"]`;
      const aria = el.getAttribute('aria-label');
      if (aria && aria.length <= 120) return `${el.tagName.toLowerCase()}[aria-label="${escapeCss(aria)}"]`;
      const testId = el.getAttribute('data-testid');
      if (testId && testId.length <= 120) return `[data-testid="${escapeCss(testId)}"]`;
      return null;
    };

    const labelFromAriaLabelledBy = (el) => {
      const ids = clean(el.getAttribute('aria-labelledby') || '');
      if (!ids) return '';
      const texts = ids
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => clean(n.textContent))
        .filter(Boolean);
      return texts.join(' ').trim();
    };

    const labelFromNativeLabel = (el) => {
      try {
        // For inputs, labels is a NodeList of associated <label>.
        // For others, fall back to closest label.
        const labels = el.labels ? Array.from(el.labels) : [];
        const direct = labels.map((l) => clean(l.textContent)).filter(Boolean).join(' ').trim();
        if (direct) return direct;
      } catch {
        // ignore
      }
      const wrap = el.closest ? el.closest('label') : null;
      if (wrap) return clean(wrap.textContent);
      return '';
    };

    const getLabel = (el) => {
      return trunc(
        labelFromNativeLabel(el) ||
          clean(el.getAttribute('aria-label') || '') ||
          labelFromAriaLabelledBy(el) ||
          clean(el.getAttribute('placeholder') || '') ||
          clean(el.getAttribute('name') || '') ||
          clean(el.id || '')
      );
    };

    const isRequired = (el) => {
      if (!el) return false;
      try {
        if (el.required) return true;
      } catch {
        // ignore
      }
      const ariaReq = clean(el.getAttribute('aria-required') || '');
      if (ariaReq.toLowerCase() === 'true') return true;
      if (el.hasAttribute('required')) return true;
      return false;
    };

    const missing = [];

    // Native controls
    const controls = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'));

    // Handle radio groups separately to avoid listing each radio input.
    const radioByName = new Map();
    for (const el of controls) {
      if (!(el instanceof HTMLInputElement)) continue;
      if ((el.getAttribute('type') || '').toLowerCase() !== 'radio') continue;
      const name = clean(el.getAttribute('name') || '');
      if (!name) continue;
      if (!radioByName.has(name)) radioByName.set(name, []);
      radioByName.get(name).push(el);
    }

    const seen = new Set();

    for (const el of controls) {
      if (missing.length >= maxItems) break;

      if (el instanceof HTMLInputElement) {
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'radio') {
          const name = clean(el.getAttribute('name') || '');
          if (!name || seen.has(`radio:${name}`)) continue;
          seen.add(`radio:${name}`);

          const group = radioByName.get(name) || [];
          const required = group.some((r) => isRequired(r));
          if (!required) continue;
          const answered = group.some((r) => r.checked);
          if (answered) continue;

          // Best-effort group label.
          let label = '';
          const fs = el.closest ? el.closest('fieldset') : null;
          if (fs) {
            const legend = fs.querySelector('legend');
            label = clean(legend?.textContent);
          }
          if (!label) label = getLabel(el);

          missing.push({
            kind: 'radio',
            label: trunc(label || name || 'radio'),
            selector: makeSelectorHint(el),
            groupName: name
          });
          continue;
        }

        if (type === 'checkbox') {
          if (!isRequired(el)) continue;
          if (el.checked) continue;
          missing.push({
            kind: 'checkbox',
            label: getLabel(el),
            selector: makeSelectorHint(el)
          });
          continue;
        }

        if (!isRequired(el)) continue;
        const val = clean(el.value || '');
        if (val) continue;
        missing.push({
          kind: 'text',
          label: getLabel(el),
          selector: makeSelectorHint(el)
        });
        continue;
      }

      if (el instanceof HTMLTextAreaElement) {
        if (!isRequired(el)) continue;
        const val = clean(el.value || '');
        if (val) continue;
        missing.push({
          kind: 'textarea',
          label: getLabel(el),
          selector: makeSelectorHint(el)
        });
        continue;
      }

      if (el instanceof HTMLSelectElement) {
        if (!isRequired(el)) continue;
        const value = clean(el.value || '');
        if (value) continue;
        missing.push({
          kind: 'select',
          label: getLabel(el),
          selector: makeSelectorHint(el)
        });
        continue;
      }

      // contenteditable
      if (el && el.getAttribute && el.getAttribute('contenteditable') === 'true') {
        if (!isRequired(el)) continue;
        const val = clean(el.textContent || '');
        if (val) continue;
        missing.push({
          kind: 'contenteditable',
          label: getLabel(el),
          selector: makeSelectorHint(el)
        });
      }
    }

    return {
      url: window.location.href,
      title: document.title,
      missingCount: missing.length,
      missing
    };
  }, { maxItems, includeSelectors, maxLabelChars });
}

async function detectControlKind(locator) {
  const tag = await locator.evaluate((el) => (el.tagName || '').toLowerCase());
  const type = tag === 'input' ? String((await locator.getAttribute('type')) || '').toLowerCase() : '';
  return { tag, type };
}

export async function fillForm(page, fields, opts = {}) {
  const timeoutMs = clampNumber(opts.timeoutMs, 1000, 300000, 30000);
  const results = [];

  for (const field of fields || []) {
    const label = cleanText(field?.label);
    const selector = cleanText(field?.selector);
    const value = field?.value ?? '';
    const kind = cleanText(field?.kind);

    if (!label && !selector) {
      results.push({ ok: false, error: 'Field missing label/selector.' });
      continue;
    }

    try {
      if (selector) {
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });
        const meta = await detectControlKind(locator);

        if (meta.tag === 'select') {
          await locator.selectOption({ label: String(value) });
          results.push({ ok: true, via: 'selector', selector, kind: 'select' });
          continue;
        }

        if (meta.tag === 'input' && (meta.type === 'radio' || meta.type === 'checkbox')) {
          await locator.click({ timeout: timeoutMs });
          results.push({ ok: true, via: 'selector', selector, kind: meta.type });
          continue;
        }

        await locator.fill(String(value), { timeout: timeoutMs });
        results.push({ ok: true, via: 'selector', selector, kind: kind || 'text' });
        continue;
      }

      // label-driven
      if (kind === 'radio' || kind === 'checkbox') {
        // Scope the option selection to a container near the question label when possible.
        const labelNode = page.getByText(label, { exact: false }).first();
        await labelNode.waitFor({ state: 'visible', timeout: timeoutMs });

        let container = labelNode.locator('xpath=ancestor::*[self::div or self::fieldset or self::section][1]').first();
        let clicked = false;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            const option = container.getByRole(kind, { name: String(value), exact: false }).first();
            if ((await option.count()) > 0) {
              await option.click({ timeout: timeoutMs });
              clicked = true;
              break;
            }
          } catch {
            // keep trying parent container
          }
          container = container.locator('xpath=ancestor::*[self::div or self::fieldset or self::section][1]').first();
        }

        if (!clicked) {
          const option = page.getByRole(kind, { name: String(value), exact: false }).first();
          await option.click({ timeout: timeoutMs });
        }

        results.push({ ok: true, via: 'label+role', label, kind });
        continue;
      }

      const control = page.getByLabel(label, { exact: false }).first();
      await control.waitFor({ state: 'visible', timeout: timeoutMs });
      const meta = await detectControlKind(control);

      if (meta.tag === 'select') {
        await control.selectOption({ label: String(value) });
        results.push({ ok: true, via: 'label', label, kind: 'select' });
        continue;
      }

      // For some "combobox" patterns, getByLabel may return an input.
      await control.fill(String(value), { timeout: timeoutMs });
      results.push({ ok: true, via: 'label', label, kind: kind || meta.tag || 'text' });
    } catch (err) {
      const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
      results.push({ ok: false, label: label || null, selector: selector || null, kind: kind || null, error: msg });
    }
  }

  return {
    count: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  };
}

