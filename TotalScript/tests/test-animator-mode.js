#!/usr/bin/env node
// tests/test-animator-mode.js — 1.99.7 third built-in work mode: ANIMATOR (id "animate").
//
//   The mode must change what the loop DOES, not only the prompt:
//   A. config.js: the Animator profile (full + tight), checklist, playbooks and
//      the label; Totality and Blender byte-identical; live budgets.
//   B. main.js: WORK_MODES.animate (card copy, 8 starters, focus regex),
//      FAMILY_ORDER.animate (animation / motion first), MODE_GATES.animate
//      (rig + playback + shared scripts / look) with a real nudge run, the
//      skill analyze call carrying the mode.
//   C. UI: overlay.css violet badge / card, popup.js + popup.html card.
//   D. README changelog.
//   Every command the profile cites must exist in this build (no invented
//   capability); the legacy id "animator" (pre-1.39.0) must NOT come back.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), cp = require("child_process");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } };

const main = read("src/core/main.js"), config = read("src/core/config.js"), css = read("overlay.css"), popup = read("popup.js"), popupHtml = read("popup.html"), readme = read("README.md");
global.window = global; global.chrome = { runtime: { getURL: (p) => p }, storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } } };
window.__rsWorkMode = () => "creation";
vm.runInThisContext(read("src/core/parser.js") + ";globalThis.RSParse=RSParse;");
vm.runInThisContext(config + ";globalThis.__RS=RS;");
const RS = globalThis.__RS;

