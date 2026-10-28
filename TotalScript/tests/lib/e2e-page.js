"use strict";
// Shared scaffolding for the whole-bundle provider e2e harnesses (1.85.0):
// tests/vani-e2e.js and tests/mimo-e2e.js (tests/clickup-e2e.js predates this
// file and keeps its own inline copy).
//
// What it gives a harness:
//   createPage({ html, url, host, mainWorld })  - a jsdom page with the layout
//       stubs the bundle needs (rects from data-rect, visibility, rAF,
//       observers, DataTransfer, Node's fetch/Response/ReadableStream so a
//       fake site can STREAM a reply through the real MAIN-world tap), the
//       chrome.* stub whose background answers status / list_tools /
//       call_tool, and loadBundle() which injects the manifest's content
//       scripts for `host` in order - MAIN-world files first, exactly as
//       Chrome would.
//   studioSim()  - a long-lived tests/lib/studio_sim.py (lupa miniature
//       DataModel). execute_luau calls from the bundle run there, so the
//       harness can verify a REAL (simulated) result - the Part exists, has
//       the requested size, is anchored - instead of a canned "OK".
//   sse(frames)  - a text/event-stream Response body from an array of frames.
//
// Everything here is MOCKED: no provider site, no Studio, no model.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch { console.error("the provider e2e harnesses need jsdom: run `npm i --no-save jsdom` in the TotalScript folder first."); process.exit(2); }

const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const log = (...a) => console.log("[harness]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Studio stand-in (lupa) ────────────────────────────────────────────────
function studioSim() {
  const py = spawn("python3", [path.join(__dirname, "studio_sim.py")], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let buf = "", seq = 0, ready = null, unavailable = false;
  const readyP = new Promise((res) => { ready = res; });
  py.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 0) { unavailable = !!m.unavailable; ready(!unavailable); continue; }
      const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); }
    }
  });
  py.on("exit", () => { unavailable = true; ready(false); for (const p of pending.values()) p({ ok: false, text: "studio sim exited" }); pending.clear(); });
  return {
    ready: () => readyP,
    available: () => !unavailable,
    exec(code) {
      if (unavailable) return Promise.resolve({ ok: false, text: "studio sim unavailable" });
      const id = ++seq;
      return new Promise((res) => { pending.set(id, res); py.stdin.write(JSON.stringify({ id, code }) + "\n"); });
    },
    close() { try { py.stdin.write(JSON.stringify({ op: "quit" }) + "\n"); } catch {} try { py.kill(); } catch {} },
  };
}

// ── SSE body helper ───────────────────────────────────────────────────────
// frames: array of strings (already "event: x\ndata: {...}\n\n" shaped) or of
// { data, event } objects; `pace` ms between frames; onFrame(i) lets the fake
// site mirror the stream into its DOM at the same moment the tap sees it.
function sse(frames, { pace = 25, onFrame, headers } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const text = typeof f === "string" ? f : `${f.event ? "event: " + f.event + "\n" : ""}data: ${typeof f.data === "string" ? f.data : JSON.stringify(f.data)}\n\n`;
        controller.enqueue(enc.encode(text));
        if (onFrame) { try { await onFrame(i, f); } catch {} }
        await sleep(pace);
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: Object.assign({ "content-type": "text/event-stream; charset=utf-8" }, headers || {}) });
}

