// 1.81.0 — non-JSON command execution, end to end but MOCKED (no AI site, no
// Studio). Run from the TotalScript root with NODE_PATH pointing at a jsdom
// install: node tests/test-nonjson-protocol.js
//
// What this proves:
//   A. the central parser (src/core/parser.js) reads every supported shape -
//      ###LUA### blocks, the new plain-text ###CMD name### envelope, JSON with
//      and without fences, native tool envelopes - in document order, with
//      prose around them, several per reply, and REFUSES malformed, cut-off,
//      unsupported and shown-only shapes (a bare ```lua fence never runs);
//   B. streaming: an open ###CMD### block keeps the watcher waiting;
//   C. the loop-side contract in main.js / config.js (parse_error reasons,
//      the one-shot "shown, not run" correction, diagnostics stage names);
//   D. the Vani and MiMo adapters run the Luau-first protocol: prompt notes
//      built from the parser's own grammar note, rescue notes without a JSON
//      demand, tool-block masking of ###CMD### <pre>s, DOM / network reads that
//      hand the parser a parseable reply, SPA key changes, no duplicate sends;
//   E. parse → catalogue gate → schema validation → dispatch, with a mock
//      dispatcher: invalid args and unknown names are rejected BEFORE any
//      backend call, Roblox calls go to the Roblox lane only.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400) : "")); } };
const R = new Function(read("src/core/parser.js") + "; return RSParse;")();
const BT = "```";

