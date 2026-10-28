// 1.81.0 — Studio execution path, MOCKED end to end (run: node tests/test-exec-path.js).
// Loads the real background.js service worker in a vm with a stubbed `chrome`
// and a FAKE WebSocket that plays the bridge, then drives `call_tool` messages
// through chrome.runtime.onMessage exactly like src/core/main.js does.
//
// Everything here is a MOCK: no total-core, no Roblox Studio, no AI site. What
// it proves is the routing contract of the worker itself:
//   - a Roblox-engine call_tool goes down the 17613 socket as {command, args}
//   - an AgentScript-engine call goes down 17615 only
//   - a page/worker engine disagreement is REFUSED (ENGINE_MISMATCH), never routed
//   - Studio offline → explicit STUDIO_BRIDGE_OFFLINE, never ok:true
//   - a bridge timeout is ok:false kind:timeout (never reported as success)
//   - a mutating tool is never replayed after an ambiguous failure, a read-only
//     tool is retried at most once
//   - results carry the caller's requestId back to the right iteration
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const root = path.join(__dirname, "..");
let failed = 0;
const ok = (n, v, extra) => { console.log((v ? "PASS  " : "FAIL  ") + n + (v || extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 300))); if (!v) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake bridge socket ───────────────────────────────────────────────────────
const sockets = [];
class FakeWebSocket {
  constructor(url) {
    this.url = url; this.readyState = FakeWebSocket.CONNECTING; this.sent = []; this.closed = false;
    this.behaviour = FakeWebSocket.behaviour; // snapshot per socket
    sockets.push(this);
    setTimeout(() => { if (this.closed) return; this.readyState = FakeWebSocket.OPEN; this.onopen && this.onopen(); this._emit({ type: "connected", mcp_alive: true, studio: this.behaviour.studio, tools: [], servers: [] }); }, 2);
  }
  _emit(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
  send(raw) {
    const m = JSON.parse(raw); this.sent.push(m);
    const b = this.behaviour;
    if (m.type === "ping") return this._emit({ type: "pong", id: m.id });
    if (m.type === "studio_status") return this._emit({ type: "studio_status", id: m.id, studio: b.studio });
    if (m.type === "list_tools") return this._emit({ type: "tools", id: m.id, ok: true, tools: [], servers: [], mcp_alive: true, studio: b.studio });
    if (m.type === "call_tool") {
      if (b.mode === "silent") return; // never answers → timeout path
      if (b.mode === "drop") { setTimeout(() => this.close(), 1); return; } // socket dies mid-call
      return this._emit({ type: "tool_result", id: m.id, requestId: m.requestId, ok: true, text: `ran ${m.command} on ${this.url}` });
    }
  }
  close() { if (this.closed) return; this.closed = true; this.readyState = FakeWebSocket.CLOSED; this.onclose && this.onclose(); }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
FakeWebSocket.behaviour = { studio: true, mode: "ok" };

// ── chrome stub ─────────────────────────────────────────────────────────────
let onMessage = null;
const storage = { "rs-engine": "roblox" };
const chrome = {
  storage: { local: { get: (k, cb) => { const o = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { if (x in storage) o[x] = storage[x]; }); cb && cb(o); return Promise.resolve(o); }, set: (o) => { Object.assign(storage, o); return Promise.resolve(); }, remove: () => Promise.resolve() }, onChanged: { addListener() {} } },
  runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, getURL: (p) => "chrome-extension://test/" + p, sendMessage: () => Promise.resolve(), getPlatformInfo: (cb) => cb && cb({ os: "linux" }), lastError: null, getManifest: () => ({ version: "test" }) },
  tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve(), create: () => Promise.resolve(), update: () => Promise.resolve() },
  windows: { update: () => Promise.resolve() },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  notifications: { create() {} },
};
const ctx = {
  chrome, WebSocket: FakeWebSocket, console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, performance, crypto: globalThis.crypto, Date, JSON, Math, Promise,
  fetch: () => Promise.reject(new Error("mock: no network")), self: {}, URL, TextEncoder, TextDecoder, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set, Symbol,
};
ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), ctx, { filename: "background.js" });
ok("background.js loads under the mock and registers one onMessage listener", typeof onMessage === "function");

