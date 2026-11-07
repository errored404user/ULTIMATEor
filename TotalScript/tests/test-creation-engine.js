"use strict";
// 2.13.0 — Universal Creation Intelligence Engine (src/core/creation_engine.js)
// unit tests + wiring pins (manifest, codecraft.html, main.js, background.js,
// popup). Pure-function tests; nothing here contacts a provider or Studio.
// Run from the TotalScript root: node tests/test-creation-engine.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const C = require(path.join(root, "src/core/creation_engine.js"));
const O = require(path.join(root, "src/core/orchestrator.js"));
const main = read("src/core/main.js"), manifest = JSON.parse(read("manifest.json")), html = read("codecraft.html"), bg = read("background.js"), popup = read("popup.js"), popupHtml = read("popup.html");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : "")); } }
const S = (text, ctx) => C.spec(text, Object.assign({ task: O.classifyTask(text) }, ctx || {}));
const ids = (sp) => sp.deliverables.map((d) => d.id);

// ── A. request → structured spec ──
{
  const sp = S("Build a sword combat system with a shop GUI, hit particles and a slash sound, and save coins with a DataStore. No music.");
  ok("A1 complex request yields every named deliverable (data, gameplay, gui, vfx, sfx)", ["data", "gameplay", "gui", "vfx", "sfx"].every((d) => ids(sp).includes(d)), ids(sp));
  ok("A2 'No music' is recorded as a negation but does NOT hide the slash sound", sp.negated.includes("music") && ids(sp).includes("sfx"), sp.negated);
  ok("A3 integration checks derived from the present domains (GUI↔server remote, DataStore↔pcall, SFX trigger)", ["gui_remote", "data_pcall", "sfx_trigger"].every((i) => sp.integrations.some((x) => x.id === i)), sp.integrations.map((i) => i.id));
  ok("A4 stages are dependency-ordered: data before logic before interface before effects/audio, verify last", (() => { const t = sp.stages.map((s) => s.id); return t.indexOf("build1") < t.indexOf("build2") && t.indexOf("build2") < t.indexOf("build4") && t.indexOf("build4") < t.indexOf("build6") && t[t.length - 1] === "verify"; })(), sp.stages.map((s) => s.id));
  ok("A5 complexity = complex, completion criteria name every deliverable + the honest final report", sp.complexity === "complex" && sp.completion.length >= sp.deliverables.length + 1 && /final report/.test(sp.completion[sp.completion.length - 1]));
  ok("A6 each deliverable carries a real build family and a real proof family", sp.deliverables.every((d) => d.build && d.verify && /[a-z]_[a-z]/.test(d.build) && /[a-z]_[a-z]/.test(d.verify)));
}
{
  ok("A7 explain intent → no deliverables, no stages", (() => { const sp = S("why does my door script error?"); return sp.explainOnly && sp.deliverables.length === 0 && sp.stages.length === 0; })());
  ok("A8 plan-only / review intents track nothing to build", S("review my DataStore code for bugs").deliverables.length === 0 && S("plan how to build an obby lobby, dont build yet").deliverables.length === 0);
  ok("A9 a negated clause removes its domain ('create a door that opens when touched, without any sounds')", (() => { const sp = S("create a door that opens when touched, without any sounds"); return ids(sp).includes("gameplay") && !ids(sp).includes("sfx") && sp.negated.length === 1; })());
  ok("A10 'script' vocabulary folds into the gameplay system (one deliverable, not two)", (() => { const sp = S("make a coin pickup system with a server script and a RemoteEvent"); return ids(sp).includes("gameplay") && !ids(sp).includes("script"); })());
  ok("A11 a lone script request stays a script deliverable", ids(S("write a ModuleScript that formats numbers with commas")).join() === "script");
  ok("A12 animation + LocalScript → anim_playback integration (script counts as the gameplay side)", (() => { const sp = S("add a walk animation to the R15 rig and play it from a LocalScript"); return ids(sp).includes("animation") && sp.integrations.some((i) => i.id === "anim_playback"); })());
  ok("A13 environment request: map + houses + lighting", (() => { const sp = S("make a cozy medieval village map with terrain, houses and ambient lighting"); return ["environment", "model", "vfx"].every((d) => ids(sp).includes(d)) && !ids(sp).includes("sfx"); })());
  ok("A14 blender mode turns a model request into a Blender deliverable", ids(S("build a low-poly lantern", { mode: "blender" })).includes("blender"));
  ok("A15 local engine drops Studio deliverables unless Roblox is named", ids(S("create a config.json and a README for the project", { engine: "local" })).join() === "local");
  ok("A16 follow-up inherits the previous spec's deliverables", (() => { const first = S("build a shop GUI and a coin system"); const t2 = O.classifyTask("make it faster", { prev: O.classifyTask("build a shop GUI and a coin system") }); const sp = C.spec("make it faster", { task: t2, prev: first }); return sp.inherited && ids(sp).join() === ids(first).join(); })());
  ok("A17 Turkish build request is understood ('dükkan arayüzü ve coin sistemi yap, ses olmasın')", (() => { const sp = S("oyuncu için bir dükkan arayüzü ve coin sistemi yap, ses olmasın"); return ids(sp).includes("gui") && ids(sp).includes("gameplay") && !ids(sp).includes("sfx") && sp.negated.includes("ses"); })());
  ok("A18 Turkish question stays a question", S("neden kapı scriptim hata veriyor?").deliverables.length === 0);
  ok("A19 fix request on a GUI is tracked as that GUI (proof still required)", ids(S("fix the leaderboard gui")).join() === "gui");
  ok("A20 spec text is capped and never carries the whole prompt", S("x ".repeat(3000)).text.length <= 280);
}

