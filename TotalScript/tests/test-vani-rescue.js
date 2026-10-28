// 1.76.0 — Vani Chat: commandless-reply rescue + visible request-shaper status.
// Reported live (logged-in account, paid model): the model answers in prose
// ("I can't run commands / use JSON blocks", a plan, a tool proposal), the core
// nudges ONCE, the second prose reply ends the run with a bare "Reply finished"
// and nothing runs in Studio. This release: (a) the shaper's pin and the
// adapter's promptExtra say outright that Vani's own tools cannot reach Studio
// and that the model is not asked to execute anything; (b) the adapter asks for
// TWO escalating rescues (provider-specific notes, no fenced block inside them);
// (c) when both fail the core says what happened and what to do; (d) the shaper
// publishes whether it actually pinned the request (<html data-rs-vani-shaped /
// data-rs-vani-unshaped / data-rs-vani-net>) and the adapter's bridgeStatus()
// turns that into a label the toasts show — diagnosable without a console.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let n = 0, failed = 0;
const ok = (name, cond, extra) => { n++; if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 600) : "")); } };
const finish = () => { console.log(`\n${n - failed}/${n} checks passed`); process.exitCode = failed ? 1 : 0; };

let JSDOM, VirtualConsole; try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch { JSDOM = null; }

const main = read("src/core/main.js");
const vani = read("src/providers/vani.js");
const net = read("src/providers/vani-net.js");

// ── static pins: core loop ──
ok("main: provider-configurable rescue count (1..3) read from P.commandlessRetries", main.includes("const maxRefuse = Math.max(1, Math.min(3, Number(P.commandlessRetries) || 1));") && main.includes("if (refuseRetries < maxRefuse && !A.stop && (isCapabilityRefuse(body) || providerCommandless)) {") && !main.includes("if (refuseRetries < 1 && !A.stop"));
ok("main: second rescue uses the provider's FINAL note, first uses its own note, else the generic capabilityRefuse feedback", /let retryFeedback = refuseRetries > 1 && P\.commandlessRetryFeedbackFinal\s*\?\s*P\.commandlessRetryFeedbackFinal\s*:\s*providerCommandless && P\.commandlessRetryFeedback\s*\?\s*P\.commandlessRetryFeedback\s*:\s*RS\.FEEDBACK\.capabilityRefuse;/.test(main));
ok("main: the rescue toast carries the attempt count and the bridge label", main.includes("ui.toast(`Model replied without acting — requesting one command… (${refuseRetries}/${maxRefuse})${bridge && bridge.label ? \" · \" + bridge.label : \"\"}`)") && main.includes('typeof P.bridgeStatus === "function" ? P.bridgeStatus() : null'));
ok("main: give-up path — once per run, only after the rescues, only when nothing ran, with a plain note + steering text, then the run ends", main.includes("if (!commandlessGaveUp && !A.stop && refuseRetries >= maxRefuse && toolTurns === 0 && (isCapabilityRefuse(body) || providerCommandless)) {") && main.includes('diag("loop.commandlessGiveUp"') && main.includes("const note = P.commandlessGiveUpNote ||") && main.includes('ui.steeringProgress("complete", "Stopped: the model answered without a command", toolTurns);') && main.includes("let commandlessGaveUp = false;"));
ok("main: order — rescue, give-up, then the mode gate nudge (the gate never replaces the rescue)", main.indexOf('diag("loop.capabilityRefuse"') < main.indexOf('diag("loop.commandlessGiveUp"') && main.indexOf('diag("loop.commandlessGiveUp"') < main.indexOf("const nudge = modeGateNudge(A.runTools);"));
ok("main: toasts stay up longer for long notes (capped at 12 s)", main.includes("const ms = Math.min(12000, 3500 + Math.max(0, String(msg || \"\").length - 60) * 40);"));

