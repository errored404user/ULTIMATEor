// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript command contract (1.89.0) - ONE pre-execution validation layer for
// the virtual Studio / agent commands, built on the metadata the packs already
// declare (SKILL_COMMANDS[].params = {type, req, desc}) instead of a second
// registry. It resolves aliases, repairs only deterministic mistakes, rejects
// invalid calls BEFORE Luau is built, classifies execution failures and tells
// the loop guard which failures can never change without a changed call.
//
//   prepare(name, args)      -> { ok, args, corrections, warnings, problems, contract, message }
//   classify(name, text)     -> { category, code, retryable, deterministic, uncertain, next }
//   annotate(name, text, p)  -> text + "[diagnosis] ..." line for ERROR results
//   signature(name, args)    -> normalized signature for repeat detection
//   schemaLine(name)         -> compact callable signature for error messages
const TotalCommandContract = (() => {
  "use strict";
  const VERSION = "1.89.0";

  // ── authoritative Roblox enum lists (Enum.<Key>.<Item>; a wrong item is a Luau error or a silently swallowed pcall) ──
  const ROBLOX_ENUMS = {
    Material: ["Plastic", "Wood", "Slate", "Concrete", "CorrodedMetal", "DiamondPlate", "Foil", "Grass", "Ice", "Marble", "Granite", "Brick", "Pebble", "Sand", "Fabric", "SmoothPlastic", "Metal", "WoodPlanks", "Cobblestone", "Air", "Water", "Rock", "Glacier", "Snow", "Sandstone", "Mud", "Basalt", "Ground", "CrackedLava", "Neon", "Glass", "Asphalt", "LeafyGrass", "Salt", "Limestone", "Pavement", "ForceField", "Cardboard", "Carpet", "CeramicTiles", "ClayRoofTiles", "RoofShingles", "Leather", "Plaster", "Rubber"],
    TerrainMaterial: ["Grass", "Rock", "Sand", "Water", "Snow", "Basalt", "Lava", "Mud", "Ice", "Salt", "LeafyGrass", "Sandstone", "Ground", "Slate", "Concrete", "Brick", "Cobblestone", "WoodPlanks", "Glacier", "Asphalt", "Limestone", "Pavement", "CrackedLava", "Air"],
    PartType: ["Ball", "Block", "Cylinder", "Wedge", "CornerWedge"],
    EasingStyle: ["Linear", "Sine", "Back", "Quad", "Quart", "Quint", "Bounce", "Elastic", "Exponential", "Circular", "Cubic"],
    EasingDirection: ["In", "Out", "InOut"],
    NormalId: ["Top", "Bottom", "Back", "Front", "Right", "Left"],
    Technology: ["Legacy", "Voxel", "Compatibility", "ShadowMap", "Future", "Unified"],
    Font: ["Legacy", "Arial", "ArialBold", "SourceSans", "SourceSansBold", "SourceSansSemibold", "SourceSansLight", "SourceSansItalic", "Bodoni", "Garamond", "Cartoon", "Code", "Highway", "SciFi", "Arcade", "Fantasy", "Antique", "Gotham", "GothamMedium", "GothamBold", "GothamBlack", "AmaticSC", "Bangers", "Creepster", "DenkOne", "Fondamento", "FredokaOne", "GrenzeGotisch", "IndieFlower", "JosefinSans", "Jura", "Kalam", "LuckiestGuy", "Merriweather", "Michroma", "Nunito", "Oswald", "PatrickHand", "PermanentMarker", "Roboto", "RobotoCondensed", "RobotoMono", "Sarpanch", "SpecialElite", "TitilliumWeb", "Ubuntu", "BuilderSans", "BuilderSansMedium", "BuilderSansBold", "BuilderSansExtraBold"],
    TextXAlignment: ["Left", "Center", "Right"],
    TextYAlignment: ["Top", "Center", "Bottom"],
    HorizontalAlignment: ["Center", "Left", "Right"],
    VerticalAlignment: ["Center", "Top", "Bottom"],
    SortOrder: ["Name", "Custom", "LayoutOrder"],
    FillDirection: ["Horizontal", "Vertical"],
    ScaleType: ["Stretch", "Slice", "Tile", "Fit", "Crop"],
    AutomaticSize: ["None", "X", "Y", "XY"],
    CameraType: ["Fixed", "Attach", "Watch", "Track", "Follow", "Custom", "Scriptable", "Orbital"],
    SurfaceType: ["Smooth", "Glue", "Weld", "Studs", "Inlet", "Universal", "Hinge", "Motor", "SteppingMotor", "SmoothNoOutlines"],
    HumanoidRigType: ["R6", "R15"],
    DataModel: ["Edit", "Server", "Client"],
  };
  // Legacy enum spellings Roblox still accepts or that the packs map themselves - exact, not fuzzy.
  const ENUM_ALIASES = {
    Font: { SourceSansSemiBold: "SourceSansSemibold", GothamSemibold: "GothamMedium", Gotham_Bold: "GothamBold" },
    Material: { Steel: null, Iron: null, Stone: null, Gold: null, Dirt: null },
  };
  // parameter name -> enum key. Only names whose meaning is the SAME in every pack
  // (verified by tests/test-command-contract.js against the handler sources).
  const ENUM_PARAMS = {
    material: (cmd) => (/^terrain_/.test(cmd) ? "TerrainMaterial" : "Material"),
    easing_style: "EasingStyle",
    easing: "EasingStyle",
    easing_direction: "EasingDirection",
    face: "NormalId",
    font: "Font",
    technology: "Technology",
    x_align: "TextXAlignment",
    y_align: "TextYAlignment",
    h_align: "HorizontalAlignment",
    v_align: "VerticalAlignment",
    sort: "SortOrder",
    scale_type: "ScaleType",
    rig_type: "HumanoidRigType",
    datamodel_type: "DataModel",
  };
  // Commands whose parameter of that name is NOT the enum (same word, other meaning).
  const ENUM_PARAM_EXCEPT = { face: /^(gfx_|thumbnail_|face_|anim)/, sort: /^(script_|project_|search_)/ };
  // Per-command overrides where a generic word IS an enum for that handler only.
  const ENUM_PARAM_COMMAND = { "tween_create.direction": "EasingDirection", "camera_dolly.style": "EasingStyle", "camera_dolly.direction": "EasingDirection" };

  // Canonical parameter aliases. alias -> canonical. Applied only when the
  // command declares the canonical name and NOT the alias (otherwise both mean
  // something to that handler and nothing is renamed).
  const PARAM_ALIASES = {
    target_path: "path", instance_path: "path", object_path: "path", instance: "path",
    parent_path: "parent", dest: "parent", destination: "parent",
    pos: "position", colour: "color", orientation: "rotation", q: "query", endpoint: "url",
    lua: "code", script: "code", content: "text", msg: "message",
  };
  // ... and the reverse direction when a pack declares the long form.
  const PARAM_ALIASES_REVERSE = { parent: "parent_path", path: "target_path" };
  // Per-command aliases the handler documents itself (alias -> canonical).
  const COMMAND_ALIASES = { terrain_fill_region: { position: "cframe", center: "cframe" } };

  // Numeric constraints for parameters whose range is fixed by Roblox / the handler.
  const RANGES = {
    transparency: [0, 1], reflectance: [0, 1], clock_time: [0, 24], fov: [1, 120], volume: [0, 10],
    opacity: [0, 1], alpha: [0, 1], playback_speed: [0, 20], limit: [1, 100000], max_distance: [0, 100000],
  };
  const INTEGERS = new Set(["limit", "count", "max_scripts", "segments", "levels", "layout_order", "z_index", "page", "max_results"]);
  const VECTOR_PARAMS = new Set(["position", "size", "rotation", "offset", "location", "scale", "target_position", "look_at", "from", "to", "center", "min", "max"]);
  const COLOR_PARAMS = new Set(["color", "color3", "secondary_color", "accent", "background_color", "text_color", "glow_color", "tint"]);

  const READ_RE = /^(get|find|list|inspect|search|validate|read|audit|analy|capture|check|diagnos|status|verify|describe|explain|preview|query|summar|stat|lint|measure|report|dump|export_report)/;
  const READ_SUFFIX_RE = /_(list|inspect|get|find|audit|read|verify|check|info|status|summary|stats|describe|lint|analysis|preview|report|diff|search|exists|count)$/;
  const DESTRUCTIVE_RE = /(destroy|delete|clear|remove|reset|wipe|kill|purge|uninstall|overwrite|truncate|drop)/;
  const VERIFY_RE = /(set|create|build|add|insert|spawn|apply|install|move|resize|rename|weld|attach|anchor|tween|place)/;

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const short = (v) => { try { const s = typeof v === "string" ? v : JSON.stringify(v); return String(s).length > 60 ? String(s).slice(0, 57) + "..." : String(s); } catch { return String(v); } };
  const snake = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
  const fold = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

  let sources = { skills: null, agent: null, native: null };
  function configure(opts) { sources = Object.assign({}, sources, opts || {}); }
  function skillsList() {
    if (sources.skills && Array.isArray(sources.skills.SKILL_COMMANDS)) return sources.skills.SKILL_COMMANDS;
    try { if (typeof RobloxScriptSkills !== "undefined" && Array.isArray(RobloxScriptSkills.SKILL_COMMANDS)) return RobloxScriptSkills.SKILL_COMMANDS; } catch {}
    return [];
  }
  function agentList() {
    if (sources.agent && Array.isArray(sources.agent.SKILL_COMMANDS)) return sources.agent.SKILL_COMMANDS;
    try { if (typeof AgentScriptSkills !== "undefined" && Array.isArray(AgentScriptSkills.SKILL_COMMANDS)) return AgentScriptSkills.SKILL_COMMANDS; } catch {}
    return [];
  }

  // ── contract ───────────────────────────────────────────────────────────────
  const cache = new Map();
  function enumKeyFor(cmd, param) {
    if (ENUM_PARAM_COMMAND[cmd + "." + param]) return ENUM_PARAM_COMMAND[cmd + "." + param];
    const k = ENUM_PARAMS[param];
    if (!k) return null;
    if (ENUM_PARAM_EXCEPT[param] && ENUM_PARAM_EXCEPT[param].test(cmd)) return null;
    return typeof k === "function" ? k(cmd) : k;
  }
  function contract(name) {
    const id = String(name || "").split("/").pop();
    if (cache.has(id)) return cache.get(id);
    let def = null, backend = null;
    for (const c of skillsList()) if (c && c.name === id) { def = c; backend = "roblox_studio"; break; }
    if (!def) for (const c of agentList()) if (c && c.name === id) { def = c; backend = "local_agent"; break; }
    if (!def) { cache.set(id, null); return null; }
    const params = {};
    const declared = Object.keys(def.params || {});
    for (const k of declared) {
      const p = def.params[k] || {};
      const type = String(p.type || "any");
      const entry = { type, required: !!p.req, desc: String(p.desc || ""), enum: null, enumKey: null, range: null, integer: INTEGERS.has(k) && (type === "number" || type === "integer"), vector: false, color: false, default: p.default };
      const ek = enumKeyFor(id, k);
      if (ek && (type === "string" || type === "any")) { entry.enumKey = ek; entry.enum = ROBLOX_ENUMS[ek]; }
      if (RANGES[k] && (type === "number" || type === "integer")) entry.range = RANGES[k];
      if ((type === "array" || type === "position" || type === "any") && (VECTOR_PARAMS.has(k) || type === "position")) entry.vector = true;
      if ((type === "array" || type === "color") && COLOR_PARAMS.has(k)) entry.color = true;
      // a param whose desc enumerates its values ("a | b | c" or "one of: a, b")
      if (!entry.enum && type === "string" && /\b(one of|options?):\s*/i.test(entry.desc)) {
        const m = entry.desc.match(/\b(?:one of|options?):\s*([^.;()]+)/i);
        if (m) { const vals = m[1].split(/[,|/]/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)); if (vals.length >= 2 && vals.length <= 24) { entry.enum = vals; entry.enumKey = "desc"; } }
      }
      params[k] = entry;
    }
    const aliases = {};
    for (const [alias, canon] of Object.entries(COMMAND_ALIASES[id] || {})) if (params[canon] && !params[alias]) aliases[alias] = canon;
    for (const [alias, canon] of Object.entries(PARAM_ALIASES)) if (params[canon] && !params[alias] && !aliases[alias]) aliases[alias] = canon;
    for (const [alias, canon] of Object.entries(PARAM_ALIASES_REVERSE)) if (params[canon] && !params[alias]) aliases[alias] = canon;
    const read = READ_RE.test(id) || READ_SUFFIX_RE.test(id) || /^(lighting_inspect|ui_inspect|plugin_list|blueprint_list|style_guide)$/.test(id);
    const c = Object.freeze({
      name: id, backend, description: String(def.description || ""), params, aliases,
      required: declared.filter((k) => params[k].required),
      mutating: !read, destructive: !read && DESTRUCTIVE_RE.test(id), reversible: !DESTRUCTIVE_RE.test(id),
      verify: !read && VERIFY_RE.test(id) ? "read back the instance (inspect_instance / instance_find) when the result matters" : null,
      hidden: !!def.hidden, version: VERSION,
    });
    cache.set(id, c);
    return c;
  }
  function invalidate() { cache.clear(); }

  function schemaLine(name) {
    const c = contract(name);
    if (!c) return "";
    const parts = Object.entries(c.params).map(([k, p]) => {
      let t = p.enumKey && p.enumKey !== "desc" ? "Enum." + p.enumKey : p.enum ? p.enum.join("|") : p.vector ? "[x,y,z]" : p.color ? "[r,g,b]" : p.type;
      if (p.range) t += " " + p.range[0] + ".." + p.range[1];
      return `${k}${p.required ? "" : "?"}: ${t}`;
    });
    return `${c.name} {${parts.join(", ")}}`;
  }

  // ── value repair (deterministic only) ───────────────────────────────────────
  function toVector(v) {
    if (Array.isArray(v)) { const n = v.map(Number); return n.length >= 2 && n.length <= 4 && n.every(Number.isFinite) ? n : null; }
    if (isObj(v)) {
      const keys = ["x", "y", "z"].filter((k) => v[k] !== undefined || v[k.toUpperCase()] !== undefined);
      if (keys.length >= 2) { const n = keys.map((k) => Number(v[k] !== undefined ? v[k] : v[k.toUpperCase()])); return n.every(Number.isFinite) ? n : null; }
      return null;
    }
    if (typeof v === "string" && /^\s*[-\d.]+\s*[, ]\s*[-\d.]+(\s*[, ]\s*[-\d.]+)?(\s*[, ]\s*[-\d.]+)?\s*$/.test(v)) { const n = v.trim().split(/\s*[, ]\s*/).map(Number); return n.every(Number.isFinite) ? n : null; }
    return null;
  }
  function toColor(v) {
    if (Array.isArray(v)) { const n = v.map(Number); return n.length === 3 && n.every(Number.isFinite) ? n : null; }
    if (typeof v === "string") {
      const h = v.trim().replace(/^#/, "");
      if (/^[0-9a-f]{6}$/i.test(h)) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      if (/^[0-9a-f]{3}$/i.test(h)) return h.split("").map((c) => parseInt(c + c, 16));
      const m = v.match(/^\s*(?:rgb\()?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)?\s*$/i);
      if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
      return null;
    }
    if (isObj(v)) { const n = ["r", "g", "b"].map((k) => Number(v[k] !== undefined ? v[k] : v[k.toUpperCase()])); return n.every(Number.isFinite) ? n : null; }
    return null;
  }
  function enumMatch(list, v, key) {
    if (typeof v !== "string") return { ok: false };
    let s = v.trim();
    const pre = s.match(/^Enum\.([A-Za-z]+)\.([A-Za-z0-9_]+)$/);
    if (pre) s = pre[2];
    if (list.includes(s)) return { ok: true, value: s, changed: s !== v };
    const al = ENUM_ALIASES[key] || {};
    if (Object.prototype.hasOwnProperty.call(al, s)) return al[s] ? { ok: true, value: al[s], changed: true } : { ok: false, known_bad: true };
    const f = fold(s);
    const hits = list.filter((e) => fold(e) === f);
    if (hits.length === 1) return { ok: true, value: hits[0], changed: true };
    return { ok: false };
  }
  function coerce(entry, v) {
    const t = entry.type;
    if (t === "string" && typeof v === "number" && Number.isFinite(v)) return { ok: true, value: String(v) };
    if (t === "string" && typeof v === "boolean") return { ok: true, value: v ? "true" : "false" };
    if ((t === "number" || t === "integer") && typeof v === "string" && /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(v)) return { ok: true, value: Number(v) };
    if (t === "boolean" && typeof v === "string" && /^\s*(true|false|yes|no|on|off|1|0)\s*$/i.test(v)) return { ok: true, value: /^\s*(true|yes|on|1)\s*$/i.test(v) };
    if (t === "boolean" && (v === 0 || v === 1)) return { ok: true, value: v === 1 };
    if ((t === "array" || t === "object" || t === "json") && typeof v === "string" && /^\s*[\[{]/.test(v)) { try { const p = JSON.parse(v); if ((t === "array" && Array.isArray(p)) || (t !== "array" && p && typeof p === "object")) return { ok: true, value: p }; } catch {} }
    if (t === "array" && typeof v === "string" && entry.vector) { const n = toVector(v); if (n) return { ok: true, value: n }; }
    if (t === "array" && typeof v === "string" && !entry.vector && !entry.color && v.includes(",")) return { ok: true, value: v.split(",").map((s) => s.trim()).filter(Boolean) };
    return { ok: false };
  }
  function typeOk(entry, v) {
    const t = entry.type;
    if (t === "any" || t === "json") return true;
    if (t === "string") return typeof v === "string";
    if (t === "number" || t === "integer") return typeof v === "number" && Number.isFinite(v);
    if (t === "boolean") return typeof v === "boolean";
    if (t === "array" || t === "position" || t === "color") return Array.isArray(v);
    if (t === "object") return isObj(v);
    return true;
  }
  const expected = (entry) => entry.enumKey && entry.enumKey !== "desc" ? `one of Enum.${entry.enumKey} (${entry.enum.slice(0, 8).join(", ")}${entry.enum.length > 8 ? ", ..." : ""})` : entry.enum ? `one of ${entry.enum.join(", ")}` : entry.vector ? "an array of numbers [x,y,z]" : entry.color ? "a colour [r,g,b] 0-255 (or #rrggbb)" : entry.integer ? "an integer" : entry.type;

  // prepare(name, args) - never throws; a command without a contract passes through untouched.
  function prepare(name, rawArgs, opts) {
    opts = opts || {};
    const c = contract(name);
    const out = { ok: true, args: isObj(rawArgs) ? Object.assign({}, rawArgs) : {}, corrections: [], warnings: [], problems: [], contract: c, message: "" };
    if (!c) return out;
    const args = out.args;
    const problem = (code, param, exp, rec, suggestion, retryable) => out.problems.push({ code, param, expected: exp, received: rec, suggestion, retryable: retryable !== false });
    const correct = (kind, param, from, to) => out.corrections.push({ kind, param, from, to });
    // 1. parameter names: exact > alias > case / camelCase variant
    for (const key of Object.keys(args)) {
      if (/^_total/.test(key) || c.params[key]) continue;
      let canon = c.aliases[key] || null;
      if (!canon) { const s = snake(key); if (s !== key && c.params[s]) canon = s; else if (c.aliases[s]) canon = c.aliases[s]; }
      if (!canon) { const hits = Object.keys(c.params).filter((k) => k.toLowerCase() === key.toLowerCase()); if (hits.length === 1) canon = hits[0]; }
      if (!canon) continue;
      if (args[canon] !== undefined && args[canon] !== null && args[canon] !== "" && JSON.stringify(args[canon]) !== JSON.stringify(args[key])) {
        problem("conflicting_parameters", key, `only '${canon}'`, `'${key}'=${short(args[key])} and '${canon}'=${short(args[canon])}`, `'${key}' is an alias of '${canon}' - send one value under '${canon}'`);
        continue;
      }
      if (args[canon] === undefined || args[canon] === null || args[canon] === "") args[canon] = args[key];
      delete args[key];
      correct("alias", key, key, canon);
    }
    // 2. unknown parameters: kept for the handler (packs read undeclared keys), reported once
    const unknown = Object.keys(args).filter((k) => !/^_total/.test(k) && !c.params[k]);
    if (unknown.length) out.warnings.push(`unknown parameter(s) for ${c.name}: ${unknown.join(", ")} (declared: ${Object.keys(c.params).join(", ") || "none"})`);
    // 3. required
    for (const k of c.required) {
      const v = args[k];
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0 && c.params[k].type === "array")) {
        problem("missing_parameter", k, expected(c.params[k]), v === undefined ? "nothing" : short(v), `pass '${k}'${c.params[k].desc ? " - " + c.params[k].desc.slice(0, 80) : ""}`);
      }
    }
    // 4. values
    for (const [k, entry] of Object.entries(c.params)) {
      let v = args[k];
      if (v === undefined) continue;
      if (v === null) { if (entry.required) continue; delete args[k]; correct("null_dropped", k, null, undefined); continue; }
      if (entry.vector && !typeOk(entry, v)) { const n = toVector(v); if (n) { args[k] = n; correct("vector", k, short(v), n); v = n; } }
      if (entry.color && !Array.isArray(v)) {
        const n = toColor(v);
        if (n) { args[k] = n; correct("color", k, short(v), n); v = n; }
        else if (typeof v === "string" && /^[a-z]+$/i.test(v.trim())) continue; // named colour ("red") - the packs map these themselves
      }
      if (!typeOk(entry, v)) {
        const cv = coerce(entry, v);
        if (cv.ok) { args[k] = cv.value; correct("type", k, short(v), short(cv.value)); v = cv.value; }
        else { problem("invalid_type", k, expected(entry), `${typeOf(v)} ${short(v)}`, `send '${k}' as ${expected(entry)}`); continue; }
      }
      if (typeof v === "number" && !Number.isFinite(v)) { problem("invalid_type", k, "a finite number", String(v), `'${k}' must not be NaN / Infinity`); continue; }
      if (entry.vector && Array.isArray(v)) {
        const n = v.map(Number);
        if (!n.every(Number.isFinite) || n.length < 2 || n.length > 4) { problem("invalid_type", k, "an array of 2-4 finite numbers", short(v), `write '${k}' as [x, y, z]`); continue; }
        if (n.some((x, i) => x !== v[i])) { args[k] = n; correct("type", k, short(v), n); v = n; }
      }
      if (entry.color && Array.isArray(v)) {
        if (v.length !== 3 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) { problem("invalid_type", k, "[r, g, b]", short(v), `write '${k}' as [r, g, b]`); continue; }
        if (v.every((x) => x >= 0 && x <= 1) && v.some((x) => x > 0 && x < 1)) { const scaled = v.map((x) => Math.round(x * 255)); args[k] = scaled; correct("color_scale", k, short(v), scaled); v = scaled; }
        if (v.some((x) => x < 0 || x > 255)) { problem("out_of_range", k, "components 0-255", short(v), `'${k}' components must be 0-255`); continue; }
      }
      if (entry.enum) {
        const m = enumMatch(entry.enum, v, entry.enumKey);
        if (m.ok) { if (m.changed) { correct("enum", k, v, m.value); args[k] = m.value; v = m.value; } }
        else problem("invalid_enum", k, expected(entry), short(v), m.known_bad ? `'${short(v)}' is not a Roblox ${entry.enumKey} - pick the closest real item from the list` : `use one of the listed ${entry.enumKey === "desc" ? "values" : "Enum." + entry.enumKey + " items"}`);
      }
      if (entry.integer && typeof v === "number" && !Number.isInteger(v)) {
        if (Math.abs(v - Math.round(v)) < 1e-9) { args[k] = Math.round(v); correct("type", k, v, args[k]); }
        else problem("invalid_type", k, "an integer", String(v), `'${k}' must be a whole number`);
      }
      if (entry.range && typeof v === "number" && (v < entry.range[0] || v > entry.range[1])) problem("out_of_range", k, `${entry.range[0]}..${entry.range[1]}`, String(v), `'${k}' must be between ${entry.range[0]} and ${entry.range[1]} - not clamped, fix the value`);
    }
    out.ok = out.problems.length === 0;
    if (!out.ok) out.message = formatProblems(c, out, opts.label || name);
    return out;
  }
  function formatProblems(c, out, label) {
    const missing = out.problems.filter((p) => p.code === "missing_parameter");
    const code = missing.length && missing.length === out.problems.length ? "MISSING_PARAMS" : out.problems.some((p) => p.code === "invalid_enum") && out.problems.every((p) => p.code === "invalid_enum") ? "INVALID_ENUM" : "INVALID_PARAMS";
    const lines = out.problems.map((p) => `- ${p.param}: ${p.code.replace(/_/g, " ")} - expected ${p.expected}, got ${p.received}. ${p.suggestion}`);
    return `ERROR ${code} calling '${label}': the call did not match the command's real schema, so it was NOT run.\n${lines.join("\n")}\nSchema: ${schemaLine(c.name)}\nFix only the listed parameter(s) and resend the same command - do not look the command up.`;
  }

  // ── execution-result classification ─────────────────────────────────────────
  const CLASSES = [
    { category: "missing_parameter", code: "MISSING_PARAMS", deterministic: true, re: /MISSING_PARAMS|missing required param|is required\b|parameter\(s\) not provided|needs (spec|name) /i, next: "add the named parameter and resend" },
    { category: "invalid_enum", code: "INVALID_ENUM", deterministic: true, re: /INVALID_ENUM|is not a valid EnumItem|not a valid member of Enum|invalid enum|must be one of|Valid: |enum "[^"]*" not found in \(|unknown (preset|material|style|format)\b/i, next: "pick one of the listed values" },
    { category: "invalid_parameter", code: "INVALID_PARAMS", deterministic: true, re: /INVALID_PARAMS|INVALID_PARAMETER|must be (a |an )?(string|number|boolean|array|object|integer|positive|finite|BasePart|Model|GuiObject|ScreenGui|JSON)|out of range|invalid (parameter|argument|value|json)|bad args|could not convert|invalid literal for|ValueError|Expected (Vector3|Color3|CFrame|UDim2|number|string|boolean|table)|cannot convert|unable to cast|invalid argument #\d/i, next: "fix the named value only, keep everything else" },
    { category: "unknown_parameter", code: "UNKNOWN_PARAM", deterministic: true, re: /unexpected keyword argument|unknown parameter|unrecognized (argument|parameter|field)|got an unexpected/i, next: "remove or rename the parameter to one the schema lists" },
    { category: "unknown_command", code: "UNKNOWN_COMMAND", deterministic: true, re: /unknown (TotalScript |blender |studio skill |animation |asset )?(command|tool|op)\b|Unknown tool|is not available in this build|no such tool|not a (recognised|recognized) command|COMMAND_NOT_FOUND/i, next: "use a command from your catalogue - do not search" },
    { category: "syntax_error", code: "SYNTAX_ERROR", deterministic: true, re: /Failed to parse command code|unexpected symbol|Incomplete statement|Expected .{1,40} got|'end' expected|unfinished string|Malformed number|syntax error|SyntaxError|IndentationError|Expected identifier|Expected expression/i, next: "fix the exact token the error names; do not rewrite unrelated code" },
    { category: "permission_denied", code: "PERMISSION_DENIED", deterministic: false, re: /USER_ACTION_REQUIRED|needs Full PC access|not allowed in (Sandbox|Ask)|permission denied|PermissionError|approval|did not answer|denied by the user|EACCES|Forbidden|HTTP 403/i, next: "stop and ask the user; never work around a permission" },
    { category: "backend_unavailable", code: "BACKEND_UNAVAILABLE", deterministic: false, transient: true, re: /STUDIO_BRIDGE_OFFLINE|bridge is offline|not connected|Studio is not connected|Blender is not connected|ENGINE_MISMATCH|Unable to find an active Studio|disconnected|stale-extension|Reload this page|Connection refused|not listening|ECONNREFUSED/i, next: "reconnect (total_status / Connect Blender) and only then retry" },
    { category: "timeout", code: "TIMEOUT", deterministic: false, transient: true, uncertain: true, re: /timed out|timeout|TIMEOUT|no response from|did not respond/i, next: "the operation MAY have run - inspect the state before retrying" },
    { category: "invalid_context", code: "INVALID_CONTEXT", deterministic: false, re: /context is incorrect|poll\(\) failed|no active object|requires an active|must be in (edit|object|pose) mode|not in edit mode|wrong mode|Operator .{1,60} is not available|cannot run while|only (works|available) in (Play|Edit|Server|Client)|datamodel_type .*Client|game (is not|must be) running/i, next: "establish the context the error names (select / mode / datamodel), then retry once" },
    { category: "invalid_property", code: "INVALID_PROPERTY", deterministic: true, re: /is not a valid member of|is not a valid property|cannot be assigned|Unable to assign property|property .{1,40} (read-only|is read only)|attempt to call a nil value \((method|field)/i, next: "check the class with inspect_instance / the API before using that property or method" },
    { category: "api_incompatibility", code: "API_INCOMPATIBLE", deterministic: true, re: /has no attribute|AttributeError|TypeError|NotImplementedError|not supported in this (version|build)|deprecated|version .{0,20} (required|unsupported)|no longer (exists|supported)/i, next: "query the installed API (blender_introspect / inspect_instance) and use a supported call" },
    { category: "resource_missing", code: "RESOURCE_MISSING", deterministic: false, re: /missing_textures|not on disk|No such file|file (not found|does not exist)|FileNotFoundError|asset .{0,40}(missing|not found|failed to load)|could not load asset|rbxassetid.{0,40}(invalid|failed|not found)|HTTP 404|KeyError/i, next: "verify the file / asset exists (or create it) before retrying" },
    { category: "invalid_reference", code: "INVALID_REFERENCE", deterministic: false, re: /not found|does not exist|No instance|could not find|cannot find|no mesh (selected|objects found)|object required|build it first|attempt to index nil|attempt to index a nil|is nil\b|nil value|no (object|part|model|target) named|unknown (object|instance|collection)/i, next: "locate the real target first (instance_find / search_game_tree / blender_list_objects), then resend with the exact path" },
    { category: "verification_failed", code: "VERIFY_FAILED", deterministic: false, re: /verif|mismatch|placeholder|expected \d+ parts|read-back|readback|structural errors/i, next: "inspect the actual state and correct the outcome, not the error text" },
  ];
  function classify(name, text) {
    const t = String(text || "");
    const failed = /^\s*ERROR\b/.test(t) || /^\s*(Output of '[^']*':\s*\n?\s*)?(error executing|error:|exception|traceback|failed to|cannot |unable to)/i.test(t) || /^\s*(Output of '[^']*':\s*\n?\s*)?\{\s*"ok"\s*:\s*false/.test(t);
    if (!failed) return { ok: true, category: "ok", code: "OK", retryable: false, deterministic: false, transient: false, uncertain: false, next: "" };
    const head = t.replace(/^Output of '[^']*':\n?/, "").slice(0, 1500);
    for (const c of CLASSES) {
      if (c.re.test(head)) return { ok: false, category: c.category, code: c.code, retryable: !c.deterministic, deterministic: !!c.deterministic, transient: !!c.transient, uncertain: !!c.uncertain, next: c.next };
    }
    return { ok: false, category: "runtime_error", code: "RUNTIME_ERROR", retryable: true, deterministic: false, transient: false, uncertain: false, next: "read the message, inspect the state it names, change the call - never resend it unchanged" };
  }
  function annotate(name, text, prep) {
    const t = String(text || "");
    if (/\[diagnosis\]/.test(t)) return t;
    const k = classify(name, t);
    const extras = [];
    if (prep && prep.warnings && prep.warnings.length) extras.push(prep.warnings[0]);
    if (prep && prep.corrections && prep.corrections.length) extras.push("normalized: " + prep.corrections.map((c) => (c.kind === "alias" ? `${c.to} <- ${c.from}` : `${c.param} (${c.kind})`)).join(", "));
    if (k.ok) return extras.length ? t + `\n[note] ${extras.join("; ")}` : t;
    const c = contract(name);
    return t + `\n[diagnosis] ${k.category}${k.deterministic ? " (deterministic: an identical resend will fail again)" : k.uncertain ? " (uncertain: the operation may have run)" : ""}; next: ${k.next}${c && c.verify && !k.deterministic ? "; verify: " + c.verify : ""}${extras.length ? "; " + extras.join("; ") : ""}`;
  }

  const api_extra = {};
  // ── repeat detection ────────────────────────────────────────────────────────
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (isObj(v)) return "{" + Object.keys(v).filter((k) => !/^_total/.test(k)).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    return JSON.stringify(v);
  }
  function signature(name, args) {
    let a = args;
    try { const p = prepare(name, args); a = p.args; } catch {}
    return String(name || "").split("/").pop() + "|" + stable(a || {});
  }
  // Decide whether a call that is byte-identical (after normalization) to the
  // previous FAILED call should run again. Only deterministic failures are
  // blocked: a timeout / offline bridge / missing object can legitimately change.
  // 1.87.0: two more rules, both opt-in through fields on `prev` so callers
  // that only pass {sig,text,klass} keep the 1.84.0 behaviour:
  //   prev.mutating + an UNCERTAIN failure (timeout: the command MAY have run)
  //     -> the identical mutating call is held ONCE (prev.uncertainHeld) until
  //        something else ran in between (a read-back clears the guard), so a
  //        part / script is never created twice because Studio answered late;
  //   transient failures (offline bridge, timeout) get a budget too: the 6th
  //     identical attempt inside REPEAT_WINDOW_MS is blocked - the model must
  //     stop and tell the user instead of hammering a backend that is down.
  //     The window makes the block expire, so "retry" after the user fixed the
  //     bridge goes through.
  const REPEAT_WINDOW_MS = 120000;
  const TRANSIENT_BUDGET = 5;
  function repeatDecision(prev, sig, attempts) {
    if (!prev || prev.sig !== sig) return { block: false };
    const k = prev.klass || classify("", prev.text);
    if (k.deterministic) return { block: true, reason: `identical to the call that just failed with ${k.category} - nothing in that call changed, so it was NOT re-sent` };
    const recent = !prev.at || (Date.now() - prev.at) < REPEAT_WINDOW_MS;
    const timed = !!prev.at && (Date.now() - prev.at) < REPEAT_WINDOW_MS; // budget needs a timestamp (opt-in)
    if (k.uncertain && prev.mutating && !prev.uncertainHeld && recent) {
      return { block: true, hold: true, reason: `identical to the call that just TIMED OUT - that call MAY have run, so re-sending it could create / change the same thing twice. Read the state back first (inspect_instance / instance_find / get_console_output); if it did not happen, send the call again after that` };
    }
    if ((attempts || 0) >= 3 && !k.transient) return { block: true, reason: `the same call has failed ${attempts} times; retry budget exhausted` };
    if ((attempts || 0) >= TRANSIENT_BUDGET && k.transient && timed) return { block: true, reason: `the same call has failed ${attempts} times in a row with ${k.category}; the backend has not come back - stop retrying, tell the user what to check (bridge / Studio / Blender) and wait` };
    return { block: false };
  }
  api_extra.REPEAT_WINDOW_MS = REPEAT_WINDOW_MS;
  api_extra.TRANSIENT_BUDGET = TRANSIENT_BUDGET;

  const api = { ...api_extra, VERSION, ROBLOX_ENUMS, ENUM_PARAMS, PARAM_ALIASES, RANGES, CLASSES: CLASSES.map((c) => c.category), configure, contract, invalidate, prepare, classify, annotate, signature, schemaLine, repeatDecision, enumMatch, toVector, toColor };
  return Object.freeze(api);
})();
if (typeof window !== "undefined") window.TotalCommandContract = TotalCommandContract;
if (typeof module !== "undefined" && module.exports) module.exports = TotalCommandContract;
