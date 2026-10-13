# ORscript Desktop

The workspace app for ORscript. It is the native bridge between the ORscript
browser extension and your machine — Roblox Studio (MCP), the AgentScript
workspace folder and any extra MCP servers — wrapped in a desktop window with
live status, a tool catalog, an explorer, a terminal and settings.

Closing the window does **not** stop anything: the bridge, the Studio MCP
helper and every extension socket keep running from the tray icon. Quit from
the tray menu when you really want it gone.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  R  ORscript v1.21.0 (Up to date) · Effort: Default              🔔 — ☐ ✕ │
├──────────────┬───────────────────────────────────────────────────────────┤
│ Home         │  Browser AI · Bridge 127.0.0.1:3000 · Desktop tray ready  │
│ Explorer     │  ▸ All supported AIs (23 browser AIs)                     │
│ Tools     22 │  ▸ Work modes & workflows                                 │
│ Toolkit      │  BRIDGE      ROBLOX STUDIO     TOOLS       WORKSPACE      │
│ MCP Servers  │  Linked      Connected         22          Ready          │
│ Skills       │  Quick access              Recent activity                │
│ Templates    │                                                           │
│ Terminal     │                                                           │
│ Updates      │                                                           │
│ Settings     │                                                           │
│ [Kill Roblox Studio]                                                     │
│ ● Bridge linked 127.0.0.1:3000 · ● Studio connected                      │
└──────────────┴───────────────────────────────────────────────────────────┘
```

## What it does

| Port | Purpose | Compatible with |
| --- | --- | --- |
| `http://127.0.0.1:3000` | extension REST API (`/api/status`, `/api/connect`, `/api/push`, `/api/poll`, `/api/result`, `/api/local-full`), `/ws` result stream, and the app UI at `/app/` | `bin/or-core.exe` |
| `ws://127.0.0.1:17613` | **RS** engine socket — Roblox Studio MCP (+ custom MCP servers merged in) | `bin/or-core.exe` |
| `ws://127.0.0.1:17615` | **AS** engine socket — AgentScript workspace (18 native tools) | `bin/or-core.exe` |

The protocol is a faithful port of `ORscript/agent/src/main.rs` and
`workspace.rs`: same message types (`connected`, `ping/pong`, `list_tools`,
`studio_status`, `restart_mcp`, `call_tool` → `tool_result`), same error codes
(`COMMAND_NOT_FOUND`, `INVALID_ARGUMENT`, `STUDIO_BRIDGE_OFFLINE`,
`TOOL_EXECUTION_ERROR`, `UNKNOWN_BRIDGE_MESSAGE`), same tool names and output
formats (`LINE | content`, `[dir ] name/ (n items)`, `$ command` …), same
sandbox rules (workspace-relative paths, FULL PC ACCESS for absolute paths and
`process_kill`), same limits (2 MB reads, 40 K chars, 60 s / 600 s command
timeouts, 100 grep hits, 200 MB downloads). The extension does not need any
change — it simply finds the bridge on the usual ports.

Beyond or-core:

- **Studio MCP lifecycle** — spawns `%LOCALAPPDATA%\Roblox\mcp.bat` (override in
  Settings or with `OR_MCP_COMMAND`), probes `get_studio_state`, restarts a dead
  helper once and retries the call, watches the `RobloxStudio` process every
  5 s, and can terminate Studio (sidebar button / tray).
- **Custom MCP servers** — `add_server` / `remove_server` from the extension are
  now supported (or-core rejected them). Add any stdio MCP server on the
  *MCP Servers* page; its tools appear in the RS catalog tagged with the server id.
- **Port hygiene** — stale `or-agent` / `or-core` / python bridges on 3000,
  17613 or 17615 are evicted; anything else holding a port is reported on Home
  (PlazCode also uses 3000 — close it first).
