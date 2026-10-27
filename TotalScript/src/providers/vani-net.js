// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/vani-net.js - Vani Chat request shaper (MAIN world, c.vani.ai).
//
// What Vani's web client really does (observed transport, Oct 2026):
//   POST /api/public/chat   (guest)    {"model", "messages":[{role,content}…]}
//   POST /api/chat/stream   (account)  {"model", "conversation_id", "messages":[…], …}
//   Reply: SSE  data:{"type":"content.delta","text":…} … {"type":"message.complete"}
// Two things make the agent loop slow and flaky there:
//   1. Vani prepends its own ~700-token platform prompt (web search first,
//      Document / Slides / Design side panels, "tools" the model may propose).
//      TotalScript's protocol arrives later inside a USER message, so the guest models
//      drift: they search the web before answering, write a "document" instead
//      of the command, or say they "cannot use JSON blocks".
//   2. The client resends the WHOLE conversation on every turn. With a 14 k
//      character bootstrap plus tool results the request grows by thousands of
//      tokens per step; each turn is slower than the last until the model
//      refuses with a context error.
// This tap runs at document_start and, ONLY while the TotalScript agent is attached
// (<html data-rs-agent="on|starting">, set by src/core/main.js):
//   - pins the protocol at the top of the LAST user message of every chat
//     request (the model reads it right before answering; nothing on screen
//     changes - the page's own transcript state is untouched);
//   - keeps the request small: when the history passes HISTORY_TRIM_AT
//     characters the first four messages (bootstrap, reply, catalogue, reply) and the last
//     HISTORY_KEEP_TAIL messages are kept, the middle is replaced by a one-line
//     note inside the first kept user message (role alternation preserved).
// With the agent off, requests pass through untouched. Any failure inside the
// tap falls through to the original request. The stream itself is read by
// src/providers/stream-net.js; the fragment it matches on lives at the END of
// the message, which this tap never edits.
(() => {
  "use strict";
  if (window.__rsVaniNet) return;
  window.__rsVaniNet = true;

  const MARK = "[TotalScript bridge]";
  const CHAT_URL_RE = /\/api\/(public\/chat|chat\/stream|chat\/completions|chat|conversations\/[^/]+\/messages|messages)(\?|$)/i;
  const PIN = [
    MARK + " This chat is live-linked to the user's Roblox Studio by a browser extension that EXECUTES the command you write and pastes the result back as the next user message.",
    "Reply with exactly ONE command as a fenced ```json block containing {\"command\":\"name\",\"params\":{...}} (execute_luau uses the ###LUA### form), then stop and wait for the result.",
    "Writing the block IS the tool call: never say you cannot run commands or use JSON blocks, never describe a command instead of writing it.",
    // 1.76.0 — logged-in Vani hands the model its own tool list (web search,
    // Document / Slides / Design, code runs). Models then answer "I can only use
    // the tools I was given" and write prose. Say it outright.
    "You are NOT being asked to execute anything yourself and you do not need any tool for this: the extension on this page runs the block the moment you post it. Vani's own tools (web search, Document, Slides, Design, code execution) cannot reach Roblox Studio - ignore them while this chat is linked.",
    "Do not search the web. Do not create a Document, Slides, Design, canvas or any side-panel artifact, and do not propose Vani tools - everything goes in this chat reply as text. One short line of prose at most; the command block is the work.",
    // 1.78.1 — reported live: the model SHOWED the block (escaped backticks /
    // quotes, visible as plain text on the page) instead of writing a fence.
    "Write the fence as real markdown: a line that is only ```json, the object on the next line, a line that is only ```. Never escape backticks, quotes or braces with backslashes and never put the block inside quotation marks or inline code.",
  ].join(" ");
  // Head = bootstrap + first reply + the list_commands result + its reply (the
  // command catalogue must survive the cut or the model starts guessing names).
  const HISTORY_KEEP_HEAD = 4;
  const HISTORY_KEEP_TAIL = 10;
  const HISTORY_TRIM_AT = 70000; // total characters of message content

  const agentState = () => {
    try { return (document.documentElement && document.documentElement.getAttribute("data-rs-agent")) || ""; } catch { return ""; }
  };
  const agentOn = () => /^(on|starting)$/.test(agentState());

  const contentText = (c) => {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n");
    if (c && typeof c === "object" && typeof c.text === "string") return c.text;
    return "";
  };
  // 1.78.1 — the field a message keeps its text in: `content` (observed), or
  // `text` / `message` / `parts` should the client change shape. Shaping a
  // message we cannot read would otherwise silently stop ("request NOT shaped").
  const textField = (m) => {
    if (!m || typeof m !== "object") return "";
    for (const k of ["content", "text", "message", "parts"]) if (m[k] != null && contentText(m[k])) return k;
    return "";
  };
  // Prepend `prefix` to a message's content whatever shape it has. Returns the
  // new content or undefined when the shape is unknown.
  function withPrefix(c, prefix) {
    if (typeof c === "string") return prefix + c;
    if (Array.isArray(c)) {
      const i = c.findIndex((p) => p && typeof p.text === "string");
      if (i === -1) return undefined;
      const out = c.slice(); out[i] = Object.assign({}, c[i], { text: prefix + c[i].text }); return out;
    }
    if (c && typeof c === "object" && typeof c.text === "string") return Object.assign({}, c, { text: prefix + c.text });
    return undefined;
  }

  // Returns {messages, changed, pinned, trimmed}.
  function patchMessages(messages) {
    const res = { messages, changed: false, pinned: false, trimmed: 0 };
    if (!Array.isArray(messages) || !messages.length || !agentOn()) return res;
    let out = messages.slice();
    // 1. history trim (before pinning so the pin always lands on the live message)
    const total = out.reduce((n, m) => n + contentText(m && m[textField(m) || "content"]).length, 0);
    if (out.length > HISTORY_KEEP_HEAD + HISTORY_KEEP_TAIL + 1 && total > HISTORY_TRIM_AT) {
      // The tail must start on a USER message so roles keep alternating.
      let cut = out.length - HISTORY_KEEP_TAIL;
      while (cut > HISTORY_KEEP_HEAD && !(out[cut] && out[cut].role === "user")) cut--;
      if (cut > HISTORY_KEEP_HEAD && out[cut] && out[cut].role === "user") {
        const dropped = cut - HISTORY_KEEP_HEAD;
        const note = `[TotalScript: ${dropped} earlier turn${dropped === 1 ? "" : "s"} omitted to keep this request fast - the task from the first message still stands; the latest results follow.]\n\n`;
        const first = Object.assign({}, out[cut]);
        const fk = textField(first) || "content";
        const nc = withPrefix(first[fk], note);
        if (nc !== undefined) {
          first[fk] = nc;
          out = out.slice(0, HISTORY_KEEP_HEAD).concat([first], out.slice(cut + 1));
          res.trimmed = dropped; res.changed = true;
        }
      }
    }
    // 2. protocol pin on the last user message
    let li = -1;
    for (let i = out.length - 1; i >= 0; i--) if (out[i] && out[i].role === "user") { li = i; break; }
    if (li >= 0) {
      const lk = textField(out[li]) || "content";
      const text = contentText(out[li][lk]);
      if (text && !text.includes(MARK)) {
        const nc = withPrefix(out[li][lk], PIN + "\n\n");
        if (nc !== undefined) { out[li] = Object.assign({}, out[li], { [lk]: nc }); res.pinned = true; res.changed = true; }
      }
    }
    res.messages = out;
    return res;
  }

  // Patches a JSON request body (string). Returns the new string or null when
  // nothing had to change.
  function patchBody(body) {
    if (typeof body !== "string" || body.length < 2 || body.length > 8 * 1024 * 1024) return null;
    if (body[0] !== "{" || !/"messages"\s*:/.test(body)) return null;
    let obj;
    try { obj = JSON.parse(body); } catch { return null; }
    if (!obj || !Array.isArray(obj.messages)) return null;
    const r = patchMessages(obj.messages);
    if (!r.changed) return null;
    obj.messages = r.messages;
    try { console.log("[rs-vani-net] shaped chat request", { agent: agentState() || "off", pinned: r.pinned, trimmed: r.trimmed, messages: obj.messages.length }); } catch {}
    noteShaped({ pinned: r.pinned, trimmed: r.trimmed, messages: obj.messages.length });
    return JSON.stringify(obj);
  }
  // 1.76.0 — visible shaping status. The adapter (isolated world) reads these
  // two attributes and the core shows them in its toasts, so a user without
  // the console can tell whether the protocol pin actually reached Vani:
  //   data-rs-vani-shaped   = JSON {n, pinned, trimmed, messages, url, at}  (last shaped request)
  //   data-rs-vani-unshaped = JSON {n, why, url, at}  (a chat-looking request passed while the
  //                           agent was on but could not be shaped: not JSON, no messages[] …)
  let shapedN = 0, unshapedN = 0, lastUrl = "";
  const pathOf = (u) => { try { return new URL(String(u || ""), location.href).pathname; } catch { return String(u || "").slice(0, 80); } };
  function noteShaped(info) {
    try { document.documentElement.setAttribute("data-rs-vani-shaped", JSON.stringify(Object.assign({ n: ++shapedN, url: pathOf(lastUrl), at: Date.now() }, info))); } catch {}
  }
  function noteUnshaped(why, url) {
    try { document.documentElement.setAttribute("data-rs-vani-unshaped", JSON.stringify({ n: ++unshapedN, why: String(why || "").slice(0, 80), url: pathOf(url), at: Date.now() })); } catch {}
  }
  // Why a chat-looking body could not be shaped (for the status attribute only).
  function unshapedReason(body) {
    if (typeof body !== "string" || !body.length) return "body not text";
    if (body.length > 8 * 1024 * 1024) return "body too large";
    if (body[0] !== "{") return "body not a JSON object";
    if (!/"messages"\s*:/.test(body)) return "no messages field";
    let obj; try { obj = JSON.parse(body); } catch { return "body not valid JSON"; }
    if (!obj || !Array.isArray(obj.messages)) return "messages is not an array";
    if (!obj.messages.some((m) => m && m.role === "user")) return "no user message";
    return "";
  }
  // Shape a chat body and record the outcome; returns the patched string or null.
  function shapeOrNote(url, body) {
    lastUrl = url;
    const patched = patchBody(body);
    if (patched) return patched;
    if (agentOn() && CHAT_URL_RE.test(String(url || ""))) { const why = unshapedReason(body); if (why) noteUnshaped(why, url); }
    return null;
  }
  window.__rsVaniPatchBody = patchBody; // exposed for tests / console diagnosis
  window.__rsVaniPatchMessages = patchMessages;
  window.__rsVaniShapeOrNote = (url, body) => shapeOrNote(url, body);

  const looksLikeChat = (url, body) =>
    CHAT_URL_RE.test(String(url || "")) || (typeof body === "string" && body[0] === "{" && /"messages"\s*:\s*\[/.test(body));

  // ── fetch ──────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      try {
        if (!agentOn()) return origFetch.apply(this, args);
        const input = args[0], init = args[1];
        if (typeof Request !== "undefined" && input instanceof Request && !(init && init.body != null)) {
          const method = String(input.method || "GET").toUpperCase();
          if (method === "POST" && (CHAT_URL_RE.test(input.url || "") || /json/i.test((input.headers && input.headers.get("content-type")) || ""))) {
            const req = input;
            return req.clone().text().then((body) => {
              const patched = looksLikeChat(req.url, body) ? shapeOrNote(req.url, body) : null;
              if (!patched) return origFetch.call(this, req, init);
              return origFetch.call(this, new Request(req, { body: patched }));
            }).catch(() => origFetch.apply(this, args));
          }
          return origFetch.apply(this, args);
        }
        const url = input instanceof Request ? input.url : String(input || "");
        const method = String((init && init.method) || "GET").toUpperCase();
        if (method === "POST" && init && looksLikeChat(url, typeof init.body === "string" ? init.body : "")) {
          if (typeof init.body === "string") {
            const patched = shapeOrNote(url, init.body);
            if (patched) args[1] = Object.assign({}, init, { body: patched });
          } else if (agentOn() && init.body != null) {
            // A chat POST whose body is not a string (FormData, Blob, stream):
            // we cannot pin it - say so instead of failing silently.
            noteUnshaped("body is " + (init.body && init.body.constructor && init.body.constructor.name || typeof init.body), url);
          }
        }
      } catch {}
      return origFetch.apply(this, args);
    };
  }

  // ── XMLHttpRequest (not used by Vani today; kept so a transport change cannot switch the tap off) ──
  try {
    const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && XP.open && XP.send) {
      const origOpen = XP.open, origSend = XP.send;
      XP.open = function (method, url, ...rest) {
        try { this.__rsVUrl = String(url || ""); this.__rsVMethod = String(method || "GET").toUpperCase(); } catch {}
        return origOpen.call(this, method, url, ...rest);
      };
      XP.send = function (body) {
        try {
          if (agentOn() && this.__rsVMethod === "POST" && typeof body === "string" && looksLikeChat(this.__rsVUrl, body)) {
            const patched = shapeOrNote(this.__rsVUrl, body);
            if (patched) body = patched;
          }
        } catch {}
        return origSend.call(this, body);
      };
    }
  } catch {}

  try { document.documentElement.setAttribute("data-rs-vani-net", "1.78"); } catch {}
  try { console.log("[rs-vani-net] active"); } catch {}
})();
