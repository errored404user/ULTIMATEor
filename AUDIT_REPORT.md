# ULTIMATEor — Repository Scan & Codebase Audit

**Repository:** `errored404user/ULTIMATEor` @ `38b6c30` (`main`, single commit "Add files via upload")
**Audit date:** 2026-10-12 · **Auditor:** Arena.ai Agent Mode
**Scope:** Everything reachable in the repository. Archives were extracted to `/tmp/audit` (outside the repo) for read-only inspection; no existing repository file was modified. This report is the only file added.

---

## A. Executive Summary

The repository is **not a source tree — it is two ZIP archives committed to Git** (`ORscript.zip`, 6.0 MB; `PlazCode-1.24.12.zip`, 20.1 MB). Inside them are two closely related products:

| Archive | What it is | Version |
|---|---|---|
| `ORscript.zip` | A Chromium MV3 extension ("ORscript") + Rust native-bridge source (`agent/`, crate `or-agent` 1.18.3) + prebuilt `bin/or-core.exe` + Python/PowerShell Blender/Studio helpers + 44 Node tests | ext 1.19.6 |
| `PlazCode-1.24.12.zip` | The upstream **PlazCode** release package: Chrome + Firefox extensions, `PlazCode.exe` (desktop app/bridge, **binary only, no source**), Engram 3.0.0 runtime binary, updater scripts, docs | 1.24.12 |

ORscript is a **derivative fork of PlazCode** (`animlib.js` differs by 2 lines, `agent_skills.js` by 0, `studio_skills.js` by 148 of 3,242; ORscript never mentions PlazCode). Both turn an AI chat website (ChatGPT, Claude, Gemini, DeepSeek, …) into an autonomous agent that drives Roblox Studio (via MCP) and a local filesystem + terminal (via a local Rust bridge on `127.0.0.1:3000 / 17613 / 17615`).

### Most important discoveries

1. **CRITICAL (F-01)** — ORscript's native bridge exposes **unauthenticated command execution to any web page**. `or-agent` accepts WebSocket connections on `127.0.0.1:17615` with no token and no Origin check and dispatches `run_command` (`cmd /C …` / `sh -c …`). `/api/local-full` (enables FULL PC ACCESS) sits behind `CorsLayer::allow_origin(Any)`. Confirmed in `agent/src/main.rs`; the shipped `bin/or-core.exe` carries the same route set and no pairing strings. PlazCode 1.24.12 added pairing auth for exactly this surface; ORscript did not.
2. **HIGH (F-02)** — In both products the default permission mode is `"sandbox"`, and `run_command` is only confirmed with the user in `"ask"` mode. Any AI reply (steerable by prompt injection in whatever the AI reads) can therefore run arbitrary shell commands with **no confirmation**. The path sandbox applies only to the file tools; the shell can `cd` anywhere.
3. **HIGH (F-03)** — PlazCode's `tab_read` / `tab_click` / `tab_type` / `tab_scroll` tools operate on **any open tab** (`host_permissions: https://*/*`, `http://*/*`) and are **not in the approval list in any permission mode**. The AI can read, type into and submit forms on the user's other authenticated tabs.
4. **HIGH (F-04)** — The shipped PlazCode package **fails its own integrity manifest**: `SHA256SUMS.txt` does not match `PlazCode.exe`, `Update-PlazCode.ps1`, or `Updater-Progress.cs` (verified; not a line-ending artifact). `PlazCode.exe` has no source in the package, so what it does cannot be audited.
5. **MEDIUM (F-05/F-06)** — Roblox account actions with the user's session cookies (`developer_product_create`, universe lookups) are triggered from AI output; the publish gate can be permanently disabled by one stored flag, and `requestApproval()` **auto-allows** when its UI nodes are missing.
6. **Repository hygiene (F-20…F-23)** — no README, CI, `.gitignore`, or source at root; 26 MB of ZIPs containing ~42 MB of Windows binaries are version-controlled; nothing is buildable or testable without unzipping.

### Checks in one line
`node --check` on all 279 JS files: **0 syntax errors**. ORscript Node tests (from the ORscript root): **36 pass / 8 fail** (6 are brittle source-string assertions against stale expectations, 1 needs a live bridge, 1 asserts UI text). PlazCode's shipped `bridge-pairing.cjs` **cannot run** in the shipped layout. Rust crate **not built** (no `cargo` in sandbox). All 121 Python files compile; `tests/test-launcher.py` 2/2 pass. No committed secrets found.

---

## B. Repository Inventory

### B.1 Git level
```
/                      (no README, .gitignore, LICENSE, CI, or manifest)
├── ORscript.zip             6,027,994 B   sha256 d0eb685e…b6061
└── PlazCode-1.24.12.zip    20,135,172 B   sha256 c717849e…a32e7
```
One commit, one author, both ZIPs tracked as blobs. `ORscript/.gitignore` inside the archive itself excludes `*.zip`.

### B.2 `ORscript.zip` → `ORscript/` (159 files, 13.1 MB)
| Area | Contents | Notes |
|---|---|---|
| `manifest.json` | MV3, v1.19.6, `minimum_chrome_version 111` | permissions `storage, unlimitedStorage, activeTab, tabs, alarms`; host_permissions include **`<all_urls>`**, `http://*/*`, `https://*/*` |
| `background.js` | 1,990 lines | service worker: WS client to bridge, Roblox cookie-auth calls, `web_fetch`/`web_search`, Figma bridge |
| `src/core/` | `main.js` 8,558 lines / 579 KB; `config.js`, `parser.js`, `animlib.js`, `studio_bridge.js`, `command_registry.js`, `template_registry.js`, `project_*`, `screenshot.js`, `figma_*`, `ui_collision_manager.js` | content-script agent loop + overlay UI |
| `src/core/skills/` | 10 files ≈ 580 KB | tool catalogs |
| `src/core/*.js` shims | 7 files of 218–222 B | `require()` forwarders → **dead in the browser** |
| `src/providers/` | 17 site adapters | DOM scraping/typing per AI site |
| `src/integrations/` | `figma_bridge.js`, `figma-plugin/` | Figma plugin bridge |
| `agent/` | Rust crate `or-agent` 1.18.3 — `main.rs` 923 L, `workspace.rs` 1,068 L, `gui.rs` 49 L, `Cargo.{toml,lock}` | axum 0.7 HTTP + tungstenite WS; file/terminal tools |
| `bin/or-core.exe` | 8.7 MB | strings: `or-agent v1.18.3`, same `/api/*` routes as source |
| `tools/` | 5 `.py`, 2 `.ps1` | Studio MCP launcher, Blender MCP bridge |
| `tests/` | 44 Node scripts + `test-launcher.py` | no runner; cwd-sensitive |
| misc | `docs/` (2 md + 2 `.rbxm`), `ui/`, `assets/`, `overlay.css` 345 KB, `popup.*`, `config.json`, `LICENSE` GPL-3.0, `README.md` | |

