// End-to-end simulation of the CodeCraft API provider (1.26.0+): the real
// codecraft.html page with the WHOLE bundle, a fake codecraftapi.com (models +
// SSE chat completions), the TotalScript bar, Start, bootstrap → list_commands →
// ready → ###LUA### → done. Optional (needs jsdom):
//
//   cd TotalScript && npm i --no-save jsdom && node tests/codecraft-e2e.js
//   NOKEY=1 node tests/codecraft-e2e.js   # no API key saved: bar warns, Start refuses, nothing is fetched
//   ERR402=1 node tests/codecraft-e2e.js  # the API answers 402 (out of tokens): visible error, no loop hang
//   DIAG=1 ...                            # print the [rs-diag] trace
const fs = require("fs");
const path = require("path");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch { console.error("tests/codecraft-e2e.js needs jsdom: run `npm i --no-save jsdom` in the TotalScript folder first."); process.exit(2); }

const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const pageHtml = fs.readFileSync(path.join(ROOT, "codecraft.html"), "utf8");
const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const NOKEY = !!process.env.NOKEY;
const ERR402 = !!process.env.ERR402;
const log = (...a) => console.log("[harness]", ...a);

// ── page ──────────────────────────────────────────────────────────────────
const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
const w = dom.window;
const d = w.document;
Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true });
Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
Object.defineProperty(d, "hidden", { value: false, configurable: true });
Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
const rectFor = (el) => {
  const id = el.id || "";
  const cls = String(el.className || "");
  if (id === "cc-log" || cls.includes("cc-main")) return { x: 0, y: 90, width: 1280, height: 600 };
  if (id === "cc-composer" || cls.includes("cc-dock")) return { x: 210, y: 700, width: 860, height: 140 };
  if (id === "cc-form") return { x: 210, y: 760, width: 860, height: 64 };
  if (id === "cc-input") return { x: 260, y: 770, width: 700, height: 40 };
  if (cls.includes("cc-top")) return { x: 0, y: 0, width: 1280, height: 90 };
  if (cls.includes("cc-msg")) return { x: 210, y: 120, width: 860, height: 60 };
  return { x: 210, y: 300, width: 860, height: 24 };
};
w.Element.prototype.getBoundingClientRect = function () {
  if (this.style && this.style.display === "none") return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, toJSON() { return this; } };
  const r = rectFor(this);
  return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() { return r; } };
};
w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return this.getBoundingClientRect().width; }, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return this.getBoundingClientRect().height; }, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return this.style.display === "none" ? null : d.body; }, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
w.HTMLElement.prototype.scrollIntoView = function () {};
w.Element.prototype.scrollTo = function () {};
w.scrollTo = () => {};
w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
w.cancelAnimationFrame = (id) => clearTimeout(id);
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
w.elementFromPoint = w.document.elementFromPoint = () => null;
d.execCommand = () => false;
w.HTMLCanvasElement.prototype.getContext = () => null;
if (!w.crypto) w.crypto = require("crypto").webcrypto;
w.Audio = class { constructor() {} play() { return Promise.resolve(); } pause() {} };
w.AudioContext = undefined;
w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
if (typeof w.AbortController !== "function") w.AbortController = AbortController;
w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" };
Object.defineProperty(w.navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", configurable: true });
w.open = () => null; w.alert = () => {}; w.confirm = () => true;

// ── fake codecraftapi.com ─────────────────────────────────────────────────
const apiCalls = [];
const chatRequests = [];
let modelReply = null; // (messages) => reply text
const enc = new TextEncoder();
function sse(text, { thinking = "" } = {}) {
  const chunks = [];
  if (thinking) chunks.push({ choices: [{ delta: { reasoning_content: thinking } }] });
  for (let i = 0; i < text.length; i += 24) chunks.push({ choices: [{ delta: { content: text.slice(i, i + 24) } }] });
  chunks.push({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 123 } });
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      return new Promise((res) => setTimeout(() => {
        if (i === 0) ctrl.enqueue(enc.encode(": keep-alive\n\n"));
        if (i < chunks.length) ctrl.enqueue(enc.encode("data: " + JSON.stringify(chunks[i++]) + "\n\n"));
        else { ctrl.enqueue(enc.encode("data: [DONE]\n\n")); ctrl.close(); }
        res();
      }, 8));
    },
  });
}
w.fetch = async (url, init = {}) => {
  const u = String(url);
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
  apiCalls.push({ url: u, method: init.method || "GET", auth });
  if (!/^https:\/\/codecraftapi\.com\/v1\//.test(u)) throw new Error("harness: unexpected fetch " + u);
  if (!/^Bearer cc_[A-Za-z0-9]{20,}$/.test(auth)) return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401, headers: { "content-type": "application/json" } });
  if (u.endsWith("/models")) return new Response(JSON.stringify({ object: "list", data: ["claude-opus-4.8", "kimi-k3", "gpt-5.6-terra", "deepseek-v4-pro-max"].map((id) => ({ id, object: "model" })) }), { status: 200, headers: { "content-type": "application/json" } });
  if (u.endsWith("/chat/completions")) {
    const body = JSON.parse(init.body);
    chatRequests.push(body);
    const last = body.messages[body.messages.length - 1];
    const text = typeof last.content === "string" ? last.content : last.content.map((p) => p.text || "").join("");
    log("CHAT REQUEST #" + chatRequests.length + " model=" + body.model + " msgs=" + body.messages.length + " last=" + text.slice(0, 80).replace(/\n/g, "\\n"));
    if (ERR402) return new Response(JSON.stringify({ error: { message: "You have used all tokens included in your plan for this period.", type: "insufficient_quota" } }), { status: 402, headers: { "content-type": "application/json" } });
    const reply = await modelReply(body.messages, text);
    return new Response(sse(reply.text, reply), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response("not found", { status: 404 });
};

// ── chrome.* stub ─────────────────────────────────────────────────────────
const storage = {};
const toolCalls = [];
const TOOLS = [
  { name: "execute_luau", description: "Run Luau in Studio", inputSchema: { type: "object", properties: { code: { type: "string" }, datamodel_type: { type: "string" } } } },
  { name: "get_studio_state", description: "Studio state", inputSchema: { type: "object", properties: {} } },
  { name: "screen_capture", description: "Capture", inputSchema: { type: "object", properties: {} } },
];
function statusObj() {
  return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, studioApp: true, studioProc: true, robloxProc: true, roblox_connected: true, local_connected: false, local_full: false, engine: "roblox", tools: TOOLS.length, servers: [] };
}
function background(msg) {
  switch (msg && msg.type) {
    case "status": return statusObj();
    case "studio_status": return { ok: true, studio: true, roblox_connected: true, connected: true };
    case "list_tools": return { ok: true, tools: TOOLS, studio: true, roblox_connected: true, servers: [] };
    case "command_catalog": return { ok: false };
    case "rs-open-extension-page": return { ok: true };
    case "call_tool": {
      toolCalls.push({ name: msg.name, arguments: msg.arguments });
      log("TOOL CALL:", msg.name, JSON.stringify(msg.arguments || {}).slice(0, 160));
      if (msg.name === "execute_luau" && /GetLogHistory/.test(String(msg.arguments && msg.arguments.code || ""))) return { ok: true, text: /MessageError/.test(msg.arguments.code) ? "[]" : JSON.stringify({ errors: [], warnings: [], info: [], errorCount: 0, warningCount: 0 }) };
      if (msg.name === "execute_luau") return { ok: true, text: "OK: Part created (SimPart)" };
      if (msg.name === "get_studio_state") return { ok: true, text: "{\"place\":\"Baseplate\",\"selection\":[]}" };
      return { ok: true, text: "OK" };
    }
    default: return { ok: false, error: "unhandled " + (msg && msg.type) };
  }
}
const storageApi = () => ({
  get(keys, cb) {
    const out = {};
    const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; }
    if (cb) { setTimeout(() => cb(out), 0); return; }
    return Promise.resolve(out);
  },
  set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
});
w.chrome = {
  runtime: {
    id: "harness-ext", lastError: undefined,
    getURL: (p) => "chrome-extension://harness-ext/" + p,
    sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 5); return Promise.resolve(r); },
    onMessage: { addListener() {}, removeListener() {} },
    onConnect: { addListener() {} },
    connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
    getManifest: () => manifest,
  },
  storage: { local: storageApi(), sync: storageApi(), session: storageApi(), onChanged: { addListener() {}, removeListener() {} } },
  i18n: { getMessage: () => "" },
};
const KEY = "cc_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4";
if (!NOKEY) storage.rsCodeCraft = { key: KEY, model: "kimi-k3" };
w.chrome.storage.local.set({ rsAllowPlaytest: true, rsDebugDiagnostics: !!process.env.DIAG });

