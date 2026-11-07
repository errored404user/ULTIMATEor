// 1.64.0 — Animation Studio key workbench: the dope sheet + graph editor are gone; in their place sit professional key
// tools - key strip, breakdown (tween machine), moving holds, frame nudge, KeyframeMarkers that reach Studio, ease presets,
// overlap / follow-through, retime, motion arcs and a timing read. Engine first, then the Studio in jsdom.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra) : "")); } };
const E = require(path.join(ROOT, "src/core/animengine.js"));
const ordered = (c) => c.keys.every((k, i, a) => !i || k.t > a[i - 1].t);
const rig = E.defaultRigInfo("R15");

// ── engine: breakdown / tween machine ──
const potion = E.generate("drink a potion");
ok("engine VERSION is 2.11.0 and exposes the workbench API", E.VERSION === "2.11.0" && ["breakdown", "holdKey", "nudgeKey", "easeAll", "EASE_PRESETS", "overlap", "setMarker", "removeMarker", "markers", "arcs", "timing"].every((k) => k in E), E.VERSION);
const mid = (potion.keys[1].t + potion.keys[2].t) / 2;
const bd0 = E.breakdown(potion, mid, 0), bd1 = E.breakdown(potion, mid, 1), bd5 = E.breakdown(potion, mid, 0.5);
ok("breakdown inserts ONE key tagged 'breakdown' between the neighbours and keeps the clip valid + ordered", bd5.inserted && bd5.clip.keys.length === potion.keys.length + 1 && bd5.clip.keys[bd5.index].tag === "breakdown" && ordered(bd5.clip) && bd5.clip.report.errors === 0, [bd5.index, bd5.clip.keys.length]);
const J = "r_shoulder";
ok("bias 0 copies the previous pose, bias 1 the next pose, bias .5 the midpoint (the tween-machine contract)", JSON.stringify(bd0.clip.keys[bd0.index].poses[J].rot) === JSON.stringify(potion.keys[1].poses[J].rot) && JSON.stringify(bd1.clip.keys[bd1.index].poses[J].rot) === JSON.stringify(potion.keys[2].poses[J].rot) && [0, 1, 2].every((a) => Math.abs(bd5.clip.keys[bd5.index].poses[J].rot[a] - (potion.keys[1].poses[J].rot[a] + potion.keys[2].poses[J].rot[a]) / 2) < 0.002));
const bdOn = E.breakdown(potion, potion.keys[1].t, 0.25);
ok("a breakdown ON an existing key re-poses that key instead of adding one", !bdOn.inserted && bdOn.index === 1 && bdOn.clip.keys.length === potion.keys.length && bdOn.clip.keys[1].tag === "breakdown");
ok("breakdown at the very start degrades to a plain key with a reason (no neighbour on one side)", /no neighbour/.test(E.breakdown(potion, 0, 0.5).reason || ""));

// ── engine: holds ──
const h = E.holdKey(potion, 1, 4);
ok("holdKey repeats the pose 4 frames later as a 'hold' key with Linear ease (flat), later keys pushed back if needed, still ordered", h.clip.keys[h.index].tag === "hold" && Math.abs(h.clip.keys[h.index].t - (potion.keys[1].t + 4 / potion.fps)) < 2e-3 && JSON.stringify(h.clip.keys[h.index].poses) === JSON.stringify(potion.keys[1].poses) && h.clip.keys[1].ease[0] === "Linear" && ordered(h.clip) && h.clip.report.errors === 0, [h.index, h.clip.keys.map((k) => k.t)]);
ok("sampling inside the hold returns the held pose (the pose actually reads)", JSON.stringify(E.sampleAt(h.clip, potion.keys[1].t + 2 / potion.fps)[J].rot) === JSON.stringify(potion.keys[1].poses[J].rot));
ok("holdKey on the last key explains it cannot", /end/.test(E.holdKey(potion, potion.keys.length - 1, 3).reason || ""));
ok("smooth() keeps hold keys (they are anchors)", E.smooth(h.clip, { strength: 1 }).keys.some((k) => k.tag === "hold"));

// ── engine: nudge ──
const nz = E.nudgeKey(potion, 2, 2), nzBack = E.nudgeKey(potion, 2, -200);
ok("nudgeKey moves a key by whole frames and never passes its neighbours", Math.abs(nz.keys[2].t - (potion.keys[2].t + 2 / potion.fps)) < 2e-3 && ordered(nz) && nzBack.keys[2].t > potion.keys[1].t && ordered(nzBack), [potion.keys[2].t, nz.keys[2].t, nzBack.keys[2].t]);

