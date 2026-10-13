# OR — Roblox Studio + AgentScript AI agent

Turn a supported AI chat (**DeepSeek, ChatGPT, Claude, Google Gemini, Kimi, NVIDIA NIM Kimi K3, GLM, Qwen, Arena, Meta AI, Crax GPT, Ox Alpha, or Notion AI (experimental)**) into an autonomous development agent. Two switchable engines:

| Engine | Toggle | Target | Port |
|---|---|---|---|
| **Roblox** (RS) | RS | Roblox Studio via its built-in MCP server | ws://127.0.0.1:17613 |
| **AgentScript** (AS) | AS | A local project folder — files + terminal | ws://127.0.0.1:17615 |

Describe what you want in plain English and the AI builds instances, writes Luau/code files, sculpts terrain, tunes lighting, generates UI, runs builds and tests, and audits your project — inside Studio or directly on disk.

Website adapters require no API keys. Optional direct API providers use the provider's own billing and credentials. Chromium browsers (Chrome, Brave, Edge, Thorium). Theme is black/white outlines.

---

## Engines

- The bar above every supported chat composer carries a segmented **RS / AS** toggle. Switching engines wipes tool caches so commands cannot cross engines.
- **RS** drives Roblox Studio through StudioMCP (stdio JSON-RPC spawned by `or-agent`), including the `animation_*` workflow.
- **AS** gives the AI full control of one local folder ("the workspace") through native Rust tools — sandboxed paths, exact-match diff editing, glob/content search, and terminal execution with hard timeouts.

Large `execute_luau` scripts are auto-chunked around 24 KB so Studio's parser never hits the ~64 KB wall. Each chunk is still one NDJSON/JSON-RPC line.

---

## Setup

1. Open `chrome://extensions` → Developer mode → **Load unpacked** → this folder (`manifest.json`).
2. Start the bridge — **ORscript Desktop**, the Rust app in `agent/` (Windows: build once with `Build-ORscript-Desktop.cmd`; macOS/Linux: `./build-orscript-desktop.sh`; or `cd agent && cargo build --release` anywhere). Launch `bin/or-core.exe` (Windows) / `bin/or-core` (macOS, Linux):
   - Workspace window: Home / Explorer / Tools / Servers / Terminal / Settings — live Bridge / Roblox Studio / Tools / Workspace status, Studio viewport snapshots, a Luau runner that executes inside Studio, and a workspace folder you can switch without restarting.
   - Closing the window hides it to the notification area; the bridge keeps running until you choose *Quit* from the tray menu. `--hidden` starts in the tray, `--headless` runs without any window.
   - It starts the HTTP API on `http://127.0.0.1:3000`, the WS bridges on `17613` (RS) and `17615` (AS), and the AgentScript workspace (`OR_WORKSPACE_ROOT` / `--workspace` / Settings → Workspace / `%USERPROFILE%\ORWorkspace`).
   - Runs on Windows, macOS and Linux (Linux drives a Studio running under Wine/Vinegar — set the MCP launcher in Settings). See `agent/README.md` for build details, per-OS paths and flags.
3. **RS:** Roblox Studio → Assistant AI → ⋯ → Manage MCP Servers → Enable Studio as MCP Server.
4. Open a supported chat and click **Start agent**.

### Provider notes

