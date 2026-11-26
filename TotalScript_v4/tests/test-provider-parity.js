"use strict";
// Provider parity: the repaired Vani / Arena / MultiChat send paths plus the
// Google AI Studio visible-UI adapter are checked against Gemini / ChatGPT's
// provider surface. The DOM is synthetic; no live provider is contacted.
//
// Part 1 (adapter table, no DOM): each adapter exports the same RSProvider
// surface as the baseline - same method names, same return types, bounded
// commandless retries, and consistent CMD_SHAPE masking (###CMD / ###LUA / JSON).
//
// Part 2 (jsdom, adapter-level): the SEND contract under three conditions that
// broke the pre-1.85 adapters, plus AI Free Forever / Langdock profile-specific
// composer discovery and scoped-send checks -
//   * slow acceptance: the site clears the box 1.2 s after the click and adds
//     the user row at 1.5 s → exactly ONE submit (the old ≤5-click loop fired
//     again at 900 ms), text delivered byte-for-byte (multiline, indentation,
//     code, Turkish + Chinese), `*.send.landed` diag with a proof,
//   * disabled send button: legacy adapters may use a safe alternate; MultiChat
//     site profiles instead report a guaranteed no-submit so the core can retry
//     only after the provider is ready,
//   * never accepted: typeAndSend returns within a bounded time, commits at most
//     once for opt-in single-commit profiles, and emits `*.send.unconfirmed`.
//
// OFFLINE / SIMULATED: no site is contacted. Run from the TotalScript root:
//   npm i --no-save jsdom && node tests/test-provider-parity.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let JSDOM, installDomShims, sleep;
try { ({ JSDOM } = require("jsdom")); ({ installDomShims, sleep } = require("./lib/e2e-page.js")); } catch (e) { console.log("test-provider-parity: jsdom missing (npm i --no-save jsdom) - skipped"); process.exit(0); }

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } }

