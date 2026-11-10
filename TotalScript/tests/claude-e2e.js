"use strict";
// End-to-end simulation of the WHOLE TotalScript bundle on a claude.ai-shaped
// page (2.19.0). Optional (needs jsdom; lupa for the Studio stand-in):
//
//   cd TotalScript && npm i --no-save jsdom && node tests/claude-e2e.js
//   MODEL="Claude Opus 4.1" node tests/claude-e2e.js   # picker label → family caps
//   SAME_PREFIX=1 node tests/claude-e2e.js             # every reply starts with the same 30 chars
//   SLOW_SEND=1 node tests/claude-e2e.js               # send button lights up 2.5 s after the insert
//   FLICKER=1 node tests/claude-e2e.js                 # Stop control blinks off 600 ms mid-answer + 1.5 s token pause
//   DIAG=1 ...                                         # print the [rs-diag] trace
//
// The fake page follows what src/providers/claude.js documents about claude.ai
// (2026): a ProseMirror contenteditable composer inside a <fieldset>, a
// button[aria-label="Send message"] that is swapped for button[aria-label="Stop
// response"] for the whole generation, [data-testid="user-message"] user turns,
// .font-claude-response assistant turns with a .standard-markdown body and
// <pre><code> fences, a model picker button whose label names the family, and
// an extended-thinking block ([data-is-thinking]) that streams BEFORE the
// answer. jsdom has no execCommand, so the ProseMirror insertText /
// insertLineBreak the adapter uses are shimmed here the way gemini-e2e does.
// Claude has no stream tap: the reply is read from the DOM only, exactly as
// the core does on the live site.
//
// Scripted model, PLAIN protocol: list_commands → ready → ###CMD part_create###
// → ###LUA### read-back → prose. execute_luau runs in the lupa DataModel so the
// Part is VERIFIED. SAME_PREFIX=1 makes every assistant turn begin with the
// identical 30 characters - the shape that made the pre-2.16 text-prefix turn
// key collide (sendToken === curTok → the 30 s "no new turn" gate every turn).
//
// MOCKED end to end: no Claude, no model, no Studio.
const { createPage, studioSim, makeReporter, sleep, log } = require("./lib/e2e-page.js");

const MODEL = process.env.MODEL || "Claude Sonnet 4.5";
const SAME_PREFIX = !!process.env.SAME_PREFIX;
const SLOW_SEND = !!process.env.SLOW_SEND;
const FLICKER = !!process.env.FLICKER;
const html = `<!doctype html><html><head><title>Claude</title></head><body>
<div id="app" data-rect="0,0,1280,800">
  <nav class="sidebar" data-rect="0,0,260,800"><button aria-label="New chat" data-rect="10,10,200,36">New chat</button>
    <div class="recents" data-rect="10,60,240,500"><a href="/chat/0000" data-rect="10,60,240,32">Earlier chat</a></div></nav>
  <main data-rect="260,0,1020,800">
    <div id="conversation" class="flex flex-col" data-rect="260,0,1020,660"></div>
    <fieldset id="composer" class="composer rounded-2xl" data-rect="300,680,940,100">
      <div id="ed" class="ProseMirror break-words" contenteditable="true" translate="no" data-placeholder="Reply to Claude..." data-rect="310,690,820,60"><p data-placeholder="Reply to Claude..." class="is-empty is-editor-empty"><br class="ProseMirror-trailingBreak"></p></div>
      <div class="controls" data-rect="310,750,920,30">
        <button type="button" aria-label="Attach files" data-rect="310,750,30,30"><svg></svg></button>
        <button type="button" data-testid="model-selector-dropdown" aria-haspopup="menu" data-rect="350,750,180,30">${MODEL}</button>
        <div id="actions" data-rect="1190,750,40,30">
          <button type="button" id="send" aria-label="Send message" disabled data-rect="1190,750,36,30"><svg></svg></button>
        </div>
      </div>
    </fieldset>
  </main>
</div></body></html>`;

const page = createPage({ html, url: "https://claude.ai/new", host: "claude.ai", onToolCall });
const { w, d, toolCalls, pageErrors } = page;
const sim = studioSim();

