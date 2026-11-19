// Public Skills (2.21.0): user-made SKILLS only - Luau command(s) + triggers +
// knowledge + a verify block, SKILL.md as the canonical shareable format.
// Dependency-free: loads src/core/public_skills.js in a vm with a chrome stub and
// pins the main.js / config.js / manifest / css wiring. Run from the TotalScript root:
//   node tests/test-public-skills.js
// The end-to-end flow (model → public_skill_create → call by name → Public tab)
// is covered by `PUBLIC=1 node tests/core-e2e.js` (jsdom); the verify blocks of
// the Featured pack run against the mocked DataModel in tests/public-pack-sim.py.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra ? "  — " + extra : "")); } };

// ── module in isolation ────────────────────────────────────────────────────
const store = {};
global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb({ ...store }), set: (o) => Object.assign(store, o), remove: (k) => { for (const key of [].concat(k)) delete store[key]; } } }, runtime: { getURL: (p) => p } };
vm.runInThisContext(read("src/core/public_skills.js"), { filename: "public_skills.js" });
const PS = window.PublicSkills;
const SRC = read("src/core/public_skills.js");
ok("module exposes window.PublicSkills; the custom-mode hook window.__rsPublicMode is gone", PS && typeof PS.upsert === "function" && window.__rsPublicMode === undefined && PS.activeMode === undefined && PS.modePrompt === undefined && PS.abilityText === undefined);
ok("module is DOM-free at top level (no document access)", !/^\s*(const|let|var)?\s*\w*\s*=?\s*document\./m.test(SRC));
ok("KINDS is skills-only; legacy kinds are known for migration", Array.isArray(PS.KINDS) && PS.KINDS.length === 1 && PS.KINDS[0] === "skill" && PS.LEGACY_KINDS.includes("ability") && PS.LEGACY_KINDS.includes("mode"));

const reserved = new Set(["part_create", "instance_find", "script_read", "execute_luau"]);
const LANTERN = { kind: "skill", name: "Lantern Row", description: "Places N anchored lanterns next to a target instance.", triggers: ["lantern", "lantern row:3", "street lights"], params: [{ name: "path", type: "string", required: true, description: "parent path" }, { name: "count", type: "int", default: 4 }, { name: "lit", type: "bool", default: true }], luau: "local t = {{path}}\nlocal n = {{count}}\nif {{lit}} then print('lit') end\nreturn {ok=true, placed=n}", knowledge: "## When to use\n- The user wants lamps along a path.\n\n## After running\n- Tell them the lanterns are named Lantern_<i>.", verify: { luau: "local parent = find(args.path)\ncheck(parent, 'parent missing')\nreturn {ok = true, detail = 'parent exists'}", note: "the parent exists" } };
let r = PS.upsert(LANTERN, { source: "ai", reserved });
ok("skill installs; name normalised to snake_case, title kept, kind forced to skill", r.ok && r.item.name === "lantern_row" && r.item.title === "Lantern Row" && r.item.source === "ai" && r.item.kind === "skill", JSON.stringify(r.errors));
ok("param types normalised (int→number, bool→boolean)", r.ok && r.item.params.map((p) => p.type).join(",") === "string,number,boolean");
ok("weighted triggers: 'lantern row:3' → trigger 'lantern row' with weight 3; plain ones weight-less", r.ok && r.item.triggers.includes("lantern row") && r.item.weights["lantern row"] === 3 && r.item.weights.lantern === undefined, JSON.stringify(r.item.triggers) + JSON.stringify(r.item.weights));
ok("knowledge + verify stored verbatim", r.ok && r.item.knowledge.startsWith("## When to use") && r.item.verify.luau.includes("find(args.path)") && r.item.verify.note === "the parent exists");
ok("persisted to chrome.storage.local rsPublicSkills", Array.isArray(store.rsPublicSkills) && store.rsPublicSkills.length === 1);

