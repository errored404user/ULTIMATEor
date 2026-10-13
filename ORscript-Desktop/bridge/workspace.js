// SPDX-License-Identifier: GPL-3.0-or-later
// AgentScript workspace: 18 native tools over a sandboxed project folder.
// Faithful port of or-core's workspace.rs (same tool names, argument shapes
// and output formats, so the ORscript extension needs zero changes).
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, execFile } = require("child_process");

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 40000;
const MAX_RUN_OUTPUT = 8000;
const DEFAULT_RUN_TIMEOUT = 60;
const MAX_RUN_TIMEOUT = 600;
const MAX_GREP_RESULTS = 100;
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 8;
const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 500;
const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".idea", ".vscode", "dist", "build", ".next", "coverage"]);

class ToolError extends Error {
  constructor(message, code = "TOOL_EXECUTION_ERROR") {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

const humanSize = (n) => {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[u]}`;
};
const clip = (s, max) => (s.length > max ? s.slice(0, max) + `\n... [output clipped at ${max} chars]` : s);
const countLines = (s) => (s.length ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);
const toPosix = (p) => p.split(path.sep).join("/");

// Lenient coercion: AIs frequently send "true" / "12" strings.
function argStr(args, key, required = true) {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`'${key}' is required`, "INVALID_ARGUMENT");
    return "";
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function argInt(args, key, dflt) {
  const v = args[key];
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}
function argBool(args, key, dflt = false) {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off", ""].includes(s)) return false;
  return dflt;
}

function globToRegExp(pattern) {
  let p = toPosix(String(pattern || "").trim()).replace(/^\.\//, "");
  if (!p) p = "**/*";
  if (!p.includes("/") && !p.startsWith("**")) p = "**/" + p; // "*.lua" matches at any depth
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$+.()|{}[]".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`, "i");
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) suspicious++;
  }
  return n > 0 && suspicious / n > 0.3;
}

class Workspace {
  constructor(options = {}) {
    this.log = options.log || null;
    this.fullAccess = !!options.fullAccess;
    this.setRoot(options.root || path.join(os.homedir(), "ORWorkspace"));
  }

