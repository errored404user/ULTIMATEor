// Quick Node smoke test for src/core/parser.js (run: node test-parser.js). Not shipped.
const fs = require("fs");
const RSParse = new Function(fs.readFileSync(__dirname + "/../src/core/parser.js", "utf8") + "; return RSParse;")();

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

const lua = RSParse.parseToolCalls("###LUA###\nreturn 1+1\n###END_LUA###");
ok("lua block", lua.length === 1 && lua[0].tool === "execute_luau" && lua[0].arguments.code === "return 1+1");
ok("lua defaults to Edit datamodel", lua[0].arguments.datamodel_type === "Edit");

const luaSpaced = RSParse.parseToolCalls("### LUA ###\nlocal s = 'x'\n### END_LUA ###");
ok("markdown-mangled lua markers", luaSpaced.length === 1 && luaSpaced[0].tool === "execute_luau");

const luaServer = RSParse.parseToolCalls("###LUA:Server###\nreturn workspace.Name\n###END_LUA###");
ok("lua :Server datamodel", luaServer.length === 1 && luaServer[0].arguments.datamodel_type === "Server" && luaServer[0].arguments.code === "return workspace.Name");

const luaClient = RSParse.parseToolCalls("### LUA : client ###\nreturn 1\n###END_LUA###");
ok("lua spaced :client datamodel", luaClient.length === 1 && luaClient[0].arguments.datamodel_type === "Client");

// Kimi bleeds its code-block "Copy" button caption into the block text right
// after a lowercase ###lua### marker: `###lua### Copy <code>`. The extracted
// code must NOT start with "Copy" (StudioMCP would reject `Copy task.wait(...)`
// as invalid Lua -> "Failed to parse command code").
const luaCopy = RSParse.parseToolCalls('###lua### Copy task.wait(4)\nreturn "dom test done"\n###END_LUA###');
ok("strips Copy chrome from bare lua block", luaCopy.length === 1 && luaCopy[0].arguments.code === 'task.wait(4)\nreturn "dom test done"');
// A genuine identifier called Copy (no trailing space eaten) must survive.
const luaCopyIdent = RSParse.parseToolCalls("###LUA###\nCopy(workspace)\n###END_LUA###");
ok("keeps legit Copy( identifier", luaCopyIdent[0].arguments.code === "Copy(workspace)");

const paramless = RSParse.parseToolCalls('{"command":"list_commands"}');
ok("paramless command", paramless.length === 1 && paramless[0].tool === "list_commands");

const braces = RSParse.parseToolCalls('{"command":"multi_edit","params":{"code":"if x then {y} end"}}');
ok("braces inside string value", braces.length === 1 && braces[0].arguments.code === "if x then {y} end");

const legacy = RSParse.parseToolCalls('{"tool":"script_read","arguments":{"path":"game.Workspace"}}');
ok("legacy tool/arguments schema", legacy.length === 1 && legacy[0].tool === "script_read");
const encodedParams = RSParse.parseToolCalls('{"command":"inspect_instance","params":"{\\"path\\":\\"game.Workspace\\"}"}');
ok("double-encoded params object", encodedParams.length === 1 && encodedParams[0].arguments.path === "game.Workspace");
const brokenEncodedParams = '{"command":"inspect_instance","params":"{\\"path\\":"}';
ok("malformed encoded params never degrade to empty arguments", RSParse.hasToolSignature(brokenEncodedParams) && RSParse.parseToolCalls(brokenEncodedParams).length === 0);
const trailingComma = RSParse.parseToolCalls('{"command":"list_commands","params":{"query":"ui",},}');
ok("safe trailing commas", trailingComma.length === 1 && trailingComma[0].arguments.query === "ui");

const mcp = RSParse.parseToolCalls('###MCP_TOOL###\n{"command":"get_studio_state"}\n###END_MCP_TOOL###');
ok("mcp_tool wrapper", mcp.length === 1 && mcp[0].tool === "get_studio_state");

const nativeFn = RSParse.parseAlternateToolCalls('```json\n{"name":"list_commands","arguments":{}}\n```');
ok("native function envelope", nativeFn.length === 1 && nativeFn[0].tool === "list_commands");
const taggedFn = RSParse.parseAlternateToolCalls('<tool_call>{"name":"get_studio_state"}</tool_call>');
ok("tagged paramless tool call", taggedFn.length === 1 && taggedFn[0].tool === "get_studio_state");
ok("plain name JSON is not a tool call", RSParse.parseAlternateToolCalls('{"name":"Alice"}').length === 0);
const nestedFn = RSParse.parseAlternateToolCalls('{"type":"function","function":{"name":"script_read","arguments":"{\\"path\\":\\"game.Workspace\\"}"}}');
ok("nested OpenAI function envelope", nestedFn.length === 1 && nestedFn[0].tool === "script_read" && nestedFn[0].arguments.path === "game.Workspace");

