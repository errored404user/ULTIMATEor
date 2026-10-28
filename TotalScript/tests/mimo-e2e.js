"use strict";
// End-to-end simulation of the WHOLE TotalScript bundle on a MiMo-Studio-shaped
// page (1.85.0). Optional (needs jsdom; lupa for the Studio stand-in):
//
//   cd TotalScript && npm i --no-save jsdom && node tests/mimo-e2e.js
//   CLOSED=1 node tests/mimo-e2e.js   # landing page (no composer): bar warns, nothing sent
//   DIAG=1 ...                        # print the [rs-diag] trace
//
// The fake page follows what src/providers/mimo.js documents about
// aistudio.xiaomimimo.com (hash-routed SPA `/#/c` → `/#/chat/<id>`, a
// textarea inside `.dialogue-container`, a send button recognisable only by
// its paper-plane SVG path, `event: message` SSE frames with
// {"type":"text","content"} deltas, inline <think>…</think> reasoning with
// U+0000 separators, `event: finish` {"content":"[DONE]"}). The reply streams
// through the REAL MAIN-world tap (stream-net.js); the DOM mirrors it a beat
// later. The first send moves the hash to a conversation id mid-session (the
// SPA navigation the core must survive).
//
// Scripted model, PLAIN (non-JSON) protocol only, with the failure classes
// the task lists: a command drafted INSIDE <think> (must never run), a
// two-command batch whose SECOND command is invalid (material "Steel" →
// contract rejects it, first command still runs), the model's fix, a ###LUA###
// read-back, then prose. execute_luau runs in the lupa miniature DataModel so
// the Part is VERIFIED (size, anchored, material) - not a canned OK.
//
// MOCKED end to end: no MiMo, no model, no Studio.
const { createPage, studioSim, sse, makeReporter, sleep, log } = require("./lib/e2e-page.js");

const CLOSED = !!process.env.CLOSED;
const SEND_D = "M.244 7.921 18.202.03a.5.5 0 0 1 .668.668L10.98 18.5a.5.5 0 0 1-.93-.052L8.1 11.9.552 9.95a.5.5 0 0 1-.308-.929Z";
const chat = `
    <div class="dialogue-container" data-rect="280,0,1000,800">
      <div class="message-list" id="msgs" data-rect="280,0,1000,660"></div>
      <div class="input-area" id="input-area" data-rect="320,690,920,90">
        <textarea id="ed" placeholder="给 MiMo 发消息" data-rect="330,700,800,60"></textarea>
        <div id="actions" data-rect="1140,700,90,50">
          <button class="tool-btn" aria-label="深度思考" data-rect="1140,700,40,40"><svg><path d="M3 3h18v18H3z"/></svg></button>
          <button class="send-btn disabled" id="send" data-rect="1190,700,40,40"><svg viewBox="0 0 19 18"><path d="${SEND_D}"/></svg></button>
        </div>
      </div>
    </div>`;
const html = `<!doctype html><html><head><title>MiMo Studio</title></head><body>
<div id="app" data-rect="0,0,1280,800">
  <aside class="sidebar" data-rect="0,0,280,800">
    <button aria-label="新对话" data-rect="10,10,200,36">新对话</button>
    <div class="history" data-rect="10,60,260,500"><div class="history-item content" data-rect="10,60,260,32">Earlier chat about doors</div></div>
    <a class="login-link" href="#/login" data-rect="10,760,60,24">登录</a>
  </aside>
  ${CLOSED ? '<main class="landing" data-rect="280,0,1000,800"><h1>MiMo</h1><p>Xiaomi MiMo Studio</p><a href="#/c">开始对话</a></main>' : chat}
</div></body></html>`;

const page = createPage({ html, url: CLOSED ? "https://aistudio.xiaomimimo.com/#/" : "https://aistudio.xiaomimimo.com/#/c", host: "aistudio.xiaomimimo.com", onToolCall });
const { w, d, toolCalls, pageErrors } = page;
const sim = studioSim();

