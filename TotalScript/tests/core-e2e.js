"use strict";
// Whole-bundle simulation of the TotalScript CORE on a chat.z.ai-shaped page
// (2.20.0). Optional (needs jsdom; the bridge is canned so every scenario is
// deterministic - no lupa needed):
//
//   cd TotalScript && npm i --no-save jsdom && node tests/core-e2e.js
//   ASK=1    node tests/core-e2e.js   # permission mode "ask": approvals, read-only tools never ask
//   CREW=1   node tests/core-e2e.js   # Multi-Agent crew protocol (planner guard, builder, tester, done)
//   HELP=1   node tests/core-e2e.js   # totalscript_help answers a "how do templates work" question
//   PUBLIC=1 node tests/core-e2e.js   # Public Skills: create, call, refuse a custom mode, verify, Public tab
//   SHOT=1   node tests/core-e2e.js   # total_screenshot / screen_capture resolve the studio_id
//   STATE=1|2|3|4 node tests/core-e2e.js # big get_studio_state dump, then execute_luau in 4 envelope shapes
//   TASKS=1  node tests/core-e2e.js   # Task list: pill, task_next / task_update, Tasks tab, Settings toggle
//   DIAG=1 ...                        # print the [rs-diag] trace
//
// History: these scenarios lived in tests/notion-e2e.js (1.21.4 → 2.20.0) and
// ran on a Notion-AI-shaped page. The Notion provider was removed in 2.20.0, so
// the scenarios moved here unchanged and now drive the GLM adapter instead
// (textarea composer, #send-message-button, .chat-assistant turns - the shape
// tests/glm-e2e.js documents). Nothing here depends on the provider: the
// scenarios exercise the core loop, parser, permissions, crew, task list,
// public skills, help and screenshot paths through the real content-script
// bundle loaded from manifest.json.
//
// MOCKED end to end: no z.ai, no model, no Studio.
const { createPage, makeReporter, sleep, log } = require("./lib/e2e-page.js");

const VERBOSE = !!process.env.VERBOSE;
const CREW = !!process.env.CREW;
const SHOT = !!process.env.SHOT;
const STATE = Number(process.env.STATE || 0);
const HELP = !!process.env.HELP;
const PUBLIC = !!process.env.PUBLIC;
const TASKS = !!process.env.TASKS;
const TAG = [process.env.ASK && "ASK", CREW && "CREW", HELP && "HELP", PUBLIC && "PUBLIC", SHOT && "SHOT", STATE && "STATE=" + STATE, TASKS && "TASKS"].filter(Boolean).map((s) => " (" + s + ")").join("");

const html = `<!doctype html><html><head><title>Z.ai Chat</title></head><body>
<div id="app" data-rect="0,0,1280,800">
  <nav class="sidebar" data-rect="0,0,260,800"><button data-rect="10,10,200,36">New Chat</button></nav>
  <main data-rect="260,0,1020,800">
    <div id="messages" class="flex flex-col" data-rect="260,0,1020,640"></div>
    <div class="messageInputContainer" data-rect="300,660,940,130">
      <div id="composer" class="flex flex-col w-full rounded-xl border" data-rect="300,660,940,130">
        <textarea id="chat-input" placeholder="Message GLM" rows="1" data-rect="310,670,900,60"></textarea>
        <div class="toolbar flex" data-rect="310,740,920,40">
          <button class="model-pill" data-rect="310,745,120,30">GLM-5.2</button>
          <div id="actions" class="ml-auto" data-rect="1190,745,40,30">
            <button id="send-message-button" type="submit" disabled data-rect="1190,745,36,30"><svg><path/></svg></button>
          </div></div></div></div>
  </main>
</div></body></html>`;

