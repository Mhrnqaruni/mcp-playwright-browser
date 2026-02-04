# MCP Playwright Browser Server

A powerful Model Context Protocol (MCP) server that exposes Playwright-powered browser automation tools to AI assistants. Enable your AI to navigate web pages, extract structured data, scrape job listings, and interact with web content programmatically - using both traditional DOM methods and visual screenshot-based navigation.

## Features

- **Visual Navigation**: Screenshot-based page analysis with element mapping and coordinate-based clicking
- **Browser Automation**: Full browser control via Playwright (Chromium)
- **MCP Integration**: Expose 23+ tools via Model Context Protocol
- **Anti-Detection**: Stealth mode to bypass bot detection
- **Job Scraping**: Specialized extractors for Indeed job postings
- **Search Extraction**: Google search results extraction
- **CDP Support**: Connect to existing Chrome instances via Chrome DevTools Protocol
- **Flexible Modes**: Headless or headful browser operation
- **Dual Navigation**: Traditional DOM-based OR visual screenshot-based interaction
- **File Management**: Save extracted data to structured text files

## How This Differs from Microsoft's Official playwright-mcp

Microsoft's [playwright-mcp](https://github.com/microsoft/playwright-mcp) focuses on **accessibility-tree based automation** for test development and structured page interaction.

This server adds:
- **Visual/screenshot-based navigation** - For sites where accessibility trees are insufficient (Shadow DOM, obfuscated forms, visual layouts)
- **Production-ready extractors** - Pre-built Indeed and Google scrapers with anti-detection
- **Stealth capabilities** - User profile persistence, anti-bot headers, CDP connection to real Chrome instances
- **Hybrid approach** - Combines DOM and visual methods, letting AI choose based on task requirements

**Use Microsoft's tool for:** Test automation, structured accessibility-driven workflows
**Use this tool for:** Web scraping, complex agent-driven automation, anti-detection scenarios

## Visual Navigation: A Unique Advantage

This server provides **two ways** for AI assistants to interact with web pages:

1. **Traditional DOM-based** (default, faster): AI reads the HTML code structure
2. **Visual screenshot-based** (optional, more human-like): AI analyzes a screenshot of the page

The visual navigation feature (`browser.visual_snapshot` + `browser.click_at`) allows AI to "see" pages like a human, which is invaluable for:
- Complex layouts where HTML structure doesn't match visual appearance
- Obfuscated forms with dynamically generated or meaningless element IDs
- Shadow DOM or heavily nested iframe structures
- When you need the AI to understand the visual layout, not just the code

### Performance & Cost Considerations

**When to use DOM methods (default):**
- ~10x faster execution
- Minimal token usage (structured text vs. image encoding)
- Lower latency for multi-step workflows
- Works reliably on well-structured sites

**When to use Visual methods:**
- Complex Shadow DOM or iframes where DOM traversal fails
- Sites with obfuscated or dynamically-generated element IDs
- Anti-bot measures that detect programmatic element selection
- When human-like interaction patterns are required

The AI automatically defaults to DOM-based methods for efficiency, switching to visual only when explicitly requested or when DOM methods fail. This optimizes for speed and cost while maintaining robustness.

## ⚠️ Ethical Use & Legal Compliance

This tool is provided for:
- Educational purposes and learning browser automation
- Testing your own web applications
- Legitimate research with appropriate authorization
- Automation of tasks you have permission to perform

**You are responsible for:**
- Respecting `robots.txt` and website Terms of Service
- Obtaining permission before scraping third-party sites
- Complying with data protection regulations (GDPR, CCPA, etc.)
- Rate-limiting requests to avoid service disruption
- Using the tool in accordance with applicable laws

**Not intended for:**
- Violating website terms of service
- Bypassing paywalls or access controls without authorization
- Automated data collection without permission
- Any illegal activity

The authors assume no liability for misuse of this software. Users are solely responsible for ensuring their use complies with all applicable laws and regulations.

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

### Visual Navigation
- `browser.visual_snapshot` - Take screenshot + generate element map with bounding boxes and IDs
- `browser.click_at` - Click at specific X/Y coordinates for visual workflows

### Specialized Extractors (Production Examples)

Pre-built extractors for common automation targets - demonstrating robust, production-grade scraping patterns:

**Job Scraping:**
- `jobs.extract_indeed` - Extract Indeed job listings with multi-selector fallbacks, duplicate detection, and anti-bot awareness
- `jobs.indeed_next_page` - Navigate to next Indeed results page with multiple pagination strategies

**Search:**
- `search.google` - Search Google and extract results with consent handling and result deobfuscation
- `search.extract_google` - Extract results from current Google page with multiple container format support

These extractors showcase best practices for building reliable scrapers: fallback selector chains, access issue detection, URL normalization, and filesystem-safe sanitization. Use them as templates for building your own specialized extractors.

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

### Example 3: Visual Navigation (Screenshot-Based)

```javascript
// Launch browser
browser.launch({ headless: false })

// Navigate to a page
browser.goto({ url: "https://example.com" })

// Take visual snapshot - AI can "see" the page layout
browser.visual_snapshot({
  path: "output/screenshot.png",
  saveMapPath: "output/element-map.json"
})

// Click element by ID from the visual map
browser.click({ elementId: 42 })

// Or click at specific coordinates
browser.click_at({ x: 350, y: 450 })
```

**When to use visual navigation:**
- Complex layouts where DOM structure is hard to parse
- Obfuscated forms or dynamically generated IDs
- When you need the AI to "see" the page like a human
- Shadow DOM or iframe-heavy pages

### Example 4: Stealth Mode with User Profile

```javascript
// Launch with persistent profile to bypass captchas
browser.launch({
  headless: false,
  userDataDir: "C:/Users/User/AppData/Local/Google/Chrome/User Data",
  args: ["--disable-blink-features=AutomationControlled"],
  stealth: true
})
```

### Example 5: Connect to Existing Chrome

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
