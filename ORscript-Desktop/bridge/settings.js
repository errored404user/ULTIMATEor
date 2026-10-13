// SPDX-License-Identifier: GPL-3.0-or-later
// Persistent app settings (JSON file inside the data directory).
// The same file is used by the Electron shell and the headless bridge CLI so
// both read identical workspace / Studio MCP / tray preferences.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const PORTS = Object.freeze({ http: 3000, roblox: 17613, local: 17615 });

const DEFAULTS = Object.freeze({
  workspaceRoot: "",          // empty = %USERPROFILE%\ORWorkspace
  fullAccess: false,          // FULL PC ACCESS for AgentScript (absolute paths, process_kill)
  mcpCommand: "",             // override for %LOCALAPPDATA%\Roblox\mcp.bat
  closeToTray: true,          // closing the window keeps the bridge alive in the tray
  startHidden: false,         // start minimized to tray
  launchAtLogin: false,
  theme: "gold",              // gold | emerald | graphite
  reduceMotion: false,
  logLevel: "info",
  autoStartStudioMcp: true,   // spawn mcp.bat on boot instead of on first request
  checkUpdates: true,
  effort: "default",          // default | fast | deep  (shown in titlebar like PlazCode)
  mcpServers: [],             // [{ id, name, command, args, env, enabled }]
});

function dataDir() {
  if (process.env.ORSCRIPT_DATA_DIR) return process.env.ORSCRIPT_DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ORscript Desktop");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "ORscript Desktop");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "orscript-desktop");
}

function defaultWorkspaceRoot() {
  return (
    process.env.OR_WORKSPACE_ROOT ||
    process.env.ROBLOXSCRIPT_WORKSPACE_ROOT ||
    path.join(os.homedir(), "ORWorkspace")
  );
}

function sanitizeServer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.server_id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 48);
  const command = String(raw.command || "").trim();
  if (!id || !command) return null;
  const args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [];
  const env = {};
  if (raw.env && typeof raw.env === "object") {
    for (const [k, v] of Object.entries(raw.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
    }
  }
  return {
    id,
    name: String(raw.name || id).slice(0, 80),
    command,
    args,
    env,
    enabled: raw.enabled !== false,
  };
}

class Settings extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dir = options.dir || dataDir();
    this.file = path.join(this.dir, "settings.json");
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object") {
        for (const key of Object.keys(DEFAULTS)) {
          if (raw[key] !== undefined) this.values[key] = raw[key];
        }
        this.values.mcpServers = (Array.isArray(raw.mcpServers) ? raw.mcpServers : []).map(sanitizeServer).filter(Boolean);
      }
    } catch {
      /* first run or unreadable file: keep defaults */
    }
    if (process.env.OR_FULL_ACCESS === "1") this.values.fullAccess = true;
    return this.values;
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      this.emit("error", err);
      return false;
    }
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values, mcpServers: this.values.mcpServers.map((s) => ({ ...s })) };
  }

  update(patch) {
    if (!patch || typeof patch !== "object") return this.all();
    const changed = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue;
      let next = value;
      if (key === "mcpServers") next = (Array.isArray(value) ? value : []).map(sanitizeServer).filter(Boolean);
      else if (typeof DEFAULTS[key] === "boolean") next = !!value;
      else if (typeof DEFAULTS[key] === "string") next = String(value == null ? "" : value).slice(0, 2000);
      if (JSON.stringify(this.values[key]) !== JSON.stringify(next)) {
        this.values[key] = next;
        changed[key] = next;
      }
    }
    if (Object.keys(changed).length) {
      this.save();
      this.emit("change", changed, this.all());
    }
    return this.all();
  }

  workspaceRoot() {
    const v = String(this.values.workspaceRoot || "").trim();
    return v || defaultWorkspaceRoot();
  }

  upsertServer(raw) {
    const server = sanitizeServer(raw);
    if (!server) throw new Error("server needs an id and a command");
    const list = this.values.mcpServers.filter((s) => s.id !== server.id);
    list.push(server);
    this.update({ mcpServers: list });
    return server;
  }

  removeServer(id) {
    const key = String(id || "").trim().toLowerCase();
    const before = this.values.mcpServers.length;
    this.update({ mcpServers: this.values.mcpServers.filter((s) => s.id !== key) });
    return this.values.mcpServers.length !== before;
  }
}

module.exports = { Settings, DEFAULTS, PORTS, dataDir, defaultWorkspaceRoot, sanitizeServer };
