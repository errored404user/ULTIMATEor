// Token Saver mode: prompt compaction, persistence wiring and catalogue caps.
// Run from TotalScript_v4 with: node tests/test-token-saver.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let passed = 0;
const check = (name, fn) => {
  try { assert(fn()); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + " — " + (e && e.message || e)); process.exitCode = 1; }
};

global.window = global;
global.chrome = { runtime: { getURL: (p) => p }, storage: { local: { get(_k, cb) { if (cb) cb({}); }, set() {} } } };
window.__rsWorkMode = () => "creation";
vm.runInThisContext(read("src/core/config.js") + ";globalThis.__TOKEN_SAVER_RS = RS;", { filename: "config.js" });
const RS = globalThis.__TOKEN_SAVER_RS;
const main = read("src/core/main.js");
const popup = read("popup.js");

const providerNotes = "KEEP_PROVIDER_RULE_EXACT: use the provider's plain-text format.";
const customPrompt = "KEEP_USER_RULE_EXACT: preserve my existing naming conventions.";
const baseOpts = { siteName: "Test AI", providerId: "test-provider", engine: "roblox", providerNotes, customPrompt };
const normal = RS.buildSystemPrompt(baseOpts);
const explicitOff = RS.buildSystemPrompt({ ...baseOpts, tokenSaver: false });
const compact = RS.buildSystemPrompt({ ...baseOpts, tokenSaver: true });

check("Token Saver is opt-in and false/omitted preserves the exact existing prompt", () => normal === explicitOff);
check("Token Saver materially shrinks the base prompt", () => compact.length < normal.length * 0.45 && compact.length < 18000);
check("provider rules and user-authored custom instructions remain byte-for-byte present", () => compact.includes(providerNotes) && compact.includes(customPrompt));
check("compact Roblox prompt retains JSON and execute_luau command formats", () => compact.includes("STANDARD FORMAT (everything except execute_luau)") && compact.includes("```json\n{\"command\": \"name\", \"params\": {\"key\": \"value\"}}") && compact.includes("###LUA###") && compact.includes("###END_LUA###"));
check("compact Roblox prompt retains the hard four-command batch ceiling and destructive-scope safety", () => compact.includes("BATCHING: up to 4 independent commands per reply") && compact.includes("NEVER DELETE BROADLY") && compact.includes("the user's latest message is the specification"));
check("compact command bootstrap still forbids guessing/searching and preserves the ready-first sequence", () => compact.includes("Your FIRST action: list_commands {}") && compact.includes("never guess") && compact.includes("NEVER search for commands"));

const plain = RS.buildSystemPrompt({ ...baseOpts, tokenSaver: true, commandFormat: "plain" });
check("plain-format providers keep CMD/LUA syntax and do not receive JSON fences in Token Saver mode", () => plain.includes("STANDARD FORMAT (all but execute_luau) - a CMD block") && plain.includes("###CMD name###") && plain.includes("###END_CMD###") && plain.includes("###LUA###") && !plain.includes("```json"));

const oldWorkMode = window.__rsWorkMode;
for (const id of ["creation", "blender", "animate", "blockbench"]) {
  window.__rsWorkMode = () => id;
  const modePrompt = RS.buildSystemPrompt({ ...baseOpts, tokenSaver: true });
  const tightHeading = RS.WORK_MODE_PROMPTS[id].tight.split("\n")[0];
  check("Token Saver selects the essential compact " + id + " work-mode profile", () => modePrompt.includes(tightHeading));
}
window.__rsWorkMode = oldWorkMode;
const oldBlender = window.__rsBlender, oldBlockbench = window.__rsBlockbench;
window.__rsBlender = () => true; window.__rsBlockbench = () => false; window.__rsWorkMode = () => "blender";
const blenderOff = RS.buildSystemPrompt({ ...baseOpts, maxChars: 14000, tokenSaver: false });
const blenderSaver = RS.buildSystemPrompt({ ...baseOpts, tokenSaver: true });
check("Token Saver trims the redundant connected-Blender tool dump but keeps connection, first-step and validation safeguards", () => blenderOff.includes("ASSET PIPELINE (1.83)") && blenderSaver.length < blenderOff.length * 0.8 && blenderSaver.includes("BLENDER MCP CONNECTED (COMPACT)") && blenderSaver.includes("get_scene_info") && blenderSaver.includes("mesh_import_verify") && blenderSaver.includes("do not silently fall back"));
window.__rsBlender = () => false; window.__rsBlockbench = () => true; window.__rsWorkMode = () => "blockbench";
const blockbenchOff = RS.buildSystemPrompt({ ...baseOpts, maxChars: 14000, tokenSaver: false });
const blockbenchSaver = RS.buildSystemPrompt({ ...baseOpts, tokenSaver: true });
check("Token Saver replaces the duplicate connected-Blockbench signature dump with its essential local-export workflow", () => blockbenchOff.includes("Commands: bb_status") && blockbenchSaver.length < blockbenchOff.length * 0.92 && blockbenchSaver.includes("BLOCKBENCH CONNECTED (COMPACT)") && blockbenchSaver.includes("bb_status first") && blockbenchSaver.includes("never claim Studio imported it"));
if (oldBlender === undefined) delete window.__rsBlender; else window.__rsBlender = oldBlender;
if (oldBlockbench === undefined) delete window.__rsBlockbench; else window.__rsBlockbench = oldBlockbench;
window.__rsWorkMode = oldWorkMode;

