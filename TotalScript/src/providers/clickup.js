// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/clickup.js — ClickUp Brain (app.clickup.com) provider.
//
// ClickUp is a large Angular workspace app; its AI assistant ("ClickUp
// Brain", earlier "ClickUp AI") lives INSIDE that app rather than on a
// dedicated chat site: a side panel / modal opened from the AI button, the
// "AI" / "Brain" entry in the sidebar, or a full Brain page under
// /<workspaceId>/ai. The same page also hosts task editors, Docs, comment
// boxes and ClickUp Chat channels - every one of them is a rich-text editor
// too, so this adapter's first job is to find the RIGHT composer and to read
// transcript rows ONLY from the Brain surface around it.
//
// ClickUp ships `cu-*` custom elements and `data-test` hooks, but we cannot
// rely on exact names (they change per release and we have no live DOM in
// the test sandbox), so discovery is score-based, like the Vani / Ox Alpha
// adapters: an editor earns points for AI/Brain markers on its ancestors
// ("Ask AI…" placeholder, cu-ai-* tags, ai-chat / brain classes) and loses
// points for task / comment / doc / channel markers. The Brain root is the
// largest AI-marked ancestor of that editor; transcript rows are discovered
// inside it by role markers first, then by shape.
// eslint-disable-next-line no-unused-vars
const RSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    editor:
      'textarea, .ql-editor[contenteditable="true"], .ProseMirror, .tiptap, ' +
      '[contenteditable="true"][role="textbox"], [role="textbox"], [contenteditable="true"]',
    sendAria: /^(send|submit|send message|submit message|ask|ask ai|ask brain|generate)$|send message|submit prompt|send prompt/i,
    stopAria: /^stop$|stop (generating|generation|response|answer)|cancel (generation|response)|abort/i,
    sendTest: /send|submit|ask/i,
    stopTest: /stop|cancel/i,
    errorSurfaces: '[role="alert"],[role="status"],[class*="toast" i],[class*="snackbar" i],[class*="error" i],cu-toast,[data-test*="toast" i]',
  };

  // Markers that say "this is the AI surface" / "this is NOT the AI surface".
  const AI_RE = /(^|[^a-z])(ai|brain|assistant|copilot|gpt)([^a-z]|$)/i;
  const AI_TAG_RE = /^CU-(AI|BRAIN|ASSISTANT)/i;
  const BAD_RE = /comment|task-?view|task_view|task-?description|description-?editor|cu-doc|docs?-page|doc-?editor|channel|cu-chat(?!-ai)|chat-?input(?!.*ai)|reply-?box|notepad|whiteboard|form-?builder|search/i;
  const PLACEHOLDER_AI_RE = /ask (ai|brain|anything|me|a question|clickup|or create|, create)|message (ai|brain)|chat with brain|what (do you want|would you like|can i help)|how can i help|type your (prompt|question|message)|ask or (search|type|create)|write a prompt|@mention|talk to text/i;
  const PLACEHOLDER_BAD_RE = /search|comment|reply|task name|add a task|description|email|password|api key|filter|rename|new doc|subtask/i;

  const RE = {
    contextLimit: /context.{0,20}(limit|exceeded|window)|conversation.{0,20}too long|(token|context|input|prompt).{0,12}(limit|too long)|message is too long|exceeds? the (maximum|character)/i,
    tooLong: /conversation .{0,20}(too long|getting too long)|message is too long|too many tokens|(prompt|input|message).{0,12}(too long|exceeds)/i,
    busy: /rate limit|too many requests|try again (later|in)|temporarily unavailable|server is busy|high demand|overloaded|something went wrong|unable to (generate|process)|please retry/i,
    allowance: /upgrade (to|your plan)|(used|reached) (all|the limit|your limit|your free).{0,40}(ai|brain|uses|credits|requests)|(no|out of) (ai|brain) (credits|uses|requests)|free (trial|uses?) (of|for) (ai|brain).{0,20}(over|ended|used)|brain (add-?on|is) (required|not (enabled|available|included))|unlock (unlimited )?(ai|brain)/i,
    continueBtn: /^(continue|continue generating|keep going|keep writing)$/i,
    // Panel chrome we must never treat as a transcript row.
    chrome: /^(new chat|new conversation|history|clear chat|upgrade|learn more|got it|suggested|try asking|ask ai|ask brain|brain|ai|close|settings|feedback)$/i,
  };

  const timings = {
    GEN_IDLE_MS: 700,
    REASON_IDLE_MS: 4000,
    WARMUP_MS: 14000,
    REASON_NOREPLY_MS: 30000,
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
  const descOf = (el) => {
    try {
      return `${el.tagName || ""} ${el.className && typeof el.className === "string" ? el.className : (el.getAttribute && el.getAttribute("class")) || ""} ${(el.getAttribute && (el.getAttribute("data-test") || el.getAttribute("data-testid") || el.getAttribute("data-cy") || el.id)) || ""}`;
    } catch { return ""; }
  };
  const isAiMarked = (el) => { if (!el || el.nodeType !== 1) return false; if (AI_TAG_RE.test(el.tagName || "")) return true; return AI_RE.test(descOf(el).replace(/^[A-Z-]+\s/, "")); };
  const isBadMarked = (el) => el && el.nodeType === 1 && BAD_RE.test(descOf(el));

  const CODE_CHROME_SEL = "[class*='line-number' i], [class*='linenumber' i], [class*='lineno' i], [class*='gutter' i], [data-line-number], [class*='code-header' i], [class*='codeHeader'], [class*='code-toolbar' i], [class*='code-block-header' i], [class*='copy' i]";
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
      if (n.tagName === "BUTTON" || (n.getAttribute && n.getAttribute("role") === "toolbar")) return;
      if (n.tagName === "TEXTAREA" || n.tagName === "INPUT" || n.tagName === "SELECT") return;
      if (n.matches && n.matches(CODE_CHROME_SEL)) return;
      if (n.tagName === "PRE" || n.tagName === "CODE") {
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

  // ── composer discovery ───────────────────────────────────────────────────
  const placeholderOf = (el) => {
    try {
      const own = el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.getAttribute("data-placeholder") || el.getAttribute("aria-placeholder") || "";
      if (own) return own;
      // Quill keeps the placeholder on .ql-editor; ProseMirror on a child <p data-placeholder>.
      const inner = el.querySelector && el.querySelector("[data-placeholder], [placeholder]");
      if (inner) return inner.getAttribute("data-placeholder") || inner.getAttribute("placeholder") || "";
      const labelled = el.getAttribute("aria-labelledby");
      if (labelled) { const l = document.getElementById(labelled); if (l) return l.textContent || ""; }
    } catch {}
    return "";
  };
  function scoreEditor(el) {
    let score = 0;
    const ph = placeholderOf(el);
    if (PLACEHOLDER_AI_RE.test(ph)) score += 6;
    if (PLACEHOLDER_BAD_RE.test(ph)) score -= 8;
    let n = el, depth = 0, aiSeen = false, badSeen = false;
    while (n && n !== document.body && depth < 16) {
      if (!aiSeen && isAiMarked(n)) { aiSeen = true; score += Math.max(1, 5 - Math.floor(depth / 4)); }
      if (!badSeen && !aiSeen && isBadMarked(n)) { badSeen = true; score -= 5; }
      n = n.parentElement; depth++;
    }
    if (el.closest("nav, header, [role='navigation'], [role='search'], [role='menu'], [role='listbox']")) score -= 6;
    try { const r = el.getBoundingClientRect(); if (r.bottom > innerHeight * 0.45) score += 1; if (r.width >= 240) score += 1; } catch {}
    return score;
  }
  let _edCache = { el: null, at: 0 };
  const getEditor = () => {
    const now = Date.now();
    if (_edCache.el && now - _edCache.at < 400 && _edCache.el.isConnected && visible(_edCache.el)) return _edCache.el;
    let best = null, bestScore = -Infinity;
    for (const el of document.querySelectorAll(S.editor)) {
      if (!visible(el)) continue;
      if (el.closest("#rs-root")) continue;
      if (el.tagName === "TEXTAREA" && el.rows === 1 && (el.getAttribute("type") || "") === "search") continue;
      let sc = scoreEditor(el);
      // Prefer the element that really takes keystrokes over a role=textbox wrapper.
      if (el.isContentEditable || el.tagName === "TEXTAREA") sc += 1;
      if (sc > bestScore || (sc === bestScore && best && best.contains(el))) { bestScore = sc; best = el; }
    }
    // Below zero means every candidate looked like a task / comment / channel
    // box - do not hijack those. The Brain composer must be open to proceed.
    const el = bestScore >= 1 ? best : null;
    _edCache = { el, at: now };
    return el;
  };

  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    if (e.tagName === "TEXTAREA" || e.tagName === "INPUT") return e.value || "";
    return (e.innerText || e.textContent || "").replace(/\u00a0/g, " ");
  };

  // The Brain surface: the largest AI-marked ancestor of the composer (side
  // panel, modal or full page). Falls back to the dialog / main region.
  function aiRoot() {
    const ed = getEditor();
    if (!ed) return null;
    let n = ed.parentElement, depth = 0, best = null, shell = null;
    while (n && n !== document.body && depth < 18) {
      if (isAiMarked(n)) {
        try {
          const r = n.getBoundingClientRect();
          if (r.height >= 200 && r.width >= 240) {
            // An "ai"-flagged app shell covering the whole window would drag
            // the entire workspace into the transcript - only use it when no
            // smaller Brain container exists.
            if (r.width * r.height >= innerWidth * innerHeight * 0.92) { if (!shell) shell = n; }
            else best = n;
          }
        } catch {}
      }
      n = n.parentElement; depth++;
    }
    if (best) return best;
    if (shell) return shell;
    const dlg = ed.closest("[role='dialog'], [aria-modal='true'], cu-modal, [class*='modal' i], [class*='drawer' i], [class*='side-panel' i], [class*='sidepanel' i], aside");
    if (dlg && visible(dlg)) return dlg;
    // Full-page Brain: the tallest ancestor that is still narrower than the
    // whole window (keeps the sidebar out) or main.
    n = ed.parentElement; depth = 0;
    while (n && n !== document.body && depth < 18) {
      try { const r = n.getBoundingClientRect(); if (r.height >= innerHeight * 0.55) return n; } catch {}
      n = n.parentElement; depth++;
    }
    return document.querySelector("main") || document.body;
  }

  // Texts this extension (or the user) sent, by their first 160 characters.
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
    const attrs = ["data-message-role", "data-role", "data-author", "data-author-role", "data-sender", "data-type"];
    for (const a of attrs) { const v = (item.getAttribute(a) || "").toLowerCase(); if (v) return v; }
    // Class tokens: "ai"/"brain" alone say nothing (every node of a cu-ai-*
    // tree carries them) - only explicit author words count.
    const d = descOf(item).toLowerCase().replace(/^[a-z-]+\s/, "");
    if (/(^|[^a-z])(user|human|own|outgoing|question|prompt|sent)([^a-z]|$)/.test(d)) return "user";
    if (/(^|[^a-z])(assistant|bot|model|response|answer|incoming|reply|received)([^a-z]|$)/.test(d)) return "assistant";
    const inner = item.querySelector("[data-message-role],[data-role],[data-author-role]");
    if (inner) return (inner.getAttribute("data-message-role") || inner.getAttribute("data-role") || inner.getAttribute("data-author-role") || "").toLowerCase();
    // Avatar / icon hints: ClickUp shows the member's avatar on their turns and
    // the Brain logo on the AI's.
    try {
      if (item.querySelector("cu-ai-icon, cu-brain-icon, [class*='ai-icon' i], [class*='brain-icon' i], [class*='ai-avatar' i], [class*='brain-avatar' i], [class*='ai-logo' i]")) return "assistant";
      if (item.querySelector("cu-user-avatar, cu-avatar, cu-user-badge, [class*='user-avatar' i], [class*='member-avatar' i], img[class*='avatar' i]")) return "user";
    } catch {}
    return "";
  }

  function composerFrame() {
    const ed = getEditor();
    if (!ed) return null;
    return ed.closest("form")
      || ed.closest("[class*='composer' i], [class*='prompt-input' i], [class*='input-container' i], [class*='chat-input' i], [class*='ChatInput'], [class*='editor-wrapper' i], [class*='footer' i], footer")
      || ed.parentElement;
  }
  function barAnchor() {
    const ed = getEditor();
    if (!ed) return null;
    let n = ed;
    for (let i = 0; i < 10 && n; i++) {
      const cls = String(n.className || "");
      if (/rounded|composer|input-bar|input-container|prompt|chat-input|editor-wrapper/i.test(cls) && n.getBoundingClientRect().width >= ed.getBoundingClientRect().width) return n;
      n = n.parentElement;
    }
    return composerFrame();
  }

  function looksLikeChrome(el) {
    const t = (el.innerText || "").trim();
    if (!t) return true;
    if (RE.chrome.test(t)) return true;
    if (el.closest("nav, header, footer, [role='navigation'], [role='menu'], #rs-root")) return true;
    const ed = getEditor();
    if (ed && (el.contains(ed) || ed.contains(el))) return true;
    const frame = composerFrame();
    if (frame && (frame.contains(el) || el.contains(frame))) return true;
    return false;
  }

  function scrollRegion(root) {
    let best = null, bestArea = 0;
    try {
      for (const el of root.querySelectorAll("*")) {
        if (!visible(el)) continue;
        const s = getComputedStyle(el);
        if (!/(auto|scroll)/.test(s.overflowY)) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = el; }
      }
    } catch {}
    return best;
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
    const root = aiRoot();
    if (!root) return [];
    const sels = [
      "[data-message-role], [data-author-role], [data-role='user'], [data-role='assistant']",
      "[data-test*='message' i], [data-testid*='message' i], [data-test*='chat-item' i]",
      "__tags__",
      "cu-ai-chat-message, cu-ai-message, cu-brain-chat-message, cu-brain-message, cu-ai-chat-item, [class*='ai-chat' i][class*='message' i], [class*='brain' i][class*='message' i], [class*='ai-message' i]",
      "[class*='chat-message' i], [class*='ChatMessage'], [class*='message-item' i], [class*='message-row' i], [class*='message__' i], [class*='message_' i]",
      "[class*='message' i]",
      "article",
    ];
    const seen = new Set();
    let out = [];
    const TAG_ROW_RE = /^CU-(AI|BRAIN)[A-Z-]*(MESSAGE|ITEM|TURN|ENTRY|BUBBLE|RESPONSE|ANSWER|QUESTION)$/;
    const tagRows = () => { try { return [...root.querySelectorAll("*")].filter((e) => TAG_ROW_RE.test(e.tagName)); } catch { return []; } };
    for (const s of sels) {
      let nodes = [];
      try { nodes = s === "__tags__" ? tagRows() : [...root.querySelectorAll(s)]; } catch { continue; }
      for (const el of nodes) {
        if (seen.has(el) || !visible(el) || looksLikeChrome(el)) continue;
        if (isContainer(el)) continue;
        // A wrapper holding several other matches of the same tier is the
        // list, not a row (".ai-chat__messages" vs ".ai-chat-message").
        if (nodes.filter((m) => m !== el && el.contains(m) && roleOf(m)).length >= 2) continue;
        if (!textWithout(el).trim()) continue;
        if (out.some((o) => o.contains(el) || el.contains(o))) continue;
        seen.add(el);
        out.push(el);
      }
      if (out.length) break;
    }
    if (out.length === 1) {
      // One match that itself holds several text rows is still a container.
      const inner = shapeRows(out[0]);
      if (inner.length >= 2) out = inner;
    }
    if (!out.length) {
      const log = scrollRegion(root) || root;
      out.push(...shapeRows(log));
    }
    return out;
  }

  const CONTAINER_RE = /(^|[^a-z])(messages|message-list|message-container|messages-container|thread|history|conversation|transcript|chat-body|chat-list|scroll)([^a-z]|$)/i;
  const isContainer = (el) => CONTAINER_RE.test(descOf(el).replace(/^[A-Z-]+\s/, ""));
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
    if (/user|human|you|own|outgoing|question|prompt/.test(r)) return true;
    if (/assistant|agent|ai|brain|bot|model|system|response|answer|incoming/.test(r)) return false;
    if (looksSent(item)) return true;
    const cls = String(item && item.className || "");
    if (/\bml-auto\b|justify-end|items-end|self-end|flex-row-reverse|align-right|right/.test(cls)) return true;
    // Alignment: a user bubble sits to the right of its row / column. Check the
    // row itself, then the first narrower descendant (full-width rows that
    // merely hold a right-aligned bubble).
    try {
      if (!item.querySelector("pre, table, h1, h2, h3")) {
        const gaps = (el, parent) => {
          const r = el.getBoundingClientRect(); const pr = parent.getBoundingClientRect();
          return { left: r.left - pr.left, right: pr.left + pr.width - (r.left + r.width), narrower: r.width < pr.width * 0.9 };
        };
        let el = item, parent = item.parentElement;
        for (let i = 0; i < 4 && el && parent; i++) {
          const g = gaps(el, parent);
          if (g.narrower) { if (g.left > g.right + 40) return true; break; }
          const kids = [...el.children].filter((k) => k.nodeType === 1 && (k.textContent || "").trim());
          if (kids.length !== 1) break;
          parent = el; el = kids[0];
        }
        const tokens = [...item.querySelectorAll("*")].slice(0, 8).flatMap((k) => String(typeof k.className === "string" ? k.className : "").split(/\s+/));
        if (tokens.some((t) => /^(right|ml-auto|justify-end|items-end|self-end|flex-row-reverse|align-right|outgoing|sent)$/.test(t) || /(--|__|-)(right|user|me|own|outgoing)$/.test(t))) return true;
      }
    } catch {}
    return false;
  }
  function isAssistantItem(item) {
    const r = roleOf(item);
    if (/assistant|agent|ai|brain|bot|model|response|answer|incoming/.test(r)) return true;
    if (/user|human|you|own|outgoing|question|prompt|system/.test(r)) return false;
    return !isUserItem(item) && !!(item && (item.innerText || "").trim());
  }

  const BODY_SEL = ".prose, .markdown, .markdown-body, [class*='prose'], [class*='markdown' i], [class*='message-content' i], [class*='MessageContent'], [class*='message-body' i], [class*='message__content' i], [class*='message-text' i], [data-test*='content' i]";
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

  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (ed.isContentEditable || ed.getAttribute("contenteditable") === "true") {
      // Quill re-asserts contenteditable; a readonly data flag + aria is the
      // safest signal, and the core's cover blocks clicks anyway.
      if (on) ed.setAttribute("aria-busy", "true"); else ed.removeAttribute("aria-busy");
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

  // app.clickup.com/login, /signup, /register, /forgot-password are gates.
  function loginGatePresent() {
    const p = (location.pathname || "").toLowerCase();
    if (/^\/(login|signin|signup|register|auth|forgot-password|sso|mfa)(\/|$)/.test(p)) return true;
    try {
      const pw = document.querySelector('input[type="password"]');
      if (pw && visible(pw) && !getEditor()) return true;
    } catch {}
    return false;
  }

  function allowanceExhausted() {
    const root = aiRoot() || document;
    try {
      for (const el of root.querySelectorAll("p, div, span, h1, h2, h3, [role='alert']")) {
        if (!visible(el) || el.closest("#rs-root")) continue;
        const t = (el.textContent || "").trim();
        if (t.length > 320 || t.length < 12) continue;
        if (RE.allowance.test(t)) return t.slice(0, 160);
      }
    } catch {}
    return "";
  }

  function modeWarning() {
    if (loginGatePresent()) return "";
    if (!getEditor()) {
      return "<b>ClickUp Brain</b> — open Brain's chat first: click <b>AI</b> / <b>Brain</b> in the sidebar (or the <b>Ask AI</b> button) so its message box is visible. TotalScript attaches to that box, not to task or comment editors.";
    }
    const a = allowanceExhausted();
    if (a) return `<b>ClickUp Brain</b> — the workspace's AI allowance looks used up (“${a.replace(/</g, "&lt;")}”). Upgrade / enable the Brain add-on or wait for the reset, then retry.`;
    return "";
  }

  const ariaOf = (b) => (b.getAttribute("aria-label") || b.title || b.getAttribute("data-tooltip") || b.getAttribute("data-test") || b.getAttribute("data-testid") || (b.textContent || "").trim()).trim();
  const testOf = (b) => (b.getAttribute("data-test") || b.getAttribute("data-testid") || b.getAttribute("data-cy") || "");
  const allButtons = () => {
    const root = aiRoot();
    const scope = root || document;
    return [...scope.querySelectorAll("button, [role='button'], cu-button, [class*='send-button' i], [class*='submit' i]")].filter((b) => !b.closest("#rs-root"));
  };
  function nearComposer(b) {
    const frame = composerFrame();
    return !frame || frame.contains(b) || (frame.parentElement && frame.parentElement.contains(b)) || (frame.parentElement && frame.parentElement.parentElement && frame.parentElement.parentElement.contains(b));
  }
  const looksSendish = (b) => S.sendAria.test(ariaOf(b)) || S.sendTest.test(testOf(b)) || /send|submit|paper-?plane|arrow-up/i.test(String(b.className || "")) || !!b.querySelector("svg[class*='send' i], [class*='send' i], [data-test*='send' i]");
  const looksStopish = (b) => S.stopAria.test(ariaOf(b)) || S.stopTest.test(testOf(b)) || /stop-?generat|stop-?button/i.test(String(b.className || ""));
  const sendButton = () =>
    allButtons().find((b) => visible(b) && b.type !== "reset" && nearComposer(b) && looksSendish(b)) ||
    allButtons().find((b) => visible(b) && b.type === "submit" && nearComposer(b)) ||
    allButtons().find((b) => visible(b) && b.type !== "reset" && looksSendish(b) && !/search|filter/i.test(ariaOf(b))) ||
    null;
  const stopButton = () => allButtons().find((b) => visible(b) && looksStopish(b)) || null;

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
  const netError = () => { try { const n = NET(); const e = n && n.error(); return e ? n.describe(e, "ClickUp Brain") : null; } catch { return null; } };

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
    try {
      const root = aiRoot();
      const last = lastAssistant();
      const probe = last || root;
      if (probe && probe.querySelector("[class*='typing' i], [class*='thinking' i], [class*='loading' i], [class*='generating' i], [class*='skeleton' i], [class*='spinner' i], [aria-busy='true'], .animate-pulse, .animate-bounce, cu-loader, cu-spinner") && now - _streamAt < WEDGE_MS) return true;
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

  // Brain's per-message cap is undocumented; keep single messages bounded
  // (the compact command index already fits well under this).
  const SEND_MAX = 30000;
  function truncateForSend(text) {
    if (!text || text.length <= SEND_MAX) return text;
    const omitted = text.length - SEND_MAX;
    const marker = `\n\n[…TotalScript: result truncated to fit ClickUp Brain's input limit - ${omitted} of ${text.length} characters omitted…]\n\n`;
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
  function selectAll(el) {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }
  function editorHas(el, text) {
    // Paragraph-per-line editors drop the newlines from textContent: compare
    // with all whitespace removed.
    const have = (el.innerText || el.textContent || "").replace(/\s+/g, "");
    const want = String(text || "").replace(/\s+/g, "");
    const probe = want.slice(0, 40);
    return probe.length > 0 && have.startsWith(probe);
  }
  function setRichText(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      setTextareaValue(el, text);
      return "value";
    }
    el.focus();
    selectAll(el);
    // 1) Native insertText: keeps Quill / ProseMirror state in sync.
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch {}
    if (ok && editorHas(el, text)) return "insertText";
    // 2) Synthetic plain-text paste: rich editors own a paste handler that
    //    inserts text without interpreting markdown shortcuts.
    try {
      selectAll(el);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      if (editorHas(el, text)) return "paste";
    } catch {}
    // 3) Last resort: DOM write + input event.
    el.textContent = text;
    try { el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); }
    catch { el.dispatchEvent(new Event("input", { bubbles: true })); }
    return "dom";
  }

  function pressEnter(editor) {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keypress", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("ClickUp Brain chat box not found — open Brain (sidebar AI / Ask AI) first");
    editor.focus();
    await sleep(40);
    text = truncateForSend(text);
    netMarkSent(text);
    rememberSent(text);
    const how = setRichText(editor, text);
    await sleep(100);
    if (images && images.length) {
      try { await attachImages(images); } catch {}
    }
    const before = userCount();
    const sendReady = () => {
      const b = sendButton();
      return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !b.classList.contains("disabled");
    };
    await waitFor(sendReady, 2500);
    diag("clickup.send", { how, editorLen: editorText().length, textLen: text.length });
    const r = await commitSend(editor, text, { users: before });
    if (!r.sent) diag("clickup.send.unconfirmed", { editorLen: editorText().length, how: r.how });
    else diag("clickup.send.landed", { how: r.how, proof: r.proof });
  }

  // 1.85.0 — commit a send EXACTLY ONCE (the ChatGPT / Gemini baseline rule:
  // "a delayed receipt never authorizes another click"). The previous loop
  // re-clicked Brain's send up to five times whenever the composer had not
  // emptied within 900 ms, which on a slow acceptance duplicated the message.
  // Proof that the send landed is any of: our text left the composer, the stop
  // control is up, a new user row, or the stream tap saw the request. A second
  // attempt uses a DIFFERENT mechanism and only while our text is still typed.
  const netSawRequest = () => { try { const n = NET(); const c = n && n.current(); return !!(c && c.matched); } catch { return false; } };
  async function commitSend(editor, text, pre) {
    const tail = String(text || "").replace(/\s+/g, " ").trim().slice(-60);
    const stillTyped = () => {
      const t = editorText().replace(/\s+/g, " ").trim();
      if (!t) return false;
      return t.length >= tail.length ? t.includes(tail) : tail.includes(t);
    };
    const proof = () => (!stillTyped() ? "cleared" : isHardGenerating() ? "generating" : userCount() > pre.users ? "userRow" : netSawRequest() ? "netRequest" : "");
    const fire = (how) => {
      try {
        if (how === "click") { const b = sendButton(); if (b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !b.classList.contains("disabled")) { b.click(); return true; } return false; }
        const form = editor.closest("form");
        if (form && typeof form.requestSubmit === "function") { form.requestSubmit(); return true; }
        pressEnter(editor); return true;
      } catch { return false; }
    };
    const plan = fire("click") ? ["click", "submit"] : ["submit", "click"];
    if (plan[0] === "submit") fire("submit");
    let p = "";
    await waitFor(() => !!(p = proof()), 2500);
    if (p) return { sent: true, how: plan[0], proof: p };
    if (!fire(plan[1])) return { sent: false, how: plan[0] };
    await waitFor(() => !!(p = proof()), 2500);
    return { sent: !!p, how: plan[1], proof: p };
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
        if (!visible(el) || el.closest("#rs-root")) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && (RE.contextLimit.test(t) || RE.allowance.test(t) || RE.busy.test(t))) return t.slice(0, 240);
      }
    } catch {}
    const a = allowanceExhausted();
    if (a) return "ClickUp Brain's AI allowance looks used up (" + a + ") — upgrade / enable the Brain add-on, then retry.";
    if (!getEditor() && !loginGatePresent()) return "The Brain chat box disappeared (panel closed?). Open Brain again.";
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
  // Brain accepts attachments on plans that include it; otherwise the file
  // input is absent and the paste is ignored - we report false and the core
  // sends the text alone.
  async function attachImages(images) {
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    const root = aiRoot();
    const frame = composerFrame();
    const fileInput = (frame && frame.querySelector('input[type="file"]')) || (root && root.querySelector('input[type="file"]')) || null;
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
    const path = location.pathname || "";
    const m = path.match(/\/(?:ai|brain|chat|conversation|thread)\/([A-Za-z0-9_-]{4,})/);
    if (m) return m[1];
    const q = new URLSearchParams(location.search || "");
    const fromQuery = q.get("aiChat") || q.get("ai_chat") || q.get("conversation") || q.get("conversationId") || q.get("chat") || q.get("thread") || q.get("c");
    if (fromQuery) return fromQuery;
    try {
      const root = aiRoot();
      const idEl = root && (root.closest("[data-conversation-id], [data-chat-id], [data-thread-id]") || root.querySelector("[data-conversation-id], [data-chat-id], [data-thread-id]"));
      if (idEl) return idEl.getAttribute("data-conversation-id") || idEl.getAttribute("data-chat-id") || idEl.getAttribute("data-thread-id");
    } catch {}
    const ws = path.match(/^\/(\d{3,})/);
    return (ws ? "ws" + ws[1] : path) + ":brain";
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
      const btn = t.closest && t.closest("button, [role='button'], cu-button");
      if (!btn || btn.closest("#rs-root")) return;
      const root = aiRoot();
      if (root && !root.contains(btn)) return;
      if (looksStopish(btn)) { handlers.onNativeStop(); return; }
      const isSend = (looksSendish(btn) || btn.type === "submit") && nearComposer(btn);
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

  // 1.85.0: parity with the Vani / MiMo adapters - the plain-text protocol's
  // ###CMD name### blocks and the "shown, not fenced" spellings (escaped /
  // single-quoted / bare keys) the core's relaxed parser executes are masked
  // too; Brain rendered a ###CMD### command as a visible <pre> next to its chip.
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

  // ClickUp's workspace DOM mutates constantly (presence, timers, task
  // lists). Only mutations inside the Brain surface (or that add/remove it)
  // are worth a transcript re-scan.
  function ignoreMutationRecords(records) {
    const root = aiRoot();
    if (!root) return false;
    for (const r of records) {
      const t = r.target;
      if (!t) continue;
      if (root.contains(t) || t.contains(root)) return false;
      for (const n of r.addedNodes || []) if (n.nodeType === 1 && (n.contains(root) || root.contains(n) || isAiMarked(n))) return false;
      for (const n of r.removedNodes || []) if (n.nodeType === 1 && (n === root || n.contains(root))) return false;
    }
    return true;
  }

  return {
    id: "clickup",
    displayName: "ClickUp Brain",
    supportsVision: true,
    // Brain's prompt size is bounded and it may summarise aggressively:
    // compact system prompt + compact command index (names + on-demand schema).
    compactCommandList: true,
    commandListMaxChars: 12000,
    sysMaxChars: 14000,
    // If Brain answers the bootstrap in prose instead of calling list_commands,
    // the core injects the catalogue itself (same fallback Notion uses).
    forceBootstrapCatalogue: true,
    // Brain is a panel inside a larger app: until it is open there is no
    // composer. Keep the bar docked at the viewport bottom so the warning line
    // ("open Brain first") is visible instead of the extension looking dead.
    keepBarVisible: true,
    // Honest flag: Brain's DOM was mapped from ClickUp's conventions, not a
    // live session. The bar shows this pill; the [rs-diag] clickup.* trace
    // tells what the adapter found if something misreads.
    unstableWarning: "ClickUp Brain support is new and adaptive: if a reply is misread or a send does not land, open the diagnostics (TotalScript menu → Settings → Diagnostics) and report the clickup.* lines.",
    promptExtra: "ClickUp Brain rules: this is a plain markdown chat with NO native tools for Roblox Studio - the ONLY way to act is to write the command as text in your reply. Every command goes in ONE fenced code block: three backticks, the word json, a newline, the JSON object, a newline, three backticks (Luau goes between ###LUA### and ###END_LUA### instead). One command per reply; the extension executes it in Studio and sends the result as the next message. Do NOT use ClickUp actions for these messages: never create, edit, assign or search ClickUp tasks, docs, comments, reminders or chat posts and never turn my messages into tasks - answer in this chat only. Do not ask for workspace context; everything you need arrives as messages.",
    timings,
    thinkingSel: ".reasoning, [class*='thinking' i], [class*='reason' i], [class*='thought' i], [data-test*='reasoning' i], details summary",
    init({ diag: d } = {}) {
      if (d) diag = d;
      try { document.documentElement.setAttribute("data-rs-clickup-ver", "2026-10"); } catch {}
      diag("clickup.init", { hasEditor: !!getEditor(), login: loginGatePresent(), path: location.pathname });
    },
    allItems, invalidateItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer() { return { ready: true }; },
    async ensureComposerReady(reason) {
      // The Brain panel is opened by the user after the app loads; give it a
      // moment (and the Angular render a tick) before declaring it absent.
      if (!getEditor()) await waitFor(() => !!getEditor(), 5000);
      diag("clickup.mode_ready", { reason, hasEditor: !!getEditor(), login: loginGatePresent() });
      return { ready: !!getEditor() && !loginGatePresent() };
    },
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    modeWarning, loginGatePresent,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot, ignoreMutationRecords,
    // Exposed for tests / diagnostics.
    _aiRoot: aiRoot, _scoreEditor: scoreEditor,
  };
})();

if (typeof window !== "undefined") window.RSProvider = RSProvider;
