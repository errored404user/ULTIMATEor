@echo off
rem ORscript Desktop - run from source (needs Node.js 18+ from https://nodejs.org)
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules\electron (
  echo Installing dependencies (first run only)...
  call npm install --no-audit --no-fund || (echo npm install failed & pause & exit /b 1)
)
start "" /b npx electron . %*
endlocal
