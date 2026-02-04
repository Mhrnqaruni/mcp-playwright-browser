import { chromium } from 'playwright';
import {
  extractIndeedJobs,
  saveJobsToTxt,
  detectIndeedAccessIssue
} from '../extractors.js';

const TARGET_URL = 'https://ae.indeed.com/q-ai-engineer-l-dubai-jobs.html';
const PAGE_2_URL = 'https://ae.indeed.com/q-ai-engineer-l-dubai-jobs.html?start=10';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const browser = await chromium.launch({
  headless: process.env.HEADFUL ? false : true,
  args: ['--disable-blink-features=AutomationControlled']
});

async function createContext() {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: USER_AGENT
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  });
  return context;
}

// Page 1
let context = await createContext();
let page = await context.newPage();
console.log(`Opening ${TARGET_URL}`);
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
const access1 = await detectIndeedAccessIssue(page);
if (access1.blocked || access1.authRequired) {
  console.log(access1.message || 'Indeed access issue detected on page 1.');
  await browser.close();
  process.exit(0);
}

const jobsPage1 = await extractIndeedJobs(page, { limit: 16 });
const savedPage1 = await saveJobsToTxt(jobsPage1, 'output/indeed/page-1');
console.log(`Saved ${savedPage1.files.length} jobs from page 1.`);
const firstJob = jobsPage1[0];
console.log(`First job salary (page 1): ${firstJob?.salary || 'N/A'}`);

await context.close();

// Page 2 in a fresh context to reduce block risk
context = await createContext();
page = await context.newPage();
console.log(`Opening ${PAGE_2_URL}`);
await page.goto(PAGE_2_URL, { waitUntil: 'domcontentloaded' });
const access2 = await detectIndeedAccessIssue(page);
if (access2.blocked || access2.authRequired) {
  console.log(access2.message || 'Indeed access issue detected on page 2.');
  await browser.close();
  process.exit(0);
}

const jobsPage2 = await extractIndeedJobs(page, { limit: 16 });
const savedPage2 = await saveJobsToTxt(jobsPage2, 'output/indeed/page-2');
console.log(`Saved ${savedPage2.files.length} jobs from page 2.`);

await context.close();
await browser.close();
