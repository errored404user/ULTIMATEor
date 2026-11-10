// 2.2.2 — Public Skills -> References (reference library, replaces Preferences).
// A: public_refs.js module (node, DOM-free).  B: the skills engine sees the
// library (ability text, mode mandate, public_skill_refs picture, design and
// convert prompts, remove() detaches).  C: Preferences really gone + static
// wiring (manifest, dispatcher, CSS, help, README).  D: jsdom walk of the real
// codecraft.html bundle: the References section in the Public tab.
// Run: cd TotalScript && node tests/test-reference-library.js   (walk needs jsdom)
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
process.chdir(ROOT);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else fail++; console.log((cond ? "ok   " : "FAIL ") + name + (extra ? "  — " + extra : "")); };

// ── A. module ──────────────────────────────────────────────────────────────
const store = {};
global.chrome = { storage: { local: { get(keys, cb) { const out = {}; for (const k of [].concat(keys)) if (k in store) out[k] = store[k]; setTimeout(() => cb(out), 0); }, set(obj) { Object.assign(store, JSON.parse(JSON.stringify(obj))); } } } };
delete require.cache[require.resolve("../src/core/public_refs.js")];
const L = require("../src/core/public_refs.js");
ok("A1 PublicReferences exposes version 2.18.0, kinds link|note|snippet, limits, frozen API", L.VERSION === "2.18.0" && JSON.stringify(L.KINDS) === JSON.stringify(["link", "note", "snippet"]) && L.LIMITS.items === 80 && L.LIMITS.body === 16000 && Object.isFrozen(L) && L.KEY === "rsPublicRefs");
let r = L.add({ kind: "link", url: "/docs/reference/engine/classes/TweenService", tags: "Tween, UI" });
ok("A2 link: '/docs/...' resolves to create.roblox.com, title derived from the URL, tags normalised", r.ok && r.entry.url === "https://create.roblox.com/docs/reference/engine/classes/TweenService" && /TweenService/.test(r.entry.title) && JSON.stringify(r.entry.tags) === JSON.stringify(["tween", "ui"]) && r.entry.kind === "link");
const linkId = r.entry.id;
r = L.add({ kind: "link", url: "ftp://nope" });
ok("A3 link validation: non-http url rejected", !r.ok && /http\(s\)/.test(r.errors[0]));
r = L.add({ url: "https://create.roblox.com/docs/reference/engine/classes/TweenService", title: "dup" });
ok("A4 duplicate url rejected with the existing title / id (duplicate returned)", !r.ok && /already in the library as/.test(r.errors[0]) && r.duplicate && r.duplicate.id === linkId);
r = L.add({ title: "Lamp", body: "local Lighting = game:GetService(\"Lighting\")\nlocal function glow(part)\n  part.Material = Enum.Material.Neon\nend\nreturn glow" });
ok("A5 kind inferred: Luau body -> snippet with lang luau", r.ok && r.entry.kind === "snippet" && r.entry.lang === "luau" && r.entry.title === "Lamp");
const snipId = r.entry.id;
r = L.add({ kind: "note", body: "short" });
ok("A6 note needs at least 8 characters of body", !r.ok && /at least 8/.test(r.errors[0]));
r = L.add({ kind: "note", body: "# Naming rules\nAll GUI frames are PascalCase; never use Frame1." });
ok("A7 note: title falls back to the first line (markdown marker stripped)", r.ok && r.entry.title === "Naming rules" && r.entry.lang === "text");
const noteId = r.entry.id;
ok("A8 list is newest-first copies; filters by kind and query", L.list().length === 3 && L.list()[0].id === noteId && L.list({ kind: "snippet" }).length === 1 && L.list({ query: "neon glow" })[0].id === snipId && (L.list()[0].title = "x", L.get(noteId).title === "Naming rules"));
r = L.attach(snipId, ["lamp_row", "Lamp Row", "street_lamps"]);
ok("A9 attach: names snake_cased + de-duplicated; forItem finds it", r.ok && JSON.stringify(r.entry.attach) === JSON.stringify(["lamp_row", "street_lamps"]) && L.forItem("lamp_row").length === 1 && L.forItem("other").length === 0);
r = L.detach(snipId, ["street_lamps"]);
ok("A10 detach one name; detach with no names clears all", r.ok && JSON.stringify(r.entry.attach) === JSON.stringify(["lamp_row"]) && L.detach(snipId, []).entry.attach.length === 0);
L.attach(snipId, "lamp_row");
r = L.setDesign(noteId, true);
ok("A11 design flag: designEntries / forItem(name,{design:true}) include it; persisted to rsPublicRefs", r.ok && L.designEntries().length === 1 && L.designEntries()[0].id === noteId && L.forItem("lamp_row", { design: true }).length === 2 && Array.isArray(store.rsPublicRefs) && store.rsPublicRefs.find((e) => e.id === noteId).design === true);
r = L.update(linkId, { title: "TweenService docs", body: "easing styles table" });
ok("A12 update merges a patch, keeps id / createdAt, bumps updatedAt", r.ok && r.entry.id === linkId && r.entry.title === "TweenService docs" && r.entry.body === "easing styles table" && r.entry.updatedAt >= r.entry.createdAt);
ok("A13 find by id, exact title (case-insensitive) or url", L.find("tweenservice docs").id === linkId && L.find("https://create.roblox.com/docs/reference/engine/classes/TweenService").id === linkId && L.get("nope") === null);
let txt = L.textFor(L.forItem("lamp_row", { design: true }));
ok("A14 textFor: USER REFERENCES heading, notes / snippets quoted with kind + lang, nothing executed", /^USER REFERENCES \(/.test(txt) && /--- \[luau snippet\] Lamp ---\nlocal Lighting/.test(txt) && /--- \[note\] Naming rules ---/.test(txt) && /nothing here ran/.test(txt) && !/\[link\]/.test(txt));
txt = L.textFor(L.list(), { budget: 260 });
ok("A15 textFor budget: links first, long bodies omitted with an id hint instead of overflowing", txt.length <= 520 && /\[link\] TweenService docs — https:\/\/create\.roblox\.com/.test(txt) && /not shown for length/.test(txt) && /public_skill_reference \{op:"get", id\}/.test(txt));
r = L.add({ kind: "note", title: "Long", body: "x".repeat(20000) });
ok("A16 body over 16000 chars is trimmed with a warning (not rejected)", r.ok && r.entry.body.length === 16000 && /trimmed/.test(r.warnings[0]));
L.remove(r.entry.id);
ok("A17 promptLine: counts + attached + design, names the tool; empty library -> ''", /REFERENCE LIBRARY: 3 user references/.test(L.promptLine()) && /1 attached to public items/.test(L.promptLine()) && /1 marked for every new design/.test(L.promptLine()) && /public_skill_reference \{op:"list"\}/.test(L.promptLine()));
let f = L.fromFile("local x = 1\nprint(x)\n", "my-snippet.luau");
ok("A18 fromFile: .luau -> luau snippet titled from the file name; a lone URL -> link; .md -> note", f.kind === "snippet" && f.lang === "luau" && f.title === "my snippet" && L.fromFile("https://devforum.roblox.com/t/x/1\n", "u.txt").kind === "link" && L.fromFile("# Notes\nabc def ghi", "notes.md").kind === "note");
const exported = L.exportJson();
ok("A19 exportJson carries the format marker and all entries; isLibraryJson recognises it (skill files are not a library)", L.isLibraryJson(exported) && JSON.parse(exported).items.length === 3 && !L.isLibraryJson(JSON.stringify({ format: "totalscript-public-skill", item: {} })));
L.replaceAll([]);
r = L.importJson(exported);
ok("A20 importJson restores entries (ids kept, source import) and reports duplicates on a second import", r.ok && r.added === 3 && L.get(snipId) && L.importJson(exported).skipped === 3);
ok("A21 importJson rejects a skill pack / garbage with a clear error", !L.importJson(JSON.stringify({ format: "totalscript-public-skills-pack", items: [] })).ok && /not a references library/.test(L.importJson(JSON.stringify({ format: "totalscript-public-skills-pack", items: [] })).errors[0]) && /not valid JSON/.test(L.importJson("{").errors[0]));
let changes = []; const onc = (e) => changes.push(e.detail.reason);
ok("A22 renameAttachment moves / drops attachments (used when an item is deleted)", L.renameAttachment("lamp_row", "lamp_row_v2") === 1 && L.forItem("lamp_row_v2").length === 1 && L.renameAttachment("lamp_row_v2", "") === 1 && L.forItem("lamp_row_v2").length === 0);
L.attach(snipId, "lamp_row");
ok("A23 capacity: at most 80 entries", (() => { const before = L.count(); let last; for (let i = 0; i < 90; i++) { last = L.add({ kind: "note", title: "n" + i, body: "note number " + i + " with enough text" }); if (!last.ok) break; } const capped = !last.ok && /at most 80/.test(last.errors[0]) && L.count() === 80; for (const e of L.list()) if (/^n\d+$/.test(e.title)) L.remove(e.id); return capped && L.count() === before; })());
void onc; void changes;

// ── B. the skills engine sees the library ──────────────────────────────────
delete require.cache[require.resolve("../src/core/public_skills.js")];
const PS = require("../src/core/public_skills.js");
PS.replaceAll([]);
const SKILL = (n) => ({ kind: "skill", name: n, title: n, description: "Audits scripts for deprecated APIs and reports what it finds.", luau: "return {ok = true, audited = 0} -- audit everything carefully", knowledge: "## Steps\n1. find\n2. read\n3. report with evidence" });
r = PS.upsert(SKILL("lamp_row"), { source: "ai" });
ok("B1 fixed defaults after the removal: author 'you', new AI-made item enabled, no 'installed DISABLED' warning", r.ok && r.item.author === "you" && r.item.enabled === true && !r.warnings.some((w) => /DISABLED/.test(w)));
ok("B2 PublicSkills no longer exports any preference API (getPrefs/setPrefs/resetPrefs/prefSpec/PREF_DEFAULTS/sortItems gone), exposes libraryText/libraryFor/PROMPT_MAX", ["getPrefs", "setPrefs", "resetPrefs", "prefSpec", "normalizePrefs", "PREF_DEFAULTS", "PREF_KEYS", "sortItems"].every((k) => PS[k] === undefined) && typeof PS.libraryText === "function" && typeof PS.libraryFor === "function" && PS.PROMPT_MAX === 12);
const info = PS.referencesFor("lamp_row");
ok("B3 referencesFor carries library: the entries attached to that item", Array.isArray(info.library) && info.library.length === 1 && info.library[0].id === snipId);
const rt = PS.referencesText("lamp_row");
ok("B4 referencesText appends the USER REFERENCES block (attached snippet quoted) after the docs links", /USER REFERENCES/.test(rt) && /--- \[luau snippet\] Lamp ---/.test(rt) && rt.indexOf("USER REFERENCES") < rt.indexOf("RELATED BUILT-IN EXPERT") || (/USER REFERENCES/.test(rt) && !/RELATED BUILT-IN EXPERT/.test(rt)));
const knowledgeText = PS.knowledgeText("lamp_row") || "";
ok("B5 the skill's knowledge text (what the AI gets with public_skill_get / the knowledge rider source) includes the attached snippet", /USER REFERENCES/.test(knowledgeText) && /Enum\.Material\.Neon/.test(knowledgeText) && /KNOWLEDGE:\n## Steps/.test(knowledgeText));
r = PS.upsert({ kind: "mode", name: "lamp_mode", title: "Lamp mode", badge: "LAMP", base: "creation", description: "A mode that lights everything with warm lamps and keeps it tidy.", mandate: "Light every place with warm lamps. Keep hierarchies tidy and names PascalCase. Verify lighting after each change and report it." }, { source: "manual" });
ok("B6 2.18.0: a custom work mode is refused with the retirement message (nothing stored, nothing to attach to) and attach() to it fails", !r.ok && /kind 'mode' was retired in 2\.18\.0/.test(r.errors.join(" ")) && PS.find("lamp_mode") === null);
const gp = PS.generationPrompt("a skill that places street lamps", "skill", { commandNames: ["script_read"] });
ok("B7 generationPrompt includes the design-flagged entries under USER REFERENCE LIBRARY (and not the merely-attached ones)", /USER REFERENCE LIBRARY \(the user marked these for every new design/.test(gp) && /Naming rules/.test(gp) && !/--- \[luau snippet\] Lamp ---/.test(gp) && /run public_skill_test \{"name"\} once \(syntax check in Studio\)/.test(gp) && /so the verify block proves it and the skill becomes VERIFIED/.test(gp) && !/their preference/.test(gp));
const cp = PS.conversionPrompt("You are a lamp expert.\n".repeat(20), "auto", {});
ok("B8 conversionPrompt includes them too, told not to override the prompt", /USER REFERENCE LIBRARY \(the user marked these for every new design; use them only where the prompt leaves a gap/.test(cp) && /Naming rules/.test(cp));
L.setDesign(noteId, false);
ok("B9 with the design flag off, the design prompt carries no library block", !/USER REFERENCE LIBRARY/.test(PS.generationPrompt("a skill that places street lamps", "skill", {})));
PS.remove("lamp_row");
ok("B10 deleting an item detaches it from the library", L.forItem("lamp_row").length === 0 && L.get(snipId));
for (let i = 0; i < 3; i++) PS.upsert(SKILL("filler_" + i), { source: "manual" });
const cat = PS.catalogueBlock({});
ok("B11 catalogue block (system prompt) mentions the library once it is non-empty, compact variant stays lean", /REFERENCE LIBRARY: 3 user references/.test(cat) && !/REFERENCE LIBRARY/.test(PS.catalogueBlock({ compact: true })));
L.replaceAll([]);
ok("B12 empty library -> no library lines anywhere", !/REFERENCE LIBRARY/.test(PS.catalogueBlock({})) && PS.referencesText("filler_0").indexOf("USER REFERENCES") < 0 && PS.libraryText(null, { design: true }) === "");
const tools = PS.managementTools();
const tool = tools.find((t) => t.name === "public_skill_reference");
ok("B13 public_skill_reference management tool: WRITE, op enum, short description (< 400 chars)", tool && tool.executionMode === "WRITE" && tool.server === "totalscript" && JSON.stringify(tool.inputSchema.properties.op.enum) === JSON.stringify(["list", "get", "add", "update", "remove", "attach", "detach"]) && tool.description.length < 400 && tools.length === 12);
ok("B14 exports always keep history now (no exportHistory switch)", (() => { PS.update("filler_0", { description: "Audits scripts for deprecated APIs and reports what it finds, with fixes." }); const o = PS.exportObject("filler_0"); return o && Array.isArray(o.item.history) && o.item.history.length >= 1; })());

// ── C. Preferences gone + static wiring ────────────────────────────────────
const main = fs.readFileSync("src/core/main.js", "utf8");
const ps = fs.readFileSync("src/core/public_skills.js", "utf8");
const css = fs.readFileSync("overlay.css", "utf8");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const readme = fs.readFileSync("README.md", "utf8");
ok("C1 public_skills.js: no rsPublicPrefs storage, no PREF_* tables, no prefs.* hooks, no 'their preference' prompt branches", !/rsPublicPrefs|PREF_DEFAULTS|PREF_SPEC|PREF_KEYS|normalizePrefs|persistPrefs|\bprefs\./.test(ps) && !/their preference/.test(ps) && !/installed DISABLED \(Preferences/.test(ps));
ok("C2 main.js: Preferences UI and handlers gone (no publicPrefsHtml, data-public-pref, getPrefs, resetPrefs, dupPolicy)", !/publicPrefsHtml|data-public-prefs?\b|getPrefs|resetPrefs|setPrefs|dupPolicy|publicPrefsOpen|PS\.sortItems/.test(main));
ok("C3 overlay.css: no .rs-public-pref rules remain; References block styled (base + cards-panel scale), old per-item .rs-public-refs line untouched", !/rs-public-prefs?\b|rs-public-pref\b|rs-public-pref-/.test(css) && /\.rs-public-lib\{margin:6px 10px 0/.test(css) && /\.rs-public-lib-kind-snippet\{/.test(css) && /#rs-cards-panel\[data-cards-tab\] \.rs-public-lib > summary/.test(css) && /\.rs-public-refs\{display:flex/.test(css));
ok("C4 tests/test-public-prefs.js deleted", !fs.existsSync("tests/test-public-prefs.js"));
const bundles = manifest.content_scripts.filter((cs) => (cs.js || []).includes("src/core/public_packs.js"));
ok("C5 manifest: public_refs.js loads right before public_packs.js in every bundle that has Public Skills (11)", bundles.length === 11 && bundles.every((cs) => cs.js.indexOf("src/core/public_refs.js") === cs.js.indexOf("src/core/public_packs.js") - 1));
ok("C6 codecraft.html loads public_refs.js before public_packs.js", (() => { const h = fs.readFileSync("codecraft.html", "utf8"); return h.indexOf("src/core/public_refs.js") > 0 && h.indexOf("src/core/public_refs.js") < h.indexOf("src/core/public_packs.js"); })());
ok("C7 main.js dispatches public_skill_reference through the public_skill_ path (runPublicReferenceTool: list/get/add/update/remove/attach/detach), never executes entry text", /if \(op === "reference"\) return runPublicReferenceTool\(name, args, \{ out, fail \}\);/.test(main) && /function runPublicReferenceTool\(name, args, io\)/.test(main) && /if \(op === "attach"\) return done\(L\.attach/.test(main) && /if \(op === "detach"\) return done\(L\.detach/.test(main) && /UNKNOWN_OP/.test(main) && !/eval\(|new Function\(/.test(main.slice(main.indexOf("function runPublicReferenceTool"), main.indexOf("async function runPublicSkillTool"))));
ok("C8 public_skill_refs output carries library[]", /library: \(info\.library \|\| \[\]\)\.map/.test(main));
ok("C9 Public tab: publicLibraryHtml in the side column where Preferences sat; form + file + export/import + per-entry Attach / Designing / Edit / Delete", /\$\{publicLibraryHtml\(PS\)\}<\/div><div class="rs-public-compose"/.test(main) && /data-public-ref-form/.test(main) && /data-public-ref-file/.test(main) && /data-public-refs-export/.test(main) && /data-public-refs-import/.test(main) && /data-public-ref-attach=/.test(main) && /data-public-ref-design=/.test(main) && /data-public-ref-edit=/.test(main) && /data-public-ref-delete=/.test(main) && /accept = "\.txt,\.md,\.lua,\.luau,\.json/.test(main));
ok("C10 library .json dropped / imported on the Public tab goes to the library, not the skill importer; compose head counts design references; cards show attached count", /PublicReferences\.isLibraryJson\(text\)\) \{ const r = PublicReferences\.importJson\(text\)/.test(main) && /rs-public-compose-lib/.test(main) && /library ref\$\{libCount\(i\) === 1/.test(main) && /total-public-refs-change/.test(main));
ok("C11 help card explains the References section (attached to skills, rides with the knowledge) and no longer the Preferences section", /The References section is your reference library: docs links, notes and Luau \/ GUI snippets attached to skills/.test(main) && !/Preferences section \(2\.0\.2\)/.test(main));
ok("C12 README: 2.2.2 entry, References described, Preferences feature line gone, test listed", /\*\*2\.2\.2 — Public Skills: Preferences removed, References added\.\*\*/.test(readme) && /References/.test(readme) && /^node tests\/test-reference-library\.js/m.test(readme) && !/^node tests\/test-public-prefs\.js/m.test(readme));

// ── D. jsdom walk of the real page ─────────────────────────────────────────
(async () => {
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
  w.HTMLAnchorElement.prototype.click = function () { clicks.push(this.download || this.href); }; const clicks = [];
  w.open = () => null; w.alert = () => {}; let confirms = 0; w.confirm = () => { confirms++; return true; }; let promptAnswer = null; w.prompt = () => promptAnswer;
  const storage = {};
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, JSON.parse(JSON.stringify(obj))); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  // A stored library and a stored public item must come back on boot.
  storage.rsPublicRefs = [{ id: "pr_seed1", kind: "link", title: "TweenService", url: "https://create.roblox.com/docs/reference/engine/classes/TweenService", body: "", lang: "", tags: ["tween"], attach: ["lamp_row"], design: false, source: "user", createdAt: 1, updatedAt: 1 }];
  storage.rsPublicSkills = [{ id: "ps_seed1", kind: "skill", name: "lamp_row", title: "Lamp row", description: "Audits scripts for deprecated APIs and reports what it finds.", luau: "return {ok = true, audited = 0} -- audit everything carefully", params: [], enabled: true, version: 1, author: "you", source: "manual", createdAt: 1, updatedAt: 1 }];
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true }; case "studio_status": return { ok: true, studio: true }; case "tools": case "list_tools": return { ok: true, tools: TOOLS }; case "call_tool": return { ok: true, result: { content: [{ type: "text", text: "ok" }] } }; default: return { ok: true }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 5); return Promise.resolve(r); }, onMessage: { addListener() {}, removeListener() {} }, lastError: null, getManifest: () => manifest }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {}, removeListener() {} } } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const errs = []; w.onerror = (m) => { errs.push(String(m)); };
  const vc = w.console; w.console = { ...vc, error: (...a) => { errs.push("console.error: " + a.map(String).join(" ").slice(0, 200)); }, warn: () => {}, log: () => {} };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = fs.readFileSync(path.join(ROOT, s), "utf8") + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = Date.now() + 10000; while (Date.now() < until && !d.getElementById("rs-bar")) await sleep(50);
  await sleep(800);
  const WL = w.PublicReferences, WPS = w.PublicSkills;
  ok("D1 page boots; PublicReferences loaded the stored library (1 link attached to lamp_row); PublicSkills has no prefs API", !!d.getElementById("rs-bar") && WL && WL.count() === 1 && WL.forItem("lamp_row").length === 1 && WPS && WPS.getPrefs === undefined);
  d.getElementById("rs-cards-btn").click(); await sleep(200);
  const panel = d.getElementById("rs-cards-panel");
  panel.querySelector('[data-tab="public"]').click(); await sleep(250);
  const det = () => panel.querySelector("[data-public-refs]");
  ok("D2 Public tab: a collapsed References section in the side column after the Share box; no Preferences left", det() && !det().open && det().closest(".rs-public-side") && det().previousElementSibling && det().previousElementSibling.classList.contains("rs-public-sharebox") && !panel.querySelector("[data-public-prefs]") && !/Preferences/.test(panel.textContent));
  ok("D3 summary counts '1 · 1 attached'; the row shows kind pill, safe link, attached name; the card says '1 library ref'", /1 · 1 attached/.test(det().querySelector("summary").textContent) && det().querySelector(".rs-public-lib-kind-link") && det().querySelector('.rs-public-lib-row a[target="_blank"][rel="noopener noreferrer"]') && /attached: lamp_row/.test(det().textContent) && /1 library ref/.test(panel.querySelector('[data-public-id="ps_seed1"]').textContent));
  det().open = true; det().dispatchEvent(new w.Event("toggle")); await sleep(50);
  // Add a snippet through the form.
  const form = det().querySelector("[data-public-ref-form]");
  const kindSel = form.querySelector("[data-public-ref-kind]"); kindSel.value = "snippet"; kindSel.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("D4 choosing Snippet hides the url field and grows the body box", form.querySelector("[data-public-ref-url]").hidden === true && form.querySelector("[data-public-ref-body]").rows === 5);
  form.querySelector("[data-public-ref-title]").value = "Glow lamp";
  form.querySelector("[data-public-ref-body]").value = "local function glow(part)\n  part.Material = Enum.Material.Neon\nend";
  form.querySelector("[data-public-ref-tags]").value = "lamp, neon";
  form.querySelector("[data-public-ref-flag]").checked = true;
  form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await sleep(250);
  const snip = WL.list().find((e) => e.title === "Glow lamp");
  ok("D5 submit adds a luau snippet with tags + design flag, persists it, section stays open and lists it", snip && snip.kind === "snippet" && snip.lang === "luau" && snip.design === true && JSON.stringify(snip.tags) === JSON.stringify(["lamp", "neon"]) && storage.rsPublicRefs.length === 2 && det().open && det().querySelector(".rs-public-lib-kind-snippet"));
  ok("D6 compose head now says 1 reference goes with every new design", /1 reference goes with every new design/.test(panel.querySelector(".rs-public-compose-head").textContent));
  // Attach via the prompt dialog (comma list, unknown names skipped).
  promptAnswer = "lamp_row, not_installed";
  det().querySelector('[data-public-ref-attach="' + snip.id + '"]').click(); await sleep(250);
  ok("D7 Attach: installed names kept, unknown skipped; the ability text the AI gets now quotes the snippet", JSON.stringify(WL.get(snip.id).attach) === JSON.stringify(["lamp_row"]) && /Enum\.Material\.Neon/.test(WPS.referencesText("lamp_row")) && /2 library refs/.test(panel.querySelector('[data-public-id="ps_seed1"]').textContent));
  // Designing toggle off.
  det().querySelector('[data-public-ref-design="' + snip.id + '"]').click(); await sleep(250);
  ok("D8 Designing toggle flips the flag and the compose note disappears", WL.get(snip.id).design === false && !/every new design/.test(panel.querySelector(".rs-public-compose-head").textContent));
  // Edit flow: form pre-filled, Save changes, Cancel via Escape.
  det().querySelector('[data-public-ref-edit="' + snip.id + '"]').click(); await sleep(250);
  const f2 = det().querySelector("[data-public-ref-form]");
  ok("D9 Edit pre-fills the form and the button reads 'Save changes'", f2.querySelector("[data-public-ref-title]").value === "Glow lamp" && /Save changes/.test(f2.querySelector("[data-public-ref-save]").textContent) && det().querySelector(".rs-public-lib-editing"));
  f2.querySelector("[data-public-ref-title]").value = "Glow lamp v2"; f2.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await sleep(250);
  ok("D10 Save changes updates the entry in place (same id, attachments kept)", WL.get(snip.id).title === "Glow lamp v2" && WL.get(snip.id).attach.length === 1 && WL.count() === 2);
  // The AI tool path writes the same library the UI shows.
  const toolOut = await w.__rsRunTool({ tool: "public_skill_reference", arguments: { op: "add", kind: "note", title: "Naming", body: "All GUI frames are PascalCase; never use Frame1.", design: true } });
  await sleep(250);
  ok("D11 public_skill_reference {op:add} through the dispatcher lands in the library and the tab re-renders with it", /"status": "added"/.test(toolOut) && WL.count() === 3 && /Naming/.test(det().textContent) && /1 reference goes with every new design/.test(panel.querySelector(".rs-public-compose-head").textContent));
  const listOut = await w.__rsRunTool({ tool: "public_skill_reference", arguments: { op: "list", attached_to: "lamp_row" } });
  ok("D12 {op:list, attached_to} filters; {op:get} prints the body; bad op is explained", /"count": 2/.test(listOut) && /Enum\.Material\.Neon/.test(await w.__rsRunTool({ tool: "public_skill_reference", arguments: { op: "get", id: snip.id } })) && /UNKNOWN_OP/.test(await w.__rsRunTool({ tool: "public_skill_reference", arguments: { op: "zap" } })));
  // Delete asks first.
  det().querySelector('[data-public-ref-delete="pr_seed1"]').click(); await sleep(250);
  ok("D13 Delete confirms, removes the entry, list and summary update", confirms >= 1 && !WL.get("pr_seed1") && WL.count() === 2 && !/TweenService/.test(det().textContent));
  // Export library -> JSON with the format marker.
  det().querySelector("[data-public-refs-export]").click(); await sleep(100);
  ok("D14 Export library downloads totalscript-references-<date>.json; the export carries the format marker", clicks.some((c) => /^totalscript-references-\d{4}-\d{2}-\d{2}\.json$/.test(c)) && WL.isLibraryJson(WL.exportJson()) && JSON.parse(WL.exportJson()).count === 2);
  ok("D15 no page errors during the walk", errs.length === 0, errs.slice(0, 2).join(" | "));
  done();
})().catch((e) => { console.error(e); fail++; done(); });

function done() {
  console.log(`\ntest-reference-library: ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 30);
}
