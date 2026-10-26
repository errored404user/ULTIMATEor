// End-to-end simulation of the WHOLE TotalScript bundle on a ClickUp-shaped page
// (1.28.0). Optional (needs jsdom):
//
//   cd TotalScript && npm i --no-save jsdom && node tests/clickup-e2e.js
//   CLOSED=1 node tests/clickup-e2e.js   # Brain panel not open: bar warns, nothing typed into task editors
//   DIAG=1 ...                           # print the [rs-diag] trace
//
// The fake page has what app.clickup.com has around Brain: a sidebar, a task
// view with a Quill description editor and a comment textarea, a Chat channel
// composer, and the Brain side panel (role=dialog in a CDK overlay pane) with
// its own Quill composer, send/stop buttons and ai-chat-message rows. The
// scripted model: bootstrap -> list_commands -> ready -> ###LUA### -> done.
// Asserts: the bar mounts on the Brain composer and survives the collision
// manager, every message goes into Brain (never a task/comment/channel box),
// the bounded catalogue is typed back, execute_luau reaches the bridge once
// with newlines intact, the result is typed back, the loop ends, no errors.
const fs = require("fs");
const path = require("path");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch { console.error("tests/clickup-e2e.js needs jsdom: run `npm i --no-save jsdom` in the TotalScript folder first."); process.exit(2); }

const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const cs = manifest.content_scripts.find((c) => c.matches.includes("https://app.clickup.com/*") && c.world !== "MAIN");
const scripts = cs.js;
const CLOSED = !!process.env.CLOSED;
const log = (...a) => console.log("[harness]", ...a);

// ── fake ClickUp page ─────────────────────────────────────────────────────
const brainPanel = `
  <div class="cdk-overlay-container"><div class="cdk-overlay-pane" data-rect="760,0,440,800">
    <cu-ai-side-panel class="ai-chat-panel" role="dialog" aria-label="ClickUp Brain" data-rect="760,0,440,800">
      <header class="ai-chat__header" data-rect="760,0,440,48"><b>Brain</b><button aria-label="New chat">+</button><button aria-label="Close">×</button></header>
      <div class="ai-chat__messages" id="msgs" style="overflow-y:auto" data-rect="760,48,440,600"></div>
      <div class="ai-chat__composer" id="composer" data-rect="770,660,420,120">
        <div class="ai-chat__editor cu-ai-editor" data-rect="776,666,408,60"><div id="ed" class="ql-editor" contenteditable="true" data-placeholder="Ask AI anything..." data-rect="776,666,408,60"><p><br></p></div></div>
        <div class="ai-chat__actions" id="actions" data-rect="776,730,408,40">
          <button type="button" aria-label="Attach" data-rect="776,730,30,30"></button>
          <input type="file" hidden>
          <button type="button" id="send" data-test="ai-chat__send-button" aria-label="Send" disabled data-rect="1150,730,30,30"><svg></svg></button>
        </div>
      </div>
    </cu-ai-side-panel>
  </div></div>`;
const html = `<!doctype html><html><head><title>ClickUp</title></head><body>
<div id="app" data-rect="0,0,1200,800">
  <nav class="cu-sidebar" data-rect="0,0,240,800"><a>Home</a><a>Inbox</a><a>AI</a></nav>
  <main class="cu-main" data-rect="240,0,520,800">
    <cu-task-view class="cu-task-view" data-rect="240,0,520,800">
      <h1 data-test="task-view__title">Fix lantern bug</h1>
      <div class="cu-task-description" data-rect="250,60,500,200"><div id="desc" class="ql-editor" contenteditable="true" data-placeholder="Add description" data-rect="250,60,500,200"><p>Players report a message about lanterns not lighting.</p></div></div>
      <div class="cu-comments" data-rect="250,300,500,400">
        <div class="cu-comment-message" data-rect="250,300,500,40">Earlier comment about the sprint.</div>
        <textarea id="comment" placeholder="Write a comment..." data-rect="250,700,500,60"></textarea>
      </div>
    </cu-task-view>
    <cu-chat class="cu-chat-view" style="display:none"><div class="cu-chat-input"><div class="ql-editor" contenteditable="true" data-placeholder="Message #general"></div></div></cu-chat>
  </main>
  ${CLOSED ? "" : brainPanel}
</div></body></html>`;

