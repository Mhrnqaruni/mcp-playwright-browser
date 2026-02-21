@echo off
setlocal enabledelayedexpansion

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
pushd "%ROOT%"

set PROFILE_NAME=cdp-profile-persist
set MCP_MODE=dom
set MCP_HEADLESS=false
set MCP_STEALTH=true
set MCP_CDP_PORT=9222
set MCP_CDP_WAIT_MS=20000
set MCP_FORCE_CDP=true
set MCP_USER_DATA_DIR=%LOCALAPPDATA%\ChromeForMCP
set MCP_PROFILE=Default
set MCP_CAPTURE_PROFILE=light
set MCP_MAX_RESPONSE_BYTES=280000
set MCP_ARGS=--disable-blink-features=AutomationControlled;--disable-session-crashed-bubble
set GEMINI_CLI_MCP_HEADLESS=%MCP_HEADLESS%
set GEMINI_CLI_MCP_STEALTH=%MCP_STEALTH%
set GEMINI_CLI_MCP_CDP_PORT=%MCP_CDP_PORT%
set GEMINI_CLI_MCP_CDP_WAIT_MS=%MCP_CDP_WAIT_MS%
set GEMINI_CLI_MCP_FORCE_CDP=%MCP_FORCE_CDP%
set GEMINI_CLI_MCP_USER_DATA_DIR=%MCP_USER_DATA_DIR%
set GEMINI_CLI_MCP_PROFILE=%MCP_PROFILE%
set GEMINI_CLI_MCP_CAPTURE_PROFILE=%MCP_CAPTURE_PROFILE%
set GEMINI_CLI_MCP_MAX_RESPONSE_BYTES=%MCP_MAX_RESPONSE_BYTES%
set GEMINI_CLI_MCP_ARGS=%MCP_ARGS%

set PROFILE_SYSTEM_MD=%ROOT%\profiles\cdp\persistent.md
set PROFILE_SYSTEM_MD_ONESHOT=%ROOT%\profiles\cdp\persistent.md

if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
if not exist "%MCP_USER_DATA_DIR%" mkdir "%MCP_USER_DATA_DIR%"

set PROMPT=
set OUTPUT=
set RESUME=
set KILL_CHROME=

call :parse_args %*
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
if /I "%~1"=="--resume" (
  set "RESUME=%~2"
  shift
  shift
  goto parse_loop
)
if /I "%~1"=="--kill-chrome" (
  set "KILL_CHROME=1"
  shift
  goto parse_loop
)
if /I "%~1"=="--fresh" (
  set "KILL_CHROME=1"
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
endlocal & set "PROMPT=%PROMPT%" & set "OUTPUT=%OUTPUT%" & set "RESUME=%RESUME%" & set "KILL_CHROME=%KILL_CHROME%"
exit /b

:run
if defined KILL_CHROME (
  REM Close any Chrome processes using the dedicated CDP user data dir
  powershell -NoProfile -Command "$dir = $env:LOCALAPPDATA + '\\ChromeForMCP'; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($dir) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >NUL 2>&1
)

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
