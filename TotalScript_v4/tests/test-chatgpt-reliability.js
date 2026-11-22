"use strict";
// Behavioral regression tests for the ChatGPT composer. Mocked jsdom only;
// no ChatGPT account, site or network is used.
const fs = require("fs");
const path = require("path");
let JSDOM, installDomShims;
try {
  ({ JSDOM } = require("jsdom"));
  ({ installDomShims } = require("./lib/e2e-page.js"));
} catch {
  console.log("test-chatgpt-reliability: jsdom missing (npm i --no-save jsdom) - skipped");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const providerSource = fs.readFileSync(path.join(ROOT, "src/providers/chatgpt.js"), "utf8");
let passed = 0, failed = 0;
function ok(name, condition, detail) {
  if (condition) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? " — " + String(detail).slice(0, 240) : "")); }
}

function makePage({
  pathname = "/c/existing",
  withSendButton = true,
  buttonState = "send",
  disabled = false,
  acceptClick = false,
  acceptEnter = false,
  addAttachmentOnPaste = false,
  replaceComposerOnInsert = false,
  newChat = "none",
  hiddenNewChat = false,
  preexistingAttachment = false,
} = {}) {
  const newChatMarkup = newChat === "none" ? "" :
    (hiddenNewChat ? '<a data-testid="create-new-chat-button" href="/" hidden>Hidden new chat</a>' : "") +
    '<a data-testid="create-new-chat-button" href="/">New chat</a>';
  const buttonMarkup = withSendButton
    ? `<button id="composer-submit-button" type="button" data-testid="${buttonState === "stop" ? "stop-button" : "send-button"}" aria-label="${buttonState === "stop" ? "Stop generating" : "Send message"}"></button>`
    : "";
  const dom = new JSDOM(`<!doctype html><html><body>
    <nav>${newChatMarkup}</nav>
    <main><div id="thread"></div>
      <form id="composer" data-testid="composer">
        <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true" role="textbox"></div>
        ${buttonMarkup}
      </form>
    </main>
  </body></html>`, {
    url: "https://chatgpt.com" + pathname,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const w = dom.window, d = w.document;
  installDomShims(w);
  // Wait loops retain their real poll-count limits, but timer sleeps are
  // immediate so a negative-path test does not spend 5+ seconds wall time.
  const nativeSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, _ms, ...args) => nativeSetTimeout(fn, 0, ...args);
  w.ClipboardEvent = class extends w.Event {
    constructor(type, init = {}) {
      super(type, init);
      Object.defineProperty(this, "clipboardData", { value: init.clipboardData || null });
    }
  };

  let editor = d.getElementById("prompt-textarea");
  const form = d.getElementById("composer");
  const button = d.getElementById("composer-submit-button");
  let clickCount = 0, enterCount = 0, didReplace = false;
  d.execCommand = (command, _showUi, value) => {
    if (command === "insertText") {
      if (replaceComposerOnInsert && !didReplace) {
        const stale = editor;
        const replacement = stale.cloneNode(false);
        stale.replaceWith(replacement);
        editor = replacement;
        didReplace = true;
        // Simulate the original React-managed node accepting the edit just as
        // React swaps it out. The provider must detect and restore this draft.
        stale.textContent = String(value);
      } else editor.textContent = String(value);
      return true;
    }
    if (command === "insertLineBreak") { editor.appendChild(d.createElement("br")); return true; }
    return false;
  };
  if (button) {
    if (disabled) button.setAttribute("aria-disabled", "true");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      clickCount++;
      if (acceptClick) editor.textContent = "";
    });
  }
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      enterCount++;
      if (acceptEnter) editor.textContent = "";
    }
  });
  const addPreview = () => {
    const preview = d.createElement("div");
    preview.className = "attachment-preview";
    const remove = d.createElement("button");
    remove.setAttribute("aria-label", "Remove attachment");
    remove.addEventListener("click", () => preview.remove());
    preview.appendChild(remove);
    form.appendChild(preview);
  };
  if (preexistingAttachment) addPreview();
  if (addAttachmentOnPaste) editor.addEventListener("paste", addPreview);
  for (const a of d.querySelectorAll('a[data-testid="create-new-chat-button"]')) {
    a.addEventListener("click", (event) => {
      event.preventDefault();
      if (newChat === "navigates") w.history.pushState({}, "", "/");
    });
  }

  w.eval(providerSource);
  const P = w.RSProvider;
  const diagnostics = [];
  P.init({ diag: (event, data) => diagnostics.push({ event, data: data || {} }) });
  return {
    dom, w, d, P, editor, currentEditor: () => editor, button, diagnostics,
    clickCount: () => clickCount,
    enterCount: () => enterCount,
  };
}

