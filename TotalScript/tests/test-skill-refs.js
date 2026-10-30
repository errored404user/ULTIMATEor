#!/usr/bin/env node
// tests/test-skill-refs.js — 1.99.4 "skills get references".
//
//   src/core/skill_refs.js carries, per built-in expert (skill_intel.js):
//     - REFS      official Roblox Creator Docs pages (paths under DOCS_BASE;
//                 a handful of Blender links are flagged `unverified`)
//     - EXAMPLES  small plain-Luau patterns the AI copies the shape of
//   skill_intel.expertText(id) renders both sections at the end of the
//   `skill {name}` output. This test checks the data shape, the wiring and
//   the load order; the docs paths themselves are verified ONLINE by
//   tools/verify_doc_refs.js (GitHub listing of Roblox/creator-docs) and the
//   Luau bodies are parsed by tests/skill-refs-sim.py (lupa).
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra != null ? "  — " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400) : "")); } };

// ── load: pack (command names) → skill_refs → skill_intel, same order as the manifest
global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
try { Object.defineProperty(global, "navigator", { value: { userAgent: "node" }, configurable: true }); } catch {}
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(read("manifest.json"));
const bundle = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"))[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
const R = require(path.join(ROOT, "src/core/skill_refs.js"));
vm.runInThisContext(read("src/core/skill_refs.js"), { filename: "skill_refs.js" });
vm.runInThisContext(read("src/core/skill_intel.js"), { filename: "skill_intel.js" });
const SI = window.TotalSkillIntel;
const src = read("src/core/skill_refs.js"), intel = read("src/core/skill_intel.js");

