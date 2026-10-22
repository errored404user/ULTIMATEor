// 1.66.0 — Vani Chat request shaper (src/providers/vani-net.js, MAIN world):
// while the OR agent is attached every chat request gets the protocol pinned at
// the top of the LAST user message and an over-long history is trimmed (head +
// tail, roles alternating); with the agent off nothing is touched. Plus the
// Vani SSE dialect (content.delta / message.complete) in the stream tap, the
// reader's long warm-up + body-level error wording, and the adapter's timings.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 600) : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { JSDOM, VirtualConsole } = require("jsdom");
const vc = new VirtualConsole(); vc.on("error", () => {}); vc.on("jsdomError", () => {});
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true, url: "https://c.vani.ai/c", virtualConsole: vc });
const w = dom.window;
w.Request = Request; w.Response = Response; w.Headers = Headers; w.ReadableStream = ReadableStream; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
const seen = [];
w.fetch = (input, init) => { const url = typeof input === "string" ? input : input.url; const body = init && init.body != null ? init.body : (input && typeof input.text === "function" ? input : null); seen.push({ url, body, method: (init && init.method) || (input && input.method) }); return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } })); };
w.console.log = () => {};
w.eval(read("src/providers/stream-net.js"));
w.eval(read("src/providers/vani-net.js"));
w.eval(read("src/providers/stream-reader.js"));
const patch = (body) => w.__rsVaniPatchBody(body);
const PIN = "[ORscript bridge]";
const agent = (v) => w.document.documentElement.setAttribute("data-rs-agent", v);
const big = (ch, len) => ch.repeat(len);