### B.3 `PlazCode-1.24.12.zip` → `PlazCode/` (1,015 files, 49.4 MB)
| Area | Notes |
|---|---|
| Root | Chrome extension unpacked at root (`manifest.json` v1.24.12, `background.js` 2,534 L, `core/` 40 files, `providers/` 19 files, `popup.*`, `ollama.html` + `ollama-page.js`, `overlay.css`) |
| `PlazCode-Extension/` | **Byte-identical copy** of the root extension (only `ollama-page.js` differs: un-minified) + `starter-skills/` (SyphoDev Roblox packs: 115 `.py`, `.lua`, `.md`) + `ultragui/` (335 PNG, 165 SVG, fonts) |
| `PlazCode-Extension-Firefox/` | Same files; only `manifest.json` differs (`background.scripts`, extra `world: MAIN` `firefox-events-main.js`, `gecko.strict_min_version 140.0`, `data_collection_permissions: websiteContent, personalCommunications, browsingActivity, websiteActivity`) |
| `PlazCode.exe` 11.5 MB, `WebView2Loader.dll` | Desktop app + bridge. **No Rust source**; `SOURCE.txt` points to GitHub `stoveez/PlazCode` release |
| `runtime/engram/engram-windows-amd64.exe` 21.5 MB | Third-party MIT memory engine; its `SHA256SUMS.txt` lists upstream *archives*, not the shipped `.exe` → unverifiable locally |
| Updater | `Update-PlazCode.{bat,ps1}`, `Updater-Progress.cs`, `Setup-Mcp-Runtime.ps1`, `update-source.json` — HTTPS feed → SHA256 → GitHub release cross-check (sound design) |
| Helpers | `*.py`, `*.ps1` — same family as ORscript `tools/` but **diverged** (`blender_ops.py` 1,343 changed lines) |
| Dev tests | `bridge-pairing.cjs` (broken in this layout), `firefox-transfer-check.js` (needs Selenium + Firefox) |
| Docs | `README.md` 90 KB changelog (newest heading 1.22.1), `MAINTENANCE.md` 86 KB, `UPDATE.txt`, `UPDATER.txt`, `VALIDATION.txt`, `release-notes.json` 133 KB, `BRANDING-NOTICE.txt`, `THIRD-PARTY-NOTICES.txt`, `LICENSE` GPL-3.0 |

### B.4 Technologies present
JavaScript (MV3 extension; no bundler, no `package.json`, no lint/TS) · Rust (tokio, axum, tungstenite, reqwest/rustls, sysinfo, clap) · Python 3 stdlib · PowerShell 5.1 + C# WinForms · Luau · prebuilt Windows PE binaries.

### B.5 Exclusions (recorded)
Binaries (`.exe/.dll/.rbxm`, images, fonts) inspected only via `strings`/hashes · `starter-skills/**`, `ultragui/**` validated (compile/JSON) but not line-reviewed · changelogs skimmed · minified provider adapters reviewed by targeted grep.

---

## C. Architecture Map

```
Browser (Chrome / Firefox)                                 Local machine (Windows-first)
┌──────────────────────────────────────────────┐           ┌──────────────────────────────────────┐
│ AI chat tab (chatgpt.com, claude.ai, …)      │           │ or-agent / PlazCode.exe (Rust)       │
│  content scripts (isolated world):           │           │  HTTP 127.0.0.1:3000  /api/*          │
│   providers/<site>.js  read & type chat DOM  │           │  WS   127.0.0.1:17613 (roblox engine) │
│   core/parser.js       AI text → tool calls  │  chrome.  │  WS   127.0.0.1:17615 (local engine)  │
│   core/main.js         agent loop, approval  │ runtime   │   ├─ McpRuntime: spawns %LOCALAPPDATA%│
│   core/skills/*        tool catalog/Luau gen │ messages  │   │   \Roblox\mcp.bat (stdio JSON-RPC) │
│   core/tool-guard.js   schema validation     │◄────────► │   │   → Roblox Studio                  │
│  MAIN-world shims (fetch taps per site)      │           │   └─ workspace.rs: read/write/edit/   │
└──────────────┬───────────────────────────────┘           │       delete/move/grep/run_command/   │
               │ chrome.runtime.sendMessage                 │       process_kill/download/open      │
┌──────────────▼───────────────────────────────┐  WS/HTTP  │  (PlazCode.exe only: /api/pair,       │
│ background.js (service worker)               │◄────────► │   memory, engram, templates, blender, │
│  ONE WebSocket per engine → bridge           │           │   desktop UI, updater, …)             │
│  pending Map<id,{resolve,timer}>             │           └──────────────────────────────────────┘
│  web_fetch / web_search (DDG, Wikipedia…)    │  https
│  Roblox APIs with user cookies (CSRF dance)  │◄────────► apis/develop/auth/users.roblox.com
│  PlazCode: tab_read/click/type on ANY tab    │           Blender MCP (via Python helpers)
│  PlazCode: pairing key in storage.local      │           Ollama 127.0.0.1:11434
└──────────────────────────────────────────────┘
```

**Start-up path.** `manifest.json` injects ~23–33 content scripts at `document_idle` into the AI site; `core/main.js` mounts an overlay bar, loads `permMode` from `chrome.storage.local` (default `"sandbox"`), and on **Start agent** injects a system prompt (tool catalog) into the chat. `background.js` connects a WebSocket to the bridge (`engineUrl()` → 17613 or 17615), receives a `connected` intro with the tool list, and keeps a heartbeat.

**Tool-call path.** AI reply text → `core/parser.js` extracts fenced/structured tool calls → `core/main.js` `runTool()` applies: blocked-tool list → `process_kill` requires `full` → `PUBLISH_OPS` approval unless `rsAllowPublishAutomation` → `ASK_OPS` approval only if `permMode === "ask"` → `bg({type:"call_tool"…})` → `background.js` `send()` over WS with `requestId` → Rust `handle_legacy_ws` `"call_tool"` → `workspace::dispatch` (local) or `roblox_tool` → MCP → Studio. Result text is typed back into the chat composer; the loop repeats.

