// 1.52.0 — Animation engine acceptance tests A–G (src/core/animengine.js) + the main.js dispatcher
// (animation_generate / refine / sequence / validate / export_rbxmx / build) run against a scripted Studio.
// Run: node tests/test-anim-engine.js      (the Luau side is covered by tests/anim-sim.py with lupa)
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const E = require(path.join(R, "src/core/animengine.js"));
const RSAnim = vm.runInNewContext(read("src/core/animlib.js") + "\nRSAnim", { console });
let n = 0; const ok = (name, cond, detail) => { n++; if (!cond) { console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 500) : "")); process.exit(1); } };
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

// ── A. R15 looping idle: generate → validate → (preview = sampleAt) → export ──
const idle = E.generate("looping idle with calm breathing and subtle weight shift", { quality: "high", rigType: "R15" });
ok("A: idle is a looping R15 clip with a sensible duration", idle.loop === true && idle.rigType === "R15" && idle.duration >= 2 && idle.duration <= 6 && idle.keys.length >= 6, [idle.loop, idle.duration, idle.keys.length]);
ok("A: validation is clean (no errors) with a score", idle.report.ok && idle.report.errors === 0 && idle.report.score >= 80, idle.report);
ok("A: keys are time-ordered, start at 0 and end at the duration", idle.keys[0].t === 0 && near(idle.keys[idle.keys.length - 1].t, idle.duration) && idle.keys.every((k, i) => i === 0 || k.t > idle.keys[i - 1].t));
const first = E.sampleAt(idle, 0), last = E.sampleAt(idle, idle.duration);
const seam = Math.max(...E.JOINTS.map((j) => Math.max(...[0, 1, 2].map((a) => Math.abs((first[j] ? first[j].rot[a] : 0) - (last[j] ? last[j].rot[a] : 0))))));
ok("A: loop seam closes (first pose == last pose)", seam < 0.5, seam);
const mid = E.sampleAt(idle, idle.duration / 4);
ok("A: the idle actually moves (breathing changes the chest / shoulders / root sway between keys)", ["waist", "neck", "l_shoulder", "root"].every((j) => mid[j] && first[j] && [0, 1, 2].some((a) => Math.abs(mid[j].rot[a] - first[j].rot[a]) > 0.5)));
ok("A: every pose rotation respects the per-joint limits", idle.keys.every((k) => Object.entries(k.poses).every(([j, p]) => [0, 1, 2].every((a) => p.rot[a] >= E.LIMITS[j][["x", "y", "z"][a]][0] - 1e-6 && p.rot[a] <= E.LIMITS[j][["x", "y", "z"][a]][1] + 1e-6))));
const fk = E.forwardKinematics(E.sampleAt(idle, 0.3), "R15");
ok("A: forward kinematics yields a full skeleton (feet below hips, head above torso)", fk.l_ankle_tip[1] < fk.l_hip[1] && fk.neck_tip[1] > fk.waist[1] && Object.keys(fk).length >= 20);
const idleXml = E.toRbxmx(idle, E.defaultRigInfo("R15"));
ok("A: .rbxmx export is a looping KeyframeSequence with one Keyframe per key and Pose nodes for the R15 bones", idleXml.includes('class="KeyframeSequence"') && /<bool name="Loop">true<\/bool>/.test(idleXml) && (idleXml.match(/class="Keyframe"/g) || []).length === idle.keys.length && idleXml.includes(">LowerTorso<") && idleXml.includes(">RightHand<") && !idleXml.includes("NaN"));
const idleBuild = E.toBuildArgs(idle, E.defaultRigInfo("R15"), { overwrite: true });
ok("A: Studio build payload carries the same keys, loop flag, R15 bone list and overwrite", idleBuild.keys.length === idle.keys.length && idleBuild.loop === true && idleBuild.bones.includes("UpperTorso") && idleBuild.overwrite === true && idleBuild.rigType === "R15" && idleBuild.name === idle.name);

