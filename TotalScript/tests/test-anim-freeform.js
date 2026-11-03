// 1.69.0 — Freeform choreography: any prompt becomes its own motion (act lexicon, "A then B" chains, "X while walking"
// layering, pose grammar, mood overlays, seeded improvisation that is reported as such), moods / "then …" as feedback, and
// the tidied Animation Studio (numbered cards, quiet viewport, Pose / Clip / Check tabs, collapsible editor).
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra) : "")); } };
const E = require(path.join(ROOT, "src/core/animengine.js"));
const inLimits = (clip) => clip.keys.every((k) => Object.entries(k.poses).every(([j, p]) => [0, 1, 2].every((a) => p.rot[a] >= E.LIMITS[j][["x", "y", "z"][a]][0] - 1e-6 && p.rot[a] <= E.LIMITS[j][["x", "y", "z"][a]][1] + 1e-6)));

// ── 1. the complaint: custom prompts used to collapse into the same idle ──
const custom = ["drink a potion", "play guitar", "open a heavy door", "headbang to metal", "swing on a rope", "type on a laptop", "answer the phone", "take a selfie", "knock on the door", "think hard", "big yawn and stretch", "shiver in the cold", "cry sadly", "stomp angrily", "push a crate", "pull a rope", "dig a hole", "chop wood", "row a boat", "ride a bike", "look around nervously", "flex muscles", "sneeze", "jumping jacks", "squats", "meditate", "drive a car", "go fishing", "sweep the floor", "paint a picture", "hug", "handshake", "high five", "thumbs up", "curtsy", "out of breath", "dizzy", "cower in fear", "hands up surrender", "kick a ball", "golf swing", "basketball jump shot", "lift a heavy box", "superhero landing", "dab", "floss dance", "twirl around", "lean on a wall", "check the watch", "pet the dog"];
const clips = custom.map((p) => E.generate(p));
ok("engine VERSION is 2.6.0", E.VERSION === "2.6.0", E.VERSION);
ok("50 custom prompts → 50 clips, none of them the idle fallback", clips.every((c) => c.intent.category !== "idle" && c.intent.category !== "improv"), clips.filter((c) => c.intent.category === "idle" || c.intent.category === "improv").map((c) => c.prompt));
ok("every clip has its own fingerprint", new Set(clips.map((c) => c.fingerprint)).size === clips.length);
let maxSim = 0, pair = null; for (let i = 0; i < clips.length; i++) for (let j = i + 1; j < clips.length; j++) { const s = E.similarity(clips[i], clips[j]); if (s > maxSim) { maxSim = s; pair = [custom[i], custom[j]]; } }
ok("no two custom clips move alike (max pairwise pose similarity < 0.99)", maxSim < 0.99, [maxSim, pair]);
ok("all of them validate without errors, inside joint limits, keys on the frame grid", clips.every((c) => c.report.errors === 0 && inLimits(c) && c.keys.every((k) => Math.abs(k.t * c.fps - Math.round(k.t * c.fps)) < 0.05)), clips.filter((c) => c.report.errors || !inLimits(c)).map((c) => [c.prompt, c.report.issues.filter((i) => i.level === "error").map((i) => i.msg)]));
const endDiff = (c) => { const a = c.keys[0].poses, b = c.keys[c.keys.length - 1].poses; return Math.max(...E.JOINTS.filter((j) => c.loop || j !== "neck").map((j) => Math.max(...[0, 1, 2].map((x) => Math.abs((a[j] ? a[j].rot[x] : 0) - (b[j] ? b[j].rot[x] : 0)))))); };
ok("looping acts close their loop exactly; one-shots return to the stance (head follow-through may lag on the last key)", clips.every((c) => endDiff(c) < (c.loop ? 0.5 : 8)), clips.filter((c) => endDiff(c) >= (c.loop ? 0.5 : 8)).map((c) => [c.prompt, c.loop, endDiff(c)]));

