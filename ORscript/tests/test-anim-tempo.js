// 1.67.1 — keep the tempo when combining animations + plain speed words.
// Chained clips ("A then B") used to join with a fixed 0.25 s snap, layering stretched the upper clip to the base
// length (a 2 s wave over a 1 s walk = 2× faster), a model-picked duration squeezed whole sequences, and "make it slow"
// was not even recognised. Engine-only + string pins; no jsdom needed.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) passed++; else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra) : "")); } }
const ctx = { window: {}, console }; ctx.window.window = ctx.window; vm.createContext(ctx);
vm.runInContext(read("src/core/animengine.js"), ctx);
const E = ctx.window.ORAnimEngine;
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

// sampled peak angular rate (deg/s) of the interpolated motion - comparable across clips with different key densities
function peakRate(clip, joints, t0, t1, dt) {
  dt = dt || 1 / 60; t0 = t0 || 0; t1 = t1 == null ? clip.duration : Math.min(t1, clip.duration); let m = 0, prev = E.sampleAt(clip, t0);
  for (let t = t0 + dt; t <= t1 + 1e-9; t += dt) { const cur = E.sampleAt(clip, t); for (const j of joints || Object.keys(cur)) { if (j === "root" || !prev[j] || !cur[j]) continue; const r = Math.hypot(...cur[j].rot.map((v, k) => v - prev[j].rot[k])) / dt; if (r > m) m = r; } prev = cur; }
  return m;
}
const UPPER = ["r_shoulder", "r_elbow", "l_shoulder", "l_elbow", "neck"];

// ── layering keeps the tempo ─────────────────────────────────────────────────────────────────────
const walk = E.generate("walk cycle"), wave = E.generate("wave"), idle = E.generate("idle"), jump = E.generate("jump"), dance = E.generate("dance");
const auto = E.layer(walk, wave, {});
ok("layer() default is 'auto' (keep tempo): a 2 s wave over a 1 s walk gives a 2 s clip, not a 1 s clip with a 2× wave", auto.layered.requested === "auto" && near(auto.duration, wave.duration, 1e-3) && auto.loop === true && auto.report.ok, [auto.duration, auto.layered]);
ok("auto: the base walk is tiled (two cycles, phase preserved) and the wave is NOT sped up (sampled upper-body peak within 20% of the solo wave; 'stretch' is ~1.5×)", auto.stages.some((s) => /walk_cycle_2/.test(s.name)) && peakRate(auto, UPPER) <= peakRate(wave, UPPER) * 1.2 && (() => { const t = 0.25 * walk.duration; const a = E.sampleAt(auto, t), b = E.sampleAt(walk, t); return Math.abs(a.l_hip.rot[0] - b.l_hip.rot[0]) < 6; })(), [peakRate(auto, UPPER), peakRate(wave, UPPER)]);
ok("auto reports what it did (tempo note in layered + limitations)", /kept tempo/.test(auto.layered.tempo || "") && auto.limitations.some((l) => /kept tempo/.test(l)));
const stretched = E.layer(walk, wave, { fit: "stretch" });
ok("explicit 'stretch' still compresses (the old behaviour is opt-in now)", stretched.layered.fit === "stretch" && near(stretched.duration, walk.duration, 1e-3) && peakRate(stretched, UPPER) > peakRate(wave, UPPER) * 1.5, [stretched.duration, peakRate(stretched, UPPER)]);
ok("layered clips interpolate with a spline (the re-sampled upper body stays fluent instead of pulsing between dense keys)", auto.interp === "spline" && stretched.interp === "spline");
ok("explicit 'loop' is unchanged", E.layer(walk, wave, { fit: "loop" }).layered.fit === "loop");
const longBase = E.layer(idle, wave, {});
ok("auto with a longer base: the one-shot wave plays once at its own speed and holds (fit → hold), clip keeps the base length", longBase.layered.fit === "hold" && near(longBase.duration, idle.duration, 1e-3) && peakRate(longBase, UPPER) <= peakRate(wave, UPPER) * 1.2 && longBase.report.ok, [longBase.duration, longBase.layered.fit]);
const oneShotBase = E.layer(jump, wave, {});
ok("auto with a one-shot base shorter than the upper clip: the base holds its last pose instead of the upper clip rushing", near(oneShotBase.duration, wave.duration, 1e-3) && oneShotBase.stages.some((s) => s.kind === "hold") && peakRate(oneShotBase, UPPER) <= peakRate(wave, UPPER) * 1.2 && oneShotBase.report.ok, [oneShotBase.duration, oneShotBase.stages.map((s) => s.name)]);
const loopUpper = E.layer(idle, dance, {});
ok("auto with a looping upper clip shorter than the base repeats it at its own period", dance.loop && loopUpper.layered.fit === "loop" && near(loopUpper.duration, idle.duration, 1e-3) && loopUpper.report.ok, [dance.loop, loopUpper.layered.fit]);
ok("explicit 'hold' is accepted", E.layer(idle, wave, { fit: "hold" }).layered.fit === "hold");
const ww = E.generate("wave while walking");
ok("'wave while walking' no longer truncates the wave to one walk cycle", ww.layered && near(ww.duration, wave.duration, 0.05) && ww.loop && ww.stages.some((s) => /walk_cycle_2/.test(s.name)) && ww.report.ok, [ww.duration, ww.stages.map((s) => s.name)]);
const travelWalk = E.generate("walk cycle with root motion");
const tl = E.layer(travelWalk, wave, {});
ok("tiling a root-motion base keeps the forward offset growing across cycles", travelWalk.travel && tl.keys[tl.keys.length - 1].poses.root.pos[2] > travelWalk.keys[travelWalk.keys.length - 1].poses.root.pos[2] * 1.5, [tl.keys[tl.keys.length - 1].poses.root.pos, travelWalk.keys[travelWalk.keys.length - 1].poses.root.pos]);

