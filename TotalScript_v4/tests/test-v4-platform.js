#!/usr/bin/env node
// tests/test-v4-platform.js — TotalScript 4.0.0 end-to-end platform verification
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const PlaytestBot = require(path.join(ROOT, "src/core/playtest_bot.js"));
const ArchGraph = require(path.join(ROOT, "src/core/architect_graph.js"));
const Crew = require(path.join(ROOT, "src/core/agent_crew.js"));

const manifest = JSON.parse(read("manifest.json"));
const cargo = read("agent/Cargo.toml");
const cargoLock = read("agent/Cargo.lock");
const mainRs = read("agent/src/main.rs");
const v4Rs = read("agent/src/v4_engine.rs");
const v4GuiRs = read("agent/src/gui/v4_suite.rs");
const guiRs = read("agent/src/gui.rs");
const bg = read("background.js");
const main = read("src/core/main.js");
const css = read("overlay.css");
const luaPlugin = read("plugin/TotalScript.lua");
const bbPlugin = read("plugin/TotalScript-Blockbench.js");
const figmaMcp = read("src/core/figma_mcp.js");
const readme = read("README.md");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? " -> " + String(detail).slice(0, 260) : "")); }
}

// ── 1. Autonomous Playtest Bot & Visual Regression ──────────────────────────
const botLua = PlaytestBot.buildBotLuau({ fuzzRemotes: true });
ok("1. TotalPlaytestBot generates plain Lua 5.x QA harness (UI sweep, RemoteEvent fuzz, world stability, JSONEncode)",
  PlaytestBot.VERSION === "4.0.0" &&
  /GuiButton/.test(botLua) && /FireServer/.test(botLua) && /ProximityPrompt/.test(botLua) &&
  /JSONEncode/.test(botLua) && !/\+=|\bcontinue\b/.test(botLua));

const vdPass = PlaytestBot.evaluateVisualDiff("aaa", "aaa", 1.2, 8.0);
const vdFail = PlaytestBot.evaluateVisualDiff("aaa", "bbb", 14.5, 8.0);
ok("2. TotalPlaytestBot.evaluateVisualDiff distinguishes pass vs visual regression",
  !vdPass.regressed && vdPass.status === "pass" && vdFail.regressed && vdFail.status === "regression");

const fixPrompt = PlaytestBot.buildFixPrompt({
  score: 58, passed: 2, failed: 2,
  checks: [{ name: "BuyItem fuzz", category: "remote_fuzz", passed: false, detail: "Accepted negative amount" }],
  errors: ["ServerScriptService.Shop:19: nil"],
}, { latest: { fps: 38.5 } });
ok("3. TotalPlaytestBot.buildFixPrompt includes failed checks, console errors & low FPS alert",
  /58\/100/.test(fixPrompt) && /BuyItem fuzz/.test(fixPrompt) && /ServerScriptService\.Shop:19/.test(fixPrompt) && /38\.5 FPS/.test(fixPrompt));

// ── 2. Live Two-Way Git & Rojo / Time-Machine Sync Studio ───────────────────
ok("4. Rust v4_engine exposes Time-Machine snapshots, unified diff, selective rollback, Rojo export & Git commit",
  v4Rs.includes("pub fn create_snapshot(") &&
  v4Rs.includes("pub fn diff_snapshot(") &&
  v4Rs.includes("pub fn rollback_snapshot(") &&
  v4Rs.includes("pub fn export_rojo_project(") &&
  v4Rs.includes("pub async fn git_status(") &&
  v4Rs.includes("pub async fn git_commit("));

ok("5. agent/src/main.rs mounts all /api/v4/* routes behind origin_guard",
  ["/api/v4/overview", "/api/v4/playtest/report", "/api/v4/sync/snapshot", "/api/v4/sync/diff", "/api/v4/sync/rollback", "/api/v4/sync/rojo/export", "/api/v4/sync/git/commit", "/api/v4/squad/launch", "/api/v4/architect/graph", "/api/v4/vault/list", "/api/v4/vault/save"].every((r) => mainRs.includes(r)));

// ── 3. True Parallel Multi-Agent Studio Squad ───────────────────────────────
const sq = Crew.squadPlan("Build a medieval RPG lobby with a Blender sword and 3-hit combat animation");
ok("6. TotalAgentCrew.squadPlan auto-decomposes multi-discipline builds across Blender, Luau, UI/VFX, Animator & QA",
  Array.isArray(Crew.SQUAD_ROLES) && Crew.SQUAD_ROLES.length === 5 &&
  sq.workers.some((w) => w.id === "blender") &&
  sq.workers.some((w) => w.id === "animator") &&
  sq.workers.some((w) => w.id === "luau") &&
  sq.workers.some((w) => w.id === "qa_bot") &&
  /STUDIO SQUAD MISSION/.test(sq.prompt));