**State.** Extension: `chrome.storage.local` (`rsPermMode`, `rs-local-full`, `rsAllowPublishAutomation`, templates, PlazCode `plazcode-pairing-key`), in-memory `pending` map and reconnect counters in the service worker. Bridge: `AppState` (`Arc<Mutex<…>>` queues, client maps, `AtomicBool` full-access flag). No database.

**Error propagation.** Rust → JSON `{type:"tool_result", ok:false, errorCode, error}` → background maps to `STUDIO_TIMEOUT` / `BRIDGE_PROTOCOL_ERROR` etc. → content script returns an `ERROR: …` string **to the AI** (the AI is the error handler).

**Critical / coupled modules.** `core/main.js` (8.5–10.6 k lines) is the god module: UI, agent loop, permission policy, template system, Figma, project import. `background.js` is the second single point of failure (one WS, one `pending` map, Roblox auth, web fetch, tab automation). `agent/src/main.rs` owns all three listeners and the MCP child. Circular dependencies: none at module level (globals via `window.*` instead).

---

## D. Critical Findings (highest priority first)

| ID | Sev | Conf | Title |
|---|---|---|---|
| F-01 | Critical | Confirmed | ORscript bridge: unauthenticated WS/HTTP → arbitrary command execution from any web page |
| F-02 | High | Confirmed | Default "sandbox" mode executes `run_command` without user confirmation (both products) |
| F-03 | High | Confirmed | PlazCode `tab_*` tools act on any tab with no approval and `https://*/*` host access |
| F-04 | High | Confirmed | PlazCode package integrity manifest does not match shipped files; desktop binary has no source |
| F-05 | Medium | Confirmed | `requestApproval()` auto-allows when approval UI is missing; publish gate is one flag away from off |
| F-06 | Medium | Strongly supported | AI-triggered Roblox account mutations use the user's live session cookies (CSRF-token-via-logout trick) |
| F-07 | Medium | Confirmed | `run_command` timeout kills `cmd.exe` but not its children (no job object) |
| F-08 | Medium | Confirmed | PlazCode background polls the bridge ≈3 req/s forever while connected |

---

## E. Complete Findings Register

Paths are relative to the extracted archive roots (`ORscript/` or `PlazCode/`).

### F-01 — Unauthenticated local bridge grants shell execution to any origin
- **Severity:** Critical · **Confidence:** Confirmed (source + binary strings)
- **Files:** `ORscript/agent/src/main.rs` — `run_server()` L558 (`CorsLayer::new().allow_origin(Any)…allow_headers(Any)`), `local_full_handler()` L626–631, `run_legacy_ws()` L733–742 (`tokio_tungstenite::accept_async(stream)` with no handshake callback), `handle_legacy_ws()` `"call_tool"` L874–905; `ORscript/agent/src/workspace.rs` `tool_run_command()` L634, `run_shell()` L677–702. `ORscript/background.js` L311/L886 (`new WebSocket(url)` — no subprotocol/token). `ORscript/bin/or-core.exe` (strings: routes `/api/connect|poll|push|result|disconnect|status|local-full`, no `/api/pair`).
- **Problem:** Nothing identifies the caller. Any page the user visits can `new WebSocket("ws://127.0.0.1:17615")`, receive the tool catalog in the `connected` frame, and send `{"type":"call_tool","name":"run_command","arguments":{"command":"…"}}`. Separately a cross-origin `POST http://127.0.0.1:3000/api/local-full {"enabled":true}` passes CORS preflight and switches the file tools to absolute-path (whole-disk) mode. `ws://127.0.0.1` is exempt from mixed-content blocking on HTTPS pages.
- **Conditions:** `or-core.exe` running (the documented setup) + user visits a malicious or compromised page. Chrome's Local-Network-Access prompt (recent versions) may interpose a one-click permission prompt; Firefox has none. The HTTP `/api/local-full` endpoint also has no auth for non-browser local callers (any local process, any user on a shared machine).
- **Impact:** Remote code execution as the logged-in user; full filesystem read/write/delete; `download_file` + `open_path` chain.
- **Repro (safe, local):** start `or-core.exe --headless`; from any page console: `const w=new WebSocket("ws://127.0.0.1:17615");w.onmessage=e=>console.log(e.data);w.onopen=()=>w.send(JSON.stringify({type:"call_tool",id:1,name:"run_command",arguments:{command:"whoami"}}))`.
- **Fix:** Port PlazCode's model: (1) on first run generate a 32-byte key, store it in the user profile, expose it only to the extension via a pairing route that checks `Origin: chrome-extension://<id>` / `moz-extension://…`; (2) require `Authorization: Bearer` on every HTTP route and `Sec-WebSocket-Protocol: plazcode-auth.<key>` on WS upgrade (`accept_hdr_async` with a callback that rejects otherwise); (3) replace `allow_origin(Any)` with an explicit extension-origin allowlist; (4) reject any request whose `Origin` is an `http(s)://` web origin; (5) bind `/api/local-full` to an additional confirmation in the desktop/tray, not just the extension.
- **Related:** F-02, F-05. **Regression test:** Rust integration test: WS upgrade without the auth subprotocol → 401/close; HTTP POST `/api/local-full` with `Origin: https://evil.example` → 403.

### F-02 — Default permission mode does not gate shell/terminal execution
- **Severity:** High · **Confidence:** Confirmed
- **Files:** `ORscript/src/core/main.js` L66 (`let permMode = "sandbox"`), L140–162 (`ASK_OPS` includes `run_command`, `delete_path`, `download_file`, `open_path`), L2281–2285 (`else if (permMode === "ask" && ASK_OPS.has(bareName))`); `PlazCode/core/main.js` L99, L257, L2479–2481 (same logic). Rust side: `workspace.rs` `run_shell` runs `cmd /C <command>` with `current_dir(ws.canon_root)` — no command filtering, no sandboxing, and `full_access` is **not** consulted.
- **Problem:** "Sandbox" is a *path* sandbox for `read_file`/`write_file`/… only. Shell commands run unconfined (`cd C:\ && del …`, `powershell -enc …`). Confirmation is requested only in `"ask"` mode; the default mode asks for nothing.
- **Conditions:** Any session where the AI emits `run_command` — including after the AI ingests attacker-controlled text (web page via `web_fetch`, file in the workspace, Roblox asset description, pasted content).
- **Impact:** Prompt-injection → arbitrary code execution without a human in the loop.
- **Fix:** Make `run_command`, `process_kill`, `download_file`, `open_path`, `delete_path`, `move_path` **always** require approval unless the user explicitly opts into an "unattended" mode with a clear warning; in the Rust bridge, honour a server-side policy (e.g. refuse `run_command` while `full_access == false` unless the request carries a per-call approval token), so a compromised content script cannot bypass the UI gate. Consider an allowlist of interpreters/binaries for sandbox mode.
- **Regression test:** content-script unit test: with `permMode="sandbox"`, `runTool("run_command")` must call `requestApproval` (or return `USER_ACTION_REQUIRED`).