- **Crax GPT** (`gpt.crax.lol`) — the site sends its own `role: system` prompt ahead of every request ("you have no tools"), which made every Crax model ignore the ORscript protocol even though the bar showed *RS Connected*. ORscript now runs a MAIN-world tap (`src/providers/crax-net.js`) that prepends the agent instructions to Crax's chat request while a session is starting or running, so all Crax models link to Studio again. Nothing is sent while the agent is off.
- **Notion AI** (`notion.so/chat`, `/ai`) — **experimental**, ported from the PlazCode Notion adapter. Notion's transcript is immutable, so command status is shown as ORscript cards next to each AI message instead of in-place chips; the bar sits on a provider-reserved strip above the composer; the Start message is phrased as plain-text *user preferences* (no Markdown blocks) so Notion's reviewer does not drop it; long tool results (the command catalogue, big script reads) are attached as `orscript_*.txt` files. Notion's own Agent is not reconfigured — ORscript only reads and writes the chat. The bar never hides on Notion: before the AI composer mounts (or on a normal Notion page) it docks to the bottom of the viewport and its status line says what it is waiting for — use the full-page chat at `notion.so/chat` or `notion.so/ai`. Hooks that exist only in the PlazCode core (native-generation respect, fresh-response gating, activity summaries) are ignored by the ORscript core.
- **ChatGPT (1.21.1)** — adapter re-synced with the current chatgpt.com DOM: the composer is found whether it is the classic `#prompt-textarea` ProseMirror box, the newer Lexical/`data-testid="composer-input"` editor or a plain `<textarea>` (Work mode), the single submit control is read through `#composer-submit-button` plus send/stop test-ids inside the composer frame, bulk `insertText` is used for the bootstrap (line-by-line only for huge results) and the composer is kept visually blank while internal messages are typed. Turn detection understands `article[data-turn]`, `data-turn-key` grouped turns and Work result units. Fixes "Start clicked but nothing is typed/sent".
- **Notion AI (1.21.1)** — composer detection no longer stalls at "waiting for the chat composer": the placeholder vocabulary was widened (Ask Notion / Ask the agent / Ask, search… / What do you want to…) and, on a confirmed `/chat` or `/ai` route, a relaxed fallback picks the chat-shaped editable nearest the bottom of the viewport after 2.5 s of strict misses (page editors never live on those routes, so this cannot touch a document). The pre-start bar line now reports how many visible text boxes the page has, which is the first thing to paste when reporting a Notion issue.
- **Provider scan (1.20.0)** — `node tests/test-provider-wiring.js` cross-checks every AI chat host against the manifest bundles, the background `PROVIDER_URLS` allow-list, the in-bar site switcher and the provider skins. It found and fixed three gaps: `agent.minimax.io`, `overchat.ai` and `huggingface.co/chat` were injected but missing from the background allow-list (the service worker refused to open/route them), Ox Alpha had no entry in the site switcher, and the switcher pointed Notion at `/ai` while the extension prefers `/chat`. Still open by design: `host_permissions` is `<all_urls>` — far broader than the 42 chat hosts actually used; narrowing it is a store-listing decision, not a code fix.

---

## Paint — draw it, the AI builds it

The brush button next to Settings (or **Ctrl/⌘+Shift+P**) opens **ORscript Paint**, a full-screen studio on top of the chat page (`src/core/paint.js`).

- **Tools (16):** pencil, brush (soft, pressure-aware), marker (multiply), spray, eraser, bucket fill (tolerance), colour picker, line, arrow, rectangle, ellipse, triangle, star, text, rectangle select (move/cut/copy/paste/flip), hand. Shift constrains shapes and lines; right-button paints with the secondary colour.
- **Params:** size 1–200px, opacity, hardness, flow, spray density, fill tolerance, line dash, shape mode (outline / filled / both), corner radius, star points, arrow heads, font size/bold; 24-colour palette + custom + recent colours; canvas presets (16:9, 4:3, square, portrait, 2K) or any size up to 4096², background (white/black/grey/transparent/blueprint), grid with optional snapping, mirror symmetry (X/Y/both); up to 8 layers with opacity, visibility, reorder, duplicate, merge, flip; 60-step undo/redo; zoom 10–1600% and pan (space/middle-drag).
- **Import:** paste or drop an image, open a file, or capture the Studio viewport straight onto a layer to annotate it.
- **Send to AI:** pick an intent (auto, 3D structure, top-down level, UI mockup, terrain, character, systems diagram, animation, annotate screenshot), add an optional note and scale hint, and press *Send to AI*. The painting is sent as the next user turn — ORscript starts the agent first if it is not running, waits out a busy step, attaches the PNG on sites that accept images, and always includes a **vector trace**: every element in drawing order with colour, shape, position/size in canvas %, text labels, inferred relations (arrows between elements, containment), and an ASCII occupancy map — so even image-less providers get the exact drawing. Intent-specific *HOW TO ACT* rules tell the agent to name what it sees, build it with the engine's commands, and screenshot-verify (Self-check) the result; *Plan first* asks for a short build plan before any command.
- `node tests/test-paint.js` guards the bundle wiring, the bar button/hooks, the CSS and the message builder.

---

## Agent

