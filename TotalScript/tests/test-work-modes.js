"use strict";
// 1.39.0 — ONE built-in work mode: Creation (the former Ultimate + Visualizer
// + Animator merged). This file keeps the 1.21 / 1.34 / 1.38 guarantees
// (model + persistence, focus coverage, prompt layers, popup + css) for the
// merged mode and adds the legacy → creation migration checks.
const fs = require("fs"), assert = require("assert");
const main = fs.readFileSync("src/core/main.js", "utf8"), config = fs.readFileSync("src/core/config.js", "utf8"),
  css = fs.readFileSync("overlay.css", "utf8"), popup = fs.readFileSync("popup.js", "utf8"), popupHtml = fs.readFileSync("popup.html", "utf8");

// model + persistence
assert(main.includes("const WORK_MODES = {") && main.includes("creation: {"), "WORK_MODES model");
for (const legacy of ["ultimate", "visualizer", "animator", "adaptive"]) assert(!new RegExp("\\b" + legacy + "\\b\\s*:\\s*\\{").test(main) && !main.includes('"' + legacy + '"'), legacy + " mode is gone from main.js");
assert(main.includes('const normalizeWorkMode = (id) => (WORK_MODE_IDS.includes(id) ? id : "creation")'), "legacy ids normalise to creation");
assert(main.includes('let workMode = "creation"') && main.includes('rsWorkMode:"creation"'), "creation is the default and the migration target");
assert(main.includes("workMode = normalizeWorkMode(r.rsWorkMode);"), "stored mode is restored through the normaliser");
assert(main.includes("chrome.storage.local.set({rsWorkMode: workMode})"), "setWorkMode persists the chosen mode");
// 1.42.0: the storage listener normalises the incoming id (a legacy id from an
// old popup/tab used to be ignored, leaving the two surfaces out of sync).
assert(main.includes("workMode = normalizeWorkMode(changes.rsWorkMode.newValue);") && !main.includes("WORK_MODE_IDS.includes(changes.rsWorkMode.newValue)"), "popup changes propagate (normalised)");
assert(main.includes('data-work="${id}"') && main.includes('WORK_MODE_IDS.map((id) =>'), "settings tray renders one card per built-in mode");
assert(main.includes('<span id="rs-work-badge" hidden></span>') && main.includes("function syncWorkModeUi()") && main.includes('setAttribute("data-rs-work", workMode)'), "bar badge + html flag");
assert(main.includes('name: "Totality", badge: "TOTALITY", short: "Totality"'), "creation card + badge");

