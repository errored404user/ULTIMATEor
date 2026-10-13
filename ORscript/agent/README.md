# ORscript Desktop (Rust)

Native desktop app + bridge for the ORscript browser extension. One binary does both jobs:

* **Bridge** — HTTP `127.0.0.1:3000`, WebSocket `17613` (Roblox Studio) and `17615` (AgentScript workspace), Roblox Studio MCP helper (`%LOCALAPPDATA%\Roblox\mcp.bat`), 18 workspace tools. Protocol-identical to or-core 1.18, so the extension needs no change.
* **Desktop window** — pure Rust (eframe/egui), 6 pages: **Home** (setup checklist that tells you the next step, status cards, live Studio viewport snapshot, quick access, recent activity), **Explorer** (workspace browser + editor), **Tools** (Studio + workspace tool catalog with a Run panel), **Servers** (Studio MCP, local bridge, channels), **Terminal** (workspace shell *and* a Luau runner that executes code inside Roblox Studio), **Settings** (workspace folder picker applied live, MCP launcher override, diagnostics, about). Closing the window hides it to the notification area; the bridge keeps running until you choose **Quit** from the tray menu.

Keyboard: `Esc` close panel / clear search · `Ctrl+1…6` pages · `Ctrl+R` restart Studio MCP · `F5` probe Studio + refresh tools · `Ctrl+Shift+S` Studio snapshot · `Ctrl+S` save file · `Ctrl+Enter` run Luau.

## Build

Requirements: Rust stable (MSVC toolchain on Windows) from <https://rustup.rs>.

```powershell
cd ORscript\agent
cargo build --release
# -> target\release\or-core.exe
copy target\release\or-core.exe ..\bin\or-core.exe
```

Or double-click `ORscript\Build-ORscript-Desktop.cmd`, which runs the same steps.

The first build downloads the crates (eframe, winit, tokio, axum, …) and takes a few minutes; later builds are incremental.

## Run

| Command | Effect |
|---|---|
| `or-core.exe` | Opens the desktop window (and the tray icon). Double-clicking again focuses the running instance. |
| `or-core.exe --hidden` | Starts straight into the tray (used by *Launch at sign-in*). |
| `or-core.exe --headless` | Bridge only, no window, no tray (servers / autostart scripts). |
| `or-core.exe --workspace D:\Projects\MyGame` | AgentScript root for this run. |

Environment overrides (same as before): `OR_WORKSPACE_ROOT`, `OR_FULL_ACCESS=1`, `OR_MCP_COMMAND`.

## Files written next to the binary

* `settings.json` — theme, close-to-tray, start hidden, launch at sign-in, workspace root, MCP launcher override, FULL PC ACCESS.
* `logs\agent.log` — append-only bridge log (also shown in the Terminal page).

## Layout

```
agent/
  Cargo.toml          crate or-agent, binary name or-core
  src/main.rs         bridge: HTTP/WS servers, Studio MCP client, UI command loop
  src/workspace.rs    AgentScript workspace engine (18 tools, sandbox rules)
  src/gui.rs          desktop window, theme, pages, tray icon
```

The Tools page lists the Studio tools reported live by the MCP helper plus the built-in workspace tools, so there is nothing to re-sync when the extension changes.
