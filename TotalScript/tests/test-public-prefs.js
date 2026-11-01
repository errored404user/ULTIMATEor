// 2.0.2 — Public Skills -> Preferences. Module checks (node, DOM-free) and a
// jsdom walk of the real codecraft.html bundle: the Preferences section in the
// Public tab, each control writing a preference that changes real behaviour.
// Run: cd TotalScript && node tests/test-public-prefs.js   (walk needs jsdom)
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
process.chdir(ROOT);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else fail++; console.log((cond ? "ok   " : "FAIL ") + name + (extra ? "  — " + extra : "")); };

// ── A. module ──────────────────────────────────────────────────────────────
delete require.cache[require.resolve("../src/core/public_skills.js")];
const PS = require("../src/core/public_skills.js");
const D = PS.PREF_DEFAULTS;
ok("A1 PREF_DEFAULTS frozen with the seven preferences", Object.isFrozen(D) && JSON.stringify(PS.PREF_KEYS) === JSON.stringify(["author", "promptMax", "newDisabled", "importDuplicates", "testAfterCreate", "exportHistory", "sort"]));
ok("A2 defaults preserve 2.0.1 behaviour (author you, 12 in prompt, enabled, ask, test, history, install order)", D.author === "" && D.promptMax === 12 && D.newDisabled === false && D.importDuplicates === "ask" && D.testAfterCreate === true && D.exportHistory === true && D.sort === "added");
ok("A3 getPrefs returns a copy", (() => { const p = PS.getPrefs(); p.promptMax = 1; return PS.getPrefs().promptMax === 12; })());
let r = PS.setPrefs({ promptMax: 99 });
ok("A4 strict: out-of-range promptMax rejected, nothing applied", !r.ok && /between 3 and 40/.test(r.errors[0]) && PS.getPrefs().promptMax === 12);
r = PS.setPrefs({ bogus: 1 });
ok("A5 strict: unknown key rejected with the known list", !r.ok && /unknown preference 'bogus'/.test(r.errors[0]) && /author, promptMax/.test(r.errors[0]));
r = PS.setPrefs({ importDuplicates: "maybe" });
ok("A6 strict: bad enum rejected", !r.ok && /ask \| replace \| keep/.test(r.errors[0]));
r = PS.setPrefs({ promptMax: 5, author: "  Mert  ", newDisabled: "true" });
ok("A7 valid patch applies, trims, coerces form strings, reports changed keys", r.ok && r.prefs.promptMax === 5 && r.prefs.author === "Mert" && r.prefs.newDisabled === true && JSON.stringify(r.changed) === JSON.stringify(["author", "promptMax", "newDisabled"]));
let events = []; const off = PS.onChange((e) => events.push(e.reason));
PS.setPrefs({ promptMax: 5 });
ok("A8 unchanged patch emits nothing; a real change emits 'prefs'", events.length === 0 && (PS.setPrefs({ promptMax: 6 }), events[0] === "prefs"));
off();
ok("A9 lenient normalisation (stored data) clamps / falls back instead of erroring", (() => { const n = PS.normalizePrefs({ promptMax: 500, sort: "zzz", author: 42, junk: 1 }, true); return n.errors.length === 0 && n.prefs.promptMax === 40 && n.prefs.sort === "added" && n.prefs.author === "42" && !("junk" in n.prefs); })());
const spec = PS.prefSpec();
ok("A10 prefSpec exposes a label per preference (the UI uses them)", PS.PREF_KEYS.every((k) => spec[k] && spec[k].label && spec[k].type));

