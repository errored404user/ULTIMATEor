// 1.80.0 — Xiaomi MiMo Studio provider (src/providers/mimo.js) for
// aistudio.xiaomimimo.com: the universal stream tap decodes MiMo's SSE dialect
// (event:message {"type":"text","content"} / event:finish {"content":"[DONE]"} /
// event:error / event:usage), the adapter strips the inline <think> reasoning
// and U+0000 noise, finds the textarea + paper-plane send button in
// .dialogue-container, keys conversations off the /#/chat/<id> hash, and the
// extension plumbing (manifest bundle + MAIN tap, host permission, background
// broadcast, popup name, switcher entry, overlay skin, README) is complete.
// Run with NODE_PATH pointing at a jsdom install.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { JSDOM, VirtualConsole } = require("jsdom");

const HOST = "aistudio.xiaomimimo.com";
const manifest = JSON.parse(read("manifest.json"));
const SEND_D = "M.244 7.921 18.202.03c.254-.111.528.115.452.373L14.51 14.345a.33.33 0 0 1-.448.201l-4.337-1.852a.333.333 0 0 0-.44.178l-1.14 2.923c-.117.298-.565.262-.63-.049l-.851-4.089a.31.31 0 0 1 .09-.285l6.707-6.448c.061-.059-.025-.15-.092-.098L5.396 10.25a.99.99 0 0 1-.92.099L.244 8.65a.395.395 0 0 1 0-.73";

// ── 1. the MAIN-world tap decodes MiMo's SSE dialect ──
{
  const vc = new VirtualConsole(); vc.on("error", () => {}); vc.on("jsdomError", () => {});
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true, url: `https://${HOST}/#/c`, virtualConsole: vc });
  const w = dom.window;
  w.ReadableStream = ReadableStream; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder; w.Response = Response; w.Headers = Headers; w.Request = Request;
  w.eval(read("src/providers/stream-net.js"));
  const fold = (lines, kind) => w.__rsStreamNetFold(lines, kind);
  let r = fold([
    "id: 1", "event: message", 'data: {"type":"text","content":"<think>Let me plan the GUI.\\u0000"}', "",
    "id: 2", "event: message", 'data: {"type":"text","content":"</think>Here is the"}', "",
    "id: 3", "event: message", 'data: {"type":"text","content":" plan."}', "",
    "event: usage", 'data: {"promptTokens":120,"completionTokens":9,"totalTokens":129}', "",
    "event: finish", 'data: {"content":"[DONE]"}', "",
  ]);
  ok("tap: event:message {type:text,content} deltas concatenate; event:finish {content:[DONE]} ends the turn without leaking \"[DONE]\"",
    r.text === "<think>Let me plan the GUI.\u0000</think>Here is the plan." && r.done === true && !r.err, r);
  r = fold(["event: message", 'data: {"type":"text","content":"partial"}', "", "event: error", 'data: {"type":"error","content":"请求过于频繁，请稍后再试"}', ""]);
  ok("tap: event:error surfaces the upstream message", /请求过于频繁/.test(r.err || "") && r.text === "partial", r);
  r = fold(['data: {"content":"[DONE]"}']);
  ok("tap: a bare JSON-wrapped [DONE] is a sentinel, not text (generic rule)", r.text === "" && r.done === true, r);
  r = fold(['data: {"choices":[{"delta":{"content":"still works"}}]}', "data: [DONE]"]);
  ok("tap: OpenAI dialect unaffected by the sentinel rule", r.text === "still works" && r.done === true, r);
}