// ── static pins: shaper ──
ok("vani-net: pin tells the model it executes nothing itself and that Vani's tools cannot reach Studio", net.includes("You are NOT being asked to execute anything yourself and you do not need any tool for this") && net.includes("Vani's own tools (web search, Document, Slides, Design, code execution) cannot reach Roblox Studio"));
ok("vani-net: publishes shaped / unshaped status attributes + a loaded marker, and routes every transport through shapeOrNote", net.includes('setAttribute("data-rs-vani-shaped"') && net.includes('setAttribute("data-rs-vani-unshaped"') && net.includes('setAttribute("data-rs-vani-net", "1.81")') && (net.match(/shapeOrNote\(/g) || []).length >= 4 && net.includes("noteUnshaped(\"body is \""));

// ── adapter contract (jsdom) ──
if (!JSDOM) { console.log("SKIP jsdom not installed — adapter / shaper checks"); finish(); return; }
const vc = new VirtualConsole(); vc.on("error", () => {}); vc.on("jsdomError", () => {});
const P = (() => { const d = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://c.vani.ai/chat", virtualConsole: vc }); d.window.eval(vani + "\n;window.__P = RSProvider;"); return { P: d.window.__P, w: d.window }; })();
const A = P.P, w = P.w;
ok("adapter: asks for 2 rescues and ships both notes + the give-up note + bridgeStatus()", A.commandlessRetries === 2 && typeof A.shouldRetryCommandlessText === "function" && typeof A.commandlessRetryFeedback === "string" && typeof A.commandlessRetryFeedbackFinal === "string" && typeof A.commandlessGiveUpNote === "string" && typeof A.bridgeStatus === "function");
const prose = [
  "I don't have the ability to run commands in Roblox Studio, but here's the code you can paste into a Script:",
  "I can only use the tools I was given in this chat, and none of them connects to Roblox Studio.",
  "I can't use JSON blocks as tool calls here. Let me outline the plan instead.",
  "I'll create a document with the full implementation plan for your shop UI.",
  "Let me search the web for the latest Roblox API first.",
  "Done! The leaderboard has been created and is now visible in your place.",
];
ok("adapter: refusals / tool talk / artifacts / plans / fake completions all trigger a rescue", prose.every((t) => A.shouldRetryCommandlessText(t) === true), prose.map((t) => A.shouldRetryCommandlessText(t)));
ok("adapter: a real command block, or an empty reply, never triggers the rescue", A.shouldRetryCommandlessText("Sure.\n```json\n{\"command\":\"list_commands\",\"params\":{}}\n```") === false && A.shouldRetryCommandlessText("###LUA###\nprint(1)\n###END_LUA###") === false && A.shouldRetryCommandlessText("") === false);
ok("adapter: rescue notes contain NO fenced block (a fenced block in a user bubble can be misread as an assistant row), name list_commands as the fallback, and the final note demands the block only", !/```/.test(A.commandlessRetryFeedback) && !/```/.test(A.commandlessRetryFeedbackFinal) && /list_commands/.test(A.commandlessRetryFeedback) && /list_commands/.test(A.commandlessRetryFeedbackFinal) && /not a Vani tool, not a jailbreak/.test(A.commandlessRetryFeedback) && /ONLY the command block and nothing else/.test(A.commandlessRetryFeedbackFinal) && /###CMD list_commands###/.test(A.commandlessRetryFeedbackFinal) && /###LUA###/.test(A.commandlessRetryFeedbackFinal) && /no JSON needed/.test(A.commandlessRetryFeedbackFinal) && /final request/.test(A.commandlessRetryFeedbackFinal));
ok("adapter: give-up note names the working guest models and the Switch AI way out", /GPT-6\.1 Sol or GLM 5\.3/.test(A.commandlessGiveUpNote) && /Switch AI/.test(A.commandlessGiveUpNote) && /Start Agent/.test(A.commandlessGiveUpNote));
ok("adapter: promptExtra says Vani's tools cannot reach Studio", /Vani's own tools \(web search, Document, Slides, Design, code execution\) cannot reach Studio/.test(A.promptExtra) && /Do NOT search the web/.test(A.promptExtra));
const html = w.document.documentElement;
let st = A.bridgeStatus();
ok("bridgeStatus: shaper not loaded → says so", st.tapLoaded === false && /request shaper not loaded/.test(st.label) && st.shaped === false);
html.setAttribute("data-rs-vani-net", "1.78");
st = A.bridgeStatus();
ok("bridgeStatus: loaded, nothing seen yet", st.tapLoaded === true && /no chat request seen yet/.test(st.label) && st.shaped === false);
html.setAttribute("data-rs-vani-shaped", JSON.stringify({ n: 1, pinned: true, trimmed: 0, messages: 3, url: "/api/chat/stream", at: 1000 }));
st = A.bridgeStatus();
ok("bridgeStatus: shaped → pinned ✓ with the message count", st.shaped === true && st.pinned === true && /protocol pinned \u2713 \(3 msgs\)/.test(st.label), st.label);
html.setAttribute("data-rs-vani-unshaped", JSON.stringify({ n: 1, why: "no messages field", url: "/api/chat/stream", at: 2000 }));
st = A.bridgeStatus();
ok("bridgeStatus: a LATER unshaped request wins → NOT shaped ✗ with the reason and path", st.shaped === false && /request NOT shaped \u2717 \(no messages field \u00b7 \/api\/chat\/stream\)/.test(st.label), st.label);
html.setAttribute("data-rs-vani-shaped", JSON.stringify({ n: 2, pinned: true, trimmed: 5, messages: 15, url: "/api/chat/stream", at: 3000 }));
st = A.bridgeStatus();
ok("bridgeStatus: a newer shaped request wins again and shows the trim", st.shaped === true && /\(15 msgs, 5 trimmed\)/.test(st.label), st.label);
ok("adapter: version marker bumped", vani.includes('setAttribute("data-rs-vani-ver", "2026-10f")'));

// ── shaper in a page world (jsdom) ──
(async () => {
  const d2 = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true, url: "https://c.vani.ai/chat", virtualConsole: vc });
  const w2 = d2.window;
  w2.Request = Request; w2.Response = Response; w2.Headers = Headers; w2.ReadableStream = ReadableStream; w2.TextDecoder = TextDecoder; w2.TextEncoder = TextEncoder;
  const seen = [];
  w2.fetch = (input, init) => { seen.push({ url: typeof input === "string" ? input : input.url, body: init && init.body }); return Promise.resolve(new Response("ok")); };
  w2.console.log = () => {};
  w2.eval(net);
  const h = w2.document.documentElement;
  const attr = (k) => { const raw = h.getAttribute(k); return raw ? JSON.parse(raw) : null; };
  ok("shaper: marks itself loaded at document_start", h.getAttribute("data-rs-vani-net") === "1.81");
  const body = JSON.stringify({ model: "anthropic/claude", conversation_id: "c1", tool_execution: "confirm", vani_mode: "standard", messages: [{ role: "user", content: "bootstrap" }, { role: "assistant", content: "ok" }, { role: "user", content: "Result: fine. Continue." }] });
  h.setAttribute("data-rs-agent", "off");
  await w2.fetch("/api/chat/stream", { method: "POST", body });
  ok("agent off: nothing shaped, nothing reported", seen[0].body === body && !attr("data-rs-vani-shaped") && !attr("data-rs-vani-unshaped"));
  h.setAttribute("data-rs-agent", "on");
  await w2.fetch("/api/chat/stream", { method: "POST", body });
  let sh = attr("data-rs-vani-shaped");
  const sent = JSON.parse(seen[1].body);
  ok("account transport (/api/chat/stream): pinned in the last user message, unknown params untouched, shaped status published", sent.messages[2].content.startsWith("[TotalScript bridge]") && sent.tool_execution === "confirm" && sent.vani_mode === "standard" && sent.conversation_id === "c1" && sh && sh.n === 1 && sh.pinned === true && sh.messages === 3 && sh.url === "/api/chat/stream" && typeof sh.at === "number", sh);
  await w2.fetch("/api/chat/stream", { method: "POST", body: JSON.stringify({ conversation_id: "c1", message: "hello" }) });
  let un = attr("data-rs-vani-unshaped");
  ok("a chat POST without messages[] is reported as unshaped with the reason", seen[2].body.includes('"message":"hello"') && un && un.why === "no messages field" && un.url === "/api/chat/stream" && un.n === 1, un);
  await w2.fetch("/api/chat/stream", { method: "POST", body: "not json at all {" });
  un = attr("data-rs-vani-unshaped");
  ok("a non-JSON chat body is reported too", un && un.why === "body not a JSON object" && un.n === 2, un);
  const fd = new w2.FormData(); fd.append("q", "x");
  await w2.fetch("/api/chat/stream", { method: "POST", body: fd });
  un = attr("data-rs-vani-unshaped");
  ok("a FormData chat body is reported as 'body is FormData'", un && /^body is FormData/.test(un.why) && un.n === 3, un);
  await w2.fetch("/api/presence", { method: "POST", body: JSON.stringify({ x: 1 }) });
  ok("non-chat URLs never produce an unshaped report", attr("data-rs-vani-unshaped").n === 3);
  const req = new w2.Request("https://c.vani.ai/api/public/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: "guest turn" }] }) });
  await w2.fetch(req);
  sh = attr("data-rs-vani-shaped");
  ok("Request-object transport (guest /api/public/chat) is shaped and reported as well", sh && sh.n === 2 && sh.url === "/api/public/chat" && sh.messages === 1, sh);
  const again = await (async () => { await w2.fetch("/api/chat/stream", { method: "POST", body: seen[1].body }); return seen[seen.length - 1].body === seen[1].body && attr("data-rs-vani-shaped").n === 2 && attr("data-rs-vani-unshaped").n === 3; })();
  ok("an already-pinned body (retry) is neither re-pinned nor reported as unshaped", again);

  const readme = read("README.md");
  ok("README: 1.76.0 entry + test listed", /\*\*1\.76\.0 — Vani: commandless-reply rescue, visible bridge status\.\*\*/.test(readme) && /test-vani-rescue\.js/.test(readme));
  const manifest = JSON.parse(read("manifest.json"));
  ok("version pins 1.82.0", manifest.version === "1.82.0" && /^version = "1\.82\.0"/m.test(read("agent/Cargo.toml")) && read("plugin/TotalScript.lua").includes('local VERSION = "1.82.0"'));
  finish();
})();