// ── 2. act lexicon integrity ──
const actNames = Object.keys(E.ACTS);
ok("act lexicon has 70+ motions, each with a regex, a duration and beats", actNames.length >= 70 && actNames.every((a) => E.ACTS[a].rx instanceof RegExp && E.ACTS[a].d > 0 && (typeof E.ACTS[a].b === "function" || E.ACTS[a].b.length >= 1)), actNames.length);
const perAct = actNames.map((a) => { const c = E.generate(a === "tiptoe_reach" ? "reach up for the top shelf" : a === "bowhead" ? "bow their head" : a === "wavearms" ? "wave both arms" : a === "lookaround" ? "look around" : a === "herolanding" ? "superhero landing" : a === "heropose" ? "superhero pose" : a === "highfive" ? "high five" : a === "fistbump" ? "fist bump" : a === "thumbsup" ? "thumbs up" : a === "blowkiss" ? "blow a kiss" : a === "jacks" ? "jumping jacks" : a === "situp" ? "sit ups" : a === "bat" ? "golf swing" : a === "soccer" ? "kick a ball" : a === "door" ? "open the door" : a === "hang" ? "monkey bars" : a === "chop" ? "chop wood" : a === "typing" ? "typing on a keyboard" : a === "pant" ? "out of breath" : a === "wall" ? "lean against a wall" : a === "watch" ? "check the time" : a === "pray" ? "hands together" : a === "shade" ? "shade their eyes" : a === "wipe" ? "wipe the sweat" : a === "tiptoe" ? a : a === "boxing" ? "boxing stance" : a === "lift" ? "lift a heavy box" : a === "carry" ? "carry a box" : a === "pet" ? "pet the dog" : a === "scratch" ? "scratch head" : a === "push" ? "push a crate" : a === "pull" ? "pull a rope" : a === "row" ? "row a boat" : a === "bike" ? "ride a bike" : a); return [a, c]; });
ok("every act is reachable from a plain phrase and generates as itself (or layered on a cycle)", perAct.every(([a, c]) => (c.intent.acts || []).includes(a) || (c.intent.upperText && E.findActs(c.intent.upperText).some((x) => x.name === a))), perAct.filter(([a, c]) => !(c.intent.acts || []).includes(a) && !(c.intent.upperText && E.findActs(c.intent.upperText).some((x) => x.name === a))).map(([a, c]) => [a, c.intent.category]));
const neutral = E.generate("idle").keys[0].poses;
ok("every act clip is error-free, inside limits and actually poses (> 15° from the neutral stance on some joint)", perAct.every(([, c]) => c.report.errors === 0 && inLimits(c) && c.keys.some((k) => E.JOINTS.some((j) => [0, 1, 2].some((x) => Math.abs(k.poses[j].rot[x] - neutral[j].rot[x]) > 15)))), perAct.filter(([, c]) => c.report.errors || !inLimits(c)).map(([a, c]) => [a, c.report.issues.filter((i) => i.level === "error").map((i) => i.msg).slice(0, 2)]));
ok("exclusive acts beat the old keyword classes (rope swing is not a sword, kick a ball is not a kick combo, fishing cast is not a spell, jumping jacks is not a jump)", E.generate("swing on a rope").intent.category === "act" && E.generate("kick a ball").intent.acts[0] === "soccer" && E.generate("cast a fishing line").intent.acts[0] === "fishing" && E.generate("five jumping jacks").intent.acts[0] === "jacks");
ok("the classics are untouched (idle / walk / sword combo / wave / jump keep their categories)", E.generate("calm looping idle").intent.category === "idle" && E.generate("natural walk cycle").intent.category === "walk" && E.generate("3 hit sword combo").intent.category === "attack" && E.generate("friendly wave emote").intent.category === "emote" && E.generate("jump with anticipation").intent.category === "jump");

