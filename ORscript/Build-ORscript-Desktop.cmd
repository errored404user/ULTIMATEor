@echo off
setlocal
REM Builds ORscript Desktop (Rust) from ORscript\agent and installs the binary
REM as ORscript\bin\or-core.exe. Requires Rust (https://rustup.rs) -> stable MSVC.
cd /d "%~dp0agent"
where cargo >nul 2>nul
if errorlevel 1 (
  echo cargo was not found. Install Rust from https://rustup.rs and reopen this window.
  pause
  exit /b 1
)
echo Building ORscript Desktop (release)...
cargo build --release
if errorlevel 1 (
  echo.
  echo Build failed. Paste the error above into the chat so it can be fixed.
  pause
  exit /b 1
)
if not exist "%~dp0bin" mkdir "%~dp0bin"
copy /Y "target\release\or-core.exe" "%~dp0bin\or-core.exe" >nul
echo.
echo Done: %~dp0bin\or-core.exe
echo Double-click it to open ORscript Desktop (or run with --headless / --hidden).
pause
