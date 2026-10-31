"use strict";
// End-to-end simulation of the WHOLE TotalScript bundle on a Gemini-shaped
// page (1.86.0) - the BASELINE provider run through the same harness as the
// repaired ones (vani-e2e; mimo-e2e / clickup-e2e were removed with their providers in 1.89.0), so "parity" has a
// reference measured the same way. Optional (needs jsdom; lupa for Studio):
//
//   cd TotalScript && npm i --no-save jsdom && node tests/gemini-e2e.js
//   CANCEL=1 node tests/gemini-e2e.js   # user presses TotalScript's Stop mid-stream
//   DIAG=1 ...                          # print the [rs-diag] trace
//
// The fake page follows src/providers/gemini.js: <input-area-v2> with a Quill
// .ql-editor (execCommand insertText / insertLineBreak - shimmed here, jsdom
// has no execCommand), ONE action button whose <mat-icon fonticon> flips
// arrow_upward → stop for the whole generation, <user-query> / <model-response>
// turns with <message-content> and <code-block> fences. Gemini has no stream
// tap: the reply is read from the DOM only, which is exactly what the core
// does there. Scripted model, PLAIN protocol: list_commands → ready → ###CMD
// part_create### → ###LUA### read-back → prose. execute_luau runs in the lupa
// DataModel so the Part is VERIFIED.
//
// MOCKED end to end: no Gemini, no model, no Studio.
const { createPage, studioSim, makeReporter, sleep, log } = require("./lib/e2e-page.js");

const CANCEL = !!process.env.CANCEL;
const html = `<!doctype html><html><head><title>Gemini</title></head><body>
<div id="app" data-rect="0,0,1280,800">
  <aside class="sidenav" data-rect="0,0,260,800"><button aria-label="New chat" data-rect="10,10,200,36">New chat</button>
    <div class="conversations" data-rect="10,60,240,500"><div class="conversation" data-rect="10,60,240,32">Earlier chat</div></div></aside>
  <main data-rect="260,0,1020,800">
    <div id="chat-history" class="chat-history" data-rect="260,0,1020,660"></div>
    <input-area-v2 data-rect="300,680,940,100">
      <rich-textarea data-rect="310,690,820,80"><div id="ed" class="ql-editor textarea" contenteditable="true" data-placeholder="Ask Gemini" data-rect="310,690,820,80"><p><br></p></div></rich-textarea>
      <div class="trailing-actions" data-rect="1140,700,90,50">
        <button class="mic-button" aria-label="Use microphone" data-rect="1140,700,40,40"><mat-icon fonticon="mic"></mat-icon></button>
        <button id="action" class="send-button" aria-label="Send message" data-rect="1190,700,40,40"><mat-icon id="action-icon" fonticon="arrow_upward"></mat-icon></button>
      </div>
    </input-area-v2>
  </main>
</div></body></html>`;

const page = createPage({ html, url: "https://gemini.google.com/app", host: "gemini.google.com", onToolCall });
const { w, d, toolCalls, pageErrors } = page;
const sim = studioSim();

// ── Quill stand-in: execCommand into the contenteditable ─────────────────
const ed = d.getElementById("ed"), action = d.getElementById("action"), icon = d.getElementById("action-icon"), history = d.getElementById("chat-history");
const lastP = () => { let p = ed.lastElementChild; if (!p || p.tagName !== "P") { p = d.createElement("p"); ed.appendChild(p); } return p; };
d.execCommand = (cmd, _ui, val) => {
  if (cmd === "insertText") { const p = lastP(); if (p.innerHTML === "<br>") p.innerHTML = ""; p.appendChild(d.createTextNode(String(val))); ed.dispatchEvent(new w.Event("input", { bubbles: true })); return true; }
  if (cmd === "insertLineBreak" || cmd === "insertParagraph") { const p = d.createElement("p"); p.innerHTML = "<br>"; ed.appendChild(p); ed.dispatchEvent(new w.Event("input", { bubbles: true })); return true; }
  if (cmd === "delete" || cmd === "selectAll") { ed.innerHTML = "<p><br></p>"; return true; }
  return false;
};
const editorValue = () => ed.innerText.replace(/\n$/, "");
const clearEditor = () => { ed.innerHTML = "<p><br></p>"; ed.dispatchEvent(new w.Event("input", { bubbles: true })); };