(async () => {
  // ── 1. patchBody ──
  const guest = JSON.stringify({ model: "openai/gpt-6.1-sol", messages: [{ role: "user", content: "SYSTEM bootstrap " + big("a", 200) }, { role: "assistant", content: "ok" }, { role: "user", content: "Result of get_studio_state: 42 parts. Continue with step two please" }] });
  agent("off");
  ok("agent off: chat requests pass through untouched", patch(guest) === null && w.__rsVaniPatchMessages(JSON.parse(guest).messages).changed === false);
  agent("starting");
  let out = JSON.parse(patch(guest));
  ok("agent starting: the protocol pin lands at the TOP of the LAST user message only", out.messages.length === 3 && out.messages[2].content.startsWith(PIN) && out.messages[2].content.endsWith("Continue with step two please") && !out.messages[0].content.includes(PIN) && out.messages[1].content === "ok", out.messages.map((m) => m.content.slice(0, 40)));
  ok("pin text: one json command block, never say you cannot, no web search / documents / tools, short prose", /ONE command as a fenced ```json block/.test(out.messages[2].content) && /never say you cannot run commands or use JSON blocks/.test(out.messages[2].content) && /Do not search the web/.test(out.messages[2].content) && /Document, Slides, Design, canvas/.test(out.messages[2].content) && /One short line of prose/.test(out.messages[2].content));
  ok("unknown top-level params are preserved byte for byte (Vani rejects unknown params with 400 strict_mode)", out.model === "openai/gpt-6.1-sol" && Object.keys(out).join() === "model,messages");
  agent("on");
  ok("idempotent: a body that already carries the pin is not patched again (retry / regenerate)", patch(JSON.stringify(out)) === null);
  const parts = JSON.stringify({ messages: [{ role: "user", content: [{ type: "image", url: "x" }, { type: "text", text: "hello there with parts" }] }] });
  out = JSON.parse(patch(parts));
  ok("array-of-parts content: the pin goes into the first text part, other parts untouched", out.messages[0].content[0].type === "image" && out.messages[0].content[1].text.startsWith(PIN) && out.messages[0].content[1].text.endsWith("hello there with parts"));
  ok("non-chat bodies / bodies without messages / non-JSON are ignored", patch("{\"title\":\"New chat\"}") === null && patch("not json") === null && patch("[1,2]") === null && patch(JSON.stringify({ messages: "nope" })) === null);
  ok("a body with only assistant messages is left alone", patch(JSON.stringify({ messages: [{ role: "assistant", content: "hi" }] })) === null);
  // history trim
  const hist = [{ role: "user", content: "BOOTSTRAP " + big("s", 14000) }, { role: "assistant", content: "```json\n{\"command\":\"list_commands\",\"params\":{}}\n```" }];
  for (let i = 0; i < 20; i++) { hist.push({ role: "user", content: `Result ${i}: ` + big("r", 3000) }); hist.push({ role: "assistant", content: `step ${i} ` + big("x", 400) }); }
  hist.push({ role: "user", content: "Result 20: final state. Next step please" });
  const r = w.__rsVaniPatchMessages(hist);
  const roles = r.messages.map((m) => m.role);
  ok("long history (43 msgs / ~90k chars): trimmed to head 4 (bootstrap, reply, catalogue result, reply) + a tail of 10-11 (cut moved back to a user message), middle dropped", r.changed && r.trimmed === 28 && r.messages.length === 15 && r.messages[0].content.startsWith("BOOTSTRAP") && r.messages[1].role === "assistant" && r.messages[2].content.startsWith("Result 0:") && r.messages[3].content.startsWith("step 0"), { len: r.messages.length, trimmed: r.trimmed });
  ok("roles still alternate user/assistant after the cut and the tail starts on a user message", roles.every((ro, i) => ro === (i % 2 === 0 ? "user" : "assistant")), roles);
  ok("the first kept tail message explains the omission; the LAST message keeps its tail verbatim (the stream tap matches on it) under the pin", /^\[ORscript: 28 earlier turns omitted/.test(r.messages[4].content) && r.messages[14].content.startsWith(PIN) && r.messages[14].content.endsWith("Result 20: final state. Next step please") && r.trimmed === hist.length - 15);
  const short = JSON.parse(JSON.stringify(hist.slice(0, 8)));
  const rs = w.__rsVaniPatchMessages(short);
  ok("short histories are never trimmed (only pinned)", rs.trimmed === 0 && rs.messages.length === 8 && rs.pinned === true);
  const small = []; for (let i = 0; i < 30; i++) small.push({ role: i % 2 ? "assistant" : "user", content: "m" + i });
  ok("many tiny messages under the character threshold are not trimmed", w.__rsVaniPatchMessages(small).trimmed === 0);

  // ── 2. fetch wrapper ──
  agent("on");
  const body = JSON.stringify({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: "please run get_studio_state and report back to me in detail now" }] });
  await w.fetch("https://c.vani.ai/api/public/chat", { method: "POST", headers: { "content-type": "application/json" }, body });
  ok("fetch(url, {body}) to /api/public/chat is shaped while the agent is on", seen.length === 1 && typeof seen[0].body === "string" && JSON.parse(seen[0].body).messages[0].content.startsWith(PIN));
  await w.fetch(new w.Request("https://c.vani.ai/api/chat/stream", { method: "POST", headers: { "content-type": "application/json" }, body }));
  await sleep(10);
  const last = seen[seen.length - 1];
  const txt = await (last.body && typeof last.body.text === "function" ? last.body.text() : Promise.resolve(String(last.body)));
  ok("fetch(Request) to /api/chat/stream is cloned and re-issued with the shaped body", /api\/chat\/stream/.test(last.url) && JSON.parse(txt).messages[0].content.startsWith(PIN));
  await w.fetch("https://c.vani.ai/api/chat/conversations", { method: "POST", body: JSON.stringify({ title: "x" }) });
  ok("other POSTs (create conversation) are untouched", seen[seen.length - 1].body === JSON.stringify({ title: "x" }));
  await w.fetch("https://c.vani.ai/api/public/chat", { method: "GET" });
  ok("GET passes straight through", seen[seen.length - 1].method === "GET");
  agent("off");
  await w.fetch("https://c.vani.ai/api/public/chat", { method: "POST", body });
  ok("agent off: the identical chat request is sent as-is", seen[seen.length - 1].body === body);
  ok("the stream tap still sees the shaped request: the sent fragment lives at the END of the message, which the shaper never edits", (() => { agent("on"); const R = w.RSStreamNet; R.markSent("please run get_studio_state and report back to me in detail now"); const frag = JSON.parse(w.document.documentElement.getAttribute("data-rs-sent")).frag; const shaped = patch(body); return shaped.includes(frag) && JSON.parse(shaped).messages[0].content.endsWith("in detail now"); })());

  // ── 3. Vani SSE dialect in the stream tap ──
  const fold = (lines, kind) => w.__rsStreamNetFold(lines, kind);
  let f = fold(['data: {"type":"message.start","id":"msg_1"}', 'data: {"type":"content.delta","text":"Sure. "}', 'data: {"type":"content.delta","text":"```json\\n{\\"command\\":\\"get_studio_state\\",\\"params\\":{}}\\n```"}', 'data: {"type":"usage","prompt_tokens":812,"completion_tokens":40,"weekly_used_percent":3}', 'data: {"type":"message.complete"}']);
  ok("Vani typed frames: content.delta text concatenates, usage ignored, message.complete ends the turn", f.text === "Sure. ```json\n{\"command\":\"get_studio_state\",\"params\":{}}\n```" && f.done === true && !f.err, f);
  f = fold(["event: message.start", 'data: {"id":"msg_2"}', "event: content.delta", 'data: {"text":"Hel"}', "event: content.delta", 'data: {"text":"lo"}', "event: usage", 'data: {"prompt_tokens":1}', "event: message.complete", 'data: {}']);
  ok("Vani event:-field form decodes the same way", f.text === "Hello" && f.done === true, f);
  f = fold(['data: {"type":"tool.proposal","tool":"document","args":{"title":"x"}}', 'data: {"type":"content.delta","text":"text"}', 'data: {"type":"tool.done"}']);
  ok("tool.* proposal frames are ignored and never end the turn by themselves", f.text === "text" && f.done === false, f);
  f = fold(['data: {"type":"error","error":{"code":"concurrency_limit","message":"One active conversation per IP"}}']);
  ok("typed error frames surface the message", /One active conversation/.test(f.err), f);
  f = fold(['data: {"type":"text-end","id":"t"}', 'data: {"type":"content_block_stop","index":0}', 'data: {"type":"finish-step"}', 'data: {"type":"response.output_text.done","text":"x"}']);
  ok("part-level closers (text-end, content_block_stop, finish-step, output_text.done) still do NOT end the message", f.done === false, f);
  for (const t of ["message.complete", "message.done", "response.done", "message_end", "conversation.end", "stream-finished", "message.stop"]) { const g = fold([`data: {"type":"${t}"}`]); if (!g.done) ok("done type " + t, false, g); }
  ok("dotted / underscored / dashed end-of-message types all end the turn", true);

  // ── 4. reader: long warm-up for a matched open stream + body-level error wording ──
  // fresh reader (no markSent yet, so a request that started long ago is still "this turn")
  const d3 = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://c.vani.ai/c", virtualConsole: vc });
  const w3 = d3.window; w3.eval(read("src/providers/stream-reader.js"));
  const R = w3.RSStreamNet;
  const node = (obj) => { let el = w3.document.getElementById("rs-stream-net"); if (!el) { el = w3.document.createElement("script"); el.type = "application/json"; el.id = "rs-stream-net"; w3.document.body.appendChild(el); } el.textContent = JSON.stringify(obj); };
  const now = Date.now();
  node({ rid: 501, text: "", done: false, t: now, matched: true, kind: "sse", url: "/api/public/chat", status: 200, err: "", startedAt: now - 100000, sentAt: now - 100000, chunks: 0 });
  ok("a matched request open for 100 s with no text yet is still 'streaming' (the model is thinking) - the core never calls it empty", R.genState({}) === "streaming", R.current());
  node({ rid: 501, text: "", done: false, t: now, matched: true, kind: "sse", url: "/api/public/chat", status: 200, err: "", startedAt: now - 160000, sentAt: now - 160000, chunks: 0 });
  ok("…bounded at 150 s (an undecodable dialect hands back to the DOM)", R.genState({}) === null);
  node({ rid: 501, text: "", done: false, t: now, matched: false, kind: "sse", url: "/api/public/chat", status: 200, err: "", startedAt: now - 5000, sentAt: now - 5000, chunks: 0 });
  ok("a 'maybe' request with no text says nothing", R.genState({}) === null);
  ok("describe(): Vani's 429 weekly_limit body is worded as allowance used up (the adapter's allowance detector), concurrency_limit as one-reply-at-a-time (busy detector), context errors as too long", /free allowance is used up/.test(R.describe({ status: 429, text: 'HTTP 429: {"error":{"code":"weekly_limit"}}' }, "Vani Chat")) && /one reply at a time/.test(R.describe({ status: 429, text: 'HTTP 429: {"error":{"code":"concurrency_limit","message":"One active conversation per IP"}}' }, "Vani Chat")) && /message is too long/.test(R.describe({ status: 400, text: "HTTP 400: context_length_exceeded" }, "Vani Chat")) && /rate limiting/.test(R.describe({ status: 429, text: "HTTP 429: slow down" }, "Vani Chat")));

  // ── 5. adapter + wiring ──
  const vani = read("src/providers/vani.js");
  const P = (() => { const d2 = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://c.vani.ai/c", virtualConsole: vc }); d2.window.eval(vani + "\n;window.__P = RSProvider;"); return d2.window.__P; })();
  ok("vani timings: WARMUP 40 s / REASON_NOREPLY 60 s / STABLE 2.5 s (the tap decides when a stream is live; these only guard the DOM fallback)", P.timings.WARMUP_MS === 40000 && P.timings.REASON_NOREPLY_MS === 60000 && P.timings.STABLE_MS === 2500 && P.timings.RESPONSE_TIMEOUT_MS === 300000);
  ok("vani busy / allowance detectors understand the reader's wording and Vani's error codes", P.isBusyMsg("Vani Chat allows one reply at a time per connection (HTTP 429) — try again in a moment.") && P.isBusyMsg("concurrency_limit") && P.isBusyMsg("Vani Chat says the free allowance is used up (HTTP 429) — log in or wait for the reset, then retry.") && P.isTooLongMsg("Vani Chat says the message is too long (HTTP 413) — the next turn is sent shorter."));
  ok("vani promptExtra forbids web search / documents / Vani tools and asks for one short line of prose", /Do NOT search the web/.test(P.promptExtra) && /Document \/ Slides \/ Design \/ canvas \/ artifact/.test(P.promptExtra) && /one short line per reply/.test(P.promptExtra));
  const manifest = JSON.parse(read("manifest.json"));
  const tap = manifest.content_scripts.find((c) => c.world === "MAIN" && c.js.includes("src/providers/vani-net.js"));
  ok("manifest: vani-net.js runs in the MAIN world at document_start on c.vani.ai only", tap && tap.run_at === "document_start" && tap.matches.length === 1 && tap.matches[0] === "https://c.vani.ai/*");
  const snet = manifest.content_scripts.find((c) => c.world === "MAIN" && c.js.includes("src/providers/stream-net.js"));
  ok("manifest: the stream tap is still on c.vani.ai (both taps wrap fetch; order does not matter - the shaper edits only the body, the tap only reads)", snet && snet.matches.includes("https://c.vani.ai/*"));
  ok("main.js publishes <html data-rs-agent> (on / starting / off) that the shaper gates on", /setAttribute\("data-rs-agent", A\.started \? "on" : \(A\.starting \? "starting" : "off"\)\)/.test(read("src/core/main.js")));
  const readme = read("README.md");
  ok("README documents 1.66.0 (Vani request shaper, dialect, warm-up)", /\*\*1\.66\.0 — /.test(readme) && /vani-net\.js/.test(readme) && /test-vani-net\.js/.test(readme));
  console.log(`test-vani-net: ${n} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FAIL harness error", e && e.stack || e); process.exit(1); });
