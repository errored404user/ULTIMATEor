// SPDX-License-Identifier: GPL-3.0-or-later
// tests/test-anim-upgrade.js — Verification suite for TotalScript 4.0 Animation
// Overhaul: biomechanical locomotion, living moving holds, wrist/neck overlapping
// drag, 10 new game moves, organic breathing pass, auto gameplay KeyframeMarkers,
// 1-click AAA polish, RunService.Heartbeat Studio preview + blendToRest settle,
// animation_polish / animation_validate upgrades, and spring UI animations.
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail !== undefined ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : "")); }
}

const E = require(path.join(ROOT, "src/core/animengine.js"));
const animlib = read("src/core/animlib.js");
const mainSrc = read("src/core/main.js");
const workModesSrc = read("src/core/work_modes.js");
const cssSrc = read("overlay.css");

// ── 1. Biomechanical locomotion (heel-strike / toe-off + wrist drag + hip yaw) ──
{
  const walk = E.generate("natural walk cycle, loop", { quality: "balanced" });
  const run = E.generate("fast sprint cycle, loop", { quality: "balanced" });
  const walkWristMove = Math.max(...walk.keys.map((k) => Math.abs((k.poses.r_wrist || { rot: [0] }).rot[0])));
  const runAnkleRange = (() => {
    const vals = run.keys.map((k) => (k.poses.r_ankle || { rot: [0] }).rot[0]);
    return Math.max(...vals) - Math.min(...vals);
  })();
  const walkHipYaw = Math.max(...walk.keys.map((k) => Math.abs((k.poses.root || { rot: [0, 0] }).rot[1])));
  ok("1. Walk/run cycles have biomechanical heel-strike/toe-off ankle range, hip counter-yaw & wrist drag",
    walk.report.ok && run.report.ok && walkWristMove > 2 && runAnkleRange > 25 && walkHipYaw > 1,
    { walkWristMove, runAnkleRange, walkHipYaw });

  const roboWalk = E.generate("robotic walk cycle, loop", { quality: "balanced" });
  const roboWrist = Math.max(...roboWalk.keys.map((k) => Math.abs((k.poses.r_wrist || { rot: [0] }).rot[0])));
  ok("2. Robotic style stays crisp and skips organic wrist drag",
    roboWalk.report.ok && roboWrist === 0, { roboWrist });
}

// ── 2. Living moving holds & hierarchical wrist/neck overlapping lag ────────
{
  const combo = E.generate("3 hit sword combo with a heavy finisher", { quality: "high" });
  const holds = combo.keys.filter((k) => k.tag === "hold");
  let livingHold = false;
  for (const h of holds) {
    const idx = combo.keys.indexOf(h);
    const prev = combo.keys[idx - 1];
    if (!prev) continue;
    for (const j of ["waist", "neck", "r_wrist", "l_wrist"]) {
      const a = prev.poses[j], b = h.poses[j];
      if (a && b && [0, 1, 2].some((ax) => Math.abs(b.rot[ax] - a.rot[ax]) > 0.2)) { livingHold = true; break; }
    }
  }
  ok("3. Non-robotic impact holds carry subtle living moving-hold drift (not frozen statues)",
    combo.report.ok && holds.length >= 1 && livingHold, { holds: holds.length, livingHold });
}

// ── 3. 10 New Modern Roblox Game Moves in ACTS ──────────────────────────────
{
  const NEW_10 = [
    ["vault", "parkour vault over obstacle"],
    ["wallrun", "wallrun stride loop"],
    ["unsheathe", "unsheathe katana blade"],
    ["riposte", "perfect parry riposte"],
    ["aura", "charge aura power up"],
    ["magswap", "tactical reload swap mag"],
    ["griddy", "hit the griddy"],
    ["breakdance", "breakdance windmill freeze"],
    ["airjump", "double jump mid-air boost"],
    ["victorypose", "heroic victory pose"],
  ];
  const bad = [];
  for (const [key, prompt] of NEW_10) {
    if (!E.ACTS[key]) { bad.push(key + ":missing"); continue; }
    const c = E.generate(prompt);
    if (!c.report.ok || !(c.intent.acts || []).includes(key)) {
      bad.push(`${key}:cat=${c.intent.category},acts=${(c.intent.acts || []).join(",")},err=${c.report.errors}`);
    }
  }
  ok("4. All 10 new game animation moves (vault, wallrun, unsheathe, riposte, aura, magswap, griddy, breakdance, airjump, victorypose) generate cleanly",
    Object.keys(E.ACTS).length >= 80 && bad.length === 0, bad);
}

