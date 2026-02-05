# Gemini Project Instructions (Auto)

## Always use MCP server
Use MCP server `playwrightBrowser` for all browser actions.

## DOM vs Visual
- Prefer DOM actions first.
- If DOM selectors fail or fields are hard to map, use `browser.visual_snapshot` and click by `elementId` or `browser.click_at`.

## Element IDs (critical)
- `elementId`s are short-lived. After any click, dropdown, or navigation:
  - call `browser.list` (or `browser.visual_snapshot`) again
  - do not reuse old element IDs

## Google Forms rules
- Dropdowns: click listbox, then use keyboard (`ArrowDown`, `Enter`).
- Avoid `<tr>` or table selectors. Use:
  - `//div[contains(@class,'Qr7Oae') and .//span[contains(text(),'Question')]]`
  - then select by `@data-value` or `aria-label`.
- If a click fails due to overlay, retry with `browser.click` on parent listbox or use `browser.click_at`.

## Safety
- If login/captcha appears: stop and wait for user.
- Before submitting any form: take a screenshot and ask for confirmation.

## Real Chrome sessions
- For logged-in flows, prefer `browser.launch` with `channel: "chrome"` + `userDataDir`,
  or `browser.launch_chrome_cdp` for a CDP-connected Chrome profile.

## Profile Instructions
- This repo uses `GEMINI_SYSTEM_MD` to switch between DOM/Visual/CDP behaviors when using the `.bat` launchers in `scripts/`.