  setRoot(root) {
    const abs = path.resolve(String(root || "").trim() || path.join(os.homedir(), "ORWorkspace"));
    try { fs.mkdirSync(abs, { recursive: true }); } catch { /* reported by workspace_info */ }
    let canon = abs;
    try { canon = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs); } catch { /* keep abs */ }
    this.root = abs;
    this.canonRoot = canon;
    return this.root;
  }

  setFullAccess(on) { this.fullAccess = !!on; }

  rootDisplay() { return this.root; }

  // Resolve a user path inside the sandbox. In FULL mode absolute paths are allowed.
  resolvePath(rel, mustExist = false) {
    let raw = String(rel == null ? "" : rel).trim();
    if (raw === "" || raw === "." || raw === "./") raw = ".";
    const absolute = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
    let candidate;
    if (absolute) {
      if (!this.fullAccess) {
        throw new ToolError(`absolute paths are only allowed in FULL PC ACCESS mode: '${raw}' (use a workspace-relative path)`, "INVALID_ARGUMENT");
      }
      candidate = path.resolve(raw);
    } else {
      candidate = path.resolve(this.canonRoot, raw);
      // Canonicalize the deepest existing ancestor so symlink tricks cannot escape.
      let probe = candidate;
      const missing = [];
      while (!fs.existsSync(probe)) {
        missing.unshift(path.basename(probe));
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      let real = probe;
      try { real = fs.realpathSync.native ? fs.realpathSync.native(probe) : fs.realpathSync(probe); } catch { /* ignore */ }
      candidate = path.join(real, ...missing);
      const relative = path.relative(this.canonRoot, candidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new ToolError(`path escapes the workspace: '${raw}'`, "INVALID_ARGUMENT");
      }
    }
    if (mustExist && !fs.existsSync(candidate)) {
      throw new ToolError(`'${this.display(candidate)}' does not exist`, "INVALID_ARGUMENT");
    }
    return candidate;
  }

  display(abs) {
    const rel = path.relative(this.canonRoot, abs);
    if (!rel) return ".";
    if (rel.startsWith("..") || path.isAbsolute(rel)) return abs;
    return toPosix(rel);
  }

  async *walk(dir, relBase = "", depth = 0, maxDepth = Infinity) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        yield { rel, abs, dir: true, depth };
        if (depth + 1 < maxDepth) yield* this.walk(abs, rel, depth + 1, maxDepth);
      } else if (e.isFile()) {
        yield { rel, abs, dir: false, depth };
      }
    }
  }

  // ── tools ────────────────────────────────────────────────────────────────

  async workspace_info() {
    let files = 0, folders = 0, bytes = 0;
    const top = [];
    try {
      const entries = await fsp.readdir(this.canonRoot, { withFileTypes: true });
      for (const e of entries) top.push(e.isDirectory() ? `${e.name}/` : e.name);
    } catch (err) {
      throw new ToolError(`cannot read workspace root ${this.root}: ${err.message}`);
    }
    for await (const item of this.walk(this.canonRoot, "", 0, 12)) {
      if (item.dir) folders++;
      else {
        files++;
        try { bytes += (await fsp.stat(item.abs)).size; } catch { /* ignore */ }
      }
    }
    top.sort();
    let out = `Workspace root: ${this.root}\nFULL PC ACCESS: ${this.fullAccess ? "ON" : "off (workspace sandbox)"}\nFiles: ${files}  Folders: ${folders}  Size: ${humanSize(bytes)}\nTop-level entries (${top.length}):\n`;
    for (const name of top.slice(0, 100)) out += `  ${name}\n`;
    if (top.length > 100) out += `  ... and ${top.length - 100} more (use list_directory)`;
    if (!top.length) out += "  (empty - this folder is yours to fill)";
    return out.trimEnd();
  }

  async list_directory(args) {
    const p = this.resolvePath(args.path || ".", true);
    const st = await fsp.stat(p);
    if (!st.isDirectory()) throw new ToolError(`'${this.display(p)}' is a file, not a folder`);
    const entries = await fsp.readdir(p, { withFileTypes: true });
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    if (!entries.length) return `${this.display(p)}/ is empty.`;
    const lines = [];
    for (const e of entries.slice(0, 500)) {
      if (e.isDirectory()) {
        let n = 0;
        try { n = (await fsp.readdir(path.join(p, e.name))).length; } catch { /* ignore */ }
        lines.push(`  [dir ] ${e.name}/ (${n} items)`);
      } else {
        let size = 0;
        try { size = (await fsp.stat(path.join(p, e.name))).size; } catch { /* ignore */ }
        lines.push(`  [file] ${e.name} (${humanSize(size)})`);
      }
    }
    if (entries.length > 500) lines.push(`  ... and ${entries.length - 500} more`);
    return `${this.display(p)}/:\n${lines.join("\n")}`;
  }

  async tree(args) {
    const p = this.resolvePath(args.path || ".", true);
    const depth = Math.min(Math.max(argInt(args, "depth", DEFAULT_TREE_DEPTH), 1), MAX_TREE_DEPTH);
    const lines = [`${this.display(p)}/`];
    let count = 0;
    for await (const item of this.walk(p, "", 0, depth)) {
      lines.push(`${"  ".repeat(item.depth + 1)}${path.basename(item.rel)}${item.dir ? "/" : ""}`);
      if (++count >= 4000) { lines.push("  ... (tree truncated at 4000 entries)"); break; }
    }
    return clip(lines.join("\n"), 30000);
  }

  async read_file(args) {
    const p = this.resolvePath(argStr(args, "path"), true);
    const st = await fsp.stat(p);
    if (st.isDirectory()) throw new ToolError(`'${this.display(p)}' is a folder - use list_directory`);
    if (st.size > MAX_READ_BYTES) {
      throw new ToolError(`'${this.display(p)}' is ${humanSize(st.size)} - over the ${humanSize(MAX_READ_BYTES)} read limit. Use grep_files or run_command to inspect parts of it.`);
    }
    const buf = await fsp.readFile(p);
    if (looksBinary(buf)) return `${this.display(p)} looks like a BINARY file (${humanSize(st.size)}); its content is not shown as text.`;
    const text = buf.toString("utf8");
    const all = text.split(/\r?\n/);
    if (all.length && all[all.length - 1] === "" && text.endsWith("\n")) all.pop();
    const total = all.length;
    const start = Math.max(argInt(args, "offset", 1), 1);
    const limit = Math.max(argInt(args, "limit", 2000), 1);
    const header = `${this.display(p)}  (${total} line${total !== 1 ? "s" : ""}, ${humanSize(st.size)})`;
    if (start > total) return `${header}\n(no lines in range ${start}-${start + limit - 1})`;
    const chunk = all.slice(start - 1, start - 1 + limit).map((ln, i) => `${String(start + i).padStart(5)} | ${ln}`);
    const end = start - 1 + chunk.length;
    const footer = end < total ? `\n... lines ${end + 1}-${total} continue (use offset=${end + 1})` : "";
    return clip(`${header}\n${chunk.join("\n")}${footer}`, MAX_TEXT_CHARS);
  }

  async write_file(args) {
    const p = this.resolvePath(argStr(args, "path"));
    const content = argStr(args, "content", false);
    if (fs.existsSync(p) && (await fsp.stat(p)).isDirectory()) throw new ToolError(`'${this.display(p)}' is a folder - cannot overwrite it with a file`);
    const existed = fs.existsSync(p);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content, "utf8");
    return `${existed ? "Overwrote" : "Created"} ${this.display(p)} (${content.length} chars, ~${countLines(content)} lines).`;
  }

  async edit_file(args) {
    const p = this.resolvePath(argStr(args, "path"), true);
    const oldStr = argStr(args, "old_string");
    const newStr = argStr(args, "new_string", false);
    const replaceAll = argBool(args, "replace_all", false);
    const st = await fsp.stat(p);
    if (st.isDirectory()) throw new ToolError(`'${this.display(p)}' is a folder`);
    if (st.size > MAX_READ_BYTES) throw new ToolError(`'${this.display(p)}' is too large to edit (${humanSize(st.size)})`);
    const original = await fsp.readFile(p, "utf8");
    const crlf = original.includes("\r\n");
    const text = crlf ? original.replace(/\r\n/g, "\n") : original;
    const needle = oldStr.replace(/\r\n/g, "\n");
    const replacement = newStr.replace(/\r\n/g, "\n");
    const occurrences = text.split(needle).length - 1;
    if (occurrences === 0) {
      // Near-miss hint: same text with trimmed line ends.
      const norm = (s) => s.split("\n").map((l) => l.trimEnd()).join("\n");
      const hint = norm(text).includes(norm(needle))
        ? " A near match exists that differs only in trailing whitespace - re-read the file and copy the exact lines."
        : " Read the file first and copy the exact text (whitespace included).";
      throw new ToolError(`old_string not found in ${this.display(p)} (searched verbatim).${hint}`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new ToolError(`old_string matches ${occurrences} places in ${this.display(p)}; include more surrounding lines to make it unique, or pass replace_all:true.`);
    }
    let updated;
    if (replaceAll) updated = text.split(needle).join(replacement);
    else {
      const idx = text.indexOf(needle);
      updated = text.slice(0, idx) + replacement + text.slice(idx + needle.length);
    }
    await fsp.writeFile(p, crlf ? updated.replace(/\n/g, "\r\n") : updated, "utf8");
    const where = replaceAll ? `all ${occurrences} occurrences` : "1 occurrence";
    return `Edited ${this.display(p)}: replaced ${where} of old_string (${oldStr.length} chars -> ${newStr.length} chars).`;
  }

  async create_folder(args) {
    const p = this.resolvePath(argStr(args, "path"));
    if (fs.existsSync(p) && !(await fsp.stat(p)).isDirectory()) throw new ToolError(`'${this.display(p)}' exists as a FILE - cannot create a folder with that name`);
    await fsp.mkdir(p, { recursive: true });
    return `Folder ready: ${this.display(p)}/`;
  }

  async delete_path(args) {
    const p = this.resolvePath(argStr(args, "path"), true);
    if (p === this.canonRoot) throw new ToolError("refusing to delete the workspace root itself", "INVALID_ARGUMENT");
    const display = this.display(p);
    const st = await fsp.stat(p);
    if (st.isDirectory()) {
      let files = 0;
      for await (const item of this.walk(p, "", 0, 64)) if (!item.dir) files++;
      await fsp.rm(p, { recursive: true, force: true });
      return `Deleted folder ${display}/ (${files} files removed).`;
    }
    await fsp.rm(p, { force: true });
    return `Deleted file ${display}.`;
  }

  async move_path(args) {
    const src = this.resolvePath(argStr(args, "source"), true);
    let dst = this.resolvePath(argStr(args, "destination"));
    if (fs.existsSync(dst) && (await fsp.stat(dst)).isDirectory()) dst = path.join(dst, path.basename(src));
    if (fs.existsSync(dst)) throw new ToolError(`destination '${this.display(dst)}' already exists`);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    try {
      await fsp.rename(src, dst);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      await fsp.cp(src, dst, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    }
    return `Moved ${this.display(src)} -> ${this.display(dst)}.`;
  }

  async search_files(args) {
    const pattern = argStr(args, "pattern");
    const re = globToRegExp(pattern);
    const matches = [];
    let truncated = false;
    for await (const item of this.walk(this.canonRoot, "", 0, 32)) {
      if (re.test(item.rel)) {
        matches.push(item.dir ? `${item.rel}/` : item.rel);
        if (matches.length >= MAX_SEARCH_RESULTS) { truncated = true; break; }
      }
    }
    if (!matches.length) return `No paths match "${pattern}".`;
    const tail = truncated ? `\n... (stopped at ${MAX_SEARCH_RESULTS} results)` : "";
    return `Paths matching "${pattern}" (${matches.length}):\n${matches.join("\n")}${tail}`;
  }

  async grep_files(args) {
    const query = argStr(args, "query");
    const include = argStr(args, "include", false) || "**/*";
    const regexMode = argBool(args, "regex", false);
    const ignoreCase = argBool(args, "ignore_case", true);
    const includeRe = globToRegExp(include);
    let matcher;
    if (regexMode) {
      try { matcher = new RegExp(query, ignoreCase ? "i" : ""); } catch (err) { throw new ToolError(`invalid regex: ${err.message}`, "INVALID_ARGUMENT"); }
    } else {
      const q = ignoreCase ? query.toLowerCase() : query;
      matcher = { test: (line) => (ignoreCase ? line.toLowerCase() : line).includes(q) };
    }
    const hits = [];
    let scanned = 0;
    let truncated = false;
    outer: for await (const item of this.walk(this.canonRoot, "", 0, 32)) {
      if (item.dir || !includeRe.test(item.rel)) continue;
      let buf;
      try {
        const st = await fsp.stat(item.abs);
        if (st.size > MAX_READ_BYTES) continue;
        buf = await fsp.readFile(item.abs);
      } catch { continue; }
      if (looksBinary(buf)) continue;
      scanned++;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i])) {
          const content = lines[i].length > 240 ? lines[i].slice(0, 240) + "..." : lines[i];
          hits.push(`${item.rel}:${i + 1}: ${content.trim()}`);
          if (hits.length >= MAX_GREP_RESULTS) { truncated = true; break outer; }
        }
      }
    }
    const kind = regexMode ? "regex" : "text";
    if (!hits.length) return `No matches for ${kind} "${query}" (scanned ${scanned} files matching "${include}").`;
    const tail = truncated ? `\n... (stopped at ${MAX_GREP_RESULTS} results - narrow with include or a longer query)` : "";
    return `Matches for "${query}" (${hits.length}, scanned ${scanned} files):\n${hits.join("\n")}${tail}`;
  }

  runShell(command, cwd, timeoutSecs) {
    return new Promise((resolve) => {
      const isWin = process.platform === "win32";
      const file = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
      const argv = isWin ? ["/D", "/S", "/C", command] : ["-c", command];
      let child;
      try {
        child = spawn(file, argv, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsVerbatimArguments: isWin });
      } catch (err) {
        return resolve({ spawnError: err });
      }
      let stdout = "", stderr = "", done = false;
      const cap = MAX_RUN_OUTPUT * 4;
      child.stdout.on("data", (d) => { if (stdout.length < cap) stdout += d.toString(); });
      child.stderr.on("data", (d) => { if (stderr.length < cap) stderr += d.toString(); });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          if (isWin) execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
          else child.kill("SIGKILL");
        } catch { /* ignore */ }
        resolve({ timeout: true, stdout, stderr });
      }, timeoutSecs * 1000);
      child.on("error", (err) => { if (!done) { done = true; clearTimeout(timer); resolve({ spawnError: err }); } });
      child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout, stderr }); } });
    });
  }

  async run_command(args) {
    const command = argStr(args, "command").trim();
    if (!command) throw new ToolError("'command' is required, e.g. \"python main.py\" or \"npm install\"", "INVALID_ARGUMENT");
    const timeout = Math.min(Math.max(argInt(args, "timeout_seconds", DEFAULT_RUN_TIMEOUT), 1), MAX_RUN_TIMEOUT);
    const t0 = Date.now();
    if (this.log) this.log.info("agentscript", `$ ${command}`);
    const out = await this.runShell(command, this.canonRoot, timeout);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (out.spawnError) throw new ToolError(`could not run command: ${out.spawnError.message}`);
    if (out.timeout) {
      return `Command TIMED OUT after ${timeout}s: ${command}\nIt may still have had partial effects. For long-running servers/tests, run them differently (background job, shorter test subset) instead of blocking.`;
    }
    let stdout = out.stdout.trim();
    let stderr = out.stderr.trim();
    if (stdout.length > MAX_RUN_OUTPUT) stdout = stdout.slice(0, MAX_RUN_OUTPUT) + `\n... [stdout truncated at ${MAX_RUN_OUTPUT} chars]`;
    if (stderr.length > MAX_RUN_OUTPUT) stderr = stderr.slice(0, MAX_RUN_OUTPUT) + `\n... [stderr truncated at ${MAX_RUN_OUTPUT} chars]`;
    const parts = [`$ ${command}`, `(ran in the workspace root, exit code ${out.code}, ${elapsed}s)`];
    if (stdout) parts.push("--- stdout ---", stdout);
    if (stderr) parts.push("--- stderr ---", stderr);
    if (out.code !== 0 && !stderr) parts.push("(non-zero exit code with empty stderr - check stdout above)");
    return clip(parts.join("\n"), MAX_TEXT_CHARS);
  }

  async file_info(args) {
    const p = this.resolvePath(argStr(args, "path"), true);
    const st = await fsp.stat(p);
    const kind = st.isDirectory() ? "folder" : "file";
    let readonly = false;
    try { await fsp.access(p, fs.constants.W_OK); } catch { readonly = true; }
    return `${this.display(p)} (${kind})\nsize: ${humanSize(st.size)}\nmodified: ${st.mtime.toISOString()}\ncreated: ${st.birthtime.toISOString()}\nreadonly: ${readonly}`;
  }

  async env_info() {
    const total = os.totalmem();
    const free = os.freemem();
    const user = process.env.USERNAME || process.env.USER || (() => { try { return os.userInfo().username; } catch { return "unknown"; } })();
    return `Host: ${os.hostname()}\nOS: ${os.type()} ${os.release()} (${process.platform})\nArch: ${os.arch()}\nCPUs: ${os.cpus().length}\nMemory: ${humanSize(total)} total, ${humanSize(free)} available\nUser: ${user}\nNode: ${process.version}\nWorkspace root: ${this.root}\nFULL PC ACCESS: ${this.fullAccess ? "ON" : "off (workspace sandbox)"}`;
  }

  listProcessesDetailed() {
    return new Promise((resolve) => {
      if (process.platform === "win32") {
        execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve([]);
          const rows = [];
          for (const line of String(stdout).split(/\r?\n/)) {
            const m = line.match(/^"([^"]*)","(\d+)","[^"]*","[^"]*","([^"]*)"/);
            if (m) rows.push({ name: m[1], pid: Number(m[2]), mem: parseInt(m[3].replace(/[^\d]/g, ""), 10) * 1024 || 0 });
          }
          resolve(rows);
        });
        return;
      }
      execFile("ps", ["-A", "-o", "pid=,rss=,comm="], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        const rows = [];
        for (const line of String(stdout).split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
          if (m) rows.push({ pid: Number(m[1]), mem: Number(m[2]) * 1024, name: path.basename(m[3]) });
        }
        resolve(rows);
      });
    });
  }

  async process_list(args) {
    const limit = Math.min(Math.max(argInt(args, "limit", 40), 1), 300);
    const rows = await this.listProcessesDetailed();
    rows.sort((a, b) => b.mem - a.mem);
    let out = `Processes (top ${Math.min(limit, rows.length)} of ${rows.length} by memory):\n  PID     MEM       NAME`;
    for (const r of rows.slice(0, limit)) out += `\n  ${String(r.pid).padEnd(7)} ${humanSize(r.mem).padEnd(9)} ${r.name}`;
    return out;
  }

  async process_kill(args) {
    if (!this.fullAccess) throw new ToolError("process_kill requires FULL PC ACCESS mode (enable it in ORscript Desktop > Settings > Execution).", "INVALID_ARGUMENT");
    const pid = argInt(args, "pid", 0);
    if (!pid || pid <= 0) throw new ToolError("'pid' must be a positive integer", "INVALID_ARGUMENT");
    if (pid === process.pid || pid === process.ppid) throw new ToolError("refusing to kill the ORscript bridge itself", "INVALID_ARGUMENT");
    const ok = await new Promise((resolve) => {
      if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => resolve(!err));
      else { try { process.kill(pid, "SIGKILL"); resolve(true); } catch { resolve(false); } }
    });
    if (!ok) throw new ToolError(`could not kill process ${pid} (not found or access denied)`);
    return `Killed process ${pid}.`;
  }

  async open_path(args) {
    const raw = argStr(args, "path");
    let target;
    if (/^https?:\/\//i.test(raw)) target = raw;
    else target = this.resolvePath(raw, true);
    const ok = await new Promise((resolve) => {
      let file, argv;
      if (process.platform === "win32") { file = process.env.ComSpec || "cmd.exe"; argv = ["/C", "start", "", target]; }
      else if (process.platform === "darwin") { file = "open"; argv = [target]; }
      else { file = "xdg-open"; argv = [target]; }
      execFile(file, argv, { windowsHide: true }, (err) => resolve(!err));
    });
    if (!ok) throw new ToolError(`could not open '${target}'`);
    return `Opened ${target} with the default application.`;
  }

  async download_file(args) {
    const url = argStr(args, "url");
    if (!/^https?:\/\//i.test(url)) throw new ToolError("'url' must start with http:// or https://", "INVALID_ARGUMENT");
    const dest = this.resolvePath(argStr(args, "path"));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const t0 = Date.now();
    const bytes = await new Promise((resolve, reject) => {
      let redirects = 0;
      const get = (u) => {
        const mod = u.startsWith("https") ? https : http;
        const req = mod.get(u, { headers: { "user-agent": "ORscript-Desktop" } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
            redirects++;
            res.resume();
            return get(new URL(res.headers.location, u).toString());
          }
          if (res.statusCode !== 200) { res.resume(); return reject(new ToolError(`HTTP ${res.statusCode} from ${url}`)); }
          const len = Number(res.headers["content-length"] || 0);
          if (len > DOWNLOAD_MAX_BYTES) { res.resume(); return reject(new ToolError(`file is ${humanSize(len)} - over the ${humanSize(DOWNLOAD_MAX_BYTES)} download cap`)); }
          let n = 0;
          const out = fs.createWriteStream(dest);
          res.on("data", (chunk) => {
            n += chunk.length;
            if (n > DOWNLOAD_MAX_BYTES) {
              res.destroy();
              out.destroy();
              fs.rm(dest, { force: true }, () => {});
              reject(new ToolError(`download exceeded the ${humanSize(DOWNLOAD_MAX_BYTES)} cap mid-stream; aborted`));
            }
          });
          res.pipe(out);
          out.on("finish", () => resolve(n));
          out.on("error", reject);
          res.on("error", reject);
        });
        req.on("error", (err) => reject(new ToolError(`download failed: ${err.message}`)));
        req.setTimeout(60000, () => req.destroy(new Error("timed out")));
      };
      get(url);
    });
    return `Downloaded ${humanSize(bytes)} to ${this.display(dest)} in ${((Date.now() - t0) / 1000).toFixed(1)}s.`;
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  async dispatch(name, rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
    const fn = TOOL_NAMES.includes(name) ? this[name] : null;
    if (!fn) {
      throw new ToolError(
        `unknown tool '${name}'. Available AgentScript tools: ${TOOL_NAMES.join(", ")} (process_kill needs FULL mode). Call list_commands for full parameter details.`,
        "COMMAND_NOT_FOUND"
      );
    }
    try {
      return await fn.call(this, args);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(err && err.message ? err.message : String(err));
    }
  }
}

const schema = (props, req = []) => ({ type: "object", properties: props, required: req });
const S = { type: "string" };
const I = { type: "integer" };
const B = { type: "boolean" };

const CATALOG = Object.freeze([
  { name: "workspace_info", description: "Overview of the connected project folder: absolute root path, file/folder counts, total size and top-level entries.", inputSchema: schema({}) },
  { name: "list_directory", description: "List one folder's entries with types and sizes.", inputSchema: schema({ path: S }) },
  { name: "tree", description: "Recursive directory tree. Generated folders (.git, node_modules, __pycache__, dist...) are skipped.", inputSchema: schema({ path: S, depth: I }) },
  { name: "read_file", description: "Read a text file. Returns numbered lines as 'LINE | content'. Always read before editing so your old_string matches byte-for-byte.", inputSchema: schema({ path: S, offset: I, limit: I }, ["path"]) },
  { name: "write_file", description: "Create a file or OVERWRITE an existing one with complete new content. Parent folders are created automatically. Prefer edit_file for partial changes.", inputSchema: schema({ path: S, content: S }, ["path", "content"]) },
  { name: "edit_file", description: "Exact-match string replacement inside a file. Replaces the FIRST match, or every match with replace_all:true. Fails loudly when old_string is missing or ambiguous.", inputSchema: schema({ path: S, old_string: S, new_string: S, replace_all: B }, ["path", "old_string", "new_string"]) },
  { name: "create_folder", description: "Create a folder (and missing parents).", inputSchema: schema({ path: S }, ["path"]) },
  { name: "delete_path", description: "Permanently DELETE a file or folder (folders recursive). Confirm scope with the user before deleting anything broad.", inputSchema: schema({ path: S }, ["path"]) },
  { name: "move_path", description: "Move or rename a file/folder. If destination is an existing folder, the source moves INSIDE it keeping its name.", inputSchema: schema({ source: S, destination: S }, ["source", "destination"]) },
  { name: "search_files", description: "Find files/folders by NAME using glob patterns, e.g. \"**/*.py\", \"src/**/*.js\".", inputSchema: schema({ pattern: S }, ["pattern"]) },
  { name: "grep_files", description: "Search INSIDE file contents. Case-insensitive substring by default; regex:true for regular expressions. Narrow with include globs like \"src/**/*.ts\".", inputSchema: schema({ query: S, include: S, regex: B, ignore_case: B }, ["query"]) },
  { name: "run_command", description: "Run a terminal command in the workspace root: installs, builds, tests, git. Captures stdout/stderr and exit code. Blocks until done (hard timeout); never start interactive apps or dev servers.", inputSchema: schema({ command: S, timeout_seconds: I, cwd_note: S }, ["command"]) },
  { name: "file_info", description: "Metadata for one path: kind, size, modified/created timestamps, readonly flag.", inputSchema: schema({ path: S }, ["path"]) },
  { name: "env_info", description: "Machine overview: host, OS, arch, CPU count, memory, user, workspace root, and whether FULL PC ACCESS is on.", inputSchema: schema({}) },
  { name: "process_list", description: "List running processes sorted by memory (top N by limit, default 40). Read-only.", inputSchema: schema({ limit: I }) },
  { name: "process_kill", description: "Kill a process by PID. Requires FULL PC ACCESS mode - refused otherwise by design.", inputSchema: schema({ pid: I }, ["pid"]) },
  { name: "open_path", description: "Open a file/folder (workspace-relative, absolute in FULL mode) or an http(s) URL with the OS default application.", inputSchema: schema({ path: S }, ["path"]) },
  { name: "download_file", description: "Download an http(s) URL to a path (200 MB cap, streamed). Path follows sandbox rules.", inputSchema: schema({ url: S, path: S }, ["url", "path"]) },
]);
const TOOL_NAMES = CATALOG.map((t) => t.name);

module.exports = { Workspace, ToolError, CATALOG, TOOL_NAMES, IGNORED_DIRS, globToRegExp, humanSize, LIMITS: { MAX_READ_BYTES, MAX_TEXT_CHARS, MAX_RUN_OUTPUT, DEFAULT_RUN_TIMEOUT, MAX_RUN_TIMEOUT, MAX_GREP_RESULTS, DEFAULT_TREE_DEPTH, MAX_TREE_DEPTH, DOWNLOAD_MAX_BYTES } };
