// 1.67.0 — Animation Studio viewport draws a blocky Roblox-style rig: one lit
// block per bone in the joint's own frame (fkFull), classic default-avatar
// colours (yellow head + arms, blue torso, green legs), a face on the front of
// the head, R15 = 15 blocks, R6 = single torso block. Rendered through a
// recording canvas and checked as polygons.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 500) : "")); } };
const { JSDOM, VirtualConsole } = require("jsdom");
const vc = new VirtualConsole(); vc.on("error", () => {}); vc.on("jsdomError", () => {});
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.com/", virtualConsole: vc });
const w = dom.window; w.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const ops = []; let cur = null;
function mkctx(cv) {
  const st = { fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "" };
  return new Proxy(st, { get: (t, k) => { if (k in t) return t[k]; return (...a) => { if (k === "beginPath") cur = { pts: [], el: [] }; else if (k === "moveTo" || k === "lineTo") cur && cur.pts.push([a[0], a[1]]); else if (k === "ellipse" || k === "arc") cur && cur.el.push(a); else if (k === "fill") ops.push({ cv, op: "fill", pts: cur.pts, el: cur.el, style: String(t.fillStyle) }); else if (k === "stroke") ops.push({ cv, op: "stroke", pts: cur.pts, el: cur.el, style: String(t.strokeStyle), lw: t.lineWidth }); else if (k === "measureText") return { width: 10 }; return undefined; }; }, set: (t, k, v) => { t[k] = v; return true; } });
}
w.HTMLCanvasElement.prototype.getContext = function () { return mkctx(this.className); };
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return 900; } }); Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 520; } });
w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 900, height: 520, right: 900, bottom: 520 }; };
w.eval(read("src/core/animengine.js")); w.eval(read("src/core/animlib.js")); w.eval(read("src/core/animstudio.js"));
const AS = w.ORAnimStudio, E = w.ORAnimEngine;
AS.open(); AS._state.onion = false;
const src = read("src/core/animstudio.js");

