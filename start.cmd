@echo off
rem MIC STUDIO one-click launcher.
rem Double-click starts dev mode; pass "app" to run the built output.
rem On Smart App Control machines Explorer blocks .cmd files:
rem use the .micstudio launcher in the repo root (see scripts\register-sac-launcher.ps1).
rem All real work lives in scripts\start.ps1.
setlocal EnableExtensions
title MIC STUDIO Launcher
cd /d "%~dp0"

rem Resolve PowerShell without trusting PATH: Explorer-launched processes can inherit
rem a broken PATH, and some machines only ship PowerShell 7 (pwsh.exe).
rem MICSTUDIO_PS can point at a specific executable when neither default works.
set "PS="
if defined MICSTUDIO_PS if exist "%MICSTUDIO_PS%" set "PS=%MICSTUDIO_PS%"
if not defined PS if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not defined PS for %%I in (powershell.exe) do set "PS=%%~$PATH:I"
if not defined PS if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PS=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined PS for %%I in (pwsh.exe) do set "PS=%%~$PATH:I"

if not defined PS (
  echo [start] PowerShell not found: neither powershell.exe nor pwsh.exe.
  echo [start] Install PowerShell 5.1+ or set MICSTUDIO_PS to its full path.
  echo [start] Then run: "%ComSpec%" /c "%~f0" app
  if not defined MICSTUDIO_NO_PAUSE pause
  exit /b 1
)

if not exist "%~dp0scripts\start.ps1" (
  echo [start] Missing scripts\start.ps1 next to this file.
  echo [start] Keep start.cmd and the scripts folder together in the repo root.
  if not defined MICSTUDIO_NO_PAUSE pause
  exit /b 1
)

"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [start] Launcher failed with exit code %RC%.
  echo [start] Copy the messages above when reporting the problem.
  echo [start] Manual command:
  echo         "%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
  rem MICSTUDIO_NO_PAUSE=1 keeps automated runs (CI/probes) from blocking here.
  if not defined MICSTUDIO_NO_PAUSE pause
)

exit /b %RC%
