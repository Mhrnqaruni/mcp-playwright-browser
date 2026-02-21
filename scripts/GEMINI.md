# Gemini Instructions (scripts workspace)

- Always use MCP server `playwrightBrowser` for browser actions.
- Do not read README or script files to "discover" MCP usage. Start the browser immediately.
- Never create `.js/.cjs/.mjs/.ts` files. Use MCP tools only.
- Prefer MCP file tools over built-ins:
  - Use `files.list_dir` to locate CV/cover letter/jobdescription under `Applied Jobs/<job-folder>/`.
  - Use `files.read_text` for `*.md/*.txt`.
  - Use `files.read_pdf_text` for `*.pdf` (do NOT try to read PDF with `files.read_text`).
  - If the needed info is missing/unreadable: ask the user. Do NOT hunt across the filesystem with built-in `ReadFile`/`Shell`.
- Set capture profile to `light` at the start of each task (`browser.set_capture_profile`).
- Use this capture ladder (smallest output first):
  1) `browser.snapshot` with `detail: "low"`
  2) `browser.list` with `detail: "low"`
  3) `browser.query_dom` with `detail: "low"` for specific reads
  4) `browser.take_snapshot` with `detail: "low"` only for `uid` workflows
  5) `browser.visual_snapshot` with `detail: "low"` only when DOM mapping is ambiguous
- Use `detail: "high"` only when `low` cannot complete the task.
- Do not repeat `take_snapshot`/`visual_snapshot` unless:
  - `domVersion` changed
  - you intentionally scrolled and need a fresh scan of newly visible content
  - MCP returned a stale reference error
  - target still cannot be found after `browser.wait_for`
  - user explicitly asks for re-verification
- If `browser.list` reports `needsScrollForMore: true` or `hasOffViewportCandidates: true`, scroll and run `browser.list` again before deciding the page is done.
- Popup tools do not auto-select by default. After popup/new-tab events, run `browser.list_pages` and then `browser.select_page` explicitly.
- Waiting: use `browser.wait_for` (selector/text/uid) instead of fixed sleeps.
- For generic forms (LinkedIn/ATS), prefer `browser.form_audit` then `browser.fill_form`, then re-audit.
- For Google Forms, prefer `forms.google_*` tools and verify completion with `forms.google_audit`.
- For visual workflows:
  - `browser.visual_snapshot` returns `coordSpace` for bboxes.
  - If `coordSpace` is `page`, click with `browser.click_at_page`. If `viewport`, use `browser.click_at`.
- Do not "research" the user (e.g., opening their LinkedIn profile) unless explicitly asked.
- Application answers: default to **YES / open / comfortable** for willingness/comfort questions; only say **NO** if the user explicitly told you so. For factual eligibility, ask if unknown.
