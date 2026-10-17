// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/nvidia.js — NVIDIA NIM playground adapter for Moonshot AI Kimi K3.
// The model page is a React/Kaizen playground rather than a dedicated chat app,
// so selectors are layered and the MAIN-world network tap preserves raw SSE text.
const RSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let diag = () => {};
  let _editorCache = null;
  let _locked = false;
  let _sentRid = null;
  let _netProxy = null;
  let _netProxyRid = null;
  let _netItem = null;
  let _netItemRid = null;
  let _netPreferDom = false;
  let _sentDomBaseline = null;

  const S = {
    editor: [
      'textarea[placeholder*="type text" i]',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea[aria-label*="prompt" i]',
      'textarea[aria-label*="message" i]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][data-placeholder]',
      '.ProseMirror[contenteditable="true"]',
      'textarea',
    ].join(", "),
    turns: [
      '[data-message-author-role]',
      '[data-message-role]',
      '[data-role="user"]',
      '[data-role="assistant"]',
      '[data-testid*="chat-message" i]',
      '[data-testid*="user-message" i]',
      '[data-testid*="assistant-message" i]',
      '[class*="chat-message" i]',
      '[class*="message-row" i]',
      '[class*="assistant-message" i]',
      '[class*="user-message" i]',
      'main [role="article"]',
    ].join(", "),
    errors: '[role="alert"], [data-testid*="error" i], [class*="toast" i], [class*="error" i]',
  };
  const RE = {
    context: /context.{0,20}(limit|length|exceeded)|maximum.{0,15}tokens|prompt.{0,15}too long|input.{0,15}too long/i,
    busy: /rate.?limit|too many requests|service unavailable|server busy|please try again/i,
  };
  const timings = {
    GEN_IDLE_MS: 750,
    REASON_IDLE_MS: 5000,
    WARMUP_MS: 12000,
    REASON_NOREPLY_MS: 25000,
    STABLE_MS: 3500,
    RESPONSE_TIMEOUT_MS: 420000,
    PRESTART_MS: 30000,
    GEN_STOP_GRACE_MS: 5000,
  };

  const attr = (el, name) => {
    try { return (el && el.getAttribute && el.getAttribute(name)) || ""; }
    catch { return ""; }
  };
  const signature = (el) => [
    attr(el, "data-testid"), attr(el, "data-role"), attr(el, "data-message-role"),
    attr(el, "aria-label"), attr(el, "placeholder"), attr(el, "data-placeholder"),
    typeof el?.className === "string" ? el.className : "",
  ].join(" ").toLowerCase();

  function visible(el) {
    if (!el) return false;
    try {
      if (el.closest && el.closest("#rs-root")) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 8 && rect.height > 6;
    } catch { return true; }
  }

  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = ".rs-chip" + (excludeSel ? `, ${excludeSel}` : "");
    let out = "";
    const blockTag = /^(?:P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|ARTICLE|SECTION|TR|CODE)$/i;
    const newline = () => { if (out && !out.endsWith("\n")) out += "\n"; };
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) { out += node.nodeValue || ""; return; }
      if (node.nodeType !== 1) return;
      try { if (node.matches && node.matches(skip)) return; } catch {}
      if (node.tagName === "BR") { out += "\n"; return; }
      if (blockTag.test(node.tagName || "")) newline();
      for (const child of node.childNodes || []) walk(child);
      if (blockTag.test(node.tagName || "")) newline();
    };
    walk(root);
    return out.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function buttonLabel(button) {
    return `${attr(button, "aria-label")} ${attr(button, "title")} ${attr(button, "data-testid")} ${button?.textContent || ""}`.trim().toLowerCase();
  }
  function nearbyButtons(editor) {
    let node = editor;
    for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
      try {
        const buttons = [...node.querySelectorAll('button, [role="button"]')].filter(visible);
        if (buttons.some((b) => /\bsend\b|submit|generate/.test(buttonLabel(b))) || buttons.length >= 2) return { node, buttons };
      } catch {}
    }
    return { node: editor && editor.parentElement, buttons: [] };
  }

  function editorScore(editor) {
    if (!editor || !visible(editor)) return -Infinity;
    const sig = signature(editor);
    if (/search|system prompt|json|code|curl|python|api key/.test(sig)) return -Infinity;
    try {
      if (editor.closest("pre, code, nav, header, [role='navigation'], #rs-root")) return -Infinity;
    } catch {}
    let score = 10;
    if (/type text here|type text|message|chat|ask|prompt/.test(sig)) score += 320;
    if (editor.tagName === "TEXTAREA") score += 100;
    if (attr(editor, "role").toLowerCase() === "textbox") score += 80;
    try {
      const rect = editor.getBoundingClientRect();
      if (rect.width >= 240) score += 80;
      if (rect.height >= 48) score += 40;
      score += Math.min(80, Math.max(0, rect.bottom / Math.max(1, window.innerHeight || 900) * 80));
    } catch {}
    const local = nearbyButtons(editor);
    if (local.buttons.some((b) => /\bsend\b|submit|generate/.test(buttonLabel(b)))) score += 260;
    return score;
  }

  function getEditor() {
    if (_editorCache && _editorCache.isConnected !== false && editorScore(_editorCache) > 0) return _editorCache;
    const candidates = [];
    const seen = new Set();
    try {
      for (const editor of document.querySelectorAll(S.editor)) {
        if (!editor || seen.has(editor)) continue;
        seen.add(editor);
        const score = editorScore(editor);
        if (score > 0) candidates.push({ editor, score });
      }
    } catch {}
    candidates.sort((a, b) => b.score - a.score);
    _editorCache = candidates.length ? candidates[0].editor : null;
    return _editorCache;
  }
  function editorText() {
    const editor = getEditor();
    if (!editor) return "";
    if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") return editor.value || "";
    return textWithout(editor);
  }
  function composerFrame() {
    const editor = getEditor();
    if (!editor) return null;
    try {
      return editor.closest("form")
        || editor.closest('[data-testid*="composer" i], [class*="composer" i], [class*="prompt-input" i], [class*="chat-input" i]')
        || nearbyButtons(editor).node
        || editor.parentElement;
    } catch { return editor.parentElement || editor; }
  }
  const barAnchor = () => composerFrame();
  const coverTarget = () => getEditor();

  function consentGatePresent() {
    try {
      return [...document.querySelectorAll("button")].some((button) => visible(button) && /acknowledge\s*&?\s*continue/i.test(button.textContent || ""));
    } catch { return false; }
  }
  function captchaPresent() {
    try {
      return [...document.querySelectorAll('iframe[title*="captcha" i], [class*="captcha" i]')].some(visible);
    } catch { return false; }
  }
  const loginGatePresent = () => consentGatePresent() || captchaPresent();
  function modeWarning() {
    if (consentGatePresent()) return "<b>NVIDIA NIM</b> — click <b>Acknowledge & Continue</b> first.";
    if (captchaPresent()) return "<b>NVIDIA NIM</b> — complete NVIDIA's verification first.";
    if (!/\/moonshotai\/kimi-k3\/playground\/?$/i.test(location.pathname || "")) {
      return "<b>NVIDIA NIM</b> — open the Kimi K3 Playground page.";
    }
    if (!getEditor()) return "<b>NVIDIA NIM</b> — wait for the Kimi K3 playground input to load, then reload once.";
    return "";
  }

  function netLatest() {
    try {
      const node = document.getElementById("rs-nvidia-net");
      if (!node || !node.textContent) return null;
      const value = JSON.parse(node.textContent);
      return value && value.rid && typeof value.text === "string" ? value : null;
    } catch { return null; }
  }
  function netCurrent() {
    const state = netLatest();
    if (!state || state.rid === _sentRid) return null;
    if (state.done === true && state.page && location.pathname && state.page !== location.pathname) return null;
    return state;
  }
  function rememberNet() {
    const state = netLatest();
    if (state && state.rid) _sentRid = state.rid;
  }
  function netReplyText(state) {
    if (!state) return "";
    let text = String(state.text || "");
    if (state.done === true && Array.isArray(state.nativeCalls)) {
      const calls = state.nativeCalls.filter((call) => call && call.name).map((call) => {
        let args = call.arguments;
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
        return `<tool_call>${JSON.stringify({ name: call.name, arguments: args })}</tool_call>`;
      });
      if (calls.length) text += (text ? "\n" : "") + calls.join("\n");
    }
    return text;
  }

  const _inferredRoles = new WeakMap();
  function role(item) {
    if (!item) return null;
    const inferred = _inferredRoles.get(item);
    if (inferred) return inferred;
    const raw = [
      attr(item, "data-message-author-role"), attr(item, "data-message-role"),
      attr(item, "data-role"), attr(item, "data-author"), attr(item, "aria-label"),
    ].find(Boolean);
    if (raw) {
      if (/user|human|you/i.test(raw)) return "user";
      if (/assistant|model|bot|response/i.test(raw)) return "assistant";
    }
    const sig = signature(item);
    if (/user[-_ ]?(?:message|turn)|from[-_ ]?user/.test(sig)) return "user";
    if (/assistant[-_ ]?(?:message|turn)|model[-_ ]?response|from[-_ ]?assistant/.test(sig)) return "assistant";
    const text = item.textContent || "";
    if (/^\s*(?:Output of ['"]|Starting Up|─{6,})/.test(text)) return "user";
    return null;
  }
  const isUserItem = (item) => role(item) === "user";
  const isAssistantItem = (item) => role(item) === "assistant";

  function turnRootFor(node) {
    if (!node) return null;
    try {
      return node.closest(S.turns) || node;
    } catch { return node; }
  }
  function matchingNetItem(root, state) {
    if (!root || !state || !state.text || !root.querySelectorAll) return null;
    const plain = state.text.replace(/\s+/g, " ").trim();
    if (!plain) return null;
    const head = plain.slice(0, Math.min(36, plain.length));
    const tail = plain.slice(-Math.min(36, plain.length));
    let best = null;
    let bestSize = Infinity;
    try {
      const nodes = root.querySelectorAll([
        S.turns,
        'pre', '.prose', '.markdown', '[class*="markdown" i]',
        '[data-testid*="response" i]', '[class*="response-content" i]', '[class*="output-content" i]',
      ].join(", "));
      for (const node of nodes) {
        if (!visible(node)) continue;
        const frame = composerFrame();
        if (frame && frame.contains && frame.contains(node)) continue;
        const text = textWithout(node).replace(/\s+/g, " ");
        if (!text || (!text.includes(head) && !text.includes(tail))) continue;
        const rootNode = turnRootFor(node);
        const size = textWithout(rootNode).length || text.length;
        if (size < bestSize) { best = rootNode; bestSize = size; }
      }
    } catch {}
    if (best) _inferredRoles.set(best, "assistant");
    return best;
  }
  function proxyFor(state) {
    if (!state || (!state.text && !state.thinking)) return null;
    if (!_netProxy || _netProxyRid !== state.rid) {
      _netProxy = document.createElement("article");
      _netProxy.setAttribute("data-message-role", "assistant");
      _netProxyRid = state.rid;
      _inferredRoles.set(_netProxy, "assistant");
    }
    // Keep the detached proxy synchronized. Replacing text also discards any old
    // OR chip; the core recreates it on the settled command if no DOM turn exists.
    _netProxy.textContent = state.text;
    return _netProxy;
  }
  function chatRoot() {
    const editor = getEditor();
    if (!editor) return document;
    try {
      return editor.closest('[role="main"], main, [data-testid*="playground" i], [class*="playground" i]') || document;
    } catch { return document; }
  }
  function domItems() {
    const root = chatRoot();
    const candidates = [];
    try {
      for (const item of root.querySelectorAll(S.turns)) {
        if (!visible(item)) continue;
        const frame = composerFrame();
        if (frame && frame.contains && frame.contains(item)) continue;
        if (!role(item)) continue;
        if (candidates.some((parent) => parent.contains && parent.contains(item) && role(parent) === role(item))) continue;
        candidates.push(item);
      }
    } catch {}
    return candidates;
  }
  function rememberDomBaseline() {
    const assistants = domItems().filter(isAssistantItem);
    const item = assistants.length ? assistants[assistants.length - 1] : null;
    _sentDomBaseline = { count: assistants.length, item, text: item ? textWithout(item).trim() : "" };
  }
  function allItems() {
    const root = chatRoot();
    const candidates = domItems();
    const state = netCurrent();
    _netItem = null;
    _netItemRid = null;
    _netPreferDom = false;
    if (state && (state.text || state.thinking || (state.nativeCalls && state.nativeCalls.length))) {
      const netText = netReplyText(state);
      const matched = netText && matchingNetItem(root, { ...state, text: netText });
      const assistants = candidates.filter(isAssistantItem);
      const newest = assistants.length ? assistants[assistants.length - 1] : null;
      const newestText = newest ? textWithout(newest).trim() : "";
      const baseline = _sentDomBaseline;
      const isNewDom = !!(newest && newestText && baseline &&
        (assistants.length > baseline.count || newest !== baseline.item || newestText !== baseline.text));
      // If NVIDIA changes its SSE payload, a completed blank/partial tap must not
      // shadow a demonstrably newer rendered command with a detached proxy.
      const domHasCommand = /"(?:command|tool)"\s*:|<tool_call\b|###\s*lua/i.test(newestText);
      const netHasCommand = /"(?:command|tool)"\s*:|<tool_call\b|###\s*lua/i.test(netText);
      const preferDom = state.done === true && isNewDom && (
        !netText || newestText.length > netText.length || (domHasCommand && !netHasCommand)
      );
      const item = preferDom ? newest : (matched || proxyFor({ ...state, text: netText }));
      if (item) {
        _netItem = item;
        _netItemRid = state.rid;
        _netPreferDom = preferDom;
        if (!candidates.includes(item) && !candidates.some((candidate) => candidate.contains && candidate.contains(item))) candidates.push(item);
      }
    }
    return candidates;
  }
  const assistantItems = () => allItems().filter(isAssistantItem);
  const userItems = () => allItems().filter(isUserItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => userItems().length;
  const lastAssistant = () => {
    const items = assistantItems();
    return items.length ? items[items.length - 1] : null;
  };
  const _ids = new WeakMap();
  let _idSeq = 0;
  function itemKey(item) {
    if (!item) return null;
    if (item === _netItem && _netItemRid) return _netItemRid;
    const stable = attr(item, "data-message-id") || attr(item, "data-turn-id") || item.id;
    if (stable) return stable;
    let id = _ids.get(item);
    if (!id) { id = `nvidia-${++_idSeq}`; _ids.set(item, id); }
    return id;
  }
  const lastAssistantId = () => itemKey(lastAssistant());
  function itemText(item) {
    const state = netCurrent();
    if (item && item === _netItem && state && !_netPreferDom) {
      const text = netReplyText(state);
      if (text) return text;
    }
    return textWithout(item);
  }
  const classifyText = (item, excludeSel) => {
    const state = netCurrent();
    if (item && item === _netItem && state && !_netPreferDom) {
      const text = netReplyText(state);
      if (text) return text;
    }
    return textWithout(item, excludeSel);
  };
  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const state = netCurrent();
    const useNet = state && item === _netItem && !_netPreferDom;
    return {
      present: true,
      reply: useNet ? netReplyText(state) : textWithout(item, ".rs-chip"),
      thinking: useNet && state.thinking || "",
      item,
    };
  }
  const streamLen = (item) => classifyText(item === undefined ? lastAssistant() : item, ".rs-chip").length;
  const snapshot = () => {
    const read = readAssistant();
    return read.present ? { th: read.thinking.length, rp: read.reply.length } : { th: 0, rp: 0 };
  };
  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();

  function buttons() {
    const frame = composerFrame();
    const roots = [frame, chatRoot()].filter(Boolean);
    const out = [];
    const seen = new Set();
    for (const root of roots) {
      try {
        for (const button of root.querySelectorAll('button, [role="button"]')) {
          if (!seen.has(button) && visible(button)) { seen.add(button); out.push(button); }
        }
      } catch {}
    }
    return out;
  }
  function stopButton() {
    return buttons().find((button) => /stop|cancel generation|abort/.test(buttonLabel(button))) || null;
  }
  function sendScore(button) {
    const label = buttonLabel(button);
    if (/stop|cancel|upload|image|file|tools?|parameters?|api|code|copy|reset|clear|delete|close/.test(label)) return -Infinity;
    let score = 0;
    if (/send message|send prompt|^send$|submit|generate/.test(label)) score += 500;
    if (button.type === "submit") score += 260;
    if (button.querySelector && button.querySelector("svg")) score += 20;
    const editor = getEditor();
    const frame = composerFrame();
    if (frame && frame.contains && frame.contains(button)) score += 120;
    try {
      const er = editor.getBoundingClientRect();
      const br = button.getBoundingClientRect();
      const distance = Math.abs(br.right - er.right) + Math.abs(br.top - er.bottom);
      score += Math.max(0, 260 - Math.min(260, distance));
      if (score <= 140 && (br.left < er.left + er.width * 0.55 || distance > 180)) return -Infinity;
    } catch {}
    return score;
  }
  function sendButton() {
    if (stopButton()) return null;
    const ranked = buttons().map((button) => ({ button, score: sendScore(button) })).filter((entry) => entry.score > 0);
    ranked.sort((a, b) => b.score - a.score);
    return ranked.length ? ranked[0].button : null;
  }

  function setInputLock(on) {
    _locked = !!on;
    const editor = getEditor();
    if (!editor) return;
    if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
      if (on) editor.setAttribute("readonly", "");
      else editor.removeAttribute("readonly");
      return;
    }
    if (on) {
      if (editor.dataset) editor.dataset.rsPointerEvents = editor.style.pointerEvents || "";
      editor.style.pointerEvents = "none";
      editor.style.caretColor = "transparent";
      editor.setAttribute("aria-readonly", "true");
    } else {
      editor.style.pointerEvents = editor.dataset?.rsPointerEvents || "";
      editor.style.caretColor = "";
      editor.removeAttribute("aria-readonly");
    }
  }
  function nativeValue(editor, value) {
    const proto = editor.tagName === "INPUT" ? window.HTMLInputElement?.prototype : window.HTMLTextAreaElement?.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(editor, value); else editor.value = value;
    editor.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }
  async function richValue(editor, value) {
    const hasTail = () => {
      const current = textWithout(editor).replace(/\u00a0/g, " ");
      const tail = String(value || "").slice(-60);
      return !tail || current.includes(tail.slice(-Math.min(36, tail.length)));
    };
    const selectAll = () => {
      editor.focus();
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch {}
    };
    selectAll();
    try { document.execCommand("insertText", false, value); } catch {}
    try { editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value })); }
    catch { try { editor.dispatchEvent(new Event("input", { bubbles: true })); } catch {} }
    await sleep(80);
    if (hasTail()) return true;
    try {
      selectAll();
      const transfer = new DataTransfer();
      transfer.setData("text/plain", value);
      editor.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: transfer, bubbles: true, cancelable: true, composed: true,
      }));
      await sleep(120);
    } catch {}
    return hasTail();
  }
  const SEND_MAX = 48000;
  function truncate(text) {
    text = String(text || "");
    if (text.length <= SEND_MAX) return text;
    const marker = `\n\n[…OR: ${text.length - SEND_MAX} characters omitted for NVIDIA NIM…]\n\n`;
    const room = SEND_MAX - marker.length;
    const head = Math.floor(room * 0.8);
    return text.slice(0, head) + marker + text.slice(text.length - (room - head));
  }
  async function waitFor(predicate, timeout, interval = 100) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try { const value = predicate(); if (value) return value; } catch {}
      await sleep(interval);
    }
    try { return predicate(); } catch { return null; }
  }
  function pressEnter(editor) {
    const options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", options));
    editor.dispatchEvent(new KeyboardEvent("keyup", options));
  }
  async function typeAndSend(value, images) {
    const editor = getEditor();
    if (!editor) throw new Error("NVIDIA Kimi K3 prompt box not found");
    rememberNet();
    rememberDomBaseline();
    const text = truncate(value);
    editor.focus();
    if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") nativeValue(editor, text);
    else await richValue(editor, text);
    await sleep(100);
    if (!editorText().includes(text.slice(-Math.min(40, text.length)))) {
      throw new Error("NVIDIA NIM did not accept the prompt text");
    }
    if (images && images.length && !(await attachImages(images))) {
      throw new Error("NVIDIA NIM could not attach the Studio screenshot");
    }
    const beforeRid = _sentRid;
    const landed = () => editorText().trim() === "" || !!stopButton() || (netLatest()?.rid && netLatest().rid !== beforeRid);
    const send = await waitFor(() => {
      const button = sendButton();
      return button && !button.disabled && attr(button, "aria-disabled") !== "true" ? button : null;
    }, 2500);
    if (send) {
      diag("nvidia.send.click", { chars: text.length, label: buttonLabel(send).slice(0, 60) });
      try { send.click(); } catch {}
      if (await waitFor(landed, 1800)) return;
    }
    const form = editor.closest && editor.closest("form");
    if (form) {
      try { if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); } catch {}
      if (await waitFor(landed, 1200)) return;
    }
    pressEnter(editor);
    if (await waitFor(landed, 1500)) return;
    throw new Error("NVIDIA NIM kept the message in the prompt box instead of sending it");
  }

  function isGenerating() {
    const state = netCurrent();
    if (state && !state.done) return true;
    return !!stopButton();
  }
  const isBusyNow = isGenerating;
  const isHardGenerating = isGenerating;
  function stopGeneration() {
    const button = stopButton();
    if (button) try { button.click(); } catch {}
  }

  function fileFromImage(image, index) {
    const mime = image.mimeType || "image/png";
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], `or_nvidia_${Date.now()}_${index}.${mime.includes("png") ? "png" : "jpg"}`, { type: mime });
  }
  async function attachImages(images) {
    if (!images?.length) return false;
    const input = document.querySelector('input[type="file"][accept*="image" i], input[type="file"][accept*="png" i]');
    if (!input) return false;
    try {
      const transfer = new DataTransfer();
      images.forEach((image, index) => transfer.items.add(fileFromImage(image, index)));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch { return false; }
  }
  function clearAttachments() {
    const frame = composerFrame();
    if (!frame?.querySelectorAll) return;
    for (const button of frame.querySelectorAll('button[aria-label*="remove" i], button[aria-label*="delete" i]')) {
      try { button.click(); } catch {}
    }
  }

  function scanError() {
    const state = netCurrent();
    if (state && state.error) return String(state.error).slice(0, 260);
    try {
      for (const node of document.querySelectorAll(S.errors)) {
        if (!visible(node)) continue;
        const text = (node.innerText || node.textContent || "").trim();
        if (text.length > 5 && text.length < 700 && (RE.context.test(text) || RE.busy.test(text))) return text.slice(0, 260);
      }
    } catch {}
    return null;
  }
  function findContinueBtn() {
    return buttons().find((button) => /^continue(?: generating)?$/i.test((button.textContent || "").trim())) || null;
  }
  function clickContinueBtn() {
    const button = findContinueBtn();
    if (!button) return false;
    try { button.click(); return true; } catch { return false; }
  }
  function openNewChat() {
    const button = buttons().find((entry) => /^(?:new|clear|reset) (?:chat|conversation)$/i.test((entry.textContent || attr(entry, "aria-label")).trim()));
    if (!button) return false;
    try { button.click(); return true; } catch { return false; }
  }
  const conversationKey = () => location.pathname + location.search;

  function installSendHooks(handlers) {
    const inEditor = (event) => {
      const editor = getEditor();
      return !!editor && (event.target === editor || (editor.contains && editor.contains(event.target)));
    };
    document.addEventListener("keydown", (event) => {
      if (_locked && event.isTrusted === true && inEditor(event)) {
        try { event.preventDefault(); event.stopImmediatePropagation(); } catch {}
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || !inEditor(event)) return;
      if (!editorText().trim() || handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
    document.addEventListener("click", (event) => {
      const clicked = event.target?.closest?.('button, [role="button"]');
      if (!clicked) return;
      const stop = stopButton();
      if (stop && clicked === stop) { if (handlers.onNativeStop) handlers.onNativeStop(); return; }
      const send = sendButton();
      if (!send || clicked !== send || handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|<tool_call\b|<(?:(?:[｜|]{1,2}DSML[｜|]{1,2})?invoke)\b|<｜tool call begin｜>|"(?:toolName|tool_name|name|function)"\s*:\s*"[^"\n]+"[\s\S]{0,240}"(?:arguments|args|parameters)"\s*:|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item) {
    if (!item?.querySelectorAll) return null;
    let spot = null;
    for (const block of item.querySelectorAll('pre, [class*="code" i], [data-testid*="code" i]')) {
      if (block.closest?.(".rs-chip") || !CMD_SHAPE.test(textWithout(block))) continue;
      block.classList.add("rs-tool-hide");
      spot ||= { parent: block.parentElement, ref: block };
    }
    return spot;
  }

  return {
    id: "nvidia",
    displayName: "NVIDIA NIM · Kimi K3",
    supportsVision: true,
    timings,
    reliableCounts: false,
    // Kimi K3 always reasons before answering. Use OR's compact prompt/catalogue
    // so mandatory thinking is spent on the task rather than a large bootstrap.
    sysMaxChars: 12000,
    compactCommandList: true,
    commandListMaxChars: 6000,
    forceBootstrapCatalogue: true,
    requireLiveEngineAtBootstrap: true,
    promptExtra: "Kimi K3 thinking is always enabled. Keep reasoning concise and move to one executable OR command as soon as the action is clear. OR is a real installed local automation bridge: when SYSTEM_STATE says STUDIO LINKED, do not claim you lack access and do not merely promise an action. End with exactly one visible fenced JSON object using command and params.",
    shouldRetryCommandlessText(text) {
      text = String(text || "");
      return /\b(can(?:not|'t)|unable|not able|do not have|don't have|no (?:direct )?access|not connected|refus|won't|can only (?:provide|explain|guide)|here(?:'s| is) (?:the )?(?:code|steps)|you(?:'ll| will) need to|let me|i(?:'ll| will) (?:start|begin|inspect|check|create|build))\b/i.test(text)
        || /\b(done|completed|finished|successfully (?:created|built|updated|fixed)|(?:i have|i've) (?:created|built|updated|fixed)|(?:has been|is now) (?:created|built|updated|fixed))\b/i.test(text);
    },
    commandlessRetryFeedback: "(System note from the installed OR extension: nothing executed because your last reply had no OR command. Follow the latest SYSTEM_STATE. If STUDIO LINKED, reply now with exactly ONE fenced JSON object: {\"command\":\"exact_name\",\"params\":{...}}. If STUDIO UNLINKED, report that once. Do not add a promise or tutorial.)",
    resendSystemEvery: 8,
    init({ diag: nextDiag } = {}) {
      if (nextDiag) diag = nextDiag;
      try { document.documentElement.setAttribute("data-rs-nvidia-ver", "2026-09"); } catch {}
      diag("nvidia.init", { editor: !!getEditor(), path: location.pathname });
    },
    allItems, role, isUserItem, isAssistantItem, assistantItems, userItems,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey,
    itemText, classifyText, readAssistant, streamLen, snapshot,
    getEditor, editorText, composerFrame, barAnchor, coverTarget,
    chatIsEmpty, isFreshChat,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer: () => ({ ready: !!getEditor() && !loginGatePresent() }),
    async ensureComposerReady(reason) {
      const ready = !!getEditor() && !loginGatePresent();
      diag("nvidia.mode_ready", { reason, ready, consent: consentGatePresent(), captcha: captchaPresent() });
      return { ready, detail: ready ? "" : "Accept NVIDIA's terms/verification and wait for the playground input." };
    },
    turnHalted: () => false,
    findContinueBtn, clickContinueBtn,
    scanError,
    isTooLongMsg: (text) => RE.context.test(text || ""),
    isBusyMsg: (text) => RE.busy.test(text || ""),
    modeWarning, loginGatePresent,
    attachImages, clearAttachments,
    openNewChat, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();

if (typeof window !== "undefined") window.RSProvider = RSProvider;
