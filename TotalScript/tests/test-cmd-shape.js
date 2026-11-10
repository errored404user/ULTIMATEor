"use strict";
// 2.19.0 — ###CMD name### parity across EVERY chat-site adapter.
//
// The shared parser (src/core/parser.js) has executed the plain-text command
// envelope `###CMD name### … ###END_CMD###` (also ###COMMAND / ###TOOL, and
// `---` as the closer) since 1.81.0, and config.js teaches it as THE format to
// the sites that cannot use JSON. Each adapter, however, decides on its own which
// rendered block is a command block (CMD_SHAPE → hide it behind the chip, anchor
// the chip there, never re-read it as prose). Until 2.16.0 only Vani, Claude and
// GLM knew the ###CMD opener; Arena, ChatGPT, CodeCraft, Gemini, Kimi, MultiChat
// and Qwen masked only ###LUA / ###MCP_TOOL / JSON — a ###CMD block executed
// fine but stayed visible and, on the re-render-heavy sites, kept rebuilding the
// chip. This suite pins the parity:
//   Part 1 (static, regex extracted from the source and evaluated): every
//          CMD_SHAPE accepts exactly the openers RSParse.CMD_START_RE accepts
//          and still rejects headings / prose / the lone closer.
//   Part 2 (static): ChatGPT's unfenced marker pair, Kimi's STARTS_CMD,
//          CodeCraft's MARKER_BLOCK_RE fence helper and DeepSeek's start/end
//          detection carry the same opener.
//   Part 3 (jsdom): the <pre>-scanning adapters mask a ###CMD block through
//          their real findToolBlockSpot and leave a prose <pre> alone.
// OFFLINE / SIMULATED: no site is contacted. Run from the TotalScript root:
//   npm i --no-save jsdom && node tests/test-cmd-shape.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } }

// The shared parser, evaluated for real.
vm.runInThisContext(read("src/core/parser.js") + ";globalThis.__P = RSParse;");
const RSParse = globalThis.__P;
ok("parser exports CMD_START_RE / CMD_END_RE (the ###CMD envelope is a first-class format)", RSParse && RSParse.CMD_START_RE instanceof RegExp && RSParse.CMD_END_RE instanceof RegExp);

// Pull `const NAME = /…/flags;` out of a source file and build the RegExp.
function regexConst(src, name) {
  const m = new RegExp("const " + name + " = /((?:\\\\.|[^/\\n])+)/([a-z]*);").exec(src);
  if (!m) return null;
  try { return new RegExp(m[1], m[2]); } catch (e) { return null; }
}

const ADAPTERS = ["arena", "chatgpt", "codecraft", "gemini", "kimi", "multichat", "qwen", "claude", "glm", "vani"];
const OPENERS = [
  "###CMD part_create###\nname: X\nsize: 4,2,4\n###END_CMD###",
  "###COMMAND part_create###\nname: X\n###END_COMMAND###",
  "###TOOL execute_luau###\ncode: print(1)\n###END_TOOL###",
  "###cmd: npc_spawn_pathfinding###\nrig_name: Dummy\n###END_CMD###",
  "### CMD part_create ---\nname: X\n--- END_CMD ---",
  "Sure - here it is:\n###CMD part_create###\nname: X\n###END_CMD###\nDone.",
];
const STILL_MASKED = ["###LUA###\nprint(1)\n###END_LUA###", "###MCP_TOOL###\n{}\n###END_MCP_TOOL###", '{"command":"part_create","args":{}}'];
const NOT_COMMANDS = [
  "### Tool list\n- part_create\n- execute_luau",
  "### Command summary\nI created the part.",
  "###END_CMD###",
  "local p = Instance.new('Part')\np.Name = 'CMD'\n",
  "Use the CMD tool: open a terminal and type `###`.",
  "###TOOLS### are listed below",
];

