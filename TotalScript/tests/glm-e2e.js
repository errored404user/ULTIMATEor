"use strict";
// End-to-end simulation of the WHOLE TotalScript bundle on a chat.z.ai-shaped
// page (2.17.0). Optional (needs jsdom; lupa for the Studio stand-in):
//
//   cd TotalScript && npm i --no-save jsdom && node tests/glm-e2e.js
//   SLOW_SVELTE=1 node tests/glm-e2e.js   # send button re-enables 2 s after input
//   NO_UUID=1 node tests/glm-e2e.js       # turns never get a message-<uuid> class
//   DIAG=1 ...                            # print the [rs-diag] trace
//
// The fake page follows what src/providers/glm.js documents about z.ai (2026,
// Svelte): a real <textarea id="chat-input"> inside .messageInputContainer,
// #send-message-button that is disabled while the box is empty / for a frame
// after input, a round `rounded-full bg-black` stop button WITHOUT svg that
// replaces it for the whole generation, round `bg-white rounded-full` scroll
// arrows WITH svg (must not read as stop), .user-message / .chat-assistant
// turns under a `message-<uuid>` wrapper, a .thinking-chain-container that
// streams first, and fenced code rendered as `div.rounded-xl` wrappers with a
// .copy-code-button that Svelte RE-CREATES on every stream update. The first
// send navigates / → /c/<uuid> and unmounts the composer for ~1.5 s, like a
// Svelte route change, and again for ~3 s right when the first tool result is due.
//
// Scripted model, PLAIN protocol: list_commands → ready → ###CMD part_create###
// → ###LUA### read-back → prose. execute_luau runs in the lupa DataModel.
// MOCKED end to end: no z.ai, no model, no Studio.
const { createPage, studioSim, makeReporter, sleep, log } = require("./lib/e2e-page.js");

const SLOW_SVELTE = !!process.env.SLOW_SVELTE;
const NO_UUID = !!process.env.NO_UUID;
const html = `<!doctype html><html><head><title>Z.ai Chat</title></head><body>
<div id="app" data-rect="0,0,1280,800">
  <nav class="sidebar" data-rect="0,0,260,800"><button data-rect="10,10,200,36">New Chat</button></nav>
  <main data-rect="260,0,1020,800">
    <div id="messages" class="flex flex-col" data-rect="260,0,1020,640"></div>
    <div id="scroll-arrows" class="absolute" data-rect="760,600,40,40"><button class="bg-white rounded-full shadow" data-rect="760,600,36,36"><svg><path d="M0 0"/></svg></button></div>
    <div id="composer-host" data-rect="300,660,940,130"></div>
  </main>
</div></body></html>`;

const page = createPage({ html, url: "https://chat.z.ai/", host: "chat.z.ai", onToolCall });
const { w, d, toolCalls, pageErrors } = page;
const sim = studioSim();
const messages = d.getElementById("messages"), host = d.getElementById("composer-host");

// ── composer (mountable, like a Svelte component) ────────────────────────
let ta = null, sendBtn = null, stopBtn = null, actions = null, generating = false, enableTimer = null;
const userMessages = []; let submitAttempts = 0, stopClicks = 0, phase = 0, modelScript = null;
function mountComposer() {
  host.innerHTML = `<div class="messageInputContainer" data-rect="300,660,940,130">
    <div class="flex flex-col w-full rounded-xl border" data-rect="300,660,940,130">
      <textarea id="chat-input" placeholder="Message GLM" rows="1" data-rect="310,670,900,60"></textarea>
      <div class="toolbar flex" data-rect="310,740,920,40">
        <button class="model-pill" data-rect="310,745,120,30">GLM-5.2</button>
        <div class="chip-scroll" data-rect="440,745,300,30"></div>
        <div id="actions" class="ml-auto" data-rect="1190,745,40,30">
          <button id="send-message-button" type="submit" disabled data-rect="1190,745,36,30"><svg><path/></svg></button>
        </div></div></div></div>`;
  ta = host.querySelector("#chat-input"); sendBtn = host.querySelector("#send-message-button"); actions = host.querySelector("#actions");
  const myTa = ta, myBtn = sendBtn;
  ta.addEventListener("input", () => {
    // Svelte: a fresh value disables the button for a frame - or, on a heavy
    // page (SLOW_SVELTE), for a whole slow reactive cycle. Extra input events
    // during a pending cycle neither reset nor shorten it.
    myBtn.disabled = true;
    if (enableTimer) return;
    enableTimer = setTimeout(() => { enableTimer = null; if (myTa.isConnected) myBtn.disabled = !myTa.value.trim() || generating; }, SLOW_SVELTE ? 2000 : 30);
  });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) submit(); } });
  sendBtn.addEventListener("click", () => { if (!sendBtn.disabled) submit(); });
  if (generating) showStop();
}
function showStop() {
  sendBtn.style.display = "none";
  stopBtn = d.createElement("button"); stopBtn.type = "submit"; stopBtn.className = "flex items-center justify-center rounded-full bg-black text-white size-8"; stopBtn.setAttribute("data-rect", "1190,745,32,32");
  const sq = d.createElement("span"); sq.className = "size-3 bg-white rounded-sm"; stopBtn.appendChild(sq);
  stopBtn.addEventListener("click", () => { stopClicks++; });
  actions.appendChild(stopBtn);
}
let remountTimer = null;
function unmountComposer(ms) {
  host.innerHTML = ""; ta = null; sendBtn = null; stopBtn = null; clearTimeout(enableTimer); enableTimer = null;
  clearTimeout(remountTimer);
  remountTimer = setTimeout(() => { remountTimer = null; mountComposer(); }, ms);
}
function hideStop() { if (stopBtn) stopBtn.remove(); stopBtn = null; sendBtn.style.display = ""; sendBtn.disabled = !ta.value.trim(); }
mountComposer();