// ── jsdom shims shared by the whole-bundle pages and the adapter-level tests ──
// Rects come from data-rect="x,y,w,h" (inherited from the nearest ancestor),
// display:none is a zero box, innerText approximates block/line breaks, and
// Node's streaming primitives are exposed so a fake site can answer fetch()
// with SSE that the real stream-net.js tap can read.
function installDomShims(w) {
  const d = w.document;
  Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(w, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(d, "hidden", { value: false, configurable: true });
  Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
  const zero = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  const rectOf = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const r = n.getAttribute && n.getAttribute("data-rect");
      if (r) { const [x, y, wd, h] = r.split(",").map(Number); return { x, y, width: wd, height: h, left: x, top: y, right: x + wd, bottom: y + h }; }
      n = n.parentElement;
    }
    return { x: 300, y: 300, width: 600, height: 24, left: 300, top: 300, right: 900, bottom: 324 };
  };
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.style && this.style.display === "none") return zero;
    if (this.closest && this.closest("[style*='display: none'], [style*='display:none'], [hidden]")) return zero;
    const r = rectOf(this);
    return { ...r, toJSON() { return r; } };
  };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return this.getBoundingClientRect().width; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return this.getBoundingClientRect().height; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return this.style.display === "none" ? null : d.body; }, configurable: true });
  // innerText ≈ textContent with block/line breaks (what the adapters read).
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() {
      let out = "";
      const walk = (n) => {
        if (n.nodeType === 3) { out += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        if (n.tagName === "BR") { out += "\n"; return; }
        const block = /^(P|DIV|PRE|LI|UL|OL|H[1-6]|SECTION|ARTICLE|TR|BLOCKQUOTE)$/.test(n.tagName);
        if (block && out && !out.endsWith("\n")) out += "\n";
        for (const c of n.childNodes) walk(c);
        if (block && !out.endsWith("\n")) out += "\n";
      };
      walk(this);
      return out.replace(/\n$/, "");
    },
    set(v) { this.textContent = v; }, configurable: true,
  });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.Element.prototype.scrollTo = function () {};
  w.scrollTo = () => {};
  w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.elementFromPoint = d.elementFromPoint = () => null;
  w.HTMLCanvasElement.prototype.getContext = () => null;
  if (!w.crypto) w.crypto = require("crypto").webcrypto;
  w.Audio = class { constructor() {} play() { return Promise.resolve(); } pause() {} };
  w.AudioContext = undefined;
  if (typeof w.DataTransfer !== "function") {
    w.DataTransfer = class {
      constructor() { const files = []; this.files = files; this.items = { add(f) { files.push(f); }, get length() { return files.length; } }; this.types = []; this._d = {}; }
      setData(t, v) { this._d[t] = v; } getData(t) { return this._d[t] || ""; }
    };
  }
  // Node's streaming primitives so a fake site can answer fetch() with SSE and
  // the real stream-net.js tap can read it (res.clone().body.getReader()).
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.ReadableStream = ReadableStream; w.Response = Response; w.Request = Request; w.Headers = Headers;
  w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" };
  Object.defineProperty(w.navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", configurable: true });
  w.open = () => null; w.alert = () => {}; w.confirm = () => true;
}