// ── B. brief ──
{
  const sp = S("Build a sword combat system with a shop GUI, hit particles and a slash sound, and save coins with a DataStore.");
  const full = C.brief(sp, {}), tight = C.brief(sp, { tight: true });
  ok("B1 full brief ≤ 760 chars, names the deliverables, the integration and the order", full.length <= 760 && /GUI/.test(full) && /Integration:/.test(full) && /Order:/.test(full), full.length);
  ok("B2 tight brief ≤ 420 chars and still lists every deliverable label", tight.length <= 420 && sp.deliverables.every((d) => tight.includes(d.label)), tight.length);
  ok("B3 brief is a system note, never the user", /not the user/.test(full) && /not the user/.test(tight));
  ok("B4 a one-item request gets no brief on High (briefMin 2) but does on Masterpiece (briefMin 1)", C.brief(S("fix the leaderboard gui"), {}) === "" && C.brief(S("fix the leaderboard gui", { profile: "masterpiece" }), {}) !== "");
  ok("B5 explicit briefMin override is honoured", C.brief(S("fix the leaderboard gui"), { briefMin: 1 }) !== "");
}

// ── C. profiles ──
{
  ok("C1 four profiles with monotone rounds 1/1/2/3 and High+ requiring read-back", C.PROFILE_IDS.join() === "standard,high,professional,masterpiece" && [1, 1, 2, 3].every((n, i) => C.PROFILES[C.PROFILE_IDS[i]].rounds === n) && !C.PROFILES.standard.requireVerify && C.PROFILES.high.requireVerify && C.PROFILES.professional.requireAudit);
  ok("C2 default profile = high; unknown ids normalise to it", C.DEFAULT_PROFILE === "high" && C.normalizeProfile("ultra") === "high" && C.normalizeProfile("Masterpiece") === "masterpiece");
  const noResend = C.profileFor("masterpiece", { id: "deepseek", noResend: true, tightPrompt: false });
  ok("C3 a provider that forbids re-sends caps rounds to 0 and says so", noResend.rounds === 0 && noResend.capped.some((c) => /re-sends/.test(c)));
  const tight = C.profileFor("professional", { id: "chatgpt", tightPrompt: true, sendCharBudget: 1000 });
  ok("C4 compact providers cap review notes (3) and raise the brief threshold (small send budget)", tight.reviewNotes === 3 && tight.briefMin === 3 && tight.tight === true);
  ok("C5 profileFor never mutates the base table", C.PROFILES.masterpiece.rounds === 3 && C.PROFILES.professional.reviewNotes === 6);
}