// ── A. config.js profile ───────────────────────────────────────────────────
const full = RS.workModePrompt("animate"), tight = RS.workModePrompt("animate", { tight: true });
ok("A1 WORK_MODE_PROMPTS = creation + blender + animate; label Animator; unknown ids still fold to creation", Object.keys(RS.WORK_MODE_PROMPTS).join() === "creation,blender,animate" && RS.workModeLabel("animate") === "Animator" && RS.workModeLabel("animator") === "Totality" && RS.workModePrompt("animator") === RS.workModePrompt("creation"));
ok("A2 the legacy id 'animator' is not a mode id anywhere (config / main / popup)", !RS.WORK_MODE_PROMPTS.animator && !/WORK_MODES\.animator\b|animator: \{/.test(main) && !/"animator"\s*,?\s*\]/.test(popup) && /animator: "creation"/.test(popup));
ok(`A3 budgets: full ${full.length} in 6000–15000, tight ${tight.length} in 1500–3000; tight is a true subset of the ideas`, full.length >= 6000 && full.length <= 15000 && tight.length >= 1500 && tight.length <= 3000 && tight.includes("━━━ ANIMATOR WORK MODE (rig → clip → preview on the rig → playback code → play-test; R6 and R15) ━━━") && full.includes("━━━ ANIMATOR WORK MODE (rig → clip → preview on the rig → playback code → play-test; R6 and R15) ━━━") && full.includes("━━━ OPERATING LOOP") && full.indexOf("━━━ OPERATING LOOP") < full.indexOf("━━━ ANIMATOR WORK MODE"));
ok("A4 rig first: both variants open with animation_select_rig / rig_joints_inspect and the R6 ≠ R15 warning", /FIRST MOVE: animation_select_rig \{path\}/.test(full) && /rig_joints_inspect/.test(full) && /R6 (from|vs|≠) R15|R6 and R15|tell R6 from R15/.test(full) && /animation_select_rig/.test(tight) && /R6 vs R15/.test(tight));
ok("A5 the loop is named in order: plan beats → author → ease → markers → preview → validate → playback code → play-test", ["animation_create", "animation_set_pose", "animation_add_keyframe", "animation_set_easing", "animation_set_marker", "animation_preview", "animation_validate", "animation_compatibility", "anim_player_install", "script_create", "script_read", "script_check", "start_stop_play", "get_console_output"].every((n) => full.includes(n)) && full.indexOf("animation_add_keyframe") < full.indexOf("animation_preview on the pinned rig") && full.indexOf("animation_preview on the pinned rig") < full.indexOf("anim_player_install"));
ok("A6 honesty rules: preview is the proof, authored ≠ published, never invent asset ids, Animator not Humanoid:LoadAnimation", /nothing counts as done until it has PLAYED on the actual rig/.test(full) && /A KeyframeSequence in the place is NOT a published asset/.test(full) && /Never write an id you did not get from a result/.test(full) && /never Humanoid:LoadAnimation/.test(full) && /NEVER: declare a clip done from a successful command without a preview/.test(full) && /NEVER: done without a preview/.test(tight));
ok("A7 sequences / cutscenes / camera are covered with the real commands", ["sequence_create", "sequence_validate", "sequence_preview", "ability_sequence_create", "cutscene_create", "cutscene_preview", "cutscene_trigger", "camera_shake", "camera_dolly", "animation_publish", "animation_export_rbxmx"].every((n) => full.includes(n)));
ok("A8 eight playbooks, each a real command chain ending in a verification step", (() => { const pb = RS.WORK_MODE_PLAYBOOKS.animate; const names = ["COMBAT CLIP:", "COMBO (3 hits):", "LOCOMOTION SET:", "HIT REACTION / BLOCK / PARRY:", "DASH / ABILITY:", "EMOTE:", "CUTSCENE:", "FIX A BROKEN ANIMATION:"]; const lines = pb.split("\n").filter((l) => l.startsWith("- ")); return names.every((n) => pb.includes("- " + n)) && lines.length === 8 && lines.every((l) => /(animation_preview|sequence_preview|cutscene_preview|play-test|get_console_output|console is clean|read the id back|report the beats)/.test(l)); })());
ok("A9 checklist + switch note", RS.workModeChecklist("animate").startsWith("ANIMATOR CHECK: animation_select_rig / rig_joints_inspect first (R6 ≠ R15)") && RS.workModeChecklist("animate").includes("animation_preview after EVERY pass") && RS.workModeSwitchNote("animate").startsWith("━━━ WORK MODE SWITCHED → ANIMATOR") && RS.workModeSwitchNote("animate").includes("PLAYBOOKS"));
// every cited command exists in this build (core / skill packs / animlib)
{
  const src = ["src/core", "src/providers"].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => read(d + "/" + f))).join("\n");
  const block = full + "\n" + tight + " " + RS.workModeChecklist("animate") + "\n" + RS.WORK_MODE_PLAYBOOKS.animate;
  const NOT_COMMANDS = new Set(["stop_on_interrupt", "plant_feet", "input_window", "three_point", "studio_grey"]); // argument / phrase words, not commands
  const cited = [...new Set([...block.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]))].filter((n) => !NOT_COMMANDS.has(n));
  const missing = cited.filter((n) => !new RegExp("[\"'`]" + n + "[\"'`:]|\\b" + n + "\\s*:").test(src));
  ok(`A10 every command the Animator profile cites exists (${cited.length} names)`, missing.length === 0 && cited.length >= 45, missing);
  ok("A11 none of the names that do NOT exist are cited (anim_play_test / anim_report / anim_create / anim_combo)", !/\b(anim_play_test|anim_report|anim_create|anim_combo)\b/.test(block));
  // hidden NOT_IMPLEMENTED stubs (studio_100.js) are never recommended, pinned, gated or started from
  const stubs = [...read("src/core/skills/studio_100.js").slice(read("src/core/skills/studio_100.js").indexOf("const NOT_IMPLEMENTED = {")).matchAll(/^\s{4}([a-z_0-9]+):/gm)].map((m) => m[1]);
  const slice = (a, b) => { const i = main.indexOf(a), j = main.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor missing: " + a); return main.slice(i, j); };
  const modeSrc = slice("  WORK_MODES.animate = {", "  const WORK_MODE_IDS") + slice("  MODE_GATES.animate = [", "  // Returns the gate nudge for the active mode");
  ok(`A11b no hidden NOT_IMPLEMENTED stub is cited by the profile, playbooks, starters, focus or gates (${stubs.length} stubs checked incl. ik_control_setup / anim_blend_space / camera_shake_preset / character_emote_play)`, stubs.length >= 90 && ["ik_control_setup", "anim_blend_space", "camera_shake_preset", "character_emote_play"].every((n) => stubs.includes(n)) && stubs.every((n) => !block.includes(n) && !modeSrc.includes(n)), stubs.filter((n) => block.includes(n) || modeSrc.includes(n)));
}
// budgets in the live prompt
window.__rsWorkMode = () => "animate";
const cg = RS.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000 });
const vn = RS.buildSystemPrompt({ siteName: "Vani Chat", providerId: "vani", engine: "roblox", maxChars: 14000, commandFormat: "plain" });
const gm = RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" });
ok(`A12 live budgets in Animator mode: ChatGPT ${cg.length} ≤ 14000, Vani (plain) ${vn.length} ≤ 14000, Gemini ${gm.length} < 48000; the profile is present`, cg.length <= 14000 && vn.length <= 14000 && gm.length < 48000 && cg.includes("━━━ ANIMATOR WORK MODE") && gm.includes("━━━ ANIMATOR WORK MODE") && vn.includes("━━━ ANIMATOR WORK MODE"));
ok("A13 the Animator profile adds no json fence (Vani stays on the plain protocol)", !full.includes("```") && !tight.includes("```") && !vn.includes("```json"));
// Totality + Blender unchanged vs the committed config.js (when that one predates the mode)
{
  let committed = "";
  try { committed = cp.execSync("git show HEAD:TotalScript/src/core/config.js", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  if (committed && committed.includes('WORK_MODE_LABELS = { creation: "Totality", blender: "Blender" }')) {
    const c = { window: {}, console, chrome: global.chrome, RSParse: globalThis.RSParse }; c.window = c; c.window.__rsWorkMode = () => "creation"; vm.createContext(c);
    vm.runInContext(committed + ";this.__RS=RS;", c);
    let same = true;
    for (const id of ["creation", "blender"]) {
      window.__rsWorkMode = () => id; c.window.__rsWorkMode = () => id;
      same = same && c.__RS.workModePrompt(id) === RS.workModePrompt(id) && c.__RS.workModePrompt(id, { tight: true }) === RS.workModePrompt(id, { tight: true }) && c.__RS.workModeChecklist(id) === RS.workModeChecklist(id) && c.__RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" }) === RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" });
    }
    ok("A14 Totality + Blender prompts / checklists / full system prompts are byte-identical to the committed config.js", same);
  } else {
    ok("A14 (skipped: committed config.js already has the Animator label or git unavailable) labels present", config.includes('creation: "Totality", blender: "Blender", animate: "Animator"'));
  }
  window.__rsWorkMode = () => "creation";
}

