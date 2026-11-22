// SPDX-License-Identifier: GPL-3.0-or-later
// MultiChat adapters with site profiles for HuggingChat, OpenRouter, AI Free Forever, and Langdock.
// The new site profiles are defensive DOM integrations, not live-site compatibility claims.
// eslint-disable-next-line no-unused-vars
const RSProvider = (() => {
  "use strict";

  const AI_FREE_URL = "https://aifreeforever.com/chat/deepseek-v4-flash";
  const LANGDOCK_URL = "https://app.langdock.com/chat";
  const HOSTS = {
    "huggingface.co": { id: "huggingchat", name: "HuggingChat", chat: "https://huggingface.co/chat/" },
    "www.huggingface.co": { id: "huggingchat", name: "HuggingChat", chat: "https://huggingface.co/chat/" },
    "openrouter.ai": { id: "openrouter", name: "OpenRouter Chat", chat: "https://openrouter.ai/chat" },
    "www.openrouter.ai": { id: "openrouter", name: "OpenRouter Chat", chat: "https://openrouter.ai/chat" },
    "aifreeforever.com": { id: "aifreeforever", name: "AI Free Forever", chat: AI_FREE_URL },
    "www.aifreeforever.com": { id: "aifreeforever", name: "AI Free Forever", chat: AI_FREE_URL },
    "app.langdock.com": { id: "langdock", name: "Langdock", chat: LANGDOCK_URL },
  };
  const SITE = HOSTS[location.hostname] || { id: "multichat", name: "AI Chat", chat: location.origin };

  // Site-specific selectors are high-priority hints. Semantic fallbacks remain
  // available because both services can change their frontend markup at any time.
  const PROFILES = {
    aifreeforever: {
      editorSelectors: [
        '[data-testid*="chat-input" i]',
        '[data-testid*="message-input" i]',
        '[data-testid*="composer" i] textarea',
        'textarea[placeholder*="message" i]',
        'textarea[placeholder*="ask" i]',
        'textarea[aria-label*="message" i]',
        'textarea[aria-label*="ask" i]',
        "textarea",
        '[contenteditable="true"][role="textbox"]',
        '[role="textbox"][contenteditable="true"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
      ],
      composerHints: /composer|chat-input|message-input|prompt-box|input-area/i,
      messageSelectors: [
        "[data-message-role]", "[data-role='user']", "[data-role='assistant']",
        "[data-testid*='chat-message' i]", "[data-testid*='message' i]", "[data-message-id]",
        ".chat-message", ".message", "article",
      ],
      logSelectors: ["[role='log']", "[role='feed']", "main [class*='messages' i]", "main [class*='conversation' i]"],
      sendSelectors: [
        'button[data-testid*="send" i]', '[role="button"][data-testid*="send" i]',
        'button[aria-label*="send" i]', 'button[title*="send" i]',
        'button[aria-label*="ask" i]', 'button[type="submit"]',
      ],
      sendWords: /(?:^|[\s_-])(?:send|submit|ask|senden|absenden)(?:$|[\s_-])|send message|send prompt/i,
      stopWords: /stop|cancel|abort|halt|stopp|abbrechen/i,
      authPath: /(?:^|\/)(?:login|log-in|signin|sign-in|auth|sso)(?:\/|$)/i,
      supportsVision: false,
    },
    langdock: {
      editorSelectors: [
        '[data-testid*="composer" i] [contenteditable="true"]',
        '[data-testid*="chat-input" i]',
        '[data-testid*="message-input" i]',
        '[data-lexical-editor="true"]',
        '[data-slate-editor="true"]',
        '[contenteditable="true"][role="textbox"]',
        '[role="textbox"][contenteditable="true"]',
        '[aria-label*="message" i][contenteditable="true"]',
        'textarea[placeholder*="message" i]',
        "textarea",
        '[contenteditable="true"]',
        '[role="textbox"]',
      ],
      composerHints: /composer|chat-input|message-input|prompt|editor|input-area/i,
      messageSelectors: [
        "[data-message-author-role]", "[data-message-role]", "[data-role='user']", "[data-role='assistant']",
        "[data-testid*='chat-message' i]", "[data-testid*='message' i]", "[data-message-id]",
        ".chat-message", ".message", "article",
      ],
      logSelectors: ["[role='log']", "[role='feed']", "main [class*='thread' i]", "main [class*='messages' i]", "main [class*='conversation' i]"],
      sendSelectors: [
        'button[data-testid*="send" i]', '[role="button"][data-testid*="send" i]',
        'button[aria-label*="send" i]', 'button[title*="send" i]',
        'button[type="submit"]',
      ],
      sendWords: /(?:^|[\s_-])(?:send|submit|senden|absenden|abschicken)(?:$|[\s_-])|send message|send prompt/i,
      stopWords: /stop|cancel|abort|halt|stopp|abbrechen/i,
      authPath: /(?:^|\/)(?:login|log-in|signin|sign-in|auth|sso|workspace-selection)(?:\/|$)/i,
      supportsVision: false,
    },
    huggingchat: {
      editorSelectors: ["textarea", '[role="textbox"]', '[contenteditable="true"]'],
      composerHints: /composer|chat-input|message-input/i,
      messageSelectors: ["[data-message-role]", "[data-role='user']", "[data-role='assistant']", "article", ".message"],
      logSelectors: ["[role='log']", "[role='feed']", "main [class*='messages' i]"],
      sendSelectors: ['button[aria-label*="send" i]', 'button[type="submit"]'],
      sendWords: /(?:^|[\s_-])(?:send|submit|ask)(?:$|[\s_-])|send message/i,
      stopWords: /stop|cancel|abort/i,
      authPath: /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i,
      supportsVision: true,
    },
    openrouter: {
      editorSelectors: ["textarea", '[role="textbox"]', '[contenteditable="true"]'],
      composerHints: /composer|chat-input|message-input|prompt/i,
      messageSelectors: ["[data-message-role]", "[data-role='user']", "[data-role='assistant']", "article", ".message"],
      logSelectors: ["[role='log']", "[role='feed']", "main [class*='messages' i]"],
      sendSelectors: ['button[aria-label*="send" i]', 'button[type="submit"]'],
      sendWords: /(?:^|[\s_-])(?:send|submit|ask)(?:$|[\s_-])|send message/i,
      stopWords: /stop|cancel|abort/i,
      authPath: /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i,
      supportsVision: true,
    },
    generic: {
      editorSelectors: ["textarea", '[contenteditable="true"][role="textbox"]', '[data-lexical-editor="true"]', '[data-slate-editor="true"]', '[role="textbox"]', '[contenteditable="true"]'],
      composerHints: /composer|chat-input|message-input|prompt|editor/i,
      messageSelectors: ["[data-message-role]", "[data-role='user']", "[data-role='assistant']", "[data-message-id]", "article", ".message"],
      logSelectors: ["[role='log']", "[role='feed']", "main [class*='messages' i]"],
      sendSelectors: ['button[aria-label*="send" i]', 'button[type="submit"]'],
      sendWords: /(?:^|[\s_-])(?:send|submit|ask)(?:$|[\s_-])|send message/i,
      stopWords: /stop|cancel|abort/i,
      authPath: /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i,
      supportsVision: false,
    },
  };
  const PROFILE = PROFILES[SITE.id] || PROFILES.generic;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let diag = () => {};

  const RE = {
    contextLimit: /context.{0,30}(limit|exceeded|too long)|conversation.{0,30}(too long|limit)|maximum.{0,20}(tokens|context)|(?:token|context).{0,15}(limit|maximum|exceeded)/i,
    tooLong: /conversation.{0,30}(too long|getting too long)|message.{0,20}(too long|exceeds)|token.{0,15}limit/i,
    busy: /rate limit|too many requests|try again later|temporarily unavailable|server is busy|please wait|try again in/i,
    quota: /quota|allowance|credits? (?:are )?(?:used|exhausted)|limit reached|usage limit/i,
    auth: /sign in|log in|login required|authentication required|session expired|choose (?:a )?workspace/i,
    failure: /failed to send|could not send|unable to send|something went wrong|request failed/i,
  };
  const timings = {
    GEN_IDLE_MS: 650,
    REASON_IDLE_MS: 4500,
    WARMUP_MS: 12000,
    REASON_NOREPLY_MS: 22000,
    STABLE_MS: 3500,
    RESPONSE_TIMEOUT_MS: 300000,
  };
  const ERROR_SELECTORS = [
    "[role='alert']", "[aria-live='assertive']", "[data-sonner-toast]",
    "[data-testid*='error' i]", "[data-testid*='toast' i]",
    "[class*='toast' i]", "[class*='error' i]", "[class*='alert' i]",
  ];
  const COMMON_EDITORS = [
    "textarea", '[contenteditable="true"][role="textbox"]', '[role="textbox"][contenteditable="true"]',
    '[data-lexical-editor="true"]', '[data-slate-editor="true"]', '[contenteditable="true"]', '[role="textbox"]',
    'input[type="text"][role="textbox"]', 'input[type="search"][role="textbox"]',
  ];
  const BUTTON_SELECTOR = 'button, [role="button"], input[type="submit"]';

  const getAttr = (el, name) => { try { return String(el && el.getAttribute ? el.getAttribute(name) || "" : ""); } catch { return ""; } };
  const classOf = (el) => { try { return typeof el.className === "string" ? el.className : (el.getAttribute("class") || ""); } catch { return ""; } };
  const safeQuery = (selector, root = document) => { try { return root && root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : []; } catch { return []; } };
  const safeClosest = (el, selector) => { try { return el && el.closest ? el.closest(selector) : null; } catch { return null; } };

  function visible(el) {
    if (!el) return false;
    try {
      if (safeClosest(el, "#rs-root") || getAttr(el, "aria-hidden") === "true" || el.hidden) return false;
      if (safeClosest(el, "[inert]")) return false;
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width < 4 || rect.height < 4) return false;
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const style = win && win.getComputedStyle ? win.getComputedStyle(el) : getComputedStyle(el);
      if (style && (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0)) return false;
    } catch { return false; }
    return true;
  }

  let _shadowRootsCache = { at: 0, roots: null };
  function deepRoots(scope = document) {
    if (scope === document && _shadowRootsCache.roots && Date.now() - _shadowRootsCache.at < 160) return _shadowRootsCache.roots;
    const roots = [scope], seen = new Set(roots);
    for (let i = 0; i < roots.length; i++) {
      for (const host of safeQuery("*", roots[i])) {
        let shadow = null;
        try { shadow = host.shadowRoot; } catch {}
        if (shadow && !seen.has(shadow)) { seen.add(shadow); roots.push(shadow); }
      }
    }
    if (scope === document) _shadowRootsCache = { at: Date.now(), roots };
    return roots;
  }
  function deepQuery(selector, scope = document) {
    const found = [], seen = new Set();
    for (const root of deepRoots(scope)) {
      for (const node of safeQuery(selector, root)) if (!seen.has(node)) { seen.add(node); found.push(node); }
    }
    return found;
  }

  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = excludeSel ? `.rs-chip, ${excludeSel}` : ".rs-chip";
    let text = "";
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) { text += node.nodeValue || ""; return; }
      if (node.nodeType !== 1) return;
      try { if (node.matches && node.matches(skip)) return; } catch {}
      if (node.tagName === "BR") { text += "\n"; return; }
      const block = /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|ARTICLE|SECTION)$/.test(node.tagName || "");
      if (block && text && !text.endsWith("\n")) text += "\n";
      for (const child of node.childNodes || []) walk(child);
      if (block && !text.endsWith("\n")) text += "\n";
    };
    walk(root);
    return text.replace(/\r/g, "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function editorMeta(el) {
    return ["aria-label", "aria-placeholder", "placeholder", "data-placeholder", "name", "title", "data-testid", "id", "role", "type", "class"]
      .map((key) => key === "class" ? classOf(el) : getAttr(el, key)).filter(Boolean).join(" ").toLowerCase();
  }
  function isEditorCandidate(el) {
    if (!el || !visible(el)) return false;
    const tag = String(el.tagName || "").toUpperCase();
    const meta = editorMeta(el);
    const role = getAttr(el, "role").toLowerCase();
    const editable = getAttr(el, "contenteditable").toLowerCase();
    const typedEditor = editable === "true" || (el.isContentEditable === true) ||
      getAttr(el, "data-lexical-editor") === "true" || getAttr(el, "data-slate-editor") === "true" || role === "textbox";
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const type = (getAttr(el, "type") || "text").toLowerCase();
      if (!["text", "search", ""].includes(type)) return false;
      if (type === "search" && !/(message|chat|prompt|ask|composer)/i.test(meta)) return false;
      return role === "textbox" || /(message|chat|prompt|ask|composer|type your)/i.test(meta);
    }
    return typedEditor;
  }
  function readEditableText(el) {
    if (!el) return "";
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "INPUT") {
      try { return String(el.value || "").replace(/\r/g, "").replace(/\u00a0/g, " "); } catch { return ""; }
    }
    let raw = "";
    try { raw = typeof el.innerText === "string" && el.innerText ? el.innerText : (el.textContent || ""); } catch {}
    return String(raw).replace(/\r/g, "").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
  }
  function editorScore(el, selectorBonus) {
    const meta = editorMeta(el);
    const tag = String(el.tagName || "").toUpperCase();
    let score = selectorBonus || 0;
    if (tag === "TEXTAREA") score += 8;
    else if (tag === "INPUT") score += 3;
    else if (getAttr(el, "contenteditable").toLowerCase() === "true" || el.isContentEditable) score += 8;
    if (getAttr(el, "role").toLowerCase() === "textbox") score += 5;
    if (/(message|chat|prompt|ask|compose|type your message|type a message)/i.test(meta)) score += 20;
    if (PROFILE.composerHints.test(meta)) score += 12;
    if (/(search|filter|find|email|password|username|workspace name|invite)/i.test(meta)) score -= 34;
    if (/(navigation|sidebar|menu-search|global-search)/i.test(meta)) score -= 12;
    if (getAttr(el, "disabled") || getAttr(el, "aria-disabled") === "true") score -= 5;
    if (getAttr(el, "readonly") !== "" || getAttr(el, "aria-readonly") === "true") score -= 8;
    if (safeClosest(el, "form")) score += 6;
    if (safeClosest(el, "main, [role='main']")) score += 3;
    if (safeClosest(el, "footer")) score += 3;
    try {
      const r = el.getBoundingClientRect();
      const viewportHeight = Number(window.innerHeight || 0);
      const viewportWidth = Number(window.innerWidth || 0);
      if (viewportHeight > 0 && r.top > viewportHeight * 0.58) score += 5;
      if (viewportWidth > 0 && r.width > viewportWidth * 0.30) score += 3;
    } catch {}
    return score;
  }

  let _editorCache = { at: 0, node: null, valid: false };
  function getEditor() {
    const now = Date.now();
    if (_editorCache.valid && now - _editorCache.at < 160 && (!_editorCache.node || isEditorCandidate(_editorCache.node))) return _editorCache.node;
    const profileSelectors = PROFILE.editorSelectors || [];
    const selectors = [...new Set([...profileSelectors, ...COMMON_EDITORS])];
    const found = new Map();
    const collect = (deep) => {
      selectors.forEach((selector, index) => {
        const nodes = deep ? deepQuery(selector) : safeQuery(selector);
        const selectorBonus = index < profileSelectors.length ? Math.max(0, 20 - index) : 0;
        for (const node of nodes) {
          if (!isEditorCandidate(node)) continue;
          const score = editorScore(node, selectorBonus);
          if (!found.has(node) || found.get(node) < score) found.set(node, score);
        }
      });
    };
    collect(false);
    let best = null, bestScore = -Infinity;
    for (const [node, score] of found) if (score > bestScore) { best = node; bestScore = score; }
    // Only walk open shadow roots when normal selectors did not identify a strong
    // candidate; keep the common path cheap on the large chat workspaces.
    if (!best || bestScore < 18) {
      collect(true);
      for (const [node, score] of found) if (score > bestScore) { best = node; bestScore = score; }
    }
    _editorCache = { at: now, node: bestScore > 0 ? best : null, valid: true };
    return _editorCache.node;
  }
  const editorText = () => readEditableText(getEditor());

  function roleOf(item) {
    if (!item) return "";
    const values = [
      getAttr(item, "data-message-role"), getAttr(item, "data-message-author-role"),
      getAttr(item, "data-role"), getAttr(item, "data-author"), getAttr(item, "data-author-role"),
      getAttr(item, "data-testid"), getAttr(item, "aria-label"), classOf(item),
    ].join(" ").toLowerCase();
    if (/(^|[^a-z])(user|human|you)([^a-z]|$)|user[-_ ]message|message[-_ ]user/.test(values)) return "user";
    if (/(^|[^a-z])(assistant|agent|model|bot|ai)([^a-z]|$)|assistant[-_ ]message|message[-_ ]assistant/.test(values)) return "assistant";
    try {
      const child = item.querySelector("[data-message-role], [data-message-author-role], [data-role], [data-author-role]");
      if (child && child !== item) return roleOf(child);
    } catch {}
    return "";
  }

  let _itemsCache = { at: 0, list: null };
  const invalidateItems = () => { _itemsCache = { at: 0, list: null }; _editorCache = { at: 0, node: null, valid: false }; _shadowRootsCache = { at: 0, roots: null }; };
  function allItems() {
    const now = Date.now();
    if (_itemsCache.list && now - _itemsCache.at < 120) return _itemsCache.list;
    const list = allItemsUncached();
    _itemsCache = { at: now, list };
    return list;
  }
  function allItemsUncached() {
    const selectors = [...new Set([
      ...(PROFILE.messageSelectors || []),
      "[data-message-role]", "[data-message-author-role]", "[data-message-id]",
      "[data-role='user']", "[data-role='assistant']", "[data-author-role]",
      "[data-testid*='chat-message' i]", "[data-testid*='message' i]",
      ".msg", ".message", "[class*='chat-message' i]", "article",
    ])];
    const candidates = new Set();
    for (const selector of selectors) for (const el of safeQuery(selector)) candidates.add(el);
    const logs = [...new Set(PROFILE.logSelectors || [])];
    for (const selector of logs) {
      for (const log of safeQuery(selector)) {
        if (!visible(log)) continue;
        for (const child of log.children || []) if (child && child.nodeType === 1) candidates.add(child);
      }
    }
    const list = [...candidates].filter((el) => {
      if (!visible(el) || safeClosest(el, "#rs-root") || el === getEditor()) return false;
      const text = itemText(el).trim();
      if (!text || text.length > 180000) return false;
      const meta = [getAttr(el, "data-testid"), getAttr(el, "data-message-id"), classOf(el), getAttr(el, "role")].join(" ").toLowerCase();
      const explicit = !!roleOf(el) || /message|chat-turn|conversation-item|assistant|human|user|response|reply|bubble/.test(meta);
      const inLog = logs.some((selector) => !!safeClosest(el, selector));
      return explicit || inLog || String(el.tagName || "").toUpperCase() === "ARTICLE";
    });
    const listSet = new Set(list);
    const topLevel = list.filter((el) => {
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        if (listSet.has(parent) && roleOf(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
    try {
      topLevel.sort((a, b) => {
        const pos = a.compareDocumentPosition && a.compareDocumentPosition(b);
        if (pos & 2) return 1;
        if (pos & 4) return -1;
        return 0;
      });
    } catch {}
    return topLevel;
  }

  function isUserItem(item) {
    const role = roleOf(item);
    if (role === "user") return true;
    if (role === "assistant") return false;
    return /\bml-auto\b|justify-end|items-end|from-user|user-message|message-user/i.test(classOf(item));
  }
  function isAssistantItem(item) {
    const role = roleOf(item);
    if (role === "assistant") return true;
    if (role === "user") return false;
    return !isUserItem(item) && !!itemText(item).trim();
  }
  function itemText(item) {
    if (!item) return "";
    const contentSelectors = [
      ...(PROFILE.contentSelectors || []), ".prose", ".markdown", ".bubble",
      "[data-testid*='message-content' i]", "[data-testid*='message-text' i]",
      "[class*='message-content' i]", "[class*='markdown' i]",
    ];
    for (const selector of [...new Set(contentSelectors)]) {
      try { const body = item.querySelector(selector); if (body) return textWithout(body); } catch {}
    }
    return textWithout(item);
  }
  function classifyText(item, excludeSel) {
    if (!item) return "";
    const contentSelectors = [...new Set([...(PROFILE.contentSelectors || []), ".prose", ".markdown", ".bubble", "[class*='message-content' i]"])];
    for (const selector of contentSelectors) {
      try { const body = item.querySelector(selector); if (body) return textWithout(body, excludeSel); } catch {}
    }
    return textWithout(item, excludeSel);
  }

  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => { const list = assistantItems(); return list.length ? list[list.length - 1] : null; };
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
    const editor = getEditor();
    if (!editor) return null;
    let node = editor;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      if (!node || node === document.body || node === document.documentElement) continue;
      const meta = [classOf(node), getAttr(node, "data-testid"), getAttr(node, "role")].join(" ");
      if (PROFILE.composerHints.test(meta) || /^(FORM|FOOTER)$/.test(node.tagName || "") || getAttr(node, "role") === "group") return node;
    }
    return safeClosest(editor, "form") || editor.parentElement || editor;
  }
  function barAnchor() {
    const editor = getEditor();
    if (!editor) return null;
    let node = editor;
    for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
      const meta = [classOf(node), getAttr(node, "data-testid")].join(" ");
      if (/rounded|composer|input-bar|chat-input|message-input|prompt-box/i.test(meta)) return node;
    }
    return composerFrame();
  }

  function setInputLock(on) {
    const editor = getEditor();
    if (!editor) return;
    if (editor.isContentEditable || getAttr(editor, "contenteditable") === "true" || getAttr(editor, "data-lexical-editor") === "true" || getAttr(editor, "data-slate-editor") === "true") {
      editor.setAttribute("contenteditable", on ? "false" : "true");
      return;
    }
    if (on) {
      if (!editor.dataset.rsPlaceholder) editor.dataset.rsPlaceholder = getAttr(editor, "placeholder");
      editor.setAttribute("readonly", "");
      editor.setAttribute("placeholder", "⏳ Agent working… please wait");
    } else {
      editor.removeAttribute("readonly");
      if (editor.dataset.rsPlaceholder != null) editor.setAttribute("placeholder", editor.dataset.rsPlaceholder);
    }
  }

  function loginGatePresent() {
    const route = `${location.pathname || ""}${location.hash || ""}`;
    if (PROFILE.authPath.test(route) && !getEditor()) return true;
    if (getEditor()) return false; // guest composers and marketing sign-in links stay usable
    for (const input of safeQuery('input[type="password"], input[autocomplete*="password" i]')) if (visible(input)) return true;
    let authButtons = 0, authHeadings = 0;
    for (const el of safeQuery("h1, h2, [role='heading'], button, [role='button'], a")) {
      if (!visible(el) || safeClosest(el, "#rs-root")) continue;
      const text = `${getAttr(el, "aria-label")} ${getAttr(el, "title")} ${el.innerText || el.textContent || ""}`.trim();
      if (/sign in|log in|login|continue with (google|microsoft|sso)|select a workspace/i.test(text)) {
        if (/^(H1|H2)$/.test(el.tagName || "") || getAttr(el, "role") === "heading") authHeadings++;
        else authButtons++;
      }
    }
    return authButtons > 0 && authHeadings > 0;
  }
  function modeWarning() {
    if (loginGatePresent()) return `<b>${SITE.name}</b> — sign in on the site, then open <b>${SITE.chat}</b>. TotalScript does not bypass provider authentication.`;
    if (!getEditor()) return `<b>${SITE.name}</b> — chat composer not found. Open <b>${SITE.chat}</b>, finish any sign-in, then reload this tab.`;
    return "";
  }

  const buttonMeta = (button) => [
    getAttr(button, "aria-label"), getAttr(button, "title"), getAttr(button, "data-tooltip"),
    getAttr(button, "data-testid"), getAttr(button, "name"), getAttr(button, "value"),
    classOf(button), button && (button.innerText || button.textContent || ""),
    ...safeQuery("svg, [aria-label], [data-icon]", button).map((el) => [getAttr(el, "aria-label"), getAttr(el, "data-icon"), getAttr(el, "title"), classOf(el)].join(" ")),
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const ariaOf = (button) => buttonMeta(button);
  const allButtons = (scope = document) => {
    const found = new Set(safeQuery(BUTTON_SELECTOR, scope).filter((button) => !safeClosest(button, "#rs-root")));
    if (!found.size) for (const button of deepQuery(BUTTON_SELECTOR, scope)) if (!safeClosest(button, "#rs-root")) found.add(button);
    return [...found];
  };
  const buttonDisabled = (button) => !!(button && (button.disabled || getAttr(button, "disabled") !== "" || getAttr(button, "aria-disabled").toLowerCase() === "true" || getAttr(button, "data-disabled").toLowerCase() === "true" || getAttr(button, "aria-busy").toLowerCase() === "true"));
  function isStopControl(button) { return PROFILE.stopWords.test(buttonMeta(button)); }
  function isSendControl(button) {
    const label = buttonMeta(button);
    return !isStopControl(button) && !/attach|upload|file|image|voice|audio|microphone|record|new chat|feedback|share|copy|search|menu|sign in|log in/i.test(label) && PROFILE.sendWords.test(label);
  }
  function sendButton() {
    const frame = composerFrame();
    const root = (() => { try { const r = getEditor() && getEditor().getRootNode(); return r && r.querySelectorAll ? r : document; } catch { return document; } })();
    const selectors = [...new Set([...(PROFILE.sendSelectors || []), BUTTON_SELECTOR])];
    const candidates = new Set();
    for (const selector of selectors) {
      for (const item of safeQuery(selector, frame || document)) candidates.add(item);
      if (root !== document) for (const item of safeQuery(selector, root)) candidates.add(item);
      for (const item of safeQuery(selector, document)) candidates.add(item);
    }
    if (!candidates.size) for (const item of deepQuery(BUTTON_SELECTOR)) candidates.add(item);
    const localButtons = frame ? allButtons(frame) : [];
    const excluded = /attach|upload|file|image|voice|audio|microphone|record|new chat|feedback|share|copy|search|menu|sign in|log in/i;
    const isPotentialSend = (button) => {
      if (!visible(button) || safeClosest(button, "#rs-root") || isStopControl(button)) return false;
      const meta = buttonMeta(button);
      if (excluded.test(meta)) return false;
      return isSendControl(button) || /send|submit|arrow-up|paper-plane/i.test(meta) ||
        getAttr(button, "type").toLowerCase() === "submit" || (!meta && localButtons.length === 1);
    };
    const localCandidates = [...candidates].filter((button) => frame && frame.contains && frame.contains(button) && isPotentialSend(button));
    // Prefer a control inside the editor's own composer. Only search elsewhere
    // when the local frame has no plausible send action; this avoids clicking a
    // page-level Submit/Send button on a dashboard with multiple forms.
    const pool = localCandidates.length ? localCandidates : [...candidates].filter(isPotentialSend);
    let best = null, bestScore = -Infinity;
    for (const button of pool) {
      const meta = buttonMeta(button);
      let score = 0;
      if (isSendControl(button)) score += 55;
      if (/send|submit|arrow-up|paper-plane/i.test(meta)) score += 30;
      if (getAttr(button, "type").toLowerCase() === "submit") score += 25;
      if (frame && (button === frame || frame.contains && frame.contains(button))) score += 60;
      if (safeClosest(button, "form") && safeClosest(button, "form") === safeClosest(getEditor(), "form")) score += 10;
      if (buttonDisabled(button)) score -= 2;
      const rect = (() => { try { return button.getBoundingClientRect(); } catch { return null; } })();
      const editorRect = (() => { try { return getEditor().getBoundingClientRect(); } catch { return null; } })();
      if (rect && editorRect && Math.abs((rect.top + rect.height / 2) - (editorRect.top + editorRect.height / 2)) < Math.max(40, editorRect.height)) score += 4;
      if (!meta && localButtons.length === 1) score += 30;
      if (!meta && localButtons.length > 1 && localButtons[localButtons.length - 1] === button && /send|submit|arrow|plane/i.test(classOf(button))) score += 12;
      if (score > bestScore) { best = button; bestScore = score; }
    }
    if (best) return best;
    // A sole, unlabelled button in the composer is the only safe icon fallback.
    const unlabelled = localButtons.filter((button) => visible(button) && !buttonMeta(button) && !buttonDisabled(button));
    return localButtons.length === 1 && unlabelled.length === 1 ? localButtons[0] : null;
  }
  function stopButton() {
    let best = null, score = -Infinity;
    for (const button of allButtons()) {
      if (!visible(button) || !isStopControl(button)) continue;
      const next = (safeClosest(button, "form") ? 10 : 0) + (buttonDisabled(button) ? -2 : 1);
      if (next > score) { best = button; score = next; }
    }
    return best;
  }

  function streamText(item) { return item ? classifyText(item, ".rs-chip").trim() : ""; }
  const streamLen = (item) => { const text = netText(); if (text) return text.length; return streamText(item === undefined ? lastAssistant() : item).length; };

  // MAIN-world stream tap: prefer verbatim network output when recognized; DOM
  // remains the fallback for these sites' unknown or changed stream protocols.
  const NET = () => (typeof RSStreamNet !== "undefined" ? RSStreamNet : (window.RSStreamNet || null));
  const netText = () => { try { const tap = NET(); return tap ? tap.replyText() : ""; } catch { return ""; } };
  const netGen = (stopVisible) => { try { const tap = NET(); return tap ? tap.genState({ stopVisible }) : null; } catch { return null; } };
  const netMarkSent = (text) => { try { const tap = NET(); if (tap) tap.markSent(text); } catch {} };
  const netError = () => { try { const tap = NET(); const error = tap && tap.error(); return error ? tap.describe(error, SITE.name) : null; } catch { return null; } };
  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant(), length = streamText(item).length, now = Date.now();
    if (item !== _streamItem || length < _streamMax - 400) { _streamItem = item; _streamMax = length; _streamAt = now; return; }
    if (length > _streamMax) { _streamMax = length; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;
  const WEDGE_MS = 12000;
  let _stopSince = 0;
  function genActive() {
    sampleStream();
    const stop = !!stopButton(), now = Date.now(), network = netGen(stop);
    if (network === "streaming") return true;
    if (network === "done" && !stop) return false;
    if (stop) { if (!_stopSince) _stopSince = now; return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2500); }
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
    try { const item = lastAssistant(); return item ? { th: 0, rp: streamLen(item) } : { th: 0, rp: 0 }; } catch { return {}; }
  }
  function readAssistant() {
    const item = lastAssistant(), networkText = netText().trim();
    if (networkText) return { present: true, reply: networkText, thinking: "", item, net: true };
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const reply = streamText(item).trim();
    return { present: !!reply, reply, thinking: "", item };
  }

  async function waitFor(predicate, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) { if (predicate()) return true; await sleep(100); }
    return !!predicate();
  }
  const SEND_MAX = 120000;
  function truncateForSend(text) {
    const value = String(text == null ? "" : text);
    if (value.length <= SEND_MAX) return value;
    const omitted = value.length - SEND_MAX;
    const marker = `\n\n[…TotalScript: result truncated to fit ${SITE.name}'s input limit - ${omitted} of ${value.length} characters omitted…]\n\n`;
    const budget = SEND_MAX - marker.length, head = Math.floor(budget * 0.85), tail = budget - head;
    return value.slice(0, head) + marker + value.slice(value.length - tail);
  }
  function normalizedDraft(value) { return String(value || "").replace(/\r/g, "").replace(/\u00a0/g, " ").replace(/\u200b/g, "").replace(/\s+/g, " ").trim(); }
  function hasDraft(editor, text) {
    const actual = normalizedDraft(readEditableText(editor)), expected = normalizedDraft(text);
    if (!actual || !expected) return false;
    const tail = expected.slice(-Math.min(80, expected.length));
    return actual === expected || (actual.endsWith(tail) && actual.length <= expected.length + 24);
  }
  function dispatchInput(editor, type, data) {
    const doc = editor.ownerDocument || document, win = doc.defaultView || window;
    try {
      const Input = win.InputEvent || InputEvent;
      editor.dispatchEvent(new Input("input", { bubbles: true, inputType: type, data }));
    } catch { try { editor.dispatchEvent(new (win.Event || Event)("input", { bubbles: true })); } catch {} }
    try { editor.dispatchEvent(new (win.Event || Event)("change", { bubbles: true })); } catch {}
  }
  function setTextareaValue(editor, value) {
    const doc = editor.ownerDocument || document, win = doc.defaultView || window;
    const ctor = editor.tagName === "TEXTAREA" ? win.HTMLTextAreaElement : win.HTMLInputElement;
    const descriptor = ctor && Object.getOwnPropertyDescriptor(ctor.prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(editor, value);
    else editor.value = value;
    dispatchInput(editor, "insertText", value);
  }
  function setRichText(editor, value) {
    const tag = String(editor.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "INPUT") { setTextareaValue(editor, value); return; }
    const doc = editor.ownerDocument || document;
    try { editor.focus(); } catch {}
    try {
      const selection = (doc.defaultView || window).getSelection();
      const range = doc.createRange(); range.selectNodeContents(editor);
      selection.removeAllRanges(); selection.addRange(range);
      if (doc.execCommand) { doc.execCommand("selectAll", false, null); doc.execCommand("insertText", false, value); }
    } catch {}
    if (!hasDraft(editor, value)) {
      try { editor.textContent = value; } catch {}
      dispatchInput(editor, "insertText", value);
    }
    return hasDraft(editor, value);
  }
  function pressEnter(editor) {
    const doc = editor.ownerDocument || document, win = doc.defaultView || window;
    const options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    try { editor.dispatchEvent(new win.KeyboardEvent("keydown", options)); } catch {}
    try { editor.dispatchEvent(new win.KeyboardEvent("keypress", options)); } catch {}
    try { editor.dispatchEvent(new win.KeyboardEvent("keyup", options)); } catch {}
  }

  async function typeAndSend(rawText, images) {
    const editor = getEditor();
    if (!editor) throw new Error(`${SITE.name} composer not found — open ${SITE.chat}`);
    if (images && images.length && !PROFILE.supportsVision) throw new Error(`${SITE.name} image attachment is disabled until its upload UI is verified.`);
    if (stopButton() || isGenerating()) {
      diag(`${SITE.id}.send.busy`, { phase: "before-type" });
      return false; // do not overwrite or submit while the provider owns the composer
    }
    const text = truncateForSend(rawText);
    const beforeUsers = userCount();
    try { editor.focus(); } catch {}
    await sleep(30);
    if (stopButton()) {
      diag(`${SITE.id}.send.busy`, { phase: "before-type" });
      return false;
    }
    netMarkSent(text);
    setRichText(editor, text);
    const typed = await waitFor(() => hasDraft(editor, text), 1400);
    if (!typed) {
      diag(`${SITE.id}.send.type.unconfirmed`, { editorTag: String(editor.tagName || ""), editorLen: readEditableText(editor).length, textLen: text.length });
      return false; // this profile has not submitted anything yet
    }
    if (images && images.length) {
      const attached = await attachImages(images);
      if (!attached) throw new Error(`${SITE.name} did not accept the requested image attachment.`);
    }
    const ready = await waitFor(() => { const button = sendButton(); return !button || !buttonDisabled(button); }, 1800);
    if (!ready) {
      diag(`${SITE.id}.send.control.disabled`, { editorLen: readEditableText(editor).length });
      return false; // no click / Enter / form submit has been issued
    }
    if (stopButton()) {
      diag(`${SITE.id}.send.busy`, { phase: "before-commit" });
      return false; // stop/cancel control means the current provider turn still owns this composer
    }
    diag(`${SITE.id}.send.prepare`, { editorTag: String(editor.tagName || ""), editorLen: readEditableText(editor).length, textLen: text.length, hasButton: !!sendButton() });
    const result = await commitSend(editor, text, beforeUsers);
    if (!result.submitted) {
      diag(`${SITE.id}.send.unsubmitted`, { how: result.how, editorLen: readEditableText(editor).length });
      return false;
    }
    if (!result.proof) diag(`${SITE.id}.send.unconfirmed`, { how: result.how, editorLen: readEditableText(editor).length });
    else diag(`${SITE.id}.send.landed`, { how: result.how, proof: result.proof });
    return true;
  }

  const netSawRequest = () => { try { const tap = NET(), current = tap && tap.current(); return !!(current && current.matched); } catch { return false; } };
  async function commitSend(editor, text, beforeUsers) {
    const button = sendButton();
    if (button && buttonDisabled(button)) return { submitted: false, how: "disabled" };
    let submitted = false, how = "";
    try {
      if (button) { button.click(); submitted = true; how = "scoped-button"; }
      else {
        const form = safeClosest(editor, "form");
        if (form && typeof form.requestSubmit === "function") { form.requestSubmit(); submitted = true; how = "form-requestSubmit"; }
        else { pressEnter(editor); submitted = true; how = "enter"; }
      }
    } catch (error) {
      diag(`${SITE.id}.send.dispatchError`, { how, error: String(error && error.message || error).slice(0, 120) });
      return { submitted: false, how: how || "dispatch-error" };
    }
    if (!submitted) return { submitted: false, how: how || "no-control" };
    const tail = normalizedDraft(text).slice(-Math.min(80, normalizedDraft(text).length));
    let proof = "";
    const confirmed = await waitFor(() => {
      const draft = normalizedDraft(readEditableText(editor));
      if (!draft || !draft.endsWith(tail)) { proof = "composer-cleared"; return true; }
      if (userCount() > beforeUsers) { proof = "user-row"; return true; }
      if (isHardGenerating()) { proof = "generating"; return true; }
      if (netSawRequest()) { proof = "network-request"; return true; }
      return false;
    }, 4200);
    return { submitted: true, confirmed, how, proof };
  }

  function stopGeneration() { const button = stopButton(); if (button) { try { button.click(); } catch {} } }

  function scanError() {
    const networkError = netError();
    if (networkError) return networkError;
    for (const selector of [...new Set([...ERROR_SELECTORS, ...(PROFILE.errorSelectors || [])])]) {
      for (const el of safeQuery(selector)) {
        if (!visible(el) || safeClosest(el, "#rs-root")) continue;
        const text = String(el.innerText || el.textContent || "").trim();
        if (text.length < 8 || text.length > 800) continue;
        if (RE.contextLimit.test(text) || RE.tooLong.test(text) || RE.busy.test(text) || RE.quota.test(text) || RE.auth.test(text) || RE.failure.test(text)) return text.slice(0, 300);
      }
    }
    if (loginGatePresent()) return `${SITE.name} requires you to sign in on the provider site; TotalScript cannot bypass authentication.`;
    const editor = getEditor();
    if (!editor) return `The ${SITE.name} chat composer is missing. Open ${SITE.chat} and sign in if requested.`;
    const button = sendButton();
    if (button && buttonDisabled(button) && !isGenerating()) return `${SITE.name}'s Send control is disabled. Check the provider's sign-in, quota, and required-field notices.`;
    return null;
  }
  const isTooLongMsg = (message) => RE.tooLong.test(String(message || "")) || RE.contextLimit.test(String(message || ""));
  const isBusyMsg = (message) => RE.busy.test(String(message || "")) || RE.quota.test(String(message || ""));

  function fileFromImage(image, index) {
    const mime = image.mimeType || "image/jpeg", binary = atob(image.data), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], `totalscript_${Date.now()}_${index}.${mime.includes("png") ? "png" : "jpg"}`, { type: mime });
  }
  function clearAttachments() {}
  async function attachImages(images) {
    if (!PROFILE.supportsVision) return false;
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    const transfer = new DataTransfer();
    images.forEach((image, index) => { try { transfer.items.add(fileFromImage(image, index)); } catch {} });
    if (!transfer.items.length) return false;
    const frame = composerFrame() || document;
    const fileInput = safeQuery('input[type="file"]', frame)[0] || safeQuery('input[type="file"]', document)[0];
    if (fileInput) {
      try { fileInput.files = transfer.files; fileInput.dispatchEvent(new Event("change", { bubbles: true })); return true; } catch {}
    }
    try { editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })); } catch {}
    return false;
  }
  function conversationKey() {
    const path = String(location.pathname || ""), hash = String(location.hash || "");
    if (SITE.id === "aifreeforever") return `${path}${hash}`; // this site's path names the model, not an individual chat
    const route = `${path}${hash}`;
    const match = route.match(/(?:\/|#\/)(?:chat|chats|c|conversation|thread)\/([^/?#]+)/i);
    if (match) { try { return decodeURIComponent(match[1]); } catch { return match[1]; } }
    return route || location.origin;
  }

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || safeClosest(event.target, "#rs-root")) return;
      const editor = getEditor();
      if (!editor || !(editor === event.target || (editor.contains && editor.contains(event.target))) || !editorText().trim()) return;
      netMarkSent(editorText());
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) { if (!chatIsEmpty()) return; handlers.onBlockedAttempt(); return; }
      handlers.onUserMessage(assistantCount());
    }, true);
    document.addEventListener("click", (event) => {
      if (safeClosest(event.target, "#rs-root")) return;
      const editor = getEditor();
      if (!editor) return;
      const target = safeClosest(event.target, BUTTON_SELECTOR);
      if (!target) return;
      if (isStopControl(target)) { handlers.onNativeStop(); return; }
      if (target !== sendButton() && !isSendControl(target)) return;
      if (buttonDisabled(target)) return;
      netMarkSent(editorText());
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) { if (!chatIsEmpty()) return; handlers.onBlockedAttempt(); return; }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###\s*(?:cmd|command|tool)\s*[:\s]\s*[A-Za-z_][A-Za-z0-9_.\/-]*\s*(?:###|---)|###mcp_tool###/i;
  function findToolBlockSpot(item) {
    if (!item) return null;
    let parent = null, ref = null;
    for (const pre of safeQuery("pre", item)) {
      if (safeClosest(pre, ".rs-chip") || !CMD_SHAPE.test(pre.textContent || "")) continue;
      try { pre.classList.add("rs-tool-hide"); item.classList.add("rs-cmd-mask"); } catch {}
      if (!ref && pre.parentElement) { parent = pre.parentElement; ref = pre; }
    }
    return ref ? { parent, ref } : null;
  }

  return {
    id: SITE.id,
    displayName: SITE.name,
    supportsVision: !!PROFILE.supportsVision,
    // This adapter returns false only before issuing a native submit action.
    // Once click/requestSubmit/Enter is dispatched, the core must not blindly
    // resend on an ambiguous DOM (the site may accept without clearing input).
    typeAndSendFalseMeansNoSubmit: true,
    typeAndSendSingleCommit: true,
    timings,
    maxBatchCommands: 4,
    commandlessRetries: 2,
    resendSystemEvery: 10,
    promptExtra:
      `- ${SITE.name} execution rules: TotalScript is active on this page and executes your command blocks for real in Roblox Studio / Blender. Never write DIY tutorials, never simulate "Output of ..." text, and never refuse for lack of tool access.\n- Command format: use ###LUA### ... ###END_LUA### for Luau or fenced {"command":"name","params":{...}} for other tools. Act on turn 1 with complete, zero-stub implementations and verify live results before finishing.`,
    thinkingSel: ".reasoning, [class*='thinking'], [class*='reason'], [class*='thought'], [data-testid*='reasoning']",
    init({ diag: diagnostic } = {}) {
      if (diagnostic) diag = diagnostic;
      try { document.documentElement.setAttribute("data-rs-multichat-ver", "2026-10-site-rework"); } catch {}
      const editor = getEditor();
      diag(`${SITE.id}.init`, { hasEditor: !!editor, editorTag: editor ? String(editor.tagName || "") : "", login: loginGatePresent(), path: location.pathname });
    },
    allItems, invalidateItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer() { return { ready: true }; },
    async ensureComposerReady(reason) {
      const editor = getEditor(), login = loginGatePresent();
      diag(`${SITE.id}.mode_ready`, { reason, hasEditor: !!editor, login, path: location.pathname });
      return { ready: !!editor && !login, reason: login ? "authentication-required" : editor ? "ready" : "chat-composer-not-found" };
    },
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    modeWarning, loginGatePresent,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();

if (typeof window !== "undefined") window.RSProvider = RSProvider;
