"use strict";
// Focused regressions for v3's explicit no-submit and single-commit contracts
// in submitAndGetBase (plus the existing ChatGPT truncation guard).
// The real core function is evaluated with deterministic provider stubs; no
// site, account, model, or network is used.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const main = fs.readFileSync(path.join(__dirname, "../src/core/main.js"), "utf8");
const chatgpt = fs.readFileSync(path.join(__dirname, "../src/providers/chatgpt.js"), "utf8");
const start = main.indexOf("  async function submitAndGetBase(text, images) {");
const end = main.indexOf("\n  // ════════════════════════════════════════════════════════════════════════\n  //  RESPONSE WATCHER", start);
assert(start >= 0 && end > start, "submitAndGetBase extraction markers must remain stable");
const submitSource = main.slice(start, end);
const truncateStart = chatgpt.indexOf("  function truncateForSend(text) {");
const truncateEnd = chatgpt.indexOf("\n  // Select the whole composer", truncateStart);
assert(truncateStart >= 0 && truncateEnd > truncateStart, "ChatGPT truncation extraction markers must remain stable");
const truncateSource = chatgpt.slice(truncateStart, truncateEnd);
const maxChars = Number(chatgpt.match(/const SEND_MAX_CHARS = (\d+)/)?.[1]);
const maxLines = Number(chatgpt.match(/const SEND_MAX_LINES = (\d+)/)?.[1]);
const truncateForSend = new Function("window", "SEND_MAX_CHARS", "SEND_MAX_LINES", "diag", `${truncateSource}\nreturn truncateForSend;`)({ __rsLimitOutgoing: null }, maxChars, maxLines, () => {});
class SendAbortedError extends Error {}

function makeHarness({ typeAndSend, scanError = () => null, isGenerating = () => false, onWaitPoll = () => {}, id = "chatgpt", typeAndSendFalseMeansNoSubmit = true, typeAndSendSingleCommit = false } = {}) {
  let editor = "";
  let userCount = 0;
  let calls = 0;
  const diagnostics = [];
  const banners = [];
  const A = { _lastSubmit: null, requestSeq: 0, stop: false, starting: false, running: false };
  const P = {
    id,
    displayName: id === "chatgpt" ? "ChatGPT" : "Legacy provider",
    typeAndSendFalseMeansNoSubmit,
    typeAndSendSingleCommit,
    isBusyNow: () => false,
    lastAssistant: () => null,
    streamLen: () => 0,
    isGenerating,
    assistantCount: () => 0,
    userCount: () => userCount,
    editorText: () => editor,
    scanError,
    async typeAndSend(text, images) {
      calls++;
      return typeAndSend
        ? typeAndSend({ text, images, calls, setEditor: (v) => { editor = v; }, addUser: () => { userCount++; } })
        : true;
    },
  };
  const ui = {
    inputCover() {},
    banner(...args) { banners.push(args); },
  };
  const diag = (event, data) => diagnostics.push({ event, data: data || {} });
  const waitFor = async (predicate, timeout) => {
    for (let i = 0; i < 10; i++) {
      if (predicate()) return true;
      onWaitPoll(i, timeout);
      await Promise.resolve();
    }
    return false;
  };
  const makeSubmit = new Function(
    "A", "P", "ui", "diag", "captureSendToken", "sleep", "waitFor", "waitVisible",
    "jitterBeforeSend", "scheduleSweep", "document", "bgMode", "SendAbortedError", "performance", "setTimeout",
    `${submitSource}\nreturn submitAndGetBase;`
  );
  const submit = makeSubmit(
    A, P, ui, diag, () => {}, async () => {}, waitFor, async () => true, async () => {}, () => {},
    { hidden: false }, false, SendAbortedError, { now: () => Date.now() }, () => 0
  );
  return { submit, A, P, diagnostics, banners, calls: () => calls };
}