// Affected model families leaks several native tool syntaxes into the
// visible answer lane. They must normalize to TotalScript calls, including the paramless
// bootstrap command; src/core/main applies the live-catalogue safety gate.
const glmNative = RSParse.parseAlternateToolCalls('<tool_call>list_commands<arg_key>query</arg_key><arg_value>ui</arg_value></tool_call>');
ok("GLM native XML tool call", glmNative.length === 1 && glmNative[0].tool === "list_commands" && glmNative[0].arguments.query === "ui");
const glmParamless = RSParse.parseAlternateToolCalls('<tool_call>list_commands</tool_call>');
ok("GLM paramless bootstrap tool call", glmParamless.length === 1 && glmParamless[0].tool === "list_commands");
const mimoNative = RSParse.parseAlternateToolCalls('<tool_call><function=inspect_instance><parameter=path>game.Workspace</parameter></tool_call>');
ok("MiMo 2.6 native XML tool call", mimoNative.length === 1 && mimoNative[0].tool === "inspect_instance" && mimoNative[0].arguments.path === "game.Workspace");
const dsmlNative = RSParse.parseAlternateToolCalls('<｜DSML｜tool_calls>\n<｜DSML｜invoke name="list_commands">\n<｜DSML｜parameter name="query" string="true">script</｜DSML｜parameter>\n<｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>');
ok("DeepSeek V4 DSML tool call", dsmlNative.length === 1 && dsmlNative[0].tool === "list_commands" && dsmlNative[0].arguments.query === "script" && dsmlNative[0].arguments.limit === 5);

// 1.47.1 — DeepSeek's web UI renders the DSML envelope with doubled bars and a
// space (`<｜｜DSML｜｜ invoke`), sometimes HTML-escaped; every spelling must parse
// and count as a command signature (seen live: the reply ended as prose and the
// user had to restart the agent after every question).
const dsmlSpaced = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="get_studio_state">\n\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
const dsmlEscaped = '&lt;｜｜DSML｜｜ calls&gt;\n&lt;｜｜DSML｜｜ invoke name="get_studio_state"&gt;\n\n&lt;/｜｜DSML｜｜ invoke&gt;\n&lt;/｜｜DSML｜｜ calls&gt;';
const dsmlSpacedParams = '<｜DSML｜ function_calls>\n<｜DSML｜ invoke name="script_read">\n<｜DSML｜ parameter name="path" string="true">ServerScriptService.Main</｜DSML｜ parameter>\n<｜DSML｜ parameter name="limit">5</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ function_calls>';
for (const [label, txt] of [["spaced double-bar", dsmlSpaced], ["HTML-escaped", dsmlEscaped]]) {
  const calls = RSParse.parseAlternateToolCalls(txt);
  ok("DSML " + label + " spelling parses to get_studio_state", calls.length === 1 && calls[0].tool === "get_studio_state" && JSON.stringify(calls[0].arguments) === "{}", JSON.stringify(calls));
  ok("DSML " + label + " spelling is a command signature / shape / native envelope", RSParse.hasToolSignature(txt) && RSParse.hasCommandShape(txt) && RSParse.NATIVE_TOOL_RE.test(txt));
  ok("DSML " + label + " spelling names the tool for the chip", RSParse.toolNameFromText(txt) === "get_studio_state", RSParse.toolNameFromText(txt));
}
const spacedParams = RSParse.parseAlternateToolCalls(dsmlSpacedParams);
ok("DSML spaced spelling keeps typed parameters", spacedParams.length === 1 && spacedParams[0].tool === "script_read" && spacedParams[0].arguments.path === "ServerScriptService.Main" && spacedParams[0].arguments.limit === 5, JSON.stringify(spacedParams));
ok("unescapeDsml leaves ordinary escaped prose alone", RSParse.unescapeDsml("use &lt;b&gt; tags") === "use &lt;b&gt; tags" && RSParse.unescapeDsml(dsmlEscaped).startsWith("<｜｜DSML｜｜ calls>"));
ok("prose that merely mentions DSML is not a command", RSParse.parseAlternateToolCalls("The DSML format is what DeepSeek uses internally.").length === 0 && !RSParse.hasToolSignature("I will not use DSML here."));const tokenNative = RSParse.parseAlternateToolCalls('<｜tool call begin｜>function=list_commands<｜tool sep｜>{"query":"ui"}<｜tool call end｜>');
ok("DeepSeek native-token tool call", tokenNative.length === 1 && tokenNative[0].arguments.query === "ui");
ok("native tool syntax is a command signature", RSParse.hasToolSignature('<tool_call>list_commands</tool_call>') && RSParse.hasCommandShape('<｜DSML｜invoke name="list_commands"></｜DSML｜invoke>'));
const brokenNative = '<tool_call>{"name":"inspect_instance","arguments":{"path":}</tool_call>';
ok("malformed native call is detectable but never executable", RSParse.hasToolSignature(brokenNative) && RSParse.parseAlternateToolCalls(brokenNative).length === 0);

