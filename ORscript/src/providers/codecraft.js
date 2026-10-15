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
  const settings = { key: "", model: DEFAULT_MODEL, temperature: null };
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
      if (hasChromeStorage()) await new Promise((res) => chrome.storage.local.set({ [STORE_KEY]: { key: settings.key, model: settings.model, temperature: settings.temperature } }, res));
      else if (window.localStorage) localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch {}
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
  };
  const isHostPage = () => !!ui.log && !!ui.input;

  // ---------- session / transcript ----------
  const sess = { id: "", messages: [], seq: 0 };
  const newId = () => "cc" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const sessKey = () => "cc:" + sess.id;
  function persist() {
    try {
      if (!window.sessionStorage) return;
      const slim = sess.messages.map((m) => ({ role: m.role, content: m.content, thinking: m.thinking || "", images: (m.images || []).slice(0, 4), error: m.error || "" }));
      sessionStorage.setItem(sessKey(), JSON.stringify(slim));
    } catch {}
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
    art.appendChild(who);
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
    msg.el = art;
    msg.bodyEl = body;
    paintBody(msg, true);
    return art;
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
  }
  function startSession(id) {
    sess.id = id || newId();
    setHash();
    clearTranscript();
    try {
      const raw = window.sessionStorage && sessionStorage.getItem(sessKey());
      if (raw) for (const m of JSON.parse(raw)) pushMessage(Object.assign({}, m));
    } catch {}
    persist();
  }
  function newChat() {
    if (_stream) stopGeneration();
    startSession(newId());
    _lastError = "";
    _pendingImages = [];
    renderAttachments();
    if (ui.input) { ui.input.value = ""; ui.input.focus(); }
    status("New chat");
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
    const toApi = (m) => {
      if (m.role === "user" && m.images && m.images.length) {
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
      if (prev && prev.role === m.role && typeof prev.content === "string" && typeof m.content === "string") prev.content += "\n\n" + m.content;
      else merged.push(m);
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
    const imgs = (images && images.length ? images : _pendingImages).slice(0, 8);
    _pendingImages = [];
    renderAttachments();
    if (!text.trim() && !imgs.length) return false;
    if (!hasKey()) { status("Paste your CodeCraft API key first (cc_…)", "warn"); try { ui.key && ui.key.focus(); } catch {} return false; }
    if (_stream) stopGeneration();
    _lastError = "";
    pushMessage({ role: "user", content: text, images: imgs });
    const reply = pushMessage({ role: "assistant", content: "", thinking: "", model: settings.model });
    const ctrl = new AbortController();
    _stream = { ctrl, msg: reply, startedAt: Date.now(), lastAt: Date.now(), firstTokenAt: 0 };
    setBusy(true);
    status(`Sending to ${settings.model}…`);
    paintBody(reply, false);
    diag("codecraft.send", { model: settings.model, textLen: text.length, images: imgs.length, history: sess.messages.length, agent: !!opts.fromAgent });
    runStream(_stream).catch(() => {});
    return true;
  }

  async function runStream(st) {
    const { ctrl, msg } = st;
    const body = { model: settings.model || DEFAULT_MODEL, messages: apiMessages(), stream: true };
    if (settings.temperature != null && settings.temperature !== "") body.temperature = Number(settings.temperature);
    let res;
    try {
      res = await fetch(API_BASE + "/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: "Bearer " + settings.key.trim() },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return finish(st, ctrl.signal.aborted ? "" : "Network error reaching codecraftapi.com: " + (e && e.message || e));
    }
    if (!res.ok) {
      let t = ""; try { t = await res.text(); } catch {}
      return finish(st, errorText(res.status, t));
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
    const queuePaint = () => {
      if (paintQueued) return;
      paintQueued = true;
      requestAnimationFrame(() => { paintQueued = false; if (msg.done) return; paintBody(msg, false); scrollToEnd(); });
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
      status(`${settings.model} · ${secs}s${u.total_tokens ? ` · ${u.total_tokens} tokens` : ""}${st.finish && st.finish !== "stop" ? ` · finish=${st.finish}` : ""}`, "ok");
      if (st.finish === "length") msg.truncated = true;
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
    if (ui.key) ui.key.value = settings.key || "";
    fillModels();
    status(hasKey() ? `key ${maskKey(settings.key)} · ${settings.model}` : "No API key yet — create one at codecraftapi.com → Dashboard → API Keys", hasKey() ? "ok" : "warn");
    const m = (location.hash || "").match(/#c=([A-Za-z0-9]+)/);
    startSession(m ? m[1] : newId());
    refreshModels();

    const onSave = async () => {
      const k = String(ui.key && ui.key.value || "").trim();
      await saveSettings({ key: k });
      if (!hasKey()) { status("That does not look like a CodeCraft key (cc_…)", "warn"); return; }
      status(`Saved key ${maskKey(k)} — loading models…`, "ok");
      await refreshModels();
    };
    if (ui.keySave) ui.keySave.addEventListener("click", onSave);
    if (ui.key) ui.key.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onSave(); } });
    if (ui.model) ui.model.addEventListener("change", () => { saveSettings({ model: ui.model.value }); status(`Model: ${ui.model.value}`, "ok"); });
    if (ui.newChat) ui.newChat.addEventListener("click", newChat);
    if (ui.stop) ui.stop.addEventListener("click", () => { stopGeneration(); if (hooks) try { hooks.onNativeStop(); } catch {} });
    if (ui.log) ui.log.addEventListener("scroll", () => { const l = ui.log; _autoScroll = l.scrollHeight - l.scrollTop - l.clientHeight < 80; });
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
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); userSend(); }
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
    return { parent: comp, before: comp.firstElementChild || null };
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
    if (ui.input) { ui.input.value = ""; autoGrow(); }
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
    codecraft: { API_BASE, SITE, STORE_KEY, DEFAULT_MODEL, FALLBACK_MODELS, loadSettings, saveSettings, hasKey, refreshModels, newChat, submit, renderMarkdown, apiMessages, session: sess, settings },
  };
})();

if (typeof window !== "undefined") window.RSProvider = RSProvider;
