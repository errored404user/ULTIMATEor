// 1.54.0 — Animation engine polish + Blender-style tools (smooth / plant feet / simplify / reverse / bake / cycle offset /
// insert key / layer / analytic 2-bone IK / pose copy-paste-flip) and the Animation Studio's orbitable viewport, IK handles,
// hotkeys, pose library and Layer picker; 1.64 replaced the dope sheet + graph editor with the key workbench
// (tests/test-anim-bench.js). Run with NODE_PATH pointing at a jsdom install.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra) : "")); } };
const E = require(path.join(ROOT, "src/core/animengine.js"));

// ── engine: smoothing ──
const walk = E.generate("natural walk cycle, loop", { quality: "balanced" });
ok("engine VERSION is 2.8.0 and the report carries a smoothness metric", E.VERSION === "2.8.0" && Number.isFinite(walk.report.smoothness) && walk.report.smoothness >= 0 && walk.report.smoothness <= 100, [E.VERSION, walk.report.smoothness]);
const sm = E.smooth(walk, { strength: 1 });
ok("smooth() keeps the clip valid, keeps first/last/impact keys and reports what it did", sm.report.ok && sm.keys[0].t === 0 && Math.abs(sm.keys[sm.keys.length - 1].t - sm.duration) < 1e-6 && /smoothed \(strength 1/.test(sm.fixes[sm.fixes.length - 1]), sm.fixes);
ok("smooth() does not lower smoothness and is deterministic", sm.report.smoothness >= walk.report.smoothness && JSON.stringify(E.smooth(walk, { strength: 1 }).keys) === JSON.stringify(sm.keys), [walk.report.smoothness, sm.report.smoothness]);
const combo = E.generate("3 hit sword combo with a heavy finisher", { quality: "balanced" });
const impactsBefore = combo.keys.filter((k) => k.tag === "impact").map((k) => JSON.stringify([k.t, k.poses.r_shoulder]));
const smc = E.smooth(combo, { strength: 1 });
ok("smooth() anchors impact keys (their time and pose are untouched)", impactsBefore.every((s) => smc.keys.some((k) => k.tag === "impact" && JSON.stringify([k.t, k.poses.r_shoulder]) === s)), impactsBefore.length);
const locked = JSON.parse(JSON.stringify(walk)); locked.keys[3].locked = true; const smL = E.smooth(locked, { strength: 1, breakdowns: false });
ok("locked keys survive smoothing unchanged", JSON.stringify(smL.keys.find((k) => k.locked).poses) === JSON.stringify(locked.keys[3].poses));
ok("high / cinematic presets apply spline smoothing automatically, fast / balanced do not", /smoothed/.test((E.generate("natural walk cycle, loop", { quality: "cinematic" }).fixes || []).join(" ")) && !/smoothed/.test((E.generate("natural walk cycle, loop", { quality: "fast" }).fixes || []).join(" ")));
ok("'smoother' feedback runs the spline pass on top of the regeneration", /spline smoothing pass/.test(E.applyFeedback(walk, "make it smoother").feedback.slice(-1)[0].applied.join(" ")));

// ── engine: foot planting ──
const idleFast = E.generate("calm looping idle", { quality: "fast" }); // fast = no auto grounding
const restFloat = Math.max(...idleFast.keys.map((k) => Math.abs(E.metrics(k.poses).footMin)));
ok("1.56: a standing pose already stands ON the ground (ROOT_HEIGHT = leg length) - no systematic 0.5-stud float left for planting to 'fix' by sinking the root", restFloat < 0.08, restFloat);
const lifted = Object.assign({}, idleFast, { keys: idleFast.keys.map((k) => Object.assign({}, k, { poses: Object.assign({}, k.poses, { root: { rot: k.poses.root.rot.slice(), pos: [0, 0.3, 0] } }) })) });
const floatBefore = Math.max(...lifted.keys.map((k) => E.metrics(k.poses).footMin));
const planted = E.groundFeet(lifted, { force: true });
const floatAfter = Math.max(...planted.keys.map((k) => Math.abs(E.metrics(k.poses).footMin)));
ok("groundFeet() puts the lowest foot on the ground at every key", floatBefore > 0.25 && floatAfter < 0.05 && planted.grounded && /planted feet/.test(planted.fixes.slice(-1)[0]), [floatBefore, floatAfter]);
ok("balanced idle / walk clips are grounded automatically; runs and jumps are not (flight phases)", /planted feet/.test((walk.fixes || []).join(" ")) && !/planted feet/.test((E.generate("fast run cycle, loop").fixes || []).join(" ")) && !/planted feet/.test((E.generate("jump with a solid landing").fixes || []).join(" ")));
ok("planted loop clips still close their loop seam", planted.report.ok && !planted.report.issues.some((i) => i.kind === "loop" && i.level !== "info"));
ok("'plant the feet' feedback is recognised", /planted the feet/.test(E.applyFeedback(E.generate("fast run cycle, loop"), "plant the feet").feedback.slice(-1)[0].applied.join(" ")));

// ── engine: simplify / reverse / bake / cycle offset / insert key ──
const baked = E.bake(walk);
ok("bake() writes one key per frame on the fps grid and stays valid", baked.keys.length === Math.round(walk.duration * walk.fps) + 1 && baked.baked && baked.report.ok, [baked.keys.length, baked.report.score]);
const simp = E.simplify(baked, 2);
ok("simplify() removes redundant keys from a baked clip without moving anchors and keeps the motion within tolerance", simp.keys.length < baked.keys.length && simp.keys[0].t === 0 && E.compare(baked, simp).largestChange.degrees <= 6, [baked.keys.length, simp.keys.length, E.compare(baked, simp).largestChange]);
const rev = E.reverse(combo);
const frame = 1 / combo.fps + 1e-6; // reversed times are re-snapped to the fps grid, so allow one frame
ok("reverse() mirrors key times (frame-snapped), flips easing direction and renames; reversing twice restores the key times", rev.name === combo.name + "_Reversed" && rev.keys.length === combo.keys.length && rev.keys.every((k, i) => Math.abs(k.t - (combo.duration - combo.keys[combo.keys.length - 1 - i].t)) < frame) && rev.keys.some((k, i) => (combo.keys[combo.keys.length - 2 - i] || {}).ease && (combo.keys[combo.keys.length - 2 - i].ease[1] === "Out") && k.ease[1] === "In") && E.reverse(rev).name === combo.name && E.reverse(rev).keys.every((k, i) => Math.abs(k.t - combo.keys[i].t) < frame), [rev.keys.map((k) => k.t), combo.keys.map((k) => k.t)]);
const off = E.cycleOffset(walk, 0.5);
ok("cycleOffset() rotates a loop's start, keeps the key count, frame alignment and loop closure", off.keys.length === walk.keys.length && off.keys[0].t === 0 && Math.abs(off.keys[off.keys.length - 1].t - walk.duration) < 1e-6 && JSON.stringify(off.keys[0].poses.l_hip) === JSON.stringify(off.keys[off.keys.length - 1].poses.l_hip) && off.report.ok, [walk.keys.length, off.keys.length]);
ok("cycleOffset() leaves non-looping clips alone", E.cycleOffset(combo, 0.3).keys.length === combo.keys.length && !(E.cycleOffset(combo, 0.3).fixes || []).some((f) => /cycle offset/.test(f)));
const ins = E.insertKey(walk, 0.21);
ok("insertKey() adds a key holding the interpolated pose; inserting on an existing frame just selects it", ins.inserted && ins.clip.keys.length === walk.keys.length + 1 && JSON.stringify(ins.clip.keys[ins.index].poses.l_hip.rot.map((v) => Math.round(v))) === JSON.stringify(E.sampleAt(walk, ins.clip.keys[ins.index].t).l_hip.rot.map((v) => Math.round(v))) && !E.insertKey(walk, walk.keys[2].t).inserted && E.insertKey(walk, walk.keys[2].t).index === 2);
ok("moveKey() clamps a dragged key between its neighbours instead of swallowing them", E.moveKey(walk, 3, walk.keys[5].t).keys.length === walk.keys.length && E.moveKey(walk, 3, walk.keys[5].t).keys[3].t < walk.keys[4].t);

// ── engine: layering ──
const wave = E.generate("friendly wave emote");
const layered = E.layer(walk, wave, { fit: "stretch" });
const tMid = layered.duration / 2;
const lp = E.sampleAt(layered, tMid), bp = E.sampleAt(walk, tMid), up = E.sampleAt(wave, (tMid / walk.duration) * wave.duration);
const close = (a, b) => Math.max(...[0, 1, 2].map((i) => Math.abs(a.rot[i] - b.rot[i]))) < 3;
ok("layer() takes legs + root from the base and the upper body from the second clip (stretched to fit)", close(lp.l_hip, bp.l_hip) && close(lp.r_knee, bp.r_knee) && close(lp.r_shoulder, up.r_shoulder) && close(lp.r_elbow, up.r_elbow) && layered.layered && layered.layered.base === walk.name && layered.layered.upper === wave.name, layered.layered);
ok("layered clip is named, documented, loop-closed and valid", layered.name === `${walk.name}+${wave.name}` && layered.loop && layered.report.ok && layered.limitations.some((l) => /layered clip/.test(l)), [layered.name, layered.report.score]);
const half = E.layer(walk, wave, { weight: 0.5 });
ok("layer weight blends the upper body", Math.abs(E.sampleAt(half, tMid).r_shoulder.rot[0] - (bp.r_shoulder.rot[0] + up.r_shoulder.rot[0]) / 2) < 3);
ok("layer fit 'loop' repeats the upper clip at its own period", E.layer(walk, wave, { fit: "loop" }).layered.fit === "loop" && E.layer(walk, wave, { fit: "loop" }).report.errors === 0);

// ── engine: IK ──
const base = walk.keys[0].poses;
const target = [1.2, 3.2, -1.0];
const ik = E.ikSolve(base, "r_hand", target);
const tip = E.forwardKinematics(ik.poses).r_wrist_tip;
ok("ikSolve() moves the right hand onto a reachable target through shoulder + elbow only", ik.reached && Math.hypot(tip[0] - target[0], tip[1] - target[1], tip[2] - target[2]) < 0.08 && ik.joints.join(",") === "r_shoulder,r_elbow" && JSON.stringify(ik.poses.l_shoulder) === JSON.stringify(base.l_shoulder), [ik.distance, ik.joints]);
ok("ikSolve() respects joint limits", ["r_shoulder", "r_elbow"].every((j) => ["x", "y", "z"].every((ax, i) => ik.poses[j].rot[i] >= E.LIMITS[j][ax][0] - 0.01 && ik.poses[j].rot[i] <= E.LIMITS[j][ax][1] + 0.01)));
ok("ikSolve() is deterministic", JSON.stringify(E.ikSolve(base, "r_hand", target).poses) === JSON.stringify(ik.poses));
const far = E.ikSolve(base, "l_foot", [-0.5, 6, 0]);
ok("unreachable targets are reported honestly (reached:false with the remaining distance)", !far.reached && far.distance > 0.5, far.distance);
let hits = 0; const N = 60; let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let i = 0; i < N; i++) { const p = JSON.parse(JSON.stringify(base)); const L = E.LIMITS; p.r_hip = { rot: [L.r_hip.x[0] * 0.6 + rnd() * (L.r_hip.x[1] - L.r_hip.x[0]) * 0.6, L.r_hip.y[0] * 0.6 + rnd() * (L.r_hip.y[1] - L.r_hip.y[0]) * 0.6, L.r_hip.z[0] * 0.6 + rnd() * (L.r_hip.z[1] - L.r_hip.z[0]) * 0.6] }; p.r_knee = { rot: [L.r_knee.x[0] * 0.9 + rnd() * (L.r_knee.x[1] - L.r_knee.x[0]) * 0.9, 0, 0] }; const T = E.forwardKinematics(p).r_ankle_tip; if (E.ikSolve(base, "r_foot", T).reached) hits++; }
ok("leg IK reaches ≥ 90% of targets that a valid pose can reach", hits >= N * 0.9, [hits, N]);

