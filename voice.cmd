@echo off
rem MIC STUDIO voice toolchain launcher (models / venv / python).
rem Usage: voice.cmd fetch [--check^|--record] [--only ^<id^>]
rem        voice.cmd venv
rem        voice.cmd python ^<args...^>
rem All real work lives in scripts\voice.ps1.
setlocal EnableExtensions
title MIC STUDIO voice
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
  echo [voice] PowerShell not found: neither powershell.exe nor pwsh.exe.
  echo [voice] Install PowerShell 5.1+ or set MICSTUDIO_PS to its full path.
  exit /b 1
)

if not exist "%~dp0scripts\voice.ps1" (
  echo [voice] Missing scripts\voice.ps1 next to this file.
  echo [voice] Keep voice.cmd and the scripts folder together in the repo root.
  exit /b 1
)

"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\voice.ps1" %*
exit /b %ERRORLEVEL%