// ── engine: ease presets ──
const punch = E.generate("heavy punch");
const presets = Object.keys(E.EASE_PRESETS);
ok("six ease presets with labels + notes", presets.length === 6 && ["snappy", "organic", "mechanical", "bouncy", "elastic", "anticipate"].every((p) => presets.includes(p) && E.EASE_PRESETS[p].label && E.EASE_PRESETS[p].note));
const mech = E.easeAll(punch, "mechanical"), bouncy = E.easeAll(punch, "bouncy"), heldB = E.easeAll(h.clip, "bouncy");
ok("mechanical = every key Linear; bouncy = Bounce Out on impacts, CubicV2 Out elsewhere; holds stay Linear", mech.keys.every((k) => k.ease[0] === "Linear") && bouncy.keys.filter((k) => k.tag === "impact").every((k) => k.ease[0] === "Bounce" && k.ease[1] === "Out") && bouncy.keys.filter((k) => !k.tag || k.tag === "key").every((k) => k.ease[0] === "CubicV2") && heldB.keys.filter((k) => k.tag === "hold").every((k) => k.ease[0] === "Linear") && bouncy.easePreset === "bouncy", bouncy.keys.map((k) => (k.tag || "key") + ":" + k.ease.join("/")));
ok("ease presets reach the Studio export (robloxEase flips the direction convention)", E.toStudio(bouncy, rig).keyframes.some((k) => k.easing.style === "Bounce") && E.toStudio(mech, rig).keyframes.every((k) => k.easing.style === "Linear"));

// ── engine: overlap / follow-through ──
const walk = E.generate("natural walk cycle, loop");
const ov = E.overlap(walk, 2);
const changed = ov.keys.filter((k, i) => JSON.stringify(k.poses.l_ankle) !== JSON.stringify(walk.keys[i].poses.l_ankle)).length;
ok("overlap shifts child joints (ankles, knees, elbows, head) in time on most keys, leaves shoulders and root untouched, keeps the loop closed", changed >= walk.keys.length / 2 && ov.keys.every((k, i) => JSON.stringify(k.poses.l_shoulder) === JSON.stringify(walk.keys[i].poses.l_shoulder) && JSON.stringify(k.poses.root) === JSON.stringify(walk.keys[i].poses.root)) && JSON.stringify(ov.keys[0].poses) === JSON.stringify(ov.keys[ov.keys.length - 1].poses) && ov.overlapFrames === 2 && ov.report.errors === 0, [changed, walk.keys.length]);
const ovW = E.overlap(walk, 2, ["l_ankle"]);
ok("overlap accepts a joint list (only l_ankle changes)", ovW.keys.every((k, i) => JSON.stringify(k.poses.r_ankle) === JSON.stringify(walk.keys[i].poses.r_ankle) && JSON.stringify(k.poses.neck) === JSON.stringify(walk.keys[i].poses.neck)) && ovW.keys.some((k, i) => JSON.stringify(k.poses.l_ankle) !== JSON.stringify(walk.keys[i].poses.l_ankle)));
const ovP = E.overlap(potion, 2);
ok("one-shot clips keep their first and last poses under overlap (rest in, rest out)", JSON.stringify(ovP.keys[0].poses) === JSON.stringify(potion.keys[0].poses) && JSON.stringify(ovP.keys[ovP.keys.length - 1].poses) === JSON.stringify(potion.keys[potion.keys.length - 1].poses));

// ── engine: the Refine box / animation_refine understand the workbench tools by name ──
const fbO = E.applyFeedback(punch, "more follow-through by 3 frames"), fbE = E.applyFeedback(punch, "make it bouncy"), fbH = E.applyFeedback(punch, "hold the impact for 4 frames"), fbX = E.applyFeedback(punch, "do the thing");
ok("feedback 'more follow-through by 3 frames' applies overlap 3f and is NOT reported as unrecognised", fbO.overlapFrames === 3 && fbO.feedback.slice(-1)[0].applied.join(" ") === "overlap 3f (follow-through)", fbO.feedback.slice(-1)[0].applied);
ok("feedback 'bouncy' applies the bouncy ease preset; 'hold the impact for 4 frames' adds a moving hold on the impact", fbE.easePreset === "bouncy" && fbH.keys.some((k) => k.tag === "hold") && /moving hold.*4f/.test(fbH.feedback.slice(-1)[0].applied.join(" ")) && fbH.keys.length === punch.keys.length + 1, [fbE.feedback.slice(-1)[0].applied, fbH.feedback.slice(-1)[0].applied]);
ok("unrecognised feedback still says so and lists the new phrases", /no recognised adjustment/.test(fbX.feedback.slice(-1)[0].applied[0]) && /follow-through/.test(fbX.feedback.slice(-1)[0].applied[0]));
ok("animlib tells the model about follow-through / holds / ease presets", /more follow-through/.test(read("src/core/animlib.js")) && /moving holds/.test(read("src/core/animlib.js")));