// ── A. module shape ────────────────────────────────────────────────────────
ok("A1 module exports (CommonJS + window.TotalSkillRefs) with the same api", R && window.TotalSkillRefs && ["VERSION", "DOCS_BASE", "REFS", "EXAMPLES", "refs", "examples", "render", "ids", "all"].every((k) => k in R && k in window.TotalSkillRefs));
ok("A2 VERSION 1.99.4, DOCS_BASE is the Creator Docs root", R.VERSION === "1.99.4" && R.DOCS_BASE === "https://create.roblox.com/docs/");
ok("A3 module is DOM-free at top level (no document access)", !/\bdocument\./.test(src.replace(/\/\/[^\n]*/g, "").replace(/"[^"\n]*"/g, '""')));

// ── B. REFS per expert ─────────────────────────────────────────────────────
const ids = R.ids();
const robloxExperts = SI.EXPERTS.filter((x) => x.env === "roblox").map((x) => x.id);
ok(`B1 every REFS id is a real expert id (${ids.length} ids, ${SI.IDS.length} experts)`, ids.length >= 15 && ids.every((id) => SI.IDS.includes(id)) && SI.IDS.every((id) => ids.includes(id)), ids.filter((id) => !SI.IDS.includes(id)));
ok(`B2 every Roblox expert has at least 3 docs references (${robloxExperts.length} experts)`, robloxExperts.every((id) => R.refs(id).length >= 3), robloxExperts.filter((id) => R.refs(id).length < 3));
const allRefs = R.all().flatMap((e) => e.refs.map((r) => Object.assign({ id: e.id }, r)));
ok(`B3 ≥ 120 references, every one with a title and an absolute https url (${allRefs.length})`, allRefs.length >= 120 && allRefs.every((r) => r.title && /^https:\/\/[^\s]+$/.test(r.url)));
ok("B4 verified refs live under DOCS_BASE and point at a page (no trailing slash, no anchors, no spaces); only `unverified` ones may leave the Roblox docs", allRefs.every((r) => r.unverified ? !r.url.startsWith(R.DOCS_BASE) : (r.url.startsWith(R.DOCS_BASE) && !/[\s#]/.test(r.url) && !r.url.endsWith("/"))), allRefs.filter((r) => r.unverified ? r.url.startsWith(R.DOCS_BASE) : !(r.url.startsWith(R.DOCS_BASE) && !/[\s#]/.test(r.url) && !r.url.endsWith("/"))).map((r) => r.url));
ok("B5 no duplicate url inside one expert", R.all().every((e) => new Set(e.refs.map((r) => r.url)).size === e.refs.length));
ok("B6 the unverified links are the three Blender ones and nothing else", allRefs.filter((r) => r.unverified).every((r) => r.url.startsWith("https://docs.blender.org/")) && allRefs.filter((r) => r.unverified).length <= 4);
ok(`B7 the unique docs paths are numerous (≥ 100) so the sweep in tools/verify_doc_refs.js means something (${new Set(allRefs.filter((r) => !r.unverified).map((r) => r.url)).size})`, new Set(allRefs.filter((r) => !r.unverified).map((r) => r.url)).size >= 100);
ok("B8 the two general experts carry no Roblox docs (creative_production / general_engineering)", R.refs("creative_production").length === 0 && R.refs("general_engineering").length === 0);
ok("B9 animation refs cover Animator / AnimationTrack / KeyframeSequence / Animation editor", ["Animator", "AnimationTrack", "KeyframeSequence"].every((c) => R.refs("animation").some((r) => r.url.endsWith("/reference/engine/classes/" + c))) && R.refs("animation").some((r) => /animation/.test(r.url) && /editor|studio/.test(r.url)));

// ── C. EXAMPLES ────────────────────────────────────────────────────────────
const allEx = R.all().flatMap((e) => e.examples.map((x) => Object.assign({ id: e.id }, x)));
ok(`C1 ≥ 12 examples spread over ≥ 10 experts (${allEx.length} / ${new Set(allEx.map((x) => x.id)).size})`, allEx.length >= 12 && new Set(allEx.map((x) => x.id)).size >= 10);
ok("C2 every example has title / lang luau / body (≥ 6 lines, ≤ 90 lines)", allEx.every((x) => x.title && x.lang === "luau" && typeof x.body === "string" && x.body.split("\n").length >= 6 && x.body.split("\n").length <= 90));
ok("C3 bodies are plain Luau: no backticks, no `continue`, no compound assignment, no type annotations, no `[[` long strings (so stock Lua parses them and the chat never fences them twice)", allEx.every((x) => !/`/.test(x.body) && !/\bcontinue\b/.test(x.body) && !/[+\-*\/.]=/.test(x.body) && !/\[\[/.test(x.body) && !/:\s*(string|number|boolean)\b\s*[,)=]/.test(x.body)), allEx.filter((x) => /`|\bcontinue\b|[+\-*\/.]=|\[\[/.test(x.body)).map((x) => x.title));
ok("C4 examples never embed asset ids or placeholder uploads (ids come from the user / results)", allEx.every((x) => !/rbxassetid:\/\/\d{3,}/.test(x.body) && !/\b\d{9,}\b/.test(x.body)));
ok("C5 the animation playback example loads through the Animator, caches tracks and cleans up; never Humanoid:LoadAnimation", (() => { const b = R.examples("animation").map((x) => x.body).join("\n"); return /Animator/.test(b) && /LoadAnimation/.test(b) && !/Humanoid:LoadAnimation/.test(b) && /Priority/.test(b) && /(Destroy|Stop)\(/.test(b); })());
ok("C6 the networking example validates on the server (type / rate check before acting)", /typeof|type\(/.test(R.examples("networking").map((x) => x.body).join("\n")) && /OnServerEvent|OnServerInvoke/.test(R.examples("networking").map((x) => x.body).join("\n")));
ok("C7 the data example wraps DataStore calls in pcall with retry and binds close", (() => { const b = R.examples("data_persistence").map((x) => x.body).join("\n"); return /pcall/.test(b) && /BindToClose/.test(b) && /(retry|attempt)/i.test(b); })());

// ── D. render() ────────────────────────────────────────────────────────────
const anim = R.render("animation");
ok("D1 render(animation) = examples section first, then the references section, with the honest framing", anim.indexOf("REFERENCE EXAMPLES (tested patterns") === 0 && anim.includes("nothing here ran") && anim.indexOf("REFERENCES (official documentation") > anim.indexOf("REFERENCE EXAMPLES") && anim.includes("--- " + R.examples("animation")[0].title + " ---"));
ok("D2 every reference renders as '- title — url'", R.refs("animation").every((r) => anim.includes(`- ${r.title} — ${r.url}`)));
ok("D3 render respects the budget: a tiny budget omits examples by name but keeps the links", (() => { const t = R.render("animation", { budget: 10 }); return /further example omitted for length: /.test(t) && t.includes("REFERENCES (official documentation") && !t.includes("local AnimPlayer = {}"); })());
ok("D4 render(id, { examples:false }) is links only; render of an expert without refs is empty; unknown id is empty", !R.render("animation", { examples: false }).includes("REFERENCE EXAMPLES") && R.render("animation", { examples: false }).includes("REFERENCES (official") && R.render("creative_production") === "" && R.render("nope_nothing") === "");
ok("D5 unverified links are labelled in the rendered text", /docs\.blender\.org[^\n]*\(outside Roblox docs; not verified offline\)/.test(R.render("blender_modeling")));
ok("D6 no numeric quality scores anywhere in the module", !/quality score|\/100\b/i.test(src));

// ── E. skill_intel wiring ──────────────────────────────────────────────────
const et = SI.expertText("animation");
ok("E1 expertText(animation) ends with EXAMPLES + REFERENCES and still closes with the guidance-only line", et.includes("REFERENCE EXAMPLES (tested patterns") && et.includes("REFERENCES (official documentation") && et.trimEnd().endsWith("the user's explicit instructions win over any step above.") && et.indexOf("REFERENCES (official") < et.indexOf("This skill is guidance only"));
ok("E2 every Roblox expert's skill output carries the references; the general ones are unchanged", robloxExperts.every((id) => SI.expertText(id).includes("REFERENCES (official documentation")) && !SI.expertText("general_engineering").includes("REFERENCES (official"));
ok("E3 api exposes references(id) / referencesText(id) and they mirror skill_refs", typeof SI.references === "function" && typeof SI.referencesText === "function" && SI.references("animation").refs.length === R.refs("animation").length && SI.referencesText("animation") === R.render("animation"));
ok("E4 skill_intel degrades gracefully when skill_refs is absent (no throw, no section)", (() => { const saved = window.TotalSkillRefs; try { window.TotalSkillRefs = undefined; const t = SI.expertText("animation"); return !t.includes("REFERENCES (official") && t.includes("This skill is guidance only"); } finally { window.TotalSkillRefs = saved; } })());
ok("E5 skill output stays within the chat budget (every expert ≤ 9000 chars)", SI.IDS.every((id) => SI.expertText(id).length <= 9000), SI.IDS.map((id) => id + ":" + SI.expertText(id).length).join(" "));
ok("E6 the `skill` answer path (answer({name})) carries the references too", SI.answer({ name: "animation" }).includes("REFERENCES (official documentation"));

// ── F. mode bias (Animator mode pins the animation expert) ─────────────────
ok("F1 MODE_BIAS.animate boosts animation / cinematics / sfx and nothing else; no bias for creation / blender", SI.MODE_BIAS && JSON.stringify(SI.MODE_BIAS.animate) === JSON.stringify({ animation: 6, cinematics: 3, sfx: 1 }) && !SI.MODE_BIAS.creation && !SI.MODE_BIAS.blender);
{
  const txt = "make the sword swing feel heavier and add a hit sound";
  const plain = SI.select(SI.analyze(txt, { engine: "roblox" }), { max: 2 });
  const biased = SI.select(SI.analyze(txt, { engine: "roblox", mode: "animate" }), { max: 2 });
  const top = (sel) => (sel.picked && sel.picked[0]) || null;
  ok("F2 analyze({mode:'animate'}) makes animation the primary skill (without the mode it is only a weak match) and the ranking says why: 'mode:animate'", top(biased) && top(biased).id === "animation" && top(biased).why.includes("mode:animate") && top(plain) && top(plain).id !== "animation" && !JSON.stringify(plain).includes("mode:"), JSON.stringify({ plain: top(plain) && top(plain).id, biased: top(biased) && top(biased).id }));
  const blenderTxt = SI.select(SI.analyze("model a sword in blender and send it to studio", { engine: "blender", mode: "animate" }), { max: 2 });
  ok("F3 the bias never applies to Blender-engine requests", top(blenderTxt) && top(blenderTxt).id.startsWith("blender_") && !JSON.stringify(blenderTxt).includes("mode:animate"));
}
ok("F4 main.js passes the active work mode into analyze (source)", /TotalSkillIntel\.analyze\(text, \{ engine: activeEngine\(\), task: A\.task, mode: normalizeWorkMode\(window\.__rsWorkMode && window\.__rsWorkMode\(\)\) \}\)/.test(read("src/core/main.js")));

// ── G. load order ──────────────────────────────────────────────────────────
ok("G1 manifest: skill_refs.js loads before gui_standard.js and skill_intel.js in every bundle that has skill_intel (12 bundles)", manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/skill_intel.js")).every((c) => c.js.indexOf("src/core/skill_refs.js") >= 0 && c.js.indexOf("src/core/skill_refs.js") === c.js.indexOf("src/core/gui_standard.js") - 1 && c.js.indexOf("src/core/skill_refs.js") < c.js.indexOf("src/core/skill_intel.js")) && manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/skill_intel.js")).length >= 10);
ok("G2 codecraft.html loads skill_refs.js before gui_standard.js and skill_intel.js", (() => { const h = read("codecraft.html"); return h.indexOf('src="src/core/skill_refs.js"') > 0 && h.indexOf('src="src/core/skill_refs.js"') < h.indexOf('src="src/core/gui_standard.js"') && h.indexOf('src="src/core/skill_refs.js"') < h.indexOf('src="src/core/skill_intel.js"'); })());
ok("G3 skill_intel never executes example text (no eval / Function / loadstring on the refs)", !/\b(eval|new Function|loadstring)\s*\(/.test(intel));
ok("G4 the online checker exists and targets the Roblox/creator-docs repository", fs.existsSync(path.join(ROOT, "tools/verify_doc_refs.js")) && read("tools/verify_doc_refs.js").includes("Roblox/creator-docs"));

console.log(`\n${pass} passed, ${fail} failed`);
