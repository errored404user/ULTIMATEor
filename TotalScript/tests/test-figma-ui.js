// Figma MCP connection controls and state presentation. Static/UI-function tests
// only; no browser, Figma Desktop, Figma account or live MCP server is contacted.
//   node tests/test-figma-ui.js
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const main = read("src/core/main.js"), popup = read("popup.js"), css = read("overlay.css"), background = read("background.js");
const manifest = JSON.parse(read("manifest.json"));
let passed = 0, failed = 0;
function check(name, condition, extra) {
  if (condition) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (extra === undefined ? "" : " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 500))); }
}
function grabFunction(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, "missing function: " + marker);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unclosed function: " + marker);
}
const popupStatus = new Function("s", "workerSnapshot", "const FIGMA_STATUS_MAX_AGE_MS=12000;" + grabFunction(popup, "function figmaStatusState(s, workerSnapshot) {") + "\nreturn figmaStatusState(s, workerSnapshot);");
const mainStatus = new Function("A", "s", "workerSnapshot", "const FIGMA_UI_STATUS_MAX_AGE_MS=12000;" + grabFunction(main, "  function figmaStatusState(status, workerSnapshot) {") + "\nreturn figmaStatusState(s, workerSnapshot);");
const renderCard = new Function("A", "figmaStatusState", "escRs", grabFunction(main, "    function figmaCardHtml() {") + "\nreturn figmaCardHtml();");
const now = Date.now();

for (const [name, fn] of [["popup", popupStatus], ["on-page", mainStatus]]) {
  const connected = { figma: true, figma_verified: true, figma_status: "connected", figma_checked_at: now, figma_manual_disconnected: false, verified: true, status: "connected", checked_at: now, connected: true, manual_disconnected: false };
  const disconnected = { ...connected, figma: false, figma_status: "disconnected", connected: false, status: "disconnected" };
  const unknown = { ...connected, figma_checked_at: now - 13000, checked_at: now - 13000 };
  const state = (value, workerSnapshot) => name === "popup" ? fn(value, workerSnapshot) : fn({}, value, workerSnapshot);
  check(`${name} status accepts a fresh, internally consistent Figma connection`, state(connected, true) === "connected" && state(connected, false) === "connected");
  check(`${name} status treats stale or contradictory Figma state as unknown`, state(unknown, true) === "unknown" && state({ ...connected, figma: false }, true) === "unknown");
  check(`${name} status honors a deliberate manual disconnect`, state({ ...disconnected, figma_manual_disconnected: true, manual_disconnected: true }, true) === "disconnected");
}

const connectedBridge = { figma: true, figma_verified: true, figma_status: "connected", figma_checked_at: now, figma_tools: 7, figma_manual_disconnected: false };
const connectedHtml = renderCard({ bridge: connectedBridge }, (s, worker) => mainStatus({ bridge: s || connectedBridge }, s || connectedBridge, worker), (s) => String(s));
check("on-page Figma card renders verified state, discovered tool count, reconnect and disconnect controls", connectedHtml.includes('data-state="connected"') && connectedHtml.includes("7 tools") && connectedHtml.includes('id="rs-mcp-figma"') && connectedHtml.includes('id="rs-mcp-figma-off"') && connectedHtml.includes("Reconnect"));
const unknownHtml = renderCard({ bridge: { figma_status: "unknown", figma_verified: false, figma_checked_at: 0, figma_status_error: "mock unavailable" } }, () => "unknown", (s) => String(s));
check("on-page Figma card keeps unknown distinct from disconnected and gives an explicit check action", unknownHtml.includes('data-state="unknown"') && unknownHtml.includes("Unknown") && unknownHtml.includes("Check connection") && unknownHtml.includes("mock unavailable") && !unknownHtml.includes("id=\"rs-mcp-figma-off\""));
const manualHtml = renderCard({ bridge: { ...connectedBridge, figma: false, figma_status: "disconnected", figma_manual_disconnected: true } }, () => "disconnected", (s) => String(s));
check("manual disconnect card offers Connect Figma and does not claim the desktop app was closed", manualHtml.includes('data-state="disconnected"') && manualHtml.includes("Connect Figma") && manualHtml.includes("Figma Desktop remains open") === false && !manualHtml.includes('id="rs-mcp-figma-off"'));