### F-03 — PlazCode browser-tab automation tools have no approval gate and reach any site
- **Severity:** High · **Confidence:** Confirmed
- **Files:** `PlazCode/manifest.json` `host_permissions` (`"https://*/*"`, `"http://*/*"`), `permissions: ["scripting"]`; `PlazCode/background.js` `resolveTab()` L2505–2520 (`chrome.tabs.query({})` + `url_contains` substring match), `case "tab_read"` L2376, `"tab_click"` L2410, `"tab_type"` L2442 (`chrome.scripting.executeScript` with `submit` → Enter), `"tab_scroll"` L2475; `PlazCode/core/main.js` L2548–2590 (handlers) vs. `ASK_OPS` L257 (no `tab_*` entries).
- **Problem:** The AI can select any tab by URL substring (`url_contains:"mail"`), dump up to 4,000 chars of page text plus all clickable labels into the chat transcript (which is sent to the AI vendor), type into inputs and submit forms. No permission mode gates this; `permMode` is never consulted for `tab_*`.
- **Impact:** Cross-site data exfiltration and action-on-behalf (webmail, banking, admin consoles) via prompt injection; also a privacy disclosure to the AI provider.
- **Fix:** Put `tab_read/tab_click/tab_type/tab_scroll` behind mandatory approval showing the target URL; restrict `resolveTab` to an explicit user-chosen tab (picker) or a per-session allowlist of origins; never target tabs whose URL is not http(s) or that are in a different profile window; redact password/credit-card fields in `tab_read`.
- **Regression test:** `tab_type` against a tab whose origin was not approved must return `USER_ACTION_REQUIRED`.

### F-04 — Package integrity manifest mismatch; desktop binary unauditable
- **Severity:** High · **Confidence:** Confirmed
- **Files:** `PlazCode/SHA256SUMS.txt` vs. `PlazCode.exe` (expected `83e76c6a…`, actual `c472282b…`), `Update-PlazCode.ps1` (expected `5bceed43…`, actual `2a31afdc…`), `Updater-Progress.cs` (expected `1cca0eb9…`, actual `490ba29e…`). `WebView2Loader.dll` and `Setup-Mcp-Runtime.ps1` match. CRLF/LF/BOM variants were hashed; none match. `runtime/engram/SHA256SUMS.txt` lists upstream archive hashes, not the shipped `engram-windows-amd64.exe` (`743037ca…`), so it cannot be verified either.
- **Problem:** Three of five manifest entries — including the main executable and the updater that runs with `-ExecutionPolicy Bypass` — do not correspond to the shipped bytes. `VALIDATION.txt` states "Installer checksums … passed", which cannot be true for this package. There is no source for `PlazCode.exe`; `SOURCE.txt` defers to an external GitHub release and `gh attestation verify`.
- **Impact:** Users cannot distinguish an official build from a tampered one; the audit cannot assess the bridge's auth (`/api/pair`), origin checks, or the ~40 `/api/*` routes the binary exposes (strings list `/api/shutdown`, `/api/desktop/kill-studio`, `/api/media/convert`, `/api/templates/upload`, …).
- **Fix:** Regenerate `SHA256SUMS.txt` from the exact release artefacts in CI; include `engram-windows-amd64.exe`; ship or link a provenance attestation for the specific `PlazCode.exe` hash; vendor the bridge source (or a pinned Git submodule) alongside the extension so forks (ORscript) inherit security fixes.
- **Regression test:** CI step `sha256sum -c SHA256SUMS.txt` on the assembled package.

