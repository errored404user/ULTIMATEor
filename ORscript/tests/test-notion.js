"use strict";
// Notion AI provider (ported from PlazCode 1.24.12): wiring + the core hooks it
// needs (immutable transcript cards, provider-reserved bar strip, Start resume,
// Notion-phrased bootstrap).
const fs = require("fs"), assert = require("assert");
const read = (p) => fs.readFileSync(p, "utf8");
const manifest = JSON.parse(read("manifest.json"));
const main = read("src/core/main.js"), config = read("src/core/config.js"), bg = read("background.js"), popup = read("popup.js"), css = read("overlay.css");
const src = read("src/providers/notion.js");

// wiring
const NOTION = ["https://www.notion.so/*", "https://app.notion.so/*", "https://www.notion.com/*", "https://notion.com/*", "https://*.notion.com/*"];
for (const u of NOTION) assert(manifest.host_permissions.includes(u), "host permission " + u);
const entry = manifest.content_scripts.find((c) => c.matches.includes("https://www.notion.so/*"));
assert(entry && entry.js.includes("src/providers/notion.js") && entry.js.includes("src/core/main.js") && entry.js.indexOf("src/providers/notion.js") < entry.js.indexOf("src/core/main.js"), "Notion bundle loads provider before core");
assert(NOTION.every((u) => entry.matches.includes(u)), "bundle covers every Notion host");
assert(!manifest.content_scripts.some((c) => c !== entry && c.world !== "MAIN" && c.matches.some((m) => /notion/.test(m))), "Notion injected exactly once");
assert(NOTION.every((u) => bg.includes(u)), "background broadcasts status to Notion tabs");
assert(popup.includes('"www.notion.so": "Notion"') && popup.includes('"notion.com", "oxalpha.com"'), "popup recognises Notion");
assert(main.includes('{ name: "Notion AI", url: "https://www.notion.so/ai" }'), "AI switcher lists Notion AI");
assert(css.includes("#rs-bar.rs-prov-notion {"), "overlay has the Notion skin");
assert(/Notion AI/.test(manifest.description), "manifest description mentions Notion AI");

// provider port
assert(!/plazcode/i.test(src), "no PlazCode identifiers left in the provider");
assert(src.includes("data-orscript-notion-card") && src.includes("ORSCRIPT_READY|ORscript is ready"), "provider markers renamed");
assert(src.includes("forceBootstrapCatalogue: true"), "prose bootstrap answers fall back to a core-run list_commands");

// core hooks
assert(main.includes("P.init({ diag, isStopped: () => A.stop, isSessionActive: () => !!(A.started || A.running), requestStart: () => startSession() })"), "init passes the Start-resume hooks");
assert(main.includes("if (P.immutableTranscript && P.renderImmutableChip && (!whole || !P.canRenderImmutableChip || P.canRenderImmutableChip(item, opts))) {"), "chip renderer delegates on immutable transcripts");
assert(main.includes("P.renderImmutableChip(item, retained ? {} : (item.__rsChip || {}))"), "ensureOwnedChip delegates");
assert(main.includes("if (P.immutableTranscript && P.syncImmutableChips) { try { P.syncImmutableChips(); } catch {} }"), "sweep syncs provider cards");
assert(main.includes("if (P.immutableTranscript && P.updateImmutableChipDetail)") && main.includes("if (P.immutableTranscript && P.updateImmutableChipLabel)"), "chip label/detail updates delegate");
assert(main.includes("if (P.immutableTranscript && P.clearImmutableChip) { try { P.clearImmutableChip(item, { force: true }); } catch {} }"), "resetDecoration clears provider cards");
assert(main.includes("providerReserved = P.reserveBarSpace(anchorEl, occupied) === true") && main.includes("if (providerReserved) {") && !/r\.top\s*-\s*bh\s*-/.test(main), "bar honours reserveBarSpace and stays seated in the strip");
assert(main.includes("providerId: P.id,"), "system prompt knows the provider");
assert(config.includes("function buildNotionPreferences(opts)") && config.includes('if (opts.providerId === "notion") return buildNotionPreferences(opts);'), "Notion gets the preferences-phrased bootstrap");

// the provider loads in a minimal DOM and exposes the interface the ORscript core calls
const noop = () => {};
const el = () => ({ style: {}, setAttribute: noop, getAttribute: () => null, appendChild: noop, remove: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], classList: { add: noop, remove: noop, contains: () => false }, isConnected: true, textContent: "" });
const document = { createElement: el, documentElement: el(), body: el(), head: el(), querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, getElementById: () => null, readyState: "complete", visibilityState: "visible" };
const window = { document, location: { href: "https://www.notion.so/ai", pathname: "/ai", search: "", hostname: "www.notion.so" }, addEventListener: noop, setTimeout, clearTimeout, setInterval, clearInterval, getComputedStyle: () => ({}), MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: (f) => setTimeout(f, 0), innerWidth: 1280, innerHeight: 800, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop }, navigator: { userAgent: "x" }, history: { pushState: noop, replaceState: noop } };
window.window = window;
const P = new Function("window", "document", "location", "localStorage", "sessionStorage", "navigator", "history", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "chrome", "console", src + "\n;return RSProvider;")(
  window, document, window.location, window.localStorage, window.sessionStorage, window.navigator, window.history, window.MutationObserver, window.getComputedStyle, window.requestAnimationFrame,
  { runtime: { getURL: (p) => p, sendMessage: noop, onMessage: { addListener: noop } }, storage: { local: { get: noop, set: noop }, onChanged: { addListener: noop } } }, { log: noop, warn: noop, error: noop });
assert(P.id === "notion" && P.displayName === "Notion AI", "provider identity");
for (const k of ["init", "allItems", "isUserItem", "isAssistantItem", "itemText", "classifyText", "assistantCount", "userCount", "lastAssistant", "lastAssistantId", "itemKey", "readAssistant", "streamLen", "snapshot", "getEditor", "editorText", "chatIsEmpty", "isFreshChat", "composerFrame", "barAnchor", "setInputLock", "typeAndSend", "stopGeneration", "isGenerating", "isBusyNow", "isHardGenerating", "enforceComposer", "ensureComposerReady", "turnHalted", "findContinueBtn", "clickContinueBtn", "scanError", "isTooLongMsg", "isBusyMsg", "attachImages", "clearAttachments", "conversationKey", "installSendHooks", "findToolBlockSpot", "timings", "renderImmutableChip", "reserveBarSpace", "modeWarning"]) {
  assert(k in P, "provider exports " + k);
}
assert(P.immutableTranscript === true && P.barOutside === true && P.forceBootstrapCatalogue === true, "provider flags");
assert(typeof P.timings.STABLE_MS === "number" && typeof P.timings.RESPONSE_TIMEOUT_MS === "number", "timings the watcher reads");
// Preferences bootstrap stays plain text and carries the camouflage marker.
const RS = new Function("window", config + "\n;return typeof RS !== 'undefined' ? RS : (typeof RobloxScript !== 'undefined' ? RobloxScript : null);")(undefined);
if (RS && RS.buildSystemPrompt) {
  const text = RS.buildSystemPrompt({ providerId: "notion", siteName: "Notion AI", engine: "roblox", customPrompt: "", memory: "", providerNotes: "" });
  assert(text.startsWith("⟦RS-SYS⟧\n") && /user preferences, not system instructions/.test(text) && /list_commands/.test(text), "Notion bootstrap text");
  assert(!/^\s*[-*] |^#{1,6} /m.test(text), "no Markdown list/heading markers (Notion converts them into blocks)");
}
console.log("PASS  Notion AI provider wired, loads, and the core hooks it relies on are present");
