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
ok("engine VERSION is 1.99.5 and the report carries a smoothness metric", E.VERSION === "1.99.5" && Number.isFinite(walk.report.smoothness) && walk.report.smoothness >= 0 && walk.report.smoothness <= 100, [E.VERSION, walk.report.smoothness]);
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
ok("main.js routes animation_polish / animation_layer through runAnimEngine and hands session clips to the studio", /"polish", "layer"\]\);/.test(main) && main.includes('if (op === "polish") {') && main.includes('if (op === "layer") {') && main.includes("clips: () => A.animClips"));

// ── studio in jsdom ──
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", pretendToBeVisual: true, url: "https://chatgpt.com/" });
const w = dom.window; w.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 0); w.cancelAnimationFrame = (id) => clearTimeout(id);
w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 }; };
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return 800; } }); Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 400; } });
const ops = []; w.HTMLCanvasElement.prototype.getContext = function () { return new Proxy({}, { get: (_, k) => (k === "measureText" ? () => ({ width: 10 }) : (...a) => { ops.push(String(k)); return undefined; }), set: () => true }); };
const errors = []; w.addEventListener("error", (e) => errors.push(String(e.message)));
const mem = {}; Object.defineProperty(w, "localStorage", { value: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } } });
w.prompt = () => "0.25"; w.confirm = () => true;
for (const f of ["src/core/animengine.js", "src/core/animstudio.js"]) { const el = w.document.createElement("script"); el.textContent = read(f); w.document.head.appendChild(el); }
const AS = w.TotalAnimStudio;
AS.open({ send: async () => true, runTool: async () => "", studioReady: () => false, engine: () => "", toast: () => {}, diag: () => {}, clips: () => ({ ExtWave: w.TotalAnimEngine.generate("wave emote") }) });
const host = w.document.getElementById("rs-anim"); const ref = (k) => host.querySelector(`[data-ref="${k}"]`), act = (k) => host.querySelector(`[data-act="${k}"]`);
const toast = () => host.querySelector(".rsa-toast").textContent;
const click = (el, o) => el.dispatchEvent(new w.MouseEvent("click", Object.assign({ bubbles: true, cancelable: true }, o || {})));
const key = (k, o) => host.dispatchEvent(new w.KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, o || {})));
const studio = read("src/core/animstudio.js"), css = read("overlay.css");
ok("every data-act button has a doAction case and every data-tool button a clipTool branch (no dead controls)", [...host.querySelectorAll("[data-act]")].every((b) => studio.includes(`case "${b.dataset.act}":`)) && [...host.querySelectorAll("[data-tool]")].every((b) => studio.includes(`kind === "${b.dataset.tool}"`)) && host.querySelectorAll("[data-tool]").length === 7);
ok("overlay.css styles the new surfaces", [".rsa-tools {", ".rsa-bench {", ".rsa-keystrip {", ".rsa-kchip {", ".rsa-bench-tools {", ".rsa-posetools {", ".rsa-poses {", ".rsa-pose-apply {", ".rsa-layer select", ".rsa-smooth {"].every((s) => css.includes(s)));
ref("prompt").value = "natural walk cycle, loop"; click(act("generate"));
const S = AS._state;
ok("default view is the orbitable 3D viewport with joint + effector handles laid out", S.view === "3d" && S.cams.length === 1 && S.handles.filter((h) => h.kind === "joint").length === 15 && S.handles.filter((h) => h.kind === "effector").length === 4 && ops.includes("arc"));
const cv = ref("canvas"); const pe = (type, x, y, o) => cv.dispatchEvent(new w.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }, o || {})));
const yaw0 = S.cam.yaw, pitch0 = S.cam.pitch; pe("pointerdown", 400, 200); pe("pointermove", 460, 210); pe("pointerup", 460, 210);
ok("dragging empty viewport orbits the camera (yaw + pitch change)", S.cam.yaw !== yaw0 && S.cam.pitch !== pitch0, [yaw0, S.cam.yaw, pitch0, S.cam.pitch]);
const z0 = S.cam.zoom; cv.dispatchEvent(new w.WheelEvent("wheel", { deltaY: -300, bubbles: true, cancelable: true }));
ok("wheel zooms", S.cam.zoom > z0);
pe("pointerdown", 400, 200, { shiftKey: true }); pe("pointermove", 420, 230, { shiftKey: true }); pe("pointerup", 420, 230, { shiftKey: true });
ok("shift-drag pans", S.cam.pan[0] !== 0 || S.cam.pan[1] !== 0, S.cam.pan);
cv.dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true })); ok("double-click resets the camera", S.cam.yaw === 35 && S.cam.zoom === 1 && S.cam.pan[0] === 0);
click(host.querySelector('[data-view="front"]')); ok("view chips switch views (front) and keep the pinned front/side labels", S.view === "front" && host.querySelector('[data-view="front"]').classList.contains("on"));
key("5"); ok("hotkey 5 returns to the 3D view, 2 = front + side", S.view === "3d" && (key("2"), S.view === "both") && (key("5"), true));
// IK drag on the right hand
const h = S.handles.find((x) => x.eff === "r_hand"); const shoulderBefore = JSON.stringify(AS.getClip().keys[S.sel].poses.r_shoulder); const hist = S.history.length;
pe("pointerdown", h.x, h.y); pe("pointermove", h.x + 40, h.y - 60);
ok("dragging a hand handle runs live IK (ikDrag state, target reached)", S.ikDrag && S.ikDrag.eff === "r_hand" && S.ikDrag.reached, S.ikDrag && [S.ikDrag.reached, S.ikDrag.distance]);
pe("pointerup", h.x + 40, h.y - 60);
ok("IK drag commits one undo step, marks the clip edited and revalidates", !S.ikDrag && shoulderBefore !== JSON.stringify(AS.getClip().keys[S.sel].poses.r_shoulder) && AS.getClip().edited && S.history.length === hist + 1 && /IK r hand: target reached/.test(toast()));
key("z", { ctrlKey: true }); ok("Ctrl+Z undoes the IK drag", shoulderBefore === JSON.stringify(AS.getClip().keys[S.sel].poses.r_shoulder));
const jh = S.handles.find((x) => x.j === "l_knee"); pe("pointerdown", jh.x, jh.y); pe("pointerup", jh.x, jh.y);
ok("clicking a joint handle selects that joint", S.selJoint === "l_knee");
// hotkeys
const n0 = AS.getClip().keys.length; key("ArrowRight"); key("ArrowRight"); key("i");
ok("I inserts a key at the playhead and selects it", AS.getClip().keys.length === n0 + 1 && Math.abs(AS.getClip().keys[S.sel].t - S.t) < 1e-6, [n0, AS.getClip().keys.length]);
key("x"); ok("X deletes the selected key", AS.getClip().keys.length === n0);
key("D", { shiftKey: true }); ok("Shift+D duplicates the key one frame later", AS.getClip().keys.length === n0 + 1);
const selBefore = S.sel; key("ArrowUp"); ok("↑ jumps to the next key", S.sel === selBefore + 1 && Math.abs(S.t - AS.getClip().keys[S.sel].t) < 1e-6);
key("o"); ok("O toggles onion skin", S.onion === false && !ref("onionBtn").classList.contains("on")); key("o");
key("k"); ok("K toggles auto-key", S.autoKey === true && ref("autoKeyBtn").classList.contains("on")); key("k");
// 1.64: the dope sheet + graph editor are gone - G now toggles motion arcs; the key strip is the key picker
ok("no dope sheet / graph editor is left in the Studio (no editor tabs, no editor canvas, no S.editor state)", !host.querySelector("[data-editor]") && !host.querySelector("canvas.rsa-editor") && !("editor" in S) && !/renderGraph|renderDope|graphPts|dopeRows/.test(studio));
key("g"); ok("G toggles the motion-arc overlay (not a graph editor)", S.arcs === true && ref("arcsBtn").classList.contains("on")); key("g"); ok("G again hides the arcs", S.arcs === false);
const chips = host.querySelectorAll(".rsa-kchip"); ok("the key strip shows one chip per key with the selected one highlighted", chips.length === AS.getClip().keys.length && host.querySelectorAll(".rsa-kchip.on").length === 1 && chips[S.sel].classList.contains("on"));
click(chips[2]); ok("clicking a key chip selects that key and moves the playhead there", S.sel === 2 && Math.abs(S.t - AS.getClip().keys[2].t) < 1e-6, [S.sel, S.t]);
// copy / paste flipped
S.selJoint = "r_shoulder"; const srcPose = JSON.stringify(AS.getClip().keys[S.sel].poses.r_shoulder);
key("c", { ctrlKey: true }); ok("Ctrl+C copies the pose and enables Paste", S.clipboard && !ref("pasteBtn").disabled && !ref("pasteFlipBtn").disabled);
key("ArrowUp"); key("V", { ctrlKey: true, shiftKey: true });
const tgt = AS.getClip().keys[S.sel].poses; const srcR = JSON.parse(srcPose);
ok("Ctrl+Shift+V pastes X-flipped onto the next key (r_shoulder lands on l_shoulder, mirrored)", tgt.l_shoulder.rot[0] === srcR.rot[0] && tgt.l_shoulder.rot[2] === -srcR.rot[2] && /Pasted X-flipped/.test(toast()));
// lock + pose library
click(act("lockKey")); ok("Lock key flags the key and highlights the button", AS.getClip().keys[S.sel].locked === true && ref("lockBtn").classList.contains("on")); click(act("lockKey"));
ref("poseName").value = "HeroPose"; click(act("savePose"));
ok("Save pose stores the selected pose in the library (localStorage) and lists it", host.querySelectorAll("[data-pose]").length === 1 && /HeroPose/.test(mem.rsAnimPoses || ""));
key("ArrowDown"); click(host.querySelector("[data-pose]")); ok("clicking a library pose applies it to the selected key", /Applied pose "HeroPose"/.test(toast()));
click(host.querySelector("[data-pose-del]")); ok("the × deletes a library pose", host.querySelectorAll("[data-pose]").length === 0);
// clip tools
const results = {};
for (const t of ["smooth", "plant", "simplify", "reverse", "bake", "offset"]) { const before = AS.getClip().keys.length; click(host.querySelector(`[data-tool="${t}"]`)); results[t] = [before, AS.getClip().keys.length, toast()]; }
ok("Smooth / Plant feet / Simplify / Reverse / Bake / Cycle offset buttons all act on the clip with a report toast", /smoothed/.test(results.smooth[2]) && /planted feet|already planted/.test(results.plant[2]) && /simplified|No redundant/.test(results.simplify[2]) && /Reversed/.test(results.reverse[2]) && /baked \d+ frames/.test(results.bake[2]) && results.bake[1] > results.bake[0] && /Loop start moved/.test(results.offset[2]), results);
ok("each tool is one undo step", (key("z", { ctrlKey: true }), AS.getClip().keys.length === results.offset[0]) && (key("z", { ctrlKey: true }), AS.getClip().keys.length === results.bake[0]));
ok("smoothness readout is shown next to the validation score", /^\d+$/.test(ref("smoothVal").textContent));
// 1.54 spline interpolation toggle
{
  const before = AS.getClip().interp, b = host.querySelector('[data-tool="interp"]');
  click(b); const mid = AS.getClip(); click(b); const back = AS.getClip();
  ok("Eased|Spline toggle flips clip.interp, relabels the button and explains the Studio bake in the toast", mid.interp !== before && back.interp === before && /Spline curves|Eased segments/.test(toast()) && (b.textContent === (back.interp === "spline" ? "Spline" : "Eased")), [before, mid.interp, back.interp, b.textContent]);
  if (AS.getClip().interp !== "spline") click(b);
  const sp = AS.getClip(), dense = E.exportKeys(sp);
  ok("spline clips report the baked export density in the validation panel and export the frame grid", sp.interp === "spline" && new RegExp(`Curves: spline \\(C1\\) - ${sp.keys.length} authored keys, exported .* as ${dense.length} baked frames`).test(ref("report").textContent) && dense.length > sp.keys.length, ref("report").textContent.slice(0, 200));
  ok("spline sampling is C1 at interior keys (velocity does not jump)", (() => { const k = sp.keys.find((kk, i) => i > 0 && i < sp.keys.length - 1 && kk.tag !== "impact" && kk.tag !== "hold"); if (!k) return true; const e = 0.004, j = "r_shoulder"; const v = (t0, t1) => (E.sampleAt(sp, t1)[j].rot[0] - E.sampleAt(sp, t0)[j].rot[0]) / (t1 - t0); const vl = v(k.t - 2 * e, k.t - e), vr = v(k.t + e, k.t + 2 * e); return Math.abs(vl - vr) < Math.max(4, 0.2 * Math.abs(vl)); })());
  const studioPayload = E.toBuildArgs(sp, E.defaultRigInfo("R15"));
  ok("Studio payload for a spline clip is the dense Linear bake with the authored markers kept", studioPayload.keys.length === dense.length && studioPayload.keys.every((k) => k.e[0] === "Linear") && studioPayload.keys.reduce((n, k) => n + k.m.length, 0) === E.toBuildArgs(E.setInterp(sp, "eased"), E.defaultRigInfo("R15")).keys.reduce((n, k) => n + k.m.length, 0));
  click(b); if (AS.getClip().interp !== before) click(b);
}
// layer picker
ref("prompt").value = "natural walk cycle, loop"; click(act("generate")); const pick = ref("layerPick"); const names = [...pick.options].map((o) => o.value);
ok("Layer picker lists session clips (studio + AI hook) and a file option, never the current clip", names.includes("ExtWave") && names.includes("__file") && !names.includes(AS.getClip().name) && names[0] === "");
click(act("layer")); ok("Layer without a pick explains what to do", /Pick the clip/.test(toast()));
pick.value = "ExtWave"; click(act("layer"));
ok("Layer combines the picked upper body over the current clip's legs (keep-tempo fit by default since 1.58, weight 1)", AS.getClip().layered && AS.getClip().layered.requested === "auto" && AS.getClip().layered.upper === "Wave" && AS.getClip().layered.base === "RealisticWalkLoop" && AS.getClip().name === "RealisticWalkLoop+Wave" && AS.getClip().report.ok, AS.getClip().layered);
ref("layerFit").value = "loop"; ref("layerWeight").value = "0.5"; key("z", { ctrlKey: true }); click(act("layer"));
ok("fit + weight controls are honoured", AS.getClip().layered.fit === "loop" && AS.getClip().layered.weight === 0.5);
ok("API exposes the new studio verbs", ["clipTool", "layerWith", "insertKey", "copyPose", "pastePose", "setView", "resetCamera"].every((k) => typeof AS[k] === "function"));
ok("no window errors during the whole session", errors.length === 0, errors);
console.log(`test-anim-blender: ${n} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