const PAGES = {
  gemini: { host: "gemini.google.com", path: "/app", html: "<main></main>" },
  aistudio: {
    host: "aistudio.google.com", path: "/prompts/new_chat", diagPrefix: "aistudio.send", landed: "aistudio.send.landed", unconfirmed: "aistudio.send.unconfirmed",
    html: `<main><div id="thread"></div><form><ms-prompt-input-wrapper><textarea id="ed" aria-label="Enter a prompt"></textarea>
      <ms-run-button><button id="send" type="submit" aria-label="Run"></button></ms-run-button></ms-prompt-input-wrapper></form></main>`,
    editorIsTextarea: true,
    userRow(d, text) { const turn = d.createElement("ms-chat-turn"); const row = d.createElement("div"); row.className = "chat-turn-container user"; const chunk = d.createElement("ms-prompt-chunk"); chunk.textContent = text; row.appendChild(chunk); turn.appendChild(row); d.getElementById("thread").appendChild(turn); },
  },
  vani: {
    host: "c.vani.ai", path: "/chat", diagPrefix: "vani.send", landed: "vani.send.landed", unconfirmed: "vani.send.unconfirmed",
    html: `<main data-rect="0,0,1280,800"><div id="thread" class="messages" data-rect="300,0,900,640"></div>
      <form id="composer" data-rect="300,660,900,120"><textarea id="ed" placeholder="Message" data-rect="310,670,800,80"></textarea>
      <button id="send" type="submit" aria-label="Send message" data-rect="1140,690,40,40"><svg><path d="M1 1"/></svg></button></form></main>`,
    editorIsTextarea: true,
    userRow(d, text) { const r = d.createElement("div"); r.className = "flex justify-end"; r.setAttribute("data-rect", "700,100,480,40"); r.textContent = text; d.getElementById("thread").appendChild(r); },
  },
  // 1.86.0 - the four adapter families that still carried the multi-click loop
  // (Arena x8, Meta x6, Ox Alpha x5, MultiChat x5 for 11 provider ids).
  arena: {
    host: "arena.ai", path: "/", diagPrefix: "arena.tas", landed: "arena.tas.sent", unconfirmed: "arena.tas.sent", sentFlag: true,
    html: `<main data-rect="0,0,1280,800"><ol class="flex-col-reverse" id="thread" data-rect="300,0,900,640"></ol>
      <form data-rect="300,660,900,120"><textarea id="ed" placeholder="Ask anything" data-rect="310,670,800,80"></textarea>
      <button id="send" type="submit" aria-label="Send message" data-rect="1140,690,40,40"><svg><path d="M1 1"/></svg></button></form></main>`,
    editorIsTextarea: true, userRow: null,
  },
  multichat: {
    adapter: "multichat.js", providerId: "huggingchat", noSubmitOnDisabled: true,
    host: "huggingface.co", path: "/chat/", diagPrefix: "huggingchat.send", landed: "huggingchat.send.landed", unconfirmed: "huggingchat.send.unconfirmed",
    html: `<main data-rect="0,0,1280,800"><div id="thread" data-rect="300,0,900,640"></div><textarea id="search" placeholder="Search conversations" data-rect="10,20,180,30"></textarea>
      <form data-testid="composer" data-rect="300,660,900,120"><textarea id="ed" placeholder="Ask anything" data-rect="310,670,800,80"></textarea>
      <button id="send" type="submit" aria-label="Send message" data-rect="1140,690,40,40"></button></form>
      <form id="other-form"><button id="other-send" type="submit" aria-label="Send message">Send message</button></form></main>`,
    editorIsTextarea: true,
    userRow(d, text) { const r = d.createElement("div"); r.setAttribute("data-message-role", "user"); r.setAttribute("data-rect", "700,100,480,40"); r.textContent = text; d.getElementById("thread").appendChild(r); },
  },
  aifreeforever: {
    adapter: "multichat.js", providerId: "aifreeforever", noSubmitOnDisabled: true,
    host: "aifreeforever.com", path: "/chat/deepseek-v4-flash", diagPrefix: "aifreeforever.send", landed: "aifreeforever.send.landed", unconfirmed: "aifreeforever.send.unconfirmed",
    html: `<main data-rect="0,0,1280,800"><div id="thread" role="log" data-rect="300,0,900,640"></div><textarea id="search" placeholder="Search conversations" data-rect="10,20,180,30"></textarea>
      <form data-testid="composer" data-rect="300,660,900,120"><textarea id="ed" placeholder="Ask a question" aria-label="Message" data-rect="310,670,800,80"></textarea>
      <button id="send" type="submit" aria-label="Send message" data-rect="1140,690,40,40"></button></form>
      <form id="other-form"><button id="other-send" type="submit" aria-label="Send message">Send message</button></form></main>`,
    editorIsTextarea: true,
    userRow(d, text) { const r = d.createElement("div"); r.setAttribute("data-message-role", "user"); r.setAttribute("data-rect", "700,100,480,40"); r.textContent = text; d.getElementById("thread").appendChild(r); },
  },
  langdock: {
    adapter: "multichat.js", providerId: "langdock", noSubmitOnDisabled: true,
    host: "app.langdock.com", path: "/chat", diagPrefix: "langdock.send", landed: "langdock.send.landed", unconfirmed: "langdock.send.unconfirmed",
    html: `<main data-rect="0,0,1280,800"><div id="thread" role="log" data-rect="300,0,900,640"></div><textarea id="search" placeholder="Search conversations" data-rect="10,20,180,30"></textarea>
      <form data-testid="composer" data-rect="300,660,900,120"><div id="ed" data-lexical-editor="true" contenteditable="true" role="textbox" aria-label="Message" data-rect="310,670,800,80"></div>
      <button id="send" type="submit" data-testid="send-button" aria-label="Send message" data-rect="1140,690,40,40"></button></form>
      <form id="other-form"><button id="other-send" type="submit" aria-label="Send message">Send message</button></form></main>`,
    editorIsTextarea: false,
    userRow(d, text) { const r = d.createElement("div"); r.setAttribute("data-message-role", "user"); r.setAttribute("data-rect", "700,100,480,40"); r.textContent = text; d.getElementById("thread").appendChild(r); },
  },
};

