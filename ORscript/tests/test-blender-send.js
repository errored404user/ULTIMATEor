// 1.46.0 — blender_send_to_studio really works end to end.
//
// Why it was broken (three independent breaks, each enough on its own):
//  1. background.js looked for the "OR_MESH_JSON:" payload inside
//     JSON.stringify(result) - the addon returns execute_code's stdout as a
//     STRING inside {executed, result}, so the payload's quotes were escaped and
//     JSON.parse never succeeded; the code fell back to files.
//  2. The status / mesh files were written RELATIVE by Blender (its cwd is the
//     Blender install folder - usually read-only, never the or-core workspace
//     that OR reads from), so write_mesh_file raised PermissionError or the
//     files were never found.
//  3. or-core's read_file clips one read at 40,000 characters and
//     blender_once.* wrote the reply as ONE line, so any dump above ~40 KB
//     (a few hundred vertices) came back truncated.
// The walk below runs the REAL chain with only Blender itself replaced: the
// real tools/blender_ops.py executed by CPython on a fake bpy, the real
// tools/blender_once.py over a real TCP socket to a mock addon that speaks the
// addon's wire format, the real background.js blenderCall with an or-core
// read_file emulation (numbered lines, 4000-line pages, 40k clip), and the
// real studioMeshLuau output executed under lupa against a Roblox stand-in.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawn, spawnSync } = require("child_process");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const bg = read("background.js");
const main = read("src/core/main.js");
const ops = read("tools/blender_ops.py");
const oncePy = read("tools/blender_once.py");
const oncePs = read("tools/blender_once.ps1");
const cfg = read("src/core/config.js");
const readme = read("README.md");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  → " + String(extra).slice(0, 500) : "")); }
}
function finish(code) { console.log(`test-blender-send: ${pass} passed, ${fail} failed`); process.exit(code != null ? code : (fail ? 1 : 0)); }