### F-05 — Approval dialog fails open; publish gate is a single persistent flag
- **Severity:** Medium · **Confidence:** Confirmed
- **Files:** `ORscript/src/core/main.js` `requestApproval()` L165–189 — L171 `if (!root || !allow || !deny) { resolve(!required); return; }`; L163 `PUBLISH_OPS`; L164 `publishAutomationEnabled()` reads `rsAllowPublishAutomation`; L177 `body.innerHTML = \`<b>${op}</b>…\`` (op unescaped; `preview` is escaped). `PlazCode/core/main.js` `requestApproval()` L280 (same pattern).
- **Problem:** If the `#rs-approve` nodes are absent (overlay not yet mounted, removed by the host page's re-render, or CSS/DOM collision — `ui_collision_manager.js` exists precisely because host pages fight the overlay), non-publish approvals resolve **true**. Once `rsAllowPublishAutomation` is set, every Roblox cloud mutation is unattended.
- **Impact:** Silent bypass of the only human-in-the-loop control; monetisation changes without confirmation.
- **Fix:** Fail closed (`resolve(false)` + visible toast) when the dialog cannot render; re-mount the dialog on demand; escape `op`; make `rsAllowPublishAutomation` time-boxed or per-session.
- **Regression test:** remove `#rs-approve` from DOM, call `requestApproval("run_command",{})` → must resolve `false`.

### F-06 — Roblox account mutations ride the user's browser session
- **Severity:** Medium · **Confidence:** Strongly supported (code confirmed; live behaviour not exercised)
- **Files:** `ORscript/background.js` `robloxCsrf()` L1338–1345 (`POST https://auth.roblox.com/v2/logout` with `credentials:"include"` to harvest `x-csrf-token`), `robloxAuthedFetch()` L1346–1366, `robloxResolveUniverse()` L1367–1400 (`develop.roblox.com/v1/user/universes`), `robloxCreateDevProduct()` L1401+ (`apis.roblox.com/developer-products/...`), `creatorAssetInfo()`. PlazCode has the same `auth.roblox.com/v2/logout` call (`providers`/`background.js`).
- **Problem:** The extension performs authenticated state changes on roblox.com with ambient cookies on instruction from AI text. The CSRF-token trick depends on Roblox returning 403 + token for an unauthenticated-CSRF logout POST; if Roblox ever accepts the request, the user is logged out. No per-request confirmation beyond F-05's gate.
- **Fix:** Use Open Cloud API keys scoped by the user (or at minimum confirm each mutation with the product name/price), fetch CSRF from a non-destructive endpoint, and show the resolved universe before writing.
- **Regression test:** mock `fetch`; `developer_product_create` with `rsAllowPublishAutomation` unset must not hit `apis.roblox.com` before approval resolves.

### F-07 — `run_command` timeout orphans child processes
- **Severity:** Medium · **Confidence:** Confirmed (code) / behaviour on Windows strongly supported
- **Files:** `ORscript/agent/src/workspace.rs` `run_shell()` L677–689 (`Command::new("cmd").args(["/C", command]).kill_on_drop(true)`), `finish()` L704–710 (`tokio::time::timeout(…, cmd.output())`).
- **Problem:** On timeout the `Child` is dropped and `cmd.exe` is killed, but processes it spawned (node, python, build tools) are not in a Job Object and keep running — with the pipes closed, they can block on a full stdout pipe. The returned text admits "may still have had partial effects". The MCP helper reset path (`main.rs` L216–235) *does* use `taskkill /T`, showing the authors know the pattern.
- **Fix:** On Windows create a Job Object with `KILL_ON_JOB_CLOSE` or run `taskkill /F /T /PID`; on Unix spawn in a new process group and `kill(-pgid)`.
- **Regression test:** `run_command` `"cmd /C start /B ping -n 60 127.0.0.1"` with `timeout_seconds:1` → no `ping.exe` remains.

### F-08 — Continuous high-frequency polling in PlazCode service worker
- **Severity:** Medium · **Confidence:** Confirmed
- **Files:** `PlazCode/background.js` L208 (`setInterval(debugUpload, 5000)`), L1013 (`setInterval(reportDesktopAgentState, 750)` → `tabs.query` + `tabs.sendMessage` + `windows.getLastFocused` + `POST /api/desktop/browser-agent` each tick), L1900 (`setInterval(readReleaseStatus, 1000)` → `GET /api/desktop/update`), L2528 (`refreshProcStatus` every 5 s), heartbeat L648.
- **Impact:** ≈3 HTTP requests/s and ≈1.3 cross-process tab messages/s for as long as the bridge is up — CPU/battery cost, log noise, and it masks real liveness problems. `readReleaseStatus` hits an *update* endpoint once per second.
- **Fix:** Push state changes from the content script on change; back off `reportDesktopAgentState` to 2–5 s when nothing changed; poll update status every few minutes or on demand.

### F-09 — Service worker is the single owner of in-flight requests; restarts drop them
- **Severity:** Medium · **Confidence:** Strongly supported
- **Files:** `ORscript/background.js` L99 (`const pending = new Map()`), L482–505; `PlazCode/background.js` equivalent. ORscript uses `chrome.alarms` (`or-keep`, 1 min) as keep-alive; PlazCode lacks the `alarms` permission and relies on timers/WS traffic.
- **Problem:** MV3 workers are terminated when idle or after ~5 min hard limit in some Chrome versions; any `pending` tool call is lost and the content script sees a timeout. Long Studio tools (`REQUEST_TIMEOUT_DEFAULT = 130000`) span that window. Both products add "stale socket" recovery but not request replay/idempotency bookkeeping across worker restarts (by design, writes must not replay — so they surface as failures to the AI).
- **Fix:** Persist outstanding `requestId`s in `chrome.storage.session`; on worker start reconcile with the bridge (`/api/status` or a `pending_results` route). Add `alarms` to PlazCode.

### F-10 — Local bridge `/api/push` + `/api/poll` accept unauthenticated Luau for Studio
- **Severity:** Medium · **Confidence:** Confirmed (ORscript source)
- **Files:** `ORscript/agent/src/main.rs` `push_handler()` L606–611, `poll_handler()` L598–605, `handle_ws()` L715–731 (any `{code:…}` text is queued).
- **Problem:** Same CORS-Any surface as F-01; arbitrary Luau can be queued for whatever consumer polls the queue. Subsumed by the F-01 fix but called out because it survives even if `run_command` is gated.

### F-11 — `web_fetch` reaches private networks and the bridge itself
- **Severity:** Low · **Confidence:** Confirmed
- **Files:** `ORscript/background.js` `case "web_fetch"` L1795–1830 (`fetch(url, {headers, redirect:"follow"})`, only `^https?://` check).
- **Problem:** No block of `127.0.0.1`, `169.254.*`, RFC-1918, `.local`; the AI can enumerate `http://127.0.0.1:3000/api/status` or LAN devices. Cookies are not sent (default credentials mode), which limits impact.
- **Fix:** Resolve and reject private/loopback hosts; cap redirects; strip auth headers on redirect.

### F-12 — `agent_skills.js` executes AI-supplied JavaScript via `node -e eval(...)`
- **Severity:** Low (design intent) · **Confidence:** Confirmed
- **Files:** `ORscript/src/core/skills/agent_skills.js` L210 and identical `PlazCode/core/agent_skills.js` L210: `run_command` with `` `node -e "eval(Buffer.from('${b64}','base64').toString())"` ``.
- **Note:** Base64 keeps the shell quoting safe; this is "run JS" by design, but it is another route around any future command allowlist. Should inherit F-02's gating.

### F-13 — Broad host permissions beyond what content scripts need
- **Severity:** Low · **Confidence:** Confirmed
- **Files:** `ORscript/manifest.json` (`<all_urls>`, `http://*/*`, `https://*/*`, `tabs`); `PlazCode/manifest.json` (`https://*/*`, `http://*/*`, `scripting`); `web_accessible_resources` exposing `ui/*.jpg`, `icon.png` to `https://*/*` and (ORscript) `src/core/project_worker.js` to `<all_urls>`.
- **Impact:** Store-review friction; extension fingerprinting by any site; enlarged blast radius if the worker is compromised (F-03). Firefox manifest at least declares `data_collection_permissions` honestly.

### F-14 — Stale/incorrect developer documentation
- **Severity:** Low · **Confidence:** Confirmed
- **Files:** `ORscript/README.md` L47–57 lists `node test-skills.js …` but tests live in `tests/` and must run from the repo root (`node tests/test-skills.js`); README names the crate `or-agent` while the shipped binary is `bin/or-core.exe`; `PlazCode/README.md` newest heading is 1.22.1 for a 1.24.12 package (changelog not updated; `release-notes.json` is).

### F-15 — Test suite is largely source-string assertions and partly stale
- **Severity:** Low · **Confidence:** Confirmed
- **Files:** `ORscript/tests/test-core-tray.js` (8 FAIL — expects tray/winit code that was removed; `gui.rs` is a 49-line stub), `test-script-read.js` L21 (FAIL — checks for a comment string that was reworded; the behaviour at `background.js` L631–646 exists), `test-roadmap.js`, `test-project-analyzer.js`, `test-project-import-export.js`, `test-v115.js`, `test-work-mode.js` (assert on UI copy), `test-bridges.js` (live-only).
- **Problem:** Most tests `readFileSync` a source file and `includes()` a substring; they neither execute the code nor catch behavioural regressions, and they rot when comments change.

### F-16 — Shipped PlazCode self-test is broken in the package layout
- **Severity:** Low · **Confidence:** Confirmed
- **Files:** `PlazCode/bridge-pairing.cjs` L5 `path.join(__dirname, '../background.js')` resolves **outside** the package; with the path corrected it still throws `ReferenceError: setInterval is not defined` because `background.js` L208 now calls `setInterval` before `const PORT_ROBLOX`, and the vm context provides only `setTimeout/clearTimeout`.

### F-17 — Dead forwarder shims in the extension tree
- **Severity:** Low · **Confidence:** Confirmed
- **Files:** `ORscript/src/core/{studio_100,studio_200,studio_daily,studio_gui,studio_plus,studio_skills,agent_skills}.js` — `module.exports = require("./skills/…")` guarded by `typeof require !== "undefined"`; never executed in the browser, not referenced by `manifest.json`. Only tests benefit; move them to `tests/` or delete.

### F-18 — Duplicate crate versions and release-profile notes
- **Severity:** Informational · **Confidence:** Confirmed
- **Files:** `ORscript/agent/Cargo.lock` — `tokio-tungstenite` 0.24.0 **and** 0.26.2, `tungstenite` 0.24.0 and 0.26.2 (axum 0.7 pins 0.24; `Cargo.toml` requests 0.26). Harmless but inflates the binary. `.cargo/config.toml` forces `+crt-static`; `[profile.release] strip=true` — fine. `cargo audit` could not be run (no cargo / no network to crates.io); versions present (`tokio 1.53.1`, `hyper 1.11.0`, `rustls 0.23.43`, `ring 0.17.14`, `idna 1.1.0`, `url 2.5.8`) are recent.

### F-19 — Slow recursive filesystem scan in the MCP launcher fallback
- **Severity:** Low · **Confidence:** Confirmed
- **Files:** `ORscript/tools/launch_studio_mcp.py` L45–52 `_iter_mcp_candidates` → `root.rglob("StudioMCP.exe")` over `%LOCALAPPDATA%`, `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`; same in `PlazCode/launch_studio_mcp.py`.
- **Impact:** Seconds-to-minutes stall on large installs when `mcp.bat` is missing; no caching. Prefer registry/known paths or bounded depth.

### F-20 — Repository stores ZIP archives, not source
- **Severity:** Medium (process) · **Confidence:** Confirmed
- **Problem:** No diffs, blame, code review, CI, or dependency scanning are possible; every change re-uploads 26 MB; history will bloat; secrets inside archives would be invisible to GitHub secret scanning. Binary payloads (`PlazCode.exe`, `engram-windows-amd64.exe`, `or-core.exe`, `WebView2Loader.dll`, ≈42 MB) are in version control.
- **Fix:** Unpack `ORscript/` into the repo root as the actual source tree (with `.gitignore` for `*.zip`, `agent/target/`, `__pycache__/`); keep upstream PlazCode as a pinned reference (URL + hash) rather than a vendored ZIP; use GitHub Releases/LFS for binaries.

### F-21 — Triplicated extension payload inside the PlazCode package
- **Severity:** Low · **Confidence:** Confirmed
- **Files:** `PlazCode/` root, `PlazCode/PlazCode-Extension/`, `PlazCode/PlazCode-Extension-Firefox/` — 72 identical files ×3 (~3.6 MB each); only `manifest.json` and one `ollama-page.js` differ.
- **Impact:** Any fix must be applied three times; the root copy differs already (minified `ollama-page.js`).

### F-22 — Fork provenance / licence hygiene
- **Severity:** Informational · **Confidence:** Confirmed
- **Observation:** ORscript retains `SPDX-License-Identifier: GPL-3.0-or-later` headers and ships `LICENSE`, satisfying the licence core. It does not mention PlazCode anywhere (`grep -ri plazcode` → 0 hits), while PlazCode's `BRANDING-NOTICE.txt` asks derivatives not to present themselves as official and to keep attribution notices intact. GPL §5 requires that modified files carry prominent notices of modification and date. Recommend adding a NOTICE/README section stating the upstream and version forked, and preserving upstream changelog attribution.

### F-23 — No CI, lint, type-check, or dependency audit anywhere
- **Severity:** Medium (process) · **Confidence:** Confirmed
- **Observation:** No `package.json`, ESLint, TypeScript/JSDoc checks, `cargo clippy/test` workflow, or `pip-audit`. The Node tests have no runner and no exit-code aggregation. `VALIDATION.txt` describes upstream CI that is not present here.

### F-24 — `innerHTML` with interpolated strings in content scripts
- **Severity:** Low · **Confidence:** Confirmed (pattern); exploitability Unverified
- **Files:** `ORscript/src/core/main.js` 22 sites (e.g. L177, L6858), `PlazCode/core/main.js` 30 sites. Most interpolate internal constants or use `escRs()`; L177 interpolates the AI-supplied tool name `op` unescaped. Inline handlers would run in the page world, not the extension world, and host CSPs typically block them, so direct privilege escalation was not demonstrated.
- **Fix:** Escape `op`; prefer `textContent`/`createElement` for anything derived from AI output.

---

## F. Security Assessment

| Area | Status |
|---|---|
| Secrets in source | **None found.** Regex sweep for OpenAI/NVIDIA/Google/GitHub/Slack/Notion tokens and PEM keys across all text files: 0 hits. The only key material is PlazCode's runtime pairing key, stored in `chrome.storage.local` (acceptable) and redacted in debug reports (`debugRedact`, `background.js` L94–104). |
| Local bridge authentication | **ORscript: none (F-01).** PlazCode: pairing via `/api/pair` + `Authorization: Bearer` + WS subprotocol `plazcode-auth.<key>`, server side **unverified** (binary only). Release notes claim origin checks and rejection of webpage origins. |
| Command execution | Design feature in both; unconfirmed by default (F-02); orphaned children (F-07); `node -e eval` wrapper (F-12). |
| Cross-site actions | PlazCode `tab_*` tools (F-03); Roblox cookie-authenticated mutations (F-06); `web_fetch` SSRF-lite (F-11). |
| Injection / XSS | CSP for extension pages is strict (`script-src 'self' 'wasm-unsafe-eval'`); no inline scripts in `popup.html`/`ollama.html`; `innerHTML` interpolation present (F-24). `new Function` appears only in tests. |
| Supply chain | Updater pins SHA256 and cross-checks GitHub Releases (good); `Setup-Mcp-Runtime.ps1` pins Node 22.22.0 / uv 0.12.21 hashes (good); but the package's own manifest is wrong (F-04) and the Engram binary is unverifiable. Windows binaries unsigned per `VALIDATION.txt`. |
| Permissions | Over-broad host permissions (F-13). Firefox `data_collection_permissions` disclosed. |
| Path traversal | `workspace.rs` `resolve_path()` L90–152 rejects `..` climbs, absolute paths (unless full access), and canonicalises the deepest existing ancestor against the root — unit-tested (`sandbox_rejects_escapes_and_absolute`). Sound for the *file* tools. |
| Deserialisation / dynamic code | `serde_json` only; no `pickle`; Python helpers use `subprocess.call(list)` — no `shell=True`. |

---

## G. Reliability and Performance

- **Single WebSocket + single `pending` map in a killable MV3 worker** (F-09). Reconnect/heal logic is extensive (stale-socket detection, `restart_mcp` throttling, idempotent-retry allowlist `IDEMPOTENT_STUDIO_TOOLS`, "never replay a mutating request") — this is the most mature part of the code.
- **Rust bridge:** one `Mutex<McpRuntime>` serialises all Studio calls; `mcp_in_flight` counter prevents status probes from starving a 20 s `execute_luau`. `poll_handler` long-polls 25 s with 500 ms sleeps. `broadcast::Sender<ExecResult>` — slow WS readers can lag and drop results (`RecvError::Lagged` is treated as loop exit in `handle_ws` L718). `reclaim_port()` kills whatever owns 3000/17613/17615 at boot (Windows) — aggressive on shared ports.
- **Timeouts:** tool default 120 s, `MAX_RUN_TIMEOUT` clamp, `download_file` 120 s, intro 8 s. Timed-out shell children leak (F-07).
- **Polling load:** F-08 (PlazCode) ≈3 req/s; ORscript polls `/api/status` every 5 s only.
- **Memory:** `mcpDiagnostics` capped at 100, debug buffers capped (300/150/6) — good. `history.slice(-20)` in Ollama page — good.
- **Hot paths:** `core/main.js` re-renders the bar on every sweep with a signature check (`lastBarSig`) — fine. `launch_studio_mcp.py` `rglob` (F-19).
- **Platform assumptions:** Windows-first (`cmd /C`, `taskkill`, `%LOCALAPPDATA%\Roblox\mcp.bat`, `CREATE_NO_WINDOW`); Unix branches exist in Rust and Python but are untested here; macOS packaging exists only for PlazCode.

---

## H. Testing and Build Results

| Check | Command / method | Result |
|---|---|---|
| Archive extraction | `unzip` both ZIPs to `/tmp/audit` | OK (159 + 1,015 files) |
| Integrity manifest | `sha256sum -c PlazCode/SHA256SUMS.txt` | **3 of 5 FAILED** (`PlazCode.exe`, `Update-PlazCode.ps1`, `Updater-Progress.cs`); `runtime/engram/SHA256SUMS.txt` references files not shipped |
| JS syntax | `node --check` on every `.js/.cjs/.mjs` (ORscript 97; PlazCode root + Firefox + skills) | **0 failures** |
| JSON validity | `jq empty` on all 28 `.json` | all valid |
| Manifest ↔ files | every `content_scripts[].js`, `background`, WAR entry exists | all present (Chrome, Firefox, ORscript) |
| Python | `python3 -m py_compile` on 121 files | all compile |
| ORscript unit tests | `node tests/*.js` from `ORscript/` root (Node 22.22.3) | **36 pass / 8 fail** — `test-bridges` (needs live bridge), `test-core-tray` (stale: tray removed), `test-script-read` (comment-string assertion), `test-roadmap`, `test-project-analyzer`, `test-project-import-export`, `test-v115`, `test-work-mode` (UI-copy assertions) |
| ORscript tests from `tests/` cwd | `cd tests && node test-skills.js` | 27 crash with `ENOENT` — tests hard-code root-relative paths |
| Python launcher test | `python3 tests/test-launcher.py` | 2/2 OK |
| PlazCode `bridge-pairing.cjs` | `node bridge-pairing.cjs` | **Cannot run** — wrong relative path; after correction, `ReferenceError: setInterval is not defined` |
| PlazCode `firefox-transfer-check.js` | — | **Not run** — requires `selenium-webdriver` + real Firefox (unavailable) |
| Rust build / `cargo test` / `cargo audit` | — | **Not run** — `cargo` not installed; crates.io not reachable from sandbox. 9 unit tests exist in `workspace.rs` (`sandbox_rejects_escapes_and_absolute`, `run_command_captures_and_times_out`, …) |
| Binary inspection | `strings` on `or-core.exe`, `PlazCode.exe` | `or-core.exe` = `or-agent v1.18.3`, routes match source; `PlazCode.exe` exposes `/api/pair` and ~40 routes |
| Secret scan | regex sweep | 0 hits |
| Live bridge / Studio / Blender / AI sites | — | **Not exercised** (no Windows, no Roblox Studio, no network to those hosts) |

---

## I. Missing Coverage

- **No behavioural tests for the permission policy** (`permMode`, `ASK_OPS`, `PUBLISH_OPS`, `requestApproval`) — the most security-relevant code path in `core/main.js`.
- **No tests for the bridge authentication surface** in ORscript (there is none to test); PlazCode's `bridge-pairing.cjs` exists but is broken.
- **No tests for `background.js` request lifecycle** across service-worker restart, WS reconnect mid-tool, or `pending` timeout → late reply.
- **No tests for provider DOM adapters against fixtures** (PlazCode's `VALIDATION.txt` mentions Chromium/Firefox fixtures upstream; none are in the package).
- **Rust:** no integration test for the HTTP/WS server (CORS, auth, `/api/local-full`), only `workspace.rs` units; no test for child-process cleanup on timeout.
- **Python Blender helpers** (`blender_ops.py` ≈ 94 KB) have no tests in either package.
- **Roblox API client** (`robloxAuthedFetch`, CSRF flow, dev-product creation) — untested, un-mocked.
- **Updater PowerShell** — no test harness in the package (upstream claims CI).

---

## J. Root-Cause Analysis

1. **"Trust the loopback" assumption.** F-01, F-10, F-11 and part of F-13 all stem from treating `127.0.0.1` as a security boundary. Browsers deliberately let web content reach loopback over WebSocket; only explicit authentication + origin allowlisting closes it. PlazCode discovered this (pairing in 1.2x); ORscript forked before/without it and shipped the unauthenticated binary.
2. **The AI is treated as a trusted operator.** F-02, F-03, F-05, F-06, F-12 share one model: tool calls parsed from model text are executed with the user's privileges, and confirmation is opt-in. Prompt injection turns every data source the AI reads into a command channel. The fix is a single policy layer (ideally enforced server-side in the bridge) rather than per-tool patches.
3. **Release assembly is not reproducible from this repository.** F-04, F-16, F-20, F-21, F-23 come from committing packaged ZIPs instead of source: hashes drift, tests lose their relative paths, and the same file is maintained in three places.
4. **Fork drift from upstream.** F-14, F-15, F-17, F-22: ORscript carried upstream tests/docs/shims while removing features (tray GUI, pairing), leaving assertions and README commands pointing at code that no longer exists.
5. **Polling instead of events between extension and desktop.** F-08 and F-19 reflect "check again soon" designs where a push/notification or a cached lookup would do.

---

## K. Recommended Repair Roadmap

### 1. Immediate (days)
- **F-01/F-10:** Add pairing-key auth + extension-origin allowlist to `or-agent` (HTTP bearer, WS subprotocol, `accept_hdr_async` origin check), drop `allow_origin(Any)`, rebuild and replace `bin/or-core.exe`. Until then, document that `or-core.exe` must not run while browsing untrusted sites.
- **F-05:** Make `requestApproval` fail closed; escape `op`.
- **F-04:** Regenerate/verify `SHA256SUMS.txt`; do not redistribute the current `PlazCode-1.24.12.zip` as "official".

### 2. High priority (1–3 weeks)
- **F-02:** Mandatory approval for `run_command`, `process_kill`, `delete_path`, `move_path`, `download_file`, `open_path` regardless of mode; add a server-side policy check in the bridge so the UI cannot be bypassed.
- **F-03:** Gate `tab_*` behind approval + explicit tab picker; redact sensitive fields.
- **F-06:** Per-mutation confirmation for Roblox cloud writes; move to Open Cloud keys.
- **F-07:** Job Object / process-group kill on timeout.
- **F-09:** `alarms` permission for PlazCode; persist pending request IDs in `storage.session`.
- **F-20/F-23:** Unpack ORscript into the repo as real source; add `.gitignore`, a `package.json` with `npm test` that runs `tests/*.js` and aggregates exit codes, GitHub Actions for `node --check`, tests, `cargo test`, `cargo audit`, `py_compile`.

### 3. Medium priority (1–2 months)
- **F-08:** Event-driven desktop state; throttle update polling.
- **F-11:** Private-network blocklist for `web_fetch`.
- **F-13:** Trim host permissions to the provider list + loopback; use `optional_host_permissions` for the rest.
- **F-15/F-16:** Replace string-grep tests with executable unit tests (vm sandbox with a proper `chrome` mock); fix or remove stale tests; fix `bridge-pairing.cjs` path and sandbox globals.
- **F-21:** Build the three extension variants from one source directory in CI.
- Split `core/main.js` (8.5–10.6 k lines) into policy, UI, templates, Figma, project-import modules; add JSDoc + `// @ts-check`.

### 4. Long term
- Provider adapter fixture tests (recorded DOM snapshots) for each AI site.
- Rust integration tests for the server; fuzz `parser.js`.
- Reproducible builds + attestation for every shipped binary; vendor or submodule the PlazCode bridge source so forks inherit security fixes.
- Document the threat model (prompt injection, local attacker, malicious page) in README.

---

## L. Unverified Areas

- **`PlazCode.exe` internals** (pairing enforcement, origin checks, every `/api/*` handler, updater integration) — binary only; claims come from release notes.
- **`engram-windows-amd64.exe`** — third-party; hash not verifiable against shipped manifest.
- **Live behaviour** against Roblox Studio MCP, Blender MCP, Ollama, Figma, and the 17+ AI websites — not exercised; provider adapters may be out of date with current site DOMs.
- **Chrome Local-Network-Access prompting** for `ws://127.0.0.1` from public sites in current Chrome/Edge/Brave — affects exploit friction for F-01, not its validity; Firefox behaviour assumed unprompted.
- **Rust crate compilation and `cargo audit`** — not possible in this sandbox.
- **Whether `PlazCode-1.24.12.zip` here equals the upstream GitHub release** — cannot be checked offline; the SHA mismatches suggest it may not.
- **Firefox-specific MAIN-world shims** (`firefox-events-main.js`) — reviewed for syntax only.

---

## M. Final Repository Assessment

| Dimension | Rating | Rationale |
|---|---|---|
| **Security** | **Poor (ORscript) / Guarded (PlazCode)** | ORscript ships an unauthenticated local RCE surface; both execute AI-chosen shell commands unconfirmed by default; PlazCode adds pairing but also adds ungated cross-tab automation. No secrets leaked. |
| **Reliability** | Fair | Extensive reconnect/timeout engineering in `background.js` and the Rust bridge; weak points are worker-restart loss of in-flight calls and orphaned processes. |
| **Maintainability** | Poor | Repo holds ZIPs; 8.5–10.6 k-line god module; three copies of the extension; fork drift; stale docs/tests; no lint/types. |
| **Testing maturity** | Low | 44 scripts exist but most are substring checks; 8 fail; no runner, no CI; PlazCode's shipped tests cannot run. |
| **Architectural risk** | High | Security policy lives only in a content script on a hostile page; the bridge trusts whoever connects; the AI is an unauthenticated principal. |

**Bottom line:** the codebase is feature-rich and shows real operational hardening around Studio/MCP reliability, but it rests on two unsafe assumptions — that loopback is private and that the AI is trustworthy. Fixing bridge authentication (F-01) and making dangerous tools fail-closed (F-02/F-03/F-05) are the first changes to make; converting the repository from ZIP uploads into a real source tree with CI is the prerequisite for everything else.
