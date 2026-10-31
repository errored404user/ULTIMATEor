// 1.72.0 — PROMPT ENHANCER: config.js request / focus / reply parser, the
// enhancer.js overlay (jsdom: open → enhance → preview → edit → send, cancel,
// insert, original), and its wiring in main.js / overlay.css / manifest /
// codecraft.html. The AI round trip is simulated through the hooks - nothing
// here talks to a provider. Run: NODE_PATH=/tmp/harness/node_modules node tests/test-enhancer.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const main = read("src/core/main.js"), css = read("overlay.css"), manifest = read("manifest.json"), codecraft = read("codecraft.html"), mod = read("src/core/enhancer.js");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log("FAIL", name, extra !== undefined ? "—" : "", extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); } };

// ── config.js ──────────────────────────────────────────────────────────────
global.window = global; global.chrome = { runtime: { getURL: () => "" }, storage: { local: { get() {}, set() {} } } };
vm.runInThisContext(read("src/core/config.js") + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
ok("config exports the enhancer surface", typeof RS.enhancerRequest === "function" && typeof RS.enhancerFocus === "function" && typeof RS.parseEnhanced === "function" && RS.ENHANCER_MARK === "⟦TotalScript PROMPT ENHANCER⟧" && RS.ENHANCED_OPEN === "<<<ENHANCED PROMPT>>>" && RS.ENHANCED_CLOSE === "<<<END ENHANCED PROMPT>>>");

const F = (text, engine) => RS.enhancerFocus({ text, engine: engine || "roblox" });
ok("focus: Studio wording → roblox", F("make me a shop gui") === "roblox" && F("fix the datastore script") === "roblox" && F("add a sword swing animation to my rig") === "roblox" && F("build a medieval house") === "roblox");
ok("focus: general questions / writing → general", F("what is the capital of France?") === "general" && F("write an email to my landlord") === "general" && F("explain quantum entanglement simply") === "general");
ok("focus: AgentScript (local) engine → general even for build wording", F("make a shop", "local") === "general");
ok("focus: ambiguous wording on the RS engine defaults to roblox; empty → roblox", F("do the thing") === "roblox" && F("") === "roblox");

const rb = RS.enhancerRequest({ rough: "make a shop", focus: "roblox", agentStarted: true, notes: "ask for a plan first" });
const gen = RS.enhancerRequest({ rough: "write an email", focus: "general", short: true });
ok("request starts with the mark and forbids doing / commanding / asking", rb.startsWith(RS.ENHANCER_MARK + " Rewrite the user's rough request below into ONE precise, complete prompt for a Roblox Studio AI agent") && rb.includes("Do NOT do the task, do NOT run any command or tool, do NOT ask questions"));
ok("request: agent-mode line only when the agent is started", rb.includes("no command block in this reply") && !gen.includes("no command block in this reply"));
ok("request: keeps intent + details, marks assumptions, user's voice, no preamble", rb.includes("keep the user's intent, scope and EVERY concrete detail") && rb.includes('mark it "(assumed)"') && rb.includes("write in the user's voice (first person, imperative), in the user's language") && rb.includes("no preamble, no commentary, no title"));
ok("roblox structure: GOAL / SCOPE / BEHAVIOUR & RULES / LOOK & FEEL / CONSTRAINTS / DONE WHEN, verified in Studio", ["GOAL - one sentence", "SCOPE - exactly what to build or change and where", "BEHAVIOUR & RULES", "server-authoritative", "LOOK & FEEL", "CONSTRAINTS", "DONE WHEN - observable checks the agent must verify in Studio"].every((s) => rb.includes(s)));
ok("general structure: GOAL / CONTEXT / REQUIREMENTS / CONSTRAINTS / OUTPUT FORMAT / DONE WHEN", ["GOAL - one sentence", "CONTEXT - who it is for", "REQUIREMENTS", "CONSTRAINTS - length, tone, language", "OUTPUT FORMAT", "DONE WHEN - how the user will judge"].every((s) => gen.includes(s)) && !gen.includes("Roblox Studio AI agent"));
ok("request: length rule, short switch, user guidance line", rb.includes("Length: as long as needed and no longer") && gen.includes("Length: compact - under 120 words.") && rb.includes("Extra guidance from the user for this rewrite: ask for a plan first") && !gen.includes("Extra guidance"));
ok("request: exact marker lines, then the rough text fenced in triple quotes", rb.endsWith('Reply with ONLY the improved prompt between these two exact lines:\n<<<ENHANCED PROMPT>>>\n...\n<<<END ENHANCED PROMPT>>>\n\nROUGH REQUEST:\n"""\nmake a shop\n"""'));
ok("request stays compact (< 2200 chars + rough)", rb.length - "make a shop".length < 2200, rb.length);
ok("GUI brief detector ignores enhancer requests", RS.detectGuiIntent(RS.enhancerRequest({ rough: "make me a shop gui", focus: "roblox" })).gui === false);

const P = (t) => RS.parseEnhanced(t);
ok("parse: markers win, chatter outside is dropped, inner fences stripped", (() => { const r = P("Sure!\n<<<ENHANCED PROMPT>>>\n```text\nGOAL - build a shop\nSCOPE - x\n```\n<<<END ENHANCED PROMPT>>>\nAnything else?"); return r.text === "GOAL - build a shop\nSCOPE - x" && r.source === "markers" && r.command === false; })());
ok("parse: open marker without close → rest of reply", (() => { const r = P("<<<ENHANCED PROMPT>>>\nGOAL - a\nSCOPE - b"); return r.text === "GOAL - a\nSCOPE - b" && r.source === "markers-open"; })());
ok("parse: single fenced block when the model forgot the markers", (() => { const r = P("Here you go:\n```\nGOAL - z\n```"); return r.text === "GOAL - z" && r.source === "fence"; })());
ok("parse: raw reply with a lead-in line stripped", (() => { const r = P("Here is the improved prompt:\nGOAL - x\nSCOPE - y"); return r.text === "GOAL - x\nSCOPE - y" && r.source === "raw"; })());
ok("parse: CRLF normalised, empty → none", P("<<<ENHANCED PROMPT>>>\r\nA\r\nB\r\n<<<END ENHANCED PROMPT>>>").text === "A\nB" && P("").source === "none" && P("   ").text === "");
ok("parse: a command instead of a rewrite is flagged (JSON and ###LUA### shapes)", P('```json\n{"command":"execute_luau","arguments":{}}\n```').command === true && P("###LUA###\nprint(1)\n###END_LUA###").command === true);
ok("parse: a clean marker-fenced prompt is kept even if the model also acted outside the markers", (() => { const r = P('{"command":"get_studio_state"}\n<<<ENHANCED PROMPT>>>\nGOAL - ok\n<<<END ENHANCED PROMPT>>>'); return r.command === false && r.text === "GOAL - ok"; })());

// ── registration + wiring ─────────────────────────────────────────────────
const m = JSON.parse(manifest);
const lists = m.content_scripts.map((c) => c.js).filter((js) => js.includes("src/core/main.js"));
ok("manifest: enhancer.js loads before main.js in every bundle", lists.length >= 10 && lists.every((js) => js.indexOf("src/core/enhancer.js") >= 0 && js.indexOf("src/core/enhancer.js") < js.indexOf("src/core/main.js")));
ok("codecraft.html loads enhancer.js before main.js", codecraft.indexOf('<script src="src/core/enhancer.js"></script>') > 0 && codecraft.indexOf('<script src="src/core/enhancer.js"></script>') < codecraft.indexOf('<script src="src/core/main.js"></script>'));
for (const s of [
  'id="rs-enhance-btn"', "(Ctrl+Shift+E)", 'root.querySelector("#rs-enhance-btn")', "window.__rsOpenEnhancer = openEnhancer;",
  "async function enhancePromptViaAI(rough, opts, onStatus)", "async function sendEnhancedPrompt(text, onStatus)", "async function fillComposer(text)",
  "TotalEnhancer.open({", "enhance: enhancePromptViaAI,", "send: sendEnhancedPrompt,", "insert: fillComposer,",
  "const ENHANCE_TIMEOUT_MS = 180000;", "const ENHANCE_STABLE_MS = 1200;",
  "RS.enhancerFocus({ text: rough, engine: activeEngine() })", "RS.enhancerRequest({ rough, focus, notes: o.notes, short: !!o.short, agentStarted: !!A.started })",
  "const parsed = RS.parseEnhanced(text);", 'if (parsed.command) throw new Error("the AI answered with a command instead of a rewrite',
  '(e.key === "E" || e.key === "e") && !e.altKey',
]) ok("main.js: " + s.slice(0, 70), main.includes(s), s);
ok("bar: enhancer button sits right before Paint", main.indexOf('id="rs-enhance-btn"') < main.indexOf('id="rs-paint-btn"') && main.indexOf('id="rs-paint-btn"') < main.indexOf('id="rs-settings-btn"'));
// The round trip is our own send: hooks must ignore it (A.injecting), and it must never start the agent or switch anything on the site.
// 1.73.0: the visible round trip moved into aiRoundTrip(request, {cancelled, kind}, onStatus)
// (shared with the Template Creator's AI draft); enhancePromptViaAI calls it. The body
// slice therefore starts at aiRoundTrip - the pinned behaviour is unchanged.
ok(main.indexOf("async function aiRoundTrip(request, opts, onStatus)") >= 0 && main.indexOf("async function aiRoundTrip") < main.indexOf("async function enhancePromptViaAI"), "aiRoundTrip is defined before enhancePromptViaAI");
const enhBody = main.slice(main.indexOf("async function enhancePromptViaAI"), main.indexOf("async function draftTemplateViaAI"));
ok(/return aiRoundTrip\(request, \{ cancelled: [^}]*kind: "enhance" \}, onStatus\)/.test(enhBody) || enhBody.includes("aiRoundTrip("), "enhancePromptViaAI delegates to aiRoundTrip");
const body = main.slice(main.indexOf("async function aiRoundTrip"), main.indexOf("function openEnhancer()"));
ok("round trip marks A.injecting around its own typeAndSend and releases it", body.includes("A.injecting = true;\n    let sent = false;\n    try {") && body.includes("sent = (await P.typeAndSend(request)) !== false;") && body.includes("setTimeout(() => { A.injecting = false; }, 400);"));
ok("round trip waits for busy / starting agent instead of interleaving", body.includes("if (A.running || A.injecting) {") && body.includes("const free = await waitFor(() => (!A.running && !A.injecting) || cancelled(), 600000);") && body.includes("if (A.starting) {"));
ok("round trip reads the NEW assistant turn only, waits for a stable non-generating read", body.includes("P.assistantCount() > base") && body.includes("if (!P.isGenerating() && cur.trim() && Date.now() - stableSince >= ENHANCE_STABLE_MS) { text = cur; break; }") && body.includes("if (cur && cur === prevText && P.assistantCount() <= base) continue;"));
ok("round trip surfaces site errors and empty replies honestly", body.includes("reported an error:") && body.includes('"the AI returned an empty reply"') && body.includes("no reply from ${P.displayName"));
ok("cancel stops a running generation and returns null (no result invented)", body.includes("if (cancelled()) { try { if (P.isGenerating()) P.stopGeneration(); } catch {} return null; }"));
ok("enhancer never starts the agent, never calls startSession, never touches reasoning / model switches", !body.includes("startSession(") && !body.includes("applyNativeReasoning") && !body.includes("__rsAllowSiteSwitch"));
const sendBody = main.slice(main.indexOf("async function sendEnhancedPrompt"), main.indexOf("async function fillComposer"));
ok("Send: running session → sendPainting path; agent off → plain message, no auto-start", sendBody.includes("if (A.started) return sendPainting(text, null, onStatus);") && sendBody.includes("const r = await P.typeAndSend(text); return r !== false;") && !sendBody.includes("startSession("));
const fillBody = main.slice(main.indexOf("async function fillComposer"), main.indexOf("function openEnhancer()"));
ok("Put in chat box: provider writeDraft first, then textarea value setter / insertText, verified by reading back", fillBody.includes('typeof P.writeDraft === "function"') && fillBody.includes('ed.dispatchEvent(new Event("input", { bubbles: true }));') && fillBody.includes('document.execCommand("insertText", false, value)') && fillBody.includes("return now.includes(value.slice(0, 40).trim());") && fillBody.includes("if (A.running || A.injecting || A.starting) return false;"));
for (const s of ["#rs-enhance {", "#rs-enhance.open {", "html.rs-enhance-open #rs-root { visibility: hidden !important; }", ".rse-shell {", ".rse-chip.on {", ".rse-btn.primary {", ".rse-result {", ".rse-status[data-kind=\"err\"]", "@media (max-width: 820px) { .rse-body { grid-template-columns: minmax(0, 1fr); }"])
  ok("overlay.css: " + s.slice(0, 60), css.includes(s), s);