// ── 4. Visual Node / Game-Flow Architect & 3D Telemetry Heatmap ─────────────
const scanLua = ArchGraph.scanGraphLuau();
const heatOn = ArchGraph.heatmapLuau();
const heatOff = ArchGraph.clearHeatmapLuau();
ok("7. TotalArchitectGraph generates plain Lua 5.x topology scanner + 3D Highlight heatmap scripts",
  ArchGraph.VERSION === "4.0.0" &&
  /RemoteEvent/.test(scanLua) && /GetDataStore/.test(scanLua) && /ScreenGui/.test(scanLua) &&
  /_TotalHeatmapHighlight/.test(heatOn) && /_TotalHeatmapHighlight/.test(heatOff) &&
  ![scanLua, heatOn, heatOff].some((c) => /\+=|\bcontinue\b/.test(c)));

const svg = ArchGraph.renderSvg({
  nodes: [
    { id: "ui1", label: "ShopGui", kind: "ui", path: "StarterGui.ShopGui", risk: "amber", heat: 42, issue: "1 dead button" },
    { id: "rem1", label: "BuyItem", kind: "remote", path: "ReplicatedStorage.BuyItem", risk: "red", heat: 78, issue: "Unvalidated" },
  ],
  edges: [{ from: "ui1", to: "rem1", kind: "remote" }],
});
ok("8. TotalArchitectGraph.renderSvg outputs clickable SVG nodes with Bezier edges and risk colors",
  svg.startsWith("<svg") && svg.includes('data-arch-node="StarterGui.ShopGui"') && svg.includes("#f87171") && svg.includes("<path d="));

// ── 5. AI Asset Vault + Extension Hub + Desktop Suite UI ────────────────────
ok("9. background.js bridges v4_api safely to /api/v4/* with traversal guard & 10s AbortController timeout",
  bg.includes('case "v4_api":') && bg.includes('/^\\/api\\/v4\\/[a-z0-9/_-]+') && bg.includes('ep.includes("..")') && bg.includes("new AbortController()"));

const tallSvg = ArchGraph.renderSvg({
  nodes: Array.from({ length: 7 }, (_, i) => ({ id: "s" + i, label: "Script" + i, kind: "script", path: "ServerScriptService.Script" + i, risk: "green", heat: 10 })),
  edges: [],
}, { width: 700, height: 205 });
ok("9b. TotalArchitectGraph.renderSvg grows height dynamically so >4 nodes in one column never overlap",
  /viewBox="0 0 700 346"/.test(tallSvg) && v4Rs.includes("fn validate_snapshot_id(") && main.includes("renderV4VaultGridHtml()"));

ok("10. main.js + overlay.css wire #rs-v4-btn, 5-tab #rs-v4-hub, @Vault chip & Alt+4 shortcut before 2.12.0 CSS block",
  main.includes('id="rs-v4-btn"') &&
  main.includes('v4El.id = "rs-v4-hub"') &&
  main.includes('data-ctx-chip="vault"') &&
  main.includes('e.code === "Digit4"') &&
  css.includes("#rs-v4-hub {") &&
  css.indexOf("#rs-v4-hub {") < css.indexOf("/* ═══ 2.12.0"));

ok("11. Desktop GUI wires TotalScript 4.0 Studio Suite overlay (5 tabs + 2D Architect canvas + Asset Vault)",
  guiRs.includes("mod v4_suite;") && guiRs.includes('"4.0 Suite"') && guiRs.includes("self.draw_v4_suite(ctx);") &&
  v4GuiRs.includes("v4_tab_playtest") && v4GuiRs.includes("v4_tab_sync") && v4GuiRs.includes("v4_tab_squad") && v4GuiRs.includes("v4_tab_architect") && v4GuiRs.includes("v4_tab_vault"));

// ── 6. Version 4.0.0 Alignment & Bundles ────────────────────────────────────
const mainBundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
ok("12. manifest.json loads playtest_bot.js & architect_graph.js in every main.js bundle",
  mainBundles.length >= 10 && mainBundles.every((c) => c.js.includes("src/core/playtest_bot.js") && c.js.includes("src/core/architect_graph.js")));

ok("13. Version 4.0.0 aligned across manifest, Cargo.toml, Cargo.lock, Studio plugin, Blockbench plugin, Figma MCP, README & built total-core.exe",
  manifest.version === "4.0.0" &&
  /^version = "4\.0\.0"/m.test(cargo) &&
  /name = "total-agent"\r?\nversion = "4\.0\.0"/.test(cargoLock) &&
  luaPlugin.includes('local VERSION = "4.0.0"') &&
  bbPlugin.includes('const VERSION = "4.0.0";') &&
  figmaMcp.includes('return "4.0.0";') &&
  readme.includes("Current source version: 4.0.0") &&
  fs.existsSync(path.join(ROOT, "bin/total-core.exe")));

console.log(`\ntest-v4-platform: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
