// End-to-end simulation of the WHOLE ORscript content-script bundle on a
// Notion-AI-shaped page. Optional (needs jsdom, which the repo does not vendor):
//
//   cd ORscript && npm i --no-save jsdom && node tests/notion-e2e.js
//   NOTION_MODE=blocks node tests/notion-e2e.js   # block-editor transcript shape
//   CREW=1 node tests/notion-e2e.js               # Multi-Agent crew protocol (1.22.0)
//   SHOT=1 node tests/notion-e2e.js               # screen_capture needs studio_id (1.22.0 fix)
//   DIAG=1 ...                                    # print the [rs-diag] trace
//
// It builds a fake Notion /chat page (textarea composer with Notion's
// placeholder, role=button send/stop controls with Notion's test ids, transcript
// rows in either DOM shape the adapter knows), stubs chrome.* and the bridge
// (list_tools / call_tool), loads every script of the Notion content_script
// entry from manifest.json in order, clicks Start, plays a scripted model
// (bootstrap -> list_commands -> ready -> ###LUA### -> done) and asserts the
// full loop: bootstrap sent, bounded catalogue typed back, session started,
// execute_luau reached the bridge exactly once with newlines intact, the result
// was typed back, the loop ended, no page errors. This is the harness that
// found the three 1.21.4 Notion defects (see README).
const fs = require("fs");
const path = require("path");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch { console.error("tests/notion-e2e.js needs jsdom: run `npm i --no-save jsdom` in the ORscript folder first."); process.exit(2); }

const ROOT = process.env.ORSCRIPT_ROOT || path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const cs = manifest.content_scripts.filter((c) => c.matches.some((m) => m.includes("notion"))).sort((a,b)=>b.js.length-a.js.length)[0];
const scripts = cs.js;

const VERBOSE = !!process.env.VERBOSE;
const log = (...a) => console.log("[harness]", ...a);

// ── fake Notion page ──────────────────────────────────────────────────────
const html = `<!doctype html><html><head><title>Notion AI</title></head><body>
<div id="app" data-rect="0,0,1200,800">
  <nav id="sidebar" data-rect="0,0,240,800">Workspace</nav>
  <main role="main" data-rect="240,0,960,800">
    <div id="transcript" data-rect="240,0,960,620"></div>
    <div id="composer-wrap" data-rect="300,640,840,120">
      <div id="composer" data-rect="320,650,800,80">
        <textarea id="ta" placeholder="Ask, search, or make anything..." data-rect="330,655,700,40"></textarea>
        <div id="controls" data-rect="330,700,780,30">
          <div role="button" tabindex="0" aria-label="Attach files" data-rect="330,700,30,30"></div>
          <div role="button" tabindex="0" id="send" data-testid="agent-chat-send-button" aria-label="Submit AI message" aria-disabled="true" data-rect="1080,700,30,30"><svg></svg></div>
        </div>
      </div>
    </div>
  </main>
</div></body></html>`;

const dom = new JSDOM(html, {
  url: "https://www.notion.so/chat",
  pretendToBeVisual: true,
  runScripts: "dangerously",
});
const w = dom.window;
const d = w.document;
Object.defineProperty(w, "innerWidth", { value: 1200, configurable: true });
Object.defineProperty(w, "innerHeight", { value: 800, configurable: true });
Object.defineProperty(d, "hidden", { value: false, configurable: true });
Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });

// Geometry: nearest data-rect wins; our own extension nodes get a plausible
// fixed-position rect so the collision manager and placeBar have numbers.
const rectOf = (el) => {
  let n = el;
  while (n && n.nodeType === 1) {
    const r = n.getAttribute && n.getAttribute("data-rect");
    if (r) { const [x, y, wd, h] = r.split(",").map(Number); return { x, y, width: wd, height: h, left: x, top: y, right: x + wd, bottom: y + h }; }
    n = n.parentElement;
  }
  // default: something visible mid-page
  return { x: 240, y: 300, width: 960, height: 24, left: 240, top: 300, right: 1200, bottom: 324 };
};
w.Element.prototype.getBoundingClientRect = function () {
  const st = this.style;
  if (st && st.display === "none") return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  const r = rectOf(this);
  return { ...r, toJSON() { return r; } };
};
w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return this.getBoundingClientRect().width; }, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return this.getBoundingClientRect().height; }, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return this.style.display === "none" ? null : d.body; }, configurable: true });
w.HTMLElement.prototype.scrollIntoView = function () {};
w.Element.prototype.scrollTo = function () {};
w.scrollTo = () => {};
w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
w.cancelAnimationFrame = (id) => clearTimeout(id);
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
w.elementFromPoint = w.document.elementFromPoint = () => null;
d.execCommand = () => false;
w.HTMLCanvasElement.prototype.getContext = () => null;
if (!w.crypto) w.crypto = require("crypto").webcrypto;
w.Audio = class { constructor() {} play() { return Promise.resolve(); } pause() {} };
// jsdom has no DataTransfer; a minimal one lets the attachment path run
// (Notion's file drop is validated live, not here).
if (typeof w.DataTransfer !== "function") {
  w.DataTransfer = class {
    constructor() { const files = []; this.files = files; this.items = { add(f) { files.push(f); }, get length() { return files.length; } }; this.types = []; }
    setData() {} getData() { return ""; }
  };
}
w.AudioContext = undefined;
w.fetch = async () => { throw new Error("fetch disabled in harness"); };
w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" };
Object.defineProperty(w.navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", configurable: true });
w.open = () => null;
w.alert = () => {};
w.confirm = () => true;

// ── Notion behaviour ──────────────────────────────────────────────────────
const ta = d.getElementById("ta");
const send = d.getElementById("send");
const transcript = d.getElementById("transcript");
const userMessages = [];
let turn = 0;
let generating = false;
let stopBtn = null;
let onUserMessage = null; // set by the scenario
ta.addEventListener("input", () => {
  send.setAttribute("aria-disabled", ta.value.trim() ? "false" : "true");
});
const MODE = process.env.NOTION_MODE || "anchors"; // anchors | blocks
let blockSeq = 0;
const blockId = () => "b" + (++blockSeq).toString(16).padStart(8, "0") + "-0000-0000-0000-000000000000";
function userRow(text) {
  const row = d.createElement("div");
  row.style.display = "flex"; row.style.justifyContent = "flex-end";
  if (MODE === "anchors") {
    row.setAttribute("data-agent-service-scroll-anchor", "user-" + (++turn));
    const bubble = d.createElement("div");
    bubble.textContent = text;
    row.appendChild(bubble);
  } else {
    // block-editor user bubble: every line its own [data-block-id] block
    const root = d.createElement("div");
    root.setAttribute("data-content-editable-root", "true"); root.className = "whenContentEditable";
    text.split("\n").forEach((line) => { const b = d.createElement("div"); b.setAttribute("data-block-id", blockId()); const inner = d.createElement("div"); inner.textContent = line; b.appendChild(inner); root.appendChild(b); });
    row.appendChild(root);
  }
  transcript.appendChild(row);
  return row;
}
function assistantRow() {
  const row = d.createElement("div");
  row.style.display = "flex"; row.style.justifyContent = "flex-start";
  if (MODE === "anchors") {
    row.setAttribute("data-agent-service-scroll-anchor", "assistant-" + (++turn));
    transcript.appendChild(row);
    return row;
  }
  const root = d.createElement("div");
  root.setAttribute("data-content-editable-root", "true"); root.className = "whenContentEditable";
  row.appendChild(root);
  transcript.appendChild(row);
  return root;
}
function startGenerating() {
  generating = true;
  stopBtn = d.createElement("div");
  stopBtn.setAttribute("role", "button"); stopBtn.setAttribute("tabindex", "0");
  stopBtn.setAttribute("data-testid", "agent-stop-button");
  stopBtn.setAttribute("aria-label", "Stop generating");
  stopBtn.setAttribute("data-rect", "1080,700,30,30");
  send.style.display = "none";
  d.getElementById("controls").appendChild(stopBtn);
}
function stopGenerating() {
  generating = false;
  if (stopBtn) stopBtn.remove(); stopBtn = null;
  send.style.display = "";
}
function doSend() {
  const text = ta.value;
  if (!text.trim() || generating) return false;
  userMessages.push(text);
  clearAttachmentCards();
  ta.value = "";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  userRow(text);
  // first message turns the landing into a thread
  if (!/[?&]t=/.test(w.location.search)) w.history.replaceState({}, "", "/chat?t=thread" + Date.now().toString(36));
  if (VERBOSE) log("USER SENT:", text.slice(0, 200).replace(/\n/g, "\\n") + (text.length > 200 ? "…" : ""));
  else log("USER SENT (" + text.length + " chars):", text.slice(0, 90).replace(/\n/g, "\\n"));
  setTimeout(() => { startGenerating(); if (onUserMessage) onUserMessage(text); }, 60);
  return true;
}
send.addEventListener("click", () => { if (send.getAttribute("aria-disabled") !== "true") doSend(); });
// File drop onto the composer stages an attachment card (what Notion renders
// for a dropped image); sending clears it.
if (typeof w.DragEvent !== "function") {
  w.DragEvent = class extends w.MouseEvent {
    constructor(type, init) { super(type, init); this.dataTransfer = (init && init.dataTransfer) || null; }
  };
}
const composerEl = d.getElementById("composer");
composerEl.addEventListener("drop", (e) => {
  const files = (e.dataTransfer && e.dataTransfer.files) || [];
  for (const f of files) {
    const card = d.createElement("div");
    card.setAttribute("data-testid", "attachment-card");
    card.setAttribute("data-rect", "330,655,120,20");
    const span = d.createElement("span"); span.textContent = f.name; card.appendChild(span);
    composerEl.appendChild(card);
  }
});
const clearAttachmentCards = () => { for (const c of [...composerEl.querySelectorAll("[data-testid='attachment-card']")]) c.remove(); };
send.addEventListener("pointerdown", () => {});
ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } });

// Streams an assistant reply as markdown-ish DOM (code blocks in <pre><code>).
function replyWith(text, { stream = true } = {}) {
  const row = assistantRow();
  const parts = text.split(/```/);
  const render = (upto) => {
    row.innerHTML = "";
    const shown = text.slice(0, upto);
    const segs = shown.split(/```/);
    segs.forEach((seg, i) => {
      if (MODE === "blocks") {
        if (i % 2 === 1) {
          const cb = d.createElement("div"); cb.setAttribute("data-block-id", blockId()); cb.className = "notion-code-block";
          seg.replace(/^[a-z]*\n/, "").split("\n").forEach((line) => { const l = d.createElement("div"); l.textContent = line; cb.appendChild(l); });
          row.appendChild(cb);
        } else {
          seg.split("\n").forEach((line) => { if (!line && i > 0) return; const b = d.createElement("div"); b.setAttribute("data-block-id", blockId()); const inner = d.createElement("div"); inner.textContent = line; b.appendChild(inner); row.appendChild(b); });
        }
        return;
      }
      if (i % 2 === 1) {
        const pre = d.createElement("pre"); const code = d.createElement("code");
        code.textContent = seg.replace(/^[a-z]*\n/, ""); pre.appendChild(code); row.appendChild(pre);
      } else {
        seg.split("\n").forEach((line) => { const p = d.createElement("p"); p.textContent = line; row.appendChild(p); });
      }
    });
  };
  return new Promise((resolve) => {
    if (!stream) { render(text.length); stopGenerating(); resolve(row); return; }
    let i = 0;
    const step = () => {
      i = Math.min(text.length, i + 40);
      render(i);
      if (i < text.length) setTimeout(step, 30);
      else { setTimeout(() => { const copy = d.createElement("div"); copy.setAttribute("role", "button"); copy.setAttribute("aria-label", "Copy response"); row.appendChild(copy); stopGenerating(); resolve(row); }, 120); }
    };
    setTimeout(step, 100);
  });
}

