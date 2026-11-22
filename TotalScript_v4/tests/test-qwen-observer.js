// 1.87.0: Qwen's code-snapshot MutationObserver (the "15-20 s freeze after N
// tools" suspect) no longer re-reads every code block of the conversation on
// every mutation. Real adapter source in jsdom; the work is counted through a
// spy on document.querySelectorAll(codeWrap) and on the blocks' view-lines.
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-qwen-observer.js
"use strict";
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log("PASS  " + name); } else { failed++; console.log("FAIL  " + name + (extra !== undefined ? "  — " + JSON.stringify(extra).slice(0, 300) : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const src = read("src/providers/qwen.js");
  ok("qwen.js: observer reduces records to touched blocks and coalesces (no per-mutation full scan)", /const _snDirty = new Set\(\)/.test(src) && /el\.closest\(S\.codeWrap\)/.test(src) && /setTimeout\(flush, SNAP_COALESCE_MS\)/.test(src) && !/new MutationObserver\(snapAll\)/.test(src));

  const blocks = 30, linesPer = 40;
  let html = '<div id="chat">';
  for (let b = 0; b < blocks; b++) {
    html += `<div class="turn"><p class="prose">answer ${b}</p><pre class="qwen-markdown-code" id="pre${b}">`;
    for (let l = 0; l < linesPer; l++) html += `<div class="view-line">line ${b}-${l}</div>`;
    html += `</pre></div>`;
  }
  html += '<p id="stream"></p></div>';
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://chat.qwen.ai/c/abc", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  // spies
  let qsaCode = 0, lineReads = 0;
  const origQSA = d.querySelectorAll.bind(d);
  d.querySelectorAll = (sel) => { if (sel === "pre.qwen-markdown-code") qsaCode++; return origQSA(sel); };
  const preProto = w.HTMLPreElement.prototype;
  const origPreQSA = preProto.querySelectorAll;
  preProto.querySelectorAll = function (sel) { if (sel === ".view-line") lineReads++; return origPreQSA.call(this, sel); };
  w.eval(read("src/providers/stream-reader.js"));
  w.eval(src);
  const P = w.RSProvider;
  P.init({ diag: () => {} });
  await sleep(10);
  const seedQSA = qsaCode, seedLines = lineReads;
  ok("init seeds every block once (one full scan)", seedQSA >= 1 && seedLines === blocks, { seedQSA, seedLines });
  ok("snapshot captured the full source of a block", (d.getElementById("pre7").dataset.rsCode || "").split("\n").length === linesPer);

  // 1. prose streaming OUTSIDE any code block: 200 mutations
  qsaCode = 0; lineReads = 0;
  const stream = d.getElementById("stream");
  for (let i = 0; i < 200; i++) stream.appendChild(d.createTextNode("tok "));
  await sleep(300);
  ok("200 prose mutations outside code blocks → ZERO block scans (before: a full scan of all 30 blocks per mutation batch, i.e. per streamed chunk)", qsaCode === 0 && lineReads === 0, { qsaCode, lineReads });

  // 2. a burst of 100 new lines streamed into ONE block
  qsaCode = 0; lineReads = 0;
  const pre3 = d.getElementById("pre3");
  for (let i = 0; i < 100; i++) { const ln = d.createElement("div"); ln.className = "view-line"; ln.textContent = "new " + i; pre3.appendChild(ln); }
  await sleep(300);
  ok("100 line mutations in ONE block → that block alone, in ONE coalesced pass (no document-wide query)", qsaCode === 0 && lineReads === 1, { qsaCode, lineReads });
  ok("the touched block's snapshot grew to the new line count (longest capture)", (pre3.dataset.rsCode || "").split("\n").length === linesPer + 100);
  ok("an untouched block was not re-read and kept its snapshot", (d.getElementById("pre9").dataset.rsCode || "").split("\n").length === linesPer);

  // 3. Monaco disposes lines (scroll-out): the snapshot survives
  while (pre3.firstChild) pre3.removeChild(pre3.firstChild);
  await sleep(300);
  ok("after Monaco disposes the view-lines the full source is still served from the snapshot", P.readAssistant ? (pre3.dataset.rsCode || "").split("\n").length === linesPer + 100 : true);

  // 4. a brand-new turn with a code block inside a wrapper → one full scan, not one per mutation
  qsaCode = 0; lineReads = 0;
  const turn = d.createElement("div"); turn.className = "turn";
  turn.innerHTML = '<pre class="qwen-markdown-code" id="preNew"><div class="view-line">x = 1</div></pre>';
  d.getElementById("chat").appendChild(turn);
  for (let i = 0; i < 50; i++) stream.appendChild(d.createTextNode("more "));
  await sleep(300);
  ok("inserting a wrapper that CONTAINS a block → one full scan picks it up; the 50 prose mutations after it add nothing", qsaCode === 1 && (d.getElementById("preNew").dataset.rsCode || "") === "x = 1", { qsaCode, lineReads });

  console.log(`test-qwen-observer: ${passed} passed, ${failed} failed (jsdom, real adapter source; no live site)`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
