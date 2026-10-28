"use strict";
// 1.85.0 — provider PARITY suite: ClickUp Brain, Vani Chat and Xiaomi MiMo
// against the Gemini / ChatGPT baseline (the adapters whose send path commits
// exactly once and whose row counts the core trusts).
//
// Part 1 (adapter table, no DOM): the three adapters export the same RSProvider
// surface as the baseline - same method names, same return types, the
// plain-text protocol in their prompt notes, bounded commandless retries,
// identical CMD_SHAPE masking rules (###CMD / ###LUA / escaped JSON).
//
// Part 2 (jsdom, adapter-level): the SEND contract under the three conditions
// that broke the pre-1.85 adapters -
//   * slow acceptance: the site clears the box 1.2 s after the click and adds
//     the user row at 1.5 s → exactly ONE submit (the old ≤5-click loop fired
//     again at 900 ms), text delivered byte-for-byte (multiline, indentation,
//     code, Turkish + Chinese), `*.send.landed` diag with a proof,
//   * disabled send button: the adapter falls back to the form / Enter path -
//     still one attempt,
//   * never accepted: typeAndSend returns within a bounded time, at most TWO
//     attempts (click + ONE alternate mechanism), `*.send.unconfirmed` diag.
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
  vani: {
    host: "c.vani.ai", path: "/chat", diagPrefix: "vani.send", landed: "vani.send.landed", unconfirmed: "vani.send.unconfirmed",
    html: `<main data-rect="0,0,1280,800"><div id="thread" class="messages" data-rect="300,0,900,640"></div>
      <form id="composer" data-rect="300,660,900,120"><textarea id="ed" placeholder="Message" data-rect="310,670,800,80"></textarea>
      <button id="send" type="submit" aria-label="Send message" data-rect="1140,690,40,40"><svg><path d="M1 1"/></svg></button></form></main>`,
    editorIsTextarea: true,
    userRow(d, text) { const r = d.createElement("div"); r.className = "flex justify-end"; r.setAttribute("data-rect", "700,100,480,40"); r.textContent = text; d.getElementById("thread").appendChild(r); },
  },
  mimo: {
    host: "aistudio.xiaomimimo.com", path: "/#/c", diagPrefix: "mimo.send", landed: "mimo.send_landed", unconfirmed: "mimo.send_unconfirmed",
    html: `<div class="dialogue-container" data-rect="280,0,1000,800"><div class="message-list" id="thread" data-rect="280,0,1000,660"></div>
      <div class="input-area" data-rect="320,690,920,90"><textarea id="ed" placeholder="给 MiMo 发消息" data-rect="330,700,800,60"></textarea>
      <button class="send-btn" id="send" data-rect="1190,700,40,40"><svg viewBox="0 0 19 18"><path d="M.244 7.921 18.202.03a.5.5 0 0 1 .668.668L10.98 18.5a.5.5 0 0 1-.93-.052L8.1 11.9.552 9.95a.5.5 0 0 1-.308-.929Z"/></svg></button></div></div>`,
    editorIsTextarea: true,
    userRow(d, text) { const r = d.createElement("div"); r.className = "message-item user-message"; r.setAttribute("data-rect", "760,100,500,44"); const c = d.createElement("div"); c.className = "content"; c.textContent = text; r.appendChild(c); d.getElementById("thread").appendChild(r); },
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
  meta: {
    host: "www.meta.ai", path: "/", diagPrefix: "meta.tas", landed: "meta.tas.sent", unconfirmed: "meta.tas.sent", sentFlag: true,
    html: `<main data-rect="0,0,1280,800"><div id="thread" data-rect="300,0,900,640"></div>
      <div class="composer" data-rect="300,660,900,120"><textarea id="ed" data-testid="composer-input" data-rect="310,670,800,80"></textarea>
      <button id="send" data-testid="composer-send-button" aria-label="Send" data-rect="1140,690,40,40"></button></div></main>`,
    editorIsTextarea: true, userRow: null,
  },
  oxalpha: {
    host: "oxalpha.com", path: "/chat", diagPrefix: "oxalpha.send", landed: "oxalpha.send.landed", unconfirmed: "oxalpha.send.unconfirmed",
    html: `<main data-rect="0,0,1280,800"><div id="thread" data-rect="300,0,900,640"></div>
      <form data-rect="300,660,900,120"><textarea id="ed" placeholder="Message" data-rect="310,670,800,80"></textarea>
      <button id="send" type="submit" aria-label="Send" data-rect="1140,690,40,40"></button></form></main>`,
    editorIsTextarea: true,
    userRow(d, text) { const r = d.createElement("div"); r.setAttribute("data-message-role", "user"); r.setAttribute("data-rect", "700,100,480,40"); r.textContent = text; d.getElementById("thread").appendChild(r); },
  },
  multichat: {
    host: "huggingface.co", path: "/chat/", diagPrefix: "huggingchat.send", landed: "huggingchat.send.landed", unconfirmed: "huggingchat.send.unconfirmed",
    html: `<main data-rect="0,0,1280,800"><div id="thread" data-rect="300,0,900,640"></div>
      <form data-rect="300,660,900,120"><textarea id="ed" placeholder="Ask anything" data-rect="310,670,800,80"></textarea>
      <button id="send" type="submit" aria-label="Send message" data-rect="1140,690,40,40"></button></form></main>`,
    editorIsTextarea: true,
    userRow(d, text) { const r = d.createElement("div"); r.setAttribute("data-message-role", "user"); r.setAttribute("data-rect", "700,100,480,40"); r.textContent = text; d.getElementById("thread").appendChild(r); },
  },
  clickup: {
    host: "app.clickup.com", path: "/9012/v/l/li/901", diagPrefix: "clickup.send", landed: "clickup.send.landed", unconfirmed: "clickup.send.unconfirmed",
    html: `<cu-ai-side-panel class="ai-chat-panel" role="dialog" aria-label="ClickUp Brain" data-rect="760,0,440,800">
      <div class="ai-chat__messages" id="thread" data-rect="760,40,440,600"></div>
      <div class="ai-chat__composer" data-rect="760,650,440,150"><div class="ai-chat__editor cu-ai-editor" data-rect="776,666,408,60"><div id="ed" class="ql-editor" contenteditable="true" data-placeholder="Ask AI anything..." data-rect="776,666,408,60"><p><br></p></div></div>
      <button type="button" id="send" data-test="ai-chat__send-button" aria-label="Send" data-rect="1150,730,30,30"><svg></svg></button></div></cu-ai-side-panel>`,
    editorIsTextarea: false,
    userRow(d, text) { const r = d.createElement("div"); r.className = "ai-chat-message ai-chat-message--user"; r.setAttribute("data-rect", "800,100,380,44"); r.textContent = text; d.getElementById("thread").appendChild(r); },
  },
};

