// TotalScript 2.0.1 - Arena: the Templates window must keep its content, and
// the reply poll must stay cheap on long chats.
//
// Bug (reported live, reproduced here): opening the Templates window on arena.ai
// left only the window shell - Library / Activity / Explorer all vanished and the
// bar disappeared with them. Root cause: arena.js overlayBlocking() counted ANY
// visible [role="dialog"] outside #rs-root as a site modal; our own window
// (#rs-cards-window, role=dialog, mounted on <html>) matched, so main.js's
// captcha/overlay branch hid the bar AND the cards panel on every placement pass.
// Fix: every TotalScript top-level host carries data-rs-owned and the detectors
// (arena.js, ui_collision_manager.js) skip it.
//
// Perf (measured in this harness before the fix): readAssistant / isGenerating /
// assistantCount / lastAssistantId each re-walked every turn with attribute
// selectors on every ~120 ms poll - ~33 ms per call at 80 turns, ~125 ms at 300.
// Fix: per-node memo of "is a turn" / "is a user turn" (WeakMap) + sibling walk.
//
// Runs the real Arena content-script bundle (manifest order) in jsdom.
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const block = manifest.content_scripts.find((b) => b.matches.some((x) => /arena/.test(x)));

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log("ok   " + msg); } else { fail++; console.log("FAIL " + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(turnPairs) {
  const html = `<!doctype html><html><head><style>.hidden{display:none}</style></head><body><main><ol class="flex-col-reverse"></ol><form><textarea></textarea><button aria-label="Send message">send</button></form></main></body></html>`;
  const dom = new JSDOM(html, { url: "https://arena.ai/?mode=direct", runScripts: "dangerously", pretendToBeVisual: true });
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
  w.HTMLElement.prototype.scrollIntoView = function () {}; w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
  w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16); w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.elementFromPoint = d.elementFromPoint = () => null; d.execCommand = () => false;
  w.HTMLCanvasElement.prototype.getContext = () => null; if (!w.crypto) w.crypto = require("crypto").webcrypto;
  w.Audio = class { play() { return Promise.resolve(); } pause() {} }; w.AudioContext = undefined;
  w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" }; w.URL.createObjectURL = () => "blob:h"; w.URL.revokeObjectURL = () => {};
  w.open = () => null; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
  const storage = {};
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  const background = (msg) => {
    switch (msg && msg.type) {
      case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true };
      case "studio_status": return { ok: true, studio: true };
      case "tools": case "list_tools": return { ok: true, tools: TOOLS };
      case "call_tool": return { ok: true, text: "ok" };
      case "blender_status": case "blender_connect": return { ok: false, blender: false };
      default: return { ok: true, tools: TOOLS };
    }
  };
  w.chrome = {
    runtime: { id: "h", getURL: (p) => "chrome-extension://h/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {}, removeListener() {} }, lastError: null, getManifest: () => manifest },
    storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {}, removeListener() {} } },
    tabs: { create() {} },
  };
  w.fetch = async () => new Response("{}", { status: 200 });
  const errs = [];
  w.onerror = (msg) => { errs.push(String(msg)); };
  const vc = w.console;
  w.console = { ...vc, error: (...a) => { errs.push("console.error: " + a.map(String).join(" ").slice(0, 300)); }, warn: () => {}, log: () => {} };
  // A long Arena chat (newest first, flex-col-reverse): user + assistant pairs,
  // each reply = prose paragraphs + two fenced code boxes (div.not-prose > pre).
  const ol = d.querySelector("ol");
  const para = (i) => `<p>Paragraph ${i}: Roblox Studio scripting, TweenService, DataStore, remote events and more words to look like prose.</p>`;
  const code = (i) => `<div class="not-prose"><pre><code>${("local x" + i + " = Instance.new('Part')\nx.Parent = workspace\n").repeat(40)}</code></pre></div>`;
  for (let i = 0; i < turnPairs; i++) {
    const a = d.createElement("li"); a.className = "mx-auto";
    a.innerHTML = `<div class="prose">${Array.from({ length: 12 }, (_, k) => para(k)).join("")}${code(i)}${Array.from({ length: 6 }, (_, k) => para(k + 20)).join("")}${code(i + 100)}</div>`;
    const u = d.createElement("li"); u.className = "mx-auto justify-end";
    u.innerHTML = `<div class="prose"><p>user message ${i} ${"tool result ".repeat(60)}</p></div>`;
    ol.prepend(a); ol.prepend(u);
  }
  for (const sc of block.js) { const el = d.createElement("script"); el.textContent = read(sc) + "\n//# sourceURL=" + sc; d.body.appendChild(el); }
  return { w, d, errs };
}

