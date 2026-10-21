#!/usr/bin/env node
// Static + build checks for the Project Index pack (1.32.0):
// src/core/skills/studio_project.js (the project_index_* commands). Registration, bundles,
// schemas, generated Luau shape (hashing, extraction patterns, require resolution, remote
// matrix, conventions, storage module, stale checks), the PROJECT MAP cache + reminder
// wiring in main.js, prompt / help / mode wiring and the version pins. Runtime behaviour
// (index a fake place -> search -> graph -> edit -> stale -> changes) is covered by
// tests/project-index-sim.py (lupa).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("PASS  " + name);
  else {
    failed++;
    console.log("FAIL  " + name + (detail ? " — " + String(detail).slice(0, 400) : ""));
  }
}

// ── bundles ───────────────────────────────────────────────────────────────────
global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
const FILE = "src/core/skills/studio_project.js";
ok("every main.js bundle loads studio_project.js right after studio_blueprints.js and before main.js", bundles.length >= 10 && bundles.every((b) => {
  const i = b.js.indexOf("src/core/skills/studio_blueprints.js");
  return i >= 0 && b.js[i + 1] === FILE && b.js.indexOf("src/core/main.js") > i + 1;
}));
ok("codecraft.html loads studio_project.js after studio_blueprints.js and before studio_bridge.js", (() => {
  const h = fs.readFileSync("codecraft.html", "utf8");
  return h.indexOf(FILE) > h.indexOf("studio_blueprints.js") && h.indexOf(FILE) < h.indexOf("src/core/studio_bridge.js");
})());
ok(FILE + " exists and is valid JS", fs.existsSync(FILE) && (() => { try { new vm.Script(fs.readFileSync(FILE, "utf8")); return true; } catch (e) { return false; } })());

const files = bundles[0].js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f));
for (const f of files) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = vm.runInThisContext("typeof RobloxScriptSkills !== 'undefined' ? RobloxScriptSkills : undefined");
ok("RobloxScriptSkills exposes PROJECT_COMMANDS + PROJECT_INDEX_VERSION 1.32.0", S && Array.isArray(S.PROJECT_COMMANDS) && S.PROJECT_INDEX_VERSION === "1.32.0");

const EXPECTED = ["project_index_build", "project_index_summary", "project_index_search", "project_index_script", "project_index_graph", "project_index_changes"];
ok("6 project commands", S.PROJECT_COMMANDS.length === 6 && EXPECTED.every((n) => S.PROJECT_COMMANDS.includes(n)), S.PROJECT_COMMANDS.join(","));
const byName = new Map(S.SKILL_COMMANDS.map((c) => [c.name, c]));
ok("commands registered in SKILL_COMMANDS with descriptions + params", EXPECTED.every((n) => byName.has(n) && byName.get(n).description.length > 80 && byName.get(n).params && typeof byName.get(n).params === "object"));
ok("SKILL_OPS contains the project ops; blueprint + design + gfx packs still registered", EXPECTED.every((n) => S.SKILL_OPS.includes(n)) && S.SKILL_OPS.includes("blueprint_install") && S.SKILL_OPS.includes("ui_screen_generate") && S.SKILL_OPS.includes("gfx_capture"));
ok("no duplicate command names after registration", new Set(S.SKILL_COMMANDS.map((c) => c.name)).size === S.SKILL_COMMANDS.length);
const isReq = (p) => p && (p.req === true || p.required === true);
ok("required params flagged (search.query, script.path); build/summary/graph/changes fully optional", isReq(byName.get("project_index_search").params.query) && isReq(byName.get("project_index_script").params.path) && ["project_index_build", "project_index_summary", "project_index_graph", "project_index_changes"].every((n) => !Object.values(byName.get(n).params).some(isReq)));
ok("search schema documents the kinds; graph schema documents requires|remotes", /symbol\|function\|export\|require\|remote\|service\|datastore\|tag\|path\|todo/.test(byName.get("project_index_search").params.kind.desc) && /requires\|remotes/.test(byName.get("project_index_graph").params.kind.desc));
ok("descriptions sell the workflow (read before you write, PROJECT MAP, stale, mismatches)", byName.get("project_index_build").description.includes("PROJECT MAP") && /stale/.test(byName.get("project_index_script").description) && /mismatch/.test(byName.get("project_index_graph").description) && /instead of reading/.test(byName.get("project_index_summary").description));