// focus regex = union of the three former families
const focusSrc = main.match(/focus: (\/\^\(script_[^\n]*\/),\n/);
assert(focusSrc, "creation focus regex");
const focus = eval(focusSrc[1]);
for (const n of [
  // ultimate family
  "script_create", "script_read", "script_set_source", "script_analysis", "execute_luau", "multi_edit", "instance_find", "part_create", "meshpart_create", "model_group", "weld_assemble", "material_set", "terrain_height", "remote_event_create", "datastore_setup", "blueprint_install", "project_index_build", "module_scaffold", "total_screenshot",
  // visualizer family
  "fx_magic_circle", "vfx_beam_arc_create", "lighting_set_preset", "atmosphere_set", "bloom_set", "ui_design_system_create", "ui_responsive_hud_create", "loading_screen_build", "beam_create", "trail_create", "point_light_add", "design_tokens_set", "gfx_capture", "postfx_cinematic",
  // animator family
  "animation_create", "animation_add_keyframe", "animation_set_easing", "animation_preview", "tween_create", "spring_create", "ik_control_setup", "camera_shake_preset", "cutscene_camera_track", "anim_blend_space", "rig_joints_inspect",
]) assert(focus.test(n), "creation focus must claim " + n);
for (const n of ["list_commands", "search_commands", "web_fetch", "task_add", "public_skill_create"]) assert(!focus.test(n), "creation focus must not claim " + n);
assert(main.includes("WORK MODE FOCUS — ${focusNames.length} commands you are expected to use heavily"), "list_commands surfaces the focus family first");
assert(main.includes("if (!commandQuery && WORK_MODES[focusMode] && WORK_MODES[focusMode].focus) {"), "focus block applies to the mode's focus set");
assert(main.includes("return intro + universalBlock + (focusBlock || \"\") + webBlock + detailBlock + sigBlock + namesBlock + tail;") && main.includes("focusBlock, focusNames, compact, limit, lineLimit,"), "focus block on both compact and full catalogues");
assert(main.includes("const FAMILY_ORDER = {") && /creation: \["script", "blueprint", "data", "build", "physics", "lighting", "vfx", "ui", "animation", "motion"/.test(main) && main.includes("FAMILY_ORDER[modeId] || FAMILY_ORDER.creation"), "one merged family order");

// gates: three checks inside one mode, merged into one nudge
assert(/const MODE_GATES = \{[\s\S]*?creation: \[[\s\S]*?id: "scripts"[\s\S]*?id: "look"[\s\S]*?id: "motion"[\s\S]*?\],\s*\};/.test(main), "MODE_GATES.creation lists the scripts / look / motion gates");
assert(main.includes('const failing = gates.filter((g) => bare.some((b) => g.did.test(b)) && !bare.some((b) => g.proof.test(b)));') && main.includes('" GATE (System note from TotalScript, not the user) ━━━\\n"'), "modeGateNudge merges the failing gates");

// prompt layers: one shared OPERATING LOOP + ONE profile (full + tight)
assert(config.includes("const WORK_MODE_LOOP = {") && config.includes("const WORK_MODE_PROMPTS = {") && config.includes("function workModePrompt(wm, opts)"), "mode prompt module");
assert(config.includes('modeExtra += "\\n\\n" + workModePrompt(wm, { tight: !!tightBudget });'), "system prompt uses the module (tight variant on small budgets)");
assert(config.includes("const tightBudget = maxChars && maxChars < 16000;"), "condensed mandate for providers with a small system-prompt budget");
assert(!/adaptive/i.test(config), "no adaptive wording left in prompts");
assert(config.includes('function normalizeModeId(wm) { return WORK_MODE_PROMPTS[wm] ? wm : "creation"; }'), "config normalises legacy ids to creation");
for (const k of ["workModePrompt,", "workModeChecklist,", "workModeSwitchNote,", "WORK_MODE_PROMPTS,"]) assert(config.includes(k), "RS exports " + k);
const vm = require("vm");
global.window = global; global.chrome = { runtime: { getURL: () => "" }, storage: { local: { get() {}, set() {} } } };
vm.runInThisContext(config + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
assert.deepStrictEqual(Object.keys(RS.WORK_MODE_PROMPTS), ["creation", "blender", "animate"], "exactly three built-in profiles: creation + blender (1.95.0; tests/test-blender-mode.js) + animate (1.99.7; tests/test-animator-mode.js)");
const wm = "creation";
const full = RS.workModePrompt(wm), tight = RS.workModePrompt(wm, { tight: true });
assert(full.startsWith("━━━ OPERATING LOOP (every work mode) ━━━") && tight.startsWith("━━━ OPERATING LOOP ━━━"), "shared loop first");
assert(full.includes("━━━ TOTALITY WORK MODE") && tight.includes("━━━ TOTALITY WORK MODE"), "own heading");
for (const legacy of ["ULTIMATE", "VISUALIZER", "ANIMATOR"]) assert(!full.includes("━━━ " + legacy + " WORK MODE") && !tight.includes("━━━ " + legacy + " WORK MODE"), "no stacked legacy heading " + legacy);
// three former profiles (6k + 4.5k + 4.6k) merged into one ~11k profile + 12 playbooks
assert(full.length > 12000 && full.length < 18500, "full profile is substantial but bounded (" + full.length + ")");
assert(tight.length > 2500 && tight.length < 3600, "tight profile fits a 14k budget (" + tight.length + ")");
assert(/FIRST MOVE:/.test(full) && /NEVER:/.test(full), "first move + never list");
assert(RS.workModeChecklist(wm).startsWith("TOTALITY CHECK:"), "reminder checklist");
const note = RS.workModeSwitchNote(wm);
assert(note.startsWith("━━━ WORK MODE SWITCHED → TOTALITY") && note.includes("Do not acknowledge this note") && !note.includes("━━━ OPERATING LOOP"), "switch note = profile only");
// legacy ids resolve to the same text everywhere
for (const legacy of ["ultimate", "visualizer", "animator", "adaptive", undefined, ""]) {
  assert.strictEqual(RS.workModePrompt(legacy), full, "workModePrompt(" + legacy + ") → creation");
  assert.strictEqual(RS.workModeChecklist(legacy), RS.workModeChecklist(wm), "checklist(" + legacy + ") → creation");
  assert.strictEqual(RS.workModeSwitchNote(legacy), note, "switch note(" + legacy + ") → creation");
}
// live prompt stays within budget on a tight provider
window.__rsWorkMode = () => wm;
const t = RS.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000 });
assert(t.length <= 14000, "tight system prompt within 14k (" + t.length + ")");
const f = RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" });
assert(f.length < 48000, "full system prompt under 48k (" + f.length + ")");
// the four mandates + the verification vocabulary of all three former modes
const block = full + "\n" + tight;
for (const s of [
  "LUAU ENGINEERING MANDATE", "MODELING MANDATE", "VISUAL MANDATE", "MOTION MANDATE", "READ BEFORE YOU WRITE", "APPROVAL ONLY FOR RISK", "VERIFY DEEPLY", "FINISH WITH EVIDENCE", "server authority", "--!strict", "script_read", "script_create", "execute_luau", "remote_event_create",
  "SET THE MOOD FIRST", "LAYER THE VFX", "DESIGN THE UI AS A SYSTEM", "PROVE IT WITH PIXELS", "BUDGET", "total_screenshot", "ui_design_system_create", "fx_magic_circle", "NumberSequence", "VISUAL SPEC", "gfx_capture",
  "READ THE RIG", "BLOCK THE KEYS", "POLISH THE CURVES", "RUNTIME MOTION", "CAMERA IS ANIMATION TOO", "PREVIEW OR IT DID NOT HAPPEN", "SHIP IT CLEANLY", "animation_preview", "animation_set_easing", "anticipation", "follow-through", "MOTION SPEC",
  "HAND-OFF", "blueprint_install", "project_index_build",
]) assert(block.includes(s), "creation profile mentions " + s);
for (const s of ["NEW SYSTEM:", "BUG FIX:", "EXISTING PLACE / REFACTOR:", "BUILD:", "MOOD PASS:", "HERO VFX:", "UI SCREEN:", "THUMBNAIL / ICON:", "COMBAT CLIP:", "LOCOMOTION LOOP:", "PROP / UI MOTION:", "CUTSCENE:"]) assert(full.includes("- " + s), "playbook " + s);
// batching is taught in the loop (1.34: up to 6 independent commands per reply)
assert(/BATCH up to 6 INDEPENDENT commands per reply/.test(full) && /batch up to 6 independent commands per reply/.test(tight), "loop teaches batching");
// every command cited in the prompts must exist somewhere in the source
const src = ["src/core", "src/providers"].flatMap((d) => fs.readdirSync(d, { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(d + "/" + f, "utf8"))).join("\n");
const cited = [...new Set([...(block + " " + RS.workModeChecklist(wm)).matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]))];
const missing = cited.filter((n) => !new RegExp("[\"'`]" + n + "[\"'`:]|\\b" + n + "\\s*:").test(src));
assert.deepStrictEqual(missing, [], "prompts cite unknown commands: " + missing.join(", "));

// main.js wiring (1.34): starters, light mode-switch rider, checklist in the reminder
assert(/creation: \{[\s\S]{0,1400}starters: \[/.test(main), "creation has quick-start prompts");
for (const label of ["Index this place", "Shop + currency", "Build a house", "Fix my errors", "Cinematic mood", "Hero spell VFX", "Game HUD", "Sword swing"]) assert(main.includes('{ label: "' + label + '"'), "quick start " + label);
assert(main.includes('data-work-starter="${i}"') && main.includes('menuEl.querySelectorAll("[data-work-starter]")') && main.includes("pasteLibraryCard({ title: q.label, prompt: q.prompt }, { silent: true })"), "quick starts render under the mode card and paste into the composer");
assert(main.includes("A.workModeSwitchPending = true; A.forceSysResend = true;") && main.includes("if (A.workModeSwitchPending && !periodicDue) {") && main.includes("RS.workModeSwitchNote(mode, { tight })") && main.includes("function workModeFocusSignatures(limitChars)"), "mode switch rider");
assert(main.includes("modeCheck = RS.workModeChecklist(normalizeWorkMode(window.__rsWorkMode && window.__rsWorkMode()))"), "periodic reminder carries the mode checklist");
assert(css.includes(".rs-work-starters") && css.includes(".rs-work-starter:hover { background: var(--totalx-grad); box-shadow: var(--totalx-glow);"), "quick-start pills styled with the theme pill tokens");

// popup + css
assert(popup.includes('const WORK_MODES = ["creation", "blender", "animate"]') && !popup.includes("WORK_HELP") && popup.includes('workMode: "creation"'), "popup modes (creation default + blender, 1.95.0)"); // 1.75.0: long help paragraph removed
assert(popup.includes('const LEGACY_WORK_MODES = { ultimate: "creation", visualizer: "creation", animator: "creation", adaptive: "creation" };') && popup.includes("settings.workMode = normalizeWorkMode(r.rsWorkMode)"), "popup migrates legacy stored ids");
assert(popupHtml.includes('id="work-creation"') && !popupHtml.includes('id="work-ultimate"') && !popupHtml.includes('id="work-visualizer"') && !popupHtml.includes('id="work-animator"'), "popup has exactly the creation card");
assert(!popupHtml.includes('data-work="adaptive"') && !popup.includes('"adaptive"'), "popup has no adaptive leftovers");
assert(css.includes('#rs-work-badge[data-work="creation"]') && css.includes('.rs-work-modes .rs-work-card[data-work="creation"].on') && css.includes(".rs-work-row.rs-work-creation") && main.includes("rs-work-row rs-work-creation rs-work-modes"), "creation badge + card + row styles");
for (const legacy of ["ultimate", "visualizer", "animator"]) assert(!css.includes('data-work="' + legacy + '"'), "css has no " + legacy + " card left");
console.log(`PASS  work modes 1.39: one Creation profile (loop + four mandates + 12 playbooks, full ${full.length} / tight ${tight.length}), legacy ids migrate, merged gates, quick starts — ${cited.length} cited commands all real`);