// ── bridge stand-in (canned, scenario-aware) ──────────────────────────────
// Mirrors the real Studio MCP: every tool takes a studio_id, screen_capture
// REFUSES without it, list_roblox_studios is how clients find it; the public
// skill 'lantern_row' answers with the shape its verify block expects.
async function onToolCall(msg) {
  const code = String(msg.arguments && msg.arguments.code || "");
  if (msg.name === "execute_luau" && /GetLogHistory/.test(code)) {
    // Studio Output probes (total_debug / Automatic Debugger): a clean console.
    return { ok: true, text: /MessageError/.test(code) ? "[]" : JSON.stringify({ errors: [], warnings: [], info: [], errorCount: 0, warningCount: 0 }) };
  }
  if (msg.name === "execute_luau" && STATE && !/StatePart|SimPart/.test(code)) msg = { name: "get_studio_state" };
  if (msg.name === "execute_luau" && /^-- TotalScript public skill 'lantern_row' v\d+ - VERIFY/.test(code)) return { ok: true, text: JSON.stringify({ ok: true, verify: true, detail: "2 lanterns found under Workspace" }) };
  if (msg.name === "execute_luau" && /^-- TotalScript public skill 'lantern_row'/.test(code)) return { ok: true, text: JSON.stringify({ ok: true, created: 2 }) };
  if (msg.name === "execute_luau") return { ok: true, text: "OK: Part created (SimPart)" };
  if (msg.name === "get_studio_state") {
    if (STATE) {
      // Shape of the real Studio MCP answer: a long multi-line dump with
      // brackets, quotes and a "command"-looking line in it.
      const lines = ["Place: Baseplate (id 0, universe 0)", "DataModel:", "  Workspace", "    Camera", "    Baseplate [Part] {\"size\":[512,20,512]}", "    SpawnLocation [SpawnLocation]"];
      for (let i = 0; i < 400; i++) lines.push("    Part" + i + " [Part] Anchored=true Size=(4, 1, 2) CFrame=(" + i + ", 0.5, 0) Material=Plastic");
      lines.push("  ReplicatedStorage", "    Remotes [Folder]", "  ServerScriptService", "    Main [Script] -- \"command\": \"noop\"", "Selection: []", "Run state: Edit");
      return { ok: true, text: lines.join("\n") };
    }
    return { ok: true, text: "{\"place\":\"Baseplate\",\"selection\":[]}" };
  }
  if (msg.name === "list_roblox_studios") return { ok: true, text: JSON.stringify({ studios: [{ id: "studio-7f3a", name: "Baseplate", place_id: 123456 }] }) };
  if (msg.name === "screen_capture") {
    const sid = msg.arguments && msg.arguments.studio_id;
    if (!sid) return { ok: false, kind: "execution", errorCode: "INVALID_ARGUMENT", error: "Missing required arg: studio_id" };
    if (sid !== "studio-7f3a") return { ok: false, kind: "execution", errorCode: "TOOL_EXECUTION_ERROR", error: "Studio instance " + sid + " is not connected" };
    return { ok: true, text: "Captured the Studio viewport", images: [{ mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" }] };
  }
  return null;
}

const page = createPage({ html, url: "https://chat.z.ai/", host: "chat.z.ai", onToolCall });
const { w, d, storage, toolCalls, pageErrors } = page;
if (TASKS) w.chrome.storage.local.set({ rsTaskList: { enabled: true, tasks: [{ id: "t_a1", text: "Create a part named SimPart", status: "todo" }, { id: "t_b2", text: "Add a PointLight to it", status: "todo" }] } });
w.chrome.storage.local.set({ rsMultiAgent: CREW, ...(process.env.ASK ? { rsPermMode: "ask" } : {}) });

// ── site behaviour (what src/providers/glm.js keys on) ────────────────────
const messages = d.getElementById("messages"), ta = d.getElementById("chat-input"), sendBtn = d.getElementById("send-message-button"), actions = d.getElementById("actions");
const userMessages = [];
let generating = false, stopBtn = null, enableTimer = null;
let onUserMessage = null; // set by the scenario
ta.addEventListener("input", () => {
  sendBtn.disabled = true; clearTimeout(enableTimer);
  enableTimer = setTimeout(() => { sendBtn.disabled = !ta.value.trim() || generating; }, 30);
});
ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) doSend(); } });
sendBtn.addEventListener("click", () => { if (!sendBtn.disabled) doSend(); });
const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
function startGenerating() {
  generating = true; sendBtn.disabled = true; sendBtn.style.display = "none";
  stopBtn = d.createElement("button"); stopBtn.type = "submit"; stopBtn.className = "flex items-center justify-center rounded-full bg-black text-white size-8"; stopBtn.setAttribute("data-rect", "1190,745,32,32");
  const sq = d.createElement("span"); sq.className = "size-3 bg-white rounded-sm"; stopBtn.appendChild(sq);
  actions.appendChild(stopBtn);
}
function stopGenerating() {
  generating = false;
  if (stopBtn) stopBtn.remove(); stopBtn = null;
  sendBtn.style.display = ""; sendBtn.disabled = !ta.value.trim();
}
function doSend() {
  const text = ta.value;
  if (!text.trim() || generating) return false;
  userMessages.push(text);
  ta.value = ""; ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  const wrap = d.createElement("div"); wrap.className = "w-full message-" + uuid(); wrap.setAttribute("data-rect", "700,100,560,50");
  const um = d.createElement("div"); um.className = "user-message flex justify-end";
  const cu = d.createElement("div"); cu.className = "chat-user rounded-3xl px-5 py-2";
  const body = d.createElement("div"); text.split("\n").forEach((line) => { const p = d.createElement("p"); p.textContent = line; body.appendChild(p); });
  cu.appendChild(body); um.appendChild(cu); wrap.appendChild(um); messages.appendChild(wrap);
  if (userMessages.length === 1) w.history.replaceState({}, "", "/c/" + uuid());
  if (VERBOSE) log("USER SENT:", text.slice(0, 200).replace(/\n/g, "\\n") + (text.length > 200 ? "…" : ""));
  else log("USER SENT (" + text.length + " chars):", text.slice(0, 90).replace(/\n/g, "\\n"));
  setTimeout(() => { startGenerating(); if (onUserMessage) onUserMessage(text); }, 60);
  return true;
}
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
    } else seg.split("\n").forEach((line) => { if (!line) return; const p = d.createElement("p"); p.textContent = line; prose.appendChild(p); prose.appendChild(d.createTextNode("\n")); });
    // (the "\n" text nodes stand in for the line breaks a browser's innerText
    //  puts between block elements - jsdom only has textContent)
  });
}
// Streams an assistant reply the way the site renders it (thinking first,
// then markdown with rounded-xl code wrappers, action bar outside the turn).
function replyWith(text) {
  const wrap = d.createElement("div"); wrap.className = "w-full message-" + uuid(); wrap.setAttribute("data-rect", "300,160,900,300");
  const turn = d.createElement("div"); turn.className = "chat-assistant markdown-prose w-full";
  const col = d.createElement("div"); col.className = "flex flex-col w-full";
  const think = d.createElement("div"); think.className = "thinking-chain-container rounded-lg"; const tb = d.createElement("p"); think.appendChild(tb);
  const prose = d.createElement("div"); prose.className = "markdown-prose";
  const spacer = d.createElement("div"); spacer.setAttribute("aria-hidden", "true"); spacer.className = "h-2";
  col.appendChild(think); col.appendChild(prose); col.appendChild(spacer); turn.appendChild(col); wrap.appendChild(turn); messages.appendChild(wrap);
  return (async () => {
    const thought = "The user wants a Roblox Studio action. I will pick the matching TotalScript command and emit it.";
    for (const ch of thought.match(/[\s\S]{1,16}/g)) { tb.textContent += ch; await sleep(15); }
    let shown = "";
    for (const ch of text.match(/[\s\S]{1,40}/g) || []) { shown += ch; renderMarkdown(prose, shown); await sleep(25); }
    await sleep(120);
    stopGenerating();
    const bar = d.createElement("div"); bar.className = "flex gap-2 actions"; for (const l of ["Copy", "Regenerate", "Like", "Dislike"]) { const b = d.createElement("button"); b.textContent = l; bar.appendChild(b); } wrap.appendChild(bar);
    return prose;
  })();
}