// hooks
PS.replaceAll([]);
PS.resetPrefs();
const ABILITY = (n) => ({ kind: "ability", name: n, title: n, description: "Audits scripts for deprecated APIs and reports what it finds.", instructions: "Audit everything carefully and report back with evidence.", steps: ["find", "read", "report"], commands: ["script_read"] });
PS.setPrefs({ author: "Mert" });
r = PS.upsert(ABILITY("aud_one"), { source: "ai" });
ok("B1 pref author: stamped on a new item with no author", r.ok && r.item.author === "Mert");
r = PS.upsert(Object.assign(ABILITY("aud_two"), { author: "Ayse" }), { source: "ai" });
ok("B2 pref author: an explicit author wins", r.ok && r.item.author === "Ayse");
PS.setPrefs({ newDisabled: true });
r = PS.upsert(ABILITY("aud_three"), { source: "ai" });
ok("B3 pref newDisabled: AI-made item installed disabled + warning the AI reads", r.ok && r.item.enabled === false && r.warnings.some((w) => /installed DISABLED/.test(w)) && PS.isCommand("aud_three") === false);
r = PS.upsert(ABILITY("aud_four"), { source: "manual" });
ok("B4 pref newDisabled: hand-made items stay enabled", r.ok && r.item.enabled === true);
r = PS.update("aud_three", { description: "Audits scripts for deprecated APIs and reports what it finds, with fixes." }, { source: "ai" });
ok("B5 pref newDisabled: an UPDATE never re-parks / changes the switch", r.ok && r.item.enabled === false && !r.warnings.some((w) => /installed DISABLED/.test(w)));
PS.setEnabled("aud_three", true);
r = PS.importShared(PS.exportJson("aud_one").replace(/"name": "aud_one"/, '"name": "aud_five"'), {});
ok("B6 pref newDisabled: imported item parked too", r.ok && r.item.name === "aud_five" && r.item.enabled === false);
PS.setPrefs({ newDisabled: false });
for (let i = 0; i < 14; i++) PS.upsert(ABILITY("filler_" + i), { source: "manual" });
const enabledCmds = PS.list({ enabled: true }).filter((i) => i.kind !== "mode").length;
const rowsOf = (t) => t.split("\n").filter((l) => /^[a-z0-9_]+ \{.*\} - \[/.test(l)).length;
PS.setPrefs({ promptMax: 12 });
const full12 = PS.catalogueBlock({});
PS.setPrefs({ promptMax: 4 });
const full4 = PS.catalogueBlock({});
ok("B7 pref promptMax: rows listed in full follow the preference (" + enabledCmds + " installed)", rowsOf(full12) === 12 && rowsOf(full4) === 4 && /and \d+ more installed/.test(full4));
ok("B8 pref promptMax: an explicit opts.max still wins", rowsOf(PS.catalogueBlock({ max: 6 })) === 6);
PS.setPrefs({ testAfterCreate: true });
ok("B9 pref testAfterCreate on: design + convert prompts carry the public_skill_test step", /public_skill_test \{"name": \.\.\.\} once to syntax-check/.test(PS.generationPrompt("lamps")) && /run public_skill_test \{"name"\} once/.test(PS.conversionPrompt("# X\nrules")));
PS.setPrefs({ testAfterCreate: false });
ok("B10 pref testAfterCreate off: both prompts say NOT to test unless asked", /do NOT call public_skill_test unless the user asks/.test(PS.generationPrompt("lamps")) && /do NOT run public_skill_test unless the user asks/.test(PS.conversionPrompt("# X\nrules")) && !/once to syntax-check/.test(PS.generationPrompt("lamps")));
PS.update("aud_one", { description: "Audits scripts for deprecated APIs and reports what it finds. v2" });
ok("B11 pref exportHistory on: history rides along the export", Array.isArray(PS.exportObject("aud_one").item.history) && PS.exportObject("aud_one").item.history.length >= 1);
PS.setPrefs({ exportHistory: false });
ok("B12 pref exportHistory off: history stripped from export, share code and pack", !("history" in PS.exportObject("aud_one").item) && !/history/.test(PS.exportJson("aud_one")) && PS.exportPackObject().items.every((i) => !("history" in i)));
ok("B13 export never carries stats either way (unchanged)", !("stats" in PS.exportObject("aud_one").item));
const L = [{ title: "Bravo", name: "b", kind: "mode", updatedAt: 20 }, { title: "alpha", name: "a", kind: "skill", updatedAt: 10, stats: { runs: 3 } }, { title: "Charlie", name: "c", kind: "ability", updatedAt: 30, stats: { runs: 9 } }];
const names = (arr) => arr.map((i) => i.name).join("");
ok("B14 sortItems: added keeps order, updated newest-first, name A-Z (case-insensitive), runs most-used, kind skill>ability>mode", names(PS.sortItems(L, "added")) === "bac" && names(PS.sortItems(L, "updated")) === "cba" && names(PS.sortItems(L, "name")) === "abc" && names(PS.sortItems(L, "runs")) === "cab" && names(PS.sortItems(L, "kind")) === "acb");
PS.setPrefs({ sort: "name" });
ok("B15 sortItems without an order uses the preference; input not mutated", names(PS.sortItems(L)) === "abc" && names(L) === "bac");
r = PS.resetPrefs();
ok("B16 resetPrefs restores every default and lists what changed", JSON.stringify(PS.getPrefs()) === JSON.stringify(D) && r.changed.includes("author") && r.changed.includes("sort"));

// ── C. source wiring (main.js) ─────────────────────────────────────────────
const main = fs.readFileSync("src/core/main.js", "utf8");
ok("C1 main.js renders the Preferences details in the Public side column", /function publicPrefsHtml\(PS\)/.test(main) && /\$\{publicPrefsHtml\(PS\)\}<\/div><div class="rs-public-compose"/.test(main));
ok("C2 one control per preference", PS.PREF_KEYS.every((k) => main.includes(`data-public-pref="${k}"`) || main.includes(`chk("${k}"`) || main.includes(`sel("${k}"`)));
ok("C3 change handler commits via setPrefs and explains a rejection", /PublicSkills\.setPrefs\(\{ \[k\]: val \}\)/.test(main) && /toast\(r\.errors\[0\]/.test(main));
ok("C4 reset button wired to resetPrefs", /data-public-prefs-reset/.test(main) && /PublicSkills\.resetPrefs\(\)/.test(main));
ok("C5 import honours importDuplicates (replace passes replace:true, keep skips, ask confirms)", /replace: dupPolicy === "replace"/.test(main) && /dupPolicy === "keep"/.test(main) && /confirm\(`'\$\{r\.duplicate\.name\}' is already installed/.test(main));
ok("C6 Public list rendered through sortItems", /PS\.sortItems\(PS\.list\(\)\)/.test(main));
const css = fs.readFileSync("overlay.css", "utf8");
ok("C7 overlay.css styles the block (base + legible cards-panel scale)", /\.rs-public-prefs\{/.test(css) && /#rs-cards-panel\[data-cards-tab\] \.rs-public-prefs > summary/.test(css) && /\.rs-public-pref-check input/.test(css));
ok("C8 README documents 2.0.2 and this test", /\*\*2\.0\.2 — /.test(fs.readFileSync("README.md", "utf8")) && /test-public-prefs\.js/.test(fs.readFileSync("README.md", "utf8")));

// ── D. jsdom walk of the real page ─────────────────────────────────────────
(async () => {
  let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { console.log("skip D (jsdom not installed)"); return done(); }
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  const pageHtml = fs.readFileSync("codecraft.html", "utf8");
  const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
  const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true }); Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
  Object.defineProperty(d, "hidden", { value: false, configurable: true }); Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
  w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} }; };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return 860; }, configurable: true }); Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; }, configurable: true }); Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return d.body; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  w.HTMLElement.prototype.scrollIntoView = function () {}; w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
  w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16); w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; w.elementFromPoint = d.elementFromPoint = () => null; d.execCommand = () => false;
  w.HTMLCanvasElement.prototype.getContext = () => null; if (!w.crypto) w.crypto = require("crypto").webcrypto;
  w.Audio = class { play() { return Promise.resolve(); } pause() {} }; w.AudioContext = undefined;
  w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" }; w.URL.createObjectURL = () => "blob:h"; w.URL.revokeObjectURL = () => {};
  w.open = () => null; w.alert = () => {}; let confirms = 0; w.confirm = () => { confirms++; return true; }; w.prompt = () => null;
  const storage = {};
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  // A stored preference must come back on boot.
  storage.rsPublicPrefs = { promptMax: 7, sort: "name" };
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true }; case "studio_status": return { ok: true, studio: true }; case "tools": case "list_tools": return { ok: true, tools: TOOLS }; case "call_tool": return { ok: true, text: "ok" }; case "blender_status": case "blender_connect": return { ok: false, blender: false }; default: return { ok: true, tools: TOOLS }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 5); return Promise.resolve(r); }, onMessage: { addListener() {}, removeListener() {} }, lastError: null, getManifest: () => manifest }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {}, removeListener() {} } }, tabs: { create() {} } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const errs = []; w.onerror = (m) => { errs.push(String(m)); };
  const vc = w.console; w.console = { ...vc, error: (...a) => { errs.push("console.error: " + a.map(String).join(" ").slice(0, 200)); }, warn: () => {}, log: () => {} };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = fs.readFileSync(path.join(ROOT, s), "utf8") + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = Date.now() + 10000; while (Date.now() < until && !d.getElementById("rs-bar")) await sleep(50);
  await sleep(800);
  const WPS = w.PublicSkills;
  ok("D1 page boots, PublicSkills loaded the stored preferences", !!d.getElementById("rs-bar") && WPS && WPS.getPrefs().promptMax === 7 && WPS.getPrefs().sort === "name");
  d.getElementById("rs-cards-btn").click(); await sleep(200);
  const panel = d.getElementById("rs-cards-panel");
  panel.querySelector('[data-tab="public"]').click(); await sleep(250);
  const det = () => panel.querySelector("[data-public-prefs]");
  ok("D2 Public tab shows a collapsed Preferences section inside the side column, after the Share box", det() && !det().open && det().closest(".rs-public-side") && det().previousElementSibling && det().previousElementSibling.classList.contains("rs-public-sharebox"));
  ok("D3 summary says '2 changed' (two stored prefs differ from defaults) and the reset button is enabled", /2 changed/.test(det().querySelector("summary").textContent) && !det().querySelector("[data-public-prefs-reset]").disabled);
  ok("D4 controls reflect stored values", det().querySelector('[data-public-pref="promptMax"]').value === "7" && det().querySelector('[data-public-pref="sort"]').value === "name" && det().querySelector('[data-public-pref="testAfterCreate"]').checked === true && det().querySelector('[data-public-pref="newDisabled"]').checked === false);
  det().open = true; det().dispatchEvent(new w.Event("toggle"));
  // Toggle a checkbox -> pref saved, storage written, section stays open after the re-render.
  const cb = det().querySelector('[data-public-pref="newDisabled"]'); cb.checked = true; cb.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(250);
  ok("D5 checkbox change saves the preference, persists it, and the section stays open after re-render", WPS.getPrefs().newDisabled === true && storage.rsPublicPrefs && storage.rsPublicPrefs.newDisabled === true && det() && det().open && det().querySelector('[data-public-pref="newDisabled"]').checked === true);
  // Text + number inputs commit on change; an invalid number is explained and reverted.
  const au = det().querySelector('[data-public-pref="author"]'); au.value = " Mert "; au.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(200);
  ok("D6 author input commits (trimmed)", WPS.getPrefs().author === "Mert" && det().querySelector('[data-public-pref="author"]').value === "Mert");
  const pm = det().querySelector('[data-public-pref="promptMax"]'); pm.value = "99"; pm.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(200);
  ok("D7 invalid promptMax rejected and the control reverts to the saved value", WPS.getPrefs().promptMax === 7 && det().querySelector('[data-public-pref="promptMax"]').value === "7");
  const so = det().querySelector('[data-public-pref="sort"]'); so.value = "kind"; so.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(200);
  ok("D8 select commits", WPS.getPrefs().sort === "kind" && storage.rsPublicPrefs.sort === "kind");
  // The parked-new-items preference really parks an AI-created item (through the management tool path the AI uses).
  const made = WPS.upsert({ kind: "ability", name: "walk_audit", title: "Walk audit", description: "Audits scripts for deprecated APIs and reports what it finds.", instructions: "Audit everything carefully and report back with evidence.", steps: ["find", "read", "report"], commands: ["script_read"] }, { source: "ai" });
  await sleep(250);
  const row = panel.querySelector('[data-public-id="' + made.item.id + '"]');
  ok("D9 with newDisabled on, an AI-created item lands disabled (card shows 'disabled', author = preference)", made.ok && made.item.enabled === false && made.item.author === "Mert" && row && row.classList.contains("rs-public-off") && /disabled/.test(row.textContent));
  // Reset restores defaults and the summary.
  det().querySelector("[data-public-prefs-reset]").click(); await sleep(250);
  ok("D10 Reset to defaults: prefs back to defaults, storage updated, summary says 'defaults', button disabled", JSON.stringify(WPS.getPrefs()) === JSON.stringify(WPS.PREF_DEFAULTS) && storage.rsPublicPrefs.promptMax === 12 && /defaults/.test(det().querySelector("summary").textContent) && det().querySelector("[data-public-prefs-reset]").disabled);
  ok("D11 no page errors during the walk", errs.length === 0, errs.slice(0, 2).join(" | "));
  done();
})().catch((e) => { console.error(e); fail++; done(); });

function done() {
  console.log(`\ntest-public-prefs: ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 30);
}
