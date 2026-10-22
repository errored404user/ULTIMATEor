// 1.63.0 — Reasoning effort setting (low · mid · high · max · ultimate) with a
// native "think more" mode per provider (src/core/reasoning.js + Settings tray).
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-reasoning-effort.js
"use strict";
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const main = read("src/core/main.js"), cfg = read("src/core/config.js"), css = read("overlay.css"), manifest = JSON.parse(read("manifest.json")), html = read("codecraft.html"), cc = read("src/providers/codecraft.js");
const OR = require(path.join(R, "src/core/reasoning.js"));
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) passed++; else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 600) : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. levels ─────────────────────────────────────────────────────────────────
ok("five levels low → ultimate in order", OR.LEVEL_IDS.join(",") === "low,mid,high,max,ultimate");
ok("legacy / odd values normalise", OR.normalize("default") === "mid" && OR.normalize("ULTIMATE") === "ultimate" && OR.normalize("maximum") === "max" && OR.normalize(undefined) === "mid" && OR.normalize("garbage") === "mid");
ok("rank / atLeast", OR.atLeast("ultimate", "high") && OR.atLeast("high", "high") && !OR.atLeast("mid", "high") && OR.rank("low") === 0);
ok("every level has name / short / sub copy", OR.LEVELS.every((l) => l.name && l.short && l.sub.length > 20));

// ── 2. per-provider mode tables ───────────────────────────────────────────────
const pick = (p, l, o) => OR.modeFor(p, l, o).label;
ok("ChatGPT: Instant → Thinking → Thinking → Think pill → Pro", [pick("chatgpt", "low"), pick("chatgpt", "mid"), pick("chatgpt", "high"), pick("chatgpt", "max"), pick("chatgpt", "ultimate")].join("|") === "Instant|Thinking|Thinking|Think (per message)|Pro");
ok("Gemini: Fast → Thinking → Thinking → Pro → Deep Think", [pick("gemini", "low"), pick("gemini", "mid"), pick("gemini", "high"), pick("gemini", "max"), pick("gemini", "ultimate")].join("|") === "Fast|Thinking|Thinking|Pro|Deep Think");
ok("DeepSeek / Qwen / Kimi / GLM: off below high, on from high", ["deepseek", "qwen", "kimi", "glm"].every((p) => OR.modeFor(p, "mid").rule.on === false && OR.modeFor(p, "high").rule.on === true && OR.modeFor(p, "ultimate").rule.on === true));
ok("Claude: extended thinking from high", pick("claude", "mid") === "Normal" && pick("claude", "high") === "Extended thinking");
ok("CodeCraft: reasoning_effort hook values", OR.modeFor("codecraft", "low").rule.value === "low" && OR.modeFor("codecraft", "mid").rule.value === "" && OR.modeFor("codecraft", "max").rule.value === "high" && OR.modeFor("codecraft", "ultimate").rule.kind === "hook");
ok("Arena / NVIDIA / unknown sites are prompt-only (never click anything)", OR.modeFor("arena", "ultimate").rule.kind === "none" && OR.modeFor("nvidia", "max").rule.kind === "none" && OR.modeFor("notion", "high").rule.kind === "none" && !OR.hasNative("notion") && !OR.hasNative("arena") && OR.hasNative("chatgpt"));
ok("every declared provider maps all five levels to a declared mode", Object.keys(OR.PROVIDERS).every((p) => OR.LEVEL_IDS.every((l) => OR.PROVIDERS[p].modes.some((m) => m.id === OR.PROVIDERS[p].map[l]))));
ok("override per provider per level + 'off' + unknown override falls back", pick("chatgpt", "ultimate", { chatgpt: { ultimate: "instant" } }) === "Instant" && OR.modeFor("chatgpt", "ultimate", { chatgpt: { ultimate: "instant" } }).overridden === true && OR.modeFor("chatgpt", "low", { chatgpt: { low: "off" } }).rule.kind === "none" && pick("chatgpt", "low", { chatgpt: { low: "nope" } }) === "Instant" && pick("chatgpt", "mid", { chatgpt: { ultimate: "instant" } }) === "Thinking");
ok("table() lists five rows with options for the UI", (() => { const t = OR.table("gemini", {}); return t.length === 5 && t[4].mode.id === "deepthink" && t[0].options.length === 4; })());

