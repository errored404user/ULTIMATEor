// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/claude.js — claude.ai / claude.com
// Same RSProvider interface as chatgpt.js. To disable, remove this file from
// manifest.json, background.js PROVIDER_URLS, popup.js SUPPORTED_HOSTS, main.js AI_SITES.
//
// Works with EVERY Claude model the site offers. The picker is left to the user
// (Haiku / Sonnet / Opus / Fable / Mythos, any generation). TotalScript never clicks it.
// Family is read from the picker label so timings + prompt size can adapt:
//   haiku  — compact system prompt, tighter idle windows
//   sonnet — default
//   opus / fable / mythos — long thinking / adaptive-reasoning windows
//
// Claude DOM (claude.ai / claude.com, 2026 — shared across models):
//  - User turns: [data-testid="user-message"]
//  - Assistant turns: .font-claude-response (markdown in .standard-markdown)
//  - Composer: ProseMirror contenteditable at the bottom (not inside a turn)
//  - Send: button[aria-label="Send message"] / data-testid="send-button"
//  - Stop: aria-label contains "Stop" ("Stop response" / "Stop generating")
//  - Thinking: [data-is-thinking], [class*="thinking"], [class*="extended-thinking"]
//  - Chat URL: /new, /chat/<uuid>, /project/<uuid>
const RSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const v = fn(); if (v) return v; } catch {}
      await sleep(80);
    }
    return fn();
  };

  let diag = () => {};
  const timings = {
    GEN_IDLE_MS: 550,
    REASON_IDLE_MS: 4500,
    WARMUP_MS: 10000,
    REASON_NOREPLY_MS: 20000,
    STABLE_MS: 3000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  const S = {
    user: '[data-testid="user-message"], [data-testid="user-turn"], [data-role="user"]',
    assistant: '.font-claude-response, [data-testid="assistant-message"], [data-testid="assistant-turn"], [data-testid="claude-response"], [data-role="assistant"]',
    reply: ".standard-markdown, .font-claude-response, [class*='grid-cols-1'], [data-testid='markdown']",
    // Include locked (contenteditable=false) nodes: startSession locks the
    // composer BEFORE ensureComposerReady, so requiring true would miss it and
    // the core would banner "Couldn't switch Claude into the right mode".
    editor: 'div.ProseMirror, [data-rs-locked="1"], [contenteditable][role="textbox"], div[contenteditable="true"]',
    thinking: '[data-is-thinking="true"], [data-testid*="thinking"], [class*="thinking"], [class*="extended-thinking"], [class*="Thoughts"]',
    artifact: '[data-testid="artifact"], [data-testid*="artifact"], [class*="artifact-content"], [class*="Artifact"]',
    codeWrap: "pre, .code-block, .cm-content",
    errorSurfaces: '[role="alert"], [data-testid*="error"], [class*="error-message"]',
    modelBtn: '[data-testid="model-selector"], [data-testid="model-selector-dropdown"], button[aria-haspopup="listbox"], button[aria-label*="model" i], [class*="model-selector"]',
  };

  const SEND_MAX_CHARS = 100000;
  const SEND_MAX_LINES = 500;
  const INSERT_CHUNK_LINES = 25;
  // 2.16: also the plain ###CMD name### opener. The parser accepts it on every
  // provider, so when the model answers in that shape the command RAN but the
  // <pre> was never camouflaged - the raw block stayed visible and the core's
  // ensureOwnedChip saw "raw command visible" on every sweep and rebuilt the
  // chip forever (the rebuild storm the Arena notes describe).
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###\s*cmd\s|###\s*(?:cmd|command|tool)\s*[:\s]\s*[A-Za-z_][A-Za-z0-9_.\/-]*\s*(?:###|---)|###mcp_tool###/i; // 2.21.0: + the full ###CMD name### / ###COMMAND name### / ###TOOL name### opener (RSParse.CMD_START_RE)

  const RE = {
    contextLimit: /conversation.{0,20}(too long|limit)|too many (tokens|characters)|maximum.{0,16}(length|context)|context window/i,
    tooLong: /message.{0,20}too long|over the (character|token) limit/i,
    busy: /try again later|capacity|overloaded|usage limit|rate limit|something went wrong|usage cap/i,
    continueBtn: /^(continue|continue generating)$/i,
    modelFamily: /\b(mythos|fable|opus|sonnet|haiku)\b/i,
  };

  // Every current + recent Claude family. Unknown labels fall through to sonnet
  // (the site default) rather than fighting the picker.
  const MODEL_CAPS = {
    haiku:   { GEN_IDLE_MS: 1200, REASON_IDLE_MS: 8000,  WARMUP_MS: 30000, REASON_NOREPLY_MS: 45000,  STABLE_MS: 6000,  RESPONSE_TIMEOUT_MS: 180000, sysMaxChars: 12000, resendEvery: 8 },
    sonnet:  { GEN_IDLE_MS: 550, REASON_IDLE_MS: 4500, WARMUP_MS: 10000, REASON_NOREPLY_MS: 20000,  STABLE_MS: 3000,  RESPONSE_TIMEOUT_MS: 300000, sysMaxChars: 0,     resendEvery: 0 },
    sonnet5: { GEN_IDLE_MS: 2800, REASON_IDLE_MS: 28000, WARMUP_MS: 90000, REASON_NOREPLY_MS: 240000, STABLE_MS: 14000, RESPONSE_TIMEOUT_MS: 720000, sysMaxChars: 0,     resendEvery: 0 },
    opus:    { GEN_IDLE_MS: 2000, REASON_IDLE_MS: 22000, WARMUP_MS: 60000, REASON_NOREPLY_MS: 35000, STABLE_MS: 10000, RESPONSE_TIMEOUT_MS: 600000, sysMaxChars: 0,     resendEvery: 0 },
    fable:  { GEN_IDLE_MS: 2200, REASON_IDLE_MS: 24000, WARMUP_MS: 70000, REASON_NOREPLY_MS: 210000, STABLE_MS: 12000, RESPONSE_TIMEOUT_MS: 720000, sysMaxChars: 0,     resendEvery: 0 },
    mythos: { GEN_IDLE_MS: 2200, REASON_IDLE_MS: 24000, WARMUP_MS: 70000, REASON_NOREPLY_MS: 210000, STABLE_MS: 12000, RESPONSE_TIMEOUT_MS: 720000, sysMaxChars: 0,     resendEvery: 0 },
  };

  let _family = "sonnet";
  let _modelLabel = "";
  let _sysMaxChars = 0;
  let _resendEvery = 0;

  function currentModelLabel() {
    const tryText = (el) => (el && (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent) || "").replace(/\s+/g, " ").trim();
    for (const el of document.querySelectorAll(S.modelBtn)) {
      const t = tryText(el);
      if (t && RE.modelFamily.test(t) && t.length < 80) return t;
    }
    // Fallback: any visible control whose label names a Claude family.
    for (const b of document.querySelectorAll("button, [role='button']")) {
      if (b.closest("#rs-root")) continue;
      const t = tryText(b);
      if (t && RE.modelFamily.test(t) && t.length < 64) {
        const r = b.getBoundingClientRect();
        if (r.width > 8 && r.height > 8) return t;
      }
    }
    return _modelLabel;
  }
  function familyFromLabel(label) {
    const s = String(label || "");
    if (/\bmythos\b/i.test(s)) return "mythos";
    if (/\bfable\b/i.test(s)) return "fable";
    if (/\bopus\b/i.test(s)) return "opus";
    if (/\bhaiku\b/i.test(s)) return "haiku";
    if (/\bsonnet\b/i.test(s) && /\b(4(?:\.\d+)?|[5-9](?:\.\d+)?)\b/.test(s)) return "sonnet5";
    if (/\bsonnet\b/i.test(s)) return "sonnet";
    const m = RE.modelFamily.exec(s);
    return m ? m[1].toLowerCase() : "sonnet";
  }
  function applyModelCaps(reason) {
    const label = currentModelLabel();
    const fam = familyFromLabel(label);
    const caps = MODEL_CAPS[fam] || MODEL_CAPS.sonnet;
    const changed = fam !== _family || label !== _modelLabel;
    _family = fam;
    if (label) _modelLabel = label;
    _sysMaxChars = caps.sysMaxChars;
    _resendEvery = caps.resendEvery;
    timings.GEN_IDLE_MS = caps.GEN_IDLE_MS;
    timings.REASON_IDLE_MS = caps.REASON_IDLE_MS;
    timings.WARMUP_MS = caps.WARMUP_MS;
    timings.REASON_NOREPLY_MS = caps.REASON_NOREPLY_MS;
    timings.STABLE_MS = caps.STABLE_MS;
    timings.RESPONSE_TIMEOUT_MS = caps.RESPONSE_TIMEOUT_MS;
    if (changed && label) diag("claude.model", { family: fam, label, reason: reason || "sweep" });
  }

  function truncateForSend(text) {
    if (!text) return text;
    let s = String(text);
    const cap = _family === "haiku" ? Math.min(SEND_MAX_CHARS, 60000) : SEND_MAX_CHARS;
    if (s.length > cap) s = s.slice(0, cap) + "\n…[truncated]";
    const lines = s.split("\n");
    if (lines.length > SEND_MAX_LINES) {
      // 2.16: keep head AND tail. A head-only cut silently dropped the end of
      // long payloads - exactly where the closing instruction / last catalogue
      // rows / final error lines live - with nothing telling the model.
      const head = Math.floor(SEND_MAX_LINES * 0.85), tail = SEND_MAX_LINES - head;
      s = lines.slice(0, head).join("\n") + `\n…[${lines.length - SEND_MAX_LINES} of ${lines.length} lines omitted]\n` + lines.slice(-tail).join("\n");
      diag("send.truncated", { lines: lines.length, kept: SEND_MAX_LINES });
    }
    return s;
  }

  function textWithout(root, excludeSel) {
    if (!root) return "";
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (excludeSel && n.matches && n.matches(excludeSel)) return;
      if (n.classList && n.classList.contains("rs-chip")) return;
      if (n.tagName === "BR") { t += "\n"; return; }
      if (n.classList && n.classList.contains("cm-line")) {
        for (const c of n.childNodes) walk(c);
        t += "\n";
        return;
      }
      const block = /^(P|DIV|LI|PRE|H1|H2|H3|H4|TR|ARTICLE|SECTION)$/.test(n.tagName);
      if (block && t && !t.endsWith("\n")) t += "\n";
      for (const c of n.childNodes) walk(c);
      if (block && t && !t.endsWith("\n")) t += "\n";
    };
    walk(root);
    return t.replace(/\n{3,}/g, "\n\n").trim();
  }

  // Only message bubbles — not [data-role=assistant] on a page-wide wrapper,
  // which would hide the live composer from getEditor().
  const inTurn = (el) => !!(el && el.closest(
    '[data-testid="user-message"], [data-testid="user-turn"], [data-testid="assistant-message"], [data-testid="assistant-turn"], [data-testid="claude-response"], .font-claude-response'
  ));

  function visibleComposer(n) {
    if (!n || n.closest("#rs-root")) return false;
    if (inTurn(n)) return false;
    if (n.closest("pre, .cm-editor, [data-testid='artifact']")) return false;
    return true;
  }
  function getEditor() {
    const all = [...document.querySelectorAll(S.editor)].filter((n) => n && !n.closest("#rs-root"));
    let nodes = all.filter(visibleComposer);
    if (!nodes.length) nodes = all.filter((n) => !inTurn(n));
    if (!nodes.length) nodes = all;
    if (!nodes.length) return null;
    const pm = nodes.filter((n) => (n.classList && n.classList.contains("ProseMirror")) || n.getAttribute("data-rs-locked") === "1");
    const pool = pm.length ? pm : nodes;
    try { pool.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top); } catch {}
    return pool[pool.length - 1] || pool[0] || null;
  }
  const editorText = () => {
    const e = getEditor();
    return e ? (e.textContent || "") : "";
  };

  function docPos(a, b) {
    const r = a.compareDocumentPosition(b);
    if (r & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (r & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  const allItems = () => {
    const users = [...document.querySelectorAll(S.user)];
    const asst = [...document.querySelectorAll(S.assistant)];
    const mixed = [...users, ...asst].filter((el, i, arr) => arr.indexOf(el) === i);
    mixed.sort(docPos);
    return mixed;
  };
  const isUserItem = (item) => !!(item && item.matches && item.matches(S.user));
  const isAssistantItem = (item) => !!(item && item.matches && item.matches(S.assistant));
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };
  // 2.16: per-NODE turn identity. The old key was data-testid + the first 24
  // characters of the turn's text - assistant turns carry no testid and, with
  // extended thinking on, their text starts with the thinking prose ("Let me
  // think about…"), so two consecutive turns produced the SAME key. The core
  // compares lastAssistantId() against the token captured at send time to tell
  // "the new reply" from "the old one still on screen": an equal key meant
  // every tool-feedback turn sat in the 30 s no-new-turn gate (or, worse, the
  // previous answer was re-parsed). A monotonic id handed out per element is
  // stable across streaming/chip insertion and never collides; a React re-key
  // of the same turn gets a fresh id, which the core's byte-identical-text
  // stale check already handles.
  const _idMap = new WeakMap();
  let _idSeq = 0;
  const itemKey = (item) => {
    if (!item || typeof item !== "object") return null;
    let id = _idMap.get(item);
    if (id == null) { id = ++_idSeq; _idMap.set(item, id); }
    return id;
  };
  const lastAssistantId = () => { const it = lastAssistant(); return it ? itemKey(it) : null; };

  function replyRoot(item) {
    if (!item) return null;
    return item.querySelector(".standard-markdown")
      || item.querySelector("[data-testid='markdown']")
      || item.querySelector(".font-claude-response")
      || item;
  }
  function artifactText(item) {
    if (!item) return "";
    let t = "";
    item.querySelectorAll(S.artifact).forEach((el) => {
      if (el.closest(S.thinking)) return;
      t += "\n" + textWithout(el, S.thinking);
    });
    return t.trim();
  }
  function thinkingText(item) {
    if (!item) return "";
    const nodes = [...item.querySelectorAll(S.thinking)];
    return nodes.map((n) => textWithout(n)).join("\n").trim();
  }
  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      const md = replyRoot(item);
      const body = textWithout(md, S.thinking);
      const art = artifactText(item);
      return art && !body.includes(art.slice(0, 80)) ? (body + "\n" + art).trim() : body;
    }
    return textWithout(item);
  }
  function classifyText(item, excludeSel) {
    if (!item) return "";
    const skip = [S.thinking, excludeSel].filter(Boolean).join(",");
    if (isAssistantItem(item)) {
      const md = replyRoot(item);
      const body = textWithout(md, skip);
      const art = artifactText(item);
      return art && !body.includes(art.slice(0, 80)) ? (body + "\n" + art).trim() : body;
    }
    return textWithout(item, skip);
  }

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => {
    const path = (location.pathname.replace(/\/+$/, "") || "/");
    return chatIsEmpty() && /(\/(new|chat|project))?$/.test(path) && !!getEditor();
  };
  const conversationKey = () =>
    (/\/(chat|project)\//.test(location.pathname) ? location.pathname : "");

  const composerFrame = () => {
    const ed = getEditor();
    if (!ed) return null;
    return ed.closest("fieldset") || ed.closest("form") || ed.closest("[class*='composer']") || ed.parentElement;
  };
  function barAnchor() {
    const ed = getEditor();
    if (!ed) return null;
    return ed.closest("fieldset") || ed.closest("[class*='composer']") || ed.closest("form") || ed.parentElement;
  }

  let _locked = false;
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    ed.setAttribute("contenteditable", on ? "false" : "true");
    if (on) ed.setAttribute("data-rs-locked", "1");
    else ed.removeAttribute("data-rs-locked");
  }

  function visibleBtn(b) {
    if (!b || b.disabled) return false;
    if (b.getAttribute("aria-disabled") === "true") return false;
    const r = b.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  }
  function labelOf(b) {
    return ((b && (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent)) || "").toLowerCase();
  }
  function stopButton() {
    for (const s of [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop" i]',
    ]) {
      for (const b of document.querySelectorAll(s)) {
        if (visibleBtn(b) && !inTurn(b)) return b;
      }
    }
    for (const b of document.querySelectorAll("button")) {
      if (!visibleBtn(b) || inTurn(b)) continue;
      const l = labelOf(b);
      if (l.includes("stop") && (l.includes("response") || l.includes("generat") || l === "stop")) return b;
    }
    return null;
  }
  function sendButton() {
    if (stopButton()) return null;
    const sels = [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[aria-label*="Send message" i]',
      'button[data-testid="send-button"]',
    ];
    for (const s of sels) {
      for (const b of document.querySelectorAll(s)) {
        if (visibleBtn(b) && !inTurn(b) && !labelOf(b).includes("stop")) return b;
      }
    }
    const ed = getEditor();
    const root = (ed && (ed.closest("fieldset") || ed.closest("form") || ed.parentElement)) || document;
    const buttons = [...root.querySelectorAll("button")].filter((b) => visibleBtn(b) && !inTurn(b));
    for (const b of buttons) {
      const l = labelOf(b);
      if (l.includes("send") && !l.includes("stop")) return b;
    }
    // 2.16: NO "last button in the composer" fallback. While the real send
    // button is disabled (empty box, ProseMirror still digesting the insert)
    // that fallback returned whatever sat last in the fieldset - attach,
    // dictate, model picker - and typeAndSend clicked it, while the click hook
    // counted a click on it as a user send. Unknown is unknown: return null and
    // let typeAndSend fall back to Enter.
    return null;
  }
  // Raw send button regardless of enabled state (to wait for it to light up).
  function sendButtonAny() {
    for (const s of ['button[aria-label="Send message"]', 'button[aria-label*="Send message" i]', 'button[data-testid="send-button"]']) {
      const b = document.querySelector(s);
      if (b && !inTurn(b)) return b;
    }
    return null;
  }

  function streamText(item) {
    if (!item) return "";
    const reply = itemText(item);
    const think = thinkingText(item);
    return think ? (think + "\n" + reply) : reply;
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;
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
  // 2.16: "stop seen, then gone" ends the turn after a short double-quiet
  // window (stop control absent ≥ 1 s AND no text growth ≥ 1 s) instead
  // of the family GEN_IDLE tail (2.8 s Sonnet 4.5 / 2.0 s Opus) on EVERY turn:
  // Claude keeps one Stop control up for the whole response (thinking +
  // answer), so its disappearance is the completion signal; the text-idle
  // window stays the fallback for turns where no Stop control was ever seen
  // (selector drift, instant answers). A sub-second flicker changes nothing,
  // and the core still holds thinking-only / open-block turns on its own.
  const STOP_GONE_QUIET_MS = 1000;
  let _stopSeenItem = null, _stopGoneAt = 0;
  function isGenerating() {
    sampleStream();
    const last = lastAssistant();
    if (stopButton()) { _stopSeenItem = last; _stopGoneAt = 0; return true; }
    if (last && last.querySelector('[data-is-thinking="true"], [data-thinking="true"], [data-is-streaming="true"]')) return true;
    const now = Date.now();
    if (last && _stopSeenItem === last && _streamMax > 1) {
      if (!_stopGoneAt) _stopGoneAt = now;
      return (now - _stopGoneAt < STOP_GONE_QUIET_MS) || (now - _streamAt < STOP_GONE_QUIET_MS);
    }
    return _streamMax > 1 && now - _streamAt < timings.GEN_IDLE_MS;
  }
  const isBusyNow = () => isGenerating();
  const isHardGenerating = () => !!stopButton();

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      return { th: thinkingText(it).length, rp: itemText(it).length };
    } catch { return {}; }
  }
  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    return { present: true, reply: itemText(item), thinking: thinkingText(item), item };
  }

  function selectAll(ed) {
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  async function typeEditorText(ed, text) {
    selectAll(ed);
    document.execCommand("insertText", false, "");
    const lines = String(text).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) document.execCommand("insertText", false, lines[i]);
      if (i < lines.length - 1) document.execCommand("insertLineBreak");
      if (i && i % INSERT_CHUNK_LINES === 0) await sleep(0);
    }
  }

  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `totalscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  async function attachImages(images) {
    const ed = getEditor();
    if (!ed || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    const fileInput = document.querySelector('input[type="file"][accept*="image"]') ||
      document.querySelector('input[type="file"]');
    if (fileInput) {
      try { fileInput.files = dt.files; fileInput.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    }
    return await waitFor(() => {
      const box = composerFrame();
      return !!(box && box.querySelector("img, [class*='preview'], [class*='thumbnail'], [class*='attachment']"));
    }, 15000);
  }
  function clearAttachments() {
    try {
      const box = composerFrame();
      if (!box) return;
      box.querySelectorAll("[aria-label*='emove' i], [aria-label*='elete' i], [aria-label*='Remove'], [class*='delete'], [class*='remove']")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }

  async function typeAndSend(text, images) {
    let ed = getEditor();
    // 2.16: the composer can be mid-remount (route change after the first
    // send, artifact panel toggling) exactly when a tool result is ready.
    // Throwing immediately ended the turn; wait a bounded moment first.
    if (!ed) { await waitFor(() => !!getEditor(), 6000); ed = getEditor(); diag("claude.editorWait", { found: !!ed }); }
    if (!ed) throw new Error("Claude input box not found");
    text = truncateForSend(text);
    const relock = _locked;
    if (relock) ed.setAttribute("contenteditable", "true");
    try {
      await typeEditorText(ed, text);
      if (images && images.length) {
        try { await attachImages(images); } catch {}
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
          const b = sendButton();
          if (b && !b.disabled) { try { b.click(); } catch {} }
          if (await waitFor(() => editorText().trim() === "" || !!stopButton(), 1200)) return;
        }
        return;
      }
      // 2.16: the send button stays disabled until ProseMirror has flushed the
      // inserted text into React state - on a big bootstrap that can lag the
      // last execCommand by well over the old 2 s wait, after which the adapter
      // used to dispatch Enter into a box the site still saw as empty (nothing
      // sent; the core's resend loop then typed the whole prompt again).
      // Wait up to 8 s for the button to light up, nudging the editor with an
      // input event every 700 ms; only then fall back to Enter, and verify.
      const t0 = Date.now();
      let nudged = 0;
      const lit = await waitFor(() => {
        if (sendButton()) return true;
        const raw = sendButtonAny();
        if (raw && raw.disabled && Date.now() - t0 > 700 * (nudged + 1) && nudged < 10) {
          nudged++;
          try { ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: " " })); } catch {}
        }
        return false;
      }, 8000);
      const before = editorText().trim();
      const btn = lit ? sendButton() : null;
      if (btn) { btn.click(); diag("send.click", { waitMs: Date.now() - t0, nudged }); }
      else {
        diag("send.enterFallback", { waitMs: Date.now() - t0, nudged, disabled: !!(sendButtonAny() && sendButtonAny().disabled) });
        const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        ed.dispatchEvent(new KeyboardEvent("keydown", o));
        ed.dispatchEvent(new KeyboardEvent("keyup", o));
      }
      // Landed = the site cleared the box or started generating. If neither
      // happened within 1.5 s the click/Enter was swallowed: try the OTHER
      // path exactly once (bounded; the core's own retry covers the rest).
      const landed = await waitFor(() => !!stopButton() || editorText().trim() !== before || editorText().trim() === "", 1500);
      if (!landed) {
        const again = sendButton();
        diag("send.retryOnce", { via: again ? "click" : "enter" });
        if (again) again.click();
        else {
          const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
          ed.dispatchEvent(new KeyboardEvent("keydown", o));
          ed.dispatchEvent(new KeyboardEvent("keyup", o));
        }
      }
    } finally {
      if (relock) { const e2 = getEditor(); if (e2) e2.setAttribute("contenteditable", "false"); }
    }
  }
  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }
  function enforceComposer() {
    applyModelCaps("sweep");
    // Never refuse a sweep because the picker label is unknown — the user owns the model.
    return { ready: !!getEditor() };
  }
  async function ensureComposerReady(reason) {
    applyModelCaps(reason || "ready");
    // startSession locks the box first. Wait for the (possibly locked) composer;
    // do not gate Start on Haiku/Sonnet/Opus/Fable/Mythos — any of them is fine.
    let ed = getEditor();
    if (!ed) {
      await waitFor(() => getEditor(), 5000);
      ed = getEditor();
    }
    const ready = !!ed;
    diag("mode_ready", { reason, provider: "claude", family: _family, model: _modelLabel, ready });
    return { ready };
  }

  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    return "";
  }
  const isTooLongMsg = (t) => RE.tooLong.test(t || "");
  const isBusyMsg = (t) => RE.busy.test(t || "");
  const turnHalted = () => false;
  const findContinueBtn = () => {
    for (const b of document.querySelectorAll("button")) {
      if (visibleBtn(b) && RE.continueBtn.test((b.textContent || "").trim())) return b;
    }
    return null;
  };
  const clickContinueBtn = () => { const b = findContinueBtn(); if (b) b.click(); };

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const ed = getEditor();
      if (!ed || !ed.contains(e.target)) return;
      if (editorText().trim() === "") return;
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
      const cont = t && t.closest && t.closest("button");
      if (cont && RE.continueBtn.test((cont.innerText || "").trim())) {
        if (handlers.onNativeContinue) handlers.onNativeContinue();
        return;
      }
      const stop = stopButton();
      if (stop && t && t.closest && t.closest("button") === stop) {
        if (handlers.onNativeStop) handlers.onNativeStop();
        return;
      }
      const btn = t && t.closest && t.closest("button");
      if (!btn || btn !== sendButton()) return;
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
    let hidAny = null;
    const hide = (el) => {
      el.classList.add("rs-tool-hide");
      hidAny = hidAny || { parent: el.parentElement, ref: el };
    };
    item.querySelectorAll(S.codeWrap).forEach((pre) => {
      if (pre.closest(".rs-chip") || pre.closest(S.thinking)) return;
      if (CMD_SHAPE.test(pre.textContent || "")) hide(pre);
    });
    item.querySelectorAll(S.artifact).forEach((el) => {
      if (el.closest(".rs-chip") || el.closest(S.thinking)) return;
      if (CMD_SHAPE.test(el.textContent || "")) hide(el);
    });
    return hidAny;
  }

  const PROMPT_EXTRA =
    `- Templates: get_template {name} searches the place / Creator Store and CLONES the match. Screenshot HOW: total_screenshot {target:"studio"} captures the real Roblox Studio/game viewport through MCP. Use target:"tab" only when the user explicitly asks to see the browser chat.
