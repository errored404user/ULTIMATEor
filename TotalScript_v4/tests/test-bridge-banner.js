// 2.2.1 — the "Bridge went down" banner must not pop on every flap.
// Root causes fixed: (1) background answered a status poll with connected=false
// while a wake-up reconnect was still in flight; (2) the page alerted on the FIRST
// false after a true (a 0.5 s socket blip = a red banner); (3) unanswered polls
// (no `connected` field) counted as a drop; (4) Close did not stop the next flap
// from re-showing it; (5) a deliberate mcp.disconnect looked like an outage.
// Static pins + a jsdom walk of the real codecraft.html bundle with a scripted
// background. Run from the TotalScript root:  node tests/test-bridge-banner.js
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra ? "  — " + String(extra).slice(0, 500) : "")); } };
const done = () => console.log(`test-bridge-banner: ${pass} passed, ${fail} failed`);

// ── A. background ───────────────────────────────────────────────────────────
const bg = read("background.js");
ok("A1 statusObj reports lifecycle / reconnecting / manual next to connected", /lifecycle: mcpLifecycle, reconnecting, manual: manualStudioDisconnect/.test(bg) && /const reconnecting = !connected && !manualStudioDisconnect && \(\(ws && ws\.readyState === WebSocket\.CONNECTING\) \|\| !!reconnectTimer\)/.test(bg));
ok("A2 a status poll waits STATUS_SETTLE_MS for an in-flight reconnect instead of answering 'down' at once", /const STATUS_SETTLE_MS = 1500;/.test(bg) && /case "status":[^]*?if \(!connected && !manualStudioDisconnect\) \{ connect\(\); await waitForConnection\(STATUS_SETTLE_MS\); \}\s*sendResponse\(statusObj\(\)\);/.test(bg));
ok("A3 connect() clears the fired reconnect timer id (else 'reconnecting' stayed true forever)", /clearTimeout\(reconnectTimer\); reconnectTimer = null;/.test(bg));
ok("A4 the slow retry after the fast attempts is still there (never stop trying)", /reconnectTimer = setTimeout\(connect, RECONNECT_SLOW_MS\);/.test(bg));

