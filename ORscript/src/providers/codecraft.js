// SPDX-License-Identifier: GPL-3.0-or-later
// CodeCraft API (https://codecraftapi.com) — ORscript's own chat surface.
//
// CodeCraft is an OpenAI-compatible API (no web chat page exists), so this
// provider is different from the DOM adapters: it OWNS the page. The
// extension ships `codecraft.html`, a minimal transcript + composer that loads
// the usual bundle (config → skills → this provider → main.js). The adapter
// below renders user/assistant rows into that transcript and streams
// `POST /v1/chat/completions` (SSE) into the assistant row, so the core's
// DOM-based contract (allItems / readAssistant / isGenerating / typeAndSend)
// works exactly as on a hosted chat site.
//
// Credentials: the user's `cc_…` key is kept in chrome.storage.local
// (`rsCodeCraft`) and is only ever sent to codecraftapi.com. Nothing is
// proxied through ORscript servers (there are none).
const RSProvider = (() => {
  let diag = () => {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const API_BASE = "https://codecraftapi.com/v1";
  const SITE = "https://codecraftapi.com";
  const STORE_KEY = "rsCodeCraft";
  const DEFAULT_MODEL = "claude-opus-4.8";
  // Shown before /models answers (or when the key is missing). The live list
  // replaces it as soon as a key is saved.
  const FALLBACK_MODELS = [
    "claude-opus-4.8", "claude-sonnet-5", "claude-opus-5", "gpt-5.6-terra", "gpt-5.6-luna",
    "gemini-3.1-pro", "gemini-3.7-flash", "deepseek-v4-pro-max", "deepseek-v4-flash-0731",
    "kimi-k3", "kimi-k2.6", "qwen3.8-max", "glm-5.3", "grok-4.6", "seed-2.1-pro",
  ];
  // Total characters of history sent per request (1M-context models cope with
  // far more, but every token is billed against the user's plan).
  const HISTORY_CHAR_BUDGET = 480000;
  const IMAGE_TURNS = 2;
  const SEND_MAX = 200000;

  const timings = {
    GEN_IDLE_MS: 700,
    REASON_IDLE_MS: 5000,
    WARMUP_MS: 15000,
    REASON_NOREPLY_MS: 60000,
    STABLE_MS: 2500,
    RESPONSE_TIMEOUT_MS: 420000,
  };

  const RE = {
    tooLong: /context[_ ]length|maximum context|context window|too many tokens|reduce the length|prompt is too long|exceeds the (model'?s )?(maximum|limit)|max_tokens|input too (long|large)/i,
    busy: /rate ?limit|too many requests|\b429\b|\b5\d\d\b|overloaded|temporarily unavailable|try again later|capacity|timed? ?out|network error|failed to fetch/i,
    quota: /\b402\b|insufficient (balance|tokens|credits)|out of tokens|quota|payment required|upgrade your plan/i,
    auth: /\b401\b|invalid (api )?key|unauthori[sz]ed|authentication|forbidden|\b403\b/i,
    continueBtn: /^(continue|continue generating|keep going)$/i,
  };

  // ---------- settings ----------
  // 1.36.0: generation settings + page preferences live in the same record.
  const settings = { key: "", model: DEFAULT_MODEL, temperature: null, maxTokens: null, reasoning: "", instructions: "", autoRetry: true, ctrlEnter: false, showMeta: true, sideCollapsed: false };
  const SETTING_KEYS = ["key", "model", "temperature", "maxTokens", "reasoning", "instructions", "autoRetry", "ctrlEnter", "showMeta", "sideCollapsed"];
  const CHAT_INDEX_KEY = "rsCodeCraftChats";
  const CHAT_KEY_PREFIX = "rsCodeCraftChat:";
  const USAGE_KEY = "rsCodeCraftUsage";
  const MAX_SAVED_CHATS = 200;
  const hasChromeStorage = () => { try { return !!(window.chrome && chrome.storage && chrome.storage.local); } catch { return false; } };
  async function loadSettings() {
    try {
      if (hasChromeStorage()) {
        const got = await new Promise((res) => { try { chrome.storage.local.get(STORE_KEY, (v) => res(v || {})); } catch { res({}); } });
        Object.assign(settings, got[STORE_KEY] || {});
      } else if (window.localStorage) {
        Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || "{}"));
      }
    } catch {}
    if (!settings.model) settings.model = DEFAULT_MODEL;
    return settings;
  }
  async function saveSettings(patch) {
    Object.assign(settings, patch || {});
    try {
      const rec = {}; for (const k of SETTING_KEYS) rec[k] = settings[k];
      if (hasChromeStorage()) await new Promise((res) => chrome.storage.local.set({ [STORE_KEY]: rec }, res));
      else if (window.localStorage) localStorage.setItem(STORE_KEY, JSON.stringify(rec));
    } catch {}
  }
  // Generic key/value storage for the chat library (chrome.storage.local on the
  // extension page, localStorage when the provider runs elsewhere).
  function storeGet(key) {
    return new Promise((res) => {
      try {
        if (hasChromeStorage()) { chrome.storage.local.get(key, (v) => res(v && v[key] != null ? v[key] : null)); return; }
        if (window.localStorage) { const raw = localStorage.getItem(key); res(raw ? JSON.parse(raw) : null); return; }
      } catch {}
      res(null);
    });
  }
  function storeSet(key, value) {
    return new Promise((res) => {
      try {
        if (hasChromeStorage()) { chrome.storage.local.set({ [key]: value }, () => res(true)); return; }
        if (window.localStorage) { localStorage.setItem(key, JSON.stringify(value)); res(true); return; }
      } catch {}
      res(false);
    });
  }
  function storeRemove(key) {
    return new Promise((res) => {
      try {
        if (hasChromeStorage()) { chrome.storage.local.remove(key, () => res(true)); return; }
        if (window.localStorage) { localStorage.removeItem(key); res(true); return; }
      } catch {}
      res(false);
    });
  }
  const hasKey = () => /^cc_[A-Za-z0-9_-]{16,}$/.test(String(settings.key || "").trim()) || String(settings.key || "").trim().length >= 24;
  const maskKey = (k) => (k && k.length > 10 ? k.slice(0, 5) + "…" + k.slice(-4) : k ? "cc_…" : "");

  // ---------- DOM refs (resolved lazily; the IIFE never touches the DOM at load) ----------
  const $ = (id) => { try { return document.getElementById(id); } catch { return null; } };
  const ui = {
    get app() { return $("cc-app"); },
    get log() { return $("cc-log"); },
    get form() { return $("cc-form"); },
    get input() { return $("cc-input"); },
    get send() { return $("cc-send"); },
    get stop() { return $("cc-stop"); },
    get model() { return $("cc-model"); },
    get key() { return $("cc-key"); },
    get keySave() { return $("cc-key-save"); },
    get status() { return $("cc-status"); },
    get newChat() { return $("cc-new"); },
    get empty() { return $("cc-empty"); },
    get composer() { return $("cc-composer"); },
    get attach() { return $("cc-attach"); },
    get attachList() { return $("cc-attachments"); },
    get fileInput() { return $("cc-file"); },
    // 1.36.0 additions (all optional: the provider works without them).
    get side() { return $("cc-side"); },
    get sideToggle() { return $("cc-side-toggle"); },
    get sideNew() { return $("cc-side-new"); },
    get search() { return $("cc-search"); },
    get chats() { return $("cc-chats"); },
    get usage() { return $("cc-usage"); },
    get usageTotal() { return $("cc-usage-total"); },
    get usageReset() { return $("cc-usage-reset"); },
    get importBtn() { return $("cc-import"); },
    get importFile() { return $("cc-import-file"); },
    get clearAll() { return $("cc-clear-all"); },
    get modelLogo() { return $("cc-model-logo"); },
    get settingsBtn() { return $("cc-settings-btn"); },
    get settingsPanel() { return $("cc-settings"); },
    get settingsClose() { return $("cc-settings-close"); },
    get exportBtn() { return $("cc-export"); },
    get temp() { return $("cc-temp"); },
    get tempOut() { return $("cc-temp-out"); },
    get tempReset() { return $("cc-temp-reset"); },
    get maxTokens() { return $("cc-max-tokens"); },
    get reasoning() { return $("cc-reasoning"); },
    get instructions() { return $("cc-instructions"); },
    get autoRetry() { return $("cc-auto-retry"); },
    get ctrlEnter() { return $("cc-ctrl-enter"); },
    get showMeta() { return $("cc-show-meta"); },
    get jump() { return $("cc-jump"); },
    get drop() { return $("cc-drop"); },
  };
  const isHostPage = () => !!ui.log && !!ui.input;

  // ---------- session / transcript ----------
  const sess = { id: "", messages: [], seq: 0, title: "", createdAt: 0, usage: { prompt: 0, completion: 0, total: 0, requests: 0 } };
  const newId = () => "cc" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const sessKey = () => "cc:" + sess.id;
  // Chat library index: [{ id, title, createdAt, updatedAt, model, pinned, count, preview }]
  let chatIndex = [];
  let indexLoaded = false;
  const BOOTSTRAP_RE = /CodeCraft API rules|ORscript|list_commands|command catalogue/i;
  function deriveTitle() {
    if (sess.title) return sess.title;
    for (const m of sess.messages) {
      if (m.role !== "user") continue;
      const t = String(m.content || "").trim();
      if (!t) continue;
      if (t.length > 600 || (BOOTSTRAP_RE.test(t) && t.length > 200)) continue;
      return t.replace(/\s+/g, " ").slice(0, 64);
    }
    const agent = sess.messages.some((m) => m.role === "user" && BOOTSTRAP_RE.test(m.content || ""));
    return agent ? "ORscript agent session" : "New chat";
  }
  function slimMessages() {
    // Pixels are not persisted (sessionStorage is ~5 MB; one screenshot can be
    // a third of that) - a reload keeps the text and notes the attachment.
    return sess.messages.map((m) => ({ role: m.role, content: m.content, thinking: m.thinking || "", imageCount: (m.images || []).length, error: m.error || "", at: m.at || 0, model: m.model || "", meta: m.meta || null, truncated: !!m.truncated }));
  }
  let _persistTimer = 0;
  function persist() {
    try {
      const slim = slimMessages();
      let json = JSON.stringify(slim);
      if (window.sessionStorage) {
        try { sessionStorage.setItem(sessKey(), json); }
        catch {
          // Quota: drop the oldest half of the transcript (keep the bootstrap).
          const half = slim.length > 2 ? [slim[0], ...slim.slice(Math.ceil(slim.length / 2))] : slim;
          json = JSON.stringify(half);
          try { sessionStorage.setItem(sessKey(), json); } catch {}
        }
      }
    } catch {}
    // The library copy (chrome.storage.local) is debounced: streaming paints
    // call persist() on every finished turn, not on every token, but a batch
    // of agent turns can still land several times a second.
    try { clearTimeout(_persistTimer); } catch {}
    _persistTimer = setTimeout(() => { persistLibrary().catch(() => {}); }, 500);
  }
  async function persistLibrary() {
    if (!sess.id || !sess.messages.length) return;
    const now = Date.now();
    const title = deriveTitle();
    const entry = chatIndex.find((c) => c.id === sess.id) || null;
    const lastUser = [...sess.messages].reverse().find((m) => m.role === "user" && !(BOOTSTRAP_RE.test(m.content || "") && m.content.length > 200));
    const rec = {
      id: sess.id, title, createdAt: (entry && entry.createdAt) || sess.createdAt || now, updatedAt: now,
      model: settings.model, pinned: !!(entry && entry.pinned), count: sess.messages.length,
      preview: String((lastUser && lastUser.content) || "").replace(/\s+/g, " ").slice(0, 120),
    };
    if (entry) Object.assign(entry, rec); else chatIndex.unshift(rec);
    if (chatIndex.length > MAX_SAVED_CHATS) {
      const drop = chatIndex.filter((c) => !c.pinned).slice(MAX_SAVED_CHATS);
      for (const c of drop) { chatIndex.splice(chatIndex.indexOf(c), 1); storeRemove(CHAT_KEY_PREFIX + c.id).catch(() => {}); }
    }
    await storeSet(CHAT_KEY_PREFIX + sess.id, { id: sess.id, title, messages: slimMessages(), usage: sess.usage, model: settings.model, createdAt: rec.createdAt, updatedAt: now });
    await storeSet(CHAT_INDEX_KEY, chatIndex);
    renderChats();
    try { document.title = (title === "New chat" ? "CodeCraft API" : title) + " — CodeCraft · ORscript"; } catch {}
  }
  async function loadIndex() {
    if (indexLoaded) return chatIndex;
    const idx = await storeGet(CHAT_INDEX_KEY);
    chatIndex = Array.isArray(idx) ? idx.filter((c) => c && c.id) : [];
    indexLoaded = true;
    return chatIndex;
  }
  const sortedChats = () => chatIndex.slice().sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  function relTime(ts) {
    const d = Date.now() - (ts || 0);
    if (!ts || d < 0) return "";
    if (d < 60e3) return "just now";
    if (d < 3600e3) return Math.round(d / 60e3) + " min ago";
    if (d < 86400e3) return Math.round(d / 3600e3) + " h ago";
    if (d < 7 * 86400e3) return Math.round(d / 86400e3) + " d ago";
    try { return new Date(ts).toLocaleDateString(); } catch { return ""; }
  }
  let _search = "";
  function renderChats() {
    const box = ui.chats;
    if (!box) return;
    const q = _search.trim().toLowerCase();
    const list = sortedChats().filter((c) => !q || (c.title + " " + (c.preview || "")).toLowerCase().includes(q));
    if (!list.length) {
      box.innerHTML = `<div class="cc-chats-empty">${q ? "No chat matches “" + esc(_search) + "”." : "No saved chats yet — your conversations appear here."}</div>`;
      return;
    }
    box.innerHTML = list.map((c) => `<div class="cc-chat${c.id === sess.id ? " cc-chat-active" : ""}${c.pinned ? " cc-chat-pinned" : ""}" role="listitem" data-chat-id="${esc(c.id)}" title="${esc(c.preview || c.title)}">
      <button type="button" class="cc-chat-open" data-chat-open="${esc(c.id)}">
        <span class="cc-chat-title">${c.pinned ? "📌 " : ""}${esc(c.title || "New chat")}</span>
        <span class="cc-chat-meta">${esc(relTime(c.updatedAt))}${c.model ? " · " + esc(c.model) : ""}${c.count ? " · " + c.count + " msgs" : ""}</span>
      </button>
      <span class="cc-chat-actions">
        <button type="button" class="cc-chat-act" data-chat-pin="${esc(c.id)}" title="${c.pinned ? "Unpin" : "Pin to top"}" aria-label="${c.pinned ? "Unpin" : "Pin"}">${c.pinned ? "📍" : "📌"}</button>
        <button type="button" class="cc-chat-act" data-chat-rename="${esc(c.id)}" title="Rename" aria-label="Rename">✎</button>
        <button type="button" class="cc-chat-act cc-chat-del" data-chat-delete="${esc(c.id)}" title="Delete" aria-label="Delete">🗑</button>
      </span>
    </div>`).join("");
  }
  function renderUsage() {
    const u = sess.usage || {};
    if (ui.usage) ui.usage.textContent = u.total ? `This chat: ${fmtTokens(u.total)} tokens · ${u.requests} request${u.requests === 1 ? "" : "s"}` : "This chat: no tokens used yet";
    if (ui.usageTotal) { const t = _usageTotal || {}; ui.usageTotal.textContent = t.total ? `${fmtTokens(t.total)} tokens · ${t.requests} requests${t.byModel ? " · top: " + topModels(t.byModel) : ""}` : "No usage recorded yet"; }
  }
  const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : String(n || 0));
  const topModels = (by) => Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${m} ${fmtTokens(n)}`).join(", ");
  let _usageTotal = null;
  async function recordUsage(u, model) {
    if (!u) return;
    const total = Number(u.total_tokens || 0) || (Number(u.prompt_tokens || 0) + Number(u.completion_tokens || 0));
    sess.usage.prompt += Number(u.prompt_tokens || 0);
    sess.usage.completion += Number(u.completion_tokens || 0);
    sess.usage.total += total;
    sess.usage.requests += 1;
    if (!_usageTotal) _usageTotal = (await storeGet(USAGE_KEY)) || { total: 0, requests: 0, byModel: {} };
    _usageTotal.total += total; _usageTotal.requests += 1;
    _usageTotal.byModel = _usageTotal.byModel || {};
    _usageTotal.byModel[model || "?"] = (_usageTotal.byModel[model || "?"] || 0) + total;
    storeSet(USAGE_KEY, _usageTotal).catch(() => {});
    renderUsage();
  }
  const guardAgent = (what) => {
    if (hooks && hooks.isBlocked()) { status(`ORscript agent is working — ${what} is disabled until its turn finishes (Stop in the bar first)`, "warn"); return false; }
    return true;
  };
  async function openChat(id) {
    if (!id || id === sess.id) return false;
    if (!guardAgent("switching chats")) return false;
    if (_stream) stopGeneration();
    await startSession(id);
    renderChats();
    status(`Opened “${deriveTitle()}”`, "ok");
    if (ui.input) try { ui.input.focus(); } catch {}
    return true;
  }
  async function deleteChat(id) {
    const i = chatIndex.findIndex((c) => c.id === id);
    if (i < 0) return;
    if (!guardAgent("deleting a chat")) return;
    chatIndex.splice(i, 1);
    await storeRemove(CHAT_KEY_PREFIX + id);
    try { sessionStorage.removeItem("cc:" + id); } catch {}
    await storeSet(CHAT_INDEX_KEY, chatIndex);
    if (id === sess.id) { if (_stream) stopGeneration(); sess.title = ""; startSession(newId()); }
    renderChats();
    status("Chat deleted", "ok");
  }
  async function renameChat(id, title) {
    const c = chatIndex.find((x) => x.id === id);
    if (!c) return;
    title = String(title || "").trim().slice(0, 80);
    if (!title) return;
    c.title = title; c.updatedAt = Date.now();
    if (id === sess.id) sess.title = title;
    const rec = await storeGet(CHAT_KEY_PREFIX + id);
    if (rec) { rec.title = title; await storeSet(CHAT_KEY_PREFIX + id, rec); }
    await storeSet(CHAT_INDEX_KEY, chatIndex);
    renderChats();
  }
  async function pinChat(id) {
    const c = chatIndex.find((x) => x.id === id);
    if (!c) return;
    c.pinned = !c.pinned;
    await storeSet(CHAT_INDEX_KEY, chatIndex);
    renderChats();
  }
  async function clearAllChats() {
    if (!guardAgent("clearing the library")) return;
    for (const c of chatIndex) { await storeRemove(CHAT_KEY_PREFIX + c.id); try { sessionStorage.removeItem("cc:" + c.id); } catch {} }
    chatIndex = [];
    await storeSet(CHAT_INDEX_KEY, chatIndex);
    if (_stream) stopGeneration();
    sess.title = "";
    startSession(newId());
    renderChats();
    status("Library cleared", "ok");
  }
  // ---------- export / import ----------
  function toMarkdown() {
    const lines = [`# ${deriveTitle()}`, "", `_CodeCraft API · ${settings.model} · exported ${new Date().toISOString()} · ${sess.messages.length} messages_`, ""];
    for (const m of sess.messages) {
      lines.push(`## ${m.role === "user" ? "You" : (m.model || "Assistant")}${m.at ? " · " + new Date(m.at).toLocaleString() : ""}`, "");
      if (m.thinking) lines.push("<details><summary>Reasoning</summary>", "", m.thinking, "", "</details>", "");
      if (m.images && m.images.length) lines.push(`_${m.images.length} image(s) attached_`, "");
      lines.push(m.content || "", "");
      if (m.error) lines.push(`> ⚠ ${m.error}`, "");
    }
    return lines.join("\n");
  }
  function toJson() {
    return JSON.stringify({ format: "orscript-codecraft-chat", version: 1, id: sess.id, title: deriveTitle(), model: settings.model, exportedAt: Date.now(), usage: sess.usage, messages: slimMessages() }, null, 2);
  }
  function download(name, text, type) {
    try {
      const blob = new Blob([text], { type: type || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 2000);
      return true;
    } catch (e) {
      // No Blob/object URLs (test harness or locked-down profile): put it on the clipboard instead.
      try { navigator.clipboard && navigator.clipboard.writeText(text); } catch {}
      return false;
    }
  }
  const safeName = (t) => String(t || "chat").replace(/[^a-z0-9\-_ ]+/gi, "").trim().replace(/\s+/g, "-").slice(0, 48) || "chat";
  function exportChat(kind) {
    if (!sess.messages.length) { status("Nothing to export yet", "warn"); return false; }
    const name = safeName(deriveTitle());
    const ok = kind === "json" ? download(name + ".json", toJson(), "application/json") : download(name + ".md", toMarkdown(), "text/markdown;charset=utf-8");
    status(ok ? `Exported ${name}.${kind === "json" ? "json" : "md"}` : "Download unavailable — transcript copied to the clipboard instead", ok ? "ok" : "warn");
    return ok;
  }
  async function importChat(json) {
    let rec; try { rec = typeof json === "string" ? JSON.parse(json) : json; } catch { status("That file is not JSON", "err"); return false; }
    const msgs = rec && (Array.isArray(rec.messages) ? rec.messages : Array.isArray(rec) ? rec : null);
    if (!msgs || !msgs.length) { status("No messages found in that file", "err"); return false; }
    if (!guardAgent("importing")) return false;
    if (_stream) stopGeneration();
    const id = newId();
    sess.id = id; sess.title = String(rec.title || "").slice(0, 80); sess.createdAt = Date.now(); sess.usage = { prompt: 0, completion: 0, total: 0, requests: 0 };
    setHash(); clearTranscript();
    for (const m of msgs) {
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      pushMessage({ role: m.role, content: String(m.content == null ? "" : (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || "").join("") : JSON.stringify(m.content))), thinking: m.thinking || "", imageCount: m.imageCount || 0, at: m.at || 0, model: m.model || "", meta: m.meta || null });
    }
    await persistLibrary();
    status(`Imported ${sess.messages.length} messages`, "ok");
    return true;
  }
  function setHash() { try { if (location.hash !== "#c=" + sess.id) history.replaceState(null, "", "#c=" + sess.id); } catch {} }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    t = t.replace(/\bhttps?:\/\/[^\s<)]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    return t;
  }
  // Minimal markdown: fenced code → <pre><code>, headings, lists, paragraphs.
  // Good enough for a transcript the core reads back as text (textWithout
  // treats <pre> verbatim, so JSON commands survive round-trips).
  // ORscript's own command envelopes (###LUA### … ###END_LUA###, ###MCP_TOOL###
  // … ###END_MCP_TOOL###) are written as bare text by the model; render them as
  // code blocks so the core can mask them behind a chip like any other site.
  const MARKER_BLOCK_RE = /(###\s*(?:lua(?:\s*[:\-_ ]\s*(?:edit|client|server))?|mcp_tool)\s*(?:###|---)[\s\S]*?(?:###\s*end[_\- ]?(?:lua|mcp_tool)\s*###|$))/gi;
  function fenceMarkers(src) {
    const parts = String(src || "").split(/```/);
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(MARKER_BLOCK_RE, (m) => "\n```orscript\n" + m.replace(/^\n+|\n+$/g, "") + "\n```\n");
    }
    return parts.join("```");
  }
  function renderMarkdown(src) {
    const out = [];
    const parts = fenceMarkers(src).split(/```/);
    for (let i = 0; i < parts.length; i++) {
      const chunk = parts[i];
      if (i % 2 === 1) {
        const nl = chunk.indexOf("\n");
        const lang = nl >= 0 ? chunk.slice(0, nl).trim() : chunk.trim();
        const body = nl >= 0 ? chunk.slice(nl + 1) : "";
        out.push(`<pre><code class="language-${esc(lang || "text")}">${esc(body.replace(/\n$/, ""))}</code></pre>`);
        continue;
      }
      const lines = chunk.split("\n");
      let para = [], list = null;
      const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`); para = []; } };
      const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`); list = null; } };
      for (const raw of lines) {
        const line = raw.replace(/\s+$/, "");
        if (!line.trim()) { flushPara(); flushList(); continue; }
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) { flushPara(); flushList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
        const ul = line.match(/^\s*[-*•]\s+(.*)$/);
        const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ul || ol) {
          flushPara();
          const tag = ul ? "ul" : "ol";
          if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
          list.items.push((ul || ol)[1]);
          continue;
        }
        flushList();
        para.push(line);
      }
      flushPara(); flushList();
    }
    return out.join("");
  }

  function rowEl(msg) {
    const art = document.createElement("article");
    art.className = "cc-msg cc-" + msg.role;
    art.setAttribute("data-message-role", msg.role);
    art.setAttribute("data-message-id", msg.id);
    const who = document.createElement("div");
    who.className = "cc-who";
    who.textContent = msg.role === "user" ? "You" : (msg.model || settings.model || "CodeCraft");
    if (!msg.at) msg.at = Date.now();
    try { who.title = new Date(msg.at).toLocaleString(); } catch {}
    const when = document.createElement("time");
    when.className = "cc-when";
    try { when.dateTime = new Date(msg.at).toISOString(); when.textContent = new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch {}
    who.appendChild(when);
    art.appendChild(who);
    if (msg.imageCount && !(msg.images && msg.images.length)) {
      const note = document.createElement("div");
      note.className = "cc-imgs-note";
      note.textContent = `${msg.imageCount} image(s) attached (not kept across reload)`;
      art.appendChild(note);
    }
    if (msg.images && msg.images.length) {
      const strip = document.createElement("div");
      strip.className = "cc-imgs";
      for (const im of msg.images) {
        const img = document.createElement("img");
        img.alt = "attachment";
        img.src = `data:${im.mimeType || "image/jpeg"};base64,${im.data}`;
        strip.appendChild(img);
      }
      art.appendChild(strip);
    }
    if (msg.role === "assistant") {
      const think = document.createElement("details");
      think.className = "cc-think";
      think.hidden = !msg.thinking;
      think.innerHTML = `<summary>Reasoning</summary><pre class="cc-think-body"></pre>`;
      think.querySelector(".cc-think-body").textContent = msg.thinking || "";
      art.appendChild(think);
    }
    // Stable slot for ORscript's tool chips (chipAtItemLevel + chipAnchor):
    // the body below is re-rendered on every streamed token, this is not.
    const chips = document.createElement("div");
    chips.className = "cc-chips";
    art.appendChild(chips);
    const body = document.createElement("div");
    body.className = "cc-body markdown-body";
    art.appendChild(body);
    if (msg.error) {
      const err = document.createElement("div");
      err.className = "cc-error";
      err.setAttribute("role", "alert");
      err.textContent = msg.error;
      art.appendChild(err);
    }
    // Hover actions (copy / edit & resend / regenerate / delete). Delegated in
    // boot() through #cc-log, so rows restored from storage get them too.
    const acts = document.createElement("div");
    acts.className = "cc-actions";
    acts.setAttribute("aria-label", "Message actions");
    acts.innerHTML = msg.role === "user"
      ? `<button type="button" data-act="copy" title="Copy text">Copy</button><button type="button" data-act="edit" title="Edit this message and resend (drops everything after it)">Edit</button><button type="button" data-act="delete" title="Delete this message">Delete</button>`
      : `<button type="button" data-act="copy" title="Copy reply as Markdown">Copy</button><button type="button" data-act="regen" title="Regenerate this reply">Regenerate</button><button type="button" data-act="delete" title="Delete this reply">Delete</button>`;
    art.appendChild(acts);
    const meta = document.createElement("div");
    meta.className = "cc-meta";
    meta.hidden = true;
    art.appendChild(meta);
    msg.el = art;
    msg.bodyEl = body;
    paintBody(msg, true);
    paintMeta(msg);
    return art;
  }
  function paintMeta(msg) {
    const el = msg.el && msg.el.querySelector(".cc-meta");
    if (!el) return;
    const m = msg.meta;
    if (!m || settings.showMeta === false || msg.role !== "assistant") { el.hidden = true; return; }
    const bits = [];
    if (m.model) bits.push(m.model);
    if (m.secs) bits.push(m.secs + " s");
    if (m.ttft) bits.push("first token " + m.ttft + " s");
    if (m.tokens) bits.push(m.tokens + " tokens");
    if (m.tps) bits.push(m.tps + " tok/s");
    if (m.finish && m.finish !== "stop") bits.push("finish=" + m.finish);
    if (m.retries) bits.push(m.retries + " retr" + (m.retries === 1 ? "y" : "ies"));
    el.textContent = bits.join(" · ");
    el.hidden = !bits.length;
  }
  // Copy button + language label above every non-command code block (final
  // paint only; command blocks stay masked behind ORscript's chips).
  function decorateCode(msg) {
    const body = msg.bodyEl;
    if (!body) return;
    for (const pre of body.querySelectorAll("pre")) {
      if (pre.classList.contains("rs-tool-hide") || CMD_SHAPE.test(pre.textContent || "")) continue;
      if (pre.previousElementSibling && pre.previousElementSibling.classList.contains("cc-pre-bar")) continue;
      const code = pre.querySelector("code");
      const lang = ((code && code.className.match(/language-([\w+-]+)/)) || [])[1] || "";
      const bar = document.createElement("div");
      bar.className = "cc-pre-bar";
      bar.innerHTML = `<span class="cc-pre-lang">${esc(lang === "text" ? "" : lang)}</span><button type="button" data-act="copy-code" title="Copy code">Copy</button>`;
      pre.parentNode.insertBefore(bar, pre);
    }
  }
  function paintBody(msg, final) {
    if (!msg.bodyEl) return;
    if (msg.role === "user") { msg.bodyEl.textContent = msg.content; return; }
    // Markdown on every paint (streaming included). Chips live in .cc-chips, so
    // re-rendering the body never loses them; the hide classes the core put on
    // command blocks are re-applied right here so the raw JSON never flashes.
    msg.bodyEl.innerHTML = renderMarkdown(msg.content);
    msg.bodyEl.classList.toggle("cc-streaming", !final);
    if (msg.el && msg.el.classList.contains("rs-cmd-mask")) { try { findToolBlockSpot(msg.el); } catch {} }
    if (final) { try { decorateCode(msg); } catch {} }
    if (msg.el) {
      const think = msg.el.querySelector(".cc-think");
      if (think) {
        think.hidden = !msg.thinking;
        const tb = think.querySelector(".cc-think-body");
        if (tb && tb.textContent !== (msg.thinking || "")) tb.textContent = msg.thinking || "";
      }
    }
  }
  function pushMessage(msg) {
    msg.id = msg.id || (++sess.seq + "-" + Date.now().toString(36));
    sess.messages.push(msg);
    if (ui.log) {
      ui.log.appendChild(rowEl(msg));
      scrollToEnd();
    }
    if (ui.empty) ui.empty.hidden = true;
    if (ui.app) ui.app.classList.add("cc-has-msgs");
    persist();
    return msg;
  }
  let _autoScroll = true;
  function scrollToEnd() {
    const log = ui.log;
    if (!log || !_autoScroll) return;
    try { log.scrollTop = log.scrollHeight; } catch {}
  }
  function clearTranscript() {
    sess.messages = [];
    if (ui.log) ui.log.innerHTML = "";
    if (ui.empty) ui.empty.hidden = false;
    if (ui.app) ui.app.classList.remove("cc-has-msgs");
  }
  function startSession(id) {
    sess.id = id || newId();
    sess.title = ""; sess.createdAt = Date.now(); sess.usage = { prompt: 0, completion: 0, total: 0, requests: 0 };
    setHash();
    clearTranscript();
    let restored = false;
    try {
      const raw = window.sessionStorage && sessionStorage.getItem(sessKey());
      if (raw) { for (const m of JSON.parse(raw)) pushMessage(Object.assign({}, m)); restored = sess.messages.length > 0; }
    } catch {}
    const entry = chatIndex.find((c) => c.id === sess.id);
    if (entry) { sess.title = entry.title || ""; sess.createdAt = entry.createdAt || sess.createdAt; }
    renderUsage();
    renderChats();
    try { document.title = "CodeCraft API — ORscript"; } catch {}
    if (restored) { persist(); return Promise.resolve(true); }
    // Not in this tab's sessionStorage: fall back to the library (another tab,
    // a closed tab, a reload after the browser dropped session state).
    const want = sess.id;
    return storeGet(CHAT_KEY_PREFIX + want).then((rec) => {
      if (!rec || sess.id !== want || sess.messages.length) return false;
      sess.title = rec.title || sess.title; sess.createdAt = rec.createdAt || sess.createdAt;
      if (rec.usage) sess.usage = Object.assign({ prompt: 0, completion: 0, total: 0, requests: 0 }, rec.usage);
      for (const m of rec.messages || []) pushMessage(Object.assign({}, m));
      renderUsage();
      try { document.title = (sess.title || deriveTitle()) + " — CodeCraft · ORscript"; } catch {}
      return true;
    }).catch(() => false);
  }
  function newChat() {
    if (_stream) stopGeneration();
    if (hooks && hooks.isBlocked()) { status("ORscript agent is working — press Stop in the bar before starting a new chat", "warn"); return; }
    startSession(newId());
    _lastError = "";
    _pendingImages = [];
    renderAttachments();
    if (ui.input) { ui.input.value = ""; ui.input.focus(); }
    status("New chat");
  }

  // ---------- message actions ----------
  function removeMessage(msg) {
    const i = sess.messages.indexOf(msg);
    if (i >= 0) sess.messages.splice(i, 1);
    try { msg.el && msg.el.remove(); } catch {}
    if (!sess.messages.length) { if (ui.empty) ui.empty.hidden = false; if (ui.app) ui.app.classList.remove("cc-has-msgs"); }
  }
  function truncateAfter(msg, inclusive) {
    const i = sess.messages.indexOf(msg);
    if (i < 0) return;
    const gone = sess.messages.splice(inclusive ? i : i + 1);
    for (const g of gone) { try { g.el && g.el.remove(); } catch {} }
    if (!sess.messages.length) { if (ui.empty) ui.empty.hidden = false; if (ui.app) ui.app.classList.remove("cc-has-msgs"); }
  }
  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(String(text || "")); status((label || "Copied") + " to clipboard", "ok"); return true; }
    catch { status("Clipboard unavailable", "warn"); return false; }
  }
  function regenerate(msg) {
    if (!msg || msg.role !== "assistant") return false;
    if (!guardAgent("regenerating")) return false;
    if (!hasKey()) { status("Paste your CodeCraft API key first (cc_…)", "warn"); return false; }
    if (_stream) stopGeneration();
    truncateAfter(msg, true);
    _lastError = "";
    const reply = pushMessage({ role: "assistant", content: "", thinking: "", model: settings.model });
    const ctrl = new AbortController();
    _stream = { ctrl, msg: reply, startedAt: Date.now(), lastAt: Date.now(), firstTokenAt: 0, retries: 0 };
    setBusy(true);
    status(`Regenerating with ${settings.model}…`);
    paintBody(reply, false);
    diag("codecraft.regenerate", { model: settings.model, history: sess.messages.length });
    runStream(_stream).catch(() => {});
    return true;
  }
  function editMessage(msg) {
    if (!msg || msg.role !== "user") return false;
    if (!guardAgent("editing")) return false;
    if (_stream) stopGeneration();
    const ta = ui.input;
    if (!ta) return false;
    truncateAfter(msg, true);
    ta.value = msg.content || "";
    if (msg.images && msg.images.length) { _pendingImages = msg.images.slice(0, 8); renderAttachments(); }
    autoGrow();
    try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
    persist();
    status("Editing — press Enter to resend; everything after this message was removed", "warn");
    return true;
  }
  function onLogClick(e) {
    const btn = e.target && e.target.closest && e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act === "copy-code") {
      const pre = btn.parentElement && btn.parentElement.nextElementSibling;
      const code = pre && (pre.querySelector("code") || pre);
      copyText(code ? code.textContent : "", "Code copied");
      return;
    }
    const row = btn.closest("article.cc-msg");
    const msg = msgOf(row);
    if (!msg) return;
    if (act === "copy") copyText(msg.content, msg.role === "user" ? "Message copied" : "Reply copied");
    else if (act === "regen") regenerate(msg);
    else if (act === "edit") editMessage(msg);
    else if (act === "delete") {
      if (!guardAgent("deleting")) return;
      if (_stream && _stream.msg === msg) stopGeneration();
      removeMessage(msg);
      persist();
      status("Message deleted", "ok");
    }
  }

  // ---------- status / errors ----------
  let _lastError = "";
  function status(text, kind) {
    const el = ui.status;
    if (!el) return;
    el.textContent = text || "";
    el.className = "cc-status" + (kind ? " cc-status-" + kind : "");
  }

  // ---------- models ----------
  let _models = FALLBACK_MODELS.slice();
  function fillModels() {
    const sel = ui.model;
    if (!sel) return;
    const cur = settings.model || DEFAULT_MODEL;
    const list = _models.includes(cur) ? _models : [cur, ..._models];
    sel.innerHTML = list.map((m) => `<option value="${esc(m)}"${m === cur ? " selected" : ""}>${esc(m)}</option>`).join("");
  }
  async function refreshModels() {
    if (!hasKey()) { fillModels(); return; }
    try {
      const r = await fetch(API_BASE + "/models", { headers: { Authorization: "Bearer " + settings.key.trim() } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const ids = (j && j.data ? j.data : Array.isArray(j) ? j : []).map((m) => m && (m.id || m.name)).filter(Boolean);
      if (ids.length) { _models = ids; fillModels(); status(`${ids.length} models · key ${maskKey(settings.key)}`, "ok"); }
    } catch (e) {
      diag("codecraft.models.error", { error: String(e && e.message || e) });
      fillModels();
      status("Could not load /models (" + (e && e.message || e) + ") — check the key", "warn");
    }
  }

  // ---------- request ----------
  let _stream = null; // { ctrl, msg, startedAt, lastAt }
  let _pendingImages = [];
  function apiMessages() {
    // Skip the in-flight placeholder and failed/empty assistant rows.
    const cur = _stream && _stream.msg;
    const msgs = sess.messages.filter((m) => m !== cur && !(m.role === "assistant" && !m.content));
    // Only the newest IMAGE_TURNS user messages keep their pixels: every request
    // re-sends the whole history, so older screenshots would be re-billed as
    // vision tokens on each turn and push the body past request-size limits.
    const withImages = msgs.filter((m) => m.role === "user" && m.images && m.images.length);
    const liveImages = new Set(withImages.slice(-IMAGE_TURNS));
    const toApi = (m) => {
      if (m.role === "user" && m.images && m.images.length) {
        if (!liveImages.has(m)) return { role: "user", content: m.content + `\n[${m.images.length} image(s) were attached here earlier; omitted from this request]` };
        return { role: "user", content: [{ type: "text", text: m.content }, ...m.images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mimeType || "image/jpeg"};base64,${im.data}` } }))] };
      }
      return { role: m.role, content: m.content };
    };
    // Keep the first message (ORscript bootstrap / command catalogue) and the
    // most recent ones within the character budget.
    const first = msgs[0];
    const rest = msgs.slice(1);
    let budget = HISTORY_CHAR_BUDGET - (first ? first.content.length : 0);
    const kept = [];
    for (let i = rest.length - 1; i >= 0; i--) {
      const len = rest[i].content.length;
      if (budget - len < 0 && kept.length) break;
      budget -= len;
      kept.unshift(rest[i]);
    }
    const out = [];
    if (first) out.push(toApi(first));
    if (rest.length > kept.length) out.push({ role: "user", content: `[ORscript: ${rest.length - kept.length} older messages omitted to fit the context budget]` });
    for (const m of kept) out.push(toApi(m));
    // The API rejects a trailing assistant row and consecutive same-role rows poorly; merge.
    const merged = [];
    for (const m of out) {
      const prev = merged[merged.length - 1];
      if (!prev || prev.role !== m.role) { merged.push(m); continue; }
      if (typeof prev.content === "string" && typeof m.content === "string") { prev.content += "\n\n" + m.content; continue; }
      // At least one side carries image parts: merge as content parts.
      const parts = (c) => (typeof c === "string" ? [{ type: "text", text: c }] : c.slice());
      prev.content = parts(prev.content).concat(parts(m.content));
    }
    return merged;
  }
  function truncateForSend(text) {
    if (!text || text.length <= SEND_MAX) return text;
    const omitted = text.length - SEND_MAX;
    const marker = `\n\n[…OR: result truncated to fit the send limit - ${omitted} of ${text.length} characters omitted…]\n\n`;
    const budget = SEND_MAX - marker.length;
    const headLen = Math.floor(budget * 0.85);
    return text.slice(0, headLen) + marker + text.slice(text.length - (budget - headLen));
  }
  function errorText(status, body) {
    let detail = "";
    try { const j = JSON.parse(body); detail = (j.error && (j.error.message || j.error)) || j.message || j.detail || ""; } catch { detail = String(body || "").slice(0, 300); }
    detail = typeof detail === "string" ? detail : JSON.stringify(detail);
    if (status === 401 || status === 403) return `CodeCraft rejected the API key (HTTP ${status}). ${detail || "Create a key at codecraftapi.com → Dashboard → API Keys and paste it above."}`;
    if (status === 402) return `CodeCraft: out of tokens for this billing period (HTTP 402). ${detail || "Upgrade the plan or wait for the monthly reset."}`;
    if (status === 429) return `CodeCraft: rate limited (HTTP 429). ${detail || "Retry in a moment."}`;
    return `CodeCraft API error HTTP ${status}${detail ? ": " + detail : ""}`;
  }

  async function submit(text, images, opts = {}) {
    text = truncateForSend(String(text || ""));
    if (!hasKey()) { status("Paste your CodeCraft API key first (cc_…)", "warn"); try { ui.key && ui.key.focus(); } catch {} return false; }
    const imgs = (images && images.length ? images : _pendingImages).slice(0, 8);
    if (!text.trim() && !imgs.length) return false;
    _pendingImages = [];
    renderAttachments();
    if (_stream) stopGeneration();
    _lastError = "";
    pushMessage({ role: "user", content: text, images: imgs });
    const reply = pushMessage({ role: "assistant", content: "", thinking: "", model: settings.model });
    const ctrl = new AbortController();
    _stream = { ctrl, msg: reply, startedAt: Date.now(), lastAt: Date.now(), firstTokenAt: 0, retries: 0 };
    setBusy(true);
    status(`Sending to ${settings.model}…`);
    paintBody(reply, false);
    diag("codecraft.send", { model: settings.model, textLen: text.length, images: imgs.length, history: sess.messages.length, agent: !!opts.fromAgent });
    runStream(_stream).catch(() => {});
    return true;
  }

  const RETRY_DELAYS_MS = [1500, 4000];
  const retryable = (status) => status === 429 || status === 408 || status === 409 || (status >= 500 && status <= 599);
  function requestBody() {
    const messages = apiMessages();
    const instr = String(settings.instructions || "").trim();
    if (instr) messages.unshift({ role: "system", content: instr.slice(0, 8000) });
    const body = { model: settings.model || DEFAULT_MODEL, messages, stream: true };
    if (settings.temperature != null && settings.temperature !== "") body.temperature = Number(settings.temperature);
    const mt = Number(settings.maxTokens);
    if (mt && mt > 0) body.max_tokens = Math.floor(mt);
    if (settings.reasoning) body.reasoning_effort = settings.reasoning;
    return body;
  }
  async function runStream(st) {
    const { ctrl, msg } = st;
    const body = requestBody();
    let res;
    // Transient failures (429 / 5xx / network) are retried in place - the row
    // keeps its position, the status line shows the countdown, and a Stop
    // during the wait aborts cleanly.
    for (let attempt = 0; ; attempt++) {
      let failure = "", transient = false;
      try {
        res = await fetch(API_BASE + "/chat/completions", {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: "Bearer " + settings.key.trim() },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (ctrl.signal.aborted) return finish(st, "");
        failure = "Network error reaching codecraftapi.com: " + (e && e.message || e); transient = true;
      }
      if (!failure && !res.ok) {
        let t = ""; try { t = await res.text(); } catch {}
        failure = errorText(res.status, t); transient = retryable(res.status);
      }
      if (!failure) break;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!transient || settings.autoRetry === false || delay == null) return finish(st, failure);
      st.retries = attempt + 1;
      status(`${failure.slice(0, 90)} — retrying in ${delay / 1000}s (${attempt + 1}/${RETRY_DELAYS_MS.length})`, "warn");
      diag("codecraft.retry", { attempt: attempt + 1, delay, error: failure.slice(0, 120) });
      await new Promise((r) => { const t = setTimeout(r, delay); ctrl.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
      if (ctrl.signal.aborted) return finish(st, "");
    }
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (!ctype.includes("event-stream")) {
      // Non-streaming answer (proxy or model without stream support).
      try {
        const j = await res.json();
        const ch = j.choices && j.choices[0];
        const m = ch && ch.message;
        if (m) { msg.content = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((p) => p.text || "").join("") : ""); msg.thinking = m.reasoning_content || m.reasoning || ""; }
        if (j.usage) st.usage = j.usage;
      } catch (e) { return finish(st, "Unreadable response: " + (e && e.message || e)); }
      return finish(st, "");
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", paintQueued = false;
    // setTimeout, not requestAnimationFrame: rAF is frozen in background tabs,
    // and the core's "work in background tabs" mode reads the transcript DOM
    // while this tab is hidden - the stream must keep landing in the DOM.
    const queuePaint = () => {
      if (paintQueued) return;
      paintQueued = true;
      setTimeout(() => { paintQueued = false; if (msg.done) return; paintBody(msg, false); scrollToEnd(); }, 40);
    };
    const handle = (data) => {
      if (data === "[DONE]") return true;
      let j; try { j = JSON.parse(data); } catch { return false; }
      if (j.error) { st.err = (j.error.message || JSON.stringify(j.error)); return true; }
      if (j.usage) st.usage = j.usage;
      const ch = j.choices && j.choices[0];
      if (!ch) return false;
      const d = ch.delta || ch.message || {};
      const think = d.reasoning_content || d.reasoning || (d.thinking && (typeof d.thinking === "string" ? d.thinking : d.thinking.text)) || "";
      if (think) { msg.thinking = (msg.thinking || "") + think; st.lastAt = Date.now(); }
      let txt = d.content;
      if (Array.isArray(txt)) txt = txt.map((p) => (typeof p === "string" ? p : p.text || "")).join("");
      if (txt) {
        if (!st.firstTokenAt) st.firstTokenAt = Date.now();
        msg.content += txt; st.lastAt = Date.now();
      }
      if (ch.finish_reason) st.finish = ch.finish_reason;
      queuePaint();
      return false;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (!line || line.startsWith(":")) continue; // keep-alive ping
          if (!line.startsWith("data:")) continue;
          if (handle(line.slice(5).trim())) { try { reader.cancel(); } catch {} buf = ""; break; }
        }
      }
      if (buf.trim().startsWith("data:")) handle(buf.trim().slice(5).trim());
    } catch (e) {
      if (!ctrl.signal.aborted) return finish(st, "Stream interrupted: " + (e && e.message || e));
    }
    return finish(st, st.err ? "CodeCraft API error: " + st.err : "");
  }

  function finish(st, error) {
    if (_stream !== st) return;
    const msg = st.msg;
    _stream = null;
    msg.done = true;
    if (error) {
      msg.error = error;
      _lastError = error;
      if (msg.el && !msg.el.querySelector(".cc-error")) {
        const err = document.createElement("div");
        err.className = "cc-error";
        err.setAttribute("role", "alert");
        err.textContent = error;
        msg.el.appendChild(err);
      }
      status(error, "err");
      diag("codecraft.error", { error });
    } else {
      const u = st.usage || {};
      const secs = ((Date.now() - st.startedAt) / 1000).toFixed(1);
      const genMs = Date.now() - (st.firstTokenAt || st.startedAt);
      const tps = u.completion_tokens && genMs > 300 ? Math.round(u.completion_tokens / (genMs / 1000)) : 0;
      status(`${settings.model} · ${secs}s${u.total_tokens ? ` · ${u.total_tokens} tokens` : ""}${tps ? ` · ${tps} tok/s` : ""}${st.finish && st.finish !== "stop" ? ` · finish=${st.finish}` : ""}`, "ok");
      if (st.finish === "length") msg.truncated = true;
      msg.meta = { model: msg.model || settings.model, secs: Number(secs), ttft: st.firstTokenAt ? Number(((st.firstTokenAt - st.startedAt) / 1000).toFixed(1)) : 0, tokens: u.total_tokens || 0, tps, finish: st.finish || "", retries: st.retries || 0 };
      paintMeta(msg);
      if (u.total_tokens || u.prompt_tokens || u.completion_tokens) recordUsage(u, msg.model || settings.model).catch(() => {});
      if (!msg.content && !msg.thinking && msg.el && !msg.el.querySelector(".cc-error")) {
        // Nothing came back (filtered / empty choice): say so instead of
        // leaving a blank bubble the user cannot interpret.
        const note = document.createElement("div");
        note.className = "cc-error";
        note.textContent = `The model returned an empty reply${st.finish ? " (finish_reason=" + st.finish + ")" : ""}. Try again or pick another model.`;
        msg.el.appendChild(note);
      }
    }
    paintBody(msg, true);
    scrollToEnd();
    setBusy(false);
    persist();
    _settledAt = Date.now();
  }
  let _settledAt = 0;

  function setBusy(on) {
    if (ui.send) ui.send.disabled = !!on;
    if (ui.stop) ui.stop.hidden = !on;
    if (ui.app) ui.app.classList.toggle("cc-busy", !!on);
  }

  // ---------- attachments (manual, via the paperclip) ----------
  function renderAttachments() {
    const box = ui.attachList;
    if (!box) return;
    box.innerHTML = "";
    box.hidden = !_pendingImages.length;
    _pendingImages.forEach((im, i) => {
      const wrap = document.createElement("span");
      wrap.className = "cc-att";
      const img = document.createElement("img");
      img.src = `data:${im.mimeType || "image/jpeg"};base64,${im.data}`;
      const x = document.createElement("button");
      x.type = "button"; x.textContent = "×"; x.title = "Remove";
      x.addEventListener("click", () => { _pendingImages.splice(i, 1); renderAttachments(); });
      wrap.appendChild(img); wrap.appendChild(x);
      box.appendChild(wrap);
    });
  }
  function fileToImage(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result || ""); const m = s.match(/^data:([^;]+);base64,(.*)$/); m ? res({ mimeType: m[1], data: m[2] }) : rej(new Error("unreadable")); };
      fr.onerror = () => rej(fr.error || new Error("read failed"));
      fr.readAsDataURL(file);
    });
  }

  // ---------- page wiring ----------
  let hooks = null;
  let booted = false;
  async function boot() {
    if (booted || !isHostPage()) return;
    booted = true;
    await loadSettings();
    await loadIndex();
    _usageTotal = (await storeGet(USAGE_KEY)) || { total: 0, requests: 0, byModel: {} };
    if (ui.key) ui.key.value = settings.key || "";
    fillModels();
    applySettingsUi();
    if (ui.app) ui.app.classList.toggle("cc-side-collapsed", !!settings.sideCollapsed);
    if (ui.sideToggle) ui.sideToggle.setAttribute("aria-expanded", settings.sideCollapsed ? "false" : "true");
    status(hasKey() ? `key ${maskKey(settings.key)} · ${settings.model}` : "No API key yet — create one at codecraftapi.com → Dashboard → API Keys", hasKey() ? "ok" : "warn");
    const m = (location.hash || "").match(/#c=([A-Za-z0-9]+)/);
    await startSession(m ? m[1] : newId());
    renderChats();
    renderUsage();
    refreshModels();
    wireExtras();

    const onSave = async () => {
      const k = String(ui.key && ui.key.value || "").trim();
      await saveSettings({ key: k });
      if (!hasKey()) { status("That does not look like a CodeCraft key (cc_…)", "warn"); return; }
      status(`Saved key ${maskKey(k)} — loading models…`, "ok");
      await refreshModels();
    };
    if (ui.keySave) ui.keySave.addEventListener("click", onSave);
    if (ui.key) ui.key.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onSave(); } });
    if (ui.model) ui.model.addEventListener("change", () => { saveSettings({ model: ui.model.value }); status(`Model: ${ui.model.value}`, "ok"); paintModelLogo(); });
    if (ui.newChat) ui.newChat.addEventListener("click", newChat);
    if (ui.stop) ui.stop.addEventListener("click", () => { stopGeneration(); if (hooks) try { hooks.onNativeStop(); } catch {} });
    if (ui.log) ui.log.addEventListener("scroll", () => { const l = ui.log; _autoScroll = l.scrollHeight - l.scrollTop - l.clientHeight < 80; if (ui.jump) ui.jump.hidden = _autoScroll; });
    if (ui.log) ui.log.addEventListener("click", onLogClick);
    if (ui.attach && ui.fileInput) {
      ui.attach.addEventListener("click", () => ui.fileInput.click());
      ui.fileInput.addEventListener("change", async () => {
        for (const f of ui.fileInput.files || []) { if (/^image\//.test(f.type)) { try { _pendingImages.push(await fileToImage(f)); } catch {} } }
        ui.fileInput.value = "";
        renderAttachments();
      });
    }
    if (ui.input) {
      ui.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey;
          const chord = e.ctrlKey || e.metaKey;
          if ((settings.ctrlEnter ? chord : plain)) { e.preventDefault(); userSend(); return; }
        }
        // ↑ in an empty composer: edit the last message you sent (ChatGPT-style).
        if (e.key === "ArrowUp" && !ui.input.value && !e.shiftKey && !e.altKey) {
          const last = [...sess.messages].reverse().find((m) => m.role === "user" && !(BOOTSTRAP_RE.test(m.content || "") && m.content.length > 200));
          if (last && !(hooks && hooks.isBlocked())) { e.preventDefault(); editMessage(last); }
        }
      });
      ui.input.addEventListener("input", autoGrow);
      ui.input.addEventListener("paste", async (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const it of items) if (it.kind === "file" && /^image\//.test(it.type)) { const f = it.getAsFile(); if (f) { try { _pendingImages.push(await fileToImage(f)); } catch {} } }
        renderAttachments();
      });
    }
    if (ui.form) ui.form.addEventListener("submit", (e) => { e.preventDefault(); userSend(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) scrollToEnd(); });
    diag("codecraft.boot", { hasKey: hasKey(), model: settings.model, restored: sess.messages.length });
  }
  function autoGrow() {
    const ta = ui.input;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 260) + "px";
  }
  // ---------- 1.36.0 page extras (library, settings drawer, export, shortcuts, drag & drop) ----------
  function paintModelLogo() {
    const img = ui.modelLogo;
    if (!img) return;
    const m = String(settings.model || "").trim();
    if (!m) { img.hidden = true; return; }
    img.hidden = false;
    img.src = `${SITE}/images/models/${encodeURIComponent(m)}.png`;
  }
  function applySettingsUi() {
    if (ui.temp) { ui.temp.value = settings.temperature == null || settings.temperature === "" ? "1" : String(settings.temperature); }
    if (ui.tempOut) ui.tempOut.textContent = settings.temperature == null || settings.temperature === "" ? "default" : String(settings.temperature);
    if (ui.maxTokens) ui.maxTokens.value = settings.maxTokens ? String(settings.maxTokens) : "";
    if (ui.reasoning) ui.reasoning.value = settings.reasoning || "";
    if (ui.instructions) ui.instructions.value = settings.instructions || "";
    if (ui.autoRetry) ui.autoRetry.checked = settings.autoRetry !== false;
    if (ui.ctrlEnter) ui.ctrlEnter.checked = !!settings.ctrlEnter;
    if (ui.showMeta) ui.showMeta.checked = settings.showMeta !== false;
    if (ui.input) ui.input.setAttribute("placeholder", settings.ctrlEnter ? "Message CodeCraft… (Ctrl+Enter to send, Enter for a new line)" : "Message CodeCraft… (Enter to send, Shift+Enter for a new line)");
    paintModelLogo();
    renderUsage();
  }
  function toggleSettings(force) {
    const p = ui.settingsPanel;
    if (!p) return;
    const open = force == null ? p.hidden : !!force;
    p.hidden = !open;
    if (ui.settingsBtn) ui.settingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (ui.app) ui.app.classList.toggle("cc-settings-open", open);
    if (open) applySettingsUi();
  }
  function toggleSide(force) {
    const collapsed = force == null ? !settings.sideCollapsed : !force;
    saveSettings({ sideCollapsed: collapsed });
    if (ui.app) ui.app.classList.toggle("cc-side-collapsed", collapsed);
    if (ui.sideToggle) ui.sideToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
  function wireExtras() {
    if (ui.modelLogo) ui.modelLogo.addEventListener("error", () => { ui.modelLogo.hidden = true; });
    if (ui.sideToggle) ui.sideToggle.addEventListener("click", () => toggleSide());
    if (ui.sideNew) ui.sideNew.addEventListener("click", newChat);
    if (ui.search) ui.search.addEventListener("input", () => { _search = ui.search.value || ""; renderChats(); });
    if (ui.chats) ui.chats.addEventListener("click", (e) => {
      const t = e.target && e.target.closest && e.target.closest("button[data-chat-open],button[data-chat-pin],button[data-chat-rename],button[data-chat-delete]");
      if (!t) return;
      e.preventDefault();
      if (t.hasAttribute("data-chat-open")) openChat(t.getAttribute("data-chat-open"));
      else if (t.hasAttribute("data-chat-pin")) pinChat(t.getAttribute("data-chat-pin"));
      else if (t.hasAttribute("data-chat-rename")) {
        const id = t.getAttribute("data-chat-rename");
        const c = chatIndex.find((x) => x.id === id);
        let name = null; try { name = window.prompt("Rename chat", (c && c.title) || ""); } catch {}
        if (name != null) renameChat(id, name);
      } else if (t.hasAttribute("data-chat-delete")) {
        const id = t.getAttribute("data-chat-delete");
        const c = chatIndex.find((x) => x.id === id);
        let yes = true; try { yes = window.confirm(`Delete “${(c && c.title) || "this chat"}”? This cannot be undone.`); } catch {}
        if (yes) deleteChat(id);
      }
    });
    if (ui.clearAll) ui.clearAll.addEventListener("click", () => { let yes = true; try { yes = window.confirm(`Delete all ${chatIndex.length} saved chats?`); } catch {} if (yes) clearAllChats(); });
    if (ui.importBtn && ui.importFile) {
      ui.importBtn.addEventListener("click", () => ui.importFile.click());
      ui.importFile.addEventListener("change", async () => {
        const f = ui.importFile.files && ui.importFile.files[0];
        ui.importFile.value = "";
        if (!f) return;
        try { await importChat(await f.text()); } catch (e) { status("Import failed: " + (e && e.message || e), "err"); }
      });
    }
    if (ui.exportBtn) ui.exportBtn.addEventListener("click", (e) => exportChat(e.shiftKey ? "json" : "md"));
    if (ui.settingsBtn) ui.settingsBtn.addEventListener("click", () => toggleSettings());
    if (ui.settingsClose) ui.settingsClose.addEventListener("click", () => toggleSettings(false));
    if (ui.temp) ui.temp.addEventListener("input", () => { const v = Number(ui.temp.value); saveSettings({ temperature: v }); if (ui.tempOut) ui.tempOut.textContent = String(v); });
    if (ui.tempReset) ui.tempReset.addEventListener("click", () => { saveSettings({ temperature: null }); applySettingsUi(); });
    if (ui.maxTokens) ui.maxTokens.addEventListener("change", () => { const v = Number(ui.maxTokens.value); saveSettings({ maxTokens: v > 0 ? Math.floor(v) : null }); });
    if (ui.reasoning) ui.reasoning.addEventListener("change", () => saveSettings({ reasoning: ui.reasoning.value || "" }));
    if (ui.instructions) ui.instructions.addEventListener("change", () => saveSettings({ instructions: String(ui.instructions.value || "").slice(0, 8000) }));
    if (ui.autoRetry) ui.autoRetry.addEventListener("change", () => saveSettings({ autoRetry: !!ui.autoRetry.checked }));
    if (ui.ctrlEnter) ui.ctrlEnter.addEventListener("change", () => { saveSettings({ ctrlEnter: !!ui.ctrlEnter.checked }); applySettingsUi(); });
    if (ui.showMeta) ui.showMeta.addEventListener("change", () => { saveSettings({ showMeta: !!ui.showMeta.checked }); for (const m of sess.messages) paintMeta(m); });
    if (ui.usageReset) ui.usageReset.addEventListener("click", () => { _usageTotal = { total: 0, requests: 0, byModel: {} }; storeSet(USAGE_KEY, _usageTotal).catch(() => {}); renderUsage(); });
    if (ui.jump) ui.jump.addEventListener("click", () => { _autoScroll = true; ui.jump.hidden = true; scrollToEnd(); });
    // Quick prompts on the empty state fill the composer (the user still presses Enter).
    if (ui.empty) ui.empty.addEventListener("click", (e) => {
      const b = e.target && e.target.closest && e.target.closest("button[data-cc-prompt]");
      if (!b || !ui.input) return;
      ui.input.value = b.getAttribute("data-cc-prompt") || "";
      autoGrow();
      try { ui.input.focus(); } catch {}
      if (hooks && !hooks.isStarted() && chatIsEmpty()) status("Press Start in the ORscript bar to let the agent build this in Studio, or Enter to just chat", "ok");
    });
    // Drag & drop images anywhere on the page.
    const app = ui.app;
    if (app) {
      let depth = 0;
      const hasFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"));
      app.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth++; if (ui.drop) ui.drop.hidden = false; });
      app.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
      app.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth && ui.drop) ui.drop.hidden = true; });
      app.addEventListener("drop", async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); depth = 0; if (ui.drop) ui.drop.hidden = true;
        let n = 0;
        for (const f of e.dataTransfer.files || []) { if (/^image\//.test(f.type) && _pendingImages.length < 8) { try { _pendingImages.push(await fileToImage(f)); n++; } catch {} } }
        renderAttachments();
        if (n) status(`${n} image${n === 1 ? "" : "s"} attached`, "ok");
      });
    }
    // Keyboard shortcuts.
    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = String(e.key || "").toLowerCase();
      if (e.key === "Escape") {
        if (_stream) { e.preventDefault(); stopGeneration(); if (hooks) try { hooks.onNativeStop(); } catch {} return; }
        if (ui.settingsPanel && !ui.settingsPanel.hidden) { toggleSettings(false); return; }
        return;
      }
      if (!mod) return;
      if (k === "k" && !e.shiftKey) { e.preventDefault(); newChat(); }
      else if (k === "b" && !e.shiftKey) { e.preventDefault(); toggleSide(); }
      else if (k === "," ) { e.preventDefault(); toggleSettings(); }
      else if (k === "s" && e.shiftKey) { e.preventDefault(); exportChat(e.altKey ? "json" : "md"); }
    });
  }
  // Manual send from the composer: mirrors what installSendHooks does on
  // hosted sites (block while the agent is mid-turn, nudge to Start on an
  // empty chat, count the user's turn otherwise).
  async function userSend() {
    const ta = ui.input;
    if (!ta || ta.readOnly) return;
    const text = ta.value;
    if (!text.trim() && !_pendingImages.length) return;
    if (hooks) {
      if (hooks.isBlocked()) { status("ORscript agent is working — wait for its turn to finish or press Stop in the bar", "warn"); return; }
      if (!hooks.isStarted()) {
        if (chatIsEmpty()) { hooks.onBlockedAttempt(); return; }
      } else {
        hooks.onUserMessage(assistantCount());
      }
    }
    ta.value = "";
    autoGrow();
    await submit(text, null, { fromAgent: false });
  }

  // ---------- RSProvider contract ----------
  const visible = (el) => !!el && el.isConnected !== false && !el.hidden;
  const getEditor = () => ui.input || null;
  const editorText = () => (ui.input && ui.input.value) || "";
  function allItems() {
    const log = ui.log;
    if (!log) return [];
    return [...log.querySelectorAll("article.cc-msg")].filter(visible);
  }
  const roleOf = (item) => (item && item.getAttribute("data-message-role")) || "";
  const isUserItem = (item) => roleOf(item) === "user";
  const isAssistantItem = (item) => roleOf(item) === "assistant";
  const msgOf = (item) => { const id = item && item.getAttribute("data-message-id"); return sess.messages.find((m) => m.id === id) || null; };
  function itemText(item) {
    const m = msgOf(item);
    if (m) return m.content;
    const b = item && item.querySelector(".cc-body");
    return b ? (b.innerText || b.textContent || "") : "";
  }
  function classifyText(item, excludeSel) {
    if (!item) return "";
    const body = item.querySelector(".cc-body");
    if (!body) return "";
    if (excludeSel && body.closest && body.closest(excludeSel)) return "";
    const m = msgOf(item);
    if (m) return m.content;
    return body.innerText || body.textContent || "";
  }
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => { const it = assistantItems(); return it.length ? it[it.length - 1] : null; };
  const itemKey = (item) => (item && item.getAttribute("data-message-id")) || null;
  const lastAssistantId = () => itemKey(lastAssistant());
  const chatIsEmpty = () => sess.messages.length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();
  const streamLen = (item) => { const m = msgOf(item === undefined ? lastAssistant() : item); return m ? m.content.length : 0; };
  const composerFrame = () => ui.composer || ui.form || null;
  const barAnchor = () => ui.composer || ui.form || null;
  // The bar lives in-flow directly above the composer: this is our page, so
  // no reservation games are needed.
  function barMount() {
    const comp = ui.composer;
    if (!comp) return null;
    // Skip our own bar when it is already the first child - otherwise `before`
    // is the bar itself and the core would re-insert it on every pass.
    let first = comp.firstElementChild;
    while (first && first.id === "rs-bar") first = first.nextElementSibling;
    return { parent: comp, before: first || null };
  }

  function setInputLock(on) {
    const ta = ui.input;
    if (!ta) return;
    if (on) {
      if (ta.dataset.rsPlaceholder == null) ta.dataset.rsPlaceholder = ta.getAttribute("placeholder") || "";
      ta.readOnly = true;
      ta.setAttribute("placeholder", "⏳ Agent working… please wait");
    } else {
      ta.readOnly = false;
      if (ta.dataset.rsPlaceholder != null) ta.setAttribute("placeholder", ta.dataset.rsPlaceholder);
    }
  }

  const isHardGenerating = () => !!_stream;
  function isGenerating() {
    if (_stream) return true;
    // A short settle window after the final paint so the core's idle timer
    // starts from the finished markdown, not mid-render.
    return Date.now() - _settledAt < 250;
  }
  const isBusyNow = isGenerating;
  const turnHalted = () => { const m = msgOf(lastAssistant()); return !!(m && m.truncated); };
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    const m = msgOf(lastAssistant());
    if (!m) return { th: 0, rp: 0 };
    return { th: (m.thinking || "").length, rp: m.content.length };
  }
  function readAssistant() {
    const item = lastAssistant();
    const m = msgOf(item);
    if (!item || !m) return { present: false, reply: "", thinking: "", item: null };
    return { present: true, reply: m.content.trim(), thinking: (m.thinking || "").trim(), item };
  }

  async function typeAndSend(text, images) {
    if (!isHostPage()) throw new Error("CodeCraft chat page not ready");
    if (!hasKey()) throw new Error("CodeCraft API key missing — paste your cc_ key at the top of the page");
    // The composer is NOT used for agent sends: whatever the user is drafting
    // stays put (the core accepts "our text is not in the composer" as landed).
    const ok = await submit(text, images, { fromAgent: true });
    if (!ok) throw new Error("CodeCraft send refused");
    await sleep(60);
  }
  function stopGeneration() {
    const st = _stream;
    if (!st) return;
    try { st.ctrl.abort(); } catch {}
    finish(st, "");
    status("Stopped", "warn");
  }

  function scanError() {
    if (_lastError) return _lastError.slice(0, 300);
    if (!hasKey()) return "CodeCraft API key missing — paste your cc_ key at the top of the page.";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text || "");
  const isBusyMsg = (text) => RE.busy.test(text || "") && !RE.auth.test(text || "");

  function modeWarning() {
    if (!isHostPage()) return "";
    if (!hasKey()) return "<b>CodeCraft API</b> — paste your <b>cc_</b> key in the field at the top (codecraftapi.com → Dashboard → API Keys), pick a model, then Start.";
    if (_lastError && RE.quota.test(_lastError)) return "<b>CodeCraft API</b> — your plan is out of tokens (HTTP 402). Upgrade at codecraftapi.com/pricing or wait for the monthly reset.";
    if (_lastError && RE.auth.test(_lastError)) return "<b>CodeCraft API</b> — the key was rejected. Create a fresh key in the dashboard and save it above.";
    return "";
  }

  async function attachImages(images) {
    if (!images || !images.length) return false;
    _pendingImages = images.slice(0, 8);
    renderAttachments();
    return true;
  }
  function clearAttachments() { _pendingImages = []; renderAttachments(); }
  const conversationKey = () => sess.id || "codecraft";

  function installSendHooks(handlers) { hooks = handlers; }

  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item) {
    if (!item) return null;
    let parent = null, ref = null;
    for (const pre of item.querySelectorAll("pre")) {
      if (pre.closest && pre.closest(".rs-chip, .cc-think")) continue;
      if (!CMD_SHAPE.test(pre.textContent || "")) continue;
      pre.classList.add("rs-tool-hide");
      item.classList.add("rs-cmd-mask");
      if (!ref && pre.parentElement) { parent = pre.parentElement; ref = pre; }
    }
    return ref ? { parent, ref } : null;
  }

  // Self-boot on the extension page (the core calls init() later, possibly
  // only when the user presses Start — the chat must work before that).
  try {
    if (typeof document !== "undefined" && document && typeof document.addEventListener === "function") {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { boot().catch(() => {}); });
      else Promise.resolve().then(() => boot().catch(() => {}));
    }
  } catch {}

  return {
    id: "codecraft",
    displayName: "CodeCraft API",
    supportsVision: true,
    reliableCounts: true,
    commandsMayAppearInThinking: false,
    // Every token is billed against the user's plan: ship the compact command
    // index and let the agent fetch per-command schemas on demand.
    compactCommandList: true,
    commandListMaxChars: 24000,
    sysMaxChars: 20000,
    promptExtra: "CodeCraft API rules: this is a raw OpenAI-compatible chat inside ORscript with NO native tools - the ONLY way to act is to write the command as text. Put every command in ONE fenced ```json code block and nothing else in that block. Do not simulate results: after a command block STOP and wait for the ORscript result message. Keep prose short; tokens are billed.",
    timings,
    thinkingSel: ".cc-think",
    init({ diag: d } = {}) {
      if (d) diag = d;
      try { document.documentElement.setAttribute("data-rs-codecraft-ver", "2026-10"); } catch {}
      boot().catch(() => {});
      diag("codecraft.init", { hasKey: hasKey(), model: settings.model, page: isHostPage() });
    },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor, barMount,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer() { return { ready: isHostPage() }; },
    async ensureComposerReady(reason) {
      await boot().catch(() => {});
      diag("codecraft.mode_ready", { reason, hasKey: hasKey(), page: isHostPage() });
      return { ready: isHostPage() && hasKey() };
    },
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    modeWarning,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
    // The body is re-rendered per token; chips anchor in the row's stable slot.
    chipAtItemLevel: true,
    chipAnchor: (item) => (item && item.querySelector(".cc-chips")) || item,
    // Page-level helpers (used by codecraft.html controls and tests).
    codecraft: {
      API_BASE, SITE, STORE_KEY, DEFAULT_MODEL, FALLBACK_MODELS, CHAT_INDEX_KEY, CHAT_KEY_PREFIX, USAGE_KEY,
      loadSettings, saveSettings, hasKey, refreshModels, newChat, submit, renderMarkdown, apiMessages, session: sess, settings,
      // 1.36.0 page extras
      requestBody, retryable, RETRY_DELAYS_MS, deriveTitle, chats: () => chatIndex, openChat, deleteChat, renameChat, pinChat, clearAllChats,
      regenerate, editMessage, exportChat, importChat, toMarkdown, toJson, toggleSettings, toggleSide, renderChats, persistLibrary,
    },
  };
})();

if (typeof window !== "undefined") window.RSProvider = RSProvider;