// ── engine: pose copy / paste / flip ──
const pose = E.copyPose(combo, 2, ["r_shoulder", "r_elbow"]);
const pasted = E.pastePose(walk, 1, pose);
ok("copyPose() picks joints; pastePose() writes only those joints", Object.keys(pose).join(",") === "r_shoulder,r_elbow" && JSON.stringify(pasted.keys[1].poses.r_shoulder) === JSON.stringify(combo.keys[2].poses.r_shoulder) && JSON.stringify(pasted.keys[1].poses.l_hip) === JSON.stringify(walk.keys[1].poses.l_hip));
const flipped = E.pastePose(walk, 1, pose, { flipped: true });
ok("pastePose({flipped}) mirrors onto the opposite side (r_shoulder → l_shoulder with y/z negated)", flipped.keys[1].poses.l_shoulder.rot[0] === combo.keys[2].poses.r_shoulder.rot[0] && flipped.keys[1].poses.l_shoulder.rot[2] === -combo.keys[2].poses.r_shoulder.rot[2] && JSON.stringify(flipped.keys[1].poses.r_shoulder) === JSON.stringify(walk.keys[1].poses.r_shoulder));
ok("channels() exposes per-joint F-curves for the graph editor", E.channels(walk).r_shoulder.x.length === walk.keys.length && E.channels(walk).root.py && E.channels(walk).root.py.length === walk.keys.length);