// ── Part 1: CMD_SHAPE parity with the parser ─────────────────────────────
for (const id of ADAPTERS) {
  const src = read(`src/providers/${id}.js`);
  const re = regexConst(src, "CMD_SHAPE");
  ok(`${id}: CMD_SHAPE is a readable regex literal`, re instanceof RegExp, src.match(/const CMD_SHAPE = [^\n]{0,120}/) && src.match(/const CMD_SHAPE = [^\n]{0,120}/)[0]);
  if (!re) continue;
  const miss = OPENERS.filter((s) => !re.test(s));
  ok(`${id}: CMD_SHAPE accepts every ###CMD / ###COMMAND / ###TOOL opener the parser executes`, miss.length === 0, miss);
  const parserAgrees = OPENERS.every((s) => RSParse.CMD_START_RE.test(s));
  ok(`${id}: … and the parser really executes those openers (no adapter-only shape)`, parserAgrees);
  const lost = STILL_MASKED.filter((s) => !re.test(s));
  ok(`${id}: ###LUA, ###MCP_TOOL and JSON commands are still masked`, lost.length === 0, lost);
  const over = NOT_COMMANDS.filter((s) => re.test(s));
  ok(`${id}: headings, prose, Lua mentioning CMD and the lone closer are NOT masked`, over.length === 0, over);
  ok(`${id}: no global flag (a stateful lastIndex would make .test() alternate on re-renders)`, !re.global);
}

// ── Part 2: the sibling shapes each adapter keeps next to CMD_SHAPE ──────
{
  const cg = read("src/providers/chatgpt.js");
  const open = regexConst(cg, "CMD_OPEN"), close = regexConst(cg, "CMD_CLOSE"), commandish = regexConst(cg, "COMMANDISH_TEXT");
  ok("chatgpt: CMD_OPEN (unfenced marker pass) matches the ###CMD name### opener and still ###LUA### / ###MCP_TOOL###",
    !!open && open.test("###CMD part_create###") && open.test("###LUA###") && open.test("###MCP_TOOL###") && open.test("###COMMAND x.y###"));
  ok("chatgpt: CMD_OPEN never matches a closer (opener test can't swallow the END line)",
    !!open && !open.test("###END_CMD###") && !open.test("###END_LUA###") && !open.test("###END_MCP_TOOL###"));
  ok("chatgpt: CMD_CLOSE matches ###END_CMD### / ###END-CMD### / ###END_COMMAND### / ###END_TOOL### and still ###END_LUA###",
    !!close && close.test("###END_CMD###") && close.test("###END-CMD###") && close.test("###END_COMMAND###") && close.test("###END_TOOL###") && close.test("###END_LUA###") && !close.test("###CMD x###"));
  ok("chatgpt: COMMANDISH_TEXT (reply-vs-reasoning split) sees a ###CMD block as command text",
    !!commandish && commandish.test("ok\n###CMD part_create###\nname: X") && !commandish.test("### Tool list"));
}
{
  const kimi = read("src/providers/kimi.js");
  const starts = regexConst(kimi, "STARTS_CMD");
  ok("kimi: STARTS_CMD (nested paragraph pass) starts on ###CMD name### like on ###LUA###",
    !!starts && starts.test("###CMD part_create###\nname: X") && starts.test("```json\n{\"command\": \"x\"}") && starts.test("###LUA###") && !starts.test("Here:\n###CMD x###") && !starts.test("### Tool list"));
}
{
  const cc = read("src/providers/codecraft.js");
  const mb = regexConst(cc, "MARKER_BLOCK_RE");
  ok("codecraft: MARKER_BLOCK_RE is a global regex (used with String.replace)", !!mb && mb.global);
  if (mb) {
    const src = "Sure.\n###CMD part_create###\nname: X\n###END_CMD###\nDone.";
    const m = src.match(mb);
    ok("codecraft: a bare ###CMD … ###END_CMD### envelope is captured as ONE block (so its renderer fences it like ###LUA###)", !!m && m.length === 1 && m[0].startsWith("###CMD part_create###") && m[0].endsWith("###END_CMD###"), m);
    const lua = "###LUA###\nprint(1)\n###END_LUA###";
    ok("codecraft: ###LUA### blocks still captured", (lua.match(mb) || []).length === 1);
    ok("codecraft: a markdown heading is not captured", !("### Tool list\n- a".match(mb)));
  }
}
{
  const ds = read("src/providers/deepseek.js");
  ok("deepseek: unfenced start/end detection uses the parser's CMD_START_RE / CMD_END_RE (no second regex to drift)",
    /const hasStart = \(t\) => P\.LUA_START_RE\.test\(t\) \|\| P\.CMD_START_RE\.test\(t\)/.test(ds) && /const hasEnd = \(t\) => P\.LUA_END_RE\.test\(t\) \|\| P\.CMD_END_RE\.test\(t\)/.test(ds));
  // deepseek lower-cases the text before testing - the parser's regexes are /i.
  ok("deepseek: those parser regexes are case-insensitive and non-global (deepseek tests lower-cased text)", RSParse.CMD_START_RE.ignoreCase && RSParse.CMD_END_RE.ignoreCase && !RSParse.CMD_START_RE.global && !RSParse.CMD_END_RE.global && RSParse.CMD_START_RE.test("###cmd part_create###") && RSParse.CMD_END_RE.test("###end_cmd###"));
}

