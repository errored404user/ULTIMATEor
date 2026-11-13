// First-class Figma Desktop MCP integration. MOCKED: the local Figma Desktop
// endpoint and total-core WebSocket are replaced with deterministic test doubles;
// no Figma account, file, authentication, Studio or network access is used.
//   node tests/test-figma-mcp.js
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const MCP = require(path.join(ROOT, "src/core/figma_mcp.js"));
let passed = 0, failed = 0;
function check(name, condition, extra) {
  if (condition) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (extra === undefined ? "" : " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 500))); }
}
function headers(values) {
  const lower = Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (key) => lower[String(key).toLowerCase()] || "" };
}
function fakeResponse(status, body, contentType, extraHeaders, asSse) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const allHeaders = Object.assign({ "content-type": contentType || "application/json" }, extraHeaders || {});
  const result = { ok: status >= 200 && status < 300, status, headers: headers(allHeaders), text: async () => text };
  if (asSse) result.body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
  return result;
}
function rpcReply(id, result, extraHeaders) {
  return fakeResponse(200, { jsonrpc: "2.0", id, result }, "application/json", extraHeaders);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

(async () => {
  // ── Client transport ───────────────────────────────────────────────────
  const wire = [];
  const png = Buffer.from("test image bytes").toString("base64");
  const listedTools = [
    { name: "get_file", description: "Read the active Figma file.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
    { name: "render_file", description: "Render Figma frames as images.", inputSchema: { properties: { node_id: { type: "string" } }, required: ["node_id", "missing"] } },
    { name: "get_file", description: "duplicate should be suppressed", inputSchema: { type: "object" } },
    { name: "bad/name", description: "invalid tool name" },
    { name: "", description: "empty name" },
  ];
  const fakeFetch = async (url, init) => {
    wire.push({ url: String(url), init, frame: JSON.parse(init.body) });
    const frame = JSON.parse(init.body);
    assert.strictEqual(String(url), MCP.ENDPOINT, "client must use the fixed loopback endpoint");
    if (frame.method === "initialize") return rpcReply(frame.id, { protocolVersion: MCP.PROTOCOL_VERSION, serverInfo: { name: "Figma Desktop", version: "test" }, capabilities: { tools: {} } }, { "Mcp-Session-Id": "figma-test-session" });
    if (frame.method === "notifications/initialized") return fakeResponse(202, "", "text/plain");
    if (frame.method === "tools/list") {
      const event = `event: message\nid: ${frame.id}\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { tools: listedTools } })}\n\n`;
      return fakeResponse(200, event, "text/event-stream", { "Mcp-Session-Id": "figma-test-session" }, true);
    }
    if (frame.method === "tools/call") {
      if (frame.params.name === "render_file") return rpcReply(frame.id, { content: [{ type: "text", text: "Rendered selected frames." }, { type: "image", mimeType: "image/png", data: png }] });
      return rpcReply(frame.id, { content: [{ type: "text", text: `Read Figma key ${frame.params.arguments.key}.` }], structuredContent: { ok: true } });
    }
    throw new Error("Unexpected MCP method " + frame.method);
  };
  const client = new MCP.Client({ fetch: fakeFetch, endpoint: "http://example.invalid/" });
  const tools = await client.connect(6500);
  check("client initializes Streamable HTTP with the negotiated MCP version and sends the initialized notification", wire[0].frame.method === "initialize" && wire[0].frame.params.protocolVersion === "2025-06-18" && wire[0].init.headers["MCP-Protocol-Version"] === "2025-06-18" && wire.some((x) => x.frame.method === "notifications/initialized"));
  check("SSE tools/list becomes a deduplicated, bounded figma_* catalogue with sanitized schemas", tools.length === 2 && tools[0].name === "figma_get_file" && tools[0].server === "figma" && tools[0].inputSchema.required.length === 1 && tools[1].name === "figma_render_file" && tools[1].inputSchema.properties && !tools.some((t) => /bad\/name/.test(t.name)));
  const toolCall = await client.callTool("get_file", { key: "file-key" }, 3000, "test-request-1");
  const sentCall = wire.find((x) => x.frame.method === "tools/call");
  check("tool calls preserve JSON arguments, session id and protocol-version header and normalize text output", toolCall.ok && /file-key/.test(toolCall.text) && sentCall.frame.params.name === "get_file" && sentCall.frame.params.arguments.key === "file-key" && sentCall.init.headers["Mcp-Session-Id"] === "figma-test-session" && sentCall.init.headers["MCP-Protocol-Version"] === "2025-06-18");
  const imageResult = await client.callTool("render_file", { node_id: "2:3" }, 3000, "test-image-1");
  check("MCP image content is returned in the extension's bounded image attachment shape", imageResult.ok && imageResult.images.length === 1 && imageResult.images[0].mimeType === "image/png" && imageResult.images[0].data === png && /Rendered selected frames/.test(imageResult.text));
  let validationError = null;
  try { await client.callTool("get_file", { oversized: "x".repeat(1024 * 1024) }, 3000, "too-large"); } catch (error) { validationError = error; }
  check("oversized Figma arguments fail locally before any MCP request is sent", validationError && validationError.code === "FIGMA_ARGS_TOO_LARGE" && wire.filter((x) => x.frame.method === "tools/call").length === 2);
  client.disconnect();
  check("disconnect clears the initialized session and advertised tools", !client.initialized && client.tools.length === 0);

  const authClient = new MCP.Client({ fetch: async () => fakeResponse(401, "login required", "text/plain") });
  let authError = null;
  try { await authClient.connect(6500); } catch (error) { authError = error; }
  check("authentication failures are typed and do not mark the MCP session connected", authError && authError.code === "FIGMA_AUTH_REQUIRED" && !authClient.initialized);

  const cancelWire = [], callStarted = deferred();
  const cancelFetch = async (url, init) => {
    const frame = JSON.parse(init.body); cancelWire.push({ frame, init });
    if (frame.method === "initialize") return rpcReply(frame.id, { protocolVersion: MCP.PROTOCOL_VERSION }, { "Mcp-Session-Id": "cancel-session" });
    if (frame.method === "notifications/initialized" || frame.method === "notifications/cancelled") return fakeResponse(202, "", "text/plain");
    if (frame.method === "tools/list") return rpcReply(frame.id, { tools: [{ name: "slow_write", inputSchema: { type: "object", properties: {} } }] });
    if (frame.method === "tools/call") {
      callStarted.resolve(frame.id);
      return new Promise((resolve, reject) => {
        if (init.signal.aborted) return reject(new DOMException("aborted", "AbortError"));
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    throw new Error("Unexpected cancellation-test method " + frame.method);
  };
  const cancelClient = new MCP.Client({ fetch: cancelFetch });
  await cancelClient.connect(6500);
  const pendingCall = cancelClient.callTool("slow_write", { value: "x" }, 10000, "request-cancel-1");
  const rpcId = await callStarted.promise;
  const cancelled = cancelClient.cancel("request-cancel-1");
  let cancelError = null;
  try { await pendingCall; } catch (error) { cancelError = error; }
  const cancelNotification = cancelWire.find((x) => x.frame.method === "notifications/cancelled");
  check("request cancellation sends MCP notifications/cancelled, aborts the local fetch and returns a typed cancellation", cancelled && cancelError && cancelError.code === "FIGMA_CANCELLED" && cancelError.kind === "cancelled" && cancelNotification && cancelNotification.frame.params.requestId === rpcId && cancelClient.initialized);
  cancelClient.disconnect();

  // ── Real background.js routing with an in-VM fake Figma + total-core ──────
  const state = { stored: {}, hubFrames: [], mcpFrames: [], hangTool: false, callStarted: deferred(), session: "worker-session" };
  const localFigmaFetch = async (url, init) => {
    const address = String(url);
    if (address.includes(":3000/api/status") || address.includes(":3000/api/blockbench/status")) {
      return fakeResponse(404, "not found", "application/json");
    }
    if (address !== MCP.ENDPOINT) return fakeResponse(404, "not found", "application/json");
    const frame = JSON.parse(init.body); state.mcpFrames.push({ frame, init });
    if (frame.method === "initialize") return rpcReply(frame.id, { protocolVersion: MCP.PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "Figma Desktop", version: "fake" } }, { "Mcp-Session-Id": state.session });
    if (frame.method === "notifications/initialized" || frame.method === "notifications/cancelled") return fakeResponse(202, "", "text/plain");
    if (frame.method === "tools/list") return rpcReply(frame.id, { tools: [
      { name: "get_file", description: "Read an active Figma file", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
      { name: "slow_op", description: "Long operation used only by the cancellation test", inputSchema: { type: "object", properties: {} } },
    ] }, { "Mcp-Session-Id": state.session });
    if (frame.method === "tools/call" && state.hangTool) {
      state.callStarted.resolve(frame.id);
      return new Promise((resolve, reject) => {
        if (init.signal.aborted) return reject(new DOMException("aborted", "AbortError"));
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if (frame.method === "tools/call") return rpcReply(frame.id, { content: [{ type: "text", text: `Background handled ${frame.params.name}.` }] }, { "Mcp-Session-Id": state.session });
    throw new Error("Unexpected worker MCP method " + frame.method);
  };
  const localStore = state.stored, sessionStore = {};
  const storageArea = (store) => ({
    get: (keys, callback) => {
      const out = {};
      for (const key of (Array.isArray(keys) ? keys : [keys])) if (key in store) out[key] = store[key];
      if (typeof callback === "function") queueMicrotask(() => callback(out));
      return Promise.resolve(out);
    },
    set: (object) => { Object.assign(store, object); return Promise.resolve(); },
    remove: (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key]; return Promise.resolve(); },
  });
  let messageListener = null;
  const listener = () => ({ addListener: (fn) => { if (!messageListener) messageListener = fn; } });
  const noopEvent = () => ({ addListener() {} });
  const chrome = {
    storage: { local: storageArea(localStore), session: storageArea(sessionStore), onChanged: noopEvent() },
    runtime: {
      onMessage: listener(), onStartup: noopEvent(), onInstalled: noopEvent(), lastError: null,
      sendMessage: () => Promise.resolve(), getURL: (name) => "chrome-extension://figma-test/" + name,
      getPlatformInfo: async () => ({ os: "linux" }), getManifest: () => ({ version: "2.21.0" }),
    },
    tabs: { query: async () => [], sendMessage: async () => {}, create: async () => ({ id: 1 }) },
    alarms: { create() {}, onAlarm: noopEvent() },
  };
  const worker = {
    chrome, console: { log() {}, warn() {}, error() {} }, fetch: localFigmaFetch,
    AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, Headers, Blob, FormData,
    crypto: globalThis.crypto, performance, atob, btoa, setTimeout, clearTimeout,
    setInterval: () => ({ fakeInterval: true }), clearInterval() {},
  };
  worker.self = worker; worker.globalThis = worker;
  worker.importScripts = (name) => vm.runInContext(read(name), worker, { filename: name });
  vm.createContext(worker);
  vm.runInContext(read("background.js"), worker, { filename: "background.js" });
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
    constructor(url) {
      this.url = url; this.readyState = 0;
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1; if (this.onopen) this.onopen();
        this.deliver({ type: "connected", mcp_alive: true, studio: false, servers: [{ id: "roblox", alive: false }] });
      }, 5);
    }
    deliver(value) { setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify(value) }); }, 1); }
    send(data) {
      const frame = JSON.parse(data); state.hubFrames.push(frame);
      if (frame.type === "ping") return this.deliver({ type: "pong", id: frame.id });
      if (frame.type === "list_tools") return this.deliver({ type: "tools", id: frame.id, tools: [{ name: "get_studio_state", description: "Read Studio state", inputSchema: { type: "object" } }], servers: [{ id: "roblox", alive: false }], mcp_alive: true, studio: false });
      if (frame.type === "studio_status") return this.deliver({ type: "studio_status", id: frame.id, studio: false });
      if (frame.type === "call_tool") return this.deliver({ type: "tool_result", id: frame.id, ok: false, error: "unexpected WebSocket tool call", errorCode: "UNEXPECTED" });
      return this.deliver({ type: "tool_result", id: frame.id, ok: true, text: "ok" });
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
  }
  worker.WebSocket = FakeSocket;
  // The worker constructs its socket before the class is assigned, so retry its
  // connect once with the in-context fake constructor installed.
  vm.runInContext("try { ws && ws.close(); } catch {}; ws = null; connected = false; connect();", worker);
  const ask = (message) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, kind: "test-timeout", error: message.type }), 8000);
    if (typeof messageListener !== "function") { clearTimeout(timer); resolve({ ok: false, kind: "no-listener" }); return; }
    messageListener(message, {}, (result) => { clearTimeout(timer); resolve(result); });
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const connected = await ask({ type: "figma_connect" });
  check("background figma_connect verifies initialization and returns the actual tool count", connected && connected.ok && connected.status === "connected" && connected.verified === true && connected.tools === 2 && connected.endpoint === MCP.ENDPOINT, connected);
  const toolsReply = await ask({ type: "list_tools", refresh: true });
  check("background list_tools merges namespaced Figma tools and reports Figma server liveness without requiring total-core", toolsReply && toolsReply.tools.some((t) => t.name === "figma_get_file" && t.server === "figma") && toolsReply.servers.some((s) => s.id === "figma" && s.alive === true && s.status === "connected"));
  const routed = await ask({ type: "call_tool", name: "figma_get_file", arguments: { key: "abc" }, requestId: "worker-req-1" });
  check("background routes figma_* directly through HTTP rather than the total-core WebSocket", routed && routed.ok && /handled get_file/.test(routed.text) && routed.requestId === "worker-req-1" && !state.hubFrames.some((f) => f.type === "call_tool") && state.mcpFrames.some((f) => f.frame.method === "tools/call" && f.frame.params.name === "get_file"));
  const stale = await ask({ type: "call_tool", name: "figma_not_advertised", arguments: {} });
  check("background refuses a non-advertised Figma tool before transport dispatch", stale && stale.ok === false && stale.errorCode === "FIGMA_TOOL_STALE" && state.mcpFrames.filter((f) => f.frame.method === "tools/call").length === 1);
  state.hangTool = true;
  const pendingWorkerCall = ask({ type: "call_tool", name: "figma_slow_op", arguments: {}, timeout: 5000, requestId: "worker-cancel-1" });
  await state.callStarted.promise;
  const cancelReply = await ask({ type: "figma_cancel", requestId: "worker-cancel-1" });
  const cancelledWorkerCall = await pendingWorkerCall;
  state.hangTool = false;
  check("figma_cancel aborts an in-flight worker request and keeps the verified connection state", cancelReply && cancelReply.cancelled && cancelledWorkerCall && cancelledWorkerCall.errorCode === "FIGMA_CANCELLED" && cancelledWorkerCall.kind === "cancelled" && (await ask({ type: "figma_status", refresh: false })).status === "connected");
  const disconnected = await ask({ type: "figma_disconnect" });
  check("dedicated disconnect persists the manual state and stops advertising Figma tools", disconnected && disconnected.manual_disconnected && disconnected.status === "disconnected" && (await ask({ type: "list_tools", refresh: true })).tools.every((t) => t.server !== "figma"));
  const refused = await ask({ type: "call_tool", name: "figma_get_file", arguments: {} });
  check("manual disconnect is respected by tool routing (no silent reconnection)", refused && refused.ok === false && refused.errorCode === "FIGMA_DISCONNECTED" && state.mcpFrames.filter((f) => f.frame.method === "tools/call").length === 2);
  const reconnected = await ask({ type: "add_server", server_id: "figma" });
  check("legacy add_server for Figma maps to its dedicated verified connector, not generic total-core add_server", reconnected && reconnected.status === "connected" && !state.hubFrames.some((f) => f.type === "add_server" && f.server_id === "figma"));
  await ask({ type: "remove_server", server_id: "figma" });
  vm.runInContext("manualStudioDisconnect = true; try { stopHeartbeat(); } catch {}; try { figmaClient.disconnect(); } catch {}; try { ws && ws.close(); } catch {}; ws = null; connected = false; clearTimeout(reconnectTimer);", worker);

  // ── Cross-layer safety / UI wiring pins ─────────────────────────────────
  const bgSource = read("background.js"), clientSource = read("src/core/figma_mcp.js");
  check("the client has a fixed loopback endpoint only; it does not accept an arbitrary server URL or token", clientSource.includes('const ENDPOINT = "http://127.0.0.1:3845/mcp"') && !/opts\.endpoint|opts\.url|Authorization.*token/i.test(clientSource));
  check("worker cancellation is dedicated to Figma and does not change the existing Roblox/Blockbench transport", /case "figma_cancel"/.test(bgSource) && /figmaClient\.cancel\(msg\.requestId\)/.test(bgSource) && /if \(isFigmaToolName\(msg\.name\)\)/.test(bgSource));

  if (failed) { console.error(`FAIL  test-figma-mcp: ${failed}/${passed + failed} checks`); process.exitCode = 1; }
  else console.log(`PASS  test-figma-mcp: ${passed} checks`);
})().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
