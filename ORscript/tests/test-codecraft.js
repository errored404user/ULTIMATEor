"use strict";
// CodeCraft API provider (1.26.0): unit checks of the page-independent logic
// (markdown renderer, command-envelope fencing, request history budget, key
// handling, settings persistence) plus the extension wiring. The full page +
// SSE loop is covered by tests/codecraft-e2e.js (jsdom).
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) passed++; else { failed++; console.log("FAIL  " + name + (extra ? "  — " + extra : "")); } };

// ── load the provider with a stub window (no DOM page) ──────────────────────
const stored = {};
const noop = () => {};
const el = () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, contains: () => false, toggle: noop }, setAttribute: noop, getAttribute: () => null, appendChild: noop, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop });
const doc = { ...el(), createElement: el, getElementById: () => null, readyState: "complete", addEventListener: noop, documentElement: el(), body: el() };
const win = {
  document: doc, location: { href: "chrome-extension://x/codecraft.html", hash: "", pathname: "/codecraft.html", search: "" }, history: { replaceState: noop },
  setTimeout, clearTimeout, console, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp, Error, Map, Set, WeakMap, Uint8Array, atob, btoa,
  requestAnimationFrame: (fn) => setTimeout(fn, 0), AbortController, TextDecoder, fetch: async () => { throw new Error("no network in unit test"); },
  chrome: { storage: { local: { get: (k, cb) => cb({ [k]: stored[k] }), set: (o, cb) => { Object.assign(stored, o); cb && cb(); } } }, runtime: { getURL: (p) => "chrome-extension://x/" + p } },
};
win.window = win; win.globalThis = win; win.self = win;
vm.runInContext(read("src/providers/codecraft.js") + "\n;window.__P = RSProvider;", vm.createContext(win));
const P = win.__P;
const CC = P.codecraft;
ok("provider loads without a page and exposes the contract", P.id === "codecraft" && P.displayName === "CodeCraft API" && typeof P.typeAndSend === "function" && typeof P.readAssistant === "function" && P.supportsVision === true);
ok("top-level load never touched the DOM (no page → not booted)", P.chatIsEmpty() && P.getEditor() === null && P.allItems().length === 0);
ok("constants point at the real API", CC.API_BASE === "https://codecraftapi.com/v1" && CC.SITE === "https://codecraftapi.com" && CC.FALLBACK_MODELS.includes("claude-opus-4.8") && CC.FALLBACK_MODELS.length >= 12);
ok("thinking selector + timings + prompt rules present", P.thinkingSel === ".cc-think" && P.timings.RESPONSE_TIMEOUT_MS >= 300000 && /ONE fenced/.test(P.promptExtra) && /tokens are billed/i.test(P.promptExtra));
ok("compact catalogue defaults (billing-aware)", P.compactCommandList === true && P.commandListMaxChars >= 12000 && P.commandListMaxChars <= 40000 && P.sysMaxChars >= 14000);
ok("chip placement is item-level with a stable anchor", P.chipAtItemLevel === true && typeof P.chipAnchor === "function");

