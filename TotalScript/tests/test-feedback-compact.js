// 1.99.8 - provider-wide result pipeline: signal-preserving tool-feedback
// compaction (orchestrator), main.js delegation, contract fence stripping for
// code parameters, and the parser repair stages that the provider-output
// corpus (tests/parser-bench.js) exercises. Mocked - no AI site or Studio.
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path");
process.chdir(path.join(__dirname, ".."));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail !== undefined ? " :: " + String(detail).slice(0, 300) : "")); } };

const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync("src/core/orchestrator.js", "utf8"), ctx);
const O = ctx.window.TotalOrchestrator;
const RSParse = new Function(fs.readFileSync("src/core/parser.js", "utf8") + "; return RSParse;")();
const main = fs.readFileSync("src/core/main.js", "utf8");
const contractSrc = fs.readFileSync("src/core/command_contract.js", "utf8");

// ── compactFeedback ────────────────────────────────────────────────────────
ok("orchestrator exports compactFeedback + PROBLEM_LINE_RE", typeof O.compactFeedback === "function" && Object.prototype.toString.call(O.PROBLEM_LINE_RE) === "[object RegExp]");
ok("short results are returned untouched (identity)", O.compactFeedback("Output of 'x':\nOK", "x") === "Output of 'x':\nOK");
ok("exactly-at-limit result untouched", (() => { const s = "a".repeat(10000); return O.compactFeedback(s, "x") === s; })());