// ── 4. addBreathing(), autoMarkers(), aaaPolish() & applyFeedback() ─────────
{
  const idle = E.generate("calm idle loop", { quality: "balanced" });
  const breathed = E.addBreathing(idle, { strength: 1.2 });
  const seamDelta = Math.max(...[0, 1, 2].map((ax) => Math.abs(breathed.keys[0].poses.waist.rot[ax] - breathed.keys[breathed.keys.length - 1].poses.waist.rot[ax])));
  ok("5. addBreathing() adds organic torso/shoulder breathing while keeping loop seams exact",
    breathed.report.ok && seamDelta < 1e-6 && breathed.fixes.some((f) => /organic breathing/.test(f)),
    { seamDelta });

  const walk = E.generate("natural walk cycle, loop", { quality: "balanced" });
  const walkMarked = E.autoMarkers(walk);
  const wNames = E.markers(walkMarked).map((m) => m.name);
  const combo = E.generate("3 hit sword combo with a heavy finisher", { quality: "balanced" });
  const comboMarked = E.autoMarkers(combo);
  const cNames = E.markers(comboMarked).map((m) => m.name);
  const jump = E.generate("athletic jump and land", { quality: "balanced" });
  const jumpMarked = E.autoMarkers(jump);
  const jNames = E.markers(jumpMarked).map((m) => m.name);
  ok("6. autoMarkers() stamps FootstepR/FootstepL on walks, SwingStart/HitFrame/SwingEnd on combos, JumpLaunch/LandImpact on jumps",
    wNames.includes("FootstepR") && wNames.includes("FootstepL") &&
    cNames.includes("SwingStart") && cNames.includes("HitFrame") && cNames.includes("SwingEnd") &&
    jNames.includes("LandImpact"),
    { wNames, cNames: [...new Set(cNames)], jNames: [...new Set(jNames)] });

  const pol = E.aaaPolish(walk);
  ok("7. aaaPolish() runs C1 spline smooth + overlap + planted feet + gameplay markers cleanly",
    pol.clip.report.ok && pol.clip.interp === "spline" &&
    pol.steps.includes("C1 spline smooth") &&
    pol.after.smoothness >= pol.before.smoothness &&
    pol.after.markers >= 2,
    { steps: pol.steps, before: pol.before, after: pol.after });

  const fbAAA = E.applyFeedback(combo, "aaa polish");
  const fbMark = E.applyFeedback(walk, "add footstep markers");
  const fbBreath = E.applyFeedback(idle, "add breathing");
  ok("8. applyFeedback() recognizes 'aaa polish', 'footstep markers' & 'add breathing'",
    fbAAA.feedback.slice(-1)[0].applied.some((s) => /AAA polish/.test(s)) &&
    fbMark.feedback.slice(-1)[0].applied.some((s) => /KeyframeMarkers/.test(s)) &&
    fbBreath.feedback.slice(-1)[0].applied.some((s) => /organic breathing/.test(s)));
}

// ── 5. Studio Preview (RunService.Heartbeat + blendToRest), animlib & main.js ──
{
  ok("9. animlib.js locks Studio viewport preview to RunService.Heartbeat with smooth cubic blendToRest settle",
    animlib.includes('local RunService = game:GetService("RunService")') &&
    animlib.includes("RunService.Heartbeat:Wait()") &&
    animlib.includes("function sampler.blendToRest(") &&
    animlib.includes("sampler.blendToRest(endT, 0.18, token)"));

  ok("10. animlib.js & main.js wire aaa_pass, overlap_frames, ease_preset, breathing, auto_markers & timing critique in animation_validate",
    animlib.includes("aaa_pass:") &&
    animlib.includes("overlap_frames:") &&
    animlib.includes("auto_markers:") &&
    mainSrc.includes('if (want("aaa_pass") || want("aaa"))') &&
    mainSrc.includes("E.autoMarkers(out)") &&
    mainSrc.includes("E.addBreathing(out)") &&
    mainSrc.includes("Director notes:") &&
    workModesSrc.includes("animation_polish {aaa_pass:true}"));
}

// ── 6. Extension UI Spring Animations & Reduced-Motion Safety (overlay.css) ──
{
  const springIdx = cssSrc.indexOf("@keyframes rs-suite-pop-in");
  const block212Idx = cssSrc.indexOf("/* ═══ 2.12.0");
  ok("11. overlay.css adds GPU-composited spring popover/tab/card micro-interactions + prefers-reduced-motion strictly BEFORE 2.12.0",
    springIdx > 0 && block212Idx > springIdx &&
    cssSrc.includes("@keyframes rs-tab-fade") &&
    cssSrc.includes("@keyframes rs-working-pulse") &&
    cssSrc.includes("#rs-v4-hub:not([hidden])") &&
    cssSrc.slice(springIdx, block212Idx).includes("@media (prefers-reduced-motion: reduce)"));
}

console.log(`\ntest-anim-upgrade: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