function loadAdapter(id) {
  const spec = PAGES[id];
  const dom = new JSDOM(`<!doctype html><html><body>${spec.html}</body></html>`, { url: `https://${spec.host}${spec.path}`, pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  installDomShims(w);
  w.__rsDiag = [];
  w.eval(read("src/providers/stream-reader.js"));
  w.eval(read(`src/providers/${spec.adapter || `${id}.js`}`));
  const P = w.RSProvider;
  // main.js hands every adapter its diag sink at init - same here.
  try { P.init({ diag: (event, data) => w.__rsDiag.push({ event, data: data || null }) }); } catch (e) { w.__rsDiag.push({ event: "init.throw", data: String(e && e.message) }); }
  return { w, d: w.document, P, spec };
}

// ── Part 1: adapter table against the baseline ─────────────────────────
const SEND_PATH_FNS = ["getEditor", "typeAndSend", "ensureComposerReady", "enforceComposer", "installSendHooks", "readAssistant", "lastAssistant", "isGenerating", "isHardGenerating", "isBusyNow", "userCount", "assistantCount", "allItems", "chatIsEmpty", "conversationKey", "scanError", "findToolBlockSpot", "classifyText", "snapshot", "stopGeneration", "isTooLongMsg", "findContinueBtn", "clickContinueBtn", "editorText"];
const base = loadAdapter("gemini").P;
const table = [];
const REPAIRED = ["vani", "arena", "multichat", "aifreeforever", "langdock", "aistudio"]; // target MultiChat profiles are exercised on synthetic AI Free Forever / Langdock DOMs
for (const id of REPAIRED) {
  const { P } = loadAdapter(id);
  if (PAGES[id].providerId) ok(`${id}: host selects its intended profile id`, P.id === PAGES[id].providerId, P.id);
  const missing = SEND_PATH_FNS.filter((f) => typeof base[f] === "function" && typeof P[f] !== "function");
  ok(`${id}: every send/read method of the Gemini baseline exists with the same name`, missing.length === 0, missing);
  const typeMismatch = [];
  const probe = (f, call) => { let a, b; try { a = call(base); } catch (e) { a = "throw"; } try { b = call(P); } catch (e) { b = "throw"; } const ta = a === null ? "null" : typeof a, tb = b === null ? "null" : typeof b; if (ta !== tb && !(ta === "null" && tb === "object") && !(ta === "object" && tb === "null")) typeMismatch.push(f + ":" + ta + "≠" + tb); };
  probe("userCount", (p) => p.userCount()); probe("assistantCount", (p) => p.assistantCount()); probe("chatIsEmpty", (p) => p.chatIsEmpty());
  probe("isGenerating", (p) => p.isGenerating()); probe("isHardGenerating", (p) => p.isHardGenerating()); probe("isBusyNow", (p) => p.isBusyNow());
  probe("editorText", (p) => p.editorText()); probe("readAssistant(null)", (p) => p.readAssistant(null)); probe("snapshot", (p) => p.snapshot());
  probe("scanError", (p) => p.scanError() || ""); probe("isTooLongMsg", (p) => p.isTooLongMsg("x"));
  ok(`${id}: return types match the baseline on an empty page`, typeMismatch.length === 0, typeMismatch);
  // Vani carries the shared PLAIN_FORMAT_NOTE (evidence: it mangles JSON
  // fences); the shared parser accepts ###CMD everywhere regardless.
  ok(`${id}: promptExtra (if any) never calls JSON the only accepted form`, P.promptExtra == null || (typeof P.promptExtra === "string" && !/must be JSON|JSON only|only JSON/i.test(P.promptExtra)));
  if (["vani"].includes(id)) ok(`${id}: promptExtra teaches the fenced command protocol`, typeof P.promptExtra === "string" && /###LUA###|###CMD/.test(P.promptExtra));
  ok(`${id}: commandlessRetries is unset (core default 1) or a small bounded integer (no endless nudging)`, P.commandlessRetries == null || (Number.isInteger(P.commandlessRetries) && P.commandlessRetries >= 1 && P.commandlessRetries <= 3), P.commandlessRetries);
  ok(`${id}: timings carry the four keys the core waits on, all finite`, ["WARMUP_MS", "REASON_NOREPLY_MS", "STABLE_MS", "RESPONSE_TIMEOUT_MS"].every((k) => Number.isFinite(P.timings[k])));
  const src = read(`src/providers/${PAGES[id].adapter || `${id}.js`}`);
  const tas = src.slice(src.indexOf("async function typeAndSend"), src.indexOf("async function typeAndSend") + 4000);
  const hasCommitProof = /proof\(\)/.test(src) || (/async function commitSend/.test(src) && /typeAndSendSingleCommit:\s*true/.test(src));
  ok(`${id}: no multi-click resend loop left in typeAndSend (one commit + one alternate is the only submit path)`, !/for \(let i = 0; i < \d+ && !sent; i\+\+\)/.test(tas) && hasCommitProof);
  table.push({ id, methods: SEND_PATH_FNS.filter((f) => typeof P[f] === "function").length + "/" + SEND_PATH_FNS.length, promptExtra: (P.promptExtra || "").length, commandlessRetries: P.commandlessRetries, reliableCounts: !!P.reliableCounts });
}
console.table(table);

// CMD_SHAPE parity: the adapter masks the same shapes the shared parser executes.
{
  const shapes = ["###CMD part_create###\nname: X\n###END_CMD###", "###LUA###\nprint(1)\n###END_LUA###", '{"command":"part_create","args":{}}', '{\\"command\\":\\"x\\"}', "{ command: 'x' }", "###MCP_TOOL###"];
  for (const id of ["vani"]) {
    const { d, P } = loadAdapter(id);
    const hits = shapes.map((s) => { const item = d.createElement("div"); const pre = d.createElement("pre"); pre.textContent = s; item.appendChild(pre); d.body.appendChild(item); const spot = P.findToolBlockSpot(item); item.remove(); return !!spot; });
    ok(`${id}: findToolBlockSpot masks ###CMD, ###LUA, JSON and ###MCP_TOOL### blocks (prose pre untouched)`, hits[0] && hits[1] && hits[2] && hits[5] && (() => { const item = d.createElement("div"); const pre = d.createElement("pre"); pre.textContent = "local x = 1 -- just code"; item.appendChild(pre); d.body.appendChild(item); const r = P.findToolBlockSpot(item); item.remove(); return !r; })(), hits);
  }
}

// ── Part 2: the send contract under hostile acceptance timing ───────────
const TEXT = "Output of 'part_create':\n{\"ok\": true}\n\n```lua\nlocal p = Instance.new(\"Part\")\n    p.Name = \"Kapı_Çerçevesi\" -- Türkçe\n    p.Parent = workspace -- 中文注释\n```\nDone.";

function wireSite({ d, w, spec }, mode) {
  const ed = d.getElementById("ed"), send = d.getElementById("send");
  const state = { attempts: 0, captured: [], rows: 0 };
  const text = () => spec.editorIsTextarea ? ed.value : (ed.innerText || ed.textContent || "");
  const clear = () => { if (spec.editorIsTextarea) { ed.value = ""; ed.dispatchEvent(new w.Event("input", { bubbles: true })); } else { ed.innerHTML = "<p><br></p>"; ed.dispatchEvent(new w.Event("input", { bubbles: true })); } };
  const accept = () => {
    const t = text();
    if (!t.trim()) return;
    state.attempts++;
    if (mode === "never") return; // the site swallows the submit
    state.captured.push(t);
    setTimeout(clear, 1200);                       // slow acceptance: box stays filled 1.2 s
    if (spec.userRow) setTimeout(() => { spec.userRow(d, t); state.rows++; }, 1500);
  };
  // One real handler per site: a <form> site accepts on submit (a click on its
  // submit button and Enter both end there); a form-less site accepts on click
  // and on Enter.
  const form = ed.closest("form");
  if (form) form.addEventListener("submit", (e) => { e.preventDefault(); accept(); });
  else send.addEventListener("click", () => { if (send.disabled) return; accept(); });
  ed.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (form) form.requestSubmit(); else accept(); } });
  if (mode === "disabled-button") send.disabled = true;
  if (mode === "busy") {
    const stop = d.createElement("button");
    stop.setAttribute("aria-label", "Stop generating");
    stop.setAttribute("data-rect", "1150,690,40,40");
    (ed.closest("form") || d.body).appendChild(stop);
  }
  return state;
}