// ── engine: markers → Studio ──
let mk = E.setMarker(walk, 2, "footstep", "left"); mk = E.setMarker(mk, 2, "sfx", "step1"); mk = E.setMarker(mk, 4, "footstep", "right"); mk = E.setMarker(mk, 2, "footstep", "LEFT");
const list = E.markers(mk);
ok("setMarker stores named markers per key (same name replaces, different names stack) and markers() lists them in time order", list.length === 3 && list.filter((m) => m.index === 2).length === 2 && list.find((m) => m.index === 2 && m.name === "footstep").value === "LEFT" && list.every((m, i, a) => !i || m.t >= a[i - 1].t), list);
const st = E.toStudio(mk, rig).keyframes;
ok("toStudio emits the markers on the right keyframes (Studio KeyframeMarker → GetMarkerReachedSignal)", st[2].markers.some((m) => m.name === "footstep" && m.value === "LEFT") && st[2].markers.some((m) => m.name === "sfx" && m.value === "step1") && st[4].markers.some((m) => m.name === "footstep" && m.value === "right"));
const xml = E.toRbxmx(mk, rig);
ok("the .rbxmx export carries the KeyframeMarkers too", (xml.match(/class="KeyframeMarker"/g) || []).length >= 3 && /footstep/.test(xml) && /step1/.test(xml));
const rm = E.removeMarker(mk, 2, "sfx");
ok("removeMarker drops one name and leaves the others", E.markers(rm).length === 2 && !E.markers(rm).some((m) => m.name === "sfx"));
ok("markers survive the retime / moveKey / smooth pipeline (they live on the key)", E.markers(E.retime(mk, 3)).length === 3 && E.markers(E.moveKey(mk, 2, mk.keys[2].t + 0.01)).length === 3 && E.markers(E.smooth(mk, { strength: 1 })).length >= 2);
ok("the model-facing build args include the markers", E.toBuildArgs(mk, rig).keys[2].m.some((m) => m.name === "footstep" || m[0] === "footstep" || JSON.stringify(m).includes("footstep")));

// ── engine: arcs + timing ──
const A = E.arcs(walk, ["r_hand", "l_foot"], 24);
ok("arcs returns per-effector 3D trails with key flags", Object.keys(A).length === 2 && A.r_hand.length === 24 && A.r_hand.every((s) => s.p.length === 3 && Number.isFinite(s.p[1])) && A.r_hand[0].key === true && A.r_hand.some((s) => !s.key) && Math.abs(A.r_hand[23].t - walk.duration) < 1e-6);
const even = Object.assign({}, potion, { loop: false, keys: [0, 0.4, 0.8, 1.2, 1.6].map((t, i) => Object.assign({}, potion.keys[Math.min(i, potion.keys.length - 1)], { t })) , duration: 1.6 });
const tmE = E.timing(even), tmH = E.timing(h.clip);
ok("timing() counts holds / breakdowns / markers / impacts and flags evenly spaced keys on one-shots", tmH.holds === E.timing(potion).holds + 1 && tmE.notes.some((x) => x.kind === "even") && E.timing(mk).markers === 3 && Array.isArray(tmE.gaps), tmE.notes.map((x) => x.kind));
ok("timing() does not nag a loop for being evenly spaced (cycles are)", !E.timing(walk).notes.some((x) => x.kind === "even"));

// ── README / help ──
const readme = read("README.md");
ok("README documents the 1.64.0 workbench and drops the dope-sheet / graph-editor claims from the feature list", /\*\*1\.64\.0 — Animation Studio key workbench/.test(readme) && !/\*\*dope sheet\*\*/.test(readme) && !/\*\*graph editor\*\*/.test(readme));

console.log(`test-anim-bench: ${n} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
