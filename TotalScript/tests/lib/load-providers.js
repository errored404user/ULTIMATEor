"use strict";
// 2.13.0 — shared loader for the SIMULATED benchmarks: evaluates every chat-site
// provider adapter from manifest.json inside a minimal window mock and returns
// its REAL flags (ids, budgets, pacing, command format). Copied from
// test-provider-bench.js so both benchmarks load exactly the same adapters.
// Nothing here contacts a provider.
const fs = require("fs"), path = require("path"), vm = require("vm");
module.exports = function loadProviders(root) {
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
  const manifest = JSON.parse(read("manifest.json"));
  const noop = () => {};
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
    const pathname = host === "huggingface.co" ? "/chat/" : host === "www.notion.so" ? "/ai" : "/";
    const win = mockWindow(host, pathname), ctx = vm.createContext(win);
    try {
      if (b.js.includes("src/providers/stream-reader.js")) vm.runInContext(read("src/providers/stream-reader.js"), ctx);
      vm.runInContext(read(file) + "\n;window.__P = typeof RSProvider !== 'undefined' ? RSProvider : window.RSProvider;", ctx);
    } catch (e) { continue; }
    const P = win.__P;
    if (!P || seen.has(P.id)) continue;
    seen.add(P.id);
    providers.push({ id: P.id, P, file });
  }
  providers.sort((a, b) => a.id.localeCompare(b.id));
  return providers;
};
