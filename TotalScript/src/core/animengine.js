// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/animengine.js - TotalScript ANIMATION ENGINE (1.52.0; 1.53.0 persona / choreography / uniqueness / mirror / travel; 1.55.0 freeform choreography; 1.54.0 smoothing / foot planting / IK / layering / Blender-style key tools)
//
// Natural language → structured, validated Roblox animation data.
//
//   intent  = TotalAnimEngine.parseIntent("extremely fluid anime sword combo with
//             anticipation, rapid strikes, a spinning finisher and a dramatic landing")
//   clip    = TotalAnimEngine.generate(intent, { rigType: "R15", quality: "high" })
//   report  = TotalAnimEngine.validate(clip)            // objective checks
//   clip2   = TotalAnimEngine.applyFeedback(clip, "make the attacks faster, heavier landing")
//   studio  = TotalAnimEngine.toStudio(clip, rigInfo)   // keyframes with per-bone CFrames
//   xml     = TotalAnimEngine.toRbxmx(clip, rigInfo)    // KeyframeSequence .rbxmx
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
  const VERSION = "1.77.0";
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
  // Root pivot above the ground = the schematic leg (hip 0.2 + thigh 0.75 + shin 0.75 + sole 0.15 = 1.85) so a straight
  // standing leg touches y = 0. 1.52–1.55 had 2.35 here: every standing pose "floated" 0.5 studs in the model, so the
  // 1.54 plant-feet pass sank the ROOT of every grounded clip by 0.5 studs - exported 1:1 to Studio, where the character
  // then stood knee-deep in the floor while airborne clips (which skip planting) did not. That was the single biggest
  // "looks wrong in Studio" cause (1.56 fix). Lying / sitting poses are expressed relative to this constant, so they keep
  // their absolute height.
  const ROOT_HEIGHT = 1.85;
  // Joint limits (degrees, semantic frame). x: flex (+ = forward swing for limbs, + = lean back for torso), y: twist, z: roll/abduction.
  const LIMITS = {
    root: { x: [-1800, 1800], y: [-1800, 1800], z: [-45, 45] }, /* root pitch is free too (flips, lying down) */ waist: { x: [-50, 50], y: [-70, 70], z: [-35, 35] }, neck: { x: [-50, 50], y: [-85, 85], z: [-35, 35] },
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
    idle: WORD("idle|breath(?:e|ing)|stand(?:ing)?|rest(?:ing)? pose|stance only"), walk: WORD("walk(?:ing|s)?|stroll(?:ing)?|march(?:ing)?|strut(?:ting)?|shambl(?:e|es|ing)|shuffl(?:e|es|ing)|trudg(?:e|es|ing)|wander(?:s|ing)?|stumbl(?:e|es|ing)|hobbl(?:e|es|ing)|limp(?:s|ing)? (?:along|around|forward)|stagger(?:s|ing)? (?:along|around|forward)|pac(?:e|es|ing)|hik(?:e|es|ing)|patrol(?:s|ling)?|skip(?:s|ping)?|prowl(?:s|ing)?|tiptoe(?:s|ing)?"), run: WORD("run(?:ning|s)?|sprint(?:ing)?|jog(?:ging)?|dash(?:ing)?"),
    jump: WORD("jump(?:ing|s)?|leap(?:ing)?|hop(?:ping)?"), fall: WORD("fall(?:ing)?|freefall"), land: WORD("land(?:ing)?|touchdown"), climb: WORD("climb(?:ing)?|ladder"), swim: WORD("swim(?:ming)?"),
    crouch: WORD("crouch(?:ing)?|sneak(?:ing)?|stealth"), sit: WORD("sit(?:ting)?|seated"), wave: WORD("wave|waving|greet(?:ing)?|hello"), cheer: WORD("cheer(?:ing)?|celebrat(?:e|ion)|victory"), dance: WORD("danc(?:e|ing)"), point: WORD("point(?:ing)?"), clap: WORD("clap(?:ping)?|applau(?:d|se)"), laugh: WORD("laugh(?:ing)?"), bow: WORD("bow(?:ing)?"),
    sword: WORD("sword|katana|blade|slash(?:es|ing)?|saber|sabre|greatsword|axe|scythe|spear|staff|swing(?:s|ing)?"), slam: WORD("slam|smash|pound|ground ?pound|crush"), attack: WORD("attack(?:s|ing)?|strike(?:s)?|hit(?:s)?|melee|fight(?:ing)?"), punch: WORD("punch(?:es|ing)?|jab|hook|uppercut|fist|boxing|haymaker"), kick: WORD("kick(?:s|ing)?|roundhouse"), thrust: WORD("thrust|stab|lunge|pierce"), spin: WORD("spin(?:ning)?|whirl(?:ing|wind)?|pirouette|tornado|360"),
    finisher: WORD("finisher|finishing (?:strike|blow|move)|final (?:strike|blow)|ultimate"), dodge: WORD("dodge|roll(?:ing)?|evade|sidestep"), block: WORD("block(?:ing)?|guard|parry|parrying|deflect"), cast: WORD("cast(?:ing)?|spell|magic|fireball|summon|charge up|energy|beam|ki blast|kamehameha"), transform: WORD("transform(?:ation)?|power ?up|awaken(?:ing)?|super saiyan|rage mode"),
    combo: WORD("combo|combination|chain|sequence|string"), anticipation: WORD("anticipation|wind ?up|charge|ready|telegraph"), recover: WORD("recover(?:y)?|settle"),
    anime: WORD("anime|shonen|exaggerated|flashy|stylized|stylised|dramatic"), realistic: WORD("realistic|grounded|natural|mocap|lifelike|subtle"), cartoony: WORD("cartoon(?:y|ish)?|bouncy|goofy|silly|squash"), heavy: WORD("heavy|massive|giant|boss|brute|slow and powerful|weighty"), fluid: WORD("fluid|smooth|flowing|graceful|elegant"), robotic: WORD("robot(?:ic)?|mechanical|stiff|rigid"), zombie: WORD("zombie|undead|shambl(?:e|ing)|monster|creature|beast|hunched"), cute: WORD("cute|pet|puppy|kitten|chibi|tiny"), ninja: WORD("ninja|assassin|agile|acrobatic"),
    fast: WORD("fast(?:er)?|fast[- ]paced|rapid(?:ly)?|quick(?:ly)?|speedy|brisk(?:ly)?|hasty|hurried|in a hurry|up[- ]tempo|high[- ]tempo|snappy|explosive|lightning|blazing"), slow: WORD("slow(?:ly|er)?|slow[- ]?mo(?:tion)?|slo[- ]mo|slow[- ]paced|sluggish|leisurely|unhurried|languid|lethargic|laid[- ]back|gentle|calm|lazy|relaxed|tired"), extreme: WORD("extremely|insanely|super|ultra|incredibly|very"),
    loop: WORD("loop(?:ing|ed|s)?|cycle|seamless|repeat(?:ing)?"), noloop: WORD("one[- ]shot|once|no loop|non[- ]looping"),
    upper: WORD("upper[- ]body(?: only)?|arms only|torso only"), facial: WORD("facial|face|expression|smile|frown|blink|lip[- ]?sync|eyebrow"),
    r6: WORD("r6"), r15: WORD("r15"), twohand: WORD("two[- ]hand(?:ed)?|greatsword|both hands"),
    qFast: WORD("fast preset|draft|rough|quick preview|low quality"), qHigh: WORD("high[- ]quality|polished|detailed|refined"), qCine: WORD("cinematic|film|cutscene|trailer"),
    // 1.53 additions
    hit: WORD("hit reaction|hit react|flinch|stagger(?:ing)?|take damage|taking damage|damaged|hurt|get(?:s|ting)? hit|got hit|wince|recoil from|hit from (?:the )?(?:front|back|behind|left|right|side)|hit in the|struck|takes? a (?:punch|blow)"), knockback: WORD("knock(?:ed)? ?back|knockdown|blown back|launched back|sent flying"),
    death: WORD("death|die(?:s)?|dying|collapse(?:s)?|defeated|k\\.?o\\.?|knocked out|faint(?:s|ing)?|pass(?:es)? out|ragdoll"),
    dash: WORD("dash(?:es|ing)?|blink step|burst forward|lunge forward|zoom forward"), slide: WORD("slide|sliding|baseball slide|power slide|slide tackle"),
    flip: WORD("back ?flip|front ?flip|somersault|flip(?:s|ping)?|cartwheel|aerial"), throwing: WORD("throw(?:s|ing)?|toss(?:es|ing)?|hurl(?:s|ing)?|grenade|lob(?:s|bing)?|pitch(?:es|ing)?"),
    shoot: WORD("shoot(?:s|ing)?|fire(?:s|ing)? (?:a |the )?(?:gun|pistol|rifle|weapon|shot|shots)|gun(?:fire)?|pistol|rifle|shotgun|blaster|aim(?:s|ing)?|reload(?:s|ing)?|recoil"),
    archery: WORD("archer(?:y)?|bow and arrow|draw(?:s|ing)? (?:the |a |my )?bow|arrow(?:s)?|longbow|crossbow"),
    pickup: WORD("pick(?:s|ing)? ?up|pickup|grab(?:s|bing)? (?:an? |the )?(?:item|object|coin|loot|sword|weapon|box|it)|loot(?:s|ing)?|collect(?:s|ing)?"),
    kneel: WORD("kneel(?:s|ing)?|on one knee|propos(?:e|al|ing)|pray(?:s|ing|er)?|genuflect"),
    salute: WORD("salute(?:s|ing)?|military greeting"), facepalm: WORD("face ?palm|disappointed|ugh"), shrug: WORD("shrug(?:s|ging)?|i don't know|dunno"), taunt: WORD("taunt(?:s|ing)?|come at me|mock(?:s|ing)?|bring it|provoke"),
    nod: WORD("nod(?:s|ding)?|say(?:s|ing)? yes|agree(?:s|ing)?"), headshake: WORD("shake(?:s)? (?:the |their |his |her )?head|say(?:s|ing)? no|disagree(?:s|ing)?|no no"),
    fly: WORD("fly(?:ing)?|hover(?:ing)?|levitat(?:e|ing)|float(?:ing)? in (?:the )?air|superhero flight|flight"), crawl: WORD("crawl(?:s|ing)?|prone|army crawl"),
    sneak: WORD("sneak(?:ing)? walk|stealth walk|crouch(?:ed|ing)? walk|tip ?toe(?:ing)?|creep(?:ing)?"), strafe: WORD("strafe|strafing|side ?step(?:ping)? cycle|shuffle sideways"), backward: WORD("backwards?|reverse walk|moonwalk|retreat(?:ing)?"),
    pushup: WORD("push ?ups?|press ?ups?"), sleep: WORD("sleep(?:ing)?|lie(?:s)? down|lying down|nap(?:ping)?|asleep|knocked out cold"), tread: WORD("tread(?:ing)? water|swim idle|float(?:ing)? in (?:the )?water|water idle"),
    both: WORD("both hands|two hands|two[- ]handed wave|double"), small: WORD("small|tiny|shy|timid|slight|little"), big: WORD("big|huge|wide|enthusiastic|energetic|excited"),
    fistpump: WORD("fist ?pump|pump(?:s|ing)? (?:the |their )?fist"), sky: WORD("point(?:s|ing)? up|at the sky|to the sky|skyward|upwards|point(?:s|ing)? overhead"), side: WORD("to the side|sideways|left|right"),
    mirror: WORD("mirror(?:ed)?|flip(?:ped)? horizontally|other hand|opposite side"), travel: WORD("moving forward|root motion|travel(?:s|ling|ing)? forward|advance(?:s|ing)?|with displacement|covers ground"),
    left: WORD("left[- ]handed|lefty|with the left (?:hand|arm|foot|leg)|left hand|left arm|left leg|left foot"),
  };
  const NUMWORD = { one: 1, two: 2, double: 2, twice: 2, three: 3, triple: 3, four: 4, quad: 4, five: 5, six: 6, seven: 7, eight: 8 };
  function countOf(text, noun) {
    const m = text.match(new RegExp("\\b(\\d+|one|two|three|four|five|six|seven|eight|double|triple|quad)[- ](?:hit|strike|slash|punch|kick|part|stage|step)?\\s*(?:" + noun + ")", "i"));
    if (!m) return null; const v = m[1].toLowerCase(); return NUMWORD[v] || parseInt(v, 10) || null;
  }
  function parseIntent(text) {
    const raw = String(text || "").trim();
    const ex = expandVocabulary(raw); // 1.61: synonyms / implied objects → known vocabulary ("guzzle a beer" → drink)
    const t = ex.text;
    const has = (k) => RE[k].test(t);
    const intent = { text: t, category: "idle", action: null, style: "default", intensity: 1, speed: 1, loop: null, duration: null, stages: [], weapon: null, hands: 2, rigHint: null, quality: null, upperOnly: has("upper"), unsupported: [], seed: hashStr(raw), take: 0, swaps: ex.swaps, rawText: raw, mirror: has("mirror") || has("left"), travel: has("travel") };
    // 1.55 freeform layer: everyday / sport / work / social acts, mood overlays, pose grammar, repeats
    const actsFound = findActs(t), exAct = actsFound.find((a) => a.ex), moodFound = findMood(t);
    intent.acts = actsFound.map((a) => a.name); intent.mood = moodFound ? moodFound.name : null; intent.repeat = repeatCount(t); intent.gesture = posePhrase(t) || (actsFound.length ? null : classGesture(t)); // 1.61: unknown motion verbs → body-region primitives
    if (moodFound && moodFound.slow) intent.speed *= moodFound.slow; if (moodFound && moodFound.fast) intent.speed *= moodFound.fast;
    intent.variantHints = { both: has("both"), small: has("small"), big: has("big"), fistpump: has("fistpump"), sky: has("sky"), side: has("side"), slow: has("slow"), twoShots: /\b(two|double|2) shots?\b|double tap/i.test(t), burst: /\bburst|full auto|spray\b/i.test(t) };
    if (has("facial")) intent.unsupported.push("facial expressions (FaceControls) - this engine animates Motor6D joints; the face is left untouched");
    if (has("r6")) intent.rigHint = "R6"; if (has("r15")) intent.rigHint = "R15";
    intent.quality = has("qCine") ? "cinematic" : has("qHigh") ? "high" : has("qFast") ? "fast" : null;
    // style
    const styles = ["anime", "realistic", "cartoony", "heavy", "fluid", "robotic", "zombie", "cute", "ninja"];
    intent.styles = styles.filter((s) => has(s));
    intent.style = intent.styles[0] || "default";
    if (has("extreme")) intent.intensity += 0.3;
    // 1.58 tempo words with magnitude: "fast" ×1.25, "very fast" ×1.5; "slow" ×0.75, "very slow" ×0.6, "slow motion" ×0.45
    if (has("fast")) { intent.speed *= has("extreme") ? 1.5 : 1.25; intent.intensity += 0.15; }
    if (has("slow")) { intent.speed *= /\bslow[- ]?mo(?:tion)?\b|\bslo[- ]mo\b/i.test(t) ? 0.45 : has("extreme") ? 0.6 : 0.75; }
    if (intent.style === "heavy") intent.speed *= 0.85;
    if (intent.style === "anime") intent.intensity += 0.2;
    if (intent.style === "realistic") intent.intensity -= 0.2;
    intent.intensity = clamp(intent.intensity, 0.5, 1.6);
    const dm = t.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/i); if (dm) { intent.duration = clamp(parseFloat(dm[1]), 0.2, 60); intent.durationExplicit = true; }
    // category
    const combat = !has("hit") && !has("fistpump") && !has("knockback") && !has("death") && !has("archery") && !has("shoot") && !has("throwing") && (has("sword") || has("punch") || has("kick") || has("thrust") || has("combo") || has("finisher") || has("slam") || has("attack") || has("spin") && (has("sword") || has("combo")));
    if (exAct) { intent.category = "act"; intent.loop = actsFound.length === 1 ? !!exAct.loop : false; }
    else if (combat) {
      intent.category = "attack";
      intent.weapon = has("sword") ? "sword" : has("kick") ? "kick" : has("punch") ? "punch" : has("thrust") ? "thrust" : has("slam") ? "slam" : "punch";
      if (has("twohand") || intent.weapon === "slam") intent.hands = 2; else if (intent.weapon === "sword") intent.hands = 1;
      const named = explicitStrikes(intent.weapon, t).length; // "overhead then thrust" = 2 strikes even without a number
      const strikes = countOf(t, "combo|strikes?|hits?|slash(?:es)?|punch(?:es)?|kicks?") || Math.max(has("combo") ? 3 : 1, named);
      const seq = [{ kind: "ready" }];
      if (has("anticipation") || strikes > 1 || intent.style === "anime" || intent.style === "heavy") seq.push({ kind: "anticipation" });
      const dirs = choreograph(intent.weapon, Math.min(Math.max(strikes, 1), 8), t, intent.seed);
      for (let i = 0; i < dirs.length; i++) { seq.push({ kind: "strike", variant: dirs[i], index: i }); if (i < dirs.length - 1) seq.push({ kind: "transition" }); }
      if (has("spin")) seq.push({ kind: "spin" });
      if (has("finisher") && !has("spin")) seq.push({ kind: "finisher" });
      if (has("jump") || has("spin") && has("land")) seq.push({ kind: "air" });
      if (has("land")) seq.push({ kind: "land" });
      seq.push({ kind: "recover" });
      intent.stages = seq;
      intent.loop = false;
    } else if (has("knockback")) { intent.category = "knockback"; intent.loop = false; intent.stages = [{ kind: "hit", variant: "front" }, { kind: "air" }, { kind: "land" }, { kind: "recover" }]; intent.hitDir = "front"; }
    else if (has("death")) { intent.category = "death"; intent.loop = false; intent.deathDir = /forward|face ?first|face down|on (?:the|their) face/i.test(t) ? "forward" : "back"; intent.stages = [{ kind: "hit", variant: "front" }, { kind: "fall" }, { kind: "still" }]; }
    else if (has("hit")) { intent.category = "hit_react"; intent.loop = false; intent.hitDir = /from (?:the )?left|left side/i.test(t) ? "left" : /from (?:the )?right|right side/i.test(t) ? "right" : /from behind|from (?:the )?back|in the back/i.test(t) ? "back" : "front"; intent.stages = [{ kind: "hit", variant: intent.hitDir }, { kind: "recover" }]; }
    else if (has("archery")) { intent.category = "archery"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "draw" }, { kind: "release" }, { kind: "recover" }]; }
    else if (has("shoot")) { const shots = intent.variantHints.burst ? 4 : intent.variantHints.twoShots ? 2 : countOf(t, "shots?|rounds?|bullets?") || 1; intent.category = /\baim(?:ing)? (?:idle|pose|loop)|aim idle|aiming only|just aim/i.test(t) ? "aim" : "shoot"; intent.loop = intent.category === "aim"; intent.shots = clamp(shots, 1, 6); if (intent.category === "shoot") { intent.stages = [{ kind: "ready" }, { kind: "aimup" }]; for (let i = 0; i < intent.shots; i++) intent.stages.push({ kind: "shot", index: i }); intent.stages.push({ kind: "recover" }); } }
    else if (has("throwing")) { intent.category = "throw"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "anticipation" }, { kind: "throw" }, { kind: "recover" }]; }
    else if (has("flip")) { intent.category = "flip"; intent.loop = false; intent.flipDir = /front|forward/i.test(t) ? "front" : "back"; intent.stages = [{ kind: "ready" }, { kind: "anticipation" }, { kind: "flip" }, { kind: "land" }, { kind: "recover" }]; }
    else if (has("dash")) { intent.category = "dash"; intent.loop = false; intent.travel = true; intent.stages = [{ kind: "ready" }, { kind: "anticipation" }, { kind: "dash" }, { kind: "recover" }]; }
    else if (has("slide")) { intent.category = "slide"; intent.loop = false; intent.travel = true; intent.stages = [{ kind: "ready" }, { kind: "slide" }, { kind: "recover" }]; }
    else if (has("pickup")) { intent.category = "pickup"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "pickup" }, { kind: "recover" }]; }
    else if (has("dodge")) { intent.category = "dodge"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "dodge" }, { kind: "recover" }]; }
    else if (has("block")) { intent.category = "block"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "block" }, { kind: "recover" }]; }
    else if (has("cast") || has("transform")) { intent.category = has("transform") ? "transform" : "cast"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "anticipation" }, { kind: "cast" }, { kind: "recover" }]; }
    else if (has("pushup")) { intent.category = "pushup"; intent.loop = true; }
    else if (has("crawl")) { intent.category = "crawl"; intent.loop = true; }
    else if (has("sneak")) { intent.category = "sneak"; intent.loop = true; }
    else if (has("strafe")) { intent.category = "strafe"; intent.loop = true; intent.strafeDir = /right/i.test(t) ? 1 : -1; }
    else if (has("backward") && (has("walk") || has("run") || !has("idle"))) { intent.category = "walk_back"; intent.loop = true; }
    else if (has("run")) { intent.category = "run"; intent.loop = true; }
    else if (has("walk")) { intent.category = "walk"; intent.loop = true; }
    else if (has("tread")) { intent.category = "tread"; intent.loop = true; }
    else if (has("fly")) { intent.category = "fly"; intent.loop = true; }
    else if (has("sleep")) { intent.category = "sleep"; intent.loop = true; }
    else if (has("kneel")) { intent.category = "kneel"; intent.loop = true; }
    else if (has("swim")) { intent.category = "swim"; intent.loop = true; }
    else if (has("climb")) { intent.category = "climb"; intent.loop = true; }
    else if (has("jump") || has("fall")) { intent.category = "jump"; intent.loop = false; intent.stages = [{ kind: "ready" }, { kind: "anticipation" }, { kind: "air" }, { kind: "land" }, { kind: "recover" }]; }
    else if (has("land")) { intent.category = "land"; intent.loop = false; intent.stages = [{ kind: "air" }, { kind: "land" }, { kind: "recover" }]; }
    else if (has("wave") || has("cheer") || has("dance") || has("point") || has("clap") || has("laugh") || has("bow") || has("salute") || has("facepalm") || has("shrug") || has("taunt") || has("nod") || has("headshake")) { intent.category = "emote"; intent.action = ["salute", "facepalm", "shrug", "taunt", "nod", "headshake", "wave", "cheer", "dance", "point", "clap", "laugh", "bow"].find((k) => has(k)); intent.loop = has("dance") || has("laugh"); }
    else if (has("sit")) { intent.category = "sit"; intent.loop = true; }
    else if (has("crouch")) { intent.category = "crouch"; intent.loop = true; }
    else { intent.category = "idle"; intent.loop = true; intent.fallback = !has("idle"); }
    if (intent.category === "idle" && actsFound.length) { intent.category = "act"; intent.loop = actsFound.length === 1 ? !!actsFound[0].loop : false; }
    if (intent.category === "act" && intent.repeat > 1 && actsFound.length === 1 && actsFound[0].loop) intent.loop = false;
    else if (intent.category === "idle" && intent.fallback && intent.gesture) { intent.category = "gesture"; intent.loop = !!intent.gesture.oscillate; intent.mirror = has("mirror"); if (intent.gesture.synth) { intent.synth = true; intent.unsupported.push(`interpreted ${intent.gesture.hits.join(" + ")} - not in the act lexicon, so the motion comes from the body-region primitive. Name a part / direction ("with the left arm", "forward") or a mood to steer it.`); if (intent.gesture.fast) intent.speed *= 1.3; } } // sides are already in the pose grammar - "left arm" must not also mirror
    else if (intent.category === "idle" && intent.fallback && !moodFound && t.replace(/[^a-z]/gi, "").length >= 3) { intent.category = "improv"; intent.loop = false; intent.improv = improvise(intent.seed, 3).map((a) => a.name); intent.unsupported.push(`no known motion in "${t.slice(0, 60)}" - improvised ${intent.improv.join(" → ")} from the prompt's seed. Use motion verbs (drink, dig, wave, kick, dance, climb, "raise the left arm", "A then B") or a mood (tired, proud, drunk) to steer it.`); }
    // "wave while walking" / "drink coffee while running": upper body from the act / emote, legs from the cycle
    const locoM = t.match(/\b(walk(?:ing)?|run(?:ning)?|jog(?:ging)?|sneak(?:ing)?|march(?:ing)?|strafe|strafing)\b/i);
    if (locoM && !exAct && /\b(while|whilst|as|during|and)\b/i.test(t) && /^(walk|run|sneak|strafe|walk_back|act|emote|gesture)$/.test(intent.category)) {
      const stripped = t.replace(/\b(while|whilst|as|during)\s+(?:he |she |they |i )?(?:is |are |am )?(?:walk(?:ing)?|run(?:ning)?|jog(?:ging)?|sneak(?:ing)?|march(?:ing)?|strafe|strafing)\b/i, "").replace(/\b(walk(?:ing)?|run(?:ning)?|jog(?:ging)?|sneak(?:ing)?|march(?:ing)?|strafe|strafing)\b/i, "").replace(/\b(while|whilst|during)\b/i, "").replace(/\s+/g, " ").trim();
      const upper = stripped.length >= 3 ? parseIntent(stripped) : null;
      if (upper && /^(act|emote|gesture)$/.test(upper.category) && !upper.layerOn) { const w = locoM[1].toLowerCase(); intent.layerOn = /^run|^jog/.test(w) ? "run" : /^sneak/.test(w) ? "sneak" : /^strafe/.test(w) ? "strafe" : "walk"; intent.upperText = stripped; intent.category = intent.layerOn; intent.loop = true; }
    }
    if (has("loop")) intent.loop = true; if (has("noloop")) intent.loop = false;
    if (intent.duration == null) intent.duration = defaultDuration(intent);
    intent.priority = /^(idle|sit|crouch|kneel|sleep|fly|tread|aim)$/.test(intent.category) ? "Idle" : /^(walk|run|swim|climb|sneak|strafe|walk_back|crawl|pushup)$/.test(intent.category) ? "Movement" : "Action";
    return intent;
  }
  function defaultDuration(i) {
    if (i.category === "attack") { const strikes = i.stages.filter((s) => s.kind === "strike").length; return clamp((1.1 + strikes * 0.55 + (i.stages.some((s) => s.kind === "spin") ? 0.7 : 0) + (i.stages.some((s) => s.kind === "land") ? 0.5 : 0)) / i.speed, 0.6, 12); }
    if (i.category === "shoot") return clamp((0.9 + (i.shots || 1) * 0.35) / i.speed, 0.6, 6);
    if (i.category === "act" || i.category === "improv") { const names = i.category === "act" ? i.acts : i.improv; const d = names.reduce((s, n) => s + (ACTS[n] ? ACTS[n].d : 1.5), 0); const a0 = names.length === 1 && ACTS[names[0]]; const reps = i.repeat && a0 ? (a0.loop ? i.repeat : typeof a0.b === "function" ? Math.max(1, i.repeat / (a0.n0 || 3)) : 1) : 1; return clamp(d * reps / i.speed, 0.4, 30); }
    if (i.category === "gesture") return clamp((i.gesture && i.gesture.oscillate ? 2.4 : 2.0) / i.speed, 0.4, 10);
    if (i.layerOn) return { run: 0.7, sneak: 1.3, strafe: 1.0 }[i.layerOn] / i.speed || 1.0 / i.speed;
    // 1.58: tempo words scale EVERY category ("slow wave", "fast idle"), not just cycles and attacks
    return ({ idle: 4, walk: 1.0, run: 0.7, swim: 1.6, climb: 1.4, jump: 1.4, land: 0.9, dodge: 0.8, block: 0.9, cast: 1.8, transform: 2.6, emote: 2.0, sit: 4, crouch: 4,
      hit_react: 0.9, knockback: 1.6, death: 2.4, dash: 0.8, slide: 1.2, flip: 1.5, throw: 1.3, archery: 2.0, pickup: 1.4, aim: 3, kneel: 4, sleep: 5, fly: 3, tread: 2.4,
      sneak: 1.3, strafe: 1.0, walk_back: 1.1, crawl: 1.6, pushup: 1.6 }[i.category] || 2) / (i.speed || 1);
  }
  function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; }
  function rng(seed) { let x = (seed >>> 0) || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
  // ── 1.53 choreography: strike order is seeded per prompt (never the same fixed cycle), explicit words win ──
  const STRIKE_WORDS = [
    ["slash_over", /\b(overhead|over ?head|downward|chop|vertical|from above|cleave)\b/i], ["slash_up", /\b(rising|upward|uppercut slash|upswing|from below)\b/i], ["slash_diag", /\b(diagonal|cross slash|x slash)\b/i],
    ["backhand", /\b(backhand|reverse slash|back slash)\b/i], ["slash_l", /\b(left to right|forehand)\b/i], ["slash_r", /\b(right to left|horizontal|sideways slash|wide slash)\b/i], ["thrust_low", /\b(low thrust|low stab|leg stab)\b/i], ["thrust", /\b(thrust|stab|lunge|pierce|poke)\b/i],
    ["uppercut", /\buppercut\b/i], ["hook", /\bhook\b/i], ["cross", /\b(cross|straight)\b/i], ["jab", /\bjab\b/i], ["elbow", /\belbow\b/i], ["haymaker", /\bhaymaker\b/i],
    ["kick_spin", /\b(spin(?:ning)? kick|roundhouse|tornado kick)\b/i], ["knee", /\bknee\b/i], ["front_kick", /\b(front kick|push kick|teep)\b/i], ["kick_l", /\bleft kick\b/i], ["kick_r", /\b(right kick|high kick|kick)\b/i],
  ];
  const STRIKE_POOL = { sword: ["slash_r", "slash_l", "slash_over", "thrust", "slash_up", "slash_diag", "backhand"], slam: ["slash_over", "slash_r", "slash_up"], thrust: ["thrust", "thrust_low", "slash_up"], punch: ["jab", "cross", "hook", "uppercut", "elbow", "haymaker"], kick: ["kick_r", "kick_l", "front_kick", "knee", "kick_spin"] };
  // explicit strike words in the order they appear ("overhead then thrust") - only words that belong to this weapon's pool
  function explicitStrikes(weapon, text) {
    const pool = STRIKE_POOL[weapon] || STRIKE_POOL.punch;
    const found = [];
    for (const [v, re] of STRIKE_WORDS) { const m = re.exec(text); if (m && pool.includes(v)) found.push([m.index, v]); }
    found.sort((a, b) => a[0] - b[0]);
    return found.map((f) => f[1]).filter((v, i, a) => i === 0 || a[i - 1] !== v);
  }
  function choreograph(weapon, count, text, seed) {
    const pool = STRIKE_POOL[weapon] || STRIKE_POOL.punch;
    const explicit = explicitStrikes(weapon, text);
    const r = rng((seed ^ 0x9e3779b9) >>> 0);
    const out = explicit.slice(0, count);
    let last = out[out.length - 1] || null;
    while (out.length < count) {
      const cands = pool.filter((v) => v !== last && !(out.length === 0 && (v === "kick_spin" || v === "haymaker" || v === "backhand"))); // open with something readable, never repeat back-to-back
      const v = cands[Math.floor(r() * cands.length)] || pool[0];
      out.push(v); last = v;
    }
    if (count >= 3 && ["kick_spin", "uppercut", "slash_over"].includes(out[0]) && !explicit.length) { const i = out.findIndex((v) => !["kick_spin", "uppercut", "slash_over"].includes(v)); if (i > 0) { const t = out[0]; out[0] = out[i]; out[i] = t; } }
    return out;
  }
  // ── 1.53 persona: deterministic character traits per prompt (+ take / variation) so no two prompts move the same way ──
  function persona(intent, params, take) {
    const r = rng((Math.imul(intent.seed, 2654435761) ^ (Math.round((params.variation || 0) * 1000) * 7919) ^ ((take || 0) * 104729)) >>> 0);
    const pick = (a) => a[Math.floor(r() * a.length)]; const span = (lo, hi) => r3(lo + (hi - lo) * r());
    const styles = intent.styles || [];
    const p = {
      lead: pick(["l", "r"]), tilt: span(-4, 4), shoulderDrop: span(-3, 3), weightSide: pick([-1, 1]) * span(0.04, 0.12), amp: span(0.9, 1.12), tempo: span(0.92, 1.08),
      breath: span(0.8, 1.3), swayPhase: span(0, 6.28), fidget: pick(["look", "hands", "shoulders", "weight", "look", "weight"]), armRest: pick(["loose", "loose", "hips", "behind", "folded"]),
      bounce: span(0.75, 1.3), armAsym: span(0.85, 1.15), headBob: span(0.6, 1.4), hipSway: span(0.6, 1.4), strideLean: span(0.7, 1.3),
      emoteVariant: Math.floor(r() * 3), holdBias: span(0.8, 1.25), easing: styles.includes("cartoony") ? "bouncy" : styles.includes("robotic") ? "mechanical" : styles.includes("anime") ? "snappy" : styles.includes("fluid") ? "soft" : pick(["soft", "snappy", "soft", "neutral"]),
    };
    if (intent.variantHints) { if (intent.variantHints.both) p.emoteVariant = 1; if (intent.variantHints.small) p.emoteVariant = 2; if (intent.variantHints.big || intent.variantHints.fistpump) p.emoteVariant = 1; if (intent.variantHints.sky) p.emoteVariant = 1; if (intent.variantHints.side) p.emoteVariant = 2; }
    if (styles.includes("robotic")) { p.tilt = 0; p.shoulderDrop = 0; p.weightSide = 0; p.fidget = "none"; }
    if (params && params.easingFlavor) p.easing = params.easingFlavor; // explicit feedback beats the seeded pick
    if (params && params.armRest) p.armRest = params.armRest; // sets: a folded/behind-the-back idle cannot blend into a walk
    p.traits = [`${p.lead === "l" ? "left" : "right"}-leading`, p.fidget !== "none" ? `fidget: ${p.fidget}` : "still", `arms: ${p.armRest}`, `easing: ${p.easing}`, `tempo ${p.tempo}`];
    return p;
  }
  // Style / persona easing vocabulary: the same beat eases differently for cartoony / robotic / anime / fluid characters.
  function flavorEase(ease, tag, flavor) {
    const [st, dir] = ease || ["CubicV2", "InOut"];
    if (flavor === "mechanical") return tag === "impact" ? ["Linear", "Out"] : ["Linear", "InOut"];
    if (flavor === "bouncy") return tag === "land" || tag === "settle" || tag === "rise" || tag === "end" ? ["Bounce", "Out"] : tag === "impact" ? ["Linear", "Out"] : [st === "Linear" ? "Linear" : "Cubic", dir];
    if (flavor === "snappy") return tag === "windup" || tag === "anticipation" ? ["Cubic", "In"] : tag === "impact" ? ["Linear", "Out"] : tag === "follow" || tag === "follow_through" ? ["Cubic", "Out"] : [st, dir];
    if (flavor === "soft") return tag === "impact" ? ["Cubic", "Out"] : ["CubicV2", dir === "In" ? "InOut" : dir];
    return [st, dir];
  }
  // Mirror a clip left<->right (left-handed take): swap paired joints, negate yaw / roll and the sideways root offset.
  function mirrorPose(poses) {
    const out = {}; const pairs = { l_shoulder: "r_shoulder", l_elbow: "r_elbow", l_wrist: "r_wrist", l_hip: "r_hip", l_knee: "r_knee", l_ankle: "r_ankle" };
    const flip = (q) => { if (!q) return q; const o = { rot: [q.rot[0], -q.rot[1], -q.rot[2]] }; if (q.pos) o.pos = [-q.pos[0], q.pos[1], q.pos[2]]; return o; };
    for (const j of JOINTS) { const src = pairs[j] || Object.keys(pairs).find((k) => pairs[k] === j) || j; out[j] = flip(poses[src] || poses[j]); }
    return out;
  }
  function mirror(clip) {
    const c = JSON.parse(JSON.stringify(clip));
    c.keys = c.keys.map((k) => Object.assign({}, k, { poses: mirrorPose(k.poses) }));
    c.name = /_Mirror$/.test(c.name) ? c.name.replace(/_Mirror$/, "") : c.name + "_Mirror"; c.mirrored = !clip.mirrored; c.edited = true;
    c.report = validate(c);
    return c;
  }
  // Fingerprint: quantised pose data → two clips that would look the same share it. generate({avoid:[...]}) re-seeds until unique.
  function fingerprint(clip) {
    let h = 0x811c9dc5; const q = (v) => Math.round(v / 4);
    for (const k of clip.keys) { h = (Math.imul(h ^ Math.round(k.t * 20), 0x01000193)) >>> 0; for (const j of JOINTS) { const p = k.poses[j]; if (!p) continue; for (const v of p.rot) h = (Math.imul(h ^ (q(v) & 0xffff), 0x01000193)) >>> 0; } }
    return ("00000000" + h.toString(16)).slice(-8);
  }
  function similarity(a, b) { // 0..1 mean-pose closeness over 16 samples (1 = identical motion)
    let acc = 0, n = 0;
    for (let i = 0; i <= 16; i++) { const pa = sampleAt(a, a.duration * i / 16), pb = sampleAt(b, b.duration * i / 16); for (const j of JOINTS) { const A = pa[j] || J(0, 0, 0), B = pb[j] || J(0, 0, 0); for (let x = 0; x < 3; x++) { acc += Math.min(90, Math.abs(A.rot[x] - B.rot[x])); n++; } } }
    return r3(1 - (acc / n) / 90);
  }

  // ───────────────────────── pose helpers ─────────────────────────
  const QUALITY = {
    fast: { fps: 24, breakdowns: 0, followThrough: false, arcs: false, secondary: false, passes: 1, holdFrames: 1, spline: 0, ground: false },
    balanced: { fps: 30, breakdowns: 1, followThrough: true, arcs: false, secondary: true, passes: 1, holdFrames: 2, spline: 0, ground: true },
    high: { fps: 30, breakdowns: 2, followThrough: true, arcs: true, secondary: true, passes: 2, holdFrames: 2, spline: 0.6, ground: true },
    cinematic: { fps: 60, breakdowns: 3, followThrough: true, arcs: true, secondary: true, passes: 3, holdFrames: 3, spline: 1, ground: true },
  };
  const J = (x, y, z) => ({ rot: [x, y, z] });
  // Base standing pose (neutral, slightly alive) scaled by style.
  let PERSONA = null; // set per generate() - stance / idles / cycles / emotes read it for asymmetry
  function stance(k, style) {
    const hunch = style === "zombie" ? 25 : style === "heavy" ? 8 : 0;
    const P = PERSONA || { tilt: 0, shoulderDrop: 0, weightSide: 0, lead: "r", armRest: "loose" };
    const ws = P.weightSide, sgn = P.lead === "l" ? -1 : 1;
    const p = {
      root: { rot: [0, 0, ws * 12], pos: [ws, 0, 0] }, waist: J(-hunch * 0.5, sgn * 2, -ws * 10), neck: J(hunch * 0.6, -sgn * 3, P.tilt),
      l_shoulder: J(5, 0, -6 - P.shoulderDrop), l_elbow: J(8, 0, 0), l_wrist: J(0, 0, 0), r_shoulder: J(5, 0, 6 - P.shoulderDrop), r_elbow: J(8, 0, 0), r_wrist: J(0, 0, 0),
      l_hip: J(2 + (sgn > 0 ? 4 : -2), 0, -3 - ws * 20), l_knee: J(ws < 0 ? -3 : -9, 0, 0), l_ankle: J(2, 0, 0), r_hip: J(2 + (sgn < 0 ? 4 : -2), 0, 3 - ws * 20), r_knee: J(ws > 0 ? -3 : -9, 0, 0), r_ankle: J(2, 0, 0),
    };
    if (P.armRest === "hips") { p.l_shoulder = J(20, 0, -35); p.r_shoulder = J(20, 0, 35); p.l_elbow = J(70, 0, 0); p.r_elbow = J(70, 0, 0); p.l_wrist = J(0, 0, 25); p.r_wrist = J(0, 0, -25); }
    else if (P.armRest === "behind") { p.l_shoulder = J(-30, 0, -14); p.r_shoulder = J(-30, 0, 14); p.l_elbow = J(45, 0, 0); p.r_elbow = J(45, 0, 0); }
    else if (P.armRest === "folded") { p.l_shoulder = J(40, 30, -20); p.r_shoulder = J(40, -30, 20); p.l_elbow = J(115, 0, 0); p.r_elbow = J(115, 0, 0); }
    if (style === "zombie") { p.l_shoulder = J(80, 0, -5); p.r_shoulder = J(75, 0, 5); p.l_elbow = J(20, 0, 0); p.r_elbow = J(25, 0, 0); }
    if (style === "robotic") { p.l_elbow = J(0, 0, 0); p.r_elbow = J(0, 0, 0); p.l_knee = J(0, 0, 0); p.r_knee = J(0, 0, 0); p.root = { rot: [0, 0, 0], pos: [0, 0, 0] }; }
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
    } else if (variant === "slash_up") { // rising cut from low left to high right
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { waist: J(-18 * k, 30 * k, 8), neck: J(10, -15, 0), r_shoulder: J(-20 * k, 20, 15), r_elbow: J(35 * k, 0, 0), r_wrist: J(-30, 0, 10), l_shoulder: twoH ? J(-10 * k, 30, -10) : J(20 * k, 0, -30), l_elbow: twoH ? J(40, 0, 0) : J(45, 0, 0), l_knee: J(-45 * k, 0, 0), r_knee: J(-40 * k, 0, 0), root: { rot: [-10 * k, 20 * k, 4], pos: [0, -0.3 * k, 0] } }) });
      B.push({ at: 0.55, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { waist: J(12 * k, -25 * k, -8), neck: J(-10, 10, 0), r_shoulder: J(150 * k, -20, 50 * k), r_elbow: J(15, 0, 0), r_wrist: J(20, 0, -10), l_shoulder: twoH ? J(140 * k, -20, 10) : J(-25 * k, 0, -30), l_elbow: twoH ? J(20, 0, 0) : J(30, 0, 0), l_knee: J(-15, 0, 0), r_knee: J(-10, 0, 0), root: { rot: [8 * k, -15 * k, -4], pos: [0, 0.15 * k, 0.1] } }) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { waist: J(16 * k, -35 * k, -10), neck: J(-14, 15, 0), r_shoulder: J(170 * k, -35, 70 * k), r_elbow: J(30, 0, 0), r_wrist: J(25, 0, -15), l_shoulder: twoH ? J(150 * k, -30, 20) : J(-30 * k, 0, -35), l_elbow: twoH ? J(25, 0, 0) : J(35, 0, 0), root: { rot: [10 * k, -25 * k, -6], pos: [0, 0.1 * k, 0.15] } }) });
    } else if (variant === "slash_diag") { // diagonal cut: high right shoulder to low left hip
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { waist: J(-10 * k, 30 * k, 10 * k), neck: J(6, -20, -5), r_shoulder: J(165 * k, 25, 60 * k), r_elbow: J(75 * k, 0, 0), r_wrist: J(-30, 0, 15), l_shoulder: twoH ? J(150 * k, 35, 10) : J(30 * k, 0, -30), l_elbow: twoH ? J(70, 0, 0) : J(45, 0, 0), root: { rot: [-8 * k, 18 * k, 6], pos: [0, -0.15 * k, -0.1] } }) });
      B.push({ at: 0.5, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { waist: J(-25 * k, -30 * k, -14 * k), neck: J(14, 15, 6), r_shoulder: J(40 * k, -30, -30 * k), r_elbow: J(10, 0, 0), r_wrist: J(15, 0, -25), l_shoulder: twoH ? J(35 * k, -25, 25) : J(-20 * k, 0, -35), l_elbow: twoH ? J(15, 0, 0) : J(30, 0, 0), l_knee: J(-40 * k, 0, 0), r_knee: J(-30 * k, 0, 0), root: { rot: [-14 * k, -20 * k, -8], pos: [0, -0.3 * k, 0.2] } }) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { waist: J(-28 * k, -45 * k, -16 * k), neck: J(16, 25, 8), r_shoulder: J(15 * k, -45, -45 * k), r_elbow: J(25, 0, 0), r_wrist: J(20, 0, -30), l_shoulder: twoH ? J(20 * k, -35, 30) : J(-30 * k, 0, -40), l_elbow: twoH ? J(20, 0, 0) : J(35, 0, 0), l_knee: J(-45 * k, 0, 0), r_knee: J(-35 * k, 0, 0), root: { rot: [-16 * k, -30 * k, -10], pos: [0, -0.35 * k, 0.25] } }) });
    } else if (variant === "backhand") { // quick reverse cut with almost no windup (reads as a flick)
      B.push({ at: 0.0, tag: "windup", ease: ["Cubic", "In"], pose: withOverrides(prev, { waist: J(-8 * k, -25 * k, -4), neck: J(4, 15, 0), r_shoulder: J(85 * k, -35, -20 * k), r_elbow: J(60 * k, 0, 0), r_wrist: J(0, 0, -30), l_shoulder: twoH ? J(80 * k, -25, 15) : J(-10 * k, 0, -30), l_elbow: twoH ? J(45, 0, 0) : J(35, 0, 0), root: { rot: [-6 * k, -12 * k, 0], pos: [0, -0.12 * k, 0] } }) });
      B.push({ at: 0.4, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { waist: J(-10 * k, 38 * k, 6), neck: J(6, -20, 0), r_shoulder: J(80 * k, 40, 75 * k), r_elbow: J(15, 0, 0), r_wrist: J(0, 0, 30), l_shoulder: twoH ? J(70 * k, 40, 5) : J(10 * k, 0, -25), l_elbow: twoH ? J(70, 0, 0) : J(40, 0, 0), root: { rot: [-6 * k, 18 * k, 4], pos: [0, -0.1 * k, 0.1] } }) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { waist: J(-8 * k, 48 * k, 8), neck: J(6, -25, 0), r_shoulder: J(70 * k, 50, 85 * k), r_elbow: J(30, 0, 0), r_wrist: J(0, 0, 35), l_shoulder: twoH ? J(60 * k, 45, 10) : J(15 * k, 0, -25), l_elbow: twoH ? J(80, 0, 0) : J(40, 0, 0), root: { rot: [-5 * k, 24 * k, 5], pos: [0, -0.08 * k, 0.12] } }) });
    } else if (variant === "elbow" || variant === "haymaker") {
      const hay = variant === "haymaker";
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { waist: J(-6 * k, 40 * k, 5), neck: J(4, -25, 0), r_shoulder: hay ? J(20 * k, 45, 80 * k) : J(75 * k, 30, 45 * k), r_elbow: hay ? J(30 * k, 0, 0) : J(150, 0, 0), r_wrist: J(0, 0, 0), l_shoulder: J(70 * k, 0, -20), l_elbow: J(130 * k, 0, 0), l_knee: J(-30 * k, 0, 0), r_knee: J(-35 * k, 0, 0), root: { rot: [-6 * k, 22 * k, 3], pos: [0, -0.2 * k, hay ? -0.15 : 0] } }) });
      B.push({ at: hay ? 0.55 : 0.45, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { waist: J(-12 * k, -40 * k, -6), neck: J(8, 20, 0), r_shoulder: hay ? J(95 * k, -40, 0) : J(95 * k, -40, 20 * k), r_elbow: hay ? J(15, 0, 0) : J(150, 0, 0), r_wrist: J(0, 0, 0), l_shoulder: J(50 * k, 0, -25), l_elbow: J(120 * k, 0, 0), root: { rot: [-8 * k, -22 * k, -4], pos: [0, -0.15 * k, 0.3 * k] } }) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { waist: J(-10 * k, -52 * k, -8), neck: J(6, 25, 0), r_shoulder: hay ? J(85 * k, -60, -30 * k) : J(90 * k, -55, 10 * k), r_elbow: hay ? J(30, 0, 0) : J(145, 0, 0), l_shoulder: J(45 * k, 0, -25), l_elbow: J(120 * k, 0, 0), root: { rot: [-8 * k, -30 * k, -5], pos: [0, -0.12 * k, 0.35 * k] } }) });
    } else if (variant === "knee" || variant === "front_kick") {
      const fk = variant === "front_kick";
      B.push({ at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { r_hip: J(-25 * k, 0, 6), r_knee: J(-60 * k, 0, 0), l_knee: J(-30 * k, 0, 0), waist: J(-8 * k, 10, 0), r_shoulder: J(70 * k, 0, 20), r_elbow: J(110, 0, 0), l_shoulder: J(60 * k, 0, -25), l_elbow: J(115, 0, 0), root: { rot: [-6 * k, 8, 0], pos: [0, -0.15, -0.1] } }) });
      B.push({ at: 0.5, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { r_hip: J(fk ? 95 * k : 120 * k, 0, 8), r_knee: J(fk ? -10 : -130 * k, 0, 0), r_ankle: J(fk ? 30 : -20, 0, 0), l_knee: J(-15, 0, 0), waist: J(fk ? 18 * k : -22 * k, -10, 0), neck: J(fk ? -8 : 10, 5, 0), r_shoulder: J(fk ? 30 * k : 100 * k, 0, 20), r_elbow: J(fk ? 90 : 60, 0, 0), l_shoulder: J(fk ? 45 * k : 30 * k, 0, -25), l_elbow: J(110, 0, 0), root: { rot: [fk ? 14 * k : -10 * k, -6, 4], pos: [0, 0.05, fk ? 0.2 : 0.1] } }) });
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { r_hip: J(fk ? 70 * k : 95 * k, 0, 10), r_knee: J(fk ? -40 : -110 * k, 0, 0), r_ankle: J(10, 0, 0), waist: J(fk ? 10 * k : -16 * k, -8, 0), r_shoulder: J(fk ? 35 * k : 85 * k, 0, 20), r_elbow: J(80, 0, 0), root: { rot: [fk ? 8 * k : -8 * k, -4, 3], pos: [0, 0, 0.15] } }) });
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
      const o = {}; o[leg + "_hip"] = J(100 * k, 0, 10 * sgn); o[leg + "_knee"] = J(-5, 0, 0); o[leg + "_ankle"] = J(20, 0, 0); o.waist = J(15 * k, -20 * sgn * k, -5 * sgn); o.neck = J(-5, 15 * sgn, 0); o.root = { rot: [12 * k, variant === "kick_spin" ? 200 * sgn : -20 * sgn * k, 8 * sgn], pos: [0, 0.05, 0.1] }; o[st + "_knee"] = J(-20 * k, 0, 0); o[st + "_ankle"] = J(8, 0, 0); o[leg + "_shoulder"] = J(-40 * k, 0, 30 * sgn); o[st + "_shoulder"] = J(60 * k, 0, -30 * sgn); o[st + "_elbow"] = J(80, 0, 0);
      B.push({ at: 0.5, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, o) });
      // a spin kick carries the body through a full turn: the follow lands at 360° (minus a little coil) so the next stage continues from +360 instead of snapping back
      B.push({ at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, Object.assign({}, o, { [leg + "_hip"]: J(85 * k, 0, 12 * sgn), [leg + "_knee"]: J(-25 * k, 0, 0), root: variant === "kick_spin" ? { rot: [6 * k, 360 * sgn - 10 * sgn, 4 * sgn], pos: [0, 0, 0.1] } : o.root })) });
      if (variant === "kick_spin") B.spinTurn = 360 * sgn;
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
  // 1.53 stage generators: reactions, falls, ranged, traversal.
  const RJ = (p, j, d) => p[j] || J(d[0], d[1], d[2]);
  function hitBeats(dir, k, prev, big) {
    const s = dir === "left" ? -1 : dir === "right" ? 1 : 0, fwd = dir === "back" ? -1 : 1, m = big ? 1.6 : 1;
    return [
      { at: 0.0, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { root: { rot: [-18 * k * m * fwd, s * 20 * k, s * 14 * k], pos: [s * 0.3 * m, -0.12 * k, -0.35 * k * m * fwd] }, waist: J(-22 * k * m * fwd, s * 25 * k, s * 12), neck: J(20 * k * fwd, -s * 20, s * 10), l_shoulder: J(s > 0 ? 70 * k : 40 * k, 0, -25), r_shoulder: J(s < 0 ? 70 * k : 40 * k, 0, 25), l_elbow: J(80 * k, 0, 0), r_elbow: J(80 * k, 0, 0), l_knee: J(-35 * k, 0, 0), r_knee: J(-35 * k, 0, 0) }) },
      { at: 0.35, tag: "hold", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-24 * k * m * fwd, s * 24 * k, s * 16 * k], pos: [s * 0.4 * m, -0.2 * k, -0.5 * k * m * fwd] }, waist: J(-26 * k * m * fwd, s * 28 * k, s * 14), neck: J(26 * k * fwd, -s * 22, s * 12), l_shoulder: J(s > 0 ? 75 * k : 45 * k, 0, -28), r_shoulder: J(s < 0 ? 75 * k : 45 * k, 0, 28), l_elbow: J(90 * k, 0, 0), r_elbow: J(90 * k, 0, 0), l_knee: J(-45 * k, 0, 0), r_knee: J(-45 * k, 0, 0) }) },
      { at: 1.0, tag: "follow", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { root: { rot: [-10 * k * fwd, s * 10 * k, s * 6 * k], pos: [s * 0.25 * m, -0.15 * k, -0.4 * k * m * fwd] }, waist: J(-12 * k * fwd, s * 12 * k, s * 6), neck: J(12 * k * fwd, -s * 10, s * 5), l_elbow: J(60 * k, 0, 0), r_elbow: J(60 * k, 0, 0), l_knee: J(-30 * k, 0, 0), r_knee: J(-30 * k, 0, 0) }) },
    ];
  }
  function fallBeats(dir, k, prev) {
    const back = dir !== "forward"; const rx = back ? 1 : -1;
    const down = { root: { rot: [rx * 90, 0, 3], pos: [0, -(ROOT_HEIGHT - 0.5), back ? -1.15 : 0.95] }, waist: J(rx * -4, 3, 2), neck: J(back ? -28 : 32, 4, 10), l_hip: J(back ? 12 : -8, 0, -16), r_hip: J(back ? 8 : -4, 0, 16), l_knee: J(back ? -20 : -12, 0, 0), r_knee: J(back ? -14 : -8, 0, 0), l_shoulder: J(back ? 155 : 45, 0, -60), r_shoulder: J(back ? 145 : 38, 0, 55), l_elbow: J(22, 0, 0), r_elbow: J(28, 0, 0), l_ankle: J(22, 0, 0), r_ankle: J(22, 0, 0) };
    return [
      { at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { root: { rot: [rx * 20 * k, 0, 6], pos: [0, -0.3, back ? -0.4 : 0.3] }, waist: J(rx * -10 * k, 8, 4), neck: J(rx * 15, 0, 6), l_knee: J(-60 * k, 0, 0), r_knee: J(-50 * k, 0, 0), l_hip: J(30 * k, 0, -8), r_hip: J(25 * k, 0, 8), l_shoulder: J(back ? 60 : -20, 0, -40), r_shoulder: J(back ? 55 : -25, 0, 40), l_elbow: J(40, 0, 0), r_elbow: J(40, 0, 0) }) },
      { at: 0.55, tag: "impact", ease: ["Cubic", "In"], pose: withOverrides(prev, { root: { rot: [rx * 85, 0, 4], pos: [0, -(ROOT_HEIGHT - 0.55), back ? -1.1 : 0.9] }, waist: J(rx * -8, 4, 2), neck: J(back ? -25 : 30, 0, 8), l_hip: J(back ? 15 : -10, 0, -14), r_hip: J(back ? 10 : -5, 0, 14), l_knee: J(back ? -25 : -15, 0, 0), r_knee: J(back ? -18 : -10, 0, 0), l_shoulder: J(back ? 150 : 40, 0, -55), r_shoulder: J(back ? 140 : 35, 0, 50), l_elbow: J(25, 0, 0), r_elbow: J(30, 0, 0), l_ankle: J(20, 0, 0), r_ankle: J(20, 0, 0) }) },
      { at: 0.75, tag: "settle", ease: ["Bounce", "Out"], pose: withOverrides(prev, down) },
      { at: 1.0, tag: "end", ease: ["CubicV2", "Out"], pose: withOverrides(prev, down) },
    ];
  }
  function stillBeats(prev) { const n = RJ(prev, "neck", [0, 0, 0]); return [{ at: 0.5, tag: "hold", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { neck: J(n.rot[0], n.rot[1] + 6, n.rot[2]) }) }, { at: 1.0, tag: "end", ease: ["CubicV2", "Out"], pose: clonePose(prev) }]; }
  function aimPose(k, base, rifle) {
    return withOverrides(base, rifle
      ? { root: { rot: [-4, 20, 0], pos: [0, -0.1, 0] }, waist: J(-6 * k, -28, 2), neck: J(2, 8, -6), r_shoulder: J(80 * k, -15, 15), r_elbow: J(95, 0, 0), r_wrist: J(0, 0, -10), l_shoulder: J(95 * k, -30, -10), l_elbow: J(40, 0, 0), l_wrist: J(0, 0, 10), l_hip: J(15, 0, -6), r_hip: J(-8, 0, 8), l_knee: J(-18, 0, 0), r_knee: J(-14, 0, 0) }
      : { root: { rot: [-3, 12, 0], pos: [0, -0.08, 0] }, waist: J(-4 * k, -18, 1), neck: J(2, 6, -4), r_shoulder: J(92 * k, -10, 8), r_elbow: J(8, 0, 0), r_wrist: J(0, 0, 0), l_shoulder: J(85 * k, -25, 20), l_elbow: J(45, 0, 0), l_wrist: J(0, 0, 15), l_hip: J(12, 0, -6), r_hip: J(-6, 0, 8), l_knee: J(-16, 0, 0), r_knee: J(-12, 0, 0) });
  }
  function shotBeats(k, prev, rifle) {
    const rec = rifle ? 0.7 : 1;
    const rs = RJ(prev, "r_shoulder", [90, -10, 8]), re = RJ(prev, "r_elbow", [8, 0, 0]), w = RJ(prev, "waist", [0, 0, 0]), n = RJ(prev, "neck", [0, 0, 0]), rt = prev.root || { rot: [0, 0, 0], pos: [0, 0, 0] };
    return [
      { at: 0.0, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { r_shoulder: J(rs.rot[0] + 14 * k * rec, rs.rot[1], rs.rot[2]), r_elbow: J(re.rot[0] + 18 * rec, 0, 0), r_wrist: J(-20 * k * rec, 0, 0), waist: J(w.rot[0] - 6 * k * rec, w.rot[1], w.rot[2]), neck: J(n.rot[0] - 5 * rec, n.rot[1], n.rot[2]), root: { rot: [rt.rot[0] - 3 * rec, rt.rot[1], rt.rot[2]], pos: [(rt.pos || [0, 0, 0])[0], (rt.pos || [0, 0, 0])[1] - 0.03, (rt.pos || [0, 0, 0])[2] - 0.08 * rec] } }) },
      { at: 0.45, tag: "hold", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { r_shoulder: J(rs.rot[0] + 5 * k * rec, rs.rot[1], rs.rot[2]), r_elbow: J(re.rot[0] + 6 * rec, 0, 0), r_wrist: J(-6 * rec, 0, 0) }) },
      { at: 1.0, tag: "settle", ease: ["CubicV2", "InOut"], pose: clonePose(prev) },
    ];
  }
  function throwBeats(k, prev) {
    return [
      { at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { root: { rot: [-10 * k, 35 * k, 0], pos: [0, -0.2, -0.25 * k] }, waist: J(-14 * k, 40 * k, 6), neck: J(6, -35, 0), r_shoulder: J(-40 * k, 30, 60 * k), r_elbow: J(110 * k, 0, 0), r_wrist: J(-40, 0, 0), l_shoulder: J(95 * k, -20, -20), l_elbow: J(20, 0, 0), l_hip: J(35 * k, 0, -10), l_knee: J(-50 * k, 0, 0), r_knee: J(-30 * k, 0, 0) }) },
      { at: 0.5, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { root: { rot: [8 * k, -25 * k, 0], pos: [0, -0.1, 0.5 * k] }, waist: J(18 * k, -35 * k, -6), neck: J(-6, 20, 0), r_shoulder: J(110 * k, -25, 20), r_elbow: J(15, 0, 0), r_wrist: J(30, 0, 0), l_shoulder: J(-30 * k, 0, -30), l_elbow: J(40, 0, 0), l_hip: J(45 * k, 0, -8), l_knee: J(-35 * k, 0, 0), r_hip: J(-25 * k, 0, 10), r_knee: J(-15, 0, 0), r_ankle: J(25, 0, 0) }) },
      { at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [12 * k, -40 * k, -4], pos: [0, -0.15, 0.6 * k] }, waist: J(22 * k, -45 * k, -8), neck: J(-8, 30, 0), r_shoulder: J(60 * k, -40, -20 * k), r_elbow: J(35, 0, 0), r_wrist: J(20, 0, 0), l_shoulder: J(-35 * k, 0, -30), l_hip: J(50 * k, 0, -8), l_knee: J(-45 * k, 0, 0), r_hip: J(-30 * k, 0, 10), r_knee: J(-20, 0, 0), r_ankle: J(30, 0, 0) }) },
    ];
  }
  function drawBeats(k, prev) {
    return [
      { at: 0.0, tag: "windup", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { root: { rot: [-3, 70, 0], pos: [0, -0.08, 0] }, waist: J(-4 * k, -20, 0), neck: J(2, -60, -4), l_shoulder: J(90 * k, -10, -10), l_elbow: J(5, 0, 0), l_wrist: J(0, 0, 0), r_shoulder: J(60 * k, -20, 30), r_elbow: J(70, 0, 0), r_wrist: J(0, 0, 0), l_hip: J(10, 0, -8), r_hip: J(-6, 0, 10), l_knee: J(-14, 0, 0), r_knee: J(-10, 0, 0) }) },
      { at: 0.75, tag: "hold", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-4, 72, 0], pos: [0, -0.12, 0] }, waist: J(-8 * k, -24, 2), neck: J(2, -64, -6), l_shoulder: J(92 * k, -10, -12), l_elbow: J(5, 0, 0), r_shoulder: J(85 * k, -40, 80 * k), r_elbow: J(135 * k, 0, 0), r_wrist: J(0, 0, -10), l_knee: J(-18, 0, 0), r_knee: J(-14, 0, 0) }) },
      { at: 1.0, tag: "anticipation", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { root: { rot: [-5, 73, 0], pos: [0, -0.14, 0] }, waist: J(-9 * k, -25, 2), neck: J(1, -65, -6), l_shoulder: J(93 * k, -10, -12), l_elbow: J(4, 0, 0), r_shoulder: J(88 * k, -42, 84 * k), r_elbow: J(140 * k, 0, 0), r_wrist: J(0, 0, -12) }) },
    ];
  }
  function releaseBeats(k, prev) {
    return [
      { at: 0.0, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { l_shoulder: J(96 * k, -12, -14), l_elbow: J(2, 0, 0), l_wrist: J(-15, 0, 0), r_shoulder: J(75 * k, -55, 110 * k), r_elbow: J(60 * k, 0, 0), r_wrist: J(10, 0, 20), neck: J(0, -66, -6), waist: J(-6 * k, -22, 2) }) },
      { at: 0.4, tag: "hold", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { l_shoulder: J(94 * k, -12, -14), l_elbow: J(3, 0, 0), r_shoulder: J(70 * k, -58, 120 * k), r_elbow: J(45 * k, 0, 0), r_wrist: J(10, 0, 25) }) },
      { at: 1.0, tag: "follow", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { l_shoulder: J(80 * k, -10, -14), l_elbow: J(10, 0, 0), r_shoulder: J(55 * k, -40, 60 * k), r_elbow: J(60 * k, 0, 0), r_wrist: J(0, 0, 10), neck: J(2, -55, -4), waist: J(-4 * k, -18, 1) }) },
    ];
  }
  function flipBeats(dir, k, prev) {
    const sgn = dir === "front" ? -1 : 1; // back flip rotates the root backwards (lean back = +x)
    const tuck = { l_hip: J(110 * k, 0, -10), r_hip: J(110 * k, 0, 10), l_knee: J(-135 * k, 0, 0), r_knee: J(-135 * k, 0, 0), waist: J(-30 * k, 0, 0), neck: J(25, 0, 0), l_shoulder: J(60 * k, 0, -20), r_shoulder: J(60 * k, 0, 20), l_elbow: J(120, 0, 0), r_elbow: J(120, 0, 0) };
    const B = [{ at: 0.0, tag: "launch", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [sgn * 25 * k, 0, 0], pos: [0, 0.4 * k, 0] }, waist: J(sgn * 10, 0, 0), l_shoulder: J(160 * k, 0, -25), r_shoulder: J(160 * k, 0, 25), l_elbow: J(20, 0, 0), r_elbow: J(20, 0, 0), l_knee: J(-20, 0, 0), r_knee: J(-20, 0, 0) }) }];
    for (let i = 1; i <= 3; i++) { const f = i / 4; B.push({ at: 0.15 + 0.6 * f, tag: i === 2 ? "apex" : "arc", ease: ["Linear", "InOut"], pose: withOverrides(prev, Object.assign({ root: { rot: [sgn * (25 * k + 335 * f), 0, 0], pos: [0, 0.4 * k + Math.sin(Math.PI * f) * 1.6 * k, sgn * -0.4 * f] } }, tuck)) }); }
    B.push({ at: 1.0, tag: "fall", ease: ["CubicV2", "In"], pose: withOverrides(prev, { root: { rot: [sgn * 360, 0, 0], pos: [0, 0.35 * k, sgn * -0.5] }, waist: J(-8, 0, 0), neck: J(12, 0, 0), l_hip: J(35, 0, -8), r_hip: J(35, 0, 8), l_knee: J(-40, 0, 0), r_knee: J(-40, 0, 0), l_shoulder: J(40, 0, -50), r_shoulder: J(40, 0, 50), l_elbow: J(30, 0, 0), r_elbow: J(30, 0, 0) }) });
    B.spinX = sgn * 360;
    return B;
  }
  function dashBeats(k, prev, travel) {
    const d = travel ? 3.2 * k : 0;
    return [
      { at: 0.0, tag: "windup", ease: ["Cubic", "In"], pose: withOverrides(prev, { root: { rot: [-22 * k, 0, 0], pos: [0, -0.35 * k, -0.2] }, waist: J(-18 * k, 0, 0), neck: J(18, 0, 0), l_hip: J(50 * k, 0, -8), r_hip: J(-15 * k, 0, 8), l_knee: J(-70 * k, 0, 0), r_knee: J(-40 * k, 0, 0), r_ankle: J(25, 0, 0), l_shoulder: J(-40 * k, 0, -20), r_shoulder: J(70 * k, 0, 20), l_elbow: J(45, 0, 0), r_elbow: J(70, 0, 0) }) },
      { at: 0.45, tag: "impact", ease: ["Linear", "Out"], pose: withOverrides(prev, { root: { rot: [-32 * k, 0, 0], pos: [0, -0.25 * k, d * 0.55] }, waist: J(-20 * k, 0, 0), neck: J(26, 0, 0), l_hip: J(-30 * k, 0, -8), r_hip: J(60 * k, 0, 8), l_knee: J(-20, 0, 0), r_knee: J(-85 * k, 0, 0), l_ankle: J(30, 0, 0), l_shoulder: J(80 * k, 0, -20), r_shoulder: J(-50 * k, 0, 20), l_elbow: J(80, 0, 0), r_elbow: J(50, 0, 0) }) },
      { at: 1.0, tag: "follow", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-12 * k, 0, 0], pos: [0, -0.3 * k, d] }, waist: J(-10 * k, 0, 0), neck: J(10, 0, 0), l_hip: J(40 * k, 0, -10), r_hip: J(-20 * k, 0, 10), l_knee: J(-60 * k, 0, 0), r_knee: J(-25, 0, 0), r_ankle: J(20, 0, 0), l_shoulder: J(20, 0, -25), r_shoulder: J(30, 0, 25), l_elbow: J(60, 0, 0), r_elbow: J(60, 0, 0) }) },
    ];
  }
  function slideBeats(k, prev, travel) {
    const d = travel ? 3.5 * k : 0;
    return [
      { at: 0.0, tag: "windup", ease: ["CubicV2", "In"], pose: withOverrides(prev, { root: { rot: [-14 * k, 0, 0], pos: [0, -0.3, 0] }, waist: J(-10, 0, 0), l_hip: J(45 * k, 0, -8), r_hip: J(-10, 0, 8), l_knee: J(-70 * k, 0, 0), r_knee: J(-30, 0, 0), l_shoulder: J(-30, 0, -20), r_shoulder: J(60, 0, 20), l_elbow: J(50, 0, 0), r_elbow: J(80, 0, 0) }) },
      { at: 0.3, tag: "impact", ease: ["Cubic", "Out"], pose: withOverrides(prev, { root: { rot: [35 * k, 0, 0], pos: [0, -(ROOT_HEIGHT - 1.0), d * 0.4] }, waist: J(-25 * k, 0, 0), neck: J(30, 0, 0), l_hip: J(70 * k, 0, -14), r_hip: J(20, 0, 16), l_knee: J(-20, 0, 0), r_knee: J(-120 * k, 0, 0), l_ankle: J(25, 0, 0), l_shoulder: J(-45, 0, -40), r_shoulder: J(110 * k, 0, 30), l_elbow: J(30, 0, 0), r_elbow: J(40, 0, 0) }) },
      { at: 0.7, tag: "hold", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [38 * k, 0, 0], pos: [0, -(ROOT_HEIGHT - 1.05), d * 0.85] }, waist: J(-28 * k, 0, 0), neck: J(32, 0, 0), l_hip: J(72 * k, 0, -14), r_hip: J(22, 0, 16), l_knee: J(-18, 0, 0), r_knee: J(-125 * k, 0, 0), l_ankle: J(25, 0, 0), l_shoulder: J(-50, 0, -40), r_shoulder: J(115 * k, 0, 30), l_elbow: J(30, 0, 0), r_elbow: J(40, 0, 0) }) },
      { at: 1.0, tag: "rise", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { root: { rot: [-5, 0, 0], pos: [0, -0.5, d] }, waist: J(-12, 0, 0), neck: J(10, 0, 0), l_hip: J(60 * k, 0, -10), r_hip: J(20, 0, 10), l_knee: J(-80 * k, 0, 0), r_knee: J(-70 * k, 0, 0), l_shoulder: J(20, 0, -25), r_shoulder: J(40, 0, 25), l_elbow: J(50, 0, 0), r_elbow: J(50, 0, 0) }) },
    ];
  }
  function pickupBeats(k, prev) {
    const low = { root: { rot: [-18 * k, 8, 0], pos: [0, -1.0 * k, 0.25] }, waist: J(-40 * k, -10, 4), neck: J(30, 0, 0), l_hip: J(85 * k, 0, -10), r_hip: J(80 * k, 0, 12), l_knee: J(-115 * k, 0, 0), r_knee: J(-110 * k, 0, 0), l_ankle: J(20, 0, 0), r_ankle: J(20, 0, 0), l_shoulder: J(40, 0, -20), l_elbow: J(60, 0, 0) };
    return [
      { at: 0.0, tag: "windup", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, { root: { rot: [-8, 0, 0], pos: [0, -0.3, 0.1] }, waist: J(-20 * k, 0, 0), neck: J(16, 0, 0), l_hip: J(40, 0, -8), r_hip: J(40, 0, 8), l_knee: J(-60 * k, 0, 0), r_knee: J(-60 * k, 0, 0), r_shoulder: J(60 * k, 0, 15), r_elbow: J(20, 0, 0), l_shoulder: J(20, 0, -15) }) },
      { at: 0.45, tag: "impact", ease: ["CubicV2", "Out"], pose: withOverrides(prev, Object.assign({}, low, { r_shoulder: J(95 * k, 0, 10), r_elbow: J(10, 0, 0), r_wrist: J(25, 0, 0) })) },
      { at: 0.6, tag: "hold", ease: ["CubicV2", "InOut"], pose: withOverrides(prev, Object.assign({}, low, { r_shoulder: J(90 * k, 0, 10), r_elbow: J(35, 0, 0), r_wrist: J(-20, 0, 0) })) },
      { at: 1.0, tag: "rise", ease: ["CubicV2", "Out"], pose: withOverrides(prev, { root: { rot: [-4, 2, 0], pos: [0, -0.15, 0.05] }, waist: J(-8, -2, 0), neck: J(4, 0, 0), l_hip: J(15, 0, -6), r_hip: J(15, 0, 6), l_knee: J(-22, 0, 0), r_knee: J(-22, 0, 0), r_shoulder: J(50 * k, 0, 12), r_elbow: J(110, 0, 0), r_wrist: J(-20, 0, 0), l_shoulder: J(10, 0, -10), l_elbow: J(20, 0, 0) }) },
    ];
  }
  // Cycles (walk / run / swim / climb) - 8 keys over the loop, second half mirrored.
  function cycleKeys(category, k, style, duration, q) {
    const keys = [];
    const base = stance(k, style);
    const n = 8;
    const P = PERSONA || { bounce: 1, armAsym: 1, headBob: 1, hipSway: 1, strideLean: 1 };
    const run = category === "run", back = category === "walk_back", sneak = category === "sneak", strafe = category === "strafe", crawl = category === "crawl", pushup = category === "pushup";
    const swing = (run ? 48 * k : sneak ? 22 * k : 30 * k) * (back ? 0.8 : 1), kneeMax = run ? 95 * k : sneak ? 40 * k : 55 * k, armSwing = (run ? 55 * k : sneak ? 10 * k : 26 * k), bob = (run ? 0.22 * k : sneak ? 0.04 : 0.09 * k) * P.bounce, lean = (run ? -14 * k : sneak ? -12 : back ? 4 * k : -3 * k) * P.strideLean;
    const sd = (PERSONA && PERSONA.strafeDir === "right") ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const f = i / n, ph = f * Math.PI * 2; // phase: 0 = right foot contact
      const p = clonePose(base);
      const hipR = Math.cos(ph) * swing, hipL = -hipR;
      // knee bends most during the swing-through (when the hip comes forward from behind)
      const kneeR = -(Math.max(0, Math.sin(ph + Math.PI / 2 + 0.6)) ** 1.5) * kneeMax - 6, kneeL = -(Math.max(0, Math.sin(ph - Math.PI / 2 + 0.6)) ** 1.5) * kneeMax - 6;
      if (pushup) {
        const dn = 0.5 - 0.5 * Math.cos(ph); // 0 top, 1 bottom, 0 top
        const flare = 25 * P.hipSway, depth = 0.55 * clamp(P.bounce, 0.8, 1.2);
        p.root = { rot: [-88, 0, 0], pos: [0, -(ROOT_HEIGHT - 1.15) - dn * depth, 0] }; p.waist = J(-2 + dn * 3 * (P.strideLean - 1), 0, 0); p.neck = J(30 - dn * 8 * P.headBob, 0, 0);
        p.l_shoulder = J(85 + dn * 10, 0, -22 - dn * flare); p.r_shoulder = J(85 + dn * 10, 0, 22 + dn * flare); p.l_elbow = J(5 + dn * 105 * k * P.armAsym, 0, 0); p.r_elbow = J(5 + dn * 105 * k / P.armAsym, 0, 0); p.l_wrist = J(-30, 0, 0); p.r_wrist = J(-30, 0, 0);
        p.l_hip = J(-6, 0, -6); p.r_hip = J(-6, 0, 6); p.l_knee = J(-4, 0, 0); p.r_knee = J(-4, 0, 0); p.l_ankle = J(40, 0, 0); p.r_ankle = J(40, 0, 0);
      } else if (crawl) {
        const reach = 45 * P.armAsym, sway = 10 * P.hipSway;
        p.root = { rot: [-84, 0, Math.sin(ph) * 4 * P.hipSway], pos: [0, -(ROOT_HEIGHT - 0.95) + Math.abs(Math.sin(ph)) * 0.06 * P.bounce, 0] }; p.waist = J(-6, Math.sin(ph) * sway, 0); p.neck = J(42 - 4 * P.strideLean, Math.sin(ph) * 8 * P.headBob, 0);
        p.r_shoulder = J(120 + Math.sin(ph) * reach, 0, 30); p.l_shoulder = J(120 - Math.sin(ph) * reach, 0, -30); p.r_elbow = J(60 + 40 * Math.max(0, -Math.sin(ph)), 0, 0); p.l_elbow = J(60 + 40 * Math.max(0, Math.sin(ph)), 0, 0);
        p.r_hip = J(30 - Math.sin(ph) * 40, 0, 20); p.l_hip = J(30 + Math.sin(ph) * 40, 0, -20); p.r_knee = J(-50 - 50 * Math.max(0, -Math.sin(ph)), 0, 0); p.l_knee = J(-50 - 50 * Math.max(0, Math.sin(ph)), 0, 0); p.r_ankle = J(35, 0, 0); p.l_ankle = J(35, 0, 0);
      } else if (strafe) {
        const op = Math.sin(ph); // leading leg reaches sideways, trailing leg closes
        p.root = { rot: [-3, 0, sd * 6 * P.hipSway + Math.sin(ph) * 2], pos: [Math.sin(ph) * 0.05, bob * (0.5 - 0.5 * Math.cos(ph * 2)), 0] }; p.waist = J(-4, -sd * 12, -sd * 4 - op * 3); p.neck = J(2, sd * 14, sd * 3 * P.headBob);
        p.r_hip = J(6, 0, 12 + sd * op * 22 * k); p.l_hip = J(6, 0, -12 + sd * op * 22 * k); p.r_knee = J(-12 - 20 * Math.max(0, sd * op) * k, 0, 0); p.l_knee = J(-12 - 20 * Math.max(0, -sd * op) * k, 0, 0); p.r_ankle = J(4, 0, -sd * op * 10); p.l_ankle = J(4, 0, -sd * op * 10);
        p.r_shoulder = J(35 * k, 0, 18 + op * 6); p.l_shoulder = J(35 * k, 0, -18 + op * 6); p.r_elbow = J(70, 0, 0); p.l_elbow = J(70, 0, 0);
      } else if (category === "swim") {
        p.root = { rot: [-80 - 3 * (P.strideLean - 1) * 10, 0, Math.sin(ph) * 3 * P.hipSway], pos: [0, Math.sin(ph * 2) * 0.05 * P.bounce, 0] }; p.waist = J(-6 + Math.sin(ph) * 6 * P.hipSway, 0, 0); p.neck = J(35 - 5 * (P.headBob - 1), Math.sin(ph) * 10 * P.headBob, 0);
        p.r_shoulder = J(170 - 180 * ((f + 0.5) % 1), 0, 20 * Math.sin(ph) * P.armAsym); p.l_shoulder = J(170 - 180 * f, 0, -20 * Math.sin(ph + Math.PI)); p.r_elbow = J(20 + 20 * Math.max(0, Math.sin(ph)), 0, 0); p.l_elbow = J(20 + 20 * Math.max(0, Math.sin(ph + Math.PI)), 0, 0);
        p.r_hip = J(Math.sin(ph * 2) * 18, 0, 4); p.l_hip = J(-Math.sin(ph * 2) * 18, 0, -4); p.r_knee = J(-12 - 10 * Math.max(0, Math.sin(ph * 2)), 0, 0); p.l_knee = J(-12 - 10 * Math.max(0, -Math.sin(ph * 2)), 0, 0);
      } else if (category === "climb") {
        p.root = { rot: [-10 * P.strideLean, 0, Math.sin(ph) * 2 * P.hipSway], pos: [0, Math.sin(ph) * 0.1 * P.bounce, -0.2] }; p.waist = J(-10, Math.sin(ph) * 6 * P.hipSway, 0); p.neck = J(-25 + 4 * (P.headBob - 1), Math.sin(ph) * 4 * P.headBob, 0);
        p.r_shoulder = J(150 - 40 * Math.sin(ph) * P.armAsym, 0, 15); p.l_shoulder = J(150 + 40 * Math.sin(ph) / P.armAsym, 0, -15); p.r_elbow = J(50 + 40 * Math.max(0, Math.sin(ph)), 0, 0); p.l_elbow = J(50 + 40 * Math.max(0, -Math.sin(ph)), 0, 0);
        p.r_hip = J(60 + 40 * Math.sin(ph), 0, 8); p.l_hip = J(60 - 40 * Math.sin(ph), 0, -8); p.r_knee = J(-80 - 30 * Math.sin(ph), 0, 0); p.l_knee = J(-80 + 30 * Math.sin(ph), 0, 0);
      } else {
        const dirS = back ? -1 : 1, crouchY = sneak ? -0.55 : 0;
        p.root = { rot: [lean + Math.sin(ph * 2) * 2 * P.bounce, 0, Math.sin(ph) * (run ? 4 : 2) * P.hipSway], pos: [0, bob * (0.5 - 0.5 * Math.cos(ph * 2)) - (run ? 0.1 : 0.03) + crouchY, 0] };
        p.waist = J((sneak ? -14 : -4) * k, -Math.cos(ph) * (run ? 12 : 6) * k * P.hipSway, Math.sin(ph) * 3 * P.hipSway); p.neck = J(sneak ? 12 : 3, Math.cos(ph) * (run ? 6 : 3) * P.headBob, -Math.sin(ph) * 2 * P.headBob);
        p.r_hip = J(hipR * dirS + (sneak ? 30 : 0), 0, 3); p.l_hip = J(hipL * dirS + (sneak ? 30 : 0), 0, -3); p.r_knee = J(kneeR - (sneak ? 45 : 0), 0, 0); p.l_knee = J(kneeL - (sneak ? 45 : 0), 0, 0);
        p.r_ankle = J(clamp(-hipR * 0.35 * dirS + (run ? 10 : 4) + (sneak ? 10 : 0), -40, 40), 0, 0); p.l_ankle = J(clamp(-hipL * 0.35 * dirS + (run ? 10 : 4) + (sneak ? 10 : 0), -40, 40), 0, 0);
        p.r_shoulder = J((-Math.cos(ph) * armSwing * P.armAsym + (run ? 10 : 0)) * dirS + (sneak ? 35 : 0), 0, 8); p.l_shoulder = J((Math.cos(ph) * armSwing / P.armAsym + (run ? 10 : 0)) * dirS + (sneak ? 35 : 0), 0, -8);
        p.r_elbow = J(run ? 85 * k : sneak ? 90 : 12 + 10 * Math.max(0, -Math.cos(ph)), 0, 0); p.l_elbow = J(run ? 85 * k : sneak ? 90 : 12 + 10 * Math.max(0, Math.cos(ph)), 0, 0);
        if (style === "ninja") { p.waist = J(-18 * k, p.waist.rot[1], p.waist.rot[2]); p.r_shoulder = J(-35, 0, 20); p.l_shoulder = J(-35, 0, -20); p.r_elbow = J(10, 0, 0); p.l_elbow = J(10, 0, 0); }
        if (style === "heavy") { p.root.pos[1] -= 0.08; p.root.rot[2] *= 2; p.r_shoulder = J(p.r_shoulder.rot[0] * 0.6, 0, 22); p.l_shoulder = J(p.l_shoulder.rot[0] * 0.6, 0, -22); }
        if (style === "cute" || style === "cartoony") { p.root.pos[1] += bob * 0.6 * (0.5 - 0.5 * Math.cos(ph * 2)); p.neck = J(p.neck.rot[0], p.neck.rot[1], p.neck.rot[2] * 2.5); }
        if (style === "zombie") { p.r_shoulder = J(80 + Math.sin(ph) * 10, 0, 5); p.l_shoulder = J(75 - Math.sin(ph) * 10, 0, -5); p.waist = J(-25, Math.cos(ph) * 8, 0); p.neck = J(15, 0, Math.sin(ph) * 6); }
      }
      keys.push({ t: r3(f * duration), poses: p, ease: ["CubicV2", "InOut"], tag: i % (n / 2) === 0 ? "contact" : i % (n / 2) === n / 4 ? "passing" : "breakdown" });
    }
    return keys;
  }
  function idleKeys(category, k, style, duration, q, seed) {
    const P = PERSONA || { breath: 1, swayPhase: 0, fidget: "look", weightSide: 0.06, lead: "r", tilt: 0 };
    const st = stance(k, style); const sgn = P.lead === "l" ? -1 : 1;
    const base = category === "sit" ? withOverrides(st, { root: { rot: [0, 0, 0], pos: [0, -1.5, 0] }, l_hip: J(85, 0, -8 - (sgn < 0 ? 10 : 0)), r_hip: J(85, 0, 8 + (sgn > 0 ? 10 : 0)), l_knee: J(-85, 0, 0), r_knee: J(-85, 0, 0), waist: J(-6, 0, 0), l_shoulder: J(45, 0, -10), r_shoulder: J(45, 0, 10), l_elbow: J(40, 0, 0), r_elbow: J(40, 0, 0) })
      : category === "crouch" ? withOverrides(st, { root: { rot: [-10, 0, 0], pos: [0, -1.1, 0] }, l_hip: J(95, 0, -12), r_hip: J(95, 0, 12), l_knee: J(-125, 0, 0), r_knee: J(-125, 0, 0), waist: J(-20, 0, 0), neck: J(15, 0, 0), l_shoulder: J(50, 0, -15), r_shoulder: J(50, 0, 15), l_elbow: J(70, 0, 0), r_elbow: J(70, 0, 0) })
      : category === "kneel" ? withOverrides(st, { root: { rot: [-6, 0, 0], pos: [0, -1.25, 0] }, l_hip: J(sgn > 0 ? 95 : 5, 0, -8), r_hip: J(sgn > 0 ? 5 : 95, 0, 8), l_knee: J(sgn > 0 ? -95 : -125, 0, 0), r_knee: J(sgn > 0 ? -125 : -95, 0, 0), l_ankle: J(sgn > 0 ? 10 : 40, 0, 0), r_ankle: J(sgn > 0 ? 40 : 10, 0, 0), waist: J(-12, 0, 0), neck: J(18, 0, 0), l_shoulder: J(sgn > 0 ? 55 : 20, 0, -10), r_shoulder: J(sgn > 0 ? 20 : 55, 0, 10), l_elbow: J(sgn > 0 ? 80 : 20, 0, 0), r_elbow: J(sgn > 0 ? 20 : 80, 0, 0) })
      : category === "sleep" ? withOverrides(st, { root: { rot: [88, 0, 8], pos: [0, -(ROOT_HEIGHT - 0.5), 0] }, waist: J(-6, 0, 4), neck: J(-10, sgn * 25, 10), l_shoulder: J(sgn > 0 ? 150 : 40, 0, -30), r_shoulder: J(sgn > 0 ? 40 : 150, 0, 30), l_elbow: J(sgn > 0 ? 110 : 30, 0, 0), r_elbow: J(sgn > 0 ? 30 : 110, 0, 0), l_hip: J(25, 0, -10), r_hip: J(10, 0, 8), l_knee: J(-40, 0, 0), r_knee: J(-15, 0, 0), l_ankle: J(25, 0, 0), r_ankle: J(25, 0, 0) })
      : category === "fly" ? withOverrides(st, { root: { rot: [-70, 0, 0], pos: [0, 0.6, 0] }, waist: J(-12, 0, 0), neck: J(38, 0, 0), l_shoulder: J(sgn > 0 ? 170 : 20, 0, -20), r_shoulder: J(sgn > 0 ? 20 : 170, 0, 20), l_elbow: J(5, 0, 0), r_elbow: J(5, 0, 0), l_hip: J(-15, 0, -6), r_hip: J(-15, 0, 6), l_knee: J(-10, 0, 0), r_knee: J(-10, 0, 0), l_ankle: J(35, 0, 0), r_ankle: J(35, 0, 0) })
      : category === "tread" ? withOverrides(st, { root: { rot: [-15, 0, 0], pos: [0, -0.2, 0] }, waist: J(-6, 0, 0), neck: J(14, 0, 0), l_shoulder: J(70, 0, -70), r_shoulder: J(70, 0, 70), l_elbow: J(60, 0, 0), r_elbow: J(60, 0, 0), l_hip: J(35, 0, -15), r_hip: J(35, 0, 15), l_knee: J(-60, 0, 0), r_knee: J(-60, 0, 0) })
      : category === "aim" ? aimPose(k, st, /rifle|shotgun|blaster|two[- ]hand/i.test(P.text || "")) : st;
    const keys = []; const n = Math.max(4, Math.round(duration * (q.breakdowns + 1) * 1.5)); const rnd = rng(seed);
    const sway = rnd() * 0.5 + 0.75, bf = P.breath, ph0 = P.swayPhase;
    const fidgetAt = 0.35 + rnd() * 0.3; // where in the loop the fidget happens
    for (let i = 0; i <= n; i++) {
      const f = i / n, ph = f * Math.PI * 2 * bf;
      const p = clonePose(base);
      const br = Math.sin(ph) * k, sw = Math.sin(f * Math.PI * 2 * 0.5 + ph0) * k * sway;
      const rp = base.root.pos || [0, 0, 0];
      const fid = Math.max(0, 1 - Math.abs(f - fidgetAt) / 0.18); // triangular bump (0 at the loop ends - keeps the seam closed)
      p.root = { rot: [base.root.rot[0] + br * 1.2, base.root.rot[1] + sw * 2, base.root.rot[2] + Math.sin(f * Math.PI * 2 * 0.5) * 1.5], pos: [rp[0], rp[1] + br * 0.035, rp[2]] };
      p.waist = J(base.waist.rot[0] + br * 2.5, base.waist.rot[1] + sw * 3, base.waist.rot[2]); p.neck = J(base.neck.rot[0] - br * 2 + 1.5, base.neck.rot[1] + Math.sin(f * Math.PI * 2 * 0.5 + 2.1 + ph0) * 6 * k, base.neck.rot[2]);
      p.l_shoulder = J(base.l_shoulder.rot[0] + br * 2, base.l_shoulder.rot[1], base.l_shoulder.rot[2] - br * 2.5); p.r_shoulder = J(base.r_shoulder.rot[0] + br * 2, base.r_shoulder.rot[1], base.r_shoulder.rot[2] + br * 2.5);
      p.l_elbow = J(base.l_elbow.rot[0] + br * 2, 0, 0); p.r_elbow = J(base.r_elbow.rot[0] + br * 2, 0, 0);
      if (category === "idle") { p.l_knee = J(base.l_knee.rot[0] - Math.max(0, -br) * 1.5, 0, 0); p.r_knee = J(base.r_knee.rot[0] - Math.max(0, br) * 1.5, 0, 0); }
      if (category === "fly") { p.root.pos[1] += Math.sin(f * Math.PI * 2) * 0.35 * k; p.l_ankle = J(35 + br * 8, 0, 0); p.r_ankle = J(35 - br * 8, 0, 0); }
      if (category === "tread") { const kick = Math.sin(f * Math.PI * 4); p.l_hip = J(35 + kick * 20, 0, -15); p.r_hip = J(35 - kick * 20, 0, 15); p.l_knee = J(-60 - Math.max(0, -kick) * 30, 0, 0); p.r_knee = J(-60 - Math.max(0, kick) * 30, 0, 0); p.root.pos[1] = rp[1] + Math.sin(f * Math.PI * 4) * 0.08; p.l_shoulder = J(70, 0, -70 - Math.sin(f * Math.PI * 4) * 12); p.r_shoulder = J(70, 0, 70 - Math.sin(f * Math.PI * 4) * 12); }
      if (category === "sleep") { p.waist = J(base.waist.rot[0] + br * 1.5, base.waist.rot[1], base.waist.rot[2]); p.root.rot = [base.root.rot[0] + br * 0.8, base.root.rot[1], base.root.rot[2]]; p.neck = J(base.neck.rot[0] - br, base.neck.rot[1], base.neck.rot[2]); }
      // persona fidget layer: one small life sign per loop, zero at the seam
      if (fid > 0 && category !== "sleep") {
        if (P.fidget === "look") { p.neck = J(p.neck.rot[0] - 4 * fid, p.neck.rot[1] + sgn * 32 * fid * k, p.neck.rot[2] + sgn * 4 * fid); p.waist = J(p.waist.rot[0], p.waist.rot[1] + sgn * 8 * fid, p.waist.rot[2]); }
        else if (P.fidget === "hands") { const a = sgn > 0 ? "r" : "l"; p[a + "_elbow"] = J(p[a + "_elbow"].rot[0] + 35 * fid, 0, 0); p[a + "_wrist"] = J(-25 * fid, 0, (sgn > 0 ? -1 : 1) * 20 * fid); p[a + "_shoulder"] = J(p[a + "_shoulder"].rot[0] + 10 * fid, p[a + "_shoulder"].rot[1], p[a + "_shoulder"].rot[2]); }
        else if (P.fidget === "shoulders") { p.l_shoulder = J(p.l_shoulder.rot[0] - 6 * fid, p.l_shoulder.rot[1], p.l_shoulder.rot[2] - 14 * fid); p.r_shoulder = J(p.r_shoulder.rot[0] - 6 * fid, p.r_shoulder.rot[1], p.r_shoulder.rot[2] + 14 * fid); p.waist = J(p.waist.rot[0] + 4 * fid, p.waist.rot[1], p.waist.rot[2]); p.neck = J(p.neck.rot[0] - 5 * fid, p.neck.rot[1], p.neck.rot[2]); }
        else if (P.fidget === "weight" && (category === "idle" || category === "crouch")) { p.root.pos[0] = rp[0] - 2 * P.weightSide * fid; p.root.rot[2] = base.root.rot[2] - 20 * P.weightSide * fid; p.waist = J(p.waist.rot[0], p.waist.rot[1], base.waist.rot[2] + 16 * P.weightSide * fid); p.l_knee = J(base.l_knee.rot[0] + (P.weightSide > 0 ? -6 : 6) * fid, 0, 0); p.r_knee = J(base.r_knee.rot[0] + (P.weightSide > 0 ? 6 : -6) * fid, 0, 0); }
      }
      keys.push({ t: r3(f * duration), poses: p, ease: ["CubicV2", "InOut"], tag: i === 0 ? "start" : fid > 0.5 ? "fidget" : "breath" });
    }
    return keys;
  }
  function emoteKeys(action, k, style, duration, q) {
    const base = stance(k, style); const keys = [];
    const push = (f, o, ease, tag) => keys.push({ t: r3(f * duration), poses: withOverrides(base, o), ease: ease || ["CubicV2", "InOut"], tag: tag || "beat" });
    const V = (PERSONA && PERSONA.emoteVariant) || 0;
    if (action === "wave" && V === 1) { // both hands, big
      push(0, {}, ["CubicV2", "In"], "start");
      push(0.18, { l_shoulder: J(165 * k, 0, -40), r_shoulder: J(165 * k, 0, 40), l_elbow: J(50, 0, 0), r_elbow: J(50, 0, 0), waist: J(4, 0, 0), neck: J(-8, 0, 0), root: { rot: [2, 0, 0], pos: [0, 0.05, 0] } }, ["CubicV2", "Out"], "raise");
      for (let i = 0; i < 3; i++) { push(0.28 + i * 0.2, { l_shoulder: J(165 * k, 0, -55), r_shoulder: J(165 * k, 0, 25), l_elbow: J(35, 0, 0), r_elbow: J(35, 0, 0), l_wrist: J(0, 0, 25 * k), r_wrist: J(0, 0, 25 * k), waist: J(4, 0, 6), neck: J(-8, 0, -6) }, ["CubicV2", "InOut"], "wave"); push(0.38 + i * 0.2, { l_shoulder: J(165 * k, 0, -25), r_shoulder: J(165 * k, 0, 55), l_elbow: J(65, 0, 0), r_elbow: J(65, 0, 0), l_wrist: J(0, 0, -25 * k), r_wrist: J(0, 0, -25 * k), waist: J(4, 0, -6), neck: J(-8, 0, 6) }, ["CubicV2", "InOut"], "wave"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "wave" && V === 2) { // shy little wave: elbow bent, hand near the shoulder
      push(0, {}, ["CubicV2", "In"], "start");
      push(0.22, { r_shoulder: J(40 * k, 0, 20), r_elbow: J(130, 0, 0), r_wrist: J(0, 0, 0), waist: J(2, -5, -4), neck: J(4, -6, 8) }, ["CubicV2", "Out"], "raise");
      for (let i = 0; i < 4; i++) { push(0.3 + i * 0.14, { r_shoulder: J(40 * k, 0, 22), r_elbow: J(125, 0, 0), r_wrist: J(0, 0, -22 * k), waist: J(2, -5, -4), neck: J(4, -6, 8) }, ["CubicV2", "InOut"], "wave"); push(0.37 + i * 0.14, { r_shoulder: J(40 * k, 0, 18), r_elbow: J(135, 0, 0), r_wrist: J(0, 0, 22 * k), waist: J(2, -5, -4), neck: J(4, -6, 8) }, ["CubicV2", "InOut"], "wave"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "salute") {
      push(0, {}, ["CubicV2", "In"], "start"); push(0.25, { r_shoulder: J(100 * k, -20, 75 * k), r_elbow: J(140, 0, 0), r_wrist: J(-15, 0, 20), waist: J(4, 0, 0), neck: J(-4, 0, 0), l_shoulder: J(2, 0, -4), root: { rot: [1, 0, 0], pos: [0, 0.03, 0] } }, ["Cubic", "Out"], "impact");
      push(0.72, { r_shoulder: J(100 * k, -20, 75 * k), r_elbow: J(140, 0, 0), r_wrist: J(-15, 0, 20), waist: J(4, 0, 0), neck: J(-4, 0, 0), l_shoulder: J(2, 0, -4), root: { rot: [1, 0, 0], pos: [0, 0.03, 0] } }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "facepalm") {
      push(0, {}, ["CubicV2", "In"], "start"); push(0.3, { r_shoulder: J(110 * k, -30, 40), r_elbow: J(145, 0, 0), r_wrist: J(-30, 0, 0), neck: J(28 * k, 0, 6), waist: J(-10 * k, 0, 0), root: { rot: [-3, 0, 0], pos: [0, -0.05, 0] }, l_shoulder: J(10, 0, -20), l_elbow: J(30, 0, 0) }, ["CubicV2", "Out"], "impact");
      push(0.55, { r_shoulder: J(112 * k, -30, 40), r_elbow: J(145, 0, 0), r_wrist: J(-30, 0, 0), neck: J(32 * k, -10, 6), waist: J(-12 * k, -4, 0), root: { rot: [-3, 0, 0], pos: [0, -0.06, 0] }, l_shoulder: J(10, 0, -20), l_elbow: J(30, 0, 0) }, ["CubicV2", "InOut"], "hold");
      push(0.75, { r_shoulder: J(112 * k, -30, 40), r_elbow: J(145, 0, 0), r_wrist: J(-30, 0, 0), neck: J(32 * k, 10, 6), waist: J(-12 * k, 4, 0), root: { rot: [-3, 0, 0], pos: [0, -0.06, 0] }, l_shoulder: J(10, 0, -20), l_elbow: J(30, 0, 0) }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "shrug") {
      push(0, {}, ["CubicV2", "In"], "start"); push(0.3, { l_shoulder: J(30 * k, 60, -40), r_shoulder: J(30 * k, -60, 40), l_elbow: J(110, 0, 0), r_elbow: J(110, 0, 0), l_wrist: J(0, 0, 40), r_wrist: J(0, 0, -40), waist: J(4, 0, 0), neck: J(-6, 0, 14 * k), root: { rot: [2, 0, 0], pos: [0, 0.04, 0] } }, ["Cubic", "Out"], "impact");
      push(0.6, { l_shoulder: J(30 * k, 60, -42), r_shoulder: J(30 * k, -60, 42), l_elbow: J(112, 0, 0), r_elbow: J(112, 0, 0), l_wrist: J(0, 0, 40), r_wrist: J(0, 0, -40), waist: J(4, 0, 0), neck: J(-6, 0, 16 * k), root: { rot: [2, 0, 0], pos: [0, 0.05, 0] } }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "taunt") {
      push(0, {}, ["CubicV2", "In"], "start"); push(0.2, { r_shoulder: J(80 * k, 0, 25), r_elbow: J(70, 0, 0), r_wrist: J(30, 0, 0), waist: J(6 * k, -10, 0), neck: J(-8, 8, -6), root: { rot: [4 * k, 0, 0], pos: [0, 0, 0.1] }, l_shoulder: J(20, 0, -30), l_elbow: J(80, 0, 0) }, ["CubicV2", "Out"], "raise");
      for (let i = 0; i < 3; i++) { push(0.3 + i * 0.18, { r_shoulder: J(78 * k, 0, 25), r_elbow: J(95, 0, 0), r_wrist: J(-30 * k, 0, 0), waist: J(6 * k, -10, 0), neck: J(-8, 8, -6), root: { rot: [4 * k, 0, 0], pos: [0, 0, 0.1] }, l_shoulder: J(20, 0, -30), l_elbow: J(80, 0, 0) }, ["Cubic", "Out"], "impact"); push(0.39 + i * 0.18, { r_shoulder: J(80 * k, 0, 25), r_elbow: J(70, 0, 0), r_wrist: J(30, 0, 0), waist: J(6 * k, -10, 0), neck: J(-8, 8, -6), root: { rot: [4 * k, 0, 0], pos: [0, 0, 0.1] }, l_shoulder: J(20, 0, -30), l_elbow: J(80, 0, 0) }, ["CubicV2", "InOut"], "beat"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "nod" || action === "headshake") {
      const nods = action === "nod" ? 2 : 3;
      push(0, {}, ["CubicV2", "In"], "start");
      for (let i = 0; i < nods; i++) { const f0 = 0.15 + i * (0.6 / nods), s = i % 2 ? -1 : 1; push(f0, action === "nod" ? { neck: J(-18 * k, 0, 0), waist: J(-3, 0, 0) } : { neck: J(0, s * 38 * k, 0), waist: J(0, s * 6, 0) }, ["CubicV2", "InOut"], "beat"); push(f0 + 0.3 / nods, action === "nod" ? { neck: J(6 * k, 0, 0), waist: J(1, 0, 0) } : { neck: J(0, -s * 38 * k, 0), waist: J(0, -s * 6, 0) }, ["CubicV2", "InOut"], "beat"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "wave") {
      push(0, {}, ["CubicV2", "In"], "start");
      push(0.2, { r_shoulder: J(160 * k, 0, 35), r_elbow: J(60, 0, 0), r_wrist: J(0, 0, 0), waist: J(0, -8, -3), neck: J(0, -8, 4) }, ["CubicV2", "Out"], "raise");
      for (let i = 0; i < 3; i++) { push(0.3 + i * 0.2, { r_shoulder: J(160 * k, 0, 35), r_elbow: J(40, 0, 0), r_wrist: J(0, 0, -30 * k), waist: J(0, -8, -3), neck: J(0, -8, 4) }, ["CubicV2", "InOut"], "wave"); push(0.4 + i * 0.2, { r_shoulder: J(160 * k, 0, 35), r_elbow: J(70, 0, 0), r_wrist: J(0, 0, 30 * k), waist: J(0, -8, -3), neck: J(0, -8, 4) }, ["CubicV2", "InOut"], "wave"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "cheer" && V === 1) { // fist pumps
      push(0, {}, ["CubicV2", "In"], "start");
      for (let i = 0; i < 2; i++) { push(0.15 + i * 0.35, { r_shoulder: J(40 * k, 0, 30), r_elbow: J(150, 0, 0), r_wrist: J(-20, 0, 0), waist: J(-12 * k, -14, 4), neck: J(4, 10, 0), root: { rot: [-5, 0, 0], pos: [0, -0.1, 0] }, l_shoulder: J(10, 0, -20), l_knee: J(-20, 0, 0), r_knee: J(-20, 0, 0) }, ["CubicV2", "In"], "anticipation"); push(0.3 + i * 0.35, { r_shoulder: J(150 * k, 0, 30), r_elbow: J(60, 0, 0), r_wrist: J(-20, 0, 0), waist: J(8 * k, 10, -4), neck: J(-14, -8, 0), root: { rot: [5, 0, 0], pos: [0, 0.12 * k, 0] }, l_shoulder: J(-15, 0, -20), l_elbow: J(40, 0, 0) }, ["Cubic", "Out"], "impact"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "cheer") {
      push(0, { l_knee: J(-20, 0, 0), r_knee: J(-20, 0, 0), root: { rot: [-5, 0, 0], pos: [0, -0.15, 0] } }, ["CubicV2", "In"], "anticipation");
      push(0.3, { l_shoulder: J(175 * k, 0, -25), r_shoulder: J(175 * k, 0, 25), l_elbow: J(25, 0, 0), r_elbow: J(25, 0, 0), waist: J(10 * k, 0, 0), neck: J(-20, 0, 0), root: { rot: [6, 0, 0], pos: [0, 0.45 * k, 0] }, l_ankle: J(-20, 0, 0), r_ankle: J(-20, 0, 0) }, ["CubicV2", "Out"], "impact");
      push(0.55, { l_shoulder: J(170 * k, 0, -40), r_shoulder: J(170 * k, 0, 40), l_elbow: J(35, 0, 0), r_elbow: J(35, 0, 0), waist: J(6, 0, 0), neck: J(-15, 0, 0), root: { rot: [2, 0, 0], pos: [0, -0.2 * k, 0] }, l_knee: J(-30, 0, 0), r_knee: J(-30, 0, 0) }, ["Bounce", "Out"], "land");
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "dance" && V === 1) { // arm-wave groove: shoulders roll, hips twist, feet planted
      for (let i = 0; i <= 8; i++) { const f = i / 8, ph = f * Math.PI * 2; push(f, { root: { rot: [-3 + Math.sin(ph * 2) * 3, Math.sin(ph) * 10 * k, Math.sin(ph) * 5], pos: [0, -0.08 + Math.abs(Math.sin(ph * 2)) * 0.1, 0] }, waist: J(-6 + Math.sin(ph * 2) * 6, -Math.sin(ph) * 22 * k, Math.cos(ph) * 8), neck: J(Math.sin(ph * 2) * 8, Math.sin(ph) * 14, -Math.cos(ph) * 6), l_shoulder: J(90 * k + Math.sin(ph) * 50 * k, 0, -30 - Math.cos(ph) * 20), r_shoulder: J(90 * k - Math.sin(ph) * 50 * k, 0, 30 + Math.cos(ph) * 20), l_elbow: J(70 + Math.cos(ph) * 40, 0, 0), r_elbow: J(70 - Math.cos(ph) * 40, 0, 0), l_wrist: J(Math.sin(ph) * 30, 0, 0), r_wrist: J(-Math.sin(ph) * 30, 0, 0), l_knee: J(-14 - Math.abs(Math.sin(ph * 2)) * 14, 0, 0), r_knee: J(-14 - Math.abs(Math.cos(ph * 2)) * 14, 0, 0) }, ["CubicV2", "InOut"], i === 0 || i === 8 ? "start" : "beat"); }
    } else if (action === "dance" && V === 2) { // bounce + point: hop on the beat, alternate pointing arms
      for (let i = 0; i <= 8; i++) { const f = i / 8, s = i % 2 ? 1 : -1, hop = i % 2 ? 0.18 * k : 0; push(f, { root: { rot: [-4, s * 18 * k, 0], pos: [0, -0.1 + hop, 0] }, waist: J(-6, -s * 18 * k, s * 4), neck: J(-4, s * 10, -s * 4), l_shoulder: J(s > 0 ? 150 * k : 30, 0, s > 0 ? -45 : -20), r_shoulder: J(s < 0 ? 150 * k : 30, 0, s < 0 ? 45 : 20), l_elbow: J(s > 0 ? 10 : 90, 0, 0), r_elbow: J(s < 0 ? 10 : 90, 0, 0), l_hip: J(10, 0, -6), r_hip: J(10, 0, 6), l_knee: J(i % 2 ? -10 : -32, 0, 0), r_knee: J(i % 2 ? -10 : -32, 0, 0), l_ankle: J(i % 2 ? -15 : 6, 0, 0), r_ankle: J(i % 2 ? -15 : 6, 0, 0) }, i % 2 ? ["Cubic", "Out"] : ["CubicV2", "In"], i === 0 || i === 8 ? "start" : i % 2 ? "impact" : "beat"); }
    } else if (action === "dance") {
      for (let i = 0; i <= 8; i++) { const s = i % 2 ? 1 : -1, f = i / 8; push(f, { root: { rot: [0, s * 12 * k, s * 6], pos: [s * 0.2, -0.12 + (i % 2) * 0.1, 0] }, waist: J(-5, -s * 20 * k, -s * 8), neck: J(0, s * 15, s * 5), l_shoulder: J(s > 0 ? 120 * k : 20, 0, -30), r_shoulder: J(s < 0 ? 120 * k : 20, 0, 30), l_elbow: J(70, 0, 0), r_elbow: J(70, 0, 0), l_hip: J(s > 0 ? 20 : -10, 0, -8), r_hip: J(s < 0 ? 20 : -10, 0, 8), l_knee: J(-30 - (s > 0 ? 20 : 0), 0, 0), r_knee: J(-30 - (s < 0 ? 20 : 0), 0, 0) }, ["CubicV2", "InOut"], i === 0 || i === 8 ? "start" : "beat"); }
    } else if (action === "point" && V === 1) { // point up at the sky
      push(0, {}, ["CubicV2", "In"], "start"); push(0.3, { r_shoulder: J(170 * k, 0, 15), r_elbow: J(5, 0, 0), r_wrist: J(0, 0, 0), waist: J(8 * k, -6, 0), neck: J(-30 * k, -4, 0), root: { rot: [3, 0, 0], pos: [0, 0.03, 0] } }, ["CubicV2", "Out"], "impact"); push(0.75, { r_shoulder: J(168 * k, 0, 15), r_elbow: J(8, 0, 0), waist: J(8 * k, -6, 0), neck: J(-32 * k, -4, 0), root: { rot: [3, 0, 0], pos: [0, 0.03, 0] } }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "point" && V === 2) { // point to the side
      push(0, {}, ["CubicV2", "In"], "start"); push(0.3, { r_shoulder: J(20 * k, 0, 95 * k), r_elbow: J(5, 0, 0), r_wrist: J(0, 0, 0), waist: J(-2, -30, 4), neck: J(0, -45, 0), root: { rot: [0, -8, 0], pos: [0, 0, 0] } }, ["CubicV2", "Out"], "impact"); push(0.75, { r_shoulder: J(18 * k, 0, 94 * k), r_elbow: J(8, 0, 0), waist: J(-2, -30, 4), neck: J(0, -48, 0), root: { rot: [0, -8, 0], pos: [0, 0, 0] } }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "point") {
      push(0, {}, ["CubicV2", "In"], "start"); push(0.3, { r_shoulder: J(95 * k, 0, 10), r_elbow: J(5, 0, 0), r_wrist: J(0, 0, 0), waist: J(-4, -10, 0), neck: J(0, -10, 0) }, ["CubicV2", "Out"], "impact"); push(0.75, { r_shoulder: J(92 * k, 0, 10), r_elbow: J(8, 0, 0), waist: J(-4, -10, 0), neck: J(0, -10, 0) }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "clap" && V === 1) { // slow overhead clap
      push(0, {}, ["CubicV2", "In"], "start");
      for (let i = 0; i < 3; i++) { push(0.18 + i * 0.26, { l_shoulder: J(170 * k, 30, -10), r_shoulder: J(170 * k, -30, 10), l_elbow: J(25, 0, 0), r_elbow: J(25, 0, 0), waist: J(6, 0, 0), neck: J(-12, 0, 0) }, ["Linear", "Out"], "impact"); push(0.31 + i * 0.26, { l_shoulder: J(165 * k, 10, -40), r_shoulder: J(165 * k, -10, 40), l_elbow: J(30, 0, 0), r_elbow: J(30, 0, 0), waist: J(6, 0, 0), neck: J(-12, 0, 0) }, ["CubicV2", "InOut"], "open"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "clap") {
      push(0, {}, ["CubicV2", "In"], "start");
      for (let i = 0; i < 4; i++) { push(0.15 + i * 0.2, { l_shoulder: J(70 * k, 35, -20), r_shoulder: J(70 * k, -35, 20), l_elbow: J(95, 0, 0), r_elbow: J(95, 0, 0) }, ["Linear", "Out"], "impact"); push(0.25 + i * 0.2, { l_shoulder: J(70 * k, 15, -35), r_shoulder: J(70 * k, -15, 35), l_elbow: J(85, 0, 0), r_elbow: J(85, 0, 0) }, ["CubicV2", "InOut"], "open"); }
      push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "laugh") {
      for (let i = 0; i <= 6; i++) { const f = i / 6, s = i % 2 ? 1 : 0; push(f, { waist: J(-6 - s * 14 * k, 0, 0), neck: J(-10 + s * 22 * k, 0, 0), root: { rot: [-4 - s * 6, 0, 0], pos: [0, -0.05 * s, 0] }, l_shoulder: J(30, 0, -14 + s * 10), r_shoulder: J(30, 0, 14 - s * 10), l_elbow: J(60 + s * 20, 0, 0), r_elbow: J(60 + s * 20, 0, 0) }, ["CubicV2", "InOut"], i === 0 || i === 6 ? "start" : "beat"); }
    } else if (action === "bow" && V === 1) { // theatrical bow with an arm flourish
      push(0, {}, ["CubicV2", "In"], "start"); push(0.2, { r_shoulder: J(160 * k, 0, 40), r_elbow: J(20, 0, 0), r_wrist: J(0, 0, 20), waist: J(6, 0, 0), neck: J(-8, 0, 0), l_shoulder: J(-20, 0, -14), l_elbow: J(30, 0, 0) }, ["CubicV2", "Out"], "raise");
      push(0.5, { waist: J(-50 * k, 0, 0), neck: J(16, 0, 0), root: { rot: [-22 * k, 0, 0], pos: [0, -0.12, 0.15] }, r_shoulder: J(60 * k, 30, 110 * k), r_elbow: J(30, 0, 0), r_wrist: J(0, 0, 30), l_shoulder: J(-30, 0, -14), l_elbow: J(40, 0, 0), l_hip: J(10, 0, -6), r_hip: J(-15, 0, 10), l_knee: J(-14, 0, 0), r_knee: J(-10, 0, 0), r_ankle: J(14, 0, 0) }, ["CubicV2", "Out"], "impact");
      push(0.75, { waist: J(-50 * k, 0, 0), neck: J(18, 0, 0), root: { rot: [-22 * k, 0, 0], pos: [0, -0.12, 0.15] }, r_shoulder: J(60 * k, 30, 112 * k), r_elbow: J(30, 0, 0), r_wrist: J(0, 0, 30), l_shoulder: J(-30, 0, -14), l_elbow: J(40, 0, 0), l_hip: J(10, 0, -6), r_hip: J(-15, 0, 10), l_knee: J(-14, 0, 0), r_knee: J(-10, 0, 0), r_ankle: J(14, 0, 0) }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    } else if (action === "bow") {
      push(0, {}, ["CubicV2", "In"], "start"); push(0.35, { waist: J(-55 * k, 0, 0), neck: J(20, 0, 0), root: { rot: [-20 * k, 0, 0], pos: [0, -0.1, 0.15] }, l_shoulder: J(25, 0, -10), r_shoulder: J(40, 40, 10), r_elbow: J(110, 0, 0), l_knee: J(-12, 0, 0), r_knee: J(-12, 0, 0) }, ["CubicV2", "Out"], "impact"); push(0.7, { waist: J(-55 * k, 0, 0), neck: J(22, 0, 0), root: { rot: [-20 * k, 0, 0], pos: [0, -0.1, 0.15] }, l_shoulder: J(25, 0, -10), r_shoulder: J(40, 40, 10), r_elbow: J(110, 0, 0) }, ["CubicV2", "InOut"], "hold"); push(1.0, {}, ["CubicV2", "Out"], "end");
    }
    return keys;
  }

  // ───────────────────────── 1.55 freeform choreography: ANY prompt becomes its own motion ─────────────────────────
  // Before 1.55 a prompt the keyword classifier did not know ("drink a potion", "play guitar", "open a heavy door") fell
  // back to the same idle. Now: (1) an ACT lexicon of everyday / sport / work / social motions, (2) a pose grammar
  // ("raise the left arm", "turn head right", "lean back"), (3) MOOD overlays (drunk, tired, sad, proud, scared, old,
  // injured, happy, angry, cold), (4) "A then B then C" clause sequencing across every category, (5) "X while walking"
  // layering, and (6) a seeded gesture improvisation that is reported as such when nothing at all is recognised.
  const SHORT = { ro: "root", wa: "waist", ne: "neck", ls: "l_shoulder", le: "l_elbow", lw: "l_wrist", rs: "r_shoulder", re: "r_elbow", rw: "r_wrist", lh: "l_hip", lk: "l_knee", la: "l_ankle", rh: "r_hip", rk: "r_knee", ra: "r_ankle" };
  function X(o, k) { // compact pose → override map; numbers scale with k except positions / root
    k = k == null ? 1 : k; const out = {};
    for (const key of Object.keys(o)) {
      if (key === "rp") continue;
      const v = o[key]; if (key === "ro") { out.root = { rot: v.slice(), pos: (o.rp || [0, 0, 0]).slice() }; continue; }
      const j = SHORT[key]; if (!j) continue; out[j] = J(v[0] * k, v[1] * k, v[2] * k);
    }
    if (o.rp && !out.root) out.root = { rot: [0, 0, 0], pos: o.rp.slice() };
    return out;
  }
  const B = (at, p, tag, ease) => [at, p, tag, ease];
  // arm vocab (right side; the left side mirrors y/z)
  const ARM = { mouth: { rs: [60, -25, 25], re: [140, 0, 0], rw: [-20, 0, 0] }, chin: { rs: [50, -30, 25], re: [145, 0, 0], rw: [-10, 0, 0] }, ear: { rs: [40, -25, 45], re: [150, 0, 0], rw: [0, 0, -20] }, head: { rs: [150, -30, 45], re: [145, 0, 0] }, face: { rs: [110, -30, 30], re: [145, 0, 0], rw: [-30, 0, 0] },
    fwd: { rs: [90, 0, 10], re: [5, 0, 0] }, up: { rs: [170, 0, 15], re: [5, 0, 0] }, out: { rs: [10, 0, 90], re: [5, 0, 0] }, hip: { rs: [20, 0, 35], re: [70, 0, 0], rw: [0, 0, -25] }, chest: { rs: [60, -40, 20], re: [120, 0, 0] }, down: { rs: [5, 0, 6], re: [8, 0, 0] } };
  const L = (o) => { const m = {}; for (const key of Object.keys(o)) { const v = o[key]; m[{ rs: "ls", re: "le", rw: "lw", rh: "lh", rk: "lk", ra: "la" }[key] || key] = [v[0], -v[1], -v[2]]; } return m; };
  const both = (o) => Object.assign({}, o, L(o));
  const osc = (n, a0, a1, mk) => { const out = []; for (let i = 0; i < n; i++) { out.push(B(a0 + (i + 0.25) * (a1 - a0) / n, mk(1, i), "beat", ["CubicV2", "InOut"])); out.push(B(a0 + (i + 0.75) * (a1 - a0) / n, mk(-1, i), "beat", ["CubicV2", "InOut"])); } return out; };
  const ACTS = {
    drink: { re: "drink(?:s|ing)?|sip(?:s|ping)?|chug(?:s|ging)?|gulp|potion|coffee|tea|beer|soda|water bottle", d: 2.4, up: true, b: [B(0.28, Object.assign({}, ARM.mouth, { ne: [6, 0, 0] }), "reach", ["CubicV2", "Out"]), B(0.45, Object.assign({}, ARM.mouth, { rw: [-45, 0, 0], ne: [-22, 0, 0], wa: [4, 0, 0] }), "hold"), B(0.72, Object.assign({}, ARM.mouth, { rw: [-45, 0, 0], ne: [-24, 0, 0], wa: [4, 0, 0] }), "hold")] },
    eat: { n0: 2, re: "eat(?:s|ing)?|bite(?:s)?|chew(?:s|ing)?|snack(?:s|ing)?|munch(?:es|ing)?|apple|sandwich|burger|pizza|cookie", d: 2.6, up: true, b: (k, n) => [B(0.2, Object.assign({}, ARM.mouth, { ne: [8, 0, 0] }), "reach"), ...osc(n || 2, 0.3, 0.85, (s) => s > 0 ? Object.assign({}, ARM.mouth, { ne: [14, 0, 2], rw: [-30, 0, 0] }) : Object.assign({}, ARM.chest, { ne: [2, 0, -2] }))] },
    guitar: { re: "guitar|strum(?:s|ming)?|ukulele|bass solo|shred(?:s|ding)?", d: 1.2, loop: true, up: true, b: (k, n) => [B(0, { ls: [70, 30, -50], le: [110, 0, 0], lw: [0, 20, 0], rs: [45, -20, 10], re: [110, 0, 0], rw: [30, 0, 0], wa: [-4, -8, 4], ne: [10, -10, 6] }, "start"), ...osc(n || 2, 0.1, 0.9, (s, i) => ({ ls: [70, 30, -50], le: [108 + (i % 2) * 6, 0, 0], lw: [0, 20 + s * 8, 0], rs: [45, -20, 10], re: [110, 0, 0], rw: [s * 40, 0, 0], wa: [-4, -8, 4 + s * 3], ne: [10 - s * 6, -10, 6] })), B(1, { ls: [70, 30, -50], le: [110, 0, 0], lw: [0, 20, 0], rs: [45, -20, 10], re: [110, 0, 0], rw: [30, 0, 0], wa: [-4, -8, 4], ne: [10, -10, 6] }, "loop_end")] },
    drums: { re: "drum(?:s|ming|mer)?|drum ?kit|percussion", d: 0.8, loop: true, up: true, b: (k) => [B(0, { rs: [50, -10, 20], re: [70, 0, 0], rw: [-30, 0, 0], ls: [50, 10, -20], le: [110, 0, 0], lw: [20, 0, 0], ne: [12, 0, 0], wa: [-6, 0, 0] }, "start"), B(0.25, { rs: [50, -10, 20], re: [110, 0, 0], rw: [20, 0, 0], ls: [50, 10, -20], le: [70, 0, 0], lw: [-30, 0, 0], ne: [8, 0, 0], wa: [-6, 0, 0] }, "impact", ["Linear", "Out"]), B(0.5, { rs: [50, -10, 20], re: [70, 0, 0], rw: [-30, 0, 0], ls: [50, 10, -20], le: [110, 0, 0], lw: [20, 0, 0], ne: [12, 0, 0], wa: [-6, 0, 0] }, "impact", ["Linear", "Out"]), B(0.75, { rs: [50, -10, 20], re: [110, 0, 0], rw: [20, 0, 0], ls: [50, 10, -20], le: [70, 0, 0], lw: [-30, 0, 0], ne: [8, 0, 0], wa: [-6, 0, 0] }, "impact", ["Linear", "Out"]), B(1, { rs: [50, -10, 20], re: [70, 0, 0], rw: [-30, 0, 0], ls: [50, 10, -20], le: [110, 0, 0], lw: [20, 0, 0], ne: [12, 0, 0], wa: [-6, 0, 0] }, "loop_end")] },
    typing: { re: "typ(?:e|es|ing)|keyboard|laptop|computer|piano|hack(?:s|ing|er)?|coding|programming", d: 1.0, loop: true, up: true, b: (k) => [B(0, { rs: [55, -10, 8], re: [95, 0, 0], rw: [10, 0, 0], ls: [55, 10, -8], le: [95, 0, 0], lw: [-10, 0, 0], ne: [14, 0, 0], wa: [-5, 0, 0] }, "start"), ...osc(2, 0.05, 0.95, (s) => ({ rs: [55, -10, 8], re: [95, 0, 0], rw: [s * 18, 0, 0], ls: [55, 10, -8], le: [95, 0, 0], lw: [-s * 18, 0, 0], ne: [14, s * 4, 0], wa: [-5, 0, 0] })), B(1, { rs: [55, -10, 8], re: [95, 0, 0], rw: [10, 0, 0], ls: [55, 10, -8], le: [95, 0, 0], lw: [-10, 0, 0], ne: [14, 0, 0], wa: [-5, 0, 0] }, "loop_end")] },
    phone: { re: "phone call|on the phone|phone|call(?:s|ing)? (?:someone|a friend|home|mom|dad)|talk(?:s|ing)? on", d: 3, loop: true, up: true, b: [B(0, Object.assign({}, ARM.ear, L(ARM.hip), { ne: [2, -8, 10] }), "start"), B(0.35, Object.assign({}, ARM.ear, L(ARM.hip), { ne: [-4, 6, 12], wa: [0, 6, 0] }), "beat"), B(0.7, Object.assign({}, ARM.ear, L(ARM.hip), { ne: [6, -12, 8], wa: [0, -4, 0] }), "beat"), B(1, Object.assign({}, ARM.ear, L(ARM.hip), { ne: [2, -8, 10] }), "loop_end")] },
    selfie: { re: "selfie|take(?:s)? a (?:photo|picture|pic)|photo pose", d: 2.6, up: true, b: [B(0.3, { rs: [150, -25, 35], re: [45, 0, 0], rw: [-20, 0, 0], ne: [-8, 12, -14], wa: [2, 8, -4] }, "reach"), B(0.5, { rs: [152, -25, 35], re: [45, 0, 0], rw: [-20, 0, 0], ne: [-10, 14, -16], wa: [2, 8, -5] }, "hold"), B(0.75, { rs: [152, -25, 35], re: [45, 0, 0], rw: [-20, 0, 0], ne: [-10, 14, -16], wa: [2, 8, -5] }, "hold")] },
    headbang: { re: "head ?bang(?:s|ing)?|rock out|rocking out|mosh|metal", d: 0.6, loop: true, up: true, b: (k) => [B(0, { ne: [-30, 0, 0], wa: [8, 0, 0], rs: [120, 0, 30], re: [120, 0, 0], ls: [120, 0, -30], le: [120, 0, 0] }, "start"), B(0.5, { ne: [40, 0, 0], wa: [-14, 0, 0], rs: [100, 0, 30], re: [130, 0, 0], ls: [100, 0, -30], le: [130, 0, 0], ro: [-4, 0, 0] }, "impact", ["CubicV2", "In"]), B(1, { ne: [-30, 0, 0], wa: [8, 0, 0], rs: [120, 0, 30], re: [120, 0, 0], ls: [120, 0, -30], le: [120, 0, 0] }, "loop_end")] },
    door: { re: "open(?:s|ing)? (?:a |the )?(?:heavy |big |front |back )?(?:door|gate|chest|lid)|push(?:es|ing)? (?:the |a )?door|pull(?:s|ing)? (?:the |a )?door", d: 2.4, b: [B(0.25, { rs: [85, 0, 5], re: [10, 0, 0], rw: [0, 0, 0], lh: [25, 0, -4], lk: [-20, 0, 0], wa: [-6, -8, 0], ro: [-3, 0, 0] }, "reach", ["CubicV2", "Out"]), B(0.4, { rs: [80, 0, 5], re: [15, 0, 0], rw: [0, 0, 0], lh: [25, 0, -4], lk: [-20, 0, 0], wa: [-8, -8, 0], ro: [-4, 0, 0] }, "contact", ["Linear", "Out"]), B(0.7, { rs: [30, 0, 8], re: [95, 0, 0], rw: [-10, 0, 0], lh: [-10, 0, -4], lk: [-10, 0, 0], rh: [15, 0, 4], rk: [-15, 0, 0], wa: [6, 18, 0], ro: [4, 8, 0], rp: [0, 0, 0.2] }, "pull")] },
    knock: { n0: 3, re: "knock(?:s|ing)?(?: on)?(?: the)?(?: door)?", d: 1.6, up: true, b: (k, n) => [B(0.2, { rs: [80, -10, 10], re: [90, 0, 0], rw: [-20, 0, 0] }, "reach"), ...osc(n || 3, 0.28, 0.8, (s) => ({ rs: [80, -10, 10], re: [s > 0 ? 70 : 95, 0, 0], rw: [s > 0 ? 10 : -25, 0, 0] })).map((b, i) => (i % 2 === 0 ? [b[0], b[1], "impact", ["Linear", "Out"]] : b))] },
    think: { re: "think(?:s|ing)?|ponder(?:s|ing)?|hmm+|wonder(?:s|ing)?|puzzled|confused|contemplat(?:e|es|ing)|idea", d: 3, loop: true, up: true, b: [B(0, Object.assign({}, ARM.chin, L(ARM.chest), { ne: [10, -8, 8], wa: [-3, 4, 0] }), "start"), B(0.45, Object.assign({}, ARM.chin, L(ARM.chest), { ne: [6, 10, 6], wa: [-3, -3, 0], rw: [-14, 0, 0] }), "beat"), B(0.75, Object.assign({}, ARM.chin, L(ARM.chest), { ne: [14, -14, 10], wa: [-3, 6, 0] }), "beat"), B(1, Object.assign({}, ARM.chin, L(ARM.chest), { ne: [10, -8, 8], wa: [-3, 4, 0] }), "loop_end")] },
    stretch: { re: "yawn(?:s|ing)?|stretch(?:es|ing)?|wake(?:s)? up|waking up|morning stretch|big stretch", d: 2.8, b: [B(0.2, { rs: [120, 0, 30], re: [60, 0, 0], ls: [120, 0, -30], le: [60, 0, 0], wa: [-4, 0, 0], ne: [8, 0, 0] }, "raise"), B(0.5, { rs: [172, 0, 25], re: [10, 0, 0], rw: [20, 0, 0], ls: [172, 0, -25], le: [10, 0, 0], lw: [20, 0, 0], wa: [12, 0, 0], ne: [-25, 0, 0], ro: [4, 0, 0], rp: [0, 0.06, 0] }, "hold"), B(0.68, { rs: [168, 0, 30], re: [12, 0, 0], rw: [20, 0, 0], ls: [168, 0, -30], le: [12, 0, 0], lw: [20, 0, 0], wa: [12, 0, 4], ne: [-26, 0, 3], ro: [4, 0, 1], rp: [0, 0.06, 0] }, "hold")] },
    shiver: { re: "shiver(?:s|ing)?|freezing|cold|brr+|chilly|teeth chatter", d: 0.5, loop: true, up: true, b: (k) => [B(0, Object.assign({}, both({ rs: [40, -30, 22], re: [125, 0, 0] }), { wa: [-10, 0, -2], ne: [12, 0, -3], ro: [-2, 0, -1] }), "start"), B(0.5, Object.assign({}, both({ rs: [42, -30, 20], re: [128, 0, 0] }), { wa: [-10, 0, 2], ne: [12, 0, 3], ro: [-2, 0, 1] }), "beat", ["Linear", "InOut"]), B(1, Object.assign({}, both({ rs: [40, -30, 22], re: [125, 0, 0] }), { wa: [-10, 0, -2], ne: [12, 0, -3], ro: [-2, 0, -1] }), "loop_end")] },
    cry: { re: "cry(?:ing)?|cries|sob(?:s|bing)?|weep(?:s|ing)?|tears|wail(?:s|ing)?", d: 3, loop: true, up: true, b: (k) => [B(0, Object.assign({}, both(ARM.face), { ne: [26, 0, 0], wa: [-12, 0, 0], ro: [-4, 0, 0] }), "start"), B(0.3, Object.assign({}, both({ rs: [112, -30, 32], re: [145, 0, 0], rw: [-30, 0, 0] }), { ne: [30, 0, 0], wa: [-18, 0, 0], ro: [-6, 0, 0], rp: [0, -0.04, 0] }), "beat"), B(0.5, Object.assign({}, both(ARM.face), { ne: [24, 0, 0], wa: [-10, 0, 0], ro: [-4, 0, 0] }), "beat"), B(0.75, Object.assign({}, both({ rs: [112, -30, 32], re: [145, 0, 0], rw: [-30, 0, 0] }), { ne: [30, 0, 0], wa: [-18, 0, 0], ro: [-6, 0, 0], rp: [0, -0.04, 0] }), "beat"), B(1, Object.assign({}, both(ARM.face), { ne: [26, 0, 0], wa: [-12, 0, 0], ro: [-4, 0, 0] }), "loop_end")] },
    stomp: { n0: 1, re: "stomp(?:s|ing)?|stamp(?:s|ing)? (?:the |your |their |a )?(?:foot|feet)|tantrum", d: 1.2, b: (k, n) => { const out = []; const m = n || 1; for (let i = 0; i < m; i++) { const a = 0.15 + i * 0.7 / m, w = 0.7 / m; out.push(B(a, { rh: [50, 0, 6], rk: [-80, 0, 0], ra: [15, 0, 0], wa: [6, 0, -4], ro: [3, 0, -3], rp: [-0.1, 0.05, 0], rs: [30, 0, 15], re: [110, 0, 0], ls: [30, 0, -15], le: [110, 0, 0] }, "anticipation", ["CubicV2", "In"])); out.push(B(a + w * 0.5, { rh: [2, 0, 6], rk: [-6, 0, 0], ra: [2, 0, 0], wa: [-10, 0, 2], ne: [8, 0, 0], ro: [-4, 0, 1], rp: [0, -0.08, 0], rs: [15, 0, 15], re: [120, 0, 0], ls: [15, 0, -15], le: [120, 0, 0] }, "impact", ["CubicV2", "In"])); } return out; } },
    push: { re: "push(?:es|ing)? (?:a |the )?(?:box|cart|wall|crate|boulder|rock|car|heavy)|shov(?:e|es|ing)", d: 1.4, loop: true, b: (k) => [B(0, { ro: [-16, 0, 0], rp: [0, -0.2, 0], wa: [-10, 0, 0], ne: [10, 0, 0], rs: [85, 0, 10], re: [15, 0, 0], ls: [85, 0, -10], le: [15, 0, 0], lh: [30, 0, -5], lk: [-30, 0, 0], la: [10, 0, 0], rh: [-25, 0, 5], rk: [-10, 0, 0], ra: [25, 0, 0] }, "contact"), B(0.5, { ro: [-16, 0, 0], rp: [0, -0.2, 0], wa: [-10, 0, 0], ne: [10, 0, 0], rs: [85, 0, 10], re: [15, 0, 0], ls: [85, 0, -10], le: [15, 0, 0], rh: [30, 0, 5], rk: [-30, 0, 0], ra: [10, 0, 0], lh: [-25, 0, -5], lk: [-10, 0, 0], la: [25, 0, 0] }, "contact"), B(1, { ro: [-16, 0, 0], rp: [0, -0.2, 0], wa: [-10, 0, 0], ne: [10, 0, 0], rs: [85, 0, 10], re: [15, 0, 0], ls: [85, 0, -10], le: [15, 0, 0], lh: [30, 0, -5], lk: [-30, 0, 0], la: [10, 0, 0], rh: [-25, 0, 5], rk: [-10, 0, 0], ra: [25, 0, 0] }, "loop_end")] },
    pull: { re: "pull(?:s|ing)? (?:a |the |on a |on the )?(?:rope|lever|chain|cart|sled)|tug(?:s|ging)?|haul(?:s|ing)?|tug of war", d: 1.4, loop: true, b: (k) => [B(0, { ro: [10, 0, 0], rp: [0, -0.15, 0], wa: [6, 0, 0], rs: [80, -20, 10], re: [30, 0, 0], ls: [70, 20, -10], le: [60, 0, 0], lh: [35, 0, -5], lk: [-40, 0, 0], rh: [-20, 0, 5], rk: [-15, 0, 0], ra: [20, 0, 0] }, "contact"), B(0.5, { ro: [14, 0, 0], rp: [0, -0.2, 0], wa: [10, 0, 0], rs: [40, -20, 12], re: [120, 0, 0], ls: [45, 20, -12], le: [110, 0, 0], lh: [40, 0, -5], lk: [-50, 0, 0], rh: [-25, 0, 5], rk: [-10, 0, 0], ra: [25, 0, 0] }, "impact", ["CubicV2", "In"]), B(1, { ro: [10, 0, 0], rp: [0, -0.15, 0], wa: [6, 0, 0], rs: [80, -20, 10], re: [30, 0, 0], ls: [70, 20, -10], le: [60, 0, 0], lh: [35, 0, -5], lk: [-40, 0, 0], rh: [-20, 0, 5], rk: [-15, 0, 0], ra: [20, 0, 0] }, "loop_end")] },
    dig: { re: "dig(?:s|ging)?|shovel(?:s|ing)?|spade", d: 1.8, loop: true, b: (k) => [B(0, { rs: [60, -20, 15], re: [60, 0, 0], ls: [40, 30, -20], le: [90, 0, 0], wa: [-30, 10, 0], ne: [16, 0, 0], ro: [-8, 0, 0], rp: [0, -0.25, 0], lh: [35, 0, -8], lk: [-45, 0, 0], rh: [-10, 0, 8], rk: [-20, 0, 0] }, "contact"), B(0.45, { rs: [95, -20, 15], re: [50, 0, 0], ls: [70, 30, -20], le: [100, 0, 0], wa: [4, 30, 0], ne: [0, 20, 0], ro: [2, 0, 0], rp: [0, -0.05, 0], lh: [20, 0, -8], lk: [-25, 0, 0], rh: [0, 0, 8], rk: [-10, 0, 0] }, "toss", ["CubicV2", "Out"]), B(1, { rs: [60, -20, 15], re: [60, 0, 0], ls: [40, 30, -20], le: [90, 0, 0], wa: [-30, 10, 0], ne: [16, 0, 0], ro: [-8, 0, 0], rp: [0, -0.25, 0], lh: [35, 0, -8], lk: [-45, 0, 0], rh: [-10, 0, 8], rk: [-20, 0, 0] }, "loop_end")] },
    chop: { re: "chop(?:s|ping)? (?:wood|logs?|a tree|trees|down)|hammer(?:s|ing)?|mine|mining|pickaxe|smash(?:es|ing)? (?:the |a )?rock|lumberjack|blacksmith", d: 1.1, loop: true, ex: true, b: (k) => [B(0, { rs: [160, -10, 20], re: [60, 0, 0], ls: [150, 10, -20], le: [70, 0, 0], wa: [10, 0, 0], ne: [-8, 0, 0], ro: [4, 0, 0], lh: [20, 0, -6], lk: [-15, 0, 0], rh: [-10, 0, 6] }, "anticipation", ["CubicV2", "In"]), B(0.45, { rs: [50, -10, 12], re: [25, 0, 0], ls: [40, 10, -12], le: [35, 0, 0], wa: [-34, 0, 0], ne: [14, 0, 0], ro: [-8, 0, 0], rp: [0, -0.18, 0], lh: [40, 0, -6], lk: [-40, 0, 0], rh: [-5, 0, 6], rk: [-20, 0, 0] }, "impact", ["CubicV2", "In"]), B(1, { rs: [160, -10, 20], re: [60, 0, 0], ls: [150, 10, -20], le: [70, 0, 0], wa: [10, 0, 0], ne: [-8, 0, 0], ro: [4, 0, 0], lh: [20, 0, -6], lk: [-15, 0, 0], rh: [-10, 0, 6] }, "loop_end")] },
    row: { re: "row(?:s|ing)? (?:a |the )?boat|rowing|paddl(?:e|es|ing)|kayak|canoe", d: 1.5, loop: true, b: (k) => [B(0, { rs: [85, 0, 10], re: [20, 0, 0], ls: [85, 0, -10], le: [20, 0, 0], wa: [-18, 0, 0], ne: [6, 0, 0], ro: [-6, 0, 0], rp: [0, -1.5, 0], lh: [85, 0, -8], rh: [85, 0, 8], lk: [-85, 0, 0], rk: [-85, 0, 0] }, "reach"), B(0.5, { rs: [30, -10, 12], re: [110, 0, 0], ls: [30, 10, -12], le: [110, 0, 0], wa: [14, 0, 0], ne: [-4, 0, 0], ro: [8, 0, 0], rp: [0, -1.5, 0], lh: [85, 0, -8], rh: [85, 0, 8], lk: [-85, 0, 0], rk: [-85, 0, 0] }, "pull", ["CubicV2", "Out"]), B(1, { rs: [85, 0, 10], re: [20, 0, 0], ls: [85, 0, -10], le: [20, 0, 0], wa: [-18, 0, 0], ne: [6, 0, 0], ro: [-6, 0, 0], rp: [0, -1.5, 0], lh: [85, 0, -8], rh: [85, 0, 8], lk: [-85, 0, 0], rk: [-85, 0, 0] }, "loop_end")] },
    bike: { re: "rid(?:e|es|ing) (?:a |the |my )?(?:bike|bicycle)|cycling|pedal(?:s|ing)?|exercise bike", d: 1.0, loop: true, b: (k) => [B(0, { rs: [70, 0, 10], re: [20, 0, 0], ls: [70, 0, -10], le: [20, 0, 0], wa: [-22, 0, 0], ne: [14, 0, 0], ro: [-8, 0, 0], rp: [0, -0.9, 0], lh: [95, 0, -6], lk: [-100, 0, 0], la: [10, 0, 0], rh: [25, 0, 6], rk: [-30, 0, 0], ra: [-10, 0, 0] }, "start"), B(0.5, { rs: [70, 0, 10], re: [20, 0, 0], ls: [70, 0, -10], le: [20, 0, 0], wa: [-22, 0, 0], ne: [14, 0, 0], ro: [-8, 0, 0], rp: [0, -0.9, 0], rh: [95, 0, 6], rk: [-100, 0, 0], ra: [10, 0, 0], lh: [25, 0, -6], lk: [-30, 0, 0], la: [-10, 0, 0] }, "beat"), B(1, { rs: [70, 0, 10], re: [20, 0, 0], ls: [70, 0, -10], le: [20, 0, 0], wa: [-22, 0, 0], ne: [14, 0, 0], ro: [-8, 0, 0], rp: [0, -0.9, 0], lh: [95, 0, -6], lk: [-100, 0, 0], la: [10, 0, 0], rh: [25, 0, 6], rk: [-30, 0, 0], ra: [-10, 0, 0] }, "loop_end")] },
    hang: { re: "hang(?:s|ing)? (?:from|on|off)|monkey bars|swing(?:s|ing)? on (?:a |the )?rope|rope swing|dangl(?:e|es|ing)|pull ?ups?|chin ?ups?", d: 2.0, loop: true, ex: true, b: (k) => [B(0, { rs: [176, 0, 12], re: [8, 0, 0], ls: [176, 0, -12], le: [8, 0, 0], wa: [6, 0, 0], ne: [-14, 0, 0], ro: [-14, 0, 0], rp: [0, 0.3, 0], lh: [-12, 0, -4], rh: [-12, 0, 4], lk: [-20, 0, 0], rk: [-20, 0, 0], la: [20, 0, 0], ra: [20, 0, 0] }, "start"), B(0.5, { rs: [176, 0, 12], re: [8, 0, 0], ls: [176, 0, -12], le: [8, 0, 0], wa: [-6, 0, 0], ne: [-6, 0, 0], ro: [14, 0, 0], rp: [0, 0.3, 0], lh: [22, 0, -4], rh: [22, 0, 4], lk: [-35, 0, 0], rk: [-35, 0, 0], la: [10, 0, 0], ra: [10, 0, 0] }, "beat"), B(1, { rs: [176, 0, 12], re: [8, 0, 0], ls: [176, 0, -12], le: [8, 0, 0], wa: [6, 0, 0], ne: [-14, 0, 0], ro: [-14, 0, 0], rp: [0, 0.3, 0], lh: [-12, 0, -4], rh: [-12, 0, 4], lk: [-20, 0, 0], rk: [-20, 0, 0], la: [20, 0, 0], ra: [20, 0, 0] }, "loop_end")] },
    lookaround: { re: "look(?:s|ing)? around|look(?:s|ing)? (?:left and right|both ways|behind)|glanc(?:e|es|ing)|scan(?:s|ning)?|search(?:es|ing)? (?:for|around)|lookout|binoculars|where (?:is|are|did)", d: 3.2, up: true, b: [B(0.25, { ne: [0, -48, 0], wa: [0, -16, 0], rs: [8, 0, 8] }, "beat"), B(0.42, { ne: [2, -44, 0], wa: [0, -16, 0] }, "hold"), B(0.7, { ne: [0, 50, 0], wa: [0, 18, 0], ls: [8, 0, -8] }, "beat"), B(0.85, { ne: [-4, 46, 0], wa: [0, 18, 0] }, "hold")] },
    shade: { re: "shad(?:e|es|ing) (?:the |their |my )?eyes|hand over (?:the |their |my )?eyes|look(?:s|ing)? (?:into the distance|far away)|gaz(?:e|es|ing)", d: 3, up: true, b: [B(0.25, { rs: [150, -25, 25], re: [140, 0, 0], rw: [-30, 0, 0], ne: [-4, -10, 0], wa: [2, -6, 0] }, "reach"), B(0.5, { rs: [150, -25, 25], re: [140, 0, 0], rw: [-30, 0, 0], ne: [-6, 18, 0], wa: [2, 8, 0] }, "beat"), B(0.75, { rs: [150, -25, 25], re: [140, 0, 0], rw: [-30, 0, 0], ne: [-4, -4, 0], wa: [2, 0, 0] }, "hold")] },
    wipe: { re: "wipe(?:s|d)? (?:the |their |my )?(?:sweat|brow|forehead)|phew|sweat(?:s|ing|y)?|relieved", d: 1.8, up: true, b: [B(0.3, { rs: [140, -30, 35], re: [150, 0, 0], rw: [-20, 0, 0], ne: [-6, 0, -4], wa: [2, 0, 0] }, "reach"), B(0.55, { rs: [138, -30, 40], re: [148, 0, 0], rw: [-20, 20, 0], ne: [-4, 6, -4], wa: [2, 2, 0] }, "beat"), B(0.75, { rs: [60, -10, 20], re: [90, 0, 0], ne: [4, 0, 0], wa: [-4, 0, 0], ro: [-2, 0, 0] }, "beat")] },
    flex: { re: "flex(?:es|ing)?|muscles?|biceps?|show(?:s|ing)? off|bodybuild(?:er|ing)|strong ?man|gym pose", d: 2.6, up: true, b: [B(0.25, both({ rs: [20, 0, 95], re: [140, 0, 0], rw: [-20, 0, 0] }), "raise", ["CubicV2", "Out"]), B(0.4, Object.assign({}, both({ rs: [22, 0, 96], re: [148, 0, 0], rw: [-25, 0, 0] }), { wa: [6, 0, 0], ne: [-4, 0, 0], ro: [2, 0, 0] }), "hold"), B(0.62, Object.assign({}, both({ rs: [22, 0, 96], re: [148, 0, 0], rw: [-25, 0, 0] }), { wa: [6, 0, 0], ne: [-4, -12, 0], ro: [2, 0, 0] }), "hold"), B(0.8, Object.assign({}, both({ rs: [22, 0, 96], re: [148, 0, 0], rw: [-25, 0, 0] }), { wa: [6, 0, 0], ne: [-4, 12, 0], ro: [2, 0, 0] }), "hold")] },
    sneeze: { re: "sneez(?:e|es|ing)|achoo|ah-?choo", d: 1.5, up: true, b: [B(0.3, { ne: [-26, 0, 0], wa: [8, 0, 0], ro: [3, 0, 0], rs: [70, -20, 20], re: [120, 0, 0] }, "anticipation", ["CubicV2", "In"]), B(0.45, { ne: [-30, 0, 0], wa: [10, 0, 0], ro: [4, 0, 0], rs: [80, -25, 22], re: [130, 0, 0] }, "anticipation", ["CubicV2", "In"]), B(0.55, Object.assign({}, ARM.face, { ne: [36, 0, 0], wa: [-26, 0, 0], ro: [-8, 0, 0], rp: [0, -0.1, 0] }), "impact", ["Linear", "Out"]), B(0.7, Object.assign({}, ARM.face, { ne: [30, 0, 0], wa: [-20, 0, 0], ro: [-6, 0, 0], rp: [0, -0.06, 0] }), "hold")] },
    cough: { n0: 2, re: "cough(?:s|ing)?|clear(?:s)? (?:their |my |the )?throat|choke|choking", d: 1.4, up: true, b: (k, n) => [B(0.2, Object.assign({}, ARM.mouth, { re: [135, 0, 0], ne: [6, 0, 0] }), "reach"), ...osc(n || 2, 0.3, 0.8, (s) => Object.assign({}, ARM.mouth, { re: [135, 0, 0], ne: s > 0 ? [18, 0, 0] : [4, 0, 0], wa: s > 0 ? [-14, 0, 0] : [-2, 0, 0], ro: s > 0 ? [-4, 0, 0] : [0, 0, 0] })).map((b, i) => (i % 2 === 0 ? [b[0], b[1], "impact", ["CubicV2", "In"]] : b))] },
    jacks: { re: "jumping jacks?|star jumps?", d: 0.9, loop: true, ex: true, b: (k) => [B(0, { rs: [10, 0, 12], re: [8, 0, 0], ls: [10, 0, -12], le: [8, 0, 0], lh: [0, 0, -4], rh: [0, 0, 4], lk: [-15, 0, 0], rk: [-15, 0, 0], rp: [0, -0.08, 0] }, "contact"), B(0.25, { rs: [90, 0, 60], re: [10, 0, 0], ls: [90, 0, -60], le: [10, 0, 0], lh: [5, 0, -15], rh: [5, 0, 15], lk: [-5, 0, 0], rk: [-5, 0, 0], la: [-25, 0, 0], ra: [-25, 0, 0], rp: [0, 0.3, 0] }, "launch"), B(0.5, { rs: [172, 0, 25], re: [10, 0, 0], ls: [172, 0, -25], le: [10, 0, 0], lh: [0, 0, -28], rh: [0, 0, 28], lk: [-15, 0, 0], rk: [-15, 0, 0], rp: [0, -0.08, 0] }, "contact"), B(0.75, { rs: [90, 0, 60], re: [10, 0, 0], ls: [90, 0, -60], le: [10, 0, 0], lh: [5, 0, -15], rh: [5, 0, 15], lk: [-5, 0, 0], rk: [-5, 0, 0], la: [-25, 0, 0], ra: [-25, 0, 0], rp: [0, 0.3, 0] }, "launch"), B(1, { rs: [10, 0, 12], re: [8, 0, 0], ls: [10, 0, -12], le: [8, 0, 0], lh: [0, 0, -4], rh: [0, 0, 4], lk: [-15, 0, 0], rk: [-15, 0, 0], rp: [0, -0.08, 0] }, "loop_end")] },
    squat: { re: "squat(?:s|ting)?|deep squat|air squat", d: 1.8, loop: true, b: (k) => [B(0, { rs: [8, 0, 8], ls: [8, 0, -8] }, "start"), B(0.5, { lh: [95, 0, -12], rh: [95, 0, 12], lk: [-130, 0, 0], rk: [-130, 0, 0], la: [-32, 0, 0], ra: [-32, 0, 0], rp: [0, -1.25, 0], ro: [-8, 0, 0], wa: [-18, 0, 0], ne: [10, 0, 0], rs: [85, 0, 8], re: [5, 0, 0], ls: [85, 0, -8], le: [5, 0, 0] }, "hold", ["CubicV2", "InOut"]), B(1, { rs: [8, 0, 8], ls: [8, 0, -8] }, "loop_end")] },
    lunge: { re: "lunge(?:s|ing)?|forward lunge", d: 1.8, loop: true, b: (k) => [B(0, {}, "start"), B(0.5, { rh: [60, 0, 6], rk: [-95, 0, 0], ra: [22, 0, 0], lh: [-38, 0, -6], lk: [-80, 0, 0], la: [42, 0, 0], rp: [0, -0.95, 0], ro: [-4, 0, 0], wa: [-4, 0, 0], rs: [20, 0, 35], re: [70, 0, 0], rw: [0, 0, -25], ls: [20, 0, -35], le: [70, 0, 0], lw: [0, 0, 25] }, "hold", ["CubicV2", "InOut"]), B(1, {}, "loop_end")] },
    situp: { re: "sit ?ups?|crunch(?:es)?|ab workout|abs", d: 1.6, loop: true, ex: true, b: (k) => [B(0, { ro: [86, 0, 0], rp: [0, -(ROOT_HEIGHT - 0.55), 0], wa: [-4, 0, 0], ne: [-10, 0, 0], rs: [150, -40, 40], re: [145, 0, 0], ls: [150, 40, -40], le: [145, 0, 0], lh: [70, 0, -8], rh: [70, 0, 8], lk: [-100, 0, 0], rk: [-100, 0, 0] }, "start"), B(0.5, { ro: [86, 0, 0], rp: [0, -(ROOT_HEIGHT - 0.55), 0], wa: [-48, 0, 0], ne: [-14, 0, 0], rs: [150, -40, 40], re: [145, 0, 0], ls: [150, 40, -40], le: [145, 0, 0], lh: [78, 0, -8], rh: [78, 0, 8], lk: [-100, 0, 0], rk: [-100, 0, 0] }, "hold", ["CubicV2", "InOut"]), B(1, { ro: [86, 0, 0], rp: [0, -(ROOT_HEIGHT - 0.55), 0], wa: [-4, 0, 0], ne: [-10, 0, 0], rs: [150, -40, 40], re: [145, 0, 0], ls: [150, 40, -40], le: [145, 0, 0], lh: [70, 0, -8], rh: [70, 0, 8], lk: [-100, 0, 0], rk: [-100, 0, 0] }, "loop_end")] },
    meditate: { re: "meditat(?:e|es|ing|ion)|lotus|zen|yoga|cross[- ]legged|criss ?cross", d: 4, loop: true, b: (k) => [B(0, { rp: [0, -1.85, 0], lh: [82, 40, -55], rh: [82, -40, 55], lk: [-135, 0, 0], rk: [-135, 0, 0], la: [-10, 0, 0], ra: [-10, 0, 0], wa: [2, 0, 0], ne: [4, 0, 0], rs: [22, 0, 22], re: [55, 0, 0], rw: [20, 0, 0], ls: [22, 0, -22], le: [55, 0, 0], lw: [20, 0, 0] }, "start"), B(0.5, { rp: [0, -1.85, 0], lh: [82, 40, -55], rh: [82, -40, 55], lk: [-135, 0, 0], rk: [-135, 0, 0], la: [-10, 0, 0], ra: [-10, 0, 0], wa: [5, 0, 0], ne: [0, 0, 0], rs: [24, 0, 22], re: [55, 0, 0], rw: [20, 0, 0], ls: [24, 0, -22], le: [55, 0, 0], lw: [20, 0, 0] }, "beat", ["CubicV2", "InOut"]), B(1, { rp: [0, -1.85, 0], lh: [82, 40, -55], rh: [82, -40, 55], lk: [-135, 0, 0], rk: [-135, 0, 0], la: [-10, 0, 0], ra: [-10, 0, 0], wa: [2, 0, 0], ne: [4, 0, 0], rs: [22, 0, 22], re: [55, 0, 0], rw: [20, 0, 0], ls: [22, 0, -22], le: [55, 0, 0], lw: [20, 0, 0] }, "loop_end")] },
    drive: { re: "driv(?:e|es|ing)|steering wheel|behind the wheel|racing car|car ride", d: 3, loop: true, b: (k) => { const seat = { rp: [0, -1.5, 0], lh: [85, 0, -8], rh: [85, 0, 8], lk: [-85, 0, 0], rk: [-85, 0, 0], wa: [-4, 0, 0] }; return [B(0, Object.assign({}, seat, { rs: [70, 0, 10], re: [40, 0, 0], ls: [70, 0, -10], le: [40, 0, 0], ne: [2, 0, 0] }), "start"), B(0.33, Object.assign({}, seat, { rs: [82, 0, 10], re: [30, 0, 0], ls: [58, 0, -10], le: [55, 0, 0], ne: [2, 10, 0] }), "beat"), B(0.66, Object.assign({}, seat, { rs: [58, 0, 10], re: [55, 0, 0], ls: [82, 0, -10], le: [30, 0, 0], ne: [2, -10, 0] }), "beat"), B(1, Object.assign({}, seat, { rs: [70, 0, 10], re: [40, 0, 0], ls: [70, 0, -10], le: [40, 0, 0], ne: [2, 0, 0] }), "loop_end")]; } },
    fishing: { re: "fish(?:es|ing)?|fishing rod|cast(?:s|ing)? (?:a |the )?(?:fishing )?line|reel(?:s|ing)? in", d: 3.4, ex: true, b: [B(0.15, { rs: [50, -10, 10], re: [100, 0, 0], ls: [40, 20, -15], le: [110, 0, 0], ne: [0, -4, 0] }, "ready"), B(0.35, { rs: [150, -20, 20], re: [80, 0, 0], ls: [120, 20, -20], le: [100, 0, 0], wa: [12, -10, 0], ne: [-10, 0, 0], ro: [4, 0, 0] }, "anticipation", ["CubicV2", "In"]), B(0.5, { rs: [70, -10, 10], re: [30, 0, 0], ls: [60, 20, -15], le: [60, 0, 0], wa: [-10, 12, 0], ne: [2, 0, 0], ro: [-4, 0, 0] }, "impact", ["CubicV2", "Out"]), B(0.72, { rs: [50, -10, 10], re: [100, 0, 0], rw: [25, 0, 0], ls: [40, 20, -15], le: [110, 0, 0], ne: [4, 0, 0] }, "beat"), B(0.84, { rs: [50, -10, 10], re: [100, 0, 0], rw: [-25, 0, 0], ls: [40, 20, -15], le: [110, 0, 0], ne: [4, 0, 0] }, "beat")] },
    sweep: { re: "sweep(?:s|ing)?|mop(?:s|ping)?|broom|clean(?:s|ing)? (?:the |up )?(?:floor|room|mess)|vacuum(?:s|ing)?|rak(?:e|es|ing) (?:the )?leaves", d: 1.5, loop: true, b: (k) => [B(0, { rs: [40, -20, 10], re: [40, 0, 0], ls: [30, 10, -15], le: [85, 0, 0], wa: [-14, -22, 0], ne: [10, 0, 0], ro: [-4, 0, 0], lh: [10, 0, -6], rh: [-6, 0, 6] }, "start"), B(0.5, { rs: [50, -20, 10], re: [70, 0, 0], ls: [45, 10, -15], le: [60, 0, 0], wa: [-14, 22, 0], ne: [10, 6, 0], ro: [-4, 0, 0], lh: [-6, 0, -6], rh: [10, 0, 6] }, "beat"), B(1, { rs: [40, -20, 10], re: [40, 0, 0], ls: [30, 10, -15], le: [85, 0, 0], wa: [-14, -22, 0], ne: [10, 0, 0], ro: [-4, 0, 0], lh: [10, 0, -6], rh: [-6, 0, 6] }, "loop_end")] },
    paint: { re: "paint(?:s|ing)?|draw(?:s|ing)? (?:a |on |something)|writ(?:e|es|ing)|sign(?:s|ing)? (?:a |the )?(?:paper|form|contract)|brush strokes|sketch(?:es|ing)?", d: 1.4, loop: true, up: true, b: (k) => [B(0, { rs: [80, -15, 10], re: [40, 0, 0], rw: [0, -20, 0], ne: [8, -4, 0], ls: [20, 0, -12], le: [40, 0, 0] }, "start"), B(0.5, { rs: [86, -5, 12], re: [35, 0, 0], rw: [0, 20, 0], ne: [8, 6, 0], ls: [20, 0, -12], le: [40, 0, 0] }, "beat"), B(1, { rs: [80, -15, 10], re: [40, 0, 0], rw: [0, -20, 0], ne: [8, -4, 0], ls: [20, 0, -12], le: [40, 0, 0] }, "loop_end")] },
    hug: { re: "hug(?:s|ging)?|embrace(?:s|d)?|cuddl(?:e|es|ing)", d: 2.6, up: true, b: [B(0.25, both({ rs: [70, -20, 35], re: [40, 0, 0] }), "reach", ["CubicV2", "Out"]), B(0.45, Object.assign({}, both({ rs: [80, -50, 15], re: [100, 0, 0] }), { wa: [-6, 0, 0], ne: [8, 0, 12], ro: [-2, 0, 0] }), "contact"), B(0.72, Object.assign({}, both({ rs: [82, -52, 15], re: [104, 0, 0] }), { wa: [-7, 0, 2], ne: [10, 4, 12], ro: [-2, 0, 1] }), "hold")] },
    handshake: { n0: 3, re: "hand ?shake|shake(?:s)? hands|shakes? (?:his|her|their|my) hand|greet(?:s|ing)? with a handshake", d: 2, up: true, b: (k, n) => [B(0.22, { rs: [55, 0, 8], re: [70, 0, 0], rw: [0, 0, -10], wa: [-4, -6, 0], ne: [2, 6, 0] }, "reach"), ...osc(n || 3, 0.3, 0.8, (s) => ({ rs: [55 + s * 4, 0, 8], re: [70 - s * 8, 0, 0], rw: [s * 12, 0, -10], wa: [-4, -6, 0], ne: [2, 6, 0] }))] },
    highfive: { re: "high[- ]?five|up top|slap hands", d: 1.4, up: true, b: [B(0.3, { rs: [150, -20, 25], re: [20, 0, 0], rw: [-30, 0, 0], wa: [4, -10, 0], ne: [-10, 6, 0], ro: [2, 0, 0], rp: [0, 0.05, 0] }, "impact", ["CubicV2", "Out"]), B(0.45, { rs: [146, -20, 25], re: [25, 0, 0], rw: [-25, 0, 0], wa: [2, -8, 0], ne: [-6, 6, 0] }, "hold")] },
    fistbump: { re: "fist ?bump|bump fists|dap", d: 1.4, up: true, b: [B(0.3, { rs: [70, 0, 10], re: [40, 0, 0], rw: [-20, 0, 0], wa: [-2, -6, 0], ne: [2, 4, 0] }, "impact", ["CubicV2", "Out"]), B(0.45, { rs: [68, 0, 10], re: [45, 0, 0], rw: [-20, 0, 0], wa: [-2, -6, 0], ne: [2, 4, 0] }, "hold")] },
    thumbsup: { re: "thumbs?[- ]?up|good job|well done|ok sign|approve(?:s|d)?", d: 1.8, up: true, b: [B(0.3, { rs: [60, 0, 15], re: [120, 0, 0], rw: [0, 0, 0], ne: [-4, -6, 4], wa: [2, 0, 0] }, "impact", ["CubicV2", "Out"]), B(0.65, { rs: [62, 0, 16], re: [122, 0, 0], rw: [0, 0, 0], ne: [-6, -6, 4], wa: [2, 0, 0] }, "hold")] },
    blowkiss: { re: "blow(?:s|ing)? (?:a )?kiss|kiss(?:es)?|smooch|mwah", d: 1.9, up: true, b: [B(0.3, Object.assign({}, ARM.mouth, { ne: [6, 0, 4] }), "reach"), B(0.42, Object.assign({}, ARM.mouth, { ne: [8, 0, 4] }), "hold"), B(0.6, { rs: [85, -10, 10], re: [10, 0, 0], rw: [20, 0, 0], ne: [-4, 0, 6], wa: [2, 0, 0], ro: [1, 0, 0] }, "impact", ["CubicV2", "Out"])] },
    curtsy: { re: "curts(?:y|ey|ies|ying)|princess bow", d: 2, b: [B(0.35, { rh: [-6, 0, -18], rk: [-40, 0, 0], lh: [16, 0, -6], lk: [-35, 0, 0], rp: [0, -0.3, 0], wa: [-12, 0, 0], ne: [8, 0, 0], rs: [10, 0, 45], re: [40, 0, 0], ls: [10, 0, -45], le: [40, 0, 0] }, "hold", ["CubicV2", "InOut"]), B(0.6, { rh: [-6, 0, -18], rk: [-42, 0, 0], lh: [16, 0, -6], lk: [-36, 0, 0], rp: [0, -0.3, 0], wa: [-13, 0, 0], ne: [9, 0, 0], rs: [10, 0, 46], re: [40, 0, 0], ls: [10, 0, -46], le: [40, 0, 0] }, "hold")] },
    pant: { re: "pant(?:s|ing)?|out of breath|exhausted|catch(?:es|ing)? (?:my |their |his |her )?breath|hands on knees|winded", d: 2.4, loop: true, b: (k) => [B(0, { wa: [-36, 0, 0], ro: [-10, 0, 0], rp: [0, -0.15, 0], rs: [60, 0, 10], re: [20, 0, 0], rw: [-20, 0, 0], ls: [60, 0, -10], le: [20, 0, 0], lw: [-20, 0, 0], ne: [-12, 0, 0], lk: [-25, 0, 0], rk: [-25, 0, 0], lh: [20, 0, -8], rh: [20, 0, 8] }, "start"), B(0.5, { wa: [-40, 0, 0], ro: [-12, 0, 0], rp: [0, -0.18, 0], rs: [60, 0, 14], re: [20, 0, 0], rw: [-20, 0, 0], ls: [60, 0, -14], le: [20, 0, 0], lw: [-20, 0, 0], ne: [-6, 0, 0], lk: [-27, 0, 0], rk: [-27, 0, 0], lh: [22, 0, -8], rh: [22, 0, 8] }, "beat"), B(1, { wa: [-36, 0, 0], ro: [-10, 0, 0], rp: [0, -0.15, 0], rs: [60, 0, 10], re: [20, 0, 0], rw: [-20, 0, 0], ls: [60, 0, -10], le: [20, 0, 0], lw: [-20, 0, 0], ne: [-12, 0, 0], lk: [-25, 0, 0], rk: [-25, 0, 0], lh: [20, 0, -8], rh: [20, 0, 8] }, "loop_end")] },
    dizzy: { re: "dizzy|woozy|stagger(?:s|ing)? around|head spinning|disoriented|drunk(?:en)? stumble", d: 2.6, loop: true, b: (k) => { const out = []; for (let i = 0; i <= 6; i++) { const f = i / 6, ph = f * Math.PI * 2; out.push(B(f, { ro: [Math.sin(ph) * 6, Math.sin(ph * 0.5) * 10, Math.cos(ph) * 9], rp: [Math.cos(ph) * 0.2, -0.05, Math.sin(ph) * 0.1], ne: [Math.cos(ph) * 10, Math.sin(ph) * 14, Math.sin(ph) * 8], wa: [Math.sin(ph) * 6, 0, -Math.cos(ph) * 6], rs: [10, 0, 45 + Math.sin(ph) * 10], re: [30, 0, 0], ls: [10, 0, -45 + Math.sin(ph) * 10], le: [30, 0, 0], lk: [-12 + Math.cos(ph) * 6, 0, 0], rk: [-12 - Math.cos(ph) * 6, 0, 0] }, i === 0 ? "start" : i === 6 ? "loop_end" : "beat", ["CubicV2", "InOut"])); } return out; } },
    cower: { re: "cower(?:s|ing)?|hide(?:s)? behind|cover(?:s|ing)? (?:their |my |your |his |her )?(?:head|face)|duck and cover|brace(?:s)? for impact|protect(?:s|ing)? (?:their |my )?head", d: 2.4, b: [B(0.25, Object.assign({}, both({ rs: [150, -40, 40], re: [150, 0, 0] }), { wa: [-30, 0, 0], ne: [22, 0, 0], ro: [-10, 0, 0], rp: [0, -0.6, 0], lk: [-60, 0, 0], rk: [-60, 0, 0], lh: [45, 0, -10], rh: [45, 0, 10] }), "impact", ["CubicV2", "In"]), B(0.5, Object.assign({}, both({ rs: [152, -42, 40], re: [152, 0, 0] }), { wa: [-32, 0, 2], ne: [24, 0, 2], ro: [-11, 0, 0], rp: [0, -0.62, 0], lk: [-62, 0, 0], rk: [-62, 0, 0], lh: [46, 0, -10], rh: [46, 0, 10] }), "hold"), B(0.72, Object.assign({}, both({ rs: [150, -40, 40], re: [150, 0, 0] }), { wa: [-30, 0, -2], ne: [22, 0, -2], ro: [-10, 0, 0], rp: [0, -0.6, 0], lk: [-60, 0, 0], rk: [-60, 0, 0], lh: [45, 0, -10], rh: [45, 0, 10] }), "hold")] },
    surrender: { re: "surrender(?:s|ing)?|hands up|put(?:s)? (?:their |your |my |his |her )?hands (?:up|in the air)|don'?t shoot|give(?:s)? up", d: 2.6, up: true, b: [B(0.25, both({ rs: [160, 0, 28], re: [65, 0, 0], rw: [-20, 0, 0] }), "raise", ["CubicV2", "Out"]), B(0.5, Object.assign({}, both({ rs: [162, 0, 30], re: [66, 0, 0], rw: [-22, 0, 0] }), { ne: [4, -6, 0], wa: [-2, 0, 0] }), "hold"), B(0.75, Object.assign({}, both({ rs: [160, 0, 29], re: [64, 0, 0], rw: [-20, 0, 0] }), { ne: [4, 6, 0], wa: [-2, 0, 0] }), "hold")] },
    soccer: { re: "kick(?:s|ing)? (?:a |the )?(?:soccer )?ball|soccer|football kick|penalty kick|free kick", d: 1.5, ex: true, b: [B(0.3, { rh: [-35, 0, 6], rk: [-85, 0, 0], ra: [20, 0, 0], lh: [12, 0, -6], lk: [-20, 0, 0], wa: [-10, -10, 0], ro: [-6, 0, 0], rs: [-20, 0, 15], re: [20, 0, 0], ls: [60, 0, -30], le: [40, 0, 0] }, "anticipation", ["CubicV2", "In"]), B(0.5, { rh: [88, 0, 6], rk: [-12, 0, 0], ra: [32, 0, 0], lh: [-8, 0, -6], lk: [-18, 0, 0], la: [8, 0, 0], wa: [6, 14, 0], ro: [6, 0, 0], rp: [0, 0.05, 0], rs: [50, 0, 25], re: [40, 0, 0], ls: [-25, 0, -25], le: [20, 0, 0] }, "impact", ["Linear", "Out"]), B(0.68, { rh: [60, 0, 6], rk: [-50, 0, 0], ra: [10, 0, 0], lh: [-6, 0, -6], lk: [-18, 0, 0], wa: [2, 10, 0], ro: [2, 0, 0], rs: [40, 0, 20], re: [50, 0, 0], ls: [-10, 0, -20], le: [30, 0, 0] }, "follow")] },
    catch: { re: "catch(?:es|ing)? (?:a |the )?(?:ball|it|frisbee)|catch", d: 1.4, up: true, b: [B(0.3, both({ rs: [85, -15, 10], re: [30, 0, 0], rw: [-20, 0, 0] }), "reach", ["CubicV2", "Out"]), B(0.45, Object.assign({}, both({ rs: [70, -30, 12], re: [70, 0, 0], rw: [-10, 0, 0] }), { wa: [-6, 0, 0], ro: [-2, 0, 0], ne: [8, 0, 0] }), "impact", ["Linear", "Out"]), B(0.7, Object.assign({}, both({ rs: [55, -35, 15], re: [100, 0, 0] }), { wa: [-4, 0, 0], ne: [6, 0, 0] }), "hold")] },
    bat: { re: "golf|swing(?:s|ing)? (?:a |the )?(?:bat|club|golf club|baseball bat)|baseball swing|home ?run|tee off|tennis|racket|racquet", d: 1.8, ex: true, b: [B(0.3, { rs: [60, -30, 10], re: [60, 0, 0], ls: [70, 30, -10], le: [40, 0, 0], wa: [-8, 42, 0], ro: [-4, 16, 0], ne: [4, -30, 0], lh: [10, 0, -8], rh: [-6, 0, 8], lk: [-20, 0, 0], rk: [-22, 0, 0] }, "anticipation", ["CubicV2", "In"]), B(0.5, { rs: [70, 20, 10], re: [20, 0, 0], ls: [30, -20, -40], le: [60, 0, 0], wa: [-8, -48, 0], ro: [-4, -22, 0], ne: [4, 20, 0], lh: [20, 0, -8], rh: [-10, 0, 8], lk: [-18, 0, 0], rk: [-30, 0, 0] }, "impact", ["Linear", "Out"]), B(0.68, { rs: [110, 30, 20], re: [40, 0, 0], ls: [60, -30, -60], le: [90, 0, 0], wa: [-4, -60, 4], ro: [-2, -28, 0], ne: [0, 30, 0], lh: [20, 0, -8], rh: [-14, 0, 8], lk: [-16, 0, 0], rk: [-32, 0, 0] }, "follow")] },
    basketball: { re: "basketball|jump ?shot|free throw|shoot(?:s|ing)? (?:a |the )?(?:hoop|basket|three)|dunk(?:s|ing)?|slam dunk", d: 1.6, ex: true, b: [B(0.25, { rs: [70, -30, 15], re: [110, 0, 0], rw: [-30, 0, 0], ls: [60, 30, -20], le: [110, 0, 0], lw: [-20, 0, 0], lk: [-40, 0, 0], rk: [-40, 0, 0], lh: [30, 0, -8], rh: [30, 0, 8], rp: [0, -0.3, 0], wa: [-6, 0, 0], ne: [-6, 0, 0] }, "anticipation", ["CubicV2", "In"]), B(0.5, { rs: [162, -10, 15], re: [20, 0, 0], rw: [-40, 0, 0], ls: [150, 10, -20], le: [40, 0, 0], lw: [-20, 0, 0], lk: [-10, 0, 0], rk: [-10, 0, 0], lh: [5, 0, -8], rh: [5, 0, 8], la: [-25, 0, 0], ra: [-25, 0, 0], rp: [0, 0.5, 0], wa: [6, 0, 0], ne: [-18, 0, 0] }, "impact", ["CubicV2", "Out"]), B(0.7, { rs: [150, -10, 15], re: [25, 0, 0], rw: [-45, 0, 0], ls: [130, 10, -20], le: [50, 0, 0], lk: [-30, 0, 0], rk: [-30, 0, 0], lh: [20, 0, -8], rh: [20, 0, 8], rp: [0, -0.1, 0], wa: [0, 0, 0], ne: [-12, 0, 0] }, "land")] },
    lift: { re: "lift(?:s|ing)? (?:a |the |up )?(?:heavy |big |huge )?(?:box|rock|crate|barbell|weight|boulder|stone)|deadlift|pick(?:s|ing)? up (?:a |the )?heavy|heavy lift|strain(?:s|ing)?", d: 2.8, ex: true, b: [B(0.25, { lh: [92, 0, -10], rh: [92, 0, 10], lk: [-125, 0, 0], rk: [-125, 0, 0], la: [-30, 0, 0], ra: [-30, 0, 0], rp: [0, -1.2, 0], ro: [-10, 0, 0], wa: [-30, 0, 0], ne: [12, 0, 0], rs: [30, 0, 10], re: [5, 0, 0], ls: [30, 0, -10], le: [5, 0, 0] }, "contact", ["CubicV2", "Out"]), B(0.4, { lh: [90, 0, -10], rh: [90, 0, 10], lk: [-122, 0, 0], rk: [-122, 0, 0], la: [-30, 0, 0], ra: [-30, 0, 0], rp: [0, -1.18, 0], ro: [-10, 0, 0], wa: [-32, 0, 0], ne: [14, 0, 0], rs: [32, 0, 10], re: [8, 0, 0], ls: [32, 0, -10], le: [8, 0, 0] }, "hold"), B(0.75, { lh: [12, 0, -10], rh: [12, 0, 10], lk: [-14, 0, 0], rk: [-14, 0, 0], rp: [0, -0.06, 0], ro: [-3, 0, 0], wa: [-8, 0, 0], ne: [6, 0, 0], rs: [30, -10, 8], re: [65, 0, 0], ls: [30, 10, -8], le: [65, 0, 0] }, "impact", ["CubicV2", "InOut"]), B(0.9, { lh: [10, 0, -10], rh: [10, 0, 10], lk: [-12, 0, 0], rk: [-12, 0, 0], rp: [0, -0.05, 0], ro: [-2, 0, 0], wa: [-6, 0, 0], ne: [5, 0, 0], rs: [30, -10, 8], re: [66, 0, 0], ls: [30, 10, -8], le: [66, 0, 0] }, "hold")] },
    carry: { re: "carry(?:ing|s)? (?:a |the )?(?:box|crate|baby|bag|bags|tray|barrel|sack)|holding a box|hold(?:s|ing)? (?:a |the )?(?:box|crate|tray)", d: 2.4, loop: true, up: true, b: [B(0, both({ rs: [50, -20, 10], re: [100, 0, 0], rw: [-10, 0, 0] }), "start"), B(1, both({ rs: [50, -20, 10], re: [100, 0, 0], rw: [-10, 0, 0] }), "loop_end")] },
    nervous: { re: "nervous|anxious|fidget(?:s|ing)?|bit(?:e|es|ing) (?:their |my )?nails|wring(?:s|ing)? (?:their |my )?hands|tap(?:s|ping)? (?:their |my )?foot|impatient|waiting", d: 2.6, loop: true, b: (k) => [B(0, { rs: [50, -30, 10], re: [120, 0, 0], ls: [50, 30, -10], le: [120, 0, 0], ne: [6, -16, 0], ra: [0, 0, 0] }, "start"), B(0.25, { rs: [52, -30, 10], re: [125, 0, 0], rw: [10, 0, 0], ls: [48, 30, -10], le: [115, 0, 0], ne: [4, 12, 0], ra: [-18, 0, 0], rk: [-14, 0, 0] }, "beat"), B(0.5, { rs: [50, -30, 10], re: [120, 0, 0], ls: [50, 30, -10], le: [120, 0, 0], ne: [8, 18, 0], ra: [0, 0, 0] }, "beat"), B(0.75, { rs: [48, -30, 10], re: [115, 0, 0], rw: [-10, 0, 0], ls: [52, 30, -10], le: [125, 0, 0], ne: [4, -10, 0], ra: [-18, 0, 0], rk: [-14, 0, 0] }, "beat"), B(1, { rs: [50, -30, 10], re: [120, 0, 0], ls: [50, 30, -10], le: [120, 0, 0], ne: [6, -16, 0], ra: [0, 0, 0] }, "loop_end")] },
    heropose: { re: "superhero|hero pose|power pose|heroic (?:pose|stance)|hands on (?:the |their |my )?hips|stand(?:s|ing)? proud", d: 3, loop: true, b: (k) => [B(0, Object.assign({}, both(ARM.hip), { wa: [8, 0, 0], ne: [-8, 0, 0], lh: [2, 0, -22], rh: [2, 0, 22], ro: [2, 0, 0] }), "start"), B(0.5, Object.assign({}, both(ARM.hip), { wa: [10, 0, 0], ne: [-9, 10, 0], lh: [2, 0, -22], rh: [2, 0, 22], ro: [2, 0, 0] }), "beat"), B(1, Object.assign({}, both(ARM.hip), { wa: [8, 0, 0], ne: [-8, 0, 0], lh: [2, 0, -22], rh: [2, 0, 22], ro: [2, 0, 0] }), "loop_end")] },
    herolanding: { re: "superhero landing|three[- ]point landing|hero landing|land(?:s|ing)? on one knee", d: 1.6, ex: true, b: [B(0.15, { rp: [0, 0.6, 0], ro: [-10, 0, 0], lh: [40, 0, -8], rh: [20, 0, 8], lk: [-60, 0, 0], rk: [-40, 0, 0], rs: [80, 0, 20], re: [60, 0, 0], ls: [80, 0, -20], le: [60, 0, 0] }, "air", ["CubicV2", "In"]), B(0.4, { rp: [0, -1.25, 0], ro: [-6, 0, 0], rh: [-8, 0, 8], rk: [-120, 0, 0], ra: [30, 0, 0], lh: [88, 0, -10], lk: [-112, 0, 0], la: [-10, 0, 0], rs: [60, 0, 10], re: [0, 0, 0], rw: [-10, 0, 0], ls: [-30, 0, -40], le: [20, 0, 0], wa: [-36, 0, 0], ne: [-12, 0, 0] }, "impact", ["CubicV2", "In"]), B(0.65, { rp: [0, -1.22, 0], ro: [-6, 0, 0], rh: [-8, 0, 8], rk: [-120, 0, 0], ra: [30, 0, 0], lh: [88, 0, -10], lk: [-112, 0, 0], la: [-10, 0, 0], rs: [60, 0, 10], re: [0, 0, 0], rw: [-10, 0, 0], ls: [-30, 0, -40], le: [20, 0, 0], wa: [-34, 0, 0], ne: [-18, 0, 0] }, "hold")] },
    dab: { re: "dab(?:s|bing)?|dab emote", d: 1.2, up: true, b: [B(0.2, { rs: [60, 0, 30], re: [60, 0, 0], ls: [60, 0, -30], le: [60, 0, 0], ne: [-6, 0, 0] }, "anticipation", ["CubicV2", "In"]), B(0.35, { rs: [150, 0, 70], re: [0, 0, 0], rw: [0, 0, 0], ls: [100, -50, -20], le: [150, 0, 0], ne: [18, 0, 26], wa: [-8, 0, 12], ro: [-2, 0, 4] }, "impact", ["Linear", "Out"]), B(0.72, { rs: [150, 0, 70], re: [0, 0, 0], rw: [0, 0, 0], ls: [100, -50, -20], le: [150, 0, 0], ne: [18, 0, 26], wa: [-8, 0, 12], ro: [-2, 0, 4] }, "hold")] },
    floss: { re: "floss(?:es|ing)?|floss dance", d: 0.8, loop: true, b: (k) => [B(0, { rs: [20, 0, -30], re: [10, 0, 0], ls: [20, 0, -38], le: [10, 0, 0], rp: [0.22, 0, 0], wa: [0, 10, -8], ne: [0, -6, 4] }, "start"), B(0.25, { rs: [-20, 0, 30], re: [10, 0, 0], ls: [-20, 0, -30], le: [10, 0, 0], rp: [0, 0, 0], wa: [0, 0, 0], ne: [0, 0, 0] }, "beat"), B(0.5, { rs: [20, 0, 38], re: [10, 0, 0], ls: [20, 0, 30], le: [10, 0, 0], rp: [-0.22, 0, 0], wa: [0, -10, 8], ne: [0, 6, -4] }, "beat"), B(0.75, { rs: [-20, 0, 30], re: [10, 0, 0], ls: [-20, 0, -30], le: [10, 0, 0], rp: [0, 0, 0], wa: [0, 0, 0], ne: [0, 0, 0] }, "beat"), B(1, { rs: [20, 0, -30], re: [10, 0, 0], ls: [20, 0, -38], le: [10, 0, 0], rp: [0.22, 0, 0], wa: [0, 10, -8], ne: [0, -6, 4] }, "loop_end")] },
    twirl: { re: "spin(?:s|ning)? (?:around|in place|in a circle)|twirl(?:s|ing)?|pirouette|360 spin|turn(?:s|ing)? around", d: 1.5, ex: true, b: [B(0.15, { rs: [10, 0, 30], re: [20, 0, 0], ls: [10, 0, -30], le: [20, 0, 0], ro: [0, -20, 0], wa: [0, -10, 0] }, "anticipation", ["CubicV2", "In"]), B(0.65, { rs: [10, 0, 85], re: [5, 0, 0], ls: [10, 0, -85], le: [5, 0, 0], ro: [0, 340, 0], rp: [0, 0.12, 0], la: [25, 0, 0], ra: [25, 0, 0], lk: [-6, 0, 0], rk: [-6, 0, 0] }, "spin", ["CubicV2", "Out"]), B(0.85, { rs: [10, 0, 30], re: [20, 0, 0], ls: [10, 0, -30], le: [20, 0, 0], ro: [0, 360, 0], lk: [-18, 0, 0], rk: [-18, 0, 0], rp: [0, -0.06, 0] }, "land")] },
    wall: { re: "lean(?:s|ing)? (?:on|against) (?:a |the )?(?:wall|tree|post|pole)|lean(?:s|ing)? back casually|cool pose", d: 4, loop: true, b: (k) => [B(0, { ro: [0, 0, 9], rp: [0.3, -0.05, 0], wa: [0, 0, -6], ne: [0, -10, -4], rs: [40, -30, 20], re: [115, 0, 0], ls: [40, 30, -20], le: [115, 0, 0], lh: [-4, 0, -18], lk: [-18, 0, 0], rh: [8, 0, -4], rk: [-30, 0, 0], ra: [20, 0, 0] }, "start"), B(0.5, { ro: [0, 0, 9], rp: [0.3, -0.05, 0], wa: [1, 0, -6], ne: [-2, 12, -4], rs: [40, -30, 20], re: [116, 0, 0], ls: [40, 30, -20], le: [116, 0, 0], lh: [-4, 0, -18], lk: [-18, 0, 0], rh: [8, 0, -4], rk: [-30, 0, 0], ra: [20, 0, 0] }, "beat"), B(1, { ro: [0, 0, 9], rp: [0.3, -0.05, 0], wa: [0, 0, -6], ne: [0, -10, -4], rs: [40, -30, 20], re: [115, 0, 0], ls: [40, 30, -20], le: [115, 0, 0], lh: [-4, 0, -18], lk: [-18, 0, 0], rh: [8, 0, -4], rk: [-30, 0, 0], ra: [20, 0, 0] }, "loop_end")] },
    watch: { re: "check(?:s|ing)? (?:the |my |their )?(?:time|watch|wrist)|look(?:s|ing)? at (?:my |the |their )?watch|what time", d: 2, up: true, b: [B(0.3, { ls: [60, -20, -20], le: [120, 0, 0], lw: [-30, 0, 0], ne: [22, 18, 0], wa: [-2, 6, 0] }, "reach"), B(0.6, { ls: [62, -20, -20], le: [122, 0, 0], lw: [-34, 0, 0], ne: [24, 18, 0], wa: [-2, 6, 0] }, "hold")] },
    scratch: { n0: 3, re: "scratch(?:es|ing)? (?:their |my |your |his |her )?(?:head|neck)|head scratch|scratch", d: 2, up: true, b: (k, n) => [B(0.25, Object.assign({}, ARM.head, { ne: [6, 0, -8] }), "reach"), ...osc(n || 3, 0.32, 0.78, (s) => Object.assign({}, ARM.head, { rw: [s * 15, 0, 0], re: [145 + s * 4, 0, 0], ne: [6, 0, -8] }))] },
    pet: { n0: 3, re: "pet(?:s|ting)? (?:a |the )?(?:dog|cat|puppy|kitten|animal)|pat(?:s|ting)? (?:a |the )?(?:dog|cat|head)|stroke(?:s)? (?:the )?(?:dog|cat)", d: 2.4, b: (k, n) => { const base = { rp: [0, -0.8, 0], ro: [-6, 0, 0], lk: [-75, 0, 0], rk: [-75, 0, 0], lh: [60, 0, -10], rh: [60, 0, 10], la: [-15, 0, 0], ra: [-15, 0, 0], wa: [-18, 0, 0], ne: [16, 0, 0], ls: [50, 0, -15], le: [90, 0, 0] }; return [B(0.25, Object.assign({}, base, { rs: [70, 0, 10], re: [40, 0, 0] }), "reach"), ...osc(n || 3, 0.32, 0.82, (s) => Object.assign({}, base, { rs: [72 + s * 6, 0, 10], re: [40 + s * 10, 0, 0], rw: [s * 15, 0, 0] }))]; } },
    pray: { re: "pray(?:s|ing|er)? standing|hands together|namaste|plead(?:s|ing)?|beg(?:s|ging)?", d: 2.6, up: true, b: [B(0.3, Object.assign({}, both({ rs: [60, -45, 20], re: [110, 0, 0], rw: [0, 0, 0] }), { ne: [12, 0, 0], wa: [-4, 0, 0] }), "reach"), B(0.5, Object.assign({}, both({ rs: [62, -46, 20], re: [112, 0, 0] }), { ne: [16, 0, 0], wa: [-6, 0, 0] }), "hold"), B(0.75, Object.assign({}, both({ rs: [62, -46, 20], re: [112, 0, 0] }), { ne: [-6, 0, 0], wa: [-2, 0, 0] }), "hold")] },
    boxing: { re: "boxing stance|guard up|bounce on (?:their |my )?toes|shadow ?box(?:es|ing)?|fighting stance", d: 1.0, loop: true, b: (k) => [B(0, { rs: [60, 0, 15], re: [125, 0, 0], ls: [70, 0, -15], le: [130, 0, 0], wa: [-8, -12, 0], ne: [6, 10, 0], ro: [-6, 15, 0], rp: [0, -0.12, 0], lh: [22, 0, -6], lk: [-28, 0, 0], rh: [-10, 0, 8], rk: [-24, 0, 0], ra: [14, 0, 0] }, "start"), B(0.5, { rs: [62, 0, 15], re: [125, 0, 0], ls: [72, 0, -15], le: [130, 0, 0], wa: [-8, -12, 0], ne: [6, 10, 0], ro: [-6, 15, 0], rp: [0, -0.02, 0], lh: [22, 0, -6], lk: [-18, 0, 0], rh: [-10, 0, 8], rk: [-14, 0, 0], ra: [14, 0, 0] }, "beat"), B(1, { rs: [60, 0, 15], re: [125, 0, 0], ls: [70, 0, -15], le: [130, 0, 0], wa: [-8, -12, 0], ne: [6, 10, 0], ro: [-6, 15, 0], rp: [0, -0.12, 0], lh: [22, 0, -6], lk: [-28, 0, 0], rh: [-10, 0, 8], rk: [-24, 0, 0], ra: [14, 0, 0] }, "loop_end")] },
    chicken: { re: "chicken|flap(?:s|ping)? (?:their |my )?(?:arms|wings)|bird|cluck", d: 1.0, loop: true, b: (k) => [B(0, { rs: [20, 0, 60], re: [140, 0, 0], rw: [0, 0, -30], ls: [20, 0, -60], le: [140, 0, 0], lw: [0, 0, 30], ne: [18, 0, 0], wa: [-10, 0, 0], lk: [-30, 0, 0], rk: [-30, 0, 0], lh: [25, 0, -14], rh: [25, 0, 14], rp: [0, -0.2, 0] }, "start"), B(0.25, { rs: [20, 0, 20], re: [145, 0, 0], rw: [0, 0, -30], ls: [20, 0, -20], le: [145, 0, 0], lw: [0, 0, 30], ne: [-6, 0, 0], wa: [-4, 0, 0], lk: [-22, 0, 0], rk: [-22, 0, 0], lh: [20, 0, -14], rh: [20, 0, 14], rp: [0, -0.12, 0] }, "beat"), B(0.5, { rs: [20, 0, 60], re: [140, 0, 0], rw: [0, 0, -30], ls: [20, 0, -60], le: [140, 0, 0], lw: [0, 0, 30], ne: [18, 0, 0], wa: [-10, 0, 0], lk: [-30, 0, 0], rk: [-30, 0, 0], lh: [25, 0, -14], rh: [25, 0, 14], rp: [0, -0.2, 0] }, "beat"), B(0.75, { rs: [20, 0, 20], re: [145, 0, 0], rw: [0, 0, -30], ls: [20, 0, -20], le: [145, 0, 0], lw: [0, 0, 30], ne: [-6, 0, 0], wa: [-4, 0, 0], lk: [-22, 0, 0], rk: [-22, 0, 0], lh: [20, 0, -14], rh: [20, 0, 14], rp: [0, -0.12, 0] }, "beat"), B(1, { rs: [20, 0, 60], re: [140, 0, 0], rw: [0, 0, -30], ls: [20, 0, -60], le: [140, 0, 0], lw: [0, 0, 30], ne: [18, 0, 0], wa: [-10, 0, 0], lk: [-30, 0, 0], rk: [-30, 0, 0], lh: [25, 0, -14], rh: [25, 0, 14], rp: [0, -0.2, 0] }, "loop_end")] },
    bowhead: { re: "bow(?:s)? (?:their |my |the )?head|lower(?:s)? (?:their |my |the )?head|moment of silence|mourn(?:s|ing)?|grie(?:f|ve|ving)", d: 3, b: [B(0.3, { ne: [34, 0, 0], wa: [-6, 0, 0], rs: [20, -20, 8], re: [40, 0, 0], ls: [20, 20, -8], le: [40, 0, 0] }, "hold", ["CubicV2", "InOut"]), B(0.72, { ne: [36, 0, 0], wa: [-7, 0, 0], rs: [20, -20, 8], re: [40, 0, 0], ls: [20, 20, -8], le: [40, 0, 0] }, "hold")] },
    wavearms: { re: "wave(?:s|ing)? (?:both |their |my )?arms|flail(?:s|ing)?|over here|help me|signal(?:s|ling|ing)? (?:for help|a plane)", d: 1.6, loop: true, up: true, b: (k) => [B(0, both({ rs: [165, 0, 30], re: [20, 0, 0] }), "start"), B(0.5, Object.assign({}, both({ rs: [165, 0, 70], re: [20, 0, 0] }), { wa: [0, 0, 4], ne: [-6, 0, -4] }), "beat"), B(1, both({ rs: [165, 0, 30], re: [20, 0, 0] }), "loop_end")] },
    tiptoe_reach: { re: "reach(?:es|ing)? (?:up|for the top shelf|for something high|overhead)|grab(?:s|bing)? (?:something )?(?:from )?(?:the )?(?:top|high) shelf", d: 2.2, b: [B(0.3, { rs: [165, -10, 15], re: [10, 0, 0], rw: [-20, 0, 0], wa: [6, -8, -6], ne: [-20, 0, 0], la: [28, 0, 0], ra: [28, 0, 0], rp: [0, 0.22, 0], ls: [10, 0, -20], le: [20, 0, 0] }, "reach", ["CubicV2", "Out"]), B(0.5, { rs: [170, -10, 15], re: [5, 0, 0], rw: [-25, 0, 0], wa: [8, -10, -8], ne: [-24, 0, 0], la: [30, 0, 0], ra: [30, 0, 0], rp: [0, 0.25, 0], ls: [10, 0, -20], le: [20, 0, 0] }, "hold"), B(0.75, { rs: [80, -20, 15], re: [90, 0, 0], rw: [-10, 0, 0], wa: [-2, 0, 0], ne: [4, 0, 0], rp: [0, 0, 0] }, "beat")] },
  };
  for (const name of Object.keys(ACTS)) { ACTS[name].name = name; ACTS[name].rx = new RegExp("\\b(?:" + ACTS[name].re + ")\\b", "i"); }
  const CLAUSE_SPLIT = /\s*(?:,?\s*(?:and )?then\b|,?\s*after that\b|,?\s*followed by\b|,?\s*afterwards?\b|,?\s*finally\b|,?\s*next\b|\s*->\s*|\s*→\s*|;\s*)\s*/i;
  function splitClauses(text) { return String(text || "").split(CLAUSE_SPLIT).map((s) => s.replace(/^\s*(?:and|,)\s*/i, "").trim()).filter(Boolean); }
  function findActs(text) { const t = String(text || ""); const out = []; for (const name of Object.keys(ACTS)) { const m = ACTS[name].rx.exec(t); if (m) out.push({ act: ACTS[name], at: m.index, len: m[0].length }); } out.sort((a, b) => a.at - b.at || b.len - a.len); const seen = []; return out.filter((o) => { if (seen.some((s) => o.at < s.at + s.len && s.at < o.at + o.len)) return false; seen.push(o); return true; }).map((o) => o.act); }
  function repeatCount(text) {
    const t = String(text || ""); const toN = (w) => { w = w.toLowerCase(); return clamp(({ twice: 2, thrice: 3 }[w]) || NUMWORD[w] || parseInt(w, 10) || 0, 1, 12) || null; };
    let m = t.match(/\b(\d+|two|three|four|five|six|seven|eight|ten|double|triple)\s*(?:times|x|reps?|repetitions?|knocks?|taps?|bites?|sips?|shakes?|rounds?)\b/i); if (m) return toN(m[1]);
    m = t.match(/\b(twice|thrice)\b/i); if (m) return toN(m[1]);
    m = t.match(/\b(\d+|two|three|four|five|six|seven|eight|ten)\s+([a-z][a-z -]{2,30})/i); // "3 squats", "five jumping jacks"
    if (m && Object.keys(ACTS).some((n) => ACTS[n].rx.test(m[2]))) return toN(m[1]);
    return null;
  }
  // pose grammar: "<verb> [left|right|both] <part> [direction]" → joint targets (a gesture clip when no act matched; a modifier otherwise)
  const PART_RX = /\b(raise|raises|raising|lift|lifts|lifting|put up|extend|extends|stretch out|reach(?:es)? out|lower|lowers|drop|drops|bend|bends|turn|turns|rotate|tilt|tilts|lean|leans|leaning|spread|open|cross|crosses|fold|kick|kicks|swing|swings|shake|shakes|wiggle|wiggles|wave|waves|pump|pumps|tap|taps|nod|look|looks|twist|twists|arch|arches|hunch|crouch|squat|duck|point|points|hold up|hold out|flap|flaps|clench|bounce)\b(?:\s+with)?(?:\s+(?:the|their|his|her|my|your|a|an))?\s*(left|right|both|l|r)?\s*(arms?|hands?|legs?|knees?|feet|foot|head|torso|body|hips?|shoulders?|elbows?|chest|fists?|neck|back|upper body)?\s*(up|down|forward|forwards|back|backwards?|left|right|out|outwards?|sideways|to the side|high|overhead|in|inward|apart|together)?/gi;
  function posePhrase(text) {
    const t = String(text || ""); const hits = []; let m; PART_RX.lastIndex = 0;
    while ((m = PART_RX.exec(t))) { const verb = m[1].toLowerCase(), side = (m[2] || "").toLowerCase(), part = (m[3] || "").toLowerCase(), dir = (m[4] || "").toLowerCase(); if (!part && !/^(crouch|squat|duck|hunch|nod|look|lean|bounce)/.test(verb)) continue; hits.push({ verb, side, part, dir }); }
    if (!hits.length) return null;
    const pose = {}; let oscN = 0, count = 0;
    const setArm = (s, rot, elbow) => { const rs = s === "left" || s === "l" ? "ls" : "rs"; const flip = rs === "ls" ? [rot[0], -rot[1], -rot[2]] : rot; pose[rs] = flip; pose[rs === "ls" ? "le" : "re"] = [elbow == null ? 10 : elbow, 0, 0]; };
    const setLeg = (s, rot, knee) => { const h = s === "left" || s === "l" ? "lh" : "rh"; const flip = h === "lh" ? [rot[0], -rot[1], -rot[2]] : rot; pose[h] = flip; pose[h === "lh" ? "lk" : "rk"] = [knee == null ? -10 : knee, 0, 0]; };
    for (const h of hits) {
      count++;
      const sides = h.side === "both" || /s$|feet/.test(h.part) && !h.side ? ["left", "right"] : [h.side || "right"];
      const V = h.verb, P = h.part === "back" && !/arm|hand|leg/.test(h.part) && /^(lean|arch|bend|tilt|fall)/.test(h.verb) ? "" : h.part, D = h.dir || (h.part === "back" && !P ? "back" : "");
      const armTarget = () => /up|high|overhead/.test(D) || /^(raise|lift|put up|hold up)/.test(V) && !D ? [[165, 0, 20], 8] : /forward|out(?!ward)/.test(D) && !/side/.test(D) || /extend|reach|hold out|point|stretch/.test(V) && !/side|out/.test(D) ? [[90, 0, 10], 5] : /side|out|apart|sideways/.test(D) || /spread|open|flap/.test(V) ? [[12, 0, 88], 5] : /back/.test(D) ? [[-45, 0, 15], 10] : /down|lower|drop/.test(D + V) ? [[5, 0, 6], 8] : /cross|fold/.test(V) || /together|in/.test(D) ? [[40, -30, 20], 115] : /clench|pump/.test(V) ? [[40, 0, 15], 130] : [[90, 0, 10], 5];
      if (/arm|hand|fist|shoulder|elbow/.test(P)) { const [rot, el] = armTarget(); for (const s of sides) setArm(s, rot, el); if (/shake|wiggle|wave|pump|swing|flap|bounce/.test(V)) oscN++; }
      else if (/leg|knee|foot|feet/.test(P)) { const rot = /back/.test(D) ? [-40, 0, 5] : /side|out|apart/.test(D) ? [10, 0, 35] : /up|high/.test(D) || /lift|raise/.test(V) ? [85, 0, 5] : /kick|swing/.test(V) || /forward/.test(D) ? [75, 0, 5] : [30, 0, 5]; const knee = /knee/.test(P) || /lift|raise/.test(V) ? -95 : -12; for (const s of sides) setLeg(s, rot, knee); if (/shake|wiggle|tap|swing|bounce/.test(V)) oscN++; }
      else if (/head|neck/.test(P) || /^(nod|look)/.test(V)) { pose.ne = /up|high|overhead/.test(D) ? [-32, 0, 0] : /down/.test(D) || V === "nod" || /lower|drop|bow/.test(V) ? [30, 0, 0] : /left/.test(D) ? [0, 45, 0] : /right/.test(D) ? [0, -45, 0] : /back/.test(D) ? [-30, 0, 0] : /side|sideways/.test(D) ? [0, 0, 24] : /tilt/.test(V) ? [0, 0, 20] : /shake/.test(V) ? [0, 40, 0] : /turn|rotate|twist/.test(V) ? [0, -50, 0] : [12, 0, 0]; if (/shake|nod|wiggle|bounce/.test(V)) oscN++; }
      else if (/torso|body|chest|back|hip|upper body/.test(P) || /^(lean|arch|hunch|twist|crouch|squat|duck|bounce)/.test(V)) {
        if (/crouch|squat|duck/.test(V) || /down/.test(D) && /body|hip/.test(P)) Object.assign(pose, { lh: [92, 0, -12], rh: [92, 0, 12], lk: [-125, 0, 0], rk: [-125, 0, 0], la: [-30, 0, 0], ra: [-30, 0, 0], rp: [0, -1.2, 0], ro: [-8, 0, 0], wa: [-18, 0, 0], ne: [10, 0, 0] });
        else if (/forward/.test(D) || /hunch/.test(V)) { pose.wa = [-30, 0, 0]; pose.ro = [-10, 0, 0]; pose.ne = [12, 0, 0]; }
        else if (/back/.test(D) || /arch/.test(V)) { pose.wa = [18, 0, 0]; pose.ro = [8, 0, 0]; pose.ne = [-14, 0, 0]; }
        else if (/left/.test(D)) { pose.wa = [0, 0, 22]; pose.ro = [0, 0, 8]; pose.ne = [0, 0, -10]; }
        else if (/right/.test(D)) { pose.wa = [0, 0, -22]; pose.ro = [0, 0, -8]; pose.ne = [0, 0, 10]; }
        else if (/twist|turn|rotate/.test(V)) { pose.wa = [0, -45, 0]; pose.ne = [0, -20, 0]; }
        else if (/bounce/.test(V)) { pose.lk = [-30, 0, 0]; pose.rk = [-30, 0, 0]; pose.rp = [0, -0.15, 0]; oscN++; }
        else { pose.wa = [0, 0, -18]; pose.ro = [0, 0, -6]; }
      }
    }
    if (!Object.keys(pose).length) return null;
    return { pose, oscillate: oscN > 0, hits: hits.map((h) => [h.verb, h.side, h.part, h.dir].filter(Boolean).join(" ")) };
  }
  function gestureBeats(g, k, n) { // one gesture phrase → beats; oscillating verbs repeat
    const p = g.pose, reps = n || (g.oscillate ? 3 : 1);
    if (!g.oscillate) return [B(0.3, p, "impact", ["CubicV2", "Out"]), B(0.6, p, "hold"), B(0.78, p, "hold")];
    const alt = {}; for (const key of Object.keys(p)) { const v = p[key]; alt[key] = key === "rp" ? [v[0] * -1, v[1] * 0.5, v[2]] : key === "ne" ? [v[0] * 0.6, -v[1], -v[2]] : /^(rs|ls)$/.test(key) ? [v[0] - 25, v[1], v[2] * 0.75] : /^(rh|lh)$/.test(key) ? [v[0] - 20, v[1], v[2]] : /^(rk|lk)$/.test(key) ? [v[0] * 0.6, 0, 0] : key === "wa" ? [v[0] * 0.5, -v[1], -v[2]] : key === "ro" ? [v[0] * 0.5, -v[1], -v[2]] : v; }
    return [B(0.18, p, "raise", ["CubicV2", "Out"]), ...osc(reps, 0.22, 0.85, (s) => (s > 0 ? alt : p))];
  }
  // MOODS: additive character overlays usable on top of any clip (also reachable through animation_refine feedback)
  const MOODS = {
    drunk: { re: "drunk|tipsy|wasted|intoxicated|wobbly|boozy", off: { ne: [6, 0, 6], wa: [-4, 0, 3], ro: [0, 0, 3] }, sway: { amp: 1, period: 1.6 } },
    tired: { re: "tired|sleepy|exhausted|weary|drowsy|lazy|sluggish|bored", off: { wa: [-10, 0, 0], ne: [16, 0, 3], rs: [4, 0, 2], ls: [4, 0, -2], lk: [-6, 0, 0], rk: [-6, 0, 0], rp: [0, -0.05, 0] } },
    sad: { re: "sad|depressed|gloomy|unhappy|miserable|heartbroken|sorrow(?:ful)?|dejected|disappointed", off: { wa: [-8, 0, 0], ne: [22, 0, 4], rs: [2, 0, -2], ls: [2, 0, 2], ro: [-2, 0, 0] } },
    happy: { re: "happy|joyful|cheerful|excited|delighted|upbeat|gleeful|giddy|playful", off: { wa: [4, 0, 0], ne: [-6, 0, 0], ro: [1, 0, 0] }, bounce: 0.04 },
    angry: { re: "angry|furious|mad|enraged|aggressive|pissed|irritated|annoyed", off: { wa: [-6, 0, 0], ne: [6, 0, 0], ro: [-3, 0, 0], re: [35, 0, 0], le: [35, 0, 0], rs: [14, 0, 6], ls: [14, 0, -6], rw: [-20, 0, 0], lw: [-20, 0, 0] } },
    scared: { re: "scared|afraid|terrified|frightened|fearful|panick(?:ed|ing|y)|timid|cautious", off: { wa: [-10, 0, 0], ne: [4, 0, 0], rs: [30, -20, 10], ls: [30, 20, -10], re: [100, 0, 0], le: [100, 0, 0], lk: [-12, 0, 0], rk: [-12, 0, 0], rp: [0, -0.08, 0] }, sway: { amp: 0.35, period: 0.35 } },
    proud: { re: "proud|confident|heroic|regal|royal|noble|majestic|arrogant|cocky|smug|boss(?:y)?", off: { wa: [8, 0, 0], ne: [-8, 0, 0], ro: [2, 0, 0], rs: [-4, 0, 6], ls: [-4, 0, -6] } },
    old: { re: "old|elderly|grandpa|grandma|granny|ancient|frail|senior", off: { wa: [-20, 0, 0], ne: [20, 0, 0], lk: [-18, 0, 0], rk: [-18, 0, 0], rp: [0, -0.12, 0], ro: [-4, 0, 0], re: [30, 0, 0], le: [30, 0, 0] }, slow: 0.8 },
    injured: { re: "injured|wounded|limp(?:s|ing)?|bleeding|in pain|clutch(?:es|ing)? (?:their |my )?(?:side|stomach|arm|wound)|drag(?:s|ging)? (?:a |the |their |my |his |her )?(?:left |right )?(?:leg|foot)|broken leg|hurt leg", off: { wa: [-12, 0, 8], ne: [10, 0, -4], ro: [-4, 0, 3], ls: [30, 40, -15], le: [115, 0, 0], rk: [-12, 0, 0], rp: [0, -0.06, 0] }, slow: 0.85 },
    sneakymood: { re: "sneaky|stealthy|suspicious|sly|creepy", off: { wa: [-14, 0, 0], ne: [6, 0, 0], ro: [-6, 0, 0], rp: [0, -0.3, 0], lk: [-35, 0, 0], rk: [-35, 0, 0], lh: [25, 0, -6], rh: [25, 0, 6], re: [80, 0, 0], le: [80, 0, 0], rs: [35, -10, 10], ls: [35, 10, -10] } },
    cold: { re: "freezing cold|shivering|hypothermi", off: { wa: [-8, 0, 0], ne: [8, 0, 0], rs: [40, -30, 20], ls: [40, 30, -20], re: [125, 0, 0], le: [125, 0, 0] }, sway: { amp: 0.4, period: 0.25 } },
    energetic: { re: "hyper|energetic|pumped|hyped|caffeinated|jittery", off: { wa: [2, 0, 0], ne: [-4, 0, 0], lk: [-10, 0, 0], rk: [-10, 0, 0] }, bounce: 0.06, fast: 1.15 },
  };
  for (const name of Object.keys(MOODS)) { MOODS[name].name = name; MOODS[name].rx = new RegExp("\\b(?:" + MOODS[name].re + ")\\b", "i"); }
  function findMood(text) { for (const name of Object.keys(MOODS)) if (MOODS[name].rx.test(text)) return MOODS[name]; return null; }
  function applyMood(keys, mood, duration, k) {
    const off = X(mood.off, k); const sway = mood.sway, bounce = mood.bounce || 0;
    return keys.map((key) => {
      const poses = clonePose(key.poses); const t = key.t;
      for (const j of Object.keys(off)) { const base = poses[j] || J(0, 0, 0); const o = off[j]; poses[j] = { rot: [base.rot[0] + o.rot[0], base.rot[1] + o.rot[1], base.rot[2] + o.rot[2]] }; if (j === "root") poses[j].pos = [(base.pos || [0, 0, 0])[0] + o.pos[0], (base.pos || [0, 0, 0])[1] + o.pos[1], (base.pos || [0, 0, 0])[2] + o.pos[2]]; else if (base.pos) poses[j].pos = base.pos; }
      if (sway || bounce) {
        const cycles = Math.max(1, Math.round(duration / (sway ? sway.period : 0.5))); const ph = (t / Math.max(1e-6, duration)) * Math.PI * 2 * cycles; // integer cycles keep loops seamless
        const r = poses.root || { rot: [0, 0, 0], pos: [0, 0, 0] }; r.pos = r.pos || [0, 0, 0];
        if (sway) { const a = sway.amp * 6 * k; r.rot = [r.rot[0] + Math.sin(ph * 0.5) * a * 0.4, r.rot[1], r.rot[2] + Math.sin(ph) * a]; r.pos = [r.pos[0] + Math.sin(ph) * sway.amp * 0.12, r.pos[1], r.pos[2]]; const n = poses.neck || J(0, 0, 0); poses.neck = J(n.rot[0], n.rot[1] + Math.cos(ph) * a * 0.8, n.rot[2] - Math.sin(ph) * a * 0.6); }
        if (bounce) r.pos = [r.pos[0], r.pos[1] + Math.abs(Math.sin(ph)) * bounce * 2 - bounce, r.pos[2]];
        poses.root = r;
      }
      return Object.assign({}, key, { poses });
    });
  }
  // act → keys (persona-infused stance underneath, k scales amplitude, n = requested repeats)
  function actKeys(act, k, style, duration, n) {
    const base = stance(k, style); const raw = typeof act.b === "function" ? act.b(k, n) : act.b;
    let beats = raw.map((b) => ({ at: b[0], pose: withOverrides(base, X(b[1], Math.min(k, 1.25))), tag: b[2] || "beat", ease: b[3] || ["CubicV2", "InOut"] }));
    beats.sort((a, b) => a.at - b.at);
    if (!act.loop) { if (beats[0].at > 0) beats.unshift({ at: 0, pose: clonePose(base), tag: "start", ease: ["CubicV2", "Out"] }); if (beats[beats.length - 1].at < 1) beats.push({ at: 1, pose: clonePose(base), tag: "end", ease: ["CubicV2", "Out"] }); }
    else { if (beats[0].at > 0) beats.unshift({ at: 0, pose: clonePose(beats[beats.length - 1].at >= 1 ? beats[beats.length - 1].pose : beats[0].pose), tag: "start", ease: ["CubicV2", "InOut"] }); if (beats[beats.length - 1].at < 1) beats.push({ at: 1, pose: clonePose(beats[0].pose), tag: "loop_end", ease: ["CubicV2", "InOut"] }); }
    return beats.map((b) => ({ t: r3(b.at * duration), poses: b.pose, ease: b.ease, tag: b.tag, stage: act.name }));
  }
  // ───────────────────────── 1.61 "any word" layer: thesaurus + verb classes + inspiration ─────────────────────────
  // The lexicon is finite, language is not. Three things make the space effectively unbounded: (1) a THESAURUS that
  // rewrites hundreds of synonyms / implied-object words into the vocabulary the classifier knows ("guzzle a beer" →
  // drink, "pirouette" → spin, "shovel" → dig, "waltz" → dance); (2) VERB CLASSES - every English motion verb that is
  // still unknown is mapped to a body region + motion pattern (arm swing, hands pulse, foot tap, head nod, torso sway,
  // tremble, slump…) and rendered through the pose grammar, so "wring", "teeter", "sniff", "shimmy" each get their own
  // motion instead of a generic improvisation; (3) everything composes: acts × moods × speeds × sides × parts ×
  // directions × "then" chains × "while" layers × takes. vocabulary() reports the counts, inspire(seed) composes prompts.
  const TH = (words, to) => [new RegExp("\\b(?:" + words + ")\\b", "gi"), to];
  const THESAURUS = [
    TH("slurp(?:s|ed|ing)?|guzzl(?:e|es|ed|ing)|swig(?:s|ged|ging)?|quaff(?:s|ed|ing)?|chugg?(?:s|ed|ing)?|a pint|lemonade|juice|milkshake|smoothie|wine|whisky|whiskey|vodka|cocktail|energy drink|canteen|flask", "drink"),
    TH("devour(?:s|ed|ing)?|nibbl(?:e|es|ed|ing)|gobbl(?:e|es|ed|ing)|scarf(?:s|ed|ing)?|feast(?:s|ed|ing)?|taco|hot ?dog|noodles|ramen|sushi|ice cream|donut|doughnut|chips|popcorn|cake|chocolate|bread|lunch|dinner|breakfast", "eat"),
    TH("waltz(?:es|ed|ing)?|tango(?:s|ed|ing)?|salsa|samba|breakdanc(?:e|es|ed|ing)|boogie(?:s|d|ing)?|disco(?:s|ed|ing)?|jive(?:s|d)?|groov(?:e|es|ed|ing)|shimmy(?:ing)?|shimmies|moonwalk(?:s|ed|ing)?|macarena|ballet|hip ?hop dance|party dance|club dance|rav(?:e|es|ing)", "dance"),
    TH("pirouette(?:s|d)?|twirl(?:s|ed|ing)? around|spin(?:s|ning)? around", "twirl"),
    TH("snooz(?:e|es|ed|ing)|doz(?:e|es|ed|ing)|slumber(?:s|ed|ing)?|hibernat(?:e|es|ed|ing)|passed out|pass(?:es)? out|koed|k\\.?o\\.?'?d", "sleep"),
    TH("saunter(?:s|ed|ing)?|ambl(?:e|es|ed|ing)|mosey(?:s|ed|ing)?|meander(?:s|ed|ing)?|promenad(?:e|es|ing)|plod(?:s|ded|ding)?|trot(?:s|ted|ting)?|catwalk|runway walk|power walk(?:ing)?|strid(?:e|es|ing)|lumber(?:s|ed|ing)? along|waddl(?:e|es|ed|ing)|toddl(?:e|es|ed|ing)", "walk"),
    TH("scamper(?:s|ed|ing)?|scurr(?:y|ies|ied|ying)|bolt(?:s|ed|ing)? (?:away|forward|off)|flee(?:s|ing)?|fled|gallop(?:s|ed|ing)?|race(?:s|d)? forward|racing forward|hurr(?:y|ies|ied|ying)|rush(?:es|ed|ing)? forward|charge(?:s|d)? forward|charging forward|chase(?:s|d)?|chasing|hustl(?:e|es|ed|ing)", "run"),
    TH("vault(?:s|ed|ing)?|bound(?:s|ed|ing)? over|hurdl(?:e|es|ed|ing)|spring(?:s|ing)? up|pounc(?:e|es|ed|ing)|skip(?:s|ped|ping)? rope|jump ?rope|bunny ?hop(?:s|ping)?|trampoline", "jump"),
    TH("plummet(?:s|ed|ing)?|tumbl(?:e|es|ed|ing) down|plung(?:e|es|ed|ing) down|skydiv(?:e|es|ed|ing)", "fall"),
    TH("scal(?:e|es|ed|ing) (?:a |the )?(?:wall|cliff|rope|tree)|shimmy(?:ing)? up|clamber(?:s|ed|ing)?|rope climb|boulder(?:s|ed|ing)?|mountaineer(?:s|ing)?", "climb"),
    TH("backstrok(?:e|es|ing)|breaststrok(?:e|es|ing)|freestyle swim(?:ming)?|front crawl|doggy ?paddl(?:e|es|ing)|snorkel(?:s|ed|ing)?|scuba", "swim"),
    TH("perch(?:es|ed|ing)?|squat(?:s|ted|ting)? on (?:a |the )?(?:chair|bench|stool|log|rock)|plop(?:s|ped|ping)? down|take(?:s)? a seat|taking a seat|sit(?:s|ting)? down", "sit"),
    TH("duck(?:s|ed|ing)? down|hunker(?:s|ed|ing)? down|tiptoe(?:s|d|ing)? around|creep(?:s|ing)? around|crept|skulk(?:s|ed|ing)?|lurk(?:s|ed|ing)?|slink(?:s|ing)?|prowl(?:s|ed|ing)? around", "sneak"),
    TH("sock(?:s|ed|ing)?|wallop(?:s|ed|ing)?|clobber(?:s|ed|ing)?|slug(?:s|ged|ging)?|deck(?:s|ed)? (?:him|her|them)|haymaker|cross punch|one[- ]two|knuckle sandwich|beat(?:s)? up|beating up|brawl(?:s|ed|ing)?|fistfight|pummel(?:s|ed|ing)?", "punch"),
    TH("boot(?:s|ed|ing)? (?:him|her|them|it|the ball)|punt(?:s|ed|ing)?|drop ?kick(?:s|ed|ing)?|bicycle kick|high kick|front kick|side kick|back kick|knee strike|knee(?:s)? (?:him|her|them)", "kick"),
    TH("brandish(?:es|ed|ing)?|wield(?:s|ed|ing)?|unsheath(?:e|es|ed|ing)|machete|cutlass|scimitar|rapier|longsword|claymore|dagger|knife|cleaver|lightsaber|laser sword|energy blade|cut(?:s|ting)? down|hack(?:s|ed|ing)? at|chop(?:s|ped|ping)? at (?:him|her|them|the enemy)", "sword"),
    TH("hammer(?:s|ed|ing)?|sledgehammer|mallet|axe|hatchet|pickaxe|mine(?:s|d)? ore|mining|fell(?:s|ed|ing)? a tree|lumberjack|woodcut(?:ter|ting)|split(?:s|ting)? (?:logs|wood|firewood)", "chop wood"),
    TH("shovel(?:s|ed|ing)?|spade|trowel|excavat(?:e|es|ed|ing)|unearth(?:s|ed|ing)?|bur(?:y|ies|ied|ying) (?:the |a )?(?:treasure|body|bone|box|chest|loot)|gardening|plant(?:s|ed|ing)? (?:a |the )?(?:seed|tree|flower|flowers|crops)|till(?:s|ed|ing)? (?:the )?soil|hoe(?:s|d|ing)? (?:the )?(?:field|ground)", "dig"),
    TH("broom|mop(?:s|ped|ping)?|rake(?:s|d)?|raking|vacuum(?:s|ed|ing)?|hoover(?:s|ed|ing)?|brush(?:es|ed|ing)? (?:the )?(?:floor|ground|steps|porch)|tid(?:y|ies|ied|ying) up|janitor|clean(?:s|ed|ing)? (?:the )?(?:floor|room|house|deck)", "sweep"),
    TH("paintbrush|roller brush|whitewash(?:es|ed|ing)?|graffiti|spray ?paint(?:s|ed|ing)?|decorat(?:e|es|ed|ing) (?:a |the )?wall|plaster(?:s|ed|ing)?|varnish(?:es|ed|ing)?|artist at (?:an )?easel|easel", "paint"),
    TH("fishing rod|fishing pole|angl(?:e|es|ed|ing) for fish|cast(?:s|ing)? a line|reel(?:s|ed|ing)? in|go(?:es|ing)? fishing|fisherman", "fishing"),
    TH("oar(?:s)?|paddl(?:e|es|ed|ing)|canoe(?:s|d|ing)?|kayak(?:s|ed|ing)?|rowboat|rowing machine|erg(?:o)?meter", "rowing"),
    TH("pedal(?:s|led|ling)?|cycl(?:e|es|ed|ing) (?:fast|slow|along|uphill|downhill|to work)|bicycle|bmx|mountain bike|exercise bike|spin class|unicycle|tricycle", "cycling"),
    TH("steer(?:s|ed|ing)?|steering wheel|behind the wheel|truck(?:er|ing)|taxi driver|bus driver|race ?car|go[- ]?kart(?:ing)?|motorbike|motorcycle|quad bike|tractor|forklift", "drive"),
    TH("text(?:s|ed|ing)? (?:on|with) (?:a |the |my )?phone|scroll(?:s|ed|ing)? (?:on |through )?(?:a |the |my )?(?:phone|feed|tiktok|instagram)|doom ?scroll(?:s|ed|ing)?|facetim(?:e|es|ed|ing)|video call(?:s|ed|ing)?|smartphone|mobile phone|cell ?phone|dial(?:s|ed|ing)? (?:a |the )?number", "phone"),
    TH("keyboard warrior|type(?:s|d)? an? (?:email|message|essay|report)|writ(?:e|es|ing) code|cod(?:e|es|ing) on (?:a |the )?laptop|spreadsheet|office work(?:er)?|data entry|gamer|gaming|play(?:s|ing)? (?:video ?games|on (?:a |the )?pc|pc games)|pianist|harpsichord|synth(?:esizer)? solo", "typing"),
    TH("electric guitar|acoustic guitar|banjo|mandolin|cello|violin|fiddl(?:e|es|ed|ing)|air guitar|rock ?star|busk(?:s|ed|ing)?|busker", "guitar"),
    TH("bongos?|tabla|timpani|snare|cymbals?|xylophone|marimba|drumstick(?:s)?|beat(?:s|ing)? (?:a |the )?(?:drum|drums)", "drums"),
    TH("gym bro|bodybuild(?:er|ing)|show(?:s|ing)? off (?:his |her |their )?(?:muscles|biceps|guns)|pose(?:s|d)? like (?:a )?bodybuilder|muscle pose|bicep(?:s)? pose|strongman pose", "flex"),
    TH("lift(?:s|ed|ing)? weights|weightlift(?:s|ed|ing|er)?|barbell|dumbbells?|kettlebell|bench ?press(?:es|ed|ing)?|deadlift(?:s|ed|ing)?|clean and jerk|snatch(?:es|ed|ing)? (?:the )?bar|overhead press|military press|power ?lift(?:ing|er)?", "deadlift"),
    TH("haul(?:s|ed|ing)?|lug(?:s|ged|ging)?|schlep(?:s|ped|ping)?|carr(?:y|ies|ied|ying) (?:a |the )?(?:sack|bag|barrel|log|body)|moving boxes|porter|delivery (?:guy|man|person)", "carry a box"),
    TH("shov(?:e|es|ed|ing)|heav(?:e|es|ed|ing)|bulldoz(?:e|es|ed|ing)|ram(?:s|med|ming)? (?:the |a )?(?:door|wall|gate)|push(?:es|ed|ing)? (?:a |the )?(?:cart|car|boulder|crate|wall|box|stroller|wheelbarrow)|shoulder barg(?:e|es|ed|ing)", "shove"),
    TH("tug(?:s|ged|ging)?|yank(?:s|ed|ing)?|drag(?:s|ged|ging)? (?:a |the )?(?:body|crate|sled|rope|net|anchor)|tow(?:s|ed|ing)? (?:a |the )?(?:car|boat|sled)|tug of war|haul(?:s|ed|ing)? (?:a |the |in the )?(?:rope|net|anchor|line)|rope pull", "haul"),
    TH("fist ?bump(?:s|ed|ing)?|bro ?fist|knuckle bump|dap(?:s|ped|ping)? (?:him|her|them|up)", "fistbump"),
    TH("high ?five(?:s|d)?|high[- ]fiving|up top|slap(?:s|ped|ping)? hands", "highfive"),
    TH("embrac(?:e|es|ed|ing)|cuddl(?:e|es|ed|ing)|snuggl(?:e|es|ed|ing)|bear ?hug|group hug|hold(?:s|ing)? (?:him|her|them) (?:tight|close)|squeez(?:e|es|ed|ing) (?:him|her|them)", "hug"),
    TH("shake(?:s|n)? hands|shaking hands|hand ?shake|seal(?:s|ed|ing)? the deal|business greeting|firm grip", "handshake"),
    TH("thumbs?[- ]up|like button|approv(?:e|es|ed|ing) gesture|good job gesture|okay sign|ok sign", "thumbsup"),
    TH("blow(?:s|ing)? (?:a |some )?kiss(?:es)?|air kiss(?:es)?|flirt(?:s|ed|ing)?|smooch(?:es|ed|ing)? (?:the air|at)", "blow a kiss"),
    TH("ponder(?:s|ed|ing)?|contemplat(?:e|es|ed|ing)|muse(?:s|d)?|musing|puzzl(?:e|es|ed|ing) over|deliberat(?:e|es|ed|ing)|wonder(?:s|ed|ing)? about|chin stroke|strok(?:e|es|ed|ing) (?:his |her |their )?(?:chin|beard)|hmm+|thinking face", "think"),
    TH("limber(?:s|ed|ing)? up|warm(?:s|ed|ing)? up|yoga|pilates|sun salutation|touch(?:es|ed|ing)? (?:his |her |their )?toes|loosen(?:s|ed|ing)? up|cool ?down stretch|hamstring stretch|calf stretch|neck roll(?:s)?", "stretch"),
    TH("freez(?:e|es|ing) cold|frostbit(?:e|ten)|brr+|teeth chatter(?:s|ing)?|hypotherm(?:ia|ic)|goosebumps|chill(?:s|ed|y) to the bone|shudder(?:s|ed|ing)? (?:from|with|in) (?:the )?cold", "shiver"),
    TH("sob(?:s|bed|bing)?|weep(?:s|ing)?|wept|bawl(?:s|ed|ing)?|blubber(?:s|ed|ing)?|tear(?:s|ed|ing)? up|in tears|heartbroken|mourn(?:s|ed|ing)?|griev(?:e|es|ed|ing)|wail(?:s|ed|ing)?", "cry"),
    TH("tantrum|throw(?:s|ing)? a fit|foot ?stamp(?:s|ed|ing)?|stamp(?:s|ed|ing)? (?:his |her |their )?(?:foot|feet)|angry stomp(?:s|ing)?", "stomp"),
    TH("knock(?:s|ed|ing)? on|rap(?:s|ped|ping)? on (?:the |a )?(?:door|window|table)|bang(?:s|ed|ing)? on (?:the |a )?(?:door|window|wall|glass)|door ?bell|ring(?:s|ing)? the bell", "knock"),
    TH("unlock(?:s|ed|ing)? (?:a |the )?(?:door|gate|chest)|swing(?:s|ing)? (?:a |the )?(?:door|gate) open|kick(?:s|ed|ing)? (?:a |the )?door open|barg(?:e|es|ed|ing) (?:in|through)|burst(?:s)? through (?:a |the )?door|open(?:s|ed|ing)? (?:a |the )?(?:fridge|cupboard|closet|wardrobe|window|hatch|trunk|coffin|crate|box|locker)", "open the door"),
    TH("squint(?:s|ed|ing)?|peer(?:s|ed|ing)? (?:out|into the distance|ahead)|scout(?:s|ed|ing)?|lookout|binoculars|spot(?:s|ted|ting)? something far|hand over (?:his |her |their )?eyes|search(?:es|ed|ing)? the horizon|scan(?:s|ned|ning)? the horizon", "gaze"),
    TH("glance(?:s|d)? around|glancing around|survey(?:s|ed|ing)? the (?:room|area)|check(?:s|ed|ing)? (?:his |her |their )?surroundings|lost tourist|where am i|look(?:s|ed|ing)? for (?:something|someone|the exit)|searching the room|confused look", "look around"),
    TH("mop(?:s|ped|ping)? (?:his |her |their )?(?:brow|forehead)|phew|wipe(?:s|d)? (?:away )?(?:the )?sweat|wiping sweat|sweaty|out of (?:breath|puff)|exhausted after", "wipe the sweat"),
    TH("dust(?:s|ed|ing)? (?:himself|herself|themselves) off|brush(?:es|ed|ing)? (?:himself|herself|themselves) off|pat(?:s|ted|ting)? (?:his |her |their )?(?:pockets|clothes)|itch(?:es|ed|ing|y)?|flea(?:s)?|mosquito bite", "scratch"),
    TH("jumping jacks?|star jumps?|jump(?:s|ed|ing)? jack|aerobics|hiit|cardio", "jumping jacks"),
    TH("air squats?|goblet squat|sumo squat|leg day|squat(?:s|ted|ting)? (?:down )?(?:and|then) (?:stand|up|stands)|deep squats?|burpee(?:s)?", "squat"),
    TH("sit[- ]?ups?|crunch(?:es)?|ab(?:s|dominal)? (?:workout|exercise)|core workout|v[- ]ups?", "situp"),
    TH("meditat(?:e|es|ed|ing)|zen|lotus (?:pose|position)|mindful(?:ness)?|monk pose|yogi|om+|levitat(?:e|es|ing) in lotus|inner peace", "meditate"),
    TH("salut(?:e|es|ed|ing) (?:the )?(?:flag|officer|captain|general|commander)|soldier salute|at attention|stand(?:s|ing)? at attention|attention stance|yes sir", "salute"),
    TH("curts(?:y|ies|ied|ying)|royal curtsy|ladylike bow|princess greeting", "curtsy"),
    TH("sulk(?:s|ed|ing)?|mop(?:e|es|ed|ing)|downcast|dejected|gloomy|melancholy|despair(?:s|ed|ing)?|hopeless|miserable|blue mood|defeated look|hang(?:s|ing)? (?:his |her |their )?head", "sad"),
    TH("ecstatic|overjoyed|thrilled|delighted|jolly|cheerful|giddy|elated|jubilant|gleeful|joyful|beaming", "happy"),
    TH("furious|enraged|livid|irate|seething|fuming|rage(?:s|d)?|raging|infuriated|mad as hell|pissed off|hot[- ]headed|wrathful", "angry"),
    TH("terrified|petrified|frightened|spooked|horrified|panick(?:ed|ing|y)|panic(?:s)?|jumpy|anxious|trembling with fear|afraid|fearful|creeped out|freaked out", "scared"),
    TH("smug|cocky|arrogant|boastful|haughty|conceited|confident|swagger(?:s|ed|ing)?|chest out|triumphant|regal|majestic|kingly|queenly|noble", "proud"),
    TH("elderly|geriatric|grandpa|grandma|granny|senior citizen|aged|ancient man|frail|creaky|hunched old|with a cane|walking stick|arthritic", "old"),
    TH("wounded|hurt leg|hurt arm|limp(?:s|ed|ing)?|bleeding|bandaged|crippled|sprained|broken leg|broken arm|clutch(?:es|ed|ing) (?:his |her |their )?(?:side|wound|stomach|arm|leg)|battle[- ]damaged", "injured"),
    TH("wasted|hammered|tipsy|intoxicated|plastered|sloshed|inebriated|boozed|buzzed|woozy|stumbling drunk|three sheets", "drunk"),
    TH("sleepy|drowsy|weary|fatigued|worn out|knackered|exhausted|drained|lethargic|sluggish|yawning|groggy|dead on (?:his |her |their )?feet|burnt out|burned out", "tired"),
    TH("hyper(?:active)?|peppy|zippy|perky|bubbly|pumped(?: up)?|hyped(?: up)?|amped(?: up)?|caffeinated|wired|full of beans|bouncing off the walls|jazzed|fired up", "energetic"),
    TH("freezing|frozen stiff|chilly|icy cold|arctic|in the snow|snowstorm|blizzard|winter cold", "cold"),
    TH("stealthy|sneaky|shifty|suspicious looking|up to no good|mischievous|cat burglar|thief|burglar|pickpocket|spy(?:ing)? around", "sneaky"),
    TH("antsy|jittery|fidgety|uneasy|on edge|restless|stage fright|awkward|shy and awkward|bashful|sheepish", "nervous"),
    TH("boogie ?woogie|robot dance|do the robot|the worm|running man|cabbage patch|sprinkler dance|dougie|whip and nae nae|gangnam style|orange justice|take the l|hype dance", "dance"),
    TH("superhero pose|power stance|hands on hips|heroic stance|victory stance|stand(?:s|ing)? heroically|superman pose|wonder woman pose|strik(?:e|es|ing) a (?:heroic |power )?pose", "hero pose"),
    TH("three[- ]point landing|superhero landing|hero drop|land(?:s|ed|ing)? like a hero|iron man landing|crater landing", "hero landing"),
    TH("sprinkler|dabb?(?:s|ed|ing)? on (?:them|haters)|hit(?:s|ting)? the dab", "dab"),
    TH("box(?:es|ed|ing)? (?:the air|practice|training)|shadow ?box(?:es|ed|ing)?|sparr(?:ed|ing)|spar(?:s)?|punching bag|heavy bag|speed bag|pad work|boxer stance|fighting stance", "boxing"),
    TH("pray(?:s|ed|ing)? for|say(?:s|ing)? a prayer|hands together in prayer|grace before (?:a )?meal|bless(?:es|ed|ing)? (?:himself|herself|themselves)|namaste|amen|plead(?:s|ed|ing)? on (?:his |her |their )?knees|beg(?:s|ged|ging)? for (?:mercy|forgiveness|his life|her life|their life)", "pray"),
    TH("stroke(?:s|d)? (?:a |the )?(?:dog|cat|puppy|kitten|horse|animal|pet)|stroking (?:a |the )?(?:dog|cat|puppy|kitten|horse|animal|pet)|pat(?:s|ted|ting)? (?:a |the )?(?:dog|cat|puppy|kitten|horse|animal|pet|head)|scratch(?:es|ed|ing)? (?:a |the )?(?:dog|cat|puppy|kitten)|good boy|good girl|pet(?:s|ted|ting)? (?:a |the )?(?:dog|cat|puppy|kitten|horse|animal)", "pet the dog"),
    TH("bow(?:s|ed|ing)? (?:his |her |their )?head|dip(?:s|ped|ping)? (?:his |her |their )?head|head bow|respectful nod|solemn nod|moment of silence", "bow the head"),
    TH("flail(?:s|ed|ing)?|wav(?:e|es|ed|ing) (?:his |her |their |both )?arms (?:around|wildly|frantically|for help)|signal(?:s|led|ling)? for help|help me gesture|hail(?:s|ed|ing)? a (?:taxi|cab|bus)|flag(?:s|ged|ging)? down (?:a |the )?(?:car|taxi|bus|plane|ship)|arms in the air|hands in the air|put your hands up", "wave both arms"),
    TH("balanc(?:e|es|ed|ing) on (?:a |the )?(?:beam|rope|ledge|edge|tightrope|wire|rail)|tightrope|balance beam|slackline|teeter(?:s|ed|ing)? on (?:a |the )?(?:ledge|edge)|wobbl(?:e|es|ed|ing) on (?:a |the )?(?:ledge|edge|beam)", "lean on a wall"),
    TH("stargaz(?:e|es|ed|ing)|cloud ?watch(?:es|ed|ing)?|bird ?watch(?:es|ed|ing)?|watch(?:es|ed|ing)? (?:the )?(?:sunset|sunrise|sky|stars|fireworks|birds|planes)|admir(?:e|es|ed|ing) the view|look(?:s|ed|ing)? up at (?:the )?(?:sky|stars|moon|clouds|ceiling)|gaz(?:e|es|ed|ing) at (?:the )?(?:sky|stars|horizon|sunset|moon)", "gaze"),
    TH("reach(?:es|ed|ing)? (?:up )?for (?:the |a )?(?:top shelf|shelf|cookie jar|ceiling|high branch|apple)|too short to reach|stand(?:s|ing)? on tiptoes?|on (?:his |her |their )?tiptoes?|tippy ?toes?", "reach up"),
    TH("car sick|sea ?sick|vertigo|lightheaded|light[- ]headed|spun around|stunned|dazed|woozy and spinning|concussed|stars around (?:his |her |their )?head|seeing stars|head spinning", "dizzy"),
    TH("winded|gasp(?:s|ed|ing)? for (?:air|breath)|catch(?:es|ing)? (?:his |her |their )?breath|catching breath|huff(?:s|ed|ing)? and puff(?:s|ed|ing)?|out of breath|breathless|hands on (?:his |her |their )?knees (?:panting|breathing|exhausted)", "pant"),
    TH("hands up|hands in the air don't shoot|give(?:s)? up|giving up|i surrender|white flag|don't (?:shoot|hurt me)|yield(?:s|ed|ing)?|submit(?:s|ted|ting)?|capitulat(?:e|es|ed|ing)", "surrender"),
    TH("cring(?:e|es|ed|ing)|flinch(?:es|ed|ing)? away|shield(?:s|ed|ing)? (?:his |her |their )?face|brac(?:e|es|ed|ing) for impact|recoil(?:s|ed|ing)? in fear|shrink(?:s|ing)? (?:back|away)|shrank back|curl(?:s|ed|ing)? up (?:in fear|scared|terrified)|protect(?:s|ed|ing)? (?:his |her |their )?head", "cower"),
    TH("clucks?|cluck(?:s|ed|ing)?|bawk|chicken dance|flap(?:s|ped|ping)? (?:his |her |their )?(?:wings|arms like wings)|bird dance|chicken walk|hen", "chicken"),
    TH("football kick|penalty kick|free kick|volley(?:s|ed|ing)? (?:a |the )?ball|shoot(?:s|ing)? (?:a |the )?(?:football|soccer ball)|striker|kick(?:s|ed|ing)? (?:a |the )?(?:ball|football|soccer ball)", "soccer"),
    TH("catch(?:es|ing)? (?:a |the )?(?:ball|frisbee|football|baseball|pass)|caught (?:a |the )?(?:ball|frisbee|football|pass)|receiv(?:e|es|ed|ing) (?:a |the )?(?:pass|ball)|wide receiver|goalkeeper (?:save|catch)|fielder", "catch"),
    TH("baseball bat|cricket bat|home ?run|swing(?:s|ing)? (?:a |the )?bat|batter up|batting|slugger|hit(?:s|ting)? (?:a |the )?(?:baseball|home run|ball with a bat)|rounders", "baseball swing"),
    TH("dribbl(?:e|es|ed|ing)|slam ?dunk(?:s|ed|ing)?|dunk(?:s|ed|ing)?|free throw|three[- ]pointer|jump shot|lay ?up|hoops|nba", "basketball"),
    TH("blink(?:s|ed|ing)? away tears|sobbing laugh|teardrop|tear(?:s)? streaming", "cry"),
    TH("salute(?:s|d)? with (?:a |the )?sword", "salute"),
    TH("wave(?:s|d)? goodbye|goodbye wave|wave(?:s|d)? hi|wave(?:s|d)? hello|wave(?:s|d)? at (?:the )?(?:crowd|camera|fans|friend|kids)|say(?:s|ing)? (?:hi|hello|goodbye|bye)|hiya|howdy|greets? (?:the )?(?:crowd|fans|camera)", "wave"),
    TH("round of applause|standing ovation|give(?:s)? (?:him|her|them|it) a hand|golf clap|slow clap|clapp?(?:s|ed|ing)? along|applaud(?:s|ed|ing)?", "clap"),
    TH("giggl(?:e|es|ed|ing)|chuckl(?:e|es|ed|ing)|cackl(?:e|es|ed|ing)|guffaw(?:s|ed|ing)?|snicker(?:s|ed|ing)?|lol|rofl|lmao|crack(?:s|ed|ing)? up|burst(?:s)? out laughing|belly laugh|evil laugh|maniacal laugh|villain laugh|muahaha+", "laugh"),
    TH("kneel(?:s|ed|ing)? before|take(?:s)? a knee|taking a knee|genuflect(?:s|ed|ing)?|knight(?:s|ed|ing)? (?:him|her|them)|be knighted|accolade|propose(?:s|d)? marriage|will you marry me|down on one knee", "kneel"),
    TH("hooray|hurray|hurrah|yay+|woo+hoo+|woot|yes+!|let'?s go+!|gg|victory dance|celebrat(?:e|es|ed|ing) (?:a |the )?(?:win|goal|victory|touchdown)|pump(?:s|ed|ing)? (?:up )?the crowd|fist in the air|arms raised in victory|champion(?:ship)? celebration", "cheer"),
    TH("exclaim(?:s|ed|ing)?|accus(?:e|es|ed|ing)|blam(?:e|es|ed|ing) (?:him|her|them|someone)|it was him|it was her|that one|over there|look over there|gestur(?:e|es|ed|ing) (?:at|toward|towards)|indicat(?:e|es|ed|ing) (?:the|a) (?:door|exit|way|direction)|show(?:s|ed|ing)? the way|direct(?:s|ed|ing)? traffic", "point"),
    TH("meh|whatever gesture|beats me|no idea|who knows|not sure gesture|couldn'?t care less|palms up confused", "shrug"),
    TH("oh no|oh dear|oh brother|smh|hand on (?:his |her |their )?forehead|rub(?:s|bed|bing)? (?:his |her |their )?(?:temples|forehead|eyes in frustration)|exasperated|headache gesture|can'?t believe (?:it|this)|cringe(?:s|d|ing)? hard|embarrass(?:ed|ing) (?:himself|herself|themselves)", "facepalm"),
    TH("curse(?:s|d)? at|cursing at|insult(?:s|ed|ing)?|trash ?talk(?:s|ed|ing)?|provok(?:e|es|ed|ing)|goad(?:s|ed|ing)?|jeer(?:s|ed|ing)?|heckl(?:e|es|ed|ing)|flex(?:es|ed|ing)? on (?:him|her|them|the enemy)|you want some|fight me|come here gesture|beckon(?:s|ed|ing)? (?:the enemy|them to fight)", "taunt"),
    TH("hover(?:s|ed|ing)? in (?:the )?air|superman flight|flies like superman|soar(?:s|ed|ing)?|glid(?:e|es|ed|ing) through the air|jetpack|iron man flight|take(?:s)? off into the sky|airborne hero|float(?:s|ed|ing)? (?:in )?mid ?air", "fly"),
    TH("belly crawl|slither(?:s|ed|ing)? (?:along|forward|on the ground)|worm(?:s|ed|ing)? (?:along|forward)|commando crawl|crawl(?:s|ed|ing)? (?:through|under) (?:a |the )?(?:vent|tunnel|fence|wire|pipe)|on all fours", "crawl"),
    TH("backpedal(?:s|led|ling)?|back(?:s|ed|ing)? away|backing away|step(?:s|ped|ping)? back(?:wards?)?|retreat(?:s|ed|ing)? slowly|walk(?:s|ed|ing)? away backwards|reverse(?:s|d)? slowly", "backward"),
    TH("sidestep(?:s|ped|ping)? (?:left|right|along)|side ?shuffl(?:e|es|ed|ing)|crab ?walk(?:s|ed|ing)?|lateral (?:shuffle|movement|steps)|defensive shuffle|circle(?:s|d)? (?:around )?(?:the |an? )?(?:enemy|opponent|target)|circling (?:the |an? )?(?:enemy|opponent|target)", "strafe"),
    TH("lob(?:s|bed|bing)?|chuck(?:s|ed|ing)?|fling(?:s|ing)?|flung|pitch(?:es|ed|ing)? (?:a |the )?(?:ball|baseball)|pitcher|hurl(?:s|ed|ing)? (?:a |the )?(?:spear|javelin|rock|stone|grenade|axe|knife)|javelin|shot ?put|discus|skip(?:s|ped|ping)? (?:a |the )?(?:stone|rock|pebble)|grenade|snowball|throw(?:s|ing)? (?:a |the )?(?:ball|stone|rock|spear|dart|frisbee|snowball|shuriken|knife|axe)", "throwing"),
    TH("rifle|pistol|revolver|shotgun|sniper|musket|blaster|laser gun|ray ?gun|machine gun|smg|assault rifle|handgun|crossbow bolt|pew pew|gun(?:s|ned|ning)? (?:down|them)|open(?:s|ed|ing)? fire|firing|fires? (?:at|on) (?:the )?(?:enemy|target|them)", "shoot"),
    TH("longbow|shortbow|recurve bow|compound bow|nock(?:s|ed|ing)? an arrow|loos(?:e|es|ed|ing) an arrow|arrow(?:s)? at|robin hood|legolas|archer stance|bowman|bowwoman", "archery"),
    TH("scoop(?:s|ed|ing)? up|bend(?:s|ing)? (?:down|over) (?:and|to) (?:pick|grab|take|lift)|retriev(?:e|es|ed|ing) (?:a |the |an )?(?:item|object|coin|key|sword|weapon|bag|box)|loot(?:s|ed|ing)?|collect(?:s|ed|ing)? (?:a |the |an )?(?:coin|coins|item|items|gem|gems|loot)|take(?:s|ing)? (?:a |the |an )?(?:item|object|coin|key|weapon) from the (?:ground|floor)", "pickup"),
    TH("parkour vault|wall ?run(?:s|ning)?|free ?run(?:ning|ner)?|ninja run|roof(?:top)? run(?:ning)?", "run"),
  ];
  function expandVocabulary(text) {
    let t = String(text || ""); const swaps = [];
    const known = (m) => !!findMood(m) || Object.keys(ACTS).some((a) => { const x = m.match(ACTS[a].rx); return x && x[0].length >= m.length - 2; }); // never rewrite a phrase the lexicon already understands as a whole
    for (const [rx, to] of THESAURUS) { rx.lastIndex = 0; if (!rx.test(t)) { rx.lastIndex = 0; continue; } rx.lastIndex = 0; t = t.replace(rx, (m) => { if (m.toLowerCase() === to || known(m)) return m; swaps.push(m.toLowerCase() + " → " + to); return to; }); rx.lastIndex = 0; }
    return { text: t, swaps: [...new Set(swaps)] };
  }
  // VERB CLASSES: body region + pattern for motion verbs outside the act lexicon. Rendered through the pose grammar.
  const VC = (words, part, pattern, amp, extra) => Object.assign({ rx: new RegExp("\\b(?:" + words + ")\\b", "i"), words, part, pattern, amp: amp || 1 }, extra || {});
  const VERB_CLASSES = [
    VC("wring(?:s|ing)?|wrung|knead(?:s|ed|ing)?|squeez(?:e|es|ed|ing)|pinch(?:es|ed|ing)?|crumpl(?:e|es|ed|ing)|rub(?:s|bed|bing)? (?:his |her |their )?hands|warm(?:s|ed|ing)? (?:his |her |their )?hands|lather(?:s|ed|ing)?|scrub(?:s|bed|bing)? (?:his |her |their )?hands|wash(?:es|ed|ing)? (?:his |her |their )?hands|fidget(?:s|ed|ing)? with", "hands", "pulse", 0.9),
    VC("stir(?:s|red|ring)?|whisk(?:s|ed|ing)?|mix(?:es|ed|ing)? (?:the )?(?:batter|dough|bowl|pot|paint|potion)|ladl(?:e|es|ed|ing)|crank(?:s|ed|ing)?|wind(?:s|ing)? (?:up )?(?:a |the )?(?:clock|toy|handle|crank|jack)|churn(?:s|ed|ing)?|grind(?:s|ing)? (?:coffee|pepper|grain)|turn(?:s|ed|ing)? (?:a |the )?(?:crank|handle|wheel|valve|knob|dial)", "arm", "circle", 1),
    VC("swat(?:s|ted|ting)?|slap(?:s|ped|ping)?|smack(?:s|ed|ing)?|spank(?:s|ed|ing)?|whack(?:s|ed|ing)?|swipe(?:s|d)?|swiping|flick(?:s|ed|ing)?|shoo(?:s|ed|ing)?|bat(?:s|ted|ting)? away|fan(?:s|ned|ning)? (?:himself|herself|themselves|the air|his face|her face)|wav(?:e|es|ed|ing) (?:away|off) (?:a |the )?(?:fly|smoke|smell|bug|mosquito)", "arm", "osc", 1.1, { fast: true }),
    VC("pok(?:e|es|ed|ing)|prod(?:s|ded|ding)?|jab(?:s|bed|bing)? (?:at|the button|a button)|press(?:es|ed|ing)? (?:a |the )?(?:button|buzzer|switch|doorbell|keypad)|push(?:es|ed|ing)? (?:a |the )?(?:button|buzzer|switch)|tap(?:s|ped|ping)? (?:a |the )?(?:screen|button|glass|window)|ring(?:s|ing)? (?:a |the )?(?:buzzer|doorbell)|dial(?:s|ed|ing)?|touch(?:es|ed|ing)? (?:a |the )?(?:screen|panel|wall|glass)", "arm", "hold", 0.9, { dir: "forward" }),
    VC("beckon(?:s|ed|ing)?|summon(?:s|ed|ing)? (?:him|her|them) over|come here|come hither|gestur(?:e|es|ed|ing) to (?:come|follow)|motion(?:s|ed|ing)? (?:him|her|them) (?:over|closer|forward)|signal(?:s|led|ling)? (?:to )?(?:stop|go|come|advance|left|right)|wav(?:e|es|ed|ing) (?:him|her|them) (?:over|through|in)|conduct(?:s|ed|ing)? (?:an? |the )?(?:orchestra|choir|band)|direct(?:s|ed|ing)? (?:an? |the )?(?:orchestra|choir|band)|maestro|usher(?:s|ed|ing)?", "arm", "osc", 1),
    VC("writ(?:e|es|ing)|wrote|scribbl(?:e|es|ed|ing)|sketch(?:es|ed|ing)?|draw(?:s|ing)? (?:a |the )?(?:picture|map|portrait|sketch|diagram|circle)|doodl(?:e|es|ed|ing)|sign(?:s|ed|ing)? (?:a |the )?(?:paper|contract|form|autograph|cheque|check|document)|autograph(?:s|ed|ing)?|jot(?:s|ted|ting)?|fill(?:s|ed|ing)? (?:in|out) (?:a |the )?form|take(?:s|ing)? notes|not(?:e|es|ed|ing) down|knit(?:s|ted|ting)?|sew(?:s|ed|ing|n)?|crochet(?:s|ed|ing)?|embroider(?:s|ed|ing)?|stitch(?:es|ed|ing)?|whittl(?:e|es|ed|ing)|carv(?:e|es|ed|ing)|sculpt(?:s|ed|ing)?|solder(?:s|ed|ing)?|tinker(?:s|ed|ing)?|repair(?:s|ed|ing)?|fix(?:es|ed|ing)? (?:a |the )?(?:engine|pipe|wire|machine|toy|watch|bike)|read(?:s|ing)? (?:a |the )?(?:book|map|letter|scroll|note|newspaper|menu|sign)", "hands", "hold", 0.8, { dir: "chest" }),
    VC("juggl(?:e|es|ed|ing)|toss(?:es|ed|ing)? (?:a |the )?(?:coin|ball|apple) (?:up|in the air)|flip(?:s|ped|ping)? a coin|coin flip|bounc(?:e|es|ed|ing) a ball|dribbl(?:e|es|ed|ing) (?:a |the )?ball|yo[- ]?yo|spin(?:s|ning)? a (?:pen|pencil|coin|ball)|twirl(?:s|ed|ing)? a (?:baton|pen|staff|sword|stick)|baton", "hands", "osc", 1, { fast: true, dir: "up" }),
    VC("count(?:s|ed|ing)? on (?:his |her |their )?fingers|count(?:s|ed|ing)? (?:money|coins|cash|bills)|finger ?gun(?:s)?|snap(?:s|ped|ping)? (?:his |her |their )?fingers|finger snap|click(?:s|ed|ing)? (?:his |her |their )?fingers|crack(?:s|ed|ing)? (?:his |her |their )?(?:knuckles|fingers)|examin(?:e|es|ed|ing) (?:his |her |their )?(?:nails|hand|ring|watch)|check(?:s|ed|ing)? (?:his |her |their )?(?:watch|nails|phone briefly)|look(?:s|ed|ing)? at (?:his |her |their )?(?:watch|hand|nails|palm)", "arm", "hold", 0.7, { dir: "chest" }),
    VC("stamp(?:s|ed|ing)? (?:a |the )?(?:foot|feet|ground)|tap(?:s|ped|ping)? (?:a |his |her |their |the )?(?:foot|feet|toe|toes)|foot ?tap(?:s|ping)?|impatient(?:ly)? tap(?:s|ping)?|kick(?:s|ed|ing)? (?:a |the )?(?:dirt|dust|pebble|can|rock|sand|ball around)|scuff(?:s|ed|ing)? (?:his |her |their )?(?:feet|shoes|foot)|drag(?:s|ged|ging)? (?:his |her |their )?feet|shuffl(?:e|es|ed|ing) (?:his |her |their )?feet|stomp(?:s|ed|ing)? in place|march(?:es|ed|ing)? in place|jog(?:s|ged|ging)? in place|run(?:s|ning)? in place|high knees|butt kicks", "leg", "osc", 1),
    VC("trip(?:s|ped|ping)? (?:over|on)|slip(?:s|ped|ping)? on|stumbl(?:e|es|ed|ing) (?:over|on|back|forward)|lurch(?:es|ed|ing)?|totter(?:s|ed|ing)?|teeter(?:s|ed|ing)?|wobbl(?:e|es|ed|ing)|lose(?:s)? (?:his |her |their )?balance|losing (?:his |her |their )?balance|off[- ]balance|regain(?:s|ed|ing)? balance|catch(?:es|ing)? (?:himself|herself|themselves)", "torso", "sway", 1.2),
    VC("sway(?:s|ed|ing)?|rock(?:s|ed|ing)? (?:back and forth|side to side|gently|slowly|in place)|bob(?:s|bed|bing)?|bobbl(?:e|es|ed|ing)|jiggl(?:e|es|ed|ing)|wiggl(?:e|es|ed|ing) (?:around|in place|his hips|her hips|their hips)|twerk(?:s|ed|ing)?|gyrat(?:e|es|ed|ing)|hula|belly ?danc(?:e|es|ed|ing)|hip ?sway(?:s|ing)?|squirm(?:s|ed|ing)?|writh(?:e|es|ed|ing)|wriggl(?:e|es|ed|ing)|limbo|grind(?:s|ed|ing)? (?:on|to) the (?:beat|music)|vib(?:e|es|ed|ing) to|nod(?:s|ded|ding)? (?:along )?to the (?:beat|music)", "torso", "sway", 1),
    VC("trembl(?:e|es|ed|ing)|shudder(?:s|ed|ing)?|quak(?:e|es|ed|ing)|quiver(?:s|ed|ing)?|convuls(?:e|es|ed|ing)|twitch(?:es|ed|ing)?|spasm(?:s|ed|ing)?|jitter(?:s|ed|ing)?|vibrat(?:e|es|ed|ing)|shak(?:e|es|ing) (?:all over|uncontrollably|violently|like a leaf|with rage|with fear)|electrocut(?:ed|ion)|zapped|tased|shock(?:ed)? by|seizure|glitch(?:es|ed|ing)?|malfunction(?:s|ed|ing)?|short[- ]circuit(?:s|ed|ing)?", "torso", "tremble", 0.8, { fast: true }),
    VC("slump(?:s|ed|ing)?|sag(?:s|ged|ging)?|droop(?:s|ed|ing)?|wilt(?:s|ed|ing)?|deflat(?:e|es|ed|ing)|faint(?:s|ed|ing)?|swoon(?:s|ed|ing)?|keel(?:s|ed|ing)? over|crumpl(?:e|es|ed|ing) (?:to the ground|down)|go(?:es)? limp|going limp|hang(?:s|ing)? limp|doubl(?:e|es|ed|ing) over|hunch(?:es|ed|ing)? over|bent over|bend(?:s|ing)? over|stoop(?:s|ed|ing)?|cower(?:s|ed|ing)? down", "torso", "slump", 1),
    VC("puff(?:s|ed|ing)? (?:out |up )?(?:his |her |their )?chest|chest puff|straighten(?:s|ed|ing)? up|stand(?:s|ing)? (?:up )?(?:tall|straight|proud)|square(?:s|d)? (?:his |her |their )?shoulders|shoulders back|crack(?:s|ed|ing)? (?:his |her |their )?(?:neck|back)|roll(?:s|ed|ing)? (?:his |her |their )?(?:shoulders|neck)|shoulder roll(?:s)?|arch(?:es|ed|ing)? (?:his |her |their )?back|lean(?:s|ed|ing)? back and relax(?:es)?", "torso", "arch", 1),
    VC("peek(?:s|ed|ing)?|peep(?:s|ed|ing)?|glanc(?:e|es|ed|ing)|glimps(?:e|es|ed|ing)|look(?:s|ed|ing)? (?:over|behind|back over) (?:his |her |their )?shoulder|check(?:s|ed|ing)? behind|double[- ]take|do(?:es)? a double take|eavesdrop(?:s|ped|ping)?|listen(?:s|ed|ing)? (?:in|closely|at the door|carefully)|cock(?:s|ed|ing)? (?:his |her |their )?head|tilt(?:s|ed|ing)? (?:his |her |their )?head", "head", "turn", 1),
    VC("star(?:e|es|ed|ing)|gaz(?:e|es|ed|ing)|gawk(?:s|ed|ing)?|gap(?:e|es|ed|ing)|ogl(?:e|es|ed|ing)|glar(?:e|es|ed|ing)|scowl(?:s|ed|ing)?|frown(?:s|ed|ing)?|squint(?:s|ed|ing)? at|death ?stare|stare[- ]?down|eye(?:s|d|ing)? (?:him|her|them|it) (?:up|suspiciously)|size(?:s|d)? (?:him|her|them) up|sizing (?:him|her|them) up|inspect(?:s|ed|ing)?|examin(?:e|es|ed|ing)|scrutiniz(?:e|es|ed|ing)|studies|stud(?:y|ying) (?:the|a|an) (?:map|screen|painting|object|wall)", "head", "hold", 0.8, { dir: "forward" }),
    VC("sniff(?:s|ed|ing)?|smell(?:s|ed|ing)?|snort(?:s|ed|ing)?|whiff|inhal(?:e|es|ed|ing)|breath(?:e|es|ed|ing) (?:in )?deeply|deep breath|take(?:s)? a deep breath|exhal(?:e|es|ed|ing)|sigh(?:s|ed|ing)?|yawn(?:s|ed|ing)?|hiccup(?:s|ed|ing)?|burp(?:s|ed|ing)?|belch(?:es|ed|ing)?|gag(?:s|ged|ging)?|retch(?:es|ed|ing)?|puk(?:e|es|ed|ing)|vomit(?:s|ed|ing)?|throw(?:s|ing)? up|cough(?:s|ed|ing)? up", "head", "nod", 0.9),
    VC("scream(?:s|ed|ing)?|shout(?:s|ed|ing)?|yell(?:s|ed|ing)?|holler(?:s|ed|ing)?|bellow(?:s|ed|ing)?|roar(?:s|ed|ing)?|howl(?:s|ed|ing)?|shriek(?:s|ed|ing)?|cry(?:ing)? out|call(?:s|ed|ing)? out|call(?:s|ed|ing)? (?:for|to) (?:help|someone|the dog|the kids)|whistl(?:e|es|ed|ing)|sing(?:s|ing)?|sang|serenad(?:e|es|ed|ing)|karaoke|chant(?:s|ed|ing)?|rap(?:s|ped|ping)? (?:a |the )?(?:verse|song|bars)|freestyl(?:e|es|ed|ing) rap|opera|announc(?:e|es|ed|ing)|preach(?:es|ed|ing)?|speech|give(?:s)? a speech|giving a speech|toast(?:s|ed|ing)? (?:the )?(?:bride|groom|couple|crowd)|cheers to|lectur(?:e|es|ed|ing)|scold(?:s|ed|ing)?|argu(?:e|es|ed|ing)|rant(?:s|ed|ing)?|complain(?:s|ed|ing)?|nag(?:s|ged|ging)?|gossip(?:s|ed|ing)?|chat(?:s|ted|ting)? (?:with|to)|talk(?:s|ed|ing)? (?:to|with|at)|explain(?:s|ed|ing)?|negotiat(?:e|es|ed|ing)|debat(?:e|es|ed|ing)|storytell(?:ing|er)|tell(?:s|ing)? a (?:story|joke|tale)", "arm", "osc", 0.9, { dir: "forward", head: true }),
    VC("bit(?:e|es|ing)|chomp(?:s|ed|ing)?|gnaw(?:s|ed|ing)?|lick(?:s|ed|ing)?|kiss(?:es|ed|ing)?|smooch(?:es|ed|ing)?|headbutt(?:s|ed|ing)?|head ?butt|nuzzl(?:e|es|ed|ing)|whisper(?:s|ed|ing)?|blow(?:s|ing)? (?:out )?(?:the )?(?:candles?|a dandelion|bubbles|a whistle|a horn|smoke)|spit(?:s|ting)?|spat", "head", "nod", 1),
    VC("salsa dip|dip(?:s|ped|ping)? (?:his |her |their )?partner|lean(?:s|ed|ing)? (?:in|closer|forward to listen)|lean(?:s|ed|ing)? on (?:a |the )?(?:wall|counter|table|railing|fence|pillar)|rest(?:s|ed|ing)? (?:his |her |their )?(?:elbow|elbows|arm|arms) on|prop(?:s|ped|ping)? (?:himself|herself|themselves) up", "torso", "lean", 0.9),
    VC("hop(?:s|ped|ping)? on one (?:foot|leg)|one[- ]legged hop|pogo|bounce(?:s|d)? (?:up and down|in place|on (?:his |her |their )?toes|excitedly)|bouncing (?:up and down|in place|on (?:his |her |their )?toes|excitedly)|jitterbug|can'?t (?:stand|keep) still|excited bounce|potty dance|need(?:s)? to pee|hold(?:s|ing)? it in", "torso", "bounce", 1, { fast: true }),
    VC("pos(?:e|es|ed|ing) (?:for|like)|strik(?:e|es|ing) a pose|model(?:s|led|ling)? (?:on|for|the)|vogue(?:s|d|ing)?|fashion pose|photo ?shoot|catwalk pose|mannequin|freeze frame|hold(?:s|ing)? (?:a |the |that )?pose|statue|frozen (?:in place|like a statue)|t[- ]pose|a[- ]pose|flex pose|dramatic pose|pin[- ]?up pose|jojo pose|anime pose", "arm", "hold", 1, { dir: "up", bothArms: true }),
    VC("shield(?:s|ed|ing)? (?:his |her |their )?eyes from|hide(?:s)? (?:his |her |their )?face|hiding (?:his |her |their )?face|cover(?:s|ed|ing)? (?:his |her |their )?(?:face|eyes|ears|mouth|nose|head)|plug(?:s|ged|ging)? (?:his |her |their )?(?:ears|nose)|hold(?:s|ing)? (?:his |her |their )?nose|peek(?:s|ed|ing)? through (?:his |her |their )?fingers|hands over (?:his |her |their )?(?:face|eyes|ears|mouth)|bury(?:ing)? (?:his |her |their )?face in (?:his |her |their )?hands|buries (?:his |her |their )?face|rub(?:s|bed|bing)? (?:his |her |their )?(?:eyes|face|neck|belly|stomach|tummy|back of (?:his|her|their) neck)|massag(?:e|es|ed|ing) (?:his |her |their )?(?:neck|temples|shoulder|shoulders|forehead|back)|pat(?:s|ted|ting)? (?:his |her |their )?(?:belly|stomach|tummy|chest|head)", "hands", "hold", 0.9, { dir: "face" }),
  ];
  const PART_POSES = {
    arm: { up: { rs: [165, 0, 20], re: [8, 0, 0] }, forward: { rs: [90, 0, 10], re: [5, 0, 0] }, chest: { rs: [60, -40, 20], re: [120, 0, 0] }, face: { rs: [120, -30, 30], re: [140, 0, 0] }, side: { rs: [10, 0, 90], re: [5, 0, 0] }, default: { rs: [85, -10, 25], re: [40, 0, 0], rw: [-10, 0, 0] } },
    hands: { chest: { rs: [60, -35, 20], re: [115, 0, 0], ls: [60, 35, -20], le: [115, 0, 0] }, face: { rs: [120, -25, 30], re: [135, 0, 0], ls: [120, 25, -30], le: [135, 0, 0], ne: [8, 0, 0] }, up: { rs: [150, -10, 25], re: [30, 0, 0], ls: [150, 10, -25], le: [30, 0, 0] }, default: { rs: [70, -30, 20], re: [110, 0, 0], ls: [70, 30, -20], le: [110, 0, 0], ne: [8, 0, 0] } },
    leg: { default: { rh: [28, 0, 6], rk: [-50, 0, 0], ra: [-10, 0, 0], ro: [0, 0, -3], rp: [0.15, 0, 0], wa: [0, 0, 3] } },
    head: { turn: { ne: [0, 42, 0], wa: [0, 10, 0] }, forward: { ne: [8, 0, 0], wa: [-6, 0, 0] }, nod: { ne: [22, 0, 0] }, default: { ne: [0, 20, 0] } },
    torso: { sway: { wa: [0, 0, 16], ro: [0, 0, 6], ne: [0, 0, -8], rp: [0.3, 0, 0] }, tremble: { wa: [-4, 0, 3], ne: [3, 0, 4], rs: [25, -5, 12], re: [55, 0, 0], ls: [25, 5, -12], le: [55, 0, 0], ro: [0, 0, 1.5] }, slump: { wa: [-32, 0, 0], ne: [26, 0, 0], ro: [-8, 0, 0], rs: [15, 0, 8], ls: [15, 0, -8], rk: [-18, 0, 0], lk: [-18, 0, 0], rp: [0, -0.3, 0] }, arch: { wa: [16, 0, 0], ne: [-14, 0, 0], ro: [6, 0, 0], rs: [-10, 0, 18], ls: [-10, 0, -18] }, lean: { wa: [-14, 0, 10], ro: [-4, 0, 5], ne: [8, 0, -8], rs: [40, -20, 15], re: [95, 0, 0] }, bounce: { lk: [-32, 0, 0], rk: [-32, 0, 0], rp: [0, -0.18, 0], rs: [20, 0, 10], ls: [20, 0, -10], re: [60, 0, 0], le: [60, 0, 0] } },
  };
  // → the same shape posePhrase() returns, so gestureBeats() renders it; sides from the prompt ("left") flip the pose
  function classGesture(text) {
    const t = String(text || ""); const found = [];
    for (const c of VERB_CLASSES) { const m = t.match(c.rx); if (m) found.push({ c, word: m[0].toLowerCase(), at: m.index }); }
    if (!found.length) return null;
    found.sort((a, b) => a.at - b.at);
    const pose = {}; let osc = false, fast = false; const hits = [];
    const left = /\b(left|lefty|left[- ]handed)\b/i.test(t) && !/\bright\b/i.test(t);
    for (const f of found.slice(0, 3)) {
      const c = f.c; const table = PART_POSES[c.part] || PART_POSES.arm;
      let p = table[c.dir] || table[c.pattern] || table.default || {};
      if (c.part === "arm" && c.bothArms) p = both(p);
      if (left && (c.part === "arm" || c.part === "leg")) p = L(p);
      for (const k of Object.keys(p)) { const v = p[k]; pose[k] = k === "rp" ? v.slice() : [v[0] * c.amp, v[1] * c.amp, v[2] * c.amp]; }
      if (c.head && !pose.ne) pose.ne = [6, left ? 10 : -10, 0];
      if (/^(osc|pulse|circle|sway|tremble|bounce|nod|turn)$/.test(c.pattern)) osc = true;
      if (c.fast) fast = true;
      hits.push(f.word + " (" + c.part + " " + c.pattern + ")");
    }
    if (!Object.keys(pose).length) return null;
    return { pose, oscillate: osc, hits, synth: true, fast, reps: fast ? 5 : 3 };
  }
  // vocabulary size for the studio + prompt composer for "Inspire me"
  function vocabulary() {
    const acts = Object.keys(ACTS).filter((k) => !MOODS[k]).length, moods = Object.keys(MOODS).length;
    const categories = Object.keys(RE).filter((k) => !/^(anime|realistic|cartoony|heavy|fluid|robotic|zombie|cute|ninja|fast|slow|extreme|loop|noloop|upper|facial|twohand|both|small|big|side|mirror|travel|left|combo|anticipation|recover)$/.test(k)).length;
    const top = (src) => { let d = 0, n = 1; for (const ch of src) { if (ch === "(") d++; else if (ch === ")") d--; else if (ch === "|" && d === 0) n++; } return n; };
    const synonyms = THESAURUS.reduce((n, [rx]) => n + top(rx.source.replace(/^\\b\(\?:|\)\\b$/g, "")), 0), verbClasses = VERB_CLASSES.reduce((n, c) => n + top(c.words), 0);
    return { acts, categories, moods, synonyms, verbClasses, styles: 9, speeds: 7, parts: 8, directions: 8, composition: ["then-chains", "while-layers", "repeats", "sides", "moods", "speeds", "styles", "takes"] };
  }
  const INSPIRE = {
    acts: ["drink a potion", "open a heavy door", "play guitar", "dig a hole", "chop wood", "sweep the floor", "wave at the crowd", "salute", "bow", "clap", "stretch", "shiver", "juggle", "stir a cauldron", "read a book", "knock on the door", "take a selfie", "flex", "pray", "pet a dog", "look around", "think hard", "high five", "fist pump", "dab", "cast a fireball", "block with a shield", "throw a spear", "draw a bow", "swing a greatsword", "two punch combo", "roundhouse kick", "dodge roll", "backflip", "sit on a bench", "crouch", "climb a ladder", "swim", "sneak", "crawl"],
    cycles: ["idle", "walk", "run", "sneak walk", "march", "jog", "walk backwards", "strafe", "crawl", "swim", "climb", "fly"],
    moods: ["tired", "proud", "drunk", "scared", "angry", "happy", "sad", "old", "injured", "cold", "energetic", "nervous", "sneaky"],
    styles: ["anime", "realistic", "cartoony", "heavy", "fluid", "robotic", "cute", "ninja"],
    speeds: ["slowly", "fast", "in slow motion", "quickly", "at half speed"],
    parts: ["raise the left arm", "turn head right", "lean back", "kick the right leg forward", "lift both arms", "shake the right fist", "nod", "twist the torso", "tilt head left", "spread both arms"],
  };
  function inspire(seed) {
    const r = rng(hashStr("inspire:" + (seed == null ? Date.now() : seed)) || 1); const pick = (a) => a[Math.floor(r() * a.length)];
    const form = Math.floor(r() * 9);
    switch (form) {
      case 0: return `${pick(INSPIRE.moods)} ${pick(INSPIRE.cycles)}`;
      case 1: return `${pick(INSPIRE.acts)} then ${pick(INSPIRE.acts)}`;
      case 2: return `${pick(INSPIRE.acts)} while walking`;
      case 3: return `${pick(INSPIRE.styles)} ${pick(INSPIRE.acts)}`;
      case 4: return `${pick(INSPIRE.acts)} ${pick(INSPIRE.speeds)}`;
      case 5: return `${pick(INSPIRE.parts)} then ${pick(INSPIRE.parts)}`;
      case 6: return `${pick(INSPIRE.moods)} ${pick(INSPIRE.acts)} ${pick(["twice", "three times", "x4"])}`;
      case 7: return `${pick(INSPIRE.acts)} then ${pick(INSPIRE.acts)} then ${pick(INSPIRE.acts)}`;
      default: return `${pick(INSPIRE.moods)} ${pick(INSPIRE.styles)} ${pick(INSPIRE.cycles)}, ${pick(INSPIRE.speeds)}`;
    }
  }
  const IMPROV_POOL = ["lookaround", "think", "scratch", "shade", "stretch", "watch", "wipe", "nervous", "heropose", "flex", "thumbsup", "shiver"];
  function improvise(seed, count) { const r = rng(seed || 1); const pool = IMPROV_POOL.slice(); const out = []; while (out.length < count && pool.length) out.push(ACTS[pool.splice(Math.floor(r() * pool.length), 1)[0]]); return out; }
  // several clips in a row with a short blend between them (A then B then C)
  // 1.58 fluent joins: the blend between two chained parts is the fastest motion in a chained clip when it is a fixed
  // 0.25 s - a wave ending overhead into a kick stance snaps. The join now takes as long as the pose distance needs at a
  // calm angular rate (JOIN_RATE deg/s, "fluent" feedback lowers it, "snappy transitions" raises it) and eases in-out.
  const JOIN_RATE = { snappy: 280, normal: 160, soft: 110 }; // average deg/s over the blend; CubicV2 InOut peaks at 3× the average mid-blend
  function poseGap(a, b) { let m = 0; for (const j of Object.keys(b || {})) { if (j === "root" || !a || !a[j] || !b[j] || !b[j].rot) continue; const d = Math.hypot(b[j].rot[0] - a[j].rot[0], b[j].rot[1] - a[j].rot[1], b[j].rot[2] - a[j].rot[2]); if (d > m) m = d; } return m; }
  function concatClips(clips, opts) {
    opts = opts || {}; const minGap = opts.gap == null ? 0.25 : opts.gap; const rate = JOIN_RATE[opts.join] || JOIN_RATE.normal; const speed = opts.speed > 0 ? opts.speed : 1;
    const fps = clips[0].fps; let t0 = 0; const keys = [], stages = [], joins = [];
    clips.forEach((c, i) => {
      const off = t0;
      // a segment takes the ease of the key that STARTS it, so the last key of every part but the last eases in-out: the blend accelerates out of the old pose and settles into the new one
      c.keys.forEach((k, ki) => keys.push(Object.assign({}, k, { t: r3(off + k.t), poses: clonePose(k.poses), ease: i < clips.length - 1 && ki === c.keys.length - 1 ? ["CubicV2", "InOut"] : k.ease, stage: (i + 1) + "." + (k.stage || c.intent && c.intent.category || "clip") })));
      for (const s of c.stages || []) stages.push(Object.assign({}, s, { name: (i + 1) + "." + s.name, t0: r3(off + s.t0), t1: r3(off + s.t1) }));
      let gap = 0;
      if (i < clips.length - 1) { const deg = poseGap(c.keys[c.keys.length - 1].poses, clips[i + 1].keys[0].poses); gap = r3(Math.max(minGap, Math.min(0.9, deg / rate)) / speed); gap = Math.max(1 / fps, Math.round(gap * fps) / fps); joins.push({ at: r3(Math.round((off + c.duration) * fps) / fps), gap, deg: Math.round(deg) }); }
      t0 = r3(off + c.duration + gap);
    });
    const first = clips[0];
    const clip = Object.assign({}, first, { name: opts.name || clips.map((c) => c.name).join("_then_").slice(0, 60), prompt: opts.prompt || clips.map((c) => c.prompt).join(", then "), duration: r3(t0), loop: !!opts.loop, keys: snapToFps(dedupeKeys(keys), fps, r3(t0)), stages, joins, edited: false, fixes: [], feedback: [], layered: null, baked: false,
      intent: Object.assign({}, first.intent, { text: opts.prompt || first.intent.text, category: "sequence", clauses: clips.map((c) => c.prompt), stages: [], duration: r3(t0), mood: opts.mood || null }), limitations: Array.from(new Set(clips.flatMap((c) => c.limitations || []))), parts: clips.map((c) => ({ name: c.name, duration: c.duration, category: c.intent && c.intent.category })) });
    if (clip.loop) clip.keys = closeLoop(clip.keys, clip.duration, false);
    clip.report = validate(clip); clip.fingerprint = fingerprint(clip); return clip;
  }

  // ───────────────────────── sequencer ─────────────────────────
  const STAGE_WEIGHT = { ready: 0.4, anticipation: 0.7, strike: 1.0, transition: 0.4, spin: 1.7, finisher: 1.3, air: 1.1, land: 1.25, recover: 0.8, dodge: 1.2, block: 1.2, cast: 1.5, hit: 0.9, fall: 1.4, still: 1.2, draw: 1.6, release: 0.9, aimup: 0.6, shot: 0.55, throw: 1.1, flip: 1.6, dash: 1.1, slide: 1.6, pickup: 1.5 };
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
    const w = stageWeights(stages, params);
    const sum = w.reduce((a, b) => a + b, 0);
    return w.map((v) => total * v / sum); // distribute the (already speed-scaled) total exactly - stages always end at `duration`
  }
  function generate(intentOrText, opts) {
    if (typeof intentOrText === "string" && !intentOrText.trim()) throw new Error("describe the motion first (empty prompt)");
    if (intentOrText == null || (typeof intentOrText !== "string" && typeof intentOrText !== "object")) throw new Error("generate() needs a prompt string or a parsed intent");
    opts = opts || {};
    // 1.55: "A then B then C" → every clause is generated on its own (any category) and the clips are chained
    const seqText = typeof intentOrText === "string" ? intentOrText : intentOrText && intentOrText.category === "sequence" && intentOrText.text;
    if (seqText && !opts._clause) {
      const clauses = splitClauses(seqText);
      if (clauses.length > 1) {
        const mood = opts.mood !== undefined ? opts.mood : (intentOrText && intentOrText.mood) || null;
        const sub = Object.assign({}, opts, { _clause: true, duration: undefined, name: undefined, loop: false, avoid: undefined, mood });
        const parts = clauses.map((c) => generate(c, sub));
        const dm = seqText.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/i);
        let clip = concatClips(parts, { name: opts.name, prompt: seqText, mood, loop: typeof opts.loop === "boolean" ? opts.loop : RE.loop.test(seqText) && !RE.noloop.test(seqText), speed: opts.params && opts.params.speed || 1, join: opts.params && opts.params.join });
        let want = dm ? clamp(parseFloat(dm[1]), 0.2, 60) : opts.duration || 0;
        // 1.58: a duration the MODEL invented (softDuration) may lengthen a chain freely but never rushes it below 75% of its natural length - "in 2 seconds" in the prompt still pins it
        if (want && !dm && opts.softDuration && want < clip.duration * 0.75) { const kept = r3(Math.round(clip.duration * 0.75 * clip.fps) / clip.fps); clip.limitations = (clip.limitations || []).concat([`tempo kept: ${want}s was asked but the ${parts.length} parts need ${clip.duration}s to read - trimmed to ${kept}s instead of rushing them (put "in ${want}s" in the prompt to force it)`]); want = kept; }
        if (want && Math.abs(want - clip.duration) > 1e-3) clip = retime(clip, want);
        clip.quality = parts[0].quality; clip.params = parts[0].params; clip.take = parts[0].take || 0; clip.persona = parts[0].persona;
        if (Array.isArray(opts.avoid) && opts.avoid.length && (opts._depth || 0) < 8 && opts.avoid.some((f) => typeof f === "string" ? f === clip.fingerprint : f && f.keys && similarity(f, clip) > 0.985)) return generate(seqText, Object.assign({}, opts, { take: (opts.take || 0) + 1, _depth: (opts._depth || 0) + 1 }));
        return clip;
      }
    }
    const intent = typeof intentOrText === "string" ? parseIntent(intentOrText) : JSON.parse(JSON.stringify(intentOrText));
    if (opts.mood !== undefined && typeof intentOrText === "string") intent.mood = opts.mood && MOODS[opts.mood] ? opts.mood : intent.mood && opts.mood === null ? null : intent.mood;
    // 1.55: "wave while walking" → legs + root from the cycle, upper body from the act / emote
    if (intent.layerOn && !opts._noLayer) {
      const sub = Object.assign({}, opts, { _noLayer: true, _clause: true, name: undefined, loop: true, avoid: undefined, duration: undefined });
      const base = generate(Object.assign({}, intent, { layerOn: null, upperText: null, category: intent.layerOn, text: intent.layerOn + " cycle", acts: [], gesture: null, mood: null, stages: [] }), Object.assign({}, sub, { duration: opts.duration }));
      const upper = generate(intent.upperText, sub);
      const out = layer(base, upper, { fit: "auto", weight: 1, name: opts.name || suggestName(intent) }); // 1.58: the act keeps its tempo, the cycle is tiled under it
      out.prompt = intent.text; out.intent = Object.assign({}, intent, { stages: [] }); out.limitations = Array.from(new Set([...(base.limitations || []), ...(upper.limitations || [])]));
      if (intent.mood) { out.keys = applyMood(out.keys, MOODS[intent.mood], out.duration, 1); out.report = validate(out); out.fingerprint = fingerprint(out); }
      return out;
    }
    const quality = QUALITY[opts.quality || intent.quality || "balanced"] ? (opts.quality || intent.quality || "balanced") : "balanced";
    const q = QUALITY[quality];
    const params = Object.assign({}, DEFAULT_PARAMS, opts.params || {});
    const rigType = String(opts.rigType || intent.rigHint || "R15").toUpperCase() === "R6" ? "R6" : "R15";
    let askDur = opts.duration || 0, tempoNote = null;
    if (askDur && opts.softDuration && !intent.durationExplicit && askDur < intent.duration * 0.75) { tempoNote = `tempo kept: ${askDur}s was asked but "${String(intent.text || intent.category).slice(0, 48)}" needs about ${r3(intent.duration)}s to read - made it ${r3(intent.duration * 0.75)}s instead of rushing it (put "in ${askDur}s" in the prompt to force it)`; askDur = intent.duration * 0.75; }
    let duration = r3(clamp((askDur || intent.duration) / params.speed, 0.2, 60));
    if (intent.stages && intent.stages.length) { const w = stageWeights(intent.stages, params).reduce((a, b) => a + b, 0), w0 = stageWeights(intent.stages, DEFAULT_PARAMS).reduce((a, b) => a + b, 0); duration = r3(clamp(duration * w / w0, 0.2, 60)); }
    const k = clamp(intent.intensity * params.amplitude, 0.4, 1.8);
    const fps = clamp(Math.round(opts.fps || q.fps), 10, 120);
    duration = r3(Math.max(2 / fps, Math.round(duration * fps) / fps));
    const loop = typeof opts.loop === "boolean" ? opts.loop : !!intent.loop;
    const style = intent.style;
    let keys = [], stages = [];
    const take = (opts.take || intent.take || 0) | 0;
    const seed = (intent.seed ^ Math.round(params.variation * 1000) ^ Math.imul(take, 2246822519)) >>> 0;
    const P = persona(Number.isFinite(opts.personaSeed) ? Object.assign({}, intent, { seed: opts.personaSeed >>> 0 }) : intent, params, take); P.text = intent.text; P.strafeDir = intent.strafeDir; PERSONA = P;
    const kP = clamp(k * P.amp, 0.4, 1.8);
    const jitter = params.variation || take ? rng(seed) : null;
    const vj = (v, pct) => jitter ? v * (1 + (jitter() * 2 - 1) * pct) : v;
    const travel = !!(intent.travel || params.travel || opts.travel);
    if (intent.stages && intent.stages.length) {
      let durs = stageDurations(intent.stages, duration, params);
      // persona tempo: anticipation / windup stages stretch or tighten a little per character; variation jitters all of them; stages still end exactly at `duration`
      durs = durs.map((d, i) => { const kind = intent.stages[i].kind; return d * (kind === "anticipation" || kind === "ready" || kind === "draw" ? P.tempo : kind === "recover" ? (2 - P.tempo) : 1); });
      if (jitter) durs = durs.map((d) => vj(d, 0.08));
      { const sum = durs.reduce((a, b) => a + b, 0); durs = durs.map((d) => d * duration / sum); }
      let t0 = 0, prev = stance(k, style), yawOffset = 0, pitchOffset = 0;
      const weapon = intent.weapon || "punch", hands = intent.hands || 1;
      intent.stages.forEach((s, idx) => {
        const d = durs[idx];
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
        else if (s.kind === "hit") beats = hitBeats(s.variant || intent.hitDir || "front", kP, prev, intent.category === "knockback" || intent.category === "death");
        else if (s.kind === "fall") beats = fallBeats(intent.deathDir || "back", kP, prev);
        else if (s.kind === "still") beats = stillBeats(prev);
        else if (s.kind === "draw") beats = drawBeats(kP, prev);
        else if (s.kind === "release") beats = releaseBeats(kP, prev);
        else if (s.kind === "aimup") beats = [{ at: 1, tag: "ready", ease: ["CubicV2", "Out"], pose: aimPose(k, stance(k, style), /rifle|shotgun|blaster|two[- ]hand/i.test(intent.text)) }];
        else if (s.kind === "shot") beats = shotBeats(kP, prev, /rifle|shotgun|blaster|two[- ]hand/i.test(intent.text));
        else if (s.kind === "throw") beats = throwBeats(kP, prev);
        else if (s.kind === "flip") beats = flipBeats(intent.flipDir || "back", kP, prev);
        else if (s.kind === "dash") beats = dashBeats(kP, prev, travel);
        else if (s.kind === "slide") beats = slideBeats(kP, prev, travel);
        else if (s.kind === "pickup") beats = pickupBeats(kP, prev);
        else if (s.kind === "recover") { const end = intent.category === "attack" ? readyPose(k * 0.9, style, weapon, hands) : stance(k, style); const keepZ = travel && prev.root && prev.root.pos ? prev.root.pos[2] : 0; const endP = keepZ ? withOverrides(end, { root: { rot: end.root.rot, pos: [end.root.pos[0], end.root.pos[1], keepZ] } }) : end; beats = [{ at: 0.55, tag: "settle", ease: ["CubicV2", "InOut"], pose: mix(prev, endP, 0.6) }, { at: 1, tag: "end", ease: ["CubicV2", "Out"], pose: endP }]; }
        for (const b of beats) b.ease = flavorEase(b.ease, b.tag, P.easing);
        const lastLocal = beats.length ? clonePose(beats[beats.length - 1].pose) : null; // before the offset is baked in - the next stage builds on the LOCAL frame
        if (yawOffset || pitchOffset) for (const b of beats) { const rp = b.pose.root || { rot: [0, 0, 0] }; b.pose.root = Object.assign({}, rp, { rot: [rp.rot[0] + pitchOffset, rp.rot[1] + yawOffset, rp.rot[2]] }); }
        const stageKeys = beats.map((b) => ({ t: r3(t0 + b.at * d), poses: b.pose, ease: b.ease, tag: b.tag, stage: s.kind + (s.index != null ? "_" + (s.index + 1) : "") }));
        let turned = 0;
        if (s.kind === "spin") turned += 360 * (intent.text && /double spin|two spins|720/i.test(intent.text) ? 2 : 1);
        if (beats.spinTurn) turned += beats.spinTurn; // spin kick: the next stage starts one full turn later
        yawOffset += turned;
        let pitched = 0; if (beats.spinX) { pitched = beats.spinX; pitchOffset += pitched; }
        stages.push({ name: s.kind + (s.index != null ? "_" + (s.index + 1) : "") + (s.variant ? ":" + s.variant : ""), kind: s.kind, t0: r3(t0), t1: r3(t0 + d), marker: s.kind === "strike" || s.kind === "finisher" || s.kind === "spin" ? "hit" : s.kind === "land" ? "land" : s.kind });
        keys.push(...stageKeys);
        if (lastLocal) prev = lastLocal;
        // `prev` lives in the next stage's local frame: after a full turn the local yaw drops by what the offset gained (otherwise a recover that mixes prev with the ready pose wobbles 140° back).
        if ((turned || pitched) && prev.root) prev = withOverrides(prev, { root: { rot: [prev.root.rot[0] - pitched, prev.root.rot[1] - turned, prev.root.rot[2]], pos: prev.root.pos } });
        t0 += d;
      });
    } else if (/^(walk|run|swim|climb|sneak|strafe|walk_back|crawl|pushup)$/.test(intent.category)) {
      keys = cycleKeys(intent.category, kP, style, duration, q); stages = [{ name: intent.category + "_cycle", kind: "cycle", t0: 0, t1: duration, marker: "cycle" }];
      if (travel && /^(walk|run|sneak|walk_back|crawl)$/.test(intent.category)) { const stride = (intent.category === "run" ? 6.5 : intent.category === "crawl" ? 1.6 : intent.category === "sneak" ? 2.2 : 3.6) * kP * (intent.category === "walk_back" ? -1 : 1); for (const key of keys) { const rp = key.poses.root.pos || [0, 0, 0]; key.poses.root.pos = [rp[0], rp[1], rp[2] + stride * key.t / duration]; } }
    } else if (intent.category === "act" || intent.category === "improv" || intent.category === "gesture") {
      const acts = intent.category === "gesture" ? [{ name: "gesture", loop: !!intent.loop, d: 1, b: (kk, n) => gestureBeats(intent.gesture, kk, n) }] : (intent.category === "act" ? intent.acts : intent.improv).map((n) => ACTS[n]).filter(Boolean);
      const total = acts.reduce((sum, a) => sum + a.d, 0) || 1; let t0 = 0;
      acts.forEach((a, i) => {
        const d = r3(duration * a.d / total); const reps = intent.repeat && acts.length === 1 ? intent.repeat : null;
        let ks;
        if (reps && a.loop && reps > 1) { ks = []; const dd = d / reps; for (let rI = 0; rI < reps; rI++) { const cyc = actKeys(a, kP, style, dd, null); for (const key of cyc) { if (rI > 0 && key.t === 0) continue; key.t = r3(rI * dd + key.t); if (key.tag === "loop_end") key.tag = rI === reps - 1 ? "end" : "beat"; ks.push(key); } } }
        else ks = actKeys(a, kP, style, d, reps); for (const key of ks) { key.t = r3(t0 + key.t); key.ease = flavorEase(key.ease, key.tag, P.easing); if (jitter) for (const j of Object.keys(key.poses)) if (j !== "root") key.poses[j] = J(vj(key.poses[j].rot[0], 0.06), vj(key.poses[j].rot[1], 0.06), vj(key.poses[j].rot[2], 0.06)); }
        keys.push(...ks); stages.push({ name: a.name + (acts.length > 1 ? "_" + (i + 1) : ""), kind: intent.category, t0: r3(t0), t1: r3(t0 + d), marker: a.name }); t0 += d;
      });
    } else if (intent.category === "emote" && intent.action) {
      keys = emoteKeys(intent.action, kP, style, duration, q); stages = [{ name: intent.action + (P.emoteVariant ? "_v" + (P.emoteVariant + 1) : ""), kind: "emote", t0: 0, t1: duration, marker: intent.action }];
      for (const key of keys) key.ease = flavorEase(key.ease, key.tag, P.easing);
    } else {
      keys = idleKeys(intent.category, kP, style, duration, q, seed); stages = [{ name: intent.category, kind: "idle", t0: 0, t1: duration, marker: intent.category }];
    }
    if (intent.mood && MOODS[intent.mood]) keys = applyMood(keys, MOODS[intent.mood], duration, kP);
    // merge keys at identical times (later wins), sort
    keys = dedupeKeys(keys);
    // principles
    if (q.holdFrames) keys = addImpactHolds(keys, fps, q.holdFrames, duration);
    if (q.followThrough) keys = addFollowThrough(keys, fps, k, duration);
    if (q.arcs) keys = addArcs(keys, duration, fps);
    if (q.secondary) keys = addSecondaryLag(keys, k);
    if (intent.upperOnly) for (const key of keys) for (const j of ["l_hip", "l_knee", "l_ankle", "r_hip", "r_knee", "r_ankle"]) key.poses[j] = J(0, 0, 0);
    const mirrored = !!(intent.mirror || opts.mirror);
    if (mirrored) keys = keys.map((key) => Object.assign({}, key, { poses: mirrorPose(key.poses) }));
    if (loop) keys = closeLoop(keys, duration, travel);
    keys = snapToFps(dedupeKeys(keys), fps, duration);
    let clip = {
      version: 1, engine: VERSION, name: opts.name || suggestName(intent) + (take ? "_take" + (take + 1) : "") + (mirrored ? "_Mirror" : ""), prompt: intent.rawText || intent.text, intent, params, quality, rigType, fps, duration, loop, priority: opts.priority || intent.priority,
      stages, keys, created: opts.now || 0, edited: false, limitations: intent.unsupported.slice(), take, personaSeed: Number.isFinite(opts.personaSeed) ? opts.personaSeed >>> 0 : intent.seed, interp: opts.interp === "spline" || opts.interp === "eased" ? opts.interp : (q.spline && opts.smooth !== false && params.smooth !== false ? "spline" : "eased"), persona: { traits: P.traits, lead: P.lead, fidget: P.fidget, armRest: P.armRest, easing: P.easing, emoteVariant: P.emoteVariant }, mirrored, travel,
    };
    if (tempoNote) clip.limitations.push(tempoNote);
    if (travel) clip.limitations.push("root motion: the HumanoidRootPart offset travels inside the clip - play it on a rig that is NOT also being moved by a controller, or strip the root track.");
    if (rigType === "R6") clip.limitations.push("R6 rig: no elbow / knee / wrist / ankle / waist joints - elbow and knee bends are folded into the shoulders and hips, waist into the torso.");
    for (let pass = 0; pass < q.passes; pass++) { const r = refine(clip); clip = r.clip; if (!r.changed) break; }
    // 1.54.0 polish: planted feet on grounded clips, spline smoothing on the high presets (both skippable per call)
    if (q.ground && opts.ground !== false && params.ground !== false) { const g = groundFeet(clip); if (g.grounded) clip = g; }
    if (q.spline && opts.smooth !== false && params.smooth !== false) clip = smooth(clip, { strength: q.spline });
    clip.report = validate(clip);
    clip.fingerprint = fingerprint(clip);
    PERSONA = null;
    // uniqueness: never hand back a clip that looks like one the caller already has (session clips / earlier takes)
    if (Array.isArray(opts.avoid) && opts.avoid.length && (opts._depth || 0) < 8) {
      const same = opts.avoid.some((f) => typeof f === "string" ? f === clip.fingerprint : f && f.keys && similarity(f, clip) > 0.985);
      if (same) return generate(intent, Object.assign({}, opts, { take: take + 1, _depth: (opts._depth || 0) + 1 }));
    }
    return clip;
  }
  function suggestName(i) {
    const s = i.style !== "default" ? i.style[0].toUpperCase() + i.style.slice(1) : "";
    const cap = (w) => w ? w[0].toUpperCase() + w.slice(1) : "";
    const core = i.category === "act" ? i.acts.map(cap).join("") : i.category === "improv" ? "Improv" + i.improv.map(cap).join("") : i.category === "gesture" ? "Gesture" + (i.gesture && i.gesture.hits[0] ? i.gesture.hits[0].split(" ").map(cap).join("") : "") : i.layerOn ? cap(i.layerOn) + "With" + cap(suggestName(parseIntent(i.upperText || ""))) : i.category === "attack" ? (i.weapon === "sword" ? "SwordCombo" : i.weapon === "kick" ? "KickCombo" : "PunchCombo") : i.category === "emote" ? (i.action || "Emote")[0].toUpperCase() + (i.action || "emote").slice(1) : i.category.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("") + (i.category === "hit_react" && i.hitDir ? i.hitDir[0].toUpperCase() + i.hitDir.slice(1) : "") + (i.category === "death" && i.deathDir === "forward" ? "Forward" : "") + (i.category === "flip" ? (i.flipDir === "front" ? "Front" : "Back") : "");
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
  function addArcs(keys, duration, fps) {
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      out.push(keys[i]);
      const a = keys[i], b = keys[i + 1];
      if (!b || a.tag !== "windup" || b.tag !== "impact" || b.t - a.t < 3 / (fps || 30)) continue; // no breakdown inside a 2-frame gap (it would spike the velocity check)
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
  function closeLoop(keys, duration, travel) {
    if (!keys.length) return keys;
    const first = keys[0];
    const last = keys[keys.length - 1];
    const p = clonePose(first.poses);
    if (travel && last.poses.root && last.poses.root.pos && p.root) p.root.pos = [p.root.pos[0], p.root.pos[1], last.poses.root.pos[2]]; // root-motion clips keep the forward offset at the seam (the controller re-bases it)
    if (Math.abs(last.t - duration) < 1e-6) { last.poses = p; last.tag = "loop_end"; return keys; }
    keys.push({ t: duration, poses: p, ease: first.ease, tag: "loop_end", synthetic: true });
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
        if (j === "root" && p.pos && (Math.abs(p.pos[1]) > 2.2 || Math.abs(p.pos[0]) > 3 || Math.abs(p.pos[2]) > (clip.travel ? 12 : 3))) add("warn", "root", `root offset ${p.pos.map((v) => v.toFixed(2)).join(",")} studs at ${key.t}s is very large`, { t: key.t, joint: j });
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
        if (j === "root" && (pa.pos || pb.pos)) { const A = pa.pos || [0, 0, 0], B = pb.pos || [0, 0, 0]; const dist = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]); if (dist / dt > (impact || clip.travel ? SPEED_LIMIT.root_pos_impact : SPEED_LIMIT.root_pos)) add("warn", "root_speed", `root moves ${dist.toFixed(2)} studs in ${dt.toFixed(3)}s at ${b.t}s`, { t: b.t, joint: j }); }
      }
    }
    // loop seam
    if (clip.loop && keys.length >= 2) {
      const a = keys[0], b = keys[keys.length - 1];
      let worst = 0, wj = null;
      for (const j of JOINTS) { const pa = a.poses[j], pb = b.poses[j]; if (!pa || !pb) continue; const d = Math.max(...[0, 1, 2].map((i) => Math.abs(pa.rot[i] - pb.rot[i]))); if (d > worst) { worst = d; wj = j; } }
      if (worst > 2) add(worst > 15 ? "error" : "warn", "loop", `loop seam: ${wj} differs by ${Math.round(worst)}° between the last and first keyframe${worst > 15 ? " (visible pop)" : ""}`, { joint: wj, delta: worst });
      if (clip.travel && a.poses.root && b.poses.root && a.poses.root.pos && b.poses.root.pos) add("info", "loop", `root motion clip: the root travels ${r3((b.poses.root.pos[2] || 0) - (a.poses.root.pos[2] || 0))} studs per loop (expected for travel clips)`);
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
    const sm = errors === 0 && keys.length >= 2 ? smoothness(clip) : { smoothness: 0, roughness: 0 };
    return { ok: errors === 0, score, errors, warnings: warns, issues, keys: keys.length, duration: clip.duration, fps: clip.fps, loop: !!clip.loop, rigType: clip.rigType, stages: (clip.stages || []).map((s) => s.name), limitations: clip.limitations || [], smoothness: sm.smoothness, roughness: sm.roughness, roughestJoint: sm.peakJoint || null };
  }
  // Fix what can be fixed objectively: clamp limits, bridge discontinuities with breakdowns, close loops, sort/dedupe.
  function refine(clipIn) {
    const clip = JSON.parse(JSON.stringify(clipIn));
    const fixes = [];
    clip.keys = dedupeKeys(clip.keys.filter((k) => Number.isFinite(k.t) && k.t >= 0 && k.t <= clip.duration + 1e-6).map((k) => Object.assign({}, k, { t: clamp(k.t, 0, clip.duration) })));
    let clamped = 0;
    for (const key of clip.keys) for (const j of JOINTS) { const p = key.poses[j]; if (!p || !p.rot) continue; const L = LIMITS[j]; ["x", "y", "z"].forEach((ax, i) => { const v = clamp(p.rot[i], L[ax][0], L[ax][1]); if (v !== p.rot[i]) { p.rot[i] = v; clamped++; } }); if (p.pos) { const zMax = clip.travel && j === "root" ? 12 : 3; p.pos = p.pos.map((v, i) => clamp(v, i === 1 ? -2.2 : i === 2 ? -zMax : -3, i === 1 ? 2.2 : i === 2 ? zMax : 3)); } }
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
    if (clip.loop) { const before = JSON.stringify(clip.keys[clip.keys.length - 1].poses), nBefore = clip.keys.length; clip.keys = closeLoop(clip.keys, clip.duration, clip.travel); if (JSON.stringify(clip.keys[clip.keys.length - 1].poses) !== before || clip.keys.length !== nBefore) fixes.push("closed the loop (last keyframe = first pose at the clip end)"); }
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
    // 1.58 tempo words: "make it slow / fast", "too fast", "a bit slower", "much faster", "half speed", "2x", "30% slower", "slow motion"…
    const mag = (() => {
      const pm = f.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/); if (pm) return clamp(1 + parseFloat(pm[1]) / 100, 1.05, 4);
      const xm = f.match(/(?:^|[\s(])(\d+(?:\.\d+)?)\s*[x×]\b|\b[x×]\s*(\d+(?:\.\d+)?)\b|(\d+(?:\.\d+)?)\s*times (?:as )?(?:fast|slow|quick)/); if (xm) { const v = parseFloat(xm[1] || xm[2] || xm[3]); if (v > 0 && v !== 1) return clamp(v >= 1 ? v : 1 / v, 1.05, 4); }
      if (has(/\b(half speed|half as fast|half the speed|slow[- ]?mo(?:tion)?|slo[- ]mo|twice as slow|double speed|double the speed|twice as fast|twice the speed)\b/)) return 2;
      if (has(/\b(very|much|way|a lot|lots|really|far|extremely|super|drastically|significantly|considerably|massively)\b/)) return 1.6;
      if (has(/\b(a bit|slightly|a little|a tad|a touch|little bit|somewhat|marginally|a notch)\b/)) return 1.12;
      return 1.25;
    })();
    const pct = (m) => m >= 2 ? r3(m) + "×" : Math.round((m - 1) * 100) + "%";
    const slowRx = /\b(slower|slow(?:er)? (?:it |this |things |everything |the whole thing |them )?down|too fast|too quick|too rushed|too hectic|too snappy|too hurried|rushed|hectic|hurried|frantic|more slowly|slowly|slow[- ]?mo(?:tion)?|slo[- ]mo|leisurely|unhurried|not so fast|not that fast|less fast|less quick|half speed|half as fast|half the speed|twice as slow|take (?:its|your|his|her|their) time|calmer pace|relaxed pace|ease (?:up|off)(?: on)? the pace|lower (?:the )?tempo)\b|\b(?:make|be|go|it|more|bit|little|very|much|way|really|so|quite|rather|pretty|lot|them|everything)\s+(?:it\s+)?slow\b|\bslow\s*(?:$|[.!,;)])/;
    const fastRx = /\b(faster|quicker|speed (?:it |this |things |everything |the whole thing |them )?up|snappier|too slow|too sluggish|too lazy|too leisurely|not fast enough|not quick enough|more quickly|quickly|rapid(?:ly)?|hurry(?: up)?|hasty|brisk(?:er)?|double speed|double the speed|twice as fast|twice the speed|pick up the pace|more pace|more tempo|higher tempo|up[- ]tempo|zippier)\b|\b(?:make|be|go|it|more|bit|little|very|much|way|really|so|quite|rather|pretty|lot|them|everything)\s+(?:it\s+)?(?:fast|quick)\b|\b(?:fast|quick)\s*(?:$|[.!,;)])/;
    const attackWord = /\b(attacks?|strikes?|hits?|slash(?:es)?|punch(?:es)?|kicks?|swings?|combo)\b/;
    const joinRx = /\b(?:(?:snappier|faster|quicker|shorter|harder|sharper|tighter|crisper) (?:transitions?|blends?|joins?|cuts?|blending)|(?:transitions?|blends?|joins?|cuts?|blending) (?:snappier|faster|quicker|shorter|harder|sharper|tighter|crisper))\b/;
    const joinSnappy = joinRx.test(f), fTempo = f.replace(joinRx, " ");
    const sm = slowRx.exec(fTempo), fm = fastRx.exec(fTempo);
    const slowFirst = sm && (!fm || sm.index <= fm.index), fastFirst = fm && (!sm || fm.index < sm.index);
    if (fastFirst && attackWord.test(f) && !/\b(overall|everything|whole|all of it)\b/.test(f)) { p.attackSpeed = r3(p.attackSpeed * Math.max(mag, 1.35)); notes.push("attacks " + pct(Math.max(mag, 1.35)) + " faster"); }
    else if (fastFirst) { p.speed = r3(p.speed * mag); notes.push("overall " + pct(mag) + " faster"); }
    if (slowFirst && attackWord.test(f) && !/\b(overall|everything|whole|all of it)\b/.test(f)) { p.attackSpeed = r3(p.attackSpeed / mag); notes.push("attacks " + pct(mag) + " slower"); }
    else if (slowFirst) { p.speed = r3(p.speed / mag); notes.push("overall " + pct(mag) + " slower" + (mag === 2 ? " (half speed)" : "")); }
    // transitions between chained parts: "fluent / smoother transitions" blend longer, "snappier transitions" cut quicker
    const fluent = has(/\b(fluent(?:ly)?|fluid(?:ly)?|flowing|flow (?:better|more|nicer)|smooth(?:er|ly)?|silky|butter(?:y)?|graceful(?:ly)?|seamless(?:ly)?|less jerky|less choppy|less robotic|less stiff|less abrupt|more natural|blends? better|smoother transitions?|better transitions?|softer transitions?|longer transitions?|organic)\b/);
    if (joinSnappy) { p.join = "snappy"; notes.push("snappy transitions"); }
    else if (fluent) { p.join = "soft"; if (!(sm && !fastFirst)) notes.push("fluent transitions"); }
    if (has(/anticipation|wind ?up|telegraph/)) { const up = !less; p.anticipation = r3(clamp(p.anticipation * (up ? 1.45 : 0.7), 0.3, 3)); notes.push((up ? "more" : "less") + " anticipation"); }
    if (has(/landing|land|impact|heav(?:y|ier)|weight/)) { const up = !has(/lighter|less heavy|softer/); p.weight = r3(clamp(p.weight * (up ? 1.4 : 0.7), 0.4, 2.5)); notes.push((up ? "heavier" : "lighter") + " landing / weight"); }
    if (has(/exaggerat|bigger|more dramatic|over the top|wilder/)) { p.amplitude = r3(clamp(p.amplitude * 1.25, 0.4, 1.8)); notes.push("bigger poses"); }
    if (has(/subtle|smaller|tone (?:it )?down|calmer|less dramatic/)) { p.amplitude = r3(clamp(p.amplitude * 0.8, 0.4, 1.8)); notes.push("smaller poses"); }
    let quality = clip.quality, duration = clip.intent.duration, loop = clip.loop, fps = clip.fps;
    if (fluent || has(/polish/)) { quality = quality === "fast" ? "balanced" : quality === "balanced" ? "high" : "cinematic"; notes.push("quality → " + quality); }
    if (has(/\blonger\b/) && !has(/anticipation/)) { duration = r3(duration * 1.3); notes.push("30% longer"); }
    if (has(/\bshorter\b/) && !has(/anticipation/)) { duration = r3(duration / 1.3); notes.push("30% shorter"); }
    const dm = f.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)\b/); if (dm) { duration = clamp(parseFloat(dm[1]), 0.2, 60); notes.push(`duration ${duration}s`); }
    if (has(/\bloop\b/) && !has(/no loop|stop looping|don't loop|do not loop/)) { loop = true; notes.push("looping"); }
    if (has(/no loop|stop looping|don't loop|do not loop|one[- ]shot/)) { loop = false; notes.push("not looping"); }
    let take = clip.take || 0, mirror = !!clip.mirrored, travel = !!clip.travel;
    if (has(/variation|different|another take|alternative|variant|new take|retake|again but|something else/)) { take += 1; notes.push("new take (" + (take + 1) + ")"); }
    if (has(/\bmirror|flip (?:it )?horizontally|other hand|left[- ]handed|switch (?:hands|sides)|opposite side/)) { mirror = !mirror; notes.push(mirror ? "mirrored (left/right swapped)" : "un-mirrored"); }
    if (has(/root motion|move forward|travel|cover ground|actually move/) && !has(/no root motion|in place|stay in place/)) { travel = true; notes.push("root motion on"); }
    if (has(/no root motion|in place|stay in place|stop moving/)) { travel = false; notes.push("root motion off (in place)"); }
    if (has(/snappier|punchier|crisper/)) { p.easingFlavor = "snappy"; notes.push("snappy easing"); }
    if (has(/softer|floatier|gentler|dreamy/)) { p.easingFlavor = "soft"; notes.push("soft easing"); }
    if (has(/mechanical|robotic easing|linear/)) { p.easingFlavor = "mechanical"; notes.push("mechanical easing"); }
    const intent = JSON.parse(JSON.stringify(clip.intent)); intent.duration = duration; intent.mirror = false; intent.travel = travel;
    // 1.55: moods and "then" chains are feedback too ("make it drunk", "add a bow at the end", "no mood")
    { const m = findMood(f); if (m && intent.mood !== m.name) { intent.mood = m.name; notes.push("mood: " + m.name); } if (has(/\b(no|remove|drop|without) (?:the )?mood|normal posture|neutral\b/) && intent.mood) { intent.mood = null; notes.push("mood removed"); } }
    if (has(/\b(?:then|add|append|end with|finish with|start with|begin with)\b/) && intent.category !== "attack") {
      const tail = f.match(/\b(?:then|add|append|end with|finish with)\s+(?:a |an |the )?([a-z][a-z ]{2,40})$/), head = f.match(/\b(?:start with|begin with)\s+(?:a |an |the )?([a-z][a-z ]{2,40})$/);
      const extra = tail ? tail[1].trim() : head ? head[1].trim() : null;
      if (extra && (findActs(extra).length || parseIntent(extra).category !== "improv")) { const baseText = intent.category === "sequence" ? intent.text : clip.prompt || intent.text; intent.text = head ? extra + " then " + baseText : baseText + " then " + extra; intent.category = "sequence"; intent.clauses = splitClauses(intent.text); intent.stages = []; notes.push((head ? "prepended " : "appended ") + JSON.stringify(extra)); if (!dm) duration = undefined; }
    }
    if (has(/\badd (?:a )?spin/)) { if (!intent.stages.some((s) => s.kind === "spin")) { const at = Math.max(0, intent.stages.findIndex((s) => s.kind === "land" || s.kind === "recover")); intent.stages.splice(at < 0 ? intent.stages.length : at, 0, { kind: "spin" }); notes.push("added a spin"); } }
    if (has(/\badd (?:a )?(?:landing|land)/) && !intent.stages.some((s) => s.kind === "land")) { const at = intent.stages.findIndex((s) => s.kind === "recover"); intent.stages.splice(at < 0 ? intent.stages.length : at, 0, { kind: "air" }, { kind: "land" }); notes.push("added a landing"); }
    // added stages extend the clip (by their default weight) instead of squeezing the existing beats - unless the user pinned a duration
    if (intent.stages && intent.stages.length && clip.intent.stages && intent.stages.length > clip.intent.stages.length && !dm) {
      const w1 = stageWeights(intent.stages, DEFAULT_PARAMS).reduce((a, b) => a + b, 0), w0 = stageWeights(clip.intent.stages, DEFAULT_PARAMS).reduce((a, b) => a + b, 0);
      if (w0 > 0 && w1 > w0) { duration = r3(clamp((duration || clip.duration) * w1 / w0, 0.2, 60)); intent.duration = duration; }
    }
    const polish = fluent || has(/\b(plant|ground|glue|stick|slid|float|simplif|fewer keys|clean|less keys|revers|backwards|rewind|overlap|follow[- ]?through|secondary motion|moving holds?|organic|mechanical|robotic|bouncy|bouncier|elastic|rubbery)\b|\b(hold|holds|linger|pause)\b.*\b(impact|hit|pose|poses|key|keys)/);
    if (!notes.length && !polish) notes.push("no recognised adjustment - regenerated with the same settings (try: make it slow / fast, a bit slower, much faster, half speed, 2x, fluent, smoother, more anticipation, heavier landing, exaggerate, subtle, longer, shorter, loop, new take, mirror, root motion, snappier, softer, more follow-through, hold the impact 4 frames, bouncy / mechanical / elastic easing)");
    const durChanged = !!dm || has(/\b(longer|shorter)\b/);
    let out = generate(intent, { quality, rigType: clip.rigType, name: notes.some((n) => /^(appended|prepended)/.test(n)) ? undefined : clip.name, fps, loop, params: p, duration: intent.category === "sequence" && !durChanged ? undefined : duration, priority: clip.priority, take, mirror, travel, mood: intent.mood || null });
    if (fluent) { out = smooth(out, { strength: 1 }); notes.push("spline smoothing pass"); }
    if (has(/\b(plant|ground(?:ed)?|glue|stick)\b.*\b(feet|foot|soles?)|\b(feet|foot)\b.*\b(plant|ground|slid|float)/)) { out = groundFeet(out, { force: true }); notes.push("planted the feet"); }
    if (has(/\b(simplif|fewer keys|clean(?: up)? keys|less keys)/)) { out = simplify(out, 2); notes.push("cleaned redundant keys"); }
    if (has(/\b(revers|backwards|rewind)/)) { out = reverse(out); notes.push("reversed"); }
    // 1.64 workbench tools by name: follow-through / overlap, ease presets, holds on impacts
    { const m = f.match(/\b(?:more\s+)?(?:overlap|follow[- ]?through|drag|secondary motion)\b(?:\s*(?:of|by)?\s*(\d+)\s*(?:f|frames?))?/); if (m) { const fr = Math.min(8, Math.max(1, parseInt(m[1], 10) || 2)); out = overlap(out, fr); notes.push(`overlap ${fr}f (follow-through)`); } }
    { const m = f.match(/\b(snappy|snappier|organic|mechanical|robotic|bouncy|bouncier|elastic|rubbery|anticipat\w*)\b/); if (m) { const id = /snap/.test(m[1]) ? "snappy" : /robot|mechan/.test(m[1]) ? "mechanical" : /bounc/.test(m[1]) ? "bouncy" : /elast|rubber/.test(m[1]) ? "elastic" : /anticip/.test(m[1]) ? "anticipate" : "organic"; out = easeAll(out, id); notes.push(`ease preset: ${id}`); } }
    if (has(/\b(hold|holds|linger|pause)\b.*\b(impact|hit|pose|poses|key|keys)|\b(moving holds?)\b/)) { const m = f.match(/(\d+)\s*(?:f|frames?)/); const fr = Math.min(12, Math.max(1, m ? parseInt(m[1], 10) : 3)); let cnt = 0; for (let i = out.keys.length - 2; i >= 1; i--) { if (/^(impact|land|reach)$/.test(out.keys[i].tag || "")) { out = holdKey(out, i, fr).clip; cnt++; } } if (cnt) notes.push(`${cnt} moving hold${cnt > 1 ? "s" : ""} of ${fr}f`); }
    out.feedback = (clip.feedback || []).concat([{ text: feedback, applied: notes }]);
    out.previous = { keys: clip.keys.length, duration: clip.duration, score: clip.report && clip.report.score };
    return out;
  }
  function variation(clip, seedDelta) { return applyFeedback(clip, "variation" + (seedDelta ? " " + seedDelta : "")); }

  // ───────────────────────── multi-stage sequences ─────────────────────────
  // Combined clip + one clip per stage group (retimed to start at 0, with the next stage's first key as a settle).
  // ───────────────────────── 1.56 animation SETS (several different animations, one character) ─────────────────────────
  // "idle, walk, run and jump animations" is NOT one clip and NOT a chain: it is a set of separate KeyframeSequences that
  // must feel like the same character and blend into each other. splitSet() recognises the request, generateSet() builds
  // every clip with ONE shared persona (lead side, arm rest, tempo, easing flavour) and compatibility() measures how well
  // they fit (stance distance, priorities, loop flags, fps / rig) and proposes fade times.
  const SET_CHAIN = /\b(then|after that|followed by|into an?|into the|combo|finisher|chain|sequence|while|during|transition)\b|->|→/i;
  const SET_FILLER = /\b(please|can you|could you|i need|i want|i'd like|give me|make|create|generate|build|author|design|produce|do|me|us|an?|the|my|our|some|few|set of|pack of|separate|individual|different|distinct|each|all|of|for|to|game|character|npc|player|rig|r15|r6|avatar|animations?|anims?|clips?|loops?|cycles?)\b/gi;
  const SET_WORDS = /^(idle|walk|run|sprint|jog|jump|fall|land|climb|swim|crouch|sneak|sit|sleep|dance|wave|attack|punch|kick|block|dodge|roll|death|die|hit|cheer|laugh|point|clap|salute|bow|swing|slash|cast|fly|tread|aim|strafe|crawl|emote|celebrate|taunt)s?$/i;
  function splitSet(text) {
    const raw = String(text || "").trim(); if (!raw || SET_CHAIN.test(raw)) return null;
    const hasListWords = /\b(animations|anims|clips|set|pack|separate|each|both|all)\b/i.test(raw) || /\d+\s*(?:animations|anims|clips)/i.test(raw);
    let parts = raw.split(/\n+|;|\s*,\s*|\s+and\s+|\s*&\s*|\s*\+\s*|\s*\/\s*|\s+or\s+|\s*(?:^|\s)\d+[.)]\s*/i).map((p) => p.replace(/^\s*(?:and|,|-|\*|•)\s*/i, "").trim()).filter(Boolean);
    if (parts.length < 2) {
      // "idle walk run jump" - bare category words in a row
      const toks = raw.replace(SET_FILLER, " ").split(/\s+/).filter(Boolean);
      if (toks.length >= 2 && toks.every((w) => SET_WORDS.test(w)) && new Set(toks.map((w) => w.toLowerCase())).size === toks.length) parts = toks; else return null;
    }
    // context shared by every part: "… for my zombie npc" → prefix + a style word carried into each prompt
    let ctx = ""; const last = parts[parts.length - 1]; const cm = last.match(/\s+for\s+(?:my|the|an?|our|this)?\s*([a-z][a-z0-9 ]{1,30})$/i);
    if (cm) { ctx = cm[1]; parts[parts.length - 1] = last.slice(0, cm.index); }
    const styleWord = (ctx.match(/\b(zombie|robot(?:ic)?|anime|cartoon(?:y)?|heavy|ninja|knight|fluid|realistic|military|soldier|old|drunk|injured|tired|scared|proud|happy|sad|angry|sneaky|boss|giant|tiny|cute|creepy|elegant|clumsy)\b/i) || [])[1] || "";
    const clean = parts.map((p) => p.replace(/\b(animations?|anims?|clips?|loops?|cycles?)\b/gi, " ").replace(/^(?:\s*(?:please|can you|could you|i need|i want|i'd like|give me|make|create|generate|build|author|me|us|an?|the|my|our|some|one|separate|different)\b)+/i, "").replace(/\s+/g, " ").trim()).filter(Boolean)
      .map((p) => (styleWord && !new RegExp("\\b" + styleWord, "i").test(p) ? styleWord + " " + p : p));
    if (clean.length < 2) return null;
    const intents = clean.map((p) => parseIntent(p));
    const cats = intents.map((i) => (i.layerOn ? "layer:" + i.upperText : i.category === "act" ? "act:" + i.acts.join("+") : i.category));
    if (intents.some((i) => i.category === "improv" || i.category === "sequence")) return null;
    if (new Set(cats).size < 2) return null; // "slow walk, fast walk" is variations - not a set
    if (clean.length === 2) {
      const pair = cats.slice().sort().join("|");
      if (/^jump\|land$/.test(pair) || /^(attack|block|dodge)\|(attack|block|dodge)$/.test(pair) && !hasListWords) return null;
      if (!hasListWords && !cats.every((c) => /^(idle|walk|run|swim|climb|sneak|strafe|walk_back|crawl|jump|fall|land|crouch|sit|dance|emote|act:|death|hit_react)/.test(c))) return null;
    }
    return clean;
  }
  function setPriority(c) { return c.priority || (/^(idle|sit|crouch|kneel|sleep|fly|tread|aim)$/.test(c.intent.category) ? "Idle" : /^(walk|run|swim|climb|sneak|strafe|walk_back|crawl|pushup)$/.test(c.intent.category) ? "Movement" : "Action"); }
  function stanceDistance(a, b, joints) { // max joint-angle gap between a's first key and b's first key (upper body by default)
    const A = a.keys[0].poses, B = b.keys[0].poses; let d = 0, worst = null;
    for (const j of joints || ["waist", "neck", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow", "root"]) { const p = A[j] || J(0, 0, 0), q = B[j] || J(0, 0, 0); for (let x = 0; x < 3; x++) { const g = Math.abs(p.rot[x] - q.rot[x]); if (g > d) { d = g; worst = j; } } }
    const ha = (A.root && A.root.pos ? A.root.pos[1] : 0), hb = (B.root && B.root.pos ? B.root.pos[1] : 0);
    return { deg: r3(d), joint: worst, height: r3(Math.abs(ha - hb)) };
  }
  function compatibility(clips) {
    const issues = [], list = (clips || []).filter((c) => c && c.keys && c.keys.length);
    if (list.length < 2) return { ok: true, score: 100, issues: [{ level: "info", msg: "one clip - nothing to compare" }], pairs: [], priorities: list.map((c) => ({ name: c.name, priority: setPriority(c) })), fades: [] };
    const rigs = new Set(list.map((c) => c.rigType)), fps = new Set(list.map((c) => c.fps));
    if (rigs.size > 1) issues.push({ level: "error", msg: `rig types differ (${[...rigs].join(", ")}) - every clip of a set must target the same rig` });
    if (fps.size > 1) issues.push({ level: "warning", msg: `frame rates differ (${[...fps].join(", ")} fps) - fine for Roblox, but retiming feels uneven; regenerate with one quality preset` });
    const personas = new Set(list.map((c) => c.persona ? `${c.persona.lead}/${c.persona.armRest}/${c.persona.easing}` : "?"));
    if (personas.size > 1) issues.push({ level: "warning", msg: `${personas.size} different personas (lead side / arm rest / easing) - clips were not generated as one character; regenerate them together (animation_set) or with the same character seed` });
    const idle = list.find((c) => c.intent && c.intent.category === "idle") || list.find((c) => c.loop) || list[0];
    const pairs = [], fades = [];
    for (const c of list) {
      if (c === idle) continue;
      const d = stanceDistance(idle, c);
      const fade = d.deg < 18 ? 0.1 : d.deg < 40 ? 0.2 : d.deg < 70 ? 0.3 : 0.4;
      pairs.push({ from: idle.name, to: c.name, deg: d.deg, joint: d.joint, height: d.height, fade });
      fades.push({ from: idle.name, to: c.name, fade });
      if (d.deg >= 70) issues.push({ level: "warning", msg: `${c.name} starts ${d.deg}° (${d.joint}) away from ${idle.name}'s stance - use AnimationTrack:Play(${fade}) so the blend hides the jump` });
      if (d.height > 0.6) issues.push({ level: "warning", msg: `${c.name} starts ${d.height} studs ${(c.keys[0].poses.root.pos || [0, 0, 0])[1] < (idle.keys[0].poses.root.pos || [0, 0, 0])[1] ? "lower" : "higher"} than ${idle.name} - the root will pop on transition` });
    }
    const pri = list.map((c) => ({ name: c.name, priority: setPriority(c), loop: !!c.loop }));
    const cycles = list.filter((c) => /^(walk|run|swim|climb|sneak|strafe|walk_back|crawl)$/.test(c.intent && c.intent.category));
    for (const c of cycles) if (!c.loop) issues.push({ level: "warning", msg: `${c.name} is a locomotion cycle but not looping - set loop so it does not stop after one stride` });
    const idles = list.filter((c) => c.intent && c.intent.category === "idle"); for (const c of idles) if (!c.loop) issues.push({ level: "warning", msg: `${c.name} (idle) should loop` });
    const byPri = {}; for (const p of pri) (byPri[p.priority] = byPri[p.priority] || []).push(p.name);
    const errors = issues.filter((i) => i.level === "error").length, warnings = issues.filter((i) => i.level === "warning").length;
    if (!issues.length) issues.push({ level: "info", msg: `${list.length} clips share one character (${[...personas][0]}), one rig (${[...rigs][0]}), ${[...fps][0]} fps; priorities ${Object.keys(byPri).map((k) => k + ": " + byPri[k].length).join(", ")}` });
    return { ok: errors === 0, score: Math.max(0, 100 - 25 * errors - 6 * warnings), errors, warnings, issues, pairs, priorities: pri, byPriority: byPri, fades, idle: idle.name, clips: list.length };
  }
  function setPrefix(text) { const m = String(text || "").match(/\bfor (?:my |the |an? )?([a-z][a-z0-9 ]{2,24}?)(?: (?:game|npc|character|boss|enemy|rig))?\s*$/i); if (!m) return ""; return m[1].split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("").slice(0, 20); }
  function generateSet(textOrList, opts) {
    opts = opts || {};
    const prompts = Array.isArray(textOrList) ? textOrList.map((s) => String(s || "").trim()).filter(Boolean) : (splitSet(textOrList) || splitClauses(textOrList));
    if (!prompts || prompts.length < 1) throw new Error("animation set: give at least one prompt (e.g. ['idle', 'walk', 'jump'] or 'idle, walk and jump animations')");
    const text = Array.isArray(textOrList) ? prompts.join(", ") : String(textOrList);
    const personaSeed = Number.isFinite(opts.personaSeed) ? opts.personaSeed >>> 0 : hashStr("set:" + prompts.join("|") + ":" + (opts.take || 0));
    const prefix = opts.prefix != null ? String(opts.prefix) : setPrefix(text);
    const avoid = (opts.avoid || []).slice(); const clips = [];
    prompts.forEach((p, i) => {
      const sub = Object.assign({}, opts, { personaSeed, avoid: avoid.slice(), name: undefined, duration: undefined, loop: undefined, prefix: undefined, params: Object.assign({ armRest: "loose" }, opts.params || {}) });
      const c = generate(p, sub);
      if (prefix && c.name.toLowerCase().indexOf(prefix.toLowerCase()) !== 0) c.name = prefix + "_" + c.name.replace(/^[^A-Za-z]+/, "");
      c.set = { id: personaSeed, index: i, size: prompts.length, prompt: text };
      avoid.push(c.fingerprint); clips.push(c);
    });
    const names = new Set(); for (const c of clips) { let n = c.name, k = 2; while (names.has(n)) n = c.name + "_" + k++; names.add(n); c.name = n; }
    for (const c of clips) c.set.members = clips.map((x) => x.name);
    const report = compatibility(clips);
    return { clips, report, personaSeed, prompts, prefix };
  }
  function describeSet(set) {
    const r = set.report;
    const lines = [`SET of ${set.clips.length} separate animations, one character (persona seed ${set.personaSeed}; ${set.clips[0].persona ? set.clips[0].persona.traits.join(", ") : ""}):`];
    for (const c of set.clips) lines.push(`- ${c.name}: ${c.intent.category}${c.intent.mood ? " (" + c.intent.mood + ")" : ""}, ${c.duration}s, ${c.keys.length} keys, ${c.loop ? "loop" : "one-shot"}, priority ${setPriority(c)}, score ${c.report.score}`);
    lines.push(`compatibility ${r.score}/100: ` + r.issues.map((i) => (i.level === "info" ? "" : "[" + i.level + "] ") + i.msg).join("; "));
    if (r.fades.length) lines.push("blend plan (AnimationTrack:Play(fadeTime)): " + r.fades.map((f) => `${f.from} → ${f.to} ${f.fade}s`).join(" · "));
    return lines.join("\n");
  }
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
      if (t <= keys[i].t) {
        const a = keys[i - 1], b = keys[i];
        if (clip.interp === "spline" && (a.ease || [])[0] !== "Constant" && b.tag !== "impact") return splineMix(clip, i - 1, t);
        const alpha = easeAlpha((t - a.t) / Math.max(1e-6, b.t - a.t), a.ease); return mix(a.poses, b.poses, alpha);
      }
    }
    return keys[keys.length - 1].poses;
  }
  // 1.54 spline interpolation (Blender F-curve style): C1 Hermite through the keys with auto-clamped Catmull-Rom tangents, so the
  // velocity no longer resets at every key. Loops take their end tangents from the other side of the seam; holds stay flat;
  // impact segments keep their eased snap (see sampleAt); Constant easing still steps.
  function splineMix(clip, i, t) {
    const keys = clip.keys, n = keys.length, a = keys[i], b = keys[i + 1], D = clip.duration;
    const h = Math.max(1e-6, b.t - a.t), u = clamp((t - a.t) / h, 0, 1);
    const loop = clip.loop && n > 2 && Math.abs(keys[n - 1].t - D) < 1e-6;
    const prev = i > 0 ? { k: keys[i - 1], t: keys[i - 1].t } : loop ? { k: keys[n - 2], t: keys[n - 2].t - D } : null;
    const next = i + 2 < n ? { k: keys[i + 2], t: keys[i + 2].t } : loop ? { k: keys[1], t: keys[1].t + D } : null;
    const h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u, h01 = -2 * u * u * u + 3 * u * u, h11 = u * u * u - u * u;
    const tangent = (pPrev, tPrev, p0, t0, p1, t1) => { // auto-clamped finite difference: zero at extrema and into holds
      if (pPrev == null) return 0;
      const d0 = (p0 - pPrev) / Math.max(1e-6, t0 - tPrev), d1 = (p1 - p0) / Math.max(1e-6, t1 - t0);
      if (d0 * d1 <= 0) return 0;
      const m = (d0 + d1) / 2, lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
      return Math.sign(m) * Math.min(Math.abs(m), lim);
    };
    const herm = (pPrev, tPrev, p0, p1, pNext, tNext) => { const m0 = tangent(pPrev, tPrev, p0, a.t, p1, b.t), m1 = pNext == null ? 0 : tangent(p0, a.t, p1, b.t, pNext, tNext); return h00 * p0 + h10 * h * m0 + h01 * p1 + h11 * h * m1; };
    const out = {};
    for (const j of JOINTS) {
      const A = a.poses[j] || J(0, 0, 0), B = b.poses[j] || J(0, 0, 0), P = prev && (prev.k.poses[j] || J(0, 0, 0)), N = next && (next.k.poses[j] || J(0, 0, 0));
      const o = { rot: [0, 1, 2].map((ax) => herm(P ? P.rot[ax] : null, prev && prev.t, A.rot[ax], B.rot[ax], N ? N.rot[ax] : null, next && next.t)) };
      if (A.pos || B.pos) { const pa = A.pos || [0, 0, 0], pb = B.pos || [0, 0, 0], pp = P ? P.pos || [0, 0, 0] : null, pn = N ? N.pos || [0, 0, 0] : null; o.pos = [0, 1, 2].map((ax) => herm(pp ? pp[ax] : null, prev && prev.t, pa[ax], pb[ax], pn ? pn[ax] : null, next && next.t)); }
      out[j] = o;
    }
    return out;
  }
  // Keys as Studio / rbxmx should receive them: eased clips export their keys verbatim; spline clips are baked to the frame grid
  // (plus every authored key time, so impacts and markers stay exact) with Linear easing - that is how a C1 curve reaches Roblox.
  // Roblox's Pose easing directions are "backwards from how these terms are used by most other animation tools and by
  // TweenService" (PoseEasingDirection docs): Pose.Out = the curve applied forward (accelerate towards the next key),
  // Pose.In = reversed (decelerate into it). The engine authors and previews in the standard sense (Out = decelerate),
  // so every Studio-bound key swaps In <-> Out here - otherwise anticipation floats and landings accelerate (1.56 fix).
  function robloxEase(ease) { const e = ease || ["CubicV2", "Out"]; return [e[0], e[1] === "Out" ? "In" : e[1] === "In" ? "Out" : e[1] || "In"]; }
  function exportKeys(clip) {
    if (clip.interp !== "spline" || !clip.keys || clip.keys.length < 2) return clip.keys;
    const fps = clip.fps || 30; let step = 1 / fps; const frames = Math.round(clip.duration * fps);
    if (frames > 240) step *= Math.ceil(frames / 240); // very long clips: thin the bake, authored keys are still exact
    const times = new Set(clip.keys.map((k) => r3(k.t)));
    for (let t = 0; t < clip.duration - 1e-6; t += step) times.add(r3(t));
    times.add(r3(clip.duration));
    const byT = new Map(clip.keys.map((k) => [r3(k.t), k]));
    return Array.from(times).sort((x, y) => x - y).map((t) => { const k = byT.get(t); return k ? { t, poses: k.poses, ease: ["Linear", "Out"], tag: k.tag, stage: k.stage, markers: k.markers } : { t, poses: sampleAt(clip, t), ease: ["Linear", "Out"], tag: "baked", synthetic: true }; });
  }
  function setInterp(clipIn, mode) { const c = cloneClip(clipIn); c.interp = mode === "spline" ? "spline" : "eased"; c.edited = true; c.report = validate(c); c.fingerprint = fingerprint(c); return c; }
  // World positions of every pivot + tips in the semantic frame (studs), root pivot at ROOT_HEIGHT.
  function forwardKinematics(poses) { return fkFull(poses).pts; }
  function fkFull(poses) {
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
    return { pts, world };
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
    const out = exportKeys(clip).map((key) => {
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
      for (const m of key.markers || []) if (m && m.name && !markers.some((x) => x.name === m.name)) markers.push({ name: String(m.name), value: String(m.value == null ? "" : m.value) }); // 1.64 user markers
      const re = robloxEase(key.ease);
      return { t: key.t, easing: { style: re[0], direction: re[1] }, markers, poses };
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
    const keys = exportKeys(clip).map((key) => {
      const sem = foldForRig(key.poses, type);
      const p = joints.map((j) => { const q = sem[j] || J(0, 0, 0); const arr = [r2(q.rot[0]), r2(q.rot[1]), r2(q.rot[2])]; if (q.pos && (q.pos[0] || q.pos[1] || q.pos[2])) arr.push(r3(q.pos[0]), r3(q.pos[1]), r3(q.pos[2])); return arr; });
      const m = []; const st = (clip.stages || []).find((s) => Math.abs(s.t0 - key.t) < 1e-6 && s.marker); if (st) m.push([st.marker, st.name]); if (key.tag === "impact") m.push(["impact", key.stage || ""]);
      for (const mk of key.markers || []) if (mk && mk.name && !m.some((x) => x[0] === mk.name)) m.push([String(mk.name), String(mk.value == null ? "" : mk.value)]); // 1.64 user markers
      return { t: key.t, e: robloxEase(key.ease), m, p };
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
  function serializeProject(clip) { return JSON.stringify({ format: "totalscript-animation", version: 1, engine: VERSION, clip }, null, 0); }
  function parseProject(text) {
    const j = typeof text === "string" ? JSON.parse(text) : text;
    const clip = j && (j.format === "totalscript-animation" || j.format === "orscript-animation") ? j.clip : (j && j.keys ? j : null);
    if (!clip || !Array.isArray(clip.keys) || !(clip.duration > 0)) throw new Error("not a TotalScript animation project (expected {format:'totalscript-animation', clip:{keys, duration}})");
    clip.keys = dedupeKeys(clip.keys);
    clip.report = validate(clip);
    return clip;
  }
  // Timing edits used by the editor
  function retime(clip, newDuration) { const s = newDuration / clip.duration; const c = JSON.parse(JSON.stringify(clip)); c.duration = r3(newDuration); c.keys = c.keys.map((k) => Object.assign({}, k, { t: r3(k.t * s) })); c.stages = (c.stages || []).map((st) => Object.assign({}, st, { t0: r3(st.t0 * s), t1: r3(st.t1 * s) })); c.edited = true; c.report = validate(c); return c; }
  // Keys never pass or swallow their neighbours while dragging: the move is clamped to the free frames between them.
  function moveKey(clip, index, t) {
    const c = JSON.parse(JSON.stringify(clip)); if (!c.keys[index]) return c; const step = 1 / (c.fps || 30);
    const lo = index > 0 ? c.keys[index - 1].t + step : 0, hi = index < c.keys.length - 1 ? c.keys[index + 1].t - step : c.duration;
    if (hi < lo - 1e-6) return c;
    c.keys[index].t = r3(clamp(clamp(t, 0, c.duration), lo, hi)); c.keys = dedupeKeys(c.keys); c.edited = true; c.report = validate(c); return c;
  }
  function setJoint(clip, index, joint, rot, pos) { const c = JSON.parse(JSON.stringify(clip)); const k = c.keys[index]; if (!k || !JOINTS.includes(joint)) return c; k.poses[joint] = Object.assign({}, k.poses[joint] || {}, rot ? { rot: rot.map(Number) } : {}, pos ? { pos: pos.map(Number) } : {}); c.edited = true; c.report = validate(c); return c; }
  function duplicateKey(clip, index) { const c = JSON.parse(JSON.stringify(clip)); const k = c.keys[index]; if (!k) return c; const step = 1 / c.fps; const t = r3(Math.min(c.duration, k.t + step)); c.keys.push({ t, poses: clonePose(k.poses), ease: k.ease, tag: "copy" }); c.keys = dedupeKeys(c.keys); c.edited = true; c.report = validate(c); return c; }
  function deleteKey(clip, index) { const c = JSON.parse(JSON.stringify(clip)); if (c.keys.length <= 2) return c; c.keys.splice(index, 1); c.edited = true; c.report = validate(c); return c; }
  // ───────────────────────── 1.54.0 polish + Blender-style tools ─────────────────────────
  // Anchors never move under smoothing / cleaning: the first + last key, impacts, holds, contacts and anything the user locked.
  const ANCHOR_TAG = /^(impact|hold|loop_end|contact|launch|start|end)$/;
  const UPPER_JOINTS = ["waist", "neck", "l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist"];
  const LOWER_JOINTS = ["root", "l_hip", "l_knee", "l_ankle", "r_hip", "r_knee", "r_ankle"];
  const GROUND_AUTO = /^(idle|walk|sneak|strafe|walk_back|crouch|emote|block|cast|aim|shoot|archery|pickup|hit_react|talk|stance)$/;
  const EFFECTORS = { l_hand: { tip: "l_wrist_tip", chain: [["l_shoulder", 0], ["l_shoulder", 2], ["l_shoulder", 1], ["l_elbow", 0]] }, r_hand: { tip: "r_wrist_tip", chain: [["r_shoulder", 0], ["r_shoulder", 2], ["r_shoulder", 1], ["r_elbow", 0]] }, l_foot: { tip: "l_ankle_tip", chain: [["l_hip", 0], ["l_hip", 2], ["l_hip", 1], ["l_knee", 0]] }, r_foot: { tip: "r_ankle_tip", chain: [["r_hip", 0], ["r_hip", 2], ["r_hip", 1], ["r_knee", 0]] } };
  const isAnchor = (key, i, n) => i === 0 || i === n - 1 || !!key.locked || ANCHOR_TAG.test(key.tag || "");
  const cloneClip = (clip) => JSON.parse(JSON.stringify(clip));
  const noteFix = (c, msg) => { c.fixes = (c.fixes || []).concat([msg]); c.edited = true; };
  function finish(c) { c.keys = snapToFps(dedupeKeys(c.keys), c.fps, c.duration); c.report = validate(c); c.fingerprint = fingerprint(c); return c; }
  // Per-channel view of a clip (graph editor / dope sheet): { joint: { x:[[t,v]..], y:[..], z:[..], px?, py?, pz? } }
  function channels(clip) {
    const out = {};
    for (const j of JOINTS) {
      const ch = { x: [], y: [], z: [] }; let hasPos = false;
      clip.keys.forEach((k, i) => { const p = k.poses[j] || J(0, 0, 0); ch.x.push([k.t, p.rot[0], i]); ch.y.push([k.t, p.rot[1], i]); ch.z.push([k.t, p.rot[2], i]); if (p.pos) hasPos = true; });
      if (hasPos) { ch.px = []; ch.py = []; ch.pz = []; clip.keys.forEach((k, i) => { const q = (k.poses[j] && k.poses[j].pos) || [0, 0, 0]; ch.px.push([k.t, q[0], i]); ch.py.push([k.t, q[1], i]); ch.pz.push([k.t, q[2], i]); }); }
      out[j] = ch;
    }
    return out;
  }
  // Roughness = mean |angular acceleration| (deg/s^2, fps-independent) of every joint channel sampled on the fps grid, skipping
  // the frames around impacts / holds (those are meant to snap); smoothness maps it to 0..100 (100 = silky).
  function smoothness(clip) {
    const fps = clip.fps || 30, n = Math.max(3, Math.round(clip.duration * fps) + 1), dt = clip.duration / (n - 1);
    if (!clip.keys || clip.keys.length < 2 || !(dt > 0)) return { roughness: 0, smoothness: 100, samples: 0 };
    const snap = (clip.keys || []).filter((k) => k.tag === "impact" || k.tag === "hold").map((k) => k.t);
    const S = []; for (let i = 0; i < n; i++) S.push(sampleAt(clip, i * dt));
    let sum = 0, cnt = 0, worst = 0, worstJ = null;
    for (let i = 1; i < n - 1; i++) {
      const t = i * dt; if (snap.some((ts) => Math.abs(ts - t) <= dt * 1.5)) continue;
      for (const j of JOINTS) for (let ax = 0; ax < 3; ax++) {
        const a = (S[i - 1][j] || J(0, 0, 0)).rot[ax], b = (S[i][j] || J(0, 0, 0)).rot[ax], c = (S[i + 1][j] || J(0, 0, 0)).rot[ax];
        const d2 = Math.abs(c - 2 * b + a) / (dt * dt); sum += d2; cnt++; if (d2 > worst) { worst = d2; worstJ = j; }
      }
    }
    const rough = cnt ? sum / cnt : 0; // deg/s^2
    return { roughness: Math.round(rough), smoothness: Math.round(clamp(100 - rough / 16, 0, 100)), peak: Math.round(worst), peakJoint: worstJ, samples: n };
  }
  // Blender "Smooth Keys" + spline breakdowns: non-anchor keys relax toward their time-weighted neighbours, then a Catmull-Rom
  // midpoint is inserted into every wide gap so the eased interpolation follows an arc instead of a straight line.
  function smooth(clipIn, opts) {
    opts = opts || {}; const strength = clamp(Number.isFinite(opts.strength) ? opts.strength : 1, 0, 1), passes = clamp(opts.passes || 1, 1, 4);
    const c = cloneClip(clipIn); const keys = c.keys; const n = keys.length; if (n < 3) return c;
    const before = smoothness(c);
    if (opts.spline !== false) c.interp = "spline"; // C1 curves between the keys - the main reason motion stops stuttering at every key
    if (opts.breakdowns === undefined) opts.breakdowns = c.interp !== "spline"; // spline curves do not need breakdown keys
    const chan = (k, j) => k.poses[j] || J(0, 0, 0);
    for (let pass = 0; pass < passes; pass++) {
      const snap = keys.map((k) => clonePose(k.poses));
      for (let i = 1; i < n - 1; i++) {
        if (isAnchor(keys[i], i, n)) continue;
        const a = keys[i - 1], b = keys[i + 1], u = clamp((keys[i].t - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
        for (const j of JOINTS) {
          const P = snap[i - 1][j] || J(0, 0, 0), Q = snap[i + 1][j] || J(0, 0, 0), cur = chan(keys[i], j);
          const rot = cur.rot.map((v, ax) => v + (lerp(P.rot[ax], Q.rot[ax], u) - v) * strength * 0.5);
          const o = { rot }; if (cur.pos) { const pa = P.pos || [0, 0, 0], pb = Q.pos || [0, 0, 0]; o.pos = cur.pos.map((v, ax) => v + (lerp(pa[ax], pb[ax], u) - v) * strength * 0.5); }
          keys[i].poses[j] = o;
        }
      }
    }
    let added = 0;
    if (opts.breakdowns !== false) {
      const out = []; const minGap = 4 / (c.fps || 30);
      for (let i = 0; i < n; i++) {
        out.push(keys[i]); const a = keys[i], b = keys[i + 1]; if (!b) break;
        if (b.t - a.t < minGap || (a.ease || [])[0] === "Constant" || a.tag === "hold" || b.tag === "hold") continue;
        const p0 = keys[Math.max(0, i - 1)], p3 = keys[Math.min(n - 1, i + 2)];
        const poses = {}; let dev = 0;
        for (const j of JOINTS) {
          const A = chan(p0, j).rot, B = chan(a, j).rot, C = chan(b, j).rot, D = chan(p3, j).rot;
          const rot = [0, 1, 2].map((ax) => { const cr = 0.5 * (2 * B[ax] + (-A[ax] + C[ax]) * 0.5 + (2 * A[ax] - 5 * B[ax] + 4 * C[ax] - D[ax]) * 0.25 + (-A[ax] + 3 * B[ax] - 3 * C[ax] + D[ax]) * 0.125); const lin = (B[ax] + C[ax]) / 2; const v = lin + (cr - lin) * strength; dev = Math.max(dev, Math.abs(v - lin)); return clamp(v, LIMITS[j][["x", "y", "z"][ax]][0], LIMITS[j][["x", "y", "z"][ax]][1]); });
          const o = { rot }; const ap = chan(a, j).pos, bp = chan(b, j).pos; if (ap || bp) { const pa = ap || [0, 0, 0], pb = bp || [0, 0, 0]; o.pos = [0, 1, 2].map((ax) => (pa[ax] + pb[ax]) / 2); }
          poses[j] = o;
        }
        if (dev < 1.5) continue; // the straight line was already right - no breakdown needed
        const t = r3((a.t + b.t) / 2), half = Math.max(1e-3, t - a.t);
        let fast = false; for (const j of JOINTS) { const B = chan(a, j).rot, M = poses[j].rot, C = chan(b, j).rot; for (let ax = 0; ax < 3; ax++) if (Math.abs(M[ax] - B[ax]) / half > SPEED_LIMIT.normal || Math.abs(C[ax] - M[ax]) / half > SPEED_LIMIT.normal) fast = true; }
        if (fast) continue;
        out.push({ t, poses, ease: ["CubicV2", "InOut"], tag: "breakdown", stage: a.stage, synthetic: true }); added++;
      }
      c.keys = out;
    }
    finish(c);
    const after = smoothness(c);
    noteFix(c, `smoothed (strength ${strength}, ${passes} pass${passes > 1 ? "es" : ""}, ${c.interp === "spline" ? "spline interpolation" : added + " spline breakdown" + (added === 1 ? "" : "s")}; smoothness ${before.smoothness} → ${after.smoothness})`);
    c.report = validate(c);
    return c;
  }
  // Blender "Clean Keyframes": drop keys that the interpolation between their neighbours already reproduces within `tol` degrees.
  function simplify(clipIn, tol) {
    tol = Number.isFinite(tol) ? Math.max(0.1, tol) : 2; const c = cloneClip(clipIn); const before = c.keys.length;
    let removed = true;
    while (removed && c.keys.length > 2) {
      removed = false; const n = c.keys.length;
      for (let i = 1; i < n - 1; i++) {
        const k = c.keys[i]; if (isAnchor(k, i, n)) continue;
        const a = c.keys[i - 1], b = c.keys[i + 1], u = (k.t - a.t) / Math.max(1e-6, b.t - a.t); let maxD = 0;
        for (const j of JOINTS) { const P = a.poses[j] || J(0, 0, 0), Q = b.poses[j] || J(0, 0, 0), K = k.poses[j] || J(0, 0, 0); for (let ax = 0; ax < 3; ax++) maxD = Math.max(maxD, Math.abs(K.rot[ax] - lerp(P.rot[ax], Q.rot[ax], u))); if (K.pos) { const pa = P.pos || [0, 0, 0], pb = Q.pos || [0, 0, 0]; for (let ax = 0; ax < 3; ax++) maxD = Math.max(maxD, Math.abs(K.pos[ax] - lerp(pa[ax], pb[ax], u)) * 40); } }
        if (maxD <= tol) { c.keys.splice(i, 1); removed = true; break; }
      }
    }
    finish(c); noteFix(c, `simplified: ${before} → ${c.keys.length} keys (tolerance ${tol}°)`); c.report = validate(c);
    return c;
  }
  function reverse(clipIn) {
    const c = cloneClip(clipIn); const D = c.duration, old = c.keys, n = old.length;
    const flipDir = (e) => { const [s, d] = e || ["CubicV2", "Out"]; return [s, d === "In" ? "Out" : d === "Out" ? "In" : d]; };
    c.keys = old.map((_, i) => { const src = old[n - 1 - i]; const segSrc = old[n - 2 - i] || src; return { t: r3(D - src.t), poses: clonePose(src.poses), ease: flipDir(segSrc.ease), tag: src.tag === "loop_end" ? "start" : src.tag === "start" ? (c.loop ? "loop_end" : "end") : src.tag, stage: src.stage, synthetic: src.synthetic }; });
    c.stages = (c.stages || []).slice().reverse().map((s) => Object.assign({}, s, { t0: r3(D - s.t1), t1: r3(D - s.t0) }));
    c.name = /_Reversed$/.test(c.name) ? c.name.replace(/_Reversed$/, "") : c.name + "_Reversed";
    finish(c); noteFix(c, "reversed in time"); c.report = validate(c);
    return c;
  }
  // Blender "Bake Action": one key per frame on the fps grid, linear between (what Studio will play anyway).
  function bake(clipIn, fps) {
    const c = cloneClip(clipIn); if (fps) c.fps = clamp(Math.round(fps), 10, 120);
    const n = Math.max(2, Math.round(c.duration * c.fps) + 1); const keys = [];
    for (let i = 0; i < n; i++) { const t = r3(Math.min(c.duration, i / c.fps)); const near = clipIn.keys.find((k) => Math.abs(k.t - t) < 0.5 / c.fps); keys.push({ t, poses: clonePose(sampleAt(clipIn, t)), ease: ["Linear", "Out"], tag: near ? near.tag : "baked", stage: near && near.stage, synthetic: !near }); }
    c.keys = keys; c.baked = true; c.interp = "eased"; // dense linear keys ARE the curve now
    finish(c); noteFix(c, `baked ${c.keys.length} frames @ ${c.fps} fps`); c.report = validate(c);
    return c;
  }
  // Blender "Cycle offset": rotate where a loop starts (sync a walk's contact to frame 0, etc.). Non-looping clips are returned untouched.
  function cycleOffset(clipIn, seconds) {
    const c = cloneClip(clipIn); if (!c.loop || !(c.duration > 0)) return c;
    const D = c.duration, off = ((seconds % D) + D) % D; if (off < 1e-6) return c;
    const src = c.keys.slice(); if (src.length >= 2 && Math.abs(src[src.length - 1].t - D) < 1e-6) src.pop();
    const keys = src.map((k) => Object.assign({}, k, { t: r3((((k.t - off) % D) + D) % D) }));
    if (!keys.some((k) => Math.abs(k.t) < 1e-6)) keys.push({ t: 0, poses: clonePose(sampleAt(clipIn, off)), ease: ["CubicV2", "InOut"], tag: "start", synthetic: true });
    keys.sort((a, b) => a.t - b.t);
    c.keys = closeLoop(keys, D, c.travel);
    c.stages = (c.stages || []).map((s) => Object.assign({}, s, { t0: r3((((s.t0 - off) % D) + D) % D), t1: r3((((s.t1 - off) % D) + D) % D || D) }));
    finish(c); noteFix(c, `cycle offset ${r3(off)}s`); c.report = validate(c);
    return c;
  }
  // Blender "I": insert a key at the playhead holding the pose the interpolation already shows there.
  function insertKey(clipIn, t) {
    const c = cloneClip(clipIn); const step = 1 / c.fps; t = r3(clamp(Math.round(t * c.fps) / c.fps, 0, c.duration)); // frame-aligned like every other key
    const existing = c.keys.findIndex((k) => Math.abs(k.t - t) < step / 2); if (existing >= 0) return { clip: c, index: existing, inserted: false };
    const prev = c.keys.filter((k) => k.t < t).pop();
    c.keys.push({ t, poses: clonePose(sampleAt(clipIn, t)), ease: prev ? prev.ease : ["CubicV2", "Out"], tag: "key", stage: prev && prev.stage });
    finish(c); c.edited = true; c.report = validate(c);
    return { clip: c, index: c.keys.findIndex((k) => Math.abs(k.t - t) < 1e-6), inserted: true };
  }
  // Blender NLA-style layering: lower body + root from `base`, upper body from `upper` (stretched to the base duration or looped
  // at its own period), blended by `weight`. walk + wave, run + aim, idle + talk ...
  // 1.58 keep-tempo layering. "stretch" retimes the upper clip to the base's length - a 2 s wave over a 1 s walk cycle plays
  // twice as fast, which is exactly what people complain about after combining. The default is now "auto": the upper clip
  // keeps its own tempo; a looping base is tiled to cover it (phase preserved), a one-shot base holds its last pose, and an
  // upper clip shorter than the base plays once and holds (or repeats, if it loops).
  function tileLoop(clip, n) {
    const c = cloneClip(clip); const D = clip.duration; const keys = []; const first = clip.keys[0], last = clip.keys[clip.keys.length - 1];
    const dz = clip.travel && first.poses.root && first.poses.root.pos && last.poses.root && last.poses.root.pos ? last.poses.root.pos[2] - first.poses.root.pos[2] : 0;
    for (let i = 0; i < n; i++) for (const k of clip.keys) { if (i > 0 && k.t < 1e-6) continue; const poses = clonePose(k.poses); if (dz && poses.root && poses.root.pos) poses.root.pos = [poses.root.pos[0], poses.root.pos[1], poses.root.pos[2] + dz * i]; keys.push(Object.assign({}, k, { t: r3(i * D + k.t), poses })); }
    c.keys = keys; c.duration = r3(n * D); c.stages = [];
    for (let i = 0; i < n; i++) for (const st of clip.stages || []) c.stages.push(Object.assign({}, st, { name: n > 1 ? st.name + "_" + (i + 1) : st.name, t0: r3(i * D + st.t0), t1: r3(i * D + st.t1) }));
    return c;
  }
  function holdTo(clip, T) {
    const c = cloneClip(clip); if (T <= clip.duration + 1e-6) return c; const last = clip.keys[clip.keys.length - 1];
    c.keys = c.keys.concat([{ t: r3(T), poses: clonePose(last.poses), ease: ["Linear", "InOut"], tag: "hold" }]);
    c.duration = r3(T); c.stages = (clip.stages || []).concat([{ name: "hold", kind: "hold", t0: r3(clip.duration), t1: r3(T), marker: "hold" }]); return c;
  }
  function layer(baseIn, upper, opts) {
    opts = opts || {}; const weight = clamp(Number.isFinite(opts.weight) ? opts.weight : 1, 0, 1);
    let fit = opts.fit === "loop" ? "loop" : opts.fit === "stretch" ? "stretch" : opts.fit === "hold" ? "hold" : "auto";
    const requested = fit; let base = baseIn, tempo = null;
    if (fit === "auto") {
      const U0 = upper.duration || baseIn.duration, D0 = baseIn.duration;
      if (U0 > D0 + 1e-6) {
        if (baseIn.loop) { const n = Math.ceil(U0 / D0 - 1e-6); base = tileLoop(baseIn, n); if (base.duration > U0 + 1e-6 && base.duration / U0 <= 1.25) { base = retime(base, U0); base.loop = baseIn.loop; } tempo = `kept tempo: "${upper.name}" (${U0}s) plays at its own speed over ${n} cycles of "${baseIn.name}"${base.duration !== r3(n * D0) ? ` (cycle eased to ${r3(base.duration / n)}s)` : ""}`; }
        else { base = holdTo(baseIn, U0); tempo = `kept tempo: "${upper.name}" (${U0}s) plays at its own speed; "${baseIn.name}" holds its last pose from ${D0}s to ${U0}s`; }
      } else if (U0 < D0 - 1e-6) tempo = `kept tempo: "${upper.name}" (${U0}s) plays once at its own speed and ${upper.loop ? "repeats" : "holds its last pose"} until ${D0}s`;
      fit = upper.loop && U0 < base.duration - 1e-6 ? "loop" : "hold";
    }
    const joints = Array.isArray(opts.joints) && opts.joints.length ? opts.joints.filter((j) => JOINTS.includes(j)) : UPPER_JOINTS;
    const D = base.duration, U = upper.duration || D;
    const tu = (t) => fit === "loop" ? ((t % U) + U) % U : fit === "hold" ? Math.min(t, U) : (t / D) * U;
    const times = new Set(base.keys.map((k) => r3(k.t)));
    if (fit === "loop") { for (let n = 0; n * U < D + 1e-6; n++) for (const k of upper.keys) { const t = r3(n * U + k.t); if (t <= D + 1e-6) times.add(Math.min(D, t)); } }
    else if (fit === "hold") { for (const k of upper.keys) if (k.t <= D + 1e-6) times.add(r3(k.t)); }
    else for (const k of upper.keys) times.add(r3((k.t / U) * D));
    const keys = Array.from(times).sort((a, b) => a - b).map((t) => {
      const poses = clonePose(sampleAt(base, t)), up = sampleAt(upper, tu(t));
      for (const j of joints) { const A = poses[j] || J(0, 0, 0), B = up[j] || J(0, 0, 0); const o = { rot: [0, 1, 2].map((ax) => lerp(A.rot[ax], B.rot[ax], weight)) }; if (j !== "root" && (A.pos || B.pos)) { const pa = A.pos || [0, 0, 0], pb = B.pos || [0, 0, 0]; o.pos = [0, 1, 2].map((ax) => lerp(pa[ax], pb[ax], weight)); } if (j === "root" && A.pos) o.pos = A.pos.slice(); poses[j] = o; }
      const bk = base.keys.find((k) => Math.abs(k.t - t) < 1e-6), uk = upper.keys.find((k) => Math.abs(r3(fit === "stretch" ? (k.t / U) * D : k.t) - t) < 1e-6 || (fit === "loop" && Math.abs(((t % U) + U) % U - k.t) < 1e-6));
      return { t, poses, ease: (bk && bk.ease) || (uk && uk.ease) || ["CubicV2", "InOut"], tag: bk ? bk.tag : uk ? "layer" : "layer", stage: bk && bk.stage };
    });
    const c = cloneClip(base);
    c.keys = keys; c.name = opts.name || `${base.name}+${upper.name}`;
    c.interp = "spline"; // 1.58: the upper body is re-sampled at the base's key times; per-segment easing between dense samples pulses, a spline through them stays fluent c.prompt = `${base.prompt || base.name} + ${upper.prompt || upper.name} (upper body)`;
    c.layered = { base: base.name, upper: upper.name, weight, fit, requested, tempo, joints };
    c.stages = (base.stages || []).concat((upper.stages || []).map((s) => Object.assign({}, s, { name: "upper:" + s.name, t0: r3(fit === "stretch" ? (s.t0 / U) * D : Math.min(D, s.t0)), t1: r3(fit === "stretch" ? (s.t1 / U) * D : Math.min(D, s.t1)) })));
    c.limitations = (base.limitations || []).concat([`layered clip: ${joints.length === UPPER_JOINTS.length ? "upper body" : joints.join(", ")} comes from "${upper.name}" (${requested === "auto" ? "keep tempo → " + fit : fit}, weight ${weight}) - the two were not authored together, check the seam and shoulder/hip balance in the preview.`]).concat(tempo ? [tempo] : []);
    if (c.loop) c.keys = closeLoop(c.keys, D, c.travel);
    finish(c); noteFix(c, `layered ${upper.name} over ${base.name}`); c.report = validate(c); c.edited = true;
    return c;
  }
  // 2-bone IK (analytic, Blender-style pole): hands reach a world target through shoulder (x,y,z) + elbow (x), feet through
  // hip (x,y,z) + knee (x). The limb's natural bend is the pole (elbows back/out, knees forward), joint limits are respected,
  // the wrist/ankle tip offset is iterated in, and a short bounded coordinate-descent polish absorbs what the clamps cost.
  // ───────────────────────── 1.64 professional key tools (replace the dope sheet / graph editor) ─────────────────────────
  // breakdown: a "tween machine" key between the neighbours of time t, favouring the previous (bias 0) or the next (bias 1)
  // pose instead of the interpolation - the classic way to add a passing position or a favour without re-posing by hand.
  function breakdown(clipIn, t, bias) {
    const c = cloneClip(clipIn); const b = clamp(Number.isFinite(bias) ? bias : 0.5, 0, 1); const step = 1 / (c.fps || 30);
    const tt = clamp(t, 0, c.duration);
    const existing = c.keys.findIndex((k) => Math.abs(k.t - tt) < step / 2);
    let prev = null, next = null; for (const k of c.keys) { if (k.t < tt - step / 2) prev = k; if (k.t > tt + step / 2 && !next) next = k; }
    if (!prev || !next) { const r = insertKey(c, tt); return { clip: r.clip, index: r.index, inserted: r.inserted, bias: b, reason: "no neighbour on one side - plain key" }; }
    const poses = {}; for (const j of JOINTS) { const a = prev.poses[j] || J(0, 0, 0), z = next.poses[j] || J(0, 0, 0); const o = { rot: [0, 1, 2].map((i) => r3(lerp(a.rot[i], z.rot[i], b))) }; if (a.pos || z.pos) o.pos = [0, 1, 2].map((i) => r3(lerp((a.pos || [0, 0, 0])[i], (z.pos || [0, 0, 0])[i], b))); poses[j] = o; }
    if (existing >= 0) { c.keys[existing].poses = poses; c.keys[existing].tag = "breakdown"; c.edited = true; c.report = validate(c); c.fingerprint = fingerprint(c); return { clip: c, index: existing, inserted: false, bias: b }; }
    c.keys.push({ t: r3(Math.round(tt / step) * step), poses, ease: ["CubicV2", "InOut"], tag: "breakdown", stage: prev.stage });
    c.keys = dedupeKeys(c.keys); c.edited = true; c.report = validate(c); c.fingerprint = fingerprint(c);
    return { clip: c, index: c.keys.findIndex((k) => k.tag === "breakdown" && Math.abs(k.t - tt) < step), inserted: true, bias: b };
  }
  // hold: a moving hold - the selected pose is repeated `frames` later (tagged "hold", so Smooth / Simplify keep it)
  function holdKey(clipIn, index, frames) {
    const c = cloneClip(clipIn); const k = c.keys[index]; if (!k) return { clip: c, index };
    const step = 1 / (c.fps || 30); const n = Math.max(1, Math.round(Number(frames) || 2)); const t = r3(Math.min(c.duration, k.t + n * step));
    if (t <= k.t + 1e-6) return { clip: c, index, reason: "already at the end" };
    const nextI = c.keys.findIndex((x) => x.t > k.t + 1e-6);
    // push later keys back by the hold length when they would collide, never past the duration
    if (nextI >= 0 && c.keys[nextI].t < t + step) { const shift = r3(t + step - c.keys[nextI].t); for (let i = nextI; i < c.keys.length; i++) c.keys[i].t = r3(Math.min(c.duration, c.keys[i].t + shift)); }
    c.keys.push({ t, poses: clonePose(k.poses), ease: ["Linear", "InOut"], tag: "hold", stage: k.stage });
    k.ease = ["Linear", "InOut"]; // a hold is flat: no ease-out drift into the copy
    c.keys = dedupeKeys(c.keys); c.edited = true; c.report = validate(c); c.fingerprint = fingerprint(c);
    return { clip: c, index: c.keys.findIndex((x) => Math.abs(x.t - t) < step / 2), frames: n };
  }
  // nudge: move a key by whole frames (clamped between its neighbours, like moveKey)
  function nudgeKey(clip, index, frames) { const step = 1 / (clip.fps || 30); const k = clip.keys[index]; if (!k) return clip; return moveKey(clip, index, k.t + (Number(frames) || 0) * step); }
  // ease presets over the whole clip - impacts / lands keep a sharp arrival, holds stay flat
  const EASE_PRESETS = {
    snappy: { label: "Snappy", note: "fast in, settle out (CubicV2 Out); impacts Linear", key: ["CubicV2", "Out"], impact: ["Linear", "InOut"] },
    organic: { label: "Organic", note: "ease both ends (CubicV2 InOut)", key: ["CubicV2", "InOut"], impact: ["CubicV2", "Out"] },
    mechanical: { label: "Mechanical", note: "constant speed (Linear) - robots, machines", key: ["Linear", "InOut"], impact: ["Linear", "InOut"] },
    bouncy: { label: "Bouncy", note: "Bounce Out into impacts / lands, CubicV2 elsewhere", key: ["CubicV2", "Out"], impact: ["Bounce", "Out"] },
    elastic: { label: "Elastic", note: "Elastic Out into impacts (cartoony overshoot)", key: ["CubicV2", "Out"], impact: ["Elastic", "Out"] },
    anticipate: { label: "Anticipate", note: "CubicV2 In into impacts (wind-up feel), InOut elsewhere", key: ["CubicV2", "InOut"], impact: ["CubicV2", "In"] },
  };
  function easeAll(clipIn, preset) {
    const c = cloneClip(clipIn); const p = EASE_PRESETS[preset] || EASE_PRESETS.organic;
    c.keys = c.keys.map((k) => { const tag = k.tag || ""; const ease = tag === "hold" ? ["Linear", "InOut"] : /^(impact|land|contact|slam)$/.test(tag) ? p.impact.slice() : p.key.slice(); return Object.assign({}, k, { ease }); });
    c.interp = "eased"; c.easePreset = preset; c.edited = true; c.report = validate(c); c.fingerprint = fingerprint(c); return c;
  }
  // overlap / follow-through: child joints (elbows, wrists, head, knees, ankles) lag their parents by `frames`
  const LAG_JOINTS = ["neck", "l_elbow", "l_wrist", "r_elbow", "r_wrist", "l_knee", "l_ankle", "r_knee", "r_ankle"];
  function overlap(clipIn, frames, joints) {
    const src = cloneClip(clipIn); const c = cloneClip(clipIn); const step = 1 / (c.fps || 30); const lag = Math.max(0, Number(frames) || 0) * step; if (!lag) return c;
    const set = Array.isArray(joints) && joints.length ? joints.filter((j) => JOINTS.includes(j)) : LAG_JOINTS;
    const n = c.keys.length;
    c.keys.forEach((k, i) => {
      if (!c.loop && (i === 0 || i === n - 1)) return; // one-shots keep their rest poses at both ends
      let t = k.t - lag; if (c.loop) { while (t < 0) t += c.duration; } else t = Math.max(0, t);
      const past = sampleAt(src, t);
      for (const j of set) if (past[j]) k.poses[j] = Object.assign({}, k.poses[j] || {}, { rot: past[j].rot.map((v) => r3(v)) });
    });
    if (c.loop && n > 1) c.keys[n - 1].poses = clonePose(c.keys[0].poses);
    c.overlapFrames = (c.overlapFrames || 0) + Math.round(frames); c.edited = true; c.report = validate(c); c.fingerprint = fingerprint(c); return c;
  }
  // markers: KeyframeMarker events on a key (GetMarkerReachedSignal in Studio) - footsteps, hits, sounds, VFX cues
  function setMarker(clipIn, index, name, value) {
    const c = cloneClip(clipIn); const k = c.keys[index]; if (!k) return c;
    const nm = String(name || "").trim().slice(0, 50); if (!nm) return c;
    k.markers = (k.markers || []).filter((m) => m.name !== nm).concat([{ name: nm, value: String(value == null ? "" : value).slice(0, 100) }]);
    c.edited = true; c.fingerprint = fingerprint(c); return c;
  }
  function removeMarker(clipIn, index, name) { const c = cloneClip(clipIn); const k = c.keys[index]; if (!k || !k.markers) return c; k.markers = k.markers.filter((m) => m.name !== name); if (!k.markers.length) delete k.markers; c.edited = true; c.fingerprint = fingerprint(c); return c; }
  function markers(clip) { const out = []; (clip.keys || []).forEach((k, i) => { for (const m of k.markers || []) out.push({ t: k.t, index: i, name: m.name, value: m.value }); }); return out; }
  // arcs: the path an effector tip draws through the clip (motion trail) - sampled per frame, keys flagged
  const ARC_TIPS = { r_hand: "r_wrist_tip", l_hand: "l_wrist_tip", r_foot: "r_ankle_tip", l_foot: "l_ankle_tip", head: "neck_tip", root: "root" };
  function arcs(clip, which, samples) {
    const names = Array.isArray(which) && which.length ? which.filter((w) => ARC_TIPS[w]) : Object.keys(ARC_TIPS);
    const n = Math.max(2, Math.min(240, Number(samples) || Math.round(clip.duration * clip.fps) + 1));
    const out = {}; for (const w of names) out[w] = [];
    for (let i = 0; i < n; i++) { const t = (i / (n - 1)) * clip.duration; const pts = forwardKinematics(sampleAt(clip, t)); for (const w of names) out[w].push({ t: r3(t), p: pts[ARC_TIPS[w]].map((v) => r3(v)) }); }
    const keyTimes = clip.keys.map((k) => k.t);
    for (const w of names) for (const s of out[w]) s.key = keyTimes.some((kt) => Math.abs(kt - s.t) < 0.5 / clip.fps);
    return out;
  }
  // timing report: spacing / arc / twinning analysis an animator would do by eye
  function timing(clip) {
    const notes = []; const keys = clip.keys; const step = 1 / (clip.fps || 30);
    const gaps = []; for (let i = 1; i < keys.length; i++) gaps.push(keys[i].t - keys[i - 1].t);
    if (gaps.length >= 3 && !clip.loop) { const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length; const varc = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / (mean || 1); if (varc < 0.12) notes.push({ level: "warn", kind: "even", text: `keys are evenly spaced (${fmtS(mean)} apart) - real motion has fast and slow parts; try a hold or a breakdown` }); }
    const tiny = gaps.filter((g) => g < step * 1.5).length; if (tiny) notes.push({ level: "info", kind: "dense", text: `${tiny} key gap${tiny > 1 ? "s" : ""} of a single frame - fine for impacts, noisy elsewhere` });
    // twinning: left and right arms mirroring each other on most keys reads mechanical
    let twins = 0, cnt = 0; for (const k of keys) { const l = k.poses.l_shoulder, r = k.poses.r_shoulder; if (!l || !r) continue; cnt++; if (Math.abs(l.rot[0] - r.rot[0]) < 4 && Math.abs(l.rot[2] + r.rot[2]) < 4) twins++; }
    if (cnt >= 3 && twins / cnt > 0.7 && !/^(idle|block|cheer|clap|pushup|situp|jacks|squat|meditate|pray|surrender)/.test((clip.intent || {}).category + "_" + ((clip.intent || {}).acts || []).join("_"))) notes.push({ level: "info", kind: "twinning", text: `arms mirror each other on ${twins}/${cnt} keys (twinning) - offset one side a few degrees or a frame` });
    const hasHold = keys.some((k) => k.tag === "hold"), hasBreak = keys.some((k) => k.tag === "breakdown"), hasMark = keys.some((k) => k.markers && k.markers.length);
    const ends = !clip.loop && keys.length >= 2 ? Math.max(0, (keys[1].t - keys[0].t)) : 0;
    if (!clip.loop && keys.length >= 3 && ends < step * 2) notes.push({ level: "info", kind: "anticipation", text: "the first move starts on frame 1 - a 2-4 frame anticipation (small counter-move) sells it" });
    return { gaps: gaps.map((g) => r3(g)), holds: keys.filter((k) => k.tag === "hold").length, breakdowns: keys.filter((k) => k.tag === "breakdown").length, markers: markers(clip).length, impacts: keys.filter((k) => k.tag === "impact").length, notes, flags: { hasHold, hasBreak, hasMark } };
  }
  const fmtS = (v) => (Math.round(v * 1000) / 1000) + "s";
  function ikSolve(posesIn, effector, target, opts) {
    const E = EFFECTORS[effector]; if (!E || !target || target.length !== 3) return { poses: posesIn, distance: Infinity, reached: false, joints: [] };
    opts = opts || {}; const poses = clonePose(posesIn);
    const upper = E.chain[0][0], lower = E.chain[3][0], end = lower === "l_elbow" ? "l_wrist" : lower === "r_elbow" ? "r_wrist" : lower === "l_knee" ? "l_ankle" : "r_ankle", tip = E.tip;
    const leg = /hip$/.test(upper), side = upper.startsWith("l_") ? -1 : 1;
    const L1 = Math.hypot(...PIVOT[lower]), L2 = Math.hypot(...PIVOT[end]);
    for (const j of [upper, lower, end]) if (!poses[j]) poses[j] = J(0, 0, 0);
    const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const dist = () => { const pt = forwardKinematics(poses)[tip]; return Math.hypot(pt[0] - target[0], pt[1] - target[1], pt[2] - target[2]); };
    const Lu = LIMITS[upper], Ll = LIMITS[lower];
    const solveWith = (poleIn) => {
      const P = clonePose(poses);
      for (let it = 0; it < 3; it++) {
        const { pts, world } = fkFull(P);
        const S = pts[upper], Rp = world[PARENT[upper]].R, Rend = world[end].R;
        const tipOff = mulV(Rend, TIP[end] || [0, 0, 0]);
        const T = [target[0] - tipOff[0], target[1] - tipOff[1], target[2] - tipOff[2]];
        const d = mulV(transpose(Rp), [T[0] - S[0], T[1] - S[1], T[2] - S[2]]);
        const D = clamp(Math.hypot(d[0], d[1], d[2]), Math.abs(L1 - L2) + 0.02, L1 + L2 - 0.005);
        const cosPhi = clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1);
        let e = (180 - Math.acos(cosPhi) / DEG) * (leg ? -1 : 1); e = clamp(e, Ll.x[0], Ll.x[1]);
        const er = e * DEG; const alpha = Math.atan2(L2 * Math.sin(er), L1 + L2 * Math.cos(er)); // signed bend of the reach vector in the upper-limb Y-Z plane
        const dn = norm(d); const yAx = [-dn[0], -dn[1], -dn[2]];
        let pole = poleIn;
        let zAx = [pole[0] - dotv(pole, yAx) * yAx[0], pole[1] - dotv(pole, yAx) * yAx[1], pole[2] - dotv(pole, yAx) * yAx[2]];
        if (Math.hypot(zAx[0], zAx[1], zAx[2]) < 1e-3) { pole = [side, 0, 0]; zAx = [pole[0] - dotv(pole, yAx) * yAx[0], pole[1] - dotv(pole, yAx) * yAx[1], pole[2] - dotv(pole, yAx) * yAx[2]]; }
        zAx = norm(zAx); const xAx = cross(yAx, zAx);
        const Q = [[xAx[0], yAx[0], zAx[0]], [xAx[1], yAx[1], zAx[1]], [xAx[2], yAx[2], zAx[2]]];
        const eu = toEulerYXZ(mul(Q, rotX(-alpha)));
        P[upper] = Object.assign({}, P[upper], { rot: [clamp(eu[0], Lu.x[0], Lu.x[1]), clamp(eu[1], Lu.y[0], Lu.y[1]), clamp(eu[2], Lu.z[0], Lu.z[1])] });
        P[lower] = Object.assign({}, P[lower], { rot: [e, 0, 0] });
      }
      const pt = forwardKinematics(P)[tip];
      return { P, d: Math.hypot(pt[0] - target[0], pt[1] - target[1], pt[2] - target[2]) };
    };
    // natural pole first (elbows back/down/out, knees forward - the sign rides on alpha); other poles only if limits clamped it
    const poles = leg ? [[side * 0.15, -0.25, 1], [side * 0.6, 0, 1], [0, 1, 0.3], [side, 0, 0]] : [[side * 0.45, -0.55, 1], [side, -0.2, 0.3], [0, -1, 0.2], [-side * 0.5, 0.6, 1], [0, 1, 0]];
    let bestSolve = null;
    for (const pole of poles) { const r = solveWith(pole); if (!bestSolve || r.d < bestSolve.d) bestSolve = r; if (bestSolve.d < (opts.tolerance || 0.08) * 0.5) break; }
    for (const j of [upper, lower]) poses[j] = bestSolve.P[j];
    // polish: bounded coordinate descent from the analytic answer (helps when a limit clamped the exact solution)
    let best = dist(); const tol = opts.tolerance || 0.08;
    if (best > tol * 0.5) {
      const params = E.chain.map(([j, ax]) => ({ j, ax, L: LIMITS[j][["x", "y", "z"][ax]] })); let step = 12;
      for (let it = 0; it < (opts.iterations || 40) && best > tol * 0.25; it++) {
        let improved = false;
        for (const p of params) { const cur = poses[p.j].rot[p.ax]; for (const dir of [1, -1]) { const v = clamp(cur + dir * step, p.L[0], p.L[1]); if (v === cur) continue; poses[p.j].rot[p.ax] = v; const dd = dist(); if (dd < best - 1e-9) { best = dd; improved = true; break; } poses[p.j].rot[p.ax] = cur; } }
        if (!improved) { step *= 0.5; if (step < 0.05) break; }
      }
    }
    for (const j of [upper, lower]) poses[j].rot = poses[j].rot.map(r3);
    return { poses, distance: r3(best), reached: best < tol, joints: [upper, lower] };
  }
  // Foot planting (Blender floor constraint + foot IK, lite): on grounded poses the lowest foot sits on the ground (root shifted
  // down/up accordingly) and planted soles are flattened, which removes the "floating" contact warnings and most foot sliding.
  function groundFeet(clipIn, opts) {
    opts = opts || {}; const c = cloneClip(clipIn); const cat = (c.intent && c.intent.category) || ""; let n = 0, maxShift = 0, flat = 0;
    // auto mode plants only clips that stay on the ground by nature (runs have flight phases, combos spin and lunge) - the
    // Plant-feet action / "plant the feet" feedback forces it on anything.
    if (!opts.force && (!GROUND_AUTO.test(cat) || (c.intent && c.intent.upperOnly))) { c.grounded = false; return c; }
    for (const key of c.keys) {
      if (/^(apex|launch|fall)$/.test(key.tag || "")) continue;
      // 1) flatten the planted sole(s) - the lowest foot and any foot within 0.12 studs of it
      let pts = forwardKinematics(key.poses); let lf = pts.l_ankle_tip[1], rf = pts.r_ankle_tip[1], lo = Math.min(lf, rf);
      for (const side of ["l", "r"]) {
        const fy = side === "l" ? lf : rf; if (fy - lo > 0.12) continue;
        const hip = key.poses[side + "_hip"] || J(0, 0, 0), knee = key.poses[side + "_knee"] || J(0, 0, 0), ank = key.poses[side + "_ankle"] || J(0, 0, 0), rootR = key.poses.root || J(0, 0, 0);
        const want = clamp(-(hip.rot[0] + knee.rot[0] + rootR.rot[0]), LIMITS[side + "_ankle"].x[0], LIMITS[side + "_ankle"].x[1]);
        if (Math.abs(want - ank.rot[0]) > 0.5) { key.poses[side + "_ankle"] = { rot: [r3(want), ank.rot[1], ank.rot[2]] }; flat++; }
      }
      // 2) re-base the root so the lowest foot sits on the ground
      pts = forwardKinematics(key.poses); lf = pts.l_ankle_tip[1]; rf = pts.r_ankle_tip[1]; lo = Math.min(lf, rf);
      const root = key.poses.root || (key.poses.root = J(0, 0, 0)); const pos = root.pos ? root.pos.slice() : [0, 0, 0];
      if (Math.abs(lo) > 0.02) { const ny = clamp(pos[1] - lo, -2.2, 2.2); maxShift = Math.max(maxShift, Math.abs(ny - pos[1])); pos[1] = Math.round(ny * 10000) / 10000; root.pos = pos; n++; }
    }
    c.grounded = true;
    if (n || flat) { finish(c); noteFix(c, `planted feet: root re-based on ${n} key${n === 1 ? "" : "s"} (max ${r3(maxShift)} studs), ${flat} sole${flat === 1 ? "" : "s"} flattened`); c.report = validate(c); }
    return c;
  }
  function copyPose(clip, index, joints) { const k = clip.keys[index]; if (!k) return null; const p = clonePose(k.poses); if (Array.isArray(joints) && joints.length) for (const j of Object.keys(p)) if (!joints.includes(j)) delete p[j]; return p; }
  function pastePose(clipIn, index, pose, opts) {
    opts = opts || {}; const c = cloneClip(clipIn); const k = c.keys[index]; if (!k || !pose) return c;
    const PAIR = { l_shoulder: "r_shoulder", l_elbow: "r_elbow", l_wrist: "r_wrist", l_hip: "r_hip", l_knee: "r_knee", l_ankle: "r_ankle", r_shoulder: "l_shoulder", r_elbow: "l_elbow", r_wrist: "l_wrist", r_hip: "l_hip", r_knee: "l_knee", r_ankle: "l_ankle" };
    const src = opts.flipped ? mirrorPose(Object.assign(clonePose(k.poses), pose)) : pose;
    const joints = Object.keys(pose).filter((j) => JOINTS.includes(j)).map((j) => (opts.flipped ? PAIR[j] || j : j));
    for (const j of joints) if (src[j]) k.poses[j] = clonePose(src[j]);
    c.edited = true; c.report = validate(c); c.fingerprint = fingerprint(c); return c;
  }
  function compare(a, b) { // before/after summary
    const n = Math.min(a.keys.length, b.keys.length); let maxD = 0, joint = null;
    for (let i = 0; i < 40; i++) { const t = (i / 39) * Math.min(a.duration, b.duration); const pa = sampleAt(a, t), pb = sampleAt(b, t); for (const j of JOINTS) { const d = Math.max(...[0, 1, 2].map((x) => Math.abs((pa[j] || J(0, 0, 0)).rot[x] - (pb[j] || J(0, 0, 0)).rot[x]))); if (d > maxD) { maxD = d; joint = j; } } }
    return { keysBefore: a.keys.length, keysAfter: b.keys.length, durationBefore: a.duration, durationAfter: b.duration, scoreBefore: a.report && a.report.score, scoreAfter: b.report && b.report.score, largestChange: { joint, degrees: Math.round(maxD) }, sharedKeys: n };
  }
  function summary(clip) {
    const r = clip.report || validate(clip);
    const lines = [`${clip.name}: ${clip.duration}s, ${clip.keys.length} keys @ ${clip.fps} fps, ${clip.rigType}, ${clip.loop ? "looping" : "one-shot"}, priority ${clip.priority}, quality ${clip.quality}`];
    const i = clip.intent || {}; const what = i.category === "sequence" ? "sequence " + (clip.parts || []).map((p) => p.name).join(" → ") : i.category === "act" ? "act " + (i.acts || []).join(" + ") : i.category === "improv" ? "improvised (no known motion in the prompt)" : i.category === "gesture" ? "gesture " + ((i.gesture || {}).hits || []).join(", ") : clip.layered ? `${clip.layered.upper} layered over ${clip.layered.base}` : i.category;
    if (what) lines.push("understood: " + what + (i.mood ? ", mood " + i.mood : "") + (i.repeat > 1 ? ", ×" + i.repeat : "") + (i.style && i.style !== "default" ? ", style " + i.style : ""));
    if (clip.stages && clip.stages.length > 1) lines.push("stages: " + clip.stages.map((s) => `${s.name} ${s.t0}-${s.t1}s`).join(" · "));
    lines.push(`validation: ${r.ok ? "OK" : "ERRORS"} score ${r.score}/100 (${r.errors} errors, ${r.warnings} warnings)` + (clip.fixes && clip.fixes.length ? "; auto-fixes: " + clip.fixes.join("; ") : ""));
    const top = r.issues.filter((i) => i.level !== "info").slice(0, 6).map((i) => "- " + i.msg); if (top.length) lines.push(...top);
    if (clip.limitations && clip.limitations.length) lines.push("limitations: " + clip.limitations.join(" | "));
    return lines.join("\n");
  }

  const api = { VERSION, JOINTS, PARENT, PIVOT, LIMITS, QUALITY, R15_BONES, R6_BONES, R6_C0, foldForRig, PRIORITY_TOKEN, EASING_TOKEN, parseIntent, generate, generateSequence, generateSet, splitSet, compatibility, describeSet, stanceDistance, setPriority, validate, refine, applyFeedback, variation, toStudio, toBuildArgs, toRbxmx, defaultRigInfo, detectRigType, boneMap, sampleAt, forwardKinematics, fkFull, metrics, serializeProject, parseProject, retime, moveKey, setJoint, duplicateKey, deleteKey, smooth, smoothness, simplify, reverse, bake, cycleOffset, insertKey, breakdown, holdKey, nudgeKey, easeAll, EASE_PRESETS, overlap, LAG_JOINTS, setMarker, removeMarker, markers, arcs, ARC_TIPS, timing, layer, ikSolve, groundFeet, copyPose, pastePose, channels, mirrorPose, easeAlpha, exportKeys, robloxEase, setInterp, ACTS, MOODS, findActs, findMood, posePhrase, classGesture, expandVocabulary, vocabulary, inspire, THESAURUS, VERB_CLASSES, splitClauses, concatClips, applyMood, UPPER_JOINTS, LOWER_JOINTS, EFFECTORS, TIP, ROOT_HEIGHT, compare, summary, mirror, fingerprint, similarity, persona, choreograph, STRIKE_POOL, math: { eulerYXZ, toEulerYXZ, mul, transpose, mulV, flat, from9 } };
  root.TotalAnimEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