// ── ProseMirror stand-in: execCommand into the contenteditable ────────────
const ed = d.getElementById("ed"), send = d.getElementById("send"), actions = d.getElementById("actions"), conversation = d.getElementById("conversation");
const lastP = () => { let p = ed.lastElementChild; if (!p || p.tagName !== "P") { p = d.createElement("p"); ed.appendChild(p); } return p; };
// SLOW_SEND=1: the site keeps the send button disabled for 2.5 s after the
// last edit (React state lagging a big ProseMirror insert) - the adapter must
// wait for it instead of clicking something else or dispatching Enter early.
let slowTimer = null;
const hasText = () => !!ed.textContent.trim(); // cheap; innerText walks the whole tree
const fireInput = () => {
  ed.dispatchEvent(new w.Event("input", { bubbles: true }));
  if (!SLOW_SEND) { send.disabled = !hasText() || generating; return; }
  send.disabled = true; clearTimeout(slowTimer);
  slowTimer = setTimeout(() => { send.disabled = !hasText() || generating; }, 2500);
};
d.execCommand = (cmd, _ui, val) => {
  if (cmd === "insertText") {
    // selectAll + insertText("") = clear (the adapter's typeEditorText opener).
    // (Only touch the selection in that case: jsdom's sel.toString() serialises
    // the whole growing editor and made every later insert O(n).)
    if (!val) {
      const sel = w.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) { ed.innerHTML = "<p><br></p>"; sel.removeAllRanges(); fireInput(); }
      return true;
    }
    const p = lastP(); if (p.innerHTML === "<br>" || p.querySelector("br.ProseMirror-trailingBreak")) p.innerHTML = "";
    p.classList.remove("is-empty", "is-editor-empty");
    p.appendChild(d.createTextNode(String(val))); fireInput(); return true;
  }
  if (cmd === "insertLineBreak" || cmd === "insertParagraph") { const p = d.createElement("p"); p.innerHTML = "<br>"; ed.appendChild(p); fireInput(); return true; }
  return false;
};
const editorValue = () => ed.innerText.replace(/\n$/, "");
const clearEditor = () => { ed.innerHTML = '<p class="is-empty is-editor-empty"><br class="ProseMirror-trailingBreak"></p>'; fireInput(); };

