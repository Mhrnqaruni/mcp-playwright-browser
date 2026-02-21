# Gemini Project Instructions (Auto)

## Always Use MCP Server
Use MCP server `playwrightBrowser` for all browser actions.

## Reading CV / Job Files
- Prefer MCP file tools (avoid built-in `ReadFile`/`Shell` because workspace restrictions can fail unexpectedly):
  - Use `files.list_dir` to locate CV/cover letter/jobdescription under `Applied Jobs/<job-folder>/`.
  - Use `files.read_text` for `*.md/*.txt`.
  - Use `files.read_pdf_text` for `*.pdf`.
  - If the needed info is missing/unreadable: ask the user (do not hunt/scan across folders).

## DOM vs Visual
- Prefer DOM actions first.
- Set capture profile at start of work:
  - Call `browser.set_capture_profile` with `profile: "light"` unless the user asks for debug-level detail.
- Follow this capture ladder (least expensive first):
  1) `browser.snapshot` with `detail: "low"`
  2) `browser.list` with `detail: "low"`
  3) `browser.query_dom` with `detail: "low"` for targeted reads
  4) `browser.take_snapshot` with `detail: "low"` only when `uid` targeting is needed
  5) `browser.visual_snapshot` with `detail: "low"` only as last resort
- Use `detail: "high"` only when low detail is insufficient.
- Do not repeat `browser.take_snapshot` / `browser.visual_snapshot` unless one of these is true:
  - `domVersion` changed
  - you intentionally scrolled and need a fresh scan of newly visible content
  - MCP returned `STALE_REF`
  - target cannot be found after `browser.wait_for`
  - user explicitly asked for a fresh visual check
- If `browser.list` reports `needsScrollForMore: true` or `hasOffViewportCandidates: true`, scroll and run `browser.list` again before concluding the page is complete.

## Element IDs (Critical)
- `elementId`s are short-lived. After any click, dropdown, or navigation:
  - call `browser.list` (or `browser.visual_snapshot`) again
  - do not reuse old element IDs
- Waiting: use `browser.wait_for` (selector/text/uid) instead of fixed sleeps.

## Multi-Tab / Popups
- Popup tools do not auto-select new tabs by default.
- If a popup/new tab opens, always use:
  - `browser.list_pages`
  - `browser.select_page`
  - `browser.close_page`

## Generic Forms (LinkedIn/ATS)
- Prefer `browser.form_audit` to find missing required fields.
- Use `browser.fill_form` (label/selector-driven) to fill, then re-run `browser.form_audit`.

## Google Forms (Recommended)
- Prefer `forms.google_*` tools for deterministic, idempotent filling:
  - `forms.google_set_text`
  - `forms.google_set_dropdown`
  - `forms.google_set_radio` (including linear scales like 1-5)
  - `forms.google_set_checkbox`
  - `forms.google_set_grid`
- Always finish with `forms.google_audit` and ensure `unansweredCount` is `0`.
- If `unansweredCount > 0`, fill the missing questions and re-run `forms.google_audit`.

## Safety
- If login/captcha/2FA appears: stop and wait for the user.
- Before submitting any form: take a screenshot and ask for confirmation.
- Do not "research" the user (e.g., opening their LinkedIn profile) unless explicitly asked.
- Writing files: screenshots/maps/logs must be saved under `Auto/output` or `Auto/logs`.

## Application Answer Policy (Maximize Hiring Chances)
- If a question is about willingness/comfort (hybrid/on-site/commute/relocation/travel/learning/new tools): answer **YES / comfortable / open** by default.
- Only answer **NO** if the user explicitly told you so.
- For factual eligibility (citizenship, work authorization, sponsorship need, degrees, dates, years of experience): answer from provided data; ask if unknown.

## Real Chrome Sessions
- For logged-in flows, prefer `browser.launch_chrome_cdp` (CDP-connected Chrome profile), or `browser.launch` with `channel: "chrome"` + `userDataDir`.

## Profile Instructions
- This repo uses `GEMINI_SYSTEM_MD` to switch between DOM/Visual/CDP behaviors when using the `.bat` launchers in `scripts/`.