// ── A. parser grammar ──────────────────────────────────────────────────────
{
  const one = (t) => R.parseToolCalls(t);
  // A1 the smoke-test request, Luau-first, prose around it
  const vaniReply = `I'll create the part now.\n${BT}\n###LUA###\nlocal p = Instance.new("Part")\np.Name = "TotalScript_Vani_SmokeTest"\np.Size = Vector3.new(4, 1, 4)\np.Anchored = true\np.Position = Vector3.new(0, 10, 0)\np.Parent = workspace\nreturn game:GetService("HttpService"):JSONEncode({ name = p.Name, size = tostring(p.Size), anchored = p.Anchored, pos = tostring(p.Position) })\n###END_LUA###\n${BT}\nThen I will report the properties.`;
  let c = one(vaniReply);
  ok("A1 fenced ###LUA### block with prose around → one execute_luau (Edit), code intact, no fence chrome", c.length === 1 && c[0].tool === "execute_luau" && c[0].arguments.datamodel_type === "Edit" && c[0].arguments.code.startsWith('local p = Instance.new("Part")') && c[0].arguments.code.endsWith("})") && !/```/.test(c[0].arguments.code), c);
  // A2 plain-text envelope, typed values
  c = one(`Checking.\n${BT}\n###CMD inspect_instance###\npath: game.Workspace.TotalScript_Vani_SmokeTest\ndepth: 2\ninclude_children: true\nprops: ["Size", "Anchored", "Position"]\n###END_CMD###\n${BT}`);
  ok("A2 ###CMD name### block: key: value lines → typed arguments (string, number, boolean, list)", c.length === 1 && c[0].tool === "inspect_instance" && c[0].arguments.path === "game.Workspace.TotalScript_Vani_SmokeTest" && c[0].arguments.depth === 2 && c[0].arguments.include_children === true && Array.isArray(c[0].arguments.props) && c[0].arguments.props[1] === "Anchored", c);
  c = one("###CMD list_commands###\n###END_CMD###");
  ok("A3 parameterless CMD block (opener + closer only) → {}", c.length === 1 && c[0].tool === "list_commands" && JSON.stringify(c[0].arguments) === "{}", c);
  c = one("### CMD : get_studio_state ### ### END_CMD ###");
  ok("A4 markdown-mangled spacing / colon / dash-tolerant markers still parse", c.length === 1 && c[0].tool === "get_studio_state", c);
  c = one("###COMMAND set_property###\npath = game.Workspace.P\nproperty = Name\nvalue = \"Door: left\"\n###END_COMMAND###");
  ok("A5 COMMAND spelling, '=' separators, quoted value with a colon inside", c.length === 1 && c[0].tool === "set_property" && c[0].arguments.value === "Door: left" && c[0].arguments.property === "Name", c);
  // A6 heredoc: multi-line raw value, special characters, nested braces/quotes, JSON array decoded
  c = one(`###CMD multi_edit###\ndatamodel_type: Edit\nedits: <<<\n[{"path":"game.ServerScriptService.Main","old_string":"local x = 1","new_string":"local x = 2 -- {\\"quoted\\"}"}]\n>>>\nnote: <<<\nline "one" { with: colons }\n  indented \\ backslash and \`backticks\`\n>>>\n###END_CMD###`);
  ok("A6 heredoc values: JSON array decoded, raw text kept verbatim (quotes, braces, backslashes, indentation)", c.length === 1 && Array.isArray(c[0].arguments.edits) && c[0].arguments.edits[0].new_string === 'local x = 2 -- {"quoted"}' && c[0].arguments.note === 'line "one" { with: colons }\n  indented \\ backslash and `backticks`', c);
  // A7 execute_luau through the CMD envelope (raw body) and with code heredoc + datamodel
  c = one("###CMD execute_luau###\nlocal s = \"a:b\"\nreturn s\n###END_CMD###");
  ok("A7a CMD execute_luau with a raw code body (no key lines) → code + Edit (a Lua `local x = 1` line is not mistaken for key=value)", c.length === 1 && c[0].tool === "execute_luau" && c[0].arguments.code === 'local s = "a:b"\nreturn s' && c[0].arguments.datamodel_type === "Edit", c);
  c = one("###CMD execute_luau###\ndatamodel: Server\ncode: <<<\nreturn workspace.Name\n>>>\n###END_CMD###");
  ok("A7b CMD execute_luau with code heredoc + datamodel alias → Server", c.length === 1 && c[0].arguments.code === "return workspace.Name" && c[0].arguments.datamodel_type === "Server", c);
  // A8 several blocks of mixed shapes, document order
  c = one(`First:\n${BT}\n###CMD get_children###\npath: game.Workspace\n${BT}\n###END_CMD###\n${BT}\nthen\n${BT}\n###LUA###\nreturn 1\n###END_LUA###\n${BT}\nand finally\n${BT}json\n{"command":"get_studio_state"}\n${BT}\n###CMD inspect_instance###\n{"path": "game.Lighting"}\n###END_CMD###`);
  ok("A8 four commands of three shapes keep document order; a JSON object body inside a CMD block is accepted; stray fence lines inside a block are ignored", c.length === 4 && c.map((x) => x.tool).join(",") === "get_children,execute_luau,get_studio_state,inspect_instance" && c[0].arguments.path === "game.Workspace" && c[3].arguments.path === "game.Lighting", c.map((x) => x.tool));
  // A9 legacy JSON forms untouched
  ok("A9 JSON with fence, without fence, tool/arguments legacy and escaped 'shown' spelling still parse", one('```json\n{"command":"list_commands","params":{}}\n```').length === 1 && one('{"command":"list_commands"}').length === 1 && one('{"tool":"script_read","arguments":{"path":"x"}}')[0].tool === "script_read" && one('\\`\\`\\`json\n{\\"command\\":\\"list_commands\\",\\"params\\":{}}\n\\`\\`\\`').length === 1);
  ok("A10 native tool envelopes still parse separately (caller gates on the catalogue)", R.parseAlternateToolCalls('<tool_call>{"name":"get_studio_state"}</tool_call>').length === 1 && one('<tool_call>{"name":"get_studio_state"}</tool_call>').length === 0);
  // A11 what must NOT execute
  const shown = `Here is how you could do it:\n${BT}lua\nlocal p = Instance.new("Part")\np.Parent = workspace\n${BT}\nPaste this into a Script.`;
  ok("A11a a bare ```lua fence without markers is NOT a command (shown code never runs) but is counted for the nudge", one(shown).length === 0 && !R.hasToolSignature(shown) && R.bareLuaFences(shown) === 1 && R.describeShapes(shown).luaFence === 1);
  ok("A11b a reply that has real ###LUA### blocks AND an example fence counts no bare fence (the model knows the markers)", R.bareLuaFences(`###LUA###\nreturn 1\n###END_LUA###\n\nexample:\n${BT}lua\nprint(1)\n${BT}`) === 0);
  ok("A11c plain prose that merely names commands or markers in words is not a command", one("You can use inspect_instance, or write a CMD block ending with END_CMD, to look at the Part.").length === 0 && !R.hasToolSignature("Use inspect_instance with path: game.Workspace") && !R.hasCommandShape("I will not write ###CMD here"));
  ok("A11d an opener with no closer parses to NOTHING (never half a command)", one("###CMD inspect_instance###\npath: game.Workspace\n").length === 0);
  const stray = "###CMD inspect_instance###\npath: game.Workspace\nplease look carefully\n###END_CMD###";
  ok("A11e a stray prose line inside a CMD block makes the block malformed → [] + a named problem", one(stray).length === 0 && JSON.stringify(R.cmdBlockProblems(stray)) === '[{"name":"inspect_instance","reason":"body"}]', R.cmdBlockProblems(stray));
  ok("A11f an unterminated <<< heredoc is malformed, not a huge string argument", one("###CMD set_property###\nvalue: <<<\nline\n###END_CMD###").length === 0 && R.cmdBlockProblems("###CMD set_property###\nvalue: <<<\nline\n###END_CMD###")[0].reason === "body");
  ok("A11g ONE malformed block voids the whole reply so a partial batch is never run", one("###CMD get_studio_state###\n###END_CMD###\n###CMD inspect_instance###\nbroken line here\n###END_CMD###").length === 0);
  ok("A11h unsupported syntax (YAML list, XML) is not a command", one("- command: inspect_instance\n  path: game.Workspace").length === 0 && one("<command name=\"inspect_instance\"/>").length === 0);
  ok("A11i empty / whitespace replies parse to nothing without throwing", one("").length === 0 && one("   \n\n").length === 0 && R.describeShapes("").len === 0);
  ok("A11j the ###LUA### and ###MCP_TOOL### markers are not mistaken for CMD openers/closers", !R.CMD_START_RE.test("###LUA###") && !R.CMD_START_RE.test("###MCP_TOOL###") && !R.CMD_END_RE.test("###END_MCP_TOOL###") && !R.CMD_END_RE.test("###END_LUA###"));
  // A12 helpers
  ok("A12 toolNameFromText names the CMD command for the chip; hasCommandShape / hasToolSignature see CMD blocks", R.toolNameFromText("###CMD inspect_instance###\npath: x") === "inspect_instance" && R.hasCommandShape("###CMD a###") && R.hasToolSignature("### CMD b ###"));
  ok("A13 PLAIN_FORMAT_NOTE documents exactly the grammar the parser accepts (###LUA###, ###CMD###, key: value, <<< >>>, JSON optional, bare lua not executed)", /###LUA###/.test(R.PLAIN_FORMAT_NOTE) && /###CMD inspect_instance###/.test(R.PLAIN_FORMAT_NOTE) && /key: <<</.test(R.PLAIN_FORMAT_NOTE) && /never required/.test(R.PLAIN_FORMAT_NOTE) && /NOT executed/.test(R.PLAIN_FORMAT_NOTE) && R.parseToolCalls(R.PLAIN_FORMAT_NOTE).length === 2 && R.parseToolCalls(R.PLAIN_FORMAT_NOTE)[1].arguments.depth === 2);
}

// ── B. streaming / completion ──────────────────────────────────────────────
{
  ok("B1 a CMD block still being streamed is an OPEN tool block (watcher keeps waiting)", R.hasOpenToolBlock("Sure.\n```\n###CMD inspect_instance###\npath: game.Work") === true);
  ok("B2 once the closer lands it is closed", R.hasOpenToolBlock("```\n###CMD inspect_instance###\npath: game.Workspace\n###END_CMD###\n```") === false);
  ok("B3 a closed first block does not hide a second one still streaming", R.hasOpenToolBlock("###CMD a###\n###END_CMD###\n###CMD b###\nx: 1") === true);
  ok("B4 a bare ```lua fence never looks like an open tool block (no endless wait)", R.hasOpenToolBlock("```lua\nlocal x = 1\n") === false);
}

// ── C. loop-side contract (static) ─────────────────────────────────────────
{
  const main = read("src/core/main.js"), cfg = read("src/core/config.js");
  ok("C1 main.js: a closed-but-unreadable CMD block → parse_error 'cmdBlock' (diag parse.cmdBlock), an unclosed one goes to the open-block branch", /RSParse\.cmdBlockProblems\(r\);\s*if \(probs\.length\) \{ diag\("parse\.cmdBlock"/.test(main) && /reason: "cmdBlock"/.test(main) && /CMD_START_RE\.test\(r\) && !RSParse\.hasOpenToolBlock\(r\)/.test(main));
  const RSsrc = cfg + ";globalThis.__RS=RS;";
  vm.runInThisContext(RSsrc); const RS = globalThis.__RS;
  const cmdErr = RS.FEEDBACK.parseError("cmdBlock", "inspect_instance");
  ok("C2 config.js: parseError('cmdBlock') explains the grammar and says NOTHING from that reply ran", /^ERROR: a ###CMD \.\.\.### command block in your reply could not be read, so NO command from that reply ran\./.test(cmdErr) && /"key: <<<" and a line ">>>"/.test(cmdErr) && /###END_CMD###/.test(cmdErr));
  ok("C3 FEEDBACK.parseError('cmdBlock') resolves (not the generic malformed text) and FEEDBACK.luaFence exists", /###CMD/.test(RS.FEEDBACK.parseError("cmdBlock", "inspect_instance")) && /shown code is never executed/.test(RS.FEEDBACK.luaFence) && /###LUA### and ###END_LUA###/.test(RS.FEEDBACK.luaFence));
  ok("C4 capabilityRefuse names all three runnable forms, JSON last", /a ###LUA### block, a ###CMD name### block, or a fenced json command/.test(RS.FEEDBACK.capabilityRefuse));
  ok("C5 main.js: the 'shown, not run' correction fires ONCE per run, only before any tool ran, only for mutating non-explain tasks, and logs the stage without content", /let luaFenceNudged = false/.test(main) && /!luaFenceNudged && !A\.stop && toolTurns === 0 && A\.task && A\.task\.mutates && !A\.task\.explainOnly && fenceShapes && fenceShapes\.luaFence > 0/.test(main) && /diag\("reply\.shownNotRun", fenceShapes\)/.test(main) && /RS\.FEEDBACK\.luaFence/.test(main));
  ok("C6 main.js: the correction runs before the generic commandless rescue (so the specific reason wins)", main.indexOf("RS.FEEDBACK.luaFence") < main.indexOf('diag("loop.capabilityRefuse"'));
  ok("C7 chip detail for the new reason", /res\.reason === "cmdBlock" \? "bad ###CMD### block"/.test(main));
  ok("C8 describeShapes carries no reply text (stage diagnostics only)", (() => { const d = R.describeShapes("###CMD a###\nsecret: value\n###END_CMD###"); return !JSON.stringify(d).includes("secret") && typeof d.len === "number"; })());
}

// ── D. adapters (jsdom) ────────────────────────────────────────────────────
let JSDOM = null, VirtualConsole = null;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch {}
const CMD_REPLY = `Let me inspect it.\n\`\`\`\n###CMD inspect_instance###\npath: game.Workspace.TotalScript_Vani_SmokeTest\ndepth: 1\n###END_CMD###\n\`\`\``;
const LUA_REPLY = "```\n###LUA###\nlocal p = workspace:FindFirstChild(\"TotalScript_Vani_SmokeTest\")\nreturn p and tostring(p.Size)\n###END_LUA###\n```";
function adapterChecks(label, P, w, items) {
  ok(`${label} D1 promptExtra is built from the parser's grammar note (single source) and no longer demands a fenced json block`, /###CMD inspect_instance###/.test(P.promptExtra) && /###LUA###/.test(P.promptExtra) && !/ONE fenced code block: three backticks, the word json/.test(P.promptExtra) && !/exactly \{\\"command\\"/.test(P.promptExtra));
  ok(`${label} D2 two escalating rescues; both notes ask for ###LUA### / ###CMD### blocks, name list_commands as the fallback, contain no fence and no JSON demand`, P.commandlessRetries === 2 && [P.commandlessRetryFeedback, P.commandlessRetryFeedbackFinal].every((t) => typeof t === "string" && /###LUA###/.test(t) && /###CMD/.test(t) && /list_commands/.test(t) && !/```/.test(t) && /No JSON is required|no JSON needed/i.test(t)));
  ok(`${label} D3 a CMD block, a LUA block or a JSON block is never a 'commandless' reply; prose refusals / fake completions are`, P.shouldRetryCommandlessText(CMD_REPLY) === false && P.shouldRetryCommandlessText(LUA_REPLY) === false && P.shouldRetryCommandlessText('```json\n{"command":"list_commands"}\n```') === false && P.shouldRetryCommandlessText("I can't run commands in Roblox Studio from here.") === true && P.shouldRetryCommandlessText("Done! The part has been created.") === true && P.shouldRetryCommandlessText("") === false);
  if (items) {
    const spot = P.findToolBlockSpot(items.cmdItem);
    ok(`${label} D4 a <pre> holding a ###CMD### block is masked and anchors the chip (same as JSON / LUA blocks)`, !!spot && spot.ref.tagName === "PRE" && spot.ref.classList.contains("rs-tool-hide"));
    const txt = P.itemText(items.cmdItem);
    const calls = R.parseToolCalls(txt);
    ok(`${label} D5 the assistant row's text as read by the adapter parses to the inspect_instance call`, calls.length === 1 && calls[0].tool === "inspect_instance" && calls[0].arguments.path === "game.Workspace.TotalScript_Vani_SmokeTest" && calls[0].arguments.depth === 1, txt);
    ok(`${label} D6 the user's own row (quoting the same block) is a user item, never an assistant reply`, P.isUserItem(items.userItem) && !P.isAssistantItem(items.userItem));
  }
}
(async () => {
  if (!JSDOM) { console.log("SKIP jsdom not installed — adapter checks (D)"); } else {
    const vc = new VirtualConsole(); vc.on("error", () => {}); vc.on("jsdomError", () => {});
    // D-MiMo
    {
      const SEND_D = "M.244 7.921 18.202.03c.254-.111.528.115.452.373L14.51 14.345";
      const html = `<!doctype html><html><head><style>button,textarea,div{display:block}</style></head><body>
        <div class="dialogue-container"><div class="message-list">
          <div class="message-item user-message"><div class="content">Use this: ###CMD inspect_instance### path: x ###END_CMD###</div></div>
          <div class="message-item assistant-message"><div class="markdown-body"><p>Let me inspect it.</p><pre><code>###CMD inspect_instance###\npath: game.Workspace.TotalScript_Vani_SmokeTest\ndepth: 1\n###END_CMD###</code></pre></div></div>
        </div><div class="input-area"><textarea placeholder="给 MiMo 发消息"></textarea><button class="send-btn"><svg><path d="${SEND_D}"/></svg></button></div></div></body></html>`;
      const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://aistudio.xiaomimimo.com/#/chat/abc123", virtualConsole: vc });
      const w = dom.window;
      w.Element.prototype.getBoundingClientRect = function () { return { width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40 }; };
      w.eval(read("src/core/parser.js") + ";window.RSParse = RSParse;"); // classic content scripts share one global lexical scope
      w.eval(read("src/providers/stream-reader.js"));
      w.eval(read("src/providers/mimo.js"));
      const P = w.RSProvider;
      const items = P.allItems();
      adapterChecks("MiMo", P, w, { userItem: items[0], cmdItem: items[1] });
      ok("MiMo D7 a bare ```lua reply IS a commandless reply for the rescue (shown code is not an action)", P.shouldRetryCommandlessText("Here you go:\n```lua\nlocal p = Instance.new('Part')\n```") === true);
      // network path: the tap publishes a <think> + CMD reply; readAssistant hands the parser a clean reply
      const node = w.document.createElement("div"); node.id = "rs-stream-net"; w.document.documentElement.appendChild(node);
      const pub = (o) => { node.textContent = JSON.stringify(Object.assign({ rid: 3, t: Date.now(), matched: true, kind: "sse", url: "/open-apis/bot/chat", status: 200, err: "", startedAt: Date.now(), sentAt: Date.now(), chunks: 1 }, o)); };
      w.RSStreamNet.markSent("inspect it");
      pub({ text: "<think>I should use a CMD block ###CMD delete_instance### path: game.Workspace ###END_CMD###</think>" + CMD_REPLY, done: true });
      const ra = P.readAssistant();
      const netCalls = R.parseToolCalls(ra.reply || "");
      ok("MiMo D8 network read: the <think> part (which held a DIFFERENT command) is dropped; only the final answer's CMD block parses", ra.net === true && netCalls.length === 1 && netCalls[0].tool === "inspect_instance" && !/delete_instance/.test(ra.reply) && P.commandsMayAppearInThinking === false, { reply: ra.reply, thinking: (ra.thinking || "").slice(0, 60) });
      pub({ text: "<think>planning", done: false });
      ok("MiMo D9 while still generating (open <think>, stream not done) the reply is empty → nothing to parse yet", P.readAssistant().reply === "" && P.isGenerating() === true);
      // SPA: hash change → new conversation key, items re-scanned
      w.location.hash = "#/chat/zzz999";
      ok("MiMo D10 SPA navigation (hash) changes the conversation key without re-injection", P.conversationKey() === "zzz999");
      // duplicate send guard: one Enter → exactly one onUserMessage even with hooks installed once per page
      const calls = [];
      P.installSendHooks({ isBlocked: () => false, isStarted: () => true, onBlockedAttempt: () => calls.push("blocked"), onUserMessage: (c) => calls.push("msg"), onNativeStop: () => calls.push("stop") });
      const ed = P.getEditor(); ed.value = "hello";
      ed.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      ok("MiMo D11 one Enter → one onUserMessage (no duplicate send signal)", calls.length === 1, calls);
      ok("MiMo D12 adapter version marker bumped for 1.81.0", read("src/providers/mimo.js").includes('setAttribute("data-rs-mimo-ver", "2026-10b")'));
    }
    // D-Vani
    {
      const html = `<!doctype html><html><head><style>button,textarea,div{display:block}</style></head><body><main>
        <div data-role="user"><div class="prose">Please run ###CMD inspect_instance### path: x ###END_CMD### for me</div></div>
        <div data-role="assistant"><div class="prose"><p>Let me inspect it.</p><pre><code>###CMD inspect_instance###\npath: game.Workspace.TotalScript_Vani_SmokeTest\ndepth: 1\n###END_CMD###</code></pre></div></div>
        <form><textarea placeholder="Message Vani"></textarea><button type="submit" aria-label="Send message">Send</button></form></main></body></html>`;
      const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://c.vani.ai/c/abcdef", virtualConsole: vc });
      const w = dom.window;
      w.Element.prototype.getBoundingClientRect = function () { return { width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40 }; };
      // jsdom has no innerText (the adapter's chrome filter reads it) - map it to textContent.
      Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
      w.eval(read("src/core/parser.js") + ";window.RSParse = RSParse;");
      w.eval(read("src/providers/stream-reader.js"));
      w.eval(read("src/providers/vani.js"));
      const P = w.RSProvider;
      const items = P.allItems();
      const cmdItem = items.find((i) => P.isAssistantItem(i)), userItem = items.find((i) => P.isUserItem(i));
      adapterChecks("Vani", P, w, cmdItem && userItem ? { userItem, cmdItem } : null);
      if (!(cmdItem && userItem)) ok("Vani D4-6 skipped: this DOM fixture did not resolve roles (" + items.length + " items)", true);
      ok("Vani D7 site rules keep the Vani-specific constraints (no web search / Document / tool proposals, allowance note) on top of the shared grammar", /Do NOT search the web/.test(P.promptExtra) && /Document \/ Slides \/ Design \/ canvas \/ artifact/.test(P.promptExtra) && /free allowance/.test(P.promptExtra) && /shown code is not executed/.test(P.promptExtra));
      const net = read("src/providers/vani-net.js");
      ok("Vani D8 request-shaper PIN asks for ###LUA### / ###CMD### blocks (JSON optional) and says shown code is not executed", /no JSON needed: ###LUA###/.test(net) && /###CMD name###/.test(net) && /shown code is not executed/.test(net));
      ok("Vani D9 promptExtra degrades gracefully when the parser is absent (isolated load) - site rules only, no throw", (() => { const d2 = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://c.vani.ai/c", virtualConsole: vc }); d2.window.eval(read("src/providers/vani.js")); const t = d2.window.RSProvider.promptExtra; return typeof t === "string" && /Vani Chat rules/.test(t) && !/###CMD inspect_instance###/.test(t); })());
    }
  }

  // ── E. parse → gate → validate → dispatch (mock dispatcher) ────────────────
  {
    const O = require(path.join(ROOT, "src/core/orchestrator.js"));
    const catalogue = new Map([
      ["inspect_instance", { name: "inspect_instance", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, depth: { type: "integer" } }, additionalProperties: false } }],
      ["execute_luau", { name: "execute_luau", inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" }, datamodel_type: { type: "string", enum: ["Edit", "Server", "Client"] } } } }],
      ["set_property", { name: "set_property", inputSchema: { type: "object", required: ["path", "property", "value"], properties: { path: { type: "string" }, property: { type: "string" }, value: {} } } }],
    ]);
    const lanes = { roblox: [], local: [] };
    // Mirrors the order main.js applies: catalogue gate → required params → schema → engine lane.
    const dispatch = (text, engine) => {
      const out = [];
      for (const call of R.parseToolCalls(text)) {
        const t = catalogue.get(call.tool);
        if (!t) { out.push({ tool: call.tool, err: "COMMAND_NOT_FOUND" }); continue; }
        const missing = (t.inputSchema.required || []).filter((k) => !(k in call.arguments));
        if (missing.length) { out.push({ tool: call.tool, err: "MISSING_PARAMS:" + missing.join(",") }); continue; }
        const v = O.validateToolArgs(t.inputSchema, call.arguments);
        if (v.problems.length) { out.push({ tool: call.tool, err: "INVALID:" + v.problems.map((p) => p.key).join(",") }); continue; }
        lanes[engine].push({ tool: call.tool, args: v.args });
        out.push({ tool: call.tool, ok: true, args: v.args });
      }
      return out;
    };
    let r = dispatch("###CMD inspect_instance###\npath: game.Workspace.P\ndepth: 2\n###END_CMD###", "roblox");
    ok("E1 valid CMD block → validated and dispatched on the Roblox lane only", r.length === 1 && r[0].ok && lanes.roblox.length === 1 && lanes.local.length === 0, r);
    r = dispatch("###CMD inspect_instance###\ndepth: 2\n###END_CMD###", "roblox");
    ok("E2 missing required 'path' → rejected BEFORE any backend call", r[0].err === "MISSING_PARAMS:path" && lanes.roblox.length === 1, r);
    r = dispatch("###CMD inspect_instance###\npath: game.Workspace\ndepth: deep\n###END_CMD###", "roblox");
    ok("E3 wrong type (depth: deep) → schema rejection, nothing dispatched", /^INVALID:depth/.test(r[0].err || "") && lanes.roblox.length === 1, r);
    r = dispatch("###CMD make_everything###\nwish: pony\n###END_CMD###", "roblox");
    ok("E4 unknown command name → COMMAND_NOT_FOUND, nothing dispatched (examples / invented names cannot run)", r[0].err === "COMMAND_NOT_FOUND" && lanes.roblox.length === 1, r);
    r = dispatch("###LUA:Client###\nreturn 1\n###END_LUA###\n###CMD set_property###\npath: game.Workspace.P\nproperty: Anchored\nvalue: true\n###END_CMD###", "roblox");
    ok("E5 two operations in one reply → both validated and dispatched in order on the same lane", r.length === 2 && r.every((x) => x.ok) && lanes.roblox.slice(-2).map((x) => x.tool).join(",") === "execute_luau,set_property" && lanes.roblox.slice(-1)[0].args.value === true && lanes.roblox.slice(-2)[0].args.datamodel_type === "Client", r);
    r = dispatch("###CMD inspect_instance###\npath: a\nthis line breaks it\n###END_CMD###\n###CMD set_property###\npath: a\nproperty: Name\nvalue: b\n###END_CMD###", "roblox");
    ok("E6 a malformed block in a batch → NOTHING dispatched from that reply (no partial batch)", r.length === 0 && lanes.roblox.length === 3, r);
    ok("E7 the AgentScript lane was never touched by Roblox replies", lanes.local.length === 0);
  }

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS (mocked — no AI site or Studio involved)");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("harness error", e); process.exit(1); });
