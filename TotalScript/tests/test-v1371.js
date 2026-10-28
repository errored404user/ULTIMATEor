// 1.37.1 — "no command searching" + project_index_build / blueprint_list hardening.
//
//  * The model must never browse the registry: search_commands / get_command /
//    command_registry_stats / generate_command_docs are no longer advertised,
//    list_commands {query} and every lookup tool answer with noSearchReply
//    (closest signatures + "act now"), and every catalogue / error text that
//    used to say "look it up with list_commands" now says the opposite.
//  * blueprint_list is answered from JS data (catalogue) + a tiny installed
//    probe; project_index_build caps its path lists, refuses cleanly when
//    Studio is explicitly offline and retries once with a small scan on a
//    transport timeout.
// Run: node tests/test-v1371.js  (from TotalScript/)
const fs = require("fs");
const vm = require("vm");
let failed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : "  -> " + extra}`); if (!cond) failed++; };
const main = fs.readFileSync("src/core/main.js", "utf8");
const config = fs.readFileSync("src/core/config.js", "utf8");
const bp = fs.readFileSync("src/core/skills/studio_blueprints.js", "utf8");
const pi = fs.readFileSync("src/core/skills/studio_project.js", "utf8");
const readme = fs.readFileSync("README.md", "utf8");

// ── A. lookup tools are hidden, still callable ──
ok("lookup tools moved out of the advertised list", !/\{name:"search_commands"/.test(main) && /const COMMAND_DISCOVERY_TOOLS = \[\s*\{name:"totalscript_help"/.test(main));
ok("totalscript_help is the only discovery tool advertised", !/COMMAND_DISCOVERY_TOOLS = \[[^\]]*search_commands/.test(main));
ok("lookup tools stay known (CORE_VIRTUAL_TOOLS) so a stray call is redirected, not COMMAND_NOT_FOUND", /"search_commands", "get_command", "command_registry_stats", "generate_command_docs"/.test(main));
ok("runTool routes the lookup family through noSearchReply", main.includes("if (LOOKUP_TOOL_RE.test(toolName)) {") && main.includes("return noSearchReply(toolName,"));
ok("registry executors kept for tooling (pinned by test-command-registry)", main.includes('toolName==="search_commands"') && main.includes('toolName==="get_command"') && main.includes("args._totalRegistry === true"));
ok("list_commands {query} is a search -> noSearchReply; the broad bootstrap call is untouched", main.includes('if (String(args.query || args.search || "").trim() && !args._totalInternal) {') && main.includes("return noSearchReply(name, args.query || args.search);"));
ok("diag event for blocked lookups", main.split('diag("lookup.blocked"').length >= 3);

// ── B. noSearchReply behaviour (functional) ──
const start = main.indexOf("  const LOOKUP_TOOL_RE = ");
const end = main.indexOf("\n  }\n", main.indexOf("function noSearchReply(")) + 4;
ok("noSearchReply block extracted", start > 0 && end > start);
const block = main.slice(start, end);
const sandbox = {
  A: { toolNames: new Set(["part_create", "part_delete", "script_read", "script_create", "blueprint_list", "search_commands", "list_tools", "lighting_preset"]),
       toolList: [
         { name: "part_create", description: "Create a Part", inputSchema: { type: "object", required: ["parent_path"], properties: { parent_path: { type: "string" }, size: { type: "array" } } } },
         { name: "part_delete", description: "Delete a part", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
         { name: "script_read", description: "Read a script source", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
         { name: "script_create", description: "Create a script", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
         { name: "blueprint_list", description: "Catalogue of blueprints", inputSchema: { type: "object", properties: { tag: { type: "string" } } } },
         { name: "search_commands", description: "search", inputSchema: { type: "object" } },
         { name: "list_tools", description: "list", inputSchema: { type: "object" } },
         { name: "lighting_preset", description: "Apply a sunset / noon / night lighting preset", inputSchema: { type: "object", properties: { preset: { type: "string" } } } },
       ] },
  bareToolName: (n) => String(n).split("/").pop(),
  toolSignature: (t) => `${t.name} {${Object.keys((t.inputSchema && t.inputSchema.properties) || {}).map((k) => ((t.inputSchema.required || []).includes(k) ? k : k + "?")).join(", ")}}`,
  RS: { suggestToolNames: (q, names) => names.filter((n) => n[0] === q[0]).slice(0, 3) },
  console,
};
vm.createContext(sandbox);
vm.runInContext(block + "\nthis.closestCommands = closestCommands; this.noSearchReply = noSearchReply;", sandbox);
const r1 = sandbox.noSearchReply("search_commands", "create part");
ok("reply says search is disabled and demands action", /COMMAND SEARCH IS DISABLED/.test(r1) && /Act now/.test(r1) && /execute_luau \{code\}/.test(r1), r1.slice(0, 120));
ok("closest signatures are included (part_create ranked first, required/optional marked)", /Closest to "create part"[^\n]*part_create \{parent_path, size\?\}/.test(r1), r1);
ok("lookup tools themselves are never suggested", !/search_commands \{|list_tools \{/.test(r1));
const r2 = sandbox.noSearchReply("get_command", "script_read");
ok("exact name ranks first for get_command", /Closest to "script_read"[^\n]*: script_read \{path\?\}/.test(r2), r2);
const r3 = sandbox.noSearchReply("list_commands", "sunset");
ok("description words still find the command (no dead end)", /lighting_preset \{preset\?\}/.test(r3), r3);
const r4 = sandbox.noSearchReply("command_registry_stats", "");
ok("empty query -> no suggestions, still the rule + execute_luau fallback", !/Closest to/.test(r4) && /execute_luau/.test(r4));
ok("total excludes the lookup tools", /\(7 commands\)/.test(r4), r4);

// ── C. catalogue / error texts no longer invite lookups ──
for (const bad of [
  'list_commands {"query":"keyword"} finds commands that are not shown here',
  'fetch one with list_commands {"query":"name"} before use',
  'list_commands {"query":"keyword"} finds them',
  "search by keyword with list_commands",
  "never guess parameters",
  "Check the command's parameters with list_commands",
  "Use list_commands to see the animation_* tools",
  "Call list_commands with another exact command name or keyword",
  'more via list_commands {"query":"keyword"}',
]) ok(`main.js no longer says: ${bad.slice(0, 60)}`, !main.includes(bad));
ok("catalogue intro states the list is complete and forbids lookups", main.includes("This catalogue is COMPLETE: never search, browse or look up commands"));
ok("names-only block tells the model to call names directly", main.includes("NAMES ONLY (call them directly; a wrong parameter returns the exact schema, never look them up)"));
ok("reminder footer: never call lookups", main.includes('Never call list_commands {\\"query\\"}, search_commands or get_command.'));
ok("param error no longer points at list_commands", main.includes("Fix the call and retry now - do not look the command up."));
for (const bad of [
  'list_commands {"query":"keyword"} finds anything omitted',
  "Use an exact name from list_commands (run it again if you are unsure",
  "Use search_commands {query, environment?} for natural-language discovery",
  'list_commands {"query":"keyword"} finds them',
  'list_commands {"query":"name"} only when a parameter is unclear',
]) ok(`config.js no longer says: ${bad.slice(0, 60)}`, !config.includes(bad));
ok("COMMAND PLATFORM carries the hard NO COMMAND SEARCHING rule", config.includes("NO COMMAND SEARCHING (hard rule): the command catalogue you were given is complete and final.") && config.includes("never retry it in a loop and never search for a substitute"));
ok("unknownTool feedback: do not search, use execute_luau", config.includes("Do not search for it: pick one of those names (all ${(valid || []).length} commands are already in your catalogue) or do it with execute_luau {code}, and continue now."));
ok("embedded + compact first-action texts forbid searching but keep their pinned openers", config.includes("The COMMAND CATALOGUE at the end of this message IS the list_commands result") && config.includes("The COMMAND CATALOGUE at the END of this message IS the list_commands result") && config.includes("Your FIRST action: list_commands {}") && (config.match(/NEVER search for commands/g) || []).length >= 3);
ok("help topic 'commands' describes the no-search policy", main.includes("No command searching (1.37.1)") && !main.includes("The agent calls list_commands / search_commands and picks the right command"));

// ── D. FIRST MOVE softened ──
ok("creation FIRST MOVE (full) is conditional and keeps the /FIRST MOVE:/ pin", config.includes("FIRST MOVE: pick ONE that matches the request (never run openers blindly, never before Studio is connected)") && config.includes("a simple request → just do it. If an opener errors, state it in one line and continue without it - do not retry it and do not search for another command."));
ok("creation FIRST MOVE (tight) is conditional", config.includes("FIRST MOVE: pick the one that matches (never blindly, never while Studio is offline)"));
ok("operating loop: project index only when scripts must be understood", config.includes("In an existing place whose scripts you must understand, start with project_index_build") && config.includes("project_index_build only in an existing place with scripts to understand - if it errors, continue without it"));
ok("PROJECT INDEX mandate keeps its pinned prefix and adds the skip rule", config.includes("PROJECT INDEX (1.32 BUILD pack - read before you write): on an existing place with scripts you must understand, project_index_build first") && config.includes("PROJECT: on an existing place run project_index_build first (project_index_summary when an index exists; skip it for trivial requests, and if it errors continue without it)"));

// ── E. blueprint_list answered locally ──
ok("studio_blueprints exports blueprintListLocal + blueprintInstalledProbeLuau", bp.includes("RobloxScriptSkills.blueprintListLocal = function (a)") && bp.includes("RobloxScriptSkills.blueprintInstalledProbeLuau = function ()"));
ok("probe is tiny (no HEAD) and JSON-encodes {ok, installed}", /return "local RS=game:GetService\('ReplicatedStorage'\) local H=game:GetService\('HttpService'\)/.test(bp) && bp.includes("return H:JSONEncode({ok=true,installed=out})"));
ok("main.js answers blueprint_list from JS and degrades installed to \"unknown\"", main.includes('if (name === "blueprint_list" && typeof RobloxScriptSkills.blueprintListLocal === "function") {') && main.includes('c.installed = installed ? Object.prototype.hasOwnProperty.call(installed, c.name) : "unknown"') && main.includes("installed state unknown (Studio offline or busy); the catalogue itself is complete"));
ok("blueprint_list result is labelled and goes through __rsAfterTool", main.includes("const res0 = `Output of 'blueprint_list':\\n${JSON.stringify(out)}`;") && main.includes("window.__rsAfterTool(name, args, true, res0)"));
{
  // functional: load the skill packs and compare the local catalogue with the Luau builder's catalogue
  const ctx = { window: null, console, chrome: { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } } };
  ctx.window = ctx;
  vm.createContext(ctx);
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
  for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
  const S = vm.runInContext("RobloxScriptSkills", ctx);
  const rows = S.blueprintListLocal({});
  ok("local catalogue lists all 12 blueprints with api/remotes/next_steps", rows.length === 12 && rows.every((r) => r.name && r.title && Array.isArray(r.api) && Array.isArray(r.remotes) && Array.isArray(r.next_steps)), rows.length);
  ok("tag filter works locally", S.blueprintListLocal({ tag: "economy" }).length > 0 && S.blueprintListLocal({ tag: "economy" }).length < 12);
  const probe = S.blueprintInstalledProbeLuau();
  ok("probe is under 600 bytes (the old program was ~34 KB)", probe.length < 600 && S.buildLuau("blueprint_list", {}).code.length > 20000, probe.length);
  const b = S.buildLuau("project_index_build", {});
  ok("project_index_build caps added/modified/removed at 60 and keeps totals", b.code.includes("local function capList(t,n)") && b.code.includes("added,addedMore=capList(added,60)") && b.code.includes("added_total=addedTotal") && b.code.includes("lists_truncated="));
  ok("summary line uses the uncapped totals", b.code.includes("': +'..addedTotal..' / ~'..modifiedTotal..' / -'..removedTotal..' since '"));
}

// ── F. project_index_build hardening in main.js ──
ok("explicit Studio-offline refusal tells the model to continue without the index", main.includes('if (name === "project_index_build" || name === "project_index_summary") {') && main.includes("Skip the project index: continue the task with what the user told you, do NOT retry ${name} and do NOT search for another command."));
ok("offline refusal only on an EXPLICIT disconnected state (never on a stale/unknown bridge)", main.includes("if (b2.connected === true && b2.roblox_connected === false) {"));
ok("one small-scan retry on a transport timeout", main.includes('diag("projectIndex.retrySmall", {});') && main.includes("max_scripts: 150") && main.includes("(partial index: the full scan timed out, so only the first 150 scripts were indexed - pass scope to index one service at a time)"));
ok("offline feedback for project_index_* / blueprint_* gains the no-retry / no-search line", main.includes("cannot run without Studio. Continue the task without it - do NOT retry and do NOT search for another command."));

// ── G. release bookkeeping ──
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
ok("manifest 1.87.0", manifest.version === "1.87.0", manifest.version);
ok("plugin + crate pinned at 1.87.0", fs.readFileSync("plugin/TotalScript.lua", "utf8").includes('local VERSION = "1.87.0"') && /^version = "1\.87\.0"/m.test(fs.readFileSync("agent/Cargo.toml", "utf8")) && /name = "total-agent"\nversion = "1\.87\.0"/.test(fs.readFileSync("agent/Cargo.lock", "utf8")));
ok("README changelog 1.37.1", readme.includes("**1.37.1 — no command searching; project_index_build / blueprint_list hardened.**") && readme.includes("test-v1371.js"));

console.log(failed ? `\n${failed} check(s) failed` : "\nall 1.37.1 checks passed");
process.exitCode = failed ? 1 : 0;
