// 1.94.0 — Vani "cannot use JSON blocks, only shows plain text". MOCKED (no
// Vani page, no Studio). Run from the TotalScript root:
//   NODE_PATH=/path/to/jsdom/node_modules node tests/test-vani-plain.js
//
// Root cause (source audit, 1.93.0): the Vani adapter's own notes and the
// request pin taught the ###CMD### / ###LUA### blocks, but the CORE bootstrap
// (buildCompactPrompt, which Vani always gets through sysMaxChars 14000) still
// said "Commands are plain JSON ... STANDARD FORMAT ```json {...}```". Two
// formats in one prompt, on a site whose platform prompt tells the model it
// cannot use JSON blocks -> prose. The fix is a provider capability
// (`commandFormat: "plain"`) that config.js honours without naming a site.
//
// What this proves:
//   A. the Vani adapter declares the capability and main.js forwards it;
//   B. the system prompt Vani receives contains NO json fence and no "plain
//      JSON" channel line; the CMD block is the STANDARD FORMAT; the examples
//      in it are parseable by the central parser (prompt and grammar agree);
//   C. the parse-error feedback for a plain provider names the CMD block;
//   D. every default (JSON) prompt / feedback string is byte-identical to the
//      1.93.0 wording (no other provider changed);
//   E. the request pin no longer mentions the JSON envelope.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } };

global.window = global;
window.__rsWorkMode = () => "creation";
vm.runInThisContext(read("src/core/parser.js") + ";globalThis.RSParse=RSParse;");
vm.runInThisContext(read("src/core/config.js") + ";globalThis.__RS=RS;");
const RS = globalThis.__RS, R = globalThis.RSParse;
const BT = "```";

// Vani adapter loaded in a vm sandbox (DOM-free: only the capability getters are read).
const html = { setAttribute() {}, getAttribute() { return null; } };
const ctx = { window: {}, document: { documentElement: html, querySelector() { return null; }, querySelectorAll() { return []; } }, location: { href: "https://c.vani.ai/chat" }, console: { log() {}, warn() {}, error() {} }, RSParse: R, navigator: { userAgent: "x" }, MutationObserver: class { observe() {} }, setTimeout, clearTimeout, setInterval, clearInterval, URL, JSON, Object, Array, String, Number, RegExp, Math, Date, Error, Promise };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(read("src/providers/vani.js") + ";this.__V=RSProvider;", ctx);
const P = ctx.__V;
const main = read("src/core/main.js");
const vaniSrc = read("src/providers/vani.js");
const net = read("src/providers/vani-net.js");

// ── A. capability wiring ───────────────────────────────────────────────────
ok("A1 Vani adapter declares commandFormat: \"plain\" (sysMaxChars 14000 → compact core; compactCommandList → list_commands-first bootstrap)", P.commandFormat === "plain" && P.sysMaxChars === 14000 && P.compactCommandList === true);
ok("A2 main.js forwards the capability to buildSystemPrompt (one line, no provider conditional)", /commandFormat: P\.commandFormat \|\| "",/.test(main) && !/P\.id === "vani"/.test(main));
ok("A3 main.js passes the plain flag to FEEDBACK.parseError on the correction turn", /RS\.FEEDBACK\.parseError\(res\.reason, failName, P\.commandFormat === "plain"\)/.test(main));
ok("A4 config.js never names a site for the plain format (capability only)", !/vani/i.test(read("src/core/config.js").split("\n").filter((l) => /plain/.test(l)).join("\n")));
ok("A5 adapter version marker and shaper marker are NOT bumped (pinned 2026-10f / 1.81)", vaniSrc.includes('setAttribute("data-rs-vani-ver", "2026-10f")') && net.includes('setAttribute("data-rs-vani-net", "1.81")'));

