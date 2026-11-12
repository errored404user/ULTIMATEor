// 2.21.0 — the TotalScript Blockbench plugin (plugin/TotalScript-Blockbench.js)
// + its total-core hub (agent/src/blockbench.rs) + the extension's command
// table (src/core/blockbench_tools.js). MOCKED: no Blockbench, no Rust build.
//   node tests/test-blockbench-plugin.js
//
// What this proves:
//   A. The three command tables agree exactly (plugin CAPABILITIES, extension
//      COMMAND_NAMES, Rust tools()) and every name has a JOBS implementation.
//   B. Mesh primitives are real closed, outward-facing tri/quad geometry
//      (Euler characteristic 2, torus 0; Newell normals point away from the
//      shape; every face has 3-4 unique indices) and validateMeshData refuses
//      the shapes Blockbench cannot take.
//   C. Every JOB runs against a stand-in Blockbench api: argument errors are
//      thrown BEFORE any edit, edits go through Undo.initEdit/finishEdit
//      (api.edit), bb_export writes real files into the injected _export_dir
//      without overwriting, bb_screenshot returns {mimeType,data}, results are
//      plain text + data.
//   D. The bridge loop against a fake total-core (node http): hello carries
//      the capabilities, poll picks up a queued job, result posts {id, ok,
//      result | error, code, elapsed_ms}; errors keep the ERROR … prefix.
//   E. Rust + extension wiring by source pins: routes, _export_dir injection,
//      BLOCKBENCH_OFFLINE mapping, chat dispatch, status fields, the plugin
//      copied next to the executable, importScripts of blockbench_tools.js,
//      the worker's bb_* branch (validate → Roblox ws, no Studio gate).
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), net = require("net"), os = require("os");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 500) : "")); } };

const P = require(path.join(ROOT, "plugin/TotalScript-Blockbench.js"));
const T = require(path.join(ROOT, "src/core/blockbench_tools.js"));
const rs = read("agent/src/blockbench.rs"), mainRs = read("agent/src/main.rs"), chatRs = read("agent/src/chat.rs"), bg = read("background.js"), pluginSrc = read("plugin/TotalScript-Blockbench.js");

// ── A. tables agree ──────────────────────────────────────────────────────────
const rustNames = [...rs.matchAll(/tool\(\s*"(bb_[a-z_]+)"/g)].map((m) => m[1]);
ok("A1 plugin: VERSION 2.21.0, PLUGIN_ID totalscript_bridge, DEFAULT_BRIDGE 127.0.0.1:3000 (total-core, no new port), 27 capabilities", P.VERSION === "2.21.0" && P.PLUGIN_ID === "totalscript_bridge" && P.DEFAULT_BRIDGE === "http://127.0.0.1:3000" && P.CAPABILITIES.length === 27);
ok("A2 plugin CAPABILITIES === extension COMMAND_NAMES === Rust tools() (same 27 names, same order)", JSON.stringify(P.CAPABILITIES) === JSON.stringify(T.COMMAND_NAMES) && JSON.stringify(rustNames) === JSON.stringify(P.CAPABILITIES), { plugin: P.CAPABILITIES, ext: T.COMMAND_NAMES, rust: rustNames });
ok("A3 every capability has a JOBS implementation, an extension validate() and a Rust required[] list; isCommand / is_tool agree on bb_ prefix", P.CAPABILITIES.every((n) => typeof P.JOBS[n] === "function" && typeof T.COMMANDS[n].validate === "function") && T.isCommand("roblox/bb_cubes") && !T.isCommand("execute_luau") && /pub fn is_tool\(name: &str\) -> bool \{\n\s+name\.rsplit\('\/'\)\.next\(\)\.unwrap_or\(name\)\.starts_with\("bb_"\)/.test(rs));
ok("A4 descriptions match between the extension table and the Rust catalogue (the AI reads one of them depending on the channel)", P.CAPABILITIES.every((n) => { const d = T.COMMANDS[n].description.replace(/"/g, '\\"'); return rs.includes('"' + d + '"'); }), P.CAPABILITIES.filter((n) => !rs.includes('"' + T.COMMANDS[n].description.replace(/"/g, '\\"') + '"')));
ok("A5 required arguments agree (Rust &[…] vs extension inputSchema.required)", P.CAPABILITIES.every((n) => { const m = rs.match(new RegExp('tool\\(\\s*"' + n + '"[\\s\\S]*?&\\[([^\\]]*)\\]\\s*,?\\s*\\)')); const rustReq = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : null; const extReq = T.COMMANDS[n].inputSchema.required || []; return rustReq && JSON.stringify(rustReq) === JSON.stringify(extReq); }), P.CAPABILITIES.map((n) => n + ":" + JSON.stringify(T.COMMANDS[n].inputSchema.required || [])));
{
  const rustSchema = (name) => {
    const m = [...rs.matchAll(/tool\s*\(\s*"(bb_[a-z_]+)"\s*,/g)].find((x) => x[1] === name);
    if (!m) return null;
    let i = m.index + m[0].length;
    const skip = () => { while (/\s/.test(rs[i] || "")) i++; };
    const readString = (at) => {
      if (rs[at] !== '"') return null;
      for (let j = at + 1, escaped = false; j < rs.length; j++) {
        const c = rs[j];
        if (escaped) { escaped = false; continue; }
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') return { end: j + 1, value: JSON.parse(rs.slice(at, j + 1)) };
      }
      return null;
    };
    skip();
    const description = readString(i);
    if (!description) return null;
    i = description.end; skip(); if (rs[i++] !== ",") return null; skip();
    if (!rs.startsWith("json!", i)) return null;
    i += 5; skip(); if (rs[i++] !== "(") return null; skip();
    const start = i;
    let depth = 0, quoted = false, escaped = false;
    for (; i < rs.length; i++) {
      const c = rs[i];
      if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') { quoted = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) return null;
    let properties;
    try { properties = JSON.parse(rs.slice(start, i + 1)); } catch { return null; }
    i++; skip(); if (rs[i++] !== ")") return null; skip(); if (rs[i++] !== ",") return null; skip();
    if (rs.slice(i, i + 2) !== "&[") return null;
    i += 2;
    const required = [];
    while (i < rs.length) {
      skip();
      if (rs[i] === "]") break;
      if (rs[i] === ",") { i++; continue; }
      const item = readString(i);
      if (!item) return null;
      required.push(item.value); i = item.end;
    }
    if (rs[i] !== "]") return null;
    return { type: "object", properties, required };
  };
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])])) : value;
  const mismatches = P.CAPABILITIES.filter((name) => {
    const rust = rustSchema(name), ext = T.COMMANDS[name] && T.COMMANDS[name].inputSchema;
    return !rust || !ext || JSON.stringify(canonical(rust)) !== JSON.stringify(canonical(Object.assign({}, ext, { required: ext.required || [] })));
  });
  ok("A6 Rust and extension Blockbench property schemas match exactly for every capability", mismatches.length === 0, mismatches);
}