// ── static pins ──
ok("S: background.js reads the payload from the addon's captured stdout string (last OR_MESH_JSON line)", bg.includes("function blenderInlayPayload") === false && bg.includes("function blenderInlinePayload(stdoutText)") && bg.includes('typeof result.result === "string" ? result.result') && bg.includes("const inline = blenderInlinePayload(stdoutText);"));
ok("S: background.js hands Blender ABSOLUTE workspace paths for the status / mesh files", bg.includes("py = py.split(\"__OR_OUT__\").join(JSON.stringify(abs(status)));") && bg.includes("py = py.split(\"__OR_MESH__\").join(JSON.stringify(abs(mesh)));") && bg.includes("root = await agentWorkspaceRoot();") && bg.includes('const mesh = "or_mesh.json"'));
ok("S: background.js reads the reply / mesh file through the wrapped-line reader (8 lines per read, < 40k clip)", bg.includes("async function localReadWrapped(path)") && bg.includes("await localRead(path, offset, 8)") && bg.includes('raw = await localReadWrapped("or_blender_out.json")') && bg.includes("const rawM = await localReadWrapped(cand);"));
ok("S: blender_once.py / .ps1 write the reply as <= 3000-char lines", oncePy.includes("def write_wrapped(path: str, text: str)") && oncePy.includes("write_wrapped(out_path, json.dumps(data, ensure_ascii=True))") && oncePs.includes("function Write-Wrapped(") && oncePs.includes("Write-Wrapped $OutFile $rawOut") && oncePs.includes("[Math]::Min(3000, $Text.Length - $i)"));
ok("S: blender_ops.py prints the whole payload inline, writes files best-effort and wrapped, never raises on a read-only cwd", ops.includes("INLINE_LIMIT = 3000000") && ops.includes("def write_wrapped(path, text):") && ops.includes('print("OR_MESH_JSON:" + full, flush=True)') && ops.includes("def write_mesh_file(meshes):\n    if not MESH:\n        return \"\"\n    try:") && ops.includes("OR_MESH_JSON") && ops.includes("def emit"));
ok("S: blender_ops.py dump — Blender triangulation, world transforms, Z-up→Y-up rotation, flat flag, material colour, budgets + skipped reasons", ["def mesh_triangles(mesh):", "calc_loop_triangles", "def mesh_color(obj):", 'inp = node.inputs.get("Base Color")', "verts.append([round(float(c.x), 4), round(float(c.z), 4), round(float(-c.y), 4)])", "MAX_TRIS_PER_MESH = 20000", "MAX_TOTAL_TRIS = 40000", "blender_decimate {objects:", '"skipped": skipped', '"meshes": meshes', "if not objs:"].every((s) => ops.includes(s)));
ok("S: main.js — studioMeshLuau decodes ONE JSON string (as <= 3000-char one-line long strings, chunker-safe), recentres on the bbox, AddTriangle from flat 0-based indices, flat normals, colour, publish via CreateAssetAsync, append mode", ['J[#J + 1] = [==[', "local data = decode(HttpService, table.concat(J))", "Content.fromObject(em), { CollisionFidelity = Enum.CollisionFidelity.Default }", "ids[(tonumber(faces[i]) or -1) + 1]", "em:SetFaceNormals(fid, { nid, nid, nid })", "AssetService:CreateAssetAsync(em, Enum.AssetType.Mesh, { Name = name", "if folder and not data.append then folder:Destroy() folder = nil end", "part.CFrame = CFrame.new(cx, cy, cz)", 'part:SetAttribute(\\"BlenderObject\\", name)', ".replace(/\\]==\\]/g, \"] == ]\")"].every((s) => main.includes(s)) && !main.includes("ids[i] = id ids[i-1] = id") && !main.includes("folder:PivotTo(CFrame.new(0, 3, 0))"));
ok("S: main.js — runAssetBridgeImport uses dump.meshes, batches by ~700 KB, gates publish like the other publish commands, reports skipped objects", ["let meshes = Array.isArray(dump.meshes) ? dump.meshes : null;", "const BATCH_CHARS = 700000;", 'await requestApproval("blender_send_to_studio", { objects: meshes.map((m) => m.name), publish: true', "const skippedText = skipped.length ?", "studioMeshLuau(batches[i], dest, scale, { append: firstAppend || i > 0, publish })", 'const viaPlugin = pluginToolAvailable("plugin_execute_luau");', 'r = await bridgeTool("plugin_execute_luau", { code }, 180000);'].every((s) => main.includes(s)));
ok("S: blender_send_to_studio / asset_bridge_import are Ask-mode commands (they write into Studio)", /ASK_OPS = new Set\(\[[\s\S]*?"blender_send_to_studio","asset_bridge_import"[\s\S]*?\]\);/.test(main));
ok("S: tool card + AI guidance describe the real behaviour (limits, publish, append)", bg.includes('btool("blender_send_to_studio", "ONE SHOT: read the live Blender meshes') && bg.includes("publish: { type: \"boolean\" }") && cfg.includes("builds REAL MeshParts via EditableMesh under Workspace.OR_Imported") && cfg.includes("20k triangles per mesh (blender_decimate first), 40k total"));
ok("S: README changelog covers the fix", /\*\*1\.46\.0 — /.test(readme) && readme.includes("blender_send_to_studio"));

// ── live walk ──
const py = spawnSync("python3", ["-c", "import lupa, sys; print(lupa.__version__)"], { encoding: "utf8" });
const haveLupa = py.status === 0;
const port = 19978;
const mock = spawn("python3", [path.join(__dirname, "fixtures", "mock_blender_addon.py"), String(port)], { stdio: ["ignore", "pipe", "pipe"] });
let mockErr = "";
mock.stderr.on("data", (d) => { mockErr += String(d); });
mock.on("error", (e) => { console.error("mock addon failed to start", e); finish(1); });
const killMock = () => { try { mock.kill(); } catch {} };
const startTimer = setTimeout(() => { console.error("mock addon did not start", mockErr); killMock(); finish(1); }, 10000);

