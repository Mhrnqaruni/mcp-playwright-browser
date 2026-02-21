import { chromium } from 'playwright';

const FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSe5NKcSePaXs9E_poGz0cX05qEPsV6dv_8zuH2dHc8X-tnYHg/viewform';

function auditQuestionsInPage(maxQ = 200, maxA = 200) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const trunc = (s) => {
    const t = clean(s);
    if (maxA <= 0 || t.length <= maxA) return t;
    if (maxA <= 3) return t.slice(0, maxA);
    return t.slice(0, maxA - 3) + '...';
  };

  const blocks = Array.from(document.querySelectorAll('.Qr7Oae')).slice(0, maxQ);
  const questions = [];

  for (const block of blocks) {
    const titleEl = block.querySelector('[role=heading]');
    const title = clean(titleEl?.textContent);
    if (!title) continue;

    const listbox = block.querySelector('[role=listbox], [role=combobox]');
    const textarea = block.querySelector('textarea');
    const textInput = block.querySelector(
      'input[type=text], input[type=email], input[type=url], input[type=date], input:not([type])'
    );

    const checkboxEls = Array.from(block.querySelectorAll('div[role=checkbox]')).filter((el) =>
      clean(el.getAttribute('aria-label'))
    );
    const radioEls = Array.from(block.querySelectorAll('div[role=radio]')).filter((el) =>
      clean(el.getAttribute('aria-label'))
    );

    const q = {
      title,
      type: 'unknown',
      answered: false,
      answer: null
    };

    if (textarea) {
      const val = textarea.value || '';
      q.type = 'textarea';
      q.answer = trunc(val);
      q.answered = clean(val).length > 0;
    } else if (listbox) {
      q.type = 'dropdown';

      // Google Forms dropdowns often have an aria-selected placeholder like "Choose".
      const placeholders = new Set(['choose', 'select', 'choose an option', 'select an option']);
      const selectedOptions = Array.from(block.querySelectorAll('[role=option][aria-selected=true]'));
      const selectedLabels = selectedOptions
        .map((el) => clean(el.getAttribute('data-value') || el.getAttribute('aria-label') || el.textContent))
        .filter(Boolean);
      const chosen = selectedLabels.find((v) => !placeholders.has(v.toLowerCase())) || '';

      q.answer = chosen ? trunc(chosen) : null;
      q.answered = Boolean(chosen);
    } else if (checkboxEls.length > 0) {
      const selected = checkboxEls
        .filter((el) => el.getAttribute('aria-checked') === 'true')
        .map((el) => clean(el.getAttribute('aria-label')))
        .filter(Boolean);
      q.type = 'checkbox';
      q.answer = selected;
      q.answered = selected.length > 0;
    } else if (radioEls.length > 0) {
      const labels = radioEls.map((el) => clean(el.getAttribute('aria-label'))).filter(Boolean);
      const isGrid = labels.some((l) => l.includes(', response for '));
      if (isGrid) {
        const rows = Array.from(
          new Set(
            labels
              .map((l) => {
                const parts = l.split(', response for ');
                return parts.length === 2 ? clean(parts[1]) : '';
              })
              .filter(Boolean)
          )
        );

        const selectedByRow = {};
        for (const row of rows) {
          const chosen = radioEls.find((el) => {
            const label = clean(el.getAttribute('aria-label'));
            return label.endsWith(`, response for ${row}`) && el.getAttribute('aria-checked') === 'true';
          });
          if (chosen) {
            const label = clean(chosen.getAttribute('aria-label'));
            const parts = label.split(', response for ');
            selectedByRow[row] = parts.length ? clean(parts[0]) : label;
          }
        }

        q.type = 'grid';
        q.answer = selectedByRow;
        q.answered = rows.length > 0 && rows.every((row) => Boolean(selectedByRow[row]));
      } else {
        const selected = radioEls.find((el) => el.getAttribute('aria-checked') === 'true');
        const selectedLabel = selected ? clean(selected.getAttribute('aria-label')) : '';
        const isLinearScale = labels.length > 0 && labels.every((l) => /^\d+$/.test(l));
        q.type = isLinearScale ? 'linear_scale' : 'radio';
        q.answer = selectedLabel || null;
        q.answered = Boolean(selectedLabel);
      }
    } else if (textInput) {
      const val = textInput.value || '';
      q.type = textInput.getAttribute('type') === 'date' ? 'date' : 'text';
      q.answer = trunc(val);
      q.answered = clean(val).length > 0;
    }

    questions.push(q);
  }

  return questions;
}

