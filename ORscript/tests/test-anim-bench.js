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
ok("engine VERSION is 1.65.0 and exposes the workbench API", E.VERSION === "1.65.0" && ["breakdown", "holdKey", "nudgeKey", "easeAll", "EASE_PRESETS", "overlap", "setMarker", "removeMarker", "markers", "arcs", "timing"].every((k) => k in E), E.VERSION);
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

// ── Studio in jsdom ──
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", pretendToBeVisual: true, url: "https://chatgpt.com/" });
const w = dom.window; w.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 0); w.cancelAnimationFrame = (id) => clearTimeout(id);
w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400 }; };
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return 800; } }); Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 400; } });
w.HTMLCanvasElement.prototype.getContext = function () { return new Proxy({}, { get: (_, k) => (k === "measureText" ? () => ({ width: 10 }) : () => undefined), set: () => true }); };
const errors = []; w.addEventListener("error", (e) => errors.push(String(e.message)));
const mem = {}; Object.defineProperty(w, "localStorage", { value: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } } });
w.prompt = () => "0.25"; w.confirm = () => true;
for (const f of ["src/core/animengine.js", "src/core/animstudio.js"]) { const el = w.document.createElement("script"); el.textContent = read(f); w.document.head.appendChild(el); }
const AS = w.ORAnimStudio; const diags = [];
AS.open({ send: async () => true, runTool: async () => "", studioReady: () => false, engine: () => "", toast: () => {}, diag: (ev, d) => diags.push(ev), clips: () => ({}) });
const host = w.document.getElementById("rs-anim"); const ref = (k) => host.querySelector(`[data-ref="${k}"]`), act = (k) => host.querySelector(`[data-act="${k}"]`);
const toast = () => host.querySelector(".rsa-toast").textContent;
const click = (el, o) => el.dispatchEvent(new w.MouseEvent("click", Object.assign({ bubbles: true, cancelable: true }, o || {})));
const key = (k, o) => host.dispatchEvent(new w.KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, o || {})));
const studio = read("src/core/animstudio.js"), css = read("overlay.css");
const S = AS._state;

ok("the dope sheet and graph editor are gone: no editor tabs, no editor canvas, no graph/dope code, no G-graph hotkey", !host.querySelector("[data-editor]") && !host.querySelector("canvas.rsa-editor") && !/renderGraph|renderDope|graphPts|dopeRows|rsa-edtabs/.test(studio) && !/dope sheet \/ graph editor/i.test(studio.replace(/replaces the dope sheet \+ graph editor/, "")));
ok("the workbench sits where the editors were (same data-ref=editor + toggleEditor) and is empty-state before a clip", ref("editor").classList.contains("rsa-bench") && ref("keystrip") && /Generate a clip/.test(ref("keystrip").textContent) && act("breakdown").disabled && act("hold").disabled && ref("markerName").disabled);
ok("every workbench control has a doAction case + a handler; CSS covers the bench", ["breakdown", "hold", "nudgeL", "nudgeR", "marker", "overlap", "retime", "arcs"].every((a) => act(a) && studio.includes(`case "${a}":`)) && [".rsa-bench {", ".rsa-bench[hidden] { display: none !important; }", ".rsa-keystrip {", ".rsa-kchip {", ".rsa-kchip.on {", ".rsa-bench-tools {", ".rsa-bt {", ".rsa-markers {", ".rsa-marker {", ".rsa-timing {"].every((s) => css.includes(s)));
ok("six Ease-all preset chips rendered from the engine table", host.querySelectorAll("[data-ease-all]").length === 6 && [...host.querySelectorAll("[data-ease-all]")].every((b) => E.EASE_PRESETS[b.getAttribute("data-ease-all")]));
ok("the tips line teaches the new hotkeys and no longer mentions a graph editor", /<kbd>B<\/kbd> breakdown/.test(studio) && /<kbd>H<\/kbd> hold/.test(studio) && /<kbd>G<\/kbd> motion arcs/.test(studio) && !/graph editor · <kbd>Ctrl\+Z<\/kbd>/.test(studio));

