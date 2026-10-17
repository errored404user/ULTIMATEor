"use strict";
// ClickUp Brain (app.clickup.com) provider: wiring pins + adapter behaviour.
// The behaviour part runs in jsdom when it is installed (npm i --no-save jsdom)
// and is skipped otherwise; the wiring/contract part always runs.
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const src = read("src/providers/clickup.js");
const main = read("src/core/main.js"), bg = read("background.js"), popup = read("popup.js"), css = read("overlay.css"), readme = read("README.md"), ucm = read("src/core/ui_collision_manager.js");

let n = 0;
const ok = (cond, msg) => { assert(cond, msg); n++; console.log("ok   " + msg); };

// ── wiring ─────────────────────────────────────────────────────────────────
ok(manifest.host_permissions.includes("https://app.clickup.com/*"), "manifest host_permissions has app.clickup.com");
const bundle = manifest.content_scripts.find((c) => c.matches.includes("https://app.clickup.com/*") && c.world !== "MAIN");
ok(bundle, "manifest has an app.clickup.com content-script bundle");
ok(bundle.js.includes("src/providers/clickup.js"), "bundle loads src/providers/clickup.js");
ok(bundle.js.indexOf("src/providers/clickup.js") < bundle.js.indexOf("src/core/main.js"), "provider loads before the core");
const vani = manifest.content_scripts.find((c) => c.matches.includes("https://c.vani.ai/*") && c.world !== "MAIN");
ok(JSON.stringify(vani.js.map((j) => j.replace("vani.js", "clickup.js"))) === JSON.stringify(bundle.js), "bundle mirrors the Vani bundle exactly");
ok(JSON.stringify(vani.css || []) === JSON.stringify(bundle.css || []), "bundle css mirrors the Vani bundle");
for (const f of bundle.js) ok(fs.existsSync(path.join(root, f)), "bundle file exists: " + f);
ok(bg.includes('"https://app.clickup.com/*"'), "background PROVIDER_URLS lists app.clickup.com");
ok(popup.includes('"app.clickup.com"') && popup.includes('"app.clickup.com": "ClickUp Brain"'), "popup knows and names app.clickup.com");
ok(main.includes('{ name: "ClickUp Brain", url: "https://app.clickup.com/" }'), "AI switcher has a ClickUp Brain entry");
ok(/ClickUp Brain \(app\.clickup\.com\) is the AI inside the ClickUp workspace/.test(main), "providers help topic explains ClickUp Brain");
ok((css.match(/\.rs-prov-clickup\b/g) || []).length >= 4, "overlay skin .rs-prov-clickup present (inline/anchored, dark/light)");
ok(/clickup: \['\.cdk-overlay-pane \[role="dialog"\]', 'cu-modal', '\[role="dialog"\]'\]/.test(ucm), "collision manager has ClickUp (CDK overlay) rules");
ok(/ClickUp Brain/.test(readme) && /test-clickup\.js/.test(readme), "README mentions ClickUp Brain and the test");
ok(!/plazcode/i.test(src), "no PlazCode references in the adapter");

