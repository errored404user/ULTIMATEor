// SPDX-License-Identifier: GPL-3.0-or-later
// src/providers/stream-reader.js - isolated-world reader for the universal
// chat-stream tap (src/providers/stream-net.js, MAIN world). 1.65.0.
//
// The tap publishes the latest chat response as JSON on #rs-stream-net:
//   { rid, text, done, t, matched, kind, url, status, err, startedAt, sentAt }
// This helper gives the adaptive providers (Vani, MultiChat; until 1.89.0 also
// ClickUp Brain and Ox Alpha) one small API on top of it:
//   markSent(text)  - call right before a send: publishes a fragment of the
//                     outgoing message on <html data-rs-sent> so the tap can
//                     recognise OUR request, and marks whatever the tap holds
//                     now as consumed (a finished previous turn must never be
//                     read as the new reply).
//   current()       - the tap state for the CURRENT turn or null (nothing new
//                     since markSent, or a response that predates the send).
//   replyText()     - the current turn's reply text ("" when none).
//   genState(opts)  - "streaming" | "done" | null (null = tap has nothing, let
//                     the DOM decide). A stream that silently died (no close
//                     frame) is declared done once its text has been frozen
//                     past opts.stallMs with no stop button on the page.
//   error()         - { status, text } when the current turn's request failed
//                     (HTTP 4xx/5xx or an error frame) - surfaced instantly
//                     instead of waiting out the pre-start grace.
//   enabled()       - whether the MAIN-world tap is installed on this page.
// eslint-disable-next-line no-unused-vars
const RSStreamNet = (() => {
  "use strict";
  const NODE_ID = "rs-stream-net";
  let consumedRid = 0, sentAt = 0, lastTextLen = 0, lastGrowAt = 0, lastRid = 0;

  function latest() {
    try {
      const n = document.getElementById(NODE_ID);
      if (!n || !n.textContent) return null;
      const o = JSON.parse(n.textContent);
      return o && typeof o.rid === "number" ? o : null;
    } catch { return null; }
  }
  const enabled = () => !!document.getElementById(NODE_ID) || !!(document.documentElement && document.documentElement.hasAttribute("data-rs-stream-net"));

  // A fragment of the outgoing message that survives JSON encoding: the longest
  // run of plain characters from the LAST 1500 chars (the tail is the part that
  // differs between turns - tool results, user text - while the head is the
  // re-sent system prompt).
  function fragmentOf(text) {
    const tail = String(text || "").slice(-1500);
    const runs = tail.match(/[A-Za-z0-9 ,.:;()'_\/-]{20,80}/g) || [];
    let best = "";
    for (const r of runs) { const t = r.trim(); if (t.length > best.length) best = t; }
    if (!best) { const all = String(text || "").match(/[A-Za-z0-9 ,.:;()'_\/-]{16,80}/g) || []; for (const r of all) { const t = r.trim(); if (t.length > best.length) best = t; } }
    return best.slice(0, 80);
  }
  function markSent(text) {
    const l = latest();
    consumedRid = l ? l.rid : 0;
    lastRid = consumedRid; lastTextLen = 0; lastGrowAt = 0;
    sentAt = Date.now();
    try { document.documentElement.setAttribute("data-rs-sent", JSON.stringify({ frag: fragmentOf(text), at: sentAt })); } catch {}
    return sentAt;
  }
  function current() {
    const l = latest();
    if (!l || !l.rid) return null;
    if (l.rid === consumedRid) return null;           // the previous turn, already consumed
    if (sentAt && l.startedAt && l.startedAt < sentAt - 1500) return null; // predates this send
    return l;
  }
  const replyText = () => { const c = current(); return c && typeof c.text === "string" ? c.text : ""; };
  function genState(opts) {
    opts = opts || {};
    const c = current();
    if (!c) return null;
    const now = Date.now();
    if (c.rid !== lastRid) { lastRid = c.rid; lastTextLen = (c.text || "").length; lastGrowAt = now; }
    const len = (c.text || "").length;
    if (len !== lastTextLen) { lastTextLen = len; lastGrowAt = now; }
    // Nothing decoded yet: a matched request whose connection is still open is
    // the model thinking (Vani's reasoning models sit silent for a minute or
    // more before the first token) - report "streaming" so the core never calls
    // the turn empty while the stream is alive. Bounded to 150 s so an
    // undecodable dialect can never pin the watcher; a "maybe" says nothing and
    // the DOM decides.
    if (!len && !c.err) return (!c.done && c.matched && now - (c.startedAt || now) < 150000) ? "streaming" : null;
    if (c.done) return "done";
    if (c.err && !len) return "done";
    const stall = Number(opts.stallMs) || (c.kind === "ws" ? 4000 : 8000);
    if (!opts.stopVisible && len > 0 && now - lastGrowAt > stall) return "done"; // lost close frame
    return "streaming";
  }
  function error() {
    const c = current();
    if (!c || !c.err) return null;
    // A request we did not positively match only counts when the status is unambiguous.
    if (!c.matched && ![402, 413, 429].includes(Number(c.status))) return null;
    if (c.text && c.text.length > 40 && !/^HTTP [45]\d\d/.test(c.err)) return null; // a reply that also carried a soft error: keep the reply
    return { status: Number(c.status) || 0, text: String(c.err).slice(0, 300) };
  }
  // Human message for an HTTP failure, phrased so the core classifies it right
  // (isTooLongMsg → context_limit; the rest → provider_error / busy).
  function describe(e, site) {
    if (!e) return null;
    const s = e.status, who = site || "The site", body = String(e.text || "");
    // Body-level reasons beat the bare status: Vani answers 429 for BOTH "weekly
    // allowance used up" and "one active reply per connection"; the wording
    // below matches the adapters' allowance / busy / too-long detectors.
    if (/weekly_limit|allowance|quota|out of credits|usage limit|insufficient_(credits|quota|balance)/i.test(body)) return `${who} says the free allowance is used up (HTTP ${s || "?"}) — log in or wait for the reset, then retry.`;
    if (/concurrency_limit|concurrent|already (running|active|generating)|one active|in progress/i.test(body)) return `${who} allows one reply at a time per connection (HTTP ${s || "?"}) — try again in a moment.`;
    if (/context.{0,20}(length|limit|window)|too many tokens|token limit|maximum context|message is too long|payload too large|request entity too large/i.test(body)) return `${who} says the message is too long (HTTP ${s || "?"}) — the next turn is sent shorter.`;
    if (s === 401 || s === 403) return `${who} rejected the request (HTTP ${s}: not signed in / no access) — log in, then retry.`;
    if (s === 402) return `${who} says the AI allowance is used up (HTTP 402) — upgrade or wait, then retry.`;
    if (s === 413) return `${who} says the message is too long (HTTP 413) — the next turn is sent shorter.`;
    if (s === 429) return `${who} is rate limiting (HTTP 429: too many requests) — try again later.`;
    if (s >= 500) return `${who} server error (HTTP ${s}) — temporarily unavailable, retrying.`;
    return `${who} request failed: ${body}`;
  }
  return { latest, current, replyText, genState, error, describe, markSent, fragmentOf, enabled, _consumed: () => consumedRid };
})();

if (typeof window !== "undefined") window.RSStreamNet = RSStreamNet;
