// Claude provider smoke (run: node test-claude.js). Not shipped.
const fs = require("fs");
const path = require("path");
const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

const root = path.join(__dirname, "..");
const claude = fs.readFileSync(path.join(root, "src/providers/claude.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const main = fs.readFileSync(path.join(root, "src/core/main.js"), "utf8");
const popup = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

ok("claude provider id", claude.includes('id: "claude"') && claude.includes('displayName: "Claude"'));
ok("claude finds ProseMirror composer", claude.includes("ProseMirror") && claude.includes("getEditor"));
ok("claude user-message selector", claude.includes('data-testid="user-message"'));
ok("claude send/stop buttons", claude.includes("Send message") && claude.includes("stopButton"));
ok("claude typeAndSend", claude.includes("function typeAndSend") && claude.includes("insertText"));
ok("bg PROVIDER_URLS has claude.ai", bg.includes("https://claude.ai/*"));
ok("overlay Switch AI lists Claude", main.includes("claude.ai"));
ok("popup SUPPORTED_HOSTS has claude.ai", popup.includes('"claude.ai"'));
ok("manifest matches claude.ai", JSON.stringify(manifest.content_scripts).includes("claude.ai"));
ok("manifest loads src/providers/claude.js", JSON.stringify(manifest.content_scripts).includes("src/providers/claude.js"));
ok("glass tokens untouched", fs.readFileSync(path.join(root, "overlay.css"), "utf8").includes("rgba(16, 17, 25, 0.82)"));

ok("every Claude family has caps", ["haiku", "sonnet", "opus", "fable", "mythos"].every((f) => claude.includes(f + ":")));
ok("does not lock the model picker", claude.includes("TotalScript never clicks it") && claude.includes("applyModelCaps") && !/modelBtn\(\)\.click|target\.click\(\)/.test(claude));
ok("thinking is read for every model", claude.includes("thinkingText") && claude.includes('data-is-thinking="true"'));
ok("Haiku gets a compact prompt", claude.includes("sysMaxChars: 12000") && claude.includes("get sysMaxChars"));
ok("Opus/Fable get long thinking windows", claude.includes("REASON_NOREPLY_MS: 35000") && claude.includes("REASON_NOREPLY_MS: 210000"));
ok("user send starts the agent loop", claude.includes("onUserMessage(assistantCount())"));
ok("prompt works on every Claude model", claude.includes("ANY Claude model") && claude.includes("promptExtra"));
ok("project chats are keyed", claude.includes("(chat|project)"));
ok("vision attach works", claude.includes("function attachImages") && !claude.includes("async function attachImages() { return false; }"));
ok("locked composer still counts as ready", claude.includes("data-rs-locked") && claude.includes("contenteditable=false") && claude.includes("visibleComposer"));
ok("getEditor falls back if the composer is locked or unlaid-out", claude.includes("if (!nodes.length) nodes = all") && claude.includes("data-rs-locked"));
ok("bar never covers page text without a composer", main.includes("Without a live composer there is no safe host-owned region") && main.includes('bar.style.display = "none"'));
ok("Start is not gated on a Claude family", claude.includes("any of them is fine") && claude.includes("const ready = !!ed"));
ok("banner is not a fake model-switch", !main.includes("into the right mode"));
const ds = fs.readFileSync(path.join(root, "src/providers/deepseek.js"), "utf8");
ok("DeepSeek Start is not blocked on Expert", ds.includes("const ready = !!getEditor()"));

// ── 2.16 regressions (static) ──
ok("turn identity is per node, not a text prefix (same-prefix turns used to collide)", claude.includes("const _idMap = new WeakMap()") && !claude.includes('":" + (item.textContent || "").slice(0, 24)'));
ok("itemKey is exported so the core's turn dedupe can use it", /lastAssistantId, itemKey, readAssistant/.test(claude));
ok("no blind last-button send fallback", !claude.includes("return buttons[buttons.length - 1] || null") && claude.includes("function sendButtonAny"));
ok("send waits for the button to light up, nudges, then Enter, then verifies once", claude.includes("send.enterFallback") && claude.includes("send.retryOnce") && claude.includes(", 8000)"));
ok("long payloads keep head AND tail", claude.includes("lines omitted") && claude.includes("send.truncated"));
ok("Stop seen-then-gone ends the turn after a 1 s double-quiet window; text-idle stays the fallback", claude.includes("STOP_GONE_QUIET_MS = 1000") && claude.includes("_stopSeenItem === last") && claude.includes("now - _streamAt < timings.GEN_IDLE_MS"));
ok("a composer mid-remount is waited for, not thrown on", claude.includes("claude.editorWait") && claude.includes("waitFor(() => !!getEditor(), 6000)"));

// ── 2.16 regressions (behavioural, jsdom optional) ──
let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch {}
if (JSDOM) {
  const dom = new JSDOM(`<main>
    <div class="font-claude-response"><div data-is-thinking="false"><p>Let me think about what the user needs</p></div><div class="standard-markdown"><p>Understood, working on it now. A</p></div></div>
    <div class="font-claude-response"><div data-is-thinking="false"><p>Let me think about what the user needs</p></div><div class="standard-markdown"><p>Understood, working on it now. B</p></div></div>
    <fieldset><div class="ProseMirror" contenteditable="true"><p>hi</p></div>
      <button aria-label="Attach files"></button><button data-testid="model-selector-dropdown">Claude Sonnet 4.5</button>
      <button aria-label="Send message" disabled></button></fieldset></main>`, { url: "https://claude.ai/chat/abc", runScripts: "outside-only" });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () { return { width: 120, height: 30, top: 0, left: 0, right: 120, bottom: 30 }; };
  w.eval(claude);
  const P = w.RSProvider;
  const items = P.allItems();
  const k0 = P.itemKey(items[0]), k1 = P.itemKey(items[1]);
  ok("two assistant turns with identical 24-char prefixes get DIFFERENT ids", items.length === 2 && k0 !== k1 && Number.isFinite(Number(k0)) && Number(k1) > Number(k0));
  ok("the id is stable while the turn streams / gets a chip", (items[1].querySelector("p").textContent += " more", P.itemKey(items[1]) === k1) && P.lastAssistantId() === k1);
  const sent = [];
  w.document.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => sent.push(b.getAttribute("aria-label") || b.getAttribute("data-testid"))));
  const ed = P.getEditor();
  const o = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
  // disabled send button + enabled attach/model buttons: the old fallback clicked the model picker.
  let enterSeen = 0; ed.addEventListener("keydown", (e) => { if (e.key === "Enter") enterSeen++; });
  w.document.execCommand = () => true;
  const t0 = Date.now();
  P.typeAndSend("hello").then(() => {
    ok("with the send button disabled nothing else in the composer is clicked", sent.length === 0, JSON.stringify(sent));
    ok("…and Enter is dispatched after a bounded wait (≤ 8 s + one verify)", enterSeen >= 1 && Date.now() - t0 < 11000);
    finishClaude();
  });
} else {
  console.log("SKIP  behavioural checks (jsdom not installed: cd TotalScript && npm i --no-save jsdom)");
  finishClaude();
}

function finishClaude() {
if (process.exitCode) {
  console.log("\nSome Claude checks failed.");
  process.exit(process.exitCode);
}
console.log("\nClaude provider checks passed.");
}
