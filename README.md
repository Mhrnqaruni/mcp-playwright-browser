# MCP Playwright Browser Server

A production-grade **Model Context Protocol (MCP) server** that gives AI assistants full browser control through Playwright — using a hybrid DOM + Accessibility Tree + Visual approach. Built for real-world agentic automation: job applications, web scraping, form filling, and complex multi-tab workflows.

> **v2.0 is a complete rewrite.** The server grew from 680 lines and 23 tools to nearly 5,000 lines and 71 tools, with a modular architecture, token-optimized capture profiles, hard payload budgets, and a full test suite.

---

## Table of Contents

- [What's New in v2.0](#whats-new-in-v20)
- [v1 vs v2 Comparison](#v1-vs-v2-comparison)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Profile Launchers](#profile-launchers)
- [All 71 MCP Tools](#all-71-mcp-tools)
- [Architecture](#architecture)
- [Token Efficiency: Capture Profiles](#token-efficiency-capture-profiles)
- [Common Use Cases](#common-use-cases)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security & Privacy](#security--privacy)
- [Ethical Use](#ethical-use)
- [License](#license)

---

## What's New in v2.0

### The Problem v1 Had

v1 was a working proof of concept. It could browse pages and extract jobs. But when used with Gemini CLI for real tasks — filling application forms, navigating multi-tab flows, handling downloads — it hit hard limits:

- **Token waste**: Every tool response dumped everything it found. One `browser.snapshot` on a complex page could push 50KB+ into Gemini's context window in a single call, rapidly exhausting the budget.
- **No multi-tab support**: If a link opened a new tab (very common in job applications), Gemini was stuck with no way to switch to it.
- **No form intelligence**: Filling a form required manual click-by-click instructions. There was no way to ask "what fields are still empty?" or "fill all required fields."
- **Brittle DOM-only navigation**: Shadow DOM, iframes, and obfuscated element IDs caused failures with no fallback.
- **No session persistence**: Every run started fresh. Logging in again and again wasted time and triggered bot detection.
- **No safety rails**: The AI could write files anywhere on disk, run arbitrary JS, or create its own automation scripts — unguarded.
- **Monolithic**: One 680-line file with no tests.

### What v2.0 Solves

Every one of those problems has a specific solution in v2.0:

| Problem | v2.0 Solution |
|---------|--------------|
| Token waste | Capture Profile System (light/balanced/full) + 280KB hard payload ceiling |
| Multi-tab stuck | Page Manager with stable pageIds, `browser.list_pages`, `browser.select_page` |
| Dumb form filling | `browser.form_audit` + `browser.fill_form` + Google Forms specialist tools |
| Shadow DOM / obfuscated IDs | A11y tree via CDP `Accessibility.getFullAXTree` with stable `ax-` UIDs |
| Session loss | Cookie export/import, `browser.export_storage_state` / `browser.import_storage_state` |
| No safety | Path allowlist in `src/security/paths.js`, `MCP_ALLOW_EVALUATE` guard |
| Monolithic | 10 focused modules in `src/browser/` + `src/security/` + 18-test suite |

---

## v1 vs v2 Comparison

| Dimension | v1.0 | v2.0 |
|-----------|------|------|
| **Total MCP tools** | 23 | **71** |
| **Server size** | 680 lines, 1 file | 4,966 lines, 11 modules |
| **Token efficiency** | Uncontrolled dumps | Capture profiles + 280KB hard ceiling |
| **Multi-tab support** | Single tab only | Full page manager (list, select, close) |
| **Form automation** | Manual click-by-click | `form_audit` + `fill_form` + Google Forms specialist |
| **A11y / Shadow DOM** | DOM-only, brittle | CDP Accessibility tree with stable UIDs |
| **Scroll handling** | Saw first viewport only | Scroll awareness + container scrolling |
| **Session persistence** | None | Cookie/storage export-import |
| **Popup & dialog handling** | None | Dialog accept/dismiss, popup pageId capture |
| **Download management** | None | Wait-for-download, save to path |
| **File reading (CV/PDF)** | None | `files.read_text`, `files.read_pdf_text` |
| **Security** | No restrictions | Allowlist-enforced read/write paths |
| **Observability** | None | Console log capture, network request log |
| **Test coverage** | 2 tests | **18 tests** |
| **Profiles** | 3 | 5 (+ persistent variants) |
| **Batch scripts** | 5 `.bat` launchers | 7 `.bat` launchers |
| **Error handling** | Raw exceptions to AI | Normalized, structured, budgeted |

### What stayed the same
- Indeed job extractor (production-grade, multi-selector, deduplication)
- Google search extractor (consent handling, URL deobfuscation)
- Stealth mode (webdriver hiding, user agent spoofing)
- CDP connection to real Chrome
- Visual snapshot + coordinate-based clicking

---

## How It Works

```
You / Gemini CLI
      │
      │ natural language prompt
      ▼
  Gemini CLI ──── loads MCP config ────► playwrightBrowser MCP server
                                               │
                              ┌────────────────┤
                              │                │
                         71 MCP Tools     Payload Budget
                         (browser.*)     (280KB ceiling)
                         (forms.*)       (capture profiles)
                         (files.*)       (retryWith hints)
                         (jobs.*)
                         (search.*)
                              │
                    ┌─────────┤──────────┐
                    │         │          │
               Playwright  CDP API   Security
               (browser)  (A11y,    (path
                          network,  allowlist)
                          clicks)
                    │
               Chrome / Chromium
```

### The Capture Ladder

Every profile instructs Gemini to try tools in order, cheapest first:

```
1. browser.snapshot     → plain text summary       (cheapest, ~6KB in light mode)
2. browser.list         → interactive elements      (structured, ~8KB)
3. browser.query_dom    → targeted selector query   (focused, ~10KB)
4. browser.take_snapshot→ A11y tree with UIDs       (rich, only when uid-clicking needed)
5. browser.visual_snapshot → screenshot + bbox map  (most expensive, last resort)
```

Gemini only escalates to a more expensive tool when the cheaper one doesn't have what it needs. This is the core of why v2.0 uses far fewer tokens than v1.0.

### The Payload Budget

Every single tool response passes through `enforcePayloadCeiling()` before being sent to Gemini:

1. Measure response size in bytes
2. If under 280KB → send as-is
3. If over → progressively truncate: arrays shrink, strings truncate, fields drop
4. Always include `retryWith` hints telling Gemini exactly what parameters to reduce next time
5. Absolute floor: `{truncated: true}` — Gemini never gets a context-crashing response

---

## Quick Start

```bash
# Clone
git clone https://github.com/Mhrnqaruni/mcp-playwright-browser.git
cd mcp-playwright-browser

# Install
npm install
npx playwright install chromium

# Run (interactive mode - chat with Gemini)
scripts\run-dom-headless.bat

# Run (one-shot automation)
scripts\run-dom-headless.bat -p "Go to https://example.com and extract the page title"

# Run with real Chrome (for logged-in sessions)
scripts\run-chrome-profile.bat --kill-chrome
```

---

## Installation

### Prerequisites

- **Node.js 18+**
- **npm**
- **Gemini CLI**: `npm install -g @google/gemini-cli` then `gemini auth login`
- **Google Chrome** (for CDP and chrome-profile modes)

### Setup

**1. Install dependencies**
```bash
npm install
npx playwright install chromium
```

**2. Configure the MCP server path**

Edit `.gemini/settings.json` and set `cwd` to your repo location:
```json
{
  "mcpServers": {
    "playwrightBrowser": {
      "command": "node",
      "args": ["src/mcp-browser-server.js"],
      "cwd": "C:/path/to/mcp-playwright-browser"
    }
  }
}
```

**3. (Optional) Disable Chrome background apps**

Prevents profile locking:
```
Chrome Settings → Advanced → System →
☐ Continue running background apps when Google Chrome is closed
```

**4. Verify**
```bash
scripts\run-dom-headless.bat -p "Use MCP server playwrightBrowser. Launch browser. Go to https://example.com. Take a snapshot. Close."
```

---

## Profile Launchers

Each `.bat` file pre-configures everything (browser type, stealth, profile, environment variables) and starts Gemini with the right system instructions. You never need to configure Gemini manually.

### Available Profiles

| Script | Browser | Mode | Best For |
|--------|---------|------|----------|
| `run-dom-headless.bat` | Chromium | Headless | ⚡ Bulk scraping, fastest |
| `run-visual-headful.bat` | Chromium | Visible + Screenshots | Debugging, visual verification |
| `run-chrome-profile.bat` | Real Chrome | Your profile | Logged-in sessions, form filling |
| `run-cdp-profile.bat` | Real Chrome | CDP | Maximum stealth |
| `run-cdp-profile-screen.bat` | Real Chrome | CDP + Visual | CDP with screenshot analysis |
| `run-cdp-profile-persist.bat` | Real Chrome | CDP + Persistent | Long sessions, multi-step flows |
| `run-cdp-profile-screen-persist.bat` | Real Chrome | CDP + Visual + Persistent | Full power mode |

### Interactive Mode (Chat)

```bash
# Start Gemini and chat with it
scripts\run-chrome-profile.bat --kill-chrome

# Then just type:
# "Fill out the job application at [URL] using my CV"
# "Go to LinkedIn and apply to the first 5 jobs"
# "Extract all AI engineer jobs from Indeed and save them"
```

### One-Shot Mode (Automation)

```bash
# Run a task and get a log file
scripts\run-dom-headless.bat -p "Your full task here"

# With custom output
scripts\run-dom-headless.bat -p "Extract 50 jobs from Indeed" --output logs\jobs.log

# Chrome profile one-shot
scripts\run-chrome-profile.bat --kill-chrome -p "Submit application at [URL]" --output logs\apply.log
```

Logs are auto-saved to `logs/` with timestamps.

### Profile Details

#### `run-dom-headless.bat` — Fastest
- Chromium headless (no GUI)
- Best for: bulk extraction, scraping, background tasks
- Token usage: lowest (no screenshots)

#### `run-visual-headful.bat` — Debugging
- Chromium with visible window
- Screenshot-based navigation available
- Best for: troubleshooting, visual verification

#### `run-chrome-profile.bat` — Authenticated Sessions
- Real Chrome with your existing logged-in profile
- Already signed into Gmail, LinkedIn, job sites
- Use `--kill-chrome` to free profile before starting
- Best for: job applications, authenticated scraping

#### `run-cdp-profile.bat` — Maximum Stealth
- Connects to real Chrome via Chrome DevTools Protocol
- Hardest for sites to detect as automation
- Best for: sites that block Playwright/Chromium
- Auto-closes any existing Chrome using the profile before launch

#### `run-cdp-profile-persist.bat` — Long Sessions
- CDP mode with persistent browser (doesn't close between tasks)
- Best for: multi-step workflows where browser state must survive

---

## All 71 MCP Tools

### Capture Profile Control
| Tool | Description |
|------|-------------|
| `browser.set_capture_profile` | Set `light` / `balanced` / `full` profile. Controls token usage across all tools. Call this first. |
| `browser.get_capture_profile` | Show current profile settings and payload budget. |

### Browser Lifecycle
| Tool | Description |
|------|-------------|
| `browser.launch` | Launch Chromium with options: headless, stealth, userDataDir, profileDirectory, channel, slowMo, args |
| `browser.launch_chrome_cdp` | Launch real Chrome with remote debugging + connect in one step |
| `browser.connect_cdp` | Connect to existing Chrome with `--remote-debugging-port` |
| `browser.close` | Close browser session |
| `browser.reload` | Reload current page |

### Multi-Tab Management
| Tool | Description |
|------|-------------|
| `browser.new_page` | Open new tab, tracked by page manager |
| `browser.list_pages` | List all open tabs with pageId, url, title, active/closed state |
| `browser.select_page` | Switch active tab by pageId |
| `browser.close_page` | Close a specific tab by pageId |
| `browser.list_frames` | List all iframes on the current page |

### Navigation
| Tool | Description |
|------|-------------|
| `browser.goto` | Navigate to URL with configurable waitUntil and timeout |
| `browser.back` | Go back in history |
| `browser.forward` | Go forward in history |
| `browser.wait` | Wait for selector or fixed ms |
| `browser.wait_for` | Smart wait: selector, text, or uid (A11y) |

### Event & Dialog Handling
| Tool | Description |
|------|-------------|
| `browser.list_dialogs` | List pending JS dialogs (alert, confirm, prompt) |
| `browser.handle_dialog` | Accept or dismiss a dialog, optionally with input text |
| `browser.wait_for_download` | Block until a download starts, returns downloadId |
| `browser.save_download` | Save a captured download to a specific path |
| `browser.wait_for_popup` | Wait for a new tab/popup to open, returns its pageId |
| `browser.expect_event` | Listen for a one-time event: dialog, download, navigation, request, response |

### Session & Cookie Management
| Tool | Description |
|------|-------------|
| `browser.get_cookies` | List cookies, optionally filtered by URL |
| `browser.set_cookies` | Inject cookies into browser session |
| `browser.clear_cookies` | Clear all or URL-specific cookies |
| `browser.export_storage_state` | Export full session state (cookies + localStorage) to JSON file |
| `browser.import_storage_state` | Restore session from previously exported JSON |

### Scroll Control
| Tool | Description |
|------|-------------|
| `browser.get_scroll_state` | Returns scrollY, scrollHeight, atTop, atBottom, viewport info |
| `browser.scroll_by` | Scroll page by delta pixels (vertical + horizontal) |
| `browser.scroll_to` | Scroll to absolute position |
| `browser.get_scrollables` | Detect all scrollable containers on the page |
| `browser.get_container_scroll_state` | Scroll metrics for a specific container selector |
| `browser.scroll_container` | Scroll a specific container by selector |

### Page Reading & Snapshots
| Tool | Description |
|------|-------------|
| `browser.snapshot` | Plain text page summary: title, text, links, optional headings + forms summary |
| `browser.take_snapshot` | A11y tree via CDP: roles, names, UIDs (`ax-{nodeId}`), depth, state |
| `browser.query_dom` | Flexible selector query: text, value, bbox, visibility, state, tagName |
| `browser.evaluate` | Execute JavaScript (requires `MCP_ALLOW_EVALUATE=true`, origin-gated) |

### Element Interaction
| Tool | Description |
|------|-------------|
| `browser.list` | List visible interactive elements with elementId, tag, text, href |
| `browser.click` | Click by elementId, uid, selector, or text |
| `browser.hover` | Hover over element (triggers dropdown menus, tooltips) |
| `browser.type` | Simulate keypress-by-keypress typing |
| `browser.fill` | Direct value fill (faster, no keypress simulation) |
| `browser.press` | Press keyboard key (Enter, Tab, Escape, etc.) |
| `browser.set_input_files` | Upload file to input[type=file] |
| `browser.scroll_to_uid` | Scroll a UID element into view |

### Visual Navigation
| Tool | Description |
|------|-------------|
| `browser.screenshot` | Save screenshot to path |
| `browser.visual_snapshot` | Screenshot + element map with bounding boxes and IDs |
| `browser.click_at` | Click at viewport-relative X/Y coordinates |
| `browser.click_at_page` | Click at document-absolute X/Y coordinates |

### Data Extraction
| Tool | Description |
|------|-------------|
| `browser.extract_text` | Extract text from CSS selector (single or all matches) |
| `browser.extract_html` | Extract outerHTML from selector |

### Form Automation
| Tool | Description |
|------|-------------|
| `browser.form_audit` | Scan page for all unfilled required fields: text, select, radio, checkbox, contenteditable |
| `browser.fill_form` | Fill a list of `{label, selector, value, kind}` fields — label-driven or selector-driven |
| `forms.google_audit` | Google Forms specialist: list all questions and check `aria-checked` for answers |
| `forms.google_set_text` | Fill a Google Forms text question by question text |
| `forms.google_set_dropdown` | Select option in Google Forms dropdown |
| `forms.google_set_checkbox` | Check/uncheck Google Forms checkbox |
| `forms.google_set_radio` | Select option in Google Forms radio group |
| `forms.google_set_grid` | Select option in Google Forms grid question |

### Observability
| Tool | Description |
|------|-------------|
| `browser.list_console_messages` | Show captured `console.log/warn/error` from the page |
| `browser.list_network_requests` | Show all network requests (URL, method, status, timing) |
| `browser.get_network_request` | Get full details for a specific request by ID |

### File Operations
| Tool | Description |
|------|-------------|
| `files.read_text` | Read text file (restricted to allowed paths) |
| `files.read_pdf_text` | Extract text from PDF — used to read CV files |
| `files.list_dir` | List directory contents |
| `files.write_text` | Write text to file (restricted to `output/` and `logs/`) |

### Specialized Extractors (Production Examples)
| Tool | Description |
|------|-------------|
| `jobs.extract_indeed` | Extract Indeed job listings with multi-selector fallbacks, deduplication, access detection |
| `jobs.indeed_next_page` | Navigate to next Indeed page (direct URL, click, or auto mode) |
| `search.google` | Open Google search and extract results with consent handling |
| `search.extract_google` | Extract results from current Google search page |

---

## Architecture

### Module Structure

```
src/
├── mcp-browser-server.js      # Main server: tool registration, env config, middleware
├── extractors.js              # Indeed + Google specialized extractors
├── browser/
│   ├── pages.js               # Multi-tab page manager (stable pageIds)
│   ├── snapshot.js            # A11y tree via CDP Accessibility.getFullAXTree
│   ├── capture-profiles.js    # light/balanced/full × low/high = 30 preset configs
│   ├── payload-budget.js      # Hard 280KB response ceiling with graceful truncation
│   ├── cdp.js                 # CDP session, click/hover/scroll by backendNodeId
│   ├── dom-version.js         # DOM mutation tracking, frame management
│   ├── forms.js               # Form audit + intelligent form fill
│   ├── observability.js       # Console + network request capture via CDP
│   └── wait.js                # Smart wait: selector, text, uid
└── security/
    └── paths.js               # Read/write path allowlist enforcement
```

### Tool Registration Middleware

Every tool goes through a wrapper that runs before and after the handler:

```
AI calls tool
      │
      ▼
assign requestId
      │
      ▼
run handler
      │
      ▼
normalize errors (structured, no stack traces)
      │
      ▼
add envelope (ok, requestId, timestamp, url, domVersion)
      │
      ▼
enforcePayloadCeiling (truncate if > 280KB)
      │
      ▼
send to AI
```

This means every tool automatically benefits from error safety and payload budgeting without any extra code per tool.

### UID System

The A11y snapshot (`browser.take_snapshot`) assigns every node a stable UID in the format `ax-{nodeId}`, tied to the CDP `backendDOMNodeId`. This UID can then be used with:
- `browser.click({ uid: "ax-123" })` — clicks via CDP directly on the backend node
- `browser.scroll_to_uid({ uid: "ax-123" })` — scrolls it into view first
- `browser.wait_for({ uid: "ax-123" })` — waits until it's visible

CDP-native clicks are more reliable than selector-based clicks because they bypass CSS selector resolution and work even in Shadow DOM.

---

## Token Efficiency: Capture Profiles

This is the most important v2.0 feature for real-world use.

### The Problem

AI context windows are finite. Every tool response consumes tokens. A naive implementation that dumps everything on every call quickly exhausts the budget.

### The Solution: Three Profiles

Set the profile once at session start, and every subsequent tool call automatically uses appropriate limits:

```
browser.set_capture_profile({ profile: "light" })
```

| Profile | Snapshot chars | List items | A11y nodes | Best For |
|---------|---------------|------------|------------|----------|
| **light** | 6,000–9,000 | 120–180 | 220–320 | Job scraping, bulk tasks |
| **balanced** | 12,000–16,000 | 240–320 | 440–700 | Form filling, research |
| **full** | 20,000 | 500 | 1,200–2,000 | Deep debugging only |

### Two Detail Levels Per Profile

Within each profile, tools accept `detail: "low"` or `detail: "high"`:

```
browser.snapshot({ detail: "low" })   # minimal, fast
browser.snapshot({ detail: "high" })  # more text, links, headings, form summary
```

### The Capture Ladder in Practice

The profile system instructions teach Gemini to escalate only when needed:

```
✅ "I need to find the Apply button"
→ browser.snapshot (low)           # did I find it in plain text? usually yes
→ browser.list (low)               # still looking? check interactive elements
→ browser.take_snapshot (low)      # need uid for reliable click? A11y tree
→ browser.visual_snapshot (low)    # shadow DOM / can't find it at all? visual fallback
```

In `light` mode, this entire ladder costs roughly 8x fewer tokens than v1.0's single dump approach.

### Hard Payload Budget

Even with capture profiles, some pages are just huge. The payload budget is a safety net:

- Default ceiling: **280KB per response**
- If exceeded: truncate progressively (arrays → strings → object keys)
- Include `retryWith` field: `{ detail: "low", maxItems: 80, limit: 20 }`
- Gemini reads this and retries with smaller parameters
- Absolute fallback: `{ truncated: true, truncationReason: "..." }`

The budget is configurable: `MCP_MAX_RESPONSE_BYTES=150000` for tighter contexts.

---

## Common Use Cases

### Job Application (Chrome Profile)

```bash
# Start with your real logged-in Chrome
scripts\run-chrome-profile.bat --kill-chrome
```

In Gemini:
```
Set capture profile to light.
Go to [application URL].
Run form_audit to see all required fields.
Fill them using fill_form with my details from Applied Jobs/CODEX/maincv.md.
Before submitting, take a screenshot and ask me to confirm.
```

### Bulk Job Scraping (Headless)

```bash
scripts\run-dom-headless.bat -p "Use playwrightBrowser. Launch browser headless. Go to https://ae.indeed.com/q-ai-engineer-l-dubai-jobs.html. Extract jobs with jobs.extract_indeed limit 20, save to output/indeed/page-1. Go to next page with jobs.indeed_next_page. Extract again, save to output/indeed/page-2. Close."
```

### Session Persistence (Login Once, Reuse)

```bash
# First time: login manually and export session
scripts\run-cdp-profile.bat
```
In Gemini:
```
Go to linkedin.com and wait for me to log in.
After I confirm logged in, run browser.export_storage_state to output/linkedin-session.json.
```

Next time:
```
Run browser.import_storage_state from output/linkedin-session.json.
Go to linkedin.com — should be logged in already.
```

### Google Form Automation

```bash
scripts\run-dom-headless.bat
```
In Gemini:
```
Go to [Google Form URL].
Run forms.google_audit to see all questions.
Fill each question using the appropriate forms.google_set_* tool.
Run forms.google_audit again to verify all answered.
Submit.
```

### PDF CV Reading

Gemini can read your CV directly without you pasting it:
```
Read my CV from Applied Jobs/CODEX/maincv.md using files.read_text.
Or read the PDF version: files.read_pdf_text from Applied Jobs/CODEX/CV.pdf.
Use that information to fill the job application form.
```

### Debugging with Visual Mode

```bash
scripts\run-visual-headful.bat
```
In Gemini:
```
Go to [URL].
Take a visual_snapshot and save to output/debug.png.
Tell me what you see and identify any unusual elements.
```

---

## Environment Variables

All variables have dual names for Gemini CLI compatibility. The launchers set both:

| Variable | Alias | Description |
|----------|-------|-------------|
| `MCP_HEADLESS` | `GEMINI_CLI_MCP_HEADLESS` | true/false — run without GUI |
| `MCP_STEALTH` | `GEMINI_CLI_MCP_STEALTH` | true/false — enable anti-detection |
| `MCP_CHANNEL` | `GEMINI_CLI_MCP_CHANNEL` | `chrome` — use real Chrome |
| `MCP_EXECUTABLE_PATH` | `GEMINI_CLI_MCP_EXECUTABLE_PATH` | Absolute path to chrome.exe |
| `MCP_USER_DATA_DIR` | `GEMINI_CLI_MCP_USER_DATA_DIR` | Chrome profile directory |
| `MCP_PROFILE` | `GEMINI_CLI_MCP_PROFILE` | Profile name: `Default`, `Profile 3` |
| `MCP_CDP_ENDPOINT` | `GEMINI_CLI_MCP_CDP_ENDPOINT` | CDP URL: `http://127.0.0.1:9222` |
| `MCP_CDP_PORT` | `GEMINI_CLI_MCP_CDP_PORT` | CDP port number (default 9222) |
| `MCP_CDP_AUTO_CLOSE` | `GEMINI_CLI_MCP_CDP_AUTO_CLOSE` | Close Chrome on server exit |
| `MCP_FORCE_CDP` | `GEMINI_CLI_MCP_FORCE_CDP` | Disable `browser.launch` (CDP-only mode) |
| `MCP_REQUIRE_PROFILE` | `GEMINI_CLI_MCP_REQUIRE_PROFILE` | Require userDataDir (prevent bare Chromium) |
| `MCP_ALLOW_EVALUATE` | `GEMINI_CLI_MCP_ALLOW_EVALUATE` | Enable `browser.evaluate` tool |
| `MCP_EVALUATE_ALLOW_ORIGINS` | `GEMINI_CLI_MCP_EVALUATE_ALLOW_ORIGINS` | Comma-separated allowed origins for evaluate |
| `MCP_CAPTURE_PROFILE` | `GEMINI_CLI_MCP_CAPTURE_PROFILE` | Default profile: `light`, `balanced`, `full` |
| `MCP_MAX_RESPONSE_BYTES` | `GEMINI_CLI_MCP_MAX_RESPONSE_BYTES` | Override 280KB payload ceiling |
| `MCP_SLOWMO_MS` | `GEMINI_CLI_MCP_SLOWMO_MS` | Slow down actions by N ms (debugging) |

**Why dual names?** Gemini CLI sanitizes environment variables and may strip `MCP_*` prefixed keys. The `GEMINI_CLI_MCP_*` variants bypass this filtering. The server reads both and uses whichever is set.

---

## Project Structure

```
mcp-playwright-browser/
│
├── src/
│   ├── mcp-browser-server.js        # Main server (71 tools, middleware, env config)
│   ├── extractors.js                # Indeed + Google production extractors
│   ├── browser/
│   │   ├── pages.js                 # Multi-tab page manager
│   │   ├── snapshot.js              # A11y tree (CDP Accessibility API)
│   │   ├── capture-profiles.js      # Token budget profiles (light/balanced/full)
│   │   ├── payload-budget.js        # Hard response size ceiling
│   │   ├── cdp.js                   # CDP primitives (click, hover, scroll by nodeId)
│   │   ├── dom-version.js           # DOM mutation tracking + frame management
│   │   ├── forms.js                 # Form audit + intelligent fill
│   │   ├── observability.js         # Console + network capture
│   │   └── wait.js                  # Smart wait (selector, text, uid)
│   ├── security/
│   │   └── paths.js                 # File read/write path allowlist
│   └── tests/
│       ├── page-manager-test.js
│       ├── security-paths-test.js
│       ├── snapshot-uid-test.js
│       ├── uid-click-fill-test.js
│       ├── elementid-no-stale-test.js
│       ├── wait-for-test.js
│       ├── form-audit-fill-test.js
│       ├── console-network-test.js
│       ├── visual-coords-test.js
│       ├── frame-domversion-test.js
│       ├── cdp-hover-test.js
│       ├── browser-events-test.js
│       ├── storage-state-test.js
│       ├── capture-profiles-test.js
│       ├── payload-budget-test.js
│       ├── google-form-test.js
│       ├── google-test.js
│       └── indeed-test.js
│
├── scripts/
│   ├── run-dom-headless.bat          # Fastest: headless Chromium
│   ├── run-visual-headful.bat        # Visual: Chromium + screenshots
│   ├── run-chrome-profile.bat        # Auth: real Chrome with your profile
│   ├── run-cdp-profile.bat           # Stealth: CDP mode
│   ├── run-cdp-profile-screen.bat    # Stealth + visual
│   ├── run-cdp-profile-persist.bat   # Stealth + persistent session
│   ├── run-cdp-profile-screen-persist.bat  # Full power
│   ├── autoconnect.js                # CDP auto-connect helper
│   └── .gemini/settings.json         # Fallback MCP config
│
├── profiles/
│   ├── dom/
│   │   ├── system.md                 # Gemini system instructions (DOM mode)
│   │   └── oneshot.md                # One-shot variant (closes browser at end)
│   ├── visual/
│   │   ├── system.md
│   │   └── oneshot.md
│   ├── cdp/
│   │   ├── system.md
│   │   ├── oneshot.md
│   │   └── persistent.md
│   └── cdp-visual/
│       ├── system.md
│       ├── oneshot.md
│       └── persistent.md
│
├── .gemini/settings.json             # Main MCP config (set your cwd here)
├── GEMINI.md                         # Project-level Gemini instructions
├── LICENSE                           # ISC License
└── README.md
```

### Running Tests

```bash
# All tests that don't need network
npm run test:local

# Live network tests (Indeed + Google)
npm run test:remote

# Everything
npm run test:all
```

---

## Troubleshooting

### "Chrome is already running" / Profile locked

```bash
# Use --kill-chrome
scripts\run-chrome-profile.bat --kill-chrome

# Or manually
taskkill /F /IM chrome.exe
```

Chrome 136+ blocks automation on the default User Data directory. Always use a dedicated profile or the `ChromeForMCP` data dir.

### "Gmail says browser is not safe"

You're connected via Chromium, not your real Chrome. Ensure:
1. Chrome is fully closed before starting (`--kill-chrome`)
2. The launch response shows `"persistent": true` and your profile path
3. If not, restart Gemini and verify `.bat` outputs `Using Chrome executable: ...`

### MCP tools not found in Gemini

- Run any `.bat` from any directory — they auto-fix `cwd`
- Verify `.gemini/settings.json` has the correct `cwd`
- The `scripts/.gemini/settings.json` is a fallback if Gemini starts in `scripts/`

### Responses truncated / `retryWith` hint

This is the payload budget working correctly. Gemini will read the `retryWith` hint and retry with lower parameters. If it keeps happening, switch to `light` profile:

```
browser.set_capture_profile({ profile: "light" })
```

### Slow performance

- Use `run-dom-headless.bat` for bulk operations (no GUI = 3-4x faster)
- Avoid `browser.extract_html` — it returns full HTML and wastes tokens
- Use `detail: "low"` on all tools unless you specifically need more

### Browser opens but ignores my profile

Check `.bat` output for:
```
Using Chrome executable: C:\Program Files\Google\Chrome\Application\chrome.exe
Using Chrome profile: Profile 3
```

If you see a different profile or "not found", edit the `.bat` and set `MCP_PROFILE` explicitly.

---

## Security & Privacy

### Path Restrictions

`browser.evaluate` (arbitrary JS execution) is **disabled by default**. Enable it only explicitly: `MCP_ALLOW_EVALUATE=true`

`files.read_text` and `files.write_text` are restricted to:
- **Read**: `Applied Jobs/`, `Auto/output/`, `Auto/logs/`
- **Write**: `Auto/output/`, `Auto/logs/`

Any attempt to read or write outside these paths throws immediately. Symlinks are resolved before checking (prevents traversal attacks).

### What Is Stored

| Data | Location | Git-ignored |
|------|----------|-------------|
| Execution logs | `logs/` | ✅ Yes |
| Extracted jobs/data | `output/` | ✅ Yes |
| Session state exports | `output/` | ✅ Yes |
| Gemini CLI state | `scripts/.gemini/state.json` | ✅ Yes |
| `.gemini/` config | root `.gemini/` | ✅ Yes |

### What Is Never Stored

- ❌ Passwords or credentials
- ❌ Credit card or payment information
- ❌ Browser history
- ❌ Personal documents outside the allowed paths

---

## Ethical Use

This tool is provided for:
- Learning browser automation and MCP development
- Testing your own web applications
- Automating tasks on sites you have permission to access
- Legitimate job searching and application workflows

**You are responsible for:**
- Respecting `robots.txt` and website Terms of Service
- Complying with data protection regulations (GDPR, CCPA, etc.)
- Rate-limiting your requests to avoid service disruption
- Not using this to bypass paywalls or access controls without authorization

The authors assume no liability for misuse. Use responsibly.

---

## How This Differs from Microsoft's Official `playwright-mcp`

Microsoft's [playwright-mcp](https://github.com/microsoft/playwright-mcp) focuses on **accessibility-tree based automation** for test development in structured environments.

| Feature | Microsoft `playwright-mcp` | This project |
|---------|---------------------------|-------------|
| Navigation | Accessibility tree | Hybrid: DOM + A11y + Visual |
| Philosophy | "Blind" automation (fast, structured) | Human-like automation (robust, adaptive) |
| Primary use case | QA testing, defined workflows | Open-web agents, scraping, complex UIs |
| Token efficiency | Not optimized | Capture profiles + hard payload budget |
| Session persistence | Basic | Cookie/storage export-import |
| Form intelligence | Manual | `form_audit` + `fill_form` + Google Forms specialist |
| Multi-tab | Basic | Full page manager with stable pageIds |
| Setup | Generic | Batteries included (stealth, profiles, launchers) |

**Use Microsoft's for:** CI/CD test automation, structured accessibility-driven workflows
**Use this for:** Autonomous agents operating on the open web, job application automation, anti-detection scraping

---

## Changelog

### v2.0.0 (Current)
- Complete architectural rewrite: monolithic → 11 modular files
- 71 MCP tools (was 23)
- Capture profile system (light/balanced/full) for token efficiency
- Hard 280KB payload budget with graceful truncation and `retryWith` hints
- Multi-tab page manager (list, select, close pages)
- A11y tree snapshots via CDP with stable `ax-` UIDs
- CDP-native click/hover/scroll by backendDOMNodeId (handles Shadow DOM)
- Form audit + intelligent fill + Google Forms specialist (6 tools)
- Session export/import (cookie + localStorage persistence)
- Popup, dialog, download event handling
- Scroll awareness: get state, scroll by delta, scroll containers
- Network + console observability via CDP
- File reading: text files + PDF extraction
- Security: path allowlist enforcement, evaluate guard
- 18-test suite (was 2)
- 7 profile launchers (was 5): added persist variants for CDP
- GEMINI_CLI_MCP_* dual env var support for Gemini sanitization

### v1.1.0
- Profile launcher system (.bat files)
- Chrome profile integration
- `--kill-chrome` flag
- One-shot mode with automatic logging
- GEMINI_CLI_MCP_* environment variable aliases
- `browser.visual_snapshot` and `browser.click_at`

### v1.0.0
- Initial release
- Basic MCP server with Playwright
- Indeed + Google extractors
- DOM and visual navigation

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Run `npm run test:local` to verify nothing breaks
4. Commit (`git commit -m 'Add your feature'`)
5. Push and open a Pull Request

---

## License

ISC License — see [LICENSE](LICENSE) file.

---

## Acknowledgments

- [Playwright](https://playwright.dev/) — browser automation backbone
- [Model Context Protocol](https://modelcontextprotocol.io/) — AI tool interface
- [Microsoft playwright-mcp](https://github.com/microsoft/playwright-mcp) — inspiration for the A11y approach

---

## Support

- **Issues**: [GitHub Issues](https://github.com/Mhrnqaruni/mcp-playwright-browser/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Mhrnqaruni/mcp-playwright-browser/discussions)
