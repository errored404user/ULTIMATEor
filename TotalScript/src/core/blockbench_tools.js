// SPDX-License-Identifier: GPL-3.0-or-later
// src/core/blockbench_tools.js - 2.21.0 Blockbench command table (pure JS).
//
// Blockbench is driven by OUR plugin (plugin/TotalScript-Blockbench.js) which
// runs inside the Blockbench desktop app and long-polls total-core for jobs -
// the same shape as the Studio plugin. The extension therefore never talks to
// Blockbench itself: bb_* calls travel down the normal Roblox channel
// (ws 17613 → total-core → plugin). This file is what the extension needs
// locally: the curated command names + argument checks (so a wrong call is
// refused before it crosses the bridge), the tool list for the catalogue and
// the connect steps shown in the popup / settings card. The plugin re-validates
// everything with the real Blockbench API; total-core serves the same names
// (agent/src/blockbench.rs - tests pin the three tables against each other).
//
// Loaded by: background.js (importScripts; the page and the popup receive the
// list through the worker) and tests/test-blockbench-*.js (node require).
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TotalBlockbench = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = "2.21.0";
  const PLUGIN_FILE = "TotalScript-Blockbench.js";
  const EXPORT_DIR = "blockbench_exports";
  const PRIMITIVES = Object.freeze(["cylinder", "cone", "pyramid", "plane", "sphere", "torus"]);
  const VIEWS = Object.freeze(["front", "back", "left", "right", "top", "bottom", "isometric_right", "isometric_left"]);
  const FORMATS = Object.freeze(["obj", "gltf", "glb", "bbmodel"]);
  const TEXTURE_ACTIONS = Object.freeze(["list", "create", "import", "apply"]);

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  const fail = (cmd, why) => ({ ok: false, error: "ERROR INVALID_ARGUMENT in " + cmd + ": " + why });
  const okay = () => ({ ok: true });

  // name → { description, inputSchema, validate(args) → {ok} | {ok:false,error} }
  // Descriptions mirror agent/src/blockbench.rs (the AI sees whichever side
  // listed the tool; both say the same thing).
  const COMMANDS = {
    bb_status: {
      description: "Blockbench: read the open project (format, name, texture size, cube / mesh / group / texture / animation counts) and the outliner tree. Run it FIRST and after every build pass. Also the quickest way to see whether Blockbench is connected.",
      inputSchema: { type: "object", properties: { max_depth: { type: "integer", description: "Outliner depth to list (1-32, default 4)." } } },
      validate(a) { if (a && a.max_depth !== undefined && !isNum(a.max_depth)) return fail("bb_status", "max_depth must be a number"); return okay(); },
    },
    bb_project: {
      description: "Blockbench: create a new project. format = Blockbench format id (free = unconstrained cubes + meshes, best for OBJ / glTF export to Roblox).",
      inputSchema: { type: "object", properties: { name: { type: "string" }, format: { type: "string", description: "Format id, default 'free'." } }, required: ["name"] },
      validate(a) { if (!str(a && a.name)) return fail("bb_project", "name (string) is required"); return okay(); },
    },
    bb_cubes: {
      description: "Blockbench: place 1-200 cubes in one undoable edit. cubes = [{name, from:[x,y,z], to:[x,y,z], origin?, rotation?, inflate?, color?}] in Blockbench units (16 = one block); group? = parent group; texture? = texture to apply.",
      inputSchema: { type: "object", properties: {
        cubes: { type: "array", description: "1-200 cubes: {name, from:[x,y,z], to:[x,y,z], origin?:[x,y,z], rotation?:[x,y,z] degrees, inflate?:number, color?:0-7}" },
        group: { type: "string", description: "Parent group name (default root)." },
        texture: { type: "string", description: "Texture name to apply to every face." },
      }, required: ["cubes"] },
      validate(a) {
        const cubes = a && Array.isArray(a.cubes) ? a.cubes : (a && a.cube && typeof a.cube === "object" ? [a.cube] : null);
        if (!cubes || !cubes.length) return fail("bb_cubes", "cubes (non-empty array) is required");
        if (cubes.length > 200) return fail("bb_cubes", "at most 200 cubes per call");
        for (let i = 0; i < cubes.length; i++) {
          const c = cubes[i] || {};
          if (!str(c.name)) return fail("bb_cubes", "cubes[" + i + "].name is required");
          if (!vec3(c.from) || !vec3(c.to)) return fail("bb_cubes", "cubes[" + i + "] needs from and to as [x,y,z] numbers");
          for (let ax = 0; ax < 3; ax++) if (c.from[ax] > c.to[ax]) return fail("bb_cubes", "cubes[" + i + "] ('" + c.name + "'): from must be <= to on every axis (axis " + "xyz"[ax] + ": " + c.from[ax] + " > " + c.to[ax] + ")");
          if (c.origin !== undefined && !vec3(c.origin)) return fail("bb_cubes", "cubes[" + i + "].origin must be [x,y,z]");
          if (c.rotation !== undefined && !vec3(c.rotation)) return fail("bb_cubes", "cubes[" + i + "].rotation must be [x,y,z] degrees");
          if (c.inflate !== undefined && !isNum(c.inflate)) return fail("bb_cubes", "cubes[" + i + "].inflate must be a number");
        }
        return okay();
      },
    },
    bb_cube_edit: {
      description: "Blockbench: change one cube by name: from, to, origin, rotation, inflate, rename, color, visible, group.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, from: { type: "array" }, to: { type: "array" }, origin: { type: "array" }, rotation: { type: "array" }, inflate: { type: "number" }, rename: { type: "string" }, color: { type: "integer" }, visible: { type: "boolean" }, group: { type: "string" } }, required: ["name"] },
      validate(a) {
        if (!str(a && a.name)) return fail("bb_cube_edit", "name (string) is required");
        for (const k of ["from", "to", "origin", "rotation"]) if (a[k] !== undefined && !vec3(a[k])) return fail("bb_cube_edit", k + " must be [x,y,z]");
        if (!["from", "to", "origin", "rotation", "inflate", "rename", "color", "visible", "group"].some((k) => a[k] !== undefined)) return fail("bb_cube_edit", "nothing to change (from/to/origin/rotation/inflate/rename/color/visible/group)");
        return okay();
      },
    },
    bb_group: {
      description: "Blockbench: create (or update) a group = bone. origin = pivot [x,y,z]; parent? = parent group; move? = names of cubes / meshes / groups to move inside.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, parent: { type: "string" }, origin: { type: "array" }, rotation: { type: "array" }, move: { type: "array" } }, required: ["name"] },
      validate(a) {
        if (!str(a && a.name)) return fail("bb_group", "name (string) is required");
        if (a.origin !== undefined && !vec3(a.origin)) return fail("bb_group", "origin must be [x,y,z]");
        if (a.rotation !== undefined && !vec3(a.rotation)) return fail("bb_group", "rotation must be [x,y,z]");
        if (a.move !== undefined && !Array.isArray(a.move)) return fail("bb_group", "move must be an array of names");
        return okay();
      },
    },
    bb_remove: {
      description: "Blockbench: delete cubes, meshes or groups by name (one undo step).",
      inputSchema: { type: "object", properties: { names: { type: "array" } }, required: ["names"] },
      validate(a) {
        const names = a && Array.isArray(a.names) ? a.names : (str(a && a.name) ? [a.name] : null);
        if (!names || !names.length) return fail("bb_remove", "names (non-empty array) is required");
        return okay();
      },
    },
    bb_mesh: {
      description: "Blockbench: create a free-form mesh from vertices [[x,y,z]…] and faces [[i,j,k(,l)]…] (3 or 4 indices each, counter-clockwise seen from outside). group?, origin?, texture?.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, vertices: { type: "array" }, faces: { type: "array" }, group: { type: "string" }, origin: { type: "array" }, texture: { type: "string" } }, required: ["name", "vertices", "faces"] },
      validate(a) {
        if (!str(a && a.name)) return fail("bb_mesh", "name (string) is required");
        if (!Array.isArray(a.vertices) || a.vertices.length < 3) return fail("bb_mesh", "vertices must list at least 3 [x,y,z] points");
        if (a.vertices.length > 4000) return fail("bb_mesh", "at most 4000 vertices per mesh");
        for (let i = 0; i < a.vertices.length; i++) if (!vec3(a.vertices[i])) return fail("bb_mesh", "vertices[" + i + "] must be [x,y,z]");
        if (!Array.isArray(a.faces) || !a.faces.length) return fail("bb_mesh", "faces must list at least one face");
        if (a.faces.length > 8000) return fail("bb_mesh", "at most 8000 faces per mesh");
        for (let i = 0; i < a.faces.length; i++) {
          const f = a.faces[i];
          if (!Array.isArray(f) || f.length < 3 || f.length > 4) return fail("bb_mesh", "faces[" + i + "] must list 3 or 4 vertex indices (Blockbench faces are tris or quads)");
          for (const ix of f) if (!Number.isInteger(ix) || ix < 0 || ix >= a.vertices.length) return fail("bb_mesh", "faces[" + i + "] has an index outside 0.." + (a.vertices.length - 1));
          if (new Set(f).size !== f.length) return fail("bb_mesh", "faces[" + i + "] repeats a vertex");
        }
        if (a.origin !== undefined && !vec3(a.origin)) return fail("bb_mesh", "origin must be [x,y,z]");
        return okay();
      },
    },
    bb_mesh_primitive: {
      description: "Blockbench: build a mesh primitive: shape = cylinder | cone | pyramid | plane | sphere | torus; diameter, height, sides (3-64), tube (torus), position = base centre [x,y,z]; group?, texture?.",
      inputSchema: { type: "object", properties: { shape: { type: "string" }, name: { type: "string" }, diameter: { type: "number" }, height: { type: "number" }, sides: { type: "integer" }, tube: { type: "number" }, position: { type: "array" }, group: { type: "string" }, texture: { type: "string" } }, required: ["shape", "name"] },
      validate(a) {
        const shape = String((a && a.shape) || "").toLowerCase();
        if (!PRIMITIVES.includes(shape)) return fail("bb_mesh_primitive", "shape must be one of " + PRIMITIVES.join(", "));
        if (!str(a.name)) return fail("bb_mesh_primitive", "name (string) is required");
        for (const k of ["diameter", "height", "sides", "tube"]) if (a[k] !== undefined && !(isNum(a[k]) && a[k] > 0)) return fail("bb_mesh_primitive", k + " must be a positive number");
        if (a.position !== undefined && !vec3(a.position)) return fail("bb_mesh_primitive", "position must be [x,y,z]");
        return okay();
      },
    },
    bb_mesh_edit: {
      description: "Blockbench: transform a mesh by name: move [dx,dy,dz], scale (number or [sx,sy,sz]), rotate [x,y,z] degrees around its origin, rename, origin, group.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, move: { type: "array" }, scale: {}, rotate: { type: "array" }, rename: { type: "string" }, origin: { type: "array" }, group: { type: "string" } }, required: ["name"] },
      validate(a) {
        if (!str(a && a.name)) return fail("bb_mesh_edit", "name (string) is required");
        for (const k of ["move", "rotate", "origin"]) if (a[k] !== undefined && !vec3(a[k])) return fail("bb_mesh_edit", k + " must be [x,y,z]");
        if (a.scale !== undefined && !(isNum(a.scale) || vec3(a.scale))) return fail("bb_mesh_edit", "scale must be a number or [sx,sy,sz]");
        if (a.scale !== undefined && (isNum(a.scale) ? [a.scale] : a.scale).some((v) => v <= 0)) return fail("bb_mesh_edit", "scale factors must be > 0");
        if (!["move", "scale", "rotate", "rename", "origin", "group"].some((k) => a[k] !== undefined)) return fail("bb_mesh_edit", "nothing to change (move/scale/rotate/rename/origin/group)");
        return okay();
      },
    },
    bb_texture: {
      description: "Blockbench: action=list | create {name, width, height, fill_color '#rrggbb', apply_to?} | import {path, name?, apply_to?} | apply {texture, targets:[cube / mesh / group names] or 'all'}.",
      inputSchema: { type: "object", properties: { action: { type: "string" }, name: { type: "string" }, width: { type: "integer" }, height: { type: "integer" }, fill_color: { type: "string" }, path: { type: "string" }, texture: { type: "string" }, targets: { type: "array" }, apply_to: { type: "array" } }, required: ["action"] },
      validate(a) {
        const action = String((a && a.action) || "").toLowerCase();
        if (!TEXTURE_ACTIONS.includes(action)) return fail("bb_texture", "action must be one of " + TEXTURE_ACTIONS.join(", "));
        if (action === "create") {
          if (!str(a.name)) return fail("bb_texture", "create needs name");
          for (const k of ["width", "height"]) if (a[k] !== undefined && !(isNum(a[k]) && a[k] >= 1 && a[k] <= 1024)) return fail("bb_texture", k + " must be 1-1024");
          if (a.fill_color !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(String(a.fill_color))) return fail("bb_texture", "fill_color must be #rrggbb");
        }
        if (action === "import" && !str(a.path)) return fail("bb_texture", "import needs path (a PNG on this computer)");
        if (action === "apply") {
          if (!str(a.texture)) return fail("bb_texture", "apply needs texture (name)");
          if (!(a.targets === "all" || (Array.isArray(a.targets) && a.targets.length))) return fail("bb_texture", "apply needs targets (array of names) or 'all'");
        }
        return okay();
      },
    },
    bb_animate: {
      description: "Blockbench: create an animation on GROUPS (bones): bones = {GroupName: [{time, rotation?:[x,y,z], position?:[x,y,z], scale?:[x,y,z]}]}, length seconds, loop (default true).",
      inputSchema: { type: "object", properties: { name: { type: "string" }, length: { type: "number" }, loop: { type: "boolean" }, bones: { type: "object" } }, required: ["name", "bones"] },
      validate(a) {
        if (!str(a && a.name)) return fail("bb_animate", "name (string) is required");
        if (!a.bones || typeof a.bones !== "object" || Array.isArray(a.bones) || !Object.keys(a.bones).length) return fail("bb_animate", "bones must be {GroupName: [keyframes]} with at least one group");
        for (const [bone, frames] of Object.entries(a.bones)) {
          if (!Array.isArray(frames) || !frames.length) return fail("bb_animate", "bones." + bone + " must list keyframes");
          for (let i = 0; i < frames.length; i++) {
            const k = frames[i] || {};
            if (!isNum(k.time) || k.time < 0) return fail("bb_animate", "bones." + bone + "[" + i + "].time must be a number >= 0");
            for (const ch of ["rotation", "position", "scale"]) if (k[ch] !== undefined && !vec3(k[ch])) return fail("bb_animate", "bones." + bone + "[" + i + "]." + ch + " must be [x,y,z]");
            if (!["rotation", "position", "scale"].some((ch) => k[ch] !== undefined)) return fail("bb_animate", "bones." + bone + "[" + i + "] needs rotation, position or scale");
          }
        }
        if (a.length !== undefined && !(isNum(a.length) && a.length > 0)) return fail("bb_animate", "length must be a positive number of seconds");
        return okay();
      },
    },
    bb_camera: {
      description: "Blockbench: frame the viewport: view = front | back | left | right | top | bottom | isometric_right | isometric_left, or position + target [x,y,z], or focus = element / group name.",
      inputSchema: { type: "object", properties: { view: { type: "string" }, position: { type: "array" }, target: { type: "array" }, focus: { type: "string" } } },
      validate(a) {
        a = a || {};
        if (a.view !== undefined && !VIEWS.includes(String(a.view).toLowerCase())) return fail("bb_camera", "view must be one of " + VIEWS.join(", "));
        if (a.position !== undefined && !vec3(a.position)) return fail("bb_camera", "position must be [x,y,z]");
        if (a.target !== undefined && !vec3(a.target)) return fail("bb_camera", "target must be [x,y,z]");
        if (a.view === undefined && a.position === undefined && a.focus === undefined) return fail("bb_camera", "give view, position (+target) or focus");
        return okay();
      },
    },
    bb_screenshot: {
      description: "Blockbench: capture the 3D viewport as a PNG you can see (max_size 128-2048, default 1024; view? = camera preset first). Do it after EVERY build pass.",
      inputSchema: { type: "object", properties: { max_size: { type: "integer" }, view: { type: "string" } } },
      validate(a) {
        a = a || {};
        if (a.max_size !== undefined && !isNum(a.max_size)) return fail("bb_screenshot", "max_size must be a number");
        if (a.view !== undefined && !VIEWS.includes(String(a.view).toLowerCase())) return fail("bb_screenshot", "view must be one of " + VIEWS.join(", "));
        return okay();
      },
    },
    bb_export: {
      description: "Blockbench: write the model to a FILE for Roblox Studio's Import 3D: format = obj (+ mtl + textures) | gltf | glb | bbmodel (editable project, not importable); name?; overwrite? (default: a -2 suffix). Files land in <workspace>/blockbench_exports (or ~/Documents/TotalScript/blockbench_exports). Nothing is uploaded or inserted.",
      inputSchema: { type: "object", properties: { format: { type: "string" }, name: { type: "string" }, overwrite: { type: "boolean" } }, required: ["format"] },
      validate(a) {
        const f = String((a && a.format) || "").toLowerCase();
        if (!FORMATS.includes(f)) return fail("bb_export", "format must be one of " + FORMATS.join(", "));
        if (a.name !== undefined && !str(a.name)) return fail("bb_export", "name must be a non-empty string");
        return okay();
      },
    },
    bb_undo: {
      description: "Blockbench: undo the last N edits (1-20).",
      inputSchema: { type: "object", properties: { steps: { type: "integer" } } },
      validate(a) { if (a && a.steps !== undefined && !(isNum(a.steps) && a.steps >= 1)) return fail("bb_undo", "steps must be a number >= 1 (max 20)"); return okay(); },
    },
    bb_redo: {
      description: "Blockbench: redo N edits (1-20).",
      inputSchema: { type: "object", properties: { steps: { type: "integer" } } },
      validate(a) { if (a && a.steps !== undefined && !(isNum(a.steps) && a.steps >= 1)) return fail("bb_redo", "steps must be a number >= 1 (max 20)"); return okay(); },
    },
    bb_tools: {
      description: "Blockbench: list what the TotalScript Blockbench plugin can do (commands, formats, camera views, mesh primitives).",
      inputSchema: { type: "object", properties: {} },
      validate() { return okay(); },
    },
  };

  const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));
  const bareName = (name) => String(name || "").split("/").pop();
  const isCommand = (name) => Object.prototype.hasOwnProperty.call(COMMANDS, bareName(name));

  function toolList() {
    return COMMAND_NAMES.map((name) => ({ name, description: COMMANDS[name].description, inputSchema: COMMANDS[name].inputSchema, server: "blockbench" }));
  }

  // Local pre-flight: catches malformed calls before they cross the bridge.
  // Returns { ok:true, name:<bare> } or { ok:false, error:"ERROR …" }.
  function validate(name, args) {
    const bare = bareName(name);
    const cmd = COMMANDS[bare];
    if (!cmd) return { ok: false, error: "ERROR UNKNOWN_COMMAND: " + bare + " is not a Blockbench command. Commands: " + COMMAND_NAMES.join(", ") };
    const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const r = cmd.validate(a);
    return r.ok ? { ok: true, name: bare } : r;
  }

  // Human steps for the popup / settings card / offline error.
  function connectSteps(pluginPath) {
    const where = pluginPath ? String(pluginPath) : PLUGIN_FILE + " (next to total-core, or plugin/ inside the extension folder)";
    return [
      "Start the TotalScript desktop app (total-core) - it keeps the plugin file up to date: " + where,
      "In Blockbench (desktop, 4.8 or newer): File → Plugins → Load Plugin from File → pick " + PLUGIN_FILE + ". Blockbench remembers it and loads it on every start.",
      "Tools → TotalScript: Bridge status shows 'connected' once the plugin reaches total-core (it dials http://127.0.0.1:3000 by itself; nothing to configure).",
      "Switch the TotalScript bar to the Blockbench work mode and ask for a model. Exports (bb_export obj / gltf) are files - import them with Roblox Studio → Import 3D.",
    ];
  }

  function offlineMessage(pluginPath) {
    return "ERROR BLOCKBENCH_OFFLINE: Blockbench is not connected to total-core. " + connectSteps(pluginPath).map((s, i) => (i + 1) + ") " + s).join(" ");
  }

  return Object.freeze({
    VERSION, PLUGIN_FILE, EXPORT_DIR, PRIMITIVES, VIEWS, FORMATS, TEXTURE_ACTIONS,
    COMMANDS, COMMAND_NAMES, isCommand, toolList, validate, connectSteps, offlineMessage,
  });
});
