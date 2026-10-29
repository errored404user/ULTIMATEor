"use strict";
// 1.86.0 — provider INVENTORY + registration consistency check.
//
// Builds the authoritative list of chat-site providers from the SOURCE
// (manifest bundles → adapter files → the adapter's own id / displayName on
// every host it is injected into), cross-checks every place a provider must be
// registered (manifest host_permissions, background PROVIDER_URLS, popup
// SUPPORTED_HOSTS, the Switch-AI list in main.js, MAIN-world dependencies and
// injection order), classifies each adapter's send path and lists the tests
// that exercise it. Writes PROVIDERS.md (source-controlled; regenerate with
// this script) and exits non-zero on any registration drift.
//
// Nothing here contacts a site: "verification" columns say what KIND of
// evidence exists (static load / jsdom adapter test / whole-bundle e2e mock),
// never that a provider was seen working live.
// Run from the TotalScript root: node tests/provider-inventory.js [--check]
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));
const manifest = JSON.parse(read("manifest.json"));
const background = read("background.js"), popup = read("popup.js"), main = read("src/core/main.js");
const CHECK_ONLY = process.argv.includes("--check");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 300) : "")); } }

// ── adapter loader (same mock as test-provider-contract.js) ──
function mockWindow(host, pathname) {
  const noop = () => {};
  const el = () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, contains: () => false, toggle: noop }, setAttribute: noop, getAttribute: () => null, removeAttribute: noop, hasAttribute: () => false, querySelector: () => null, querySelectorAll: () => [], closest: () => null, appendChild: (c) => c, removeChild: noop, remove: noop, addEventListener: noop, removeEventListener: noop, contains: () => false, getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }), children: [], childNodes: [], textContent: "", innerText: "", offsetParent: null, matches: () => false, focus: noop, blur: noop, click: noop, dispatchEvent: () => true, insertBefore: (c) => c, cloneNode() { return el(); } });
  const doc = { ...el(), createElement: el, createTextNode: () => ({}), body: el(), head: el(), documentElement: el(), getElementById: () => null, readyState: "complete", visibilityState: "visible", hidden: false, activeElement: null, execCommand: () => true, title: "" };
  const win = { document: doc, location: { href: `https://${host}${pathname}`, hostname: host, host, origin: `https://${host}`, pathname, search: "", hash: "" }, navigator: { userAgent: "Mozilla/5.0", clipboard: {} }, HTMLElement: class {}, HTMLTextAreaElement: class {}, HTMLInputElement: class {}, HTMLButtonElement: class {}, Element: class {}, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }), setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame: clearTimeout, MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } }, ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} }, KeyboardEvent: class { constructor(t, o) { Object.assign(this, { type: t }, o || {}); } }, Event: class { constructor(t, o) { Object.assign(this, { type: t }, o || {}); } }, InputEvent: class { constructor(t, o) { Object.assign(this, { type: t }, o || {}); } }, CustomEvent: class { constructor(t, o) { Object.assign(this, { type: t }, o || {}); } }, DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } }, ClipboardEvent: class {}, File: class {}, Blob: class {}, URL: { createObjectURL: () => "", revokeObjectURL: noop }, performance: { now: () => Date.now() }, console, NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 }, innerWidth: 1280, innerHeight: 800, scrollTo: noop, atob: (s) => Buffer.from(s, "base64").toString("binary"), btoa: (s) => Buffer.from(s, "binary").toString("base64"), chrome: { runtime: { sendMessage: noop, onMessage: { addListener: noop }, getURL: (p) => "chrome-extension://x/" + p }, storage: { local: { get: (k, cb) => cb && cb({}), set: noop } } }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop } };
  win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;
  return win;
}
const hostOf = (pattern) => pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const pathOfPattern = (pattern) => { const m = pattern.replace(/^https?:\/\/[^/]+/, ""); return m.replace(/\*$/, "") || "/"; };
const DEFAULT_PATH = { "huggingface.co": "/chat/", "www.notion.so": "/ai", "c.vani.ai": "/chat", "arena.ai": "/text/direct" };

// ── MAIN-world dependencies each adapter reads (from the adapter sources) ──
const MAIN_DEPS = [
  { needle: /RSStreamNet/, file: "src/providers/stream-net.js", label: "stream-net (MAIN)" },
  { needle: /data-rs-vani-net|__rsVaniNet/, file: "src/providers/vani-net.js", label: "vani-net (MAIN)" },
  { needle: /rs-qwen-net/, file: "src/providers/qwen-net.js", label: "qwen-net (MAIN)" },
  { needle: /data-rs-cm|rs-cm-|__rsCm/, file: "src/providers/chatgpt-cm.js", label: "chatgpt-cm (MAIN)" },
];

