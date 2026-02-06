@echo off
setlocal enabledelayedexpansion

echo ========================================
echo MCP Playwright Browser - Auto Installer
echo ========================================
echo.

REM Check if git is installed
where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Git is not installed!
    echo Please install Git from https://git-scm.com/download/win
    pause
    exit /b 1
)

REM Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if npm is installed
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm is not installed!
    echo Please install Node.js (includes npm^) from https://nodejs.org/
    pause
    exit /b 1
)

echo [1/7] Checking if repository exists...
if exist ".git" (
    echo Found existing repository. Pulling latest changes...
    git pull origin master
    if %ERRORLEVEL% neq 0 (
        echo WARNING: Failed to pull latest changes. Continuing with existing files...
    )
) else (
    echo Repository not found. Cloning from GitHub...
    cd ..
    git clone https://github.com/Mhrnqaruni/mcp-playwright-browser.git
    if %ERRORLEVEL% neq 0 (
        echo ERROR: Failed to clone repository!
        pause
        exit /b 1
    )
    cd mcp-playwright-browser
)

echo.
echo [2/7] Detecting installation directory...
set "INSTALL_DIR=%CD%"
echo Installation directory: %INSTALL_DIR%

echo.
echo [3/7] Installing Node.js dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed!
    pause
    exit /b 1
)

echo.
echo [4/7] Installing Playwright Chromium...
call npx playwright install chromium
if %ERRORLEVEL% neq 0 (
    echo ERROR: Playwright installation failed!
    pause
    exit /b 1
)

echo.
echo [5/7] Configuring MCP settings...

REM Update main .gemini/settings.json
if not exist ".gemini" mkdir ".gemini"

REM Convert Windows path to forward slashes for JSON
set "JSON_PATH=%INSTALL_DIR:\=/%"

echo Updating .gemini/settings.json...
(
echo {
echo   "mcpServers": {
echo     "playwrightBrowser": {
echo       "command": "node",
echo       "args": [
echo         "src/mcp-browser-server.js"
echo       ],
echo       "cwd": "%JSON_PATH%"
echo     }
echo   }
echo }
) > ".gemini\settings.json"

REM Update scripts/.gemini/settings.json
if not exist "scripts\.gemini" mkdir "scripts\.gemini"

echo Updating scripts/.gemini/settings.json...
(
echo {
echo   "mcpServers": {
echo     "playwrightBrowser": {
echo       "command": "node",
echo       "args": [
echo         "src/mcp-browser-server.js"
echo       ],
echo       "cwd": "%JSON_PATH%"
echo     }
echo   }
echo }
) > "scripts\.gemini\settings.json"

echo.
echo [6/7] Verifying installation...
set "ALL_OK=1"

if not exist "node_modules" (
    echo WARNING: node_modules not found!
    set "ALL_OK=0"
)

if not exist "src\mcp-browser-server.js" (
    echo ERROR: MCP server file not found!
    set "ALL_OK=0"
)

if not exist "scripts\run-chrome-profile.bat" (
    echo ERROR: Profile launchers not found!
    set "ALL_OK=0"
)

if "%ALL_OK%"=="0" (
    echo.
    echo Installation completed with WARNINGS. Please check the errors above.
    pause
    exit /b 1
)

echo.
echo [7/7] Creating quick launch shortcut...
echo @echo off > "%USERPROFILE%\Desktop\MCP Browser.bat"
echo cd /d "%INSTALL_DIR%" >> "%USERPROFILE%\Desktop\MCP Browser.bat"
echo scripts\run-chrome-profile.bat --kill-chrome >> "%USERPROFILE%\Desktop\MCP Browser.bat"

echo.
echo ========================================
echo Installation Complete!
echo ========================================
echo.
echo Installation directory:
echo   %INSTALL_DIR%
echo.
echo MCP Server configured at:
echo   .gemini\settings.json
echo   scripts\.gemini\settings.json
echo.
echo Desktop shortcut created:
echo   %USERPROFILE%\Desktop\MCP Browser.bat
echo.
echo ========================================
echo Quick Start Guide
echo ========================================
echo.
echo Option 1: Use Desktop Shortcut
echo   - Double-click "MCP Browser.bat" on your desktop
echo   - This launches Chrome with your profile
echo.
echo Option 2: Run from Command Line
echo   cd "%INSTALL_DIR%"
echo   scripts\run-chrome-profile.bat --kill-chrome
echo.
echo Option 3: One-Shot Automation
echo   scripts\run-dom-headless.bat -p "Your task here"
echo.
echo ========================================
echo Available Profiles
echo ========================================
echo   run-chrome-profile.bat    - Real Chrome with your profile
echo   run-dom-headless.bat      - Fast headless automation
echo   run-visual-headful.bat    - Visual debugging
echo   run-cdp-profile.bat       - Advanced CDP mode
echo.
echo ========================================
echo Important Notes
echo ========================================
echo   1. Make sure Gemini CLI is installed:
echo      npm install -g @google/gemini-cli
echo.
echo   2. Disable Chrome background apps (recommended^):
echo      Chrome Settings ^> System ^>
echo      Uncheck "Continue running background apps"
echo.
echo   3. First time usage:
echo      scripts\run-chrome-profile.bat --kill-chrome
echo.
echo For more information, see README.md
echo.
pause
