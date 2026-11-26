#!/usr/bin/env node
// tests/test-work-modes-op.js — Verification suite for the 3.0 OP Work Modes rework:
//   1. Richer zero-turn preflight (topModels, guiNames, remoteNames, clipDetails, animSaves, Live Studio Profiler injection)
//   2. Upgraded auto-checks (Blender feedback-name extraction, deprecated Luau API detection, offset-only UI detection, 0-pose clips)
//   3. Target tracking & target-aware mode gate verification nudges (extractTarget, targetNote, gateVerifyPrompt)
//   4. Smart intent -> mode recommender (recommendMode) with zero false positives
//   5. OP Quick Missions (16 missions across all 4 modes) + main.js/overlay.css wiring
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const WM = require(path.join(ROOT, "src/core/work_modes.js"));
const main = read("src/core/main.js");
const css = read("overlay.css");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? " -> " + String(detail).slice(0, 260) : "")); }
}

// 1. Richer preflight Lua + brief + Live Studio Profiler injection
const pc = WM.preflight("creation", { engine: "roblox" });
const pa = WM.preflight("animate", { engine: "roblox" });
ok("1. creation preflight Lua captures topModels, guiNames, remoteNames, streaming in plain Lua 5.x",
  pc && /topModels/.test(pc.code) && /guiNames/.test(pc.code) && /remoteNames/.test(pc.code) && /StreamingEnabled/.test(pc.code) && !/\+=|\bcontinue\b/.test(pc.code));
ok("2. animate preflight Lua captures clipDetails and animSaves in plain Lua 5.x",
  pa && /clipDetails/.test(pa.code) && /animSaves/.test(pa.code) && !/\+=|\bcontinue\b/.test(pa.code));

const richCreation = WM.renderBrief("creation", {
  parts: 84, unanchored: 0, models: 4, scripts: 6, guis: 2, remotes: 3,
  lighting: { technology: "Future", clock: 15, atmosphere: true, bloom: true },
  topModels: ["SpawnLobby", "ShopBooth"], guiNames: ["HUD", "ShopGui"], remoteNames: ["BuyItem", "SyncCoins"],
  streaming: true, selection: [],
}, {
  perf: {
    mode: "play", health: "warn",
    latest: { fps: 31.4, lua_heap_mb: 148.2 },
    stats: { total_errors: 4 },
    alerts: [{ title: "High Heartbeat time" }],
  },
});
ok("3. creation renderBrief surfaces existing Models/GUIs/Remotes, Streaming, and Live Studio Profiler telemetry",
  /Existing: Models: SpawnLobby, ShopBooth · GUIs: HUD, ShopGui · Remotes: BuyItem, SyncCoins/.test(richCreation) &&
  /Streaming/.test(richCreation) &&
  /Live Studio Profiler \(play\): 31 FPS · LuaHeap 148\.2 MB · 4 runtime errors · alerts: High Heartbeat time/.test(richCreation) &&
  richCreation.length <= WM.BRIEF_MAX, richCreation);

const richAnim = WM.renderBrief("animate", {
  rigs: [{ path: "Workspace.Hero", rig: "R15", animator: true, motors: 15, hrp: true, animSaves: true }],
  clips: 2, clipNames: ["Idle", "Slash1"],
  clipDetails: [{ name: "Idle", kf: 4, len: 1.5, loop: true }, { name: "Slash1", kf: 5, len: 0.65, loop: false }],
  animations: 1, animPlayer: true, selection: [], playing: false,
});
ok("4. animate renderBrief surfaces AnimSaves + clip timing summaries",
  /AnimSaves/.test(richAnim) && /Clip timing: Idle \(4kf, 1\.50s, loop\); Slash1 \(5kf, 0\.65s\)/.test(richAnim), richAnim);

// 2. Upgraded auto-checks
const blFromFeedback = WM.autoCheck("blender", "execute_blender_code", { code: "pass" }, 'Output: {"ok":true,"asset":"DragonBlade"}');
ok("5. blender autoCheck extracts created asset name from feedback JSON when args.name is omitted",
  blFromFeedback && blFromFeedback.kind === "blender" && blFromFeedback.tool === "get_object_info" && blFromFeedback.args.name === "DragonBlade", JSON.stringify(blFromFeedback));

const rbLua = WM.readbackLua("ServerScriptService.Shop");
ok("6. readbackLua scans deprecated Luau APIs & offset-only UI in plain Lua 5.x",
  /deprecated/.test(rbLua) && /offsetOnly/.test(rbLua) && !/\+=|\bcontinue\b/.test(rbLua));

const acScriptDep = WM.renderAutoCheck({ kind: "luau", path: "ServerScriptService.Shop", mode: "creation" },
  JSON.stringify({ found: true, path: "ServerScriptService.Shop", class: "Script", parts: 0, anchored: 0, scripts: 0, sourceLen: 420, enabled: true, deprecated: 2 }));
ok("7. renderAutoCheck flags deprecated Luau APIs on scripts",
  /CHECK: 2 deprecated API\(s\)/.test(acScriptDep), acScriptDep);

const acGuiOffset = WM.renderAutoCheck({ kind: "luau", path: "StarterGui.HUD", mode: "creation" },
  JSON.stringify({ found: true, path: "StarterGui.HUD", class: "ScreenGui", parts: 0, anchored: 0, scripts: 0, guiObjects: 6, offsetOnly: 4 }));
ok("8. renderAutoCheck flags offset-only GuiObjects for mobile responsiveness",
  /CHECK: 4 offset-only GuiObject\(s\)/.test(acGuiOffset), acGuiOffset);

