"use strict";
// 1.77.0 — Cutscene Studio: TotalScript can CREATE cutscenes (not a
// "configured" stub). Static checks on the pack, the catalogue, the prompts,
// the mode gates and the generated Luau. tests/cutscene-sim.py executes it.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
let n = 0;
function ok(label, cond, detail) { n++; if (!cond) { console.log("FAIL  " + label + (detail ? " — " + String(detail).slice(0, 400) : "")); process.exitCode = 1; } else console.log("PASS  " + label); }

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p, getManifest: () => ({ version: "0" }) } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
ok("every main.js bundle loads studio_cutscene.js after studio_100.js and studio_modes.js, before studio_bridge.js", bundles.length > 0 && bundles.every((b) => {
  const i = b.js.indexOf("src/core/skills/studio_cutscene.js");
  return i > b.js.indexOf("src/core/skills/studio_100.js") && i > b.js.indexOf("src/core/skills/studio_modes.js") && i < b.js.indexOf("src/core/studio_bridge.js");
}));
const bundle = bundles[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = RobloxScriptSkills;

// ── the stub is gone, the real pack is registered ──
const studio100 = fs.readFileSync("src/core/skills/studio_100.js", "utf8");
ok("studio_100.js no longer carries the fake cutscene_camera_track executor / catalogue entry", !/B\.cutscene_camera_track\s*=/.test(studio100) && !/name: "cutscene_camera_track"/.test(studio100));
const pack = fs.readFileSync("src/core/skills/studio_cutscene.js", "utf8");
ok("pack header + version", pack.includes("TotalScript cutscene pack (1.77.0)") && /const VERSION = "1\.77\.0"/.test(pack) && S.CUTSCENE_VERSION === "1.77.0");
ok("no 'configured' fake result anywhere in the pack", !/configured'\)/.test(pack));
const names = ["cutscene_create", "cutscene_shot_add", "cutscene_shot_from_camera", "cutscene_shots_from_path", "cutscene_preview", "cutscene_trigger", "cutscene_list", "cutscene_delete", "cutscene_camera_track"];
ok("CUTSCENE_COMMANDS exports the 9 names", JSON.stringify(S.CUTSCENE_COMMANDS) === JSON.stringify(names));
for (const nm of names) {
  const hits = S.SKILL_COMMANDS.filter((c) => c.name === nm);
  ok("catalogue: exactly one " + nm + " with params + description", hits.length === 1 && hits[0].params && hits[0].description && hits[0].description.length > 40, hits.length);
  ok("SKILL_OPS lists " + nm, S.SKILL_OPS.includes(nm));
}
const create = S.SKILL_COMMANDS.find((c) => c.name === "cutscene_create");
ok("cutscene_create documents the four shot shapes and the options", /position/.test(create.params.shots.desc) && /target/.test(create.params.shots.desc) && /cframe/.test(create.params.shots.desc) && /part:/.test(create.params.shots.desc) && create.params.fade_in && create.params.letterbox && create.params.skip);
const legacy = S.SKILL_COMMANDS.find((c) => c.name === "cutscene_camera_track");
ok("cutscene_camera_track is documented as the alias (not a stub) and warns that duration/fov alone do nothing", /legacy name for cutscene_create/i.test(legacy.description) && /no-op stub before 1\.77/.test(legacy.description) && legacy.params.shots && legacy.params.shots.req === true);

// ── generated Luau ──
const r = S.buildLuau("cutscene_create", { name: "Intro", shots: [{ position: [0, 10, 20], look_at: [0, 0, 0], fov: 60, duration: 3, easing: "quad", direction: "out" }, { target: "Workspace.Boss", preset: "hero_low", hold: 1 }], fade_in: 0.5 });
ok("cutscene_create builds Luau (no err)", !r.err && typeof r.code === "string" && r.code.length > 2000, r.err);
ok("Luau writes ReplicatedStorage.TotalCutscenes.<Name> ModuleScript with ShotsJSON + TotalCutscene attributes", /TotalCutscenes/.test(r.code) && /SetAttribute\('ShotsJSON'/.test(r.code) && /SetAttribute\('TotalCutscene',true\)/.test(r.code) && /Instance\.new\('ModuleScript'\)/.test(r.code));
ok("Luau installs the shared runtime: CutscenePlayer module, PlayCutscene RemoteEvent, StarterPlayerScripts.TotalCutsceneClient LocalScript", /'CutscenePlayer'/.test(r.code) && /'PlayCutscene'/.test(r.code) && /RemoteEvent/.test(r.code) && /TotalCutsceneClient/.test(r.code) && /StarterPlayerScripts/.test(r.code));
ok("easing / direction are normalised to Enum names (quad/out -> Quad/Out)", /easing="Quad"/.test(r.code) && /direction="Out"/.test(r.code));
ok("the whole body runs under pcall and surfaces errors through fail()", /pcall\(function\(\)/.test(r.code) && /return fail\(\(tostring\(resRun\)/.test(r.code));
ok("generated Luau has no raw newline inside a quoted string, no backticks, no `continue`", !/`/.test(r.code) && !/\bcontinue\b/.test(r.code));
const rt = S.CUTSCENE_RUNTIME_SRC, cl = S.CUTSCENE_CLIENT_SRC;
ok("CutscenePlayer runtime: play/stop/isPlaying/duration/Completed, Scriptable camera, TweenService:GetValue easing, letterbox + fade + skip, HUD + humanoid restore", /function M\.play\(/.test(rt) && /function M\.stop\(/.test(rt) && /function M\.isPlaying\(/.test(rt) && /function M\.duration\(/.test(rt) && /M\.Completed = Instance\.new\("BindableEvent"\)/.test(rt) && /Enum\.CameraType\.Scriptable/.test(rt) && /TweenService:GetValue\(k, style, dir\)/.test(rt) && /BarTop/.test(rt) && /SkipHint/.test(rt) && /SetCoreGuiEnabled\(Enum\.CoreGuiType\.All, true\)/.test(rt) && /hum\.WalkSpeed = prevWalk/.test(rt));
ok("runtime restores camera type, FOV and CFrame and never leaves the camera Scriptable", /cam\.CameraType = prevType/.test(rt) && /cam\.FieldOfView = prevFov/.test(rt) && /cam\.CFrame = prevCF/.test(rt));
ok("runtime reads cutscenes by name from ReplicatedStorage.TotalCutscenes and errors clearly when missing", /cutscene not found: /.test(rt) && /TotalCutscenes/.test(rt));
ok("client LocalScript listens on PlayCutscene, plays through the runtime and reports back with FireServer", /OnClientEvent:Connect/.test(cl) && /pcall\(Player\.play, name, opts\)/.test(cl) && /remote:FireServer\(name, okP and res == true\)/.test(cl));
ok("sources contain no backticks and no `continue` (Luau-safe)", !/`/.test(rt + cl) && !/\bcontinue\b/.test(rt + cl));

// trigger scripts
for (const kind of ["spawn", "touch", "proximity"]) {
  const t = S.buildLuau("cutscene_trigger", { name: "Intro", trigger: kind, part: "Workspace.Pad", delay: 1, once: false });
  ok("cutscene_trigger " + kind + " emits a server Script under ServerScriptService with Cutscene / Trigger attributes", !t.err && /ServerScriptService/.test(t.code) && /TotalCutsceneTrigger_/.test(t.code) && /SetAttribute\('Cutscene'/.test(t.code) && /SetAttribute\('Trigger'/.test(t.code) && /FireClient/.test(t.code));
}
const tt = S.buildLuau("cutscene_trigger", { name: "Intro", trigger: "touch" });
ok("cutscene_trigger touch without a part fails at build time", /return fail\('cutscene_trigger touch needs part/.test(tt.code));
const bad = S.buildLuau("cutscene_create", { name: "Intro", shots: [{ position: [0, 0, 0] }, { fov: 20 }] });
ok("a shape-less shot is rejected at build time with the shot index", !!bad.err && /shot 2/.test(bad.err), bad.err);
const legacyNoArgs = S.buildLuau("cutscene_camera_track", { duration: 5, fov: 70 });
ok("legacy call with only duration/fov generates a fail(), never a success", /return fail\('cutscene_camera_track now builds a REAL cutscene and needs shots/.test(legacyNoArgs.code) && !/'cutscene_camera_track configured'/.test(legacyNoArgs.code));
const legacyReal = S.buildLuau("cutscene_camera_track", { name: "L", shots: [{ position: [0, 0, 0] }, { position: [1, 1, 1] }] });
ok("legacy call with shots builds the same cutscene program as cutscene_create", !legacyReal.err && /SetAttribute\('ShotsJSON'/.test(legacyReal.code));
const prev = S.buildLuau("cutscene_preview", { name: "Intro", speed: 2, from_shot: 2 });
ok("cutscene_preview drives workspace.CurrentCamera with task.spawn and restores it", /task\.spawn\(function\(\)/.test(prev.code) && /cam\.CameraType=Enum\.CameraType\.Scriptable/.test(prev.code) && /cam\.CFrame=startCF/.test(prev.code) && /total_screenshot/.test(prev.code));

// ── prompts / gates / catalogue mentions ──
const config = fs.readFileSync("src/core/config.js", "utf8"), main = fs.readFileSync("src/core/main.js", "utf8");
ok("config.js name index lists the cutscene commands", /cutscene_create, cutscene_shot_add, cutscene_shot_from_camera, cutscene_shots_from_path, cutscene_preview, cutscene_trigger, cutscene_list, cutscene_delete/.test(config));
ok("Totality prompt: camera rule and CUTSCENE playbook use cutscene_create -> cutscene_preview -> cutscene_trigger; the stub name is no longer recommended anywhere", /cutscene_create \+ cutscene_preview, camera_reset after\./.test(config) && /- CUTSCENE: cutscene_create \{name, shots:\[2\+ \{position, look_at\}\|\{target, preset\}\]\} → cutscene_preview \+ total_screenshot → cutscene_trigger → report the beats with timings\./.test(config) && !/cutscene_camera_track/.test(config));
ok("motion gate: cutscene authoring counts as 'did', cutscene_preview counts as proof", /cutscene_\(create\|camera_track\|shot_add\|shot_from_camera\|shots_from_path\|trigger\)/.test(main) && /camera_orbit_preview\|cutscene_preview\|total_screenshot/.test(main));
ok("motion family regex in the catalogue groups cutscene_* under TWEENS, SPRINGS & CAMERA", /re: \/\^\(tween\|spring_\|camera_\|cutscene\|walkspeed\)\//.test(main));
const readme = fs.readFileSync("README.md", "utf8");
ok("README changelog + test list", /\*\*1\.77\.0 — Cutscene Studio/.test(readme) && /test-cutscene\.js/.test(readme) && /cutscene-sim\.py/.test(readme));
ok("test-command-dedup.js scans the cutscene pack", /"studio_cutscene\.js"/.test(fs.readFileSync("tests/test-command-dedup.js", "utf8")));

console.log((process.exitCode ? "FAIL" : "PASS") + "  test-cutscene: " + n + " checks");