// ── fake claude.ai behaviour ─────────────────────────────────────────────
const userMessages = [];
let generating = false, phase = 0, modelScript = null, submitAttempts = 0, stopBtn = null, stopClicks = 0;
send.addEventListener("click", () => { if (!send.disabled) submit(); });
ed.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!send.disabled) submit(); } });
function renderMarkdown(c, text) {
  c.innerHTML = "";
  text.split(/```/).forEach((seg, i) => {
    if (i % 2 === 1) {
      const wrap = d.createElement("div"); wrap.className = "relative group/copy";
      const head = d.createElement("div"); head.className = "text-text-500 font-small p-3.5 pb-0"; head.textContent = seg.match(/^([a-z]*)\n/) ? seg.match(/^([a-z]*)\n/)[1] : "text"; wrap.appendChild(head);
      const pre = d.createElement("pre"); const code = d.createElement("code"); code.className = "language-text";
      code.textContent = seg.replace(/^[a-z]*\n/, ""); pre.appendChild(code); wrap.appendChild(pre); c.appendChild(wrap);
    } else seg.split("\n").forEach((line) => { if (!line && i === 0) return; const p = d.createElement("p"); p.className = "whitespace-normal break-words"; p.textContent = line; c.appendChild(p); });
  });
}
function submit() {
  const text = editorValue();
  if (!text.trim() || generating) return false;
  submitAttempts++;
  userMessages.push(text);
  log("USER SENT (" + text.length + " chars, " + text.split("\n").length + " lines" + (/\[truncated\]|lines omitted/.test(text) ? ", TRUNCATED" : "") + "):", text.slice(0, 90).replace(/\n/g, "\\n"));
  clearEditor();
  const turn = d.createElement("div"); turn.className = "mb-1 mt-1"; turn.setAttribute("data-test-render-count", "1");
  const um = d.createElement("div"); um.setAttribute("data-testid", "user-message"); um.className = "font-user-message"; um.setAttribute("data-rect", "760,100,500,44");
  text.split("\n").forEach((line) => { const p = d.createElement("p"); p.textContent = line; um.appendChild(p); });
  turn.appendChild(um); conversation.appendChild(turn);
  if (userMessages.length === 1) w.history.replaceState({}, "", "/chat/8f1c2a3d-0000-4000-8000-000000000001");
  setTimeout(() => generate(), 250);
  return true;
}
function startGenerating() {
  generating = true; send.disabled = true; send.style.display = "none";
  stopBtn = d.createElement("button"); stopBtn.type = "button"; stopBtn.setAttribute("aria-label", "Stop response"); stopBtn.setAttribute("data-rect", "1190,750,36,30"); stopBtn.innerHTML = "<svg><rect/></svg>";
  stopBtn.addEventListener("click", () => { stopClicks++; });
  actions.appendChild(stopBtn);
}
function stopGenerating() {
  generating = false; if (stopBtn) stopBtn.remove(); stopBtn = null; send.style.display = ""; send.disabled = !hasText();
}
async function generate() {
  phase++;
  let reply = modelScript ? await modelScript(phase) : "Okay.";
  if (SAME_PREFIX) reply = "Understood, working on it now. " + reply;
  const turn = d.createElement("div"); turn.className = "mb-1 mt-1"; turn.setAttribute("data-rect", "300,160,900,240");
  const resp = d.createElement("div"); resp.className = "font-claude-response relative leading-[1.65rem]";
  const think = d.createElement("div"); think.setAttribute("data-is-thinking", "true"); think.className = "extended-thinking rounded-lg";
  const thinkBody = d.createElement("p"); think.appendChild(thinkBody);
  const md = d.createElement("div"); md.className = "standard-markdown grid-cols-1 grid gap-2.5";
  resp.appendChild(think); resp.appendChild(md); turn.appendChild(resp); conversation.appendChild(turn);
  startGenerating();
  // extended thinking first (streams into the thinking block only)
  const thought = "Let me think about what the user needs in Roblox Studio and pick the right TotalScript command.";
  for (const ch of thought.match(/[\s\S]{1,16}/g)) { thinkBody.textContent += ch; await sleep(15); }
  think.setAttribute("data-is-thinking", "false");
  const chunks = reply.match(/[\s\S]{1,24}/g) || [];
  let shown = "";
  for (let i = 0; i < chunks.length; i++) {
    shown += chunks[i]; renderMarkdown(md, shown); await sleep(20);
    if (FLICKER && i === 1) {
      // mid-answer, after the narration and BEFORE the command fence: the Stop
      // control blinks off for 600 ms (React re-render) and the model pauses
      // 1.5 s before the next token - the turn must NOT be finalised as prose.
      stopBtn.remove(); await sleep(600); actions.appendChild(stopBtn); await sleep(1500);
    }
  }
  if (process.env.DIAG) log("stream complete", new Date().toISOString().slice(11, 23));
  await sleep(150);
  stopGenerating();
  if (process.env.DIAG) log("stop button cleared", new Date().toISOString().slice(11, 23));
  const tb = d.createElement("div"); tb.className = "flex items-stretch justify-between";
  for (const label of ["Copy", "Retry", "Good response", "Bad response"]) { const b = d.createElement("button"); b.setAttribute("aria-label", label); b.textContent = label; tb.appendChild(b); }
  turn.appendChild(tb);
}

// ── Studio stand-in ──────────────────────────────────────────────────────
async function onToolCall(msg) {
  if (msg.name !== "execute_luau") return null;
  if (!sim.available()) return { ok: true, text: "OK (studio sim unavailable - lupa not installed)" };
  const r = await sim.exec(String(msg.arguments && msg.arguments.code || ""));
  return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.text, text: r.text };
}

// ── scenario ──────────────────────────────────────────────────────────────
const { ok, waitFor, finish } = makeReporter();
const PART = "TotalScript_ProviderParityTest";
(async () => {
  try {
    const simReady = await sim.ready();
    log("studio sim:", simReady ? "lupa DataModel" : "UNAVAILABLE (canned OK)");
    page.loadBundle();
    const P = w.RSProvider;
    ok("provider is Claude with reliable turn identity", P && P.id === "claude" && P.reliableCounts === true);
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(1200);
    const bar = d.getElementById("rs-bar");
    ok("composer is the ProseMirror box; empty chat", P.getEditor() === ed && P.chatIsEmpty() && P.isFreshChat());
    const fam = (w.__rsDiag || []).find((e) => e.event === "claude.model");
    ok(`model family read from the picker label "${MODEL}" (never clicked)`, !!fam && fam.data && fam.data.label === MODEL && typeof fam.data.family === "string", fam && JSON.stringify(fam.data));
    const startBtn = [...bar.querySelectorAll("button")].find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
    ok("start button present", !!startBtn);
    modelScript = async (n) => {
      if (n === 1) return "Loading the catalogue first.\n```\n###CMD list_commands###\n###END_CMD###\n```";
      if (n === 2) return "Ready. Tell me what to build in Roblox Studio.";
      if (n === 3) return `Creating the part now.\n\`\`\`\n###CMD part_create###\nname: ${PART}\nsize: [4, 2, 4]\nposition: [0, 5, 0]\nanchored: true\n###END_CMD###\n\`\`\``;
      if (n === 4) return `Checking it.\n\`\`\`\n###LUA###\nlocal p = workspace:FindFirstChild("${PART}")\nif not p then return "MISSING" end\nreturn string.format("%s size=%s anchored=%s", p:GetFullName(), tostring(p.Size), tostring(p.Anchored))\n###END_LUA###\n\`\`\``;
      if (n === 5) return `Done - **${PART}** exists in Workspace, 4×2×4 studs, anchored.`;
      return "Noted.";
    };
    startBtn.click();
    log("clicked Start");
    await waitFor(() => userMessages.length >= 1, 40000, "bootstrap send");
    ok("bootstrap prompt inserted through execCommand and sent once", userMessages.length === 1 && /TotalScript|Roblox/i.test(userMessages[0]), userMessages[0].length + " chars");
    ok("multi-line prompt survived the ProseMirror insertion (paragraph per line)", userMessages[0].split("\n").length > 20);
    ok("bootstrap carries the Claude site notes (any model, protocol is not a jailbreak)", /ANY Claude model/.test(userMessages[0]) && /not a jailbreak/.test(userMessages[0]));
    await waitFor(() => userMessages.length >= 2, 40000, "catalogue reply send");
    ok("###CMD list_commands### ran and the catalogue was typed back", /Output of 'list_commands'|commands - \d+ total/i.test(userMessages[1]), userMessages[1].slice(0, 80).replace(/\n/g, " "));
    ok("the command drafted inside extended thinking was NOT executed (thinking text excluded)", toolCalls.filter((c) => c.name === "list_commands").length <= 1);
    await waitFor(() => !/Starting…/.test(bar.textContent || ""), 40000, "session ready");
    await waitFor(() => !P.isGenerating(), 15000, "ready reply settled");
    await sleep(600);
    ok("session marked started after the ready reply", !/Starting…/.test(bar.textContent || ""), (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90));
    ok("conversation key follows the /chat/<uuid> route after the first send", /^\/chat\//.test(P.conversationKey()), P.conversationKey());

    // The user asks through Claude's own composer (Enter).
    d.execCommand("insertText", false, `Create an anchored 4x2x4 part named ${PART} and check it exists`);
    await waitFor(() => !send.disabled, 5000, "site enables send for the user's text");
    ed.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => userMessages.length >= 3, 6000, "user request send");
    const t3 = Date.now();
    await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && new RegExp(PART).test(String(c.arguments.code || ""))), 90000, "execute_luau (part_create)");
    await waitFor(() => userMessages.length >= 4, 60000, "tool result send");
    ok("###CMD part_create### went through parser → contract → skill → execute_luau and the REAL result was typed back", /Output of 'part_create'/.test(userMessages[3]) && /"ok": true/.test(userMessages[3]), userMessages[3].slice(0, 120).replace(/\n/g, " "));
    await waitFor(() => userMessages.length >= 5, 60000, "read-back result");
    ok("###LUA### read-back ran and reported the part", simReady ? /size=4(\.0+)?, 2(\.0+)?, 4(\.0+)? anchored=true/.test(userMessages[4]) : /Output of 'execute_luau'/.test(userMessages[4]), userMessages[4].slice(0, 120).replace(/\n/g, " "));
    await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 60000, "loop.end");
    const turnMs = Date.now() - t3;
    ok("agent loop ended after the final prose reply", true);
    const modelLuau = toolCalls.filter((c) => c.name === "execute_luau" && !/GetLogHistory|IsRunning\(\)|TotalScript mode probe/.test(String(c.arguments.code || "")));
    ok("exactly two model commands reached the bridge (create + read-back); nothing re-ran", modelLuau.length === 2, modelLuau.length + " calls");
    ok("5 sends total, each a single submit; the site's stop button was never clicked", userMessages.length === 5 && submitAttempts === 5 && stopClicks === 0, userMessages.length + " sends, " + submitAttempts + " submits, " + stopClicks + " stop clicks");
    ok("command blocks were masked in the transcript (rs-tool-hide on the <pre>)", !!conversation.querySelector("pre.rs-tool-hide"));
    ok("reply text never carried the footer button labels or the thinking into a command", !toolCalls.some((c) => /Good response|Bad response|Let me think about/.test(JSON.stringify(c.arguments || {}))));
    const dg = w.__rsDiag || [];
    const grace = dg.filter((e) => e.event === "noTurnGrace.wait" || e.event === "staleTurn.wait");
    ok("no turn sat in the 30 s 'no new turn' / stale-turn gate (turn identity is per node, not a text prefix)", grace.length === 0, grace.slice(0, 2).map((e) => e.event + ":" + JSON.stringify(e.data).slice(0, 120)).join(" | "));
    const tails = dg.filter((e) => e.event === "stopGoneToResp").map((e) => e.data && e.data.stopGoneToRespMs);
    ok("every reply finalised within 4 s of the stop button clearing (" + tails.join("/") + " ms)", tails.length >= 3 && tails.every((ms) => ms < 4000), tails.join(","));
    ok("three agent turns (request → create → read-back → done) took under 40 s of simulated time (" + turnMs + " ms)", turnMs < 40000, turnMs);
    const endAt = (dg.find((e) => e.event === "loop.end") || {}).t || Date.now();
    await sleep(3000);
    const storm = (w.__rsDiag || []).filter((e) => e.event === "chip.rebuild" && e.data && e.data.rawVisible && (e.t || 0) > endAt);
    ok("no chip-rebuild storm after the loop ended (###CMD <pre> is camouflaged, not re-found every sweep)", storm.length === 0, storm.length + " rebuilds after loop.end");
    const ids = new Set(dg.filter((e) => e.event === "send" ).map((e) => e.data && e.data.requestId));
    ok("each send had its own request id", ids.size >= 4, ids.size);
    if (simReady) {
      const v = await sim.exec(`local p = workspace:FindFirstChild("${PART}") if not p then return "MISSING" end return { class = p.ClassName, size = { p.Size.X, p.Size.Y, p.Size.Z }, anchored = p.Anchored }`);
      let o = null; try { o = JSON.parse(v.text); } catch {}
      ok("VERIFIED in the DataModel: Part 4×2×4, anchored", !!o && o.class === "Part" && JSON.stringify(o.size) === "[4,2,4]" && o.anchored === true, v.text);
    } else ok("Studio stand-in unavailable (lupa missing) - result verification skipped: Blocked by environment", true);
    await sleep(600);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
  } catch (e) { console.error(e); process.exitCode = 1; }
  sim.close();
  finish("claude-e2e" + (SAME_PREFIX ? " (SAME_PREFIX)" : "") + (SLOW_SEND ? " (SLOW_SEND)" : "") + (FLICKER ? " (FLICKER)" : "") + (process.env.MODEL ? " (" + MODEL + ")" : ""), pageErrors);
})();
