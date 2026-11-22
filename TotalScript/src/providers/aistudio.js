// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/aistudio.js - Google AI Studio's visible prompt/chat workspace.
// This is a browser-UI adapter for aistudio.google.com, not a Gemini API client.
// It reads the rendered prompt turns, types into the on-page prompt textarea and
// submits through AI Studio's Run control. No API key, network hook or private
// endpoint is used. Live AI Studio behavior has not been verified by this project.
// eslint-disable-next-line no-unused-vars
const RSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let diag = () => {};

  // Prefer AI Studio's semantic custom elements and labelled composer controls.
  // These are UI selectors only; if the page no longer exposes them, the adapter
  // reports that the prompt box is unavailable instead of guessing at a control.
  const S = {
    userItem: ".chat-turn-container.user",
    assistantItem: ".chat-turn-container.model",
    anyItem: "ms-chat-turn .chat-turn-container.user, ms-chat-turn .chat-turn-container.model, .chat-turn-container.user, .chat-turn-container.model",
    userBody: ".user-prompt-container ms-prompt-chunk, .user-prompt-container, ms-prompt-chunk",
    assistantBody: ".model-prompt-container, .model-response-container, .response-container, .response-text",
    thinking: "ms-thought-chunk, ms-thought-accordion, [data-testid*='thinking'], [data-testid*='reasoning']",
    editor: [
      "ms-prompt-input-wrapper textarea",
      "ms-prompt-box textarea",
      "ms-autosize-textarea textarea",
      "ms-chunk-input textarea",
      "textarea.textarea",
      "textarea.gmat-body-medium",
      'textarea[aria-label="Type something or pick one from prompt gallery"]',
      'textarea[aria-label="Enter a prompt"]',
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="prompt" i]',
      'ms-prompt-input-wrapper [contenteditable="true"][role="textbox"]',
      'ms-prompt-box [contenteditable="true"][role="textbox"]',
    ],
    promptFrame: "ms-prompt-input-wrapper, ms-prompt-box, ms-prompt-input, form",
    errorSurfaces: 'ms-callout.error-callout .message, .toast.warning, .toast.error, [role="alert"], [class*="error-message"]',
  };

  const RE = {
    contextLimit: /conversation.{0,30}(too long|limit)|context.{0,24}(limit|exceeded|too long)|maximum.{0,20}(context|length)|token.{0,16}limit|start a new (chat|prompt)/i,
    tooLong: /conversation.{0,30}(too long|maximum length)|message.{0,20}too long|maximum.{0,20}(context|length)/i,
    busy: /rate limit|too many requests|try again later|temporarily unavailable|server is busy|overloaded/i,
  };

  // AI Studio may stream thinking text before its final text chunk. These are
  // conservative DOM-timing defaults, not a claim about any particular model.
  const timings = {
    GEN_IDLE_MS: 1000,
    REASON_IDLE_MS: 7000,
    WARMUP_MS: 18000,
    REASON_NOREPLY_MS: 30000,
    STABLE_MS: 4500,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###\s*(?:cmd|command|tool)\s*[:\s]\s*[A-Za-z_][A-Za-z0-9_.\/-]*\s*(?:###|---)|###mcp_tool###/i;
  const SR_SKIP = ".rs-chip, #rs-root, button, mat-icon, svg, script, style, [aria-hidden='true'], .cdk-visually-hidden, [class*='screen-reader']";
  const BLOCK_TAGS = /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|ARTICLE|SECTION|MS-PROMPT-CHUNK|MS-CMARK-NODE|MS-TEXT-CHUNK|MS-CODE-BLOCK)$/;

  function visible(el) {
    if (!el || el.hidden || (el.getAttribute && el.getAttribute("aria-hidden") === "true")) return false;
    try {
      if (el.closest && el.closest("[hidden], [aria-hidden='true']")) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity || "1") !== 0;
    } catch {
      return true;
    }
  }

  function isUserItem(item) {
    try { return !!(item && item.matches && item.matches(S.userItem)); } catch { return false; }
  }
  function isAssistantItem(item) {
    try { return !!(item && item.matches && item.matches(S.assistantItem)); } catch { return false; }
  }

  function allItems() {
    try { return Array.from(document.querySelectorAll(S.anyItem)); } catch { return []; }
  }
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const items = assistantItems();
    return items.length ? items[items.length - 1] : null;
  };

  const _itemIds = new WeakMap();
  let _nextItemId = 0;
  function itemKey(item) {
    if (!item || typeof item !== "object") return null;
    let id = _itemIds.get(item);
    if (id == null) { id = ++_nextItemId; _itemIds.set(item, id); }
    return id;
  }
  const lastAssistantId = () => itemKey(lastAssistant());

  function getEditor() {
    for (const selector of S.editor) {
      let candidates = [];
      try { candidates = Array.from(document.querySelectorAll(selector)); } catch { continue; }
      for (const el of candidates) {
        if (!visible(el) || (el.closest && el.closest("#rs-root, ms-chat-turn, .chat-turn-container, [role='dialog']"))) continue;
        if (el.disabled) continue;
        return el;
      }
    }
    return null;
  }

  function editorText() {
    const el = getEditor();
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return String(el.value || "");
    return String(el.innerText || el.textContent || "").replace(/\u00a0/g, " ");
  }

  function chatIsEmpty() { return allItems().length === 0; }
  function isFreshChat() { return chatIsEmpty() && !!getEditor(); }

  function bodyFor(item) {
    if (!item) return null;
    try {
      const selector = isUserItem(item) ? S.userBody : S.assistantBody;
      return item.querySelector(selector) || item;
    } catch { return item; }
  }

  function textWithout(root, excludeSelector) {
    if (!root) return "";
    let text = "";
    const walk = (node) => {
      if (node.nodeType === 3) { text += node.nodeValue || ""; return; }
      if (node.nodeType !== 1) return;
      try {
        if (node.matches(SR_SKIP) || (excludeSelector && node.matches(excludeSelector))) return;
      } catch {}
      const tag = String(node.tagName || "").toUpperCase();
      if (tag === "BR") { text += "\n"; return; }
      const block = BLOCK_TAGS.test(tag);
      if (block && text && !text.endsWith("\n")) text += "\n";
      for (const child of Array.from(node.childNodes || [])) walk(child);
      if (block && text && !text.endsWith("\n")) text += "\n";
    };
    try { walk(root); } catch {}
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  function itemText(item) { return textWithout(bodyFor(item), S.thinking); }
  function classifyText(item, excludeSelector) {
    const root = bodyFor(item);
    return textWithout(root, excludeSelector ? `${S.thinking}, ${excludeSelector}` : S.thinking);
  }

  function thinkingText(item) {
    if (!item) return "";
    try {
      return Array.from(item.querySelectorAll(S.thinking)).map((node) => textWithout(node)).filter(Boolean).join("\n").trim();
    } catch { return ""; }
  }

  function readAssistant(item) {
    const turn = item && isAssistantItem(item) ? item : lastAssistant();
    if (!turn) return { present: false, reply: "", thinking: "", item: null };
    return {
      present: true,
      reply: textWithout(bodyFor(turn), S.thinking),
      thinking: thinkingText(turn),
      item: turn,
    };
  }

  function streamLen(item) {
    const turn = item === undefined ? lastAssistant() : item;
    if (!turn) return 0;
    const reading = readAssistant(turn);
    return String(reading.reply || "").length + String(reading.thinking || "").length;
  }

  function snapshot() {
    const turn = lastAssistant();
    if (!turn) return { th: 0, rp: 0 };
    const reading = readAssistant(turn);
    return { th: reading.thinking.length, rp: reading.reply.length };
  }

  function composerFrame() {
    const editor = getEditor();
    if (!editor) return null;
    try {
      const promptBox = editor.closest("ms-prompt-input-wrapper, ms-prompt-box, ms-prompt-input");
      const form = editor.closest("form");
      if (promptBox && promptBox.querySelector("button, ms-run-button")) return promptBox;
      if (form) return form;
      return promptBox || editor.closest("ms-autosize-textarea, ms-chunk-input") || editor.parentElement || null;
    } catch { return editor.parentElement || null; }
  }

  function barAnchor() {
    const editor = getEditor();
    if (!editor) return null;
    try {
      return editor.closest("ms-prompt-input-wrapper, ms-prompt-box, ms-prompt-input")
        || editor.closest("form")
        || editor.closest("ms-autosize-textarea, ms-chunk-input")
        || editor.parentElement
        || null;
    } catch { return editor.parentElement || null; }
  }

  function inputIsContentEditable(editor) {
    return !!(editor && (editor.isContentEditable || (editor.getAttribute && editor.getAttribute("contenteditable") != null)));
  }
  let _locked = false;
  const _lockState = new WeakMap();
  function setInputLock(on) {
    _locked = !!on;
    const editor = getEditor();
    if (!editor) return;
    if (on) {
      if (!_lockState.has(editor)) {
        _lockState.set(editor, {
          contenteditable: editor.getAttribute("contenteditable"),
          readonly: editor.getAttribute("readonly"),
        });
      }
      if (inputIsContentEditable(editor)) editor.setAttribute("contenteditable", "false");
      else editor.setAttribute("readonly", "");
      editor.setAttribute("data-rs-locked", "1");
      return;
    }
    const prior = _lockState.get(editor);
    if (prior) {
      if (prior.contenteditable == null) editor.removeAttribute("contenteditable");
      else editor.setAttribute("contenteditable", prior.contenteditable);
      if (prior.readonly == null) editor.removeAttribute("readonly");
      else editor.setAttribute("readonly", prior.readonly);
      _lockState.delete(editor);
    }
    editor.removeAttribute("data-rs-locked");
  }

  function sendButtons() {
    const frame = composerFrame();
    if (!frame) return [];
    const selectors = [
      "ms-run-button button[type='submit']",
      "button[type='submit']",
      "button.run-button",
      'button[aria-label="Run"]',
      'button[aria-label*="Run" i]',
      'button[aria-label*="Send" i]',
    ];
    const found = [];
    const seen = new Set();
    for (const selector of selectors) {
      let buttons = [];
      try { buttons = Array.from(frame.querySelectorAll(selector)); } catch { continue; }
      for (const button of buttons) {
        if (!seen.has(button) && visible(button) && !(button.closest && button.closest("#rs-root"))) {
          seen.add(button); found.push(button);
        }
      }
      if (found.length) break;
    }
    return found;
  }

  const STOP_SELECTOR = 'button[aria-label*="stop" i], button[title*="stop" i], button[data-test-id*="stop"], button[data-testid*="stop"], button[class*="stop"], .stoppable-spinner';
  function stopButton() {
    const frame = composerFrame();
    if (!frame) return null;
    try {
      for (const node of frame.querySelectorAll(STOP_SELECTOR)) {
        if (!visible(node)) continue;
        const button = node.closest && node.closest("button");
        return button || node;
      }
    } catch {}
    return null;
  }

  let _streamItem = null, _streamMax = -1, _streamAt = 0;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamLen(item);
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now;
      return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;
  function genActive() {
    sampleStream();
    // The stop/run control is scoped to the prompt frame. If AI Studio is
    // temporarily between control states, recent rendered text growth is a
    // bounded fallback; a static response is never treated as generating.
    return !!stopButton() || grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = genActive;

  async function waitFor(predicate, timeout) {
    const ms = Number.isFinite(timeout) ? Math.max(0, timeout) : 10000;
    let polls = Math.ceil(ms / 120) + 2;
    const started = Date.now();
    while (polls-- > 0 && Date.now() - started <= ms) {
      try { if (predicate()) return true; } catch {}
      await sleep(120);
    }
    try { return !!predicate(); } catch { return false; }
  }

  function setTextareaValue(editor, value) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && typeof descriptor.set === "function" && editor.tagName === "TEXTAREA") descriptor.set.call(editor, value);
    else editor.value = value;
    try { editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); }
    catch { editor.dispatchEvent(new Event("input", { bubbles: true })); }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setContentEditableValue(editor, value) {
    editor.focus();
    let inserted = false;
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      inserted = !!document.execCommand("insertText", false, value);
    } catch {}
    if (!inserted) {
      editor.textContent = value;
      try { editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); }
      catch { editor.dispatchEvent(new Event("input", { bubbles: true })); }
    }
  }

  function pressEnter(editor) {
    const options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", options));
    editor.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  function stillTyped(editor, text) {
    const tail = String(text || "").replace(/\s+/g, " ").trim().slice(-60);
    const current = (editorText() || "").replace(/\s+/g, " ").trim();
    return !!(tail && current && (current.includes(tail) || tail.includes(current.slice(-Math.min(40, current.length)))));
  }

  // One primary submit and, only if the exact prompt is still in the composer
  // with no landing evidence, one alternate form/Enter submit. The core performs
  // its own bounded landing check too; diagnostics never include prompt text.
  async function commitSend(editor, text, pre) {
    const proof = () => {
      if (!stillTyped(editor, text)) return "composer-cleared-or-changed";
      if (userCount() > pre.users) return "user-row";
      if (assistantCount() > pre.assistants) return "assistant-row";
      if (isHardGenerating()) return "generating";
      return "";
    };
    const fireAlternate = () => {
      try {
        const form = editor.closest("form");
        if (form && typeof form.requestSubmit === "function") { form.requestSubmit(); return "submit"; }
      } catch {}
      try { pressEnter(editor); return "enter"; } catch { return "unavailable"; }
    };

    let button = sendButtons()[0] || null;
    const enabled = (candidate) => !!candidate && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true";
    let primary = "click";
    if (button && enabled(button)) {
      button.click();
    } else {
      const becameReady = await waitFor(() => {
        button = sendButtons()[0] || null;
        return enabled(button);
      }, 2500);
      if (becameReady) button.click();
      else {
        // A form-level submit is the only fallback when the labelled Run button
        // has not become usable; never click a disabled control or guess globally.
        primary = fireAlternate();
        if (primary === "unavailable") return { sent: false, how: "no-submit-control", proof: "" };
      }
    }

    let landed = "";
    await waitFor(() => !!(landed = proof()), 2500);
    if (landed) return { sent: true, how: primary, proof: landed };
    if (!stillTyped(editor, text)) return { sent: true, how: primary, proof: "composer-changed" };

    const alternate = fireAlternate();
    if (alternate === "unavailable") return { sent: false, how: primary, proof: "" };
    await waitFor(() => !!(landed = proof()), 2500);
    return { sent: !!landed, how: alternate, proof: landed };
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("Google AI Studio prompt box not found — open a prompt workspace at aistudio.google.com.");
    if (images && images.length) {
      diag("aistudio.attach.unsupported", { count: images.length });
      throw new Error("Google AI Studio image attachment is not supported by this adapter yet; the text was not sent with the image silently omitted.");
    }
    text = String(text == null ? "" : text);
    const wasLocked = _locked;
    if (wasLocked) setInputLock(false);
    try {
      if (editorText() !== text) {
        if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") setTextareaValue(editor, text);
        else setContentEditableValue(editor, text);
      }
      editor.focus();
      const ready = await waitFor(() => !!sendButtons().find((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true"), 2500);
      const pre = { users: userCount(), assistants: assistantCount() };
      diag("aistudio.send", { chars: text.length, runReady: ready });
      const result = await commitSend(editor, text, pre);
      if (result.sent) diag("aistudio.send.landed", { how: result.how, proof: result.proof });
      else diag("aistudio.send.unconfirmed", { how: result.how });
      return result.sent;
    } finally {
      if (wasLocked) setInputLock(true);
    }
  }

  function stopGeneration() {
    const button = stopButton();
    if (button) { try { button.click(); } catch {} }
  }

  function enforceComposer() { return { ready: true }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason: reason || "check", provider: "aistudio" });
    return { ready: !!getEditor() };
  }

  function scanError() {
    try {
      for (const element of document.querySelectorAll(S.errorSurfaces)) {
        if (!visible(element) || (element.closest && element.closest(S.anyItem))) continue;
        const text = String(element.innerText || element.textContent || "").trim();
        if (text.length > 8 && text.length < 600 && (RE.contextLimit.test(text) || RE.tooLong.test(text) || RE.busy.test(text))) return text.slice(0, 240);
      }
    } catch {}
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(String(text || ""));
  const isBusyMsg = (text) => RE.busy.test(String(text || ""));

  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  // AI Studio's file picker / attachment flow is not used here. Returning false
  // keeps screenshot tools unavailable until that path is actually implemented.
  const attachImages = async () => false;
  const clearAttachments = () => {};

  function conversationKey() {
    const path = String(location.pathname || "");
    const match = path.match(/\/(?:app\/)?prompts\/([^/?#]+)/i);
    if (match) {
      let id = match[1];
      try { id = decodeURIComponent(id); } catch {}
      return /^new_chat$/i.test(id) ? "" : id;
    }
    return chatIsEmpty() ? "" : path;
  }

  function modeWarning() {
    return getEditor() ? null
      : '<b>Google AI Studio</b> — open a prompt workspace at <b>aistudio.google.com</b>. TotalScript uses the visible chat UI; no Gemini API key is used.';
  }

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const editor = getEditor();
      if (!editor || !editor.contains(event.target) || !editorText().trim() || handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);

    document.addEventListener("click", (event) => {
      if (event.target && event.target.closest && event.target.closest("#rs-root")) return;
      const target = event.target && event.target.closest && event.target.closest("button");
      if (!target || !visible(target)) return;
      const stop = stopButton();
      if (stop && (target === stop || target.contains(stop))) {
        if (event.isTrusted) handlers.onNativeStop();
        return;
      }
      if (!sendButtons().includes(target)) return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  function findToolBlockSpot(item) {
    if (!item) return null;
    const root = bodyFor(item) || item;
    let hidden = null;
    let blocks = [];
    try { blocks = Array.from(root.querySelectorAll("ms-code-block, code-block, pre, .code-block")); } catch {}
    for (const node of blocks) {
      if (node.closest && node.closest(".rs-chip")) continue;
      if (!CMD_SHAPE.test(node.textContent || "")) continue;
      const target = (node.closest && (node.closest("ms-code-block, code-block"))) || node;
      if (target.classList) target.classList.add("rs-tool-hide");
      if (item.classList) item.classList.add("rs-cmd-mask");
      if (root.classList) root.classList.add("rs-cmd-mask");
      hidden = hidden || { parent: target.parentElement, ref: target };
    }
    // Plain, unfenced protocol text is rare but accepted by the shared parser.
    // Hide only small direct children containing a command marker; the sweep
    // re-checks them if AI Studio replaces the rendered markdown node.
    try {
      for (const node of Array.from(root.children || [])) {
        if (node.classList && node.classList.contains("rs-chip")) continue;
        if (node.querySelector && node.querySelector("ms-code-block, code-block, pre, .code-block")) continue;
        const text = node.textContent || "";
        if (text.length >= 600 || !CMD_SHAPE.test(text)) continue;
        node.classList.add("rs-tool-hide");
        hidden = hidden || { parent: node.parentElement, ref: node };
      }
    } catch {}
    return hidden;
  }

  return {
    id: "aistudio",
    displayName: "Google AI Studio",
    supportsVision: false,
    timings,
    thinkingSel: S.thinking,
    chipAtItemLevel: true,
    // Turn rows may be re-rendered by the host, so the core uses stable element
    // identity rather than trusting list counts as a definitive reply signal.
    reliableCounts: false,
    modeWarning,
    init({ diag: sink } = {}) { if (sink) diag = sink; },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();

if (typeof window !== "undefined") window.RSProvider = RSProvider;
