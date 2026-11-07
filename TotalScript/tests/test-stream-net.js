// 1.65.0 — universal chat-stream tap (src/providers/stream-net.js, MAIN world) +
// isolated reader (src/providers/stream-reader.js) + their use by the adaptive
// adapters (Vani Chat, MultiChat; ClickUp Brain and Ox Alpha until 1.89.0): the model's reply is
// read verbatim off the network in every common stream dialect, the turn ends
// the instant the stream closes, HTTP failures surface at once, and the DOM
// stays the fallback. Run with NODE_PATH pointing at a jsdom install.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra) : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { JSDOM, VirtualConsole } = require("jsdom");
const vc = new VirtualConsole(); vc.on("error", () => {}); vc.on("jsdomError", () => {});
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true, url: "https://c.vani.ai/c" });
const w = dom.window;
// Web streams + Response for the fetch mock (Node globals are fine inside jsdom's window).
w.ReadableStream = ReadableStream; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder; w.Response = Response; w.Headers = Headers; w.Request = Request; w.FormData = FormData; w.Blob = Blob;
const calls = [];
// ── a scripted server: each fetch returns the body lines of the matching script, streamed ──
function sseResponse(lines, opts) {
  opts = opts || {};
  const enc = new TextEncoder();
  const body = new ReadableStream({ async start(c) { for (const l of lines) { c.enqueue(enc.encode(l + "\n")); await sleep(opts.gap || 2); } c.close(); } });
  return new Response(body, { status: opts.status || 200, headers: { "content-type": opts.ct || "text/event-stream" } });
}
let script = null;
w.fetch = (input, init) => { calls.push({ url: String(input && input.url || input), init }); return Promise.resolve(script ? script(input, init) : new Response("{}", { headers: { "content-type": "application/json" } })); };

// A minimal XHR that the tap can wrap (jsdom's cannot be fed fake responses).
class FakeXHR {
  constructor() { this._l = {}; this.readyState = 0; this.status = 0; this.responseText = ""; this.responseType = ""; this._h = {}; }
  addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  _emit(t) { for (const f of this._l[t] || []) f({ type: t }); }
  open(m, u) { this.method = m; this.url = u; this.readyState = 1; }
  setRequestHeader() {}
  getResponseHeader(k) { return this._h[k.toLowerCase()] || null; }
  send(body) { this.body = body; FakeXHR.last = this; }
  // test helpers
  _headers(h) { this._h = h; }
  _chunk(txt) { this.readyState = 3; this.responseText += txt; this._emit("readystatechange"); this._emit("progress"); }
  _done(status) { this.status = status || 200; this.readyState = 4; this._emit("readystatechange"); this._emit("load"); }
}
w.XMLHttpRequest = FakeXHR;
class FakeWS { constructor(url) { this.url = url; this._l = {}; FakeWS.last = this; } addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); } send(d) { this.sent = d; } _msg(data) { for (const f of this._l.message || []) f({ data }); } }
w.WebSocket = FakeWS;

w.eval(read("src/providers/stream-net.js"));
w.eval(read("src/providers/stream-reader.js"));
const R = w.RSStreamNet;
const state = () => w.__rsStreamNetState();
const nodeJSON = () => { const el = w.document.getElementById("rs-stream-net"); return el ? JSON.parse(el.textContent) : null; };
const fold = (lines, kind) => w.__rsStreamNetFold(lines, kind);