// ── catalogue + main wiring ──
const animlib = read("src/core/animlib.js"), main = read("src/core/main.js");
ok("animlib advertises animation_polish + animation_layer after the five engine commands (first five unchanged)", /name: "animation_polish"/.test(animlib) && /name: "animation_layer"/.test(animlib) && animlib.indexOf('name: "animation_polish"') > animlib.indexOf('name: "animation_export_rbxmx"') && /1\.54: animation_polish/.test(animlib));
ok("main.js routes animation_polish / animation_layer through runAnimEngine and keeps session clips in A.animClips (2.0.3: no studio window)", /"polish", "layer"\]\);/.test(main) && main.includes('if (op === "polish") {') && main.includes('if (op === "layer") {') && main.includes("A.animClips = A.animClips || {};") && !/TotalAnimStudio|__rsOpenAnimStudio|rs-anim-btn/.test(main));

// ── engine: spline interpolation (2.0.3: ported from the removed Studio toggle test) ──
{
  const sp = E.setInterp(walk, "spline"), dense = E.exportKeys(sp);
  ok("setInterp('spline') flags the clip and exportKeys bakes a dense frame grid for Studio", sp.interp === "spline" && dense.length > sp.keys.length && E.setInterp(sp, "eased").interp === "eased");
  const studioPayload = E.toBuildArgs(sp, E.defaultRigInfo("R15"));
  ok("build payload for a spline clip is the dense Linear bake", studioPayload.keys.length === dense.length && studioPayload.keys.every((k) => k.e[0] === "Linear"));
}
console.log(`test-anim-blender: ${n} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
