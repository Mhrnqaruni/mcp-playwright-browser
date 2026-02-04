# MCP Playwright Browser Server

A powerful Model Context Protocol (MCP) server that exposes Playwright-powered browser automation tools to AI assistants. Enable your AI to navigate web pages, extract structured data, scrape job listings, and interact with web content programmatically.

## Features

- **Browser Automation**: Full browser control via Playwright (Chromium)
- **MCP Integration**: Expose 20+ tools via Model Context Protocol
- **Anti-Detection**: Stealth mode to bypass bot detection
- **Job Scraping**: Specialized extractors for Indeed job postings
- **Search Extraction**: Google search results extraction
- **CDP Support**: Connect to existing Chrome instances via Chrome DevTools Protocol
- **Flexible Modes**: Headless or headful browser operation
- **File Management**: Save extracted data to structured text files

## Installation

```bash
npm install
```

Install Playwright Chromium browser:

```bash
npx playwright install chromium
```

## Quick Start

### Running the MCP Server

```bash
npm start
```

### Running Standalone Tests

Test Indeed job extraction:
```bash
npm run test:indeed
```

Test Google search extraction:
```bash
npm run test:google
```

## MCP Configuration

Configure your MCP client to use this server. For Gemini CLI, add to your `settings.json`:

```json
{
  "mcpServers": {
    "playwrightBrowser": {
      "command": "node",
      "args": ["src/mcp-browser-server.js"],
      "cwd": "/path/to/this/repo"
    }
  }
}
```

Or use the CLI:
```bash
gemini mcp add playwrightBrowser node src/mcp-browser-server.js
```

## Available Tools

### Browser Control
- `browser.launch` - Launch Chromium with optional stealth mode
- `browser.connect_cdp` - Connect to existing Chrome instance
- `browser.goto` - Navigate to URL
- `browser.back` / `browser.forward` - Navigate history
- `browser.new_page` - Open new tab
- `browser.close` - Close browser session

### Element Interaction
- `browser.list` - List interactive elements
- `browser.click` - Click elements by ID, selector, or text
- `browser.type` - Type into input fields
- `browser.press` - Press keyboard keys

### Data Extraction
- `browser.snapshot` - Get page summary with text and links
- `browser.extract_text` - Extract text from selectors
- `browser.extract_html` - Extract HTML from selectors
- `browser.screenshot` - Capture screenshots

### Job Scraping
- `jobs.extract_indeed` - Extract Indeed job listings
- `jobs.indeed_next_page` - Navigate to next Indeed results page

### Search
- `search.google` - Search Google and extract results
- `search.extract_google` - Extract results from current Google page

### File Operations
- `files.write_text` - Save arbitrary text to files

## Usage Examples

### Example 1: Scrape Indeed Jobs

```javascript
// Launch browser
browser.launch({ headless: false })

// Navigate to Indeed search
browser.goto({ url: "https://ae.indeed.com/q-ai-engineer-l-dubai-jobs.html" })

// Extract and save jobs
jobs.extract_indeed({ limit: 20, saveDir: "output/indeed/page-1" })

// Go to next page
jobs.indeed_next_page()

// Extract more jobs
jobs.extract_indeed({ limit: 20, saveDir: "output/indeed/page-2" })
```

### Example 2: Google Search

```javascript
// Launch browser
browser.launch({ headless: true })

// Search and extract results
search.google({
  query: "remote ai jobs in usa",
  limit: 10,
  saveDir: "output/google"
})
```

### Example 3: Stealth Mode with User Profile

```javascript
// Launch with persistent profile to bypass captchas
browser.launch({
  headless: false,
  userDataDir: "C:/Users/User/AppData/Local/Google/Chrome/User Data",
  args: ["--disable-blink-features=AutomationControlled"],
  stealth: true
})
```

### Example 4: Connect to Existing Chrome

Start Chrome with remote debugging:
```bash
chrome.exe --remote-debugging-port=9222
```

Then connect:
```javascript
browser.connect_cdp({ endpoint: "http://127.0.0.1:9222" })
```

## Handling Captchas and Blocks

Indeed and Google may show captchas or block automation. Solutions:

1. **Use headful mode**: `browser.launch({ headless: false })` allows you to solve captchas manually
2. **Use persistent profiles**: Launch with `userDataDir` to reuse cookies and sessions
3. **Enable stealth mode**: `browser.launch({ stealth: true })`
4. **Use existing Chrome**: Connect via CDP to a logged-in Chrome instance
5. **Change network/IP**: Some blocks are IP-based

## Output Structure

Extracted data is saved as text files:

```
output/
├── indeed/
│   ├── page-1/
│   │   ├── AI Engineer.txt
│   │   ├── Machine Learning Engineer.txt
│   │   └── ...
│   └── page-2/
│       └── ...
└── google/
    ├── Result Title.txt
    └── ...
```

Each file contains structured data:
```
Title: AI Engineer
Company: Tech Company
Location: Dubai, UAE
Salary: AED 15,000 - 25,000
URL: https://ae.indeed.com/viewjob?jk=...
Summary:
Job description text here...
```

## Architecture

- `src/mcp-browser-server.js` - Main MCP server with tool definitions
- `src/extractors.js` - Extraction logic for Indeed and Google
- `src/tests/` - Standalone test scripts

## Dependencies

- `@modelcontextprotocol/sdk` - MCP server implementation
- `playwright` - Browser automation framework
- `zod` - Schema validation for MCP tools

## License

ISC

## Contributing

Contributions welcome! Please feel free to submit issues and pull requests.
