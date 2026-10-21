// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/animengine.js - ORscript ANIMATION ENGINE (1.52.0)
//
// Natural language → structured, validated Roblox animation data.
//
//   intent  = ORAnimEngine.parseIntent("extremely fluid anime sword combo with
//             anticipation, rapid strikes, a spinning finisher and a dramatic landing")
//   clip    = ORAnimEngine.generate(intent, { rigType: "R15", quality: "high" })
//   report  = ORAnimEngine.validate(clip)            // objective checks
//   clip2   = ORAnimEngine.applyFeedback(clip, "make the attacks faster, heavier landing")
//   studio  = ORAnimEngine.toStudio(clip, rigInfo)   // keyframes with per-bone CFrames
//   xml     = ORAnimEngine.toRbxmx(clip, rigInfo)    // KeyframeSequence .rbxmx
//
// EVERYTHING here is deterministic and pure (no DOM, no Studio): the same
// prompt + options always yields the same clip, which is what makes refinement,
// variation and tests reproducible. Poses are authored in ONE semantic frame
// (the torso frame Roblox uses for R15 Motor6Ds: +X right, +Y up, +Z back) on
// 15 semantic joints; rig adapters convert them to real bone names and real
// joint-local CFrames by conjugating with each Motor6D's C0 rotation - so R6's
// rotated shoulder/hip frames, R15's identity frames and any custom Motor6D rig
// reported by Studio all receive correct transforms.
//
// Motion principles are applied explicitly, not by chance: anticipation keys,
// impact holds, follow-through overshoot on secondary joints, arc breakdowns,
// weight (root drop + knee bend on landings), secondary head/torso lag, and
// loop closure. Validation measures joint limits, discontinuities, timing,
// loop seams and data integrity; refinement fixes what it can and reports the
// rest. Nothing is faked: unsupported requests return explicit limitations.
(function (root) {
  "use strict";
  const VERSION = "1.52.0";
  const DEG = Math.PI / 180;

  // ───────────────────────── rotation math ─────────────────────────
  const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
  const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
  function mul(A, B) { const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]; return R; }
  const transpose = (A) => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
  const mulV = (A, v) => [A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2], A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2], A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2]];
  // Roblox CFrame.fromEulerAnglesYXZ(x, y, z) == Ry * Rx * Rz
  const eulerYXZ = (x, y, z) => mul(mul(rotY(y * DEG), rotX(x * DEG)), rotZ(z * DEG));
  function toEulerYXZ(R) { // degrees, matches CFrame:ToEulerAnglesYXZ
    const rx = Math.asin(Math.max(-1, Math.min(1, -R[1][2])));
    const ry = Math.atan2(R[0][2], R[2][2]);
    const rz = Math.atan2(R[1][0], R[1][1]);
    return [rx / DEG, ry / DEG, rz / DEG];
  }
  const flat = (R) => [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
  const from9 = (a) => [[a[0], a[1], a[2]], [a[3], a[4], a[5]], [a[6], a[7], a[8]]];
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ───────────────────────── semantic rig ─────────────────────────
  const JOINTS = ["root", "waist", "neck", "l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist", "l_hip", "l_knee", "l_ankle", "r_hip", "r_knee", "r_ankle"];
  const PARENT = { root: null, waist: "root", neck: "waist", l_shoulder: "waist", l_elbow: "l_shoulder", l_wrist: "l_elbow", r_shoulder: "waist", r_elbow: "r_shoulder", r_wrist: "r_elbow", l_hip: "root", l_knee: "l_hip", l_ankle: "l_knee", r_hip: "root", r_knee: "r_hip", r_ankle: "r_knee" };
  // Pivot offsets (studs, semantic frame) from the parent pivot - R15 proportions; used by the schematic preview + QA metrics.
  const PIVOT = { root: [0, 0, 0], waist: [0, 0.2, 0], neck: [0, 1.2, 0], l_shoulder: [-1.0, 1.0, 0], l_elbow: [0, -0.6, 0], l_wrist: [0, -0.6, 0], r_shoulder: [1.0, 1.0, 0], r_elbow: [0, -0.6, 0], r_wrist: [0, -0.6, 0], l_hip: [-0.5, -0.2, 0], l_knee: [0, -0.75, 0], l_ankle: [0, -0.75, 0], r_hip: [0.5, -0.2, 0], r_knee: [0, -0.75, 0], r_ankle: [0, -0.75, 0] };
  const TIP = { neck: [0, 0.7, 0], l_wrist: [0, -0.35, 0], r_wrist: [0, -0.35, 0], l_ankle: [0, -0.15, -0.45], r_ankle: [0, -0.15, -0.45] };
  const ROOT_HEIGHT = 2.35; // root pivot above the ground, studs (R15 default HipHeight 2 + lower torso)
  // Joint limits (degrees, semantic frame). x: flex (+ = forward swing for limbs, + = lean back for torso), y: twist, z: roll/abduction.
  const LIMITS = {
    root: { x: [-60, 60], y: [-1800, 1800], z: [-45, 45] }, waist: { x: [-50, 50], y: [-70, 70], z: [-35, 35] }, neck: { x: [-50, 50], y: [-85, 85], z: [-35, 35] },
    l_shoulder: { x: [-190, 190], y: [-90, 90], z: [-190, 40] }, r_shoulder: { x: [-190, 190], y: [-90, 90], z: [-40, 190] },
    l_elbow: { x: [-5, 155], y: [-90, 90], z: [-20, 20] }, r_elbow: { x: [-5, 155], y: [-90, 90], z: [-20, 20] },
    l_wrist: { x: [-70, 70], y: [-90, 90], z: [-45, 45] }, r_wrist: { x: [-70, 70], y: [-90, 90], z: [-45, 45] },
    l_hip: { x: [-60, 130], y: [-50, 50], z: [-60, 25] }, r_hip: { x: [-60, 130], y: [-50, 50], z: [-25, 60] },
    l_knee: { x: [-155, 5], y: [-10, 10], z: [-10, 10] }, r_knee: { x: [-155, 5], y: [-10, 10], z: [-10, 10] },
    l_ankle: { x: [-45, 45], y: [-30, 30], z: [-30, 30] }, r_ankle: { x: [-45, 45], y: [-30, 30], z: [-30, 30] },
  };
  const SECONDARY = ["neck", "l_wrist", "r_wrist", "l_elbow", "r_elbow"]; // follow-through carriers

  // Bone names (Pose names = Part1 names) and default Motor6D C0 rotations per rig.
  const R15_BONES = { root: "LowerTorso", waist: "UpperTorso", neck: "Head", l_shoulder: "LeftUpperArm", l_elbow: "LeftLowerArm", l_wrist: "LeftHand", r_shoulder: "RightUpperArm", r_elbow: "RightLowerArm", r_wrist: "RightHand", l_hip: "LeftUpperLeg", l_knee: "LeftLowerLeg", l_ankle: "LeftFoot", r_hip: "RightUpperLeg", r_knee: "RightLowerLeg", r_ankle: "RightFoot" };
  const R15_PARENT_BONE = { LowerTorso: "HumanoidRootPart", UpperTorso: "LowerTorso", Head: "UpperTorso", LeftUpperArm: "UpperTorso", LeftLowerArm: "LeftUpperArm", LeftHand: "LeftLowerArm", RightUpperArm: "UpperTorso", RightLowerArm: "RightUpperArm", RightHand: "RightLowerArm", LeftUpperLeg: "LowerTorso", LeftLowerLeg: "LeftUpperLeg", LeftFoot: "LeftLowerLeg", RightUpperLeg: "LowerTorso", RightLowerLeg: "RightUpperLeg", RightFoot: "RightLowerLeg" };
  const R6_BONES = { root: "Torso", neck: "Head", l_shoulder: "Left Arm", r_shoulder: "Right Arm", l_hip: "Left Leg", r_hip: "Right Leg" };
  const R6_PARENT_BONE = { Torso: "HumanoidRootPart", Head: "Torso", "Left Arm": "Torso", "Right Arm": "Torso", "Left Leg": "Torso", "Right Leg": "Torso" };
  // Real R6 Motor6D C0 rotation matrices (row-major) - the classic rig rotates its limb joint frames.
  const R6_C0 = {
    Torso: [-1, 0, 0, 0, 0, 1, 0, 1, 0], Head: [-1, 0, 0, 0, 0, 1, 0, 1, 0],
    "Right Arm": [0, 0, 1, 0, 1, 0, -1, 0, 0], "Right Leg": [0, 0, 1, 0, 1, 0, -1, 0, 0],
    "Left Arm": [0, 0, -1, 0, 1, 0, 1, 0, 0], "Left Leg": [0, 0, -1, 0, 1, 0, 1, 0, 0],
  };
  const PRIORITY_TOKEN = { Idle: 0, Movement: 1, Action: 2, Action2: 3, Action3: 4, Action4: 5, Core: 1000 };
  const EASING_TOKEN = { Linear: 0, Constant: 1, Elastic: 2, Cubic: 3, Bounce: 4, CubicV2: 5 };
  const DIRECTION_TOKEN = { In: 0, Out: 1, InOut: 2 };

  // rigInfo = { rigType: "R15"|"R6"|"Custom", bones: [{name, parent, c0?:[9]}], path? }
  function defaultRigInfo(rigType) {
    const t = String(rigType || "R15").toUpperCase() === "R6" ? "R6" : "R15";
    const map = t === "R6" ? R6_PARENT_BONE : R15_PARENT_BONE;
    return { rigType: t, path: null, bones: Object.keys(map).map((name) => ({ name, parent: map[name], c0: t === "R6" ? R6_C0[name] : [1, 0, 0, 0, 1, 0, 0, 0, 1] })) };
  }
  function detectRigType(rigInfo) {
    if (!rigInfo) return "R15";
    if (rigInfo.rigType === "R6" || rigInfo.rigType === "R15") return rigInfo.rigType;
    const names = new Set((rigInfo.bones || []).map((b) => b.name));
    if (names.has("UpperTorso") && names.has("LowerTorso")) return "R15";
    if (names.has("Torso") && names.has("Right Arm")) return "R6";
    return "Custom";
  }
  // Semantic joint → bone name for a given rig (null = not on this rig).
  function boneMap(rigInfo) {
    const type = detectRigType(rigInfo);
    const names = new Set((rigInfo && rigInfo.bones || []).map((b) => b.name));
    const out = {};
    const pick = (table) => { for (const j of JOINTS) { const n = table[j]; out[j] = n && (names.size === 0 || names.has(n)) ? n : null; } };
    if (type === "R6") pick(R6_BONES); else pick(R15_BONES);
    if (type === "Custom") { // best effort: case-insensitive name matching on R15 names
      const lower = {}; for (const n of names) lower[n.toLowerCase()] = n;
      for (const j of JOINTS) if (!out[j]) { const want = (R15_BONES[j] || "").toLowerCase(); out[j] = lower[want] || null; }
    }
    return { type, map: out };
  }

  // ───────────────────────── intent parsing ─────────────────────────
  const WORD = (re) => new RegExp("\\b(?:" + re + ")\\b", "i");
  const RE = {
    idle: WORD("idle|breath(?:e|ing)|stand(?:ing)?|rest(?:ing)? pose|stance only"), walk: WORD("walk(?:ing|s)?|stroll|march(?:ing)?|strut"), run: WORD("run(?:ning|s)?|sprint(?:ing)?|jog(?:ging)?|dash(?:ing)?"),
    jump: WORD("jump(?:ing|s)?|leap(?:ing)?|hop(?:ping)?"), fall: WORD("fall(?:ing)?|freefall"), land: WORD("land(?:ing)?|touchdown"), climb: WORD("climb(?:ing)?|ladder"), swim: WORD("swim(?:ming)?"),
    crouch: WORD("crouch(?:ing)?|sneak(?:ing)?|stealth"), sit: WORD("sit(?:ting)?|seated"), wave: WORD("wave|waving|greet(?:ing)?|hello"), cheer: WORD("cheer(?:ing)?|celebrat(?:e|ion)|victory"), dance: WORD("danc(?:e|ing)"), point: WORD("point(?:ing)?"), clap: WORD("clap(?:ping)?|applau(?:d|se)"), laugh: WORD("laugh(?:ing)?"), bow: WORD("bow(?:ing)?"),
    sword: WORD("sword|katana|blade|slash(?:es|ing)?|saber|sabre|greatsword|axe|scythe|spear|staff|swing(?:s|ing)?"), slam: WORD("slam|smash|pound|ground ?pound|stomp|crush"), attack: WORD("attack(?:s|ing)?|strike(?:s)?|hit(?:s)?|melee|fight(?:ing)?"), punch: WORD("punch(?:es|ing)?|jab|hook|uppercut|fist|boxing|haymaker"), kick: WORD("kick(?:s|ing)?|roundhouse"), thrust: WORD("thrust|stab|lunge|pierce"), spin: WORD("spin(?:ning)?|whirl(?:ing|wind)?|pirouette|tornado|360"),
    finisher: WORD("finisher|finishing (?:strike|blow|move)|final (?:strike|blow)|ultimate"), dodge: WORD("dodge|roll(?:ing)?|evade|sidestep"), block: WORD("block(?:ing)?|guard|parry|parrying|deflect"), cast: WORD("cast(?:ing)?|spell|magic|fireball|summon|charge up|energy|beam|ki blast|kamehameha"), transform: WORD("transform(?:ation)?|power ?up|awaken(?:ing)?|super saiyan|rage mode"),
    combo: WORD("combo|combination|chain|sequence|string"), anticipation: WORD("anticipation|wind ?up|charge|ready|telegraph"), recover: WORD("recover(?:y)?|settle"),
    anime: WORD("anime|shonen|exaggerated|flashy|stylized|stylised|dramatic"), realistic: WORD("realistic|grounded|natural|mocap|lifelike|subtle"), cartoony: WORD("cartoon(?:y|ish)?|bouncy|goofy|silly|squash"), heavy: WORD("heavy|massive|giant|boss|brute|slow and powerful|weighty"), fluid: WORD("fluid|smooth|flowing|graceful|elegant"), robotic: WORD("robot(?:ic)?|mechanical|stiff|rigid"), zombie: WORD("zombie|undead|shambl(?:e|ing)|monster|creature|beast|hunched"), cute: WORD("cute|pet|puppy|kitten|chibi|tiny"), ninja: WORD("ninja|assassin|agile|acrobatic"),
    fast: WORD("fast(?:er)?|rapid(?:ly)?|quick(?:ly)?|snappy|explosive|lightning|blazing"), slow: WORD("slow(?:ly|er)?|gentle|calm|lazy|relaxed|tired"), extreme: WORD("extremely|insanely|super|ultra|incredibly|very"),
    loop: WORD("loop(?:ing|ed|s)?|cycle|seamless|repeat(?:ing)?"), noloop: WORD("one[- ]shot|once|no loop|non[- ]looping"),
    upper: WORD("upper[- ]body(?: only)?|arms only|torso only"), facial: WORD("facial|face|expression|smile|frown|blink|lip[- ]?sync|eyebrow"),
    r6: WORD("r6"), r15: WORD("r15"), left: WORD("left[- ]handed|lefty"), twohand: WORD("two[- ]hand(?:ed)?|greatsword|both hands"),
    qFast: WORD("fast preset|draft|rough|quick preview|low quality"), qHigh: WORD("high[- ]quality|polished|detailed|refined"), qCine: WORD("cinematic|film|cutscene|trailer"),
  };
  const NUMWORD = { one: 1, two: 2, double: 2, twice: 2, three: 3, triple: 3, four: 4, quad: 4, five: 5, six: 6, seven: 7, eight: 8 };
  function countOf(text, noun) {
    const m = text.match(new RegExp("\\b(\\d+|one|two|three|four|five|six|seven|eight|double|triple|quad)[- ](?:hit|strike|slash|punch|kick|part|stage|step)?\\s*(?:" + noun + ")", "i"));
    if (!m) return null; const v = m[1].toLowerCase(); return NUMWORD[v] || parseInt(v, 10) || null;
  }
  function parseIntent(text) {
    const t = String(text || "").trim();
    const has = (k) => RE[k].test(t);
    const intent = { text: t, category: "idle", action: null, style: "default", intensity: 1, speed: 1, loop: null, duration: null, stages: [], weapon: null, hands: 2, rigHint: null, quality: null, upperOnly: has("upper"), unsupported: [], seed: hashStr(t) };
    if (has("facial")) intent.unsupported.push("facial expressions (FaceControls) - this engine animates Motor6D joints; the face is left untouched");
    if (has("r6")) intent.rigHint = "R6"; if (has("r15")) intent.rigHint = "R15";
    intent.quality = has("qCine") ? "cinematic" : has("qHigh") ? "high" : has("qFast") ? "fast" : null;
    // style
    const styles = ["anime", "realistic", "cartoony", "heavy", "fluid", "robotic", "zombie", "cute", "ninja"];
    intent.styles = styles.filter((s) => has(s));
    intent.style = intent.styles[0] || "default";
    if (has("extreme")) intent.intensity += 0.3;
    if (has("fast")) { intent.speed *= 1.25; intent.intensity += 0.15; }
    if (has("slow")) { intent.speed *= 0.75; }
    if (intent.style === "heavy") intent.speed *= 0.85;
    if (intent.style === "anime") intent.intensity += 0.2;
    if (intent.style === "realistic") intent.intensity -= 0.2;
    intent.intensity = clamp(intent.intensity, 0.5, 1.6);
    const dm = t.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/i); if (dm) intent.duration = clamp(parseFloat(dm[1]), 0.2, 60);
    // category
    const combat = has("sword") || has("punch") || has("kick") || has("thrust") || has("combo") || has("finisher") || has("slam") || has("attack") || has("spin") && (has("sword") || has("combo"));
    if (combat) {
      intent.category = "attack";
      intent.weapon = has("sword") ? "sword" : has("kick") ? "kick" : has("punch") ? "punch" : has("thrust") ? "thrust" : has("slam") ? "slam" : "punch";
      if (has("twohand") || intent.weapon === "slam") intent.hands = 2; else if (intent.weapon === "sword") intent.hands = 1;
      const strikes = countOf(t, "combo|strikes?|hits?|slash(?:es)?|punch(?:es)?|kicks?") || (has("combo") ? 3 : 1);
      const seq = [{ kind: "ready" }];
      if (has("anticipation") || strikes > 1 || intent.style === "anime" || intent.style === "heavy") seq.push({ kind: "anticipation" });
      const dirs = intent.weapon === "kick" ? ["kick_r", "kick_l", "kick_spin"] : intent.weapon === "slam" ? ["slash_over", "slash_r", "slash_over"] : intent.weapon === "thrust" ? ["thrust", "thrust", "thrust_low"] : intent.weapon === "punch" ? ["jab", "cross", "hook", "uppercut"] : ["slash_r", "slash_l", "slash_over", "thrust"];
      for (let i = 0; i < Math.min(strikes, 6); i++) { seq.push({ kind: "strike", variant: dirs[i % dirs.length], index: i }); if (i < strikes - 1) seq.push({ kind: "transition" }); }
      if (has("spin")) seq.push({ kind: "spin" });
      if (has("finisher") && !has("spin")) seq.push({ kind: "finisher" });
      if (has("jump") || has("spin") && has("land")) seq.push({ kind: "air" });
      if (has("land")) seq.push({ kind: "land" });
      seq.push({ kind: "recover" });
      intent.stages = seq;
      intent.loop = false;
    } else if (has("dodge")) { intent.category = "dodge"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "dodge" }, { kind: "recover" }]; }
    else if (has("block")) { intent.category = "block"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "block" }, { kind: "recover" }]; }
    else if (has("cast") || has("transform")) { intent.category = has("transform") ? "transform" : "cast"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "anticipation" }, { kind: "cast" }, { kind: "recover" }]; }
    else if (has("run")) { intent.category = "run"; intent.loop = true; }
    else if (has("walk")) { intent.category = "walk"; intent.loop = true; }
    else if (has("swim")) { intent.category = "swim"; intent.loop = true; }
    else if (has("climb")) { intent.category = "climb"; intent.loop = true; }
    else if (has("jump") || has("fall")) { intent.category = "jump"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "anticipation" }, { kind: "air" }, { kind: "land" }, { kind: "recover" }]; }
    else if (has("land")) { intent.category = "land"; intent.loop = false; intent.stages = [{ kind: "air" }, { kind: "land" }, { kind: "recover" }]; }
    else if (has("wave") || has("cheer") || has("dance") || has("point") || has("clap") || has("laugh") || has("bow")) { intent.category = "emote"; intent.action = ["wave", "cheer", "dance", "point", "clap", "laugh", "bow"].find((k) => has(k)); intent.loop = has("dance") || has("laugh"); }
    else if (has("sit")) { intent.category = "sit"; intent.loop = true; }
    else if (has("crouch")) { intent.category = "crouch"; intent.loop = true; }
    else { intent.category = "idle"; intent.loop = true; }
    if (has("loop")) intent.loop = true; if (has("noloop")) intent.loop = false;
    if (intent.duration == null) intent.duration = defaultDuration(intent);
    intent.priority = intent.category === "idle" || intent.category === "sit" || intent.category === "crouch" ? "Idle" : (intent.category === "walk" || intent.category === "run" || intent.category === "swim" || intent.category === "climb") ? "Movement" : "Action";
    return intent;
  }
  function defaultDuration(i) {
    if (i.category === "attack") { const strikes = i.stages.filter((s) => s.kind === "strike").length; return clamp((1.1 + strikes * 0.55 + (i.stages.some((s) => s.kind === "spin") ? 0.7 : 0) + (i.stages.some((s) => s.kind === "land") ? 0.5 : 0)) / i.speed, 0.6, 12); }
    return { idle: 4, walk: 1.0 / i.speed, run: 0.7 / i.speed, swim: 1.6 / i.speed, climb: 1.4 / i.speed, jump: 1.4 / i.speed, land: 0.9, dodge: 0.8 / i.speed, block: 0.9, cast: 1.8 / i.speed, transform: 2.6 / i.speed, emote: 2.0, sit: 4, crouch: 4 }[i.category] || 2;
  }
  function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; }
  function rng(seed) { let x = (seed >>> 0) || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

  // ───────────────────────── pose helpers ─────────────────────────
  const QUALITY = {
    fast: { fps: 24, breakdowns: 0, followThrough: false, arcs: false, secondary: false, passes: 1, holdFrames: 1 },
    balanced: { fps: 30, breakdowns: 1, followThrough: true, arcs: false, secondary: true, passes: 1, holdFrames: 2 },
    high: { fps: 30, breakdowns: 2, followThrough: true, arcs: true, secondary: true, passes: 2, holdFrames: 2 },
    cinematic: { fps: 60, breakdowns: 3, followThrough: true, arcs: true, secondary: true, passes: 3, holdFrames: 3 },
  };
  const J = (x, y, z) => ({ rot: [x, y, z] });
  // Base standing pose (neutral, slightly alive) scaled by style.
  function stance(k, style) {
    const hunch = style === "zombie" ? 25 : style === "heavy" ? 8 : 0;
    const p = {
      root: { rot: [0, 0, 0], pos: [0, 0, 0] }, waist: J(-hunch * 0.5, 0, 0), neck: J(hunch * 0.6, 0, 0),
      l_shoulder: J(5, 0, -6), l_elbow: J(8, 0, 0), l_wrist: J(0, 0, 0), r_shoulder: J(5, 0, 6), r_elbow: J(8, 0, 0), r_wrist: J(0, 0, 0),
      l_hip: J(2, 0, -3), l_knee: J(-4, 0, 0), l_ankle: J(2, 0, 0), r_hip: J(2, 0, 3), r_knee: J(-4, 0, 0), r_ankle: J(2, 0, 0),
    };
    if (style === "zombie") { p.l_shoulder = J(80, 0, -5); p.r_shoulder = J(75, 0, 5); p.l_elbow = J(20, 0, 0); p.r_elbow = J(25, 0, 0); }
    if (style === "robotic") { p.l_elbow = J(0, 0, 0); p.r_elbow = J(0, 0, 0); p.l_knee = J(0, 0, 0); p.r_knee = J(0, 0, 0); }
    return p;
  }
  // Combat ready stance: weight low, lead foot forward, weapon arm cocked.
  function readyPose(k, style, weapon, hands) {
    const p = stance(k, style);
    p.root = { rot: [-6 * k, 15, 0], pos: [0, -0.15 * k, 0] };
    p.waist = J(-8 * k, -12, 0); p.neck = J(6, 10, 0);
    p.l_hip = J(22 * k, 0, -6); p.l_knee = J(-28 * k, 0, 0); p.l_ankle = J(6, 0, 0);
    p.r_hip = J(-10 * k, 0, 8); p.r_knee = J(-24 * k, 0, 0); p.r_ankle = J(14, 0, 0);
    if (weapon === "sword") {
      p.r_shoulder = J(40 * k, 0, 20); p.r_elbow = J(95 * k, 0, 0); p.r_wrist = J(-20, 0, 0);
      if (hands === 2) { p.l_shoulder = J(45 * k, 25, -10); p.l_elbow = J(100 * k, 0, 0); } else { p.l_shoulder = J(30 * k, 0, -25); p.l_elbow = J(60 * k, 0, 0); }
    } else if (weapon === "kick") {
      p.r_shoulder = J(55 * k, 0, 25); p.r_elbow = J(110 * k, 0, 0); p.l_shoulder = J(60 * k, 0, -25); p.l_elbow = J(115 * k, 0, 0);
    } else { // fists up
      p.r_shoulder = J(60 * k, 0, 15); p.r_elbow = J(125 * k, 0, 0); p.l_shoulder = J(70 * k, 0, -15); p.l_elbow = J(130 * k, 0, 0);
    }
    return p;
  }
  function mix(a, b, t) { // blend two poses
    const out = {};
    for (const j of JOINTS) {
      const A = a[j] || J(0, 0, 0), B = b[j] || J(0, 0, 0);
      const o = { rot: [lerp(A.rot[0], B.rot[0], t), lerp(A.rot[1], B.rot[1], t), lerp(A.rot[2], B.rot[2], t)] };
      if (A.pos || B.pos) { const pa = A.pos || [0, 0, 0], pb = B.pos || [0, 0, 0]; o.pos = [lerp(pa[0], pb[0], t), lerp(pa[1], pb[1], t), lerp(pa[2], pb[2], t)]; }
      out[j] = o;
    }
    return out;
  }
  const clonePose = (p) => JSON.parse(JSON.stringify(p));
  function withOverrides(base, o) { const p = clonePose(base); for (const j of Object.keys(o)) p[j] = Object.assign({}, p[j] || {}, o[j]); return p; }
  function scalePose(base, p, s) { return mix(base, p, s); } // exaggerate (s>1) or soften relative to base

  // ───────────────────────── stage generators ─────────────────────────
  // Each generator returns beats: [{ at: 0..1 (fraction of the stage), pose, ease, tag }].
  function strikeBeats(variant, k, hands, prev) {
    const B = [];
    const twoH = hands === 2;
    if (variant === "slash_r") { // right-to-left horizontal slash
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { waist: J(-6 * k, 35 * k, 0), neck: J(4, -20, 0), r_shoulder: J(60 * k, 30, 70 * k), r_elbow: J(70 * k, 0, 0), r_wrist: J(-25, 0, 20), l_shoulder: twoH ? J(60 * k, 40, 10) : J(25 * k, 0, -30), l_elbow: twoH ? J(80 * k, 0, 0) : J(40, 0, 0), root: { rot: [-4, 20 * k, 0], pos: [0, -0.1, 0] } }) });
      B.push({ at: 0.55, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { waist: J(-12 * k, -40 * k, -5), neck: J(8, 15, 0), r_shoulder: J(85 * k, -40, -25 * k), r_elbow: J(10, 0, 0), r_wrist: J(10, 0, -25), l_shoulder: twoH ? J(80 * k, -30, 20) : J(-20 * k, 0, -35), l_elbow: twoH ? J(15, 0, 0) : J(30, 0, 0), root: { rot: [-10 * k, -30 * k, 0], pos: [0, -0.22 * k, -0.25 * k] }, r_hip: J(10, 0, 8), l_hip: J(30 * k, 0, -5), l_knee: J(-40 * k, 0, 0) }) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { waist: J(-8 * k, -55 * k, -8), neck: J(6, 25, 0), r_shoulder: J(70 * k, -60, -45 * k), r_elbow: J(25, 0, 0), r_wrist: J(15, 0, -30), l_shoulder: twoH ? J(65 * k, -40, 25) : J(-30 * k, 0, -40), l_elbow: twoH ? J(20, 0, 0) : J(35, 0, 0), root: { rot: [-8 * k, -40 * k, 0], pos: [0, -0.18 * k, -0.2 * k] } }) });
    } else if (variant === "slash_l") { // left-to-right return slash
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { waist: J(-6 * k, -45 * k, -6), neck: J(4, 20, 0), r_shoulder: J(75 * k, -55, -50 * k), r_elbow: J(40 * k, 0, 0), r_wrist: J(20, 0, -30), l_shoulder: twoH ? J(70 * k, -35, 20) : J(-25 * k, 0, -40), l_elbow: twoH ? J(25, 0, 0) : J(30, 0, 0), root: { rot: [-6, -35 * k, 0], pos: [0, -0.15, -0.1] } }) });
      B.push({ at: 0.55, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { waist: J(-14 * k, 40 * k, 6), neck: J(8, -15, 0), r_shoulder: J(90 * k, 35, 55 * k), r_elbow: J(8, 0, 0), r_wrist: J(-15, 0, 25), l_shoulder: twoH ? J(85 * k, 35, 5) : J(30 * k, 0, -20), l_elbow: twoH ? J(10, 0, 0) : J(60, 0, 0), root: { rot: [-12 * k, 30 * k, 0], pos: [0, -0.25 * k, -0.35 * k] }, r_hip: J(35 * k, 0, 10), r_knee: J(-45 * k, 0, 0), l_hip: J(-5, 0, -6) }) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { waist: J(-10 * k, 55 * k, 8), neck: J(6, -25, 0), r_shoulder: J(80 * k, 55, 75 * k), r_elbow: J(20, 0, 0), r_wrist: J(-20, 0, 30), l_shoulder: twoH ? J(75 * k, 45, 0) : J(35 * k, 0, -15), l_elbow: twoH ? J(15, 0, 0) : J(65, 0, 0), root: { rot: [-10 * k, 40 * k, 0], pos: [0, -0.2 * k, -0.3 * k] } }) });
    } else if (variant === "slash_over") { // overhead downward chop
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { waist: J(18 * k, 0, 0), neck: J(-15, 0, 0), r_shoulder: J(175 * k, 0, 15), r_elbow: J(110 * k, 0, 0), r_wrist: J(-30, 0, 0), l_shoulder: twoH ? J(170 * k, 0, -15) : J(40 * k, 0, -30), l_elbow: twoH ? J(115 * k, 0, 0) : J(50, 0, 0), root: { rot: [8 * k, 0, 0], pos: [0, 0.08, 0.15] }, l_knee: J(-10, 0, 0), r_knee: J(-10, 0, 0) }) });
      B.push({ at: 0.5, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { waist: J(-40 * k, 0, 0), neck: J(25, 0, 0), r_shoulder: J(60 * k, 0, 10), r_elbow: J(5, 0, 0), r_wrist: J(35, 0, 0), l_shoulder: twoH ? J(55 * k, 0, -10) : J(-15 * k, 0, -35), l_elbow: twoH ? J(5, 0, 0) : J(30, 0, 0), root: { rot: [-22 * k, 0, 0], pos: [0, -0.45 * k, -0.4 * k] }, l_hip: J(55 * k, 0, -8), l_knee: J(-75 * k, 0, 0), r_hip: J(-20 * k, 0, 10), r_knee: J(-30 * k, 0, 0), r_ankle: J(25, 0, 0) }) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { waist: J(-45 * k, 0, 0), neck: J(30, 0, 0), r_shoulder: J(35 * k, 0, 10), r_elbow: J(12, 0, 0), r_wrist: J(40, 0, 0), l_shoulder: twoH ? J(30 * k, 0, -10) : J(-20 * k, 0, -35), root: { rot: [-25 * k, 0, 0], pos: [0, -0.5 * k, -0.35 * k] } }) });
    } else if (variant === "thrust" || variant === "thrust_low") {
      const low = variant === "thrust_low" ? 1 : 0;
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { waist: J(-4, 40 * k, 0), neck: J(4, -30, 0), r_shoulder: J(20 * k, 10, 25), r_elbow: J(130 * k, 0, 0), r_wrist: J(0, 0, 0), l_shoulder: J(60 * k, 20, -20), l_elbow: J(90 * k, 0, 0), root: { rot: [-5, 35 * k, 0], pos: [0, -0.12, 0.2] } }) });
      B.push({ at: 0.5, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { waist: J(-18 * k - low * 15, -25 * k, 0), neck: J(10, 20, 0), r_shoulder: J(95 * k - low * 25, 0, 5), r_elbow: J(0, 0, 0), r_wrist: J(0, 0, 0), l_shoulder: J(-35 * k, 0, -30), l_elbow: J(40, 0, 0), root: { rot: [-15 * k - low * 10, -25 * k, 0], pos: [0, -0.35 * k - low * 0.3, -0.75 * k] }, l_hip: J(70 * k + low * 15, 0, -6), l_knee: J(-90 * k, 0, 0), r_hip: J(-30 * k, 0, 10), r_knee: J(-10, 0, 0), r_ankle: J(30, 0, 0) }) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { waist: J(-20 * k - low * 15, -30 * k, 0), r_shoulder: J(100 * k - low * 25, -5, 5), r_elbow: J(5, 0, 0), root: { rot: [-16 * k - low * 10, -28 * k, 0], pos: [0, -0.38 * k - low * 0.3, -0.8 * k] } }) });
    } else if (variant === "jab" || variant === "cross" || variant === "hook" || variant === "uppercut") {
      const arm = variant === "jab" ? "l" : "r", other = arm === "l" ? "r" : "l", sgn = arm === "l" ? -1 : 1;
      const o = {};
      const wind = {}; wind.waist = J(-4, 15 * sgn * k, 0); wind[arm + "_shoulder"] = J(65 * k, 0, 18 * sgn); wind[arm + "_elbow"] = J(135 * k, 0, 0); wind.root = { rot: [-4, 12 * sgn * k, 0], pos: [0, -0.12, 0.05] };
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, wind) });
      if (variant === "uppercut") { o.waist = J(-20 * k, -20 * sgn * k, 0); o[arm + "_shoulder"] = J(120 * k, 0, 12 * sgn); o[arm + "_elbow"] = J(95 * k, 0, 0); o.root = { rot: [-6, -15 * sgn * k, 0], pos: [0, -0.05, -0.2] }; o[arm + "_hip"] = J(10, 0, 6 * sgn); o[arm + "_knee"] = J(-45 * k, 0, 0); }
      else if (variant === "hook") { o.waist = J(-10 * k, -45 * sgn * k, 0); o[arm + "_shoulder"] = J(90 * k, -30 * sgn, 35 * sgn); o[arm + "_elbow"] = J(95 * k, 0, 0); o.root = { rot: [-8, -35 * sgn * k, 0], pos: [0, -0.15, -0.2] }; }
      else { o.waist = J(-14 * k, -30 * sgn * k, 0); o[arm + "_shoulder"] = J(92 * k, 0, 5 * sgn); o[arm + "_elbow"] = J(2, 0, 0); o[arm + "_wrist"] = J(0, 0, 0); o.root = { rot: [-10 * k, -25 * sgn * k, 0], pos: [0, -0.15, -0.35 * k] }; }
      o.neck = J(8, 10 * sgn, 0); o[other + "_shoulder"] = J(70 * k, 0, -15 * sgn); o[other + "_elbow"] = J(135 * k, 0, 0);
      B.push({ at: 0.5, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, o) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, Object.assign({}, o, { [arm + "_shoulder"]: J((o[arm + "_shoulder"].rot[0] + 6), o[arm + "_shoulder"].rot[1] - 5 * sgn, o[arm + "_shoulder"].rot[2]) })) });
    } else if (variant === "kick_r" || variant === "kick_l" || variant === "kick_spin") {
      const leg = variant === "kick_l" ? "l" : "r", st = leg === "l" ? "r" : "l", sgn = leg === "l" ? -1 : 1;
      const w = {}; w[leg + "_hip"] = J(-35 * k, 0, 6 * sgn); w[leg + "_knee"] = J(-100 * k, 0, 0); w.waist = J(-8, 20 * sgn * k, 0); w.root = { rot: [-6, 15 * sgn * k, 0], pos: [0, -0.1, 0.1] }; w[st + "_knee"] = J(-30 * k, 0, 0);
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, w) });
      const o = {}; o[leg + "_hip"] = J(100 * k, 0, 10 * sgn); o[leg + "_knee"] = J(-5, 0, 0); o[leg + "_ankle"] = J(20, 0, 0); o.waist = J(15 * k, -20 * sgn * k, -5 * sgn); o.neck = J(-5, 15 * sgn, 0); o.root = { rot: [12 * k, variant === "kick_spin" ? 170 * sgn : -20 * sgn * k, 8 * sgn], pos: [0, 0.05, 0.1] }; o[st + "_knee"] = J(-20 * k, 0, 0); o[st + "_ankle"] = J(8, 0, 0); o[leg + "_shoulder"] = J(-40 * k, 0, 30 * sgn); o[st + "_shoulder"] = J(60 * k, 0, -30 * sgn); o[st + "_elbow"] = J(80, 0, 0);
      B.push({ at: 0.5, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, o) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, Object.assign({}, o, { [leg + "_hip"]: J(85 * k, 0, 12 * sgn), [leg + "_knee"]: J(-25 * k, 0, 0) })) });
    }
    return B;
  }
  function spinBeats(k, hands, prev, turns) {
    const B = []; const total = 360 * (turns || 1);
    B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { root: { rot: [-8, -40 * k, 0], pos: [0, -0.3 * k, 0] }, waist: J(-10, -30 * k, 0), r_shoulder: J(70 * k, -40, -30), r_elbow: J(60, 0, 0), l_shoulder: J(40 * k, -20, -40), l_elbow: J(50, 0, 0), l_knee: J(-50 * k, 0, 0), r_knee: J(-50 * k, 0, 0) }) });
    const steps = 4 * (turns || 1);
    for (let i = 1; i <= steps; i++) {
      const f = i / steps; const yaw = -40 * k + total * f; const air = Math.sin(Math.PI * f) * 0.9 * k;
      B.push({ at: 0.1 + 0.75 * f, tag: i === Math.round(steps * 0.6) ? "impact" : "arc", ease: ["Linear", "InOut"], pose: withOverrides(prev, { root: { rot: [-6, yaw, 0], pos: [0, air, 0] }, waist: J(-12, 10 * Math.sin(f * Math.PI * 2), 0), neck: J(5, 15, 0), r_shoulder: J(95 * k, 0, 80 * k), r_elbow: J(5, 0, 0), r_wrist: J(0, 0, 0), l_shoulder: J(90 * k, 0, -80 * k), l_elbow: J(hands === 2 ? 20 : 10, 0, 0), l_hip: J(20, 0, -15), l_knee: J(-70 * k, 0, 0), r_hip: J(15, 0, 15), r_knee: J(-65 * k, 0, 0) }) });
    }
    B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-10, total - 40 * k + 20, 0], pos: [0, -0.1, 0] }, waist: J(-15 * k, 20, 0), r_shoulder: J(70 * k, -20, 50), r_elbow: J(20, 0, 0), l_shoulder: J(70 * k, 0, -50), l_knee: J(-40 * k, 0, 0), r_knee: J(-40 * k, 0, 0) }) });
    return B;
  }
  function airBeats(k, prev) {
    return [
      { at: 0.0, tag: "launch", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-8, 0, 0], pos: [0, 0.15 * k, 0] }, waist: J(-10, 0, 0), l_shoulder: J(110 * Math.min(k, 1.2), 0, -30), r_shoulder: J(110 * Math.min(k, 1.2), 0, 30), l_elbow: J(30, 0, 0), r_elbow: J(30, 0, 0), l_hip: J(10, 0, -6), r_hip: J(10, 0, 6), l_knee: J(-20, 0, 0), r_knee: J(-20, 0, 0), l_ankle: J(-25, 0, 0), r_ankle: J(-25, 0, 0) }) },
      { at: 0.5, tag: "apex", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { root: { rot: [-5, 0, 0], pos: [0, Math.min(1.8, 1.45 * k), 0] }, waist: J(-20 * k, 0, 0), neck: J(15, 0, 0), l_shoulder: J(60 * k, 0, -45), r_shoulder: J(60 * k, 0, 45), l_elbow: J(70, 0, 0), r_elbow: J(70, 0, 0), l_hip: J(80 * k, 0, -8), r_hip: J(75 * k, 0, 8), l_knee: J(-110 * k, 0, 0), r_knee: J(-105 * k, 0, 0), l_ankle: J(-20, 0, 0), r_ankle: J(-20, 0, 0) }) },
      { at: 0.82, tag: "fall", ease: ["CubicV2", "In"], pose: withOverrides(prev, { root: { rot: [0, 0, 0], pos: [0, 0.4 * k, 0] }, waist: J(-10, 0, 0), neck: J(20, 0, 0), l_shoulder: J(40, 0, -60 * k), r_shoulder: J(40, 0, 60 * k), l_elbow: J(20, 0, 0), r_elbow: J(20, 0, 0), l_hip: J(30, 0, -8), r_hip: J(30, 0, 8), l_knee: J(-40, 0, 0), r_knee: J(-40, 0, 0), l_ankle: J(-30, 0, 0), r_ankle: J(-30, 0, 0) }) },
    ];
  }
  function landBeats(k, weight, prev) {
    const w = weight || 1;
    return [
      { at: 0.0, tag: "contact", ease: ["Linear", "Out"], pose: withOverrides(prev, { root: { rot: [-10 * k, 0, 0], pos: [0, -0.1, 0] }, l_hip: J(35, 0, -8), r_hip: J(35, 0, 8), l_knee: J(-50, 0, 0), r_knee: J(-50, 0, 0), l_ankle: J(15, 0, 0), r_ankle: J(15, 0, 0) }) },
      { at: 0.22, tag: "impact", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-25 * k * w, 0, 0], pos: [0, -Math.min(1.5, 0.8 * k * w), 0] }, waist: J(-30 * k * w, 0, 0), neck: J(20 * w, 0, 0), l_shoulder: J(45 * k, 0, -40 * w), r_shoulder: J(45 * k, 0, 40 * w), l_elbow: J(40, 0, 0), r_elbow: J(40, 0, 0), l_hip: J(95 * k * Math.min(1.25, w), 0, -14), r_hip: J(90 * k * Math.min(1.25, w), 0, 14), l_knee: J(-125 * k * Math.min(1.2, w), 0, 0), r_knee: J(-120 * k * Math.min(1.2, w), 0, 0), l_ankle: J(30, 0, 0), r_ankle: J(30, 0, 0) }) },
      { at: 0.5, tag: "settle", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { root: { rot: [-18 * k * w, 0, 0], pos: [0, -Math.min(1.2, 0.6 * k * w), 0] }, waist: J(-22 * k * w, 0, 0), neck: J(14 * w, 0, 0), l_hip: J(75 * k, 0, -12), r_hip: J(70 * k, 0, 12), l_knee: J(-100 * k, 0, 0), r_knee: J(-95 * k, 0, 0), l_ankle: J(25, 0, 0), r_ankle: J(25, 0, 0) }) },
      { at: 1.0, tag: "rise", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-6, 0, 0], pos: [0, -0.2, 0] }, waist: J(-8, 0, 0), neck: J(4, 0, 0), l_hip: J(25, 0, -6), r_hip: J(25, 0, 6), l_knee: J(-35, 0, 0), r_knee: J(-35, 0, 0), l_ankle: J(10, 0, 0), r_ankle: J(10, 0, 0) }) },
    ];
  }
  function anticipationBeats(k, amp, prev, weapon, hands) {
    const a = amp || 1;
    const p = withOverrides(prev, { root: { rot: [-4, 25 * k * a, 0], pos: [0, -0.28 * k * a, 0.25 * a] }, waist: J(-4, 30 * k * a, 0), neck: J(4, -25 * a, 0), l_knee: J(-45 * k * a, 0, 0), r_knee: J(-40 * k * a, 0, 0), l_hip: J(30 * k, 0, -6), r_hip: J(10, 0, 8) });
    if (weapon === "sword") { p.r_shoulder = J(70 * k * a, 35, 60 * k * a); p.r_elbow = J(110 * k, 0, 0); p.r_wrist = J(-30 * a, 0, 15); if (hands === 2) { p.l_shoulder = J(75 * k * a, 45, 0); p.l_elbow = J(100 * k, 0, 0); } }
    else if (weapon === "kick") { p.r_shoulder = J(60 * k, 0, 30); p.l_shoulder = J(65 * k, 0, -30); }
    else { p.r_shoulder = J(45 * k * a, 0, 25); p.r_elbow = J(140 * k, 0, 0); p.l_shoulder = J(75 * k, 0, -20); p.l_elbow = J(130 * k, 0, 0); }
    return [{ at: 0.0, tag: "anticipation", ease: ["CubicV2", "In"], pose: p }, { at: 1.0, tag: "hold", ease: ["CubicV2", "InOut"], pose: withOverrides(p, { root: { rot: [-5, 28 * k * a, 0], pos: [0, -0.32 * k * a, 0.28 * a] } }) }];
  }
  function dodgeBeats(k, prev) {
    return [
      { at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { root: { rot: [-6, 0, 10 * k], pos: [0.25 * k, -0.15, 0] }, waist: J(-10, 0, 12 * k), l_knee: J(-40, 0, 0), r_knee: J(-35, 0, 0) }) },
      { at: 0.4, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { root: { rot: [-12 * k, 0, -25 * k], pos: [-1.6 * k, -0.6 * k, 0] }, waist: J(-20 * k, 0, -20 * k), neck: J(8, 0, 15), l_shoulder: J(50 * k, 0, -50 * k), r_shoulder: J(40 * k, 0, 30), l_elbow: J(60, 0, 0), r_elbow: J(70, 0, 0), l_hip: J(70 * k, 0, -25 * k), l_knee: J(-110 * k, 0, 0), r_hip: J(40 * k, 0, 30 * k), r_knee: J(-70 * k, 0, 0), r_ankle: J(25, 0, 0) }) },
      { at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-6, 0, -8 * k], pos: [-2.0 * k, -0.25, 0] }, waist: J(-8, 0, -6), l_hip: J(30, 0, -10), l_knee: J(-45, 0, 0), r_hip: J(15, 0, 12), r_knee: J(-40, 0, 0) }) },
    ];
  }
  function blockBeats(k, prev) {
    return [
      { at: 0.0, tag: "windup", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-6, 0, 0], pos: [0, -0.15, 0.1] }, waist: J(-10 * k, 10, 0), neck: J(8, 0, 0), l_shoulder: J(95 * k, 30, -40), l_elbow: J(130 * k, 0, 0), r_shoulder: J(100 * k, -30, 40), r_elbow: J(125 * k, 0, 0), l_knee: J(-35 * k, 0, 0), r_knee: J(-35 * k, 0, 0) }) },
      { at: 0.45, tag: "impact", ease: ["Elastic", "Out"], pose: withOverrides(prev, { root: { rot: [-4, 0, 0], pos: [0, -0.22, 0.3 * k] }, waist: J(-6 * k, 8, 0), neck: J(14, 0, 0), l_shoulder: J(85 * k, 28, -38), l_elbow: J(125 * k, 0, 0), r_shoulder: J(90 * k, -28, 38), r_elbow: J(120 * k, 0, 0), l_knee: J(-45 * k, 0, 0), r_knee: J(-45 * k, 0, 0) }) },
      { at: 1.0, tag: "hold", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-6, 0, 0], pos: [0, -0.18, 0.2 * k] }, l_shoulder: J(95 * k, 30, -40), r_shoulder: J(100 * k, -30, 40), l_elbow: J(130 * k, 0, 0), r_elbow: J(125 * k, 0, 0), l_knee: J(-40 * k, 0, 0), r_knee: J(-40 * k, 0, 0) }) },
    ];
  }
  function castBeats(k, prev, transform) {
    const up = transform ? 1 : 0;
    return [
      { at: 0.0, tag: "gather", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { root: { rot: [-4, 0, 0], pos: [0, -0.25 * k, 0] }, waist: J(-12 * k, 0, 0), neck: J(10, 0, 0), l_shoulder: J(45 * k, 20, -20), r_shoulder: J(45 * k, -20, 20), l_elbow: J(110 * k, 0, 0), r_elbow: J(110 * k, 0, 0), l_wrist: J(-30, 0, 0), r_wrist: J(-30, 0, 0), l_knee: J(-35 * k, 0, 0), r_knee: J(-35 * k, 0, 0) }) },
      { at: 0.5, tag: "impact", ease: ["CubicV2", "Out"], pose: withOverrides(prev, transform ? { root: { rot: [10 * k, 0, 0], pos: [0, 0.1 * k, 0] }, waist: J(20 * k, 0, 0), neck: J(-30 * k, 0, 0), l_shoulder: J(110 * k, 0, -120 * k), r_shoulder: J(110 * k, 0, 120 * k), l_elbow: J(60, 0, 0), r_elbow: J(60, 0, 0), l_hip: J(15, 0, -25 * k), r_hip: J(15, 0, 25 * k), l_knee: J(-30, 0, 0), r_knee: J(-30, 0, 0) } : { root: { rot: [-14 * k, 0, 0], pos: [0, -0.2 * k, -0.35 * k] }, waist: J(-16 * k, 0, 0), neck: J(8, 0, 0), l_shoulder: J(95 * k, 0, -8), r_shoulder: J(95 * k, 0, 8), l_elbow: J(3, 0, 0), r_elbow: J(3, 0, 0), l_wrist: J(25, 0, 0), r_wrist: J(25, 0, 0), l_hip: J(50 * k, 0, -8), l_knee: J(-70 * k, 0, 0), r_hip: J(-20 * k, 0, 10), r_ankle: J(25, 0, 0) }) },
      { at: 1.0, tag: "hold", ease: ["CubicV2", "Out"], pose: withOverrides(prev, transform ? { root: { rot: [8 * k, 0, 0], pos: [0, 0.05 * k + up * 0.05, 0] }, waist: J(16 * k, 0, 0), neck: J(-25 * k, 0, 0), l_shoulder: J(105 * k, 0, -115 * k), r_shoulder: J(105 * k, 0, 115 * k) } : { root: { rot: [-12 * k, 0, 0], pos: [0, -0.2 * k, -0.3 * k] }, l_shoulder: J(92 * k, 0, -8), r_shoulder: J(92 * k, 0, 8) }) },
    ];
  }
  // Cycles (walk / run / swim / climb) - 8 keys over the loop, second half mirrored.
  function cycleKeys(category, k, style, duration, q) {
    const keys = [];
    const base = stance(k, style);
    const n = category === "run" ? 8 : 8;
    const run = category === "run";
    const swing = run ? 48 * k : 30 * k, kneeMax = run ? 95 * k : 55 * k, armSwing = run ? 55 * k : 26 * k, bob = run ? 0.22 * k : 0.09 * k, lean = run ? -14 * k : -3 * k;
    for (let i = 0; i < n; i++) {
      const f = i / n, ph = f * Math.PI * 2; // phase: 0 = right foot contact
      const p = clonePose(base);
      const hipR = Math.cos(ph) * swing, hipL = -hipR;
      // knee bends most during the swing-through (when the hip comes forward from behind)
      const kneeR = -(Math.max(0, Math.sin(ph + Math.PI / 2 + 0.6)) ** 1.5) * kneeMax - 6, kneeL = -(Math.max(0, Math.sin(ph - Math.PI / 2 + 0.6)) ** 1.5) * kneeMax - 6;
      if (category === "swim") {
        p.root = { rot: [-80, 0, 0], pos: [0, 0, 0] }; p.waist = J(-6 + Math.sin(ph) * 6, 0, 0); p.neck = J(35, Math.sin(ph) * 10, 0);
        p.r_shoulder = J(170 - 180 * ((f + 0.5) % 1), 0, 20 * Math.sin(ph)); p.l_shoulder = J(170 - 180 * f, 0, -20 * Math.sin(ph + Math.PI)); p.r_elbow = J(20 + 20 * Math.max(0, Math.sin(ph)), 0, 0); p.l_elbow = J(20 + 20 * Math.max(0, Math.sin(ph + Math.PI)), 0, 0);
        p.r_hip = J(Math.sin(ph * 2) * 18, 0, 4); p.l_hip = J(-Math.sin(ph * 2) * 18, 0, -4); p.r_knee = J(-12 - 10 * Math.max(0, Math.sin(ph * 2)), 0, 0); p.l_knee = J(-12 - 10 * Math.max(0, -Math.sin(ph * 2)), 0, 0);
      } else if (category === "climb") {
        p.root = { rot: [-10, 0, 0], pos: [0, Math.sin(ph) * 0.1, -0.2] }; p.waist = J(-10, Math.sin(ph) * 6, 0); p.neck = J(-25, 0, 0);
        p.r_shoulder = J(150 - 40 * Math.sin(ph), 0, 15); p.l_shoulder = J(150 + 40 * Math.sin(ph), 0, -15); p.r_elbow = J(50 + 40 * Math.max(0, Math.sin(ph)), 0, 0); p.l_elbow = J(50 + 40 * Math.max(0, -Math.sin(ph)), 0, 0);
        p.r_hip = J(60 + 40 * Math.sin(ph), 0, 8); p.l_hip = J(60 - 40 * Math.sin(ph), 0, -8); p.r_knee = J(-80 - 30 * Math.sin(ph), 0, 0); p.l_knee = J(-80 + 30 * Math.sin(ph), 0, 0);
      } else {
        p.root = { rot: [lean + Math.sin(ph * 2) * 2, 0, Math.sin(ph) * (run ? 4 : 2)], pos: [0, bob * (0.5 - 0.5 * Math.cos(ph * 2)) - (run ? 0.1 : 0.03), 0] };
        p.waist = J(-4 * k, -Math.cos(ph) * (run ? 12 : 6) * k, Math.sin(ph) * 3); p.neck = J(3, Math.cos(ph) * (run ? 6 : 3), -Math.sin(ph) * 2);
        p.r_hip = J(hipR, 0, 3); p.l_hip = J(hipL, 0, -3); p.r_knee = J(kneeR, 0, 0); p.l_knee = J(kneeL, 0, 0);
        p.r_ankle = J(clamp(-hipR * 0.35 + (run ? 10 : 4), -40, 40), 0, 0); p.l_ankle = J(clamp(-hipL * 0.35 + (run ? 10 : 4), -40, 40), 0, 0);
        p.r_shoulder = J(-Math.cos(ph) * armSwing + (run ? 10 : 0), 0, 8); p.l_shoulder = J(Math.cos(ph) * armSwing + (run ? 10 : 0), 0, -8);
        p.r_elbow = J(run ? 85 * k : 12 + 10 * Math.max(0, -Math.cos(ph)), 0, 0); p.l_elbow = J(run ? 85 * k : 12 + 10 * Math.max(0, Math.cos(ph)), 0, 0);
        if (style === "zombie") { p.r_shoulder = J(80 + Math.sin(ph) * 10, 0, 5); p.l_shoulder = J(75 - Math.sin(ph) * 10, 0, -5); p.waist = J(-25, Math.cos(ph) * 8, 0); p.neck = J(15, 0, Math.sin(ph) * 6); }
      }
      keys.push({ t: r3(f * duration), poses: p, ease: ["CubicV2", "InOut"], tag: i % (n / 2) === 0 ? "contact" : i % (n / 2) === n / 4 ? "passing" : "breakdown" });
    }
    return keys;
  }
  function idleKeys(category, k, style, duration, q, seed) {
    const base = category === "sit" ? withOverrides(stance(k, style), { root: { rot: [0, 0, 0], pos: [0, -1.5, 0] }, l_hip: J(85, 0, -8), r_hip: J(85, 0, 8), l_knee: J(-85, 0, 0), r_knee: J(-85, 0, 0), waist: J(-6, 0, 0) })
      : category === "crouch" ? withOverrides(stance(k, style), { root: { rot: [-10, 0, 0], pos: [0, -1.1, 0] }, l_hip: J(95, 0, -12), r_hip: J(95, 0, 12), l_knee: J(-125, 0, 0), r_knee: J(-125, 0, 0), waist: J(-20, 0, 0), neck: J(15, 0, 0), l_shoulder: J(50, 0, -15), r_shoulder: J(50, 0, 15), l_elbow: J(70, 0, 0), r_elbow: J(70, 0, 0) })
      : stance(k, style);
    const keys = []; const n = Math.max(4, Math.round(duration * (q.breakdowns + 1) * 1.5)); const rnd = rng(seed);
    const sway = rnd() * 0.5 + 0.75;
    for (let i = 0; i <= n; i++) {
      const f = i / n, ph = f * Math.PI * 2;
      const p = clonePose(base);
      const br = Math.sin(ph) * k, sw = Math.sin(ph * 0.5 + 1.0) * k * sway;
      p.root = { rot: [(base.root.rot[0]) + br * 1.2, sw * 2, Math.sin(ph * 0.5) * 1.5], pos: [(base.root.pos || [0, 0, 0])[0], (base.root.pos || [0, 0, 0])[1] + br * 0.035, (base.root.pos || [0, 0, 0])[2]] };
      p.waist = J(base.waist.rot[0] + br * 2.5, base.waist.rot[1] + sw * 3, base.waist.rot[2]); p.neck = J(base.neck.rot[0] - br * 2 + 1.5, base.neck.rot[1] + Math.sin(ph * 0.5 + 2.1) * 6 * k, base.neck.rot[2]);
      p.l_shoulder = J(base.l_shoulder.rot[0] + br * 2, base.l_shoulder.rot[1], base.l_shoulder.rot[2] - br * 2.5); p.r_shoulder = J(base.r_shoulder.rot[0] + br * 2, base.r_shoulder.rot[1], base.r_shoulder.rot[2] + br * 2.5);
      p.l_elbow = J(base.l_elbow.rot[0] + br * 2, 0, 0); p.r_elbow = J(base.r_elbow.rot[0] + br * 2, 0, 0);
      if (category === "idle") { p.l_knee = J(base.l_knee.rot[0] - Math.max(0, -br) * 1.5, 0, 0); p.r_knee = J(base.r_knee.rot[0] - Math.max(0, br) * 1.5, 0, 0); }
      keys.push({ t: r3(f * duration), poses: p, ease: ["CubicV2", "InOut"], tag: i === 0 ? "start" : "breath" });
    }
    return keys;
  }
  function emoteKeys(action, k, style, duration, q) {
    const base = stance(k, style); const keys = [];
    const push = (f, o, ease, tag) => keys.push({ t: r3(f * duration), poses: withOverrides(base, o), ease: ease || ["CubicV2", "InOut"], tag: tag || "beat" });
    if (action === "wave") {
      push(0, {}, ["CubicV2", "In"], "start");
      push(0.2, { r_shoulder: J(160 * k, 0, 35), r_elbow: J(60, 0, 0), r_wrist: J(0, 0, 0), waist: J(0, -8, -3), neck: J(0, -8, 4) }, ["CubicV2", "Out"], "raise");
      for (let i = 0; i < 3; i++) { push(0.3 + i * 0.2, { r_shoulder: J(160 * k, 0, 35), r_elbow: J(40, 0, 0), r_wrist: J(0, 0, -30 * k), waist: J(0, -8, -3), neck: J(0, -8, 4) }, ["CubicV2", "InOut"], "wave"); push(0.4 + i * 0.2, { r_shoulder: J(160 * k, 0, 35), r_elbow: J(70, 0, 0), r_wrist: J(0, 0, 30 * k), waist: J(0, -8, -3), neck: J(0, -8, 4) }, ["CubicV2", "InOut"], "wave"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "cheer") {
      push(0, { l_knee: J(-20, 0, 0), r_knee: J(-20, 0, 0), root: { rot: [-5, 0, 0], pos: [0, -0.15, 0] } }, ["CubicV2", "In"], "anticipation");
      push(0.3, { l_shoulder: J(175 * k, 0, -25), r_shoulder: J(175 * k, 0, 25), l_elbow: J(25, 0, 0), r_elbow: J(25, 0, 0), waist: J(10 * k, 0, 0), neck: J(-20, 0, 0), root: { rot: [6, 0, 0], pos: [0, 0.45 * k, 0] }, l_ankle: J(-20, 0, 0), r_ankle: J(-20, 0, 0) }, ["CubicV2", "Out"], "impact");
      push(0.55, { l_shoulder: J(170 * k, 0, -40), r_shoulder: J(170 * k, 0, 40), l_elbow: J(35, 0, 0), r_elbow: J(35, 0, 0), waist: J(6, 0, 0), neck: J(-15, 0, 0), root: { rot: [2, 0, 0], pos: [0, -0.2 * k, 0] }, l_knee: J(-30, 0, 0), r_knee: J(-30, 0, 0) }, ["Bounce", "Out"], "land");
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "dance") {
      for (let i = 0; i <= 8; i++) { const s = i % 2 ? 1 : -1, f = i / 8; push(f, { root: { rot: [0, s * 12 * k, s * 6], pos: [s * 0.2, -0.12 + (i % 2) * 0.1, 0] }, waist: J(-5, -s * 20 * k, -s * 8), neck: J(0, s * 15, s * 5), l_shoulder: J(s > 0 ? 120 * k : 20, 0, -30), r_shoulder: J(s < 0 ? 120 * k : 20, 0, 30), l_elbow: J(70, 0, 0), r_elbow: J(70, 0, 0), l_hip: J(s > 0 ? 20 : -10, 0, -8), r_hip: J(s < 0 ? 20 : -10, 0, 8), l_knee: J(-30 - (s > 0 ? 20 : 0), 0, 0), r_knee: J(-30 - (s < 0 ? 20 : 0), 0, 0) }, ["CubicV2", "InOut"], i === 0 || i === 8 ? "start" : "beat"); }
    } else if (action === "point") {
      push(0, {}, ["CubicV2", "In"], "start"); push(0.3, { r_shoulder: J(95 * k, 0, 10), r_elbow: J(5, 0, 0), r_wrist: J(0, 0, 0), waist: J(-4, -10, 0), neck: J(0, -10, 0) }, ["CubicV2", "Out"], "impact"); push(0.75, { r_shoulder: J(92 * k, 0, 10), r_elbow: J(8, 0, 0), waist: J(-4, -10, 0), neck: J(0, -10, 0) }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "clap") {
      push(0, {}, ["CubicV2", "In"], "start");
      for (let i = 0; i < 4; i++) { push(0.15 + i * 0.2, { l_shoulder: J(70 * k, 35, -20), r_shoulder: J(70 * k, -35, 20), l_elbow: J(95, 0, 0), r_elbow: J(95, 0, 0) }, ["Linear", "Out"], "impact"); push(0.25 + i * 0.2, { l_shoulder: J(70 * k, 15, -35), r_shoulder: J(70 * k, -15, 35), l_elbow: J(85, 0, 0), r_elbow: J(85, 0, 0) }, ["CubicV2", "InOut"], "open"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "laugh") {
      for (let i = 0; i <= 6; i++) { const f = i / 6, s = i % 2 ? 1 : 0; push(f, { waist: J(-6 - s * 14 * k, 0, 0), neck: J(-10 + s * 22 * k, 0, 0), root: { rot: [-4 - s * 6, 0, 0], pos: [0, -0.05 * s, 0] }, l_shoulder: J(30, 0, -14 + s * 10), r_shoulder: J(30, 0, 14 - s * 10), l_elbow: J(60 + s * 20, 0, 0), r_elbow: J(60 + s * 20, 0, 0) }, ["CubicV2", "InOut"], i === 0 || i === 6 ? "start" : "beat"); }
    } else if (action === "bow") {
      push(0, {}, ["CubicV2", "In"], "start"); push(0.35, { waist: J(-55 * k, 0, 0), neck: J(20, 0, 0), root: { rot: [-20 * k, 0, 0], pos: [0, -0.1, 0.15] }, l_shoulder: J(25, 0, -10), r_shoulder: J(40, 40, 10), r_elbow: J(110, 0, 0), l_knee: J(-12, 0, 0), r_knee: J(-12, 0, 0) }, ["CubicV2", "Out"], "impact"); push(0.7, { waist: J(-55 * k, 0, 0), neck: J(22, 0, 0), root: { rot: [-20 * k, 0, 0], pos: [0, -0.1, 0.15] }, l_shoulder: J(25, 0, -10), r_shoulder: J(40, 40, 10), r_elbow: J(110, 0, 0) }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    }
    return keys;
  }

  // ───────────────────────── sequencer ─────────────────────────
  const STAGE_WEIGHT = { ready: 0.4, anticipation: 0.7, strike: 1.0, transition: 0.4, spin: 1.7, finisher: 1.3, air: 1.1, land: 1.25, recover: 0.8, dodge: 1.2, block: 1.2, cast: 1.5 };
  const DEFAULT_PARAMS = { speed: 1, attackSpeed: 1, anticipation: 1, weight: 1, amplitude: 1, variation: 0 };
  function stageWeights(stages, params) {
    return stages.map((s) => {
      let v = STAGE_WEIGHT[s.kind] || 1;
      if (s.kind === "strike" || s.kind === "finisher" || s.kind === "spin") v /= params.attackSpeed;
      if (s.kind === "anticipation") v *= params.anticipation;
      if (s.kind === "land" || s.kind === "recover") v *= Math.sqrt(params.weight);
      return v;
    });
  }
  // Stage lengths: the prompt's duration is the budget at default params; feedback (faster attacks, more anticipation,
  // heavier landing) stretches or shrinks the affected stages, and therefore the clip, instead of stealing time elsewhere.
  function stageDurations(stages, total, params) {
    const w = stageWeights(stages, params), w0 = stageWeights(stages, DEFAULT_PARAMS);
    const sum = w.reduce((a, b) => a + b, 0), sum0 = w0.reduce((a, b) => a + b, 0);
    return w.map((v) => total * v / sum0 * (sum0 / sum) * (sum / sum0));
  }
  function generate(intentOrText, opts) {
    const intent = typeof intentOrText === "string" ? parseIntent(intentOrText) : JSON.parse(JSON.stringify(intentOrText));
    opts = opts || {};
    const quality = QUALITY[opts.quality || intent.quality || "balanced"] ? (opts.quality || intent.quality || "balanced") : "balanced";
    const q = QUALITY[quality];
    const params = Object.assign({}, DEFAULT_PARAMS, opts.params || {});
    const rigType = String(opts.rigType || intent.rigHint || "R15").toUpperCase() === "R6" ? "R6" : "R15";
    let duration = r3(clamp((opts.duration || intent.duration) / params.speed, 0.2, 60));
    if (intent.stages && intent.stages.length) { const w = stageWeights(intent.stages, params).reduce((a, b) => a + b, 0), w0 = stageWeights(intent.stages, DEFAULT_PARAMS).reduce((a, b) => a + b, 0); duration = r3(clamp(duration * w / w0, 0.2, 60)); }
    const k = clamp(intent.intensity * params.amplitude, 0.4, 1.8);
    const fps = clamp(Math.round(opts.fps || q.fps), 10, 120);
    duration = r3(Math.max(2 / fps, Math.round(duration * fps) / fps));
    const loop = typeof opts.loop === "boolean" ? opts.loop : !!intent.loop;
    const style = intent.style;
    let keys = [], stages = [];
    const seed = (intent.seed ^ Math.round(params.variation * 1000)) >>> 0;
    const jitter = params.variation ? rng(seed) : null;
    const vj = (v, pct) => jitter ? v * (1 + (jitter() * 2 - 1) * pct) : v;
    if (intent.stages && intent.stages.length) {
      const durs = stageDurations(intent.stages, duration, params);
      let t0 = 0, prev = stance(k, style), yawOffset = 0;
      const weapon = intent.weapon || "punch", hands = intent.hands || 1;
      intent.stages.forEach((s, idx) => {
        const d = vj(durs[idx], 0.08);
        let beats = [];
        if (s.kind === "ready") { const rp = intent.category === "attack" || intent.category === "dodge" || intent.category === "block" ? readyPose(k, style, weapon, hands) : stance(k, style); beats = [{ at: 0, tag: "start", ease: ["CubicV2", "Out"], pose: idx === 0 && !(intent.category === "attack") ? stance(k, style) : rp }, { at: 1, tag: "ready", ease: ["CubicV2", "InOut"], pose: rp }]; }
        else if (s.kind === "anticipation") beats = anticipationBeats(k, params.anticipation, prev, weapon, hands);
        else if (s.kind === "strike") beats = strikeBeats(s.variant, vj(k, 0.1), hands, prev);
        else if (s.kind === "transition") beats = [{ at: 1, tag: "transition", ease: ["CubicV2", "InOut"], pose: mix(prev, readyPose(k, style, weapon, hands), 0.55) }];
        else if (s.kind === "spin") { const turns = intent.text && /double spin|two spins|720/i.test(intent.text) ? 2 : 1; beats = spinBeats(k, hands, prev, turns); }
        else if (s.kind === "finisher") beats = strikeBeats(weapon === "kick" ? "kick_spin" : weapon === "punch" ? "uppercut" : "slash_over", k * 1.15, hands, prev);
        else if (s.kind === "air") { beats = airBeats(k, prev); if (idx > 0 && intent.stages[idx - 1].kind === "spin") beats = beats.filter((b) => b.tag !== "launch"); }
        else if (s.kind === "land") beats = landBeats(k, params.weight, prev);
        else if (s.kind === "dodge") beats = dodgeBeats(k, prev);
        else if (s.kind === "block") beats = blockBeats(k, prev);
        else if (s.kind === "cast") beats = castBeats(k, prev, intent.category === "transform");
        else if (s.kind === "recover") { const end = intent.category === "attack" ? readyPose(k * 0.9, style, weapon, hands) : stance(k, style); beats = [{ at: 0.55, tag: "settle", ease: ["CubicV2", "InOut"], pose: mix(prev, end, 0.6) }, { at: 1, tag: "end", ease: ["CubicV2", "Out"], pose: end }]; }
        if (yawOffset) for (const b of beats) { const rp = b.pose.root || { rot: [0, 0, 0] }; b.pose.root = Object.assign({}, rp, { rot: [rp.rot[0], rp.rot[1] + yawOffset, rp.rot[2]] }); }
        const stageKeys = beats.map((b) => ({ t: r3(t0 + b.at * d), poses: b.pose, ease: b.ease, tag: b.tag, stage: s.kind + (s.index != null ? "_" + (s.index + 1) : "") }));
        if (s.kind === "spin") yawOffset += 360 * (intent.text && /double spin|two spins|720/i.test(intent.text) ? 2 : 1);
        stages.push({ name: s.kind + (s.index != null ? "_" + (s.index + 1) : "") + (s.variant ? ":" + s.variant : ""), kind: s.kind, t0: r3(t0), t1: r3(t0 + d), marker: s.kind === "strike" || s.kind === "finisher" || s.kind === "spin" ? "hit" : s.kind === "land" ? "land" : s.kind });
        keys.push(...stageKeys);
        if (beats.length) prev = beats[beats.length - 1].pose;
        t0 += d;
      });
    } else if (intent.category === "walk" || intent.category === "run" || intent.category === "swim" || intent.category === "climb") {
      keys = cycleKeys(intent.category, k, style, duration, q); stages = [{ name: intent.category + "_cycle", kind: "cycle", t0: 0, t1: duration, marker: "cycle" }];
    } else if (intent.category === "emote" && intent.action) {
      keys = emoteKeys(intent.action, k, style, duration, q); stages = [{ name: intent.action, kind: "emote", t0: 0, t1: duration, marker: intent.action }];
    } else {
      keys = idleKeys(intent.category, k, style, duration, q, seed); stages = [{ name: intent.category, kind: "idle", t0: 0, t1: duration, marker: intent.category }];
    }
    // merge keys at identical times (later wins), sort
    keys = dedupeKeys(keys);
    // principles
    if (q.holdFrames) keys = addImpactHolds(keys, fps, q.holdFrames, duration);
    if (q.followThrough) keys = addFollowThrough(keys, fps, k, duration);
    if (q.arcs) keys = addArcs(keys, duration);
    if (q.secondary) keys = addSecondaryLag(keys, k);
    if (intent.upperOnly) for (const key of keys) for (const j of ["l_hip", "l_knee", "l_ankle", "r_hip", "r_knee", "r_ankle"]) key.poses[j] = J(0, 0, 0);
    if (loop) keys = closeLoop(keys, duration);
    keys = snapToFps(dedupeKeys(keys), fps, duration);
    let clip = {
      version: 1, engine: VERSION, name: opts.name || suggestName(intent), prompt: intent.text, intent, params, quality, rigType, fps, duration, loop, priority: opts.priority || intent.priority,
      stages, keys, created: opts.now || 0, edited: false, limitations: intent.unsupported.slice(),
    };
    if (rigType === "R6") clip.limitations.push("R6 rig: no elbow / knee / wrist / ankle / waist joints - elbow and knee bends are folded into the shoulders and hips, waist into the torso.");
    for (let pass = 0; pass < q.passes; pass++) { const r = refine(clip); clip = r.clip; if (!r.changed) break; }
    clip.report = validate(clip);
    return clip;
  }
  function suggestName(i) {
    const s = i.style !== "default" ? i.style[0].toUpperCase() + i.style.slice(1) : "";
    const core = i.category === "attack" ? (i.weapon === "sword" ? "SwordCombo" : i.weapon === "kick" ? "KickCombo" : "PunchCombo") : i.category === "emote" ? (i.action || "Emote")[0].toUpperCase() + (i.action || "emote").slice(1) : i.category[0].toUpperCase() + i.category.slice(1);
    return (s + core + (i.loop ? "Loop" : "")).replace(/[^A-Za-z0-9_]/g, "");
  }
  function dedupeKeys(keys) {
    const byT = new Map();
    for (const key of keys) { const t = r3(key.t); const ex = byT.get(t); byT.set(t, ex ? Object.assign({}, ex, key, { poses: Object.assign({}, ex.poses, key.poses) }) : Object.assign({}, key, { t })); }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }
  function snapToFps(keys, fps, duration) {
    const step = 1 / fps; const out = []; const seen = new Set();
    for (const key of keys) { let t = r3(Math.round(key.t / step) * step); t = clamp(t, 0, duration); if (seen.has(t)) continue; seen.add(t); out.push(Object.assign({}, key, { t })); }
    if (out.length && out[out.length - 1].t < duration && duration - out[out.length - 1].t > step * 0.5 && !keys.some((k) => Math.abs(k.t - duration) < 1e-6)) { /* leave */ }
    return out.sort((a, b) => a.t - b.t);
  }
  // Impact keys hold for N frames so the strike reads at gameplay speed.
  function addImpactHolds(keys, fps, frames, duration) {
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      out.push(keys[i]);
      if (keys[i].tag === "impact" && !/^spin/.test(keys[i].stage || "")) { const t = r3(keys[i].t + frames / fps); const next = keys[i + 1]; if (t < duration && (!next || next.t - t >= frames / fps)) out.push({ t, poses: clonePose(keys[i].poses), ease: ["CubicV2", "Out"], tag: "hold", stage: keys[i].stage, synthetic: true }); }
    }
    return out;
  }
  // Follow-through: secondary joints overshoot the impact pose shortly after it, then settle on the next key.
  function addFollowThrough(keys, fps, k, duration) {
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      out.push(keys[i]);
      const key = keys[i], next = keys[i + 1], prev = keys[i - 1];
      if (key.tag !== "impact" || !next || !prev) continue;
      const gap = next.t - key.t; if (gap < 5 / fps) continue;
      if (/^spin/.test(key.stage || "")) continue; // a spin is continuous - no overshoot/hold inside it
      const dtF = Math.min(gap * 0.45, 4 / fps), t = r3(key.t + dtF);
      const poses = mix(key.poses, next.poses, dtF / gap); // primary motion keeps going...
      for (const j of SECONDARY) { const a = prev.poses[j] || J(0, 0, 0), b = key.poses[j] || J(0, 0, 0); poses[j] = { rot: b.rot.map((v, ax) => v + (v - a.rot[ax]) * 0.22 * k) }; }
      out.push({ t, poses, ease: ["CubicV2", "Out"], tag: "follow_through", stage: key.stage, synthetic: true });
    }
    return out;
  }
  // Arcs: between windup and impact, lift the striking arm so the hand travels an arc instead of a chord.
  function addArcs(keys, duration) {
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      out.push(keys[i]);
      const a = keys[i], b = keys[i + 1];
      if (!b || a.tag !== "windup" || b.tag !== "impact") continue;
      const t = r3((a.t + b.t) / 2); const poses = mix(a.poses, b.poses, 0.5);
      for (const j of ["l_shoulder", "r_shoulder"]) { const d = Math.abs((b.poses[j] || J(0, 0, 0)).rot[0] - (a.poses[j] || J(0, 0, 0)).rot[0]) + Math.abs((b.poses[j] || J(0, 0, 0)).rot[2] - (a.poses[j] || J(0, 0, 0)).rot[2]); if (d > 40) poses[j].rot[0] += Math.min(35, d * 0.25); }
      out.push({ t, poses, ease: ["CubicV2", "InOut"], tag: "arc", stage: a.stage, synthetic: true });
    }
    return out;
  }
  // Secondary motion: the head lags the torso by one key (drag), scaled down.
  function addSecondaryLag(keys, k) {
    for (let i = 1; i < keys.length; i++) {
      const prevW = keys[i - 1].poses.waist || J(0, 0, 0), curW = keys[i].poses.waist || J(0, 0, 0), n = keys[i].poses.neck || J(0, 0, 0);
      keys[i].poses.neck = { rot: [n.rot[0] + (prevW.rot[0] - curW.rot[0]) * 0.18, n.rot[1] + (prevW.rot[1] - curW.rot[1]) * 0.25, n.rot[2] + (prevW.rot[2] - curW.rot[2]) * 0.15] };
    }
    return keys;
  }
  function closeLoop(keys, duration) {
    if (!keys.length) return keys;
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (Math.abs(last.t - duration) < 1e-6) { last.poses = clonePose(first.poses); last.tag = "loop_end"; return keys; }
    keys.push({ t: duration, poses: clonePose(first.poses), ease: first.ease, tag: "loop_end", synthetic: true });
    return keys;
  }

  // ───────────────────────── validation + refinement ─────────────────────────
  const SPEED_LIMIT = { normal: 1400, impact: 3200, root_pos: 18, root_pos_impact: 30 }; // deg/s, studs/s
  function validate(clip) {
    const issues = [];
    const add = (level, kind, msg, extra) => issues.push(Object.assign({ level, kind, msg }, extra || {}));
    const keys = clip.keys || [];
    if (!keys.length) add("error", "empty", "the clip has no keyframes");
    if (!(clip.duration > 0)) add("error", "duration", "duration must be > 0");
    let lastT = -1;
    for (const key of keys) {
      if (!Number.isFinite(key.t)) { add("error", "time", "keyframe with a non-numeric time"); continue; }
      if (key.t < 0 || key.t > clip.duration + 1e-6) add("error", "range", `keyframe at ${key.t}s is outside 0..${clip.duration}s`, { t: key.t });
      if (key.t <= lastT) add("error", "order", `keyframe times must be strictly increasing (at ${key.t}s)`, { t: key.t });
      lastT = key.t;
      for (const j of JOINTS) {
        const p = key.poses[j]; if (!p) continue;
        if (!p.rot || p.rot.length !== 3 || p.rot.some((v) => !Number.isFinite(v))) { add("error", "nan", `${j} at ${key.t}s has an invalid rotation`, { t: key.t, joint: j }); continue; }
        if (p.pos && p.pos.some((v) => !Number.isFinite(v))) add("error", "nan", `${j} at ${key.t}s has an invalid position`, { t: key.t, joint: j });
        const L = LIMITS[j];
        ["x", "y", "z"].forEach((ax, i) => { const v = p.rot[i]; if (v < L[ax][0] - 0.01 || v > L[ax][1] + 0.01) add("warn", "limit", `${j}.${ax} = ${Math.round(v)}° exceeds ${L[ax][0]}..${L[ax][1]}° at ${key.t}s`, { t: key.t, joint: j, axis: i }); });
        if (j === "root" && p.pos && (Math.abs(p.pos[1]) > 2.2 || Math.abs(p.pos[0]) > 3 || Math.abs(p.pos[2]) > 3)) add("warn", "root", `root offset ${p.pos.map((v) => v.toFixed(2)).join(",")} studs at ${key.t}s is very large`, { t: key.t, joint: j });
      }
    }
    // discontinuities
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i], dt = Math.max(1e-3, b.t - a.t);
      const impact = b.tag === "impact" || a.tag === "impact" || b.tag === "hold";
      for (const j of JOINTS) {
        const pa = a.poses[j], pb = b.poses[j]; if (!pa || !pb) continue;
        const d = Math.max(Math.abs(pb.rot[0] - pa.rot[0]), Math.abs(pb.rot[1] - pa.rot[1]), Math.abs(pb.rot[2] - pa.rot[2]));
        const speed = d / dt;
        if (speed > (impact ? SPEED_LIMIT.impact : SPEED_LIMIT.normal)) add(impact ? "warn" : "warn", "discontinuity", `${j} turns ${Math.round(d)}° in ${dt.toFixed(3)}s (${Math.round(speed)}°/s) at ${b.t}s`, { t: b.t, joint: j, speed, impact });
        if (j === "root" && (pa.pos || pb.pos)) { const A = pa.pos || [0, 0, 0], B = pb.pos || [0, 0, 0]; const dist = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]); if (dist / dt > (impact ? SPEED_LIMIT.root_pos_impact : SPEED_LIMIT.root_pos)) add("warn", "root_speed", `root moves ${dist.toFixed(2)} studs in ${dt.toFixed(3)}s at ${b.t}s`, { t: b.t, joint: j }); }
      }
    }
    // loop seam
    if (clip.loop && keys.length >= 2) {
      const a = keys[0], b = keys[keys.length - 1];
      let worst = 0, wj = null;
      for (const j of JOINTS) { const pa = a.poses[j], pb = b.poses[j]; if (!pa || !pb) continue; const d = Math.max(...[0, 1, 2].map((i) => Math.abs(pa.rot[i] - pb.rot[i]))); if (d > worst) { worst = d; wj = j; } }
      if (worst > 2) add("warn", "loop", `loop seam: ${wj} differs by ${Math.round(worst)}° between the last and first keyframe`, { joint: wj, delta: worst });
      if (Math.abs(b.t - clip.duration) > 1e-6) add("warn", "loop", `looping clip should end with a keyframe at ${clip.duration}s (last is ${b.t}s)`);
    }
    // timing sanity: too-dense / too-sparse
    if (keys.length >= 2) { const gaps = []; for (let i = 1; i < keys.length; i++) gaps.push(keys[i].t - keys[i - 1].t); const maxGap = Math.max(...gaps); if (maxGap > Math.max(1.2, clip.duration * 0.6)) add("info", "sparse", `a ${maxGap.toFixed(2)}s gap without keys - motion will be a straight interpolation there`); }
    // foot contact estimate (idle / land / cycles): both feet above ground while the clip is grounded
    if (/^(idle|walk|run|land|crouch)$/.test(clip.intent && clip.intent.category || "")) {
      for (const key of keys) { const m = metrics(key.poses); if (m.footMin > 0.55 && key.tag !== "apex" && key.tag !== "launch" && key.tag !== "fall") add("info", "contact", `both feet ~${m.footMin.toFixed(2)} studs above the rest ground at ${key.t}s (foot sliding / floating risk)`, { t: key.t }); }
    }
    const errors = issues.filter((i) => i.level === "error").length, warns = issues.filter((i) => i.level === "warn").length;
    const score = Math.max(0, 100 - errors * 25 - warns * 4 - issues.filter((i) => i.level === "info").length);
    return { ok: errors === 0, score, errors, warnings: warns, issues, keys: keys.length, duration: clip.duration, fps: clip.fps, loop: !!clip.loop, rigType: clip.rigType, stages: (clip.stages || []).map((s) => s.name), limitations: clip.limitations || [] };
  }
  // Fix what can be fixed objectively: clamp limits, bridge discontinuities with breakdowns, close loops, sort/dedupe.
  function refine(clipIn) {
    const clip = JSON.parse(JSON.stringify(clipIn));
    const fixes = [];
    clip.keys = dedupeKeys(clip.keys.filter((k) => Number.isFinite(k.t) && k.t >= 0 && k.t <= clip.duration + 1e-6).map((k) => Object.assign({}, k, { t: clamp(k.t, 0, clip.duration) })));
    let clamped = 0;
    for (const key of clip.keys) for (const j of JOINTS) { const p = key.poses[j]; if (!p || !p.rot) continue; const L = LIMITS[j]; ["x", "y", "z"].forEach((ax, i) => { const v = clamp(p.rot[i], L[ax][0], L[ax][1]); if (v !== p.rot[i]) { p.rot[i] = v; clamped++; } }); if (p.pos) p.pos = p.pos.map((v, i) => clamp(v, i === 1 ? -2.2 : -3, i === 1 ? 2.2 : 3)); }
    if (clamped) fixes.push(`clamped ${clamped} rotation value(s) to joint limits`);
    // discontinuities → insert a breakdown half-way (non-impact transitions only)
    const added = [];
    for (let i = 1; i < clip.keys.length; i++) {
      const a = clip.keys[i - 1], b = clip.keys[i], dt = b.t - a.t;
      if (dt < 4 / clip.fps) continue;
      const impact = b.tag === "impact" || a.tag === "impact" || b.tag === "hold";
      let worst = 0;
      for (const j of JOINTS) { const pa = a.poses[j], pb = b.poses[j]; if (!pa || !pb) continue; worst = Math.max(worst, ...[0, 1, 2].map((x) => Math.abs(pb.rot[x] - pa.rot[x]))); }
      if (worst / dt > (impact ? SPEED_LIMIT.impact : SPEED_LIMIT.normal) && !impact) added.push({ t: r3((a.t + b.t) / 2), poses: mix(a.poses, b.poses, 0.5), ease: ["CubicV2", "InOut"], tag: "breakdown", stage: a.stage, synthetic: true });
    }
    if (added.length) { clip.keys = dedupeKeys(clip.keys.concat(added)); fixes.push(`inserted ${added.length} breakdown key(s) to smooth abrupt transitions`); }
    if (clip.loop) { const before = JSON.stringify(clip.keys[clip.keys.length - 1].poses); clip.keys = closeLoop(clip.keys, clip.duration); if (JSON.stringify(clip.keys[clip.keys.length - 1].poses) !== before || clip.keys[clip.keys.length - 1].synthetic) fixes.push("closed the loop (last keyframe = first pose at the clip end)"); }
    clip.keys = snapToFps(clip.keys, clip.fps, clip.duration);
    clip.fixes = (clipIn.fixes || []).concat(fixes);
    return { clip, changed: fixes.length > 0 };
  }

  // ───────────────────────── feedback ─────────────────────────
  function applyFeedback(clip, feedback) {
    const f = String(feedback || "").toLowerCase();
    const p = Object.assign({}, clip.params || {});
    const notes = [];
    const has = (re) => re.test(f);
    const more = has(/\b(more|bigger|stronger|increase|longer|extra|exaggerat)/), less = has(/\b(less|smaller|weaker|decrease|shorter|reduce|subtle)/);
    if (has(/\b(attacks?|strikes?|hits?|slash(?:es)?|punch(?:es)?|kicks?)\b.*\b(faster|quicker|snappier)|\b(faster|quicker|snappier)\b.*\b(attacks?|strikes?|hits?)/)) { p.attackSpeed = r3(p.attackSpeed * 1.35); notes.push("attacks 35% faster"); }
    else if (has(/\bfaster|quicker|speed (?:it )?up|snappier|too slow\b/)) { p.speed = r3(p.speed * 1.25); notes.push("overall 25% faster"); }
    if (has(/\bslower|slow (?:it )?down|too fast\b/)) { p.speed = r3(p.speed / 1.25); notes.push("overall 25% slower"); }
    if (has(/anticipation|wind ?up|telegraph/)) { const up = !less; p.anticipation = r3(clamp(p.anticipation * (up ? 1.45 : 0.7), 0.3, 3)); notes.push((up ? "more" : "less") + " anticipation"); }
    if (has(/landing|land|impact|heav(?:y|ier)|weight/)) { const up = !has(/lighter|less heavy|softer/); p.weight = r3(clamp(p.weight * (up ? 1.4 : 0.7), 0.4, 2.5)); notes.push((up ? "heavier" : "lighter") + " landing / weight"); }
    if (has(/exaggerat|bigger|more dramatic|over the top|wilder/)) { p.amplitude = r3(clamp(p.amplitude * 1.25, 0.4, 1.8)); notes.push("bigger poses"); }
    if (has(/subtle|smaller|tone (?:it )?down|calmer|less dramatic/)) { p.amplitude = r3(clamp(p.amplitude * 0.8, 0.4, 1.8)); notes.push("smaller poses"); }
    let quality = clip.quality, duration = clip.intent.duration, loop = clip.loop, fps = clip.fps;
    if (has(/smooth|fluid|less jerky|polish/)) { quality = quality === "fast" ? "balanced" : quality === "balanced" ? "high" : "cinematic"; notes.push("quality → " + quality); }
    if (has(/\blonger\b/) && !has(/anticipation/)) { duration = r3(duration * 1.3); notes.push("30% longer"); }
    if (has(/\bshorter\b/) && !has(/anticipation/)) { duration = r3(duration / 1.3); notes.push("30% shorter"); }
    const dm = f.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\b/); if (dm) { duration = clamp(parseFloat(dm[1]), 0.2, 60); notes.push(`duration ${duration}s`); }
    if (has(/\bloop\b/) && !has(/no loop|stop looping|don't loop|do not loop/)) { loop = true; notes.push("looping"); }
    if (has(/no loop|stop looping|don't loop|do not loop|one[- ]shot/)) { loop = false; notes.push("not looping"); }
    if (has(/variation|different|another take|alternative|variant/)) { p.variation = r3((p.variation || 0) + 0.37); notes.push("new variation"); }
    const intent = JSON.parse(JSON.stringify(clip.intent)); intent.duration = duration;
    if (has(/\badd (?:a )?spin/)) { if (!intent.stages.some((s) => s.kind === "spin")) { const at = Math.max(0, intent.stages.findIndex((s) => s.kind === "land" || s.kind === "recover")); intent.stages.splice(at < 0 ? intent.stages.length : at, 0, { kind: "spin" }); notes.push("added a spin"); } }
    if (has(/\badd (?:a )?(?:landing|land)/) && !intent.stages.some((s) => s.kind === "land")) { const at = intent.stages.findIndex((s) => s.kind === "recover"); intent.stages.splice(at < 0 ? intent.stages.length : at, 0, { kind: "air" }, { kind: "land" }); notes.push("added a landing"); }
    if (!notes.length) notes.push("no recognised adjustment - regenerated with the same settings (try: faster, slower, more anticipation, heavier landing, exaggerate, subtle, smoother, longer, shorter, loop, variation)");
    const out = generate(intent, { quality, rigType: clip.rigType, name: clip.name, fps, loop, params: p, duration, priority: clip.priority });
    out.feedback = (clip.feedback || []).concat([{ text: feedback, applied: notes }]);
    out.previous = { keys: clip.keys.length, duration: clip.duration, score: clip.report && clip.report.score };
    return out;
  }
  function variation(clip, seedDelta) { return applyFeedback(clip, "variation" + (seedDelta ? " " + seedDelta : "")); }

  // ───────────────────────── multi-stage sequences ─────────────────────────
  // Combined clip + one clip per stage group (retimed to start at 0, with the next stage's first key as a settle).
  function generateSequence(text, opts) {
    const combined = generate(text, opts);
    const groups = []; // merge ready+anticipation into the first strike, transition into the preceding strike
    let cur = null;
    for (const s of combined.stages) {
      const own = s.kind === "strike" || s.kind === "spin" || s.kind === "finisher" || s.kind === "air" || s.kind === "cast" || s.kind === "dodge" || s.kind === "block" || s.kind === "cycle" || s.kind === "idle" || s.kind === "emote";
      if (own || !cur) { cur = { name: s.name, kind: s.kind, t0: s.t0, t1: s.t1, stages: [s.name] }; groups.push(cur); } else { cur.t1 = s.t1; cur.stages.push(s.name); cur.name = cur.name + "+" + s.kind; }
    }
    const clips = groups.map((g, i) => {
      const keys = combined.keys.filter((k) => k.t >= g.t0 - 1e-6 && k.t <= g.t1 + 1e-6).map((k) => Object.assign({}, k, { t: r3(k.t - g.t0) }));
      const dur = r3(g.t1 - g.t0);
      if (!keys.length || keys[0].t > 1e-6) keys.unshift({ t: 0, poses: clonePose(sampleAt(combined, g.t0)), ease: ["CubicV2", "InOut"], tag: "start" });
      if (Math.abs(keys[keys.length - 1].t - dur) > 1e-6) keys.push({ t: dur, poses: clonePose(sampleAt(combined, g.t1)), ease: ["CubicV2", "Out"], tag: "end" });
      const c = Object.assign({}, combined, { name: combined.name + "_" + String(i + 1).padStart(2, "0") + "_" + g.kind, keys: dedupeKeys(keys), duration: dur, loop: false, stages: combined.stages.filter((s) => g.stages.includes(s.name)).map((s) => Object.assign({}, s, { t0: r3(s.t0 - g.t0), t1: r3(s.t1 - g.t0) })), part: i + 1, of: groups.length });
      c.report = validate(c);
      return c;
    });
    const transitions = clips.map((c, i) => ({ clip: c.name, from: i ? clips[i - 1].name : null, blend: i ? "cross-fade 0.1s (AnimationTrack:Play(0.1)) from the previous clip's last key" : "play from idle / ready stance", gameplayWindow: c.stages.find((s) => s.kind === "strike" || s.kind === "finisher" || s.kind === "spin") ? "cancel into the next clip after the 'hit' marker" : "uninterruptible" }));
    return { combined, clips, transitions };
  }

  // ───────────────────────── sampling + FK (preview / metrics) ─────────────────────────
  function easeAlpha(a, ease) {
    const [style, dir] = ease || ["CubicV2", "Out"];
    const f = (x) => {
      if (style === "Linear") return x; if (style === "Constant") return x >= 1 ? 1 : 0;
      if (style === "Bounce") { const n1 = 7.5625, d1 = 2.75; if (x < 1 / d1) return n1 * x * x; if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75; if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375; return n1 * (x -= 2.625 / d1) * x + 0.984375; }
      if (style === "Elastic") { const c4 = (2 * Math.PI) / 3; return x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1; }
      return 1 - Math.pow(1 - x, 3); // cubic out
    };
    const out = (x) => f(x), inn = (x) => 1 - f(1 - x);
    if (dir === "In") return inn(a); if (dir === "InOut") return a < 0.5 ? inn(a * 2) / 2 : 0.5 + out(a * 2 - 1) / 2; return out(a);
  }
  function sampleAt(clip, t) {
    const keys = clip.keys; if (!keys.length) return stance(1, "default");
    if (t <= keys[0].t) return keys[0].poses;
    if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].poses;
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].t) { const a = keys[i - 1], b = keys[i]; const alpha = easeAlpha((t - a.t) / Math.max(1e-6, b.t - a.t), a.ease); return mix(a.poses, b.poses, alpha); }
    }
    return keys[keys.length - 1].poses;
  }
  // World positions of every pivot + tips in the semantic frame (studs), root pivot at ROOT_HEIGHT.
  function forwardKinematics(poses) {
    const world = {}; const pts = {};
    const walk = (j, parentR, parentP) => {
      const p = poses[j] || J(0, 0, 0);
      const off = PIVOT[j]; let pivot = [parentP[0] + 0, parentP[1], parentP[2]];
      const offW = mulV(parentR, off); pivot = [parentP[0] + offW[0], parentP[1] + offW[1], parentP[2] + offW[2]];
      if (j === "root" && p.pos) pivot = [pivot[0] + p.pos[0], pivot[1] + p.pos[1], pivot[2] + p.pos[2]];
      else if (p.pos) { const pw = mulV(parentR, p.pos); pivot = [pivot[0] + pw[0], pivot[1] + pw[1], pivot[2] + pw[2]]; }
      const R = mul(parentR, eulerYXZ(p.rot[0], p.rot[1], p.rot[2]));
      world[j] = { R, p: pivot }; pts[j] = pivot;
      if (TIP[j]) { const tw = mulV(R, TIP[j]); pts[j + "_tip"] = [pivot[0] + tw[0], pivot[1] + tw[1], pivot[2] + tw[2]]; }
      for (const c of JOINTS) if (PARENT[c] === j) walk(c, R, pivot);
    };
    walk("root", I3(), [0, ROOT_HEIGHT, 0]);
    return pts;
  }
  function metrics(poses) {
    const pts = forwardKinematics(poses);
    const lf = pts.l_ankle_tip[1], rf = pts.r_ankle_tip[1];
    return { rootY: pts.root[1], footL: lf, footR: rf, footMin: Math.min(lf, rf), handL: pts.l_wrist_tip, handR: pts.r_wrist_tip, head: pts.neck_tip };
  }

  // ───────────────────────── rig adapters / export ─────────────────────────
  // Studio keyframes: [{t, easing:{style,direction}, markers:[{name,value}], poses:[{bone, cf:[x,y,z,r00..r22]}]}]
  function toStudio(clip, rigInfo) {
    rigInfo = rigInfo && rigInfo.bones && rigInfo.bones.length ? rigInfo : defaultRigInfo(clip.rigType);
    const { type, map } = boneMap(rigInfo);
    const c0 = {}; for (const b of rigInfo.bones) c0[b.name] = b.c0 && b.c0.length === 9 ? from9(b.c0) : (type === "R6" && R6_C0[b.name] ? from9(R6_C0[b.name]) : I3());
    const dropped = JOINTS.filter((j) => !map[j]);
    const out = clip.keys.map((key) => {
      const poses = [];
      const sem = foldForRig(key.poses, type);
      for (const j of JOINTS) {
        const bone = map[j]; if (!bone) continue;
        const p = sem[j] || J(0, 0, 0);
        const M = c0[bone] || I3(), Mt = transpose(M);
        const R = eulerYXZ(p.rot[0], p.rot[1], p.rot[2]);
        const T = mul(mul(Mt, R), M);
        const pos = p.pos ? mulV(Mt, p.pos) : [0, 0, 0];
        poses.push({ bone, cf: [r3(pos[0]), r3(pos[1]), r3(pos[2])].concat(flat(T).map((v) => Math.round(v * 1e6) / 1e6)) });
      }
      const markers = []; const st = (clip.stages || []).find((s) => Math.abs(s.t0 - key.t) < 1e-6 && s.marker);
      if (st) markers.push({ name: st.marker, value: st.name });
      if (key.tag === "impact") markers.push({ name: "impact", value: key.stage || "" });
      return { t: key.t, easing: { style: (key.ease || ["CubicV2", "Out"])[0], direction: (key.ease || ["CubicV2", "Out"])[1] }, markers, poses };
    });
    return { rigType: type, keyframes: out, bones: JOINTS.filter((j) => map[j]).map((j) => map[j]), dropped, rootBone: rigInfo.bones.find((b) => !rigInfo.bones.some((x) => x.name === b.parent)) ? (rigInfo.bones.find((b) => !rigInfo.bones.some((x) => x.name === b.parent)) || {}).parent || "HumanoidRootPart" : "HumanoidRootPart" };
  }
  // Compact payload for the Studio-side `build` op (animlib.js api.build): bone names once, per key
  // [rx,ry,rz(,px,py,pz)] in the semantic (parent-frame) convention - Studio conjugates with the real C0.
  function toBuildArgs(clip, rigInfo, opts) {
    opts = opts || {};
    rigInfo = rigInfo && rigInfo.bones && rigInfo.bones.length ? rigInfo : defaultRigInfo(clip.rigType);
    const { type, map } = boneMap(rigInfo);
    const joints = JOINTS.filter((j) => map[j]);
    const r2 = (n) => Math.round(n * 100) / 100;
    const keys = clip.keys.map((key) => {
      const sem = foldForRig(key.poses, type);
      const p = joints.map((j) => { const q = sem[j] || J(0, 0, 0); const arr = [r2(q.rot[0]), r2(q.rot[1]), r2(q.rot[2])]; if (q.pos && (q.pos[0] || q.pos[1] || q.pos[2])) arr.push(r3(q.pos[0]), r3(q.pos[1]), r3(q.pos[2])); return arr; });
      const m = []; const st = (clip.stages || []).find((s) => Math.abs(s.t0 - key.t) < 1e-6 && s.marker); if (st) m.push([st.marker, st.name]); if (key.tag === "impact") m.push(["impact", key.stage || ""]);
      return { t: key.t, e: key.ease || ["CubicV2", "Out"], m, p };
    });
    return { name: clip.name, duration: clip.duration, loop: !!clip.loop, priority: clip.priority || "Action", fps: clip.fps, prompt: clip.prompt || "", quality: clip.quality || "balanced", params: JSON.stringify(clip.params || {}), engine: VERSION, overwrite: opts.overwrite !== false, anim_saves: opts.animSaves !== false, bones: joints.map((j) => map[j]), keys, rigType: type, dropped: JOINTS.filter((j) => !map[j]) };
  }
  // R6 has no elbows/knees/waist: fold them so the silhouette survives.
  function foldForRig(poses, type) {
    if (type !== "R6") return poses;
    const p = clonePose(poses);
    const w = p.waist || J(0, 0, 0), rt = p.root || J(0, 0, 0);
    const Rr = mul(eulerYXZ(rt.rot[0], rt.rot[1], rt.rot[2]), eulerYXZ(w.rot[0], w.rot[1], w.rot[2]));
    p.root = { rot: toEulerYXZ(Rr).map(r3), pos: rt.pos || [0, 0, 0] };
    for (const side of ["l", "r"]) {
      const s = p[side + "_shoulder"] || J(0, 0, 0), e = p[side + "_elbow"] || J(0, 0, 0);
      p[side + "_shoulder"] = { rot: [s.rot[0] + e.rot[0] * 0.5, s.rot[1], s.rot[2]] };
      const h = p[side + "_hip"] || J(0, 0, 0), k = p[side + "_knee"] || J(0, 0, 0);
      p[side + "_hip"] = { rot: [h.rot[0] + k.rot[0] * 0.5, h.rot[1], h.rot[2]] };
    }
    return p;
  }
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function toRbxmx(clip, rigInfo) {
    rigInfo = rigInfo && rigInfo.bones && rigInfo.bones.length ? rigInfo : defaultRigInfo(clip.rigType);
    const studio = toStudio(clip, rigInfo);
    const parentOf = {}; for (const b of rigInfo.bones) parentOf[b.name] = b.parent;
    const rootName = studio.rootBone || "HumanoidRootPart";
    let ref = 0; const nextRef = () => "RBX" + (ref++).toString(16).toUpperCase().padStart(8, "0");
    const cfXml = (cf) => `<CoordinateFrame name="CFrame"><X>${cf[0]}</X><Y>${cf[1]}</Y><Z>${cf[2]}</Z><R00>${cf[3]}</R00><R01>${cf[4]}</R01><R02>${cf[5]}</R02><R10>${cf[6]}</R10><R11>${cf[7]}</R11><R12>${cf[8]}</R12><R20>${cf[9]}</R20><R21>${cf[10]}</R21><R22>${cf[11]}</R22></CoordinateFrame>`;
    const lines = [];
    lines.push('<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">');
    lines.push(`<Item class="KeyframeSequence" referent="${nextRef()}"><Properties><bool name="Loop">${clip.loop ? "true" : "false"}</bool><string name="Name">${xmlEsc(clip.name)}</string><token name="Priority">${PRIORITY_TOKEN[clip.priority] != null ? PRIORITY_TOKEN[clip.priority] : 2}</token></Properties>`);
    for (const kf of studio.keyframes) {
      lines.push(`<Item class="Keyframe" referent="${nextRef()}"><Properties><string name="Name">Keyframe</string><float name="Time">${kf.t}</float></Properties>`);
      const byBone = {}; for (const p of kf.poses) byBone[p.bone] = p;
      const children = (parent) => rigInfo.bones.filter((b) => b.parent === parent).map((b) => b.name);
      const emit = (bone, cf) => {
        lines.push(`<Item class="Pose" referent="${nextRef()}"><Properties>${cfXml(cf)}<token name="EasingDirection">${DIRECTION_TOKEN[kf.easing.direction] != null ? DIRECTION_TOKEN[kf.easing.direction] : 1}</token><token name="EasingStyle">${EASING_TOKEN[kf.easing.style] != null ? EASING_TOKEN[kf.easing.style] : 5}</token><string name="Name">${xmlEsc(bone)}</string><float name="Weight">1</float></Properties>`);
        for (const c of children(bone)) emit(c, byBone[c] ? byBone[c].cf : [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
        lines.push("</Item>");
      };
      emit(rootName, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
      for (const m of kf.markers) lines.push(`<Item class="KeyframeMarker" referent="${nextRef()}"><Properties><string name="Name">${xmlEsc(m.name)}</string><string name="Value">${xmlEsc(m.value || "")}</string></Properties></Item>`);
      lines.push("</Item>");
    }
    lines.push("</Item></roblox>");
    return lines.join("\n");
  }
  // Project file (editable): the clip itself is the project.
  function serializeProject(clip) { return JSON.stringify({ format: "orscript-animation", version: 1, engine: VERSION, clip }, null, 0); }
  function parseProject(text) {
    const j = typeof text === "string" ? JSON.parse(text) : text;
    const clip = j && j.format === "orscript-animation" ? j.clip : (j && j.keys ? j : null);
    if (!clip || !Array.isArray(clip.keys) || !(clip.duration > 0)) throw new Error("not an ORscript animation project (expected {format:'orscript-animation', clip:{keys, duration}})");
    clip.keys = dedupeKeys(clip.keys);
    clip.report = validate(clip);
    return clip;
  }
  // Timing edits used by the editor
  function retime(clip, newDuration) { const s = newDuration / clip.duration; const c = JSON.parse(JSON.stringify(clip)); c.duration = r3(newDuration); c.keys = c.keys.map((k) => Object.assign({}, k, { t: r3(k.t * s) })); c.stages = (c.stages || []).map((st) => Object.assign({}, st, { t0: r3(st.t0 * s), t1: r3(st.t1 * s) })); c.edited = true; c.report = validate(c); return c; }
  function moveKey(clip, index, t) { const c = JSON.parse(JSON.stringify(clip)); if (!c.keys[index]) return c; c.keys[index].t = r3(clamp(t, 0, c.duration)); c.keys = dedupeKeys(c.keys); c.edited = true; c.report = validate(c); return c; }
  function setJoint(clip, index, joint, rot, pos) { const c = JSON.parse(JSON.stringify(clip)); const k = c.keys[index]; if (!k || !JOINTS.includes(joint)) return c; k.poses[joint] = Object.assign({}, k.poses[joint] || {}, rot ? { rot: rot.map(Number) } : {}, pos ? { pos: pos.map(Number) } : {}); c.edited = true; c.report = validate(c); return c; }
  function duplicateKey(clip, index) { const c = JSON.parse(JSON.stringify(clip)); const k = c.keys[index]; if (!k) return c; const step = 1 / c.fps; const t = r3(Math.min(c.duration, k.t + step)); c.keys.push({ t, poses: clonePose(k.poses), ease: k.ease, tag: "copy" }); c.keys = dedupeKeys(c.keys); c.edited = true; c.report = validate(c); return c; }
  function deleteKey(clip, index) { const c = JSON.parse(JSON.stringify(clip)); if (c.keys.length <= 2) return c; c.keys.splice(index, 1); c.edited = true; c.report = validate(c); return c; }
  function compare(a, b) { // before/after summary
    const n = Math.min(a.keys.length, b.keys.length); let maxD = 0, joint = null;
    for (let i = 0; i < 40; i++) { const t = (i / 39) * Math.min(a.duration, b.duration); const pa = sampleAt(a, t), pb = sampleAt(b, t); for (const j of JOINTS) { const d = Math.max(...[0, 1, 2].map((x) => Math.abs((pa[j] || J(0, 0, 0)).rot[x] - (pb[j] || J(0, 0, 0)).rot[x]))); if (d > maxD) { maxD = d; joint = j; } } }
    return { keysBefore: a.keys.length, keysAfter: b.keys.length, durationBefore: a.duration, durationAfter: b.duration, scoreBefore: a.report && a.report.score, scoreAfter: b.report && b.report.score, largestChange: { joint, degrees: Math.round(maxD) }, sharedKeys: n };
  }
  function summary(clip) {
    const r = clip.report || validate(clip);
    const lines = [`${clip.name}: ${clip.duration}s, ${clip.keys.length} keys @ ${clip.fps} fps, ${clip.rigType}, ${clip.loop ? "looping" : "one-shot"}, priority ${clip.priority}, quality ${clip.quality}`];
    if (clip.stages && clip.stages.length > 1) lines.push("stages: " + clip.stages.map((s) => `${s.name} ${s.t0}-${s.t1}s`).join(" · "));
    lines.push(`validation: ${r.ok ? "OK" : "ERRORS"} score ${r.score}/100 (${r.errors} errors, ${r.warnings} warnings)` + (clip.fixes && clip.fixes.length ? "; auto-fixes: " + clip.fixes.join("; ") : ""));
    const top = r.issues.filter((i) => i.level !== "info").slice(0, 6).map((i) => "- " + i.msg); if (top.length) lines.push(...top);
    if (clip.limitations && clip.limitations.length) lines.push("limitations: " + clip.limitations.join(" | "));
    return lines.join("\n");
  }

  const api = { VERSION, JOINTS, PARENT, PIVOT, LIMITS, QUALITY, R15_BONES, R6_BONES, R6_C0, PRIORITY_TOKEN, EASING_TOKEN, parseIntent, generate, generateSequence, validate, refine, applyFeedback, variation, toStudio, toBuildArgs, toRbxmx, defaultRigInfo, detectRigType, boneMap, sampleAt, forwardKinematics, metrics, serializeProject, parseProject, retime, moveKey, setJoint, duplicateKey, deleteKey, compare, summary, math: { eulerYXZ, toEulerYXZ, mul, transpose, mulV, flat, from9 } };
  root.ORAnimEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
