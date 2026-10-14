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
      if (msg.name === "execute_luau") return { ok: true, text: "OK: Part created (SimPart)" };
      if (msg.name === "get_studio_state") return { ok: true, text: "{\"place\":\"Baseplate\",\"selection\":[]}" };
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
w.chrome.storage.local.set({ rsAllowPlaytest: true, rsDebugDiagnostics: !!process.env.DIAG, rsMultiAgent: CREW });

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
      if (SHOT && phase >= 3) {
        if (phase === 3) await replyWith("Let me look at the viewport first.\n" + cmd("or_screenshot", { target: "studio" }));
        else if (phase === 4) await replyWith("Now the raw tool.\n" + cmd("screen_capture", {}));
        else await replyWith("I can see the viewport. Done.");
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