- **Workspace app** — Home status cards, Explorer with editor, Tools catalog
  with RS / AS / MCP filters, Toolkit (run any tool, diagnostics), Skills (633
  virtual commands synced from the extension), Templates (production Luau
  starters you can export into the workspace), Terminal (live log + command
  runner), Updates (GitHub releases), Settings (theme, workspace, Studio MCP,
  tray behaviour, log level).

## Install (Windows)

The Windows installer and a portable `.exe` are produced by the GitHub Actions
workflow **ORscript Desktop (Windows build)** (`.github/workflows/desktop.yml`)
on every push that touches this folder, and attached to GitHub Releases for
`desktop-v*` tags.

1. GitHub → **Actions** → *ORscript Desktop (Windows build)* → latest run →
   **Artifacts** → `ORscript-Desktop-windows`.
2. Run `ORscript Desktop-1.21.0-x64-win.exe` (installer, per-user, creates a
   Start-menu and desktop shortcut) or the `-portable.exe`.
3. Start it. The tray icon appears, the bridge binds the three ports and the
   window opens on *Home*. Enable **Studio → Assistant AI → ⋯ → Manage MCP
   Servers → Enable Studio as MCP Server** once; the *ROBLOX STUDIO* card turns
   green when a place is open.

### Run from source

Needs Node.js 18+ (https://nodejs.org).

```
Start-ORscript-Desktop.cmd        # installs deps on first run, launches the app
Start-ORscript-Bridge.cmd         # headless bridge only (no window / tray)
Build-Windows-Installer.cmd       # npm ci + tests + electron-builder → release\*.exe
```

or directly:

```
npm install
npm start                 # electron .
npm run start:hidden      # start minimized to the tray
npm run bridge -- --workspace D:\Games\MyPlace --full-access
npm test
npm run dist              # Windows installer + portable
```

## Background mode

- Close (✕) → window hides, tray icon stays, bridge keeps serving.
  A one-time notification explains this the first time.
- Tray menu: Open ORscript · Open workspace folder · Restart Studio MCP ·
  Kill Roblox Studio · Launch at sign-in · Close window to tray · **Quit**.
- *Settings → Background & tray*: start minimized, launch at Windows sign-in
  (uses `--hidden`), or turn *close to tray* off so ✕ quits.
- Single instance: launching a second copy focuses the running window.

## Layout

```
ORscript-Desktop/
├─ electron/      main.js (window, tray, IPC, single instance)  preload.js (safe API)
├─ bridge/        server.js (HTTP + 3 WebSocket servers, extension + app API)
│                 studio.js (Studio MCP runtime, process watcher, kill)
│                 mcp-client.js (stdio JSON-RPC client)  workspace.js (18 AgentScript tools)
│                 settings.js  log.js  ports.js  cli.js (headless entry)
├─ ui/            index.html  app.css  app.js  (vanilla, served at /app/)
├─ data/          skills.json · templates.json · ais.json  (npm run sync-catalog)
├─ scripts/       sync-catalog.js + templates/*.lua
├─ assets/ build/ gold-R icons (png / ico / tray)
└─ test/          node:test suite (workspace sandbox, protocol, HTTP, MCP servers)
```

Data lives in `%APPDATA%\ORscript Desktop\` (`settings.json`, `logs\agent.log`
with 5 MB rotation). Override with `ORSCRIPT_DATA_DIR`.

### Environment variables

| Variable | Effect |
| --- | --- |
| `OR_WORKSPACE_ROOT` / `ROBLOXSCRIPT_WORKSPACE_ROOT` | default workspace root (else `%USERPROFILE%\ORWorkspace`) |
| `OR_FULL_ACCESS=1` | start with FULL PC ACCESS on |
| `OR_MCP_COMMAND` / `ROBLOXSCRIPT_MCP_COMMAND` | Studio MCP helper command |
| `ORSCRIPT_DATA_DIR` | settings + logs directory |

## Tests

`npm test` runs 17 tests with a fake Studio MCP helper (`test/fixtures/fake-mcp.js`):
or-core-compatible HTTP/WS protocol, tool routing, dead-helper retry, payload
queue, app API, custom MCP server lifecycle and the AgentScript sandbox.