(async () => {
  const landedOf = (w, spec) => w.__rsDiag.filter((e) => e.event === spec.landed && (!spec.sentFlag || (e.data && e.data.sent === true)));
  const unconfirmedOf = (w, spec) => w.__rsDiag.filter((e) => e.event === spec.unconfirmed && (!spec.sentFlag || (e.data && e.data.sent === false)));
  for (const id of REPAIRED) {
    // (a) slow acceptance
    {
      const page = loadAdapter(id); const { w, P, spec } = page;
      const site = wireSite(page, "slow");
      const t0 = Date.now();
      await P.typeAndSend(TEXT);
      const dt = Date.now() - t0;
      ok(`${id}: slow acceptance → exactly ONE submit attempt (pre-1.85 adapters re-clicked at 900 ms)`, site.attempts === 1, site.attempts + " attempts");
      const got = site.captured[0] || "";
      const norm = (s) => s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n+$/, "");
      ok(`${id}: multiline / indented / code / Turkish / Chinese text delivered intact`, norm(got) === norm(TEXT), JSON.stringify(got.slice(0, 160)));
      const landed = landedOf(w, spec);
      ok(`${id}: one '${spec.landed}' diag with a landing proof, no 'unconfirmed'`, landed.length === 1 && !!(landed[0].data && landed[0].data.proof) && unconfirmedOf(w, spec).length === 0, landed.map((e) => e.data && e.data.proof));
      ok(`${id}: typeAndSend waited for the proof but no longer than the bounded window`, dt >= 1000 && dt < 6000, dt + " ms");
      await sleep(1700);
      if (spec.userRow) ok(`${id}: the user row that arrived late was counted once (userCount=1)`, P.userCount() === 1 && site.rows === 1, P.userCount());
    }
    // (b) disabled send control: MultiChat must not press Enter behind a
    // disabled site's back; providers with established fallback behavior retain it.
    {
      const page = loadAdapter(id); const { w, spec, P } = page;
      const site = wireSite(page, "disabled-button");
      const result = await P.typeAndSend("second message\nwith two lines");
      if (spec.noSubmitOnDisabled) {
        ok(`${id}: disabled send control → explicit no-submit, no hidden Enter/form submit`, result === false && site.attempts === 0, { result, attempts: site.attempts });
        ok(`${id}: disabled control emits an actionable diagnostic`, w.__rsDiag.some((e) => e.event === `${P.id}.send.control.disabled`));
      } else {
        ok(`${id}: disabled send button → form/Enter fallback, still exactly one submit`, site.attempts === 1 && /second message\s+with two lines/.test(site.captured[0] || ""), { attempts: site.attempts, got: site.captured[0] });
        const landed = landedOf(w, spec);
        ok(`${id}: fallback send still reports a landing proof`, landed.length === 1 && landed[0].data && landed[0].data.how !== "click", landed.map((e) => e.data));
      }
    }
    if (PAGES[id].noSubmitOnDisabled) {
      // (c) active Stop/busy control: never overwrite the draft or force-submit.
      const page = loadAdapter(id); const { w, P, spec } = page;
      const site = wireSite(page, "busy");
      const result = await P.typeAndSend("wait until the active turn ends");
      ok(`${id}: active Stop control → confirmed no-submit before typing`, result === false && site.attempts === 0 && P.editorText() === "");
      ok(`${id}: busy refusal reports the safe pre-type phase`, w.__rsDiag.some((e) => e.event === `${P.id}.send.busy` && e.data && e.data.phase === "before-type"));
    }
    // (d) never accepted → bounded, at most two attempts, honest diag
    {
      const page = loadAdapter(id); const { w, spec, P } = page;
      const site = wireSite(page, "never");
      const t0 = Date.now();
      await P.typeAndSend("hello?");
      const dt = Date.now() - t0;
      ok(`${id}: a send the site swallows → bounded submit count with no internal retry loop`, site.attempts >= 1 && site.attempts <= (P.typeAndSendSingleCommit ? 1 : 2), site.attempts);
      ok(`${id}: typeAndSend returns within the bounded window (~5 s) instead of hanging`, dt < 7000, dt + " ms");
      ok(`${id}: '${spec.unconfirmed}' diag emitted and no false 'landed'`, unconfirmedOf(w, spec).length >= 1 && landedOf(w, spec).length === 0, w.__rsDiag.filter((e) => /send|tas/.test(e.event)).map((e) => e.event + ":" + JSON.stringify(e.data)));
    }
  }
  console.log(`\ntest-provider-parity: ${pass} passed, ${fail} failed (jsdom adapter-level simulation; no live site)`);
  process.exit(fail ? 1 : 0);
})();