// ── chained clips blend at a calm rate ───────────────────────────────────────────────────────────
const kick = E.generate("kick"), chain = E.generate("wave then kick then jump");
ok("a chain records its joins (where, how long, how far the pose had to travel)", Array.isArray(chain.joins) && chain.joins.length === 2 && chain.joins.every((j) => j.gap >= 0.25 && j.gap <= 0.9 && j.deg >= 0), chain.joins);
ok("the join is no longer the fastest motion in the clip: sampled peak across every join ≤ 520 deg/s (160 deg/s average, CubicV2 in-out) and below each part's own peak", chain.joins.every((j, i) => { const r = peakRate(chain, null, j.at, j.at + j.gap); return r <= 520 && r < Math.max(peakRate([wave, kick, jump][i]), peakRate([wave, kick, jump][i + 1])); }), chain.joins.map((j) => Math.round(peakRate(chain, null, j.at, j.at + j.gap))));
ok("each part keeps its own tempo inside the chain (wave / kick / jump peak rates within 10% of the solo clips)", (() => { let t0 = 0; return chain.parts.every((p, i) => { const solo = [wave, kick, jump][i]; const r = peakRate(chain, null, t0 + 1e-3, t0 + p.duration - 1e-3), rs = peakRate(solo); t0 += p.duration + (chain.joins[i] ? chain.joins[i].gap : 0); return r <= rs * 1.1; }); })());
ok("the last key of every earlier part eases in-out (a segment takes the ease of the key that starts it, so the blend accelerates out and settles in)", chain.joins.every((j) => { const k = chain.keys.find((x) => near(x.t, j.at, 1e-3)); return k && k.ease[0] === "CubicV2" && k.ease[1] === "InOut"; }) && chain.keys.filter((k) => /^2\./.test(k.stage || "")).slice(-1)[0].ease[1] === "InOut");
ok("the duration is parts + joins and the clip validates", near(chain.duration, chain.parts.reduce((a, p) => a + p.duration, 0) + chain.joins.reduce((a, j) => a + j.gap, 0), 0.05) && chain.report.errors === 0, [chain.duration]);
const big = E.generate("salute then bow then sit down then wave then kick");
ok("a 5-part chain still blends every seam calmly", big.joins.length === 4 && big.joins.every((j) => peakRate(big, null, j.at, j.at + j.gap) <= 520) && big.report.errors === 0, big.joins.map((j) => Math.round(peakRate(big, null, j.at, j.at + j.gap))));

