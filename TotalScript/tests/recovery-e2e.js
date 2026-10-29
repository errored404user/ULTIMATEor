"use strict";
// 1.97.0 - Recovery e2e: the WHOLE bundle on a Gemini-shaped page (DOM-only
// provider, plain ###CMD### protocol) with a FAULT-INJECTING bridge. One
// session, four user requests, each exercising one failure category the shared
// core must handle for EVERY provider:
//   A. mutating command TIMES OUT after the request reached the bridge
//      (sent:true) -> the model is told it MAY have run, an identical resend is
//      held once, a read-back clears the hold, the next resend runs.
//   B. contract rejection (invalid Enum.Material) -> nothing reaches the bridge,
//      the feedback names the parameter + allowed values, the corrected call runs.
//   C. batch of 3 where step 2 fails -> steps 1 ran, 3 NOT RUN, model resends only 3.
//   D. bridge offline (sent:false) -> feedback says it did NOT run; identical
//      retries are budgeted (TRANSIENT_BUDGET) and the 6th is blocked.
// MOCKED end to end: no Gemini, no model, no Studio (lupa sim when available).
//   cd TotalScript && NODE_PATH=... node tests/recovery-e2e.js   (DIAG=1 for the trace)
const { createPage, studioSim, makeReporter, sleep, log } = require("./lib/e2e-page.js");
const html = `<!doctype html><html><head><title>Gemini</title></head><body>
<div id="app" data-rect="0,0,1280,800">
  <aside class="sidenav" data-rect="0,0,260,800"><button aria-label="New chat" data-rect="10,10,200,36">New chat</button></aside>
  <main data-rect="260,0,1020,800">
    <div id="chat-history" class="chat-history" data-rect="260,0,1020,660"></div>
    <input-area-v2 data-rect="300,680,940,100">
      <rich-textarea data-rect="310,690,820,80"><div id="ed" class="ql-editor textarea" contenteditable="true" data-placeholder="Ask Gemini" data-rect="310,690,820,80"><p><br></p></div></rich-textarea>
      <div class="trailing-actions" data-rect="1140,700,90,50">
        <button id="action" class="send-button" aria-label="Send message" data-rect="1190,700,40,40"><mat-icon id="action-icon" fonticon="arrow_upward"></mat-icon></button>
      </div>
    </input-area-v2>
  </main>
</div></body></html>`;
const page = createPage({ html, url: "https://gemini.google.com/app", host: "gemini.google.com", onToolCall });
const { w, d, toolCalls, pageErrors } = page;
const sim = studioSim();
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
const userMessages = [];
let generating = false, phase = 0, modelScript = null;
action.addEventListener("click", () => { if (generating) return; submit(); });
ed.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
function renderMarkdown(c, text) {
  c.innerHTML = "";
  text.split(/```/).forEach((seg, i) => {
    if (i % 2 === 1) { const cb = d.createElement("code-block"); const pre = d.createElement("pre"); const code = d.createElement("code"); code.textContent = seg.replace(/^[a-z]*\n/, ""); pre.appendChild(code); cb.appendChild(pre); c.appendChild(cb); }
    else seg.split("\n").forEach((line) => { if (!line && i === 0) return; const p = d.createElement("p"); p.textContent = line; c.appendChild(p); });
  });
}
function submit() {
  const text = editorValue();
  if (!text.trim() || generating) return false;
  userMessages.push(text);
  log("USER SENT (" + text.length + " chars):", text.slice(0, 110).replace(/\n/g, "\\n"));
  clearEditor();
  const uq = d.createElement("user-query"); uq.setAttribute("data-rect", "760,100,500,44");
  const qt = d.createElement("div"); qt.className = "query-text"; qt.textContent = text; uq.appendChild(qt); history.appendChild(uq);
  setTimeout(() => generate(), 200);
  return true;
}
async function generate() {
  phase++;
  const reply = modelScript ? await modelScript(phase, userMessages[userMessages.length - 1]) : "Okay.";
  log("MODEL #" + phase + ":", reply.slice(0, 90).replace(/\n/g, "\\n"));
  const mr = d.createElement("model-response"); mr.setAttribute("data-rect", "300,160,900,240");
  const mc = d.createElement("message-content"); mr.appendChild(mc); history.appendChild(mr);
  generating = true; icon.setAttribute("fonticon", "stop"); action.setAttribute("aria-label", "Stop response");
  const chunks = reply.match(/[\s\S]{1,40}/g) || [];
  let shown = "";
  for (const ch of chunks) { shown += ch; renderMarkdown(mc, shown); await sleep(12); }
  await sleep(150);
  generating = false; icon.setAttribute("fonticon", "arrow_upward"); action.setAttribute("aria-label", "Send message");
}
// ── fault-injecting Studio stand-in ──
const faults = { timeoutOnce: true, offline: false };
async function onToolCall(msg) {
  if (faults.offline) return { ok: false, kind: "disconnected", errorCode: "STUDIO_BRIDGE_OFFLINE", error: "Roblox Studio MCP is not reachable. Open Studio, enable its bridge, and retry.", sent: false };
  if (msg.name === "script_read") return { ok: false, kind: "execution", errorCode: "SCRIPT_NOT_FOUND", error: "Nope is not a valid member of Workspace \"Workspace\"" };
  if (msg.name !== "execute_luau") return null;
  const code = String(msg.arguments && msg.arguments.code || "");
  // the skill-generated create (long) times out once; the model's own one-line read-back never does
  if (/RecoveryA/.test(code) && !/^return workspace:FindFirstChild/.test(code.trim()) && faults.timeoutOnce) { faults.timeoutOnce = false; return { ok: false, kind: "timeout", errorCode: "STUDIO_TIMEOUT", error: "bridge did not respond in time", sent: true }; }
  if (!sim.available()) return { ok: true, text: "OK (studio sim unavailable)" };
  const r = await sim.exec(code);
  return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.text, text: r.text };
}
const cmd = (name, body) => "```\n###CMD " + name + "###\n" + body + "\n###END_CMD###\n```";
const partA = cmd("part_create", "name: RecoveryA\nsize: [2, 2, 2]\nposition: [0, 5, 0]\nanchored: true");
const { ok, waitFor, finish } = makeReporter();
const lastUser = () => userMessages[userMessages.length - 1] || "";
const luau = () => toolCalls.filter((c) => c.name === "execute_luau" && !/GetLogHistory|IsRunning\(\)/.test(String(c.arguments.code || "")));
async function ask(text) { d.execCommand("insertText", false, text); await sleep(60); action.click(); }
async function untilLoopEnds(label) {
  const t0 = Date.now(); // the diag buffer is capped (chip events flood it) - match by time, never by count
  try { await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end" && e.t >= t0), 60000, label); }
  catch (e) { console.log("[harness] diag tail:", JSON.stringify((w.__rsDiag || []).filter((x) => !/^chip\.|^sweep|^mask|^hide/.test(x.event)).slice(-30).map((x) => [x.event, x.data && JSON.stringify(x.data).slice(0, 80)]))); throw e; }
  await sleep(300);
}
(async () => {
  try {
    const simReady = await sim.ready();
    log("studio sim:", simReady ? "lupa DataModel" : "UNAVAILABLE (canned OK)");
    page.loadBundle();
    const P = w.RSProvider;
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(1000);
    const bar = d.getElementById("rs-bar");
    const startBtn = [...bar.querySelectorAll("button")].find((b) => /start/i.test(b.textContent || "") || b.id === "rs-start");
    const stage = { name: "boot" };
    modelScript = async (n, last) => {
      if (n === 1) return "Loading.\n```\n###CMD list_commands###\n###END_CMD###\n```";
      if (n === 2) return "Ready.";
      // ── A: timeout, hold, read-back, resend ──
      if (stage.name === "A") {
        if (stage.step === 0) { stage.step = 1; return "Creating it.\n" + partA; }
        if (stage.step === 1) { stage.step = 2; stage.fb1 = last; return "Retrying the same call.\n" + partA; }
        if (stage.step === 2) { stage.step = 3; stage.fb2 = last; return "Reading back first.\n```\n###LUA###\nreturn workspace:FindFirstChild(\"RecoveryA\") and \"EXISTS\" or \"MISSING\"\n###END_LUA###\n```"; }
        if (stage.step === 3) { stage.step = 4; stage.fb3 = last; return "It is missing, creating it now.\n" + partA; }
        stage.fb4 = last; return "Done - RecoveryA exists.";
      }
      if (stage.name === "B") {
        if (stage.step === 0) { stage.step = 1; return "Creating.\n" + cmd("part_create", "name: RecoveryB\nmaterial: Shiny\nanchored: true"); }
        if (stage.step === 1) { stage.step = 2; stage.fb1 = last; return "Fixing the material.\n" + cmd("part_create", "name: RecoveryB\nmaterial: Neon\nanchored: true"); }
        stage.fb2 = last; return "Done - RecoveryB is Neon.";
      }
      if (stage.name === "C") {
        if (stage.step === 0) { stage.step = 1; return "Three parts.\n" + cmd("part_create", "name: RecoveryC1") + "\n" + cmd("script_read", "path: game.Workspace.Nope.Script") + "\n" + cmd("part_create", "name: RecoveryC3"); }
        if (stage.step === 1) { stage.step = 2; stage.fb1 = last; return "Resending only the third.\n" + cmd("part_create", "name: RecoveryC3"); }
        stage.fb2 = last; return "Done.";
      }
      if (stage.name === "D") {
        stage.step++; // step n: the (n-1)th feedback arrives, the nth identical attempt goes out
        if (stage.step <= 8) { if (stage.step > 1) stage["fb" + (stage.step - 1)] = last; return "Trying again.\n" + cmd("part_create", "name: RecoveryD"); }
        stage.fbEnd = last; return "Studio is offline - I stopped; please reconnect the bridge.";
      }
      return "Noted.";
    };
    startBtn.click();
    await waitFor(() => userMessages.length >= 2, 30000, "catalogue reply send");
    await waitFor(() => !/Starting…/.test(bar.textContent || ""), 30000, "session ready");
    await waitFor(() => !P.isGenerating(), 10000, "ready reply settled");
    await sleep(500);
    const sendsBoot = userMessages.length;

    // ── A ──
    stage.name = "A"; stage.step = 0;
    await ask("Create an anchored 2x2x2 part named RecoveryA");
    await untilLoopEnds("scenario A loop");
    ok("A1 timeout feedback: ERROR STUDIO_TIMEOUT, says the request reached the bridge and MAY have run, tells the model to read the state back", /ERROR STUDIO_TIMEOUT/.test(stage.fb1) && /MAY have run|may have run/i.test(stage.fb1) && /read|inspect/i.test(stage.fb1) && !/did NOT run|was not sent/i.test(stage.fb1), (stage.fb1 || "").slice(0, 300));
    ok("A1b [diagnosis] names the category as uncertain", /\[diagnosis\] timeout \(uncertain/.test(stage.fb1), (stage.fb1 || "").match(/\[diagnosis\][^\n]*/)?.[0]);
    ok("A2 identical resend was HELD by the loop guard (NOT RUN, read the state back) and did not reach the bridge", /\[LOOP GUARD\] NOT RUN/.test(stage.fb2) && /MAY have run/.test(stage.fb2), (stage.fb2 || "").slice(-260));
    const aCalls = luau().filter((c) => /RecoveryA/.test(String(c.arguments.code)));
    ok("A3 read-back ran (MISSING) and the following resend executed: exactly 3 RecoveryA bridge calls (timed-out create, read-back, create)", aCalls.length === 3 && /MISSING/.test(stage.fb3) && /Output of 'part_create'/.test(stage.fb4) && !/LOOP GUARD/.test(stage.fb4), { calls: aCalls.length, fb3: (stage.fb3 || "").slice(0, 80), fb4: (stage.fb4 || "").slice(0, 80) });
    if (simReady) { const v = await sim.exec(`return workspace:FindFirstChild("RecoveryA") and "EXISTS" or "MISSING"`); ok("A4 VERIFIED in the DataModel: RecoveryA exists exactly once", v.text === "EXISTS", v.text); }

    // ── B ──
    stage.name = "B"; stage.step = 0;
    await ask("Create a part named RecoveryB with a shiny material");
    await untilLoopEnds("scenario B loop");
    ok("B1 invalid enum rejected BEFORE the bridge: feedback names material + Neon among the allowed values, no bridge call carried 'Shiny'", /ERROR/.test(stage.fb1) && /material/i.test(stage.fb1) && /Neon/.test(stage.fb1) && !luau().some((c) => /Shiny/.test(String(c.arguments.code))), (stage.fb1 || "").slice(0, 300));
    ok("B2 corrected call ran and succeeded", /Output of 'part_create'/.test(stage.fb2) && !/^ERROR/.test(stage.fb2), (stage.fb2 || "").slice(0, 120));
    if (simReady) { const v = await sim.exec(`local p = workspace:FindFirstChild("RecoveryB") return p and tostring(p.Material) or "MISSING"`); ok("B3 VERIFIED: RecoveryB material is Neon", /Neon/.test(v.text), v.text); }

    // ── C ──
    stage.name = "C"; stage.step = 0;
    await ask("Create RecoveryC1, read a script, create RecoveryC3");
    await untilLoopEnds("scenario C loop");
    ok("C1 batch result: '2 of 3 commands ran (1 ok, step 2 failed)', step 2 failed, part_create NOT RUN, instruction to resend only the remaining", /2 of 3 commands ran \(1 ok, step 2 failed\)/.test(stage.fb1) && /step 2 failed/.test(stage.fb1) && /NOT RUN: part_create/.test(stage.fb1), (stage.fb1 || "").slice(0, 300));
    ok("C2 only the third command was resent and ran; RecoveryC1 was created once, never twice", /Output of 'part_create'/.test(stage.fb2) && luau().filter((c) => /RecoveryC1/.test(String(c.arguments.code))).length === 1 && luau().filter((c) => /RecoveryC3/.test(String(c.arguments.code))).length === 1, { c1: luau().filter((c) => /RecoveryC1/.test(String(c.arguments.code))).length, c3: luau().filter((c) => /RecoveryC3/.test(String(c.arguments.code))).length });

    // ── D ──
    stage.name = "D"; stage.step = 0; faults.offline = true;
    const dCalls0 = toolCalls.length, tD0 = Date.now();
    await ask("Create a part named RecoveryD");
    await untilLoopEnds("scenario D loop");
    faults.offline = false;
    ok("D1 offline feedback: STUDIO_BRIDGE_OFFLINE, says the command did NOT run (nothing was sent), classified backend_unavailable", /ERROR STUDIO_BRIDGE_OFFLINE/.test(stage.fb1) && /did NOT run|not run|nothing ran/i.test(stage.fb1) && /\[diagnosis\] backend_unavailable/.test(stage.fb1), (stage.fb1 || "").slice(0, 300));
    const dBridge = toolCalls.slice(dCalls0).filter((c) => c.name === "execute_luau" && /RecoveryD/.test(String(c.arguments.code))).length;
    ok("D2 identical offline retries are budgeted: at most 5 reached the bridge, the 6th was blocked with 'stop retrying, tell the user'", dBridge <= 5 && [stage.fb6, stage.fb7, stage.fbEnd].some((t) => /\[LOOP GUARD\] NOT RUN[^\n]*(stop retrying|budget)/i.test(t || "")), { bridgeCalls: dBridge, fb6: (stage.fb6 || "").slice(-200) });
    ok("D3 every offline feedback carried a [SYSTEM_STATE] tag so the model sees BRIDGE DOWN", [stage.fb1, stage.fb2, stage.fb3].every((t) => /\[SYSTEM_STATE:/.test(t || "")), [stage.fb1, stage.fb2, stage.fb3].map((t) => (t || "").match(/\[SYSTEM_STATE:[^\]]*/)?.[0]?.slice(0, 60)));
    ok("D4 the loop did not stall: all 8 identical attempts + the final prose were answered within the scenario (no duplicate-submit suppression on identical feedback)", stage.step >= 9 && !(w.__rsDiag || []).some((e) => e.event === "send.duplicateSuppressed" && e.t >= tD0), { step: stage.step });

    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
    log("sends:", userMessages.length, "boot:", sendsBoot, "bridge calls:", toolCalls.length);
  } catch (e) { console.error(e); process.exitCode = 1; }
  sim.close();
  finish("recovery-e2e", pageErrors);
})();