// ── generated Luau ────────────────────────────────────────────────────────────
const build = (op, args) => S.buildLuau(op, args);
const luaOk = (r) => r && !r.err && typeof r.code === "string";
const b = build("project_index_build", {});
ok("project_index_build builds: walk services, hash, analyze, write module, diff, map", luaOk(b) && ["collectScripts(", "hashOf(", "analyze(", "buildIndex(", "writeIndex(", "diffIndex(", "mapText(", "INDEX_NAME='OR_ProjectIndex'", "ChangeHistoryService"].every((k) => b.code.includes(k)));
ok("HEAD skips CoreGui-style services and the index module itself; walks the documented roots", b.code.includes("SKIP={CoreGui=true") && b.code.includes("if nm==INDEX_NAME then return end") && ["'ServerScriptService'", "'ServerStorage'", "'ReplicatedStorage'", "'ReplicatedFirst'", "'StarterPlayer'", "'StarterGui'", "'Workspace'"].every((k) => b.code.includes(k)));
ok("djb2 hash is chunked (string.byte 512 at a time) and length-suffixed", b.code.includes("math.min(n,i+511)") && b.code.includes("string.byte(s,i,j)") && b.code.includes("%08x%06x"));
ok("per-script extraction: functions, requires, GetService, DataStores, tags, TODO/FIXME, --!strict, Disabled, remotes, frameworks, return name", ["local%s+function%s+", "require%s*%(", "GetService%s*%(", "DataStore%s*%(", "GetTagged%s*%(", "AddTag%s*%(", "%-%-!strict", "e.disabled=s.Disabled", "remoteOp(l)", "remoteVar(l)", "FRAMEWORKS", "^%s*return%s+([%a_][%w_]*)%s*$"].every((k) => b.code.includes(k)));
ok("remote ops classified by side (FireServer / FireClient / OnServerEvent / OnClientEvent / Invoke)", [":FireServer", ":InvokeServer", ":FireClient", ":FireAllClients", ".OnServerEvent", ".OnServerInvoke", ".OnClientEvent", ".OnClientInvoke", "client_fire", "server_fire", "server_handle", "client_handle"].every((k) => b.code.includes(k)));
ok("remote names resolve through WaitForChild locals and dotted access; instances enumerated from ReplicatedStorage", b.code.includes("WaitForChild%s*%(%s*[\"\\']([%w_ ]+)[\"\\']") && b.code.includes("vars[lv]=nm") && b.code.includes("remoteInstances()") && b.code.includes("IsA('RemoteEvent') or d:IsA('RemoteFunction') or d:IsA('UnreliableRemoteEvent')"));
ok("mismatch detection: no instance / fired-never-handled / handled-never-fired / unused", ["no RemoteEvent/RemoteFunction instance", "fired but never handled", "handled but never fired", "unused remote instance"].every((k) => b.code.includes(k)));
ok("require resolution by module name with same-folder preference, required_by, hubs, orphans, DFS cycles", ["byName[r.name]", "r.ambiguous=#cands", "required_by", "hubTop", "orphans", "local function dfs(n)", "cycles[#cycles+1]=cyc"].every((k) => b.code.includes(k)));
ok("conventions: indent, function/variable case (service/require/module locals ignored), strict ratio, wait style, service access, frameworks, style_guide sentence", ["conv={indent=", "function_case=", "variable_case=", "strict_ratio=", "wait_style=", "service_access=", "frameworks=fwList", "conv.style_guide=", "rhs:match('^{%s*}%s*$')", "Knit", "ProfileService", "Fusion", "Roact", "OR_Systems"].every((k) => b.code.includes(k)));
ok("index module: ServerStorage ModuleScript returning JSONDecode([===[...]===]) with OR_Version / BuiltAt / Scripts attributes", ["m=Instance.new('ModuleScript') m.Name=INDEX_NAME m.Parent=ServerStorage", "JSONDecode([===['..js..']===])", "m:SetAttribute('OR_Version',PI_VERSION)", "m:SetAttribute('BuiltAt'", "m:SetAttribute('Scripts'", "m.Source:match('%[===%[(.-)%]===%]')"].every((k) => b.code.includes(k)));
ok("map text: header, Style, Layout, Hubs, Remotes, Issues, Blueprints installed, usage hint, bounded", ["'PROJECT MAP ('", "'Style: '", "'Layout: '", "'Hubs (most required): '", "'Remotes: '", "'Issues: '", "'Blueprints installed: '", "Use project_index_search / project_index_script", "if #txt>maxChars then txt=txt:sub(1,maxChars-3)..'...' end"].every((k) => b.code.includes(k)));
ok("build options: scope, max_scripts, dry_run (no write), max_chars", (() => { const r = build("project_index_build", { scope: "ServerScriptService", max_scripts: 50, dry_run: true, max_chars: 800 }); return luaOk(r) && r.code.includes("local scope='ServerScriptService'") && r.code.includes("local maxN=50") && r.code.includes("if not true then local rec=wp()") && r.code.includes("mapText(idx,800)"); })());
ok("build returns added / modified / removed / conventions / hubs / mismatches / map_text and a summary line", b.code.includes("added=added,modified=modified,removed=removed") && b.code.includes("map_text=map") && b.code.includes("' since '"));
ok("project_index_summary: needIndex, staleCheck, map_text + STALE suffix, datastores / tags / todo_files / largest_scripts", (() => { const r = build("project_index_summary", { max_chars: 900 }); return luaOk(r) && ["needIndex()", "staleCheck(idx,", "mapText(idx,900)", "(STALE: ", "todo_files=todoFiles", "largest_scripts=big", "datastores=ds", "tags=tags"].every((k) => r.code.includes(k)); })());
ok("project_index_search: requires a query (except kind todo), validates kind, lowercases, limits, counts total, instance rows", (() => { const r = build("project_index_search", { query: "AddCoins", kind: "symbol", limit: 7 }); return luaOk(r) && r.code.includes("local qstr='addcoins'") && r.code.includes("local kind='symbol'") && r.code.includes("local limit=7") && r.code.includes("remote_instance") && /query is required/.test(build("project_index_search", {}).err || "") && /unknown kind 'planet'/.test(build("project_index_search", { query: "x", kind: "planet" }).err || "") && luaOk(build("project_index_search", { kind: "todo" })); })());
ok("project_index_script: requires path, suffix / unique-name lookup, stale by rehash, remote partners, required_by", (() => { const r = build("project_index_script", { path: "ServerScriptService.Main" }); return luaOk(r) && ["findEntry(idx,'ServerScriptService.Main')", "stale=cur~=e.hash", "remote_partners=partners", "required_by=e.required_by", "ambiguous: "].every((k) => r.code.includes(k)) && /path is required/.test(build("project_index_script", {}).err || ""); })());
ok("project_index_graph requires: edges / nodes ranked / hubs / orphans / cycles / unresolved, root + depth neighbourhood", (() => { const r = build("project_index_graph", { root: "Main", depth: 2 }); return luaOk(r) && ["local root='Main'", "local depth=2", "nodeList", "unresolved", "cycles=idx.cycles", "orphans=idx.orphans", "d>=depth"].every((k) => r.code.includes(k)); })());
ok("project_index_graph remotes: rows, mismatches, wrong-side handlers; rejects other kinds", (() => { const r = build("project_index_graph", { kind: "remotes", root: "buy" }); return luaOk(r) && r.code.includes("wrongSide") && r.code.includes("OnServerEvent/OnServerInvoke in a LocalScript") && r.code.includes("mismatches=idx.mismatches") && /requires' or 'remotes/.test(build("project_index_graph", { kind: "spaghetti" }).err || ""); })());
ok("project_index_changes: rebuild without writing, hash diff, per-script new / removed functions + line delta", (() => { const r = build("project_index_changes", {}); return luaOk(r) && !r.code.includes("local _,n=writeIndex(idx)") && ["diffIndex(old,idx)", "new_functions=newFns", "removed_functions=gone", "delta_lines=e.lines-o.lines", "requires_changed", "remotes_changed"].every((k) => r.code.includes(k)); })());
ok("summary / search / script / graph / changes fail cleanly without an index", ["project_index_summary", "project_index_search", "project_index_script", "project_index_graph", "project_index_changes"].every((n) => build(n, { query: "x", path: "y" }).code.includes("run project_index_build first")));
ok("every project program wraps the body in pcall and reports failures as JSON", EXPECTED.every((n) => { const r = build(n, { query: "x", path: "y" }); return luaOk(r) && r.code.includes("local okRun,resRun=pcall(function()") && r.code.includes("return fail("); }));
ok("every project program is free of Luau-only syntax and JS interpolation", EXPECTED.every((n) => { const r = build(n, { query: "x", path: "y" }); return luaOk(r) && !/\$\{/.test(r.code) && !/`/.test(r.code) && !/\bcontinue\b/.test(r.code) && !/\+=/.test(r.code); }));
ok("user strings are escaped into Luau literals", (() => { const r = build("project_index_search", { query: "it's \"q\"\nx" }); return luaOk(r) && r.code.includes("local qstr='it\\'s \"q\"\\nx'"); })());
ok("non-project ops fall through to the previous builders (blueprints + gfx + design + base)", luaOk(build("blueprint_list", {})) && luaOk(build("gfx_brief", {})) && luaOk(build("ui_audit", { path: "StarterGui" })) && luaOk(build("lighting_inspect", {})));

// ── prompt / help / mode / reminder wiring ────────────────────────────────────
const mainSrc = fs.readFileSync("src/core/main.js", "utf8");
const configSrc = fs.readFileSync("src/core/config.js", "utf8");
ok("creation work mode focuses project_index_* commands", /focus:\s*\/\^\(script_\|model_\|memory_\|blueprint_\|project_index_\|/.test(mainSrc));
ok("feature help has a 'projectindex' topic (before 'projects' in the alias order) with the workflow", /projectindex:\{title:"Project Index/.test(mainSrc) && mainSrc.includes("project_index_search {query, kind}") && /projectindex:\/project index\|project map\|codebase\|architecture/.test(mainSrc) && mainSrc.indexOf("projectindex:/project index") < mainSrc.indexOf("projects:/project|rbxl"));
ok("__rsAfterTool caches the PROJECT MAP from project_index_build / project_index_summary results", mainSrc.includes('(op === "project_index_build" || op === "project_index_summary") && typeof res === "string"') && mainSrc.includes("cacheProjectMap(res)") && mainSrc.includes("function cacheProjectMap(resText)") && mainSrc.includes("window.__rsProjectMap = entry") && mainSrc.includes("chrome.storage.local.set({ rsProjectMap: entry })"));
ok("cache is bounded (PROJECT_MAP_MAX 1500), restored from storage, and ignores failed results", mainSrc.includes("const PROJECT_MAP_MAX = 1500;") && mainSrc.includes('chrome.storage.local.get("rsProjectMap"') && mainSrc.includes("j && j.ok !== false && j.data") && mainSrc.includes("d.map_text.slice(0, PROJECT_MAP_MAX)"));
ok("periodic tools reminder appends the cached map with a staleness nudge", mainSrc.includes("RS.memoryNudge() + projectMapReminder()") && mainSrc.includes("function projectMapReminder()") && mainSrc.includes("(PROJECT MAP, cached ") && mainSrc.includes("run project_index_changes or project_index_build when it may be stale") && mainSrc.includes("projectMap: !!(window.__rsProjectMap && window.__rsProjectMap.text)"));
ok("cacheProjectMap / projectMapReminder are defined at module scope (reachable from runTool + ui)", /^  function cacheProjectMap\(/m.test(mainSrc) && /^  function projectMapReminder\(/m.test(mainSrc));
ok("mandates teach 'read before you write' in both budgets", configSrc.includes("PROJECT INDEX (1.32 BUILD pack - read before you write)") && configSrc.includes("PROJECT: on an existing place run project_index_build first") && ["project_index_build", "project_index_summary", "project_index_search", "project_index_script", "project_index_changes"].every((k) => configSrc.includes(k)));
ok("luau-parse-check covers the project programs", fs.readFileSync("tests/luau-parse-check.py", "utf8").includes("PROJECT_COMMANDS"));
const readme = fs.readFileSync("README.md", "utf8");
ok("README documents the project index pack", readme.includes("project_index_build") && readme.includes("1.32.0") && readme.includes("project-index-sim.py"));
ok("manifest version is 1.56.0", manifest.version === "1.56.0", manifest.version);
ok("plugin / crate pinned at 1.56.0", /1\.56\.0/.test(fs.readFileSync("plugin/ORscript.lua", "utf8")) && /^version = "1\.56\.0"/m.test(fs.readFileSync("agent/Cargo.toml", "utf8")));

// ── simulator ─────────────────────────────────────────────────────────────────
ok("project-index-sim.py exists and covers build / search / graph / stale / changes", (() => { const t = fs.readFileSync("tests/project-index-sim.py", "utf8"); return t.includes("from roblox_sim import make_runtime") && ["project_index_build", "project_index_search", "project_index_graph", "project_index_changes", "stale", "GhostRemote", "cycle"].every((k) => t.includes(k)); })());

console.log("\n" + (failed ? failed + " check(s) failed" : "all project index pack checks passed"));
process.exit(failed ? 1 : 0);