const built = PS.buildLuau("lantern_row", { path: "Workspace.A", count: "4" });
ok("placeholders become Lua literals and args table is injected", built.code && /local args = \{\["path"\]="Workspace.A",\["count"\]=4,\["lit"\]=true\}/.test(built.code) && /local t = "Workspace.A"\nlocal n = 4\nif true then/.test(built.code), built.err);
ok("skill body is wrapped in pcall and JSON-encodes the returned table", /pcall\(function\(\)/.test(built.code) && /HttpService:JSONEncode\(__res\)/.test(built.code) && /ok = false, error = tostring\(__res\)/.test(built.code));
ok("missing required param → MISSING_PARAMS with the signature", /^ERROR MISSING_PARAMS calling 'lantern_row': path - call it as lantern_row \{path, count\?, lit\?\}/.test(PS.buildLuau("lantern_row", {}).err || ""), PS.buildLuau("lantern_row", {}).err);
ok("bad number → INVALID_PARAMETER", /INVALID_PARAMETER/.test(PS.buildLuau("lantern_row", { path: "x", count: "many" }).err || ""));
ok("disabled skill refuses to run", (PS.setEnabled("lantern_row", false), /disabled/.test(PS.buildLuau("lantern_row", { path: "x" }).err || "")) && (PS.setEnabled("lantern_row", true), true));

// verify block program
const vb = PS.buildVerify("lantern_row", { path: "Workspace.A" }, { ok: true, placed: 4 });
ok("buildVerify injects args + result, the find/attr/check helpers, wraps in pcall and tags verify=true", vb.code && /local args = \{\["path"\]="Workspace.A"/.test(vb.code) && /local result = \{\["ok"\]=true,\["placed"\]=4\}/.test(vb.code) && /local function find\(path\)/.test(vb.code) && /local function attr\(path, name\)/.test(vb.code) && /local function check\(cond, message\)/.test(vb.code) && /verify = true/.test(vb.code) && vb.code.includes("find(args.path)"), vb.err || vb.code);
ok("verify prelude is plain Lua 5.x (no `continue`, no `+=`) so the mocked sim can compile it", !/\bcontinue\b/.test(vb.code) && !/\+=/.test(vb.code));
ok("syntaxCheckLuau bundles command + verify as two loadstring parts", /parts = #srcs/.test(PS.syntaxCheckLuau("lantern_row", { path: "x" }).code) && /"verify"/.test(PS.syntaxCheckLuau("lantern_row", { path: "x" }).code));
ok("a skill without verify → buildVerify NO_VERIFY", (() => { const t = PS.upsert({ kind: "skill", name: "no_verify", description: "a skill with no verify block at all.", luau: "return {ok=true} -- nothing to see here" }); const e = PS.buildVerify("no_verify", {}, null).err; PS.remove("no_verify"); return /NO_VERIFY/.test(e || ""); })());

// verification lifecycle
let ver = PS.verification("lantern_row");
ok("fresh skill is UNVERIFIED (callable, flagged)", ver.state === "unverified" && ver.label === "UNVERIFIED" && PS.isCommand("lantern_row"));
PS.markTested("lantern_row", "syntax", "loadstring OK");
ok("markTested syntax → SYNTAX OK, still flagged UNVERIFIED", PS.verification("lantern_row").state === "syntax" && /UNVERIFIED/.test(PS.verification("lantern_row").flag));
PS.markTested("lantern_row", "run", "ran");
ok("markTested run → RAN (ran OK, verify not passed), flagged UNVERIFIED", PS.verification("lantern_row").state === "ran" && /UNVERIFIED/.test(PS.verification("lantern_row").flag));
PS.markTested("lantern_row", "verified", "parent exists");
ver = PS.verification("lantern_row");
ok("markTested verified → VERIFIED with timestamp, version and detail", ver.state === "verified" && ver.flag === "VERIFIED" && ver.at > 0 && ver.version === 1 && ver.detail === "parent exists");
ok("the tested record is not exported (per-device)", PS.exportObject("lantern_row").item.tested === undefined && !/tested/.test(PS.toSkillMd("lantern_row")));
r = PS.update("lantern_row", { luau: LANTERN.luau + "\n-- v2" }, { reserved });
ok("editing the Luau bumps the version and makes the VERIFIED pass STALE", r.ok && r.item.version === 2 && PS.verification("lantern_row").state === "stale" && /UNVERIFIED/.test(PS.verification("lantern_row").flag));
r = PS.update("lantern_row", { description: "Places N anchored lanterns next to a target instance, now with light." }, { reserved });
ok("a description-only edit keeps the verification state (hash covers code, params, verify)", r.ok && r.item.version === 3 && PS.verification("lantern_row").state === "stale" && PS.codeHash(r.item) === PS.codeHash(PS.find("lantern_row")));
PS.markTested("lantern_row", "verified", "again");
ok("re-testing after the edit restores VERIFIED at the new version", PS.verification("lantern_row").state === "verified" && PS.verification("lantern_row").version === 3);
PS.clearTested("lantern_row");
ok("clearTested drops back to UNVERIFIED", PS.verification("lantern_row").state === "unverified");

// validation failures
const bad = PS.validate({ kind: "skill", name: "part_create", description: "collides with a built-in", luau: "return {ok=true, x={{missing}}}" }, { reserved });
ok("validation rejects built-in name collisions and undeclared placeholders", !bad.ok && bad.errors.some((e) => /collides with a built-in/.test(e)) && bad.errors.some((e) => /\{\{missing\}\}/.test(e)), JSON.stringify(bad.errors));
ok("validation rejects reserved public_skill_ prefix and short descriptions", !PS.validate({ kind: "skill", name: "public_skill_x", description: "short", luau: "return {ok=true} -- long enough body" }).ok);
ok("duplicate names are rejected on create", !PS.validate({ kind: "skill", name: "lantern_row", description: "another one with the same name", luau: "return {ok=true} -- long enough" }).ok);
ok("a definition without Luau is rejected (no kind guessing any more)", !PS.validate({ name: "mystery", description: "no luau, no mandate, no steps here" }).ok);
const abil = PS.validate({ kind: "ability", name: "script_audit", description: "Audit every script for deprecated APIs and fix them.", instructions: "Audit carefully.", steps: ["List scripts", "Fix"] });
ok("kind ability / mode are rejected with a retirement message that says what to do instead", !abil.ok && abil.errors.some((e) => /retired in 2\.21\.0/.test(e) && /knowledge/.test(e) && /verify/.test(e)) && !PS.validate({ kind: "mode", title: "Horror", mandate: "x".repeat(80) }).ok, JSON.stringify(abil.errors));
ok("missing verify block is a WARNING (installs, stays UNVERIFIED) - not an error", (() => { const v = PS.validate({ kind: "skill", name: "warn_only", description: "a skill that forgot its verify block entirely.", luau: "return {ok=true} -- long enough body" }); return v.ok && v.warnings.some((w) => /no verify block/.test(w) && /UNVERIFIED/.test(w)); })());
ok("verify must be Luau that returns / raises (a bare string is rejected)", !PS.validate({ kind: "skill", name: "bad_verify", description: "verify given as something that is not a program.", luau: "return {ok=true} -- body", verify: { luau: "yes it works" } }).ok);

// sub-commands
r = PS.upsert({ kind: "skill", name: "zone_tools", description: "Zone helpers: create a zone and clear every zone.", triggers: ["zone"], params: [{ name: "zone", type: "string", required: true }], luau: "local z = {{zone}}\nreturn {ok=true, zone=z}", commands: [{ name: "zone_clear", description: "Removes every zone part tagged Zone.", params: [], luau: "return {ok=true, cleared=0}" }, { name: "zone_count", description: "Counts the zones.", params: [{ name: "tag", type: "string", default: "Zone" }], luau: "local t = {{tag}}\nreturn {ok=true, count=0, tag=t}" }], verify: { luau: "return {ok=true}" } }, { reserved });
ok("a skill may carry sub-commands; each becomes callable by name", r.ok && PS.isCommand("zone_tools") && PS.isCommand("zone_clear") && PS.isCommand("zone_count") && PS.commandOf("zone_count").cmd.name === "zone_count" && PS.commandOf("zone_count").cmd.main === false && PS.commandOf("zone_tools").cmd.main === true && PS.commandOf("zone_count").item.name === "zone_tools", JSON.stringify(r.errors));
ok("signatures lists main + sub-commands", PS.signatures("zone_tools").join(" | ") === "zone_tools {zone} | zone_clear {} | zone_count {tag?}", PS.signatures("zone_tools").join(" | "));
const subBuilt = PS.buildLuau("zone_count", { tag: "Lava" });
ok("buildLuau on a sub-command resolves its own params and reports the command name", subBuilt.code && /local t = "Lava"/.test(subBuilt.code) && subBuilt.command === "zone_count" && subBuilt.main === false, subBuilt.err);
ok("sub-command names collide like any other name", !PS.validate({ kind: "skill", name: "zone_clear", description: "collides with a sub-command of zone_tools", luau: "return {ok=true} -- body" }).ok && !PS.validate({ kind: "skill", name: "other_thing", description: "its sub-command collides with a built-in", luau: "return {ok=true} -- body", commands: [{ name: "part_create", description: "nope", luau: "return {ok=true}" }] }, { reserved }).ok);

// catalogue / tool entries
const entries = PS.toolEntries();
ok("toolEntries exposes every enabled command (main + sub) with schemas and the UNVERIFIED flag in the description", entries.length === 4 && entries.every((t) => t.publicSkill && t.virtual && t.inputSchema.type === "object") && entries.find((t) => t.name === "lantern_row").inputSchema.required.join() === "path" && entries.every((t) => /UNVERIFIED/.test(t.description)) && /Public skill 'zone_tools' command/.test(entries.find((t) => t.name === "zone_count").description), JSON.stringify(entries.map((t) => t.name)));
PS.markTested("lantern_row", "verified", "x");
ok("a VERIFIED skill's tool entry is flagged VERIFIED instead", /VERIFIED/.test(PS.toolEntries().find((t) => t.name === "lantern_row").description) && !/UNVERIFIED/.test(PS.toolEntries().find((t) => t.name === "lantern_row").description));
PS.clearTested("lantern_row");
ok("twelve public_skill_* management tools (create, from_prompt, list, get, refs, reference, update, delete, enable, test, export, import)", PS.managementTools().length === 12 && ["public_skill_create", "public_skill_from_prompt", "public_skill_list", "public_skill_get", "public_skill_refs", "public_skill_reference", "public_skill_update", "public_skill_delete", "public_skill_enable", "public_skill_test", "public_skill_export", "public_skill_import"].every((n) => PS.managementTools().some((t) => t.name === n)), PS.managementTools().map((t) => t.name).join());
ok("public_skill_test schema has dry_run (default true) and args; public_skill_list has verified filter; enable has no activate", (() => { const T = (n) => PS.managementTools().find((t) => t.name === n).inputSchema.properties; return T("public_skill_test").dry_run && T("public_skill_test").args && T("public_skill_list").verified && !T("public_skill_enable").activate; })());
ok("public_skill_create's definition doc describes luau / triggers / knowledge / verify / commands - no ability or mode", (() => { const d = PS.managementTools().find((t) => t.name === "public_skill_create").description + PS.DEFINITION_DOC; return /verify/.test(d) && /knowledge/.test(d) && /triggers/.test(d) && /commands/.test(d) && !/kind=ability|kind=mode|mandate/.test(d); })());
const block = PS.catalogueBlock({ compact: true });
ok("catalogueBlock lists every signature under a PUBLIC SKILLS header with the verification flag", /^PUBLIC SKILLS - 2 user-made skills \(4 commands\)/.test(block) && /lantern_row \{path, count\?, lit\?\}/.test(block) && /zone_count \{tag\?\}/.test(block) && /UNVERIFIED/.test(block) && block.endsWith("\n\n"), block.slice(0, 200));
ok("catalogueBlock is empty with nothing installed", (() => { const saved = PS.list(); PS.replaceAll([]); const e = PS.catalogueBlock(); PS.replaceAll(saved); return e === ""; })());

// relevance + knowledge rider
const rel = PS.relevant("please add a lantern row along the bridge", 3);
ok("relevant() ranks by weighted triggers (lantern row:3 beats a single hit)", rel.length >= 1 && rel[0].name === "lantern_row" && rel[0].score >= 3, JSON.stringify(rel));
ok("relevant() ignores unrelated requests", PS.relevant("write a datastore wrapper", 3).length === 0);
const rider = PS.knowledgeRider("add a lantern row along the bridge", {});
ok("knowledgeRider returns the matching skill's knowledge + signature + verification flag", /PUBLIC SKILL KNOWLEDGE/.test(rider) && /Lantern Row \(lantern_row/.test(rider) && /When to use/.test(rider) && /lantern_row \{path, count\?, lit\?\}/.test(rider) && /UNVERIFIED/.test(rider), rider.slice(0, 200));
ok("knowledgeRider is empty for unrelated text and shorter when tight", PS.knowledgeRider("write a datastore wrapper", {}) === "" && PS.knowledgeRider("add a lantern row along the bridge", { tight: true }).length <= rider.length);
ok("knowledgeText(name) = the full block (knowledge + commands + verify note)", /the parent exists/.test(PS.knowledgeText("lantern_row")) && /## When to use/.test(PS.knowledgeText("lantern_row")));

// ── SKILL.md (canonical format) ────────────────────────────────────────────
const md = PS.toSkillMd("lantern_row");
ok("toSkillMd: YAML frontmatter (name/title/description/version/author/triggers with weight/params) + # Title + ## Knowledge + ## Command + ```luau + ## Verify", /^---\nname: lantern_row\ntitle: Lantern Row\n/.test(md) && /\nversion: 3\n/.test(md) && /triggers:\n  - lantern\n  - "lantern row: 3"\n/.test(md) && /params:\n  - name: path\n/.test(md) && /\n---\n\n# Lantern Row\n/.test(md) && /## Knowledge\n\n## When to use/.test(md) && /## Command lantern_row\n\nMain command: `lantern_row \{path, count\?, lit\?\}`\n\n```luau\nlocal t = \{\{path\}\}/.test(md) && /## Verify\n\nthe parent exists\n\n```luau\nlocal parent = find\(args\.path\)/.test(md), md);
ok("isSkillMd recognises it; plain prose, a prompt with a heading + Luau fence (Save as-is material) and JSON are not SKILL.md", PS.isSkillMd(md) && !PS.isSkillMd("You are a lighting artist. Always add fog.") && !PS.isSkillMd("# Lamp prompt\nYou place lamps.\n```luau\nreturn {ok = true}\n```") && PS.isSkillMd("# Lamp\n## Knowledge\nx\n## Command lamp\n```luau\nreturn {ok = true}\n```") && !PS.isSkillMd(PS.exportJson("lantern_row")));
const parsed = PS.parseSkillMd(md);
ok("parseSkillMd reads it back: same name, params (types + defaults), triggers + weights, knowledge, luau, verify", parsed.ok && parsed.def.name === "lantern_row" && parsed.def.params.length === 3 && parsed.def.params[1].default === 4 && parsed.def.params[1].type === "number" && parsed.def.params[0].required === true && parsed.def.triggers.includes("lantern row: 3") && parsed.def.knowledge.trim() === PS.find("lantern_row").knowledge.trim() && parsed.def.luau.trim() === PS.find("lantern_row").luau.trim() && parsed.def.verify.luau.includes("find(args.path)") && parsed.def.verify.note === "the parent exists", JSON.stringify(parsed).slice(0, 400));
ok("SKILL.md round-trips byte-identical (export → parse → validate → export)", (() => { const v = PS.validate(parsed.def, { allowDuplicateId: true, installed: [] }); if (!v.ok) return false; const again = PS.toSkillMd(Object.assign(v.item, { version: 3, author: PS.find("lantern_row").author })); return again === md; })());
const mdMulti = PS.toSkillMd("zone_tools");
const parsedMulti = PS.parseSkillMd(mdMulti);
ok("SKILL.md carries sub-commands as extra ## Command sections with their own params", /## Command zone_clear\n/.test(mdMulti) && /## Command zone_count\n\nCounts the zones\.\n\nparams:\n  - name: tag/.test(mdMulti) && parsedMulti.ok && parsedMulti.def.commands.length === 2 && parsedMulti.def.commands[1].name === "zone_count" && parsedMulti.def.commands[1].params[0].default === "Zone", mdMulti);
const HAND_MD = `---
name: Spawn Ring
description: >-
  Spawns a ring of N parts around the origin for quick tests.
triggers: [ring, "spawn ring: 4"]
params:
  - count: number = 6 "how many parts"
  - color: string = "warm"
tags: [props, test]
---

# Spawn Ring

## Knowledge
- Use it when the user wants a quick circle of parts.
- Safe zone: 4 studs around the origin stays empty.

## Command spawn_ring
\`\`\`luau
local n = {{count}}
for i = 1, n do local p = Instance.new('Part') p.Name = 'Ring_' .. i p.Parent = workspace end
return {ok = true, count = n, color = {{color}}}
\`\`\`

## Verify
\`\`\`luau
check(find("Workspace.Ring_1"), "first ring part missing")
return {ok = true}
\`\`\`
`;
{
  const t = PS.parseSkillMd(HAND_MD);
  ok("hand-written SKILL.md: folded description, inline arrays, '- name: type = default \"doc\"' params, weighted trigger, name from the command heading", t.ok && t.def.name === "spawn_ring" && t.def.title === "Spawn Ring" && /quick tests\.$/.test(t.def.description) && t.def.params.length === 2 && t.def.params[0].name === "count" && t.def.params[0].type === "number" && t.def.params[0].default === 6 && t.def.params[0].description === "how many parts" && t.def.params[1].default === "warm" && t.def.triggers.includes("spawn ring: 4") && t.def.tags.join() === "props,test" && /Safe zone: 4 studs/.test(t.def.knowledge) && t.def.verify.luau.includes("Ring_1"), JSON.stringify(t).slice(0, 500));
  const v = PS.validate(t.def);
  ok("parsed hand-written SKILL.md validates with weight 4 on 'spawn ring'", v.ok && v.item.weights["spawn ring"] === 4, (v.errors || []).join("; "));
  const imp = PS.importShared(HAND_MD, { reserved: new Set() });
  ok("importShared accepts SKILL.md text", imp.ok && imp.item && imp.item.name === "spawn_ring" && imp.item.source === "import" && PS.isCommand("spawn_ring"), JSON.stringify(imp.errors));
  ok("fileName is <name>.SKILL.md; JSON stays available as <name>.skill.orskill.json; exportText === toSkillMd", PS.fileName("spawn_ring") === "spawn_ring.SKILL.md" && PS.jsonFileName("spawn_ring") === "spawn_ring.skill.orskill.json" && PS.exportText("spawn_ring") === PS.toSkillMd("spawn_ring"));
  ok("parseYamlLite reads '- safe zone: 4' as a scalar entry and '- name: zone' as a mapping", (() => { const a = PS.parseYamlLite("- safe zone: 4\n- plain"); const b = PS.parseYamlLite("- name: zone\n  type: string"); return Array.isArray(a) && a[0] === "safe zone: 4" && a[1] === "plain" && Array.isArray(b) && b[0].name === "zone" && b[0].type === "string"; })());
  PS.remove("spawn_ring");
}
{
  const p = PS.parseText("You are a senior Roblox lighting artist. Always set up atmosphere first.\nNever leave default lighting. Verify with a screenshot.");
  ok("parseText flags free prose as a prompt", !p.ok && p.prompt === true && typeof p.text === "string");
  const s = PS.importShared("Please make every build you do clean and verified, always.", { reserved: new Set() });
  ok("importShared reports prompt:true for prose instead of 'unrecognised'", !s.ok && s.prompt === true && /prompt, not a skill file/.test(s.errors[0]));
  const legacyTxt = "# Lantern Line\nkind: skill\ndescription: Places N lanterns with warm PointLights along the selected path.\nparams: count:number=4 \"how many\"\n\n--- luau ---\nlocal n = {{count}}\nprint(n)\n";
  const t = PS.importShared(legacyTxt, { reserved: new Set() });
  ok("legacy .txt skills still import (and warn that there is no verify block)", t.ok && t.item.name === "lantern_line" && t.item.params[0].default === 4 && t.warnings.some((w) => /verify/.test(w)), JSON.stringify(t.errors));
  PS.remove("lantern_line");
  const legacyAbility = PS.importShared("# Tidy Up\nkind: ability\ndescription: Cleans the workspace before publishing a place.\n--- steps ---\n1. Delete stray parts\n2. Group props\n");
  ok("legacy .txt ability without Luau is refused with the retirement message", !legacyAbility.ok && legacyAbility.errors.some((e) => /retired in 2\.21\.0/.test(e)), JSON.stringify(legacyAbility.errors));
}

// ── prompt → skill (2.21.0: the AI designs it; prompt = knowledge) ────────
{
  const PROMPT = "# Boss Arena Builder\nYou build circular boss arenas in Roblox Studio.\n\n1. Create a 120-stud circular floor with a neon ring.\n2. Add four pillars and a raised throne platform.\n3. Place spawn locations at the four compass points.\n4. Verify with a screenshot.";
  ok("looksLikeFullPrompt: long/multi-line yes, short description no", PS.looksLikeFullPrompt(PROMPT) && !PS.looksLikeFullPrompt("a skill that adds lanterns"));
  const f = PS.fromPrompt(PROMPT, { reserved: new Set() });
  ok("fromPrompt (no AI) on a prose prompt → needsAi, never an ability", !f.ok && f.needsAi === true && f.errors.some((e) => /Design a skill from it/.test(e)) && !PS.isCommand("boss_arena_builder"), JSON.stringify(f));
  const sk = PS.fromPrompt("Spawn ring\nUse this when the user wants a ring of parts.\n```lua\nlocal n = {{count}}\nfor i = 1, n do local p = Instance.new('Part') p.Parent = workspace end\n```", {});
  ok("fromPrompt with fenced Luau → skill: Luau = command, prose = knowledge, {{count}} param, no-verify warning", sk.ok && sk.def.kind === "skill" && sk.def.params.length === 1 && sk.def.params[0].name === "count" && /Instance\.new/.test(sk.def.luau) && /ring of parts/.test(sk.def.knowledge) && PS.validate(sk.def).ok && sk.warnings.some((w) => /verify/.test(w)), JSON.stringify(sk).slice(0, 300));
  ok("fromPrompt rejects tiny text", !PS.fromPrompt("hi there").ok);
  const inst = PS.installFromPrompt("Torch line\n```luau\nlocal n = {{count}}\nreturn {ok=true, n=n}\n```", { reserved: new Set(), source: "manual" });
  ok("installFromPrompt installs the Luau-bearing prompt as a callable, UNVERIFIED skill", inst.ok && inst.item.kind === "skill" && PS.isCommand("torch_line") && PS.verification("torch_line").state === "unverified", JSON.stringify(inst.errors));
  PS.remove("torch_line");
  const cp = PS.conversionPrompt(PROMPT, "skill", { commandNames: ["create_part", "set_lighting"] });
  ok("conversionPrompt = DESIGN BRIEF: prompt verbatim becomes knowledge, AI writes Luau + verify, submits via public_skill_create, then tests", /\(DESIGN BRIEF\)/.test(cp) && cp.includes("<<<PROMPT\n" + PROMPT + "\nPROMPT>>>") && /knowledge/.test(cp) && /verify/.test(cp) && /public_skill_create/.test(cp) && /public_skill_test/.test(cp) && /create_part, set_lighting/.test(cp) && !/mandate|kind=ability|kind=mode/.test(cp), cp.slice(0, 300));
  ok("conversionPrompt accepts a preferred title / name", /Boss Arena Builder/.test(PS.conversionPrompt(PROMPT, "skill", { title: "Boss Arena Builder", name: "boss_arena" })) && /boss_arena/.test(PS.conversionPrompt(PROMPT, "skill", { title: "Boss Arena Builder", name: "boss_arena" })));
  const gp = PS.generationPrompt("a skill that paints selected parts red", "skill", { commandNames: ["part_create", "instance_find"] });
  ok("generationPrompt tells the model to submit via public_skill_create with luau + triggers + knowledge + verify and lists installed names", /public_skill_create/.test(gp) && /verify/.test(gp) && /knowledge/.test(gp) && /triggers/.test(gp) && /lantern_row/.test(gp) && /DEFINITION OBJECT/.test(gp) && /part_create, instance_find/.test(gp) && !/KIND: decide yourself|kind=mode/.test(gp), gp.slice(0, 200));
}

// ── sharing ────────────────────────────────────────────────────────────────
const json = PS.exportJson("lantern_row");
const exp = JSON.parse(json);
ok("JSON export is a tagged totalscript-public-skill document without device state", exp.format === "totalscript-public-skill" && exp.item.name === "lantern_row" && exp.item.enabled === undefined && exp.item.createdAt === undefined && exp.item.tested === undefined);
const code = PS.shareCode("lantern_row");
ok("share code is ORSKILL2:<base64 of the SKILL.md>", /^ORSKILL2:[A-Za-z0-9+/=]+$/.test(code) && Buffer.from(code.slice(9), "base64").toString("utf8") === md.replace(/\nversion: 3\n/, "\nversion: 3\n"));
ok("import of a duplicate is refused unless replace", !PS.importShared(code).ok && PS.importShared(code).duplicate.name === "lantern_row" && PS.importShared(code, { replace: true }).ok);
ok("import after delete reinstalls from the share code with source=import and UNVERIFIED", (PS.remove("lantern_row"), (() => { const i = PS.importShared(code); return i.ok && i.item.source === "import" && i.item.name === "lantern_row" && PS.verification("lantern_row").state === "unverified"; })()));
ok("legacy ORSKILL1 JSON codes and .orskill.json files still import", (() => { const legacy = "ORSKILL1:" + Buffer.from(json, "utf8").toString("base64"); PS.remove("lantern_row"); const a = PS.importShared(legacy); const nameA = a.ok && a.item.name; PS.remove("lantern_row"); const b = PS.importShared(json); return nameA === "lantern_row" && b.ok && b.item.name === "lantern_row"; })());
ok("garbage import is rejected cleanly", !PS.importShared("ORSKILL2:!!!").ok && !PS.importShared("ORSKILL1:!!!").ok && !PS.importShared("{not json").ok && !PS.importShared(JSON.stringify({ hello: 1 })).ok);

// pack sharing (Export all / Import)
const pack = JSON.parse(PS.exportPackJson());
ok("exportPackJson bundles every installed item", pack.format === "totalscript-public-skill-pack" && pack.count === PS.list().length && pack.items.every((i) => i.kind === "skill" && i.name));
const packText = PS.exportPackText();
ok("exportPackText = SKILLS.md: every SKILL.md joined by the pack separator; packFileName ends .SKILLS.md; code is ORSKILL2", packText.split(PS.PACK_SEPARATOR).length === pack.count && /^totalscript-public-skills-\d{4}-\d{2}-\d{2}\.SKILLS\.md$/.test(PS.packFileName()) && /\.orskills\.json$/.test(PS.packJsonFileName()) && /^ORSKILL2:/.test(PS.packShareCode()));
const packCode = PS.packShareCode();
let imp = PS.importShared(packCode);
ok("importing a pack over existing items reports them as skipped", imp.pack && imp.installed.length === 0 && imp.skipped.length === pack.count, JSON.stringify(imp).slice(0, 160));
ok("pack import with replace reinstalls everything", PS.importShared(packCode, { replace: true }).installed.length === pack.count && PS.list().length === pack.count);
ok("SKILLS.md text, a JSON pack and a bare array all import into an empty registry", (() => { const saved = PS.list(); let good = true; for (const t of [packText, JSON.stringify(pack), JSON.stringify(pack.items)]) { PS.replaceAll([]); const r = PS.importShared(t); good = good && r.pack && r.installed.length === pack.count && PS.list().length === pack.count; } PS.replaceAll(saved); return good; })());

// ── migration (2.21.0) ─────────────────────────────────────────────────────
{
  const legacy = [
    { id: "a1", kind: "skill", name: "keep_me", description: "an ordinary skill that must survive migration.", luau: "return {ok=true} -- survive", version: 2 },
    { id: "a2", kind: "ability", name: "ring_proc", title: "Ring Procedure", description: "A procedure whose instructions contain Luau to run.", params: [{ name: "count", type: "number", default: 3 }], instructions: "Place a ring of parts.\n```lua\nlocal n = {{count}}\nfor i = 1, n do Instance.new('Part').Parent = workspace end\nreturn {ok=true}\n```\nThen tell the user.", steps: ["Run the Luau", "Report"], version: 1 },
    { id: "a3", kind: "ability", name: "tidy_up", title: "Tidy Up", description: "A pure-prompt procedure without any Luau in it.", instructions: "Audit the workspace and delete stray parts.", steps: ["List", "Delete"] },
    { id: "a4", kind: "mode", name: "horror_builder", title: "Horror Builder", badge: "HORROR", base: "creation", description: "Dread: fog, flicker, low light, sound.", mandate: "You are a horror ambience specialist. ".repeat(4) },
  ];
  const m = PS.migrateStored(legacy);
  ok("migrateStored keeps skills, converts the Luau-bearing ability, drops the prompt-only ability and the mode", m.items.length === 2 && m.items[0].name === "keep_me" && m.converted.length === 1 && m.converted[0].name === "ring_proc" && m.dropped.length === 2 && m.dropped.map((d) => d.kind).sort().join() === "ability,mode", JSON.stringify({ items: m.items.map((i) => i.name), c: m.converted, d: m.dropped }));
  const conv = m.items[1];
  ok("converted ability: Luau → command, prose → knowledge, params kept, history note, id preserved", conv.kind === "skill" && conv.id === "a2" && /Instance\.new/.test(conv.luau) && /Place a ring of parts/.test(conv.knowledge) && !/```/.test(conv.knowledge) && conv.params[0].name === "count" && conv.history.some((h) => /converted from an ability/.test(h.note)), JSON.stringify(conv).slice(0, 400));
  ok("dropped items carry a reason and their original JSON is archived for download", m.dropped.every((d) => d.reason && d.title) && m.archive.length === 2 && m.archive[0].name === "tidy_up" && m.archive[1].kind === "mode");
  ok("migrationNotice is null before any load; migrationArchiveJson null too", PS.migrationNotice() === null && PS.migrationArchiveJson() === null);
  // real load() path through the chrome stub (fresh module instance below)
  store.rsPublicSkills = legacy; store.rsPublicMode = "a4";
}
(async () => {
  const ctx = { chrome: global.chrome, console, setTimeout, clearTimeout, Buffer, Date, JSON, Math };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.runInNewContext(SRC, ctx, { filename: "public_skills.js" });
  const PS2 = ctx.PublicSkills;
  await PS2.load();
  const notice = PS2.migrationNotice();
  ok("load() migrates stored legacy items once, records the notice (converted + dropped) and removes rsPublicMode", PS2.list().length === 2 && notice && notice.version === "2.21.0" && notice.converted.length === 1 && notice.dropped.length === 2 && notice.archived === 2 && store.rsPublicMode === undefined && store.rsPublicSkillsMigration && store.rsPublicSkillsMigration.archive.length === 2, JSON.stringify(notice));
  ok("migrationArchiveJson is a downloadable document with the dropped originals", (() => { const a = JSON.parse(PS2.migrationArchiveJson()); return a.format === "totalscript-public-skill-archive" && a.items.length === 2 && a.items.some((i) => i.kind === "mode"); })());
  PS2.dismissMigration();
  ok("dismissMigration hides the notice and clears the stored record (one-time notice)", PS2.migrationNotice() === null && store.rsPublicSkillsMigration === undefined && PS2.migrationArchiveJson() === null);
  ok("the converted skill is callable in the new instance and the main command of the kept skill too", PS2.isCommand("ring_proc") && PS2.isCommand("keep_me") && !PS2.isCommand("horror_builder") && !PS2.isCommand("tidy_up"));

  // change events
  let events = 0; const off = PS.onChange(() => events++); PS.setEnabled("zone_tools", false); PS.setEnabled("zone_tools", true); off();
  ok("onChange fires on toggles and can be unsubscribed", events === 2);

  // ── wiring pins ────────────────────────────────────────────────────────────
  const main = read("src/core/main.js");
  const config = read("src/core/config.js");
  const css = read("overlay.css");
  const intel = read("src/core/skill_intel.js");
  const manifest = JSON.parse(read("manifest.json"));
  const bundles = manifest.content_scripts.filter((c) => (c.js || []).includes("src/core/main.js"));
  ok("manifest loads public_skills.js before main.js in every main.js bundle", bundles.length > 0 && bundles.every((c) => { const i = c.js.indexOf("src/core/public_skills.js"); return i >= 0 && i < c.js.indexOf("src/core/main.js") && i > c.js.indexOf("src/core/config.js"); }));
  ok("runTool routes public_skill_* and installed public commands", main.includes('if (toolName.startsWith("public_skill_")) return await runPublicSkillTool(toolName, args);') && main.includes('if (typeof PublicSkills !== "undefined" && PublicSkills.isCommand(toolName))'));
  ok("legacy public_item_* hook now resolves to a real dispatcher", /function dispatchPublicItemTool\(name, args\)/.test(main) && main.includes("typeof dispatchPublicItemTool === \"function\""));
  ok("public skills execute through execute_luau with the TotalScript-internal flag and relabelled output", /runPublicSkill[\s\S]{0,1400}tool: "execute_luau", arguments: \{ code: built\.code, datamodel_type: "Edit", _totalInternal: true \}/.test(main));
  ok("runPublicSkill is sub-command aware (built.command → cmdName) and reports through __rsBeforeTool/__rsAfterTool", /runPublicSkill[\s\S]{0,800}const cmdName = built\.command \|\| item\.name/.test(main) && /runPublicSkill[\s\S]{0,2400}window\.__rsBeforeTool\(cmdName, args\)/.test(main) && /window\.__rsAfterTool\(cmdName, args, ok, res\)/.test(main));
  ok("testPublicSkill: dry_run → syntaxCheckLuau + markTested('syntax'); real run → RUN_FAILED / RAN_UNVERIFIED / VERIFY_FAILED / VERIFIED via buildVerify + markTested('verified')", /async function testPublicSkill\(name, args, io\)/.test(main) && /PS\.syntaxCheckLuau\(ref, args\.args \|\| \{\}\)/.test(main) && /PS\.markTested\(item\.id, "syntax"/.test(main) && /PS\.buildVerify\(/.test(main) && /status: "VERIFY_FAILED"/.test(main) && /status: "RAN_UNVERIFIED"/.test(main) && /io\.fail\("RUN_FAILED"/.test(main) && /PS\.markTested\(item\.id, "verified"/.test(main) && /status: "VERIFIED"/.test(main));
  ok("the test never marks VERIFIED without a passing verify result (ok === true on the parsed verify JSON)", /const vj = PS\.parseResult\(vres\);[\s\S]{0,900}if \(vj\.ok !== true \|\| vj\.verify !== true\) \{[\s\S]{0,600}status: "VERIFY_FAILED"/.test(main) && /PS\.markTested\(item\.id, "verified"/.test(main));
  ok("public_skill_test op calls testPublicSkill; create → verification + next; list supports {verified}; get returns knowledge_block; enable has no activate", main.includes('if (op === "test") return await testPublicSkill(') && /op === "create"[\s\S]{0,1600}verification: ver\.state/.test(main) && /op === "list"[\s\S]{0,600}args\.verified/.test(main) && /op === "get"[\s\S]{0,900}knowledge_block/.test(main) && !/activate: !!args\.activate/.test(main));
  ok("public_skill_from_prompt returns a DESIGN_BRIEF built by conversionPrompt (prompt → knowledge; AI writes Luau + verify)", /op === "from_prompt"[\s\S]{0,1200}PS\.conversionPrompt\(text, "skill"[\s\S]{0,300}status: "DESIGN_BRIEF", installed: false/.test(main));
  ok("public_skill_export returns skillMd + fileName (SKILL.md) with JSON secondary; 'all' returns skillsMd", /skillMd: PS\.toSkillMd\(/.test(main) && /fileName: PS\.fileName\(/.test(main) && /jsonFileName: PS\.jsonFileName\(/.test(main) && /skillsMd: PS\.exportPackText\(\)/.test(main));
  ok("catalogue injects management tools + user commands and refreshes on change", main.includes("[...PublicSkills.managementTools(), ...PublicSkills.toolEntries()]") && /function refreshPublicSkillTools\(\)/.test(main));
  ok("buildCatalogue appends the PUBLIC SKILLS block to the universal tier (pinned return untouched)", main.includes("const pub = PublicSkills.catalogueBlock({ compact });") && main.includes("universalBlock += pub;"));
  ok("knowledge rider: a matching public skill's knowledge rides on the first tool result (budgeted, diag'd)", /PublicSkills\.knowledgeRider\(reqText, \{ tight \}\)/.test(main) && /diag\("publicSkill\.knowledgeSent"/.test(main) && /diag\("publicSkill\.knowledgeSkipped"/.test(main));
  ok("custom work modes are gone from main.js: no pm:<id> layering, no custom cards, stale pm: ids fall back with a toast", !main.includes("workMode = normalizeWorkMode(custom ? custom.base : id);") && !main.includes("rs-work-card rs-work-custom") && !main.includes('data-work="pm:${m.id}"') && !/customFocus\.has\(/.test(main) && /id\.startsWith\("pm:"\)\) \{ toast\("Custom work modes were retired in 2\.21\.0/.test(main) && !/__rsPublicMode/.test(main) && !/PublicSkills\.(activeMode|setActiveMode|modePrompt|abilityText|modes)\(/.test(main));
  ok("Public tab: verification filter chips (All / Verified / Unverified), verify badge per row, Test in Studio + Run + Improve actions, SKILL.md export", /pchip\("verified", "Verified"/.test(main) && /pchip\("unverified", "Unverified"/.test(main) && /rs-public-verify rs-public-verify-\$\{escRs\(v\.state\)\}/.test(main) && main.includes('data-public-action="test" title="Run it in Studio and then its verify block; marks VERIFIED on a pass">Test in Studio</button>') && main.includes('data-public-action="run">Run…</button>') && main.includes('data-public-action="export">Export SKILL.md</button>') && !/data-public-filter="(skill|ability|mode)"/.test(main) && !/id="rs-public-kind"/.test(main));
  ok("Public tab card actions: test → publicTest (public_skill_test dry_run:false through runLibraryCard), no activate", /function publicTest\(item\)/.test(main) && /publicTest[\s\S]{0,900}public_skill_test \{"name":"\$\{item\.name\}","dry_run":false/.test(main) && main.includes('else if(act==="test")publicTest(item);') && !/act==="activate"/.test(main));
  ok("migration banner: rendered from PublicSkills.migrationNotice() with download / dismiss handlers", /PS\.migrationNotice\(\) : null/.test(main) && main.includes('data-public-migration="download"') && main.includes('data-public-migration="dismiss"') && main.includes("PublicSkills.migrationArchiveJson()") && main.includes("PublicSkills.dismissMigration()"));
  ok("Public tab has a Share box: import file/code, paste code, export all (SKILLS.md), share-all code", main.includes("rs-public-sharebox") && main.includes("[data-public-export-all]") && main.includes("[data-public-share-all]") && main.includes("PublicSkills.exportPackText()") && main.includes('type:"text/markdown"'));
  ok("public_skill_export accepts name='all' and public_skill_import handles packs", main.includes("if (/^(all|\\*|everything)$/i.test(ref))") && main.includes("if (r.pack) { for (const it of r.installed) announce("));
  ok("cards panel has a Public tab with composer, import and per-item actions", main.includes('data-tab="public">Public') && /function publicHtml\(\)/.test(main) && main.includes('id="rs-public-prompt"') && main.includes("[data-public-create]") && main.includes("[data-public-import]"));
  ok("Create button: SKILL.md paste → import; full prompt → design brief (conversionPrompt); description → generationPrompt", /PublicSkills\.isSkillMd\(text\)\)\{publicImportText\(text/.test(main) && /if \(how === "convert"\) return PublicSkills\.conversionPrompt\(text, kind, \{ commandNames: publicCommandSample\(\) \}\);/.test(main) && /prompt:publicGenerationPrompt\(text,publicKind\)\},true\)/.test(main));
  ok("Save as-is only when the text carries Luau (needsAi toast otherwise); downloads: SKILL.md primary (publicDownload), JSON secondary", /r\.needsAi \? "No Luau in that text/.test(main) && /function publicDownload\(id\)\{ const PS = PublicSkills; const txt = PS\.toSkillMd\(id\)/.test(main) && /a\.download = PS\.jsonFileName\(id\)/.test(main));
  ok("install results open a review modal with verify badge + Test in Studio", main.includes('new CustomEvent("total-public-skill-result"') && /function showPublicInstalled\(detail\)/.test(main) && main.includes("data-public-installed-test") && /rs-public-verify rs-public-verify-\$\{escRs\(ver\.state\)\}/.test(main));
  ok("hand-made editor exists with a single skill skeleton carrying triggers / knowledge / verify", /function openPublicEditor\(item, kind\)/.test(main) && /PUBLIC_SKELETONS = \{\s*skill:/.test(main) && !/ability: \{ kind: "ability"/.test(main) && !/mode: \{ kind: "mode"/.test(main) && /PUBLIC_SKELETONS[\s\S]{0,1600}verify: \{ luau:/.test(main));
  ok("ui-closure vars used by early init are hoisted (no TDZ)", main.includes("var publicEditorEl = null, openCardsPanel = null, openTrayFn = null, closeCardsWindowFn = null;") && main.includes('var publicDraft = "", publicKind = "skill";'));
  ok("import: prose files load into the composer; file picker accepts .md / SKILL.md first", main.includes("if (!r.ok && r.prompt) {") && main.includes('input.accept = ".md,.SKILL.md,.SKILLS.md,.json,.orskill.json,.orskills.json,.txt,text/plain,text/markdown,application/json"'));
  ok("totalscript_help publicskills topic explains skills-only, SKILL.md, verify states and the migration", /publicskills:\{title:"Public Skills"/.test(main) && /2\.21\.0: skills only/.test(main) && /SKILL\.md \(canonical, shareable\)/.test(main) && /VERIFIED \/ VERIFY_FAILED \/ RUN_FAILED/.test(main) && /Migration \(2\.21\.0\)/.test(main) && !/Plain-text format \(\.txt\)/.test(main));
  ok("config.js: PUBLIC SKILLS block (tight + full) teaches luau/triggers/knowledge/verify + VERIFIED semantics; no mode mandate, no ability", config.includes("━━━ PUBLIC SKILLS (ALL PROVIDERS) ━━━") && config.includes("━━━ PUBLIC SKILLS ━━━") && /`verify` = \{luau\}/.test(config) && /flagged UNVERIFIED/.test(config) && /DESIGN BRIEF/.test(config) && !config.includes("PublicSkills.modePrompt") && !config.includes("__rsPublicMode") && !/kind=ability|kind=mode|Custom work modes available/.test(config));
  ok("config.js installed list tags each public skill [VERIFIED] / [UNVERIFIED]", /PS\.verification\(i\)[\s\S]{0,120}\[VERIFIED\]" : " \[UNVERIFIED\]"/.test(config));
  ok("the Notion 'preferences' bootstrap is gone with the provider (2.21.0); every provider gets the one PUBLIC SKILLS block", !/buildNotionPreferences|PUBLIC SKILLS preference:/.test(config) && !/providerId === "notion"/.test(config));
  ok("skill_intel ranks public skills with trigger weights and skips anything that is not a skill", /it\.kind && it\.kind !== "skill"\)\) continue/.test(intel) && /score \+= 3 \* wOf\(w\)/.test(intel) && /score \+= 4 \* wOf\(p\)/.test(intel));
  ok("overlay.css styles the Public tab, verify badges (verified / stale / ran / syntax / unverified) and the migration banner; kind-mode / ability / active-mode styles removed", css.includes(".rs-public-compose") && css.includes(".rs-public-verify-verified") && css.includes(".rs-public-verify-stale") && css.includes(".rs-public-verify-unverified") && css.includes(".rs-public-migration") && css.includes(".rs-public-editor") && !css.includes(".rs-public-kind-mode") && !css.includes(".rs-public-kind-ability") && !css.includes(".rs-public-active") && !css.includes(".rs-work-card.rs-work-custom") && !/--cp-ability|--cp-mode/.test(css));
  ok("popup work-mode literal untouched by public skills (built-in ids only)", read("popup.js").includes('const WORK_MODES = ["creation", "blender", "animate", "blockbench"]'));
  ok("module version is 2.21.0 and documents the shape in its header", PS.VERSION === "2.21.0" && /SKILL\.md/.test(SRC.slice(0, 4000)) && /VERIFY/.test(SRC.slice(0, 4000)));

  console.log(`\n${pass} passed, ${fail} failed`);
})();
