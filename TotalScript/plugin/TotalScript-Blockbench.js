// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript Bridge - a plugin for Blockbench (desktop) · 2.19.0
//
// Install once: Blockbench → File → Plugins → Load Plugin from File → this
// file (total-core also writes a copy next to its executable and the popup /
// desktop app show the path). Blockbench remembers it; it loads on every start.
//
// What it does: the plugin DIALS OUT to the TotalScript desktop app
// (total-core, http://127.0.0.1:3000) with Node's http module - the same
// hello / long-poll / result loop the Studio plugin uses:
//   POST /api/blockbench/hello    {client_id, version, blockbench_version, project, format, capabilities}
//   GET  /api/blockbench/poll?client_id=…   → {ok, job:{id,name,args}|null}   (long poll, ~20 s)
//   POST /api/blockbench/result   {id, ok, result, error?, elapsed_ms}
// No port is opened in Blockbench, nothing listens, no MCP session, no CORS
// / Origin dance: the app is the only thing that ever talks to this plugin and
// it is the app's own loopback server (requests without an Origin header).
// The AI - in the desktop chat or through the browser extension on a chat
// site - calls the bb_* commands; total-core queues them here; the plugin runs
// them with Blockbench's real API and answers with text (+ a PNG for
// bb_screenshot). Exports are written to <workspace>/blockbench_exports when
// the app has a workspace, else ~/Documents/TotalScript/blockbench_exports.
//
// Pure-JS core: the JOBS table and the geometry helpers never touch Blockbench
// globals directly - they go through `api` so tests/test-blockbench-plugin.js
// can run every command against a stand-in. Nothing here evaluates code sent
// by the AI; every job is a fixed, validated operation.
(function () {
  "use strict";
  const VERSION = "2.19.0";
  const PLUGIN_ID = "totalscript_bridge";
  const DEFAULT_BRIDGE = "http://127.0.0.1:3000";
  const HELLO_EVERY_MS = 25000;
  const POLL_TIMEOUT_MS = 30000;
  const CAPABILITIES = Object.freeze([
    "bb_status", "bb_project", "bb_cubes", "bb_cube_edit", "bb_group", "bb_remove",
    "bb_mesh", "bb_mesh_primitive", "bb_mesh_edit", "bb_texture", "bb_animate",
    "bb_camera", "bb_screenshot", "bb_export", "bb_undo", "bb_redo", "bb_tools",
  ]);

  // ── small helpers ─────────────────────────────────────────────────────────
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const clip = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  function fail(cmd, msg) { const e = new Error("ERROR INVALID_ARGUMENT in " + cmd + ": " + msg); e.code = "INVALID_ARGUMENT"; return e; }
  function failRun(cmd, msg) { const e = new Error("ERROR in " + cmd + ": " + msg); e.code = "EXECUTION"; return e; }
  const safeName = (v, fallback) => { const s = String(v == null ? "" : v).trim().replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "").slice(0, 64); return s || fallback; };
  const hex = (v) => /^#?[0-9a-f]{6}$/i.test(String(v || "").trim()) ? "#" + String(v).trim().replace(/^#/, "").toLowerCase() : null;

  // ── geometry (pure) ─────────────────────────────────────────────────────────
  // primitiveGeometry(shape, opts) → {vertices:[[x,y,z]…], faces:[[i,…]…]}.
  // Faces are listed counter-clockwise seen from OUTSIDE (what OBJ / glTF
  // viewers and Roblox's importer treat as the front side). Y is up, like
  // Blockbench. Closed shapes satisfy V - E + F = 2 (torus: 0) - the test
  // checks it, so a wrong wind or a missing cap cannot slip through.
  function primitiveGeometry(shape, o) {
    o = o || {};
    const sides = Math.max(3, Math.min(64, Math.round(Number(o.sides) || 12)));
    const diameter = isNum(o.diameter) && o.diameter > 0 ? o.diameter : 8;
    const r = diameter / 2;
    const height = isNum(o.height) && o.height > 0 ? o.height : diameter;
    const V = [], F = [];
    const ring = (y, radius) => { const start = V.length; for (let i = 0; i < sides; i++) { const a = (i / sides) * Math.PI * 2; V.push([r3(Math.cos(a) * radius), r3(y), r3(Math.sin(a) * radius)]); } return start; };
    // Blockbench faces are tris or quads, so caps are triangle fans around a
    // centre vertex. Ring order (angle increasing from +X towards +Z) runs
    // CLOCKWISE seen from +Y, so: walls go lower_i → upper_i → upper_j →
    // lower_j, the bottom fan is centre → i → j, the top fan centre → j → i.
    const wall = (lower, upper) => { for (let i = 0; i < sides; i++) { const j = (i + 1) % sides; F.push([lower + i, upper + i, upper + j, lower + j]); } };
    const fan = (start, centre, top) => { for (let i = 0; i < sides; i++) { const j = (i + 1) % sides; F.push(top ? [centre, start + j, start + i] : [centre, start + i, start + j]); } };
    const centreAt = (y) => { V.push([0, r3(y), 0]); return V.length - 1; };
    switch (shape) {
      case "cylinder": { const b = ring(0, r), t = ring(height, r); wall(b, t); fan(b, centreAt(0), false); fan(t, centreAt(height), true); break; }
      case "cone": { const b = ring(0, r); const apex = centreAt(height); fan(b, apex, true); fan(b, centreAt(0), false); break; }
      case "pyramid": { const b = V.length; const h = r; V.push([-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h]); const apex = centreAt(height); F.push([b + 1, b, apex], [b + 2, b + 1, apex], [b + 3, b + 2, apex], [b, b + 3, apex]); F.push([b, b + 1, b + 2, b + 3]); break; }
      case "plane": { const h = r; V.push([-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h]); F.push([3, 2, 1, 0]); break; }
      case "sphere": {
        const rings = Math.max(2, Math.round(sides / 2));
        const bottom = centreAt(-r);
        const starts = [];
        for (let k = 1; k < rings; k++) { const phi = -Math.PI / 2 + (k / rings) * Math.PI; starts.push(ring(r * Math.sin(phi), r * Math.cos(phi))); }
        const top = centreAt(r);
        fan(starts[0], bottom, false);
        for (let k = 0; k + 1 < starts.length; k++) wall(starts[k], starts[k + 1]);
        fan(starts[starts.length - 1], top, true);
        break;
      }
      case "torus": {
        const tube = isNum(o.tube) && o.tube > 0 ? o.tube : Math.max(0.5, r / 3);
        const segs = sides, tsegs = Math.max(3, Math.min(32, Math.round(Number(o.tube_sides) || Math.max(3, Math.round(sides / 2)))));
        const R = r;
        for (let i = 0; i < segs; i++) { const a = (i / segs) * Math.PI * 2; for (let k = 0; k < tsegs; k++) { const b = (k / tsegs) * Math.PI * 2; const rr = R + tube * Math.cos(b); V.push([r3(Math.cos(a) * rr), r3(Math.sin(b) * tube), r3(Math.sin(a) * rr)]); } }
        for (let i = 0; i < segs; i++) { const i2 = (i + 1) % segs; for (let k = 0; k < tsegs; k++) { const k2 = (k + 1) % tsegs; F.push([i * tsegs + k, i * tsegs + k2, i2 * tsegs + k2, i2 * tsegs + k]); } }
        break;
      }
      default: return null;
    }
    const pos = vec3(o.position) ? o.position : [0, 0, 0];
    if (pos[0] || pos[1] || pos[2]) for (const v of V) { v[0] = r3(v[0] + pos[0]); v[1] = r3(v[1] + pos[1]); v[2] = r3(v[2] + pos[2]); }
    return { vertices: V, faces: F };
  }
  // Newell normal of a face (used by the test's outward check and by nothing
  // else at runtime - kept here so the geometry and its proof live together).
  function faceNormal(vertices, face) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < face.length; i++) { const a = vertices[face[i]], b = vertices[face[(i + 1) % face.length]]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
    return [nx, ny, nz];
  }
  const PRIMITIVES = Object.freeze(["cylinder", "cone", "pyramid", "plane", "sphere", "torus"]);

  // Euler check used by bb_mesh validation and the test: every face index valid,
  // ≥ 3 distinct vertices per face.
  function validateMeshData(vertices, faces) {
    if (!Array.isArray(vertices) || vertices.length < 3) return "vertices must be an array of at least 3 [x,y,z] points";
    for (let i = 0; i < vertices.length; i++) if (!vec3(vertices[i])) return "vertices[" + i + "] must be [x,y,z] numbers";
    if (!Array.isArray(faces) || !faces.length) return "faces must be a non-empty array of vertex-index lists";
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      if (!Array.isArray(f) || f.length < 3 || f.length > 4) return "faces[" + i + "] must list 3 or 4 vertex indices (Blockbench faces are tris or quads)";
      for (const ix of f) if (!Number.isInteger(ix) || ix < 0 || ix >= vertices.length) return "faces[" + i + "] references vertex " + ix + " which does not exist";
      if (new Set(f).size !== f.length) return "faces[" + i + "] repeats a vertex";
    }
    if (vertices.length > 4000 || faces.length > 4000) return "at most 4000 vertices / faces per bb_mesh call";
    return null;
  }

  // ── JOBS: name → async (args, api) → result ───────────────────────────────
  // `api` is the Blockbench adapter below (or the test's stand-in).
  const JOBS = {};

  JOBS.bb_status = async (a, api) => {
    const depth = Math.min(32, Math.max(1, Math.round(Number(a && a.max_depth) || 4)));
    const p = api.project();
    if (!p) return { text: "No project is open in Blockbench. Create one with bb_project {name, format:\"free\"} (or open a file in Blockbench).", project: null };
    const tree = api.outline(depth);
    const lines = [];
    const walk = (nodes, ind) => { for (const n of nodes) { lines.push(ind + n.line); if (n.children) walk(n.children, ind + "  "); } };
    walk(tree, "");
    const summary = { name: p.name, format: p.format, texture_size: [p.texture_width, p.texture_height], cubes: p.cubes, meshes: p.meshes, groups: p.groups, textures: p.textures, animations: p.animations, blockbench: api.version() };
    const text = "Blockbench project " + JSON.stringify(summary) + "\nOutliner (depth " + depth + "):\n" + (lines.length ? lines.join("\n") : "(empty)");
    return { text: clip(text, 12000), project: summary };
  };

  JOBS.bb_project = async (a, api) => {
    if (!str(a && a.name)) throw fail("bb_project", "name (string) is required");
    const format = str(a && a.format) ? String(a.format).trim() : "free";
    if (!api.hasFormat(format)) throw fail("bb_project", "unknown format '" + format + "'. Available: " + api.formats().join(", "));
    const ok = api.newProject(format, String(a.name).trim());
    if (!ok) throw failRun("bb_project", "Blockbench refused to create the project (a dialog may be open)");
    const p = api.project();
    return { text: "Created project '" + p.name + "' (format " + p.format + "). Next: bb_group for each part, bb_cubes / bb_mesh_primitive inside them, bb_screenshot to look." };
  };

  function parseCubes(cmd, a) {
    const cubes = a && Array.isArray(a.cubes) ? a.cubes : (a && a.cube && typeof a.cube === "object" ? [a.cube] : null);
    if (!cubes || !cubes.length) throw fail(cmd, "cubes (non-empty array) is required");
    if (cubes.length > 200) throw fail(cmd, "at most 200 cubes per call");
    const out = [];
    for (let i = 0; i < cubes.length; i++) {
      const c = cubes[i] || {};
      if (!str(c.name)) throw fail(cmd, "cubes[" + i + "].name is required");
      if (!vec3(c.from) || !vec3(c.to)) throw fail(cmd, "cubes[" + i + "] needs from and to as [x,y,z] numbers");
      for (let k = 0; k < 3; k++) if (c.from[k] > c.to[k]) throw fail(cmd, "cubes[" + i + "] ('" + c.name + "'): from must be <= to on every axis (axis " + "xyz"[k] + ": " + c.from[k] + " > " + c.to[k] + ")");
      const el = { name: String(c.name).trim(), from: c.from.slice(), to: c.to.slice() };
      if (c.origin !== undefined) { if (!vec3(c.origin)) throw fail(cmd, "cubes[" + i + "].origin must be [x,y,z]"); el.origin = c.origin.slice(); }
      if (c.rotation !== undefined) { if (!vec3(c.rotation)) throw fail(cmd, "cubes[" + i + "].rotation must be [x,y,z] degrees"); el.rotation = c.rotation.slice(); }
      if (c.inflate !== undefined) { if (!isNum(c.inflate)) throw fail(cmd, "cubes[" + i + "].inflate must be a number"); el.inflate = c.inflate; }
      if (c.color !== undefined) { if (!Number.isInteger(c.color) || c.color < 0 || c.color > 9) throw fail(cmd, "cubes[" + i + "].color must be a marker colour index 0-9"); el.color = c.color; }
      out.push(el);
    }
    return out;
  }

  JOBS.bb_cubes = async (a, api) => {
    const cubes = parseCubes("bb_cubes", a);
    if (!api.project()) throw failRun("bb_cubes", "no project is open - bb_project first");
    const group = str(a.group) ? api.findGroup(a.group) : null;
    if (str(a.group) && !group) throw failRun("bb_cubes", "group '" + a.group + "' not found - create it with bb_group or omit group");
    const texture = str(a.texture) ? api.findTexture(a.texture) : null;
    if (str(a.texture) && !texture) throw failRun("bb_cubes", "texture '" + a.texture + "' not found (bb_texture {action:\"list\"})");
    const made = api.edit("TotalScript: place cubes", { outliner: true }, () => cubes.map((c) => api.addCube(c, group, texture)));
    return { text: "Placed " + made.length + " cube(s)" + (group ? " in group '" + group.name + "'" : " at root") + (texture ? " with texture '" + texture.name + "'" : "") + ": " + made.map((m) => m.name).join(", ") + ". bb_screenshot to look; bb_status to read the tree back.", created: made.map((m) => ({ name: m.name, uuid: m.uuid })) };
  };

  JOBS.bb_cube_edit = async (a, api) => {
    const key = a && (a.name || a.uuid);
    if (!str(key)) throw fail("bb_cube_edit", "name (or uuid) of the cube is required");
    const cube = api.findCube(key);
    if (!cube) throw failRun("bb_cube_edit", "no cube named '" + key + "' (bb_status lists them)");
    const patch = {};
    for (const k of ["from", "to", "origin", "rotation"]) if (a[k] !== undefined) { if (!vec3(a[k])) throw fail("bb_cube_edit", k + " must be [x,y,z]"); patch[k] = a[k].slice(); }
    if (a.inflate !== undefined) { if (!isNum(a.inflate)) throw fail("bb_cube_edit", "inflate must be a number"); patch.inflate = a.inflate; }
    if (a.rename !== undefined) { if (!str(a.rename)) throw fail("bb_cube_edit", "rename must be a non-empty string"); patch.name = String(a.rename).trim(); }
    if (a.color !== undefined) { if (!Number.isInteger(a.color) || a.color < 0 || a.color > 9) throw fail("bb_cube_edit", "color must be a marker colour index 0-9"); patch.color = a.color; }
    if (a.visible !== undefined) patch.visibility = !!a.visible;
    const from = patch.from || cube.from, to = patch.to || cube.to;
    for (let k = 0; k < 3; k++) if (from[k] > to[k]) throw fail("bb_cube_edit", "from must be <= to on every axis after the edit");
    if (!Object.keys(patch).length) throw fail("bb_cube_edit", "nothing to change (from, to, origin, rotation, inflate, rename, color, visible, group)");
    const group = str(a.group) ? api.findGroup(a.group) : undefined;
    if (str(a.group) && !group) throw failRun("bb_cube_edit", "group '" + a.group + "' not found");
    api.edit("TotalScript: edit cube", { elements: [cube], outliner: !!group }, () => { api.extendCube(cube, patch); if (group) api.moveTo(cube, group); });
    return { text: "Edited cube '" + cube.name + "': " + Object.keys(patch).join(", ") + (group ? " → group '" + group.name + "'" : "") + ".", cube: api.describeCube(cube) };
  };

  JOBS.bb_group = async (a, api) => {
    if (!str(a && a.name)) throw fail("bb_group", "name is required");
    if (!api.project()) throw failRun("bb_group", "no project is open - bb_project first");
    if (a.origin !== undefined && !vec3(a.origin)) throw fail("bb_group", "origin (pivot) must be [x,y,z]");
    if (a.rotation !== undefined && !vec3(a.rotation)) throw fail("bb_group", "rotation must be [x,y,z] degrees");
    const parent = str(a.parent) ? api.findGroup(a.parent) : null;
    if (str(a.parent) && !parent) throw failRun("bb_group", "parent group '" + a.parent + "' not found");
    const move = Array.isArray(a.move) ? a.move.map(String) : [];
    const members = move.map((n) => api.findElement(n) || api.findGroup(n));
    const missing = move.filter((n, i) => !members[i]);
    if (missing.length) throw failRun("bb_group", "cannot move into the group, not found: " + missing.join(", "));
    const existing = api.findGroup(a.name);
    const g = api.edit("TotalScript: group", { outliner: true }, () => {
      const grp = existing || api.addGroup({ name: String(a.name).trim(), origin: a.origin, rotation: a.rotation }, parent);
      if (existing && (a.origin || a.rotation)) api.extendGroup(grp, { origin: a.origin, rotation: a.rotation });
      for (const m of members) api.moveTo(m, grp);
      return grp;
    });
    return { text: (existing ? "Updated" : "Created") + " group '" + g.name + "'" + (parent ? " under '" + parent.name + "'" : "") + (a.origin ? " pivot " + JSON.stringify(a.origin) : "") + (members.length ? ", moved in: " + move.join(", ") : "") + ".", group: { name: g.name, uuid: g.uuid } };
  };

  JOBS.bb_remove = async (a, api) => {
    const names = a && Array.isArray(a.names) ? a.names.map(String) : (str(a && a.name) ? [a.name] : []);
    if (!names.length) throw fail("bb_remove", "names (array of cube / mesh / group names) is required");
    const found = [], missing = [];
    for (const n of names) { const node = api.findElement(n) || api.findGroup(n); if (node) found.push(node); else missing.push(n); }
    if (!found.length) throw failRun("bb_remove", "nothing matched: " + missing.join(", "));
    api.edit("TotalScript: remove", { outliner: true, elements: found.filter((f) => f.type !== "group") }, () => { for (const f of found) api.removeNode(f); });
    return { text: "Removed " + found.length + ": " + found.map((f) => f.name).join(", ") + (missing.length ? " (not found: " + missing.join(", ") + ")" : "") + "." };
  };

  JOBS.bb_mesh = async (a, api) => {
    if (!str(a && a.name)) throw fail("bb_mesh", "name is required");
    const err = validateMeshData(a.vertices, a.faces);
    if (err) throw fail("bb_mesh", err);
    if (!api.project()) throw failRun("bb_mesh", "no project is open - bb_project first");
    if (!api.meshesAllowed()) throw failRun("bb_mesh", "the current format does not support meshes - use bb_project {format:\"free\"}");
    if (a.origin !== undefined && !vec3(a.origin)) throw fail("bb_mesh", "origin must be [x,y,z]");
    const group = str(a.group) ? api.findGroup(a.group) : null;
    if (str(a.group) && !group) throw failRun("bb_mesh", "group '" + a.group + "' not found");
    const texture = str(a.texture) ? api.findTexture(a.texture) : null;
    if (str(a.texture) && !texture) throw failRun("bb_mesh", "texture '" + a.texture + "' not found");
    const mesh = api.edit("TotalScript: mesh", { outliner: true }, () => api.addMesh({ name: String(a.name).trim(), vertices: a.vertices, faces: a.faces, origin: a.origin }, group, texture));
    return { text: "Created mesh '" + mesh.name + "' with " + a.vertices.length + " vertices / " + a.faces.length + " faces" + (group ? " in '" + group.name + "'" : "") + ". bb_screenshot to look.", mesh: { name: mesh.name, uuid: mesh.uuid, vertices: a.vertices.length, faces: a.faces.length } };
  };

  JOBS.bb_mesh_primitive = async (a, api) => {
    const shape = String(a && a.shape || "").trim().toLowerCase();
    if (!PRIMITIVES.includes(shape)) throw fail("bb_mesh_primitive", "shape must be one of " + PRIMITIVES.join(", "));
    if (!str(a.name)) throw fail("bb_mesh_primitive", "name is required");
    for (const k of ["diameter", "height", "tube"]) if (a[k] !== undefined && !(isNum(a[k]) && a[k] > 0)) throw fail("bb_mesh_primitive", k + " must be a positive number");
    if (a.sides !== undefined && !(Number.isInteger(a.sides) && a.sides >= 3 && a.sides <= 64)) throw fail("bb_mesh_primitive", "sides must be an integer 3-64");
    if (a.position !== undefined && !vec3(a.position)) throw fail("bb_mesh_primitive", "position must be [x,y,z] (the base centre)");
    const geo = primitiveGeometry(shape, a);
    const sub = Object.assign({}, a, { vertices: geo.vertices, faces: geo.faces, origin: a.origin || a.position || [0, 0, 0] });
    const r = await JOBS.bb_mesh(sub, api);
    r.text = "Built " + shape + " mesh '" + String(a.name).trim() + "' (" + geo.vertices.length + " vertices / " + geo.faces.length + " faces" + (a.sides ? ", " + a.sides + " sides" : "") + ")" + (str(a.group) ? " in '" + a.group + "'" : "") + ". bb_screenshot to look; bb_mesh_edit to move / scale / rotate it.";
    return r;
  };

  JOBS.bb_mesh_edit = async (a, api) => {
    const key = a && (a.name || a.uuid);
    if (!str(key)) throw fail("bb_mesh_edit", "name (or uuid) of the mesh is required");
    const mesh = api.findMesh(key);
    if (!mesh) throw failRun("bb_mesh_edit", "no mesh named '" + key + "'");
    const ops = [];
    if (a.move !== undefined) { if (!vec3(a.move)) throw fail("bb_mesh_edit", "move must be [dx,dy,dz]"); ops.push(["move", a.move]); }
    if (a.scale !== undefined) { const s = isNum(a.scale) ? [a.scale, a.scale, a.scale] : a.scale; if (!vec3(s) || s.some((v) => v <= 0)) throw fail("bb_mesh_edit", "scale must be a positive number or [sx,sy,sz]"); ops.push(["scale", s]); }
    if (a.rotate !== undefined) { if (!vec3(a.rotate)) throw fail("bb_mesh_edit", "rotate must be [x,y,z] degrees (applied to the vertices around the mesh origin)"); ops.push(["rotate", a.rotate]); }
    if (a.rename !== undefined) { if (!str(a.rename)) throw fail("bb_mesh_edit", "rename must be a non-empty string"); ops.push(["rename", String(a.rename).trim()]); }
    if (a.origin !== undefined) { if (!vec3(a.origin)) throw fail("bb_mesh_edit", "origin must be [x,y,z]"); ops.push(["origin", a.origin]); }
    if (!ops.length) throw fail("bb_mesh_edit", "nothing to change (move, scale, rotate, rename, origin, group)");
    const group = str(a.group) ? api.findGroup(a.group) : undefined;
    if (str(a.group) && !group) throw failRun("bb_mesh_edit", "group '" + a.group + "' not found");
    api.edit("TotalScript: edit mesh", { elements: [mesh], outliner: !!group }, () => {
      for (const [op, v] of ops) {
        if (op === "rename") api.extendMesh(mesh, { name: v });
        else if (op === "origin") api.extendMesh(mesh, { origin: v });
        else api.transformMeshVertices(mesh, op, v);
      }
      if (group) api.moveTo(mesh, group);
    });
    return { text: "Edited mesh '" + mesh.name + "': " + ops.map((o) => o[0]).join(", ") + (group ? " → '" + group.name + "'" : "") + ".", mesh: api.describeMesh(mesh) };
  };

  JOBS.bb_texture = async (a, api) => {
    const action = String(a && a.action || "list").trim().toLowerCase();
    if (action === "list") {
      const list = api.textures();
      return { text: list.length ? "Textures (" + list.length + "): " + list.map((t) => t.name + " (" + t.width + "x" + t.height + (t.uuid ? ", " + t.uuid.slice(0, 8) : "") + ")").join("; ") : "No textures in the project. bb_texture {action:\"create\", name, width, height, fill_color} makes a flat colour.", textures: list };
    }
    if (!api.project()) throw failRun("bb_texture", "no project is open - bb_project first");
    if (action === "create") {
      if (!str(a.name)) throw fail("bb_texture", "name is required for create");
      const w = Math.round(Number(a.width) || 16), h = Math.round(Number(a.height) || w);
      if (w < 1 || h < 1 || w > 1024 || h > 1024) throw fail("bb_texture", "width / height must be 1-1024");
      const fill = a.fill_color === undefined ? "#8e8e8e" : hex(a.fill_color);
      if (!fill) throw fail("bb_texture", "fill_color must be a #rrggbb hex colour");
      const t = api.createTexture(String(a.name).trim(), w, h, fill);
      let applied = 0;
      if (a.apply_to) applied = applyTexture(api, t, a.apply_to);
      return { text: "Created texture '" + t.name + "' " + w + "x" + h + " filled " + fill + (applied ? " and applied it to " + applied + " element(s)" : "") + ". bb_texture {action:\"apply\", texture:\"" + t.name + "\", targets:[…]} to put it on cubes / meshes / groups.", texture: { name: t.name, uuid: t.uuid, width: w, height: h } };
    }
    if (action === "import") {
      if (!str(a.path)) throw fail("bb_texture", "path (PNG on this computer) is required for import");
      if (!api.fileExists(a.path)) throw failRun("bb_texture", "file not found: " + a.path);
      const t = api.importTexture(String(a.path), str(a.name) ? String(a.name).trim() : undefined);
      let applied = 0;
      if (a.apply_to) applied = applyTexture(api, t, a.apply_to);
      return { text: "Imported texture '" + t.name + "' from " + a.path + (applied ? " and applied it to " + applied + " element(s)" : "") + ".", texture: { name: t.name, uuid: t.uuid } };
    }
    if (action === "apply") {
      const key = a.texture || a.name || a.id;
      if (!str(key)) throw fail("bb_texture", "texture (name or uuid) is required for apply");
      const t = api.findTexture(key);
      if (!t) throw failRun("bb_texture", "texture '" + key + "' not found (bb_texture {action:\"list\"})");
      const targets = a.targets || a.target || a.apply_to;
      if (!targets) throw fail("bb_texture", "targets (array of cube / mesh / group names, or \"all\") is required for apply");
      const n = applyTexture(api, t, targets);
      return { text: "Applied texture '" + t.name + "' to " + n + " element(s).", applied: n };
    }
    throw fail("bb_texture", "action must be list | create | import | apply");
  };
  function applyTexture(api, t, targets) {
    const list = targets === "all" ? ["all"] : (Array.isArray(targets) ? targets.map(String) : [String(targets)]);
    let n = 0;
    api.edit("TotalScript: apply texture", { elements: [], outliner: false }, () => {
      for (const name of list) {
        if (name === "all") { n += api.applyTextureTo(t, null); continue; }
        const node = api.findElement(name) || api.findGroup(name);
        if (!node) throw failRun("bb_texture", "target '" + name + "' not found");
        n += api.applyTextureTo(t, node);
      }
    });
    return n;
  }

  JOBS.bb_animate = async (a, api) => {
    if (!str(a && a.name)) throw fail("bb_animate", "name is required");
    if (!api.project()) throw failRun("bb_animate", "no project is open");
    if (!api.animationsAllowed()) throw failRun("bb_animate", "the current format has no animation mode - use a bone-rig format (free works)");
    const length = isNum(a.length) && a.length > 0 ? a.length : 1;
    const bones = a.bones && typeof a.bones === "object" && !Array.isArray(a.bones) ? a.bones : null;
    if (!bones || !Object.keys(bones).length) throw fail("bb_animate", "bones {GroupName: [{time, rotation?:[x,y,z], position?:[x,y,z], scale?:[x,y,z]}]} is required");
    const plan = [];
    for (const [groupName, keys] of Object.entries(bones)) {
      const g = api.findGroup(groupName);
      if (!g) throw failRun("bb_animate", "group '" + groupName + "' not found - animations target GROUPS (bones)");
      if (!Array.isArray(keys) || !keys.length) throw fail("bb_animate", "bones." + groupName + " must be a non-empty array of keyframes");
      for (const k of keys) {
        if (!k || !isNum(k.time) || k.time < 0 || k.time > length) throw fail("bb_animate", "bones." + groupName + ": every keyframe needs time within 0.." + length);
        let any = false;
        for (const ch of ["rotation", "position", "scale"]) if (k[ch] !== undefined) { if (!vec3(k[ch])) throw fail("bb_animate", "bones." + groupName + "." + ch + " must be [x,y,z]"); any = true; }
        if (!any) throw fail("bb_animate", "bones." + groupName + ": a keyframe needs rotation, position or scale");
      }
      plan.push([g, keys]);
    }
    const anim = api.edit("TotalScript: animation", { animations: true }, () => {
      const an = api.createAnimation({ name: String(a.name).trim(), loop: a.loop === undefined ? true : !!a.loop, length });
      let count = 0;
      for (const [g, keys] of plan) for (const k of keys) for (const ch of ["rotation", "position", "scale"]) if (k[ch]) { api.addKeyframe(an, g, ch, k.time, k[ch]); count++; }
      an.__keyframes = count;
      return an;
    });
    return { text: "Animation '" + anim.name + "' (" + length + " s, " + (a.loop === false ? "once" : "loop") + ") with " + anim.__keyframes + " keyframe(s) on " + plan.map((p) => p[0].name).join(", ") + ". It is selected in the Animate tab; glTF export carries it (Studio imports glTF animations only partially).", animation: { name: anim.name, length, keyframes: anim.__keyframes } };
  };

  JOBS.bb_camera = async (a, api) => {
    const preset = str(a && a.view) ? String(a.view).trim().toLowerCase() : "";
    if (preset) {
      if (!api.hasAnglePreset(preset)) throw fail("bb_camera", "view must be one of " + api.anglePresets().join(", "));
      api.loadAnglePreset(preset);
    }
    if (a && a.position !== undefined) { if (!vec3(a.position)) throw fail("bb_camera", "position must be [x,y,z]"); }
    if (a && a.target !== undefined) { if (!vec3(a.target)) throw fail("bb_camera", "target must be [x,y,z]"); }
    if (a && (a.position || a.target)) api.setCamera(a.position || null, a.target || null);
    if (a && str(a.focus)) { const node = api.findElement(a.focus) || api.findGroup(a.focus); if (!node) throw failRun("bb_camera", "focus '" + a.focus + "' not found"); api.focusCamera(node); }
    if (!preset && !(a && (a.position || a.target || str(a.focus)))) throw fail("bb_camera", "give view (front|back|left|right|top|bottom|isometric_right|isometric_left), position/target or focus");
    return { text: "Camera set" + (preset ? " to " + preset : "") + (a.position ? " position " + JSON.stringify(a.position) : "") + (a.target ? " target " + JSON.stringify(a.target) : "") + (a.focus ? " focused on '" + a.focus + "'" : "") + ". bb_screenshot to capture it." };
  };

  JOBS.bb_screenshot = async (a, api) => {
    if (!api.project()) throw failRun("bb_screenshot", "no project is open");
    const max = Math.min(2048, Math.max(128, Math.round(Number(a && a.max_size) || 1024)));
    if (a && str(a.view)) { if (!api.hasAnglePreset(String(a.view).toLowerCase())) throw fail("bb_screenshot", "view must be one of " + api.anglePresets().join(", ")); api.loadAnglePreset(String(a.view).toLowerCase()); }
    const dataUrl = await api.screenshot(max);
    const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(String(dataUrl || ""));
    if (!m) throw failRun("bb_screenshot", "Blockbench returned no image (is the 3D preview visible?)");
    const p = api.project();
    return { text: "Blockbench viewport" + (a && a.view ? " (" + a.view + ")" : "") + " of '" + p.name + "' - " + p.cubes + " cube(s), " + p.meshes + " mesh(es), " + p.groups + " group(s). Judge proportions, silhouette, gaps, z-fighting and pivots; fix, then screenshot again.", images: [{ mimeType: m[1].toLowerCase(), data: m[2] }] };
  };

  const FORMATS = Object.freeze({ obj: ".obj", gltf: ".gltf", glb: ".glb", bbmodel: ".bbmodel" });
  JOBS.bb_export = async (a, api) => {
    const format = String(a && a.format || "obj").trim().toLowerCase();
    if (!FORMATS[format]) throw fail("bb_export", "format must be obj | gltf | glb | bbmodel");
    const p = api.project();
    if (!p) throw failRun("bb_export", "no project is open");
    const base = safeName(a && a.name, safeName(p.name, "model"));
    const dir = str(a && a._export_dir) ? String(a._export_dir) : api.defaultExportDir();
    api.ensureDir(dir);
    let file = api.joinPath(dir, base + FORMATS[format]);
    if (!(a && a.overwrite === true)) { let n = 2; while (api.fileExists(file)) { file = api.joinPath(dir, base + "-" + n + FORMATS[format]); n++; } }
    const written = [];
    if (format === "obj") {
      const out = await api.compileObj();
      api.writeText(file, out.obj); written.push(file);
      const mtlPath = file.replace(/\.obj$/, ".mtl");
      if (out.mtl) { api.writeText(mtlPath, out.mtl); written.push(mtlPath); }
      for (const img of out.images || []) { const ip = api.joinPath(dir, img.name); api.writeBase64(ip, img.base64); written.push(ip); }
    } else if (format === "gltf") {
      api.writeText(file, await api.compileGltf("ascii")); written.push(file);
    } else if (format === "glb") {
      api.writeBuffer(file, await api.compileGltf("binary")); written.push(file);
    } else {
      api.writeText(file, api.compileProject()); written.push(file);
    }
    const steps = format === "bbmodel"
      ? "A .bbmodel is the editable Blockbench project (File → Open Model); Roblox Studio cannot import it - export obj / gltf / glb for Studio."
      : "Roblox Studio: Home → Import 3D → pick " + file + " → check scale (16 Blockbench units = 1 block; set the import scale so the piece is the size you want in studs) → Import. TotalScript did NOT import or upload anything.";
    return { text: "Exported " + format.toUpperCase() + " → " + file + (written.length > 1 ? " (+ " + (written.length - 1) + " companion file(s): " + written.slice(1).map((w) => api.baseName(w)).join(", ") + ")" : "") + ".\n" + steps, path: file, files: written, format };
  };

  JOBS.bb_undo = async (a, api) => { const n = Math.min(20, Math.max(1, Math.round(Number(a && a.steps) || 1))); let done = 0; for (let i = 0; i < n; i++) if (api.undo()) done++; else break; return { text: "Undid " + done + " step(s)." + (done < n ? " Nothing older to undo." : "") }; };
  JOBS.bb_redo = async (a, api) => { const n = Math.min(20, Math.max(1, Math.round(Number(a && a.steps) || 1))); let done = 0; for (let i = 0; i < n; i++) if (api.redo()) done++; else break; return { text: "Redid " + done + " step(s)." }; };
  JOBS.bb_tools = async (a, api) => ({ text: "TotalScript Blockbench plugin " + VERSION + " on Blockbench " + api.version() + ". Commands: " + CAPABILITIES.join(", ") + ". Formats: " + api.formats().join(", ") + ". Camera views: " + api.anglePresets().join(", ") + ". Mesh primitives: " + PRIMITIVES.join(", ") + "." });

  async function runJob(name, args, api) {
    const bare = String(name || "").split("/").pop();
    const fn = Object.prototype.hasOwnProperty.call(JOBS, bare) ? JOBS[bare] : null;
    if (!fn) { const e = new Error("ERROR COMMAND_NOT_FOUND: the TotalScript Blockbench plugin has no command '" + bare + "' (bb_tools lists them)"); e.code = "COMMAND_NOT_FOUND"; throw e; }
    return fn(args && typeof args === "object" ? args : {}, api);
  }

  // ── Blockbench adapter (only this part touches Blockbench globals) ─────────
  function makeBlockbenchApi(nodeFs, nodePath, nodeOs) {
    const byName = (list, key) => { const k = String(key).trim(); return list.find((x) => x.uuid === k) || list.find((x) => x.name === k) || list.find((x) => String(x.name).toLowerCase() === k.toLowerCase()) || null; };
    const api = {
      version: () => (typeof Blockbench !== "undefined" && Blockbench.version) || "?",
      project() {
        if (typeof Project === "undefined" || !Project) return null;
        return { name: Project.name || "(untitled)", format: (Project.format && Project.format.id) || (typeof Format !== "undefined" && Format && Format.id) || "?", texture_width: Project.texture_width, texture_height: Project.texture_height, cubes: Cube.all.length, meshes: typeof Mesh !== "undefined" ? Mesh.all.length : 0, groups: Group.all.length, textures: Texture.all.length, animations: typeof Animation !== "undefined" && Animation.all ? Animation.all.length : 0 };
      },
      outline(depth) {
        const node = (n, d) => {
          if (n instanceof Group) { const o = { line: "[group] " + n.name + " pivot " + JSON.stringify(n.origin.map(r3)) + (n.rotation && n.rotation.some(Boolean) ? " rot " + JSON.stringify(n.rotation.map(r3)) : "") }; if (d < depth) o.children = n.children.map((c) => node(c, d + 1)); else if (n.children.length) o.children = [{ line: "… " + n.children.length + " more" }]; return o; }
          if (n instanceof Cube) return { line: "[cube] " + n.name + " " + JSON.stringify(n.from.map(r3)) + "→" + JSON.stringify(n.to.map(r3)) + (n.inflate ? " inflate " + n.inflate : "") + (n.rotation && n.rotation.some(Boolean) ? " rot " + JSON.stringify(n.rotation.map(r3)) : "") };
          if (typeof Mesh !== "undefined" && n instanceof Mesh) return { line: "[mesh] " + n.name + " " + Object.keys(n.vertices).length + " verts / " + Object.keys(n.faces).length + " faces, origin " + JSON.stringify(n.origin.map(r3)) };
          return { line: "[" + (n.type || "node") + "] " + n.name };
        };
        return Outliner.root.map((n) => node(n, 1));
      },
      formats: () => Object.keys(Formats),
      hasFormat: (id) => !!Formats[id],
      newProject(formatId, name) { const ok = newProject(Formats[formatId]); if (ok && Project) { Project.name = name; } return !!ok; },
      meshesAllowed: () => !!(typeof Format !== "undefined" && Format && Format.meshes),
      animationsAllowed: () => !!(typeof Format !== "undefined" && Format && Format.animation_mode),
      findGroup: (key) => byName(Group.all, key),
      findCube: (key) => byName(Cube.all, key),
      findMesh: (key) => typeof Mesh !== "undefined" ? byName(Mesh.all, key) : null,
      findElement: (key) => byName(Outliner.elements, key),
      findTexture: (key) => byName(Texture.all, key),
      textures: () => Texture.all.map((t) => ({ name: t.name, uuid: t.uuid, width: t.width, height: t.height })),
      edit(label, aspects, fn) {
        const asp = Object.assign({ elements: [], outliner: false }, aspects || {});
        if (asp.elements) asp.elements = asp.elements.slice();
        Undo.initEdit(asp);
        let out;
        try { out = fn(); }
        catch (e) { try { Undo.cancelEdit(); } catch {} throw e; }
        const after = Object.assign({}, asp);
        if (Array.isArray(out)) after.elements = (asp.elements || []).concat(out.filter((x) => x && x.type !== "group" && x.uuid));
        else if (out && out.uuid && out.type !== "group" && out.type !== "animation") after.elements = (asp.elements || []).concat([out]);
        Undo.finishEdit(label, after);
        try { Canvas.updateAll(); } catch {}
        return out;
      },
      addCube(c, group, texture) {
        const data = { name: c.name, from: c.from, to: c.to, origin: c.origin || c.from, rotation: c.rotation || [0, 0, 0], inflate: c.inflate || 0, autouv: 0 };
        if (c.color !== undefined) data.color = c.color;
        const cube = new Cube(data).init();
        if (group) cube.addTo(group);
        if (texture) cube.applyTexture(texture, true);
        return cube;
      },
      extendCube(cube, patch) { cube.extend(patch); },
      describeCube: (c) => ({ name: c.name, uuid: c.uuid, from: c.from.map(r3), to: c.to.map(r3), origin: c.origin.map(r3), rotation: c.rotation.map(r3), inflate: c.inflate }),
      addGroup(data, parent) { const g = new Group({ name: data.name, origin: data.origin || [0, 0, 0], rotation: data.rotation || [0, 0, 0] }).init(); if (parent) g.addTo(parent); return g; },
      extendGroup(g, patch) { if (patch.origin) g.origin.V3_set(patch.origin[0], patch.origin[1], patch.origin[2]); if (patch.rotation) g.rotation.V3_set(patch.rotation[0], patch.rotation[1], patch.rotation[2]); },
      moveTo(node, group) { node.addTo(group); },
      removeNode(node) { if (node instanceof Group) node.remove(false); else node.remove(); },
      addMesh(data, group, texture) {
        const mesh = new Mesh({ name: data.name, vertices: {} });
        const keys = mesh.addVertices(...data.vertices.map((v) => v.slice()));
        mesh.addFaces(...data.faces.map((f) => new MeshFace(mesh, { vertices: f.map((i) => keys[i]) })));
        if (data.origin) mesh.origin.V3_set(data.origin[0], data.origin[1], data.origin[2]);
        mesh.init();
        if (group) mesh.addTo(group);
        if (texture) mesh.applyTexture(texture, true);
        return mesh;
      },
      extendMesh(mesh, patch) { if (patch.name) mesh.name = patch.name; if (patch.origin) mesh.origin.V3_set(patch.origin[0], patch.origin[1], patch.origin[2]); },
      transformMeshVertices(mesh, op, v) {
        const o = mesh.origin;
        for (const key of Object.keys(mesh.vertices)) {
          const p = mesh.vertices[key];
          if (op === "move") { p[0] += v[0]; p[1] += v[1]; p[2] += v[2]; }
          else if (op === "scale") { p[0] = o[0] + (p[0] - o[0]) * v[0]; p[1] = o[1] + (p[1] - o[1]) * v[1]; p[2] = o[2] + (p[2] - o[2]) * v[2]; }
          else if (op === "rotate") { const q = rotateXYZ([p[0] - o[0], p[1] - o[1], p[2] - o[2]], v); p[0] = o[0] + q[0]; p[1] = o[1] + q[1]; p[2] = o[2] + q[2]; }
        }
        if (op === "move") { o[0] += v[0]; o[1] += v[1]; o[2] += v[2]; }
        try { Canvas.updateView({ elements: [mesh], element_aspects: { geometry: true, transform: true, uv: true } }); } catch {}
      },
      describeMesh: (m) => ({ name: m.name, uuid: m.uuid, vertices: Object.keys(m.vertices).length, faces: Object.keys(m.faces).length, origin: m.origin.map(r3) }),
      createTexture(name, w, h, fill) {
        const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d"); ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h);
        const t = new Texture({ name }).fromDataURL(canvas.toDataURL("image/png")).add(false);
        return t;
      },
      importTexture(filePath, name) { const t = new Texture({ name: name || nodePath.basename(filePath) }).fromPath(filePath).add(false); return t; },
      applyTextureTo(t, node) {
        let n = 0;
        const apply = (el) => { if (el && typeof el.applyTexture === "function") { el.applyTexture(t, true); n++; } };
        if (!node) { Outliner.elements.forEach(apply); }
        else if (node instanceof Group) { node.forEachChild(apply, undefined, false); }
        else apply(node);
        return n;
      },
      createAnimation(data) { const an = new Animation({ name: data.name, loop: data.loop ? "loop" : "once", length: data.length, snapping: 24 }).add(false); an.select(); return an; },
      addKeyframe(an, group, channel, time, v) { const animator = an.getBoneAnimator(group); animator.addKeyframe({ channel, time, data_points: [{ x: v[0], y: v[1], z: v[2] }] }); },
      anglePresets: () => (typeof DefaultCameraPresets !== "undefined" ? DefaultCameraPresets.map((p) => p.id) : []),
      hasAnglePreset(id) { return typeof DefaultCameraPresets !== "undefined" && DefaultCameraPresets.some((p) => p.id === id); },
      loadAnglePreset(id) { const p = DefaultCameraPresets.find((x) => x.id === id); Preview.selected.loadAnglePreset(p); },
      setCamera(pos, target) { const pv = Preview.selected; if (pos) pv.camera.position.set(pos[0], pos[1], pos[2]); if (target) pv.controls.target.set(target[0], target[1], target[2]); pv.controls.update(); },
      focusCamera(node) { let c = null; if (typeof node.getWorldCenter === "function") c = node.getWorldCenter(); else if (node.origin) c = { x: node.origin[0], y: node.origin[1], z: node.origin[2] }; if (c) { Preview.selected.controls.target.set(c.x, c.y, c.z); Preview.selected.controls.update(); } },
      screenshot(max) {
        return new Promise((resolve, reject) => {
          try {
            Preview.selected.screenshot({ crop: false }, (dataUrl) => {
              if (!dataUrl) return resolve("");
              const img = new Image();
              img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)); if (s >= 1) return resolve(dataUrl); const cv = document.createElement("canvas"); cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s); cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); resolve(cv.toDataURL("image/png")); };
              img.onerror = () => resolve(dataUrl);
              img.src = dataUrl;
            });
          } catch (e) { reject(e); }
        });
      },
      defaultExportDir: () => nodePath.join(nodeOs.homedir(), "Documents", "TotalScript", "blockbench_exports"),
      ensureDir: (d) => nodeFs.mkdirSync(d, { recursive: true }),
      joinPath: (a, b) => nodePath.join(a, b),
      baseName: (p) => nodePath.basename(p),
      fileExists: (p) => { try { return nodeFs.existsSync(p); } catch { return false; } },
      writeText: (p, s) => nodeFs.writeFileSync(p, String(s == null ? "" : s), "utf8"),
      writeBase64: (p, b64) => nodeFs.writeFileSync(p, Buffer.from(b64, "base64")),
      writeBuffer: (p, buf) => nodeFs.writeFileSync(p, Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf)),
      async compileObj() {
        const out = await Codecs.obj.compile({});
        if (typeof out === "string") return { obj: out, mtl: "", images: [] };
        const images = [];
        const imgs = out.images || {};
        for (const key of Object.keys(imgs)) {
          const t = imgs[key];
          let b64 = "";
          try { b64 = typeof t === "string" ? t.replace(/^data:image\/\w+;base64,/, "") : (typeof t.getBase64 === "function" ? t.getBase64() : String(t.getDataURL()).replace(/^data:image\/\w+;base64,/, "")); } catch {}
          if (b64) images.push({ name: /\.png$/i.test(key) ? key : key + ".png", base64: b64 });
        }
        return { obj: out.obj || "", mtl: out.mtl || "", images };
      },
      async compileGltf(encoding) { return Codecs.gltf.compile({ encoding, animations: true }); },
      compileProject: () => Codecs.project.compile({ compressed: false }),
      undo() { if (Undo.index <= 0) return false; Undo.undo(); return true; },
      redo() { if (Undo.index >= Undo.history.length) return false; Undo.redo(); return true; },
    };
    return api;
  }
  function rotateXYZ(p, deg) {
    const [ax, ay, az] = deg.map((d) => (d * Math.PI) / 180);
    let [x, y, z] = p;
    let c = Math.cos(ax), s = Math.sin(ax); let y1 = y * c - z * s, z1 = y * s + z * c; y = y1; z = z1;
    c = Math.cos(ay); s = Math.sin(ay); let x1 = x * c + z * s; z1 = -x * s + z * c; x = x1; z = z1;
    c = Math.cos(az); s = Math.sin(az); x1 = x * c - y * s; y1 = x * s + y * c; x = x1; y = y1;
    return [r3(x), r3(y), r3(z)];
  }

  // ── bridge loop (hello / poll / result over Node http) ─────────────────────
  // createBridge({request, api, url, log, onState}) → {start, stop, state()}.
  // `request(method, path, body, timeoutMs)` → Promise<{status, json}>; the
  // plugin passes a Node-http implementation, the test passes a fetch to its
  // fake total-core.
  function createBridge(opts) {
    const request = opts.request, api = opts.api, log = opts.log || (() => {}), onState = opts.onState || (() => {});
    let url = String(opts.url || DEFAULT_BRIDGE).replace(/\/+$/, "");
    const clientId = "bb-" + Math.random().toString(36).slice(2, 10);
    let running = false, connected = false, helloTimer = null, pollAbort = null, backoff = 2000, jobsDone = 0, lastError = "";
    const setConnected = (on, err) => { const was = connected; connected = on; lastError = on ? "" : String(err || ""); if (was !== on) { log(on ? "connected to total-core at " + url : "total-core not reachable (" + lastError + ")"); onState(state()); } };
    function state() { return { connected, url, clientId, jobsDone, lastError, running }; }
    async function hello() {
      const p = api.project();
      try {
        const r = await request("POST", url + "/api/blockbench/hello", { client_id: clientId, version: VERSION, blockbench_version: api.version(), project: p ? p.name : "", format: p ? p.format : "", capabilities: CAPABILITIES }, 8000);
        if (r.status === 200 && r.json && r.json.ok) { setConnected(true); backoff = 2000; return true; }
        setConnected(false, "hello answered HTTP " + r.status);
      } catch (e) { setConnected(false, (e && e.message) || String(e)); }
      return false;
    }
    async function runOne(job) {
      const started = Date.now();
      let body;
      try {
        const result = await runJob(job.name, job.args, api);
        body = { id: job.id, ok: true, result, elapsed_ms: Date.now() - started };
      } catch (e) {
        body = { id: job.id, ok: false, result: null, error: String((e && e.message) || e), code: (e && e.code) || "EXECUTION", elapsed_ms: Date.now() - started };
      }
      jobsDone++;
      try { await request("POST", url + "/api/blockbench/result", body, 8000); } catch (e) { log("result delivery failed: " + ((e && e.message) || e)); }
      onState(state());
    }
    async function loop() {
      while (running) {
        if (!connected) {
          const ok = await hello();
          if (!ok) { await sleep(backoff); backoff = Math.min(15000, Math.round(backoff * 1.5)); continue; }
        }
        try {
          const r = await request("GET", url + "/api/blockbench/poll?client_id=" + encodeURIComponent(clientId), null, POLL_TIMEOUT_MS);
          if (r.status !== 200 || !r.json || !r.json.ok) { setConnected(false, "poll answered HTTP " + r.status); continue; }
          if (r.json.job) await runOne(r.json.job);
        } catch (e) { setConnected(false, (e && e.message) || String(e)); await sleep(backoff); }
      }
    }
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    return {
      start() { if (running) return; running = true; helloTimer = setInterval(() => { if (connected) hello(); }, HELLO_EVERY_MS); loop(); onState(state()); },
      stop() { running = false; clearInterval(helloTimer); helloTimer = null; setConnected(false, "stopped"); onState(state()); },
      setUrl(u) { url = String(u || DEFAULT_BRIDGE).replace(/\/+$/, ""); setConnected(false, "url changed"); },
      state, hello,
    };
  }

  function nodeRequest(http) {
    return (method, urlStr, body, timeoutMs) => new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const data = body == null ? null : JSON.stringify(body);
      const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: Object.assign({ "accept": "application/json" }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
      });
      req.setTimeout(timeoutMs || 10000, () => { req.destroy(new Error("timeout after " + timeoutMs + " ms")); });
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  const core = { VERSION, PLUGIN_ID, DEFAULT_BRIDGE, CAPABILITIES, PRIMITIVES, JOBS, runJob, primitiveGeometry, faceNormal, validateMeshData, createBridge, nodeRequest, makeBlockbenchApi, rotateXYZ };
  // node (tests) only - inside Blockbench the Electron renderer also has a
  // `module`, which must stay untouched.
  if (typeof BBPlugin === "undefined" && typeof module !== "undefined" && module.exports) module.exports = core;

  // ── Blockbench registration ────────────────────────────────────────────────
  if (typeof BBPlugin !== "undefined" && typeof Plugin !== "undefined") {
    let bridge = null, setting = null, actionStatus = null, actionToggle = null, nodeMods = null;
    const log = (m) => { try { console.log("[TotalScript] " + m); } catch {} };
    BBPlugin.register(PLUGIN_ID, {
      title: "TotalScript Bridge",
      author: "TotalScript",
      icon: "hub",
      description: "Lets the TotalScript desktop app (and the browser extension through it) model in Blockbench: cubes, groups, meshes, textures, animations, screenshots and OBJ / glTF exports for Roblox Studio.",
      about: "Dials out to total-core on http://127.0.0.1:3000 (no port is opened in Blockbench). Start the TotalScript desktop app, then ask the AI in Blockbench work mode. Tools → TotalScript shows the link state.",
      version: VERSION,
      variant: "desktop",
      min_version: "4.8.0",
      tags: ["Roblox", "TotalScript", "Bridge"],
      onload() {
        if (typeof isApp === "undefined" || !isApp || typeof require !== "function") { Blockbench.showMessageBox({ title: "TotalScript Bridge", message: "This plugin needs the Blockbench desktop app (it uses Node's http module)." }); return; }
        nodeMods = { http: require("http"), fs: require("fs"), path: require("path"), os: require("os") };
        const api = makeBlockbenchApi(nodeMods.fs, nodeMods.path, nodeMods.os);
        setting = new Setting("totalscript_bridge_url", { name: "TotalScript bridge URL", description: "Where the TotalScript desktop app listens (default http://127.0.0.1:3000).", category: "general", type: "text", value: DEFAULT_BRIDGE, onChange(v) { if (bridge) bridge.setUrl(v); } });
        bridge = createBridge({ request: nodeRequest(nodeMods.http), api, url: (settings.totalscript_bridge_url && settings.totalscript_bridge_url.value) || DEFAULT_BRIDGE, log, onState(s) { if (actionStatus) actionStatus.name = "TotalScript: " + (s.connected ? "connected · " + s.jobsDone + " job(s)" : (s.running ? "waiting for the desktop app…" : "off")); } });
        actionStatus = new Action("totalscript_bridge_status", { name: "TotalScript: waiting for the desktop app…", description: "Link state between Blockbench and the TotalScript desktop app", icon: "hub", category: "tools", click() { const s = bridge.state(); Blockbench.showMessageBox({ title: "TotalScript Bridge " + VERSION, message: (s.connected ? "Connected to " + s.url + " (" + s.jobsDone + " job(s) run this session)." : "Not connected to " + s.url + (s.lastError ? " - " + s.lastError : "") + ". Start the TotalScript desktop app (total-core); the link comes up by itself.") + "\n\nCommands the AI can run here: " + CAPABILITIES.join(", ") + "." }); } });
        actionToggle = new Action("totalscript_bridge_toggle", { name: "TotalScript: pause / resume the link", description: "Stop accepting commands from the TotalScript app (resume any time)", icon: "pause_circle", category: "tools", click() { const s = bridge.state(); if (s.running) { bridge.stop(); Blockbench.showQuickMessage("TotalScript link paused", 2000); } else { bridge.start(); Blockbench.showQuickMessage("TotalScript link resumed", 2000); } } });
        MenuBar.addAction(actionStatus, "tools");
        MenuBar.addAction(actionToggle, "tools");
        bridge.start();
        log("TotalScript Bridge " + VERSION + " loaded");
      },
      onunload() {
        try { if (bridge) bridge.stop(); } catch {}
        try { if (actionStatus) actionStatus.delete(); } catch {}
        try { if (actionToggle) actionToggle.delete(); } catch {}
        try { if (setting) setting.delete(); } catch {}
        bridge = null;
      },
    });
  }
})();