ref("prompt").value = "drink a potion"; click(act("generate"));
const c0 = AS.getClip(); const n0 = c0.keys.length;
ok("after generating, the key strip lists every key and the timing read shows counts", host.querySelectorAll(".rsa-kchip").length === n0 && /keys/.test(ref("timing").textContent) && /impacts/.test(ref("timing").textContent) && !act("breakdown").disabled);
click(host.querySelectorAll(".rsa-kchip")[1]); ok("clicking a key chip selects the key (chip highlighted, playhead moved, inspector follows)", S.sel === 1 && host.querySelectorAll(".rsa-kchip")[1].classList.contains("on") && Math.abs(S.t - c0.keys[1].t) < 1e-6);
// breakdown at the playhead between key 1 and 2 with bias 25%
AS._scrub((c0.keys[1].t + c0.keys[2].t) / 2); ref("bias").value = "25"; ref("bias").dispatchEvent(new w.Event("input", { bubbles: true }));
ok("the bias slider echoes its value", ref("biasVal").textContent === "25%");
click(act("breakdown"));
ok("Breakdown inserts a 'breakdown' key at the playhead, selects it, toasts the favour, and the chip shows ~", AS.getClip().keys.length === n0 + 1 && AS.getClip().keys[S.sel].tag === "breakdown" && /favouring the previous pose \(25%\)/.test(toast()) && host.querySelector(".rsa-kchip.on i").textContent === "~" && S.history.length >= 1, [toast(), S.sel]);
const bdT = AS.getClip().keys[S.sel].t;
// hold 3 frames
ref("holdFrames").value = "3"; click(act("hold"));
ok("Hold adds a moving hold 3 frames after the selected key and selects the new hold key", AS.getClip().keys.length === n0 + 2 && AS.getClip().keys[S.sel].tag === "hold" && Math.abs(AS.getClip().keys[S.sel].t - (bdT + 3 / AS.getClip().fps)) < 2e-3 && /Moving hold/.test(toast()), [toast(), AS.getClip().keys.map((k) => k.t)]);
// nudge
const tN = AS.getClip().keys[S.sel].t; click(act("nudgeR"));
ok("Nudge ▶ moves the selected key one frame later (or explains it cannot)", Math.abs(AS.getClip().keys[S.sel].t - tN - 1 / AS.getClip().fps) < 2e-3 || /cannot move/.test(toast()), [tN, AS.getClip().keys[S.sel].t, toast()]);
key(","); key(","); ok("',' nudges back a frame (hotkey)", AS.getClip().keys[S.sel].t <= tN + 1e-6 && ordered(AS.getClip()));
// markers
ref("markerName").value = "sip=potion"; click(act("marker"));
ok("Marker adds a KeyframeMarker to the selected key, shows the chip + flag, and toasts the Studio signal name", AS.getClip().keys[S.sel].markers.length === 1 && AS.getClip().keys[S.sel].markers[0].name === "sip" && AS.getClip().keys[S.sel].markers[0].value === "potion" && host.querySelector(".rsa-marker") && /GetMarkerReachedSignal\("sip"\)/.test(toast()) && host.querySelector(".rsa-kchip.on em") && ref("markerName").value === "", toast());
ref("markerName").value = "sfx"; ref("markerName").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
ok("Enter in the marker box adds a second marker", AS.getClip().keys[S.sel].markers.length === 2 && host.querySelectorAll(".rsa-marker").length === 2);
click(host.querySelector('[data-marker-del="sfx"]'));
ok("the × on a marker chip removes that marker", AS.getClip().keys[S.sel].markers.length === 1 && host.querySelectorAll(".rsa-marker").length === 1);
ok("the clip's Studio export now carries the marker", E.toStudio(AS.getClip(), rig).keyframes[S.sel].markers.some((m) => m.name === "sip" && m.value === "potion"));
// ease all
click(host.querySelector('[data-ease-all="mechanical"]'));
ok("Ease all → Mechanical sets every key Linear, lights the chip and toasts the preset note", AS.getClip().keys.every((k) => k.ease[0] === "Linear") && host.querySelector('[data-ease-all="mechanical"]').classList.contains("on") && /Mechanical/.test(toast()));
click(host.querySelector('[data-ease-all="snappy"]')); ok("another preset replaces it", AS.getClip().easePreset === "snappy" && !host.querySelector('[data-ease-all="mechanical"]').classList.contains("on"));
// overlap
const beforeOv = JSON.stringify(AS.getClip().keys.map((k) => [k.poses.r_elbow, k.poses.neck, k.poses.r_wrist])); ref("lagFrames").value = "2"; click(act("overlap"));
ok("Overlap applies follow-through (child joints change, counter shows 2f)", JSON.stringify(AS.getClip().keys.map((k) => [k.poses.r_elbow, k.poses.neck, k.poses.r_wrist])) !== beforeOv && AS.getClip().overlapFrames === 2 && /2f/.test(ref("timing").textContent) && /Overlap/.test(toast()));
// retime
const dur0 = AS.getClip().duration; ref("retimeTo").value = "4"; click(act("retime"));
ok("Retime stretches the clip to 4 s keeping key ratios", Math.abs(AS.getClip().duration - 4) < 1e-6 && Math.abs(AS.getClip().keys[1].t / 4 - c0.keys[1].t / dur0) < 0.02 && /retimed to 4.00s/.test(toast()) && ref("retimeTo").value === "", [dur0, AS.getClip().duration, toast()]);
ref("retimeTo").value = "0"; click(act("retime")); ok("an invalid length is refused with a hint", /new length in seconds/.test(toast()) && Math.abs(AS.getClip().duration - 4) < 1e-6);
// arcs
click(act("arcs")); ok("Arcs toggles the viewport motion trails (button lit, state on, toast)", S.arcs === true && ref("arcsBtn").classList.contains("on") && /Motion arcs/.test(toast()));
key("g"); ok("G hotkey turns the arcs off again", S.arcs === false && !ref("arcsBtn").classList.contains("on"));
// hotkeys B / H
const nB = AS.getClip().keys.length; AS._scrub((AS.getClip().keys[0].t + AS.getClip().keys[1].t) / 2); key("b");
ok("B inserts a breakdown at the playhead", AS.getClip().keys.length === nB + 1 && AS.getClip().keys[S.sel].tag === "breakdown");
const nH = AS.getClip().keys.length; key("h"); ok("H adds a hold after the selected key", AS.getClip().keys.length === nH + 1 && AS.getClip().keys[S.sel].tag === "hold");
// undo through the stack
const nU = AS.getClip().keys.length; key("z", { ctrlKey: true }); ok("Ctrl+Z undoes the last workbench edit", AS.getClip().keys.length === nU - 1);
// collapse / expand
click(act("toggleEditor")); ok("the toggle hides the workbench; toggling again shows it with the strip intact", ref("editor").hidden && (click(act("toggleEditor")), !ref("editor").hidden && host.querySelectorAll(".rsa-kchip").length === AS.getClip().keys.length));
ok("workbench actions are reported through diag", ["animStudio.bench.breakdown", "animStudio.bench.hold", "animStudio.bench.marker", "animStudio.bench.easeAll", "animStudio.bench.overlap"].every((d) => diags.includes(d)), diags.filter((d) => /bench/.test(d)));
ok("the clip still validates and exports after the whole session (no NaNs, ordered keys)", AS.getClip().report && ordered(AS.getClip()) && !/NaN/.test(E.toRbxmx(AS.getClip(), rig)));
ok("no window errors during the workbench session", errors.length === 0, errors);

// ── README / help ──
const readme = read("README.md");
ok("README documents the 1.64.0 workbench and drops the dope-sheet / graph-editor claims from the feature list", /\*\*1\.64\.0 — Animation Studio key workbench/.test(readme) && !/\*\*dope sheet\*\*/.test(readme) && !/\*\*graph editor\*\*/.test(readme));

console.log(`test-anim-bench: ${n} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