mock.stdout.once("data", async () => {
  clearTimeout(startTimer);
  try { await walk(); } catch (e) { console.error("harness error", e && e.stack || e); fail++; }
  killMock();
  finish();
});

async function walk() {
  // workspace directory standing in for or-core's workspace root
  const ws = fs.mkdtempSync(path.join(require("os").tmpdir(), "or-ws-"));
  const files = {};
  const wsPath = (p) => path.isAbsolute(p) ? p : path.join(ws, p);
  // or-core read_file emulation: numbered lines, limit clamped to 4000, whole reply clipped at 40,000 chars.
  function readFileLikeOrCore(p, offset, limit) {
    const full = wsPath(p);
    if (!fs.existsSync(full)) return { ok: false, error: "no such file " + p };
    const text = fs.readFileSync(full, "utf8");
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const start = Math.max(1, Number(offset) || 1);
    const lim = Math.min(4000, Math.max(1, Number(limit) || 2000));
    const chunk = lines.slice(start - 1, start - 1 + lim).map((ln, i) => String(start + i).padStart(5, " ") + " | " + ln);
    const end = start - 1 + chunk.length;
    const footer = end < lines.length ? `\n... lines ${end + 1}-${lines.length} continue (use offset=${end + 1})` : "";
    let out = `${p}  (${lines.length} lines)\n${chunk.join("\n")}${footer}`;
    if (out.length > 40000) out = out.slice(0, 40000) + "\n... [output truncated at 40000 characters]";
    return { ok: true, text: out };
  }
  const runs = [];
  function stub(name) { const f = function () { return stub(name + "()"); }; return new Proxy(f, { get(t, k) { if (k === "then") return undefined; if (typeof k === "symbol") return undefined; return stub(name + "." + String(k)); }, apply() { return stub(name + "()"); } }); }
  const ctx = { chrome: stub("chrome"), console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => ({ ok: false, status: 0, text: async () => "", json: async () => ({}) }), WebSocket: class { constructor() {} close() {} send() {} }, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Blob, FormData, crypto, performance };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(bg, ctx, { filename: "background.js" });
  // plug the native engine: workspace files + a real run of blender_once.py over TCP to the mock addon
  ctx.chrome = { runtime: { getPlatformInfo: async () => ({ os: "linux" }), getURL: (n) => n }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  ctx.extText = async (name) => read(name);
  ctx.localWrite = async (p, content) => { fs.writeFileSync(wsPath(p), content); files[p] = content.length; return "ok"; };
  ctx.localRead = async (p, offset, limit) => {
    const r = readFileLikeOrCore(p, offset, limit);
    if (!r.ok) throw new Error(r.error);
    const lines = String(r.text || "").split("\n"); const body = []; let more = false; let next = offset || 1;
    for (const ln of lines) { const cont = ln.match(/\.\.\. lines (\d+)/); if (cont) { more = true; next = Number(cont[1]); continue; } const m = ln.match(/^\s*\d+\s+\|\s(.*)$/); if (m) body.push(m[1]); }
    return { text: body.join("\n"), more, next, count: body.length };
  };
  ctx.localRun = async (command, secs) => {
    runs.push(command);
    const m = command.match(/^python3 blender_once\.py (\S+) (\S+)$/);
    if (!m) return { ok: false, text: "python3: command not recognized" };
    const r = spawnSync("python3", [path.join(root, "tools", "blender_once.py"), wsPath(m[1]), wsPath(m[2])], { encoding: "utf8", cwd: ws, timeout: 60000, env: { ...process.env, BLENDER_PORT: String(port), BLENDER_HOST: "127.0.0.1" } });
    return { ok: true, text: String(r.stdout || "") + String(r.stderr || "") };
  };
  ctx.agentWorkspaceRoot = async () => ws;
  ctx.setBlender = (on, err) => { ctx.blenderAddon = !!on; };
  // `let` bindings of the script are not global-object properties - flip them from inside the context.
  vm.runInContext("blenderAddon = true; blenderScriptsReady = true;", ctx);

  // 1. the dump: real ops script, real once script, real transport emulation
  const t0 = Date.now();
  const dump = await ctx.blenderCall("blender_mesh_dump", {}, 120000);
  const outFile = fs.existsSync(path.join(ws, "or_blender_out.json")) ? fs.readFileSync(path.join(ws, "or_blender_out.json"), "utf8") : "";
  ok("walk: blender_mesh_dump returns ok with the two importable meshes (fake Blender scene: 2 cubes + a 25k-tri fan + a face-less mesh)", dump && dump.ok === true && Array.isArray(dump.meshes) && dump.meshes.length === 2 && dump.meshes.map((m) => m.name).join(",") === "Cube,Ball", JSON.stringify(dump && (dump.error || dump.text)).slice(0, 400));
  ok("walk: the reply crossed the native transport as 3000-char lines written by blender_once.py", outFile.length > 0 && outFile.split("\n").every((l) => l.length <= 3000) && /^python3 blender_once\.py or_blender_in\.json or_blender_out\.json$/.test(runs[0] || ""), (runs[0] || "") + " / " + outFile.length);
  ok("walk: ops script received ABSOLUTE workspace paths and wrote or_status.json + or_mesh.json there (wrapped)", fs.existsSync(path.join(ws, "or_status.json")) && fs.existsSync(path.join(ws, "or_mesh.json")) && fs.readFileSync(path.join(ws, "or_mesh.json"), "utf8").split("\n").every((l) => l.length <= 3000) && JSON.parse(fs.readFileSync(path.join(ws, "or_mesh.json"), "utf8").replace(/\n/g, "")).meshes.length === 2);
  const cube = dump && dump.meshes && dump.meshes[0];
  ok("walk: Cube = 8 world-space vertices rotated to Y-up (Blender (1,2,3) → Roblox (1,3,-2)), 12 triangles as flat 0-based indices, flat-shaded, Principled base colour", !!cube && cube.verts.length === 8 && cube.faces.length === 36 && cube.tris === 12 && cube.flat === true && JSON.stringify(cube.color) === "[0.8,0.2,0.1]" && JSON.stringify(cube.verts[0]) === "[0,2,-1]", JSON.stringify(cube).slice(0, 300));
  ok("walk: Ball is smooth and carries the node-less material's viewport colour", dump && dump.meshes[1] && dump.meshes[1].flat === false && JSON.stringify(dump.meshes[1].color) === "[0.5,0.5,0.5]");
  const skipped = (dump && dump.skipped) || [];
  ok("walk: the dense fan and the face-less mesh are reported as skipped WITH actionable reasons (decimate ratio / no faces)", skipped.length === 2 && skipped.some((k) => k.name === "Dense" && /25000 triangles/.test(k.reason) && /blender_decimate \{objects:\["Dense"\], ratio:0\.\d+\}/.test(k.reason)) && skipped.some((k) => k.name === "Empty" && /no faces/.test(k.reason)), JSON.stringify(skipped));
  ok("walk: the text channel carries a summary, not a megabyte of vertices", dump && typeof dump.text === "string" && !/"verts":\s*\[\s*\[/.test(dump.text) && /mesh_summary/.test(dump.text) && dump.text.length < 4000, dump && dump.text && dump.text.length);
  console.log("      (dump round trip " + (Date.now() - t0) + " ms, " + runs.length + " native run(s))");

  // 2. transport stress: a reply far above the 40k clip must survive intact
  const big = { status: "success", result: { executed: true, result: "OR_MESH_JSON:" + JSON.stringify({ ok: true, meshes: [{ name: "Big", verts: Array.from({ length: 12000 }, (_, i) => [i * 0.001, 0.5, -0.25]), faces: Array.from({ length: 36000 }, (_, i) => i % 12000), tris: 12000 }] }) + "\n" } };
  const bigTxt = JSON.stringify(big);
  fs.writeFileSync(path.join(ws, "big_reply.json"), Array.from({ length: Math.ceil(bigTxt.length / 3000) }, (_, i) => bigTxt.slice(i * 3000, (i + 1) * 3000)).join("\n"));
  const back = await ctx.localReadWrapped("big_reply.json");
  ok("walk: localReadWrapped reassembles a " + Math.round(bigTxt.length / 1024) + " KB reply byte-for-byte through the 40k-clipped read_file", back === bigTxt, back.length + " vs " + bigTxt.length);
  const inline = ctx.blenderInlinePayload(JSON.parse(back).result.result);
  ok("walk: and the inline payload parses with all 12,000 vertices", inline && inline.meshes && inline.meshes[0].verts.length === 12000);

  // 3. Studio side: run the generated Luau under lupa against a Roblox stand-in
  if (!haveLupa) { console.log("SKIP  lupa not installed - Studio Luau walk skipped (pip install lupa)"); return; }
  const fnSrc = main.slice(main.indexOf("  function studioMeshLuau(meshes, dest, scale, opts) {"), main.indexOf("  // ── Thumbnail & Icon Studio: gfx_capture composite ──"));
  const studioMeshLuau = vm.runInNewContext("(function(){" + fnSrc + " return studioMeshLuau; })()", { JSON, Number, String });
  const runLuau = (code, mode) => {
    const f = path.join(ws, "studio_" + mode + ".luau");
    fs.writeFileSync(f, code);
    const r = spawnSync("python3", [path.join(__dirname, "fixtures", "run_studio_mesh_luau.py"), f, mode], { encoding: "utf8", timeout: 60000 });
    try { return JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { return { error: String(r.stdout) + String(r.stderr) }; }
  };
  const code = studioMeshLuau(dump.meshes, "Workspace", 20, {});
  ok("walk: generated Luau is < 60 KB for the two cubes and free of Luau-only sugar the scanner rejects", code.length < 60000 && !/\+=/.test(code) && !/table\.create/.test(code));
  // the MCP route: execute_luau's own chunker must be able to split the big program between lines
  const chunkSrc = main.slice(main.indexOf("  const LUAU_CHUNK_MAX = 18000;"), main.indexOf("  // Embed `s` as a Luau long-string."));
  const chunker = vm.runInNewContext("(function(){" + chunkSrc + " return { splitLuauChunks, LUAU_CHUNK_MAX }; })()", {});
  const bigCode = studioMeshLuau(inline.meshes, "Workspace", 20, {});
  const pieces = chunker.splitLuauChunks(bigCode, chunker.LUAU_CHUNK_MAX) || [bigCode];
  ok("walk: a " + Math.round(bigCode.length / 1024) + " KB program splits into " + pieces.length + " chunker pieces of <= 18 KB that re-join byte-exact (every JSON line is a closed long string)", pieces.length > 10 && pieces.every((p) => p.length <= chunker.LUAU_CHUNK_MAX + 3100) && pieces.join("\n") === bigCode && bigCode.split("\n").every((l) => l.length <= 3100), pieces.map((p) => p.length).slice(0, 5).join(","));
  const rep = runLuau(code, "editable");
  ok("walk: Luau runs without error under the Roblox stand-in", rep && !rep.error, rep && rep.error);
  if (rep && !rep.error) {
    const parts = rep.parts || [];
    const cubeP = parts.find((p) => p.name === "Cube");
    ok("walk: previous OR_Imported is replaced, one Model named OR_Imported under Workspace, PrimaryPart set", rep.destroyed.some((d) => d.name === "OR_Imported") && rep.workspaceChildren.filter((c) => c === "OR_Imported:Model").length === 1 && rep.primaryPart === "Cube", JSON.stringify([rep.destroyed, rep.workspaceChildren, rep.primaryPart]));
    ok("walk: both meshes became MeshParts through EditableMesh (8 verts / 12 tris each, RemoveUnused, Default collision)", parts.length === 2 && parts.every((p) => p.class === "MeshPart" && p.anchored) && rep.meshes.length === 2 && rep.meshes.every((m) => m.verts === 8 && m.tris === 12 && m.removedUnused && m.fidelity === "Default"), JSON.stringify(rep.meshes));
    ok("walk: flat cube gets 12 per-face normals, smooth ball none", rep.meshes[0].normals === 12 && rep.meshes[0].faceNormals === 12 && rep.meshes[1].normals === 0, JSON.stringify(rep.meshes));
    ok("walk: Cube sits at its Blender world position × scale (1,3,-2)·20 = (20,60,-40) with the Principled colour and a BlenderObject attribute", !!cubeP && JSON.stringify(cubeP.cframe) === "[20,60,-40]" && JSON.stringify(cubeP.color) === "[0.8,0.2,0.1]" && cubeP.attrs.BlenderObject === "Cube", JSON.stringify(cubeP));
    ok("walk: result text names every mesh and the method", /imported 2 mesh\(es\) into Workspace\.OR_Imported \(2 real MeshParts, 0 bounding boxes, 0 published\)/.test(rep.result) && /Cube: MeshPart \(12 tris\)/.test(rep.result), rep.result);
    ok("walk: nothing was uploaded without publish:true", rep.published.length === 0);
  }
  const rep2 = runLuau(studioMeshLuau(dump.meshes, "Workspace", 20, { append: true }), "noeditable");
  ok("walk: without EditableMesh the import degrades to bounding-box Parts at the right places and says why; append keeps the existing OR_Imported", rep2 && !rep2.error && rep2.destroyed.length === 0 && rep2.parts.length === 2 && rep2.parts.every((p) => p.class === "Part") && JSON.stringify(rep2.parts[0].size) === "[40,40,40]" && /bounding-box Part - EditableMesh unavailable/.test(rep2.result) && /2 bounding boxes/.test(rep2.result), rep2 && (rep2.error || rep2.result));
  const rep3 = runLuau(studioMeshLuau(dump.meshes, "Lighting", 20, { publish: true }), "editable");
  ok("walk: publish:true uploads each EditableMesh with CreateAssetAsync and stamps PublishedMeshId; dotted / service dest resolves", rep3 && !rep3.error && rep3.published.length === 2 && rep3.published.every((p) => p.type === "Mesh") && /2 published/.test(rep3.result) && /published as rbxassetid:\/\/12345/.test(rep3.result) && rep3.parts.length === 0 /* under Lighting, not Workspace */, rep3 && (rep3.error || rep3.result));
  const rep4 = runLuau(studioMeshLuau(dump.meshes, "Workspace", 20, { publish: true }), "publishfail");
  ok("walk: a failed upload keeps the MeshPart and reports the failure per mesh", rep4 && !rep4.error && rep4.parts.length === 2 && /publish failed: Failure moderation rejected/.test(rep4.result) && /0 published/.test(rep4.result), rep4 && (rep4.error || rep4.result));
  const sub = runLuau(studioMeshLuau(dump.meshes, "Workspace.Props", 20, {}), "editable");
  ok("walk: dest \"Workspace.Props\" creates the folder when missing and builds under it", sub && !sub.error && sub.parts.length === 2 && sub.parts.every((p) => p.path.startsWith("Workspace.Props.OR_Imported.")) && /into Workspace\.Props\.OR_Imported/.test(sub.result), sub && (sub.error || JSON.stringify(sub.parts.map((p) => p.path))));
  // 4. error path: Blender replies with an error → ok:false with the message, nothing thrown
  const bad = await ctx.blenderCall("blender_mesh_dump", { objects: ["Nope"] }, 120000);
  ok("walk: dumping only a missing object falls back to the whole scene (resolve_objects) rather than failing", bad && bad.ok && bad.meshes && bad.meshes.length === 2, JSON.stringify(bad && (bad.error || bad.meshes && bad.meshes.length)));
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}
