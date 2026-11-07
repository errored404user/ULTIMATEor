"use strict";
// Cross-checks every AI chat website adapter against what the core and the
// extension plumbing expect: required P.* methods, manifest bundle + host
// permissions, background status broadcast hosts, popup site names, AI
// switcher entry, overlay skin, and the optional capability matrix the paint /
// screenshot features rely on (attachImages).
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const main = read("src/core/main.js"), bg = read("background.js"), popup = read("popup.js"), css = read("overlay.css");

// P.* methods main.js calls without a guard.
const used = new Set([...main.matchAll(/\bP\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
const guardRe = (n) => new RegExp("(?:P\\." + n + "\\s*(?:&&|\\?\\.|\\|\\||\\?)|typeof\\s+P\\." + n + "|\\bP\\." + n + "\\s*(?:===|!==|==|!=|\\)|,|;)|P\\." + n + "\\s*\\|\\|)");
const REQUIRED = [...used].filter((n) => new RegExp("\\bP\\." + n + "\\(").test(main) && !guardRe(n).test(main));
assert(REQUIRED.includes("readAssistant") && REQUIRED.includes("typeAndSend") === false, "sanity: core contract extraction");

function mockWindow(host, pathname) {
  const noop = () => {};
  const el = () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, contains: () => false, toggle: noop }, setAttribute: noop, getAttribute: () => null, removeAttribute: noop, appendChild: (c) => c, insertBefore: (c) => c, remove: noop, addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }), children: [], childNodes: [], isConnected: true, textContent: "", innerText: "" });
  const doc = { ...el(), createElement: el, createTextNode: () => ({}), body: el(), head: el(), documentElement: el(), getElementById: () => null, readyState: "complete", visibilityState: "visible", activeElement: null, execCommand: () => true, hasFocus: () => true };
  const win = { document: doc, location: { href: `https://${host}${pathname}`, hostname: host, host, origin: `https://${host}`, pathname, search: "", hash: "" }, navigator: { userAgent: "Mozilla/5.0", clipboard: {} }, addEventListener: noop, removeEventListener: noop, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: noop, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop, MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} }, InputEvent: class {}, KeyboardEvent: class {}, Event: class {}, CustomEvent: class {}, MouseEvent: class {}, DragEvent: class {}, HTMLElement: class {}, HTMLTextAreaElement: class {}, HTMLInputElement: class {}, Node: class {}, DataTransfer: class { constructor() { this.items = { add: noop, length: 0 }; this.files = []; } }, File: class {}, Blob: class {}, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }), localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop }, history: { pushState: noop, replaceState: noop }, innerWidth: 1280, innerHeight: 800, performance: { now: () => Date.now() }, console: { log: noop, warn: noop, error: noop, debug: noop, info: noop }, atob: (s) => Buffer.from(s, "base64").toString("binary"), btoa: (s) => Buffer.from(s, "binary").toString("base64"), chrome: { runtime: { id: "x", getURL: (p) => p, sendMessage: noop, onMessage: { addListener: noop }, getManifest: () => manifest }, storage: { local: { get: noop, set: noop }, onChanged: { addListener: noop } } } };
  win.window = win; win.self = win; win.globalThis = win;
  return win;
}

