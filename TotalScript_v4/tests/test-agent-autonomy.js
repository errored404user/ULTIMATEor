"use strict";
// Comprehensive test suite for TotalScript Agent Intelligence & Autonomy upgrades
// across Roblox Studio (RS), AgentScript (AS), and 3D/Design (Blender, Blockbench, Figma).
// Pure offline deterministic tests — run with: node tests/test-agent-autonomy.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } } };

// Load skill packs, parser, and agent crew via vm (browser content-script globals)
const ctx = { window: {}, console, chrome: global.chrome, __rsMultiAgent: () => true };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(read("src/core/skills/studio_skills.js") + "\n" + read("src/core/skills/studio_daily.js") + "\nthis.__skills = RobloxScriptSkills;", ctx);
vm.runInContext(read("src/core/parser.js") + "\nthis.__RSParse = RSParse;", ctx);
vm.runInContext(read("src/core/agent_crew.js") + "\nthis.__Crew = TotalAgentCrew;", ctx);

const C = require(path.join(root, "src/core/command_contract.js"));
C.configure({ skills: ctx.__skills });
const O = require(path.join(root, "src/core/orchestrator.js"));
const CR = require(path.join(root, "src/core/creation_engine.js"));
const W = require(path.join(root, "src/core/work_modes.js"));
const P = ctx.__RSParse;
const Crew = ctx.__Crew;
const main = read("src/core/main.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("ok   " + name); }
  else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 260) : "")); }
}

// ── 1. Self-Healing Error Diagnosis & Path Trimming (TotalCommandContract) ──
{
  const p = C.prepare("material_set", { path: "  Workspace.Door  ", material: "Wood" });
  ok("A1 prepare() trims accidental whitespace around path params and records trim correction",
    p.ok && p.args.path === "Workspace.Door" && p.corrections.some((c) => c.kind === "trim" && c.param === "path"), p);

  const rsChar = C.diagnoseFix("execute_luau", "ERROR: ServerScriptService.Combat:14: attempt to index nil with 'Character'");
  ok("A2 RS nil Character error → CharacterAdded:Wait guard recipe",
    rsChar && rsChar.domain === "roblox" && /CharacterAdded:Wait/.test(rsChar.recipe), rsChar);

  const rsYield = C.diagnoseFix("execute_luau", "Infinite yield possible on 'ReplicatedStorage:WaitForChild(\"BuyRemote\")'");
  ok("A3 RS Infinite yield → names missing child & timeout recipe",
    rsYield && rsYield.pattern === "infinite_yield" && rsYield.recipe.includes("BuyRemote") && /WaitForChild/.test(rsYield.recipe), rsYield);

  const rsMember = C.diagnoseFix("execute_luau", "ERROR: Coins is not a valid member of Folder \"leaderstats\"");
  ok("A4 RS invalid member → names member & parent inspection",
    rsMember && rsMember.pattern === "invalid_member" && rsMember.recipe.includes("Coins") && rsMember.recipe.includes("leaderstats"), rsMember);

  const rsDs = C.diagnoseFix("execute_luau", "ERROR: 403: Studio Access to API Services is not allowed");
  ok("A5 RS DataStore 403 → Studio API Services + pcall recipe",
    rsDs && rsDs.pattern === "datastore_api" && /API Services/.test(rsDs.recipe), rsDs);

  const rsTimeout = C.diagnoseFix("execute_luau", "Script timeout: exhausted allowed execution time");
  ok("A6 RS script timeout → task.wait() recipe",
    rsTimeout && rsTimeout.pattern === "script_timeout" && /task\.wait/.test(rsTimeout.recipe), rsTimeout);

  const rsAnim = C.diagnoseFix("execute_luau", "Failed to load animation: Invalid AnimationId");
  ok("A7 RS animation load error → animation_build / AnimSaves recipe",
    rsAnim && rsAnim.pattern === "animation_load" && /animation_build/.test(rsAnim.recipe), rsAnim);

  const asEdit = C.diagnoseFix("edit_file", "ERROR: target block not found in src/app.ts");
  ok("A8 AS edit_file mismatch → read_range exact whitespace recipe",
    asEdit && asEdit.domain === "local" && asEdit.pattern === "edit_mismatch" && /read_range/.test(asEdit.recipe), asEdit);

  const asMulti = C.diagnoseFix("replace_in_file", "ERROR: target occurred 3 times (ambiguous)");
  ok("A9 AS ambiguous edit → surrounding context recipe",
    asMulti && asMulti.pattern === "edit_ambiguous" && /surrounding lines/.test(asMulti.recipe), asMulti);

  const asEnoent = C.diagnoseFix("read_file", "ERROR: ENOENT: no such file or directory, open 'src/missing.js'");
  ok("A10 AS ENOENT → names file and suggests list_dir/search_files",
    asEnoent && asEnoent.pattern === "file_not_found" && asEnoent.recipe.includes("src/missing.js") && /list_dir/.test(asEnoent.recipe), asEnoent);

  const asCmdTimeout = C.diagnoseFix("run_command", "ERROR: command timed out after 30s");
  ok("A11 AS run_command timeout → non-interactive flags recipe",
    asCmdTimeout && asCmdTimeout.pattern === "cmd_timeout" && /--no-watch/.test(asCmdTimeout.recipe), asCmdTimeout);

  const blPoll = C.diagnoseFix("blender_bevel", "ERROR: RuntimeError: Operator bpy.ops.mesh.bevel.poll() failed, context is incorrect");
  ok("A12 Blender poll() failed → mode/selection context recipe",
    blPoll && blPoll.domain === "blender" && blPoll.pattern === "blender_context", blPoll);

  const bbProj = C.diagnoseFix("bb_cubes", "ERROR: No project open in Blockbench");
  ok("A13 Blockbench no project → bb_project recipe",
    bbProj && bbProj.domain === "blockbench" && /bb_project/.test(bbProj.recipe), bbProj);

  const fgPair = C.diagnoseFix("figma_plugin_create_frame", "ERROR: 401 unauthorized - plugin session expired");
  ok("A14 Figma pairing error → Settings Connections pairing recipe",
    fgPair && fgPair.domain === "figma" && /Figma Design plugin/.test(fgPair.recipe), fgPair);

  const ann = C.annotate("execute_luau", "ERROR: Coins is not a valid member of Folder \"leaderstats\"");
  ok("A15 annotate() automatically includes ; fix: recipe inside [diagnosis]",
    /\[diagnosis\]/.test(ann) && /; fix: /.test(ann) && ann.includes("leaderstats"), ann);
}