const acZeroPoses = WM.renderAutoCheck({ kind: "luau", path: "ReplicatedStorage.Clips.Empty", mode: "animate" },
  JSON.stringify({ found: true, path: "ReplicatedStorage.Clips.Empty", class: "KeyframeSequence", parts: 0, anchored: 0, scripts: 0, keyframes: 3, poses: 0, length: 0.8, loop: false }));
ok("9. renderAutoCheck flags multi-keyframe clips with 0 poses",
  /CHECK: 0 poses - rig will not deform/.test(acZeroPoses), acZeroPoses);

// 3. Target extraction + target-aware gate nudge + interactive gate prompts
ok("10. extractTarget resolves Studio paths, Blender assets, and Blockbench groups",
  WM.extractTarget("creation", "script_create", { parent: "ServerScriptService", name: "Economy" }, "ok") === "ServerScriptService.Economy" &&
  WM.extractTarget("blender", "blender_asset_build", {}, '{"asset":"FrostAxe"}') === "FrostAxe" &&
  WM.extractTarget("blockbench", "bb_cubes", { group: "Blade", cubes: [{ name: "Edge" }] }, "ok") === "Blade");

const tn = WM.targetNote("blender", ["asset", "import"], ["FrostAxe", "FrostAxe", "Workspace.FrostAxe"]);
ok("11. targetNote deduplicates targets and produces concrete batch guidance",
  /Touched targets \(asset, import\): FrostAxe, Workspace\.FrostAxe/.test(tn) && /ONE batch/.test(tn), tn);

const gvp = WM.gateVerifyPrompt("creation", "scripts", ["ServerScriptService.Shop"]);
ok("12. gateVerifyPrompt produces target-aware 1-click verification prompt",
  /ServerScriptService\.Shop/.test(gvp) && /script_read/.test(gvp) && /script_check/.test(gvp), gvp);

const stripHtml = WM.gateStripHtml("creation", [{ id: "scripts", label: "SCRIPTS", state: "pending" }, { id: "look", label: "LOOK", state: "proved" }]);
ok("13. gateStripHtml attaches data-gate and data-state attributes for click-to-verify",
  /data-gate="scripts"/.test(stripHtml) && /data-state="pending"/.test(stripHtml) && /click to draft proof command/.test(stripHtml), stripHtml);

// 4. Smart Intent -> Mode Recommender
const recBl = WM.recommendMode("Sculpt a high-poly dragon sword in Blender with bevel modifier, bake textures and cycles render", { currentMode: "creation", engine: "roblox", blenderConnected: false });
ok("14. recommendMode detects Blender intent from Totality and flags needsConnect when offline",
  recBl && recBl.mode === "blender" && recBl.needsConnect === true && recBl.score >= 5, JSON.stringify(recBl));

const recAn = WM.recommendMode("Build a 3-hit sword combo animation on R15 rig with walk cycle and AnimPlayer playback", { currentMode: "blender", engine: "roblox" });
ok("15. recommendMode detects Animator intent from Blender",
  recAn && recAn.mode === "animate", JSON.stringify(recAn));

const recBb = WM.recommendMode("Model a blocky voxel crate in Blockbench and export bbmodel for Import 3D", { currentMode: "creation", engine: "roblox", blockbenchConnected: true });
ok("16. recommendMode detects Blockbench intent from Totality",
  recBb && recBb.mode === "blockbench" && recBb.needsConnect === false, JSON.stringify(recBb));

const recCr = WM.recommendMode("Create a full DataStore currency shop system with leaderstats and ServerScriptService RemoteEvent validation", { currentMode: "blender", engine: "roblox" });
ok("17. recommendMode detects Totality intent when user is stuck in Blender mode",
  recCr && recCr.mode === "creation", JSON.stringify(recCr));

ok("18. recommendMode returns null on matching mode, local engine, or short ambiguous text (zero spam)",
  WM.recommendMode("Sculpt a sword in Blender", { currentMode: "blender", engine: "roblox" }) === null &&
  WM.recommendMode("Sculpt a sword in Blender", { currentMode: "creation", engine: "local" }) === null &&
  WM.recommendMode("fix this bug please", { currentMode: "creation", engine: "roblox" }) === null);

// 5. OP Quick Missions + main.js & overlay.css wiring
ok("19. QUICK_MISSIONS provides 4 curated OP missions for every mode (16 total)",
  WM.IDS.every((id) => Array.isArray(WM.QUICK_MISSIONS[id]) && WM.QUICK_MISSIONS[id].length === 4 && WM.QUICK_MISSIONS[id].every((m) => m.id && m.tag && m.label && m.desc && m.prompt.length > 80)));

ok("20. main.js wires #rs-mode-pop, #rs-mode-suggest, clickable #rs-work-badge, clickable #rs-mode-gates, A.modeTargets, live perf preflight & Alt+M",
  main.includes('modePopEl.id = "rs-mode-pop"') &&
  main.includes('modeSuggestEl.id = "rs-mode-suggest"') &&
  main.includes('const workBadgeBtn = root.querySelector("#rs-work-badge")') &&
  main.includes('const modeGatesEl = root.querySelector("#rs-mode-gates")') &&
  main.includes("A.modeTargets = []") &&
  main.includes("WM.renderBrief(mode, data, { perf })") &&
  main.includes("WM.recommendMode(text,") &&
  main.includes('e.code === "KeyM"'));

ok("21. overlay.css styles #rs-mode-pop and #rs-mode-suggest BEFORE the 2.12.0 cascade block",
  css.includes("#rs-mode-pop {") && css.includes("#rs-mode-suggest {") &&
  css.indexOf("#rs-mode-pop {") < css.indexOf("/* ═══ 2.12.0"));

console.log(`\ntest-work-modes-op: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
