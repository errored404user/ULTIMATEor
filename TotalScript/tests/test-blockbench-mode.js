// 2.21.0 — BLOCKBENCH work mode + extension routing. MOCKED: no Blockbench,
// no Studio, no AI site, no total-core. A fake total-core WebSocket (in-vm)
// stands in for the desktop app; the real command table
// (src/core/blockbench_tools.js) and the real background.js code path run
// against it. The plugin itself is covered by tests/test-blockbench-plugin.js.
//   node tests/test-blockbench-mode.js
//
// What this proves:
//   A. src/core/blockbench_tools.js: the 27 bb_* commands, validate() refuses
//      what the plugin would refuse (nothing bad crosses the bridge), the
//      tool list the AI reads, connect steps + offline message.
//   B. background.js in a vm against a fake total-core socket: a bb_* call_tool
//      is validated locally, needs total-core but NOT Studio, is refused with
//      BLOCKBENCH_OFFLINE + steps while total-core says the plugin is away,
//      travels as the plain {command, args, requestId} frame when connected,
//      images come back untouched, a late "not connected" answer flips the
//      link flag, servers[{id:"blockbench", alive}] drive the flag, the
//      blockbench_status / add_server messages answer the same payload; the
//      MCP client, the declarativeNetRequest rule and the URL key are gone.
//   D. work_modes.js: 4th id, preflight / precondition / brief / auto-check.
//   E. main.js: WORK_MODES.blockbench, MODE_GATES.blockbench (model + export),
//      bb_ branch in runTool, families, settings card (plugin file, Check
//      again, Copy plugin path) + handlers.
//   F. config.js profile + budgets; G. popup card / row / palette; H. README.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400) : "")); } };

const BB = require(path.join(ROOT, "src/core/blockbench_tools.js"));
const main = read("src/core/main.js"), config = read("src/core/config.js"), css = read("overlay.css"), popup = read("popup.js"), popupHtml = read("popup.html"), bg = read("background.js"), readme = read("README.md"), manifest = JSON.parse(read("manifest.json"));
const WM = require(path.join(ROOT, "src/core/work_modes.js"));
const PNG_B64 = Buffer.from("\x89PNG\r\n\x1a\n" + "x".repeat(200)).toString("base64");
const PLUGIN_FILE = "C:\\Users\\me\\AppData\\Local\\TotalScript\\TotalScript-Blockbench.js";

