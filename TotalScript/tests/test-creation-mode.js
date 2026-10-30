// 1.42.0 — Creation mode, end to end.
//
// Creation is TotalScript's single work mode: the user describes what they want
// in the provider chat, the extension's system prompt (config.js) turns the
// model into a tool-calling creator, every emitted command runs through
// runTool() → background.js → the total-core bridge → Roblox Studio (plugin /
// MCP) or the AgentScript workspace, and the result is written back into the
// chat. This test covers that chain with the real code wherever node can run
// it, and pins the Rust / Luau halves it cannot execute:
//
//   A  activation + UI state (static + jsdom)
//   B  prompt processing: the CREATION block really reaches the system prompt
//   C  the real runTool() against a fake bridge: dispatch, result display,
//      bridge-offline errors, malicious paths, approval gates (deny / allow)
//   D  permissions: CONFIRM_ALWAYS_OPS, Ask-mode set, fail-closed modal
//   E  web tools never reach loopback / LAN (background.js privateNetworkReason)
//   F  Rust bridge pins: origin policy, plugin timeout no-duplicate, backups,
//      download SSRF guard, desktop-chat approval round-trip (+ their cargo tests)
//
//   NODE_PATH=/tmp/harness/node_modules node tests/test-creation-mode.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const main = read("src/core/main.js");
const config = read("src/core/config.js");
const background = read("background.js");
const popup = read("popup.js");
const mainRs = read("agent/src/main.rs");
const pluginRs = read("agent/src/plugin.rs");
const wsRs = read("agent/src/workspace.rs");
const chatRs = read("agent/src/chat.rs");
const guiRs = read("agent/src/gui.rs");
let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch {}

