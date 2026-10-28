// 1.73.0 — Templates window + Template Creator.
// The templates bar button opens the cards panel (Library · Activity · Public ·
// Tasks) in a centred window (#rs-cards-window) and the Library tab hosts the
// Template Creator (src/core/templatecreator.js): list of saved templates on
// the left, a plain-language form on the right ({{blanks}} detected from the
// prompt, optional steps, AI draft from one sentence via the visible round
// trip). String/wiring checks always run; the pure-function and jsdom parts
// run in plain node (jsdom needed for the window walk).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const main = read("src/core/main.js");
const creator = read("src/core/templatecreator.js");
const config = read("src/core/config.js");
const css = read("overlay.css");
const manifest = JSON.parse(read("manifest.json"));
const page = read("codecraft.html");
const results = []; const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };

// ── wiring ──
ok("manifest: templatecreator.js is loaded before main.js in every content_scripts entry", (() => { const withMain = manifest.content_scripts.filter((cs) => (cs.js || []).includes("src/core/main.js")); return withMain.length >= 10 && withMain.every((cs) => { const js = cs.js; const a = js.indexOf("src/core/templatecreator.js"), b = js.indexOf("src/core/main.js"); return a >= 0 && b > a; }); })());
ok("codecraft.html: templatecreator.js script tag precedes main.js", page.indexOf('src="src/core/templatecreator.js"') > 0 && page.indexOf('src="src/core/templatecreator.js"') < page.indexOf('src="src/core/main.js"'));
ok("module exposes window.TotalTemplateCreator with open/close/isOpen/state + pure helpers", /window\.TotalTemplateCreator = \{ open, close, isOpen, state, detectBlanks, formToTemplate, templateToForm, exampleToForm, draftToForm, CATEGORIES \};/.test(creator));
ok("creator supports an embedded mount (opts.mount) and keeps its host across re-mounts", /function build\(mount\)/.test(creator) && /host\.classList\.add\("rst-embedded"\)/.test(creator) && /else if \(o\.mount && D\.host\.parentElement !== o\.mount\)/.test(creator) && /S\.embedded = !!o\.mount;/.test(creator));
ok("embedded close hands control back to the host window (hooks.onClose) instead of toggling the full-screen classes", /if \(S\.embedded\) \{ try \{ S\.hooks\.onClose && S\.hooks\.onClose\(\); \} catch \{\} \}/.test(creator));

