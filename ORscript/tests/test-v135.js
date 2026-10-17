// 1.35.0 — Reliability, stability, performance pass.
//  • placeBar: adaptive cadence (per-frame only while "hot", else 100 ms busy /
//    200 ms idle) instead of a full layout pass on every animation frame.
//  • cards panel: coalesced re-renders (one rebuild per frame per burst), never
//    while an editor inside the panel has focus, per-tab error boundary.
//  • bg(): every background call has a finite ceiling (no more hung loop).
//  • Studio plugin: offline backoff, poll-failure backoff, result POST retry,
//    pcall-guarded poll loop.
// String checks always run; the jsdom part measures the idle DOM-read rate and
// the focus guard when jsdom is installed (cd ORscript && npm i --no-save jsdom).
const fs = require("fs");
const path = require("path");
const ROOT = process.env.ORSCRIPT_ROOT || path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const main = read("src/core/main.js");
const lua = read("plugin/ORscript.lua");
const results = []; const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };

// ── placeBar cadence ──
ok("placeBar keeps the rAF heartbeat + self-heal but gates the body on an adaptive cadence", /function placeBar\(\) \{\s*barRaf = requestAnimationFrame\(placeBar\);[\s\S]{0,900}if \(now >= placeHotUntil\) \{[\s\S]{0,700}placeBarBody\(\);\s*\}\s*var placeBodyRuns = 0;/.test(main) && /function placeBarBody\(\) \{/.test(main));
ok("cadence constants: hot 700 ms per-frame, busy 100 ms, idle 200 ms", /var PLACE_HOT_MS = 700, PLACE_BUSY_MS = 100, PLACE_IDLE_MS = 200;/.test(main));
ok("busy = session live / tool running / tray open; else idle", /const period = \(A\.running \|\| A\.starting \|\| A\.injecting \|\| A\.toolRunning \|\| trayOpen\) \? PLACE_BUSY_MS : PLACE_IDLE_MS;/.test(main));
ok("kickPlaceBar is NaN-safe and exposed; triggers cover resize/scroll/wheel/pointer/key/focus/input/transitions/visibility/visualViewport", /function kickPlaceBar\(ms\) \{ placeHotUntil = Math\.max\(placeHotUntil \|\| 0,/.test(main) && /window\.__rsKickPlaceBar = kickPlaceBar/.test(main) && /\["resize", "scroll", "wheel", "pointerdown", "pointerup", "keydown", "focusin", "input", "transitionend", "animationend", "orientationchange"\]/.test(main) && /document\.addEventListener\("visibilitychange", \(\) => kickPlaceBar\(1500\)/.test(main) && /window\.visualViewport\.addEventListener\("resize"/.test(main));
ok("a detached #rs-root re-attach kicks a hot window", /document\.documentElement\.appendChild\(root\); \} catch \{\}\s*kickPlaceBar\(\);/.test(main));
ok("renderBar kicks placement only when the bar content actually changed (after the signature guard)", /if \(sig === lastBarSig\) return;\s*lastBarSig = sig;\s*try \{ kickPlaceBar\(\); \} catch \{\}/.test(main) && !/if \(!bar\) return;\s*try \{ kickPlaceBar\(\); \} catch \{\}\s*\/\/ Recover from any stale composer mask/.test(main));
ok("scheduleSweep does NOT kick (streaming mutations must not pin the loop hot)", !/function scheduleSweep\(\) \{\s*try \{ if \(typeof window\.__rsKickPlaceBar/.test(main));
ok("Activity 'ago' refresh is time-based (5 s) and coalesced, not a frame counter", /if \(t - fabActivityLastAt >= 5000\) \{ fabActivityLastAt = t; scheduleRenderCards\(\); \}/.test(main) && !/fabActivityTick % 300/.test(main));
ok("window.__rsPerf exposes placement passes + cards renders for measurement", /window\.__rsPerf = \(\) => \(\{ placeBodyRuns, placeHot: performance\.now\(\) < placeHotUntil, cardsRenders \}\)/.test(main));

// ── in-flow mount: no per-frame re-insert ──
const codecraft = read("src/providers/codecraft.js");
ok("placeBar re-inserts the bar only when genuinely out of place (before===bar and before:undefined no longer churn)", /const ref = \(mount\.before && mount\.before !== bar\) \? mount\.before : null;\s*const inPlace = bar\.parentElement === mount\.parent && \(mount\.before === bar \|\| bar\.nextElementSibling === ref\);\s*if \(!inPlace\) \{/.test(main));
ok("CodeCraft barMount skips the bar itself when computing `before`", /while \(first && first\.id === "rs-bar"\) first = first\.nextElementSibling;/.test(codecraft));

// ── cards panel: coalescing, focus guard, error boundary ──
ok("scheduleRenderCards coalesces to one rebuild per frame and defers while an editor in the panel has focus", /function scheduleRenderCards\(\) \{\s*if \(renderCardsQueued\) return;/.test(main) && /if \(panelHasFocusedEditor\(cardsPanel\)\) \{ setTimeout\(run, 400\); return; \}/.test(main) && /a\.matches\("input, textarea, select, \[contenteditable=\\"true\\"\]"\)/.test(main));
ok("trackCard + tasklist / public-skills / templates-synced / roadmap events use the coalesced path", /scheduleRenderCards\(\);\s*\}\s*try \{ window\.__rsTrackCard = trackCard; \}/.test(main) && /\(cardsTab === "tasks" \|\| !taskListOn\(\)\)\) scheduleRenderCards\(\);/.test(main) && /cardsTab === "public"\) scheduleRenderCards\(\);/.test(main) && /or-templates-synced",\(\)=>\{try\{if\(cardsPanel&&!cardsPanel\.hidden\)scheduleRenderCards\(\);\}/.test(main) && /cardsTab === "roadmap"\) scheduleRenderCards\(\);/.test(main));
ok("per-tab error boundary: a throwing tab renders a fallback with Try again and logs cards.tabFailed", /function renderCardsBody\(local\) \{[\s\S]{0,700}diag\("cards\.tabFailed", \{ tab: cardsTab, error: msg \}\);[\s\S]{0,400}data-cards-retry/.test(main) && /const body = renderCardsBody\(local\);/.test(main) && /const retryBtn = panel\.querySelector\("\[data-cards-retry\]"\)/.test(main));

// ── bg() hang guard ──
ok("bg() settles once, with a finite ceiling: msg.timeout + 20 s (floor 15 s) or 150 s", /const BG_TIMEOUT_DEFAULT_MS = 150000, BG_TIMEOUT_FLOOR_MS = 15000;/.test(main) && /return Math\.max\(BG_TIMEOUT_FLOOR_MS, t \+ 20000\);/.test(main) && /const done = \(v\) => \{ if \(settled\) return; settled = true; clearTimeout\(timer\); resolve\(v\); \};/.test(main) && /errorCode: "BACKGROUND_TIMEOUT"/.test(main) && /diag\("bg\.hung"/.test(main));
ok("bg() still maps lastError to stale-extension / disconnected", /kind: isContextInvalidated\(m\) \? "stale-extension" : "disconnected",/.test(main) && /if \(chrome\.runtime\.lastError\) fail\(chrome\.runtime\.lastError\.message\);/.test(main));

// ── Studio plugin ──
ok("plugin: offline hello backoff 3 → 15 s, reset on success", /local offlineWait, pollFailures = 3, 0/.test(lua) && /offlineWait = math\.min\(15, offlineWait \+ 3\)/.test(lua) && /offlineWait = 3\n/.test(lua));
ok("plugin: poll-failure backoff (2 s × failures, max 10 s) and pcall-guarded loop body", /pollFailures = pollFailures \+ 1/.test(lua) && /task\.wait\(math\.min\(10, 2 \* pollFailures\)\)/.test(lua) && /local okLoop, errLoop = pcall\(function\(\)/.test(lua) && /log\("poll loop error: " \.\. tostring\(errLoop\)\)/.test(lua));
ok("plugin: result POST retried up to 4× with backoff; the job itself is not redone", /for attempt = 1, 4 do\s*local okP, errP = request\("POST", "\/api\/plugin\/result", result\)\s*if okP then delivered = true break end/.test(lua) && /task\.wait\(attempt \* 0\.75\)/.test(lua) && /return delivered/.test(lua));
ok("plugin: no Luau 'continue' left in the poll loop (replaced by early returns inside the pcall)", !/if not connected then task\.wait\(3\) continue end/.test(lua));

// ── jsdom: measure + focus guard ──
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { JSDOM = null; }
if (!JSDOM) { console.log("SKIP  jsdom measurements (jsdom not installed)"); finish(); } else { render().catch((e) => { ok("jsdom part completed", false, String(e && e.stack || e)); finish(); }); }
function finish() { const failed = results.filter((r) => !r[1]); console.log(`\n${results.length - failed.length}/${results.length} checks passed`); if (failed.length) { console.log("FAILURES:"); failed.forEach((r) => console.log("  - " + r[0])); } }

async function render() {
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
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true }; case "studio_status": return { ok: true, studio: true }; case "tools": case "list_tools": return { ok: true, tools: TOOLS }; default: return { ok: true, tools: TOOLS }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {} }, lastError: null, getManifest: () => JSON.parse(read("manifest.json")) }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {} } }, tabs: { create() {} } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const pageErrors = [];
  w.onerror = (m) => { pageErrors.push(String(m)); };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }

  await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
  await sleep(1500);
  // idle: full placement passes + layout reads over 3 s (was ~185 passes / ~370 rect reads per 3 s)
  let gbcr = 0; const g0 = w.Element.prototype.getBoundingClientRect; w.Element.prototype.getBoundingClientRect = function () { gbcr++; return g0.call(this); };
  const p0 = w.__rsPerf().placeBodyRuns; await sleep(3000); const passes = w.__rsPerf().placeBodyRuns - p0;
  ok("idle: ≤ 25 placement passes and ≤ 80 getBoundingClientRect reads in 3 s (per-frame loop would do ~185 / ~370)", passes <= 25 && gbcr <= 80, `passes=${passes} rects=${gbcr}`);
  // the bar must not be detached/re-attached while hot (CodeCraft used to re-insert it every frame)
  { const ib = w.Node.prototype.insertBefore; let nIns = 0; w.Node.prototype.insertBefore = function (n, ref) { if (n && n.id === "rs-bar") nIns++; return ib.call(this, n, ref); };
    w.dispatchEvent(new w.Event("resize")); await sleep(400); w.Node.prototype.insertBefore = ib;
    ok("no bar re-insertion during 400 ms of hot placement passes", nIns === 0, `reinserts=${nIns}`); }
  // a user gesture makes it hot again immediately
  w.dispatchEvent(new w.Event("scroll")); await sleep(120);
  ok("a scroll kicks the loop hot (several passes within 120 ms)", w.__rsPerf().placeBodyRuns - p0 - passes >= 3, String(w.__rsPerf().placeBodyRuns - p0 - passes));
  // cards: a burst of 12 trackCard calls → one rebuild
  d.getElementById("rs-cards-btn").click(); await sleep(150);
  const panel = d.getElementById("rs-cards-panel");
  panel.querySelector('[data-tab="activity"]').click(); await sleep(80);
  const r0 = w.__rsPerf().cardsRenders;
  for (let i = 0; i < 6; i++) { w.__rsTrackCard("tool_" + i, "run", "executing", "tool"); w.__rsTrackCard("tool_" + i, "ok", "done " + i, "tool"); }
  await sleep(200);
  ok("12 trackCard calls in one burst → exactly 1 panel rebuild with 6 rows", w.__rsPerf().cardsRenders - r0 === 1 && panel.querySelectorAll(".rs-activity-row").length === 6, `renders=${w.__rsPerf().cardsRenders - r0}`);
  // focus guard: typing in the Tasks input must survive a tasklist-change event
  try { w.ORTaskList.setEnabled(true); } catch {}
  await sleep(120); panel.querySelector('[data-tab="library"]').click(); await sleep(80);
  const tasksTab = panel.querySelector('[data-tab="tasks"]');
  if (tasksTab) {
    tasksTab.click(); await sleep(80);
    const input = panel.querySelector("#rs-task-input"); input.focus(); input.value = "half-typed task";
    const r1 = w.__rsPerf().cardsRenders;
    w.dispatchEvent(new w.CustomEvent("or-tasklist-change")); await sleep(250);
    ok("focus guard: no rebuild while the task input is focused (draft + caret survive)", w.__rsPerf().cardsRenders === r1 && d.activeElement === input && input.value === "half-typed task" && input.isConnected, `renders=${w.__rsPerf().cardsRenders - r1} active=${d.activeElement && d.activeElement.id} connected=${input.isConnected}`);
    input.blur(); await sleep(700);
    ok("…and the deferred rebuild lands once the input blurs", w.__rsPerf().cardsRenders === r1 + 1);
  } else { console.log("SKIP  focus guard (task list tab disabled in this profile)"); }
  // error boundary: make one tab throw → fallback block, other tabs still work
  const origPS = w.PublicSkills && w.PublicSkills.list;
  if (origPS) {
    w.PublicSkills.list = () => { throw new Error("boom from a broken skill store"); };
    panel.querySelector('[data-tab="public"]').click(); await sleep(80);
    ok("error boundary: a throwing tab shows the fallback with Try again instead of a blank panel", !!panel.querySelector(".rs-cards-broken [data-cards-retry]") && /boom from a broken skill store/.test(panel.textContent) && panel.querySelectorAll(".rs-cards-tab").length >= 3);
    w.PublicSkills.list = origPS;
    panel.querySelector("[data-cards-retry]").click(); await sleep(80);
    ok("Try again re-renders the tab normally", !panel.querySelector(".rs-cards-broken") && !!panel.querySelector(".rs-public"));
  }
  finish();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
}