const failed = [];
let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("ok   " + name); }
  else { failed.push(name); console.log("FAIL " + name + (extra !== undefined ? "  → " + String(extra).slice(0, 220) : "")); }
}
function finish() {
  console.log(`\n${passed} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

// ───────────────────────── A. activation (static) ─────────────────────────
ok("A: Creation is the only built-in work mode and every legacy id normalises to it",
  /const WORK_MODES = \{\s*creation: \{/.test(main) && main.includes('const normalizeWorkMode = (id) => (WORK_MODE_IDS.includes(id) ? id : "creation");') && main.includes('let workMode = "creation";'));
ok("A: syncWorkModeUi falls back to the mode that exists (no dead WORK_MODES.ultimate)",
  main.includes("const mode = WORK_MODES[workMode] || WORK_MODES.creation;") && !main.includes("WORK_MODES.ultimate"));
ok("A: a work-mode change arriving through chrome.storage is normalised before use",
  main.includes("if (changes.rsWorkMode && normalizeWorkMode(changes.rsWorkMode.newValue) !== workMode) {\n          workMode = normalizeWorkMode(changes.rsWorkMode.newValue);"));
ok("A: popup mirrors the built-in modes (creation + blender since 1.95.0; creation stays the default)", popup.includes('const WORK_MODES = ["creation", "blender", "animate"];') && popup.includes('workMode: "creation"') && /LEGACY_WORK_MODES = \{ ultimate: "creation", visualizer: "creation", animator: "creation", adaptive: "creation" \}/.test(popup));
ok("A: the mode card, quick starts and badge are rendered from WORK_MODES",
  main.includes('class="rs-work-row rs-work-creation rs-work-modes" role="radiogroup"') && main.includes('<span id="rs-work-badge" hidden></span>') && /rs-work-starters/.test(main));
ok("A: Creation evidence gates (scripts / look / motion) exist and feed modeGateNudge",
  /creation: \[\s*\{ id: "scripts",/.test(main) && /\{ id: "look",/.test(main) && /\{ id: "motion",/.test(main) && /function modeGateNudge\(runTools\)/.test(main));

// ───────────────────────── B. prompt processing ─────────────────────────
{
  // config.js is a plain script that fills window.RS / globals; run it in a vm
  // with the live work mode set to creation and ask for the mode block.
  let promptOk = false, detail = "";
  try {
    const sandbox = { window: {}, console, document: { documentElement: { getAttribute: () => null } }, chrome: { storage: { local: { get: (k, cb) => cb && cb({}) } } } };
    sandbox.window.__rsWorkMode = () => "creation";
    sandbox.globalThis = sandbox; sandbox.self = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(config + "\n;globalThis.__cfg = (typeof RS !== 'undefined' ? RS : (window.RS || null));", sandbox);
    const full = /creation: \{\s*full: `([\s\S]*?)`,\s*tight: `([\s\S]*?)`/.exec(config);
    detail = full ? full[1].slice(0, 80) : "no block";
    promptOk = !!full && full[1].includes("TOTALITY WORK MODE") && full[2].includes("TOTALITY WORK MODE") && full[1].length > 1500 && full[2].length > 300 && full[2].length < full[1].length;
  } catch (e) { detail = String(e && e.message || e); }
  ok("B: config.js carries a full and a tight TOTALITY WORK MODE block (compact providers get the tight one)", promptOk, detail);
  ok("B: the mode block is selected by the live work mode (normalizeModeId → creation)", config.includes('function normalizeModeId(wm) { return WORK_MODE_PROMPTS[wm] ? wm : "creation"; }') && config.includes('const wm = (window.__rsWorkMode && window.__rsWorkMode()) || "creation";'));
  ok("B: Creation playbooks + TOTALITY CHECK line exist for the per-turn reminder", /creation: `PLAYBOOKS \(pick the one that matches/.test(config) && /creation: "TOTALITY CHECK: read before you write/.test(config));
  ok("B: SYSTEM_STATE tag reports WORK=<mode> and PERM=<access mode> on every tool result", main.includes("[SYSTEM_STATE: ENGINE=${eng} | WORK=${wm}") && main.includes("PERM=${perm}"));
}

// ───────────────────────── D. permissions (static) ─────────────────────────
// 1.99.5: access is two states - Sandbox only / Full PC. The PC-leaving set is
// unchanged from 1.42.0 but is now REFUSED in Sandbox (no prompt) and run in Full PC.
ok("D: FULL_PC_OPS covers shell / process / delete / move / download / open / Blender (same set as the 1.42.0 always-confirm list)",
  /const FULL_PC_OPS = new Set\(\[\s*"run_command","process_kill","delete_path","move_path","download_file","open_path",\s*"execute_blender_code","blender_export_fbx",\s*\]\);/.test(main));
ok("D: accessAllows = Full PC || not a PC-leaving op; the gate refuses with ERROR ACCESS_SANDBOX before any bridge call and never prompts",
  main.includes('const accessAllows = (bareName, mode) => normalizeAccess(mode) === "full" || !FULL_PC_OPS.has(bareName);') && main.includes("if (!accessAllows(bareName, permMode)) {") && main.includes("return `ERROR ACCESS_SANDBOX in ${bareName}: Access is \"Sandbox only\" (Studio + workspace), and this command leaves the sandbox, so it did NOT run and nothing changed.") && !/needsConfirmation|ASK_OPS|CONFIRM_ALWAYS_OPS\.has/.test(main));
ok("D: missing approval modal fails CLOSED (publish confirmation is the only prompt left)", main.includes("if (!root || !allow || !deny) { resolve(false); return; }") && main.includes("if (!internalCall && PUBLISH_OPS.has(bareName) && !(await publishAutomationEnabled())) {"));
ok("D: only sandbox / full are accepted; a stored 'ask' reads as sandbox (load, setPermMode, storage change)", main.includes('const ACCESS_MODES = ["sandbox", "full"];') && main.includes('const normalizeAccess = (id) => (ACCESS_MODES.includes(id) ? id : "sandbox");') && main.includes('if (r && typeof r.rsPermMode === "string") permMode = normalizeAccess(r.rsPermMode);') && main.includes("if (!ACCESS_MODES.includes(id)) return;") && main.includes("permMode = normalizeAccess(changes.rsPermMode.newValue);") && !/\["sandbox", ?"ask", ?"full"\]/.test(main));
ok("D: Access cards explain the gate honestly (two cards, no Ask card)", main.includes("Sandbox only = Studio and the workspace folder; shell commands, deletes, moves, downloads, opening paths and Blender code are refused (no prompts). Full PC = everything runs, and total-core's FULL PC ACCESS switches on with it.") && main.includes('data-perm="sandbox"') && main.includes('data-perm="full"') && !main.includes('data-perm="ask"'));
ok("D: the Danger-zone FULL toggle is the same switch (goes through setPermMode)", main.includes('setPermMode(want ? "full" : "sandbox");') && main.includes('chrome.runtime.sendMessage({ type: "rs-set-full", enabled: id === "full" })'));
ok("D: runTool is reachable for harnesses (window.__rsRunTool)", main.includes("window.__rsRunTool = (call) => runTool(call);"));
ok("D: late bar lookups go through uiEl (bar → root → document) so the CREATION badge / status pill / task pill update on inline mounts too", main.includes('function uiEl(id)') && main.includes('const badge = uiEl("rs-work-badge");') && main.includes('const pill = uiEl("rs-status-pill");') && main.includes('const el = uiEl("rs-task-pill");') && !main.includes('root && root.querySelector("#rs-work-badge")'));

// ───────────────────────── E. web tools vs private networks ─────────────────────────
{
  const m = /function privateNetworkReason[\s\S]*?\n}\n/.exec(background);
  let fn = null;
  try { fn = m && new Function(m[0] + "\nreturn privateNetworkReason;")(); } catch {}
  ok("E: background.js defines privateNetworkReason", typeof fn === "function");
  if (fn) {
    const bad = ["http://127.0.0.1:3000/api/status", "http://localhost:17615/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://172.16.0.1/", "http://100.64.0.1/", "http://[::1]/", "http://[fe80::1]/", "http://router.local/", "http://0.0.0.0/", "ftp://example.com/x", "not a url"];
    const good = ["https://example.com/", "http://8.8.8.8/", "https://create.roblox.com/docs", "https://172.15.0.1/", "https://registry.npmjs.org/jsdom"];
    ok("E: loopback, RFC-1918, link-local, CGNAT, IPv6 local, .local and non-http are refused", bad.every((u) => fn(u)), bad.filter((u) => !fn(u)).join(" "));
    ok("E: public hosts pass", good.every((u) => !fn(u)), good.filter((u) => fn(u)).join(" "));
  }
  ok("E: web_fetch and api_request both consult the guard before fetching",
    background.includes('{ const why = privateNetworkReason(url); if (why) { sendResponse({ ok: false, error: "web_fetch refused: " + why') && background.includes('{ const why = privateNetworkReason(url); if (why) { sendResponse({ ok: false, error: "api_request refused: " + why'));
}

// ───────────────────────── F. Rust bridge pins ─────────────────────────
ok("F: bridge origin policy — extension schemes pass, web origins are refused, no Origin = local caller",
  mainRs.includes("pub fn origin_allowed(origin: Option<&str>) -> bool") && mainRs.includes('["chrome-extension://", "moz-extension://", "safari-web-extension://", "ms-browser-extension://"]') && mainRs.includes("let Some(o) = origin.map(str::trim) else { return true };"));
ok("F: every HTTP route sits behind origin_guard (403) and CORS only reflects allowed origins — allow_origin(Any) is gone",
  mainRs.includes(".layer(axum::middleware::from_fn(origin_guard))") && mainRs.includes("AllowOrigin::predicate(|origin: &axum::http::HeaderValue, _parts: &axum::http::request::Parts| origin_allowed(origin.to_str().ok()))") && !mainRs.includes("allow_origin(Any)") && mainRs.includes("axum::http::StatusCode::FORBIDDEN"));
ok("F: legacy WebSocket ports (17613 / 17615) check Origin at the handshake (accept_hdr_async → 403)",
  mainRs.includes("tokio_tungstenite::accept_hdr_async(stream, guard)") && mainRs.includes("*err.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;") && !mainRs.includes("tokio_tungstenite::accept_async(stream)"));
ok("F: origin policy has a cargo unit test", /mod origin_tests[\s\S]*fn extension_and_local_callers_pass_web_pages_do_not/.test(mainRs));
ok("F: plugin timeout is typed (PluginTimeout { in_flight }) and an in-flight execute_luau is NOT re-run through the MCP helper",
  pluginRs.includes("pub struct PluginTimeout {") && pluginRs.includes("return Err(anyhow::Error::new(PluginTimeout { name: name.to_string(), secs: timeout.as_secs(), in_flight }));") && pluginRs.includes("Err(e) if matches!(e.downcast_ref::<PluginTimeout>(), Some(t) if t.in_flight) => {") && /before == q\.len\(\)/.test(pluginRs));
ok("F: workspace writes keep backups (.totalscript-backups) before overwrite / edit / delete, pruned per file, hidden from tree",
  wsRs.includes('pub const BACKUP_DIR: &str = ".totalscript-backups";') && wsRs.includes("pub async fn backup_existing(ws: &Workspace, p: &Path) -> Option<String>") && (wsRs.match(/backup_existing\(ws, &p\)\.await/g) || []).length === 3 && wsRs.includes('"coverage", BACKUP_DIR,') && wsRs.includes("const BACKUPS_PER_FILE: usize = 10;"));
ok("F: workspace backup behaviour has a cargo test", wsRs.includes("async fn overwrite_edit_and_delete_keep_backups_inside_the_workspace()"));
ok("F: download_file refuses private networks server-side (+ cargo test)", wsRs.includes("pub fn private_network_reason(url: &str) -> Option<String>") && wsRs.includes('if let Some(why) = private_network_reason(&url) { return Err(format!("download refused: {why}")); }') && wsRs.includes("fn download_refuses_private_networks()"));
ok("F: path sandbox keeps its lexical + canonical checks and tests", wsRs.includes("fn resolve_path(&self, rel: &str, must_exist: bool) -> Result<PathBuf, String>") && wsRs.includes("fn sandbox_rejects_escapes_and_absolute()") && wsRs.includes('ws.resolve_path("../outside", false).is_err()'));
ok("F: desktop chat pauses guarded tools for Allow / Deny (ChatEvent::Approval, oneshot reply, 120 s auto-deny, Stop = deny)",
  chatRs.includes('pub const GUARDED_TOOLS: &[&str] = &["run_command", "process_kill", "delete_path", "download_file", "open_path"];') && chatRs.includes("Approval { name: String, args: Value, reply: tokio::sync::oneshot::Sender<bool> },") && chatRs.includes("} else if is_guarded(&real) {") && chatRs.includes("pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);") && chatRs.includes('if cancel.load(Ordering::Relaxed) { return Err(format!("\'{name}\' was not run: stopped by the user")); }'));
ok("F: desktop window renders the Allow / Deny box and answers the turn", guiRs.includes("fn chat_approval_box(&mut self, ui: &mut egui::Ui)") && guiRs.includes("E::Approval { name, args, reply } => {") && guiRs.includes("fn chat_answer_approval(&mut self, allow: bool)") && guiRs.includes("if busy { self.chat_approval_box(ui); }") && guiRs.includes("self.chat_answer_approval(false);\n        if let Some(turn) = &self.chat_turn {"));
ok("F: approval round-trip has cargo tests", /mod approval_tests[\s\S]*fn approval_allow_deny_and_dismiss[\s\S]*fn approval_respects_stop/.test(chatRs));
ok("F: desktop system prompt tells the model about the gate and the backups", chatRs.includes("pause the turn until the user clicks Allow in this window") && chatRs.includes(".totalscript-backups/"));

// ───────────────────────── A/C. jsdom walk ─────────────────────────
if (!JSDOM) { console.log("skip jsdom walk (jsdom not installed)"); finish(); }

(async () => {
  const pageHtml = read("codecraft.html");
  const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
  const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
  Object.defineProperty(d, "hidden", { value: false, configurable: true });
  Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
  w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} }; };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return 860; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return d.body; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
  w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16); w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.elementFromPoint = d.elementFromPoint = () => null; d.execCommand = () => false;
  w.HTMLCanvasElement.prototype.getContext = () => null;
  if (!w.crypto) w.crypto = require("crypto").webcrypto;
  w.Audio = class { play() { return Promise.resolve(); } pause() {} }; w.AudioContext = undefined;
  w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" };
  w.URL.createObjectURL = () => "blob:harness"; w.URL.revokeObjectURL = () => {};
  w.open = () => null; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
  const storage = {};
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  const TOOLS = [
    { name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
    { name: "run_command", description: "Shell", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
    { name: "write_file", description: "Write", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
  ];
  // Fake total-core bridge: records every call_tool, answers like the Rust side.
  const calls = [];
  const sentFull = []; // every rs-set-full the page pushed to the background (1.99.5 access switch)
  let bridgeUp = true;
  const background = (msg) => {
    switch (msg && msg.type) {
      case "status": return { ok: true, type: "rs-status", connected: bridgeUp, mcpAlive: bridgeUp, studio: bridgeUp, roblox_connected: bridgeUp };
      case "studio_status": return { ok: true, studio: bridgeUp };
      case "tools": case "list_tools": return { ok: true, tools: TOOLS };
      case "call_tool": {
        calls.push({ name: msg.name, args: msg.arguments });
        if (!bridgeUp) return { ok: false, kind: "bridge", error: "bridge offline", errorCode: "BRIDGE_OFFLINE" };
        const a = msg.arguments || {};
        if (msg.name === "write_file") {
          const p = String(a.path || "");
          if (/^(\/|[a-zA-Z]:)/.test(p)) return { ok: false, kind: "execution", error: `paths must be relative to the workspace root, got '${p}'`, errorCode: "BRIDGE_COMMAND_FAILED" };
          if (p.split("/").some((seg) => seg === "..")) return { ok: false, kind: "execution", error: `path '${p}' is outside the workspace`, errorCode: "BRIDGE_COMMAND_FAILED" };
          return { ok: true, text: `Created ${p} (${String(a.content || "").length} chars, ~1 lines).` };
        }
        if (msg.name === "run_command") return { ok: true, text: "exit 0\nharness-user" };
        return { ok: true, text: "ok" };
      }
      case "rs-set-full": sentFull.push(!!msg.enabled); return { ok: true, enabled: !!msg.enabled };
      default: return { ok: true, tools: TOOLS };
    }
  };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {} }, lastError: null, getManifest: () => JSON.parse(read("manifest.json")) }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {} } }, tabs: { create() {} } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  storage.rsWorkMode = "visualizer"; // legacy id left over from 1.38 → must normalise to creation
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const pageErrors = [];
  w.onerror = (m) => { pageErrors.push(String(m)); };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }

  try {
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(700);

    // A — activation + UI state
    ok("walk A: boot with a legacy stored mode ('visualizer') lands on creation and rewrites storage", w.__rsWorkMode() === "creation" && storage.rsWorkMode === "creation", w.__rsWorkMode() + "/" + storage.rsWorkMode);
    ok("walk A: <html data-rs-work=creation> and the bar badge says TOTALITY", d.documentElement.getAttribute("data-rs-work") === "creation" && (() => { const b = d.getElementById("rs-work-badge"); return b && !b.hidden && b.textContent === "TOTALITY"; })());
    const supportBtn = d.getElementById("rs-support-btn") || d.querySelector("[data-rs-menu], #rs-menu-btn, .rs-menu-btn");
    if (supportBtn) { supportBtn.click(); await sleep(150); }
    const menu = d.getElementById("rs-menu");
    const card = menu && menu.querySelector('.rs-work-card[data-work="creation"]');
    ok("walk A: settings tray shows the Creation card selected with quick starts", !!card && card.classList.contains("on") && card.getAttribute("aria-checked") === "true" && menu.querySelectorAll(".rs-work-starters .rs-work-starter, .rs-work-starters button").length >= 4, card ? card.className : "no card (menu " + !!menu + ")");
    w.__rsSetWorkMode("ultimate"); await sleep(50);
    ok("walk A: selecting a legacy mode id keeps creation (normalised, no crash)", w.__rsWorkMode() === "creation" && pageErrors.length === 0, pageErrors.join(" | "));

    // D — accessAllows semantics (1.99.5)
    const al = w.__rsAccessAllows;
    ok("walk D: sandbox → run_command / delete_path / download_file / execute_blender_code refused; write_file / execute_luau / web_fetch allowed", !al("run_command", "sandbox") && !al("delete_path", "sandbox") && !al("download_file", "sandbox") && !al("execute_blender_code", "sandbox") && al("write_file", "sandbox") && al("execute_luau", "sandbox") && al("web_fetch", "sandbox"));
    ok("walk D: full → everything allowed; the legacy 'ask' value behaves as sandbox", al("run_command", "full") && al("write_file", "full") && !al("run_command", "ask") && al("write_file", "ask") && w.__rsFullPcOps().length === 8);

    // C — the real runTool against the fake bridge
    const runTool = w.__rsRunTool;
    ok("walk C: runTool hook present", typeof runTool === "function");
    ok("walk C: default access mode is sandbox", w.__rsPermMode() === "sandbox", w.__rsPermMode());
    // The catalogue is fetched from the bridge when a run starts (ensureTools);
    // do the same here so runTool knows write_file / run_command exist.
    const tools = await w.__rsEnsureTools(true);
    const names = new Set((tools || []).map((t) => t.name));
    ok("walk C: catalogue fetched from the bridge (list_tools) carries the bridge tools plus the built-in virtual ones", names.has("write_file") && names.has("run_command") && names.has("execute_luau") && names.has("total_screenshot") && names.has("totalscript_help"), [...names].slice(0, 12).join(","));
    ok("walk C: an unknown command is refused with COMMAND_NOT_FOUND instead of being sent to the bridge", /COMMAND_NOT_FOUND/.test(await runTool({ tool: "make_everything", arguments: {} })));

    // C1 plain workspace write goes straight to the bridge and the result is readable
    calls.length = 0;
    let out = await runTool({ tool: "write_file", arguments: { path: "src/Shop.lua", content: "return {}" } });
    ok("walk C1: write_file reaches the bridge as call_tool with the exact args and its text comes back", calls.length === 1 && calls[0].name === "write_file" && calls[0].args.path === "src/Shop.lua" && /Created src\/Shop\.lua/.test(out), out);

    // C2 malicious paths: the bridge refuses, the chat sees a clear ERROR (never a fake success)
    const evil = ["../../etc/passwd", "C:/Windows/system32/drivers/etc/hosts", "/etc/shadow", "ok/../../escape.txt"];
    let evilOk = true, evilDetail = "";
    for (const p of evil) {
      calls.length = 0;
      const r = await runTool({ tool: "write_file", arguments: { path: p, content: "x" } });
      const good = /ERROR/i.test(r) && /outside the workspace|relative to the workspace/.test(r) && !/Created/.test(r);
      if (!good) { evilOk = false; evilDetail += p + " → " + String(r).slice(0, 80) + " ; "; }
    }
    ok("walk C2: traversal / absolute paths surface as ERROR … outside the workspace (no false success)", evilOk, evilDetail);

    // C3 sandbox: run_command is REFUSED immediately - no modal, no bridge call (1.99.5)
    calls.length = 0;
    const t3 = Date.now();
    out = await runTool({ tool: "run_command", arguments: { command: "whoami" } });
    ok("walk C3: sandbox run_command → immediate ERROR ACCESS_SANDBOX, modal never opened, bridge untouched", (Date.now() - t3) < 1500 && /^ERROR ACCESS_SANDBOX in run_command: Access is "Sandbox only"/.test(out) && /Access → Full PC/.test(out) && d.getElementById("rs-approve").hidden && calls.length === 0, out);
    ok("walk C3: the user sees a banner naming the blocked command with a one-click 'Switch to Full PC' action", (() => { const b = [...d.querySelectorAll(".rs-banner")].find((x) => /Blocked by Sandbox access/.test(x.textContent)); return !!b && /run_command/.test(b.textContent) && !!b.querySelector(".rs-banner-go") && /Switch to Full PC/.test(b.querySelector(".rs-banner-go").textContent); })());

    // C4 every PC-leaving op is refused the same way; Studio / workspace writes still run
    calls.length = 0;
    const refused = [];
    for (const [tool, args] of [["delete_path", { path: "src" }], ["download_file", { url: "https://example.com/a.zip", path: "a.zip" }], ["open_path", { path: "." }], ["execute_blender_code", { code: "print(1)" }]]) {
      const r = await runTool({ tool, arguments: args });
      if (!/^ERROR ACCESS_SANDBOX in /.test(r)) refused.push(tool + " → " + String(r).slice(0, 60));
    }
    ok("walk C4: delete_path / download_file / open_path / execute_blender_code all refused in Sandbox, zero bridge calls", refused.length === 0 && calls.length === 0, refused.join(" ; "));
    calls.length = 0;
    out = await runTool({ tool: "write_file", arguments: { path: "c.txt", content: "3" } });
    ok("walk C4: write_file still runs in Sandbox without any prompt (one bridge call)", calls.length === 1 && /Created c\.txt/.test(out) && d.getElementById("rs-approve").hidden, out);

    // C5 the banner's action switches to Full PC and the same command then runs
    const go = [...d.querySelectorAll(".rs-banner")].find((x) => /Blocked by Sandbox access/.test(x.textContent)).querySelector(".rs-banner-go");
    go.click(); await sleep(60);
    ok("walk C5: 'Switch to Full PC' → access mode full, persisted, total-core told (rs-set-full true)", w.__rsPermMode() === "full" && sentFull.length > 0 && sentFull[sentFull.length - 1] === true, JSON.stringify(sentFull));
    calls.length = 0;
    out = await runTool({ tool: "run_command", arguments: { command: "whoami" } });
    ok("walk C5: Full PC → run_command reaches the bridge exactly once, no modal", calls.length === 1 && calls[0].name === "run_command" && /harness-user/.test(out) && d.getElementById("rs-approve").hidden, out);
    w.__rsSetPermMode("sandbox"); await sleep(60);
    ok("walk C5: back to Sandbox only via the hook → rs-set-full false pushed", w.__rsPermMode() === "sandbox" && sentFull[sentFull.length - 1] === false, JSON.stringify(sentFull));

    // C6 bridge offline → explicit error, no infinite wait
    bridgeUp = false; calls.length = 0;
    const t0 = Date.now();
    out = await runTool({ tool: "write_file", arguments: { path: "a.txt", content: "1" } });
    bridgeUp = true;
    ok("walk C6: bridge offline → immediate ERROR text (no hang), not a success", (Date.now() - t0) < 5000 && /ERROR|offline|bridge/i.test(out) && !/Created/.test(out), out);

    // C7 the two Access cards: Full PC card switches (and tells total-core), Sandbox card switches back; no Ask card exists
    const menuEl = d.getElementById("rs-menu");
    const fullCard = menuEl && menuEl.querySelector('.rs-work-card[data-perm="full"]');
    sentFull.length = 0;
    if (fullCard) { fullCard.click(); await sleep(60); }
    ok("walk C7: Full PC card switches the access mode and pushes rs-set-full true", w.__rsPermMode() === "full" && sentFull[sentFull.length - 1] === true, w.__rsPermMode() + " " + JSON.stringify(sentFull));
    calls.length = 0;
    out = await runTool({ tool: "run_command", arguments: { command: "dir" } });
    ok("walk C7: Full PC → run_command runs without a prompt", calls.length === 1 && d.getElementById("rs-approve").hidden && /exit 0/.test(out), out);
    ok("walk C7: no Ask card is rendered any more", !d.getElementById("rs-menu").querySelector('.rs-work-card[data-perm="ask"]') && d.getElementById("rs-menu").querySelectorAll(".rs-access-row .rs-work-card").length === 2);
    const sandboxCard = d.getElementById("rs-menu").querySelector('.rs-work-card[data-perm="sandbox"]');
    if (sandboxCard) { sandboxCard.click(); await sleep(60); }
    ok("walk C7: Sandbox only card switches back and pushes rs-set-full false", w.__rsPermMode() === "sandbox" && sentFull[sentFull.length - 1] === false, JSON.stringify(sentFull));
    calls.length = 0;
    out = await runTool({ tool: "run_command", arguments: { command: "dir" } });
    ok("walk C7: back in Sandbox → refused again, no bridge call", /^ERROR ACCESS_SANDBOX/.test(out) && calls.length === 0, out);

    ok("walk: no uncaught page errors during the walk", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (e) {
    ok("walk: completed without harness exceptions", false, e && e.stack || e);
  }
  finish();
})();
