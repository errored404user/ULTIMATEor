// SPDX-License-Identifier: GPL-3.0-or-later
// ORscript bridge - the service behind the desktop window.
//
//   http://127.0.0.1:3000   extension REST/WS API (or-core compatible) + /app UI
//   ws://127.0.0.1:17613    legacy engine socket: roblox (Studio MCP + custom MCP)
//   ws://127.0.0.1:17615    legacy engine socket: local (AgentScript workspace)
//
// Everything in here is independent from Electron so the same bridge runs
// headless (`node bridge/cli.js`) and inside the tray app.
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { EventEmitter } = require("events");
const { WebSocketServer, WebSocket } = require("ws");

const { Logger } = require("./log");
const { Settings, PORTS, dataDir } = require("./settings");
const { Workspace, CATALOG: AS_CATALOG, ToolError } = require("./workspace");
const { StudioRuntime } = require("./studio");
const { McpClient, isDeadError } = require("./mcp-client");
const { reclaimPorts } = require("./ports");

const PKG = require("../package.json");
const UI_DIR = path.join(__dirname, "..", "ui");
const DATA_DIR = path.join(__dirname, "..", "data");
const SHARED_ASSETS = path.join(__dirname, "..", "assets");

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
const POLL_ROUNDS = 50;
const POLL_STEP_MS = 500;
const INTRO_TIMEOUT_MS = 8000;

const nowIso = () => new Date().toISOString();
const errorCode = (err) => {
  if (err && err.code && /^[A-Z_]+$/.test(err.code)) return err.code;
  if (isDeadError(err)) return "STUDIO_BRIDGE_OFFLINE";
  return "TOOL_EXECUTION_ERROR";
};

class Bridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.version = options.version || PKG.version;
    this.dataDir = options.dataDir || dataDir();
    this.settings = options.settings || new Settings({ dir: this.dataDir });
    this.log = options.log || new Logger({ dir: path.join(this.dataDir, "logs"), level: this.settings.get("logLevel"), echo: options.echo !== false });
    this.ports = { ...PORTS, ...(options.ports || {}) };
    this.host = "127.0.0.1";
    this.bootAt = Date.now();
    this.workspace = new Workspace({ root: this.settings.workspaceRoot(), fullAccess: !!this.settings.get("fullAccess"), log: this.log });
    this.studio = new StudioRuntime({ log: this.log, version: this.version, command: this.settings.get("mcpCommand") });
    this.servers = new Map(); // custom MCP servers id -> { cfg, client, error }

    this.httpServer = null;
    this.wsBridge = null;      // /ws on :3000
    this.wsRoblox = null;      // :17613
    this.wsLocal = null;       // :17615
    this.bound = { http: false, roblox: false, local: false };
    this.portReport = [];

    this.robloxClients = new Set();
    this.localClients = new Set();
    this.bridgeClients = new Set();
    this.extensionClients = new Map(); // client_id -> { engine, at }
    this.robloxQueue = [];
    this.lastResult = null;
    this.sse = new Set();
    this.stopped = false;
    this.snapshotTimer = null;
    this.retryTimer = null;

    this.settings.on("change", (changed) => this.applySettings(changed));
    this.studio.on("studio", () => this.pushSnapshot());
    this.studio.on("mcp", () => this.pushSnapshot());
    this.studio.on("process", () => this.pushSnapshot());
    this.studio.on("tools", () => this.pushSnapshot());
    this.log.on("line", (entry) => this.broadcastSse("log", entry));
    this.log.on("activity", (entry) => this.broadcastSse("activity", entry));
    this.log.on("activity-cleared", () => this.broadcastSse("activity-cleared", {}));
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start() {
    this.log.info("core", `ORscript Desktop v${this.version} - native bridge for roblox studio / local fs`);
    this.log.info("core", `workspace: ${this.workspace.root}${this.workspace.fullAccess ? " (FULL PC ACCESS)" : ""}`);
    this.log.info("core", `data: ${this.dataDir}`);
    this.portReport = await reclaimPorts([this.ports.http, this.ports.roblox, this.ports.local], this.log);
    await this.bindAll();
    this.studio.startWatcher();
    this.startCustomServers().catch(() => {});
    if (this.settings.get("autoStartStudioMcp") && this.studio.commandAvailable()) {
      this.studio.ensure().catch(() => {});
    }
    this.snapshotTimer = setInterval(() => this.pushSnapshot(), 5000);
    if (this.snapshotTimer.unref) this.snapshotTimer.unref();
    this.log.track("boot", `Bridge online - http ${this.host}:${this.ports.http}, ws ${this.ports.roblox}/${this.ports.local}`);
    return this;
  }

  async bindAll() {
    if (!this.bound.http) {
      try {
        await this.bindHttp();
      } catch (err) {
        this.log.error("core", `cannot bind http ${this.ports.http}: ${err.message}`);
      }
    }
    if (!this.bound.roblox) {
      try { this.wsRoblox = await this.bindEngineSocket(this.ports.roblox, "roblox"); this.bound.roblox = true; }
      catch (err) { this.log.error("core", `cannot bind ws ${this.ports.roblox}: ${err.message}`); }
    }
    if (!this.bound.local) {
      try { this.wsLocal = await this.bindEngineSocket(this.ports.local, "local"); this.bound.local = true; }
      catch (err) { this.log.error("core", `cannot bind ws ${this.ports.local}: ${err.message}`); }
    }
    if (this.bound.http && this.bound.roblox && this.bound.local) {
      this.log.info("core", `listening: http://${this.host}:${this.ports.http} · ws ${this.ports.roblox} (roblox) · ${this.ports.local} (agentscript)`);
      if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    } else if (!this.retryTimer) {
      this.retryTimer = setInterval(() => { if (!this.stopped) this.bindAll().catch(() => {}); }, 10000);
      if (this.retryTimer.unref) this.retryTimer.unref();
    }
    this.pushSnapshot();
  }

  bindHttp() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleHttp(req, res).catch((err) => {
        this.log.error("http", `${req.method} ${req.url}: ${err.message}`);
        if (!res.headersSent) this.json(res, 500, { ok: false, error: err.message });
        else res.end();
      }));
      const wss = new WebSocketServer({ noServer: true });
      server.on("upgrade", (req, socket, head) => {
        const pathname = new URL(req.url, "http://localhost").pathname;
        if (pathname !== "/ws") { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => this.onBridgeSocket(ws));
      });
      server.once("error", reject);
      server.listen(this.ports.http, this.host, () => {
        server.removeListener("error", reject);
        server.on("error", (err) => this.log.error("http", err.message));
        this.httpServer = server;
        this.wsBridge = wss;
        this.bound.http = true;
        resolve();
      });
    });
  }

  bindEngineSocket(port, engine) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.host, port });
      wss.once("error", reject);
      wss.once("listening", () => {
        wss.removeListener("error", reject);
        wss.on("error", (err) => this.log.error(`ws:${engine}`, err.message));
        wss.on("connection", (ws) => this.onEngineSocket(ws, engine));
        resolve(wss);
      });
    });
  }

  async stop() {
    this.stopped = true;
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    for (const res of this.sse) { try { res.end(); } catch { /* ignore */ } }
    this.sse.clear();
    const closeWss = (wss) => new Promise((r) => { if (!wss) return r(); for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } } wss.close(() => r()); });
    await Promise.all([closeWss(this.wsRoblox), closeWss(this.wsLocal), closeWss(this.wsBridge)]);
    await new Promise((r) => (this.httpServer ? this.httpServer.close(() => r()) : r()));
    await this.studio.stop();
    for (const entry of this.servers.values()) { if (entry.client) { try { await entry.client.stop(); } catch { /* ignore */ } } }
    this.log.info("core", "bridge stopped");
  }

  applySettings(changed) {
    if ("workspaceRoot" in changed) {
      this.workspace.setRoot(this.settings.workspaceRoot());
      this.log.info("core", `workspace: ${this.workspace.root}`);
      this.log.track("workspace", `Workspace set to ${this.workspace.root}`);
    }
    if ("fullAccess" in changed) {
      this.workspace.setFullAccess(changed.fullAccess);
      this.log.track("workspace", `FULL PC ACCESS ${changed.fullAccess ? "enabled" : "disabled"}`);
    }
    if ("mcpCommand" in changed) this.studio.setCommand(changed.mcpCommand);
    if ("logLevel" in changed) this.log.setLevel(changed.logLevel);
    if ("mcpServers" in changed) this.startCustomServers().catch(() => {});
    this.pushSnapshot();
    this.emit("settings", this.settings.all());
  }

  // ── custom MCP servers ───────────────────────────────────────────────────

  async startCustomServers() {
    const wanted = new Map(this.settings.get("mcpServers").map((s) => [s.id, s]));
    for (const [id, entry] of this.servers) {
      const cfg = wanted.get(id);
      if (!cfg || !cfg.enabled || JSON.stringify(cfg) !== JSON.stringify(entry.cfg)) {
        if (entry.client) { try { await entry.client.stop(); } catch { /* ignore */ } }
        this.servers.delete(id);
      }
    }
    for (const cfg of wanted.values()) {
      if (!cfg.enabled || this.servers.has(cfg.id)) continue;
      const entry = { cfg, client: null, error: null };
      this.servers.set(cfg.id, entry);
      this.startCustomServer(entry).catch(() => {});
    }
    this.pushSnapshot();
  }

  async startCustomServer(entry) {
    const { cfg } = entry;
    const client = new McpClient({ id: cfg.id, name: cfg.name, command: cfg.command, args: cfg.args, env: cfg.env, cwd: this.workspace.root, log: this.log, version: this.version });
    entry.client = client;
    client.on("exit", () => this.pushSnapshot());
    client.on("tools", () => { this.pushSnapshot(); this.broadcastEngine("roblox", { type: "server_changed", id: 0, ok: true, server_id: cfg.id, restarting: false }); });
    try {
      await client.start();
      entry.error = null;
      this.log.track("mcp", `MCP server "${cfg.name}" ready (${client.tools.length} tools)`);
    } catch (err) {
      entry.error = err.message;
      this.log.warn("mcp", `server ${cfg.id} failed: ${err.message}`);
    }
    this.pushSnapshot();
  }

  async restartCustomServer(id) {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`no server named "${id}"`);
    if (entry.client) { try { await entry.client.stop(); } catch { /* ignore */ } }
    await this.startCustomServer(entry);
    return this.serverList().find((s) => s.id === id);
  }

  serverList() {
    const list = [
      { id: "roblox", name: "Roblox Studio MCP", alive: this.studio.mcpAlive, studio: this.studio.lastProbe.studio, tools: this.studio.tools.length, builtin: true, kind: "studio", command: this.studio.resolveCommand().command, args: this.studio.resolveCommand().args, error: this.studio.lastError || null },
      { id: "local", name: "AgentScript workspace", alive: true, tools: AS_CATALOG.length, builtin: true, kind: "workspace", root: this.workspace.root },
    ];
    for (const cfg of this.settings.get("mcpServers")) {
      const entry = this.servers.get(cfg.id);
      list.push({
        id: cfg.id, name: cfg.name, command: cfg.command, args: cfg.args, env: cfg.env, enabled: cfg.enabled, builtin: false, kind: "custom",
        alive: !!(entry && entry.client && entry.client.alive && entry.client.ready),
        tools: entry && entry.client ? entry.client.tools.length : 0,
        error: entry ? entry.error : null,
      });
    }
    return list;
  }

  // ── tool catalogue ───────────────────────────────────────────────────────

  robloxTools() {
    const out = this.studio.tools.map((t) => ({ ...t, server: "roblox", source: "RS" }));
    for (const [id, entry] of this.servers) {
      if (!entry.client || !entry.client.ready) continue;
      for (const t of entry.client.tools) out.push({ ...t, server: id, source: "MCP" });
    }
    return out;
  }

  localTools() {
    return AS_CATALOG.map((t) => ({ ...t, server: "local", source: "AS" }));
  }

  allTools() {
    return [...this.robloxTools(), ...this.localTools()];
  }

  routeRobloxTool(name) {
    const bare = String(name || "").split("/").pop();
    if (this.studio.tools.some((t) => t.name === bare)) return { kind: "studio", name: bare };
    for (const [id, entry] of this.servers) {
      if (entry.client && entry.client.ready && entry.client.tools.some((t) => t.name === bare)) return { kind: "custom", id, name: bare, client: entry.client };
    }
    if (bare.includes(".")) {
      const [prefix, ...rest] = bare.split(".");
      const entry = this.servers.get(prefix);
      if (entry && entry.client && entry.client.ready) return { kind: "custom", id: prefix, name: rest.join("."), client: entry.client };
    }
    return { kind: "studio", name: bare }; // let Studio reject unknown names with its own message
  }

  async callRobloxTool(name, args, timeoutMs) {
    const route = this.routeRobloxTool(name);
    if (route.kind === "custom") return route.client.callTool(route.name, args, timeoutMs);
    if (!this.studio.tools.length) {
      await this.studio.ensure();
    }
    if (this.studio.tools.length && !this.studio.tools.some((t) => t.name === route.name)) {
      const err = new ToolError(`unknown Studio command '${route.name}'. Call list_commands to see the live catalogue.`, "COMMAND_NOT_FOUND");
      throw err;
    }
    return this.studio.callTool(route.name, args, timeoutMs);
  }

  async callTool(engine, name, args, timeoutMs) {
    const t0 = Date.now();
    try {
      let result;
      if (engine === "local") result = { text: await this.workspace.dispatch(String(name || "").split("/").pop(), args), images: [] };
      else result = await this.callRobloxTool(name, args, timeoutMs);
      this.log.info(`tool:${engine}`, `${name} ok (${Date.now() - t0} ms)`);
      this.log.track("tool", `${name} · ${engine === "local" ? "AgentScript" : "Studio"} · ${Date.now() - t0} ms`);
      return result;
    } catch (err) {
      this.log.warn(`tool:${engine}`, `${name} failed: ${err.message}`);
      this.log.track("error", `${name} failed - ${String(err.message).slice(0, 140)}`);
      throw err;
    }
  }

  // ── legacy engine sockets (17613 / 17615) ────────────────────────────────

  send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  broadcastEngine(engine, obj) {
    const set = engine === "local" ? this.localClients : this.robloxClients;
    for (const ws of set) this.send(ws, obj);
  }

  async introPayload(engine, id = 0) {
    if (engine === "local") {
      return { type: "connected", id, ok: true, mcp_alive: true, studio: false, local_ready: true, tools: this.localTools(), servers: this.serverList().filter((s) => s.id === "local"), workspace_root: this.workspace.root, full_access: this.workspace.fullAccess };
    }
    let error;
    try {
      await Promise.race([this.studio.ensure(), new Promise((_, rej) => setTimeout(() => rej(new Error("studio mcp start timed out")), INTRO_TIMEOUT_MS))]);
    } catch (err) {
      error = err.message;
    }
    let studio = false;
    if (this.studio.mcpAlive) {
      try { studio = await Promise.race([this.studio.probe(), new Promise((r) => setTimeout(() => r(this.studio.lastProbe.studio), 4000))]); } catch { studio = false; }
    }
    return { type: "connected", id, ok: true, mcp_alive: this.studio.mcpAlive, studio, tools: this.robloxTools(), servers: this.serverList().filter((s) => s.id !== "local"), error };
  }

  onEngineSocket(ws, engine) {
    const set = engine === "local" ? this.localClients : this.robloxClients;
    set.add(ws);
    this.log.info(`ws:${engine}`, `extension connected (${set.size} client${set.size === 1 ? "" : "s"})`);
    this.log.track("bridge", `${engine === "local" ? "AgentScript" : "Roblox"} engine linked (browser extension)`);
    this.pushSnapshot();
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return this.send(ws, { type: "error", id: 0, ok: false, errorCode: "UNKNOWN_BRIDGE_MESSAGE", error: "invalid json" }); }
      this.handleEngineMessage(ws, engine, msg).catch((err) => this.send(ws, { type: "error", id: msg.id || 0, ok: false, errorCode: "TOOL_EXECUTION_ERROR", error: err.message }));
    });
    ws.on("close", () => {
      set.delete(ws);
      this.log.info(`ws:${engine}`, `extension disconnected (${set.size} left)`);
      this.pushSnapshot();
    });
    ws.on("error", () => {});
    this.introPayload(engine).then((intro) => this.send(ws, intro)).catch(() => {});
  }

  async handleEngineMessage(ws, engine, msg) {
    const id = msg.id ?? 0;
    switch (msg.type) {
      case "ping":
        return this.send(ws, { type: "pong", id });

      case "list_tools": {
        if (engine === "local") {
          return this.send(ws, { type: "tools", id, ok: true, mcp_alive: true, studio: false, local_ready: true, tools: this.localTools(), servers: this.serverList().filter((s) => s.id === "local"), workspace_root: this.workspace.root });
        }
        let error;
        try { if (msg.refresh && this.studio.mcpAlive) await this.studio.client.refreshTools(); else await this.studio.listTools(); } catch (err) { error = err.message; }
        return this.send(ws, { type: "tools", id, ok: !error || this.robloxTools().length > 0, mcp_alive: this.studio.mcpAlive, studio: this.studio.lastProbe.studio, tools: this.robloxTools(), servers: this.serverList().filter((s) => s.id !== "local"), error });
      }

      case "studio_status": {
        if (engine === "local") return this.send(ws, { type: "studio_status", id, studio: false, studio_app: false, studio_proc: false, local_ready: true });
        let studio = this.studio.lastProbe.studio;
        if (!this.studio.busy) { try { studio = await this.studio.probe(); } catch { /* keep cached */ } }
        return this.send(ws, { type: "studio_status", id, studio, studio_app: this.studio.processSeen, studio_proc: this.studio.processSeen, mcp_alive: this.studio.mcpAlive });
      }

      case "restart_mcp": {
        if (engine === "local") return this.send(ws, { type: "mcp_status", id, ok: true, alive: true, tools: this.localTools() });
        try {
          await this.studio.restart();
          const studio = await this.studio.probe({ force: true });
          return this.send(ws, { type: "mcp_status", id, ok: true, alive: true, studio, tools: this.robloxTools() });
        } catch (err) {
          return this.send(ws, { type: "mcp_status", id, ok: false, alive: false, error: err.message });
        }
      }

      case "call_tool": {
        const name = String(msg.name || "");
        if (!name) return this.send(ws, { type: "tool_result", id, ok: false, kind: "execution", errorCode: "INVALID_ARGUMENT", error: "'name' is required" });
        const timeout = Math.min(Math.max(Number(msg.timeout) || 120000, 1000), 600000);
        try {
          const r = await this.callTool(engine, name, msg.arguments || msg.params || {}, timeout);
          return this.send(ws, { type: "tool_result", id, ok: true, text: r.text || "", images: r.images || [] });
        } catch (err) {
          return this.send(ws, { type: "tool_result", id, ok: false, kind: "execution", errorCode: errorCode(err), error: err.message });
        }
      }

      case "add_server": {
        try {
          const server = this.settings.upsertServer({ id: msg.server_id, name: msg.name || msg.server_id, command: msg.command, args: msg.args, env: msg.env, enabled: true });
          this.log.track("mcp", `MCP server "${server.name}" added from the extension`);
          return this.send(ws, { type: "server_changed", id, ok: true, server_id: server.id, restarting: false });
        } catch (err) {
          return this.send(ws, { type: "server_changed", id, ok: false, error: err.message, errorCode: "INVALID_ARGUMENT" });
        }
      }

      case "remove_server": {
        const removed = this.settings.removeServer(msg.server_id);
        return this.send(ws, { type: "server_changed", id, ok: removed, server_id: msg.server_id, restarting: false, error: removed ? undefined : `no server named "${msg.server_id}"` });
      }

      default:
        return this.send(ws, { type: "error", id, ok: false, errorCode: "UNKNOWN_BRIDGE_MESSAGE", error: `unknown message type '${msg.type}'` });
    }
  }

  // ── /ws bridge socket (payload results) ──────────────────────────────────

  onBridgeSocket(ws) {
    this.bridgeClients.add(ws);
    this.pushSnapshot();
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg && typeof msg.code === "string") {
        this.enqueuePayload({ id: msg.id, target: msg.engine || "roblox", code: msg.code, language: msg.language || "luau", meta: msg.meta || {} });
      }
    });
    ws.on("close", () => { this.bridgeClients.delete(ws); this.pushSnapshot(); });
    ws.on("error", () => {});
  }

  enqueuePayload(p) {
    const payload = { id: String(p.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`), target: p.target || "roblox", code: String(p.code || ""), language: p.language || "luau", meta: p.meta || {}, queued_at: nowIso() };
    this.robloxQueue.push(payload);
    if (this.robloxQueue.length > 200) this.robloxQueue.shift();
    this.log.track("payload", `Queued payload ${payload.id} for ${payload.target}`);
    this.pushSnapshot();
    return payload;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-OR-Client");
    res.setHeader("Access-Control-Max-Age", "600");
  }

  json(res, status, body) {
    this.cors(res);
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  readBody(req, limit = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) return resolve({});
        try { resolve(JSON.parse(text)); } catch { reject(new Error("invalid JSON body")); }
      });
      req.on("error", reject);
    });
  }

  async handleHttp(req, res) {
    const url = new URL(req.url, `http://${this.host}:${this.ports.http}`);
    const p = url.pathname;
    if (req.method === "OPTIONS") { this.cors(res); res.writeHead(204); return res.end(); }

    if (p === "/" && req.method === "GET") {
      return this.json(res, 200, { ok: true, service: "or-agent", app: "ORscript Desktop", version: this.version, ui: `http://${this.host}:${this.ports.http}/app/` });
    }
    if (p.startsWith("/api/")) return this.handleExtensionApi(req, res, url);
    if (p === "/app" ) { this.cors(res); res.writeHead(302, { Location: "/app/" }); return res.end(); }
    if (p.startsWith("/app/api/")) return this.handleAppApi(req, res, url);
    if (p.startsWith("/app/")) return this.serveStatic(res, p.slice("/app/".length) || "index.html");
    if (p === "/favicon.ico") return this.serveStatic(res, "assets/icon.png");
    return this.json(res, 404, { ok: false, error: "not found" });
  }

  async serveStatic(res, rel) {
    const clean = path.normalize(rel).replace(/^(\.\.[\\/])+/, "");
    let file = path.join(UI_DIR, clean);
    if (clean.startsWith("assets" + path.sep) || clean.startsWith("assets/")) {
      const alt = path.join(SHARED_ASSETS, clean.slice("assets/".length));
      if (!fs.existsSync(file) && fs.existsSync(alt)) file = alt;
    }
    if (!file.startsWith(UI_DIR) && !file.startsWith(SHARED_ASSETS)) return this.json(res, 403, { ok: false, error: "forbidden" });
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(data);
    } catch {
      this.json(res, 404, { ok: false, error: "not found" });
    }
  }

  // Extension-facing REST (or-core compatible).
  async handleExtensionApi(req, res, url) {
    const p = url.pathname;
    if (p === "/api/status" && req.method === "GET") return this.json(res, 200, this.extensionStatus());
    if (p === "/api/connect" && req.method === "POST") {
      const body = await this.readBody(req);
      const clientId = String(body.client_id || "anonymous");
      const engine = body.engine === "local" ? "local" : "roblox";
      this.extensionClients.set(clientId, { engine, at: Date.now() });
      let editor = false;
      if (engine === "local") editor = true;
      else if (!this.studio.busy) { try { editor = await this.studio.probe(); } catch { editor = false; } }
      this.pushSnapshot();
      return this.json(res, 200, { ok: true, bridge_registered: true, editor_connected: editor, client_id: clientId });
    }
    if (p === "/api/disconnect" && req.method === "POST") {
      const body = await this.readBody(req);
      this.extensionClients.delete(String(body.client_id || ""));
      this.pushSnapshot();
      return this.json(res, 200, { ok: true });
    }
    if (p === "/api/push" && req.method === "POST") {
      const body = await this.readBody(req);
      const code = body.code ?? (body.arguments && body.arguments.code) ?? (body.payload && body.payload.code);
      if (typeof code !== "string") return this.json(res, 400, { ok: false, error: "'code' is required" });
      const payload = this.enqueuePayload({ id: body.id, target: body.target || body.engine || "roblox", code, language: body.language, meta: body.meta });
      return this.json(res, 200, { ok: true, id: payload.id, queued: this.robloxQueue.length });
    }
    if (p === "/api/poll" && req.method === "GET") {
      for (let i = 0; i < POLL_ROUNDS; i++) {
        if (this.robloxQueue.length) { const payload = this.robloxQueue.shift(); this.pushSnapshot(); return this.json(res, 200, { ok: true, payload }); }
        if (res.destroyed || req.destroyed) return;
        await new Promise((r) => setTimeout(r, POLL_STEP_MS));
      }
      return this.json(res, 200, { ok: true, payload: null });
    }
    if (p === "/api/result" && req.method === "POST") {
      const body = await this.readBody(req);
      const result = { type: "result", id: body.id, ok: body.ok !== false, result: body.result, error: body.error, at: nowIso() };
      this.lastResult = result;
      for (const ws of this.bridgeClients) this.send(ws, result);
      this.log.track("payload", `Result for ${body.id}: ${result.ok ? "ok" : "error"}`);
      return this.json(res, 200, { ok: true, delivered: this.bridgeClients.size });
    }
    if (p === "/api/local-full" && req.method === "POST") {
      const body = await this.readBody(req);
      this.settings.update({ fullAccess: !!body.enabled });
      return this.json(res, 200, { ok: true, local_full: this.workspace.fullAccess });
    }
    return this.json(res, 404, { ok: false, error: `no route ${req.method} ${p}` });
  }

  extensionStatus() {
    return {
      ok: true,
      service: "or-agent",
      version: this.version,
      roblox_connected: this.studio.lastProbe.studio,
      roblox_bridge_connected: this.robloxClients.size > 0,
      local_bridge_connected: this.localClients.size > 0,
      local_ready: true,
      local_root: this.workspace.root,
      local_full: this.workspace.fullAccess,
      roblox_queue: this.robloxQueue.length,
      roblox_proc: this.studio.processSeen,
      mcp_alive: this.studio.mcpAlive,
      mcp_busy: this.studio.busy,
      servers: this.serverList().map((s) => ({ id: s.id, name: s.name, alive: s.alive, tools: s.tools })),
    };
  }

  // ── app (UI) API ─────────────────────────────────────────────────────────

  snapshot() {
    const tools = this.allTools();
    const studio = this.studio.status();
    const ext = [...this.extensionClients.entries()].map(([id, v]) => ({ id, engine: v.engine, at: v.at }));
    return {
      version: this.version,
      app: "ORscript Desktop",
      platform: process.platform,
      pid: process.pid,
      boot_at: new Date(this.bootAt).toISOString(),
      uptime_s: Math.round((Date.now() - this.bootAt) / 1000),
      host: this.host,
      ports: this.ports,
      bound: { ...this.bound },
      port_report: this.portReport,
      bridge: {
        roblox_clients: this.robloxClients.size,
        local_clients: this.localClients.size,
        ws_clients: this.bridgeClients.size,
        extension_clients: ext,
        linked: this.robloxClients.size + this.localClients.size > 0,
        queue: this.robloxQueue.length,
        last_result: this.lastResult,
      },
      studio,
      workspace: { root: this.workspace.root, full_access: this.workspace.fullAccess, exists: fs.existsSync(this.workspace.root) },
      tools: {
        total: tools.length,
        rs: tools.filter((t) => t.source === "RS").length,
        as: tools.filter((t) => t.source === "AS").length,
        mcp: tools.filter((t) => t.source === "MCP").length,
      },
      servers: this.serverList(),
      settings: this.settings.all(),
      data_dir: this.dataDir,
      log_file: this.log.file,
      activity: this.log.activity.slice(-80),
    };
  }

  pushSnapshot() {
    if (this.stopped) return;
    clearTimeout(this._snapDebounce);
    this._snapDebounce = setTimeout(() => {
      const snap = this.snapshot();
      this.emit("snapshot", snap);
      this.broadcastSse("snapshot", snap);
    }, 60);
    if (this._snapDebounce.unref) this._snapDebounce.unref();
  }

  broadcastSse(event, data) {
    if (!this.sse.size) return;
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sse) { try { res.write(chunk); } catch { /* ignore */ } }
  }

  async handleAppApi(req, res, url) {
    const p = url.pathname.slice("/app/api".length);
    const m = req.method;
    const body = m === "POST" || m === "PUT" || m === "DELETE" ? await this.readBody(req).catch(() => ({})) : {};

    if (p === "/snapshot" && m === "GET") return this.json(res, 200, this.snapshot());

    if (p === "/events" && m === "GET") {
      this.cors(res);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
      this.sse.add(res);
      const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 20000);
      req.on("close", () => { clearInterval(beat); this.sse.delete(res); });
      return;
    }

    if (p === "/logs" && m === "GET") {
      const limit = Number(url.searchParams.get("limit")) || 500;
      const since = Number(url.searchParams.get("since")) || 0;
      return this.json(res, 200, { ok: true, lines: this.log.recent(limit, since), file: this.log.file });
    }

    if (p === "/activity/clear" && m === "POST") { this.log.clearActivity(); return this.json(res, 200, { ok: true }); }

    if (p === "/tools" && m === "GET") return this.json(res, 200, { ok: true, tools: this.allTools() });

    if (p === "/tools/call" && m === "POST") {
      const engine = body.engine === "local" || AS_CATALOG.some((t) => t.name === body.name) ? "local" : "roblox";
      try {
        const r = await this.callTool(engine, String(body.name || ""), body.arguments || {}, Number(body.timeout) || 120000);
        return this.json(res, 200, { ok: true, engine, text: r.text, images: r.images || [] });
      } catch (err) {
        return this.json(res, 200, { ok: false, engine, errorCode: errorCode(err), error: err.message });
      }
    }

    if (p === "/studio/restart" && m === "POST") {
      try { await this.studio.restart(); const studio = await this.studio.probe({ force: true }); return this.json(res, 200, { ok: true, studio, tools: this.studio.tools.length }); }
      catch (err) { return this.json(res, 200, { ok: false, error: err.message }); }
    }
    if (p === "/studio/probe" && m === "POST") {
      try { const studio = await this.studio.probe({ force: true }); return this.json(res, 200, { ok: true, studio, ...this.studio.status() }); }
      catch (err) { return this.json(res, 200, { ok: false, error: err.message }); }
    }
    if (p === "/studio/kill" && m === "POST") return this.json(res, 200, await this.studio.killStudio());

    if (p === "/settings" && m === "GET") return this.json(res, 200, { ok: true, settings: this.settings.all(), data_dir: this.dataDir, workspace_default: require("./settings").defaultWorkspaceRoot() });
    if (p === "/settings" && m === "POST") {
      const next = this.settings.update(body || {});
      return this.json(res, 200, { ok: true, settings: next });
    }

    if (p === "/servers" && m === "GET") return this.json(res, 200, { ok: true, servers: this.serverList() });
    if (p === "/servers" && m === "POST") {
      try {
        const cfg = { ...body };
        if (typeof cfg.args === "string") cfg.args = cfg.args.match(/"([^"]*)"|'([^']*)'|(\S+)/g)?.map((s) => s.replace(/^["']|["']$/g, "")) || [];
        if (typeof cfg.env === "string") {
          const env = {};
          for (const line of cfg.env.split(/\r?\n/)) { const i = line.indexOf("="); if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
          cfg.env = env;
        }
        const server = this.settings.upsertServer(cfg);
        this.log.track("mcp", `MCP server "${server.name}" saved`);
        return this.json(res, 200, { ok: true, server, servers: this.serverList() });
      } catch (err) { return this.json(res, 400, { ok: false, error: err.message }); }
    }
    let sm = p.match(/^\/servers\/([a-z0-9_-]+)(?:\/(restart))?$/);
    if (sm && m === "DELETE") { const ok = this.settings.removeServer(sm[1]); return this.json(res, 200, { ok, servers: this.serverList() }); }
    if (sm && sm[2] === "restart" && m === "POST") {
      if (sm[1] === "roblox") { try { await this.studio.restart(); } catch (err) { return this.json(res, 200, { ok: false, error: err.message }); } return this.json(res, 200, { ok: true, servers: this.serverList() }); }
      try { await this.restartCustomServer(sm[1]); return this.json(res, 200, { ok: true, servers: this.serverList() }); }
      catch (err) { return this.json(res, 200, { ok: false, error: err.message }); }
    }

    if (p === "/fs/list" && m === "GET") {
      try {
        const rel = url.searchParams.get("path") || ".";
        const abs = this.workspace.resolvePath(rel, true);
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        const rows = [];
        for (const e of entries) {
          let size = 0, mtime = null;
          try { const st = await fsp.stat(path.join(abs, e.name)); size = st.size; mtime = st.mtime.toISOString(); } catch { /* ignore */ }
          rows.push({ name: e.name, dir: e.isDirectory(), size, mtime, path: this.workspace.display(path.join(abs, e.name)) });
        }
        rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
        return this.json(res, 200, { ok: true, path: this.workspace.display(abs), abs, root: this.workspace.root, entries: rows });
      } catch (err) { return this.json(res, 400, { ok: false, error: err.message }); }
    }
    if (p === "/fs/read" && m === "GET") {
      try {
        const abs = this.workspace.resolvePath(url.searchParams.get("path") || "", true);
        const st = await fsp.stat(abs);
        if (st.isDirectory()) return this.json(res, 400, { ok: false, error: "is a folder" });
        if (st.size > 2 * 1024 * 1024) return this.json(res, 200, { ok: true, binary: true, size: st.size, text: "", note: "file too large for the viewer" });
        const buf = await fsp.readFile(abs);
        const isBin = buf.includes(0);
        return this.json(res, 200, { ok: true, binary: isBin, size: st.size, text: isBin ? "" : buf.toString("utf8"), path: this.workspace.display(abs), mtime: st.mtime.toISOString() });
      } catch (err) { return this.json(res, 400, { ok: false, error: err.message }); }
    }
    if (p === "/fs/write" && m === "POST") {
      try { const text = await this.workspace.write_file({ path: body.path, content: String(body.content ?? "") }); this.log.track("workspace", `Saved ${body.path} from Explorer`); return this.json(res, 200, { ok: true, text }); }
      catch (err) { return this.json(res, 400, { ok: false, error: err.message }); }
    }
    if (p === "/fs/mkdir" && m === "POST") {
      try { return this.json(res, 200, { ok: true, text: await this.workspace.create_folder({ path: body.path }) }); }
      catch (err) { return this.json(res, 400, { ok: false, error: err.message }); }
    }
    if (p === "/fs/delete" && m === "POST") {
      try { return this.json(res, 200, { ok: true, text: await this.workspace.delete_path({ path: body.path }) }); }
      catch (err) { return this.json(res, 400, { ok: false, error: err.message }); }
    }

    if (p === "/terminal/run" && m === "POST") {
      try {
        const text = await this.workspace.run_command({ command: String(body.command || ""), timeout_seconds: Number(body.timeout_seconds) || 60 });
        return this.json(res, 200, { ok: true, text });
      } catch (err) { return this.json(res, 200, { ok: false, error: err.message }); }
    }

    if (p === "/open" && m === "POST") {
      const target = String(body.target || "");
      let arg;
      if (target === "workspace") arg = this.workspace.root;
      else if (target === "logs") arg = path.join(this.dataDir, "logs");
      else if (target === "data") arg = this.dataDir;
      else if (/^https?:\/\//i.test(target)) arg = target;
      else if (target) { try { arg = this.workspace.resolvePath(target, true); } catch (err) { return this.json(res, 400, { ok: false, error: err.message }); } }
      if (!arg) return this.json(res, 400, { ok: false, error: "nothing to open" });
      try { fs.mkdirSync(arg.startsWith("http") ? this.dataDir : (fs.existsSync(arg) ? arg : path.dirname(arg)), { recursive: true }); } catch { /* ignore */ }
      const prev = this.workspace.fullAccess;
      this.workspace.fullAccess = true;
      try { const text = await this.workspace.open_path({ path: arg }); return this.json(res, 200, { ok: true, text }); }
      catch (err) { return this.json(res, 200, { ok: false, error: err.message }); }
      finally { this.workspace.fullAccess = prev; }
    }

    if (p === "/skills" && m === "GET") return this.json(res, 200, { ok: true, ...(await this.readData("skills.json", { families: [] })) });
    if (p === "/templates" && m === "GET") return this.json(res, 200, { ok: true, ...(await this.readData("templates.json", { templates: [] })) });
    if (p === "/templates/export" && m === "POST") {
      const data = await this.readData("templates.json", { templates: [] });
      const tpl = data.templates.find((t) => t.id === body.id);
      if (!tpl) return this.json(res, 404, { ok: false, error: "template not found" });
      const dest = body.path || path.posix.join("templates", tpl.file);
      try { const text = await this.workspace.write_file({ path: dest, content: tpl.content }); this.log.track("template", `Exported template "${tpl.name}" to ${dest}`); return this.json(res, 200, { ok: true, text, path: dest }); }
      catch (err) { return this.json(res, 400, { ok: false, error: err.message }); }
    }

    if (p === "/ais" && m === "GET") return this.json(res, 200, { ok: true, ...(await this.readData("ais.json", { ais: [] })) });

    if (p === "/diagnostics" && m === "GET") return this.json(res, 200, { ok: true, text: this.diagnostics() });

    if (p === "/updates" && m === "GET") return this.json(res, 200, await this.checkUpdates());

    return this.json(res, 404, { ok: false, error: `no app route ${m} ${p}` });
  }

  async readData(name, fallback) {
    try { return JSON.parse(await fsp.readFile(path.join(DATA_DIR, name), "utf8")); } catch { return fallback; }
  }

  diagnostics() {
    const s = this.snapshot();
    const lines = [
      `ORscript Desktop v${s.version} (${s.platform}, node ${process.version}, pid ${s.pid})`,
      `uptime: ${s.uptime_s}s  boot: ${s.boot_at}`,
      `http: ${s.bound.http ? "listening" : "NOT BOUND"} ${s.host}:${s.ports.http}   ws roblox: ${s.bound.roblox ? "listening" : "NOT BOUND"} ${s.ports.roblox}   ws local: ${s.bound.local ? "listening" : "NOT BOUND"} ${s.ports.local}`,
      `extension: roblox clients ${s.bridge.roblox_clients}, local clients ${s.bridge.local_clients}, /ws clients ${s.bridge.ws_clients}, queue ${s.bridge.queue}`,
      `studio: process ${s.studio.studio_proc ? "running" : "closed"}, mcp ${s.studio.mcp_alive ? "alive" : "down"}, attached ${s.studio.studio ? "yes" : "no"}, tools ${s.studio.tools}`,
      `studio mcp command: ${s.studio.command} (${s.studio.command_available ? "found" : "missing"})${s.studio.last_error ? `  last error: ${s.studio.last_error}` : ""}`,
      `workspace: ${s.workspace.root} (${s.workspace.exists ? "exists" : "missing"}) full access: ${s.workspace.full_access ? "ON" : "off"}`,
      `tools: ${s.tools.total} total - RS ${s.tools.rs} / AS ${s.tools.as} / MCP ${s.tools.mcp}`,
      `servers: ${s.servers.map((x) => `${x.id}(${x.alive ? "up" : "down"}:${x.tools})`).join(", ")}`,
      `ports: ${s.port_report.map((r) => `${r.port}=${r.action}${r.owner ? `[${r.owner.name}]` : ""}`).join(" ")}`,
      `data dir: ${s.data_dir}`,
      `log file: ${s.log_file || "(none)"}`,
    ];
    return lines.join("\n");
  }

  async checkUpdates() {
    const https = require("https");
    const fetchJson = (u) => new Promise((resolve, reject) => {
      const req = https.get(u, { headers: { "user-agent": "ORscript-Desktop", accept: "application/vnd.github+json" } }, (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (data += c));
        r.on("end", () => { try { resolve({ status: r.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: r.statusCode, body: null }); } });
      });
      req.on("error", reject);
      req.setTimeout(8000, () => req.destroy(new Error("timed out")));
    });
    try {
      const rel = await fetchJson("https://api.github.com/repos/errored404user/ULTIMATEor/releases/latest");
      if (rel.status === 200 && rel.body && rel.body.tag_name) {
        const latest = String(rel.body.tag_name).replace(/^v/i, "");
        return { ok: true, current: this.version, latest, up_to_date: compareVersions(latest, this.version) <= 0, url: rel.body.html_url, published_at: rel.body.published_at, notes: String(rel.body.body || "").slice(0, 4000) };
      }
      const commits = await fetchJson("https://api.github.com/repos/errored404user/ULTIMATEor/commits?per_page=1");
      if (commits.status === 200 && Array.isArray(commits.body) && commits.body[0]) {
        const c = commits.body[0];
        return { ok: true, current: this.version, latest: null, up_to_date: true, latest_commit: { sha: c.sha.slice(0, 7), message: String(c.commit.message).split("\n")[0], date: c.commit.author.date, url: c.html_url }, url: "https://github.com/errored404user/ULTIMATEor" };
      }
      return { ok: false, current: this.version, error: `GitHub responded ${rel.status}` };
    } catch (err) {
      return { ok: false, current: this.version, error: err.message };
    }
  }
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

module.exports = { Bridge, compareVersions, PORTS };
