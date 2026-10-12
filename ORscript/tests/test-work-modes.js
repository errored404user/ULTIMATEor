"use strict";
// 1.19.8 — Visualizer and Animator work modes sit on top of Adaptive.
const fs = require("fs"), assert = require("assert");
const main = fs.readFileSync("src/core/main.js", "utf8"), config = fs.readFileSync("src/core/config.js", "utf8"),
  css = fs.readFileSync("overlay.css", "utf8"), popup = fs.readFileSync("popup.js", "utf8"), popupHtml = fs.readFileSync("popup.html", "utf8");

// model + persistence
assert(main.includes("const WORK_MODES = {") && main.includes("visualizer: {") && main.includes("animator: {"), "WORK_MODES model");
assert(main.includes('const normalizeWorkMode = (id) => (WORK_MODE_IDS.includes(id) ? id : "adaptive")'), "legacy presets normalise to adaptive");
assert(main.includes("workMode = normalizeWorkMode(r.rsWorkMode);"), "stored mode is restored, not forced to adaptive");
assert(main.includes("chrome.storage.local.set({rsWorkMode: workMode})"), "setWorkMode persists the chosen mode");
assert(main.includes("WORK_MODE_IDS.includes(changes.rsWorkMode.newValue)"), "popup changes propagate for all modes");
assert(main.includes('data-work="${id}"') && main.includes('WORK_MODE_IDS.map((id) =>'), "settings tray renders one card per mode");
assert(main.includes('<span id="rs-work-badge" hidden></span>') && main.includes('function syncWorkModeUi()') && main.includes('setAttribute("data-rs-work", workMode)'), "bar badge + html flag");

// focus regexes cover the right families and nothing else
const vis = eval(main.match(/focus: (\/\^\(fx_[^\n]*\/),\n/)[1]), ani = eval(main.match(/focus: (\/\^\(animation_[^\n]*\/),\n/)[1]);
for (const n of ["fx_magic_circle", "vfx_beam_arc_create", "lighting_set_preset", "atmosphere_set", "bloom_set", "ui_design_system_create", "ui_responsive_hud_create", "loading_screen_build", "beam_create", "trail_create", "point_light_add", "query_particle_emitters", "or_screenshot"]) assert(vis.test(n), "visualizer focus: " + n);
for (const n of ["animation_create", "animation_add_keyframe", "animation_set_easing", "animation_preview", "tween_create", "spring_create", "ik_control_setup", "camera_shake_preset", "cutscene_camera_track", "anim_blend_space", "or_screenshot"]) assert(ani.test(n), "animator focus: " + n);
for (const n of ["script_write", "execute_luau", "part_create", "datastore_get", "remote_event_create", "animation_create"]) assert(!vis.test(n), "visualizer must not claim " + n);
for (const n of ["script_write", "execute_luau", "ui_build", "fx_create_emitter", "rigid_constraint_create"]) assert(!ani.test(n), "animator must not claim " + n);
assert(main.includes("WORK MODE FOCUS — ${focusNames.length} commands you are expected to use heavily"), "list_commands surfaces the focus family first");
assert(main.includes("return intro + focusBlock + chosen.join") && main.includes("${focusBlock}${requested} commands"), "focus block on both compact and full catalogues");

// prompt layers: Adaptive stays the base; specialists add a mandate + pipeline + verification
assert(config.includes('if (["adaptive", "visualizer", "animator"].includes(wm)) modeExtra += `\\n\\n━━━ ADAPTIVE WORK MODE'), "adaptive block is the base for every mode");
const visBlock = config.slice(config.indexOf("━━━ VISUALIZER WORK MODE"), config.indexOf("━━━ ANIMATOR WORK MODE"));
const aniBlock = config.slice(config.indexOf("━━━ ANIMATOR WORK MODE"), config.indexOf("} catch {}", config.indexOf("━━━ ANIMATOR WORK MODE")));
assert(visBlock.length > 3000 && aniBlock.length > 3000, "specialist prompts are substantial");
for (const s of ["READ THE SCENE", "SET THE MOOD FIRST", "LAYER THE VFX", "DESIGN THE UI AS A SYSTEM", "PROVE IT WITH PIXELS", "BUDGET", "HAND-OFF", "or_screenshot", "ui_design_system_create", "fx_magic_circle", "NumberSequence", "VISUAL SPEC"]) assert(visBlock.includes(s), "visualizer prompt: " + s);
for (const s of ["READ THE RIG", "BLOCK THE KEYS", "POLISH THE CURVES", "RUNTIME MOTION", "CAMERA IS ANIMATION TOO", "PREVIEW OR IT DID NOT HAPPEN", "SHIP IT CLEANLY", "animation_preview", "animation_set_easing", "anticipation", "follow-through", "MOTION SPEC"]) assert(aniBlock.includes(s), "animator prompt: " + s);
// every command cited in the specialist prompts must exist somewhere in the source
const src = ["src/core", "src/providers"].flatMap((d) => fs.readdirSync(d, { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(d + "/" + f, "utf8"))).join("\n");
const cited = [...new Set([...(visBlock + aniBlock).matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]))];
const missing = cited.filter((n) => !new RegExp("[\"'`]" + n + "[\"'`:]|\\b" + n + "\\s*:").test(src));
assert.deepStrictEqual(missing, [], "prompts cite unknown commands: " + missing.join(", "));

// popup + css
assert(popup.includes('const WORK_MODES = ["adaptive", "visualizer", "animator"]') && popup.includes("WORK_HELP[settings.workMode]"), "popup modes");
for (const id of ["visualizer", "animator"]) assert(popupHtml.includes(`id="work-${id}"`), "popup card " + id);
assert(css.includes('#rs-work-badge[data-work="visualizer"]') && css.includes('.rs-work-modes .rs-work-card[data-work="animator"].on'), "mode styling");
console.log(`PASS  work modes: adaptive + visualizer (${cited.length} cited commands all real) + animator`);