const ask = (msg, waitMs = 4000) => new Promise((resolve) => {
  let done = false; const t = setTimeout(() => { if (!done) { done = true; resolve({ __noAnswer: true }); } }, waitMs);
  const r = onMessage(msg, { id: "test" }, (resp) => { if (!done) { done = true; clearTimeout(t); resolve(resp); } });
  if (r !== true && !done) { /* synchronous handlers answer through sendResponse too */ }
});
const lastSock = () => sockets[sockets.length - 1];
// Wait until the worker has dialled a NEW socket after `prev` and it is open
// (the worker reconnects with jittered backoff, so never sleep a fixed time).
const waitNewOpen = async (prev, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = lastSock(); if (s && s !== prev && s.readyState === FakeWebSocket.OPEN) { await sleep(20); return s; } await sleep(15); } return null; };
const callsOn = (s) => s.sent.filter((m) => m.type === "call_tool");

(async () => {
  await sleep(30);
  ok("worker dials the ROBLOX socket (ws://127.0.0.1:17613) by default", !!lastSock() && /:17613$/.test(lastSock().url), lastSock() && lastSock().url);

  // 1. Roblox command → Roblox socket, legacy wire shape, requestId preserved
  const r1 = await ask({ type: "call_tool", name: "execute_luau", arguments: { code: "return 1", datamodel_type: "Edit" }, timeout: 2000, requestId: "iter-7", engine: "roblox" });
  const c1 = callsOn(lastSock());
  ok("execute_luau reaches the Roblox socket as {command, args, requestId}", c1.length === 1 && c1[0].command === "execute_luau" && c1[0].args && c1[0].args.code === "return 1" && c1[0].requestId === "iter-7", c1[0]);
  ok("the bridge result comes back ok with the SAME requestId (result → correct iteration)", r1 && r1.ok === true && /ran execute_luau on ws:\/\/127\.0\.0\.1:17613/.test(r1.text) && r1.requestId === "iter-7", r1);
  ok("no extension-internal flags or engine tag leak onto the wire", !("engine" in c1[0]) || c1[0].engine === undefined ? true : false, c1[0]);

  // 2. Page says AgentScript while the worker is on Roblox → refused, nothing sent
  const before = callsOn(lastSock()).length;
  const r2 = await ask({ type: "call_tool", name: "write_file", arguments: { path: "a.txt", content: "x" }, timeout: 2000, engine: "local" });
  ok("engine disagreement is REFUSED with ENGINE_MISMATCH (no silent cross-engine routing)", r2 && r2.ok === false && r2.errorCode === "ENGINE_MISMATCH" && r2.workerEngine === "roblox", r2);
  ok("…and nothing was written to the Roblox socket for it", callsOn(lastSock()).length === before);

  // 3. Studio offline → explicit error, never success
  const sockA = lastSock();
  sockA.behaviour = { studio: false, mode: "ok" };
  sockA._emit({ type: "studio_status", studio: false });
  const r3 = await ask({ type: "call_tool", name: "get_studio_state", arguments: {}, timeout: 2000, engine: "roblox" });
  ok("Studio not attached → ok:false STUDIO_BRIDGE_OFFLINE (explicit, not a fake success)", r3 && r3.ok === false && r3.errorCode === "STUDIO_BRIDGE_OFFLINE", r3);
  ok("…and the command never reached the bridge", callsOn(sockA).filter((m) => m.command === "get_studio_state").length === 0);
  sockA.behaviour = { studio: true, mode: "ok" };
  sockA._emit({ type: "studio_status", studio: true });

  // 4. Mutating tool: an ambiguous failure (socket dropped after the send) is NOT replayed
  sockA.behaviour = { studio: true, mode: "drop" };
  const r4 = await ask({ type: "call_tool", name: "execute_luau", arguments: { code: "workspace.X:Destroy()", datamodel_type: "Edit" }, timeout: 2000, engine: "roblox" }, 15000);
  await sleep(40);
  const allExec = sockets.flatMap((s) => callsOn(s)).filter((m) => m.command === "execute_luau" && m.args.code === "workspace.X:Destroy()");
  ok("mutating execute_luau after a mid-call disconnect: reported as a failure, sent exactly ONCE (no replay)", r4 && r4.ok === false && allExec.length === 1, { r4, n: allExec.length });
  const sockB = await waitNewOpen(sockA);
  ok("worker reconnected to the SAME Roblox port after the drop", !!sockB && /:17613$/.test(sockB.url), sockB && sockB.url);

  // 5. Read-only tool: retried at most once after a disconnect
  sockB.behaviour = { studio: true, mode: "drop" };
  const r5 = await ask({ type: "call_tool", name: "get_studio_state", arguments: {}, timeout: 2000, engine: "roblox" }, 20000);
  const allState = sockets.flatMap((s) => callsOn(s)).filter((m) => m.command === "get_studio_state");
  ok("read-only get_studio_state after a drop: retried on the fresh socket at most once (sent ≤ 2 times total) and answered", allState.length >= 1 && allState.length <= 2 && r5 && r5.ok === true, { n: allState.length, r5 });
  const sockC = lastSock().readyState === FakeWebSocket.OPEN ? lastSock() : await waitNewOpen(sockB);

  // 6. Timeout is a failure, not a success
  sockC.behaviour = { studio: true, mode: "silent" };
  const t0 = Date.now();
  const r6 = await ask({ type: "call_tool", name: "inspect_instance", arguments: { path: "game.Workspace" }, timeout: 300, engine: "roblox" }, 15000);
  ok("bridge never answers → ok:false kind:timeout with an error code (never ok:true)", r6 && r6.ok === false && r6.kind === "timeout" && !!r6.errorCode, r6);
  ok("timeout respected the caller's budget (+10 s worker margin), not a hard-coded 120 s", Date.now() - t0 < 14000, Date.now() - t0);
  sockC.behaviour = { studio: true, mode: "ok" };

  // 7. Engine switch → AgentScript socket (17615) and only there
  const r7 = await ask({ type: "rs-set-engine", engine: "local" });
  await sleep(40);
  const sockL = lastSock();
  ok("rs-set-engine local → the worker dials ws://127.0.0.1:17615", r7 && r7.engine === "local" && /:17615$/.test(sockL.url), sockL && sockL.url);
  const r8 = await ask({ type: "call_tool", name: "read_file", arguments: { path: "README.md" }, timeout: 2000, engine: "local" });
  ok("AgentScript call goes down 17615 and answers", r8 && r8.ok === true && /17615/.test(r8.text) && callsOn(sockL).some((m) => m.command === "read_file"), r8);
  const r9 = await ask({ type: "call_tool", name: "execute_luau", arguments: { code: "return 1" }, timeout: 2000, engine: "roblox" });
  ok("a Roblox-page call while the worker is on AgentScript is REFUSED (never reaches 17615)", r9 && r9.ok === false && r9.errorCode === "ENGINE_MISMATCH" && !callsOn(sockL).some((m) => m.command === "execute_luau"), r9);
  const r10 = await ask({ type: "call_tool", name: "list_dir", arguments: {}, timeout: 2000 });
  ok("legacy caller without an engine tag is routed as before (back-compat)", r10 && r10.ok === true, r10);
  ok("no socket to 17613 was used for AgentScript calls", !sockets.filter((s) => /:17613$/.test(s.url)).some((s) => callsOn(s).some((m) => m.command === "read_file" || m.command === "list_dir")));

  // 8. Static contract: mutating Studio tools are not in the idempotent retry set
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const setSrc = (bg.match(/IDEMPOTENT_STUDIO_TOOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/) || [])[1] || "";
  ok("IDEMPOTENT_STUDIO_TOOLS never lists execute_luau / multi_edit / set_property / delete_instance / create_instance", setSrc && !/execute_luau|multi_edit|set_property|delete_instance|create_instance|script_set_source/.test(setSrc));
  const main = fs.readFileSync(path.join(root, "src/core/main.js"), "utf8");
  ok("main.js tags every call_tool with the page engine and surfaces ENGINE_MISMATCH as an explicit ERROR", /msg\.type === "call_tool" && !msg\.engine\) msg\.engine = activeEngine\(\)/.test(main) && /ERROR ENGINE_MISMATCH:/.test(main) && /The command did NOT run\./.test(main));
  ok("main.js routes Studio calls through callStudioToolWithId and AgentScript calls through bg(call_tool) - no third path", /activeEngine\(\) === "local" \|\| bareName === "list_roblox_studios"\s*\?\s*bg\(\{ type: "call_tool"/.test(main) && /: callStudioToolWithId\(name, wireArgs, timeout, A\.activeRequestId\)/.test(main));
  ok("main.js: a bridge timeout is reported as an ERROR that says it was not silently successful", /The request was not silently reported as successful/.test(main));
  ok("main.js: executed-turn ledger keys on conversation + turn so a retried read never re-runs a finished command", /executed\.set\(`\$\{P\.conversationKey\(\)\}\|\$\{turnKey\(item\)\}`/.test(main));

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS (mocked bridge — no live Studio involved)");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("harness error", e); process.exit(1); });
