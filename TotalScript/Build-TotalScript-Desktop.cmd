@echo off
setlocal
REM Builds TotalScript Desktop (Rust) from TotalScript\agent and installs the binary
REM as TotalScript\bin\total-core.exe. Requires Rust (https://rustup.rs) -> stable MSVC.
cd /d "%~dp0agent"
where cargo >nul 2>nul
if errorlevel 1 (
  echo cargo was not found. Install Rust from https://rustup.rs and reopen this window.
  pause
  exit /b 1
)
echo Building TotalScript Desktop (release)...
cargo build --release
if errorlevel 1 (
  echo.
  echo Build failed. Paste the error above into the chat so it can be fixed.
  pause
  exit /b 1
)
if not exist "%~dp0bin" mkdir "%~dp0bin"
copy /Y "target\release\total-core.exe" "%~dp0bin\total-core.exe" >nul
echo.
echo Done: %~dp0bin\total-core.exe
echo Double-click it to open TotalScript Desktop (or run with --headless / --hidden).
pause