// ── B. multi-stage sword combo ──
const combo = E.generate("extremely fluid anime sword combo: anticipation, three rapid strikes, a spinning finisher and a dramatic landing", { quality: "cinematic" });
ok("B: an attack clip is one-shot, Action priority and has 6+ named stages", combo.loop === false && combo.priority === "Action" && combo.stages.length >= 6, combo.stages.map((s) => s.name));
ok("B: stages are contiguous from 0 to the duration", combo.stages[0].t0 === 0 && near(combo.stages[combo.stages.length - 1].t1, combo.duration, 1e-3) && combo.stages.every((s, i) => i === 0 || near(s.t0, combo.stages[i - 1].t1, 1e-3)));
ok("B: anticipation precedes the first strike, the finisher spins, the landing dips the root", combo.stages.findIndex((s) => /antic/i.test(s.name)) < combo.stages.findIndex((s) => /strike|slash|hit/i.test(s.name)) && combo.keys.some((k) => k.poses.root && Math.abs(k.poses.root.rot[1]) >= 90) && combo.keys.some((k) => k.stage && /land/i.test(k.stage) && k.poses.root && k.poses.root.pos && k.poses.root.pos[1] < -0.2), combo.stages.map((s) => s.name));
ok("B: impact keys carry markers / tags for gameplay", combo.keys.some((k) => /hit|impact|contact/i.test(k.tag || "")));
ok("B: cinematic quality densifies keys (breakdowns) and uses 60 fps", combo.fps === 60 && combo.keys.length >= 24, [combo.fps, combo.keys.length]);
ok("B: validation clean on the combo", combo.report.ok, combo.report.issues.filter((i) => i.level === "error"));
const seq = E.generateSequence("8 stage sword combo with a spinning finisher and a landing", { quality: "high" });
ok("B: generateSequence returns a combined clip plus one clip per stage group with transitions", seq.combined && seq.clips.length >= 4 && seq.transitions.length === seq.clips.length && seq.clips.every((c) => c.keys[0].t === 0 && c.report.ok), seq.clips.map((c) => [c.name, c.duration]));
ok("B: per-stage clips sum to the combined duration", near(seq.clips.reduce((a, c) => a + c.duration, 0), seq.combined.duration, 0.05), [seq.clips.reduce((a, c) => a + c.duration, 0), seq.combined.duration]);
ok("B: consecutive stage clips are pose-continuous (last pose of one ≈ first pose of the next)", seq.clips.every((c, i) => { if (!i) return true; const a = E.sampleAt(seq.clips[i - 1], seq.clips[i - 1].duration), b = E.sampleAt(c, 0); return E.JOINTS.every((j) => !a[j] || !b[j] || [0, 1, 2].every((ax) => Math.abs(a[j].rot[ax] - b[j].rot[ax]) < 1)); }));

