// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/mimo.js - the Xiaomi MiMo Studio (aistudio.xiaomimimo.com)
// provider. 1.80.0.
//
// Exports the same RSProvider interface as the other adapters; the core
// (src/core/main.js) is provider-agnostic. To DISABLE MiMo support, remove this
// file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// What is KNOWN about the site (from public, dated sources - TotalScript has
// not been run against the live page by its author, so every DOM selector
// below is a best-informed guess with a semantic fallback, never a hard
// requirement):
//  - Hash-routed SPA: the chat lives at `/#/c`; a conversation is `/#/chat/<id>`.
//  - The composer is a real <textarea> inside `.dialogue-container`; the send
//    button sits in the same container and is only recognisable by its paper-
//    plane SVG path (`M.244 7.921 18.202.03 …`) - it has no stable aria-label
//    (observed by the open-source ai-clash injector, 2026-04). A "new chat"
//    button carries aria-label "新对话".
//  - The reply crosses the network as SSE from
//    `POST /open-apis/bot/chat?xiaomichatbot_ph=…` (the UltraSpeed model uses
//    `/fastchat/open-apis/bot/chat`): `event: message` frames carry
//    `{"type":"text","content":"…"}` deltas, `event: finish` carries
//    `{"content":"[DONE]"}`, `event: error` `{"type","content"}`, `event: usage`
//    token counts. Reasoning is INLINE in the text stream between `<think>` and
//    `</think>`, and the stream sprinkles U+0000 separators (mimo-web-proxy,
//    ai-clash, openclaw-zero-token - all 2026). The request body is
//    `{msgId, conversationId, query, isEditedQuery, modelConfig, multiMedias}`.
//  - Login is a Xiaomi account; basic chat has been reported to work without
//    one at times. Rate limiting answers HTTP 429 ("请求过于频繁").
//
// Strategy: the 1.65 universal stream tap (stream-net.js, MAIN world) is the
// PRIMARY reply source - it already decodes the `{"type":"text","content"}`
// dialect and closes the turn on `event: finish` / stream end - and this file
// strips the inline `<think>…</think>` reasoning and the U+0000 noise, so tool
// blocks drafted while reasoning are never executed. The DOM is the fallback
// (shape-based rows) and still anchors chips and counts turns.
// eslint-disable-next-line no-unused-vars
const RSProvider = (() => {
  "use strict";
  const SITE = { id: "mimo", name: "Xiaomi MiMo Studio", chat: "https://aistudio.xiaomimimo.com/#/c" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  // Paper-plane glyph of the send button (ai-clash, 2026-04). Compared by prefix
  // so minor path re-exports keep matching.
  const SEND_PATH_PREFIX = "M.244 7.921 18.202.03";
  const S = {
    container: ".dialogue-container",
    editor: '.dialogue-container textarea, textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"], .ProseMirror, [role="textbox"]',
    sendAria: /^(send|submit|发送|发送消息)$|send message|发送/i,
    stopAria: /stop|cancel|abort|停止|终止|取消生成/i,
    newChat: 'button[aria-label="新对话"], button[aria-label="New chat"], button[aria-label="New conversation"]',
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="message-error"],[class*="error"],[class*="notice"],[class*="ant-message"],[class*="el-message"]',
  };

  const RE = {
    contextLimit: /context.{0,20}(limit|exceeded|length|window)|conversation.{0,20}too long|(token|context).{0,10}limit|上下文.{0,10}(超出|过长|限制)|对话.{0,6}(过长|太长)|字数.{0,6}(超出|限制)/i,
    tooLong: /conversation .{0,20}(too long|getting too long)|对话.{0,6}(过长|太长)|too many tokens|message is too long/i,
    busy: /rate limit|too many requests|try again later|temporarily unavailable|server is busy|请求过于频繁|系统繁忙|稍后再试|服务繁忙|请求太快/i,
    login: /^(登录|登陆|立即登录|log ?in|sign ?in|login with xiaomi|小米账号登录)$/i,
  };

  // The tap closes the turn on the stream's `event: finish`, so windows can be
  // tight; the DOM fallbacks keep the Ox Alpha-style patience.
  const timings = {
    GEN_IDLE_MS: 600,
    REASON_IDLE_MS: 4000,
    WARMUP_MS: 12000,
    REASON_NOREPLY_MS: 25000,
    STABLE_MS: 3200,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  function visible(el) {
    if (!el || el.closest("#rs-root")) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 10) return false;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
    } catch { return false; }
    return true;
  }

  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = excludeSel ? `.rs-chip, ${excludeSel}` : ".rs-chip";
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      if (n.tagName === "BR") { t += "\n"; return; }
      const isBlock = /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|ARTICLE|SECTION|TABLE|TR)$/.test(n.tagName);
      if (isBlock && t && !t.endsWith("\n")) t += "\n";
      for (const c of n.childNodes) walk(c);
      if (isBlock && !t.endsWith("\n")) t += "\n";
    };
    walk(root);
    return t;
  }

  // ── reasoning / noise filter ─────────────────────────────────────────────
  // MiMo streams its reasoning inline: `<think>…</think>` ahead of the answer,
  // with U+0000 separators. splitThink() returns the visible answer and the
  // reasoning separately; an UNCLOSED <think> means the model is still
  // reasoning (answer = "" so far).
  function splitThink(raw) {
    let s = String(raw || "").replace(/\u0000/g, "");
    let thinking = "";
    let reply = "";
    let i = 0;
    while (i < s.length) {
      const a = s.indexOf("<think>", i);
      if (a < 0) { reply += s.slice(i); break; }
      reply += s.slice(i, a);
      const b = s.indexOf("</think>", a + 7);
      if (b < 0) { thinking += s.slice(a + 7); break; }
      thinking += s.slice(a + 7, b);
      i = b + 8;
    }
    return { reply: reply.replace(/^\s+/, ""), thinking: thinking.trim() };
  }

  const container = () => document.querySelector(S.container);
  const getEditor = () => {
    const sels = S.editor.split(",").map((s) => s.trim());
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        if (el.closest("nav, header, aside, [role='navigation'], [role='search']")) continue;
        if (el.tagName === "TEXTAREA" && el.readOnly && !el.dataset.rsPlaceholder) continue;
        return el;
      }
    }
    return null;
  };

  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    if (e.tagName === "TEXTAREA" || e.tagName === "INPUT") return e.value || "";
    return (e.innerText || e.textContent || "").replace(/\u00a0/g, " ");
  };

  function roleOf(item) {
    if (!item) return "";
    const a = (item.getAttribute("data-message-role") || item.getAttribute("data-role") || item.getAttribute("data-author") || "").toLowerCase();
    if (a) return a;
    const cls = String(item.className || "").toLowerCase();
    if (/\buser\b|human|from-user|msg-user|question|query-item/.test(cls)) return "user";
    if (/\bassistant\b|\bagent\b|\bai\b|\bbot\b|from-assistant|msg-assistant|answer|reply|response/.test(cls)) return "assistant";
    const inner = item.querySelector("[data-message-role],[data-role]");
    if (inner) return (inner.getAttribute("data-message-role") || inner.getAttribute("data-role") || "").toLowerCase();
    return "";
  }

  // The watcher asks for the transcript several times per tick; memoise for
  // one beat - the core's mutation observer calls invalidateItems() on changes.
  let _itemsCache = { at: 0, list: null };
  const invalidateItems = () => { _itemsCache = { at: 0, list: null }; };
  function allItems() {
    const now = Date.now();
    if (_itemsCache.list && now - _itemsCache.at < 120) return _itemsCache.list;
    const list = allItemsUncached();
    _itemsCache = { at: now, list };
    return list;
  }
  function allItemsUncached() {
    const root = container() || document;
    const sels = [
      "[data-message-role]",
      "[data-role='user'], [data-role='assistant']",
      "[class*='message-item'], [class*='MessageItem'], [class*='chat-message'], [class*='ChatMessage'], [class*='dialogue-item'], [class*='msg-item']",
      "[class*='question'], [class*='answer']",
      ".message, .msg, article",
    ];
    const seen = new Set();
    const out = [];
    for (const s of sels) {
      for (const el of root.querySelectorAll(s)) {
        if (seen.has(el) || !visible(el)) continue;
        // Keep the OUTERMOST match of a nested pair (a message root that
        // contains another candidate), never both.
        if ([...seen].some((p) => p.contains(el))) continue;
        seen.add(el);
        out.push(el);
      }
      if (out.length) break;
    }
    if (!out.length) {
      const log = root.querySelector("[role='log'], [role='feed'], [class*='message-list'], [class*='messages'], [class*='chat-list'], [class*='dialogue-list']");
      if (log) {
        for (const el of log.children) {
          if (el.nodeType === 1 && visible(el) && (el.innerText || "").trim()) out.push(el);
        }
      }
    }
    return out;
  }

  function isUserItem(item) {
    const r = roleOf(item);
    if (/user|human/.test(r)) return true;
    if (/assistant|agent|ai|bot|model|system/.test(r)) return false;
    return /\bml-auto\b|justify-end|items-end|self-end|text-right/.test(String(item && item.className || ""));
  }
  function isAssistantItem(item) {
    const r = roleOf(item);
    if (/assistant|agent|ai|bot|model/.test(r)) return true;
    if (/user|human/.test(r)) return false;
    return !isUserItem(item) && !!(item && (item.innerText || "").trim());
  }

  const BODY_SEL = ".prose, .markdown, .markdown-body, [class*='markdown'], [class*='message-content'], [class*='content']";
  // Reasoning drawers on the page (if MiMo renders one) - excluded from reads.
  const THINK_DOM = "[class*='think'], [class*='reason'], [class*='thought'], details";
  function itemText(item) {
    if (!item) return "";
    const body = item.querySelector(BODY_SEL) || item;
    return splitThink(textWithout(body, THINK_DOM)).reply;
  }
  function classifyText(item, excludeSel) {
    if (!item) return "";
    const body = item.querySelector(BODY_SEL) || item;
    const ex = excludeSel ? `${excludeSel}, ${THINK_DOM}` : THINK_DOM;
    if (excludeSel && body.closest && body.closest(excludeSel)) return "";
    return splitThink(textWithout(body, ex)).reply;
  }

  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => { const it = assistantItems(); return it.length ? it[it.length - 1] : null; };

  const _idMap = new WeakMap();
  let _idSeq = 0;
  function itemKey(item) {
    if (!item) return null;
    let id = _idMap.get(item);
    if (!id) { id = ++_idSeq; _idMap.set(item, id); }
    return id;
  }
  const lastAssistantId = () => itemKey(lastAssistant());

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();

  function composerFrame() {
    const ed = getEditor();
    if (!ed) return null;
    return ed.closest("form")
      || ed.closest("[class*='composer'], [class*='input-area'], [class*='input-box'], [class*='chat-input'], [class*='editor']")
      || ed.closest(S.container)
      || ed.closest("footer")
      || ed.parentElement;
  }
  function barAnchor() {
    const ed = getEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 10 && n; i++) {
      const cls = String(n.className || "");
      if (/rounded|composer|input-bar|input-box|input-area|chat-input|dialogue-input/i.test(cls)) return n;
      n = n.parentElement;
    }
    return composerFrame();
  }

  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (ed.isContentEditable || ed.getAttribute("contenteditable") === "true") {
      ed.setAttribute("contenteditable", on ? "false" : "true");
      return;
    }
    if (on) {
      if (!ed.dataset.rsPlaceholder) ed.dataset.rsPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("readonly", "");
      ed.setAttribute("placeholder", "⏳ Agent working… please wait");
    } else {
      ed.removeAttribute("readonly");
      if (ed.dataset.rsPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.rsPlaceholder);
    }
  }

  function loginGatePresent() {
    const p = ((location.hash || "") + (location.pathname || "")).toLowerCase();
    if (/\/(login|signin|sign-in|auth|passport)(\/|$|\?)/.test(p)) return true;
    if (getEditor()) return false; // a usable composer beats any "log in" link in a corner
    try {
      for (const el of document.querySelectorAll("button, a, [role='button']")) {
        if (!visible(el)) continue;
        const t = (el.textContent || "").trim();
        if (RE.login.test(t)) return true;
      }
    } catch {}
    return false;
  }

  function modeWarning() {
    if (loginGatePresent()) return "";
    if (!getEditor()) return `<b>${SITE.name}</b> — open the chat at <b>${SITE.chat}</b>. TotalScript needs the text chat (not the landing page, MiMo Claw, TTS or image pages).`;
    return "";
  }

  // ── buttons ──────────────────────────────────────────────────────────────
  const ariaOf = (b) => (b.getAttribute("aria-label") || b.title || "").trim();
  const inComposer = (b) => { const f = composerFrame() || container(); return !!(f && f.contains(b)); };
  const allButtons = () => [...document.querySelectorAll("button, [role='button']")].filter((b) => !b.closest("#rs-root"));
  const hasSendGlyph = (b) => { try { for (const p of b.querySelectorAll("path")) { const d = p.getAttribute("d") || ""; if (d.startsWith(SEND_PATH_PREFIX)) return true; } } catch {} return false; };
  const hasStopGlyph = (b) => { try { return !!b.querySelector("rect") && !b.querySelector("path[d^='M.244']"); } catch { return false; } };
  const sendButton = () =>
    allButtons().find((b) => visible(b) && hasSendGlyph(b)) ||
    allButtons().find((b) => visible(b) && S.sendAria.test(ariaOf(b)) && b.type !== "reset") ||
    // A bare <button> reports type "submit" even outside a form, so the generic
    // fallback needs a real form around it - otherwise any tool button matches.
    allButtons().find((b) => visible(b) && b.type === "submit" && !!b.closest("form") && inComposer(b)) ||
    null;
  const stopButton = () =>
    allButtons().find((b) => visible(b) && S.stopAria.test(ariaOf(b))) ||
    allButtons().find((b) => visible(b) && inComposer(b) && hasStopGlyph(b) && !sendButtonVisible()) ||
    null;
  const sendButtonVisible = () => !!allButtons().find((b) => visible(b) && hasSendGlyph(b));

  function streamText(item) {
    if (!item) return "";
    return classifyText(item, ".rs-chip").trim();
  }

  // ── 1.65 universal stream tap (stream-net.js + stream-reader.js) ─────────
  const NET = () => (typeof RSStreamNet !== "undefined" ? RSStreamNet : (window.RSStreamNet || null));
  const netRaw = () => { try { const n = NET(); return n ? n.replyText() : ""; } catch { return ""; } };
  const netParts = () => splitThink(netRaw());
  const netText = () => netParts().reply;
  const netGen = (stopVisible) => { try { const n = NET(); return n ? n.genState({ stopVisible }) : null; } catch { return null; } };
  const netMarkSent = (text) => { try { const n = NET(); if (n) n.markSent(text); } catch {} };
  const netError = () => { try { const n = NET(); const e = n && n.error(); return e ? n.describe(e, "MiMo Studio") : null; } catch { return null; } };

  const streamLen = (item) => { const nt = netText(); if (nt) return nt.length; return streamText(item === undefined ? lastAssistant() : item).length; };

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = Math.max(streamText(item).length, netRaw().length);
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  const WEDGE_MS = 10000;
  let _stopSince = 0;
  function genActive() {
    sampleStream();
    const stop = !!stopButton();
    const now = Date.now();
    const g = netGen(stop);
    if (g === "streaming") return true;
    if (g === "done" && !stop) return false;
    if (stop) {
      if (!_stopSince) _stopSince = now;
      return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2000);
    }
    _stopSince = 0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton() || netGen(false) === "streaming";

  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const it = lastAssistant();
      const p = netParts();
      return { th: p.thinking.length, rp: p.reply ? p.reply.length : (it ? streamText(it).length : 0) };
    } catch { return {}; }
  }
  function readAssistant() {
    const item = lastAssistant();
    const p = netParts();
    if (p.reply.trim() || p.thinking) return { present: true, reply: p.reply.trim(), thinking: p.thinking, item, net: true };
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    return { present: true, reply: streamText(item).trim(), thinking: "", item };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // Input limit not published; 100k chars keeps well under what the web chat
  // has been seen to accept while leaving tool results intact in practice.
  const SEND_MAX = 100000;
  function truncateForSend(text) {
    if (!text || text.length <= SEND_MAX) return text;
    const omitted = text.length - SEND_MAX;
    const marker = `\n\n[…TotalScript: result truncated to fit MiMo Studio's input limit - ${omitted} of ${text.length} characters omitted…]\n\n`;
    const budget = SEND_MAX - marker.length;
    const headLen = Math.floor(budget * 0.85);
    const tailLen = budget - headLen;
    return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  }

  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
  }

  function setRichText(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      setTextareaValue(el, text);
      return;
    }
    el.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch {}
    if (!ok) {
      el.textContent = text;
      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      } catch {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  function pressEnter(editor) {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keypress", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("MiMo Studio chat box not found — open aistudio.xiaomimimo.com/#/c");
    editor.focus();
    await sleep(40);
    text = truncateForSend(text);
    netMarkSent(text);
    setRichText(editor, text);
    await sleep(80);
    if (images && images.length) {
      try { await attachImages(images); } catch {}
    }
    const sendReady = () => {
      const b = sendButton();
      return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !/disabled/i.test(String(b.className || ""));
    };
    await waitFor(sendReady, 2500);
    diag("mimo.send", { editorLen: editorText().length, textLen: text.length, hasSend: !!sendButton() });
    let sent = false;
    for (let i = 0; i < 5 && !sent; i++) {
      const b = sendButton();
      if (b && !b.disabled) { try { b.click(); } catch {} }
      else {
        try {
          const form = editor.closest("form");
          if (form && typeof form.requestSubmit === "function") form.requestSubmit();
          else pressEnter(editor);
        } catch { pressEnter(editor); }
      }
      sent = await waitFor(() => editorText().trim() === "" || isHardGenerating(), 800);
    }
    if (!sent) diag("mimo.send_unconfirmed", { editorLen: editorText().length });
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) { try { b.click(); } catch {} }
  }

  function scanError() {
    const ne = netError();
    if (ne) return ne;
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (!visible(el)) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 4 && t.length < 600 && (RE.contextLimit.test(t) || RE.busy.test(t))) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor() && !loginGatePresent()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `totalscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  function clearAttachments() {}
  // MiMo Studio accepts uploads (its request carries `multiMedias`); the page's
  // own file input or a paste into the composer is used - never a direct
  // upload call. Returns false when neither route exists, and the core then
  // sends text only.
  async function attachImages(images) {
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    const frame = composerFrame() || container() || document;
    const fileInput = frame.querySelector('input[type="file"]') || document.querySelector('input[type="file"]');
    if (fileInput) {
      try {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch {}
    }
    try {
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch {}
    return false;
  }

  // `/#/chat/<id>` per conversation; the empty chat is `/#/c`.
  const conversationKey = () => {
    const h = String(location.hash || "");
    const m = h.match(/#\/(?:chat|c|conversation)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : (h.replace(/^#/, "") || location.pathname);
  };

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const ed = getEditor();
      if (!ed || !ed.contains(e.target)) return;
      if (editorText().trim() === "") return;
      netMarkSent(editorText());
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
    document.addEventListener("click", (e) => {
      if (!getEditor()) return;
      const t = e.target;
      const btn = t.closest && t.closest("button, [role='button']");
      if (!btn) return;
      if (S.stopAria.test(ariaOf(btn)) || (inComposer(btn) && hasStopGlyph(btn) && !hasSendGlyph(btn) && isHardGenerating())) { handlers.onNativeStop(); return; }
      const isSend = hasSendGlyph(btn) || S.sendAria.test(ariaOf(btn)) || (btn.type === "submit" && !!btn.closest("form") && inComposer(btn));
      if (!isSend) return;
      if (btn.disabled) return;
      netMarkSent(editorText());
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item) {
    if (!item) return null;
    let parent = null, ref = null;
    for (const pre of item.querySelectorAll("pre")) {
      if (pre.closest && pre.closest(".rs-chip")) continue;
      if (!CMD_SHAPE.test(pre.textContent || "")) continue;
      pre.classList.add("rs-tool-hide");
      item.classList.add("rs-cmd-mask");
      if (!ref && pre.parentElement) { parent = pre.parentElement; ref = pre; }
    }
    return ref ? { parent, ref } : null;
  }

  return {
    id: SITE.id,
    displayName: SITE.name,
    supportsVision: true,
    timings,
    thinkingSel: THINK_DOM,
    // The model reasons inline; keep the core from acting on anything that
    // only ever appeared inside <think> (splitThink already removes it).
    commandsMayAppearInThinking: false,
    init({ diag: d } = {}) {
      if (d) diag = d;
      try { document.documentElement.setAttribute("data-rs-mimo-ver", "2026-10"); } catch {}
      diag("mimo.init", { hasEditor: !!getEditor(), hasContainer: !!container(), login: loginGatePresent(), hash: location.hash, tap: !!(NET() && NET().enabled && NET().enabled()) });
    },
    allItems, invalidateItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer() { return { ready: true }; },
    async ensureComposerReady(reason) {
      diag("mimo.mode_ready", { reason, hasEditor: !!getEditor(), login: loginGatePresent() });
      return { ready: !!getEditor() && !loginGatePresent() };
    },
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    modeWarning, loginGatePresent,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
    // exposed for tests
    _splitThink: splitThink,
    _sendPathPrefix: SEND_PATH_PREFIX,
  };
})();

if (typeof window !== "undefined") window.RSProvider = RSProvider;