// ── B. geometry ──────────────────────────────────────────────────────────────
function topology(g) {
  const E = new Set();
  for (const f of g.faces) for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length]; E.add(a < b ? a + "-" + b : b + "-" + a); }
  return { V: g.vertices.length, E: E.size, F: g.faces.length, chi: g.vertices.length - E.size + g.faces.length };
}
function inwardFaces(shape, g, R) {
  let bad = 0;
  for (const f of g.faces) {
    const n = P.faceNormal(g.vertices, f);
    const c = [0, 0, 0]; for (const i of f) { c[0] += g.vertices[i][0] / f.length; c[1] += g.vertices[i][1] / f.length; c[2] += g.vertices[i][2] / f.length; }
    let ref;
    if (shape === "torus") { const a = Math.atan2(c[2], c[0]); ref = [Math.cos(a) * R, 0, Math.sin(a) * R]; }
    else if (shape === "plane") ref = [0, -1, 0];
    else { const ys = g.vertices.map((v) => v[1]); ref = [0, (Math.min(...ys) + Math.max(...ys)) / 2, 0]; }
    if (n[0] * (c[0] - ref[0]) + n[1] * (c[1] - ref[1]) + n[2] * (c[2] - ref[2]) <= 0) bad++;
  }
  return bad;
}
{
  const report = {};
  let allOk = true;
  for (const shape of P.PRIMITIVES) {
    const g = P.primitiveGeometry(shape, { sides: 8, diameter: 8, height: 10, tube: 1 });
    const t = topology(g);
    const closedChi = shape === "torus" ? 0 : shape === "plane" ? 1 : 2;
    const inward = inwardFaces(shape, g, 4);
    const triQuad = g.faces.every((f) => (f.length === 3 || f.length === 4) && new Set(f).size === f.length);
    report[shape] = Object.assign(t, { inward, triQuad, valid: P.validateMeshData(g.vertices, g.faces) });
    if (t.chi !== closedChi || inward !== 0 || !triQuad || report[shape].valid !== null) allOk = false;
  }
  ok("B1 six primitives: closed (χ=2; torus 0; plane 1), all faces tris/quads with unique indices, every face outward (Newell normal · (centroid − axis) > 0), validateMeshData passes", allOk, report);
  const cyl = P.primitiveGeometry("cylinder", { sides: 6, diameter: 4, height: 3, position: [10, 20, 30] });
  const ys = cyl.vertices.map((v) => v[1]);
  ok("B2 position = base centre: cylinder at [10,20,30] spans y 20..23 and is centred on x=10 / z=30; sides clamp to 3..64; diameter 8 / height = diameter by default", Math.min(...ys) === 20 && Math.max(...ys) === 23 && Math.abs(cyl.vertices.slice(0, 6).reduce((s, v) => s + v[0], 0) / 6 - 10) < 1e-6 && P.primitiveGeometry("cone", { sides: 2 }).vertices.length === P.primitiveGeometry("cone", { sides: 3 }).vertices.length && P.primitiveGeometry("cone", { sides: 999 }).vertices.length === P.primitiveGeometry("cone", { sides: 64 }).vertices.length && P.primitiveGeometry("cylinder", {}).vertices.some((v) => v[1] === 8) && P.primitiveGeometry("cylinder", {}).vertices.some((v) => v[0] === 4));
  const bad = [
    [[], []], [[[0, 0, 0], [1, 0, 0]], [[0, 1]]], [[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 2, 3]]], [[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 1]]],
    [[[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [2, 2, 2]], [[0, 1, 2, 3, 4]]], [[[0, 0, "x"], [1, 0, 0], [0, 1, 0]], [[0, 1, 2]]], [[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 5]]],
  ];
  ok("B3 validateMeshData refuses: empty, <3 verts, index out of range, repeated index, 5-gon, non-numeric vertex; accepts a quad + tri", bad.every(([v, f]) => typeof P.validateMeshData(v, f) === "string") && P.validateMeshData([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]], [[0, 1, 2, 3], [0, 1, 4]]) === null);
  const r = P.rotateXYZ([1, 0, 0], [0, 90, 0]);
  ok("B4 rotateXYZ: 90° about Y sends +X to −Z (right-handed, like Blockbench's three.js scene); 360° is identity", r[0] === 0 && r[2] === -1 && JSON.stringify(P.rotateXYZ([1, 2, 3], [360, 360, 360])) === JSON.stringify([1, 2, 3]));
}