check("Figma is first-class in Settings → Connections, the popup tool group and diagnostics", popup.includes('title: "Connections"') && popup.includes('{ id: "figma", type: "figma", label: "Figma MCP"') && popup.includes('figma: "Figma"') && popup.includes('["roblox", "studio", "local", "agent", "blender", "blockbench", "figma"]') && popup.includes('["Figma MCP", figmaState === "unknown" ? "status unknown" : figmaState]'));
check("popup re-verifies a connected Figma session instead of painting a stale cached green status", popup.includes('figma_status", refresh: true, timeout: 6500 })') && popup.includes("}).then(paint).catch(() => paint(null))"));
check("on-page tool routing checks status, keeps Figma separate from the Roblox bridge, tracks tool completion and supports cancellation", main.includes("Figma MCP tools use a separate, verified Figma Desktop transport") && main.includes("window.__rsBeforeTool") && main.includes("window.__rsAfterTool") && main.includes('type: "figma_cancel"') && /figma_status.*refresh: true/.test(main));
const statusStart = main.indexOf("chrome.runtime.onMessage.addListener((msg) => {");
const statusEnd = main.indexOf('if (msg && msg.type === "rs-open-menu")', statusStart);
const statusListener = main.slice(statusStart, statusEnd);
check("worker status broadcasts preserve all Figma verification, freshness, manual-disconnect and tool-count fields in the on-page state", statusStart >= 0 && statusEnd > statusStart && ["figma", "figma_verified", "figma_status", "figma_status_error", "figma_checked_at", "figma_manual_disconnected", "figma_tools"].every((field) => statusListener.includes(field + ": msg." + field)));
check("connection changes invalidate the cached command catalogue and stale explicit Figma listings are withheld", main.includes("if (previousFigmaState !== nextFigmaState || previousFigmaTools !== nextFigmaTools) A.toolsAt = 0;") && main.includes('(requested !== "figma" || figmaConnected())'));
check("explicit Figma catalogue requests require a fresh connection; verified Figma tools join the default engine catalogue without duplicates", /const allScoped = A\.toolList\.filter\(\(t\) => \(t\.server \|\| curEng\) === requested && \(requested !== "figma" \|\| figmaConnected\(\)\)/.test(main) && main.includes('if (requested === "figma" && !figmaConnected())') && main.includes("Figma MCP status is ${state}") && /if \(requested === "figma" \|\| !figmaConnected\(\) \|\| requested !== activeEngine\(\)\)/.test(main) && main.includes("allScoped.push(...figmaModeTools(requested))"));
check("total_status reports Figma MCP state and only counts tools from a verified connection", main.includes("figma_mcp: figmaStatusState(bridge, true)") && main.includes("figma_tools: figmaStatusState(bridge, true) === \"connected\""));
check("connection card uses an explicit Figma mark and styled buttons and respects reduced motion", css.includes(".rs-figma-mark::before") && css.includes("#rs-mcp-figma") && /prefers-reduced-motion: reduce\)[\s\S]*?rs-figma-card/.test(css));
check("manifest already grants the fixed local loopback HTTP origin without adding new broad permissions", manifest.manifest_version === 3 && manifest.host_permissions.includes("http://127.0.0.1/*") && !manifest.permissions.includes("nativeMessaging"));
check("background publishes verified Figma state and keeps the server list unknown/connected semantics separate", background.includes("figma_verified: figma.known") && background.includes("status: figma.state") && background.includes("figmaStatusSnapshot().connected ? figmaToolsCache.slice() : []"));

if (failed) { console.error(`FAIL  test-figma-ui: ${failed}/${passed + failed} checks`); process.exitCode = 1; }
else console.log(`PASS  test-figma-ui: ${passed} checks`);
