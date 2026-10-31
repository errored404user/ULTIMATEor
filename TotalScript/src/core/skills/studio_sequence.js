// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript sequence pack (1.99.1) - ONE timeline for camera, animation,
// VFX, SFX, lighting, UI and gameplay signals, layered on RobloxScriptSkills
// like studio_cutscene.js.
//
// Why (Phase 115 audit): cutscenes moved the camera, animations played on a
// rig, effects were spawned by hand and sounds were loose instances - nothing
// shared a clock, so "fireball: pose, camera punch, charge, release, impact,
// recovery, UI" was a chain of task.wait() guesses in a generated script.
// A sequence is structured data:
//
//   { name, duration, tier, palette, options = {restore_camera, cancel_on_death},
//     events = [ {t, kind, duration?, side?, ...kind fields} ] }
//   kinds: camera | animation | vfx | sfx | light | ui | tween | signal
//
// One Heartbeat scheduler starts every event at its time, updates the running
// ones, finishes them at t + duration and cleans up (camera / lighting / UI
// restored, effects stopped, tracks stopped) on completion, Stop(), Skip(),
// death or respawn. Cosmetic kinds run on the client, signals on both sides
// (gameplay code applies damage on the server when the "hit" signal fires).
//
//   ReplicatedStorage.TotalSequences/
//     SequenceRunner   ModuleScript  - runtime (client + server + Studio preview)
//     PlaySequence     RemoteEvent   - server -> client play / cancel, client -> server done
//     Signal           BindableEvent - (sequenceName, signalName, value, player)
//     <Name>           ModuleScript  - one sequence (SpecJSON attribute + readable source)
//   StarterPlayer.StarterPlayerScripts.TotalSequenceClient  LocalScript
//
// Commands: sequence_create, ability_sequence_create, sequence_validate,
//           sequence_preview, sequence_play, sequence_stop, sequence_list, sequence_delete.
// Conventions as in studio_vfxpro.js (plain Lua 5.4 runtime, no raw newline in a Luau string).
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const VERSION = "1.99.8";
  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  const num = (v) => { const x = Number(v); return isFinite(x) ? x : null; };
  const ident = (v, d) => { const s = String(v || d || "Sequence").replace(/[^A-Za-z0-9_]/g, ""); return /^[A-Za-z_]/.test(s) ? s : "_" + s; };
  const lua = RobloxScriptSkills.luaLiteral;
  const VFX_FAMILIES = RobloxScriptSkills.VFX_FAMILY_NAMES || [];
  const SFX_CATALOGUE = RobloxScriptSkills.SFX_CATALOGUE || {};

  const KINDS = ["camera", "animation", "vfx", "sfx", "light", "ui", "tween", "signal"];
  const CLIENT_KINDS = { camera: 1, animation: 1, vfx: 1, sfx: 1, light: 1, ui: 1 };
  const CAM_PRESETS = ["wide", "closeup", "hero_low", "top_down", "side", "behind", "over_shoulder"];
  const LIMBS = ["right_hand", "left_hand", "head", "torso", "root", "right_foot", "left_foot"];
  const TIER_BUDGET = { High: { vfx: 4, events: 80 }, Medium: { vfx: 3, events: 60 }, Low: { vfx: 2, events: 40 } };

  // ── JS-side structural validation (no place access) ──────────────────────
  function normalizeSpec(a) {
    const spec = { name: ident(a.name, "Sequence"), duration: num(a.duration), tier: a.tier ? String(a.tier) : "High", palette: a.palette ? String(a.palette) : null, options: {}, events: [] };
    const o = a.options || {};
    spec.options.restore_camera = o.restore_camera !== false && a.restore_camera !== false;
    spec.options.cancel_on_death = o.cancel_on_death !== false && a.cancel_on_death !== false;
    spec.options.skippable = o.skippable === true || a.skippable === true;
    let events = Array.isArray(a.events) ? a.events.slice() : [];
    if (Array.isArray(a.tracks)) for (const tr of a.tracks) if (tr && Array.isArray(tr.events)) for (const ev of tr.events) events.push(Object.assign({ track: tr.id || tr.name }, ev));
    spec.events = events.filter((e) => e && typeof e === "object").map((e, i) => {
      const ev = Object.assign({}, e);
      ev.t = num(ev.t !== undefined ? ev.t : ev.time !== undefined ? ev.time : ev.at_time);
      ev.kind = String(ev.kind || ev.type || "").toLowerCase();
      if (ev.duration !== undefined) ev.duration = num(ev.duration);
      ev.index = i + 1;
      return ev;
    });
    if (spec.duration === null) { let end = 0; for (const ev of spec.events) end = Math.max(end, (ev.t || 0) + (ev.duration || 0) + (ev.kind === "vfx" || ev.kind === "sfx" ? 1 : 0)); spec.duration = Math.max(0.5, Math.round(end * 100) / 100); }
    return spec;
  }

  function validateSpec(spec) {
    const issues = [];
    const add = (level, code, msg, ev) => issues.push({ level, code, msg, event: ev ? ev.index : undefined, t: ev ? ev.t : undefined });
    if (!spec.events.length) add("error", "empty", "a sequence needs at least one event");
    if (!(spec.duration > 0)) add("error", "duration", "duration must be > 0");
    if (!TIER_BUDGET[spec.tier]) add("error", "tier", "tier must be High, Medium or Low");
    const budget = TIER_BUDGET[spec.tier] || TIER_BUDGET.High;
    if (spec.events.length > budget.events) add("error", "too-many-events", spec.events.length + " events exceed the " + spec.tier + " budget (" + budget.events + ")");
    const cams = [];
    for (const ev of spec.events) {
      if (ev.t === null || ev.t < 0) add("error", "time", "event " + ev.index + " has no start time t >= 0", ev);
      if (!KINDS.includes(ev.kind)) { add("error", "kind", "event " + ev.index + ": unknown kind '" + ev.kind + "' (" + KINDS.join(", ") + ")", ev); continue; }
      if (ev.duration !== undefined && !(ev.duration >= 0)) add("error", "duration", "event " + ev.index + ": duration must be >= 0", ev);
      if (ev.t !== null && spec.duration > 0 && ev.t > spec.duration) add("error", "after-end", "event " + ev.index + " (" + ev.kind + ") starts at " + ev.t + "s, after the sequence ends at " + spec.duration + "s - it would never fire", ev);
      if (ev.t !== null && ev.duration && ev.t + ev.duration > spec.duration + 1e-6) add("warning", "clipped", "event " + ev.index + " (" + ev.kind + ") runs past the end (" + (ev.t + ev.duration) + "s > " + spec.duration + "s) and will be cut", ev);
      if (ev.side && !/^(client|server|both)$/.test(ev.side)) add("error", "side", "event " + ev.index + ": side must be client, server or both", ev);
      switch (ev.kind) {
        case "camera": {
          const shot = ev.shot || ev;
          if (!shot.position && !shot.target && !shot.part && !shot.cframe && !ev.shake && !ev.fov_punch) add("error", "camera-shot", "event " + ev.index + ": camera needs a shot ({position, look_at} | {target, preset}) or a shake / fov_punch", ev);
          if (shot.preset && !CAM_PRESETS.includes(String(shot.preset))) add("error", "camera-preset", "event " + ev.index + ": unknown camera preset '" + shot.preset + "' (" + CAM_PRESETS.join(", ") + ")", ev);
          if (ev.shake && num(ev.shake.amplitude) > 1.5) add("warning", "shake", "event " + ev.index + ": shake amplitude " + ev.shake.amplitude + " is capped at 1.5 studs (restraint)", ev);
          if (shot.position || shot.target || shot.part || shot.cframe) cams.push(ev);
          break;
        }
        case "animation":
          if (!ev.animation && !ev.clip && !ev.id) add("error", "animation", "event " + ev.index + ": animation needs animation (Animation instance path or asset id)", ev);
          if (!ev.rig && !ev.actor) add("error", "animation-rig", "event " + ev.index + ": animation needs rig ('player' or a Model path)", ev);
          break;
        case "vfx":
          if (!ev.family) add("error", "vfx-family", "event " + ev.index + ": vfx needs family", ev);
          else if (VFX_FAMILIES.length && !VFX_FAMILIES.includes(String(ev.family))) add("error", "vfx-family", "event " + ev.index + ": unknown vfx family '" + ev.family + "' (" + VFX_FAMILIES.join(", ") + ")", ev);
          if (ev.at === undefined && !ev.path && !ev.position) add("error", "vfx-at", "event " + ev.index + ": vfx needs at ('player' | path | {actor, limb} | [x,y,z])", ev);
          if (ev.at && typeof ev.at === "object" && !Array.isArray(ev.at) && ev.at.limb && !LIMBS.includes(String(ev.at.limb))) add("error", "limb", "event " + ev.index + ": unknown limb '" + ev.at.limb + "' (" + LIMBS.join(", ") + ")", ev);
          break;
        case "sfx":
          if (!ev.event) add("error", "sfx-event", "event " + ev.index + ": sfx needs event", ev);
          else if (Object.keys(SFX_CATALOGUE).length && SFX_CATALOGUE[ev.event] && !SFX_CATALOGUE[ev.event].ids.length) add("warning", "sfx-missing", "event " + ev.index + ": sfx event '" + ev.event + "' has no engine-bundled asset - define it with sfx_event_define or it plays nothing", ev);
          break;
        case "light":
          if (!ev.props && !ev.effect) add("error", "light", "event " + ev.index + ": light needs props (Lighting properties) and/or effect (ColorCorrection | Bloom | Blur) with props", ev);
          break;
        case "ui":
          if (!ev.text) add("error", "ui-text", "event " + ev.index + ": ui needs text", ev);
          if (!(ev.duration > 0)) add("error", "ui-duration", "event " + ev.index + ": ui needs duration > 0", ev);
          break;
        case "tween":
          if (!ev.path || !ev.props) add("error", "tween", "event " + ev.index + ": tween needs path and props", ev);
          if (!(ev.duration > 0)) add("error", "tween-duration", "event " + ev.index + ": tween needs duration > 0", ev);
          break;
        case "signal":
          if (!ev.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(ev.name))) add("error", "signal-name", "event " + ev.index + ": signal needs an identifier name (e.g. hit, fire_projectile)", ev);
          break;
      }
    }
    cams.sort((a, b) => a.t - b.t);
    for (let i = 1; i < cams.length; i++) { const p = cams[i - 1]; const pe = p.t + (p.duration || 0); if (cams[i].t < pe - 1e-6) add("error", "camera-overlap", "camera events " + p.index + " and " + cams[i].index + " overlap (" + p.t + "-" + pe + "s vs " + cams[i].t + "s) - one camera, one move at a time", cams[i]); }
    const vfx = spec.events.filter((e) => e.kind === "vfx" && e.t !== null);
    for (const e of vfx) { const end = e.t + (e.duration || 1); const live = vfx.filter((o) => o.t <= e.t && o.t + (o.duration || 1) > e.t).length; if (live > budget.vfx) { add("error", "vfx-budget", live + " effects alive at " + e.t + "s exceed the " + spec.tier + " budget (" + budget.vfx + ")", e); break; } void end; }
    const ui = spec.events.filter((e) => e.kind === "ui" && e.t !== null).sort((a, b) => a.t - b.t);
    for (let i = 1; i < ui.length; i++) if (ui[i].t < ui[i - 1].t + (ui[i - 1].duration || 0)) add("warning", "ui-overlap", "ui events " + ui[i - 1].index + " and " + ui[i].index + " overlap - the second replaces the first", ui[i]);
    const errors = issues.filter((i) => i.level === "error").length;
    return { ok: errors === 0, errors, warnings: issues.length - errors, issues };
  }

  // ── ability templates: anticipation -> camera -> charge -> release -> impact -> recovery -> UI -> cleanup ──
  // Every template is data; the sequence runner never has a hard-coded ability.
  function abilityTemplate(kind, o) {
    const rig = o.rig || "player";
    const target = o.target || null;
    const pal = o.palette || null;
    const hand = o.hand === "left" ? "left_hand" : "right_hand";
    const anim = o.animation || null;
    const label = o.label || (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, " "));
    const at = (limb) => ({ actor: rig, limb });
    const P = (x) => (pal ? Object.assign({ palette: pal }, x) : x);
    const base = { name: o.name, tier: o.tier || "High", palette: pal, options: { restore_camera: true, cancel_on_death: true } };
    const E = [];
    const push = (ev) => E.push(ev);
    const animEv = (t, fade) => { if (anim) push({ t, kind: "animation", rig, animation: anim, fade: fade || 0.1, priority: "Action" }); };
    const feet = () => ({ actor: rig, limb: "root", offset: [0, -2.8, 0] });
    const tgt = () => (target ? target : { actor: rig, limb: "root", offset: [0, 0, -14] });
    const ui = (t, text) => push({ t, kind: "ui", text, style: "toast", duration: 1.2 });
    switch (kind) {
      case "fireball":
        animEv(0);
        push({ t: 0, kind: "camera", fov_punch: { amount: -4, duration: 0.7 } });
        push({ t: 0, kind: "vfx", family: "charge", at: at(hand), duration: 0.7, palette: pal || "ember" });
        push({ t: 0, kind: "sfx", event: "charge", at: at(hand) });
        push({ t: 0.7, kind: "vfx", family: "release", at: at(hand), normal: "aim", palette: pal || "ember" });
        push({ t: 0.7, kind: "sfx", event: "release", at: at(hand) });
        push({ t: 0.7, kind: "camera", shake: { amplitude: 0.35, frequency: 18, decay: 0.3 } });
        push({ t: 0.72, kind: "signal", name: "fire_projectile", value: "fireball" });
        push({ t: 0.72, kind: "vfx", family: "projectile", at: at(hand), to: target || undefined, duration: 0.45, arc: 1, palette: pal || "ember" });
        push({ t: 1.15, kind: "vfx", family: "explosion", at: tgt(), scale: 0.8, palette: pal || "ember" });
        push({ t: 1.15, kind: "sfx", event: "explosion", at: tgt() });
        push({ t: 1.15, kind: "camera", shake: { amplitude: 0.9, frequency: 16, decay: 0.45 } });
        push({ t: 1.15, kind: "signal", name: "hit", value: "fireball" });
        push({ t: 1.2, kind: "light", effect: "ColorCorrection", props: { Brightness: 0.08, Contrast: 0.1 }, duration: 0.35, tween: 0.05 });
        ui(1.3, label);
        return Object.assign(base, { duration: 2.6, events: E });
      case "slash":
        animEv(0);
        push({ t: 0, kind: "sfx", event: "unsheath", at: at(hand) });
        push({ t: 0.25, kind: "vfx", family: "slash", at: { actor: rig, limb: "torso", offset: [0, 0, -2.5] }, normal: "aim", palette: pal || "steel" });
        push({ t: 0.25, kind: "sfx", event: "swing", at: at(hand) });
        push({ t: 0.32, kind: "signal", name: "hit_window_open", value: "slash" });
        push({ t: 0.38, kind: "vfx", family: "impact", at: tgt(), normal: "aim", palette: pal || "steel" });
        push({ t: 0.38, kind: "vfx", family: "hit_confirm", at: tgt(), palette: pal || "steel" });
        push({ t: 0.38, kind: "sfx", event: "impact", at: tgt() });
        push({ t: 0.38, kind: "camera", shake: { amplitude: 0.3, frequency: 22, decay: 0.2 } });
        push({ t: 0.38, kind: "signal", name: "hit", value: "slash" });
        push({ t: 0.55, kind: "signal", name: "hit_window_close", value: "slash" });
        return Object.assign(base, { duration: 1.3, events: E });
      case "heal":
        animEv(0, 0.2);
        push({ t: 0, kind: "vfx", family: "charge", at: at(hand), duration: 0.5, palette: pal || "nature" });
        push({ t: 0.5, kind: "vfx", family: "heal", at: feet(), palette: pal || "nature" });
        push({ t: 0.5, kind: "sfx", event: "heal", at: feet() });
        push({ t: 0.5, kind: "signal", name: "heal", value: 25 });
        push({ t: 0.5, kind: "light", effect: "ColorCorrection", props: { Saturation: 0.15, Brightness: 0.04 }, duration: 0.8, tween: 0.2 });
        ui(0.6, label);
        return Object.assign(base, { duration: 2.0, events: E });
      case "shield":
        animEv(0, 0.15);
        push({ t: 0, kind: "vfx", family: "release", at: at(hand), scale: 0.5, normal: "aim", palette: pal || "frost" });
        push({ t: 0.1, kind: "vfx", family: "shield", at: { actor: rig, limb: "torso" }, duration: o.shield_duration || 4, palette: pal || "frost" });
        push({ t: 0.1, kind: "sfx", event: "shield", at: at("torso") });
        push({ t: 0.1, kind: "signal", name: "shield_on", value: o.shield_duration || 4 });
        ui(0.2, label);
        push({ t: 0.1 + (o.shield_duration || 4), kind: "signal", name: "shield_off", value: 0 });
        return Object.assign(base, { duration: 0.3 + (o.shield_duration || 4), events: E });
      case "dash":
        animEv(0, 0.05);
        push({ t: 0, kind: "vfx", family: "dash", at: { actor: rig, limb: "root" }, normal: "back", duration: 0.35, palette: pal || "steel" });
        push({ t: 0, kind: "sfx", event: "whoosh", at: at("root") });
        push({ t: 0, kind: "camera", fov_punch: { amount: 6, duration: 0.35 } });
        push({ t: 0, kind: "signal", name: "dash_start", value: o.distance || 18 });
        push({ t: 0.3, kind: "vfx", family: "dust", at: feet(), palette: pal || "dust" });
        push({ t: 0.3, kind: "signal", name: "dash_end", value: 0 });
        return Object.assign(base, { duration: 0.8, events: E });
      case "teleport":
        animEv(0, 0.1);
        push({ t: 0, kind: "vfx", family: "charge", at: { actor: rig, limb: "torso" }, duration: 0.35, palette: pal || "arcane" });
        push({ t: 0.35, kind: "vfx", family: "teleport", at: feet(), palette: pal || "arcane" });
        push({ t: 0.35, kind: "sfx", event: "teleport", at: feet() });
        push({ t: 0.35, kind: "light", effect: "Blur", props: { Size: 10 }, duration: 0.25, tween: 0.05 });
        push({ t: 0.4, kind: "signal", name: "teleport", value: o.distance || 20 });
        push({ t: 0.45, kind: "vfx", family: "teleport", at: feet(), palette: pal || "arcane", scale: 0.8 });
        push({ t: 0.45, kind: "camera", shake: { amplitude: 0.25, frequency: 14, decay: 0.25 } });
        return Object.assign(base, { duration: 1.3, events: E });
      case "ground_slam":
        animEv(0);
        push({ t: 0, kind: "camera", fov_punch: { amount: -3, duration: 0.5 } });
        push({ t: 0, kind: "vfx", family: "charge", at: at(hand), duration: 0.45, palette: pal || "ember" });
        push({ t: 0, kind: "sfx", event: "charge", at: at(hand) });
        push({ t: 0.5, kind: "vfx", family: "impact", at: feet(), scale: 1.6, palette: pal || "ember" });
        push({ t: 0.5, kind: "vfx", family: "dust", at: feet(), scale: 1.8, palette: pal || "dust" });
        push({ t: 0.5, kind: "sfx", event: "explosion", at: feet(), volume: 0.7 });
        push({ t: 0.5, kind: "camera", shake: { amplitude: 1.2, frequency: 14, decay: 0.6 } });
        push({ t: 0.5, kind: "signal", name: "hit", value: "ground_slam" });
        push({ t: 0.55, kind: "light", effect: "ColorCorrection", props: { Contrast: 0.15 }, duration: 0.3, tween: 0.05 });
        ui(0.7, label);
        return Object.assign(base, { duration: 2.0, events: E });
      default:
        return null;
    }
  }
  const ABILITIES = ["fireball", "slash", "heal", "shield", "dash", "teleport", "ground_slam"];

  // ── runtime ───────────────────────────────────────────────────────────────
  const RUNTIME_SRC = [
    "-- TotalScript sequence runtime (SequenceRunner) " + VERSION + " - generated by sequence_create. One clock for camera, animation, VFX, SFX, lighting, UI and signals.",
    "-- Runner.play(specOrName, ctx) -> handle {Stop(reason), Pause(), Resume(), Skip(), IsPlaying(), Completed (signal: reason), state}",
    "--   ctx = {side='client'|'server'|'preview', player=Player, character=Model, target=Instance, speed=1}",
    "-- Runner.cast(name, player, ctx) (server) -> fires PlaySequence to that player (nil = everyone) and runs the server-side events here.",
    "-- Runner.cancel(name, player) (server) / Runner.stopAll() / Runner.validate(spec, ctx) -> {ok, errors, warnings, issues} / Runner.load(name) -> spec",
    "-- Signals: ReplicatedStorage.TotalSequences.Signal.Event:Connect(function(sequenceName, signalName, value, player) end) - apply damage / spawn projectiles here (server authoritative).",
    "local RunService = game:GetService('RunService')",
    "local Players = game:GetService('Players')",
    "local TweenService = game:GetService('TweenService')",
    "local Lighting = game:GetService('Lighting')",
    "local ReplicatedStorage = game:GetService('ReplicatedStorage')",
    "local HttpService = game:GetService('HttpService')",
    "local M = {}",
    "M.VERSION = '" + VERSION + "'",
    "M.KINDS = " + lua(KINDS),
    "M.TIER_BUDGET = " + lua(TIER_BUDGET),
    "local active = {}",
    "local stepConn = nil",
    "local rng = Random.new()",
    "local R15 = {right_hand = 'RightHand', left_hand = 'LeftHand', head = 'Head', torso = 'UpperTorso', root = 'HumanoidRootPart', right_foot = 'RightFoot', left_foot = 'LeftFoot'}",
    "local R6 = {right_hand = 'Right Arm', left_hand = 'Left Arm', head = 'Head', torso = 'Torso', root = 'HumanoidRootPart', right_foot = 'Right Leg', left_foot = 'Left Leg'}",
    "local function resolve(p) if p == nil or p == '' then return nil end if typeof(p) == 'Instance' then return p end p = tostring(p):gsub('^game%.', '') local lp = p:lower() if lp == 'game' then return game end if lp == 'workspace' then return workspace end local cur = game for seg in p:gmatch('[^%.]+') do if cur == game and seg:lower() == 'workspace' then cur = workspace else local nxt = cur:FindFirstChild(seg) if not nxt and cur == game then local okS, svc = pcall(function() return game:GetService(seg) end) if okS then nxt = svc end end if not nxt then return nil end cur = nxt end end return cur end",
    "M.resolve = resolve",
    "local function vec(t, d) if typeof(t) == 'Vector3' then return t end if type(t) == 'table' and #t >= 3 then return Vector3.new(tonumber(t[1]) or 0, tonumber(t[2]) or 0, tonumber(t[3]) or 0) end return d end",
    "local function lib(name) local mod = ReplicatedStorage:FindFirstChild(name) if not mod or not mod:IsA('ModuleScript') then return nil, name .. ' not installed' end local okR, m = pcall(require, mod) if okR and type(m) == 'table' then return m end return nil, name .. ' failed to load: ' .. tostring(m) end",
    "local function humanoidOf(model) return model and model:FindFirstChildOfClass('Humanoid') or nil end",
    "function M.rigType(model) local hum = humanoidOf(model) if hum then local okT, rt = pcall(function() return hum.RigType end) if okT and rt == Enum.HumanoidRigType.R6 then return 'R6' end if okT and rt == Enum.HumanoidRigType.R15 then return 'R15' end end if model and model:FindFirstChild('UpperTorso') then return 'R15' end if model and model:FindFirstChild('Torso') then return 'R6' end return 'Custom' end",
    "function M.limb(model, role) if not model then return nil, 'no rig' end local rt = M.rigType(model) local map = rt == 'R6' and R6 or R15 local name = map[role] if not name then return nil, 'unknown limb ' .. tostring(role) end local part = model:FindFirstChild(name) if not part then local alt = (rt == 'R6' and R15 or R6)[role] part = alt and model:FindFirstChild(alt) or nil end if not part then return nil, 'rig ' .. model.Name .. ' (' .. rt .. ') has no ' .. name end return part end",
    "local function actorOf(h, ref) if ref == nil or ref == 'player' or ref == 'self' then return h.ctx.character end if ref == 'target' then return h.ctx.target end return resolve(ref) end",
    "local function whereOf(h, at, offset) if at == nil then return nil, 'no at' end if type(at) == 'table' and #at >= 3 then return CFrame.new(vec(at)), nil end if type(at) == 'table' then local actor = actorOf(h, at.actor) if not actor then return nil, 'actor not found: ' .. tostring(at.actor) end local host = actor if actor:IsA('Model') then if at.limb then local part, err = M.limb(actor, at.limb) if not part then return nil, err end host = part else host = actor.PrimaryPart or actor:FindFirstChild('HumanoidRootPart') or actor:FindFirstChildWhichIsA('BasePart') end end local off = vec(at.offset or offset, nil) if off and host and host:IsA('BasePart') then local a = Instance.new('Attachment') a.Name = 'TotalSequence_At' a.Position = off a.Parent = host h.owned[#h.owned + 1] = a return a, nil end return host, nil end local inst = actorOf(h, at) if not inst then return nil, 'at not found: ' .. tostring(at) end if inst:IsA('Model') then return inst.PrimaryPart or inst:FindFirstChild('HumanoidRootPart') or inst:FindFirstChildWhichIsA('BasePart') or inst, nil end return inst, nil end",
    "local function posOf(x) if typeof(x) == 'CFrame' then return x.Position end if typeof(x) == 'Instance' then if x:IsA('Attachment') then return x.WorldPosition end if x:IsA('BasePart') then return x.Position end if x:IsA('Model') then return x:GetPivot().Position end end return Vector3.new(0, 0, 0) end",
    "local function normalOf(h, ev, where) local n = ev.normal if type(n) == 'table' then return vec(n) end local actor = h.ctx.character if type(ev.at) == 'table' and ev.at.actor then actor = actorOf(h, ev.at.actor) or actor end local root = actor and (actor:FindFirstChild('HumanoidRootPart') or (actor:IsA('Model') and actor.PrimaryPart) or (actor:IsA('BasePart') and actor)) or nil if n == 'aim' and root then return root.CFrame.LookVector end if n == 'back' and root then return -root.CFrame.LookVector end if n == 'to_target' and h.ctx.target then return (posOf(h.ctx.target) - posOf(where)).Unit end if n == 'up' or n == nil then return nil end return nil end",
    "local function bboxOf(inst) if inst:IsA('BasePart') then return inst.CFrame, inst.Size end if inst:IsA('Model') then local cf, sz = inst:GetBoundingBox() return cf, sz end if inst:IsA('Attachment') then return inst.WorldCFrame, Vector3.new(1, 1, 1) end return CFrame.new(posOf(inst)), Vector3.new(4, 4, 4) end",
    "local function presetShot(targetInst, preset, dist, height) local c, sz = bboxOf(targetInst) local r = math.max(sz.X, sz.Y, sz.Z, 1) local look, right, up = c.LookVector, c.RightVector, Vector3.new(0, 1, 0) local f = ({closeup = 0.9, hero_low = 1.6, wide = 2.8, top_down = 2.5, side = 2.2, behind = 2.0, over_shoulder = 1.2})[preset or 'wide'] or 2.8 local d = tonumber(dist) or r * f local pos, aim = c.Position + look * d + up * (tonumber(height) or r * 0.35), c.Position if preset == 'closeup' then pos = c.Position + look * d + up * (tonumber(height) or r * 0.25) elseif preset == 'hero_low' then pos = c.Position + look * d + up * (tonumber(height) or -r * 0.3) elseif preset == 'top_down' then pos = c.Position + up * d + look * 0.01 elseif preset == 'side' then pos = c.Position + right * d + up * (tonumber(height) or r * 0.2) elseif preset == 'behind' then pos = c.Position - look * d + up * (tonumber(height) or r * 0.45) elseif preset == 'over_shoulder' then pos = c.Position - look * d + right * r * 0.45 + up * (tonumber(height) or r * 0.45) aim = c.Position + look * r * 3 end return CFrame.lookAt(pos, aim), (preset == 'closeup') and 40 or nil end",
    "local function shotCFrame(h, shot) if shot.cframe and #shot.cframe >= 12 then local c = shot.cframe return CFrame.new(c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12]), shot.fov end if shot.part then local p = resolve(shot.part) if not p then error('camera part not found: ' .. tostring(shot.part)) end return p.CFrame, shot.fov end if shot.target then local t = actorOf(h, shot.target) if not t then error('camera target not found: ' .. tostring(shot.target)) end local cf, fov = presetShot(t, shot.preset, shot.distance, shot.height) return cf, shot.fov or fov end local pos = vec(shot.position) if not pos then error('camera shot needs position / target / part / cframe') end local look = shot.look_at if type(look) == 'string' then local li = actorOf(h, look) if not li then error('look_at not found: ' .. look) end look = posOf(li) else look = vec(look, pos + Vector3.new(0, 0, -1)) end local cf = CFrame.lookAt(pos, look) if shot.roll then cf = cf * CFrame.Angles(0, 0, math.rad(shot.roll)) end return cf, shot.fov end",
    "local function startAt(h, ev) if type(ev.t) == 'number' and ev.t <= h.elapsed and ev.t > h.elapsed - 0.5 then return ev.t end return h.elapsed end",
    "local function camState(h) local cam = workspace.CurrentCamera if not h.cam then h.cam = {cam = cam, prevType = cam.CameraType, prevCF = cam.CFrame, prevFov = cam.FieldOfView, prevSubject = cam.CameraSubject, base = cam.CFrame, baseFov = cam.FieldOfView, mode = 'overlay', last = CFrame.new(), bound = false, shake = nil, punch = nil} local okB = pcall(function() RunService:BindToRenderStep('TotalSequenceCam_' .. tostring(h.spec.name), Enum.RenderPriority.Camera.Value + 1, function() if h.cam and h.cam.mode == 'overlay' then h.cam.bound = true h.camOverlay() end end) end) h.cam.canBind = okB end return h.cam end",
    "local function camOffsets(h) local c = h.cam local off = CFrame.new() local dFov = 0 if c.punch then local p = c.punch local k = math.clamp((h.elapsed - p.t0) / p.duration, 0, 1) local env = k < 0.3 and (k / 0.3) or (1 - (k - 0.3) / 0.7) dFov = p.amount * env if k >= 1 then c.punch = nil end end if c.shake then local s = c.shake local k = math.clamp((h.elapsed - s.t0) / s.duration, 0, 1) local env = (1 - k) * (1 - k) if k >= 1 then c.shake = nil else local a = s.amplitude * env local ph = h.elapsed * s.frequency local ox = math.sin(ph * 1.0) * a * rng:NextNumber(0.6, 1) local oy = math.sin(ph * 1.3 + 1.7) * a * rng:NextNumber(0.6, 1) local rz = math.rad(math.sin(ph * 0.9 + 0.4) * s.rotation * env) off = CFrame.new(ox, oy, 0) * CFrame.Angles(0, 0, rz) end end return off, dFov end",
    "local function camApply(h) local c = h.cam if not c then return end local off, dFov = camOffsets(h) if c.mode == 'scripted' then c.cam.CFrame = c.base * off c.cam.FieldOfView = c.baseFov + dFov else c.cam.FieldOfView = c.prevFov + dFov if not c.bound then c.cam.CFrame = c.cam.CFrame * c.last:Inverse() * off c.last = off end end end",
    "local function camOverlayFrame(h) local c = h.cam if not c or c.mode ~= 'overlay' then return end local off = camOffsets(h) c.cam.CFrame = c.cam.CFrame * off end",
    "local function camRestore(h) local c = h.cam if not c then return end pcall(function() RunService:UnbindFromRenderStep('TotalSequenceCam_' .. tostring(h.spec.name)) end) if c.mode == 'overlay' then c.cam.FieldOfView = c.prevFov if not c.bound then c.cam.CFrame = c.cam.CFrame * c.last:Inverse() end else c.cam.FieldOfView = c.prevFov local restoreType = c.prevType or Enum.CameraType.Custom if h.spec.options and h.spec.options.restore_camera == false then c.cam.CameraType = restoreType else c.cam.CameraType = restoreType c.cam.CFrame = c.prevCF if c.prevSubject then c.cam.CameraSubject = c.prevSubject end end end h.cam = nil end",
    "local handlers = {}",
    "handlers.camera = function(h, ev) local c = camState(h) local run = {} if ev.shake then c.shake = {t0 = startAt(h, ev), amplitude = math.clamp(tonumber(ev.shake.amplitude) or 0.5, 0, 1.5), frequency = math.clamp(tonumber(ev.shake.frequency) or 16, 1, 40), duration = math.clamp(tonumber(ev.shake.decay) or 0.4, 0.05, 3), rotation = math.clamp(tonumber(ev.shake.rotation) or 1.5, 0, 2.5)} end if ev.fov_punch then c.punch = {t0 = startAt(h, ev), amount = math.clamp(tonumber(ev.fov_punch.amount) or -4, -20, 20), duration = math.clamp(tonumber(ev.fov_punch.duration) or 0.4, 0.05, 3)} end local shot = ev.shot or ev if shot.position or shot.target or shot.part or shot.cframe then if c.mode ~= 'scripted' then if not c.bound then c.cam.CFrame = c.cam.CFrame * c.last:Inverse() end c.last = CFrame.new() c.mode = 'scripted' c.base = c.cam.CFrame c.baseFov = c.prevFov c.cam.CameraType = Enum.CameraType.Scriptable end local toCF, toFov = shotCFrame(h, shot) toFov = toFov or c.baseFov local travel = tonumber(ev.duration) or 0 if travel <= 0 or ev.move == 'cut' or not h.camMoved then c.base = toCF c.baseFov = toFov h.camMoved = true else run.fromCF, run.fromFov, run.toCF, run.toFov, run.travel = c.base, c.baseFov, toCF, toFov, travel run.style = Enum.EasingStyle[ev.easing or 'Sine'] or Enum.EasingStyle.Sine run.dir = Enum.EasingDirection[ev.direction or 'InOut'] or Enum.EasingDirection.InOut run.track = shot.track and actorOf(h, shot.track) or nil run.pos = toCF.Position end end run.update = function(dt, age) if run.toCF then local k = math.clamp(age / run.travel, 0, 1) local e = TweenService:GetValue(k, run.style, run.dir) local toCF = run.toCF if run.track then toCF = CFrame.lookAt(run.pos, posOf(run.track)) end c.base = run.fromCF:Lerp(toCF, e) c.baseFov = run.fromFov + (run.toFov - run.fromFov) * e if k >= 1 then run.toCF = nil end end camApply(h) return true end run.finish = function() end return run end",
    "handlers.animation = function(h, ev) local rig = actorOf(h, ev.rig or ev.actor) if not rig or not rig:IsA('Model') then return nil, 'animation rig not found: ' .. tostring(ev.rig or ev.actor) end local hum = humanoidOf(rig) if not hum then return nil, 'rig ' .. rig.Name .. ' has no Humanoid' end local animator = hum:FindFirstChildOfClass('Animator') if not animator then animator = Instance.new('Animator') animator.Parent = hum end local src = ev.animation or ev.clip or ev.id local anim = nil if typeof(src) == 'Instance' then anim = src elseif type(src) == 'string' and (src:match('^rbxassetid://%d+$') or src:match('^%d+$')) or type(src) == 'number' then anim = Instance.new('Animation') anim.Name = 'TotalSequence_' .. tostring(src) anim.AnimationId = (type(src) == 'number' or tostring(src):match('^%d+$')) and ('rbxassetid://' .. tostring(src)) or src h.owned[#h.owned + 1] = anim else anim = resolve(src) end if not anim or not anim:IsA('Animation') then return nil, 'animation not found: ' .. tostring(src) end if anim.AnimationId == '' then return nil, 'Animation ' .. anim:GetFullName() .. ' has no AnimationId (publish the clip first: animation_publish)' end local okL, track = pcall(function() return animator:LoadAnimation(anim) end) if not okL or not track then return nil, 'LoadAnimation failed: ' .. tostring(track) end local run = {track = track, conns = {}} if ev.priority and type(track) == 'userdata' then pcall(function() track.Priority = Enum.AnimationPriority[ev.priority] end) end if ev.looped ~= nil then pcall(function() track.Looped = ev.looped == true end) end if type(ev.marker_events) == 'table' then for _, me in ipairs(ev.marker_events) do if me.marker and type(me.events) == 'table' then local okM, sig = pcall(function() return track:GetMarkerReachedSignal(me.marker) end) if okM and sig then run.conns[#run.conns + 1] = sig:Connect(function() for _, sub in ipairs(me.events) do h:startEvent(sub, true) end end) else h.skipped[#h.skipped + 1] = 'marker ' .. tostring(me.marker) .. ' (no marker signal here)' end end end end local okP, err = pcall(function() track:Play(tonumber(ev.fade) or 0.1, 1, tonumber(ev.speed) or 1) end) if not okP then return nil, 'track:Play failed: ' .. tostring(err) end run.update = function() return true end run.finish = function(reason) for _, c in ipairs(run.conns) do c:Disconnect() end if ev.on_stop ~= 'keep' or reason ~= 'completed' then pcall(function() track:Stop(tonumber(ev.fade) or 0.1) end) end end return run end",
    "handlers.vfx = function(h, ev) local VFX, err = lib('TotalVFX') if not VFX then return nil, err .. ' (run vfx_library_install)' end local where, werr = whereOf(h, ev.at or ev.path or ev.position) if not where then return nil, werr end local opts = {palette = ev.palette or h.spec.palette or nil, tier = ev.tier or h.spec.tier, scale = ev.scale, duration = ev.duration, density = ev.density} local n = normalOf(h, ev, where) if n then opts.normal = n end local travel = nil if ev.to ~= nil then local dest, derr = whereOf(h, ev.to) if not dest then return nil, derr end local p0 = posOf(where) local p1 = posOf(dest) local hostP = Instance.new('Part') hostP.Name = 'TotalSequence_Projectile' hostP.Size = Vector3.new(0.4, 0.4, 0.4) hostP.Transparency = 1 hostP.Anchored = true hostP.CanCollide = false hostP.CanQuery = false hostP.CanTouch = false hostP.CastShadow = false hostP.CFrame = CFrame.lookAt(p0, p1) hostP.Parent = workspace:FindFirstChild('TotalVFXRuntime') or workspace h.owned[#h.owned + 1] = hostP travel = {host = hostP, p0 = p0, dest = dest, t0 = startAt(h, ev), duration = math.max(0.05, tonumber(ev.duration) or 0.5), arc = tonumber(ev.arc) or 0} where = hostP opts.duration = nil end local okP, handle = pcall(VFX.play, ev.family, where, opts) if not okP then return nil, 'TotalVFX.play: ' .. tostring(handle) end local run = {handle = handle} run.update = function() if travel then local k = math.clamp((h.elapsed - travel.t0) / travel.duration, 0, 1) local p1 = posOf(travel.dest) local p = travel.p0:Lerp(p1, k) + Vector3.new(0, travel.arc * 4 * k * (1 - k), 0) local ahead = travel.p0:Lerp(p1, math.min(1, k + 0.02)) if (ahead - p).Magnitude > 1e-3 then travel.host.CFrame = CFrame.lookAt(p, ahead) else travel.host.CFrame = CFrame.new(p) end if k >= 1 then return false end end return handle:IsPlaying() end run.finish = function(reason) if handle:IsPlaying() then if reason == 'completed' or reason == 'event-end' then handle:Stop(reason) else handle:Destroy() end end if travel and travel.host then travel.host:Destroy() end end return run end",
    "handlers.sfx = function(h, ev) local SFX, err = lib('TotalSFX') if not SFX then return nil, err .. ' (run sfx_library_install)' end local where = nil if ev.at ~= nil then local w, werr = whereOf(h, ev.at) if not w then return nil, werr end where = w if typeof(where) == 'CFrame' then where = where.Position end end local s, reason = SFX.play(ev.event, where, {volume = ev.volume, loop = ev.loop}) if not s then return nil, 'sfx ' .. tostring(ev.event) .. ': ' .. tostring(reason) end local run = {sound = s} run.update = function() return ev.duration ~= nil end run.finish = function() if ev.loop or (ev.duration and s.Parent) then pcall(function() s:Stop() s:Destroy() end) end end return run end",
    "handlers.light = function(h, ev) local run = {restore = {}, tweens = {}} local function tw(inst, props, t) if t and t > 0 then local tween = TweenService:Create(inst, TweenInfo.new(t, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), props) tween:Play() run.tweens[#run.tweens + 1] = tween else for k, v in pairs(props) do inst[k] = v end end end local function conv(v) if type(v) == 'table' and #v >= 3 then return Color3.fromRGB(v[1], v[2], v[3]) end return v end if type(ev.props) == 'table' and not ev.effect then local props = {} for k, v in pairs(ev.props) do local okG, cur = pcall(function() return Lighting[k] end) if okG then run.restore[k] = cur props[k] = conv(v) else h.skipped[#h.skipped + 1] = 'Lighting.' .. tostring(k) .. ' (unknown property)' end end run.target = Lighting tw(Lighting, props, tonumber(ev.tween)) end if ev.effect then local cls = ({colorcorrection = 'ColorCorrectionEffect', bloom = 'BloomEffect', blur = 'BlurEffect', sunrays = 'SunRaysEffect', depthoffield = 'DepthOfFieldEffect'})[tostring(ev.effect):lower():gsub('effect$', '')] if not cls then return nil, 'unknown light effect ' .. tostring(ev.effect) end local fx = Instance.new(cls) fx.Name = 'TotalSequence_' .. cls local zero = {} local props = {} for k, v in pairs(ev.props or {}) do local okG, cur = pcall(function() return fx[k] end) if okG then zero[k] = cur props[k] = conv(v) end end fx.Parent = Lighting run.fx = fx run.zero = zero h.owned[#h.owned + 1] = fx tw(fx, props, tonumber(ev.tween)) end run.update = function() return true end run.finish = function() for _, t in ipairs(run.tweens) do pcall(function() t:Cancel() end) end local out = tonumber(ev.tween_out) or tonumber(ev.tween) or 0 if run.target then if out > 0 then local tween = TweenService:Create(Lighting, TweenInfo.new(out, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), run.restore) tween:Play() tween.Completed:Connect(function() end) else for k, v in pairs(run.restore) do Lighting[k] = v end end end if run.fx then if out > 0 and run.fx.Parent then local tween = TweenService:Create(run.fx, TweenInfo.new(out, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), run.zero) tween:Play() local fx = run.fx tween.Completed:Connect(function() fx:Destroy() end) else run.fx:Destroy() end end end return run end",
    "local function uiParent(h) local plr = h.ctx.player or Players.LocalPlayer if plr then local pg = plr:FindFirstChildOfClass('PlayerGui') if pg then return pg end end local okC, cg = pcall(function() return game:GetService('CoreGui') end) if okC and cg then return cg end return game:GetService('StarterGui') end",
    "handlers.ui = function(h, ev) local parent = uiParent(h) local gui = parent:FindFirstChild('TotalSequenceUI') if not gui then gui = Instance.new('ScreenGui') gui.Name = 'TotalSequenceUI' gui.ResetOnSpawn = false gui.IgnoreGuiInset = false gui.DisplayOrder = 50 pcall(function() gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets end) gui.Parent = parent h.owned[#h.owned + 1] = gui end local style = ev.style or 'toast' local old = gui:FindFirstChild('Message') if old then old:Destroy() end local frame = Instance.new('Frame') frame.Name = 'Message' frame.BackgroundColor3 = Color3.fromRGB(12, 14, 20) frame.BackgroundTransparency = 1 frame.BorderSizePixel = 0 frame.AnchorPoint = Vector2.new(0.5, style == 'subtitle' and 1 or (style == 'banner' and 0.5 or 0)) frame.Position = style == 'subtitle' and UDim2.new(0.5, 0, 1, -48) or (style == 'banner' and UDim2.new(0.5, 0, 0.42, 0) or UDim2.new(0.5, 0, 0, 24)) frame.Size = UDim2.new(0.6, 0, 0, style == 'banner' and 84 or 44) local sc = Instance.new('UISizeConstraint') sc.MinSize = Vector2.new(220, 36) sc.MaxSize = Vector2.new(720, 120) sc.Parent = frame local corner = Instance.new('UICorner') corner.CornerRadius = UDim.new(0, 10) corner.Parent = frame local stroke = Instance.new('UIStroke') stroke.Color = Color3.fromRGB(255, 255, 255) stroke.Transparency = 1 stroke.Thickness = 1 stroke.Parent = frame local pad = Instance.new('UIPadding') pad.PaddingLeft = UDim.new(0, 18) pad.PaddingRight = UDim.new(0, 18) pad.PaddingTop = UDim.new(0, 6) pad.PaddingBottom = UDim.new(0, 6) pad.Parent = frame local label = Instance.new('TextLabel') label.Name = 'Text' label.BackgroundTransparency = 1 label.Size = UDim2.new(1, 0, ev.subtitle and 0.6 or 1, 0) label.Font = Enum.Font.GothamBold label.Text = tostring(ev.text) label.TextScaled = true label.TextWrapped = true label.TextColor3 = ev.color and Color3.fromRGB(ev.color[1], ev.color[2], ev.color[3]) or Color3.fromRGB(245, 246, 250) label.TextTransparency = 1 label.TextStrokeTransparency = 0.75 label.Parent = frame local tsc = Instance.new('UITextSizeConstraint') tsc.MaxTextSize = style == 'banner' and 40 or 22 tsc.MinTextSize = 12 tsc.Parent = label local sub = nil if ev.subtitle then sub = Instance.new('TextLabel') sub.Name = 'Subtitle' sub.BackgroundTransparency = 1 sub.Position = UDim2.new(0, 0, 0.6, 0) sub.Size = UDim2.new(1, 0, 0.4, 0) sub.Font = Enum.Font.Gotham sub.Text = tostring(ev.subtitle) sub.TextScaled = true sub.TextWrapped = true sub.TextColor3 = Color3.fromRGB(200, 204, 214) sub.TextTransparency = 1 sub.Parent = frame local c2 = Instance.new('UITextSizeConstraint') c2.MaxTextSize = 18 c2.MinTextSize = 10 c2.Parent = sub end frame.Parent = gui local run = {frame = frame} local total = tonumber(ev.duration) or 1.5 local fadeIn, fadeOut = 0.15, 0.25 run.update = function(dt, age) local a = 1 if age < fadeIn then a = age / fadeIn elseif age > total - fadeOut then a = math.max(0, (total - age) / fadeOut) end if not frame.Parent then return false end label.TextTransparency = 1 - a if sub then sub.TextTransparency = 1 - a * 0.9 end frame.BackgroundTransparency = 1 - a * (style == 'subtitle' and 0.35 or 0.55) stroke.Transparency = 1 - a * 0.25 return true end run.finish = function() if frame.Parent then frame:Destroy() end if gui.Parent and #gui:GetChildren() == 0 then gui:Destroy() end end return run end",
    "handlers.tween = function(h, ev) local inst = resolve(ev.path) if not inst then return nil, 'tween path not found: ' .. tostring(ev.path) end local props = {} for k, v in pairs(ev.props or {}) do if type(v) == 'table' and #v >= 3 then local okG, cur = pcall(function() return inst[k] end) if okG and typeof(cur) == 'Color3' then props[k] = Color3.fromRGB(v[1], v[2], v[3]) elseif okG and typeof(cur) == 'Vector3' then props[k] = Vector3.new(v[1], v[2], v[3]) elseif okG and typeof(cur) == 'CFrame' and #v >= 12 then props[k] = CFrame.new(v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12]) elseif okG and typeof(cur) == 'CFrame' then props[k] = CFrame.new(v[1], v[2], v[3]) end else props[k] = v end end local tween = TweenService:Create(inst, TweenInfo.new(tonumber(ev.duration) or 0.5, Enum.EasingStyle[ev.easing or 'Quad'] or Enum.EasingStyle.Quad, Enum.EasingDirection[ev.direction or 'Out'] or Enum.EasingDirection.Out), props) tween:Play() local run = {tween = tween} run.update = function() return true end run.finish = function(reason) if reason ~= 'completed' and reason ~= 'event-end' then pcall(function() tween:Cancel() end) end end return run end",
    "handlers.signal = function(h, ev) local root = ReplicatedStorage:FindFirstChild('TotalSequences') local sig = root and root:FindFirstChild('Signal') if sig then sig:Fire(h.spec.name, ev.name, ev.value, h.ctx.player) end h.signals[#h.signals + 1] = ev.name local run = {} run.update = function() return false end run.finish = function() end return run end",
    "local function sideOf(ev) if ev.side then return ev.side end if ev.kind == 'signal' or ev.kind == 'tween' then return 'both' end return 'client' end",
    "local Handle = {} Handle.__index = Handle",
    "function Handle:startEvent(ev, fromMarker) local side = sideOf(ev) if self.ctx.side ~= 'preview' and side ~= 'both' and side ~= self.ctx.side then return end local fn = handlers[ev.kind] if not fn then self.skipped[#self.skipped + 1] = 'unknown kind ' .. tostring(ev.kind) return end local okS, run, err = pcall(fn, self, ev) if not okS then self.skipped[#self.skipped + 1] = tostring(ev.kind) .. '@' .. tostring(ev.t) .. ': ' .. tostring(run) return end if not run then self.skipped[#self.skipped + 1] = tostring(ev.kind) .. '@' .. tostring(ev.t) .. ': ' .. tostring(err) return end run.ev = ev local t0 = (not fromMarker and type(ev.t) == 'number' and ev.t <= self.elapsed and ev.t > self.elapsed - 0.5) and ev.t or self.elapsed run.t0 = t0 run.untilT = ev.duration and (t0 + ev.duration) or nil self.running[#self.running + 1] = run self.started = self.started + 1 end",
    "local function finishRun(h, run, reason) if run.done then return end run.done = true pcall(run.finish, reason) end",
    "local function teardown(h, reason) for i = #h.running, 1, -1 do finishRun(h, h.running[i], reason) end h.running = {} camRestore(h) for _, inst in ipairs(h.owned) do if inst and inst.Parent then inst:Destroy() end end h.owned = {} for _, c in ipairs(h.conns) do c:Disconnect() end h.conns = {} end",
    "local function complete(h, reason) if h.done then return end h.done = true teardown(h, reason) for i = #active, 1, -1 do if active[i] == h then table.remove(active, i) end end if #active == 0 and stepConn then stepConn:Disconnect() stepConn = nil end h.state = reason h.completedEv:Fire(reason) h.completedEv:Destroy() if h.ctx.side == 'client' and h.ctx.report ~= false then local root = ReplicatedStorage:FindFirstChild('TotalSequences') local ev = root and root:FindFirstChild('PlaySequence') if ev and Players.LocalPlayer then pcall(function() ev:FireServer(h.spec.name, reason) end) end end end",
    "local function step(dt) for i = #active, 1, -1 do local h = active[i] if not h.done and not h.paused then h.elapsed = h.elapsed + dt * (h.ctx.speed or 1) while h.nextEvent <= #h.events and (h.events[h.nextEvent].t or 0) <= h.elapsed do h:startEvent(h.events[h.nextEvent]) h.nextEvent = h.nextEvent + 1 end for j = #h.running, 1, -1 do local run = h.running[j] local age = h.elapsed - run.t0 local alive = true if run.untilT and h.elapsed >= run.untilT then if run.update then pcall(run.update, dt * (h.ctx.speed or 1), run.untilT - run.t0) end finishRun(h, run, 'event-end') alive = false else local okU, keep = pcall(run.update, dt * (h.ctx.speed or 1), age) if not okU then h.skipped[#h.skipped + 1] = tostring(run.ev.kind) .. ' update: ' .. tostring(keep) finishRun(h, run, 'error') alive = false elseif keep == false and not run.untilT then finishRun(h, run, 'completed') alive = false end end if not alive then table.remove(h.running, j) end end if h.cam and not h.done then camApply(h) end if h.elapsed >= h.duration then complete(h, 'completed') end end end end",
    "function Handle:Stop(reason) complete(self, reason or 'stopped') end",
    "function Handle:Pause() self.paused = true end",
    "function Handle:Resume() self.paused = false end",
    "function Handle:Skip() if self.done then return end self.elapsed = self.duration while self.nextEvent <= #self.events do local ev = self.events[self.nextEvent] if ev.kind == 'signal' then self:startEvent(ev) end self.nextEvent = self.nextEvent + 1 end complete(self, 'skipped') end",
    "function Handle:IsPlaying() return not self.done end",
    "function M.load(name) local root = ReplicatedStorage:FindFirstChild('TotalSequences') local mod = root and root:FindFirstChild(tostring(name)) if not mod or not mod:IsA('ModuleScript') or not mod:GetAttribute('TotalSequence') then error('sequence not found: ' .. tostring(name)) end local raw = mod:GetAttribute('SpecJSON') local okD, spec = pcall(function() return HttpService:JSONDecode(raw or '') end) if okD and type(spec) == 'table' and type(spec.events) == 'table' then spec.name = mod.Name return spec end local okR, m = pcall(require, mod) if okR and type(m) == 'table' then m.name = mod.Name return m end error('sequence ' .. tostring(name) .. ' has no readable spec') end",
    "function M.validate(spec, ctx) ctx = ctx or {} local issues = {} local function add(level, code, msg, ev) issues[#issues + 1] = {level = level, code = code, msg = msg, event = ev and ev.index or nil, t = ev and ev.t or nil} end if type(spec) ~= 'table' or type(spec.events) ~= 'table' then return {ok = false, errors = 1, warnings = 0, issues = {{level = 'error', code = 'spec', msg = 'spec.events missing'}}} end local VFX = lib('TotalVFX') local SFX = lib('TotalSFX') if not VFX then add('warning', 'no-vfx', 'TotalVFX is not installed - vfx events will be skipped (vfx_library_install)') end if not SFX then add('warning', 'no-sfx', 'TotalSFX is not installed - sfx events will be skipped (sfx_library_install)') end local fake = {ctx = ctx, owned = {}, skipped = {}, spec = spec} local function checkAt(ev, at) if at == nil then return end if type(at) == 'table' and #at >= 3 then return end if type(at) == 'table' then local actor = (at.actor == nil or at.actor == 'player' or at.actor == 'self') and (ctx.character or 'player') or (at.actor == 'target' and (ctx.target or 'target')) or resolve(at.actor) if not actor then add('error', 'ref', 'event ' .. ev.index .. ': actor not found: ' .. tostring(at.actor), ev) return end if typeof(actor) == 'Instance' and at.limb then local part, err = M.limb(actor, at.limb) if not part then add('error', 'rig-limb', 'event ' .. ev.index .. ': ' .. err, ev) end end if typeof(actor) ~= 'Instance' and at.limb and not R15[at.limb] then add('error', 'limb', 'event ' .. ev.index .. ': unknown limb ' .. tostring(at.limb), ev) end return end if at == 'player' or at == 'self' or at == 'target' then return end if not resolve(at) then add('error', 'ref', 'event ' .. ev.index .. ': at not found: ' .. tostring(at), ev) end end for i, ev in ipairs(spec.events) do ev.index = ev.index or i if ev.kind == 'vfx' then if VFX and not VFX.FAMILIES[ev.family] then add('error', 'vfx-family', 'event ' .. ev.index .. ': unknown vfx family ' .. tostring(ev.family), ev) end checkAt(ev, ev.at or ev.path or ev.position) if ev.to ~= nil then checkAt(ev, ev.to) end elseif ev.kind == 'sfx' then if SFX then local def = SFX.get(ev.event) if not def then add('error', 'sfx-event', 'event ' .. ev.index .. ': unknown sfx event ' .. tostring(ev.event) .. ' (sfx_event_define it)', ev) elseif #(def.ids or {}) == 0 then add('warning', 'sfx-missing', 'event ' .. ev.index .. ': sfx event ' .. tostring(ev.event) .. ' has no asset - plays nothing until sfx_event_define', ev) end end if ev.at ~= nil then checkAt(ev, ev.at) end elseif ev.kind == 'animation' then local rig = (ev.rig == nil or ev.rig == 'player') and ctx.character or resolve(ev.rig) if ev.rig and ev.rig ~= 'player' and not rig then add('error', 'ref', 'event ' .. ev.index .. ': rig not found: ' .. tostring(ev.rig), ev) elseif rig and not humanoidOf(rig) then add('error', 'rig', 'event ' .. ev.index .. ': rig ' .. rig.Name .. ' has no Humanoid', ev) end local src = ev.animation or ev.clip or ev.id if type(src) == 'string' and not src:match('^rbxassetid://%d+$') and not src:match('^%d+$') then local a = resolve(src) if not a then add('error', 'ref', 'event ' .. ev.index .. ': animation not found: ' .. src, ev) elseif not a:IsA('Animation') then add('error', 'animation', 'event ' .. ev.index .. ': ' .. src .. ' is a ' .. a.ClassName .. ', not an Animation', ev) elseif a.AnimationId == '' then add('error', 'animation-id', 'event ' .. ev.index .. ': ' .. src .. ' has an empty AnimationId - publish the clip first', ev) end end elseif ev.kind == 'camera' then local shot = ev.shot or ev if shot.target and shot.target ~= 'player' and shot.target ~= 'target' and not resolve(shot.target) then add('error', 'ref', 'event ' .. ev.index .. ': camera target not found: ' .. tostring(shot.target), ev) end if shot.part and not resolve(shot.part) then add('error', 'ref', 'event ' .. ev.index .. ': camera part not found: ' .. tostring(shot.part), ev) end if type(shot.look_at) == 'string' and shot.look_at ~= 'player' and shot.look_at ~= 'target' and not resolve(shot.look_at) then add('error', 'ref', 'event ' .. ev.index .. ': look_at not found: ' .. tostring(shot.look_at), ev) end elseif ev.kind == 'tween' then if not resolve(ev.path) then add('error', 'ref', 'event ' .. ev.index .. ': tween path not found: ' .. tostring(ev.path), ev) end elseif ev.kind == 'light' and type(ev.props) == 'table' and not ev.effect then for k in pairs(ev.props) do local okG = pcall(function() return Lighting[k] end) if not okG then add('error', 'light-prop', 'event ' .. ev.index .. ': Lighting has no property ' .. tostring(k), ev) end end end end local errors, warnings = 0, 0 for _, i in ipairs(issues) do if i.level == 'error' then errors = errors + 1 else warnings = warnings + 1 end end return {ok = errors == 0, errors = errors, warnings = warnings, issues = issues} end",
    "function M.play(specOrName, ctx) local spec = type(specOrName) == 'table' and specOrName or M.load(specOrName) ctx = ctx or {} if not ctx.side then if RunService:IsClient() and RunService:IsServer() then ctx.side = 'preview' elseif RunService:IsClient() then ctx.side = 'client' else ctx.side = 'server' end end if ctx.side == 'client' and not ctx.player then ctx.player = Players.LocalPlayer end if not ctx.character and ctx.player then ctx.character = ctx.player.Character end for i = #active, 1, -1 do if active[i].spec.name == spec.name and active[i].ctx.player == ctx.player then active[i]:Stop('replaced') end end local events = {} for i, ev in ipairs(spec.events) do ev.index = ev.index or i events[#events + 1] = ev end table.sort(events, function(a, b) if a.t == b.t then return (a.index or 0) < (b.index or 0) end return (a.t or 0) < (b.t or 0) end) local h = setmetatable({spec = spec, ctx = ctx, events = events, nextEvent = 1, running = {}, owned = {}, conns = {}, skipped = {}, signals = {}, started = 0, elapsed = 0, duration = tonumber(spec.duration) or 1, done = false, paused = false, state = 'playing'}, Handle) h.completedEv = Instance.new('BindableEvent') h.Completed = h.completedEv.Event h.camOverlay = function() camOverlayFrame(h) end if spec.options and spec.options.cancel_on_death ~= false and ctx.character then local hum = humanoidOf(ctx.character) if hum then h.conns[#h.conns + 1] = hum.Died:Connect(function() h:Stop('died') end) end if ctx.player then h.conns[#h.conns + 1] = ctx.player.CharacterRemoving:Connect(function() h:Stop('respawn') end) end end active[#active + 1] = h if not stepConn then stepConn = RunService.Heartbeat:Connect(step) end step(0) return h end",
    "function M.cast(name, player, ctx) ctx = ctx or {} local spec = M.load(name) local root = ReplicatedStorage:FindFirstChild('TotalSequences') local ev = root and root:FindFirstChild('PlaySequence') if not ev then error('PlaySequence RemoteEvent missing - run sequence_create again') end local payload = {target = ctx.target and ctx.target:GetFullName() or nil, speed = ctx.speed} if player then ev:FireClient(player, 'play', name, payload) else ev:FireAllClients('play', name, payload) end local sctx = {side = 'server', player = player, character = player and player.Character or nil, target = ctx.target, speed = ctx.speed} return M.play(spec, sctx) end",
    "function M.cancel(name, player) local root = ReplicatedStorage:FindFirstChild('TotalSequences') local ev = root and root:FindFirstChild('PlaySequence') if ev then if player then ev:FireClient(player, 'cancel', name) else ev:FireAllClients('cancel', name) end end for i = #active, 1, -1 do if active[i].spec.name == name and (player == nil or active[i].ctx.player == player) then active[i]:Stop('cancelled') end end end",
    "function M.stopAll(reason) for i = #active, 1, -1 do active[i]:Stop(reason or 'stopped') end end",
    "function M.active() local out = {} for _, h in ipairs(active) do out[#out + 1] = {name = h.spec.name, elapsed = h.elapsed, duration = h.duration, side = h.ctx.side} end return out end",
    "function M.step(dt) step(dt) end",
    "return M",
  ].join("\n");

  const CLIENT_SRC = [
    "-- TotalScript sequence client " + VERSION + " - plays / cancels sequences the server casts and reports completion.",
    "local ReplicatedStorage = game:GetService('ReplicatedStorage')",
    "local Players = game:GetService('Players')",
    "local root = ReplicatedStorage:WaitForChild('TotalSequences')",
    "local Runner = require(root:WaitForChild('SequenceRunner'))",
    "local ev = root:WaitForChild('PlaySequence')",
    "local function resolve(p) if not p then return nil end local cur = game for seg in tostring(p):gmatch('[^%.]+') do if cur == game and seg == 'Workspace' then cur = workspace else cur = cur:FindFirstChild(seg) if not cur then return nil end end end return cur end",
    "ev.OnClientEvent:Connect(function(action, name, payload)",
    "  if action == 'cancel' then Runner.cancel(name) return end",
    "  if action ~= 'play' then return end",
    "  payload = type(payload) == 'table' and payload or {}",
    "  local okP, err = pcall(function() Runner.play(name, {side = 'client', player = Players.LocalPlayer, character = Players.LocalPlayer.Character, target = resolve(payload.target), speed = payload.speed}) end)",
    "  if not okP then warn('[TotalSequence] ' .. tostring(err)) ev:FireServer(name, 'error') end",
    "end)",
  ].join("\n");

  // ── Studio-side command library ───────────────────────────────────────────
  // 1.98.0 - AnimPlayer: ONE playback runtime for every generated gameplay script
  // (combat tools, ability casts, emotes). What it fixes, from the audit of the
  // generated clients: Humanoid:LoadAnimation (deprecated) called on every swing
  // (a new AnimationTrack per press, never stopped), no priority, no interruption
  // of the previous Action track, nothing on respawn, and a silent no-op when the
  // Animation had no AnimationId. Tracks are cached per character and the cache
  // dies with the character (Died / removed from the game).
  const ANIM_PLAYER_SRC = `-- TotalScript AnimPlayer (generated by anim_player_install, v__VERSION__). Shared, respawn-safe animation playback.
-- local AnimPlayer = require(game.ReplicatedStorage.TotalAnimations.AnimPlayer)
-- local p = AnimPlayer.forCharacter(character)           -- cached per character; cleared on death / removal
-- local track, err = p:play("Punch1", { priority = "Action", fade = 0.1, speed = 1, looped = false, exclusive = true })
-- p:stop("Punch1", 0.2)   p:stopAll(0.2, "Action")   p:isPlaying("Punch1")   AnimPlayer.bindPlayer(player, function(p) ... end)
-- Names resolve to ReplicatedStorage.Animations.<name>, a Tool/character child, an Animation instance or "rbxassetid://id".
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local AnimPlayer = {}
AnimPlayer.VERSION = "__VERSION__"
AnimPlayer.__index = AnimPlayer

local PRIORITIES = { Idle = Enum.AnimationPriority.Idle, Movement = Enum.AnimationPriority.Movement, Action = Enum.AnimationPriority.Action, Action2 = Enum.AnimationPriority.Action2, Action3 = Enum.AnimationPriority.Action3, Action4 = Enum.AnimationPriority.Action4, Core = Enum.AnimationPriority.Core }
local players = setmetatable({}, { __mode = "k" })

local function animFolder()
	return ReplicatedStorage:FindFirstChild("Animations")
end

-- Returns an Animation instance or nil + an actionable reason.
function AnimPlayer.resolve(src, scope)
	if typeof(src) == "Instance" then
		if src:IsA("Animation") then
			return src
		end
		local inner = src:FindFirstChildOfClass("Animation")
		if inner then
			return inner
		end
		return nil, src:GetFullName() .. " is not an Animation and has none inside"
	end
	if type(src) == "number" or (type(src) == "string" and src:match("^%d+$")) then
		local a = Instance.new("Animation")
		a.Name = "Anim_" .. tostring(src)
		a.AnimationId = "rbxassetid://" .. tostring(src)
		return a
	end
	if type(src) == "string" and src:match("^rbxassetid://%d+$") then
		local a = Instance.new("Animation")
		a.Name = "Anim_" .. src:match("%d+")
		a.AnimationId = src
		return a
	end
	if type(src) ~= "string" or src == "" then
		return nil, "animation name is empty"
	end
	local folder = animFolder()
	local found = folder and folder:FindFirstChild(src)
	if not found and scope then
		found = scope:FindFirstChild(src, true)
	end
	if not found then
		return nil, 'no animation named "' .. src .. '" in ReplicatedStorage.Animations' .. (scope and (" or under " .. scope:GetFullName()) or "") .. " - publish it first (animation_publish) or pass an asset id"
	end
	return AnimPlayer.resolve(found)
end

function AnimPlayer.forCharacter(character)
	if not character then
		return nil, "no character"
	end
	local existing = players[character]
	if existing and not existing.dead then
		return existing
	end
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	local host = humanoid or character:FindFirstChildOfClass("AnimationController")
	if not host then
		return nil, character.Name .. " has no Humanoid / AnimationController"
	end
	local animator = host:FindFirstChildOfClass("Animator")
	if not animator then
		animator = Instance.new("Animator")
		animator.Parent = host
	end
	local self = setmetatable({ character = character, humanoid = humanoid, animator = animator, tracks = {}, dead = false, conns = {} }, AnimPlayer)
	if humanoid then
		table.insert(self.conns, humanoid.Died:Connect(function()
			self:stopAll(0.1)
			self:destroy()
		end))
	end
	table.insert(self.conns, character.AncestryChanged:Connect(function(_, parent)
		if parent == nil then
			self:destroy()
		end
	end))
	players[character] = self
	return self
end

function AnimPlayer:destroy()
	if self.dead then
		return
	end
	self.dead = true
	for _, c in ipairs(self.conns) do
		pcall(function() c:Disconnect() end)
	end
	self.conns = {}
	for _, rec in pairs(self.tracks) do
		pcall(function() rec.track:Stop(0) end)
		pcall(function() rec.track:Destroy() end)
	end
	self.tracks = {}
	if players[self.character] == self then
		players[self.character] = nil
	end
end

local function keyOf(anim)
	return anim.AnimationId ~= "" and anim.AnimationId or anim:GetFullName()
end

function AnimPlayer:load(src, opts)
	if self.dead then
		return nil, "character is gone"
	end
	local anim, err = AnimPlayer.resolve(src, self.character)
	if not anim then
		return nil, err
	end
	if anim.AnimationId == "" then
		return nil, anim:GetFullName() .. " has no AnimationId - publish the clip first (animation_publish) so it can be loaded"
	end
	local key = keyOf(anim)
	local rec = self.tracks[key]
	if rec then
		return rec.track
	end
	local okL, track = pcall(function()
		return self.animator:LoadAnimation(anim)
	end)
	if not okL or not track then
		return nil, "LoadAnimation failed for " .. anim.AnimationId .. ": " .. tostring(track) .. " (asset private, moderated or not an animation?)"
	end
	rec = { track = track, anim = anim, name = anim.Name }
	self.tracks[key] = rec
	if type(src) == "string" then
		self.tracks[src] = rec
	end
	return track
end

function AnimPlayer:play(src, opts)
	opts = opts or {}
	local track, err = self:load(src, opts)
	if not track then
		return nil, err
	end
	local prio = opts.priority and (PRIORITIES[opts.priority] or opts.priority) or nil
	if prio then
		pcall(function() track.Priority = prio end)
	end
	if opts.looped ~= nil then
		pcall(function() track.Looped = opts.looped == true end)
	end
	if opts.exclusive ~= false then
		local myPrio = nil
		pcall(function() myPrio = track.Priority end)
		for _, rec in pairs(self.tracks) do
			if rec.track ~= track and rec.track.IsPlaying then
				local same = true
				pcall(function() same = (rec.track.Priority == myPrio) end)
				if same then
					rec.track:Stop(opts.fade or 0.1)
				end
			end
		end
	end
	track:Play(opts.fade or 0.1, opts.weight or 1, opts.speed or 1)
	if opts.on_marker and track.GetMarkerReachedSignal then
		for marker, fn in pairs(opts.on_marker) do
			local c
			c = track:GetMarkerReachedSignal(marker):Connect(function(v)
				fn(v)
			end)
			table.insert(self.conns, c)
		end
	end
	return track
end

function AnimPlayer:stop(src, fade)
	local rec = type(src) == "string" and self.tracks[src] or nil
	if not rec then
		local anim = AnimPlayer.resolve(src, self.character)
		rec = anim and self.tracks[keyOf(anim)] or nil
	end
	if rec then
		rec.track:Stop(fade or 0.1)
		return true
	end
	return false
end

function AnimPlayer:stopAll(fade, priority)
	local want = priority and (PRIORITIES[priority] or priority) or nil
	for _, rec in pairs(self.tracks) do
		local keep = false
		if want then
			pcall(function() keep = rec.track.Priority ~= want end)
		end
		if not keep and rec.track.IsPlaying then
			rec.track:Stop(fade or 0.1)
		end
	end
end

function AnimPlayer:isPlaying(src)
	local rec = type(src) == "string" and self.tracks[src] or nil
	return rec ~= nil and rec.track.IsPlaying == true
end

-- Respawn-safe binding: fn(player, animPlayer) runs for the current character and every new one.
function AnimPlayer.bindPlayer(player, fn)
	local function hook(character)
		local p = AnimPlayer.forCharacter(character)
		if p then
			fn(p, character)
		end
	end
	if player.Character then
		task.defer(hook, player.Character)
	end
	return player.CharacterAdded:Connect(hook)
end

return AnimPlayer
`.replace(/__VERSION__/g, VERSION);

  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local ReplicatedStorage=game:GetService('ReplicatedStorage')",
    "local StarterPlayer=game:GetService('StarterPlayer')",
    "local RunService=game:GetService('RunService')",
    "local Players=game:GetService('Players')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local RUNTIME_VERSION=" + q(VERSION),
    "local RUNTIME_SRC=" + q(RUNTIME_SRC),
    "local CLIENT_SRC=" + q(CLIENT_SRC),
    "local ANIM_PLAYER_SRC=" + q(ANIM_PLAYER_SRC),
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end",
    "local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end if lp=='workspace' then return workspace end local cur=game for seg in p:gmatch('[^%.]+') do if cur==game and seg:lower()=='workspace' then cur=workspace else local nxt=cur:FindFirstChild(seg) if not nxt and cur==game then local okS,svc=pcall(function() return game:GetService(seg) end) if okS then nxt=svc end end if not nxt then return nil end cur=nxt end end return cur end",
    "local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('TotalScript sequence') end) return okW and w or nil end",
    "local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end",
    "local function folder(parent,name) local f=parent:FindFirstChild(name) if not f then f=Instance.new('Folder') f.Name=name f.Parent=parent end return f end",
    "local function root() return folder(ReplicatedStorage,'TotalSequences') end",
    "local function ensureRuntime() local r=root() local made={} local m=r:FindFirstChild('SequenceRunner') if m and not m:IsA('ModuleScript') then m:Destroy() m=nil end if not m then m=Instance.new('ModuleScript') m.Name='SequenceRunner' m.Parent=r made[#made+1]='SequenceRunner' end if m:GetAttribute('TotalVersion')~=RUNTIME_VERSION then m.Source=RUNTIME_SRC m:SetAttribute('TotalVersion',RUNTIME_VERSION) if #made==0 then made[#made+1]='SequenceRunner (upgraded)' end end if not r:FindFirstChild('PlaySequence') then local e=Instance.new('RemoteEvent') e.Name='PlaySequence' e.Parent=r made[#made+1]='PlaySequence' end if not r:FindFirstChild('Signal') then local b=Instance.new('BindableEvent') b.Name='Signal' b.Parent=r made[#made+1]='Signal' end local sps=StarterPlayer:FindFirstChild('StarterPlayerScripts') if not sps then sps=Instance.new('StarterPlayerScripts') sps.Name='StarterPlayerScripts' sps.Parent=StarterPlayer end local cl=sps:FindFirstChild('TotalSequenceClient') if not cl then cl=Instance.new('LocalScript') cl.Name='TotalSequenceClient' cl.Parent=sps made[#made+1]='TotalSequenceClient' end if cl:GetAttribute('TotalVersion')~=RUNTIME_VERSION then cl.Source=CLIENT_SRC cl:SetAttribute('TotalVersion',RUNTIME_VERSION) end return m,made end",
    "local function runner() local m,made=ensureRuntime() local okR,lib=pcall(require,m) if not okR then error('SequenceRunner failed to load: '..tostring(lib)) end return lib,m,made end",
    "local function luaStr(s) return string.format('%q',tostring(s)) end",
    "local function fmt(n) n=tonumber(n) or 0 if math.abs(n-math.floor(n+0.5))<1e-6 then return tostring(math.floor(n+0.5)) end local s=string.format('%.4f',n) s=s:gsub('0+$','') s=s:gsub('%.$','') return s end",
    "local function luaVal(v,ind) local t=type(v) if t=='string' then return luaStr(v) elseif t=='number' then return fmt(v) elseif t=='boolean' then return tostring(v) elseif t=='table' then local isArr=#v>0 local parts={} if isArr then for _,x in ipairs(v) do parts[#parts+1]=luaVal(x,ind) end return '{'..table.concat(parts,', ')..'}' end local keys={} for k in pairs(v) do keys[#keys+1]=tostring(k) end table.sort(keys) for _,k in ipairs(keys) do if k~='index' then parts[#parts+1]=(k:match('^[%a_][%w_]*$') and k or ('['..luaStr(k)..']'))..' = '..luaVal(v[k],ind) end end return '{'..table.concat(parts,', ')..'}' end return 'nil' end",
    "local function render(spec) local L={} L[#L+1]='-- TotalScript sequence '..luaStr(spec.name)..' ('..#spec.events..' events, '..fmt(spec.duration)..'s) - generated by sequence_create; edit with the sequence_* commands (the SpecJSON attribute is the source of truth)' L[#L+1]='return {' L[#L+1]='  name = '..luaStr(spec.name)..',' L[#L+1]='  duration = '..fmt(spec.duration)..',' L[#L+1]='  tier = '..luaStr(spec.tier or 'High')..',' if spec.palette then L[#L+1]='  palette = '..luaStr(spec.palette)..',' end L[#L+1]='  options = '..luaVal(spec.options or {})..',' L[#L+1]='  events = {' for _,ev in ipairs(spec.events) do L[#L+1]='    '..luaVal(ev)..',' end L[#L+1]='  },' L[#L+1]='}' return table.concat(L,'\\n') end",
    "local function save(spec) local r=root() local m=r:FindFirstChild(spec.name) if m and not m:IsA('ModuleScript') then m:Destroy() m=nil end if not m then m=Instance.new('ModuleScript') m.Name=spec.name m.Parent=r end m:SetAttribute('TotalSequence',true) m:SetAttribute('SpecJSON',HttpService:JSONEncode(spec)) m:SetAttribute('Events',#spec.events) m:SetAttribute('Duration',spec.duration) m:SetAttribute('Tier',spec.tier or 'High') m.Source=render(spec) return m end",
    "local function find(name) local r=ReplicatedStorage:FindFirstChild('TotalSequences') local m=r and r:FindFirstChild(tostring(name or '')) if m and m:IsA('ModuleScript') and m:GetAttribute('TotalSequence') then return m end return nil end",
    "local function all() local out={} local r=ReplicatedStorage:FindFirstChild('TotalSequences') if r then for _,m in ipairs(r:GetChildren()) do if m:IsA('ModuleScript') and m:GetAttribute('TotalSequence') then out[#out+1]=m end end end table.sort(out,function(a,b) return a.Name<b.Name end) return out end",
    "local function previewCtx(a) local ctx={side='preview',speed=tonumber(a and a.speed) or 1} local rig=a and a.rig and resolve(a.rig) or nil if rig then ctx.character=rig else local ch=nil for _,m in ipairs(workspace:GetChildren()) do if m:IsA('Model') and m:FindFirstChildOfClass('Humanoid') and m:FindFirstChild('HumanoidRootPart') then ch=m break end end ctx.character=ch end local tgt=a and a.target and resolve(a.target) or nil if tgt then ctx.target=tgt end return ctx end",
    "local function beats(spec) local out={} for _,ev in ipairs(spec.events) do local what=ev.kind if ev.kind=='vfx' then what='vfx '..tostring(ev.family) elseif ev.kind=='sfx' then what='sfx '..tostring(ev.event) elseif ev.kind=='signal' then what='signal '..tostring(ev.name) elseif ev.kind=='camera' then what='camera '..(ev.shake and 'shake' or ev.fov_punch and 'fov punch' or ((ev.shot or ev).preset or 'shot')) elseif ev.kind=='ui' then what='ui '..luaStr(ev.text) elseif ev.kind=='animation' then what='animation '..tostring(ev.animation or ev.clip or ev.id) elseif ev.kind=='light' then what='light '..tostring(ev.effect or 'Lighting') end out[#out+1]=fmt(ev.t)..'s '..what..(ev.duration and (' ('..fmt(ev.duration)..'s)') or '') end return out end",
    "local function usage(name) return 'Server: require(ReplicatedStorage.TotalSequences.SequenceRunner).cast('..luaStr(name)..', player, {target = enemyModel})  |  Client: Runner.play('..luaStr(name)..', {character = char})  |  gameplay: ReplicatedStorage.TotalSequences.Signal.Event:Connect(function(seq, signal, value, player) end)' end",
  ].join("\n");

  const B = {};

  function createBody(spec, report, replace, extraText) {
    return [
      "local rec=wp() local lib,mod,made=runner()",
      replace === false ? "if find(" + q(spec.name) + ") then wpDone(rec) return fail('sequence " + spec.name + " already exists (replace:true to overwrite)') end" : "",
      "local spec=HttpService:JSONDecode(" + q(JSON.stringify(spec)) + ")",
      "local ctx=previewCtx({}) local v=lib.validate(spec,ctx)",
      "local static=HttpService:JSONDecode(" + q(JSON.stringify(report)) + ")",
      "for _,i in ipairs(static.issues) do v.issues[#v.issues+1]=i if i.level=='error' then v.errors=v.errors+1 else v.warnings=v.warnings+1 end end v.ok=v.errors==0",
      "if not v.ok then wpDone(rec) local msgs={} for _,i in ipairs(v.issues) do if i.level=='error' then msgs[#msgs+1]=i.msg end end return fail('sequence " + spec.name + " NOT created - '..#msgs..' error(s): '..table.concat(msgs,' | ')) end",
      "local m=save(spec) wpDone(rec)",
      "local warns={} for _,i in ipairs(v.issues) do if i.level=='warning' then warns[#warns+1]=i.msg end end",
      "return ok({module=m:GetFullName(),name=spec.name,duration=spec.duration,tier=spec.tier,palette=spec.palette,events=#spec.events,beats=beats(spec),validation=v,installed=made,runtime_version=lib.VERSION,usage=usage(spec.name)},'sequence '..spec.name..' saved at '..m:GetFullName()..' ('..#spec.events..' events, '..fmt(spec.duration)..'s, tier '..tostring(spec.tier)..')'..(#warns>0 and (' with '..#warns..' warning(s): '..table.concat(warns,' | ')) or ' - validation clean')..'. " + (extraText || "") + "Next: sequence_preview {name} and total_screenshot at the key beats; in Play mode the server casts it with SequenceRunner.cast.')",
    ].filter(Boolean).join("\n");
  }

  B.sequence_create = (a) => {
    const spec = normalizeSpec(a);
    const report = validateSpec(spec);
    if (!report.ok) return "return fail(" + q("sequence " + spec.name + " NOT created - " + report.errors + " structural error(s): " + report.issues.filter((i) => i.level === "error").map((i) => i.msg).join(" | ") + ". Event shape: {t, kind: camera|animation|vfx|sfx|light|ui|tween|signal, duration?, ...}") + ")";
    for (const ev of spec.events) delete ev.index;
    return createBody(spec, { issues: report.issues.filter((i) => i.level === "warning") }, a.replace, "");
  };

  B.ability_sequence_create = (a) => {
    const kind = String(a.ability || a.kind || a.template || "").toLowerCase().replace(/[\s-]+/g, "_");
    if (!ABILITIES.includes(kind)) return "return fail('ability is required: " + ABILITIES.join(", ") + "')";
    const name = ident(a.name, kind.charAt(0).toUpperCase() + kind.slice(1));
    const tpl = abilityTemplate(kind, { name, rig: a.rig || "player", target: a.target || null, palette: a.palette || null, tier: a.tier || "High", animation: a.animation || null, hand: a.hand, label: a.label, shield_duration: num(a.shield_duration) || undefined, distance: num(a.distance) || undefined });
    const spec = normalizeSpec(tpl);
    const report = validateSpec(spec);
    if (!report.ok) return "return fail(" + q("ability template " + kind + " failed its own validation: " + report.issues.filter((i) => i.level === "error").map((i) => i.msg).join(" | ")) + ")";
    for (const ev of spec.events) delete ev.index;
    return createBody(spec, { issues: report.issues.filter((i) => i.level === "warning") }, a.replace, "Beats: anticipation -> camera -> charge VFX + SFX -> release -> primary effect at the target -> recovery -> UI -> cleanup; gameplay listens for the signals (" + Array.from(new Set(spec.events.filter((e) => e.kind === "signal").map((e) => e.name))).join(", ") + ") to apply server-authoritative effects. " + (a.animation ? "" : "No animation was given: pass animation (Animation path or asset id from animation_publish) to add the pose track. "));
  };

  B.sequence_validate = (a) => {
    const name = ident(a.name, "Sequence");
    return [
      "local m=find(" + q(name) + ") if not m then return fail('no sequence named " + name + "') end local lib=runner() local spec=lib.load(m.Name)",
      "local ctx=previewCtx({rig=" + (a.rig ? q(a.rig) : "nil") + ",target=" + (a.target ? q(a.target) : "nil") + "}) local v=lib.validate(spec,ctx)",
      "local budget=lib.TIER_BUDGET[spec.tier or 'High'] or lib.TIER_BUDGET.High local live=0 for _,e in ipairs(spec.events) do if e.kind=='vfx' then local n=0 for _,o in ipairs(spec.events) do if o.kind=='vfx' and o.t<=e.t and o.t+(o.duration or 1)>e.t then n=n+1 end end if n>live then live=n end end end if live>budget.vfx then v.issues[#v.issues+1]={level='error',code='vfx-budget',msg=live..' effects alive at once exceed the '..tostring(spec.tier)..' budget ('..budget.vfx..')'} v.errors=v.errors+1 v.ok=false end",
      "local rigName=ctx.character and (ctx.character.Name..' ('..lib.rigType(ctx.character)..')') or 'none in Workspace (animations / limb anchors unverified)'",
      "return ok({name=m.Name,ok=v.ok,errors=v.errors,warnings=v.warnings,issues=v.issues,events=#spec.events,duration=spec.duration,tier=spec.tier,max_live_vfx=live,checked_against={rig=rigName,target=ctx.target and ctx.target:GetFullName() or nil,vfx=ReplicatedStorage:FindFirstChild('TotalVFX')~=nil,sfx=ReplicatedStorage:FindFirstChild('TotalSFX')~=nil}},'sequence '..m.Name..': '..(v.ok and 'VALID' or 'INVALID')..' - '..v.errors..' error(s), '..v.warnings..' warning(s), max '..live..' live effects; checked against rig '..rigName)",
    ].join("\n");
  };

  B.sequence_preview = (a) => {
    const name = ident(a.name, "Sequence");
    return [
      "local m=find(" + q(name) + ") if not m then return fail('no sequence named " + name + " (sequence_list)') end local lib=runner() local spec=lib.load(m.Name)",
      "local ctx=previewCtx({rig=" + (a.rig ? q(a.rig) : "nil") + ",target=" + (a.target ? q(a.target) : "nil") + ",speed=" + (num(a.speed) || 1) + "}) ctx.report=false",
      "lib.stopAll('replaced') local h=lib.play(spec,ctx)",
      "local startedNow=h.started local pending=#h.events-(h.nextEvent-1)",
      "return ok({name=m.Name,duration=spec.duration,speed=ctx.speed,events=#h.events,started_at_t0=startedNow,pending=pending,skipped=h.skipped,signals=h.signals,rig=ctx.character and ctx.character:GetFullName() or nil,target=ctx.target and ctx.target:GetFullName() or nil,beats=beats(spec),note=RunService:IsEdit() and 'edit-mode preview: camera, VFX, SFX, lighting, UI and signals run on Heartbeat; animation tracks play only if the rig accepts them here; the camera is restored when it ends (sequence_stop cancels)' or 'playing'},'previewing '..m.Name..' ('..fmt(spec.duration/ctx.speed)..'s real time, '..#h.events..' events'..(#h.skipped>0 and ('; skipped: '..table.concat(h.skipped,'; ')) or '')..'). total_screenshot at the beats: '..table.concat(beats(spec),', '))",
    ].join("\n");
  };

  B.sequence_play = (a) => {
    const name = ident(a.name, "Sequence");
    const player = a.player ? String(a.player) : "";
    return [
      "local m=find(" + q(name) + ") if not m then return fail('no sequence named " + name + "') end local lib=runner()",
      "if RunService:IsEdit() then local ctx=previewCtx({rig=" + (a.rig ? q(a.rig) : "nil") + ",target=" + (a.target ? q(a.target) : "nil") + "}) ctx.report=false lib.stopAll('replaced') local h=lib.play(lib.load(m.Name),ctx) return ok({name=m.Name,mode='edit-preview',events=#h.events,skipped=h.skipped,usage=usage(m.Name)},'Studio is in edit mode, so " + name + " runs as a local preview (no players). In a running game: '..usage(m.Name)) end",
      player ? "local plr=Players:FindFirstChild(" + q(player) + ") if not plr then return fail('player " + player.replace(/'/g, "") + " not found') end local h=lib.cast(m.Name,plr,{target=" + (a.target ? "resolve(" + q(a.target) + ")" : "nil") + "}) return ok({name=m.Name,player=plr.Name,mode='cast'},'cast " + name + " to '..plr.Name..' (client plays the cosmetic track, server runs the signals)')" : "local h=lib.cast(m.Name,nil,{target=" + (a.target ? "resolve(" + q(a.target) + ")" : "nil") + "}) return ok({name=m.Name,mode='cast-all'},'cast " + name + " to every player')",
    ].join("\n");
  };

  B.sequence_stop = (a) => [
    "local lib=runner() local before=lib.active() lib.stopAll('stopped') return ok({stopped=before},#before..' sequence(s) stopped and cleaned up (camera / lighting / UI restored)')",
  ].join("\n");

  B.anim_player_install = (a) => [
    "local f=folder(ReplicatedStorage,'TotalAnimations') local m=f:FindFirstChild('AnimPlayer') local how='kept'",
    "if m and not m:IsA('ModuleScript') then m:Destroy() m=nil end",
    "local force=" + (a.force === true ? "true" : "false"),
    "if not m then m=Instance.new('ModuleScript') m.Name='AnimPlayer' m.Parent=f how='created' end",
    "local installed=m:GetAttribute('TotalVersion')",
    "if how=='created' or force or installed~=RUNTIME_VERSION then local rec=wp() m.Source=ANIM_PLAYER_SRC m:SetAttribute('TotalVersion',RUNTIME_VERSION) wpDone(rec) if how~='created' then how='updated' end end",
    "local okR,lib=pcall(require,m) if not okR then return fail('AnimPlayer failed to load: '..tostring(lib)) end",
    "local anims=ReplicatedStorage:FindFirstChild('Animations') local n=0 if anims then for _,c in ipairs(anims:GetChildren()) do if c:IsA('Animation') then n=n+1 end end end",
    "return ok({path=m:GetFullName(),how=how,version=RUNTIME_VERSION,published_animations=n},'AnimPlayer '..how..' at '..m:GetFullName()..' ('..n..' published Animation(s) in ReplicatedStorage.Animations). Use: local AnimPlayer=require(game.ReplicatedStorage.TotalAnimations.AnimPlayer) local p=AnimPlayer.forCharacter(character) local track,err=p:play(\"Name\",{priority=\"Action\",fade=0.1,exclusive=true}) - names resolve to ReplicatedStorage.Animations.<Name>, Tool children or rbxassetid://; err explains missing ids / failed loads instead of a silent no-op')",
  ].join("\n");

  B.sequence_list = () => [
    "local out={} for _,m in ipairs(all()) do out[#out+1]={name=m.Name,events=m:GetAttribute('Events'),duration=m:GetAttribute('Duration'),tier=m:GetAttribute('Tier')} end",
    "local r=ReplicatedStorage:FindFirstChild('TotalSequences') local rt=r and r:FindFirstChild('SequenceRunner')",
    "return ok({sequences=out,count=#out,runtime=rt and rt:GetFullName() or nil,runtime_version=rt and rt:GetAttribute('TotalVersion') or nil,vfx_installed=ReplicatedStorage:FindFirstChild('TotalVFX')~=nil,sfx_installed=ReplicatedStorage:FindFirstChild('TotalSFX')~=nil,abilities=" + lua(ABILITIES) + "},#out==0 and 'no sequences yet - sequence_create {name, events:[...]} or ability_sequence_create {name, ability}' or (#out..' sequence(s): '..(function() local n={} for i,s in ipairs(out) do n[i]=s.name..' ('..tostring(s.events)..' events, '..fmt(s.duration)..'s)' end return table.concat(n,', ') end)()))",
  ].join("\n");

  B.sequence_delete = (a) => {
    const name = ident(a.name, "Sequence");
    return [
      "local m=find(" + q(name) + ") if not m then return fail('no sequence named " + name + "') end",
      "local rec=wp() local removed={m:GetFullName()} m:Destroy() wpDone(rec)",
      "return ok({removed=removed},'deleted sequence " + name + " (runtime kept for the others)')",
    ].join("\n");
  };

  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const EVENT_DESC = "array of events on ONE timeline. Each {t: seconds, kind, duration?, side?: client|server|both} plus: camera {shot:{position,[x,y,z] look_at|\"Workspace.Boss\"} | {target, preset: wide|closeup|hero_low|top_down|side|behind|over_shoulder, distance?, height?}, fov?, easing?, move: cut|ease, track?, shake:{amplitude<=1.5, frequency, decay}, fov_punch:{amount, duration}} · animation {rig: \"player\"|path, animation: Animation path | asset id, fade?, speed?, priority?, marker_events:[{marker:\"hit\", events:[...]}]} · vfx {family, at: \"player\"|path|{actor, limb: right_hand|left_hand|head|torso|root|right_foot|left_foot, offset?}|[x,y,z], normal?: \"aim\"|\"back\"|\"to_target\"|[x,y,z], to?: path|[x,y,z] (projectile travels at->to over duration, arc?), palette?, scale?} · sfx {event, at?, volume?} · light {props:{Brightness,...} | effect: ColorCorrection|Bloom|Blur + props, tween?} · ui {text, subtitle?, style: toast|banner|subtitle, duration} · tween {path, props, duration, easing?} · signal {name, value?} (fires ReplicatedStorage.TotalSequences.Signal for gameplay code)";
  const C = [
    { name: "anim_player_install", description: "Install / refresh ReplicatedStorage.TotalAnimations.AnimPlayer - the shared, respawn-safe animation playback module every generated gameplay script should use: cached AnimationTracks per character (no track leak per press), priority + fade + speed + looped, exclusive play stops the previous track of the same priority, cleanup on death / character removal, bindPlayer(player, fn) re-binds on respawn, and actionable errors when the Animation has no AnimationId or the asset fails to load. Usage: local p = AnimPlayer.forCharacter(char); p:play('Punch1', {priority='Action', fade=0.1, exclusive=true}).", params: { force: S("boolean", false, "overwrite an edited module (default: refresh only when the installed version is older)") } },
    { name: "sequence_create", description: "Create a REAL multi-domain sequence: camera, animation, VFX (TotalVFX), SFX (TotalSFX), lighting, UI and gameplay signals on ONE validated timeline (ReplicatedStorage.TotalSequences.<Name> + SequenceRunner runtime + client script). Validation refuses unknown kinds / families / events, events after the end, overlapping camera moves, missing paths and over-budget effects; cleanup, cancel, death / respawn interruption and camera restore are built in. Prefer ability_sequence_create for abilities.", params: { name: S("string", true), events: S("array", true, EVENT_DESC), duration: S("number", false, "seconds (default: last event end)"), tier: S("string", false, "High | Medium | Low effect budget"), palette: S("string", false, "default TotalVFX palette for every vfx event"), options: S("object", false, "{restore_camera: true, cancel_on_death: true}"), replace: S("boolean", false, "false = refuse to overwrite") } },
    { name: "ability_sequence_create", description: "Build a complete game-ready ability sequence from a template (" + ABILITIES.join(", ") + "): anticipation -> camera punch -> charge VFX + SFX at the hand (rig-aware R6 / R15 limbs) -> release -> projectile / impact at the target -> camera shake -> recovery -> lighting accent -> UI -> cleanup, with signals (fire_projectile, hit, heal, shield_on...) for server-authoritative gameplay. Then sequence_preview it.", params: { name: S("string", false, "sequence name (default = ability)"), ability: S("string", true, ABILITIES.join(" | ")), rig: S("string", false, "\"player\" (default) or a rig Model path"), target: S("string", false, "target Model / Part path (default: 14 studs ahead of the rig)"), animation: S("string", false, "Animation instance path or asset id to play as the pose track"), palette: S("string", false, "TotalVFX palette override"), tier: S("string", false, "High | Medium | Low"), hand: S("string", false, "right (default) | left"), label: S("string", false, "UI label text") } },
    { name: "sequence_validate", description: "Validate a saved sequence against THIS place: references (rig, limbs for its R6/R15 type, targets, Animation ids, paths), TotalVFX families, TotalSFX events (missing assets flagged), Lighting properties, effect budget per tier. Returns a defect list with event indices.", params: { name: S("string", true), rig: S("string", false, "rig Model path to check limbs / animations against (default: first Humanoid model in Workspace)"), target: S("string", false) } },
    { name: "sequence_preview", description: "Play a sequence on the Studio camera right now (edit mode): camera moves / shake / FOV punch, TotalVFX, TotalSFX, lighting accents, UI and signals run on one clock and clean up afterwards. total_screenshot at the reported beats.", params: { name: S("string", true), rig: S("string", false, "rig Model for \"player\" anchors (default: first Humanoid model in Workspace)"), target: S("string", false, "target for \"target\" anchors"), speed: S("number", false, "playback speed (default 1)") } },
    { name: "sequence_play", description: "Cast a sequence in a running game to one player (or everyone): the client plays the cosmetic track, the server runs the signals. In edit mode this is a local preview.", params: { name: S("string", true), player: S("string", false, "player name (default all)"), target: S("string", false) } },
    { name: "sequence_stop", hidden: true, description: "Stop every active sequence preview and restore camera / lighting / UI.", params: {} },
    { name: "sequence_list", description: "List saved sequences (events, duration, tier), runtime version and whether TotalVFX / TotalSFX are installed.", params: {} },
    { name: "sequence_delete", description: "Delete a sequence module (runtime stays).", params: { name: S("string", true) } },
  ];

  function buildSeq(op, args) {
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
    const extra = buildSeq(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const names = new Set(C.map((c) => c.name));
  const arr = RobloxScriptSkills.SKILL_COMMANDS;
  for (let i = arr.length - 1; i >= 0; i--) if (names.has(arr[i].name)) arr.splice(i, 1);
  for (const c of C) arr.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.SEQUENCE_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.SEQUENCE_RUNTIME_SRC = RUNTIME_SRC;
  RobloxScriptSkills.SEQUENCE_CLIENT_SRC = CLIENT_SRC;
  RobloxScriptSkills.ANIM_PLAYER_SRC = ANIM_PLAYER_SRC;
  RobloxScriptSkills.SEQUENCE_VERSION = VERSION;
  RobloxScriptSkills.SEQUENCE_KINDS = KINDS;
  RobloxScriptSkills.SEQUENCE_ABILITIES = ABILITIES;
  RobloxScriptSkills.sequenceNormalize = normalizeSpec;
  RobloxScriptSkills.sequenceValidate = validateSpec;
  RobloxScriptSkills.sequenceAbilityTemplate = abilityTemplate;
})();