// ── B. the prompt Vani receives ────────────────────────────────────────────
const vaniPrompt = RS.buildSystemPrompt({ siteName: P.displayName, providerId: P.id, providerNotes: P.promptExtra || "", engine: "roblox", maxChars: P.sysMaxChars, commandFormat: P.commandFormat });
const core = vaniPrompt.split("━━━ ADDITIONAL RULES FOR THIS SITE ━━━")[0];
ok("B1 compact core is used (14k budget) and it contains NO json fence anywhere in the whole prompt", core.includes("CONTEXT: the user installed \"TotalScript\"") && !vaniPrompt.includes(BT + "json"), { len: vaniPrompt.length });
ok("B2 no 'Commands are plain JSON' channel line; the plain channel line is there instead", !vaniPrompt.includes("Commands are plain JSON") && core.includes("Commands are plain-text blocks in your normal reply - the only channel that works; no JSON needed."));
ok("B3 STANDARD FORMAT is the CMD block (opener / key: value / closer) and execute_luau keeps the ###LUA### block", /STANDARD FORMAT \(all but execute_luau\) - a CMD block/.test(core) && core.includes(BT + "\n###CMD name###\nkey: value\n###END_CMD###\n" + BT) && core.includes("###LUA###\n-- lua code, no escaping\nreturn \"result\"\n###END_LUA###"));
ok("B4 no JSON envelope example survives in the core ({\"command\": ...} only appears in the provider note's 'still accepted' sentence)", !/\{"command"\s*:/.test(core) && (vaniPrompt.match(/\{"command"/g) || []).length === 1 && /still accepted but never required/.test(vaniPrompt));
ok("B5 the dummy example is a CMD block, not JSON", /a fenced ###CMD npc_spawn_pathfinding### block with the line rig_name: Dummy/.test(core));
ok("B6 first action is still list_commands (name only - the model writes it as a CMD block)", /Your FIRST action: list_commands \{\}/.test(core));
// prompt ↔ grammar agreement: the exact blocks shown in the prompt parse.
const fenced = [...core.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
ok("B7 the two fenced examples in the core are exactly one CMD block and one LUA block", fenced.length === 2 && /^###CMD name###/.test(fenced[0]) && /^###LUA###/.test(fenced[1]), fenced.map((f) => f.slice(0, 20)));
const demo = fenced[0].replace("###CMD name###", "###CMD inspect_instance###").replace("key: value", "path: game.Workspace.Demo");
const calls = R.parseToolCalls(BT + "\n" + demo + "\n" + BT);
ok("B8 the CMD example (with a real name/param) parses to a tool call with the param as text", calls.length === 1 && calls[0].tool === "inspect_instance" && calls[0].arguments && calls[0].arguments.path === "game.Workspace.Demo", calls);
const luaCalls = R.parseToolCalls(BT + "\n" + fenced[1] + "\n" + BT);
ok("B9 the LUA example parses to execute_luau with the code verbatim", luaCalls.length === 1 && luaCalls[0].tool === "execute_luau" && /return "result"/.test(luaCalls[0].arguments.code || JSON.stringify(luaCalls[0].arguments)), luaCalls);
const first = R.parseToolCalls(BT + "\n###CMD list_commands###\n###END_CMD###\n" + BT);
ok("B10 the expected first reply (###CMD list_commands### + closer, no params) parses", first.length === 1 && first[0].tool === "list_commands");
const dummy = R.parseToolCalls(BT + "\n###CMD npc_spawn_pathfinding###\nrig_name: Dummy\n###END_CMD###\n" + BT);
ok("B11 the dummy example written as instructed parses with rig_name", dummy.length === 1 && dummy[0].tool === "npc_spawn_pathfinding" && dummy[0].arguments.rig_name === "Dummy");
ok("B12 Vani prompt stays within the known soft budget (core ≤ 14000 before site notes; whole prompt < 17600)", core.length <= 14000 && vaniPrompt.length < 17600, { core: core.length, whole: vaniPrompt.length });
ok("B13 the site notes still follow (VANI rules + PLAIN_FORMAT_NOTE) - one consistent story, no contradiction", vaniPrompt.includes("Vani Chat rules:") && vaniPrompt.includes(R.PLAIN_FORMAT_NOTE));
// the full (non-compact) prompt also honours the flag, for any roomy plain provider
const fullPlain = RS.buildSystemPrompt({ siteName: "X", providerId: "x", engine: "roblox", maxChars: 0, commandFormat: "plain" });
ok("B14 full prompt with commandFormat plain: CMD block is the STANDARD COMMAND FORMAT, no json fence, no JSON envelope example", /━━━ STANDARD COMMAND FORMAT \(everything except execute_luau\) ━━━\nWrite a CMD block/.test(fullPlain) && !fullPlain.includes(BT + "json") && !/\{"command": "list_commands"\}/.test(fullPlain) && /━━━ FORMAT FOR execute_luau ━━━/.test(fullPlain));

// ── C. parse-error feedback for a plain provider ───────────────────────────
for (const reason of ["malformed", "unclosed", "envelope", "toolKey"]) {
  const t = RS.FEEDBACK.parseError(reason, "command", true);
  ok(`C1 parseError('${reason}', plain) names the CMD block, not the JSON envelope`, /###CMD exact_command_name###/.test(t) && /###END_CMD###/.test(t) && !/\{"command": "name"/.test(t) && /###LUA###/.test(t) && /Nothing ran/.test(t));
}
ok("C2 plain parseError for a known non-luau command drops the ###LUA### hint", !/###LUA###/.test(RS.FEEDBACK.parseError("malformed", "execute_blender_code", true)));
ok("C3 'unclosed' explains the cut-off; 'cmdBlock' / 'luaOpener' keep their specific texts", /cut off before it finished/.test(RS.FEEDBACK.parseError("unclosed", "command", true)) && /^ERROR: a ###CMD \.\.\.### command block/.test(RS.FEEDBACK.parseError("cmdBlock", "x", true)) && /closing ###END_LUA### marker but not the opening/.test(RS.FEEDBACK.parseError("luaOpener", "x", true)));

// ── D. defaults unchanged (other providers) ────────────────────────────────
const chatgpt = RS.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000 });
ok("D1 ChatGPT (compact, JSON) keeps the 1.93.0 wording", chatgpt.includes("Commands are plain JSON in your normal reply - the only channel that works.") && chatgpt.includes("STANDARD FORMAT (everything except execute_luau):\n" + BT + "json\n{\"command\": \"name\", \"params\": {\"key\": \"value\"}}\n" + BT + "\nexecute_luau NEVER uses JSON - markers only, inside one fenced block:") && chatgpt.includes('(e.g. {"command":"npc_spawn_pathfinding","params":{"rig_name":"Dummy"}})'));
const gemini = RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox", maxChars: 0 });
ok("D2 Gemini (full, JSON) keeps the 1.93.0 STANDARD COMMAND FORMAT + SPECIAL FORMAT sections", gemini.includes("━━━ STANDARD COMMAND FORMAT (everything except execute_luau) ━━━\nWrite this JSON object inside a fenced code block") && gemini.includes("For example, to list every available command you would write " + BT + '{"command": "list_commands"}' + BT + ".") && gemini.includes("━━━ SPECIAL FORMAT FOR execute_luau ━━━\nexecute_luau is the ONE exception to the JSON format above") && gemini.includes("The ###LUA### block needs NO escaping and NO JSON, so this never happens.\nThe ###LUA### / ###END_LUA### markers AND the code all go INSIDE one fenced code block:"));
ok("D3 ChatGPT / Vani compact prompts stay ≤ 14000 without site notes (test-v139 budget)", chatgpt.length <= 14000 && RS.buildSystemPrompt({ siteName: "vani", providerId: "vani", engine: "roblox", maxChars: 14000, commandFormat: "plain" }).length <= 14000, { chatgpt: chatgpt.length });
ok("D4 default parseError texts unchanged (JSON envelope advice)", /Rewrite it as a single valid JSON object in plain text, exactly like \{"command": "name", "params": \{\.\.\.\}\}/.test(RS.FEEDBACK.parseError("malformed", "command")) && /The key must be exactly "command"/.test(RS.FEEDBACK.parseError("toolKey", "x")) && RS.FEEDBACK.parseError("malformed", "command") === RS.FEEDBACK.parseError("malformed", "command", false));
ok("D5 an undeclared commandFormat (every other provider) yields the JSON prompt", RS.buildSystemPrompt({ siteName: "Z", providerId: "z", engine: "roblox", maxChars: 14000 }) === RS.buildSystemPrompt({ siteName: "Z", providerId: "z", engine: "roblox", maxChars: 14000, commandFormat: "" }));

// ── E. request pin ─────────────────────────────────────────────────────────
ok("E1 vani-net PIN no longer offers the ```json envelope (###LUA### / ###CMD name### only; shown code is not executed)", !/```json/.test(net) && /no JSON needed: ###LUA###/.test(net) && /###CMD name###/.test(net) && /shown code is not executed/.test(net));
ok("E2 README documents 1.94.0 and lists this test", /\*\*1\.94\.0 — Vani/.test(read("README.md")) && read("README.md").includes("test-vani-plain.js"));

console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
process.exit(failed ? 1 : 0);
