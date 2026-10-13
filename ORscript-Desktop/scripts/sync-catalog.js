#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Regenerates data/*.json from the sibling ORscript extension source so the
// desktop app's Skills / Home pages always mirror the shipped extension.
//   node scripts/sync-catalog.js [path/to/ORscript]
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXT = path.resolve(process.argv[2] || path.join(ROOT, "..", "ORscript"));
const OUT = path.join(ROOT, "data");
fs.mkdirSync(OUT, { recursive: true });

const FAMILIES = [
  { file: "studio_skills.js", id: "studio-core", title: "Studio production suite", engine: "roblox", description: "Lighting, UI, VFX, audio, terrain, camera, diagnostics, DataStore and NPC generators layered on execute_luau." },
  { file: "studio_daily.js", id: "studio-daily", title: "Everyday Studio commands", engine: "roblox", description: "Parts, selection, tags, attributes and the small operations builders use all day." },
  { file: "studio_gui.js", id: "studio-gui", title: "GUI builder", engine: "roblox", description: "ScreenGui scaffolds, responsive layouts and component generators." },
  { file: "studio_plus.js", id: "studio-plus", title: "Studio plus", engine: "roblox", description: "Advanced instance operations, batch edits and scripting helpers." },
  { file: "studio_100.js", id: "studio-100", title: "Studio 100", engine: "roblox", description: "One hundred focused primitives: physics, constraints, materials, sounds, scripting utilities." },
  { file: "studio_200.js", id: "studio-200", title: "Studio 200", engine: "roblox", description: "Extended production catalogue: gameplay systems, tooling, UI kits and automation." },
  { file: "studio_extra40.js", id: "studio-extra40", title: "Studio extras (40)", engine: "roblox", description: "Deduplicated high-utility primitives and automation helpers." },
  { file: "studio_extra100.js", id: "studio-inspect", title: "Inspectors", engine: "roblox", description: "Read-only inspectors for every service - safe reconnaissance before edits." },
  { file: "creative_pro.js", id: "creative-pro", title: "Creative Pro", engine: "roblox", description: "High-fidelity VFX, sound design, interface and motion presets." },
  { file: "agent_skills.js", id: "agentscript-extras", title: "AgentScript extras", engine: "local", description: "File helpers, JSON patching, git, npm, python/node runners mapped onto the native workspace tools." },
];

const RE = /name\s*:\s*(["'])([a-z][a-z0-9_]*)\1\s*,\s*description\s*:\s*(["'`])((?:\\.|(?!\3)[\s\S])*)\3/g;

function extractSkills(source) {
  const seen = new Set();
  const out = [];
  let m;
  while ((m = RE.exec(source))) {
    const name = m[2];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: m[4].replace(/\\(["'`])/g, "$1").replace(/\s+/g, " ").trim().slice(0, 400) });
  }
  return out;
}

const families = [];
for (const fam of FAMILIES) {
  const file = path.join(EXT, "src", "core", "skills", fam.file);
  if (!fs.existsSync(file)) { console.warn(`skip ${fam.file} (not found)`); continue; }
  const skills = extractSkills(fs.readFileSync(file, "utf8"));
  if (!skills.length) { console.warn(`no skills parsed from ${fam.file}`); continue; }
  families.push({ id: fam.id, title: fam.title, engine: fam.engine, description: fam.description, source: fam.file, skills });
}
const totalSkills = families.reduce((n, f) => n + f.skills.length, 0);
fs.writeFileSync(path.join(OUT, "skills.json"), JSON.stringify({ generated_at: new Date().toISOString(), total: totalSkills, families }, null, 2));
console.log(`skills.json: ${totalSkills} commands in ${families.length} families`);

// Supported browser AIs (from the extension's AI_SITES table).
const mainJs = fs.readFileSync(path.join(EXT, "src", "core", "main.js"), "utf8");
const block = (mainJs.match(/const AI_SITES = \[([\s\S]*?)\];/) || [])[1] || "";
const ais = [];
const re = /\{\s*name:\s*"([^"]+)",\s*url:\s*"([^"]+)"\s*\}/g;
let m;
while ((m = re.exec(block))) {
  let host = m[2];
  try { host = new URL(m[2]).host; } catch { /* keep */ }
  ais.push({ name: m[1], url: m[2], host });
}
let extVersion = "";
try { extVersion = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).version || ""; } catch { /* ignore */ }
fs.writeFileSync(path.join(OUT, "ais.json"), JSON.stringify({ generated_at: new Date().toISOString(), extension_version: extVersion, ais }, null, 2));
console.log(`ais.json: ${ais.length} browser AIs (extension ${extVersion})`);

// Bundled project templates (scripts/templates/*).
const TEMPLATE_META = {
  "ServerBootstrap.server.lua": { id: "server-bootstrap", name: "Server bootstrap", description: "Loads every service ModuleScript, runs Init/Start with isolated error handling and timing output.", tags: ["server", "architecture", "luau"] },
  "PlayerData.lua": { id: "player-data", name: "PlayerData service", description: "DataStore profile service with defaults, exponential retries, autosave, BindToClose flush and leaderstats mirror.", tags: ["server", "datastore", "leaderstats"] },
  "RemoteBus.lua": { id: "remote-bus", name: "RemoteBus", description: "Declarative remotes with per-player rate limiting and payload validators; typed helpers for both sides.", tags: ["shared", "networking", "security"] },
  "ClientController.client.lua": { id: "client-controller", name: "Client controller", description: "ContextActionService input, lightweight tweened HUD and character lifecycle wiring.", tags: ["client", "input", "ui"] },
  "StateMachine.lua": { id: "state-machine", name: "State machine", description: "Allocation-free finite state machine for NPCs, UI flows and match phases with a Changed signal.", tags: ["shared", "gameplay", "pattern"] },
  "default.project.json": { id: "rojo-project", name: "Rojo project", description: "Rojo default.project.json mapping src/shared, src/server and src/client into the DataModel.", tags: ["tooling", "rojo"] },
};
const TPL_DIR = path.join(ROOT, "scripts", "templates");
const templates = [];
for (const file of fs.readdirSync(TPL_DIR).sort()) {
  const meta = TEMPLATE_META[file];
  if (!meta) continue;
  templates.push({ ...meta, file, language: file.endsWith(".json") ? "json" : "luau", content: fs.readFileSync(path.join(TPL_DIR, file), "utf8") });
}
fs.writeFileSync(path.join(OUT, "templates.json"), JSON.stringify({ generated_at: new Date().toISOString(), templates }, null, 2));
console.log(`templates.json: ${templates.length} templates`);