// ── load the bundle exactly as codecraft.html does ────────────────────────
const pageErrors = [];
w.onerror = (m, s, l, c, err) => { pageErrors.push(String(m)); console.error("[window.onerror]", m, err && err.stack); };
w.addEventListener("unhandledrejection", (e) => { pageErrors.push(String(e.reason)); console.error("[unhandledrejection]", e.reason); });
process.on("unhandledRejection", (r) => { pageErrors.push(String(r && r.stack || r)); console.error("[unhandledRejection]", r && r.stack || r); });
for (const s of scripts) {
  const el = d.createElement("script");
  el.textContent = fs.readFileSync(path.join(ROOT, s), "utf8") + "\n//# sourceURL=" + s;
  const before = pageErrors.length;
  d.body.appendChild(el);
  if (pageErrors.length > before) { console.error("[load error]", s); process.exitCode = 1; }
}
log("bundle loaded;", scripts.length, "scripts");

// ── scenario ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if (pred()) return true; } catch {} await sleep(50); }
  throw new Error("timeout waiting for " + label);
}
const results = [];
const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };
const userRows = () => [...d.querySelectorAll("#cc-log article.cc-msg[data-message-role='user']")];
const assistantRows = () => [...d.querySelectorAll("#cc-log article.cc-msg[data-message-role='assistant']")];

