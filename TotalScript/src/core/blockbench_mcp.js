// SPDX-License-Identifier: GPL-3.0-or-later
// blockbench_mcp.js - 2.18.0 Blockbench MCP (Streamable HTTP client + the
// curated bb_* command table).
//
// Blockbench (https://www.blockbench.net) is the free low-poly / voxel-style
// model, texture and animation editor. The community plugin
// jasonjgardner/blockbench-mcp-plugin (MIT, v1.10.x) runs an MCP server INSIDE
// the Blockbench desktop app over the MCP "Streamable HTTP" transport, default
// http://localhost:3000/bb-mcp (Blockbench → Settings → General → MCP Server
// Port / Endpoint). This file is the whole protocol side:
//
//   createClient({url, fetch})   initialize → notifications/initialized →
//                                tools/list (paged) → tools/call, with the
//                                Mcp-Session-Id header, JSON *or* SSE bodies,
//                                one transparent re-initialize when the server
//                                answers 404 "session not found".
//   COMMANDS / plan()            the curated TotalScript commands (bb_status,
//                                bb_project, bb_cubes, bb_cube_edit, bb_group,
//                                bb_remove, bb_texture, bb_animate, bb_camera,
//                                bb_screenshot, bb_export, bb_undo, bb_tools,
//                                bb_call). Every one validates its arguments
//                                here and maps onto the plugin's REAL tool
//                                names and parameter names (read from the
//                                plugin's server/tools/*.ts zod schemas, not
//                                invented). plan() returns the MCP calls to
//                                make; the caller (background.js) executes
//                                them in order and feeds the results through
//                                render().
//
// Pure JS: no DOM, no chrome.*; `fetch` is injected so the node test can run
// the client against a fake Streamable HTTP server. Loaded by background.js
// via importScripts (classic service worker) and by tests via require.
const TotalBlockbenchMcp = (() => {
  "use strict";
  const VERSION = "2.18.0";
  const DEFAULT_URL = "http://localhost:3000/bb-mcp";
  const PROTOCOL_VERSION = "2025-06-18";
  const CLIENT_INFO = { name: "TotalScript", version: VERSION };
  const DEFAULT_TIMEOUT_MS = 60000;
  const EXPORT_DIR = "blockbench_exports";
  const EXPORT_MAX_INLINE = 2000000; // plugin cap for max_content_length

  // ── URL ────────────────────────────────────────────────────────────────────
  // Only loopback targets: the plugin binds 127.0.0.1 / ::1 by default and
  // TotalScript must never be pointed at a remote host from a chat page.
  function isLoopbackHost(h) {
    const host = String(h || "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  }
  // normalizeUrl(raw) → { ok:true, url, port, origin } | { ok:false, error }
  function normalizeUrl(raw) {
    const s = String(raw == null ? "" : raw).trim() || DEFAULT_URL;
    let u;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : "http://" + s); } catch { return { ok: false, error: "Blockbench MCP URL is not a valid http URL: " + s }; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Blockbench MCP URL must start with http://" };
    if (!isLoopbackHost(u.hostname)) return { ok: false, error: "Blockbench MCP URL must point at this computer (localhost / 127.0.0.1), got " + u.hostname };
    if (u.search || u.hash) return { ok: false, error: "Blockbench MCP URL must not carry a query string or fragment" };
    const path = u.pathname.replace(/\/+$/, "") || "/bb-mcp";
    const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
    const origin = u.protocol + "//" + u.hostname + (u.port ? ":" + u.port : "");
    return { ok: true, url: origin + path, port, origin, host: u.hostname, path };
  }

  // ── SSE / JSON-RPC parsing ────────────────────────────────────────────────
  // parseSse(text) → every JSON message carried in `data:` lines (events are
  // separated by a blank line; a multi-line data block is joined with \n).
  function parseSse(text) {
    const out = [];
    const blocks = String(text || "").replace(/\r\n/g, "\n").split(/\n\n+/);
    for (const block of blocks) {
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      try { out.push(JSON.parse(data.join("\n"))); } catch {}
    }
    return out;
  }
  function parseBody(contentType, text) {
    const ct = String(contentType || "").toLowerCase();
    if (ct.includes("text/event-stream")) return parseSse(text);
    const s = String(text || "").trim();
    if (!s) return [];
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : [v]; } catch {}
    return parseSse(s); // a few servers stream SSE without the header
  }

  class McpError extends Error {
    constructor(message, extra) { super(message); this.name = "McpError"; Object.assign(this, extra || {}); }
  }

  // ── Client ─────────────────────────────────────────────────────────────────
  // createClient({ url, fetch, timeoutMs, onSession }) — one session per
  // client. All methods reject with McpError {code, status, hint}.
  function createClient(opts) {
    const o = opts || {};
    const n = normalizeUrl(o.url);
    if (!n.ok) throw new McpError(n.error, { code: "BAD_URL" });
    const f = typeof o.fetch === "function" ? o.fetch : (typeof fetch === "function" ? fetch : null);
    if (!f) throw new McpError("no fetch implementation", { code: "NO_FETCH" });
    const defaultTimeout = Math.max(1000, Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const state = { url: n.url, sessionId: "", serverInfo: null, instructions: "", tools: [], toolsAt: 0, nextId: 1, connecting: null };

    function baseHeaders() {
      const h = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
      if (state.sessionId) { h["Mcp-Session-Id"] = state.sessionId; h["MCP-Protocol-Version"] = PROTOCOL_VERSION; }
      return h;
    }
    function explain(status, text) {
      const t = String(text || "").slice(0, 300);
      if (status === 403 && /origin not allowed/i.test(t)) {
        return { code: "ORIGIN_REJECTED", hint: "The Blockbench MCP plugin only accepts loopback origins; TotalScript sets Origin to the plugin's own origin through a declarativeNetRequest session rule. If this persists, update Chrome / reload the extension and reconnect." };
      }
      if (status === 403) return { code: "FORBIDDEN", hint: "The plugin refused the request (Host/Origin check)." };
      if (status === 404) return { code: "NOT_FOUND", hint: "Nothing answered at this endpoint: check Blockbench → Settings → General → MCP Server Port / Endpoint and that the MCP plugin is installed and enabled." };
      if (status === 406) return { code: "NOT_ACCEPTABLE", hint: "The server rejected the Accept header." };
      if (status === 503) return { code: "BUSY", hint: "Too many MCP sessions are open in Blockbench - close another MCP client or raise the session limit in Blockbench settings." };
      return { code: "HTTP_" + status, hint: "" };
    }
    async function post(body, timeoutMs) {
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      const ms = Math.max(1000, Number(timeoutMs) || defaultTimeout);
      const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch {} }, ms);
      let res;
      try {
        res = await f(state.url, { method: "POST", headers: baseHeaders(), body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
      } catch (e) {
        clearTimeout(timer);
        const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e && e.message)));
        throw new McpError(aborted ? "Blockbench did not answer within " + Math.round(ms / 1000) + "s" : "Blockbench MCP is not reachable at " + state.url + " (" + String((e && e.message) || e) + ")", { code: aborted ? "TIMEOUT" : "UNREACHABLE" });
      }
      clearTimeout(timer);
      const sid = res.headers && typeof res.headers.get === "function" ? res.headers.get("mcp-session-id") : "";
      if (sid) state.sessionId = sid;
      const ct = res.headers && typeof res.headers.get === "function" ? (res.headers.get("content-type") || "") : "";
      const text = res.status === 202 || res.status === 204 ? "" : await res.text();
      if (res.status === 404 && state.sessionId && /session/i.test(text)) {
        state.sessionId = "";
        throw new McpError("Blockbench MCP session expired", { code: "SESSION_LOST", status: 404 });
      }
      if (!res.ok) {
        const x = explain(res.status, text);
        let detail = "";
        try { const j = JSON.parse(text); detail = (j && j.error && j.error.message) || ""; } catch {}
        throw new McpError("Blockbench MCP HTTP " + res.status + (detail ? ": " + detail : "") + (x.hint ? " — " + x.hint : ""), { code: x.code, status: res.status });
      }
      return parseBody(ct, text);
    }
    async function request(method, params, timeoutMs) {
      const id = state.nextId++;
      const msgs = await post({ jsonrpc: "2.0", id, method, params: params || {} }, timeoutMs);
      const hit = msgs.find((m) => m && m.id === id) || msgs.find((m) => m && ("result" in m || "error" in m));
      if (!hit) throw new McpError("Blockbench MCP returned no response for " + method, { code: "EMPTY" });
      if (hit.error) throw new McpError(String((hit.error && hit.error.message) || "MCP error"), { code: "RPC_ERROR", rpc: hit.error.code, data: hit.error.data });
      return hit.result;
    }
    async function notify(method, params) {
      await post({ jsonrpc: "2.0", method, params: params || {} }, 10000);
    }
    async function listTools() {
      const all = [];
      let cursor;
      for (let page = 0; page < 20; page++) {
        const r = await request("tools/list", cursor ? { cursor } : {});
        for (const t of (r && Array.isArray(r.tools)) ? r.tools : []) if (t && t.name) all.push(t);
        cursor = r && r.nextCursor;
        if (!cursor) break;
      }
      state.tools = all; state.toolsAt = Date.now();
      return all;
    }
    async function connect() {
      if (state.connecting) return state.connecting;
      state.connecting = (async () => {
        state.sessionId = "";
        const init = await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, 15000);
        state.serverInfo = (init && init.serverInfo) || null;
        state.instructions = String((init && init.instructions) || "");
        await notify("notifications/initialized", {});
        await listTools();
        try { if (typeof o.onSession === "function") o.onSession(state.sessionId); } catch {}
        return { ok: true, sessionId: state.sessionId, serverInfo: state.serverInfo, tools: state.tools, protocolVersion: (init && init.protocolVersion) || "" };
      })();
      try { return await state.connecting; } finally { state.connecting = null; }
    }
    async function callTool(name, args, timeoutMs) {
      if (!state.sessionId) await connect();
      try {
        return await request("tools/call", { name: String(name), arguments: args && typeof args === "object" ? args : {} }, timeoutMs);
      } catch (e) {
        if (e && e.code === "SESSION_LOST") {
          await connect();
          return await request("tools/call", { name: String(name), arguments: args && typeof args === "object" ? args : {} }, timeoutMs);
        }
        throw e;
      }
    }
    async function close() {
      if (!state.sessionId) return;
      const sid = state.sessionId;
      state.sessionId = "";
      try { await f(state.url, { method: "DELETE", headers: { "Mcp-Session-Id": sid, "MCP-Protocol-Version": PROTOCOL_VERSION } }); } catch {}
    }
    return {
      url: state.url,
      get sessionId() { return state.sessionId; },
      get tools() { return state.tools; },
      get serverInfo() { return state.serverInfo; },
      get instructions() { return state.instructions; },
      connect, listTools, callTool, close, request,
    };
  }

  // ── Result helpers ────────────────────────────────────────────────────────
  // resultText(result) → the text content blocks joined; resultImages(result)
  // → [{mimeType, data}] in the shape the extension already uses for
  // screenshots (ui.showImages / A.pendingImages).
  function resultText(result) {
    const parts = [];
    const content = result && Array.isArray(result.content) ? result.content : [];
    for (const c of content) {
      if (!c) continue;
      if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      else if (c.type === "resource" && c.resource && typeof c.resource.text === "string") parts.push(c.resource.text);
      else if (c.type === "resource_link" && c.uri) parts.push("[resource " + c.uri + "]");
    }
    if (!parts.length && result && result.structuredContent) { try { parts.push(JSON.stringify(result.structuredContent)); } catch {} }
    return parts.join("\n");
  }
  function resultImages(result) {
    const out = [];
    const content = result && Array.isArray(result.content) ? result.content : [];
    for (const c of content) {
      if (c && c.type === "image" && typeof c.data === "string" && c.data.length > 100) out.push({ mimeType: String(c.mimeType || "image/png"), data: c.data.replace(/^data:[^,]*,/, "") });
    }
    return out;
  }
  const isErrorResult = (result) => !!(result && result.isError === true);

  // ── Validation helpers ────────────────────────────────────────────────────
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  const safeName = (v, fallback) => {
    const s = String(v == null ? "" : v).trim().replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 64);
    return s || fallback;
  };
  function fail(cmd, msg) { return { ok: false, error: "ERROR INVALID_ARGUMENT in " + cmd + ": " + msg }; }

  const FORMATS = {
    obj: { codec: "obj", ext: "obj", label: "Wavefront OBJ (+ .mtl; Roblox Studio 3D Importer accepts it)" },
    gltf: { codec: "gltf", ext: "gltf", label: "glTF 2.0 ascii (Roblox Studio 3D Importer accepts it)", options: { encoding: "ascii" } },
    glb: { codec: "gltf", ext: "glb", label: "glTF 2.0 binary (Roblox Studio 3D Importer accepts it)", options: { encoding: "binary" } },
    bbmodel: { codec: "project", ext: "bbmodel", label: "Blockbench project (re-open in Blockbench; Studio cannot import it)" },
    fbx: { codec: "fbx", ext: "fbx", label: "FBX (only when Blockbench lists the fbx codec)" },
  };

  // ── Curated commands ──────────────────────────────────────────────────────
  // Each entry: description, inputSchema (JSON schema the catalogue shows),
  // plan(args, ctx) → { ok:true, steps:[{tool, args, optional?}], note? } |
  // { ok:false, error }, and render(stepResults, args, ctx) → text. ctx =
  // { tools: Set of discovered tool names, exportRoot: "<agent workspace>" | "" }.
  const COMMANDS = {
    bb_status: {
      description: "Blockbench: read the open project (format, name, texture size, element counts, top-level groups) and the outliner tree. Run it FIRST and after every build pass.",
      inputSchema: { type: "object", properties: { max_depth: { type: "integer", description: "Outliner depth to list (1-32, default 4)." } } },
      plan(a) {
        const d = Math.min(32, Math.max(1, Math.round(Number(a && a.max_depth) || 4)));
        return { ok: true, steps: [{ tool: "get_project_info", args: {} }, { tool: "list_outline", args: { max_depth: d, include_cubes: true, include_meshes: true }, optional: true }] };
      },
    },
    bb_project: {
      description: "Blockbench: create a new project. format = Blockbench format id (free = generic low-poly for Roblox exports, bedrock_block, java_block, …).",
      inputSchema: { type: "object", properties: { name: { type: "string" }, format: { type: "string", description: "Format id, default 'free' (unconstrained cubes, best for OBJ / glTF export to Roblox)." } }, required: ["name"] },
      plan(a) {
        if (!str(a && a.name)) return fail("bb_project", "name (string) is required");
        return { ok: true, steps: [{ tool: "create_project", args: { name: String(a.name).trim(), format: str(a.format) ? String(a.format).trim() : "free" } }, { tool: "get_project_info", args: {}, optional: true }] };
      },
    },
    bb_cubes: {
      description: "Blockbench: place one or more cubes in one undoable edit. cubes = [{name, from:[x,y,z], to:[x,y,z], origin?, rotation?, inflate?}] in Blockbench units (16 = one block); group? = parent group name; texture? = texture name/id.",
      inputSchema: { type: "object", properties: {
        cubes: { type: "array", description: "1-200 cubes: {name, from:[x,y,z], to:[x,y,z], origin?:[x,y,z], rotation?:[x,y,z] degrees, inflate?:number}" },
        group: { type: "string", description: "Parent group name or UUID (default root)." },
        texture: { type: "string", description: "Texture name or id to apply to every face (omit = project default texture)." },
      }, required: ["cubes"] },
      plan(a) {
        const cubes = a && Array.isArray(a.cubes) ? a.cubes : (a && a.cube && typeof a.cube === "object" ? [a.cube] : null);
        if (!cubes || !cubes.length) return fail("bb_cubes", "cubes (non-empty array) is required");
        if (cubes.length > 200) return fail("bb_cubes", "at most 200 cubes per call");
        const elements = [];
        for (let i = 0; i < cubes.length; i++) {
          const c = cubes[i] || {};
          if (!str(c.name)) return fail("bb_cubes", "cubes[" + i + "].name is required");
          if (!vec3(c.from) || !vec3(c.to)) return fail("bb_cubes", "cubes[" + i + "] needs from and to as [x,y,z] numbers");
          const el = { name: String(c.name).trim(), from: c.from, to: c.to };
          if (c.origin !== undefined) { if (!vec3(c.origin)) return fail("bb_cubes", "cubes[" + i + "].origin must be [x,y,z]"); el.origin = c.origin; }
          if (c.rotation !== undefined) { if (!vec3(c.rotation)) return fail("bb_cubes", "cubes[" + i + "].rotation must be [x,y,z] degrees"); el.rotation = c.rotation; }
          if (c.inflate !== undefined) { if (!isNum(c.inflate)) return fail("bb_cubes", "cubes[" + i + "].inflate must be a number"); el.inflate = c.inflate; }
          elements.push(el);
        }
        const args = { elements };
        if (str(a.group) && String(a.group).trim().toLowerCase() !== "root") args.group = String(a.group).trim();
        if (str(a.texture)) args.texture = String(a.texture).trim();
        return { ok: true, steps: [{ tool: "place_cube", args }] };
      },
    },
    bb_cube_edit: {
      description: "Blockbench: change an existing cube by name/id: from, to, origin, rotation, inflate, new name, visibility.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "Cube name or UUID." }, from: { type: "array" }, to: { type: "array" }, origin: { type: "array" }, rotation: { type: "array" }, inflate: { type: "number" }, name: { type: "string", description: "New name." }, visibility: { type: "boolean" } }, required: ["id"] },
      plan(a) {
        if (!str(a && a.id)) return fail("bb_cube_edit", "id (cube name or UUID) is required");
        const args = { id: String(a.id).trim() };
        for (const k of ["from", "to", "origin", "rotation"]) if (a[k] !== undefined) { if (!vec3(a[k])) return fail("bb_cube_edit", k + " must be [x,y,z] numbers"); args[k] = a[k]; }
        if (a.inflate !== undefined) { if (!isNum(a.inflate)) return fail("bb_cube_edit", "inflate must be a number"); args.inflate = a.inflate; }
        if (a.name !== undefined) { if (!str(a.name)) return fail("bb_cube_edit", "name must be a non-empty string"); args.name = String(a.name).trim(); }
        if (a.visibility !== undefined) args.visibility = !!a.visibility;
        if (Object.keys(args).length === 1) return fail("bb_cube_edit", "give at least one property to change (from, to, origin, rotation, inflate, name, visibility)");
        return { ok: true, steps: [{ tool: "modify_cube", args }] };
      },
    },
    bb_group: {
      description: "Blockbench: add a group (bone) — the unit that animations move. origin = pivot, parent = group name or root.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, origin: { type: "array", description: "[x,y,z] pivot" }, rotation: { type: "array" }, parent: { type: "string", description: "Parent group name/UUID or 'root'." } }, required: ["name"] },
      plan(a) {
        if (!str(a && a.name)) return fail("bb_group", "name is required");
        const args = { name: String(a.name).trim() };
        if (a.origin !== undefined) { if (!vec3(a.origin)) return fail("bb_group", "origin must be [x,y,z]"); args.origin = a.origin; }
        if (a.rotation !== undefined) { if (!vec3(a.rotation)) return fail("bb_group", "rotation must be [x,y,z]"); args.rotation = a.rotation; }
        if (str(a.parent)) args.parent = String(a.parent).trim();
        return { ok: true, steps: [{ tool: "add_group", args }] };
      },
    },
    bb_remove: {
      description: "Blockbench: remove a cube, mesh or group by name/id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      plan(a) {
        if (!str(a && a.id)) return fail("bb_remove", "id (element name or UUID) is required");
        return { ok: true, steps: [{ tool: "remove_element", args: { id: String(a.id).trim() } }] };
      },
    },
    bb_texture: {
      description: "Blockbench textures. action:'create' {name, width?, height?, fill_color? '#rrggbb' | data? image data URL} · 'apply' {id: element, texture: name/id, applyTo?: all|blank} · 'list'.",
      inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create", "apply", "list"] }, name: { type: "string" }, width: { type: "integer" }, height: { type: "integer" }, fill_color: { type: "string" }, data: { type: "string" }, id: { type: "string" }, texture: { type: "string" }, applyTo: { type: "string", enum: ["all", "blank", "none"] } }, required: ["action"] },
      plan(a) {
        const action = String((a && a.action) || "").trim().toLowerCase();
        if (action === "list") return { ok: true, steps: [{ tool: "list_textures", args: {} }] };
        if (action === "create") {
          if (!str(a.name)) return fail("bb_texture", "name is required for action:create");
          const w = a.width === undefined ? 16 : Number(a.width), h = a.height === undefined ? 16 : Number(a.height);
          if (!(Number.isInteger(w) && w >= 16 && w <= 4096 && Number.isInteger(h) && h >= 16 && h <= 4096)) return fail("bb_texture", "width/height must be integers 16-4096");
          const args = { name: String(a.name).trim(), width: w, height: h };
          if (str(a.data) && str(a.fill_color)) return fail("bb_texture", "give data OR fill_color, not both");
          if (str(a.data)) args.data = String(a.data).trim();
          if (str(a.fill_color)) args.fill_color = String(a.fill_color).trim();
          return { ok: true, steps: [{ tool: "create_texture", args }] };
        }
        if (action === "apply") {
          if (!str(a.id) || !str(a.texture)) return fail("bb_texture", "action:apply needs id (element) and texture (name/id)");
          const args = { id: String(a.id).trim(), texture: String(a.texture).trim() };
          if (a.applyTo !== undefined) { const m = String(a.applyTo); if (!["all", "blank", "none"].includes(m)) return fail("bb_texture", "applyTo must be all | blank | none"); args.applyTo = m; }
          return { ok: true, steps: [{ tool: "apply_texture", args }] };
        }
        return fail("bb_texture", "action must be create | apply | list");
      },
    },
    bb_animate: {
      description: "Blockbench: create a keyframe animation on groups in one call. bones = {GroupName: [{time, rotation?:[x,y,z], position?:[x,y,z], scale?:[x,y,z]|number}]}; loop?, length? seconds.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, loop: { type: "boolean" }, length: { type: "number", description: "Animation length in seconds." }, bones: { type: "object", description: "{groupName: [{time, rotation?, position?, scale?}]}" } }, required: ["name", "bones"] },
      plan(a) {
        if (!str(a && a.name)) return fail("bb_animate", "name is required");
        if (!a.bones || typeof a.bones !== "object" || Array.isArray(a.bones) || !Object.keys(a.bones).length) return fail("bb_animate", "bones must be an object {groupName: [keyframes]}");
        const bones = {};
        for (const [bone, keys] of Object.entries(a.bones)) {
          if (!Array.isArray(keys) || !keys.length) return fail("bb_animate", "bones." + bone + " must be a non-empty array of keyframes");
          const out = [];
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i] || {};
            if (!isNum(k.time) || k.time < 0) return fail("bb_animate", "bones." + bone + "[" + i + "].time must be a number ≥ 0");
            const kf = { time: k.time };
            let any = false;
            for (const ch of ["position", "rotation"]) if (k[ch] !== undefined) { if (!vec3(k[ch])) return fail("bb_animate", "bones." + bone + "[" + i + "]." + ch + " must be [x,y,z]"); kf[ch] = k[ch]; any = true; }
            if (k.scale !== undefined) { if (!vec3(k.scale) && !isNum(k.scale)) return fail("bb_animate", "bones." + bone + "[" + i + "].scale must be [x,y,z] or a number"); kf.scale = k.scale; any = true; }
            if (!any) return fail("bb_animate", "bones." + bone + "[" + i + "] needs position, rotation or scale");
            out.push(kf);
          }
          bones[bone] = out;
        }
        const args = { name: String(a.name).trim(), loop: !!a.loop, bones };
        const len = a.length !== undefined ? a.length : a.animation_length;
        if (len !== undefined) { if (!isNum(len) || len < 0) return fail("bb_animate", "length must be a number ≥ 0 (seconds)"); args.animation_length = len; }
        return { ok: true, steps: [{ tool: "create_animation", args }] };
      },
    },
    bb_camera: {
      description: "Blockbench: move the viewport camera. position [x,y,z], target? [x,y,z], projection? perspective|orthographic, fov?, locked_angle? top|bottom|north|south|east|west (orthographic only).",
      inputSchema: { type: "object", properties: { position: { type: "array" }, target: { type: "array" }, projection: { type: "string", enum: ["unset", "orthographic", "perspective"] }, fov: { type: "number" }, locked_angle: { type: "string", enum: ["top", "bottom", "north", "south", "east", "west"] } }, required: ["position"] },
      plan(a) {
        if (!vec3(a && a.position)) return fail("bb_camera", "position must be [x,y,z] numbers");
        const args = { position: a.position, projection: "unset" };
        if (a.target !== undefined) { if (!vec3(a.target)) return fail("bb_camera", "target must be [x,y,z]"); args.target = a.target; }
        if (a.projection !== undefined) { const p = String(a.projection); if (!["unset", "orthographic", "perspective"].includes(p)) return fail("bb_camera", "projection must be unset | orthographic | perspective"); args.projection = p; }
        if (a.fov !== undefined) { if (!isNum(a.fov) || a.fov < 1 || a.fov > 179) return fail("bb_camera", "fov must be 1-179"); args.fov = a.fov; }
        if (a.locked_angle !== undefined) {
          const l = String(a.locked_angle);
          if (!["top", "bottom", "north", "south", "east", "west"].includes(l)) return fail("bb_camera", "locked_angle must be top | bottom | north | south | east | west");
          if (args.projection === "perspective") return fail("bb_camera", "locked_angle needs projection orthographic");
          args.locked_angle = l;
        }
        return { ok: true, steps: [{ tool: "set_camera_angle", args }] };
      },
    },
    bb_screenshot: {
      description: "Blockbench: PHOTO of the Blockbench viewport (the real render, attached to your next message). max_size? = longest side in px (default 1024). Use it after every build pass and judge what you see.",
      inputSchema: { type: "object", properties: { max_size: { type: "integer" } } },
      plan(a) {
        const args = {};
        const m = a && a.max_size !== undefined ? Number(a.max_size) : 1024;
        if (!(Number.isInteger(m) && m >= 64 && m <= 4096)) return fail("bb_screenshot", "max_size must be an integer 64-4096");
        args.max_size = m;
        return { ok: true, steps: [{ tool: "capture_screenshot", args }] };
      },
    },
    bb_export: {
      description: "Blockbench: export the open project to a file for Roblox Studio. format = obj | gltf | glb | bbmodel. Writes <agent workspace>/blockbench_exports/<name>.<ext> when the TotalScript desktop agent runs (Blockbench asks once for file permission); otherwise the file content comes back inline. Studio import is MANUAL: Studio → Home → Import 3D → pick the file.",
      inputSchema: { type: "object", properties: { format: { type: "string", enum: ["obj", "gltf", "glb", "bbmodel"] }, name: { type: "string", description: "File name without extension (default the project name / timestamp)." }, overwrite: { type: "boolean", description: "Replace an existing file (default false)." }, scale: { type: "number", description: "glTF export scale option (optional)." } }, required: ["format"] },
      plan(a, ctx) {
        const key = String((a && a.format) || "").trim().toLowerCase();
        const fmt = FORMATS[key];
        if (!fmt) return fail("bb_export", "format must be obj | gltf | glb | bbmodel");
        const tools = ctx && ctx.tools instanceof Set ? ctx.tools : null;
        if (tools && tools.size && !tools.has("export_model")) return fail("bb_export", "this Blockbench MCP plugin does not offer export_model - update the plugin (File → Plugins → MCP → Update) or export by hand from Blockbench (File → Export)");
        const name = safeName(a.name, "TotalScript_" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14));
        const args = { codec_id: fmt.codec, overwrite: !!(a && a.overwrite), result_format: "text" };
        const options = Object.assign({}, fmt.options || {});
        if (a && a.scale !== undefined) { if (!isNum(a.scale) || a.scale <= 0) return fail("bb_export", "scale must be a positive number"); options.scale = a.scale; }
        if (Object.keys(options).length) args.options = options;
        const root = ctx && typeof ctx.exportRoot === "string" ? ctx.exportRoot.trim() : "";
        let path = "";
        if (root) {
          const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
          path = root.replace(/[\\/]+$/, "") + sep + EXPORT_DIR + sep + name + "." + fmt.ext;
          args.path = path;
          args.max_content_length = 0;
        } else {
          args.max_content_length = EXPORT_MAX_INLINE;
        }
        return { ok: true, steps: [{ tool: "export_model", args }], meta: { format: key, codec: fmt.codec, ext: fmt.ext, label: fmt.label, path, name } };
      },
    },
    bb_undo: {
      description: "Blockbench: undo or redo the last edit. action = undo | redo.",
      inputSchema: { type: "object", properties: { action: { type: "string", enum: ["undo", "redo"] } } },
      plan(a) {
        const act = String((a && a.action) || "undo").trim().toLowerCase();
        if (act !== "undo" && act !== "redo") return fail("bb_undo", "action must be undo | redo");
        return { ok: true, steps: [{ tool: act, args: {} }] };
      },
    },
    bb_tools: {
      description: "Blockbench: list the raw MCP tools the connected plugin offers (name + one line), for bb_call. filter? = substring.",
      inputSchema: { type: "object", properties: { filter: { type: "string" } } },
      plan() { return { ok: true, steps: [], local: "tools" }; },
    },
    bb_call: {
      description: "Blockbench power use: call any raw plugin tool by its exact name with its own arguments (see bb_tools). TotalScript only checks that the tool exists.",
      inputSchema: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] },
      plan(a, ctx) {
        if (!str(a && a.tool)) return fail("bb_call", "tool (exact plugin tool name) is required");
        const tool = String(a.tool).trim();
        if (/^bb_/.test(tool)) return fail("bb_call", tool + " is a TotalScript command - call it directly");
        const tools = ctx && ctx.tools instanceof Set ? ctx.tools : null;
        if (tools && tools.size && !tools.has(tool)) {
          const near = [...tools].filter((t) => t.includes(tool.slice(0, 5)) || tool.includes(t.slice(0, 5))).slice(0, 6);
          return fail("bb_call", "the connected plugin offers no tool named '" + tool + "'" + (near.length ? ". Near: " + near.join(", ") : ". Run bb_tools {} to list them."));
        }
        const args = a.args && typeof a.args === "object" && !Array.isArray(a.args) ? a.args : (a.arguments && typeof a.arguments === "object" ? a.arguments : {});
        return { ok: true, steps: [{ tool, args }] };
      },
    },
  };
  const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));
  const isCommand = (name) => Object.prototype.hasOwnProperty.call(COMMANDS, String(name || "").split("/").pop());

  // Tool advertisements for list_tools (same shape as background BLENDER_TOOLS).
  function toolList() {
    return COMMAND_NAMES.map((name) => ({ name, description: COMMANDS[name].description, inputSchema: COMMANDS[name].inputSchema, server: "blockbench" }));
  }
  function plan(name, args, ctx) {
    const bare = String(name || "").split("/").pop();
    const cmd = COMMANDS[bare];
    if (!cmd) return { ok: false, error: "ERROR UNKNOWN_COMMAND: " + bare + " is not a Blockbench command. Commands: " + COMMAND_NAMES.join(", ") };
    try { return cmd.plan(args && typeof args === "object" ? args : {}, ctx || {}); }
    catch (e) { return { ok: false, error: "ERROR in " + bare + ": " + String((e && e.message) || e) }; }
  }

  // render(name, planned, stepResults, ctx) → { text, images, error? }.
  // stepResults = [{ tool, result?, error? }] in plan order. Never invents:
  // the plugin's own text is quoted; TotalScript adds only the next step.
  const clip = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  function render(name, planned, stepResults, ctx) {
    const bare = String(name || "").split("/").pop();
    const images = [];
    const parts = [];
    let error = "";
    for (const sr of stepResults || []) {
      if (!sr) continue;
      if (sr.error) {
        if (sr.optional) parts.push("(" + sr.tool + " skipped: " + clip(sr.error, 200) + ")");
        else { error = sr.error; break; }
        continue;
      }
      const r = sr.result;
      const txt = resultText(r);
      for (const im of resultImages(r)) images.push(im);
      if (isErrorResult(r)) { error = txt || (sr.tool + " failed"); break; }
      if (txt) parts.push((stepResults.length > 1 ? "[" + sr.tool + "] " : "") + clip(txt, 6000));
    }
    if (error) return { text: "", images, error: "ERROR in " + bare + " (" + (stepResults.find((s) => s && (s.error || isErrorResult(s.result))) || {}).tool + "): " + clip(error, 1500) };
    if (bare === "bb_export" && planned && planned.meta) {
      const m = planned.meta;
      const note = m.path
        ? "File: " + m.path + " (" + m.label + "). Blockbench may have shown a one-time file-access prompt - if the text above says the write was refused, accept it in Blockbench and run bb_export again.\nNext for Roblox: in Studio → Home tab → Import 3D → choose that file → check scale / pivot → Import. TotalScript does not upload the file for you."
        : "No desktop agent workspace was available, so the export content is returned inline above (bounded). Save it as <name>." + m.ext + " yourself (or start the TotalScript desktop agent and run bb_export again to get a file). Then Studio → Home → Import 3D.";
      parts.push(note);
    }
    if (bare === "bb_screenshot" && !images.length && !parts.length) parts.push("capture_screenshot returned no image.");
    return { text: parts.join("\n").trim(), images, error: "" };
  }

  // Compact raw-tool listing for bb_tools.
  function describeTools(tools, filter) {
    const q = String(filter || "").trim().toLowerCase();
    const rows = (Array.isArray(tools) ? tools : []).filter((t) => t && t.name && (!q || String(t.name).toLowerCase().includes(q) || String(t.description || "").toLowerCase().includes(q)));
    if (!rows.length) return q ? "No plugin tool matches '" + q + "'." : "The plugin offered no tools (tools/list came back empty).";
    const lines = rows.map((t) => {
      const props = t.inputSchema && t.inputSchema.properties ? Object.keys(t.inputSchema.properties) : [];
      const req = t.inputSchema && Array.isArray(t.inputSchema.required) ? t.inputSchema.required : [];
      const sig = props.length ? " {" + props.map((p) => p + (req.includes(p) ? "" : "?")).slice(0, 12).join(", ") + (props.length > 12 ? ", …" : "") + "}" : " {}";
      return "- " + t.name + sig + " — " + clip(String(t.description || "").replace(/\s+/g, " "), 110);
    });
    return rows.length + " raw tool(s) from the Blockbench MCP plugin (call with bb_call {tool, args}):\n" + lines.join("\n");
  }

  return Object.freeze({
    VERSION, DEFAULT_URL, PROTOCOL_VERSION, EXPORT_DIR, FORMATS, COMMANDS, COMMAND_NAMES,
    McpError, normalizeUrl, isLoopbackHost, parseSse, parseBody, createClient,
    resultText, resultImages, isErrorResult, isCommand, toolList, plan, render, describeTools,
  });
})();
try { if (typeof module !== "undefined" && module.exports) module.exports = TotalBlockbenchMcp; } catch {}
try { if (typeof self !== "undefined") self.TotalBlockbenchMcp = TotalBlockbenchMcp; } catch {}
