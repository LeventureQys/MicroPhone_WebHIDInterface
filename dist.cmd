@echo off
rem MIC STUDIO one-click packager (Windows).
rem Output: release\MicStudio-<version>-portable.exe -- one file, double-click to run.
rem Usage: "dist.cmd" (default) or "dist.cmd -Installer -Zip -OpenFolder".
rem
rem On Smart App Control machines Explorer blocks double-clicking .cmd files:
rem run it from a terminal instead:  cmd /c dist.cmd
rem All real work lives in scripts\dist.ps1.
setlocal EnableExtensions
title MIC STUDIO Packager
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
  echo [dist] PowerShell not found: neither powershell.exe nor pwsh.exe.
  echo [dist] Install PowerShell 5.1+ or set MICSTUDIO_PS to its full path.
  if not defined MICSTUDIO_NO_PAUSE pause
  exit /b 1
)

if not exist "%~dp0scripts\dist.ps1" (
  echo [dist] Missing scripts\dist.ps1 next to this file.
  echo [dist] Keep dist.cmd and the scripts folder together in the repo root.
  if not defined MICSTUDIO_NO_PAUSE pause
  exit /b 1
)

"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dist.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [dist] Packaging failed with exit code %RC%.
  echo [dist] Copy the messages above when reporting the problem.
  echo [dist] Manual command:
  echo         "%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dist.ps1"
  rem MICSTUDIO_NO_PAUSE=1 keeps automated runs (CI/probes) from blocking here.
  if not defined MICSTUDIO_NO_PAUSE pause
)

exit /b %RC%