// ── 3. evidence gate ──────────────────────────────────────────────────────────
const g = (lvl, tools, st) => { const r = OR.gate(lvl, new Set(tools), st || {}); return r ? r.id : null; };
ok("low / mid: no gate", g("low", ["script_set_source"]) === null && g("mid", ["script_set_source"]) === null);
ok("high: mutated without read-back → verify; verified → nothing", g("high", ["script_set_source"]) === "verify" && g("high", ["script_set_source", "script_read"]) === null && g("high", ["script_read"]) === null);
ok("max: verify first, then one final review", g("max", ["script_set_source"]) === "verify" && g("max", ["script_set_source", "script_read"]) === "review" && g("max", ["script_set_source", "script_read"], { review: true }) === null);
ok("ultimate: verify → audit (playtest / console) → review, each once", g("ultimate", ["ui_build_spec"]) === "verify" && g("ultimate", ["ui_build_spec", "or_screenshot"]) === "audit" && g("ultimate", ["ui_build_spec", "or_screenshot", "or_debug"]) === "review" && g("ultimate", ["ui_build_spec", "or_screenshot", "or_debug"], { review: true }) === null && g("ultimate", ["ui_build_spec", "or_screenshot"], { audit: true }) === "review");
ok("read-only runs (inspect / list) never trigger the gate", g("ultimate", ["inspect_instance", "ui_layout_report", "animation_validate", "list_commands"]) === null);
ok("gate texts are OR system notes that forbid acknowledging", ["verify", "audit", "review"].every((id) => { const r = OR.gate("ultimate", new Set(["script_set_source", "script_read", "or_debug"]), { verify: id !== "verify", audit: id !== "audit" && id !== "verify" ? true : id === "review", review: false }); return !r || /System note from OR, not the user/.test(r.text); }));