ok("open lua block detected", RSParse.hasOpenToolBlock("###LUA###\nlocal x=1") === true);
ok("closed lua block not open", RSParse.hasOpenToolBlock("###LUA###\nreturn 1\n###END_LUA###") === false);
ok("open json command detected", RSParse.hasOpenToolBlock('{"command":"multi_edit","params":{"a":1') === true);

ok("prose has no signature", RSParse.hasToolSignature("Here is how you could use a command in theory.") === false);
ok("command shape detected", RSParse.hasCommandShape('{"command":"x"}') === true);
ok("injected feedback detected", RSParse.isInjectedFeedback("Output of 'execute_luau':\n2") === true);
ok("parse-error note is feedback not command", RSParse.isInjectedFeedback('ERROR: bad JSON, write {"command": "name"}') === true);
ok("tool name mid-stream", RSParse.toolNameFromText('{"command":"multi_ed') === "multi_ed");

// ── salvageCutOff: auto-close a command whose trailing closers were cut ──
// The live Qwen case: a big multi_edit missing exactly ONE final "}".
const cut1 = RSParse.salvageCutOff('{"command": "multi_edit", "params": {"datamodel_type": "Edit", "file_path": "game.ServerScriptService.AdminHandler", "edits": [{"old_string": "a", "new_string": "b"}]}');
ok("salvage: one missing root brace", cut1 && cut1.tool === "multi_edit" && cut1.arguments.edits.length === 1);
// Two missing closers (params + root) still salvages.
const cut2 = RSParse.salvageCutOff('{"command": "get_studio_state", "params": {"verbose": true');
ok("salvage: two missing closers", cut2 && cut2.tool === "get_studio_state" && cut2.arguments.verbose === true);
// Cut MID-STRING = real content amputated -> refuse.
ok("salvage refuses mid-string cut", RSParse.salvageCutOff('{"command": "multi_edit", "params": {"edits": [{"old_string": "elseif command ==') === null);
// Deep deficit (cut between edits: ] } } missing = 3 closers) -> refuse.
ok("salvage refuses deep deficit", RSParse.salvageCutOff('{"command": "multi_edit", "params": {"edits": [{"old_string": "a", "new_string": "b"}') === null);
// A CLOSED command is not salvage's business.
ok("salvage ignores closed command", RSParse.salvageCutOff('{"command": "list_commands"}') === null);
// Dangling comma after the last complete value = incomplete next value -> refuse.
ok("salvage refuses trailing comma", RSParse.salvageCutOff('{"command": "multi_edit", "params": {"edits": [{"old_string": "a"},') === null);
// Escaped quotes inside values must not confuse the string tracking.
const cutEsc = RSParse.salvageCutOff('{"command": "execute_luau", "params": {"code": "print(\\"hi\\")", "datamodel_type": "Edit"}');
ok("salvage handles escaped quotes", cutEsc && cutEsc.tool === "execute_luau" && cutEsc.arguments.code === 'print("hi")');

// 1.47.1 — the runtime steers the model back to JSON after a native envelope ran.
{
  const fs = require("fs"), path = require("path");
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "core", "main.js"), "utf8");
  const cfgSrc = fs.readFileSync(path.join(__dirname, "..", "src", "core", "config.js"), "utf8");
  const dsSrc = fs.readFileSync(path.join(__dirname, "..", "src", "providers", "deepseek.js"), "utf8");
  const nvSrc = fs.readFileSync(path.join(__dirname, "..", "src", "providers", "nvidia.js"), "utf8");
  ok("main flags alternate-envelope commands as native", mainSrc.includes('return { kind: "tool", calls: alternateCalls, item: d.item, native: true };'));
  ok("main appends the format note to a native envelope's result", mainSrc.includes('if (res.native) { try { toSend += "\\n\\n" + RS.FEEDBACK.nativeEnvelope;'));
  ok("config carries FEEDBACK.nativeEnvelope asking for fenced JSON", /nativeEnvelope:\s*\n\s*"\(Format note from TotalScript/.test(cfgSrc) && cfgSrc.includes("never the DSML / <tool_call> envelope.)"));
  ok("DeepSeek provider note forbids native DSML markup", dsSrc.includes("NEVER emit your native tool-call markup (<｜DSML｜function_calls>"));
  ok("NVIDIA CMD_SHAPE accepts the spaced / escaped DSML spelling", nvSrc.includes("(?:<|&lt;)\\s*(?:[｜|]{1,2}\\s*DSML\\s*[｜|]{1,2}\\s*)?invoke\\b"));
}
