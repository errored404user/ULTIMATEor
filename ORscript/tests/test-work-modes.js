"use strict";
// 1.21 — Ultimate (default) + Visualizer and Animator specialists on top of it.
const fs = require("fs"), assert = require("assert");
const main = fs.readFileSync("src/core/main.js", "utf8"), config = fs.readFileSync("src/core/config.js", "utf8"),
  css = fs.readFileSync("overlay.css", "utf8"), popup = fs.readFileSync("popup.js", "utf8"), popupHtml = fs.readFileSync("popup.html", "utf8");

// model + persistence
assert(main.includes("const WORK_MODES = {") && main.includes("ultimate: {") && main.includes("visualizer: {") && main.includes("animator: {"), "WORK_MODES model");
assert(!/\badaptive\b\s*:/.test(main) && !main.includes('"adaptive"'), "adaptive mode is gone from main.js");
assert(main.includes('const normalizeWorkMode = (id) => (WORK_MODE_IDS.includes(id) ? id : "ultimate")'), "legacy presets + adaptive normalise to ultimate");
assert(main.includes('let workMode = "ultimate"') && main.includes('rsWorkMode:"ultimate"'), "ultimate is the default and the migration target");
assert(main.includes("workMode = normalizeWorkMode(r.rsWorkMode);"), "stored mode is restored, not forced to the default");
assert(main.includes("chrome.storage.local.set({rsWorkMode: workMode})"), "setWorkMode persists the chosen mode");
assert(main.includes("WORK_MODE_IDS.includes(changes.rsWorkMode.newValue)"), "popup changes propagate for all modes");
assert(main.includes('data-work="${id}"') && main.includes('WORK_MODE_IDS.map((id) =>'), "settings tray renders one card per mode");
assert(main.includes('<span id="rs-work-badge" hidden></span>') && main.includes('function syncWorkModeUi()') && main.includes('setAttribute("data-rs-work", workMode)'), "bar badge + html flag");