// ── contract (bare DOM mock, like tests/test-provider-wiring.js) ───────────
{
  const noop = () => {};
  const el = () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, contains: () => false, toggle: noop }, setAttribute: noop, getAttribute: () => null, removeAttribute: noop, appendChild: (c) => c, remove: noop, addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false, getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }), children: [], childNodes: [] });
  const doc = { ...el(), createElement: el, body: el(), documentElement: el(), getElementById: () => null, execCommand: () => true };
  const win = { document: doc, location: { href: "https://app.clickup.com/123/home", hostname: "app.clickup.com", pathname: "/123/home", search: "" }, navigator: {}, addEventListener: noop, setTimeout, clearTimeout, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", overflowY: "visible" }), innerWidth: 1280, innerHeight: 800, WeakMap, Map, Set, Date, URLSearchParams, Event: class {}, KeyboardEvent: class {}, InputEvent: class {}, ClipboardEvent: class {}, CustomEvent: class {}, DataTransfer: class { constructor() { this.items = { add: noop, length: 0 }; this.files = []; } setData() {} }, File: class {}, atob: (s) => s, Uint8Array };
  win.window = win;
  vm.runInContext(src + "\n;window.__P = RSProvider;", vm.createContext(win));
  const P = win.__P;
  ok(P && P.id === "clickup" && P.displayName === "ClickUp Brain", "adapter id/displayName");
  for (const m of ["getEditor", "typeAndSend", "readAssistant", "installSendHooks", "allItems", "isGenerating", "stopGeneration", "attachImages", "scanError", "modeWarning", "loginGatePresent", "conversationKey", "findToolBlockSpot", "ensureComposerReady", "ignoreMutationRecords", "snapshot", "isUserItem", "chatIsEmpty", "enforceComposer", "classifyText"]) {
    ok(typeof P[m] === "function", "adapter exports " + m + "()");
  }
  ok(P.timings && P.timings.RESPONSE_TIMEOUT_MS > 60000, "adapter timings");
  ok(P.compactCommandList === true && Number(P.commandListMaxChars) >= 6000 && P.sysMaxChars === 14000 && P.forceBootstrapCatalogue === true, "compact catalogue + forced bootstrap catalogue for Brain");
  ok(/never create, edit, assign or search ClickUp tasks/.test(P.promptExtra) && /ONE fenced code block/.test(P.promptExtra), "prompt extra forbids ClickUp actions and explains the json block");
  ok(P.loginGatePresent() === false, "/123/home is not a login gate");
  win.location.pathname = "/login"; ok(P.loginGatePresent() === true, "/login is a login gate"); win.location.pathname = "/123/home";
  ok(/open Brain's chat first/.test(P.modeWarning()) && /<b>AI<\/b>/.test(P.modeWarning()), "modeWarning tells the user to open Brain when no composer is found");
  ok(P.allItems().length === 0 && P.chatIsEmpty(), "no Brain surface → no transcript rows (never reads the workspace)");
  win.location.pathname = "/123/ai/conv_9f8e7d"; ok(P.conversationKey() === "conv_9f8e7d", "conversationKey reads /ai/<id>");
  win.location.pathname = "/123/home"; win.location.search = "?aiChat=abc123"; ok(P.conversationKey() === "abc123", "conversationKey reads ?aiChat=");
  win.location.search = ""; ok(P.conversationKey() === "ws123:brain", "conversationKey falls back to the workspace id");
  ok(P.isBusyMsg("You have reached your limit of AI requests - upgrade to continue"), "allowance message counts as busy, not fatal");
  ok(P.isTooLongMsg("Your message is too long"), "too-long detection");
  ok(P.ignoreMutationRecords([{ target: el(), addedNodes: [], removedNodes: [] }]) === false, "without a Brain root no mutation is ignored");
}

// ── behaviour in jsdom (optional) ──────────────────────────────────────────
let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch {}
if (!JSDOM) {
  console.log("skip jsdom behaviour checks (npm i --no-save jsdom to run them)");
  console.log(`PASS  test-clickup: ${n} checks`);
} else {
  const html = `<!doctype html><html><body>
  <nav class="cu-sidebar"><a>Home</a><a>AI</a></nav>
  <main class="cu-main">
    <cu-task-view class="cu-task-view">
      <h1>Fix lantern bug</h1>
      <div class="cu-task-description"><div class="ql-editor" contenteditable="true" data-placeholder="Add description"><p>Task description text that mentions a message about lanterns.</p></div></div>
      <div class="cu-comments"><div class="cu-comment-message">Earlier comment about the sprint.</div><textarea placeholder="Write a comment..."></textarea></div>
    </cu-task-view>
    <cu-chat class="cu-chat-view"><div class="chat-message">Hello team</div><div class="cu-chat-input"><div class="ql-editor" contenteditable="true" data-placeholder="Message #general"></div></div></cu-chat>
  </main>
  <div class="cdk-overlay-container"><div class="cdk-overlay-pane">
    <cu-ai-side-panel class="ai-chat-panel" role="dialog" style="height:700px;width:460px">
      <header class="ai-chat__header"><b>Brain</b><button aria-label="Close">×</button></header>
      <div class="ai-chat__messages" id="msgs" style="overflow-y:auto;height:560px">
        <div class="ai-chat-message ai-chat-message--user"><div class="ai-chat-message__content"><p>Start the Roblox agent</p></div></div>
        <div class="ai-chat-message ai-chat-message--assistant"><div class="ai-chat-message__content markdown"><p>Loading the catalogue.</p><pre><code>{"command":"list_commands"}</code></pre><div class="message-actions"><button aria-label="Copy">Copy</button></div></div></div>
      </div>
      <div class="ai-chat__composer"><div class="ql-editor" contenteditable="true" data-placeholder="Ask AI anything..."></div><button data-test="ai-chat__send-button" aria-label="Send"></button><input type="file" hidden></div>
    </cu-ai-side-panel>
  </div></div>
  </body></html>`;
  const dom = new JSDOM(html, { url: "https://app.clickup.com/123/home", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(w, "innerHeight", { value: 800, configurable: true });
  w.Element.prototype.getBoundingClientRect = function () {
    const inPanel = !!this.closest("cu-ai-side-panel");
    const h = this.tagName === "CU-AI-SIDE-PANEL" ? 700 : this.id === "msgs" ? 560 : this.classList.contains("ai-chat-panel") ? 700 : 40;
    const wdt = this.tagName === "NAV" ? 220 : inPanel ? (this.classList.contains("ai-chat-message--user") ? 260 : 420) : 900;
    const left = inPanel ? (this.classList.contains("ai-chat-message--user") ? 980 : 820) : 230;
    return { x: left, y: 100, width: wdt, height: h, left, top: 100, right: left + wdt, bottom: 100 + h, toJSON() { return this; } };
  };
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  d.execCommand = (cmd, _ui, text) => { if (cmd !== "insertText") return false; const ed = d.activeElement; if (!ed) return false; ed.textContent = text; return true; };
  const diags = [];
  vm.runInContext(src + "\n;window.__P = RSProvider;", dom.getInternalVMContext());
  const P = w.__P;
  P.init({ diag: (k, v) => diags.push([k, v]) });
  const ed = P.getEditor();
  ok(ed && ed.getAttribute("data-placeholder") === "Ask AI anything..." && ed.closest("cu-ai-side-panel"), "getEditor picks the Brain composer, not the task / comment / channel editors");
  ok(P._scoreEditor(d.querySelector(".cu-task-description .ql-editor")) < P._scoreEditor(ed) && P._scoreEditor(d.querySelector("cu-chat .ql-editor")) < P._scoreEditor(ed), "editor scoring ranks the Brain box above task and channel boxes");
  ok(P._aiRoot() && P._aiRoot().tagName === "CU-AI-SIDE-PANEL", "aiRoot is the Brain side panel");
  const items = P.allItems();
  ok(items.length === 2 && items.every((i) => i.closest("cu-ai-side-panel")), "allItems reads exactly the two Brain rows (task text, comments and channel messages ignored)");
  ok(P.isUserItem(items[0]) && !P.isUserItem(items[1]) && P.isAssistantItem(items[1]), "user / assistant roles from the row classes");
  const ra = P.readAssistant();
  ok(ra.present && /Loading the catalogue\./.test(ra.reply) && ra.reply.includes('{"command":"list_commands"}') && !/Copy/.test(ra.reply), "readAssistant returns the markdown + code and skips the Copy toolbar");
  ok(P.userCount() === 1 && P.assistantCount() === 1 && !P.chatIsEmpty(), "counts");
  const spot = P.findToolBlockSpot(items[1]);
  ok(spot && spot.ref.tagName === "PRE" && spot.ref.classList.contains("rs-tool-hide"), "findToolBlockSpot hides the command <pre>");
  ok(P.composerFrame() && P.composerFrame().classList.contains("ai-chat__composer"), "composerFrame is the Brain composer wrapper");
  ok(P.modeWarning() === "", "no warning while the Brain box is visible");
  // typeAndSend: insertText path + send button click clears the editor.
  const send = d.querySelector("[data-test='ai-chat__send-button']");
  let clicked = 0;
  send.addEventListener("click", () => { clicked++; ed.textContent = ""; });
  (async () => {
    await P.typeAndSend("Output of 'list_commands':\n```json\n{\"ok\":true}\n```");
    ok(clicked === 1 && ed.textContent === "", "typeAndSend types into the Brain box and clicks its send button");
    const sendDiag = diags.find((x) => x[0] === "clickup.send");
    ok(sendDiag && sendDiag[1].how === "insertText", "typing used execCommand insertText (Quill-safe path)");
    // Mutations outside the panel are ignored; inside are not.
    ok(P.ignoreMutationRecords([{ target: d.querySelector("cu-task-view"), addedNodes: [], removedNodes: [] }]) === true, "workspace mutations outside Brain are ignored");
    ok(P.ignoreMutationRecords([{ target: d.getElementById("msgs"), addedNodes: [], removedNodes: [] }]) === false, "mutations inside the Brain transcript are observed");
    // Close the panel: no editor may be hijacked, warning asks to open Brain.
    d.querySelector(".cdk-overlay-container").remove();
    await new Promise((r) => setTimeout(r, 450));
    ok(P.getEditor() === null, "without Brain open, task / comment / channel editors are NOT used as the composer");
    ok(/open Brain's chat first/.test(P.modeWarning()), "modeWarning asks to open Brain");
    ok(P.allItems().length === 0, "no transcript rows without Brain");
    ok(/Brain chat box disappeared/.test(P.scanError() || ""), "scanError reports the closed panel");
    // Second layout: full Brain page, ProseMirror composer inside a <form>,
    // cu-brain-chat-turn custom-element rows, avatar / icon role hints, and an
    // "ai-enabled" app shell that must NOT become the transcript root.
    const html2 = `<!doctype html><html><body><cu-app class="cu-app ai-enabled">
      <nav class="cu-sidebar"><a>Home</a></nav>
      <main class="cu-main"><cu-brain-view class="brain-view">
        <div class="brain-view__scroll" style="overflow-y:auto">
          <cu-brain-chat-turn><cu-user-avatar></cu-user-avatar><div class="turn-body"><p>Start the Roblox agent please now</p></div></cu-brain-chat-turn>
          <cu-brain-chat-turn><cu-ai-icon></cu-ai-icon><div class="turn-body"><p>Sure. Loading.</p><pre><code>{"command":"list_commands"}</code></pre></div></cu-brain-chat-turn>
        </div>
        <form class="brain-view__input"><div class="ProseMirror" contenteditable="true"><p class="is-empty" data-placeholder="Ask Brain anything"><br></p></div><button type="submit" data-test="brain-chat-input__send">Send</button></form>
      </cu-brain-view></main></cu-app></body></html>`;
    const dom2 = new JSDOM(html2, { url: "https://app.clickup.com/123/ai", pretendToBeVisual: true, runScripts: "outside-only" });
    const w2 = dom2.window;
    Object.defineProperty(w2, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(w2, "innerHeight", { value: 800, configurable: true });
    w2.Element.prototype.getBoundingClientRect = function () { const t = this.tagName; const h = t === "CU-APP" ? 800 : t === "CU-BRAIN-VIEW" ? 760 : this.className === "brain-view__scroll" ? 640 : 40; const wd = t === "CU-APP" ? 1280 : t === "NAV" ? 220 : t === "CU-BRAIN-VIEW" ? 1000 : 800; return { x: 240, y: 0, width: wd, height: h, left: 240, top: 0, right: 240 + wd, bottom: h }; };
    Object.defineProperty(w2.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
    vm.runInContext(src + "\n;window.__P = RSProvider;", dom2.getInternalVMContext());
    const P2 = w2.__P;
    ok(P2.getEditor() && P2.getEditor().classList.contains("ProseMirror"), "layout 2: ProseMirror composer (placeholder on the inner <p>) is found");
    ok(P2._aiRoot() && P2._aiRoot().tagName === "CU-BRAIN-VIEW", "layout 2: the Brain view is the root, not the ai-enabled full-window app shell");
    const it2 = P2.allItems();
    ok(it2.length === 2 && it2.every((i) => i.tagName === "CU-BRAIN-CHAT-TURN"), "layout 2: cu-brain-chat-turn custom elements are the rows (form is not chrome)");
    ok(P2.isUserItem(it2[0]) && P2.isAssistantItem(it2[1]) && !P2.isUserItem(it2[1]), "layout 2: avatar → user, Brain icon → assistant");
    ok(P2.readAssistant().reply.includes('{"command":"list_commands"}'), "layout 2: reply read with the code block");
    console.log(`PASS  test-clickup: ${n} checks (incl. jsdom behaviour)`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
