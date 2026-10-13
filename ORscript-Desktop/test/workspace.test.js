"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Workspace, CATALOG, ToolError } = require("../bridge/workspace");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orws-"));
const ws = new Workspace({ root });

test("catalog exposes the 18 or-core AgentScript tools", () => {
  assert.equal(CATALOG.length, 18);
  for (const t of CATALOG) assert.ok(t.name && t.description && t.inputSchema.type === "object");
});

test("write / read / edit round-trip keeps or-core output formats", async () => {
  const w = await ws.dispatch("write_file", { path: "src/app.js", content: "const a = 1;\nconst b = 2;\n" });
  assert.match(w, /^Created src\/app\.js \(\d+ chars, ~2 lines\)\.$/);
  const r = await ws.dispatch("read_file", { path: "src/app.js" });
  assert.match(r, /^src\/app\.js  \(2 lines, /);
  assert.match(r, /\n    1 \| const a = 1;\n    2 \| const b = 2;$/);
  const e = await ws.dispatch("edit_file", { path: "src/app.js", old_string: "const b = 2;", new_string: "const b = 3;" });
  assert.match(e, /^Edited src\/app\.js: replaced 1 occurrence/);
  await assert.rejects(ws.dispatch("edit_file", { path: "src/app.js", old_string: "nope", new_string: "x" }), /old_string not found/);
  const info = await ws.dispatch("file_info", { path: "src/app.js" });
  assert.match(info, /^src\/app\.js \(file\)\nsize: /);
});

test("edit_file preserves CRLF and refuses ambiguous matches", async () => {
  await ws.dispatch("write_file", { path: "crlf.txt", content: "x\r\ny\r\nx\r\n" });
  await assert.rejects(ws.dispatch("edit_file", { path: "crlf.txt", old_string: "x", new_string: "z" }), /matches 2 places/);
  await ws.dispatch("edit_file", { path: "crlf.txt", old_string: "x", new_string: "z", replace_all: "true" });
  assert.equal(fs.readFileSync(path.join(root, "crlf.txt"), "utf8"), "z\r\ny\r\nz\r\n");
});

test("sandbox blocks escapes and absolute paths unless FULL access", async () => {
  await assert.rejects(ws.dispatch("read_file", { path: "../../etc/passwd" }), (err) => err instanceof ToolError && err.code === "INVALID_ARGUMENT");
  await assert.rejects(ws.dispatch("list_directory", { path: os.tmpdir() }), /FULL PC ACCESS/);
  ws.setFullAccess(true);
  const out = await ws.dispatch("list_directory", { path: root });
  assert.match(out, /\[dir \] src\//);
  ws.setFullAccess(false);
});

test("search_files / grep_files / tree / list_directory", async () => {
  await ws.dispatch("create_folder", { path: "node_modules/skip" });
  await ws.dispatch("write_file", { path: "node_modules/skip/x.js", content: "const a = 1;" });
  const s = await ws.dispatch("search_files", { pattern: "**/*.js" });
  assert.match(s, /src\/app\.js/);
  assert.doesNotMatch(s, /node_modules/);
  const g = await ws.dispatch("grep_files", { query: "const B", include: "src/**/*.js" });
  assert.match(g, /src\/app\.js:2: const b = 3;/);
  const g2 = await ws.dispatch("grep_files", { query: "const [ab]", regex: true, ignore_case: false });
  assert.match(g2, /\(2, scanned/);
  const t = await ws.dispatch("tree", { depth: 2 });
  assert.match(t, /^\.\/\n/);
  assert.match(t, /  src\/\n    app\.js/);
  const l = await ws.dispatch("list_directory", {});
  assert.match(l, /\[file\] crlf\.txt/);
});

test("run_command captures output, exit code and timeouts", async () => {
  const out = await ws.dispatch("run_command", { command: process.platform === "win32" ? "echo hi" : "echo hi && exit 3" });
  assert.match(out, /^\$ echo hi/);
  assert.match(out, /--- stdout ---\nhi/);
  if (process.platform !== "win32") assert.match(out, /exit code 3/);
  const slow = await ws.dispatch("run_command", { command: process.platform === "win32" ? "ping -n 5 127.0.0.1 >NUL" : "sleep 5", timeout_seconds: 1 });
  assert.match(slow, /TIMED OUT after 1s/);
  await assert.rejects(ws.dispatch("run_command", { command: "   " }), /'command' is required/);
});

test("move / delete / env / process tools", async () => {
  const m = await ws.dispatch("move_path", { source: "crlf.txt", destination: "src" });
  assert.equal(m, "Moved crlf.txt -> src/crlf.txt.");
  const d = await ws.dispatch("delete_path", { path: "src" });
  assert.match(d, /^Deleted folder src\/ \(2 files removed\)\.$/);
  await assert.rejects(ws.dispatch("delete_path", { path: "." }), /workspace root/);
  const env = await ws.dispatch("env_info", {});
  assert.match(env, /Workspace root: /);
  await assert.rejects(ws.dispatch("process_kill", { pid: 1 }), /FULL PC ACCESS/);
  const pl = await ws.dispatch("process_list", { limit: 3 });
  assert.match(pl, /^Processes \(top 3 of/);
  const wi = await ws.dispatch("workspace_info", {});
  assert.match(wi, /^Workspace root: /);
});

test("unknown tools raise COMMAND_NOT_FOUND with the catalog list", async () => {
  await assert.rejects(ws.dispatch("nope", {}), (err) => err.code === "COMMAND_NOT_FOUND" && /Available AgentScript tools: workspace_info/.test(err.message));
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
