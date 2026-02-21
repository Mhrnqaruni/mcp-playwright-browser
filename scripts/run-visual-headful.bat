@echo off
setlocal enabledelayedexpansion

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
pushd "%ROOT%"

set PROFILE_NAME=visual-headful
set MCP_MODE=visual
set MCP_HEADLESS=false
set MCP_STEALTH=true
set MCP_ARGS=--disable-blink-features=AutomationControlled
set GEMINI_CLI_MCP_HEADLESS=%MCP_HEADLESS%
set GEMINI_CLI_MCP_STEALTH=%MCP_STEALTH%
set GEMINI_CLI_MCP_ARGS=%MCP_ARGS%

set PROFILE_SYSTEM_MD=%ROOT%\profiles\visual\system.md
set PROFILE_SYSTEM_MD_ONESHOT=%ROOT%\profiles\visual\oneshot.md

if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

set PROMPT=
set OUTPUT=
set RESUME=

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
endlocal & set "PROMPT=%PROMPT%" & set "OUTPUT=%OUTPUT%" & set "RESUME=%RESUME%"
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
