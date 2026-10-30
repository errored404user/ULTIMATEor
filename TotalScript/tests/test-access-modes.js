#!/usr/bin/env node
// tests/test-access-modes.js — 1.99.5 "change how access works: Full PC or Sandbox only".
//
//   Access is ONE switch with TWO states everywhere it is shown:
//     sandbox  Studio + the workspace folder; the PC-leaving commands
//              (FULL_PC_OPS) are refused with ERROR ACCESS_SANDBOX - no prompt
//     full     those commands run; total-core's FULL PC ACCESS is pushed ON
//   The 1.42.0 "ask" state (confirm every write) is gone; a stored "ask" reads
//   as sandbox in main.js and popup.js. The Session panel's Danger-zone toggle
//   is the same switch. Publishing keeps its own confirmation.
//   The behavioural walk (refusal, banner action, Full PC run, rs-set-full
//   pushes) lives in tests/test-creation-mode.js C3-C7 + walk D.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; process.exitCode = 1; console.log("FAIL  " + name + (extra != null ? "  — " + String(extra).slice(0, 300) : "")); } };

const main = read("src/core/main.js"), popup = read("popup.js"), popupHtml = read("popup.html"), css = read("overlay.css"), readme = read("README.md");
const chat = read("agent/src/chat.rs"), gui = read("agent/src/gui.rs");

