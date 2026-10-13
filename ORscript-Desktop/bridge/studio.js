// SPDX-License-Identifier: GPL-3.0-or-later
// Roblox Studio runtime: owns the Studio MCP helper (mcp.bat), probes whether a
// Studio instance is attached, watches the Studio process every 5 s and can
// terminate Studio on request ("Kill Roblox Studio").
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { EventEmitter } = require("events");
const { McpClient, McpError, isDeadError } = require("./mcp-client");

const WATCH_INTERVAL = 5000;
const STUDIO_PROCESS_HINT = "robloxstudio";
const NOT_ATTACHED = [
  "unable to find an active studio instance",
  "previously active studio has disconnected",
  "no active studio",
];

function defaultMcpCommand() {
  if (process.env.OR_MCP_COMMAND) return process.env.OR_MCP_COMMAND;
  if (process.env.ROBLOXSCRIPT_MCP_COMMAND) return process.env.ROBLOXSCRIPT_MCP_COMMAND;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Roblox", "mcp.bat");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Roblox", "mcp.sh");
  }
  return path.join(os.homedir(), ".local", "share", "Roblox", "mcp.sh");
}

function splitCommand(raw) {
  // "C:\path\mcp.bat" or `node server.js --flag` -> { command, args }
  const s = String(raw || "").trim();
  if (!s) return { command: "", args: [] };
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) parts.push(m[1] ?? m[2] ?? m[3]);
  return { command: parts[0] || "", args: parts.slice(1) };
}

function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        const rows = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = line.match(/^"([^"]*)","(\d+)"/);
          if (m) rows.push({ name: m[1], pid: Number(m[2]) });
        }
        resolve(rows);
      });
      return;
    }
    execFile("ps", ["-A", "-o", "pid=,comm="], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows = [];
      for (const line of String(stdout).split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (m) rows.push({ pid: Number(m[1]), name: path.basename(m[2]) });
      }
      resolve(rows);
    });
  });
}

class StudioRuntime extends EventEmitter {
  constructor(options) {
    super();
    this.log = options.log;
    this.version = options.version || "0.0.0";
    this.commandOverride = options.command || "";
    this.client = null;
    this.starting = null;
    this.inFlight = 0;
    this.lastProbe = { studio: false, at: 0, error: null };
    this.processSeen = false;
    this.processPids = [];
    this.watchTimer = null;
    this.lastError = null;
  }

  get mcpAlive() { return !!(this.client && this.client.alive && this.client.ready); }
  get busy() { return this.inFlight > 0; }
  get tools() { return this.client ? this.client.tools : []; }

  resolveCommand() {
    return splitCommand(this.commandOverride || defaultMcpCommand());
  }

  commandAvailable() {
    const { command } = this.resolveCommand();
    if (!command) return false;
    if (/[\\/]/.test(command)) return fs.existsSync(command);
    return true; // bare executable on PATH - let spawn decide
  }

  setCommand(raw) {
    this.commandOverride = String(raw || "");
  }

  startWatcher() {
    if (this.watchTimer) return;
    const tick = async () => {
      try {
        const rows = await listProcesses();
        const matches = rows.filter((r) => r.name.toLowerCase().includes(STUDIO_PROCESS_HINT));
        const seen = matches.length > 0;
        this.processPids = matches.map((r) => r.pid);
        if (seen !== this.processSeen) {
          this.processSeen = seen;
          this.log.info("studio", seen ? `Roblox Studio process detected (${matches.length})` : "Roblox Studio process gone");
          this.log.track("studio", seen ? "Roblox Studio started" : "Roblox Studio closed");
          if (!seen) this.lastProbe = { studio: false, at: Date.now(), error: null };
          this.emit("process", seen);
        }
      } catch (err) {
        this.log.debug("studio", `watcher: ${err.message}`);
      }
    };
    tick();
    this.watchTimer = setInterval(tick, WATCH_INTERVAL);
    if (this.watchTimer.unref) this.watchTimer.unref();
  }

