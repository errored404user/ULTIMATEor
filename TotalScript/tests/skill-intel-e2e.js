"use strict";
// Skill Intelligence end-to-end in jsdom (1.88.0): the WHOLE bundle on the
// Gemini-shaped page from gemini-e2e.js, scripted model, PLAIN protocol.
//
//   1. the user asks for a FIX → the task brief AND the expert note
//      ("Specialist: Debug & repair … skill {name: "debug_repair"}") ride on the
//      first tool result; nothing is injected for unrelated turns;
//   2. the model calls `skill {name: debug}` → answered locally from the expert
//      library (full procedure; before 1.88.0 the answer was a one-sentence
//      pack);
//   3. the Prompt Enhancer: rough text → request carries MODE / MUST KEEP /
//      DOMAIN EXPERTISE → the model's rewrite drops a number and flips an
//      exclusion → the checks flag both, the original stays untouched, the
//      edited text is what Send hands over.
//
// MOCKED end to end: no Gemini, no model, no Studio. Optional (needs jsdom):
//   cd TotalScript && npm i --no-save jsdom && node tests/skill-intel-e2e.js
const { createPage, makeReporter, sleep, log } = require("./lib/e2e-page.js");

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
let generating = false, phase = 0, modelScript = null, cancelled = false;
action.addEventListener("click", () => { if (generating) { cancelled = true; return; } submit(); });
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
  log("USER SENT (" + text.length + " chars):", text.slice(0, 90).replace(/\n/g, "\\n"));
  clearEditor();
  const uq = d.createElement("user-query"); uq.setAttribute("data-rect", "760,100,500,44");
  const qt = d.createElement("div"); qt.className = "query-text"; qt.textContent = text; uq.appendChild(qt); history.appendChild(uq);
  setTimeout(() => generate(), 250);
  return true;
}
async function generate() {
  phase++;
  const reply = modelScript ? await modelScript(phase, userMessages[userMessages.length - 1]) : "Okay.";
  const mr = d.createElement("model-response"); mr.setAttribute("data-rect", "300,160,900,240");
  const mc = d.createElement("message-content"); mr.appendChild(mc); history.appendChild(mr);
  generating = true; cancelled = false; icon.setAttribute("fonticon", "stop"); action.setAttribute("aria-label", "Stop response");
  const chunks = reply.match(/[\s\S]{1,48}/g) || [];
  let shown = "";
  for (const ch of chunks) { if (cancelled) break; shown += ch; renderMarkdown(mc, shown); await sleep(12); }
  await sleep(150);
  generating = false; icon.setAttribute("fonticon", "arrow_upward"); action.setAttribute("aria-label", "Send message");
}
async function onToolCall(msg) {
  if (msg.name === "execute_luau") return { ok: true, text: "OK" };
  return null;
}