// Every ISOLATED bundle that loads the core with a provider.
const bundles = manifest.content_scripts.filter((c) => c.world !== "MAIN" && c.js.some((j) => j.includes("src/core/main.js")));
const siteList = [...main.matchAll(/\{ name: "([^"]+)", url: "https:\/\/([^/"]+)[^"]*" \}/g)].map((m) => ({ name: m[1], host: m[2] }));
const hostOf = (pattern) => pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const matchesHost = (pattern, host) => { const h = hostOf(pattern); return h === host || (h.startsWith("*.") && host.endsWith(h.slice(1))); };

let failures = 0, rows = [];
for (const b of bundles) {
  // Shared helpers under src/providers/ (the 1.65 stream-reader) are not adapters.
  const providerFile = b.js.find((j) => /src\/providers\//.test(j) && !/stream-reader\.js$/.test(j));
  if (b.js.includes("src/providers/stream-reader.js")) {
    assert(b.js.indexOf("src/providers/stream-reader.js") < b.js.indexOf(providerFile), "stream-reader.js must load before " + providerFile);
    const tap = manifest.content_scripts.find((c) => c.world === "MAIN" && c.js.includes("src/providers/stream-net.js"));
    assert(tap && b.matches.every((m) => tap.matches.includes(m)), "every host that loads stream-reader.js must also get the MAIN-world stream-net.js tap: " + b.matches.join(","));
  }
  assert(providerFile, "bundle without provider: " + b.matches.join(","));
  assert(b.js.indexOf(providerFile) < b.js.indexOf("src/core/main.js"), providerFile + " must load before the core");
  assert(b.js.indexOf("src/core/config.js") === 0, "config.js first in " + providerFile);
  for (const f of b.js) assert(fs.existsSync(path.join(root, f)), "missing file " + f + " in bundle for " + providerFile);
  for (const c of b.css || []) assert(fs.existsSync(path.join(root, c)), "missing css " + c);
  const hosts = [...new Set(b.matches.map(hostOf))];
  for (const h of hosts) {
    const problems = [];
    const pathname = h === "huggingface.co" ? "/chat/" : h === "www.notion.so" ? "/ai" : "/";
    const win = mockWindow(h, pathname);
    let P = null;
    try { vm.runInContext(read(providerFile) + "\n;window.__P = typeof RSProvider !== 'undefined' ? RSProvider : window.RSProvider;", vm.createContext(win)); P = win.__P; }
    catch (e) { problems.push("load error: " + e.message); }
    if (P) {
      for (const m of REQUIRED) if (typeof P[m] !== "function") problems.push("missing core-required P." + m + "()");
      for (const m of ["typeAndSend", "getEditor", "installSendHooks", "timings"]) if (!(m in P)) problems.push("missing P." + m);
      if (!P.id || !P.displayName) problems.push("missing id/displayName");
      // Dedicated skins are optional for the multi-site adapter's secondary hosts (generic bar styling applies).
      if (P.id && !css.includes("rs-prov-" + P.id) && !/multichat/.test(providerFile)) problems.push("no overlay skin .rs-prov-" + P.id);
    }
    if (!manifest.host_permissions.some((p) => matchesHost(p, h))) problems.push("host not in host_permissions");
    if (!bg.includes(h)) problems.push("background.js never broadcasts status to " + h);
    const popupKnows = popup.includes(`"${h}"`) || popup.split(/[\s"',]+/).some((tok) => tok && h.endsWith(tok) && tok.includes(".") && tok.length > 5);
    if (!popupKnows) problems.push("popup.js has no site name for " + h);
    // Switcher: at least one host of this bundle must be listed (aliases like chat.openai.com / claude.com need not be).
    if (!hosts.some((hh) => siteList.some((s) => s.host === hh || hh.endsWith(s.host.replace(/^www\./, "")) || s.host.endsWith(hh.replace(/^www\./, ""))))) problems.push("none of this bundle's hosts is in the AI switcher list");
    rows.push({ host: h, provider: path.basename(providerFile), id: P && P.id, attachImages: !!(P && P.attachImages), stop: !!(P && P.stopGeneration), problems });
    if (problems.length) failures++;
  }
}
for (const r of rows) console.log(`${r.problems.length ? "FAIL" : "ok  "} ${r.host.padEnd(34)} ${String(r.provider).padEnd(14)} id=${String(r.id).padEnd(10)} images=${r.attachImages ? "yes" : "NO "} ${r.problems.join("; ")}`);
// Switcher entries must point at hosts some bundle actually injects into.
for (const s of siteList) {
  const injected = bundles.some((b) => b.matches.some((m) => matchesHost(m, s.host)));
  if (!injected) { console.log(`FAIL switcher entry "${s.name}" (${s.host}) has no content-script bundle`); failures++; }
}
// MAIN-world taps must sit on hosts that also get the isolated bundle.
for (const c of manifest.content_scripts.filter((c) => c.world === "MAIN")) {
  for (const m of c.matches) if (!bundles.some((b) => b.matches.includes(m))) { console.log(`FAIL MAIN-world tap ${c.js.join(",")} on ${m} without an isolated bundle`); failures++; }
}
// ── Extension-hosted chat pages (API-only providers such as CodeCraft) ──────
// These load the bundle through <script> tags instead of a content_scripts
// entry, so the same ordering / contract / plumbing rules are checked here.
const PAGES = [{ html: "codecraft.html", provider: "src/providers/codecraft.js", id: "codecraft", name: "CodeCraft API", apiHost: "codecraftapi.com" }];
const refBundle = bundles.find((b) => b.js.some((j) => /vani\.js/.test(j))) || bundles[0];
let pageRows = 0;
for (const pg of PAGES) {
  const problems = [];
  if (!fs.existsSync(path.join(root, pg.html))) { console.log(`FAIL page ${pg.html} missing`); failures++; continue; }
  const html = read(pg.html);
  const js = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const cssLinks = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  if (/<script>|\son[a-z]+="/.test(html)) problems.push("inline script / handler (blocked by the extension CSP)");
  if (js[0] !== "src/core/config.js") problems.push("config.js must load first");
  if (!js.includes(pg.provider)) problems.push("page does not load " + pg.provider);
  if (js.indexOf(pg.provider) > js.indexOf("src/core/main.js")) problems.push("provider must load before the core");
  for (const f of [...js, ...cssLinks]) if (!fs.existsSync(path.join(root, f))) problems.push("missing file " + f);
  if (!cssLinks.includes("overlay.css")) problems.push("overlay.css not linked");
  // Same module set as a hosted bundle (only the provider differs).
  const expect = refBundle.js.filter((j) => !/stream-reader\.js$/.test(j)).map((j) => (/src\/providers\//.test(j) ? pg.provider : j));
  if (JSON.stringify(expect) !== JSON.stringify(js)) problems.push("script list differs from the reference bundle: " + JSON.stringify(js.filter((j) => !expect.includes(j)).concat(expect.filter((j) => !js.includes(j)))));
  const win = mockWindow(pg.apiHost, "/");
  let P = null;
  try { vm.runInContext(read(pg.provider) + "\n;window.__P = typeof RSProvider !== 'undefined' ? RSProvider : window.RSProvider;", vm.createContext(win)); P = win.__P; }
  catch (e) { problems.push("load error: " + e.message); }
  if (P) {
    for (const m of REQUIRED) if (typeof P[m] !== "function") problems.push("missing core-required P." + m + "()");
    for (const m of ["typeAndSend", "getEditor", "installSendHooks", "timings"]) if (!(m in P)) problems.push("missing P." + m);
    if (P.id !== pg.id || P.displayName !== pg.name) problems.push("id/displayName mismatch");
    if (!css.includes("rs-prov-" + pg.id)) problems.push("no overlay skin .rs-prov-" + pg.id);
  }
  if (!manifest.host_permissions.some((p) => matchesHost(p, pg.apiHost))) problems.push("API host not in host_permissions");
  if (!bg.includes(pg.html)) problems.push("background.js does not broadcast status to the page");
  if (!popup.includes(pg.html) || !popup.includes(pg.name)) problems.push("popup.js cannot open / name the page");
  if (!read("popup.html").includes(pg.id)) problems.push("popup.html has no launcher for the page");
  if (!main.includes(`{ name: "${pg.name}"`) || !main.includes(pg.html)) problems.push("AI switcher has no entry for the page");
  if (!main.includes("rs-open-extension-page") || !bg.includes("rs-open-extension-page")) problems.push("switcher cannot open an extension page via the background worker");
  console.log(`${problems.length ? "FAIL" : "ok  "} ${(pg.html + " (extension page)").padEnd(34)} ${path.basename(pg.provider).padEnd(14)} id=${String(P && P.id).padEnd(10)} images=${P && P.attachImages ? "yes" : "NO "} ${problems.join("; ")}`);
  if (problems.length) failures++;
  pageRows++;
}
if (failures) { console.log(`\n${failures} provider wiring problem(s)`); process.exit(1); }
console.log(`PASS  ${rows.length} AI chat hosts across ${bundles.length} bundles + ${pageRows} extension chat page(s) are fully wired (core contract: ${REQUIRED.length} required methods)`);
