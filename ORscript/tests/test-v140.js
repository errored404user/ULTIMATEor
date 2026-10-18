#!/usr/bin/env node
// 1.40.0 — Beginner mode.
//   * The getting-started card on the bar is a LIVE 4-step checklist (agent
//     app → Studio linked → place open → press Start) with one-click fixes and
//     three starter requests once everything is green.
//   * Settings opens in a SIMPLE view; "Show advanced settings" reveals the
//     power-user rows (persisted in chrome.storage rsSettingsAdvanced).
//   * Plain-language tutorial, a `beginner` help topic the AI can quote, and
//     the popup's hint row is the same live checklist.
//   * Version pins 1.40.0 everywhere.
// Behavioural coverage (card ticks, starters paste, simple/advanced flip,
// Help → checklist) lives in tests/notion-e2e.js (default + TASKS=1 runs).
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failed++;
}

const main = read("src/core/main.js");
const css = read("overlay.css");
const popupHtml = read("popup.html");
const popupJs = read("popup.js");
const readme = read("README.md");
const manifest = JSON.parse(read("manifest.json"));

// ── A. Live checklist on the bar ───────────────────────────────────────────
ok("setup card keeps the pinned ids (test-v115 / test-layout contracts)",
  main.includes('setupCard.id = "rs-setup"') && main.includes('id="rs-setup-tutorial"') && main.includes("bar.appendChild(setupCard)") && main.includes('id="rs-setup-close"'));
ok("setupSteps() computes four live steps from bridge / Studio / place / started state",
  /function setupSteps\(\)/.test(main) && ['id: "bridge"', 'id: "studio"', 'id: "place"', 'id: "start"'].every((t) => main.includes(t)) && /const started = !!A\.started;/.test(main) && /A\.bridge\.connected/.test(main) && /id: "start", ok: started/.test(main));
ok("renderSetup paints ok / now / wait pips, hints, a state label and a progress counter",
  main.includes('<li class="rs-step-${state}" data-step="${st.id}">') && /const state = st\.ok \? "ok" : \([^)]*\? "now" : "wait"\)/.test(main) && ["rs-step-pip", "rs-step-hint", "rs-step-state", "rs-setup-progress"].every((t) => main.includes(t)) && main.includes("setText(prog, `${done}/${steps.length}`)") && /if \(mutated\) \{ try \{ kickPlaceBar\(\); \} catch \{\} \}/.test(main));
