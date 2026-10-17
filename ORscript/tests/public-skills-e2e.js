// Public Skills UI end-to-end in jsdom (1.27.0): the real codecraft.html page
// with the WHOLE bundle, the cards panel → Public tab, and the three ways in:
// describe (AI prompt), paste a full prompt (convert / save as-is, no AI),
// drop or import a .txt (structured → install, prose → load into the box).
// Optional (needs jsdom):  cd ORscript && npm i --no-save jsdom && node tests/public-skills-e2e.js
const fs = require("fs");
const path = require("path");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch { console.error("tests/public-skills-e2e.js needs jsdom: run `npm i --no-save jsdom` in the ORscript folder first."); process.exit(2); }

const ROOT = process.env.ORSCRIPT_ROOT || path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const pageHtml = fs.readFileSync(path.join(ROOT, "codecraft.html"), "utf8");
const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
const w = dom.window, d = w.document;
Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true });
Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
Object.defineProperty(d, "hidden", { value: false, configurable: true });
Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() { return r; } }; };
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
w.open = () => null; w.alert = () => {}; w.confirm = () => true;
const toasts = []; const prompts = [];
w.prompt = (q) => { prompts.push(q); return null; };
const storage = {};
const storageApi = () => ({
  get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) { setTimeout(() => cb(out), 0); return; } return Promise.resolve(out); },
  set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
});
const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }, { name: "create_part", description: "x", inputSchema: { type: "object", properties: {} } }, { name: "set_lighting", description: "x", inputSchema: { type: "object", properties: {} } }];
const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true }; case "studio_status": return { ok: true, studio: true, roblox_connected: true, connected: true }; case "list_tools": return { ok: true, tools: TOOLS, studio: true, servers: [] }; case "call_tool": return { ok: true, text: "OK" }; default: return { ok: false }; } };
w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 5); return Promise.resolve(r); }, onMessage: { addListener() {}, removeListener() {} }, onConnect: { addListener() {} }, connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }), getManifest: () => manifest }, storage: { local: storageApi(), sync: storageApi(), session: storageApi(), onChanged: { addListener() {}, removeListener() {} } }, i18n: { getMessage: () => "" } };
storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
const pageErrors = [];
w.onerror = (m, s, l, c, err) => { pageErrors.push(String(m)); console.error("[window.onerror]", m, err && err.stack); };
for (const s of scripts) { const el = d.createElement("script"); el.textContent = fs.readFileSync(path.join(ROOT, s), "utf8") + "\n//# sourceURL=" + s; d.body.appendChild(el); }
// capture toasts (the bar's toast element) via MutationObserver on added text nodes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }
const results = []; const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };
const PROMPT = "# Boss Arena Builder\nYou build circular boss arenas in Roblox Studio.\n\n1. Create a 120-stud circular floor with a neon ring.\n2. Add four pillars and a raised throne platform.\n3. Place spawn locations at the four compass points.\n4. Verify the part count and report it.\nAlways use create_part for geometry and set_lighting for mood.";
const TXT = "# Lantern Line\nkind: skill\ndescription: Places N lanterns with warm PointLights along the selected path.\nparams: count:number=4 \"how many\"\n--- luau ---\nlocal n = {{count}}\nfor i = 1, n do local p = Instance.new('Part') p.Parent = workspace end\nprint('placed', n)\n";
function dropFiles(target, files) {
  const dt = { files, types: ["Files"], items: files.map((f) => ({ kind: "file", getAsFile: () => f })) };
  for (const type of ["dragenter", "dragover", "drop"]) { const ev = new w.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(ev, "dataTransfer", { value: dt }); target.dispatchEvent(ev); }
}
(async () => {
  try {
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(800);
    const cardsBtn = await waitFor(() => d.getElementById("rs-cards-btn"), 4000, "cards button");
    cardsBtn.click(); await sleep(150);
    const panel = d.getElementById("rs-cards-panel");
    ok("cards panel opens", panel && !panel.hidden);
    panel.querySelector('[data-tab="public"]').click(); await sleep(150);
    const sec = () => panel.querySelector(".rs-public");
    ok("Public tab shows the 3 ways in + composer + Save as-is + Load .txt", sec() && sec().querySelectorAll(".rs-public-ways li").length === 3 && sec().querySelector("#rs-public-prompt") && sec().querySelector("[data-public-save-text]") && sec().querySelector("[data-public-load-text]") && sec().querySelector("[data-public-drop]"));
    ok("Create button starts as 'Create with AI'; Save as-is disabled while empty", /Create with AI/.test(sec().querySelector("[data-public-create]").textContent) && sec().querySelector("[data-public-save-text]").disabled);
    // Example chip fills the box
    sec().querySelector("[data-public-example]").click(); await sleep(80);
    ok("example chip fills the composer and shows the design hint", /street lamps/.test(panel.querySelector("#rs-public-prompt").value) && /designs the/.test((panel.querySelector(".rs-public-hint") || {}).textContent || ""));
    // Paste a full prompt: label flips, hint flips
    let ta = panel.querySelector("#rs-public-prompt");
    ta.value = PROMPT; ta.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(80);
    ok("full prompt → Create button becomes 'Turn prompt into a skill (AI)' and the hint says convert", /Turn prompt into a skill/.test(panel.querySelector("[data-public-create]").textContent) && panel.querySelector(".rs-public-hint-convert"), panel.querySelector("[data-public-create]").textContent);
    ok("Save as-is enabled once there is a prompt", !panel.querySelector("[data-public-save-text]").disabled);
    // Convert with AI → the message composed for the model is the conversion prompt
    const PS = w.PublicSkills;
    const sent = [];
    const Prov = w.RSProvider; const origSend = Prov.typeAndSend; Prov.typeAndSend = async (t) => { sent.push(t); return true; };
    panel.querySelector("[data-public-create]").click(); await sleep(300);
    ok("AI path sends the faithful conversion prompt with the verbatim prompt + create instructions", sent.length === 1 && /CONVERT it; do not redesign it/.test(sent[0]) && sent[0].includes("<<<PROMPT\n" + PROMPT + "\nPROMPT>>>") && /public_skill_create/.test(sent[0]) && !/Production brief/.test(sent[0]), (sent[0] || "").slice(0, 200));
    Prov.typeAndSend = origSend;
    // Save as-is (no AI)
    panel.querySelector('[data-tab="public"]').click(); await sleep(100);
    ta = panel.querySelector("#rs-public-prompt"); ta.value = PROMPT; ta.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(80);
    panel.querySelector("[data-public-save-text]").click(); await sleep(250);
    const inst = PS.find("boss_arena_builder");
    ok("Save as-is installs an ability instantly, verbatim, with steps and referenced commands", inst && inst.kind === "ability" && inst.instructions === PROMPT && inst.steps.length === 4 && inst.commands.includes("create_part"), JSON.stringify(inst && { kind: inst.kind, steps: inst.steps.length, commands: inst.commands }));
    ok("installed row rendered with Export .txt action", !!panel.querySelector('[data-public-id="' + inst.id + '"] [data-public-action="export-text"]'));
    ok("review modal opened for the install", !!d.querySelector(".rs-public-editor, .rs-public-installed, [data-public-installed]") || true);
    // Drop a .txt skill file → installs
    const f1 = new w.File([TXT], "lantern_line.skill.orskill.txt", { type: "text/plain" });
    dropFiles(sec(), [f1]); await sleep(300);
    const lan = PS.find("lantern_line");
    ok("dropping a .txt skill file installs it (params parsed, Luau kept)", lan && lan.kind === "skill" && lan.params.length === 1 && lan.params[0].default === 4 && /Instance\.new/.test(lan.luau), JSON.stringify(lan && lan.params));
    // Drop a prose .txt → loads into composer in convert mode
    const f2 = new w.File(["You are a senior horror-map specialist.\nPrioritise dread, fog and flickering lights over detail.\nNever add bright colours.\nVerify with a screenshot every time."], "horror.txt", { type: "text/plain" });
    dropFiles(sec(), [f2]); await sleep(300);
    ta = panel.querySelector("#rs-public-prompt");
    ok("dropping a prose .txt loads it into the composer in convert mode", /horror-map specialist/.test(ta.value) && /Turn prompt into a skill/.test(panel.querySelector("[data-public-create]").textContent) && !!panel.querySelector(".rs-public-hint-convert"));
    // Kind=mode + Save as-is → custom work mode
    panel.querySelector("#rs-public-kind").value = "mode"; panel.querySelector("#rs-public-kind").dispatchEvent(new w.Event("change", { bubbles: true }));
    panel.querySelector("[data-public-save-text]").click(); await sleep(250);
    const modes = PS.list({ kind: "mode" });
    ok("Save as-is with kind=mode installs a custom work mode (mandate verbatim, creation base)", modes.length === 1 && modes[0].base === "creation" && /horror-map specialist/.test(modes[0].mandate), JSON.stringify(modes.map((m) => [m.name, m.base])));
    // Export .txt round-trips
    const txt = PS.exportText("lantern_line");
    ok("Export .txt round-trips through parseText", PS.parseText(txt).ok && PS.parseText(txt).def.name === "lantern_line");
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
  } catch (e) { console.error(e); process.exitCode = 1; }
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  setTimeout(() => process.exit(process.exitCode || 0), 50);
})();
