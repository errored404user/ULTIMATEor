// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript perf pack (2.13.0) - a place-wide performance audit with a score
// and the mechanical fixes it recommends, both one call each.
//
//   perf_audit {path?, limit?}
//       Walks Workspace (or one subtree) plus the script containers and
//       Lighting and measures what actually costs frame time on Roblox:
//       part count, FREE unanchored parts (no joint / constraint, not in a
//       character or vehicle - they wake the physics engine every frame),
//       tiny parts that still cast shadows, MeshParts with Precise
//       collision / render fidelity, Unions, ParticleEmitters (total rate,
//       emitters over 200/s or with very long lifetimes), Beams / Trails,
//       lights with Shadows on, Decals / Textures, Humanoids, looped
//       playing Sounds, scripts with busy loops (while true without a wait,
//       bare wait() loops, Heartbeat handlers), Models without a PrimaryPart,
//       empty Folders / Models, StreamingEnabled, post effects, plus the
//       Stats service memory (and physics FPS in Play mode). Returns a
//       0-100 score with the penalty breakdown and a findings list whose
//       `fix` names the exact perf_fix op (or model_optimize / vfx_validate
//       / the script to edit). The scoring rules are in PERF.SCORE_RULES.
//   perf_fix {path?, ops?, dry_run?}
//       Applies the mechanical fixes in one undoable step and re-scores:
//         anchor_free       Anchored = true on free parts (see above)
//         shadows_small     CastShadow = false on parts whose longest side < 2
//         mesh_collision    MeshPart / Union CollisionFidelity Precise -> Hull
//                           (Box when the longest side < 3); RenderFidelity
//                           Precise -> Automatic
//         emitter_caps      Rate > 200 -> 200 and Lifetime.Max > 10 -> 10 on
//                           emitters that are not TotalVFX-owned
//         light_shadows     Shadows = false on every light except the 8 with
//                           the largest Range * Brightness
//         empty_containers  delete empty Folders / Models (not under
//                           ServerStorage / ReplicatedStorage)
//         streaming         Workspace.StreamingEnabled = true with
//                           StreamingMinRadius 64 / TargetRadius 256 - NEVER
//                           in the default set (changes replication; scripts
//                           that index Workspace parts directly need
//                           WaitForChild), pass it explicitly
//       Scripts are never rewritten: busy loops are reported with the path
//       and line so you can fix them with script_replace. dry_run:true counts
//       what each op would touch.
//
// Plain Lua syntax only (no +=, continue, ::) so tests/luau-parse-check.py and
// the mocked DataModel in tests/perf-sim.py can run it.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;
  const VERSION = "2.13.0";
  const FIX_OPS = ["anchor_free", "shadows_small", "mesh_collision", "emitter_caps", "light_shadows", "empty_containers", "streaming"];
  const DEFAULT_OPS = ["anchor_free", "shadows_small", "mesh_collision", "emitter_caps", "light_shadows", "empty_containers"];
  const MAX_WALK = 60000;

  const LIB = String.raw`
local HttpService = game:GetService("HttpService")
local ServerStorage = game:GetService("ServerStorage")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Lighting = game:GetService("Lighting")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local PERF = {}
PERF.VERSION = "__VERSION__"
local MAX_WALK = __MAX_WALK__
local function okj(d, t) return HttpService:JSONEncode({ ok = true, data = d or {}, text = t or "" }) end
local function failj(m) return HttpService:JSONEncode({ ok = false, error = tostring(m) }) end
local function resolve(path)
  if path == nil or path == "" then return nil end
  local node = game
  for seg in tostring(path):gsub("^game%.", ""):gmatch("[^%.]+") do
    local nxt = nil
    if node == game then
      if seg:lower() == "workspace" then nxt = workspace
      else local okS, s = pcall(function() return game:GetService(seg) end) nxt = okS and s or game:FindFirstChild(seg) end
    else nxt = node:FindFirstChild(seg) end
    if not nxt then error("path not found: " .. tostring(path) .. " (at '" .. seg .. "')") end
    node = nxt
  end
  return node
end
local function waypoint(label) pcall(function() local chs = game:GetService("ChangeHistoryService") if chs and chs.SetWaypoint then chs:SetWaypoint(label) end end) end
local function r1(v) return math.floor(v * 10 + 0.5) / 10 end
local function maxDim(s) return math.max(s.X, s.Y, s.Z) end
local function safeGet(inst, k) local okG, v = pcall(function() return inst[k] end) if okG then return v end return nil end
local function isCharacter(inst)
  local okC, res = pcall(function()
    for _, p in ipairs(Players:GetPlayers()) do if p.Character and (inst == p.Character or inst:IsDescendantOf(p.Character)) then return true end end
    return false
  end)
  return okC and res or false
end
local function dynamicAncestor(part)
  local n = part.Parent
  while n and n ~= workspace and n ~= game do
    if n:IsA("Model") and (n:FindFirstChildOfClass("Humanoid") or n:FindFirstChildWhichIsA("VehicleSeat", true)) then return true end
    if n:IsA("Tool") or n:IsA("Accessory") then return true end
    n = n.Parent
  end
  return false
end
local function isFreePart(p)
  if not p:IsA("BasePart") or p:IsA("Terrain") then return false end
  if p.Anchored then return false end
  if #p:GetJoints() > 0 then return false end
  for _, c in ipairs(p:GetChildren()) do
    if c:IsA("WeldConstraint") or c:IsA("Constraint") or c:IsA("JointInstance") or c:IsA("BodyMover") then return false end
    if c:IsA("Attachment") then for _, cc in ipairs(c:GetChildren()) do if cc:IsA("Constraint") then return false end end end
  end
  if dynamicAncestor(p) or isCharacter(p) then return false end
  return true
end
local function scriptRoots()
  local roots = {}
  for _, name in ipairs({ "ServerScriptService", "StarterPlayer", "StarterGui", "ReplicatedStorage", "ReplicatedFirst", "StarterPack" }) do
    local okS, s = pcall(function() return game:GetService(name) end)
    if okS and s then roots[#roots + 1] = s end
  end
  return roots
end
local function busyLoops(src)
  local out = {}
  local lineNo = 0
  local inLoop = false
  local loopLine = 0
  local sawWait = false
  for line in (src .. "\n"):gmatch("([^\n]*)\n") do
    lineNo = lineNo + 1
    local l = line:gsub("%-%-.*$", "")
    if l:find("while%s+true%s+do") or l:find("while%s+wait%(") or l:find("repeat") and l:find("until%s+false") then
      if l:find("while%s+wait%(%s*%)") then out[#out + 1] = { line = lineNo, kind = "while wait() do", why = "bare wait() throttles to ~30 Hz and spins forever - use task.wait(interval) or an event" } end
      inLoop = true loopLine = lineNo sawWait = l:find("wait%(") ~= nil
    end
    if inLoop and lineNo ~= loopLine then
      if l:find("task%.wait") or l:find("wait%(") or l:find("Heartbeat:Wait") or l:find("Stepped:Wait") or l:find("RenderStepped:Wait") or l:find(":Wait%(") then
        if l:find("wait%(%s*%)") and not l:find("task%.wait%(%s*%)") then out[#out + 1] = { line = lineNo, kind = "wait() in loop", why = "legacy wait() with no interval - task.wait(n) with a real interval" } end
        sawWait = true
      end
      if l:find("^%s*end") or l:find("%send%s*$") then
        if not sawWait then out[#out + 1] = { line = loopLine, kind = "loop without wait", why = "a while true loop with no yield freezes the server / client" } end
        inLoop = false
      end
    end
  end
  return out
end

PERF.SCORE_RULES = {
  { id = "parts", text = "parts > 5000 -10, > 15000 -20, > 30000 -30" },
  { id = "free_parts", text = "free unanchored parts: -1 per 20 (max -15)" },
  { id = "shadow_small", text = "tiny parts casting shadows: -1 per 50 (max -10)" },
  { id = "precise_mesh", text = "Precise collision / render MeshParts: -1 per 25 (max -10)" },
  { id = "emitters", text = "total particle rate > 2000/s -10, > 5000/s -20; heavy emitters -2 each (max -10)" },
  { id = "shadow_lights", text = "lights with Shadows: > 8 -5, > 24 -10" },
  { id = "busy_loops", text = "busy script loops: -5 each (max -20)" },
  { id = "humanoids", text = "Humanoids > 30 -5, > 80 -15" },
  { id = "streaming", text = "StreamingEnabled off with > 8000 parts -10" },
  { id = "post_fx", text = "more than 3 enabled post effects -5" },
  { id = "unions", text = "Unions > 200 -5; Decals + Textures > 500 -5; looped playing sounds > 10 -5" },
}

function PERF.measure(a)
  local root = nil
  if a.path ~= nil and a.path ~= "" then root = resolve(a.path) end
  local limit = tonumber(a.limit) or MAX_WALK
  local m = {
    instances = 0, parts = 0, free_parts = 0, shadow_small = 0, mesh_parts = 0, precise_collision = 0, precise_render = 0, unions = 0,
    invisible_parts = 0, lights = 0, shadow_lights = 0, emitters = 0, emitters_enabled = 0, emitter_rate = 0, heavy_emitters = 0,
    beams = 0, trails = 0, decals = 0, sounds = 0, looped_playing_sounds = 0, humanoids = 0, models = 0, models_no_primary = 0,
    empty_containers = 0, scripts = 0, local_scripts = 0, module_scripts = 0, busy_loops = 0, heartbeat_handlers = 0, truncated = false,
  }
  local free, smallShadow, precise, heavy, loops, noPrimary, empties, shadowLights = {}, {}, {}, {}, {}, {}, {}, {}
  local walked = 0
  local function visit(d)
    walked = walked + 1
    m.instances = m.instances + 1
    if d:IsA("BasePart") and not d:IsA("Terrain") then
      m.parts = m.parts + 1
      if isFreePart(d) then m.free_parts = m.free_parts + 1 if #free < 40 then free[#free + 1] = d:GetFullName() end end
      if d.CastShadow and maxDim(d.Size) < 2 then m.shadow_small = m.shadow_small + 1 if #smallShadow < 20 then smallShadow[#smallShadow + 1] = d:GetFullName() end end
      if d.Transparency >= 1 then m.invisible_parts = m.invisible_parts + 1 end
      if d:IsA("MeshPart") or d:IsA("UnionOperation") then
        if d:IsA("MeshPart") then m.mesh_parts = m.mesh_parts + 1 else m.unions = m.unions + 1 end
        local cf = safeGet(d, "CollisionFidelity")
        if cf and cf.Name == "PreciseConvexDecomposition" then m.precise_collision = m.precise_collision + 1 if #precise < 20 then precise[#precise + 1] = d:GetFullName() end end
        local rf = safeGet(d, "RenderFidelity")
        if rf and rf.Name == "Precise" then m.precise_render = m.precise_render + 1 end
      end
    elseif d:IsA("Light") then
      m.lights = m.lights + 1
      if d.Shadows then m.shadow_lights = m.shadow_lights + 1 shadowLights[#shadowLights + 1] = d end
    elseif d:IsA("ParticleEmitter") then
      m.emitters = m.emitters + 1
      if d.Enabled then
        m.emitters_enabled = m.emitters_enabled + 1
        m.emitter_rate = m.emitter_rate + d.Rate
        local life = safeGet(d, "Lifetime")
        local lmax = life and life.Max or 1
        if d.Rate > 200 or lmax > 10 or d.Rate * lmax > 1500 then m.heavy_emitters = m.heavy_emitters + 1 if #heavy < 20 then heavy[#heavy + 1] = d:GetFullName() .. " (" .. d.Rate .. "/s x " .. r1(lmax) .. "s)" end end
      end
    elseif d:IsA("Beam") then m.beams = m.beams + 1
    elseif d:IsA("Trail") then m.trails = m.trails + 1
    elseif d:IsA("Decal") then m.decals = m.decals + 1
    elseif d:IsA("Sound") then
      m.sounds = m.sounds + 1
      if d.Looped and (d.Playing or d.IsPlaying) then m.looped_playing_sounds = m.looped_playing_sounds + 1 end
    elseif d:IsA("Humanoid") then m.humanoids = m.humanoids + 1
    elseif d:IsA("Model") then
      m.models = m.models + 1
      if not d.PrimaryPart and #d:GetChildren() > 0 and not d:FindFirstChildOfClass("Humanoid") then m.models_no_primary = m.models_no_primary + 1 if #noPrimary < 20 then noPrimary[#noPrimary + 1] = d:GetFullName() end end
    end
    if (d:IsA("Folder") or d:IsA("Model")) and #d:GetChildren() == 0 and not d:IsDescendantOf(ServerStorage) and not d:IsDescendantOf(ReplicatedStorage) then
      m.empty_containers = m.empty_containers + 1 if #empties < 20 then empties[#empties + 1] = d:GetFullName() end
    end
  end
  local function walk(r)
    if walked >= limit then m.truncated = true return end
    for _, d in ipairs(r:GetDescendants()) do
      if walked >= limit then m.truncated = true return end
      if not (d:IsA("Terrain") or d:IsA("Camera")) then visit(d) end
    end
  end
  if root then walk(root) else walk(workspace) end
  -- scripts (everywhere they can live, or inside the scoped root)
  local function scanScript(sc)
    if sc:IsA("Script") then m.scripts = m.scripts + 1 elseif sc:IsA("LocalScript") then m.local_scripts = m.local_scripts + 1 elseif sc:IsA("ModuleScript") then m.module_scripts = m.module_scripts + 1 else return end
    local okS, src = pcall(function() return sc.Source end)
    if okS and type(src) == "string" and #src > 0 then
      local hb = select(2, src:gsub("Heartbeat:Connect", ""))
      local rs = select(2, src:gsub("RenderStepped:Connect", ""))
      m.heartbeat_handlers = m.heartbeat_handlers + hb + rs
      for _, l in ipairs(busyLoops(src)) do
        m.busy_loops = m.busy_loops + 1
        if #loops < 20 then loops[#loops + 1] = { path = sc:GetFullName(), line = l.line, kind = l.kind, why = l.why } end
      end
    end
  end
  if root then
    if root:IsA("LuaSourceContainer") then scanScript(root) end
    for _, d in ipairs(root:GetDescendants()) do if d:IsA("LuaSourceContainer") then scanScript(d) end end
  else
    for _, d in ipairs(workspace:GetDescendants()) do if d:IsA("LuaSourceContainer") then scanScript(d) end end
    for _, r in ipairs(scriptRoots()) do for _, d in ipairs(r:GetDescendants()) do if d:IsA("LuaSourceContainer") then scanScript(d) end end end
  end
  -- place-level settings
  m.streaming_enabled = safeGet(workspace, "StreamingEnabled") == true
  m.global_shadows = safeGet(Lighting, "GlobalShadows") ~= false
  local fx = 0
  for _, c in ipairs(Lighting:GetChildren()) do if c:IsA("PostEffect") and c.Enabled ~= false then fx = fx + 1 end end
  m.post_effects = fx
  local okStats, stats = pcall(function() return game:GetService("Stats") end)
  if okStats and stats then
    local okMem, mem = pcall(function() return stats:GetTotalMemoryUsageMb() end)
    if okMem and type(mem) == "number" then m.memory_mb = r1(mem) end
  end
  local running = false
  pcall(function() running = RunService:IsRunning() end)
  if running then local okF, f = pcall(function() return workspace:GetRealPhysicsFPS() end) if okF and type(f) == "number" then m.physics_fps = r1(f) end end
  m.mode = running and "play" or "edit"
  m.samples = { free_parts = free, shadow_small = smallShadow, precise = precise, heavy_emitters = heavy, busy_loops = loops, models_no_primary = noPrimary, empty_containers = empties }
  m.shadow_light_instances = shadowLights
  return m
end

function PERF.score(m)
  local pen = {}
  local function add(id, pts, detail) if pts > 0 then pen[#pen + 1] = { id = id, points = pts, detail = detail } end end
  if m.parts > 30000 then add("parts", 30, m.parts .. " parts") elseif m.parts > 15000 then add("parts", 20, m.parts .. " parts") elseif m.parts > 5000 then add("parts", 10, m.parts .. " parts") end
  add("free_parts", math.min(15, math.floor(m.free_parts / 20)), m.free_parts .. " free unanchored parts")
  add("shadow_small", math.min(10, math.floor(m.shadow_small / 50)), m.shadow_small .. " tiny parts cast shadows")
  add("precise_mesh", math.min(10, math.floor((m.precise_collision + m.precise_render) / 25)), (m.precise_collision + m.precise_render) .. " Precise fidelity meshes")
  if m.emitter_rate > 5000 then add("emitters", 20, m.emitter_rate .. " particles/s") elseif m.emitter_rate > 2000 then add("emitters", 10, m.emitter_rate .. " particles/s") end
  add("heavy_emitters", math.min(10, m.heavy_emitters * 2), m.heavy_emitters .. " heavy emitters")
  if m.shadow_lights > 24 then add("shadow_lights", 10, m.shadow_lights .. " shadow lights") elseif m.shadow_lights > 8 then add("shadow_lights", 5, m.shadow_lights .. " shadow lights") end
  add("busy_loops", math.min(20, m.busy_loops * 5), m.busy_loops .. " busy loops")
  if m.humanoids > 80 then add("humanoids", 15, m.humanoids .. " Humanoids") elseif m.humanoids > 30 then add("humanoids", 5, m.humanoids .. " Humanoids") end
  if not m.streaming_enabled and m.parts > 8000 then add("streaming", 10, "StreamingEnabled off with " .. m.parts .. " parts") end
  if (m.post_effects or 0) > 3 then add("post_fx", 5, m.post_effects .. " post effects enabled") end
  if m.unions > 200 then add("unions", 5, m.unions .. " unions") end
  if m.decals > 500 then add("decals", 5, m.decals .. " decals / textures") end
  if m.looped_playing_sounds > 10 then add("sounds", 5, m.looped_playing_sounds .. " looped sounds playing") end
  local total = 0
  for _, p in ipairs(pen) do total = total + p.points end
  return math.max(0, 100 - total), pen
end

local function grade(s) if s >= 90 then return "excellent" elseif s >= 75 then return "good" elseif s >= 55 then return "needs work" else return "poor" end end

function PERF.audit(a)
  local m = PERF.measure(a)
  local score, pen = PERF.score(m)
  local findings = {}
  local function f(sev, id, count, detail, fix) if count and count > 0 then findings[#findings + 1] = { severity = sev, id = id, count = count, detail = detail, fix = fix } end end
  f(m.free_parts >= 100 and "high" or "medium", "free_parts", m.free_parts, "unanchored parts with no joints (physics simulates every one; they fall / drift / wake neighbours). Samples: " .. table.concat(m.samples.free_parts, ", "), "perf_fix {ops:['anchor_free']}")
  f("low", "shadow_small", m.shadow_small, "parts under 2 studs still cast shadows", "perf_fix {ops:['shadows_small']}")
  f("medium", "precise_mesh", m.precise_collision + m.precise_render, m.precise_collision .. " Precise collision + " .. m.precise_render .. " Precise render meshes. Samples: " .. table.concat(m.samples.precise, ", "), "perf_fix {ops:['mesh_collision']} (model_optimize {path} for one model)")
  f(m.emitter_rate > 5000 and "high" or "medium", "heavy_emitters", m.heavy_emitters, "emitters over 200/s or 10 s lifetime: " .. table.concat(m.samples.heavy_emitters, ", ") .. " (total " .. m.emitter_rate .. " particles/s)", "perf_fix {ops:['emitter_caps']} or vfx_validate {path}")
  f("medium", "shadow_lights", m.shadow_lights > 8 and m.shadow_lights or 0, m.shadow_lights .. " lights with Shadows (each one is an extra shadow pass)", "perf_fix {ops:['light_shadows']}")
  for _, l in ipairs(m.samples.busy_loops) do findings[#findings + 1] = { severity = "high", id = "busy_loop", count = 1, detail = l.path .. ":" .. l.line .. " " .. l.kind .. " - " .. l.why, fix = "script_read " .. l.path .. " then script_replace (perf_fix never rewrites scripts)" } end
  f("medium", "humanoids", m.humanoids > 30 and m.humanoids or 0, m.humanoids .. " Humanoids (NPCs cost physics + animation every frame)", "pool / despawn NPCs out of range; Humanoid:SetStateEnabled off for unused states")
  f(m.parts > 15000 and "high" or "medium", "parts", m.parts > 5000 and m.parts or 0, m.parts .. " parts in scope", (m.streaming_enabled and "" or "perf_fix {ops:['streaming']} (explicit - changes replication) and ") .. "model_optimize / mesh_shape_create to merge detail")
  f("low", "models_no_primary", m.models_no_primary, "Models without PrimaryPart: " .. table.concat(m.samples.models_no_primary, ", "), "quality_fix {ops:['primary_part']}")
  f("low", "empty_containers", m.empty_containers, "empty Folders / Models: " .. table.concat(m.samples.empty_containers, ", "), "perf_fix {ops:['empty_containers']}")
  f("low", "post_fx", (m.post_effects or 0) > 3 and m.post_effects or 0, m.post_effects .. " post effects enabled at once", "keep Bloom + ColorCorrection, drop Blur / DepthOfField on low tier")
  f("low", "looped_sounds", m.looped_playing_sounds > 10 and m.looped_playing_sounds or 0, m.looped_playing_sounds .. " looped sounds playing", "sound_ambience_zone_create / stop sounds far from players")
  table.sort(findings, function(x, y) local o = { high = 0, medium = 1, low = 2 } if o[x.severity] ~= o[y.severity] then return o[x.severity] < o[y.severity] end return (x.count or 0) > (y.count or 0) end)
  local fixOps = {}
  local seen = {}
  for _, fd in ipairs(findings) do local op = tostring(fd.fix):match("perf_fix %{ops:%['([%w_]+)'%]") if op and not seen[op] and op ~= "streaming" then seen[op] = true fixOps[#fixOps + 1] = op end end
  m.samples = nil m.shadow_light_instances = nil
  local pd = {}
  for _, p in ipairs(pen) do pd[#pd + 1] = p.id .. " -" .. p.points .. " (" .. p.detail .. ")" end
  local top = {}
  for i = 1, math.min(4, #findings) do top[#top + 1] = findings[i].id .. " x" .. findings[i].count end
  return okj({ score = score, grade = grade(score), penalties = pen, metrics = m, findings = findings, fix_ops = fixOps, rules = PERF.SCORE_RULES, scope = a.path or "Workspace + scripts + Lighting" },
    "PERF " .. score .. "/100 (" .. grade(score) .. ") for " .. (a.path or "the place") .. " in " .. m.mode .. " mode: " .. m.instances .. " instances, " .. m.parts .. " parts (" .. m.free_parts .. " free unanchored), " .. m.mesh_parts .. " meshes (" .. m.precise_collision .. " precise), " .. m.emitters .. " emitters (" .. m.emitter_rate .. "/s), " .. m.lights .. " lights (" .. m.shadow_lights .. " shadowed), " .. (m.scripts + m.local_scripts + m.module_scripts) .. " scripts (" .. m.busy_loops .. " busy loops), " .. m.humanoids .. " humanoids, streaming " .. (m.streaming_enabled and "on" or "off") .. (m.memory_mb and (", " .. m.memory_mb .. " MB") or "") .. (m.physics_fps and (", physics " .. m.physics_fps .. " fps") or "") .. (m.truncated and " [walk truncated at " .. (tonumber(a.limit) or MAX_WALK) .. "]" or "") .. ". Penalties: " .. (#pd > 0 and table.concat(pd, "; ") or "none") .. "." .. (#findings > 0 and (" Top: " .. table.concat(top, ", ") .. ". ") or " ") .. (#fixOps > 0 and ("perf_fix {ops:" .. HttpService:JSONEncode(fixOps) .. "} applies the mechanical ones; ") or "") .. "busy loops need script edits. Scores are heuristics from instance counts, not a measured frame time - verify in Play with the MicroProfiler.")
end

function PERF.fix(a)
  local ops = a.ops
  if type(ops) ~= "table" or #ops == 0 then ops = { "anchor_free", "shadows_small", "mesh_collision", "emitter_caps", "light_shadows", "empty_containers" } end
  local want = {}
  for _, o in ipairs(ops) do want[tostring(o)] = true end
  local dry = a.dry_run == true
  local before = PERF.measure(a)
  local scoreBefore = PERF.score(before)
  local root = (a.path ~= nil and a.path ~= "") and resolve(a.path) or workspace
  local counts = {}
  local function bump(k) counts[k] = (counts[k] or 0) + 1 end
  if not dry then waypoint("TotalScript perf_fix") end
  local shadowKeep = {}
  if want.light_shadows then
    local lights = before.shadow_light_instances or {}
    table.sort(lights, function(x, y) return (x.Range or 0) * (x.Brightness or 1) > (y.Range or 0) * (y.Brightness or 1) end)
    for i = 1, math.min(8, #lights) do shadowKeep[lights[i]] = true end
  end
  local toDelete = {}
  for _, d in ipairs(root:GetDescendants()) do
    if d:IsA("BasePart") and not d:IsA("Terrain") then
      if want.anchor_free and isFreePart(d) then bump("anchor_free") if not dry then d.Anchored = true end end
      if want.shadows_small and d.CastShadow and maxDim(d.Size) < 2 then bump("shadows_small") if not dry then d.CastShadow = false end end
      if want.mesh_collision and (d:IsA("MeshPart") or d:IsA("UnionOperation")) then
        local cf = safeGet(d, "CollisionFidelity")
        if cf and cf.Name == "PreciseConvexDecomposition" then bump("mesh_collision") if not dry then pcall(function() d.CollisionFidelity = maxDim(d.Size) < 3 and Enum.CollisionFidelity.Box or Enum.CollisionFidelity.Hull end) end end
        local rf = safeGet(d, "RenderFidelity")
        if rf and rf.Name == "Precise" then bump("mesh_render") if not dry then pcall(function() d.RenderFidelity = Enum.RenderFidelity.Automatic end) end end
      end
    elseif want.emitter_caps and d:IsA("ParticleEmitter") and d.Enabled then
      local owned = d.Parent and (d.Parent:GetAttribute("TotalVFX") ~= nil or d:GetAttribute("Owner") ~= nil)
      if not owned then
        local life = safeGet(d, "Lifetime")
        local lmax = life and life.Max or 1
        if d.Rate > 200 then bump("emitter_caps") if not dry then d.Rate = 200 end end
        if lmax > 10 then bump("emitter_lifetime") if not dry then pcall(function() d.Lifetime = NumberRange.new(math.min(life.Min, 10), 10) end) end end
      end
    elseif want.light_shadows and d:IsA("Light") and d.Shadows and not shadowKeep[d] then
      bump("light_shadows") if not dry then d.Shadows = false end
    elseif want.empty_containers and (d:IsA("Folder") or d:IsA("Model")) and #d:GetChildren() == 0 and not d:IsDescendantOf(ServerStorage) and not d:IsDescendantOf(ReplicatedStorage) then
      bump("empty_containers") toDelete[#toDelete + 1] = d
    end
  end
  if not dry then for _, d in ipairs(toDelete) do pcall(function() d:Destroy() end) end end
  if want.streaming then
    if not safeGet(workspace, "StreamingEnabled") then
      bump("streaming")
      if not dry then pcall(function() workspace.StreamingEnabled = true workspace.StreamingMinRadius = 64 workspace.StreamingTargetRadius = 256 end) end
    end
  end
  if not dry then waypoint("TotalScript perf_fix done") end
  local after = dry and before or PERF.measure(a)
  local scoreAfter = PERF.score(after)
  after.samples = nil after.shadow_light_instances = nil before.samples = nil before.shadow_light_instances = nil
  local parts = {}
  for _, k in ipairs({ "anchor_free", "shadows_small", "mesh_collision", "mesh_render", "emitter_caps", "emitter_lifetime", "light_shadows", "empty_containers", "streaming" }) do if counts[k] then parts[#parts + 1] = k .. " " .. counts[k] end end
  local unknown = {}
  for o in pairs(want) do local known = false for _, k in ipairs({ "anchor_free", "shadows_small", "mesh_collision", "emitter_caps", "light_shadows", "empty_containers", "streaming" }) do if k == o then known = true end end if not known then unknown[#unknown + 1] = o end end
  return okj({ dry_run = dry, ops = ops, counts = counts, score_before = scoreBefore, score_after = scoreAfter, metrics_before = before, metrics_after = after, unknown_ops = unknown, busy_loops = after.busy_loops },
    (dry and "DRY RUN - would change: " or "PERF FIX applied: ") .. (#parts > 0 and table.concat(parts, ", ") or "nothing matched") .. ". Score " .. scoreBefore .. " -> " .. scoreAfter .. "/100" .. (#unknown > 0 and (". Unknown ops ignored: " .. table.concat(unknown, ", ")) or "") .. (after.busy_loops > 0 and (". " .. after.busy_loops .. " busy script loop(s) still need script edits (perf_audit lists path:line)") or "") .. (want.streaming and counts.streaming and not dry and ". StreamingEnabled is now ON: scripts that index Workspace parts at start must WaitForChild" or "") .. ". Undo: Ctrl+Z (one waypoint).")
end

function PERF.run(op, a)
  a = a or {}
  local okR, res = pcall(function()
    if op == "perf_audit" then return PERF.audit(a) end
    if op == "perf_fix" then return PERF.fix(a) end
    return failj("unknown op " .. tostring(op))
  end)
  if okR then return res end
  return failj(res)
end
`.replace("__VERSION__", VERSION).replace("__MAX_WALK__", String(MAX_WALK));

  const C = [
    { name: "perf_audit", description: "Score the place (or one subtree) 0-100 for runtime performance from what really costs frames on Roblox: part count, FREE unanchored parts (no joint / constraint, outside characters and vehicles), tiny parts casting shadows, MeshParts / Unions with Precise collision or render fidelity, ParticleEmitters (total rate, > 200/s or > 10 s lifetime), lights with Shadows, Humanoids, looped playing sounds, scripts with busy loops (while true without a yield, bare wait() loops) and Heartbeat handlers, Models without PrimaryPart, empty containers, StreamingEnabled, post effects, Stats memory (physics FPS in Play). Returns penalties, findings with the exact fix (perf_fix op, model_optimize, vfx_validate or the script path:line) and fix_ops ready for perf_fix. Heuristic from instance counts - not a measured frame time.",
      params: {
        path: { type: "string", req: false, desc: "subtree to audit (default Workspace + script containers + Lighting)" },
        limit: { type: "number", req: false, desc: "max instances walked (default 60000; the result says when truncated)" },
      } },
    { name: "perf_fix", description: "Apply the mechanical performance fixes in one undoable step and re-score: anchor_free (Anchored on free parts), shadows_small (CastShadow off under 2 studs), mesh_collision (Precise -> Hull / Box, RenderFidelity Precise -> Automatic), emitter_caps (Rate <= 200, Lifetime <= 10 s on non-TotalVFX emitters), light_shadows (keep shadows on the 8 strongest lights), empty_containers (delete empty Folders / Models), streaming (Workspace.StreamingEnabled + 64/256 radii - explicit only, never in the default set). Scripts are never rewritten - busy loops are listed for script_replace. dry_run counts first.",
      params: {
        path: { type: "string", req: false, desc: "subtree to fix (default Workspace)" },
        ops: { type: "array", req: false, desc: "subset of " + FIX_OPS.join("|") + " (default all except streaming)" },
        dry_run: { type: "boolean", req: false, desc: "only count what would change" },
      } },
  ];
  const NAMES = C.map((c) => c.name);

  function validate(op, a) {
    if (op === "perf_audit") {
      if (a.limit != null && !(Number(a.limit) >= 100)) return "limit must be >= 100";
    }
    if (op === "perf_fix") {
      if (a.ops != null && !Array.isArray(a.ops)) return `ops must be an array of ${FIX_OPS.join("|")}`;
      if (Array.isArray(a.ops)) {
        const bad = a.ops.map(String).filter((o) => !FIX_OPS.includes(o));
        if (bad.length) return `unknown ops [${bad.join(", ")}] - use ${FIX_OPS.join("|")}`;
      }
    }
    return null;
  }

  function build(op, args) {
    if (!NAMES.includes(op)) return null;
    const a = args || {};
    const pre = validate(op, a);
    if (pre) return { err: `ERROR ${op}: ${pre}` };
    let json;
    try { json = JSON.stringify(a); } catch (e) { return { err: `ERROR ${op}: arguments are not serialisable` }; }
    if (json.includes("]==]")) return { err: `ERROR ${op}: arguments contain ']==]'` };
    const body = `local __a = HttpService:JSONDecode([==[${json}]==])\nreturn PERF.run(${JSON.stringify(op)}, __a)`;
    return { code: LIB + "\n" + body, lib: LIB, body };
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = build(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const names = new Set(NAMES);
  const arr = RobloxScriptSkills.SKILL_COMMANDS;
  for (let i = arr.length - 1; i >= 0; i--) if (names.has(arr[i].name)) arr.splice(i, 1);
  for (const c of C) arr.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.PERF_COMMANDS = NAMES.slice();
  RobloxScriptSkills.PERF_VERSION = VERSION;
  RobloxScriptSkills.PERF_LIB = LIB;
  RobloxScriptSkills.PERF_FIX_OPS = FIX_OPS.slice();
  RobloxScriptSkills.PERF_DEFAULT_OPS = DEFAULT_OPS.slice();
  RobloxScriptSkills.validatePerf = validate;
})();