// ── 3. repeats, chains, layering, gestures, moods, improvisation ──
const knock = E.generate("knock on the door 5 times"), sq = E.generate("do 3 squats"), sq1 = E.generate("squats");
ok("'N times' repeats an oscillating act N times; '3 squats' tiles the cycle 3× as a finite clip", knock.intent.repeat === 5 && knock.keys.filter((k) => k.tag === "impact").length === 5 && sq.intent.repeat === 3 && !sq.loop && Math.abs(sq.duration - sq1.duration * 3) < 0.2, [knock.keys.filter((k) => k.tag === "impact").length, sq.duration, sq1.duration]);
const seq = E.generate("salute then bow then sit down");
ok("'A then B then C' chains three clips with blends, stage names prefixed per part", seq.intent.category === "sequence" && seq.parts.length === 3 && seq.parts.map((p) => p.category).join(",") === "emote,emote,sit" && seq.stages.some((s) => /^1\./.test(s.name)) && seq.stages.some((s) => /^3\./.test(s.name)) && seq.joins.length === 2 && seq.joins.every((j) => j.gap >= 0.25 && j.gap <= 0.9) && Math.abs(seq.duration - (seq.parts.reduce((a, p) => a + p.duration, 0) + seq.joins.reduce((a, j) => a + j.gap, 0))) < 0.05 && seq.report.errors === 0, [seq.parts, seq.joins, seq.duration]); // 1.58: joins are pose-distance based (≥ 0.25 s), no longer a fixed 0.25 s
ok("a chained clip keeps its keys ascending and every part's first key reachable from the previous part's last", seq.keys.every((k, i) => i === 0 || k.t > seq.keys[i - 1].t) && E.sampleAt(seq, seq.parts[0].duration + 0.125) !== null);
const ww = E.generate("wave while walking"), dr = E.generate("drink coffee while running");
ok("'X while walking' = legs + root from the cycle, upper body from the act / emote", ww.layered && ww.layered.base === "WalkLoop" && /Wave/.test(ww.layered.upper) && ww.loop && dr.layered && /Run/.test(dr.layered.base) && /Drink/.test(dr.layered.upper), [ww.layered, dr.layered]);
ok("layered clips keep the walk in the legs and the wave in the arm", (() => { const walk = E.generate("walk cycle"); const t = ww.duration * 0.25; const a = E.sampleAt(ww, t), b = E.sampleAt(walk, t); return Math.abs(a.l_hip.rot[0] - b.l_hip.rot[0]) < 25 && Math.max(...ww.keys.map((k) => Math.max(k.poses.r_shoulder.rot[0], k.poses.r_elbow.rot[0]))) > 100 && Math.max(...walk.keys.map((k) => Math.max(k.poses.r_shoulder.rot[0], k.poses.r_elbow.rot[0]))) < 60; })());
const g1 = E.generate("raise the left arm"), g2 = E.generate("shake your head"), g3 = E.generate("lean back and look up");
ok("pose grammar: 'raise the left arm' lifts the LEFT shoulder (mirrored), 'shake your head' oscillates the neck, 'lean back and look up' arches waist + neck", g1.intent.category === "gesture" && Math.max(...g1.keys.map((k) => k.poses.l_shoulder.rot[0])) > 120 && Math.max(...g1.keys.map((k) => k.poses.r_shoulder.rot[0])) < 60 && g2.intent.category === "gesture" && g2.intent.gesture.oscillate && g2.keys.filter((k) => Math.abs(k.poses.neck.rot[1]) > 25).length >= 3 && g3.intent.category === "gesture" && g3.keys.some((k) => k.poses.waist.rot[0] > 10 && k.poses.neck.rot[0] < -20), [g1.intent.category, g2.intent.category, g3.intent.category]);
const tiredWalk = E.generate("tired old man walk"), proud = E.generate("proud idle"), drunkW = E.generate("drunk walk");
ok("moods overlay any category: tired/old walk hunches and slows, proud idle lifts the chest, drunk walk sways", tiredWalk.intent.mood && tiredWalk.keys.every((k) => k.poses.neck.rot[0] > 8) && tiredWalk.duration > E.generate("walk").duration && proud.intent.mood === "proud" && proud.keys.every((k) => k.poses.waist.rot[0] > 4) && drunkW.intent.mood === "drunk" && Math.max(...drunkW.keys.map((k) => Math.abs(k.poses.root.rot[2]))) > 5, [tiredWalk.intent.mood, tiredWalk.duration, proud.intent.mood, drunkW.intent.mood]);
ok("mood overlays keep loops seamless and clips valid", [tiredWalk, proud, drunkW].every((c) => c.report.errors === 0 && Math.abs(c.keys[0].poses.root.rot[2] - c.keys[c.keys.length - 1].poses.root.rot[2]) < 0.5));
const imp = E.generate("asdf qwerty zxcv"), imp2 = E.generate("blorp florp");
ok("nonsense is improvised from the seed (3 acts), differs per prompt and SAYS SO in limitations", imp.intent.category === "improv" && imp.intent.improv.length === 3 && imp.fingerprint !== imp2.fingerprint && /no known motion in "asdf qwerty zxcv" - improvised/.test(imp.limitations[0]) && imp.stages.length === 3, [imp.intent.improv, imp.limitations]);
ok("a plain 'idle' is still an idle, not an improvisation", E.generate("idle").intent.category === "idle" && E.generate("tired idle").intent.category === "idle" && E.generate("tired idle").intent.mood === "tired");
ok("determinism: the same prompt gives the same clip; a different prompt wording gives a different persona", JSON.stringify(E.generate("drink a potion").keys) === JSON.stringify(E.generate("drink a potion").keys) && E.generate("drink a potion").fingerprint !== E.generate("drink the potion slowly").fingerprint);

