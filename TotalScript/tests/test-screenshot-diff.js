// 2.3.0 — screenshot_compare / total_screenshot {compare:true}.
// A: pure pixel maths of src/core/screenshot_diff.js on synthetic images
//    (no browser, no decoder). B: capture memory + compare() with an injected
//    decoder. C: wiring (manifest x12, codecraft.html, virtual tool, gate
//    proof, handler). D: jsdom boot of the real page - total_screenshot
//    {target:"tab"} twice with a mocked tab capture, second call compare:true
//    reports NO VISIBLE CHANGE / CHANGE through the real dispatcher.
// Mocked throughout - no Studio, no AI site. Run: node tests/test-screenshot-diff.js
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."); process.chdir(ROOT);
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (d !== undefined ? "  — " + (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 500) : "")); } };
const done = () => { console.log(`\n${fail === 0 ? "OK   " : "FAIL "} test-screenshot-diff: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };

const D = require("../src/core/screenshot_diff.js");
const img = (w, h, fill) => { const data = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fill(x, y); const i = (y * w + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; } return { width: w, height: h, data }; };
const grey = (w, h, v) => img(w, h, () => [v, v, v]);

// ── A. pure diff ─────────────────────────────────────────────────────────────
const base = img(200, 120, (x, y) => [x % 256, y % 256, 90]);
const same = D.diff(base, img(200, 120, (x, y) => [x % 256, y % 256, 90]));
ok("A1 identical images: 0% changed, same:true, no bbox, no hot regions", same.changed_pct === 0 && same.same === true && same.bbox === null && same.hot_regions.length === 0 && same.mean_delta === 0);
const noisy = D.diff(base, img(200, 120, (x, y) => [x % 256, y % 256, 90 + ((x + y) % 7)]));
ok("A2 sub-threshold noise (<= 6/255) counts as no change", noisy.changed_pct === 0 && noisy.same === true && noisy.mean_delta > 0);
const patch = D.diff(base, img(200, 120, (x, y) => (x >= 150 && y >= 90) ? [255, 0, 0] : [x % 256, y % 256, 90]));
ok("A3 a red patch in the bottom-right 25% x 25% corner: ~6% changed, bbox at x75/y75 w25/h25, hot region bottom-right, same:false", Math.abs(patch.changed_pct - 6.3) < 0.3 && patch.same === false && patch.bbox.x === 75 && patch.bbox.y === 75 && patch.bbox.w === 25 && patch.bbox.h === 25 && patch.hot_regions[0] === "bottom-right", patch);
const centre = D.diff(base, img(200, 120, (x, y) => (x >= 80 && x < 120 && y >= 40 && y < 80) ? [0, 0, 0] : [x % 256, y % 256, 90]));
ok("A4 a central block is named 'center' and the 6x6 grid lights only the middle cells", centre.hot_regions.includes("center") && centre.grid[2][2] >= 50 && centre.grid[2][3] >= 50 && centre.grid[0][0] === 0 && centre.grid[2][0] === 0, { hot: centre.hot_regions, g: centre.grid[2] });
const all = D.diff(grey(64, 64, 20), grey(64, 64, 220));
ok("A5 everything changed: 100%, bbox is the full frame", all.changed_pct === 100 && all.bbox.w === 100 && all.bbox.h === 100 && all.same === false);
const mism = D.diff(grey(64, 64, 20), grey(128, 128, 20));
ok("A6 size mismatch is resampled (nearest) and flagged, identical content still reads as no change", mism.size_mismatch === true && mism.changed_pct === 0 && mism.same === true);
const thr = D.diff(grey(32, 32, 100), grey(32, 32, 130), { threshold: 40 });
ok("A7 threshold is honoured (delta 30 < 40 -> no change) and clamped to 1..255", thr.changed_pct === 0 && D.diff(grey(8, 8, 0), grey(8, 8, 2), { threshold: 0.5 }).changed_pct === 100);
const big = D.downsample(grey(1920, 1080, 7), D.MAX_WIDTH);
ok("A8 downsample keeps the aspect ratio at <= 256 px wide and leaves small images untouched", big.width === 256 && big.height === 144 && D.downsample(grey(100, 50, 1), 256).width === 100);
const t0 = Date.now(); for (let i = 0; i < 20; i++) D.diff(grey(256, 144, 10), grey(256, 144, 60)); const perDiff = (Date.now() - t0) / 20;
ok("A9 a 256x144 compare takes < 10 ms", perDiff < 10, perDiff + " ms");
let threw = false; try { D.diff(null, grey(2, 2, 0)); } catch { threw = true; }
ok("A10 diff throws on missing images instead of returning a fake result", threw);
ok("A11 describe(): NO VISIBLE CHANGE text tells the model to check path / Enabled / camera and NOT to claim a change", /NO VISIBLE CHANGE/.test(D.describe(same, { id: 1, label: "before" }, { id: 2, label: "" })) && /Do not claim the look changed/.test(D.describe(same, { id: 1 }, { id: 2 })) && /#1 "before" -> #2/.test(D.describe(same, { id: 1, label: "before" }, { id: 2, label: "" })));
ok("A12 describe(): CHANGE text carries %, scale words, bbox and regions; >= 60% warns the camera probably moved", /CHANGE vs previous capture/.test(D.describe(patch, { id: 1 }, { id: 2 })) && /moderate change/.test(D.describe(patch, { id: 1 }, { id: 2 })) && /small, local change/.test(D.describe(D.diff(base, img(200, 120, (x, y) => (x < 20 && y < 20) ? [255, 0, 0] : [x % 256, y % 256, 90])), { id: 1 }, { id: 2 })) && /bottom-right/.test(D.describe(patch, { id: 1 }, { id: 2 })) && /camera probably moved/.test(D.describe(all, { id: 1 }, { id: 2 })));

// ── B. memory + compare with an injected decoder ─────────────────────────────
(async () => {
  const frames = { f1: grey(64, 48, 40), f2: grey(64, 48, 40), f3: img(64, 48, (x, y) => (x < 16 && y < 12) ? [250, 250, 250] : [40, 40, 40]) };
  D.setDecoder(async (mime, b64) => { const f = frames[Buffer.from(b64, "base64").toString()]; if (!f) throw new Error("unknown frame"); return f; });
  D.clear();
  const b64 = (k) => Buffer.from(k).toString("base64");
  let r = await D.compare({});
  ok("B1 compare with no captures explains what to do (total_screenshot first)", r.ok === false && /no captures yet/.test(r.text));
  const e1 = D.remember({ mimeType: "image/png", data: b64("f1") }, "before");
  r = await D.compare({});
  ok("B2 one capture: asks for a second one, never fakes a delta", r.ok === false && /only one capture/.test(r.text) && e1.id === 1 && e1.label === "before");
  D.remember({ mimeType: "image/png", data: b64("f2") }, "");
  r = await D.compare({});
  ok("B3 two identical captures -> NO VISIBLE CHANGE (previous vs latest by default)", r.ok === true && r.diff.same === true && /NO VISIBLE CHANGE between captures #1 "before" -> #2/.test(r.text), r.text);
  D.remember({ mimeType: "image/png", data: b64("f3") }, "after lamp");
  r = await D.compare({ before: "before", after: "after lamp" });
  ok("B4 labels resolve (an exact label 'before' beats the keyword); a top-left patch reports ~6% changed, region top-left", r.ok === true && Math.abs(r.diff.changed_pct - 6.3) < 0.3 && r.diff.hot_regions[0] === "top-left" && r.before.id === 1 && r.after.id === 3, r.text);
  r = await D.compare({ before: "#2", after: "last" });
  ok("B5 #id and 'last' resolve", r.ok && r.before.id === 2 && r.after.id === 3);
  r = await D.compare({ before: "nope" });
  ok("B6 unknown reference -> explicit error listing the known captures", r.ok === false && /capture not found/.test(r.text) && /#1 before/.test(r.text));
  r = await D.compare({ before: "#3", after: "#3" });
  ok("B7 same capture twice is rejected", r.ok === false && /same capture/.test(r.text));
  for (let i = 0; i < 12; i++) D.remember({ mimeType: "image/png", data: b64("f1") }, "spam" + i);
  ok("B8 the ring keeps only the last 8 captures and list()/latest() expose metadata without the pixels", D.list().length === 8 && D.latest().label === "spam11" && D.latest(1).label === "spam10" && !("data" in D.latest()) && D.list()[0].bytes > 0);
  D.setDecoder(async () => { throw new Error("boom"); }); D.clear(); D.remember({ data: b64("f1") }); D.remember({ data: b64("f2") });
  r = await D.compare({});
  ok("B9 decoder failure is reported honestly (judge by eye), not as 'no change'", r.ok === false && /could not decode/.test(r.text) && /boom/.test(r.text));
  D.setDecoder(null);

  // ── C. wiring ─────────────────────────────────────────────────────────────
  const main = fs.readFileSync("src/core/main.js", "utf8"), manifest = fs.readFileSync("manifest.json", "utf8"), cc = fs.readFileSync("codecraft.html", "utf8");
  ok("C1 manifest lists screenshot_diff.js right after screenshot.js in all 12 bundles; codecraft.html loads it", (manifest.match(/"src\/core\/screenshot\.js",\n\s+"src\/core\/screenshot_diff\.js",/g) || []).length === 12 && /screenshot\.js"><\/script>\n\s*<script src="src\/core\/screenshot_diff\.js">/.test(cc));
  ok("C2 total_screenshot schema gained compare / label / threshold and a screenshot_compare virtual tool is injected", /compare: \{ type: "boolean", description: "2\.3\.0: also measure the pixel delta/.test(main) && /name: "screenshot_compare",/.test(main) && /op: \{ type: "string", enum: \["compare", "list"\]/.test(main));
  ok("C3 the handler remembers every capture and appends the compare note; screenshot_compare has its own handler", /TotalScreenshotDiff\.remember\(result\.images\[0\], args\.label \|\| ""\)/.test(main) && /return result\.text \+ compareNote;/.test(main) && /if \(name === "screenshot_compare"\) \{/.test(main));
  ok("C4 the LOOK gate accepts screenshot_compare as proof and the helper lists carry it next to total_screenshot", /proof: \/\^\(total_screenshot\|screenshot_compare\|gfx_capture/.test(main) && (main.match(/"total_screenshot", "screenshot_compare", "total_debug"/g) || []).length === 2);

  // ── D. jsdom boot: real dispatcher ────────────────────────────────────────
  let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { console.log("skip D (jsdom not installed)"); return done(); }
  const pageHtml = fs.readFileSync("codecraft.html", "utf8");
  const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
  const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true }); Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
  Object.defineProperty(d, "hidden", { value: false, configurable: true }); Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
  w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} }; };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return 860; }, configurable: true }); Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  w.HTMLElement.prototype.scrollIntoView = function () {}; w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
  w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16); w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; w.elementFromPoint = d.elementFromPoint = () => null; d.execCommand = () => false;
  w.HTMLCanvasElement.prototype.getContext = () => null; if (!w.crypto) w.crypto = require("crypto").webcrypto;
  w.Audio = class { play() { return Promise.resolve(); } pause() {} }; w.AudioContext = undefined;
  w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" }; w.URL.createObjectURL = () => "blob:h"; w.URL.revokeObjectURL = () => {};
  w.open = () => null; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null; w.focus = () => {};
  const storage = {};
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, JSON.parse(JSON.stringify(obj))); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  let frame = "f1";
  const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: false, roblox_connected: false }; case "studio_status": return { ok: true, studio: false }; case "tools": case "list_tools": return { ok: true, tools: TOOLS }; case "screenshot_capture": return { ok: true, images: [{ mimeType: "image/png", data: b64(frame) }] }; case "call_tool": return { ok: true, result: { content: [{ type: "text", text: "ok" }] } }; default: return { ok: true }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 5); return Promise.resolve(r); }, onMessage: { addListener() {}, removeListener() {} }, lastError: null, getManifest: () => JSON.parse(manifest) }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {}, removeListener() {} } } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const errs = []; w.onerror = (m) => { errs.push(String(m)); };
  const vc = w.console; w.console = { ...vc, error: (...a) => { errs.push("console.error: " + a.map(String).join(" ").slice(0, 200)); }, warn: () => {}, log: () => {} };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = fs.readFileSync(path.join(ROOT, s), "utf8") + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = Date.now() + 10000; while (Date.now() < until && !d.getElementById("rs-bar")) await sleep(50);
  await sleep(600);
  ok("D1 page boots with screenshot_diff.js loaded (window.TotalScreenshotDiff) and no script errors", !!d.getElementById("rs-bar") && w.TotalScreenshotDiff && w.TotalScreenshotDiff.VERSION === "2.4.0" && errs.length === 0, errs.slice(0, 3));
  w.TotalScreenshotDiff.setDecoder(async (mime, data) => frames[Buffer.from(data, "base64").toString()]);
  const run = (tool, args) => w.__rsRunTool({ tool, arguments: args || {} });
  let out = await run("screenshot_compare", {});
  ok("D2 screenshot_compare before any capture: honest 'no captures yet'", /no captures yet/.test(String(out)), out);
  out = await run("total_screenshot", { target: "tab", label: "before" });
  ok("D3 total_screenshot {target:tab, label:before} attaches the photo and says capture #1 \"before\" kept", /photo is attached/.test(String(out)) && /capture #1 "before" kept/.test(String(out)), out);
  out = await run("total_screenshot", { target: "tab", compare: true });
  ok("D4 second identical capture with compare:true -> NO VISIBLE CHANGE appended by the real handler", /NO VISIBLE CHANGE between captures #1 "before" -> #2/.test(String(out)) && /Do not claim the look changed/.test(String(out)), out);
  frame = "f3";
  out = await run("total_screenshot", { target: "tab", compare: true, label: "after" });
  ok("D5 a changed frame -> CHANGE vs previous capture with % and region", /CHANGE vs previous capture #2 -> #3 "after": 6\.\d% of pixels differ/.test(String(out)) && /top-left/.test(String(out)), out);
  out = await run("screenshot_compare", { before: "before", after: "after" });
  ok("D6 explicit screenshot_compare {before:\"before\", after:\"after\"} works through the dispatcher and appends the raw diff line", /CHANGE vs previous capture #1 "before" -> #3 "after"/.test(String(out)) && /\[diff: changed 6\.\d%, mean delta/.test(String(out)), out);
  out = await run("screenshot_compare", { op: "list" });
  ok("D7 {op:list} enumerates the kept captures", /#1 "before"/.test(String(out)) && /#3 "after"/.test(String(out)), out);
  const tools = (w.__rsToolList ? w.__rsToolList() : null);
  ok("D8 the gate regex accepts screenshot_compare as LOOK proof (source) - live gate run not simulated here", /screenshot_compare\|gfx_capture/.test(main));
  void tools;
  done();
})().catch((e) => { ok("unhandled", false, String(e && e.stack || e)); done(); });