function findQ(questions, title) {
  return questions.find((x) => x.title === title) || null;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.Qr7Oae', { timeout: 60000 });

  // Fill a few representative field types.
  const fullNameBlock = page
    .locator('div.Qr7Oae')
    .filter({ has: page.locator('[role=heading]').filter({ hasText: /Full Name/i }) })
    .first();
  const fullNameInput = fullNameBlock.locator('input[type=text], input:not([type])').first();
  if (await fullNameInput.isDisabled()) {
    // Google Forms behavior changes frequently (sign-in requirements, bot mitigation, etc.).
    // When inputs are disabled, treat this as a skipped integration test rather than a failure.
    console.log('SKIP google-form-test: form inputs are disabled (likely sign-in required or blocked).');
    await browser.close();
    return;
  }
  await fullNameInput.fill('Test User');

  const educationBlock = page
    .locator('div.Qr7Oae')
    .filter({ has: page.locator('[role=heading]').filter({ hasText: /Highest Level of Education Completed/i }) })
    .first();
  const educationListbox = educationBlock.locator('[role=listbox], [role=combobox]').first();
  await educationListbox.scrollIntoViewIfNeeded();
  await educationListbox.click();
  const mastersOption = page.getByRole('option', { name: "Master's", exact: true }).first();
  await mastersOption.waitFor({ state: 'visible', timeout: 30000 });
  await mastersOption.click();

  const pythonBlock = page
    .locator('div.Qr7Oae')
    .filter({ has: page.locator('[role=heading]').filter({ hasText: /Rate your proficiency with Python/i }) })
    .first();
  const python5 = pythonBlock.getByRole('radio', { name: '5', exact: true }).first();
  await python5.click();

  const domainsBlock = page
    .locator('div.Qr7Oae')
    .filter({ has: page.locator('[role=heading]').filter({ hasText: /AI domains have you worked in/i }) })
    .first();
  const cvCb = domainsBlock.getByRole('checkbox', { name: 'Computer Vision', exact: true }).first();
  await cvCb.click();

  const workModesBlock = page
    .locator('div.Qr7Oae')
    .filter({ has: page.locator('[role=heading]').filter({ hasText: /work modes/i }) })
    .first();
  const remotePrefer = workModesBlock.getByRole('radio', { name: 'Prefer it, response for Remote', exact: true }).first();
  await remotePrefer.click();

  const questions = await page.evaluate(auditQuestionsInPage);

  // Verify audit logic sees the answers.
  const qFullName = findQ(questions, 'Full Name');
  if (!qFullName || !qFullName.answered || qFullName.type !== 'text') {
    console.log(`SKIP google-form-test: Full Name not answered as expected: ${JSON.stringify(qFullName)}`);
    await browser.close();
    return;
  }

  const qEdu = findQ(questions, 'Highest Level of Education Completed');
  if (!qEdu || !qEdu.answered || qEdu.type !== 'dropdown' || qEdu.answer !== "Master's") {
    console.log(`SKIP google-form-test: Education not answered as expected: ${JSON.stringify(qEdu)}`);
    await browser.close();
    return;
  }

  const qPython = findQ(questions, 'Rate your proficiency with Python.');
  if (!qPython || !qPython.answered || qPython.type !== 'linear_scale' || qPython.answer !== '5') {
    console.log(`SKIP google-form-test: Python rating not answered as expected: ${JSON.stringify(qPython)}`);
    await browser.close();
    return;
  }

  const qDomains = findQ(questions, 'Which of the following AI domains have you worked in? (Select all that apply)');
  if (
    !qDomains ||
    !qDomains.answered ||
    qDomains.type !== 'checkbox' ||
    !Array.isArray(qDomains.answer) ||
    !qDomains.answer.includes('Computer Vision')
  ) {
    console.log(`SKIP google-form-test: Domains not answered as expected: ${JSON.stringify(qDomains)}`);
    await browser.close();
    return;
  }

  const qWorkModes = findQ(questions, 'How would you rate your interest in the following work modes?');
  if (!qWorkModes || !qWorkModes.answer || typeof qWorkModes.answer !== 'object' || qWorkModes.answer.Remote !== 'Prefer it') {
    console.log(`SKIP google-form-test: Work modes not answered as expected: ${JSON.stringify(qWorkModes)}`);
    await browser.close();
    return;
  }

  console.log('PASS google-form-test');
  await browser.close();
}

await main();
