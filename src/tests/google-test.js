import { chromium } from 'playwright';
import {
  extractGoogleResults,
  saveSearchResultsToTxt,
  tryAcceptGoogleConsent,
  detectGoogleBlocked
} from '../extractors.js';

const QUERY = 'remote ai jobs in usa';
const TARGET_URL = `https://www.google.com/search?q=${encodeURIComponent(QUERY)}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

console.log(`Searching Google for: ${QUERY}`);
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
await tryAcceptGoogleConsent(page);
if (await detectGoogleBlocked(page)) {
  console.log('Google flagged this session as unusual traffic. Try headful mode or another network/IP.');
  await browser.close();
  process.exit(0);
}

const results = await extractGoogleResults(page, { limit: 10 });
const saved = await saveSearchResultsToTxt(results, 'output/google');
console.log(`Saved ${saved.files.length} Google results.`);

await browser.close();
