@echo off
rem ORscript bridge only (no window, no tray) - same ports as the desktop app.
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules\ws (
  echo Installing dependencies (first run only)...
  call npm install --omit=dev --ignore-scripts --no-audit --no-fund || (echo npm install failed & pause & exit /b 1)
)
node bridge\cli.js %*
endlocal