// ── 2. Multi-Turn Autonomy Brain (TotalOrchestrator.createRunMemory) ──
{
  // Oscillation A <-> B detection
  const mem = O.createRunMemory({ engine: "roblox", task: { mutates: true } });
  const r1 = mem.record({ tool: "script_create", args: { name: "A" }, sig: "A", ok: false, category: "invalid_reference", feedback: "ERROR: not found" });
  const r2 = mem.record({ tool: "part_create", args: { name: "B" }, sig: "B", ok: false, category: "invalid_parameter", feedback: "ERROR: bad param" });
  const r3 = mem.record({ tool: "script_create", args: { name: "A" }, sig: "A", ok: false, category: "invalid_reference", feedback: "ERROR: not found" });
  ok("B1 oscillation detector catches A -> B -> A echo on turn 3",
    !r1.coaching && !r2.coaching && r3.kind === "oscillation" && /AUTONOMY GUARD/.test(r3.coaching) && mem.snapshot().oscillations === 1, r3);

  // Same-error-class rut across DIFFERENT arguments
  const memRut = O.createRunMemory({ engine: "local", task: { mutates: true } });
  memRut.record({ tool: "edit_file", args: { path: "a.js" }, sig: "e1", ok: false, category: "invalid_reference", feedback: "ERROR: not found" });
  memRut.record({ tool: "edit_file", args: { path: "b.js" }, sig: "e2", ok: false, category: "invalid_reference", feedback: "ERROR: not found" });
  const rut3 = memRut.record({ tool: "edit_file", args: { path: "c.js" }, sig: "e3", ok: false, category: "invalid_reference", feedback: "ERROR: not found" });
  ok("B2 rut detector catches 3 consecutive same-category failures across different args with AS-specific hint",
    rut3.kind === "error_rut" && /3 consecutive 'invalid_reference'/.test(rut3.coaching) && /list_dir|read_range/.test(rut3.coaching), rut3);

  // Recovery clears failure streaks and triggers memory sync
  const rec = memRut.record({ tool: "write_file", args: { path: "src/app.js" }, sig: "w1", ok: true, feedback: "OK" });
  ok("B3 success after failure streak resets streaks, tracks artifact, and flags recovery",
    rec.recovered === true && memRut.snapshot().failStreak === 0 && memRut.snapshot().artifacts.includes("src/app.js"), memRut.snapshot());

  // Read-only exploration spin guard on mutating tasks
  const memSpin = O.createRunMemory({ engine: "roblox", task: { mutates: true }, readSpinLimit: 4 });
  let spinHit = null;
  for (let i = 0; i < 4; i++) {
    spinHit = memSpin.record({ tool: "inspect_instance", args: { path: "Workspace.P" + i }, sig: "r" + i, ok: true, feedback: "OK" });
  }
  ok("B4 read-spin guard nudges model to start building after consecutive read-only calls on mutating task",
    spinHit && spinHit.kind === "read_spin" && /AUTONOMY NOTE/.test(spinHit.coaching), spinHit);

  // Non-mutating (explain/review) task NEVER triggers read-spin
  const memRev = O.createRunMemory({ engine: "roblox", task: { mutates: false }, readSpinLimit: 3 });
  let revSpin = "";
  for (let i = 0; i < 5; i++) {
    const r = memRev.record({ tool: "script_read", args: { path: "S" + i }, sig: "sr" + i, ok: true, feedback: "OK" });
    if (r.coaching) revSpin = r.coaching;
  }
  ok("B5 non-mutating tasks never trigger read-spin", revSpin === "");

  // Cross-workflow artifact ledger + [RUN MEMORY] note bounds
  const memArt = O.createRunMemory({ engine: "roblox", task: { mutates: true } });
  memArt.record({ tool: "script_create", args: { parent: "ServerScriptService", name: "ShopServer" }, ok: true, feedback: '{"path":"ServerScriptService.ShopServer"}' });
  memArt.record({ tool: "ui_screen_generate", args: { name: "ShopUI" }, ok: true, feedback: 'path=StarterGui.ShopUI' });
  memArt.record({ tool: "blender_asset_build", args: { name: "SwordMesh" }, ok: true, feedback: "OK" });
  memArt.record({ tool: "bb_export", args: { format: "glb" }, ok: true, feedback: "Exported to exports/knight.glb" });
  memArt.record({ tool: "figma_plugin_create_frame", args: { name: "HudFrame" }, ok: true, feedback: "OK" });
  const snap = memArt.snapshot();
  ok("B6 artifact ledger tracks RS, Blender, Blockbench, and Figma outputs cleanly",
    snap.artifacts.includes("ServerScriptService.ShopServer") &&
    snap.artifacts.includes("StarterGui.ShopUI") &&
    snap.artifacts.includes("blender:SwordMesh") &&
    snap.artifacts.includes("bb_export:exports/knight.glb") &&
    snap.artifacts.includes("figma:HudFrame"), snap.artifacts);

  const noteFull = memArt.memoryNote({ tight: false, creationProgress: "Gameplay system ✓ · GUI ◌(verify)" });
  const noteTight = memArt.memoryNote({ tight: true, creationProgress: "Gameplay system ✓ · GUI ◌(verify)" });
  ok("B7 [RUN MEMORY] note respects tight (<=240) and full (<=360) budgets and includes deliverables + artifacts",
    noteFull.startsWith("[RUN MEMORY") && noteFull.length <= 360 && noteFull.includes("ShopUI") && noteFull.includes("Gameplay system ✓") &&
    noteTight.length <= 240, { full: noteFull.length, tight: noteTight.length, noteFull });
}

