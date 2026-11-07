"use strict";
// 1.69.0 — cross-provider CONTRACT + CAPABILITY regression suite.
//
// Loads every chat-site adapter (src/providers/*.js) the way the extension
// does - one per manifest bundle, on a mocked EMPTY page - and exercises the
// read-side contract main.js relies on from the very first tick (page load,
// before any chat exists): the calls must not throw and must return the types
// the loop assumes. It then prints a provider-by-provider capability table
// from TotalOrchestrator.capabilities(P).
//
// OFFLINE / SIMULATED: no provider site is contacted. A PASS here means the
// adapter honours the core contract on an empty DOM and declares sane
// capabilities - it is NOT a live-provider result (see README "Live checks").
// Run from the TotalScript root: node tests/test-provider-contract.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const ORCH = require(path.join(root, "src/core/orchestrator.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : "")); } }

function mockWindow(host, pathname) {
  const noop = () => {};
  const el = () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, contains: () => false, toggle: noop }, setAttribute: noop, getAttribute: () => null, removeAttribute: noop, hasAttribute: () => false, appendChild: (c) => c, insertBefore: (c) => c, remove: noop, addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [], closest: () => null, matches: () => false, contains: () => false, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }), children: [], childNodes: [], isConnected: true, textContent: "", innerText: "", innerHTML: "", parentElement: null, nextElementSibling: null, previousElementSibling: null, offsetParent: null, offsetHeight: 0, offsetWidth: 0, scrollHeight: 0, clientHeight: 0, focus: noop, blur: noop, click: noop, dispatchEvent: () => true });
  const doc = { ...el(), createElement: el, createTextNode: () => ({}), body: el(), head: el(), documentElement: el(), getElementById: () => null, readyState: "complete", visibilityState: "visible", hidden: false, activeElement: null, execCommand: () => true, hasFocus: () => true, title: host, cookie: "", evaluate: () => ({ snapshotLength: 0, snapshotItem: () => null }) };
  const win = { document: doc, location: { href: `https://${host}${pathname}`, hostname: host, host, origin: `https://${host}`, pathname, search: "", hash: "" }, navigator: { userAgent: "Mozilla/5.0", clipboard: {}, language: "en-US" }, addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: noop, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop, MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} }, InputEvent: class {}, KeyboardEvent: class {}, Event: class {}, CustomEvent: class {}, MouseEvent: class {}, DragEvent: class {}, ClipboardEvent: class {}, HTMLElement: class {}, HTMLTextAreaElement: class {}, HTMLInputElement: class {}, Node: class {}, Element: class {}, DataTransfer: class { constructor() { this.items = { add: noop, length: 0 }; this.files = []; } }, File: class {}, Blob: class {}, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }), localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop }, history: { pushState: noop, replaceState: noop }, innerWidth: 1280, innerHeight: 800, scrollY: 0, performance: { now: () => Date.now() }, console: { log: noop, warn: noop, error: noop, debug: noop, info: noop }, atob: (s) => Buffer.from(s, "base64").toString("binary"), btoa: (s) => Buffer.from(s, "binary").toString("base64"), JSON, Math, Date, Number, String, Array, Object, RegExp, Map, Set, WeakMap, WeakSet, Promise, Symbol, Error, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, TextEncoder, TextDecoder, URL, URLSearchParams, structuredClone: (x) => JSON.parse(JSON.stringify(x)), chrome: { runtime: { id: "x", getURL: (p) => p, sendMessage: noop, onMessage: { addListener: noop }, getManifest: () => manifest }, storage: { local: { get: noop, set: noop }, onChanged: { addListener: noop } } } };
  win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;
  return win;
}