const localOpts = { ...baseOpts, engine: "local", fullAccess: true };
const localFull = RS.buildSystemPrompt(localOpts);
const localCompact = RS.buildSystemPrompt({ ...localOpts, tokenSaver: true });
check("AgentScript Token Saver shortens its prompt while retaining exact JSON, workflow and four-command contract", () => localCompact.length < localFull.length * 0.55 && localCompact.includes('{"command":"name","params":{"key":"value"}}') && localCompact.includes("at most 4 independent commands") && localCompact.includes("Read relevant files before editing") && localCompact.includes("FULL PC ACCESS IS ON"));
check("AgentScript Token Saver keeps workspace/destructive-action safeguards and custom instructions", () => localCompact.includes("workspace-relative") && localCompact.includes("delete only the exact requested target") && localCompact.includes("KEEP_USER_RULE_EXACT") && localCompact.includes("KEEP_PROVIDER_RULE_EXACT"));

const catalogue = "━━━ COMMAND CATALOGUE (embedded) ━━━\nexample_tool {path}\n━━━ END COMMAND CATALOGUE ━━━";
const compactWithCatalogue = RS.buildSystemPrompt({ ...baseOpts, tokenSaver: true, catalogue });
check("Token Saver preserves the supplied command catalogue rather than altering or deleting it", () => compactWithCatalogue.includes(catalogue));
const reminderTools = Array.from({ length: 300 }, (_, i) => ({
  name: "test_family_command_" + String(i).padStart(3, "0"),
  inputSchema: { properties: { path: { type: "string" }, target: { type: "string" } }, required: ["path"] },
}));
const fullReminder = RS.toolsReminder(reminderTools);
const compactReminder = RS.toolsReminder(reminderTools, 5000);
check("periodic reminder budget trims a large tool inventory without removing its safety framing", () =>
  compactReminder.length < fullReminder.length * 0.65 && compactReminder.length < 6000 && compactReminder.includes("automatic REMINDER") && compactReminder.includes("never search or look commands up"));
check("existing provider-budget fallback still matches when Token Saver is off", () => {
  const opts = { ...baseOpts, maxChars: 14000 };
  return RS.buildSystemPrompt(opts) === RS.buildSystemPrompt({ ...opts, tokenSaver: false });
});

check("popup exposes a persistent, default-off live toggle in AI & Agents and includes it in reset/export/import keys", () =>
  /\{ id: "agents", title: "AI & Agents"[\s\S]{0,500}\{ id: "tokensaver", key: "rsTokenSaver", type: "toggle", default: false, live: true, label: "Token Saver"/.test(popup) &&
  /const RS_KEYS_ALL = \[[^\]]*"rsTokenSaver"/.test(popup) &&
  /const EXPORT_KEYS = RS_KEYS_ALL\.filter/.test(popup) &&
  /for \(const k of EXPORT_KEYS\)/.test(popup) &&
  /storeRemove\(RS_KEYS_ALL\)/.test(popup));
check("main.js loads and syncs the preference, then forwards it to prompt construction", () =>
  /let tokenSaverEnabled = false/.test(main) &&
  /window\.__rsTokenSaver = \(\) => tokenSaverEnabled/.test(main) &&
  /"rsMultiAgent", "rsTokenSaver"/.test(main) &&
  /typeof r\.rsTokenSaver === "boolean"\) tokenSaverEnabled = r\.rsTokenSaver/.test(main) &&
  /hasOwnProperty\.call\(changes, "rsTokenSaver"\)/.test(main) &&
  /tokenSaverEnabled = changes\.rsTokenSaver\.newValue === true/.test(main) &&
  /tokenSaver,\s*catalogue,/.test(main) &&
  /if \(dirty\)[\s\S]{0,100}markModesChanged\(\)/.test(main));
check("Token Saver caps broad embedded/list-command catalogues at 9k chars and 200 lines", () =>
  /TOKEN_SAVER_CATALOGUE_CHARS = 9000/.test(main) &&
  /TOKEN_SAVER_CATALOGUE_LINES = 200/.test(main) &&
  /const budget = tokenSaver \? Math\.min\(baseBudget, TOKEN_SAVER_CATALOGUE_CHARS\) : baseBudget/.test(main) &&
  /const saverCatalogue = isTokenSaverEnabled\(\) && !commandQuery/.test(main) &&
  /Math\.min\(baseLimit, TOKEN_SAVER_CATALOGUE_CHARS\)/.test(main));
check("periodic command reminders shrink in Token Saver mode without changing the default", () =>
  /TOKEN_SAVER_REMINDER_CHARS = 5000/.test(main) &&
  /compactTools\(tools, maxChars\)/.test(read("src/core/config.js")) &&
  /RS\.toolsReminder\(roblox, isTokenSaverEnabled\(\) \? TOKEN_SAVER_REMINDER_CHARS : undefined\)/.test(main));

console.log(`\ntest-token-saver: ${passed} checks passed`);