// ── 4. apply() against fake composers in jsdom ────────────────────────────────
function page(body) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: "https://example.test/", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 80, height: 30, top: 0, left: 0, right: 80, bottom: 30 }; };
  w.eval(read("src/core/reasoning.js"));
  return w;
}
(async () => {
  // toggle: DeepSeek-like button exposing aria-pressed
  {
    const w = page(`<form><textarea id="ed"></textarea><button type="button" id="dt" aria-pressed="false">DeepThink</button><button type="button" aria-pressed="false">Search</button></form><div id="rs-root"><button aria-pressed="false">DeepThink</button></div>`);
    const d = w.document; const btn = d.getElementById("dt"); let clicks = 0;
    btn.addEventListener("click", () => { clicks++; btn.setAttribute("aria-pressed", btn.getAttribute("aria-pressed") === "true" ? "false" : "true"); });
    const P = { id: "deepseek", getEditor: () => d.getElementById("ed") };
    const r1 = await w.ORReasoning.apply(P, w.ORReasoning.modeFor("deepseek", "ultimate"), { settleMs: 10 });
    ok("toggle: clicks DeepThink on and verifies the state", r1.ok && r1.how === "clicked" && r1.verified === true && clicks === 1 && btn.getAttribute("aria-pressed") === "true", r1);
    const r2 = await w.ORReasoning.apply(P, w.ORReasoning.modeFor("deepseek", "ultimate"), { settleMs: 10 });
    ok("toggle: already on → no second click", r2.ok && r2.how === "already" && clicks === 1, r2);
    const r3 = await w.ORReasoning.apply(P, w.ORReasoning.modeFor("deepseek", "low"), { settleMs: 10 });
    ok("toggle: low effort switches DeepThink back off", r3.ok && r3.how === "clicked" && btn.getAttribute("aria-pressed") === "false" && clicks === 2, r3);
    ok("the copy inside #rs-root was never considered", d.querySelector("#rs-root button").getAttribute("aria-pressed") === "false");
  }
  // toggle: control missing → honest failure, nothing clicked
  {
    const w = page(`<form><textarea id="ed"></textarea><button type="button" id="other" aria-pressed="false">Think about whether to deep think later</button></form>`);
    const d = w.document; let clicks = 0; d.getElementById("other").addEventListener("click", () => clicks++);
    const r = await w.ORReasoning.apply({ id: "deepseek", getEditor: () => d.getElementById("ed") }, w.ORReasoning.modeFor("deepseek", "high"), { settleMs: 10 });
    ok("toggle: no exact-label control → ok:false control-not-found and no stray click", r.ok === false && r.reason === "control-not-found" && clicks === 0, r);
  }
  // picker: ChatGPT-like model menu
  {
    const w = page(`<header><button type="button" id="trig" aria-haspopup="menu" aria-label="Model selector, current model is Thinking">ChatGPT Thinking</button></header><main><form><textarea id="ed"></textarea></form></main><div id="menu"></div>`);
    const d = w.document; const trig = d.getElementById("trig"); let picked = "";
    trig.addEventListener("click", () => {
      const m = d.getElementById("menu"); m.innerHTML = `<div role="menu"><div role="menuitemradio">Instant</div><div role="menuitemradio">Thinking</div><div role="menuitemradio">Pro</div></div>`;
      m.querySelectorAll("[role=menuitemradio]").forEach((it) => it.addEventListener("click", () => { picked = it.textContent; m.innerHTML = ""; trig.setAttribute("aria-label", "Model selector, current model is " + picked); trig.textContent = "ChatGPT " + picked; }));
    });
    const P = { id: "chatgpt", getEditor: () => d.getElementById("ed") };
    const r1 = await w.ORReasoning.apply(P, w.ORReasoning.modeFor("chatgpt", "ultimate"), { settleMs: 10 });
    ok("picker: opens the model menu and picks Pro", r1.ok && r1.how === "picked" && picked === "Pro", r1);
    const r2 = await w.ORReasoning.apply(P, w.ORReasoning.modeFor("chatgpt", "ultimate"), { settleMs: 10 });
    ok("picker: trigger already shows Pro → 'already', menu not reopened", r2.ok && r2.how === "already" && d.getElementById("menu").innerHTML === "", r2);
    const r3 = await w.ORReasoning.apply(P, w.ORReasoning.modeFor("chatgpt", "low"), { settleMs: 10 });
    ok("picker: low effort picks Instant", r3.ok && picked === "Instant", r3);
  }
  // picker: item missing → menu closed again, ok:false
  {
    const w = page(`<header><button type="button" id="trig" aria-label="Model selector">GPT</button></header><form><textarea id="ed"></textarea></form><div id="menu"></div>`);
    const d = w.document; const trig = d.getElementById("trig"); let opens = 0;
    trig.addEventListener("click", () => { opens++; const m = d.getElementById("menu"); m.innerHTML = m.innerHTML ? "" : `<div role="menuitemradio">Something else</div>`; });
    const r = await w.ORReasoning.apply({ id: "chatgpt", getEditor: () => d.getElementById("ed") }, w.ORReasoning.modeFor("chatgpt", "ultimate"), { settleMs: 10 });
    ok("picker: wanted item absent → ok:false item-not-found and the menu is closed again", r.ok === false && r.reason === "item-not-found" && opens === 2 && d.getElementById("menu").innerHTML === "", r);
  }
  // hook: provider implements setReasoningMode
  {
    const w = page(`<div></div>`); let got = null;
    const r = await w.ORReasoning.apply({ id: "codecraft", setReasoningMode: async (id, rule) => { got = { id, value: rule.value }; return { ok: true, how: "hook" }; } }, w.ORReasoning.modeFor("codecraft", "max"));
    ok("hook: P.setReasoningMode receives the mode + reasoning_effort value", r.ok && r.how === "hook" && got && got.id === "high" && got.value === "high", { r, got });
    const r2 = await w.ORReasoning.apply({ id: "arena" }, w.ORReasoning.modeFor("arena", "ultimate"));
    ok("prompt-only providers resolve instantly without touching the DOM", r2.ok && r2.how === "prompt-only");
  }

  // ── 5. wiring pins ──────────────────────────────────────────────────────────
  const lists = manifest.content_scripts.map((c) => c.js).filter((js) => js.includes("src/core/main.js"));
  ok("manifest: reasoning.js loads after animstudio.js and before main.js in all 16 bundles", lists.length === 16 && lists.every((js) => { const a = js.indexOf("src/core/animstudio.js"), r = js.indexOf("src/core/reasoning.js"), m = js.indexOf("src/core/main.js"); return a >= 0 && r === a + 1 && m > r; }));
  ok("codecraft.html loads reasoning.js before main.js", html.indexOf('<script src="src/core/reasoning.js"></script>') > html.indexOf('<script src="src/core/animstudio.js"></script>') && html.indexOf('<script src="src/core/reasoning.js"></script>') < html.indexOf('<script src="src/core/main.js"></script>'));
  ok("codecraft.js exposes setReasoningMode → reasoning_effort setting", /async setReasoningMode\(modeId, rule\) \{/.test(cc) && /await saveSettings\(\{ reasoning: v \}\);/.test(cc) && /body\.reasoning_effort = settings\.reasoning/.test(cc));
  ok("config.js: ULTIMATE prompt block + header renamed to REASONING EFFORT", /ultimate: "ULTIMATE THINKING \(no shortcuts\): \(1\) PLAN/.test(cfg) && cfg.includes("━━━ REASONING EFFORT: ${lvl.toUpperCase()} (user setting) ━━━") && /start_stop_play \+ get_console_output \(or or_debug\), then quality_audit/.test(cfg));
  ok("main.js: storage (rsThinkingLevel + rsReasoningModes), setters and hooks", /chrome\.storage\.local\.get\(\["rsThinkingLevel", "rsReasoningModes"\]/.test(main) && /function setThinkingLevel\(v, opts\)/.test(main) && /function setReasoningModeOverride\(providerId, level, modeId\)/.test(main) && /window\.__rsSetThinkingLevel = \(v\) => setThinkingLevel\(v\);/.test(main) && /window\.__rsApplyReasoning = \(reason\) => applyNativeReasoning\(reason \|\| "loop"\);/.test(main) && /changes\.rsReasoningModes/.test(main));
  ok("main.js: Settings section = effort dial (5 stops) + boost chips + focus lenses + standing rule + prompt preview; NO model picker / site switch anywhere (1.63)", /function reasoningSectionHtml\(\)/.test(main) && main.includes("${reasoningSectionHtml()}") && /class="rs-effort-dial" data-level=/.test(main) && /class="rs-effort-stop \$\{thinkingLevel === l\.id \? "on" : ""\} \$\{i < idx \? "lit" : ""\}" data-effort="\$\{l\.id\}"/.test(main) && /data-effort-boost="\$\{c\.key\}" aria-pressed=/.test(main) && /class="rs-effort-profile" data-level=/.test(main) && /data-effort-focus="\$\{f\.id\}"/.test(main) && /class="rs-effort-rule-in" data-effort-rule="1" maxlength="240"/.test(main) && /<details class="rs-effort-preview rs-adv"><summary>What the AI is told \(advanced\)<\/summary><pre class="rs-effort-pre">/.test(main) && /prompt steering only/.test(main) && /your model stays/.test(main) && !/select class="rs-effort-mode"/.test(main) && !/rs-effort-all/.test(main) && !/data-effort-apply/.test(main) && !/data-effort-reset/.test(main) && !/Leave the site as it is/.test(main) && !/rs-effort-card/.test(main));
  ok("main.js: dial walks with the arrow keys", /ArrowRight" \|\| e\.key === "ArrowUp"/.test(main) && /setThinkingLevel\(to\)/.test(main));
  ok("reasoning.js: every level carries a profile for the chips + PROFILE_KEYS export", /PROFILE_KEYS = \[\["plan", "Plan"\]/.test(read("src/core/reasoning.js")) && /profile: \{ plan: "full plan", critique: "5\+ flaws", loops: "up to 5"/.test(read("src/core/reasoning.js")));
  ok("main.js: dial / boost / focus / rule handlers", /menuEl\.querySelectorAll\("\[data-effort\]"\)/.test(main) && /menuEl\.querySelectorAll\("\[data-effort-boost\]"\)/.test(main) && /menuEl\.querySelectorAll\("\[data-effort-focus\]"\)/.test(main) && /menuEl\.querySelectorAll\("input\[data-effort-rule\]"\)/.test(main) && /function toggleEffortBoost\(key\)/.test(main) && /function toggleEffortFocus\(id\)/.test(main) && /function setEffortExtras\(patch, opts\)/.test(main) && /chrome\.storage\.local\.get\(\["rsEffortExtras"\]/.test(main) && /window\.__rsEffortExtras = \(\) => effortExtras;/.test(main));
  ok("main.js: the site's model / think mode is NEVER switched by ORscript (1.63) - no apply at Start, at loop start or on setting change; the routine is inert without an explicit opt-in", !/__rsApplyReasoning\("start"\)/.test(main) && !/__rsApplyReasoning\("loop"\)/.test(main) && !/applyNativeReasoning\("setting"\)/.test(main) && !/applyNativeReasoning\("override"\)/.test(main) && /if \(window\.__rsAllowSiteSwitch !== true\) \{ _nativeApplied = \{/.test(main) && /prompt only - your model stays as it is/.test(main));
  ok("config.js: REASONING_NOTES hoisted + exported for the preview, promptExtras appended after the level note", /const REASONING_NOTES = \{/.test(cfg) && /const lvlNote = REASONING_NOTES\[lvl\];/.test(cfg) && /ORReasoning\.promptExtras\(lvl, window\.__rsEffortExtras && window\.__rsEffortExtras\(\)\)/.test(cfg) && /\n    REASONING_NOTES,\n/.test(cfg));
  ok("reasoning.js: 1.63 power-ups exported (FOCUS 8 lenses, BOOST_TEXT 8, cleanExtras / effectiveProfile / promptExtras / extrasCount) and gate() honours boosts", (() => { const R = require(path.join(__dirname, "..", "src/core/reasoning.js")); const ex = { boost: { proof: 1, critique: 1 }, focus: ["perf", "ask", "bogus"], rule: "  Always   use typed Luau  " }; const c = R.cleanExtras(ex); const pe = R.promptExtras("mid", ex); const prof = R.effectiveProfile("mid", ex); return R.FOCUS.length === 8 && Object.keys(R.BOOST_TEXT).length === 8 && c.focus.join() === "perf,ask" && c.rule === "Always use typed Luau" && /BOOSTED \(the user forced these on at Medium\):\n- CRITIQUE: .*\n- PROOF: /.test(pe) && /FOCUS LENSES \(check these specifically in every review pass\):\n- PERFORMANCE: /.test(pe) && /STANDING RULE \(the user's own, always applies\): Always use typed Luau/.test(pe) && prof.find((x) => x.key === "proof").boosted && prof.find((x) => x.key === "proof").value === "play+console" && prof.find((x) => x.key === "critique").value === "5+ flaws" && !prof.find((x) => x.key === "plan").on && R.extrasCount(ex) === 5 && R.promptExtras("ultimate", { boost: { proof: 1 } }) === "" && !!R.gate("mid", new Set(["script_create"]), {}, { boost: { readback: 1 } }) && R.gate("mid", new Set(["script_create"]), {}, {}) === null && R.gate("mid", new Set(["script_create"]), { verify: true }, { boost: { proof: 1 } }).id === "audit"; })());
  ok("main.js: effort evidence gate in the text branch, after the work-mode gate, before 'complete'", (() => { const i = main.indexOf("const nudge = modeGateNudge(A.runTools);"), j = main.indexOf("g = ORReasoning.gate(window.__rsThinkingLevel && window.__rsThinkingLevel(), A.runTools, effortGate, window.__rsEffortExtras && window.__rsEffortExtras());"), k = main.indexOf('ui.steeringProgress("complete", toolTurns ?'); return i > 0 && j > i && k > j && /const effortGate = \{ verify: false, audit: false, review: false \};/.test(main) && /diag\("loop\.effortGate"/.test(main); })());
  ok("main.js never contains the legacy work-mode literal", !main.includes('"ultimate"'));
  ok("overlay.css styles the dial (rail, fill from --p, stops, pulsing Ultimate dot), the profile chips, the site line and the selects", /\.rs-effort-fill \{[^}]*width: calc\(var\(--p, 1\) \/ 4 \* 100%\)/.test(css) && /\.rs-effort-stops \{ position: relative; display: grid; grid-template-columns: repeat\(5, 1fr\); \}/.test(css) && /\.rs-effort-stop\[data-effort="ultimate"\]\.on \.rs-effort-dot \{[^}]*animation: rs-effort-pulse/.test(css) && /@keyframes rs-effort-pulse/.test(css) && /\.rs-effort-chips \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/.test(css) && /\.rs-effort-chip\.on \{/.test(css) && /\.rs-effort-profile\[data-level="ultimate"\] \{/.test(css) && /\.rs-effort-site \{/.test(css) && /\.rs-effort-chip\.boost \{/.test(css) && /\.rs-effort-lens\.on \{/.test(css) && /\.rs-effort-rule-in \{/.test(css) && /\.rs-effort-pre \{/.test(css) && !/\.rs-effort-mode \{/.test(css) && !/\.rs-effort-all/.test(css) && !/\.rs-effort-line/.test(css) && !/\.rs-effort-site-go/.test(css) && !/\.rs-effort-row \{/.test(css) && !/\.rs-effort-card/.test(css));

  // ── 6. real page walk (codecraft.html bundle) ───────────────────────────────
  {
    const pageHtml = read("codecraft.html");
    const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
    const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
    const w = dom.window, d = w.document;
    Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true }); Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
    Object.defineProperty(d, "hidden", { value: false, configurable: true }); Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
    w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} }; };
    w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
    Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return 860; }, configurable: true });
    Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; }, configurable: true });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return d.body; }, configurable: true });
    Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
    w.HTMLElement.prototype.scrollIntoView = function () {}; w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
    w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16); w.cancelAnimationFrame = (id) => clearTimeout(id);
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.elementFromPoint = d.elementFromPoint = () => null; d.execCommand = () => false;
    w.HTMLCanvasElement.prototype.getContext = () => null;
    if (!w.crypto) w.crypto = require("crypto").webcrypto;
    w.Audio = class { play() { return Promise.resolve(); } pause() {} }; w.AudioContext = undefined;
    w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
    w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" };
    w.URL.createObjectURL = () => "blob:harness"; w.URL.revokeObjectURL = () => {};
    w.open = () => null; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
    const storage = {};
    const storageApi = () => ({
      get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
      set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
      remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    });
    const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
    const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true }; case "studio_status": return { ok: true, studio: true }; case "call_tool": return { ok: true, text: "ok" }; default: return { ok: true, tools: TOOLS }; } };
    w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {} }, lastError: null, getManifest: () => manifest }, storage: { local: storageApi(), sync: storageApi(), session: storageApi(), onChanged: { addListener() {} } }, tabs: { create() {} } };
    storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
    storage.rsThinkingLevel = "default"; // legacy value → Medium
    storage.rsSettingsAdvanced = true;
    w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
    const pageErrors = []; w.onerror = (m) => { pageErrors.push(String(m)); };
    for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
    async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }
    try {
      await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
      await sleep(700);
      ok("walk: legacy stored 'default' level reads back as mid", w.__rsThinkingLevel() === "mid", w.__rsThinkingLevel());
      const supportBtn = d.getElementById("rs-support-btn") || d.getElementById("rs-settings-btn");
      if (supportBtn) { supportBtn.click(); await sleep(150); }
      const menu = d.getElementById("rs-menu");
      const cards = menu ? [...menu.querySelectorAll(".rs-effort-stop")] : [];
      ok("walk: Settings shows the effort dial with five stops, Medium selected, Low lit behind it", cards.length === 5 && cards.map((c) => c.dataset.effort).join(",") === "low,mid,high,max,ultimate" && cards[1].classList.contains("on") && cards[1].getAttribute("aria-checked") === "true" && cards[0].classList.contains("lit") && !cards[2].classList.contains("lit") && menu.querySelector(".rs-effort-dial").getAttribute("style") === "--p:1", cards.map((c) => c.dataset.effort + (c.classList.contains("on") ? "*" : "")));
      ok("walk: the profile card lists what Medium does (critique + loops lit, proof / audit off) as boost toggles; no model picker anywhere", (() => { const chips = [...menu.querySelectorAll(".rs-effort-profile .rs-effort-chip")]; const on = chips.filter((c) => c.classList.contains("on")).map((c) => c.dataset.effortBoost); return chips.length === 8 && chips.every((c) => c.tagName === "BUTTON" && c.getAttribute("aria-pressed") === "false") && on.join(",") === "critique,loops" && /Medium/.test(menu.querySelector(".rs-effort-profile-head b").textContent) && !menu.querySelector(".rs-effort-sec select") && !menu.querySelector(".rs-effort-sec details.rs-effort-all"); })(), [...menu.querySelectorAll(".rs-effort-chip.on")].map((c) => c.dataset.effortBoost));
      const sec = menu && menu.querySelector(".rs-effort-sec");
      ok("walk: the section sits right after Work mode and before Access", (() => { const secs = [...menu.querySelectorAll(".rs-menu-sec")]; const i = secs.indexOf(sec); const labels = secs.map((s) => (s.querySelector(".rs-sec-label span") || {}).textContent || ""); return i > 0 && labels[i - 1] === "Work mode" && labels[i + 1] === "Access"; })());
      ok("walk: the site line says prompt steering only / your model stays, 8 focus lenses, a standing-rule input and the prompt preview are rendered", sec && /On CodeCraft API/.test(sec.querySelector(".rs-effort-site").textContent) && /prompt steering only/.test(sec.querySelector(".rs-effort-site-mode").textContent) && /your model stays/.test(sec.querySelector(".rs-effort-site-state").textContent) && sec.querySelectorAll(".rs-effort-lens").length === 8 && sec.querySelector("input[data-effort-rule]") && /REASONING EFFORT: MID \(user setting\)/.test(sec.querySelector(".rs-effort-pre").textContent) && /MID THINKING: after writing code/.test(sec.querySelector(".rs-effort-pre").textContent) && sec.querySelector("details.rs-effort-preview.rs-adv"));
      cards[4].click(); await sleep(250);
      ok("walk: clicking Ultimate stores rsThinkingLevel and updates the hook", storage.rsThinkingLevel === "ultimate" && w.__rsThinkingLevel() === "ultimate");
      const menu2 = d.getElementById("rs-menu");
      ok("walk: Ultimate stop is now selected, the dial is full, every chip lit and the state label says Ultimate", menu2.querySelector('.rs-effort-stop[data-effort="ultimate"]').classList.contains("on") && menu2.querySelector(".rs-effort-dial").getAttribute("style") === "--p:4" && menu2.querySelectorAll(".rs-effort-stop.lit").length === 4 && menu2.querySelectorAll(".rs-effort-chip.on").length === 8 && /play\+console/.test(menu2.querySelector('.rs-effort-chip[data-effort-boost="proof"]').textContent) && /Ultimate · no shortcuts/.test(menu2.querySelector(".rs-effort-sec .rs-sec-state").textContent));
      { const stop = menu2.querySelector('.rs-effort-stop[data-effort="ultimate"]'); stop.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); await sleep(250);
        ok("walk: ArrowLeft on the dial steps down to Max", w.__rsThinkingLevel() === "max" && d.getElementById("rs-menu").querySelector('.rs-effort-stop[data-effort="max"]').classList.contains("on"), w.__rsThinkingLevel());
        d.getElementById("rs-menu").querySelector('.rs-effort-stop[data-effort="max"]').dispatchEvent(new w.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); await sleep(250);
        ok("walk: End jumps back to Ultimate", w.__rsThinkingLevel() === "ultimate"); }
      await sleep(300);
      ok("walk: 1.63 - CodeCraft's reasoning_effort was NOT touched by the level change (ORscript never switches the site's model / mode)", !(storage.rsCodeCraft && storage.rsCodeCraft.reasoning), storage.rsCodeCraft);
      w.__rsSetThinkingLevel("mid"); await sleep(250);
      // boosts: pin Proof on at Medium
      d.getElementById("rs-menu").querySelector('.rs-effort-chip[data-effort-boost="proof"]').click(); await sleep(250);
      const m3 = d.getElementById("rs-menu");
      ok("walk: clicking the Proof chip at Medium boosts it on (stored in rsEffortExtras, chip lit + .boost, Ultimate's value shown, state label counts +1, preview carries the BOOSTED block)", storage.rsEffortExtras && storage.rsEffortExtras.boost && storage.rsEffortExtras.boost.proof === true && w.__rsEffortExtras().boost.proof === true && m3.querySelector('.rs-effort-chip[data-effort-boost="proof"]').classList.contains("boost") && /play\+console/.test(m3.querySelector('.rs-effort-chip[data-effort-boost="proof"]').textContent) && m3.querySelector('.rs-effort-chip[data-effort-boost="proof"]').getAttribute("aria-pressed") === "true" && /Medium · balanced · \+1/.test(m3.querySelector(".rs-effort-sec .rs-sec-state").textContent) && /BOOSTED \(the user forced these on at Medium\):\n- PROOF:/.test(m3.querySelector(".rs-effort-pre").textContent), { ex: storage.rsEffortExtras, state: m3.querySelector(".rs-effort-sec .rs-sec-state").textContent });
      // focus lenses
      m3.querySelector('.rs-effort-lens[data-effort-focus="security"]').click(); await sleep(200);
      d.getElementById("rs-menu").querySelector('.rs-effort-lens[data-effort-focus="mobile"]').click(); await sleep(200);
      const m4 = d.getElementById("rs-menu");
      ok("walk: two focus lenses toggle on, persist and appear in the preview", storage.rsEffortExtras.focus.join() === "security,mobile" && m4.querySelectorAll(".rs-effort-lens.on").length === 2 && /FOCUS LENSES[^]*- SECURITY: [^]*- MOBILE & UI: /.test(m4.querySelector(".rs-effort-pre").textContent) && /\+3/.test(m4.querySelector(".rs-effort-sec .rs-sec-state").textContent), storage.rsEffortExtras);
      // standing rule
      { const inp = m4.querySelector("input[data-effort-rule]"); inp.value = "Always use typed Luau"; inp.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(250); }
      const m5 = d.getElementById("rs-menu");
      ok("walk: the standing rule saves on change, survives the rebuild and lands in the preview", storage.rsEffortExtras.rule === "Always use typed Luau" && m5.querySelector("input[data-effort-rule]").value === "Always use typed Luau" && /STANDING RULE \(the user's own, always applies\): Always use typed Luau/.test(m5.querySelector(".rs-effort-pre").textContent));
      ok("walk: the real system prompt carries the level note + boost + lenses + rule (prompt-only steering)", (() => { try { const sp = w.eval("RS.buildSystemPrompt({})"); return /REASONING EFFORT: MID \(user setting\)/.test(sp) && /BOOSTED \(the user forced these on at Medium\)/.test(sp) && /- SECURITY: /.test(sp) && /STANDING RULE .*Always use typed Luau/.test(sp); } catch (e) { return "ERR " + e; } })() === true, (() => { try { const sp = w.eval("RS.buildSystemPrompt({})"); const i = sp.indexOf("REASONING EFFORT:"); return sp.slice(i, i + 400); } catch (e) { return String(e); } })());
      // unboost
      m5.querySelector('.rs-effort-chip[data-effort-boost="proof"]').click(); await sleep(200);
      ok("walk: clicking a boosted chip again removes the boost", !(storage.rsEffortExtras.boost && storage.rsEffortExtras.boost.proof) && !d.getElementById("rs-menu").querySelector('.rs-effort-chip[data-effort-boost="proof"]').classList.contains("boost"));
      w.__rsSetThinkingLevel("low"); await sleep(250);
      ok("walk: programmatic hook → Low persists; the site is still untouched", w.__rsThinkingLevel() === "low" && storage.rsThinkingLevel === "low" && !(storage.rsCodeCraft && storage.rsCodeCraft.reasoning), storage.rsCodeCraft);
      ok("walk: no page errors", pageErrors.length === 0, pageErrors.slice(0, 3));
    } catch (e) { ok("walk: completed", false, String(e && e.stack || e)); }
    try { dom.window.close(); } catch {}
  }
  console.log(`test-reasoning-effort: ${passed + failed} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