// ── C. jobs against a stand-in api ───────────────────────────────────────────
function fakeApi(opts) {
  const o = Object.assign({ project: true, meshes: true, animations: true, exportDir: null, screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" }, opts || {});
  const st = { project: o.project ? { name: "Fake", format: "free" } : null, nodes: [], textures: [], animations: [], selected: [], undo: [], redoStack: [], edits: [], camera: null, presets: ["front", "back", "left", "right", "top", "bottom", "isometric_right", "isometric_left"], writes: [] };
  let uuid = 1; const mk = (type, data) => Object.assign({ type, uuid: "u" + (uuid++), parent: null }, data);
  const find = (list, key) => list.find((x) => x.uuid === key || x.name === key) || null;
  const els = () => st.nodes.filter((n) => n.type !== "group");
  const api = {
    _st: st,
    version: () => "4.12.0",
    project: () => st.project ? { name: st.project.name, format: st.project.format, texture_width: 16, texture_height: 16, cubes: st.nodes.filter((n) => n.type === "cube").length, meshes: st.nodes.filter((n) => n.type === "mesh").length, groups: st.nodes.filter((n) => n.type === "group").length, locators: st.nodes.filter((n) => n.type === "locator").length, textures: st.textures.length, animations: st.animations.length } : null,
    outline: (depth) => { const node = (n, d) => { const line = "[" + n.type + "] " + n.name; if (n.type !== "group") return { line }; const kids = st.nodes.filter((k) => k.parent === n); return d < depth ? { line, children: kids.map((k) => node(k, d + 1)) } : { line, children: kids.length ? [{ line: "… " + kids.length + " more" }] : undefined }; }; return st.nodes.filter((n) => !n.parent).map((n) => node(n, 1)); },
    formats: () => ["free", "bedrock", "java_block"],
    hasFormat: (id) => ["free", "bedrock", "java_block"].includes(id),
    newProject(fmt, name) { st.project = { name, format: fmt }; st.nodes = []; st.textures = []; st.animations = []; return true; },
    meshesAllowed: () => o.meshes, animationsAllowed: () => o.animations,
    findGroup: (k) => find(st.nodes.filter((n) => n.type === "group"), k), findCube: (k) => find(st.nodes.filter((n) => n.type === "cube"), k), findMesh: (k) => find(st.nodes.filter((n) => n.type === "mesh"), k), findElement: (k) => find(els(), k), findTexture: (k) => find(st.textures, k), findAnimation: (k) => find(st.animations, k),
    animations: () => st.animations.slice(), animationKeyframeCount: (an) => an.keys.length, animationGroupNames: (an) => [...new Set(an.keys.map((k) => k.bone))],
    animationKeyframes(an, group, channel) { const animator = an.animators[group.uuid]; return animator && animator[channel] || []; }, animationMarkers: (an) => an.markers,
    snapAnimationTime: (time, an) => Math.max(0, Math.round(time * (an ? an.snapping : 24)) / (an ? an.snapping : 24)),
    textures: () => st.textures.map((t) => ({ name: t.name, uuid: t.uuid, width: t.width, height: t.height })),
    edit(label, aspects, fn) { st.edits.push({ label, aspects: Object.assign({}, aspects, { elements: (aspects && aspects.elements || []).slice() }), open: true }); let out; try { out = fn(); } catch (e) { st.edits.pop(); throw e; } st.edits[st.edits.length - 1].open = false; st.undo.push(label); st.redoStack = []; return out; },
    addCube(c, group, texture) { const cube = mk("cube", Object.assign({ texture: texture ? texture.name : null, visibility: true, faces: Object.fromEntries(["north", "south", "east", "west", "up", "down"].map((side) => [side, { uv: [0, 0, 16, 16] }])) }, c)); if (group) cube.parent = group; st.nodes.push(cube); return cube; },
    extendCube(cube, patch) { Object.assign(cube, patch); },
    setCubeFaceUV(cube, faces) { for (const [side, uv] of Object.entries(faces)) cube.faces[side].uv = uv.slice(); },
    describeCube: (c) => ({ name: c.name, uuid: c.uuid, from: c.from, to: c.to }),
    addGroup(data, parent) { const g = mk("group", { name: data.name, origin: data.origin || [0, 0, 0], rotation: data.rotation || [0, 0, 0], visibility: true }); if (parent) g.parent = parent; st.nodes.push(g); return g; },
    addLocator(data, group) { const locator = mk("locator", { name: data.name, position: data.position || [0, 0, 0], rotation: data.rotation || [0, 0, 0], visibility: true, parent: group || null }); st.nodes.push(locator); return locator; },
    extendGroup(g, patch) { if (patch.origin) g.origin = patch.origin; if (patch.rotation) g.rotation = patch.rotation; },
    moveTo(node, group) { node.parent = group; },
    duplicateNode(node) {
      const clone = (source, parent) => { const data = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "uuid" && key !== "parent")); const copy = mk(source.type, structuredClone(data)); copy.parent = parent || null; st.nodes.push(copy); if (source.type === "group") for (const child of st.nodes.filter((candidate) => candidate.parent === source && candidate !== copy)) clone(child, copy); copy.name += " copy"; return copy; };
      return clone(node, node.parent || null);
    },
    selectNodes(nodes, additive) { st.selected = additive ? [...st.selected, ...nodes.filter((node) => !st.selected.includes(node))] : nodes.slice(); return nodes; },
    setVisibility(node, visible) { node.visibility = visible; },
    removeNode(node) { st.nodes = st.nodes.filter((n) => n !== node && n.parent !== node); },
    addMesh(data, group, texture) { const m = mk("mesh", { name: data.name, vertices: data.vertices.map((v) => v.slice()), faces: data.faces, origin: data.origin || [0, 0, 0], texture: texture ? texture.name : null }); if (group) m.parent = group; st.nodes.push(m); return m; },
    extendMesh(m, patch) { if (patch.name) m.name = patch.name; if (patch.origin) m.origin = patch.origin; },
    transformMeshVertices(m, op, v) { for (const p of m.vertices) { if (op === "move") { p[0] += v[0]; p[1] += v[1]; p[2] += v[2]; } else if (op === "scale") { for (let i = 0; i < 3; i++) p[i] = m.origin[i] + (p[i] - m.origin[i]) * v[i]; } else if (op === "rotate") { const q = P.rotateXYZ([p[0] - m.origin[0], p[1] - m.origin[1], p[2] - m.origin[2]], v); for (let i = 0; i < 3; i++) p[i] = m.origin[i] + q[i]; } } if (op === "move") for (let i = 0; i < 3; i++) m.origin[i] += v[i]; },
    describeMesh: (m) => ({ name: m.name, uuid: m.uuid, vertices: m.vertices.length, faces: m.faces.length, origin: m.origin }),
    createTexture(name, w, h, fill) { const t = mk("texture", { name, width: w, height: h, fill }); st.textures.push(t); return t; },
    importTexture(p, name) { const t = mk("texture", { name: name || path.basename(p), width: 16, height: 16, path: p }); st.textures.push(t); return t; },
    textureElements(node) { const found = []; const visit = (entry) => { if (entry.type === "group") st.nodes.filter((child) => child.parent === entry).forEach(visit); else if (["cube", "mesh"].includes(entry.type)) found.push(entry); }; if (!node) els().forEach(visit); else visit(node); return found; },
    applyTextureTo(t, node) { const elements = api.textureElements(node); for (const element of elements) element.texture = t.name; return elements.length; },
    createAnimation(d) { const an = mk("animation", { name: d.name, loop: d.loop ? "loop" : "once", length: d.length, snapping: 24, keys: [], animators: {}, markers: [] }); st.animations.push(an); return an; },
    extendAnimation(an, patch) { if (patch.name) an.name = patch.name; if (patch.length !== undefined) an.length = patch.length; if (patch.loop !== undefined) an.loop = patch.loop; },
    removeAnimation(an) { st.animations = st.animations.filter((item) => item !== an); st.undo.push("remove animation"); st.redoStack = []; },
    editKeyframes(label, keyframes, fn) { return api.edit(label, { keyframes }, () => fn(keyframes)); },
    addAnimationKeyframe(an, group, channel, time, value) { const animator = an.animators[group.uuid] || (an.animators[group.uuid] = { group, [channel]: [] }); if (!animator[channel]) animator[channel] = []; const keyframe = { uuid: "kf" + (uuid++), bone: group.name, channel, time, data_points: [{ x: value[0], y: value[1], z: value[2] }] }; animator[channel].push(keyframe); an.keys.push({ bone: group.name, ch: channel, time, v: value, keyframe }); return keyframe; },
    removeAnimationKeyframe(keyframe) { for (const an of st.animations) { an.keys = an.keys.filter((item) => item.keyframe !== keyframe); for (const animator of Object.values(an.animators)) for (const ch of ["rotation", "position", "scale"]) if (animator[ch]) animator[ch] = animator[ch].filter((item) => item !== keyframe); } },
    addAnimationMarker(an, data) { const marker = Object.assign({ uuid: "mk" + (uuid++) }, data); an.markers.push(marker); return marker; },
    removeAnimationMarker(an, marker) { an.markers = an.markers.filter((item) => item !== marker); },
    addKeyframe(an, g, ch, time, v) { const animator = an.animators[g.uuid] || (an.animators[g.uuid] = { group: g }); if (!animator[ch]) animator[ch] = []; const keyframe = { uuid: "kf" + (uuid++), bone: g.name, ch, channel: ch, time, v }; animator[ch].push(keyframe); an.keys.push({ bone: g.name, ch, time, v, keyframe }); },
    anglePresets: () => st.presets, hasAnglePreset: (id) => st.presets.includes(id), loadAnglePreset(id) { st.camera = { preset: id }; },
    setCamera(pos, target) { st.camera = { pos, target }; }, focusCamera(node) { st.camera = { focus: node.name }; },
    screenshot: async () => o.screenshot,
    defaultExportDir: () => o.exportDir || path.join(os.tmpdir(), "ts-bb-default-" + process.pid),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }), joinPath: (a, b) => path.join(a, b), baseName: (p) => path.basename(p), fileExists: (p) => fs.existsSync(p),
    writeText: (p, s) => { fs.writeFileSync(p, s, "utf8"); st.writes.push(p); }, writeBase64: (p, b) => { fs.writeFileSync(p, Buffer.from(b, "base64")); st.writes.push(p); }, writeBuffer: (p, b) => { fs.writeFileSync(p, Buffer.from(b)); st.writes.push(p); },
    compileObj: async () => ({ obj: "# fake obj\nv 0 0 0\n", mtl: "newmtl m\n", images: [{ name: "skin.png", base64: "iVBORw0KGgo=" }] }),
    compileGltf: async (enc) => enc === "binary" ? new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer : JSON.stringify({ asset: { version: "2.0" } }),
    compileProject: () => JSON.stringify({ meta: { format_version: "4.10" } }),
    undo() { if (!st.undo.length) return false; st.redoStack.push(st.undo.pop()); return true; }, redo() { if (!st.redoStack.length) return false; st.undo.push(st.redoStack.pop()); return true; },
  };
  return api;
}
const run = (name, args, api) => P.runJob(name, args, api).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));

