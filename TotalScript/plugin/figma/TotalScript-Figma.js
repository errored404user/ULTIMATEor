// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript ↔ Figma Design live plugin bridge. This is a normal Figma plugin;
// it does not use Dev Mode, the Figma Desktop MCP server, or a Figma API key.
// All network traffic is confined to the token-gated TotalScript loopback routes.
(() => {
  "use strict";

  const VERSION = "1.0.0";
  const API = "http://127.0.0.1:3000/api/figma-plugin";
  const TOKEN_HEADER = "X-TotalScript-Figma-Token";
  const CLIENT_KEY = "totalscript.figma.client-id.v1";
  const SESSION_KEY = "totalscript.figma.session-token.v1";
  const MAX_WAIT_MS = 35_000;
  const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
  const MAX_NODES = 50;
  const ALLOWED_TOOLS = new Set([
    "figma_plugin_document", "figma_plugin_selection", "figma_plugin_find",
    "figma_plugin_page", "figma_plugin_create_frame", "figma_plugin_create_shape",
    "figma_plugin_create_text", "figma_plugin_update_node", "figma_plugin_set_text",
    "figma_plugin_reparent", "figma_plugin_duplicate", "figma_plugin_group",
    "figma_plugin_delete", "figma_plugin_export", "figma_plugin_component",
  ]);

  const state = {
    clientId: "",
    sessionToken: "",
    connection: "unknown",
    stopping: false,
    pollTask: null,
    pollController: null,
    heartbeatTimer: null,
    heartbeatBusy: false,
    activeJob: "",
    backoffMs: 1_000,
  };

  class BridgeError extends Error {
    constructor(status, message) { super(message); this.name = "BridgeError"; this.status = status; }
  }
  class OperationError extends Error {
    constructor(code, message) { super(message); this.name = "OperationError"; this.code = code; }
  }
  const fail = (message) => { throw new OperationError("INVALID_ARGUMENT", message); };
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const bounded = (value, min, max, label) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) fail(`${label} must be between ${min} and ${max}`);
    return n;
  };
  const textArg = (value, label, required, max = 4000) => {
    if (value == null || value === "") {
      if (required) fail(`${label} is required`);
      return "";
    }
    if (typeof value !== "string") fail(`${label} must be a string`);
    const result = value.trim();
    if (required && !result) fail(`${label} must not be empty`);
    if (result.length > max) fail(`${label} exceeds ${max} characters`);
    return result;
  };
  const listArg = (value, label, max = MAX_NODES, minimum = 1) => {
    if (!Array.isArray(value) || value.length < minimum || value.length > max) fail(`${label} must contain ${minimum}–${max} items`);
    return value.map((entry, i) => textArg(entry, `${label}[${i}]`, true, 120));
  };

  figma.showUI(__html__, { width: 370, height: 520, themeColors: true });

  function uiMessage(type, data) {
    try { figma.ui.postMessage(Object.assign({ type }, data || {})); } catch (_) {}
  }
  function showState(connection, message, extra) {
    state.connection = connection;
    uiMessage("state", Object.assign({
      state: connection,
      message: message || "",
      tools: connection === "connected" ? ALLOWED_TOOLS.size + 1 : 1,
    }, extra || {}));
  }
  function showMessage(text, kind, connected) {
    uiMessage("message", { text: String(text || ""), kind: kind || "", connected: !!connected });
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function validToken(token) { return typeof token === "string" && /^[a-f0-9]{64}$/i.test(token); }
  function makeClientId() {
    const bytes = new Uint8Array(16);
    try { crypto.getRandomValues(bytes); }
    catch (_) { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
    return "figma-" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function storageRead(key) {
    try { return await figma.clientStorage.getAsync(key); }
    catch (_) { return undefined; }
  }
  async function storageWrite(key, value) {
    try { await figma.clientStorage.setAsync(key, value); }
    catch (_) { throw new Error("Figma could not save the local pairing session. Check Figma plugin storage and try again."); }
  }
  async function storageDelete(key) {
    try { await figma.clientStorage.deleteAsync(key); } catch (_) {}
  }

  async function request(path, token, options, timeoutMs) {
    const init = Object.assign({ method: "GET", cache: "no-store" }, options || {});
    init.headers = Object.assign({ [TOKEN_HEADER]: token }, init.headers || {});
    const externalSignal = init.signal;
    const controller = new AbortController();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    init.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs || MAX_WAIT_MS);
    try {
      const response = await fetch(API + path, init);
      let body;
      try { body = await response.json(); } catch (_) { body = {}; }
      if (!response.ok || !body || body.ok === false) {
        throw new BridgeError(response.status, String((body && body.error) || `TotalScript replied HTTP ${response.status}`));
      }
      return body;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error && error.name === "AbortError") throw new Error("The TotalScript bridge request timed out");
      throw new Error(String(error && error.message || error || "Could not reach TotalScript at 127.0.0.1:3000"));
    } finally {
      clearTimeout(timer);
    }
  }

  async function announce(token) {
    const reply = await request("/hello", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: state.clientId, version: VERSION }),
    }, 10_000);
    if (!validToken(reply.session_token)) throw new Error("TotalScript returned an invalid Figma session token");
    state.sessionToken = reply.session_token;
    await storageWrite(SESSION_KEY, state.sessionToken);
    return reply;
  }

  function startHeartbeats() {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(() => { void heartbeat(); }, 15_000);
  }
  async function heartbeat() {
    if (state.stopping || !state.sessionToken || state.heartbeatBusy) return;
    state.heartbeatBusy = true;
    try {
      const reply = await announce(state.sessionToken);
      showState("connected", "Verified live · TotalScript is listening for requested Figma operations.", { tools: reply.tools || ALLOWED_TOOLS.size + 1 });
    } catch (error) {
      if (error instanceof BridgeError && error.status === 401) {
        await forgetSession();
        showState("disconnected", "This pairing was revoked or TotalScript restarted. Generate a fresh code in TotalScript Settings.");
      } else {
        showState("unknown", "The Figma session is saved; the local bridge did not answer. Reconnecting automatically…");
      }
    } finally {
      state.heartbeatBusy = false;
    }
  }

  function startPolling() {
    if (state.pollTask || state.stopping || !state.sessionToken) return;
    state.pollTask = pollLoop().catch((error) => {
      showState("unknown", String(error && error.message || error));
    }).finally(() => {
      state.pollTask = null;
      state.pollController = null;
      if (!state.stopping && state.sessionToken) setTimeout(startPolling, 500);
    });
  }
  async function pollLoop() {
    while (!state.stopping && state.sessionToken) {
      const controller = new AbortController();
      state.pollController = controller;
      try {
        const query = `?client_id=${encodeURIComponent(state.clientId)}`;
        const reply = await request("/poll" + query, state.sessionToken, { signal: controller.signal }, 28_000);
        state.backoffMs = 1_000;
        if (reply.job) {
          if (!reply.job || typeof reply.job !== "object" || typeof reply.job.id !== "string") {
            showMessage("TotalScript sent a malformed job; it was rejected.", "error", true);
            continue;
          }
          // executeJob has its own allowlist and reports an unsupported name as
          // a failed result instead of leaving the MCP caller waiting.
          await runJob(reply.job);
        }
      } catch (error) {
        if (state.stopping) break;
        if (error instanceof BridgeError && error.status === 401) {
          await forgetSession();
          showState("disconnected", "This pairing is no longer valid. Generate a fresh code in TotalScript Settings.");
          break;
        }
        if (error instanceof BridgeError && error.status === 409) {
          try {
            const reply = await announce(state.sessionToken);
            showState("connected", "Figma session refreshed.", { tools: reply.tools || ALLOWED_TOOLS.size + 1 });
          } catch (refreshError) {
            if (refreshError instanceof BridgeError && refreshError.status === 401) {
              await forgetSession();
              showState("disconnected", "This pairing is no longer valid. Generate a fresh code in TotalScript Settings.");
              break;
            }
            showState("unknown", "Reconnecting to the TotalScript bridge…");
            await sleep(state.backoffMs);
            state.backoffMs = Math.min(10_000, state.backoffMs * 2);
          }
          continue;
        }
        if (!(error && error.name === "AbortError" && state.stopping)) {
          showState("unknown", "The local bridge did not answer; Figma will retry automatically.");
          await sleep(state.backoffMs);
          state.backoffMs = Math.min(10_000, state.backoffMs * 2);
        }
      } finally {
        if (state.pollController === controller) state.pollController = null;
      }
    }
  }

  async function runJob(job) {
    const started = Date.now();
    state.activeJob = job.id;
    showMessage(`Running ${job.name.replace(/^figma_plugin_/, "").replaceAll("_", " ")}…`, "", true);
    let payload;
    try {
      const output = await executeJob(job.name, job.args || {});
      payload = { id: job.id, client_id: state.clientId, ok: true, result: output, elapsed_ms: Date.now() - started };
    } catch (error) {
      const code = error && error.code ? String(error.code) : "FIGMA_PLUGIN_OPERATION_FAILED";
      const detail = String(error && error.message || error || "Figma operation failed").slice(0, 1600);
      payload = {
        id: job.id,
        client_id: state.clientId,
        ok: false,
        result: null,
        error: `ERROR ${code}: ${detail}`,
        code,
        elapsed_ms: Date.now() - started,
      };
    }
    try {
      // A lost HTTP response may mean TotalScript already accepted this result.
      // Retrying the same result is safe; the canvas operation itself is never replayed.
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !state.stopping; attempt++) {
        try {
          await request("/result", state.sessionToken, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }, 15_000);
          lastError = null;
          break;
        } catch (error) {
          if (error instanceof BridgeError && error.status === 409) { lastError = error; break; }
          if (error instanceof BridgeError && error.status === 401) {
            await forgetSession();
            showState("disconnected", "This pairing was revoked while Figma was working. Generate a fresh code in TotalScript Settings.");
            lastError = error;
            break;
          }
          lastError = error;
          if (attempt < 2) await sleep(500 * (attempt + 1));
        }
      }
      if (lastError && state.sessionToken) {
        showMessage("The canvas operation finished, but TotalScript did not confirm its result. Inspect the Figma canvas before retrying.", "error", true);
      } else if (payload.ok) {
        showMessage("Operation completed in Figma.", "ok", true);
      } else {
        showMessage(String(payload.error || "Figma operation failed"), "error", true);
      }
    } finally {
      state.activeJob = "";
    }
  }

  async function forgetSession() {
    state.stopping = true;
    if (state.pollController) { try { state.pollController.abort(); } catch (_) {} }
    if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
    state.sessionToken = "";
    await storageDelete(SESSION_KEY);
  }

  async function pair(code) {
    const pairingToken = textArg(code, "Pairing code", true, 128);
    if (!validToken(pairingToken)) fail("Paste the complete 64-character one-time code from TotalScript Settings.");
    if (!state.clientId) fail("Figma is still initializing; wait a moment and try again.");
    state.stopping = true;
    if (state.pollController) { try { state.pollController.abort(); } catch (_) {} }
    state.stopping = false;
    try {
      const reply = await announce(pairingToken);
      state.stopping = false;
      showState("connected", "Paired securely with the local TotalScript session.", { tools: reply.tools || ALLOWED_TOOLS.size + 1 });
      uiMessage("clear-code");
      showMessage("Paired. You can close this panel; keep Figma open while TotalScript works.", "ok", true);
      startHeartbeats();
      startPolling();
    } catch (error) {
      state.sessionToken = "";
      await storageDelete(SESSION_KEY);
      state.stopping = false;
      const text = error instanceof BridgeError && error.status === 401
        ? "Pairing code is invalid, expired, or already used. Generate a new code in TotalScript Settings."
        : String(error && error.message || error || "Could not pair with TotalScript");
      showState("disconnected", text);
      showMessage(text, "error", false);
    }
  }

  async function disconnect() {
    const token = state.sessionToken;
    state.stopping = true;
    if (state.pollController) { try { state.pollController.abort(); } catch (_) {} }
    if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
    let confirmed = false;
    if (token && state.clientId) {
      try {
        const reply = await request("/goodbye", token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: state.clientId }),
        }, 5000);
        confirmed = reply.disconnected === true;
      } catch (_) {}
    }
    state.sessionToken = "";
    await storageDelete(SESSION_KEY);
    showState("disconnected", confirmed ? "Disconnected from TotalScript. Pair again when you want to reconnect." : "Local session cleared. If TotalScript is offline, its status will become unknown until the heartbeat expires.");
    showMessage(state.activeJob ? "Disconnected; an operation already running in Figma may still finish. Inspect the canvas before retrying." : "Disconnected from TotalScript.", "", false);
  }

  async function bootstrap() {
    showState("unknown", "Checking the Figma plugin's saved local session…");
    let clientId = await storageRead(CLIENT_KEY);
    if (typeof clientId !== "string" || !/^figma-[a-f0-9]{32}$/.test(clientId)) {
      clientId = makeClientId();
      await storageWrite(CLIENT_KEY, clientId);
    }
    state.clientId = clientId;
    const saved = await storageRead(SESSION_KEY);
    if (!validToken(saved)) {
      showState("disconnected", "Not paired yet. Generate a one-time code in TotalScript Settings → Connections → Figma Design plugin.");
      return;
    }
    try {
      const reply = await announce(saved);
      state.stopping = false;
      showState("connected", "Reconnected to the saved TotalScript session.", { tools: reply.tools || ALLOWED_TOOLS.size + 1 });
      showMessage("Connected. Figma operations will be requested through the local bridge.", "ok", true);
      startHeartbeats();
      startPolling();
    } catch (error) {
      await storageDelete(SESSION_KEY);
      state.sessionToken = "";
      state.stopping = false;
      if (error instanceof BridgeError && error.status === 401) {
        showState("disconnected", "The saved pairing expired or TotalScript restarted. Generate a fresh code in TotalScript Settings.");
      } else {
        showState("unknown", "Could not reach TotalScript on 127.0.0.1:3000. Start the desktop app, then press Check connection or reopen this plugin.");
      }
    }
  }

  function assertObject(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) fail("Arguments must be a JSON object");
    return args;
  }
  function findNode(nodeId) {
    const id = textArg(nodeId, "node_id", true, 120);
    return figma.currentPage.findAll((node) => node.id === id)[0] || null;
  }
  function requireNode(nodeId) {
    const node = findNode(nodeId);
    if (!node) fail(`Node '${nodeId}' was not found on the current page. Inspect selection or run figma_plugin_find first.`);
    return node;
  }
  function canContain(node) { return !!node && typeof node.appendChild === "function"; }
  function resolveParent(parentId) {
    if (parentId == null || parentId === "") return figma.currentPage;
    const parent = requireNode(parentId);
    if (!canContain(parent)) fail(`Parent '${parentId}' cannot contain layers`);
    return parent;
  }
  function color(value, label) {
    const hex = textArg(value, label, true, 9);
    if (!/^#[0-9a-f]{6}$/i.test(hex)) fail(`${label} must be a #RRGGBB color`);
    return {
      type: "SOLID",
      color: {
        r: parseInt(hex.slice(1, 3), 16) / 255,
        g: parseInt(hex.slice(3, 5), 16) / 255,
        b: parseInt(hex.slice(5, 7), 16) / 255,
      },
      opacity: 1,
    };
  }
  function dimensions(args, fallbackWidth, fallbackHeight) {
    const width = bounded(args.width == null ? fallbackWidth : args.width, 1, 10_000, "width");
    const height = bounded(args.height == null ? fallbackHeight : args.height, 1, 10_000, "height");
    return { width, height };
  }
  function position(node, args) {
    if (args.x != null) node.x = bounded(args.x, -1_000_000, 1_000_000, "x");
    if (args.y != null) node.y = bounded(args.y, -1_000_000, 1_000_000, "y");
  }
  function paintSummary(paints) {
    if (!Array.isArray(paints)) return undefined;
    const first = paints.find((paint) => paint && paint.type === "SOLID" && paint.visible !== false);
    if (!first || !first.color) return undefined;
    const channel = (number) => Math.max(0, Math.min(255, Math.round(Number(number || 0) * 255))).toString(16).padStart(2, "0");
    return `#${channel(first.color.r)}${channel(first.color.g)}${channel(first.color.b)}`.toUpperCase();
  }
  function describeNode(node) {
    const result = { id: node.id, name: node.name, type: node.type };
    for (const key of ["x", "y", "width", "height", "rotation", "opacity", "visible", "locked"]) {
      try { if (typeof node[key] === "number" || typeof node[key] === "boolean") result[key] = node[key]; } catch (_) {}
    }
    try { if (Array.isArray(node.fills)) result.fill = paintSummary(node.fills); } catch (_) {}
    try { if (Array.isArray(node.strokes)) result.stroke = paintSummary(node.strokes); } catch (_) {}
    try { if (Array.isArray(node.children)) result.child_count = node.children.length; } catch (_) {}
    if (node.type === "TEXT") {
      try { result.characters = String(node.characters || "").slice(0, 160); } catch (_) {}
      try { if (typeof node.fontSize === "number") result.font_size = node.fontSize; } catch (_) {}
    }
    return result;
  }
  function textResult(text, extra) { return Object.assign({ text }, extra || {}); }
  function outputJSON(label, value) { return `${label}\n${JSON.stringify(value, null, 2)}`; }

  function matrixInverse(matrix) {
    const [[a, c, e], [b, d, f]] = matrix;
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) fail("Cannot preserve position under a singular parent transform");
    const inv = 1 / determinant;
    return [[d * inv, -c * inv, (c * f - d * e) * inv], [-b * inv, a * inv, (b * e - a * f) * inv]];
  }
  function matrixMultiply(left, right) {
    const [[a, c, e], [b, d, f]] = left;
    const [[g, i, k], [h, j, l]] = right;
    return [[a * g + c * h, a * i + c * j, a * k + c * l + e], [b * g + d * h, b * i + d * j, b * k + d * l + f]];
  }
  function absoluteMatrix(node) {
    try { return node.type === "PAGE" ? [[1, 0, 0], [0, 1, 0]] : node.absoluteTransform.map((row) => row.slice()); }
    catch (_) { return [[1, 0, finite(node.x, 0)], [0, 1, finite(node.y, 0)]]; }
  }

  async function executeJob(name, rawArgs) {
    if (!ALLOWED_TOOLS.has(name)) fail(`Unsupported operation '${name}'`);
    const args = assertObject(rawArgs);
    switch (name) {
      case "figma_plugin_document": {
        const pages = figma.root.children.map((page) => ({ id: page.id, name: page.name }));
        return textResult(outputJSON("Open Figma Design document", {
          document_name: figma.root.name,
          current_page: { id: figma.currentPage.id, name: figma.currentPage.name },
          pages: args.include_pages === false ? undefined : pages,
          page_count: pages.length,
          top_level_layer_count: figma.currentPage.children.length,
          selection_count: figma.currentPage.selection.length,
        }));
      }
      case "figma_plugin_selection": {
        const limit = Math.trunc(bounded(args.limit == null ? 25 : args.limit, 1, MAX_NODES, "limit"));
        const nodes = figma.currentPage.selection.slice(0, limit).map(describeNode);
        return textResult(outputJSON(`Current selection (${figma.currentPage.selection.length} node(s); returning ${nodes.length})`, nodes));
      }
      case "figma_plugin_find": {
        const query = textArg(args.query, "query", true, 160).toLocaleLowerCase();
        const wantedType = textArg(args.type, "type", false, 40).toUpperCase();
        const limit = Math.trunc(bounded(args.limit == null ? 50 : args.limit, 1, 100, "limit"));
        const matches = figma.currentPage.findAll((node) =>
          node.name.toLocaleLowerCase().includes(query) && (!wantedType || node.type === wantedType));
        const rows = matches.slice(0, limit).map(describeNode);
        return textResult(outputJSON(`Found ${matches.length} matching layer(s) on '${figma.currentPage.name}' (returning ${rows.length})`, rows));
      }
      case "figma_plugin_page": {
        const action = textArg(args.action, "action", true, 16).toLowerCase();
        if (!["list", "create", "rename", "activate"].includes(action)) fail("action must be list, create, rename, or activate");
        if (action === "list") return textResult(outputJSON("Figma pages", figma.root.children.map((page) => ({ id: page.id, name: page.name, active: page.id === figma.currentPage.id }))));
        if (action === "create") {
          const pageName = textArg(args.name, "name", true, 120);
          const page = figma.createPage(); page.name = pageName;
          await figma.setCurrentPageAsync(page);
          return textResult(`Created and activated page '${page.name}' (${page.id}).`, { page: { id: page.id, name: page.name } });
        }
        const target = args.page_id ? figma.root.children.find((page) => page.id === String(args.page_id)) : null;
        const page = target || (args.name ? figma.root.children.find((entry) => entry.name === String(args.name)) : null);
        if (!page) fail("page_id or an exact page name matching an existing page is required");
        if (action === "rename") {
          page.name = textArg(args.name, "name", true, 120);
          return textResult(`Renamed page ${page.id} to '${page.name}'.`, { page: { id: page.id, name: page.name } });
        }
        await figma.setCurrentPageAsync(page);
        return textResult(`Activated page '${page.name}' (${page.id}).`, { page: { id: page.id, name: page.name } });
      }
      case "figma_plugin_create_frame": {
        const size = dimensions(args, 640, 360);
        const parent = resolveParent(args.parent_id);
        const frame = figma.createFrame();
        frame.name = textArg(args.name, "name", false, 120) || "Frame";
        frame.resize(size.width, size.height);
        if (args.fill != null) frame.fills = [color(args.fill, "fill")];
        if (typeof args.clip_content === "boolean") frame.clipsContent = args.clip_content;
        parent.appendChild(frame);
        position(frame, args);
        figma.currentPage.selection = [frame];
        return textResult(`Created frame '${frame.name}' (${frame.id}) at ${Math.round(frame.x)}, ${Math.round(frame.y)} · ${Math.round(frame.width)} × ${Math.round(frame.height)} px.`, { node: describeNode(frame) });
      }
      case "figma_plugin_create_shape": {
        const shape = textArg(args.shape, "shape", true, 24).toLowerCase();
        const constructors = {
          rectangle: () => figma.createRectangle(),
          ellipse: () => figma.createEllipse(),
          line: () => figma.createLine(),
          polygon: () => figma.createPolygon(),
          star: () => figma.createStar(),
        };
        if (!constructors[shape]) fail("shape must be rectangle, ellipse, line, polygon, or star");
        const size = dimensions(args, 160, 120);
        const node = constructors[shape]();
        node.name = textArg(args.name, "name", false, 120) || shape[0].toUpperCase() + shape.slice(1);
        node.resize(size.width, size.height);
        if (args.rotation != null) node.rotation = bounded(args.rotation, -3600, 3600, "rotation");
        if (args.fill != null && shape !== "line") node.fills = [color(args.fill, "fill")];
        if (args.stroke != null) node.strokes = [color(args.stroke, "stroke")];
        if (args.stroke_width != null) node.strokeWeight = bounded(args.stroke_width, 0, 100, "stroke_width");
        if (shape === "polygon" && args.point_count != null) node.pointCount = Math.trunc(bounded(args.point_count, 3, 12, "point_count"));
        if (shape === "star" && args.point_count != null) node.pointCount = Math.trunc(bounded(args.point_count, 3, 12, "point_count"));
        const parent = resolveParent(args.parent_id);
        parent.appendChild(node);
        position(node, args);
        figma.currentPage.selection = [node];
        return textResult(`Created ${shape} '${node.name}' (${node.id}).`, { node: describeNode(node) });
      }
      case "figma_plugin_create_text": {
        const characters = textArg(args.text, "text", true, 20_000);
        const fontFamily = textArg(args.font_family, "font_family", false, 100) || "Inter";
        const fontStyle = textArg(args.font_style, "font_style", false, 80) || "Regular";
        const fontSize = bounded(args.font_size == null ? 16 : args.font_size, 1, 1000, "font_size");
        const node = figma.createText();
        await figma.loadFontAsync({ family: fontFamily, style: fontStyle });
        node.fontName = { family: fontFamily, style: fontStyle };
        node.characters = characters;
        node.fontSize = fontSize;
        node.name = textArg(args.name, "name", false, 120) || characters.split("\n")[0].slice(0, 100) || "Text";
        if (args.color != null) node.fills = [color(args.color, "color")];
        if (args.auto_resize != null) {
          const value = textArg(args.auto_resize, "auto_resize", true, 24).toUpperCase();
          if (!["HEIGHT", "WIDTH_AND_HEIGHT", "NONE"].includes(value)) fail("auto_resize must be HEIGHT, WIDTH_AND_HEIGHT, or NONE");
          node.textAutoResize = value;
        }
        if (args.text_align != null) {
          const value = textArg(args.text_align, "text_align", true, 24).toUpperCase();
          if (!["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(value)) fail("text_align must be LEFT, CENTER, RIGHT, or JUSTIFIED");
          node.textAlignHorizontal = value;
        }
        resolveParent(args.parent_id).appendChild(node);
        position(node, args);
        figma.currentPage.selection = [node];
        return textResult(`Created text '${node.name}' (${node.id}) using ${fontFamily} ${fontStyle} at ${fontSize}px.`, { node: describeNode(node) });
      }
      case "figma_plugin_update_node": {
        const node = requireNode(args.node_id);
        let changed = [];
        if (args.name != null) { node.name = textArg(args.name, "name", true, 120); changed.push("name"); }
        if (args.x != null) { node.x = bounded(args.x, -1_000_000, 1_000_000, "x"); changed.push("x"); }
        if (args.y != null) { node.y = bounded(args.y, -1_000_000, 1_000_000, "y"); changed.push("y"); }
        if (args.width != null || args.height != null) {
          if (typeof node.resize !== "function") fail(`Node '${node.name}' cannot be resized`);
          const width = bounded(args.width == null ? node.width : args.width, 1, 10_000, "width");
          const height = bounded(args.height == null ? node.height : args.height, 1, 10_000, "height");
          node.resize(width, height); changed.push("size");
        }
        if (args.rotation != null) { node.rotation = bounded(args.rotation, -3600, 3600, "rotation"); changed.push("rotation"); }
        if (args.opacity != null) { node.opacity = bounded(args.opacity, 0, 1, "opacity"); changed.push("opacity"); }
        if (typeof args.visible === "boolean") { node.visible = args.visible; changed.push("visible"); }
        if (typeof args.locked === "boolean") { node.locked = args.locked; changed.push("locked"); }
        if (args.fill != null) {
          if (!("fills" in node)) fail(`Node '${node.name}' does not support fills`);
          node.fills = [color(args.fill, "fill")]; changed.push("fill");
        }
        if (args.stroke != null) {
          if (!("strokes" in node)) fail(`Node '${node.name}' does not support strokes`);
          node.strokes = [color(args.stroke, "stroke")]; changed.push("stroke");
        }
        if (args.stroke_width != null) { node.strokeWeight = bounded(args.stroke_width, 0, 100, "stroke_width"); changed.push("stroke_width"); }
        if (args.corner_radius != null) { node.cornerRadius = bounded(args.corner_radius, 0, 500, "corner_radius"); changed.push("corner_radius"); }
        if (!changed.length) fail("At least one supported field besides node_id must be supplied");
        return textResult(`Updated '${node.name}' (${node.id}): ${changed.join(", ")}.`, { node: describeNode(node), changed });
      }
      case "figma_plugin_set_text": {
        const node = requireNode(args.node_id);
        if (node.type !== "TEXT") fail(`Node '${node.name}' is ${node.type}, not TEXT`);
        const family = textArg(args.font_family, "font_family", false, 100);
        const style = textArg(args.font_style, "font_style", false, 80);
        let font = node.fontName;
        if (family || style || font === figma.mixed) {
          await figma.loadFontAsync({ family: family || (font !== figma.mixed && font.family) || "Inter", style: style || (font !== figma.mixed && font.style) || "Regular" });
          font = { family: family || (font !== figma.mixed && font.family) || "Inter", style: style || (font !== figma.mixed && font.style) || "Regular" };
        }
        node.fontName = font;
        node.characters = textArg(args.text, "text", true, 20_000);
        if (args.font_size != null) node.fontSize = bounded(args.font_size, 1, 1000, "font_size");
        if (args.color != null) node.fills = [color(args.color, "color")];
        return textResult(`Updated text in '${node.name}' (${node.id}).`, { node: describeNode(node) });
      }
      case "figma_plugin_reparent": {
        const node = requireNode(args.node_id);
        const parent = resolveParent(args.parent_id);
        let ancestor = parent;
        while (ancestor && ancestor.type !== "PAGE") {
          if (ancestor.id === node.id) fail("A node cannot be moved into itself or one of its descendants");
          ancestor = ancestor.parent;
        }
        const world = absoluteMatrix(node);
        parent.appendChild(node);
        if (args.x == null && args.y == null) {
          const parentWorld = absoluteMatrix(parent);
          node.relativeTransform = matrixMultiply(matrixInverse(parentWorld), world);
        }
        position(node, args);
        return textResult(`Moved '${node.name}' (${node.id}) under '${parent.name || "current page"}'${args.x == null && args.y == null ? " while preserving its canvas position" : ""}.`, { node: describeNode(node), parent_id: parent.id });
      }
      case "figma_plugin_duplicate": {
        const ids = listArg(args.node_ids, "node_ids", MAX_NODES, 1);
        const dx = bounded(args.dx == null ? 24 : args.dx, -10_000, 10_000, "dx");
        const dy = bounded(args.dy == null ? 24 : args.dy, -10_000, 10_000, "dy");
        const source = ids.map(requireNode);
        const copies = source.map((node) => {
          const copy = node.clone();
          copy.x = finite(copy.x, 0) + dx;
          copy.y = finite(copy.y, 0) + dy;
          return copy;
        });
        figma.currentPage.selection = copies;
        return textResult(`Duplicated ${copies.length} node(s) with offset ${dx}, ${dy}.`, { nodes: copies.map(describeNode) });
      }
      case "figma_plugin_group": {
        const ids = listArg(args.node_ids, "node_ids", MAX_NODES, 2);
        if (ids.length < 2) fail("At least two nodes are required to create a group");
        const nodes = ids.map(requireNode);
        const parent = nodes[0].parent;
        if (!nodes.every((node) => node.parent && node.parent.id === parent.id)) fail("All grouped nodes must have the same parent");
        const group = figma.group(nodes, parent);
        group.name = textArg(args.name, "name", false, 120) || "Group";
        figma.currentPage.selection = [group];
        return textResult(`Grouped ${nodes.length} nodes as '${group.name}' (${group.id}).`, { node: describeNode(group) });
      }
      case "figma_plugin_delete": {
        const ids = listArg(args.node_ids, "node_ids", MAX_NODES, 1);
        const nodes = ids.map(requireNode);
        for (const node of nodes) node.remove();
        figma.currentPage.selection = [];
        return textResult(`Deleted ${nodes.length} node(s) from the current page.`, { deleted_ids: ids });
      }
      case "figma_plugin_export": {
        const ids = args.node_ids == null ? figma.currentPage.selection.map((node) => node.id) : listArg(args.node_ids, "node_ids", 3, 1);
        if (!ids.length || ids.length > 3) fail("Select 1–3 nodes or provide 1–3 node_ids to export");
        const nodes = ids.map(requireNode);
        const format = textArg(args.format, "format", false, 8).toUpperCase() || "PNG";
        if (!["PNG", "JPG", "SVG"].includes(format)) fail("format must be PNG, JPG, or SVG");
        const scale = bounded(args.scale == null ? 1 : args.scale, 1, 4, "scale");
        const images = [];
        let totalBytes = 0;
        for (const node of nodes) {
          const bytes = await node.exportAsync(format === "SVG" ? { format: "SVG" } : { format, constraint: { type: "SCALE", value: scale } });
          totalBytes += bytes.length;
          if (totalBytes > MAX_EXPORT_BYTES) fail("Combined export exceeds the 4 MiB attachment safety limit; export fewer or smaller layers");
          images.push({ mimeType: format === "SVG" ? "image/svg+xml" : format === "JPG" ? "image/jpeg" : "image/png", data: bytesToBase64(bytes), name: node.name });
        }
        return textResult(`Exported ${images.length} node(s) as ${format}${format === "SVG" ? "" : ` at ${scale}×`}.`, { images });
      }
      case "figma_plugin_component": {
        const action = textArg(args.action, "action", true, 12).toLowerCase();
        if (action === "list") {
          const limit = Math.trunc(bounded(args.limit == null ? 50 : args.limit, 1, 100, "limit"));
          const components = figma.currentPage.findAll((node) => node.type === "COMPONENT" || node.type === "COMPONENT_SET");
          return textResult(outputJSON(`Found ${components.length} component(s) and component set(s) on the current page (returning ${Math.min(limit, components.length)})`, components.slice(0, limit).map(describeNode)));
        }
        if (action !== "create") fail("action must be list or create");
        const source = requireNode(args.node_id);
        const component = figma.createComponentFromNode(source);
        return textResult(`Created component '${component.name}' (${component.id}) from '${source.name}'.`, { node: describeNode(component) });
      }
      default: fail(`Unsupported Figma operation '${name}'`);
    }
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
    }
    return btoa(binary);
  }

  async function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      if (state.connection === "unknown") void bootstrap();
      return;
    }
    if (message.type === "pair") return pair(message.code);
    if (message.type === "disconnect") return disconnect();
    if (message.type === "check") return heartbeat();
    if (message.type === "help") {
      showMessage("In TotalScript open Settings → Connections → Figma Design plugin → Generate pairing code. Paste it here, then click Pair Figma. No Dev Mode is needed.", "", state.connection === "connected");
    }
  }

  // The plugin exits when its UI is closed or Figma unloads it. Send a best-effort
  // goodbye so TotalScript can mark an intentional disconnect immediately.
  try {
    figma.on("close", () => {
      const token = state.sessionToken;
      if (!token || !state.clientId) return;
      try {
        void fetch(API + "/goodbye", {
          method: "POST", keepalive: true,
          headers: { "Content-Type": "application/json", [TOKEN_HEADER]: token },
          body: JSON.stringify({ client_id: state.clientId }),
        }).catch(() => {});
      } catch (_) {}
    });
  } catch (_) {}

  // Funnel UI messages through one guarded handler; the HTML panel can request
  // pairing actions but cannot execute arbitrary code in the Figma plugin.
  figma.ui.onmessage = (message) => { void handleMessage(message).catch((error) => showMessage(String(error && error.message || error), "error", state.connection === "connected")); };
})();