// ── A. main.js: the gate ───────────────────────────────────────────────────
ok("A1 ACCESS_MODES = sandbox + full; normalizeAccess folds anything else to sandbox", main.includes('const ACCESS_MODES = ["sandbox", "full"];') && main.includes('const normalizeAccess = (id) => (ACCESS_MODES.includes(id) ? id : "sandbox");'));
ok("A2 FULL_PC_OPS is exactly the eight PC-leaving commands", /const FULL_PC_OPS = new Set\(\[\s*"run_command","process_kill","delete_path","move_path","download_file","open_path",\s*"execute_blender_code","blender_export_fbx",\s*\]\);/.test(main));
ok("A3 accessAllows: full || not PC-leaving; exported for harnesses with the op list", main.includes('const accessAllows = (bareName, mode) => normalizeAccess(mode) === "full" || !FULL_PC_OPS.has(bareName);') && main.includes("window.__rsAccessAllows = accessAllows; window.__rsFullPcOps = () => [...FULL_PC_OPS];"));
ok("A4 the gate runs before the publish check and before any bridge call, refuses with ERROR ACCESS_SANDBOX, tells the model not to retry or work around it", (() => { const i = main.indexOf("if (!accessAllows(bareName, permMode)) {"); const j = main.indexOf("if (!internalCall && PUBLISH_OPS.has(bareName)"); return i > 0 && j > i && /ERROR ACCESS_SANDBOX in \$\{bareName\}: Access is "Sandbox only" \(Studio \+ workspace\), and this command leaves the sandbox, so it did NOT run and nothing changed\. Do not retry it and do not work around it with another command\./.test(main); })());
ok("A5 the refusal shows the user a banner with a one-click 'Switch to Full PC' action (goes through setPermMode)", /ui\.banner\("warn", "Blocked by Sandbox access", `'\$\{bareName\}' leaves the Studio \+ workspace sandbox, so it did not run\. Switch Access to Full PC if you want the AI to do this\.`, \{ label: "Switch to Full PC", onClick: \(\) => \{ setPermMode\("full"\);/.test(main) && main.includes('diag("access.blocked", { name: bareName, mode: permMode })'));
ok("A6 no Ask state survives: no needsConfirmation / ASK_OPS / CONFIRM_ALWAYS_OPS.has / 'Ask mode' / data-perm=ask / three-value lists", !/needsConfirmation|ASK_OPS|CONFIRM_ALWAYS_OPS\.has|Ask mode|data-perm="ask"|\["sandbox", ?"ask", ?"full"\]/.test(main));
ok("A7 load, setPermMode and the storage listener all normalise through the two-state list", main.includes('if (r && typeof r.rsPermMode === "string") permMode = normalizeAccess(r.rsPermMode);') && main.includes("if (!ACCESS_MODES.includes(id)) return;") && main.includes("permMode = normalizeAccess(changes.rsPermMode.newValue);"));
ok("A8 setPermMode persists and pushes rs-set-full to total-core (Full PC there = FULL PC ACCESS in the agent)", /function setPermMode\(id\) \{\s*if \(!ACCESS_MODES\.includes\(id\)\) return;\s*permMode = id;\s*try \{ window\.__rsPermMode = \(\) => permMode; \} catch \{\}\s*try \{ chrome\.storage\.local\.set\(\{ rsPermMode: id \}\); \} catch \{\}\s*try \{ chrome\.runtime\.sendMessage\(\{ type: "rs-set-full", enabled: id === "full" \}\)/.test(main) && main.includes("window.__rsSetPermMode = (id) => setPermMode(id);"));
ok("A9 the approval modal is only ever a publish / template confirmation now (never gated by the access mode) and a missing modal fails CLOSED", (() => { const calls = [...main.matchAll(/await requestApproval\(([^\n]{0,160})/g)].map((m) => m[1]); return calls.length === 4 && calls.every((c) => /publish|warning:|Run template/i.test(c)) && !/requestApproval\([^\n]*permMode/.test(main) && main.includes("if (!root || !allow || !deny) { resolve(false); return; }") && main.includes('<div class="rs-approve-kicker">Confirm</div>'); })());
ok("A10 Danger-zone toggle = the same switch (setPermMode), copy says so", main.includes('setPermMode(want ? "full" : "sandbox");') && main.includes("Same switch as Settings \\u2192 Access.") && main.includes('<b>FULL PC</b>'));
ok("A11 Settings tray: two cards in .rs-access-row with honest copy, toast says Access: …", main.includes('<div class="rs-work-row rs-access-row">') && main.includes('<span class="rs-work-name">Sandbox only</span><span class="rs-work-sub">Studio + workspace; PC commands refused</span>') && main.includes('<span class="rs-work-name">Full PC</span><span class="rs-work-sub">Files, shell, processes, Blender - no prompts</span>') && main.includes('const label = permMode === "full" ? "Full PC" : "Sandbox only (Studio + workspace)";') && main.includes('toast("Access: " + label)'));
ok("A12 help topic describes the two states, the refusal, the shared switch and the removed Ask state", /permissions:\{title:"Access: Sandbox only \/ Full PC"/.test(main) && main.includes("refused with ERROR ACCESS_SANDBOX - no approval card") && main.includes("one switch in two places") && main.includes("The old Ask state (confirm every write) was removed; a stored 'ask' reads as Sandbox only."));
ok("A13 SYSTEM_STATE still reports PERM=<mode> (values are now sandbox | full)", main.includes("PERM=${perm}"));

// ── B. the gate in isolation (real source, vm) ─────────────────────────────
{
  const slice = (a, b) => { const i = main.indexOf(a), j = main.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor missing: " + a); return main.slice(i, j); };
  const src = slice("  const ACCESS_MODES = [", "  let permMode = ") + slice("  const FULL_PC_OPS = new Set([", "  const PUBLISH_OPS=");
  const c = { window: {} }; vm.createContext(c);
  vm.runInContext(src + "\nthis.accessAllows=accessAllows;this.normalizeAccess=normalizeAccess;this.FULL_PC_OPS=FULL_PC_OPS;", c);
  ok("B1 sandbox refuses every FULL_PC_OPS entry and allows Studio / workspace / network tools", [...c.FULL_PC_OPS].every((n) => !c.accessAllows(n, "sandbox")) && ["execute_luau", "write_file", "multi_edit", "script_create", "web_fetch", "api_request", "blender_send_to_studio", "blender_asset_build", "get_scene_info", "mesh_import_verify"].every((n) => c.accessAllows(n, "sandbox")));
  ok("B2 full allows everything; undefined / 'ask' / garbage behave as sandbox", [...c.FULL_PC_OPS].every((n) => c.accessAllows(n, "full")) && !c.accessAllows("run_command", "ask") && !c.accessAllows("run_command", undefined) && !c.accessAllows("run_command", "FULL") && c.normalizeAccess("ask") === "sandbox" && c.normalizeAccess("full") === "full");
}

// ── C. popup ───────────────────────────────────────────────────────────────
ok("C1 popup.js: PERM_MODES = sandbox + full; stored / changed 'ask' reads as sandbox", popup.includes('const PERM_MODES = ["sandbox", "full"];') && popup.includes('if (typeof r.rsPermMode === "string") settings.permMode = PERM_MODES.includes(r.rsPermMode) ? r.rsPermMode : "sandbox";') && popup.includes('settings.permMode = PERM_MODES.includes(changes.rsPermMode.newValue) ? changes.rsPermMode.newValue : "sandbox";') && popup.includes('permMode: "sandbox"'));
ok("C2 popup.js setPermMode still pushes rs-set-full", /async function setPermMode\(id\) \{\s*if \(!PERM_MODES\.includes\(id\)\) return;[\s\S]*?rs-set-full", enabled: id === "full"/.test(popup));
ok("C3 popup.html: two Access cards (Sandbox only / Full PC) in a two-column row, no Ask card", popupHtml.includes('<div class="work work-access">') && popupHtml.includes('data-perm="sandbox" id="perm-sandbox"') && popupHtml.includes('data-perm="full" id="perm-full"') && !popupHtml.includes('perm-ask') && (popupHtml.match(/class="work-card" data-perm="/g) || []).length === 2 && popupHtml.includes(".work.work-access{grid-template-columns:1fr 1fr}") && popupHtml.includes('<span class="work-name">Sandbox only</span>') && popupHtml.includes('<span class="work-name">Full PC</span>'));
ok("C4 overlay.css: the tray access row is two columns", css.includes(".rs-work-row.rs-access-row{grid-template-columns:1fr 1fr}"));

// ── D. desktop app strings + README ────────────────────────────────────────
ok("D1 agent (Rust) no longer describes an Ask access state", !/Sandbox \/ Ask \/ Full|Sandbox and\s*\/\/\/ Ask access modes/.test(chat + gui) && gui.includes("Access switch (Sandbox only / Full PC)"));
ok("D2 README documents the change (1.99.5) and the migration of 'ask'", /1\.99\.5/.test(readme) && /Sandbox only/.test(readme) && /Full PC/.test(readme) && /ACCESS_SANDBOX/.test(readme) && /stored .ask./i.test(readme));

console.log(`\n${pass} passed, ${fail} failed`);
