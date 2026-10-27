// 1.51.0 / 1.51.1 — GUI BRIEF: the custom message TotalScript sends the AI for a GUI
// request (detection in config.js; delivery by the agent loop + settings toggle
// in main.js; reference image protocol; system-prompt hook). 1.51.1: the user's
// composer is never rewritten - the brief rides on the first command result or
// goes out as its own message when the model answers without acting.
const fs = require("fs"), path = require("path"), vm = require("vm");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const config = read("src/core/config.js"), main = read("src/core/main.js");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log("FAIL", name, extra !== undefined ? "—" : "", extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ""); } };

global.window = global; global.chrome = { runtime: { getURL: () => "" }, storage: { local: { get() {}, set() {} } } };
vm.runInThisContext(config + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;

// ── detection ────────────────────────────────────────────────────────────────
ok("config exports GUI_BRIEF_MARK / detectGuiIntent / guiBrief", typeof RS.detectGuiIntent === "function" && typeof RS.guiBrief === "function" && RS.GUI_BRIEF_MARK === "⟦TotalScript GUI BRIEF⟧");
const D = (t) => RS.detectGuiIntent(t);
const positives = ["make me a shop gui", "create a shop", "make a health bar", "write the code for the shop ui", "Create a main menu for my game", "build this inventory screen like the screenshot", "fix my HUD, the coins label overlaps", "shop ui", "add a pause menu with resume and quit buttons for mobile", "recreate this UI 1:1 from the image", "bana bir dükkan arayüzü yap", "change the button color to red in my settings menu", "a loading screen pls", "I need a leaderboard UI", "design a daily rewards popup with 7 days", "can you make me a settings menu?", "Generate a HUD with health and coins", "Build the interface in the attached mockup"];
for (const t of positives) ok("GUI request detected: " + t, D(t).gui === true, D(t));
const negatives = ["what is a ScreenGui?", "write a datastore script", "write a script for the shop", "add a button to the door", "put a window in the wall", "make a sword tool", "how do I make a gui?", "no gui, just the server script for the shop", "make the door open with a button", "build a frame for the house", "spawn a part and tween it", "explain how UIListLayout works?", "", "GUI STUDIO HAND-OFF (TotalScript)\nmake it nice", RS.GUI_BRIEF_MARK + " already here, make a menu"];
for (const t of negatives) ok("not a GUI request: " + JSON.stringify(t).slice(0, 60), D(t).gui === false, D(t));
ok("edit flag: fixing / changing an existing GUI", D("fix my HUD, the coins label overlaps").edit === true && D("change the button color to red in my settings menu").edit === true && D("make me a shop gui").edit === false && D("make a new shop gui, fix the layout").edit === false);
ok("reference flag: screenshot / image / mockup / 1:1 wording", D("build this inventory screen like the screenshot").reference === true && D("recreate this UI 1:1 from the image").reference === true && D("Build the interface in the attached mockup").reference === true && D("make me a shop gui").reference === false);
ok("mobile flag", D("add a pause menu with resume and quit buttons for mobile").mobile === true && D("make me a shop gui").mobile === false);
ok("detection reports the GUI words it matched", D("make me a shop gui").words.includes("shop") && D("make me a shop gui").words.includes("gui"));

// ── the brief ────────────────────────────────────────────────────────────────
const base = RS.guiBrief({}), ref = RS.guiBrief({ reference: true, imageAttached: true }), refText = RS.guiBrief({ reference: true, imageAttached: false }), edit = RS.guiBrief({ edit: true }), mob = RS.guiBrief({ mobile: true });
ok("brief starts with the mark, says it is automatic and tells a model that already started to continue, not restart", base.startsWith(RS.GUI_BRIEF_MARK + " TotalScript's protocol for the user's GUI request above (automatic).") && base.includes("if you already started, continue from the matching step - do not undo good work, do not ask whether to proceed. Reply to THIS message with your next command, not an acknowledgement:"));
ok("1.51.2: every command the brief names exists (ui_set_props → ui_bulk_set / ui_set_property, shop_card → card)", edit.includes("ui_bulk_set / ui_set_property / ui_component / ui_align / ui_tokens_apply for the edits") && !edit.includes("ui_set_props") && base.includes("(window, tabs, card, health_bar, hotbar, toggle, dropdown, slider, toast, modal)") && !base.includes("shop_card"));
ok("1.51.2: the verify loop is bounded and a command error is not a restart", base.includes("quality_audit {path} ≥ 85 - at most TWO fix rounds, then hand off and report the score. A command error is not a reason to restart: read it, fix that call once, continue."));
ok("1.51.2: brief asks for a command in reply, not an acknowledgement", base.includes("Reply to THIS message with your next command, not an acknowledgement:"));
ok("1.51.2: FEEDBACK.guiBriefAct exists and allows one real question", typeof RS.FEEDBACK.guiBriefAct === "string" && RS.FEEDBACK.guiBriefAct.includes("The GUI BRIEF above is not a question - act on it now") && RS.FEEDBACK.guiBriefAct.includes("ask it in ONE line and stop"));
ok("brief speaks about 'the user' (it is TotalScript's message, not the user's)", !/\b(I|my|me)\b/.test(edit) && edit.includes("change ONLY what was asked"));
ok("brief: six numbered steps (understand → art direction → one-shot build → wire → verify → hand-off)", /\n1\. UNDERSTAND:/.test(base) && /\n2\. ART DIRECTION:/.test(base) && /\n3\. BUILD IN ONE SHOT:/.test(base) && /\n4\. WIRE IT:/.test(base) && /\n5\. VERIFY:/.test(base) && /\n6\. HAND-OFF:/.test(base));
ok("brief: builds through ui_build_spec {spec, replace:true} + ui_component, tokens, never Offset-only", base.includes("ONE ui_build_spec {spec, replace:true} tree") && base.includes("Use ui_component for ready widgets") && base.includes("design_tokens_set or ui_tokens_apply") && base.includes("never Offset-only sizing"));
ok("brief: verification with ui_layout_report, total_screenshot, quality_audit ≥ 85, phone preset + 58 px inset", base.includes("ui_layout_report {path}") && base.includes("total_screenshot") && base.includes("quality_audit {path} ≥ 85") && base.includes("58 px top inset"));
ok("brief: server-authoritative wiring", base.includes("server authoritative - the client never decides prices or rewards"));
ok("brief: no questions, infer and build", base.includes("Do not ask questions - infer sensible defaults and build."));
ok("reference image attached → step 0 REFERENCE READ with measurements, hex palette, typography, states, 1:1 rebuild and screenshot comparison", ref.includes("0. REFERENCE IMAGE IS ATTACHED - replicate it, do not reinterpret it.") && ref.includes("REFERENCE READ") && ref.includes("position and size as % of the screen") && ref.includes("palette as hex") && ref.includes("typography") && ref.includes("states shown") && ref.includes("rebuild it 1:1 with Scale positions that match the measured %") && ref.includes("total_screenshot and compare against the reference") && ref.includes("list every difference"));
ok("reference mentioned in text only → softer header, same protocol", refText.includes("0. A REFERENCE is given - replicate it, do not reinterpret it.") && refText.includes("REFERENCE READ") && !refText.includes("REFERENCE IMAGE IS ATTACHED"));
ok("no reference → no step 0", !base.includes("REFERENCE READ") && !/\n0\./.test(base));
ok("edit → read first with ui_export_spec and change only what was asked", edit.includes("1. READ FIRST: ui_list_tree / ui_export_spec {path}") && edit.includes("change ONLY what was asked") && !edit.includes("1. UNDERSTAND:"));
ok("mobile → touch targets ≥ 44 px, TextScaled max, safe areas", mob.includes("THIS MUST WORK ON TOUCH / SMALL SCREENS") && mob.includes("≥ 44 px") && mob.includes("TextScaled with a max size"));
// 1.51.2: +"reply with a command" header and the bounded verify loop (two fix rounds, errors are not restarts) - budget raised by exactly that much.
ok("brief stays compact: base < 2200 chars, everything on < 3400", base.length < 2200 && RS.guiBrief({ reference: true, imageAttached: true, edit: true, mobile: true }).length < 3400, [base.length, RS.guiBrief({ reference: true, imageAttached: true, edit: true, mobile: true }).length]);
ok("brief never contains code fences or tool-call markup (plain user text)", !/```|<tool_call|DSML/.test(ref));

// ── system prompt knows the brief ───────────────────────────────────────────
const full = RS.workModePrompt("creation");
ok("Creation prompt: GUI BRIEF sentence in the DESIGN mandate", full.includes('GUI BRIEF: an "TotalScript GUI BRIEF" block in a user message is that request\'s protocol - follow its steps in order.'));
ok("Creation prompt: UI SCREEN playbook routes through ui_build_spec + ui_layout_report", /- UI SCREEN: style_guide \{genre\} → design_tokens_set \{preset, primary, font\} from it → ui_build_spec \{spec\} \(ui_screen_generate \{kind\} for stock screens\) → ui_layout_report \+ ui_audit → quality_audit \{path\} ≥ 85 → total_screenshot → fix what it shows\./.test(full));
ok("Creation prompt still teaches the GUI STUDIO hand-off and stays under budget", full.includes('GUI STUDIO (1.48): a "GUI STUDIO HAND-OFF" message carries an exact spec') && full.length < 18500, full.length);

// ── main.js wiring ──────────────────────────────────────────────────────────
ok("send hook only NOTES the request (first thing in onUserMessage) - the composer is never rewritten", main.includes("    onUserMessage: (base) => {\n      // 1.51.1: GUI request → remember the GUI BRIEF; the loop delivers it with\n      // the first result (never by rewriting the composer).\n      A.guiBrief = null;\n      try { A.guiBrief = ui.noteGuiRequest(); } catch {}") && !main.includes("function attachGuiBrief()") && !/pasteLibraryCard\(\{ title: "GUI brief"/.test(main));
ok("noteGuiRequest: reads the composer, detects intent, skips when the mark is already there, returns a pending record", main.includes("function noteGuiRequest() {") && main.includes("if (!text.trim() || text.includes(RS.GUI_BRIEF_MARK)) return null;") && main.includes("const intent = RS.detectGuiIntent(text);") && main.includes("const brief = RS.guiBrief({ reference: intent.reference || imageAttached, imageAttached, edit: intent.edit, mobile: intent.mobile });") && main.includes("return { text: brief, intent, imageAttached, at: Date.now(), sent: false };"));
ok("noteGuiRequest respects the setting and tells the user what will be sent", main.includes("if (!guiBriefEnabled) return null;") && main.includes('"GUI brief ready — reference "') && main.includes('diag("guiBrief", { edit: intent.edit, reference: intent.reference, image: imageAttached, mobile: intent.mobile });'));
ok("loop: the brief rides on the FIRST command result (appended after the output, before the re-statement budget)", main.includes('          if (A.guiBrief && !A.guiBrief.sent) {\n            toSend += "\\n\\n" + A.guiBrief.text;\n            A.guiBrief.sent = true;\n            diag("guiBrief.sent", { via: "result" });') && main.indexOf('diag("guiBrief.sent", { via: "result" });') < main.indexOf('bumpSys("results");\n          // Ride the system-prompt re-statement out on this result'));
ok("loop: a command-less reply to a GUI request gets the brief as its own message, once, before the mode gate", main.includes('          if (A.guiBrief && !A.guiBrief.sent && !A.stop) {\n            A.guiBrief.sent = true;\n            diag("guiBrief.sent", { via: "text", toolTurns });') && main.includes('base = await submitAndGetBase(A.guiBrief.text + (state ? "\\n" + state : ""));\n            continue;') && main.indexOf('diag("guiBrief.sent", { via: "text", toolTurns });') < main.indexOf("// 1.38.0: MODE EVIDENCE GATE"));
ok("1.51.2 loop: after the brief, a prose-only reply with no command gets ONE act-now nudge (questions pass through)", main.includes("if (A.guiBrief && A.guiBrief.sent && !A.guiBrief.nudged && !A.stop && toolTurns === 0 && !/\\?\\s*$/.test(body.trim())) {") && main.includes("base = await submitAndGetBase(RS.FEEDBACK.guiBriefAct + (state ? \"\\n\" + state : \"\"));"));
ok("A.guiBrief state exists and a new user message resets it", main.includes("    guiBrief: null, // 1.51.1: pending GUI BRIEF") && main.includes("      A.guiBrief = null;\n      try { A.guiBrief = ui.noteGuiRequest(); } catch {}"));
ok("composerHasImage looks for attachment thumbnails / remove-attachment buttons around the composer form", main.includes("function composerHasImage() {") && main.includes('img[src^="blob:"], img[src^="data:image"], [data-testid*="attachment" i] img') && main.includes('let scope = ed.closest("form"); if (scope && scope.parentElement) scope = scope.parentElement;'));
ok("codecraft page reads the composer AFTER the send hook so the appended brief goes out", read("src/providers/codecraft.js").includes("hooks.onUserMessage(assistantCount());\n      }\n    }\n    // Read AFTER the hook: TotalScript may have appended a GUI BRIEF (1.51) to the composer.\n    const text = ta.value;"));
ok("setting: rsGuiBrief (default on) with window.__rsGuiBrief, storage sync, menu toggle + setter", main.includes("guiBriefEnabled = true;") && main.includes("window.__rsGuiBrief = () => guiBriefEnabled;") && main.includes('chrome.storage.local.get("rsGuiBrief"') && main.includes("if (changes.rsGuiBrief && typeof changes.rsGuiBrief.newValue === \"boolean\")") && main.includes('data-mode="guibrief"') && main.includes('else if(m==="guibrief") setGuiBrief(!guiBriefEnabled);') && main.includes("function setGuiBrief(v){"));
ok("menu row explains the feature in plain words (incl. reference images)", main.includes('<span class="rs-tgl-name">GUI brief</span><span class="rs-tgl-sub">When you ask for a GUI, TotalScript sends the AI its build protocol right after your message — with a reference-image protocol when you attach or mention a screenshot.</span>'));
ok("ui exposes noteGuiRequest + composerHasImage", main.includes("return { runTemplateById, openTray, closeTray, noteGuiRequest, composerHasImage, setStatus,") /* 1.73.0: template window/creator hooks exported first */);
ok("GUI brief toggle is visible in Simple settings (not rs-adv)", /<div class="rs-tgl-row" data-mode="guibrief"/.test(main));
ok("feature help has a factual guibrief topic", main.includes('guibrief:{title:"GUI brief (custom message for GUI requests)"') && main.includes("saved as rsGuiBrief") && main.includes("GUI Studio hand-offs are never double-briefed") && main.includes("your message itself is never edited"));

// ── composer image detection (selector exercised in jsdom) ──────────────────
try {
  const { JSDOM } = require("jsdom");
  const sel = (main.match(/const sel = '([^']+)';\s*\n\s*return scope\.querySelectorAll\(sel\)\.length > 0;/) || [])[1];
  ok("image selector extracted", !!sel);
  const dom = new JSDOM(`<form id="f"><div class="attachments"><img src="blob:https://chat/abc"></div><div id="ed" contenteditable="true">make this shop ui</div></form><form id="g"><div id="ed2" contenteditable="true">make a hud</div></form><img src="blob:x" id="avatar">`);
  const d = dom.window.document;
  ok("form with a blob thumbnail counts as an attached image", d.getElementById("f").querySelectorAll(sel).length === 1);
  ok("form without attachments → no image (blob img outside the form ignored)", d.getElementById("g").querySelectorAll(sel).length === 0);
} catch (e) { ok("jsdom available for the selector check", false, String(e && e.message)); }

// ── behavioural walk: the real main.js on the CodeCraft page (jsdom) ─────────
(async () => {
  let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch {}
  if (!JSDOM) { console.log("skip jsdom walk"); return finish(); }
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
  const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: false, mcpAlive: false, studio: false }; case "studio_status": return { ok: true, studio: false }; default: return { ok: true, tools: [] }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {} }, lastError: null, getManifest: () => ({ version: "0.0.0" }) }, storage: { local: storageApi(), sync: storageApi(), session: storageApi(), onChanged: { addListener() {} } }, tabs: { query: (q, cb) => cb && cb([]) } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  w.fetch = async () => new Response("{}", { status: 200 });
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }
  try {
    await waitFor(() => d.getElementById("rs-bar") && typeof w.__rsNoteGuiRequest === "function", 8000, "#rs-bar + hook");
    await sleep(300);
    const ta = d.getElementById("cc-input");
    ok("walk: hook + setting exposed, default on", typeof w.__rsNoteGuiRequest === "function" && w.__rsGuiBrief() === true);
    ta.value = "write a datastore script for coins";
    ok("walk: a non-GUI message is ignored", w.__rsNoteGuiRequest() === null && ta.value === "write a datastore script for coins");
    ta.value = "make me a shop gui with 4 item cards";
    const r1 = w.__rsNoteGuiRequest();
    ok("walk: a GUI request yields a pending brief and the composer is NOT touched", r1 && r1.intent.gui && r1.sent === false && r1.text.startsWith(RS.GUI_BRIEF_MARK) && r1.text.includes("3. BUILD IN ONE SHOT") && !r1.text.includes("REFERENCE READ") && ta.value === "make me a shop gui with 4 item cards", r1 && r1.text.slice(0, 120));
    // reference image attached in the CodeCraft composer (thumbnail strip beside the form)
    const att = d.getElementById("cc-attachments"); att.hidden = false; att.innerHTML = '<span class="cc-att"><img src="data:image/png;base64,iVBORw0KGgo="><button type="button">×</button></span>';
    ta.value = "build this inventory screen";
    const r2 = w.__rsNoteGuiRequest();
    ok("walk: an attached image switches on the REFERENCE IMAGE protocol even without reference words", r2 && r2.imageAttached === true && r2.text.includes("0. REFERENCE IMAGE IS ATTACHED - replicate it, do not reinterpret it.") && r2.text.includes("REFERENCE READ") && ta.value === "build this inventory screen", r2 && r2.imageAttached);
    att.innerHTML = ""; att.hidden = true;
    ta.value = "fix my HUD, the coins label overlaps the health bar on phones";
    const r3 = w.__rsNoteGuiRequest();
    ok("walk: edit + mobile wording → read-first protocol + touch rules", r3 && r3.intent.edit && r3.intent.mobile && r3.text.includes("1. READ FIRST: ui_list_tree / ui_export_spec {path}") && r3.text.includes("THIS MUST WORK ON TOUCH / SMALL SCREENS"), r3 && r3.intent);
    // the user's own toast confirms it
    const toastEl = d.querySelector("#rs-root .rs-toast, .rs-toast");
    ok("walk: the bar toast tells the user the brief is ready", !!toastEl && /GUI brief ready/.test(toastEl.textContent || ""), toastEl && toastEl.textContent);
    // menu toggle turns it off
    const row = d.querySelector('[data-mode="guibrief"]');
    ok("walk: settings row rendered (GUI brief, on)", !!row && row.getAttribute("aria-checked") === "true");
    if (row) { row.click(); await sleep(50); }
    ta.value = "make me a main menu";
    ok("walk: toggled off → stored as rsGuiBrief=false and GUI requests are ignored", w.__rsGuiBrief() === false && storage.rsGuiBrief === false && w.__rsNoteGuiRequest() === null && ta.value === "make me a main menu");
  } catch (e) { ok("walk completed without throwing", false, String(e && e.stack || e)); }
  finish();
})();
function finish() {
  console.log(fail ? `test-gui-brief: ${fail} FAILED, ${pass} passed` : `test-gui-brief: ${pass} checks passed`);
  process.exit(fail ? 1 : 0);
}