// focus regexes cover the right families and nothing else
const ult = eval(main.match(/focus: (\/\^\(script_[^\n]*\/),\n/)[1]), vis = eval(main.match(/focus: (\/\^\(fx_[^\n]*\/),\n/)[1]), ani = eval(main.match(/focus: (\/\^\(animation_[^\n]*\/),\n/)[1]);
for (const n of ["script_create", "script_read", "script_set_source", "script_analysis", "execute_luau", "multi_edit", "instance_find", "part_create", "meshpart_create", "model_group", "weld_assemble", "material_set", "terrain_height", "remote_event_create", "datastore_setup", "ds_update", "physics_anchor_all", "staircase_generate", "generate_procedural_model", "or_screenshot", "start_stop_play"]) assert(ult.test(n), "ultimate focus must include " + n);
for (const n of ["fx_magic_circle", "ui_build", "animation_create", "tween_create", "lighting_set", "camera_shake"]) assert(!ult.test(n), "ultimate must not claim " + n);
for (const n of ["fx_magic_circle", "vfx_beam_arc_create", "lighting_set_preset", "atmosphere_set", "bloom_set", "ui_design_system_create", "ui_responsive_hud_create", "loading_screen_build", "beam_create", "trail_create", "point_light_add", "or_screenshot"]) assert(vis.test(n), "visualizer focus: " + n);
for (const n of ["animation_create", "animation_add_keyframe", "animation_set_easing", "animation_preview", "tween_create", "spring_create", "ik_control_setup", "camera_shake_preset", "cutscene_camera_track", "anim_blend_space", "or_screenshot"]) assert(ani.test(n), "animator focus: " + n);
for (const n of ["script_write", "execute_luau", "part_create", "datastore_get", "remote_event_create", "animation_create"]) assert(!vis.test(n), "visualizer must not claim " + n);
for (const n of ["script_write", "execute_luau", "ui_build", "fx_create_emitter", "rigid_constraint_create"]) assert(!ani.test(n), "animator must not claim " + n);
assert(main.includes("WORK MODE FOCUS — ${focusNames.length} commands you are expected to use heavily"), "list_commands surfaces the focus family first");
assert(main.includes("if (!commandQuery && WORK_MODES[focusMode] && WORK_MODES[focusMode].focus) {"), "focus block applies to every mode with a focus set (incl. ultimate)");
assert(main.includes("return intro + universalBlock + (focusBlock || \"\") + webBlock + detailBlock + sigBlock + namesBlock + tail;") && main.includes("focusBlock, focusNames, compact, limit, lineLimit,"), "focus block on both compact and full catalogues (buildCatalogue)");
assert(main.includes("const detail = []; // tier 1: full schemas") || main.includes("function buildCatalogue(o)"), "catalogue builder exists");

// prompt layers (1.34): one shared OPERATING LOOP + one DISTINCT profile per
// mode, full and tight variants, exposed as RS.workModePrompt / workModeChecklist
// / workModeSwitchNote. Before 1.34 every mode carried the 18k Ultimate text
// plus a 9k specialist block (Visualizer prompt 55k; "tight" 25k on a 14k budget).
assert(config.includes("const WORK_MODE_LOOP = {") && config.includes("const WORK_MODE_PROMPTS = {") && config.includes("function workModePrompt(wm, opts)"), "mode prompt module");
assert(config.includes('modeExtra += "\\n\\n" + workModePrompt(wm, { tight: !!tightBudget });'), "system prompt uses the module (tight variant on small budgets)");
assert(config.includes("const tightBudget = maxChars && maxChars < 16000;"), "condensed mandate for providers with a small system-prompt budget");
assert(!/adaptive/i.test(config), "no adaptive wording left in prompts");
for (const k of ["workModePrompt,", "workModeChecklist,", "workModeSwitchNote,", "WORK_MODE_PROMPTS,"]) assert(config.includes(k), "RS exports " + k);
const vm = require("vm");
global.window = global; global.chrome = { runtime: { getURL: () => "" }, storage: { local: { get() {}, set() {} } } };
vm.runInThisContext(config + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
const blocks = {};
for (const wm of ["ultimate", "visualizer", "animator"]) {
  const full = RS.workModePrompt(wm), tight = RS.workModePrompt(wm, { tight: true });
  assert(full.startsWith("━━━ OPERATING LOOP (every work mode) ━━━") && tight.startsWith("━━━ OPERATING LOOP ━━━"), wm + ": shared loop first");
  assert(full.includes("━━━ " + wm.toUpperCase() + " WORK MODE") && tight.includes("━━━ " + wm.toUpperCase() + " WORK MODE"), wm + ": own heading");
  assert(full.length > 5500 && full.length < 11000, wm + ": full profile is substantial but bounded (" + full.length + ")"); // 1.38.0: + PLAYBOOKS
  assert(tight.length > 1500 && tight.length < 3600, wm + ": tight profile fits a 14k budget (" + tight.length + ")");
  for (const other of ["ultimate", "visualizer", "animator"]) if (other !== wm) assert(!full.includes("━━━ " + other.toUpperCase() + " WORK MODE"), wm + " must not stack " + other);
  assert(/FIRST MOVE:/.test(full) && /NEVER:/.test(full), wm + ": first move + never list");
  assert(RS.workModeChecklist(wm).startsWith(wm.toUpperCase() + " CHECK:"), wm + ": reminder checklist");
  const note = RS.workModeSwitchNote(wm);
  assert(note.startsWith("━━━ WORK MODE SWITCHED → " + wm.toUpperCase()) && note.includes("Do not acknowledge this note") && !note.includes("━━━ OPERATING LOOP"), wm + ": switch note = profile only");
  blocks[wm] = full + "\n" + tight;
  // every mode's live prompt stays within budget on a tight provider
  window.__rsWorkMode = () => wm;
  const t = RS.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000 });
  assert(t.length <= 14000, wm + ": tight system prompt within 14k (" + t.length + ")");
  const f = RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" });
  assert(f.length < 40000, wm + ": full system prompt under 40k (" + f.length + ")");
}
const ultBlock = blocks.ultimate, visBlock = blocks.visualizer, aniBlock = blocks.animator;
for (const s of ["LUAU ENGINEERING MANDATE", "MODELING MANDATE", "READ BEFORE YOU WRITE", "APPROVAL ONLY FOR RISK", "VERIFY DEEPLY", "FINISH WITH EVIDENCE", "server authority", "--!strict", "script_read", "script_create", "execute_luau", "remote_event_create", "blueprint_install", "project_index_build", "design_tokens_set", "model_build", "or_screenshot"]) assert(ultBlock.includes(s), "ultimate prompt covers " + s);
for (const s of ["READ THE SCENE", "SET THE MOOD FIRST", "LAYER THE VFX", "DESIGN THE UI AS A SYSTEM", "PROVE IT WITH PIXELS", "BUDGET", "HAND-OFF", "or_screenshot", "ui_design_system_create", "fx_magic_circle", "NumberSequence", "VISUAL SPEC", "gfx_capture"]) assert(visBlock.includes(s), "visualizer prompt covers " + s);
for (const s of ["READ THE RIG", "BLOCK THE KEYS", "POLISH THE CURVES", "RUNTIME MOTION", "CAMERA IS ANIMATION TOO", "PREVIEW OR IT DID NOT HAPPEN", "SHIP IT CLEANLY", "animation_preview", "animation_set_easing", "anticipation", "follow-through", "MOTION SPEC", "eclipse_handoff"]) assert(aniBlock.includes(s), "animator prompt covers " + s);
// batching is taught in the loop (1.34: up to 6 independent commands per reply)
assert(/BATCH up to 6 INDEPENDENT commands per reply/.test(ultBlock) && /batch up to 6 independent commands per reply/.test(RS.workModePrompt("animator", { tight: true })), "loop teaches batching");
// every command cited in the prompts must exist somewhere in the source
const src = ["src/core", "src/providers"].flatMap((d) => fs.readdirSync(d, { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(d + "/" + f, "utf8"))).join("\n");
const cited = [...new Set([...(ultBlock + visBlock + aniBlock + Object.values(["ultimate", "visualizer", "animator"].map(RS.workModeChecklist)).join(" ")).matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]))];
const missing = cited.filter((n) => !new RegExp("[\"'`]" + n + "[\"'`:]|\\b" + n + "\\s*:").test(src));
assert.deepStrictEqual(missing, [], "prompts cite unknown commands: " + missing.join(", "));

// main.js wiring (1.34): starters per mode, light mode-switch rider, checklist in the reminder
for (const id of ["ultimate", "visualizer", "animator"]) assert(new RegExp(id + ": \\{[\\s\\S]{0,1400}starters: \\[").test(main), id + " has quick-start prompts");
assert(main.includes('data-work-starter="${i}"') && main.includes('menuEl.querySelectorAll("[data-work-starter]")') && main.includes("pasteLibraryCard({ title: q.label, prompt: q.prompt }, { silent: true })"), "quick starts render under the mode cards and paste into the composer");
assert(main.includes("A.workModeSwitchPending = true; A.forceSysResend = true;") && main.includes("if (A.workModeSwitchPending && !periodicDue) {") && main.includes("RS.workModeSwitchNote(mode, { tight })") && main.includes("function workModeFocusSignatures(limitChars)"), "mode switch sends a short profile + focus signatures rider, not the whole prompt");
assert(main.includes("modeCheck = RS.workModeChecklist(normalizeWorkMode(window.__rsWorkMode && window.__rsWorkMode()))"), "periodic reminder carries the mode checklist");
assert(css.includes(".rs-work-starters") && css.includes(".rs-work-starter:hover { background: var(--orx-grad); box-shadow: var(--orx-glow);"), "quick-start pills styled with the theme pill tokens");

// popup + css
assert(popup.includes('const WORK_MODES = ["ultimate", "visualizer", "animator"]') && popup.includes("WORK_HELP[settings.workMode]") && popup.includes('workMode: "ultimate"'), "popup modes");
for (const id of ["ultimate", "visualizer", "animator"]) assert(popupHtml.includes(`id="work-${id}"`), "popup card " + id);
assert(!popupHtml.includes('data-work="adaptive"') && !popup.includes("adaptive"), "popup has no adaptive leftovers");
assert(css.includes('#rs-work-badge[data-work="ultimate"]') && css.includes('#rs-work-badge[data-work="visualizer"]') && css.includes('.rs-work-modes .rs-work-card[data-work="ultimate"].on') && css.includes('.rs-work-modes .rs-work-card[data-work="animator"].on') && css.includes(".rs-work-row.rs-work-ultimate"), "mode styling");
console.log(`PASS  work modes 1.34: shared loop + distinct ultimate / visualizer / animator profiles (full + tight), switch rider, quick starts — ${cited.length} cited commands all real`);