// ── 1. dialect decoding ──
ok("tap installed once (guard) and wraps fetch / XHR / EventSource / WebSocket", w.__rsStreamNet === true && w.fetch.toString().includes("origFetch") && w.XMLHttpRequest.prototype.send.toString().includes("classify") && w.WebSocket.prototype.send.toString().includes("bodyHasFrag"));
let r = fold(['data: {"choices":[{"delta":{"role":"assistant"}}]}', 'data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}', "data: [DONE]"]);
ok("OpenAI chat.completions SSE: deltas concatenate, finish_reason / [DONE] end the turn", r.text === "Hello" && r.done === true, r);
r = fold(['data: {"type":"message_start","message":{"id":"m1","content":[]}}', 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}', 'data: {"type":"content_block_stop","index":0}', 'data: {"type":"message_stop"}']);
ok("Anthropic Messages SSE: content_block_delta text, message_stop ends", r.text === "Hi there" && r.done === true, r);
r = fold(['data: {"type":"response.created","response":{"id":"r1"}}', 'data: {"type":"response.output_text.delta","delta":"A"}', 'data: {"type":"response.output_text.delta","delta":"B"}', 'data: {"type":"response.completed","response":{"id":"r1"}}']);
ok("OpenAI Responses API SSE", r.text === "AB" && r.done === true, r);
r = fold(['data: {"type":"start","messageId":"x"}', 'data: {"type":"text-start","id":"t1"}', 'data: {"type":"text-delta","id":"t1","delta":"Vercel "}', 'data: {"type":"reasoning-delta","id":"r1","delta":"secret thoughts"}', 'data: {"type":"text-delta","id":"t1","delta":"v5"}', 'data: {"type":"text-end","id":"t1"}', 'data: {"type":"finish","finishReason":"stop"}', "data: [DONE]"]);
ok("Vercel AI SDK UI-message stream (v5): text-delta only, reasoning ignored, finish ends", r.text === "Vercel v5" && r.done === true, r);
r = fold(['f:{"messageId":"m"}', '0:"Vercel "', 'g:"thinking…"', '0:"v4"', 'e:{"finishReason":"stop"}', 'd:{"finishReason":"stop"}']);
ok("Vercel AI SDK data-stream protocol (v4): 0: text parts, g: reasoning ignored, d:/e: end", r.text === "Vercel v4" && r.done === true, r);
r = fold(['{"answer":"The"}', '{"answer":"The quick brown fox jumps over the lazy dog, said"}', '{"answer":"The quick brown fox jumps over the lazy dog, said the model.","done":true}'], "ndjson");
ok("NDJSON with a cumulative `answer` field replaces instead of appending", r.text === "The quick brown fox jumps over the lazy dog, said the model." && r.done === true, r);
r = fold(['data: {"delta":"tok1 "}', 'data: {"delta":"tok2"}', 'event: done', 'data: {}']);
ok("generic {delta} tokens + `event: done`", r.text === "tok1 tok2" && r.done === true, r);
r = fold(['data: {"message":{"role":"assistant","content":"partial"}}', 'data: {"message":{"role":"assistant","content":"partial answer in full"}, "done": true}']);
ok("nested {message:{content}} frames are cumulative", r.text === "partial answer in full" && r.done === true, r);
r = fold(['data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}']);
ok("error frames are captured", /Rate limit exceeded/.test(r.err), r);
r = fold(['data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}', 'data: {"choices":[{"delta":{"content":"visible"}}]}']);
ok("reasoning_content never leaks into the reply", r.text === "visible", r);
r = fold(["Plain line one", "line two"], "text");
ok("raw text bodies are kept line by line", r.text === "Plain line one\nline two\n", r);
r = fold(['data: {"text":"```json\\n{\\"command\\":\\"get_studio_state\\",\\"params\\":{}}\\n```"}']);
ok("fenced command blocks come through verbatim (the parser's canonical input)", r.text.includes('{"command":"get_studio_state","params":{}}') && r.text.startsWith("```json"), r);

// ── 2. request matching + fetch streaming end-to-end ──
const pending = [];
const await_ = (fn) => pending.push(fn());
const prompt = "SYSTEM PROMPT ... [SYSTEM_STATE: ok]\nResult of get_studio_state: Workspace has 42 parts and 3 scripts in ServerScriptService today";
const frag = R.fragmentOf(prompt);
ok("fragmentOf picks a long plain run from the TAIL of the message (the part that differs per turn)", frag.length >= 20 && prompt.slice(-200).includes(frag) && !/[\n"\\]/.test(frag), frag);
R.markSent(prompt);
const sentAttr = JSON.parse(w.document.documentElement.getAttribute("data-rs-sent"));
ok("markSent publishes {frag, at} on <html data-rs-sent>", sentAttr.frag === frag && Date.now() - sentAttr.at < 2000);
ok("before any response the reader has nothing (null / '' / no error)", R.current() === null && R.replyText() === "" && R.genState({}) === null && R.error() === null);
// unrelated traffic in the window
script = () => new Response("{\"ok\":true}", { headers: { "content-type": "application/json" } });
await_(async () => {
  await w.fetch("https://c.vani.ai/_next/static/chunks/app.js", { method: "GET" });
  await w.fetch("https://c.vani.ai/api/analytics", { method: "POST", body: JSON.stringify({ ev: "view" }) });
  await sleep(20);
  ok("static / analytics requests are never adopted", state().rid === 0 && R.current() === null);
  // the real chat request: body carries our prompt
  script = () => sseResponse(['data: {"type":"text-delta","delta":"Sure. "}', 'data: {"type":"text-delta","delta":"```json\\n{\\"command\\":\\"get_studio_state\\",\\"params\\":{}}\\n```"}', "data: [DONE]"], { gap: 70 });
  const p = w.fetch("https://c.vani.ai/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: prompt }], model: "gpt" }) });
  await sleep(55);
  const mid = nodeJSON();
  ok("while streaming: node shows matched=true, done=false, partial text; reader says 'streaming'", mid && mid.matched === true && mid.done === false && mid.text.startsWith("Sure.") && R.genState({}) === "streaming", mid);
  await p; await sleep(320);
  const fin = nodeJSON();
  ok("after the stream closes: done=true, full verbatim text, reader says 'done' and hands over the reply", fin.done === true && fin.text.includes('{"command":"get_studio_state","params":{}}') && R.genState({}) === "done" && R.replyText() === fin.text, fin);
  const rid1 = fin.rid;
  // next turn: markSent consumes the finished response
  R.markSent("Output of 'get_studio_state':\n{...}\nNow continue with the next step of the plan please and thank you kindly");
  ok("markSent consumes the finished turn: current()/replyText()/genState() are empty until a NEW response arrives", R.current() === null && R.replyText() === "" && R.genState({}) === null && R._consumed() === rid1);
  // "maybe" path: body does not carry the fragment (e.g. the site sends only a conversation id) but it is a chatty streaming POST inside the window
  script = () => sseResponse(['data: {"choices":[{"delta":{"content":"maybe-matched reply"}}]}', "data: [DONE]"]);
  await w.fetch("https://c.vani.ai/api/conversation/abc/messages", { method: "POST", body: JSON.stringify({ conversationId: "abc" }) }); await sleep(40);
  const mb = nodeJSON();
  ok("a chat-looking streaming POST inside the send window is adopted as 'maybe' (matched=false) and still read", mb.rid > rid1 && mb.matched === false && mb.text === "maybe-matched reply" && mb.done === true && R.replyText() === "maybe-matched reply", mb);
  // HTTP failure surfaces instantly
  R.markSent("third turn text that is long enough to carry a fragment for matching purposes here");
  script = () => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "content-type": "application/json" } });
  await w.fetch("https://c.vani.ai/api/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "third turn text that is long enough to carry a fragment for matching purposes here" }] }) }); await sleep(30);
  const e = R.error();
  ok("HTTP 429 on the matched request → error() {status:429} and describe() words it as rate limiting", e && e.status === 429 && /rate limiting/.test(R.describe(e, "Vani Chat")) && R.genState({}) === "done", e);
  ok("describe() maps 401/402/413/5xx to login / allowance / too-long / server wording; 413 trips the core's too-long detector", /log in/.test(R.describe({ status: 401, text: "" }, "X")) && /allowance/.test(R.describe({ status: 402, text: "" }, "X")) && /message is too long/.test(R.describe({ status: 413, text: "" }, "X")) && /server error/.test(R.describe({ status: 503, text: "" }, "X")));
  // a 404 on an UNMATCHED request is not an error for the turn
  R.markSent("fourth turn text that is long enough to carry a fragment for matching purposes");
  script = () => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
  await w.fetch("https://c.vani.ai/api/chat/title", { method: "POST", body: JSON.stringify({ id: 1 }) }); await sleep(30);
  ok("a 404 on a request we did not positively match is ignored (no false provider_error)", R.error() === null);
  // Request-object fetch (body inside the Request)
  R.markSent("fifth turn carrying the prompt fragment inside a Request object body for the clone path");
  script = () => sseResponse(['data: {"choices":[{"delta":{"content":"from Request"}}]}', "data: [DONE]"]);
  const req = new Request("https://c.vani.ai/api/chat", { method: "POST", body: JSON.stringify({ q: "fifth turn carrying the prompt fragment inside a Request object body for the clone path" }) });
  await w.fetch(req); await sleep(60);
  ok("fetch(Request) bodies are peeked via clone and matched", nodeJSON().matched === true && R.replyText() === "from Request", nodeJSON());
  // whole JSON reply (non-streamed)
  R.markSent("sixth turn asks for a plain JSON answer without any streaming on this request");
  script = () => new Response(JSON.stringify({ id: 9, response: "whole JSON answer", model: "x" }), { headers: { "content-type": "application/json" } });
  await w.fetch("https://app.clickup.com/ai/v1/chat", { method: "POST", body: JSON.stringify({ prompt: "sixth turn asks for a plain JSON answer without any streaming on this request" }) }); await sleep(30);
  ok("non-streamed JSON replies ({response}) are read whole and marked done", R.replyText() === "whole JSON answer" && R.genState({}) === "done");
  // XHR (Angular HttpClient) streaming SSE
  R.markSent("seventh turn goes out over XMLHttpRequest like an Angular HttpClient call would");
  const x = new w.XMLHttpRequest(); x.open("POST", "https://app.clickup.com/ai/v1/brain/answer"); x.send(JSON.stringify({ message: "seventh turn goes out over XMLHttpRequest like an Angular HttpClient call would" }));
  x._headers({ "content-type": "text/event-stream" }); x._chunk('data: {"text":"XHR "}\n'); await sleep(55);
  ok("XHR progress chunks stream into the node", nodeJSON().text === "XHR " && R.genState({}) === "streaming", nodeJSON());
  x._chunk('data: {"text":"reply"}\ndata: [DONE]\n'); x._done(200); await sleep(5);
  ok("XHR load ends the turn with the full text", R.replyText() === "XHR reply" && R.genState({}) === "done");
  // XHR HTTP 402 → allowance
  R.markSent("eighth turn over XHR gets an allowance refusal from the server side today");
  const x2 = new w.XMLHttpRequest(); x2.open("POST", "https://app.clickup.com/ai/v1/brain/answer"); x2.send(JSON.stringify({ message: "eighth turn over XHR gets an allowance refusal from the server side today" }));
  x2._headers({ "content-type": "application/json" }); x2.responseText = '{"err":"no credits"}'; x2._done(402); await sleep(5);
  ok("XHR 402 → allowance error", R.error() && R.error().status === 402 && /allowance/.test(R.describe(R.error(), "ClickUp Brain")));
  // WebSocket turn (socket.io framing)
  R.markSent("ninth turn is pushed over the application websocket in socket io frames");
  const ws = new w.WebSocket("wss://app.clickup.com/ws"); ws.send('42["ask",{"text":"ninth turn is pushed over the application websocket in socket io frames"}]');
  ws._msg('42["token",{"delta":"ws "}]'); ws._msg('42["token",{"delta":"reply"}]'); await sleep(55);
  ok("WebSocket: sending our prompt marks the socket; token frames stream in", R.replyText() === "ws reply" && R.genState({}) === "streaming", nodeJSON());
  ws._msg('42["done",{}]'); await sleep(5);
  ok("a done frame ends the websocket turn", R.genState({}) === "done");
  // stall rule: a stream that never closes is declared done after stallMs without a stop button
  R.markSent("tenth turn stream loses its close frame and must not pin the watcher for ever");
  script = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"delta":"stalled text"}\n')); /* never closes */ } }), { headers: { "content-type": "text/event-stream" } });
  w.fetch("https://c.vani.ai/api/chat", { method: "POST", body: JSON.stringify({ messages: [{ content: "tenth turn stream loses its close frame and must not pin the watcher for ever" }] }) }); await sleep(60);
  ok("an open stream is 'streaming' first…", R.genState({ stallMs: 150 }) === "streaming" && R.replyText() === "stalled text");
  await sleep(200);
  ok("…and 'done' once its text has been frozen past stallMs with no stop button (stop button visible keeps it streaming)", R.genState({ stallMs: 150 }) === "done" && R.genState({ stallMs: 150, stopVisible: true }) === "streaming");
});

Promise.all(pending).then(async () => {
  // ── 3. the adapters consume the tap ──
  const dom2 = new JSDOM(`<!doctype html><html><body><main><div class="messages"><div class="message" data-message-role="user">hello from the user side</div><div class="message" data-message-role="assistant"><div class="prose"><p>DOM copy of the reply</p></div></div></div></main><form><textarea placeholder="Message"></textarea><button type="submit" aria-label="Send">Send</button></form></body></html>`, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://c.vani.ai/c", virtualConsole: vc });
  const w2 = dom2.window;
  w2.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 800, height: 40, right: 800, bottom: 40 }; };
  Object.defineProperty(w2.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  w2.fetch = () => Promise.resolve(new Response("{}"));
  w2.HTMLFormElement.prototype.requestSubmit = function () { this.dispatchEvent(new w2.Event("submit", { bubbles: true, cancelable: true })); };
  w2.eval(read("src/providers/stream-reader.js"));
  const fakeNode = (obj) => { let el = w2.document.getElementById("rs-stream-net"); if (!el) { el = w2.document.createElement("script"); el.type = "application/json"; el.id = "rs-stream-net"; w2.document.body.appendChild(el); } el.textContent = JSON.stringify(obj); };
  const diags = [];
  for (const prov of ["vani", "multichat"]) {
    const src = read(`src/providers/${prov}.js`);
    ok(`${prov}.js consumes the tap (netText / netGen / netMarkSent / netError / invalidateItems) and prefers it in readAssistant`, /const NET = \(\) =>/.test(src) && /const nt = netText\(\)\.trim\(\);\s*if \(nt\) return \{ present: true, reply: nt, thinking: "", item, net: true \};/.test(src) && /const g = netGen\(stop\);\s*if \(g === "streaming"\) return true;\s*if \(g === "done" && !stop\) return false;/.test(src) && /netMarkSent\(text\);/.test(src) && /const ne = netError\(\);\s*if \(ne\) return ne;/.test(src) && /allItems, invalidateItems,/.test(src) && /function allItemsUncached\(\)/.test(src));
  }
  w2.eval(read("src/providers/vani.js") + "\n;window.__P = RSProvider;");
  const P = w2.__P; P.init({ diag: (ev, d) => diags.push(ev) });
  const R2 = w2.RSStreamNet;
  P.isGenerating(); await sleep(700); P.invalidateItems(); // DOM path: a row counts as "growing" for GEN_IDLE_MS (600) after it first appears
  ok("vani: with no tap data readAssistant reads the DOM row (fallback intact)", P.readAssistant().reply === "DOM copy of the reply" && P.isGenerating() === false && P.invalidateItems && (P.invalidateItems(), true), [P.readAssistant(), P.isGenerating(), P.allItems().length]);
  // a send marks the tap; then a matched stream arrives
  await P.typeAndSend("please run get_studio_state now and report the result back to me here");
  ok("vani: typeAndSend calls markSent (data-rs-sent carries a fragment of the outgoing text)", /get_studio_state now and report/.test(w2.document.documentElement.getAttribute("data-rs-sent")));
  fakeNode({ rid: 7, text: "```json\n{\"command\":\"get_studio_state\",\"params\":{}}\n```", done: false, t: Date.now(), matched: true, kind: "sse", url: "/api/chat", status: 200, err: "", startedAt: Date.now(), sentAt: Date.now(), chunks: 2 });
  let d = P.readAssistant();
  ok("vani: while the tap streams, readAssistant returns the network text (net:true) and isGenerating/isHardGenerating are true without any stop button", d.net === true && d.reply.includes('"command":"get_studio_state"') && P.isGenerating() === true && P.isHardGenerating() === true && P.streamLen() === d.reply.length, d);
  fakeNode({ rid: 7, text: "```json\n{\"command\":\"get_studio_state\",\"params\":{}}\n```", done: true, t: Date.now(), matched: true, kind: "sse", url: "/api/chat", status: 200, err: "", startedAt: Date.now(), sentAt: Date.now(), chunks: 2 });
  ok("vani: the moment the tap says done, isGenerating is false (no 3 s stability wait) and the reply is still the verbatim text", P.isGenerating() === false && P.readAssistant().reply.includes("get_studio_state") && P.scanError() === null);
  P.invalidateItems();
  fakeNode({ rid: 8, text: "", done: true, t: Date.now(), matched: true, kind: "json", url: "/api/chat", status: 429, err: "HTTP 429: too many requests", startedAt: Date.now(), sentAt: Date.now(), chunks: 0 });
  R2.markSent("x"); fakeNode({ rid: 9, text: "", done: true, t: Date.now(), matched: true, kind: "json", url: "/api/chat", status: 429, err: "HTTP 429: too many requests", startedAt: Date.now(), sentAt: Date.now(), chunks: 0 });
  ok("vani: an HTTP 429 on the turn's request surfaces through scanError() at once", /rate limiting \(HTTP 429/.test(P.scanError() || ""), P.scanError());
  R2.markSent("y");
  ok("vani: after the next send the stale error is consumed and the DOM fallback returns", P.scanError() === null && P.readAssistant().reply === "DOM copy of the reply");

  // ── 4. wiring ──
  const manifest = JSON.parse(read("manifest.json"));
  const tap = manifest.content_scripts.find((c) => c.world === "MAIN" && c.js.includes("src/providers/stream-net.js"));
  ok("manifest: stream-net.js runs in the MAIN world at document_start for the adaptive hosts (Vani, MultiChat sites)", tap && tap.run_at === "document_start" && ["https://c.vani.ai/*", "https://overchat.ai/*", "https://huggingface.co/chat/*", "https://openrouter.ai/*"].every((h) => tap.matches.includes(h)));
  for (const prov of ["vani", "multichat"]) {
    const b = manifest.content_scripts.find((c) => c.world !== "MAIN" && c.js.includes(`src/providers/${prov}.js`));
    ok(`manifest: the ${prov} bundle loads stream-reader.js right before the adapter and every one of its hosts has the tap`, b && b.js.indexOf("src/providers/stream-reader.js") === b.js.indexOf(`src/providers/${prov}.js`) - 1 && b.matches.every((m) => tap.matches.includes(m)));
  }
  const noTap = manifest.content_scripts.filter((c) => c.world !== "MAIN" && c.js.includes("src/core/main.js") && !c.js.includes("src/providers/stream-reader.js"));
  ok("providers with their own taps / stable DOMs (ChatGPT, Claude, Gemini, Qwen, …) are untouched by the generic tap", noTap.length >= 10 && noTap.every((b) => !b.matches.some((m) => tap.matches.includes(m))));
  const mainSrc = read("src/core/main.js");
  ok("core watcher polls tighter on every provider (120 ms while streaming, 140 ms pre-start, 220 ms settle)", /await sleep\(120\); \/\/ 1\.65: tighter poll/.test(mainSrc) && /await sleep\(140\); \/\/ 1\.65: catch the first token sooner/.test(mainSrc) && /Date\.now\(\) - doneSince < 220\)/.test(mainSrc));
  const readme = read("README.md");
  ok("README documents 1.65.0 (stream tap, ClickUp + Vani, faster watcher) and the test", /\*\*1\.65\.0 — /.test(readme) && /stream-net\.js/.test(readme) && /test-stream-net\.js/.test(readme));
  console.log(`test-stream-net: ${n} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.log("FAIL harness error", e && e.stack || e); process.exit(1); });