  stopWatcher() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  // Ensure the MCP helper is up; concurrent callers share one start attempt.
  async ensure() {
    if (this.mcpAlive) return this.client;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { command, args } = this.resolveCommand();
      if (!command) throw new McpError("Studio MCP command is not configured", "dead");
      if (/[\\/]/.test(command) && !fs.existsSync(command)) {
        throw new McpError(
          `Studio MCP helper not found at ${command}. Open Roblox Studio, enable "MCP" in File > Beta Features and restart Studio once; it installs mcp.bat.`,
          "dead"
        );
      }
      if (this.client) { try { await this.client.stop(); } catch { /* ignore */ } }
      const client = new McpClient({ id: "studio", name: "Roblox Studio MCP", command, args, log: this.log, version: this.version });
      client.on("exit", () => {
        this.lastProbe = { studio: false, at: Date.now(), error: "helper exited" };
        this.emit("mcp", false);
      });
      client.on("tools", () => this.emit("tools", client.tools));
      await client.start();
      this.client = client;
      this.lastError = null;
      this.log.info("studio", `MCP helper ready (${client.tools.length} tools)`);
      this.log.track("mcp", `Studio MCP ready - ${client.tools.length} tools`);
      this.emit("mcp", true);
      return client;
    })();
    try {
      return await this.starting;
    } catch (err) {
      this.lastError = err.message;
      this.log.warn("studio", `MCP start failed: ${err.message}`);
      this.emit("mcp", false);
      throw err;
    } finally {
      this.starting = null;
    }
  }

  async restart() {
    if (this.client) { try { await this.client.stop(); } catch { /* ignore */ } }
    this.client = null;
    this.log.track("mcp", "Restarting Studio MCP helper");
    return this.ensure();
  }

  async stop() {
    this.stopWatcher();
    if (this.client) { try { await this.client.stop(); } catch { /* ignore */ } }
    this.client = null;
  }

  // Probe = get_studio_state must not report "no active Studio".
  async probe({ force = false } = {}) {
    if (!force && this.busy) return this.lastProbe.studio; // never queue behind a long tool call
    if (!force && Date.now() - this.lastProbe.at < 1500) return this.lastProbe.studio;
    if (!this.processSeen && process.platform === "win32" && !force) {
      this.lastProbe = { studio: false, at: Date.now(), error: null };
      return false;
    }
    try {
      const client = await this.ensure();
      this.inFlight++;
      let text = "";
      try {
        const r = await client.callTool("get_studio_state", {}, 15000);
        text = (r.text || "").toLowerCase();
      } finally {
        this.inFlight--;
      }
      const attached = !NOT_ATTACHED.some((s) => text.includes(s));
      if (attached !== this.lastProbe.studio) {
        this.log.info("studio", attached ? "Studio attached to MCP" : "Studio not attached to MCP");
        this.log.track("studio", attached ? "Roblox Studio connected" : "Roblox Studio offline");
      }
      this.lastProbe = { studio: attached, at: Date.now(), error: null };
      this.emit("studio", attached);
      return attached;
    } catch (err) {
      const text = String(err.message || err).toLowerCase();
      // A tool error that itself says "no active Studio" is a clean negative.
      const attached = false;
      if (this.lastProbe.studio !== attached) this.emit("studio", attached);
      this.lastProbe = { studio: attached, at: Date.now(), error: NOT_ATTACHED.some((s) => text.includes(s)) ? null : err.message };
      return attached;
    }
  }

  async listTools() {
    const client = await this.ensure();
    if (!client.tools.length) await client.refreshTools();
    return client.tools;
  }

  // Tool call with the same "dead helper -> reset + one retry" policy as or-core.
  async callTool(name, args, timeoutMs) {
    let attempt = 0;
    for (;;) {
      attempt++;
      let client;
      try {
        client = await this.ensure();
      } catch (err) {
        throw new McpError(err.message, "dead");
      }
      this.inFlight++;
      try {
        const result = await client.callTool(name, args, timeoutMs);
        return result;
      } catch (err) {
        if (isDeadError(err) && attempt === 1) {
          this.log.warn("studio", `helper died during ${name}; restarting once`);
          this.client = null;
          continue;
        }
        throw err;
      } finally {
        this.inFlight--;
      }
    }
  }

  status() {
    return {
      mcp_alive: this.mcpAlive,
      mcp_busy: this.busy,
      studio: this.lastProbe.studio,
      studio_proc: this.processSeen,
      studio_pids: this.processPids,
      tools: this.tools.length,
      command: this.resolveCommand().command,
      command_available: this.commandAvailable(),
      last_error: this.lastError || this.lastProbe.error || null,
      probed_at: this.lastProbe.at || null,
    };
  }

  // Terminates every Roblox Studio process (sidebar "Kill Roblox Studio").
  async killStudio() {
    const rows = await listProcesses();
    const targets = rows.filter((r) => r.name.toLowerCase().includes(STUDIO_PROCESS_HINT));
    if (!targets.length) return { ok: true, killed: 0, message: "Roblox Studio is not running." };
    let killed = 0;
    for (const t of targets) {
      const ok = await new Promise((resolve) => {
        if (process.platform === "win32") {
          execFile("taskkill", ["/PID", String(t.pid), "/T", "/F"], { windowsHide: true }, (err) => resolve(!err));
        } else {
          try { process.kill(t.pid, "SIGKILL"); resolve(true); } catch { resolve(false); }
        }
      });
      if (ok) killed++;
    }
    this.log.warn("studio", `killed ${killed}/${targets.length} Studio process(es)`);
    this.log.track("studio", `Killed Roblox Studio (${killed} process${killed === 1 ? "" : "es"})`);
    this.lastProbe = { studio: false, at: Date.now(), error: null };
    this.emit("studio", false);
    return { ok: killed > 0, killed, total: targets.length, message: `Terminated ${killed} of ${targets.length} Studio process(es).` };
  }
}

module.exports = { StudioRuntime, defaultMcpCommand, splitCommand, listProcesses };