(async () => {
  try {
    const P = w.RSProvider;
    ok("provider is CodeCraft", P && P.id === "codecraft" && P.displayName === "CodeCraft API");
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    ok("bar mounted on the extension page", true);
    await sleep(1200);
    const bar = d.getElementById("rs-bar");
    ok("bar mounted in-flow inside the composer card (barMount)", bar.closest("#cc-composer") === d.getElementById("cc-composer") && bar.classList.contains("rs-bar-inline") && bar.classList.contains("rs-prov-codecraft"), "parent=" + (bar.parentElement && bar.parentElement.id) + " classes=" + bar.className);
    ok("model picker filled", d.getElementById("cc-model").options.length >= (NOKEY ? 10 : 4), d.getElementById("cc-model").options.length + " options");
    const buttons = [...bar.querySelectorAll("button")];
    const startBtn = buttons.find((b) => /start/i.test(b.textContent || "") || /start/i.test(b.getAttribute("aria-label") || "") || b.id === "rs-start");
    ok("start button present", !!startBtn);
    if (NOKEY) {
      ok("no key: /models was never fetched", !apiCalls.some((c) => c.url.endsWith("/models")));
      ok("no key: modeWarning tells the user where the key goes", /cc_/.test(P.modeWarning()) && /API Keys/.test(P.modeWarning()), P.modeWarning());
      ok("no key: status line says so", /No API key/i.test(d.getElementById("cc-status").textContent));
      startBtn.click();
      await sleep(2500);
      ok("no key: nothing reached /chat/completions", chatRequests.length === 0 && apiCalls.length === 0, JSON.stringify(apiCalls));
      ok("no key: a manual send is refused and focuses the key field", (() => { const ta = d.getElementById("cc-input"); ta.value = "hello"; d.getElementById("cc-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); return chatRequests.length === 0 && userRows().length === 0; })());
      // Saving a key live loads the models and unlocks the page.
      d.getElementById("cc-key").value = KEY;
      d.getElementById("cc-key-save").click();
      await waitFor(() => apiCalls.some((c) => c.url.endsWith("/models")), 3000, "models after save");
      await sleep(200);
      ok("saving a key fetches /models with the Bearer header and persists it", apiCalls[0].auth === "Bearer " + KEY && storage.rsCodeCraft && storage.rsCodeCraft.key === KEY && d.getElementById("cc-model").options.length === 4);
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    await waitFor(() => apiCalls.some((c) => c.url.endsWith("/models")), 3000, "/models");
    ok("/models fetched with the saved key (Bearer) and the stored model is selected", apiCalls[0].auth === "Bearer " + KEY && d.getElementById("cc-model").value === "kimi-k3", d.getElementById("cc-model").value);
    ok("key field is masked (password) and never echoed in the status line", d.getElementById("cc-key").type === "password" && !d.getElementById("cc-status").textContent.includes(KEY.slice(6, 30)));

    let phase = 0;
    const cmd = (name, params) => "```json\n" + JSON.stringify({ command: name, params }) + "\n```";
    modelReply = async (messages, lastText) => {
      phase++;
      if (phase === 1) return { text: "Understood. Loading the command catalogue.\n```json\n{\"command\":\"list_commands\"}\n```", thinking: "The user wants me to bootstrap." };
      if (phase === 2) return { text: "TotalScript is ready. Tell me what to build in Roblox Studio." };
      if (phase === 3) return { text: "Creating the part now.\n###LUA###\nlocal p = Instance.new(\"Part\")\np.Name = \"SimPart\"\np.Parent = workspace\nprint(\"OK\")\n###END_LUA###" };
      if (phase === 4) return { text: "Done — **SimPart** was created in `Workspace`." };
      return { text: "Noted." };
    };
    startBtn.click();
    log("clicked Start");
    if (ERR402) {
      await waitFor(() => chatRequests.length >= 1, 20000, "bootstrap request");
      await waitFor(() => d.querySelector(".cc-error"), 5000, "error row");
      const err = d.querySelector(".cc-error").textContent;
      ok("402 is shown on the assistant row", /402/.test(err) && /out of tokens|used all tokens/i.test(err), err);
      ok("scanError surfaces it to the core", /402/.test(P.scanError() || ""));
      ok("modeWarning points at the plan", /out of tokens/i.test(P.modeWarning()), P.modeWarning());
      await sleep(2500);
      ok("the page did not retry in a loop", chatRequests.length <= 2, chatRequests.length + " requests");
      ok("generation flags are clear", !P.isGenerating() && !P.isHardGenerating());
      ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
      return;
    }
    await waitFor(() => chatRequests.length >= 1, 20000, "bootstrap request");
    const boot = chatRequests[0];
    ok("bootstrap sent as a streaming chat completion on the chosen model", boot.stream === true && boot.model === "kimi-k3" && boot.messages.length === 1 && boot.messages[0].role === "user" && /TotalScript|Roblox/i.test(boot.messages[0].content), boot.messages[0].content.length + " chars");
    ok("bootstrap carries the CodeCraft rules", /CodeCraft API rules/.test(boot.messages[0].content));
    ok("user row rendered in the transcript", userRows().length === 1 && userRows()[0].textContent.includes("TotalScript"));
    await waitFor(() => chatRequests.length >= 2, 30000, "catalogue reply");
    const cat = chatRequests[1];
    ok("catalogue result typed back with full history (user/assistant/user)", cat.messages.length === 3 && cat.messages[1].role === "assistant" && /list_commands/.test(cat.messages[1].content) && /list_commands|commands|Output/i.test(cat.messages[2].content), cat.messages.map((m) => m.role).join(","));
    ok("compact catalogue stays within the token budget", cat.messages[2].content.length < 40000, cat.messages[2].content.length + " chars");
    ok("reasoning rendered in a collapsible block and not in the reply text", (() => { const th = assistantRows()[0].querySelector(".cc-think"); return !!th && !th.hidden && /bootstrap/.test(th.textContent) && !/The user wants me to bootstrap/.test(P.itemText(assistantRows()[0])); })());
    await waitFor(() => (w.__rsDiag || []).some((e) => /start\.(done|ready|complete)|session\.(started|ready)|agent\.ready/i.test(e.event)) || !/Starting…/.test(bar.textContent || ""), 40000, "session ready");
    ok("session marked started", !/Starting…/.test(bar.textContent || ""), "bar=" + (bar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100));
    await sleep(800);
    // The user types a request into the page's own composer.
    const ta = d.getElementById("cc-input");
    ta.value = "Create a part named SimPart";
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => chatRequests.length >= 3, 5000, "user request send");
    ok("manual Enter sends through the same transcript", userRows().length === 3 && ta.value === "", userRows().length + " user rows");
    await waitFor(() => toolCalls.some((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || ""))), 30000, "execute_luau call");
    const ex = toolCalls.find((c) => c.name === "execute_luau" && /SimPart/.test(String(c.arguments.code || "")));
    ok("execute_luau executed from the streamed reply with real newlines", /\n/.test(ex.arguments.code) && !/```/.test(ex.arguments.code), JSON.stringify(ex.arguments.code).slice(0, 100));
    await waitFor(() => chatRequests.length >= 4, 30000, "tool feedback send");
    const fb = chatRequests[3].messages[chatRequests[3].messages.length - 1];
    ok("tool result fed back to the model", fb.role === "user" && /OK|SimPart|Output/.test(fb.content), String(fb.content).slice(0, 100).replace(/\n/g, " "));
    await waitFor(() => (w.__rsDiag || []).some((e) => e.event === "loop.end"), 30000, "loop.end");
    ok("agent loop ended after the final text reply", true);
    ok("no duplicate execute_luau", toolCalls.filter((c) => c.name === "execute_luau" && /SimPart/.test(c.arguments.code)).length === 1);
    await sleep(800);
    const lastRow = assistantRows()[assistantRows().length - 1];
    ok("final reply rendered as markdown (bold + code) once streaming ended", !!lastRow.querySelector(".cc-body strong") && !!lastRow.querySelector(".cc-body code") && !lastRow.querySelector(".cc-live"), lastRow.querySelector(".cc-body").innerHTML.slice(0, 120));
    if (process.env.DUMP) for (const r of assistantRows()) console.log("ROW:", r.className, r.innerHTML.replace(/\s+/g, " ").slice(0, 400));
    ok("command blocks are hidden behind TotalScript chips", assistantRows().some((r) => r.querySelector("pre.rs-tool-hide")));
    ok("status line reports model + tokens", /kimi-k3/.test(d.getElementById("cc-status").textContent) && /123 tokens/.test(d.getElementById("cc-status").textContent), d.getElementById("cc-status").textContent);
    ok("every API call carried the user's key to codecraftapi.com only", apiCalls.every((c) => c.url.startsWith("https://codecraftapi.com/v1/") && c.auth === "Bearer " + KEY), apiCalls.length + " calls");
    ok("conversation key is stable across the session", /^cc[a-z0-9]+$/.test(P.conversationKey()) && w.location.hash === "#c=" + P.conversationKey(), P.conversationKey());
    // New chat clears the transcript and starts a new conversation id.
    const prevKey = P.conversationKey();
    d.getElementById("cc-new").click();
    await sleep(100);
    ok("New chat resets the transcript and the conversation id", userRows().length === 0 && P.chatIsEmpty() && P.conversationKey() !== prevKey && !d.getElementById("cc-empty").hidden);
    // Stop mid-stream: the row keeps what arrived, no error, flags clear.
    modelReply = async () => ({ text: ("streaming paragraph number N. ").repeat(80) });
    await P.codecraft.submit("tell me a long story", null, {});
    await waitFor(() => (P.readAssistant().reply || "").length > 40, 3000, "partial stream");
    ok("stream is flagged as generating while tokens arrive", P.isGenerating() && P.isHardGenerating() && !d.getElementById("cc-stop").hidden);
    d.getElementById("cc-stop").click();
    await sleep(120);
    const stopped = P.readAssistant();
    ok("Stop keeps the partial reply, clears the flags and shows no error", !P.isHardGenerating() && stopped.reply.length > 40 && stopped.reply.length < 2400 && !assistantRows()[assistantRows().length - 1].querySelector(".cc-error") && /Stopped/.test(d.getElementById("cc-status").textContent), stopped.reply.length + " chars; status=" + d.getElementById("cc-status").textContent);
    await sleep(400);
    ok("no late repaint after Stop (markdown final, no cursor)", !assistantRows()[assistantRows().length - 1].querySelector(".cc-body").classList.contains("cc-streaming"));
    ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" || ").slice(0, 300));
  } catch (e) {
    console.error("SCENARIO FAILED:", e && e.stack || e);
    process.exitCode = 1;
  } finally {
    const failed = results.filter((r) => !r[1]).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? " — " + failed + " FAILED" : ""}`);
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  }
})();
