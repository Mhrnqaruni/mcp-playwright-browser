# MCP Playwright Browser Server

A powerful Model Context Protocol (MCP) server that exposes Playwright-powered browser automation tools to AI assistants. Enable your AI to navigate web pages, extract structured data, scrape job listings, and interact with web content programmatically - using both traditional DOM methods and visual screenshot-based navigation.

## 🚀 Quick Start with Profile Launchers

**The easiest way to get started** is using the pre-configured profile launchers:

```bash
# Interactive mode (recommended for beginners)
scripts\run-chrome-profile.bat --kill-chrome

# One-shot automation
scripts\run-dom-headless.bat -p "Go to https://example.com and extract text"
```

See [Profile Launchers](#profile-launchers) section for detailed usage.

---

## Features

- **Profile Launchers**: One-click scripts that configure everything automatically
- **Visual Navigation**: Screenshot-based page analysis with element mapping and coordinate-based clicking
- **Browser Automation**: Full browser control via Playwright (Chromium/Chrome)
- **MCP Integration**: 25+ tools via Model Context Protocol
- **Anti-Detection**: Stealth mode with real Chrome profile support
- **Job Scraping**: Specialized extractors for Indeed job postings
- **Search Extraction**: Google search results extraction
- **CDP Support**: Connect to existing Chrome instances via Chrome DevTools Protocol
- **Flexible Modes**: Headless or headful browser operation
- **Dual Navigation**: Traditional DOM-based OR visual screenshot-based interaction
- **File Management**: Save extracted data to structured text files

---

## 🎯 Profile Launchers

### Available Profiles

| Profile | Use Case | Browser | Speed | Best For |
|---------|----------|---------|-------|----------|
| **run-chrome-profile.bat** | Real Chrome with your profile | Chrome (Profile 3) | Medium | Form filling, logged-in sessions |
| **run-dom-headless.bat** | Fast automation | Chromium (headless) | ⚡ Fastest | Job scraping, bulk extraction |
| **run-visual-headful.bat** | Visual debugging | Chromium (visible) | Medium | Debugging, verification |
| **run-cdp-profile.bat** | Advanced - Real Chrome via CDP | Chrome (CDP) | Medium | Maximum stealth |

### How to Use Profiles

#### **Interactive Mode** (Chat with Gemini)

Run the launcher and interact naturally:

```bash
# Use your real Chrome profile (logged into Gmail, etc.)
scripts\run-chrome-profile.bat --kill-chrome

# Fast headless automation
scripts\run-dom-headless.bat

# Visual mode with browser visible
scripts\run-visual-headful.bat
```

Then in Gemini, just type your task:
```
Go to gmail.com and wait for me
Fill out the job application at [URL] with my CV
Extract all job listings from Indeed and save them
```

#### **One-Shot Mode** (Automated Scripts)

Run a task and get a log file:

```bash
# Basic one-shot
scripts\run-dom-headless.bat -p "Go to https://example.com and take a snapshot"

# With custom output file
scripts\run-chrome-profile.bat --kill-chrome -p "Fill form at [URL]" --output logs\form-fill.log

# Complex automation
scripts\run-dom-headless.bat -p "Extract 50 jobs from Indeed and save to output/jobs"
```

**Logs are automatically saved** to `logs/` with timestamps.

---

## 🔧 Installation

### Prerequisites
- Node.js 18+
- npm
- Gemini CLI (install via: `npm install -g @google/gemini-cli`)

### Setup Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/Mhrnqaruni/mcp-playwright-browser.git
   cd mcp-playwright-browser
   ```

2. **Install dependencies**
   ```bash
   npm install
   npx playwright install chromium
   ```

3. **Configure Gemini CLI**

   The project includes `.gemini/settings.json` that configures the MCP server automatically.

   **Important:** Update the `cwd` path in `.gemini/settings.json` to your repository location:
   ```json
   {
     "mcpServers": {
       "playwrightBrowser": {
         "command": "node",
         "args": ["src/mcp-browser-server.js"],
         "cwd": "C:/Users/YourUsername/path/to/mcp-playwright-browser"
       }
     }
   }
   ```

4. **Disable Chrome Background Apps** (Optional but recommended)

   To avoid Chrome locking your profile:
   ```
   Chrome Settings → Advanced → System →
   ☐ Continue running background apps when Google Chrome is closed
   ```

5. **Test the installation**
   ```bash
   scripts\run-dom-headless.bat -p "Launch browser, go to https://example.com, take a snapshot, close"
   ```

---

## 📖 Usage Guide

### Profile Comparison

#### 1. **Chrome Profile** (Recommended for most users)
```bash
scripts\run-chrome-profile.bat --kill-chrome
```

**Features:**
- ✅ Uses your real Chrome with Profile 3 (mehran.gharuni@gmail.com)
- ✅ Already logged into Gmail, LinkedIn, job sites
- ✅ Persistent sessions (no re-login needed)
- ✅ Full Chrome extensions support
- ⚠️ Requires Chrome to be closed (use `--kill-chrome`)

**Best for:**
- Filling out job applications
- Accessing authenticated sites
- Tasks requiring logged-in sessions
- Form submissions

**Example tasks:**
```
Fill out the application form at [URL] with my information
Go to my Gmail inbox and summarize unread emails
Submit this job application on LinkedIn
```

#### 2. **DOM Headless** (Fastest automation)
```bash
scripts\run-dom-headless.bat -p "your task here"
```

**Features:**
- ⚡ Fastest execution (no GUI overhead)
- ✅ Best for bulk operations
- ✅ Low resource usage
- ❌ No visual feedback

**Best for:**
- Job scraping (Indeed, LinkedIn)
- Bulk data extraction
- Automated testing
- Background tasks

**Example tasks:**
```bash
scripts\run-dom-headless.bat -p "Extract 100 jobs from Indeed and save to output/jobs"
scripts\run-dom-headless.bat -p "Scrape product prices from [URL] and save to prices.txt"
```

#### 3. **Visual Headful** (For debugging)
```bash
scripts\run-visual-headful.bat
```

**Features:**
- 👁️ Browser visible (watch what's happening)
- 📸 Screenshot-based navigation
- ✅ Good for troubleshooting
- ⚠️ Slower than DOM mode

**Best for:**
- Debugging automation issues
- Verifying form fills
- Complex visual layouts
- Learning how it works

**Example tasks:**
```
Take a visual snapshot of [URL] and identify all buttons
Navigate [complex site] and show me what you see
```

#### 4. **CDP Profile** (Advanced)
```bash
scripts\run-cdp-profile.bat
```

**Features:**
- 🔐 Maximum stealth (connects to real Chrome)
- ✅ Bypasses most bot detection
- ✅ Uses Chrome DevTools Protocol
- ⚠️ More complex setup

**Best for:**
- Sites with aggressive bot detection
- When other profiles get blocked
- Advanced automation scenarios

---

## 🎛️ Advanced Features

### Environment Variables

The launchers automatically set these. You can customize them:

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_HEADLESS` | varies | Run browser without GUI (true/false) |
| `MCP_STEALTH` | true | Enable anti-detection (true/false) |
| `MCP_USER_DATA_DIR` | auto | Chrome profile directory |
| `MCP_PROFILE` | Profile 3 | Chrome profile name |
| `MCP_CHANNEL` | chrome | Use real Chrome (vs Chromium) |
| `MCP_REQUIRE_PROFILE` | varies | Enforce profile usage (chrome-profile.bat only) |

**Note:** The launchers set both `MCP_*` and `GEMINI_CLI_MCP_*` variants for compatibility with Gemini CLI's environment sanitization.

### Flags

#### `--kill-chrome`
Force-closes all Chrome processes before launching.

```bash
scripts\run-chrome-profile.bat --kill-chrome
```

**When to use:**
- Chrome background processes are blocking profile access
- You get "Chrome is already running" errors
- After closing Chrome windows but profile still locked

#### `-p` or `--prompt`
Run a single task and exit (one-shot mode).

```bash
scripts\run-dom-headless.bat -p "Your task here"
```

#### `--output`
Specify custom log file location.

```bash
scripts\run-chrome-profile.bat -p "Task" --output logs\custom.log
```

---

## 🛠️ Available MCP Tools

### Browser Control
- `browser.launch` - Launch browser with options (headless, stealth, profile, etc.)
- `browser.launch_chrome_cdp` - Launch Chrome with CDP for advanced control
- `browser.connect_cdp` - Connect to existing Chrome instance
- `browser.goto` - Navigate to URL
- `browser.back` / `browser.forward` - Navigate history
- `browser.new_page` - Open new tab
- `browser.close` - Close browser session
- `browser.wait` - Wait for selector or timeout

### Element Interaction
- `browser.list` - List visible interactive elements
- `browser.click` - Click elements by ID, selector, or text
- `browser.type` - Type into input fields
- `browser.press` - Press keyboard keys
- `browser.click_at` - Click at specific X/Y coordinates

### Data Extraction
- `browser.snapshot` - Get page summary (title, text, links)
- `browser.extract_text` - Extract text from CSS selectors
- `browser.extract_html` - Extract HTML from selectors
- `browser.screenshot` - Save screenshot to file
- `browser.visual_snapshot` - Take screenshot + generate element map with bounding boxes

### Specialized Extractors
- `jobs.extract_indeed` - Extract Indeed job listings (production-ready with fallbacks)
- `jobs.indeed_next_page` - Navigate to next Indeed page
- `search.google` - Search Google and extract results
- `search.extract_google` - Extract results from current Google page

### File Operations
- `files.write_text` - Save text to file

---

## 📝 Common Use Cases

### 1. Job Application Automation

```bash
# Interactive mode - fill applications manually with AI assistance
scripts\run-chrome-profile.bat --kill-chrome
```

Then in Gemini:
```
Go to [job application URL]
Fill out the form with:
- Name: Mehran Gharooni
- Email: mehran.gharuni@gmail.com
- Upload CV from: ./Mehran_Gharooni_CV.pdf
Submit the application
```

### 2. Job Scraping

```bash
# One-shot - extract 100 jobs and save
scripts\run-dom-headless.bat -p "Go to Indeed, search for 'AI Engineer Dubai', extract 100 jobs, save to output/jobs"
```

### 3. Form Filling (Multiple Forms)

Create a script:
```bash
@echo off
for %%F in (jobs\*.txt) do (
  echo Processing %%F
  scripts\run-chrome-profile.bat --kill-chrome -p "Go to %%F URL and fill application form" --output logs\%%~nF.log
  timeout /t 60
)
```

### 4. Research & Data Collection

```bash
# Search multiple topics and save results
scripts\run-dom-headless.bat -p "Search Google for 'remote AI jobs 2026', extract top 20 results, save to output/google/ai-jobs.txt"
```

---

## 🐛 Troubleshooting

### Issue: "Chrome is already running" error

**Cause:** Chrome background processes are blocking the profile.

**Solution:**
```bash
# Use --kill-chrome flag
scripts\run-chrome-profile.bat --kill-chrome

# Or manually kill Chrome
taskkill /F /IM chrome.exe
```

### Issue: Gmail says "This browser is not safe"

**Cause:** Using Chromium instead of your real Chrome profile.

**Solution:**
1. Ensure Chrome is completely closed (use `--kill-chrome`)
2. Verify the browser.launch response shows:
   ```json
   {
     "persistent": true,
     "userDataDir": "C:\\Users\\User\\AppData\\Local\\Google\\Chrome\\User Data",
     "profileDirectory": "Profile 3"
   }
   ```
3. If still showing `null` values, restart Gemini and try again

### Issue: MCP tools not found

**Cause:** Gemini started in wrong directory or MCP config not loaded.

**Solution:**
- Always run the `.bat` files from any directory (they auto-fix working directory)
- Check `.gemini/settings.json` has correct `cwd` path
- The project includes `scripts/.gemini/settings.json` as backup

### Issue: Browser opens but doesn't use my profile

**Cause:** Environment variables not passing through or Chrome profile locked.

**Solution:**
1. Use `--kill-chrome` to unlock profile
2. Check that `run-chrome-profile.bat` outputs:
   ```
   Using Chrome executable: C:\Program Files\Google\Chrome\Application\chrome.exe
   Using Chrome profile: Profile 3
   ```
3. If not, the profile detection failed - manually set `MCP_PROFILE=Profile 3` in the .bat file

### Issue: Slow performance or high memory usage

**Cause:** Running headful mode or visual snapshots.

**Solution:**
- Use `run-dom-headless.bat` for bulk operations
- Close unnecessary Chrome tabs/extensions
- Use one-shot mode with `--output` to free resources after each task

---

## 🔒 Security & Privacy

### What Data Is Stored?

- **Logs**: Command outputs saved to `logs/` (git-ignored)
- **Extracted Data**: Jobs, search results saved to `output/` (git-ignored)
- **Chrome Profile**: Uses your existing Chrome Profile 3 (no new profile created)
- **Credentials**: Never stored or transmitted (uses your existing logged-in sessions)

### What Is NOT Stored?

- ❌ Passwords or credentials
- ❌ Credit card information
- ❌ Personal identification documents
- ❌ Browser history (uses temp sessions for non-profile modes)

### Best Practices

1. **Review automation logs** before sharing them (may contain personal info)
2. **Use dedicated Chrome profile** for automation (not your main profile)
3. **Test on non-sensitive sites first**
4. **Never commit `.gemini/` or `logs/` to git** (already in .gitignore)
5. **Keep your Chrome and Node.js updated** for security patches

---

## 📂 Project Structure

```
mcp-playwright-browser/
├── src/
│   ├── mcp-browser-server.js    # Main MCP server
│   ├── extractors.js             # Indeed & Google extractors
│   └── tests/                    # Standalone tests
├── scripts/
│   ├── run-chrome-profile.bat    # Chrome with your profile
│   ├── run-dom-headless.bat      # Fast headless mode
│   ├── run-visual-headful.bat    # Visual debugging mode
│   ├── run-cdp-profile.bat       # CDP advanced mode
│   ├── .gemini/settings.json     # MCP config (workspace fallback)
│   └── GEMINI.md                 # Fallback instructions
├── profiles/
│   ├── dom/                      # DOM mode instructions
│   ├── visual/                   # Visual mode instructions
│   └── cdp/                      # CDP mode instructions
├── .gemini/
│   └── settings.json             # Main MCP configuration
├── logs/                         # Execution logs (git-ignored)
├── output/                       # Extracted data (git-ignored)
├── GEMINI.md                     # Project-level instructions
└── README.md                     # This file
```

---

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Test your changes with all profiles
4. Commit your changes (`git commit -m 'Add amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

---

## 📄 License

ISC License - See [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Built on [Playwright](https://playwright.dev/) for reliable browser automation
- Uses [Model Context Protocol](https://modelcontextprotocol.io/) for AI integration
- Inspired by [Microsoft's playwright-mcp](https://github.com/microsoft/playwright-mcp)

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/Mhrnqaruni/mcp-playwright-browser/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Mhrnqaruni/mcp-playwright-browser/discussions)
- **Email**: mehran.gharuni@gmail.com

---

## 🔄 Changelog

### Version 1.1.0 (Current)
- ✅ Added profile launcher system (.bat files)
- ✅ Fixed Chrome profile integration with real Chrome
- ✅ Added `--kill-chrome` flag for background process management
- ✅ Implemented GEMINI_CLI_MCP_* environment variable support
- ✅ Added workspace root fallback (scripts/.gemini/)
- ✅ Fixed prompt parsing (parentheses support)
- ✅ Added MCP_REQUIRE_PROFILE guard
- ✅ Enhanced instructions to prevent script creation
- ✅ Added one-shot mode with automatic logging

### Version 1.0.0
- Initial release
- Basic MCP server with Playwright integration
- Indeed and Google extractors
- Visual and DOM navigation modes
