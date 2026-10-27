// Public Skills (1.25.0): user-made skills / abilities / work modes.
// Dependency-free: loads src/core/public_skills.js in a vm with a chrome stub and
// pins the main.js / config.js / manifest wiring. Run from the TotalScript root:
//   node tests/test-public-skills.js
// The end-to-end flow (model → public_skill_create → call by name → custom mode
// badge → Public tab) is covered by `PUBLIC=1 node tests/notion-e2e.js` (jsdom).
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
global.chrome = { storage: { local: { get: (k, cb) => cb({ ...store }), set: (o) => Object.assign(store, o) } }, runtime: { getURL: (p) => p } };
vm.runInThisContext(read("src/core/public_skills.js"), { filename: "public_skills.js" });
const PS = window.PublicSkills;
ok("module exposes window.PublicSkills and window.__rsPublicMode", PS && typeof PS.upsert === "function" && typeof window.__rsPublicMode === "function");
ok("module is DOM-free at top level (no document access)", !/^\s*(const|let|var)?\s*\w*\s*=?\s*document\./m.test(read("src/core/public_skills.js")));

const reserved = new Set(["part_create", "instance_find", "script_read", "execute_luau"]);
let r = PS.upsert({ kind: "skill", name: "Lantern Row", description: "Places N anchored lanterns next to a target instance.", params: [{ name: "path", type: "string", required: true, description: "parent path" }, { name: "count", type: "int", default: 3 }, { name: "lit", type: "bool", default: true }], luau: "local t = {{path}}\nlocal n = {{count}}\nif {{lit}} then print('lit') end\nreturn {ok=true, n=n, t=t, a=args.count}" }, { source: "ai", reserved });
ok("skill installs; name normalised to snake_case, title kept", r.ok && r.item.name === "lantern_row" && r.item.title === "Lantern Row" && r.item.source === "ai", JSON.stringify(r.errors));
ok("param types normalised (int→number, bool→boolean)", r.ok && r.item.params.map((p) => p.type).join(",") === "string,number,boolean");
ok("persisted to chrome.storage.local rsPublicSkills", Array.isArray(store.rsPublicSkills) && store.rsPublicSkills.length === 1);

