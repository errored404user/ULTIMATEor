"use strict";
// 1.99.0 - Gentle-mode e2e: the WHOLE bundle on the Gemini-shaped harness page
// with a provider that publishes a P.pacing contract (what deepseek.js ships).
// Verifies, end to end and without any real site:
//   G1 automatic sends are held to the pacing gap (diag send.paced reason=gap,
//      measured gaps between consecutive automatic user messages >= minGapMs),
//      while the user's own message is not budget-blocked.
//   G2 an ACCOUNT suspension notice (the DeepSeek wording) stops the loop at
//      once: classified account_block, no re-send, a banner names the date.
//   G3 the pacing switch (window.__rsGentlePacing) turns the pacing off.
// MOCKED end to end: no DeepSeek, no model, no Studio (canned OK results).
//   cd TotalScript && NODE_PATH=... node tests/gentle-e2e.js   (DIAG=1 for the trace)
const { createPage, makeReporter, sleep, log } = require("./lib/e2e-page.js");
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
const page = createPage({ html, url: "https://gemini.google.com/app", host: "gemini.google.com", onToolCall: async () => ({ ok: true, text: "OK" }) });
const { w, d, pageErrors } = page;
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
const userMessages = [], userTimes = [];
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
  userMessages.push(text); userTimes.push(Date.now());
  log("USER SENT (" + text.length + " chars):", text.slice(0, 90).replace(/\n/g, "\\n"));
  clearEditor();
  const uq = d.createElement("user-query"); uq.setAttribute("data-rect", "760,100,500,44");
  const qt = d.createElement("div"); qt.className = "query-text"; qt.textContent = text; uq.appendChild(qt); history.appendChild(uq);
  setTimeout(() => generate(), 200);
  return true;
}
async function generate() {
  phase++;
  const reply = modelScript ? await modelScript(phase, userMessages[userMessages.length - 1]) : "Okay.";
  log("MODEL #" + phase + ":", reply.slice(0, 80).replace(/\n/g, "\\n"));
  const mr = d.createElement("model-response"); mr.setAttribute("data-rect", "300,160,900,240");
  const mc = d.createElement("message-content"); mr.appendChild(mc); history.appendChild(mr);
  generating = true; icon.setAttribute("fonticon", "stop"); action.setAttribute("aria-label", "Stop response");
  const chunks = reply.match(/[\s\S]{1,40}/g) || [];
  let shown = "";
  for (const ch of chunks) { shown += ch; renderMarkdown(mc, shown); await sleep(12); }
  await sleep(150);
  generating = false; icon.setAttribute("fonticon", "arrow_upward"); action.setAttribute("aria-label", "Send message");
}
const cmd = (name, body) => "```\n###CMD " + name + "###\n" + body + "\n###END_CMD###\n```";
const { ok, waitFor, finish } = makeReporter();
async function ask(text) { d.execCommand("insertText", false, text); await sleep(60); action.click(); }
const diags = (name, t0) => (w.__rsDiag || []).filter((e) => e.event === name && e.t >= t0);
async function untilLoopEnds(label, ms = 60000) {
  const t0 = Date.now();
  try { await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end" && e.t >= t0), ms, label); }
  catch (e) { console.log("[harness] diag tail:", JSON.stringify((w.__rsDiag || []).filter((x) => !/^chip\.|^sweep|^mask|^hide/.test(x.event)).slice(-25).map((x) => [x.event, x.data && JSON.stringify(x.data).slice(0, 80)]))); throw e; }
  await sleep(300);
}
const SUSPENDED = "Due to violation of user policies, your account has been suspended until September 20, 2026 02:55.";
(async () => {
  try {
    page.loadBundle();
    const P = w.RSProvider;
    // the contract deepseek.js ships, with a short gap so the test stays fast
    const GAP = 1500;
    P.pacing = { minGapMs: GAP, maxGapMs: GAP, perHour: 100, noResend: true, label: "Test gentle mode", apiHint: "Use the API." };
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(1000);
    const bar = d.getElementById("rs-bar");
    const startBtn = [...bar.querySelectorAll("button")].find((b) => /start/i.test(b.textContent || "") || b.id === "rs-start");
    const stage = { name: "boot", step: 0 };
    modelScript = async (n) => {
      if (n === 1) return "Loading.\n```\n###CMD list_commands###\n###END_CMD###\n```";
      if (n === 2) return "Ready.";
      if (stage.name === "G1") {
        stage.step++;
        if (stage.step <= 3) return "Step " + stage.step + ".\n" + cmd("part_create", "name: Gentle" + stage.step + "\nanchored: true");
        return "Done - three parts.";
      }
      if (stage.name === "G2") { await sleep(2500); stage.step++; return "Thinking.\n" + cmd("part_create", "name: Blocked\nanchored: true"); }
      if (stage.name === "G3") {
        stage.step++;
        if (stage.step <= 2) return "Fast " + stage.step + ".\n" + cmd("part_create", "name: Fast" + stage.step + "\nanchored: true");
        return "Done.";
      }
      return "Noted.";
    };
    const tBoot = Date.now();
    startBtn.click();
    await waitFor(() => userMessages.length >= 2, 30000, "catalogue reply send");
    await waitFor(() => !/Starting…/.test(bar.textContent || ""), 30000, "session ready");
    await waitFor(() => !P.isGenerating(), 10000, "ready reply settled");
    await sleep(500);
    const bootBanners = [...d.querySelectorAll(".rs-banner")].map((b) => b.className + ": " + (b.textContent || ""));
    ok("boot: the first (user) send is not budget-blocked and the notice banner appeared once", userMessages.length >= 2 && bootBanners.filter((t) => /paces its automatic messages/.test(t)).length === 1, JSON.stringify({ sends: userMessages.length, banners: bootBanners }));
    ok("boot: notice flag stored (rsGentleNoticeShown) so it shows once per install", !!page.storage.rsGentleNoticeShown);
    d.querySelectorAll(".rs-banner .rs-banner-x").forEach((b) => b.click());
    const sendsBoot = userMessages.length;

    // ── G1: automatic sends are paced ──
    stage.name = "G1"; stage.step = 0;
    const t1 = Date.now();
    await ask("Create three anchored parts");
    await untilLoopEnds("G1 loop", 90000);
    const auto = userTimes.slice(sendsBoot + 1); // the tool results (after the user's message)
    const gaps = auto.map((t, i) => t - (i === 0 ? userTimes[sendsBoot] : auto[i - 1]));
    const paced = diags("send.paced", t1);
    ok("G1 three tool results went out and each was paced (diag send.paced reason=gap)", auto.length === 3 && paced.length >= 3 && paced.every((e) => e.data && e.data.reason === "gap"), JSON.stringify({ auto: auto.length, paced: paced.map((e) => e.data) }));
    ok("G1 measured gaps between consecutive sends >= minGapMs (" + GAP + " ms)", gaps.length === 3 && gaps.every((g) => g >= GAP - 50), JSON.stringify(gaps));
    ok("G1 the run still completed (3 steps, final prose)", stage.step === 4 && /Done - three parts/.test(history.textContent || ""), stage.step);

    // ── G2: account suspension notice stops the loop cold ──
    stage.name = "G2"; stage.step = 0;
    const realScan = P.scanError;
    const t2 = Date.now(), sends2 = userMessages.length;
    await ask("Create a part named Blocked");
    await sleep(GAP + 400); // the user's message is out; the site now shows the suspension
    P.scanError = () => SUSPENDED;
    await untilLoopEnds("G2 loop", 60000);
    P.scanError = realScan;
    const blk = diags("loop.accountBlock", t2);
    ok("G2 classified as account_block and the loop ended (diag loop.accountBlock with the parsed until-date)", blk.length === 1 && blk[0].data && new Date(blk[0].data.until).getUTCFullYear() === 2026, JSON.stringify(blk.map((e) => e.data)));
    ok("G2 nothing was re-sent after the notice: exactly one user message (the request) in this scenario, no deadRetry / providerRetry", userMessages.length - sends2 === 1 && diags("loop.deadRetry", t2).length === 0 && diags("loop.providerRetry", t2).length === 0, userMessages.length - sends2);
    const banner = [...d.querySelectorAll(".rs-banner")].map((b) => b.textContent || "").join(" | ");
    ok("G2 banner names the block, the date and the API route; no generic 'request failed'", /blocked this account until/.test(banner) && /2026/.test(banner) && /Use the API\./.test(banner) && !/request failed/.test(banner), banner.slice(0, 200));
    d.querySelectorAll(".rs-banner .rs-banner-x").forEach((b) => b.click());

    // ── G3: the switch turns pacing off ──
    w.__rsGentlePacing = () => false;
    stage.name = "G3"; stage.step = 0;
    const t3 = Date.now();
    await ask("Create two parts fast");
    await untilLoopEnds("G3 loop", 60000);
    ok("G3 with Gentle pacing OFF no send is paced and the run completes", diags("send.paced", t3).length === 0 && stage.step === 3, JSON.stringify({ paced: diags("send.paced", t3).length, step: stage.step }));
    w.__rsGentlePacing = () => true;

    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
    log("sends:", userMessages.length, "boot:", sendsBoot, "elapsed:", Date.now() - tBoot, "ms");
  } catch (e) { console.error(e); process.exitCode = 1; }
  finish("gentle-e2e", pageErrors);
})();
