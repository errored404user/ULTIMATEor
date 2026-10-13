@echo off
rem Builds release\ORscript Desktop-<version>-x64-win.exe (installer) and the portable exe.
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
call npm ci --no-audit --no-fund || (echo npm ci failed & pause & exit /b 1)
call npm test || (echo tests failed & pause & exit /b 1)
call npm run dist || (echo build failed & pause & exit /b 1)
echo.
echo Done. Installers are in the release\ folder.
pause
endlocal