const built = PS.buildLuau("lantern_row", { path: "Workspace.A", count: "4" });
ok("placeholders become Lua literals and args table is injected", built.code && /local args = \{\["path"\]="Workspace.A",\["count"\]=4,\["lit"\]=true\}/.test(built.code) && /local t = "Workspace.A"\nlocal n = 4\nif true then/.test(built.code), built.err || built.code.slice(0, 200));
ok("skill body is wrapped in pcall and JSON-encodes the returned table", /pcall\(function\(\)/.test(built.code) && /HttpService:JSONEncode\(__res\)/.test(built.code) && /ok = false, error = tostring\(__res\)/.test(built.code));
ok("missing required param → MISSING_PARAMS with the signature", /^ERROR MISSING_PARAMS calling 'lantern_row': path - call it as lantern_row \{path, count\?, lit\?\}/.test(PS.buildLuau("lantern_row", {}).err || ""), PS.buildLuau("lantern_row", {}).err);
ok("bad number → INVALID_PARAMETER", /INVALID_PARAMETER/.test(PS.buildLuau("lantern_row", { path: "x", count: "many" }).err || ""));
ok("disabled skill refuses to run", (PS.setEnabled("lantern_row", false), /disabled/.test(PS.buildLuau("lantern_row", { path: "x" }).err || "")) && (PS.setEnabled("lantern_row", true), true));

// validation failures
const bad = PS.validate({ kind: "skill", name: "part_create", description: "collides with a built-in", luau: "return {ok=true, x={{missing}}}" }, { reserved });
ok("validation rejects built-in name collisions and undeclared placeholders", !bad.ok && bad.errors.some((e) => /collides with a built-in/.test(e)) && bad.errors.some((e) => /\{\{missing\}\}/.test(e)), JSON.stringify(bad.errors));
ok("validation rejects reserved public_skill_ prefix and short descriptions", !PS.validate({ kind: "skill", name: "public_skill_x", description: "short", luau: "return {ok=true} -- long enough body" }).ok);
ok("duplicate names are rejected on create", !PS.validate({ kind: "skill", name: "lantern_row", description: "another one with the same name", luau: "return {ok=true} -- long enough" }).ok);
ok("unknown kind is rejected", !PS.validate({ name: "mystery", description: "no luau, no mandate, no steps here" }).ok);

// ability
r = PS.upsert({ kind: "ability", name: "script_audit", description: "Audit every script for deprecated APIs and fix them.", params: [{ name: "scope", type: "string", default: "game" }], instructions: "Audit {{scope}} carefully.", steps: ["List scripts with script_list", "Read each with script_read", "Fix with script_set_source"], commands: ["script_read", "no_such_cmd"] }, { reserved });
ok("ability installs with a warning for unknown commands", r.ok && r.warnings.some((w) => /no_such_cmd/.test(w)), JSON.stringify(r.errors.concat(r.warnings)));
const ab = PS.abilityText("script_audit", {});
ok("ability call returns instructions with defaults filled in", ab.text && /ABILITY 'script_audit'/.test(ab.text) && /Audit game carefully/.test(ab.text) && /1\. List scripts/.test(ab.text) && /nothing has been executed yet/.test(ab.text), ab.err || ab.text);

// mode
r = PS.upsert({ kind: "mode", title: "Horror Builder", badge: "horror!!", base: "visualizer", description: "Dread: fog, flicker, low light, sound.", mandate: "You are a horror ambience specialist. Every scene needs Atmosphere fog, low ambient light, a flickering light and a sound layer; verify with a screenshot after each pass.", focus: ["execute_luau", "fx_fog"] }, { reserved });
ok("mode installs: snake name from title, badge sanitised, legacy base migrates to creation (1.39.0)", r.ok && r.item.name === "horror_builder" && r.item.badge === "HORROR" && r.item.base === "creation", JSON.stringify(r.errors));
ok("mode with a short mandate is rejected", !PS.validate({ kind: "mode", title: "Tiny", mandate: "too short" }).ok);
ok("activeMode is null until set; setActiveMode persists rsPublicMode", PS.activeMode() === null && PS.setActiveMode("horror_builder").name === "horror_builder" && store.rsPublicMode === r.item.id && window.__rsPublicMode().title === "Horror Builder");
const mp = PS.modePrompt();
ok("modePrompt layers the mandate on the base mode and lists focus commands", /CUSTOM WORK MODE: HORROR BUILDER/.test(mp) && /layered on TOTALITY/.test(mp) && /FOCUS COMMANDS[^\n]*execute_luau, fx_fog/.test(mp), mp.slice(0, 120));
ok("disabling the active mode deactivates it", (PS.setEnabled("horror_builder", false), PS.activeMode() === null) && (PS.setEnabled("horror_builder", true), true));
ok("modes are not commands", !PS.isCommand("horror_builder") && PS.isCommand("lantern_row") && PS.isCommand("script_audit"));

// catalogue / tool entries
const entries = PS.toolEntries();
ok("toolEntries exposes enabled skills+abilities (not modes) with schemas", entries.length === 2 && entries.every((t) => t.publicSkill && t.virtual && t.inputSchema.type === "object") && entries.find((t) => t.name === "lantern_row").inputSchema.required.join() === "path" && entries.find((t) => t.name === "lantern_row").server === "roblox" && entries.find((t) => t.name === "script_audit").server === "totalscript");
ok("ten public_skill_* management tools (incl. public_skill_from_prompt)", PS.managementTools().length === 10 && PS.managementTools().every((t) => /^public_skill_/.test(t.name) && t.server === "totalscript") && PS.managementTools().some((t) => t.name === "public_skill_from_prompt" && t.executionMode === "WRITE"));

// ── plain-text (.txt) format ───────────────────────────────────────────────
const TXT_SKILL = `# Lantern Line
kind: skill
description: Places N lanterns with warm PointLights along the selected path.
params: count:number=4 "how many", color:string="warm" "light colour"
tags: lighting, props

--- luau ---
local n = {{count}}
for i = 1, n do
  local p = Instance.new('Part')
  p.Name = 'Lantern_' .. i
  p.Parent = workspace
end
print('placed', n, {{color}})
`;
{
  const t = PS.parseText(TXT_SKILL);
  ok("parseText reads a .txt skill (title, kind, params, luau section)", t.ok && t.def.kind === "skill" && t.def.title === "Lantern Line" && t.def.name === "lantern_line" && t.def.params.length === 2 && t.def.params[0].name === "count" && t.def.params[0].type === "number" && t.def.params[0].default === 4 && t.def.params[0].description === "how many" && t.def.params[1].default === "warm" && /local n = \{\{count\}\}/.test(t.def.luau) && t.def.tags === "lighting, props", JSON.stringify(t).slice(0, 300));
  const v = PS.validate(t.def);
  ok("parsed .txt skill validates", v.ok, (v.errors || []).join("; "));
  const r = PS.importShared(TXT_SKILL, { reserved: new Set() });
  ok("importShared accepts .txt skills", r.ok && r.item && r.item.name === "lantern_line" && r.item.params.length === 2, JSON.stringify(r.errors));
  const out = PS.exportText("lantern_line");
  ok("exportText writes the same format back", /^# Lantern Line\nkind: skill\nname: lantern_line\n/.test(out) && out.includes("--- luau ---") && out.includes("params: count:number=4 \"how many\", color:string=\"warm\" \"light colour\""), out);
  const back = PS.parseText(out);
  ok("exportText → parseText round-trips", back.ok && back.def.name === "lantern_line" && back.def.params.length === 2 && back.def.params[0].default === 4 && back.def.luau.trim() === r.item.luau.trim());
  ok("textFileName uses name.kind.orskill.txt", PS.textFileName("lantern_line") === "lantern_line.skill.orskill.txt");
  PS.remove("lantern_line");
}
{
  const t = PS.parseText("# Night Market\nkind: mode\nbase: visualizer\nbadge: MARKET\ndescription: Atmospheric night market scenes with lanterns and fog.\nfocus: set_lighting, create_part\n\n--- mandate ---\n" + "Build moody night markets. ".repeat(6));
  ok("parseText reads a mode (base/badge/focus/mandate; legacy base kept in the def, normalised on validate)", t.ok && t.def.kind === "mode" && t.def.base === "visualizer" && PS.validate(t.def).item.base === "creation" && t.def.badge === "MARKET" && t.def.mandate.length >= 80 && PS.validate(t.def).ok, JSON.stringify(t).slice(0, 200));
  const a = PS.parseText("# Tidy Up\nkind: ability\ndescription: Cleans the workspace before publishing a place.\n--- steps ---\n1. Delete stray parts\n2. Group props\n3. Verify with count\n");
  ok("parseText reads an ability with steps (instructions derived)", a.ok && a.def.kind === "ability" && a.def.steps.length === 3 && a.def.steps[1] === "Group props" && PS.validate(a.def).ok, JSON.stringify(a).slice(0, 200));
  const p = PS.parseText("You are a senior Roblox lighting artist. Always set up atmosphere first.\nNever leave default lighting. Verify with a screenshot.");
  ok("parseText flags free prose as a prompt", !p.ok && p.prompt === true && typeof p.text === "string");
  const s = PS.importShared("Please make every build you do clean and verified, always.", { reserved: new Set() });
  ok("importShared reports prompt:true for prose instead of 'unrecognised'", !s.ok && s.prompt === true && /prompt, not a skill file/.test(s.errors[0]));
}

// ── prompt → skill ─────────────────────────────────────────────────────────
{
  const PROMPT = "# Boss Arena Builder\nYou build circular boss arenas in Roblox Studio.\n\n1. Create a 120-stud circular floor with a neon ring.\n2. Add four pillars and a raised throne platform.\n3. Place spawn locations at the four compass points.\n4. Verify the part count and report it.\nAlways use create_part for geometry and set_lighting for mood.";
  ok("looksLikeFullPrompt: long/multi-line yes, short description no", PS.looksLikeFullPrompt(PROMPT) && !PS.looksLikeFullPrompt("a skill that adds lanterns"));
  const f = PS.fromPrompt(PROMPT, { reserved: new Set(["create_part", "set_lighting", "execute_luau"]) });
  ok("fromPrompt (no AI) -> ability with title, steps and referenced commands", f.ok && f.def.kind === "ability" && f.def.title === "Boss Arena Builder" && f.def.name === "boss_arena_builder" && f.def.steps.length === 4 && f.def.instructions === PROMPT && f.def.commands.includes("create_part") && f.def.commands.includes("set_lighting") && PS.validate(f.def).ok, JSON.stringify(f).slice(0, 300));
  const m = PS.fromPrompt("You are a senior horror-map specialist. " + "Prioritise dread, fog and flickering lights over detail. ".repeat(8) + "Never add bright colours.", { kind: "mode" });
  ok("fromPrompt kind=mode -> mandate verbatim, base is creation", m.ok && m.def.kind === "mode" && m.def.base === "creation" && m.def.mandate.startsWith("You are a senior horror-map specialist.") && m.def.badge.length <= 12 && PS.validate(m.def).ok, JSON.stringify(m).slice(0, 300));
  const sk = PS.fromPrompt("Spawn ring\n```lua\nlocal n = {{count}}\nfor i = 1, n do local p = Instance.new('Part') p.Parent = workspace end\n```", { kind: "skill" });
  ok("fromPrompt kind=skill with fenced Luau -> skill with {{count}} param", sk.ok && sk.def.kind === "skill" && sk.def.params.length === 1 && sk.def.params[0].name === "count" && /Instance\.new/.test(sk.def.luau) && PS.validate(sk.def).ok, JSON.stringify(sk).slice(0, 300));
  const fb = PS.fromPrompt("Make the arena bigger and add torches around the edge, then verify.", { kind: "skill" });
  ok("fromPrompt kind=skill without Luau falls back to ability with a warning", fb.ok && fb.def.kind === "ability" && fb.warnings.length === 1);
  ok("fromPrompt rejects tiny text", !PS.fromPrompt("hi there").ok);
  const inst = PS.installFromPrompt(PROMPT, { reserved: new Set() });
  ok("installFromPrompt installs and is callable as a command", inst.ok && inst.item.kind === "ability" && PS.isCommand("boss_arena_builder") && String(PS.abilityText("boss_arena_builder", {}).text || "").includes("Create a 120-stud circular floor"), JSON.stringify(inst.errors));
  const cp = PS.conversionPrompt(PROMPT, "auto", { commandNames: ["create_part", "set_lighting"] });
  ok("conversionPrompt: faithful conversion, verbatim prompt, create call, definition doc, existing names", /CONVERT it; do not redesign it/.test(cp) && cp.includes("<<<PROMPT\n" + PROMPT + "\nPROMPT>>>") && cp.includes("public_skill_create") && cp.includes("DEFINITION OBJECT (JSON)") && cp.includes("boss_arena_builder (ability)") && /KIND: choose from the prompt itself/.test(cp));
  ok("conversionPrompt honours an explicit kind", /KIND: mode \(the user chose this explicitly\)/.test(PS.conversionPrompt(PROMPT, "mode")));
  PS.remove("boss_arena_builder");
}
const block = PS.catalogueBlock({ compact: true });
ok("catalogueBlock lists signatures under a PUBLIC SKILLS header", /^PUBLIC SKILLS - 2 user-made commands/.test(block) && /lantern_row \{path, count\?, lit\?\}/.test(block) && /script_audit \{scope\?\}/.test(block) && block.endsWith("\n\n"));
ok("catalogueBlock is empty with nothing installed", (() => { const saved = PS.list(); PS.replaceAll([]); const e = PS.catalogueBlock(); PS.replaceAll(saved); PS.setActiveMode("horror_builder"); return e === ""; })());

// sharing
const json = PS.exportJson("lantern_row");
const exp = JSON.parse(json);
ok("export is a tagged totalscript-public-skill document without device state", exp.format === "totalscript-public-skill" && exp.item.name === "lantern_row" && exp.item.enabled === undefined && exp.item.createdAt === undefined);
ok("fileName uses <name>.<kind>.orskill.json", PS.fileName("lantern_row") === "lantern_row.skill.orskill.json");
const code = PS.shareCode("lantern_row");
ok("share code is ORSKILL1:<base64>", /^ORSKILL1:[A-Za-z0-9+/=]+$/.test(code));
ok("import of a duplicate is refused unless replace", !PS.importShared(code).ok && PS.importShared(code).duplicate.name === "lantern_row" && PS.importShared(code, { replace: true }).ok);
ok("import after delete reinstalls from the share code with source=import", (PS.remove("lantern_row"), (() => { const i = PS.importShared(code); return i.ok && i.item.source === "import" && i.item.name === "lantern_row"; })()));
ok("garbage import is rejected cleanly", !PS.importShared("ORSKILL1:!!!").ok && !PS.importShared("{not json").ok && !PS.importShared(JSON.stringify({ hello: 1 })).ok);

// pack sharing (Export all / Import)
const pack = JSON.parse(PS.exportPackJson());
ok("exportPackJson bundles every installed item", pack.format === "totalscript-public-skill-pack" && pack.count === PS.list().length && pack.items.every((i) => i.kind && i.name));
ok("pack file name and share code", /^totalscript-public-skills-\d{4}-\d{2}-\d{2}\.orskills\.json$/.test(PS.packFileName()) && /^ORSKILL1:/.test(PS.packShareCode()));
const packCode = PS.packShareCode();
let imp = PS.importShared(packCode);
ok("importing a pack over existing items reports them as skipped", imp.pack && imp.installed.length === 0 && imp.skipped.length === pack.count, JSON.stringify(imp).slice(0, 160));
ok("pack import with replace reinstalls everything", PS.importShared(packCode, { replace: true }).installed.length === pack.count && PS.list().length === pack.count);
ok("pack import into an empty registry installs all and keeps the active-mode item", (() => { const saved = PS.list(); PS.replaceAll([]); const r = PS.importShared(JSON.stringify(pack)); const okk = r.ok && r.installed.length === pack.count && PS.list().length === pack.count; PS.replaceAll(saved); PS.setActiveMode("horror_builder"); return okk; })());
ok("a bare array of definitions imports as a pack too", (() => { const saved = PS.list(); PS.replaceAll([]); const r = PS.importShared(JSON.stringify(pack.items)); const okk = r.pack && r.installed.length === pack.count; PS.replaceAll(saved); PS.setActiveMode("horror_builder"); return okk; })());

// update + generation prompt
r = PS.update("lantern_row", { description: "Places N anchored lanterns next to a target instance, now with light." }, { reserved });
ok("update merges a patch and bumps the version", r.ok && r.item.version === 2 && /with light/.test(r.item.description));
const gp = PS.generationPrompt("a skill that paints selected parts red", "auto", { commandNames: ["part_create", "instance_find"] });
ok("generationPrompt tells the model to submit via public_skill_create and lists installed names", /public_skill_create/.test(gp) && /KIND: decide yourself/.test(gp) && /lantern_row \(skill\)/.test(gp) && /DEFINITION OBJECT/.test(gp) && /part_create, instance_find/.test(gp));
ok("generationPrompt honours an explicit kind", /KIND: mode \(the user chose/.test(PS.generationPrompt("x", "mode")));

// change events
let events = 0; const off = PS.onChange(() => events++); PS.setEnabled("script_audit", false); PS.setEnabled("script_audit", true); off();
ok("onChange fires on toggles and can be unsubscribed", events === 2);

// ── wiring pins ────────────────────────────────────────────────────────────
const main = read("src/core/main.js");
const config = read("src/core/config.js");
const css = read("overlay.css");
const manifest = JSON.parse(read("manifest.json"));
const bundles = manifest.content_scripts.filter((c) => (c.js || []).includes("src/core/main.js"));
ok("manifest loads public_skills.js before main.js in every main.js bundle", bundles.length > 0 && bundles.every((c) => { const i = c.js.indexOf("src/core/public_skills.js"); return i >= 0 && i < c.js.indexOf("src/core/main.js") && i > c.js.indexOf("src/core/config.js"); }));
ok("runTool routes public_skill_* and installed public commands", main.includes('if (toolName.startsWith("public_skill_")) return await runPublicSkillTool(toolName, args);') && main.includes('if (typeof PublicSkills !== "undefined" && PublicSkills.isCommand(toolName)) return await runPublicSkill(toolName, args);'));
ok("legacy public_item_* hook now resolves to a real dispatcher", /function dispatchPublicItemTool\(name, args\)/.test(main) && main.includes("typeof dispatchPublicItemTool === \"function\""));
ok("public skills execute through execute_luau with the TotalScript-internal flag and relabelled output", /runPublicSkill[\s\S]{0,1200}tool: "execute_luau", arguments: \{ code: built\.code, datamodel_type: "Edit", _totalInternal: true \}/.test(main) && /res = `Output of '\$\{item\.name\}':` \+ res\.slice\("Output of 'execute_luau':"\.length\)/.test(main));
ok("public skill runs report through __rsBeforeTool/__rsAfterTool", /runPublicSkill[\s\S]{0,2000}window\.__rsBeforeTool\(item\.name, args\)[\s\S]{0,1500}window\.__rsAfterTool\(item\.name, args, ok, res\)/.test(main));
ok("catalogue injects management tools + user commands and refreshes on change", main.includes("[...PublicSkills.managementTools(), ...PublicSkills.toolEntries()]") && /function refreshPublicSkillTools\(\)/.test(main) && main.includes('window.addEventListener("total-public-skills-change", () => refreshPublicSkillTools())'));
ok("buildCatalogue appends the PUBLIC SKILLS block to the universal tier (pinned return untouched)", main.includes("const pub = PublicSkills.catalogueBlock({ compact });") && main.includes("universalBlock += pub;") && main.includes('return intro + universalBlock + (focusBlock || "") + webBlock + detailBlock + sigBlock + namesBlock + tail;'));
ok("work mode: pm:<id> ids layer a custom mode on its base; hook for the agent", /if \(typeof id === "string" && id\.startsWith\("pm:"\)\)/.test(main) && main.includes("workMode = normalizeWorkMode(custom ? custom.base : id);") && main.includes("window.__rsSetWorkMode = (id) => setWorkMode(id);"));
ok("badge shows the custom mode; menu lists custom modes after the built-ins", main.includes("badge.textContent = pm ? pm.badge : mode.badge;") && main.includes('data-work="pm:${m.id}"') && main.includes("rs-work-card rs-work-custom"));
ok("workModeFocusNames unions the custom focus list", /customFocus\.has\(String\(n\)\.replace/.test(main) && main.includes("|| isUniversalCommand(n))"));
ok("Public tab has a Share box: import file/code, paste code, export all, share-all code", main.includes("rs-public-sharebox") && main.includes("[data-public-export-all]") && main.includes("[data-public-share-all]") && main.includes("PublicSkills.exportPackJson()") && main.includes("PublicSkills.packShareCode()") && /if \(r\.pack\) \{ let msg/.test(main));
ok("public_skill_export accepts name='all' and public_skill_import handles packs", main.includes("if (/^(all|\\*|everything)$/i.test(ref))") && main.includes("if (r.pack) { for (const it of r.installed) announce("));
ok("cards panel has a Public tab with composer, import and per-item actions", main.includes('data-tab="public">Public') && /function publicHtml\(\)/.test(main) && main.includes('id="rs-public-prompt"') && main.includes("[data-public-create]") && main.includes("[data-public-import]") && main.includes("[data-public-paste]") && ["run", "activate", "improve", "edit", "toggle", "export", "share", "delete"].every((a) => main.includes(`act==="${a}"`)));
ok("Create with AI sends the generation prompt through runLibraryCard", /prompt:publicGenerationPrompt\(text,publicKind\)\},true\)/.test(main));
ok("install results open a review modal (total-public-skill-result)", main.includes('new CustomEvent("total-public-skill-result"') && /window\.addEventListener\("total-public-skill-result"/.test(main) && /function showPublicInstalled\(detail\)/.test(main));
ok("hand-made editor exists with skeletons for all three kinds", /function openPublicEditor\(item, kind\)/.test(main) && /PUBLIC_SKELETONS = \{\s*skill:/.test(main) && /ability: \{ kind: "ability"/.test(main) && /mode: \{ kind: "mode"/.test(main));
ok("ui-closure vars used by early init are hoisted (no TDZ)", main.includes("var publicEditorEl = null, openCardsPanel = null, openTrayFn = null, closeCardsWindowFn = null;") /* 1.73.0: + templates-window hooks */ && main.includes('var publicDraft = "", publicKind = "auto";'));
ok("totalscript_help knows the publicskills topic", /publicskills:\{title:"Public Skills"/.test(main) && /publicskills:\/public skill\|own skill/.test(main));
ok("config.js appends the custom mode mandate and a PUBLIC SKILLS block (tight + full)", config.includes("PublicSkills.modePrompt(pm)") && config.includes("━━━ PUBLIC SKILLS (ALL PROVIDERS) ━━━") && config.includes("━━━ PUBLIC SKILLS ━━━") && config.includes("Custom work modes available:") && !config.includes("PUBLIC ITEMS (ALL PROVIDERS)"));
ok("Notion preferences bootstrap mentions public skills", config.includes("PUBLIC SKILLS preference:") && config.includes("${crewPref}${publicPref}"));
ok("overlay.css styles the Public tab, kind pills and custom mode cards", css.includes(".rs-public-compose") && css.includes(".rs-public-kind-mode") && css.includes(".rs-work-card.rs-work-custom") && css.includes(".rs-public-editor"));
ok("1.27.0 Public tab: 3 ways in, prompt → skill (AI + Save as-is), Load .txt, drop zone, Export .txt", main.includes("rs-public-ways") && main.includes("[data-public-save-text]") && main.includes("[data-public-load-text]") && main.includes('data-public-drop') && main.includes('data-public-action="export-text"') && /function publicSaveAsIs\(text\)/.test(main) && /function publicLoadText\(text, fileName\)/.test(main) && /function publicDownloadText\(id\)/.test(main) && main.includes('pubSection.addEventListener("drop"') && /function publicReadFile\(file\)/.test(main));
ok("Create button auto-routes: full prompt → conversionPrompt, description → generationPrompt (pin kept)", /if \(how === "convert"\) return PublicSkills\.conversionPrompt\(text, kind, \{ commandNames: publicCommandSample\(\) \}\);/.test(main) && main.includes('var publicHow = "auto";') && main.includes("Turn prompt into a skill (AI)"));
ok("import: prose files load into the composer instead of failing", main.includes("if (!r.ok && r.prompt) {") && main.includes('input.accept = ".json,.orskill.json,.orskills.json,.txt,.md,text/plain,application/json"'));
ok("runTool handles public_skill_from_prompt", main.includes('if (op === "from_prompt") {') && main.includes("PS.installFromPrompt(text, { kind: args.kind, title: args.title, name: args.name, description: args.description, reserved: reserved(), source: \"ai\" })") && main.includes("Available: public_skill_create/from_prompt/list/get/update/delete/enable/test/export/import."));
ok("help topic + config prompt blocks explain prompt → skill and .txt", /Prompt → skill: paste a whole prompt/.test(main) && /Plain-text format \(\.txt\)/.test(main) && config.includes("PROMPT → SKILL: when the user pastes a full prompt") && config.includes("public_skill_from_prompt {prompt}") && css.includes(".rs-public-ways") && css.includes(".rs-public-hint-convert") && css.includes(".rs-public-dragover"));
ok("popup work-mode literal untouched", read("popup.js").includes('const WORK_MODES = ["creation"]'));
ok("BASES = [creation] with legacy mapping exported", Array.isArray(PS.BASES) && PS.BASES.length === 1 && PS.BASES[0] === "creation" && PS.normalizeBase("animator") === "creation" && PS.normalizeBase("ULTIMATE") === "creation" && PS.normalizeBase("creation") === "creation" && PS.normalizeBase("") === "creation");

console.log(`\n${pass} passed, ${fail} failed`);
