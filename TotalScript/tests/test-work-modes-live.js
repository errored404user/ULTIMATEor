#!/usr/bin/env node
// 1.99.9 — work modes DO something: preflight facts, live gate tracker,
// enforced gates + verdict, read-back auto-checks, Blender precondition.
// Pure-module checks for src/core/work_modes.js plus main.js / manifest /
// overlay.css wiring pins. Run from the TotalScript root:
//   node tests/test-work-modes-live.js
// Mocked only: no Studio / Blender / provider is involved (tests/work-modes-sim.py
// executes the probe Luau on the lupa DataModel).
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); } };

const W = require(path.join(ROOT, "src/core/work_modes.js"));
const main = read("src/core/main.js");
const css = read("overlay.css");
const manifest = JSON.parse(read("manifest.json"));
const html = read("codecraft.html");

// MODE_GATES from main.js (the real regexes) — evaluated in isolation.
const gatesSrc = main.slice(main.indexOf("  const MODE_GATES = {"), main.indexOf("  const MODE_GATE_ROUNDS"));
const MODE_GATES = new Function(gatesSrc + "\nreturn MODE_GATES;")();

// ── module surface ──────────────────────────────────────────────────────────
ok("A1 TotalWorkModes VERSION 2.0.0, ids creation/blender/animate, frozen", W.VERSION === "2.0.0" && JSON.stringify(W.IDS) === JSON.stringify(["creation", "blender", "animate"]) && Object.isFrozen(W));
ok("A2 normalize() maps unknown / animator → creation and keeps the three ids", W.normalize("animator") === "creation" && W.normalize("ANIMATE") === "animate" && W.normalize("blender") === "blender" && W.normalize() === "creation");
ok("A3 DOES text per mode names concrete behaviours (preflight, gate strip, read back, verdict)", W.IDS.every((id) => /[Pp]reflight/.test(W.DOES[id]) && /gate strip/i.test(W.DOES[id]) && /read back/i.test(W.DOES[id]) && /verdict/i.test(W.DOES[id])));
ok("A4 GATE_LABEL covers every MODE_GATES id", Object.values(MODE_GATES).flat().every((g) => W.GATE_LABEL[g.id]));