// ── B. content script ───────────────────────────────────────────────────────
const main = read("src/core/main.js");
ok("B1 grace + re-arm constants and the debounce state exist", /const BRIDGE_DROP_GRACE_MS = 8000, BRIDGE_REARM_MS = 60000;/.test(main) && /let bridgeDropTimer = null, bridgeDismissedAt = 0, bridgeUpSince = 0, bridgeReconnecting = false;/.test(main));
ok("B2 the old 'first false after true → banner' line is gone", !main.includes("if (wasConnected && !s.connected) bridgeAlert(true);"));
ok("B3 lifecycle ERROR alerts at once, anything else waits for the grace timer and re-checks A.bridge", /if \(s\.lifecycle === "ERROR"\) \{/.test(main) && /bridgeDropTimer = setTimeout\(\(\) => \{\s*bridgeDropTimer = null;\s*const cur = A\.bridge;\s*if \(cur && cur\.connected === false && cur\.manual !== true\) \{ bridgeAlert\(true\);/.test(main));
ok("B4 a manual disconnect clears the banner and never arms it", /\} else if \(s\.manual === true\) \{[^]*?bridgeAlert\(false\);/.test(main));
ok("B5 Close mutes the banner (bridgeDismissedAt) and it re-arms only after BRIDGE_REARM_MS of stable connection", /if \(bridgeDismissedAt\) return;/.test(main) && /bridgeDismissedAt = Date\.now\(\);/.test(main) && /if \(bridgeDismissedAt && Date\.now\(\) - bridgeUpSince >= BRIDGE_REARM_MS\) bridgeDismissedAt = 0;/.test(main));
ok("B6 onStatus skips replies without a boolean `connected` and reports an outage only after 3 misses", /if \(typeof s\.connected !== "boolean"\) \{\s*statusMisses\+\+;/.test(main) && /if \(statusMisses < 3\) return;/.test(main) && /s = \{ connected: false, lifecycle: "ERROR", unanswered: true/.test(main));
ok("B7 the rs-status push forwards lifecycle / reconnecting / manual", /lifecycle: msg\.lifecycle, reconnecting: msg\.reconnecting, manual: msg\.manual \}\);/.test(main));
ok("B8 dot gets a 'reconnecting' class + plain title while redialling; banner copy says the page reconnects by itself", /\(bridgeReconnecting \? " reconnecting" : ""\)/.test(main) && main.includes('txt = "Bridge connection dropped - reconnecting…";') && main.includes("this page reconnects by itself, nothing to reload"));
const css = read("overlay.css");
ok("B9 overlay.css pulses #rs-dot.reconnecting (reduced-motion safe)", /#rs-dot\.reconnecting \{[^}]*animation: rs-dot-pulse/.test(css) && /@keyframes rs-dot-pulse/.test(css) && /prefers-reduced-motion: reduce\) \{ #rs-dot\.reconnecting \{ animation: none; \}/.test(css));
const popup = read("popup.js");
ok("B10a bar pill has a reconnecting state", /pill\.classList\.add\("rs-status-offline", "rs-status-reconnecting"\);/.test(main) && /#rs-status-pill\.rs-status-reconnecting \.rs-status-dot \{ animation: rs-dot-pulse/.test(css) && /warn = !bridgeReconnecting;/.test(main));
ok("B10 popup distinguishes reconnecting / paused from offline", popup.includes('s.reconnecting === true && s.lifecycle !== "ERROR" ? "Bridge connection dropped — reconnecting…"') && popup.includes("s.manual === true ?"));

// ── C. jsdom walk ───────────────────────────────────────────────────────────
(async () => {
  let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { console.log("skip C (jsdom not installed)"); return done(); }
  const manifest = JSON.parse(read("manifest.json"));
  const pageHtml = read("codecraft.html");
  const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
  const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true }); Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
  Object.defineProperty(d, "hidden", { value: false, configurable: true }); Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
  w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} }; };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return 860; }, configurable: true }); Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; }, configurable: true }); Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return this.parentElement; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  w.HTMLElement.prototype.scrollIntoView = function () {}; w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
  w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16); w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; w.elementFromPoint = d.elementFromPoint = () => null; d.execCommand = () => false;
  w.HTMLCanvasElement.prototype.getContext = () => null; if (!w.crypto) w.crypto = require("crypto").webcrypto;
  w.Audio = class { play() { return Promise.resolve(); } pause() {} }; w.AudioContext = undefined;
  w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" }; w.URL.createObjectURL = () => "blob:h"; w.URL.revokeObjectURL = () => {};
  w.open = () => null; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
  const storage = {};
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  // Scripted bridge status: the walk mutates STATUS and pushes rs-status messages.
  let STATUS = { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true, lifecycle: "CONNECTED", reconnecting: false, manual: false, engine: "roblox", tools: 1, servers: [] };
  let statusReply = () => ({ ...STATUS });
  const listeners = [];
  const background = (msg) => { switch (msg && msg.type) { case "status": return statusReply(); case "studio_status": return { ok: true, studio: true }; case "tools": case "list_tools": return { ok: true, tools: TOOLS, studio: true, roblox_connected: true }; case "call_tool": return { ok: true, text: "ok" }; case "blender_status": case "blender_connect": return { ok: false, blender: false }; default: return { ok: true, tools: TOOLS }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 5); return Promise.resolve(r); }, onMessage: { addListener(fn) { listeners.push(fn); }, removeListener() {} }, lastError: null, getManifest: () => manifest }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {}, removeListener() {} } }, tabs: { create() {} } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const errs = []; w.onerror = (m) => { errs.push(String(m)); };
  const vc = w.console; w.console = { ...vc, error: (...a) => { errs.push("console.error: " + a.map(String).join(" ").slice(0, 200)); }, warn: () => {}, log: () => {} };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = Date.now() + 10000; while (Date.now() < until && !d.getElementById("rs-bar")) await sleep(50);
  await sleep(800);
  const push = (patch) => { STATUS = { ...STATUS, ...patch }; for (const fn of listeners) { try { fn({ ...STATUS }); } catch {} } };
  const banner = () => d.querySelector(".rs-banner.rs-bridge-down");
  const dot = () => d.getElementById("rs-dot");
  ok("C1 page boots connected: green dot, no bridge banner", !!d.getElementById("rs-bar") && dot() && dot().classList.contains("on") && !banner());

  // a blip: socket closed, worker redialling, back 1.2 s later
  push({ connected: false, lifecycle: "RECONNECTING", reconnecting: true, roblox_connected: false, studio: false });
  await sleep(150);
  ok("C2 a drop that is being redialled shows NO banner - the dot pulses amber with a plain title", !banner() && dot().classList.contains("reconnecting") && /reconnecting/.test(dot().title), dot().className + " | " + dot().title);
  const pill = d.getElementById("rs-status-pill");
  ok("C2b the inline status pill says Reconnecting… (not 'Offline - run total-core') and pulses", pill && !pill.hidden ? (pill.classList.contains("rs-status-reconnecting") && /Reconnecting/.test(pill.textContent)) : true, pill && pill.textContent);
  await sleep(1200);
  push({ connected: true, lifecycle: "CONNECTED", reconnecting: false, roblox_connected: true, studio: true });
  await sleep(150);
  ok("C3 back within the grace window: still no banner, dot green again", !banner() && dot().classList.contains("on") && !dot().classList.contains("reconnecting"));

  // flap three times quickly - the old code popped three banners
  for (let i = 0; i < 3; i++) { push({ connected: false, lifecycle: "RECONNECTING", reconnecting: true }); await sleep(120); push({ connected: true, lifecycle: "CONNECTED", reconnecting: false }); await sleep(120); }
  ok("C4 three quick flaps: zero banners", !banner() && d.querySelectorAll(".rs-banner.rs-bridge-down").length === 0);

  // a sustained drop without ERROR: the grace timer (8 s) decides, re-checking the latest status
  push({ connected: false, lifecycle: "RECONNECTING", reconnecting: true });
  await sleep(4000);
  ok("C5 4 s into a sustained drop: still no banner (grace running)", !banner());
  await sleep(5000);
  ok("C6 after the 8 s grace with the bridge still down: the banner shows once, with the self-reconnect copy", banner() && /Bridge went down/.test(banner().textContent) && /reconnects by itself/.test(banner().textContent) && d.querySelectorAll(".rs-banner.rs-bridge-down").length === 1);
  push({ connected: true, lifecycle: "CONNECTED", reconnecting: false });
  await sleep(150);
  ok("C7 reconnect clears it", !banner());

  // a deliberate mcp.disconnect is not an outage
  push({ connected: false, lifecycle: "CLOSED", reconnecting: false, manual: true });
  await sleep(150);
  ok("C8 manual disconnect: no banner (even instantly with lifecycle CLOSED), title explains mcp.connect", !banner() && /mcp\.connect/.test(dot().title), dot().title);
  push({ connected: true, lifecycle: "CONNECTED", manual: false });
  await sleep(150);

  // the worker gave up its fast reconnects: a real outage shows immediately
  push({ connected: false, lifecycle: "ERROR", reconnecting: true });
  await sleep(150);
  ok("C9 lifecycle ERROR: banner at once (no 8 s wait)", !!banner());
  banner().querySelector(".rs-banner-x").click();
  await sleep(100);
  push({ connected: false, lifecycle: "ERROR", reconnecting: true });
  await sleep(150);
  ok("C10 Close keeps it closed for this outage: a repeated ERROR status does not re-pop it", !banner());
  push({ connected: true, lifecycle: "CONNECTED", reconnecting: false });
  await sleep(150);
  push({ connected: false, lifecycle: "ERROR", reconnecting: true });
  await sleep(150);
  ok("C11 ...and a drop right after a short reconnect is still muted (needs 60 s of stable connection to re-arm)", !banner());
  push({ connected: true, lifecycle: "CONNECTED", reconnecting: false });
  await sleep(150);

  // the worker does not answer the poll at all (asleep / busy): not a drop
  statusReply = () => ({ ok: false, kind: "timeout", errorCode: "BACKGROUND_TIMEOUT", error: "background did not answer" });
  await sleep(5600); // one poll tick
  ok("C12 an unanswered status poll leaves the dot as it was (no banner, no 'offline')", !banner() && dot().classList.contains("on") && !/offline/i.test(dot().title), dot().title);
  statusReply = () => ({ ...STATUS });
  ok("C13 no page errors during the walk", errs.length === 0, errs.join(" | "));
  done();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
})();
