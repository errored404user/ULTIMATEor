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
2. Start the native bridge in headless mode with **`bin/or-core.exe --headless`**. ORscript no longer includes a desktop status window. It starts:
   - HTTP API on `http://127.0.0.1:3000`
   - WS bridges on `17613` (RS) and `17615` (AS)
   - Workspace folder for AgentScript (`OR_WORKSPACE_ROOT` / `--workspace` / `%USERPROFILE%\ORWorkspace`)
   - The bridge runs in the background without opening an ORscript desktop window. Stop the process from the shell when finished.
3. **RS:** Roblox Studio → Assistant AI → ⋯ → Manage MCP Servers → Enable Studio as MCP Server.
4. Open a supported chat and click **Start agent**.

### Provider notes

- **Crax GPT** (`gpt.crax.lol`) — the site sends its own `role: system` prompt ahead of every request ("you have no tools"), which made every Crax model ignore the ORscript protocol even though the bar showed *RS Connected*. ORscript now runs a MAIN-world tap (`src/providers/crax-net.js`) that prepends the agent instructions to Crax's chat request while a session is starting or running, so all Crax models link to Studio again. Nothing is sent while the agent is off.
- **Notion AI** (`notion.so/ai`, `/chat`) — **experimental**, ported from the PlazCode Notion adapter. Notion's transcript is immutable, so command status is shown as ORscript cards next to each AI message instead of in-place chips; the bar sits on a provider-reserved strip above the composer; the Start message is phrased as plain-text *user preferences* (no Markdown blocks) so Notion's reviewer does not drop it; long tool results (the command catalogue, big script reads) are attached as `orscript_*.txt` files. Notion's own Agent is not reconfigured — ORscript only reads and writes the chat. Hooks that exist only in the PlazCode core (native-generation respect, fresh-response gating, activity summaries) are ignored by the ORscript core.

---

## Agent

- Native crate: `agent/` (`or-agent` 1.18.3). It runs as a background bridge only; the removed desktop status window is not part of ORscript.
- Service worker skips stale-socket reconnect and MCP heal while a `call_tool` is in flight (the 25 s stale window used to kill long tools).
- 30 Studio skills, a 24-command animation suite, AgentScript file/terminal tools.
- Work modes (Settings → Work mode, also in the popup): **Adaptive** (default generalist workflow), **Visualizer** (VFX, lighting and UI specialist — layers `fx_*`/`vfx_*`/`lighting*`/`ui_*`, screenshot-verifies every pass) and **Animator** (animation specialist — `animation_*` editor pipeline, tweens, springs, IK, camera beats, preview-verified). The specialists run on top of Adaptive, add their own mandate to the system prompt, show a badge on the bar, and make `list_commands` surface their command family first. `node tests/test-work-modes.js` guards them.

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