(async () => {
  const text = "Read this carefully, then continue.";
  {
    const p = makePage({ acceptClick: true });
    const result = await p.P.typeAndSend(text);
    ok("a cleared composer confirms exactly one submit", result === true && p.clickCount() === 1 && p.editor.textContent === "");
    ok("accepted send records its proof without logging the message", p.diagnostics.some((d) => d.event === "send.landed" && d.data.proof) && !JSON.stringify(p.diagnostics).includes(text));
    p.dom.window.close();
  }
  {
    const p = makePage({ acceptClick: true, replaceComposerOnInsert: true });
    const result = await p.P.typeAndSend(text);
    ok("a React-remounted composer is reacquired and repaired before submit", result === true && p.clickCount() === 1 && p.P.editorText() === "" && p.diagnostics.some((d) => d.event === "composer.recover"));
    p.dom.window.close();
  }
  {
    const p = makePage({ disabled: true });
    const result = await p.P.typeAndSend(text);
    ok("aria-disabled send is not clicked or reported as success", result === false && p.clickCount() === 0 && p.editor.textContent.includes(text));
    ok("disabled ChatGPT send gives the core a recoverable error signal", /disabled|quota/i.test(p.P.scanError() || "") && p.diagnostics.some((d) => d.event === "send.disabled"));
    p.dom.window.close();
  }
  {
    const p = makePage({ buttonState: "stop" });
    const result = await p.P.typeAndSend(text);
    ok("active Stop control blocks both Send and the Enter fallback", result === false && p.clickCount() === 0 && p.enterCount() === 0 && p.diagnostics.some((d) => d.event === "send.busy"));
    p.dom.window.close();
  }
  {
    const p = makePage({ withSendButton: false, acceptEnter: true });
    const result = await p.P.typeAndSend(text);
    ok("Enter fallback is bounded and reports a successful send", result === true && p.enterCount() === 1 && p.editor.textContent === "");
    p.dom.window.close();
  }
  {
    const p = makePage({ acceptClick: false });
    const result = await p.P.typeAndSend(text);
    ok("an unconfirmed click is attempted once without a false landing claim", result === true && p.clickCount() === 1 && p.diagnostics.some((d) => d.event === "send.unconfirmed") && !p.diagnostics.some((d) => d.event === "send.landed"));
    p.dom.window.close();
  }
  {
    const p = makePage({ withSendButton: false, acceptEnter: true, addAttachmentOnPaste: true });
    const result = await p.P.typeAndSend("Inspect this screenshot", [{ mimeType: "image/png", data: "aGVsbG8=" }]);
    ok("vision can use the single Enter fallback when ChatGPT exposes no Send button", result === true && p.enterCount() === 1 && p.P.editorText() === "");
    p.dom.window.close();
  }
  {
    const p = makePage({ acceptClick: true, addAttachmentOnPaste: true });
    const result = await p.P.typeAndSend("Inspect this screenshot", [{ mimeType: "image/png", data: "aGVsbG8=" }]);
    ok("vision send waits for a visible upload preview before its single submit", result === true && p.clickCount() === 1 && p.editor.textContent === "");
    p.dom.window.close();
  }
  {
    const p = makePage({ disabled: true, addAttachmentOnPaste: true, preexistingAttachment: true });
    let error = "";
    try { await p.P.typeAndSend("Inspect this screenshot", [{ mimeType: "image/png", data: "aGVsbG8=" }]); }
    catch (e) { error = e.message; }
    ok("a quota-blocked image send removes only its new attachment and preserves the user's file", /disabled Send/i.test(error) && p.clickCount() === 0 && p.d.querySelectorAll(".attachment-preview").length === 1);
    p.dom.window.close();
  }
  {
    const p = makePage({ acceptClick: true, addAttachmentOnPaste: false });
    let error = "";
    try { await p.P.typeAndSend("Inspect this screenshot", [{ mimeType: "image/png", data: "aGVsbG8=" }]); }
    catch (e) { error = e.message; }
    ok("an image without an upload receipt is never submitted", /did not confirm/i.test(error) && p.clickCount() === 0 && p.diagnostics.some((d) => d.event === "send.imageUnconfirmed"));
    p.dom.window.close();
  }
  {
    const p = makePage({ pathname: "/c/old", newChat: "navigates", hiddenNewChat: true });
    const result = await p.P.openNewChat();
    ok("new-chat control selection skips hidden duplicates", result === true && p.w.location.pathname === "/");
    p.dom.window.close();
  }
  {
    const p = makePage({ pathname: "/c/old", newChat: "navigates" });
    const result = await p.P.openNewChat();
    ok("new-chat navigation succeeds only after the conversation is empty and ready", result === true && p.w.location.pathname === "/");
    p.dom.window.close();
  }
  {
    const p = makePage({ pathname: "/c/old", newChat: "none" });
    const result = await p.P.openNewChat();
    ok("missing new-chat control reports failure", result === false);
    p.dom.window.close();
  }
  {
    const p = makePage({ pathname: "/c/old", newChat: "does-not-navigate" });
    const result = await p.P.openNewChat();
    ok("a click without a verified new conversation is not reported as success", result === false);
    p.dom.window.close();
  }
  {
    const p = makePage({ pathname: "/", newChat: "navigates" });
    const result = await p.P.openNewChat();
    ok("an already-empty root chat is ready without another navigation click", result === true);
    p.dom.window.close();
  }

  console.log(`\ntest-chatgpt-reliability: ${passed} passed, ${failed} failed (jsdom; no live ChatGPT site)`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