// ── a duration the model picks never rushes the clip ─────────────────────────────────────────────
const soft = E.generate("wave then kick then jump", { duration: 2, softDuration: true });
ok("softDuration: 2 s asked for a 5.8 s chain → trimmed to ~75%, never squeezed to 2 s; the clip says why", soft.duration >= chain.duration * 0.75 - 0.05 && soft.duration < chain.duration && soft.limitations.some((l) => /tempo kept/.test(l)), [soft.duration, chain.duration, soft.limitations]);
ok("without the flag the duration is exact (Studio form / explicit asks)", near(E.generate("wave then kick then jump", { duration: 2 }).duration, 2, 1e-3));
ok("softDuration never blocks a LONGER duration", near(E.generate("wave then kick then jump", { duration: 9, softDuration: true }).duration, 9, 1e-3));
const combo = E.generate("3 hit sword combo"), softCombo = E.generate("3 hit sword combo", { duration: 1, softDuration: true }), pinned = E.generate("3 hit sword combo in 1 second", { duration: 1, softDuration: true });
ok("single clips too: a 1 s ask on a 2.75 s combo keeps ≥ 75% of the natural length", softCombo.duration >= combo.duration * 0.75 - 0.05 && softCombo.limitations.some((l) => /tempo kept/.test(l)), [combo.duration, softCombo.duration]);
ok("'in 1 second' IN THE PROMPT still pins it exactly", near(pinned.duration, 1, 1e-3) && !pinned.limitations.some((l) => /tempo kept/.test(l)));
ok("parseIntent marks explicit durations", E.parseIntent("wave for 3 seconds").durationExplicit === true && !E.parseIntent("wave").durationExplicit);

// ── speed words in the prompt ────────────────────────────────────────────────────────────────────
const d = (p) => E.generate(p).duration;
ok("'slow wave' / 'fast wave' change an emote's length (emotes and idles used to ignore tempo words)", d("slow wave") > d("wave") && d("fast wave") < d("wave") && d("slow idle") > d("idle"), [d("slow wave"), d("wave"), d("fast wave")]);
ok("magnitude: very slow > slow, slow motion > very slow; very fast < fast", d("very slow wave") > d("slow wave") && d("slow motion wave") > d("very slow wave") && d("very fast wave") < d("fast wave"), [d("very slow wave"), d("slow motion wave"), d("very fast wave")]);
ok("more tempo vocabulary: sluggish / leisurely / unhurried slow it, brisk / speedy / fast-paced speed it up", E.parseIntent("sluggish walk").speed < 1 && E.parseIntent("leisurely stroll").speed < 1 && E.parseIntent("unhurried wave").speed < 1 && E.parseIntent("brisk walk").speed > 1 && E.parseIntent("speedy run").speed > 1 && E.parseIntent("fast-paced punch combo").speed > 1);

