@echo off
setlocal enabledelayedexpansion

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
pushd "%ROOT%"

set PROFILE_NAME=chrome-profile
set MCP_MODE=dom
set MCP_HEADLESS=false
set MCP_STEALTH=true
set MCP_REQUIRE_PROFILE=true
set MCP_CHANNEL=chrome
set MCP_EXECUTABLE_PATH=
set "MCP_USER_DATA_DIR=%LOCALAPPDATA%\ChromeForMCP"
set MCP_PROFILE=Default
set MCP_ARGS=--disable-blink-features=AutomationControlled;--disable-session-crashed-bubble
set GEMINI_CLI_MCP_HEADLESS=%MCP_HEADLESS%
set GEMINI_CLI_MCP_STEALTH=%MCP_STEALTH%
set GEMINI_CLI_MCP_REQUIRE_PROFILE=%MCP_REQUIRE_PROFILE%
set GEMINI_CLI_MCP_CHANNEL=%MCP_CHANNEL%
set GEMINI_CLI_MCP_EXECUTABLE_PATH=%MCP_EXECUTABLE_PATH%
set GEMINI_CLI_MCP_USER_DATA_DIR=%MCP_USER_DATA_DIR%
set GEMINI_CLI_MCP_ARGS=%MCP_ARGS%

set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"
set "LAD=%LOCALAPPDATA%"
if exist "%PF%\Google\Chrome\Application\chrome.exe" set "MCP_EXECUTABLE_PATH=%PF%\Google\Chrome\Application\chrome.exe"
if not defined MCP_EXECUTABLE_PATH if defined PF86 if exist "%PF86%\Google\Chrome\Application\chrome.exe" set "MCP_EXECUTABLE_PATH=%PF86%\Google\Chrome\Application\chrome.exe"
if not defined MCP_EXECUTABLE_PATH if exist "%LAD%\Google\Chrome\Application\chrome.exe" set "MCP_EXECUTABLE_PATH=%LAD%\Google\Chrome\Application\chrome.exe"
if defined MCP_EXECUTABLE_PATH set "MCP_CHANNEL="
if defined MCP_EXECUTABLE_PATH (
  set "GEMINI_CLI_MCP_EXECUTABLE_PATH=!MCP_EXECUTABLE_PATH!"
  set "GEMINI_CLI_MCP_CHANNEL="
) else (
  set "GEMINI_CLI_MCP_CHANNEL=%MCP_CHANNEL%"
)
set GEMINI_CLI_MCP_PROFILE=%MCP_PROFILE%

if not exist "%MCP_USER_DATA_DIR%" (
  mkdir "%MCP_USER_DATA_DIR%"
)
set KILL_CHROME=
if defined MCP_EXECUTABLE_PATH (
  echo Using Chrome executable: !MCP_EXECUTABLE_PATH!
) else (
  echo Using Playwright channel: !MCP_CHANNEL!
)
echo Using user data dir: !MCP_USER_DATA_DIR!
echo Using profile: !MCP_PROFILE!

set PROFILE_SYSTEM_MD=%ROOT%\profiles\dom\system.md
set PROFILE_SYSTEM_MD_ONESHOT=%ROOT%\profiles\dom\oneshot.md

if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

set PROMPT=
set OUTPUT=
set RESUME=

call :parse_args %*
set "DEFAULT_USER_DATA_DIR=%LOCALAPPDATA%\Google\Chrome\User Data"
set CHECK_CHROME_LOCK=0
if /I "%MCP_USER_DATA_DIR%"=="%DEFAULT_USER_DATA_DIR%" set CHECK_CHROME_LOCK=1
if %CHECK_CHROME_LOCK%==1 (
  tasklist /FI "IMAGENAME eq chrome.exe" | find /I "chrome.exe" >NUL
  if %ERRORLEVEL%==0 (
    if defined KILL_CHROME (
      echo Closing all Chrome processes...
      taskkill /F /IM chrome.exe >NUL 2>&1
      powershell -NoProfile -Command "Start-Sleep -Seconds 2" >NUL
    ) else (
      echo ERROR: Chrome is already running. Close Chrome to unlock the profile or use run-cdp-profile.bat.
      popd
      exit /b 1
    )
  )
)
goto run

:parse_args
setlocal DisableDelayedExpansion
:parse_loop
if "%~1"=="" goto parse_done
if /I "%~1"=="-p" (
  set "PROMPT=%~2"
  shift
  shift
  goto parse_loop
)
if /I "%~1"=="--prompt" (
  set "PROMPT=%~2"
  shift
  shift
  goto parse_loop
)
if /I "%~1"=="--output" (
  set "OUTPUT=%~2"
  shift
  shift
  goto parse_loop
)
if /I "%~1"=="--kill-chrome" (
  set "KILL_CHROME=1"
  shift
  goto parse_loop
)
if /I "%~1"=="--resume" (
  set "RESUME=%~2"
  shift
  shift
  goto parse_loop
)
if /I "%~1"=="--" (
  shift
  set "PROMPT=%*"
  goto parse_done
)
if defined PROMPT (
  set "PROMPT=%PROMPT% %~1"
) else (
  set "PROMPT=%~1"
)
shift
goto parse_loop
:parse_done
endlocal & set "PROMPT=%PROMPT%" & set "OUTPUT=%OUTPUT%" & set "KILL_CHROME=%KILL_CHROME%" & set "RESUME=%RESUME%"
exit /b

:run
if defined PROMPT (
  set GEMINI_SYSTEM_MD=%PROFILE_SYSTEM_MD_ONESHOT%
  if not defined OUTPUT (
    for /f %%A in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%A
    set OUTPUT=%ROOT%\logs\%PROFILE_NAME%-!TS!.log
  )
  setlocal DisableDelayedExpansion
  if defined RESUME (
    gemini --resume %RESUME% -p "%PROMPT%" --approval-mode yolo --allowed-mcp-server-names playwrightBrowser > "%OUTPUT%" 2>&1
  ) else (
    gemini -p "%PROMPT%" --approval-mode yolo --allowed-mcp-server-names playwrightBrowser > "%OUTPUT%" 2>&1
  )
  endlocal
) else (
  set GEMINI_SYSTEM_MD=%PROFILE_SYSTEM_MD%
  gemini --approval-mode yolo --allowed-mcp-server-names playwrightBrowser
)

if defined PROMPT echo Output saved to %OUTPUT%
popd
