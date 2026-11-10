// 2.18.0 — BLOCKBENCH MCP + work mode. MOCKED: no Blockbench, no Studio, no AI
// site. A fake MCP "Streamable HTTP" server (node http) stands in for the
// jasonjgardner/blockbench-mcp-plugin; the real client, the real curated
// command table and the real background.js code path run against it.
//   NODE_PATH=/path/to/node_modules node tests/test-blockbench-mode.js
//
// What this proves:
//   A. src/core/blockbench_mcp.js: loopback-only URL normalisation, SSE + JSON
//      body parsing, every bb_* command validates and maps onto the plugin's
//      REAL tool / parameter names (place_cube elements[], add_group, …),
//      bb_export paths land in <workspace>/blockbench_exports, render() quotes
//      the plugin and never invents a Studio import.
//   B. The client against the fake server: initialize → initialized →
//      tools/list (paged) → tools/call; Mcp-Session-Id round-trips; a 404
//      "session not found" re-initialises once; images come back as
//      {mimeType, data}; 403 "Origin not allowed" and a dead port are
//      explained; DELETE closes the session.
//   C. background.js in a vm: importScripts, connectBlockbench + blockbenchCall
//      end-to-end (status, invalid args, export path, screenshot, bb_tools,
//      bb_call guard), the declarativeNetRequest Origin session rule is added
//      on connect and removed on disconnect, call_tool routes bb_* before the
//      Blender / Studio paths, status + servers carry the link; manifest holds
//      the permission.
//   D. work_modes.js: 4th id, preflight / precondition / brief / auto-check.
//   E. main.js: WORK_MODES.blockbench, MODE_GATES.blockbench (model + export),
//      bb_ branch in runTool, families, settings card + handlers.
//   F. config.js profile + budgets; G. popup card / row / palette; H. README.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), http = require("http"), os = require("os");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400) : "")); } };

const BB = require(path.join(ROOT, "src/core/blockbench_mcp.js"));
const main = read("src/core/main.js"), config = read("src/core/config.js"), css = read("overlay.css"), popup = read("popup.js"), popupHtml = read("popup.html"), bg = read("background.js"), readme = read("README.md"), manifest = JSON.parse(read("manifest.json"));
const WM = require(path.join(ROOT, "src/core/work_modes.js"));

