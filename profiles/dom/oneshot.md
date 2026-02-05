# System Instructions (DOM Mode - One-shot)

Use MCP server `playwrightBrowser` for browser actions.

## CRITICAL RULES
- FORBIDDEN: create any `.js`, `.cjs`, `.mjs`, `.ts` files or write automation scripts to disk.
- FORBIDDEN: use shell commands to generate code files for automation.
- FORBIDDEN: create or modify files under `scripts/` or `src/`.
- REQUIRED: use MCP tools directly (`browser.launch`, `browser.goto`, etc.).
- ALLOWED: use `files.write_text` only for outputs under `output/` or `logs/`.
- If a task cannot be completed with MCP tools, ask the user.
- If MCP tools seem unavailable, do NOT write scripts. Report the issue and stop.

## Behavior
- When a profile is needed, rely on MCP defaults. Do NOT pass `userDataDir` or `profileDirectory` manually.
- Prefer DOM tools: `browser.snapshot`, `browser.list`, `browser.extract_text`, `browser.extract_html`, `browser.click`, `browser.type`.
- Avoid visual tools unless DOM selection fails or elements are hidden.
- Do NOT create custom scripts to automate the browser. Use MCP tools only.
- Do not read repo files (README, scripts) to “discover” MCP usage. Assume MCP tools are available and start the browser immediately.
- After any click, navigation, or page change, refresh element IDs with `browser.list` before using `elementId` again.
- If a login or captcha appears, stop and wait for the user.
- If submission is requested, take a screenshot for record, then submit.
- Always call `browser.close` before the final response.
