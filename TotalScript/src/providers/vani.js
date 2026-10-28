// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/vani.js — Vani Chat (c.vani.ai) provider.
//
// Vani Chat is a Next.js app that fronts many frontier models behind one
// conversation. Guest chat (no account) lives at /c and /chat (the latter
// redirects to /c for guests); logged-in threads live at /chat and /c/<id>.
// The composer is a single "Message" box with a model picker ("OpenAI
// GPT-6.1 Sol"…) and suggestion chips on an empty thread. A sidebar panel
// invites you to sign up / log in — that is NOT a login gate: guest chat works
// with a shared free allowance. Only /login itself is a gate.
//
// The DOM has no stable role attributes for us to rely on, so this adapter is
// deliberately adaptive (like the Ox Alpha one): it discovers the editor,
// send/stop controls and transcript rows by shape and text, prefers explicit
// data-role / data-message-role markers when the bundle ships them, and
// otherwise splits user vs assistant rows by alignment and markdown shape.
// eslint-disable-next-line no-unused-vars
const RSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    editor:
      'textarea[placeholder*="Message" i], textarea[name="message"], textarea[aria-label*="message" i], ' +
      '[contenteditable="true"][role="textbox"], .ProseMirror, .tiptap, textarea, [contenteditable="true"], [role="textbox"]',
    sendAria: /^(send|submit|send message|submit message|ask)$|send message|submit prompt/i,
    stopAria: /^stop$|stop (generating|generation|response)|cancel generation|abort/i,
    errorSurfaces: '[role="alert"],[role="status"],[class*="toast"],[class*="error"],[data-sonner-toast],[data-sonner-toaster] li',
  };

  const RE = {
    contextLimit: /context.{0,20}(limit|exceeded|window)|conversation.{0,20}too long|(token|context|input).{0,12}(limit|too long)|message is too long/i,
    tooLong: /conversation .{0,20}(too long|getting too long)|message is too long|too many tokens/i,
    busy: /rate limit|too many requests|try again (later|in)|temporarily unavailable|server is busy|high demand|overloaded|concurrency_limit|one (active )?(reply|conversation|request) at a time|one reply at a time/i,
    allowance: /allowance (used up|is used up|exhausted|exceeded)|(used up|exhausted) (your|the) (free |shared |guest )?allowance|out of (free )?(messages|allowance)|(^|[^0-9.])0% of your free allowance|no (free )?allowance left|free allowance is used up|weekly_limit/i,
    continueBtn: /^(continue|continue generating|keep going)$/i,
    // Composer chrome we must never treat as a transcript row.
    chrome: /^(new chat|see plans and pricing|sign up for free|log in|back to vani\.ai|decline|accept|try vani)$/i,
  };

  const timings = {
    GEN_IDLE_MS: 600,
    REASON_IDLE_MS: 4000,
    // 1.66: Vani's guest models (GPT-6.1 Sol / GPT-6 Luna) reason for a long
    // time before the first token; the network tap reports the open stream as
    // "generating", these only govern the DOM fallback.
    WARMUP_MS: 40000,
    REASON_NOREPLY_MS: 60000,
    STABLE_MS: 2500,
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

  const CODE_CHROME_SEL = "[class*='line-number' i], [class*='linenumber' i], [class*='lineno' i], [class*='gutter' i], [data-line-number], .react-syntax-highlighter-line-number, [class*='code-header' i], [class*='codeHeader'], [class*='code-toolbar' i], [class*='CodeToolbar'], [class*='code-lang' i], [class*='language-label' i], [aria-hidden='true'][class*='line']";
  // Plain text of a <pre>/<code>: token spans concatenated, gutters skipped,
  // one newline per rendered line (highlighters that wrap each line in a span
  // or div without a text newline).
  function codeText(node) {
    let out = "";
    const lineish = (el) => el.nodeType === 1 && (el.tagName === "DIV" || (el.tagName === "SPAN" && /\bline\b|^line|code-line|cm-line|token-line/i.test(String(el.className || "")) && !/number|gutter/i.test(String(el.className || ""))));
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && (n.matches(CODE_CHROME_SEL) || n.tagName === "BUTTON")) return;
      if (n.tagName === "BR") { out += "\n"; return; }
      const isLine = lineish(n);
      for (const c of n.childNodes) walk(c);
      if (isLine && !out.endsWith("\n")) out += "\n";
    };
    walk(node);
    return out.replace(/\u00a0/g, " ");
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
      // Copy / regenerate / model-name toolbars under a reply are not reply text.
      if (n.tagName === "BUTTON" || (n.getAttribute && n.getAttribute("role") === "toolbar")) return;
      // Syntax-highlighter chrome inside code blocks: line-number gutters and
      // the "json / Copy" header would be interleaved with the JSON command and
      // break the parser ("1 { 2 \"command\": …").
      if (n.matches && n.matches(CODE_CHROME_SEL)) return;
      if (n.tagName === "PRE" || n.tagName === "CODE") {
        // Code is read verbatim (no block-break insertion between token spans).
        const code = codeText(n);
        if (t && !t.endsWith("\n")) t += "\n";
        t += code;
        if (!t.endsWith("\n")) t += "\n";
        return;
      }
      const isBlock = /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|ARTICLE|SECTION|TABLE|TR)$/.test(n.tagName);
      if (isBlock && t && !t.endsWith("\n")) t += "\n";
      for (const c of n.childNodes) walk(c);
      if (isBlock && !t.endsWith("\n")) t += "\n";
    };
    walk(root);
    return t;
  }

  const getEditor = () => {
    const sels = S.editor.split(",").map((s) => s.trim());
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        if (el.closest("nav, header, aside, [role='navigation'], [role='dialog'], [role='search']")) continue;
        // Search boxes / API-key fields in settings panels are never the composer.
        const ph = (el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").toLowerCase();
        if (/search|api key|email|password|name your/.test(ph)) continue;
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

  // Texts this extension (or the user) sent, by their first 160 characters.
  // The most reliable user-row signal on a layout we cannot see: a transcript
  // row whose text starts like something we typed is the user's, whatever its
  // CSS says. Keeps the last 40.
  const _sentKeys = [];
  const sentKey = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 160);
  function rememberSent(text) {
    const k = sentKey(text);
    if (k.length < 8) return;
    if (!_sentKeys.includes(k)) { _sentKeys.push(k); if (_sentKeys.length > 40) _sentKeys.shift(); }
  }
  function looksSent(item) {
    if (!_sentKeys.length) return false;
    const k = sentKey(item && (item.innerText || item.textContent));
    if (k.length < 8) return false;
    const head = k.slice(0, 60);
    return _sentKeys.some((sk) => sk.startsWith(head) || k.startsWith(sk.slice(0, 60)));
  }
  function roleOf(item) {
    if (!item) return "";
    const a = (item.getAttribute("data-message-role") || item.getAttribute("data-role") || item.getAttribute("data-author") || item.getAttribute("data-author-role") || "").toLowerCase();
    if (a) return a;
    const cls = String(item.className || "").toLowerCase();
    if (/\buser\b|human|from-user|msg-user|message-user/.test(cls)) return "user";
    if (/\bassistant\b|\bagent\b|\bai\b|from-assistant|msg-assistant|message-assistant|\bmodel\b/.test(cls)) return "assistant";
    const inner = item.querySelector("[data-message-role],[data-role],[data-author-role]");
    if (inner) return (inner.getAttribute("data-message-role") || inner.getAttribute("data-role") || inner.getAttribute("data-author-role") || "").toLowerCase();
    return "";
  }

  function transcriptRoot() {
    const ed = getEditor();
    const cands = [
      "[role='log']", "[role='feed']", "main [class*='messages' i]", "main [class*='thread' i]",
      "main [class*='conversation' i]", "main [class*='transcript' i]", "main [class*='chat' i] ol", "main ol", "main",
    ];
    for (const sel of cands) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        if (ed && el.contains(ed) && sel !== "main") continue;
        return el;
      }
    }
    return document.querySelector("main") || document.body;
  }

  function looksLikeChrome(el) {
    const t = (el.innerText || "").trim();
    if (!t) return true;
    if (RE.chrome.test(t)) return true;
    if (el.closest("nav, header, aside, footer, form, [role='navigation'], [role='dialog'], #rs-root")) return true;
    const ed = getEditor();
    if (ed && (el.contains(ed) || ed.contains(el))) return true;
    return false;
  }

  // 1.65: the watcher asks for the transcript several times per tick
  // (readAssistant, assistantCount, lastAssistantId, isGenerating); on a heavy
  // workspace page every scan is a few full-document queries. Memoise for one
  // beat; the core's mutation observer calls invalidateItems() on DOM changes.
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
    const sels = [
      "[data-message-role]",
      "[data-message-id]",
      "[data-role='user'], [data-role='assistant']",
      "[data-author-role]",
      "article[data-testid*='message' i], [data-testid*='message' i]",
      ".message, [class*='ChatMessage'], [class*='chat-message'], [class*='message-row'], [class*='MessageRow']",
      "article",
    ];
    const seen = new Set();
    const out = [];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (seen.has(el) || !visible(el) || looksLikeChrome(el)) continue;
        // Keep outermost rows only (a row that contains an already-collected
        // row would double-count).
        if (out.some((o) => o.contains(el) || el.contains(o))) continue;
        seen.add(el);
        out.push(el);
      }
      if (out.length) break;
    }
    if (!out.length) {
      // Shape fallback: walk down from the transcript container through
      // single-child wrappers until a level with several text-bearing rows
      // (user bubbles / markdown bodies) appears.
      const log = transcriptRoot();
      if (log) out.push(...shapeRows(log));
    }
    return out;
  }

  function rowCandidates(parent) {
    const rows = [];
    for (const el of parent.children) {
      if (el.nodeType !== 1 || !visible(el) || looksLikeChrome(el)) continue;
      if (!textWithout(el).trim()) continue;
      rows.push(el);
    }
    return rows;
  }
  function shapeRows(root) {
    let node = root;
    for (let depth = 0; depth < 12 && node; depth++) {
      const rows = rowCandidates(node);
      if (rows.length >= 2) return rows;
      if (rows.length === 0) return node === root ? [] : [node];
      node = rows[0];
    }
    return node && node !== root ? [node] : [];
  }

  function isUserItem(item) {
    const r = roleOf(item);
    if (/user|human/.test(r)) return true;
    if (/assistant|agent|ai|model|system/.test(r)) return false;
    if (looksSent(item)) return true;
    const cls = String(item && item.className || "");
    if (/\bml-auto\b|justify-end|items-end|self-end|flex-row-reverse/.test(cls)) return true;
    // A user bubble is usually a right-aligned box without markdown chrome.
    try {
      const r2 = item.getBoundingClientRect();
      const parentW = (item.parentElement && item.parentElement.getBoundingClientRect().width) || innerWidth;
      const rightGap = parentW - (r2.left + r2.width - (item.parentElement ? item.parentElement.getBoundingClientRect().left : 0));
      const leftGap = r2.left - (item.parentElement ? item.parentElement.getBoundingClientRect().left : 0);
      if (leftGap > rightGap + 60 && !item.querySelector("pre, table, h1, h2, h3")) return true;
    } catch {}
    return false;
  }
  function isAssistantItem(item) {
    const r = roleOf(item);
    if (/assistant|agent|ai|model/.test(r)) return true;
    if (/user|human|system/.test(r)) return false;
    return !isUserItem(item) && !!(item && (item.innerText || "").trim());
  }

  const BODY_SEL = ".prose, .markdown, .markdown-body, [class*='prose'], [class*='markdown' i], [class*='message-content' i], [class*='MessageContent'], [data-testid*='content' i]";
  function itemText(item) {
    if (!item) return "";
    const body = item.querySelector(BODY_SEL) || item;
    return textWithout(body);
  }
  function classifyText(item, excludeSel) {
    if (!item) return "";
    const body = item.querySelector(BODY_SEL) || item;
    if (excludeSel && body.closest && body.closest(excludeSel)) return "";
    return textWithout(body, excludeSel);
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
      || ed.closest("[class*='composer' i]")
      || ed.closest("[class*='chat-input' i], [class*='ChatInput'], [class*='prompt' i]")
      || ed.closest("footer")
      || ed.parentElement;
  }
  function barAnchor() {
    const ed = getEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 10 && n; i++) {
      const cls = String(n.className || "");
      if (/rounded|composer|input-bar|chat-input|prompt/i.test(cls) && n.getBoundingClientRect().width >= ed.getBoundingClientRect().width) return n;
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

  // Only the dedicated /login route is a gate. The "Sign up for free / Log in"
  // panel next to guest chat is marketing — the composer still works.
  function loginGatePresent() {
    const p = (location.pathname || "").toLowerCase();
    if (/^\/(login|signin|signup|register|auth)(\/|$)/.test(p)) return true;
    return false;
  }

  function allowanceExhausted() {
    try {
      for (const el of document.querySelectorAll("p, div, span, [role='alert']")) {
        if (!visible(el) || el.closest("#rs-root")) continue;
        const t = (el.textContent || "").trim();
        if (t.length > 400 || t.length < 12) continue;
        if (/(^|[^0-9.])0% of your free allowance left|used up (your|the) (free|shared) allowance|allowance (is )?(used up|exhausted)|no (free )?allowance left/i.test(t)) return true;
      }
    } catch {}
    return false;
  }

  function modeWarning() {
    if (loginGatePresent()) return "";
    if (allowanceExhausted()) {
      return "<b>Vani Chat</b> — the free guest allowance is used up. <b>Log in</b> (own allowance) or wait, then reload.";
    }
    if (!getEditor()) {
      return "<b>Vani Chat</b> — open the chat at <b>c.vani.ai/chat</b>, then reload.";
    }
    return "";
  }

  const ariaOf = (b) => (b.getAttribute("aria-label") || b.title || b.getAttribute("data-tooltip") || (b.textContent || "").trim()).trim();
  const allButtons = () => [...document.querySelectorAll("button, [role='button']")].filter((b) => !b.closest("#rs-root"));
  function nearComposer(b) {
    const frame = composerFrame();
    return !frame || frame.contains(b) || (frame.parentElement && frame.parentElement.contains(b));
  }
  const sendButton = () =>
    allButtons().find((b) => S.sendAria.test(ariaOf(b)) && visible(b) && b.type !== "reset" && nearComposer(b)) ||
    allButtons().find((b) => b.type === "submit" && visible(b) && nearComposer(b)) ||
    allButtons().find((b) => S.sendAria.test(ariaOf(b)) && visible(b) && b.type !== "reset") ||
    null;
  const stopButton = () =>
    allButtons().find((b) => S.stopAria.test(ariaOf(b)) && visible(b)) || null;

  function streamText(item) {
    if (!item) return "";
    return classifyText(item, ".rs-chip").trim();
  }
  const streamLen = (item) => { const nt = netText(); if (nt) return nt.length; return streamText(item === undefined ? lastAssistant() : item).length; };

  // ── 1.65 universal stream tap (src/providers/stream-net.js + stream-reader.js) ──
  // The model's reply as it crossed the network: verbatim markdown, with the
  // stream's close as the exact end of the turn. Preferred over the shape-based
  // DOM read whenever the tap has text for THIS turn; the DOM remains the
  // fallback and still anchors chips / counts turns.
  const NET = () => (typeof RSStreamNet !== "undefined" ? RSStreamNet : (window.RSStreamNet || null));
  const netText = () => { try { const n = NET(); return n ? n.replyText() : ""; } catch { return ""; } };
  const netGen = (stopVisible) => { try { const n = NET(); return n ? n.genState({ stopVisible }) : null; } catch { return null; } };
  const netMarkSent = (text) => { try { const n = NET(); if (n) n.markSent(text); } catch {} };
  // 1.76.0 — what the MAIN-world request shaper (vani-net.js) last did. Read
  // from the <html> attributes it writes; surfaced by the core in its toasts so
  // the user can see whether the protocol pin reached Vani without a console.
  function bridgeStatus() {
    const readAttr = (name) => { try { const raw = document.documentElement.getAttribute(name); return raw ? JSON.parse(raw) : null; } catch { return null; } };
    const shaped = readAttr("data-rs-vani-shaped"), unshaped = readAttr("data-rs-vani-unshaped");
    const tapLoaded = !!document.documentElement.getAttribute("data-rs-vani-net");
    let label;
    if (!tapLoaded) label = "Vani bridge: request shaper not loaded \u2717 (reload the page)";
    else if (shaped && (!unshaped || shaped.at >= unshaped.at)) label = `Vani bridge: protocol pinned \u2713 (${shaped.messages || "?"} msgs${shaped.trimmed ? ", " + shaped.trimmed + " trimmed" : ""})`;
    else if (unshaped) label = `Vani bridge: request NOT shaped \u2717 (${unshaped.why || "unknown"} \u00b7 ${unshaped.url || "?"})`;
    else label = "Vani bridge: no chat request seen yet \u2717";
    return { shaped: !!shaped && (!unshaped || shaped.at >= unshaped.at), pinned: !!(shaped && shaped.pinned), lastShaped: shaped, lastUnshaped: unshaped, tapLoaded, label };
  }
  const netError = () => { try { const n = NET(); const e = n && n.error(); return e ? n.describe(e, "Vani Chat") : null; } catch { return null; } };

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  const WEDGE_MS = 12000;
  let _stopSince = 0;
  function genActive() {
    sampleStream();
    const stop = !!stopButton();
    const now = Date.now();
    // Tap first: streaming per the network = generating; stream closed = done
    // (unless a stop button is still up - then the DOM wedge rules below apply).
    const g = netGen(stop);
    if (g === "streaming") return true;
    if (g === "done" && !stop) return false;
    if (stop) {
      if (!_stopSince) _stopSince = now;
      return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2500);
    }
    _stopSince = 0;
    // Vani shows a typing/thinking indicator before the first token.
    try {
      const last = lastAssistant();
      if (last && last.querySelector("[class*='typing' i], [class*='thinking' i], [class*='loading' i], [aria-busy='true'], .animate-pulse, .animate-bounce") && now - _streamAt < WEDGE_MS) return true;
    } catch {}
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton() || netGen(false) === "streaming";

  const turnHalted = () => false;
  const findContinueBtn = () => {
    try {
      return allButtons().find((b) => visible(b) && RE.continueBtn.test((b.textContent || "").trim())) || null;
    } catch { return null; }
  };
  const clickContinueBtn = () => { const b = findContinueBtn(); if (!b) return false; try { b.click(); return true; } catch { return false; } };

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      return { th: 0, rp: streamLen(it) };
    } catch { return {}; }
  }
  function readAssistant() {
    const item = lastAssistant();
    const nt = netText().trim();
    if (nt) return { present: true, reply: nt, thinking: "", item, net: true };
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

  // Guest chat runs on a shared allowance; keep single messages well under
  // any server-side cap while still fitting the compact command index.
  const SEND_MAX = 60000;
  function truncateForSend(text) {
    if (!text || text.length <= SEND_MAX) return text;
    const omitted = text.length - SEND_MAX;
    const marker = `\n\n[…TotalScript: result truncated to fit Vani's input limit - ${omitted} of ${text.length} characters omitted…]\n\n`;
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
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("Vani chat box not found — open c.vani.ai/chat");
    editor.focus();
    await sleep(40);
    text = truncateForSend(text);
    netMarkSent(text);
    rememberSent(text);
    setRichText(editor, text);
    await sleep(80);
    if (images && images.length) {
      try { await attachImages(images); } catch {}
    }
    const sendReady = () => {
      const b = sendButton();
      return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
    };
    await waitFor(sendReady, 2500);
    diag("vani.send", { editorLen: editorText().length, textLen: text.length });
    let sent = false;
    for (let i = 0; i < 5 && !sent; i++) {
      const b = sendButton();
      if (b && !b.disabled && b.getAttribute("aria-disabled") !== "true") { try { b.click(); } catch {} }
      else {
        try {
          const form = editor.closest("form");
          if (form && typeof form.requestSubmit === "function") form.requestSubmit();
          else pressEnter(editor);
        } catch { pressEnter(editor); }
      }
      sent = await waitFor(() => editorText().trim() === "" || isHardGenerating(), 900);
    }
    if (!sent) diag("vani.send.unconfirmed", { editorLen: editorText().length });
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
        if (t.length > 8 && t.length < 600 && (RE.contextLimit.test(t) || RE.allowance.test(t) || RE.busy.test(t))) return t.slice(0, 240);
      }
    } catch {}
    if (allowanceExhausted()) return "Vani's free guest allowance is used up — log in for your own allowance, then retry.";
    if (!getEditor() && !loginGatePresent()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text) || RE.allowance.test(text);

  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `or_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  function clearAttachments() {}
  // Image upload is a logged-in feature on Vani ("Attach images, PDFs and
  // text files" needs an account). For guests the file input does not exist
  // and the paste path is ignored, so attachImages reports false and the core
  // sends the text alone.
  async function attachImages(images) {
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    const frame = composerFrame();
    const fileInput = (frame && frame.querySelector('input[type="file"]')) || document.querySelector('input[type="file"]');
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

  const conversationKey = () => {
    const m = (location.pathname || "").match(/\/(?:c|chat|conversation|thread)\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    const q = new URLSearchParams(location.search || "");
    return q.get("c") || q.get("id") || q.get("thread") || location.pathname;
  };

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const ed = getEditor();
      if (!ed || !ed.contains(e.target)) return;
      if (editorText().trim() === "") return;
      rememberSent(editorText());
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
      if (!btn || btn.closest("#rs-root")) return;
      if (S.stopAria.test(ariaOf(btn))) { handlers.onNativeStop(); return; }
      const isSend = (S.sendAria.test(ariaOf(btn)) || btn.type === "submit") && nearComposer(btn);
      if (!isSend) return;
      if (btn.disabled) return;
      rememberSent(editorText());
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

  // 1.78.1: also the "shown, not fenced" spellings (escaped / single-quoted /
  // bare keys) the core's relaxed parser now executes, so their <pre> is masked too.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|\\"(?:command|tool)\\"\s*:|'(?:command|tool)'\s*:|[{,]\s*(?:command|tool)\s*:\s*["']|###\s*lua|###\s*(?:cmd|command|tool)\s*[:\s]|###mcp_tool###/i;
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

  const PLAIN_NOTE = () => { try { return (typeof RSParse !== "undefined" && RSParse && RSParse.PLAIN_FORMAT_NOTE) || ""; } catch { return ""; } };
  const VANI_SITE_RULES = "Vani Chat rules: for Roblox Studio this is a plain markdown chat with NO usable native tools - Vani's own tools (web search, Document, Slides, Design, code execution) cannot reach Studio, so ignore them while this chat is linked; the ONLY way to act is to write the command as text in your reply. No JSON is needed: use a ###LUA### ... ###END_LUA### block for Studio code and a ###CMD name### ... ###END_CMD### block (one \"key: value\" line per parameter) for every other command, each inside its own fenced code block. Write the fence as REAL markdown - a line that is only the three backticks, the block on the next lines, a line that is only three backticks; never escape the backticks, quotes or braces with backslashes, never put the block inside quotes, inline code, a Document or a tool proposal, never only describe it, and never show code in a bare lua fence without the ###LUA### markers (shown code is not executed). Never say you cannot run code or use command blocks - you only have to WRITE the block; the extension on this page executes it and pastes the result back as the next user message. One command per reply unless the steps are independent, then stop and wait for the result. Do NOT search the web, do NOT create a Document / Slides / Design / canvas / artifact and do NOT propose Vani tools - everything goes in the chat reply as text. Keep prose to one short line per reply; the command block is the work. Guest sessions are not saved - never rely on an earlier page load. If Vani reports that the free allowance is used up, stop and tell the user to log in.";
  return {
    id: "vani",
    displayName: "Vani Chat",
    supportsVision: true,
    // Guest chat shares a free allowance and the thread is lost on refresh;
    // keep the bootstrap bounded (name index + per-command schema fetches)
    // instead of the full 180k-character catalogue dump.
    compactCommandList: true,
    commandListMaxChars: 12000,
    // Guest chat has a shared allowance and an unknown per-message cap: use the
    // compact system prompt (same as ChatGPT) so the bootstrap always lands.
    sysMaxChars: 14000,
    // 1.81.0: Luau-first plain-text protocol. The format itself (###LUA### and
    // ###CMD name### blocks, JSON optional) is RSParse.PLAIN_FORMAT_NOTE - one
    // source for prompt and parser; this adds only what is Vani-specific.
    get promptExtra() { return VANI_SITE_RULES + (PLAIN_NOTE() ? "\n" + PLAIN_NOTE() : ""); },
    timings,
    thinkingSel: ".reasoning, [class*='thinking' i], [class*='reason' i], [class*='thought' i], [data-testid*='reasoning' i], details summary",
    // 1.76.0 — commandless first replies get TWO escalating rescues here (one
    // elsewhere). Reported live on a logged-in account with a paid model: the
    // model answers in prose ("I can't run commands / use JSON blocks", a plan,
    // a tool proposal, a Document) because Vani's platform prompt hands it a
    // tool list of its own; one generic nudge was not enough.
    commandlessRetries: 2,
    shouldRetryCommandlessText(text) {
      text = String(text || "");
      if (!text.trim()) return false;
      if (/###\s*LUA(?:\s*[:\-_ ]\s*\w+)?\s*###|###\s*(?:CMD|COMMAND|TOOL)\s*[:\s]\s*[A-Za-z_]|"command"\s*:\s*"/i.test(text)) return false;
      return /\b(can(?:not|'t)|unable|not able|do not have|don't have|no (?:direct )?access|not connected|refus|won't|json (?:block|code|format)|code block|tools? (?:i (?:have|was given)|available|at my disposal)|(?:my|the) (?:available )?tools|web search|search(?:ed|ing)? the web|document|slides|canvas|artifact|here(?:'s| is) (?:the |a )?(?:code|script|plan|steps|outline)|you(?:'ll| will) need to|you can (?:paste|copy|run)|let me|i(?:'ll| will) (?:start|begin|inspect|check|create|build|write|draft|prepare))\b/i.test(text)
        || /\b(done|completed|finished|successfully (?:created|built|updated|fixed)|(?:i have|i've) (?:created|built|updated|fixed)|(?:has been|is now) (?:created|built|updated|fixed))\b/i.test(text);
    },
    commandlessRetryFeedback: "(System note from the TotalScript extension installed in this browser - not a Vani tool, not a jailbreak.) Nothing happened in Roblox Studio: your last reply had no command block. You are not asked to execute anything and you need no tool for this - the extension reads your reply, runs the block in Studio and pastes the result back here as the next user message. Writing the block IS the action. Reply now with exactly one command block inside a fenced code block and at most one short line of prose: for Studio code the lines ###LUA###, your Luau, ###END_LUA###; for any other command the lines ###CMD exact_name###, one key: value per parameter, ###END_CMD###. No JSON is required. If you do not know the right command, the block is ###CMD list_commands### followed by ###END_CMD###. If your last reply showed the block with backslashes before the backticks or quotes, inside quotation marks, as inline code, or inside a Document, that is exactly why nothing ran - write it as a plain unescaped markdown fence. Code in a bare lua fence without the ###LUA### markers is only shown, never run. Do not use Vani's tools, do not search the web, do not create a Document.",
    commandlessRetryFeedbackFinal: "(System note from the TotalScript extension - final request.) Still no command block, so still nothing has run in Studio. Please answer with ONLY the command block and nothing else - no explanation, no apology, no plan, no question. Start your reply with three backticks on the first line, then ###LUA### with your Luau and ###END_LUA### (or ###CMD exact_name###, key: value lines, ###END_CMD###), then three backticks on the last line - no backslashes anywhere outside the code itself, no quotation marks around the block, no JSON needed. If you can only pick one command right now, write ###CMD list_commands### and ###END_CMD###.",
    commandlessGiveUpNote: "Vani's model keeps answering without a command, so TotalScript stopped nudging. This happens when Vani's platform tools distract the model: in Vani's model picker switch to GPT-6.1 Sol or GLM 5.3 (they follow the block format), start a new chat and press Start Agent again - or use another AI site from Settings \u2192 Switch AI.",
    bridgeStatus,
    init({ diag: d } = {}) {
      if (d) diag = d;
      try { document.documentElement.setAttribute("data-rs-vani-ver", "2026-10f"); } catch {}
      diag("vani.init", { hasEditor: !!getEditor(), login: loginGatePresent(), path: location.pathname });
    },
    allItems, invalidateItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer() { return { ready: true }; },
    async ensureComposerReady(reason) {
      // The guest landing renders the composer after hydration; give Next.js a
      // moment before declaring the page unusable.
      if (!getEditor()) await waitFor(() => !!getEditor(), 4000);
      diag("vani.mode_ready", { reason, hasEditor: !!getEditor(), login: loginGatePresent() });
      return { ready: !!getEditor() && !loginGatePresent() };
    },
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    modeWarning, loginGatePresent,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();

if (typeof window !== "undefined") window.RSProvider = RSProvider;
