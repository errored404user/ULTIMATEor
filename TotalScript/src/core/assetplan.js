// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript Asset Planner (1.99.1) - brief -> structured 3D asset spec.
//
// This is the "think before you add a cube" half of the Blender pipeline. A
// natural-language brief ("detailed sci-fi sword, 1.2 m, teal accents") becomes
// a SPEC: category, style profile, overall dimensions, a part list with
// roles (primary / secondary / tertiary), per-part construction ops (bevel,
// inset, boolean cut, grooves, taper, mirror, array, displace), seeded
// procedural generators (1.93.0: branching trees, canopies, fBm terrain, rock
// and crystal clusters, stairs), smoothing
// policy, a material set with real PBR parameters + a Roblox material hint,
// attachments, origin rule, and a tri / part / material budget. tools/
// blender_asset.py builds the spec in Blender; the spec is also what the
// validator reasons about, so every decision is inspectable data.
//
// Nothing here talks to Blender or Studio. Exposed as window.TotalAssetPlan and
// module.exports (tests). Units: metres, Blender Z-up; size = [x, y, z] full
// extents; pos = part centre; rot = degrees.
(function (root) {
  "use strict";
  const VERSION = "1.99.7";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const vec = (a) => a.map(r3);

  // ── Style profiles: every field changes geometry, not just colour ──────────
  const STYLES = {
    stylized_fantasy: { label: "Stylized fantasy", bevel_scale: 1.6, bevel_segments: 3, exaggerate: 1.25, saturation: 1.15, value: 1.05, roughness_bias: 0.1, metal_bias: -0.1, emissive: true, detail: 0.6, poly_mult: 1.0, subdiv: 0, facet: false, cylinder_segments: 20 },
    realistic: { label: "Realistic / semi-realistic", bevel_scale: 0.7, bevel_segments: 3, exaggerate: 1.0, saturation: 0.9, value: 0.95, roughness_bias: 0.05, metal_bias: 0, emissive: false, detail: 0.8, poly_mult: 1.3, subdiv: 0, facet: false, cylinder_segments: 32 },
    scifi: { label: "Sci-fi / futuristic", bevel_scale: 0.9, bevel_segments: 2, exaggerate: 1.1, saturation: 0.85, value: 0.9, roughness_bias: -0.1, metal_bias: 0.25, emissive: true, detail: 1.0, poly_mult: 1.2, subdiv: 0, facet: false, cylinder_segments: 24 },
    low_poly: { label: "Low-poly", bevel_scale: 0.0, bevel_segments: 1, exaggerate: 1.1, saturation: 1.1, value: 1.0, roughness_bias: 0.25, metal_bias: -0.3, emissive: false, detail: 0.2, poly_mult: 0.35, subdiv: 0, facet: true, cylinder_segments: 8 },
    cartoon: { label: "Cartoon", bevel_scale: 2.2, bevel_segments: 4, exaggerate: 1.4, saturation: 1.25, value: 1.1, roughness_bias: 0.2, metal_bias: -0.2, emissive: false, detail: 0.3, poly_mult: 1.0, subdiv: 1, facet: false, cylinder_segments: 24 },
    anime: { label: "Anime-inspired", bevel_scale: 1.2, bevel_segments: 2, exaggerate: 1.3, saturation: 1.1, value: 1.05, roughness_bias: 0.15, metal_bias: -0.05, emissive: true, detail: 0.5, poly_mult: 1.0, subdiv: 0, facet: false, cylinder_segments: 20 },
    horror: { label: "Horror / dark", bevel_scale: 0.8, bevel_segments: 2, exaggerate: 1.05, saturation: 0.55, value: 0.6, roughness_bias: 0.3, metal_bias: -0.1, emissive: false, detail: 0.7, poly_mult: 1.1, subdiv: 0, facet: false, cylinder_segments: 24, wear: true },
  };
  const STYLE_WORDS = [["low_poly", /low[- ]?poly|flat[- ]shaded|faceted/i], ["cartoon", /cartoon|toon|chibi|cute/i], ["anime", /anime|manga|cel[- ]?shad/i], ["horror", /horror|creepy|haunted|dark|grim|rotten|rusty|decay/i], ["scifi", /sci[- ]?fi|futur|cyber|space|laser|plasma|blaster|mech/i], ["realistic", /realis|photo|pbr|semi[- ]real/i], ["stylized_fantasy", /fantasy|stylized|stylised|medieval|rpg|magic|rune/i]];

  // ── Categories: budgets (triangles for ONE hero asset at normal viewing distance) ──
  const CATEGORIES = {
    weapon: { tris: 6000, parts: 12, materials: 5, origin: "grip", collision: "box" },
    prop: { tris: 3000, parts: 10, materials: 4, origin: "bottom", collision: "box" },
    furniture: { tris: 3500, parts: 12, materials: 4, origin: "bottom", collision: "box" },
    building_module: { tris: 2500, parts: 10, materials: 4, origin: "bottom", collision: "precise" },
    vehicle: { tris: 12000, parts: 16, materials: 6, origin: "bottom", collision: "hull" },
    organic: { tris: 4000, parts: 6, materials: 3, origin: "bottom", collision: "hull" },
    scifi_prop: { tris: 5000, parts: 12, materials: 5, origin: "bottom", collision: "box" },
    building: { tris: 9000, parts: 10, materials: 4, origin: "bottom", collision: "precise" },
    environment: { tris: 9000, parts: 6, materials: 3, origin: "bottom", collision: "precise" },
    character_part: { tris: 8000, parts: 8, materials: 4, origin: "bottom", collision: "none", unsupported: "character meshes need sculpting, retopology, skinning and an R15 cage - the Blender pipeline builds hard-surface and simple organic props only; use the blocky R6/R15 rig builders or a hand-made mesh for characters" },
  };

  // ── Material families: PBR parameters + the closest Roblox material ─────────
  // (Roblox cannot reproduce a Principled BSDF: the importer maps these to
  // Enum.Material + Color + Reflectance/Transparency - the hint is explicit.)
  const FAMILIES = {
    steel: { metallic: 1.0, roughness: 0.35, roblox: "Metal" },
    dark_steel: { metallic: 1.0, roughness: 0.5, roblox: "DiamondPlate" },
    gold: { metallic: 1.0, roughness: 0.3, roblox: "Metal" },
    painted_metal: { metallic: 0.6, roughness: 0.45, roblox: "Metal" },
    chrome: { metallic: 1.0, roughness: 0.12, roblox: "Metal" },
    wood: { metallic: 0.0, roughness: 0.7, roblox: "Wood" },
    planks: { metallic: 0.0, roughness: 0.8, roblox: "WoodPlanks" },
    leather: { metallic: 0.0, roughness: 0.6, roblox: "Fabric" },
    fabric: { metallic: 0.0, roughness: 0.9, roblox: "Fabric" },
    rubber: { metallic: 0.0, roughness: 0.85, roblox: "SmoothPlastic" },
    plastic: { metallic: 0.0, roughness: 0.4, roblox: "SmoothPlastic" },
    stone: { metallic: 0.0, roughness: 0.9, roblox: "Slate" },
    brick: { metallic: 0.0, roughness: 0.9, roblox: "Brick" },
    concrete: { metallic: 0.0, roughness: 0.85, roblox: "Concrete" },
    glass: { metallic: 0.0, roughness: 0.05, roblox: "Glass", alpha: 0.35 },
    energy: { metallic: 0.0, roughness: 0.2, roblox: "Neon", emissive: true },
    foliage: { metallic: 0.0, roughness: 0.75, roblox: "Grass" },
    bark: { metallic: 0.0, roughness: 0.9, roblox: "Wood" },
    crystal: { metallic: 0.0, roughness: 0.08, roblox: "Glass", alpha: 0.75, emissive: true, keep_roblox: true },
    plaster: { metallic: 0.0, roughness: 0.75, roblox: "Concrete" },
  };
  const SWATCH = { teal: [0.1, 0.65, 0.65], cyan: [0.15, 0.8, 0.9], red: [0.7, 0.12, 0.1], crimson: [0.55, 0.05, 0.08], blue: [0.15, 0.3, 0.75], navy: [0.08, 0.12, 0.3], green: [0.2, 0.5, 0.2], purple: [0.4, 0.15, 0.6], gold: [0.85, 0.65, 0.2], orange: [0.9, 0.45, 0.1], white: [0.9, 0.9, 0.88], black: [0.05, 0.05, 0.06], grey: [0.45, 0.45, 0.47], gray: [0.45, 0.45, 0.47], brown: [0.4, 0.26, 0.14], pink: [0.9, 0.4, 0.6], yellow: [0.95, 0.85, 0.2] };

  function tint(c, st) {
    // saturation / value treatment from the style profile (HSV-ish, cheap)
    const m = (c[0] + c[1] + c[2]) / 3;
    return c.map((x) => clamp((m + (x - m) * st.saturation) * st.value, 0, 1)).map(r3);
  }
  function material(id, family, color, st, extra) {
    const f = FAMILIES[family] || FAMILIES.plastic;
    // texture: "procedural" = family shader graph in Blender (wood grain, stone breakup, brushed metal,
    // edge wear, weave, glass, pulse ...); "flat" for faceted styles. texture_scale = metres per pattern tile.
    const o = Object.assign({ id, family, color: tint(color, st), metallic: clamp(f.metallic + st.metal_bias * (f.metallic > 0 ? 1 : 0), 0, 1), roughness: clamp(f.roughness + st.roughness_bias, 0.03, 1), alpha: f.alpha != null ? f.alpha : 1, emission: null, emission_strength: 0, roblox: f.roblox, wear: !!st.wear, texture: st.facet ? "flat" : "procedural", texture_scale: 1 }, extra || {});
    if (f.emissive) { o.emission = o.emission || o.color; o.emission_strength = st.emissive ? (o.emission_strength || (family === "crystal" ? 1.5 : 4)) : 0; if (!st.emissive && !f.keep_roblox) o.roblox = "SmoothPlastic"; }
    return o;
  }
  // bevel width relative to the part's smallest dimension (never a fixed 0.05)
  function bevel(size, frac, st, segs) {
    if (!st.bevel_scale) return null;
    const minDim = Math.min.apply(null, size.filter((x) => x > 0));
    // soft styles (cartoon) round everything with their own segment count; others may ask for fewer segments on thin parts
    return { width: r3(clamp(minDim * frac * st.bevel_scale, 0.0015, minDim * 0.45)), segments: st.bevel_segments >= 4 ? st.bevel_segments : (segs || st.bevel_segments), angle: 30, harden_normals: !st.facet };
  }
  const smooth = (st, kind) => (st.facet ? "flat" : kind || "auto");

  // ── Recipes: each returns {dims, parts, materials, attachments, origin, notes} ──
  // Proportions come from reference ranges (real swords: blade ~70-80 % of
  // length, guard 2.5-3x grip width; crates: plank 1/12 of width; doors 0.9 x 2.1 m …)
  const RECIPES = {};
  const P = (o) => Object.assign({ role: "secondary", rot: [0, 0, 0], ops: [], smooth: "auto", collision: "inherit", can_collide: null }, o);

  RECIPES.sword = (o, st) => {
    const L = o.length || 1.1, ex = st.exaggerate;
    const bladeL = L * 0.74, gripL = L * 0.16, guardW = 0.19 * ex, bladeW = 0.055 * ex, bladeT = 0.012, gripR = 0.019;
    const mats = { blade: material("blade", o.family_blade || "steel", o.accent2 || [0.78, 0.8, 0.84], st), guard: material("guard", o.family_guard || "dark_steel", o.secondary || [0.25, 0.27, 0.3], st), grip: material("grip", "leather", o.primary || [0.3, 0.18, 0.1], st), accent: material("accent", st.emissive ? "energy" : "gold", o.accent || [0.1, 0.7, 0.7], st) };
    const parts = [
      P({ name: "Blade", role: "primary", shape: "box", size: [bladeW, bladeT, bladeL], pos: [0, 0, gripL + 0.03 + bladeL / 2], material: "blade", bevel: bevel([bladeW, bladeT, bladeL], 0.42, st, 2), smooth: smooth(st, "auto"), ops: [{ op: "taper", axis: "z", top: 0.18, bottom: 1.0 }, { op: "grooves", axis: "z", count: 1, width: bladeW * 0.3, depth: bladeT * 0.25, length: 0.6, offset_z: -bladeL * 0.15, faces: "y" }] }),
      P({ name: "Guard", role: "secondary", shape: "box", size: [guardW, 0.03 * ex, 0.028], pos: [0, 0, gripL + 0.016], material: "guard", bevel: bevel([guardW, 0.03, 0.028], 0.3, st), ops: [{ op: "taper", axis: "x", top: 0.7, bottom: 0.7 }] }),
      P({ name: "Grip", role: "secondary", shape: "cylinder", size: [gripR * 2, gripR * 2, gripL], pos: [0, 0, gripL / 2], material: "grip", segments: st.cylinder_segments, bevel: bevel([gripR * 2, gripR * 2, gripL], 0.08, st, 1), smooth: smooth(st, "smooth"), ops: [{ op: "grooves", axis: "z", count: 5, width: 0.004, depth: 0.002, faces: "ring" }] }),
      P({ name: "Pommel", role: "tertiary", shape: "sphere", size: [gripR * 3.2, gripR * 3.2, gripR * 2.6], pos: [0, 0, -gripR * 0.8], material: "guard", segments: st.cylinder_segments, smooth: smooth(st, "smooth") }),
      P({ name: "GuardGem", role: "tertiary", shape: "cylinder", size: [0.02 * ex, 0.02 * ex, 0.04 * ex], pos: [0, 0, gripL + 0.016], rot: [90, 0, 0], material: "accent", segments: st.facet ? 6 : 12, smooth: smooth(st, "smooth") }),
    ];
    if (st.detail >= 0.6) parts.push(P({ name: "Ricasso", role: "tertiary", shape: "box", size: [bladeW * 1.15, bladeT * 1.6, 0.05], pos: [0, 0, gripL + 0.03 + 0.025], material: "guard", bevel: bevel([bladeW, bladeT * 1.6, 0.05], 0.2, st, 1) }));
    return { dims: [guardW, gripR * 3.2, L], parts, materials: mats, origin: "grip", origin_pos: [0, 0, gripL / 2], attachments: [{ name: "RightGripAttachment", pos: [0, 0, gripL / 2] }, { name: "TipAttachment", pos: [0, 0, L] }], notes: "blade 74 % / grip 16 % of length, fuller groove, tapered tip, gem in guard" };
  };

  RECIPES.blaster = (o, st) => {
    const total = o.length || 0.62, L = total / 1.14, ex = st.exaggerate; // parts span -0.47 L .. +0.67 L
    const mats = { body: material("body", "painted_metal", o.primary || [0.22, 0.24, 0.27], st), dark: material("dark", "dark_steel", [0.1, 0.1, 0.12], st), grip: material("grip", "rubber", [0.08, 0.08, 0.09], st), glow: material("glow", "energy", o.accent || [0.15, 0.8, 0.9], st, { emission_strength: 6 }) };
    const recv = [L * 0.5, 0.07 * ex, 0.11];
    const parts = [
      P({ name: "Receiver", role: "primary", shape: "box", size: recv, pos: [0, 0, 0.14], material: "body", bevel: bevel(recv, 0.12, st), ops: [{ op: "inset", faces: "sides", thickness: 0.012, depth: -0.006 }, { op: "grooves", axis: "x", count: Math.round(2 + st.detail * 3), width: 0.006, depth: 0.004, faces: "top" }] }),
      P({ name: "Barrel", role: "primary", shape: "cylinder", size: [0.04, 0.04, L * 0.42], pos: [L * 0.25 + L * 0.21, 0, 0.16], rot: [0, 90, 0], material: "dark", segments: st.cylinder_segments, smooth: smooth(st, "smooth"), bevel: bevel([0.04, 0.04, L * 0.42], 0.08, st, 1), ops: [{ op: "inset", faces: "+z", thickness: 0.008, depth: -0.03 }] }),
      P({ name: "BarrelShroud", role: "secondary", shape: "box", size: [L * 0.3, 0.06 * ex, 0.05], pos: [L * 0.25 + L * 0.12, 0, 0.16], material: "body", bevel: bevel([L * 0.3, 0.06, 0.05], 0.15, st), ops: [{ op: "cut", shape: "cylinder", size: [0.03, 0.03, L * 0.4], pos: [0, 0, 0], rot: [0, 90, 0] }, { op: "grooves", axis: "x", count: 4, width: 0.008, depth: 0.01, faces: "sides" }] }),
      P({ name: "Grip", role: "secondary", shape: "box", size: [0.035, 0.045 * ex, 0.12], pos: [-L * 0.08, 0, 0.03], rot: [0, -15, 0], material: "grip", bevel: bevel([0.035, 0.045, 0.12], 0.25, st), ops: [{ op: "grooves", axis: "z", count: 4, width: 0.004, depth: 0.002, faces: "sides" }] }),
      P({ name: "Stock", role: "secondary", shape: "box", size: [L * 0.22, 0.05 * ex, 0.07], pos: [-L * 0.25 - L * 0.1, 0, 0.12], material: "body", bevel: bevel([L * 0.22, 0.05, 0.07], 0.2, st), ops: [{ op: "taper", axis: "x", top: 1, bottom: 0.75 }] }),
      P({ name: "EnergyCell", role: "tertiary", shape: "cylinder", size: [0.03, 0.03, 0.08], pos: [-L * 0.02, 0, 0.21], rot: [0, 90, 0], material: "glow", segments: st.cylinder_segments, smooth: smooth(st, "smooth") }),
      P({ name: "Sight", role: "tertiary", shape: "box", size: [0.06, 0.02, 0.025], pos: [L * 0.1, 0, 0.215], material: "dark", bevel: bevel([0.06, 0.02, 0.025], 0.2, st, 1) }),
      P({ name: "TriggerGuard", role: "tertiary", shape: "torus", size: [0.05, 0.05, 0.012], pos: [-L * 0.03, 0, 0.07], rot: [90, 0, 0], material: "dark", segments: st.facet ? 8 : 16, smooth: smooth(st, "smooth") }),
    ];
    if (!st.emissive) parts[5].material = "dark";
    return { dims: [total * 1.18, 0.07 * ex, 0.26], parts, materials: mats, origin: "grip", origin_pos: [-L * 0.08, 0, 0.03], attachments: [{ name: "RightGripAttachment", pos: [-L * 0.08, 0, 0.03] }, { name: "MuzzleAttachment", pos: [L * 0.25 + L * 0.42, 0, 0.16] }], notes: "receiver + barrel primary, shroud / grip / stock secondary, cell / sight / trigger guard tertiary; emissive only when the style allows" };
  };

  RECIPES.crate = (o, st) => {
    const s = o.size || 1.0, plank = s / 12, ex = st.exaggerate;
    const mats = { planks: material("planks", "planks", o.primary || [0.5, 0.36, 0.2], st), frame: material("frame", "wood", o.secondary || [0.32, 0.22, 0.12], st), metal: material("metal", "dark_steel", [0.2, 0.2, 0.22], st) };
    const body = [s, s, s * 0.95];
    const parts = [P({ name: "Body", role: "primary", shape: "box", size: body, pos: [0, 0, body[2] / 2], material: "planks", bevel: bevel(body, 0.02, st, 1), ops: [{ op: "grooves", axis: "z", count: 3, width: plank * 0.12, depth: plank * 0.2, faces: "sides" }] })];
    const t = plank * 0.9 * ex;
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sy], i) => parts.push(P({ name: "Corner" + (i + 1), role: "secondary", shape: "box", size: [t, t, body[2] + t], pos: [sx * (s / 2 - t / 2 + t * 0.3), sy * (s / 2 - t / 2 + t * 0.3), body[2] / 2], material: "frame", bevel: bevel([t, t, body[2]], 0.15, st, 1) })));
    [0, 1].forEach((i) => parts.push(P({ name: "Band" + (i + 1), role: "tertiary", shape: "box", size: [s + t * 0.6, s + t * 0.6, plank * 0.7], pos: [0, 0, body[2] * (0.25 + i * 0.5)], material: "metal", bevel: bevel([s, s, plank * 0.7], 0.1, st, 1), ops: [{ op: "cut", shape: "box", size: [s - t * 0.2, s - t * 0.2, plank], pos: [0, 0, 0] }] })));
    return { dims: [s + t * 0.6, s + t * 0.6, body[2] + t], parts, materials: mats, origin: "bottom", attachments: [], notes: "plank grooves 1/12 width, corner posts proud of the body, two metal bands cut hollow" };
  };

  RECIPES.barrel = (o, st) => {
    const h = o.height || 0.9, r = (o.radius || 0.3) * st.exaggerate;
    const mats = { staves: material("staves", "wood", o.primary || [0.45, 0.3, 0.16], st), hoop: material("hoop", "dark_steel", [0.18, 0.18, 0.2], st) };
    const parts = [P({ name: "Staves", role: "primary", shape: "cylinder", size: [r * 2, r * 2, h], pos: [0, 0, h / 2], material: "staves", segments: st.cylinder_segments, smooth: smooth(st, "auto"), ops: [{ op: "bulge", amount: 0.1 }, { op: "grooves", axis: "z", count: st.facet ? 0 : 12, width: 0.004, depth: 0.003, faces: "ring_vertical" }] })];
    [0.18, 0.5, 0.82].forEach((k, i) => parts.push(P({ name: "Hoop" + (i + 1), role: "secondary", shape: "cylinder", size: [r * 2 * (1 + 0.1 * Math.sin(Math.PI * k)) + 0.012, r * 2 * (1 + 0.1 * Math.sin(Math.PI * k)) + 0.012, 0.045], pos: [0, 0, h * k], material: "hoop", segments: st.cylinder_segments, smooth: smooth(st, "smooth"), ops: [{ op: "cut", shape: "cylinder", size: [r * 2 * (1 + 0.1 * Math.sin(Math.PI * k)) - 0.01, r * 2 * (1 + 0.1 * Math.sin(Math.PI * k)) - 0.01, 0.06], pos: [0, 0, 0] }] })));
    parts.push(P({ name: "Lid", role: "tertiary", shape: "cylinder", size: [r * 1.9, r * 1.9, 0.03], pos: [0, 0, h - 0.015], material: "staves", segments: st.cylinder_segments, smooth: smooth(st, "flat") }));
    return { dims: [r * 2.2, r * 2.2, h], parts, materials: mats, origin: "bottom", attachments: [], notes: "bulged staves, three hoops that follow the bulge, recessed lid" };
  };

  RECIPES.table = (o, st) => {
    const w = o.width || 1.6, d = o.depth || 0.8, h = o.height || 0.75, top = 0.04, leg = 0.07 * st.exaggerate;
    const mats = { top: material("top", "wood", o.primary || [0.52, 0.36, 0.2], st), legs: material("legs", "wood", o.secondary || [0.36, 0.24, 0.13], st) };
    const parts = [P({ name: "Top", role: "primary", shape: "box", size: [w, d, top], pos: [0, 0, h - top / 2], material: "top", bevel: bevel([w, d, top], 0.3, st) })];
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sy], i) => parts.push(P({ name: "Leg" + (i + 1), role: "secondary", shape: "box", size: [leg, leg, h - top], pos: [sx * (w / 2 - leg * 0.9), sy * (d / 2 - leg * 0.9), (h - top) / 2], material: "legs", bevel: bevel([leg, leg, h], 0.12, st), ops: [{ op: "taper", axis: "z", top: 1, bottom: 0.75 }] })));
    parts.push(P({ name: "ApronLong", role: "tertiary", shape: "box", size: [w - leg * 2.2, 0.025, 0.09], pos: [0, d / 2 - leg * 0.9, h - top - 0.045], material: "legs", mirror: "y" }), P({ name: "ApronShort", role: "tertiary", shape: "box", size: [0.025, d - leg * 2.2, 0.09], pos: [w / 2 - leg * 0.9, 0, h - top - 0.045], material: "legs", mirror: "x" }));
    return { dims: [w, d, h], parts, materials: mats, origin: "bottom", attachments: [{ name: "SurfaceAttachment", pos: [0, 0, h] }], notes: "tapered legs inset from the corners, mirrored aprons, bevelled top" };
  };

  RECIPES.chair = (o, st) => {
    const w = o.width || 0.45, d = 0.45, seatH = 0.46, backH = 0.9, leg = 0.04 * st.exaggerate;
    const mats = { frame: material("frame", "wood", o.primary || [0.4, 0.27, 0.15], st), seat: material("seat", "fabric", o.secondary || [0.5, 0.15, 0.15], st) };
    const parts = [P({ name: "Seat", role: "primary", shape: "box", size: [w, d, 0.035], pos: [0, 0, seatH], material: "frame", bevel: bevel([w, d, 0.035], 0.3, st) }), P({ name: "Cushion", role: "secondary", shape: "box", size: [w * 0.9, d * 0.9, 0.04], pos: [0, 0, seatH + 0.037], material: "seat", bevel: bevel([w * 0.9, d * 0.9, 0.04], 0.45, st, 3), smooth: smooth(st, "smooth") })];
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sy], i) => parts.push(P({ name: "Leg" + (i + 1), role: "secondary", shape: "box", size: [leg, leg, seatH - 0.0175], pos: [sx * (w / 2 - leg * 0.8), sy * (d / 2 - leg * 0.8), (seatH - 0.0175) / 2], material: "frame", bevel: bevel([leg, leg, seatH], 0.12, st), ops: [{ op: "taper", axis: "z", top: 1, bottom: 0.8 }] })));
    parts.push(P({ name: "BackPost", role: "secondary", shape: "box", size: [leg, leg, backH - seatH], pos: [w / 2 - leg * 0.8, -d / 2 + leg * 0.8, seatH + (backH - seatH) / 2], rot: [8, 0, 0], material: "frame", mirror: "x", bevel: bevel([leg, leg, backH], 0.12, st) }), P({ name: "BackSlat", role: "tertiary", shape: "box", size: [w - leg * 1.6, 0.018, 0.1], pos: [0, -d / 2 + leg * 0.8 - 0.02, backH - 0.12], rot: [8, 0, 0], material: "frame", bevel: bevel([w, 0.018, 0.1], 0.3, st), array: { count: 2, offset: [0, 0.025, -0.16] } }));
    return { dims: [w, d, backH], parts, materials: mats, origin: "bottom", attachments: [{ name: "SeatAttachment", pos: [0, 0, seatH + 0.06] }], notes: "8 degree back rake, mirrored posts, arrayed slats, soft-bevelled cushion" };
  };

  RECIPES.lamp_post = (o, st) => {
    const h = o.height || 3.2, ex = st.exaggerate;
    const mats = { iron: material("iron", "painted_metal", o.primary || [0.1, 0.1, 0.12], st), glass: material("glass", "glass", [0.9, 0.85, 0.6], st), light: material("light", "energy", o.accent || [1, 0.8, 0.45], st, { emission_strength: 8 }) };
    const parts = [
      P({ name: "Base", role: "secondary", shape: "cylinder", size: [0.36 * ex, 0.36 * ex, 0.18], pos: [0, 0, 0.09], material: "iron", segments: st.cylinder_segments, bevel: bevel([0.36, 0.36, 0.18], 0.15, st), ops: [{ op: "taper", axis: "z", top: 0.7, bottom: 1 }] }),
      P({ name: "Pole", role: "primary", shape: "cylinder", size: [0.11, 0.11, h - 0.6], pos: [0, 0, 0.18 + (h - 0.6) / 2], material: "iron", segments: st.cylinder_segments, smooth: smooth(st, "smooth"), ops: [{ op: "taper", axis: "z", top: 0.7, bottom: 1 }, { op: "grooves", axis: "z", count: 2, width: 0.02, depth: 0.008, faces: "ring" }] }),
      P({ name: "Lantern", role: "primary", shape: "box", size: [0.34 * ex, 0.34 * ex, 0.42], pos: [0, 0, h - 0.42 + 0.21 - 0.15], material: "iron", bevel: bevel([0.34, 0.34, 0.42], 0.08, st, 1), ops: [{ op: "inset", faces: "sides", thickness: 0.03, depth: -0.012 }, { op: "taper", axis: "z", top: 1.1, bottom: 0.8 }] }),
      P({ name: "Panes", role: "secondary", shape: "box", size: [0.3 * ex, 0.3 * ex, 0.34], pos: [0, 0, h - 0.42 + 0.21 - 0.15], material: "glass", smooth: "flat", can_collide: false, collision: "none" }),
      P({ name: "Bulb", role: "tertiary", shape: "sphere", size: [0.12, 0.12, 0.12], pos: [0, 0, h - 0.42 + 0.21 - 0.15], material: "light", segments: st.facet ? 8 : 16, smooth: smooth(st, "smooth"), can_collide: false, collision: "none" }),
      P({ name: "Cap", role: "tertiary", shape: "cone", size: [0.44 * ex, 0.44 * ex, 0.22], pos: [0, 0, h - 0.11 + 0.04], material: "iron", segments: st.facet ? 6 : 12, smooth: smooth(st, "auto") }),
    ];
    return { dims: [0.44 * ex, 0.44 * ex, h + 0.04], parts, materials: mats, origin: "bottom", attachments: [{ name: "LightAttachment", pos: [0, 0, h - 0.36] }], notes: "tapered base and pole, inset lantern panels, separate glass + emissive bulb (no collision), conical cap" };
  };

  RECIPES.pillar = (o, st) => {
    const h = o.height || 3.0, r = (o.radius || 0.22) * st.exaggerate;
    const mats = { stone: material("stone", "stone", o.primary || [0.7, 0.68, 0.62], st), trim: material("trim", "stone", o.secondary || [0.6, 0.58, 0.52], st) };
    const parts = [P({ name: "Shaft", role: "primary", shape: "cylinder", size: [r * 2, r * 2, h - 0.5], pos: [0, 0, 0.25 + (h - 0.5) / 2], material: "stone", segments: st.cylinder_segments, smooth: smooth(st, "auto"), ops: [{ op: "taper", axis: "z", top: 0.85, bottom: 1 }, { op: "grooves", axis: "z", count: st.detail >= 0.5 ? 12 : 0, width: r * 0.22, depth: r * 0.12, faces: "ring_vertical" }] }), P({ name: "Plinth", role: "secondary", shape: "box", size: [r * 3.2, r * 3.2, 0.25], pos: [0, 0, 0.125], material: "trim", bevel: bevel([r * 3.2, r * 3.2, 0.25], 0.15, st) }), P({ name: "Capital", role: "secondary", shape: "box", size: [r * 3.0, r * 3.0, 0.25], pos: [0, 0, h - 0.125], material: "trim", bevel: bevel([r * 3, r * 3, 0.25], 0.15, st), ops: [{ op: "taper", axis: "z", top: 1, bottom: 0.72 }] }), P({ name: "Torus", role: "tertiary", shape: "torus", size: [r * 2.3, r * 2.3, r * 0.5], pos: [0, 0, 0.25 + 0.08], material: "trim", segments: st.cylinder_segments, smooth: smooth(st, "smooth") })];
    return { dims: [r * 3.2, r * 3.2, h], parts, materials: mats, origin: "bottom", attachments: [], notes: "entasis taper, fluting only above medium detail, plinth / torus / capital" };
  };

  // Modular kit: 4 m wide, 3 m tall, 0.3 m thick, origin at bottom-centre of the
  // wall line so pieces snap on a 4 m grid without gaps.
  function kitMats(o, st) { return { wall: material("wall", o.family_wall || "stone", o.primary || [0.72, 0.7, 0.64], st), trim: material("trim", "wood", o.secondary || [0.35, 0.24, 0.13], st), glass: material("glass", "glass", [0.7, 0.8, 0.85], st), metal: material("metal", "dark_steel", [0.15, 0.15, 0.17], st) }; }
  const KIT = { w: 4, h: 3, t: 0.3 };
  RECIPES.wall_module = (o, st) => {
    const { w, h, t } = KIT;
    const parts = [P({ name: "Wall", role: "primary", shape: "box", size: [w, t, h], pos: [0, 0, h / 2], material: "wall", bevel: bevel([w, t, h], 0.01, st, 1), smooth: "flat", collision: "box" }), P({ name: "Plinth", role: "secondary", shape: "box", size: [w, t + 0.08, 0.25], pos: [0, 0, 0.125], material: "trim", bevel: bevel([w, t, 0.25], 0.1, st, 1) }), P({ name: "Cornice", role: "secondary", shape: "box", size: [w, t + 0.12, 0.18], pos: [0, 0, h - 0.09], material: "trim", bevel: bevel([w, t, 0.18], 0.15, st, 1) })];
    if (st.detail >= 0.5) parts.push(P({ name: "Beam", role: "tertiary", shape: "box", size: [0.14, t + 0.04, h - 0.43], pos: [-w / 2 + 0.07, 0, 0.25 + (h - 0.43) / 2], material: "trim", mirror: "x" }));
    return { dims: [w, t + 0.12, h], parts, materials: kitMats(o, st), origin: "bottom", attachments: [{ name: "SnapLeft", pos: [-w / 2, 0, 0] }, { name: "SnapRight", pos: [w / 2, 0, 0] }], notes: "4 m grid kit piece: wall + plinth + cornice; snap attachments at both ends", kit: KIT };
  };
  RECIPES.door_module = (o, st) => {
    const { w, h, t } = KIT, dw = 1.0, dh = 2.1;
    const base = RECIPES.wall_module(o, st);
    base.parts[0].ops = [{ op: "cut", shape: "box", size: [dw, t * 2, dh], pos: [0, 0, -h / 2 + dh / 2] }];
    base.parts.push(P({ name: "Frame", role: "secondary", shape: "box", size: [dw + 0.2, t * 0.5, dh + 0.1], pos: [0, 0, (dh + 0.1) / 2], material: "trim", bevel: bevel([dw, t * 0.5, dh], 0.08, st, 1), ops: [{ op: "cut", shape: "box", size: [dw, t, dh], pos: [0, 0, -0.05] }] }), P({ name: "Door", role: "primary", shape: "box", size: [dw - 0.02, 0.05, dh - 0.02], pos: [0, t * 0.15, dh / 2], material: "trim", bevel: bevel([dw, 0.05, dh], 0.25, st), ops: [{ op: "inset", faces: "y", thickness: 0.08, depth: -0.012 }, { op: "grooves", axis: "z", count: 1, width: 0.03, depth: 0.01, faces: "y" }] }), P({ name: "Handle", role: "tertiary", shape: "cylinder", size: [0.03, 0.03, 0.12], pos: [dw * 0.38, t * 0.15 + 0.05, 1.05], rot: [90, 0, 0], material: "metal", segments: st.facet ? 8 : 16, smooth: smooth(st, "smooth") }));
    base.attachments.push({ name: "DoorHinge", pos: [-dw / 2, t * 0.15, dh / 2] });
    base.notes = "wall module with a 1.0 x 2.1 m boolean opening, frame, panelled door (separate part, hinge attachment), handle";
    return base;
  };
  RECIPES.window_module = (o, st) => {
    const { w, h, t } = KIT, ww = 1.4, wh = 1.2, sill = 1.0;
    const base = RECIPES.wall_module(o, st);
    base.parts[0].ops = [{ op: "cut", shape: "box", size: [ww, t * 2, wh], pos: [0, 0, -h / 2 + sill + wh / 2] }];
    base.parts.push(P({ name: "Frame", role: "secondary", shape: "box", size: [ww + 0.16, t * 0.6, wh + 0.16], pos: [0, 0, sill + wh / 2], material: "trim", bevel: bevel([ww, t * 0.6, wh], 0.1, st, 1), ops: [{ op: "cut", shape: "box", size: [ww, t, wh], pos: [0, 0, 0] }] }), P({ name: "Mullion", role: "tertiary", shape: "box", size: [0.06, t * 0.4, wh], pos: [0, 0, sill + wh / 2], material: "trim" }), P({ name: "Transom", role: "tertiary", shape: "box", size: [ww, t * 0.4, 0.06], pos: [0, 0, sill + wh / 2], material: "trim" }), P({ name: "Glass", role: "secondary", shape: "box", size: [ww, 0.02, wh], pos: [0, 0, sill + wh / 2], material: "glass", smooth: "flat", can_collide: true, collision: "box" }), P({ name: "Sill", role: "tertiary", shape: "box", size: [ww + 0.3, t + 0.16, 0.08], pos: [0, 0, sill - 0.04], material: "trim", bevel: bevel([ww, t, 0.08], 0.15, st, 1) }));
    base.notes = "wall module with a 1.4 x 1.2 m opening, frame, mullion + transom, glass pane, sill";
    return base;
  };

  RECIPES.rock = (o, st) => {
    const s = o.size || 1.2, ex = st.exaggerate;
    const mats = { rock: material("rock", "stone", o.primary || [0.42, 0.4, 0.37], st), moss: material("moss", "foliage", o.accent || [0.3, 0.42, 0.2], st) };
    const parts = [P({ name: "Rock", role: "primary", shape: "ico", size: [s, s * 0.8, s * 0.65 * ex], pos: [0, 0, s * 0.65 * ex * 0.47], material: "rock", subdivisions: st.facet ? 1 : 2, smooth: st.facet ? "flat" : "auto", ops: [{ op: "displace", strength: s * 0.12, scale: s * 0.9, detail: st.facet ? 1 : 2, seed: o.seed || 3 }, { op: "flatten_bottom", level: 0.08 }, { op: "decimate", ratio: st.facet ? 0.5 : 0.7 }] })];
    if (st.detail >= 0.5) parts.push(P({ name: "Chip", role: "secondary", shape: "ico", size: [s * 0.38, s * 0.32, s * 0.25], pos: [s * 0.42, s * 0.2, s * 0.1], rot: [0, 0, 35], material: "rock", subdivisions: 1, smooth: st.facet ? "flat" : "auto", ops: [{ op: "displace", strength: s * 0.05, scale: s * 0.5, detail: 1, seed: (o.seed || 3) + 1 }, { op: "flatten_bottom", level: 0.1 }] }));
    return { dims: [s * 1.4, s, s * 0.65 * ex], parts, materials: mats, origin: "bottom", attachments: [], notes: "icosphere with low-frequency noise displacement (strength 12 % of size - no vertex spaghetti), flattened contact face, decimated to budget; a second chip breaks the symmetry" };
  };

  RECIPES.tree = (o, st) => {
    const h = o.height || 5.0, ex = st.exaggerate, trunkR = h * 0.035;
    const mats = { bark: material("bark", "bark", o.secondary || [0.35, 0.24, 0.14], st), leaves: material("leaves", "foliage", o.primary || [0.22, 0.48, 0.2], st) };
    const parts = [P({ name: "Trunk", role: "primary", shape: "cylinder", size: [trunkR * 2, trunkR * 2, h * 0.45], pos: [0, 0, h * 0.225], material: "bark", segments: st.facet ? 7 : 12, smooth: st.facet ? "flat" : "smooth", ops: [{ op: "taper", axis: "z", top: 0.55, bottom: 1.25 }, { op: "displace", strength: trunkR * 0.25, scale: h * 0.3, detail: 1, seed: 7 }] })];
    const canopy = [[0, 0, h * 0.68, 0.46], [h * 0.14, h * 0.05, h * 0.55, 0.3 * ex], [-h * 0.12, -h * 0.08, h * 0.58, 0.28 * ex], [0.02, h * 0.13, h * 0.5, 0.24]];
    canopy.forEach(([x, y, z, r], i) => parts.push(P({ name: "Canopy" + (i + 1), role: i === 0 ? "primary" : "secondary", shape: "ico", size: [h * r, h * r * 0.95, h * r * 0.8], pos: [x, y, z], rot: [0, 0, i * 37], material: "leaves", subdivisions: st.facet ? 1 : 2, smooth: st.facet ? "flat" : "auto", ops: [{ op: "displace", strength: h * r * 0.08, scale: h * r * 0.6, detail: 1, seed: 11 + i }, { op: "decimate", ratio: st.facet ? 0.5 : 0.75 }] })));
    if (st.detail >= 0.5) parts.push(P({ name: "Branch", role: "tertiary", shape: "cylinder", size: [trunkR * 0.7, trunkR * 0.7, h * 0.22], pos: [h * 0.08, h * 0.03, h * 0.5], rot: [0, 55, 20], material: "bark", segments: st.facet ? 6 : 8, smooth: st.facet ? "flat" : "smooth", ops: [{ op: "taper", axis: "z", top: 0.5, bottom: 1 }] }));
    return { dims: [h * 0.7, h * 0.7, h * 0.9], parts, materials: mats, origin: "bottom", attachments: [], notes: "flared, tapered trunk; four offset canopy masses of different radii and rotation (no repeated sphere), one visible branch above medium detail" };
  };

  RECIPES.car = (o, st) => {
    const L = o.length || 4.2, W = 1.8, ex = st.exaggerate, wheelR = 0.33 * ex;
    const mats = { paint: material("paint", "painted_metal", o.primary || [0.75, 0.12, 0.1], st, { roughness: 0.25 }), glass: material("glass", "glass", [0.4, 0.55, 0.65], st), tyre: material("tyre", "rubber", [0.06, 0.06, 0.06], st), rim: material("rim", "chrome", [0.8, 0.8, 0.82], st), trim: material("trim", "dark_steel", [0.1, 0.1, 0.11], st), lamp: material("lamp", "energy", [1, 0.9, 0.7], st, { emission_strength: 3 }) };
    const bodyZ = wheelR * 0.9;
    const parts = [
      P({ name: "Body", role: "primary", shape: "box", size: [L, W, 0.55], pos: [0, 0, bodyZ + 0.275], material: "paint", bevel: bevel([L, W, 0.55], 0.14, st, 3), smooth: smooth(st, "auto"), ops: [{ op: "taper", axis: "z", top: 0.94, bottom: 1 }, { op: "cut", shape: "cylinder", size: [wheelR * 2.3, wheelR * 2.3, W + 0.2], pos: [L * 0.31, 0, -0.275 - wheelR * 0.1], rot: [90, 0, 0], mirror: "x" }] }),
      P({ name: "Cabin", role: "primary", shape: "box", size: [L * 0.48, W * 0.86, 0.5], pos: [-L * 0.05, 0, bodyZ + 0.55 + 0.25], material: "paint", bevel: bevel([L * 0.48, W * 0.86, 0.5], 0.12, st, 3), smooth: smooth(st, "auto"), ops: [{ op: "taper", axis: "z", top: 0.8, bottom: 1 }] }),
      P({ name: "Windows", role: "secondary", shape: "box", size: [L * 0.48 + 0.02, W * 0.86 + 0.02, 0.36], pos: [-L * 0.05, 0, bodyZ + 0.55 + 0.25], material: "glass", smooth: "flat", ops: [{ op: "taper", axis: "z", top: 0.82, bottom: 0.98 }], can_collide: true, collision: "box" }),
      P({ name: "Bumper", role: "secondary", shape: "box", size: [0.12, W * 0.98, 0.16], pos: [L / 2 - 0.02, 0, bodyZ + 0.12], material: "trim", mirror: "x", bevel: bevel([0.12, W, 0.16], 0.3, st) }),
      P({ name: "Headlight", role: "tertiary", shape: "cylinder", size: [0.16, 0.16, 0.05], pos: [L / 2 - 0.01, W * 0.34, bodyZ + 0.36], rot: [0, 90, 0], material: "lamp", segments: st.facet ? 8 : 16, mirror: "y", smooth: smooth(st, "smooth"), can_collide: false, collision: "none" }),
    ];
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sy], i) => { const px = sx * L * 0.31, py = sy * (W / 2 - 0.08); parts.push(P({ name: "Wheel" + ["FL", "FR", "RL", "RR"][i < 2 ? (i === 0 ? 0 : 1) : (i === 2 ? 2 : 3)], role: "secondary", shape: "cylinder", size: [wheelR * 2, wheelR * 2, 0.24], pos: [px, py, wheelR], rot: [90, 0, 0], material: "tyre", segments: st.cylinder_segments, smooth: smooth(st, "smooth"), bevel: bevel([wheelR * 2, wheelR * 2, 0.24], 0.1, st, 2), origin: "center", pivot_group: "Wheel" }), P({ name: "Rim" + ["FL", "FR", "RL", "RR"][i < 2 ? (i === 0 ? 0 : 1) : (i === 2 ? 2 : 3)], role: "tertiary", shape: "cylinder", size: [wheelR * 1.2, wheelR * 1.2, 0.26], pos: [px, py, wheelR], rot: [90, 0, 0], material: "rim", segments: st.facet ? 8 : 16, smooth: smooth(st, "smooth"), ops: [{ op: "inset", faces: "caps", thickness: wheelR * 0.15, depth: -0.03 }], can_collide: false, collision: "none" })); });
    return { dims: [L, W, bodyZ + 0.55 + 0.5], parts, materials: mats, origin: "bottom", attachments: [{ name: "DriverSeat", pos: [-L * 0.02, W * 0.22, bodyZ + 0.5] }].concat(["FL", "FR", "RL", "RR"].map((k, i) => ({ name: "Wheel" + k + "Attachment", pos: [(i < 2 ? 1 : -1) * L * 0.31, (i % 2 === 0 ? 1 : -1) * (W / 2 - 0.08), wheelR] }))), notes: "body + cabin primary with tapered sides and boolean wheel arches; wheels keep their own centre pivot for spinning; glass / lamps are separate non-colliding parts" };
  };


  // ── Procedural generators (1.99.1): shape "generator" parts are built by tools/blender_asset.py
  // from a seed - same seed, same asset. pos of a generator part is its BASE point (ground
  // contact / trunk foot), not its centre; the validator knows.
  const GENERATORS = ["tree_branches", "canopy_cluster", "terrain", "rock_cluster", "crystal_cluster", "stairs"];
  const G = (o) => Object.assign({ shape: "generator", pos: [0, 0, 0], smooth: "auto" }, o);

  RECIPES.tree_procedural = (o, st) => {
    const h = o.height || 6.0, ex = st.exaggerate, seed = o.seed || 3;
    const levels = st.detail >= 0.8 ? 4 : st.detail >= 0.5 ? 3 : 2, branches = st.facet || levels === 4 ? 2 : 3;
    const trunkD = r3(h * 0.07 * ex), skelH = r3(h * 0.85);
    const skel = { seed, levels, branches, spread: 38, trunk_ratio: 0.45, length_ratio: 0.62, tree_height: skelH, tree_width: r3(h * 0.6) };
    const mats = { bark: material("bark", "bark", o.secondary || [0.33, 0.22, 0.13], st, { texture_scale: 0.5 }), leaves: material("leaves", "foliage", o.primary || [0.2, 0.46, 0.18], st, { texture_scale: 0.7 }) };
    const parts = [
      P(G({ name: "Trunk", role: "primary", generator: Object.assign({ kind: "tree_branches" }, skel), size: [trunkD, trunkD, skelH], material: "bark", segments: st.facet ? 5 : 8, smooth: st.facet ? "flat" : "smooth" })),
      P(G({ name: "Canopy", role: "secondary", generator: Object.assign({ kind: "canopy_cluster", trunk_radius: r3(trunkD / 2), blobs: st.facet ? 8 : 14, leaf_radius: r3(h * 0.14 * ex) }, skel), size: [h * 0.75, h * 0.75, h], material: "leaves", subdivisions: st.facet ? 1 : 2, smooth: st.facet ? "flat" : "auto", ops: [{ op: "displace", strength: r3(h * 0.02), scale: r3(h * 0.2), detail: 2, seed }] })),
    ];
    return { dims: [h * 0.9, h * 0.9, h], parts, materials: mats, origin: "bottom", attachments: [], notes: "recursive branch skeleton (" + levels + " levels x " + branches + " branches, seed " + seed + ") as one tapered tube mesh; leaf blobs sit on the real branch tips of the same skeleton, noise-broken so no two read alike; bark grain + leaf colour variation graphs" };
  };

  RECIPES.terrain_tile = (o, st) => {
    const s = o.size || 24, ex = st.exaggerate, seed = o.seed || 3, fl = o.flags || {};
    const h = r3(s * (fl.steep ? 0.28 : 0.14) * ex), res = st.facet ? 16 : st.detail >= 0.8 ? 40 : 28;
    const mats = { ground: material("ground", "foliage", o.primary || [0.24, 0.45, 0.18], st, { texture_scale: 3 }), rock: material("rock", "stone", o.secondary || [0.42, 0.4, 0.37], st, { texture_scale: 1.5 }) };
    const parts = [P(G({ name: "Ground", role: "primary", generator: { kind: "terrain", seed, resolution: res, octaves: st.facet ? 3 : 4, frequency: fl.steep ? 2.4 : 1.6, falloff: fl.island ? "island" : "none", plateau: fl.mesa ? 0.6 : 0, skirt: true }, size: [s, s, h], material: "ground", smooth: st.facet ? "flat" : "smooth" }))];
    if (st.detail >= 0.5) parts.push(P(G({ name: "Rocks", role: "secondary", generator: { kind: "rock_cluster", seed: seed + 1, count: st.detail >= 0.8 ? 7 : 4 }, size: [s * 0.45, s * 0.4, h * 0.9], pos: [s * 0.18, -s * 0.12, h * 0.25], material: "rock", subdivisions: st.facet ? 1 : 2, smooth: st.facet ? "flat" : "auto" })));
    return { dims: [s, s, h * 1.15], parts, materials: mats, origin: "bottom", attachments: [], notes: "fBm heightfield (" + res + "x" + res + ", " + (st.facet ? 3 : 4) + " octaves, seed " + seed + (fl.island ? ", island falloff" : "") + (fl.mesa ? ", mesa plateau" : "") + ") closed with a skirt so Studio gets a solid tile; rocks are sunk to a quarter of the height so they always meet the surface" };
  };

  RECIPES.rock_cluster = (o, st) => {
    const s = o.size || 2.0, ex = st.exaggerate, seed = o.seed || 3;
    const mats = { rock: material("rock", "stone", o.primary || [0.42, 0.4, 0.37], st, { texture_scale: s * 0.6 }) };
    const parts = [P(G({ name: "Rocks", role: "primary", generator: { kind: "rock_cluster", seed, count: st.detail >= 0.8 ? 9 : st.detail >= 0.5 ? 6 : 4 }, size: [s * 1.6, s * 1.3, s * 0.7 * ex], material: "rock", subdivisions: st.facet ? 1 : 2, smooth: st.facet ? "flat" : "auto" }))];
    return { dims: [s * 1.6, s * 1.3, s * 0.7 * ex], parts, materials: mats, origin: "bottom", attachments: [], notes: "one hero boulder + satellites scattered in the footprint, each noise-displaced with its own seed and buried to a flat contact; one mesh, one material" };
  };

  RECIPES.crystal_cluster = (o, st) => {
    const s = o.size || 1.2, ex = st.exaggerate, seed = o.seed || 3;
    const mats = { crystal: material("crystal", "crystal", o.accent || o.primary || [0.4, 0.75, 0.95], st), rock: material("rock", "stone", o.secondary || [0.3, 0.28, 0.27], st) };
    const parts = [
      P({ name: "Base", role: "secondary", shape: "ico", size: [s * 0.9, s * 0.8, s * 0.3], pos: [0, 0, s * 0.12], material: "rock", subdivisions: st.facet ? 1 : 2, smooth: st.facet ? "flat" : "auto", ops: [{ op: "displace", strength: r3(s * 0.04), scale: r3(s * 0.5), detail: 2, seed }, { op: "flatten_bottom", height: 0.3 }] }),
      P(G({ name: "Crystals", role: "primary", generator: { kind: "crystal_cluster", seed, count: st.detail >= 0.8 ? 9 : st.detail >= 0.5 ? 7 : 5, sides: st.facet ? 5 : 6, thickness: 0.16 * ex }, size: [s * 0.8, s * 0.7, s], pos: [0, 0, s * 0.12], material: "crystal", smooth: "flat" })),
    ];
    return { dims: [s * 0.9, s * 0.8, s * 1.12], parts, materials: mats, origin: "bottom", attachments: [], notes: "tallest shard upright in the middle, satellites tilted 8-28 deg around it, all rooted in a displaced rock base; crystal family = transmission + faint emission (Roblox: Glass, emission lost)" };
  };

  RECIPES.stairs = (o, st) => {
    const w = o.width || 1.2, ex = st.exaggerate, steps = st.detail >= 0.8 ? 12 : st.detail >= 0.5 ? 10 : 8, rise = 0.17 * ex, run = 0.28;
    const sy = r3(steps * run), sz = r3(steps * rise);
    const fam = st.label && /sci/i.test(st.label) ? "painted_metal" : (/cartoon|low/i.test(st.label || "") ? "plaster" : "stone");
    const mats = { step: material("step", fam, o.primary || [0.6, 0.58, 0.54], st), rail: material("rail", "dark_steel", o.secondary || [0.12, 0.12, 0.14], st) };
    const parts = [P(G({ name: "Steps", role: "primary", generator: { kind: "stairs", steps, nosing: st.detail >= 0.6 ? 0.02 : 0 }, size: [w, sy, sz], material: "step", smooth: "flat", bevel: bevel([w, run, rise], 0.08, st, 1) }))];
    if (st.detail >= 0.5) {
      parts.push(P({ name: "PostsL", role: "tertiary", shape: "box", size: [0.04, 0.04, 0.9], pos: [-w / 2 + 0.03, run / 2, rise + 0.45], material: "rail", array: { count: steps, offset: [0, run, rise] } }));
      parts.push(P({ name: "PostsR", role: "tertiary", shape: "box", size: [0.04, 0.04, 0.9], pos: [w / 2 - 0.03, run / 2, rise + 0.45], material: "rail", array: { count: steps, offset: [0, run, rise] } }));
    }
    return { dims: [w, sy, st.detail >= 0.5 ? sz + 0.9 : sz], parts, materials: mats, origin: "bottom", attachments: [], notes: steps + " steps, rise " + r3(rise) + " m / run " + run + " m (comfortable 2R+G), one solid manifold profile mesh; balusters climb with an Array offset of exactly one step" };
  };

  RECIPES.building = (o, st) => {
    const h = o.height || 9, ex = st.exaggerate, floors = clamp(Math.round(h / 3.1), 1, 6), fh = r3(h / floors);
    const w = o.width || clamp(h * 0.9, 4, 14), d = r3(w * 0.75);
    let bays = clamp(Math.round(w / 2.2), 1, 5);
    while (floors * bays > 20) bays--;
    const wallFam = /sci/i.test(st.label || "") ? "painted_metal" : /real/i.test(st.label || "") ? "brick" : /fantasy/i.test(st.label || "") ? "stone" : /horror/i.test(st.label || "") ? "concrete" : "plaster";
    const mats = { wall: material("wall", wallFam, o.primary || [0.7, 0.66, 0.58], st, { texture_scale: 2 }), roof: material("roof", floors <= 2 ? "planks" : "dark_steel", o.secondary || (floors <= 2 ? [0.38, 0.2, 0.14] : [0.16, 0.17, 0.19]), st), trim: material("trim", "wood", o.accent || [0.3, 0.2, 0.12], st) };
    const cuts = [];
    const ww = r3(Math.min(1.2, (w / bays) * 0.5 * ex)), wh = r3(fh * 0.45);
    for (let f = 0; f < floors; f++) for (let b = 0; b < bays; b++) {
      const x = r3(-w / 2 + (b + 0.5) * (w / bays)), door = f === 0 && b === Math.floor(bays / 2);
      cuts.push({ op: "cut", shape: "box", size: door ? [1.1, 0.5, 2.2] : [ww, 0.5, wh], pos: [x, r3(-d / 2), door ? 1.1 : r3(f * fh + fh * 0.55 - h / 2)], mirror: door ? undefined : "y" });
    }
    // cut positions are relative to the part centre (pos z = h/2): shift the door too
    for (const c of cuts) if (c.size[2] === 2.2) c.pos[2] = r3(1.1 - h / 2);
    const parts = [
      P({ name: "Body", role: "primary", shape: "box", size: [w, d, h], pos: [0, 0, h / 2], material: "wall", bevel: bevel([w, d, h], 0.004, st, 1), ops: cuts }),
      P({ name: "Plinth", role: "tertiary", shape: "box", size: [w * 1.04, d * 1.04, 0.3], pos: [0, 0, 0.15], material: "trim", bevel: bevel([w, d, 0.3], 0.1, st, 1) }),
    ];
    if (floors <= 2) {
      parts.push(P({ name: "Roof", role: "secondary", shape: "cone", size: [w * 1.15, d * 1.15, h * 0.28], pos: [0, 0, h + h * 0.14], rot: [0, 0, 45], material: "roof", segments: 4, smooth: "flat" }));
      if (st.detail >= 0.5) parts.push(P({ name: "Chimney", role: "tertiary", shape: "box", size: [0.6, 0.6, h * 0.32], pos: [w * 0.3, d * 0.2, h + h * 0.1], material: "wall" }));
    } else {
      parts.push(P({ name: "Roof", role: "secondary", shape: "box", size: [w * 1.05, d * 1.05, 0.3], pos: [0, 0, h + 0.15], material: "roof", bevel: bevel([w, d, 0.3], 0.1, st, 1) }));
      if (st.detail >= 0.5) parts.push(P({ name: "Parapet", role: "tertiary", shape: "box", size: [w * 0.3, d * 0.3, 0.9], pos: [w * 0.25, -d * 0.2, h + 0.75], material: "wall" }));
    }
    if (st.detail >= 0.5) parts.push(P({ name: "DoorFrame", role: "tertiary", shape: "box", size: [1.3, 0.12, 2.35], pos: [0, -d / 2 - 0.02, 1.17], material: "trim", bevel: bevel([1.3, 0.12, 2.35], 0.2, st, 1) }));
    return { dims: [w * 1.15, d * 1.15, h * 1.3], parts, materials: mats, origin: "bottom", attachments: [], notes: floors + " floors x " + bays + " bays = " + cuts.length + " recessed openings cut through front and back (mirror y), door in the middle bay, " + (floors <= 2 ? "pyramid roof + chimney" : "flat roof + parapet") + "; " + wallFam + " wall graph at 2 m tiling" };
  };

  RECIPES.fence = (o, st) => {
    const L = o.length || 6, ex = st.exaggerate, n = clamp(Math.round(L / 1.5) + 1, 2, 10), spacing = r3(L / (n - 1));
    const fam = /sci/i.test(st.label || "") ? "painted_metal" : "planks";
    const mats = { wood: material("wood", fam, o.primary || [0.5, 0.36, 0.2], st, { texture_scale: 0.6 }) };
    const pH = 1.2 * ex;
    const parts = [
      P({ name: "Posts", role: "primary", shape: "box", size: [0.1, 0.1, pH], pos: [-L / 2, -0.04, pH / 2], material: "wood", bevel: bevel([0.1, 0.1, pH], 0.15, st, 1), array: { count: n, offset: [spacing, 0, 0] } }),
      P({ name: "RailTop", role: "secondary", shape: "box", size: [L, 0.05, 0.12], pos: [0, 0.03, pH * 0.82], material: "wood", bevel: bevel([L, 0.05, 0.12], 0.2, st, 1) }),
      P({ name: "RailBottom", role: "secondary", shape: "box", size: [L, 0.05, 0.12], pos: [0, 0.03, pH * 0.35], material: "wood", bevel: bevel([L, 0.05, 0.12], 0.2, st, 1) }),
    ];
    if (st.detail >= 0.5) { const pk = Math.max(2, Math.round(L / 0.18)); parts.push(P({ name: "Pickets", role: "tertiary", shape: "box", size: [0.08, 0.03, pH * 0.85], pos: [-L / 2 + 0.09, 0.07, pH * 0.5], material: "wood", array: { count: pk, offset: [r3((L - 0.18) / (pk - 1)), 0, 0] } })); }
    return { dims: [L + 0.1, 0.18, pH], parts, materials: mats, origin: "bottom", attachments: [], notes: n + " posts every " + spacing + " m (Array), two rails, " + (st.detail >= 0.5 ? "pickets" : "no pickets") + " - stretch by changing length, the arrays follow" };
  };

  const RECIPE_CATEGORY = { sword: "weapon", blaster: "weapon", crate: "prop", barrel: "prop", table: "furniture", chair: "furniture", lamp_post: "prop", pillar: "building_module", wall_module: "building_module", door_module: "building_module", window_module: "building_module", rock: "organic", tree: "organic", car: "vehicle", tree_procedural: "organic", terrain_tile: "environment", rock_cluster: "organic", crystal_cluster: "prop", stairs: "building_module", building: "building", fence: "prop" };
  const RECIPE_WORDS = [["crystal_cluster", /crystal|gem ?cluster|shards?\b|geode/i], ["terrain_tile", /terrain|landscape|heightmap|island|hills?\b|mesa|ground tile|valley/i], ["rock_cluster", /boulder field|rock (?:cluster|field|pile|garden)|boulders|rocks\b|scattered rocks/i], ["stairs", /stairs?|staircase|stairway|steps\b/i], ["fence", /fence|railing|picket|palisade/i], ["building", /building|house|tower|apartment|skyscraper|cottage|cabin|hut|shop\b|office block|warehouse/i], ["tree_procedural", /branch|procedural tree|l-?system|dead tree|willow|birch|baobab|big tree|realistic tree/i], ["sword", /sword|blade|katana|sabre|saber|greatsword|dagger/i], ["blaster", /blaster|rifle|gun|pistol|smg|carbine|shotgun|launcher/i], ["crate", /crate|box|chest|container/i], ["barrel", /barrel|keg|drum/i], ["table", /table|desk|workbench/i], ["chair", /chair|stool|seat|throne/i], ["lamp_post", /lamp ?post|street ?light|lantern|lamp/i], ["pillar", /pillar|column|post\b/i], ["door_module", /door/i], ["window_module", /window/i], ["wall_module", /wall|module|kit|fa[cç]ade/i], ["rock", /rock|boulder|stone|cliff/i], ["tree", /tree|oak|pine|bush|shrub/i], ["car", /car\b|vehicle|truck|jeep|buggy|van\b|sedan/i]];

  // ── Brief interpretation ──────────────────────────────────────────────────
  function interpret(brief, opts) {
    const b = String(brief || ""), o = Object.assign({}, opts || {});
    const out = { recipe: o.recipe || null, style: o.style || null, palette: {}, size: {}, seed: num(o.seed, 3) };
    if (!out.recipe) for (const [id, re] of RECIPE_WORDS) if (re.test(b)) { out.recipe = id; break; }
    if (!out.style) for (const [id, re] of STYLE_WORDS) if (re.test(b)) { out.style = id; break; }
    if (!out.style) out.style = out.recipe === "blaster" ? "scifi" : "stylized_fantasy";
    if (/character|humanoid|npc|avatar|creature|monster|person|face|body/i.test(b) && !out.recipe) out.category = "character_part";
    const m = b.match(/(\d+(?:\.\d+)?)\s*(m|meter|metre|cm|studs?)\b/i);
    if (m) { let v = Number(m[1]); const u = m[2].toLowerCase(); if (u === "cm") v /= 100; if (/stud/.test(u)) v /= num(o.studs_per_meter, 3.5); out.size.main = v; }
    const cols = []; for (const k of Object.keys(SWATCH)) if (new RegExp("\\b" + k + "\\b", "i").test(b)) cols.push(k);
    if (cols[0]) out.palette.primary = SWATCH[cols[0]];
    if (cols[1]) out.palette.accent = SWATCH[cols[1]];
    if (/accent|glow|neon|emissive/i.test(b) && cols[1]) out.palette.accent = SWATCH[cols[1]];
    out.flags = { island: /island/i.test(b), mesa: /mesa|plateau|flat[- ]top/i.test(b), steep: /steep|mountain|cliff|jagged/i.test(b) };
    return out;
  }

  function plan(brief, opts) {
    const o = Object.assign({}, opts || {});
    const it = interpret(brief, o);
    const recipeId = it.recipe;
    if (it.category === "character_part" && !recipeId) return { ok: false, error: "unsupported: " + CATEGORIES.character_part.unsupported, category: "character_part" };
    if (!recipeId) return { ok: false, error: "no recipe matches the brief - say what the asset IS (" + Object.keys(RECIPES).join(", ") + ") or pass recipe explicitly; a custom spec can also be passed straight to blender_asset_build {spec}" };
    if (!RECIPES[recipeId]) return { ok: false, error: "unknown recipe " + recipeId + " (" + Object.keys(RECIPES).join(", ") + ")" };
    const styleId = STYLES[it.style] ? it.style : "stylized_fantasy";
    if (o.style && !STYLES[o.style]) return { ok: false, error: "unknown style " + o.style + " (" + Object.keys(STYLES).join(", ") + ")" };
    const st = Object.assign({}, STYLES[styleId]);
    if (o.style2 && STYLES[o.style2]) { const s2 = STYLES[o.style2]; for (const k of Object.keys(st)) if (typeof st[k] === "number") st[k] = (st[k] + s2[k]) / 2; st.hybrid = o.style2; }
    const ro = Object.assign({}, it.palette, o.palette || {}, { seed: it.seed, flags: Object.assign({}, it.flags || {}, o.flags || {}) });
    const main = num(o.size, it.size.main);
    if (main) { ({ sword: "length", blaster: "length", crate: "size", barrel: "height", table: "width", chair: "width", lamp_post: "height", pillar: "height", rock: "size", tree: "height", car: "length", tree_procedural: "height", terrain_tile: "size", rock_cluster: "size", crystal_cluster: "size", stairs: "width", building: "height", fence: "length" }[recipeId] || "size").split(",").forEach((k) => { ro[k] = main; }); }
    if (o.primary) ro.primary = parseColor(o.primary) || ro.primary;
    if (o.accent) ro.accent = parseColor(o.accent) || ro.accent;
    if (o.secondary) ro.secondary = parseColor(o.secondary) || ro.secondary;
    const r = RECIPES[recipeId](ro, st);
    const category = CATEGORIES[RECIPE_CATEGORY[recipeId]];
    const name = (o.name || (recipeId.replace(/_module$/, "").replace(/(^|_)(\w)/g, (_, a, c) => c.toUpperCase()))).replace(/[^A-Za-z0-9_]/g, "");
    const spm = num(o.studs_per_meter, 3.5);
    const budget = { tris: Math.round(category.tris * st.poly_mult), parts: category.parts + 4, materials: category.materials };
    const spec = {
      version: VERSION, name, brief: String(brief || ""), recipe: recipeId, category: RECIPE_CATEGORY[recipeId], style: styleId, style_profile: st, studs_per_meter: spm,
      dims: vec(r.dims), origin: r.origin || category.origin, origin_pos: r.origin_pos ? vec(r.origin_pos) : null, collision: o.collision || category.collision,
      materials: r.materials, parts: r.parts.map((p) => { const q = Object.assign({}, p); q.size = vec(q.size); q.pos = vec(q.pos); if (q.collision === "inherit") q.collision = o.collision || category.collision; if (q.can_collide === null) q.can_collide = q.collision !== "none"; if (st.facet) { q.smooth = "flat"; q.bevel = null; } return q; }),
      attachments: (r.attachments || []).map((a) => ({ name: a.name, pos: vec(a.pos) })), budget, uv: o.uv !== false, kit: r.kit || null, notes: r.notes,
      inspect: { views: ["front", "side", "top", "iso"], size: 640 },
    };
    const v = validate(spec);
    return { ok: v.errors === 0, spec, validation: v, summary: summary(spec) };
  }

  function parseColor(v) {
    if (Array.isArray(v) && v.length >= 3) { const a = v.slice(0, 3).map(Number); if (a.every(Number.isFinite)) return a.map((x) => (x > 1 ? x / 255 : x)); }
    if (typeof v === "string") { const s = v.trim().toLowerCase(); if (SWATCH[s]) return SWATCH[s]; const h = s.replace("#", ""); if (/^[0-9a-f]{6}$/.test(h)) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); }
    return null;
  }

  // ── Structural validation of a spec (JS side - before Blender runs) ───────
  const SHAPES = ["box", "cylinder", "sphere", "cone", "torus", "ico", "generator"];
  const OPS = ["inset", "cut", "taper", "grooves", "displace", "flatten_bottom", "decimate", "bulge"];
  function validate(spec) {
    const issues = [];
    let estTris = 0;
    const add = (level, code, msg, part) => issues.push({ level, code, msg, part: part || null });
    if (!spec || typeof spec !== "object") { add("error", "spec", "spec must be an object"); return finish(); }
    if (!spec.name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(String(spec.name))) add("error", "name", "spec.name must be an identifier (letters, digits, underscore)");
    if (!Array.isArray(spec.parts) || !spec.parts.length) add("error", "parts", "spec.parts must be a non-empty array");
    const mats = spec.materials && typeof spec.materials === "object" ? spec.materials : {};
    if (!Object.keys(mats).length) add("error", "materials", "spec.materials is empty - every part needs a material with colour / metallic / roughness");
    for (const [id, m] of Object.entries(mats)) {
      if (!Array.isArray(m.color) || m.color.length < 3) add("error", "material-color", "material " + id + ": color must be [r, g, b] 0..1");
      if (m.roblox && !/^[A-Z][A-Za-z]+$/.test(String(m.roblox))) add("error", "material-roblox", "material " + id + ": roblox must be an Enum.Material name");
      if (m.alpha != null && (m.alpha < 0 || m.alpha > 1)) add("error", "material-alpha", "material " + id + ": alpha out of 0..1");
    }
    const parts = Array.isArray(spec.parts) ? spec.parts : [];
    const names = new Set(), bevels = [], roles = { primary: 0, secondary: 0, tertiary: 0 };
    const dims = Array.isArray(spec.dims) ? spec.dims : null;
    parts.forEach((p, i) => {
      const tag = "part " + (i + 1) + (p && p.name ? " (" + p.name + ")" : "");
      if (!p || typeof p !== "object") return add("error", "part", tag + ": not an object");
      if (!p.name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(String(p.name))) add("error", "part-name", tag + ": name must be an identifier - no Cube.001 style names");
      else if (names.has(p.name)) add("error", "part-dup", tag + ": duplicate part name"); else names.add(p.name);
      if (!SHAPES.includes(p.shape)) add("error", "part-shape", tag + ": shape must be one of " + SHAPES.join(", "));
      if (p.shape === "generator") {
        const g = p.generator && typeof p.generator === "object" ? p.generator : null;
        if (!g || !GENERATORS.includes(g.kind)) add("error", "generator", tag + ": generator.kind must be one of " + GENERATORS.join(", "));
        else if (g.kind === "terrain" && g.resolution != null && !(g.resolution >= 4 && g.resolution <= 96)) add("error", "generator-res", tag + ": terrain resolution must be 4..96");
        else if (/cluster/.test(g.kind) && g.count != null && !(g.count >= 1 && g.count <= 24)) add("error", "generator-count", tag + ": cluster count must be 1..24");
        else if (g.kind === "tree_branches" || g.kind === "canopy_cluster") { if (g.levels != null && !(g.levels >= 1 && g.levels <= 5)) add("error", "generator-levels", tag + ": levels must be 1..5"); if (g.branches != null && !(g.branches >= 1 && g.branches <= 5)) add("error", "generator-branches", tag + ": branches must be 1..5"); }
        else if (g.kind === "stairs" && g.steps != null && !(g.steps >= 2 && g.steps <= 40)) add("error", "generator-steps", tag + ": steps must be 2..40");
      }
      if (!Array.isArray(p.size) || p.size.length < 3 || !p.size.every((x) => Number.isFinite(Number(x)) && Number(x) > 0)) add("error", "part-size", tag + ": size must be 3 positive numbers (metres)");
      if (!Array.isArray(p.pos) || p.pos.length < 3 || !p.pos.every((x) => Number.isFinite(Number(x)))) add("error", "part-pos", tag + ": pos must be [x, y, z]");
      if (!p.material || !mats[p.material]) add("error", "part-material", tag + ": material '" + p.material + "' is not defined in spec.materials");
      if (p.role && roles[p.role] !== undefined) roles[p.role]++;
      if (p.bevel) {
        const minDim = Array.isArray(p.size) ? Math.min.apply(null, p.size.map(Number)) : 1;
        if (!(p.bevel.width > 0) || p.bevel.width > minDim / 2) add("error", "bevel-width", tag + ": bevel width " + p.bevel.width + " must be > 0 and <= half the smallest dimension (" + r3(minDim / 2) + ")");
        else bevels.push(r3(p.bevel.width));
      }
      for (const op of p.ops || []) {
        if (!OPS.includes(op.op)) add("error", "op", tag + ": unknown op '" + op.op + "' (" + OPS.join(", ") + ")");
        if (op.op === "cut" && (!Array.isArray(op.size) || !SHAPES.includes(op.shape || "box"))) add("error", "op-cut", tag + ": cut needs shape + size");
        if (op.op === "displace" && Array.isArray(p.size) && op.strength > Math.min.apply(null, p.size.map(Number)) * 0.3) add("warning", "displace-noise", tag + ": displace strength > 30 % of the smallest dimension destroys the silhouette");
        if (op.op === "decimate" && !(op.ratio > 0.05 && op.ratio <= 1)) add("error", "op-decimate", tag + ": decimate ratio must be 0.05..1");
      }
      if (dims && Array.isArray(p.size) && Array.isArray(p.pos)) {
        const ext = extents(p);
        for (let a = 0; a < 3; a++) { const half = ext[a] / 2, c = Number(p.pos[a]) + (p.shape === "generator" && a === 2 ? half : 0); const lim = a === 2 ? [-(dims[2] * 0.15), dims[2] * 1.05] : [-(dims[a] / 2) * 1.1, (dims[a] / 2) * 1.1]; if (c + half > lim[1] + 1e-6 || c - half < lim[0] - 1e-6) { add("warning", "bounds", tag + ": extends outside spec.dims on axis " + "xyz"[a]); break; } }
      }
      if (Array.isArray(p.size)) { const seg = Number(p.segments) || 24; const base = p.shape === "box" ? 12 : p.shape === "cylinder" || p.shape === "cone" ? seg * 4 : p.shape === "sphere" ? seg * seg : p.shape === "torus" ? seg * 24 : p.shape === "generator" ? generatorTris(p) : 20 * Math.pow(4, Number(p.subdivisions) || 1); let t = base; if (p.bevel) t *= 1 + (Number(p.bevel.segments) || 2) * 1.5; for (const op of p.ops || []) { if (op.op === "grooves") t += 24 * (Number(op.count) || 1); if (op.op === "cut") t += 40; if (op.op === "inset") t += 12; if (op.op === "decimate") t *= Number(op.ratio) || 1; } if (p.mirror) t *= 2; if (p.array) t *= Number(p.array.count) || 1; estTris += t; }
    });
    if (parts.length && roles.primary === 0) add("error", "roles", "no part has role 'primary' - establish the silhouette before details");
    if (parts.length >= 4 && roles.tertiary === parts.length) add("warning", "roles", "every part is tertiary - the primary form is missing");
    if (bevels.length >= 3 && new Set(bevels).size === 1) add("warning", "bevel-uniform", "every bevelled part uses the same bevel width (" + bevels[0] + ") - scale bevels to the part");
    const budget = spec.budget || {};
    if (budget.tris && estTris > budget.tris * 1.5) add("error", "budget-tris", "estimated " + Math.round(estTris) + " triangles exceed the budget " + budget.tris + " by more than 50 % - lower segments / bevel segments / decimate");
    else if (budget.tris && estTris > budget.tris) add("warning", "budget-tris", "estimated " + Math.round(estTris) + " triangles over the " + budget.tris + " budget");
    if (budget.parts && parts.length > budget.parts) add("warning", "budget-parts", parts.length + " parts exceed the " + budget.parts + " part budget - merge tertiary pieces");
    if (budget.materials && Object.keys(mats).length > budget.materials) add("warning", "budget-materials", Object.keys(mats).length + " materials exceed the budget " + budget.materials);
    if (!Array.isArray(spec.dims) || spec.dims.length < 3) add("error", "dims", "spec.dims [x, y, z] metres is required");
    if (spec.studs_per_meter != null && !(spec.studs_per_meter > 0.5 && spec.studs_per_meter < 100)) add("error", "scale", "studs_per_meter must be 0.5..100");
    for (const a of spec.attachments || []) if (!a.name || !Array.isArray(a.pos)) add("error", "attachment", "attachment needs name + pos");
    return finish();
    function finish() { const errors = issues.filter((i) => i.level === "error").length; return { ok: errors === 0, errors, warnings: issues.length - errors, issues, estimated_tris: Math.round(estTris) }; }
  }

  // triangle estimate of a generator part (mirrors the construction in tools/blender_asset.py)
  function generatorTris(p) {
    const g = p.generator || {}, k = g.kind, sub = Number(p.subdivisions) || 2, ico = 20 * Math.pow(4, Math.max(0, sub - 1));
    const branchCount = () => { const L = Number(g.levels) || 3, B = Number(g.branches) || 3; let n = 0; for (let l = 0; l <= L; l++) n += Math.pow(B, l); return n; };
    if (k === "tree_branches") return branchCount() * 3 * (Number(p.segments) || 8) * 2;
    if (k === "canopy_cluster") return (Number(g.blobs) || 14) * ico;
    if (k === "terrain") { const n = Number(g.resolution) || 24; return n * n * 2 + (g.skirt === false ? 0 : n * 8 + 2); }
    if (k === "rock_cluster") return (Number(g.count) || 6) * ico;
    if (k === "crystal_cluster") return (Number(g.count) || 7) * ((Number(g.sides) || 6) * 3 + 4);
    if (k === "stairs") return (Number(g.steps) || 8) * 8 + 8;
    return 100;
  }

  // world-axis extents of a part: 90-degree rotations swap axes (enough for the recipes' cylinders / tori)
  function extents(p) {
    let e = p.size.map(Number); const rot = Array.isArray(p.rot) ? p.rot.map((d) => Math.round(Number(d) || 0)) : [0, 0, 0];
    const q = (d) => Math.abs(((d % 180) + 180) % 180 - 90) < 15;
    if (q(rot[0])) e = [e[0], e[2], e[1]];
    if (q(rot[1])) e = [e[2], e[1], e[0]];
    if (q(rot[2])) e = [e[1], e[0], e[2]];
    return e;
  }

  function summary(spec) {
    const byRole = { primary: [], secondary: [], tertiary: [] };
    for (const p of spec.parts || []) (byRole[p.role] || byRole.secondary).push(p.name);
    return spec.name + " (" + spec.recipe + ", " + spec.style + (spec.style_profile && spec.style_profile.hybrid ? "+" + spec.style_profile.hybrid : "") + "): " + spec.dims.join(" x ") + " m, " + (spec.parts || []).length + " parts [primary: " + byRole.primary.join(", ") + " | secondary: " + byRole.secondary.join(", ") + " | tertiary: " + byRole.tertiary.join(", ") + "], materials " + Object.keys(spec.materials || {}).map((k) => k + "=" + spec.materials[k].family + "->" + spec.materials[k].roblox).join(", ") + "; budget " + spec.budget.tris + " tris; origin " + spec.origin + "; " + spec.studs_per_meter + " studs/m";
  }

  const api = { VERSION, extents, STYLES, CATEGORIES, FAMILIES, GENERATORS, generatorTris, RECIPES, RECIPE_CATEGORY, RECIPE_WORDS, STYLE_WORDS, SWATCH, interpret, plan, validate, summary, parseColor, material, bevel };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.TotalAssetPlan = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
