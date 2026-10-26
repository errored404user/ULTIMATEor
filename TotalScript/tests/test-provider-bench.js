"use strict";
// 1.69.0 — provider benchmark / regression suite: 12 named scenarios run
// against the orchestration layer for EVERY chat-site adapter, producing a
// per-provider report.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ SIMULATED. No provider is contacted; no model output is involved.       │
// │ Each scenario drives the deterministic parts of the pipeline (task      │
// │ classification, Layer-C brief, error taxonomy + back-off, tool-argument │
// │ validation, false-success detection, capability routing) with the      │
// │ provider's REAL adapter flags and timings loaded from src/providers/.   │
// │ A PASS means the plumbing behaves correctly for that provider's declared │
// │ capabilities - it says nothing about the model's live quality.          │
// │ Live checks (manual) are described in README "Provider live checks".   │
// └──────────────────────────────────────────────────────────────────────────┘
// Run from the TotalScript root: node tests/test-provider-bench.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const O = require(path.join(root, "src/core/orchestrator.js"));
const main = read("src/core/main.js"), rs = read("agent/src/chat.rs");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : "")); } }

// ── load adapters (same mock as test-provider-contract.js) ──
function mockWindow(host, pathname) {
  const noop = () => {};
  const el = () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, contains: () => false, toggle: noop }, setAttribute: noop, getAttribute: () => null, removeAttribute: noop, hasAttribute: () => false, appendChild: (c) => c, insertBefore: (c) => c, remove: noop, addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [], closest: () => null, matches: () => false, contains: () => false, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }), children: [], childNodes: [], isConnected: true, textContent: "", innerText: "", innerHTML: "", parentElement: null, focus: noop, blur: noop, click: noop, dispatchEvent: () => true });
  const doc = { ...el(), createElement: el, createTextNode: () => ({}), body: el(), head: el(), documentElement: el(), getElementById: () => null, readyState: "complete", visibilityState: "visible", hidden: false, activeElement: null, execCommand: () => true, hasFocus: () => true, title: host, cookie: "" };
  const win = { document: doc, location: { href: `https://${host}${pathname}`, hostname: host, host, origin: `https://${host}`, pathname, search: "", hash: "" }, navigator: { userAgent: "Mozilla/5.0", clipboard: {}, language: "en-US" }, addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: noop, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop, MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} }, InputEvent: class {}, KeyboardEvent: class {}, Event: class {}, CustomEvent: class {}, MouseEvent: class {}, DragEvent: class {}, ClipboardEvent: class {}, HTMLElement: class {}, HTMLTextAreaElement: class {}, HTMLInputElement: class {}, Node: class {}, Element: class {}, DataTransfer: class { constructor() { this.items = { add: noop, length: 0 }; this.files = []; } }, File: class {}, Blob: class {}, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }), localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop }, history: { pushState: noop, replaceState: noop }, innerWidth: 1280, innerHeight: 800, scrollY: 0, performance: { now: () => Date.now() }, console: { log: noop, warn: noop, error: noop, debug: noop, info: noop }, atob: (s) => Buffer.from(s, "base64").toString("binary"), btoa: (s) => Buffer.from(s, "binary").toString("base64"), JSON, Math, Date, URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone: (x) => JSON.parse(JSON.stringify(x)), chrome: { runtime: { id: "x", getURL: (p) => p, sendMessage: noop, onMessage: { addListener: noop }, getManifest: () => manifest }, storage: { local: { get: noop, set: noop }, onChanged: { addListener: noop } } } };
  win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;
  return win;
}
const hostOf = (pattern) => pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const providers = [];
const seen = new Set();
for (const b of manifest.content_scripts.filter((c) => c.world !== "MAIN" && c.js.some((j) => j.includes("src/core/main.js")))) {
  const file = b.js.find((j) => /src\/providers\//.test(j) && !/stream-reader\.js$/.test(j));
  const host = hostOf(b.matches[0]);
  const pathname = host === "huggingface.co" ? "/chat/" : host === "www.notion.so" ? "/ai" : host === "build.nvidia.com" ? "/moonshotai/kimi-k3" : "/";
  const win = mockWindow(host, pathname), ctx = vm.createContext(win);
  try {
    if (b.js.includes("src/providers/stream-reader.js")) vm.runInContext(read("src/providers/stream-reader.js"), ctx);
    vm.runInContext(read(file) + "\n;window.__P = typeof RSProvider !== 'undefined' ? RSProvider : window.RSProvider;", ctx);
  } catch (e) { continue; }
  const P = win.__P;
  if (!P || seen.has(P.id)) continue;
  seen.add(P.id);
  providers.push({ id: P.id, P, caps: O.capabilities(P), file });
}
providers.sort((a, b) => a.id.localeCompare(b.id));
ok("adapters loaded for the benchmark: " + providers.map((p) => p.id).join(", "), providers.length >= 16);
// The desktop app (total-agent, OpenAI-compatible HTTP) is benchmarked from its source pins.
providers.push({ id: "total-agent", P: null, caps: { id: "total-agent", name: "total-agent (HTTP tools)", vision: false, tightPrompt: false, sysMaxChars: 0, sendCharBudget: 0, maxBatchCommands: 8, timings: {} }, rust: true });

// ── the 12 scenarios ──
// Each returns { pass: bool, note } for one provider. `c` = capability record.
const SCENARIOS = [
  ["instruction comprehension", (p) => {
    const cases = [["script a door that opens when touched", "implement"], ["why does my script error?", "explain"], ["plan how to build an obby lobby, dont build yet", "plan"], ["the door is broken", "fix"], ["review my DataStore code for bugs", "review"]];
    const bad = cases.filter(([t, want]) => O.classifyTask(t, { prev: O.classifyTask("script a door") }).intent !== want);
    return { pass: bad.length === 0, note: bad.length ? "misread: " + bad.map((b) => b[0]).join("; ") : "5/5 intents" };
  }],
  ["continuity", (p) => {
    const first = O.classifyTask("build a sword with a swing animation, only use one Script");
    const fu = O.classifyTask("make it faster too", { prev: first });
    const brief = O.taskLayer(fu, { tight: p.caps.tightPrompt });
    return { pass: fu.inherited && fu.constraints.length === 1 && /follow-up/.test(brief) && /only use one Script/.test(brief), note: "constraints carried: " + fu.constraints.length };
  }],
  ["repo understanding", (p) => {
    const t = O.classifyTask("read ServerScriptService.Main and tell me what it does, dont change anything");
    const t2 = O.classifyTask("find where the coin value is set in my scripts");
    return { pass: t.mutates === false && t2.mutates === false && t2.needsTools === true && t.constraints.some((c) => /dont change anything/.test(c)), note: `inspect-only: tools=${t2.needsTools} mutates=${t.mutates}` };
  }],
  ["tool call", (p) => {
    if (p.rust) return { pass: /fn missing_required\(/.test(rs) && /MISSING_PARAMS/.test(rs) && /"tool_call_id": id/.test(rs), note: "schema preflight + tool_call_id correlation (source pin)" };
    const schema = { type: "object", required: ["code"], properties: { code: { type: "string" }, timeout: { type: "integer" } } };
    const v = O.validateToolArgs(schema, { code: "print(1)", timeout: "5" });
    return { pass: v.problems.length === 0 && v.args.timeout === 5 && /ORCH\.validateToolArgs\(/.test(main), note: "coerced " + v.coerced.join(",") };
  }],
  ["multi tool calls", (p) => {
    if (p.rust) return { pass: /for \(i, \(id, name, args\)\) in calls/.test(rs) || /calls\.iter\(\)\.enumerate\(\)/.test(rs) || /for \(id, name, args\) in/.test(rs), note: "sequential tool loop with per-call ids (source pin)" };
    const n = p.caps.maxBatchCommands;
    return { pass: Number.isInteger(n) && n >= 1 && n <= 8, note: `batch cap ${n}` };
  }],
  ["error recovery", (p) => {
    if (p.rust) return { pass: /transient_retries < 2/.test(rs) && /ErrClass::Permanent/.test(rs) && /last_fail_count >= 4/.test(rs), note: "≤2 transient retries, permanent = stop, repeat-failure guard (source pin)" };
    const r = O.classifyProviderError("HTTP 429 rate limit, retry after 10 seconds");
    const d1 = O.retryDelay(r.cls, 1, r.waitMs), d2 = O.retryDelay(r.cls, 2, r.waitMs), d3 = O.retryDelay(r.cls, 3, r.waitMs);
    const perm = O.retryDelay(O.classifyProviderError("401 invalid api key").cls, 1);
    return { pass: r.retryable && d1 === 15000 && d2 === 45000 && d3 === null && perm === null, note: `back-off ${d1}/${d2}/stop; auth never retried` };
  }],
  ["fallback", (p) => {
    // Policy: TotalScript never switches the user's site/model by itself (Phase 91). Fallback is reported, not silent.
    if (p.rust) return { pass: !/switch_provider|fallback_provider/.test(rs), note: "no silent provider switch in total-agent" };
    const banner = /request failed\$\{cls && cls\.cls !== "unknown"/.test(main);
    return { pass: /__rsAllowSiteSwitch !== true\) \{/.test(main) && banner, note: "errors surface with class + hint; no auto-switch" };
  }],
  ["structured output", (p) => {
    if (p.rust) return { pass: /Invalid JSON in tool arguments|arguments.*from_str|serde_json::from_str/.test(rs), note: "tool-call JSON parsed and rejected when malformed (source pin)" };
    const schema = { type: "object", properties: { enabled: { type: "boolean" }, count: { type: "integer" }, kind: { type: "string", enum: ["Part", "Model"] } } };
    const v = O.validateToolArgs(schema, { enabled: "false", count: "2", kind: "part" });
    const bad = O.validateToolArgs(schema, { count: "two" });
    return { pass: v.args.enabled === false && v.args.count === 2 && v.args.kind === "Part" && bad.problems.length === 1 && /NOT run/.test(O.argProblemsMessage("x", bad)), note: "repairs string→bool/int, enum case; rejects 'two'" };
  }],
  ["long context", (p) => {
    if (p.rust) return { pass: /fn trim_history\(/.test(rs) && /ErrClass::ContextLength/.test(rs) && /trims < 3/.test(rs), note: "oldest exchanges dropped (≤3 rounds) then stop (source pin)" };
    const r = O.classifyProviderError("This conversation has reached the maximum context length");
    const brief = O.taskLayer(O.classifyTask("make a coin pickup system, only one script and don't touch the lighting"), { tight: p.caps.tightPrompt });
    const budget = p.caps.sendCharBudget || p.caps.sysMaxChars || 16000;
    return { pass: r.cls === "context_limit" && !r.retryable && brief.length <= (p.caps.tightPrompt ? 420 : 760) && brief.length < budget / 8, note: `rider ${brief.length} chars (${p.caps.tightPrompt ? "tight" : "full"}), context_limit → fresh chat` };
  }],
  ["real implementation", (p) => {
    if (p.rust) return { pass: /steps/.test(rs) && /finish\(/.test(rs), note: "turn ends with an honest step count (source pin)" };
    const t = O.classifyTask("make a door that opens when touched");
    return { pass: t.mutates && O.claimsCompletion("Done! The door script is now in ServerScriptService.") && !O.claimsCompletion("I will add the script now.") && /loop\.falseSuccess/.test(main), note: "claims without a single command are nudged once" };
  }],
  ["Roblox Luau", (p) => {
    const t = O.classifyTask("write a Luau script that gives players a sword when they join");
    const brief = O.taskLayer(t, { tight: p.caps.tightPrompt });
    return { pass: t.categories.includes("luau") && t.mutates && t.needsTools && /script|mechanic/i.test(brief) && /read back/i.test(brief), note: `luau task (${t.primary}) → tools + read-back brief` };
  }],
  ["cross-provider consistency", (p) => {
    if (p.rust) return { pass: true, note: "n/a (HTTP tools API)" };
    const c = p.caps;
    const tightOk = !c.tightPrompt || O.taskLayer(O.classifyTask("make a coin pickup system, only one script"), { tight: true }).length <= 420;
    const timingsOk = c.timings.warmupMs > 0 && c.timings.responseTimeoutMs >= c.timings.warmupMs;
    return { pass: tightOk && timingsOk && c.id === p.id, note: `warmup ${Math.round(c.timings.warmupMs / 1000)}s / total ${Math.round(c.timings.responseTimeoutMs / 1000)}s` };
  }],
];
ok("12 named scenarios defined", SCENARIOS.length === 12, SCENARIOS.map((s) => s[0]));

// ── run ──
const report = {};
for (const p of providers) {
  report[p.id] = {};
  for (const [name, fn] of SCENARIOS) {
    let r;
    try { r = fn(p); } catch (e) { r = { pass: false, note: "threw: " + e.message }; }
    report[p.id][name] = r;
  }
}
console.log("\nPROVIDER BENCHMARK REPORT — SIMULATED (no provider contacted, no model output). PASS = plumbing correct for the adapter's declared capabilities.");
const names = SCENARIOS.map((s) => s[0]);
const short = ["instr", "cont", "repo", "tool", "multi", "err", "fallb", "struct", "long", "impl", "luau", "xprov"];
console.log("provider".padEnd(12) + short.map((s) => s.padEnd(7)).join(""));
for (const id of Object.keys(report)) {
  console.log(id.padEnd(12) + names.map((n) => (report[id][n].pass ? "PASS" : "FAIL").padEnd(7)).join(""));
}
console.log("\nnotes (first provider + total-agent):");
const first = providers[0].id;
for (const n of names) console.log(`  ${n.padEnd(28)} ${first}: ${report[first][n].note}   | total-agent: ${report["total-agent"][n].note}`);
for (const n of names) {
  const failing = Object.keys(report).filter((id) => !report[id][n].pass);
  ok(`scenario "${n}" passes for every provider (simulated)`, failing.length === 0, failing.map((id) => id + ": " + report[id][n].note));
}
// Machine-readable report for the debug overlay / CI artefacts (not committed).
try {
  const out = path.join(require("os").tmpdir(), "totalscript-provider-bench.json");
  fs.writeFileSync(out, JSON.stringify({ version: O.VERSION, mode: "simulated", at: new Date().toISOString(), scenarios: names, report }, null, 1));
  console.log("\nreport written to " + out);
} catch {}

console.log(`\ntest-provider-bench: ${pass + fail} checks, ${fail} failed (SIMULATED)`);
process.exit(fail ? 1 : 0);
