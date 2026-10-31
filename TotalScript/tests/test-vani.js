"use strict";
// Vani Chat (c.vani.ai) provider wiring + adapter sanity.
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const src = read("src/providers/vani.js");
const main = read("src/core/main.js"), bg = read("background.js"), popup = read("popup.js"), css = read("overlay.css"), readme = read("README.md");

let n = 0;
const ok = (cond, msg) => { assert(cond, msg); n++; console.log("ok   " + msg); };

ok(manifest.host_permissions.includes("https://c.vani.ai/*"), "manifest host_permissions has c.vani.ai");
const bundle = manifest.content_scripts.find((c) => c.matches.includes("https://c.vani.ai/*") && c.world !== "MAIN");
ok(bundle, "manifest has a c.vani.ai content-script bundle");
ok(bundle.js.includes("src/providers/vani.js"), "bundle loads src/providers/vani.js");
ok(bundle.js.indexOf("src/providers/vani.js") < bundle.js.indexOf("src/core/main.js"), "provider loads before the core");
for (const f of ["src/core/config.js", "src/core/screenshot.js", "src/core/templates.js", "src/core/studio_bridge.js", "src/core/paint.js", "src/core/agent_crew.js", "src/core/main.js"]) {
  ok(bundle.js.includes(f), "bundle includes " + f);
}
// 1.89.0: the Ox Alpha bundle (the former mirror) is gone; the MultiChat bundle has the same stream-reader + adapter + core shape.
const mc = manifest.content_scripts.find((c) => c.js && c.js.includes("src/providers/multichat.js") && c.world !== "MAIN");
ok(JSON.stringify(mc.js.map((j) => j.replace("multichat.js", "vani.js"))) === JSON.stringify(bundle.js), "bundle mirrors the MultiChat bundle exactly");
ok(JSON.stringify(mc.css || []) === JSON.stringify(bundle.css || []), "bundle css mirrors the MultiChat bundle");
for (const f of bundle.js) ok(fs.existsSync(path.join(root, f)), "bundle file exists: " + f);

ok(bg.includes('"https://c.vani.ai/*"'), "background PROVIDER_URLS lists c.vani.ai");
ok(popup.includes('"c.vani.ai"'), "popup SUPPORTED_HOSTS lists c.vani.ai");
ok(popup.includes('"c.vani.ai": "Vani Chat"'), "popup names the site Vani Chat");
ok(main.includes('{ name: "Vani Chat", url: "https://c.vani.ai/chat" }'), "AI switcher has a Vani Chat entry");
ok((css.match(/\.rs-prov-vani\b/g) || []).length >= 4, "overlay skin .rs-prov-vani present (inline/anchored, dark/light)");
ok(/Vani Chat/.test(readme) && /test-vani\.js/.test(readme), "README mentions Vani Chat and the test");

// Adapter contract (load in a bare DOM mock, like tests/test-provider-wiring.js).
const noop = () => {};
const el = () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, contains: () => false, toggle: noop }, setAttribute: noop, getAttribute: () => null, removeAttribute: noop, appendChild: (c) => c, remove: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }), children: [], childNodes: [], textContent: "", innerText: "" });
const doc = { ...el(), createElement: el, body: el(), documentElement: el(), getElementById: () => null, execCommand: () => true };
const win = { document: doc, location: { href: "https://c.vani.ai/chat", hostname: "c.vani.ai", pathname: "/chat", search: "" }, navigator: {}, addEventListener: noop, setTimeout, clearTimeout, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }), innerWidth: 1280, URLSearchParams, Event: class {}, KeyboardEvent: class {}, InputEvent: class {}, DataTransfer: class { constructor() { this.items = { add: noop, length: 0 }; this.files = []; } }, File: class {}, atob: (s) => Buffer.from(s, "base64").toString("binary"), console };
win.window = win;
vm.runInContext(src + "\n;window.__P = RSProvider;", vm.createContext(win));
const P = win.__P;
ok(P && P.id === "vani" && P.displayName === "Vani Chat", "adapter id/displayName");
for (const m of ["getEditor", "typeAndSend", "readAssistant", "installSendHooks", "allItems", "isGenerating", "stopGeneration", "attachImages", "scanError", "modeWarning", "loginGatePresent", "conversationKey", "findToolBlockSpot", "ensureComposerReady", "setInputLock"]) {
  ok(typeof P[m] === "function", "adapter exports " + m + "()");
}
ok(P.timings && P.timings.RESPONSE_TIMEOUT_MS > 60000, "adapter timings");
ok(P.compactCommandList === true && Number(P.commandListMaxChars) >= 6000, "compact command index for the guest allowance");
ok(P.loginGatePresent() === false, "/chat is not a login gate");
win.location.pathname = "/login"; ok(P.loginGatePresent() === true, "/login is a login gate"); win.location.pathname = "/chat";
ok(/open the chat at <b>c\.vani\.ai\/chat<\/b>/.test(P.modeWarning()), "modeWarning points at c.vani.ai/chat when no composer is found");
win.location.pathname = "/c/abc123XYZ"; ok(P.conversationKey() === "abc123XYZ", "conversationKey reads /c/<id>");
win.location.pathname = "/chat"; win.location.search = "?c=thread9"; ok(P.conversationKey() === "thread9", "conversationKey reads ?c=");
ok(P.isBusyMsg("You have used up your free allowance for today"), "allowance-exhausted message counts as busy, not fatal");
ok(P.isTooLongMsg("This message is too long"), "too-long detection");
ok(!/plazcode/i.test(src), "no PlazCode references in the adapter");
console.log(`PASS  test-vani: ${n} checks`);
