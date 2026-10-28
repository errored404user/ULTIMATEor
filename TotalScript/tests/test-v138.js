// 1.38.0 — Modes & commands overhaul. (1.39.0: the three modes merged into
//  one "creation" mode - the per-mode checks below now run against it.)
//
//  COMMANDS: the signature tier of the catalogue is grouped into FAMILIES with
//  the active work mode's families first; 34 "studio.x {}" alias rows and the
//  raw screen_capture are hidden; signatures list required parameters first;
//  sigFromLine no longer leaks description examples ("Rewards") as parameters;
//  packSignatures is strict (no duplicate names in the names-only tail); helper
//  lines are deduplicated; heavy skill programs get a 90 s execute budget.
//  MODES: PLAYBOOKS (four command chains per mode) in the full profile and the
//  switch note; a MODE EVIDENCE GATE in the loop (one verification request per
//  run when the mode mutated without proving); mode notes describe all of it.
// Run: node tests/test-v138.js  (from TotalScript/)
const fs = require("fs");
const vm = require("vm");
let failed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : "  -> " + extra}`); if (!cond) failed++; };
const main = fs.readFileSync("src/core/main.js", "utf8");
const config = fs.readFileSync("src/core/config.js", "utf8");
const readme = fs.readFileSync("README.md", "utf8");

// ── load the skill packs once (real describeCommands lines) ──
global.window = global; global.chrome = { runtime: { getURL: (p) => p }, storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });

// ── extract the catalogue machinery from main.js and run it for real ──
const cut = (a, b) => { const i = main.indexOf(a), j = main.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor missing: " + a); return main.slice(i, j); };
const block = cut("  const UNIVERSAL_COMMANDS = [", "  const UNIVERSAL_SET")
  + cut("  const PRIORITY_COMMAND_RE", "  // ── Project Index map cache (1.32) ──")
  + "\n" + cut("  const WORK_MODES = {", "  const WORK_MODE_IDS");
const ctx = { window: null, console, RS: { TOOL_NOTES: {} }, bareToolName: (n) => String(n).split("/").pop(), RobloxScriptSkills, RSAnim, PublicSkills: undefined, TotalTaskList: undefined, WORK_MODE_IDS: ["creation"] };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(block + "\nthis.buildCatalogue=buildCatalogue;this.sigFromLine=sigFromLine;this.commandFamily=commandFamily;this.groupByFamily=groupByFamily;this.packSignatures=packSignatures;this.toolSignature=toolSignature;this.COMMAND_FAMILIES=COMMAND_FAMILIES;this.FAMILY_ORDER=FAMILY_ORDER;", ctx);
const skillLines = RobloxScriptSkills.describeCommands(), animLines = RSAnim.describeCommands();

// A. signatures
const bpc = skillLines.find((l) => /^blueprint_configure:/.test(l));
ok("sigFromLine: no description example leaks in (Rewards) and required comes first", ctx.sigFromLine(bpc) === "blueprint_configure {name, replace?, reset?, verify?, config?}", ctx.sigFromLine(bpc));
ok("sigFromLine: multi-line detailed params still parsed", ctx.sigFromLine("foo_bar: does things\n    a:string, b?:number \"x\"\n    path: string - full path to the thing to foo\n    opts?: object - keys to merge, e.g. {Rewards:{OnKill:1}}") === "foo_bar {a, path, b?, opts?}", ctx.sigFromLine("foo_bar: does things\n    a:string, b?:number \"x\"\n    path: string - full path to the thing to foo\n    opts?: object - keys to merge, e.g. {Rewards:{OnKill:1}}"));
ok("toolSignature: required parameters first", ctx.toolSignature({ name: "x", inputSchema: { type: "object", required: ["code"], properties: { datamodel_type: { type: "string" }, code: { type: "string" } } } }) === "x {code, datamodel_type?}");
const packed = ctx.packSignatures(["a {}", "bb {x}", "ccc {y, z?}", "dddd {}"], 17, 10);
ok("packSignatures is strict: shown is a prefix, omitted = the tail", packed.shown === 2 && packed.omitted === 2 && packed.text === "a {}  ·  bb {x}", JSON.stringify(packed));

// B. families
ok("COMMAND_FAMILIES exists with an OTHER catch-all and a per-mode FAMILY_ORDER", Array.isArray(ctx.COMMAND_FAMILIES) && ctx.COMMAND_FAMILIES[ctx.COMMAND_FAMILIES.length - 1].id === "other" && ["creation"].every((m) => Array.isArray(ctx.FAMILY_ORDER[m]) && ctx.FAMILY_ORDER[m].length === ctx.COMMAND_FAMILIES.length));
ok("every family id appears exactly once in every mode order", ["creation"].every((m) => new Set(ctx.FAMILY_ORDER[m]).size === ctx.COMMAND_FAMILIES.length && ctx.COMMAND_FAMILIES.every((f) => ctx.FAMILY_ORDER[m].includes(f.id))));
const famOf = (n) => ctx.commandFamily(n);
ok("families classify representative commands", famOf("script_read") === "script" && famOf("blueprint_install") === "blueprint" && famOf("ds_set") === "data" && famOf("remote_event_create") === "data" && famOf("part_create") === "build" && famOf("model_wall") === "build" && famOf("hinge_create") === "physics" && famOf("terrain_height") === "terrain" && famOf("lighting_set_preset") === "lighting" && famOf("fx_magic_circle") === "vfx" && famOf("ui_screen_generate") === "ui" && famOf("gfx_capture") === "gfx" && famOf("sound_play") === "audio" && famOf("animation_add_keyframe") === "animation" && famOf("tween_sequence") === "motion" && famOf("camera_shake_preset") === "motion" && famOf("start_stop_play") === "play" && famOf("studio_playtest") === "play" && famOf("memory_search") === "studio" && famOf("web_fetch") === "web");
ok("creation order: scripting first, then blueprints / data / build / physics, then lighting / vfx / ui, then animation / motion", ctx.FAMILY_ORDER.creation.slice(0, 10).join() === "script,blueprint,data,build,physics,lighting,vfx,ui,animation,motion");
{
  const allNames = [...skillLines, ...animLines].map((l) => (l.match(/^([a-z][\w]*):/) || [])[1]).filter(Boolean);
  const other = allNames.filter((n) => famOf(n) === "other");
  ok(`fewer than 3% of ${allNames.length} skill commands fall into OTHER`, other.length / allNames.length < 0.03, other.length + ": " + other.slice(0, 15).join(", "));
}

// C. the catalogue itself, per mode
const native = [
  { name: "execute_luau", inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" }, datamodel_type: { type: "string" } } } },
  { name: "get_studio_state", inputSchema: { type: "object", properties: {} } },
  { name: "script_read", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
  { name: "start_stop_play", inputSchema: { type: "object", properties: { is_start: { type: "boolean" } } } },
];
const helpers = ["— Screenshot: total_screenshot {target?} — PHOTO", "— Debugger: total_debug {}", "— Screenshot: total_screenshot {target?} — capture", "— Debugger: total_debug {} — LogService"];
const cats = {};
for (const mode of ["creation"]) {
  ctx.window.__rsWorkMode = () => mode;
  cats[mode] = ctx.buildCatalogue({ toolName: "list_commands", requested: "roblox", heading: "━━━ COMMAND CATALOGUE (embedded) ━━━", nativeTools: native, virtualLines: [...animLines, ...skillLines], webLines: helpers, focusBlock: `━━━ ${mode.toUpperCase()} WORK MODE FOCUS — x ━━━\n\n`, focusNames: [], compact: true, limit: 20000, lineLimit: 420, modeId: mode });
}
const famsWithSigs = (t) => [...t.matchAll(/^── (.+?) \(\d+\) ──$/gm)].map((m) => m[1]);
ok("creation catalogue: scripting / blueprints / data / build families carry signatures first", famsWithSigs(cats.creation).slice(0, 4).join("|") === "SCRIPTING|SYSTEM BLUEPRINTS|DATA, REMOTES, NETWORK & MONETIZATION|MODELING & BUILD", famsWithSigs(cats.creation).join("|"));
ok("creation catalogue: lighting / VFX / UI families follow physics", famsWithSigs(cats.creation).slice(5, 8).join("|") === "LIGHTING & ATMOSPHERE|VFX & PARTICLES|UI & HUD", famsWithSigs(cats.creation).join("|"));
ok("creation catalogue: animation / tweens-camera families follow UI", famsWithSigs(cats.creation).slice(8, 10).join("|") === "ANIMATION|TWEENS, SPRINGS & CAMERA", famsWithSigs(cats.creation).join("|"));
ok("the heading names the mode", cats.creation.includes("SIGNATURES BY FAMILY (callable as shown; TOTALITY families first):"));
for (const mode of Object.keys(cats)) {
  const t = cats[mode];
  ok(`${mode}: within budget (${t.length} chars, ${t.split("\n").length} lines)`, t.length <= 20000 && t.split("\n").length <= 420);
  const sigNames = [...t.split("NAMES ONLY")[0].matchAll(/(?:^|·\s+)([a-z][a-z0-9_]*) \{/gm)].map((m) => m[1]);
  const nameOnly = (t.split("NAMES ONLY")[1] || "").split("\n").slice(1).flatMap((row) => row.split(": ").slice(1).join(": ").split(", ").map((x) => x.trim())).filter(Boolean);
  const dup = nameOnly.filter((n) => sigNames.includes(n));
  ok(`${mode}: no command is listed both as a signature and as a name`, dup.length === 0, dup.slice(0, 5).join(", "));
  ok(`${mode}: names-only rows are grouped by family`, /NAMES ONLY[^\n]*\n[A-Z][A-Z ,&]+: [a-z_]+/.test(t));
  ok(`${mode}: no alias rows / raw screen_capture`, !/studio\.\w+ \{\}/.test(t) && !/\bscreen_capture \{/.test(t));
}
ok("helper lines deduplicated by label", (cats.creation.match(/— Screenshot:/g) || []).length === 1 && (cats.creation.match(/— Debugger:/g) || []).length === 1);

// D. source wiring for the above
ok("alias tools hidden", main.includes('server:"roblox",aliasTarget:target,hidden:true}'));
ok("screen_capture hidden after the tool fetch", main.includes('if (t && bareToolName(t.name) === "screen_capture") t.hidden = true;'));
ok("both catalogue call sites pass modeId", main.includes("focusBlock, focusNames, compact, limit, lineLimit, modeId: focusMode,") && main.includes("lineLimit: Math.max(120, Number(P.embedCatalogueLines) || 420), modeId: focusMode,"));
ok("focus header no longer claims every focus command is listed with a signature", !main.includes("all listed with their signatures below") && main.includes("which come FIRST in SIGNATURES BY FAMILY below"));
ok("slow skill programs get a 90 s budget via _totalTimeout (stripped from the wire)", main.includes("const SLOW_SKILL_RE = /^(project_index_(build|changes|summary|search|graph)|project_health_report|blueprint_(install|verify|remove|configure|status)") && main.includes("const slowBudget = SLOW_SKILL_RE.test(name) ? 90000 : 0;") && main.includes("let res = await runSkillLuau(built, slowBudget);") && main.includes("_totalInternal: true, _totalTimeout: budget || undefined }") && main.includes("const timeout = Math.min(115000, Number(args && args._totalTimeout) || 0) || (name === \"execute_luau\" ? 20000") && main.includes("if (!/^_total/.test(k)) o[k] = args[k];"));

// E. playbooks
vm.runInThisContext(config + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
ok("WORK_MODE_PLAYBOOKS exported with the twelve merged recipes (4 + 4 + 4)", RS.WORK_MODE_PLAYBOOKS && (RS.WORK_MODE_PLAYBOOKS.creation.match(/^- [A-Z]/gm) || []).length === 12 && typeof RS.workModePlaybook === "function" && RS.workModePlaybook("visualizer") === RS.WORK_MODE_PLAYBOOKS.creation);
ok("playbooks name the twelve jobs", ["NEW SYSTEM", "BUG FIX", "EXISTING PLACE", "BUILD", "MOOD PASS", "HERO VFX", "UI SCREEN", "THUMBNAIL", "COMBAT CLIP", "LOCOMOTION LOOP", "PROP / UI MOTION", "CUTSCENE"].every((k) => RS.WORK_MODE_PLAYBOOKS.creation.includes("- " + k)));
ok("full profiles end with the playbook, tight ones do not", ["creation", "ultimate", "visualizer", "animator"].every((m) => RS.workModePrompt(m).includes("PLAYBOOKS (") && !RS.workModePrompt(m, { tight: true }).includes("PLAYBOOKS (")));
ok("switch note carries the playbook", RS.workModeSwitchNote("creation").includes("MOOD PASS:") && !RS.workModeSwitchNote("creation", { tight: true }).includes("MOOD PASS:"));
ok("every playbook step ends in verification", /start_stop_play \+ get_console_output → report\./.test(RS.WORK_MODE_PLAYBOOKS.creation) && /gfx_teardown\./.test(RS.WORK_MODE_PLAYBOOKS.creation) && /animation_preview → fix → animation_preview\./.test(RS.WORK_MODE_PLAYBOOKS.creation));

// F. mode evidence gate
const gateBlock = cut("  const MODE_GATES = {", "  // 1.38.0: skill programs that legitimately run long");
const gctx = { window: { __rsWorkMode: () => "ultimate" }, normalizeWorkMode: (id) => (id === "creation" ? id : "creation"), bareToolName: (n) => String(n).split("/").pop(), WORK_MODES: { creation: { badge: "CREATION" } } };
vm.createContext(gctx); vm.runInContext(gateBlock + "\nthis.modeGateNudge=modeGateNudge;this.MODE_GATES=MODE_GATES;", gctx);
ok("gate: creation fires on scripts written without read-back / check / console (legacy id still routes)", /CREATION GATE[\s\S]*- SCRIPTS:/.test(gctx.modeGateNudge(new Set(["get_studio_state", "script_create", "multi_edit"]))));
ok("gate: scripts gate silent when verified", gctx.modeGateNudge(new Set(["script_create", "script_read", "script_check"])) === "" && gctx.modeGateNudge(new Set(["script_set_source", "start_stop_play"])) === "");
ok("gate: silent on a pure inspection run or a plain execute_luau", gctx.modeGateNudge(new Set(["get_studio_state", "search_game_tree", "execute_luau"])) === "");
gctx.window.__rsWorkMode = () => "visualizer";
ok("gate: look gate fires on a changed look without a screenshot", /CREATION GATE[\s\S]*- LOOK:/.test(gctx.modeGateNudge(new Set(["lighting_set_preset", "fx_create_vfx"]))) && gctx.modeGateNudge(new Set(["lighting_set_preset", "total_screenshot"])) === "" && gctx.modeGateNudge(new Set(["gfx_stage_create", "gfx_capture"])) === "");
ok("gate: look gate ignores read-only ui_list_tree / ui_audit", gctx.modeGateNudge(new Set(["ui_list_tree", "ui_audit"])) === "");
gctx.window.__rsWorkMode = () => "animator";
ok("gate: motion gate fires on motion without preview", /CREATION GATE[\s\S]*- MOTION:/.test(gctx.modeGateNudge(new Set(["animation_create", "animation_add_keyframe"]))) && gctx.modeGateNudge(new Set(["animation_create", "animation_preview"])) === "" && gctx.modeGateNudge(new Set(["tween_sequence", "start_stop_play"])) === "");
ok("gate texts are ONE system note that forbids acknowledging; several failing gates merge", (() => { const n = gctx.modeGateNudge(new Set(["script_create", "lighting_set_preset", "animation_create"])); return /System note from TotalScript, not the user/.test(n) && /Do not acknowledge this note/.test(n) && n.includes("- SCRIPTS:") && n.includes("- LOOK:") && n.includes("- MOTION:") && (n.match(/━━━ CREATION GATE/g) || []).length === 1; })());
ok("loop wiring: run tool set, one gate per run, before 'complete'", main.includes("let modeGateSent = false; // 1.38.0: one evidence gate per run") && main.includes("A.runTools = new Set();") && main.includes("try { A.runTools.add(bareToolName(call.tool)); } catch {}") && main.includes("if (!modeGateSent && !A.stop && toolTurns >= 2) {") && main.includes("const nudge = modeGateNudge(A.runTools);") && main.includes('diag("loop.modeGate"') && main.indexOf("const nudge = modeGateNudge(A.runTools);") < main.indexOf('ui.steeringProgress("complete", toolTurns ?'));
ok("gate runs after the commandless-retry rescue (never instead of it)", main.indexOf('diag("loop.capabilityRefuse"') < main.indexOf("const nudge = modeGateNudge(A.runTools);"));

// G. mode notes + bookkeeping
ok("mode note describes catalogue order, playbooks and the gates", /Catalogue: scripting, blueprints, data, build and physics families first, then lighting, VFX, UI, animation and motion\. Playbooks: new system, bug fix, existing place, build, mood pass, hero VFX, UI screen, thumbnail, combat clip, locomotion loop, prop motion, cutscene\. Gate: changed scripts must be read back and checked, a changed look screenshotted and new motion previewed before 'done'\./.test(main));
const mf = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
ok("manifest 1.81.0", mf.version === "1.81.0", mf.version);
ok("plugin + crate pinned at 1.81.0", fs.readFileSync("plugin/TotalScript.lua", "utf8").includes('local VERSION = "1.81.0"') && /^version = "1\.81\.0"/m.test(fs.readFileSync("agent/Cargo.toml", "utf8")) && /name = "total-agent"\nversion = "1\.81\.0"/.test(fs.readFileSync("agent/Cargo.lock", "utf8")));
ok("README changelog 1.38.0", readme.includes("**1.38.0 — Modes & commands overhaul:") && readme.includes("test-v138.js"));

console.log(failed ? `\n${failed} check(s) failed` : "\nall 1.38.0 checks passed");
process.exitCode = failed ? 1 : 0;
