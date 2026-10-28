// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript production VFX pack (1.82.0) - spec-driven, staged, self-cleaning
// effect families, layered on RobloxScriptSkills like studio_cutscene.js.
//
// Why (Phase 115 audit): every earlier effect command assembled a handful of
// ParticleEmitters with two-key Size / Transparency sequences and a constant
// Rate, then walked away: fx_create_vfx {effect:"explosion"} is an emitter that
// explodes forever, nothing has an anticipation / burst / dissipate lifecycle,
// nothing is destroyed afterwards, nothing scales with a quality tier and
// gameplay code has no library to call. This pack ships:
//
//   ReplicatedStorage.TotalVFX                ModuleScript - the runtime: TotalVFX.play(family, where, opts)
//                                             returns a handle {Stop, Destroy, Completed}; one Heartbeat
//                                             scheduler drives bursts, streams, lights, rings and beams from
//                                             structured family specs; palettes and tiers are data.
//   ReplicatedStorage.TotalVFX.Replicate      RemoteEvent  - server -> clients (cosmetic effects stay client-side)
//   StarterPlayer.StarterPlayerScripts.TotalVFXClient LocalScript - plays replicated casts
//
// Commands: vfx_library_install, vfx_play (edit-mode preview with auto cleanup),
//           vfx_theme_set, vfx_validate (audits an existing effect tree), vfx_families.
//
// Conventions: JS strings are double-quoted, Luau literals single-quoted
// except q()/lua() output. No raw newline inside a Luau string literal. The
// embedded runtime is plain Lua 5.4 compatible (no `+=`, no `continue`, no
// type annotations) so tests/roblox_sim.py can compile and run it.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const VERSION = "1.82.0";
  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  const num = (v) => { const x = Number(v); return isFinite(x) ? x : null; };
  const ident = (v, d) => { const s = String(v || d || "Effect").replace(/[^A-Za-z0-9_]/g, ""); return /^[A-Za-z_]/.test(s) ? s : "_" + s; };
  // JS value -> Lua table literal (arrays keep order, objects become k = v).
  function lua(v) {
    if (v === null || v === undefined) return "nil";
    if (typeof v === "number") return isFinite(v) ? String(v) : "0";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return q(v);
    if (Array.isArray(v)) return "{" + v.map(lua).join(",") + "}";
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    return "{" + keys.map((k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : "[" + q(k) + "]") + "=" + lua(v[k])).join(",") + "}";
  }

  // ── art direction: palettes are the only place colours live ───────────────
  // roles: primary (body of the effect), secondary (gradient end), accent
  // (hot core / flash), smoke (dark debris). Restrained values on purpose:
  // the accent is the only near-white and it lives in short flashes.
  const PALETTES = {
    ember: { primary: [255, 122, 36], secondary: [255, 196, 84], accent: [255, 236, 196], smoke: [46, 36, 32] },
    frost: { primary: [120, 196, 255], secondary: [196, 232, 255], accent: [240, 250, 255], smoke: [120, 140, 160] },
    arcane: { primary: [150, 90, 255], secondary: [220, 150, 255], accent: [250, 230, 255], smoke: [40, 30, 60] },
    holy: { primary: [255, 222, 120], secondary: [255, 246, 200], accent: [255, 255, 240], smoke: [200, 190, 160] },
    void: { primary: [90, 40, 140], secondary: [150, 60, 200], accent: [230, 200, 255], smoke: [15, 10, 25] },
    nature: { primary: [120, 200, 90], secondary: [200, 240, 140], accent: [240, 255, 220], smoke: [60, 70, 50] },
    toxic: { primary: [150, 230, 60], secondary: [220, 255, 120], accent: [240, 255, 200], smoke: [50, 70, 30] },
    electric: { primary: [120, 200, 255], secondary: [220, 240, 255], accent: [255, 255, 255], smoke: [60, 70, 90] },
    steel: { primary: [220, 220, 230], secondary: [255, 230, 180], accent: [255, 255, 255], smoke: [70, 70, 75] },
    blood: { primary: [180, 30, 40], secondary: [240, 90, 90], accent: [255, 200, 200], smoke: [50, 20, 20] },
    dust: { primary: [190, 170, 140], secondary: [220, 205, 180], accent: [240, 232, 215], smoke: [150, 135, 110] },
  };
  // Genre -> default palette (vfx_theme_set {genre}) so a project stays cohesive.
  const GENRE_PALETTE = { fantasy: "arcane", medieval: "ember", scifi: "electric", cyberpunk: "electric", horror: "void", cozy: "holy", nature: "nature", desert: "dust", winter: "frost", tropical: "nature", city: "steel", cartoon: "holy", simulator: "holy", obby: "electric", candy: "holy", anime: "arcane", military: "steel", pirate: "ember" };

  // ── quality tiers: budgets, not adjectives ────────────────────────────────
  // particles = multiplier on burst counts / stream rates; maxEmitters = emitters
  // per effect (lower-priority layers are dropped first); maxActive = live
  // effects before the oldest is destroyed; lights / rings can be disabled.
  const TIERS = {
    High: { particles: 1, maxEmitters: 6, maxActive: 14, lights: true, rings: true, beams: true },
    Medium: { particles: 0.6, maxEmitters: 4, maxActive: 9, lights: true, rings: true, beams: true },
    Low: { particles: 0.35, maxEmitters: 2, maxActive: 5, lights: false, rings: false, beams: true },
  };

  // ── family specs ──────────────────────────────────────────────────────────
  // layer kinds: burst (Emit once at t), stream (Rate from t for dur), flash
  // (point light peak -> 0 over life), light (steady light for dur), ring
  // (expanding flat cylinder, size/transparency over life), beam (arc between
  // two offsets; jitter > 0 = electric), trail (needs a host part), shell
  // (translucent ForceField sphere for dur), sound (TotalSFX event by name).
  // Curves are keypoint lists [[t, v], ...] (3+ keys for anything that should
  // read as motion). color = role or [roleA, roleB] gradient. orient = "normal"
  // emits along the effect normal, "up" along world up, "radial" everywhere.
  // priority 1 = must keep, 3 = first to drop on a low tier.
  const FAMILIES = {
    impact: { duration: 0.55, palette: "steel", desc: "melee / bullet hit: flash, directional sparks, dust puff, shock ring", layers: [
      { kind: "flash", t: 0, life: 0.14, brightness: 5, range: 12, color: "accent", priority: 2 },
      { kind: "burst", t: 0, texture: "spark", count: 14, speed: [10, 20], life: [0.18, 0.4], size: [[0, 0.3], [0.2, 0.45], [1, 0]], transparency: [[0, 0], [0.6, 0.15], [1, 1]], spread: [40, 40], drag: 5, orient: "normal", color: ["accent", "primary"], lightEmission: 1, priority: 1 },
      { kind: "burst", t: 0.02, texture: "smoke", count: 5, speed: [3, 6], life: [0.5, 0.9], size: [[0, 0.8], [0.5, 1.8], [1, 2.4]], transparency: [[0, 0.5], [0.4, 0.7], [1, 1]], spread: [60, 60], orient: "normal", color: "smoke", rotSpeed: [-60, 60], priority: 3 },
      { kind: "ring", t: 0, life: 0.3, from: 0.6, to: 5, thickness: 0.15, color: "secondary", transparency: [[0, 0.4], [0.5, 0.6], [1, 1]], priority: 2 },
      { kind: "sound", t: 0, event: "impact" } ] },
    hit_confirm: { duration: 0.3, palette: "steel", desc: "small feedback tick on a successful hit", layers: [
      { kind: "flash", t: 0, life: 0.1, brightness: 3, range: 8, color: "accent", priority: 2 },
      { kind: "burst", t: 0, texture: "spark", count: 8, speed: [12, 18], life: [0.1, 0.22], size: [[0, 0.25], [0.3, 0.3], [1, 0]], transparency: [[0, 0], [0.7, 0.2], [1, 1]], spread: [180, 180], drag: 6, color: ["accent", "secondary"], lightEmission: 1, priority: 1 },
      { kind: "ring", t: 0, life: 0.2, from: 0.3, to: 2.4, thickness: 0.1, color: "accent", transparency: [[0, 0.3], [1, 1]], priority: 3 },
      { kind: "sound", t: 0, event: "hit" } ] },
    slash: { duration: 0.4, palette: "steel", desc: "melee swing arc: curved beam that thins out plus a few trailing sparks", layers: [
      { kind: "beam", t: 0, life: 0.26, from: [-2.4, 0, 0], to: [2.4, 0, 0], curve: 2.2, width: [0.9, 0.12], texture: "spark", color: ["accent", "primary"], transparency: [[0, 0.05], [0.6, 0.3], [1, 1]], priority: 1 },
      { kind: "burst", t: 0.02, texture: "spark", count: 7, speed: [6, 12], life: [0.15, 0.3], size: [[0, 0.22], [0.3, 0.3], [1, 0]], transparency: [[0, 0], [0.6, 0.3], [1, 1]], spread: [25, 25], orient: "normal", drag: 4, color: "accent", lightEmission: 1, priority: 2 },
      { kind: "sound", t: 0, event: "swing" } ] },
    projectile: { duration: 1.5, sustain: true, palette: "ember", desc: "travelling bolt: bright core stream, light, trail (host part)", layers: [
      { kind: "stream", t: 0, rate: 40, texture: "spark", speed: [0.5, 1.5], life: [0.15, 0.3], size: [[0, 0.55], [0.4, 0.45], [1, 0]], transparency: [[0, 0], [0.5, 0.2], [1, 1]], spread: [180, 180], color: ["accent", "primary"], lightEmission: 1, priority: 1 },
      { kind: "stream", t: 0, rate: 10, texture: "smoke", speed: [0.5, 1], life: [0.3, 0.6], size: [[0, 0.4], [0.5, 0.9], [1, 1.2]], transparency: [[0, 0.6], [0.5, 0.8], [1, 1]], spread: [180, 180], color: "smoke", priority: 3 },
      { kind: "trail", t: 0, lifetime: 0.25, width: 0.6, color: ["accent", "primary"], transparency: [[0, 0.1], [1, 1]], priority: 2 },
      { kind: "light", t: 0, brightness: 2.2, range: 11, color: "primary", priority: 2 } ] },
    explosion: { duration: 1.2, palette: "ember", desc: "blast: flash, fireball, sparks under gravity, slow smoke, shock ring", layers: [
      { kind: "flash", t: 0, life: 0.28, brightness: 8, range: 30, color: "accent", priority: 1 },
      { kind: "burst", t: 0, texture: "fire", count: 24, speed: [14, 26], life: [0.3, 0.7], size: [[0, 1.5], [0.3, 3.2], [1, 0.6]], transparency: [[0, 0], [0.5, 0.3], [1, 1]], spread: [180, 180], drag: 4, color: ["accent", "primary"], lightEmission: 1, priority: 1 },
      { kind: "burst", t: 0, texture: "spark", count: 30, speed: [25, 45], life: [0.4, 0.9], size: [[0, 0.35], [0.5, 0.3], [1, 0]], transparency: [[0, 0], [0.7, 0.2], [1, 1]], spread: [180, 180], drag: 3, accel: [0, -25, 0], color: "accent", lightEmission: 1, priority: 2 },
      { kind: "burst", t: 0.05, texture: "smoke", count: 12, speed: [6, 10], life: [1.2, 2.2], size: [[0, 2], [0.4, 5], [1, 7]], transparency: [[0, 0.35], [0.5, 0.6], [1, 1]], spread: [180, 180], accel: [0, 2, 0], color: "smoke", rotSpeed: [-40, 40], priority: 2 },
      { kind: "ring", t: 0, life: 0.45, from: 1, to: 16, thickness: 0.3, color: "accent", transparency: [[0, 0.3], [0.4, 0.55], [1, 1]], priority: 3 },
      { kind: "sound", t: 0, event: "explosion" } ] },
    fire: { duration: 3, sustain: true, palette: "ember", desc: "campfire / torch / burning prop: flames, embers, smoke, flickering light", layers: [
      { kind: "stream", t: 0, rate: 22, texture: "fire", speed: [2, 4], life: [0.5, 0.9], size: [[0, 1], [0.4, 1.3], [1, 0.2]], transparency: [[0, 0.1], [0.7, 0.4], [1, 1]], spread: [20, 20], accel: [0, 3, 0], orient: "up", color: ["primary", "secondary"], lightEmission: 1, priority: 1 },
      { kind: "stream", t: 0, rate: 6, texture: "spark", speed: [3, 6], life: [0.8, 1.4], size: [[0, 0.15], [0.5, 0.12], [1, 0]], transparency: [[0, 0], [0.8, 0.3], [1, 1]], spread: [30, 30], accel: [0, 4, 0], orient: "up", color: "accent", lightEmission: 1, priority: 2 },
      { kind: "stream", t: 0.2, rate: 5, texture: "smoke", speed: [1.5, 3], life: [1.5, 2.5], size: [[0, 1], [0.5, 2.4], [1, 3.5]], transparency: [[0, 0.6], [0.5, 0.8], [1, 1]], spread: [15, 15], accel: [0, 2, 0], orient: "up", color: "smoke", rotSpeed: [-20, 20], priority: 3 },
      { kind: "light", t: 0, brightness: 1.6, range: 14, color: "primary", flicker: 0.25, priority: 2 } ] },
    smoke: { duration: 3, sustain: true, palette: "steel", desc: "smoke column / smouldering debris", layers: [
      { kind: "stream", t: 0, rate: 10, texture: "smoke", speed: [2, 3.5], life: [1.5, 3], size: [[0, 1.5], [0.5, 3.5], [1, 5]], transparency: [[0, 0.4], [0.6, 0.7], [1, 1]], spread: [20, 20], accel: [0, 2, 0], orient: "up", color: "smoke", rotSpeed: [-20, 20], priority: 1 } ] },
    electric: { duration: 0.6, palette: "electric", desc: "arc burst: jittering bolt, snap sparks, strobing light", layers: [
      { kind: "beam", t: 0, life: 0.45, from: [-3, 0, 0], to: [3, 0, 0], curve: 0, jitter: 0.9, width: [0.45, 0.2], texture: "spark", color: ["accent", "primary"], transparency: [[0, 0], [0.7, 0.2], [1, 1]], priority: 1 },
      { kind: "burst", t: 0, texture: "spark", count: 12, speed: [8, 15], life: [0.1, 0.25], size: [[0, 0.2], [0.5, 0.25], [1, 0]], transparency: [[0, 0], [0.6, 0.2], [1, 1]], spread: [180, 180], drag: 8, color: "accent", lightEmission: 1, priority: 2 },
      { kind: "flash", t: 0, life: 0.4, brightness: 4, range: 16, color: "accent", flicker: 0.8, priority: 2 },
      { kind: "sound", t: 0, event: "zap" } ] },
    aura: { duration: 4, sustain: true, palette: "arcane", desc: "character / pickup aura: slow rising motes, soft light", layers: [
      { kind: "stream", t: 0, rate: 12, texture: "spark", speed: [1, 2], life: [1, 1.6], size: [[0, 0.2], [0.3, 0.35], [1, 0]], transparency: [[0, 0.2], [0.6, 0.4], [1, 1]], spread: [180, 180], accel: [0, 1.5, 0], color: ["primary", "secondary"], lightEmission: 0.8, priority: 1 },
      { kind: "light", t: 0, brightness: 1.2, range: 9, color: "primary", flicker: 0.1, priority: 2 } ] },
    heal: { duration: 1.2, palette: "nature", desc: "healing: rising motes, soft rising ring, warm glow", layers: [
      { kind: "burst", t: 0, texture: "spark", count: 16, speed: [2, 4], life: [0.8, 1.2], size: [[0, 0.25], [0.4, 0.3], [1, 0]], transparency: [[0, 0.1], [0.7, 0.3], [1, 1]], spread: [25, 25], accel: [0, 4, 0], orient: "up", color: ["accent", "primary"], lightEmission: 0.9, priority: 1 },
      { kind: "ring", t: 0, life: 0.6, from: 0.5, to: 4, thickness: 0.12, rise: 3, color: "secondary", transparency: [[0, 0.45], [0.6, 0.6], [1, 1]], priority: 2 },
      { kind: "flash", t: 0, life: 0.7, brightness: 2.5, range: 12, color: "secondary", priority: 2 },
      { kind: "sound", t: 0, event: "heal" } ] },
    shield: { duration: 3, sustain: true, palette: "frost", desc: "barrier: translucent force shell that breathes, rim motes, steady light", layers: [
      { kind: "shell", t: 0, radius: 3.2, color: "primary", transparency: 0.72, pulse: 0.05, priority: 1 },
      { kind: "burst", t: 0, texture: "spark", count: 10, speed: [3, 5], life: [0.4, 0.7], size: [[0, 0.3], [0.5, 0.3], [1, 0]], transparency: [[0, 0], [0.7, 0.3], [1, 1]], spread: [180, 180], color: "accent", lightEmission: 1, priority: 3 },
      { kind: "light", t: 0, brightness: 1, range: 9, color: "secondary", priority: 2 },
      { kind: "sound", t: 0, event: "shield" } ] },
    teleport: { duration: 0.8, palette: "arcane", desc: "blink: pillar of motes, collapsing ring, flash, residual mist", layers: [
      { kind: "burst", t: 0, texture: "spark", count: 20, speed: [4, 8], life: [0.3, 0.6], size: [[0, 0.3], [0.5, 0.35], [1, 0]], transparency: [[0, 0], [0.6, 0.3], [1, 1]], spread: [15, 15], accel: [0, 10, 0], orient: "up", color: ["accent", "primary"], lightEmission: 1, priority: 1 },
      { kind: "ring", t: 0, life: 0.35, from: 3, to: 0.3, thickness: 0.15, color: "accent", transparency: [[0, 0.3], [0.7, 0.5], [1, 1]], priority: 2 },
      { kind: "flash", t: 0, life: 0.3, brightness: 4, range: 14, color: "accent", priority: 2 },
      { kind: "burst", t: 0.05, texture: "smoke", count: 6, speed: [1, 2], life: [0.6, 1], size: [[0, 1], [0.5, 1.9], [1, 2.5]], transparency: [[0, 0.6], [0.5, 0.8], [1, 1]], spread: [180, 180], color: "smoke", priority: 3 },
      { kind: "sound", t: 0, event: "teleport" } ] },
    dash: { duration: 0.6, palette: "steel", desc: "dash / dodge: dust kicked backwards, speed sparks, trail on the host", layers: [
      { kind: "burst", t: 0, texture: "smoke", count: 8, speed: [2, 4], life: [0.4, 0.8], size: [[0, 0.8], [0.5, 1.5], [1, 2]], transparency: [[0, 0.45], [0.5, 0.7], [1, 1]], spread: [30, 30], orient: "normal", color: "smoke", priority: 2 },
      { kind: "burst", t: 0, texture: "spark", count: 6, speed: [6, 12], life: [0.2, 0.3], size: [[0, 0.3], [0.4, 0.25], [1, 0]], transparency: [[0, 0], [0.6, 0.3], [1, 1]], spread: [20, 20], orient: "normal", color: "accent", lightEmission: 1, priority: 3 },
      { kind: "trail", t: 0, lifetime: 0.2, width: 1.2, color: ["accent", "primary"], transparency: [[0, 0.3], [1, 1]], priority: 1 },
      { kind: "sound", t: 0, event: "whoosh" } ] },
    dust: { duration: 0.8, palette: "dust", desc: "landing / footfall / debris dust: flat puff and a faint ring", layers: [
      { kind: "burst", t: 0, texture: "smoke", count: 10, speed: [3, 6], life: [0.6, 1.1], size: [[0, 1], [0.5, 2], [1, 2.8]], transparency: [[0, 0.45], [0.5, 0.7], [1, 1]], spread: [80, 15], orient: "normal", color: "smoke", rotSpeed: [-30, 30], priority: 1 },
      { kind: "ring", t: 0, life: 0.4, from: 0.5, to: 4, thickness: 0.12, color: "smoke", transparency: [[0, 0.75], [0.5, 0.85], [1, 1]], priority: 3 } ] },
    charge: { duration: 0.8, sustain: true, palette: "arcane", desc: "wind-up: motes converge from a sphere onto the hand, light builds", layers: [
      { kind: "stream", t: 0, rate: 50, texture: "spark", speed: [6, 10], life: [0.35, 0.5], size: [[0, 0], [0.5, 0.3], [1, 0.1]], transparency: [[0, 1], [0.3, 0], [1, 0]], spread: [0, 0], inward: 3, color: ["secondary", "accent"], lightEmission: 1, priority: 1 },
      { kind: "light", t: 0, brightness: 3, range: 10, color: "primary", grow: true, priority: 2 },
      { kind: "sound", t: 0, event: "charge" } ] },
    release: { duration: 0.5, palette: "arcane", desc: "cast release: hard flash, directional spray, ring along the aim", layers: [
      { kind: "flash", t: 0, life: 0.2, brightness: 7, range: 20, color: "accent", priority: 1 },
      { kind: "burst", t: 0, texture: "spark", count: 22, speed: [18, 30], life: [0.25, 0.5], size: [[0, 0.4], [0.3, 0.45], [1, 0]], transparency: [[0, 0], [0.6, 0.2], [1, 1]], spread: [25, 25], orient: "normal", drag: 2, color: ["accent", "primary"], lightEmission: 1, priority: 1 },
      { kind: "ring", t: 0, life: 0.3, from: 0.8, to: 8, thickness: 0.2, color: "secondary", transparency: [[0, 0.35], [0.5, 0.6], [1, 1]], priority: 2 },
      { kind: "sound", t: 0, event: "release" } ] },
    transition: { duration: 0.7, palette: "holy", desc: "scene transition in world space: wide soft flash and drifting motes (pair with a GUI fade)", layers: [
      { kind: "flash", t: 0, life: 0.6, brightness: 3, range: 40, color: "accent", priority: 1 },
      { kind: "burst", t: 0, texture: "spark", count: 24, speed: [2, 5], life: [0.4, 0.7], size: [[0, 0.3], [0.5, 0.4], [1, 0]], transparency: [[0, 0.2], [0.5, 0.4], [1, 1]], spread: [180, 180], color: ["accent", "secondary"], lightEmission: 0.8, priority: 2 } ] },
  };
  const FAMILY_NAMES = Object.keys(FAMILIES);

  // ── JS-side spec validation (shared with the sequence pack) ───────────────
  function validateFamily(name, spec) {
    const issues = [];
    const add = (level, msg) => issues.push({ level, family: name, msg });
    if (!spec || !Array.isArray(spec.layers) || !spec.layers.length) { add("error", "no layers"); return issues; }
    if (!(num(spec.duration) > 0)) add("error", "duration must be > 0");
    const emitters = spec.layers.filter((l) => l.kind === "burst" || l.kind === "stream").length;
    if (emitters > TIERS.High.maxEmitters) add("error", emitters + " emitters exceed the High tier budget (" + TIERS.High.maxEmitters + ")");
    let particles = 0;
    for (const l of spec.layers) {
      if (!/^(burst|stream|flash|light|ring|beam|trail|shell|sound)$/.test(l.kind)) add("error", "unknown layer kind " + l.kind);
      if (l.kind === "burst") particles += l.count || 0;
      if (l.kind === "stream") particles += (l.rate || 0) * Math.min(num(spec.duration) || 1, 1);
      if ((l.kind === "burst" || l.kind === "stream") && (!Array.isArray(l.size) || l.size.length < 2)) add("error", l.kind + " layer without a size curve");
      if ((l.kind === "burst" || l.kind === "stream") && (!Array.isArray(l.transparency) || l.transparency.length < 3)) add("warning", l.kind + " layer transparency curve has fewer than 3 keys (reads as a linear fade)");
      if (l.kind === "burst" && !(l.count > 0 && l.count <= 60)) add("error", "burst count must be 1-60 (quality is not particle spam)");
      if (l.kind === "stream" && !(l.rate > 0 && l.rate <= 80)) add("error", "stream rate must be 1-80");
      if (num(l.t) === null || l.t < 0) add("error", l.kind + " layer without a start time");
      if ((l.kind === "burst" || l.kind === "stream") && !(Array.isArray(l.life) && l.life.length === 2 && l.life[0] > 0 && l.life[1] >= l.life[0] && l.life[1] <= 6)) add("error", l.kind + " layer needs life [min,max] within 0-6s");
      if ((l.kind === "flash" || l.kind === "ring" || l.kind === "beam") && !(num(l.life) > 0)) add("error", l.kind + " layer without a life");
      if ((l.kind === "flash" || l.kind === "light") && !(l.brightness > 0 && l.brightness <= 10)) add("error", "light brightness must be 0-10");
      if (l.kind === "sound" && !l.event) add("error", "sound layer without an event name");
    }
    if (particles > 160) add("error", "about " + Math.round(particles) + " particles in the first second - over the 160 High budget");
    if (!spec.palette || !PALETTES[spec.palette]) add("error", "unknown default palette " + spec.palette);
    return issues;
  }
  function validateAll() { const out = []; for (const n of FAMILY_NAMES) out.push(...validateFamily(n, FAMILIES[n])); return out; }
  function sfxEventsUsed() { const s = new Set(); for (const n of FAMILY_NAMES) for (const l of FAMILIES[n].layers) if (l.kind === "sound") s.add(l.event); return Array.from(s).sort(); }

  // ── runtime (plain Lua 5.4 subset) ────────────────────────────────────────
  const RUNTIME_SRC = [
    "-- TotalScript VFX runtime (TotalVFX) " + VERSION + " - generated by vfx_library_install. Do not hand-edit: re-run the command to upgrade.",
    "-- TotalVFX.play(family, where, opts) -> handle   family: " + FAMILY_NAMES.join(", "),
    "--   where: CFrame | Vector3 | BasePart | Attachment     opts: {palette='ember'|{primary={r,g,b},...}, tier='High'|'Medium'|'Low', scale=1, normal=Vector3, duration=seconds (sustained families), seed=n}",
    "--   handle:Stop() ends gracefully (streams off, particles fade, then everything is destroyed); handle:Destroy() removes it now; handle.Completed:Connect(function(reason) end)",
    "-- TotalVFX.cast(family, where, opts) - on the server: replicates to clients near the effect (nothing is created on the server); on the client: same as play.",
    "-- TotalVFX.stopAll(), TotalVFX.setTheme(paletteName), TotalVFX.setTier(name), TotalVFX.families(), TotalVFX.validate(family) - every function is safe to call from Scripts and LocalScripts.",
    "local RunService = game:GetService('RunService')",
    "local Players = game:GetService('Players')",
    "local UserInputService = game:GetService('UserInputService')",
    "local M = {}",
    "M.VERSION = '" + VERSION + "'",
    "M.TEX = {spark = 'rbxasset://textures/particles/sparkles_main.dds', smoke = 'rbxasset://textures/particles/smoke_main.dds', fire = 'rbxasset://textures/particles/fire_main.dds'}",
    "M.PALETTES = " + lua(PALETTES),
    "M.TIERS = " + lua(TIERS),
    "M.FAMILIES = " + lua(FAMILIES),
    "local active = {}",
    "local stepConn = nil",
    "local nextId = 0",
    "local rng = Random.new()",
    "local function rgb(c) return Color3.fromRGB(c[1], c[2], c[3]) end",
    "local function roleColor(pal, role) local c = pal[role] or pal.primary if typeof(c) == 'Color3' then return c end return rgb(c) end",
    "local function colorSeq(pal, spec) if type(spec) == 'table' and type(spec[1]) == 'string' then return ColorSequence.new(roleColor(pal, spec[1]), roleColor(pal, spec[2] or spec[1])) end return ColorSequence.new(roleColor(pal, spec or 'primary')) end",
    "local function numSeq(curve, mul) mul = mul or 1 if type(curve) == 'number' then return NumberSequence.new(curve * mul) end local keys = {} for i, k in ipairs(curve) do keys[i] = NumberSequenceKeypoint.new(math.clamp(k[1], 0, 1), math.max(0, k[2] * mul)) end if keys[1].Time > 0 then table.insert(keys, 1, NumberSequenceKeypoint.new(0, keys[1].Value)) end if keys[#keys].Time < 1 then keys[#keys + 1] = NumberSequenceKeypoint.new(1, keys[#keys].Value) end return NumberSequence.new(keys) end",
    "local function curveAt(curve, k) if type(curve) == 'number' then return curve end local prev = curve[1] for i = 2, #curve do local c = curve[i] if k <= c[1] then local span = c[1] - prev[1] local a = span > 0 and (k - prev[1]) / span or 1 return prev[2] + (c[2] - prev[2]) * a end prev = c end return curve[#curve][2] end",
    "local function easeOut(k) k = math.clamp(k, 0, 1) return 1 - (1 - k) * (1 - k) * (1 - k) end",
    "local function orientFrame(pos, n) if n.Magnitude < 1e-4 then n = Vector3.new(0, 1, 0) end n = n.Unit local up = Vector3.new(0, 1, 0) if math.abs(n.Y) > 0.98 then up = Vector3.new(1, 0, 0) end return CFrame.lookAt(pos, pos + n, up) * CFrame.Angles(-math.pi / 2, 0, 0) end",
    "function M.resolvePalette(p) if type(p) == 'table' then local out = {} for role, base in pairs(M.PALETTES.steel) do out[role] = p[role] or base end return out end local name = tostring(p or '') if M.PALETTES[name] then return M.PALETTES[name] end local theme = script:GetAttribute('DefaultPalette') if theme and M.PALETTES[theme] then return M.PALETTES[theme] end return nil end",
    "function M.autoTier() local forced = script:GetAttribute('DefaultTier') if forced and M.TIERS[forced] then return forced end if RunService:IsClient() and UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled then return 'Medium' end return 'High' end",
    "function M.setTheme(name) if not M.PALETTES[name] then error('TotalVFX.setTheme: unknown palette ' .. tostring(name)) end script:SetAttribute('DefaultPalette', name) end",
    "function M.setTier(name) if not M.TIERS[name] then error('TotalVFX.setTier: High, Medium or Low') end script:SetAttribute('DefaultTier', name) end",
    "function M.families() local out = {} for name, f in pairs(M.FAMILIES) do out[#out + 1] = {name = name, duration = f.duration, sustain = f.sustain == true, palette = f.palette, desc = f.desc} end table.sort(out, function(a, b) return a.name < b.name end) return out end",
    "function M.validate(name) local f = M.FAMILIES[name] local issues = {} if not f then return {{level = 'error', msg = 'unknown family ' .. tostring(name)}} end local emitters, particles = 0, 0 for _, l in ipairs(f.layers) do if l.kind == 'burst' or l.kind == 'stream' then emitters = emitters + 1 end if l.kind == 'burst' then particles = particles + (l.count or 0) end if l.kind == 'stream' then particles = particles + (l.rate or 0) end if (l.kind == 'burst' or l.kind == 'stream') and (type(l.size) ~= 'table' or #l.size < 2) then issues[#issues + 1] = {level = 'error', msg = l.kind .. ' without a size curve'} end end if emitters > M.TIERS.High.maxEmitters then issues[#issues + 1] = {level = 'error', msg = emitters .. ' emitters over budget'} end if particles > 160 then issues[#issues + 1] = {level = 'error', msg = particles .. ' particles in the first second over budget'} end return issues end",
    "local function whereOf(where) if typeof(where) == 'CFrame' then return where, nil end if typeof(where) == 'Vector3' then return CFrame.new(where), nil end if typeof(where) == 'Instance' then if where:IsA('Attachment') then return where.WorldCFrame, where end if where:IsA('BasePart') then return where.CFrame, where end if where:IsA('Model') then local cf = where:GetPivot() return cf, where.PrimaryPart or where:FindFirstChildWhichIsA('BasePart') end end error('TotalVFX: where must be a CFrame, Vector3, BasePart, Attachment or Model (got ' .. typeof(where) .. ')') end",
    "local function hostCFrame(host, fallback) if not host or not host.Parent then return fallback end if host:IsA('Attachment') then return host.WorldCFrame end return host.CFrame end",
    "local function makeEmitter(h, l, tier) local e = Instance.new('ParticleEmitter') e.Name = l.kind == 'burst' and 'Burst' or 'Stream' e.Texture = M.TEX[l.texture or 'spark'] or M.TEX.spark e.Color = colorSeq(h.palette, l.color) e.Size = numSeq(l.size, h.scale) e.Transparency = numSeq(l.transparency or {{0, 0}, {0.7, 0.3}, {1, 1}}) local sp = l.speed or {4, 8} e.Speed = NumberRange.new(sp[1] * h.scale, sp[2] * h.scale) local lf = l.life or {0.3, 0.6} e.Lifetime = NumberRange.new(lf[1], lf[2]) local spread = l.spread or {180, 180} e.SpreadAngle = Vector2.new(spread[1], spread[2]) e.Drag = l.drag or 0 e.LightEmission = l.lightEmission or 0.3 e.LightInfluence = 0.2 e.Rate = 0 e.Enabled = false e.Brightness = 1.5 if l.accel then e.Acceleration = Vector3.new(l.accel[1], l.accel[2], l.accel[3]) end if l.rotSpeed then e.RotSpeed = NumberRange.new(l.rotSpeed[1], l.rotSpeed[2]) e.Rotation = NumberRange.new(0, 360) end if l.inward then e.Shape = Enum.ParticleEmitterShape.Sphere e.ShapeInOut = Enum.ParticleEmitterShapeInOut.Inward e.ShapeStyle = Enum.ParticleEmitterShapeStyle.Surface e.Parent = h.part else if l.orient == 'radial' then e.EmissionDirection = Enum.NormalId.Top e.SpreadAngle = Vector2.new(180, 180) end e.Parent = (l.orient == 'up') and h.upAttach or h.attach end return e end",
    "local function makeLight(h, l) local pl = Instance.new('PointLight') pl.Name = l.kind == 'flash' and 'Flash' or 'Light' pl.Color = roleColor(h.palette, l.color) pl.Brightness = l.grow and 0 or l.brightness pl.Range = (l.range or 10) * math.max(1, h.scale * 0.75) pl.Shadows = false pl.Parent = h.attach return pl end",
    "local function makeRing(h, l) local p = Instance.new('Part') p.Name = 'Ring' p.Shape = Enum.PartType.Cylinder p.Anchored = true p.CanCollide = false p.CanQuery = false p.CanTouch = false p.CastShadow = false p.Material = Enum.Material.Neon p.Color = roleColor(h.palette, l.color) p.Transparency = curveAt(l.transparency or {{0, 0.4}, {1, 1}}, 0) p.Size = Vector3.new(l.thickness or 0.15, l.from * h.scale, l.from * h.scale) p.CFrame = h.frame * CFrame.Angles(0, 0, math.pi / 2) p.Parent = h.part return p end",
    "local function makeBeam(h, l) local a0 = Instance.new('Attachment') a0.Name = 'BeamA' a0.Position = Vector3.new(l.from[1], l.from[2], l.from[3]) * h.scale a0.Parent = h.part local a1 = Instance.new('Attachment') a1.Name = 'BeamB' a1.Position = Vector3.new(l.to[1], l.to[2], l.to[3]) * h.scale a1.Parent = h.part local b = Instance.new('Beam') b.Name = 'Arc' b.Attachment0 = a0 b.Attachment1 = a1 b.Texture = M.TEX[l.texture or 'spark'] or M.TEX.spark b.Color = colorSeq(h.palette, l.color) b.Width0 = (l.width or {0.6, 0.2})[1] * h.scale b.Width1 = (l.width or {0.6, 0.2})[2] * h.scale b.CurveSize0 = (l.curve or 0) * h.scale b.CurveSize1 = -(l.curve or 0) * h.scale b.Segments = l.jitter and 14 or 10 b.LightEmission = 1 b.LightInfluence = 0 b.FaceCamera = true b.Transparency = numSeq(l.transparency or {{0, 0}, {1, 1}}) b.Parent = h.part return b, a0, a1 end",
    "local function makeTrail(h, l) local host = h.host if not host or not host:IsA('BasePart') then return nil end local a0 = Instance.new('Attachment') a0.Name = 'TrailA' a0.Position = Vector3.new(0, (l.width or 0.6) * 0.5 * h.scale, 0) a0.Parent = host local a1 = Instance.new('Attachment') a1.Name = 'TrailB' a1.Position = Vector3.new(0, -(l.width or 0.6) * 0.5 * h.scale, 0) a1.Parent = host local t = Instance.new('Trail') t.Name = 'Trail' t.Attachment0 = a0 t.Attachment1 = a1 t.Texture = M.TEX.smoke t.Color = colorSeq(h.palette, l.color) t.Lifetime = l.lifetime or 0.25 t.MinLength = 0.05 t.LightEmission = 0.8 t.WidthScale = NumberSequence.new(1, 0) t.Transparency = numSeq(l.transparency or {{0, 0.2}, {1, 1}}) t.Parent = host h.owned[#h.owned + 1] = a0 h.owned[#h.owned + 1] = a1 h.owned[#h.owned + 1] = t return t end",
    "local function makeShell(h, l) local p = Instance.new('Part') p.Name = 'Shell' p.Shape = Enum.PartType.Ball p.Anchored = true p.CanCollide = false p.CanQuery = false p.CanTouch = false p.CastShadow = false p.Material = Enum.Material.ForceField p.Color = roleColor(h.palette, l.color) p.Transparency = l.transparency or 0.7 local d = (l.radius or 3) * 2 * h.scale p.Size = Vector3.new(d, d, d) p.CFrame = h.frame p.Parent = h.part return p end",
    "local function playSound(h, l) local mod = game:GetService('ReplicatedStorage'):FindFirstChild('TotalSFX') if not mod or not mod:IsA('ModuleScript') then h.skipped[#h.skipped + 1] = 'sound ' .. tostring(l.event) .. ' (TotalSFX not installed)' return end local okR, sfx = pcall(require, mod) if not okR or type(sfx) ~= 'table' or type(sfx.play) ~= 'function' then h.skipped[#h.skipped + 1] = 'sound ' .. tostring(l.event) .. ' (TotalSFX unavailable)' return end local okP, res = pcall(sfx.play, l.event, h.frame.Position, {volume = h.opts.volume}) if not okP or res == nil then h.skipped[#h.skipped + 1] = 'sound ' .. tostring(l.event) .. ' (no verified asset)' end end",
    "local function startLayer(h, l) local tier = h.tier if l.kind == 'sound' then playSound(h, l) return end if (l.kind == 'flash' or l.kind == 'light') and not tier.lights then return end if l.kind == 'ring' and not tier.rings then return end if l.kind == 'beam' and not tier.beams then return end local run = {layer = l, t0 = h.elapsed} if l.kind == 'burst' then local e = makeEmitter(h, l, tier) e:Emit(math.max(1, math.floor(l.count * tier.particles * (h.opts.density or 1) + 0.5))) run.inst = e run.life = (l.life or {0.3, 0.6})[2] elseif l.kind == 'stream' then local e = makeEmitter(h, l, tier) e.Rate = math.max(1, l.rate * tier.particles * (h.opts.density or 1)) e.Enabled = true run.inst = e run.sustain = true run.life = (l.life or {0.3, 0.6})[2] elseif l.kind == 'flash' then run.inst = makeLight(h, l) run.life = l.life elseif l.kind == 'light' then run.inst = makeLight(h, l) run.sustain = true run.life = 0.15 elseif l.kind == 'ring' then run.inst = makeRing(h, l) run.life = l.life elseif l.kind == 'beam' then local b, a0, a1 = makeBeam(h, l) run.inst = b run.a0 = a0 run.a1 = a1 run.life = l.life elseif l.kind == 'trail' then run.inst = makeTrail(h, l) if not run.inst then h.skipped[#h.skipped + 1] = 'trail (needs a BasePart host)' return end run.sustain = true run.life = l.lifetime or 0.25 elseif l.kind == 'shell' then run.inst = makeShell(h, l) run.sustain = true run.life = 0.3 end h.running[#h.running + 1] = run end",
    "local function updateLayer(h, run, dt) local l = run.layer local inst = run.inst if not inst or not inst.Parent then return false end local age = h.elapsed - run.t0 if l.kind == 'flash' then local k = age / l.life if k >= 1 then inst:Destroy() return false end local b = l.brightness * (1 - easeOut(k)) if l.flicker then b = b * (1 - l.flicker * rng:NextNumber(0, 1)) end inst.Brightness = b elseif l.kind == 'light' then if h.stopping then inst.Brightness = math.max(0, inst.Brightness - dt * l.brightness / 0.3) if inst.Brightness <= 0 then inst:Destroy() return false end elseif l.grow then inst.Brightness = l.brightness * easeOut(math.min(1, age / math.max(0.2, h.duration))) elseif l.flicker then inst.Brightness = l.brightness * (1 - l.flicker * 0.5 + l.flicker * rng:NextNumber(0, 1)) end elseif l.kind == 'ring' then local k = age / l.life if k >= 1 then inst:Destroy() return false end local r = (l.from + (l.to - l.from) * easeOut(k)) * h.scale inst.Size = Vector3.new(l.thickness or 0.15, r, r) inst.Transparency = curveAt(l.transparency or {{0, 0.4}, {1, 1}}, k) if l.rise then inst.CFrame = (h.frame * CFrame.new(0, l.rise * easeOut(k), 0)) * CFrame.Angles(0, 0, math.pi / 2) elseif h.host then inst.CFrame = h.frame * CFrame.Angles(0, 0, math.pi / 2) end elseif l.kind == 'beam' then local k = age / l.life if k >= 1 then inst:Destroy() return false end if l.jitter and run.a0 and run.a1 then local j = l.jitter * h.scale run.a0.Position = Vector3.new(l.from[1] * h.scale + rng:NextNumber(-j, j), l.from[2] * h.scale + rng:NextNumber(-j, j), rng:NextNumber(-j, j)) run.a1.Position = Vector3.new(l.to[1] * h.scale + rng:NextNumber(-j, j), l.to[2] * h.scale + rng:NextNumber(-j, j), rng:NextNumber(-j, j)) end elseif l.kind == 'shell' then if h.stopping then inst.Transparency = math.min(1, inst.Transparency + dt / 0.3) if inst.Transparency >= 1 then inst:Destroy() return false end elseif l.pulse then local d = (l.radius or 3) * 2 * h.scale * (1 + l.pulse * math.sin(age * 4)) inst.Size = Vector3.new(d, d, d) inst.CFrame = h.frame end elseif l.kind == 'stream' or l.kind == 'trail' then if h.stopping then if l.kind == 'stream' then inst.Enabled = false else inst.Enabled = false end if h.elapsed - h.stopAt >= run.life then inst:Destroy() return false end end elseif l.kind == 'burst' then if age >= run.life + 0.05 then inst:Destroy() return false end end return true end",
    "local function finish(h, reason) if h.done then return end h.done = true for i = #active, 1, -1 do if active[i] == h then table.remove(active, i) end end for _, inst in ipairs(h.owned) do if inst and inst.Parent then inst:Destroy() end end if h.part and h.part.Parent then h.part:Destroy() end if #active == 0 and stepConn then stepConn:Disconnect() stepConn = nil end h.state = reason h.completedEv:Fire(reason) h.completedEv:Destroy() end",
    "local function step(dt) for i = #active, 1, -1 do local h = active[i] if not h.done then h.elapsed = h.elapsed + dt if h.host then if h.host.Parent then h.frame = hostCFrame(h.host, h.frame) * h.localOffset h.part.CFrame = h.frame else h:Stop('host-removed') end end while h.nextLayer <= #h.layers and h.layers[h.nextLayer].t <= h.elapsed and not h.stopping do startLayer(h, h.layers[h.nextLayer]) h.nextLayer = h.nextLayer + 1 end for j = #h.running, 1, -1 do if not updateLayer(h, h.running[j], dt) then table.remove(h.running, j) end end if not h.stopping and h.elapsed >= h.duration then h:Stop('completed') end if h.stopping and #h.running == 0 and h.nextLayer > #h.layers then finish(h, h.stopReason) elseif h.stopping and h.elapsed - h.stopAt > 6 then finish(h, h.stopReason) end end end end",
    "local Handle = {} Handle.__index = Handle",
    "function Handle:Stop(reason) if self.done or self.stopping then return end self.stopping = true self.stopAt = self.elapsed self.stopReason = reason or 'stopped' self.nextLayer = #self.layers + 1 for _, run in ipairs(self.running) do if run.layer.kind == 'stream' and run.inst then run.inst.Enabled = false end end end",
    "function Handle:Destroy() self.stopping = true finish(self, 'destroyed') end",
    "function Handle:IsPlaying() return not self.done end",
    "function M.play(family, where, opts) opts = opts or {} local spec = M.FAMILIES[family] if not spec then error('TotalVFX.play: unknown family ' .. tostring(family) .. ' (families: ' .. table.concat((function() local n = {} for k in pairs(M.FAMILIES) do n[#n + 1] = k end table.sort(n) return n end)(), ', ') .. ')') end local tierName = opts.tier or M.autoTier() local tier = M.TIERS[tierName] or M.TIERS.High local palette = M.resolvePalette(opts.palette) or M.PALETTES[spec.palette] or M.PALETTES.steel local frame, host = whereOf(where) local normal = opts.normal if typeof(normal) ~= 'Vector3' then normal = Vector3.new(0, 1, 0) end if opts.normal == nil and host and host:IsA('BasePart') and spec.layers[1] and spec.layers[1].orient == 'normal' then normal = frame.LookVector end local oriented = orientFrame(frame.Position, normal) local h = setmetatable({family = family, spec = spec, opts = opts, tier = tier, tierName = tierName, palette = palette, scale = math.clamp(tonumber(opts.scale) or 1, 0.2, 6), host = host, frame = oriented, elapsed = 0, duration = spec.sustain and (tonumber(opts.duration) or spec.duration) or spec.duration, layers = {}, nextLayer = 1, running = {}, owned = {}, skipped = {}, done = false, stopping = false, state = 'playing'}, Handle) h.completedEv = Instance.new('BindableEvent') h.Completed = h.completedEv.Event if host then h.localOffset = hostCFrame(host, frame):Inverse() * oriented end local pri = {} local emitters = 0 local sorted = {} for _, l in ipairs(spec.layers) do sorted[#sorted + 1] = l end table.sort(sorted, function(a, b) return (a.priority or 2) < (b.priority or 2) end) local keep = {} for _, l in ipairs(sorted) do if l.kind == 'burst' or l.kind == 'stream' then if emitters < tier.maxEmitters then emitters = emitters + 1 keep[l] = true else h.skipped[#h.skipped + 1] = l.kind .. ' layer dropped by tier ' .. tierName end else keep[l] = true end end for _, l in ipairs(spec.layers) do if keep[l] then h.layers[#h.layers + 1] = l end end table.sort(h.layers, function(a, b) return (a.t or 0) < (b.t or 0) end) nextId = nextId + 1 h.id = nextId local root = workspace:FindFirstChild('TotalVFXRuntime') if not root then root = Instance.new('Folder') root.Name = 'TotalVFXRuntime' root.Parent = workspace end local part = Instance.new('Part') part.Name = 'TotalVFX_' .. family .. '_' .. nextId part.Anchored = true part.CanCollide = false part.CanQuery = false part.CanTouch = false part.CastShadow = false part.Transparency = 1 local r = 0.4 for _, l in ipairs(h.layers) do if l.inward then r = l.inward * h.scale * 2 end end part.Size = Vector3.new(r, r, r) part.CFrame = oriented part:SetAttribute('TotalVFX', family) part:SetAttribute('Tier', tierName) local at = Instance.new('Attachment') at.Name = 'Root' at.Parent = part local up = Instance.new('Attachment') up.Name = 'Up' up.Parent = part up.WorldCFrame = CFrame.new(oriented.Position) h.part = part h.attach = at h.upAttach = up part.Parent = root active[#active + 1] = h while #active > tier.maxActive do local oldest = active[1] oldest:Destroy() end if not stepConn then stepConn = RunService.Heartbeat:Connect(step) end step(0) return h end",
    "function M.cast(family, where, opts) if RunService:IsServer() and not RunService:IsClient() then local ev = script:FindFirstChild('Replicate') if not ev then error('TotalVFX.cast: Replicate RemoteEvent missing - run vfx_library_install again') end local frame = whereOf(where) local radius = (opts and opts.radius) or 300 local sent = 0 local payload = {} if type(opts) == 'table' then for k, v in pairs(opts) do if k ~= 'normal' then payload[k] = v end end if typeof(opts.normal) == 'Vector3' then payload.normal = {opts.normal.X, opts.normal.Y, opts.normal.Z} end end for _, plr in ipairs(Players:GetPlayers()) do local ch = plr.Character local root = ch and ch:FindFirstChild('HumanoidRootPart') if not root or (root.Position - frame.Position).Magnitude <= radius then ev:FireClient(plr, family, {frame:GetComponents()}, payload) sent = sent + 1 end end return sent end return M.play(family, where, opts) end",
    "function M.stopAll() for i = #active, 1, -1 do active[i]:Destroy() end end",
    "function M.activeCount() return #active end",
    "function M.step(dt) step(dt) end",
    "return M",
  ].join("\n");

  const CLIENT_SRC = [
    "-- TotalScript VFX client " + VERSION + " - plays effects the server replicates with TotalVFX.cast (cosmetic only; the server never spawns particles).",
    "local ReplicatedStorage = game:GetService('ReplicatedStorage')",
    "local mod = ReplicatedStorage:WaitForChild('TotalVFX')",
    "local TotalVFX = require(mod)",
    "local ev = mod:WaitForChild('Replicate')",
    "ev.OnClientEvent:Connect(function(family, cf, opts)",
    "  if type(cf) ~= 'table' or #cf < 12 then return end",
    "  opts = type(opts) == 'table' and opts or {}",
    "  if type(opts.normal) == 'table' then opts.normal = Vector3.new(opts.normal[1], opts.normal[2], opts.normal[3]) end",
    "  local okP, err = pcall(TotalVFX.play, family, CFrame.new(cf[1], cf[2], cf[3], cf[4], cf[5], cf[6], cf[7], cf[8], cf[9], cf[10], cf[11], cf[12]), opts)",
    "  if not okP then warn('[TotalVFX] ' .. tostring(err)) end",
    "end)",
  ].join("\n");

  // ── Studio-side command library ───────────────────────────────────────────
  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local ReplicatedStorage=game:GetService('ReplicatedStorage')",
    "local StarterPlayer=game:GetService('StarterPlayer')",
    "local RunService=game:GetService('RunService')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local RUNTIME_VERSION=" + q(VERSION),
    "local RUNTIME_SRC=" + q(RUNTIME_SRC),
    "local CLIENT_SRC=" + q(CLIENT_SRC),
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end",
    "local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end if lp=='workspace' then return workspace end local cur=game for seg in p:gmatch('[^%.]+') do if cur==game and seg:lower()=='workspace' then cur=workspace else local nxt=cur:FindFirstChild(seg) if not nxt and cur==game then local okS,svc=pcall(function() return game:GetService(seg) end) if okS then nxt=svc end end if not nxt then return nil end cur=nxt end end return cur end",
    "local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('TotalScript VFX') end) return okW and w or nil end",
    "local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end",
    "local function ensureRuntime() local made={} local mod=ReplicatedStorage:FindFirstChild('TotalVFX') if mod and not mod:IsA('ModuleScript') then mod:Destroy() mod=nil end if not mod then mod=Instance.new('ModuleScript') mod.Name='TotalVFX' mod.Parent=ReplicatedStorage made[#made+1]='TotalVFX' end if mod:GetAttribute('TotalVersion')~=RUNTIME_VERSION then mod.Source=RUNTIME_SRC mod:SetAttribute('TotalVersion',RUNTIME_VERSION) mod:SetAttribute('TotalVFX',true) if #made==0 then made[#made+1]='TotalVFX (upgraded)' end end local ev=mod:FindFirstChild('Replicate') if not ev then ev=Instance.new('RemoteEvent') ev.Name='Replicate' ev.Parent=mod made[#made+1]='TotalVFX.Replicate' end local sps=StarterPlayer:FindFirstChild('StarterPlayerScripts') if not sps then sps=Instance.new('StarterPlayerScripts') sps.Name='StarterPlayerScripts' sps.Parent=StarterPlayer end local cl=sps:FindFirstChild('TotalVFXClient') if not cl then cl=Instance.new('LocalScript') cl.Name='TotalVFXClient' cl.Parent=sps made[#made+1]='TotalVFXClient' end if cl:GetAttribute('TotalVersion')~=RUNTIME_VERSION then cl.Source=CLIENT_SRC cl:SetAttribute('TotalVersion',RUNTIME_VERSION) end return mod,made end",
    "local function loadRuntime() local mod,made=ensureRuntime() local okR,lib=pcall(require,mod) if not okR then error('TotalVFX runtime failed to load: '..tostring(lib)) end return lib,mod,made end",
  ].join("\n");

  const B = {};

  B.vfx_library_install = (a) => {
    const theme = a.theme || a.palette || (a.genre && GENRE_PALETTE[String(a.genre).toLowerCase()]) || null;
    const tier = a.tier ? String(a.tier) : null;
    return [
      "local rec=wp() local lib,mod,made=loadRuntime()",
      theme ? "if lib.PALETTES[" + q(theme) + "] then mod:SetAttribute('DefaultPalette'," + q(theme) + ") else wpDone(rec) return fail('unknown palette " + theme + " - choose one of: ' .. table.concat((function() local n={} for k in pairs(lib.PALETTES) do n[#n+1]=k end table.sort(n) return n end)(), ', ')) end" : "",
      tier ? "if lib.TIERS[" + q(tier) + "] then mod:SetAttribute('DefaultTier'," + q(tier) + ") else wpDone(rec) return fail('tier must be High, Medium or Low') end" : "",
      "wpDone(rec)",
      "local fams=lib.families() local names={} for i,f in ipairs(fams) do names[i]=f.name end",
      "return ok({module=mod:GetFullName(),version=lib.VERSION,installed=made,families=names,palettes=(function() local n={} for k in pairs(lib.PALETTES) do n[#n+1]=k end table.sort(n) return n end)(),default_palette=mod:GetAttribute('DefaultPalette'),default_tier=mod:GetAttribute('DefaultTier') or 'auto',usage='local VFX=require(game.ReplicatedStorage.TotalVFX) local h=VFX.play(\"impact\", cframeOrPartOrAttachment, {palette=\"ember\", normal=hitNormal}) -- server: VFX.cast(...) replicates to nearby clients; h:Stop() / h:Destroy() / h.Completed'},",
      "  'TotalVFX '..lib.VERSION..' ready at '..mod:GetFullName()..' ('..#fams..' families: '..table.concat(names,', ')..'). Preview one with vfx_play {family, path}; gameplay scripts require(ReplicatedStorage.TotalVFX).')",
    ].filter(Boolean).join("\n");
  };

  B.vfx_play = (a) => {
    const family = String(a.family || a.effect || "").toLowerCase();
    if (!family) return "return fail('family is required: " + FAMILY_NAMES.join(", ") + "')";
    if (!FAMILIES[family]) return "return fail('unknown family " + family.replace(/'/g, "") + " - valid: " + FAMILY_NAMES.join(", ") + "')";
    const path = a.path || a.parent_path || a.target || "";
    const pos = Array.isArray(a.position) && a.position.length >= 3 ? a.position.slice(0, 3).map((x) => num(x) || 0) : null;
    const normal = Array.isArray(a.normal) && a.normal.length >= 3 ? a.normal.slice(0, 3).map((x) => num(x) || 0) : null;
    const opts = {};
    if (a.palette) opts.palette = typeof a.palette === "object" ? a.palette : String(a.palette);
    if (a.tier) opts.tier = String(a.tier);
    if (num(a.scale) !== null) opts.scale = num(a.scale);
    if (num(a.duration) !== null) opts.duration = num(a.duration);
    if (num(a.density) !== null) opts.density = num(a.density);
    return [
      "local lib,mod=loadRuntime()",
      path ? "local where=resolve(" + q(path) + ") if not where then return fail('path not found: " + String(path).replace(/'/g, "") + "') end" : (pos ? "local where=CFrame.new(" + pos.join(",") + ")" : "local cam=workspace.CurrentCamera local where=CFrame.new(cam.CFrame.Position+cam.CFrame.LookVector*12)"),
      pos && path ? "where=CFrame.new(" + pos.join(",") + ")" : "",
      "local opts=" + lua(opts),
      normal ? "opts.normal=Vector3.new(" + normal.join(",") + ")" : "",
      "if typeof(opts.palette)=='string' and not lib.PALETTES[opts.palette] then return fail('unknown palette '..opts.palette..' - valid: ember, frost, arcane, holy, void, nature, toxic, electric, steel, blood, dust') end",
      "if opts.tier and not lib.TIERS[opts.tier] then return fail('tier must be High, Medium or Low') end",
      "local h=lib.play(" + q(family) + ",where,opts)",
      "local layers={} for _,run in ipairs(h.running) do layers[#layers+1]=run.layer.kind end",
      "local emitters,lights,parts=0,0,0 for _,d in ipairs(h.part:GetDescendants()) do if d:IsA('ParticleEmitter') then emitters=emitters+1 elseif d:IsA('Light') then lights=lights+1 elseif d:IsA('BasePart') then parts=parts+1 end end",
      "local note=RunService:IsEdit() and 'edit mode: Heartbeat drives the effect, it cleans itself up after '..string.format('%.2f',h.duration)..'s (+particle lifetimes)' or 'playing'",
      "return ok({family=" + q(family) + ",container=h.part:GetFullName(),tier=h.tierName,palette=opts.palette or mod:GetAttribute('DefaultPalette') or lib.FAMILIES[" + q(family) + "].palette,duration=h.duration,layers_started=layers,layers_total=#h.layers,emitters=emitters,lights=lights,extra_parts=parts,skipped=h.skipped,sustain=lib.FAMILIES[" + q(family) + "].sustain==true,note=note},",
      "  'TotalVFX '.." + q(family) + "..' playing at '..h.part:GetFullName()..' (tier '..h.tierName..', '..#h.layers..' layers, '..emitters..' emitters'..(#h.skipped>0 and ', skipped: '..table.concat(h.skipped,'; ') or '')..'). total_screenshot now to judge it; it self-destructs when done.')",
    ].filter(Boolean).join("\n");
  };

  B.vfx_theme_set = (a) => {
    const genre = a.genre ? String(a.genre).toLowerCase() : "";
    const palette = a.palette ? String(a.palette) : (genre && GENRE_PALETTE[genre]) || "";
    if (!palette) return "return fail('palette (ember, frost, arcane, holy, void, nature, toxic, electric, steel, blood, dust) or genre is required')";
    const tier = a.tier ? String(a.tier) : null;
    return [
      "local rec=wp() local lib,mod=loadRuntime()",
      "if not lib.PALETTES[" + q(palette) + "] then wpDone(rec) return fail('unknown palette " + palette.replace(/'/g, "") + "') end",
      "mod:SetAttribute('DefaultPalette'," + q(palette) + ")",
      tier ? "if not lib.TIERS[" + q(tier) + "] then wpDone(rec) return fail('tier must be High, Medium or Low') end mod:SetAttribute('DefaultTier'," + q(tier) + ")" : "",
      "wpDone(rec)",
      "local p=lib.PALETTES[" + q(palette) + "]",
      "return ok({palette=" + q(palette) + ",genre=" + q(genre) + ",tier=mod:GetAttribute('DefaultTier') or 'auto',roles=p},'TotalVFX default palette = " + palette + "' .. (" + q(genre) + "~='' and ' (genre " + genre + ")' or '') .. '; every vfx_play / TotalVFX.play without an explicit palette now uses it')",
    ].filter(Boolean).join("\n");
  };

  // Audit an existing effect tree against the production rules; returns real
  // findings (counts, constant rates with no owner, neon blocks, 2-key curves).
  B.vfx_validate = (a) => {
    const path = a.path || a.parent_path || "";
    if (!path) return "return fail('path is required (a Part, Attachment, Model or Folder holding the effect)')";
    return [
      "local root=resolve(" + q(path) + ") if not root then return fail('path not found: " + String(path).replace(/'/g, "") + "') end",
      "local issues={} local function add(level,code,msg,inst) issues[#issues+1]={level=level,code=code,msg=msg,path=inst and inst:GetFullName() or nil} end",
      "local emitters,lights,beams,trails,neon,rate=0,0,0,0,0,0 local list={} if root:IsA('ParticleEmitter') or root:IsA('Light') or root:IsA('Beam') or root:IsA('Trail') then list={root} end for _,d in ipairs(root:GetDescendants()) do list[#list+1]=d end",
      "for _,d in ipairs(list) do",
      "  if d:IsA('ParticleEmitter') then emitters=emitters+1 rate=rate+(d.Enabled and d.Rate or 0)",
      "    if #d.Size.Keypoints<=2 and d.Size.Keypoints[1].Value==d.Size.Keypoints[#d.Size.Keypoints].Value then add('warning','flat-size','Size is constant - particles that never grow or shrink read as flat',d) end",
      "    if #d.Transparency.Keypoints<=2 then add('warning','linear-fade','Transparency has only '..#d.Transparency.Keypoints..' keys (linear fade); use 3+ keys (hold, then fade)',d) end",
      "    if d.Enabled and d.Rate>0 and d.Rate*d.Lifetime.Max>150 then add('error','particle-spam',string.format('%.0f live particles (Rate %.0f x Lifetime %.2f) - over the 150 budget',d.Rate*d.Lifetime.Max,d.Rate,d.Lifetime.Max),d) end",
      "    if d.Enabled and d.Rate>0 and d.Lifetime.Max>0 and not d.Parent:GetAttribute('TotalVFX') and not d:GetAttribute('Owner') and (d.Name:lower():find('explosion') or d.Name:lower():find('impact') or d.Name:lower():find('burst')) then add('error','no-lifecycle','a one-shot effect runs forever (Enabled + Rate '..d.Rate..', nothing stops or destroys it)',d) end",
      "    if d.Texture=='' then add('error','no-texture','emitter without a texture renders the default square',d) end",
      "    if d.Lifetime.Max>6 then add('warning','long-life','Lifetime '..d.Lifetime.Max..'s - particles that linger pile up',d) end",
      "  elseif d:IsA('Light') then lights=lights+1 if d.Brightness>10 then add('warning','blown-light','Brightness '..d.Brightness..' blows out the scene',d) end if d.Range>60 then add('warning','light-range','Range '..d.Range..' studs lights the whole map',d) end",
      "  elseif d:IsA('Beam') then beams=beams+1 if d.Width0>5 then add('warning','beam-width','Width0 '..d.Width0..' is a wall, not a beam',d) end",
      "  elseif d:IsA('Trail') then trails=trails+1 if d.Lifetime>2 then add('warning','trail-life','Trail Lifetime '..d.Lifetime..'s smears',d) end",
      "  elseif d:IsA('BasePart') and d.Material==Enum.Material.Neon and d.Transparency<0.2 and not d:GetAttribute('TotalVFX') and not (d.Parent and d.Parent:GetAttribute('TotalVFX')) then neon=neon+1 if neon<=5 then add('error','neon-block','opaque Neon part used as an effect - use emitters / lights / short-lived rings',d) end end",
      "end",
      "if emitters==0 and lights==0 and beams==0 and trails==0 then add('error','empty','no ParticleEmitter / Light / Beam / Trail under '..root:GetFullName(),root) end",
      "if emitters>6 then add('error','emitter-count',emitters..' emitters in one effect (High tier allows 6)',root) end",
      "if lights>2 then add('warning','light-count',lights..' lights in one effect',root) end",
      "if rate>120 then add('error','rate-sum','total enabled Rate '..rate..'/s over budget',root) end",
      "local errors,warnings=0,0 for _,i in ipairs(issues) do if i.level=='error' then errors=errors+1 else warnings=warnings+1 end end",
      "local score=math.max(0,100-errors*20-warnings*7)",
      "return ok({path=root:GetFullName(),emitters=emitters,lights=lights,beams=beams,trails=trails,neon_parts=neon,rate_per_second=rate,score=score,errors=errors,warnings=warnings,issues=issues},'VFX audit of '..root:GetFullName()..': score '..score..' ('..errors..' errors, '..warnings..' warnings; '..emitters..' emitters, '..lights..' lights, '..beams..' beams, '..trails..' trails)'..(errors>0 and ' - fix the errors (vfx_play a TotalVFX family instead of hand-built loops)' or ''))",
    ].join("\n");
  };

  B.vfx_families = () => [
    "local lib,mod=loadRuntime()",
    "return ok({families=lib.families(),palettes=lib.PALETTES,tiers=lib.TIERS,default_palette=mod:GetAttribute('DefaultPalette'),default_tier=mod:GetAttribute('DefaultTier') or 'auto'},'" + FAMILY_NAMES.length + " TotalVFX families: " + FAMILY_NAMES.join(", ") + "')",
  ].join("\n");

  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const FAM_DESC = FAMILY_NAMES.join(" | ");
  const C = [
    { name: "vfx_library_install", description: "Install / upgrade the TotalVFX runtime (ReplicatedStorage.TotalVFX ModuleScript + Replicate RemoteEvent + StarterPlayerScripts.TotalVFXClient): " + FAMILY_NAMES.length + " spec-driven effect families (" + FAM_DESC + ") with staged lifecycles (flash / burst / stream / ring / beam / trail / shell / sound layers), 3+ key curves, palettes (art direction) and High/Medium/Low tier budgets; every effect cleans itself up. Gameplay code: require(ReplicatedStorage.TotalVFX).play(family, where, opts) / .cast on the server.", params: { theme: S("string", false, "default palette: ember, frost, arcane, holy, void, nature, toxic, electric, steel, blood, dust (or genre)"), genre: S("string", false, "fantasy, scifi, horror, cozy, nature, winter, city, cartoon... picks the palette"), tier: S("string", false, "force High / Medium / Low (default auto: Medium on touch devices)") } },
    { name: "vfx_play", description: "Play one TotalVFX family right now at a path (BasePart / Attachment / Model) or position - installs the runtime if needed, auto-cleans when done. Use it to preview and judge (total_screenshot), and in sequences / scripts via TotalVFX.play. Families: " + FAM_DESC + ".", params: { family: S("string", true, FAM_DESC), path: S("string", false, "dotted path of the host (BasePart / Attachment / Model); omit with position"), position: S("array", false, "[x,y,z] world position when there is no host"), normal: S("array", false, "[x,y,z] direction the effect points along (hit normal, aim); default up / host look"), palette: S("string", false, "ember, frost, arcane, holy, void, nature, toxic, electric, steel, blood, dust (default: project theme or family default)"), tier: S("string", false, "High / Medium / Low"), scale: S("number", false, "0.2-6 size multiplier (default 1)"), duration: S("number", false, "seconds for sustained families (fire, smoke, aura, shield, charge, projectile)") } },
    { name: "vfx_theme_set", description: "Set the project's default VFX palette (and optionally tier) so every effect shares one art direction.", params: { palette: S("string", false, "ember, frost, arcane, holy, void, nature, toxic, electric, steel, blood, dust"), genre: S("string", false, "fantasy, medieval, scifi, cyberpunk, horror, cozy, nature, desert, winter, tropical, city, cartoon, simulator, obby, candy, anime, military, pirate"), tier: S("string", false, "High / Medium / Low") } },
    { name: "vfx_validate", description: "Audit an existing effect (Part / Attachment / Model / Folder) against production rules: emitter and light counts, live-particle budget, constant sizes, 2-key fades, missing textures, one-shots that run forever, opaque Neon blocks. Returns a score and a defect list with paths.", params: { path: S("string", true, "dotted path of the effect root") } },
    { name: "vfx_families", hidden: true, description: "List TotalVFX families, palettes and tier budgets.", params: {} },
  ];

  function buildVfx(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))";
      return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + (e && e.message || e) };
    }
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = buildVfx(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const names = new Set(C.map((c) => c.name));
  const arr = RobloxScriptSkills.SKILL_COMMANDS; // mutate in place (describeCommands keeps this reference)
  for (let i = arr.length - 1; i >= 0; i--) if (names.has(arr[i].name)) arr.splice(i, 1);
  for (const c of C) arr.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.VFX_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.VFX_FAMILIES = FAMILIES;
  RobloxScriptSkills.VFX_FAMILY_NAMES = FAMILY_NAMES;
  RobloxScriptSkills.VFX_PALETTES = PALETTES;
  RobloxScriptSkills.VFX_TIERS = TIERS;
  RobloxScriptSkills.VFX_GENRE_PALETTE = GENRE_PALETTE;
  RobloxScriptSkills.VFX_RUNTIME_SRC = RUNTIME_SRC;
  RobloxScriptSkills.VFX_CLIENT_SRC = CLIENT_SRC;
  RobloxScriptSkills.VFX_VERSION = VERSION;
  RobloxScriptSkills.vfxValidateFamily = validateFamily;
  RobloxScriptSkills.vfxValidateAll = validateAll;
  RobloxScriptSkills.vfxSfxEventsUsed = sfxEventsUsed;
  RobloxScriptSkills.luaLiteral = lua;
})();