const logLines = [];
for (let i = 0; i < 700; i++) logLines.push(i === 412 ? "ServerScriptService.Main:12: attempt to index nil with 'Parent'" : i % 9 === 0 ? "Infinite yield possible on 'Workspace:WaitForChild(\"Door\")'" : `tick ${i} value=${(i * 31) % 97}`);
const bigLog = "Output of 'get_console_output':\n" + logLines.join("\n");
const c1 = O.compactFeedback(bigLog, "get_console_output", 6000);
ok("text body: fits the budget", c1.length <= 6000, c1.length);
ok("text body: 'Output of' prefix preserved verbatim", c1.startsWith("Output of 'get_console_output':\n"));
ok("text body: the single error line buried at line 412 survives", c1.includes("attempt to index nil with 'Parent'"));
ok("text body: repeated warning folded into one line with a count", /Infinite yield possible[^\n]*\(×\d+\)/.test(c1));
ok("text body: head and tail both present, gap marked", c1.includes("tick 1 value=31") && c1.includes("tick 699 value=") && c1.includes("[…]"));
ok("text body: footer states kept/dropped counts and how to ask for the rest", /\[TotalScript context compression: kept \d+ of \d+ lines \(\d+ problem lines? kept in full, repeats folded\); dropped \d+ of \d+ chars from get_console_output\. Ask again with a narrower command/.test(c1), c1.slice(-300));
ok("deterministic: same input → same output", O.compactFeedback(bigLog, "a", 6000) === O.compactFeedback(bigLog, "a", 6000));

const err = "ERROR: script failed\n" + logLines.join("\n");
const c2 = O.compactFeedback(err, "x", 5000);
ok("ERROR prefix preserved (feedbackIsError keeps working)", c2.startsWith("ERROR: script failed\n") && c2.length <= 5000);

const items = []; for (let i = 0; i < 500; i++) items.push({ path: "Workspace.Part" + i, className: "Part", size: [4, 1, 2], note: "n".repeat(80) });
const bigJson = "Output of 'workspace_list':\n" + JSON.stringify({ count: 500, items, truncated: false });
const c3 = O.compactFeedback(bigJson, "workspace_list", 8000);
const body3 = c3.slice("Output of 'workspace_list':\n".length, c3.lastIndexOf("\n[TotalScript context compression"));
let parsed3 = null; try { parsed3 = JSON.parse(body3); } catch {}
ok("JSON body: still parses after compaction", parsed3 !== null, body3.slice(0, 120));
ok("JSON body: scalar keys exact (count=500, truncated=false)", parsed3 && parsed3.count === 500 && parsed3.truncated === false);
ok("JSON body: long array keeps first items + an explicit '(+n more items, 500 total)' marker", parsed3 && Array.isArray(parsed3.items) && parsed3.items.length < 500 && /\(\+\d+ more items, 500 total\)/.test(parsed3.items[parsed3.items.length - 1]));
ok("JSON body: fits the budget", c3.length <= 8000, c3.length);
ok("JSON footer says it was shrunk structurally", c3.includes("JSON shrunk structurally"));

const longStr = "Output of 'script_read':\n" + JSON.stringify({ path: "A", source: "x".repeat(30000) });
const c4 = O.compactFeedback(longStr, "script_read", 4000);
ok("JSON long string clipped with its true length", /…\[\+\d+ chars\]/.test(c4) && c4.length <= 4000, c4.length);

const rep = "Output of 'x':\n" + Array(4000).fill("same line").join("\n");
const c5 = O.compactFeedback(rep, "x", 3000);
ok("4000 identical lines fold to one '(×4000)' line", c5.includes("same line  (×4000)") && c5.length < 600, c5.length);

ok("never throws on garbage input", (() => { try { O.compactFeedback(null, null, 10); O.compactFeedback({}, "", "x"); O.compactFeedback("a".repeat(20000), undefined, -5); return true; } catch { return false; } })());

// ── main.js delegation ─────────────────────────────────────────────────────
ok("main.js compressToolFeedback delegates to ORCH.compactFeedback with the 10000 cap and keeps the old cut as fallback", main.includes("if (ORCH && ORCH.compactFeedback) { try { return ORCH.compactFeedback(s, name, MAX); } catch {} }") && main.includes("TotalScript context compression: dropped"));
ok("main.js still applies compression per step and per batch", (main.match(/compressToolFeedback\(feedback, /g) || []).length >= 2);

// ── contract: wrapping fence stripped from code parameters ─────────────────
ok("contract strips a wrapping ``` fence for declared code parameters (fence_stripped correction)", contractSrc.includes('correct("fence_stripped", k') && contractSrc.includes('const CODE_PARAM_KEYS = ["source", "code", "script", "luau", "body", "text", "content"]'));
{
  global.window = global; global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set() {} } }, runtime: { getURL: (p) => p } };
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
  for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
  const C = require(path.join(process.cwd(), "src/core/command_contract.js"));
  const r1 = C.prepare("script_set_source", { path: "SSS.A", source: "```lua\nprint(1)\nreturn 2\n```" });
  ok("script_set_source: ```lua fence wrapping the whole source removed", r1.ok && r1.args.source === "print(1)\nreturn 2" && r1.corrections.some((c) => c.kind === "fence_stripped"), JSON.stringify(r1.args));
  const r2 = C.prepare("script_set_source", { path: "SSS.A", source: "local s = [[\n```lua\n]]\nprint(s)" });
  ok("a fence INSIDE the body (not wrapping it) is left alone", r2.ok && r2.args.source === "local s = [[\n```lua\n]]\nprint(s)");
  const r3 = C.prepare("script_set_source", { path: "SSS.A", source: "print(1)" });
  ok("plain source untouched, no correction recorded", r3.ok && r3.args.source === "print(1)" && !r3.corrections.some((c) => c.kind === "fence_stripped"));
  const r4 = C.prepare("instance_rename", { path: "Workspace.P", name: "```x```" });
  ok("non-code parameters are never fence-stripped", r4.args.name === "```x```");
  // the six write commands declare `unchecked`
  const S = RobloxScriptSkills;
  const writes = S.SKILL_COMMANDS.filter((c) => /^(script_set_source|script_append|script_create|script_module|script_replace|script_insert)$/.test(c.name));
  ok("six script-writing commands declare the `unchecked` boolean (syntax gate bypass)", writes.length === 6 && writes.every((c) => c.params && c.params.unchecked && c.params.unchecked.type === "boolean"), writes.map((c) => c.name + ":" + !!(c.params && c.params.unchecked)).join(","));
  const built = S.buildLuau("script_set_source", { path: "SSS.A", source: "return 1" });
  ok("script_set_source Luau compiles the source with syntaxErr BEFORE assigning .Source", built.code.includes("local se=syntaxErr(src) if se then return fail(\"SYNTAX ERROR - nothing written to \"") && built.code.indexOf("syntaxErr(src)") < built.code.indexOf("inst.Source=src"));
  const forced = S.buildLuau("script_set_source", { path: "SSS.A", source: "return 1", unchecked: true });
  ok("unchecked=true compiles to a nil gate (no loadstring call)", forced.code.includes("local se=nil if se then") && !forced.code.includes("local se=syntaxErr(src)"));
  const created = S.buildLuau("script_create", { kind: "server", name: "A", source: "-- header\nprint(1)\n-- footer" });
  ok("script_create keeps newlines in the created source (qsrc) - a `-- comment` no longer swallows the file", created.code.includes('"-- header\\nprint(1)\\n-- footer"') && !created.code.includes('"-- header print(1) -- footer"'));
  const chk = S.buildLuau("script_check", { source: "return 1" });
  ok("script_check reads loadstring's second return value (nil+message) instead of pcall-only", chk.code.includes("local se=syntaxErr(src)") && chk.code.includes("COMPILE ERROR: ' .. se") && !chk.code.includes("pcall(function() local f=loadstring(src) return f end)"));
  for (const f of ["studio_daily", "studio_200", "studio_ultimate"]) {
    ok(`${f}.js prelude defines syntaxErr (loadstring nil+message aware, nil when unavailable)`, fs.readFileSync(`src/core/skills/${f}.js`, "utf8").includes("local function syntaxErr(src) if type(loadstring)~='function' then return nil end local okL,f,e=pcall(loadstring,src) if not okL or f then return nil end return tostring(e or 'syntax error') end"));
  }
}