// ── C. R6 vs R15 mapping ──
const wave = E.generate("friendly wave emote", { quality: "balanced" });
const r15 = E.toBuildArgs(wave, E.defaultRigInfo("R15"), {}), r6 = E.toBuildArgs(wave, E.defaultRigInfo("R6"), {});
ok("C: R15 payload uses R15 bone names, R6 payload uses R6 names", r15.bones.includes("RightUpperArm") && !r15.bones.includes("Right Arm") && r6.bones.includes("Right Arm") && !r6.bones.includes("RightUpperArm"), [r15.bones, r6.bones]);
ok("C: R6 folds elbow/wrist into the single arm bone (fewer bones, no dropped keys)", r6.bones.length <= 6 && r15.bones.length >= 12 && r6.keys.length === r15.keys.length);
ok("C: the same semantic clip yields different per-bone numbers on R6 (elbow folded into the arm, engine-side C0 conjugation happens in toStudio/toRbxmx)", (() => { const i15 = r15.bones.indexOf("RightUpperArm"), i6 = r6.bones.indexOf("Right Arm"); const k = Math.floor(wave.keys.length / 2); return i15 >= 0 && i6 >= 0 && r15.keys[k].p[i15].join() !== r6.keys[k].p[i6].join(); })(), [r15.keys[Math.floor(wave.keys.length / 2)].p[r15.bones.indexOf("RightUpperArm")], r6.keys[Math.floor(wave.keys.length / 2)].p[r6.bones.indexOf("Right Arm")]]);
const st15 = E.toStudio(wave, E.defaultRigInfo("R15")), st6 = E.toStudio(wave, E.defaultRigInfo("R6"));
ok("C: toStudio emits 12-component joint-local CFrames per real bone for both rig types", st15.keyframes.length === wave.keys.length && st6.keyframes.length === wave.keys.length && st15.keyframes[0].poses.some((p) => p.bone === "RightUpperArm" && p.cf.length === 12) && st6.keyframes[0].poses.some((p) => p.bone === "Right Arm" && p.cf.length === 12) && st6.bones.length === 6 && st15.bones.length === 15, [st15.bones, st6.bones]);
ok("C: rig type detection from real bone lists", E.detectRigType({ bones: [{ name: "Torso" }, { name: "Right Arm" }, { name: "Head" }] }) === "R6" && E.detectRigType({ bones: [{ name: "UpperTorso" }, { name: "LowerTorso" }, { name: "RightUpperArm" }] }) === "R15" && E.detectRigType({ bones: [{ name: "Spine1" }, { name: "Jaw" }] }) === "Custom");
const bm = E.boneMap(E.defaultRigInfo("R6"));
ok("C: boneMap maps semantic joints to R6 bones (r_shoulder → Right Arm, r_hip → Right Leg)", bm.map.r_shoulder === "Right Arm" && bm.map.r_hip === "Right Leg" && bm.map.neck === "Head");
const r6Xml = E.toRbxmx(wave, E.defaultRigInfo("R6"));
ok("C: R6 export names R6 parts and still roots at HumanoidRootPart", r6Xml.includes(">Right Arm<") && r6Xml.includes(">Torso<") && r6Xml.includes("HumanoidRootPart") && !r6Xml.includes("UpperTorso"));

// ── D. feedback refinement ──
const fb = E.applyFeedback(combo, "make the attacks faster, more anticipation, heavier landing");
const appliedD = fb.feedback[fb.feedback.length - 1].applied;
ok("D: all three asks were recognised and applied", appliedD.length >= 3 && /faster/i.test(appliedD.join(" ")) && /anticipation/i.test(appliedD.join(" ")) && /land/i.test(appliedD.join(" ")), appliedD);
ok("D: faster → shorter duration; validation still clean", fb.duration < combo.duration && fb.report.ok, [combo.duration, fb.duration, fb.report.errors]);
const landBefore = Math.min(...combo.keys.filter((k) => k.poses.root && k.poses.root.pos).map((k) => k.poses.root.pos[1]));
const landAfter = Math.min(...fb.keys.filter((k) => k.poses.root && k.poses.root.pos).map((k) => k.poses.root.pos[1]));
ok("D: heavier landing → deeper root dip", landAfter < landBefore - 0.05, [landBefore, landAfter]);
const cmp = E.compare(combo, fb);
ok("D: compare() reports before/after numbers for the model", cmp.durationBefore === combo.duration && cmp.durationAfter === fb.duration && cmp.largestChange && typeof cmp.largestChange.degrees === "number");
ok("D: generic feedback is rejected honestly (nothing silently applied)", E.applyFeedback(idle, "make it pop").feedback.slice(-1)[0].applied.length === 0 || /pop|exagg/i.test(E.applyFeedback(idle, "make it pop").feedback.slice(-1)[0].applied.join(" ")));

