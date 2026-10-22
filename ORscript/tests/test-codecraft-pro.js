"use strict";
// 1.36.0 — CodeCraft page extras: persistent chat library (sidebar), message
// actions (copy / edit & resend / regenerate / delete), generation settings
// drawer (temperature, max_tokens, reasoning_effort, custom instructions),
// transient-error auto-retry, usage meter, export / import, quick prompts,
// shortcuts. Drives the real codecraft.html with ONLY the provider (no core)
// against a fake codecraftapi.com. Needs jsdom (NODE_PATH=/tmp/harness/node_modules).
const fs = require("fs"), path = require("path");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch { console.log("test-codecraft-pro: jsdom missing — skipped"); process.exit(0); }
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) passed++; else { failed++; console.log("FAIL  " + name + (extra ? "  — " + extra : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { if (pred()) return true; } catch {} await sleep(20); } throw new Error("timeout: " + label); }

// ── static checks ──────────────────────────────────────────────────────────
const html = read("codecraft.html"), js = read("src/providers/codecraft.js"), css = read("ui/codecraft.css");
ok("page has the 1.36.0 controls", ["cc-side", "cc-side-toggle", "cc-side-new", "cc-search", "cc-chats", "cc-usage", "cc-import", "cc-import-file", "cc-clear-all", "cc-model-logo", "cc-settings-btn", "cc-settings", "cc-settings-close", "cc-export", "cc-temp", "cc-max-tokens", "cc-reasoning", "cc-instructions", "cc-auto-retry", "cc-ctrl-enter", "cc-show-meta", "cc-usage-total", "cc-usage-reset", "cc-jump", "cc-drop"].every((id) => html.includes(`id="${id}"`)));
ok("quick prompts are plain buttons with data-cc-prompt (no inline handlers anywhere)", (html.match(/data-cc-prompt="/g) || []).length >= 5 && !/\son[a-z]+="/i.test(html) && !/<script>/.test(html));
ok("script order unchanged: config first, provider before the core, core last", (() => { const s = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]); return s[0] === "src/core/config.js" && s.indexOf("src/providers/codecraft.js") < s.indexOf("src/core/main.js") && s[s.length - 1] === "src/core/main.js"; })());
ok("provider never adds inline handlers and only fetches codecraftapi.com", !/\son[a-z]+="/i.test(js) && [...js.matchAll(/fetch\(([^,)]+)/g)].every((m) => /API_BASE/.test(m[1])));
ok("stylesheet covers the library, drawer, actions, code bars, quick prompts and the collapsed state", [".cc-side", ".cc-settings", ".cc-actions", ".cc-pre-bar", ".cc-qp", ".cc-side-collapsed .cc-side", ".cc-jump", ".cc-drop", ".cc-chat-active"].every((sel) => css.includes(sel)));
ok("transcript persistence still never stores pixels", /imageCount: \(m\.images \|\| \[\]\)\.length/.test(js) && !/images: \(m\.images \|\| \[\]\)\.slice/.test(js));

// ── page + provider in jsdom ───────────────────────────────────────────────
const htmlNoScripts = html.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
const w = dom.window, d = w.document;
const storage = {};
const storageApi = {
  get(keys, cb) { const out = {}; const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || storage); for (const k of ks) if (k in storage) out[k] = JSON.parse(JSON.stringify(storage[k])); setTimeout(() => cb(out), 0); },
  set(obj, cb) { for (const k of Object.keys(obj)) storage[k] = JSON.parse(JSON.stringify(obj[k])); if (cb) setTimeout(cb, 0); },
  remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); },
};
w.chrome = { storage: { local: storageApi }, runtime: { getURL: (p) => "chrome-extension://harness-ext/" + p, id: "harness-ext" } };
const KEY = "cc_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4";
storage.rsCodeCraft = { key: KEY, model: "kimi-k3" };
let clip = "";
w.navigator.clipboard = { writeText: async (t) => { clip = String(t); }, readText: async () => clip };
w.prompt = () => "Renamed chat";
w.confirm = () => true;
w.HTMLElement.prototype.scrollIntoView = function () {};
w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
const enc = new TextEncoder();
function sse(text, usage) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 20) chunks.push({ choices: [{ delta: { content: text.slice(i, i + 20) } }] });
  chunks.push({ choices: [{ delta: {}, finish_reason: "stop" }], usage: usage || { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  let i = 0;
  return new ReadableStream({ pull(ctrl) { return new Promise((res) => setTimeout(() => { if (i < chunks.length) ctrl.enqueue(enc.encode("data: " + JSON.stringify(chunks[i++]) + "\n\n")); else { ctrl.enqueue(enc.encode("data: [DONE]\n\n")); ctrl.close(); } res(); }, 3)); } });
}
const requests = [];
let failNext = []; // queue of HTTP statuses to answer before succeeding
let replyText = "Hello from the fake model.\n```lua\nprint(\"hi\")\n```";
w.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!/^https:\/\/codecraftapi\.com\/v1\//.test(u)) throw new Error("unexpected fetch " + u);
  if (u.endsWith("/models")) return new Response(JSON.stringify({ data: ["kimi-k3", "claude-opus-4.8"].map((id) => ({ id })) }), { status: 200, headers: { "content-type": "application/json" } });
  const body = JSON.parse(init.body);
  requests.push(body);
  if (failNext.length) { const st = failNext.shift(); return new Response(JSON.stringify({ error: { message: "upstream hiccup " + st } }), { status: st, headers: { "content-type": "application/json" } }); }
  return new Response(sse(typeof replyText === "function" ? replyText(body) : replyText), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const errors = [];
w.addEventListener("error", (e) => errors.push(String(e.message || e)));
const el = d.createElement("script"); el.textContent = js + "\n//# sourceURL=codecraft.js"; d.body.appendChild(el);
const P = w.RSProvider, CC = P.codecraft;

(async () => {
  try {
    // the live /models answer (exactly 2 ids) lands after boot wired the page
    await waitFor(() => d.getElementById("cc-model").options.length === 2, 3000, "boot");
    await sleep(30);
    const ta = d.getElementById("cc-input");
    const send = async (text) => { ta.value = text; const n = requests.length; ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await waitFor(() => requests.length > n, 3000, "request"); await waitFor(() => !P.isHardGenerating(), 9000, "stream end"); await sleep(650); };
    const rows = () => [...d.querySelectorAll("#cc-log article.cc-msg")];

    // ── library ──
    ok("empty library placeholder", /No saved chats yet/.test(d.getElementById("cc-chats").textContent));
    await send("Build me a lobby with a spawn pad");
    ok("a sent message lands in the library index with a derived title", Array.isArray(storage.rsCodeCraftChats) && storage.rsCodeCraftChats.length === 1 && storage.rsCodeCraftChats[0].title === "Build me a lobby with a spawn pad", JSON.stringify(storage.rsCodeCraftChats));
    const firstId = CC.session.id;
    ok("the chat body is stored under its own key without pixels", storage["rsCodeCraftChat:" + firstId] && storage["rsCodeCraftChat:" + firstId].messages.length === 2 && !("images" in storage["rsCodeCraftChat:" + firstId].messages[0]));
    ok("sidebar lists it as the active chat", d.querySelector("#cc-chats .cc-chat-active .cc-chat-title") && /lobby/.test(d.querySelector("#cc-chats .cc-chat-active .cc-chat-title").textContent));
    ok("document title follows the chat", /lobby/.test(d.title));
    ok("usage meter counts the API usage", /150 tokens · 1 request/.test(d.getElementById("cc-usage").textContent), d.getElementById("cc-usage").textContent);
    ok("reply stats painted under the reply", /kimi-k3/.test(rows()[1].querySelector(".cc-meta").textContent) && /150 tokens/.test(rows()[1].querySelector(".cc-meta").textContent), rows()[1].querySelector(".cc-meta").textContent);
    ok("code block gets a copy bar with the language", rows()[1].querySelector(".cc-pre-bar .cc-pre-lang").textContent === "lua" && rows()[1].querySelector('.cc-pre-bar button[data-act="copy-code"]'));
    rows()[1].querySelector('.cc-pre-bar button[data-act="copy-code"]').click(); await sleep(10);
    ok("copy-code copies the raw code", clip === 'print("hi")', JSON.stringify(clip));

    // second chat → switch back → restore
    d.getElementById("cc-side-new").click(); await sleep(50);
    ok("New chat (sidebar) clears the transcript and keeps the first chat listed", rows().length === 0 && d.querySelectorAll("#cc-chats .cc-chat").length === 1);
    await send("Second conversation about pets");
    ok("two chats in the library, newest first", storage.rsCodeCraftChats.length === 2 && storage.rsCodeCraftChats[0].title.startsWith("Second"));
    const secondId = CC.session.id;
    // wipe this tab's sessionStorage copy so the switch must come from the library
    try { w.sessionStorage.clear(); } catch {} // (jsdom has no sessionStorage on chrome-extension:// origins — the switch comes from the library either way)
    d.querySelector(`#cc-chats button[data-chat-open="${firstId}"]`).click();
    await waitFor(() => CC.session.id === firstId && rows().length === 2, 2000, "switch");
    ok("opening a chat restores its transcript from the library and updates the hash", rows()[0].textContent.includes("lobby") && w.location.hash === "#c=" + firstId && P.conversationKey() === firstId);
    ok("usage of the restored chat is back", /150 tokens/.test(d.getElementById("cc-usage").textContent));
    d.getElementById("cc-search").value = "pets"; d.getElementById("cc-search").dispatchEvent(new w.Event("input", { bubbles: true }));
    ok("search filters the library", d.querySelectorAll("#cc-chats .cc-chat").length === 1 && /pets/.test(d.querySelector("#cc-chats .cc-chat-title").textContent));
    d.getElementById("cc-search").value = ""; d.getElementById("cc-search").dispatchEvent(new w.Event("input", { bubbles: true }));
    d.querySelector(`#cc-chats button[data-chat-pin="${firstId}"]`).click(); await sleep(30);
    ok("pinning moves a chat to the top", d.querySelectorAll("#cc-chats .cc-chat")[0].getAttribute("data-chat-id") === firstId && storage.rsCodeCraftChats.find((c) => c.id === firstId).pinned === true);
    d.querySelector(`#cc-chats button[data-chat-rename="${secondId}"]`).click(); await sleep(30);
    ok("rename persists", storage.rsCodeCraftChats.find((c) => c.id === secondId).title === "Renamed chat" && /Renamed chat/.test(d.getElementById("cc-chats").textContent));

    // ── message actions ──
    const beforeReq = requests.length;
    rows()[1].querySelector('button[data-act="regen"]').click();
    await waitFor(() => requests.length > beforeReq, 2000, "regen request");
    await waitFor(() => !P.isHardGenerating(), 5000, "regen end"); await sleep(50);
    ok("Regenerate re-asks with the same history and replaces the reply (still 2 rows)", requests[requests.length - 1].messages.length === 1 && rows().length === 2 && CC.session.messages.length === 2);
    rows()[1].querySelector('button[data-act="copy"]').click(); await sleep(10);
    ok("Copy puts the reply markdown on the clipboard", /Hello from the fake model/.test(clip) && /```lua/.test(clip));
    await send("follow-up question");
    ok("four rows now", rows().length === 4);
    rows()[0].querySelector('button[data-act="edit"]').click(); await sleep(10);
    ok("Edit puts the text back in the composer and drops that message and everything after it", ta.value === "Build me a lobby with a spawn pad" && rows().length === 0 && CC.session.messages.length === 0);
    await send(ta.value + " (edited)");
    ok("resend after edit works", rows().length === 2 && /edited/.test(rows()[0].textContent));
    rows()[1].querySelector('button[data-act="delete"]').click(); await sleep(10);
    ok("Delete removes a single message", rows().length === 1 && CC.session.messages.length === 1);

    // ── settings → request body ──
    d.getElementById("cc-settings-btn").click();
    ok("settings drawer opens", !d.getElementById("cc-settings").hidden && d.getElementById("cc-settings-btn").getAttribute("aria-expanded") === "true");
    const set = (id, v, ev) => { const e = d.getElementById(id); e.value = v; e.dispatchEvent(new w.Event(ev || "change", { bubbles: true })); };
    set("cc-temp", "0.3", "input"); set("cc-max-tokens", "4096"); set("cc-reasoning", "high"); set("cc-instructions", "Always answer in strict Luau.");
    await sleep(20);
    const body = CC.requestBody();
    ok("temperature / max_tokens / reasoning_effort flow into the request", body.temperature === 0.3 && body.max_tokens === 4096 && body.reasoning_effort === "high", JSON.stringify({ t: body.temperature, m: body.max_tokens, r: body.reasoning_effort }));
    ok("custom instructions are sent as a leading system message", body.messages[0].role === "system" && /strict Luau/.test(body.messages[0].content) && body.messages[1].role === "user");
    ok("settings persist in rsCodeCraft", storage.rsCodeCraft.temperature === 0.3 && storage.rsCodeCraft.maxTokens === 4096 && storage.rsCodeCraft.reasoning === "high" && /strict Luau/.test(storage.rsCodeCraft.instructions));
    d.getElementById("cc-temp-reset").click(); set("cc-instructions", ""); set("cc-max-tokens", ""); set("cc-reasoning", ""); await sleep(10);
    const body2 = CC.requestBody();
    ok("clearing the settings removes the params again", !("temperature" in body2) && !("max_tokens" in body2) && !("reasoning_effort" in body2) && body2.messages[0].role === "user");
    d.getElementById("cc-settings-close").click();
    ok("drawer closes", d.getElementById("cc-settings").hidden);

    // ── auto-retry ──
    failNext = [503, 429];
    const n0 = requests.length;
    await send("retry me");
    ok("429/5xx are retried (3 requests for one send) and the reply still lands", requests.length - n0 === 3 && /Hello from the fake model/.test(rows()[rows().length - 1].textContent) && !rows()[rows().length - 1].querySelector(".cc-error"), (requests.length - n0) + " requests");
    ok("retries are reported in the reply stats", /2 retries/.test(rows()[rows().length - 1].querySelector(".cc-meta").textContent), rows()[rows().length - 1].querySelector(".cc-meta").textContent);
    failNext = [402];
    const n1 = requests.length;
    ta.value = "quota"; ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => !P.isHardGenerating() && requests.length > n1, 3000, "402"); await sleep(50);
    ok("402 is NOT retried and shows the error", requests.length - n1 === 1 && /402/.test(rows()[rows().length - 1].querySelector(".cc-error").textContent));
    d.getElementById("cc-settings-btn").click(); d.getElementById("cc-auto-retry").click(); d.getElementById("cc-settings-close").click(); await sleep(10);
    failNext = [503];
    const n2 = requests.length;
    ta.value = "no retry"; ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => !P.isHardGenerating() && requests.length > n2, 3000, "503"); await sleep(50);
    ok("with auto-retry off a 503 fails immediately", requests.length - n2 === 1 && /503/.test(rows()[rows().length - 1].querySelector(".cc-error").textContent) && storage.rsCodeCraft.autoRetry === false);
    d.getElementById("cc-settings-btn").click(); d.getElementById("cc-auto-retry").click(); d.getElementById("cc-settings-close").click();

    // ── export / import ──
    const md = CC.toMarkdown();
    ok("Markdown export has the title, both roles and the code fence", /^# /.test(md) && /## You/.test(md) && /## kimi-k3/.test(md) && /```lua/.test(md));
    const json = JSON.parse(CC.toJson());
    ok("JSON export is self-describing", json.format === "orscript-codecraft-chat" && json.messages.length === CC.session.messages.length && json.messages.every((m) => !("images" in m)));
    const nChats = storage.rsCodeCraftChats.length;
    const impOk = await CC.importChat(JSON.stringify({ title: "Imported pets", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello", model: "gpt-x" }] }));
    await sleep(50);
    ok("JSON import creates a new library chat with the messages", impOk && rows().length === 2 && storage.rsCodeCraftChats.length === nChats + 1 && storage.rsCodeCraftChats[0].title === "Imported pets" && /gpt-x/.test(rows()[1].querySelector(".cc-who").textContent));
    ok("export falls back to the clipboard when object URLs are unavailable", (() => { clip = ""; const r = CC.exportChat("md"); return r === false && /Imported pets/.test(clip); })());

    // ── quick prompts, shortcuts, sidebar toggle ──
    d.getElementById("cc-new").click(); await sleep(30);
    d.querySelector("#cc-empty button[data-cc-prompt]").click();
    ok("quick prompt fills the composer", /obby/i.test(ta.value) && d.activeElement === ta);
    ta.value = "";
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(10);
    ok("Ctrl+K starts a new chat", rows().length === 0 && P.chatIsEmpty());
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(20);
    ok("Ctrl+B collapses the library and remembers it", d.getElementById("cc-app").classList.contains("cc-side-collapsed") && storage.rsCodeCraft.sideCollapsed === true);
    d.getElementById("cc-side-toggle").click(); await sleep(20);
    ok("toggle button expands it again", !d.getElementById("cc-app").classList.contains("cc-side-collapsed"));
    ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    ok("ArrowUp in an empty new chat does nothing harmful", ta.value === "");
    // ↑ edits the last user message in a chat that has one
    await send("edit me via arrow");
    ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    ok("ArrowUp in an empty composer recalls the last user message for editing", ta.value === "edit me via arrow" && rows().length === 0);

    // ── delete + clear all ──
    const delId = storage.rsCodeCraftChats[0].id;
    d.querySelector(`#cc-chats button[data-chat-delete="${delId}"]`).click(); await sleep(40);
    ok("delete removes the chat and its body", !storage.rsCodeCraftChats.some((c) => c.id === delId) && !storage["rsCodeCraftChat:" + delId]);
    d.getElementById("cc-clear-all").click(); await sleep(40);
    ok("Clear all empties the library", storage.rsCodeCraftChats.length === 0 && /No saved chats yet/.test(d.getElementById("cc-chats").textContent) && !Object.keys(storage).some((k) => k.startsWith("rsCodeCraftChat:")));
    ok("usage totals survive (profile-wide)", storage.rsCodeCraftUsage && storage.rsCodeCraftUsage.total > 0 && storage.rsCodeCraftUsage.byModel["kimi-k3"] > 0);
    ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    failed++; console.log("FAIL  scenario: " + (e && e.stack || e));
  }
  console.log(`test-codecraft-pro: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