(async () => {
  {
    const h = makeHarness({
      typeAndSend({ calls, addUser, setEditor }) {
        if (calls === 1) return false; // ChatGPT saw Stop before issuing a submit.
        setEditor("");
        addUser();
        return true;
      },
    });
    const base = await h.submit("send this once");
    assert.strictEqual(base, 0);
    assert.strictEqual(h.calls(), 2, "a blank composer after a no-submit result is not success; retry once safely");
    assert(h.diagnostics.some((x) => x.event === "send.providerNotSubmitted"));
  }

  {
    let busy = false;
    const h = makeHarness({
      isGenerating: () => busy,
      onWaitPoll(i) { if (i === 0) busy = false; },
      typeAndSend({ calls, addUser, setEditor }) {
        if (calls === 1) { busy = true; return false; }
        assert.strictEqual(busy, false, "the next attempt must wait until Stop is gone");
        setEditor("");
        addUser();
        return true;
      },
    });
    await h.submit("wait for ChatGPT to finish");
    assert.strictEqual(h.calls(), 2, "a busy refusal waits for idle before the only retry");
    assert(h.diagnostics.some((x) => x.event === "send.waitProviderIdle"));
  }

  {
    const h = makeHarness({ isGenerating: () => true, typeAndSend() { return false; } });
    let error;
    try { await h.submit("do not retry while Stop is active"); } catch (e) { error = e; }
    assert(error instanceof SendAbortedError);
    assert.strictEqual(h.calls(), 1, "a still-busy provider is not poked with a second send attempt");
    assert(h.diagnostics.some((x) => x.event === "send.providerStillBusy"));
  }

  {
    const h = makeHarness({
      typeAndSend() { return false; },
      scanError: () => "ChatGPT will not accept the message - its send button is disabled (quota reached).",
    });
    let error;
    try { await h.submit("quota-blocked message"); } catch (e) { error = e; }
    assert(error instanceof SendAbortedError, "a provider refusal aborts instead of waiting for a reply that cannot arrive");
    assert.strictEqual(h.calls(), 1, "a known disabled/quota send is not retried");
    assert(h.banners.some((b) => String(b[2]).includes("quota reached")), "the provider's actionable error is shown");
    assert.strictEqual(h.A._lastSubmit.answered, true, "a definitely-unsent message does not block an immediate user retry");
  }

  {
    const h = makeHarness({ typeAndSend({ calls, addUser, setEditor }) {
      if (calls <= 2) return false;
      setEditor("");
      addUser();
      return true;
    } });
    let error;
    try { await h.submit("retry after refusal"); } catch (e) { error = e; }
    assert(error instanceof SendAbortedError, "two confirmed no-submit results fail promptly");
    assert.strictEqual(h.calls(), 2, "at most one safe retry is allowed");
    assert.strictEqual(h.A._lastSubmit.answered, true);
    // The same text is a valid new attempt after the provider explicitly said
    // neither attempt was submitted; duplicate suppression must not eat it.
    await h.submit("retry after refusal");
    assert.strictEqual(h.calls(), 3, "an immediate same-text retry is not suppressed after a confirmed refusal");
  }

  {
    const h = makeHarness({
      id: "legacy",
      typeAndSendFalseMeansNoSubmit: false,
      typeAndSend({ calls, text, addUser, setEditor }) {
        if (calls === 1) { setEditor(text); return false; } // legacy false semantics are deliberately not inferred
        setEditor("");
        addUser();
      },
    });
    await h.submit("legacy provider message");
    assert.strictEqual(h.calls(), 2, "providers without the opt-in keep the existing composer-proof behavior");
    assert(!h.diagnostics.some((x) => x.event === "send.providerNotSubmitted"), "false is not globally assigned a meaning");
  }

  {
    const h = makeHarness({
      id: "multichat",
      typeAndSendSingleCommit: true,
      typeAndSend({ text, setEditor }) { setEditor(text); return true; },
    });
    let error;
    try { await h.submit("ambiguous site-specific send"); } catch (e) { error = e; }
    assert(error instanceof SendAbortedError, "an ambiguous single commit ends promptly instead of being clicked twice");
    assert.strictEqual(h.calls(), 1, "typeAndSendSingleCommit forbids the core's normal second send attempt");
    assert(h.diagnostics.some((x) => x.event === "send.unconfirmedSingleCommit"));
    assert(h.banners.some((b) => String(b[2]).includes("check the chat before retrying")));
  }

  {
    let settle;
    const h = makeHarness({
      id: "multichat",
      typeAndSendSingleCommit: true,
      onWaitPoll(i) { if (i === 0 && settle) settle(); },
      typeAndSend({ text, setEditor, addUser }) {
        setEditor(text);
        settle = () => { setEditor(""); addUser(); };
        return true;
      },
    });
    await h.submit("single commit with delayed landing proof");
    assert.strictEqual(h.calls(), 1, "a delayed clearing/user row proves the single send without retrying");
    assert(h.diagnostics.some((x) => x.event === "send.cleared"));
  }

  {
    const lines = Array.from({ length: 605 }, (_, i) => `line-${i}`);
    lines[603] = "previous-" + "p".repeat(24);
    lines[604] = "end-" + "z".repeat(12);
    const text = lines.join("\n");
    const truncated = truncateForSend(text);
    assert(truncated.includes("truncated (5 of 605 lines omitted") && truncated.endsWith(text.slice(-80)), "ChatGPT's real truncator preserves the original tail");
    const h = makeHarness({
      typeAndSend({ calls, addUser, setEditor }) {
        if (calls === 1) { setEditor(truncated); return true; } // first commit remains unconfirmed in the composer
        setEditor("");
        addUser();
        return true;
      },
    });
    await h.submit(text);
    assert.strictEqual(h.calls(), 2, "the core recognizes ChatGPT's preserved tail after line-count truncation and retries only while it remains typed");
  }

  console.log("test-multichat-send-core: 9 scenarios passed (v3 extracted core function; mocked providers)");
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