// ── 3. Upgraded Static Review (Luau + Local Multi-Language) & Live ProgressLine ──
{
  const leakLuau = [
    'local Players = game:GetService("Players")',
    'local RunService = game:GetService("RunService")',
    'local cache = {}',
    'Players.PlayerAdded:Connect(function(plr)',
    '  cache[plr.UserId] = { coins = 0 }',
    '  local p = Instance.new("Part", workspace)',
    '  p.Anchored = true',
    '  RunService.Heartbeat:Connect(function() end)',
    'end)',
  ].join("\n");
  const fl = CR.reviewLuau(leakLuau, { container: "server" }).map((x) => x.code);
  ok("C1 reviewLuau catches Instance.new(class,parent), per-player table leak, and Heartbeat leak inside PlayerAdded",
    fl.includes("instance_new_parent_arg") && fl.includes("player_table_no_cleanup") && fl.includes("loop_conn_leak"), fl);

  const dsNoClose = [
    'local Players = game:GetService("Players")',
    'local ds = game:GetService("DataStoreService"):GetDataStore("Main")',
    'Players.PlayerAdded:Connect(function(plr) pcall(function() ds:GetAsync(plr.UserId) end) end)',
    'Players.PlayerRemoving:Connect(function(plr) pcall(function() ds:SetAsync(plr.UserId, 1) end) end)',
  ].join("\n");
  const flDs = CR.reviewLuau(dsNoClose, { container: "server" }).map((x) => x.code);
  ok("C2 reviewLuau catches missing BindToClose on full PlayerAdded+PlayerRemoving DataStore scripts",
    flDs.includes("datastore_no_bindtoclose"), flDs);

  const badJs = 'const KEY = "sk-proj-1234567890abcdefghij";\nfunction run() {\n  throw new Error("not implemented");\n';
  const fJs = CR.reviewCode(badJs, { path: "src/api.js", fullFile: true }).map((x) => x.code);
  ok("C3 reviewCode catches hardcoded secrets, unimplemented stubs, and unbalanced braces in JS/TS",
    fJs.includes("hardcoded_secret") && fJs.includes("stub_leftover") && fJs.includes("unbalanced_braces"), fJs);

  const badPy = "def load():\n    try:\n        return 1\n    except:\n        raise NotImplementedError()\n";
  const fPy = CR.reviewCode(badPy, { path: "app.py", fullFile: true }).map((x) => x.code);
  ok("C4 reviewCode catches bare except and NotImplementedError in Python",
    fPy.includes("python_bare_except") && fPy.includes("stub_leftover"), fPy);

  const cleanJs = 'export function add(a, b) {\n  const s = "{not a brace}";\n  return a + b + s.length;\n}\n';
  ok("C5 reviewCode produces zero false positives on clean JS with braces inside strings",
    CR.reviewCode(cleanJs, { path: "math.js", fullFile: true }).length === 0);

  // Tracker observe() runs reviewCode on local write_file and progressLine() reflects state
  const spLocal = CR.spec("write a python helper file app.py", { engine: "local", profile: "high" });
  const trLocal = CR.tracker(spLocal);
  const obs1 = trLocal.observe({ tool: "write_file", arguments: { path: "app.py", content: badPy } }, "OK");
  ok("C6 creation tracker automatically attaches static review note on local write_file and reports progressLine",
    /STATIC REVIEW/.test(obs1.note) && /re-read \/ run tests/.test(obs1.note) && /Local files \/ code ◌\(verify\)/.test(trLocal.progressLine()),
    { note: obs1.note, prog: trLocal.progressLine() });
  trLocal.observe({ tool: "run_command", arguments: { command: "pytest" } }, "OK: 3 passed");
  ok("C7 progressLine flips to ✓ after local verification command",
    /Local files \/ code ✓/.test(trLocal.progressLine()), trLocal.progressLine());
}

