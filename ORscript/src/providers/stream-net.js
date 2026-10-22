// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/stream-net.js - universal chat-stream tap (runs in the MAIN world).
//
// WHY THIS EXISTS (1.65.0): the adaptive adapters (Vani Chat, ClickUp Brain,
// Ox Alpha, MultiChat) discover transcript rows by SHAPE because those sites
// ship no stable role markers and we have no live DOM in the build sandbox.
// Shape reads are fragile: a reskin, a virtualised list or a syntax
// highlighter that re-renders the reply makes the extension read the wrong
// row, a truncated command, or nothing at all - every such misread costs a
// 30-60 s rescue (warm-up, pre-start or stale-turn grace) before the loop
// nudges the model again. The model's reply, by contrast, always crosses the
// network verbatim, and the stream closing is the exact moment the turn ends.
//
// This script wraps fetch, XMLHttpRequest, EventSource and WebSocket in the
// page world (an isolated-world wrap would not see the app's calls), decides
// which request is OUR chat turn, decodes the reply stream in every common
// dialect and republishes the reconstructed text + done flag + HTTP status into
// a DOM node (#rs-stream-net, JSON textContent) that the isolated content
// script (src/providers/stream-reader.js) reads. It never alters a request.
//
// Which request is the chat turn? The content script publishes what it just
// sent on <html data-rs-sent='{"frag":"...","at":ms}'>. A request counts when
// its body contains that fragment (exact or JSON-escaped), or - fallback -
// when it starts inside the send window and either streams (text/event-stream,
// NDJSON, chunked text) or hits a chat-looking URL. Background traffic
// (presence, analytics, autosave) never matches.
//
// Dialects decoded: SSE `data: {...}` (OpenAI chat.completions deltas,
// Responses API `response.output_text.delta`, Anthropic `content_block_delta`,
// Vercel AI UI-message stream `text-delta`), Vercel AI data-stream lines
// (`0:"text"`), NDJSON, plain cumulative JSON (`{answer|content|text|message}`)
// and raw text chunks. Reasoning / thinking fields are ignored on purpose.
(() => {
  "use strict";
  if (window.__rsStreamNet) return;
  window.__rsStreamNet = true;

  const NODE_ID = "rs-stream-net";
  const SEND_WINDOW_MS = 20000;   // a request this long after our send may still be the turn
  const MAX_TEXT = 400000;
  const CHAT_URL_RE = /(chat|complet|message|conversation|\bai\b|brain|assistant|stream|generat|answer|prompt|respond|\bllm\b|agent|inference|query|ask)/i;
  const STATIC_RE = /\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map|json\?v=|mp[34])(\?|$)|\/_next\/static\/|\/sockjs|\/analytics|\/telemetry|\/metrics|\/log(s|ging)?\b|\/sentry|\/track|\/beacon|\/heartbeat|\/presence|\/ping\b/i;
  const STREAM_CT_RE = /text\/event-stream|application\/(x-)?ndjson|application\/stream\+json|application\/jsonl|text\/plain|application\/octet-stream/i;

  let seq = 0;
  let latest = { rid: 0, text: "", done: true, t: 0, matched: false, kind: "", url: "", status: 0, err: "", startedAt: 0, sentAt: 0, chunks: 0 };

  const node = () => {
    let n = document.getElementById(NODE_ID);
    if (!n) {
      n = document.createElement("script");
      n.type = "application/json";
      n.id = NODE_ID;
      (document.body || document.documentElement).appendChild(n);
    }
    return n;
  };
  let publishTimer = 0, publishDirty = false;
  function publishNow() {
    publishDirty = false;
    try { node().textContent = JSON.stringify(latest); } catch {}
  }
  // Publish at most every ~40 ms while streaming (a big reply arrives in hundreds
  // of chunks); the final state is always flushed immediately.
  let publishedAt = 0;
  function publish(force) {
    latest.t = Date.now();
    if (force) { if (publishTimer) { clearTimeout(publishTimer); publishTimer = 0; } publishedAt = latest.t; publishNow(); return; }
    // Leading edge: the first token of a turn lands at once; later deltas
    // coalesce to one write per 40 ms with a trailing flush.
    if (!publishTimer && latest.t - publishedAt >= 40) { publishedAt = latest.t; publishNow(); return; }
    publishDirty = true;
    if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = 0; publishedAt = Date.now(); if (publishDirty) publishNow(); }, 40);
  }

  // ── what did the extension just send? ───────────────────────────────────
  function sentInfo() {
    try {
      const raw = document.documentElement && document.documentElement.getAttribute("data-rs-sent");
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && typeof o.at === "number" ? o : null;
    } catch { return null; }
  }
  const inSendWindow = (info, now) => !!info && now - info.at > -500 && now - info.at < SEND_WINDOW_MS;
  function bodyHasFrag(body, info) {
    if (!info || !info.frag || typeof body !== "string" || !body) return false;
    if (body.includes(info.frag)) return true;
    try { const esc = JSON.stringify(info.frag).slice(1, -1); if (esc !== info.frag && body.includes(esc)) return true; } catch {}
    return false;
  }
  const urlOf = (u) => { try { return String((u && u.url) || u || ""); } catch { return ""; } };
  const chatty = (url) => !STATIC_RE.test(url) && CHAT_URL_RE.test(url);

  // Classify an outgoing request: "matched" (our prompt is in the body), "maybe"
  // (inside the send window and chat-looking), or null (ignore).
  function classify(url, method, body) {
    const info = sentInfo(); const now = Date.now();
    if (STATIC_RE.test(url)) return null;
    if (bodyHasFrag(body, info)) return "matched";
    if (!inSendWindow(info, now)) return null;
    const m = String(method || "GET").toUpperCase();
    if (m === "POST" || m === "PUT" || m === "PATCH") return chatty(url) || (typeof body === "string" && /"(messages|prompt|message|content|query|question|input|text)"\s*:/.test(body)) ? "maybe" : null;
    return null;
  }

  // ── delta extraction ─────────────────────────────────────────────────────
  // End-of-message types. Dotted / underscored / dashed vendor forms are listed
  // explicitly (Vani `message.complete`, `response.done`, …) - NOT a generic
  // "ends with done" rule, because `text-end` / `content_block_stop` /
  // `finish-step` close a PART, not the message.
  const DONE_TYPE_RE = /^(done|finish(ed)?|complete[d]?|end|stop|message_stop|message_end|response\.completed|response\.done|finish-message|finish|final|turn_end|end_of_stream|(message|response|conversation|chat|stream|generation|completion|turn|run|answer)[._-](complete[d]?|done|end(ed)?|stop(ped)?|finish(ed)?|final))$/i;
  const ERROR_TYPE_RE = /^(error|failure|failed)$/i;
  const SKIP_KEY_RE = /^(reasoning|reasoning_content|reasoning_text|thinking|thought|thoughts|tool_calls|tool_call|function_call|citations|sources|metadata|usage|id|model|created|object|role|name|type|index|status|conversation_id|conversationId|messageId|message_id|parent_id|timestamp|time|ts)$/;
  const str = (v) => (typeof v === "string" ? v : null);

  // Returns { text, cumulative, done, error } for one decoded JSON payload.
  function extract(o, depth) {
    const out = { text: "", cumulative: false, done: false, error: "" };
    if (o == null || depth > 6) return out;
    if (typeof o === "string") { out.text = o; return out; }
    if (typeof o !== "object") return out;
    if (Array.isArray(o)) { for (const it of o) merge(out, extract(it, depth + 1)); return out; }
    const type = str(o.type) || str(o.event) || str(o.kind) || "";
    if (ERROR_TYPE_RE.test(type) || o.error) {
      const e = o.error || o.message || o.detail || o;
      out.error = typeof e === "string" ? e : (e && (e.message || e.detail || e.msg)) || (type ? type : "error");
      if (typeof out.error !== "string") { try { out.error = JSON.stringify(out.error).slice(0, 300); } catch { out.error = "error"; } }
    }
    if (DONE_TYPE_RE.test(type)) out.done = true;
    if (o.done === true || o.is_final === true || o.finished === true || o.isFinal === true || o.final === true || o.is_end === true || o.end === true) out.done = true;
    if (o.status && /^(finished|completed|done|complete|stopped|end)$/i.test(String(o.status))) out.done = true;
    // OpenAI chat.completions (delta = incremental, message = cumulative)
    if (Array.isArray(o.choices) && o.choices.length) {
      const c = o.choices[0] || {};
      const d = c.delta || {};
      if (typeof d.content === "string") out.text += d.content;
      else if (Array.isArray(d.content)) for (const p of d.content) if (p && typeof p.text === "string") out.text += p.text;
      if (typeof d.text === "string") out.text += d.text;
      if (c.message && typeof c.message.content === "string") { out.text += c.message.content; out.cumulative = true; }
      if (typeof c.text === "string") out.text += c.text;
      if (c.finish_reason) out.done = true;
      return out;
    }
    // Anthropic / Responses API / Vercel UI-message stream
    if (type === "content_block_delta" && o.delta) { if (typeof o.delta.text === "string") out.text += o.delta.text; return out; }
    if (/^response\.output_text\.delta$|^output_text\.delta$/.test(type) && typeof o.delta === "string") { out.text += o.delta; return out; }
    if (/^text[-_]delta$/i.test(type)) { out.text += str(o.delta) || str(o.textDelta) || str(o.text) || str(o.content) || ""; return out; }
    if (/^(text|text-start|text-end|reasoning|reasoning-delta|reasoning-start|reasoning-end|tool-call|tool-input|tool-result|source|file|start|start-step|step-start|step-finish|message_start|message\.start|content_block_start|content_block_stop|ping|usage|heartbeat|keepalive|tool\.[a-z_.-]+|citation|citations|sources|search\.[a-z_.-]+)$/i.test(type) && !/^text$/i.test(type)) return out;
    // Generic objects: direct text-bearing keys first.
    const direct = str(o.delta) || str(o.textDelta) || str(o.token) || str(o.output_text) || str(o.text) || str(o.answer) || str(o.content) || str(o.response) || str(o.reply) || str(o.output) || str(o.result) || str(o.completion) || str(o.generated_text);
    if (direct != null) {
      out.text += direct;
      // Keys that carry the WHOLE text so far rather than a piece.
      if (o.answer != null || o.response != null || o.reply != null || o.result != null || o.completion != null || o.generated_text != null || o.full_text != null || o.cumulative === true) out.cumulative = true;
      if (typeof o.full_text === "string") { out.text = o.full_text; out.cumulative = true; }
      return out;
    }
    if (typeof o.message === "string") { out.text += o.message; out.cumulative = !!o.done; return out; }
    // Nested carriers: {message:{content}}, {delta:{content}}, {data:{...}}, {payload:{...}}, {output:{...}}
    for (const k of ["delta", "message", "data", "payload", "output", "result", "response", "chunk", "body", "item", "part", "value"]) {
      const v = o[k];
      if (v && typeof v === "object" && !SKIP_KEY_RE.test(k)) { const sub = extract(v, depth + 1); if (sub.text || sub.done || sub.error) { merge(out, sub); if (k === "message" && !sub.cumulative && typeof v.content === "string" && !o.delta) out.cumulative = true; return out; } }
    }
    return out;
  }
  function merge(a, b) { if (b.text) { a.text += b.text; if (b.cumulative) a.cumulative = true; } if (b.done) a.done = true; if (b.error && !a.error) a.error = b.error; }

  // Fold one decoded piece into the live accumulator, resolving cumulative vs.
  // incremental: a piece that restates everything so far replaces the text.
  function fold(acc, piece) {
    if (piece.error && !acc.err) acc.err = String(piece.error).slice(0, 300);
    if (piece.text) {
      const t = piece.text;
      if (piece.cumulative || (t.length > 24 && acc.text && t.startsWith(acc.text) && t.length >= acc.text.length)) acc.text = t;
      else if (t.length > 24 && acc.text.endsWith(t)) { /* duplicate frame */ }
      else acc.text += t;
      if (acc.text.length > MAX_TEXT) acc.text = acc.text.slice(0, MAX_TEXT);
      acc.chunks++;
    }
    if (piece.done) acc.done = true;
  }
  function tryJSON(s) { try { return JSON.parse(s); } catch { return undefined; } }
  // One line of a streamed body in any dialect.
  function foldLine(acc, raw) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) return;
    let s = line; let isData = false;
    if (/^event:\s*/i.test(s)) { const ev = s.replace(/^event:\s*/i, "").trim(); if (DONE_TYPE_RE.test(ev)) acc.pendingDone = true; if (ERROR_TYPE_RE.test(ev)) acc.pendingErr = true; return; }
    if (/^(id|retry):/i.test(s)) return;
    if (/^data:/i.test(s)) {
      s = s.replace(/^data:\s?/i, ""); isData = true;
      if (s.trim() === "[DONE]" || s.trim() === "DONE") { acc.done = true; return; }
    } else {
      // Vercel AI data-stream protocol: `<code>:<json>` per line.
      const m = s.match(/^([0-9a-z]{1,2}):(.*)$/i);
      if (m) {
        const code = m[1], payload = m[2];
        if (code === "0") { const v = tryJSON(payload); fold(acc, { text: typeof v === "string" ? v : "" }); return; }
        if (code === "3") { const v = tryJSON(payload); fold(acc, { error: typeof v === "string" ? v : "stream error" }); return; }
        if (code === "d" || code === "e") { acc.done = true; return; }
        return; // 2 data, 8 annotations, 9/a tool calls, g reasoning, f start - ignored
      }
    }
    const o = tryJSON(s);
    if (o === undefined) { if (isData) fold(acc, { text: s }); else if (acc.kind === "text") fold(acc, { text: s + "\n" }); return; }
    const piece = extract(o, 0);
    if (acc.pendingErr && !piece.error) piece.error = typeof o === "string" ? o : (o && (o.message || o.error)) || "stream error";
    if (acc.pendingDone) piece.done = true;
    acc.pendingDone = false; acc.pendingErr = false;
    fold(acc, piece);
  }

  function newAcc(url, kind, matched) {
    const acc = { rid: ++seq, text: "", done: false, t: Date.now(), matched, kind, url: String(url).slice(0, 200), status: 0, err: "", startedAt: Date.now(), sentAt: (sentInfo() || {}).at || 0, chunks: 0, pendingDone: false, pendingErr: false, buf: "" };
    return acc;
  }
  // A fresher accumulator wins the node; a stale "maybe" never overwrites a
  // live "matched" turn.
  function adopt(acc) {
    if (latest && !latest.done && latest.matched && !acc.matched && latest.rid !== acc.rid) return false;
    latest = acc; publish(true); return true;
  }
  function feedChunk(acc, chunk, final) {
    acc.buf += chunk;
    let idx;
    while ((idx = acc.buf.indexOf("\n")) >= 0) { foldLine(acc, acc.buf.slice(0, idx)); acc.buf = acc.buf.slice(idx + 1); }
    if (final && acc.buf) { foldLine(acc, acc.buf); acc.buf = ""; }
    if (latest === acc) publish(final);
  }
  function finish(acc) {
    acc.done = true;
    if (latest === acc) publish(true);
  }
  // Whole (non-streamed) JSON reply.
  function foldWhole(acc, text, ct) {
    const o = tryJSON(text);
    if (o !== undefined) { const piece = extract(o, 0); if (piece.text) { acc.text = piece.text; acc.chunks++; } if (piece.error) acc.err = String(piece.error).slice(0, 300); }
    else if (/text\//i.test(ct || "") || !/json/i.test(ct || "")) feedChunk(acc, text, true);
    finish(acc);
  }

  async function consumeResponse(res, acc) {
    const ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
    acc.status = res.status || 0;
    acc.kind = /event-stream/i.test(ct) ? "sse" : /ndjson|jsonl|stream\+json/i.test(ct) ? "ndjson" : /json/i.test(ct) ? "json" : "text";
    if (res.status >= 400) {
      let body = ""; try { body = await res.text(); } catch {}
      acc.err = `HTTP ${res.status}${body ? ": " + body.replace(/\s+/g, " ").slice(0, 300) : ""}`;
      adopt(acc); finish(acc); return;
    }
    if (!adopt(acc)) return;
    if (!res.body || !res.body.getReader || acc.kind === "json") {
      let body = ""; try { body = await res.text(); } catch {}
      foldWhole(acc, body, ct); return;
    }
    const reader = res.body.getReader(); const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        feedChunk(acc, dec.decode(value, { stream: true }), false);
      }
      feedChunk(acc, dec.decode(), true);
    } catch (e) { if (!acc.text) acc.err = acc.err || ("stream aborted: " + (e && e.message || e)); }
    finish(acc);
  }

  // ── fetch ────────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  function watch(p, url, cls) {
    p.then((res) => {
      try {
        const ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
        // A "maybe" must look like a reply: streaming or JSON (or an error), never HTML / static.
        if (cls === "matched" || STREAM_CT_RE.test(ct) || /json/i.test(ct) || res.status >= 400) consumeResponse(res.clone(), newAcc(url, "", cls === "matched"));
      } catch {}
    }).catch(() => {});
  }
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = urlOf(input);
        const method = (init && init.method) || (input && input.method) || "GET";
        const bodyStr = typeof (init && init.body) === "string" ? init.body : "";
        const cls = classify(url, method, bodyStr);
        if (!bodyStr && input && typeof input.clone === "function" && typeof input.text === "function" && /^(POST|PUT|PATCH)$/i.test(input.method || "") && (cls || inSendWindow(sentInfo(), Date.now()) || chatty(url))) {
          // A Request object carries its body internally: peek at a clone so a
          // "maybe" can be upgraded to a positive match on our fragment.
          input.clone().text().then((t) => { const c2 = classify(url, input.method, t) || cls; if (c2) watch(p, url, c2); }).catch(() => { if (cls) watch(p, url, cls); });
        } else if (cls) watch(p, url, cls);
      } catch {}
      return p;
    };
  }

  // ── XMLHttpRequest (Angular HttpClient, older apps) ──────────────────────
  try {
    const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && XP.open && XP.send) {
      const oOpen = XP.open, oSend = XP.send;
      XP.open = function (method, url) { try { this.__rsUrl = String(url || ""); this.__rsMethod = String(method || "GET"); } catch {} return oOpen.apply(this, arguments); };
      XP.send = function (body) {
        try {
          const cls = classify(this.__rsUrl || "", this.__rsMethod, typeof body === "string" ? body : "");
          if (cls) {
            const xhr = this; let acc = null, seen = 0, adopted = false;
            const ct = () => { try { return xhr.getResponseHeader("content-type") || ""; } catch { return ""; } };
            const ensure = () => { if (!acc) { acc = newAcc(xhr.__rsUrl, "", cls === "matched"); acc.status = xhr.status || 0; const c = ct(); acc.kind = /event-stream/i.test(c) ? "sse" : /json/i.test(c) && !/ndjson|jsonl/i.test(c) ? "json" : /ndjson|jsonl/i.test(c) ? "ndjson" : "text"; adopted = adopt(acc); } return adopted; };
            const onProgress = () => {
              try {
                if (xhr.readyState < 3) return;
                if (xhr.responseType && xhr.responseType !== "text") return;
                const c = ct();
                if (cls !== "matched" && !(STREAM_CT_RE.test(c) || /json/i.test(c) || xhr.status >= 400)) return;
                if (!ensure()) return;
                if (acc.kind === "json" || xhr.status >= 400) return; // whole body on load
                const txt = xhr.responseText || ""; if (txt.length > seen) { feedChunk(acc, txt.slice(seen), false); seen = txt.length; }
              } catch {}
            };
            const onLoad = () => {
              try {
                if (xhr.responseType && xhr.responseType !== "text" && xhr.responseType !== "json") return;
                const c = ct();
                if (cls !== "matched" && !(STREAM_CT_RE.test(c) || /json/i.test(c) || xhr.status >= 400)) return;
                if (!ensure()) return;
                acc.status = xhr.status || 0;
                if (xhr.status >= 400) { let b = ""; try { b = String(xhr.responseType === "json" ? JSON.stringify(xhr.response) : xhr.responseText || ""); } catch {} acc.err = `HTTP ${xhr.status}${b ? ": " + b.replace(/\s+/g, " ").slice(0, 300) : ""}`; finish(acc); return; }
                if (acc.kind === "json") { let b = ""; try { b = xhr.responseType === "json" ? JSON.stringify(xhr.response) : xhr.responseText || ""; } catch {} foldWhole(acc, b, c); return; }
                const txt = xhr.responseText || ""; if (txt.length > seen) feedChunk(acc, txt.slice(seen), true); else feedChunk(acc, "", true);
                finish(acc);
              } catch {}
            };
            xhr.addEventListener("progress", onProgress); xhr.addEventListener("readystatechange", onProgress);
            xhr.addEventListener("load", onLoad); xhr.addEventListener("error", () => { if (acc) { acc.err = acc.err || "network error"; finish(acc); } }); xhr.addEventListener("abort", () => { if (acc) finish(acc); });
          }
        } catch {}
        return oSend.apply(this, arguments);
      };
    }
  } catch {}

  // ── EventSource (server-push replies after a POST that started the turn) ──
  try {
    const OES = window.EventSource;
    if (typeof OES === "function") {
      const Wrapped = function (url, cfg) {
        const es = cfg === undefined ? new OES(url) : new OES(url, cfg);
        try {
          const u = urlOf(url);
          if (chatty(u) && inSendWindow(sentInfo(), Date.now())) {
            const acc = newAcc(u, "sse", false); let adopted = false;
            es.addEventListener("message", (ev) => { try { if (!adopted) adopted = adopt(acc); if (!adopted) return; foldLine(acc, "data: " + String(ev.data == null ? "" : ev.data)); if (latest === acc) publish(acc.done); if (acc.done) { try { es.close(); } catch {} } } catch {} });
            es.addEventListener("error", () => { if (adopted && es.readyState === 2) finish(acc); });
          }
        } catch {}
        return es;
      };
      Wrapped.prototype = OES.prototype; Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSED = 2;
      window.EventSource = Wrapped;
    }
  } catch {}

  // ── WebSocket (replies pushed over the app socket) ───────────────────────
  try {
    const WSP = window.WebSocket && window.WebSocket.prototype;
    if (WSP && WSP.send) {
      const oSend = WSP.send;
      WSP.send = function (data) {
        try {
          if (typeof data === "string" && bodyHasFrag(data, sentInfo())) {
            const ws = this;
            if (!ws.__rsTapped) {
              ws.__rsTapped = true;
              ws.addEventListener("message", (ev) => {
                try {
                  if (typeof ev.data !== "string" || !ws.__rsAcc) return;
                  const acc = ws.__rsAcc; if (acc.done) return;
                  let s = ev.data; const m = s.match(/^\d+(\[.*\])?$/s); // socket.io framing: 42["event",{...}]
                  if (m) { if (!m[1]) return; const arr = tryJSON(m[1]); if (Array.isArray(arr)) { const payload = arr.length > 1 ? arr[1] : arr[0]; const piece = extract(payload, 0); if (typeof arr[0] === "string" && DONE_TYPE_RE.test(arr[0])) piece.done = true; fold(acc, piece); if (latest === acc) publish(acc.done); } return; }
                  foldLine(acc, s); if (latest === acc) publish(acc.done);
                } catch {}
              });
            }
            ws.__rsAcc = newAcc(ws.url || "ws", "ws", true); adopt(ws.__rsAcc);
          }
        } catch {}
        return oSend.apply(this, arguments);
      };
    }
  } catch {}

  // Test / inspection hook (page world only).
  window.__rsStreamNetState = () => latest;
  window.__rsStreamNetFold = (lines, kind) => { const acc = newAcc("test", kind || "sse", true); for (const l of lines) foldLine(acc, l); return { text: acc.text, done: acc.done, err: acc.err }; };
})();
