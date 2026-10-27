"use strict";
// 1.34.0: batched command execution (up to 6 independent commands per reply,
// one combined result), work modes 2.0 (shared OPERATING LOOP + distinct
// profiles, light mode-switch rider, reminder checklist, quick starts), and
// the system-prompt diet that came with it.
const fs = require("fs"), assert = require("assert"), vm = require("vm");
const main = fs.readFileSync("src/core/main.js", "utf8");
const config = fs.readFileSync("src/core/config.js", "utf8");
const parser = fs.readFileSync("src/core/parser.js", "utf8");
let passed = 0;
function ok(name, cond, extra) { if (!cond) { console.error("FAIL  " + name + (extra ? " :: " + extra : "")); process.exitCode = 1; } else { passed++; } }

// ── parser: several commands in one reply all come out ───────────────────────
const RSParse = vm.runInThisContext(parser + "\n;RSParse", { filename: "parser.js" });
const reply = [
  "Creating the three parts now.",
  "```json", '{"command": "part_create", "params": {"name": "Floor", "size": [40, 1, 40]}}', "```",
  "```json", "{“command”: “part_create”, “params”: {“name”: “Wall_N”, “size”: [40, 12, 1]}}", "```",
  "```", "###LUA###", "return workspace:GetChildren()", "###END_LUA###", "```",
  "```json", '{"command": "part_create", "params": {"name": "Floor", "size": [40, 1, 40]}}', "```",
].join("\n");
const calls = RSParse.parseToolCalls(reply);
ok("parser returns every command of a multi-command reply (curly quotes included)", calls.length === 4, String(calls.length));
ok("parser keeps the order (json, json, lua, json)", calls.map((c) => c.tool).join(",") === "part_create,part_create,execute_luau,part_create");
ok("curly-quoted command parsed with its args", calls[1] && calls[1].arguments && calls[1].arguments.name === "Wall_N");

ok("open-block detection judges the LAST json envelope", RSParse.hasOpenToolBlock('{"command":"a","params":{}}\n{"command":"b","params":{"x":') === true && RSParse.hasOpenToolBlock('{"command":"a","params":{}}\n{"command":"b","params":{}}') === false);
ok("open-block detection judges the LAST lua block", RSParse.hasOpenToolBlock("###LUA###\nreturn 1\n###END_LUA###\n###LUA###\nreturn 2") === true && RSParse.hasOpenToolBlock("###LUA###\nreturn 1\n###END_LUA###\n###LUA###\nreturn 2\n###END_LUA###") === false);
ok("json envelope wrapping execute_luau with inner markers is one call", RSParse.parseToolCalls('{"command":"execute_luau","params":{"code":"###LUA###\\nreturn 1\\n###END_LUA###"}}').length === 1);
ok("lua block whose code contains a json-looking string is one call", RSParse.parseToolCalls('###LUA###\nlocal s = \'{"command": "x"}\'\nreturn s\n###END_LUA###').length === 1);

// ── main.js: the batch loop ───────────────────────────────────────────────────
ok("MAX_BATCH_COMMANDS defaults to 6 (provider override, hard cap 8)", main.includes("const MAX_BATCH_COMMANDS = Math.max(1, Math.min(8, Number(P.maxBatchCommands) || 6));"));
ok("over the cap we still ask for a smaller reply (with the limit)", main.includes("if (calls.length > MAX_BATCH_COMMANDS) {") && main.includes("RS.FEEDBACK.multiTool(calls.map((c) => c.tool || \"?\"), MAX_BATCH_COMMANDS)"));
ok("the old one-command rejection is gone", !main.includes("Model proposed multiple commands — requesting one safe step"));
ok("identical repeats in one reply run once", main.includes("1.34: identical repeats in one reply") && main.includes('diag("tool.dedupe"'));
ok("per-step loop with step chips", main.includes("for (let bi = 0; bi < batchN; bi++) {") && main.includes("`step ${bi + 1}/${batchN} · `") && main.includes("} // end batch loop"));
ok("a failed step stops the batch; the rest is reported NOT RUN", main.includes("if (stepErr) break;") && main.includes("NOT RUN: ${notRun.join(\", \")}") && main.includes("fix step ${failedAt + 1} and resend only the remaining commands"));
ok("combined result is one injected feedback turn (Output of 'batch' / ERROR prefix)", main.includes("`Output of 'batch':\\n${ran} of ${batchN} commands ran (${okCount} ok") && main.includes('(failedAt >= 0 ? "ERROR: " : "")'));
ok("images from every step travel together", main.includes("batchImages = batchImages.concat(A.pendingImages)") && main.includes("A.pendingImages = batchImages.length ? batchImages : null;"));
ok("auto-debug runs once per batch, state tag appended once", main.includes("if (bi === batchN - 1) { try { feedback = await attachAutoDebug(call.tool, feedback); } catch {} }") && main.includes("if (batchN === 1) { const _tag = asStateTag();"));
ok("steering stops a batch between steps and rides on the combined result", main.includes("batchSteer = steerAtDispatch; batchStopped = true; break;") && main.includes("const steerAfter = batchSteer || ui.takeSteeringSteering();") && main.includes("function peekSteeringSteering()") && main.includes("peekSteeringSteering, clearSteeringSteering"));
ok("stop / park abort end the loop as before", main.includes("if (A.stop || batchAbort) break;") && main.includes("if (batchStopped && !batchParts.length) continue;"));
ok("chip summarises the batch", main.includes("const chipName = batchN > 1 ? `${batchParts.length}/${batchN} commands` : call.tool;"));