const dom = new JSDOM(html, { url: "https://app.clickup.com/9012345/v/l/li/901234567", pretendToBeVisual: true, runScripts: "dangerously" });
const w = dom.window;
const d = w.document;
Object.defineProperty(w, "innerWidth", { value: 1200, configurable: true });
Object.defineProperty(w, "innerHeight", { value: 800, configurable: true });
Object.defineProperty(d, "hidden", { value: false, configurable: true });
Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
const rectOf = (el) => {
  let n = el;
  while (n && n.nodeType === 1) {
    const r = n.getAttribute && n.getAttribute("data-rect");
    if (r) { const [x, y, wd, h] = r.split(",").map(Number); return { x, y, width: wd, height: h, left: x, top: y, right: x + wd, bottom: y + h }; }
    n = n.parentElement;
  }
  return { x: 240, y: 300, width: 520, height: 24, left: 240, top: 300, right: 760, bottom: 324 };
};
w.Element.prototype.getBoundingClientRect = function () {
  if (this.style && this.style.display === "none") return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  if (this.closest && this.closest("[style*='display: none'], [style*='display:none']")) return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  const r = rectOf(this);
  return { ...r, toJSON() { return r; } };
};
w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return this.getBoundingClientRect().width; }, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return this.getBoundingClientRect().height; }, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return this.style.display === "none" ? null : d.body; }, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
w.HTMLElement.prototype.scrollIntoView = function () {};
w.Element.prototype.scrollTo = function () {};
w.scrollTo = () => {};
w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
w.cancelAnimationFrame = (id) => clearTimeout(id);
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
w.elementFromPoint = w.document.elementFromPoint = () => null;
w.HTMLCanvasElement.prototype.getContext = () => null;
if (!w.crypto) w.crypto = require("crypto").webcrypto;
w.Audio = class { constructor() {} play() { return Promise.resolve(); } pause() {} };
if (typeof w.DataTransfer !== "function") {
  w.DataTransfer = class {
    constructor() { const files = []; this.files = files; this.items = { add(f) { files.push(f); }, get length() { return files.length; } }; this.types = []; this._d = {}; }
    setData(t, v) { this._d[t] = v; } getData(t) { return this._d[t] || ""; }
  };
}
w.AudioContext = undefined;
w.fetch = async () => { throw new Error("fetch disabled in harness"); };
w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" };
Object.defineProperty(w.navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", configurable: true });
w.open = () => null; w.alert = () => {}; w.confirm = () => true;

// ── fake Quill + Brain behaviour ──────────────────────────────────────────
// execCommand("insertText") writes into the focused contenteditable as Quill
// would (one <p> per line) and fires input; the editor's text is what the
// adapter reads back.
const edText = (el) => [...el.querySelectorAll("p")].map((p) => p.textContent).join("\n").replace(/\n+$/, "");
d.execCommand = (cmd, _ui, text) => {
  if (cmd !== "insertText") return false;
  const el = d.activeElement && d.activeElement.closest && d.activeElement.closest("[contenteditable='true']");
  if (!el) return false;
  el.innerHTML = String(text).split("\n").map((l) => "<p>" + (l ? l.replace(/&/g, "&amp;").replace(/</g, "&lt;") : "<br>") + "</p>").join("");
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
  return true;
};
const typedInto = { desc: 0, comment: 0, ed: 0 };
for (const id of ["desc", "comment"]) { const el = d.getElementById(id); if (el) el.addEventListener("input", () => { typedInto[id]++; }); }
const userMessages = [];
let generating = false, stopBtn = null, onUserMessage = null;
const ed = d.getElementById("ed"), send = d.getElementById("send"), msgs = d.getElementById("msgs");
if (ed) {
  ed.addEventListener("input", () => { typedInto.ed++; send.disabled = !edText(ed).trim(); });
  ed.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } });
  send.addEventListener("click", () => { if (!send.disabled) doSend(); });
}
function row(role, text) {
  const r = d.createElement("div");
  r.className = "ai-chat-message ai-chat-message--" + role;
  r.setAttribute("data-rect", role === "user" ? "900,100,280,40" : "770,100,420,120");
  const c = d.createElement("div"); c.className = "ai-chat-message__content" + (role === "assistant" ? " markdown" : "");
  if (text != null) { const p = d.createElement("p"); p.textContent = text; c.appendChild(p); }
  r.appendChild(c); msgs.appendChild(r);
  return c;
}
function startGenerating() {
  generating = true;
  stopBtn = d.createElement("button"); stopBtn.type = "button"; stopBtn.setAttribute("data-test", "ai-chat__stop-button"); stopBtn.setAttribute("aria-label", "Stop generating"); stopBtn.setAttribute("data-rect", "1150,730,30,30");
  send.style.display = "none"; d.getElementById("actions").appendChild(stopBtn);
}
function stopGenerating() { generating = false; if (stopBtn) stopBtn.remove(); stopBtn = null; send.style.display = ""; }
function doSend() {
  const text = edText(ed);
  if (!text.trim() || generating) return false;
  userMessages.push(text);
  ed.innerHTML = "<p><br></p>"; ed.dispatchEvent(new w.Event("input", { bubbles: true }));
  row("user", text);
  log("USER SENT (" + text.length + " chars):", text.slice(0, 90).replace(/\n/g, "\\n"));
  setTimeout(() => { startGenerating(); if (onUserMessage) onUserMessage(text); }, 60);
  return true;
}
function replyWith(text) {
  const c = row("assistant", null);
  const render = (upto) => {
    c.innerHTML = "";
    text.slice(0, upto).split(/```/).forEach((seg, i) => {
      if (i % 2 === 1) { const pre = d.createElement("pre"); const code = d.createElement("code"); code.textContent = seg.replace(/^[a-z]*\n/, ""); pre.appendChild(code); c.appendChild(pre); }
      else seg.split("\n").forEach((line) => { const p = d.createElement("p"); p.textContent = line; c.appendChild(p); });
    });
  };
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      i = Math.min(text.length, i + 40); render(i);
      if (i < text.length) setTimeout(step, 30);
      else setTimeout(() => { const tb = d.createElement("div"); tb.className = "message-actions"; const copy = d.createElement("button"); copy.setAttribute("aria-label", "Copy"); copy.textContent = "Copy"; tb.appendChild(copy); c.appendChild(tb); stopGenerating(); resolve(c); }, 300);
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
function background(msg) {
  switch (msg && msg.type) {
    case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, studioApp: true, studioProc: true, robloxProc: true, roblox_connected: true, local_connected: false, local_full: false, tools: TOOLS.length, servers: [], engine: "roblox" };
    case "studio_status": return { ok: true, studio: true, roblox_connected: true, connected: true };
    case "list_tools": return { ok: true, tools: TOOLS, studio: true, roblox_connected: true, servers: [] };
    case "command_catalog": return { ok: false };
    case "call_tool": {
      toolCalls.push({ name: msg.name, arguments: msg.arguments });
      log("TOOL CALL:", msg.name, JSON.stringify(msg.arguments || {}).slice(0, 160));
      if (msg.name === "execute_luau" && /GetLogHistory/.test(String(msg.arguments && msg.arguments.code || ""))) return { ok: true, text: /MessageError/.test(msg.arguments.code) ? "[]" : JSON.stringify({ errors: [], warnings: [], info: [], errorCount: 0, warningCount: 0 }) };
      if (msg.name === "execute_luau") return { ok: true, text: "OK: Part created (SimPart)" };
      if (msg.name === "get_studio_state") return { ok: true, text: "{\"place\":\"Baseplate\",\"selection\":[]}" };
      return { ok: true, text: "OK" };
    }
    default: return { ok: false, error: "unhandled " + (msg && msg.type) };
  }
}
const storageApi = () => ({
  get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) { setTimeout(() => cb(out), 0); return; } return Promise.resolve(out); },
  set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
});
w.chrome = {
  runtime: { id: "harness-ext", lastError: undefined, getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 5); return Promise.resolve(r); }, onMessage: { addListener() {}, removeListener() {} }, onConnect: { addListener() {} }, connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }), getManifest: () => manifest },
  storage: { local: storageApi(), sync: storageApi(), session: storageApi(), onChanged: { addListener() {}, removeListener() {} } },
  i18n: { getMessage: () => "" },
};
w.chrome.storage.local.set({ rsAllowPlaytest: true, rsDebugDiagnostics: !!process.env.DIAG });

// ── load the bundle ───────────────────────────────────────────────────────
const pageErrors = [];
w.onerror = (m, s, l, c, err) => { pageErrors.push(String(m)); console.error("[window.onerror]", m, err && err.stack); };
w.addEventListener("unhandledrejection", (e) => { pageErrors.push(String(e.reason)); console.error("[unhandledrejection]", e.reason); });
process.on("unhandledRejection", (r) => { pageErrors.push(String(r && r.stack || r)); console.error("[unhandledRejection]", r && r.stack || r); });
for (const s of scripts) {
  const el = d.createElement("script");
  el.textContent = fs.readFileSync(path.join(ROOT, s), "utf8") + "\n//# sourceURL=" + s;
  const before = pageErrors.length;
  d.head.appendChild(el);
  if (pageErrors.length > before) { console.error("[load error]", s); process.exitCode = 1; }
}
log("bundle loaded;", scripts.length, "scripts");

// ── scenario ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { if (pred()) return true; } catch {} await sleep(50); } throw new Error("timeout waiting for " + label); }
const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };

(async () => {
  try {
    const P = w.RSProvider;
    ok("provider is ClickUp Brain", P && P.id === "clickup" && P.displayName === "ClickUp Brain");
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    ok("bar mounted", true);
    await sleep(1500);
    const bar = d.getElementById("rs-bar");
    const root = d.getElementById("rs-root");
    ok(CLOSED ? "bar stays visible (docked) while Brain is closed" : "bar stays visible after 1.5s (Brain dialog is not treated as a blocking modal)", bar.style.display !== "none" && root.dataset.rsCollisionState !== "hidden", "display=" + JSON.stringify(bar.style.display) + " state=" + root.dataset.rsCollisionState);
    if (CLOSED) {
      ok("no composer while Brain is closed", P.getEditor() === null);
      ok("mode warning asks to open Brain", /open Brain's chat first/.test(P.modeWarning()));
      const buttons = [...bar.querySelectorAll("button")];
      const startBtn = buttons.find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
      if (startBtn) { startBtn.click(); await sleep(6500); }
      ok("Start never typed into the task description or comment box", typedInto.desc === 0 && typedInto.comment === 0 && d.getElementById("desc").textContent.indexOf("TotalScript") < 0, JSON.stringify(typedInto));
      ok("bar warning line tells the user to open Brain", /open Brain/i.test(root.textContent || ""), (root.textContent || "").replace(/\s+/g, " ").slice(0, 160));
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return finish();
    }
    ok("composer is the Brain Quill box", P.getEditor() === ed);
    ok("bar is placed inside / next to the Brain panel", !!bar.closest("cu-ai-side-panel") || bar.classList.contains("rs-bar-anchored") || bar.classList.contains("rs-bar-inline") || root.contains(bar), bar.className);
    const buttons = [...bar.querySelectorAll("button")];
    const startBtn = buttons.find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
    ok("start button present", !!startBtn);
    let phase = 0;
    onUserMessage = async () => {
      phase++;
      if (phase === 1) await replyWith("Understood. Loading the command catalogue.\n```json\n{\"command\":\"list_commands\"}\n```");
      else if (phase === 2) await replyWith("TotalScript is ready. Tell me what to build in Roblox Studio.");
      else if (phase === 3) await replyWith("Creating the part now.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\nprint(\"OK\")\n###END_LUA###");
      else if (phase === 4) await replyWith("Done — **SimPart** was created in `Workspace`.");
      else await replyWith("Noted.");
    };
    startBtn.click();
    log("clicked Start");
    await waitFor(() => userMessages.length >= 1, 20000, "bootstrap send");
    ok("bootstrap prompt sent into Brain", /TotalScript|Roblox/i.test(userMessages[0]), userMessages[0].length + " chars");
    ok("bootstrap carries the ClickUp rules (no ClickUp actions, json block)", /never create, edit, assign or search ClickUp tasks/.test(userMessages[0]) && /ONE fenced code block/.test(userMessages[0]));
    ok("bootstrap fits the compact budget", userMessages[0].length <= 20000, userMessages[0].length + " chars");
    await waitFor(() => userMessages.length >= 2, 30000, "catalogue reply send");
    ok("bounded catalogue typed back", /list_commands|Output/i.test(userMessages[1]) && userMessages[1].length <= 30000, userMessages[1].length + " chars");
    await waitFor(() => /Agent running|Restart/i.test(bar.textContent || ""), 30000, "session ready");
    ok("session marked started", true, (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100));
    await sleep(800);
    // The user asks for a build through Brain's own box + Enter.
    ed.focus(); d.execCommand("insertText", false, "Create a part named SimPart");
    await sleep(100);
    ed.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await sleep(100);
    if (userMessages.length < 3) send.click();
    await waitFor(() => userMessages.length >= 3, 5000, "user request send");
    await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || ""))), 60000, "execute_luau");
    const ex = toolCalls.find((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || "")));
    ok("execute_luau reached the bridge with real newlines, no fences", /\n/.test(ex.arguments.code) && !/```/.test(ex.arguments.code) && /^local p = Instance\.new/.test(ex.arguments.code), JSON.stringify(ex.arguments.code).slice(0, 120));
    await waitFor(() => userMessages.length >= 4, 40000, "execute_luau result");
    ok("result typed back into Brain", /Output of 'execute_luau'|OK: Part created/.test(userMessages[3]), userMessages[3].slice(0, 100).replace(/\n/g, " "));
    await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
    ok("agent loop ended after the final text reply", true);
    ok("exactly one SimPart execute_luau ran", toolCalls.filter((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || ""))).length === 1);
    ok("no TotalScript-internal flags leaked to the bridge", !toolCalls.some((c) => Object.keys(c.arguments || {}).some((k) => /^_total/.test(k))));
    ok("nothing was ever typed into the task description or comment box", typedInto.desc === 0 && typedInto.comment === 0, JSON.stringify(typedInto));
    ok("command <pre> blocks in Brain replies are masked", !!msgs.querySelector("pre.rs-tool-hide"));
    const tiers = (w.__rsDiag || []).filter((e) => /^clickup\./.test(e.event)).map((e) => e.event);
    ok("adapter diagnostics present", tiers.includes("clickup.init") && tiers.includes("clickup.send"), tiers.slice(0, 6).join(","));
    await sleep(800);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
  } catch (e) { console.error(e); process.exitCode = 1; }
  finish();
})();
function finish() {
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  setTimeout(() => process.exit(process.exitCode || 0), 50);
}