// ── 4. Zero-Turn Verification & AgentScript Preflight (TotalWorkModes) ──
{
  const acModel = W.autoCheck("creation", "model_build", { name: "Castle", parent: "Workspace" }, '{"path":"Workspace.Castle"}');
  const rModel = W.renderAutoCheck(acModel, JSON.stringify({ found: true, path: "Workspace.Castle", class: "Model", parts: 12, anchored: 12, hasPrimary: false, size: [10, 8, 10] }));
  ok("D1 renderAutoCheck flags multi-part Model with missing PrimaryPart",
    /CHECK:.*no PrimaryPart/.test(rModel), rModel);

  const acGui = W.autoCheck("creation", "ui_screen_generate", { name: "ShopUI", parent: "StarterGui" }, '{"path":"StarterGui.ShopUI"}');
  const rGui = W.renderAutoCheck(acGui, JSON.stringify({ found: true, path: "StarterGui.ShopUI", class: "ScreenGui", parts: 0, anchored: 0, guiObjects: 4, zeroSize: 2, guiEnabled: false }));
  ok("D2 renderAutoCheck flags disabled ScreenGui and visible zero-size GuiObjects",
    /ScreenGui Enabled=false/.test(rGui) && /2 visible GuiObject\(s\) at zero size/.test(rGui), rGui);

  const lp = W.localPreflight();
  const lb = W.renderLocalBrief("package.json\ntsconfig.json\nsrc/\ntests/\n.git/");
  ok("D3 localPreflight + renderLocalBrief detects stack (Node/JS, TypeScript, Git) and formats AGENTSCRIPT PREFLIGHT",
    lp && lp.kind === "local" && lp.tool === "list_dir" &&
    /^━━━ AGENTSCRIPT PREFLIGHT/.test(lb) && /Node\/JS/.test(lb) && /TypeScript/.test(lb) && /Git/.test(lb), lb);
}