// ── speed words as feedback ──────────────────────────────────────────────────────────────────────
const fb = (text, base) => { const c = E.applyFeedback(base || combo, text); return { c, notes: c.feedback[c.feedback.length - 1].applied, p: c.params }; };
const table = [
  ["make it slow", (r) => near(r.p.speed, 0.8, 1e-3) && r.c.duration > combo.duration],
  ["make it fast", (r) => near(r.p.speed, 1.25, 1e-3) && r.c.duration < combo.duration],
  ["it's too fast", (r) => r.p.speed < 1],
  ["too slow", (r) => r.p.speed > 1],
  ["not so fast", (r) => r.p.speed < 1],
  ["slow it down", (r) => r.p.speed < 1],
  ["speed it up", (r) => r.p.speed > 1],
  ["slowly please", (r) => r.p.speed < 1],
  ["a bit slower", (r) => near(r.p.speed, 1 / 1.12, 1e-2)],
  ["much faster", (r) => near(r.p.speed, 1.6, 1e-3)],
  ["way slower", (r) => near(r.p.speed, 1 / 1.6, 1e-2)],
  ["half speed", (r) => near(r.p.speed, 0.5, 1e-3) && /half speed/.test(r.notes.join(" "))],
  ["2x faster", (r) => near(r.p.speed, 2, 1e-3)],
  ["twice as fast", (r) => near(r.p.speed, 2, 1e-3)],
  ["30% slower", (r) => near(r.p.speed, 1 / 1.3, 1e-2) && /30% slower/.test(r.notes.join(" "))],
  ["slow motion", (r) => near(r.p.speed, 0.5, 1e-3)],
  ["slower attacks", (r) => near(r.p.attackSpeed, 0.8, 1e-3) && near(r.p.speed, 1, 1e-6)],
  ["faster attacks and heavier landing", (r) => near(r.p.attackSpeed, 1.35, 1e-3) && near(r.p.speed, 1, 1e-6) && /heavier/.test(r.notes.join(" "))],
  ["make the transitions snappier", (r) => r.p.join === "snappy" && near(r.p.speed, 1, 1e-6) && /snappy transitions/.test(r.notes.join(" "))],
  ["fluent", (r) => r.p.join === "soft" && r.c.quality === "high" && /spline smoothing pass/.test(r.notes.join(" ")) && /fluent transitions/.test(r.notes.join(" "))],
  ["make it more fluid and natural", (r) => r.p.join === "soft" && /spline smoothing pass/.test(r.notes.join(" "))],
  ["make it smoother", (r) => /spline smoothing pass/.test(r.notes.join(" ")) && r.c.quality === "high"],
  ["less jerky", (r) => /spline smoothing pass/.test(r.notes.join(" "))],
];
for (const [text, check] of table) { const r = fb(text); ok("feedback '" + text + "' is understood", check(r) && r.c.report.ok, [r.notes, r.p.speed, r.p.attackSpeed, r.p.join, r.c.duration]); }
ok("speed feedback compounds across rounds ('slower' twice = 0.64×)", near(fb("slower", fb("slower").c).p.speed, 0.64, 1e-3));
ok("a chain slows down as a whole and keeps calm joins", (() => { const s = fb("make it slow", chain); return s.c.duration > chain.duration * 1.15 && s.c.joins.every((j) => peakRate(s.c, null, j.at, j.at + j.gap) <= 520); })());
ok("'fluent' on a chain lengthens the blends between parts (≤ 360 deg/s sampled peak) and 'snappier transitions' shortens them", (() => { const f = fb("make it fluent", chain), sn = fb("snappier transitions", chain); return f.c.joins.reduce((a, j) => a + j.gap, 0) > chain.joins.reduce((a, j) => a + j.gap, 0) && f.p.join === "soft" && f.c.joins.every((j) => peakRate(f.c, null, j.at, j.at + j.gap) <= 360) && sn.c.joins.reduce((a, j) => a + j.gap, 0) < chain.joins.reduce((a, j) => a + j.gap, 0); })());
ok("the 'nothing recognised' hint teaches the new words", /make it slow \/ fast/.test(fb("make it pop").notes.join(" ")) && /fluent/.test(fb("make it pop").notes.join(" ")));

// ── wiring: Studio overlay, model-facing command, docs ───────────────────────────────────────────
const studio = read("src/core/animstudio.js"), main = read("src/core/main.js"), animlib = read("src/core/animlib.js");
ok("Animation Studio layer select defaults to keep-tempo and offers stretch / loop / hold", /<option value="auto">keep tempo \(auto\)<\/option><option value="stretch">/.test(studio) && /<option value="hold">play once, hold<\/option>/.test(studio) && /\["loop", "stretch", "hold"\]\.includes\(D\.layerFit\.value\) \? D\.layerFit\.value : "auto"/.test(studio));
ok("Studio feedback box advertises the speed words", /placeholder="make it slow · a bit faster · fluent ·/.test(studio) && /Understands speed \("make it slow \/ fast"/.test(studio));
ok("main.js: model-picked durations are soft and animation_layer defaults to auto", /softDuration: true, loop, fps, name: nameOf\(\)/.test(main) && /\["loop", "stretch", "hold", "auto"\]\.includes\(String\(args\.fit \|\| ""\)\) \? String\(args\.fit\) : "auto"/.test(main) && /keep tempo → /.test(main));
ok("main.js next-steps hint lists the speed words", /make it slow \/ fast, a bit slower, 2x faster, fluent/.test(main));
ok("animlib documents the new refine vocabulary and the layer fit modes", /'make it slow' \/ 'make it fast'/.test(animlib) && /auto \(keep tempo, default\) \| stretch \| loop \| hold/.test(animlib) && /1\.58: tempo is kept when combining/.test(animlib));

console.log(`test-anim-tempo: ${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
