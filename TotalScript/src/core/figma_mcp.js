/* Figma Desktop MCP transport for the extension service worker.
 * Only the fixed loopback endpoint is reachable here. No Figma token, user URL,
 * arbitrary MCP command or subprocess is accepted by this module.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TotalFigmaMcp = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function (root) {
  "use strict";

  const ENDPOINT = "http://127.0.0.1:3845/mcp";
  const PROTOCOL_VERSION = "2025-06-18";
  const MAX_TOOLS = 128;
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const MAX_TEXT_CHARS = 64 * 1024;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,54}$/;

  function timeoutBudget(value, fallback) {
    return Math.max(1000, Math.min(Number(value) || fallback || 6500, 150000));
  }
  function remainingBudget(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FigmaMcpError("Figma MCP operation timed out", "FIGMA_TIMEOUT", "transport");
    return Math.max(250, remaining);
  }

  class FigmaMcpError extends Error {
    constructor(message, code, kind, status) {
      super(String(message || "Figma MCP request failed"));
      this.name = "FigmaMcpError";
      this.code = code || "FIGMA_MCP_ERROR";
      this.kind = kind || "transport";
      if (Number.isFinite(status)) this.status = status;
    }
  }

  const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const clip = (value, max) => String(value == null ? "" : value).slice(0, max);

  function jsonSize(value) {
    try { return JSON.stringify(value).length; } catch { return Infinity; }
  }

  function cleanInputSchema(value) {
    if (!isRecord(value) || jsonSize(value) > 128 * 1024) return { type: "object", properties: {} };
    let schema;
    try { schema = JSON.parse(JSON.stringify(value)); } catch { return { type: "object", properties: {} }; }
    if (!schema.type) schema.type = "object";
    if (!isRecord(schema.properties)) schema.properties = {};
    if (!Array.isArray(schema.required)) delete schema.required;
    else schema.required = schema.required.filter((x) => typeof x === "string" && Object.prototype.hasOwnProperty.call(schema.properties, x)).slice(0, 128);
    return schema;
  }

  function exposeTools(rawTools) {
    if (!Array.isArray(rawTools)) throw new FigmaMcpError("Figma MCP returned an invalid tools list", "FIGMA_BAD_TOOLS", "protocol");
    const out = [], seen = new Set();
    for (const raw of rawTools.slice(0, MAX_TOOLS)) {
      if (!isRecord(raw) || typeof raw.name !== "string" || !TOOL_NAME_RE.test(raw.name)) continue;
      const name = "figma_" + raw.name;
      if (name.length > 64 || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        server: "figma",
        description: "Figma MCP: " + clip(raw.description || "Figma Desktop MCP tool", 4000),
        inputSchema: cleanInputSchema(raw.inputSchema),
      });
    }
    return out;
  }

  function jsonRpcMessage(raw, expectedId) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.find((item) => isRecord(item) && item.id === expectedId) || null;
  }

  function sseMessage(raw, expectedId, includeTail) {
    const frames = String(raw).split(/\r?\n\r?\n/);
    const complete = includeTail ? frames : frames.slice(0, -1);
    for (const frame of complete) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, ""));
      if (!data.length) continue;
      const message = jsonRpcMessage(data.join("\n"), expectedId);
      if (message) return message;
    }
    return null;
  }

  async function readJsonRpcResponse(response, expectedId) {
    const contentType = String(response.headers && response.headers.get ? response.headers.get("content-type") || "" : "").toLowerCase();
    const isSse = contentType.includes("text/event-stream");
    const body = response.body;
    if (isSse && body && typeof body.getReader === "function") {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let text = "", bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.value) {
            bytes += part.value.byteLength || part.value.length || 0;
            if (bytes > MAX_RESPONSE_BYTES) throw new FigmaMcpError("Figma MCP response exceeded the 8 MiB safety limit", "FIGMA_RESPONSE_TOO_LARGE", "transport");
            text += decoder.decode(part.value, { stream: !part.done });
            const found = sseMessage(text, expectedId, false);
            if (found) { try { await reader.cancel(); } catch {} return found; }
          }
          if (part.done) break;
        }
        text += decoder.decode();
      } finally {
        try { reader.releaseLock(); } catch {}
      }
      const found = sseMessage(text, expectedId, true);
      if (found) return found;
      throw new FigmaMcpError("Figma MCP event stream ended without the matching JSON-RPC response", "FIGMA_BAD_RESPONSE", "protocol");
    }

    let text;
    try { text = await response.text(); }
    catch (error) { throw new FigmaMcpError("Could not read the Figma MCP response: " + clip(error && error.message || error, 180), "FIGMA_BAD_RESPONSE", "transport"); }
    if (text.length > MAX_RESPONSE_BYTES) throw new FigmaMcpError("Figma MCP response exceeded the 8 MiB safety limit", "FIGMA_RESPONSE_TOO_LARGE", "transport");
    const message = isSse ? sseMessage(text, expectedId, true) : jsonRpcMessage(text, expectedId);
    if (!message) throw new FigmaMcpError("Figma MCP returned invalid JSON-RPC data", "FIGMA_BAD_RESPONSE", "protocol");
    return message;
  }

  function resultText(result) {
    if (!isRecord(result)) return "";
    const content = Array.isArray(result.content) ? result.content : [];
    return content.filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text).join("\n");
  }

  function normalizeToolResult(result) {
    const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
    let text = resultText(result), imageBytes = 0;
    const images = [];
    for (const item of content) {
      if (!isRecord(item) || item.type !== "image" || typeof item.data !== "string") continue;
      const mimeType = String(item.mimeType || "image/png").toLowerCase();
      if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mimeType)) continue;
      const data = item.data.replace(/\s+/g, "");
      const bytes = Math.floor(data.length * 3 / 4);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || bytes > MAX_IMAGE_BYTES || imageBytes + bytes > MAX_IMAGE_BYTES) continue;
      images.push({ mimeType, data });
      imageBytes += bytes;
      if (images.length >= 4) break;
    }
    if (!text && isRecord(result) && result.structuredContent != null) {
      try { text = JSON.stringify(result.structuredContent); } catch { text = ""; }
    }
    if (!text && !images.length) text = "(Figma MCP tool returned no content)";
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "\n[Truncated by TotalScript at 64 KiB.]";
    const isError = !!(isRecord(result) && result.isError === true);
    return isError
      ? { ok: false, kind: "tool", errorCode: "FIGMA_TOOL_ERROR", error: text || "Figma MCP tool reported an error", text, images: [] }
      : { ok: true, text, images };
  }

  class Client {
    constructor(options) {
      const opts = options || {};
      this.endpoint = ENDPOINT;
      this.fetchImpl = typeof opts.fetch === "function" ? opts.fetch : (root && typeof root.fetch === "function" ? root.fetch.bind(root) : null);
      this.clientInfo = isRecord(opts.clientInfo) ? opts.clientInfo : { name: "TotalScript", version: "2.21.0" };
      this._nextId = 1;
      this._activeCalls = new Set();
      this._callsByRequestId = new Map();
      this._sessionId = "";
      this._protocolVersion = "";
      this._initialized = false;
      this._rawTools = [];
      this._exposedTools = [];
    }

    get tools() { return this._exposedTools.slice(); }
    get initialized() { return this._initialized; }

    _reset() {
      this._sessionId = "";
      this._protocolVersion = "";
      this._initialized = false;
      this._rawTools = [];
      this._exposedTools = [];
    }

    async _post(method, params, timeoutMs, notification, options) {
      if (!this.fetchImpl) throw new FigmaMcpError("Fetch is unavailable in this extension context", "FIGMA_TRANSPORT_UNAVAILABLE", "transport");
      const id = notification ? null : this._nextId++;
      const envelope = { jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) };
      const headers = { "Accept": "application/json, text/event-stream", "Content-Type": "application/json" };
      if (this._sessionId) headers["Mcp-Session-Id"] = this._sessionId;
      headers["MCP-Protocol-Version"] = this._protocolVersion || PROTOCOL_VERSION;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const tracking = options && options.tracking;
      if (tracking) { tracking.controller = controller; tracking.id = id; }
      const timeout = Math.max(250, Math.min(Number(timeoutMs) || 6500, 150000));
      const timer = controller ? setTimeout(() => { if (tracking) tracking.timedOut = true; try { controller.abort(); } catch {} }, timeout) : null;
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST", headers, body: JSON.stringify(envelope), cache: "no-store",
          credentials: "omit", redirect: "error", ...(controller ? { signal: controller.signal } : {}),
        });
        const session = response.headers && response.headers.get ? response.headers.get("Mcp-Session-Id") : "";
        if (session) this._sessionId = String(session).slice(0, 512);
        if (!response.ok) {
          let detail = "";
          try { detail = clip(await response.text(), 180).replace(/[\r\n\t]+/g, " "); } catch {}
          const code = response.status === 401 || response.status === 403 ? "FIGMA_AUTH_REQUIRED" : response.status === 404 ? "FIGMA_NOT_AVAILABLE" : "FIGMA_HTTP_ERROR";
          const why = response.status === 404
            ? "Figma Desktop MCP endpoint returned 404; open Figma Desktop and enable its local MCP server"
            : "Figma Desktop MCP returned HTTP " + response.status + (detail ? ": " + detail : "");
          throw new FigmaMcpError(why, code, "transport", response.status);
        }
        if (notification && (response.status === 202 || response.status === 204)) return null;
        if (!notification && (response.status === 202 || response.status === 204)) {
          throw new FigmaMcpError("Figma MCP accepted a request but did not return its response", "FIGMA_EMPTY_RESPONSE", "protocol", response.status);
        }
        if (notification) {
          // Streamable HTTP notifications may be acknowledged with an empty 200.
          let body = "";
          try { body = await response.text(); } catch {}
          if (!body.trim()) return null;
          try { return JSON.parse(body); } catch { return null; }
        }
        const message = await readJsonRpcResponse(response, id);
        if (message.error) {
          const why = isRecord(message.error) ? message.error.message : message.error;
          const code = method === "tools/call" ? "FIGMA_TOOL_ERROR" : "FIGMA_MCP_PROTOCOL_ERROR";
          throw new FigmaMcpError(clip(why || "Figma MCP returned a JSON-RPC error", 2000), code, method === "tools/call" ? "tool" : "protocol");
        }
        if (!Object.prototype.hasOwnProperty.call(message, "result")) throw new FigmaMcpError("Figma MCP response did not include a result", "FIGMA_BAD_RESPONSE", "protocol");
        return message.result;
      } catch (error) {
        if (tracking && tracking.cancelled) throw new FigmaMcpError("Figma MCP tool call was cancelled", "FIGMA_CANCELLED", "cancelled");
        if ((tracking && tracking.timedOut) || (controller && controller.signal.aborted)) throw new FigmaMcpError("Figma Desktop MCP request timed out", "FIGMA_TIMEOUT", "transport");
        if (error instanceof FigmaMcpError) throw error;
        const detail = clip(error && error.message || error, 160);
        throw new FigmaMcpError("Could not reach Figma Desktop MCP at 127.0.0.1:3845/mcp" + (detail ? ": " + detail : ""), "FIGMA_TRANSPORT_ERROR", "transport");
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async connect(timeoutMs) {
      this.cancelAll();
      this._reset();
      const deadline = Date.now() + timeoutBudget(timeoutMs, 6500);
      const remaining = () => remainingBudget(deadline);
      const initialized = await this._post("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clip(this.clientInfo.name || "TotalScript", 80), version: clip(this.clientInfo.version || "2.21.0", 40) },
      }, remaining(), false);
      if (!isRecord(initialized) || typeof initialized.protocolVersion !== "string") {
        this._reset();
        throw new FigmaMcpError("Figma MCP did not complete protocol initialization", "FIGMA_BAD_INITIALIZE", "protocol");
      }
      this._protocolVersion = initialized.protocolVersion;
      this._initialized = true;
      try {
        await this._post("notifications/initialized", {}, remaining(), true);
        const listed = await this._post("tools/list", {}, remaining(), false);
        if (!isRecord(listed) || !Array.isArray(listed.tools)) throw new FigmaMcpError("Figma MCP returned an invalid tools/list result", "FIGMA_BAD_TOOLS", "protocol");
        this._rawTools = listed.tools.filter((tool) => isRecord(tool) && typeof tool.name === "string" && TOOL_NAME_RE.test(tool.name)).slice(0, MAX_TOOLS);
        this._exposedTools = exposeTools(this._rawTools);
        return this.tools;
      } catch (error) {
        this._reset();
        throw error;
      }
    }

    async refresh(timeoutMs) {
      if (!this._initialized) return this.connect(timeoutMs);
      const timeout = Number(timeoutMs) || 6500;
      try {
        const listed = await this._post("tools/list", {}, timeout, false);
        if (!isRecord(listed) || !Array.isArray(listed.tools)) throw new FigmaMcpError("Figma MCP returned an invalid tools/list result", "FIGMA_BAD_TOOLS", "protocol");
        this._rawTools = listed.tools.filter((tool) => isRecord(tool) && typeof tool.name === "string" && TOOL_NAME_RE.test(tool.name)).slice(0, MAX_TOOLS);
        this._exposedTools = exposeTools(this._rawTools);
        return this.tools;
      } catch (error) {
        if (error && error.status === 404) return this.connect(timeout);
        throw error;
      }
    }

    async callTool(rawName, args, timeoutMs, requestId) {
      if (!this._initialized) throw new FigmaMcpError("Figma Desktop MCP is not connected", "FIGMA_OFFLINE", "transport");
      const toolName = String(rawName || "");
      if (!this._rawTools.some((tool) => tool.name === toolName)) throw new FigmaMcpError("That tool is no longer advertised by Figma MCP; refresh its tool list before retrying", "FIGMA_TOOL_STALE", "validation");
      const arguments_ = isRecord(args) ? args : {};
      if (jsonSize(arguments_) > 1024 * 1024) throw new FigmaMcpError("Figma tool arguments exceed the 1 MiB safety limit", "FIGMA_ARGS_TOO_LARGE", "validation");
      const key = requestId == null ? "" : clip(String(requestId), 128);
      const tracking = { id: null, controller: null, cancelled: false, timedOut: false };
      this._activeCalls.add(tracking);
      if (key) {
        let calls = this._callsByRequestId.get(key);
        if (!calls) this._callsByRequestId.set(key, calls = new Set());
        calls.add(tracking);
      }
      try {
        const result = await this._post("tools/call", { name: toolName, arguments: arguments_ }, timeoutMs, false, { tracking });
        if (!isRecord(result)) throw new FigmaMcpError("Figma MCP returned an invalid tool result", "FIGMA_BAD_RESULT", "protocol");
        return normalizeToolResult(result);
      } finally {
        this._activeCalls.delete(tracking);
        if (key) {
          const calls = this._callsByRequestId.get(key);
          if (calls) { calls.delete(tracking); if (!calls.size) this._callsByRequestId.delete(key); }
        }
      }
    }

    _cancelCall(tracking) {
      if (!tracking || tracking.cancelled) return false;
      tracking.cancelled = true;
      if (tracking.id != null && this._initialized) {
        try { this._post("notifications/cancelled", { requestId: tracking.id, reason: "Cancelled by the user in TotalScript" }, 1200, true).catch(() => {}); } catch {}
      }
      try { tracking.controller && tracking.controller.abort(); } catch {}
      return true;
    }

    cancel(requestId) {
      const key = requestId == null ? "" : clip(String(requestId), 128);
      const calls = key && this._callsByRequestId.get(key);
      if (!calls || !calls.size) return false;
      let cancelled = false;
      for (const call of calls) cancelled = this._cancelCall(call) || cancelled;
      return cancelled;
    }

    cancelAll() {
      let cancelled = false;
      for (const call of this._activeCalls) cancelled = this._cancelCall(call) || cancelled;
      return cancelled;
    }

    disconnect() { this.cancelAll(); this._reset(); }
  }

  return {
    ENDPOINT,
    PROTOCOL_VERSION,
    Client,
    FigmaMcpError,
    exposeTools,
    normalizeToolResult,
  };
});