- Native crate: `agent/` (`or-agent` 1.18.3). It runs as a background bridge only; the removed desktop status window is not part of ORscript.
- Service worker skips stale-socket reconnect and MCP heal while a `call_tool` is in flight (the 25 s stale window used to kill long tools).
- 679 Studio commands (`list_commands`), a 24-command animation suite, AgentScript file/terminal tools.
- **1.21.4 — Notion now actually runs commands in Studio.** Found by driving the complete content-script bundle on a simulated Notion AI page (jsdom; composer, send/stop controls, transcript rows in both Notion DOM shapes) with a scripted model and a stub bridge, side by side with the reference extension. Three defects, all in ORscript's integration, not in the adapter: (1) *the catalogue never fitted* — ORscript's `list_commands` answer for Notion was the full 750-command schema dump, **184 000 characters in one message**; Notion never answers that, so Start looked dead. Notion now gets the bounded command-name index (`compactCommandList`, ~12 k characters; schemas are fetched per command with `list_commands {query}`), and the periodic command reminder is bounded the same way (it was ~75 k characters every 20 calls). (2) *replies were invisible for 15 s and commands ran twice* — the core's mutation observer never called the adapter's `invalidateItems`/`ignoreMutationRecords`/`preprocessMutations` hooks, so Notion's cached transcript model (15 s TTL) missed new replies; the response watcher then finalised on the *previous* turn and re-executed its `execute_luau` (duplicate parts in Studio), and the bootstrap waited out the whole TTL. The observer now feeds the hooks, watches the subtree that contains both transcript and composer, and invalidates on every rebind — the simulated start handshake dropped from 24 s to 9.5 s and the duplicate execution is gone. (3) *multi-line Luau arrived glued* — Notion renders each line of a reply as its own block, and `textContent` joined them (`p.Parent = workspaceprint("OK")` → Luau syntax error in Studio). The adapter reads transcript items block-aware now (newline at block boundaries, inline spans unchanged). `tests/test-notion.js` covers all three.
- **1.21.3 — Notion: the bar no longer vanishes a second after load.** Root cause was the host-UI collision manager, not the Notion adapter: its rule "an element whose class contains *overlay*/*modal* and covers more than 55 % of the viewport is a modal → hide the whole ORscript root" matched Notion's permanent, fully transparent, click-through `notion-overlay-container` shell on the 1 s poll, so the UI appeared and then got `visibility:hidden` for good. The manager now (a) measures the rectangle ORscript really occupies (the root is a zero-size wrapper), (b) only hides for a `role=dialog`/`aria-modal` surface or a dimming/blurring backdrop that actually intersects that rectangle, (c) ignores transparent click-through shells, opaque page surfaces and anything wrapping the chat composer, and (d) nudges instead of hiding for popovers. `tests/test-collision-manager.js` reproduces the bug against a DOM stub. In addition, Notion's keep-visible bar falls back to the viewport-bottom dock whenever the reserved composer strip cannot be seated (zero-width/off-screen anchor), instead of hiding.
- **1.21.2 — tool fixes, Ultimate skill pack, self-writing memory, agent loop guard**
  - *Tool errors fixed.* A real parse of every generated command (new `tests/test-luau-syntax.js` + optional `tests/luau-parse-check.py`, which compiles all 1 308 generated programs with a Lua parser) found and fixed: three bugs in the shared skills library that broke all 33 core commands ("Malformed string" / "Expected 'end'" — raw newlines inside Lua strings, a missing `end` in `lighting_set_preset`, an unclosed block in `ui_create_component`); JS-array syntax (`["a","b"]`) emitted as Lua tables in `property_copy`, `raycast_do`, `swept_ray`, `remote_folder`, `ds_get_many`, `shop_ui`, `tabs_ui`, `dropdown_ui` (raycast filters now resolve paths to Instances); `if … then … else … end` used as an *expression* in 10 commands (`instance_is_ancestor`, `player_godmode`, `ragdoll_*`, `toggle_ui`, `light_flicker`, `audio_loop/pitch/pan/id`); a broken concatenation in `slider_ui`; double-wrapped colours in 11 commands; `instance_count` (extra `end`), `camera_zoom` (did nothing — now changes FOV), `fx_magic_circle`, `log_tag`. `script_grep` / `instance_new` were advertised twice with conflicting params — the catalogue is now de-duplicated with merged aliases. Skill programs that report `{"ok":false}` are now surfaced as real `ERROR` results (red chip, retry hints) instead of green "output". Unknown command names get *Did you mean …?* suggestions (token/edit-distance ranking) instead of a 600-name dump.
  - *New Ultimate skill pack* (`src/core/skills/studio_ultimate.js`, 34 commands, surfaced first in Ultimate mode): `script_replace` (exact find/replace with expected-count guard), `script_insert`, `script_delete_lines`, `script_outline`, `script_find_usages`, `script_rename_symbol`, `script_lint`, `script_todo`, `script_requires`, `script_backup` / `script_restore` / `script_backups_list`; `model_build` (JSON parts spec → finished Model), `model_report`, `model_center_pivot`, `model_snap_to_ground`, `model_align`, `model_distribute`, `model_array_radial`, `model_wall`, `model_hollow_box`, `model_pipe`, `model_paint`, `model_anchor_fix`, `model_optimize`, `model_union`, `model_subtract`, `model_rotate_about`, `model_export_spec`; and `memory_read` / `memory_add_fact` / `memory_update_section` / `memory_remove_fact` / `memory_search` for the shared handbook at `ServerStorage.RobloxScript.Memory`. Every program runs inside `pcall` and records a ChangeHistory waypoint, so Ctrl+Z works and runtime errors come back as clean failures.
  - *Memory.* The AI no longer hand-edits the handbook ModuleScript — the `memory_*` commands edit one section at a time and keep it under its size cap. ORscript also records a **session recap** automatically (commands used, scripts/models touched, unresolved errors, place, mode, duration) for the last four sessions and shows it to the AI as read-only context in the next chat; Settings → Coding memory shows the recap with an on/off toggle and *Forget sessions*.
  - *Agents.* A loop guard tags the result when the identical command+parameters fails twice or more in a row and tells the model to change approach; the Ultimate workflow now mandates `script_outline`/`script_find_usages`/`model_report` before edits, `script_backup` before rewrites, `script_lint` in verification, and states explicitly that a task is never completed merely because code was written.