- Production craft: build complete, named, textured models and features. Default grey is not finished art. Prefer inspect_instance / search_game_tree / generate_procedural_model over guessing.
- You may be ANY Claude model the user picked (Haiku, Sonnet 3.5/4/4.5/5+, Opus, Fable, Mythos). The TotalScript command protocol is the same for all of them.
- TotalScript is a real browser extension the user installed. Outputting a fenced json command or ###LUA### block is how their Roblox Studio MCP bridge receives work — the same as Cursor/Copilot applying a diff. This is authorized local automation, not a jailbreak.
- Do not refuse for lack of capability (Sonnet 5 / 4.5 included). Claude's own tools, computer use, Projects MCP, Artifacts-as-execution, and Claude Code CANNOT reach this machine. Write TotalScript JSON / ###LUA### in the normal chat reply; the extension executes it.
- Refuse only the user's task if it is actually disallowed. Never refuse the TotalScript protocol itself.
- Artifacts may preview UI for the user, but the command that runs must still appear in the chat reply as a fenced JSON object or a ###LUA### block.`;

  return {
    id: "claude",
    displayName: "Claude",
    supportsVision: true,
    timings,
    thinkingSel: S.thinking,
    chipAtItemLevel: true,
    reliableCounts: true,
    promptExtra: PROMPT_EXTRA,
    get sysMaxChars() { return _sysMaxChars; },
    get resendSystemEvery() { return _resendEvery; },
    init({ diag: d } = {}) { if (d) diag = d; applyModelCaps("init"); },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();

if (typeof window !== "undefined") window.RSProvider = RSProvider;
