# Gemini + Playwright Web Automation (MCP)

## Overview
This project provides a local MCP server that exposes Playwright-powered browser tools to Gemini CLI. Gemini can then navigate pages, extract data, and save files by calling these tools.

Key pieces:
- `src/mcp-browser-server.js`: MCP server exposing browser, search, and job-extraction tools.
- `src/extractors.js`: Robust extractors for Indeed job cards and Google search results.
- `src/tests/indeed-test.js`: End-to-end extractor test for Indeed.
- `src/tests/google-test.js`: End-to-end extractor test for Google search results.

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```

2. Install Playwright Chromium:
   ```bash
   npx playwright install chromium
   ```

3. Install Gemini CLI (if not already installed), then log in following Google’s instructions.

4. Configure Gemini CLI to use the MCP server. Gemini CLI reads `mcpServers` from a `settings.json` file. You can add it manually (project `.gemini/settings.json` or user `~/.gemini/settings.json`) or use `gemini mcp add`.

Manual example for a project-local `.gemini/settings.json`:
   ```json
   {
     "mcpServers": {
       "playwrightBrowser": {
         "command": "node",
         "args": ["src/mcp-browser-server.js"],
         "cwd": "C:/Users/User/Desktop/Applying for Job/Auto"
       }
     }
   }
   ```

CLI example:
```bash
gemini mcp add playwrightBrowser node src/mcp-browser-server.js
```

## Using Gemini CLI With This Server
Start Gemini CLI in this repo. Then issue prompts like:

- “Launch the browser (headless: false). Go to `https://ae.indeed.com/q-ai-engineer-l-dubai-jobs.html`, extract the jobs, and save them as txt files under `output/indeed/page-1`.”
- “Go to the next page, extract jobs again, and save under `output/indeed/page-2`.”
- “Go back to the first page and tell me the salary for the first job.”
- “Search Google for ‘remote ai jobs in usa’, extract the top 10 results, and save them under `output/google`.”

Gemini will call tools like:
- `browser.launch`, `browser.goto`, `browser.list`, `browser.click`, `browser.back`
- `jobs.extract_indeed`, `jobs.indeed_next_page`
- `search.google`, `search.extract_google`
- `files.write_text` for custom saves

## Running Local Tests
```bash
npm run test:indeed
npm run test:google
```

### Notes on Blocking / Captchas
- Indeed and Google can block automation or show captchas (Cloudflare “Request Blocked”, Google “unusual traffic”).
- Indeed can also require sign-in to view page 2+ of results.
- If that happens:
  - Use `browser.launch` with `headless: false` so you can solve captchas.
  - Use a real browser profile via `userDataDir` in `browser.launch` to reuse cookies.
  - Try a different network/IP.

Example for a persistent profile:
```json
{
  "tool": "browser.launch",
  "args": {
    "headless": false,
    "userDataDir": "C:/Users/User/AppData/Local/Google/Chrome/User Data",
    "args": ["--disable-blink-features=AutomationControlled"],
    "stealth": true
  }
}
```

If you already have Chrome running with remote debugging enabled, you can connect and reuse that session (best for logged-in accounts):
```json
{
  "tool": "browser.connect_cdp",
  "args": {
    "endpoint": "http://127.0.0.1:9222"
  }
}
```

## Tool Reference (High-Level)
- `browser.launch`: Start Chromium. Optional `userDataDir` for persistent profiles.
- `browser.connect_cdp`: Attach to an existing Chrome instance with remote debugging.
- `browser.goto`: Navigate to a URL.
- `browser.list`: List clickable elements.
- `browser.click`: Click by elementId, selector, or text.
- `browser.snapshot`: Get page summary text and links.
- `jobs.extract_indeed`: Extract job cards and optionally save to txt.
- `jobs.indeed_next_page`: Click Indeed “Next” pagination.
- `search.google`: Open Google search and extract results.
- `search.extract_google`: Extract results from current Google search page.
- `files.write_text`: Save arbitrary text.

## Output
- Indeed results: `output/indeed/.../*.txt`
- Google results: `output/google/*.txt`

Each `.txt` file is named after the job/result title and contains key fields (title, company, location, salary, URL, snippet).