// ── 2. the adapter: reasoning split, DOM, send, hash key ──
(async () => {
  const vc = new VirtualConsole(); vc.on("error", () => {}); vc.on("jsdomError", () => {});
  const html = `<!doctype html><html><head><style>button,textarea,div{display:block}</style></head><body>
    <header><a href="/login">登录</a></header>
    <div class="dialogue-container">
      <div class="message-list">
        <div class="message-item user-message"><div class="content">make a shop gui</div></div>
        <div class="message-item assistant-message"><div class="think-block">secret plan</div><div class="markdown-body"><p>Sure.</p><pre>{"command":"ui_build_spec","args":{}}</pre></div></div>
      </div>
      <div class="input-area"><textarea placeholder="给 MiMo 发消息"></textarea>
        <button class="tool-btn"><svg><path d="M3 3h18v18H3z"/></svg></button>
        <button class="send-btn"><svg viewBox="0 0 19 18"><path d="${SEND_D}"/></svg></button>
      </div>
    </div></body></html>`;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: `https://${HOST}/#/chat/9f3c2a1b7e` , virtualConsole: vc });
  const w = dom.window;
  // jsdom has no layout: give elements a box so visible() accepts them.
  w.Element.prototype.getBoundingClientRect = function () { return { width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40 }; };
  w.eval(read("src/providers/stream-reader.js"));
  w.eval(read("src/providers/mimo.js"));
  const P = w.RSProvider;
  ok("adapter exports id/displayName and the shared contract", P && P.id === "mimo" && /MiMo/.test(P.displayName) && ["getEditor", "typeAndSend", "readAssistant", "installSendHooks", "scanError", "ensureComposerReady", "barAnchor", "allItems", "conversationKey", "attachImages", "stopGeneration"].every((k) => typeof P[k] === "function") && P.timings && P.supportsVision === true);

  const sp = P._splitThink;
  ok("splitThink: closed <think> goes to thinking, answer keeps its text, U+0000 removed",
    JSON.stringify(sp("<think>plan\u0000 it</think>\n\nHello **there**")) === JSON.stringify({ reply: "Hello **there**", thinking: "plan it" }), sp("<think>plan\u0000 it</think>\n\nHello **there**"));
  ok("splitThink: an UNCLOSED <think> means still reasoning (empty reply, thinking so far)",
    sp("<think>still going").reply === "" && sp("<think>still going").thinking === "still going");
  ok("splitThink: a command block inside <think> never reaches the reply",
    !/ui_build_spec/.test(sp('<think>```json\n{"command":"ui_build_spec"}\n```</think>ok').reply) && sp('<think>x</think>ok').reply === "ok");
  ok("splitThink: plain text passes through unchanged", sp("just text\nline 2").reply === "just text\nline 2");

  const ed = P.getEditor();
  ok("editor: the .dialogue-container textarea", !!ed && ed.tagName === "TEXTAREA");
  ok("conversationKey: /#/chat/<id> hash", P.conversationKey() === "9f3c2a1b7e", P.conversationKey());
  ok("login gate NOT reported while a usable composer exists (corner 登录 link ignored)", P.loginGatePresent() === false && P.modeWarning() === "");
  const items = P.allItems();
  ok("transcript rows found by class shape; roles from class names", items.length === 2 && P.isUserItem(items[0]) && P.isAssistantItem(items[1]), items.length);
  ok("assistant text read from the markdown body without the reasoning drawer", P.itemText(items[1]).includes("Sure.") && !/secret plan/.test(P.itemText(items[1])), P.itemText(items[1]));
  const spot = P.findToolBlockSpot(items[1]);
  ok("tool block <pre> is masked and anchors the chip", !!spot && spot.ref.tagName === "PRE" && spot.ref.classList.contains("rs-tool-hide"));
  ok("barAnchor resolves to the input area", !!P.barAnchor() && P.barAnchor().className.includes("input-area"));

  // send: the paper-plane button (no aria-label) is the one clicked; a tool
  // button with a different glyph is not.
  let clicked = [];
  for (const b of w.document.querySelectorAll("button")) b.addEventListener("click", () => { clicked.push(b.className); if (b.className === "send-btn") ed.value = ""; });
  await P.typeAndSend("hello MiMo, build a shop gui with three tabs");
  ok("typeAndSend: fills the textarea via the native setter and clicks the paper-plane button only", clicked.length >= 1 && clicked.every((c) => c === "send-btn"), clicked);
  ok("typeAndSend: markSent published the outgoing fragment for the tap", /shop gui/.test(w.document.documentElement.getAttribute("data-rs-sent") || ""));

  // reply via the tap: publish what stream-net would, with the think prefix.
  const node = w.document.createElement("div"); node.id = "rs-stream-net"; node.style.display = "none"; w.document.documentElement.appendChild(node);
  const pub = (o) => { node.textContent = JSON.stringify(Object.assign({ rid: 7, t: Date.now(), matched: true, kind: "sse", url: "/open-apis/bot/chat", status: 200, err: "", startedAt: Date.now(), sentAt: Date.now(), chunks: 1 }, o)); };
  pub({ text: "<think>thinking about tabs", done: false });
  let ra = P.readAssistant();
  ok("readAssistant while reasoning: present, empty reply, thinking exposed, generating", ra.present && ra.reply === "" && /thinking about tabs/.test(ra.thinking) && P.isGenerating() === true, ra);
  pub({ text: "<think>thinking about tabs</think>Done:\n```json\n{\"command\":\"ui_build_spec\"}\n```", done: true });
  ra = P.readAssistant();
  ok("readAssistant after finish: reply without the reasoning, from the network", ra.net === true && ra.reply.startsWith("Done:") && /ui_build_spec/.test(ra.reply) && !/thinking about/.test(ra.reply), ra);
  ok("stream closed → not generating (no stop button on the page)", P.isGenerating() === false);
  ok("streamLen follows the network text", P.streamLen() === ra.reply.length);

  // errors
  pub({ text: "", done: true, err: "HTTP 429: 请求过于频繁", status: 429, rid: 8 });
  P.typeAndSend && (void 0);
  w.RSStreamNet.markSent("x"); pub({ text: "", done: true, err: "HTTP 429: 请求过于频繁", status: 429, rid: 9, startedAt: Date.now() + 10 });
  const se = P.scanError();
  ok("scanError: a 429 from the tap is described as rate limiting", /rate limiting|429/.test(se || ""), se);
  ok("isBusyMsg knows the Chinese and English wordings", P.isBusyMsg("请求过于频繁，请稍后再试") && P.isBusyMsg("Too many requests") && !P.isBusyMsg("Here is your GUI"));
  ok("isTooLongMsg knows the context wordings", P.isTooLongMsg("对话过长") && P.isTooLongMsg("message is too long") && !P.isTooLongMsg("ok"));

  // send hooks: Enter in the textarea and a click on the paper-plane reach the handlers
  const calls = [];
  P.installSendHooks({ isBlocked: () => false, isStarted: () => true, onBlockedAttempt: () => calls.push("blocked"), onUserMessage: (c) => calls.push("msg:" + c), onNativeStop: () => calls.push("stop") });
  ed.value = "typed by the user";
  ed.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  w.document.querySelector(".send-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  w.document.querySelector(".tool-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok("send hooks: Enter + paper-plane click → onUserMessage; the tool button is ignored", calls.length === 2 && calls.every((c) => c === "msg:1"), calls);

  // no composer: a visible 登录 link means "log in" (no nag about the chat page);
  // without that link the adapter says where the chat is.
  w.document.querySelector("textarea").remove();
  ok("no composer + visible 登录 link → login gate, no mode warning", P.loginGatePresent() === true && P.modeWarning() === "");
  w.document.querySelector("header").remove();
  ok("no composer, no login link → the warning points at the chat URL", P.loginGatePresent() === false && /aistudio\.xiaomimimo\.com\/#\/c/.test(P.modeWarning()), P.modeWarning());

  // ── 3. wiring ──
  const bundle = manifest.content_scripts.find((c) => c.world !== "MAIN" && c.matches.includes(`https://${HOST}/*`));
  ok("manifest: isolated bundle for the host loads stream-reader.js then mimo.js then the core", !!bundle && bundle.js.indexOf("src/providers/stream-reader.js") < bundle.js.indexOf("src/providers/mimo.js") && bundle.js.indexOf("src/providers/mimo.js") < bundle.js.indexOf("src/core/main.js") && bundle.js[0] === "src/core/config.js");
  const tap = manifest.content_scripts.find((c) => c.world === "MAIN" && c.js.includes("src/providers/stream-net.js"));
  ok("manifest: the MAIN-world stream tap also runs on the host", !!tap && tap.matches.includes(`https://${HOST}/*`));
  ok("manifest: host permission", manifest.host_permissions.includes(`https://${HOST}/*`));
  ok("background.js broadcasts status to the host", read("background.js").includes(`https://${HOST}/*`));
  const popup = read("popup.js");
  ok("popup.js knows the host and names it", popup.includes(`"${HOST}"`) && /"aistudio\.xiaomimimo\.com": "Xiaomi MiMo Studio"/.test(popup));
  ok("AI switcher lists Xiaomi MiMo Studio at the hash-routed chat URL", /\{ name: "Xiaomi MiMo Studio", url: "https:\/\/aistudio\.xiaomimimo\.com\/#\/c" \}/.test(read("src/core/main.js")));
  const css = read("overlay.css");
  ok("overlay.css: .rs-prov-mimo skin (Xiaomi orange) + flat anchored/inline variants", /#rs-bar\.rs-prov-mimo \{[^}]*--accent: #ff6900/.test(css) && css.includes("#rs-bar.rs-bar-inline.rs-prov-mimo,") && css.includes("#rs-bar.rs-bar-anchored.rs-prov-mimo {") && css.includes("html.rs-light #rs-bar.rs-bar-anchored.rs-prov-mimo {"));
  const readme = read("README.md");
  ok("README: 1.80.0 entry, supported-site list, test listed", /\*\*1\.80\.0 — Xiaomi MiMo Studio/.test(readme) && /Xiaomi MiMo Studio/.test(readme.split("\n")[4] || "") && readme.includes("tests/test-mimo.js"));
  ok("version pins 1.85.0", manifest.version === "1.85.0" && /^version = "1\.85\.0"/m.test(read("agent/Cargo.toml")) && read("plugin/TotalScript.lua").includes('local VERSION = "1.85.0"'));

  console.log(`\n${n - failed}/${n} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