// ── parser repair stages (spot checks; the corpus is the full suite) ──────
const p = (t) => RSParse.parseToolCalls(t);
ok("parser: // and /* */ comments between tokens", p('{"command":"x", /* why */ "params":{"a":"http://u"}} // done')[0].arguments.a === "http://u");
ok("parser: Python True/None outside strings only", (() => { const c = p('{"command":"x","params":{"a":True,"b":None,"c":"True"}}')[0]; return c.arguments.a === true && c.arguments.b === null && c.arguments.c === "True"; })());
ok("parser: raw quotes + raw newlines inside a code value", p('{"command":"execute_luau","params":{"code":"local p = Instance.new("Part")\np.Parent = workspace"}}')[0].arguments.code === 'local p = Instance.new("Part")\np.Parent = workspace');
ok("parser: raw-quoted code followed by another property", (() => { const c = p('{"command":"execute_luau","params":{"code":"print("x")\nreturn 1","datamodel_type":"Server"}}')[0]; return c && c.arguments.code === 'print("x")\nreturn 1' && c.arguments.datamodel_type === "Server"; })());
ok("parser: double-escaped envelope unescaped one level", p('{"command":"execute_luau","params":{"code":"print(\\\\"a\\\\")\\\\nreturn 1"}}')[0].arguments.code === 'print("a")\nreturn 1');
ok("parser: params before command key", p('{"params":{"path":"W"},"command":"workspace_list"}')[0].arguments.path === "W");
ok("parser: flat root params adopted, commentary keys dropped", (() => { const c = p('{"command":"instance_rename","path":"Workspace.Part","name":"Door","reason":"asked"}')[0]; return c.arguments.path === "Workspace.Part" && c.arguments.name === "Door" && !("reason" in c.arguments); })());
ok("parser: bare {\"command\":\"x\"} still yields {}", JSON.stringify(p('{"command":"list_commands"}')[0].arguments) === "{}");
ok("parser: code as array of lines joined", p('{"command":"execute_luau","params":{"code":["a","b"]}}')[0].arguments.code === "a\nb");
ok("parser: heading-rendered ### LUA / ### END_LUA", (() => { const c = p("### LUA\nreturn 1\n### END_LUA"); return c.length === 1 && c[0].arguments.code === "return 1"; })());
ok("parser: heading prose '### LUA scripts are great' is NOT a marker", p("### LUA scripts are great\nreturn 1\n### END_LUA").length === 0 && !RSParse.hasToolSignature("### Lua tips\nUse pcall."));
ok("parser: bold markers leave no ** residue", p("**###LUA###**\nreturn 1\n**###END_LUA###**")[0].arguments.code === "return 1");
ok("parser: entity-escaped Lua decoded only when the block has no raw < >", p("###LUA###\nif a &lt; b then return 1 end\n###END_LUA###")[0].arguments.code === "if a < b then return 1 end" && p('###LUA###\nif a < b then print("&amp;") end\n###END_LUA###')[0].arguments.code === 'if a < b then print("&amp;") end');
ok("parser: valid JSON never altered by the repair stages", (() => { const c = p('{"command":"execute_luau","params":{"code":"print(\\"ok\\")\\nreturn 1 // not a comment","datamodel_type":"Server"}}')[0]; return c.arguments.code === 'print("ok")\nreturn 1 // not a comment'; })());
ok("parser: a second command after an odd-quoted first one is not swallowed", (() => { const c = p('{"command":"execute_luau","params":{"code":"print("a") print("b") print("c\\")"}}\n{"command":"selection_info"}'); return c.length === 2 && c[1].tool === "selection_info"; })());
ok("parser: still-streaming open envelope stays open (watcher keeps waiting)", RSParse.hasOpenToolBlock('{"command":"execute_luau","params":{"code":"print(') && RSParse.hasOpenToolBlock("### LUA\nreturn 1"));

// ── bench wiring ───────────────────────────────────────────────────────────
const corpus = JSON.parse(fs.readFileSync("tests/fixtures/provider_outputs.json", "utf8"));
ok("provider-output corpus present (>= 80 cases, >= 6 negatives, 14 provider tags)", corpus.format === "totalscript-provider-output-corpus" && corpus.cases.length >= 80 && corpus.cases.filter((c) => c.tag === "negative").length >= 6 && new Set(corpus.cases.map((c) => c.tag)).size >= 14);
const bench = fs.readFileSync("tests/parser-bench.js", "utf8");
ok("parser-bench enforces floors (overall 0.98, negatives 1.0, per-tag 0.9)", bench.includes("const FLOORS = { overall: 0.98, negative: 1.0, perTag: 0.9 }") && bench.includes("process.exitCode = 1"));

console.log(`${fail ? "FAIL" : "OK"}    test-feedback-compact: ${pass} passed, ${fail} failed (mocked - no AI site or Studio involved)`);
if (fail) process.exitCode = 1;