// ── chrome.* stub ─────────────────────────────────────────────────────────
const storage = {};
const toolCalls = [];
const TOOLS = [
  { name: "execute_luau", description: "Run Luau in Studio", inputSchema: { type: "object", properties: { code: { type: "string" }, datamodel_type: { type: "string" } } } },
  { name: "get_studio_state", description: "Studio state", inputSchema: { type: "object", properties: {} } },
  { name: "screen_capture", description: "Capture", inputSchema: { type: "object", properties: {} } },
];
function statusObj() {
  return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, studioApp: true, studioProc: true, robloxProc: true, roblox_connected: true, local_connected: false, local_full: false, tools: TOOLS.length, servers: [], engine: "roblox" };
}
function background(msg) {
  switch (msg && msg.type) {
    case "status": return statusObj();
    case "studio_status": return { ok: true, studio: true, roblox_connected: true, connected: true };
    case "list_tools": return { ok: true, tools: TOOLS, studio: true, roblox_connected: true, servers: [] };
    case "command_catalog": return { ok: false };
    case "call_tool": {
      toolCalls.push({ name: msg.name, arguments: msg.arguments });
      log("TOOL CALL:", msg.name, JSON.stringify(msg.arguments || {}).slice(0, 160));
      if (msg.name === "execute_luau" && /GetLogHistory/.test(String(msg.arguments && msg.arguments.code || ""))) {
        // Studio Output probes (or_debug / Automatic Debugger): a clean console.
        return { ok: true, text: /MessageError/.test(msg.arguments.code) ? "[]" : JSON.stringify({ errors: [], warnings: [], info: [], errorCount: 0, warningCount: 0 }) };
      }
      if (msg.name === "execute_luau" && STATE && !/StatePart|SimPart/.test(String(msg.arguments && msg.arguments.code || ""))) msg = { name: "get_studio_state" };
      if (msg.name === "execute_luau") return { ok: true, text: "OK: Part created (SimPart)" };
      if (msg.name === "get_studio_state") {
        if (STATE) {
          // Shape of the real Studio MCP answer: a long multi-line dump with
          // brackets, quotes and a "command"-looking line in it.
          const lines = ["Place: Baseplate (id 0, universe 0)", "DataModel:", "  Workspace", "    Camera", "    Baseplate [Part] {\"size\":[512,20,512]}", "    SpawnLocation [SpawnLocation]"];
          for (let i = 0; i < 400; i++) lines.push("    Part" + i + " [Part] Anchored=true Size=(4, 1, 2) CFrame=(" + i + ", 0.5, 0) Material=Plastic");
          lines.push("  ReplicatedStorage", "    Remotes [Folder]", "  ServerScriptService", "    Main [Script] -- \"command\": \"noop\"", "Selection: []", "Run state: Edit");
          return { ok: true, text: lines.join("\n") };
        }
        return { ok: true, text: "{\"place\":\"Baseplate\",\"selection\":[]}" };
      }
      // Real Studio behaviour: every tool takes a studio_id; screen_capture is
      // the one that REFUSES the call without it, and list_roblox_studios is
      // how clients find it.
      if (msg.name === "list_roblox_studios") return { ok: true, text: JSON.stringify({ studios: [{ id: "studio-7f3a", name: "Baseplate", place_id: 123456 }] }) };
      if (msg.name === "screen_capture") {
        const sid = msg.arguments && msg.arguments.studio_id;
        if (!sid) return { ok: false, kind: "execution", errorCode: "INVALID_ARGUMENT", error: "Missing required arg: studio_id" };
        if (sid !== "studio-7f3a") return { ok: false, kind: "execution", errorCode: "TOOL_EXECUTION_ERROR", error: "Studio instance " + sid + " is not connected" };
        return { ok: true, text: "Captured the Studio viewport", images: [{ mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" }] };
      }
      return { ok: true, text: "OK" };
    }
    default: return { ok: false, error: "unhandled " + (msg && msg.type) };
  }
}
const listeners = [];
const storageApi = (name) => ({
  get(keys, cb) {
    const out = {};
    const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; }
    if (cb) { setTimeout(() => cb(out), 0); return; }
    return Promise.resolve(out);
  },
  set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
});
w.chrome = {
  runtime: {
    id: "harness-ext",
    lastError: undefined,
    getURL: (p) => "chrome-extension://harness-ext/" + p,
    sendMessage(msg, cb) {
      const r = background(msg);
      if (typeof cb === "function") setTimeout(() => cb(r), 5);
      return Promise.resolve(r);
    },
    onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {} },
    onConnect: { addListener() {} },
    connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
    getManifest: () => manifest,
  },
  storage: { local: storageApi("local"), sync: storageApi("sync"), session: storageApi("session"), onChanged: { addListener() {}, removeListener() {} } },
  i18n: { getMessage: () => "" },
};
const CREW = !!process.env.CREW; // CREW=1 → Multi-Agent crew scenario (1.22.0)
const SHOT = !!process.env.SHOT; // SHOT=1 → screenshot / studio_id scenario (1.22.0)
// STATE=1|2|3|4 → get_studio_state (big multi-line dump) then execute_luau (1.23.0):
//   1 = valid JSON envelope with \n escapes, 2 = JSON with RAW newlines inside the
//   code string (what Notion's model actually writes), 3 = JSON envelope whose
//   code is a nested ```lua fence.
const STATE = Number(process.env.STATE || 0);
// HELP=1 → the model answers a "how do templates work" question with orscript_help
// (1.23.1 regression: "Internal loop error: FEATURE_HELP_TOPICS is not defined").
const HELP = !!process.env.HELP;
// PUBLIC=1 → Public Skills (1.25.0): the model installs a user-made skill with
// public_skill_create, calls it by name (runs as execute_luau, relabelled), then
// installs a custom work mode and activates it; the Public tab lists both.
const PUBLIC = !!process.env.PUBLIC;
// TASKS=1 → Task list (1.25.0): enabled in Settings with two tasks; the model
// calls task_next, builds, marks it done with task_update; pill + state line +
// Tasks tab follow.
const TASKS = !!process.env.TASKS;
if (TASKS) w.chrome.storage.local.set({ rsTaskList: { enabled: true, tasks: [{ id: "t_a1", text: "Create a part named SimPart", status: "todo" }, { id: "t_b2", text: "Add a PointLight to it", status: "todo" }] } });
w.chrome.storage.local.set({ rsAllowPlaytest: true, rsDebugDiagnostics: !!process.env.DIAG, rsMultiAgent: CREW, ...(process.env.ASK ? { rsPermMode: "ask" } : {}) });

// ── load the bundle ───────────────────────────────────────────────────────
w.addEventListener("error", (e) => { console.error("[page error]", e.message, e.error && e.error.stack); });
const pageErrors = [];
w.onerror = (m, s, l, c, err) => { pageErrors.push(String(m)); console.error("[window.onerror]", m, err && err.stack); };
w.addEventListener("unhandledrejection", (e) => { pageErrors.push(String(e.reason)); console.error("[unhandledrejection]", e.reason); });
// Node's unhandled rejections from jsdom-executed promises surface on process:
process.on("unhandledRejection", (r) => { pageErrors.push(String(r && r.stack || r)); console.error("[unhandledRejection]", r && r.stack || r); });

for (const s of scripts) {
  const src = fs.readFileSync(path.join(ROOT, s), "utf8");
  const el = d.createElement("script");
  el.textContent = src + "\n//# sourceURL=" + s;
  const before = pageErrors.length;
  d.head.appendChild(el);
  if (pageErrors.length > before) { console.error("[load error]", s); process.exitCode = 1; }
}
log("bundle loaded;", scripts.length, "scripts");

// ── scenario ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if (pred()) return true; } catch {} await sleep(50); }
  throw new Error("timeout waiting for " + label);
}
const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };

(async () => {
  try {
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    ok("bar mounted", true);
    await sleep(1500);
    const bar = d.getElementById("rs-bar");
    const root = d.getElementById("rs-root");
    const dispBar = bar.style.display;
    ok("bar stays visible after 1.5s", dispBar !== "none", "display=" + JSON.stringify(dispBar) + " state=" + root.dataset.rsCollisionState);
    // Find the Start button
    const buttons = [...bar.querySelectorAll("button")];
    const startBtn = buttons.find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
    ok("start button present", !!startBtn, buttons.map((b) => (b.id || "") + ":" + (b.textContent || "").trim().slice(0, 20)).join(" | "));
    if (!startBtn) throw new Error("no start button");
    // Model behaviour: first user message (bootstrap) → acknowledge; then
    // catalogue → "ORscript is ready"; then build request → execute_luau; then
    // tool result → done.
    let phase = 0;
    const cmd = (name, params) => "```json\n" + JSON.stringify({ command: name, params }) + "\n```";
    onUserMessage = async (text) => {
      phase++;
      if (TASKS && phase >= 3) {
        if (phase === 3) await replyWith("Let me take the next task.\n" + cmd("task_next", {}));
        else if (phase === 4) await replyWith("Creating the part now.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\nprint(\"OK\")\n###END_LUA###");
        else if (phase === 5) await replyWith("Verified. Marking it done.\n" + cmd("task_update", { id: "#1", status: "done", notes: "SimPart created in Workspace" }));
        else await replyWith("Task 1 is done; task 2 is next whenever you want.");
        return;
      }
      if (PUBLIC && phase >= 3) {
        if (phase === 3) await replyWith("I'll build that as a public skill.\n" + cmd("public_skill_create", { definition: { kind: "skill", name: "lantern_row", title: "Lantern Row", description: "Places a row of anchored lantern parts with PointLights next to a target instance.", params: [{ name: "path", type: "string", description: "Full path of the parent", required: true }, { name: "count", type: "number", description: "How many lanterns", default: 3 }], luau: "local target = game\nfor seg in string.gmatch({{path}}, '[^.]+') do target = target:FindFirstChild(seg) if not target then return {ok=false, error='missing ' .. seg} end end\nlocal made = 0\nfor i = 1, {{count}} do local p = Instance.new('Part') p.Name = 'Lantern_' .. i p.Anchored = true p.Parent = target made += 1 end\nreturn {ok=true, created=made}" } }));
        else if (phase === 4) await replyWith("Installed. Let me try it.\n" + cmd("lantern_row", { path: "Workspace", count: 2 }));
        else if (phase === 5) await replyWith("Now the work mode.\n" + cmd("public_skill_create", { definition: { kind: "mode", title: "Horror Builder", badge: "HORROR", base: "visualizer", description: "Builds dread: fog, flicker, low light and sound layers.", mandate: "You are a horror ambience specialist. Every scene must have Atmosphere fog, low ambient light, at least one flickering light source and a sound layer; verify with a screenshot after each pass and never leave a scene fully lit.", focus: ["execute_luau", "get_studio_state"] } }));
        else if (phase === 6) await replyWith("Switching to it.\n" + cmd("public_skill_enable", { name: "horror_builder", activate: true }));
        else await replyWith("Done — Lantern Row is installed and Horror Builder is active.");
        return;
      }
      if (HELP && phase >= 3) {
        if (phase === 3) await replyWith("Let me check how this build does it.\n" + cmd("orscript_help", { question: "how do templates work in orscript?" }));
        else await replyWith("Templates are reusable task recipes saved in the OR menu. Done.");
        return;
      }
      if (SHOT && phase >= 3) {
        if (phase === 3) await replyWith("Let me look at the viewport first.\n" + cmd("or_screenshot", { target: "studio" }));
        else if (phase === 4) await replyWith("Now the raw tool.\n" + cmd("screen_capture", {}));
        else await replyWith("I can see the viewport. Done.");
        return;
      }
      if (STATE && phase >= 3) {
        const lua = 'local part = Instance.new("Part")\npart.Name = "StatePart"\npart.Size = Vector3.new(4, 1, 2)\npart.Anchored = true\npart.Parent = workspace\nprint("created", part:GetFullName())\nreturn part:GetFullName()';
        if (phase === 3) await replyWith("First I'll inspect the place.\n" + cmd("get_studio_state", {}));
        else if (phase === 4) {
          if (STATE === 1) await replyWith("The place is a Baseplate with 400 parts. Creating the part now.\n" + cmd("execute_luau", { code: lua, datamodel_type: "Edit" }));
          else if (STATE === 2) await replyWith("The place is a Baseplate with 400 parts. Creating the part now.\n```json\n{\"command\": \"execute_luau\", \"params\": {\"code\": \"" + lua.replace(/"/g, '\\"') + "\", \"datamodel_type\": \"Edit\"}}\n```");
          else if (STATE === 3) await replyWith("The place is a Baseplate with 400 parts. Creating the part now.\n```json\n{\"command\": \"execute_luau\", \"params\": {\"code\": \"```lua\\n" + lua.replace(/"/g, '\\"').replace(/\n/g, "\\n") + "\\n```\"}}\n```");
          // STATE=4: raw ###LUA### marker with a bled-in fence language tag on
          // its own line (Notion's code-block chrome) - parser bug 2 in 1.23.1.
          else await replyWith("The place is a Baseplate with 400 parts. Creating the part now.\n###LUA###\nlua\n" + lua + "\n###END_LUA###");
        }
        else await replyWith("Done — StatePart was created in Workspace.");
        return;
      }
      if (CREW && phase >= 3) {
        // Crew protocol: planner → (guarded mutation) → builder → build → done (refused) → done.
        if (phase === 3) await replyWith("Planning first.\n" + cmd("or_agent", { role: "planner", task: "plan the request" }));
        else if (phase === 4) await replyWith("Let me just build it.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\n###END_LUA###");
        else if (phase === 5) await replyWith("Handing off.\n" + cmd("or_agent", { role: "builder", goal: "SimPart in Workspace", plan: ["Create SimPart", "Verify it"], step: 1, task: "create the part" }));
        else if (phase === 6) await replyWith("Creating the part now.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\nprint(\"OK\")\n###END_LUA###");
        else if (phase === 7) await replyWith("Finishing.\n" + cmd("or_agent", { role: "done", summary: "SimPart created" }));
        else if (phase === 8) await replyWith("Verifying as tester.\n" + cmd("or_agent", { role: "tester", task: "verify", step_done: 2 }));
        else if (phase === 9) await replyWith("Reading the console.\n" + cmd("or_debug", {}));
        else if (phase === 10) await replyWith("Finishing.\n" + cmd("or_agent", { role: "done", summary: "SimPart created and verified" }));
        else await replyWith("Done — SimPart was created in Workspace and verified.");
        return;
      }
      if (phase === 1) {
        await replyWith("Understood. I will start by loading the command catalogue.\n```json\n{\"command\":\"list_commands\"}\n```");
      } else if (phase === 2) {
        await replyWith("ORscript is ready. Tell me what to build in Roblox Studio.");
      } else if (phase === 3) {
        await replyWith("Creating the part now.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\nprint(\"OK\")\n###END_LUA###");
      } else if (phase === 4) {
        await replyWith("Done — SimPart was created in Workspace.");
      } else {
        await replyWith("Noted.");
      }
    };
    startBtn.click();
    log("clicked Start");
    await waitFor(() => userMessages.length >= 1, 20000, "bootstrap send");
    ok("bootstrap prompt sent to Notion", /ORscript|ROBLOX|Roblox/i.test(userMessages[0]), userMessages[0].length + " chars");
    await waitFor(() => userMessages.length >= 2, 30000, "catalogue reply send");
    ok("catalogue result typed back", /list_commands|commands|Output/i.test(userMessages[1]), userMessages[1].slice(0, 80).replace(/\n/g, " "));
    await waitFor(() => /Agent running|Restart/i.test(bar.textContent || ""), 30000, "session ready");
    ok("session marked started", true, "bar=" + (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120));
    // The user types a request.
    await sleep(800);
    ta.value = "Create a part named SimPart";
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(100);
    ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await sleep(100);
    if (userMessages.length < 3) { send.click(); }
    await waitFor(() => userMessages.length >= 3, 5000, "user request send");
    // Ask mode: the user answers every approval prompt ~1 s after it appears.
    const approvals = [];
    if (process.env.ASK) {
      setInterval(() => {
        const root = d.getElementById("rs-approve");
        if (!root || root.hidden) return;
        const op = (d.getElementById("rs-approve-body") || {}).textContent || "";
        if (approvals.length && approvals[approvals.length - 1].at > Date.now() - 900) return;
        approvals.push({ op: op.slice(0, 40), at: Date.now() });
        setTimeout(() => { const allow = d.getElementById("rs-approve-allow"); if (allow && !root.hidden) allow.click(); }, 1000);
      }, 200);
    }
    if (STATE) {
      await waitFor(() => userMessages.length >= 4, 40000, "get_studio_state result");
      if (process.env.ASK) ok("read-only get_studio_state did not ask for approval", approvals.length === 0, JSON.stringify(approvals));
      ok("get_studio_state result typed back", /Baseplate|Output of 'get_studio_state'/.test(userMessages[3]), userMessages[3].length + " chars: " + userMessages[3].slice(0, 90).replace(/\n/g, " "));
      await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && /StatePart/.test(String(c.arguments.code || ""))), 60000, "execute_luau after get_studio_state");
      const ex = toolCalls.find((c) => c.name === "execute_luau" && /StatePart/.test(String(c.arguments.code || "")));
      ok("execute_luau code arrived with real newlines", /\n/.test(ex.arguments.code) && !/\\n/.test(ex.arguments.code) && !/```/.test(ex.arguments.code), JSON.stringify(ex.arguments.code).slice(0, 120));
      ok("execute_luau code has no leftover fence tag / Copy chrome line", !/^(?:lua|luau|json|copy)\s*$/im.test(ex.arguments.code.split("\n")[0]) && /^local part/.test(ex.arguments.code), JSON.stringify(ex.arguments.code.split("\n")[0]));
      await waitFor(() => userMessages.length >= 5, 40000, "execute_luau result");
      ok("execute_luau result fed back", /Output of 'execute_luau'|OK/.test(userMessages[4]), userMessages[4].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      ok("agent loop ended after the final text reply", true);
      ok("exactly one StatePart execute_luau ran", toolCalls.filter((c) => c.name === "execute_luau" && /StatePart/.test(String(c.arguments.code || ""))).length === 1);
      if (process.env.ASK) ok("execute_luau asked for approval exactly once and ran after Allow", approvals.length === 1 && /execute_luau/.test(approvals[0].op) && d.getElementById("rs-approve").parentElement === d.documentElement, JSON.stringify(approvals));
      ok("no OR-internal flags leaked to the bridge", !toolCalls.some((c) => Object.keys(c.arguments || {}).some((k) => /^_or/.test(k))), JSON.stringify(toolCalls.map((c) => Object.keys(c.arguments || {}))));
      await sleep(1000);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (TASKS) {
      ok("bootstrap carries the task list preference with the open tasks", /TASK LIST preference/.test(userMessages[0]) && /1\. Create a part named SimPart/.test(userMessages[0]), userMessages[0].length + " chars");
      ok("catalogue lists task_* commands while enabled", /task_next/.test(userMessages[1]) && /task_update/.test(userMessages[1]));
      const pill = d.getElementById("rs-task-pill");
      ok("bar shows the Tasks 0/2 pill", !!pill && !pill.hidden && pill.textContent === "Tasks 0/2", pill && pill.textContent);
      await waitFor(() => userMessages.length >= 4, 40000, "task_next result");
      ok("task_next returned task #1 and marked it doing", /"n": 1/.test(userMessages[3]) && /"status": "doing"/.test(userMessages[3]) && /Create a part named SimPart/.test(userMessages[3]), userMessages[3].slice(0, 160).replace(/\n/g, " "));
      ok("state line carries TASKS 0/2 and the next task", /TASKS 0\/2 next #1 "Create a part named SimPart"/.test(userMessages[3]), (userMessages[3].match(/\[SYSTEM_STATE:[^\]]*\]/) || [""])[0].slice(0, 200));
      await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || ""))), 40000, "execute_luau");
      await waitFor(() => userMessages.length >= 6, 40000, "task_update result");
      ok("task_update marked #1 done and points at #2", /"status": "done"/.test(userMessages[5]) && /"next": "#2 Add a PointLight to it"/.test(userMessages[5]), userMessages[5].slice(0, 200).replace(/\n/g, " "));
      ok("pill updated to Tasks 1/2", pill.textContent === "Tasks 1/2" && pill.dataset.done === "open", pill.textContent);
      ok("storage persisted the task state", storage.rsTaskList && storage.rsTaskList.enabled === true && storage.rsTaskList.tasks[0].status === "done" && storage.rsTaskList.tasks[0].notes === "SimPart created in Workspace");
      // Tasks tab in the cards panel
      pill.click(); await sleep(250);
      const rows = [...d.querySelectorAll(".rs-task-row")];
      ok("Tasks tab lists both tasks with #1 done", rows.length === 2 && rows[0].classList.contains("rs-task-done") && /Add a PointLight/.test(rows[1].textContent), rows.map((r) => r.className).join(" | "));
      ok("Tasks tab has add input, Run next and Run all", !!d.getElementById("rs-task-input") && !!d.querySelector("[data-task-run-next]") && !!d.querySelector("[data-task-run-all]"));
      // Settings toggle: disable → tab + pill + tools gone, tasks kept.
      const menuBtn = d.getElementById("rs-settings-btn"); if (menuBtn) { menuBtn.click(); await sleep(250); }
      const tgl = d.querySelector('.rs-tgl-row[data-mode="tasklist"]');
      ok("Settings has the Task list toggle, currently on", !!tgl && tgl.getAttribute("aria-checked") === "true", tgl && tgl.getAttribute("aria-checked"));
      if (tgl) { tgl.click(); await sleep(250); }
      ok("disabling hides the pill and keeps the tasks", pill.hidden && storage.rsTaskList.enabled === false && storage.rsTaskList.tasks.length === 2);
      ok("task_* commands refuse while disabled", /disabled/.test(w.eval("ORTaskList").run("task_list", {})));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      await sleep(800);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (PUBLIC) {
      ok("bootstrap advertises Public Skills", /PUBLIC SKILLS preference/.test(userMessages[0]) && /public_skill_create/.test(userMessages[0]), userMessages[0].length + " chars");
      await waitFor(() => userMessages.length >= 4, 40000, "public_skill_create result");
      ok("public_skill_create installed the skill", /"status": "INSTALLED"/.test(userMessages[3]) && /"name": "lantern_row"/.test(userMessages[3]) && !/Internal loop error|is not defined/.test(userMessages[3]), userMessages[3].slice(0, 160).replace(/\n/g, " "));
      ok("install modal shown to the user", !!d.querySelector(".rs-public-installed"), String(d.querySelector(".rs-public-installed") && d.querySelector(".rs-public-installed").textContent).slice(0, 80));
      await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && /public skill 'lantern_row'/.test(String(c.arguments.code || ""))), 40000, "lantern_row execute_luau");
      const ex = toolCalls.find((c) => c.name === "execute_luau" && /public skill 'lantern_row'/.test(String(c.arguments.code || "")));
      ok("lantern_row ran as execute_luau with params injected as Lua literals", /local args = \{\["path"\]="Workspace",\["count"\]=2\}/.test(ex.arguments.code) && /string\.gmatch\("Workspace"/.test(ex.arguments.code) && /for i = 1, 2 do/.test(ex.arguments.code), ex.arguments.code.split("\n").slice(0, 4).join(" | ").slice(0, 200));
      ok("no OR-internal flags leaked to the bridge", !Object.keys(ex.arguments).some((k) => /^_or/.test(k)), JSON.stringify(Object.keys(ex.arguments)));
      await waitFor(() => userMessages.length >= 5, 40000, "lantern_row result");
      ok("result is labelled with the public skill's name", /^Output of 'lantern_row'/.test(userMessages[4]) && !/Output of 'execute_luau'/.test(userMessages[4]), userMessages[4].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 6, 40000, "mode create result");
      ok("custom work mode installed", /"status": "INSTALLED"/.test(userMessages[5]) && /"kind": "mode"/.test(userMessages[5]) && /"name": "horror_builder"/.test(userMessages[5]), userMessages[5].slice(0, 160).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 7, 40000, "mode enable result");
      ok("public_skill_enable activated the mode", /"activated": true/.test(userMessages[6]), userMessages[6].slice(0, 120).replace(/\n/g, " "));
      const badge = d.getElementById("rs-work-badge");
      ok("bar badge shows the custom mode on its Visualizer base", !!badge && badge.textContent === "HORROR" && w.__rsWorkMode() === "visualizer" && w.__rsPublicMode() && w.__rsPublicMode().name === "horror_builder", badge && badge.textContent + " / " + w.__rsWorkMode());
      const sysPrompt = (() => { try { return w.eval("RS").buildSystemPrompt({ siteName: "Notion" }); } catch (e) { return "ERR " + e; } })();
      ok("system prompt now carries the custom mandate", /CUSTOM WORK MODE: HORROR BUILDER/.test(sysPrompt) && /layered on VISUALIZER/.test(sysPrompt) && /Custom work modes available: Horror Builder/.test(sysPrompt), sysPrompt.slice(0, 60));
      // Public tab in the cards panel lists both items.
      const cardsBtn = d.getElementById("rs-cards-btn") || [...d.querySelectorAll("#rs-bar button")].find((b) => /cards|library|templates/i.test(b.getAttribute("aria-label") || b.title || b.textContent || ""));
      if (cardsBtn) { cardsBtn.click(); await sleep(200); const tab = d.querySelector('.rs-cards-tab[data-tab="public"]'); if (tab) { tab.click(); await sleep(200); } }
      const rows = [...d.querySelectorAll(".rs-public-row")];
      ok("Public tab lists the skill and the mode", rows.length === 2 && rows.some((r) => /Lantern Row/.test(r.textContent)) && rows.some((r) => /Horror Builder/.test(r.textContent) && /ACTIVE/.test(r.textContent)), rows.map((r) => r.textContent.replace(/\s+/g, " ").slice(0, 60)).join(" || ") || "cardsBtn=" + !!cardsBtn);
      ok("Public tab has the prompt composer", !!d.getElementById("rs-public-prompt") && !!d.querySelector("[data-public-create]"));
      ok("registry stored the items and the active mode", Array.isArray(storage.rsPublicSkills) && storage.rsPublicSkills.length === 2 && typeof storage.rsPublicMode === "string");
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      ok("agent loop ended after the final text reply", true);
      await sleep(800);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (HELP) {
      await waitFor(() => userMessages.length >= 4, 40000, "orscript_help result");
      ok("orscript_help answered without an Internal loop error", !/Internal loop error|is not defined|ERROR/.test(userMessages[3]) && /Output of 'orscript_help'/.test(userMessages[3]), userMessages[3].slice(0, 160).replace(/\n/g, " "));
      ok("orscript_help resolved the templates topic", /"topic": "templates"/.test(userMessages[3]) && /"agentStarted": false/.test(userMessages[3]), userMessages[3].slice(0, 120).replace(/\n/g, " "));
      ok("orscript_help executed nothing in Studio", !toolCalls.some((c) => c.name === "execute_luau" && !/GetLogHistory/.test(String(c.arguments && c.arguments.code || ""))), JSON.stringify(toolCalls.map((c) => c.name)));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      ok("agent loop ended after the final text reply", true);
      await sleep(800);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (SHOT) {
      await waitFor(() => userMessages.length >= 4, 40000, "or_screenshot result");
      const caps = () => toolCalls.filter((c) => c.name === "screen_capture");
      ok("or_screenshot resolved a studio_id through list_roblox_studios", toolCalls.some((c) => c.name === "list_roblox_studios") && caps().length >= 1 && caps()[caps().length - 1].arguments.studio_id === "studio-7f3a", JSON.stringify(caps().map((c) => c.arguments)));
      ok("or_screenshot delivered the image instead of 'Missing required arg'", !/Missing required arg|INVALID_ARGUMENT/.test(userMessages[3]) && /captur|image|attached/i.test(userMessages[3]), userMessages[3].slice(0, 120).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 5, 40000, "screen_capture result");
      ok("raw screen_capture {} also carries the studio_id", caps().length >= 2 && caps().every((c) => c.arguments.studio_id === "studio-7f3a"), JSON.stringify(caps().map((c) => c.arguments)));
      ok("raw screen_capture result is the image, not an error", !/Missing required arg|INVALID_ARGUMENT/.test(userMessages[4]) && /image|captur/i.test(userMessages[4]), userMessages[4].slice(0, 120).replace(/\n/g, " "));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      await sleep(1000);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (CREW) {
      ok("bootstrap carries the crew protocol", /MULTI-AGENT/.test(userMessages[0]) && /ROLE GUARD/.test(userMessages[0]));
      await waitFor(() => userMessages.length >= 4, 30000, "planner handoff result");
      ok("or_agent planner handoff shows the board", /CREW HANDOFF #1/.test(userMessages[3]) && /ROLE=planner/.test(userMessages[3]), userMessages[3].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 5, 30000, "guarded mutation result");
      ok("planner mutation refused by the role guard, nothing executed", /ROLE GUARD/.test(userMessages[4]) && !toolCalls.some((c) => c.name === "execute_luau"), userMessages[4].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 6, 30000, "builder handoff result");
      ok("builder handoff shows GOAL + PLAN", /GOAL: SimPart in Workspace/.test(userMessages[5]) && /1\. \[>\] Create SimPart/.test(userMessages[5]));
      const badge = d.getElementById("rs-crew-badge");
      ok("bar shows the crew badge for the builder", !!badge && !badge.hidden && badge.textContent === "BUILD", badge && badge.textContent);
      await waitFor(() => toolCalls.some((c) => c.name === "execute_luau"), 30000, "builder execute_luau");
      await waitFor(() => userMessages.length >= 8, 30000, "done refused");
      ok("done is refused before verification", /NOT DONE YET/.test(userMessages[7]) && /TESTER has not verified/.test(userMessages[7]), userMessages[7].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 11, 45000, "done accepted");
      ok("tester verification unlocks done", /run verified/.test(userMessages[9]) && /CREW DONE/.test(userMessages[10]), userMessages[10].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      ok("agent loop ended after the final text reply", true);
      ok("exactly one SimPart execute_luau ran", toolCalls.filter((c) => c.name === "execute_luau" && /SimPart/.test(c.arguments.code)).length === 1);
      await sleep(1500);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    await waitFor(() => toolCalls.some((c) => c.name === "execute_luau"), 30000, "execute_luau call");
    ok("execute_luau executed from Notion reply", true, JSON.stringify(toolCalls.find((c) => c.name === "execute_luau").arguments).slice(0, 120));
    await waitFor(() => userMessages.length >= 4, 30000, "tool feedback send");
    ok("tool result fed back to Notion", /OK|SimPart|Output/.test(userMessages[3]), userMessages[3].slice(0, 100).replace(/\n/g, " "));
    await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
    const endEv = (w.__rsDiag || []).filter((e) => e.event === "loop.end").pop();
    ok("agent loop ended after the final text reply", !!endEv, JSON.stringify(endEv && endEv.data).slice(0, 160));
    ok("no duplicate execute_luau", toolCalls.filter((c) => c.name === "execute_luau" && /SimPart/.test(c.arguments.code)).length === 1);
    await sleep(1500);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
  } catch (e) {
    console.error("SCENARIO FAILED:", e && e.stack || e);
    process.exitCode = 1;
    const bar = d.getElementById("rs-bar");
    console.error("bar text:", bar && (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300));
    console.error("userMessages:", userMessages.length, "toolCalls:", toolCalls.length);
    console.error("diag tail:", (w.__rsDiagTail || []).slice(-15));
  } finally {
    console.log("summary:", results.filter((r) => r[1]).length, "pass /", results.filter((r) => !r[1]).length, "fail");
    setTimeout(() => process.exit(), 50);
  }
})();
