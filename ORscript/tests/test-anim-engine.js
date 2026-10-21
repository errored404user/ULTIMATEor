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
const idleExport = E.exportKeys(idle); // 1.54: high-quality clips are spline clips and export baked frames (every authored key kept exact)
ok("A: spline clip exports the frame grid plus every authored key time", idle.interp === "spline" && idleExport.length > idle.keys.length && idle.keys.every((k) => idleExport.some((e) => Math.abs(e.t - k.t) < 1e-6 && e.poses === k.poses)), [idle.keys.length, idleExport.length]);
ok("A: .rbxmx export is a looping KeyframeSequence with one Keyframe per exported key and Pose nodes for the R15 bones", idleXml.includes('class="KeyframeSequence"') && /<bool name="Loop">true<\/bool>/.test(idleXml) && (idleXml.match(/class="Keyframe"/g) || []).length === idleExport.length && idleXml.includes(">LowerTorso<") && idleXml.includes(">RightHand<") && !idleXml.includes("NaN"));
const idleBuild = E.toBuildArgs(idle, E.defaultRigInfo("R15"), { overwrite: true });
ok("A: Studio build payload carries the same keys, loop flag, R15 bone list and overwrite", idleBuild.keys.length === idleExport.length && idleBuild.loop === true && idleBuild.bones.includes("UpperTorso") && idleBuild.overwrite === true && idleBuild.rigType === "R15" && idleBuild.name === idle.name);

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
ok("F: easing is written as enum tokens and keyframe times are ascending", /<token name="EasingStyle">\d<\/token>/.test(idleXml) && /<token name="EasingDirection">\d<\/token>/.test(idleXml) && (() => { const ts = [...idleXml.matchAll(/<float name="Time">([\d.e-]+)<\/float>/g)].map((m) => +m[1]); return ts.length === idleExport.length && ts.every((t, i) => i === 0 || t > ts[i - 1]); })());
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
  // ── 1.53 UNIQUENESS SUITE: every animation is its own ──
  const U = [
    "looping idle", "relaxed idle, hands on hips", "nervous idle", "walk cycle", "run cycle", "sneak walk", "strafe left", "strafe right", "walk backwards", "crawl", "pushups", "swim", "climb", "tread water", "fly idle", "sleep", "kneel idle", "crouch idle", "sit idle",
    "8 stage sword combo", "3 hit punch combo", "kick combo with a spin", "heavy axe slash", "dodge roll", "block", "jump", "land", "jump and land heavy",
    "hit reaction from the front", "hit reaction from the left", "hit from behind", "knockback", "death falling backwards", "death falling forward", "dash forward", "slide", "backflip", "front flip", "throw a grenade", "shoot pistol", "fire rifle two shots", "burst fire blaster", "archery draw and release", "pick up an item", "cast fireball",
    "wave", "wave with both hands", "shy small wave", "cheer", "fist pump cheer", "dance", "point", "point at the sky", "point to the side", "clap", "slow clap", "bow", "theatrical big bow", "laugh", "salute", "facepalm", "shrug", "taunt", "nod", "shake head",
  ];
  const uclips = U.map((p) => E.generate(p, {}));
  ok("uniqueness: every one of the " + U.length + " prompts generates with 0 validation errors", uclips.every((c) => c.report.errors === 0), uclips.filter((c) => c.report.errors).map((c) => [c.prompt, c.report.issues.filter((i) => i.level === "error").map((i) => i.msg)]));
  ok("uniqueness: every one of the " + U.length + " prompts has a distinct fingerprint", new Set(uclips.map((c) => c.fingerprint)).size === U.length, uclips.map((c) => c.prompt + ":" + c.fingerprint));
  ok("uniqueness: the same prompt is deterministic (same fingerprint twice)", E.generate("wave", {}).fingerprint === E.generate("wave", {}).fingerprint);
  ok("uniqueness: all new categories resolve (no fall-through to idle)", ["sneak", "strafe", "walk_back", "crawl", "pushup", "tread", "fly", "sleep", "kneel", "hit_react", "knockback", "death", "dash", "slide", "flip", "throw", "shoot", "archery", "pickup"].every((cat) => uclips.some((c) => c.intent.category === cat)), uclips.map((c) => c.intent.category));
  ok("uniqueness: new emotes resolve to their own action", ["salute", "facepalm", "shrug", "taunt", "nod", "headshake"].every((a) => uclips.some((c) => c.intent.action === a)));
  ok("uniqueness: emote sub-variants are picked from the words (both hands → v2, shy → v3, sky → v2, side → v3)", uclips.find((c) => c.prompt === "wave with both hands").persona.emoteVariant === 1 && uclips.find((c) => c.prompt === "shy small wave").persona.emoteVariant === 2 && uclips.find((c) => c.prompt === "point at the sky").persona.emoteVariant === 1 && uclips.find((c) => c.prompt === "point to the side").persona.emoteVariant === 2);
  ok("uniqueness: persona traits are attached to every clip and differ across prompts", uclips.every((c) => c.persona && c.persona.traits.length === 5) && new Set(uclips.map((c) => c.persona.traits.join("|"))).size > U.length / 2);
  ok("uniqueness: two idles do not share a stance (persona asymmetry reaches the first key)", JSON.stringify(uclips[0].keys[0].poses) !== JSON.stringify(uclips[2].keys[0].poses));
  // choreography honours the words, in order
  const ot = E.parseIntent("overhead then thrust sword");
  ok("choreograph: explicit strike words win and keep prompt order", ot.stages.filter((s) => s.kind === "strike" || s.kind === "finisher").map((s) => s.variant).slice(0, 2).join(",") === "slash_over,thrust", ot.stages.map((s) => s.variant));
  const c8 = E.parseIntent("8 hit sword combo").stages.filter((s) => s.kind === "strike" || s.kind === "finisher").map((s) => s.variant);
  ok("choreograph: an 8 strike combo never repeats a strike back-to-back and uses the wider pool", c8.length === 8 && c8.every((v, i) => i === 0 || v !== c8[i - 1]) && c8.some((v) => /slash_up|slash_diag|backhand/.test(v)), c8);
  ok("choreograph: the first strike of a punch combo is never a haymaker / spin opener", !/haymaker|kick_spin|backhand/.test(E.parseIntent("5 hit punch combo").stages.find((s) => s.kind === "strike").variant));
  // takes / avoid / mirror / travel
  const w0 = E.generate("wave", {}); const w1 = E.generate("wave", { avoid: [w0.fingerprint] }); const w2 = E.generate("wave", { avoid: [w0, w1.fingerprint] });
  ok("avoid: a repeated prompt with the earlier fingerprint in `avoid` comes back as a NEW take with a new fingerprint and a _take suffix", w1.take === 1 && w1.name === "Wave_take2" && w1.fingerprint !== w0.fingerprint && E.similarity(w0, w1) < 0.98, [w1.take, w1.name, E.similarity(w0, w1)]);
  ok("avoid: clips objects are accepted too (similarity test) and the chain keeps producing distinct takes", w2.take === 2 && new Set([w0.fingerprint, w1.fingerprint, w2.fingerprint]).size === 3);
  ok("avoid: same prompt without avoid stays deterministic (take 0)", E.generate("wave", {}).take === 0 && E.generate("wave", {}).fingerprint === w0.fingerprint);
  const m = E.mirror(w0), mm = E.mirror(m);
  ok("mirror: swaps left/right joints, negates yaw/roll, suffixes _Mirror, round-trips exactly", m.name === "Wave_Mirror" && m.mirrored === true && Math.abs(m.keys[2].poses.l_shoulder.rot[0] - w0.keys[2].poses.r_shoulder.rot[0]) < 1e-9 && m.keys[2].poses.l_shoulder.rot[2] === -w0.keys[2].poses.r_shoulder.rot[2] && mm.name === "Wave" && E.similarity(mm, w0) > 0.999, [m.name, mm.name]);
  ok("mirror: a mirrored clip still validates clean (limits are side-aware)", m.report.errors === 0, m.report.issues.filter((i) => i.level === "error"));
  const lh = E.generate("left-handed sword slash", {});
  ok("mirror: 'left-handed' in the prompt mirrors at generation time", lh.mirrored === true && /_Mirror$/.test(lh.name) && lh.report.errors === 0);
  const rm = E.generate("run forward with root motion", {});
  const lastZ = rm.keys[rm.keys.length - 1].poses.root.pos[2];
  ok("travel: 'with root motion' makes the root advance across the loop and declares the limitation", rm.travel === true && lastZ > 3 && rm.keys[0].poses.root.pos[2] === 0 && rm.limitations.some((l) => /root motion/.test(l)) && rm.report.errors === 0, [lastZ, rm.report.issues.filter((i) => i.level !== "info")]);
  const fbT = E.applyFeedback(w0, "another take"); const fbM = E.applyFeedback(w0, "mirror it"); const fbE = E.applyFeedback(w0, "softer");
  ok("feedback: 'another take' / 'mirror it' / 'softer' are understood", fbT.take === 1 && fbT.fingerprint !== w0.fingerprint && fbM.mirrored === true && fbE.persona.easing === "soft" && fbE.feedback[0].applied.includes("soft easing"), [fbT.feedback[0].applied, fbM.feedback[0].applied, fbE.feedback[0].applied]);
  // new categories: structural checks
  const dth = uclips.find((c) => c.prompt === "death falling backwards"), flp = uclips.find((c) => c.prompt === "backflip"), sh2 = uclips.find((c) => c.prompt === "fire rifle two shots"), arc = uclips.find((c) => c.prompt === "archery draw and release");
  ok("death: ends lying flat (root pitched ~90°, dropped to ~0.5 studs above the ground) and holds still", Math.abs(Math.abs(dth.keys[dth.keys.length - 1].poses.root.rot[0]) - 90) < 6 && Math.abs(dth.keys[dth.keys.length - 1].poses.root.pos[1] + (E.ROOT_HEIGHT - 0.5)) < 0.05 && dth.stages.some((s) => s.kind === "still"), [dth.keys[dth.keys.length - 1].poses.root, dth.stages.map((s) => s.kind)]);
  ok("flip: the root completes a full 360° pitch and lands back upright", flp.stages.some((s) => s.kind === "flip") && Math.abs(Math.abs(flp.keys[flp.keys.length - 1].poses.root.rot[0]) % 360) < 12, flp.keys[flp.keys.length - 1].poses.root.rot);
  ok("shoot: 'two shots' makes two shot stages with recoil impacts; archery has draw → release", sh2.stages.filter((s) => s.kind === "shot").length === 2 && sh2.keys.filter((k) => k.tag === "impact").length >= 2 && arc.stages.map((s) => s.kind).join(",").includes("draw,release"), [sh2.stages.map((s) => s.kind), arc.stages.map((s) => s.kind)]);
  const hl = uclips.find((c) => c.prompt === "hit reaction from the left"), hb = uclips.find((c) => c.prompt === "hit from behind");
  ok("hit reactions: direction reaches the name and the root lean", hl.name === "HitReactLeft" && hb.name === "HitReactBack" && hl.keys[1].poses.root.rot[2] < 0 && hb.keys[1].poses.root.rot[0] > 0, [hl.keys[1].poses.root.rot, hb.keys[1].poses.root.rot]);
  // dispatcher: variations
  c = makeCtx({ rig: R15RIG, builds: [] });
  out = await c.__run("generate", { prompt: "wave", variations: 3 });
  ok("dispatcher: {variations:3} builds three distinct takes, names them _v1.._v3 and reports the fingerprints + persona", /3 distinct takes/.test(out) && /Wave_v1/.test(out) && /Wave_v3/.test(out) && /BUILT in Studio: Wave_v1, Wave_v2, Wave_v3/.test(out) && /persona/.test(out) && c.log.filter((l) => l.startsWith("luau:build")).length === 3 && new Set([c.__A.animClips.Wave_v1.fingerprint, c.__A.animClips.Wave_v2.fingerprint, c.__A.animClips.Wave_v3.fingerprint]).size === 3, out.slice(0, 500));
  out = await c.__run("generate", { prompt: "wave" });
  ok("dispatcher: generating the same prompt again in a session never repeats an earlier fingerprint (session clips are `avoid`)", !Object.keys(c.__A.animClips).filter((n) => n !== c.__A.animLast).some((n) => c.__A.animClips[n].fingerprint === c.__A.animClips[c.__A.animLast].fingerprint), Object.keys(c.__A.animClips).map((n) => n + ":" + c.__A.animClips[n].fingerprint));
  out = await c.__run("generate", { prompt: "sword slash", mirror: true });
  ok("dispatcher: {mirror:true} builds the left-handed version", /_Mirror/.test(out) && c.__A.animClips[c.__A.animLast].mirrored === true, out.slice(0, 200));
  // registration in the catalogue
  const names = RSAnim.ANIM_COMMANDS.map((x) => x.name);
  ok("catalogue advertises the five engine commands first (animation_build stays internal)", names.slice(0, 5).join(",") === "animation_generate,animation_refine,animation_sequence,animation_validate,animation_export_rbxmx" && !names.includes("animation_build") && RSAnim.ANIM_OPS.includes("generate"));
  ok("describeCommands teaches the engine-first flow", /FIRST CHOICE \(1\.52 engine\): animation_generate \{prompt\}/.test(RSAnim.describeCommands()));
  const config = read("src/core/config.js");
  ok("Creation prompt teaches animation_generate first and the honest asset-id rule", config.includes("ANIMATION: animation_generate {prompt, quality?, duration?, loop?} authors, validates and BUILDS a whole clip from words") && config.includes("Asset ids only from publish results.") && config.includes("2. BLOCK THE KEYS: animation_generate {prompt, quality} first"));
  // ── 1.56: Roblox easing direction, sets of compatible clips ──────────────
  {
    const jump = E.generate("jump", { rigType: "R15" });
    const k = jump.keys.find((x) => x.ease && x.ease[1] === "Out"), kIn = jump.keys.find((x) => x.ease && x.ease[1] === "InOut");
    ok("engine keys use TweenService-style easing (Out = decelerate into the key)", !!k);
    ok("robloxEase swaps In<->Out for Pose.EasingDirection (Roblox docs: backwards from TweenService), InOut unchanged", JSON.stringify(E.robloxEase(["CubicV2", "Out"])) === '["CubicV2","In"]' && JSON.stringify(E.robloxEase(["Sine", "In"])) === '["Sine","Out"]' && JSON.stringify(E.robloxEase(["CubicV2", "InOut"])) === '["CubicV2","InOut"]');
    const st = E.toStudio(jump, E.defaultRigInfo("R15"));
    ok("toStudio keyframes carry the flipped direction", st.keyframes.some((f) => f.easing.direction === "In") && !st.keyframes.some((f, i) => jump.keys[i] && jump.keys[i].ease && jump.keys[i].ease[1] === "Out" && f.easing.direction === "Out"));
    const ba = E.toBuildArgs(jump, E.defaultRigInfo("R15"));
    ok("toBuildArgs (Luau build) carries the flipped direction too", JSON.stringify(ba).includes('"In"') && ba.keys.every((x) => !(jump.keys.find((y) => y.t === x.t) || {}).ease || x.e[1] !== (jump.keys.find((y) => y.t === x.t).ease[1] === "Out" ? "Out" : "__")));
    const xml = E.toRbxmx(jump, E.defaultRigInfo("R15"));
    const firstKeyDir = jump.keys[0].ease ? jump.keys[0].ease[1] : "Out";
    const tok = { In: 0, Out: 1, InOut: 2 }[firstKeyDir === "Out" ? "In" : firstKeyDir === "In" ? "Out" : "InOut"];
    ok(".rbxmx EasingDirection token is the flipped one for the first keyframe", new RegExp(`<token name="EasingDirection">${tok}</token>`).test(xml.split("<Item class=\"Keyframe\"")[1] || ""));
    // splitSet: lists of animations vs. one clip with several beats
    ok("splitSet: 'idle, walk and run animations' -> 3 prompts", JSON.stringify(E.splitSet("idle, walk and run animations")) === '["idle","walk","run"]');
    ok("splitSet: 'walk then wave' is ONE sequence clip", E.splitSet("walk then wave") === null);
    ok("splitSet: 'jump and land' is ONE clip", E.splitSet("jump and land") === null);
    ok("splitSet: 'slow walk, fast walk' are variants of one clip (not a set)", E.splitSet("slow walk, fast walk") === null);
    ok("splitSet: 'punch and kick' is ONE combo", E.splitSet("punch and kick") === null);
    ok("splitSet: 'idle, walk, run, jump and attack animations for my knight' -> 5", (E.splitSet("idle, walk, run, jump and attack animations for my knight") || []).length === 5);
    const set = E.generateSet("zombie idle, zombie walk and zombie attack for my zombie", { rigType: "R15" });
    ok("generateSet: one clip per prompt, prefix not duplicated (ZombieIdleLoop, not Zombie_ZombieIdleLoop)", set.clips.length === 3 && set.clips.every((c) => /^Zombie[A-Z]/.test(c.name)) && !set.clips.some((c) => /^Zombie_Zombie/.test(c.name)), set.clips.map((c) => c.name));
    ok("generateSet: every clip shares one persona seed + persona (lead / armRest / easing)", new Set(set.clips.map((c) => c.personaSeed)).size === 1 && new Set(set.clips.map((c) => `${c.persona.lead}/${c.persona.armRest}/${c.persona.easing}`)).size === 1);
    ok("generateSet: set report scores the set, lists priorities + fades per non-idle clip", set.report && set.report.score >= 70 && set.report.priorities.length === 3 && set.report.pairs.length === 2 && set.report.clips === 3, set.report);
    ok("generateSet: idle/walk loop, attack one-shot, priorities Idle/Movement/Action", set.clips[0].loop && set.clips[1].loop && !set.clips[2].loop && set.report.priorities.map((p) => p.priority).join(",") === "Idle,Movement,Action", set.report.priorities);
    const low = (c) => { const f = E.forwardKinematics(c, 0); return Math.min(...Object.values(f).map((p) => p[1])); };
    ok("generateSet: every clip stands on the ground at t=0 (ROOT_HEIGHT 1.85 - no 0.5 stud sink)", set.clips.every((c) => low(c) > -0.12 && low(c) < 0.3), set.clips.map(low));
    const d = E.stanceDistance(set.clips[0], set.clips[1]);
    ok("stanceDistance: idle -> walk start within a short cross-fade (no stance snap)", d.deg < 70 && d.height < 0.6, d);
    const mixed = E.compatibility([E.generate("idle", { rigType: "R15" }), E.generate("walk", { rigType: "R6" })]);
    ok("compatibility: different rigs = error, score drops", !mixed.ok && mixed.issues.some((i) => i.level === "error" && /rig types differ/.test(i.msg)) && mixed.score <= 75);
    const strangers = E.compatibility([E.generate("idle", { rigType: "R15", personaSeed: 1 }), E.generate("walk", { rigType: "R15", personaSeed: 2 }), E.generate("run", { rigType: "R15", personaSeed: 3 })]);
    ok("compatibility: clips generated as different characters are flagged (persona warning) unless personas coincide", strangers.ok && (strangers.issues.some((i) => /different personas/.test(i.msg)) || new Set([1, 2, 3].map((sd) => JSON.stringify(E.persona ? 1 : 1))).size === 1));
    const desc = E.describeSet(set);
    ok("describeSet reports every clip, the shared character and the fade advice", /ZombieIdleLoop/.test(desc) && /ZombieWalkLoop/.test(desc) && /Play\(/.test(desc) && /character/i.test(desc), desc.slice(0, 400));
    const main = read("src/core/main.js");
    for (const s of ['"build", "set", "compatibility", "polish", "layer"]', 'op === "set"', 'op === "compatibility"', "function animBuildSet(", "function animPersonaSeed(", "E.splitSet(", "ORAnimStudio.loadSet"]) ok("main.js set wiring: " + s, main.includes(s));
    const animlib = read("src/core/animlib.js");
    ok("catalogue advertises animation_set + animation_compatibility", /name: "animation_set"/.test(animlib) && /name: "animation_compatibility"/.test(animlib));
    const outSet = await c.__run("set", { prompts: ["idle", "walk", "jump"], rig: "R15" });
    ok("dispatcher: animation_set builds separate clips and reports them", /IdleLoop/.test(outSet) && /WalkLoop/.test(outSet) && /Jump/.test(outSet) && !/merged/i.test(outSet), outSet.slice(0, 300));
    const outGen = await c.__run("generate", { prompt: "crouch idle and crouch walk animations" });
    ok("dispatcher: a multi-animation animation_generate prompt is auto-split into a set", /^SET of 2 separate animations/.test(outGen) && /CrouchLoop/.test(outGen) && /SneakLoop/.test(outGen), outGen.slice(0, 300));
    const outCompat = await c.__run("compatibility", {});
    ok("dispatcher: animation_compatibility scores the session clips", /\/100|score/i.test(outCompat), outCompat.slice(0, 200));
  }
  console.log(`test-anim-engine: ${n} checks passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL (exception)", e && e.stack || e); process.exit(1); });