ok("bar button styled with the other bar buttons (nests the pinned anim selector, keeps it intact)", (css.match(/:is\(:is\(:is\(#rs-settings-btn, #rs-paint-btn\), #rs-anim-btn\), #rs-enhance-btn\)/g) || []).length >= 20 && (css.match(/:is\(:is\(#rs-settings-btn, #rs-paint-btn\), #rs-anim-btn\)/g) || []).length >= 20);
ok("README documents the enhancer", read("README.md").includes("**1.72.0 — Prompt Enhancer: rough idea → precise prompt, reviewed by you.**") && read("README.md").includes("Ctrl/⌘+Shift+E"));

// ── overlay in jsdom ───────────────────────────────────────────────────────
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", pretendToBeVisual: true, url: "https://chatgpt.com/" });
const w = dom.window;
const store = {};
w.chrome = { runtime: { getURL: (p) => "chrome-extension://x/" + p }, storage: { local: { get: (k, cb) => cb && cb({ rsEnhancer: { focus: "general", short: true } }), set(o) { Object.assign(store, o || {}); } } } };
const errors = []; w.addEventListener("error", (e) => errors.push(String(e.message)));
const el = w.document.createElement("script"); el.textContent = mod; w.document.head.appendChild(el);
ok("enhancer.js loads without window errors", errors.length === 0, errors);
const E = w.TotalEnhancer;
ok("window.TotalEnhancer exported (open / close / isOpen / state / FOCUS)", E && ["open", "close", "isOpen", "state"].every((k) => typeof E[k] === "function") && E.FOCUS.map((f) => f.id).join() === "auto,roblox,general");

const sent = [], inserted = [], diags = [], toasts = [];
let draft = "make a shop", started = false, enhanceImpl = null;
const hooks = {
  draft: () => draft,
  enhance: (rough, opts, onStatus) => enhanceImpl(rough, opts, onStatus),
  send: async (t, s) => { sent.push(t); s && s("Sending…"); return true; },
  insert: async (t) => { inserted.push(t); return true; },
  engine: () => "roblox", agentStarted: () => started, providerName: () => "ChatGPT",
  toast: (x) => toasts.push(x), diag: (e, d) => diags.push([e, d]),
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
(async () => {
  E.open(hooks);
  const host = w.document.getElementById("rs-enhance");
  const q = (s) => host.querySelector(s);
  ok("open: dialog mounted, bar hidden class set, draft prefilled from the composer", host && host.classList.contains("open") && w.document.documentElement.classList.contains("rs-enhance-open") && q(".rse-rough").value === "make a shop" && E.isOpen());
  ok("open: button names the provider; result actions disabled until there is a result", q(".rse-go span").textContent === "Enhance with ChatGPT" && q(".rse-send").disabled && q(".rse-insert").disabled && q(".rse-copy").disabled && !q(".rse-go").disabled);
  await tick(5);
  ok("prefs restored from storage (focus chip + short)", q('.rse-chip[data-focus="general"]').classList.contains("on") && q(".rse-short").checked === true && E.state().focus === "general");
  ok("agent-off hint says Send is a plain message and does not start the agent", /Agent is off: Send posts the prompt as a plain chat message/.test(q(".rse-agent-hint").textContent));
  q('.rse-chip[data-focus="auto"]').click();
  ok("focus chip switches (aria radio)", E.state().focus === "auto" && q('.rse-chip[data-focus="auto"]').getAttribute("aria-checked") === "true" && q('.rse-chip[data-focus="general"]').getAttribute("aria-checked") === "false");
  q(".rse-notes").value = "ask for a plan first"; q(".rse-notes").dispatchEvent(new w.Event("input", { bubbles: true }));

  // enhance → preview
  let seenOpts = null, statuses = [];
  enhanceImpl = async (rough, opts, onStatus) => { seenOpts = opts; onStatus("Waiting for ChatGPT's rewrite…"); await tick(10); return { text: "GOAL - build a shop\nSCOPE - StarterGui.Shop (assumed)\nDONE WHEN - playtest clean", focus: "roblox", source: "markers" }; };
  q(".rse-go").click();
  ok("while busy: inputs locked, Cancel shown, status live", q(".rse-rough").disabled && !q(".rse-cancel").hidden && q(".rse-go").hidden && /Waiting for ChatGPT/.test(q(".rse-status").textContent));
  await tick(30);
  ok("hooks.enhance got the rough text + focus / short / notes / cancelled()", seenOpts && seenOpts.focus === "auto" && seenOpts.short === true && seenOpts.notes === "ask for a plan first" && typeof seenOpts.cancelled === "function" && seenOpts.cancelled() === false);
  ok("result lands in the editable preview, actions enabled, meta shows words + focus", q(".rse-result").value.startsWith("GOAL - build a shop") && !q(".rse-send").disabled && !q(".rse-insert").disabled && !q(".rse-copy").disabled && /\d+ words · Roblox focus/.test(q(".rse-meta").textContent) && /Ready in/.test(q(".rse-status").textContent) && !q(".rse-rough").disabled);
  ok("nothing was sent by the enhance step itself", sent.length === 0 && inserted.length === 0);

  // edit → send (agent off → still goes through hooks.send, which main.js routes as a plain message)
  q(".rse-result").value = q(".rse-result").value + "\nCONSTRAINTS - keep my existing Coins leaderstat";
  q(".rse-result").dispatchEvent(new w.Event("input", { bubbles: true }));
  q(".rse-send").click();
  await tick(20);
  ok("Send: the EDITED text is what goes out, dialog closes, toast", sent.length === 1 && sent[0].endsWith("CONSTRAINTS - keep my existing Coins leaderstat") && !E.isOpen() && toasts.includes("Enhanced prompt sent"));
  ok("diag trail: open → done → sent", diags.some(([e]) => e === "enhancer.open") && diags.some(([e, d]) => e === "enhancer.done" && d.focus === "roblox") && diags.some(([e]) => e === "enhancer.sent"));

  // reopen keeps the last result; "Use original" puts the rough text back; Put in chat box inserts + closes
  started = true; draft = "";
  E.open(hooks);
  ok("reopen keeps the result and the rough text when the composer is empty; agent-on hint", q(".rse-result").value.endsWith("Coins leaderstat") && q(".rse-rough").value === "make a shop" && /hands the prompt to the running TotalScript session/.test(q(".rse-agent-hint").textContent));
  q(".rse-back").click();
  ok("Use original replaces the result with the rough wording", q(".rse-result").value === "make a shop" && q(".rse-back").disabled);
  q(".rse-result").value = "make a shop, server-authoritative"; q(".rse-result").dispatchEvent(new w.Event("input", { bubbles: true }));
  q(".rse-insert").click(); await tick(10);
  ok("Put in chat box hands the text to hooks.insert (no send) and closes", inserted.length === 1 && inserted[0] === "make a shop, server-authoritative" && sent.length === 1 && !E.isOpen());

  // failure + cancel paths
  E.open(hooks);
  enhanceImpl = async () => { throw new Error("no reply from ChatGPT within 180s"); };
  q(".rse-go").click(); await tick(10);
  ok("enhance failure is shown, nothing sent, inputs unlocked", /Enhance failed: no reply from ChatGPT/.test(q(".rse-status").textContent) && q(".rse-status").dataset.kind === "err" && sent.length === 1 && !q(".rse-rough").disabled);
  enhanceImpl = async (rough, opts, onStatus) => { onStatus("Waiting…"); while (!opts.cancelled()) await tick(5); return null; };
  const before = q(".rse-result").value;
  q(".rse-go").click(); await tick(5);
  q(".rse-cancel").click(); await tick(30);
  ok("Cancel flips opts.cancelled(), status says Cancelled, result untouched", /Cancelled/.test(q(".rse-status").textContent) && q(".rse-result").value === before && !q(".rse-cancel").hidden === false);
  enhanceImpl = async () => ({ text: "   ", focus: "general", source: "none" });
  q(".rse-go").click(); await tick(10);
  ok("an empty rewrite is reported as a failure, not shown as a result", /returned nothing usable/.test(q(".rse-status").textContent) && q(".rse-result").value === before);

  // ── 1.88.0: modes, insight (hooks.analyze), previous version, checks + repair ──
  E.open(hooks);
  ok("mode chips: six radios (Auto default), hint line, insight hidden when there is no analyze hook", E.MODES.map((m) => m.id).join(",") === "auto,quick,expert,deep,creative,debug" && host.querySelectorAll('.rse-chip[data-mode]').length === 6 && q('.rse-chip[data-mode="auto"]').getAttribute("aria-checked") === "true" && E.state().mode === "auto" && q(".rse-insight").hidden);
  let analyzeCalls = [];
  hooks.analyze = (rough, o) => { analyzeCalls.push([rough, o]); return { mode: o.mode === "auto" ? "expert" : o.mode, modeAuto: o.mode === "auto", experts: [{ id: "gameplay_systems", title: "Gameplay systems", why: ["sword", "damage"] }], explain: "x", preserve: "MUST KEEP (found in the rough request; restate each one, never drop or invert): numbers: 25." };
  };
  q('.rse-chip[data-mode="debug"]').click();
  ok("picking a mode: chip + state + prefs persisted ({focus, short, mode}); analyze re-run with the mode; insight shows it as explicit (no '(auto)')", E.state().mode === "debug" && q('.rse-chip[data-mode="debug"]').classList.contains("on") && store.rsEnhancer && store.rsEnhancer.mode === "debug" && analyzeCalls.length >= 1 && analyzeCalls[analyzeCalls.length - 1][1].mode === "debug" && !q(".rse-insight").hidden && /^Mode: Debug & Repair  —  Expertise: Gameplay systems \(sword, damage\)  —  Will keep: numbers: 25\.$/.test(q(".rse-insight").textContent), q(".rse-insight").textContent);
  q('.rse-chip[data-mode="auto"]').click();
  ok("back to Auto: insight says '(auto)' and the resolved mode", /^Mode: Expert \(auto\)/.test(q(".rse-insight").textContent) && E.state().insight && E.state().insight.mode === "expert");
  const firstResult = q(".rse-result").value;
  enhanceImpl = async (rough, opts) => { seenOpts = opts; return { text: "GOAL - sword\nLOOK - include a gui", focus: "roblox", source: "markers", mode: "expert", experts: [{ id: "gameplay_systems", title: "Gameplay systems" }], checks: { ok: false, issues: [{ kind: "numbers", severity: "warn", text: "dropped numbers: 25" }, { kind: "preamble", severity: "info", text: "chatter" }], repaired: "GOAL - sword\nLOOK - include a gui\n\nCODE FROM MY REQUEST (keep exactly as written):\n```lua\nprint(1)\n```" } }; };
  q(".rse-go").click(); await tick(30);
  ok("hooks.enhance receives the mode; Re-enhance keeps the previous result (Previous version enabled)", seenOpts.mode === "auto" && E.state().prev === firstResult && !q(".rse-prev").disabled && q(".rse-result").value === "GOAL - sword\nLOOK - include a gui");
  ok("checks rendered next to the preview (severity per item, head says review), status points at them, meta names the mode", !q(".rse-checks").hidden && q(".rse-check-head").textContent === "Checks: review before sending" && host.querySelectorAll('.rse-check-list li[data-severity="warn"]').length === 1 && host.querySelectorAll('.rse-check-list li[data-severity="info"]').length === 1 && /see the checks, review, edit, then Send/.test(q(".rse-status").textContent) && q(".rse-status").dataset.kind === "warn" && /Expert/.test(q(".rse-meta").textContent) && E.state().last.checks.ok === false && E.state().last.experts[0].id === "gameplay_systems");
  q(".rse-repair").click();
  ok("Restore dropped code swaps in the repaired text, keeps the unrepaired one as Previous version, removes the repair button", /CODE FROM MY REQUEST/.test(q(".rse-result").value) && E.state().prev === "GOAL - sword\nLOOK - include a gui" && !q(".rse-repair") && !q(".rse-prev").disabled);
  q(".rse-prev").click();
  ok("Previous version swaps back (and forth) without touching the rough text", q(".rse-result").value === "GOAL - sword\nLOOK - include a gui" && /CODE FROM MY REQUEST/.test(E.state().prev) && q(".rse-rough").value === E.state().rough);
  q(".rse-result").value = "GOAL - sword, 25 damage, no gui"; q(".rse-result").dispatchEvent(new w.Event("input", { bubbles: true }));
  enhanceImpl = async () => { throw new Error("timed out"); };
  q(".rse-go").click(); await tick(10);
  ok("a failed Re-enhance keeps the edited result (status says so) and the rough text", /Enhance failed: timed out - your previous result is still here\./.test(q(".rse-status").textContent) && q(".rse-result").value === "GOAL - sword, 25 damage, no gui" && q(".rse-rough").value === E.state().rough);
  hooks.analyze = () => { throw new Error("boom"); };
  q('.rse-chip[data-mode="quick"]').click();
  ok("a throwing analyze hook is contained: insight hidden, dialog alive, mode still switches", q(".rse-insight").hidden && E.isOpen() && E.state().mode === "quick");
  delete hooks.analyze; q('.rse-chip[data-mode="auto"]').click();
  enhanceImpl = async () => ({ text: before, focus: "roblox", source: "markers" });
  q(".rse-go").click(); await tick(20);
  ok("a result without mode / experts / checks (older main.js shape) renders cleanly: no checks panel, plain Ready status", q(".rse-checks").hidden && /^Ready in [\d.]+s - review, edit, then Send\.$/.test(q(".rse-status").textContent) && q(".rse-result").value === before);

  // keyboard: Esc closes; Ctrl+Enter in the result = send
  host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok("Esc closes the dialog", !E.isOpen());
  E.open(hooks);
  const ev = new w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true });
  q(".rse-result").dispatchEvent(ev); await tick(20);
  ok("Ctrl+Enter in the result sends it", sent.length === 2 && sent[1] === before && !E.isOpen());

  console.log(`${fail ? "FAIL" : "OK"}    test-enhancer: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
