"use strict";
// End-to-end simulation of the WHOLE TotalScript bundle on a Vani-Chat-shaped
// page (1.85.0). Optional (needs jsdom; lupa for the Studio stand-in):
//
//   cd TotalScript && npm i --no-save jsdom && node tests/vani-e2e.js
//   CLOSED=1 node tests/vani-e2e.js   # no composer (landing page): bar warns, nothing sent
//   DIAG=1 ...                        # print the [rs-diag] trace
//
// The fake page follows what the adapter documents about c.vani.ai (a Next.js
// guest chat: one "Message" textarea in a form with a submit button, a model
// picker, a marketing sidebar with "Log in" that is NOT a gate, user bubbles
// right-aligned, assistant markdown left-aligned, NO role attributes) and what
// tests/test-vani-net.js documents about its network protocol (POST
// /api/public/chat, SSE `content.delta` / `message.complete`). The reply
// streams through the REAL MAIN-world tap (stream-net.js) and the REAL request
// shaper (vani-net.js); the DOM mirrors it a beat later like the site does.
// Acceptance happens SLOWLY on purpose (1.2 s before the composer clears) -
// the duplicate-submit regression of the pre-1.85 adapters.
//
// The scripted model answers in the PLAIN (non-JSON) protocol only: a
// ###CMD list_commands### bootstrap, ###CMD part_create### for the request,
// a ###LUA### read-back, then prose. execute_luau runs in the lupa
// miniature DataModel (tests/lib/studio_sim.py) so the Part is VERIFIED to
// exist with the requested size, anchored - not a canned OK.
//
// MOCKED end to end: no Vani, no model, no Studio.
const { createPage, studioSim, sse, makeReporter, sleep, log } = require("./lib/e2e-page.js");

const CLOSED = !!process.env.CLOSED;
const composer = `
    <form id="composer" class="composer rounded-3xl border" data-rect="320,690,900,90">
      <textarea id="ed" name="message" placeholder="Message" rows="1" data-rect="330,700,780,60"></textarea>
      <button type="button" id="model" aria-haspopup="listbox" data-rect="330,765,160,24">OpenAI GPT-6 Luna</button>
      <div id="actions" data-rect="1160,700,50,50">
        <button type="submit" id="send" aria-label="Send message" disabled data-rect="1160,700,44,44"><svg></svg></button>
      </div>
    </form>`;
const html = `<!doctype html><html><head><title>Vani Chat</title></head><body>
<div id="__next" data-rect="0,0,1280,800">
  <aside class="sidebar" data-rect="0,0,260,800">
    <button data-rect="10,10,200,36">New chat</button>
    <div class="promo" data-rect="10,600,240,120"><p>Sign up for free</p><a href="/login" data-rect="10,700,80,24">Log in</a><p>See plans and pricing</p></div>
  </aside>
  <main data-rect="260,0,1020,800">
    <div id="thread" class="messages flex flex-col gap-4" data-rect="260,0,1020,670"></div>
    ${CLOSED ? '<div class="landing" data-rect="300,200,900,200"><h1>Vani</h1><p>The best AI models in one place.</p><a href="/c">Try Vani</a></div>' : composer}
  </main>
</div></body></html>`;

const page = createPage({ html, url: CLOSED ? "https://c.vani.ai/" : "https://c.vani.ai/c", host: "c.vani.ai", onToolCall });
const { w, d, toolCalls, pageErrors } = page;
const sim = studioSim();