// ── E. loop discontinuity → detected → fixed ──
const broken = JSON.parse(JSON.stringify(idle));
broken.keys[broken.keys.length - 1].poses.l_shoulder = { rot: [60, 0, -30] };
const brokenReport = E.validate(broken);
ok("E: a loop seam mismatch is detected as an error", !brokenReport.ok && brokenReport.issues.some((i) => /loop|seam/i.test(i.msg) && i.level === "error"), brokenReport.issues);
const fixed = E.refine(broken);
ok("E: refine() closes the seam and records the fix", fixed.changed && fixed.clip.report.ok && fixed.clip.fixes.some((f) => /loop|seam/i.test(f)), [fixed.changed, fixed.clip.fixes]);
const abrupt = JSON.parse(JSON.stringify(idle)); abrupt.loop = false; abrupt.keys[2].poses.r_shoulder = { rot: [170, 0, 0] }; abrupt.keys[3].poses.r_shoulder = { rot: [-170, 0, 0] };
const abruptR = E.validate(abrupt);
ok("E: a 340° jump between adjacent keys is flagged as a discontinuity", abruptR.issues.some((i) => i.kind === "discontinuity" && /turns \d+° in/.test(i.msg)), abruptR.issues);

// ── F. export integrity ──
const items = (idleXml.match(/<Item /g) || []).length, closes = (idleXml.match(/<\/Item>/g) || []).length;
ok("F: rbxmx XML is balanced (every <Item> is closed)", items === closes && items > idle.keys.length);
const cfs = idleXml.match(/<CoordinateFrame name="CFrame">[\s\S]*?<\/CoordinateFrame>/g) || [];
ok("F: every Pose CFrame has 12 finite components", cfs.length > 0 && cfs.every((c) => (c.match(/<(X|Y|Z|R\d\d)>-?\d/g) || []).length === 12 && !/NaN|Infinity/.test(c)), cfs.length);
ok("F: Poses nest HumanoidRootPart → LowerTorso → UpperTorso → … per Roblox's KeyframeSequence format", idleXml.indexOf(">HumanoidRootPart<") < idleXml.indexOf(">LowerTorso<") && idleXml.indexOf(">LowerTorso<") < idleXml.indexOf(">UpperTorso<") && idleXml.indexOf(">UpperTorso<") < idleXml.indexOf(">Head<"));
ok("F: easing is written as enum tokens and keyframe times are ascending", /<token name="EasingStyle">\d<\/token>/.test(idleXml) && /<token name="EasingDirection">\d<\/token>/.test(idleXml) && (() => { const ts = [...idleXml.matchAll(/<float name="Time">([\d.e-]+)<\/float>/g)].map((m) => +m[1]); return ts.length === idle.keys.length && ts.every((t, i) => i === 0 || t > ts[i - 1]); })());
const round = E.parseProject(E.serializeProject(combo));
ok("F: project JSON round-trips losslessly (keys, stages, feedback, report)", JSON.stringify(round.keys) === JSON.stringify(combo.keys) && JSON.stringify(round.stages) === JSON.stringify(combo.stages) && round.name === combo.name && round.report && round.report.score === combo.report.score);
let threw = false; try { E.parseProject("{\"nope\":1}"); } catch { threw = true; }
ok("F: parseProject rejects a non-project file", threw);

// ── G. failure handling in the engine ──
const nan = JSON.parse(JSON.stringify(wave)); nan.keys[1].poses.r_shoulder = { rot: [NaN, 0, 0] };
ok("G: NaN rotations are a validation error (never exported silently)", !E.validate(nan).ok && E.validate(nan).issues.some((i) => /nan|finite|invalid/i.test(i.msg)));
const empty = JSON.parse(JSON.stringify(wave)); empty.keys = [];
ok("G: a clip without keys is invalid", !E.validate(empty).ok);
let unsupported = null; try { unsupported = E.toBuildArgs(wave, { rigType: "Custom", bones: [{ name: "Spine1", parent: "Root" }, { name: "Jaw", parent: "Spine1" }] }, {}); } catch (e) { unsupported = e; }
ok("G: an unsupported rig (no matching bones) throws or yields zero bones with everything dropped — never a fake build payload", unsupported instanceof Error || (unsupported && unsupported.bones.length === 0 && unsupported.dropped.length >= 10), unsupported instanceof Error ? unsupported.message : unsupported && [unsupported.bones, unsupported.dropped.length]);
let badPrompt = null; try { badPrompt = E.generate("", {}); } catch (e) { badPrompt = e; }
ok("G: an empty prompt is rejected", badPrompt instanceof Error);