(async () => {
  const api = fakeApi();
  const st = api._st;
  // status without project
  const noProj = await run("bb_status", {}, fakeApi({ project: false }));
  ok("C1 bb_status: no project → plain text pointing at bb_project (no throw); with a project → JSON summary + outliner, project data attached", noProj.ok && /No project is open/.test(noProj.r.text) && noProj.r.project === null && (await run("bb_status", { max_depth: 2 }, api)).r.text.startsWith("Blockbench project {"));
  const pj = await run("bb_project", { name: "Sword", format: "free" }, api);
  const pjBad = await run("bb_project", { name: "X", format: "nope" }, api);
  ok("C2 bb_project creates with a known format; unknown format → ERROR INVALID_ARGUMENT listing the formats; missing name refused", pj.ok && st.project.name === "Sword" && !pjBad.ok && pjBad.e.code === "INVALID_ARGUMENT" && /Available: free/.test(pjBad.e.message) && !(await run("bb_project", {}, api)).ok);
  const g1 = await run("bb_group", { name: "Blade", origin: [0, 8, 0] }, api);
  const g2 = await run("bb_group", { name: "Tip", parent: "Blade" }, api);
  const gBad = await run("bb_group", { name: "Z", parent: "Missing" }, api);
  ok("C3 bb_group: create with pivot, nested under a parent, missing parent → EXECUTION error (no edit opened)", g1.ok && st.nodes[0].origin[1] === 8 && g2.ok && st.nodes[1].parent === st.nodes[0] && !gBad.ok && gBad.e.code === "EXECUTION" && st.edits.length === 2);
  const editsBefore = st.edits.length;
  const cBad = await run("bb_cubes", { cubes: [{ name: "a", from: [0, 0, 0], to: [-1, 1, 1] }] }, api);
  const cBad2 = await run("bb_cubes", { cubes: [{ name: "a", from: [0, 0] }] }, api);
  const cBad3 = await run("bb_cubes", { cubes: [{ name: "a", from: [0, 0, 0], to: [1, 1, 1], color: 10 }] }, api);
  const editsAfterBad = st.edits.length;
  const c1 = await run("bb_cubes", { cubes: [{ name: "Edge", from: [-1, 0, -0.5], to: [1, 24, 0.5], color: 3 }, { name: "Fuller", from: [-0.5, 2, 0.5], to: [0.5, 20, 0.6] }], group: "Blade" }, api);
  ok("C4 bb_cubes: reversed bounds, 2-vectors and marker colors outside 0-9 are refused BEFORE any edit; a valid batch lands in the group in ONE undo step", !cBad.ok && /from must be <= to/.test(cBad.e.message) && !cBad2.ok && !cBad3.ok && /color must be a marker colour index 0-9/.test(cBad3.e.message) && editsAfterBad === editsBefore && c1.ok && c1.r.created.length === 2 && st.edits.length === editsBefore + 1 && st.nodes.filter((n) => n.type === "cube").every((n) => n.parent && n.parent.name === "Blade") && st.nodes.find((n) => n.name === "Edge").color === 3 && /Placed 2 cube\(s\) in group 'Blade'/.test(c1.r.text));
  const ce = await run("bb_cube_edit", { name: "Fuller", to: [0.5, 21, 0.6], rename: "Fuller2", group: "Tip" }, api);
  const ceNone = await run("bb_cube_edit", { name: "Edge" }, api);
  ok("C5 bb_cube_edit: patch + rename + regroup in one edit; 'nothing to change' refused; unknown cube → EXECUTION", ce.ok && st.nodes.find((n) => n.name === "Fuller2").to[1] === 21 && st.nodes.find((n) => n.name === "Fuller2").parent.name === "Tip" && !ceNone.ok && ceNone.e.code === "INVALID_ARGUMENT" && (await run("bb_cube_edit", { name: "Nope", inflate: 1 }, api)).e.code === "EXECUTION");
  const m1 = await run("bb_mesh", { name: "Wedge", vertices: [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4], [0, 3, 0], [4, 3, 0]], faces: [[0, 1, 2, 3], [0, 4, 5, 1], [1, 5, 2], [0, 3, 4], [3, 2, 5, 4]], group: "Blade" }, api);
  const mBad = await run("bb_mesh", { name: "W", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2, 3, 0]] }, api);
  const mFmt = await run("bb_mesh", { name: "W", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] }, fakeApi({ meshes: false }));
  ok("C6 bb_mesh: wedge (quads + tris) created in the group; a 5-index face is refused; a format without meshes → EXECUTION naming format:\"free\"", m1.ok && m1.r.mesh.faces === 5 && st.nodes.find((n) => n.name === "Wedge").parent.name === "Blade" && !mBad.ok && /3 or 4 vertex indices/.test(mBad.e.message) && !mFmt.ok && mFmt.e.code === "EXECUTION" && /format:\\?"free\\?"/.test(mFmt.e.message));
  const prim = await run("bb_mesh_primitive", { shape: "cylinder", name: "Pommel", diameter: 4, height: 2, sides: 8, position: [0, -2, 0] }, api);
  const primBad = await run("bb_mesh_primitive", { shape: "cube", name: "x" }, api);
  ok("C7 bb_mesh_primitive: cylinder → mesh with the generated geometry (origin = position), text names shape + counts; unknown shape refused with the list", prim.ok && /Built cylinder mesh 'Pommel' \(18 vertices \/ 24 faces, 8 sides\)/.test(prim.r.text) && JSON.stringify(st.nodes.find((n) => n.name === "Pommel").origin) === "[0,-2,0]" && !primBad.ok && /cylinder, cone, pyramid, plane, sphere, torus/.test(primBad.e.message));
  const me = await run("bb_mesh_edit", { name: "Pommel", move: [0, -1, 0], scale: 2, rotate: [0, 45, 0], rename: "Pommel2" }, api);
  const pm = st.nodes.find((n) => n.name === "Pommel2");
  ok("C8 bb_mesh_edit: move shifts origin + vertices, uniform scale doubles the radius about the origin, rotate keeps |r|, rename applied; scale ≤ 0 refused", me.ok && JSON.stringify(pm.origin) === "[0,-3,0]" && Math.abs(Math.hypot(pm.vertices[0][0], pm.vertices[0][2]) - 4) < 0.01 && !(await run("bb_mesh_edit", { name: "Pommel2", scale: 0 }, api)).ok);
  const tl0 = await run("bb_texture", { action: "list" }, api);
  const tc = await run("bb_texture", { action: "create", name: "steel", width: 32, height: 32, fill_color: "#8a8f99", apply_to: ["Blade"] }, api);
  const textureGroupUndoElements = st.edits.at(-1) && st.edits.at(-1).aspects.elements.map((element) => element.name);
  const tcBad = await run("bb_texture", { action: "create", name: "x", fill_color: "silver" }, api);
  const tcBig = await run("bb_texture", { action: "create", name: "x", width: 4096 }, api);
  const ta = await run("bb_texture", { action: "apply", texture: "steel", targets: "all" }, api);
  const textureAllUndoElements = st.edits.at(-1) && st.edits.at(-1).aspects.elements.map((element) => element.name);
  const editsBeforeMixedTargets = st.edits.length;
  const taMixed = await run("bb_texture", { action: "apply", texture: "steel", targets: ["all", "Blade"] }, api);
  const ti = await run("bb_texture", { action: "import", path: path.join(os.tmpdir(), "definitely-missing-" + process.pid + ".png") }, api);
  ok("C9 bb_texture: list → create/apply local texture; groups include nested descendants, every changed element is in the undo aspects, add/import use Blockbench undo; 'all' cannot mix with names; bad hex / oversized / missing file refused", tl0.ok && /No textures/.test(tl0.r.text) && tc.ok && st.textures[0].fill === "#8a8f99" && st.textures[0].width === 32 && /applied it to 3 element\(s\)/.test(tc.r.text) && JSON.stringify(textureGroupUndoElements.slice().sort()) === JSON.stringify(["Edge", "Fuller2", "Wedge"]) && !tcBad.ok && !tcBig.ok && ta.ok && ta.r.applied === st.nodes.filter((n) => ["cube", "mesh"].includes(n.type)).length && textureAllUndoElements.length === ta.r.applied && textureAllUndoElements.every((name) => st.nodes.some((node) => node.name === name && ["cube", "mesh"].includes(node.type))) && /\.add\(true\)/.test(pluginSrc) && !/(?:fromDataURL|fromPath)[^\n]*\.add\(false\)/.test(pluginSrc) && !taMixed.ok && taMixed.e.code === "INVALID_ARGUMENT" && /do not mix 'all'/.test(taMixed.e.message) && st.edits.length === editsBeforeMixedTargets && !ti.ok && ti.e.code === "EXECUTION" && /file not found/.test(ti.e.message));
  const an = await run("bb_animate", { name: "swing", length: 1, bones: { Blade: [{ time: 0, rotation: [0, 0, 0] }, { time: 0.5, rotation: [0, 0, -40], position: [0, 1, 0] }, { time: 1, rotation: [0, 0, 0] }] } }, api);
  const anBad = await run("bb_animate", { name: "x", bones: { Blade: [{ time: 2, rotation: [0, 0, 0] }] }, length: 1 }, api);
  const anNoGroup = await run("bb_animate", { name: "x", bones: { Edge: [{ time: 0, rotation: [0, 0, 0] }] } }, api);
  ok("C10 bb_animate: keyframes per channel on the GROUP (4 here), loop default, text says glTF carries it partially; time beyond length refused; a cube name (not a group) → EXECUTION 'animations target GROUPS'", an.ok && st.animations[0].keys.length === 4 && st.animations[0].loop === "loop" && /Studio imports glTF animations only partially/.test(an.r.text) && !anBad.ok && anBad.e.code === "INVALID_ARGUMENT" && !anNoGroup.ok && /target GROUPS/.test(anNoGroup.e.message));
  const cam = await run("bb_camera", { view: "isometric_right" }, api);
  const camA = st.camera;
  const cam2 = await run("bb_camera", { position: [40, 30, 40], target: [0, 8, 0] }, api);
  const camB = st.camera;
  const cam3 = await run("bb_camera", { focus: "Blade" }, api);
  const camC = st.camera;
  const camBad = await run("bb_camera", {}, api);
  ok("C11 bb_camera: preset / position+target / focus all land; empty call refused with the preset list", cam.ok && camA.preset === "isometric_right" && cam2.ok && camB.pos[0] === 40 && camB.target[1] === 8 && cam3.ok && camC.focus === "Blade" && !camBad.ok && /isometric_right/.test(camBad.e.message));
  const shot = await run("bb_screenshot", { view: "front", max_size: 512 }, api);
  const shotNone = await run("bb_screenshot", {}, fakeApi({ screenshot: "" }));
  ok("C12 bb_screenshot: images [{mimeType image/png, data base64}] + text with counts, view preset applied first; an empty capture → EXECUTION (never an invented picture)", shot.ok && shot.r.images.length === 1 && shot.r.images[0].mimeType === "image/png" && /^iVBOR/.test(shot.r.images[0].data) && st.camera.preset === "front" && /cube\(s\), .* mesh\(es\), .* group\(s\)/.test(shot.r.text) && !shotNone.ok && shotNone.e.code === "EXECUTION");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-bb-export-"));
  const ex1 = await run("bb_export", { format: "obj", _export_dir: dir }, api);
  const ex2 = await run("bb_export", { format: "obj", _export_dir: dir }, api);
  const ex3 = await run("bb_export", { format: "obj", _export_dir: dir, overwrite: true, name: "Sword" }, api);
  const exGlb = await run("bb_export", { format: "glb", name: "sword final!", _export_dir: dir }, api);
  const exGltf = await run("bb_export", { format: "gltf", _export_dir: dir }, api);
  const exBb = await run("bb_export", { format: "bbmodel", _export_dir: dir }, api);
  const exBad = await run("bb_export", { format: "fbx", _export_dir: dir }, api);
  const files = fs.readdirSync(dir).sort();
  ok("C13 bb_export obj: Sword.obj + Sword.mtl + skin.png written into the injected _export_dir; second call → Sword-2.obj (no overwrite); overwrite:true reuses Sword.obj; text = path + manual Import 3D steps + 'did NOT import'", ex1.ok && ex1.r.path === path.join(dir, "Sword.obj") && ex1.r.files.length === 3 && ex2.ok && ex2.r.path === path.join(dir, "Sword-2.obj") && ex3.ok && ex3.r.path === path.join(dir, "Sword.obj") && /Home → Import 3D → pick /.test(ex1.r.text) && /did NOT import or upload/.test(ex1.r.text) && files.includes("Sword.mtl") && files.includes("skin.png"), files);
  ok("C14 bb_export glb (binary, name sanitised 'sword final_' - no shell / path characters), gltf (text), bbmodel (project json + 'Studio cannot import it'); fbx refused", exGlb.ok && exGlb.r.path === path.join(dir, "sword final_.glb") && fs.readFileSync(exGlb.r.path).toString("latin1") === "glTF" && exGltf.ok && JSON.parse(fs.readFileSync(exGltf.r.path, "utf8")).asset.version === "2.0" && exBb.ok && /Studio cannot import it/.test(exBb.r.text) && !exBad.ok && /obj \| gltf \| glb \| bbmodel/.test(exBad.e.message));
  const exDefault = await run("bb_export", { format: "gltf" }, fakeApi({ exportDir: path.join(dir, "fallback") }));
  ok("C15 bb_export without _export_dir (no agent workspace) falls back to api.defaultExportDir() (Documents/TotalScript/blockbench_exports in Blockbench) and still writes", exDefault.ok && exDefault.r.path.startsWith(path.join(dir, "fallback")) && fs.existsSync(exDefault.r.path));
  const undoN = st.undo.length;
  const u = await run("bb_undo", { steps: 2 }, api);
  const afterUndo = st.undo.length;
  const rd = await run("bb_redo", {}, api);
  const afterRedo = st.undo.length;
  const uAll = await run("bb_undo", { steps: 99 }, api);
  ok("C16 bb_undo / bb_redo step through the real undo stack (clamped 1-20) and report when nothing older exists", undoN >= 5 && u.ok && /Undid 2 step/.test(u.r.text) && afterUndo === undoN - 2 && rd.ok && afterRedo === undoN - 1 && uAll.ok && /Nothing older to undo/.test(uAll.r.text) && st.undo.length === 0);
  const uvEditsBefore = st.edits.length;
  const uv = await run("bb_cube_uv", { name: "Edge", faces: { north: [2, 3, 14, 15], up: [0, 0, 8, 8] } }, api);
  const uvBad = await run("bb_cube_uv", { name: "Edge", faces: { front: [0, 0, 1, 1] } }, api);
  ok("C17 bb_cube_uv writes real per-face UV rectangles in one undoable edit; unknown faces are refused without opening an edit", uv.ok && JSON.stringify(st.nodes.find((n) => n.name === "Edge").faces.north.uv) === "[2,3,14,15]" && JSON.stringify(st.nodes.find((n) => n.name === "Edge").faces.up.uv) === "[0,0,8,8]" && st.edits.length === uvEditsBefore + 1 && !uvBad.ok && uvBad.e.code === "INVALID_ARGUMENT" && st.edits.length === uvEditsBefore + 1);
  const duplicateEditsBefore = st.edits.length, duplicateNodesBefore = st.nodes.length;
  const dup = await run("bb_duplicate", { names: ["Blade"] }, api);
  const bladeCopy = st.nodes.find((node) => node.type === "group" && node.name === "Blade copy");
  ok("C18 bb_duplicate uses Blockbench's node duplicate operation in one edit; duplicating a group carries its nested descendants and gets a unique root name", dup.ok && bladeCopy && dup.r.duplicated.some((node) => node.name === "Blade copy") && st.nodes.length > duplicateNodesBefore + 1 && st.edits.length === duplicateEditsBefore + 1 && st.nodes.some((node) => node.parent === bladeCopy && node.name === "Tip copy"));
  const editsBeforeSelect = st.edits.length;
  const selected = await run("bb_select", { names: ["Edge", "Wedge"] }, api);
  const selectedAdd = await run("bb_select", { names: ["Pommel2"], additive: true }, api);
  ok("C19 bb_select sets and extends the outliner selection without editing model data", selected.ok && selected.r.selected.length === 2 && selected.r.selected.some((node) => node.name === "Edge") && selectedAdd.ok && st.selected.length === 3 && st.selected.some((node) => node.name === "Pommel2") && st.edits.length === editsBeforeSelect);
  const visibleEditsBefore = st.edits.length;
  const hidden = await run("bb_visibility", { names: ["Blade", "Edge"], visible: false }, api);
  const visibilityBad = await run("bb_visibility", { names: ["Edge", "missing"], visible: true }, api);
  ok("C20 bb_visibility toggles real outliner/viewport visibility in one undoable edit; unresolved names are rejected before an edit", hidden.ok && st.nodes.find((node) => node.name === "Blade").visibility === false && st.nodes.find((node) => node.name === "Edge").visibility === false && st.edits.length === visibleEditsBefore + 1 && !visibilityBad.ok && visibilityBad.e.code === "EXECUTION" && st.edits.length === visibleEditsBefore + 1);
  const loc = await run("bb_locator", { name: "RightHand", position: [1, 8, 0], rotation: [0, 90, 0], group: "Blade" }, api);
  const locBad = await run("bb_locator", { name: "Bad", position: [0, 1] }, api);
  ok("C21 bb_locator creates an outliner locator with its transform and parent group; invalid vectors are refused", loc.ok && st.nodes.some((node) => node.type === "locator" && node.name === "RightHand" && node.parent.name === "Blade" && node.position[1] === 8) && !locBad.ok && locBad.e.code === "INVALID_ARGUMENT");
  const animationList = await run("bb_animation_list", {}, api);
  ok("C22 bb_animation_list reads the actual animation list, loop / duration, tracks and keyframe count", animationList.ok && animationList.r.animations.some((animation) => animation.name === "swing" && animation.keyframes === 4 && animation.groups.includes("Blade")) && /Animations \(1\): swing/.test(animationList.r.text));
  const animationEdit = await run("bb_animation_edit", { name: "swing", rename: "swing_v2", length: 2, loop: "hold" }, api);
  const animationEditBad = await run("bb_animation_edit", { name: "swing_v2", length: -1 }, api);
  ok("C23 bb_animation_edit changes the live animation name, duration and loop mode in one undo step; invalid duration is rejected", animationEdit.ok && st.animations[0].name === "swing_v2" && st.animations[0].length === 2 && st.animations[0].loop === "hold" && !animationEditBad.ok && animationEditBad.e.code === "INVALID_ARGUMENT");
  const keyframeEditCount = st.edits.length;
  const keyAdd = await run("bb_animation_keyframe", { action: "add", animation: "swing_v2", group: "Blade", channel: "scale", time: 0.25, value: [1, 1.2, 1] }, api);
  const keyDuplicate = await run("bb_animation_keyframe", { action: "add", animation: "swing_v2", group: "Blade", channel: "scale", time: 0.25, value: [1, 1, 1] }, api);
  const keyRemove = await run("bb_animation_keyframe", { action: "remove", animation: "swing_v2", group: "Blade", channel: "scale", time: 0.25 }, api);
  ok("C24 bb_animation_keyframe adds then removes a native bone-channel keyframe through one edit each; duplicate snapped times are refused before an edit", keyAdd.ok && keyAdd.r.keyframe.time === 0.25 && st.animations[0].animators[st.nodes.find((node) => node.name === "Blade").uuid].scale.length === 0 && !keyDuplicate.ok && keyDuplicate.e.code === "INVALID_ARGUMENT" && keyRemove.ok && /Removed scale keyframe/.test(keyRemove.r.text) && st.edits.length === keyframeEditCount + 2);
  const markerListBefore = await run("bb_marker", { action: "list", animation: "swing_v2" }, api);
  const markerAdd = await run("bb_marker", { action: "add", animation: "swing_v2", name: "impact", time: 0.75, color: 4 }, api);
  const markerAddDup = await run("bb_marker", { action: "add", animation: "swing_v2", name: "impact-again", time: 0.75 }, api);
  const markerList = await run("bb_marker", { action: "list", animation: "swing_v2" }, api);
  const markerRemove = await run("bb_marker", { action: "remove", animation: "swing_v2", name: "impact" }, api);
  ok("C25 bb_marker lists, adds and removes actual timeline markers; duplicate timestamps are refused and marker edits participate in animation undo", markerListBefore.ok && markerListBefore.r.markers.length === 0 && markerAdd.ok && markerAdd.r.marker.color === 4 && !markerAddDup.ok && markerAddDup.e.code === "INVALID_ARGUMENT" && markerList.ok && markerList.r.markers.length === 1 && markerList.r.markers[0].name === "impact" && markerRemove.ok && markerRemove.r.removed.length === 1 && st.animations[0].markers.length === 0);
  const animationRemove = await run("bb_animation_remove", { name: "swing_v2" }, api);
  ok("C26 bb_animation_remove uses Blockbench's undoable remove API but does not delete any external animation file", animationRemove.ok && st.animations.length === 0 && /external animation file was not deleted/.test(animationRemove.r.text) && st.undo.at(-1) === "remove animation");
  const tools = await run("bb_tools", {}, api);
  const unknown = await run("bb_paint", {}, api);
  ok("C27 bb_tools lists the 27 commands + formats + views + primitives; an unknown name → COMMAND_NOT_FOUND with the ERROR prefix", tools.ok && P.CAPABILITIES.every((n) => tools.r.text.includes(n)) && /Mesh primitives: cylinder/.test(tools.r.text) && !unknown.ok && unknown.e.code === "COMMAND_NOT_FOUND" && /^ERROR COMMAND_NOT_FOUND/.test(unknown.e.message));
  const noProjCalls = await Promise.all(["bb_cubes", "bb_group", "bb_mesh", "bb_screenshot", "bb_export", "bb_animate"].map((n) => run(n, { name: "x", cubes: [{ name: "a", from: [0, 0, 0], to: [1, 1, 1] }], vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], format: "obj", bones: { a: [{ time: 0, rotation: [0, 0, 0] }] } }, fakeApi({ project: false }))));
  ok("C28 every building / capturing job refuses to run without an open project (EXECUTION, names bb_project)", noProjCalls.every((x) => !x.ok && x.e.code === "EXECUTION" && /no project is open/i.test(x.e.message)));
  ok("C29 argument errors carry code INVALID_ARGUMENT and the message prefix 'ERROR INVALID_ARGUMENT in <cmd>:' (what the AI sees verbatim)", [cBad, cBad2, ceNone, mBad, primBad, tcBad, anBad, camBad, exBad].every((x) => x.e.code === "INVALID_ARGUMENT" && /^ERROR INVALID_ARGUMENT in bb_[a-z_]+: /.test(x.e.message)));
  fs.rmSync(dir, { recursive: true, force: true });

  // ── D. bridge loop against a fake total-core ───────────────────────────────
  {
    const hub = { hellos: [], results: [], goodbyes: [], queue: [], polls: 0 };
    const srv = http.createServer((req, res) => {
      const chunks = []; req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
        const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        if (req.method === "POST" && req.url === "/api/blockbench/hello") { hub.hellos.push({ body, origin: req.headers.origin || null }); return send(200, { ok: true, version: "2.21.0", client_id: body.client_id }); }
        if (req.method === "GET" && req.url.startsWith("/api/blockbench/poll?client_id=")) { hub.polls++; const job = hub.queue.shift() || null; return setTimeout(() => send(200, { ok: true, job }), job ? 0 : 30); }
        if (req.method === "POST" && req.url === "/api/blockbench/result") { hub.results.push(body); return send(200, { ok: true }); }
        if (req.method === "POST" && req.url === "/api/blockbench/goodbye") { hub.goodbyes.push(body); return send(200, { ok: true, disconnected: true }); }
        send(404, { ok: false });
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + srv.address().port;
    const bapi = fakeApi();
    const states = [];
    const bridge = P.createBridge({ request: P.nodeRequest(net), api: bapi, url, log() {}, onState: (s) => states.push(s.connected) });
    hub.queue.push({ id: "bbjob-1", name: "bb_cubes", args: { cubes: [{ name: "Box", from: [0, 0, 0], to: [4, 4, 4] }] } });
    hub.queue.push({ id: "bbjob-2", name: "bb_cubes", args: { cubes: [] } });
    hub.queue.push({ id: "bbjob-3", name: "bb_nope", args: {} });
    bridge.start();
    const until = Date.now() + 5000;
    while (hub.results.length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const s = bridge.state();
    bridge.stop();
    await new Promise((r) => setTimeout(r, 60));
    srv.close();
    const h = hub.hellos[0] && hub.hellos[0].body;
    ok("D1 hello: POST /api/blockbench/hello {client_id bb-…, version 2.21.0, blockbench_version, project, format, capabilities[27]} with NO Origin header (total-core's origin_guard would refuse a browser origin)", h && /^bb-[a-z0-9]{8}$/.test(h.client_id) && h.version === "2.21.0" && h.blockbench_version === "4.12.0" && h.project === "Fake" && h.format === "free" && JSON.stringify(h.capabilities) === JSON.stringify(P.CAPABILITIES) && hub.hellos[0].origin === null);
    ok("D2 poll → job → POST /api/blockbench/result: ok job carries {id, ok:true, result:{text,…}, elapsed_ms}; the cube really landed in the stand-in Blockbench", hub.results[0] && hub.results[0].id === "bbjob-1" && hub.results[0].client_id === h.client_id && hub.results[0].ok === true && /Placed 1 cube/.test(hub.results[0].result.text) && typeof hub.results[0].elapsed_ms === "number" && bapi._st.nodes.some((n) => n.name === "Box"));
    ok("D3 failing jobs answer ok:false with the ERROR-prefixed message and a code (INVALID_ARGUMENT / COMMAND_NOT_FOUND) - never an exception that stalls the loop", hub.results[1] && hub.results[1].ok === false && hub.results[1].code === "INVALID_ARGUMENT" && /^ERROR INVALID_ARGUMENT in bb_cubes/.test(hub.results[1].error) && hub.results[2] && hub.results[2].code === "COMMAND_NOT_FOUND", hub.results.slice(1));
    ok("D4 state(): connected with jobsDone 3 while running; stop() → connected false + explicit client goodbye; polling kept going between jobs", s.connected === true && s.jobsDone === 3 && s.running === true && bridge.state().connected === false && states[0] === false && states.includes(true) && hub.polls >= 3 && hub.goodbyes.length === 1 && hub.goodbyes[0].client_id === h.client_id);
    const lifecycle = { calls: [] };
    const lifecycleRequest = (method, target, body) => {
      lifecycle.calls.push({ method, target, body });
      if (target.endsWith("/api/blockbench/hello")) return Promise.resolve({ status: 200, json: { ok: true } });
      if (target.includes("/api/blockbench/poll?")) return new Promise((resolve) => setTimeout(() => resolve({ status: 200, json: { ok: true, job: null } }), 30));
      if (target.endsWith("/api/blockbench/goodbye")) return Promise.resolve({ status: 200, json: { ok: true } });
      return Promise.resolve({ status: 200, json: { ok: true } });
    };
    const lifecycleBridge = P.createBridge({ request: lifecycleRequest, api: bapi, url: "http://total-core-old", log() {}, onState() {} });
    const waitFor = async (predicate) => { const deadline = Date.now() + 1500; while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5)); return predicate(); };
    lifecycleBridge.start();
    await waitFor(() => lifecycle.calls.some((c) => c.method === "GET" && c.target.includes("total-core-old/api/blockbench/poll")));
    const firstClient = lifecycleBridge.state().clientId;
    lifecycleBridge.setUrl("http://total-core-new");
    const urlChanged = await waitFor(() => lifecycle.calls.some((c) => c.method === "POST" && c.target === "http://total-core-new/api/blockbench/hello"));
    const secondClient = lifecycleBridge.state().clientId;
    await new Promise((r) => setTimeout(r, 45)); // the old long-poll resolves after the new session starts
    const oldGoodbye = lifecycle.calls.find((c) => c.method === "POST" && c.target === "http://total-core-old/api/blockbench/goodbye");
    const oldPollDidNotWin = lifecycleBridge.state().connected === true && lifecycleBridge.state().url === "http://total-core-new";
    lifecycleBridge.stop();
    lifecycleBridge.start();
    const resumed = await waitFor(() => lifecycle.calls.filter((c) => c.method === "POST" && c.target === "http://total-core-new/api/blockbench/hello").length >= 2);
    const thirdClient = lifecycleBridge.state().clientId;
    lifecycleBridge.stop();
    const goodbyes = lifecycle.calls.filter((c) => c.method === "POST" && c.target.endsWith("/api/blockbench/goodbye"));
    ok("D6 URL change, pause and resume send goodbye to the old session, rotate client IDs, reconnect promptly and ignore a late old poll", urlChanged && resumed && firstClient !== secondClient && secondClient !== thirdClient && oldGoodbye && oldGoodbye.body.client_id === firstClient && oldPollDidNotWin && goodbyes.length === 3 && goodbyes[1].body.client_id === secondClient && goodbyes[2].body.client_id === thirdClient);
    const dead = P.createBridge({ request: P.nodeRequest(net), api: bapi, url: "http://127.0.0.1:1", log() {}, onState() {} });
    const helloDead = await dead.hello();
    ok("D5 nothing listening → hello() false, lastError names the refusal, nothing thrown (the plugin keeps retrying with backoff 2 s → 15 s)", helloDead === false && /ECONNREFUSED|connect/i.test(dead.state().lastError) && /backoff = Math\.min\(15000, Math\.round\(backoff \* 1\.5\)\)/.test(pluginSrc) && /let running = false, connected = false, helloTimer = null, backoff = 2000/.test(pluginSrc) && /generation = 0/.test(pluginSrc));
  }

  // ── E. wiring pins (Rust + extension) ──────────────────────────────────────
  ok("E1 blockbench.rs: Hub status distinguishes connected / explicit disconnect / stale unknown; plugin poll/results and queued jobs are client-bound; goodbye, status, 45s stale and 20s poll handlers; run() timeouts explain picked-up vs not-picked-up", /pub struct Hub \{[\s\S]*?info: Mutex<Option<\(PluginInfo, Instant\)>>,[\s\S]*?explicitly_disconnected: AtomicBool,[\s\S]*?queue: Mutex<VecDeque<PendingJob>>/.test(rs) && /const STALE_AFTER: Duration = Duration::from_secs\(45\);/.test(rs) && /const POLL_WAIT: Duration = Duration::from_secs\(20\);/.test(rs) && ["hello_handler", "poll_handler", "result_handler", "goodbye_handler", "status_handler"].every((h) => rs.includes("pub async fn " + h + "(")) && /state: "unknown"[\s\S]*?heartbeat is stale/.test(rs) && /unknown or disconnected Blockbench client/.test(rs) && /struct PendingJob \{[\s\S]*?client_id: String/.test(rs) && /take_job_for\(&self, client_id: &str\)/.test(rs) && /picked up '\{name\}' but did not finish it/.test(rs) && /did not pick up '\{name\}' within/.test(rs));
  ok("E2 blockbench.rs call(): verified disconnect → ERROR BLOCKBENCH_OFFLINE; stale/unverified → ERROR BLOCKBENCH_STATUS_UNKNOWN; exports get _export_dir only when ready; results render text/images; export paths tracked", /let link = state\.blockbench\.status\(\)\.await;/.test(rs) && /ERROR BLOCKBENCH_OFFLINE/.test(rs) && /ERROR BLOCKBENCH_STATUS_UNKNOWN/.test(rs) && /if link\.state == "disconnected" \{[\s\S]*?anyhow::bail!/.test(rs) && /anyhow::bail!\("ERROR BLOCKBENCH_STATUS_UNKNOWN:/.test(rs) && /obj\.insert\("_export_dir"\.to_string\(\), Value::String\(dir\)\);/.test(rs) && /if state\.workspace\.ready\(\) \{\n\s+Some\(PathBuf::from\(state\.workspace\.root_display\(\)\)\.join\(EXPORT_DIR\)/.test(rs) && /pub const EXPORT_DIR: &str = "blockbench_exports";/.test(rs) && /\.filter\(\|img\| img\.get\("data"\)/.test(rs) && /state\.ui\.track\("blockbench", format!\("export written: \{p\}"\)\)/.test(rs));
  ok("E3 blockbench.rs tools(): only bb_status while disconnected (so the AI can probe), all 27 when connected, every entry server:\"blockbench\" with an object schema; plugin_source_is_the_bridge_plugin test pins JOBS.<name> = for every catalogue name; install() writes PLUGIN_SOURCE next to the executable unless TOTAL_NO_PLUGIN_INSTALL", /if !connected \{\n\s+return v;\n\s+\}/.test(rs) && /"server": "blockbench"/.test(rs) && /assert!\(PLUGIN_SOURCE\.contains\(&format!\("JOBS\.\{n\} ="\)\)/.test(rs) && /include_str!\("\.\.\/\.\.\/plugin\/TotalScript-Blockbench\.js"\)/.test(rs) && /TOTAL_NO_PLUGIN_INSTALL/.test(rs) && /std::fs::write\(&path, PLUGIN_SOURCE\)\?;/.test(rs));
  ok("E4 main.rs: mod blockbench, AppState.blockbench, the four routes, install() logged at boot + set_installed, call_tool dispatch bb_* BEFORE the Studio plugin / MCP helper, BLOCKBENCH_OFFLINE error code, with_blockbench_server() adds {id:\"blockbench\"} to intro + list_tools servers (also when the MCP helper is down), /api/status carries blockbench_connected + blockbench_plugin_file", /^mod blockbench;$/m.test(mainRs) && /blockbench: Arc<blockbench::Hub>,/.test(mainRs) && ["/api/blockbench/hello", "/api/blockbench/poll", "/api/blockbench/result", "/api/blockbench/goodbye", "/api/blockbench/status"].every((r) => mainRs.includes('.route("' + r + '"')) && /match blockbench::install\(\) \{/.test(mainRs) && /state\.blockbench\.set_installed\(Some\(path\.display\(\)\.to_string\(\)\)\)\.await;/.test(mainRs) && /"roblox" => if blockbench::is_tool\(&name\) \{ blockbench::call\(&state2, &name, args\)\.await \} else if plugin::is_plugin_tool\(&name\)/.test(mainRs) && /lower\.contains\("blockbench_status_unknown"\)[\s\S]*?"BLOCKBENCH_STATUS_UNKNOWN"/.test(mainRs) && /lower\.contains\("blockbench_offline"\)[\s\S]*?"BLOCKBENCH_OFFLINE"/.test(mainRs) && (mainRs.match(/with_blockbench_server\(&state, /g) || []).length === 4 && /"blockbench_connected": blockbench\.connected,\n\s+"blockbench_status": blockbench\.state,\n\s+"blockbench_verified": blockbench\.verified,/.test(mainRs) && /tools\.extend\(blockbench::tools\(state\.blockbench\.connected\(\)\.await\)\);/.test(mainRs));
  ok("E5 chat.rs (desktop chat): catalogue lists bb_* on the roblox engine, execute dispatches blockbench::is_tool first, the system prompt states the Blockbench link + file hand-off; gui shows the plugin in Integrations / Health / Help", /let bb_tools = blockbench::tools\(blockbench_connected\);\n\s+to_defs\(&bb_tools, "roblox", &mut tools, &mut seen\);/.test(chatRs) && /blockbench_status: bb_status\.state/.test(chatRs) && /UNKNOWN - no fresh verified Blockbench heartbeat/.test(chatRs) && /if blockbench::is_tool\(name\) \{ blockbench::call\(state, name, args\)\.await \} else if plugin::is_plugin_tool\(name\)/.test(chatRs) && /Blockbench \(TotalScript Bridge plugin\): \{blockbench_line\}/.test(chatRs) && /nothing is inserted into Studio by itself/.test(chatRs) && /pub fn blockbench_status\(&self\) -> &'static str/.test(read("agent/src/gui.rs")) && /unknown — last heartbeat/.test(read("agent/src/gui/center.rs")) && /plugin explicitly paused or unloaded/.test(read("agent/src/gui/prefs.rs")));
  ok("E6 plugin source: BBPlugin.register(totalscript_bridge) desktop-only, min 4.8.0, onload builds the API + permissioned Node net bridge, Tools-menu status / pause actions, a bridge-URL setting, onunload stops + deletes; module.exports only outside Blockbench", /BBPlugin\.register\(PLUGIN_ID, \{/.test(pluginSrc) && /variant: "desktop",\n\s+min_version: "4\.8\.0",/.test(pluginSrc) && /new Action\("totalscript_bridge_status"/.test(pluginSrc) && /new Action\("totalscript_bridge_toggle"/.test(pluginSrc) && /new Setting\("totalscript_bridge_url"/.test(pluginSrc) && /const net = require\("net"\)/.test(pluginSrc) && /net\.createConnection/.test(pluginSrc) && !/require\("http"\)/.test(pluginSrc) && /api\/blockbench\/goodbye/.test(pluginSrc) && /MenuBar\.addAction\(actionStatus, "tools"\)/.test(pluginSrc) && /onunload\(\) \{\n\s+try \{ if \(bridge\) bridge\.stop\(\); \} catch \{\}/.test(pluginSrc) && /if \(typeof BBPlugin === "undefined" && typeof module !== "undefined" && module\.exports\) module\.exports = core;/.test(pluginSrc) && /Undo\.initEdit\(asp\);/.test(pluginSrc) && /Undo\.finishEdit\(label, after\);/.test(pluginSrc) && /Undo\.cancelEdit\(\)/.test(pluginSrc));
  ok("E7 background.js: Blockbench calls validate locally, require a fresh verified total-core status but not the Studio gate, detect offline successful-text replies, and treat cached /api/status server fields as diagnostics only", (() => {
    const i = bg.indexOf('const isBb = typeof TotalBlockbench !== "undefined" && TotalBlockbench.isCommand(msg.name);');
    const j = bg.indexOf("if (blenderAddon && isBlenderToolName(msg.name)) {", i);
    const k = bg.indexOf("if (!connected || robloxEditorConnected !== true) await refreshStudioStatus();", j);
    const branch = bg.slice(i, j);
    const proc = bg.slice(bg.indexOf("async function refreshProcStatus()"), bg.indexOf("\nfunction broadcastStatus()"));
    const refresh = bg.slice(bg.indexOf("function bbRefresh()"), bg.indexOf("\nfunction bbStatusPayload()"));
    const servers = bg.slice(bg.indexOf("function noteBlockbenchServers(list)"), bg.indexOf("\nfunction log("));
    return bg.includes('importScripts("src/core/blockbench_tools.js")') && i > 0 && i < j && j < k &&
      branch.includes('if (!v.ok) { sendResponse({ ok: false, kind: "validation", errorCode: "INVALID_ARGUMENT", error: v.error }); break; }') &&
      branch.includes("bbStatusSnapshot()") && branch.includes("await bbRefresh()") &&
      branch.includes("BLOCKBENCH_STATUS_UNKNOWN") && branch.includes("BLOCKBENCH_OFFLINE") &&
      branch.includes('const br = await send({ type: "call_tool", name: v.name') && !branch.includes("robloxEditorConnected") &&
      branch.includes("const statusText =") && branch.includes("statusErrorReply") && branch.includes("BLOCKBENCH_STATUS_MISMATCH") &&
      refresh.includes("/api/blockbench/status") && refresh.includes('cache: "no-store"') && refresh.includes("j.verified === true") && refresh.includes('j.status === "connected" || j.status === "disconnected"') && refresh.includes('typeof j.connected === "boolean"') && bg.includes("setInterval(() => { void bbRefresh(); }, 5000);") &&
      bg.includes("blockbench_verified: bb.known") && bg.includes("blockbench_status: bb.known") &&
      !proc.includes("blockbench_connected") && !proc.includes("bbSetConnected") &&
      servers.includes("dedicated total-core heartbeat remains authoritative") && !servers.includes("bbSetConnected(bb.alive === true)") &&
      !/TotalBlockbenchMcp|declarativeNetRequest|rsBlockbenchUrl|bb-mcp|blockbenchCall|connectBlockbench/.test(bg) &&
      !fs.existsSync(path.join(ROOT, "src/core/blockbench_mcp.js"));
  })());
  ok("E8 manifest: declarativeNetRequestWithHostAccess permission removed (only the Blockbench MCP client used it); loopback host permissions stay for total-core", !JSON.parse(read("manifest.json")).permissions.includes("declarativeNetRequestWithHostAccess") && JSON.parse(read("manifest.json")).host_permissions.includes("http://127.0.0.1/*"));
  ok("E9 blockbench_tools.js validate(): mirrors the plugin's refusals for the obvious cases (so a bad call never crosses the bridge) and passes the good ones; connectSteps names the file + Load Plugin from File + Tools → TotalScript; offlineMessage starts with ERROR BLOCKBENCH_OFFLINE", !T.validate("bb_cubes", { cubes: [] }).ok && !T.validate("bb_mesh", { name: "m", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2, 3, 0]] }).ok && !T.validate("bb_mesh_primitive", { shape: "cube", name: "x" }).ok && !T.validate("bb_texture", { action: "create", name: "t", fill_color: "red" }).ok && !T.validate("bb_animate", { name: "a", bones: {} }).ok && !T.validate("bb_camera", {}).ok && !T.validate("bb_export", { format: "fbx" }).ok && T.validate("roblox/bb_cubes", { cubes: [{ name: "a", from: [0, 0, 0], to: [1, 1, 1] }] }).name === "bb_cubes" && T.validate("bb_mesh_primitive", { shape: "torus", name: "ring", tube: 1 }).ok && T.validate("bb_texture", { action: "apply", texture: "t", targets: "all" }).ok && T.validate("bb_status", {}).ok && /UNKNOWN_COMMAND/.test(T.validate("bb_paint", {}).error) && T.connectSteps("C:/x/TotalScript-Blockbench.js").some((s) => /Load Plugin from File/.test(s)) && T.connectSteps("C:/x/TotalScript-Blockbench.js")[0].includes("C:/x/TotalScript-Blockbench.js") && T.connectSteps().some((s) => /Tools → TotalScript/.test(s)) && /^ERROR BLOCKBENCH_OFFLINE: /.test(T.offlineMessage()));

  console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