const isoBundles = manifest.content_scripts.filter((c) => c.world !== "MAIN" && c.js.some((j) => j.includes("src/core/main.js")));
const mainBundles = manifest.content_scripts.filter((c) => c.world === "MAIN");
const hostPerms = new Set(manifest.host_permissions);
const providerUrlsSrc = (background.match(/const PROVIDER_URLS = \[([\s\S]*?)\];/) || [, ""])[1];
const providerUrls = new Set([...providerUrlsSrc.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
const supportedHostsSrc = (popup.match(/const SUPPORTED_HOSTS = \[([\s\S]*?)\];/) || [, ""])[1];
const supportedHosts = [...supportedHostsSrc.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const aiSitesSrc = (main.match(/const AI_SITES = \[([\s\S]*?)\n  \];/) || [, ""])[1];
const aiSiteUrls = [...aiSitesSrc.matchAll(/url: "([^"]+)"/g)].map((m) => m[1]);
const testFiles = fs.readdirSync(path.join(root, "tests")).filter((f) => /\.(js|py)$/.test(f));
const testSrc = Object.fromEntries(testFiles.map((f) => [f, read("tests/" + f)]));

const rows = [];
const idsSeen = new Map();
for (const b of isoBundles) {
  const adapterFile = b.js.find((j) => /src\/providers\//.test(j) && !/stream-reader\.js$/.test(j));
  ok(`bundle ${b.matches[0]}: has one provider adapter`, !!adapterFile, b.js.filter((j) => /providers/.test(j)));
  if (!adapterFile) continue;
  ok(`${adapterFile}: file exists`, exists(adapterFile));
  const src = exists(adapterFile) ? read(adapterFile) : "";
  // injection order: stream-reader before the adapter, adapter before main.js
  const iAdapter = b.js.indexOf(adapterFile), iMain = b.js.indexOf("src/core/main.js"), iReader = b.js.indexOf("src/providers/stream-reader.js");
  ok(`${adapterFile}: injected before src/core/main.js`, iAdapter >= 0 && iAdapter < iMain);
  if (/RSStreamReader|rsStreamReader|stream-reader/.test(src)) ok(`${adapterFile}: stream-reader.js injected before it`, iReader >= 0 && iReader < iAdapter, { iReader, iAdapter });
  // the three places every host must be registered
  for (const m of b.matches) {
    ok(`${m}: in host_permissions`, hostPerms.has(m) || hostPerms.has("https://*/*") || hostPerms.has("<all_urls>"));
    ok(`${m}: in background PROVIDER_URLS`, providerUrls.has(m), m);
    const h = hostOf(m).replace(/^\*\./, "");
    ok(`${m}: popup SUPPORTED_HOSTS recognises ${h}`, supportedHosts.some((s) => h.includes(s.replace(/\/.*$/, "")) || s.includes(h)), h);
  }
  // MAIN-world dependencies must be injected on the same hosts, at document_start
  const mainDeps = [];
  for (const dep of MAIN_DEPS) {
    if (!dep.needle.test(src)) continue;
    mainDeps.push(dep.label);
    const mb = mainBundles.filter((c) => c.js.includes(dep.file));
    const covered = b.matches.every((m) => mb.some((c) => c.matches.includes(m)));
    ok(`${adapterFile}: ${dep.label} injected on every host of its bundle`, covered, { missing: b.matches.filter((m) => !mb.some((c) => c.matches.includes(m))) });
    ok(`${dep.file}: runs at document_start`, mb.every((c) => c.run_at === "document_start"));
  }
  // load the adapter once per distinct host → id / displayName
  const hostsById = new Map();
  for (const m of b.matches) {
    const host = hostOf(m).replace(/^\*\./, "www.");
    const pathname = DEFAULT_PATH[host] || pathOfPattern(m);
    const win = mockWindow(host, pathname), ctx = vm.createContext(win);
    let P = null, err = null;
    try {
      if (iReader >= 0) vm.runInContext(read("src/providers/stream-reader.js"), ctx, { filename: "stream-reader.js" });
      vm.runInContext(src + "\n;window.__P = typeof RSProvider !== 'undefined' ? RSProvider : window.RSProvider;", ctx, { filename: adapterFile });
      P = win.__P;
    } catch (e) { err = e.message; }
    ok(`${adapterFile} on ${host}: loads and exports RSProvider with id + displayName`, !!(P && typeof P.id === "string" && typeof P.displayName === "string"), err);
    if (!P) continue;
    const prev = idsSeen.get(P.id);
    ok(`${P.id}: provider id is unique to one adapter file`, !prev || prev === adapterFile, { prev });
    idsSeen.set(P.id, adapterFile);
    if (!hostsById.has(P.id)) hostsById.set(P.id, { P, hosts: [] });
    hostsById.get(P.id).hosts.push(host);
  }
  // send-path classification from the adapter source
  const tasAt = src.indexOf("async function typeAndSend");
  const tas = tasAt >= 0 ? src.slice(tasAt, tasAt + 6000) : "";
  const multiClick = /for \(let i = 0; i < \d+ && !sent; i\+\+\)/.test(tas);
  const imageLoop = /while \(Date\.now\(\) - t0 < 25000\)/.test(tas);
  const singleCommit = /proof\(\)/.test(src) || /commitSend\(/.test(src);
  const sendPath = multiClick ? "MULTI-CLICK LOOP (defect)" : singleCommit ? "single commit + bounded proof" : imageLoop ? "single click (text) · bounded re-click loop on the screenshot path" : "single click / Enter";
  ok(`${adapterFile}: typeAndSend has no multi-click resend loop`, !multiClick);
  for (const [id, { P, hosts }] of hostsById) {
    const tests = testFiles.filter((f) => f !== "provider-inventory.js" && (testSrc[f].includes(adapterFile) || testSrc[f].includes(path.basename(adapterFile)) || new RegExp(`["'\`]${id}["'\`]`).test(testSrc[f])));
    const e2e = tests.filter((f) => /-e2e\.js$/.test(f));
    const jsdom = tests.filter((f) => /jsdom/i.test(testSrc[f]) && !/-e2e\.js$/.test(f));
    const inSwitch = hosts.some((h) => aiSiteUrls.some((u) => hostOf(u) === h || hostOf(u).replace(/^www\./, "") === h.replace(/^www\./, "")));
    ok(`${id}: listed in the Switch-AI site list (main.js AI_SITES)`, inSwitch, hosts);
    rows.push({
      id, name: P.displayName, hosts, adapter: adapterFile, mainDeps, streamTap: /RSStreamNet|netLatest|netCurrent|rs-qwen-net/.test(src),
      sendPath, vision: !!P.supportsVision, tight: !!(P.sysMaxChars && P.sysMaxChars < 16000), compact: !!P.compactCommandList,
      // 1.94.0: command-format capability (config.js builds the ###CMD###-first prompt for "plain").
      format: P.commandFormat === "plain" ? "plain (###CMD### / ###LUA###, no json fence)" : "json + plain",
      commandless: P.commandlessRetries == null ? "core default (1)" : String(P.commandlessRetries), promptExtra: typeof P.promptExtra === "string" ? P.promptExtra.length : 0,
      tests, e2e, jsdom,
    });
  }
}
// Extension-hosted CodeCraft page (API client, no content_scripts bundle).
{
  const src = read("src/providers/codecraft.js");
  const html = read("codecraft.html");
  ok("codecraft.js: loaded by codecraft.html before main.js", html.indexOf("src/providers/codecraft.js") >= 0 && html.indexOf("src/providers/codecraft.js") < html.indexOf("src/core/main.js"));
  const tests = testFiles.filter((f) => testSrc[f].includes("codecraft"));
  // 1.99.1: the same page serves API profiles (codecraft.html?api=deepseek → api.deepseek.com).
  const profileHosts = [...src.matchAll(/^\s+([a-z]+): \{\s*\n\s+id: "([a-z]+)", name: "([^"]+)", apiBase: "([^"]+)"/gm)].map((m) => (m[2] === "codecraft" ? "codecraft.html" : "codecraft.html?api=" + m[2]) + " (extension) → " + m[4]);
  rows.push({ id: "codecraft", name: "CodeCraft API / DeepSeek API (extension page, API profiles)", hosts: profileHosts.length ? profileHosts : ["codecraft.html (extension) → https://codecraftapi.com/v1"], adapter: "src/providers/codecraft.js", mainDeps: [], streamTap: /fetch\(/.test(src), sendPath: "HTTP request (no DOM composer)", vision: false, tight: false, compact: false, commandless: "core default (1)", promptExtra: 0, tests, e2e: [], jsdom: [] });
}
rows.sort((a, b) => a.id.localeCompare(b.id));
ok("every registered id has exactly one adapter and every adapter file in src/providers is reachable from a bundle or codecraft.html", (() => {
  const files = fs.readdirSync(path.join(root, "src/providers")).map((f) => "src/providers/" + f);
  const reachable = new Set([...manifest.content_scripts.flatMap((c) => c.js), "src/providers/codecraft.js"]);
  const orphans = files.filter((f) => !reachable.has(f));
  if (orphans.length) console.log("orphan adapters:", orphans);
  return orphans.length === 0;
})());

// ── PROVIDERS.md ──
const md = [];
md.push("# TotalScript provider inventory", "", "Generated by `node tests/provider-inventory.js` (1.99.2) from `manifest.json`, `background.js`, `popup.js`, `src/core/main.js` and the adapters in `src/providers/`. Re-run the script after any provider change; it fails on registration drift.", "",
  "**Evidence levels.** *static* = the adapter loads on a mocked empty page and honours the read-side contract (`tests/test-provider-contract.js`, `tests/test-provider-bench.js`); *jsdom* = a dedicated DOM-level adapter test; *e2e (mock)* = the whole bundle runs against a fake page of that site with the real stream tap, the shared parser / contract / dispatcher and a lupa Studio stand-in; *live* = seen working against the real site + Studio. **No provider has live evidence in this repository** - live runs are done by users (README \"Provider live checks\").", "",
  "| id | name | hosts | adapter | MAIN-world deps | stream tap | send path | vision | tight prompt | compact list | command format | commandless retries | static | jsdom | e2e (mock) | live |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  md.push(`| \`${r.id}\` | ${r.name} | ${r.hosts.join(", ")} | \`${r.adapter}\` | ${r.mainDeps.join(", ") || "-"} | ${r.streamTap ? "yes" : "no"} | ${r.sendPath} | ${r.vision ? "yes" : "no"} | ${r.tight ? "yes" : "no"} | ${r.compact ? "yes" : "no"} | ${r.format || "json + plain"} | ${r.commandless} | ${r.id === "codecraft" ? "scan-all-providers" : "yes"} | ${r.jsdom.length ? r.jsdom.join(", ") : "-"} | ${r.e2e.length ? r.e2e.join(", ") : "-"} | not verified |`);
}
md.push("", "## Shared pipeline every provider feeds", "",
  "`typeAndSend` → site → `readAssistant` (stream tap first where present, DOM otherwise) → `src/core/parser.js` (JSON · `###MCP_TOOL###` · `###LUA###` / `###LUA:Server|Client###` · `###CMD name###` envelopes · native `<tool_call>` / DSML) → `TotalCommandContract.prepare` (aliases, enums, ranges, required params) → `command_registry` / skills → `background.js call_tool` (Roblox bridge 17613 / local 17615, Blender ops) → result typed back by `typeAndSend`. Providers never parse commands themselves; `findToolBlockSpot` only masks command blocks visually.", "",
  "## Send-path contract (1.85.0 / 1.86.0)", "",
  "Commit ONCE (send button click; else the composer's own form submit / Enter), wait a bounded 2.5 s for a landing proof (our text left the composer · stop control up · new user row · stream tap saw the request), ONE alternate mechanism only while our text is verifiably still typed, then an honest `*.send.landed` / `*.send.unconfirmed` (or `*.tas.sent {sent, how, proof}`) diagnostic without the text. Adapters marked *single click / Enter* already committed once (ChatGPT, Gemini, Kimi, Qwen, GLM, DeepSeek, Crax, NVIDIA, Claude, Notion); the loop-based ones were repaired in 1.85.0 (Vani, MiMo, ClickUp) and 1.87.0 (Arena, Meta, Ox Alpha, MultiChat × 11 ids). Claude and DeepSeek keep a bounded re-click loop ONLY on the screenshot path (send button disabled until the upload finishes; the site clears the composer synchronously on accept) - inconsistent with the rule, not observed to duplicate, left as is and listed here.", "",
  "## Known limitations (honest)", "",
  "- `multichat.js` is one generic adapter (any textarea / contenteditable + aria send/stop) for 5 playground-style hosts; composer discovery on dashboards with several text inputs (OpenRouter) is **unverified**.",
  "- Qwen's Monaco code-snapshot MutationObserver is document-wide (singleton, traced, never duplicated) - a known performance suspect on very long chats, unchanged.",
  "- Live Studio / Blender / site behaviour is outside what this repository's tests can prove.");
if (!CHECK_ONLY) fs.writeFileSync(path.join(root, "PROVIDERS.md"), md.join("\n") + "\n");
console.table(rows.map((r) => ({ id: r.id, hosts: r.hosts.length, sendPath: r.sendPath, tap: r.streamTap, tests: r.tests.length, e2e: r.e2e.length })));
console.log(`provider-inventory: ${rows.length} providers, ${pass} checks passed, ${fail} failed${CHECK_ONLY ? "" : " — PROVIDERS.md written"}`);
process.exit(fail ? 1 : 0);
