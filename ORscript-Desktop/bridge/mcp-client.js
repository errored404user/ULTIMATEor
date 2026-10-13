// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal, dependency-free MCP client over stdio (JSON-RPC 2.0, newline framed).
// Used for Roblox Studio's MCP helper (mcp.bat) and for user-added servers.
"use strict";

const { spawn } = require("child_process");
const { EventEmitter } = require("events");

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_CALL_TIMEOUT = 120000;
const INIT_TIMEOUT = 30000;

class McpError extends Error {
  constructor(message, kind = "rpc") {
    super(message);
    this.name = "McpError";
    this.kind = kind; // "dead" | "timeout" | "rpc" | "tool"
  }
}

function isDeadError(err) {
  const m = String((err && err.message) || err || "").toLowerCase();
  return (
    (err && err.kind === "dead") ||
    m.includes("helper exited") ||
    m.includes("stdin unavailable") ||
    m.includes("stdout unavailable") ||
    m.includes("spawn failed") ||
    m.includes("not running")
  );
}

function shellCommand(command, args) {
  // Windows batch helpers must run through cmd.exe; everything else spawns directly.
  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(command)) {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/C", command, ...args] };
  }
  return { file: command, args: [...args] };
}

class McpClient extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id || "mcp";
    this.name = options.name || this.id;
    this.command = options.command;
    this.args = Array.isArray(options.args) ? options.args : [];
    this.env = options.env || {};
    this.cwd = options.cwd || undefined;
    this.log = options.log || null;
    this.clientInfo = options.clientInfo || { name: "ORscript Desktop", version: options.version || "0.0.0" };
    this.proc = null;
    this.alive = false;
    this.ready = false;
    this.tools = [];
    this.serverInfo = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.exitInfo = null;
  }

  logLine(level, msg) {
    if (this.log && typeof this.log[level] === "function") this.log[level](`mcp:${this.id}`, msg);
  }

  async start() {
    if (this.alive) return this;
    const { file, args } = shellCommand(this.command, this.args);
    this.logLine("info", `starting ${file} ${args.join(" ")}`.trim());
    try {
      this.proc = spawn(file, args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      throw new McpError(`spawn failed: ${err.message}`, "dead");
    }
    this.alive = true;
    this.exitInfo = null;
    const proc = this.proc;
    proc.on("error", (err) => {
      this.logLine("error", `process error: ${err.message}`);
      this.handleExit(-1, `spawn failed: ${err.message}`);
    });
    proc.on("exit", (code, signal) => this.handleExit(code, signal ? `signal ${signal}` : null));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.logLine("debug", `stderr: ${text.slice(0, 600)}`);
    });
    proc.stdin.on("error", (err) => this.logLine("warn", `stdin: ${err.message}`));

    const init = await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
      INIT_TIMEOUT
    );
    this.serverInfo = (init && init.serverInfo) || null;
    this.notify("notifications/initialized", {});
    this.ready = true;
    await this.refreshTools();
    this.emit("ready", this);
    return this;
  }

  handleExit(code, reason) {
    if (!this.alive && !this.proc) return;
    this.alive = false;
    this.ready = false;
    this.exitInfo = { code, reason, at: Date.now() };
    const message = reason || `helper exited with code ${code}`;
    this.logLine("warn", message);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new McpError(`helper exited (${message})`, "dead"));
    }
    this.pending.clear();
    this.proc = null;
    this.emit("exit", this.exitInfo);
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        this.logLine("debug", `non-json stdout: ${line.slice(0, 200)}`);
        continue;
      }
      this.onMessage(msg);
    }
    if (this.buffer.length > 50 * 1024 * 1024) this.buffer = ""; // runaway protection
  }

  onMessage(msg) {
    if (msg && msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error;
        p.reject(new McpError(`${e.message || "rpc error"}${e.code !== undefined ? ` (code ${e.code})` : ""}`, "rpc"));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg && msg.method) {
      // Server-initiated request (e.g. sampling/ping): answer pings, ignore the rest.
      if (msg.method === "ping" && msg.id !== undefined) this.write({ jsonrpc: "2.0", id: msg.id, result: {} });
      else if (msg.method === "notifications/tools/list_changed") this.refreshTools().catch(() => {});
      this.emit("notification", msg);
    }
  }

  write(obj) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) throw new McpError("stdin unavailable", "dead");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  notify(method, params) {
    try { this.write({ jsonrpc: "2.0", method, params }); } catch { /* ignore */ }
  }

  request(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new McpError("helper not running", "dead"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params: params || {} });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async refreshTools() {
    const res = await this.request("tools/list", {}, 20000);
    const tools = Array.isArray(res && res.tools) ? res.tools : [];
    this.tools = tools.map((t) => ({
      name: String(t.name || ""),
      description: String(t.description || ""),
      inputSchema: t.inputSchema || t.input_schema || { type: "object", properties: {} },
    })).filter((t) => t.name);
    this.emit("tools", this.tools);
    return this.tools;
  }

  // Returns { text, images:[{mimeType,data}], isError }
  async callTool(name, args, timeoutMs = DEFAULT_CALL_TIMEOUT) {
    const res = await this.request("tools/call", { name, arguments: args && typeof args === "object" ? args : {} }, timeoutMs);
    const content = Array.isArray(res && res.content) ? res.content : [];
    const texts = [];
    const images = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block.type === "image" && block.data) images.push({ mimeType: block.mimeType || "image/png", data: block.data });
      else if (block.type === "resource" && block.resource && typeof block.resource.text === "string") texts.push(block.resource.text);
    }
    let text = texts.join("\n");
    if (!text && res && res.structuredContent) text = JSON.stringify(res.structuredContent);
    if (res && res.isError) throw new McpError(text || "tool reported an error", "tool");
    return { text, images, isError: false };
  }

  async stop() {
    const proc = this.proc;
    if (!proc) { this.alive = false; this.ready = false; return; }
    this.logLine("info", "stopping");
    try { proc.stdin.end(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      }, 1500);
      proc.once("exit", () => { clearTimeout(t); resolve(); });
      try { proc.kill(); } catch { /* ignore */ }
    });
    this.handleExit(0, "stopped");
  }
}

module.exports = { McpClient, McpError, isDeadError, PROTOCOL_VERSION };