(async () => {
  // ── A. the command table ──────────────────────────────────────────────────
  const NAMES = ["bb_status", "bb_project", "bb_cubes", "bb_cube_edit", "bb_cube_uv", "bb_duplicate", "bb_select", "bb_visibility", "bb_group", "bb_locator", "bb_remove", "bb_mesh", "bb_mesh_primitive", "bb_mesh_edit", "bb_texture", "bb_animate", "bb_animation_list", "bb_animation_edit", "bb_animation_keyframe", "bb_animation_remove", "bb_marker", "bb_camera", "bb_screenshot", "bb_export", "bb_undo", "bb_redo", "bb_tools"];
  ok("A1 TotalBlockbench: 27 curated real commands (modeling, selection, UV, animation, camera, export), every one with description / inputSchema / validate; isCommand only for the table (not any bb_ prefix, not blender_)", JSON.stringify(BB.COMMAND_NAMES) === JSON.stringify(NAMES) && NAMES.every((n) => BB.COMMANDS[n] && typeof BB.COMMANDS[n].description === "string" && BB.COMMANDS[n].inputSchema && BB.COMMANDS[n].inputSchema.type === "object" && typeof BB.COMMANDS[n].validate === "function") && BB.isCommand("bb_cubes") && !BB.isCommand("bb_call") && !BB.isCommand("blender_add_cube"));
  const bad = [
    ["bb_project", {}, /name/],
    ["bb_cubes", {}, /cubes/],
    ["bb_cubes", { cubes: [{ name: "a", from: [0, 0, 0], to: [-1, 1, 1] }] }, /from must be <= to/],
    ["bb_cubes", { cubes: [{ name: "a", from: [0, 0], to: [1, 1, 1] }] }, /\[x,y,z\]/],
    ["bb_cubes", { cubes: [{ name: "a", from: [0, 0, 0], to: [1, 1, 1], color: 10 }] }, /color.*0-9/],
    ["bb_cube_uv", { name: "Body", faces: { top: [0, 0, 1, 1] } }, /unknown cube face/],
    ["bb_duplicate", { names: [] }, /names/],
    ["bb_select", { names: ["Body"], additive: "yes" }, /additive/],
    ["bb_visibility", { names: ["Body"], visible: 1 }, /visible/],
    ["bb_group", {}, /name/],
    ["bb_locator", { name: "Hand", position: [0, 1] }, /\[x,y,z\]/],
    ["bb_remove", { names: [] }, /names/],
    ["bb_mesh", { name: "w", vertices: [[0, 0, 0], [1, 0, 0]], faces: [[0, 1, 1]] }, /vert/i],
    ["bb_mesh", { name: "w", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [2, 2, 0]], faces: [[0, 1, 2, 3, 4]] }, /3 or 4/],
    ["bb_mesh_primitive", { shape: "blob" }, /cylinder/],
    ["bb_mesh_edit", { name: "m" }, /nothing to change|move|scale/i],
    ["bb_mesh_edit", { name: "m", scale: 0 }, /scale/],
    ["bb_texture", { action: "paint" }, /list\|create\|import\|apply|action/],
    ["bb_texture", { action: "create", name: "t", fill_color: "red" }, /#/],
    ["bb_texture", { action: "create", name: "t", width: 4096 }, /2048|size|width/i],
    ["bb_texture", { action: "apply", texture: "t" }, /targets/],
    ["bb_texture", { action: "apply", texture: "t", targets: ["all", "Body"] }, /do not mix/],
    ["bb_texture", { action: "create", name: "t", apply_to: ["all", "Body"] }, /do not mix/],
    ["bb_animate", { name: "idle", bones: {} }, /bones/],
    ["bb_animation_edit", { name: "idle" }, /at least one/],
    ["bb_animation_keyframe", { action: "add", animation: "idle", group: "Body", channel: "rotation", time: 0 }, /value/],
    ["bb_animation_remove", {}, /name/],
    ["bb_marker", { action: "remove", animation: "idle" }, /needs marker/],
    ["bb_camera", {}, /view|position|focus/],
    ["bb_export", { format: "fbx" }, /obj/],
    ["bb_undo", { steps: 0 }, /steps/],
    ["nope", {}, /unknown|not a Blockbench/i],
  ];
  const badFails = bad.filter(([n, a, re]) => { const v = BB.validate(n, a); return v.ok || !re.test(String(v.error)); }).map(([n, a]) => n + " " + JSON.stringify(a) + " → " + JSON.stringify(BB.validate(n, a)));
  ok("A2 validate() refuses the plugin's obvious refusals up front (missing name, from > to, 2-vectors, degenerate meshes, 5-gons, unknown shape, empty mesh edit, scale 0, bad action / hex / 4096 px / no targets, empty bones, empty camera, fbx, steps 0, unknown command) with a reason", badFails.length === 0, badFails);
  const good = [
    ["bb_status", {}], ["bb_status", { max_depth: 2 }], ["bb_project", { name: "Sword", format: "free" }],
    ["bb_cubes", { cubes: [{ name: "Edge", from: [-1, 0, -0.5], to: [1, 24, 0.5], color: 3 }], group: "Blade" }],
    ["bb_cube_edit", { name: "Edge", to: [1, 26, 0.5] }],
    ["bb_cube_uv", { name: "Edge", faces: { north: [0, 0, 16, 16] } }], ["bb_duplicate", { names: ["Edge", "Blade"] }],
    ["bb_select", { names: ["Edge", "Blade"], additive: true }], ["bb_visibility", { names: ["Edge", "Blade"], visible: false }],
    ["bb_group", { name: "Blade", origin: [0, 8, 0] }], ["bb_locator", { name: "Hand", position: [0, 8, 0], group: "Blade" }], ["bb_remove", { names: ["Edge"] }],
    ["bb_mesh", { name: "Wedge", vertices: [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4], [0, 4, 0], [4, 4, 0]], faces: [[0, 3, 2, 1], [0, 1, 5, 4], [1, 2, 5], [2, 3, 4, 5], [3, 0, 4]] }],
    ["bb_mesh_primitive", { shape: "cylinder", name: "Pommel", diameter: 4, height: 2, sides: 8, position: [0, -2, 0] }],
    ["bb_mesh_edit", { name: "Pommel", scale: 2, rotate: [0, 45, 0] }],
    ["bb_texture", { action: "list" }], ["bb_texture", { action: "create", name: "steel", width: 32, height: 32, fill_color: "#9aa3ad" }], ["bb_texture", { action: "apply", texture: "steel", targets: "all" }],
    ["bb_animate", { name: "idle", loop: true, length: 2, bones: { Blade: [{ time: 0, rotation: [0, 0, 0] }, { time: 1, rotation: [0, 0, 5] }] } }],
    ["bb_animation_list", {}], ["bb_animation_edit", { name: "idle", rename: "idle_v2", length: 3, loop: "hold" }],
    ["bb_animation_keyframe", { action: "add", animation: "idle", group: "Blade", channel: "rotation", time: 0.5, value: [0, 0, 10] }],
    ["bb_animation_keyframe", { action: "remove", animation: "idle", group: "Blade", channel: "rotation", time: 0.5 }],
    ["bb_animation_remove", { name: "idle" }], ["bb_marker", { action: "list", animation: "idle" }], ["bb_marker", { action: "add", animation: "idle", name: "hit", time: 0.5, color: 2 }], ["bb_marker", { action: "remove", animation: "idle", name: "hit" }],
    ["bb_camera", { view: "isometric_right" }], ["bb_screenshot", {}], ["bb_screenshot", { view: "front", max_size: 800 }],
    ["bb_export", { format: "obj", name: "sword" }], ["bb_export", { format: "glb" }], ["bb_undo", {}], ["bb_redo", { steps: 3 }], ["bb_tools", {}],
  ];
  const goodFails = good.filter(([n, a]) => !BB.validate(n, a).ok).map(([n, a]) => n + " " + JSON.stringify(a) + " → " + BB.validate(n, a).error);
  ok("A3 validate() passes every well-formed call the Blockbench profile teaches (status, project, cubes, cube_edit, group, remove, mesh, primitives, mesh_edit, texture list/create/apply, animate, camera, screenshot, export obj/glb, undo/redo, tools) and returns the canonical name", goodFails.length === 0 && BB.validate("bb_cubes", good[3][1]).name === "bb_cubes", goodFails);
  const tl = BB.toolList();
  ok("A4 toolList(): 27 entries {name, description, inputSchema, server:'blockbench'} in table order - what the extension merges into the AI's catalogue while the plugin is connected", tl.length === 27 && tl.every((t, i) => t.name === NAMES[i] && t.server === "blockbench" && typeof t.description === "string" && t.description.length > 20 && t.inputSchema && t.inputSchema.type === "object"));
  const steps = BB.connectSteps(PLUGIN_FILE), stepsNoFile = BB.connectSteps("");
  ok("A5 connectSteps(file): desktop app first, then Blockbench File → Plugins → Load Plugin from File → the actual plugin path, then Tools → TotalScript shows the link; without a known path it still names TotalScript-Blockbench.js; offlineMessage = 'ERROR BLOCKBENCH_OFFLINE: …' + the numbered steps (what the AI reads verbatim)", steps.length >= 3 && /desktop app|total-core/i.test(steps[0]) && steps[0].includes(PLUGIN_FILE) && steps.some((s) => /File → Plugins → Load Plugin from File → pick TotalScript-Blockbench\.js/.test(s)) && steps.some((s) => /Tools → TotalScript/.test(s) && /127\.0\.0\.1:3000/.test(s)) && stepsNoFile.some((s) => /TotalScript-Blockbench\.js/.test(s)) && BB.offlineMessage(PLUGIN_FILE).startsWith("ERROR BLOCKBENCH_OFFLINE: Blockbench is not connected to total-core. 1) ") && BB.offlineMessage(PLUGIN_FILE).includes(PLUGIN_FILE), { steps });

  // ── B. background.js in a vm against a fake total-core socket ────────────
  {
    const stored = {};
    const hub = { connected: false, frames: [], sockets: [], replyHook: null, statusOverride: null };
    class FakeSocket {
      static get OPEN() { return 1; } static get CONNECTING() { return 0; } static get CLOSED() { return 3; }
      constructor(url) {
        this.url = url; this.readyState = 0; hub.sockets.push(this);
        setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; this.onopen && this.onopen(); this.deliver({ type: "connected", mcp_alive: true, studio: false, servers: [{ id: "roblox", alive: true }, { id: "blockbench", alive: hub.connected }] }); }, 2);
      }
      deliver(obj) { setTimeout(() => { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }, 1); }
      send(data) {
        const f = JSON.parse(data); hub.frames.push(f);
        if (f.type === "ping") return this.deliver({ type: "pong", id: f.id });
        if (f.type === "list_tools") return this.deliver({ type: "tools", id: f.id, tools: [{ name: "get_studio_state", description: "x", inputSchema: { type: "object" } }], servers: [{ id: "roblox", alive: true }, { id: "blockbench", alive: hub.connected }], mcp_alive: true, studio: false });
        if (f.type === "studio_status") return this.deliver({ type: "studio_status", id: f.id, studio: false });
        if (f.type === "call_tool" && /^bb_/.test(f.command)) {
          if (hub.replyHook) { const r = hub.replyHook(f); if (r) return this.deliver(Object.assign({ type: "tool_result", id: f.id, requestId: f.requestId }, r)); }
          if (!hub.connected) return this.deliver({ type: "tool_result", id: f.id, requestId: f.requestId, ok: false, error: "ERROR BLOCKBENCH_OFFLINE: Blockbench is not connected to total-core. 1) start the app", errorCode: "BLOCKBENCH_OFFLINE" });
          if (f.command === "bb_screenshot") return this.deliver({ type: "tool_result", id: f.id, requestId: f.requestId, ok: true, text: "Screenshot of 'Sword' (free): 2 cube(s), 1 mesh(es).", images: [{ mimeType: "image/png", data: PNG_B64 }] });
          return this.deliver({ type: "tool_result", id: f.id, requestId: f.requestId, ok: true, text: "Placed " + ((f.args && f.args.cubes) || []).length + " cube(s) in group '" + (f.args && f.args.group) + "'." });
        }
        return this.deliver({ type: "tool_result", id: f.id, requestId: f.requestId, ok: false, error: "fake hub: unexpected " + f.command, errorCode: "BRIDGE_COMMAND_FAILED" });
      }
      close() { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose && this.onclose({ code: 1000 }), 1); }
    }
    const fetchLog = [];
    const fakeFetch = async (u) => {
      const url = String(u); fetchLog.push(url);
      const json = (obj, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => obj, text: async () => JSON.stringify(obj) });
      if (url.endsWith("/api/blockbench/status")) {
        const state = hub.statusOverride || { status: hub.connected ? "connected" : "disconnected", connected: hub.connected, verified: true };
        return json({ connected: state.connected, status: state.status, verified: state.verified, status_error: state.status === "unknown" ? "fake stale heartbeat" : undefined, plugin_file: PLUGIN_FILE, tools: 27 });
      }
      if (url.endsWith("/api/status")) return json({ roblox_proc: true, local_ready: false, local_full: false, blockbench_connected: hub.connected, blockbench_plugin_file: PLUGIN_FILE });
      return json({ error: "not found" }, 404);
    };
    let onMessage = null;
    function stub(name) { const f = function () { return stub(name + "()"); }; return new Proxy(f, { get(t, k) { if (k === "then") return undefined; if (typeof k === "symbol") return undefined; if (k === "addListener" && /onMessage$/.test(name)) return (fn) => { onMessage = fn; }; return stub(name + "." + String(k)); }, apply() { return stub(name + "()"); } }); }
    const ctx = { chrome: stub("chrome"), console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, fetch: fakeFetch, AbortController, WebSocket: FakeSocket, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Blob, FormData, crypto, performance, Headers };
    ctx.self = ctx; ctx.globalThis = ctx;
    ctx.importScripts = (p) => vm.runInContext(read(p), ctx, { filename: p });
    vm.createContext(ctx);
    vm.runInContext(bg, ctx, { filename: "background.js" });
    ok("B1 background.js importScripts src/core/blockbench_tools.js (classic worker), TotalBlockbench is visible to it, and the 2.18 MCP client is gone (no TotalBlockbenchMcp / blockbench_mcp.js / declarativeNetRequest / rsBlockbenchUrl / bb-mcp / blockbench_connect|disconnect|set_url)", /importScripts\("src\/core\/blockbench_tools\.js"\)/.test(bg) && vm.runInContext("typeof TotalBlockbench", ctx) === "object" && !/TotalBlockbenchMcp|blockbench_mcp\.js|declarativeNetRequest|rsBlockbenchUrl|bb-mcp|blockbench_(connect|disconnect|set_url)\b/.test(bg) && typeof onMessage === "function");
    ctx.chrome = {
      runtime: { getPlatformInfo: async () => ({ os: "linux" }), getURL: (n) => n, sendMessage: async () => {}, onMessage: { addListener() {} }, lastError: null },
      tabs: { query: async () => [], sendMessage: async () => {} },
      storage: { local: { get: (k, cb) => { const out = {}; for (const key of Array.isArray(k) ? k : [k]) if (key in stored) out[key] = stored[key]; return cb ? cb(out) : Promise.resolve(out); }, set: async (o) => { Object.assign(stored, o); } } },
      alarms: { create() {}, onAlarm: { addListener() {} } },
    };
    const ask = (msg) => new Promise((res) => { const t = setTimeout(() => res({ ok: false, kind: "test-timeout" }), 15000); onMessage(msg, {}, (r) => { clearTimeout(t); res(r); }); });
    const bbFrames = () => hub.frames.filter((f) => /^bb_/.test(String(f.command)));
    const r1 = await ask({ type: "call_tool", name: "bb_cubes", arguments: { cubes: [{ name: "x", from: [0, 0, 0], to: [1, 1] }] } });
    ok("B2 call_tool bb_cubes with a 2-vector → kind validation / INVALID_ARGUMENT from the worker's own table; NOTHING is sent to total-core", r1 && r1.ok === false && r1.kind === "validation" && r1.errorCode === "INVALID_ARGUMENT" && /\[x,y,z\]/.test(r1.error) && bbFrames().length === 0, r1);
    const st0 = await ask({ type: "blockbench_status", refresh: true });
    ok("B3 blockbench_status {refresh:true} re-reads total-core's /api/blockbench/status: off → {ok false, blockbench false, plugin_file (from total-core), core, tools 0, steps[] naming the file}", st0 && st0.ok === false && st0.blockbench === false && st0.plugin_file === PLUGIN_FILE && st0.tools === 0 && Array.isArray(st0.steps) && st0.steps.some((s) => s.includes(PLUGIN_FILE)) && fetchLog.some((u) => u.endsWith("/api/blockbench/status")), st0);
    hub.statusOverride = { status: "unknown", connected: false, verified: false };
    const stUnknown = await ask({ type: "blockbench_status", refresh: true });
    const framesBeforeUnknownCall = bbFrames().length;
    const unknownCall = await ask({ type: "call_tool", name: "bb_undo", arguments: {} });
    hub.statusOverride = { status: "connected", connected: false, verified: true };
    const stContradictory = await ask({ type: "blockbench_status", refresh: true });
    hub.statusOverride = null;
    ok("B3a unverified or contradictory dedicated status stays UNKNOWN; a Blockbench call is refused before the socket is touched", stUnknown && stUnknown.status === "unknown" && stUnknown.verified === false && stUnknown.blockbench === false && unknownCall && unknownCall.kind === "status-unknown" && unknownCall.errorCode === "BLOCKBENCH_STATUS_UNKNOWN" && bbFrames().length === framesBeforeUnknownCall && stContradictory && stContradictory.status === "unknown" && stContradictory.verified === false, { stUnknown, unknownCall, stContradictory });
    const r2 = await ask({ type: "call_tool", name: "bb_cubes", arguments: { cubes: [{ name: "Torso", from: [-4, 0, -2], to: [4, 12, 2] }], group: "Body" } });
    ok("B4 a valid bb_* call while total-core says the plugin is away → kind disconnected / BLOCKBENCH_OFFLINE, error = offlineMessage (ERROR BLOCKBENCH_OFFLINE: … 1) …), steps[] attached, nothing sent over the socket (no Studio gate involved: studio is false throughout)", r2 && r2.ok === false && r2.kind === "disconnected" && r2.errorCode === "BLOCKBENCH_OFFLINE" && /^ERROR BLOCKBENCH_OFFLINE: Blockbench is not connected to total-core\. 1\) /.test(r2.error) && Array.isArray(r2.steps) && r2.steps.length >= 3 && bbFrames().length === 0 && vm.runInContext("robloxEditorConnected", ctx) !== true, r2);
    hub.connected = true;
    const st1 = await ask({ type: "blockbench_status", refresh: true });
    const statusNow = vm.runInContext("statusObj()", ctx);
    ok("B5 plugin up (total-core reports connected) → blockbench_status {ok true, blockbench true, core true, tools 27}; statusObj carries blockbench + blockbench_plugin_file; mergeBlenderTools(toolsCache) folds the 27 bb_* tools (server 'blockbench') into the catalogue", st1 && st1.ok === true && st1.blockbench === true && st1.core === true && st1.tools === 27 && statusNow.blockbench === true && statusNow.blockbench_plugin_file === PLUGIN_FILE && (() => { const tools = vm.runInContext("mergeBlenderTools(toolsCache)", ctx); return NAMES.every((n) => tools.some((t) => t.name === n && t.server === "blockbench")); })(), { st1, keys: Object.keys(statusNow) });
    const r3 = await ask({ type: "call_tool", name: "bb_cubes", arguments: { cubes: [{ name: "Torso", from: [-4, 0, -2], to: [4, 12, 2] }], group: "Body" }, requestId: "req-bb-1" });
    const f3 = bbFrames().at(-1);
    ok("B6 connected: the call travels as the plain total-core frame {type call_tool, command bb_cubes, args, requestId, version 1.0, id} and the plugin's own text comes back (ok, text) - no MCP, no second socket", r3 && r3.ok === true && /Placed 1 cube\(s\) in group 'Body'/.test(r3.text) && f3 && f3.type === "call_tool" && f3.command === "bb_cubes" && f3.name === "bb_cubes" && f3.args.group === "Body" && f3.args.cubes[0].name === "Torso" && f3.requestId === "req-bb-1" && f3.version === "1.0" && typeof f3.id === "number" && hub.sockets.length >= 1 && hub.sockets.every((s) => s.url === "ws://127.0.0.1:17613"), { r3, f3 });
    const r4 = await ask({ type: "call_tool", name: "bb_screenshot", arguments: {} });
    ok("B7 bb_screenshot: images [{mimeType image/png, data}] pass through untouched in the extension's capture shape", r4 && r4.ok === true && Array.isArray(r4.images) && r4.images.length === 1 && r4.images[0].mimeType === "image/png" && r4.images[0].data === PNG_B64 && /Screenshot of 'Sword'/.test(r4.text), r4);
    hub.connected = false; // Blockbench closed between two calls; the worker still believes it is up
    const r5 = await ask({ type: "call_tool", name: "bb_undo", arguments: {} });
    const st2 = await ask({ type: "blockbench_status", refresh: false });
    ok("B8 total-core answers 'Blockbench is not connected' mid-session → the worker flips its flag (status without refresh now says off), re-codes the answer BLOCKBENCH_OFFLINE and attaches the steps", r5 && r5.ok === false && r5.errorCode === "BLOCKBENCH_OFFLINE" && Array.isArray(r5.steps) && r5.steps.length >= 3 && st2 && st2.blockbench === false && bbFrames().at(-1).command === "bb_undo", { r5, st2 });
    hub.sockets.at(-1).deliver({ type: "tools", ok: false, mcp_alive: true, studio: false, tools: [], servers: [{ id: "roblox", alive: true }, { id: "blockbench", alive: true }] });
    await new Promise((r) => setTimeout(r, 20));
    const st3 = await ask({ type: "blockbench_status", refresh: false });
    const srv = await ask({ type: "add_server", server_id: "blockbench" });
    ok("B9 a cached server-list alive entry cannot override the dedicated verified disconnected status; the mismatch is reported, and legacy add_server re-reads total-core instead of spawning MCP", st3 && st3.verified === true && st3.status === "disconnected" && st3.blockbench === false && String(st3.server_list_mismatch || "").includes("alive/disconnected") && srv && srv.status === "disconnected" && srv.blockbench === false && !hub.frames.some((f) => f.type === "add_server"), { st3, srv });
    // total-core's bb_status offline path is a successful tool result whose text carries the sentinel.
    // Verify that it cannot keep a previously fresh worker/UI status green.
    hub.connected = true;
    const stFreshAgain = await ask({ type: "blockbench_status", refresh: true });
    hub.connected = false;
    hub.replyHook = (f) => f.command === "bb_status" ? { ok: true, text: "ERROR BLOCKBENCH_OFFLINE: Blockbench is not connected to total-core. 1) start the app" } : null;
    const r7 = await ask({ type: "call_tool", name: "bb_status", arguments: {} });
    hub.replyHook = null;
    const st4 = await ask({ type: "blockbench_status", refresh: false });
    ok("B9a bb_status offline sentinel in a successful text result forces a fresh total-core probe and is returned as a failure, not as a false connected success", stFreshAgain && stFreshAgain.blockbench === true && r7 && r7.ok === false && r7.errorCode === "BLOCKBENCH_OFFLINE" && !r7.text && st4 && st4.verified === true && st4.status === "disconnected" && st4.blockbench === false && /ERROR BLOCKBENCH_OFFLINE/.test(r7.error) && bbFrames().at(-1).command === "bb_status", { stFreshAgain, r7, st4 });
    hub.connected = true;
    const stUnknownAgain = await ask({ type: "blockbench_status", refresh: true });
    hub.replyHook = (f) => {
      if (f.command !== "bb_status") return null;
      hub.statusOverride = { status: "unknown", connected: false, verified: false };
      return { ok: true, text: "ERROR BLOCKBENCH_STATUS_UNKNOWN: Blockbench status cannot be verified" };
    };
    const r8 = await ask({ type: "call_tool", name: "bb_status", arguments: {} });
    hub.replyHook = null;
    hub.statusOverride = null;
    ok("B9b successful-text STATUS_UNKNOWN sentinel is never surfaced as a successful Blockbench call", stUnknownAgain && stUnknownAgain.blockbench === true && r8 && r8.ok === false && r8.errorCode === "BLOCKBENCH_STATUS_UNKNOWN" && /could not verify/i.test(r8.error) && !r8.text);
    const bbFramesBeforeLocal = bbFrames().length;
    vm.runInContext('engine = "local"', ctx);
    const r6 = await ask({ type: "call_tool", name: "bb_status", arguments: {} });
    vm.runInContext('engine = "roblox"', ctx);
    ok("B10 on the local engine a bb_* call is refused with ENGINE_MISMATCH (the plugin link lives in total-core on ws 17613) before anything is sent", r6 && r6.ok === false && r6.errorCode === "ENGINE_MISMATCH" && r6.workerEngine === "local" && bbFrames().length === bbFramesBeforeLocal, r6);
    ok("B11 background source: Blockbench liveness comes only from fresh /api/blockbench/status; server-list conflicts are diagnostics; call results detect the bb_status offline sentinel and refuse to mask unknown/mismatched status", (() => { const i = bg.indexOf("const isBb = typeof TotalBlockbench !== \"undefined\" && TotalBlockbench.isCommand(msg.name);"); const j = bg.indexOf("if (blenderAddon && isBlenderToolName(msg.name)) {"); const k = bg.indexOf("if (!connected || robloxEditorConnected !== true) await refreshStudioStatus();"); const branch = bg.slice(i, j); const serverFn = bg.slice(bg.indexOf("function noteBlockbenchServers(list)"), bg.indexOf("\n}\n", bg.indexOf("function noteBlockbenchServers(list)"))); return i > 0 && i < j && j < k && !/robloxEditorConnected/.test(branch) && /await send\(\{ type: "call_tool", name: v\.name, arguments: msg\.arguments \|\| \{\}, timeout: msg\.timeout, requestId: msg\.requestId \}, timeout\)/.test(branch) && /blockbench: bb\.connected, blockbench_verified: bb\.known/.test(bg) && /function bbStatusSnapshot\(\)/.test(bg) && /cache: "no-store"/.test(bg) && /void bbRefresh\(\);/.test(bg) && /setInterval\(\(\) => \{ void bbRefresh\(\); \}, 5000\)/.test(bg) && /const statusText = \//.test(branch) && /statusErrorReply/.test(branch) && /BLOCKBENCH_STATUS_MISMATCH/.test(branch) && /cached WebSocket server list is diagnostic only/.test(bg) && /bbServerMismatch/.test(serverFn) && /bbRefresh\(\)/.test(serverFn) && !/bbSetConnected\(bb\.alive === true\)/.test(serverFn); })());
    ok("B12 manifest: no declarativeNetRequest* permission any more (only the MCP client needed the Origin rewrite); storage / alarms kept; loopback host permission for total-core kept", !manifest.permissions.some((p) => /declarativeNetRequest/.test(p)) && !(manifest.optional_permissions || []).some((p) => /declarativeNetRequest/.test(p)) && manifest.permissions.includes("storage") && manifest.permissions.includes("alarms") && manifest.host_permissions.some((h) => /127\.0\.0\.1|localhost|http:\/\/\*\/\*/.test(h)));
    for (const s of hub.sockets) s.close();
    vm.runInContext("try { stopHeartbeat(); } catch {} try { clearTimeout(reconnectTimer); } catch {} manualStudioDisconnect = true;", ctx);
  }


  // ── D. work_modes.js ──────────────────────────────────────────────────────
  ok("D1 TotalWorkModes: ids creation/blender/animate/blockbench, badge BLOCKBENCH, DOES text names the manual Import 3D, GATE_LABEL has model + export", JSON.stringify(WM.IDS) === JSON.stringify(["creation", "blender", "animate", "blockbench"]) && WM.BADGE.blockbench === "BLOCKBENCH" && /Import 3D/.test(WM.DOES.blockbench) && WM.GATE_LABEL.model === "MODEL" && WM.GATE_LABEL.export === "EXPORT" && WM.normalize("blockbench") === "blockbench");
  const pre = WM.precondition("blockbench", { blockbenchConnected: false }), preOk = WM.precondition("blockbench", { blockbenchConnected: true });
  ok("D2 precondition: not connected → hard stop (title, message names the desktop app + File → Plugins → Load Plugin from File → TotalScript-Blockbench.js, brief forbids emulating Blockbench); connected → ok", !pre.ok && /not connected/.test(pre.title) && /Load Plugin from File/.test(pre.message) && /TotalScript-Blockbench\.js/.test(pre.message) && /total-core|desktop app/.test(pre.message) && !/jasonjgardner|mcp\.js|bb-mcp/i.test(pre.message + pre.brief) && /Do NOT emulate Blockbench/.test(pre.brief) && pre.brief.startsWith("━━━ BLOCKBENCH PREFLIGHT") && preOk.ok === true);
  const pf = WM.preflight("blockbench", { engine: "roblox", blockbenchConnected: true });
  ok("D3 preflight probe = {kind blockbench, tool bb_status}; none when disconnected or on the local engine", pf && pf.kind === "blockbench" && pf.tool === "bb_status" && WM.preflight("blockbench", { engine: "roblox", blockbenchConnected: false }) === null && WM.preflight("blockbench", { engine: "local", blockbenchConnected: true }) === null);
  const brief = WM.renderBrief("blockbench", "[get_project_info] {\"format\":\"free\",\"elements\":{\"cubes\":3}}", {}), briefNone = WM.renderBrief("blockbench", null, {});
  ok("D4 renderBrief quotes the project read, states the MODEL / EXPORT rules and 'facts read from Blockbench'; null data → 'could not be read' + bb_project hint; ≤ BRIEF_MAX", /Blockbench project \(bb_status/.test(brief) && /cubes/.test(brief) && /EXPORT gate/.test(brief) && /facts read from Blockbench/.test(brief) && brief.length <= WM.BRIEF_MAX && /could not be read/.test(briefNone) && /bb_project/.test(briefNone) && WM.briefSummary("blockbench", "x") === "Blockbench project read");
  const ac1 = WM.autoCheck("blockbench", "bb_cubes", { cubes: [{ name: "Torso" }] }, "Output of 'bb_cubes':\nPlaced 1"), ac2 = WM.autoCheck("blockbench", "bb_screenshot", {}, "ok"), ac3 = WM.autoCheck("blockbench", "bb_texture", { action: "list" }, "ok"), ac4 = WM.autoCheck("blockbench", "bb_cubes", {}, "ERROR INVALID_ARGUMENT"), ac5 = WM.autoCheck("blockbench", "bb_camera", { view: "front" }, "ok"), ac6 = WM.autoCheck("blockbench", "bb_mesh_primitive", { shape: "cylinder", name: "Wheel" }, "ok"), ac7 = WM.autoCheck("blockbench", "bb_export", { format: "obj" }, "ok"), ac8 = WM.autoCheck("blockbench", "bb_undo", {}, "Undid 1 step(s).");
  ok("D5 autoCheck: builds (bb_cubes, bb_mesh_primitive, bb_undo) → bb_status read-back labelled with the element; read-only (bb_screenshot, bb_texture list, bb_camera, bb_export) and errors → none", ac1 && ac1.kind === "blockbench" && ac1.tool === "bb_status" && ac2 === null && ac3 === null && ac4 === null && ac5 === null && ac6 && ac6.tool === "bb_status" && ac6.label === "Wheel" && ac7 === null && ac8 && ac8.tool === "bb_status");
  ok("D6 renderAutoCheck: '[MODE AUTO-CHECK bb_status after bb_cubes] …' clipped to AUTO_MAX; empty raw → ''", /^\[MODE AUTO-CHECK bb_status after bb_cubes\] \[get_project_info\]/.test(WM.renderAutoCheck(ac1, "[get_project_info] {\"cubes\":4}")) && WM.renderAutoCheck(ac1, "").length === 0 && WM.renderAutoCheck(ac1, "x".repeat(2000)).length <= WM.AUTO_MAX);

  // ── E. main.js ────────────────────────────────────────────────────────────
  ok("E1 main.js WORK_MODES.blockbench: name/badge/short, sub + note say export file + manual Import 3D, toast, 8 starters, focus regex claims bb_* and total_screenshot", /WORK_MODES\.blockbench = \{\n    name: "Blockbench", badge: "BLOCKBENCH", short: "Blockbench",/.test(main) && /Studio Import 3D \(manual\)/.test(main) && (main.match(/WORK_MODES\.blockbench = \{[\s\S]*?focus: (\/[^\n]+\/),\n  \};/) || [])[1] && (() => { const m = main.match(/WORK_MODES\.blockbench = \{([\s\S]*?)\n  \};/); const block = m[1]; const starters = (block.match(/\{ label: "/g) || []).length; const focus = eval(block.match(/focus: (\/[^\n]+\/),/)[1]); return starters === 8 && focus.test("bb_cubes") && focus.test("bb_export") && focus.test("total_screenshot") && !focus.test("blender_add_cube") && !focus.test("list_commands"); })());
  {
    const m = main.match(/MODE_GATES\.blockbench = \[([\s\S]*?)\n  \];/);
    const gates = m ? eval("[" + m[1] + "]") : [];
    const model = gates.find((g) => g.id === "model"), exp = gates.find((g) => g.id === "export");
    ok("E2 MODE_GATES.blockbench: MODEL (did bb_cubes/group/mesh/mesh_primitive/mesh_edit/texture/animate → proof bb_screenshot|bb_status) + EXPORT (did builds → proof bb_export); scripts + look pushed from creation; nudges say Import 3D is manual", model && exp && model.did.test("bb_cubes") && model.did.test("bb_mesh_primitive") && model.did.test("bb_mesh_edit") && !model.did.test("bb_tools") && !model.did.test("bb_screenshot") && model.proof.test("bb_screenshot") && model.proof.test("bb_status") && !model.proof.test("bb_export") && exp.did.test("bb_group") && !exp.did.test("bb_remove") && exp.proof.test("bb_export") && !exp.proof.test("bb_status") && /Do not claim it is in Studio/.test(exp.nudge) && main.includes('MODE_GATES.blockbench.push(...MODE_GATES.creation.filter((g) => g.id === "scripts" || g.id === "look"));'));
  }
  ok("E3 runTool and preflight: Blockbench calls require a fresh consistent verified status; unknown and disconnected are distinct, the offline result clears the green state, and no fake execution or MCP route exists", main.indexOf('if (/^bb_[a-z_]+$/.test(bareName)) {') > 0 && main.indexOf('if (/^bb_[a-z_]+$/.test(bareName)) {') < main.indexOf('const BLENDER_OPS = new Set(') && main.includes("function blockbenchStatusState(bridge)") && main.includes("function applyBlockbenchStatus(status)") && main.includes('await bg({ type: "blockbench_status", refresh: true })') && main.includes("ERROR BLOCKBENCH_STATUS_UNKNOWN calling '") && main.includes("ERROR BLOCKBENCH_OFFLINE calling '") && main.includes('if (probe.kind === "blockbench" && blockbenchStatusState(A.bridge) !== "connected") return feedback;') && main.includes('applyBlockbenchStatus({ blockbench: false, verified: true, status: "disconnected"') && main.includes('probe.kind === "blender" || probe.kind === "blockbench"') && main.includes("async function blockbenchReady()") && main.includes("ui.showImages(r.images, name)") && !/blockbench_(connect|disconnect|set_url)\b|jasonjgardner|bb-mcp/.test(main));
  {
    const start = main.indexOf("const BLOCKBENCH_UI_STATUS_MAX_AGE_MS = 12000;");
    const end = main.indexOf("function startModePreflight()", start);
    const statusCtx = { Date, A: { bridge: {} } }; vm.createContext(statusCtx);
    vm.runInContext(main.slice(start, end) + "\nthis.__bbState = blockbenchStatusState; this.__applyBb = applyBlockbenchStatus;", statusCtx);
    const apply = statusCtx.__applyBb, state = statusCtx.__bbState, now = Date.now();
    const connected = apply({ verified: true, status: "connected", blockbench: true, checked_at: now, core: true });
    const contradictory = apply({ verified: true, status: "connected", blockbench: false, checked_at: now, core: true });
    const stale = apply({ verified: true, status: "disconnected", blockbench: false, checked_at: now - 12001, core: true });
    const disconnected = apply({ verified: true, status: "disconnected", blockbench: false, checked_at: now, core: true });
    const callMismatch = apply({ verified: true, status: "connected", blockbench: true, checked_at: now, core: true, call_mismatch: "offline reply disagrees" });
    const clearedMismatch = apply({ verified: true, status: "connected", blockbench: true, checked_at: now, core: true });
    ok("E3a main.js normalizes only fresh internally consistent verified status; contradictions become unknown, expiry repaints the UI, and a fresh worker response clears a resolved call mismatch", connected === "connected" && contradictory === "unknown" && stale === "unknown" && disconnected === "disconnected" && callMismatch === "unknown" && clearedMismatch === "connected" && !statusCtx.A.bridge.blockbench_call_mismatch && main.includes("blockbenchStatusExpiryTimer = setTimeout") && main.includes("try { renderBar(); } catch {}"));
  }
  {
    const start = main.indexOf("chrome.runtime.onMessage.addListener((msg) => {");
    const end = main.indexOf('if (msg && msg.type === "rs-open-menu")', start);
    const listener = main.slice(start, end);
    const fields = ["blockbench", "blockbench_verified", "blockbench_status", "blockbench_status_error", "blockbench_checked_at", "blockbench_core_api", "blockbench_bridge_connected", "blockbench_server_list_mismatch", "blockbench_call_mismatch", "blockbench_plugin_file"];
    ok("E3b content-script status messages preserve all verified Blockbench fields into ui.setStatus", start >= 0 && end > start && fields.every((field) => listener.includes(field + ": msg." + field)));
  }
  {
    const famBlock = main.slice(main.indexOf("const COMMAND_FAMILIES = ["), main.indexOf("function familyOrderFor"));
    const c = {}; vm.runInNewContext(famBlock + "\nthis.F=COMMAND_FAMILIES;this.O=FAMILY_ORDER;", c);
    ok("E4 COMMAND_FAMILIES: blockbench family (re /^bb_/) second after blender, OTHER last; FAMILY_ORDER has a blockbench order (blockbench first) and every mode order holds every family exactly once", c.F[0].id === "blender" && c.F[1].id === "blockbench" && c.F[1].re.test("bb_cubes") && !c.F[1].re.test("blender_add_cube") && c.F.at(-1).id === "other" && c.O.blockbench[0] === "blockbench" && ["creation", "blender", "animate", "blockbench"].every((m) => new Set(c.O[m]).size === c.F.length && c.F.every((f) => c.O[m].includes(f.id))) && c.O.creation.slice(0, 3).join() === "script,blueprint,data" && c.O.blender[0] === "blender" && c.O.animate.slice(0, 3).join() === "animation,motion,script");
  }
  ok("E5 Blockbench catalogue + UI: mode-gated tools and the settings card use fresh, verified status, expose diagnostics, and provide real Check again / Copy plugin path actions", main.includes("function blockbenchModeTools(requested)") && (main.match(/allScoped\.push\(\.\.\.blockbenchModeTools\(requested\)\)/g) || []).length === 2 && main.includes('window.__rsBlockbench = () => blockbenchStatusState(s) === "connected"') && main.includes("function blockbenchCardHtml()") && main.includes('id="rs-blockbench-card"') && main.includes('data-state="${state}"') && main.includes('<code class="rs-bb-path">${escRs(pluginFile)}</code>') && main.includes("<em>File → Plugins → Load Plugin from File</em> → pick <code>TotalScript-Blockbench.js</code>") && main.includes('<button type="button" id="rs-mcp-blockbench" class="rs-blender-primary">Check again</button>') && main.includes('id="rs-blockbench-copy"') && main.includes('id="rs-blockbench-site"') && main.includes('menuEl.querySelector("#rs-mcp-blockbench")') && main.includes('menuEl.querySelector("#rs-blockbench-copy")') && main.includes('const r = await bg({ type: "blockbench_status", refresh: true });') && main.includes("const bbState = applyBlockbenchStatus(r);") && main.includes("Status diagnostic:") && main.includes("https://www.blockbench.net/") && main.includes("${blockbenchCardHtml()}") && !main.includes('id="rs-blockbench-url"'));
  ok("E6 overlay.css: Blockbench card recolour + mark + selectable plugin path, reduced-motion honoured", /\.rs-blender-card\.rs-bb-card \{ --bl: #1e9c86;/.test(css) && /\.rs-bb-mark::before/.test(css) && /\.rs-bb-path \{ display: inline-block; max-width: 100%; user-select: all; \}/.test(css) && !/\.rs-bb-url/.test(css) && /\.rs-blender-card\.rs-bb-card\.on \.rs-blender-mark \{ animation: none; \}/.test(css));

  // ── F. config.js ──────────────────────────────────────────────────────────
  {
    const c = { window: {}, console }; c.window = c; c.chrome = { runtime: { getURL: () => "" }, storage: { local: { get() {}, set() {} } } };
    vm.createContext(c);
    vm.runInContext(config + ";this.__RS=RS;", c, { filename: "config.js" });
    const RS = c.__RS;
    const full = RS.workModePrompt("blockbench"), tight = RS.workModePrompt("blockbench", { tight: true });
    ok("F1 WORK_MODE_PROMPTS keys creation,blender,animate,blockbench; label Blockbench; checklist; playbooks appended to full only", Object.keys(RS.WORK_MODE_PROMPTS).join() === "creation,blender,animate,blockbench" && RS.workModeLabel("blockbench") === "Blockbench" && /^BLOCKBENCH CHECK: bb_status first/.test(RS.workModeChecklist("blockbench")) && /PLAYBOOKS \(Blockbench mode/.test(full) && !/PLAYBOOKS/.test(tight));
    ok(`F2 budgets: full ${full.length} in (8000, 12000) (below the Animator profile), tight ${tight.length} in (1800, 2600)`, full.length > 8000 && full.length < 12000 && tight.length > 1800 && tight.length < 2600 && full.length < RS.workModePrompt("animate").length);
    ok("F3 profile teaches: FIRST MOVE bb_status; how to connect (Load Plugin from File); units 16 = one block; groups with pivots; meshes via bb_mesh_primitive / bb_mesh; bb_animate on groups; bb_screenshot after every pass; bb_export + Import 3D is the USER's click; bbmodel is for the user; never claim an import / asset id or invent names; no MCP wording left", /FIRST MOVE: bb_status \{\}/.test(full) && /16 = one block/.test(full) && /pivot/.test(full) && /bb_screenshot \{\} after EVERY build pass/.test(full) && /TotalScript does NOT upload or insert the file; the import is the user's click/.test(full) && /NEVER: build without a screenshot; claim an import, an asset id or a Studio placement; invent command names \(bb_tools lists them\)/.test(full) && /Load Plugin from File/.test(full) && /bb_mesh_primitive \{shape:"cylinder"\|"cone"\|"pyramid"\|"plane"\|"sphere"\|"torus"/.test(full) && /bb_mesh \{name, vertices, faces\}/.test(full) && /bb_animate \{name, loop, length, bones/.test(full) && /format:"bbmodel"/.test(full) && !/bb_call|MCP|jasonjgardner/.test(full + tight) && /FIRST MOVE: bb_status/.test(tight) && /Load Plugin from File/.test(tight) && /never uploads or inserts/.test(tight));
    const cited = new Set((full + tight + RS.workModeChecklist("blockbench")).match(/\bbb_[a-z_]+/g));
    ok("F4 every bb_* command the profile cites exists in the curated table (" + [...cited].join(", ") + ")", [...cited].every((n) => BB.COMMAND_NAMES.includes(n)), [...cited].filter((n) => !BB.COMMAND_NAMES.includes(n)));
    ok("F5 BLOCKBENCH IS CONNECTED block rides on window.__rsBlockbench, names the plugin (no MCP, no port) and lists the whole family with signatures; the Totality / Blender / Animator prompts are untouched (budget pins in test-work-modes hold)", config.includes("const isBlockbench = window.__rsBlockbench && window.__rsBlockbench();") && config.includes("if (isBlockbench) modeExtra += `\\n\\n━━━ BLOCKBENCH IS CONNECTED ━━━") && !config.includes("BLOCKBENCH MCP IS CONNECTED") && (() => { const m = config.match(/━━━ BLOCKBENCH IS CONNECTED ━━━[\s\S]*?`;/)[0]; if (!/own Blockbench plugin/.test(m) || !/no MCP, no port to configure/.test(m)) return false; return BB.COMMAND_NAMES.every((n) => m.includes(n)) && /never uploads/.test(m); })() && !/Blockbench|bb_/.test(RS.workModePrompt("creation")) && !/Blockbench|bb_/.test(RS.workModePrompt("blender")));
  }

  // ── G. popup ──────────────────────────────────────────────────────────────
  ok("G1 popup.js: Blockbench UI uses fresh, consistent verified status; launcher/category, path, Check again and copy actions remain wired with no URL/Connect path", popup.includes('const WORK_MODES = ["creation", "blender", "animate", "blockbench"];') && /blockbench: \{ thinking: "max", extra: false \}/.test(popup) && /blockbench: "Blockbench" \}/.test(popup) && popup.includes('if (/^bb_/.test(n)) return "blockbench";') && popup.includes('["roblox", "studio", "local", "agent", "blender", "blockbench"]') && popup.includes('{ id: "blockbench", type: "blockbench", label: "Blockbench"') && popup.includes('case "blockbench": {') && popup.includes('id="blockbench-check"') && popup.includes('id="blockbench-state"') && popup.includes('id="blockbench-path"') && popup.includes('const bbUp = blockbenchStatusState(s, true) === "connected";') && popup.includes('const bbState = blockbenchStatusState(r, false);') && popup.includes('bg({ type: "blockbench_status", refresh: false }).then(paint).catch(() => paint(null));') && popup.includes('bg({ type: "blockbench_status", refresh: true }).then(paint).catch(() => paint(null));') && popup.includes('const r = await bg({ type: "blockbench_status", refresh: true });') && !/blockbench_(connect|disconnect|set_url)\\b|blockbench-url|bb-mcp/.test(popup) && popup.includes('add({ id: "mode:blockbench", group: "Work mode", title: "Blockbench mode"') && popup.includes('$("blockbench")?.addEventListener("click"'));
  ok("G2 popup.html: four work cards in a 2 × 2 grid, Blockbench card (teal selected style) names the manual Import 3D, hidden #blockbench launcher; the three older cards unchanged", (popupHtml.match(/class="work-card" data-work="/g) || []).length === 4 && popupHtml.includes('<button type="button" class="work-card" data-work="blockbench" id="work-blockbench">') && popupHtml.includes(".work.work-modes{grid-template-columns:1fr 1fr}") && /#work-blockbench\.on\{background:linear-gradient\(135deg,#bff3e8/.test(popupHtml) && /Studio Import 3D<\/span>/.test(popupHtml) && popupHtml.includes('<button type="button" id="blockbench">Blockbench — open menu</button>') && popupHtml.includes("Low-poly models in Blockbench through the TotalScript plugin: groups → cubes → meshes → texture") && !/Blockbench[^<"]*MCP|MCP plugin/.test(popupHtml) && popupHtml.includes('data-work="creation" id="work-creation"') && popupHtml.includes('data-work="blender" id="work-blender"') && popupHtml.includes('data-work="animate" id="work-animate"'));
  {
    const pctx = { window: {}, console }; vm.createContext(pctx);
    vm.runInContext(popup.slice(popup.indexOf("const WORK_MODES = ["), popup.indexOf("const WORK_PRESETS")) + "\nthis.normalizeWorkMode = normalizeWorkMode;", pctx);
    ok("G3 popup normaliser keeps blockbench and still folds legacy ids to creation", pctx.normalizeWorkMode("blockbench") === "blockbench" && pctx.normalizeWorkMode("animator") === "creation" && pctx.normalizeWorkMode("x") === "creation");
  }
  ok("G4 popup badge: Blockbench appears only from a fresh, internally consistent verified status", popup.includes('const bbUp = blockbenchStatusState(s, true) === "connected";') && popup.includes('blockbenchStatusState(r, false)') && popup.includes('BLOCKBENCH_STATUS_MAX_AGE_MS - (Date.now() - checkedAt) + 1'));
  {
    const start = popup.indexOf("const BLOCKBENCH_STATUS_MAX_AGE_MS = 12000;");
    const end = popup.indexOf("// Sound volume", start);
    const statusCtx = { Date }; vm.createContext(statusCtx);
    vm.runInContext(popup.slice(start, end) + "\nthis.__bbStatus = blockbenchStatusState;", statusCtx);
    const state = statusCtx.__bbStatus, now = Date.now();
    const workerConnected = state({ blockbench_verified: true, blockbench_status: "connected", blockbench: true, blockbench_checked_at: now }, true);
    const directConnected = state({ verified: true, status: "connected", blockbench: true, checked_at: now }, false);
    const stale = state({ blockbench_verified: true, blockbench_status: "connected", blockbench: true, blockbench_checked_at: now - 12001 }, true);
    const mismatch = state({ verified: true, status: "connected", blockbench: false, checked_at: now }, false);
    const offline = state({ verified: true, status: "disconnected", blockbench: false, checked_at: now }, false);
    const callMismatch = state({ verified: true, status: "connected", blockbench: true, checked_at: now, call_mismatch: "conflict" }, false);
    ok("G5 popup rejects stale, contradictory and call-mismatched states as unknown across worker and direct status payloads", workerConnected === "connected" && directConnected === "connected" && stale === "unknown" && mismatch === "unknown" && offline === "disconnected" && callMismatch === "unknown");
  }

  // ── H. README ─────────────────────────────────────────────────────────────
  ok("H1 README: current 2.21.0 Blockbench section documents the 27-command contract, dedicated three-state status, plugin hand-off, tested suites and honest live/Rust limitations", /2\.21\.0/.test(readme) && /TotalScript-Blockbench\.js/.test(readme) && /Load Plugin from File/.test(readme) && /Import 3D/.test(readme) && /bb_animation_keyframe/.test(readme) && /dedicated `\/api\/blockbench\/status`/.test(readme) && /UNKNOWN|unknown/.test(readme) && /54 checks/.test(readme) && /45 checks/.test(readme) && /cargo` is unavailable/.test(readme) && /test-blockbench-mode\.js/.test(readme) && /test-blockbench-plugin\.js/.test(readme));

  console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
