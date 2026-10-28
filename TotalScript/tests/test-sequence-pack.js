"use strict";
// 1.82.0 - studio_sequence.js: the shared timeline / event model that binds camera, animation,
// VFX, SFX, lighting, UI and gameplay signals (tests A, F and G of the Phase 115 plan - static part).
// tests/sequence-sim.py executes the runtime inside tests/roblox_sim.py.
const fs = require("fs"), vm = require("vm");
global.window = global; global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = RobloxScriptSkills;
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? " - " + detail : "")); } }
const codes = (v) => v.issues.map((i) => i.code);

ok("pack registered in every isolated-world list + codecraft.html (after creative_pro, before agent_skills)", manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js")).every((c) => { const i = c.js.indexOf("src/core/skills/studio_sequence.js"); return i > c.js.indexOf("src/core/skills/studio_vfxpro.js") && i > c.js.indexOf("src/core/skills/studio_sfx.js") && i < c.js.indexOf("src/core/skills/agent_skills.js"); }) && /studio_sequence\.js/.test(fs.readFileSync("codecraft.html", "utf8")));
ok("version pinned + plugin / README / manifest at 1.93.0", S.SEQUENCE_VERSION === "1.93.0" && manifest.version === "1.93.0" && /TotalScript 1\.93\.0|VERSION = "1\.93\.0"/.test(fs.readFileSync("plugin/TotalScript.lua", "utf8")) && /\*\*1\.93\.0 — /.test(fs.readFileSync("README.md", "utf8")));
ok("commands: create / ability / validate / preview / play / list / delete visible, stop hidden", ["sequence_create", "ability_sequence_create", "sequence_validate", "sequence_preview", "sequence_play", "sequence_list", "sequence_delete"].every((n) => S.SKILL_COMMANDS.some((c) => c.name === n && !c.hidden)) && S.SKILL_COMMANDS.some((c) => c.name === "sequence_stop" && c.hidden));
ok("event kinds: camera, animation, vfx, sfx, light, ui, tween, signal", JSON.stringify(S.SEQUENCE_KINDS) === JSON.stringify(["camera", "animation", "vfx", "sfx", "light", "ui", "tween", "signal"]));

// Ability templates: structured beats, not prose.
ok("7 ability templates (fireball, slash, heal, shield, dash, teleport, ground_slam)", S.SEQUENCE_ABILITIES.length === 7);
for (const a of S.SEQUENCE_ABILITIES) {
  const spec = S.sequenceNormalize(S.sequenceAbilityTemplate(a, {}));
  const v = S.sequenceValidate(spec);
  const kinds = new Set(spec.events.map((e) => e.kind));
  ok(a + ": structurally valid (0 errors; only honest sfx-missing warnings)", v.errors === 0 && codes(v).every((c) => c === "sfx-missing"), JSON.stringify(v.issues.map((i) => i.msg)).slice(0, 200));
  ok(a + ": binds VFX + SFX + a gameplay signal on a shared timeline", kinds.has("vfx") && kinds.has("sfx") && kinds.has("signal") && spec.events.every((e) => typeof e.t === "number"));
  ok(a + ": timing is explicit (events sorted inside duration, no arbitrary waits)", spec.duration > 0 && spec.events.every((e) => e.t <= spec.duration));
}
const fire = S.sequenceNormalize(S.sequenceAbilityTemplate("fireball", { rig: "Workspace.Hero", target: "Workspace.Dummy", palette: "frost" }));
ok("fireball follows the ability arc: charge -> release -> projectile -> hit -> recovery UI", (() => { const seq = fire.events.filter((e) => e.kind === "vfx").map((e) => e.family); return seq.indexOf("charge") < seq.indexOf("release") && seq.indexOf("release") < seq.indexOf("projectile") && seq.indexOf("projectile") < seq.indexOf("explosion") && fire.events.some((e) => e.kind === "ui") && fire.events.some((e) => e.kind === "camera" && e.shake); })());
ok("fireball: hand-anchored charge, projectile travels to the target, palette propagated", fire.events.some((e) => e.kind === "vfx" && e.at && e.at.limb === "right_hand") && fire.events.some((e) => e.kind === "vfx" && e.family === "projectile" && e.to === "Workspace.Dummy" && e.duration > 0) && fire.events.filter((e) => e.kind === "vfx").every((e) => e.palette === "frost"));
ok("fireball: signals carry gameplay hooks (fire_projectile, hit) for the server", fire.events.filter((e) => e.kind === "signal").map((e) => e.name).join(",") === "fire_projectile,hit");
ok("camera shake is restrained (amplitude <= 1.5 studs, decays)", S.SEQUENCE_ABILITIES.every((a) => S.sequenceNormalize(S.sequenceAbilityTemplate(a, {})).events.filter((e) => e.kind === "camera" && e.shake).every((e) => e.shake.amplitude <= 1.5 && e.shake.decay > 0)));

// Validator: real defects, not a rubber stamp.
const bad = S.sequenceValidate(S.sequenceNormalize({ name: "Bad", duration: 3, events: [
  { t: 0, kind: "vfx", family: "nope", at: "player" }, { t: 5, kind: "sfx", event: "impact" },
  { t: 0, kind: "camera", shot: { position: [0, 5, 10], look_at: [0, 0, 0] }, duration: 2 }, { t: 1, kind: "camera", shot: { position: [5, 5, 10], look_at: [0, 0, 0] }, duration: 1 },
  { t: -1, kind: "signal", name: "x" }, { t: 0, kind: "dance" }, { kind: "signal", name: "no_t" }, { t: 0.1, kind: "animation", rig: "player" }, { t: 0, kind: "ui", text: "a", duration: 1 }, { t: 0.5, kind: "ui", text: "b", duration: 1 },
] }));
ok("validator flags unknown family, after-end, camera overlap, negative t, unknown kind, missing t, animation without asset, ui overlap", ["vfx-family", "after-end", "camera-overlap", "time", "kind", "animation", "ui-overlap"].every((c) => codes(bad).includes(c)) && bad.errors >= 6, codes(bad).join(","));
const budget = S.sequenceValidate(S.sequenceNormalize({ name: "B", tier: "Low", events: [{ t: 0, kind: "vfx", family: "explosion", at: "player" }, { t: 0, kind: "vfx", family: "fire", at: "player", duration: 3 }, { t: 0.1, kind: "vfx", family: "smoke", at: "player", duration: 3 }] }));
ok("validator enforces per-tier concurrency budgets (Low: 2 live effects)", codes(budget).includes("vfx-budget"));
const limb = S.sequenceValidate(S.sequenceNormalize({ name: "L", events: [{ t: 0, kind: "vfx", family: "impact", at: { actor: "player", limb: "tail" } }] }));
ok("validator rejects unknown limb roles", codes(limb).includes("limb"));
const clean = S.sequenceValidate(S.sequenceNormalize({ name: "Ok", duration: 1, events: [{ t: 0, kind: "camera", shake: { amplitude: 0.5, frequency: 12, decay: 0.3 } }, { t: 0.1, kind: "signal", name: "go" }] }));
ok("a clean spec validates with zero issues", clean.ok && clean.issues.length === 0);
ok("normalize assigns tier High by default and keeps user duration", S.sequenceNormalize({ name: "X", events: [] }).tier === "High" && S.sequenceNormalize({ name: "X", duration: 2.5, events: [] }).duration === 2.5);

// Runtime shape.
const rt = S.SEQUENCE_RUNTIME_SRC;
ok("runtime: play/cast/cancel/stopAll/active/step/validate/load/limb/rigType", ["play", "cast", "cancel", "stopAll", "active", "step", "validate", "load", "limb", "rigType"].every((k) => rt.includes("function M." + k)), ["play", "cast", "cancel", "stopAll", "active", "step", "validate", "load", "limb", "rigType"].filter((k) => !rt.includes("function M." + k)).join(","));
ok("runtime: handles expose Stop / Pause / Resume / Skip / IsPlaying / Completed", /function Handle:Stop/.test(rt) && /Pause/.test(rt) && /Resume/.test(rt) && /Skip/.test(rt) && /IsPlaying/.test(rt) && /Completed/.test(rt));
ok("runtime: rig-aware limb map (R15 + R6) - no R15 joint names on R6", /RightHand/.test(rt) && /'Right Arm'/.test(rt) && /R6/.test(rt) && /R15/.test(rt));
ok("runtime: camera is restored (type, CFrame, FOV, subject) and shake uses a decaying envelope", /prevType/.test(rt) && /prevCF/.test(rt) && /prevFov/.test(rt) && /\(1 - k\) \* \(1 - k\)/.test(rt));
ok("runtime: shake overlays the live camera (RenderStep after Camera priority) instead of hijacking it", /BindToRenderStep/.test(rt) && /RenderPriority\.Camera\.Value \+ 1/.test(rt) && /UnbindFromRenderStep/.test(rt));
ok("runtime: non-linear easing default + TweenService:GetValue for camera moves", /GetValue/.test(rt) && /Enum\.EasingStyle\[/.test(rt) && !/EasingStyle\.Linear/.test(rt));
ok("runtime: cancellation is first-class (death, character removal, Stop) and cleans lighting / UI / VFX / tracks", /Died/.test(rt) && /AncestryChanged|CharacterRemoving/.test(rt) && /function teardown/.test(rt) && /TotalSequence_/.test(rt));
ok("runtime: animation markers (GetMarkerReachedSignal) fire sub-events for SFX / VFX sync", /GetMarkerReachedSignal/.test(rt) && /marker_events/.test(rt));
ok("runtime: server-authoritative split - signals fire on both sides, cosmetics on the client, server casts through a RemoteEvent", /sideOf/.test(rt) && /'both'/.test(rt) && /PlaySequence/.test(rt) && /FireClient/.test(rt));
ok("runtime: speed scaling, no task.wait / wait() delays (Heartbeat-driven)", /speed/.test(rt) && !/task\.wait\(|\bwait\(/.test(rt) && /Heartbeat/.test(rt));
ok("client bootstrap listens for PlaySequence and reports completion back", /PlaySequence/.test(S.SEQUENCE_CLIENT_SRC) && /OnClientEvent/.test(S.SEQUENCE_CLIENT_SRC) && /FireServer/.test(S.SEQUENCE_CLIENT_SRC));
ok("no Luau-only syntax in runtime / client", !/\+=|-=|\.\.=|\bcontinue\b/.test(rt + S.SEQUENCE_CLIENT_SRC));

// Executors.
const names = ["sequence_create", "ability_sequence_create", "sequence_validate", "sequence_preview", "sequence_play", "sequence_list", "sequence_delete", "sequence_stop"];
const built = names.map((n) => [n, S.buildLuau(n, { name: "Fireball", ability: "fireball", rig: "Workspace.Hero", target: "Workspace.Dummy", events: [{ t: 0, kind: "signal", name: "go" }] })]);
ok("all 8 executors build Luau with structured JSON results", built.every(([, r]) => r && r.code && /JSONEncode/.test(r.code) && !/loadstring\s*\(/.test(r.code)), built.filter(([, r]) => !r || !r.code).map(([n, r]) => n + ":" + (r && r.err)).join(","));
const badCreate = S.buildLuau("sequence_create", { name: "Bad", events: [{ t: 0, kind: "dance" }] });
ok("sequence_create with structural errors fails before Studio runs anything", !!badCreate.err || /fail\(/.test(badCreate.code) && /NOT created/.test(badCreate.code));
const badAbility = S.buildLuau("ability_sequence_create", { ability: "nuke" });
ok("ability_sequence_create with an unknown ability fails with the list", !!badAbility.err && /fireball/.test(badAbility.err) || /fail\(/.test(badAbility.code || ""));
ok("sequence_create executor verifies rig / target / animation references in Studio before saving", /Runner\.validate|validate\(/.test(built[0][1].code) && /not found/.test(S.SEQUENCE_RUNTIME_SRC));
ok("sequence_create schema documents the event shape", (() => { const c = S.SKILL_COMMANDS.find((x) => x.name === "sequence_create"); const d = JSON.stringify(c); return /t: seconds, kind, duration\?/.test(d) && /marker_events/.test(d) && /to\?: path/.test(d); })());
ok("test-command-dedup covers the three new packs", /studio_vfxpro\.js","studio_sfx\.js","studio_sequence\.js"/.test(fs.readFileSync("tests/test-command-dedup.js", "utf8")));

console.log(fail ? "FAIL  test-sequence-pack: " + pass + " passed, " + fail + " failed" : "OK    test-sequence-pack: " + pass + " passed");
process.exit(fail ? 1 : 0);