// ── fake Vani behaviour ──────────────────────────────────────────────────
const ACCEPT_DELAY = 1200; // server round trip before the composer clears
const userMessages = [], requests = [];
let generating = false, stopBtn = null, phase = 0, modelScript = null;
const ed = d.getElementById("ed"), send = d.getElementById("send"), thread = d.getElementById("thread"), actions = d.getElementById("actions"), form = d.getElementById("composer");
if (ed) {
  ed.addEventListener("input", () => { send.disabled = !ed.value.trim() || generating; });
  ed.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  send.addEventListener("click", (e) => { e.preventDefault(); if (!send.disabled) submit(); });
}
function row(role) {
  const r = d.createElement("div");
  r.className = role === "user" ? "flex justify-end" : "flex justify-start";
  r.setAttribute("data-rect", role === "user" ? "720,100,540,44" : "300,160,900,220");
  const c = d.createElement("div");
  c.className = role === "user" ? "rounded-2xl bg-primary px-4 py-2 whitespace-pre-wrap" : "prose prose-invert max-w-none";
  r.appendChild(c); thread.appendChild(r);
  return c;
}
function renderMarkdown(c, text) {
  c.innerHTML = "";
  text.split(/```/).forEach((seg, i) => {
    if (i % 2 === 1) {
      const pre = d.createElement("pre"); const header = d.createElement("div"); header.className = "code-header"; header.textContent = "text"; const copy = d.createElement("button"); copy.textContent = "Copy"; header.appendChild(copy); pre.appendChild(header);
      const code = d.createElement("code"); code.textContent = seg.replace(/^[a-z]*\n/, ""); pre.appendChild(code); c.appendChild(pre);
    } else seg.split("\n").forEach((line) => { if (!line && i === 0) return; const p = d.createElement("p"); p.textContent = line; c.appendChild(p); });
  });
}
function startGenerating() {
  generating = true; send.disabled = true; send.style.display = "none";
  stopBtn = d.createElement("button"); stopBtn.type = "button"; stopBtn.setAttribute("aria-label", "Stop generating"); stopBtn.setAttribute("data-rect", "1160,700,44,44"); stopBtn.innerHTML = "<svg><rect/></svg>";
  actions.appendChild(stopBtn);
}
function stopGenerating(c) {
  generating = false; if (stopBtn) stopBtn.remove(); stopBtn = null; send.style.display = "";
  const tb = d.createElement("div"); tb.className = "actions flex gap-2";
  for (const label of ["Copy", "Regenerate", "Good response", "Bad response"]) { const b = d.createElement("button"); b.setAttribute("aria-label", label); b.textContent = label; tb.appendChild(b); }
  c.parentElement.appendChild(tb);
}
let inFlight = false, submitAttempts = 0;
function submit() {
  const text = ed.value;
  if (!text.trim() || generating) return false;
  // Every submit attempt counts, even while the previous one is still being
  // accepted: on a site that queues them, a second click = a duplicate message.
  submitAttempts++;
  if (inFlight) return false;
  inFlight = true;
  // Next.js server action: nothing visible changes until the server accepts.
  setTimeout(() => {
    inFlight = false;
    userMessages.push(text);
    log("USER SENT (" + text.length + " chars):", text.slice(0, 90).replace(/\n/g, "\\n"));
    ed.value = ""; ed.dispatchEvent(new w.Event("input", { bubbles: true }));
    row("user").textContent = text;
    const history = userMessages.map((t) => ({ role: "user", content: t }));
    w.fetch("https://c.vani.ai/api/public/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-6-luna", messages: history }) }).catch(() => {});
  }, ACCEPT_DELAY);
  return true;
}
// The site's own fetch → the model. Installed BEFORE the bundle so the real
// taps wrap it (stream-net.js + vani-net.js both wrap window.fetch).
w.fetch = async (input, init) => {
  const url = String((input && input.url) || input || "");
  const body = String((init && init.body) || "");
  requests.push({ url, body });
  if (!/\/api\/public\/chat/.test(url)) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  phase++;
  const reply = modelScript ? await modelScript(phase, body) : "Noted.";
  const c = row("assistant");
  startGenerating();
  const chunks = reply.match(/[\s\S]{1,24}/g) || [];
  let shown = "";
  const frames = [{ data: { type: "message.start", id: "msg_" + phase } }];
  for (const ch of chunks) frames.push({ data: { type: "content.delta", text: ch } });
  frames.push({ data: { type: "usage", prompt_tokens: 12, completion_tokens: chunks.length, weekly_used_percent: 3 } });
  frames.push({ data: { type: "message.complete" } });
  return sse(frames, {
    pace: 20,
    onFrame: (i, f) => {
      if (f.data.type === "content.delta") { shown += f.data.text; setTimeout(() => renderMarkdown(c, shown), 60); } // DOM trails the wire by a beat
      if (f.data.type === "message.complete") setTimeout(() => { renderMarkdown(c, shown); stopGenerating(c); }, 120);
    },
  });
};

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
    ok("provider is Vani Chat", P && P.id === "vani" && P.displayName === "Vani Chat");
    ok("MAIN-world taps installed: stream tap + request shaper", w.__rsStreamNet === true && !!d.documentElement.getAttribute("data-rs-vani-net"));
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    ok("bar mounted", true);
    await sleep(1200);
    const bar = d.getElementById("rs-bar"), root = d.getElementById("rs-root");
    if (CLOSED) {
      ok("landing page: no composer", P.getEditor() === null);
      ok("mode warning points at c.vani.ai/chat", /c\.vani\.ai\/chat/.test(P.modeWarning()));
      ok("the sidebar 'Log in' link is not a login gate", P.loginGatePresent() === false);
      const startBtn = [...bar.querySelectorAll("button")].find((b) => /start/i.test(b.textContent || "") || b.id === "rs-start");
      if (startBtn) { startBtn.click(); await sleep(5500); }
      ok("nothing was sent without a composer", userMessages.length === 0 && requests.length === 0);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
      return finish("vani-e2e (CLOSED)", pageErrors);
    }
    ok("composer is the Message textarea", P.getEditor() === ed);
    ok("bar anchored to the composer", !!bar && (bar.classList.contains("rs-bar-anchored") || bar.classList.contains("rs-bar-inline") || root.contains(bar)), bar.className);
    ok("empty thread reads as empty (sidebar promo / model picker are not transcript rows)", P.chatIsEmpty() && P.assistantCount() === 0 && P.userCount() === 0);
    const startBtn = [...bar.querySelectorAll("button")].find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
    ok("start button present", !!startBtn);

    const stageSeen = {};
    modelScript = async (n) => {
      if (n === 1) return "Loading the catalogue first.\n```\n###CMD list_commands###\n###END_CMD###\n```";
      if (n === 2) return "Ready. Tell me what to build in Roblox Studio.";
      if (n === 3) return `Creating the part now.\n\`\`\`\n###CMD part_create###\nname: ${PART}\nsize: [4, 2, 4]\nposition: [0, 5, 0]\nanchored: true\n###END_CMD###\n\`\`\``;
      if (n === 4) { stageSeen.result = userMessages[userMessages.length - 1]; return `Checking it.\n\`\`\`\n###LUA###\nlocal p = workspace:FindFirstChild("${PART}")\nif not p then return "MISSING" end\nreturn string.format("%s size=%s anchored=%s", p:GetFullName(), tostring(p.Size), tostring(p.Anchored))\n###END_LUA###\n\`\`\``; }
      if (n === 5) { stageSeen.readback = userMessages[userMessages.length - 1]; return `Done - **${PART}** exists in Workspace, 4×2×4 studs, anchored.`; }
      return "Noted.";
    };
    startBtn.click();
    log("clicked Start");
    await waitFor(() => userMessages.length >= 1, 20000, "bootstrap send");
    ok("bootstrap prompt sent once into the Message box", userMessages.length === 1 && /TotalScript|Roblox/i.test(userMessages[0]), userMessages[0].length + " chars");
    ok("bootstrap carries the Vani rules + the plain-text format note (no JSON requirement)", /Vani Chat rules/.test(userMessages[0]) && /###CMD/.test(userMessages[0]) && /never required/.test(userMessages[0]));
    ok("bootstrap uses the compact prompt and stays far under the guest send cap (60k)", /list_commands/.test(userMessages[0]) && userMessages[0].length <= 20000, userMessages[0].length + " chars");
    await waitFor(() => requests.length >= 1, 5000, "chat request");
    ok("request shaper pinned the protocol into the LAST user message (vani-net.js)", (() => { try { const b = JSON.parse(requests[0].body); const last = b.messages[b.messages.length - 1]; return last.role === "user" && /command block/i.test(last.content) && b.model === "openai/gpt-6-luna"; } catch { return false; } })());
    await waitFor(() => userMessages.length >= 2, 30000, "catalogue reply send");
    ok("the ###CMD list_commands### bootstrap call ran and the catalogue was typed back", /Output of 'list_commands'|commands - \d+ total/i.test(userMessages[1]), userMessages[1].slice(0, 80).replace(/\n/g, " "));
    ok("stream tap bridge status reports the pin", P.bridgeStatus().shaped === true, P.bridgeStatus().label);
    await waitFor(() => (w.__rsDiag || []).some((e) => /^start\.ready$|^session\.ready$/.test(e.event)) || /Agent running|Ready/i.test(bar.textContent || "") || !/Starting/i.test(bar.textContent || ""), 30000, "session ready");
    await waitFor(() => !P.isGenerating(), 10000, "ready reply settled");
    await sleep(600);
    ok("session marked started after the ready reply", !/Starting…/.test(bar.textContent || ""), (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90));

    // The user asks through Vani's own box: Enter in the textarea.
    ed.focus(); ed.value = `Create an anchored 4x2x4 part named ${PART} and check it exists`; ed.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(80);
    ed.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    // Duplicate event: the site also fires the form submit for the same keypress.
    form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => userMessages.length >= 3, 6000, "user request send");
    await sleep(ACCEPT_DELAY + 200);
    ok("one user message for the Enter + submit pair (no duplicate submit)", userMessages.length === 3, userMessages.length + " sends");
    await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && new RegExp(PART).test(String(c.arguments.code || ""))), 60000, "execute_luau (part_create)");
    const ex = toolCalls.find((c) => c.name === "execute_luau" && new RegExp(PART).test(String(c.arguments.code || "")));
    ok("###CMD part_create### went through the shared parser → contract → skill → execute_luau", /\n/.test(ex.arguments.code) && !/```/.test(ex.arguments.code) && !/###/.test(ex.arguments.code), String(ex.arguments.code).slice(0, 80).replace(/\n/g, "\\n"));
    ok("no TotalScript-internal flags leaked to the bridge", !Object.keys(ex.arguments).some((k) => /^_total/.test(k)));
    await waitFor(() => userMessages.length >= 4, 40000, "part_create result");
    ok("the REAL (simulated) result was typed back, not a canned OK", /Output of 'part_create'/.test(userMessages[3]) && (!simReady || /TotalScript_ProviderParityTest|"ok"\s*:\s*true|Workspace/.test(userMessages[3])), userMessages[3].slice(0, 120).replace(/\n/g, " "));
    await waitFor(() => userMessages.length >= 5, 40000, "read-back result");
    ok("###LUA### read-back ran and reported the part", simReady ? /size=4(\.0+)?, 2(\.0+)?, 4(\.0+)? anchored=true/.test(userMessages[4]) : /Output of 'execute_luau'/.test(userMessages[4]), userMessages[4].slice(0, 120).replace(/\n/g, " "));
    await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
    ok("agent loop ended after the final prose reply", true);
    // The core's own post-command log scan (GetLogHistory) is internal, not a model command.
    const luauCalls = toolCalls.filter((c) => c.name === "execute_luau" && !/GetLogHistory/.test(String(c.arguments.code || "")));
    ok("exactly two model commands reached the bridge (create + read-back) - the remembered turns were never re-run", luauCalls.length === 2, luauCalls.length + " calls");
    ok("5 sends total: bootstrap, catalogue, request, 2 results", userMessages.length === 5, userMessages.length + "");
    if (simReady) {
      const v = await sim.exec(`local p = workspace:FindFirstChild("${PART}") if not p then return "MISSING" end return { class = p.ClassName, size = { p.Size.X, p.Size.Y, p.Size.Z }, anchored = p.Anchored }`);
      let o = null; try { o = JSON.parse(v.text); } catch {}
      ok("VERIFIED in the DataModel: Part 4×2×4, anchored", !!o && o.class === "Part" && JSON.stringify(o.size) === "[4,2,4]" && o.anchored === true, v.text);
    } else ok("Studio stand-in unavailable (lupa missing) - result verification skipped: Blocked by environment", true);
    ok("reply text read from the wire, never with button labels", !(w.__rsDiag || []).some((e) => /Copy|Regenerate|Good response/.test(JSON.stringify(e.data || {}).slice(0, 2000)) && /^tool\./.test(e.event)));
    const vani = (w.__rsDiag || []).filter((e) => /^vani\./.test(e.event)).map((e) => e.event);
    ok("adapter diagnostics present (init, send, landed)", vani.includes("vani.init") && vani.includes("vani.send") && vani.includes("vani.send.landed"), [...new Set(vani)].join(","));
    const landed = (w.__rsDiag || []).filter((e) => e.event === "vani.send.landed");
    // 4 adapter sends (bootstrap, catalogue, 2 results); the user's own Enter is the site's.
    ok("every adapter send was committed ONCE and confirmed by a landing proof", landed.length === userMessages.length - 1 && landed.every((e) => e.data && e.data.proof), landed.map((e) => e.data && e.data.proof).join(","));
    ok("no 'send unconfirmed' diagnostics", !(w.__rsDiag || []).some((e) => e.event === "vani.send.unconfirmed"));
    // The Enter + form-submit pair above is 2 attempts by design (the site's own
    // duplicate event); every ADAPTER send must be exactly one attempt.
    ok("the adapter fired exactly one submit per message during the slow 1.2 s acceptance (pre-1.85 adapters re-clicked)", submitAttempts === userMessages.length + 1, submitAttempts + " attempts for " + userMessages.length + " messages");
    ok("the model never saw the JSON-only wording", !userMessages.some((m) => /must be JSON|only JSON/i.test(m)));
    await sleep(600);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
  } catch (e) { console.error(e); process.exitCode = 1; }
  sim.close();
  finish("vani-e2e", pageErrors);
})();