(async () => {
  // ── A. Templates window keeps its content on Arena ───────────────────────
  {
    const { w, d, errs } = boot(3);
    const until = Date.now() + 10000;
    while (Date.now() < until && !d.getElementById("rs-bar")) await sleep(50);
    await sleep(800);
    const bar = d.getElementById("rs-bar");
    ok(!!bar, "A1 Arena bundle boots and mounts the bar (errors: " + errs.length + ")");
    const P = w.RSProvider;
    ok(P && P.id === "arena", "A2 active provider is arena");
    ok(P.overlayBlocking() === false, "A3 overlayBlocking() is false with no site dialog");
    const btn = d.getElementById("rs-cards-btn");
    ok(!!btn, "A4 templates button present");
    btn.click();
    await sleep(500);
    const win = d.getElementById("rs-cards-window"), panel = d.getElementById("rs-cards-panel");
    ok(win && win.classList.contains("open"), "A5 Templates window opens");
    ok(win && win.getAttribute("role") === "dialog" && win.getAttribute("data-rs-owned") === "1", "A6 window is role=dialog AND marked data-rs-owned");
    ok(panel && panel.closest("#rs-cards-window") === win, "A7 cards panel moved into the window");
    ok(P.overlayBlocking() === false, "A8 overlayBlocking() ignores our own window (root cause)");
    ok(P.captchaPresent() === false, "A9 captchaPresent() false");
    // Let the placement loop run several passes - this is where the panel used to be hidden.
    await sleep(1800);
    ok(panel.hidden === false, "A10 cards panel is NOT hidden after placement passes (was hidden every pass before 2.0.1)");
    ok(bar.style.display !== "none", "A11 bar not hidden by the overlay branch");
    const tabs = [...panel.querySelectorAll(".rs-cards-tab")].map((t) => t.dataset.tab);
    ok(tabs.includes("library") && tabs.includes("activity") && tabs.includes("explorer"), "A12 Library/Activity/Explorer tabs present: " + tabs.join(","));
    ok(win.classList.contains("open"), "A13 window still open");
    const act = panel.querySelector('.rs-cards-tab[data-tab="activity"]');
    act.click(); await sleep(300);
    ok(panel.dataset.cardsTab === "activity" && panel.hidden === false, "A14 Activity tab switch works and panel stays visible");
    // A genuine site modal must still count.
    const site = d.createElement("div"); site.setAttribute("role", "dialog"); site.textContent = "Sign in"; d.body.appendChild(site);
    ok(P.overlayBlocking() === true, "A15 a real site [role=dialog] still blocks");
    site.remove();
    ok(P.overlayBlocking() === false, "A16 ...and clears when removed");
    ok(errs.length === 0, "A17 no page errors during the window flow" + (errs.length ? " " + errs.slice(0, 3).join(" | ") : ""));
  }

  // ── B. every TotalScript top-level host is marked data-rs-owned ──────────
  {
    const main = read("src/core/main.js");
    ok(/cardsWindow\.setAttribute\("data-rs-owned", "1"\)/.test(main), "B1 main.js cards window marked");
    ok((main.match(/modal\.setAttribute\("data-rs-owned", *"1"\)/g) || []).length >= 3, "B2 main.js template editor modals marked");
    for (const f of ["videostudio.js", "enhancer.js"]) ok(/data-rs-owned/.test(read("src/core/" + f)), "B3 " + f + " host marked");
    ok(/closest\("#rs-root, \[data-rs-owned\]"\)/.test(read("src/providers/arena.js")), "B4 arena.js overlayBlocking skips data-rs-owned");
    ok(/closest\("#rs-root, \[data-rs-owned\]"\)/.test(read("src/core/ui_collision_manager.js")), "B6 collision manager never treats our windows as site overlays");
  }

  // ── C. poll cost on a long chat (deterministic: selector calls, not ms) ──
  {
    const { w, d, errs } = boot(120); // 240 turns
    const until = Date.now() + 10000;
    while (Date.now() < until && !d.getElementById("rs-bar")) await sleep(50);
    await sleep(600);
    const P = w.RSProvider;
    ok(P.assistantCount() === 120, "C1 240-turn chat: assistantCount 120");
    ok(P.readAssistant().reply.length > 5000, "C2 readAssistant reads the newest reply");
    // Warm the memo once, then count DOM queries over 50 polls of the four
    // calls the core makes every ~120 ms.
    P.readAssistant(); P.isGenerating(); P.assistantCount(); P.lastAssistantId();
    const qs = w.Element.prototype.querySelector, qsa = w.Element.prototype.querySelectorAll;
    let n = 0;
    w.Element.prototype.querySelector = function () { n++; return qs.apply(this, arguments); };
    w.Element.prototype.querySelectorAll = function () { n++; return qsa.apply(this, arguments); };
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) { P.readAssistant(); P.isGenerating(); P.assistantCount(); P.lastAssistantId(); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
    w.Element.prototype.querySelector = qs; w.Element.prototype.querySelectorAll = qsa;
    // Before 2.0.1 each poll ran >= 240 element queries (one per turn per call,
    // x4 calls) = >= 48000 over 50 polls. Now only the newest turn is probed.
    ok(n < 2000, "C3 50 polls x 4 calls issue " + n + " element queries (< 2000; pre-fix >= 48000)");
    console.log("     info: " + ms.toFixed(2) + " ms per poll (4 calls) at 240 turns in jsdom");
    // Memo must not freeze the list: a new reply appended later is seen.
    const ol = d.querySelector("ol");
    const a = d.createElement("li"); a.className = "mx-auto"; a.innerHTML = `<div class="prose"><p>NEW REPLY</p></div>`;
    ol.prepend(a);
    ok(P.assistantCount() === 121 && /NEW REPLY/.test(P.readAssistant().reply), "C4 a newly mounted reply is picked up (memo is per node, not per list)");
    // An empty reply shell (no body yet) is not a turn until its body mounts.
    const shell = d.createElement("li"); shell.className = "mx-auto"; ol.prepend(shell);
    ok(P.assistantCount() === 121, "C5 empty reply shell not counted yet");
    shell.innerHTML = `<div class="prose"><p>late body</p></div>`;
    ok(P.assistantCount() === 122 && /late body/.test(P.readAssistant().reply), "C6 ...and counted once its body mounts");
    const u = d.createElement("li"); u.className = "mx-auto justify-end"; u.innerHTML = `<div class="prose"><p>me</p></div>`; ol.prepend(u);
    ok(P.userCount() === 121 && P.assistantCount() === 122, "C7 new user turn classified as user (role memo per node)");
    ok(errs.length === 0, "C8 no page errors on the long chat");
  }

  console.log(`\ntest-arena-cards-window: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