page.loadBundle();

// ── scenario ──────────────────────────────────────────────────────────────
const { ok, waitFor, finish } = makeReporter();

(async () => {
  try {
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    ok("bar mounted", true);
    await sleep(1500);
    const bar = d.getElementById("rs-bar");
    const root = d.getElementById("rs-root");
    const dispBar = bar.style.display;
    ok("bar stays visible after 1.5s", dispBar !== "none", "display=" + JSON.stringify(dispBar) + " state=" + root.dataset.rsCollisionState);
    // Find the Start button
    const buttons = [...bar.querySelectorAll("button")];
    const startBtn = buttons.find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
    ok("start button present", !!startBtn, buttons.map((b) => (b.id || "") + ":" + (b.textContent || "").trim().slice(0, 20)).join(" | "));
    if (!startBtn) throw new Error("no start button");
    // Model behaviour: first user message (bootstrap) → acknowledge; then
    // catalogue → "TotalScript is ready"; then build request → execute_luau; then
    // tool result → done.
    let phase = 0;
    const cmd = (name, params) => "```json\n" + JSON.stringify({ command: name, params }) + "\n```";
    onUserMessage = async (text) => {
      phase++;
      if (TASKS && phase >= 3) {
        if (phase === 3) await replyWith("Let me take the next task.\n" + cmd("task_next", {}));
        else if (phase === 4) await replyWith("Creating the part now.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\nprint(\"OK\")\n###END_LUA###");
        else if (phase === 5) await replyWith("Verified. Marking it done.\n" + cmd("task_update", { id: "#1", status: "done", notes: "SimPart created in Workspace" }));
        else await replyWith("Task 1 is done; task 2 is next whenever you want.");
        return;
      }
      if (PUBLIC && phase >= 3) {
        if (phase === 3) await replyWith("I'll build that as a public skill.\n" + cmd("public_skill_create", { definition: { kind: "skill", name: "lantern_row", title: "Lantern Row", description: "Places a row of anchored lantern parts with PointLights next to a target instance.", params: [{ name: "path", type: "string", description: "Full path of the parent", required: true }, { name: "count", type: "number", description: "How many lanterns", default: 3 }], luau: "local target = game\nfor seg in string.gmatch({{path}}, '[^.]+') do target = target:FindFirstChild(seg) if not target then return {ok=false, error='missing ' .. seg} end end\nlocal made = 0\nfor i = 1, {{count}} do local p = Instance.new('Part') p.Name = 'Lantern_' .. i p.Anchored = true p.Parent = target made += 1 end\nreturn {ok=true, created=made}", triggers: ["lantern", "lamp row"], knowledge: "## When to use\nThe user wants a row of lanterns / lamps along something.\n## After running\nReport the created count; the verify block counts Lantern_* children.", verify: { luau: "local n = 0\nfor _, c in ipairs(find(args.path):GetChildren()) do if c.Name:match('^Lantern_') then n += 1 end end\ncheck(n >= args.count, 'expected ' .. args.count .. ' lanterns, found ' .. n)\nreturn {ok = true, detail = n .. ' lanterns found'}", note: "counts Lantern_* parts under the target" } } }));
        else if (phase === 4) await replyWith("Installed. Let me try it.\n" + cmd("lantern_row", { path: "Workspace", count: 2 }));
        else if (phase === 5) await replyWith("Now the work mode.\n" + cmd("public_skill_create", { definition: { kind: "mode", title: "Horror Builder", badge: "HORROR", base: "visualizer", description: "Builds dread: fog, flicker, low light and sound layers.", mandate: "You are a horror ambience specialist. Every scene must have Atmosphere fog, low ambient light, at least one flickering light source and a sound layer; verify with a screenshot after each pass and never leave a scene fully lit.", focus: ["execute_luau", "get_studio_state"] } }));
        else if (phase === 6) await replyWith("Understood - modes are gone. Proving the skill instead.\n" + cmd("public_skill_test", { name: "lantern_row", dry_run: false, args: { path: "Workspace", count: 2 } }));
        else await replyWith("Done — Lantern Row is installed and VERIFIED.");
        return;
      }
      if (HELP && phase >= 3) {
        if (phase === 3) await replyWith("Let me check how this build does it.\n" + cmd("totalscript_help", { question: "how do templates work in totalscript?" }));
        else await replyWith("Templates are reusable task recipes saved in the TotalScript menu. Done.");
        return;
      }
      if (SHOT && phase >= 3) {
        if (phase === 3) await replyWith("Let me look at the viewport first.\n" + cmd("total_screenshot", { target: "studio" }));
        else if (phase === 4) await replyWith("Now the raw tool.\n" + cmd("screen_capture", {}));
        else await replyWith("I can see the viewport. Done.");
        return;
      }
      if (STATE && phase >= 3) {
        const lua = 'local part = Instance.new("Part")\npart.Name = "StatePart"\npart.Size = Vector3.new(4, 1, 2)\npart.Anchored = true\npart.Parent = workspace\nprint("created", part:GetFullName())\nreturn part:GetFullName()';
        if (phase === 3) await replyWith("First I'll inspect the place.\n" + cmd("get_studio_state", {}));
        else if (phase === 4) {
          if (STATE === 1) await replyWith("The place is a Baseplate with 400 parts. Creating the part now.\n" + cmd("execute_luau", { code: lua, datamodel_type: "Edit" }));
          else if (STATE === 2) await replyWith("The place is a Baseplate with 400 parts. Creating the part now.\n```json\n{\"command\": \"execute_luau\", \"params\": {\"code\": \"" + lua.replace(/"/g, '\\"') + "\", \"datamodel_type\": \"Edit\"}}\n```");
          else if (STATE === 3) await replyWith("The place is a Baseplate with 400 parts. Creating the part now.\n```json\n{\"command\": \"execute_luau\", \"params\": {\"code\": \"```lua\\n" + lua.replace(/"/g, '\\"').replace(/\n/g, "\\n") + "\\n```\"}}\n```");
          // STATE=4: raw ###LUA### marker with a bled-in fence language tag on
          // its own line (a code-block header bled into the copy) - parser bug 2 in 1.23.1.
          else await replyWith("The place is a Baseplate with 400 parts. Creating the part now.\n```\n###LUA###\nlua\n" + lua + "\n###END_LUA###\n```");
        }
        else await replyWith("Done — StatePart was created in Workspace.");
        return;
      }
      if (CREW && phase >= 3) {
        // Crew protocol: planner → (guarded mutation) → builder → build → done (refused) → done.
        if (phase === 3) await replyWith("Planning first.\n" + cmd("total_agent", { role: "planner", task: "plan the request" }));
        else if (phase === 4) await replyWith("Let me just build it.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\n###END_LUA###");
        else if (phase === 5) await replyWith("Handing off.\n" + cmd("total_agent", { role: "builder", goal: "SimPart in Workspace", plan: ["Create SimPart", "Verify it"], step: 1, task: "create the part" }));
        else if (phase === 6) await replyWith("Creating the part now.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\nprint(\"OK\")\n###END_LUA###");
        else if (phase === 7) await replyWith("Finishing.\n" + cmd("total_agent", { role: "done", summary: "SimPart created" }));
        else if (phase === 8) await replyWith("Verifying as tester.\n" + cmd("total_agent", { role: "tester", task: "verify", step_done: 2 }));
        else if (phase === 9) await replyWith("Reading the console.\n" + cmd("total_debug", {}));
        else if (phase === 10) await replyWith("Finishing.\n" + cmd("total_agent", { role: "done", summary: "SimPart created and verified" }));
        else await replyWith("Done — SimPart was created in Workspace and verified.");
        return;
      }
      if (phase === 1) {
        await replyWith("Understood. I will start by loading the command catalogue.\n```json\n{\"command\":\"list_commands\"}\n```");
      } else if (phase === 2) {
        await replyWith("TotalScript is ready. Tell me what to build in Roblox Studio.");
      } else if (phase === 3) {
        await replyWith("Creating the part now.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\nprint(\"OK\")\n###END_LUA###");
      } else if (phase === 4) {
        await replyWith("Done — SimPart was created in Workspace.");
      } else {
        await replyWith("Noted.");
      }
    };
    // 1.40.0 Beginner mode: before Start, the getting-started card is a LIVE
    // checklist - bridge / Studio / place already green from the stubbed bridge,
    // "Press Start" is the highlighted next step.
    {
      const card = d.getElementById("rs-setup");
      const steps = card ? [...card.querySelectorAll("#rs-setup-steps li")] : [];
      ok("getting-started card shows 4 live steps with Start as the next one", !!card && !card.hidden && steps.length === 4 && steps.slice(0, 3).every((li) => li.classList.contains("rs-step-ok")) && steps[3].classList.contains("rs-step-now") && steps[3].dataset.step === "start" && /3\/4/.test(card.querySelector("#rs-setup-progress")?.textContent || ""), steps.map((li) => li.className + ":" + li.dataset.step).join(" | "));
      ok("the next step carries a one-click fix (Start) and no starters yet", !!card?.querySelector('[data-setup-fix="start"]') && card?.querySelector("#rs-setup-starters")?.hidden === true);
    }
    startBtn.click();
    log("clicked Start");
    await waitFor(() => userMessages.length >= 1, 20000, "bootstrap send");
    ok("bootstrap prompt sent to the site", /TotalScript|ROBLOX|Roblox/i.test(userMessages[0]), userMessages[0].length + " chars");
    ok("bootstrap carries no coding-memory / session-recap block (removed 1.39.1)", !/My coding memory|Recent sessions \(auto-recorded/.test(userMessages[0]));
    await waitFor(() => userMessages.length >= 2, 30000, "catalogue reply send");
    ok("catalogue result typed back", /list_commands|commands|Output/i.test(userMessages[1]), userMessages[1].slice(0, 80).replace(/\n/g, " "));
    await waitFor(() => /Agent running|Restart/i.test(bar.textContent || ""), 30000, "session ready");
    ok("session marked started", true, "bar=" + (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120));
    {
      try { await waitFor(() => (w.__rsSetupSteps ? w.__rsSetupSteps() : []).every((st) => st.ok), 20000, "setup steps all ok"); } catch (e) { log("setup steps did not all turn ok:", String(e)); }
      const card = d.getElementById("rs-setup");
      const chips = card ? [...card.querySelectorAll("[data-setup-starter]")] : [];
      ok("after Start the card is all green and offers 3 starter requests", !!card && !card.hidden && card.classList.contains("rs-setup-ready") && chips.length === 3 && /4\/4/.test(card.querySelector("#rs-setup-progress")?.textContent || ""), (card?.querySelector("#rs-setup-sub")?.textContent || "") + " chips=" + chips.length);
      if (chips[0]) {
        const ed = ta;
        const before = ed ? ed.value : "";
        chips[0].click(); await sleep(150);
        const after = ed ? ed.value : "";
        ok("clicking a starter types the request into the composer and closes the card", after.length > before.length && /lobby/i.test(after) && card.hidden === true && storage.rsSetupSeen === true, after.slice(0, 60).replace(/\n/g, " "));
        if (ed && typeof ed.value === "string") { ed.value = ""; ed.dispatchEvent(new w.Event("input", { bubbles: true })); }
      }
    }
    // The user types a request.
    await sleep(800);
    ta.value = "Create a part named SimPart";
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(100);
    ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await sleep(100);
    if (userMessages.length < 3) { sendBtn.click(); }
    await waitFor(() => userMessages.length >= 3, 5000, "user request send");
    // ASK=1: the old "Ask" permission state was removed in 1.99.5 - a stored
    // rsPermMode "ask" must read as Sandbox only, and no approval card may
    // appear for Studio tools (they run directly; only publish ops ask).
    const approvals = [];
    if (process.env.ASK) {
      ok("a stored rsPermMode 'ask' reads as Sandbox only (1.99.5 migration)", w.__rsPermMode && w.__rsPermMode() === "sandbox", w.__rsPermMode && w.__rsPermMode());
      setInterval(() => {
        const root = d.getElementById("rs-approve");
        if (!root || root.hidden) return;
        const op = (d.getElementById("rs-approve-body") || {}).textContent || "";
        if (approvals.length && approvals[approvals.length - 1].at > Date.now() - 900) return;
        approvals.push({ op: op.slice(0, 40), at: Date.now() });
        setTimeout(() => { const allow = d.getElementById("rs-approve-allow"); if (allow && !root.hidden) allow.click(); }, 1000);
      }, 200);
    }
    if (STATE) {
      await waitFor(() => userMessages.length >= 4, 40000, "get_studio_state result");
      if (process.env.ASK) ok("read-only get_studio_state did not ask for approval", approvals.length === 0, JSON.stringify(approvals));
      ok("get_studio_state result typed back", /Baseplate|Output of 'get_studio_state'/.test(userMessages[3]), userMessages[3].length + " chars: " + userMessages[3].slice(0, 90).replace(/\n/g, " "));
      await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && /StatePart/.test(String(c.arguments.code || ""))), 60000, "execute_luau after get_studio_state");
      const ex = toolCalls.find((c) => c.name === "execute_luau" && /StatePart/.test(String(c.arguments.code || "")));
      ok("execute_luau code arrived with real newlines", /\n/.test(ex.arguments.code) && !/\\n/.test(ex.arguments.code) && !/```/.test(ex.arguments.code), JSON.stringify(ex.arguments.code).slice(0, 120));
      ok("execute_luau code has no leftover fence tag / Copy chrome line", !/^(?:lua|luau|json|copy)\s*$/im.test(ex.arguments.code.split("\n")[0]) && /^local part/.test(ex.arguments.code), JSON.stringify(ex.arguments.code.split("\n")[0]));
      await waitFor(() => userMessages.length >= 5, 40000, "execute_luau result");
      ok("execute_luau result fed back", /Output of 'execute_luau'|OK/.test(userMessages[4]), userMessages[4].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      ok("agent loop ended after the final text reply", true);
      ok("exactly one StatePart execute_luau ran", toolCalls.filter((c) => c.name === "execute_luau" && /StatePart/.test(String(c.arguments.code || ""))).length === 1);
      if (process.env.ASK) ok("execute_luau ran without an approval card (Sandbox only never asks); the card element is still mounted and hidden for publish ops", approvals.length === 0 && !!d.getElementById("rs-approve") && d.getElementById("rs-approve").hidden === true, JSON.stringify(approvals));
      ok("no TotalScript-internal flags leaked to the bridge", !toolCalls.some((c) => Object.keys(c.arguments || {}).some((k) => /^_total/.test(k))), JSON.stringify(toolCalls.map((c) => Object.keys(c.arguments || {}))));
      await sleep(1000);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (TASKS) {
      ok("bootstrap carries the task list block with the open tasks", /TASK LIST \(user-enabled; 0\/2 done\)/.test(userMessages[0]) && /\[ \] #1 Create a part named SimPart/.test(userMessages[0]) && /\[ \] #2 Add a PointLight to it/.test(userMessages[0]), userMessages[0].length + " chars");
      ok("catalogue lists task_* commands while enabled", /task_next/.test(userMessages[1]) && /task_update/.test(userMessages[1]));
      const pill = d.getElementById("rs-task-pill");
      ok("bar shows the Tasks 0/2 pill", !!pill && !pill.hidden && pill.textContent === "Tasks 0/2", pill && pill.textContent);
      await waitFor(() => userMessages.length >= 4, 40000, "task_next result");
      ok("task_next returned task #1 and marked it doing", /"n": 1/.test(userMessages[3]) && /"status": "doing"/.test(userMessages[3]) && /Create a part named SimPart/.test(userMessages[3]), userMessages[3].slice(0, 160).replace(/\n/g, " "));
      ok("state line carries TASKS 0/2 and the next task", /TASKS 0\/2 next #1 "Create a part named SimPart"/.test(userMessages[3]), (userMessages[3].match(/\[SYSTEM_STATE:[^\]]*\]/) || [""])[0].slice(0, 200));
      await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || ""))), 40000, "execute_luau");
      await waitFor(() => userMessages.length >= 6, 40000, "task_update result");
      ok("task_update marked #1 done and points at #2", /"status": "done"/.test(userMessages[5]) && /"next": "#2 Add a PointLight to it"/.test(userMessages[5]), userMessages[5].slice(0, 200).replace(/\n/g, " "));
      ok("pill updated to Tasks 1/2", pill.textContent === "Tasks 1/2" && pill.dataset.done === "open", pill.textContent);
      ok("storage persisted the task state", storage.rsTaskList && storage.rsTaskList.enabled === true && storage.rsTaskList.tasks[0].status === "done" && storage.rsTaskList.tasks[0].notes === "SimPart created in Workspace");
      // Tasks tab in the cards panel
      pill.click(); await sleep(250);
      const rows = [...d.querySelectorAll(".rs-task-row")];
      ok("Tasks tab lists both tasks with #1 done", rows.length === 2 && rows[0].classList.contains("rs-task-done") && /Add a PointLight/.test(rows[1].textContent), rows.map((r) => r.className).join(" | "));
      ok("Tasks tab has add input, Run next and Run all", !!d.getElementById("rs-task-input") && !!d.querySelector("[data-task-run-next]") && !!d.querySelector("[data-task-run-all]"));
      // Settings toggle: disable → tab + pill + tools gone, tasks kept.
      const menuBtn = d.getElementById("rs-settings-btn"); if (menuBtn) { menuBtn.click(); await sleep(250); }
      ok("Settings has no Themes or Coding memory section (removed 1.39.1)", !d.querySelector(".rs-theme-sec") && !d.querySelector("[data-theme-card]") && !d.querySelector(".rs-memory-sec") && !d.getElementById("rs-mem-save") && !d.getElementById("rs-mem-recap") && !!d.querySelector('.rs-tgl-row[data-mode="bgmode"]'));
      // 1.40.0 Beginner mode: Settings opens in the SIMPLE view (advanced rows
      // carry .rs-adv and the tray carries .rs-menu-simple); the switch flips it
      // and persists; Help has a "Getting-started checklist" button.
      {
        const menu = d.getElementById("rs-menu");
        const adv = d.querySelector('.rs-tgl-row[data-mode="advanced"]');
        const advRows = [...d.querySelectorAll("#rs-menu .rs-adv")];
        ok("Settings opens in the simple view with advanced rows tagged", !!menu && menu.classList.contains("rs-menu-simple") && !!adv && adv.getAttribute("aria-checked") === "false" && advRows.length >= 6 && advRows.some((r) => r.dataset.mode === "tasklist") && advRows.some((r) => r.classList.contains("rs-keybind-sec")) && !!d.getElementById("rs-menu-setup"), "adv rows=" + advRows.length);
        if (adv) { adv.click(); await sleep(250); }
        const menu2 = d.getElementById("rs-menu");
        const adv2 = d.querySelector('.rs-tgl-row[data-mode="advanced"]');
        ok("'Show advanced settings' reveals everything and persists", !!menu2 && !menu2.classList.contains("rs-menu-simple") && !!adv2 && adv2.getAttribute("aria-checked") === "true" && storage.rsSettingsAdvanced === true);
        const setupBtn = d.getElementById("rs-menu-setup");
        if (setupBtn) { setupBtn.click(); await sleep(200); }
        const card = d.getElementById("rs-setup");
        ok("Help → Getting-started checklist reopens the card even after it was dismissed", !!card && card.hidden === false && !!card.querySelector("#rs-setup-steps li"), card && card.className);
        const close = d.getElementById("rs-setup-close"); if (close) { close.click(); await sleep(100); }
        if (menuBtn) { menuBtn.click(); await sleep(250); }
      }
      const tgl = d.querySelector('.rs-tgl-row[data-mode="tasklist"]');
      ok("Settings has the Task list toggle, currently on", !!tgl && tgl.getAttribute("aria-checked") === "true", tgl && tgl.getAttribute("aria-checked"));
      if (tgl) { tgl.click(); await sleep(250); }
      ok("disabling hides the pill and keeps the tasks", pill.hidden && storage.rsTaskList.enabled === false && storage.rsTaskList.tasks.length === 2);
      ok("task_* commands refuse while disabled", /disabled/.test(w.eval("TotalTaskList").run("task_list", {})));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      await sleep(800);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (PUBLIC) {
      ok("bootstrap advertises Public Skills", /PUBLIC SKILLS/.test(userMessages[0]) && /public_skill_create/.test(userMessages[0]), userMessages[0].length + " chars");
      await waitFor(() => userMessages.length >= 4, 40000, "public_skill_create result");
      ok("public_skill_create installed the skill", /"status": "INSTALLED"/.test(userMessages[3]) && /"name": "lantern_row"/.test(userMessages[3]) && !/Internal loop error|is not defined/.test(userMessages[3]), userMessages[3].slice(0, 160).replace(/\n/g, " "));
      ok("install modal shown to the user", !!d.querySelector(".rs-public-installed"), String(d.querySelector(".rs-public-installed") && d.querySelector(".rs-public-installed").textContent).slice(0, 80));
      await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && /public skill 'lantern_row'/.test(String(c.arguments.code || ""))), 40000, "lantern_row execute_luau");
      const ex = toolCalls.find((c) => c.name === "execute_luau" && /public skill 'lantern_row'/.test(String(c.arguments.code || "")));
      ok("lantern_row ran as execute_luau with params injected as Lua literals", /local args = \{\["path"\]="Workspace",\["count"\]=2\}/.test(ex.arguments.code) && /string\.gmatch\("Workspace"/.test(ex.arguments.code) && /for i = 1, 2 do/.test(ex.arguments.code), ex.arguments.code.split("\n").slice(0, 4).join(" | ").slice(0, 200));
      ok("no TotalScript-internal flags leaked to the bridge", !Object.keys(ex.arguments).some((k) => /^_total/.test(k)), JSON.stringify(Object.keys(ex.arguments)));
      await waitFor(() => userMessages.length >= 5, 40000, "lantern_row result");
      ok("result is labelled with the public skill's name", /^Output of 'lantern_row'/.test(userMessages[4]) && !/Output of 'execute_luau'/.test(userMessages[4]), userMessages[4].slice(0, 100).replace(/\n/g, " "));
      ok("the unverified result is flagged for the model (callable, but says so)", /UNVERIFIED/.test(userMessages[4]), userMessages[4].slice(0, 200).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 6, 40000, "mode create result");
      ok("2.20.0: a custom work mode is REFUSED with the retirement message (nothing installed, no mode storage)", /VALIDATION_FAILED/.test(userMessages[5]) && /kind 'mode' was retired in 2\.20\.0/.test(userMessages[5]) && !/"status": "INSTALLED"/.test(userMessages[5]) && !w.PublicSkills.find("horror_builder"), userMessages[5].slice(0, 200).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 7, 40000, "public_skill_test result");
      const verifyCall = toolCalls.find((c) => c.name === "execute_luau" && /^-- TotalScript public skill 'lantern_row' v\d+ - VERIFY/.test(String(c.arguments.code || "")));
      ok("public_skill_test {dry_run:false} ran the command, then the verify block as a second execute_luau with args + the command's result injected", !!verifyCall && /local args = \{\["path"\]="Workspace",\["count"\]=2\}/.test(verifyCall.arguments.code) && /local result = \{\["ok"\]=true,\["created"\]=2\}/.test(verifyCall.arguments.code) && /Lantern_/.test(verifyCall.arguments.code), verifyCall ? verifyCall.arguments.code.split("\n").slice(0, 5).join(" | ").slice(0, 240) : "no verify call");
      ok("the verify pass makes the skill VERIFIED (result says so, registry records it)", /"status": "VERIFIED"/.test(userMessages[6]) && /"verification": "verified"/.test(userMessages[6]) && /2 lanterns found/.test(userMessages[6]) && w.PublicSkills.verification("lantern_row").state === "verified", userMessages[6].slice(0, 200).replace(/\n/g, " "));
      const badge = d.getElementById("rs-work-badge");
      ok("bar badge stays on the built-in mode (no custom-mode glue left): Totality, no public mode accessor", !!badge && w.__rsWorkMode() === "creation" && badge.textContent !== "HORROR" && typeof w.__rsPublicMode !== "function", badge && badge.textContent + " / " + w.__rsWorkMode());
      const sysPrompt = (() => { try { return w.eval("RS").buildSystemPrompt({ siteName: "GLM", providerId: "glm" }); } catch (e) { return "ERR " + e; } })();
      const catBlock = w.PublicSkills.catalogueBlock({ compact: false });
      ok("system prompt keeps the static PUBLIC SKILLS section and no custom-mode section; the live catalogue block (list_commands) lists the verified skill with its signature and no UNVERIFIED tag", /PUBLIC SKILLS/.test(sysPrompt) && !/CUSTOM WORK MODE/.test(sysPrompt) && !/Custom work modes available/.test(sysPrompt) && /PUBLIC SKILLS - 1 user-made skill \(1 command\)/.test(catBlock) && /^lantern_row \{path, count\?\} - /m.test(catBlock) && !/lantern_row[^\n]*\[UNVERIFIED\]/.test(catBlock), catBlock.slice(0, 200));
      // Public tab in the cards panel lists both items.
      const cardsBtn = d.getElementById("rs-cards-btn") || [...d.querySelectorAll("#rs-bar button")].find((b) => /cards|library|templates/i.test(b.getAttribute("aria-label") || b.title || b.textContent || ""));
      if (cardsBtn) { cardsBtn.click(); await sleep(200); const tab = d.querySelector('.rs-cards-tab[data-tab="public"]'); if (tab) { tab.click(); await sleep(200); } }
      const rows = [...d.querySelectorAll(".rs-public-row")];
      ok("Public tab lists the one skill with the VERIFIED badge (no mode card)", rows.length === 1 && /Lantern Row/.test(rows[0].textContent) && !!rows[0].querySelector(".rs-public-verify-verified") && !rows.some((r) => /Horror Builder/.test(r.textContent)), rows.map((r) => r.textContent.replace(/\s+/g, " ").slice(0, 60)).join(" || ") || "cardsBtn=" + !!cardsBtn);
      ok("Public tab has the prompt composer", !!d.getElementById("rs-public-prompt") && !!d.querySelector("[data-public-create]"));
      ok("registry stored the skill (with its tested record) and no mode key", Array.isArray(storage.rsPublicSkills) && storage.rsPublicSkills.length === 1 && storage.rsPublicSkills[0].tested && storage.rsPublicSkills[0].tested.level === "verified" && /2 lanterns found/.test(storage.rsPublicSkills[0].tested.detail) && storage.rsPublicMode === undefined);
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      ok("agent loop ended after the final text reply", true);
      await sleep(800);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (HELP) {
      await waitFor(() => userMessages.length >= 4, 40000, "totalscript_help result");
      ok("totalscript_help answered without an Internal loop error", !/Internal loop error|is not defined|ERROR/.test(userMessages[3]) && /Output of 'totalscript_help'/.test(userMessages[3]), userMessages[3].slice(0, 160).replace(/\n/g, " "));
      ok("totalscript_help resolved the templates topic", /"topic": "templates"/.test(userMessages[3]) && /"agentStarted": false/.test(userMessages[3]), userMessages[3].slice(0, 120).replace(/\n/g, " "));
      ok("totalscript_help executed nothing in Studio (only the read-only work-mode probes ran)", !toolCalls.some((c) => c.name === "execute_luau" && !/GetLogHistory|IsRunning\(\)|TotalScript mode probe/.test(String(c.arguments && c.arguments.code || ""))), JSON.stringify(toolCalls.map((c) => c.name + ":" + String(c.arguments && c.arguments.code || "").slice(0, 30))));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      ok("agent loop ended after the final text reply", true);
      await sleep(800);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (SHOT) {
      await waitFor(() => userMessages.length >= 4, 40000, "total_screenshot result");
      const caps = () => toolCalls.filter((c) => c.name === "screen_capture");
      ok("total_screenshot resolved a studio_id through list_roblox_studios", toolCalls.some((c) => c.name === "list_roblox_studios") && caps().length >= 1 && caps()[caps().length - 1].arguments.studio_id === "studio-7f3a", JSON.stringify(caps().map((c) => c.arguments)));
      ok("total_screenshot delivered the image instead of 'Missing required arg'", !/Missing required arg|INVALID_ARGUMENT/.test(userMessages[3]) && /captur|image|attached/i.test(userMessages[3]), userMessages[3].slice(0, 120).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 5, 40000, "screen_capture result");
      ok("raw screen_capture {} also carries the studio_id", caps().length >= 2 && caps().every((c) => c.arguments.studio_id === "studio-7f3a"), JSON.stringify(caps().map((c) => c.arguments)));
      ok("raw screen_capture result is the image, not an error", !/Missing required arg|INVALID_ARGUMENT/.test(userMessages[4]) && /image|captur/i.test(userMessages[4]), userMessages[4].slice(0, 120).replace(/\n/g, " "));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      await sleep(1000);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    if (CREW) {
      ok("bootstrap carries the crew protocol", /MULTI-AGENT/.test(userMessages[0]) && /ROLE GUARD/.test(userMessages[0]));
      await waitFor(() => userMessages.length >= 4, 30000, "planner handoff result");
      ok("total_agent planner handoff shows the board", /CREW HANDOFF #1/.test(userMessages[3]) && /ROLE=planner/.test(userMessages[3]), userMessages[3].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 5, 30000, "guarded mutation result");
      // The role guard must keep the PLANNER's SimPart Luau off the bridge. The
      // work-mode preflight's read-only probes (RunService:IsRunning(), console
      // read) are also execute_luau calls and legitimately run at this point -
      // count only Luau that carries the planner's mutation (gemini/claude-e2e
      // filter the same probes out of their "model Luau" counts).
      const plannerLuau = () => toolCalls.filter((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments && c.arguments.code || "")));
      ok("planner mutation refused by the role guard, nothing executed", /ROLE GUARD/.test(userMessages[4]) && plannerLuau().length === 0, userMessages[4].slice(0, 100).replace(/\n/g, " ") + " | planner luau on bridge: " + plannerLuau().length);
      await waitFor(() => userMessages.length >= 6, 30000, "builder handoff result");
      ok("builder handoff shows GOAL + PLAN", /GOAL: SimPart in Workspace/.test(userMessages[5]) && /1\. \[>\] Create SimPart/.test(userMessages[5]));
      const badge = d.getElementById("rs-crew-badge");
      ok("bar shows the crew badge for the builder", !!badge && !badge.hidden && badge.textContent === "BUILD", badge && badge.textContent);
      await waitFor(() => plannerLuau().length >= 1, 30000, "builder execute_luau");
      await waitFor(() => userMessages.length >= 8, 30000, "done refused");
      ok("done is refused before verification", /NOT DONE YET/.test(userMessages[7]) && /TESTER has not verified/.test(userMessages[7]), userMessages[7].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => userMessages.length >= 11, 45000, "done accepted");
      ok("tester verification unlocks done", /run verified/.test(userMessages[9]) && /CREW DONE/.test(userMessages[10]), userMessages[10].slice(0, 100).replace(/\n/g, " "));
      await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
      ok("agent loop ended after the final text reply", true);
      ok("exactly one SimPart execute_luau ran", toolCalls.filter((c) => c.name === "execute_luau" && /SimPart/.test(c.arguments.code)).length === 1);
      await sleep(1500);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || ""))), 30000, "execute_luau call");
    ok("execute_luau executed from the model reply", toolCalls.some((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || ""))), JSON.stringify(toolCalls.find((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || ""))).arguments).slice(0, 120));
    await waitFor(() => userMessages.length >= 4, 30000, "tool feedback send");
    ok("tool result fed back to the site", /OK|SimPart|Output/.test(userMessages[3]), userMessages[3].slice(0, 100).replace(/\n/g, " "));
    await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
    const endEv = (w.__rsDiag || []).filter((e) => e.event === "loop.end").pop();
    ok("agent loop ended after the final text reply", !!endEv, JSON.stringify(endEv && endEv.data).slice(0, 160));
    ok("no duplicate execute_luau", toolCalls.filter((c) => c.name === "execute_luau" && /SimPart/.test(c.arguments.code)).length === 1);
    await sleep(1500);
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
  } catch (e) {
    console.error("SCENARIO FAILED:", e && e.stack || e);
    process.exitCode = 1;
    const bar = d.getElementById("rs-bar");
    console.error("bar text:", bar && (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300));
    console.error("userMessages:", userMessages.length, "toolCalls:", toolCalls.length);
    console.error("diag tail:", (w.__rsDiagTail || []).slice(-15));
  } finally {
    finish("core-e2e" + TAG, pageErrors);
  }
})();
