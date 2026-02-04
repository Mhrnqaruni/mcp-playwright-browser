import fs from 'node:fs/promises';
import path from 'node:path';

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*]+/g;

export function sanitizeFileName(name) {
  const base = (name || '').replace(INVALID_FILENAME_CHARS, '_').replace(/\s+/g, ' ').trim();
  if (!base) return 'item';
  return base.length > 80 ? base.slice(0, 80).trim() : base;
}

export async function saveJobsToTxt(jobs, dir) {
  const targetDir = path.resolve(dir);
  await fs.mkdir(targetDir, { recursive: true });
  const used = new Map();
  const files = [];

  for (const job of jobs) {
    const baseName = sanitizeFileName(job.title || 'job');
    const count = (used.get(baseName) || 0) + 1;
    used.set(baseName, count);
    const fileName = count === 1 ? `${baseName}.txt` : `${baseName}-${count}.txt`;
    const filePath = path.join(targetDir, fileName);

    const lines = [
      `Title: ${job.title || ''}`,
      `Company: ${job.company || ''}`,
      `Location: ${job.location || ''}`,
      `Salary: ${job.salary || ''}`,
      `URL: ${job.url || ''}`,
      'Summary:',
      job.summary || ''
    ];

    await fs.writeFile(filePath, lines.join('\n').trim() + '\n', 'utf8');
    files.push(filePath);
  }

  return { dir: targetDir, files };
}

export async function saveSearchResultsToTxt(results, dir) {
  const targetDir = path.resolve(dir);
  await fs.mkdir(targetDir, { recursive: true });
  const used = new Map();
  const files = [];

  for (const result of results) {
    const baseName = sanitizeFileName(result.title || 'result');
    const count = (used.get(baseName) || 0) + 1;
    used.set(baseName, count);
    const fileName = count === 1 ? `${baseName}.txt` : `${baseName}-${count}.txt`;
    const filePath = path.join(targetDir, fileName);

    const lines = [
      `Title: ${result.title || ''}`,
      `URL: ${result.url || ''}`,
      'Snippet:',
      result.snippet || ''
    ];

    await fs.writeFile(filePath, lines.join('\n').trim() + '\n', 'utf8');
    files.push(filePath);
  }

  return { dir: targetDir, files };
}

