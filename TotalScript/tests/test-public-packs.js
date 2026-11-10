// Featured Public Skills pack (2.21.0): src/core/public_packs.js.
// Dependency-free. Loads the real skills bundle + Public Skills in a vm, then checks
// that every bundled item validates against the live command catalogue, installs
// through the normal import path, round-trips as a pack file / share code, and that
// the manifest / codecraft / main.js / overlay.css wiring is in place. Run from the
// TotalScript root:  node tests/test-public-packs.js
// Behaviour of the generated Luau is covered by tests/public-pack-sim.py (lupa).
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra ? "  — " + String(extra).slice(0, 600) : "")); } };

// ── boot: skills bundle + skill_intel/refs + public skills + packs ─────────
const store = {};
global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb({ ...store }), set: (o) => Object.assign(store, o) } }, runtime: { getURL: (p) => p } };
global.navigator = { userAgent: "node" };
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(read("manifest.json"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
for (const f of bundles[0].js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
for (const f of ["src/core/skill_intel.js", "src/core/skill_refs.js", "src/core/public_skills.js", "src/core/public_packs.js"]) vm.runInThisContext(read(f), { filename: f });
const S = RobloxScriptSkills, PS = window.PublicSkills, PP = window.TotalPublicPacks;
const catalogue = new Set(S.SKILL_COMMANDS.map((c) => c.name));
const reserved = new Set([...catalogue, ...PS.managementTools().map((t) => t.name)]);

ok("module exposes window.TotalPublicPacks (and module.exports) with a frozen API", PP && Object.isFrozen(PP) && typeof PP.install === "function" && typeof PP.status === "function" && typeof PP.packJson === "function");
ok("VERSION 2.21.0, PACK_ID totalscript_featured, exactly one pack listed", PP.VERSION === "2.21.0" && PP.PACK_ID === "totalscript_featured" && PP.list().length === 1 && PP.list()[0].id === PP.PACK_ID);
ok("module is DOM-free at top level", !/^\s*(const|let|var)?\s*\w*\s*=?\s*document\./m.test(read("src/core/public_packs.js")));

const pack = PP.get(PP.PACK_ID);
const items = pack.items;
const byKind = (k) => items.filter((i) => i.kind === k);
ok("pack has 11 items and every one is a skill (no abilities, no modes - 2.2.3)", items.length === 11 && byKind("skill").length === 11 && byKind("ability").length === 0 && byKind("mode").length === 0, items.map((i) => i.kind + ":" + i.name).join(","));
ok("expected item names", JSON.stringify(items.map((i) => i.name)) === JSON.stringify(["damage_numbers_pro", "npc_patrol_chase", "keycard_door_system", "dialogue_tree_system", "collectible_spawner", "zone_system", "boss_health_bar", "checkpoint_system", "gui_polish_kit", "game_feel_kit", "place_audit_report"]), items.map((i) => i.name).join(","));
ok("names are unique and none collides with a built-in command or management tool", new Set(items.map((i) => i.name)).size === items.length && items.every((i) => !reserved.has(i.name)));
ok("every item carries author/version/tags and a real description", items.every((i) => i.author === PP.AUTHOR && i.version >= 1 && Array.isArray(i.tags) && i.tags.length >= 2 && i.description.length >= 60));

// ── validation against the live catalogue ──────────────────────────────────
for (const it of items) {
  const v = PS.validate(it, { reserved });
  ok(`validate ${it.kind} '${it.name}': 0 errors, 0 warnings`, v.ok && v.errors.length === 0 && v.warnings.length === 0, JSON.stringify({ e: v.errors, w: v.warnings }));
}
for (const it of byKind("skill")) {
  const luau = String(it.luau || "");
  ok(`skill '${it.name}' Luau: substantial, ends with a result table (wrapper adds ok=true), honest ok=false errors when it needs a target, every param used`, luau.length >= 6000 && /return \{\n  \w+ = /.test(luau.slice(luau.lastIndexOf("return {"))) && (!it.params.some((p) => p.required) || /return \{ ok = false, error = /.test(luau)) && it.params.length >= 1 && it.params.every((p) => luau.includes("{{" + p.name + "}}") || luau.includes("args." + p.name)), luau.length);
  ok(`skill '${it.name}' Luau avoids +=, continue and :: so the sim parser (and old tooling) reads it`, !/\+=|\ncontinue\b|::/.test(luau));
  ok(`skill '${it.name}' installs scripts with real code in .Source (no TODO stubs, no fake asset ids)`, /\.Source\s*=/.test(luau) && !/TODO|rbxassetid:\/\/\d{3,}/.test(luau));
}
for (const it of items) {
  const refs = it.references || [];
  ok(`skill '${it.name}' carries >= 4 docs references, each a titled create.roblox.com/docs link`, refs.length >= 4 && refs.length <= 12 && refs.every((r) => r && typeof r.title === "string" && r.title.length >= 3 && /^https:\/\/create\.roblox\.com\/docs\//.test(r.url)), JSON.stringify(refs.map((r) => r.url)));
}
ok("no item carries legacy ability/mode fields (steps, focus, mandate) - every one is kind skill", items.every((i) => i.kind === "skill" && !i.steps && !i.focus && !i.mandate));
// 2.21.0: knowledge + verify on every item (what makes an installed copy VERIFIABLE)
for (const it of items) {
  const k = String(it.knowledge || ""), v = it.verify && it.verify.luau ? String(it.verify.luau) : "";
  ok(`skill '${it.name}' knowledge: When to use / Before running (or nothing to prepare) / After running sections, 300-1200 chars`, /## When to use/.test(k) && /## After running/.test(k) && k.length >= 300 && k.length <= 1200, k.length);
  ok(`skill '${it.name}' verify block: uses find()/check(), returns {ok = true, detail}, has a note, plain Lua (no += / continue)`, v.length >= 200 && /\bcheck\(/.test(v) && /\bfind\(/.test(v) && /return \{ ok = true, detail = /.test(v) && typeof it.verify.note === "string" && it.verify.note.length >= 20 && !/\+=|\bcontinue\b|::/.test(v), v.slice(0, 120));
  const built = PS.buildVerify(Object.assign({}, it, { id: "x" }), it.params.reduce((a, p) => (p.required ? Object.assign(a, { [p.name]: "Workspace.Thing" }) : a), {}), null);
  ok(`skill '${it.name}' verify program builds (helpers + pcall wrapper + verify=true tag)`, !built.err && /local function find\(path\)/.test(built.code) && /verify = true/.test(built.code), built.err);
}

// ── install through the normal import path ──────────────────────────────────
let st = PP.status(PS, PP.PACK_ID);
ok("status before install: 11 rows, none installed, each reporting its reference count (>= 4) and verify/knowledge flags", st.length === 11 && st.every((r) => !r.installed && !r.upToDate && !r.modified && r.references >= 4 && r.verify === true && r.knowledge === true));
let inst = PP.install(PS, PP.PACK_ID, { reserved });
ok("install: 11 installed, no errors/warnings, every item is now a real Public Skill", inst.ok && inst.installed.length === 11 && inst.errors.length === 0 && inst.warnings.length === 0 && items.every((i) => PS.find(i.name) && PS.find(i.name).kind === i.kind), JSON.stringify({ e: inst.errors, w: inst.warnings }));
st = PP.status(PS, PP.PACK_ID);
ok("status after install: all installed, upToDate, unmodified", st.every((r) => r.installed && r.upToDate && !r.modified && r.installedVersion >= 1));
ok("installed skills are callable tools (toolEntries) with their signatures", byKind("skill").every((i) => PS.toolEntries().some((t) => t.name === i.name && t.publicSkill)));
ok("installed featured skills arrive UNVERIFIED (bundling never pre-verifies) and their knowledge rides for a matching request", items.every((i) => PS.verification(i.name).state === "unverified") && /PUBLIC SKILL KNOWLEDGE/.test(PS.knowledgeRider("add floating damage numbers over every enemy", {})) && /damage_numbers_pro/.test(PS.knowledgeRider("add floating damage numbers over every enemy", {})));
ok("every installed featured skill exports as SKILL.md and parses back with knowledge + verify intact", items.every((i) => { const md = PS.toSkillMd(i.name); const p = PS.parseSkillMd(md); return p.ok && p.def.name === i.name && p.def.verify && p.def.verify.luau.trim() === i.verify.luau.trim() && p.def.knowledge.trim() === i.knowledge.trim() && p.def.luau.trim() === i.luau.trim(); }));
const again = PP.install(PS, PP.PACK_ID, { reserved });
ok("installing again skips everything instead of duplicating", again.installed.length === 0 && again.skipped.length === 11 && PS.list().length === 11, JSON.stringify(again.skipped.length));
const subset = PP.install(PS, PP.PACK_ID, { reserved, names: ["zone_system"], replace: true });
ok("names subset + replace reinstalls only that item", subset.installed.length === 1 && subset.installed[0].name === "zone_system" && PS.list().length === 11);
ok("unknown subset -> honest error", !PP.install(PS, PP.PACK_ID, { reserved, names: ["nope"] }).ok && !PP.install(PS, "nope", { reserved }).ok);
const upd = PS.update("zone_system", { description: PS.find("zone_system").description + " (my tweak)" }, { reserved });
ok("a user edit marks the row modified (history) so the UI asks before replacing", upd.ok && PP.status(PS, PP.PACK_ID).find((r) => r.name === "zone_system").modified === true, JSON.stringify(upd.errors));

// built Luau from an installed skill resolves args (the sim covers runtime)
const built = PS.buildLuau("zone_system", { zone: "Workspace.Lava", kind: "damage", amount: 20 });
ok("buildLuau on an installed featured skill injects the args and wraps in pcall", built.code && built.code.includes("Workspace.Lava") && /pcall\(function\(\)/.test(built.code) && built.code.length > 8000, built.err);
ok("missing required param -> MISSING_PARAMS with signature", /MISSING_PARAMS/.test(PS.buildLuau("keycard_door_system", {}).err || ""));

// ── pack file / share code round trip ──────────────────────────────────────
const json = PP.packJson(PP.PACK_ID);
const obj = JSON.parse(json);
ok("packJson is a totalscript-public-skill-pack with deterministic exportedAt and 11 items", obj.format === "totalscript-public-skill-pack" && obj.formatVersion === 1 && obj.pack === PP.PACK_ID && obj.exportedAt === "bundled" && obj.count === 11 && obj.items.length === 11 && obj.version === "2.21.0");
const file = read("public_skills/totalscript-featured.orskills.json");
ok("public_skills/totalscript-featured.orskills.json is the exact packJson output (node tests/build-public-pack.js)", file === json + "\n", "run: node tests/build-public-pack.js");
PS.replaceAll([]);
const imp = PS.importShared(json, { reserved });
ok("importShared(packJson) installs the same 11 items (what a downloaded file does)", imp.ok && imp.pack && imp.installed.length === 11 && imp.errors.length === 0, JSON.stringify(imp.errors));
PS.replaceAll([]);
const code = "ORSKILL1:" + Buffer.from(json, "utf8").toString("base64");
const imp2 = PS.importShared(code, { reserved });
ok("the share code the Public tab copies imports too", imp2.ok && imp2.installed.length === 11);
const parsed = PS.parseShared(json);
ok("parseShared recognises the pack and keeps item kinds", parsed.ok && parsed.pack && parsed.defs.length === 11 && parsed.defs.every((i) => i.kind === "skill" && Array.isArray(i.references) && i.references.length >= 4));

// ── wiring ─────────────────────────────────────────────────────────────────
ok("manifest loads public_packs.js right before public_skills.js in all 10 main.js bundles (2.21.0: Notion removed; pack module is load-order independent; explorer.js keeps its slot after public_skills.js)", bundles.length >= 10 && bundles.every((c) => c.js.indexOf("src/core/public_packs.js") === c.js.indexOf("src/core/public_skills.js") - 1 && c.js.indexOf("src/core/public_packs.js") < c.js.indexOf("src/core/main.js")));
const cc = read("codecraft.html");
ok("codecraft.html includes public_packs.js right before public_skills.js", cc.indexOf("src/core/public_packs.js") > 0 && cc.indexOf("src/core/public_packs.js") < cc.indexOf("src/core/public_skills.js") && /public_packs\.js"><\/script>\n\s*<script src="src\/core\/public_skills\.js">/.test(cc));
const main = read("src/core/main.js");
ok("main.js dispatcher: public_skill_import {data:'featured'} / {pack} routes through TotalPublicPacks.packObject + importShared", main.includes("/^(pack:)?(featured|totalscript_featured)$/i.test(String(args.data") && main.includes("PP.packObject(pack.id)") && main.includes('fail("UNKNOWN_PACK"') && main.includes('fail("UNKNOWN_PACK_ITEM"'));
ok("main.js: empty list hint points at the featured pack", main.includes('public_skill_import {data:\\"featured\\"} installs the bundled Featured pack'));
ok("main.js Public tab renders the Featured shelf with per-item + install-all + export + share handlers", /function publicFeaturedHtml\(PS\)/.test(main) && main.includes("${publicFeaturedHtml(PS)}${pfilters}") && ["data-public-feat-install=", "data-public-feat-install-all", "data-public-feat-export", "data-public-feat-share", "data-public-featured"].every((s) => main.includes(s)) && /function publicFeaturedInstall\(names, replace\)/.test(main));
ok("main.js: reinstalling an edited item asks first; install uses publicReserved()", main.includes("was edited on this device. Replace it with the bundled version?") && main.includes("PP.install(PublicSkills, PP.PACK_ID, { names, replace: !!replace, reserved: publicReserved() })"));
ok("main.js help card mentions the Featured pack and that every item ships knowledge + verify", /Featured by TotalScript \(2\.2\.0, knowledge \+ verify since 2\.21\.0\)/.test(main) && /each with docs references, knowledge and a verify block/.test(main) && /Bundled skills arrive UNVERIFIED/.test(main));
const tool = PS.managementTools().find((t) => t.name === "public_skill_import");
ok("public_skill_import tool schema documents data:'featured' and names[]", /featured/.test(tool.description) && tool.inputSchema.properties.names && tool.inputSchema.properties.names.type === "array");
const css = read("overlay.css");
ok("overlay.css styles the shelf (dark + light)", [".rs-public-featured{", ".rs-public-feat-row{", ".rs-public-feat-list{", "html.rs-light .rs-public-featured{"].every((s) => css.includes(s)));
ok("README documents the Featured pack and the sim test", /Featured by TotalScript/.test(read("README.md")) && /public-pack-sim\.py/.test(read("README.md")) && /test-public-packs\.js/.test(read("README.md")));

// ── E. jsdom walk of the real page: the Featured shelf in the Public tab ────
(async () => {
  const done = () => console.log(`test-public-packs: ${pass} passed, ${fail} failed`);
  let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { console.log("skip E (jsdom not installed)"); return done(); }
  delete global.window; delete global.chrome;
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
  const WPS = w.PublicSkills, WPP = w.TotalPublicPacks;
  ok("E1 page boots with TotalPublicPacks loaded and nothing installed", !!d.getElementById("rs-bar") && WPP && WPP.VERSION === "2.21.0" && WPS.list().length === 0);
  d.getElementById("rs-cards-btn").click(); await sleep(200);
  const panel = d.getElementById("rs-cards-panel");
  panel.querySelector('[data-tab="public"]').click(); await sleep(250);
  const shelf = () => panel.querySelector("[data-public-featured]");
  ok("E2b every featured row shows its docs reference count pill (e.g. '5 refs')", shelf().querySelectorAll(".rs-public-feat-row").length === 11 && Array.from(shelf().querySelectorAll(".rs-public-feat-row")).every((row) => /\d+ refs/.test(row.textContent)));
  ok("E2 Public tab shows the Featured shelf open, 0/11 installed, 11 rows with Install buttons", shelf() && shelf().open && shelf().querySelector(".rs-template-count").textContent === "0/11" && shelf().querySelectorAll(".rs-public-feat-row").length === 11 && shelf().querySelectorAll("[data-public-feat-install]").length === 11);
  shelf().querySelector('[data-public-feat-install="zone_system"]').click(); await sleep(300);
  ok("E3 Install on one row installs that skill (list card appears, row marked Installed, count 1/11)", WPS.find("zone_system") && WPS.list().length === 1 && shelf().querySelector('[data-public-feat-item="zone_system"]').classList.contains("on") && shelf().querySelector(".rs-template-count").textContent === "1/11" && !!panel.querySelector(".rs-public-list"));
  ok("E4 the installed skill is a live tool for the agent (public_skill tool entry)", WPS.toolEntries().some((t) => t.name === "zone_system") && WPS.toolEntries().filter((t) => t.publicSkill).length === 1);
  shelf().querySelector("[data-public-feat-install-all]").click(); await sleep(400);
  ok("E5 Install all missing installs the other 10; button turns into 'Everything installed' (disabled)", WPS.list().length === 11 && shelf().querySelector("[data-public-feat-install-all]").disabled && /Everything installed/.test(shelf().querySelector("[data-public-feat-install-all]").textContent) && shelf().querySelectorAll("[data-public-feat-replace]").length === 11);
  ok("E6 all 11 featured items are callable tools, every one of them kind skill, and all arrive UNVERIFIED (a bundled pass never travels)", WPS.toolEntries().filter((t) => t.publicSkill).length === 11 && WPS.list().every((i) => i.kind === "skill" && WPS.verification(i).state === "unverified") && typeof WPS.modes !== "function");
  WPS.update("boss_health_bar", { description: WPS.find("boss_health_bar").description + " (edited)" });
  await sleep(300);
  const bossRow = shelf().querySelector('[data-public-feat-item="boss_health_bar"]');
  ok("E7 an edited item shows 'Installed · edited' and Reinstall asks for confirmation", bossRow && /edited/.test(bossRow.querySelector(".rs-public-feat-have").textContent) && (confirms = 0, bossRow.querySelector("[data-public-feat-replace]").click(), true));
  await sleep(300);
  ok("E8 confirmed Reinstall restores the bundled description", confirms === 1 && !/\(edited\)$/.test(WPS.find("boss_health_bar").description), WPS.find("boss_health_bar").description.slice(-40));
  let copied = ""; w.navigator.clipboard.writeText = async (t) => { copied = t; };
  shelf().querySelector("[data-public-feat-share]").click(); await sleep(200);
  ok("E9 Copy share code puts an ORSKILL1 pack code on the clipboard that parses back to 11 items", /^ORSKILL1:/.test(copied) && WPS.parseShared(copied).defs.length === 11);
  let downloaded = ""; w.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; }; // jsdom cannot navigate to blob: URLs
  shelf().querySelector("[data-public-feat-export]").click(); await sleep(100);
  ok("E10 Download pack .json triggers a totalscript-featured.orskills.json download", downloaded === "totalscript-featured.orskills.json");
  ok("E11 no page errors during the walk", errs.length === 0, errs.join(" | "));
  done();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
})();