// ── page ──────────────────────────────────────────────────────────────────
function createPage({ html, url, host, mainWorld = true, tools, onToolCall, diag }) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: "dangerously" });
  const w = dom.window, d = w.document;
  installDomShims(w);

  // ── chrome.* stub ──
  const storage = {};
  const toolCalls = [];
  const TOOLS = tools || [
    { name: "execute_luau", description: "Run Luau in Studio", inputSchema: { type: "object", properties: { code: { type: "string" }, datamodel_type: { type: "string" } } } },
    { name: "get_studio_state", description: "Studio state", inputSchema: { type: "object", properties: {} } },
    { name: "screen_capture", description: "Capture", inputSchema: { type: "object", properties: {} } },
  ];
  async function background(msg) {
    switch (msg && msg.type) {
      case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, studioApp: true, studioProc: true, robloxProc: true, roblox_connected: true, local_connected: false, local_full: false, engine: "roblox", servers: [] };
      case "studio_status": return { ok: true, studio: true, roblox_connected: true, connected: true };
      case "list_tools": return { ok: true, tools: TOOLS, studio: true, roblox_connected: true, servers: [] };
      case "command_catalog": return { ok: false };
      case "call_tool": {
        const rec = { name: msg.name, arguments: msg.arguments, at: Date.now() };
        toolCalls.push(rec);
        log("TOOL CALL:", msg.name, JSON.stringify(msg.arguments || {}).slice(0, 140).replace(/\n/g, "\\n"));
        if (onToolCall) { const r = await onToolCall(msg, rec); if (r) return r; }
        if (msg.name === "get_studio_state") return { ok: true, text: "{\"place\":\"Baseplate\",\"selection\":[]}" };
        return { ok: true, text: "OK" };
      }
      default: return { ok: false, error: "unhandled " + (msg && msg.type) };
    }
  }
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && !Array.isArray(keys) && typeof keys === "object") out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  w.chrome = {
    runtime: {
      id: "harness-ext", lastError: undefined, getURL: (p) => "chrome-extension://harness-ext/" + p,
      sendMessage(msg, cb) { const p = background(msg); if (typeof cb === "function") p.then((r) => setTimeout(() => cb(r), 2)); return p; },
      onMessage: { addListener() {}, removeListener() {} }, connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }),
      getManifest: () => manifest,
    },
    storage: { local: storageApi(), sync: storageApi(), session: storageApi(), onChanged: { addListener() {}, removeListener() {} } },
    i18n: { getMessage: () => "" },
  };
  w.chrome.storage.local.set({ rsAllowPlaytest: true, rsDebugDiagnostics: !!(diag || process.env.DIAG) });

  const pageErrors = [];
  w.onerror = (m, s, l, c, err) => { pageErrors.push(String(m)); console.error("[window.onerror]", m, err && err.stack); };
  w.addEventListener("unhandledrejection", (e) => { pageErrors.push(String(e.reason)); console.error("[unhandledrejection]", e.reason); });
  process.on("unhandledRejection", (r) => { pageErrors.push(String(r && r.stack || r)); console.error("[unhandledRejection]", r && r.stack || r); });

  const pattern = `https://${host}/*`;
  const isolated = manifest.content_scripts.find((c) => c.matches.includes(pattern) && c.world !== "MAIN");
  const mains = manifest.content_scripts.filter((c) => c.matches.includes(pattern) && c.world === "MAIN");
  const inject = (file) => {
    const el = d.createElement("script");
    el.textContent = fs.readFileSync(path.join(ROOT, file), "utf8") + "\n//# sourceURL=" + file;
    const before = pageErrors.length;
    d.head.appendChild(el);
    if (pageErrors.length > before) { console.error("[load error]", file); process.exitCode = 1; }
  };
  function loadBundle() {
    const files = [];
    if (mainWorld) for (const m of mains) files.push(...m.js);
    files.push(...isolated.js);
    for (const f of files) inject(f);
    log("bundle loaded;", files.length, "scripts (" + mains.reduce((n, m) => n + m.js.length, 0) + " MAIN-world)");
    return files;
  }
  return { dom, w, d, storage, toolCalls, pageErrors, loadBundle, isolated, mains, log };
}

// ── scenario helpers ──────────────────────────────────────────────────────
function makeReporter() {
  const results = [];
  const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + String(extra).slice(0, 300) : "")); if (!cond) process.exitCode = 1; };
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { if (pred()) return true; } catch {} await sleep(50); } throw new Error("timeout waiting for " + label); }
  function finish(title, pageErrors, extra) {
    const passed = results.filter((r) => r[1]).length, failed = results.length - passed;
    console.log(`\n${title}: ${passed} passed, ${failed} failed (whole-bundle jsdom simulation; no live site, no live Studio)`);
    if (extra) console.log(extra);
    if (pageErrors && pageErrors.length) console.log("page errors:", pageErrors.slice(0, 5));
    setTimeout(() => process.exit(failed ? 1 : (process.exitCode || 0)), 50);
  }
  return { ok, waitFor, finish, results };
}

module.exports = { createPage, installDomShims, studioSim, sse, makeReporter, sleep, log, ROOT, manifest };
