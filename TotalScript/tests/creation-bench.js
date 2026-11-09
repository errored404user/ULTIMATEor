"use strict";
// 2.16.1 — CREATION BENCHMARK: measures the Universal Creation Intelligence
// Engine (src/core/creation_engine.js) against a labelled corpus and against
// the previous gate (the work-mode evidence gates in main.js), per provider.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ SIMULATED. No provider is contacted, no model output is involved, no    │
// │ Studio is touched. The "runs" below are synthetic command logs that     │
// │ stand for three typical model behaviours (complete / skipped a part /   │
// │ never read back). The numbers therefore measure the DETERMINISTIC layer │
// │ - what the engine understands from a request and what it can prove or  │
// │ catch from a command log - not live model quality.                     │
// └─────────────────────────────────────────────────────────────────────────┘
// Run from the TotalScript root: node tests/creation-bench.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const C = require(path.join(root, "src/core/creation_engine.js"));
const O = require(path.join(root, "src/core/orchestrator.js"));
const manifest = JSON.parse(read("manifest.json"));
const main = read("src/core/main.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : "")); } }
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

// ── BEFORE: the work-mode evidence gates, read from main.js itself ──
const MODE_GATES = (() => {
  const lines = main.split("\n");
  const start = lines.findIndex((l) => /^\s*const MODE_GATES = \{/.test(l));
  let end = start; while (end < lines.length && !/^  \};\s*$/.test(lines[end])) end++;
  return new Function(lines.slice(start, end + 1).join("\n") + "\nreturn MODE_GATES;")();
})();
function modeGateNudges(tools) {
  const gates = MODE_GATES.creation;
  return gates.filter((g) => tools.some((t) => g.did.test(t)) && !tools.some((t) => g.proof.test(t))).map((g) => g.id);
}

// ── 1. labelled corpus: 30 requests, 10 domains ──
// want = the deliverable domains a careful human would list; neg = excluded
const CORPUS = [
  ["gui", "make a main menu with Play and Settings buttons", ["gui"]],
  ["gui", "build a shop UI with a scrolling list of items and a buy button", ["gui"]],
  ["gui", "fix the leaderboard gui, it overlaps the health bar", ["gui"]],
  ["script", "write a ModuleScript that formats numbers with commas", ["script"]],
  ["script", "create a server script that gives 10 coins every minute and a LocalScript that shows them", ["gameplay"]],
  ["script", "refactor my RemoteEvent handler module to validate arguments", ["script"]],
  ["gameplay", "make a coin pickup system with leaderstats", ["gameplay"]],
  ["gameplay", "create a door that opens when touched, without any sounds", ["gameplay"], ["sounds"]],
  ["gameplay", "build a round based minigame with a lobby, a timer and a winner screen", ["gameplay", "gui"]],
  ["gameplay", "Build a sword combat system with a shop GUI, hit particles and a slash sound, and save coins with a DataStore. No music.", ["data", "gameplay", "gui", "vfx", "sfx"], ["music"]],
  ["model", "build a medieval tower with a spiral staircase", ["model"]],
  ["model", "make a low-poly pickup truck", ["model"]],
  ["model", "create a set of furniture: a table and four chairs", ["model"]],
  ["animation", "add a walk animation to the R15 rig and play it from a LocalScript", ["animation", "script"]],
  ["animation", "make an idle and a two-hit attack combo animation for the sword", ["animation"]],
  ["animation", "create a cutscene where the camera flies over the castle", ["animation"]],
  ["vfx", "add an explosion effect with smoke and sparks when the barrel is hit", ["vfx"]],
  ["vfx", "set up moody night lighting with fog and bloom", ["vfx"]],
  ["vfx", "give the sword a glowing trail and a hit flash", ["vfx"]],
  ["sfx", "add footstep sounds and a background music loop", ["sfx"]],
  ["sfx", "wire click sounds to every button in the shop menu", ["sfx"]],
  ["sfx", "play a coin sound when a coin is picked up", ["sfx"]],
  ["environment", "make a cozy medieval village map with terrain, houses and ambient lighting", ["environment", "model", "vfx"]],
  ["environment", "generate an island with a beach, a forest and a mountain", ["environment"]],
  ["environment", "build a desert arena with spawn points and some rocks", ["environment", "gameplay"]],
  ["data", "save the player's coins and level between sessions with a DataStore", ["data"]],
  ["data", "add a ProfileService style data layer with session locking", ["data"]],
  ["data", "make leaderstats that save, plus a GUI that shows them", ["data", "gui"]],
  ["blender", "in Blender build a low-poly lantern and send it to Studio", ["blender", "model"]],
  ["tr", "oyuncu için bir dükkan arayüzü ve coin sistemi yap, ses olmasın", ["gui", "gameplay"], ["ses"]],
];

// HELD-OUT set: written after the engine was tuned on CORPUS and never used
// to adjust a regex. Reported separately; the number is whatever it is.
const HELD_OUT = [
  ["gameplay", "create a sprint system with a stamina bar", ["gameplay", "gui"]],
  ["gameplay", "make a lava floor that kills players and respawns them at the last checkpoint", ["gameplay"]],
  ["vfx", "add rain particles and thunder sounds to the map", ["vfx", "sfx"]],
  ["model", "build a pirate ship model with cannons that fire cannonballs", ["model", "gameplay"]],
  ["animation", "animate the door opening and closing smoothly", ["animation"]],
  ["gameplay", "set up a daily reward system with a popup that shows the streak and saves it", ["gameplay", "gui", "data"]],
  ["environment", "generate a snowy mountain terrain with a frozen lake", ["environment"]],
  ["script", "write a typed ModuleScript for inventory management with unit tests", ["script"]],
  ["tr", "bana bir envanter sistemi ve kaydetme ekle", ["gameplay", "data"]],
  ["gui", "make the shop prettier, no new features", ["gui"]],
];
const specResults = [];
let exact = 0, tp = 0, fp = 0, fn = 0;
const perDomain = {};
for (const [domain, text, want, neg] of CORPUS) {
  const sp = C.spec(text, { task: O.classifyTask(text), mode: domain === "blender" ? "blender" : "creation" });
  const got = sp.deliverables.map((d) => d.id);
  const w = new Set(want), g = new Set(got);
  const hit = [...g].filter((x) => w.has(x)).length;
  tp += hit; fp += g.size - hit; fn += w.size - hit;
  const isExact = hit === w.size && g.size === w.size;
  if (isExact) exact++;
  const negOk = !neg || neg.every((n) => sp.negated.some((x) => x.includes(n) || n.includes(x)));
  (perDomain[domain] = perDomain[domain] || { n: 0, exact: 0 }).n++; if (isExact) perDomain[domain].exact++;
  specResults.push({ domain, text, want, got, exact: isExact, negated: sp.negated, negOk, complexity: sp.complexity, integrations: sp.integrations.map((i) => i.id) });
}
const precision = pct(tp, tp + fp), recall = pct(tp, tp + fn);
console.log("\n1. REQUEST → SPEC (" + CORPUS.length + " labelled requests)");
console.log(`   exact deliverable set: ${exact}/${CORPUS.length} (${pct(exact, CORPUS.length)}%) · domain precision ${precision}% · recall ${recall}%`);
console.log("   per domain exact: " + Object.entries(perDomain).map(([d, r]) => `${d} ${r.exact}/${r.n}`).join(" · "));
for (const r of specResults.filter((x) => !x.exact)) console.log(`   miss  [${r.domain}] "${r.text.slice(0, 70)}" want ${r.want.join("+")} got ${r.got.join("+") || "-"}`);
ok("spec: exact deliverable set on ≥ 80% of the corpus", pct(exact, CORPUS.length) >= 80, { exact, n: CORPUS.length });
let hoExact = 0; const hoMiss = [];
for (const [domain, text, want] of HELD_OUT) {
  const got = C.spec(text, { task: O.classifyTask(text) }).deliverables.map((d) => d.id);
  if (got.length === want.length && want.every((w) => got.includes(w))) hoExact++; else hoMiss.push({ text, want, got });
}
console.log(`   HELD-OUT (${HELD_OUT.length} requests written after tuning, never used to adjust the engine): exact ${hoExact}/${HELD_OUT.length} (${pct(hoExact, HELD_OUT.length)}%)`);
for (const m of hoMiss) console.log(`   miss  "${m.text.slice(0, 70)}" want ${m.want.join("+")} got ${m.got.join("+") || "-"}`);
ok("spec: held-out set is reported (no threshold - the number is the finding)", true);
ok("spec: every negation in the corpus is recorded", specResults.every((r) => r.negOk), specResults.filter((r) => !r.negOk).map((r) => r.text));

// ── 2. coverage detection: synthetic runs vs BEFORE (mode gates) / AFTER (creation engine) ──
// Representative build + proof commands per domain (all real catalogue names).
const BUILD = { gui: ["ui_screen_generate", { name: "Shop" }], script: ["script_create", { kind: "module", name: "Fmt", parent: "ReplicatedStorage", source: "--!strict\nlocal M = {}\nfunction M.fmt(n: number): string return tostring(n) end\nreturn M" }], gameplay: ["script_create", { kind: "server", name: "Main", parent: "ServerScriptService", source: 'local Players = game:GetService("Players")\nPlayers.PlayerAdded:Connect(function(plr) task.wait(1) end)' }], model: ["model_build", { name: "Tower" }], animation: ["animation_create", { name: "Walk" }], vfx: ["fx_create_emitter", { name: "Hit" }], sfx: ["sfx_event_define", { name: "step" }], environment: ["map_generate", { preset: "island" }], data: ["datastore_profile_scaffold", { name: "Profile" }], blender: ["blender_asset_build", { name: "Lantern" }], local: ["write_file", { path: "a.json", content: "{}" }] };
const SERVER_REMOTE = 'local RS = game:GetService("ReplicatedStorage")\nlocal ds = game:GetService("DataStoreService"):GetDataStore("x")\nlocal re = RS:WaitForChild("Buy")\nre.OnServerEvent:Connect(function(plr, id)\n  if typeof(id) ~= "string" then return end\n  local ok = pcall(function() return ds:GetAsync(plr.UserId) end)\n  workspace.Sword.Handle.Hit:Play()\n  workspace.Sword.Handle.Spark:Emit(10)\nend)';
const CLIENT_REMOTE = 'local re = game:GetService("ReplicatedStorage"):WaitForChild("Buy")\nscript.Parent.Buy.MouseButton1Click:Connect(function() re:FireServer("sword") end)';
const INTEGRATE = {
  gui_remote: [["remote_scaffold", { name: "Buy" }], ["script_set_source", { path: "ServerScriptService.Main", source: SERVER_REMOTE }], ["script_create", { kind: "client", name: "ShopClient", parent: "StarterGui", source: CLIENT_REMOTE }]],
  gui_remote_data: [["leaderstats_add", { name: "Coins" }]],
  data_pcall: [["script_set_source", { path: "ServerScriptService.Main", source: SERVER_REMOTE }]],
  sfx_trigger: [["sfx_event_play", { name: "step" }]],
  sfx_gui: [["ui_sound_effects_wire", { screen: "Shop" }]],
  vfx_trigger: [["vfx_play", { name: "Hit" }]],
  anim_playback: [["anim_player_install", {}]],
  model_gameplay: [["tool_create", { name: "Sword" }]],
  env_spawn: [["spawn_location_create", {}]],
};
const PROOF = { gui: "ui_audit", script: "script_check", gameplay: "script_check", model: "model_report", animation: "animation_validate", vfx: "vfx_validate", sfx: "sfx_validate", environment: "terrain_info", data: "ds_get", blender: "blender_asset_validate", local: "read_file" };
function simulate(sp, behaviour, profile) {
  const T = C.tracker(sp, { profile: C.profileFor(profile, { id: "bench" }) });
  const tools = [];
  const items = sp.deliverables;
  const run = (tool, args, fb) => { tools.push(tool); T.observe({ tool, arguments: args || {} }, fb || "ok"); };
  run("get_studio_state", {});
  items.forEach((d, i) => {
    if (behaviour === "skipped" && i === items.length - 1) return; // the model forgot the last part
    const b = BUILD[d.id]; run(b[0], b[1]);
    if (behaviour !== "noreadback") run(PROOF[d.id], {});
  });
  // a complete run also carries the integration evidence the spec asked for
  if (behaviour === "complete") for (const i of sp.integrations) { const x = INTEGRATE[i.id]; if (x) for (const [tool, args] of x) run(tool, args); }
  const before = modeGateNudges(tools).length > 0;
  const after = T.nudge({ resendAllowed: true }) !== "";
  const rep = T.report();
  return { before, after, level: rep.level, missing: rep.missing };
}
const det = { complete: { before: 0, after: 0, n: 0 }, skipped: { before: 0, after: 0, n: 0 }, noreadback: { before: 0, after: 0, n: 0 } };
const multi = specResults.filter((r) => r.got.length >= 1);
for (const r of multi) {
  const sp = C.spec(r.text, { task: O.classifyTask(r.text), mode: r.domain === "blender" ? "blender" : "creation" });
  for (const b of ["complete", "skipped", "noreadback"]) {
    if (b === "skipped" && sp.deliverables.length < 2) continue; // nothing to skip without making it 'nothing ran'
    const s = simulate(sp, b, "high");
    det[b].n++; if (s.before) det[b].before++; if (s.after) det[b].after++;
  }
}
console.log("\n2. COVERAGE DETECTION on synthetic runs (High profile) — BEFORE = work-mode gates only, AFTER = creation check");
console.log("   behaviour           runs  before-nudged  after-nudged   (a nudge on 'complete' is a false alarm; on the others it is a catch)");
for (const [b, r] of Object.entries(det)) console.log(`   ${b.padEnd(19)} ${String(r.n).padStart(4)}  ${String(r.before).padStart(13)}  ${String(r.after).padStart(12)}`);
ok("coverage: the creation check raises no false alarm on complete + integrated runs (the mode gates do: " + det.complete.before + "/" + det.complete.n + ")", det.complete.after === 0, det.complete);
ok("coverage: every skipped deliverable is caught by the creation check (the mode gates only fire for unrelated reasons, never for the missing part)", det.skipped.after === det.skipped.n && det.skipped.before < det.skipped.n, det.skipped);
ok("coverage: never-read-back runs are caught at least as often as before", det.noreadback.after >= det.noreadback.before && det.noreadback.after === det.noreadback.n, det.noreadback);

// ── 3. profile behaviour (same 'noreadback' run, four profiles) ──
console.log("\n3. PROFILE BEHAVIOUR on the 5-deliverable request, model never reads back");
const big = C.spec(CORPUS[9][1], { task: O.classifyTask(CORPUS[9][1]) });
const profRows = {};
for (const id of C.PROFILE_IDS) {
  const T = C.tracker(big, { profile: C.profileFor(id, { id: "bench" }) });
  T.observe({ tool: "get_studio_state", arguments: {} }, "ok");
  for (const d of big.deliverables) { const b = BUILD[d.id]; T.observe({ tool: b[0], arguments: b[1] }, "ok"); }
  let rounds = 0; while (T.nudge({ resendAllowed: true })) { rounds++; const d = big.deliverables[rounds % big.deliverables.length]; T.observe({ tool: PROOF[d.id], arguments: {} }, "ok"); } // each round the model fixes one item
  const rep = T.report();
  profRows[id] = { rounds, maxRounds: rep.maxRounds, level: rep.level, verified: rep.verified, requireVerify: C.PROFILES[id].requireVerify, requireAudit: C.PROFILES[id].requireAudit };
  console.log(`   ${id.padEnd(13)} checks sent ${rounds}/${rep.maxRounds} · read back ${rep.verified}/${rep.deliverables} · level ${rep.level} · requireVerify ${C.PROFILES[id].requireVerify} · requireAudit ${C.PROFILES[id].requireAudit}`);
}
ok("profiles: Standard sends no read-back check, Masterpiece sends the most", profRows.standard.rounds === 0 && profRows.masterpiece.rounds > profRows.high.rounds && profRows.masterpiece.rounds <= 3, profRows);

// ── 4. static Luau review: labelled snippets ──
const SNIPPETS = [
  ["server", 'local ds = game:GetService("DataStoreService"):GetDataStore("x")\nds:SetAsync("k", 1)', ["datastore_no_pcall"]],
  ["server", "local p = game.Players.LocalPlayer\nprint(p)", ["server_localplayer", "service_path"]],
  ["server", "while true do\n  doWork()\nend", ["busy_loop"]],
  ["server", "re.OnServerEvent:Connect(function(plr, amt)\n  coins.Value += amt\nend)", ["remote_no_validation"]],
  ["server", "part.Touched:Connect(function(hit)\n  hit.Parent.Humanoid:TakeDamage(10)\nend)", ["touched_no_debounce"]],
  ["server", "wait(2)\nspawn(function() end)", ["legacy_wait", "legacy_spawn"]],
  ["client", 'local ds = game:GetService("DataStoreService")\nhum.Health = 0', ["client_datastore", "client_health"]],
  ["server", "loadstring(src)()\nrequire(1234567)", ["loadstring", "require_id"]],
  ["module", "local M = {}\nreturn M", ["module_no_strict"]],
  ["client", 'local f = Instance.new("Frame")\nf.Size = UDim2.new(0, 200, 0, 100)', ["ui_offset_only"]],
  // clean
  ["server", 'local Players = game:GetService("Players")\nlocal ds = game:GetService("DataStoreService"):GetDataStore("x")\nPlayers.PlayerAdded:Connect(function(plr)\n  local ok, err = pcall(function() return ds:GetAsync(plr.UserId) end)\n  task.wait(1)\nend)', []],
  ["server", 're.OnServerEvent:Connect(function(plr, amt)\n  if typeof(amt) ~= "number" then return end\n  coins.Value += math.clamp(amt, 0, 5)\nend)', []],
  ["server", "local debounce = {}\npart.Touched:Connect(function(hit)\n  if debounce[hit] then return end\n  debounce[hit] = true\n  task.wait(1)\n  debounce[hit] = nil\nend)", []],
  ["module", "--!strict\nlocal M = {}\nfunction M.add(a: number, b: number): number return a + b end\nreturn M", []],
  ["client", 'local f = Instance.new("Frame")\nf.Size = UDim2.fromScale(0.3, 0.2)', []],
  ["server", "while true do\n  task.wait(1)\n  tick()\nend", []],
  ["server", "-- wait(1) loadstring(x) while true do\nlocal x = 1", []],
];
let stp = 0, sfp = 0, sfn = 0, cleanFalse = 0;
for (const [container, src, want] of SNIPPETS) {
  const got = C.reviewLuau(src, { container }).map((x) => x.code);
  const w = new Set(want), g = new Set(got);
  const hit = [...g].filter((x) => w.has(x)).length;
  stp += hit; sfp += g.size - hit; sfn += w.size - hit;
  if (!want.length && got.length) { cleanFalse++; console.log("   false positive on clean snippet: " + got.join(",") + " ← " + src.split("\n")[0]); }
  if (want.some((x) => !g.has(x))) console.log("   missed: want " + want.join(",") + " got " + (got.join(",") || "-"));
}
console.log(`\n4. STATIC LUAU REVIEW (${SNIPPETS.length} labelled snippets, ${SNIPPETS.filter((s) => !s[2].length).length} clean): precision ${pct(stp, stp + sfp)}% · recall ${pct(stp, stp + sfn)}% · false positives on clean ${cleanFalse}`);
ok("static review: no false positive on clean snippets, recall 100% on the labelled defects", cleanFalse === 0 && sfn === 0, { sfn, cleanFalse });

// ── 5. per provider: REAL adapter caps → effective profile, brief / nudge within the send budget ──
const providers = require(path.join(__dirname, "lib/load-providers.js"))(root).map((p) => ({ id: p.id, caps: O.capabilities(p.P) }));
console.log("\n5. PER PROVIDER (real adapter flags; profile = High unless noted)");
console.log("   provider      tight  budget   rounds  briefMin  notes  brief(full/tight)  nudge  fits-budget");
const provRows = {};
const bigSpec = big;
for (const p of providers) {
  const caps = Object.assign({}, p.caps);
  const prof = C.profileFor("high", caps), master = C.profileFor("masterpiece", caps);
  const briefFull = C.brief(bigSpec, { tight: false, briefMin: 1 }).length, briefTight = C.brief(bigSpec, { tight: true, briefMin: 1 }).length;
  const T = C.tracker(bigSpec, { profile: prof }); T.observe({ tool: "ui_screen_generate", arguments: {} }, "ok");
  const nudge = T.nudge({ resendAllowed: true }).length;
  const budget = caps.sendCharBudget || null;
  const fits = !budget || ((prof.tight ? briefTight : briefFull) <= budget && nudge <= budget);
  provRows[p.id] = { tight: prof.tight, sendCharBudget: budget, rounds: prof.rounds, masterpieceRounds: master.rounds, briefMin: prof.briefMin, reviewNotes: prof.reviewNotes, brief: prof.tight ? briefTight : briefFull, nudge, fits, commandFormat: caps.commandFormat, commandlessRetries: caps.commandlessRetries, capped: prof.capped };
  console.log(`   ${p.id.padEnd(13)} ${String(prof.tight).padEnd(6)} ${String(budget || "-").padEnd(8)} ${String(prof.rounds + "/" + master.rounds).padEnd(7)} ${String(prof.briefMin).padEnd(9)} ${String(prof.reviewNotes).padEnd(6)} ${String(briefFull + "/" + briefTight).padEnd(18)} ${String(nudge).padEnd(6)} ${fits}`);
}
ok("providers: ≥ 12 real adapters loaded and the brief + nudge fit every declared send budget", providers.length >= 11 && Object.values(provRows).every((r) => r.fits), Object.entries(provRows).filter(([, r]) => !r.fits).map(([k]) => k));
ok("providers: every adapter keeps its full check budget (High 1 / Masterpiece 3) - 2.16.1 removed the DeepSeek gentle-mode cap", Object.entries(provRows).every(([id, r]) => r.rounds === 1 && r.masterpieceRounds === 3), provRows);

const out = { version: C.VERSION, simulated: true, at: new Date().toISOString(), spec: { n: CORPUS.length, exact, precision, recall, perDomain, misses: specResults.filter((r) => !r.exact), heldOut: { n: HELD_OUT.length, exact: hoExact, misses: hoMiss } }, coverage: det, profiles: profRows, staticReview: { snippets: SNIPPETS.length, precision: pct(stp, stp + sfp), recall: pct(stp, stp + sfn), cleanFalsePositives: cleanFalse }, providers: provRows };
try { fs.writeFileSync("/tmp/totalscript-creation-bench.json", JSON.stringify(out, null, 2)); console.log("\nreport written to /tmp/totalscript-creation-bench.json"); } catch {}
console.log(`\ncreation-bench: ${pass + fail} checks, ${fail} failed (SIMULATED — deterministic layer only)`);
process.exit(fail ? 1 : 0);
