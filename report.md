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

## CLI Profiles (.bat)
This repo now includes ready-to-run profile launchers under `scripts/`. Each `.bat` sets environment defaults and starts Gemini.

Available profiles:
- `scripts/run-dom-headless.bat` (fast DOM, headless)
- `scripts/run-visual-headful.bat` (visual mode with screenshots)
- `scripts/run-chrome-profile.bat` (real Chrome using a dedicated automation profile at `ChromeForMCP`)
- `scripts/run-cdp-profile.bat` (auto-launch Chrome via CDP using `ChromeForMCP`)
- `scripts/run-cdp-profile-screen.bat` (CDP + visual-first; screenshots by default)

### Interactive mode
Run any `.bat` without arguments:
```bash
scripts\run-dom-headless.bat
```

### One-shot (non-interactive) mode + logging
Pass a prompt and Gemini will run once and exit. Output is saved to a log file:
```bash
scripts\run-dom-headless.bat -p "Use MCP server playwrightBrowser. Launch browser. Go to https://example.com. Take a snapshot and close."
```

Optional: specify an output file:
```bash
scripts\run-dom-headless.bat -p "Go to https://example.com and take a snapshot." --output logs\\example.log
```

Notes:
- If your prompt contains spaces, wrap it in quotes.
- Logs are saved under `logs/` by default.
- The launchers now force the working directory to the repo root, so MCP config is always found even if you run the `.bat` from `scripts/`.
- Prompt parsing is robust to parentheses and other special characters.
- There is also a `scripts/.gemini/settings.json` copy to ensure MCP loads even if Gemini’s workspace root is `scripts/`.
- `scripts/GEMINI.md` provides fallback instructions if Gemini starts with the `scripts/` workspace.
- `run-chrome-profile.bat` now prefers a real Chrome executable when found (and falls back to the Playwright `chrome` channel).
- `run-chrome-profile.bat` uses a dedicated user data dir (`%LOCALAPPDATA%\ChromeForMCP`) so it doesn’t clash with your normal Chrome session.
- Use `--kill-chrome` only if you intentionally set the default Chrome “User Data” directory.
- If Gmail blocks sign-in, use the CDP profile with the dedicated data dir (`run-cdp-profile.bat`) and log in once.
- `run-cdp-profile.bat` now force-closes any Chrome processes that are using `ChromeForMCP` before launching, so the headful window always appears.

### Environment Defaults
The MCP server reads these environment variables as defaults if tool args are not provided.
For resilience, the launchers also set `GEMINI_CLI_MCP_*` equivalents (e.g., `GEMINI_CLI_MCP_USER_DATA_DIR`) which are always passed through Gemini’s environment sanitization.
- `MCP_HEADLESS` (true/false)
- `MCP_SLOWMO_MS` (number)
- `MCP_ARGS` (semicolon or comma-separated list, or JSON array)
- `MCP_STEALTH` (true/false)
- `MCP_CHANNEL` (e.g., `chrome`)
- `MCP_EXECUTABLE_PATH` (absolute path to chrome.exe)
- `MCP_USER_DATA_DIR`
- `MCP_PROFILE` (profile directory, e.g., `Default` or `Profile 3`)
- `MCP_CDP_ENDPOINT` (optional, e.g., `http://127.0.0.1:9222`)
- `MCP_CDP_PORT` (number, default 9222)
- `MCP_CDP_WAIT_MS` (number)
- `MCP_CDP_AUTO_CLOSE` (true/false)
- `MCP_CHROME_PATH` (absolute path to chrome.exe)
- `MCP_FORCE_CDP` (true/false) — disables `browser.launch` when using CDP profile
- `MCP_REQUIRE_PROFILE` (true/false) — require `userDataDir` for `browser.launch` (prevents accidental Chromium sessions)

Notes:
- If `userDataDir` points to `...\Profile X` or `...\Default`, the server normalizes it to the parent directory and sets `profileDirectory` automatically.
- Chrome 136+ blocks automation on the default “User Data” directory. Use a dedicated data dir like `ChromeForMCP` or CDP.

### Profile Instructions
The `.bat` scripts set `GEMINI_SYSTEM_MD` to profile-specific instructions:
- DOM profiles use `profiles/dom/system.md`
- Visual profiles use `profiles/visual/system.md`
- CDP profiles use `profiles/cdp/system.md`

In one-shot mode, the scripts swap to `profiles/*/oneshot.md` to ensure the browser is closed at the end.

### Script Creation Guardrails
Gemini should not create custom `.js/.cjs` automation scripts in this repo. The profile instructions now explicitly forbid it.
They also forbid creating or modifying files under `scripts/` or `src/` and require stopping if MCP tools are unavailable.
If you ever see unexpected `.cjs` files in `scripts/`, delete them.
The repo `.gitignore` also ignores `*.cjs` to prevent accidental commits.

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
- Use a real browser profile via `userDataDir` in `browser.launch` to reuse cookies. Chrome 136+ blocks automation on the default “User Data” directory; use a dedicated data dir (e.g., `ChromeForMCP`) or CDP.
  - Try a different network/IP.

Example for a persistent profile:
```json
{
  "tool": "browser.launch",
  "args": {
    "headless": false,
    "userDataDir": "C:/Users/User/AppData/Local/ChromeForMCP",
    "profileDirectory": "Default",
    "channel": "chrome",
    "args": ["--disable-blink-features=AutomationControlled"],
    "stealth": true
  }
}
```

If you want to auto-launch Chrome with CDP and connect in one step:
```json
{
  "tool": "browser.launch_chrome_cdp",
  "args": {
    "userDataDir": "C:/Users/User/AppData/Local/ChromeForMCP",
    "profileDirectory": "Default",
    "port": 9222,
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
- `browser.launch_chrome_cdp`: Launch Chrome with remote debugging and connect automatically.
- `browser.get_scroll_state`: Read window scroll metrics to decide if more content exists.
- `browser.scroll_by`: Scroll the main page by a delta.
- `browser.scroll_to`: Scroll the main page to an absolute position.
- `browser.get_scrollables`: List scrollable containers on the page.
- `browser.get_container_scroll_state`: Read scroll metrics for a container selector.
- `browser.scroll_container`: Scroll a specific container by selector.
- `browser.goto`: Navigate to a URL.
- `browser.list`: List clickable elements.
- `browser.click`: Click by elementId, selector, or text.
- `browser.snapshot`: Get page summary text and links.
- `browser.visual_snapshot`: Save a screenshot and return element bounding boxes for visual navigation.
- `jobs.extract_indeed`: Extract job cards and optionally save to txt.
- `jobs.indeed_next_page`: Click Indeed “Next” pagination.
- `search.google`: Open Google search and extract results.
- `search.extract_google`: Extract results from current Google search page.
- `files.write_text`: Save arbitrary text.

## Output
- Indeed results: `output/indeed/.../*.txt`
- Google results: `output/google/*.txt`

Each `.txt` file is named after the job/result title and contains key fields (title, company, location, salary, URL, snippet).

## Visual (Image) Mode
If you want Gemini to “look at” the page instead of DOM-only extraction, use:

```
Use MCP server playwrightBrowser.
Launch browser (headless false, stealth true).
Go to https://uniquetechsolution.uk/
Run browser.visual_snapshot and save to output/screenshots/uniquetech.png with a map at output/screenshots/uniquetech.json.
Analyze the screenshot and click the elementId that looks like “Contact”.
```

Gemini can then use:
- `browser.visual_snapshot` for screenshot + element map (with bounding boxes).
- `browser.click` by `elementId` (from the returned map).
- `browser.click_at` by coordinates if needed.
