"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { Bridge } = require("../bridge/server");
const { Settings } = require("../bridge/settings");
const { Logger } = require("../bridge/log");

const FAKE = path.join(__dirname, "fixtures", "fake-mcp.js");
const PORTS = { http: 43100, roblox: 43113, local: 43115 };

let dataDir, bridge;

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORTS.http, method, path: p, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function wsClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue = [];
    const waiters = [];
    ws.on("message", (m) => { const msg = JSON.parse(String(m)); if (waiters.length) waiters.shift()(msg); else queue.push(msg); });
    ws.on("open", () => resolve({
      ws,
      next: () => new Promise((r) => (queue.length ? r(queue.shift()) : waiters.push(r))),
      send: (obj) => ws.send(JSON.stringify(obj)),
      close: () => ws.close(),
    }));
    ws.on("error", reject);
  });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ordata-"));
  const settings = new Settings({ dir: dataDir });
  settings.update({ workspaceRoot: path.join(dataDir, "ws"), mcpCommand: `${process.execPath} ${FAKE}`, autoStartStudioMcp: false });
  const log = new Logger({ dir: path.join(dataDir, "logs"), echo: false });
  bridge = new Bridge({ settings, log, dataDir, ports: PORTS });
  await bridge.start();
});
test.after(async () => { await bridge.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test("HTTP root and /api/status are or-core compatible", async () => {
  const root = await request("GET", "/");
  assert.equal(root.body.service, "or-agent");
  const st = await request("GET", "/api/status");
  for (const key of ["roblox_connected", "roblox_bridge_connected", "local_bridge_connected", "local_ready", "local_root", "local_full", "roblox_queue", "roblox_proc", "mcp_busy"]) assert.ok(key in st.body, key);
  assert.equal(st.body.local_ready, true);
});

test("local engine socket: intro, ping, list_tools, call_tool", async () => {
  const c = await wsClient(PORTS.local);
  const intro = await c.next();
  assert.equal(intro.type, "connected");
  assert.equal(intro.tools.length, 18);
  assert.ok(intro.workspace_root);
  c.send({ type: "ping", id: 1 });
  assert.deepEqual(await c.next(), { type: "pong", id: 1 });
  c.send({ type: "list_tools", id: 2 });
  const tools = await c.next();
  assert.equal(tools.type, "tools");
  assert.equal(tools.tools[0].server, "local");
  c.send({ type: "call_tool", id: 3, name: "write_file", arguments: { path: "hello.txt", content: "hi" } });
  const r = await c.next();
  assert.equal(r.type, "tool_result");
  assert.equal(r.ok, true);
  assert.match(r.text, /Created hello\.txt/);
  c.send({ type: "call_tool", id: 4, name: "read_file", arguments: { path: "missing.txt" } });
  const bad = await c.next();
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, "execution");
  assert.equal(bad.errorCode, "INVALID_ARGUMENT");
  c.send({ type: "bogus", id: 5 });
  assert.equal((await c.next()).errorCode, "UNKNOWN_BRIDGE_MESSAGE");
  c.close();
});

test("roblox engine socket talks to the Studio MCP helper", async () => {
  const c = await wsClient(PORTS.roblox);
  const intro = await c.next();
  assert.equal(intro.type, "connected");
  assert.equal(intro.mcp_alive, true);
  assert.equal(intro.studio, true);
  assert.ok(intro.tools.some((t) => t.name === "execute_luau" && t.server === "roblox"));
  assert.ok(intro.servers.some((s) => s.id === "roblox" && s.alive));
  c.send({ type: "studio_status", id: 1 });
  const ss = await c.next();
  assert.equal(ss.type, "studio_status");
  assert.equal(ss.studio, true);
  c.send({ type: "call_tool", id: 2, name: "execute_luau", arguments: { code: "print(1)" } });
  const r = await c.next();
  assert.equal(r.ok, true);
  assert.equal(r.text, "ran: print(1)");
  c.send({ type: "call_tool", id: 3, name: "screen_capture", arguments: {} });
  const img = await c.next();
  assert.equal(img.images.length, 1);
  assert.equal(img.images[0].mimeType, "image/png");
  c.send({ type: "call_tool", id: 4, name: "does_not_exist", arguments: {} });
  const nf = await c.next();
  assert.equal(nf.ok, false);
  assert.equal(nf.errorCode, "COMMAND_NOT_FOUND");
  c.send({ type: "restart_mcp", id: 5 });
  const rs = await c.next();
  assert.equal(rs.type, "mcp_status");
  assert.equal(rs.ok, true);
  assert.equal(rs.alive, true);
  c.close();
});

test("dead helper is restarted once and the call retried", async () => {
  bridge.studio.setCommand(`${process.execPath} ${FAKE}`);
  process.env.FAKE_MCP_CRASH_ON = "execute_luau";
  await bridge.studio.restart();
  delete process.env.FAKE_MCP_CRASH_ON;
  const r = await bridge.callTool("roblox", "execute_luau", { code: "x" }, 10000);
  assert.equal(r.text, "ran: x");
});

test("payload queue: push -> poll -> result broadcast on /ws", async () => {
  const sock = new WebSocket(`ws://127.0.0.1:${PORTS.http}/ws`);
  await new Promise((r) => sock.on("open", r));
  const got = new Promise((r) => sock.on("message", (m) => r(JSON.parse(String(m)))));
  const push = await request("POST", "/api/push", { id: "p1", code: "print('hi')", engine: "roblox" });
  assert.equal(push.body.ok, true);
  const poll = await request("GET", "/api/poll?client_id=x");
  assert.equal(poll.body.payload.id, "p1");
  assert.equal(poll.body.payload.code, "print('hi')");
  await request("POST", "/api/result", { id: "p1", ok: true, result: "done" });
  const msg = await got;
  assert.equal(msg.id, "p1");
  assert.equal(msg.result, "done");
  sock.close();
});

test("app API: snapshot, settings, local-full, explorer, terminal", async () => {
  const snap = await request("GET", "/app/api/snapshot");
  assert.equal(snap.body.tools.as, 18);
  assert.ok(snap.body.tools.rs >= 4);
  const lf = await request("POST", "/api/local-full", { enabled: true });
  assert.equal(lf.body.local_full, true);
  assert.equal((await request("GET", "/app/api/settings")).body.settings.fullAccess, true);
  await request("POST", "/app/api/settings", { fullAccess: false, theme: "emerald" });
  assert.equal(bridge.workspace.fullAccess, false);
  const list = await request("GET", "/app/api/fs/list?path=.");
  assert.ok(list.body.entries.some((e) => e.name === "hello.txt"));
  const read = await request("GET", "/app/api/fs/read?path=hello.txt");
  assert.equal(read.body.text, "hi");
  const term = await request("POST", "/app/api/terminal/run", { command: "echo term" });
  assert.match(term.body.text, /term/);
  const tools = await request("GET", "/app/api/tools");
  assert.ok(tools.body.tools.some((t) => t.source === "RS") && tools.body.tools.some((t) => t.source === "AS"));
  const ui = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: PORTS.http, path: "/app/" }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }));
  assert.equal(ui.status, 200);
  assert.match(ui.body, /ORscript Desktop/);
});

test("custom MCP servers merge into the roblox catalog and can be removed", async () => {
  const add = await request("POST", "/app/api/servers", { id: "fake2", name: "Fake 2", command: process.execPath, args: FAKE });
  assert.equal(add.body.ok, true);
  await new Promise((r) => setTimeout(r, 1500));
  const tools = await request("GET", "/app/api/tools");
  assert.ok(tools.body.tools.some((t) => t.source === "MCP" && t.server === "fake2"));
  const c = await wsClient(PORTS.roblox);
  const intro = await c.next();
  assert.ok(intro.servers.some((s) => s.id === "fake2" && s.alive && s.tools === 4));
  c.send({ type: "remove_server", id: 7, server_id: "fake2" });
  const rm = await c.next();
  assert.equal(rm.type, "server_changed");
  assert.equal(rm.ok, true);
  c.close();
  assert.equal(bridge.serverList().some((s) => s.id === "fake2"), false);
});