// ── D. static Luau review ──
{
  const bad = 'local ds = game:GetService("DataStoreService"):GetDataStore("coins")\nlocal p = game.Players.LocalPlayer\nwhile true do end\nloadstring("x")\nrequire(123456)\nworkspace.Part.Touched:Connect(function() end)\nwait(1)\nprint(1) print(2) print(3)';
  const f = C.reviewLuau(bad, { container: "server" });
  const codes = f.map((x) => x.code);
  ok("D1 server script: DataStore without pcall, LocalPlayer, busy loop, loadstring, require(id), Touched without debounce, legacy wait, prints", ["datastore_no_pcall", "server_localplayer", "busy_loop", "loadstring", "require_id", "touched_no_debounce", "legacy_wait", "print_leftover"].every((c) => codes.includes(c)), codes);
  ok("D2 findings carry 1-based lines and sort high → medium → low", f[0].sev === "high" && f.find((x) => x.code === "server_localplayer").line === 2 && f.find((x) => x.code === "legacy_wait").line === 7 && f.every((x, i) => i === 0 || ({ high: 0, medium: 1, low: 2 })[f[i - 1].sev] <= ({ high: 0, medium: 1, low: 2 })[x.sev]));
  ok("D3 clean modern code → no findings", C.reviewLuau('local Players = game:GetService("Players")\nlocal ds = game:GetService("DataStoreService"):GetDataStore("x")\nPlayers.PlayerAdded:Connect(function(plr)\n  local ok, v = pcall(function() return ds:GetAsync(plr.UserId) end)\n  task.wait(1)\nend)', { container: "server" }).length === 0);
  ok("D4 client script: DataStore and Health writes are flagged, LocalPlayer is fine", (() => { const c = C.reviewLuau('local p = game:GetService("Players").LocalPlayer\nlocal ds = game:GetService("DataStoreService")\np.Character.Humanoid.Health = 0', { container: "client" }).map((x) => x.code); return c.includes("client_datastore") && c.includes("client_health") && !c.includes("server_localplayer"); })());
  ok("D5 remote handler without any validation is flagged; with typeof/clamp it is not", C.reviewLuau('re.OnServerEvent:Connect(function(plr, amt) coins.Value += amt end)', { container: "server" }).some((x) => x.code === "remote_no_validation") && !C.reviewLuau('re.OnServerEvent:Connect(function(plr, amt) if typeof(amt) ~= "number" then return end coins.Value += math.clamp(amt, 0, 10) end)', { container: "server" }).some((x) => x.code === "remote_no_validation"));
  ok("D6 module without --!strict is a low finding; with it none", C.reviewLuau("local M = {}\nreturn M", { container: "module" }).map((x) => x.code).join() === "module_no_strict" && C.reviewLuau("--!strict\nlocal M = {}\nreturn M", { container: "module" }).length === 0);
  ok("D7 offset-only GUI and unanchored parts are flagged", C.reviewLuau('local g = Instance.new("ScreenGui")\nlocal f = Instance.new("Frame")\nf.Size = UDim2.new(0, 300, 0, 200)', { container: "client" }).some((x) => x.code === "ui_offset_only") && C.reviewLuau('local p = Instance.new("Part")\np.Parent = workspace', { container: "server" }).some((x) => x.code === "part_unanchored"));
  ok("D7b placeholder asset ids are flagged, real-looking ids are not", C.reviewLuau('s.SoundId = "rbxassetid://12345"\ni.Image = ""', { container: "client" }).filter((x) => x.code === "asset_placeholder").length === 1 && !C.reviewLuau('s.SoundId = "rbxassetid://9118823101"', { container: "client" }).some((x) => x.code === "asset_placeholder"));
  ok("D8 comments never trigger findings", C.reviewLuau("-- wait(1) loadstring('x') while true do\nlocal x = 1\ntask.wait()", { container: "server" }).length === 0);
  const note = C.reviewNote(f, { level: "medium", max: 3 });
  ok("D9 review note: labelled automated, ≤ 420 chars, ≤ 3 items, ends with the next step", /STATIC REVIEW \(TotalScript, automated/.test(note) && note.length <= 420 && (note.match(/\[(high|medium)\]/g) || []).length <= 3 && /script_check/.test(note), note.length);
  ok("D10 tight note ≤ 320 chars; 'high' level drops medium findings", C.reviewNote(f, { level: "medium", max: 3, tight: true }).length <= 320 && !/\[medium\]/.test(C.reviewNote(f, { level: "high", max: 5 })));
  ok("D11 sourceOf finds Luau in source/code/edits and ignores short or non-Luau strings", C.sourceOf({ source: bad }) === bad && C.sourceOf({ code: "local x = game:GetService('Players')" }) !== "" && C.sourceOf({ edits: [{ replace: "local a = 1\nlocal b = function() end" }] }) !== "" && C.sourceOf({ source: "hello" }) === "" && C.sourceOf({ name: "Combat" }) === "");
  ok("D12 containerOf reads kind, parent paths and LocalScript names", C.containerOf("script_create", { kind: "server" }) === "server" && C.containerOf("script_create", { kind: "client" }) === "client" && C.containerOf("script_set_source", { path: "StarterGui.Shop.Main" }) === "client" && C.containerOf("script_set_source", { path: "ServerScriptService.Combat" }) === "server" && C.containerOf("module_scaffold", { parent: "ReplicatedStorage" }) === "module" && C.containerOf("execute_luau", { code: "x" }) === "run");
}

// ── E. tracker: coverage, integration, nudge, report ──
function run(text, profile, caps, steps) {
  const sp = S(text, { profile });
  const T = C.tracker(sp, { profile: C.profileFor(profile, caps || { id: "t" }) });
  const notes = [];
  for (const [tool, args, fb] of steps || []) { const o = T.observe({ tool, arguments: args || {} }, fb || "ok"); if (o.note) notes.push(o.note); }
  return { sp, T, notes };
}
const SERVER_BAD = 'local Players = game.Players\nlocal ds = game:GetService("DataStoreService"):GetDataStore("coins")\nlocal re = game.ReplicatedStorage.RemoteEvent\nre.OnServerEvent:Connect(function(plr, target)\n  target.Humanoid:TakeDamage(10)\n  wait(1)\nend)';
const SERVER_GOOD = 'local Players = game:GetService("Players")\nlocal RS = game:GetService("ReplicatedStorage")\nlocal ds = game:GetService("DataStoreService"):GetDataStore("coins")\nlocal re = RS:WaitForChild("RemoteEvent")\nre.OnServerEvent:Connect(function(plr, target)\n  if typeof(target) ~= "Instance" then return end\n  target.Humanoid:TakeDamage(10)\n  task.wait(1)\nend)\nPlayers.PlayerAdded:Connect(function(plr) local ok = pcall(function() return ds:GetAsync(plr.UserId) end) end)';
const CLIENT = 'local re = game:GetService("ReplicatedStorage"):WaitForChild("RemoteEvent")\nscript.Parent.Button.MouseButton1Click:Connect(function() re:FireServer(1) end)';
const REQ = "Build a sword combat system with a shop GUI and a slash sound, save coins with a DataStore";
{
  const { T, notes } = run(REQ, "high", null, [
    ["get_studio_state", {}],
    ["script_create", { kind: "server", name: "Combat", parent: "ServerScriptService", source: SERVER_BAD }],
    ["ui_screen_generate", { name: "Shop" }],
  ]);
  const cov = T.coverage();
  ok("E1 coverage: gameplay built (script_create) but not read back; GUI built; data / sfx missing", cov.find((c) => c.id === "gameplay").status === "unverified" && cov.find((c) => c.id === "gui").built && cov.find((c) => c.id === "data").status === "missing" && cov.find((c) => c.id === "sfx").status === "missing", cov.map((c) => c.id + ":" + c.status));
  ok("E2 the static review rode on the bad server script (DataStore without pcall first, more findings counted)", notes.length === 1 && /STATIC REVIEW/.test(notes[0]) && /pcall/.test(notes[0]) && /\+\d more|trusts the client/.test(notes[0]) && notes[0].length <= 420, notes);
  const n1 = T.nudge({ resendAllowed: true });
  ok("E3 first nudge lists the missing items, the build and proof commands, labels itself derived from the log, ≤ 1400 chars", /CREATION CHECK 1\/1/.test(n1) && /Saved data/.test(n1) && /NOT BUILT/.test(n1) && /NOT READ BACK/.test(n1) && /command log/.test(n1) && n1.length <= 1400, n1.length);
  ok("E4 High = one round: the second call is empty even though items are still missing", T.nudge({ resendAllowed: true }) === "" && T.state.rounds === 1);
  ok("E5 resendAllowed=false never produces a nudge", (() => { const r = run(REQ, "masterpiece", null, [["ui_screen_generate", {}]]); return r.T.nudge({ resendAllowed: false }) === "" && r.T.state.rounds === 0; })());
  const rep = T.report();
  ok("E6 report: counts only (no score), level incomplete, names the missing domains, states rounds used", /derived from the command log/.test(rep.text) && !/\/100|score/i.test(rep.text) && rep.level === "incomplete" && rep.missing.includes("data") && rep.missing.includes("sfx") && /creation checks sent 1\/1/.test(rep.text), rep.text);
}
{
  // Professional: two rounds, but the second only after progress
  const { T } = run(REQ, "professional", null, [
    ["script_create", { kind: "server", name: "Combat", parent: "ServerScriptService", source: SERVER_BAD }],
  ]);
  ok("E7 Professional first round fires", /CREATION CHECK 1\/2/.test(T.nudge({ resendAllowed: true })));
  ok("E8 no successful relevant command since the last round → no second round (no-progress stop), report says so", T.nudge({ resendAllowed: true }) === "" && T.state.stoppedNoProgress === true && /stopped early/.test(T.report().text));
  const r2 = run(REQ, "professional", null, [["script_create", { kind: "server", name: "Combat", parent: "ServerScriptService", source: SERVER_BAD }]]);
  r2.T.nudge({ resendAllowed: true });
  r2.T.observe({ tool: "ui_screen_generate", arguments: { name: "Shop" } }, "ok");
  ok("E9 progress after round 1 → round 2 is sent", /CREATION CHECK 2\/2/.test(r2.T.nudge({ resendAllowed: true })));
}
{
  // Full happy path on Professional: everything built, read back, integrated, audited
  const { T, notes } = run(REQ, "professional", null, [
    ["get_studio_state", {}],
    ["datastore_profile_scaffold", { name: "Coins" }],
    ["script_create", { kind: "server", name: "Combat", parent: "ServerScriptService", source: SERVER_BAD }],
    ["script_set_source", { path: "ServerScriptService.Combat", source: SERVER_GOOD }],
    ["script_create", { kind: "client", name: "ShopClient", parent: "StarterGui", source: CLIENT }],
    ["ui_screen_generate", { name: "Shop" }],
    ["ui_sound_effects_wire", { screen: "Shop" }],
    ["sfx_event_define", { name: "slash" }],
    ["sfx_event_play", { name: "slash" }],
    ["script_check", { path: "ServerScriptService.Combat" }],
    ["ui_audit", {}],
    ["sfx_validate", {}],
    ["ds_get", { key: "1" }],
    ["bench_run", {}],
    ["quality_audit", {}],
    ["start_stop_play", {}],
  ]);
  const cov = T.coverage(), integ = T.integration(), rep = T.report();
  ok("E10 every deliverable built + read back + audited → all ok", cov.every((c) => c.status === "ok"), cov.map((c) => c.id + ":" + c.status));
  ok("E11 integration: remote both sides, DataStore pcall, sfx played, button sounds wired → ok", integ.filter((i) => ["gui_remote", "data_pcall", "sfx_trigger", "sfx_gui"].includes(i.id)).every((i) => i.status === "ok"), integ.map((i) => i.id + ":" + i.status + ":" + i.why));
  ok("E12 no nudge when nothing is missing; report level complete, static review shows raised AND resolved", T.nudge({ resendAllowed: true }) === "" && rep.level === "complete" && rep.review.raised >= 2 && rep.review.resolved >= 2 && rep.review.open.length === 0, rep.text);
  ok("E13 the bad script got a note, the rewritten clean script did not (notes bounded by profile.reviewNotes)", notes.length === 1);
  ok("E14 inspect-first satisfied (read before mutate) → report has no process warning", rep.builtBeforeRead === false && !/before any read/.test(rep.text));
}
{
  const { T } = run(REQ, "professional", null, [["ui_screen_generate", { name: "Shop" }], ["get_studio_state", {}]]);
  ok("E15 Professional flags a mutation before the first read of the place", T.report().builtBeforeRead === true && /before any read/.test(T.report().text));
}
{
  // Standard: no read-back requirement, integration not demanded
  const { T } = run(REQ, "standard", null, [
    ["script_create", { kind: "server", name: "Combat", parent: "ServerScriptService", source: SERVER_BAD }],
    ["ui_screen_generate", { name: "Shop" }], ["sfx_event_define", {}], ["ds_set", {}],
  ]);
  ok("E16 Standard accepts built-but-unverified work and does not list integration gaps", T.coverage().every((c) => c.status === "ok") && T.missing().length === 0 && T.nudge({ resendAllowed: true }) === "");
  ok("E17 Standard still reports integration status (informational) in the report", /Integration/.test(T.report().text));
}
{
  // Failed builds are never success; a failed write gets no static note
  const { T, notes } = run("make a shop gui", "high", null, [["ui_screen_generate", { name: "Shop" }, "ERROR: Studio offline"], ["script_create", { kind: "server", source: SERVER_BAD }, "ERROR: syntax"]]);
  const c = T.coverage()[0];
  ok("E18 a failed build counts as failed (not built), the nudge says so, no review note on a failed write", c.status === "failed" && /failed attempt/.test(T.nudge({ resendAllowed: true })) && notes.length === 0 && T.report().failed === 2);
}
{
  // Tight provider: short nudge, short notes
  const { T, notes } = run(REQ, "high", { id: "chatgpt", tightPrompt: true, sendCharBudget: 6000 }, [["script_create", { kind: "server", name: "Combat", parent: "ServerScriptService", source: SERVER_BAD }]]);
  const n = T.nudge({ resendAllowed: true });
  ok("E19 tight provider: nudge ≤ 460 chars, still names the missing items; review note ≤ 320", n.length <= 460 && /Still missing/.test(n) && /GUI/.test(n) && notes[0].length <= 320, n.length);
}
{
  // execute_luau that creates things counts for the matching family
  const { T } = run("make a shop gui and a coin system", "standard", null, [["execute_luau", { code: 'local g = Instance.new("ScreenGui") g.Parent = game.StarterGui\nlocal s = Instance.new("Script") s.Source = "x" s.Parent = game.ServerScriptService' }]]);
  ok("E20 execute_luau creating a ScreenGui + Script is build evidence for gui + gameplay", T.coverage().every((c) => c.built));
  ok("E21 event log is bounded (400)", (() => { const r = run("make a shop gui", "standard"); for (let i = 0; i < 450; i++) r.T.observe({ tool: "ui_set_text", arguments: {} }, "ok"); return r.T.events.length === 400; })());
}

// ── F. every build / proof family matches at least one real command ──
{
  const names = new Set();
  for (const f of fs.readdirSync(path.join(root, "src/core/skills")).filter((x) => x.endsWith(".js"))) for (const m of read("src/core/skills/" + f).matchAll(/name: "([a-z][a-z0-9_]+)"/g)) names.add(m[1]);
  for (const f of ["src/core/main.js", "src/core/animengine.js", "src/core/config.js", "src/core/assetplan.js", "src/core/meshimport.js", "src/core/studio_bridge.js"]) for (const m of read(f).matchAll(/name: "([a-z][a-z0-9_]+)"/g)) names.add(m[1]);
  const list = [...names];
  const unmatched = [];
  for (const id of C.DOMAIN_IDS) { if (id === "local" || id === "blender") continue; for (const k of ["did", "proof", "audit"]) if (!list.some((n) => C.DOMAINS[id][k].test(n))) unmatched.push(id + "." + k); }
  ok("F1 every Studio domain's did / proof / audit family matches a real catalogue command (" + list.length + " names)", unmatched.length === 0, unmatched);
  const mainMatches = (re) => re.test("write_file") || re.test("read_file") || re.test("run_command");
  ok("F2 local-engine families cover the AgentScript file tools", mainMatches(C.DOMAINS.local.did) && mainMatches(C.DOMAINS.local.proof) && /blender_asset_build/.test("blender_asset_build") && C.DOMAINS.blender.did.test("blender_asset_build") && C.DOMAINS.blender.proof.test("blender_asset_validate"));
}

// ── G. wiring pins ──
{
  const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
  ok("G1 manifest: creation_engine.js right after orchestrator.js and before main.js in all " + bundles.length + " bundles", bundles.length >= 12 && bundles.every((c) => { const i = c.js.indexOf("src/core/creation_engine.js"); return i > 0 && c.js[i - 1] === "src/core/orchestrator.js" && i < c.js.indexOf("src/core/main.js"); }));
  ok("G2 codecraft.html loads it after orchestrator.js", html.indexOf('src="src/core/creation_engine.js"') > html.indexOf('src="src/core/orchestrator.js"') && html.indexOf('src="src/core/creation_engine.js"') < html.indexOf('src="src/core/main.js"'));
  ok("G3 main.js: tracker starts with the task classification (startCreationTracker) and the spec is logged", /A\.task = ORCH\.classifyTask\(text, \{ prev \}\); A\.task\.riderSent = false; try \{ startCreationTracker\(text\); \} catch \{\}/.test(main) && /function startCreationTracker\(text\)/.test(main) && /diag\("creation\.spec"/.test(main));
  ok("G4 main.js: every tool result passes through A.creation.observe AFTER compression + mode auto-check, note appended", (() => { const i = main.indexOf("feedback = await attachModeAutoCheck(call.tool, call.arguments, feedback)"); const j = main.indexOf("A.creation.observe(call, feedback"); return i > 0 && j > i && j - i < 900 && /feedback \+= "\\n" \+ o\.note/.test(main); })());
  ok("G5 main.js: the creation brief rides on the first result inside the send budget", /TotalCreation\.brief\(A\.creation\.spec, \{ tight, briefMin: A\.creation\.profile\.briefMin \}\)/.test(main) && /diag\("creation\.briefSent"/.test(main) && /diag\("creation\.briefSkipped"/.test(main));
  ok("G6 main.js: COVERAGE GATE runs before the mode gate, only when re-sends are allowed, uses the standard gate pattern", (() => { const i = main.indexOf("A.creation.nudge({ resendAllowed: true })"); const j = main.indexOf("const nudge = modeGateNudge(A.runTools);"); return i > 0 && j > i && /if \(A\.creation && resendAllowed\(\) && !A\.stop && toolTurns >= 1\)/.test(main) && /diag\("loop\.creationGate"/.test(main) && main.slice(i, j).includes("base = await submitAndGetBase(cn + (state"); })());
  ok("G7 main.js: end-of-run CREATION REPORT → diag + Activity card (≤120-char short line) + popup note; never sent to the model", /diag\("loop\.creationReport"/.test(main) && /ui\.trackCard\("creation report", rep\.level === "complete" \? "ok" : "err", rep\.short, "creation"\)/.test(main) && /type: "activity_note", kind: "creation"/.test(main) && !/submitAndGetBase\(rep\.text/.test(main));
  ok("G8 main.js: rsCreationProfile setting (load, set, storage sync, window.__rsCreationProfile) + tray section with 4 profile cards", /chrome\.storage\.local\.get\("rsCreationProfile"/.test(main) && /rsCreationProfile: creationProfile/.test(main) && /changes\.rsCreationProfile/.test(main) && /window\.__rsCreationProfile = \(\) => creationProfile/.test(main) && /function creationSectionHtml\(\)/.test(main) && /\$\{creationSectionHtml\(\)\}/.test(main) && /data-cprofile="\$\{id\}"/.test(main) && /querySelectorAll\("\[data-cprofile\]"\)/.test(main));
  ok("G9 main.js: the profile is capped by the provider (ORCH.capabilities + pacing noResend)", /TotalCreation\.profileFor\(sp\.profile, caps\)/.test(main) && /noResend: !!\(P\.pacing && P\.pacing\.noResend && gentlePacingOn\(\)\)/.test(main));
  ok("G10 background.js: activity_note handler whitelists kind / level and caps text at 200", /case "activity_note":/.test(bg) && /\/\^\(creation\|tool\|server\)\$\//.test(bg) && /\/\^\(ok\|info\|warn\|error\)\$\//.test(bg) && /slice\(0, 200\)/.test(bg.slice(bg.indexOf('case "activity_note":'), bg.indexOf('case "activity_note":') + 900)));
  ok("G11 popup: Creation quality select in AI & Agents, key exported/imported, Activity filter chip", /key: "rsCreationProfile", type: "select", default: "high"/.test(popup) && /const CREATION_PROFILES = \[\["standard", "Standard"\], \["high", "High quality"\], \["professional", "Professional"\], \["masterpiece", "Masterpiece"\]\]/.test(popup) && /"rsPlanMode", "rsCreationProfile",/.test(popup) && /data-f="creation"/.test(popupHtml));
  ok("G12 orchestrator capabilities expose pacingNoResend / commandFormat / commandlessRetries from real adapter fields only", (() => { const c = O.capabilities({ id: "x" }); const v = O.capabilities({ id: "v", commandFormat: "plain", commandlessRetries: 2, pacing: { noResend: true, minGapMs: 8000 } }); return c.pacingNoResend === false && c.commandFormat === "json" && c.commandlessRetries === null && c.pacing === null && v.pacingNoResend && v.commandFormat === "plain" && v.commandlessRetries === 2 && v.pacing.minGapMs === 8000; })());
  ok("G13 versions: creation_engine 2.13.0, no numeric quality score anywhere in the module", C.VERSION === "2.13.0" && !/quality score|\/100|\b\d+ ?\/ ?10\b|score:/i.test(read("src/core/creation_engine.js")));
}

// ── H. real page walk (codecraft.html bundle in jsdom): tray section + hooks ──
(async () => {
  let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch { console.log("skip H (jsdom not installed: NODE_PATH=/tmp/harness/node_modules)"); }
  if (JSDOM) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pageHtml = read("codecraft.html");
    const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
    const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
    const w = dom.window, d = w.document;
    Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true }); Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
    Object.defineProperty(d, "hidden", { value: false, configurable: true }); Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
    w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} }; };
    w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
    Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return 860; }, configurable: true });
    Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; }, configurable: true });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return d.body; }, configurable: true });
    Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
    w.HTMLElement.prototype.scrollIntoView = function () {}; w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
    w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16); w.cancelAnimationFrame = (id) => clearTimeout(id);
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.elementFromPoint = d.elementFromPoint = () => null; d.execCommand = () => false;
    w.HTMLCanvasElement.prototype.getContext = () => null;
    if (!w.crypto) w.crypto = require("crypto").webcrypto;
    w.Audio = class { play() { return Promise.resolve(); } pause() {} }; w.AudioContext = undefined;
    w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
    w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" };
    w.URL.createObjectURL = () => "blob:harness"; w.URL.revokeObjectURL = () => {};
    w.open = () => null; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
    const storage = {};
    const storageApi = () => ({
      get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
      set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
      remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    });
    const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
    const notes = [];
    const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true }; case "studio_status": return { ok: true, studio: true }; case "call_tool": return { ok: true, text: "ok" }; case "activity_note": notes.push(msg); return { ok: true }; default: return { ok: true, tools: TOOLS }; } };
    w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {} }, lastError: null, getManifest: () => manifest }, storage: { local: storageApi(), sync: storageApi(), session: storageApi(), onChanged: { addListener() {} } }, tabs: { create() {} } };
    storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
    storage.rsSettingsAdvanced = true;
    storage.rsCreationProfile = "professional"; // stored choice must be restored
    w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
    const pageErrors = []; w.onerror = (m) => { pageErrors.push(String(m)); };
    for (const sc of scripts) { const el = d.createElement("script"); el.textContent = read(sc) + "\n//# sourceURL=" + sc; d.body.appendChild(el); }
    async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout: " + label); }
    try {
      await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
      await sleep(700);
      ok("H1 page: TotalCreation is loaded in the bundle and the stored profile is restored", typeof w.TotalCreation === "object" && w.TotalCreation.VERSION === "2.13.0" && typeof w.__rsCreationProfile === "function" && w.__rsCreationProfile() === "professional", w.__rsCreationProfile && w.__rsCreationProfile());
      const supportBtn = d.getElementById("rs-support-btn") || d.getElementById("rs-settings-btn");
      if (supportBtn) { supportBtn.click(); await sleep(150); }
      const menu = d.getElementById("rs-menu");
      const sec = menu && menu.querySelector(".rs-creation-sec");
      const cards = sec ? [...sec.querySelectorAll("[data-cprofile]")] : [];
      ok("H2 tray: Creation quality section with four cards, Professional selected, state label shows rounds", cards.length === 4 && cards.map((c) => c.dataset.cprofile).join() === "standard,high,professional,masterpiece" && cards[2].classList.contains("on") && /Professional · 2 checks/.test(sec.querySelector(".rs-sec-state").textContent), sec && sec.textContent.slice(0, 200));
      ok("H3 tray: the section sits after Access (the effort section keeps its 'right before Access' pin)", (() => { const secs = [...menu.querySelectorAll(".rs-menu-sec")]; const i = secs.indexOf(sec); const labels = secs.map((x) => (x.querySelector(".rs-sec-label span") || {}).textContent || ""); return i > 0 && labels[i - 1] === "Access"; })());
      cards[3].click(); await sleep(250);
      ok("H4 tray: clicking Masterpiece stores rsCreationProfile, updates the hook and re-renders the card as selected", storage.rsCreationProfile === "masterpiece" && w.__rsCreationProfile() === "masterpiece" && d.getElementById("rs-menu").querySelector('[data-cprofile="masterpiece"]').classList.contains("on"));
      ok("H5 page: no page errors while loading the bundle with the creation engine", pageErrors.length === 0, pageErrors.slice(0, 3));
    } catch (e) { ok("H walk: completed", false, String(e && e.stack || e)); }
    try { dom.window.close(); } catch {}
  }
  console.log(`\ntest-creation-engine: ${pass + fail} checks, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