// ── 5. Parser Heading-Stripped ###CMD### & Crew 3D/Design Read-Only ──
{
  const headingCmd = "### CMD inspect_instance\npath: Workspace.Castle\ndepth: 2\n### END_CMD";
  const parsed = P.parseToolCalls(headingCmd);
  ok("E1 parser recovers heading-stripped ###CMD### blocks (missing trailing ###)",
    parsed.length === 1 && parsed[0].tool === "inspect_instance" && parsed[0].arguments.path === "Workspace.Castle" && parsed[0].arguments.depth === 2, parsed);

  Crew.reset();
  Crew.handoff({ role: "planner", goal: "Inspect 3D and Figma assets" });
  ok("E2 AgentCrew Planner allows read-only Blockbench, Figma, and Blender inspection",
    Crew.guard("bb_status", {}) === null &&
    Crew.guard("figma_plugin_find", {}) === null &&
    Crew.guard("blender_scene_info", {}) === null &&
    Crew.guard("blender_asset_validate", {}) === null);
  const blocksMutation = (tool) => {
    Crew.reset();
    Crew.handoff({ role: "planner", goal: "Inspect 3D and Figma assets" });
    return typeof Crew.guard(tool, {}) === "string";
  };
  ok("E3 AgentCrew Planner still blocks 3D/Design mutations",
    blocksMutation("bb_cubes") &&
    blocksMutation("figma_plugin_create_frame") &&
    blocksMutation("blender_asset_build"));
  Crew.reset();
}

// ── 6. main.js Wiring Verification ──
{
  ok("F1 main.js initializes A.runMemory in agentLoop and wires autonomy.coach + autonomy.memory",
    /A\.runMemory = \(ORCH && typeof ORCH\.createRunMemory === "function"\)/.test(main) &&
    /diag\("autonomy\.coach"/.test(main) &&
    /diag\("autonomy\.memory"/.test(main));
  ok("F2 main.js wires AgentScript localPreflight in startModePreflight + runModeProbe",
    /probe\.kind === "local"/.test(main) &&
    /WM\.localPreflight\(\)/.test(main) &&
    /WM\.renderLocalBrief\(raw\)/.test(main));
  ok("F3 main.js consolidates creationGate with effortGate.verify and open work-mode gates",
    /effortGate\.verify = true;/.test(main) &&
    /Open work-mode gates to close in the same batch/.test(main));
}

console.log(`\ntest-agent-autonomy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
