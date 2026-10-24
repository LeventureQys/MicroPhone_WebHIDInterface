@echo off
rem MIC STUDIO one-click launcher.
rem Double-click starts dev mode; pass "app" to run the built output.
rem All real work lives in scripts\start.ps1.
setlocal
title MIC STUDIO Launcher
cd /d "%~dp0"

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [start] powershell.exe not found.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [start] Launcher failed with exit code %RC%.
  echo [start] Copy the messages above when reporting the problem.
  rem MICSTUDIO_NO_PAUSE=1 keeps automated runs (CI/probes) from blocking here.
  if not defined MICSTUDIO_NO_PAUSE pause
)

exit /b %RC%