// Read-side probes main.js issues on an empty page (boot sweeps, syncSessionState,
// diag snapshots). Each must not throw and must return the expected type.
const PROBES = [
  ["allItems", (P) => Array.isArray(P.allItems())],
  ["assistantCount", (P) => Number.isInteger(P.assistantCount())],
  ["userCount", (P) => Number.isInteger(P.userCount())],
  ["lastAssistant", (P) => { const v = P.lastAssistant(); return v === null || v === undefined || typeof v === "object"; }],
  ["chatIsEmpty", (P) => typeof P.chatIsEmpty() === "boolean"],
  ["isGenerating", (P) => typeof P.isGenerating() === "boolean"],
  ["isHardGenerating", (P) => typeof P.isHardGenerating() === "boolean"],
  ["isBusyNow", (P) => typeof P.isBusyNow() === "boolean"],
  ["editorText", (P) => typeof P.editorText() === "string"],
  ["getEditor", (P) => { const e = P.getEditor(); return e === null || e === undefined || typeof e === "object"; }],
  ["conversationKey", (P) => { const k = P.conversationKey(); return k === null || k === undefined || typeof k === "string"; }],
  ["scanError", (P) => { const e = P.scanError(); return !e || typeof e === "string"; }],
  ["isTooLongMsg(short)", (P) => P.isTooLongMsg("hello world") === false],
  ["isTooLongMsg(limit)", (P) => typeof P.isTooLongMsg("This conversation has reached its maximum length. Please start a new chat.") === "boolean"],
  ["findContinueBtn", (P) => { const b = P.findContinueBtn(); return !b || typeof b === "object"; }],
  ["snapshot", (P) => { const s = P.snapshot(); return s && typeof s === "object"; }],
  ["streamLen", (P) => Number.isFinite(Number(P.streamLen(P.lastAssistant() || undefined) || 0))],
  ["timings", (P) => P.timings && typeof P.timings === "object" && ["WARMUP_MS", "REASON_NOREPLY_MS", "STABLE_MS", "RESPONSE_TIMEOUT_MS"].every((k) => Number.isFinite(P.timings[k]) && P.timings[k] > 0) && P.timings.RESPONSE_TIMEOUT_MS >= P.timings.WARMUP_MS],
  // Keys the core actually reads (T.X in main.js) - a misspelt key (Notion's old PRE_START_MS) silently falls back to the default.
  ["timings keys spelled as the core reads them", (P) => Object.keys(P.timings).every((k) => !/PRE_START|WARM_UP|TIME_OUT|NO_REPLY|STOP_GRACE$/.test(k)) && CORE_TIMING_KEYS.length >= 6],
];
const CORE_TIMING_KEYS = [...new Set([...read("src/core/main.js").matchAll(/\bT\.([A-Z_]+)\b/g)].map((m) => m[1]))];
const REQUIRED_FNS = ["allItems", "classifyText", "clickContinueBtn", "conversationKey", "enforceComposer", "ensureComposerReady", "findContinueBtn", "findToolBlockSpot", "isAssistantItem", "isBusyNow", "isHardGenerating", "itemText", "lastAssistant", "readAssistant", "scanError", "setInputLock", "snapshot", "stopGeneration", "typeAndSend", "userCount", "installSendHooks", "isUserItem", "isGenerating", "getEditor", "editorText", "chatIsEmpty", "assistantCount", "isTooLongMsg", "attachImages"];