- Work modes (Settings → Work mode, also in the popup): **Ultimate** (default — the flagship: senior Luau engineer and 3D modeler in one. Reads the project before writing, architects server-authoritative systems with typed ModuleScripts, validated remotes and session-locked DataStores, builds gameplay systems end-to-end, blocks out → details → materials → collisions for models at real scale, and verifies with `script_check`/`audit_*`, playtests, console reads and screenshots; `list_commands` surfaces its ~150-command scripting/instance/physics/build/terrain family first), **Visualizer** (VFX, lighting and UI specialist — layers `fx_*`/`vfx_*`/`lighting*`/`ui_*`, screenshot-verifies every pass) and **Animator** (animation specialist — `animation_*` editor pipeline, tweens, springs, IK, camera beats, preview-verified). The specialists run on top of Ultimate, add their own mandate to the system prompt, and every mode shows a badge on the bar. Stored `adaptive`/`fast`/`balanced`/`thorough` values migrate to Ultimate. `node tests/test-work-modes.js` and `tests/test-work-mode.js` guard them.

---

## Testing

```bash
node test-skills.js
node test-parser.js
node test-chatgpt.js
node test-animlib.js
node test-v111.js
node test-v112.js
node tests/test-crax-net.js        # Crax request tap
node tests/test-notion.js          # Notion AI provider wiring + core hooks
node tests/test-luau-syntax.js     # static Luau check of every generated Studio command
node tests/test-collision-manager.js # host-overlay collision rules (Notion shell must not hide the bar)
npm i --no-save jsdom && node tests/notion-e2e.js   # optional: full Notion session simulation (Start -> catalogue -> execute_luau -> result), also NOTION_MODE=blocks
python3 tests/luau-parse-check.py  # optional: compile all generated programs with a real Lua parser (pip install lupa)
node --check src/core/main.js && node --check src/core/config.js && node --check background.js
cd agent && cargo test
```

`test-bridges.js` is a live smoke test: start `or-agent --headless` first. It checks HTTP `:3000` and WS `17613` / `17615` (no Unreal port).

### Theme preview (no extension load needed)

`tools/theme-preview/` renders the real `overlay.css` with the real bar / settings / approve DOM ids so all 16 themes (backgrounds, corner decorations, button states) can be checked in a plain browser:

```bash
python3 -m http.server 8080            # from the ORscript root
# open http://localhost:8080/tools/theme-preview/index.html?theme=void
```

`node tests/test-theme-visuals.js` guards the 1.19.7 visual layer (per-theme tokens, swatch photos for all 16 themes, SVG corner ornaments + inside textures, pill button states) and the sound packs. Decorations are designed SVG motifs (`--orx-orn` in `overlay.css`) painted with the theme gradient — never emoji or text.

### Sound packs

Every theme ships seven hand-tuned Web Audio effects — `start`, `done`, `stop`, `error`, `ok`, `click` and a `special` signature — defined as data in `THEME_SOUNDS` (`src/core/main.js`) and rendered by a single synth (`playSfx(kind, themeId)`): oscillators with glide, lowpass, detune/chorus and vibrato, plus filtered noise. Every effect is under one second and never loops. The ♪ pills under the theme picker preview the current pack; the preview harness above plays the same code.

## Privacy

There is no OrScript telemetry. Local tool bridges use `127.0.0.1`; enabled API integrations contact only their configured HTTPS provider endpoint. AgentScript stays inside the workspace root unless you flip FULL ACCESS.


## Studio MCP reliability

Studio operations use Roblox Studio's supported MCP server through the local OrScript agent. Timed-out MCP calls are not replayed, `script_read` has a bounded 30-second extension timeout, and reconnect retries are limited to disconnected read-only requests.