const { ok, waitFor, finish } = makeReporter();
(async () => {
  try {
    page.loadBundle();
    const P = w.RSProvider, SI = w.TotalSkillIntel;
    ok("TotalSkillIntel is part of the bundle (loaded before main.js)", !!SI && SI.VERSION === "2.0.0" && typeof SI.answer === "function");
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(1200);
    const bar = d.getElementById("rs-bar");
    const startBtn = [...bar.querySelectorAll("button")].find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
    ok("start button present", !!startBtn);
    let enhancerReplyAt = 0;
    modelScript = async (n, last) => {
      if (n === 1) return "Loading the catalogue first.\n```\n###CMD list_commands###\n###END_CMD###\n```";
      if (n === 2) return "Ready. Tell me what to build in Roblox Studio.";
      if (n === 3) return "Let me load the debugging procedure first.\n```\n###CMD skill###\nname: debug\n###END_CMD###\n```";
      if (n === 4) return "Understood - I will reproduce first. Done for now.";
      if (/PROMPT ENHANCER/.test(last || "")) {
        enhancerReplyAt = n;
        // A plausible but flawed rewrite: the number 25 is gone and "no gui" became a GUI requirement.
        return "<<<ENHANCED PROMPT>>>\nGOAL - add a sword tool.\nSCOPE - a Tool in StarterPack with a server-side hitbox dealing damage with a 0.8s cooldown.\nLOOK & FEEL - include a small GUI that shows the cooldown.\nDONE WHEN - the sword damages a dummy in a play-test.\n<<<END ENHANCED PROMPT>>>";
      }
      return "Noted.";
    };
    startBtn.click();
    await waitFor(() => userMessages.length >= 2, 30000, "catalogue reply send");
    await waitFor(() => !/Starting…/.test(bar.textContent || ""), 30000, "session ready");
    await waitFor(() => !P.isGenerating(), 10000, "ready reply settled");
    await sleep(600);
    let skillEntry = null; try { skillEntry = w.eval("RobloxScriptSkills.SKILL_COMMANDS.find((c) => c.name === 'skill')"); } catch {}
    ok("registry entry for `skill` describes the expert library (ids), not the old 'debug|remotes|pathfinding' hint", !!skillEntry && /debug_repair/.test(skillEntry.description) && !/debug\|remotes\|pathfinding/.test(JSON.stringify(skillEntry)), skillEntry && skillEntry.description.slice(0, 80));

    // ── 1+2. a FIX request → expert rider + local `skill` answer ──
    d.execCommand("insertText", false, "fix the DataManager script in ServerScriptService, the output says attempt to index nil with 'Coins'");
    await sleep(80);
    action.click();
    await waitFor(() => userMessages.length >= 3, 6000, "user request send");
    await waitFor(() => userMessages.length >= 4, 40000, "skill result send");
    const res = userMessages[3];
    ok("`skill {name: debug}` was answered from the expert library (alias → debug_repair)", /Output of 'skill':\nSKILL debug_repair — Debug & repair \[roblox\]/.test(res), res.slice(0, 120).replace(/\n/g, " "));
    ok("the answer is the full procedure with real commands and the precedence sentence", /PROCEDURE:\n1\. Get the real symptom: `get_console_output`/.test(res) && /COMMANDS THIS SKILL USES \(all exist in this build\): /.test(res) && /guidance only: nothing ran/.test(res));
    ok("no execute_luau round trip was made for `skill` (answered in the extension)", !toolCalls.some((c) => c.name === "execute_luau" && /skill/.test(String(c.arguments && c.arguments.code || "")) && !/GetLogHistory|IsRunning/.test(String(c.arguments.code || ""))), toolCalls.map((c) => c.name).join(","));
    ok("the task brief rode on the first result (1.69 behaviour intact)", /\(Task brief from TotalScript, not the user\.\) Task: debugging \/ error diagnosis · intent: fix/.test(res));
    ok("the EXPERT note rode next to it: Debug & repair specialist + pointer to the full skill + precedence", /\(Expert note from TotalScript, not the user\.\) Specialist: Debug & repair\./.test(res) && /skill \{name: "debug_repair"\}/.test(res) && /override this note|win over this note/.test(res));
    const dg = () => w.__rsDiag || [];
    ok("diag trail: skill.selected (debug_repair primary) → skill.riderSent within the send budget", dg().some((e) => e.event === "skill.selected" && /debug_repair/.test(JSON.stringify(e.data))) && dg().some((e) => e.event === "skill.riderSent"));
    await waitFor(() => dg().some((e) => e.event === "loop.end"), 30000, "loop.end");

    // ── 3. Prompt Enhancer with the deterministic layer ──
    const E = w.TotalEnhancer;
    ok("TotalEnhancer exposes MODES (auto, quick, expert, deep, creative, debug)", E && Array.isArray(E.MODES) && E.MODES.map((m) => m.id).join(",") === "auto,quick,expert,deep,creative,debug");
    w.__rsOpenEnhancer();
    await sleep(200);
    const host = d.getElementById("rs-enhance");
    ok("enhancer opened with mode chips and the insight line", host && host.classList.contains("open") && host.querySelectorAll(".rse-chip[data-mode]").length === 6 && !!host.querySelector(".rse-insight"));
    const rough = host.querySelector(".rse-rough");
    const ROUGH = "add a sword with 25 damage and a 0.8s cooldown, server authoritative, no gui";
    rough.value = ROUGH; rough.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(500);
    const insight = host.querySelector(".rse-insight").textContent;
    ok("insight (sync, before any AI call): Auto → Expert, Gameplay + Remotes specialists, will keep 25 / 0.8s / no gui", /Mode: Expert \(auto\)/.test(insight) && /Gameplay systems/.test(insight) && /remotes/.test(insight) && /no gui/.test(insight) && /0\.8s/.test(insight), insight.slice(0, 200));
    const sendsBefore = userMessages.length;
    host.querySelector(".rse-go").click();
    await waitFor(() => userMessages.length > sendsBefore, 15000, "enhancer request send");
    const req = userMessages[sendsBefore];
    ok("the rewrite request carries the 1.72 contract AND the new layers: MODE: Expert, MUST KEEP, DOMAIN EXPERTISE", /⟦TotalScript PROMPT ENHANCER⟧ Rewrite the user's rough request/.test(req) && /MODE: Expert - make implied requirements explicit/.test(req) && /MUST KEEP \(found in the rough request; restate each one, never drop or invert\): exclusions: no gui · numbers: 25, 0\.8s\./.test(req) && /DOMAIN EXPERTISE \(use it to make implied requirements explicit/.test(req) && /- Gameplay systems/.test(req));
    ok("expert excerpts are short (whole request under 4 kB) and reference no command names", req.length < 4000 && !/\b[a-z]+_[a-z]+_[a-z]+\b/.test(req.split("DOMAIN EXPERTISE")[1] || ""), req.length);
    await waitFor(() => !!E.state().last, 20000, "enhancer result");
    await sleep(300);
    const st = E.state();
    ok("result landed in the preview; the rough text is untouched", st.result.startsWith("GOAL - add a sword tool.") && st.rough === ROUGH && rough.value === ROUGH);
    ok("checks flagged the dropped number AND the inverted exclusion (gui without a negation)", st.last.checks && st.last.checks.ok === false && st.last.checks.issues.some((i) => i.kind === "numbers" && /25/.test(i.text)) && st.last.checks.issues.some((i) => i.kind === "exclusion" && /gui/.test(i.text)), JSON.stringify(st.last.checks && st.last.checks.issues));
    const checksEl = host.querySelector(".rse-checks");
    ok("checks are shown next to the preview and the status says to review them", checksEl && !checksEl.hidden && /review before sending/.test(checksEl.textContent) && /see the checks/.test(host.querySelector(".rse-status").textContent));
    ok("meta names the mode; experts recorded on the result", /Expert/.test(host.querySelector(".rse-meta").textContent) && st.last.experts.some((x) => x.id === "gameplay_systems"));
    // The user fixes the preview by hand, then Send: the EDITED text goes out.
    const result = host.querySelector(".rse-result");
    result.value = st.result.replace("dealing damage", "dealing 25 damage").replace("LOOK & FEEL - include a small GUI that shows the cooldown.", "CONSTRAINTS - no GUI at all.");
    result.dispatchEvent(new w.Event("input", { bubbles: true }));
    const sends2 = userMessages.length;
    host.querySelector(".rse-send").click();
    await waitFor(() => userMessages.length > sends2, 15000, "enhanced prompt send");
    ok("Send handed over the EDITED prompt (25 damage, no GUI), closed the dialog", /dealing 25 damage/.test(userMessages[sends2]) && /no GUI at all/.test(userMessages[sends2]) && !E.isOpen());
    await sleep(800);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
  } catch (e) { console.error(e); process.exitCode = 1; }
  finish("skill-intel-e2e", pageErrors);
})();