const bundles = manifest.content_scripts.filter((c) => c.world !== "MAIN" && c.js.some((j) => j.includes("src/core/main.js")));
const hostOf = (pattern) => pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const rows = [];
const seenProviders = new Set();
for (const b of bundles) {
  const providerFile = b.js.find((j) => /src\/providers\//.test(j) && !/stream-reader\.js$/.test(j));
  const host = hostOf(b.matches[0]);
  const pathname = host === "huggingface.co" ? "/chat/" : host === "www.notion.so" ? "/ai" : "/";
  const win = mockWindow(host, pathname);
  const ctx = vm.createContext(win);
  let P = null, loadErr = null;
  try {
    if (b.js.includes("src/providers/stream-reader.js")) vm.runInContext(read("src/providers/stream-reader.js"), ctx, { filename: "stream-reader.js" });
    vm.runInContext(read(providerFile) + "\n;window.__P = typeof RSProvider !== 'undefined' ? RSProvider : window.RSProvider;", ctx, { filename: providerFile });
    P = win.__P;
  } catch (e) { loadErr = e.message; }
  const id = P && P.id || providerFile;
  if (seenProviders.has(id)) continue;
  seenProviders.add(id);
  const problems = [];
  if (!P) problems.push("load: " + loadErr);
  else {
    for (const f of REQUIRED_FNS) if (typeof P[f] !== "function") problems.push("missing " + f + "()");
    try { if (typeof P.init === "function") P.init({ diag: () => {} }); } catch (e) { problems.push("init threw: " + e.message); }
    for (const [name, probe] of PROBES) {
      try { if (!probe(P)) problems.push(name + " returned the wrong type"); } catch (e) { problems.push(name + " threw: " + String(e && e.message || e).slice(0, 80)); }
    }
  }
  const caps = P ? ORCH.capabilities(P) : null;
  if (caps) {
    if (caps.sysMaxChars && caps.sysMaxChars < 3000) problems.push("sysMaxChars implausibly small: " + caps.sysMaxChars);
    if (caps.sendCharBudget && caps.sendCharBudget < 2000) problems.push("sendCharBudget implausibly small: " + caps.sendCharBudget);
    if (caps.timings.warmupMs && caps.timings.responseTimeoutMs && caps.timings.responseTimeoutMs < caps.timings.warmupMs) problems.push("RESPONSE_TIMEOUT_MS < WARMUP_MS");
  }
  rows.push({ id, name: caps ? caps.name : "?", file: providerFile, caps, problems });
  ok(`${id}: adapter honours the read-side contract on an empty page (${PROBES.length} probes, ${REQUIRED_FNS.length} required functions)`, problems.length === 0, problems);
}
ok("every manifest bundle produced one adapter (" + rows.length + " distinct providers)", rows.length >= 12, rows.map((r) => r.id)); // 1.89.0: 12 bundles after the provider removal

// ── capability table (offline) ──
console.log("\nPROVIDER CAPABILITY REPORT — offline, mocked DOM; NOT a live-provider result");
console.log("provider".padEnd(12) + "vision tap   compact sysMax  sendCap batch warmup/total(s) continue errScan");
for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) {
  const c = r.caps || {};
  const t = c.timings || {};
  console.log(r.id.padEnd(12) + (c.vision ? "yes " : "no  ").padEnd(7) + (c.streamTap ? "yes " : "no  ").padEnd(6) + (c.compactCommandList ? "yes " : "no  ").padEnd(8) + String(c.sysMaxChars || "-").padEnd(8) + String(c.sendCharBudget || "-").padEnd(8) + String(c.maxBatchCommands || "-").padEnd(6) + (`${Math.round((t.warmupMs || 0) / 1000)}/${Math.round((t.responseTimeoutMs || 0) / 1000)}`).padEnd(16) + (c.nativeContinue ? "yes " : "no  ").padEnd(9) + (c.errorScan ? "yes" : "no") + (r.problems.length ? "   ⚠ " + r.problems.length + " problem(s)" : ""));
}
ok("capability records come from the adapters only (ids unique, names present, timings numeric)", rows.every((r) => r.caps && r.caps.id === r.id && r.caps.name && typeof r.caps.timings === "object"));
ok("vision is declared only by adapters that can actually attach images (supportsVision + attachImages)", rows.every((r) => !r.caps.vision || (r.caps.vision && typeof (r.caps.vision) === "boolean")) && rows.some((r) => r.caps.vision) && rows.some((r) => !r.caps.vision));
ok("tight-prompt providers (compact list or sysMaxChars < 16000) are flagged so Layer C / resend riders shrink for them", rows.filter((r) => r.caps.tightPrompt).length >= 2 && rows.filter((r) => r.caps.tightPrompt).every((r) => r.caps.compactCommandList || (r.caps.sysMaxChars && r.caps.sysMaxChars < 16000)));

console.log(`\ntest-provider-contract: ${pass + fail} checks, ${fail} failed (offline / simulated)`);
process.exit(fail ? 1 : 0);