// ── preflight ───────────────────────────────────────────────────────────────
const pc = W.preflight("creation", { engine: "roblox" });
const pa = W.preflight("animate", { engine: "roblox" });
ok("B1 creation / animate preflight = read-only execute_luau probes (JSONEncode, no Instance.new / Destroy / Source=)", pc && pa && pc.kind === "luau" && pa.kind === "luau" && [pc.code, pa.code].every((c) => /return hs:JSONEncode\(out\)/.test(c) && !/Instance\.new|:Destroy\(|\.Source\s*=|:ClearAllChildren/.test(c)));
ok("B2 probe Luau stays plain Lua (no +=, no continue) so the lupa sim can run it", [pc.code, pa.code, W.readbackLua("Workspace.X")].every((c) => !/\+=/.test(c) && !/\bcontinue\b/.test(c)));
ok("B3 animate probe reads rigs (RigType, Animator, Motor6D, HRP), KeyframeSequences, Animation objects and ReplicatedStorage.TotalAnimations.AnimPlayer", /RigType/.test(pa.code) && /Animator/.test(pa.code) && /Motor6D/.test(pa.code) && /HumanoidRootPart/.test(pa.code) && /KeyframeSequence/.test(pa.code) && /IsA\('Animation'\)/.test(pa.code) && /TotalAnimations/.test(pa.code) && /AnimPlayer/.test(pa.code) && /seen<8/.test(pa.code));
ok("B4 creation probe reads parts / anchoring / models / scripts / GUIs / remotes / Lighting / Total_ProjectIndex / _TotalBench / Selection / RunService", ["BasePart", "Anchored", "LuaSourceContainer", "ScreenGui", "RemoteEvent", "Lighting", "Total_ProjectIndex", "_TotalBench", "Selection", "IsRunning"].every((k) => pc.code.includes(k)));
ok("B5 local engine → no preflight; blender mode → get_scene_info only when connected, null when not", W.preflight("creation", { engine: "local" }) === null && W.preflight("blender", { engine: "roblox", blenderConnected: false }) === null && (() => { const b = W.preflight("blender", { engine: "roblox", blenderConnected: true }); return b && b.kind === "blender" && b.tool === "get_scene_info"; })());
ok("B6 probe timeout is bounded (8 s)", pc.timeoutMs === 8000 && W.PROBE_TIMEOUT_MS === 8000);

const animData = { mode: "animate", rigs: [{ path: "Workspace.Hero", rig: "R15", animator: true, motors: 15, hrp: true }, { path: "ServerStorage.Bot", rig: "R6", animator: false, motors: 0, hrp: true }], clips: 2, clipNames: ["Idle", "Run"], animations: 0, animPlayer: false, selection: ["Workspace.Hero"], playing: false };
const ba = W.renderBrief("animate", animData);
ok("C1 animator brief: header, both rigs with facts, fix list for the broken rig", /^━━━ ANIMATOR PREFLIGHT \(System note from TotalScript, not the user\) ━━━/.test(ba) && /Workspace\.Hero \[R15, 15 Motor6D, Animator\]/.test(ba) && /ServerStorage\.Bot \[R6, 0 Motor6D, NO Animator\]/.test(ba) && /Fix first: ServerStorage\.Bot has no Motor6D joints[^\n]*no Animator/.test(ba));
ok("C2 animator brief: clips by name, AnimPlayer NOT installed → anim_player_install, selection recognised as a rig", /Clips: 2 KeyframeSequences \(Idle, Run\)/.test(ba) && /AnimPlayer \(ReplicatedStorage\.TotalAnimations\.AnimPlayer\): NOT installed - anim_player_install/.test(ba) && /Selected in Studio: Workspace\.Hero \(a rig/.test(ba));
const baEmpty = W.renderBrief("animate", { rigs: [], clips: 0, clipNames: [], animPlayer: true, selection: [], playing: true });
ok("C3 animator brief with no rig says NONE + dummy_spawn / Rig Builder, AnimPlayer installed, and warns Studio is PLAYING", /Rigs: NONE found/.test(baEmpty) && /dummy_spawn/.test(baEmpty) && /animation_select_rig/.test(baEmpty) && /AnimPlayer[^\n]*: installed/.test(baEmpty) && /Studio is PLAYING/.test(baEmpty));
const bc = W.renderBrief("creation", { parts: 120, unanchored: 3, models: 7, scripts: 4, guis: 1, remotes: 2, lighting: { technology: "Future", clock: 14.5, atmosphere: true, bloom: false }, selection: ["Workspace.Lobby"], index: true, bench: false, playing: false });
ok("C4 totality brief: counts, lighting, unanchored warning, selection as default target, project index hint", /^━━━ TOTALITY PREFLIGHT/.test(bc) && /120 parts \(3 unanchored\) · 7 models · 4 scripts · 1 ScreenGuis · 2 remotes · Lighting Future @ 14\.5h, Atmosphere/.test(bc) && /3 unanchored parts will fall/.test(bc) && /Selected in Studio: Workspace\.Lobby - the user's selection is the default target/.test(bc) && /Total_ProjectIndex exists/.test(bc));
const bcEmpty = W.renderBrief("creation", { parts: 0, unanchored: 0, models: 0, scripts: 0, guis: 0, remotes: 0, lighting: {}, selection: [] });
ok("C5 totality brief on an empty place says EMPTY - build, do not look for content", /The place is EMPTY/.test(bcEmpty));
const bNull = W.renderBrief("creation", null);
ok("C6 failed probe → honest 'could not be read' note (no invented counts), never an empty brief", /could not be read/.test(bNull) && !/\d+ parts/.test(bNull) && /get_studio_state/.test(bNull));
const bb = W.renderBrief("blender", "Scene: 12 objects, 2 cameras, 1 light");
ok("C7 blender brief carries the get_scene_info text + the ASSET / IMPORT rule and the auto read-back promise", /^━━━ BLENDER PREFLIGHT/.test(bb) && /Scene: 12 objects/.test(bb) && /blender_asset_validate/.test(bb) && /mesh_import_verify/.test(bb) && /get_object_info/.test(bb));
const longData = { rigs: Array.from({ length: 8 }, (_, i) => ({ path: "Workspace.VeryLongRigNameNumber" + i + ".Deep.Path.Here", rig: "R15", animator: false, motors: 0, hrp: false })), clips: 8, clipNames: Array.from({ length: 8 }, (_, i) => "ClipNameNumber" + i), selection: ["Workspace.A", "Workspace.B", "Workspace.C"] };
ok("C8 brief is capped at BRIEF_MAX (1200) and ends cleanly", W.renderBrief("animate", longData).length <= W.BRIEF_MAX && W.renderBrief("animate", longData).endsWith("…"));
ok("C9 briefSummary is short UI text per mode", W.briefSummary("animate", animData) === "2 rig(s) · 2 clip(s) · AnimPlayer missing" && /120 parts · 4 scripts · 1 GUIs · 2 remotes/.test(W.briefSummary("creation", { parts: 120, scripts: 4, guis: 1, remotes: 2 })) && W.briefSummary("creation", null) === "place not read (probe failed)");
ok("C10 parseResult tolerates prefixed / wrapped JSON and rejects garbage", W.parseResult("Output of 'execute_luau':\n{\"a\":1}").a === 1 && W.parseResult("{\"b\":2}").b === 2 && W.parseResult("nope") === null && W.parseResult("") === null);

// ── gate tracker ────────────────────────────────────────────────────────────
const stIdle = W.gateStates(MODE_GATES.creation, []);
ok("D1 gateStates idle: every creation gate '–' in MODE_GATES order", stIdle.map((s) => s.id).join(",") === "scripts,look,motion,quality,systems" && stIdle.every((s) => s.state === "idle"));
const stPend = W.gateStates(MODE_GATES.creation, new Set(["script_create", "lighting_preset"]));
ok("D2 did-family ran without proof → pending (scripts + look), others idle", stPend.find((s) => s.id === "scripts").state === "pending" && stPend.find((s) => s.id === "look").state === "pending" && stPend.find((s) => s.id === "quality").state === "idle");
const stProved = W.gateStates(MODE_GATES.creation, ["roblox/script_create", "script_check", "lighting_preset", "total_screenshot", "model_build", "quality_audit"]);
ok("D3 did + proof (server-prefixed names too) → proved for scripts / look / quality; a proof without a did (motion ← total_screenshot) stays idle", ["scripts", "look", "quality"].every((id) => stProved.find((s) => s.id === id).state === "proved") && stProved.find((s) => s.id === "motion").state === "idle");
ok("D4 gateStrip text + HTML (escaped, per-state classes, badge)", W.gateStrip("creation", stPend) === "TOTALITY SCRIPTS ◌ · LOOK ◌ · MOTION – · QUALITY – · SYSTEMS –" && /<b>TOTALITY<\/b>/.test(W.gateStripHtml("creation", stPend)) && /class="rs-gate rs-gate-pending"/.test(W.gateStripHtml("creation", stPend)) && !/</.test(W.gateStrip("creation", stPend)));
const stAnim = W.gateStates(MODE_GATES.animate, ["animation_generate", "anim_player_install", "animation_preview"]);
ok("D5 animate gates: rig proved by animation_preview, playback pending (no script_check / playtest)", stAnim.find((s) => s.id === "rig").state === "proved" && stAnim.find((s) => s.id === "playback").state === "pending" && stAnim.map((s) => s.id).join(",") === "rig,playback,scripts,look");
const stBl = W.gateStates(MODE_GATES.blender, ["blender_asset_build", "blender_send_to_studio", "mesh_import_verify"]);
ok("D6 blender gates: asset pending, import proved", stBl.find((s) => s.id === "asset").state === "pending" && stBl.find((s) => s.id === "import").state === "proved");

// ── verdict ─────────────────────────────────────────────────────────────────
ok("E1 verdict: nothing gated ran", W.verdict("creation", stIdle, 0) === "TOTALITY gates: no gated family ran" && W.verdictLevel(stIdle) === "none");
ok("E2 verdict: open gates named with the missing proof + reminder count", W.verdict("creation", stPend, 2) === "TOTALITY gates: SCRIPTS ✗ LOOK ✗ — SCRIPTS ✗ (script_read / script_check / playtest never ran), LOOK ✗ (total_screenshot never ran) after 2 reminders" && W.verdictLevel(stPend) === "open");
ok("E3 verdict: all touched gates proved", /^TOTALITY gates: SCRIPTS ✓ LOOK ✓ QUALITY ✓ — all 3 touched gates proved$/.test(W.verdict("creation", stProved, 0)) && W.verdictLevel(stProved) === "proved");
ok("E4 verdict for animate names RIG ✓ PLAYBACK ✗ (script_check + playtest never ran)", /ANIMATOR gates: RIG ✓ PLAYBACK ✗ — PLAYBACK ✗ \(script_check \+ playtest never ran\)/.test(W.verdict("animate", stAnim, 1)) && /after 1 reminder$/.test(W.verdict("animate", stAnim, 1)));

// ── auto-checks ─────────────────────────────────────────────────────────────
const acPart = W.autoCheck("creation", "roblox/part_create", { name: "Crate", parent: "Workspace" }, "Output of 'part_create':\n{\"ok\":true,\"path\":\"Workspace.Crate\"}");
ok("F1 part_create with a path in the result → read-back Luau probe for that path", acPart && acPart.kind === "luau" && acPart.path === "Workspace.Crate" && /resolve\('Workspace\.Crate'\)/.test(acPart.code) && /GetBoundingBox|Anchored/.test(acPart.code));
ok("F2 path falls back to the arguments (path / parent+name) when the result has none", W.extractPath({ path: "Workspace.Lobby.Door" }, "ok") === "Workspace.Lobby.Door" && W.extractPath({ parent: "game.Workspace", name: "Tree" }, "done") === "game.Workspace.Tree" && W.extractPath({}, "path=ServerScriptService.Main ok") === "ServerScriptService.Main");
ok("F3 read-only / inspection tools never trigger (script_read, quality_audit, total_screenshot, get_*, list_*, ui_inspect)", ["script_read", "quality_audit", "total_screenshot", "get_studio_state", "list_commands", "ui_inspect", "animation_preview", "blender_asset_validate"].every((n) => W.autoCheck("creation", n, { path: "Workspace.X" }, "{\"path\":\"Workspace.X\"}") === null && W.autoCheck("blender", n, { name: "X" }, "ok") === null));
ok("F4 an ERROR result never triggers a read-back", W.autoCheck("creation", "part_create", { path: "Workspace.X" }, "ERROR calling 'part_create': boom") === null);
ok("F5 no extractable path → no probe (no guessing)", W.autoCheck("creation", "part_create", { name: "Crate" }, "ok") === null);
const acAnim = W.autoCheck("animate", "animation_build", { name: "Wave" }, "{\"ok\":true,\"path\":\"ReplicatedStorage.Clips.Wave\"}");
ok("F6 animate: animation_build → KeyframeSequence read-back (keyframes / poses / length / loop / priority)", acAnim && acAnim.kind === "luau" && /GetKeyframes/.test(acAnim.code) && /Priority/.test(acAnim.code) && /Loop/.test(acAnim.code));
ok("F7 animate: creation-only generators do not trigger in animate mode, but dummy_spawn does", W.autoCheck("animate", "ui_screen_generate", { path: "StarterGui.HUD" }, "{\"path\":\"StarterGui.HUD\"}") === null && W.autoCheck("animate", "dummy_spawn", { name: "D" }, "{\"path\":\"Workspace.D\"}") !== null);
const acBl = W.autoCheck("blender", "blender_asset_build", { name: "Lantern", kind: "prop" }, "ok built");
ok("F8 blender: blender_* build → get_object_info {name} (real background.js tool + param)", acBl && acBl.kind === "blender" && acBl.tool === "get_object_info" && acBl.args.name === "Lantern");
ok("F9 blender: validate / inspect / render / status never trigger; send_to_studio falls through to the Studio read-back", W.autoCheck("blender", "blender_asset_inspect", { name: "L" }, "ok") === null && W.autoCheck("blender", "blender_render_shot", { name: "L" }, "ok") === null && (() => { const p = W.autoCheck("blender", "blender_send_to_studio", { name: "L" }, "{\"path\":\"Workspace.Imported.L\"}"); return p && p.kind === "luau"; })());
ok("F10 the Blender tool names used exist in background.js BLENDER_TOOLS", (() => { const bgSrc = read("background.js"); return /btool\("get_object_info"/.test(bgSrc) && /btool\("get_scene_info"/.test(bgSrc) && /name: \{ type: "string" \} \}, \["name"\]\)/.test(bgSrc.slice(bgSrc.indexOf('btool("get_object_info"'), bgSrc.indexOf('btool("get_object_info"') + 200)); })());

const r1 = W.renderAutoCheck(acPart, "{\"found\":true,\"path\":\"Workspace.Crate\",\"class\":\"Part\",\"parts\":1,\"anchored\":1,\"scripts\":0,\"children\":0,\"size\":[4,4,4]}");
ok("G1 renderAutoCheck Part: class · parts · size · anchored a/b", r1 === "[MODE AUTO-CHECK] Workspace.Crate: Part · 1 part · 4.0×4.0×4.0 · anchored 1/1");
const r2 = W.renderAutoCheck(acPart, "{\"found\":true,\"path\":\"Workspace.House\",\"class\":\"Model\",\"parts\":40,\"anchored\":12,\"scripts\":2,\"children\":5,\"size\":[20,10,15]}");
ok("G2 renderAutoCheck Model with unanchored parts → CHECK: 28 unanchored", /Model · 40 parts · 20\.0×10\.0×15\.0 · anchored 12\/40 · 2 scripts — CHECK: 28 unanchored$/.test(r2));
const r3 = W.renderAutoCheck(acAnim, "{\"found\":true,\"path\":\"ReplicatedStorage.Clips.Wave\",\"class\":\"KeyframeSequence\",\"parts\":0,\"anchored\":0,\"scripts\":0,\"keyframes\":1,\"poses\":1,\"length\":0,\"loop\":false}");
ok("G3 renderAutoCheck clip with 1 keyframe → CHECK: fewer than 2 keyframes", /KeyframeSequence · 1 keyframes · 1 poses · 0\.00s — CHECK: fewer than 2 keyframes - nothing moves$/.test(r3));
const r4 = W.renderAutoCheck(acAnim, "{\"found\":true,\"path\":\"Workspace.Hero\",\"class\":\"Model\",\"parts\":16,\"anchored\":0,\"rigType\":\"R15\",\"animator\":false,\"motors\":15,\"hrp\":true}");
ok("G4 renderAutoCheck rig: rig R15 · Motor6D · NO Animator → CHECK (no unanchored nag for rigs)", /rig R15 · 15 Motor6D · NO Animator — CHECK: no Animator$/.test(r4) && !/unanchored/.test(r4));
ok("G5 renderAutoCheck NOT FOUND is explicit and names the path", /^\[MODE AUTO-CHECK\] Workspace\.Crate: NOT FOUND after the command/.test(W.renderAutoCheck(acPart, "{\"found\":false,\"path\":\"Workspace.Crate\"}")));
ok("G6 renderAutoCheck returns '' for empty / garbage probe output (never invents)", W.renderAutoCheck(acPart, "") === "" && W.renderAutoCheck(acPart, "RUNTIME: boom") === "" && W.renderAutoCheck(null, "{}") === "");
ok("G7 renderAutoCheck blender: prefixed with the tool + object, capped at AUTO_MAX", (() => { const t = W.renderAutoCheck(acBl, "name: Lantern\ntype: MESH\n" + "x".repeat(2000)); return t.startsWith("[MODE AUTO-CHECK get_object_info Lantern] name: Lantern type: MESH") && t.length <= W.AUTO_MAX; })());
ok("G8 renderAutoCheck script: chars + DISABLED / empty Source warning", /Script · 0 chars · DISABLED — CHECK: empty Source$/.test(W.renderAutoCheck(acPart, "{\"found\":true,\"path\":\"ServerScriptService.Main\",\"class\":\"Script\",\"parts\":0,\"anchored\":0,\"scripts\":0,\"sourceLen\":0,\"enabled\":false}")));

// ── precondition ────────────────────────────────────────────────────────────
const pre = W.precondition("blender", { blenderConnected: false });
ok("H1 blender + not connected → hard brief (BLENDER NOT CONNECTED, no execute_luau emulation) + banner title/message", pre.ok === false && /BLENDER NOT CONNECTED/.test(pre.brief) && /Do NOT emulate Blender with execute_luau/.test(pre.brief) && /^━━━ BLENDER PREFLIGHT/.test(pre.brief) && /not connected/.test(pre.title) && /Start MCP Server/.test(pre.message));
ok("H2 blender connected / other modes → ok", W.precondition("blender", { blenderConnected: true }).ok === true && W.precondition("creation", {}).ok === true && W.precondition("animate", { blenderConnected: false }).ok === true);

// ── main.js wiring ──────────────────────────────────────────────────────────
ok("I1 main.js: startModePreflight runs at onUserMessage right after the GUI brief (async, read-only)", /A\.guiBrief = null;\n\s*try \{ A\.guiBrief = ui\.noteGuiRequest\(\); \} catch \{\}\n[\s\S]{0,300}if \(A\.started\) startModePreflight\(\);/.test(main));
ok("I2 main.js: the brief rides on the FIRST tool result via takeModeBrief (next to the GUI brief rider), never the composer", /A\.guiBrief\.sent = true;[\s\S]{0,600}const mb = await takeModeBrief\(\); if \(mb\) \{ toSend \+= "\\n\\n" \+ mb;/.test(main) && !/editorSet\([^)]*modeBrief/.test(main));
ok("I3 main.js: probes go through bg call_tool execute_luau (datamodel Edit) / Blender tool with a bounded race timeout", /name: "execute_luau", arguments: \{ code: probe\.code, datamodel_type: "Edit" \}, timeout: ms \}/.test(main) && /Promise\.race\(\[req, new Promise\(\(res\) => setTimeout\(\(\) => res\(null\), ms\)\)\]\)/.test(main));
ok("I4 main.js: Blender precondition = status → connect attempt, then hard brief + ui.banner (throttled) + Activity card", /async function blenderReady\(\)[\s\S]{0,500}type: "blender_connect"/.test(main) && /brief\.kind = "precondition"; brief\.text = pre\.brief;/.test(main) && /ui\.banner\("warn", pre\.title, pre\.message\)/.test(main));
ok("I5 main.js: gate strip rendered at loop start, after every tool (A.runTools.add) and at completion; exposed as ui.renderModeGates", /A\.runTools = new Set\(\);\n\s*try \{ ui\.renderModeGates\(\); \} catch \{\}/.test(main) && /A\.runTools\.add\(bareToolName\(call\.tool\)\); ui\.renderModeGates\(\);/.test(main) && /renderModeGates, /.test(main.slice(main.indexOf("    return { runTemplateById"))));
ok("I6 main.js: #rs-mode-gates element in the bar + renderModeGates uses TotalWorkModes.gateStates/gateStripHtml on MODE_GATES[workMode]", /<span id="rs-mode-gates" hidden/.test(main) && /function renderModeGates\(\)[\s\S]{0,700}TotalWorkModes\.gateStates\(gates, A\.runTools \|\| \[\]\)[\s\S]{0,200}TotalWorkModes\.gateStripHtml\(workMode, states\)/.test(main));
ok("I7 main.js: mode gate = up to MODE_GATE_ROUNDS (2) per run, counter not boolean, still behind resendAllowed()", /const MODE_GATE_ROUNDS = 2;/.test(main) && /let modeGateRounds = 0;/.test(main) && /if \(modeGateRounds < MODE_GATE_ROUNDS && resendAllowed\(\) && !A\.stop && toolTurns >= 2\)/.test(main) && /modeGateRounds\+\+;/.test(main) && !/modeGateSent/.test(main));
ok("I8 main.js: verdict card + diag loop.modeVerdict right before steeringProgress(\"complete\")", /WM\.verdict\(currentWorkMode\(\), states, modeGateRounds\)[\s\S]{0,400}diag\("loop\.modeVerdict"[\s\S]{0,300}ui\.trackCard\("mode verdict"[\s\S]{0,400}ui\.steeringProgress\("complete"/.test(main));
ok("I9 main.js: auto-check appended AFTER compressToolFeedback (never the dropped part), per executed call with its arguments", /try \{ feedback = compressToolFeedback\(feedback, call\.tool\); \} catch \{\}\n[\s\S]{0,300}feedback = await attachModeAutoCheck\(call\.tool, call\.arguments, feedback\);/.test(main));
ok("I10 main.js: attachModeAutoCheck skips the local engine, requires a live Blender flag for Blender probes, appends (never prefixes) the line", /async function attachModeAutoCheck\(toolName, args, feedback\)[\s\S]{0,300}activeEngine\(\) === "local"\) return feedback;[\s\S]{0,900}return String\(feedback \|\| ""\) \+ "\\n" \+ line;/.test(main) && /probe\.kind === "blender" && !\(A\.bridge && A\.bridge\.blender === true\)\) return feedback;/.test(main));
ok("I11 main.js: mode picker shows a 'What <mode> does while it runs' line from TotalWorkModes.DOES (WORK_MODES literal untouched)", /rs-work-does[\s\S]{0,120}What \$\{escRs\(WORK_MODES\[workMode\]\.name\)\} does while it runs/.test(main) && /const WORK_MODE_IDS = Object\.keys\(WORK_MODES\);/.test(main) && /const WORK_MODES = \{/.test(main));
ok("I12 main.js: existing single-nudge pins intact (modeGateNudge, MODE_GATES ids)", /function modeGateNudge\(runTools\)/.test(main) && ["scripts", "look", "motion", "quality", "systems", "asset", "import", "rig", "playback"].every((id) => new RegExp('id: "' + id + '"').test(gatesSrc)));
ok("I13 main.js: late preflight (still pending after 2.5 s) is dropped honestly, never sent half-done", /if \(b\.pending && b\.promise\) \{ try \{ await Promise\.race\(\[b\.promise, new Promise\(\(res\) => setTimeout\(res, 2500\)\)\]\); \} catch \{\} \}\n\s*if \(b\.pending\) \{ diag\("mode\.preflight", \{ mode: b\.mode, ok: false, late: true \}\); return ""; \}/.test(main));

// ── manifest / html / css ───────────────────────────────────────────────────
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
ok("J1 manifest: work_modes.js loads after orchestrator.js and before public_skills.js / main.js in every main.js bundle (" + bundles.length + ")", bundles.length >= 12 && bundles.every((c) => { const i = c.js.indexOf("src/core/work_modes.js"); return i > c.js.indexOf("src/core/orchestrator.js") && i < c.js.indexOf("src/core/public_skills.js") && i < c.js.indexOf("src/core/main.js"); }));
ok("J2 manifest: gui_standard.js still immediately before skill_intel.js (load-order pin untouched)", bundles.every((c) => c.js.indexOf("src/core/skill_intel.js") === c.js.indexOf("src/core/gui_standard.js") + 1));
ok("J3 codecraft.html loads work_modes.js after orchestrator.js and before main.js", html.indexOf('src="src/core/orchestrator.js"') < html.indexOf('src="src/core/work_modes.js"') && html.indexOf('src="src/core/work_modes.js"') < html.indexOf('src="src/core/main.js"'));
ok("J4 overlay.css styles the gate strip states (pending / proved / level) + light theme + rs-work-does", /#rs-mode-gates \.rs-gate-pending/.test(css) && /#rs-mode-gates \.rs-gate-proved/.test(css) && /#rs-mode-gates\[data-level="open"\]/.test(css) && /html\.rs-light #rs-mode-gates/.test(css) && /\.rs-work-does/.test(css));
ok("J5 work_modes.js is pure: no DOM / chrome / fetch / eval", (() => { const src = read("src/core/work_modes.js"); return !/document\.|chrome\.|fetch\(|\beval\(|new Function/.test(src.replace(/^\/\/.*$/gm, "")); })());

// ── prompts byte-identical (modes change behaviour, not prompt text) ────────
ok("K1 config.js WORK_MODE_PROMPTS / CHECKLIST / PLAYBOOKS untouched by this phase (no 'preflight' / 'gate strip' text added to the prompts)", (() => { const cfg = read("src/core/config.js"); const sec = cfg.slice(cfg.indexOf("const WORK_MODE_PROMPTS"), cfg.indexOf("const WORK_MODE_LABELS")); return !/gate strip|AUTO-CHECK|PREFLIGHT/.test(sec); })());

// ── jsdom walk: the real page with a fake bridge ────────────────────────────
// Boots codecraft.html (every core script incl. work_modes.js + main.js), then:
// the gate strip element exists and renders from the live MODE_GATES, the
// settings tray shows the "What <mode> does" line, and the preflight / auto-
// check helpers call the fake bridge with execute_luau (datamodel Edit).
let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch {}
function finish() { console.log(`\ntest-work-modes-live: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
if (!JSDOM) { console.log("skip jsdom walk (jsdom not installed)"); finish(); }
(async () => {
  const pageHtml = read("codecraft.html");
  const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
  const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
  Object.defineProperty(d, "hidden", { value: false, configurable: true });
  Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
  w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} }; };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return 860; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return d.body; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
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
  const calls = [];
  const background = (msg) => {
    switch (msg && msg.type) {
      case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true };
      case "studio_status": return { ok: true, studio: true };
      case "tools": case "list_tools": return { ok: true, tools: TOOLS };
      case "call_tool": {
        calls.push({ name: msg.name, args: msg.arguments, timeout: msg.timeout });
        const code = String((msg.arguments || {}).code || "");
        if (/mode='animate'/.test(code)) return { ok: true, text: JSON.stringify({ mode: "animate", rigs: [{ path: "Workspace.Hero", rig: "R15", animator: true, motors: 15, hrp: true }], clips: 1, clipNames: ["Idle"], animations: 0, animPlayer: false, selection: [], playing: false }) };
        if (/mode='creation'/.test(code)) return { ok: true, text: JSON.stringify({ mode: "creation", parts: 3, unanchored: 1, models: 0, scripts: 0, guis: 0, remotes: 0, lighting: { technology: "Future", clock: 12 }, selection: [], playing: false }) };
        if (/local target=resolve\(/.test(code)) return { ok: true, text: JSON.stringify({ found: true, path: "Workspace.Crate", class: "Part", parts: 1, anchored: 0, scripts: 0, children: 0, size: [4, 4, 4] }) };
        return { ok: true, text: "ok" };
      }
      case "blender_status": case "blender_connect": return { ok: false, blender: false };
      default: return { ok: true, tools: TOOLS };
    }
  };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {} }, lastError: null, getManifest: () => JSON.parse(read("manifest.json")) }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {} } }, tabs: { create() {} } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  storage.rsWorkMode = "animate";
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const pageErrors = [];
  w.onerror = (m) => { pageErrors.push(String(m)); };
  for (const sc of scripts) { const el = d.createElement("script"); el.textContent = read(sc) + "\n//# sourceURL=" + sc; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }
  try {
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(700);
    ok("walk W1: page boots with TotalWorkModes on window and no page errors", w.TotalWorkModes && w.TotalWorkModes.VERSION === "2.0.0" && pageErrors.length === 0, pageErrors.join(" | "));
    const strip = d.getElementById("rs-mode-gates");
    ok("walk W2: #rs-mode-gates exists in the bar and is hidden before a session starts", !!strip && strip.hidden === true);
    w.__rsSetWorkMode("animate"); await sleep(80);
    const supportBtn = d.getElementById("rs-support-btn") || d.querySelector("[data-rs-menu], #rs-menu-btn, .rs-menu-btn");
    if (supportBtn) { supportBtn.click(); await sleep(150); }
    const menu = d.getElementById("rs-menu");
    const does = menu && menu.querySelector(".rs-work-does");
    ok("walk W3: settings tray shows 'What Animator does while it runs' with the concrete behaviours", !!does && /What Animator does while it runs/.test(does.textContent) && /Preflight lists the rigs/.test(does.textContent) && /gate strip RIG \/ PLAYBACK/.test(does.textContent), does && does.textContent);
    w.__rsSetWorkMode("creation"); await sleep(80);
    const does2 = d.getElementById("rs-menu") && d.getElementById("rs-menu").querySelector(".rs-work-does");
    ok("walk W4: switching to Totality swaps the line (preflight reads the place, SCRIPTS / LOOK / MOTION / QUALITY / SYSTEMS)", !!does2 && /What Totality does while it runs/.test(does2.textContent) && /SCRIPTS \/ LOOK \/ MOTION \/ QUALITY \/ SYSTEMS/.test(does2.textContent), does2 && does2.textContent);
    ok("walk W5: __rsRenderModeGates is exposed and keeps the strip hidden while no agent session is started", typeof w.__rsRenderModeGates === "function" && (w.__rsRenderModeGates(), d.getElementById("rs-mode-gates").hidden === true));
    // Preflight against the fake bridge (animate): execute_luau, Edit datamodel, 8 s budget, facts in the brief.
    w.__rsSetWorkMode("animate"); await sleep(50);
    calls.length = 0;
    const brief = w.__rsModePreflight();
    ok("walk W6: startModePreflight registers a pending brief for the animate mode", !!brief && brief.pending === true && brief.mode === "animate" && brief.sent === false);
    await brief.promise;
    const pf = calls.find((c) => c.name === "execute_luau");
    ok("walk W7: the probe went to the bridge as execute_luau {datamodel_type:Edit} with the 8 s timeout and the animate probe code", !!pf && pf.args.datamodel_type === "Edit" && pf.timeout === 8000 && /mode='animate'/.test(pf.args.code), JSON.stringify(calls.map((c) => c.name)));
    ok("walk W8: the resolved brief carries the rig facts from the (fake) place and is marked unsent until the first result", brief.pending === false && /^━━━ ANIMATOR PREFLIGHT/.test(brief.text) && /Workspace\.Hero \[R15, 15 Motor6D, Animator\]/.test(brief.text) && /AnimPlayer[^\n]*NOT installed/.test(brief.text) && brief.sent === false, brief.text);
    // Auto-check after a successful create command: read-back line appended, never prefixed.
    calls.length = 0;
    w.__rsSetWorkMode("creation"); await sleep(50);
    const fb = await w.__rsModeAutoCheck("roblox/part_create", { name: "Crate", parent: "Workspace" }, "Output of 'part_create':\n{\"ok\":true,\"path\":\"Workspace.Crate\"}");
    ok("walk W9: attachModeAutoCheck ran one execute_luau read-back for Workspace.Crate and appended the fact line with the unanchored CHECK", calls.length === 1 && calls[0].name === "execute_luau" && /resolve\('Workspace\.Crate'\)/.test(calls[0].args.code) && fb.startsWith("Output of 'part_create':") && /\n\[MODE AUTO-CHECK\] Workspace\.Crate: Part · 1 part · 4\.0×4\.0×4\.0 · anchored 0\/1 — CHECK: 1 unanchored$/.test(fb), fb);
    calls.length = 0;
    const fbErr = await w.__rsModeAutoCheck("part_create", { name: "Crate" }, "ERROR calling 'part_create': nope");
    ok("walk W10: an ERROR result / a read-only tool never triggers a bridge call", calls.length === 0 && fbErr === "ERROR calling 'part_create': nope" && (await w.__rsModeAutoCheck("script_read", { path: "Workspace.X" }, "{\"path\":\"Workspace.X\"}")) === "{\"path\":\"Workspace.X\"}" && calls.length === 0);
    // Blender precondition: not connected → hard brief + banner, no execute_luau probe.
    calls.length = 0;
    w.__rsSetWorkMode("blender"); await sleep(50);
    const bb2 = w.__rsModePreflight(); await bb2.promise; await sleep(30);
    const bannerEl = [...d.querySelectorAll(".rs-banner")].find((b) => /Blender is not connected/.test(b.textContent));
    ok("walk W11: Blender mode with no Blender → precondition brief (BLENDER NOT CONNECTED) + warn banner, and no Studio probe was run", bb2.kind === "precondition" && /BLENDER NOT CONNECTED/.test(bb2.text) && !!bannerEl && !calls.some((c) => c.name === "execute_luau"), JSON.stringify(calls.map((c) => c.name)));
    ok("walk W12: no uncaught page errors during the walk", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (e) {
    ok("walk: completed without harness exceptions", false, e && e.stack || e);
  }
  finish();
})();
