# ORscript Desktop (Rust)

Native desktop app + bridge for the ORscript browser extension. One binary does both jobs:

* **Bridge** — HTTP `127.0.0.1:3000`, WebSocket `17613` (Roblox Studio) and `17615` (AgentScript workspace), Roblox Studio MCP helper (Windows `%LOCALAPPDATA%\Roblox\mcp.bat`, macOS `RobloxStudio.app/Contents/MacOS/StudioMCP`, Linux via Wine — see below), 18 workspace tools. Protocol-identical to or-core 1.18, so the extension needs no change.
* **Desktop window** — pure Rust (eframe/egui), 6 pages: **Home** (setup checklist that tells you the next step, status cards, live Studio viewport snapshot, quick access, recent activity), **Explorer** (workspace browser + editor), **Tools** (Studio + workspace tool catalog with a Run panel), **Servers** (Studio MCP, local bridge, channels), **Terminal** (workspace shell *and* a Luau runner that executes code inside Roblox Studio), **Settings** (workspace folder picker applied live, MCP launcher override, diagnostics, about). Closing the window hides it to the notification area; the bridge keeps running. Left-click the tray icon (or launch `or-core` again) to reopen the window; right-click → **Quit**, or the **Quit** pill in the title bar, stops the bridge. Since 1.22.0 the tray icon is created on the event-loop thread and serviced by a dedicated worker, so it keeps working while the window is hidden; a hidden window does no layout work. Runs on **Windows, macOS and Linux** (see *Platforms*).

Keyboard: `Esc` close panel / clear search · `Ctrl+1…6` pages · `Ctrl+R` restart Studio MCP · `F5` probe Studio + refresh tools · `Ctrl+Shift+S` Studio snapshot · `Ctrl+S` save file · `Ctrl+Enter` run Luau.

## Build

Requirements: Rust stable from <https://rustup.rs> (MSVC toolchain on Windows, Xcode command line tools on macOS).

**Windows**

```powershell
cd ORscript\agent
cargo build --release
# -> target\release\or-core.exe
copy target\release\or-core.exe ..\bin\or-core.exe
```

Or double-click `ORscript\Build-ORscript-Desktop.cmd`, which runs the same steps.

**macOS / Linux**

```sh
cd ORscript/agent
cargo build --release
# -> target/release/or-core
cp target/release/or-core ../bin/or-core
```

Or run `ORscript/build-orscript-desktop.sh` (same steps; pass `--features linux-tray` on Linux for the tray icon).

Linux build packages (Debian/Ubuntu names): `build-essential pkg-config libssl-dev libxkbcommon-dev libgl1-mesa-dev libwayland-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev libfontconfig1-dev`; the optional tray additionally needs `libgtk-3-dev libayatana-appindicator3-dev`.

The first build downloads the crates (eframe, winit, tokio, axum, …) and takes a few minutes; later builds are incremental.

## Run

| Command | Effect |
|---|---|
| `or-core.exe` | Opens the desktop window (and the tray icon). Double-clicking again focuses the running instance. |
| `or-core.exe --hidden` | Starts straight into the tray (used by *Launch at sign-in*). |
| `or-core.exe --headless` | Bridge only, no window, no tray (servers / autostart scripts). |
| `or-core.exe --workspace D:\Projects\MyGame` | AgentScript root for this run. |

Environment overrides (same as before): `OR_WORKSPACE_ROOT`, `OR_FULL_ACCESS=1`, `OR_MCP_COMMAND`.

## Platforms

| | Windows | macOS | Linux |
|---|---|---|---|
| Window + bridge | yes | yes | yes |
| Tray icon | yes | yes (menu bar) | with `--features linux-tray` (GTK + AppIndicator); otherwise *Close* quits (the app never hides without a tray icon to bring it back); use `--headless` for a window-less bridge |
| Launch at sign-in | `HKCU\…\Run` | `~/Library/LaunchAgents/com.orscript.desktop.plist` | `~/.config/autostart/orscript-desktop.desktop` |
| Studio MCP launcher (default) | `%LOCALAPPDATA%\Roblox\mcp.bat` | `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` | auto-detected `mcp.bat` inside `$WINEPREFIX`, `~/.wine`, Vinegar or Grapejuice prefixes → `wine cmd /c …`; otherwise set it in **Settings → MCP launcher** |
| Data dir (`settings.json`, `logs/agent.log`) | next to the binary | `~/Library/Application Support/ORscript` | `$XDG_CONFIG_HOME/orscript` (default `~/.config/orscript`) |
| Folder picker | Explorer dialog | `osascript` choose folder | `zenity` or `kdialog` if installed, else type the path |

Roblox does not ship Studio for Linux; ORscript Desktop talks to a Studio running under Wine (Vinegar/Grapejuice) exactly like on Windows once the launcher command is set. A second launch of `or-core` on any OS raises the running window (`POST /api/window`) instead of starting a second bridge.

## Files written

* `settings.json` — theme, close-to-tray, start hidden, launch at sign-in, workspace root, MCP launcher override, FULL PC ACCESS.
* `logs/agent.log` — append-only bridge log (also shown in the Terminal page).

Location per OS: see the *Data dir* row above (Windows keeps them next to `or-core.exe`, portable).

## Layout

```
agent/
  Cargo.toml          crate or-agent, binary name or-core (feature `linux-tray`)
  build.rs            sets cfg(has_tray): Windows/macOS always, Linux with the feature
  src/main.rs         bridge: HTTP/WS servers, Studio MCP client, UI command loop
  src/workspace.rs    AgentScript workspace engine (18 tools, sandbox rules)
  src/gui.rs          desktop window, theme, pages, tray icon, per-OS data dir / autostart
```

The Tools page lists the Studio tools reported live by the MCP helper plus the built-in workspace tools, so there is nothing to re-sync when the extension changes.