// ── fake Streamable HTTP MCP server ─────────────────────────────────────────
const RAW_TOOLS = [
  { name: "get_project_info", description: "Returns read-only project orientation.", inputSchema: { type: "object", properties: {} } },
  { name: "list_outline", description: "Outliner tree.", inputSchema: { type: "object", properties: { max_depth: { type: "integer" }, include_cubes: { type: "boolean" }, include_meshes: { type: "boolean" } } } },
  { name: "create_project", description: "Creates a project.", inputSchema: { type: "object", properties: { name: { type: "string" }, format: { type: "string" } }, required: ["name"] } },
  { name: "place_cube", description: "Creates cubes.", inputSchema: { type: "object", properties: { elements: { type: "array" }, texture: { type: "string" }, group: { type: "string" }, faces: {} }, required: ["elements"] } },
  { name: "modify_cube", description: "Modifies a cube.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "add_group", description: "Adds a group.", inputSchema: { type: "object", properties: { name: { type: "string" }, origin: {}, rotation: {}, parent: { type: "string" } }, required: ["name"] } },
  { name: "remove_element", description: "Removes.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "create_texture", description: "Creates a texture.", inputSchema: { type: "object", properties: { name: { type: "string" }, width: {}, height: {}, fill_color: {}, data: {} }, required: ["name"] } },
  { name: "apply_texture", description: "Applies a texture.", inputSchema: { type: "object", properties: { id: {}, texture: {}, applyTo: {} }, required: ["id", "texture"] } },
  { name: "list_textures", description: "Lists textures.", inputSchema: { type: "object", properties: {} } },
  { name: "create_animation", description: "Creates an animation.", inputSchema: { type: "object", properties: { name: {}, loop: {}, animation_length: {}, bones: {} }, required: ["name"] } },
  { name: "set_camera_angle", description: "Camera.", inputSchema: { type: "object", properties: { position: {}, target: {}, projection: {} }, required: ["position", "projection"] } },
  { name: "capture_screenshot", description: "Viewport PNG.", inputSchema: { type: "object", properties: { max_size: {} } } },
  { name: "list_export_formats", description: "Codecs.", inputSchema: { type: "object", properties: {} } },
  { name: "export_model", description: "Exports.", inputSchema: { type: "object", properties: { codec_id: {}, options: {}, path: {}, overwrite: {}, max_content_length: {}, result_format: {} } } },
  { name: "undo", description: "Undo.", inputSchema: { type: "object", properties: {} } },
  { name: "redo", description: "Redo.", inputSchema: { type: "object", properties: {} } },
  { name: "paint_fill_tool", description: "Fills.", inputSchema: { type: "object", properties: { texture: {}, color: {} } } },
  { name: "boom", description: "Always fails (isError).", inputSchema: { type: "object", properties: {} } },
];
const PNG_B64 = Buffer.from("\x89PNG\r\n\x1a\n" + "x".repeat(200)).toString("base64");
function makeServer(opts) {
  const o = opts || {};
  const state = { sessions: new Set(), initCount: 0, calls: [], requests: [], sseOnce: !!o.sseOnce, rejectOrigin: !!o.rejectOrigin, dropNext: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers });
      const json = (status, obj, extra) => { res.writeHead(status, Object.assign({ "content-type": "application/json" }, extra || {})); res.end(JSON.stringify(obj)); };
      if (req.url !== "/bb-mcp") { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not Found"); return; }
      if (state.rejectOrigin && req.headers.origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin)) { json(403, { jsonrpc: "2.0", error: { code: -32000, message: "Forbidden: Origin not allowed: " + req.headers.origin }, id: null }); return; }
      const sid = req.headers["mcp-session-id"];
      if (req.method === "DELETE") { state.sessions.delete(sid); res.writeHead(204); res.end(); return; }
      if (req.method !== "POST") { json(405, { error: "method" }); return; }
      const accept = String(req.headers.accept || "");
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) { json(406, { jsonrpc: "2.0", error: { code: -32000, message: "Not Acceptable: Client must accept both application/json and text/event-stream" }, id: null }); return; }
      let msg; try { msg = JSON.parse(body); } catch { json(400, { error: "bad json" }); return; }
      const isInit = msg.method === "initialize";
      if (sid && !state.sessions.has(sid)) { json(404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found. Please reinitialize." }, id: null }); return; }
      if (!sid && !isInit) { json(400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" }, id: null }); return; }
      if (isInit) {
        const id = "sess-" + (++state.initCount) + "-" + Math.random().toString(36).slice(2, 8);
        state.sessions.add(id);
        json(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-blockbench-mcp", version: "1.10.1" }, instructions: "fake" } }, { "mcp-session-id": id });
        return;
      }
      if (msg.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      if (msg.method === "tools/list") {
        const cursor = msg.params && msg.params.cursor;
        const page = cursor === "p2" ? RAW_TOOLS.slice(10) : RAW_TOOLS.slice(0, 10);
        const result = { tools: page }; if (!cursor) result.nextCursor = "p2";
        json(200, { jsonrpc: "2.0", id: msg.id, result }); return;
      }
      if (msg.method === "tools/call") {
        const name = msg.params && msg.params.name, args = (msg.params && msg.params.arguments) || {};
        state.calls.push({ name, args });
        if (state.dropNext) { state.dropNext = false; state.sessions.delete(sid); json(404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found. Please reinitialize." }, id: null }); return; }
        let result;
        if (name === "get_project_info") result = { content: [{ type: "text", text: JSON.stringify({ format: "free", name: "FakeProject", texture_width: 16, texture_height: 16, elements: { cubes: 3, groups: 2 } }) }] };
        else if (name === "list_outline") result = { content: [{ type: "text", text: "Root\n  Body (group)\n    Torso (cube)\n  Head (group)" }] };
        else if (name === "capture_screenshot") result = { content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] };
        else if (name === "export_model") result = { content: [{ type: "text", text: JSON.stringify({ codec: args.codec_id, written: args.path || null, content: args.path ? null : "o cube\nv 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3" }) }] };
        else if (name === "place_cube") result = { content: [{ type: "text", text: "Placed " + (args.elements || []).length + " cube(s)" + (args.group ? " in " + args.group : "") }] };
        else if (name === "boom") result = { isError: true, content: [{ type: "text", text: "Tool boom exploded" }] };
        else if (!RAW_TOOLS.some((t) => t.name === name)) { json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Tool " + name + " not found" } }); return; }
        else result = { content: [{ type: "text", text: name + " ok " + JSON.stringify(args) }] };
        if (state.sseOnce) {
          state.sseOnce = false;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n\n");
          return;
        }
        json(200, { jsonrpc: "2.0", id: msg.id, result }); return;
      }
      json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port, url: "http://127.0.0.1:" + server.address().port + "/bb-mcp" })));
}

(async () => {
  // ── A. pure module ────────────────────────────────────────────────────────
  ok("A1 module: VERSION 2.18.0, default URL localhost:3000/bb-mcp, 14 curated commands all bb_*, toolList tags server blockbench", BB.VERSION === "2.18.0" && BB.DEFAULT_URL === "http://localhost:3000/bb-mcp" && BB.COMMAND_NAMES.length === 14 && BB.COMMAND_NAMES.every((n) => /^bb_[a-z_]+$/.test(n)) && BB.toolList().every((t) => t.server === "blockbench" && t.inputSchema && t.description));
  const n1 = BB.normalizeUrl(""), n2 = BB.normalizeUrl("localhost:3100/bb-mcp/"), n3 = BB.normalizeUrl("http://evil.example.com:3000/bb-mcp"), n4 = BB.normalizeUrl("http://127.0.0.1:3000/bb-mcp?x=1"), n5 = BB.normalizeUrl("http://[::1]:3000/custom");
  ok("A2 normalizeUrl: empty → default; bare host:port gets http + trailing slash trimmed; remote host, query string rejected; ::1 allowed", n1.ok && n1.url === BB.DEFAULT_URL && n1.port === 3000 && n1.origin === "http://localhost:3000" && n2.ok && n2.url === "http://localhost:3100/bb-mcp" && n2.port === 3100 && !n3.ok && /this computer/.test(n3.error) && !n4.ok && n5.ok && n5.url === "http://[::1]:3000/custom", { n1, n2, n3, n4, n5 });
  const sse = BB.parseSse("event: message\ndata: {\"a\":1}\n\n: keepalive\n\ndata: {\"b\":\ndata: 2}\n\n");
  ok("A3 parseSse: two events, comment lines ignored, multi-line data joined; parseBody picks JSON vs SSE by content-type", sse.length === 2 && sse[0].a === 1 && sse[1].b === 2 && BB.parseBody("application/json", "{\"x\":1}")[0].x === 1 && BB.parseBody("text/event-stream", "data: {\"y\":2}\n\n")[0].y === 2);
  const p1 = BB.plan("bb_cubes", { cubes: [{ name: "Torso", from: [-4, 0, -2], to: [4, 12, 2], origin: [0, 0, 0] }, { name: "Head", from: [-4, 12, -4], to: [4, 20, 4], inflate: 0.5 }], group: "Body", texture: "skin" });
  ok("A4 bb_cubes → place_cube {elements:[{name,from,to,…}], group, texture} (the plugin's real parameter names)", p1.ok && p1.steps.length === 1 && p1.steps[0].tool === "place_cube" && p1.steps[0].args.elements.length === 2 && p1.steps[0].args.elements[1].inflate === 0.5 && p1.steps[0].args.group === "Body" && p1.steps[0].args.texture === "skin" && !("cubes" in p1.steps[0].args), p1);
  const bad = [
    BB.plan("bb_cubes", { cubes: [] }), BB.plan("bb_cubes", { cubes: [{ name: "x", from: [0, 0], to: [1, 1, 1] }] }), BB.plan("bb_cubes", { cubes: [{ from: [0, 0, 0], to: [1, 1, 1] }] }),
    BB.plan("bb_group", {}), BB.plan("bb_texture", { action: "create" }), BB.plan("bb_texture", { action: "create", name: "t", width: 8 }), BB.plan("bb_texture", { action: "paint" }),
    BB.plan("bb_animate", { name: "idle", bones: {} }), BB.plan("bb_animate", { name: "idle", bones: { Head: [{ time: 0 }] } }), BB.plan("bb_camera", { position: [1, 2] }), BB.plan("bb_camera", { position: [1, 2, 3], projection: "perspective", locked_angle: "top" }),
    BB.plan("bb_export", { format: "fbx2" }), BB.plan("bb_screenshot", { max_size: 10 }), BB.plan("bb_undo", { action: "twice" }), BB.plan("bb_call", {}), BB.plan("bb_cube_edit", { id: "Torso" }), BB.plan("bb_remove", {}), BB.plan("bb_project", {}), BB.plan("nope", {}),
  ];
  ok("A5 validation: 19 bad calls all refused with ERROR … before any MCP call (empty cubes, 2-vector, missing name, bad action, size < 16, empty bones, keyframe without channel, locked_angle + perspective, unknown format, tiny screenshot, unknown command)", bad.every((b) => b && b.ok === false && /^ERROR (INVALID_ARGUMENT|UNKNOWN_COMMAND)/.test(b.error)), bad.map((b) => b.error));
  const p2 = BB.plan("bb_group", { name: "ArmL", origin: [4, 20, 0], parent: "Body" }), p3 = BB.plan("bb_texture", { action: "create", name: "wood", width: 32, height: 32, fill_color: "#8b5a2b" }), p4 = BB.plan("bb_texture", { action: "apply", id: "Torso", texture: "wood", applyTo: "all" });
  const p5 = BB.plan("bb_animate", { name: "walk", loop: true, length: 1, bones: { ArmL: [{ time: 0, rotation: [20, 0, 0] }, { time: 0.5, rotation: [-20, 0, 0] }], LegL: [{ time: 0, rotation: [-20, 0, 0] }] } });
  const p6 = BB.plan("bb_camera", { position: [40, 30, 40], target: [0, 10, 0], projection: "perspective", fov: 50 }), p7 = BB.plan("bb_undo", {}), p8 = BB.plan("bb_status", {}), p9 = BB.plan("bb_project", { name: "Sword" }), p10 = BB.plan("bb_cube_edit", { id: "Torso", to: [4, 14, 2], name: "Chest" });
  ok("A6 mappings: add_group {name, origin, parent} · create_texture {name,width,height,fill_color} · apply_texture {id,texture,applyTo} · create_animation {name,loop,animation_length,bones} · set_camera_angle {position,target,projection,fov} · undo · get_project_info + optional list_outline · create_project format free · modify_cube {id,to,name}",
    p2.ok && p2.steps[0].tool === "add_group" && p2.steps[0].args.parent === "Body" && p2.steps[0].args.origin[1] === 20
    && p3.ok && p3.steps[0].tool === "create_texture" && p3.steps[0].args.width === 32 && p3.steps[0].args.fill_color === "#8b5a2b"
    && p4.ok && p4.steps[0].tool === "apply_texture" && p4.steps[0].args.applyTo === "all"
    && p5.ok && p5.steps[0].tool === "create_animation" && p5.steps[0].args.loop === true && p5.steps[0].args.animation_length === 1 && Object.keys(p5.steps[0].args.bones).join() === "ArmL,LegL" && !("length" in p5.steps[0].args)
    && p6.ok && p6.steps[0].tool === "set_camera_angle" && p6.steps[0].args.projection === "perspective" && p6.steps[0].args.fov === 50
    && p7.ok && p7.steps[0].tool === "undo" && p8.ok && p8.steps[0].tool === "get_project_info" && p8.steps[1].tool === "list_outline" && p8.steps[1].optional === true
    && p9.ok && p9.steps[0].tool === "create_project" && p9.steps[0].args.format === "free" && p10.ok && p10.steps[0].tool === "modify_cube" && p10.steps[0].args.name === "Chest" && p10.steps[0].args.to[1] === 14, { p2, p3, p4, p5, p6 });
  const toolsSet = new Set(RAW_TOOLS.map((t) => t.name));
  const e1 = BB.plan("bb_export", { format: "obj", name: "Hero Sword!" }, { tools: toolsSet, exportRoot: "C:\\Users\\me\\TotalScript" }), e2 = BB.plan("bb_export", { format: "glb", scale: 2 }, { tools: toolsSet, exportRoot: "/home/me/ws/" }), e3 = BB.plan("bb_export", { format: "gltf" }, { tools: toolsSet, exportRoot: "" }), e4 = BB.plan("bb_export", { format: "obj" }, { tools: new Set(["place_cube"]), exportRoot: "/x" }), e5 = BB.plan("bb_export", { format: "bbmodel", overwrite: true }, { tools: toolsSet, exportRoot: "/x" });
  ok("A7 bb_export: export_model {codec_id obj|gltf|project, options.encoding for glb, path <root>/blockbench_exports/<safe name>.<ext>, overwrite false unless asked, max_content_length 0 when a path is written, 2 000 000 inline otherwise}; plugin without export_model → honest error",
    e1.ok && e1.steps[0].tool === "export_model" && e1.steps[0].args.codec_id === "obj" && e1.steps[0].args.path === "C:\\Users\\me\\TotalScript\\blockbench_exports\\Hero_Sword.obj" && e1.steps[0].args.overwrite === false && e1.steps[0].args.max_content_length === 0 && e1.steps[0].args.result_format === "text"
    && e2.ok && e2.steps[0].args.codec_id === "gltf" && e2.steps[0].args.options.encoding === "binary" && e2.steps[0].args.options.scale === 2 && /^\/home\/me\/ws\/blockbench_exports\/TotalScript_\d{14}\.glb$/.test(e2.steps[0].args.path)
    && e3.ok && !("path" in e3.steps[0].args) && e3.steps[0].args.max_content_length === 2000000 && e3.steps[0].args.options.encoding === "ascii"
    && !e4.ok && /does not offer export_model/.test(e4.error) && e5.ok && e5.steps[0].args.codec_id === "project" && e5.steps[0].args.overwrite === true && e5.meta.ext === "bbmodel", { e1: e1.steps && e1.steps[0].args, e2: e2.steps && e2.steps[0].args, e4: e4.error });
  const c1 = BB.plan("bb_call", { tool: "paint_fill_tool", args: { texture: "wood", color: "#fff" } }, { tools: toolsSet }), c2 = BB.plan("bb_call", { tool: "paint_fill", args: {} }, { tools: toolsSet }), c3 = BB.plan("bb_call", { tool: "bb_cubes" }, { tools: toolsSet });
  ok("A8 bb_call: exact plugin tool passes its own args through; an unknown name is refused with near matches; bb_* names are redirected", c1.ok && c1.steps[0].tool === "paint_fill_tool" && c1.steps[0].args.color === "#fff" && !c2.ok && /no tool named 'paint_fill'/.test(c2.error) && /paint_fill_tool/.test(c2.error) && !c3.ok && /TotalScript command/.test(c3.error));
  const r1 = BB.render("bb_export", e1, [{ tool: "export_model", result: { content: [{ type: "text", text: "{\"written\":true}" }] } }], {});
  const r2 = BB.render("bb_export", e3, [{ tool: "export_model", result: { content: [{ type: "text", text: "o cube" }] } }], {});
  const r3 = BB.render("bb_status", p8, [{ tool: "get_project_info", result: { content: [{ type: "text", text: "{\"format\":\"free\"}" }] } }, { tool: "list_outline", error: "no project", optional: true }], {});
  const r4 = BB.render("bb_cubes", p1, [{ tool: "place_cube", result: { isError: true, content: [{ type: "text", text: "Group Body not found" }] } }], {});
  const r5 = BB.render("bb_screenshot", null, [{ tool: "capture_screenshot", result: { content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] } }], {});
  ok("A9 render: export quotes the plugin + the path + the MANUAL Import 3D steps (never 'imported'); inline export says save it yourself; optional step failure is a note, not an error; isError → ERROR in bb_cubes (place_cube); screenshot → images[]",
    /File: C:\\Users\\me\\TotalScript\\blockbench_exports\\Hero_Sword\.obj/.test(r1.text) && /Import 3D/.test(r1.text) && /does not upload/.test(r1.text) && !/imported into Studio|is now in Studio/i.test(r1.text) && !r1.error
    && /Save it as <name>\.gltf yourself/.test(r2.text) && /\[get_project_info\]/.test(r3.text) && /list_outline skipped: no project/.test(r3.text) && !r3.error
    && r4.error === "ERROR in bb_cubes (place_cube): Group Body not found" && r5.images.length === 1 && r5.images[0].mimeType === "image/png" && r5.images[0].data === PNG_B64, { r1: r1.text, r2: r2.text, r3: r3.text, r4 });
  ok("A10 describeTools: name + {params, optional?} + clipped description; filter narrows; isCommand recognises bb_* only", /^19 raw tool\(s\)/.test(BB.describeTools(RAW_TOOLS)) && /- place_cube \{elements, texture\?, group\?, faces\?\}/.test(BB.describeTools(RAW_TOOLS)) && /^1 raw tool/.test(BB.describeTools(RAW_TOOLS, "paint")) && BB.isCommand("bb_cubes") && BB.isCommand("blockbench/bb_export") && !BB.isCommand("place_cube") && !BB.isCommand("blender_add_cube"));

  // ── B. client vs fake server ──────────────────────────────────────────────
  const srv = await makeServer({ sseOnce: true });
  const client = BB.createClient({ url: srv.url, fetch, timeoutMs: 5000 });
  const conn = await client.connect();
  const initReq = srv.state.requests.find((r) => r.method === "POST");
  ok("B1 connect: initialize (Accept json+sse, protocolVersion 2025-06-18, clientInfo TotalScript) → session id captured → notifications/initialized carried the Mcp-Session-Id → tools/list paged through nextCursor (19 tools)", conn.ok && /^sess-1-/.test(conn.sessionId) && conn.serverInfo.name === "fake-blockbench-mcp" && client.tools.length === 19 && /application\/json/.test(initReq.headers.accept) && /text\/event-stream/.test(initReq.headers.accept) && srv.state.requests.filter((r) => r.method === "POST").slice(1).every((r) => r.headers["mcp-session-id"] === conn.sessionId && r.headers["mcp-protocol-version"] === "2025-06-18"), conn);
  const t1 = await client.callTool("get_project_info", {}, 5000);
  ok("B2 tools/call over an SSE body (first call) parses the event stream and returns the result", /FakeProject/.test(BB.resultText(t1)));
  const t2 = await client.callTool("capture_screenshot", { max_size: 512 }, 5000);
  ok("B3 image content → resultImages [{mimeType, data}]", BB.resultImages(t2).length === 1 && BB.resultImages(t2)[0].data === PNG_B64 && srv.state.calls.at(-1).args.max_size === 512);
  srv.state.dropNext = true;
  const t3 = await client.callTool("list_textures", {}, 5000);
  ok("B4 session lost (404 'Session not found') → one transparent re-initialize + retry; the second call succeeded on a NEW session", /list_textures ok/.test(BB.resultText(t3)) && srv.state.initCount === 2 && /^sess-2-/.test(client.sessionId));
  let rpcErr = null; try { await client.callTool("no_such_tool", {}, 5000); } catch (e) { rpcErr = e; }
  ok("B5 JSON-RPC error → McpError RPC_ERROR with the server's message", rpcErr && rpcErr.code === "RPC_ERROR" && /Tool no_such_tool not found/.test(rpcErr.message));
  await client.close();
  ok("B6 close(): DELETE with the session header; server forgot the session; sessionId cleared", srv.state.requests.at(-1).method === "DELETE" && srv.state.sessions.size === 0 && client.sessionId === "");
  const srvO = await makeServer({ rejectOrigin: true });
  const cO = BB.createClient({ url: srvO.url, fetch: (u, init) => fetch(u, Object.assign({}, init, { headers: Object.assign({}, init.headers, { Origin: "chrome-extension://abcdefgh" }) })), timeoutMs: 5000 });
  let oErr = null; try { await cO.connect(); } catch (e) { oErr = e; }
  ok("B7 a chrome-extension:// Origin is refused by the plugin's guard → McpError ORIGIN_REJECTED naming the declarativeNetRequest rule (why the worker rewrites Origin)", oErr && oErr.code === "ORIGIN_REJECTED" && oErr.status === 403 && /declarativeNetRequest/.test(oErr.message));
  srvO.server.close();
  const dead = BB.createClient({ url: "http://127.0.0.1:1/bb-mcp", fetch, timeoutMs: 3000 });
  let dErr = null; try { await dead.connect(); } catch (e) { dErr = e; }
  ok("B8 nothing listening → UNREACHABLE with the URL in the message", dErr && dErr.code === "UNREACHABLE" && /127\.0\.0\.1:1\/bb-mcp/.test(dErr.message));
  let badUrl = null; try { BB.createClient({ url: "http://example.com/bb-mcp", fetch }); } catch (e) { badUrl = e; }
  ok("B9 createClient refuses a non-loopback URL (BAD_URL)", badUrl && badUrl.code === "BAD_URL");

  // ── C. background.js in a vm against the fake server ──────────────────────
  {
    const rules = [];
    const stored = {};
    function stub(name) { const f = function () { return stub(name + "()"); }; return new Proxy(f, { get(t, k) { if (k === "then") return undefined; if (typeof k === "symbol") return undefined; return stub(name + "." + String(k)); }, apply() { return stub(name + "()"); } }); }
    const ctx = { chrome: stub("chrome"), console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, fetch: (u, init) => fetch(u, init), AbortController, WebSocket: class { constructor() {} close() {} send() {} }, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Blob, FormData, crypto, performance, Headers };
    ctx.self = ctx; ctx.globalThis = ctx;
    ctx.importScripts = (p) => vm.runInContext(read(p), ctx, { filename: p });
    vm.createContext(ctx);
    vm.runInContext(bg, ctx, { filename: "background.js" });
    ok("C1 background.js importScripts src/core/blockbench_mcp.js (classic worker) and the module is visible to it", /importScripts\("src\/core\/blockbench_mcp\.js"\)/.test(bg) && vm.runInContext("typeof TotalBlockbenchMcp", ctx) === "object");
    ctx.chrome = {
      runtime: { getPlatformInfo: async () => ({ os: "linux" }), getURL: (n) => n, sendMessage: async () => {} },
      tabs: { query: async () => [], sendMessage: async () => {} },
      storage: { local: { get: (k, cb) => { const out = {}; for (const key of Array.isArray(k) ? k : [k]) if (key in stored) out[key] = stored[key]; return cb ? cb(out) : Promise.resolve(out); }, set: async (o) => { Object.assign(stored, o); } } },
      declarativeNetRequest: { updateSessionRules: async (o) => { rules.push(o); } },
    };
    ctx.agentWorkspaceRoot = async () => "/tmp/total_ws";
    const srvB = await makeServer({});
    const cr = await ctx.connectBlockbench(srvB.url);
    const st = await new Promise((res) => vm.runInContext("statusObj", ctx) && res(vm.runInContext("statusObj()", ctx)));
    ok("C2 connectBlockbench(url): ok, 19 plugin tools, status carries blockbench:true + url; servers list gains {id:'blockbench', alive, tools 14, raw_tools 19}; curated bb_* merged into list_tools", cr && cr.ok && cr.blockbench && cr.tools === 19 && st.blockbench === true && st.blockbench_url === srvB.url && vm.runInContext("blenderServers([])", ctx).some((s) => s.id === "blockbench" && s.alive && s.tools === 14 && s.raw_tools === 19) && vm.runInContext("mergeBlenderTools([])", ctx).filter((t) => t.server === "blockbench").length === 14 && stored["rs-blockbench-on"] === true, { cr, st });
    const rule = rules.at(-1) && rules.at(-1).addRules && rules.at(-1).addRules[0];
    ok("C3 connect installed ONE declarativeNetRequest session rule: modifyHeaders set Origin → the plugin's own origin, scoped to that exact URL (urlFilter |url), xmlhttprequest, post/get/delete; the id is removed first (idempotent)", rule && rule.id === 215001 && rule.action.type === "modifyHeaders" && rule.action.requestHeaders[0].header === "Origin" && rule.action.requestHeaders[0].operation === "set" && rule.action.requestHeaders[0].value === "http://127.0.0.1:" + srvB.port && rule.condition.urlFilter === "|" + srvB.url && rule.condition.resourceTypes.join() === "xmlhttprequest" && rules.at(-1).removeRuleIds.join() === "215001", rules.at(-1));
    const s1 = await ctx.blockbenchCall("bb_status", {}, 20000);
    ok("C4 blockbenchCall bb_status → get_project_info + list_outline quoted under [tool] headings", s1 && s1.ok && /\[get_project_info\] .*FakeProject/.test(s1.text) && /\[list_outline\] Root/.test(s1.text), s1);
    const s2 = await ctx.blockbenchCall("bb_cubes", { cubes: [{ name: "x", from: [0, 0, 0], to: [1, 1] }] }, 20000);
    const callsBefore = srvB.state.calls.length;
    ok("C5 invalid args are refused in the worker (kind validation, INVALID_ARGUMENT) and NOTHING is sent to Blockbench", s2 && s2.ok === false && s2.kind === "validation" && /^ERROR INVALID_ARGUMENT in bb_cubes/.test(s2.error) && srvB.state.calls.length === callsBefore);
    const s3 = await ctx.blockbenchCall("bb_cubes", { cubes: [{ name: "Torso", from: [-4, 0, -2], to: [4, 12, 2] }], group: "Body" }, 20000);
    ok("C6 bb_cubes end-to-end: place_cube received elements[] + group; the plugin's own text is returned", s3 && s3.ok && /Placed 1 cube\(s\) in Body/.test(s3.text) && srvB.state.calls.at(-1).name === "place_cube" && srvB.state.calls.at(-1).args.elements[0].name === "Torso");
    const s4 = await ctx.blockbenchCall("bb_export", { format: "obj", name: "sword" }, 20000);
    ok("C7 bb_export: path = <agent workspace>/blockbench_exports/sword.obj passed to export_model (max_content_length 0, overwrite false); result reports the path + manual Import 3D; response carries .path", s4 && s4.ok && s4.path === "/tmp/total_ws/blockbench_exports/sword.obj" && srvB.state.calls.at(-1).name === "export_model" && srvB.state.calls.at(-1).args.path === s4.path && srvB.state.calls.at(-1).args.max_content_length === 0 && srvB.state.calls.at(-1).args.overwrite === false && /Import 3D/.test(s4.text) && /does not upload/.test(s4.text), s4);
    ctx.agentWorkspaceRoot = async () => "";
    const s4b = await ctx.blockbenchCall("bb_export", { format: "gltf" }, 20000);
    ok("C8 bb_export without an agent workspace: no path, inline content requested (2 000 000) and the user is told to save it", s4b && s4b.ok && !s4b.path && !("path" in srvB.state.calls.at(-1).args) && srvB.state.calls.at(-1).args.max_content_length === 2000000 && /Save it as <name>\.gltf yourself/.test(s4b.text));
    const s5 = await ctx.blockbenchCall("bb_screenshot", {}, 20000);
    ok("C9 bb_screenshot → images [{mimeType image/png, data}] in the extension's screenshot shape (max_size 1024 default)", s5 && s5.ok && s5.images.length === 1 && s5.images[0].mimeType === "image/png" && srvB.state.calls.at(-1).args.max_size === 1024);
    const s6 = await ctx.blockbenchCall("bb_tools", { filter: "texture" }, 20000);
    const s7 = await ctx.blockbenchCall("bb_call", { tool: "nonexistent_tool", args: {} }, 20000);
    const s8 = await ctx.blockbenchCall("bb_call", { tool: "paint_fill_tool", args: { texture: "t", color: "#f00" } }, 20000);
    ok("C10 bb_tools lists the discovered raw tools (no MCP call); bb_call refuses unknown names and passes known ones through verbatim", s6 && s6.ok && /raw tool\(s\)/.test(s6.text) && /create_texture/.test(s6.text) && /apply_texture/.test(s6.text) && s7 && s7.ok === false && /no tool named 'nonexistent_tool'/.test(s7.error) && s8 && s8.ok && srvB.state.calls.at(-1).name === "paint_fill_tool" && srvB.state.calls.at(-1).args.color === "#f00");
    const s9 = await ctx.blockbenchCall("bb_call", { tool: "boom" }, 20000);
    ok("C11 a tool result with isError:true becomes ok:false kind execution 'ERROR in bb_call (boom): …'", s9 && s9.ok === false && s9.kind === "execution" && s9.error === "ERROR in bb_call (boom): Tool boom exploded", s9);
    await ctx.disconnectBlockbench();
    const after = vm.runInContext("statusObj()", ctx);
    ok("C12 disconnect: session DELETEd, status blockbench:false, DNR rule removed (removeRuleIds only), servers list no longer has blockbench, flag persisted false", srvB.state.requests.at(-1).method === "DELETE" && after.blockbench === false && rules.at(-1).removeRuleIds.join() === "215001" && rules.at(-1).addRules.length === 0 && !vm.runInContext("blenderServers([])", ctx).some((s) => s.id === "blockbench") && stored["rs-blockbench-on"] === false);
    const s10 = await ctx.blockbenchCall("bb_status", {}, 20000);
    ok("C13 after disconnect a bb_* call answers kind disconnected / BLOCKBENCH_OFFLINE with the connect steps (the flag is off, so no silent auto-reconnect)", s10 && s10.ok === false && s10.kind === "disconnected" && s10.errorCode === "BLOCKBENCH_OFFLINE" && /Connect/.test(s10.error));
    srvB.server.close();
    srv.server.close();
  }
  ok("C14 background: call_tool routes TotalBlockbenchMcp.isCommand(msg.name) BEFORE the Blender and engine paths; messages blockbench_connect / status / disconnect / set_url; add_server 'blockbench' → connectBlockbench; storage key rsBlockbenchUrl",
    bg.indexOf('TotalBlockbenchMcp.isCommand(msg.name)') > 0 && bg.indexOf('TotalBlockbenchMcp.isCommand(msg.name)') < bg.indexOf('if (blenderAddon && isBlenderToolName(msg.name)) {') && ["blockbench_connect", "blockbench_status", "blockbench_disconnect", "blockbench_set_url"].every((m) => bg.includes(`case "${m}": {`)) && bg.includes('String(msg.server_id || "").toLowerCase() === "blockbench"') && bg.includes('const BB_URL_KEY = "rsBlockbenchUrl";'));
  ok("C15 background explains the port-3000 clash with the desktop agent (bbPortConflict) and the Origin guard; manifest grants declarativeNetRequestWithHostAccess (no new host permission) and keeps localhost + 127.0.0.1", /Port 3000 is taken by the TotalScript desktop agent/.test(bg) && /async function bbPortConflict/.test(bg) && /Origin: chrome-extension:/.test(bg) && manifest.permissions.includes("declarativeNetRequestWithHostAccess") && manifest.host_permissions.includes("http://localhost/*") && manifest.host_permissions.includes("http://127.0.0.1/*") && !manifest.permissions.includes("declarativeNetRequest"));

  // ── D. work_modes.js ──────────────────────────────────────────────────────
  ok("D1 TotalWorkModes: ids creation/blender/animate/blockbench, badge BLOCKBENCH, DOES text names the manual Import 3D, GATE_LABEL has model + export", JSON.stringify(WM.IDS) === JSON.stringify(["creation", "blender", "animate", "blockbench"]) && WM.BADGE.blockbench === "BLOCKBENCH" && /Import 3D/.test(WM.DOES.blockbench) && WM.GATE_LABEL.model === "MODEL" && WM.GATE_LABEL.export === "EXPORT" && WM.normalize("blockbench") === "blockbench");
  const pre = WM.precondition("blockbench", { blockbenchConnected: false }), preOk = WM.precondition("blockbench", { blockbenchConnected: true });
  ok("D2 precondition: not connected → hard stop (title, message with the plugin URL + Connect, brief forbids emulating Blockbench); connected → ok", !pre.ok && /not connected/.test(pre.title) && /jasonjgardner\.github\.io/.test(pre.message) && /Do NOT emulate Blockbench/.test(pre.brief) && pre.brief.startsWith("━━━ BLOCKBENCH PREFLIGHT") && preOk.ok === true);
  const pf = WM.preflight("blockbench", { engine: "roblox", blockbenchConnected: true });
  ok("D3 preflight probe = {kind blockbench, tool bb_status}; none when disconnected or on the local engine", pf && pf.kind === "blockbench" && pf.tool === "bb_status" && WM.preflight("blockbench", { engine: "roblox", blockbenchConnected: false }) === null && WM.preflight("blockbench", { engine: "local", blockbenchConnected: true }) === null);
  const brief = WM.renderBrief("blockbench", "[get_project_info] {\"format\":\"free\",\"elements\":{\"cubes\":3}}", {}), briefNone = WM.renderBrief("blockbench", null, {});
  ok("D4 renderBrief quotes the project read, states the MODEL / EXPORT rules and 'facts read from Blockbench'; null data → 'could not be read' + bb_project hint; ≤ BRIEF_MAX", /Blockbench project \(bb_status/.test(brief) && /cubes/.test(brief) && /EXPORT gate/.test(brief) && /facts read from Blockbench/.test(brief) && brief.length <= WM.BRIEF_MAX && /could not be read/.test(briefNone) && /bb_project/.test(briefNone) && WM.briefSummary("blockbench", "x") === "Blockbench project read");
  const ac1 = WM.autoCheck("blockbench", "bb_cubes", { cubes: [{ name: "Torso" }] }, "Output of 'bb_cubes':\nPlaced 1"), ac2 = WM.autoCheck("blockbench", "bb_screenshot", {}, "ok"), ac3 = WM.autoCheck("blockbench", "bb_texture", { action: "list" }, "ok"), ac4 = WM.autoCheck("blockbench", "bb_cubes", {}, "ERROR INVALID_ARGUMENT"), ac5 = WM.autoCheck("blockbench", "bb_call", { tool: "get_selection" }, "ok"), ac6 = WM.autoCheck("blockbench", "bb_call", { tool: "place_mesh" }, "ok");
  ok("D5 autoCheck: builds (bb_cubes, bb_call with a mutating tool) → bb_status read-back; read-only (bb_screenshot, bb_texture list, bb_call get_*) and errors → none", ac1 && ac1.kind === "blockbench" && ac1.tool === "bb_status" && ac2 === null && ac3 === null && ac4 === null && ac5 === null && ac6 && ac6.label === "place_mesh");
  ok("D6 renderAutoCheck: '[MODE AUTO-CHECK bb_status after bb_cubes] …' clipped to AUTO_MAX; empty raw → ''", /^\[MODE AUTO-CHECK bb_status after bb_cubes\] \[get_project_info\]/.test(WM.renderAutoCheck(ac1, "[get_project_info] {\"cubes\":4}")) && WM.renderAutoCheck(ac1, "").length === 0 && WM.renderAutoCheck(ac1, "x".repeat(2000)).length <= WM.AUTO_MAX);

  // ── E. main.js ────────────────────────────────────────────────────────────
  ok("E1 main.js WORK_MODES.blockbench: name/badge/short, sub + note say export file + manual Import 3D, toast, 8 starters, focus regex claims bb_* and total_screenshot", /WORK_MODES\.blockbench = \{\n    name: "Blockbench", badge: "BLOCKBENCH", short: "Blockbench",/.test(main) && /Studio Import 3D \(manual\)/.test(main) && (main.match(/WORK_MODES\.blockbench = \{[\s\S]*?focus: (\/[^\n]+\/),\n  \};/) || [])[1] && (() => { const m = main.match(/WORK_MODES\.blockbench = \{([\s\S]*?)\n  \};/); const block = m[1]; const starters = (block.match(/\{ label: "/g) || []).length; const focus = eval(block.match(/focus: (\/[^\n]+\/),/)[1]); return starters === 8 && focus.test("bb_cubes") && focus.test("bb_export") && focus.test("total_screenshot") && !focus.test("blender_add_cube") && !focus.test("list_commands"); })());
  {
    const m = main.match(/MODE_GATES\.blockbench = \[([\s\S]*?)\n  \];/);
    const gates = m ? eval("[" + m[1] + "]") : [];
    const model = gates.find((g) => g.id === "model"), exp = gates.find((g) => g.id === "export");
    ok("E2 MODE_GATES.blockbench: MODEL (did bb_cubes/group/texture/animate/call → proof bb_screenshot|bb_status) + EXPORT (did builds → proof bb_export); scripts + look pushed from creation; nudges say Import 3D is manual", model && exp && model.did.test("bb_cubes") && model.did.test("bb_call") && !model.did.test("bb_screenshot") && model.proof.test("bb_screenshot") && model.proof.test("bb_status") && !model.proof.test("bb_export") && exp.did.test("bb_group") && !exp.did.test("bb_remove") && exp.proof.test("bb_export") && !exp.proof.test("bb_status") && /Do not claim it is in Studio/.test(exp.nudge) && main.includes('MODE_GATES.blockbench.push(...MODE_GATES.creation.filter((g) => g.id === "scripts" || g.id === "look"));'));
  }
  ok("E3 runTool: bb_* branch BEFORE the Blender branch — status → connect once, offline → ERROR BLOCKBENCH_OFFLINE with the plugin URL (no emulation), images attached like other captures, worker errors passed through; probes of kind blockbench run through call_tool; preflight/auto-check wired with blockbenchConnected", main.indexOf('if (/^bb_[a-z_]+$/.test(bareName)) {') > 0 && main.indexOf('if (/^bb_[a-z_]+$/.test(bareName)) {') < main.indexOf('const BLENDER_OPS = new Set(') && main.includes('"ERROR BLOCKBENCH_OFFLINE calling \'" + name + "\': Blockbench is not connected.') && main.includes('probe.kind === "blender" || probe.kind === "blockbench"') && main.includes("const blockbenchUp = mode === \"blockbench\" ? await blockbenchReady() : false;") && main.includes("blenderConnected: blenderUp, blockbenchConnected: blockbenchUp") && main.includes('if (probe.kind === "blockbench" && !(A.bridge && A.bridge.blockbench === true)) return feedback;') && main.includes("async function blockbenchReady()"));
  {
    const famBlock = main.slice(main.indexOf("const COMMAND_FAMILIES = ["), main.indexOf("function familyOrderFor"));
    const c = {}; vm.runInNewContext(famBlock + "\nthis.F=COMMAND_FAMILIES;this.O=FAMILY_ORDER;", c);
    ok("E4 COMMAND_FAMILIES: blockbench family (re /^bb_/) second after blender, OTHER last; FAMILY_ORDER has a blockbench order (blockbench first) and every mode order holds every family exactly once", c.F[0].id === "blender" && c.F[1].id === "blockbench" && c.F[1].re.test("bb_cubes") && !c.F[1].re.test("blender_add_cube") && c.F.at(-1).id === "other" && c.O.blockbench[0] === "blockbench" && ["creation", "blender", "animate", "blockbench"].every((m) => new Set(c.O[m]).size === c.F.length && c.F.every((f) => c.O[m].includes(f.id))) && c.O.creation.slice(0, 3).join() === "script,blueprint,data" && c.O.blender[0] === "blender" && c.O.animate.slice(0, 3).join() === "animation,motion,script");
  }
  ok("E5 blockbenchModeTools folds server:'blockbench' tools into the default catalogue only in Blockbench mode (both list sites), __rsBlockbench flag from status + menu, settings card (steps incl. plugin URL, port-3000 note, URL field, Connect / Disconnect / blockbench.net) with handlers", main.includes("function blockbenchModeTools(requested)") && (main.match(/allScoped\.push\(\.\.\.blockbenchModeTools\(requested\)\)/g) || []).length === 2 && main.includes("window.__rsBlockbench = () => !!(s && s.blockbench)") && main.includes("function blockbenchCardHtml()") && main.includes('id="rs-blockbench-card"') && main.includes('id="rs-blockbench-url"') && main.includes("jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js") && /already uses port 3000/.test(main) && main.includes('menuEl.querySelector("#rs-mcp-blockbench")') && main.includes('bg({ type: "blockbench_disconnect" })') && main.includes('{ type: "blockbench_set_url", url }') && main.includes("https://www.blockbench.net/") && main.includes("${blockbenchCardHtml()}"));
  ok("E6 overlay.css: Blockbench card recolour + mark + URL field, reduced-motion honoured", /\.rs-blender-card\.rs-bb-card \{ --bl: #1e9c86;/.test(css) && /\.rs-bb-mark::before/.test(css) && /\.rs-bb-url > input/.test(css) && /\.rs-blender-card\.rs-bb-card\.on \.rs-blender-mark \{ animation: none; \}/.test(css));

  // ── F. config.js ──────────────────────────────────────────────────────────
  {
    const c = { window: {}, console }; c.window = c; c.chrome = { runtime: { getURL: () => "" }, storage: { local: { get() {}, set() {} } } };
    vm.createContext(c);
    vm.runInContext(config + ";this.__RS=RS;", c, { filename: "config.js" });
    const RS = c.__RS;
    const full = RS.workModePrompt("blockbench"), tight = RS.workModePrompt("blockbench", { tight: true });
    ok("F1 WORK_MODE_PROMPTS keys creation,blender,animate,blockbench; label Blockbench; checklist; playbooks appended to full only", Object.keys(RS.WORK_MODE_PROMPTS).join() === "creation,blender,animate,blockbench" && RS.workModeLabel("blockbench") === "Blockbench" && /^BLOCKBENCH CHECK: bb_status first/.test(RS.workModeChecklist("blockbench")) && /PLAYBOOKS \(Blockbench mode/.test(full) && !/PLAYBOOKS/.test(tight));
    ok(`F2 budgets: full ${full.length} in (8000, 12000) (below the Animator profile), tight ${tight.length} in (1800, 2600)`, full.length > 8000 && full.length < 12000 && tight.length > 1800 && tight.length < 2600 && full.length < RS.workModePrompt("animate").length);
    ok("F3 profile teaches: FIRST MOVE bb_status; units 16 = one block; groups with pivots; bb_screenshot after every pass; bb_export + Import 3D is the USER's click; never claim an import / asset id; bb_tools / bb_call for raw tools", /FIRST MOVE: bb_status \{\}/.test(full) && /16 = one block/.test(full) && /pivot/.test(full) && /bb_screenshot \{\} after EVERY build pass/.test(full) && /TotalScript does NOT upload or insert the file; the import is the user's click/.test(full) && /NEVER: build without a screenshot; claim an import, an asset id or a Studio placement/.test(full) && /bb_tools \/ bb_call/.test(full) && /FIRST MOVE: bb_status/.test(tight) && /never uploads or inserts/.test(tight));
    const cited = new Set((full + tight + RS.workModeChecklist("blockbench")).match(/\bbb_[a-z_]+/g));
    ok("F4 every bb_* command the profile cites exists in the curated table (" + [...cited].join(", ") + ")", [...cited].every((n) => BB.COMMAND_NAMES.includes(n)), [...cited].filter((n) => !BB.COMMAND_NAMES.includes(n)));
    ok("F5 BLOCKBENCH MCP IS CONNECTED block rides on window.__rsBlockbench and lists the whole family with signatures; the Totality / Blender / Animator prompts are untouched (budget pins in test-work-modes hold)", config.includes("const isBlockbench = window.__rsBlockbench && window.__rsBlockbench();") && config.includes("if (isBlockbench) modeExtra += `\\n\\n━━━ BLOCKBENCH MCP IS CONNECTED ━━━") && (() => { const m = config.match(/━━━ BLOCKBENCH MCP IS CONNECTED ━━━[\s\S]*?`;/)[0]; return BB.COMMAND_NAMES.every((n) => m.includes(n)) && /never uploads/.test(m); })() && !/Blockbench|bb_/.test(RS.workModePrompt("creation")) && !/Blockbench|bb_/.test(RS.workModePrompt("blender")));
  }

  // ── G. popup ──────────────────────────────────────────────────────────────
  ok("G1 popup.js: WORK_MODES literal gains blockbench (4th), preset, SERVER_LABEL + classifier (bb_ → blockbench) + SERVER_ORDER, Studio category row {id blockbench, type blockbench} with URL field + Connect/Disconnect via blockbench_* messages, palette 'Blockbench mode', hidden launcher", popup.includes('const WORK_MODES = ["creation", "blender", "animate", "blockbench"];') && /blockbench: \{ thinking: "max", extra: false \}/.test(popup) && /blockbench: "Blockbench" \}/.test(popup) && popup.includes('if (/^bb_/.test(n)) return "blockbench";') && popup.includes('["roblox", "studio", "local", "agent", "blender", "blockbench"]') && popup.includes('{ id: "blockbench", type: "blockbench", label: "Blockbench MCP"') && popup.includes('case "blockbench": {') && popup.includes('id="blockbench-url"') && popup.includes('{ type: "blockbench_set_url", url: url || "http://localhost:3000/bb-mcp" }') && popup.includes('{ type: "blockbench_disconnect" }') && popup.includes('{ type: "blockbench_connect", url }') && popup.includes('add({ id: "mode:blockbench", group: "Work mode", title: "Blockbench mode"') && popup.includes('$("blockbench")?.addEventListener("click"'));
  ok("G2 popup.html: four work cards in a 2 × 2 grid, Blockbench card (teal selected style) names the manual Import 3D, hidden #blockbench launcher; the three older cards unchanged", (popupHtml.match(/class="work-card" data-work="/g) || []).length === 4 && popupHtml.includes('<button type="button" class="work-card" data-work="blockbench" id="work-blockbench">') && popupHtml.includes(".work.work-modes{grid-template-columns:1fr 1fr}") && /#work-blockbench\.on\{background:linear-gradient\(135deg,#bff3e8/.test(popupHtml) && /Studio Import 3D<\/span>/.test(popupHtml) && popupHtml.includes('<button type="button" id="blockbench">Blockbench MCP — open menu</button>') && popupHtml.includes('data-work="creation" id="work-creation"') && popupHtml.includes('data-work="blender" id="work-blender"') && popupHtml.includes('data-work="animate" id="work-animate"'));
  {
    const pctx = { window: {}, console }; vm.createContext(pctx);
    vm.runInContext(popup.slice(popup.indexOf("const WORK_MODES = ["), popup.indexOf("const WORK_PRESETS")) + "\nthis.normalizeWorkMode = normalizeWorkMode;", pctx);
    ok("G3 popup normaliser keeps blockbench and still folds legacy ids to creation", pctx.normalizeWorkMode("blockbench") === "blockbench" && pctx.normalizeWorkMode("animator") === "creation" && pctx.normalizeWorkMode("x") === "creation");
  }
  ok("G4 popup badge: Studio card badge says Blockbench linked / Blender + Blockbench linked from the status", popup.includes('s.blender && s.blockbench ? "Blender + Blockbench linked" : s.blockbench ? "Blockbench linked" : "Blender linked"'));

  // ── H. README ─────────────────────────────────────────────────────────────
  ok("H1 README: 2.18.0 block names Blockbench MCP (Streamable HTTP plugin, bb_* commands, export + manual Import 3D, Origin rule, port 3000 note) and the test is listed under Testing", /2\.18\.0/.test(readme) && /Blockbench/.test(readme) && /bb-mcp/.test(readme) && /Import 3D/.test(readme) && /declarativeNetRequest/.test(readme) && /test-blockbench-mode\.js/.test(readme));

  console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
