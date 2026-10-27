// 1.78.1 — Vani: "shown, not fenced" command blocks.
//
// Reported live (logged-in Vani account): the model answers in prose or SHOWS
// the command block as plain text - the page renders visible backticks - and
// TotalScript treated the reply as commandless ("the AI says it can't use JSON
// blocks"). Root cause: the parser accepted only strictly double-quoted
// "command" JSON; markdown-escaped (\`\`\`json {\"command\":…}), single-quoted,
// JS-literal, entity-encoded and \_-escaped spellings all parsed to nothing.
// This test pins the relaxed second pass (same strict scanner, normalised
// input - never a looser parse of prose), the prompt / pin wording that tells
// the model to write a real unescaped fence, and the shaper's message-shape
// fallbacks. Run: node tests/test-vani-format.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
process.chdir(root);
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (extra !== undefined ? "  →  " + String(extra).slice(0, 200) : "")); } };

global.window = global;
vm.runInThisContext(read("src/core/parser.js") + ";globalThis.__P=RSParse;");
const P = globalThis.__P;
const first = (t) => { const r = P.parseToolCalls(t); return r.length ? r[0] : null; };

// ── 1. relaxed shapes parse to the same strict call ─────────────────────────
const shapes = {
  "escaped quotes + backticks": "\\`\\`\\`json\n{\\\"command\\\":\\\"list_commands\\\",\\\"params\\\":{}}\n\\`\\`\\`",
  "escaped backticks only": "\\`\\`\\`json\n{\"command\":\"list_commands\",\"params\":{}}\n\\`\\`\\`",
  "single quotes": "```json\n{'command':'list_commands','params':{}}\n```",
  "JS object literal keys": "```json\n{command:\"list_commands\", params:{}}\n```",
  "escaped braces": "\\{\"command\":\"list_commands\",\"params\":\\{\\}\\}",
  "HTML entities": "<code>{&quot;command&quot;:&quot;list_commands&quot;,&quot;params&quot;:{}}</code>",
  "markdown-escaped underscore": "```json\n{\"command\":\"list\\_commands\",\"params\":{}}\n```",
  "inline fence": "Sure: ```json {\"command\":\"list_commands\",\"params\":{}} ```",
};
for (const [name, text] of Object.entries(shapes)) {
  const c = first(text);
  ok("parses: " + name, c && c.tool === "list_commands" && JSON.stringify(c.arguments) === "{}", JSON.stringify(c));
  ok("hasCommandShape / hasToolSignature: " + name, P.hasCommandShape(text) && P.hasToolSignature(text));
}
{
  const c = first("\\`\\`\\`json\\n\\{\\\"command\\\": \\\"create_part\\\", \\\"params\\\": \\{\\\"name\\\": \\\"X\\\"\\}\\}\\n\\`\\`\\`");
  ok("fully escaped one-liner (literal \\n between tokens) carries its params", c && c.tool === "create_part" && c.arguments.name === "X", JSON.stringify(c));
  const esc = "Here it is:\n\\`\\`\\`json\n{\\\"command\\\":\\\"execute_luau\\\",\\\"params\\\":{\\\"code\\\":\\\"print(\\\\\\\"hi\\\\\\\")\\\\nreturn 1\\\"}}\n\\`\\`\\`";
  const e = first(esc);
  ok("escaped execute_luau keeps the inner escaped quotes and newline of its code", e && e.tool === "execute_luau" && e.arguments.code === 'print("hi")\nreturn 1', JSON.stringify(e));
  const two = P.parseToolCalls("{'command':'a_cmd','params':{'n':1}} then {command:\"b_cmd\", params:{ok:true, s:'it\\'s \"q\"'}}");
  ok("several relaxed envelopes in one reply, in order, with quotes inside values preserved", two.length === 2 && two[0].tool === "a_cmd" && two[0].arguments.n === 1 && two[1].tool === "b_cmd" && two[1].arguments.s === 'it\'s "q"', JSON.stringify(two));
}
// ── 2. strict replies are untouched ─────────────────────────────────────────
{
  const lua = "```json\n{\"command\":\"execute_luau\",\"params\":{\"code\":\"print(\\\"hi\\\")\\nlocal s = 'a\\\\nb'\\nreturn {x=1}\",\"datamodel_type\":\"Edit\"}}\n```";
  const c = first(lua);
  ok("strict JSON with escaped quotes / \\\\n / apostrophes in code is parsed by the strict pass unchanged", c && c.arguments.code === "print(\"hi\")\nlocal s = 'a\\nb'\nreturn {x=1}", JSON.stringify(c));
  ok("relaxCommandText returns null for a strict reply", P.relaxCommandText(lua) === null);
}
// ── 3. prose never becomes a command ────────────────────────────────────────
const prose = {
  "prose naming a key": "The command: \"list_commands\" lists everything you can do.",
  "prose quoting the schema": "I can't use the {\"command\": ...} format you described, sorry.",
  "apostrophes + a Lua table": "Don't worry, it's fine. Let's use 'move' instead of {'x':1}.",
  "inline Lua": "In Lua you write `print('hi')` and then {ok = true}.",
  "bare argument object": "{\"file_path\":\"a.lua\",\"edits\":[]}",
};
for (const [name, text] of Object.entries(prose)) {
  ok("not a command: " + name, P.parseToolCalls(text).length === 0 && !P.hasCommandShape(text) && !P.hasToolSignature(text));
}
ok("RELAXED_KEY_RE exported and requires a brace/comma before a bare key", P.RELAXED_KEY_RE instanceof RegExp && !P.RELAXED_KEY_RE.test('command: "x"') && P.RELAXED_KEY_RE.test('{command: "x"'));
// ── 4. chip names from relaxed spellings ────────────────────────────────────
ok("toolNameFromText: escaped key with \\_", P.toolNameFromText('{\\"command\\":\\"list\\_commands\\"') === "list_commands");
ok("toolNameFromText: single-quoted / bare / entity keys", P.toolNameFromText("{'command': 'ui_art_build'") === "ui_art_build" && P.toolNameFromText("{command: \"ui_font_set\"") === "ui_font_set" && P.toolNameFromText("{&quot;command&quot;:&quot;get_selection&quot;") === "get_selection");
ok("toolNameFromText: prose still yields the placeholder", P.toolNameFromText("the command: \"x\" is") === "command");

