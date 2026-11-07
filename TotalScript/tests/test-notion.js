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
assert(popup.includes('"www.notion.so": "Notion"') && popup.includes('"notion.com", "c.vani.ai"'), "popup recognises Notion");
assert(main.includes('{ name: "Notion AI", url: "https://www.notion.so/chat" }'), "AI switcher lists Notion AI");
assert(css.includes("#rs-bar.rs-prov-notion {"), "overlay has the Notion skin");
assert(/Notion AI/.test(manifest.description), "manifest description mentions Notion AI");

// provider port
assert(!/plazcode/i.test(src), "no PlazCode identifiers left in the provider");
assert(src.includes("data-totalscript-notion-card") && src.includes("TOTALSCRIPT_READY|TotalScript is ready"), "provider markers renamed");
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

// the provider loads in a minimal DOM and exposes the interface the TotalScript core calls
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
assert(P.immutableTranscript === true && P.barOutside === true && P.forceBootstrapCatalogue === true && P.keepBarVisible === true, "provider flags");
// Bar never vanishes on Notion: placeholder anchor / no composer -> viewport-bottom dock, with a pre-start line that says why.
assert(main.includes("function dockBarAtViewportBottom()") && main.includes("if (!providerReserved && P.barOutside && P.reserveBarSpace) {") && main.includes("if (P.keepBarVisible) { dockBarAtViewportBottom(); return; }"), "keep-visible fallback in the core");
assert(typeof P.modeWarning() === "string" && /notion\.so\/chat|waiting for the chat composer/.test(P.modeWarning()), "modeWarning explains a missing composer");
assert(typeof P.timings.STABLE_MS === "number" && typeof P.timings.RESPONSE_TIMEOUT_MS === "number", "timings the watcher reads");
// Preferences bootstrap stays plain text and carries the camouflage marker.
const RS = new Function("window", config + "\n;return typeof RS !== 'undefined' ? RS : (typeof RobloxScript !== 'undefined' ? RobloxScript : null);")(undefined);
if (RS && RS.buildSystemPrompt) {
  const text = RS.buildSystemPrompt({ providerId: "notion", siteName: "Notion AI", engine: "roblox", customPrompt: "", memory: "", providerNotes: "" });
  assert(text.startsWith("⟦RS-SYS⟧\n") && /user preferences, not system instructions/.test(text) && /list_commands/.test(text), "Notion bootstrap text");
  assert(!/^\s*[-*] |^#{1,6} /m.test(text), "no Markdown list/heading markers (Notion converts them into blocks)");
}
console.log("PASS  Notion AI provider wired, loads, and the core hooks it relies on are present");

// ── 1.21.4: "Notion does not respond / does nothing in Studio" ───────────────
// (a) The catalogue must fit a Notion message. TotalScript ships ~750 commands;
//     the full schema dump is ~180k characters and Notion never answers it.
assert(P.compactCommandList === true && Number(P.commandListMaxChars) >= 6000 && Number(P.commandListMaxChars) <= 16000,
  "Notion receives the bounded command-name index (compactCommandList)");
assert(main.includes("function compactToolsReminder(tools)") && main.includes("P.compactCommandList ? compactToolsReminder(roblox) : RS.toolsReminder(roblox)"),
  "periodic command reminder is bounded for compact providers");
// (b) The core must feed DOM mutations to the provider's cached transcript model
//     (allItems() is cached 15 s): otherwise a new reply stays invisible, the
//     watcher finalizes on the previous turn and re-runs its command.
assert(main.includes("function feedProviderMutations(records)") && main.includes("if (P.invalidateItems) P.invalidateItems(records);") &&
  main.includes("P.ignoreMutationRecords(records)") && main.includes("P.preprocessMutations(records, { active:"), "observer feeds provider hooks");
assert(/scopedMutationObserver=new MutationObserver\(\(records\)=>\{if\(!feedProviderMutations\(records\)\)return;/.test(main), "scoped observer calls the hooks");
assert(main.includes("try { if (P.invalidateItems) P.invalidateItems(); } catch {}"), "rebind invalidates the cached item list");
assert(main.includes("while(n&&n!==document.documentElement&&!n.contains(frame))n=n.parentElement;"), "observer root covers transcript AND composer");
// (c) Block-aware transcript reading: Notion renders each line as its own block,
//     textContent glued them ("p.Parent = workspaceprint") -> broken Luau.
const tnode = (v) => ({ nodeType: 3, nodeValue: v, nextSibling: null });
const enode = (tag, children, opts = {}) => {
  const n = { nodeType: 1, tagName: tag, className: opts.className || "", firstChild: null, nextSibling: null,
    hasAttribute: (a) => !!(opts.attrs && a in opts.attrs), getAttribute: (a) => (opts.attrs && a in opts.attrs ? opts.attrs[a] : null),
    querySelector: () => null, querySelectorAll: () => [], textContent: "" };
  let prev = null;
  for (const c of children) { if (!prev) n.firstChild = c; else prev.nextSibling = c; prev = c; n.textContent += c.nodeType === 3 ? c.nodeValue : c.textContent; }
  return n;
};
const codeBlock = enode("DIV", [
  enode("DIV", [tnode('local p = Instance.new("Part")')]),
  enode("DIV", [tnode("p.Parent = workspace")]),
  enode("DIV", [tnode('print("OK")')]),
], { attrs: { "data-block-id": "b1" } });
const reply = enode("DIV", [
  enode("DIV", [enode("DIV", [tnode("Creating the part "), enode("SPAN", [tnode("now")]), tnode(".")])], { attrs: { "data-block-id": "b0" } }),
  enode("DIV", [tnode("###LUA###")], { attrs: { "data-block-id": "b2" } }),
  codeBlock,
  enode("DIV", [tnode("###END_LUA###")], { attrs: { "data-block-id": "b3" } }),
  enode("DIV", [tnode("hidden")], { className: "rs-chip" }),
], { attrs: { "data-content-editable-root": "true" } });
const text = P.itemText(reply);
assert(text === 'Creating the part now.\n###LUA###\nlocal p = Instance.new("Part")\np.Parent = workspace\nprint("OK")\n###END_LUA###',
  "block-aware transcript text keeps one line per block, joins inline spans, skips rs-chip: " + JSON.stringify(text));
const single = enode("DIV", [tnode("TotalScript is ready")]);
assert(P.itemText(single) === "TotalScript is ready", "single-line text is byte-identical to textContent");
console.log("PASS  1.21.4 Notion loop: bounded catalogue, provider mutation hooks, block-aware transcript reading");