export async function extractIndeedJobs(page, { limit = 20 } = {}) {
  await page.waitForLoadState('domcontentloaded');

  const selectors = [
    '[data-testid="job-card"]',
    '.job_seen_beacon',
    '.jobsearch-SerpJobCard',
    'a.tapItem'
  ];

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 8000 });
      break;
    } catch {
      // try next selector
    }
  }

  const payload = await page.evaluate(({ limit, selectors }) => {
    const pick = (root, selectorList) => {
      for (const selector of selectorList) {
        const node = root.querySelector(selector);
        if (!node) continue;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      return '';
    };

    let cards = [];
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector));
      if (found.length) {
        cards = found;
        break;
      }
    }

    const jobs = cards.map((card) => {
      const title = pick(card, [
        'h2 a span',
        'h2 span',
        '[data-testid="job-title"]',
        'h2',
        'a[aria-label]'
      ]);

      const company = pick(card, [
        '[data-testid="company-name"]',
        '.companyName',
        'span.companyName'
      ]);

      const location = pick(card, [
        '[data-testid="text-location"]',
        '.companyLocation',
        'div.companyLocation'
      ]);

      const salary = pick(card, [
        '.salary-snippet-container',
        '.salary-snippet',
        '[data-testid="attribute_snippet_testid"]'
      ]);

      const summary = pick(card, [
        '.job-snippet',
        '[data-testid="job-snippet"]'
      ]);

      const linkEl = card.querySelector('a[href*="viewjob"], a[href^="/"]');
      const href = linkEl ? linkEl.getAttribute('href') : '';
      const jobKey = card.getAttribute('data-jk') || '';

      return {
        title,
        company,
        location,
        salary,
        summary,
        url: href || '',
        jobKey
      };
    });

    return {
      totalCards: cards.length,
      jobs: jobs.filter((job) => job.title || job.company || job.url).slice(0, limit)
    };
  }, { limit, selectors });

  const baseUrl = page.url();
  const jobs = payload.jobs.map((job) => {
    let url = job.url || '';
    if (url) {
      try {
        url = new URL(url, baseUrl).toString();
      } catch {
        // keep as-is
      }
    }
    return { ...job, url };
  });

  const seen = new Set();
  const uniqueJobs = [];
  for (const job of jobs) {
    const key = `${job.title}|${job.company}|${job.location}|${job.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueJobs.push(job);
  }

  return uniqueJobs;
}

export async function detectIndeedAccessIssue(page) {
  try {
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body?.innerText || '');
    if (/Request Blocked|Cloudflare/i.test(text)) {
      return {
        blocked: true,
        authRequired: false,
        message: 'Indeed returned a Request Blocked (Cloudflare) page.'
      };
    }
    if (/To see more than one page of jobs, create an account or sign in/i.test(text)) {
      return {
        blocked: false,
        authRequired: true,
        message: 'Indeed requires sign-in to view more than one page of jobs.'
      };
    }
    return { blocked: false, authRequired: false, message: '' };
  } catch {
    return { blocked: false, authRequired: false, message: '' };
  }
}

export async function clickIndeedNextPage(page) {
  const selectors = [
    'a[aria-label="Next Page"]',
    'a[aria-label="Next"]',
    'a[data-testid="pagination-page-next"]',
    'a[aria-label="Next Page"] svg'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.click();
      return true;
    }
  }

  const nextButton = page.getByRole('link', { name: /next/i });
  if (await nextButton.count()) {
    await nextButton.first().click();
    return true;
  }

  return false;
}

export async function tryAcceptGoogleConsent(page) {
  const buttonLabels = ['I agree', 'Accept all', 'Accept all cookies', 'Agree'];

  for (const label of buttonLabels) {
    const button = page.getByRole('button', { name: label, exact: false });
    if (await button.count()) {
      await button.first().click();
      await page.waitForTimeout(1000);
      return true;
    }
  }

  const selectors = ['button#L2AGLb', 'button#W0wltc'];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.click();
      await page.waitForTimeout(1000);
      return true;
    }
  }

  return false;
}

export async function extractGoogleResults(page, { limit = 10 } = {}) {
  await page.waitForLoadState('domcontentloaded');
  try {
    await page.waitForSelector('#search', { timeout: 8000 });
  } catch {
    // continue anyway
  }

  const results = await page.evaluate((limit) => {
    const containers = Array.from(document.querySelectorAll('div.MjjYud, div.g'));
    const items = [];

    for (const container of containers) {
      const titleEl = container.querySelector('h3');
      const linkEl = container.querySelector('a[href]');
      if (!titleEl || !linkEl) continue;
      const title = (titleEl.textContent || '').replace(/\s+/g, ' ').trim();
      const url = linkEl.getAttribute('href') || '';
      const snippetEl = container.querySelector('.VwiC3b, .IsZvec, .aCOpRe');
      const snippet = (snippetEl?.textContent || '').replace(/\s+/g, ' ').trim();

      if (!title || !url) continue;
      items.push({ title, url, snippet });
      if (items.length >= limit) break;
    }

    return items;
  }, limit);

  const cleaned = results.map((item) => {
    let url = item.url || '';
    if (url.startsWith('/url?')) {
      try {
        const params = new URLSearchParams(url.slice(5));
        url = params.get('q') || url;
      } catch {
        // keep as-is
      }
    }
    return { ...item, url };
  });

  return cleaned;
}

export async function detectGoogleBlocked(page) {
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    return /unusual traffic|not a robot|detected unusual traffic/i.test(text);
  } catch {
    return false;
  }
}
