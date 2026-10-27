#!/usr/bin/env node
// Static + build checks for the Thumbnail & Icon Studio (src/core/skills/studio_gfx.js, 1.30.0):
// registration, bundles, schemas, styles / poses / faces / cameras / fx tables, generated
// Luau shape, the gfx_capture composite in main.js (photo -> crop -> PNG), prompt/help
// wiring and the version pins. Runtime behaviour is covered by tests/gfx-sim.py (lupa).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("PASS  " + name);
  else {
    failed++;
    console.log("FAIL  " + name + (detail ? " — " + String(detail).slice(0, 400) : ""));
  }
}

// ── bundles ───────────────────────────────────────────────────────────────────
global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
ok("every main.js bundle loads studio_gfx.js right after studio_design.js and before main.js", bundles.length >= 10 && bundles.every((b) => {
  const i = b.js.indexOf("src/core/skills/studio_design.js");
  return i >= 0 && b.js[i + 1] === "src/core/skills/studio_gfx.js" && b.js.indexOf("src/core/main.js") > i + 1;
}));
ok("codecraft.html loads studio_gfx.js after studio_design.js", (() => {
  const h = fs.readFileSync("codecraft.html", "utf8");
  return h.indexOf("studio_gfx.js") > h.indexOf("studio_design.js") && h.indexOf("studio_gfx.js") < h.indexOf("src/core/main.js");
})());

const files = bundles[0].js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f));
for (const f of files) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = vm.runInThisContext("typeof RobloxScriptSkills !== 'undefined' ? RobloxScriptSkills : undefined");
ok("RobloxScriptSkills exposes the gfx pack tables", S && Array.isArray(S.GFX_COMMANDS) && S.GFX_STYLES && S.GFX_POSES && S.GFX_FACES && S.GFX_CAMERAS && S.GFX_FX && S.GFX_VERSION === "1.30.0");

const EXPECTED = ["gfx_stage_create", "gfx_subject_add", "gfx_pose", "gfx_prop_add", "gfx_camera", "gfx_overlay", "gfx_fx", "gfx_lighting", "gfx_capture", "gfx_brief", "gfx_teardown"];
ok("11 gfx commands", S.GFX_COMMANDS.length === 11 && EXPECTED.every((n) => S.GFX_COMMANDS.includes(n)), S.GFX_COMMANDS.join(","));
const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));
ok("gfx commands registered in SKILL_COMMANDS with descriptions + params", EXPECTED.every((n) => byName.has(n) && byName.get(n).description.length > 60 && byName.get(n).params && typeof byName.get(n).params === "object"));
ok("SKILL_OPS contains the gfx ops", EXPECTED.every((n) => S.SKILL_OPS.includes(n)));
ok("design pack still registered alongside (no clobbering)", Array.isArray(S.DESIGN_COMMANDS) && S.DESIGN_COMMANDS.length === 13 && S.SKILL_OPS.includes("ui_screen_generate"));
ok("no duplicate command names after registration", new Set(S.SKILL_COMMANDS.map((c) => c.name)).size === S.SKILL_COMMANDS.length);
const isReq = (p) => p && (p.req === true || p.required === true);
ok("required params flagged (gfx_pose.path, gfx_prop_add.source, gfx_fx.kind)", isReq(byName.get("gfx_pose").params.path) && isReq(byName.get("gfx_prop_add").params.source) && isReq(byName.get("gfx_fx").params.kind));
const descOf = (cmd, p) => String((byName.get(cmd).params[p] || {}).desc || (byName.get(cmd).params[p] || {}).description || "");
ok("schemas enumerate styles / poses / faces / cameras / fx", S.GFX_STYLES.every((x) => descOf("gfx_stage_create", "style").includes(x)) && S.GFX_POSES.every((x) => descOf("gfx_subject_add", "pose").includes(x)) && S.GFX_FACES.every((x) => descOf("gfx_pose", "face").includes(x)) && S.GFX_CAMERAS.every((x) => descOf("gfx_camera", "preset").includes(x)) && S.GFX_FX.every((x) => descOf("gfx_fx", "kind").includes(x)));