// ── fake Gemini behaviour ────────────────────────────────────────────────
const userMessages = [];
let generating = false, phase = 0, modelScript = null, submitAttempts = 0, cancelled = false;
action.addEventListener("click", () => {
  if (generating) { cancelled = true; return; } // stop icon: abort the stream
  submit();
});
ed.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
function renderMarkdown(c, text) {
  c.innerHTML = "";
  text.split(/```/).forEach((seg, i) => {
    if (i % 2 === 1) {
      const cb = d.createElement("code-block"); const pre = d.createElement("pre"); const code = d.createElement("code");
      code.textContent = seg.replace(/^[a-z]*\n/, ""); pre.appendChild(code); cb.appendChild(pre); c.appendChild(cb);
    } else seg.split("\n").forEach((line) => { if (!line && i === 0) return; const p = d.createElement("p"); p.textContent = line; c.appendChild(p); });
  });
}
function submit() {
  const text = editorValue();
  if (!text.trim() || generating) return false;
  submitAttempts++;
  userMessages.push(text);
  log("USER SENT (" + text.length + " chars):", text.slice(0, 90).replace(/\n/g, "\\n"));
  clearEditor();
  const uq = d.createElement("user-query"); uq.setAttribute("data-rect", "760,100,500,44");
  const qt = d.createElement("div"); qt.className = "query-text"; qt.textContent = text; uq.appendChild(qt); history.appendChild(uq);
  setTimeout(() => generate(), 250);
  return true;
}
async function generate() {
  phase++;
  const reply = modelScript ? await modelScript(phase) : "Okay.";
  const mr = d.createElement("model-response"); mr.setAttribute("data-rect", "300,160,900,240");
  const mc = d.createElement("message-content"); mr.appendChild(mc); history.appendChild(mr);
  generating = true; cancelled = false; icon.setAttribute("fonticon", "stop"); action.setAttribute("aria-label", "Stop response");
  const chunks = reply.match(/[\s\S]{1,24}/g) || [];
  let shown = "";
  for (const ch of chunks) {
    if (cancelled) break;
    shown += ch; renderMarkdown(mc, shown);
    await sleep(phase === 3 && CANCEL ? 120 : 20);
  }
  await sleep(150);
  generating = false; icon.setAttribute("fonticon", "arrow_upward"); action.setAttribute("aria-label", "Send message");
  const tb = d.createElement("div"); tb.className = "response-footer";
  for (const label of ["Good response", "Bad response", "Copy"]) { const b = d.createElement("button"); b.setAttribute("aria-label", label); b.textContent = label; tb.appendChild(b); }
  mr.appendChild(tb);
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
    ok("provider is Gemini (baseline)", P && P.id === "gemini" && P.reliableCounts === true);
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(1200);
    const bar = d.getElementById("rs-bar");
    ok("composer is the Quill editor, send button found by its mat-icon", P.getEditor() === ed && !!P.getEditor() && P.chatIsEmpty());
    const startBtn = [...bar.querySelectorAll("button")].find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
    ok("start button present", !!startBtn);
    modelScript = async (n) => {
      if (n === 1) return "Loading the catalogue first.\n```\n###CMD list_commands###\n###END_CMD###\n```";
      if (n === 2) return "Ready. Tell me what to build in Roblox Studio.";
      if (n === 3) return CANCEL
        ? "Let me think about this at length before acting. " + "The part should be anchored and sized correctly, placed above the origin so it is visible. ".repeat(6) + "\n```\n###CMD part_create###\nname: " + PART + "\nsize: [4, 2, 4]\nposition: [0, 5, 0]\nanchored: true\n###END_CMD###\n```"
        : `Creating the part now.\n\`\`\`\n###CMD part_create###\nname: ${PART}\nsize: [4, 2, 4]\nposition: [0, 5, 0]\nanchored: true\n###END_CMD###\n\`\`\``;
      if (n === 4) return `Checking it.\n\`\`\`\n###LUA###\nlocal p = workspace:FindFirstChild("${PART}")\nif not p then return "MISSING" end\nreturn string.format("%s size=%s anchored=%s", p:GetFullName(), tostring(p.Size), tostring(p.Anchored))\n###END_LUA###\n\`\`\``;
      if (n === 5) return `Done - **${PART}** exists in Workspace, 4×2×4 studs, anchored.`;
      return "Noted.";
    };
    startBtn.click();
    log("clicked Start");
    await waitFor(() => userMessages.length >= 1, 20000, "bootstrap send");
    ok("bootstrap prompt inserted through execCommand and sent once", userMessages.length === 1 && /TotalScript|Roblox/i.test(userMessages[0]), userMessages[0].length + " chars");
    ok("multi-line prompt survived the Quill insertion (paragraph per line)", userMessages[0].split("\n").length > 20);
    await waitFor(() => userMessages.length >= 2, 30000, "catalogue reply send");
    ok("###CMD list_commands### ran and the catalogue was typed back", /Output of 'list_commands'|commands - \d+ total/i.test(userMessages[1]), userMessages[1].slice(0, 80).replace(/\n/g, " "));
    await waitFor(() => !/Starting…/.test(bar.textContent || ""), 30000, "session ready");
    await waitFor(() => !P.isGenerating(), 10000, "ready reply settled");
    await sleep(600);
    ok("session marked started after the ready reply", !/Starting…/.test(bar.textContent || ""), (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90));

    // The user asks through Gemini's own composer.
    d.execCommand("insertText", false, `Create an anchored 4x2x4 part named ${PART} and check it exists`);
    await sleep(80);
    action.click();
    await waitFor(() => userMessages.length >= 3, 6000, "user request send");

    if (CANCEL) {
      // Press TotalScript's Stop while the long reply is still streaming (before the command block has rendered).
      await waitFor(() => P.isGenerating(), 8000, "generation started");
      await sleep(400);
      const stop = [...bar.querySelectorAll("button")].find((b) => /stop/i.test(b.textContent || "") || /stop/i.test(b.getAttribute("aria-label") || "") || /stop/i.test(b.title || ""));
      ok("TotalScript shows its own Stop control during generation", !!stop);
      if (stop) stop.click();
      await waitFor(() => (w.__rsDiag || []).some((e) => /loop\.end|stop/i.test(e.event)), 15000, "loop wound down");
      await sleep(2500);
      ok("the site's generation was stopped (native stop clicked) or finished", !generating || cancelled, { generating, cancelled });
      ok("NO command from the interrupted turn reached the bridge", !toolCalls.some((c) => c.name === "execute_luau" && new RegExp(PART).test(String(c.arguments.code || ""))), toolCalls.map((c) => c.name));
      ok("no tool result was typed back after Stop (3 sends total: bootstrap, catalogue, request)", userMessages.length === 3, userMessages.length);
      // "Agent running - N tools" on the bar is the SESSION label (started); since 1.87.0 it carries the loop phase too.
      const barTxt = (bar.textContent || "").replace(/\s+/g, " ");
      ok("the bar says the loop is stopped / idle after Stop (not 'running a command' / 'waiting for the AI')", /Agent running[^·]*· (stopped|idle|stopping)/.test(barTxt) && !/waiting for the AI|running a command|running execute_luau/.test(barTxt), barTxt.slice(0, 160));
      const dg = w.__rsDiag || [];
      ok("loop wound down after Stop (stopLoop → response:stopped → loop.end, final snapshot run:false)", dg.some((e) => e.event === "stopLoop") && dg.some((e) => e.event === "response" && e.data && e.data.kind === "stopped") && dg.some((e) => e.event === "loop.end") && dg[dg.length - 1].snap && dg[dg.length - 1].snap.run === false, dg.slice(-4).map((e) => e.event + ":" + (e.snap && e.snap.run)));
      ok("Stop was not re-run by the auto-resume watchdog within 2.5 s (userStopped honoured)", !dg.some((e) => /autoResume|resume\./.test(e.event) && e.t > (dg.find((x) => x.event === "stopLoop") || {}).t), dg.filter((e) => /resume/i.test(e.event)).map((e) => e.event));
      if (simReady) {
        const v = await sim.exec(`return workspace:FindFirstChild("${PART}") and "EXISTS" or "MISSING"`);
        ok("VERIFIED in the DataModel: nothing was created", v.text === "MISSING", v.text);
      }
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
      sim.close();
      return finish("gemini-e2e (CANCEL)", pageErrors);
    }

    await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && new RegExp(PART).test(String(c.arguments.code || ""))), 60000, "execute_luau (part_create)");
    await waitFor(() => userMessages.length >= 4, 40000, "tool result send");
    ok("###CMD part_create### went through parser → contract → skill → execute_luau and the REAL result was typed back", /Output of 'part_create'/.test(userMessages[3]) && /"ok": true/.test(userMessages[3]), userMessages[3].slice(0, 120).replace(/\n/g, " "));
    await waitFor(() => userMessages.length >= 5, 40000, "read-back result");
    ok("###LUA### read-back ran and reported the part", simReady ? /size=4(\.0+)?, 2(\.0+)?, 4(\.0+)? anchored=true/.test(userMessages[4]) : /Output of 'execute_luau'/.test(userMessages[4]), userMessages[4].slice(0, 120).replace(/\n/g, " "));
    await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
    ok("agent loop ended after the final prose reply", true);
    const modelLuau = toolCalls.filter((c) => c.name === "execute_luau" && !/GetLogHistory|IsRunning\(\)|TotalScript mode probe/.test(String(c.arguments.code || "")));
    ok("exactly two model commands reached the bridge (create + read-back); nothing re-ran", modelLuau.length === 2, modelLuau.length + " calls");
    ok("5 sends total, each a single submit", userMessages.length === 5 && submitAttempts === 5, userMessages.length + " sends, " + submitAttempts + " submits");
    ok("command blocks were masked in the transcript (rs-tool-hide on code-block)", !!history.querySelector("code-block.rs-tool-hide"));
    ok("reply text never carried the footer button labels into a command", !toolCalls.some((c) => /Good response|Bad response/.test(JSON.stringify(c.arguments || {}))));
    if (simReady) {
      const v = await sim.exec(`local p = workspace:FindFirstChild("${PART}") if not p then return "MISSING" end return { class = p.ClassName, size = { p.Size.X, p.Size.Y, p.Size.Z }, anchored = p.Anchored }`);
      let o = null; try { o = JSON.parse(v.text); } catch {}
      ok("VERIFIED in the DataModel: Part 4×2×4, anchored", !!o && o.class === "Part" && JSON.stringify(o.size) === "[4,2,4]" && o.anchored === true, v.text);
    } else ok("Studio stand-in unavailable (lupa missing) - result verification skipped: Blocked by environment", true);
    await sleep(600);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
  } catch (e) { console.error(e); process.exitCode = 1; }
  sim.close();
  finish("gemini-e2e", pageErrors);
})();