ok("one-click fixes: retry bridge, repair Studio link, press Start",
  main.includes('data-setup-fix="retry"') || /data-setup-fix="\$\{/.test(main)) ;
ok("fix handlers route to reconnect / restart_mcp / #rs-action",
  main.includes('if (fix === "retry") { try { bg({ type: "reconnect" }); }') && main.includes('else if (fix === "repair") { try { bg({ type: "restart_mcp" }); }') && main.includes('else if (fix === "start") {') && /fix === "start"[^\n]*#rs-action/.test(main));
ok("three starter requests paste through pasteLibraryCard and dismiss the card",
  /const SETUP_STARTERS\s*=\s*\[/.test(main) && (main.match(/\{\s*title:\s*"[^"]+",\s*prompt:\s*"[^"]*lobby/i) || main.match(/Build a small lobby/)) && /data-setup-starter[\s\S]{0,500}pasteLibraryCard\(/.test(main) && /rs-setup-starters-label/.test(main));
ok("card auto-marks itself seen only after everything is green (no more 'seen on first connect')",
  !/rsSetupSeen:\s*true[\s\S]{0,200}first bridge connect/i.test(main) && /setupReadyAt/.test(main) && /rs-setup-ready/.test(main));
ok("Help → Getting-started checklist reopens the card on demand",
  main.includes('id="rs-menu-setup"') && /function openSetupChecklist\(\)/.test(main) && /__rsOpenSetup/.test(main) && /#rs-menu-setup[\s\S]{0,300}openSetupChecklist\(\)/.test(main));
ok("setStatus and setStarted both refresh the checklist",
  /renderBar\(\);\s*if \(!bridgeBannerEl\) refreshSetup\(\); else hideSetup\(\);/.test(main) && /function setStarted\(\)[^\n]*refreshSetup\(\)/.test(main));

// ── B. Simple / advanced Settings ──────────────────────────────────────────
ok("settingsAdvanced flag persists in chrome.storage (rsSettingsAdvanced)",
  /let settingsAdvanced = false/.test(main) && /chrome\.storage\.local\.get\("rsSettingsAdvanced"/.test(main) && /function setSettingsAdvanced\(on\)/.test(main) && /rsSettingsAdvanced:\s*settingsAdvanced/.test(main));
ok("Settings tray carries rs-menu-simple until the switch is on",
  main.includes('menuEl.classList.toggle("rs-menu-simple", !settingsAdvanced)') && main.includes('data-mode="advanced"') && /m==="advanced"[^\n]*setSettingsAdvanced\(!settingsAdvanced\)/.test(main));
const advRows = (main.match(/class="rs-tgl-row[^"]* rs-adv"/g) || []).length;
const advSecs = (main.match(/class="rs-menu-sec[^"]*\brs-adv\b/g) || []).length;
ok("advanced rows (auto-fix stop, auto-debug, multi-agent, task list) + keybind / custom prompt / MCP sections are tagged .rs-adv",
  advRows >= 4 && advSecs >= 3 && ["autofixstop", "autodebug", "multiagent", "tasklist"].every((m) => new RegExp(`class="rs-tgl-row[^"]* rs-adv" data-mode="${m}"`).test(main)), `rows=${advRows} secs=${advSecs}`);
ok("overlay.css hides .rs-adv inside the simple view and styles the live checklist",
  css.includes("#rs-menu.rs-menu-simple .rs-adv { display: none !important; }") && css.includes("1.40.0 Beginner mode") && [".rs-step-ok .rs-step-pip", ".rs-step-now .rs-step-pip", ".rs-setup-fix", ".rs-setup-starter", "#rs-setup-progress"].every((s) => css.includes(s)));
ok("overlay.css keeps the earlier setup-card layers intact",
  css.includes("/* setup card 1.17.19 */") && css.includes("#rs-bar.rs-setup-open #rs-setup") && css.includes("html[data-rs-theme] #rs-setup::after"));

// ── C. Plain-language tutorial + help topic ────────────────────────────────
const tut = main.slice(main.indexOf("const TUTORIAL_HTML = `"), main.indexOf("function buildTutorial()"));
ok("tutorial is the 4-step beginner walkthrough",
  ["<h3>1 · Run the agent app</h3>", "<h3>2 · Link Roblox Studio</h3>", "<h3>3 · Open a place</h3>", "<h3>4 · Press Start Agent</h3>", "<h3>What to say</h3>", "<h3>If something is red</h3>"].every((h) => tut.includes(h)) && /Manage MCP Servers/.test(tut) && /\$\{RUN_CMD\}/.test(tut));
ok("tutorial speaks plain words (no registry / catalogue jargon in headings)",
  !/<h3>[^<]*(registry|catalogue|JSON|MCP)[^<]*<\/h3>/i.test(tut) && /no code is needed|never have to write code/i.test(tut));
ok("FEATURE_HELP_TOPICS has a beginner topic the AI can quote and orscript_help routes 'getting started' to it",
  /beginner:\{title:"Getting started \(beginner guide\)"/.test(main) && /beginner:\/beginner\|get\(ting\)\? started\|getting-started/.test(main));

// ── D. Popup checklist ─────────────────────────────────────────────────────
ok("popup hint row is a live 4-step checklist with the load-bearing ids kept",
  ["hint-row", "run-hint", "hint-engine", "start-steps", "steps-progress", "next-step", "hint-place", "hint-studio"].every((id) => popupHtml.includes(`id="${id}"`)) && ['data-step="bridge"', 'data-step="studio"', 'data-step="place"', 'data-step="chat"'].every((t) => popupHtml.includes(t)));
ok("popup.js ticks the steps from the bridge snapshot and writes a plain 'Next:' line",
  /const states = \{ bridge: mcpOk, studio: studioLinked, place: placeOpen, chat: false \}/.test(popupJs) && /li\.className = states\[k\] \? "ok" : \(k === firstOpen \? "now" : "wait"\)/.test(popupJs) && /Next: double-click \$\{RUN_CMD\}/.test(popupJs) && /Ready - open an AI chat and press/.test(popupJs));
ok("popup CSS styles the pips", popupHtml.includes("#start-steps li.ok .pip") && popupHtml.includes("#start-steps li.now .pip"));

// ── E. Version pins ────────────────────────────────────────────────────────
const V = "1.40.0";
ok("manifest is " + V, manifest.version === V, manifest.version);
ok("plugin pinned", read("plugin/ORscript.lua").includes(`local VERSION = "${V}"`) && read("plugin/ORscript.lua").split("\n")[1].includes(V));
ok("crate pinned (Cargo.toml + Cargo.lock)", /^version = "1\.40\.0"/m.test(read("agent/Cargo.toml")) && /name = "or-agent"\nversion = "1\.40\.0"/.test(read("agent/Cargo.lock")));
ok("README changelog + test listed + crate line",
  readme.includes("**1.40.0 — Beginner mode.**") && readme.includes("node tests/test-v140.js") && readme.includes("(`or-agent` 1.40.0)"));

if (failed) { console.log(`\n${failed} 1.40.0 check(s) failed.`); process.exit(1); }
console.log("\nall 1.40.0 checks passed");