// ── B. main.js ─────────────────────────────────────────────────────────────
const cut = (a, b) => { const i = main.indexOf(a), j = main.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor missing: " + a); return main.slice(i, j); };
const modesBlock = cut("  const WORK_MODES = {", "  const WORK_MODE_IDS");
const mctx = { window: null, console }; mctx.window = mctx; vm.createContext(mctx);
vm.runInContext(modesBlock + "\nthis.WORK_MODES = WORK_MODES;", mctx);
const M = mctx.WORK_MODES.animate;
ok("B1 WORK_MODES = creation + blender + animate; card copy, badge, toast", Object.keys(mctx.WORK_MODES).join() === "creation,blender,animate" && M.name === "Animator" && M.badge === "ANIMATOR" && M.short === "Animator" && /Rig → clip → preview on the rig → playback code → play-test/.test(M.sub) && /R6 and R15/.test(M.sub) && /Authored keyframes are not a published asset/.test(M.note) && /^Animator Work Mode — rig first, preview on the rig after every pass/.test(M.toast));
ok("B2 eight quick starts, every one an animation job that ends in a preview / play-test / verification", M.starters.length === 8 && ["3-hit combo", "Locomotion set", "Hit reaction + block", "Dash ability", "Emote", "Intro cutscene", "R6 port", "Fix my animation"].every((l) => M.starters.some((s) => s.label === l)) && M.starters.every((s) => /(preview|play-test|Play-test|re-run|screenshot)/i.test(s.prompt)));
ok("B3 the starters never ask for an upload by default and the emote one says so", M.starters.every((s) => !/publish it now|upload it/i.test(s.prompt)) && /do not publish unless I ask/.test(M.starters.find((s) => s.label === "Emote").prompt));
ok("B4 focus regex: animation / motion families + the playback script and play-test commands, not modeling / blueprints", ["animation_create", "animation_preview", "anim_player_install", "rig_joints_inspect", "rig_pose_reset", "motor6d_set", "sequence_create", "ability_sequence_create", "cutscene_create", "camera_shake", "camera_dolly", "tween_sequence", "spring_create", "script_create", "script_check", "start_stop_play", "studio_playtest", "get_console_output", "model_prefab", "sfx_event_play", "total_screenshot"].every((n) => M.focus.test(n)) && ["model_build", "blueprint_install", "blender_asset_build", "ui_screen_generate", "lighting_set_preset", "datastore_setup", "camera_shake_preset", "anim_blend_space", "ik_control_setup", "character_emote_play", "facial_animation_play", "spring_constraint_set"].every((n) => !M.focus.test(n)));
ok("B5 normaliser source unchanged (WORK_MODE_IDS-driven, folds unknown ids to creation) and the mode is declared the same way as Blender", main.includes('const normalizeWorkMode = (id) => (WORK_MODE_IDS.includes(id) ? id : "creation");') && main.includes("WORK_MODES.animate = {") && main.indexOf("WORK_MODES.animate = {") > main.indexOf("WORK_MODES.blender = {"));
// families + catalogue
{
  const manifest = JSON.parse(read("manifest.json"));
  const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
  for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib)/.test(f))) vm.runInThisContext(read(f), { filename: f });
  const block = cut("  const UNIVERSAL_COMMANDS = [", "  const UNIVERSAL_SET") + cut("  const PRIORITY_COMMAND_RE", "  // ── Project Index map cache (1.32) ──") + "\n" + modesBlock;
  const ctx = { window: null, console, RS: { TOOL_NOTES: {} }, bareToolName: (n) => String(n).split("/").pop(), RobloxScriptSkills, RSAnim, PublicSkills: undefined, TotalTaskList: undefined, WORK_MODE_IDS: ["creation", "blender", "animate"] };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(block + "\nthis.buildCatalogue=buildCatalogue;this.commandFamily=commandFamily;this.COMMAND_FAMILIES=COMMAND_FAMILIES;this.FAMILY_ORDER=FAMILY_ORDER;", ctx);
  ok("B6 FAMILY_ORDER.animate: animation, motion, script first; every family exactly once; creation / blender orders untouched", ctx.FAMILY_ORDER.animate.slice(0, 3).join() === "animation,motion,script" && new Set(ctx.FAMILY_ORDER.animate).size === ctx.COMMAND_FAMILIES.length && ctx.COMMAND_FAMILIES.every((f) => ctx.FAMILY_ORDER.animate.includes(f.id)) && ctx.FAMILY_ORDER.creation.slice(0, 3).join() === "script,blueprint,data" && ctx.FAMILY_ORDER.blender.slice(0, 3).join() === "blender,build,script");
  ok("B7 commandFamily routes the Animator focus to animation / motion", ["animation_create", "anim_player_install", "rig_joints_inspect", "rig_pose_reset", "sequence_create", "ability_sequence_create", "animation_publish"].every((n) => ctx.commandFamily(n) === "animation") && ["tween_sequence", "spring_create", "camera_shake", "cutscene_create"].every((n) => ctx.commandFamily(n) === "motion"));
  const native = [
    { name: "execute_luau", inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } },
    { name: "get_studio_state", inputSchema: { type: "object", properties: {} } },
    { name: "script_read", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
  ];
  const cats = {};
  for (const mode of ["creation", "animate"]) {
    ctx.window.__rsWorkMode = () => mode;
    cats[mode] = ctx.buildCatalogue({ toolName: "list_commands", requested: "roblox", heading: "━━━ COMMAND CATALOGUE (embedded) ━━━", nativeTools: native, virtualLines: [...RSAnim.describeCommands(), ...RobloxScriptSkills.describeCommands()], webLines: [], focusBlock: `━━━ ${mode.toUpperCase()} WORK MODE FOCUS ━━━\n\n`, focusNames: [], compact: true, limit: 20000, lineLimit: 420, modeId: mode });
  }
  const fams = (t) => [...t.matchAll(/^── (.+?) \(\d+\) ──$/gm)].map((m) => m[1]);
  ok("B8 real buildCatalogue: Animator mode lists the ANIMATION family first, then the motion family, then SCRIPTING", /^ANIMATION/.test(fams(cats.animate)[0] || "") && /TWEEN|CAMERA|MOTION/i.test(fams(cats.animate)[1] || "") && fams(cats.animate)[2] === "SCRIPTING", fams(cats.animate).slice(0, 4));
  ok("B9 Totality catalogue order unchanged (scripting first) and both within budget", fams(cats.creation).slice(0, 2).join("|") === "SCRIPTING|SYSTEM BLUEPRINTS" && cats.creation.length <= 20000 && cats.animate.length <= 20000);
}
// evidence gates
{
  const gateBlock = cut("  const MODE_GATES = {", "  // Returns the gate nudge for the active mode") + cut("  function modeGateNudge(runTools) {", "  // 1.38.0: skill programs that legitimately run long");
  const g = { window: { __rsWorkMode: () => "animate" }, normalizeWorkMode: (id) => (["creation", "blender", "animate"].includes(id) ? id : "creation"), bareToolName: (n) => String(n).split("/").pop(), WORK_MODES: { creation: { badge: "TOTALITY" }, blender: { badge: "BLENDER" }, animate: { badge: "ANIMATOR" } } };
  vm.createContext(g); vm.runInContext(gateBlock + "\nthis.modeGateNudge=modeGateNudge;this.MODE_GATES=MODE_GATES;", g);
  ok("B10 MODE_GATES.animate = rig + playback + shared scripts + look (creation / blender gates untouched)", g.MODE_GATES.animate.map((x) => x.id).join() === "rig,playback,scripts,look" && g.MODE_GATES.creation.map((x) => x.id).join() === "scripts,look,motion,quality,systems" && g.MODE_GATES.blender.map((x) => x.id).join() === "asset,import,scripts,look" && g.MODE_GATES.animate[2] === g.MODE_GATES.creation[0] && g.MODE_GATES.animate[3] === g.MODE_GATES.creation[1]);
  ok("B11 rig gate fires on authored clips / sequences / cutscenes that were never previewed", /ANIMATOR GATE[\s\S]*- RIG:/.test(g.modeGateNudge(new Set(["animation_select_rig", "animation_create", "animation_add_keyframe"]))) && /- RIG:/.test(g.modeGateNudge(new Set(["animation_generate"]))) && /- RIG:/.test(g.modeGateNudge(new Set(["sequence_create", "sequence_validate"]))) && /- RIG:/.test(g.modeGateNudge(new Set(["cutscene_create", "cutscene_shot_add"]))) && /- RIG:/.test(g.modeGateNudge(new Set(["animation_polish"]))));
  ok("B12 rig gate silent once previewed / validated / simulated / play-tested", g.modeGateNudge(new Set(["animation_create", "animation_add_keyframe", "animation_preview"])) === "" && g.modeGateNudge(new Set(["animation_generate", "animation_validate"])) === "" && g.modeGateNudge(new Set(["sequence_create", "sequence_preview"])) === "" && g.modeGateNudge(new Set(["cutscene_create", "cutscene_preview"])) === "" && g.modeGateNudge(new Set(["animation_refine", "start_stop_play"])) === "");
  ok("B13 playback gate fires on anim_player_install without read-back / play-test and is silent with proof", /- PLAYBACK:/.test(g.modeGateNudge(new Set(["anim_player_install"]))) && g.modeGateNudge(new Set(["anim_player_install", "script_check"])) === "" && g.modeGateNudge(new Set(["anim_player_install", "start_stop_play"])) === "");
  ok("B14 read-only animation runs never trip the gates (select rig, inspect, preview, validate, screenshot)", g.modeGateNudge(new Set(["animation_select_rig", "rig_joints_inspect", "animation_inspect", "animation_preview", "animation_validate", "total_screenshot", "get_studio_state"])) === "" && g.modeGateNudge(new Set(["cutscene_list", "sequence_list", "animation_compatibility"])) === "");
  ok("B15 shared gates still fire in Animator mode (scripts without read-back, look without screenshot) and merge into ONE note", (() => { const n = g.modeGateNudge(new Set(["animation_create", "script_create", "lighting_set_preset"])); return /System note from TotalScript, not the user/.test(n) && n.includes("- RIG:") && n.includes("- SCRIPTS:") && n.includes("- LOOK:") && (n.match(/ANIMATOR GATE/g) || []).length === 1; })());
  ok("B16 the rig nudge names the real proof commands", /animation_preview on the pinned rig/.test(g.MODE_GATES.animate[0].nudge) && /sequence_preview \/ cutscene_preview/.test(g.MODE_GATES.animate[0].nudge) && /animation_validate/.test(g.MODE_GATES.animate[0].nudge) && /script_read the playback script, script_check it, then start_stop_play \+ get_console_output/.test(g.MODE_GATES.animate[1].nudge));
  g.window.__rsWorkMode = () => "creation";
  ok("B17 in Totality the Animator gates do not exist (its own MOTION gate governs animation there)", !/- RIG:|- PLAYBACK:/.test(g.modeGateNudge(new Set(["animation_create", "anim_player_install"]))) && /- MOTION:/.test(g.modeGateNudge(new Set(["animation_create"]))));
}
ok("B18 skill_intel: the loop passes the active work mode into analyze and MODE_BIAS.animate exists (source)", /TotalSkillIntel\.analyze\(text, \{ engine: activeEngine\(\), task: A\.task, mode: normalizeWorkMode\(window\.__rsWorkMode && window\.__rsWorkMode\(\)\) \}\)/.test(main) && /MODE_BIAS = \{[\s\S]*?animate: \{ animation: 6, cinematics: 3, sfx: 1 \}/.test(read("src/core/skill_intel.js")));
ok("B19 settings tray stays data-driven: cards come from WORK_MODE_IDS, no hard-coded third card", main.includes("${WORK_MODE_IDS.map((id) => `<button type=\"button\" class=\"rs-work-card ${workMode===id&&!publicMode()?\"on\":\"\"}\" data-work=\"${id}\"") && !main.includes('data-work="animate"'));

// ── C. UI ──────────────────────────────────────────────────────────────────
ok("C1 overlay.css: violet Animator badge + card accent + selected card; Totality / Blender rules untouched", css.includes('#rs-work-badge[data-work="animate"]') && /#rs-work-badge\[data-work="animate"\][^\n]*#a78bfa/.test(css) && css.includes('.rs-work-modes .rs-work-card[data-work="animate"]::before') && css.includes('html[data-rs-theme] .rs-work-modes .rs-work-card[data-work="animate"].on {') && css.includes('#rs-work-badge[data-work="creation"]   { background: linear-gradient(135deg, #9ff3ff 0%, #22d3ee 45%, #0e7490 100%)') && css.includes('#rs-work-badge[data-work="blender"]    { background: linear-gradient(135deg, #ffd9a8 0%, #f5792a 45%, #a63d12 100%)'));
ok("C2 popup.js: WORK_MODES + preset; legacy map still folds the old 'animator' id to creation", popup.includes('const WORK_MODES = ["creation", "blender", "animate"];') && /animate: \{ thinking: "max", extra: false \}/.test(popup) && popup.includes('const LEGACY_WORK_MODES = { ultimate: "creation", visualizer: "creation", animator: "creation", adaptive: "creation" };'));
ok("C3 popup.html: Animator card + violet selected style + three-column grid; the other two cards unchanged", popupHtml.includes('<button type="button" class="work-card" data-work="animate" id="work-animate">') && popupHtml.includes('<span class="work-name">Animator</span>') && popupHtml.includes("#work-animate.on{background:linear-gradient(135deg,#ddd6fe 0%,#a78bfa 45%,#5b21b6 100%)") && popupHtml.includes(".work.work-modes{grid-template-columns:1fr 1fr 1fr}") && (popupHtml.match(/class="work-card" data-work="/g) || []).length === 3 && popupHtml.includes('id="work-creation"') && popupHtml.includes('id="work-blender"'));

// ── D. README ──────────────────────────────────────────────────────────────
ok("D1 README documents the Animator mode (1.99.4) with the honest framing", /1\.99\.4/.test(readme) && /Animator/.test(readme) && /animate/.test(readme) && /(preview|played) on the (actual )?rig/i.test(readme));

console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
process.exit(failed ? 1 : 0);