// ── Part 3: the real findToolBlockSpot on the <pre>-scanning adapters ────
let JSDOM = null, installDomShims = null;
try { ({ JSDOM } = require("jsdom")); ({ installDomShims } = require("./lib/e2e-page.js")); } catch {}
if (!JSDOM) {
  console.log("(jsdom missing - Part 3 skipped: npm i --no-save jsdom)");
} else {
  const PAGES = {
    codecraft: { host: "codecraftapi.com", path: "/" },
    multichat: { host: "huggingface.co", path: "/chat/" },
    vani: { host: "c.vani.ai", path: "/chat" },
    // arena / gemini / qwen / kimi / chatgpt / claude / glm scan their site-specific
    // reply containers (slide / .markdown / body) - covered by their e2e suites.
  };
  for (const id of Object.keys(PAGES)) {
    const { host, path: p } = PAGES[id];
    let P = null, d = null;
    try {
      const dom = new JSDOM(`<!doctype html><html><body><main></main></body></html>`, { url: `https://${host}${p}`, pretendToBeVisual: true, runScripts: "outside-only" });
      const w = dom.window; installDomShims(w); w.__rsDiag = [];
      w.eval(read("src/providers/stream-reader.js"));
      w.eval(read(`src/providers/${id}.js`));
      P = w.RSProvider; d = w.document;
      try { P.init({ diag: (event, data) => w.__rsDiag.push({ event, data: data || null }) }); } catch {}
    } catch (e) { ok(`${id}: adapter loads in jsdom`, false, String(e && e.message)); continue; }
    const probe = (text) => {
      const item = d.createElement("div"); item.className = "message";
      const pre = d.createElement("pre"); pre.textContent = text; item.appendChild(pre); d.body.appendChild(item);
      let spot = null; try { spot = P.findToolBlockSpot(item); } catch (e) { spot = "throw " + e.message; }
      const hidden = pre.classList.contains("rs-tool-hide");
      item.remove();
      return { spot, hidden };
    };
    const cmd = probe(OPENERS[0]), lua = probe(STILL_MASKED[0]), prose = probe("local p = Instance.new('Part')");
    ok(`${id}: findToolBlockSpot masks a <pre>###CMD part_create###…</pre> (chip anchored on it, block hidden)`, !!cmd.spot && typeof cmd.spot === "object" && cmd.hidden, cmd);
    ok(`${id}: … still masks ###LUA### and leaves a plain Lua <pre> visible`, !!lua.spot && typeof lua.spot === "object" && lua.hidden && prose.spot === null && !prose.hidden, { lua, prose });
  }
}

console.log(`\ntest-cmd-shape: ${pass} passed, ${fail} failed (static + jsdom; no live site)`);
process.exit(fail ? 1 : 0);