// ── markdown ────────────────────────────────────────────────────────────────
const md = CC.renderMarkdown;
ok("fenced code → pre/code with language class, HTML escaped", /<pre><code class="language-json">\{&quot;command&quot;:&quot;x&quot;\}<\/code><\/pre>/.test(md("```json\n{\"command\":\"x\"}\n```")));
ok("###LUA### envelope is fenced into a code block (so the core can mask it)", (() => { const h = md("Creating.\n###LUA###\nlocal p = Instance.new(\"Part\")\n###END_LUA###\nDone."); return /<p>Creating\.<\/p>/.test(h) && /<pre><code class="language-orscript">###LUA###\nlocal p = Instance\.new\(&quot;Part&quot;\)\n###END_LUA###<\/code><\/pre>/.test(h) && /<p>Done\.<\/p>/.test(h); })(), md("Creating.\n###LUA###\nlocal p\n###END_LUA###\nDone."));
ok("###MCP_TOOL### envelope and lua:server variant are fenced too", /language-orscript">###MCP_TOOL###/.test(md("###MCP_TOOL###\n{\"a\":1}\n###END_MCP_TOOL###")) && /language-orscript">###LUA:SERVER###/.test(md("###LUA:SERVER###\nprint(1)\n###END_LUA###")));
ok("an unterminated envelope (mid-stream) is fenced to the end", /language-orscript">###LUA###\nlocal p = 1<\/code>/.test(md("###LUA###\nlocal p = 1")));
ok("envelopes already inside a fence are not double-fenced", (md("```lua\n###LUA###\nx\n###END_LUA###\n```").match(/<pre>/g) || []).length === 1);
ok("bold / inline code / lists / headings", (() => { const h = md("## Title\n- one `a`\n- **two**\n1. x\n2. y\n\npara"); return /<h4>Title<\/h4>/.test(h) && /<ul><li>one <code>a<\/code><\/li><li><strong>two<\/strong><\/li><\/ul>/.test(h) && /<ol><li>x<\/li><li>y<\/li><\/ol>/.test(h) && /<p>para<\/p>/.test(h); })(), md("## Title\n- one `a`\n- **two**\n1. x\n2. y\n\npara"));
ok("script tags are escaped, not executed", !/<script/.test(md("<script>alert(1)</script> **x**")) && /&lt;script&gt;/.test(md("<script>alert(1)</script>")));
ok("links are clickable but escaped", /<a href="https:\/\/codecraftapi\.com\/docs" target="_blank" rel="noopener">/.test(md("see https://codecraftapi.com/docs")));

// ── request assembly ────────────────────────────────────────────────────────
const sess = CC.session;
sess.messages.length = 0;
sess.messages.push({ id: "1", role: "user", content: "BOOTSTRAP " + "x".repeat(1000) });
for (let i = 0; i < 30; i++) {
  sess.messages.push({ id: "a" + i, role: "assistant", content: "reply " + i + " " + "y".repeat(30000) });
  sess.messages.push({ id: "u" + i, role: "user", content: "result " + i + " " + "z".repeat(30000) });
}
sess.messages.push({ id: "img", role: "user", content: "look", images: [{ mimeType: "image/png", data: "AAAA" }] });
sess.messages.push({ id: "empty", role: "assistant", content: "" });
let api = CC.apiMessages();
ok("message budget constants are sane", CC.session === sess && typeof CC.apiMessages === "function");
ok("history budget keeps the bootstrap first and the newest turns", api[0].role === "user" && /^BOOTSTRAP/.test(api[0].content) && api.length < 62 && /older messages omitted/.test(api[0].content + api[1].content), api.length + " msgs");
ok("the most recent messages survive the trim", api.some((m) => Array.isArray(m.content) ? /^result 29/.test(m.content[0].text) : /^result 29/.test(m.content)));
ok("total request stays within the character budget", api.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0) < 500000);
const last = api[api.length - 1];
ok("empty assistant placeholder is skipped; image message becomes OpenAI content parts (merged with the preceding user text)", last.role === "user" && Array.isArray(last.content) && last.content[0].type === "text" && /^result 29/.test(last.content[0].text) && last.content[1].text === "look" && last.content[2].type === "image_url" && /^data:image\/png;base64,AAAA$/.test(last.content[2].image_url.url), JSON.stringify(last).slice(0, 200));
sess.messages.length = 0;
sess.messages.push({ id: "1", role: "user", content: "a" }, { id: "2", role: "user", content: "b" }, { id: "3", role: "assistant", content: "c" }, { id: "4", role: "assistant", content: "d" }, { id: "5", role: "user", content: "e" });
api = CC.apiMessages();
ok("consecutive same-role rows are merged (strict OpenAI alternation)", api.map((m) => m.role).join(",") === "user,assistant,user" && api[0].content === "a\n\nb" && api[1].content === "c\n\nd", JSON.stringify(api));
// Image window: only the newest two image-bearing user turns keep pixels.
sess.messages.length = 0;
const IMG = [{ mimeType: "image/png", data: "QUJD" }];
sess.messages.push({ id: "b", role: "user", content: "boot" }, { id: "r0", role: "assistant", content: "ok" });
for (let i = 0; i < 4; i++) sess.messages.push({ id: "s" + i, role: "user", content: "shot " + i, images: IMG }, { id: "x" + i, role: "assistant", content: "seen " + i });
api = CC.apiMessages();
const imgTurns = api.filter((m) => Array.isArray(m.content));
ok("older screenshots are not re-sent (only the newest 2 image turns carry image_url parts)", imgTurns.length === 2 && imgTurns.every((m) => /shot [23]/.test(m.content[0].text)), JSON.stringify(api.map((m) => (Array.isArray(m.content) ? "IMG:" + m.content[0].text : m.content))));
ok("dropped images leave a text note", api.some((m) => typeof m.content === "string" && /shot 0\n\[1 image\(s\) were attached here earlier/.test(m.content)));
sess.messages.length = 0;
sess.messages.push({ id: "1", role: "user", content: "see", images: IMG }, { id: "2", role: "user", content: "and this" });
api = CC.apiMessages();
ok("a text row merges into a preceding image row as content parts", api.length === 1 && Array.isArray(api[0].content) && api[0].content.length === 3 && api[0].content[2].text === "and this", JSON.stringify(api));
sess.messages.length = 0;

// ── key handling / settings ─────────────────────────────────────────────────
(async () => {
  await CC.saveSettings({ key: "cc_" + "k".repeat(48), model: "kimi-k3" });
  ok("settings persist to chrome.storage.local under rsCodeCraft", stored.rsCodeCraft && stored.rsCodeCraft.key.startsWith("cc_") && stored.rsCodeCraft.model === "kimi-k3");
  ok("hasKey accepts a cc_ key", CC.hasKey() === true);
  await CC.saveSettings({ key: "nope" });
  ok("hasKey rejects junk", CC.hasKey() === false);
  ok("scanError explains the missing key", /cc_/.test(P.scanError() || ""));
  ok("isTooLongMsg / isBusyMsg classify API errors", P.isTooLongMsg("This model's maximum context length is 128000 tokens") && P.isBusyMsg("HTTP 429 rate limit exceeded") && !P.isBusyMsg("401 invalid api key"));
  ok("typeAndSend leaves the composer alone (user drafts survive agent sends)", !/ui\.input\.value = ""; autoGrow\(\); \}\n    const ok = await submit/.test(read("src/providers/codecraft.js")) && /composer is NOT used for agent sends/.test(read("src/providers/codecraft.js")));
  ok("transcript persistence never stores pixels", /imageCount: \(m\.images \|\| \[\]\)\.length/.test(read("src/providers/codecraft.js")) && !/images: \(m\.images \|\| \[\]\)\.slice/.test(read("src/providers/codecraft.js")));
  ok("typeAndSend refuses without the page (never a silent drop)", await P.typeAndSend("hi").then(() => false, (e) => /not ready|key/i.test(e.message)));

  // ── wiring ────────────────────────────────────────────────────────────────
  const manifest = JSON.parse(read("manifest.json")), main = read("src/core/main.js"), bg = read("background.js"), popup = read("popup.js"), popupHtml = read("popup.html"), css = read("overlay.css"), html = read("codecraft.html");
  ok("manifest grants the API host", manifest.host_permissions.includes("https://codecraftapi.com/*"));
  ok("page loads the full bundle with the provider before the core and no inline script", (() => { const js = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]); return js[0] === "src/core/config.js" && js.indexOf("src/providers/codecraft.js") > 0 && js.indexOf("src/providers/codecraft.js") < js.indexOf("src/core/main.js") && !/<script>/.test(html) && /ui\/codecraft\.css/.test(html) && /overlay\.css/.test(html); })());
  ok("page has the controls the provider binds", ["cc-app", "cc-log", "cc-form", "cc-input", "cc-send", "cc-stop", "cc-model", "cc-key", "cc-key-save", "cc-status", "cc-new", "cc-empty", "cc-composer", "cc-attach", "cc-attachments", "cc-file"].every((id) => html.includes(`id="${id}"`)));
  ok("page stylesheet exists and follows the light flag", fs.existsSync(path.join(root, "ui/codecraft.css")) && /html\.rs-light/.test(read("ui/codecraft.css")));
  ok("AI switcher lists CodeCraft and opens extension pages through the background", /\{ name: "CodeCraft API", url: CODECRAFT_PAGE_URL/.test(main) && /chrome\.runtime\.getURL\("codecraft\.html"\)/.test(main) && /rs-open-extension-page/.test(main) && /s\.host \|\| hostOf\(s\.url\)/.test(main));
  ok("background broadcasts to the page and serves rs-open-extension-page (allow-listed)", /async function providerTabs\(\)/.test(bg) && /chrome\.runtime\.getURL\(CODECRAFT_PAGE\) \+ "\*"/.test(bg) && !/chrome\.tabs\.query\(\{ url: PROVIDER_URLS \}, \(tabs\)/.test(bg) && /case "rs-open-extension-page"/.test(bg) && /page !== CODECRAFT_PAGE/.test(bg));
  ok("popup names the page, treats it as a supported tab and has a launcher", /isCodeCraftTab/.test(popup) && /"CodeCraft API"/.test(popup) && /getElementById\("codecraft"\)/.test(popup) && /id="codecraft"/.test(popupHtml));
  ok("overlay skin for the inline bar", /#rs-bar\.rs-bar-inline\.rs-prov-codecraft \{/.test(css) && /html\.rs-light #rs-bar\.rs-bar-inline\.rs-prov-codecraft/.test(css));
  ok("the key is only ever sent to codecraftapi.com", (() => { const src = read("src/providers/codecraft.js"); const fetches = [...src.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]); return fetches.length >= 2 && fetches.every((f) => /API_BASE/.test(f)); })());
  ok("manifest version 1.47.0", manifest.version === "1.47.0");

  console.log(`test-codecraft: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