const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
function renderMarkdown(prose, text) {
  prose.innerHTML = "";
  text.split(/```/).forEach((seg, i) => {
    if (i % 2 === 1) {
      const wrap = d.createElement("div"); wrap.className = "relative my-2 flex flex-col rounded-xl border bg-gray-50";
      const head = d.createElement("div"); head.className = "flex items-center justify-between px-4 py-2";
      const lang = d.createElement("span"); lang.textContent = (seg.match(/^([a-z]*)\n/) || [, "text"])[1] || "text"; head.appendChild(lang);
      const copy = d.createElement("button"); copy.className = "copy-code-button"; copy.textContent = "Copy"; head.appendChild(copy);
      wrap.appendChild(head);
      const pre = d.createElement("pre"); const code = d.createElement("code"); code.className = "cm-content"; code.textContent = seg.replace(/^[a-z]*\n/, ""); pre.appendChild(code); wrap.appendChild(pre);
      prose.appendChild(wrap);
    } else seg.split("\n").forEach((line) => { if (!line) return; const p = d.createElement("p"); p.textContent = line; prose.appendChild(p); });
  });
}
function submit() {
  const text = ta.value;
  if (!text.trim() || generating) return false;
  submitAttempts++; userMessages.push(text);
  log("USER SENT (" + text.length + " chars, " + text.split("\n").length + " lines" + (/lines omitted|\[truncated\]/.test(text) ? ", TRUNCATED" : "") + "):", text.slice(0, 90).replace(/\n/g, "\\n"));
  ta.value = ""; ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  const wrap = d.createElement("div"); wrap.className = "w-full " + (NO_UUID ? "" : "message-" + uuid()); wrap.setAttribute("data-rect", "700,100,560,50");
  const um = d.createElement("div"); um.className = "user-message flex justify-end";
  const cu = d.createElement("div"); cu.className = "chat-user rounded-3xl px-5 py-2";
  const body = d.createElement("div"); text.split("\n").forEach((line) => { const p = d.createElement("p"); p.textContent = line; body.appendChild(p); });
  cu.appendChild(body); um.appendChild(cu); wrap.appendChild(um); messages.appendChild(wrap);
  if (userMessages.length === 1) {
    // route change / → /c/<uuid>: Svelte unmounts the composer for ~1.5 s
    w.history.replaceState({}, "", "/c/" + uuid());
    unmountComposer(1500);
  }
  setTimeout(() => generate(), 300);
  return true;
}
async function generate() {
  phase++;
  const reply = modelScript ? await modelScript(phase) : "Okay.";
  const wrap = d.createElement("div"); wrap.className = "w-full " + (NO_UUID ? "" : "message-" + uuid()); wrap.setAttribute("data-rect", "300,160,900,300");
  const turn = d.createElement("div"); turn.className = "chat-assistant markdown-prose w-full";
  const col = d.createElement("div"); col.className = "flex flex-col w-full";
  const think = d.createElement("div"); think.className = "thinking-chain-container rounded-lg"; const tb = d.createElement("p"); think.appendChild(tb);
  const prose = d.createElement("div"); prose.className = "markdown-prose";
  const spacer = d.createElement("div"); spacer.setAttribute("aria-hidden", "true"); spacer.className = "h-2";
  col.appendChild(think); col.appendChild(prose); col.appendChild(spacer); turn.appendChild(col); wrap.appendChild(turn); messages.appendChild(wrap);
  generating = true; if (sendBtn) { sendBtn.disabled = true; showStop(); }
  const thought = "The user wants a Roblox Studio action. I will pick the matching TotalScript command and emit it.";
  for (const ch of thought.match(/[\s\S]{1,16}/g)) { tb.textContent += ch; await sleep(15); }
  let shown = "";
  for (const ch of reply.match(/[\s\S]{1,24}/g) || []) { shown += ch; renderMarkdown(prose, shown); await sleep(20); }
  await sleep(120);
  generating = false; if (sendBtn) hideStop();
  // After the FIRST reply (the long catalogue is about to be typed back) a
  // heavy re-render of the list unmounts the composer for ~3 s - exactly
  // when the core wants to inject the tool result.
  if (phase === 1) unmountComposer(3000);
  // action bar OUTSIDE the turn (validated live per the adapter notes)
  const bar = d.createElement("div"); bar.className = "flex gap-2 actions"; for (const l of ["Copy", "Regenerate", "Like", "Dislike"]) { const b = d.createElement("button"); b.textContent = l; bar.appendChild(b); } wrap.appendChild(bar);
}

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
    ok("provider is GLM with reliable turn identity and item-level trailing chips", P && P.id === "glm" && P.reliableCounts === true && P.chipAtItemLevel && P.chipAppend);
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(1200);
    const bar = d.getElementById("rs-bar");
    ok("composer is the #chat-input textarea; empty chat; no stop button on the static page (scroll arrow ignored)", P.getEditor() === ta && P.chatIsEmpty() && !P.isHardGenerating());
    ok("bar is anchored to the rounded composer card, not injected into it", !!P.barAnchor() && !P.barAnchor().contains(bar));
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
    await waitFor(() => userMessages.length >= 1, 20000, "bootstrap send");
    ok("bootstrap prompt set through the native textarea setter and sent once", userMessages.length === 1 && /TotalScript|Roblox/i.test(userMessages[0]), userMessages[0].length + " chars");
    const tBoot = Date.now();
    await waitFor(() => userMessages.length >= 2, 40000, "catalogue reply send");
    ok("###CMD list_commands### ran across the route change and the catalogue was typed back (composer unmounted 1.5 s after the first send AND for 3 s when the first result was due)", /Output of 'list_commands'|commands - \d+ total/i.test(userMessages[1]), userMessages[1].slice(0, 80).replace(/\n/g, " "));
    ok("the transient composer unmount did NOT end the turn as a provider error", !(w.__rsDiag || []).some((e) => /input box disappeared/.test(JSON.stringify(e.data || {}))) && !/input box disappeared/.test(bar.textContent || ""));
    await waitFor(() => !/Starting…/.test(bar.textContent || ""), 40000, "session ready");
    await waitFor(() => !P.isGenerating(), 15000, "ready reply settled");
    await sleep(600);
    ok("session marked started after the ready reply (" + (Date.now() - tBoot) + " ms after bootstrap)", !/Starting…/.test(bar.textContent || ""), (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90));
    ok("conversation key follows the /c/<uuid> route; not the transient root", /^\/c\//.test(P.conversationKey()), P.conversationKey());
    ok("turn identity read from the message-<uuid> wrapper" + (NO_UUID ? " (absent → null, count fallback)" : ""), NO_UUID ? P.lastAssistantId() === null : /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(String(P.lastAssistantId())), String(P.lastAssistantId()));

    // The user asks through the site's own textarea (Enter).
    const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, `Create an anchored 4x2x4 part named ${PART} and check it exists`);
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    await waitFor(() => !sendBtn.disabled, 5000, "site enables send for the user's text");
    ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => userMessages.length >= 3, 6000, "user request send");
    const t3 = Date.now();
    await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && new RegExp(PART).test(String(c.arguments.code || ""))), 90000, "execute_luau (part_create)");
    await waitFor(() => userMessages.length >= 4, 60000, "tool result send");
    ok("###CMD part_create### went through parser → contract → skill → execute_luau and the REAL result was typed back", /Output of 'part_create'/.test(userMessages[3]) && /"ok": true/.test(userMessages[3]), userMessages[3].slice(0, 120).replace(/\n/g, " "));
    await waitFor(() => userMessages.length >= 5, 60000, "read-back result");
    ok("###LUA### read-back ran and reported the part", simReady ? /size=4(\.0+)?, 2(\.0+)?, 4(\.0+)? anchored=true/.test(userMessages[4]) : /Output of 'execute_luau'/.test(userMessages[4]), userMessages[4].slice(0, 120).replace(/\n/g, " "));
    await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 60000, "loop.end");
    const turnMs = Date.now() - t3;
    const modelLuau = toolCalls.filter((c) => c.name === "execute_luau" && !/GetLogHistory|IsRunning\(\)|TotalScript mode probe/.test(String(c.arguments.code || "")));
    ok("exactly two model commands reached the bridge (create + read-back); nothing re-ran", modelLuau.length === 2, modelLuau.length + " calls");
    ok("5 sends total, each a single submit; the stop button was never clicked", userMessages.length === 5 && submitAttempts === 5 && stopClicks === 0, userMessages.length + " sends, " + submitAttempts + " submits, " + stopClicks + " stop clicks");
    const hidden = [...messages.querySelectorAll(".rs-tool-hide")];
    ok("command code wrappers were camouflaged (rs-tool-hide on the rounded-xl wrapper) and the turn masked", hidden.length >= 2 && hidden.every((h) => /rounded-xl/.test(h.className)) && !!messages.querySelector(".chat-assistant.rs-cmd-mask"), hidden.length + " hidden");
    const chips = [...messages.querySelectorAll(".chat-assistant .rs-chip")];
    ok("chips trail the reply inside the content column, above the aria-hidden spacer", chips.length >= 2 && chips.every((c) => c.parentElement.classList.contains("flex-col") && c.nextElementSibling && c.nextElementSibling.getAttribute("aria-hidden") === "true"), chips.length + " chips");
    ok("reply text never carried the action bar labels or the thinking into a command", !toolCalls.some((c) => /Regenerate|Dislike|The user wants a Roblox/.test(JSON.stringify(c.arguments || {}))));
    const dg = w.__rsDiag || [];
    const grace = dg.filter((e) => e.event === "noTurnGrace.wait" || e.event === "staleTurn.wait");
    ok("no turn sat in the 30 s 'no new turn' / stale-turn gate", grace.length === 0, grace.slice(0, 2).map((e) => e.event + ":" + JSON.stringify(e.data).slice(0, 120)).join(" | "));
    const tails = dg.filter((e) => e.event === "stopGoneToResp").map((e) => e.data && e.data.stopGoneToRespMs);
    ok("every reply finalised within 4 s of the stop button clearing (" + tails.join("/") + " ms)", tails.length >= 3 && tails.every((ms) => ms < 4000), tails.join(","));
    ok("three agent turns took under 40 s of simulated time (" + turnMs + " ms)", turnMs < 40000, turnMs);
    const sends = dg.filter((e) => e.event === "glm.send");
    ok("every adapter send saw the button re-enable" + (SLOW_SVELTE ? " after the 2 s Svelte lag" : "") + "; no Enter fallback / retry needed", sends.length >= 4 && sends.every((e) => e.data && e.data.enabled === true) && !dg.some((e) => e.event === "glm.send.retryOnce"), sends.map((e) => JSON.stringify(e.data)).join(" "));
    const endAt = (dg.find((e) => e.event === "loop.end") || {}).t || Date.now();
    await sleep(3000);
    const storm = (w.__rsDiag || []).filter((e) => e.event === "chip.rebuild" && e.data && e.data.rawVisible && (e.t || 0) > endAt);
    ok("no chip-rebuild storm after the loop ended", storm.length === 0, storm.length + " rebuilds after loop.end");
    if (simReady) {
      const v = await sim.exec(`local p = workspace:FindFirstChild("${PART}") if not p then return "MISSING" end return { class = p.ClassName, size = { p.Size.X, p.Size.Y, p.Size.Z }, anchored = p.Anchored }`);
      let o = null; try { o = JSON.parse(v.text); } catch {}
      ok("VERIFIED in the DataModel: Part 4×2×4, anchored", !!o && o.class === "Part" && JSON.stringify(o.size) === "[4,2,4]" && o.anchored === true, v.text);
    } else ok("Studio stand-in unavailable (lupa missing) - result verification skipped: Blocked by environment", true);
    await sleep(600);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
  } catch (e) { console.error(e); process.exitCode = 1; }
  sim.close();
  finish("glm-e2e" + (SLOW_SVELTE ? " (SLOW_SVELTE)" : "") + (NO_UUID ? " (NO_UUID)" : ""), pageErrors);
})();