function loadAdapter(id) {
  const spec = PAGES[id];
  const dom = new JSDOM(`<!doctype html><html><body>${spec.html}</body></html>`, { url: `https://${spec.host}${spec.path}`, pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  installDomShims(w);
  w.__rsDiag = [];
  w.eval(read("src/providers/stream-reader.js"));
  w.eval(read(`src/providers/${id}.js`));
  const P = w.RSProvider;
  // main.js hands every adapter its diag sink at init - same here.
  try { P.init({ diag: (event, data) => w.__rsDiag.push({ event, data: data || null }) }); } catch (e) { w.__rsDiag.push({ event: "init.throw", data: String(e && e.message) }); }
  return { w, d: w.document, P, spec };
}

// ── Part 1: adapter table against the baseline ─────────────────────────
const SEND_PATH_FNS = ["getEditor", "typeAndSend", "ensureComposerReady", "enforceComposer", "installSendHooks", "readAssistant", "lastAssistant", "isGenerating", "isHardGenerating", "isBusyNow", "userCount", "assistantCount", "allItems", "chatIsEmpty", "conversationKey", "scanError", "findToolBlockSpot", "classifyText", "snapshot", "stopGeneration", "isTooLongMsg", "findContinueBtn", "clickContinueBtn", "editorText"];
const base = loadAdapter("gemini").P;
const table = [];
const REPAIRED = ["vani", "mimo", "clickup", "arena", "meta", "oxalpha", "multichat"];
for (const id of REPAIRED) {
  const { P } = loadAdapter(id);
  const missing = SEND_PATH_FNS.filter((f) => typeof base[f] === "function" && typeof P[f] !== "function");
  ok(`${id}: every send/read method of the Gemini baseline exists with the same name`, missing.length === 0, missing);
  const typeMismatch = [];
  const probe = (f, call) => { let a, b; try { a = call(base); } catch (e) { a = "throw"; } try { b = call(P); } catch (e) { b = "throw"; } const ta = a === null ? "null" : typeof a, tb = b === null ? "null" : typeof b; if (ta !== tb && !(ta === "null" && tb === "object") && !(ta === "object" && tb === "null")) typeMismatch.push(f + ":" + ta + "≠" + tb); };
  probe("userCount", (p) => p.userCount()); probe("assistantCount", (p) => p.assistantCount()); probe("chatIsEmpty", (p) => p.chatIsEmpty());
  probe("isGenerating", (p) => p.isGenerating()); probe("isHardGenerating", (p) => p.isHardGenerating()); probe("isBusyNow", (p) => p.isBusyNow());
  probe("editorText", (p) => p.editorText()); probe("readAssistant(null)", (p) => p.readAssistant(null)); probe("snapshot", (p) => p.snapshot());
  probe("scanError", (p) => p.scanError() || ""); probe("isTooLongMsg", (p) => p.isTooLongMsg("x"));
  ok(`${id}: return types match the baseline on an empty page`, typeMismatch.length === 0, typeMismatch);
  // Vani / MiMo carry the shared PLAIN_FORMAT_NOTE (evidence: both mangle JSON
  // fences); ClickUp keeps the baseline json + ###LUA### wording - the shared
  // parser accepts ###CMD everywhere regardless (clickup-e2e proves it).
  ok(`${id}: promptExtra (if any) never calls JSON the only accepted form`, P.promptExtra == null || (typeof P.promptExtra === "string" && !/must be JSON|JSON only|only JSON/i.test(P.promptExtra)));
  if (["vani", "mimo", "clickup"].includes(id)) ok(`${id}: promptExtra teaches the fenced command protocol`, typeof P.promptExtra === "string" && /###LUA###|###CMD/.test(P.promptExtra));
  ok(`${id}: commandlessRetries is unset (core default 1) or a small bounded integer (no endless nudging)`, P.commandlessRetries == null || (Number.isInteger(P.commandlessRetries) && P.commandlessRetries >= 1 && P.commandlessRetries <= 3), P.commandlessRetries);
  ok(`${id}: timings carry the four keys the core waits on, all finite`, ["WARMUP_MS", "REASON_NOREPLY_MS", "STABLE_MS", "RESPONSE_TIMEOUT_MS"].every((k) => Number.isFinite(P.timings[k])));
  const src = read(`src/providers/${id}.js`);
  const tas = src.slice(src.indexOf("async function typeAndSend"), src.indexOf("async function typeAndSend") + 4000);
  ok(`${id}: no multi-click resend loop left in typeAndSend (one commit + one alternate is the only submit path)`, !/for \(let i = 0; i < \d+ && !sent; i\+\+\)/.test(tas) && /proof\(\)/.test(src));
  table.push({ id, methods: SEND_PATH_FNS.filter((f) => typeof P[f] === "function").length + "/" + SEND_PATH_FNS.length, promptExtra: (P.promptExtra || "").length, commandlessRetries: P.commandlessRetries, reliableCounts: !!P.reliableCounts });
}
console.table(table);

// CMD_SHAPE parity: the three adapters mask the same shapes the shared parser executes.
{
  const shapes = ["###CMD part_create###\nname: X\n###END_CMD###", "###LUA###\nprint(1)\n###END_LUA###", '{"command":"part_create","args":{}}', '{\\"command\\":\\"x\\"}', "{ command: 'x' }", "###MCP_TOOL###"];
  for (const id of ["vani", "mimo", "clickup"]) {
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
  const text = () => spec.editorIsTextarea ? ed.value : ed.innerText;
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
    // (b) disabled send button → alternate mechanism, still one attempt
    {
      const page = loadAdapter(id); const { w, spec, P } = page;
      const site = wireSite(page, "disabled-button");
      await P.typeAndSend("second message\nwith two lines");
      ok(`${id}: disabled send button → form/Enter fallback, still exactly one submit`, site.attempts === 1 && /second message\s+with two lines/.test(site.captured[0] || ""), { attempts: site.attempts, got: site.captured[0] });
      const landed = landedOf(w, spec);
      ok(`${id}: fallback send still reports a landing proof`, landed.length === 1 && landed[0].data && landed[0].data.how !== "click", landed.map((e) => e.data));
    }
    // (c) never accepted → bounded, at most two attempts, honest diag
    {
      const page = loadAdapter(id); const { w, spec, P } = page;
      const site = wireSite(page, "never");
      const t0 = Date.now();
      await P.typeAndSend("hello?");
      const dt = Date.now() - t0;
      ok(`${id}: a send the site swallows → at most 2 attempts (click + ONE alternate), never a loop`, site.attempts >= 1 && site.attempts <= 2, site.attempts);
      ok(`${id}: typeAndSend returns within the bounded window (~5 s) instead of hanging`, dt < 7000, dt + " ms");
      ok(`${id}: '${spec.unconfirmed}' diag emitted and no false 'landed'`, unconfirmedOf(w, spec).length >= 1 && landedOf(w, spec).length === 0, w.__rsDiag.filter((e) => /send|tas/.test(e.event)).map((e) => e.event + ":" + JSON.stringify(e.data)));
    }
  }
  console.log(`\ntest-provider-parity: ${pass} passed, ${fail} failed (jsdom adapter-level simulation; no live site)`);
  process.exit(fail ? 1 : 0);
})();