// ── tables ────────────────────────────────────────────────────────────────────
ok("6 styles incl. cinematic/cartoony/horror/neon/clean/chroma", S.GFX_STYLES.length === 6 && ["cinematic", "cartoony", "horror", "neon", "clean", "chroma"].every((x) => S.GFX_STYLES.includes(x)));
ok("13 poses incl. hero/point/jump/scared/victory/dab", S.GFX_POSES.length === 13 && ["hero", "point", "jump", "scared", "victory", "dab", "idle"].every((x) => S.GFX_POSES.includes(x)));
ok("9 face presets incl. happy/shocked/angry/scared", S.GFX_FACES.length === 9 && ["happy", "shocked", "angry", "scared", "neutral"].every((x) => S.GFX_FACES.includes(x)));
ok("8 camera presets incl. hero_low/closeup/dutch/icon", S.GFX_CAMERAS.length === 8 && ["hero_low", "closeup", "dutch", "icon", "three_quarter"].every((x) => S.GFX_CAMERAS.includes(x)));
ok("7 fx kinds incl. sparkles/embers/smoke/confetti/rays", S.GFX_FX.length === 7 && ["sparkles", "embers", "smoke", "confetti", "rays"].every((x) => S.GFX_FX.includes(x)));

// ── generated Luau shape ──────────────────────────────────────────────────────
const build = (op, args) => S.buildLuau(op, args);
const luaOk = (r) => r && !r.err && typeof r.code === "string";
const stage = build("gfx_stage_create", { style: "horror", kind: "icon", size: 90 });
ok("gfx_stage_create builds (horror icon): cove, light rig, snapshot, effects, camera", luaOk(stage) && ["Cove_", "'Key'", "'Fill'", "'Rim'", "snapshotLighting", "saveCamera", "BloomEffect", "frameCamera", "ShowDevelopmentGui"].every((k) => stage.code.includes(k)));
ok("stage programs wrap the body in pcall and report failures as JSON", luaOk(stage) && stage.code.includes("local okRun,resRun=pcall(function()") && stage.code.includes("return fail("));
const subj = build("gfx_subject_add", { source: "player:12345", pose: "victory", face: "shocked", slot: "left" });
ok("gfx_subject_add builds: CreateHumanoidModelFromUserId + description fallback + ScaleTo + face", luaOk(subj) && ["CreateHumanoidModelFromUserId", "CreateHumanoidModelFromDescription", "applyPose", "applyFace", "placeOnStage", "ScaleTo"].every((k) => subj.code.includes(k)) && subj.code.includes("12345"));
ok("gfx_subject_add rejects an unknown face at build time", /ERROR building command gfx_subject_add: unknown face 'grumpy'/.test(build("gfx_subject_add", { face: "grumpy" }).err || ""));
ok("gfx_pose needs path; unknown pose rejected with the list", /missing required param 'path'/.test(build("gfx_pose", {}).err || "") && /unknown pose 'moonwalk' - use one of: idle, hero/.test(build("gfx_pose", { path: "X", pose: "moonwalk" }).err || ""));
const pose = build("gfx_pose", { path: "Workspace.Rig", pose: "jump", head_yaw: 10, reset: true });
ok("gfx_pose keeps original C0s in TOTAL_C0 attributes (reset path) and handles R6 names", luaOk(pose) && pose.code.includes("TOTAL_C0") && pose.code.includes("'Right Shoulder'") && pose.code.includes("resetPose"));
const prop = build("gfx_prop_add", { source: "Workspace.Sword", float: true, glow: true });
ok("gfx_prop_add strips scripts, converts Tools, floats + glows", luaOk(prop) && ["LuaSourceContainer", "IsA('Tool')", "PointLight", "Highlight"].every((k) => prop.code.includes(k)));
const cam = build("gfx_camera", { preset: "hero_low", target: "Workspace.Rig", roll: 5 });
ok("gfx_camera: lookAt maths, Focus, DOF focus distance, viewport box", luaOk(cam) && ["CFrame.lookAt", "cam.Focus", "DepthOfFieldEffect", "viewportBox", "math.tan"].every((k) => cam.code.includes(k)));
const ov = build("gfx_overlay", { title: "Epic", subtitle: "s", badge: "NEW", style: "cartoony", logo_image: "rbxassetid://1" });
ok("gfx_overlay: ScreenGui with IgnoreGuiInset, masks, safe area, thirds, TextScaled, UIStroke, UIGradient, badge, logo", luaOk(ov) && ["Total_GFX_Overlay", "IgnoreGuiInset=true", "'SafeArea'", "'Third_V'", "TextScaled=true", "UIStroke", "UIGradient", "'Badge'", "'Logo'", "UIAspectRatioConstraint"].every((k) => ov.code.includes(k)));
ok("gfx_fx rejects unknown kinds; sparkles builds a ParticleEmitter with sequences", /use one of: sparkles/.test(build("gfx_fx", { kind: "lasers" }).err || "") && (() => { const r = build("gfx_fx", { kind: "sparkles", attach: "Workspace.Rig" }); return luaOk(r) && ["ParticleEmitter", "NumberSequence.new", "ColorSequence.new", "NumberRange.new", "HumanoidRootPart"].every((k) => r.code.includes(k)); })());
const light = build("gfx_lighting", { style: "neon", bloom: 1, dof: 0, fog: 1 });
ok("gfx_lighting restyles + tweaks + removes DOF at 0", luaOk(light) && ["clearGfxEffects", "BloomEffect", "FogEnd", "e:Destroy()"].every((k) => light.code.includes(k)));
const cap = build("gfx_capture", { kind: "icon", name: "My Game" });
ok("gfx_capture Luau prepares the shot: guides hidden, Selection cleared, box fractions + out + file returned", luaOk(cap) && ["overlaySetGuides", "Selection:Set({})", "viewportBox", "out={w=ow,h=oh}", "file=name", "settle_ms"].every((k) => cap.code.includes(k)) && cap.code.includes("My_Game") && !cap.code.includes("My Game"));
const brief = build("gfx_brief", { title: "Epic Quest", genre: "RPG", style: "neon", subjects: ["knight"] });
ok("gfx_brief embeds prompt, negative prompt, checklist and recipe as JSON", luaOk(brief) && ["negative_prompt", "checklist", "studio_recipe", "Epic Quest", "neon cyberpunk"].every((k) => brief.code.includes(k)));
ok("gfx_teardown restores Lighting + camera and removes the overlay/stage", (() => { const r = build("gfx_teardown", {}); return luaOk(r) && ["restoreLighting", "restoreCamera", "clearGfxEffects", "overlayGui()"].every((k) => r.code.includes(k)); })());
ok("every gfx program is free of Luau-only syntax the Lua 5.4 parser rejects and of JS interpolation", EXPECTED.every((n) => {
  const r = build(n, n === "gfx_pose" ? { path: "X" } : n === "gfx_prop_add" ? { source: "X" } : n === "gfx_fx" ? { kind: "smoke" } : {});
  return luaOk(r) && !/\$\{/.test(r.code) && !/`/.test(r.code) && !/\bcontinue\b/.test(r.code) && !/[+\-*/]=\s/.test(r.code.replace(/==/g, ""));
}));
ok("non-gfx ops fall through to the previous builder (design + base packs still build)", luaOk(build("ui_audit", { path: "StarterGui" })) && luaOk(build("lighting_inspect", {})) && build("ui_audit", { path: "StarterGui" }).code.includes("Total_Design"));

// ── main.js composite ─────────────────────────────────────────────────────────
const mainSrc = fs.readFileSync("src/core/main.js", "utf8");
ok("runTool intercepts gfx_capture before the generic skill dispatch", (() => {
  const i = mainSrc.indexOf('if (name === "gfx_capture" || bareName === "gfx_capture")');
  const j = mainSrc.indexOf("RobloxScriptSkills.SKILL_OPS.includes(name)");
  return i > 0 && j > i;
})());
ok("runGfxCapture: Luau prep -> total_screenshot -> crop -> download + attach", ["async function runGfxCapture(args)", 'RobloxScriptSkills.buildLuau("gfx_capture", args)', 'tool: "total_screenshot"', "await cropGfxImage(imgs[0], d)", "downloadDataImage(img, file)", 'ui.showImages([img], "gfx_capture")', "A.pendingImages = [img]"].every((k) => mainSrc.includes(k)));
ok("cropGfxImage crops by viewport fractions and resizes on a canvas to the requested output", ["createImageBitmap", "ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, ow, oh)", 'canvas.toDataURL("image/png")', "clamp01(box.w, 1)"].every((k) => mainSrc.includes(k)));
ok("gfx_capture failure paths are explicit ERRORs (no capture / Luau fail)", mainSrc.includes("ERROR in gfx_capture: the Studio viewport could not be photographed") && mainSrc.includes("return `ERROR in gfx_capture: ${(j && j.error)"));
ok("raw:true skips the crop; settle_ms waits before the photo", mainSrc.includes("if (args.raw !== true)") && mainSrc.includes("Number(d.settle_ms)"));
ok("before/after tool hooks wrap gfx_capture (checkpoints, recap, suggestions)", /gfx_capture[\s\S]{0,400}__rsBeforeTool[\s\S]{0,400}runGfxCapture\(args\)[\s\S]{0,400}__rsAfterTool/.test(mainSrc));

// ── prompt / help / mode wiring ───────────────────────────────────────────────
const configSrc = fs.readFileSync("src/core/config.js", "utf8");
ok("creation work mode focuses gfx_* commands", /focus:\s*\/\^\([^\n]*gfx_/.test(mainSrc));
ok("feature help has a 'gfx' topic with the workflow + alias triggers", /gfx:\{title:"Thumbnail & Icon Studio/.test(mainSrc) && /gfx:\/thumbnail\|game icon/.test(mainSrc));
ok("mandates teach the gfx workflow (brief -> stage -> subject -> overlay -> camera -> capture -> teardown)", configSrc.includes("THUMBNAIL & ICON STUDIO (1.30 gfx pack)") && configSrc.includes("THUMBNAILS / ICONS: never say you cannot make images") && ["gfx_brief", "gfx_stage_create", "gfx_subject_add", "gfx_overlay", "gfx_camera", "gfx_capture", "gfx_teardown"].every((k) => configSrc.includes(k)));
const readme = fs.readFileSync("README.md", "utf8");
ok("README documents the gfx pack", readme.includes("gfx_capture") && readme.includes("gfx_stage_create") && readme.includes("1.30.0") && readme.includes("gfx-sim.py"));
ok("manifest version is 1.77.0", manifest.version === "1.77.0", manifest.version);
ok("plugin / crate pinned at 1.77.0", /TotalScript\s+1\.77\.0|1\.77\.0/.test(fs.readFileSync("plugin/TotalScript.lua", "utf8")) && /^version = "1\.77\.0"/m.test(fs.readFileSync("agent/Cargo.toml", "utf8")));

// ── shared simulator module ───────────────────────────────────────────────────
const sim = fs.readFileSync("tests/roblox_sim.py", "utf8");
ok("tests/roblox_sim.py models CFrame/Vector3 maths, rigs, Lighting and Selection for both simulators", ["CFrame.lookAt", "fromEulerAnglesYXZ", "function M.buildRig", "CreateHumanoidModelFromUserId", 'service("Lighting")', 'service("Selection")', "function methods:GetBoundingBox", "function methods:ScaleTo"].every((k) => sim.includes(k)));
ok("design-sim.py and gfx-sim.py both import the shared model", fs.readFileSync("tests/design-sim.py", "utf8").includes("from roblox_sim import ROBLOX") && fs.readFileSync("tests/gfx-sim.py", "utf8").includes("from roblox_sim import make_runtime"));

console.log("\n" + (failed ? failed + " check(s) failed" : "all gfx pack checks passed"));
process.exit(failed ? 1 : 0);