// ── config: prompts teach batching, feedback explains the cap ────────────────
global.window = global; global.chrome = { runtime: { getURL: () => "" }, storage: { local: { get() {}, set() {} } } };
vm.runInThisContext(config + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
const mt = RS.FEEDBACK.multiTool(["a", "b", "c", "d", "e", "f", "g"], 6);
ok("multiTool feedback names the limit and says nothing ran", /too many commands in one reply \(7; the limit is 6\)/.test(mt) && /Nothing was run/.test(mt));
ok("full prompt rules teach batching", config.includes("BATCHING: up to 6 INDEPENDENT commands per reply, each in its own block; they run in order and you get ONE combined result"));
ok("compact prompt rules teach batching", config.includes("BATCHING: up to 6 INDEPENDENT commands per reply - they run in order and you get ONE combined result"));
ok("AgentScript prompt teaches batching", config.includes("Up to 6 INDEPENDENT commands per reply (they run in order, one combined result; a failed step stops the batch)"));
ok("no 'ONE command per reply' rule left", !/ONE command (block )?per reply/.test(config));

// ── prompt diet ───────────────────────────────────────────────────────────────
for (const wm of ["creation"]) {
  window.__rsWorkMode = () => wm;
  const cat = "━━━ COMMAND CATALOGUE (embedded; this IS the list_commands result) ━━━\nx {}";
  const live = RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox", catalogue: cat });
  ok(wm + ": live full prompt (without the catalogue) is under 38k", live.length - cat.length < 38000, String(live.length - cat.length)); // 1.39.0: one merged profile (~17k with playbooks) instead of ~10k
  ok(wm + ": skills list collapses to a pointer when the catalogue is embedded", live.includes("STUDIO SKILLS & VIRTUAL TOOLS: besides the core MCP tools") && !live.includes("ANIMATION TOOLS: the animation_* tools"));
  const noCat = RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" });
  ok(wm + ": without a catalogue the full skills list is kept", noCat.includes("STUDIO SKILLS & VIRTUAL TOOLS: In addition to core MCP tools") && noCat.includes("ANIMATION TOOLS: the animation_* tools"));
  const tight = RS.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000 });
  ok(wm + ": tight prompt within 14k", tight.length <= 14000, String(tight.length));
  ok(wm + ": tight prompt carries the mode heading", tight.includes("━━━ " + RS.workModeLabel(wm).toUpperCase() + " WORK MODE")); // 1.74.0: id creation is labelled Totality
}
// mode switch rider replaces the whole-prompt restate on a mode change only
ok("mode switch pending flag set by setWorkMode while a session runs", main.includes("try { if (A.started || A.running) { A.workModeSwitchPending = true; A.forceSysResend = true; } } catch {}"));
ok("withSysResend sends the short rider unless the periodic restate is due", main.includes("if (A.workModeSwitchPending && !periodicDue) {") && main.includes('diag("sys.modeSwitch"') && main.includes("A.workModeSwitchPending = false; // the full prompt carries the new mode too"));
const note = RS.workModeSwitchNote("animator"); // legacy id → creation (1.39.0)
ok("switch note is the creation profile (+ playbooks), not the loop", note.length > 10000 && note.length < 16000 && note.includes("━━━ TOTALITY WORK MODE") && !note.includes("━━━ OPERATING LOOP"), String(note.length));
ok("reminder checklist is short (one merged line)", ["creation", "ultimate", "visualizer", "animator"].every((m) => RS.workModeChecklist(m).length > 120 && RS.workModeChecklist(m).length < 600));

// ── help / popup copy ─────────────────────────────────────────────────────────
ok("help topic explains the merged mode + quick starts", main.includes("Totality runs on the shared OPERATING LOOP") && main.includes("The mode card has Quick starts"));
ok("popup no longer carries the long mode paragraph (1.74.0: removed on request); the card keeps its one-line sub", !/WORK_HELP/.test(fs.readFileSync("popup.js", "utf8")) && /Luau systems · Modeling · VFX &amp; Lighting · UI · Animation &amp; Camera/.test(fs.readFileSync("popup.html", "utf8")));

if (process.exitCode) { console.error(`test-v134: ${passed} passed, some FAILED`); process.exit(1); }
console.log(`PASS  1.34.0: batched commands (parser ${calls.length} calls, loop, feedback, prompts), work modes 2.0 (loop + profiles, switch rider, checklist, quick starts), prompt diet — ${passed} checks`);
