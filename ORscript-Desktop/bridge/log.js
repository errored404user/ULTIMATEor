// SPDX-License-Identifier: GPL-3.0-or-later
// Structured logger shared by the bridge, the Studio runtime and the UI.
// Keeps an in-memory ring (served to the Terminal page), appends to
// <dataDir>/logs/agent.log with size rotation and emits "line" events for
// live subscribers (SSE).
"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_LIMIT = 2000;
const ACTIVITY_LIMIT = 300;
const ROTATE_BYTES = 5 * 1024 * 1024;

class Logger extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(100);
    this.level = LEVELS[options.level] || LEVELS.info;
    this.ring = [];
    this.activity = [];
    this.seq = 0;
    this.dir = options.dir || null;
    this.file = this.dir ? path.join(this.dir, "agent.log") : null;
    this.echo = options.echo !== false;
    if (this.dir) {
      try { fs.mkdirSync(this.dir, { recursive: true }); } catch { this.file = null; }
    }
  }

  setLevel(level) {
    if (LEVELS[level]) this.level = LEVELS[level];
  }

  log(level, source, message, extra) {
    const weight = LEVELS[level] || LEVELS.info;
    const entry = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      level,
      source: String(source || "core"),
      message: String(message == null ? "" : message),
    };
    if (extra && typeof extra === "object") entry.extra = extra;
    this.ring.push(entry);
    if (this.ring.length > RING_LIMIT) this.ring.splice(0, this.ring.length - RING_LIMIT);
    if (weight >= this.level) {
      const line = `${entry.ts} [${level.toUpperCase().padEnd(5)}] ${entry.source}: ${entry.message}`;
      if (this.echo) {
        if (level === "error" || level === "warn") process.stderr.write(line + "\n");
        else process.stdout.write(line + "\n");
      }
      this.appendFile(line);
    }
    this.emit("line", entry);
    return entry;
  }

  debug(source, message, extra) { return this.log("debug", source, message, extra); }
  info(source, message, extra) { return this.log("info", source, message, extra); }
  warn(source, message, extra) { return this.log("warn", source, message, extra); }
  error(source, message, extra) { return this.log("error", source, message, extra); }

  // Human-facing event stream shown on the Home page ("Recent activity").
  track(kind, text, meta) {
    const entry = { seq: ++this.seq, ts: new Date().toISOString(), kind: String(kind || "info"), text: String(text || "") };
    if (meta && typeof meta === "object") entry.meta = meta;
    this.activity.push(entry);
    if (this.activity.length > ACTIVITY_LIMIT) this.activity.splice(0, this.activity.length - ACTIVITY_LIMIT);
    this.emit("activity", entry);
    return entry;
  }

  clearActivity() {
    this.activity = [];
    this.emit("activity-cleared");
  }

  recent(limit = 500, sinceSeq = 0) {
    const rows = sinceSeq > 0 ? this.ring.filter((r) => r.seq > sinceSeq) : this.ring;
    return rows.slice(-Math.max(1, Math.min(limit, RING_LIMIT)));
  }

  appendFile(line) {
    if (!this.file) return;
    try {
      let st = null;
      try { st = fs.statSync(this.file); } catch { st = null; }
      if (st && st.size > ROTATE_BYTES) {
        const rotated = this.file.replace(/\.log$/, "") + ".1.log";
        try { fs.rmSync(rotated, { force: true }); } catch { /* ignore */ }
        try { fs.renameSync(this.file, rotated); } catch { /* ignore */ }
      }
      fs.appendFileSync(this.file, line + "\n");
    } catch {
      /* logging must never throw */
    }
  }
}

module.exports = { Logger, LEVELS };