// main.js: window
ok("main: templates button opens the centred window (falls back to the bar tray only if the window cannot be built)", /cardsBtn\.addEventListener\("click", \(e\)=>\{\s*e\.stopPropagation\(\);\s*if \(cardsWindowOpen\(\)\) \{ closeCardsWindow\(\); return; \}/.test(main) && /try \{ openCardsWindow\(\); \} catch \(err\) \{ diag\("cards\.windowFailed"/.test(main));
ok("main: #rs-cards-window host with title bar, close button and body; appended to <html>", main.includes('cardsWindow.id = "rs-cards-window"') && main.includes('class="rs-cw-title"') && main.includes("data-cw-close") && main.includes('class="rs-cw-body"') && /document\.documentElement\.appendChild\(cardsWindow\);/.test(main));
ok("main: openCardsWindow moves the SAME panel element into the window, marks it, renders and hides the bar via html.rs-cards-window-open", /if \(cardsPanel\.parentElement !== body\) body\.appendChild\(cardsPanel\);/.test(main) && /cardsPanel\.classList\.add\("rs-cards-in-window"\);/.test(main) && /document\.documentElement\.classList\.add\("rs-cards-window-open"\);/.test(main) && /renderCards\(cardsPanel\);\s*try \{ win\.focus/.test(main));
ok("main: Esc / backdrop / close button close the window; Esc is ignored while the creator is busy (AI draft running)", /e\.key === "Escape"\) \{ if \(typeof TotalTemplateCreator !== "undefined" && TotalTemplateCreator\.isOpen\(\) && TotalTemplateCreator\.state\(\)\.busy\) return;/.test(main) && /if \(e\.target === cardsWindow \|\| \(e\.target\.closest && e\.target\.closest\("\[data-cw-close\]"\)\)\)/.test(main));
ok("main: closing restores the hidden panel, clears classes and closes the embedded creator", /cardsPanel\.hidden = true; cardsPanel\.classList\.remove\("rs-cards-in-window"\);/.test(main) && /if \(typeof TotalTemplateCreator !== "undefined" && TotalTemplateCreator\.isOpen\(\)\) TotalTemplateCreator\.close\(\);/.test(main));
ok("main: task pill, Public Skills modal and Settings → Task list open the window too", main.includes('if (wasTasks) closeCardsWindow(); else openCardsWindow("tasks");') && /openCardsPanel = \(open, tab\) => \{ if \(open\) openCardsWindow\(tab\);/.test(main) && /openTrayFn = \(tab\) => openCardsWindow\(tab\);/.test(main));
ok("main: Library tab inside the window = embedded creator; re-renders only rebuild the rail while the slot exists", /const creatorTab = panel\.classList\.contains\("rs-cards-in-window"\) && cardsTab === "library" && !local && typeof TotalTemplateCreator !== "undefined";/.test(main) && /const existingSlot = creatorTab \? panel\.querySelector\("\.rs-cards-body > \.rs-cards-creator-slot"\) : null;/.test(main) && /topEl\.replaceWith\(tmp\.firstElementChild\)/.test(main) && /window\.__rsOpenTemplateCreator\(\{ mount: slot \}\)/.test(main));
ok("main: openTemplateCreator wires registry / commands / examples / run / draft / openTray / onClose / engine hooks", /run: \(templateId, values\) => ui\.runTemplateById\(templateId, values\),\s*draft: draftTemplateViaAI,\s*openTray: \(tab\) => \{ try \{ ui\.openTray\(tab\); \} catch \{\} \},\s*onClose: \(\) => \{ try \{ ui\.closeTray\(\); \} catch \{\} \},/.test(main) && /window\.__rsOpenTemplateCreator = openTemplateCreator;/.test(main));
ok("main: a run from the creator closes the window before pasting/sending (runLibraryCard)", /if \(closeCardsWindowFn\) closeCardsWindowFn\(\); cardsPanel\.hidden = true;/.test(main));
ok("main: runTemplateCard accepts preset blank values (no prompt() chain) and returns true/false", /async function runTemplateCard\(card,presetVars\)/.test(main) && /const preset=presetVars&&typeof presetVars==="object"\?presetVars:null;/.test(main) && /function runTemplateById\(templateId, values\)/.test(main));
ok("main: AI draft reuses the visible round trip (aiRoundTrip) with kind templateDraft and never auto-starts the agent", /async function draftTemplateViaAI\(sentence, opts, onStatus\)/.test(main) && /aiRoundTrip\(request, \{ cancelled: o\.cancelled, kind: "templateDraft" \}, onStatus\)/.test(main) && /RS\.parseTemplateDraft\(text\)/.test(main));

// overlay.css
const sec = css.slice(css.indexOf("1.73.0 — TEMPLATES WINDOW"));
ok("css: templates-window block is appended last", sec.length > 1500 && css.indexOf("1.73.0 — TEMPLATES WINDOW") > css.indexOf("#rs-tcreator {"));
ok("css: window = fixed backdrop, centred shell min(1380px, 100vw-24px) × min(900px, 100vh-24px), bar hidden while open", /#rs-cards-window \{ position: fixed; inset: 0;/.test(sec) && /\.rs-cw-shell \{ position: relative; width: min\(1380px, calc\(100vw - 24px\)\); height: min\(900px, calc\(100vh - 24px\)\);/.test(sec) && /html\.rs-cards-window-open #rs-root \{ visibility: hidden !important; \}/.test(sec));
ok("css: the panel fills the shell (static, 100%, no max-height) - the §15 rail+content grid is reused", /#rs-cards-window #rs-cards-panel, #rs-cards-window #rs-cards-panel\[data-cards-tab\] \{\s*position: static !important;/.test(sec) && /width: 100% !important;[^}]*height: 100% !important; max-height: none !important;/.test(sec));
ok("css: embedded creator loses backdrop/frame and stretches inside the Library slot", /#rs-tcreator\.rst-embedded, #rs-tcreator\.rst-embedded\.open \{ position: static;[^}]*background: transparent;/.test(sec) && /#rs-tcreator\.rst-embedded \.rst-shell \{ width: 100%; height: 100%;/.test(sec) && /\[data-act="close"\] \{ display: none !important; \}/.test(sec));
ok("css: no `#rs-cards-panel .` selectors (keeps the §15 specificity contract of test-v141)", !/#rs-cards-panel \./.test(sec));

const readme = read("README.md");
ok("README: 1.73.0 entry + Templates window section", readme.includes("**1.73.0 — Templates window: Library, Activity and Public Skills in one centred window, with an easy Template Creator.**") && readme.includes("## Templates window — Library, Activity, Public Skills, in the middle of the screen"));
ok("version pins 1.84.0 (manifest / crate / plugin)", manifest.version === "1.84.0" && /^version = "1\.84\.0"/m.test(read("agent/Cargo.toml")) && read("plugin/TotalScript.lua").includes('local VERSION = "1.84.0"'));

// ── pure helpers (templatecreator.js in a bare sandbox) ──
const sandbox = { window: {}, console, setTimeout, clearTimeout };
sandbox.globalThis = sandbox; sandbox.window = sandbox;
vm.runInNewContext(creator, sandbox, { filename: "templatecreator.js" });
const TC = sandbox.TotalTemplateCreator;
ok("pure: module loads without a DOM and exposes the API", TC && typeof TC.open === "function" && Array.isArray(TC.CATEGORIES) && TC.CATEGORIES.includes("Building"));
ok("pure: detectBlanks finds unique {{names}} in order", JSON.stringify(TC.detectBlanks("Build a {{size}} stud {{shape}} arena with {{size}} pillars")) === JSON.stringify(["size", "shape"]));
const form = { id: null, name: "Boss arena", description: "Circular arena", category: "Building", prompt: "Build a {{size}} stud arena", blanks: [{ name: "size", question: "How big?", default: "120", required: true }], steps: [{ text: "Add pillars", command: "", params: "" }, { text: "", command: "create_part", params: '{"name":"Floor"}' }], environment: "ROBLOX_STUDIO", tags: "arena, boss", executionLevel: "READ", versions: [], currentVersion: 0 };
const t = TC.formToTemplate(form);
ok("pure: formToTemplate → workflow template with instructions, variables and step objects", t.type === "workflow" && t.instructions === "Build a {{size}} stud arena" && t.variables.length === 1 && t.variables[0].name === "size" && t.variables[0].default === "120" && t.workflow.length === 2 && t.workflow[0].id === "step-1" && t.workflow[0].instruction === "Add pillars" && t.workflow[1].command === "create_part" && t.workflow[1].parameters.name === "Floor" && t.workflow[1].errorBehavior === "STOP", JSON.stringify(t).slice(0, 200));
const back = TC.templateToForm(Object.assign({ id: "tpl_x", currentVersion: 2, versions: [{ version: 1, name: "a" }, { version: 2, name: "b" }] }, t, { instructions: ["Build a {{size}} stud arena"] }));
ok("pure: templateToForm round-trips name/prompt/blanks/steps/versions", back.id === "tpl_x" && back.name === "Boss arena" && back.prompt === "Build a {{size}} stud arena" && back.blanks[0].question === "How big?" && back.steps.length === 2 && back.steps[1].command === "create_part" && JSON.parse(back.steps[1].params).name === "Floor" && back.versions.length === 2 && back.currentVersion === 2);
ok("pure: a prompt without steps becomes a prompt template", TC.formToTemplate({ name: "P", prompt: "Summarise", blanks: [], steps: [] }).type === "prompt");
let threw = false; try { TC.formToTemplate({ name: "P", prompt: "x", blanks: [], steps: [{ text: "", command: "create_part", params: "not json" }] }); } catch { threw = true; }
ok("pure: bad step parameters throw (surfaced as a form error, never saved)", threw);
const d = TC.draftToForm({ name: "Shop", description: "d", category: "UI", prompt: "Make a shop selling {{item}} for {{price}}", blanks: [{ name: "item", question: "What is sold?", required: true }], steps: ["Add a {{currency}} label"] });
ok("pure: draftToForm syncs blanks with the prompt + steps (declared + discovered)", d.blanks.map((b) => b.name).join(",") === "item,price,currency" && d.blanks[0].question === "What is sold?" && d.steps.length === 1 && d.category === "UI");

// ── config: draft request + parser ──
vm.runInThisContext(config + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
ok("config: TEMPLATE_DRAFT_MARK / fences / categories exported", RS.TEMPLATE_DRAFT_MARK === "⟦TotalScript TEMPLATE DRAFT⟧" && Array.isArray(RS.TEMPLATE_CATEGORIES) && typeof RS.templateDraftRequest === "function" && typeof RS.parseTemplateDraft === "function");
const req = RS.templateDraftRequest({ sentence: "a shop ui with a currency label", engine: "roblox", agentStarted: true });
ok("config: draft request carries the mark, forbids commands/tools and asks for fenced JSON", req.includes(RS.TEMPLATE_DRAFT_MARK) && /do NOT run any command or tool/.test(req) && req.includes("<<<TEMPLATE JSON>>>") && req.includes("<<<END TEMPLATE JSON>>>") && /no command block in this reply/.test(req) && req.includes("a shop ui with a currency label"));
const good = RS.parseTemplateDraft("Sure.\n<<<TEMPLATE JSON>>>\n{\"name\":\"Shop UI\",\"category\":\"UI\",\"description\":\"d\",\"prompt\":\"Create a shop ScreenGui selling {{item}}\",\"blanks\":[{\"name\":\"item\",\"question\":\"What is sold?\"}],\"steps\":[\"Add a {{currency}} label\"]}\n<<<END TEMPLATE JSON>>>\nDone.");
ok("config: marker-fenced JSON parses; blanks used in prompt/steps but not declared are added", good.ok && good.source === "markers" && good.draft.name === "Shop UI" && good.draft.category === "UI" && good.draft.blanks.map((b) => b.name).join(",") === "item,currency" && good.draft.steps.length === 1, good.error);
const fence = RS.parseTemplateDraft("```json\n{\"name\":\"X\",\"prompt\":\"Do {{a}}\",\"category\":\"Nope\"}\n```");
ok("config: ``` fence fallback; unknown category kept as given (custom categories allowed)", fence.ok && fence.source === "fence" && fence.draft.category === "Nope" && fence.draft.blanks[0].name === "a");
const bad = RS.parseTemplateDraft("### MCP_TOOL ###\n{\"tool\":\"create_part\",\"args\":{}}");
ok("config: a command-shaped reply is flagged (command: true) and yields no draft", bad.command === true && !bad.ok);
ok("config: missing name/prompt → error, not a half template", !RS.parseTemplateDraft("{\"name\":\"only\"}").ok && /name and a prompt/.test(RS.parseTemplateDraft("{\"name\":\"only\"}").error));
ok("config: detectGuiIntent ignores template-draft requests", RS.detectGuiIntent ? !RS.detectGuiIntent(RS.TEMPLATE_DRAFT_MARK + " make a shop gui with a frame and buttons").match : true);

// ── jsdom window walk ──
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { JSDOM = null; }
if (!JSDOM) { console.log("SKIP  jsdom walk (jsdom not installed)"); finish(); } else { walk().catch((e) => { ok("jsdom walk completed", false, String(e && e.stack || e)); finish(); }); }

function finish() { const failed = results.filter((r) => !r[1]); console.log(`\n${results.length - failed.length}/${results.length} checks passed`); if (failed.length) { console.log("FAILURES:"); failed.forEach((r) => console.log("  - " + r[0])); } }

async function walk() {
  const pageHtml = read("codecraft.html");
  const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
  const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
  Object.defineProperty(d, "hidden", { value: false, configurable: true });
  Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
  w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} }; };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return 860; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return d.body; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
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
  const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true }; case "studio_status": return { ok: true, studio: true }; case "tools": case "list_tools": return { ok: true, tools: TOOLS }; default: return { ok: true }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {}, removeListener() {} }, lastError: null, getManifest: () => JSON.parse(read("manifest.json")) }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {}, removeListener() {} } } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  const fetches = [];
  w.fetch = async (url, init) => { fetches.push({ url: String(url), body: init && typeof init.body === "string" ? init.body : "" }); if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const pageErrors = [];
  w.onerror = (m) => { pageErrors.push(String(m)); };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));

  await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
  await sleep(600);
  const bar = d.getElementById("rs-bar");
  const cardsBtn = await waitFor(() => d.getElementById("rs-cards-btn"), 4000, "cards button");
  const panel = d.getElementById("rs-cards-panel");
  ok("walk: before the click the panel is hidden and lives in the bar", panel && panel.hidden && bar.contains(panel));
  cardsBtn.click(); await sleep(200);
  const win = d.getElementById("rs-cards-window");
  ok("walk: templates button → centred window open, panel moved into it, bar hidden (html.rs-cards-window-open)", win && win.classList.contains("open") && win.querySelector(".rs-cw-body > #rs-cards-panel") === panel && !panel.hidden && !bar.classList.contains("rs-cards-open") && d.documentElement.classList.contains("rs-cards-window-open"));
  ok("walk: window title bar has the Templates brand, the tabs hint and a close button", /Templates/.test(win.querySelector(".rs-cw-brand").textContent) && /Library · Activity · Public Skills · Tasks/.test(win.querySelector(".rs-cw-sub").textContent) && !!win.querySelector("[data-cw-close]"));
  const tabs = [...panel.querySelectorAll(":scope > .rs-cards-top .rs-cards-tab")].map((b) => b.dataset.tab);
  ok("walk: rail shows Library / Activity / Public (Tasks appears when the task list is on)", tabs.join(",") === "library,activity,public" || tabs.join(",") === "library,activity,public,tasks", tabs.join(","));
  const host = await waitFor(() => panel.querySelector(".rs-cards-body > .rs-cards-creator-slot > #rs-tcreator.rst-embedded.open"), 2000, "embedded creator");
  ok("walk: Library tab = embedded Template Creator (list + form + AI sentence row), full-screen chrome hidden", !!host.querySelector(".rst-list") && !!host.querySelector("form.rst-form") && !!host.querySelector(".rst-sentence") && w.TotalTemplateCreator.state().embedded === true && !d.documentElement.classList.contains("rs-tcreator-open"));
  ok("walk: empty library shows the 'No templates yet' state with example chips", /No templates yet/.test(host.querySelector(".rst-list").textContent) && host.querySelectorAll('.rst-example-chips [data-act="example"]').length > 0);

  // create a template through the form
  const f = host.querySelector("form.rst-form");
  f.elements.name.value = "Boss arena"; fire(f.elements.name, "input");
  f.elements.prompt.value = "Build a {{size}} stud circular arena with {{pillars}} pillars"; fire(f.elements.prompt, "input");
  await sleep(40);
  const blankRows = host.querySelectorAll(".rst-blank-rows [data-blank=\"question\"]");
  ok("walk: typing {{size}} / {{pillars}} in the prompt adds two blank rows", blankRows.length === 2 && blankRows[0].value === "size" && blankRows[1].value === "pillars", String(blankRows.length));
  blankRows[0].value = "How wide (studs)?"; fire(blankRows[0], "input");
  const defaults = host.querySelectorAll(".rst-blank-rows [data-blank=\"default\"]"); defaults[1].value = "8"; fire(defaults[1], "input");
  f.elements.category.value = "Building"; fire(f.elements.category, "input");
  host.querySelector(".rst-save").click(); await sleep(250);
  const R = w.TotalTemplateRegistry;
  const saved = R.list().find((x) => x.name === "Boss arena");
  ok("walk: Save writes a registry template (prompt type, 2 variables, category Building)", saved && saved.type === "prompt" && saved.category === "Building" && saved.variables.length === 2 && saved.variables[0].description === "How wide (studs)?" && saved.variables[1].default === "8", saved ? JSON.stringify(saved.variables) : host.querySelector(".rst-form-status").textContent);
  ok("walk: the list shows the new card selected with '2 blanks' meta and the status says saved", host.querySelectorAll(".rst-list > .rst-card").length === 1 && host.querySelector(".rst-list > .rst-card.on") && /2 blanks/.test(host.querySelector(".rst-card-meta").textContent) && /saved/i.test(host.querySelector(".rst-form-status").textContent), host.querySelector(".rst-form-status").textContent);

  // run: dialog → fill blank → composer receives the filled prompt, window closes
  host.querySelector('.rst-card [data-act="run"]').click(); await sleep(60);
  const run = host.querySelector(".rst-run");
  ok("walk: Run opens the fill-the-blanks dialog with one field per blank and a live preview", run && !run.hidden && run.querySelectorAll("[data-run-var]").length === 2 && /stud circular arena/.test(run.querySelector(".rst-run-preview pre").textContent));
  host.querySelector('[data-act="runGo"]').click(); await sleep(60);
  ok("walk: Run with the required blank empty is refused in place (status names the blank)", !run.hidden && /\{\{size\}\}/.test(host.querySelector(".rst-run-status").textContent), host.querySelector(".rst-run-status").textContent);
  const sizeInput = run.querySelector('[data-run-var="size"]'); sizeInput.value = "120"; fire(sizeInput, "input");
  ok("walk: preview substitutes the typed value and the default", /Build a 120 stud circular arena with 8 pillars/.test(run.querySelector(".rst-run-preview pre").textContent), run.querySelector(".rst-run-preview pre").textContent);
  // P.typeAndSend on the CodeCraft page talks to the API (stubbed fetch), so the
  // composer may already be cleared - the send embed on the bar is the stable signal.
  host.querySelector('[data-act="runGo"]').click(); await sleep(400);
  const embed = d.getElementById("rs-card-embed");
  const sentBody = fetches.map((x) => x.body).find((b) => /Build a 120 stud circular arena with 8 pillars/.test(b)) || "";
  ok("walk: runGo → the filled prompt is sent (CodeCraft API request body carries it), the bar embed reports 'Sent to AI', the window closes and the panel is hidden", sentBody && /Execute this reviewed prompt template/.test(sentBody) && embed && !embed.hidden && /Boss arena/.test(embed.textContent) && /Sent to AI/.test(embed.textContent) && !win.classList.contains("open") && panel.hidden && !d.documentElement.classList.contains("rs-cards-window-open"), (embed ? embed.textContent.slice(0, 80) : "no embed") + " | fetches=" + fetches.length);
  // reopen → other tabs render the same content as before; Esc closes
  cardsBtn.click(); await sleep(150);
  panel.querySelector('.rs-cards-tab[data-tab="activity"]').click(); await sleep(80);
  ok("walk: Activity tab inside the window renders the activity shell", !!panel.querySelector(".rs-cards-body > .rs-template-library.rs-activity") && panel.dataset.cardsTab === "activity");
  panel.querySelector('.rs-cards-tab[data-tab="public"]').click(); await sleep(80);
  ok("walk: Public Skills tab inside the window renders the public shell", !!panel.querySelector(".rs-cards-body > .rs-template-library.rs-public") && panel.dataset.cardsTab === "public");
  panel.querySelector('.rs-cards-tab[data-tab="library"]').click(); await sleep(80);
  ok("walk: back on Library the creator host is re-mounted (same element) and still lists the saved template", panel.querySelector(".rs-cards-creator-slot > #rs-tcreator") === host && host.querySelectorAll(".rst-list > .rst-card").length === 1);
  win.querySelector("[data-cw-close]").click(); await sleep(60);
  ok("walk: the close button closes the window", !win.classList.contains("open") && panel.hidden && !w.TotalTemplateCreator.isOpen());
  ok("walk: no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  finish();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
}