// ── fake MiMo behaviour ──────────────────────────────────────────────────
const userMessages = [], requests = [];
let generating = false, stopBtn = null, phase = 0, modelScript = null, submitAttempts = 0, convId = null;
const ed = d.getElementById("ed"), send = d.getElementById("send"), msgs = d.getElementById("msgs"), actions = d.getElementById("actions");
if (ed) {
  ed.addEventListener("input", () => { send.classList.toggle("disabled", !ed.value.trim() || generating); });
  ed.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  send.addEventListener("click", () => { if (!send.classList.contains("disabled")) submit(); });
}
function row(role) {
  const r = d.createElement("div");
  r.className = "message-item " + role + "-message";
  r.setAttribute("data-rect", role === "user" ? "760,100,500,44" : "300,160,900,240");
  const c = d.createElement("div"); c.className = role === "user" ? "content" : "markdown-body";
  if (role === "assistant") { const t = d.createElement("div"); t.className = "think-block"; t.style.display = "none"; r.appendChild(t); }
  r.appendChild(c); msgs.appendChild(r);
  return r;
}
function renderMarkdown(c, text) {
  c.innerHTML = "";
  text.split(/```/).forEach((seg, i) => {
    if (i % 2 === 1) { const pre = d.createElement("pre"); const code = d.createElement("code"); code.textContent = seg.replace(/^[a-z]*\n/, ""); pre.appendChild(code); c.appendChild(pre); }
    else seg.split("\n").forEach((line) => { if (!line && i === 0) return; const p = d.createElement("p"); p.textContent = line; c.appendChild(p); });
  });
}
function startGenerating() {
  generating = true; send.classList.add("disabled"); send.style.display = "none";
  stopBtn = d.createElement("button"); stopBtn.className = "stop-btn"; stopBtn.setAttribute("data-rect", "1190,700,40,40"); stopBtn.innerHTML = "<svg><rect x='4' y='4' width='10' height='10'/></svg>";
  actions.appendChild(stopBtn);
}
function stopGenerating(r) {
  generating = false; if (stopBtn) stopBtn.remove(); stopBtn = null; send.style.display = "";
  const tb = d.createElement("div"); tb.className = "msg-actions";
  for (const label of ["复制", "重新生成", "点赞"]) { const b = d.createElement("button"); b.setAttribute("aria-label", label); b.textContent = label; tb.appendChild(b); }
  r.appendChild(tb);
}
function submit() {
  const text = ed.value;
  if (!text.trim() || generating) return false;
  submitAttempts++;
  userMessages.push(text);
  log("USER SENT (" + text.length + " chars):", text.slice(0, 90).replace(/\n/g, "\\n"));
  ed.value = ""; ed.dispatchEvent(new w.Event("input", { bubbles: true }));
  row("user").querySelector(".content").textContent = text;
  if (!convId) { convId = "conv_" + Date.now().toString(36); setTimeout(() => { w.location.hash = "#/chat/" + convId; }, 150); } // SPA navigation after the first send
  w.fetch("https://aistudio.xiaomimimo.com/open-apis/bot/chat?xiaomichatbot_ph=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msgId: "m" + userMessages.length, conversationId: convId, query: text, isEditedQuery: false, modelConfig: { model: "mimo-v2" }, multiMedias: [] }) }).catch(() => {});
  return true;
}
w.fetch = async (input, init) => {
  const url = String((input && input.url) || input || "");
  const body = String((init && init.body) || "");
  requests.push({ url, body });
  if (!/open-apis\/bot\/chat/.test(url)) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  phase++;
  const { think, reply } = modelScript ? await modelScript(phase) : { think: "", reply: "好的。" };
  const r = row("assistant"); const c = r.querySelector(".markdown-body"); const tb = r.querySelector(".think-block");
  startGenerating();
  const wire = (think ? "<think>" + think + "</think>" : "") + reply;
  const chunks = wire.match(/[\s\S]{1,22}/g) || [];
  let shown = "";
  const frames = chunks.map((ch, i) => `event: message\ndata: ${JSON.stringify({ type: "text", content: (i % 3 === 2 ? "\u0000" : "") + ch })}\n\n`);
  frames.push(`event: usage\ndata: ${JSON.stringify({ prompt_tokens: 20, completion_tokens: chunks.length })}\n\n`);
  frames.push(`event: finish\ndata: ${JSON.stringify({ content: "[DONE]" })}\n\n`);
  return sse(frames, {
    pace: 18,
    onFrame: (i) => {
      if (i < chunks.length) {
        shown += chunks[i];
        setTimeout(() => {
          const m = shown.match(/^<think>([\s\S]*?)(<\/think>([\s\S]*))?$/);
          if (m) { tb.textContent = m[1]; renderMarkdown(c, m[3] || ""); } else renderMarkdown(c, shown);
        }, 50);
      }
      if (i === frames.length - 1) setTimeout(() => stopGenerating(r), 120);
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
    ok("provider is Xiaomi MiMo Studio", P && P.id === "mimo");
    ok("MAIN-world stream tap installed", w.__rsStreamNet === true);
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    ok("bar mounted", true);
    await sleep(1200);
    const bar = d.getElementById("rs-bar"), root = d.getElementById("rs-root");
    if (CLOSED) {
      ok("landing page: no composer", P.getEditor() === null);
      ok("mode warning points at the chat URL", /aistudio\.xiaomimimo\.com\/#\/c/.test(P.modeWarning()) || P.loginGatePresent());
      const startBtn = [...bar.querySelectorAll("button")].find((b) => /start/i.test(b.textContent || "") || b.id === "rs-start");
      if (startBtn) { startBtn.click(); await sleep(5500); }
      ok("nothing was sent without a composer", userMessages.length === 0 && requests.length === 0);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
      return finish("mimo-e2e (CLOSED)", pageErrors);
    }
    ok("composer is the dialogue textarea", P.getEditor() === ed);
    ok("the corner 登录 link is not a login gate while the composer exists", P.loginGatePresent() === false);
    ok("bar anchored to the composer", !!bar && (bar.classList.contains("rs-bar-anchored") || bar.classList.contains("rs-bar-inline") || root.contains(bar)), bar.className);
    ok("empty chat reads as empty (sidebar history entry is not a transcript row)", P.chatIsEmpty() && P.assistantCount() === 0, P.allItems().length + " rows");
    const startBtn = [...bar.querySelectorAll("button")].find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
    ok("start button present", !!startBtn);

    modelScript = async (n) => {
      if (n === 1) return { think: "The extension wants list_commands first.", reply: "先加载命令目录。\n```\n###CMD list_commands###\n###END_CMD###\n```" };
      if (n === 2) return { think: "", reply: "准备好了。Tell me what to build in Roblox Studio." };
      if (n === 3) return { think: "I could run\n###LUA###\nprint('from think')\n###END_LUA###\nbut the user wants a part, so part_create then material_set.", reply: `Creating the part and setting its material.\n\`\`\`\n###CMD part_create###\nname: ${PART}\nsize: [4, 2, 4]\nposition: [0, 5, 0]\nanchored: true\n###END_CMD###\n\`\`\`\n\`\`\`\n###CMD material_set###\npath: Workspace.${PART}\nmaterial: Steel\n###END_CMD###\n\`\`\`` };
      if (n === 4) return { think: "Steel is not a Material enum; use Neon.", reply: `Fixing the material.\n\`\`\`\n###CMD material_set###\npath: Workspace.${PART}\nmaterial: Neon\n###END_CMD###\n\`\`\`` };
      if (n === 5) return { think: "", reply: `Checking.\n\`\`\`\n###LUA###\nlocal p = workspace:FindFirstChild("${PART}")\nif not p then return "MISSING" end\nreturn string.format("%s size=%s anchored=%s material=%s", p:GetFullName(), tostring(p.Size), tostring(p.Anchored), tostring(p.Material))\n###END_LUA###\n\`\`\`` };
      if (n === 6) return { think: "", reply: `完成 - **${PART}** exists in Workspace: 4×2×4, anchored, Neon.` };
      return { think: "", reply: "好的。" };
    };
    startBtn.click();
    log("clicked Start");
    await waitFor(() => userMessages.length >= 1, 20000, "bootstrap send");
    ok("bootstrap prompt sent once into the textarea", userMessages.length === 1 && /TotalScript|Roblox/i.test(userMessages[0]), userMessages[0].length + " chars");
    ok("bootstrap carries the MiMo rules + the plain-text format note", /MiMo Studio rules/.test(userMessages[0]) && /###CMD/.test(userMessages[0]) && /never required/.test(userMessages[0]));
    await waitFor(() => userMessages.length >= 2, 30000, "catalogue reply send");
    ok("the ###CMD list_commands### bootstrap call ran and the catalogue was typed back", /Output of 'list_commands'|commands - \d+ total/i.test(userMessages[1]), userMessages[1].slice(0, 80).replace(/\n/g, " "));
    ok("hash moved to the conversation id after the first send and the session survived it", /#\/chat\/conv_/.test(w.location.hash) && P.conversationKey() === convId, w.location.hash);
    await waitFor(() => !/Starting…/.test(bar.textContent || ""), 30000, "session ready");
    await waitFor(() => !P.isGenerating(), 10000, "ready reply settled");
    await sleep(600);
    ok("session marked started after the ready reply", !/Starting…/.test(bar.textContent || ""), (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90));

    // The user asks through MiMo's own box with the paper-plane button.
    ed.focus(); ed.value = `Create an anchored 4x2x4 Neon part named ${PART}`; ed.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(80);
    send.click();
    await waitFor(() => userMessages.length >= 3, 6000, "user request send");
    await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && new RegExp(PART).test(String(c.arguments.code || ""))), 60000, "execute_luau (part_create)");
    await waitFor(() => userMessages.length >= 4, 40000, "batch result");
    const batch = userMessages[3];
    ok("batch result: part_create ran, material_set 'Steel' was rejected by the contract BEFORE any Luau (INVALID_ENUM, NOT run)", /\[1\/2\] part_create[\s\S]*"ok": true/.test(batch) && /\[2\/2\] material_set - FAILED/.test(batch) && /INVALID_ENUM/.test(batch) && /material_set/.test(batch) && /NOT run/.test(batch), batch.slice(0, 200).replace(/\n/g, " "));
    ok("the command drafted inside <think> never reached the bridge", !toolCalls.some((c) => /from think/.test(String(c.arguments && c.arguments.code || ""))));
    await waitFor(() => userMessages.length >= 5, 40000, "material fix result");
    ok("the fix (material Neon) ran and was verified by read-back", /Output of 'material_set'/.test(userMessages[4]) && (!simReady || /Neon/.test(userMessages[4])), userMessages[4].slice(0, 160).replace(/\n/g, " "));
    await waitFor(() => userMessages.length >= 6, 40000, "read-back result");
    ok("###LUA### read-back reports size, anchored and material", simReady ? /size=4(\.0+)?, 2(\.0+)?, 4(\.0+)? anchored=true material=Enum\.Material\.Neon/.test(userMessages[5]) : /Output of 'execute_luau'/.test(userMessages[5]), userMessages[5].slice(0, 160).replace(/\n/g, " "));
    await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
    ok("agent loop ended after the final prose reply", true);
    // The core's own probes (RunService:IsRunning, LogService:GetLogHistory) are internal, not model commands.
    const modelLuau = toolCalls.filter((c) => c.name === "execute_luau" && !/GetLogHistory|IsRunning\(\)/.test(String(c.arguments.code || "")));
    ok("exactly three model commands reached the bridge (create, material fix, read-back); no re-runs, no Steel", modelLuau.length === 3 && !modelLuau.some((c) => /Steel/.test(String(c.arguments.code))), modelLuau.length + " calls");
    ok("6 sends total: bootstrap, catalogue, request, 3 results", userMessages.length === 6, userMessages.length + "");
    ok("every submit was a single attempt (no duplicate submits)", submitAttempts === userMessages.length, submitAttempts + " attempts");
    if (simReady) {
      const v = await sim.exec(`local p = workspace:FindFirstChild("${PART}") if not p then return "MISSING" end return { class = p.ClassName, size = { p.Size.X, p.Size.Y, p.Size.Z }, anchored = p.Anchored, material = tostring(p.Material) }`);
      let o = null; try { o = JSON.parse(v.text); } catch {}
      ok("VERIFIED in the DataModel: Part 4×2×4, anchored, Neon", !!o && o.class === "Part" && JSON.stringify(o.size) === "[4,2,4]" && o.anchored === true && /Neon/.test(o.material), v.text);
    } else ok("Studio stand-in unavailable (lupa missing) - result verification skipped: Blocked by environment", true);
    const mimo = (w.__rsDiag || []).filter((e) => /^mimo\./.test(e.event)).map((e) => e.event);
    ok("adapter diagnostics present (init, send, landed)", mimo.includes("mimo.init") && mimo.includes("mimo.send") && mimo.includes("mimo.send_landed"), [...new Set(mimo)].join(","));
    ok("no 'send unconfirmed' diagnostics", !(w.__rsDiag || []).some((e) => e.event === "mimo.send_unconfirmed"));
    ok("reply text never carried the 复制 / 重新生成 toolbar labels into a command", !toolCalls.some((c) => /复制|重新生成/.test(JSON.stringify(c.arguments || {}))));
    await sleep(600);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || "));
  } catch (e) { console.error(e); process.exitCode = 1; }
  sim.close();
  finish("mimo-e2e", pageErrors);
})();