// ── 5. Vani adapter wording ─────────────────────────────────────────────────
vm.runInThisContext(read("src/providers/vani.js") + ";globalThis.__V=RSProvider;");
const V = globalThis.__V;
const vani = read("src/providers/vani.js");
ok("promptExtra: real markdown fence, never escaped, never quoted / inline / Document / tool proposal", /Write the fence as REAL markdown/.test(V.promptExtra) && /never escape the backticks, quotes or braces with backslashes/.test(V.promptExtra) && /never put the block inside quotes, inline code, a Document or a tool proposal/.test(V.promptExtra));
ok("first rescue note names the escaped / quoted / inline / Document mistake as the reason nothing ran", /showed the block with backslashes before the backticks or quotes, inside quotation marks, as inline code, or inside a Document, that is exactly why nothing ran/.test(V.commandlessRetryFeedback));
ok("final rescue note forbids backslashes outside JSON strings and quotation marks around the block", /no backslashes anywhere outside JSON strings, no quotation marks around the block/.test(V.commandlessRetryFeedbackFinal));
ok("adapter version marker bumped to 2026-10e", vani.includes('setAttribute("data-rs-vani-ver", "2026-10e")'));
ok("CMD_SHAPE (tool-block masking) accepts the relaxed spellings", /CMD_SHAPE = \/.*\\\\"\(\?:command\|tool\)\\\\"\\s\*:.*'\(\?:command\|tool\)'\\s\*:/.test(vani));
ok("an escaped block is no longer a 'commandless' reply for the rescue logic", V.shouldRetryCommandlessText("\\`\\`\\`json\n{\\\"command\\\":\\\"list_commands\\\",\\\"params\\\":{}}\n\\`\\`\\`") === false || P.parseToolCalls("\\`\\`\\`json\n{\\\"command\\\":\\\"list_commands\\\",\\\"params\\\":{}}\n\\`\\`\\`").length === 1);

// ── 6. request shaper: pin wording + message-shape fallbacks ────────────────
const net = read("src/providers/vani-net.js");
ok("PIN tells the model to write a real unescaped fence", /Write the fence as real markdown: a line that is only ```json/.test(net) && /Never escape backticks, quotes or braces with backslashes/.test(net));
ok("shaper marks itself 1.78", net.includes('setAttribute("data-rs-vani-net", "1.78")'));
{
  const html = { attrs: { "data-rs-agent": "on" }, getAttribute(n) { return this.attrs[n] || null; }, setAttribute(n, v) { this.attrs[n] = v; } };
  const ctx = { window: {}, document: { documentElement: html }, console: { log() {} }, location: { href: "https://c.vani.ai/chat" }, URL, JSON, Object, Array, String, Number, RegExp, Math, Date, Error };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(net, ctx);
  const pm = ctx.window.__rsVaniPatchMessages;
  const a = pm([{ role: "user", text: "hello" }]);
  ok("a message carrying its text in `text` is still pinned", a.pinned && typeof a.messages[0].text === "string" && a.messages[0].text.startsWith("[TotalScript bridge]") && a.messages[0].text.endsWith("hello"), JSON.stringify(a.messages[0]).slice(0, 120));
  const b = pm([{ role: "user", parts: [{ type: "text", text: "hi there" }] }]);
  ok("a message carrying its text in `parts` is still pinned", b.pinned && b.messages[0].parts[0].text.startsWith("[TotalScript bridge]"), JSON.stringify(b.messages[0]).slice(0, 120));
  const c = pm([{ role: "user", content: "plain" }]);
  ok("observed `content` shape unchanged", c.pinned && c.messages[0].content.startsWith("[TotalScript bridge]") && c.messages[0].content.endsWith("plain"));
  const d = pm([{ role: "user", content: "[TotalScript bridge] already" }]);
  ok("a message that already carries the pin is left alone", !d.pinned && !d.changed);
}

// ── 7. release bookkeeping ──────────────────────────────────────────────────
const readme = read("README.md");
ok("README: 1.78.1 entry + this test listed", /\*\*1\.78\.1 — Vani: "shown, not fenced" command blocks/.test(readme) && readme.includes("test-vani-format.js"));
const manifest = JSON.parse(read("manifest.json"));
ok("version pins 1.79.0", manifest.version === "1.79.0" && /^version = "1\.79\.0"/m.test(read("agent/Cargo.toml")) && read("plugin/TotalScript.lua").includes('local VERSION = "1.79.0"'));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
