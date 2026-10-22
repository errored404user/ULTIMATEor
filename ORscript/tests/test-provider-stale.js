// 1.63.0 — "it executed the previous answer again" on Arena (and others).
// Two layers: (1) the core never parses a reply that is provably the turn that
// already existed before the send (same node / no new node + identical text);
// (2) the Arena provider recognises turns without depending on this month's
// Tailwind classes (`mx-auto`, `justify-end`, `ol.flex-col-reverse`).
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-provider-stale.js
"use strict";
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const main = read("src/core/main.js"), arenaSrc = read("src/providers/arena.js");
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) passed++; else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 500) : "")); } };

// ── 1. core: isStaleReply (real source, lifted out of main.js) ─────────────────────────────
const fnSrc = (() => { const i = main.indexOf("  function isStaleReply(curTok, replyText) {"); const j = main.indexOf("\n  }\n", i); return main.slice(i, j + 4); })();
ok("main.js defines isStaleReply", fnSrc.startsWith("  function isStaleReply") && /return txt\.length > 0 && \(txt === snap\.text \|\| txt === snap\.reply\);/.test(fnSrc));
function makeStale(A, P) { return new Function("A", "P", fnSrc + "\nreturn isStaleReply;")(A, P); }
{
  const A = { sendToken: 7, sendSnapshot: { tok: 7, count: 3, text: "run this ```json {\"tool\":\"x\"} ```" } };
  const P = { assistantCount: () => 3 };
  const stale = makeStale(A, P);
  ok("same node + identical text ⇒ stale", stale(7, "run this   ```json {\"tool\":\"x\"} ```") === true);
  ok("new node + count grew ⇒ not stale even with identical text", makeStale(A, { assistantCount: () => 4 })(8, "run this ```json {\"tool\":\"x\"} ```") === false);
  ok("new node identity but FLAT count + identical text ⇒ stale (React re-keyed the same turn)", stale(8, "run this ```json {\"tool\":\"x\"} ```") === true);
  ok("new node + flat count + different text ⇒ not stale", stale(8, "fresh answer") === false);
  ok("same node but different text (regenerated in place) ⇒ not stale", stale(7, "something new") === false);
  ok("empty read ⇒ not stale (the empty / warm-up branches own that case)", stale(7, "") === false);
  ok("no snapshot ⇒ not stale", makeStale({ sendToken: 7, sendSnapshot: null }, P)(7, "run this") === false);
  ok("autoResume (sendToken === null) ⇒ never stale", makeStale({ sendToken: null, sendSnapshot: { tok: 7, count: 3, text: "run this" } }, P)(7, "run this") === false);
  // count-only providers (no lastAssistantId): undefined / null token
  const P2 = { assistantCount: () => 3 };
  ok("count-only provider: count unchanged + same text ⇒ stale", makeStale(A, P2)(undefined, "run this ```json {\"tool\":\"x\"} ```") === true);
  ok("count-only provider: count grew ⇒ not stale", makeStale(A, { assistantCount: () => 4 })(undefined, "run this ```json {\"tool\":\"x\"} ```") === false);
  ok("null token (id missing on this node) falls back to the count test", makeStale(A, P2)(null, "run this ```json {\"tool\":\"x\"} ```") === true);
}
// wiring pins
ok("captureSendToken records the pre-send text (itemText AND readAssistant reply) + count snapshot", /A\.sendSnapshot = \{ tok: A\.sendToken, count: P\.assistantCount\(\), text: txt\.replace\(\/\\s\+\/g, " "\)\.trim\(\), reply: rep\.replace\(\/\\s\+\/g, " "\)\.trim\(\), at: Date\.now\(\) \};/.test(main));
{
  const A = { sendToken: 7, sendSnapshot: { tok: 7, count: 3, text: "Output header run this", reply: "run this" } };
  ok("the masked reply text (readAssistant) also identifies the old turn", makeStale(A, { assistantCount: () => 3 })(7, "run this") === true);
}
ok("waitForResponse gates on the stale turn BEFORE the reliableCounts gate and ends 'empty' after the grace window", (() => { const i = main.indexOf("const stale = isStaleReply(curTok, d.reply || lastGoodReply);"); const j = main.indexOf("if (P.reliableCounts && !newReply) {"); return i > 0 && j > i && /if \(_w < NO_TURN_GRACE_MS\) \{ await sleep\(120\); continue; \}\s*diag\("empty\.why", \{ branch: "staleTurn"/.test(main.slice(i, j)) && /return \{ kind: "empty", stale: true \};/.test(main.slice(i, j)); })());
ok("the stale gate sits after the generating / open-block wait (a live stream is never cut) and before parsing", main.indexOf("const stale = isStaleReply(") > main.indexOf("if ((gen || effectiveBlock) && !stuckDone) {") && main.indexOf("const stale = isStaleReply(") < main.indexOf("let r = d.reply;\n      if (!r && lastGoodReply)"));
ok("a tool turn whose command already ran (executed map) is never dispatched again", /if \(res\.kind === "tool" && res\.item && !res\.native && isRememberedExecuted\(res\.item, P\.itemText\(res\.item\)\)\) \{[\s\S]{0,400}res = \{ kind: "empty", stale: true \};/.test(main) && /let res = await waitForResponse\(base\);/.test(main));
ok("the user is told the previous reply was NOT re-run", /showed the previous reply again - it was NOT re-run/.test(main));

// ── 2. Arena provider in jsdom: validated DOM and a reskinned DOM ──────────────────────────
function loadArena(html, pathname) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://arena.ai" + (pathname || "/c/123"), runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  // layout stubs: everything is "visible"
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 100, height: 40, top: 0, left: 0, right: 100, bottom: 40 }; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return this.parentElement; } });
  w.eval(arenaSrc);
  return { w, P: w.RSProvider };
}
const USER = (t) => `<div class="mx-auto max-w-[800px] flex justify-end"><div class="prose">${t}</div></div>`;
const AST = (t) => `<div class="mx-auto max-w-[800px] flex"><div class="text-xs">Response provided by Anthropic</div><div class="flex flex-col gap-3"><div class="prose">${t}</div></div></div>`;
// flex-col-reverse: NEWEST FIRST in the DOM
const validated = `<main><ol class="flex flex-col-reverse">${AST("reply two")}${USER("prompt two")}${AST("reply one")}${USER("prompt one")}<div class="h-0"></div></ol><form><textarea placeholder="Ask anything"></textarea><button aria-label="Send message" type="submit"></button></form></main>`;
{
  const { P } = loadArena(validated);
  const items = P.allItems();
  ok("validated DOM: 4 turns, chronological order (newest-first list reversed)", items.length === 4 && P.itemText(items[0]) === "prompt one" && P.itemText(items[3]) === "reply two", items.map((i) => P.itemText(i)));
  ok("validated DOM: roles", P.isUserItem(items[0]) && P.isAssistantItem(items[1]) && P.isUserItem(items[2]) && P.isAssistantItem(items[3]) && P.assistantCount() === 2 && P.userCount() === 2);
  ok("validated DOM: lastAssistant is the newest reply and the vendor header is not read as output", P.itemText(P.lastAssistant()) === "reply two" && P.readAssistant().reply === "reply two");
  ok("validated DOM: lastAssistantId is stable per node and changes with a new node", (() => { const a = P.lastAssistantId(), b = P.lastAssistantId(); return a === b && a > 0; })());
}
// RESKIN: no <ol>, no mx-auto, no justify-end on the root; column-reverse via inline style; user alignment on an inner wrapper;
// assistant carries a data attribute; the bodies are still .prose
const reskin = `<main><section id="list" style="display:flex;flex-direction:column-reverse">
  <article data-message-role="assistant"><header>Response provided by OpenAI</header><div class="prose">reply two</div></article>
  <article><div class="flex self-end ml-auto"><div class="prose">prompt two</div></div></article>
  <article data-message-role="assistant"><header>Response provided by OpenAI</header><div class="prose">reply one</div></article>
  <article><div class="flex self-end ml-auto"><div class="prose">prompt one</div></div></article>
  <div class="h-0"></div></section><form><textarea placeholder="Ask anything"></textarea><button data-testid="stop-button" aria-label="Stop"></button></form></main>`;
{
  const { P } = loadArena(reskin);
  const items = P.allItems();
  ok("reskinned DOM (no ol / mx-auto / justify-end / flex-col-reverse class): all 4 turns found, chronological", items.length === 4 && P.itemText(items[0]) === "prompt one" && P.itemText(items[3]) === "reply two", items.map((i) => P.itemText(i)));
  ok("reskinned DOM: user turns by inner alignment wrapper, assistant turns by data attribute", P.isUserItem(items[0]) && P.isUserItem(items[2]) && P.isAssistantItem(items[1]) && P.isAssistantItem(items[3]) && P.assistantCount() === 2);
  ok("reskinned DOM: lastAssistant / readAssistant read the newest reply only", P.readAssistant().reply === "reply two" && P.streamLen() === "reply two".length);
  ok("reskinned DOM: a stop button found by data-testid counts as hard-generating", P.isHardGenerating() === true);
}
// NOT reversed list (plain column): must keep DOM order
const plain = `<main><ol class="flex flex-col">${USER("prompt one")}${AST("reply one")}${USER("prompt two")}${AST("reply two")}</ol><form><textarea></textarea></form></main>`;
{
  const { P } = loadArena(plain);
  const items = P.allItems();
  ok("a normal (non-reversed) list keeps DOM order - direction is detected, not assumed", items.length === 4 && P.itemText(items[0]) === "prompt one" && P.itemText(P.lastAssistant()) === "reply two", items.map((i) => P.itemText(i)));
}
// A/B carousel turn (no mx-auto) is still a turn and candidate A is read
const carousel = `<main><ol class="flex flex-col-reverse"><div class="w-full"><div role="region" aria-roledescription="carousel"><div aria-roledescription="slide"><div class="prose">candidate A</div></div><div aria-roledescription="slide"><div class="prose">candidate B</div></div></div></div>${USER("prompt one")}</ol><form><textarea></textarea></form></main>`;
{
  const { P } = loadArena(carousel);
  ok("A/B carousel turn is counted and candidate A is read", P.assistantCount() === 1 && P.readAssistant().reply === "candidate A");
}
// Empty / login page: nothing explodes, no turns, OR's own root is never a list
{
  const { P } = loadArena(`<div id="rs-root"><div class="prose">chip text</div><div class="prose">more</div><div class="prose">x</div></div><div>Sign in</div>`, "/text/direct");
  ok("OR's own #rs-root is never mistaken for the message list", P.allItems().length === 0 && P.chatIsEmpty());
}
ok("arena.js: direction helper + body selector + role helper exist", /const listReversed = \(ol\) =>/.test(arenaSrc) && /function directIsUser\(item\)/.test(arenaSrc) && /const bodySel = \(\) =>/.test(arenaSrc) && !/domTurns\(\)\.reverse\(\)/.test(arenaSrc));

console.log(`test-provider-stale: ${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