const pv = () => ops.filter((o) => o.cv === "rsa-canvas"); // the viewport only (the timeline draws key diamonds)
const quads = () => pv().filter((o) => o.op === "fill" && o.pts.length === 4);
const colourOf = (s) => { const m = s.match(/rgba\((\d+),(\d+),(\d+),/); return m ? [+m[1], +m[2], +m[3]] : null; };
const isYellow = (c) => c && c[0] > 150 && c[1] > 120 && c[2] < 90;
const isBlue = (c) => c && c[2] > 90 && c[0] < 60;
const isGreen = (c) => c && c[1] > 100 && c[1] > c[0] && c[2] < 100 && c[0] > 80;
function render(prompt, rigType, view, t) {
  const clip = E.generate(prompt, { quality: "balanced", rigType });
  AS.loadClip(clip); AS.setView(view); ops.length = 0; AS._scrub(t == null ? 0.3 : t);
  return clip;
}

// ── R15, front ──
render("looping idle with calm breathing", "R15", "front", 0.3);
let q = quads();
ok("source: blocks are built in each joint's own frame from fkFull (points + rotations), not from bare FK points", /drawRig\(ctx, E\(\)\.fkFull\(poses\), cam/.test(src) && /const pts = rig\.pts \|\| rig, world = rig\.world/.test(src) && /mulV\(w\.R, l\)/.test(src));
ok("source: R15 part table has exactly 15 blocks (lower/upper torso, head, 3 per arm, 3 per leg) and R6 a single torso block", (src.match(/\["[a-z_]+", -?[\d.]+, -?[\d.]+, [\d.]+, [\d.]+, "(torso|head|arm|leg)"/g) || []).length === 15 + 14 && /const PARTS_R6 = \[\n\s*\["waist", -0\.42, 1\.2/.test(src));
ok("front view of an idle R15 fills lit block faces (>= 15 quads, one per visible block) - no stick-figure line pass", q.length >= 15 && q.length <= 60, q.length);
const cols = q.map((o) => colourOf(o.style));
ok("Roblox default-avatar colours: yellow (head/arms), blue (torso), green (legs) all present; nothing grey", cols.some(isYellow) && cols.some(isBlue) && cols.some(isGreen) && !cols.some((c) => c && Math.abs(c[0] - c[1]) < 8 && Math.abs(c[1] - c[2]) < 8 && c[0] > 150), cols.slice(0, 6));
const yellowQ = q.filter((o) => isYellow(colourOf(o.style))).length, blueQ = q.filter((o) => isBlue(colourOf(o.style))).length, greenQ = q.filter((o) => isGreen(colourOf(o.style))).length;
ok("block counts by colour make sense from the front (7 yellow = head + 6 arm blocks, 2 blue torso blocks, 6 green leg blocks, each 1-3 faces)", yellowQ >= 7 && yellowQ <= 21 && blueQ >= 2 && blueQ <= 6 && greenQ >= 6 && greenQ <= 18, { yellowQ, blueQ, greenQ });
const eyes = pv().filter((o) => o.op === "fill" && o.el.length === 1 && /rgba\(20,20,26/.test(o.style));
const smile = pv().filter((o) => o.op === "stroke" && o.pts.length === 9 && /rgba\(20,20,26/.test(o.style));
ok("the head shows a face from the front: two dark eyes + a 9-point smile", eyes.length === 2 && smile.length === 1, { eyes: eyes.length, smile: smile.length });
const lit = new Set(q.filter((o) => isBlue(colourOf(o.style))).map((o) => o.style));
ok("faces are shaded per normal (the torso shows more than one blue shade in 3D)", (() => { render("looping idle with calm breathing", "R15", "3d", 0.3); const b = new Set(quads().filter((o) => isBlue(colourOf(o.style))).map((o) => o.style)); return b.size >= 2; })(), [...lit]);
// back view: no face
render("looping idle with calm breathing", "R15", "back", 0.3);
ok("from the back the face is hidden (back-face culling on the head's -z face)", pv().filter((o) => o.op === "fill" && o.el.length === 1 && /rgba\(20,20,26/.test(o.style)).length === 0);
// left / right seams
render("wave hello", "R15", "front", 0.5);
const seams = pv().filter((o) => o.op === "stroke" && o.pts.length === 4);
ok("left / right blocks keep their blue / orange seam so the sides stay tellable apart; centre blocks get a dark seam", seams.some((o) => /127,178,255/.test(o.style)) && seams.some((o) => /255,159,110/.test(o.style)) && seams.some((o) => /0,0,0,\.45/.test(o.style)));
// selected joint
AS._state.selJoint = "r_elbow"; ops.length = 0; AS._scrub(0.5);
ok("the blocks touching the selected joint are outlined gold", pv().filter((o) => o.op === "stroke" && o.pts.length === 4 && o.style === "#ffd166" && o.lw === 2).length >= 2);
AS._state.selJoint = "r_shoulder";
// ── R6 ──
render("looping idle with calm breathing", "R6", "front", 0.3);
q = quads();
ok("R6 front: still blocky; the torso is ONE block (1-3 blue faces) and the head is the bigger cube", q.filter((o) => isBlue(colourOf(o.style))).length <= 3 && q.filter((o) => isYellow(colourOf(o.style))).length >= 7);
// ghosts / onion skins stay translucent outlines
render("walk", "R15", "front", 0.4);
AS._state.onion = true; AS._state.playing = false; ops.length = 0; AS._scrub(0.4);
ok("onion skins draw the same blocks as translucent tinted outlines", pv().some((o) => o.op === "fill" && o.pts.length === 4 && /rgba\(126,178,255,\.3\)/.test(o.style)) && pv().some((o) => o.op === "stroke" && o.pts.length === 4 && /rgba\(255,159,110,\.3\)/.test(o.style)));
AS._state.onion = false;
// sword
render("sword slash combo", "R15", "3d", 0.4);
ok("the sword still hangs off the right hand (blade + cross-guard)", pv().some((o) => o.op === "stroke" && o.style === "#c9d6ff") && pv().some((o) => o.op === "stroke" && o.style === "#8a6a2a"));
// handles unchanged
ok("joint handles / IK effectors still render on top for dragging", AS._state.handles.length >= 15 && AS._state.handles.some((h) => h.kind === "effector"));
const readme = read("README.md");
ok("README documents the blocky rig (1.67.0)", /\*\*1\.67\.0 — /.test(readme) && /blocky/i.test(readme) && /test-anim-blocky\.js/.test(readme));
console.log(`test-anim-blocky: ${n} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
