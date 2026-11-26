// 2.2.1 — notification stack polish: banners and toasts share one top-right column
// (#rs-notify), duplicate toasts collapse into a ×N counter, at most 4 toasts stay
// up, hover pauses auto-hide, a repeated banner nudges instead of stacking, and the
// stack steps aside while the getting-started card is up.
// Static pins + a jsdom walk of the real codecraft.html bundle (uses the Featured
// shelf's Install toasts as a deterministic toast source).
// Run from the TotalScript root:  node tests/test-notify-stack.js
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra ? "  — " + String(extra).slice(0, 500) : "")); } };
const done = () => console.log(`test-notify-stack: ${pass} passed, ${fail} failed`);

const main = read("src/core/main.js");
const css = read("overlay.css");
ok("A1 notifyHost() lazily creates #rs-notify as a polite live region inside #rs-root", /function notifyHost\(\) \{[^]*?h\.id = "rs-notify";[^]*?aria-live", "polite"\)[^]*?root\.appendChild\(h\);/.test(main));
ok("A2 toast(): same text while showing → ×N counter + timer restart, no second element", /x\.dataset\.msg === msg && !x\.dataset\.leaving/.test(main) && /c\.textContent = "×" \+ n;/.test(main) && /same\.__restart\(\)/.test(main));
ok("A3 toast(): TOAST_MAX = 4, oldest dismissed first; hover pauses, click dismisses", /const TOAST_MAX = 4;/.test(main) && /if \(live\.length >= TOAST_MAX && typeof live\[0\]\.__dismiss === "function"\) live\[0\]\.__dismiss\(\);/.test(main) && /addEventListener\("mouseenter", \(\) => \{ hovering = true; clearTimeout\(timer\); \}\)/.test(main) && /addEventListener\("click", \(\) => t\.__dismiss\(\)\)/.test(main));
ok("A4 every banner path appends to the stack, none to root directly", !/root\.appendChild\(b\);/.test(main) && (main.match(/notifyHost\(\)\.appendChild\(b\);/g) || []).length === 3);
ok("A5 banner(): identical title+text nudges the live banner instead of stacking a copy", /x\.dataset\.title === String\(title\) && x\.dataset\.msg === String\(msg\)/.test(main) && /dup\.classList\.add\("rs-banner-again"\); return;/.test(main));
ok("A6 the setup card toggles rs-setup-visible on #rs-root", /root\.classList\.add\("rs-setup-visible"\)/.test(main) && /root\.classList\.remove\("rs-setup-visible"\)/.test(main));
ok("B1 overlay.css: #rs-notify is a fixed top-right flex column; children lose their own fixed placement", /#rs-notify \{ position: fixed; top: 18px; right: 18px; width: 320px;[^}]*flex-direction: column;[^}]*pointer-events: none; \}/.test(css) && /#rs-notify > \.rs-banner, #rs-notify > \.rs-toast \{ position: static !important;[^}]*pointer-events: auto; \}/.test(css));
ok("B2 overlay.css: toasts hug the right edge, counter pill styled (dark + light), empty stack hidden", /#rs-notify > \.rs-toast \{ align-self: flex-end;/.test(css) && /\.rs-toast-n \{/.test(css) && /html\.rs-light \.rs-toast-n \{/.test(css) && /#rs-notify:empty \{ display: none; \}/.test(css));
ok("B3 overlay.css: banner nudge keyframes + reduced-motion opt-out; stack moves left of the setup card", /@keyframes rs-banner-nudge/.test(css) && /prefers-reduced-motion: reduce\) \{ \.rs-banner-again \{ animation: none !important; \}/.test(css) && /#rs-root\.rs-setup-visible #rs-notify \{ right: calc\(18px \+ 288px \+ 12px\); \}/.test(css));
ok("B4 the old per-toast fixed placement is still defined for anything outside the stack (back-compat)", /\.rs-toast \{\s*position: fixed; right: 18px; top: 80px;/.test(css));

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
  let STATUS = { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true, lifecycle: "CONNECTED", reconnecting: false, manual: false, engine: "roblox", tools: 1, servers: [] };
  const listeners = [];
  const background = (msg) => { switch (msg && msg.type) { case "status": return { ...STATUS }; case "studio_status": return { ok: true, studio: true }; case "tools": case "list_tools": return { ok: true, tools: TOOLS, studio: true, roblox_connected: true }; case "call_tool": return { ok: true, text: "ok" }; case "blender_status": case "blender_connect": return { ok: false, blender: false }; default: return { ok: true, tools: TOOLS }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 5); return Promise.resolve(r); }, onMessage: { addListener(fn) { listeners.push(fn); }, removeListener() {} }, lastError: null, getManifest: () => manifest }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {}, removeListener() {} } }, tabs: { create() {} } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  storage.rsSetupSeen = true;
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const errs = []; w.onerror = (m) => { errs.push(String(m)); };
  const vc = w.console; w.console = { ...vc, error: (...a) => { errs.push("console.error: " + a.map(String).join(" ").slice(0, 200)); }, warn: () => {}, log: () => {} };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = Date.now() + 10000; while (Date.now() < until && !d.getElementById("rs-bar")) await sleep(50);
  await sleep(800);
  const push = (patch) => { STATUS = { ...STATUS, ...patch }; for (const fn of listeners) { try { fn({ ...STATUS }); } catch {} } };
  const host = () => d.getElementById("rs-notify");
  const toasts = () => host() ? [...host().querySelectorAll(".rs-toast")].filter((t) => !t.dataset.leaving) : [];
  ok("C1 page boots; no stray toasts/banners outside the stack", !!d.getElementById("rs-bar") && [...d.querySelectorAll(".rs-toast, .rs-banner")].every((x) => x.closest("#rs-notify")));
  d.getElementById("rs-cards-btn").click(); await sleep(200);
  const panel = d.getElementById("rs-cards-panel");
  panel.querySelector('[data-tab="public"]').click(); await sleep(250);
  const shelf = () => panel.querySelector("[data-public-featured]");
  shelf().querySelector('[data-public-feat-install="zone_system"]').click(); await sleep(250);
  ok("C2 a toast lands inside #rs-notify (polite live region in #rs-root) with its text in .rs-toast-m", host() && host().closest("#rs-root") && host().getAttribute("aria-live") === "polite" && toasts().length === 1 && /Installed 1 item: zone_system/.test(toasts()[0].querySelector(".rs-toast-m").textContent) && toasts()[0].querySelector(".rs-toast-n").hidden, host() && host().innerHTML.slice(0, 200));
  shelf().querySelector('[data-public-feat-install="zone_system"]').click(); await sleep(250); // Reinstall (confirm → true) → identical toast text
  ok("C3 the identical toast collapses into the live one with a ×2 counter", toasts().length === 1 && toasts()[0].querySelector(".rs-toast-n").textContent === "×2" && !toasts()[0].querySelector(".rs-toast-n").hidden, toasts().map((t) => t.textContent).join(" | "));
  for (const name of ["boss_health_bar", "damage_numbers_pro", "collectible_spawner", "keycard_door_system", "dialogue_tree_system"]) { shelf().querySelector(`[data-public-feat-install="${name}"]`).click(); await sleep(120); }
  ok("C4 six distinct toasts → at most 4 stay up (oldest left first, newest at the bottom)", toasts().length === 4 && /dialogue_tree_system/.test(toasts()[3].textContent) && !toasts().some((t) => /zone_system/.test(t.textContent)), toasts().map((t) => t.textContent.slice(0, 40)).join(" | "));
  const hovered = toasts()[0]; const hoveredText = hovered.textContent;
  hovered.dispatchEvent(new w.MouseEvent("mouseenter", { bubbles: true }));
  await sleep(4200); // past the 3.5 s base lifetime
  ok("C5 hovering a toast pauses its auto-hide; the others have left on schedule", toasts().includes(hovered) && toasts().length <= 2, toasts().map((t) => t.textContent.slice(0, 40)).join(" | "));
  hovered.click(); await sleep(350);
  ok("C6 click dismisses it", !toasts().some((t) => t.textContent === hoveredText));
  // banners join the same column and never stack duplicates
  push({ connected: false, lifecycle: "ERROR", reconnecting: true, roblox_connected: false, studio: false });
  await sleep(200);
  const bridge = host().querySelector(".rs-banner.rs-bridge-down");
  ok("C7 the bridge banner renders inside the same stack", !!bridge && bridge.parentElement === host());
  push({ connected: false, lifecycle: "ERROR", reconnecting: true });
  await sleep(200);
  ok("C8 ...and a repeated ERROR status does not add a second banner", host().querySelectorAll(".rs-banner").length === 1);
  push({ connected: true, lifecycle: "CONNECTED", reconnecting: false, roblox_connected: true, studio: true });
  await sleep(200);
  ok("C9 reconnect removes it; stack is empty again (display:none via :empty once the last toast leaves)", host().querySelectorAll(".rs-banner").length === 0);
  ok("C10 no page errors during the walk", errs.length === 0, errs.join(" | "));
  done();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
})();