// ── 4. feedback understands moods and "then …" ──
let fb = E.applyFeedback(E.generate("drink a potion"), "make it drunk");
ok("feedback 'make it drunk' adds the mood and reports it", fb.intent.mood === "drunk" && fb.feedback[0].applied.includes("mood: drunk"));
fb = E.applyFeedback(fb, "then wave");
ok("feedback 'then wave' appends a motion (sequence of 2, mood kept, name updated)", fb.intent.category === "sequence" && fb.parts.length === 2 && /Wave/.test(fb.parts[1].name) && fb.intent.mood === "drunk" && /then_Wave/.test(fb.name), [fb.name, fb.parts.map((p) => p.name), fb.intent.mood]);
const faster = E.applyFeedback(fb, "faster");
ok("'faster' on a sequence shortens it (clauses regenerate with the speed param)", faster.intent.category === "sequence" && faster.duration < fb.duration - 0.3, [fb.duration, faster.duration]);
const nm = E.applyFeedback(faster, "no mood");
ok("'no mood' removes the overlay; '5 seconds' pins the duration", nm.intent.mood === null && Math.abs(E.applyFeedback(nm, "5 seconds").duration - 5) < 1e-6);
const seqTake = E.applyFeedback(seq, "new take");
ok("'new take' on a chain changes every part", seqTake.take === 1 && seqTake.fingerprint !== seq.fingerprint);

// ── 5. export of the new categories ──
const build = E.toBuildArgs(seq, E.defaultRigInfo("R15")), xml = E.toRbxmx(ww, E.defaultRigInfo("R15"));
ok("sequence and layered clips export like any other (markers per part, R15 Pose tree)", build.keys.length === E.exportKeys(seq).length && build.keys.some((k) => k.m.length) && /class="KeyframeSequence"/.test(xml) && (xml.match(/class="Keyframe"/g) || []).length === E.exportKeys(ww).length);
ok("R6 mapping works for acts (elbows folded)", E.toStudio(E.generate("drink a potion", { rigType: "R6" }), E.defaultRigInfo("R6")).keyframes.every((k) => k.poses.length === 6 && k.poses.every((p) => p.cf.length === 12)));

// ── 6. catalogue text ──
const animlib = read("src/core/animlib.js");
ok("animlib tells the model any prompt works (1.55) without moving the FIRST CHOICE line", /1\.55: ANY prompt works/.test(animlib) && /FIRST CHOICE \(1\.52 engine\): animation_generate \{prompt\}/.test(animlib) && /any motion \(1\.55\): 'drink a potion'/.test(animlib));

console.log(`test-anim-freeform: ${n} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
