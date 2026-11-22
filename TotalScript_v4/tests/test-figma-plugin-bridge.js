// Figma Design plugin bridge: token pairing, local-only permissions, scoped
// Origin:null/CORS, tool discovery and a simulated tool job. No live Figma,
// desktop app, extension runtime, or network is contacted.
//   node tests/test-figma-plugin-bridge.js
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const agent = read("agent/src/main.rs"), rust = read("agent/src/figma_plugin.rs");
const plugin = read("plugin/figma/TotalScript-Figma.js"), ui = read("plugin/figma/ui.html");
const popup = read("popup.js"), background = read("background.js"), main = read("src/core/main.js");
const manifest = JSON.parse(read("plugin/figma/manifest.json"));
let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (extra === undefined ? "" : " — " + String(extra).slice(0, 500))); }
}
function reply(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

// The manifest deliberately grants the plugin one loopback origin and no cloud access.
check("Figma manifest targets the Design editor and permits only TotalScript on 127.0.0.1:3000", manifest.editorType.length === 1 && manifest.editorType[0] === "figma" && manifest.networkAccess.allowedDomains.length === 1 && manifest.networkAccess.allowedDomains[0] === "none" && manifest.networkAccess.devAllowedDomains.length === 1 && manifest.networkAccess.devAllowedDomains[0] === "http://127.0.0.1:3000");
check("plugin UI explains normal Figma plugin import and does not require Dev Mode", /Plugins → Development → Import plugin from manifest/.test(popup) && /Dev Mode is not required/.test(popup) && /no Dev Mode or API key/i.test(ui));
check("plugin privacy notice discloses local-only transport and requested-data/export handoff to the selected AI provider", /Requests go only to 127\.0\.0\.1:3000/.test(ui) && /Only data needed for the operation you request \(or selected export layers\)/.test(ui) && /may be passed to your chosen AI provider/.test(ui));
check("plugin runtime uses only the existing local HTTP bridge and a dedicated token header", plugin.includes('const API = "http://127.0.0.1:3000/api/figma-plugin"') && plugin.includes('const TOKEN_HEADER = "X-TotalScript-Figma-Token"') && !/https?:\/\/(?!127\.0\.0\.1:3000)/i.test(plugin));

// Rust hub and browser entry points expose the same explicit tool allowlist.
const rustNamesBlock = rust.match(/const TOOL_NAMES: &\[&str\] = &\[(.*?)\];/s);
const runtimeNamesBlock = plugin.match(/const ALLOWED_TOOLS = new Set\(\[(.*?)\]\);/s);
const rustNames = rustNamesBlock ? [...rustNamesBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
const runtimeNames = runtimeNamesBlock ? [...runtimeNamesBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
check("Rust catalog and in-plugin allowlist have matching operation names", rustNames.length === runtimeNames.length + 1 && rustNames.filter((name) => name !== "figma_plugin_status").sort().join("|") === runtimeNames.sort().join("|"));
check("Figma tools are a distinct MCP-style server and Desktop MCP names remain separate", rust.includes('"server": "figma_plugin"') && rust.includes('!is_tool("figma_get_file")') && agent.includes('figma_plugin::is_tool(&name)') && background.includes("isFigmaPluginToolName(msg.name)") && background.includes("dispatchFigmaTool(msg.name"));
check("TotalScript advertises Figma Design plugin separately and documents the explicit server id", background.includes('id: "figma_plugin", name: "Figma Design plugin"') && main.includes('Use list_commands with a "server" param') && main.includes('Figma Design plugin uses server "figma_plugin"') && main.includes('"figma".'));
check("popup has code generation, clipboard, verified status and revoke controls", popup.includes('type: "figma_plugin_pair"') && popup.includes('type: "figma_plugin_status"') && popup.includes('type: "figma_plugin_revoke"') && popup.includes("navigator.clipboard.writeText(pairingToken)") && popup.includes("figma_plugin_verified"));
check("pair/revoke messages are restricted to the exact extension Settings popup and the token is not persisted", background.includes('function trustedFigmaSettingsPopup(sender)') && background.includes('sender.id !== chrome.runtime.id || sender.tab') && background.includes('chrome.runtime.getURL("popup.html")') && background.includes("if (!trustedFigmaSettingsPopup(sender))") && !/chrome\.storage\.(?:local|sync|session)\.set\([^\n]*pairing_token/i.test(background));

// Route presence, body sizing, authentication and path-scoped CORS are pinned.
const routes = ["pair", "hello", "poll", "result", "goodbye", "status", "revoke"];
check("all seven Figma HTTP handlers are mounted on the existing port-3000 router", routes.every((route) => agent.includes(`.route("/api/figma-plugin/${route}"`)) && agent.includes('default_value = "127.0.0.1:3000"'));
check("large image results receive an 8 MiB route-local body limit", agent.includes('.route("/api/figma-plugin/result", post(figma_plugin::result_handler).layer(axum::extract::DefaultBodyLimit::max(8 * 1024 * 1024)))') && rust.includes("const MAX_RESULT_BYTES: usize = 7 * 1024 * 1024"));
check("CORS and origin guard accept Origin:null only for the four plugin requests that need it", agent.includes('origin_allowed_for_path(origin.to_str().ok(), parts.uri.path())') && ["hello", "poll", "result", "goodbye"].every((route) => agent.includes(`/api/figma-plugin/${route}`)) && ["pair", "status", "revoke"].every((route) => !/fn figma_plugin_null_origin_route\(path: &str\) -> bool \{[\s\S]*?\n\}/.exec(agent)?.[0].includes(`/api/figma-plugin/${route}`)));
check("pair and revoke handlers reject null, missing and web origins", rust.includes("fn pairing_request_allowed(origin: Option<&str>)") && rust.includes("extension_origin(origin)"));
check("the Figma plugin source is compiled from its actual subdirectory path", rust.includes('include_str!("../../plugin/figma/TotalScript-Figma.js")') && fs.existsSync(path.resolve(ROOT, "agent/src/../../plugin/figma/TotalScript-Figma.js")));
check("background and on-page status carry the paired plugin's independent liveness and tool count", background.includes("figma_plugin_status: figmaPluginStatus") && background.includes("figma_plugin_verified: figmaPluginVerified") && main.includes("figma_plugin_status: msg.figma_plugin_status") && main.includes("figma_design_plugin: figmaPluginStatusState(bridge)"));

// Run the real plugin source in a minimal in-memory Figma stand-in and exercise
// pairing, authenticated long-poll, one allowlisted canvas operation and result.
(async () => {
  const store = new Map(), uiMessages = [], requests = [], results = [];
  const page = {
    id: "page-1", type: "PAGE", name: "Canvas", children: [], selection: [],
    appendChild(node) { node.parent = this; this.children.push(node); },
  };
  let nextNodeId = 1;
  const figma = {
    root: { name: "Mock Design", children: [page] },
    currentPage: page,
    mixed: Symbol("mixed"),
    ui: { onmessage: null, postMessage: (msg) => uiMessages.push(msg) },
    showUI() {},
    on() {},
    clientStorage: {
      getAsync: async (key) => store.get(key),
      setAsync: async (key, value) => { store.set(key, value); },
      deleteAsync: async (key) => { store.delete(key); },
    },
    createFrame() {
      return {
        id: `frame-${nextNodeId++}`, type: "FRAME", name: "", x: 0, y: 0, width: 0, height: 0,
        fills: [], strokes: [], resize(width, height) { this.width = width; this.height = height; },
      };
    },
  };
  const pairingCode = "a".repeat(64), sessionToken = "b".repeat(64);
  let deliveredJob = false;
  const fakeFetch = async (url, init = {}) => {
    const request = { url: String(url), init: { ...init, headers: { ...(init.headers || {}) } } };
    requests.push(request);
    if (request.url.endsWith("/hello")) return reply(200, { ok: true, session_token: sessionToken, tools: 16 });
    if (request.url.includes("/poll?")) {
      if (!deliveredJob) {
        deliveredJob = true;
        return reply(200, { ok: true, job: { id: "job-1", name: "figma_plugin_create_frame", args: { name: "Bridge frame", width: 320, height: 180, x: 12, y: 34 } } });
      }
      return new Promise(() => {}); // leave the next legitimate long-poll pending
    }
    if (request.url.endsWith("/result")) {
      results.push(JSON.parse(request.init.body));
      return reply(200, { ok: true });
    }
    if (request.url.endsWith("/goodbye")) return reply(200, { ok: true, disconnected: true });
    return reply(404, { ok: false, error: "unexpected mock route" });
  };
  const context = {
    figma, __html__: "<mock-ui>", fetch: fakeFetch,
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, btoa,
    crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {},
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(context);
  vm.runInContext(plugin, context, { filename: "TotalScript-Figma.js" });
  figma.ui.onmessage({ type: "ready" });
  const waitUntil = async (predicate, label) => {
    for (let i = 0; i < 80; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  await waitUntil(() => store.has("totalscript.figma.client-id.v1"), "plugin client id initialization");
  figma.ui.onmessage({ type: "pair", code: pairingCode });
  await waitUntil(() => results.length === 1, "pairing and first Figma tool result");
  const hello = requests.find((entry) => entry.url.endsWith("/hello"));
  const poll = requests.find((entry) => entry.url.includes("/poll?"));
  const result = results[0];
  check("runtime exchanges a one-time code for a saved session token and sends the session token on polling", !!hello && hello.init.headers["X-TotalScript-Figma-Token"] === pairingCode && store.get("totalscript.figma.session-token.v1") === sessionToken && !!poll && poll.init.headers["X-TotalScript-Figma-Token"] === sessionToken);
  check("runtime executes only the declared frame operation and reports its authenticated result", page.children.length === 1 && page.children[0].name === "Bridge frame" && page.children[0].x === 12 && page.selection[0].id === page.children[0].id && result.ok === true && result.client_id === store.get("totalscript.figma.client-id.v1") && result.result.node.name === "Bridge frame" && result.elapsed_ms >= 0);
  check("runtime never sends a plugin request outside the exact local Figma route family", requests.every((entry) => entry.url.startsWith("http://127.0.0.1:3000/api/figma-plugin/")));

  if (failed) { console.error(`FAIL  test-figma-plugin-bridge: ${failed}/${passed + failed} checks`); process.exitCode = 1; }
  else console.log(`PASS  test-figma-plugin-bridge: ${passed} checks`);
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