// ── main.js dispatcher against a scripted Studio ───────────────────────────
const main = read("src/core/main.js");
const start = main.indexOf("  // ── 1.52.0 ANIMATION ENGINE (src/core/animengine.js)"), end = main.indexOf("  async function runTool(call) {");
ok("dispatcher block found in main.js", start > 0 && end > start);
const block = main.slice(start, end);
function makeCtx(studio) {
  const log = [];
  const ctx = {
    ORAnimEngine: E, RSAnim, A: { stop: false }, console,
    ORAnimStudio: { loaded: [], loadClip(c, meta) { this.loaded.push([c.name, meta]); } },
    document: { createElement: () => ({ click() { log.push("download"); }, set href(v) {}, set download(v) { log.push("file:" + v); } }) },
    URL: { createObjectURL: () => { if (studio.downloadFails) throw new Error("blob blocked"); return "blob:x"; }, revokeObjectURL() {} },
    Blob: function (parts) { this.size = String(parts[0]).length; },
    setTimeout: () => 0,
    runSkillLuau: async (built, budget) => {
      const body = built.body || built.code;
      const op = (body.match(/local OP = "([a-z_]+)"/) || body.match(/"op"\s*:\s*"([a-z_]+)"/) || [, "?"])[1];
      log.push("luau:" + op + ":" + budget);
      if (studio.offline) return "ERROR calling 'execute_luau': STUDIO_BRIDGE_OFFLINE: or-core is not running";
      if (op === "rig_info") return "Output of 'execute_luau':\n" + JSON.stringify({ ok: true, data: studio.rig, text: "rig" });
      if (op === "build") { studio.builds.push(body.length); if (studio.buildFails) return "Output of 'execute_luau':\n" + JSON.stringify({ ok: false, error: studio.buildFails }); return "Output of 'execute_luau':\n" + JSON.stringify({ ok: true, data: { name: "x", keyframes: 9 }, text: "9 keyframes, 15 bones" }); }
      return "Output of 'execute_luau':\n" + JSON.stringify({ ok: true, text: "ok" });
    },
    log,
  };
  vm.createContext(ctx);
  vm.runInContext(block + "\nglobalThis.__run = runAnimEngine; globalThis.__A = A;", ctx);
  return ctx;
}
const R15RIG = { rigType: "R15", path: "Workspace.Rig", name: "Rig", root: "HumanoidRootPart", bones: ["LowerTorso", "UpperTorso", "Head", "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightUpperArm", "RightLowerArm", "RightHand", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "RightUpperLeg", "RightLowerLeg", "RightFoot"].map((b) => ({ name: b, parent: "x", kind: "Motor6D" })), animations: [] };
ok("the generated Luau for rig_info / build is detectable by the scripted Studio", /local OP = "rig_info"|"op"\s*:\s*"rig_info"/.test(RSAnim.buildLuau("rig_info", {}).body || RSAnim.buildLuau("rig_info", {}).code));
(async () => {
  // A (dispatcher): generate online → rig_info + build, report, overlay fed
  let c = makeCtx({ rig: R15RIG, builds: [] });
  let out = await c.__run("generate", { prompt: "looping idle with calm breathing", quality: "balanced" });
  ok("dispatcher A: generate = exactly one rig_info trip + one build trip", c.log.filter((l) => l.startsWith("luau:rig_info")).length === 1 && c.log.filter((l) => l.startsWith("luau:build")).length === 1, c.log);
  ok("dispatcher A: report says BUILT, names next steps, never claims an asset id", /BUILT in Studio/.test(out) && /animation_preview/.test(out) && /animation_refine/.test(out) && !/asset ?id\s*[:=]\s*\d/i.test(out), out.slice(0, 400));
  ok("dispatcher A: the overlay receives the clip flagged as built with the rig info", c.ORAnimStudio.loaded.length === 1 && c.ORAnimStudio.loaded[0][1].built === true && c.ORAnimStudio.loaded[0][1].rigInfo.rigType === "R15");
  ok("dispatcher A: the clip is remembered as the last one", c.__A.animLast && c.__A.animClips[c.__A.animLast]);
  // validate / export on the remembered clip
  out = await c.__run("validate", {});
  ok("dispatcher: validate reports issues + a verdict without a Studio trip", /issues \(\d+\)/.test(out) && /Verdict/.test(out) && c.log.filter((l) => l.startsWith("luau:")).length === 2, out);
  out = await c.__run("export_rbxmx", {});
  ok("dispatcher F: export_rbxmx downloads <name>.rbxmx and explains there is no asset id", /Saved .*\.rbxmx/.test(out) && c.log.includes("download") && /no asset id/.test(out), out);
  // D: refine → rebuild
  out = await c.__run("refine", { feedback: "faster attacks, more anticipation, heavier landing" });
  ok("dispatcher D: refine applies feedback, shows before → after and REBUILDS", /Applied:/.test(out) && /Before → after/.test(out) && /REBUILT in Studio/.test(out) && c.log.filter((l) => l.startsWith("luau:build")).length === 2, out);
  // C: R6 rig in Studio while the model asked for R15
  const R6RIG = { rigType: "R6", path: "Workspace.Dummy", name: "Dummy", root: "HumanoidRootPart", bones: ["Torso", "Head", "Left Arm", "Right Arm", "Left Leg", "Right Leg"].map((b) => ({ name: b, parent: "x", kind: "Motor6D" })), animations: [] };
  c = makeCtx({ rig: R6RIG, builds: [] });
  out = await c.__run("generate", { prompt: "wave emote", rig: "R15" });
  ok("dispatcher C: the real rig wins (R6) and the mismatch is explained", /is R6 - built for R6/.test(out) && c.__A.animClips[c.__A.animLast].rigType === "R6", out);
  // B: sequence builds combined + stage clips
  c = makeCtx({ rig: R15RIG, builds: [] });
  out = await c.__run("sequence", { prompt: "8 stage sword combo with a spinning finisher and a landing", quality: "high" });
  ok("dispatcher B: sequence builds the combined clip and every stage clip, lists transitions and controller guidance", /Per-stage clips \(\d+\)/.test(out) && /Transitions:/.test(out) && /BUILT in Studio: (\d+)\/\1 clips/.test(out) && /GetMarkerReachedSignal/.test(out), out.slice(0, 600));
  // G: provider/Studio unavailable → generated, validated, NOT built, honest
  c = makeCtx({ rig: R15RIG, builds: [], offline: true });
  out = await c.__run("generate", { prompt: "heavy two-handed slam" });
  ok("dispatcher G: offline → clip generated + validated, explicitly NOT built, overlay still gets it", /NOT built/.test(out) && /STUDIO_BRIDGE_OFFLINE/.test(out) && !/BUILT in Studio/.test(out) && c.ORAnimStudio.loaded.length === 1 && !c.ORAnimStudio.loaded[0][1].built, out);
  out = await c.__run("export_rbxmx", {});
  ok("dispatcher G: export still works offline (file path)", /Saved .*\.rbxmx/.test(out), out);
  // G: Studio refuses the build (wrong rig) → ERROR, clip kept for the overlay
  c = makeCtx({ rig: R15RIG, builds: [], buildFails: "only 3 of the clip's 15 bones exist on rig 'Rig' (wrong rig type?)" });
  out = await c.__run("generate", { prompt: "run cycle" });
  ok("dispatcher G: a refused build is an ERROR naming the Studio reason, not a success", /^ERROR calling 'animation_generate'/.test(out) && /wrong rig type/.test(out) && c.ORAnimStudio.loaded.length === 1 && !c.ORAnimStudio.loaded[0][1].built, out);
  // G: invalid transforms never reach Studio
  c = makeCtx({ rig: R15RIG, builds: [] });
  const bad = JSON.parse(JSON.stringify(wave)); bad.keys[1].poses.r_shoulder = { rot: [NaN, 0, 0] };
  out = await c.__run("build", { clip: bad });
  ok("dispatcher G: a clip with invalid transforms is refused before any Studio trip", /^ERROR calling 'animation_build'/.test(out) && c.log.filter((l) => l.startsWith("luau:")).length === 0, out);
  out = await c.__run("export_rbxmx", { name: "nope" });
  ok("dispatcher G: export of an unknown clip is an ERROR that points at animation_generate", /^ERROR calling 'animation_export_rbxmx'/.test(out) && /animation_generate/.test(out), out);
  // G: export failure (browser refuses the download)
  c = makeCtx({ rig: R15RIG, builds: [], downloadFails: true });
  await c.__run("generate", { prompt: "jump" });
  out = await c.__run("export_rbxmx", {});
  ok("dispatcher G: a refused download is reported as an ERROR", /^ERROR calling 'animation_export_rbxmx'/.test(out) && /blob blocked/.test(out), out);
  // G: cancel mid-sequence
  c = makeCtx({ rig: R15RIG, builds: [] });
  const origRun = c.runSkillLuau; let trips = 0; c.runSkillLuau = async (b, t) => { trips++; if (trips === 3) c.__A.stop = true; return origRun(b, t); };
  vm.runInContext("runSkillLuau = globalThis.runSkillLuau;", c);
  out = await c.__run("sequence", { prompt: "sword combo with a spin and a landing" });
  ok("dispatcher G: user cancel (A.stop) stops the remaining builds and the report says CANCELLED", /CANCELLED - not built/.test(out) && /cancelled by the user/.test(out), out.slice(-400));
  // missing prompt / feedback
  c = makeCtx({ rig: R15RIG, builds: [] });
  ok("dispatcher G: missing prompt / feedback are argument errors", /^ERROR calling 'animation_generate': 'prompt' is required/.test(await c.__run("generate", {})) && /^ERROR calling 'animation_refine': 'feedback' is required/.test(await c.__run("refine", {})));
  // registration in the catalogue
  const names = RSAnim.ANIM_COMMANDS.map((x) => x.name);
  ok("catalogue advertises the five engine commands first (animation_build stays internal)", names.slice(0, 5).join(",") === "animation_generate,animation_refine,animation_sequence,animation_validate,animation_export_rbxmx" && !names.includes("animation_build") && RSAnim.ANIM_OPS.includes("generate"));
  ok("describeCommands teaches the engine-first flow", /FIRST CHOICE \(1\.52 engine\): animation_generate \{prompt\}/.test(RSAnim.describeCommands()));
  const config = read("src/core/config.js");
  ok("Creation prompt teaches animation_generate first and the honest asset-id rule", config.includes("ANIMATION: animation_generate {prompt, quality?, duration?, loop?} authors, validates and BUILDS a whole clip from words") && config.includes("Asset ids only from publish results.") && config.includes("2. BLOCK THE KEYS: animation_generate {prompt, quality} first"));
  console.log(`test-anim-engine: ${n} checks passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL (exception)", e && e.stack || e); process.exit(1); });
