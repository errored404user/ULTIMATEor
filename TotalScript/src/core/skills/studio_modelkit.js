// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript model kit (2.19.0) - real procedural builders for the things
// people actually ask an agent to model: buildings and structures, vehicles,
// weapons, furniture, smooth EditableMesh shapes, detail passes and seeded
// variants.
//
// Before this pack "model creation" meant model_build (hand-written JSON part
// lists), model_prefab (24 small props), generate_procedural_model (8 blocky
// kinds) and a row of NOT_IMPLEMENTED stubs in the x100 pack (staircase,
// archway, fence, roof, bridge, dungeon room, vehicle chassis). Everything
// here is Luau that runs in Studio through the normal skill path:
//
//   structure_build    18 architectural kinds (house, tower, castle_wall, gatehouse, bridge, staircase,
//                      spiral_staircase, archway, fence, gate, roof, dungeon_room, dock, watchtower,
//                      windmill, lighthouse, barn, pergola) with real door / window openings, roofs,
//                      interiors, 8 style palettes and working hinge motors (windmill, lighthouse beam)
//   vehicle_build      car, truck, kart, buggy, boat, raft, plane, helicopter, tank, wagon - optional
//                      drivable rig: VehicleSeat + HingeConstraint wheel motors (or LinearVelocity /
//                      AngularVelocity for boats and aircraft) + a small drive Script
//   weapon_build       20 weapon kinds, optional Tool wrapper (Handle, Grip, Tip / Muzzle attachments
//                      for weapon_trail_enable / weapon_hitbox_create)
//   furniture_build    18 furniture kinds beyond model_prefab (sofa, desk, wardrobe, fridge, throne, piano ...)
//   mesh_shape_create  smooth EditableMesh primitives (sphere, icosphere, torus, cone, capsule, cylinder,
//                      dome, ring, prism, star, gear, crystal, egg, rock, lathe, tube) -> MeshPart, with
//                      an honest Part fallback when EditableMesh is unavailable
//   model_detail       non-destructive detail passes on an existing model: trim, rivets, planks, wear, bevel, moss
//   model_variant      seeded variations of an existing model (scale, hue, mirror, drop small parts)
//
// One shared Luau library (MK) + a tiny body per call so main.js caches the
// library in Studio (runSkillLuau). Plain Lua syntax only (no +=, continue,
// ::) so tests/luau-parse-check.py and tests/modelkit-sim.py can read it.
// Nothing here invents asset ids: geometry is Parts, WedgeParts,
// CornerWedgeParts and EditableMesh triangles built from arithmetic.
//
// Verification level (2.19.0): every command runs green in tests/modelkit-sim.py
// (mocked DataModel) and the Luau parses; NOT verified in Studio yet: hip-roof
// CornerWedgePart orientation, wedge blade tips, the hinge-motor drive feel and
// AssetService:CreateMeshPartAsync (the sim only checks the triangle lists).
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;
  const VERSION = "2.19.0";

  const STRUCTURES = ["house", "tower", "castle_wall", "gatehouse", "bridge", "staircase", "spiral_staircase", "archway", "fence", "gate", "roof", "dungeon_room", "dock", "watchtower", "windmill", "lighthouse", "barn", "pergola"];
  const STYLES = ["medieval", "rustic", "modern", "fantasy", "scifi", "desert", "stone", "industrial"];
  const ROOFS = ["gable", "hip", "flat", "shed", "none"];
  const VEHICLES = ["car", "truck", "kart", "buggy", "boat", "raft", "plane", "helicopter", "tank", "wagon"];
  const WEAPONS = ["sword", "greatsword", "dagger", "katana", "axe", "battleaxe", "mace", "hammer", "spear", "bow", "crossbow", "staff", "wand", "shield", "pistol", "rifle", "shotgun", "sniper", "bat", "pickaxe"];
  const WEAPON_STYLES = ["steel", "iron", "gold", "dark", "crystal", "wooden", "scifi"];
  const FURNITURE = ["sofa", "armchair", "desk", "wardrobe", "shelf", "stool", "counter", "bar_stool", "fridge", "oven", "sink", "bathtub", "toilet", "tv", "floor_lamp", "bunk_bed", "throne", "piano"];
  const FURNITURE_STYLES = ["modern", "rustic", "royal", "scifi", "cozy"];
  const SHAPES = ["sphere", "icosphere", "torus", "cone", "capsule", "cylinder", "dome", "ring", "prism", "star", "gear", "crystal", "egg", "rock", "lathe", "tube"];
  const DETAIL_OPS = ["trim", "rivets", "planks", "wear", "bevel", "moss"];

  // -- shared Luau library ------------------------------------------------
  const LIB = String.raw`
local HttpService = game:GetService("HttpService")
local AssetService = game:GetService("AssetService")
local MK = {}
MK.VERSION = "__VERSION__"
MK.MAX_PARTS = 1500
local function okj(d, t) return HttpService:JSONEncode({ ok = true, data = d or {}, text = t or "" }) end
local function failj(m) return HttpService:JSONEncode({ ok = false, error = tostring(m) }) end
MK.okj = okj MK.failj = failj
local PI, TAU = math.pi, math.pi * 2
local function num(v, d, lo, hi) local n = tonumber(v) if n == nil then n = d end if lo and n < lo then n = lo end if hi and n > hi then n = hi end return n end
local function clamp(v, a, b) if v < a then return a end if v > b then return b end return v end
local function vec(a, dx, dy, dz) if typeof(a) == "Vector3" then return a end if type(a) ~= "table" then return Vector3.new(dx or 0, dy or 0, dz or 0) end return Vector3.new(num(a[1], dx or 0), num(a[2], dy or 0), num(a[3], dz or 0)) end
local function key(v, d) if v == nil or v == "" then return d end local s = tostring(v):lower():gsub("[%s%-]", "_") return s end
-- 2.4.0: when the call does not name a style, the project style (project_style -> ServerStorage._TotalStyle) decides
local function projectStyle(field)
  local okS, v = pcall(function() local f = game:GetService("ServerStorage"):FindFirstChild("_TotalStyle") return f and f:GetAttribute(field) end)
  if okS and type(v) == "string" and v ~= "" then return v end
  return nil
end
local function C(r, g, b) return Color3.fromRGB(r, g, b) end
local function shade(c, k) return Color3.new(clamp(c.R * k, 0, 1), clamp(c.G * k, 0, 1), clamp(c.B * k, 0, 1)) end
local function rnd(seed) local s = math.floor(num(seed, 1)) % 2147483647 if s <= 0 then s = s + 2147483646 end return function(lo, hi) s = (s * 48271) % 2147483647 local r = (s - 1) / 2147483646 if lo == nil then return r end return lo + (hi - lo) * r end end
MK.num = num MK.clamp = clamp MK.vec = vec MK.key = key MK.rnd = rnd MK.shade = shade
local NAMED = { red = {200,40,40}, green = {60,150,70}, blue = {50,90,200}, yellow = {230,200,60}, orange = {230,130,40}, purple = {130,60,170}, pink = {230,120,170}, white = {240,240,240}, black = {25,25,28}, gray = {130,130,135}, grey = {130,130,135}, brown = {110,75,45}, wood = {140,100,60}, stone = {135,135,130}, gold = {212,175,55}, silver = {190,192,198}, cyan = {60,200,220}, teal = {40,150,150}, aqua = {34,211,238}, navy = {30,45,90}, beige = {215,200,170}, cream = {245,238,215}, sand = {220,200,150}, lime = {150,220,70}, maroon = {110,30,40}, copper = {184,115,51}, bronze = {150,100,50}, rust = {160,80,40}, iron = {95,98,105}, steel = {160,165,175}, crimson = {170,30,50}, violet = {120,80,200} }
local function rgb(c, d)
  if typeof(c) == "Color3" then return c end
  if type(c) == "table" and c[1] ~= nil then
    local r, g, b = num(c[1], 0), num(c[2], 0), num(c[3], 0)
    if r <= 1 and g <= 1 and b <= 1 then return Color3.new(r, g, b) end
    return C(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255))
  end
  if type(c) == "table" and c.r ~= nil then return rgb({ c.r, c.g, c.b }, d) end
  if type(c) == "string" then
    local s = c:lower():gsub("[%s_%-]", "")
    local hex = s:match("^#?(%x%x%x%x%x%x)$")
    if hex then return C(tonumber(hex:sub(1, 2), 16), tonumber(hex:sub(3, 4), 16), tonumber(hex:sub(5, 6), 16)) end
    local n = NAMED[s] if n then return C(n[1], n[2], n[3]) end
  end
  return d
end
MK.rgb = rgb
local function matOf(n, d) if typeof(n) == "EnumItem" then return n end if n == nil or n == "" then return d end local okE, m = pcall(function() return Enum.Material[tostring(n)] end) if okE and m then return m end local okL, mm = pcall(function() local s = tostring(n):lower() for _, item in ipairs(Enum.Material:GetEnumItems()) do if item.Name:lower() == s then return item end end end) if okL and mm then return mm end return d end
MK.mat = matOf
local M = setmetatable({}, { __index = function(_, k) return Enum.Material[k] end })

-- builder --------------------------------------------------------------------
local function newB(model, R, S) return { m = model, R = R or CFrame.new(), S = S, n = 0, parts = {} } end
local function mk(b, class, size, cf, col, mat, name, props)
  if b.n + 1 > MK.MAX_PARTS then error(("part budget exceeded (%d parts) - build in several calls"):format(MK.MAX_PARTS)) end
  b.n = b.n + 1
  local p = Instance.new(class)
  p.Name = name or class
  p.Size = size
  p.CFrame = b.R * cf
  p.Anchored = true
  p.Color = col or C(163, 162, 165)
  p.Material = mat or M.SmoothPlastic
  p.TopSurface = Enum.SurfaceType.Smooth p.BottomSurface = Enum.SurfaceType.Smooth
  if props then for k, v in pairs(props) do p[k] = v end end
  p.Parent = b.m
  b.parts[#b.parts + 1] = p
  return p
end
local function at(x, y, z) return CFrame.new(x, y, z) end
local function box(b, sx, sy, sz, cf, col, mat, name, props) return mk(b, "Part", Vector3.new(sx, sy, sz), cf, col, mat, name, props) end
-- a real Seat (players can sit): same footprint as a box, Seat class has no Shape so it is always a block
local function seatBox(b, sx, sy, sz, cf, col, mat, name, props) return mk(b, "Seat", Vector3.new(sx, sy, sz), cf, col, mat, name or "Seat", props) end
local function wedge(b, sx, sy, sz, cf, col, mat, name, props) return mk(b, "WedgePart", Vector3.new(sx, sy, sz), cf, col, mat, name, props) end
local function cwedge(b, sx, sy, sz, cf, col, mat, name) return mk(b, "CornerWedgePart", Vector3.new(sx, sy, sz), cf, col, mat, name) end
local ROT_Y = CFrame.Angles(0, 0, PI / 2)
local ROT_Z = CFrame.Angles(0, PI / 2, 0)
local function withShape(shape, props) local t = { Shape = shape } if props then for k, v in pairs(props) do t[k] = v end end return t end
local function cylY(b, r, h, cf, col, mat, name, props) return mk(b, "Part", Vector3.new(h, r * 2, r * 2), cf * ROT_Y, col, mat, name, withShape(Enum.PartType.Cylinder, props)) end
local function cylX(b, r, len, cf, col, mat, name, props) return mk(b, "Part", Vector3.new(len, r * 2, r * 2), cf, col, mat, name, withShape(Enum.PartType.Cylinder, props)) end
local function cylZ(b, r, len, cf, col, mat, name, props) return mk(b, "Part", Vector3.new(len, r * 2, r * 2), cf * ROT_Z, col, mat, name, withShape(Enum.PartType.Cylinder, props)) end
local function ball(b, r, cf, col, mat, name, props) return mk(b, "Part", Vector3.new(r * 2, r * 2, r * 2), cf, col, mat, name, withShape(Enum.PartType.Ball, props)) end
local function glass(b, sx, sy, sz, cf, col, name) return box(b, sx, sy, sz, cf, col or C(170, 210, 230), M.Glass, name or "Glass", { Transparency = 0.35, CanCollide = true }) end
local function light(parent, kind, color, bright, range, extra)
  local L = Instance.new(kind or "PointLight") L.Color = color or C(255, 214, 150) L.Brightness = bright or 1.5 L.Range = range or 16 L.Shadows = true
  if extra then for k, v in pairs(extra) do L[k] = v end end
  L.Parent = parent return L
end
local function attach(part, name, cf) local a = Instance.new("Attachment") a.Name = name a.CFrame = cf or CFrame.new() a.Parent = part return a end
local function weld(root, p) if p == root then return end local w = Instance.new("WeldConstraint") w.Name = "Weld_" .. p.Name w.Part0 = root w.Part1 = p w.Parent = p end
local function hinge(p0, p1, cf0, cf1, name, props)
  local a0 = attach(p0, (name or "Hinge") .. "A0", cf0) local a1 = attach(p1, (name or "Hinge") .. "A1", cf1)
  local h = Instance.new("HingeConstraint") h.Name = name or "Hinge" h.Attachment0 = a0 h.Attachment1 = a1
  if props then for k, v in pairs(props) do h[k] = v end end
  h.Parent = p0 return h
end
local function motor(p0, p1, cf0, cf1, name, speed, torque) return hinge(p0, p1, cf0, cf1, name, { ActuatorType = Enum.ActuatorType.Motor, AngularVelocity = speed or 1, MotorMaxTorque = torque or 100000, MotorMaxAcceleration = 50 }) end
-- CFrame whose local X axis runs from p to q (for cylX segments); returns cf, length
local function segCF(p, q)
  local d = q - p local L = d.Magnitude
  if L < 1e-6 then return CFrame.new(p), 0 end
  local u = d / L
  return CFrame.new((p + q) / 2) * CFrame.Angles(0, math.atan2(-u.Z, u.X), 0) * CFrame.Angles(0, 0, math.asin(clamp(u.Y, -1, 1))), L
end
MK.segCF = segCF
MK.newB = newB MK.mk = mk MK.box = box MK.wedge = wedge MK.cylY = cylY MK.cylX = cylX MK.cylZ = cylZ MK.ball = ball MK.at = at MK.light = light MK.attach = attach MK.weld = weld MK.hinge = hinge MK.motor = motor

local function finish(b, name, parent, primary, pivot)
  local m = b.m
  m.Name = name
  if primary then m.PrimaryPart = primary end
  pcall(function() m.WorldPivot = pivot or b.R end)
  m.Parent = parent
  m:SetAttribute("TotalModelKit", MK.VERSION)
  return m
end
local function parentOf(path)
  if path == nil or path == "" then return workspace end
  local node = game
  for seg in tostring(path):gsub("^game%.", ""):gmatch("[^%.]+") do
    local nxt = nil
    if node == game then if seg:lower() == "workspace" then nxt = workspace else local okS, s = pcall(function() return game:GetService(seg) end) nxt = okS and s or game:FindFirstChild(seg) end
    else nxt = node:FindFirstChild(seg) end
    if not nxt then error("parent path not found: " .. tostring(path) .. " (" .. seg .. ")") end
    node = nxt
  end
  return node
end
local function findModel(path)
  if path == nil or path == "" then error("path is required") end
  local okP, node = pcall(parentOf, path)
  if not okP or node == nil or node == workspace or node == game then error("model not found: " .. tostring(path)) end
  return node
end
MK.parentOf = parentOf MK.findModel = findModel
local function rootCF(a) local p = vec(a.position, 0, 0, 0) local ry = math.rad(num(a.rotation, 0)) return CFrame.new(p) * CFrame.Angles(0, ry, 0) end
local function makeModel(a, prefix, kind) local m = Instance.new("Model") m.Name = tostring(a.name or (prefix .. "_" .. kind)) return m end
local function stats(b) return { parts = b.n } end
local function unanchorAll(m) for _, d in ipairs(m:GetDescendants()) do if d:IsA("BasePart") then d.Anchored = false end end end

-- style palettes --------------------------------------------------------------
MK.STYLES = {
  medieval   = { wall = C(205, 190, 160), wallMat = "Brick",   trim = C(96, 70, 48),   trimMat = "Wood",     roof = C(120, 58, 48),  roofMat = "Slate",       accent = C(70, 70, 78),   floor = C(120, 115, 108), floorMat = "Cobblestone", stone = C(132, 130, 126), wood = C(110, 78, 50),  glass = C(180, 205, 220) },
  rustic     = { wall = C(145, 105, 65),  wallMat = "WoodPlanks", trim = C(90, 62, 40), trimMat = "Wood",   roof = C(95, 70, 50),   roofMat = "WoodPlanks",  accent = C(60, 50, 45),   floor = C(120, 90, 60),   floorMat = "WoodPlanks",  stone = C(125, 122, 115), wood = C(128, 92, 58),  glass = C(190, 215, 225) },
  modern     = { wall = C(235, 235, 232), wallMat = "Concrete", trim = C(60, 62, 68),   trimMat = "Metal",    roof = C(55, 57, 62),   roofMat = "Concrete",    accent = C(40, 42, 48),   floor = C(190, 190, 188), floorMat = "Marble",      stone = C(160, 160, 160), wood = C(150, 120, 90), glass = C(150, 200, 230) },
  fantasy    = { wall = C(226, 214, 238), wallMat = "Marble",   trim = C(212, 175, 55), trimMat = "Metal",    roof = C(90, 60, 170),  roofMat = "Slate",       accent = C(80, 200, 220), floor = C(200, 195, 210), floorMat = "Marble",      stone = C(150, 150, 170), wood = C(120, 90, 60),  glass = C(190, 230, 250) },
  scifi      = { wall = C(70, 74, 84),    wallMat = "Metal",    trim = C(34, 211, 238), trimMat = "Neon",     roof = C(50, 54, 62),   roofMat = "DiamondPlate", accent = C(34, 211, 238), floor = C(60, 62, 70),   floorMat = "DiamondPlate", stone = C(90, 92, 100), wood = C(90, 92, 100),  glass = C(120, 220, 240) },
  desert     = { wall = C(222, 196, 150), wallMat = "Sandstone", trim = C(160, 110, 70), trimMat = "Wood",   roof = C(190, 110, 70), roofMat = "Sandstone",   accent = C(90, 130, 150), floor = C(200, 180, 140), floorMat = "Sandstone",   stone = C(200, 180, 140), wood = C(150, 110, 70), glass = C(200, 220, 230) },
  stone      = { wall = C(128, 128, 124), wallMat = "Cobblestone", trim = C(90, 90, 88), trimMat = "Slate", roof = C(70, 72, 78),   roofMat = "Slate",       accent = C(60, 60, 64),   floor = C(110, 110, 106), floorMat = "Cobblestone", stone = C(128, 128, 124), wood = C(100, 72, 46),  glass = C(170, 190, 200) },
  industrial = { wall = C(120, 70, 55),   wallMat = "Brick",    trim = C(80, 82, 86),   trimMat = "CorrodedMetal", roof = C(90, 92, 96), roofMat = "Metal",   accent = C(220, 150, 40), floor = C(100, 100, 100), floorMat = "Concrete",    stone = C(110, 110, 108), wood = C(100, 80, 60),  glass = C(160, 180, 190) },
}
local function styleOf(a, default)
  local s = MK.STYLES[key(a.style, default or "medieval")] or MK.STYLES[default or "medieval"]
  local S = {}
  for k, v in pairs(s) do S[k] = v end
  for k, v in pairs(S) do if type(v) == "string" then S[k] = matOf(v, M.SmoothPlastic) end end
  S.wall = rgb(a.color, S.wall) S.roof = rgb(a.color2 or a.roof_color, S.roof) S.accent = rgb(a.accent, S.accent) S.trim = rgb(a.trim_color, S.trim)
  if a.material then S.wallMat = matOf(a.material, S.wallMat) end
  if a.roof_material then S.roofMat = matOf(a.roof_material, S.roofMat) end
  return S
end
MK.styleOf = styleOf

-- walls with openings ------------------------------------------------------------
-- a0 -> a1 local base points (y = floor), h height, t thickness, openings { {u0,u1,y0,y1,kind}, ... } measured along the wall
local function wallRun(b, o, a0, a1, h, t, openings, col, mat, name, S)
  local dv = a1 - a0 local L = dv.Magnitude if L < 0.05 then return end
  local dir = dv / L local ang = math.atan2(-dir.Z, dir.X)
  local function piece(u0, u1, y0, y1)
    if u1 - u0 < 0.05 or y1 - y0 < 0.05 then return end
    local c = a0 + dir * ((u0 + u1) / 2)
    box(b, u1 - u0, y1 - y0, t, o * at(c.X, c.Y + (y0 + y1) / 2, c.Z) * CFrame.Angles(0, ang, 0), col, mat, name or "Wall")
  end
  local ops = {}
  for _, op in ipairs(openings or {}) do ops[#ops + 1] = op end
  table.sort(ops, function(p, q) return p[1] < q[1] end)
  local u = 0
  for _, op in ipairs(ops) do
    local u0, u1 = clamp(op[1], 0, L), clamp(op[2], 0, L)
    if u1 > u0 + 0.05 and u0 >= u - 0.01 then
      piece(u, u0, 0, h)
      piece(u0, u1, 0, op[3])
      piece(u0, u1, op[4], h)
      u = u1
      local c = a0 + dir * ((u0 + u1) / 2)
      local ocf = o * at(c.X, c.Y, c.Z) * CFrame.Angles(0, ang, 0)
      local w, hh, y0, y1 = u1 - u0, op[4] - op[3], op[3], op[4]
      if op[5] == "window" and S then
        glass(b, w - 0.4, hh - 0.4, 0.3, ocf * at(0, (y0 + y1) / 2, 0), S.glass, "WindowGlass")
        box(b, w, 0.3, t + 0.4, ocf * at(0, y0 + 0.15, 0), S.trim, S.trimMat, "WindowSill")
        box(b, w, 0.3, t + 0.2, ocf * at(0, y1 - 0.15, 0), S.trim, S.trimMat, "WindowLintel")
        box(b, 0.3, hh, t + 0.2, ocf * at(-w / 2 + 0.15, (y0 + y1) / 2, 0), S.trim, S.trimMat, "WindowFrame")
        box(b, 0.3, hh, t + 0.2, ocf * at(w / 2 - 0.15, (y0 + y1) / 2, 0), S.trim, S.trimMat, "WindowFrame")
      elseif op[5] == "door" and S then
        box(b, 0.4, hh, t + 0.2, ocf * at(-w / 2 + 0.2, (y0 + y1) / 2, 0), S.trim, S.trimMat, "DoorFrame")
        box(b, 0.4, hh, t + 0.2, ocf * at(w / 2 - 0.2, (y0 + y1) / 2, 0), S.trim, S.trimMat, "DoorFrame")
        box(b, w, 0.4, t + 0.2, ocf * at(0, y1 - 0.2, 0), S.trim, S.trimMat, "DoorLintel")
        if op[6] ~= false then
          local door = box(b, w - 0.8, hh - 0.4, 0.35, ocf * at(0, (y0 + y1) / 2 - 0.2, 0), shade(S.wood, 0.8), M.Wood, "Door", { CanCollide = false })
          ball(b, 0.25, ocf * at(w / 2 - 1.3, (y0 + y1) / 2 - 0.2, -t / 2 - 0.1), S.accent, M.Metal, "DoorKnob", { CanCollide = false })
          door:SetAttribute("Opening", true)
        end
      end
    end
  end
  piece(u, L, 0, h)
end
local function windowsAlong(L, n, w, y0, y1, keepOut)
  local ops = {}
  if n <= 0 then return ops end
  local gap = L / n
  for i = 1, n do
    local c = gap * (i - 0.5)
    local skip = false
    if keepOut then for _, k in ipairs(keepOut) do if c + w / 2 > k[1] - 0.6 and c - w / 2 < k[2] + 0.6 then skip = true end end end
    if not skip and c - w / 2 > 0.8 and c + w / 2 < L - 0.8 then ops[#ops + 1] = { c - w / 2, c + w / 2, y0, y1, "window" } end
  end
  return ops
end
MK.wallRun = wallRun MK.windowsAlong = windowsAlong

-- roofs ----------------------------------------------------------------------------
-- ridge along X, eave at height y, footprint w x d, origin at centre
local function roofBuild(b, o, kind, w, d, y, S, pitch, overhang)
  local ov = overhang or 1.5
  local rise = math.max(2, (d / 2) * (pitch or 0.75))
  kind = kind or "gable"
  if kind == "none" then return 0 end
  if kind == "flat" then
    box(b, w + ov, 0.8, d + ov, o * at(0, y + 0.4, 0), S.roof, S.roofMat, "RoofSlab")
    box(b, w + ov, 1.4, 0.6, o * at(0, y + 1.5, -(d + ov) / 2 + 0.3), S.trim, S.trimMat, "Parapet")
    box(b, w + ov, 1.4, 0.6, o * at(0, y + 1.5, (d + ov) / 2 - 0.3), S.trim, S.trimMat, "Parapet")
    box(b, 0.6, 1.4, d + ov, o * at(-(w + ov) / 2 + 0.3, y + 1.5, 0), S.trim, S.trimMat, "Parapet")
    box(b, 0.6, 1.4, d + ov, o * at((w + ov) / 2 - 0.3, y + 1.5, 0), S.trim, S.trimMat, "Parapet")
    return 1.6
  end
  if kind == "shed" then
    wedge(b, w + ov, rise, d + ov, o * at(0, y + rise / 2, 0), S.roof, S.roofMat, "RoofSlope")
    box(b, w, rise - 0.2, 0.4, o * at(0, y + (rise - 0.2) / 2, d / 2 - 0.2), S.wall, S.wallMat, "RoofBackFill")
    return rise
  end
  local half = d / 2 + ov / 2
  local ridgeLen = w + ov
  if kind == "hip" then ridgeLen = math.max(2, w - d) end
  -- slope A covers z in [0, d/2] (ridge at z = 0 -> vertical face of the wedge must face -Z -> rotate 180)
  wedge(b, ridgeLen, rise, half, o * at(0, y + rise / 2, half / 2) * CFrame.Angles(0, PI, 0), S.roof, S.roofMat, "RoofSlopeA")
  wedge(b, ridgeLen, rise, half, o * at(0, y + rise / 2, -half / 2), S.roof, S.roofMat, "RoofSlopeB")
  box(b, ridgeLen, 0.5, 1, o * at(0, y + rise + 0.1, 0), S.trim, S.trimMat, "RidgeBeam")
  if kind == "gable" then
    wedge(b, 0.8, rise - 0.1, d / 2, o * at(-w / 2 + 0.4, y + (rise - 0.1) / 2, d / 4) * CFrame.Angles(0, PI, 0), S.wall, S.wallMat, "GableEnd")
    wedge(b, 0.8, rise - 0.1, d / 2, o * at(-w / 2 + 0.4, y + (rise - 0.1) / 2, -d / 4), S.wall, S.wallMat, "GableEnd")
    wedge(b, 0.8, rise - 0.1, d / 2, o * at(w / 2 - 0.4, y + (rise - 0.1) / 2, d / 4) * CFrame.Angles(0, PI, 0), S.wall, S.wallMat, "GableEnd")
    wedge(b, 0.8, rise - 0.1, d / 2, o * at(w / 2 - 0.4, y + (rise - 0.1) / 2, -d / 4), S.wall, S.wallMat, "GableEnd")
  else
    -- hip ends: four corner wedges, peak at the ridge end (CornerWedgePart peak sits above its +X/+Z corner)
    local ex = ridgeLen / 2
    for _, sx in ipairs({ -1, 1 }) do
      for _, sz in ipairs({ -1, 1 }) do
        local cx, cz = sx * (ex + half / 2), sz * (half / 2)
        local ang = 0
        if sx == 1 and sz == 1 then ang = PI elseif sx == 1 and sz == -1 then ang = PI / 2 elseif sx == -1 and sz == 1 then ang = -PI / 2 end
        cwedge(b, half, rise, half, o * at(cx, y + rise / 2, cz) * CFrame.Angles(0, ang, 0), S.roof, S.roofMat, "RoofHip")
      end
    end
  end
  return rise
end
MK.roofBuild = roofBuild

-- structure kinds ----------------------------------------------------------------
local K = {}
local function footprint(a, dw, dd, dh)
  local s = a.size
  if type(s) == "table" then return num(s[1], dw, 4, 512), num(s[3] or s[2], dd, 4, 512), num(s[2], dh, 2, 400) end
  return num(a.width, dw, 4, 512), num(a.depth, dd, 4, 512), num(a.height, dh, 2, 400)
end

function K.house(b, a, o, S)
  local w, d = footprint(a, 24, 20, 12)
  local floors = math.floor(num(a.floors, 1, 1, 8))
  local fh = num(a.floor_height, 12, 8, 20)
  local t = 1
  local winW, winN = 4, math.floor(num(a.windows, math.max(1, math.floor(w / 8)), 0, 12))
  local winNd = math.floor(num(a.windows, math.max(1, math.floor(d / 8)), 0, 12))
  box(b, w + 1, 1, d + 1, o * at(0, 0.5, 0), S.stone, S.floorMat, "Foundation")
  local doorW, doorH = num(a.door_width, 5, 3, 12), num(a.door_height, 8, 6, 16)
  for f = 1, floors do
    local y0 = 1 + (f - 1) * fh
    local fo = o * at(0, y0, 0)
    local hx = w / 2 - t / 2 local hz = d / 2 - t / 2
    local front, back, left, right = {}, {}, {}, {}
    local doorU0 = w / 2 - doorW / 2
    if f == 1 and a.door ~= false then front[#front + 1] = { doorU0, doorU0 + doorW, 0, doorH, "door" } end
    for _, op in ipairs(windowsAlong(w, winN, winW, 3.5, 3.5 + 5, f == 1 and a.door ~= false and { { doorU0, doorU0 + doorW } } or nil)) do front[#front + 1] = op end
    for _, op in ipairs(windowsAlong(w, winN, winW, 3.5, 8.5)) do back[#back + 1] = op end
    for _, op in ipairs(windowsAlong(d, winNd, winW, 3.5, 8.5)) do left[#left + 1] = op right[#right + 1] = op end
    -- front wall runs -x -> +x at z = -hz (so its outward face is -Z), back +x -> -x at +hz, sides likewise
    wallRun(b, fo, Vector3.new(-hx, 0, -hz), Vector3.new(hx, 0, -hz), fh, t, front, S.wall, S.wallMat, "WallFront", S)
    wallRun(b, fo, Vector3.new(hx, 0, hz), Vector3.new(-hx, 0, hz), fh, t, back, S.wall, S.wallMat, "WallBack", S)
    wallRun(b, fo, Vector3.new(-hx, 0, hz), Vector3.new(-hx, 0, -hz), fh, t, left, S.wall, S.wallMat, "WallLeft", S)
    wallRun(b, fo, Vector3.new(hx, 0, -hz), Vector3.new(hx, 0, hz), fh, t, right, S.wall, S.wallMat, "WallRight", S)
    -- corner posts + storey trim
    for _, sx in ipairs({ -1, 1 }) do for _, sz in ipairs({ -1, 1 }) do box(b, t + 0.4, fh, t + 0.4, fo * at(sx * hx, fh / 2, sz * hz), S.trim, S.trimMat, "CornerPost") end end
    if f > 1 then
      box(b, w + 0.6, 0.5, d + 0.6, fo * at(0, 0.25, 0), S.trim, S.trimMat, "StoreyTrim")
      -- interior floor slab with a stair hole
      local holeW, holeD = 4.5, 9
      box(b, w - 2 * t, 0.6, d - 2 * t - holeD, fo * at(0, 0.3, holeD / 2), S.floor, S.floorMat, "Floor")
      box(b, w - 2 * t - holeW, 0.6, holeD, fo * at(-holeW / 2, 0.3, -(d - 2 * t) / 2 + holeD / 2), S.floor, S.floorMat, "Floor")
    end
    if a.interior ~= false and f < floors then
      -- straight interior staircase up to the next floor along the right front wall
      local steps = math.floor(fh / 1) local run = 9 / steps
      for i = 1, steps do
        box(b, 4, i * (fh / steps), run, fo * at(w / 2 - t - 2.2, i * (fh / steps) / 2, -(d - 2 * t) / 2 + (i - 0.5) * run), S.wood, M.Wood, "Step")
      end
    end
    if a.lights ~= false then
      local lamp = box(b, 1.2, 0.3, 1.2, fo * at(0, fh - 0.3, 0), C(255, 240, 200), M.Neon, "CeilingLamp", { CanCollide = false })
      light(lamp, "PointLight", C(255, 225, 170), 1.2, math.max(w, d))
    end
  end
  local roofY = 1 + floors * fh
  local rise = roofBuild(b, o, key(a.roof, "gable"), w, d, roofY, S, num(a.roof_pitch, 0.75, 0.2, 2), 1.5)
  if a.chimney ~= false and key(a.roof, "gable") ~= "flat" then
    box(b, 2.2, rise + 3, 2.2, o * at(w / 4, roofY + (rise + 3) / 2 - 0.5, -d / 6), shade(S.wall, 0.75), M.Brick, "Chimney")
  end
  if a.porch then
    box(b, doorW + 4, 0.5, 5, o * at(0, 0.75, -d / 2 - 2.5), S.wood, M.WoodPlanks, "Porch")
    for _, sx in ipairs({ -1, 1 }) do box(b, 0.6, 9, 0.6, o * at(sx * (doorW / 2 + 1.5), 5.5, -d / 2 - 4.5), S.trim, S.trimMat, "PorchPost") end
    wedge(b, doorW + 5, 2.5, 5.5, o * at(0, 10 + 1.25, -d / 2 - 2.75), S.roof, S.roofMat, "PorchRoof")
  end
  return { width = w, depth = d, floors = floors, height = roofY + rise, door = a.door ~= false and { 0, 0, -d / 2 } or nil }
end

function K.barn(b, a, o, S)
  local w, d = footprint(a, 28, 36, 14)
  local h = num(a.height, 14, 8, 30)
  if a.color == nil then S.wall = C(150, 40, 35) S.wallMat = M.WoodPlanks end
  if a.trim_color == nil then S.trim = C(235, 230, 220) S.trimMat = M.Wood end
  local t = 1 local hx, hz = w / 2 - t / 2, d / 2 - t / 2
  box(b, w + 1, 1, d + 1, o * at(0, 0.5, 0), S.stone, M.Concrete, "Foundation")
  local fo = o * at(0, 1, 0)
  local doorW, doorH = math.min(w * 0.45, 12), math.min(h - 2, 11)
  local du0 = w / 2 - doorW / 2
  wallRun(b, fo, Vector3.new(-hx, 0, -hz), Vector3.new(hx, 0, -hz), h, t, { { du0, du0 + doorW, 0, doorH, "door", false } }, S.wall, S.wallMat, "WallFront", S)
  wallRun(b, fo, Vector3.new(hx, 0, hz), Vector3.new(-hx, 0, hz), h, t, windowsAlong(w, 2, 3, 4, 7), S.wall, S.wallMat, "WallBack", S)
  wallRun(b, fo, Vector3.new(-hx, 0, hz), Vector3.new(-hx, 0, -hz), h, t, windowsAlong(d, 3, 3, 4, 7), S.wall, S.wallMat, "WallLeft", S)
  wallRun(b, fo, Vector3.new(hx, 0, -hz), Vector3.new(hx, 0, hz), h, t, windowsAlong(d, 3, 3, 4, 7), S.wall, S.wallMat, "WallRight", S)
  -- sliding double doors (parked open at the sides)
  for _, sx in ipairs({ -1, 1 }) do
    box(b, doorW / 2 + 0.5, doorH - 0.2, 0.4, fo * at(sx * (doorW / 2 + doorW / 4 + 0.4), doorH / 2, -d / 2 - 0.5), shade(S.wall, 0.8), M.WoodPlanks, "BarnDoor")
    box(b, doorW / 2 + 0.5, 0.4, 0.5, fo * at(sx * (doorW / 2 + doorW / 4 + 0.4), doorH * 0.5, -d / 2 - 0.55), S.trim, S.trimMat, "DoorCross")
  end
  box(b, doorW * 2 + 2, 0.5, 0.6, fo * at(0, doorH + 0.5, -d / 2 - 0.6), S.trim, M.Metal, "DoorRail")
  -- hay loft + ladder
  box(b, w - 2 * t, 0.6, d * 0.45, fo * at(0, h * 0.6, d * 0.275 - t), S.wood, M.WoodPlanks, "Loft")
  for i = 1, math.floor(h * 0.6 / 1.5) do box(b, 2.4, 0.3, 0.3, fo * at(-w / 4, i * 1.5, d * 0.05 - t), S.wood, M.Wood, "LadderRung") end
  -- gambrel roof: steep lower wedges + shallow upper gable
  local lowRise, upRise = h * 0.5, h * 0.35
  local qd = d / 4
  local eave = 1 + h
  wedge(b, w + 2, lowRise, qd + 1, o * at(0, eave + lowRise / 2, d / 2 - qd / 2 + 0.5) * CFrame.Angles(0, PI, 0), S.roof, S.roofMat, "RoofLowerA")
  wedge(b, w + 2, lowRise, qd + 1, o * at(0, eave + lowRise / 2, -(d / 2 - qd / 2 + 0.5)), S.roof, S.roofMat, "RoofLowerB")
  box(b, w - 1, lowRise, d / 2, o * at(0, eave + lowRise / 2, 0), S.wall, S.wallMat, "UpperWall")
  wedge(b, w + 2, upRise, qd + 1, o * at(0, eave + lowRise + upRise / 2, qd / 2 + 0.5) * CFrame.Angles(0, PI, 0), S.roof, S.roofMat, "RoofUpperA")
  wedge(b, w + 2, upRise, qd + 1, o * at(0, eave + lowRise + upRise / 2, -(qd / 2 + 0.5)), S.roof, S.roofMat, "RoofUpperB")
  box(b, w + 2, 0.5, 1, o * at(0, eave + lowRise + upRise + 0.1, 0), S.trim, S.trimMat, "RidgeBeam")
  for _, sx in ipairs({ -1, 1 }) do
    wedge(b, 0.8, upRise - 0.1, qd, o * at(sx * (w / 2 - 0.4), eave + lowRise + (upRise - 0.1) / 2, qd / 2) * CFrame.Angles(0, PI, 0), S.wall, S.wallMat, "GableEnd")
    wedge(b, 0.8, upRise - 0.1, qd, o * at(sx * (w / 2 - 0.4), eave + lowRise + (upRise - 0.1) / 2, -qd / 2), S.wall, S.wallMat, "GableEnd")
  end
  if a.lights ~= false then local lamp = box(b, 1.5, 0.3, 1.5, fo * at(0, h - 0.5, -d / 6), C(255, 240, 200), M.Neon, "Lamp", { CanCollide = false }) light(lamp, "PointLight", C(255, 220, 160), 1.3, math.max(w, d)) end
  return { width = w, depth = d, height = eave + lowRise + upRise, door_width = doorW }
end

function K.tower(b, a, o, S)
  local r = num(a.radius, 6, 2.5, 40)
  local h = num(a.height, 36, 8, 300)
  local sides = math.floor(num(a.sides, 0, 0, 16))
  local body
  if sides >= 4 then
    body = box(b, r * 2, h, r * 2, o * at(0, h / 2, 0), S.wall, S.wallMat, "TowerBody")
  else
    body = cylY(b, r, h, o * at(0, h / 2, 0), S.wall, S.wallMat, "TowerBody")
  end
  cylY(b, r + 0.8, 2, o * at(0, 1, 0), S.stone, S.floorMat, "Base")
  cylY(b, r + 1.2, 1, o * at(0, h + 0.5, 0), S.stone, S.floorMat, "Ledge")
  local n = math.max(6, math.floor((r + 1.2) * TAU / 3.2))
  if a.battlements ~= false then
    for i = 0, n - 1 do
      local ang = i / n * TAU
      local rr = r + 0.8
      local cf = o * CFrame.Angles(0, ang, 0) * at(rr, h + 1 + 1.25, 0)
      box(b, 1.2, 2.5, 2.2, cf, S.wall, S.wallMat, "Merlon")
    end
    cylY(b, r + 0.6, 2, o * at(0, h + 2, 0), S.stone, S.floorMat, "Walkway", { Transparency = 1, CanCollide = false })
  end
  if a.door ~= false then
    box(b, 4, 7, 0.6, o * at(0, 3.5 + 1, -r + 0.1), shade(S.wood, 0.75), M.Wood, "Door", { CanCollide = false })
    box(b, 5, 7.6, 0.4, o * at(0, 3.8 + 1, -r + 0.3), S.trim, S.trimMat, "DoorFrame")
  end
  local levels = math.floor(h / 10)
  for lv = 1, levels do
    for i = 0, 3 do
      local ang = i / 4 * TAU + PI / 4
      box(b, 1.2, 3, 0.4, o * CFrame.Angles(0, ang, 0) * at(0, lv * 10 - 2, -r + 0.1), C(30, 30, 36), M.SmoothPlastic, "WindowSlit", { CanCollide = false })
    end
  end
  local top = h + 2
  local roofK = key(a.roof, (key(a.style, "") == "fantasy") and "cone" or "none")
  if roofK == "cone" or roofK == "spire" then
    local tiers = 5 local ch = num(a.roof_height, r * 1.6, 2, 80)
    for i = 1, tiers do
      local rr = (r + 1.2) * (1 - (i - 1) / tiers)
      cylY(b, rr, ch / tiers + 0.1, o * at(0, top + (i - 0.5) * ch / tiers, 0), S.roof, S.roofMat, "ConeTier")
    end
    top = top + ch
  end
  if a.flag then
    cylY(b, 0.2, 7, o * at(0, top + 3.5, 0), S.accent, M.Metal, "FlagPole")
    box(b, 4, 2.5, 0.2, o * at(2.1, top + 5.5, 0), rgb(a.flag, S.roof), M.Fabric, "Flag", { CanCollide = false })
  end
  if a.lights ~= false then light(body, "PointLight", C(255, 200, 140), 1, r * 3) end
  return { radius = r, height = top, merlons = a.battlements ~= false and n or 0 }
end

function K.castle_wall(b, a, o, S)
  local L = num(a.length or (type(a.size) == "table" and a.size[1]), 48, 8, 512)
  local h = num(a.height or (type(a.size) == "table" and a.size[2]), 16, 6, 80)
  local t = num(a.thickness or (type(a.size) == "table" and a.size[3]), 4, 2, 20)
  box(b, L, h, t, o * at(0, h / 2, 0), S.wall, S.wallMat, "WallBody")
  box(b, L, 1, t + 0.6, o * at(0, 0.5, 0), S.stone, S.floorMat, "WallFooting")
  box(b, L, 0.5, t + 1, o * at(0, h + 0.25, 0), S.stone, S.floorMat, "Walkway")
  local n = math.floor(L / 4)
  for _, sz in ipairs({ -1, 1 }) do
    if sz == -1 or a.both_sides ~= false then
      box(b, L, 1.5, 0.8, o * at(0, h + 0.5 + 0.75, sz * (t / 2 + 0.1)), S.wall, S.wallMat, "ParapetBase")
      for i = 0, n - 1 do
        local x = -L / 2 + 2 + i * 4
        box(b, 2, 2.5, 0.8, o * at(x, h + 2 + 1.25, sz * (t / 2 + 0.1)), S.wall, S.wallMat, "Merlon")
      end
    end
  end
  if a.towers then
    for _, sx in ipairs({ -1, 1 }) do
      local ta = { radius = t / 2 + 3, height = h + 8, style = a.style, color = a.color, roof = a.roof, battlements = true, door = false, lights = false }
      K.tower(b, ta, o * at(sx * (L / 2 + 1), 0, 0), S)
    end
  end
  if a.stairs ~= false then
    local steps = math.floor(h / 1) local run = 1.4
    for i = 1, steps do box(b, run, 1, 3.5, o * at(-L / 2 + 2 + (i - 0.5) * run, i - 0.5, t / 2 + 1.75 + 0.4), S.stone, S.floorMat, "Step") end
  end
  return { length = L, height = h, thickness = t, merlons = n * (a.both_sides ~= false and 2 or 1) }
end

local function archBuild(b, o, W, H, t, pw, S, segs, fill)
  -- opening width W, total height H, wall thickness t, pillar width pw. Semi-circular arch of segs blocks.
  local R = W / 2
  local springY = H - R
  if springY < 1 then springY = 1 end
  for _, sx in ipairs({ -1, 1 }) do
    box(b, pw, springY, t, o * at(sx * (R + pw / 2), springY / 2, 0), S.stone, S.wallMat, "Pillar")
    box(b, pw + 0.6, 0.8, t + 0.4, o * at(sx * (R + pw / 2), springY - 0.4, 0), S.trim, S.trimMat, "Impost")
    box(b, pw + 0.6, 1, t + 0.4, o * at(sx * (R + pw / 2), 0.5, 0), S.trim, S.trimMat, "Plinth")
  end
  segs = math.max(5, math.floor(segs or 9))
  local rc = R + pw / 2
  local seg = (PI * rc) / segs
  for i = 0, segs - 1 do
    local ang = PI * (i + 0.5) / segs
    local cf = o * at(0, springY, 0) * CFrame.Angles(0, 0, ang) * at(rc, 0, 0)
    box(b, pw, seg * 1.1, t, cf, S.stone, S.wallMat, "ArchStone")
  end
  box(b, pw + 0.4, pw + 1, t + 0.3, o * at(0, springY + rc, 0), S.trim, S.trimMat, "Keystone")
  if fill then
    local topY = springY + R + pw + 0.5
    local fillH = (fill - topY)
    if fillH > 0.2 then box(b, W + 2 * pw, fillH, t, o * at(0, topY + fillH / 2, 0), S.wall, S.wallMat, "Spandrel") end
    for _, sx in ipairs({ -1, 1 }) do
      box(b, pw + 0.01, R + pw, t - 0.02, o * at(sx * (R / 2 + pw / 2 + 0.01), springY + (R + pw) / 2, 0), S.wall, S.wallMat, "SpandrelSide")
    end
  end
  return springY + rc + pw / 2
end
MK.archBuild = archBuild

function K.archway(b, a, o, S)
  local W = num(a.width, 10, 3, 80)
  local H = num(a.height, 12, 4, 100)
  local t = num(a.thickness, 3, 1, 30)
  local top = archBuild(b, o, W, H, t, num(a.pillar_width, 2, 0.8, 10), S, num(a.segments, 9, 5, 32), a.fill and (H + num(a.pillar_width, 2) + 3) or nil)
  if a.torches then
    for _, sx in ipairs({ -1, 1 }) do
      local tp = cylY(b, 0.25, 2, o * at(sx * (W / 2 + 1), H * 0.6, -t / 2 - 0.4) * CFrame.Angles(math.rad(-20), 0, 0), S.wood, M.Wood, "Torch")
      local flame = ball(b, 0.5, o * at(sx * (W / 2 + 1), H * 0.6 + 1.3, -t / 2 - 0.8), C(255, 150, 40), M.Neon, "Flame", { CanCollide = false })
      light(flame, "PointLight", C(255, 160, 60), 1.5, 14) pcall(function() local f = Instance.new("Fire") f.Size = 3 f.Heat = 6 f.Parent = flame end)
    end
  end
  return { width = W, height = H, top = top }
end

function K.gatehouse(b, a, o, S)
  local W = num(a.width, 12, 6, 40)
  local H = num(a.height, 14, 8, 60)
  local t = num(a.thickness, 6, 3, 30)
  local r = num(a.radius, 5, 3, 20)
  archBuild(b, o, W, H, t, 2, S, 11, H + 6)
  box(b, W + 4, 0.5, t + 1, o * at(0, H + 6 + 0.25, 0), S.stone, S.floorMat, "Walkway")
  for i = 0, math.floor((W + 4) / 4) - 1 do box(b, 2, 2.5, 0.8, o * at(-(W + 4) / 2 + 2 + i * 4, H + 6 + 1.75, -t / 2), S.wall, S.wallMat, "Merlon") end
  for _, sx in ipairs({ -1, 1 }) do
    K.tower(b, { radius = r, height = H + 12, roof = a.roof, battlements = true, door = false, lights = false, flag = a.flag }, o * at(sx * (W / 2 + 2 + r - 0.5), 0, 0), S)
  end
  if a.portcullis ~= false then
    local pc = Instance.new("Model") pc.Name = "Portcullis" pc.Parent = b.m
    local pb = newB(pc, b.R, S) pb.n = b.n
    for i = 0, math.floor(W / 1.5) do box(pb, 0.4, H - 2, 0.4, o * at(-W / 2 + 0.75 + i * 1.5, (H - 2) / 2 + 1, 0), S.accent, M.Metal, "Bar") end
    for j = 1, math.floor((H - 2) / 3) do box(pb, W - 0.4, 0.4, 0.4, o * at(0, 1 + j * 3, 0), S.accent, M.Metal, "CrossBar") end
    b.n = pb.n
  end
  return { width = W, height = H, towers = 2 }
end

function K.staircase(b, a, o, S)
  local h = num(a.height, 12, 1, 200)
  local w = num(a.width, 6, 1, 60)
  local riser = num(a.step_height, 1, 0.25, 2)
  local steps = math.max(1, math.floor(num(a.steps, h / riser, 1, 400)))
  riser = h / steps
  local run = num(a.step_depth, (a.length and num(a.length, 0) > 0) and num(a.length, 0) / steps or math.max(1, riser * 1.6), 0.4, 10)
  local solid = a.solid ~= false
  local col = rgb(a.color, S.stone) local mat = matOf(a.material, S.floorMat)
  for i = 1, steps do
    local y = i * riser
    local sh = solid and y or math.min(riser, 1)
    box(b, w, sh, run, o * at(0, y - sh / 2, -(i - 0.5) * run), col, mat, "Step")
  end
  if a.rails ~= false then
    local L = steps * run
    for _, sx in ipairs({ -1, 1 }) do
      local rcf, rlen = segCF(Vector3.new(sx * (w / 2 + 0.3), 3, 0), Vector3.new(sx * (w / 2 + 0.3), h + 3, -L))
      cylX(b, 0.18, rlen, o * rcf, S.trim, S.trimMat, "Rail")
      for i = 0, steps, math.max(1, math.floor(steps / 6)) do
        local yy = i * riser local zz = -(i) * run
        box(b, 0.3, 3, 0.3, o * at(sx * (w / 2 + 0.3), yy + 1.5, zz), S.trim, S.trimMat, "Baluster")
      end
    end
  end
  return { steps = steps, step_height = riser, step_depth = run, length = steps * run, height = h }
end

function K.spiral_staircase(b, a, o, S)
  local h = num(a.height, 24, 2, 300)
  local r = num(a.radius, 5, 2, 40)
  local turns = num(a.turns, 1.5, 0.25, 10)
  local per = math.floor(num(a.steps_per_turn, 14, 6, 40))
  local steps = math.max(2, math.floor(turns * per))
  local riser = h / steps
  local ang = TAU * turns / steps
  local clockwise = a.clockwise ~= false and 1 or -1
  local col = rgb(a.color, S.stone) local mat = matOf(a.material, S.floorMat)
  cylY(b, math.max(0.6, r * 0.18), h + 2, o * at(0, (h + 2) / 2, 0), S.stone, S.wallMat, "Column")
  local treadW = r - r * 0.18
  for i = 1, steps do
    local t_ = (i - 1) * ang * clockwise
    local cf = o * CFrame.Angles(0, t_, 0) * at(r * 0.18 + treadW / 2, i * riser - 0.25, 0)
    box(b, treadW, 0.5, math.max(1, (r * TAU / per) * 1.15), cf, col, mat, "Step")
    if a.rails ~= false then
      box(b, 0.25, 3.2, 0.25, o * CFrame.Angles(0, t_, 0) * at(r - 0.2, i * riser + 1.6, 0), S.trim, S.trimMat, "Baluster")
      local p0 = (CFrame.Angles(0, t_, 0) * at(r - 0.2, i * riser + 3.2, 0)).Position
      local p1 = (CFrame.Angles(0, t_ + ang * clockwise, 0) * at(r - 0.2, (i + 1) * riser + 3.2, 0)).Position
      local rcf, rlen = segCF(p0, p1)
      cylX(b, 0.15, rlen + 0.2, o * rcf, S.trim, S.trimMat, "Rail")
    end
  end
  return { steps = steps, step_height = riser, height = h, radius = r, turns = turns }
end

function K.fence(b, a, o, S)
  local pts = {}
  if type(a.points) == "table" and #a.points >= 2 then
    for _, p in ipairs(a.points) do pts[#pts + 1] = Vector3.new(num(p[1], 0), num(p[2] and p[3] and p[2] or 0), num(p[3] or p[2], 0)) end
  else
    local L = num(a.length, 32, 2, 1024)
    pts = { Vector3.new(-L / 2, 0, 0), Vector3.new(L / 2, 0, 0) }
  end
  local sty = key(a.style, "medieval")
  local kind = key(a.fence_style or a.kind2, (sty == "modern" or sty == "industrial" or sty == "scifi") and "metal" or (sty == "stone" and "stone" or "wood"))
  local h = num(a.height, 4, 1, 20)
  local spacing = num(a.spacing, 6, 1, 24)
  local posts, rails = 0, 0
  local col = rgb(a.color, kind == "metal" and S.accent or (kind == "stone" and S.stone or S.wood))
  local mat = matOf(a.material, kind == "metal" and M.Metal or (kind == "stone" and S.wallMat or M.Wood))
  for i = 1, #pts - 1 do
    local p0, p1 = pts[i], pts[i + 1]
    local dv = p1 - p0 local L = dv.Magnitude
    if L > 0.1 then
      local dir = dv / L local ang = math.atan2(-dir.Z, dir.X)
      local n = math.max(1, math.floor(L / spacing + 0.5))
      local gap = L / n
      if kind == "stone" then
        box(b, L, h, 1.2, o * at(p0.X + dir.X * L / 2, p0.Y + h / 2, p0.Z + dir.Z * L / 2) * CFrame.Angles(0, ang, 0), col, mat, "StoneWall")
        box(b, L + 0.4, 0.5, 1.6, o * at(p0.X + dir.X * L / 2, p0.Y + h + 0.25, p0.Z + dir.Z * L / 2) * CFrame.Angles(0, ang, 0), shade(col, 0.85), mat, "Coping")
        rails = rails + 2
      else
        for j = 0, n do
          if j < n or i == #pts - 1 then
            local c = p0 + dir * (gap * j)
            if kind == "metal" then cylY(b, 0.18, h + 0.4, o * at(c.X, c.Y + (h + 0.4) / 2, c.Z), col, mat, "Post") ball(b, 0.3, o * at(c.X, c.Y + h + 0.5, c.Z), col, mat, "PostCap")
            else box(b, 0.7, h + 0.4, 0.7, o * at(c.X, c.Y + (h + 0.4) / 2, c.Z), shade(col, 0.9), mat, "Post") end
            posts = posts + 1
          end
        end
        local mid = p0 + dir * (L / 2)
        local railN = kind == "metal" and 2 or (kind == "picket" and 2 or 2)
        for k = 1, railN do
          local y = h * (k / (railN + 1)) + (kind == "picket" and 0.6 or 0)
          if kind == "metal" then cylX(b, 0.12, L, o * at(mid.X, mid.Y + y, mid.Z) * CFrame.Angles(0, ang, 0), col, mat, "Rail")
          else box(b, L, 0.5, 0.3, o * at(mid.X, mid.Y + y, mid.Z) * CFrame.Angles(0, ang, 0), col, mat, "Rail") end
          rails = rails + 1
        end
        if kind == "picket" then
          local m = math.floor(L / 1.1)
          for j = 0, m - 1 do local c = p0 + dir * (0.55 + j * 1.1) box(b, 0.6, h, 0.25, o * at(c.X, c.Y + h / 2, c.Z) * CFrame.Angles(0, ang, 0), col, mat, "Picket") end
        elseif kind == "metal" then
          local m = math.floor(L / 1.2)
          for j = 1, m - 1 do local c = p0 + dir * (j * 1.2) cylY(b, 0.07, h - 0.3, o * at(c.X, c.Y + (h - 0.3) / 2, c.Z), col, mat, "Bar") end
        end
      end
    end
  end
  return { segments = #pts - 1, posts = posts, rails = rails, fence_style = kind, height = h }
end
`;

  // The LIB string is continued in LIB2 (kept in two template literals so the file stays editable).
  const LIB2 = String.raw`
function K.gate(b, a, o, S)
  local W = num(a.width, 8, 2, 40)
  local h = num(a.height, 5, 1.5, 30)
  local dbl = a.double ~= false and W > 5
  local col = rgb(a.color, S.wood) local mat = matOf(a.material, M.Wood)
  local posts = {}
  for _, sx in ipairs({ -1, 1 }) do posts[#posts + 1] = box(b, 1, h + 1.5, 1, o * at(sx * (W / 2 + 0.5), (h + 1.5) / 2, 0), S.stone, S.wallMat, "GatePost") ball(b, 0.6, o * at(sx * (W / 2 + 0.5), h + 1.9, 0), S.trim, S.trimMat, "PostCap") end
  local leaves = {}
  local function leaf(x0, width, hingeSide)
    local m = Instance.new("Model") m.Name = "GateLeaf" m.Parent = b.m
    local lb = newB(m, b.R, S) lb.n = b.n
    local cx = x0 + width / 2 * hingeSide
    local frame = box(lb, width, 0.5, 0.4, o * at(cx, h - 0.25 + 0.3, 0), col, mat, "TopRail")
    box(lb, width, 0.5, 0.4, o * at(cx, 0.55, 0), col, mat, "BottomRail")
    local n = math.floor(width / 1.2)
    for i = 0, n do box(lb, 0.5, h - 0.2, 0.25, o * at(x0 + hingeSide * (0.3 + i * (width - 0.6) / math.max(1, n)), (h - 0.2) / 2 + 0.3, 0), col, mat, "Slat") end
    box(lb, math.sqrt(width * width + (h - 1) * (h - 1)), 0.3, 0.2, o * at(cx, h / 2 + 0.3, 0.25) * CFrame.Angles(0, 0, math.atan2(h - 1, width) * hingeSide), shade(col, 0.8), mat, "Brace")
    m.PrimaryPart = frame
    b.n = lb.n
    leaves[#leaves + 1] = { model = m, root = frame, x0 = x0 }
    return m
  end
  if dbl then leaf(-W / 2, W / 2 - 0.1, 1) leaf(W / 2, W / 2 - 0.1, -1) else leaf(-W / 2, W - 0.1, 1) end
  if a.hinged then
    for i, lf in ipairs(leaves) do
      local post = posts[i == 1 and 1 or 2]
      local hx = lf.x0
      for _, p in ipairs(lf.model:GetDescendants()) do if p:IsA("BasePart") then p.Anchored = false if p ~= lf.root then weld(lf.root, p) end end end
      local worldHinge = b.R * o * at(hx, h / 2, 0)
      hinge(post, lf.root, post.CFrame:ToObjectSpace(worldHinge) * CFrame.Angles(0, 0, PI / 2), lf.root.CFrame:ToObjectSpace(worldHinge) * CFrame.Angles(0, 0, PI / 2), "GateHinge", { LimitsEnabled = true, LowerAngle = -100, UpperAngle = 100, Restitution = 0 })
    end
  end
  return { width = W, height = h, leaves = #leaves, hinged = a.hinged == true }
end

function K.roof(b, a, o, S)
  local w, d, h = footprint(a, 24, 20, 0)
  local kind = key(a.roof or a.roof_kind, "gable")
  local rise = roofBuild(b, o, kind, w, d, 0, S, num(a.roof_pitch, 0.75, 0.2, 2), num(a.overhang, 1.5, 0, 8))
  return { width = w, depth = d, roof = kind, rise = rise }
end

function K.bridge(b, a, o, S)
  local L = num(a.length, 40, 6, 400)
  local w = num(a.width, 8, 2, 40)
  local sty = key(a.style, "medieval")
  local kind = key(a.bridge_style or a.kind2, (sty == "modern" or sty == "industrial" or sty == "scifi") and "suspension" or ((sty == "rustic") and "rope" or "stone"))
  local deckCol = rgb(a.color, kind == "stone" and S.stone or S.wood)
  local deckMat = matOf(a.material, kind == "stone" and S.floorMat or M.WoodPlanks)
  local cnt = { planks = 0, arches = 0, cables = 0 }
  -- deck runs along X from -L/2 to L/2, deck top at y = 0
  if kind == "rope" then
    local n = math.max(4, math.floor(L / 1.6))
    local sag = num(a.sag, math.min(L * 0.08, 6), 0, 40)
    local pl = L / n
    for i = 1, n do
      local u0 = (i - 1) / n local u1 = i / n
      local y0 = -sag * (1 - (2 * u0 - 1) ^ 2) local y1 = -sag * (1 - (2 * u1 - 1) ^ 2)
      local x = -L / 2 + (i - 0.5) * pl
      local ang = math.atan2(y1 - y0, pl)
      box(b, pl * 1.08, 0.35, w, o * at(x, (y0 + y1) / 2 - 0.2, 0) * CFrame.Angles(0, 0, ang), shade(deckCol, 0.9 + 0.2 * ((i % 3) / 3)), deckMat, "Plank")
      cnt.planks = cnt.planks + 1
      for _, sz in ipairs({ -1, 1 }) do
        local ry0, ry1 = y0 + 3.2, y1 + 3.2
        cylX(b, 0.12, math.sqrt(pl * pl + (y1 - y0) ^ 2) + 0.2, o * at(x, (ry0 + ry1) / 2, sz * (w / 2 + 0.1)) * CFrame.Angles(0, 0, ang), C(150, 120, 80), M.Fabric, "RopeRail")
        if i % 4 == 0 then box(b, 0.3, 3.4, 0.3, o * at(x, (y0 + y1) / 2 + 1.5, sz * (w / 2 + 0.1)), S.wood, M.Wood, "RopePost") end
      end
    end
    for _, sx in ipairs({ -1, 1 }) do for _, sz in ipairs({ -1, 1 }) do box(b, 0.8, 5, 0.8, o * at(sx * (L / 2 - 0.4), 2.2, sz * (w / 2 + 0.1)), S.wood, M.Wood, "EndPost") end end
  elseif kind == "stone" then
    box(b, L, 1.2, w, o * at(0, -0.6, 0), deckCol, deckMat, "Deck")
    local arches = math.max(1, math.floor(num(a.arches, L / 16, 1, 20)))
    local span = L / arches
    local H = num(a.height, span * 0.6, 3, 200)
    cnt.arches = arches
    for i = 1, arches do
      local cx = -L / 2 + (i - 0.5) * span
      archBuild(b, o * at(cx, -H - 1.2, 0), span - 3, H, w, 1.5, S, 9, nil)
    end
    for _, sz in ipairs({ -1, 1 }) do
      box(b, L, 1.6, 0.6, o * at(0, 0.8, sz * (w / 2 - 0.3)), S.wall, S.wallMat, "Parapet")
      for i = 0, math.floor(L / 6) do box(b, 1, 2.4, 1, o * at(-L / 2 + 0.5 + i * ((L - 1) / math.max(1, math.floor(L / 6))), 1.2, sz * (w / 2 - 0.3)), S.trim, S.trimMat, "ParapetPost") end
    end
  else
    -- suspension: deck + two pylons + main cables (parabola) + hangers
    box(b, L, 1, w, o * at(0, -0.5, 0), deckCol, a.material and deckMat or M.Concrete, "Deck")
    for _, sz in ipairs({ -1, 1 }) do
      box(b, L, 0.4, 0.4, o * at(0, 1.2, sz * (w / 2 - 0.2)), S.trim, M.Metal, "Guardrail")
      for i = 0, math.floor(L / 4) do box(b, 0.2, 1.2, 0.2, o * at(-L / 2 + 0.3 + i * ((L - 0.6) / math.max(1, math.floor(L / 4))), 0.6, sz * (w / 2 - 0.2)), S.trim, M.Metal, "RailPost") end
    end
    local H = num(a.height, math.max(10, L * 0.22), 6, 300)
    local px = L * 0.3
    for _, sx in ipairs({ -1, 1 }) do
      for _, sz in ipairs({ -1, 1 }) do box(b, 1.6, H + 6, 1.6, o * at(sx * px, (H + 6) / 2 - 6, sz * (w / 2 + 0.6)), S.accent, M.Metal, "Pylon") end
      box(b, 2, 1.2, w + 2.4, o * at(sx * px, H - 0.6, 0), S.accent, M.Metal, "PylonCross")
      box(b, 2, 1.2, w + 2.4, o * at(sx * px, H / 2, 0), S.accent, M.Metal, "PylonCross")
    end
    local segs = 24
    local function cableY(x)
      local ax = math.abs(x)
      if ax <= px then local u = x / px return H - (H - 2) * (1 - u * u) end
      local u = (ax - px) / (L / 2 - px) return H - (H - 1.5) * u
    end
    for _, sz in ipairs({ -1, 1 }) do
      for i = 1, segs do
        local x0 = -L / 2 + (i - 1) * L / segs local x1 = -L / 2 + i * L / segs
        local y0, y1 = cableY(x0), cableY(x1)
        local len = math.sqrt((x1 - x0) ^ 2 + (y1 - y0) ^ 2)
        cylX(b, 0.18, len + 0.1, o * at((x0 + x1) / 2, (y0 + y1) / 2, sz * (w / 2 + 0.6)) * CFrame.Angles(0, 0, math.atan2(y1 - y0, x1 - x0)), S.accent, M.Metal, "MainCable", { CanCollide = false })
        cnt.cables = cnt.cables + 1
      end
      for x = -px + 3, px - 3, 4 do
        local y = cableY(x)
        if y > 1.5 then cylY(b, 0.08, y - 1.2, o * at(x, (y - 1.2) / 2 + 1.2, sz * (w / 2 + 0.6)), S.accent, M.Metal, "Hanger", { CanCollide = false }) end
      end
    end
  end
  return { length = L, width = w, bridge_style = kind, planks = cnt.planks, arches = cnt.arches, cables = cnt.cables }
end

function K.dungeon_room(b, a, o, S)
  local w, d, h = footprint(a, 24, 24, 12)
  local t = 2 local hx, hz = w / 2 + t / 2, d / 2 + t / 2
  box(b, w + 2 * t, 1, d + 2 * t, o * at(0, -0.5, 0), S.floor, S.floorMat, "Floor")
  local doorW, doorH = 6, 9
  local doors = a.doors
  local sides = { north = true, south = true }
  if type(doors) == "table" then sides = {} for _, s in ipairs(doors) do sides[key(s)] = true end
  elseif type(doors) == "number" then sides = {} local names = { "south", "north", "east", "west" } for i = 1, clamp(math.floor(doors), 0, 4) do sides[names[i]] = true end
  elseif doors == false then sides = {} end
  local function ops(L, has) if not has then return {} end return { { L / 2 - doorW / 2, L / 2 + doorW / 2, 0, doorH, "door", false } } end
  wallRun(b, o, Vector3.new(-hx, 0, -hz), Vector3.new(hx, 0, -hz), h, t, ops(w + 2 * t, sides.south), S.wall, S.wallMat, "WallSouth", S)
  wallRun(b, o, Vector3.new(hx, 0, hz), Vector3.new(-hx, 0, hz), h, t, ops(w + 2 * t, sides.north), S.wall, S.wallMat, "WallNorth", S)
  wallRun(b, o, Vector3.new(-hx, 0, hz), Vector3.new(-hx, 0, -hz), h, t, ops(d + 2 * t, sides.west), S.wall, S.wallMat, "WallWest", S)
  wallRun(b, o, Vector3.new(hx, 0, -hz), Vector3.new(hx, 0, hz), h, t, ops(d + 2 * t, sides.east), S.wall, S.wallMat, "WallEast", S)
  if a.ceiling ~= false then box(b, w + 2 * t, 1, d + 2 * t, o * at(0, h + 0.5, 0), shade(S.wall, 0.8), S.wallMat, "Ceiling") end
  local pillars = 0
  if w >= 16 and d >= 16 and a.pillars ~= false then
    for _, sx in ipairs({ -1, 1 }) do for _, sz in ipairs({ -1, 1 }) do
      cylY(b, 1, h, o * at(sx * (w / 2 - 3), h / 2, sz * (d / 2 - 3)), S.stone, S.wallMat, "Pillar")
      box(b, 2.6, 0.6, 2.6, o * at(sx * (w / 2 - 3), 0.3, sz * (d / 2 - 3)), S.trim, S.trimMat, "PillarBase")
      box(b, 2.6, 0.6, 2.6, o * at(sx * (w / 2 - 3), h - 0.3, sz * (d / 2 - 3)), S.trim, S.trimMat, "PillarCap")
      pillars = pillars + 1
    end end
  end
  local torches = 0
  if a.torches ~= false then
    local spots = { { -w / 4, 0, -d / 2 + 0.6 }, { w / 4, 0, -d / 2 + 0.6 }, { -w / 4, 0, d / 2 - 0.6 }, { w / 4, 0, d / 2 - 0.6 } }
    for _, p in ipairs(spots) do
      local ty = h * 0.6
      cylY(b, 0.22, 2, o * at(p[1], ty, p[3]), S.wood, M.Wood, "Torch", { CanCollide = false })
      local flame = ball(b, 0.45, o * at(p[1], ty + 1.3, p[3]), C(255, 150, 40), M.Neon, "Flame", { CanCollide = false })
      light(flame, "PointLight", C(255, 160, 70), 1.4, 18)
      pcall(function() local f = Instance.new("Fire") f.Size = 2 f.Heat = 5 f.Parent = flame end)
      torches = torches + 1
    end
  end
  if a.props ~= false then
    local R = rnd(a.seed or 7)
    for i = 1, math.floor(num(a.prop_count, 4, 0, 24)) do
      local px, pz = R(-w / 2 + 3, w / 2 - 3), R(-d / 2 + 3, d / 2 - 3)
      if i % 2 == 0 then cylY(b, 1.1, 2.6, o * at(px, 1.3, pz), C(120, 85, 50), M.Wood, "Barrel") box(b, 2.4, 0.2, 2.4, o * at(px, 0.7, pz), C(80, 80, 85), M.Metal, "BarrelBand") box(b, 2.4, 0.2, 2.4, o * at(px, 1.9, pz), C(80, 80, 85), M.Metal, "BarrelBand")
      else box(b, 2.4, 2.4, 2.4, o * at(px, 1.2, pz) * CFrame.Angles(0, R(0, TAU), 0), C(140, 100, 60), M.WoodPlanks, "Crate") end
    end
  end
  if a.cells then
    local n = math.floor(w / 1.2)
    for i = 0, n do cylY(b, 0.1, h - 1, o * at(-w / 2 + i * (w / n), (h - 1) / 2, d / 4), C(60, 60, 66), M.Metal, "CellBar") end
    box(b, w, 0.3, 0.3, o * at(0, h - 1, d / 4), C(60, 60, 66), M.Metal, "CellRail")
  end
  return { width = w, depth = d, height = h, pillars = pillars, torches = torches, doors = sides }
end

function K.dock(b, a, o, S)
  local L = num(a.length, 30, 6, 300)
  local w = num(a.width, 8, 3, 40)
  local depth = num(a.depth, 10, 1, 100)
  local n = math.floor(L / 1.6)
  local pl = L / n
  local col = rgb(a.color, S.wood) local mat = matOf(a.material, M.WoodPlanks)
  for i = 1, n do box(b, pl * 0.92, 0.4, w, o * at(-L / 2 + (i - 0.5) * pl, -0.2, 0), shade(col, 0.88 + 0.16 * ((i % 4) / 4)), mat, "Plank") end
  for _, sz in ipairs({ -1, 1 }) do box(b, L, 0.6, 0.6, o * at(0, -0.7, sz * (w / 2 - 0.5)), shade(col, 0.8), M.Wood, "Joist") end
  local posts = 0
  for x = -L / 2 + 1, L / 2, 8 do
    for _, sz in ipairs({ -1, 1 }) do cylY(b, 0.45, depth + 1.5, o * at(x, -depth / 2 + 0.5, sz * (w / 2 - 0.5)), shade(col, 0.7), M.Wood, "Piling") posts = posts + 1 end
  end
  for _, sx in ipairs({ -1, 1 }) do cylY(b, 0.5, 1.6, o * at(sx * (L / 2 - 1.5), 0.8, w / 2 - 1), C(50, 50, 55), M.Metal, "Bollard") end
  if a.rails then
    for _, sz in ipairs({ -1, 1 }) do
      box(b, L, 0.3, 0.3, o * at(0, 3, sz * (w / 2 - 0.3)), col, M.Wood, "Rail")
      for x = -L / 2 + 0.5, L / 2, 6 do box(b, 0.4, 3.2, 0.4, o * at(x, 1.6, sz * (w / 2 - 0.3)), col, M.Wood, "RailPost") end
    end
  end
  for i = 0, 4 do box(b, 2, 0.25, 0.25, o * at(L / 2 + 0.3, -0.6 - i * 1.3, 0), C(60, 60, 66), M.Metal, "LadderRung") end
  box(b, 0.25, 6.5, 0.25, o * at(L / 2 + 0.3, -2.5, -1), C(60, 60, 66), M.Metal, "LadderRail") box(b, 0.25, 6.5, 0.25, o * at(L / 2 + 0.3, -2.5, 1), C(60, 60, 66), M.Metal, "LadderRail")
  return { length = L, width = w, planks = n, pilings = posts }
end

function K.watchtower(b, a, o, S)
  local h = num(a.height, 20, 6, 120)
  local w = num(a.width, 8, 4, 30)
  local col = rgb(a.color, S.wood) local mat = matOf(a.material, M.Wood)
  local legs = 0
  for _, sx in ipairs({ -1, 1 }) do for _, sz in ipairs({ -1, 1 }) do
    local lean = math.rad(6)
    box(b, 0.9, h + 1, 0.9, o * at(sx * (w / 2 + h * 0.05), (h + 1) / 2, sz * (w / 2 + h * 0.05)) * CFrame.Angles(-sz * lean, 0, sx * lean), col, mat, "Leg")
    legs = legs + 1
  end end
  local braces = math.max(1, math.floor(h / 8))
  for i = 1, braces do
    local y = i * h / (braces + 1)
    local span = w + 2 * (h - y) * 0.1 + 1
    for _, sz in ipairs({ -1, 1 }) do box(b, span, 0.4, 0.4, o * at(0, y, sz * (span / 2)), col, mat, "Brace") box(b, 0.4, 0.4, span, o * at(sz * (span / 2), y, 0), col, mat, "Brace") end
    for _, sz in ipairs({ -1, 1 }) do box(b, math.sqrt(2) * span, 0.3, 0.3, o * at(0, y + 0.1, sz * (span / 2)) * CFrame.Angles(0, 0, PI / 4), shade(col, 0.85), mat, "CrossBrace") end
  end
  box(b, w + 3, 0.6, w + 3, o * at(0, h + 0.3, 0), col, M.WoodPlanks, "Platform")
  for _, sz in ipairs({ -1, 1 }) do
    box(b, w + 3, 0.3, 0.3, o * at(0, h + 3.3, sz * (w / 2 + 1.35)), col, mat, "Rail") box(b, 0.3, 0.3, w + 3, o * at(sz * (w / 2 + 1.35), h + 3.3, 0), col, mat, "Rail")
    for _, sx in ipairs({ -1, 1 }) do box(b, 0.4, 3, 0.4, o * at(sx * (w / 2 + 1.35), h + 2, sz * (w / 2 + 1.35)), col, mat, "RailPost") end
  end
  if a.roof ~= false and key(a.roof, "hip") ~= "none" then
    for _, sx in ipairs({ -1, 1 }) do for _, sz in ipairs({ -1, 1 }) do box(b, 0.5, 6, 0.5, o * at(sx * (w / 2 + 1), h + 3.6 + 3, sz * (w / 2 + 1)), col, mat, "RoofPost") end end
    roofBuild(b, o, "hip", w + 2, w + 2, h + 9.6, S, 0.6, 1)
  end
  for i = 1, math.floor(h / 1.4) do box(b, 2, 0.25, 0.25, o * at(0, i * 1.4, -(w / 2 + 0.2)), shade(col, 0.75), mat, "LadderRung") end
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.25, h + 2, 0.25, o * at(sx * 1, (h + 2) / 2, -(w / 2 + 0.2)), shade(col, 0.75), mat, "LadderRail") end
  if a.lights ~= false then local lamp = box(b, 0.8, 0.8, 0.8, o * at(0, h + 5.5, 0), C(255, 200, 120), M.Neon, "Lantern", { CanCollide = false }) light(lamp, "PointLight", C(255, 190, 110), 1.6, 30) end
  return { height = h, width = w, legs = legs }
end

function K.windmill(b, a, o, S)
  local h = num(a.height, 30, 10, 120)
  local r = num(a.radius, 6, 3, 25)
  local tiers = 3
  for i = 1, tiers do
    local rr = r * (1 - (i - 1) * 0.15)
    cylY(b, rr, h / tiers + 0.1, o * at(0, (i - 0.5) * h / tiers, 0), S.wall, S.wallMat, "TowerTier")
  end
  box(b, 4, 7, 0.6, o * at(0, 3.6, -r + 0.2), shade(S.wood, 0.75), M.Wood, "Door", { CanCollide = false })
  box(b, 3, 3, 0.4, o * at(0, h * 0.55, -r * 0.85 + 0.2), S.glass, M.Glass, "Window", { Transparency = 0.4 })
  local capR = r * 0.75
  cylY(b, capR + 0.6, 1.5, o * at(0, h + 0.75, 0), S.trim, S.trimMat, "CapRing")
  local cap = ball(b, capR + 0.2, o * at(0, h + 1.2, 0), S.roof, S.roofMat, "Cap")
  local hubCF = o * at(0, h + 1.2, -(capR + 1.6))
  local hub = cylZ(b, 0.9, 2.4, hubCF, S.accent, M.Metal, "Hub")
  local bl = num(a.blade_length, h * 0.42, 4, 80)
  local blades = {}
  local nb = math.floor(num(a.blades, 4, 2, 8))
  for i = 0, nb - 1 do
    local ang = i / nb * TAU
    local bcf = hubCF * CFrame.Angles(0, 0, ang) * at(0, bl / 2 + 0.5, -0.4)
    blades[#blades + 1] = box(b, 0.5, bl, 0.5, bcf, S.wood, M.Wood, "BladeSpar")
    blades[#blades + 1] = box(b, 2.6, bl * 0.8, 0.15, hubCF * CFrame.Angles(0, 0, ang) * at(1.4, bl * 0.6, -0.4), C(235, 230, 215), M.Fabric, "Sail", { CanCollide = false })
    for k = 1, 4 do blades[#blades + 1] = box(b, 2.8, 0.2, 0.3, hubCF * CFrame.Angles(0, 0, ang) * at(1.4, bl * 0.25 + k * bl * 0.16, -0.4), S.wood, M.Wood, "SailBar", { CanCollide = false }) end
  end
  local spin = a.spin ~= false
  if spin then
    hub.Anchored = false
    for _, p in ipairs(blades) do p.Anchored = false weld(hub, p) end
    -- the hub is a Z cylinder: its local X axis (= the hinge axis of an identity attachment) is the sail axis
    motor(cap, hub, cap.CFrame:ToObjectSpace(hub.CFrame), CFrame.new(), "WindmillMotor", num(a.speed, 0.6, -10, 10), 1e6)
  end
  if a.lights ~= false then light(hub, "PointLight", C(255, 220, 170), 0.6, 10) end
  return { height = h, radius = r, blades = nb, blade_length = bl, spinning = spin }
end

function K.lighthouse(b, a, o, S)
  local h = num(a.height, 40, 12, 200)
  local r = num(a.radius, 5, 2.5, 20)
  local tiers = 4
  local base = rgb(a.color, C(240, 240, 236)) local band = rgb(a.color2, C(190, 40, 40))
  local bodyParts = {}
  for i = 1, tiers do
    local rr = r * (1 - (i - 1) * 0.12)
    local th = h / tiers
    local c = (i % 2 == 1) and base or band
    bodyParts[#bodyParts + 1] = cylY(b, rr, th + 0.05, o * at(0, (i - 0.5) * th, 0), c, matOf(a.material, M.Concrete), "Tier")
  end
  cylY(b, r + 1.2, 1.5, o * at(0, 0.75, 0), S.stone, S.floorMat, "Base")
  box(b, 3.5, 7, 0.6, o * at(0, 3.5 + 1.5, -r + 0.2), shade(S.wood, 0.75), M.Wood, "Door", { CanCollide = false })
  for lv = 1, math.floor(h / 12) do box(b, 2, 2.6, 0.4, o * at(0, lv * 12 - 3, -r * (1 - (lv - 1) * 0.12 / 3) + 0.1), S.glass, M.Glass, "Window", { Transparency = 0.35 }) end
  local topR = r * (1 - (tiers - 1) * 0.12)
  local gallery = cylY(b, topR + 2, 0.8, o * at(0, h + 0.4, 0), S.accent, M.Metal, "Gallery")
  local n = 12
  for i = 0, n - 1 do local ang = i / n * TAU cylY(b, 0.12, 3, o * CFrame.Angles(0, ang, 0) * at(topR + 1.7, h + 2.3, 0), S.accent, M.Metal, "GalleryPost") end
  cylY(b, topR + 1.75, 0.2, o * at(0, h + 3.8, 0), S.accent, M.Metal, "GalleryRail", { CanCollide = false })
  local roomH = 7
  cylY(b, topR, roomH, o * at(0, h + 0.8 + roomH / 2, 0), C(170, 220, 240), M.Glass, "LanternRoom", { Transparency = 0.6 })
  for i = 0, 5 do local ang = i / 6 * TAU box(b, 0.4, roomH, 0.4, o * CFrame.Angles(0, ang, 0) * at(topR - 0.1, h + 0.8 + roomH / 2, 0), S.accent, M.Metal, "Mullion") end
  local lamp = ball(b, 1.1, o * at(0, h + 0.8 + roomH / 2, 0), C(255, 240, 200), M.Neon, "Lamp", { CanCollide = false })
  light(lamp, "PointLight", C(255, 235, 190), 2, 40)
  cylY(b, topR + 0.5, 1, o * at(0, h + 0.8 + roomH + 0.5, 0), S.accent, M.Metal, "RoofRing")
  local dome = ball(b, topR + 0.3, o * at(0, h + 0.8 + roomH + 0.3, 0), band, M.Metal, "Dome")
  local beam = box(b, 0.1, 0.1, 0.1, o * at(0, h + 0.8 + roomH / 2, 0), C(255, 240, 200), M.Neon, "BeamPivot", { Transparency = 1, CanCollide = false })
  local beamLen = num(a.beam_length, 60, 10, 400)
  local ray = box(b, 1.2, 1.2, beamLen, o * at(0, h + 0.8 + roomH / 2, -beamLen / 2 - 1), C(255, 240, 200), M.Neon, "Beam", { Transparency = 0.82, CanCollide = false, CastShadow = false })
  light(beam, "SpotLight", C(255, 240, 200), 4, beamLen, { Angle = 25, Face = Enum.NormalId.Front })
  local rotate = a.rotate ~= false
  if rotate then
    beam.Anchored = false ray.Anchored = false weld(beam, ray)
    motor(gallery, beam, gallery.CFrame:ToObjectSpace(beam.CFrame) * ROT_Y, CFrame.new() * ROT_Y, "BeamMotor", num(a.speed, 0.5, -10, 10), 1e6)
  end
  return { height = h + 0.8 + roomH + topR, radius = r, rotating_beam = rotate, beam_length = beamLen }
end

function K.pergola(b, a, o, S)
  local w, d, h = footprint(a, 16, 12, 9)
  local col = rgb(a.color, S.wood) local mat = matOf(a.material, M.Wood)
  local nx = math.max(2, math.floor(w / 8) + 1)
  local nz = math.max(2, math.floor(d / 8) + 1)
  local posts = 0
  for i = 0, nx - 1 do for j = 0, nz - 1 do
    if i == 0 or i == nx - 1 or j == 0 or j == nz - 1 then box(b, 0.8, h, 0.8, o * at(-w / 2 + i * (w / (nx - 1)), h / 2, -d / 2 + j * (d / (nz - 1))), col, mat, "Post") posts = posts + 1 end
  end end
  for j = 0, nz - 1 do box(b, w + 2, 0.8, 0.5, o * at(0, h + 0.4, -d / 2 + j * (d / (nz - 1))), col, mat, "Beam") end
  local slats = 0
  for x = -w / 2 - 0.5, w / 2 + 0.5, 1.6 do box(b, 0.3, 0.6, d + 2, o * at(x, h + 1.1, 0), shade(col, 0.92), mat, "Slat") slats = slats + 1 end
  if a.vines then local R = rnd(a.seed or 3) for i = 1, slats do box(b, 0.6, 0.5, R(2, d), o * at(-w / 2 - 0.5 + (i - 1) * 1.6, h + 1.5, R(-d / 4, d / 4)), C(70, 130, 60), M.Grass, "Vine", { CanCollide = false }) end end
  return { width = w, depth = d, height = h, posts = posts, slats = slats }
end
MK.K = K

-- vehicles ----------------------------------------------------------------------------
local V = {}
local DRIVE_SRC = [=[
-- TotalScript vehicle_build drive script (arcade): VehicleSeat Throttle / Steer -> hinge motors or velocity constraints
local model = script.Parent
local RunService = game:GetService("RunService")
local seat = model:FindFirstChildWhichIsA("VehicleSeat", true)
if not seat then return end
local maxSpeed = model:GetAttribute("MaxSpeed") or 60
local turn = model:GetAttribute("TurnSpeed") or 0.6
local mode = model:GetAttribute("DriveMode") or "wheels"
local hinges = {}
for _, d in ipairs(model:GetDescendants()) do
  if d:IsA("HingeConstraint") and d:GetAttribute("Side") then hinges[#hinges + 1] = d end
end
local lv = model:FindFirstChild("DriveVelocity", true)
local av = model:FindFirstChild("DriveTurn", true)
RunService.Heartbeat:Connect(function()
  local t, s = seat.Throttle, seat.Steer
  if mode == "wheels" then
    for _, h in ipairs(hinges) do
      local r = h:GetAttribute("Radius") or 1.5
      local w = (maxSpeed / r) * t
      local side = h:GetAttribute("Side")
      if side == "L" then w = w + s * turn * (maxSpeed / r) elseif side == "R" then w = w - s * turn * (maxSpeed / r) end
      h.AngularVelocity = -w
    end
  else
    if lv then lv.VectorVelocity = Vector3.new(0, 0, -maxSpeed * t) end
    if av then av.AngularVelocity = Vector3.new(0, -s * turn * 2, 0) end
  end
end)
]=]
local function wheel(b, root, x, y, z, r, width, col, side, drivable)
  local w = cylX(b, r, width, at(x, y, z), col or C(30, 30, 32), M.Rubber, "Wheel")
  local hub = cylX(b, r * 0.55, width + 0.1, at(x, y, z), C(170, 172, 178), M.Metal, "Hubcap", { CanCollide = false })
  if drivable then
    w.Anchored = false hub.Anchored = false weld(w, hub)
    pcall(function() w.CustomPhysicalProperties = PhysicalProperties.new(1.2, 2, 0.1, 1, 1) end)
    local h = motor(root, w, root.CFrame:ToObjectSpace(w.CFrame), CFrame.new(), "WheelMotor", 0, 60000)
    h:SetAttribute("Side", side) h:SetAttribute("Radius", r)
  end
  return w
end
local function vehicleFinish(b, a, root, name, kind, mode, wheels)
  local m = b.m
  local drivable = a.drivable == true
  local seatPart = nil
  if drivable then
    for _, p in ipairs(b.parts) do
      if p.Name ~= "Wheel" and p.Name ~= "Hubcap" and p ~= root and p.Anchored then p.Anchored = false weld(root, p) end
    end
    root.Anchored = false
    seatPart = Instance.new("VehicleSeat") seatPart.Name = "VehicleSeat" seatPart.Size = Vector3.new(2, 0.6, 2)
    seatPart.CFrame = b.R * (a.__seat or CFrame.new(0, 2, 0)) seatPart.Anchored = false seatPart.Color = C(40, 40, 45) seatPart.Material = M.Fabric
    seatPart.MaxSpeed = num(a.max_speed, 60) seatPart.Torque = 10 seatPart.TurnSpeed = 1 seatPart.HeadsUpDisplay = true
    seatPart.Parent = m weld(root, seatPart)
    m:SetAttribute("MaxSpeed", num(a.max_speed, mode == "wheels" and 60 or 40))
    m:SetAttribute("TurnSpeed", num(a.turn_speed, 0.6))
    m:SetAttribute("DriveMode", mode)
    if mode ~= "wheels" then
      local a0 = attach(root, "DriveAttachment", CFrame.new())
      local lv = Instance.new("LinearVelocity") lv.Name = "DriveVelocity" lv.Attachment0 = a0 lv.RelativeTo = Enum.ActuatorRelativeTo.Attachment0 lv.MaxForce = 1e6 lv.VectorVelocity = Vector3.new() lv.Parent = root
      local av = Instance.new("AngularVelocity") av.Name = "DriveTurn" av.Attachment0 = a0 av.RelativeTo = Enum.ActuatorRelativeTo.Attachment0 av.MaxTorque = 1e6 av.AngularVelocity = Vector3.new() av.Parent = root
      if mode == "float" then for _, p in ipairs(b.parts) do if p.Name == "Hull" or p.Name == "Bow" or p.Name == "Barrel" then pcall(function() p.CustomPhysicalProperties = PhysicalProperties.new(0.25, 0.3, 0.5, 1, 1) end) end end end
    end
    local s = Instance.new("Script") s.Name = "Drive" s.Source = DRIVE_SRC s.Parent = m
  end
  finish(b, name, parentOf(a.parent), root)
  return { kind = kind, drivable = drivable, drive_mode = drivable and mode or "static", wheels = wheels or 0, parts = b.n, seat = seatPart and seatPart:GetFullName() or nil,
    note = drivable and ("arcade physics: " .. (mode == "wheels" and "hinge motor wheels with differential steering, no suspension" or (mode == "float" and "buoyant hull + LinearVelocity / AngularVelocity drive (needs Terrain water)" or "LinearVelocity / AngularVelocity hover drive, altitude held at spawn height"))) or "anchored static model (pass drivable=true for a VehicleSeat rig)" }
end
local function headlights(b, root, w, y, z, col)
  for _, sx in ipairs({ -1, 1 }) do
    local hl = box(b, 0.8, 0.5, 0.2, at(sx * (w / 2 - 0.8), y, z), col or C(255, 250, 220), M.Neon, "Headlight", { CanCollide = false })
    light(hl, "SpotLight", C(255, 250, 220), 2, 40, { Angle = 45, Face = Enum.NormalId.Front })
  end
end
local function taillights(b, w, y, z)
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.8, 0.4, 0.2, at(sx * (w / 2 - 0.8), y, z), C(220, 40, 40), M.Neon, "Taillight", { CanCollide = false }) end
end
function V.car(b, a)
  local L, w = num(a.length, 12, 6, 40), num(a.width, 6, 3, 16)
  local col = rgb(a.color, C(200, 40, 50)) local mat = matOf(a.material, M.SmoothPlastic)
  local r = num(a.wheel_radius, 1.4, 0.6, 4)
  local by = r + 0.6
  local root = box(b, w, 1.6, L, at(0, by + 0.8, 0), col, mat, "Chassis")
  box(b, w - 0.4, 0.8, L * 0.3, at(0, by + 2, -L * 0.25), col, mat, "Hood")
  glass(b, w - 1.2, 1.8, L * 0.42, at(0, by + 2.5, L * 0.05), C(140, 190, 220), "Cabin")
  box(b, w - 1.4, 0.2, L * 0.42, at(0, by + 3.5, L * 0.05), col, mat, "RoofPanel")
  box(b, w - 0.4, 1.0, L * 0.22, at(0, by + 2.1, L * 0.36), col, mat, "Trunk")
  box(b, w + 0.4, 0.5, 0.6, at(0, by + 0.6, -L / 2 - 0.2), C(60, 60, 66), M.Metal, "Bumper")
  box(b, w + 0.4, 0.5, 0.6, at(0, by + 0.6, L / 2 + 0.2), C(60, 60, 66), M.Metal, "Bumper")
  if a.spoiler then box(b, w - 0.6, 0.2, 1.2, at(0, by + 3, L / 2 - 0.6), C(30, 30, 34), M.SmoothPlastic, "Spoiler") end
  headlights(b, root, w, by + 1.6, -L / 2 - 0.1) taillights(b, w, by + 1.6, L / 2 + 0.1)
  local d = a.drivable == true
  wheel(b, root, -(w / 2 + 0.3), r, -L * 0.3, r, 1, nil, "L", d) wheel(b, root, (w / 2 + 0.3), r, -L * 0.3, r, 1, nil, "R", d)
  wheel(b, root, -(w / 2 + 0.3), r, L * 0.3, r, 1, nil, "L", d) wheel(b, root, (w / 2 + 0.3), r, L * 0.3, r, 1, nil, "R", d)
  a.__seat = at(-w / 6, by + 1.9, L * 0.02)
  return root, "wheels", 4
end
function V.truck(b, a)
  local L, w = num(a.length, 20, 10, 60), num(a.width, 7, 4, 16)
  local col = rgb(a.color, C(40, 90, 170)) local mat = matOf(a.material, M.SmoothPlastic)
  local r = num(a.wheel_radius, 1.8, 0.8, 5)
  local by = r + 0.8
  local root = box(b, w, 1.4, L, at(0, by + 0.7, 0), C(50, 50, 56), M.Metal, "Chassis")
  local cabL = L * 0.3
  box(b, w, 3.2, cabL, at(0, by + 1.4 + 1.6, -L / 2 + cabL / 2), col, mat, "Cab")
  glass(b, w - 0.8, 1.8, 0.3, at(0, by + 4, -L / 2 + 0.2), C(140, 190, 220), "Windscreen")
  box(b, w - 0.6, 1, 0.3, at(0, by + 5.6 + 0.5, -L / 2 + cabL / 2), col, mat, "CabRoofSign")
  local bedL = L - cabL - 1
  local bedZ = -L / 2 + cabL + 1 + bedL / 2
  box(b, w, 0.4, bedL, at(0, by + 1.6, bedZ), C(110, 80, 50), M.WoodPlanks, "BedFloor")
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.3, 2.2, bedL, at(sx * (w / 2 - 0.15), by + 2.9, bedZ), col, mat, "BedSide") end
  box(b, w, 2.2, 0.3, at(0, by + 2.9, L / 2 - 0.15), col, mat, "Tailgate") box(b, w, 2.6, 0.3, at(0, by + 3.1, -L / 2 + cabL + 0.5), col, mat, "Headboard")
  if a.covered then box(b, w, 3.5, bedL, at(0, by + 1.8 + 1.75 + 0.2, bedZ), rgb(a.color2, C(230, 230, 225)), M.Fabric, "Canopy") end
  box(b, w + 0.4, 0.6, 0.6, at(0, by + 0.8, -L / 2 - 0.2), C(60, 60, 66), M.Metal, "Bumper")
  headlights(b, root, w, by + 2.2, -L / 2 - 0.1) taillights(b, w, by + 2, L / 2 + 0.1)
  cylY(b, 0.3, 3, at(w / 2 - 0.6, by + 5.6 + 1, -L / 2 + cabL - 0.5), C(60, 60, 66), M.Metal, "Exhaust")
  local d = a.drivable == true
  wheel(b, root, -(w / 2 + 0.3), r, -L * 0.36, r, 1.2, nil, "L", d) wheel(b, root, (w / 2 + 0.3), r, -L * 0.36, r, 1.2, nil, "R", d)
  for _, zf in ipairs({ 0.16, 0.36 }) do wheel(b, root, -(w / 2 + 0.3), r, L * zf, r, 1.2, nil, "L", d) wheel(b, root, (w / 2 + 0.3), r, L * zf, r, 1.2, nil, "R", d) end
  a.__seat = at(-w / 5, by + 2.6, -L / 2 + cabL / 2 + 0.5)
  return root, "wheels", 6
end
function V.kart(b, a)
  local L, w = num(a.length, 8, 4, 16), num(a.width, 4.5, 2.5, 10)
  local col = rgb(a.color, C(240, 180, 30))
  local r = num(a.wheel_radius, 0.9, 0.4, 2)
  local by = r + 0.3
  local root = box(b, w - 1, 0.5, L, at(0, by, 0), C(50, 50, 56), M.Metal, "Chassis")
  box(b, w - 1.4, 0.8, L * 0.3, at(0, by + 0.65, -L * 0.3), col, M.SmoothPlastic, "Nose")
  wedge(b, w - 1.4, 0.8, L * 0.15, at(0, by + 0.65, -L * 0.52) * CFrame.Angles(0, PI, 0), col, M.SmoothPlastic, "NoseCone")
  box(b, w - 1.2, 1.2, L * 0.22, at(0, by + 0.85, L * 0.36), col, M.SmoothPlastic, "Engine")
  box(b, 1.6, 1.4, 0.4, at(0, by + 1.6, L * 0.05), C(40, 40, 45), M.Fabric, "SeatBack")
  cylZ(b, 0.6, 0.15, at(0, by + 1.8, -L * 0.18), C(30, 30, 34), M.SmoothPlastic, "SteeringWheel", { CanCollide = false })
  cylZ(b, 0.08, 1.6, at(0, by + 1.4, -L * 0.1) * CFrame.Angles(math.rad(-30), 0, 0), C(80, 80, 88), M.Metal, "SteeringColumn", { CanCollide = false })
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.3, 0.3, L * 0.8, at(sx * (w / 2 - 0.2), by + 0.3, 0), C(80, 80, 88), M.Metal, "SideBar") end
  local d = a.drivable == true
  wheel(b, root, -(w / 2 + 0.3), r, -L * 0.35, r, 0.9, nil, "L", d) wheel(b, root, (w / 2 + 0.3), r, -L * 0.35, r, 0.9, nil, "R", d)
  wheel(b, root, -(w / 2 + 0.3), r, L * 0.33, r * 1.1, 1.1, nil, "L", d) wheel(b, root, (w / 2 + 0.3), r, L * 0.33, r * 1.1, 1.1, nil, "R", d)
  a.__seat = at(0, by + 0.6, L * 0.08)
  return root, "wheels", 4
end
function V.buggy(b, a)
  local L, w = num(a.length, 11, 6, 30), num(a.width, 6, 3, 14)
  local col = rgb(a.color, C(90, 150, 60))
  local r = num(a.wheel_radius, 1.9, 0.8, 5)
  local by = r + 0.5
  local root = box(b, w - 1, 1, L, at(0, by + 0.5, 0), col, M.Metal, "Chassis")
  box(b, w - 1, 1.4, L * 0.35, at(0, by + 1.7, -L * 0.3), col, M.Metal, "Hood")
  glass(b, w - 1.6, 1.6, 0.2, at(0, by + 3, -L * 0.12) * CFrame.Angles(math.rad(-15), 0, 0), C(140, 190, 220), "Windscreen")
  for _, sx in ipairs({ -1, 1 }) do
    cylY(b, 0.18, 3.6, at(sx * (w / 2 - 0.8), by + 1 + 1.8, -L * 0.1), C(40, 40, 45), M.Metal, "CageBar")
    cylY(b, 0.18, 3.6, at(sx * (w / 2 - 0.8), by + 1 + 1.8, L * 0.3), C(40, 40, 45), M.Metal, "CageBar")
    cylZ(b, 0.18, L * 0.42, at(sx * (w / 2 - 0.8), by + 4.7, L * 0.1), C(40, 40, 45), M.Metal, "CageTop")
  end
  cylX(b, 0.18, w - 1.6, at(0, by + 4.7, -L * 0.1), C(40, 40, 45), M.Metal, "CageCross") cylX(b, 0.18, w - 1.6, at(0, by + 4.7, L * 0.3), C(40, 40, 45), M.Metal, "CageCross")
  box(b, 1.8, 1.6, 0.4, at(-w / 6, by + 1.8, L * 0.12), C(40, 40, 45), M.Fabric, "SeatBack") box(b, 1.8, 1.6, 0.4, at(w / 6, by + 1.8, L * 0.12), C(40, 40, 45), M.Fabric, "SeatBack")
  cylX(b, 1, 1.4, at(0, by + 2.2, L / 2 - 0.2), C(30, 30, 32), M.Rubber, "SpareWheel")
  headlights(b, root, w - 1, by + 2.3, -L / 2 - 0.05)
  local d = a.drivable == true
  wheel(b, root, -(w / 2 + 0.5), r, -L * 0.32, r, 1.4, nil, "L", d) wheel(b, root, (w / 2 + 0.5), r, -L * 0.32, r, 1.4, nil, "R", d)
  wheel(b, root, -(w / 2 + 0.5), r, L * 0.32, r, 1.4, nil, "L", d) wheel(b, root, (w / 2 + 0.5), r, L * 0.32, r, 1.4, nil, "R", d)
  a.__seat = at(-w / 6, by + 1.3, L * 0.14)
  return root, "wheels", 4
end
function V.wagon(b, a)
  local L, w = num(a.length, 12, 6, 30), num(a.width, 6, 3, 12)
  local col = rgb(a.color, C(130, 90, 55))
  local r = num(a.wheel_radius, 2, 0.8, 5)
  local by = r
  local root = box(b, w, 0.6, L, at(0, by + 0.3, 0), col, M.WoodPlanks, "Chassis")
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.4, 2.4, L, at(sx * (w / 2 - 0.2), by + 1.8, 0), col, M.WoodPlanks, "Side") end
  box(b, w, 2.4, 0.4, at(0, by + 1.8, L / 2 - 0.2), col, M.WoodPlanks, "Tailboard") box(b, w, 2.8, 0.4, at(0, by + 2, -L / 2 + 0.2), col, M.WoodPlanks, "Headboard")
  box(b, w, 0.5, 1.6, at(0, by + 3.4, -L / 2 + 1.2), shade(col, 0.8), M.Wood, "DriverBench")
  for _, sx in ipairs({ -0.5, 0.5 }) do cylZ(b, 0.2, 7, at(sx * (w - 1.2), by + 0.6, -L / 2 - 3.5), shade(col, 0.8), M.Wood, "Shaft") end
  if a.covered then
    for i = 0, 4 do cylX(b, 0.15, w + 0.6, at(0, by + 3.2 + 2.2, -L / 2 + 1 + i * (L - 2) / 4), shade(col, 0.7), M.Wood, "Hoop") end
    box(b, w + 0.8, 3, L - 1.5, at(0, by + 3.2 + 1.3, 0.2), rgb(a.color2, C(235, 228, 210)), M.Fabric, "Canopy")
  end
  local d = a.drivable == true
  local function spoked(x, z, side)
    local wh = wheel(b, root, x, r, z, r, 0.5, C(110, 80, 50), side, d)
    for k = 0, 3 do local sp = box(b, 0.3, r * 1.9, 0.3, at(x, r, z) * CFrame.Angles(k * PI / 4, 0, 0), shade(col, 0.7), M.Wood, "Spoke", { CanCollide = false }) if d then sp.Anchored = false weld(wh, sp) end end
  end
  spoked(-(w / 2 + 0.4), -L * 0.3, "L") spoked((w / 2 + 0.4), -L * 0.3, "R") spoked(-(w / 2 + 0.4), L * 0.3, "L") spoked((w / 2 + 0.4), L * 0.3, "R")
  a.__seat = at(0, by + 3.95, -L / 2 + 1.2)
  return root, "wheels", 4
end
function V.tank(b, a)
  local L, w = num(a.length, 18, 8, 50), num(a.width, 10, 5, 24)
  local col = rgb(a.color, C(90, 100, 70)) local mat = matOf(a.material, M.Metal)
  local r = num(a.wheel_radius, 1.3, 0.6, 3)
  local by = r + 0.4
  local trackW = 2.2
  local hullW = w - 2 * trackW - 0.4
  local root = box(b, hullW, 2.6, L, at(0, by + 1.3, 0), col, mat, "Hull")
  wedge(b, hullW, 1.4, 3, at(0, by + 2.6 + 0.7, -L / 2 + 1.5) * CFrame.Angles(0, PI, 0), col, mat, "GlacisPlate")
  for _, sx in ipairs({ -1, 1 }) do
    box(b, trackW, r * 2 + 0.6, L + 1, at(sx * (hullW / 2 + trackW / 2 + 0.2), by + 0.4, 0), col, mat, "TrackGuard", { CanCollide = false })
    box(b, trackW - 0.2, 0.4, L + 1.2, at(sx * (hullW / 2 + trackW / 2 + 0.2), r * 2 + 0.3, 0), C(40, 40, 42), M.Rubber, "TrackTop", { CanCollide = false })
  end
  local turret = cylY(b, hullW * 0.42, 1.8, at(0, by + 2.6 + 0.9, L * 0.05), col, mat, "Turret")
  box(b, 2, 1.6, 1.6, at(hullW * 0.2, by + 2.6 + 1.8 + 0.5, L * 0.12), col, mat, "Hatch")
  local barrelLen = num(a.barrel_length, L * 0.7, 4, 60)
  cylZ(b, 0.45, barrelLen, at(0, by + 3.6, L * 0.05 - hullW * 0.42 - barrelLen / 2), shade(col, 0.6), M.Metal, "Barrel")
  cylZ(b, 0.6, 1.4, at(0, by + 3.6, L * 0.05 - hullW * 0.42 - barrelLen + 0.7), shade(col, 0.5), M.Metal, "MuzzleBrake")
  attach(turret, "Muzzle", CFrame.new(0, 0.1, 0))
  local d = a.drivable == true
  local n = math.max(3, math.floor(L / (r * 2.4)))
  local wheels = 0
  for _, sx in ipairs({ -1, 1 }) do
    for i = 1, n do
      local z = -L / 2 + 1 + (i - 0.5) * ((L - 2) / n)
      wheel(b, root, sx * (hullW / 2 + trackW / 2 + 0.2), r, z, r, trackW - 0.4, C(50, 50, 54), sx < 0 and "L" or "R", d)
      wheels = wheels + 1
    end
  end
  a.__seat = at(0, by + 2.6 + 0.3, L * 0.3)
  return root, "wheels", wheels
end
function V.boat(b, a)
  local L, w = num(a.length, 16, 6, 60), num(a.width, 6, 3, 20)
  local col = rgb(a.color, C(230, 230, 225)) local trim = rgb(a.color2, C(60, 90, 150))
  local hullH = 2.4
  local bowLen = L * 0.3
  local bodyL = L - bowLen
  local root = box(b, w, hullH, bodyL, at(0, hullH / 2, bowLen / 2), col, M.SmoothPlastic, "Hull")
  wedge(b, hullH, w / 2, bowLen, at(w / 4, hullH / 2, -L / 2 + bowLen / 2) * CFrame.Angles(0, 0, -PI / 2), col, M.SmoothPlastic, "Bow")
  wedge(b, hullH, w / 2, bowLen, at(-w / 4, hullH / 2, -L / 2 + bowLen / 2) * CFrame.Angles(0, 0, PI / 2), col, M.SmoothPlastic, "Bow")
  box(b, w - 1, 0.3, bodyL - 1, at(0, hullH - 0.4, bowLen / 2), C(180, 140, 90), M.WoodPlanks, "Deck")
  box(b, w + 0.2, 0.3, bodyL + 0.2, at(0, hullH * 0.45, bowLen / 2), trim, M.SmoothPlastic, "Stripe", { CanCollide = false })
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.3, 0.9, bodyL - 1, at(sx * (w / 2 - 0.3), hullH + 0.35, bowLen / 2), col, M.SmoothPlastic, "Gunwale") end
  box(b, w - 1, 1.8, 1.6, at(0, hullH + 0.9, -L / 2 + bowLen + 1.6), col, M.SmoothPlastic, "Console")
  glass(b, w - 1.2, 1.6, 0.2, at(0, hullH + 2.4, -L / 2 + bowLen + 1) * CFrame.Angles(math.rad(-20), 0, 0), C(140, 190, 220), "Windscreen")
  cylZ(b, 0.5, 0.15, at(0, hullH + 2.2, -L / 2 + bowLen + 2.4), C(30, 30, 34), M.SmoothPlastic, "Helm", { CanCollide = false })
  box(b, 1.6, 1.2, 1.2, at(0, hullH + 0.6, L / 2 - 0.4), C(40, 40, 45), M.Metal, "Outboard")
  cylZ(b, 0.3, 1.6, at(0, hullH * 0.4, L / 2 + 0.5), C(60, 60, 66), M.Metal, "Propshaft")
  box(b, 1.6, 1.4, 0.4, at(-w / 6, hullH + 0.9, -L / 2 + bowLen + 3.6), C(40, 40, 45), M.Fabric, "Bench") box(b, 1.6, 1.4, 0.4, at(w / 6, hullH + 0.9, -L / 2 + bowLen + 3.6), C(40, 40, 45), M.Fabric, "Bench")
  local lamp = ball(b, 0.3, at(0, hullH + 3.2, -L / 2 + bowLen + 1), C(255, 255, 255), M.Neon, "Lamp", { CanCollide = false }) light(lamp, "PointLight", C(255, 255, 255), 1, 20)
  a.__seat = at(-w / 6, hullH + 0.25, -L / 2 + bowLen + 3.2)
  return root, "float", 0
end
function V.raft(b, a)
  local L, w = num(a.length, 10, 4, 30), num(a.width, 8, 3, 20)
  local col = rgb(a.color, C(150, 110, 70))
  local n = math.max(3, math.floor(w / 1.4))
  local root = box(b, w, 0.5, L, at(0, 1.6, 0), col, M.WoodPlanks, "Hull", { Transparency = 1, CanCollide = false })
  for i = 1, n do cylZ(b, 0.65, L, at(-w / 2 + (i - 0.5) * (w / n), 1.6, 0), shade(col, 0.85 + 0.3 * ((i % 2))), M.Wood, "Log") end
  box(b, w, 0.3, 0.6, at(0, 2.4, -L / 2 + 1), shade(col, 0.7), M.Wood, "CrossBeam") box(b, w, 0.3, 0.6, at(0, 2.4, L / 2 - 1), shade(col, 0.7), M.Wood, "CrossBeam")
  for _, sx in ipairs({ -1, 1 }) do cylX(b, 1, L * 0.8, at(sx * (w / 2 + 0.6), 1.1, 0) * CFrame.Angles(0, PI / 2, 0), C(120, 85, 50), M.Wood, "Barrel") end
  if a.sail ~= false then
    cylY(b, 0.25, 10, at(0, 2.5 + 5, 0), shade(col, 0.7), M.Wood, "Mast")
    box(b, 5, 6, 0.1, at(0, 9, 0.2), rgb(a.color2, C(235, 228, 205)), M.Fabric, "Sail", { CanCollide = false })
    cylX(b, 0.15, 5.4, at(0, 12, 0.2), shade(col, 0.7), M.Wood, "Yard", { CanCollide = false })
  end
  a.__seat = at(0, 2.5, L * 0.2)
  return root, "float", 0
end
function V.plane(b, a)
  local L = num(a.length, 18, 8, 60) local span = num(a.wingspan or a.width, L * 1.2, 6, 120)
  local col = rgb(a.color, C(220, 50, 50)) local col2 = rgb(a.color2, C(240, 240, 235))
  local r = 1.4
  local by = 3
  local root = cylZ(b, r, L, at(0, by + r, 0), col, M.SmoothPlastic, "Fuselage")
  ball(b, r, at(0, by + r, -L / 2), col, M.SmoothPlastic, "Nose")
  local wing = box(b, span, 0.35, L * 0.22, at(0, by + r - 0.4, -L * 0.05), col2, M.SmoothPlastic, "Wing")
  for _, sx in ipairs({ -1, 1 }) do box(b, span * 0.14, 0.3, L * 0.08, at(sx * span * 0.43, by + r - 0.4, L * 0.1), col, M.SmoothPlastic, "Aileron") end
  box(b, span * 0.38, 0.3, L * 0.14, at(0, by + r + 0.2, L / 2 - L * 0.08), col2, M.SmoothPlastic, "Tailplane")
  box(b, 0.3, L * 0.18, L * 0.14, at(0, by + r + L * 0.09 + 0.4, L / 2 - L * 0.08), col, M.SmoothPlastic, "Fin")
  glass(b, r * 1.5, 1.4, L * 0.22, at(0, by + r * 2, -L * 0.2), C(140, 190, 220), "Canopy")
  local prop = cylZ(b, 0.4, 0.8, at(0, by + r, -L / 2 - r - 0.4), C(40, 40, 45), M.Metal, "PropHub")
  local blades = { box(b, 0.5, r * 4, 0.12, at(0, by + r, -L / 2 - r - 0.5), C(60, 60, 66), M.Metal, "PropBlade", { CanCollide = false }), box(b, r * 4, 0.5, 0.12, at(0, by + r, -L / 2 - r - 0.5), C(60, 60, 66), M.Metal, "PropBlade", { CanCollide = false }) }
  local d = a.drivable == true
  if a.spin_prop ~= false then
    prop.Anchored = false for _, p in ipairs(blades) do p.Anchored = false weld(prop, p) end
    motor(root, prop, root.CFrame:ToObjectSpace(prop.CFrame), CFrame.new(), "PropMotor", 12, 1e5)
  end
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.3, by - 0.9, 0.3, at(sx * 1.6, (by - 0.9) / 2 + 0.9, -L * 0.15), C(60, 60, 66), M.Metal, "GearStrut") end
  box(b, 0.3, 1.6, 0.3, at(0, 0.8 + 0.6, L / 2 - 1.5), C(60, 60, 66), M.Metal, "TailStrut")
  wheel(b, root, -1.6, 0.9, -L * 0.15, 0.9, 0.5, nil, "L", d) wheel(b, root, 1.6, 0.9, -L * 0.15, 0.9, 0.5, nil, "R", d) wheel(b, root, 0, 0.6, L / 2 - 1.5, 0.6, 0.4, nil, nil, d)
  a.__seat = at(0, by + r + 0.6, -L * 0.2)
  return root, "hover", 3
end
function V.helicopter(b, a)
  local L = num(a.length, 16, 8, 50)
  local col = rgb(a.color, C(50, 60, 80))
  local by = 2.2
  local root = box(b, 4.4, 3.4, L * 0.45, at(0, by + 1.7, -L * 0.2), col, M.SmoothPlastic, "Fuselage")
  glass(b, 4.2, 2.6, 1.2, at(0, by + 1.9, -L * 0.2 - L * 0.225), C(140, 190, 220), "Canopy")
  cylZ(b, 0.8, L * 0.55, at(0, by + 2.4, L * 0.25), col, M.SmoothPlastic, "TailBoom")
  box(b, 0.3, 3, 2, at(0, by + 4.2, L / 2 - 0.6), col, M.SmoothPlastic, "TailFin")
  for _, sx in ipairs({ -1, 1 }) do
    cylZ(b, 0.25, L * 0.5, at(sx * 1.8, 0.25, -L * 0.2), C(60, 60, 66), M.Metal, "Skid")
    box(b, 0.25, by, 0.25, at(sx * 1.8, by / 2, -L * 0.3), C(60, 60, 66), M.Metal, "SkidStrut") box(b, 0.25, by, 0.25, at(sx * 1.8, by / 2, -L * 0.1), C(60, 60, 66), M.Metal, "SkidStrut")
  end
  local mastY = by + 3.4 + 0.6
  cylY(b, 0.35, 1.2, at(0, mastY, -L * 0.2), C(60, 60, 66), M.Metal, "Mast")
  local hub = cylY(b, 0.7, 0.5, at(0, mastY + 0.8, -L * 0.2), C(40, 40, 45), M.Metal, "RotorHub")
  local rl = num(a.rotor_length, L * 0.55, 4, 60)
  local blades = {}
  for i = 0, 3 do blades[#blades + 1] = box(b, 0.7, 0.12, rl, at(0, mastY + 0.9, -L * 0.2) * CFrame.Angles(0, i * PI / 2, 0) * at(0, 0, -rl / 2), C(70, 70, 76), M.Metal, "RotorBlade", { CanCollide = false }) end
  local tail = cylX(b, 0.3, 0.5, at(0.9, by + 4.5, L / 2 - 0.6), C(40, 40, 45), M.Metal, "TailRotorHub")
  local tb = { box(b, 0.12, 3.2, 0.4, at(1.0, by + 4.5, L / 2 - 0.6), C(70, 70, 76), M.Metal, "TailBlade", { CanCollide = false }), box(b, 0.12, 0.4, 3.2, at(1.0, by + 4.5, L / 2 - 0.6), C(70, 70, 76), M.Metal, "TailBlade", { CanCollide = false }) }
  if a.spin_rotor ~= false then
    hub.Anchored = false for _, p in ipairs(blades) do p.Anchored = false weld(hub, p) end
    motor(root, hub, root.CFrame:ToObjectSpace(hub.CFrame), CFrame.new(), "RotorMotor", 8, 1e5)
    tail.Anchored = false for _, p in ipairs(tb) do p.Anchored = false weld(tail, p) end
    motor(root, tail, root.CFrame:ToObjectSpace(tail.CFrame), CFrame.new(), "TailRotorMotor", 20, 1e4)
  end
  a.__seat = at(-1, by + 0.5, -L * 0.32)
  return root, "hover", 0
end
MK.V = V

-- weapons --------------------------------------------------------------------------------
local W = {}
MK.WSTYLES = {
  steel = { blade = C(200, 204, 212), bladeMat = "Metal", guard = C(120, 122, 130), guardMat = "Metal", grip = C(60, 40, 30), gripMat = "Leather", pommel = C(160, 150, 90), wood = C(120, 85, 50), accent = C(60, 120, 200) },
  iron = { blade = C(120, 122, 128), bladeMat = "CorrodedMetal", guard = C(70, 70, 76), guardMat = "Metal", grip = C(50, 35, 25), gripMat = "Leather", pommel = C(80, 80, 86), wood = C(100, 70, 45), accent = C(140, 40, 40) },
  gold = { blade = C(230, 200, 90), bladeMat = "Metal", guard = C(212, 175, 55), guardMat = "Metal", grip = C(120, 20, 30), gripMat = "Fabric", pommel = C(230, 200, 90), wood = C(140, 100, 60), accent = C(200, 40, 60) },
  dark = { blade = C(40, 40, 48), bladeMat = "Metal", guard = C(30, 30, 36), guardMat = "Metal", grip = C(25, 25, 28), gripMat = "Leather", pommel = C(120, 20, 30), wood = C(50, 40, 40), accent = C(170, 30, 50) },
  crystal = { blade = C(120, 230, 255), bladeMat = "Neon", guard = C(190, 200, 230), guardMat = "Glass", grip = C(60, 70, 110), gripMat = "Leather", pommel = C(120, 230, 255), wood = C(150, 160, 200), accent = C(120, 230, 255) },
  wooden = { blade = C(150, 110, 70), bladeMat = "Wood", guard = C(120, 85, 50), guardMat = "Wood", grip = C(90, 60, 40), gripMat = "Wood", pommel = C(120, 85, 50), wood = C(140, 100, 60), accent = C(100, 70, 45) },
  scifi = { blade = C(34, 211, 238), bladeMat = "Neon", guard = C(60, 64, 74), guardMat = "Metal", grip = C(40, 42, 50), gripMat = "Metal", pommel = C(34, 211, 238), wood = C(60, 64, 74), accent = C(34, 211, 238) },
}
local function wstyle(a)
  local s = MK.WSTYLES[key(a.style, "steel")] or MK.WSTYLES.steel
  local S = {} for k, v in pairs(s) do S[k] = v end
  for k, v in pairs(S) do if type(v) == "string" then S[k] = matOf(v, M.Metal) end end
  S.blade = rgb(a.color, S.blade) S.grip = rgb(a.color2, S.grip) S.accent = rgb(a.accent, S.accent)
  return S
end
-- all weapons: grip centre at origin, business end along +Y (melee) or -Z (ranged)
local function swordLike(b, a, S, bladeLen, bladeW, gripLen, guardW, tipLen)
  local thick = 0.25
  local handle = cylY(b, 0.28, gripLen, at(0, 0, 0), S.grip, S.gripMat, "Handle")
  ball(b, 0.42, at(0, -gripLen / 2 - 0.3, 0), S.pommel, S.guardMat, "Pommel", { CanCollide = false })
  box(b, guardW, 0.4, 0.6, at(0, gripLen / 2 + 0.2, 0), S.guard, S.guardMat, "Crossguard", { CanCollide = false })
  local blade = box(b, bladeW, bladeLen, thick, at(0, gripLen / 2 + 0.4 + bladeLen / 2, 0), S.blade, S.bladeMat, "Blade", { CanCollide = false })
  box(b, bladeW * 0.3, bladeLen * 0.8, thick + 0.08, at(0, gripLen / 2 + 0.4 + bladeLen / 2, 0), shade(S.blade, 0.8), S.bladeMat, "Fuller", { CanCollide = false })
  local tipY = gripLen / 2 + 0.4 + bladeLen
  wedge(b, thick, tipLen, bladeW, at(0, tipY + tipLen / 2, 0) * CFrame.Angles(0, PI / 2, 0) * CFrame.Angles(0, 0, 0), S.blade, S.bladeMat, "BladeTip", { CanCollide = false })
  attach(handle, "BladeStart", CFrame.new(0, gripLen / 2 + 0.4, 0))
  attach(handle, "Tip", CFrame.new(0, tipY + tipLen, 0))
  return handle, blade, tipY + tipLen
end
function W.sword(b, a, S) local h, _, tip = swordLike(b, a, S, num(a.length, 4.2, 2, 10), 0.7, 1.6, 2.2, 0.8) return h, tip end
function W.greatsword(b, a, S) local h, _, tip = swordLike(b, a, S, num(a.length, 6.5, 3, 14), 1.0, 2.6, 3.2, 1.2) return h, tip end
function W.dagger(b, a, S) local h, _, tip = swordLike(b, a, S, num(a.length, 1.8, 1, 4), 0.5, 1.1, 1.2, 0.6) return h, tip end
function W.katana(b, a, S)
  local len = num(a.length, 4.4, 2, 10) local gripLen = 2
  local handle = cylY(b, 0.26, gripLen, at(0, 0, 0), S.grip, S.gripMat, "Handle")
  for i = 1, 5 do box(b, 0.6, 0.12, 0.6, at(0, -gripLen / 2 + i * gripLen / 6, 0) * CFrame.Angles(0, i * 0.4, 0), shade(S.grip, 0.6), M.Fabric, "Wrap", { CanCollide = false }) end
  cylY(b, 0.6, 0.15, at(0, gripLen / 2 + 0.08, 0), S.guard, S.guardMat, "Tsuba", { CanCollide = false })
  local segs = 4
  for i = 1, segs do
    local f = (i - 0.5) / segs
    local curve = math.rad(3) * i
    box(b, 0.55, len / segs + 0.05, 0.18, at(-0.05 * i * i * 0.5, gripLen / 2 + 0.15 + f * len, 0) * CFrame.Angles(0, 0, curve), S.blade, S.bladeMat, "Blade", { CanCollide = false })
  end
  wedge(b, 0.18, 0.7, 0.55, at(-0.05 * segs * segs * 0.5 - 0.1, gripLen / 2 + 0.15 + len + 0.35, 0) * CFrame.Angles(0, PI / 2, 0), S.blade, S.bladeMat, "BladeTip", { CanCollide = false })
  attach(handle, "BladeStart", CFrame.new(0, gripLen / 2 + 0.15, 0)) attach(handle, "Tip", CFrame.new(-0.4, gripLen / 2 + 0.15 + len + 0.7, 0))
  return handle, gripLen / 2 + len + 0.85
end
local function haft(b, a, S, len, r) local h = cylY(b, r or 0.22, len, at(0, 0, 0), S.wood, M.Wood, "Handle") return h end
function W.axe(b, a, S)
  local len = num(a.length, 3.6, 2, 8)
  local h = haft(b, a, S, len)
  local headY = len / 2 - 0.5
  box(b, 0.5, 1.2, 0.5, at(0, headY, 0), S.guard, S.guardMat, "AxeEye", { CanCollide = false })
  box(b, 1.2, 1.4, 0.25, at(0.8, headY, 0), S.blade, S.bladeMat, "AxeHead", { CanCollide = false })
  box(b, 0.5, 2.0, 0.15, at(1.6, headY, 0), shade(S.blade, 1.1), S.bladeMat, "AxeEdge", { CanCollide = false })
  attach(h, "Tip", CFrame.new(2.2, headY, 0)) attach(h, "BladeStart", CFrame.new(0.3, headY, 0))
  return h, len / 2 + 0.3
end
function W.battleaxe(b, a, S)
  local len = num(a.length, 5, 3, 10)
  local h = haft(b, a, S, len, 0.26)
  local headY = len / 2 - 0.8
  box(b, 0.6, 1.8, 0.6, at(0, headY, 0), S.guard, S.guardMat, "AxeEye", { CanCollide = false })
  for _, sx in ipairs({ -1, 1 }) do
    box(b, 1.4, 2.2, 0.25, at(sx * 1.0, headY, 0), S.blade, S.bladeMat, "AxeHead", { CanCollide = false })
    box(b, 0.5, 3.0, 0.15, at(sx * 1.9, headY, 0), shade(S.blade, 1.1), S.bladeMat, "AxeEdge", { CanCollide = false })
  end
  cylY(b, 0.12, 1.4, at(0, len / 2 + 0.7, 0), S.blade, S.bladeMat, "Spike", { CanCollide = false })
  attach(h, "Tip", CFrame.new(2.8, headY, 0)) attach(h, "BladeStart", CFrame.new(-2.8, headY, 0))
  return h, len / 2 + 1.4
end
function W.mace(b, a, S)
  local len = num(a.length, 3.4, 2, 8)
  local h = haft(b, a, S, len, 0.2)
  local head = ball(b, 0.8, at(0, len / 2 + 0.5, 0), S.blade, S.bladeMat, "MaceHead", { CanCollide = false })
  for i = 0, 7 do local ang = i * PI / 4 box(b, 0.3, 0.9, 0.3, at(0, len / 2 + 0.5, 0) * CFrame.Angles(ang, 0, 0) * at(0, 0.9, 0), S.blade, S.bladeMat, "Flange", { CanCollide = false }) end
  box(b, 0.3, 0.9, 0.3, at(0, len / 2 + 0.5, 0) * CFrame.Angles(0, 0, PI / 2) * at(0, 0.9, 0), S.blade, S.bladeMat, "Flange", { CanCollide = false })
  box(b, 0.3, 0.9, 0.3, at(0, len / 2 + 0.5, 0) * CFrame.Angles(0, 0, -PI / 2) * at(0, 0.9, 0), S.blade, S.bladeMat, "Flange", { CanCollide = false })
  attach(h, "Tip", CFrame.new(0, len / 2 + 1.4, 0)) attach(h, "BladeStart", CFrame.new(0, len / 2, 0))
  return h, len / 2 + 1.4
end
function W.hammer(b, a, S)
  local len = num(a.length, 4.2, 2, 10)
  local h = haft(b, a, S, len, 0.26)
  local headY = len / 2 - 0.4
  box(b, 2.6, 1.4, 1.4, at(0, headY, 0), S.blade, S.bladeMat, "HammerHead", { CanCollide = false })
  box(b, 0.5, 1.6, 1.6, at(1.2, headY, 0), shade(S.blade, 0.8), S.bladeMat, "Face", { CanCollide = false })
  box(b, 0.5, 1.6, 1.6, at(-1.2, headY, 0), shade(S.blade, 0.8), S.bladeMat, "Face", { CanCollide = false })
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.4, 0.4, 1.5, at(sx * 1.45, headY, 0), S.accent, S.guardMat, "Band", { CanCollide = false }) end
  attach(h, "Tip", CFrame.new(1.5, headY, 0)) attach(h, "BladeStart", CFrame.new(-1.5, headY, 0))
  return h, len / 2 + 0.3
end
function W.spear(b, a, S)
  local len = num(a.length, 7, 3, 16)
  local h = haft(b, a, S, len, 0.18)
  box(b, 0.5, 1.6, 0.16, at(0, len / 2 + 0.7, 0), S.blade, S.bladeMat, "SpearBlade", { CanCollide = false })
  wedge(b, 0.16, 1.0, 0.5, at(0, len / 2 + 1.5 + 0.5, 0) * CFrame.Angles(0, PI / 2, 0), S.blade, S.bladeMat, "SpearTip", { CanCollide = false })
  cylY(b, 0.24, 0.6, at(0, len / 2 - 0.1, 0), S.guard, S.guardMat, "Socket", { CanCollide = false })
  for i = 1, 3 do box(b, 0.5, 0.1, 0.5, at(0, len / 2 - 0.6 - i * 0.25, 0), S.accent, M.Fabric, "Binding", { CanCollide = false }) end
  attach(h, "Tip", CFrame.new(0, len / 2 + 2.5, 0)) attach(h, "BladeStart", CFrame.new(0, len / 2, 0))
  return h, len / 2 + 2.5
end
function W.staff(b, a, S)
  local len = num(a.length, 6.5, 3, 14)
  local h = haft(b, a, S, len, 0.22)
  local orb = ball(b, 0.6, at(0, len / 2 + 0.7, 0), S.accent, M.Neon, "Orb", { CanCollide = false })
  light(orb, "PointLight", S.accent, 1.2, 10)
  for i = 0, 2 do local ang = i * TAU / 3 box(b, 0.18, 1.4, 0.18, at(0, len / 2 + 0.3, 0) * CFrame.Angles(0, ang, 0) * at(0.55, 0, 0) * CFrame.Angles(0, 0, math.rad(-12)), S.guard, S.guardMat, "Claw", { CanCollide = false }) end
  cylY(b, 0.3, 0.5, at(0, -len / 2 + 0.2, 0), S.guard, S.guardMat, "Ferrule", { CanCollide = false })
  attach(h, "Tip", CFrame.new(0, len / 2 + 1.3, 0)) attach(h, "BladeStart", CFrame.new(0, len / 2, 0))
  return h, len / 2 + 1.3
end
function W.wand(b, a, S)
  local len = num(a.length, 1.6, 0.8, 4)
  local h = cylY(b, 0.11, len, at(0, 0, 0), S.wood, M.Wood, "Handle")
  cylY(b, 0.16, len * 0.3, at(0, -len / 2 + len * 0.15, 0), S.guard, S.guardMat, "WandGrip", { CanCollide = false })
  local tip = ball(b, 0.16, at(0, len / 2 + 0.1, 0), S.accent, M.Neon, "WandTip", { CanCollide = false })
  light(tip, "PointLight", S.accent, 0.8, 6)
  attach(h, "Tip", CFrame.new(0, len / 2 + 0.2, 0)) attach(h, "BladeStart", CFrame.new(0, 0, 0))
  return h, len / 2 + 0.2
end
function W.shield(b, a, S)
  local hgt = num(a.length or a.height, 3.6, 1.5, 8) local wid = num(a.width, 2.6, 1, 6)
  local h = box(b, 1.0, 0.3, 0.3, at(0, 0, 0.45), S.grip, S.gripMat, "Handle")
  local face = box(b, wid, hgt * 0.7, 0.3, at(0, hgt * 0.15, 0), S.blade, S.bladeMat, "ShieldFace", { CanCollide = false })
  wedge(b, 0.3, hgt * 0.3, wid / 2, at(wid / 4, -hgt * 0.35, 0) * CFrame.Angles(0, 0, PI) * CFrame.Angles(0, PI / 2, 0), S.blade, S.bladeMat, "ShieldPoint", { CanCollide = false })
  wedge(b, 0.3, hgt * 0.3, wid / 2, at(-wid / 4, -hgt * 0.35, 0) * CFrame.Angles(0, 0, PI) * CFrame.Angles(0, -PI / 2, 0), S.blade, S.bladeMat, "ShieldPoint", { CanCollide = false })
  box(b, wid + 0.2, 0.3, 0.35, at(0, hgt * 0.5, 0), S.guard, S.guardMat, "Rim", { CanCollide = false })
  box(b, 0.3, hgt * 0.7, 0.35, at(-wid / 2, hgt * 0.15, 0), S.guard, S.guardMat, "Rim", { CanCollide = false }) box(b, 0.3, hgt * 0.7, 0.35, at(wid / 2, hgt * 0.15, 0), S.guard, S.guardMat, "Rim", { CanCollide = false })
  ball(b, 0.5, at(0, hgt * 0.1, -0.2), S.accent, S.guardMat, "Boss", { CanCollide = false })
  if a.emblem ~= false then box(b, wid * 0.25, hgt * 0.4, 0.05, at(0, hgt * 0.1, -0.18), S.accent, M.SmoothPlastic, "Emblem", { CanCollide = false }) box(b, wid * 0.6, hgt * 0.12, 0.05, at(0, hgt * 0.15, -0.18), S.accent, M.SmoothPlastic, "Emblem", { CanCollide = false }) end
  attach(h, "Tip", CFrame.new(0, -hgt * 0.5, 0)) attach(h, "BladeStart", CFrame.new(0, hgt * 0.5, 0))
  return h, hgt / 2
end
function W.bow(b, a, S)
  local len = num(a.length, 4.4, 2, 9)
  local h = cylY(b, 0.18, 1.2, at(0, 0, 0), S.grip, S.gripMat, "Handle")
  local segs = 4
  for _, sy in ipairs({ -1, 1 }) do
    for i = 1, segs do
      local f = (i - 0.5) / segs
      local y = sy * (0.6 + f * (len / 2 - 0.6))
      local bend = sy * f * f * 0.9
      box(b, 0.22, (len / 2 - 0.6) / segs + 0.05, 0.3, at(0, y, 0.25 + bend) * CFrame.Angles(sy * f * 0.5, 0, 0), S.wood, M.Wood, "Limb", { CanCollide = false })
    end
  end
  cylY(b, 0.03, len - 0.3, at(0, 0, 0.25 + 0.9 + 0.15), C(230, 225, 210), M.Fabric, "String", { CanCollide = false })
  attach(h, "Tip", CFrame.new(0, len / 2, 0.5)) attach(h, "BladeStart", CFrame.new(0, -len / 2, 0.5)) attach(h, "Muzzle", CFrame.new(0, 0, -0.5))
  return h, len / 2
end
local function gunBase(b, a, S, bodyL, bodyH, barrelLen, barrelR, stock)
  local h = box(b, 0.5, 1.2, 0.6, at(0, -0.6, 0.25) * CFrame.Angles(math.rad(15), 0, 0), S.grip, S.gripMat, "Handle")
  box(b, 0.6, bodyH, bodyL, at(0, 0.2, -bodyL / 2 + 0.4), S.guard, S.guardMat, "Receiver", { CanCollide = false })
  local barrel = cylZ(b, barrelR, barrelLen, at(0, 0.25, -bodyL + 0.4 - barrelLen / 2), S.blade, S.bladeMat, "Barrel", { CanCollide = false })
  box(b, 0.5, 0.2, 0.5, at(0, 0.6, -bodyL / 2 + 0.4), S.accent, S.guardMat, "Sight", { CanCollide = false })
  box(b, 0.5, 0.5, 0.4, at(0, -0.3, -0.1), S.guard, S.guardMat, "TriggerGuard", { CanCollide = false })
  if stock then box(b, 0.6, 1.0, stock, at(0, -0.1, 0.4 + stock / 2) * CFrame.Angles(math.rad(-6), 0, 0), S.wood, (S.gripMat == M.Metal) and M.Metal or M.Wood, "Stock", { CanCollide = false }) end
  attach(h, "Muzzle", CFrame.new(0, 0.25, -bodyL + 0.4 - barrelLen)) attach(h, "Tip", CFrame.new(0, 0.25, -bodyL + 0.4 - barrelLen))
  return h, bodyL + barrelLen
end
function W.pistol(b, a, S) return gunBase(b, a, S, 1.6, 0.6, 0.8, 0.14, nil) end
function W.rifle(b, a, S) local h, l = gunBase(b, a, S, 2.6, 0.7, 2.6, 0.14, 1.6) box(b, 0.4, 0.9, 0.5, at(0, -0.5, -1.0), S.guard, S.guardMat, "Magazine", { CanCollide = false }) return h, l end
function W.shotgun(b, a, S) local h, l = gunBase(b, a, S, 2.2, 0.8, 3.0, 0.16, 1.8) cylZ(b, 0.16, 3.0, at(0.32, 0.25, -2.2 + 0.4 - 1.5), S.blade, S.bladeMat, "Barrel2", { CanCollide = false }) cylZ(b, 0.22, 1.2, at(0, -0.1, -2.6), S.wood, M.Wood, "Pump", { CanCollide = false }) return h, l end
function W.sniper(b, a, S) local h, l = gunBase(b, a, S, 2.8, 0.7, 3.6, 0.12, 2.0) cylZ(b, 0.22, 1.6, at(0, 0.85, -1.2), S.guard, S.guardMat, "Scope", { CanCollide = false }) box(b, 0.2, 0.3, 0.2, at(0, 0.6, -0.8), S.guard, S.guardMat, "ScopeMount", { CanCollide = false }) box(b, 0.2, 0.3, 0.2, at(0, 0.6, -1.6), S.guard, S.guardMat, "ScopeMount", { CanCollide = false }) for _, sx in ipairs({ -1, 1 }) do box(b, 0.1, 1.2, 0.1, at(sx * 0.3, -0.5, -4.5) * CFrame.Angles(0, 0, sx * 0.3), S.guard, S.guardMat, "Bipod", { CanCollide = false }) end return h, l end
function W.crossbow(b, a, S)
  local h, l = gunBase(b, a, S, 2.4, 0.6, 0.6, 0.1, 1.4)
  for _, sx in ipairs({ -1, 1 }) do
    for i = 1, 3 do local f = (i - 0.5) / 3 box(b, 0.9, 0.25, 0.2, at(sx * (0.45 + f * 1.4), 0.3, -1.8 + f * f * 0.5) * CFrame.Angles(0, -sx * f * 0.5, 0), S.wood, M.Wood, "Limb", { CanCollide = false }) end
  end
  box(b, 4.2, 0.04, 0.04, at(0, 0.3, -1.2), C(230, 225, 210), M.Fabric, "String", { CanCollide = false })
  box(b, 0.12, 0.12, 2.2, at(0, 0.45, -1.4), S.wood, M.Wood, "Bolt", { CanCollide = false })
  return h, l
end
function W.bat(b, a, S)
  local len = num(a.length, 3.4, 2, 6)
  local h = cylY(b, 0.16, len * 0.35, at(0, -len * 0.3, 0), S.grip, S.gripMat, "Handle")
  cylY(b, 0.22, len * 0.3, at(0, 0, 0), S.wood, M.Wood, "Taper", { CanCollide = false })
  cylY(b, 0.34, len * 0.45, at(0, len * 0.3, 0), S.wood, M.Wood, "Barrel", { CanCollide = false })
  cylY(b, 0.24, 0.12, at(0, -len * 0.48, 0), S.guard, S.guardMat, "Knob", { CanCollide = false })
  attach(h, "Tip", CFrame.new(0, len * 0.55, 0)) attach(h, "BladeStart", CFrame.new(0, 0, 0))
  return h, len / 2
end
function W.pickaxe(b, a, S)
  local len = num(a.length, 3.6, 2, 8)
  local h = haft(b, a, S, len, 0.2)
  local headY = len / 2 - 0.3
  box(b, 0.6, 0.6, 0.6, at(0, headY, 0), S.guard, S.guardMat, "PickEye", { CanCollide = false })
  for _, sx in ipairs({ -1, 1 }) do
    box(b, 1.6, 0.45, 0.4, at(sx * 1.0, headY + 0.1, 0) * CFrame.Angles(0, 0, -sx * 0.15), S.blade, S.bladeMat, "PickArm", { CanCollide = false })
    wedge(b, 0.4, 0.8, 0.45, at(sx * 2.1, headY - 0.1, 0) * CFrame.Angles(0, 0, -sx * PI / 2 - sx * 0.15) * CFrame.Angles(0, PI / 2, 0), S.blade, S.bladeMat, "PickPoint", { CanCollide = false })
  end
  attach(h, "Tip", CFrame.new(2.5, headY, 0)) attach(h, "BladeStart", CFrame.new(-2.5, headY, 0))
  return h, len / 2 + 0.3
end
MK.W = W

-- furniture ---------------------------------------------------------------------------------
local F = {}
MK.FSTYLES = {
  modern = { body = C(235, 235, 232), bodyMat = "SmoothPlastic", frame = C(50, 52, 58), frameMat = "Metal", cushion = C(90, 100, 120), cushionMat = "Fabric", accent = C(34, 211, 238), wood = C(150, 120, 90), woodMat = "Wood" },
  rustic = { body = C(140, 100, 62), bodyMat = "Wood", frame = C(100, 70, 45), frameMat = "Wood", cushion = C(150, 60, 50), cushionMat = "Fabric", accent = C(70, 70, 76), wood = C(140, 100, 62), woodMat = "Wood" },
  royal = { body = C(120, 20, 40), bodyMat = "Fabric", frame = C(212, 175, 55), frameMat = "Metal", cushion = C(130, 25, 45), cushionMat = "Fabric", accent = C(212, 175, 55), wood = C(80, 50, 35), woodMat = "Wood" },
  scifi = { body = C(60, 64, 74), bodyMat = "Metal", frame = C(40, 42, 50), frameMat = "Metal", cushion = C(70, 74, 90), cushionMat = "SmoothPlastic", accent = C(34, 211, 238), wood = C(60, 64, 74), woodMat = "Metal" },
  cozy = { body = C(200, 170, 130), bodyMat = "Fabric", frame = C(120, 85, 50), frameMat = "Wood", cushion = C(190, 120, 90), cushionMat = "Fabric", accent = C(220, 190, 120), wood = C(140, 100, 62), woodMat = "Wood" },
}
local function fstyle(a)
  local s = MK.FSTYLES[key(a.style, "modern")] or MK.FSTYLES.modern
  local S = {} for k, v in pairs(s) do S[k] = v end
  for k, v in pairs(S) do if type(v) == "string" then S[k] = matOf(v, M.SmoothPlastic) end end
  S.body = rgb(a.color, S.body) S.cushion = rgb(a.color2, S.cushion) S.accent = rgb(a.accent, S.accent)
  if a.material then S.bodyMat = matOf(a.material, S.bodyMat) end
  return S
end
local function legs4(b, w, d, h, r, col, mat, inset) inset = inset or 0.4 for _, sx in ipairs({ -1, 1 }) do for _, sz in ipairs({ -1, 1 }) do box(b, r, h, r, at(sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset)), col, mat, "Leg") end end end
function F.sofa(b, a, S)
  local w, d = num(a.width, 7, 3, 20), num(a.depth, 3.2, 2, 6)
  local root = box(b, w, 1.2, d, at(0, 1.0, 0), S.body, S.bodyMat, "Base")
  box(b, w, 1.6, 0.8, at(0, 2.4, d / 2 - 0.4), S.body, S.bodyMat, "Back")
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.7, 1.0, d, at(sx * (w / 2 - 0.35), 2.1, 0), S.body, S.bodyMat, "Arm") end
  local n = math.max(1, math.floor(w / 2.4))
  for i = 1, n do seatBox(b, (w - 1.4) / n - 0.1, 0.5, d - 1.0, at(-(w - 1.4) / 2 + (i - 0.5) * ((w - 1.4) / n), 1.85, -0.3), S.cushion, S.cushionMat, "Seat") box(b, (w - 1.4) / n - 0.1, 1.2, 0.5, at(-(w - 1.4) / 2 + (i - 0.5) * ((w - 1.4) / n), 2.5, d / 2 - 1.0), S.cushion, S.cushionMat, "BackCushion") end
  legs4(b, w, d, 0.4, 0.3, S.frame, S.frameMat)
  return root
end
function F.armchair(b, a, S) a.width = num(a.width, 3.2, 2, 6) a.depth = num(a.depth, 3.2, 2, 6) return F.sofa(b, a, S) end
function F.desk(b, a, S)
  local w, d, h = num(a.width, 6, 3, 14), num(a.depth, 3, 1.5, 6), num(a.height, 3, 2, 5)
  local root = box(b, w, 0.25, d, at(0, h - 0.125, 0), S.wood, S.woodMat, "Top")
  box(b, w * 0.35, h - 0.3, d - 0.2, at(w / 2 - w * 0.175, (h - 0.3) / 2, 0), S.body, S.bodyMat, "Pedestal")
  for i = 1, 3 do box(b, w * 0.35 - 0.2, (h - 0.6) / 3 - 0.1, 0.1, at(w / 2 - w * 0.175, 0.3 + (i - 0.5) * (h - 0.6) / 3, -d / 2 + 0.02), shade(S.body, 0.9), S.bodyMat, "Drawer") box(b, 0.8, 0.12, 0.15, at(w / 2 - w * 0.175, 0.3 + (i - 0.5) * (h - 0.6) / 3, -d / 2 - 0.08), S.accent, S.frameMat, "Knob", { CanCollide = false }) end
  box(b, 0.3, h - 0.3, 0.3, at(-w / 2 + 0.3, (h - 0.3) / 2, -d / 2 + 0.3), S.frame, S.frameMat, "Leg") box(b, 0.3, h - 0.3, 0.3, at(-w / 2 + 0.3, (h - 0.3) / 2, d / 2 - 0.3), S.frame, S.frameMat, "Leg")
  box(b, w - 0.4, 0.8, 0.15, at(0, h - 0.8, d / 2 - 0.1), S.body, S.bodyMat, "Modesty")
  if a.monitor ~= false then box(b, 2.4, 1.5, 0.12, at(0.4, h + 1.2, 0.6), C(25, 25, 28), M.SmoothPlastic, "Monitor", { CanCollide = false }) box(b, 2.2, 1.3, 0.02, at(0.4, h + 1.2, 0.52), S.accent, M.Neon, "Screen", { CanCollide = false }) box(b, 0.4, 0.5, 0.4, at(0.4, h + 0.25, 0.7), C(50, 50, 56), M.Metal, "Stand", { CanCollide = false }) box(b, 1.8, 0.1, 0.7, at(0.2, h + 0.05, -0.4), C(40, 40, 46), M.SmoothPlastic, "Keyboard", { CanCollide = false }) end
  return root
end
function F.wardrobe(b, a, S)
  local w, d, h = num(a.width, 4.5, 2, 10), num(a.depth, 2, 1, 4), num(a.height, 7, 4, 12)
  local root = box(b, w, h, d, at(0, h / 2, 0), S.body, S.bodyMat, "Body")
  for _, sx in ipairs({ -1, 1 }) do box(b, w / 2 - 0.15, h - 0.5, 0.1, at(sx * (w / 4), h / 2, -d / 2 - 0.05), shade(S.body, 0.92), S.bodyMat, "Door") box(b, 0.15, 0.6, 0.15, at(sx * 0.3, h / 2, -d / 2 - 0.15), S.accent, S.frameMat, "Handle", { CanCollide = false }) end
  box(b, w + 0.2, 0.3, d + 0.2, at(0, h + 0.15, 0), S.frame, S.frameMat, "Cornice")
  box(b, w + 0.1, 0.4, d + 0.1, at(0, 0.2, 0), S.frame, S.frameMat, "Plinth")
  return root
end
function F.shelf(b, a, S)
  local w, d, h = num(a.width, 4, 2, 12), num(a.depth, 1.2, 0.6, 3), num(a.height, 6, 2, 14)
  local n = math.floor(num(a.shelves, math.max(2, math.floor(h / 1.6)), 1, 12))
  local root = box(b, w, 0.25, d, at(0, 0.125, 0), S.wood, S.woodMat, "Bottom")
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.25, h, d, at(sx * (w / 2 - 0.125), h / 2, 0), S.frame, S.frameMat, "Side") end
  box(b, w, h, 0.15, at(0, h / 2, d / 2 - 0.075), shade(S.body, 0.9), S.bodyMat, "Back")
  for i = 1, n do box(b, w - 0.5, 0.2, d - 0.2, at(0, i * (h / (n + 0.2)), -0.05), S.wood, S.woodMat, "Shelf") end
  if a.items ~= false then
    local R = rnd(a.seed or 5)
    for i = 1, n do
      local shelfTop = (i - 1) * (h / (n + 0.2)) + (i == 1 and 0.25 or 0.1)
      for k = 1, 3 do
        if R() > 0.3 then
          local ih = R(0.6, 1.1)
          box(b, R(0.3, 0.8), ih, d - 0.5, at(-w / 2 + 0.6 + k * (w - 1) / 4 + R(-0.2, 0.2), shelfTop + ih / 2, 0), Color3.fromHSV(R(), 0.5, 0.8), M.SmoothPlastic, "Item", { CanCollide = false })
        end
      end
    end
  end
  return root
end
function F.stool(b, a, S)
  local h = num(a.height, 2, 1, 4) local r = num(a.width, 1.4, 0.8, 3) / 2
  local root = cylY(b, r, 0.3, at(0, h - 0.15, 0), S.cushion, S.cushionMat, "Cushion")
  seatBox(b, r * 1.4, 0.2, r * 1.4, at(0, h + 0.1, 0), S.cushion, S.cushionMat, "Seat", { Transparency = 1 })
  for i = 0, 2 do local ang = i * TAU / 3 box(b, 0.25, h - 0.3, 0.25, CFrame.Angles(0, ang, 0) * at(r * 0.7, (h - 0.3) / 2, 0) * CFrame.Angles(0, 0, math.rad(-8)), S.frame, S.frameMat, "Leg") end
  return root
end
function F.bar_stool(b, a, S)
  local h = num(a.height, 3.4, 2, 5) local r = num(a.width, 1.4, 0.8, 3) / 2
  local root = cylY(b, r, 0.35, at(0, h - 0.17, 0), S.cushion, S.cushionMat, "Cushion")
  seatBox(b, r * 1.4, 0.2, r * 1.4, at(0, h + 0.1, 0), S.cushion, S.cushionMat, "Seat", { Transparency = 1 })
  cylY(b, 0.15, h - 0.4, at(0, (h - 0.4) / 2, 0), S.frame, S.frameMat, "Column")
  cylY(b, r * 1.1, 0.15, at(0, 0.08, 0), S.frame, S.frameMat, "Base")
  cylY(b, r * 0.9, 0.08, at(0, h * 0.35, 0), S.frame, S.frameMat, "Footrest", { CanCollide = false })
  box(b, r * 2, 1.2, 0.3, at(0, h + 0.6, r - 0.15), S.cushion, S.cushionMat, "Back")
  return root
end
function F.counter(b, a, S)
  local w, d, h = num(a.width, 8, 3, 30), num(a.depth, 2.4, 1.5, 5), num(a.height, 3.2, 2, 5)
  local root = box(b, w, h - 0.3, d, at(0, (h - 0.3) / 2, 0), S.body, S.bodyMat, "Cabinet")
  box(b, w + 0.3, 0.3, d + 0.3, at(0, h - 0.15, 0), S.wood, M.Marble, "Countertop")
  local n = math.max(1, math.floor(w / 2))
  for i = 1, n do box(b, w / n - 0.15, h - 0.8, 0.08, at(-w / 2 + (i - 0.5) * (w / n), (h - 0.8) / 2 + 0.25, -d / 2 - 0.04), shade(S.body, 0.92), S.bodyMat, "CabinetDoor") box(b, 0.12, 0.6, 0.12, at(-w / 2 + (i - 0.5) * (w / n) + 0.5, h / 2 + 0.5, -d / 2 - 0.14), S.accent, S.frameMat, "Handle", { CanCollide = false }) end
  box(b, w, 0.3, d - 0.2, at(0, 0.15, 0.1), S.frame, S.frameMat, "Kickboard")
  if a.sink then box(b, 2.2, 0.6, 1.6, at(0, h - 0.3, 0), C(200, 205, 210), M.Metal, "Basin") cylY(b, 0.08, 1, at(0, h + 0.5, 0.6), C(200, 205, 210), M.Metal, "Tap", { CanCollide = false }) end
  return root
end
function F.fridge(b, a, S)
  local w, d, h = num(a.width, 3, 2, 6), num(a.depth, 2.6, 1.5, 5), num(a.height, 6.5, 4, 10)
  local root = box(b, w, h, d, at(0, h / 2, 0), rgb(a.color, C(220, 222, 226)), matOf(a.material, M.Metal), "Body")
  box(b, w - 0.1, h * 0.62, 0.1, at(0, h * 0.31 + 0.1, -d / 2 - 0.05), rgb(a.color, C(230, 232, 236)), M.Metal, "Door") box(b, w - 0.1, h * 0.33, 0.1, at(0, h - h * 0.165 - 0.05, -d / 2 - 0.05), rgb(a.color, C(230, 232, 236)), M.Metal, "FreezerDoor")
  box(b, 0.15, h * 0.4, 0.2, at(-w / 2 + 0.4, h * 0.45, -d / 2 - 0.2), C(80, 82, 90), M.Metal, "Handle", { CanCollide = false }) box(b, 0.15, h * 0.2, 0.2, at(-w / 2 + 0.4, h - h * 0.17, -d / 2 - 0.2), C(80, 82, 90), M.Metal, "Handle", { CanCollide = false })
  return root
end
function F.oven(b, a, S)
  local w, d, h = num(a.width, 3, 2, 6), num(a.depth, 2.4, 1.5, 4), num(a.height, 3.2, 2, 5)
  local root = box(b, w, h, d, at(0, h / 2, 0), rgb(a.color, C(210, 212, 216)), matOf(a.material, M.Metal), "Body")
  box(b, w - 0.4, h * 0.45, 0.1, at(0, h * 0.35, -d / 2 - 0.05), C(30, 30, 34), M.Glass, "OvenDoor", { Transparency = 0.2 })
  box(b, w - 0.4, 0.12, 0.3, at(0, h * 0.62, -d / 2 - 0.2), C(80, 82, 90), M.Metal, "Handle", { CanCollide = false })
  box(b, w, 0.15, d, at(0, h + 0.07, 0), C(30, 30, 34), M.Glass, "Hob")
  for _, sx in ipairs({ -1, 1 }) do for _, sz in ipairs({ -1, 1 }) do cylY(b, 0.5, 0.06, at(sx * (w / 4), h + 0.17, sz * (d / 4)), C(70, 70, 76), M.Metal, "Burner", { CanCollide = false }) end end
  for i = 1, 4 do cylZ(b, 0.12, 0.2, at(-w / 2 + i * (w / 5), h - 0.3, -d / 2 - 0.1), C(60, 60, 66), M.SmoothPlastic, "Knob", { CanCollide = false }) end
  return root
end
function F.sink(b, a, S) a.sink = true a.width = num(a.width, 4, 2, 10) return F.counter(b, a, S) end
function F.bathtub(b, a, S)
  local w, d, h = num(a.width, 6, 3, 10), num(a.depth, 3, 2, 5), num(a.height, 2, 1.2, 3)
  local col = rgb(a.color, C(245, 245, 242))
  local root = box(b, w, 0.4, d, at(0, 0.2, 0), col, M.SmoothPlastic, "Bottom")
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.4, h, d, at(sx * (w / 2 - 0.2), h / 2, 0), col, M.SmoothPlastic, "Wall") end
  for _, sz in ipairs({ -1, 1 }) do box(b, w - 0.8, h, 0.4, at(0, h / 2, sz * (d / 2 - 0.2)), col, M.SmoothPlastic, "Wall") end
  box(b, w + 0.3, 0.2, d + 0.3, at(0, h + 0.1, 0), col, M.SmoothPlastic, "Rim")
  if a.water ~= false then box(b, w - 0.8, 0.1, d - 0.8, at(0, h * 0.7, 0), C(120, 190, 230), M.Glass, "Water", { Transparency = 0.4, CanCollide = false }) end
  cylY(b, 0.08, 1.2, at(0, h + 0.7, d / 2 - 0.6), C(200, 205, 210), M.Metal, "Tap", { CanCollide = false }) cylZ(b, 0.08, 0.8, at(0, h + 1.2, d / 2 - 1.0), C(200, 205, 210), M.Metal, "Spout", { CanCollide = false })
  return root
end
function F.toilet(b, a, S)
  local col = rgb(a.color, C(245, 245, 242))
  local root = box(b, 1.6, 1.6, 1.0, at(0, 0.8, 0.8), col, M.SmoothPlastic, "Base")
  cylY(b, 0.8, 1.6, at(0, 0.8, -0.2), col, M.SmoothPlastic, "Bowl")
  cylY(b, 0.85, 0.15, at(0, 1.68, -0.2), col, M.SmoothPlastic, "Seat")
  box(b, 1.5, 1.6, 0.8, at(0, 2.4, 1.0), col, M.SmoothPlastic, "Tank")
  box(b, 1.6, 0.1, 0.9, at(0, 3.25, 1.0), col, M.SmoothPlastic, "Lid")
  box(b, 0.4, 0.1, 0.15, at(-0.5, 2.9, 0.55), C(200, 205, 210), M.Metal, "Flush", { CanCollide = false })
  return root
end
function F.tv(b, a, S)
  local w = num(a.width, 5, 2, 14) local h = w * 0.56
  local standH = num(a.height, 2.2, 0, 5)
  local root = box(b, w, standH > 0 and 0.4 or 0.1, 1.4, at(0, 0.2, 0), S.body, S.bodyMat, "Stand")
  if standH > 0 then box(b, w * 0.4, standH - 0.4, 0.3, at(0, standH / 2 + 0.2, 0), S.frame, S.frameMat, "Neck") end
  box(b, w, h, 0.2, at(0, standH + h / 2 + 0.1, 0), C(20, 20, 24), M.SmoothPlastic, "Bezel")
  box(b, w - 0.2, h - 0.2, 0.04, at(0, standH + h / 2 + 0.1, -0.12), rgb(a.color2, C(40, 120, 200)), M.Neon, "Screen", { CanCollide = false })
  pcall(function() local sg = Instance.new("SurfaceGui") sg.Name = "ScreenGui" sg.Face = Enum.NormalId.Front sg.Parent = b.parts[#b.parts] end)
  return root
end
function F.floor_lamp(b, a, S)
  local h = num(a.height, 6, 3, 12)
  local root = cylY(b, 0.9, 0.15, at(0, 0.08, 0), S.frame, S.frameMat, "Base")
  cylY(b, 0.1, h - 1.2, at(0, (h - 1.2) / 2 + 0.15, 0), S.frame, S.frameMat, "Pole")
  local shadeP = cylY(b, 1.2, 1.4, at(0, h - 0.6, 0), S.cushion, M.Fabric, "Shade", { CanCollide = false })
  local bulb = ball(b, 0.3, at(0, h - 0.6, 0), C(255, 240, 200), M.Neon, "Bulb", { CanCollide = false })
  light(bulb, "PointLight", C(255, 225, 170), 1.3, 18)
  return root
end
function F.bunk_bed(b, a, S)
  local w, d = num(a.width, 4, 3, 7), num(a.depth, 7.5, 5, 12)
  local lvl = { 1.2, 4.6 }
  local root = nil
  for _, sx in ipairs({ -1, 1 }) do for _, sz in ipairs({ -1, 1 }) do local p = box(b, 0.4, 6.4, 0.4, at(sx * (w / 2 - 0.2), 3.2, sz * (d / 2 - 0.2)), S.frame, S.frameMat, "Post") root = root or p end end
  for _, y in ipairs(lvl) do
    box(b, w, 0.3, d, at(0, y, 0), S.frame, S.frameMat, "Frame")
    box(b, w - 0.5, 0.6, d - 0.5, at(0, y + 0.45, 0), rgb(a.color, C(240, 240, 236)), M.Fabric, "Mattress")
    box(b, w - 0.7, 0.4, d * 0.55, at(0, y + 0.85, 0.2 * d), S.cushion, S.cushionMat, "Blanket")
    box(b, w - 1.2, 0.35, 1.2, at(0, y + 0.9, -d / 2 + 1), C(250, 250, 248), M.Fabric, "Pillow")
  end
  box(b, w, 0.25, 0.25, at(0, lvl[2] + 1.4, d / 2 - 0.2), S.frame, S.frameMat, "GuardRail") box(b, w, 0.25, 0.25, at(0, lvl[2] + 1.4, -d / 2 + 0.2), S.frame, S.frameMat, "GuardRail")
  for i = 1, 4 do box(b, 0.25, 0.25, 1.4, at(w / 2 + 0.3, i * 1.1, -d / 2 + 1.2), S.frame, S.frameMat, "LadderRung") end
  box(b, 0.25, 5, 0.25, at(w / 2 + 0.3, 2.5, -d / 2 + 0.55), S.frame, S.frameMat, "LadderRail") box(b, 0.25, 5, 0.25, at(w / 2 + 0.3, 2.5, -d / 2 + 1.85), S.frame, S.frameMat, "LadderRail")
  return root
end
function F.throne(b, a, S)
  if a.style == nil then S = fstyle({ style = "royal", color = a.color, color2 = a.color2, accent = a.accent, material = a.material }) end
  local w = num(a.width, 3.4, 2, 7)
  local root = box(b, w, 1.8, 3, at(0, 0.9, 0), S.frame, S.frameMat, "Base")
  seatBox(b, w - 0.4, 0.5, 2.6, at(0, 2.05, 0), S.cushion, S.cushionMat, "Seat")
  box(b, w, 5.5, 0.6, at(0, 1.8 + 2.75, 1.2), S.frame, S.frameMat, "Back")
  box(b, w - 0.8, 4.2, 0.2, at(0, 1.8 + 2.6, 0.85), S.cushion, S.cushionMat, "BackCushion")
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.5, 1.4, 2.6, at(sx * (w / 2 - 0.25), 2.5, 0), S.frame, S.frameMat, "Arm") ball(b, 0.45, at(sx * (w / 2 - 0.25), 3.3, -1.2), S.accent, S.frameMat, "ArmOrb", { CanCollide = false }) end
  for i = -1, 1 do box(b, 0.5, 1.4, 0.4, at(i * (w / 3), 1.8 + 5.5 + 0.6, 1.2), S.accent, S.frameMat, "Finial", { CanCollide = false }) end
  ball(b, 0.5, at(0, 1.8 + 5.5 + 1.5, 1.2), S.accent, M.Neon, "Jewel", { CanCollide = false })
  box(b, w + 2, 0.4, 5, at(0, 0.2, -1), S.frame, S.frameMat, "Dais")
  return root
end
function F.piano(b, a, S)
  local w = num(a.width, 7, 4, 12)
  local col = rgb(a.color, C(20, 20, 24))
  local root = box(b, w, 2.6, 3.4, at(0, 2.6 / 2 + 0.8, 0.6), col, M.SmoothPlastic, "Body")
  box(b, w, 0.15, 3.4, at(0, 3.5, 0.6), col, M.SmoothPlastic, "Lid")
  box(b, w - 0.4, 0.3, 1.2, at(0, 2.2, -1.6), C(250, 250, 245), M.SmoothPlastic, "Keys")
  local n = math.floor((w - 0.4) / 0.5)
  for i = 1, n do if i % 7 ~= 3 and i % 7 ~= 0 then box(b, 0.22, 0.2, 0.7, at(-(w - 0.4) / 2 + (i - 0.5) * 0.5 + 0.25, 2.42, -1.35), C(20, 20, 24), M.SmoothPlastic, "BlackKey", { CanCollide = false }) end end
  for _, sx in ipairs({ -1, 1 }) do box(b, 0.4, 0.8, 0.4, at(sx * (w / 2 - 0.3), 0.4, -1.9), col, M.SmoothPlastic, "Leg") box(b, 0.4, 0.8, 0.4, at(sx * (w / 2 - 0.3), 0.4, 2.1), col, M.SmoothPlastic, "Leg") end
  box(b, 1.6, 0.3, 1.2, at(0, 1.6, -3.6), col, M.SmoothPlastic, "Bench") for _, sx in ipairs({ -1, 1 }) do for _, sz in ipairs({ -1, 1 }) do box(b, 0.2, 1.45, 0.2, at(sx * 0.6, 0.72, -3.6 + sz * 0.45), col, M.SmoothPlastic, "BenchLeg") end end
  return root
end
MK.F = F
`;

  // EditableMesh shapes, detail passes, variants and the command dispatcher.
  const LIB3 = String.raw`
-- editable mesh shapes ------------------------------------------------------------------------
local G = {}
local function newMesh() return { v = {}, f = {} } end
local function addV(m, x, y, z) local id = #m.v + 1 m.v[id] = Vector3.new(x, y, z) return id end
local function addF(m, a, b2, c) if a ~= b2 and b2 ~= c and a ~= c then m.f[#m.f + 1] = { a, b2, c } end end
-- revolve profile { {r, y}, ... } (top -> bottom) around Y, outward winding; caps when the end radius is > 0
local function lathe(m, profile, segs, capTop, capBottom)
  local rings = {}
  for i, p in ipairs(profile) do
    local r, y = p[1], p[2]
    if r <= 1e-6 then rings[i] = { pole = addV(m, 0, y, 0) }
    else
      local ring = {}
      for j = 0, segs - 1 do local t = j / segs * TAU ring[j + 1] = addV(m, r * math.cos(t), y, r * math.sin(t)) end
      rings[i] = ring
    end
  end
  for i = 1, #profile - 1 do
    local A, B = rings[i], rings[i + 1]
    for j = 1, segs do
      local j2 = (j % segs) + 1
      if A.pole and not B.pole then addF(m, A.pole, B[j2], B[j])
      elseif B.pole and not A.pole then addF(m, A[j], A[j2], B.pole)
      elseif not A.pole and not B.pole then addF(m, A[j], A[j2], B[j2]) addF(m, A[j], B[j2], B[j]) end
    end
  end
  local first, last = rings[1], rings[#rings]
  if capTop and not first.pole then local c = addV(m, 0, profile[1][2], 0) for j = 1, segs do local j2 = (j % segs) + 1 addF(m, c, first[j2], first[j]) end end
  if capBottom and not last.pole then local c = addV(m, 0, profile[#profile][2], 0) for j = 1, segs do local j2 = (j % segs) + 1 addF(m, c, last[j], last[j2]) end end
  return m
end
local function arcProfile(r, fromDeg, toDeg, n, cy, scaleY)
  local out = {}
  for i = 0, n do local t = math.rad(fromDeg + (toDeg - fromDeg) * i / n) out[#out + 1] = { r * math.cos(t), (cy or 0) + r * math.sin(t) * (scaleY or 1) } end
  return out
end
function G.sphere(a) local r = num(a.radius, 2, 0.1, 500) return lathe(newMesh(), arcProfile(r, 90, -90, math.floor(num(a.rings, 12, 3, 128))), math.floor(num(a.segments, 24, 3, 256))) end
function G.egg(a) local r = num(a.radius, 2, 0.1, 500) local prof = {} local n = math.floor(num(a.rings, 14, 3, 128)) for i = 0, n do local t = math.rad(90 - 180 * i / n) local k = 1 + 0.25 * math.sin(t) prof[#prof + 1] = { r * math.cos(t) * k, r * math.sin(t) * 1.25 } end return lathe(newMesh(), prof, math.floor(num(a.segments, 24, 3, 256))) end
function G.dome(a) local r = num(a.radius, 4, 0.1, 500) return lathe(newMesh(), arcProfile(r, 90, 0, math.floor(num(a.rings, 8, 2, 128))), math.floor(num(a.segments, 24, 3, 256)), false, true) end
function G.cone(a) local r, h = num(a.radius, 2, 0.1, 500), num(a.height, 4, 0.1, 1000) return lathe(newMesh(), { { 0, h / 2 }, { r, -h / 2 } }, math.floor(num(a.segments, 24, 3, 256)), false, true) end
function G.cylinder(a) local r, h = num(a.radius, 2, 0.1, 500), num(a.height, 4, 0.1, 1000) return lathe(newMesh(), { { r, h / 2 }, { r, -h / 2 } }, math.floor(num(a.segments, 32, 3, 256)), true, true) end
function G.prism(a) local r, h = num(a.radius, 2, 0.1, 500), num(a.height, 4, 0.1, 1000) local t = num(a.taper, 1, 0, 1) return lathe(newMesh(), { { r * t, h / 2 }, { r, -h / 2 } }, math.floor(num(a.sides, 6, 3, 64)), t > 0.001, true) end
function G.crystal(a) local r, h = num(a.radius, 1.2, 0.1, 200), num(a.height, 5, 0.2, 500) return lathe(newMesh(), { { 0, h / 2 }, { r * 0.7, h * 0.22 }, { r, -h * 0.15 }, { r * 0.75, -h / 2 + 0.01 }, { 0, -h / 2 } }, math.floor(num(a.sides, 6, 3, 64))) end
function G.capsule(a)
  local r, h = num(a.radius, 1.5, 0.1, 500), num(a.height, 6, 0.1, 1000)
  local cyl = math.max(0, h - 2 * r)
  local prof = {}
  for _, p in ipairs(arcProfile(r, 90, 0, math.floor(num(a.rings, 6, 2, 64)))) do prof[#prof + 1] = { p[1], p[2] + cyl / 2 } end
  for _, p in ipairs(arcProfile(r, 0, -90, math.floor(num(a.rings, 6, 2, 64)))) do prof[#prof + 1] = { p[1], p[2] - cyl / 2 } end
  return lathe(newMesh(), prof, math.floor(num(a.segments, 24, 3, 256)))
end
function G.ring(a)
  local ro, ri, h = num(a.radius, 4, 0.2, 500), num(a.inner_radius, 3, 0.05, 499), num(a.height, 1, 0.05, 500)
  if ri >= ro then ri = ro * 0.7 end
  -- closed rectangle profile walked clockwise in the r/y plane so every face points outward
  return lathe(newMesh(), { { ri, h / 2 }, { ro, h / 2 }, { ro, -h / 2 }, { ri, -h / 2 }, { ri, h / 2 } }, math.floor(num(a.segments, 32, 3, 256)))
end
function G.lathe(a)
  local prof = {}
  if type(a.profile) ~= "table" or #a.profile < 2 then error("lathe needs profile [[radius, y], ...] with at least 2 points (top to bottom)") end
  for _, p in ipairs(a.profile) do prof[#prof + 1] = { math.max(0, num(p[1], 0)), num(p[2], 0) } end
  return lathe(newMesh(), prof, math.floor(num(a.segments, 24, 3, 256)), a.cap_top ~= false, a.cap_bottom ~= false)
end
function G.torus(a)
  local R, r = num(a.radius, 4, 0.2, 500), num(a.tube_radius or a.inner_radius, 1, 0.05, 250)
  local segs, rings = math.floor(num(a.segments, 32, 3, 256)), math.floor(num(a.rings, 16, 3, 128))
  local m = newMesh()
  local ids = {}
  for i = 0, segs - 1 do
    local u = i / segs * TAU
    ids[i + 1] = {}
    for j = 0, rings - 1 do
      local v = j / rings * TAU
      local cx, cz = math.cos(u), math.sin(u)
      local rr = R + r * math.cos(v)
      ids[i + 1][j + 1] = addV(m, rr * cx, r * math.sin(v), rr * cz)
    end
  end
  for i = 1, segs do
    local i2 = (i % segs) + 1
    for j = 1, rings do
      local j2 = (j % rings) + 1
      addF(m, ids[i][j], ids[i][j2], ids[i2][j2]) addF(m, ids[i][j], ids[i2][j2], ids[i2][j])
    end
  end
  return m
end
local function extrude(m, poly, h)
  -- poly: list of {x, z} counter-clockwise seen from above, star-shaped around the origin
  local n = #poly
  local top, bot = {}, {}
  for i = 1, n do top[i] = addV(m, poly[i][1], h / 2, poly[i][2]) bot[i] = addV(m, poly[i][1], -h / 2, poly[i][2]) end
  local ct, cb = addV(m, 0, h / 2, 0), addV(m, 0, -h / 2, 0)
  for i = 1, n do
    local i2 = (i % n) + 1
    addF(m, ct, top[i2], top[i]) addF(m, cb, bot[i], bot[i2])
    addF(m, top[i], top[i2], bot[i2]) addF(m, top[i], bot[i2], bot[i])
  end
  return m
end
local function polyCCW(poly)
  local s = 0
  for i = 1, #poly do local p, q = poly[i], poly[(i % #poly) + 1] s = s + (p[1] * q[2] - q[1] * p[2]) end
  -- in the x/z plane viewed from +Y, a positive shoelace sum is clockwise (z axis points toward the viewer's bottom)
  if s > 0 then local r = {} for i = #poly, 1, -1 do r[#r + 1] = poly[i] end return r end
  return poly
end
function G.star(a)
  local pts, ro, ri, h = math.floor(num(a.points, 5, 3, 32)), num(a.radius, 3, 0.1, 500), num(a.inner_radius, 1.3, 0.05, 499), num(a.height, 0.6, 0.05, 500)
  local poly = {}
  for i = 0, pts * 2 - 1 do local t = i / (pts * 2) * TAU - PI / 2 local r = (i % 2 == 0) and ro or ri poly[#poly + 1] = { r * math.cos(t), r * math.sin(t) } end
  return extrude(newMesh(), polyCCW(poly), h)
end
function G.gear(a)
  local teeth, ro, h = math.floor(num(a.teeth, 12, 3, 96)), num(a.radius, 3, 0.1, 500), num(a.height, 0.8, 0.05, 500)
  local ri = num(a.inner_radius, ro * 0.8, 0.05, ro - 0.01)
  local poly = {}
  for i = 0, teeth - 1 do
    local t0 = i / teeth * TAU local dt = TAU / teeth
    poly[#poly + 1] = { ri * math.cos(t0), ri * math.sin(t0) }
    poly[#poly + 1] = { ro * math.cos(t0 + dt * 0.2), ro * math.sin(t0 + dt * 0.2) }
    poly[#poly + 1] = { ro * math.cos(t0 + dt * 0.5), ro * math.sin(t0 + dt * 0.5) }
    poly[#poly + 1] = { ri * math.cos(t0 + dt * 0.7), ri * math.sin(t0 + dt * 0.7) }
  end
  return extrude(newMesh(), polyCCW(poly), h)
end
function G.tube(a)
  local pts = {}
  if type(a.points) == "table" and #a.points >= 2 then for _, p in ipairs(a.points) do pts[#pts + 1] = vec(p, 0, 0, 0) end
  else local L = num(a.height or a.length, 8, 0.1, 1000) pts = { Vector3.new(0, -L / 2, 0), Vector3.new(0, L / 2, 0) } end
  local r, segs = num(a.radius, 0.5, 0.02, 200), math.floor(num(a.segments, 12, 3, 128))
  local m = newMesh()
  local rings = {}
  for i, p in ipairs(pts) do
    local dir
    if i == 1 then dir = pts[2] - pts[1] elseif i == #pts then dir = pts[i] - pts[i - 1] else dir = (pts[i + 1] - pts[i]).Unit + (pts[i] - pts[i - 1]).Unit end
    if dir.Magnitude < 1e-6 then dir = Vector3.new(0, 1, 0) end
    dir = dir.Unit
    local up = math.abs(dir.Y) > 0.9 and Vector3.new(1, 0, 0) or Vector3.new(0, 1, 0)
    local n1 = dir:Cross(up).Unit local n2 = dir:Cross(n1).Unit
    rings[i] = {}
    for j = 0, segs - 1 do local t = j / segs * TAU local q = p + n1 * (r * math.cos(t)) + n2 * (r * math.sin(t)) rings[i][j + 1] = addV(m, q.X, q.Y, q.Z) end
  end
  for i = 1, #pts - 1 do
    for j = 1, segs do local j2 = (j % segs) + 1 addF(m, rings[i][j], rings[i + 1][j2], rings[i][j2]) addF(m, rings[i][j], rings[i + 1][j], rings[i + 1][j2]) end
  end
  if a.caps ~= false then
    local c0 = addV(m, pts[1].X, pts[1].Y, pts[1].Z) local c1 = addV(m, pts[#pts].X, pts[#pts].Y, pts[#pts].Z)
    for j = 1, segs do local j2 = (j % segs) + 1 addF(m, c0, rings[1][j], rings[1][j2]) addF(m, c1, rings[#pts][j2], rings[#pts][j]) end
  end
  return m, "tube"
end
function G.icosphere(a, noise)
  local r = num(a.radius, 2, 0.1, 500)
  local sub = math.floor(num(a.subdivisions, 2, 0, 4))
  local t = (1 + math.sqrt(5)) / 2
  local base = { { -1, t, 0 }, { 1, t, 0 }, { -1, -t, 0 }, { 1, -t, 0 }, { 0, -1, t }, { 0, 1, t }, { 0, -1, -t }, { 0, 1, -t }, { t, 0, -1 }, { t, 0, 1 }, { -t, 0, -1 }, { -t, 0, 1 } }
  local faces = { { 1, 12, 6 }, { 1, 6, 2 }, { 1, 2, 8 }, { 1, 8, 11 }, { 1, 11, 12 }, { 2, 6, 10 }, { 6, 12, 5 }, { 12, 11, 3 }, { 11, 8, 7 }, { 8, 2, 9 }, { 4, 10, 5 }, { 4, 5, 3 }, { 4, 3, 7 }, { 4, 7, 9 }, { 4, 9, 10 }, { 5, 10, 6 }, { 3, 5, 12 }, { 7, 3, 11 }, { 9, 7, 8 }, { 10, 9, 2 } }
  local verts = {}
  for i, p in ipairs(base) do local v = Vector3.new(p[1], p[2], p[3]).Unit verts[i] = v end
  local cache = {}
  local function mid(i, j)
    local k = i < j and (i .. "_" .. j) or (j .. "_" .. i)
    if cache[k] then return cache[k] end
    local v = ((verts[i] + verts[j]) * 0.5).Unit
    verts[#verts + 1] = v cache[k] = #verts return #verts
  end
  for _ = 1, sub do
    local nf = {}
    for _, f in ipairs(faces) do
      local a1, b1, c1 = mid(f[1], f[2]), mid(f[2], f[3]), mid(f[3], f[1])
      nf[#nf + 1] = { f[1], a1, c1 } nf[#nf + 1] = { f[2], b1, a1 } nf[#nf + 1] = { f[3], c1, b1 } nf[#nf + 1] = { a1, b1, c1 }
    end
    faces = nf
  end
  local m = newMesh()
  local R = rnd(a.seed or 1)
  local rough = noise and num(a.roughness, 0.35, 0, 0.9) or 0
  local st = vec(a.stretch, 1, 1, 1)
  for i, v in ipairs(verts) do
    local k = 1
    if rough > 0 then k = 1 - rough * 0.5 + rough * R() + 0.15 * rough * math.noise(v.X * 2.3 + R() * 0.01, v.Y * 2.3, v.Z * 2.3) end
    addV(m, v.X * r * k * st.X, v.Y * r * k * st.Y, v.Z * r * k * st.Z)
  end
  for _, f in ipairs(faces) do addF(m, f[1], f[2], f[3]) end
  return m
end
function G.rock(a) return G.icosphere({ radius = a.radius, subdivisions = num(a.subdivisions, 1, 0, 3), seed = a.seed, roughness = a.roughness, stretch = a.stretch or { 1.3, 0.8, 1 } }, true) end
MK.G = G
local function meshStats(m)
  local mn, mx = nil, nil
  for _, v in ipairs(m.v) do
    if not mn then mn = v mx = v else mn = Vector3.new(math.min(mn.X, v.X), math.min(mn.Y, v.Y), math.min(mn.Z, v.Z)) mx = Vector3.new(math.max(mx.X, v.X), math.max(mx.Y, v.Y), math.max(mx.Z, v.Z)) end
  end
  return mn or Vector3.new(), mx or Vector3.new()
end
MK.meshStats = meshStats
function MK.buildMesh(m, flat)
  -- returns MeshPart or nil, err. Normals: flat = one per face, smooth = accumulated per vertex.
  local okEm, em = pcall(function() return AssetService:CreateEditableMesh() end)
  if not okEm or not em then return nil, "EditableMesh unavailable: " .. tostring(em) end
  local ids = {}
  local okAdd, addErr = pcall(function()
    for i, v in ipairs(m.v) do ids[i] = em:AddVertex(v) end
    local nids = nil
    if not flat then
      local acc = {}
      for i = 1, #m.v do acc[i] = Vector3.new() end
      for _, f in ipairs(m.f) do
        local p0, p1, p2 = m.v[f[1]], m.v[f[2]], m.v[f[3]]
        local n = (p1 - p0):Cross(p2 - p0)
        acc[f[1]] = acc[f[1]] + n acc[f[2]] = acc[f[2]] + n acc[f[3]] = acc[f[3]] + n
      end
      nids = {}
      for i = 1, #m.v do local n = acc[i] if n.Magnitude < 1e-9 then n = Vector3.new(0, 1, 0) end nids[i] = em:AddNormal(n.Unit) end
    end
    for _, f in ipairs(m.f) do
      local fid = em:AddTriangle(ids[f[1]], ids[f[2]], ids[f[3]])
      if fid then
        if flat then local nid = em:AddNormal() em:SetFaceNormals(fid, { nid, nid, nid })
        else em:SetFaceNormals(fid, { nids[f[1]], nids[f[2]], nids[f[3]] }) end
      end
    end
    pcall(function() em:RemoveUnused() end)
  end)
  if not okAdd then return nil, "EditableMesh build failed: " .. tostring(addErr) end
  local okMP, mp = pcall(function() return AssetService:CreateMeshPartAsync(Content.fromObject(em), { CollisionFidelity = Enum.CollisionFidelity.Default }) end)
  if not okMP or not mp then return nil, "CreateMeshPartAsync failed: " .. tostring(mp) end
  return mp, nil
end

-- detail passes --------------------------------------------------------------------------------
local D = {}
local function isBox(p) return p:IsA("Part") and p.Shape == Enum.PartType.Block end
local function biggest(parts, limit, minSize)
  local out = {}
  for _, p in ipairs(parts) do local s = p.Size if math.max(s.X, s.Z) >= (minSize or 3) and s.Y >= 0.5 then out[#out + 1] = p end end
  table.sort(out, function(p, q) return p.Size.X * p.Size.Y * p.Size.Z > q.Size.X * q.Size.Y * q.Size.Z end)
  while #out > limit do out[#out] = nil end
  return out
end
function D.trim(b, parts, a, S, R)
  local col = rgb(a.color, S.trim) local n = 0
  for _, p in ipairs(biggest(parts, 60, 3)) do
    local s = p.Size local t = num(a.thickness, 0.4, 0.1, 2)
    for _, e in ipairs({ { 0, s.Y / 2, -s.Z / 2, s.X + t, t, t }, { 0, s.Y / 2, s.Z / 2, s.X + t, t, t }, { -s.X / 2, s.Y / 2, 0, t, t, s.Z + t }, { s.X / 2, s.Y / 2, 0, t, t, s.Z + t } }) do
      mk(b, "Part", Vector3.new(e[4], e[5], e[6]), p.CFrame * at(e[1], e[2], e[3]), col, matOf(a.material, M.Wood), "Trim", { CanCollide = false })
      n = n + 1
    end
  end
  return n
end
function D.rivets(b, parts, a, S, R)
  local col = rgb(a.color, C(90, 92, 98)) local n = 0 local sp = num(a.spacing, 2, 0.5, 10) local r = num(a.size, 0.18, 0.05, 1)
  for _, p in ipairs(biggest(parts, 40, 2)) do
    local s = p.Size
    for _, face in ipairs({ { 0, 0, -1 }, { 0, 0, 1 }, { -1, 0, 0 }, { 1, 0, 0 } }) do
      local along = face[3] ~= 0 and s.X or s.Z
      local cnt = math.floor(along / sp)
      if cnt >= 1 then
        for i = 1, cnt do
          local u = -along / 2 + (i - 0.5) * (along / cnt)
          for _, y in ipairs({ s.Y / 2 - 0.4, -s.Y / 2 + 0.4 }) do
            local off = face[3] ~= 0 and at(u, y, face[3] * (s.Z / 2 + r * 0.4)) or at(face[1] * (s.X / 2 + r * 0.4), y, u)
            mk(b, "Part", Vector3.new(r * 2, r * 2, r * 2), p.CFrame * off, col, M.Metal, "Rivet", { Shape = Enum.PartType.Ball, CanCollide = false })
            n = n + 1
            if n >= num(a.budget, 300, 1, 1500) then return n end
          end
        end
      end
    end
  end
  return n
end
function D.planks(b, parts, a, S, R)
  local col = rgb(a.color, S.wood) local n = 0 local pw = num(a.spacing, 1.2, 0.4, 6)
  for _, p in ipairs(biggest(parts, 30, 3)) do
    local s = p.Size
    -- largest vertical face pair
    local faceZ = s.X >= s.Z
    local along = faceZ and s.X or s.Z
    local cnt = math.floor(along / pw)
    for _, side in ipairs({ -1, 1 }) do
      for i = 1, cnt do
        local u = -along / 2 + (i - 0.5) * (along / cnt)
        local sz = faceZ and Vector3.new(along / cnt - 0.08, s.Y, 0.12) or Vector3.new(0.12, s.Y, along / cnt - 0.08)
        local off = faceZ and at(u, 0, side * (s.Z / 2 + 0.06)) or at(side * (s.X / 2 + 0.06), 0, u)
        mk(b, "Part", sz, p.CFrame * off, shade(col, 0.85 + 0.3 * R()), M.WoodPlanks, "Plank", { CanCollide = false })
        n = n + 1
        if n >= num(a.budget, 300, 1, 1500) then return n end
      end
    end
  end
  return n
end
function D.wear(b, parts, a, S, R)
  local n = 0 local amount = num(a.amount, 0.5, 0, 1)
  for _, p in ipairs(parts) do
    local k = 1 - amount * 0.25 + amount * 0.3 * R()
    p.Color = shade(p.Color, k) n = n + 1
    if p.Size.Y >= 4 and math.max(p.Size.X, p.Size.Z) >= 3 and R() < amount then
      local s = p.Size
      mk(b, "Part", Vector3.new(s.X + 0.05, math.min(1.2, s.Y * 0.2), s.Z + 0.05), p.CFrame * at(0, -s.Y / 2 + math.min(1.2, s.Y * 0.2) / 2, 0), shade(p.Color, 0.6), p.Material, "Grime", { CanCollide = false, Transparency = 0.25 })
    end
  end
  return n
end
function D.bevel(b, parts, a, S, R)
  local n = 0 local t = num(a.thickness, 0.5, 0.1, 3)
  for _, p in ipairs(biggest(parts, 40, 3)) do
    local s = p.Size local col = shade(p.Color, 0.92)
    -- four wedges along the top edges; vertical face of the wedge sits inside the part, slope faces out and up
    mk(b, "WedgePart", Vector3.new(s.X, t, t), p.CFrame * at(0, s.Y / 2 + t / 2, -s.Z / 2 + t / 2), col, p.Material, "Bevel", { CanCollide = false })
    mk(b, "WedgePart", Vector3.new(s.X, t, t), p.CFrame * at(0, s.Y / 2 + t / 2, s.Z / 2 - t / 2) * CFrame.Angles(0, PI, 0), col, p.Material, "Bevel", { CanCollide = false })
    mk(b, "WedgePart", Vector3.new(s.Z, t, t), p.CFrame * at(-s.X / 2 + t / 2, s.Y / 2 + t / 2, 0) * CFrame.Angles(0, -PI / 2, 0), col, p.Material, "Bevel", { CanCollide = false })
    mk(b, "WedgePart", Vector3.new(s.Z, t, t), p.CFrame * at(s.X / 2 - t / 2, s.Y / 2 + t / 2, 0) * CFrame.Angles(0, PI / 2, 0), col, p.Material, "Bevel", { CanCollide = false })
    n = n + 4
  end
  return n
end
function D.moss(b, parts, a, S, R)
  local n = 0 local col = rgb(a.color, C(80, 130, 60)) local amount = num(a.amount, 0.5, 0, 1)
  for _, p in ipairs(biggest(parts, 50, 2)) do
    local s = p.Size
    local cnt = math.floor(1 + amount * 3)
    for i = 1, cnt do
      if R() < 0.4 + amount * 0.5 then
        local w, d = s.X * R(0.2, 0.5), s.Z * R(0.2, 0.5)
        mk(b, "Part", Vector3.new(w, 0.12, d), p.CFrame * at(R(-s.X / 2 + w / 2, s.X / 2 - w / 2), s.Y / 2 + 0.06, R(-s.Z / 2 + d / 2, s.Z / 2 - d / 2)), shade(col, 0.85 + 0.3 * R()), M.Grass, "Moss", { CanCollide = false })
        n = n + 1
        if s.Y >= 3 and R() < amount then mk(b, "Part", Vector3.new(0.1, s.Y * R(0.3, 0.7), s.Z * R(0.15, 0.35)), p.CFrame * at(-s.X / 2 - 0.05, -s.Y * 0.15, R(-s.Z / 3, s.Z / 3)), shade(col, 0.8), M.Grass, "MossDrip", { CanCollide = false }) n = n + 1 end
      end
    end
  end
  return n
end
MK.D = D

-- commands -------------------------------------------------------------------------------------
local CMD = {}
function CMD.structure_build(a)
  local kind = key(a.kind, "house")
  local fn = K[kind]
  if not fn then error("unknown structure kind " .. tostring(a.kind)) end
  if a.style == nil or a.style == "" then a.style = projectStyle("model") end
  local S = styleOf(a, kind == "dungeon_room" and "stone" or "medieval")
  local R = rootCF(a)
  local m = makeModel(a, "Structure", kind)
  local b = newB(m, R, S)
  local info = fn(b, a, CFrame.new(), S) or {}
  local primary = b.parts[1]
  finish(b, m.Name, parentOf(a.parent), primary)
  m:SetAttribute("StructureKind", kind) m:SetAttribute("StructureStyle", key(a.style, kind == "dungeon_room" and "stone" or "medieval"))
  local size = select(2, m:GetBoundingBox())
  info.kind = kind info.style = key(a.style, kind == "dungeon_room" and "stone" or "medieval") info.parts = b.n info.path = m:GetFullName()
  info.bounds = { math.floor(size.X * 10) / 10, math.floor(size.Y * 10) / 10, math.floor(size.Z * 10) / 10 }
  info.next = "total_screenshot to check it, model_detail {path, ops:[\"trim\",\"wear\"]} for extra detail, model_variant for seeded copies, environment_scatter around it"
  return okj(info, ("%s built: %d parts, %.0fx%.0fx%.0f studs at %s"):format(kind, b.n, size.X, size.Y, size.Z, m:GetFullName()))
end
function CMD.vehicle_build(a)
  local kind = key(a.kind, "car")
  local fn = V[kind]
  if not fn then error("unknown vehicle kind " .. tostring(a.kind)) end
  local R = rootCF(a)
  local m = makeModel(a, "Vehicle", kind)
  local b = newB(m, R, nil)
  local root, mode, wheels = fn(b, a)
  local info = vehicleFinish(b, a, root, m.Name, kind, mode, wheels)
  m:SetAttribute("VehicleKind", kind)
  info.path = m:GetFullName()
  local size = select(2, m:GetBoundingBox())
  info.bounds = { math.floor(size.X * 10) / 10, math.floor(size.Y * 10) / 10, math.floor(size.Z * 10) / 10 }
  info.next = a.drivable and "play-test (sit in the VehicleSeat, WASD); tune MaxSpeed / TurnSpeed attributes on the model; total_screenshot to check the look" or "total_screenshot to check it; re-run with drivable=true for a working VehicleSeat rig"
  return okj(info, ("%s built: %d parts%s at %s"):format(kind, b.n, a.drivable and (", drivable (" .. mode .. ")") or ", static", m:GetFullName()))
end
function CMD.weapon_build(a)
  local kind = key(a.kind, "sword")
  local fn = W[kind]
  if not fn then error("unknown weapon kind " .. tostring(a.kind)) end
  if a.style == nil or a.style == "" then a.style = projectStyle("weapon") end
  local S = wstyle(a)
  local asTool = a.as_tool ~= false
  local R = rootCF(a)
  local holder = asTool and Instance.new("Tool") or Instance.new("Model")
  holder.Name = tostring(a.name or (kind:sub(1, 1):upper() .. kind:sub(2)))
  local b = newB(holder, R, S)
  local handle, reach = fn(b, a, S)
  handle.Name = "Handle"
  for _, p in ipairs(b.parts) do if p ~= handle then weld(handle, p) end end
  local ranged = (kind == "pistol" or kind == "rifle" or kind == "shotgun" or kind == "sniper" or kind == "bow" or kind == "crossbow")
  if asTool then
    holder.RequiresHandle = true holder.CanBeDropped = a.droppable ~= false
    holder.ToolTip = tostring(a.tooltip or holder.Name)
    local gripMode = key(a.grip, ranged and "up" or "forward")
    if gripMode == "forward" then holder.Grip = CFrame.Angles(-PI / 2, 0, 0) else holder.Grip = CFrame.new() end
    for _, p in ipairs(b.parts) do p.Anchored = false end
    if a.parent == nil then holder.Parent = workspace else holder.Parent = parentOf(a.parent) end
  else
    holder.PrimaryPart = handle
    holder.Parent = parentOf(a.parent)
  end
  holder:SetAttribute("WeaponKind", kind) holder:SetAttribute("TotalModelKit", MK.VERSION)
  local tipA = handle:FindFirstChild("Tip") local muzzle = handle:FindFirstChild("Muzzle")
  return okj({ kind = kind, style = key(a.style, "steel"), tool = asTool, parts = b.n, path = holder:GetFullName(), reach = math.floor((reach or 0) * 100) / 100, ranged = ranged,
    attachments = { tip = tipA and tipA:GetFullName() or nil, muzzle = muzzle and muzzle:GetFullName() or nil, blade_start = handle:FindFirstChild("BladeStart") and handle.BladeStart:GetFullName() or nil },
    next = asTool and "move the Tool to StarterPack to give it to every player; weapon_trail_enable {part: Handle path} for a slash trail; weapon_hitbox_create {part: Handle path, damage} for melee damage; pose it with the animation commands" or "re-run with as_tool=true for a wearable Tool" },
    ("%s built: %d parts%s at %s"):format(kind, b.n, asTool and " as a Tool (Handle + Grip set)" or "", holder:GetFullName()))
end
function CMD.furniture_build(a)
  local kind = key(a.kind, "sofa")
  local fn = F[kind]
  if not fn then error("unknown furniture kind " .. tostring(a.kind)) end
  if a.style == nil or a.style == "" then a.style = projectStyle("furniture") end
  local S = fstyle(a)
  local R = rootCF(a)
  local m = makeModel(a, "Furniture", kind)
  local b = newB(m, R, S)
  local root = fn(b, a, S)
  finish(b, m.Name, parentOf(a.parent), root or b.parts[1])
  m:SetAttribute("FurnitureKind", kind)
  local size = select(2, m:GetBoundingBox())
  return okj({ kind = kind, style = key(a.style, "modern"), parts = b.n, path = m:GetFullName(), bounds = { math.floor(size.X * 10) / 10, math.floor(size.Y * 10) / 10, math.floor(size.Z * 10) / 10 },
    next = "model_variant for seeded copies, model_detail {ops:[\"wear\"]} to age it, seat_create / proximity prompts for interaction" },
    ("%s built: %d parts at %s"):format(kind, b.n, m:GetFullName()))
end
function CMD.mesh_shape_create(a)
  local shape = key(a.shape or a.kind, "sphere")
  local gen = G[shape]
  if not gen then error("unknown shape " .. tostring(a.shape)) end
  local m = gen(a)
  if #m.f == 0 then error("shape produced no faces") end
  if #m.v > 60000 or #m.f > 20000 then error(("mesh too dense: %d vertices / %d faces (EditableMesh limit 60000 / 20000) - lower segments / rings / subdivisions"):format(#m.v, #m.f)) end
  local flat = a.shading ~= nil and key(a.shading) == "flat" or (a.shading == nil and (shape == "rock" or shape == "crystal" or shape == "prism" or shape == "star" or shape == "gear"))
  local col = rgb(a.color, C(163, 162, 165)) local mat = matOf(a.material, M.SmoothPlastic)
  local pos = vec(a.position, 0, 0, 0)
  local mn, mx = meshStats(m)
  local natural = mx - mn
  local part, err = MK.buildMesh(m, flat)
  local fallback = false
  if not part then
    fallback = true
    part = Instance.new("Part")
    local s = (shape == "sphere" or shape == "icosphere" or shape == "rock" or shape == "egg") and Enum.PartType.Ball or ((shape == "cylinder" or shape == "prism" or shape == "gear" or shape == "ring" or shape == "tube") and Enum.PartType.Cylinder or Enum.PartType.Block)
    part.Shape = s
    if s == Enum.PartType.Cylinder then part.Size = Vector3.new(natural.Y, natural.X, natural.Z) part.CFrame = CFrame.new(pos) * ROT_Y else part.Size = natural part.CFrame = CFrame.new(pos) end
  else
    part.CFrame = CFrame.new(pos)
  end
  part.Name = tostring(a.name or ("Mesh_" .. shape))
  part.Anchored = a.anchored ~= false part.Color = col part.Material = mat
  if a.transparency then part.Transparency = num(a.transparency, 0, 0, 1) end
  if type(a.size) == "table" and not fallback then
    local sz = vec(a.size, natural.X, natural.Y, natural.Z)
    pcall(function() part.Size = sz end)
  elseif a.scale and not fallback then
    local k = num(a.scale, 1, 0.01, 100) pcall(function() part.Size = part.Size * k end)
  end
  part:SetAttribute("MeshShape", shape) part:SetAttribute("TotalModelKit", MK.VERSION)
  if fallback then part:SetAttribute("MeshFallback", tostring(err)) end
  part.Parent = parentOf(a.parent)
  local data = { shape = shape, vertices = #m.v, faces = #m.f, shading = flat and "flat" or "smooth", path = part:GetFullName(), class = part.ClassName, fallback = fallback,
    natural_size = { math.floor(natural.X * 100) / 100, math.floor(natural.Y * 100) / 100, math.floor(natural.Z * 100) / 100 } }
  if fallback then data.error = tostring(err) data.note = "EditableMesh is not available here (needs the Studio EditableMesh beta / published-place permissions); a plain Part approximation was placed instead" end
  return okj(data, fallback and ("%s: EditableMesh unavailable (%s) - placed a %s Part approximation at %s"):format(shape, tostring(err), part.Shape.Name, part:GetFullName())
    or ("%s MeshPart created: %d vertices, %d triangles, %s shading at %s"):format(shape, #m.v, #m.f, flat and "flat" or "smooth", part:GetFullName()))
end
function CMD.model_detail(a)
  local target = findModel(a.path or a.model)
  local ops = {}
  if type(a.ops) == "table" then for _, o in ipairs(a.ops) do ops[#ops + 1] = key(o) end elseif a.op then ops = { key(a.op) } else ops = { "trim", "wear" } end
  local parts = {}
  if target:IsA("BasePart") then parts = { target } else for _, d in ipairs(target:GetDescendants()) do if d:IsA("BasePart") and d.Transparency < 1 and d.Name ~= "Trim" and d.Name ~= "Rivet" and d.Name ~= "Plank" and d.Name ~= "Moss" and d.Name ~= "Bevel" and d.Name ~= "Grime" then parts[#parts + 1] = d end end end
  if #parts == 0 then error("no parts under " .. target:GetFullName()) end
  local boxes = {} for _, p in ipairs(parts) do if isBox(p) then boxes[#boxes + 1] = p end end
  local S = styleOf(a, "medieval")
  local folder = target:IsA("BasePart") and target.Parent or target
  local holder = folder:FindFirstChild("Detail") or Instance.new("Folder")
  holder.Name = "Detail" holder.Parent = folder
  local b = newB(holder, CFrame.new(), S)
  b.n = 0
  MK.MAX_PARTS = num(a.budget, 600, 1, 1500)
  local R = rnd(a.seed or 11)
  local done = {}
  local budgetHit = false
  for _, op in ipairs(ops) do
    local fn = D[op]
    if not fn then error("unknown detail op " .. tostring(op) .. " (trim, rivets, planks, wear, bevel, moss)") end
    local before = b.n
    local okOp, n = pcall(fn, b, op == "wear" and parts or boxes, a, S, R)
    if okOp then done[op] = n
    elseif tostring(n):find("part budget") then done[op] = b.n - before budgetHit = true break
    else error(n) end
  end
  MK.MAX_PARTS = 1500
  local parts_added = b.n
  return okj({ path = target:GetFullName(), ops = done, parts_scanned = #parts, boxes = #boxes, parts_added = parts_added, budget = MK.num(a.budget, 600), budget_hit = budgetHit, detail_folder = holder:GetFullName(), note = "non-destructive: every added part lives in the Detail folder (delete it to undo); wear only recolours" },
    ("detail on %s: %s, %d parts added%s"):format(target.Name, HttpService:JSONEncode(done), parts_added, budgetHit and " (part budget reached - raise budget or run fewer ops)" or ""))
end
function CMD.model_variant(a)
  local src = findModel(a.path or a.model)
  if not src:IsA("Model") then error("path must be a Model (got " .. src.ClassName .. ")") end
  local count = math.floor(num(a.count, 3, 1, 12))
  local R = rnd(a.seed or 1)
  local spread = num(a.spacing, select(2, src:GetBoundingBox()).X + 6, 0, 500)
  local scaleR = type(a.scale) == "table" and { num(a.scale[1], 0.85), num(a.scale[2], 1.15) } or { 0.85, 1.15 }
  local hue = num(a.hue_shift, 20, 0, 180) / 360
  local valJ = num(a.value_jitter, 0.12, 0, 0.6)
  local dropP = num(a.drop_small, 0.25, 0, 1)
  local mirrorP = a.mirror == false and 0 or 0.5
  local out = {}
  local base = src:GetPivot()
  local parentNode = a.parent and parentOf(a.parent) or src.Parent
  local positions = type(a.positions) == "table" and a.positions or nil
  for i = 1, count do
    local c = src:Clone()
    c.Name = tostring(a.name or src.Name) .. "_v" .. i
    local sc = R(scaleR[1], scaleR[2])
    local sy = sc * R(0.92, 1.08)
    local hs = R(-hue, hue)
    local mirrored = R() < mirrorP
    local rotY = a.rotate == false and 0 or R(-1, 1) * math.rad(num(a.rotation_jitter, 15, 0, 180))
    local parts = {}
    for _, d in ipairs(c:GetDescendants()) do if d:IsA("BasePart") then parts[#parts + 1] = d end end
    local dropped = 0
    local vol = {}
    for _, p in ipairs(parts) do vol[#vol + 1] = p.Size.X * p.Size.Y * p.Size.Z end
    table.sort(vol)
    local smallCut = vol[math.max(1, math.floor(#vol * 0.3))] or 0
    for _, p in ipairs(parts) do
      local v = p.Size.X * p.Size.Y * p.Size.Z
      if p ~= c.PrimaryPart and v <= smallCut and #parts > 6 and R() < dropP * 0.5 then p:Destroy() dropped = dropped + 1
      else
        local rel = base:ToObjectSpace(p.CFrame)
        local px, py, pz = rel.X * sc, rel.Y * sy, rel.Z * sc
        if mirrored then px = -px end
        local rot = rel - rel.Position
        local newRel = CFrame.new(px, py, pz) * rot
        p.Size = Vector3.new(p.Size.X * sc, p.Size.Y * sy, p.Size.Z * sc)
        p.CFrame = base * newRel
        local h, s, v2 = p.Color:ToHSV()
        h = (h + hs) % 1
        v2 = clamp(v2 * (1 + R(-valJ, valJ)), 0, 1)
        if p.Material ~= Enum.Material.Neon and p.Material ~= Enum.Material.Glass then p.Color = Color3.fromHSV(h, s, v2) end
      end
    end
    local target
    if positions and positions[i] then target = CFrame.new(vec(positions[i], 0, 0, 0)) else target = CFrame.new(base.Position + Vector3.new(spread * i, 0, 0)) end
    c:PivotTo(target * CFrame.Angles(0, rotY, 0))
    c:SetAttribute("VariantSeed", a.seed or 1) c:SetAttribute("VariantIndex", i) c:SetAttribute("VariantScale", math.floor(sc * 1000) / 1000)
    c.Parent = parentNode
    out[#out + 1] = { name = c.Name, path = c:GetFullName(), scale = math.floor(sc * 1000) / 1000, hue_shift_deg = math.floor(hs * 3600) / 10, mirrored = mirrored, dropped_parts = dropped, rotation_deg = math.floor(math.deg(rotY) * 10) / 10 }
  end
  return okj({ source = src:GetFullName(), count = count, seed = a.seed or 1, variants = out, note = "each variant is a clone laid out along +X (or at positions[]); rebuildable from seed + settings" },
    ("%d variants of %s created (seed %s)"):format(count, src.Name, tostring(a.seed or 1)))
end
MK.CMD = CMD
function MK.run(op, a)
  local fn = CMD[op]
  if not fn then return failj("unknown modelkit command " .. tostring(op)) end
  local okR, res = pcall(fn, a or {})
  MK.MAX_PARTS = 1500
  if not okR then return failj("modelkit " .. op .. " failed: " .. tostring(res)) end
  return res
end
`;
  const FULL_LIB = (LIB + LIB2 + LIB3).replace("__VERSION__", VERSION);

  // -- JS side: commands, validation, builder -----------------------------
  const pt = (desc) => ({ type: "array", req: false, desc });
  const common = { position: pt("[x, y, z] ground point under the centre (default origin)"), rotation: { type: "number", req: false, desc: "yaw in degrees" }, name: { type: "string", req: false }, parent: { type: "string", req: false, desc: "path (default workspace)" } };
  const C = [
    { name: "structure_build", description: "Procedural buildings and structures with real door / window openings, roofs and interiors: house (floors, gable / hip / flat / shed roof, porch, chimney, interior stairs, lights), tower (round or square, battlements, cone roof, flag), castle_wall (walkway, merlons, end towers, stairs), gatehouse (arch + portcullis + towers), bridge (stone arches / rope / suspension), staircase, spiral_staircase, archway, fence (wood / picket / metal / stone along points), gate (optionally hinged), roof, dungeon_room (doorways, pillars, torches, props, cells), dock, watchtower, windmill (spinning sails via HingeConstraint motor), lighthouse (rotating beam), barn, pergola. 8 style palettes: medieval, rustic, modern, fantasy, scifi, desert, stone, industrial. Everything is anchored Parts / WedgeParts in one Model.",
      params: Object.assign({ kind: { type: "string", req: true, desc: "house|tower|castle_wall|gatehouse|bridge|staircase|spiral_staircase|archway|fence|gate|roof|dungeon_room|dock|watchtower|windmill|lighthouse|barn|pergola" },
        style: { type: "string", req: false, desc: "medieval|rustic|modern|fantasy|scifi|desert|stone|industrial" }, size: { type: "any", req: false, desc: "[width, height, depth] studs (or width / depth / height / length / radius separately)" },
        width: { type: "number", req: false }, depth: { type: "number", req: false }, height: { type: "number", req: false }, length: { type: "number", req: false }, radius: { type: "number", req: false },
        floors: { type: "number", req: false, desc: "house: 1-8" }, roof: { type: "string", req: false, desc: "house / roof: gable|hip|flat|shed|none; tower: cone|none" }, windows: { type: "number", req: false, desc: "windows per wall" }, door: { type: "boolean", req: false },
        color: { type: "any", req: false, desc: "wall colour [r,g,b] / name / hex" }, color2: { type: "any", req: false, desc: "roof / second colour" }, accent: { type: "any", req: false }, material: { type: "string", req: false, desc: "wall material override" },
        points: { type: "array", req: false, desc: "fence: [[x,z] or [x,y,z], ...] polyline" }, fence_style: { type: "string", req: false, desc: "fence: wood|picket|metal|stone" }, bridge_style: { type: "string", req: false, desc: "bridge: stone|rope|suspension" },
        steps: { type: "number", req: false }, step_height: { type: "number", req: false }, turns: { type: "number", req: false, desc: "spiral_staircase" }, doors: { type: "any", req: false, desc: "dungeon_room: [\"north\",\"south\",\"east\",\"west\"] or a count" },
        hinged: { type: "boolean", req: false, desc: "gate: physics hinges" }, spin: { type: "boolean", req: false, desc: "windmill sails (default true)" }, rotate: { type: "boolean", req: false, desc: "lighthouse beam (default true)" }, towers: { type: "boolean", req: false, desc: "castle_wall end towers" },
        lights: { type: "boolean", req: false }, interior: { type: "boolean", req: false }, porch: { type: "boolean", req: false }, chimney: { type: "boolean", req: false }, torches: { type: "boolean", req: false }, flag: { type: "any", req: false, desc: "tower: flag colour" }, seed: { type: "number", req: false } }, common) },
    { name: "vehicle_build", description: "Vehicles from Parts: car, truck, kart, buggy, boat, raft, plane, helicopter, tank, wagon (headlights with SpotLights, glass cabins, spinning propeller / rotors). drivable=true turns it into a working rig: unanchored welded body, VehicleSeat, HingeConstraint motor wheels with differential steering (land), buoyant hull + LinearVelocity / AngularVelocity drive (boat, raft) or hover drive (plane, helicopter), plus a small Drive Script - arcade physics, no suspension. Default is a static anchored model.",
      params: Object.assign({ kind: { type: "string", req: true, desc: "car|truck|kart|buggy|boat|raft|plane|helicopter|tank|wagon" }, drivable: { type: "boolean", req: false, desc: "VehicleSeat + motors + drive script (default false)" },
        length: { type: "number", req: false }, width: { type: "number", req: false }, wheel_radius: { type: "number", req: false }, color: { type: "any", req: false }, color2: { type: "any", req: false }, material: { type: "string", req: false },
        max_speed: { type: "number", req: false, desc: "studs/s (default 60 land, 40 water / air)" }, turn_speed: { type: "number", req: false, desc: "steer strength (default 0.6)" }, spoiler: { type: "boolean", req: false }, covered: { type: "boolean", req: false, desc: "truck / wagon canopy" }, sail: { type: "boolean", req: false, desc: "raft" } }, common) },
    { name: "weapon_build", description: "Weapons as Tools (Handle + Grip + Tip / BladeStart / Muzzle attachments, parts welded) or plain Models: sword, greatsword, dagger, katana, axe, battleaxe, mace, hammer, spear, bow, crossbow, staff, wand, shield, pistol, rifle, shotgun, sniper, bat, pickaxe. Styles: steel, iron, gold, dark, crystal (neon blade), wooden, scifi. Follow with weapon_trail_enable / weapon_hitbox_create on the Handle.",
      params: Object.assign({ kind: { type: "string", req: true, desc: "sword|greatsword|dagger|katana|axe|battleaxe|mace|hammer|spear|bow|crossbow|staff|wand|shield|pistol|rifle|shotgun|sniper|bat|pickaxe" }, style: { type: "string", req: false, desc: "steel|iron|gold|dark|crystal|wooden|scifi" },
        as_tool: { type: "boolean", req: false, desc: "wrap in a Tool (default true)" }, length: { type: "number", req: false, desc: "blade / haft length in studs" }, color: { type: "any", req: false, desc: "blade colour" }, color2: { type: "any", req: false, desc: "grip colour" }, accent: { type: "any", req: false },
        grip: { type: "string", req: false, desc: "forward (blade points ahead, default for melee) | up" }, tooltip: { type: "string", req: false }, droppable: { type: "boolean", req: false } }, common) },
    { name: "furniture_build", description: "Furniture beyond model_prefab: sofa, armchair, desk (with monitor), wardrobe, shelf (with items), stool, counter, bar_stool, fridge, oven, sink, bathtub, toilet, tv, floor_lamp (lit), bunk_bed, throne, piano. Styles: modern, rustic, royal, scifi, cozy.",
      params: Object.assign({ kind: { type: "string", req: true, desc: "sofa|armchair|desk|wardrobe|shelf|stool|counter|bar_stool|fridge|oven|sink|bathtub|toilet|tv|floor_lamp|bunk_bed|throne|piano" }, style: { type: "string", req: false, desc: "modern|rustic|royal|scifi|cozy" },
        width: { type: "number", req: false }, depth: { type: "number", req: false }, height: { type: "number", req: false }, color: { type: "any", req: false }, color2: { type: "any", req: false, desc: "cushion / screen colour" }, accent: { type: "any", req: false }, material: { type: "string", req: false }, seed: { type: "number", req: false } }, common) },
    { name: "mesh_shape_create", description: "Smooth EditableMesh primitives that Parts cannot make (real MeshPart via AssetService:CreateEditableMesh + CreateMeshPartAsync, smooth or flat normals): sphere, icosphere, torus, cone, capsule, cylinder, dome, ring, prism, star, gear, crystal, egg, rock (seeded low-poly), lathe (your own [radius,y] profile), tube (along points). Reports vertices / triangles; if EditableMesh is unavailable it places a Part approximation and says so (fallback=true).",
      params: Object.assign({ shape: { type: "string", req: true, desc: "sphere|icosphere|torus|cone|capsule|cylinder|dome|ring|prism|star|gear|crystal|egg|rock|lathe|tube" }, radius: { type: "number", req: false }, height: { type: "number", req: false }, inner_radius: { type: "number", req: false, desc: "ring / star / gear / torus tube" },
        segments: { type: "number", req: false, desc: "around (3-256)" }, rings: { type: "number", req: false, desc: "along (3-128)" }, sides: { type: "number", req: false, desc: "prism / crystal" }, points: { type: "any", req: false, desc: "star points, or tube [[x,y,z],...]" }, teeth: { type: "number", req: false }, subdivisions: { type: "number", req: false, desc: "icosphere / rock 0-4" },
        profile: { type: "array", req: false, desc: "lathe: [[radius, y], ...] top to bottom" }, roughness: { type: "number", req: false, desc: "rock 0-0.9" }, seed: { type: "number", req: false }, shading: { type: "string", req: false, desc: "smooth|flat" },
        size: { type: "any", req: false, desc: "[x,y,z] final size override" }, scale: { type: "number", req: false }, color: { type: "any", req: false }, material: { type: "string", req: false }, transparency: { type: "number", req: false }, anchored: { type: "boolean", req: false } }, common) },
    { name: "model_detail", description: "Non-destructive detail passes on an existing Model or Part (all new parts go to a Detail folder): trim (edge beams on top edges), rivets (bolt rows), planks (plank overlay on big faces), wear (seeded colour ageing + grime bands), bevel (wedge chamfers on top edges), moss (patches + drips). Use after structure_build / model_build / model_prefab.",
      params: { path: { type: "string", req: true, desc: "model path, e.g. workspace.Structure_house" }, ops: { type: "array", req: false, desc: "[\"trim\",\"rivets\",\"planks\",\"wear\",\"bevel\",\"moss\"] (default trim + wear)" }, color: { type: "any", req: false }, material: { type: "string", req: false }, amount: { type: "number", req: false, desc: "wear / moss 0-1" }, spacing: { type: "number", req: false }, thickness: { type: "number", req: false }, budget: { type: "number", req: false, desc: "max new parts (default 600)" }, seed: { type: "number", req: false }, style: { type: "string", req: false } } },
    { name: "model_variant", description: "Seeded variations of an existing Model (clones laid out along +X or at positions[]): per-variant uniform scale jitter, hue shift, value jitter, random mirror / yaw, small decorative parts dropped. Deterministic from seed; returns each variant's parameters.",
      params: { path: { type: "string", req: true, desc: "source model path" }, count: { type: "number", req: false, desc: "1-12 (default 3)" }, seed: { type: "number", req: false }, spacing: { type: "number", req: false, desc: "studs between variants" }, positions: { type: "array", req: false, desc: "[[x,y,z], ...] explicit placements" },
        scale: { type: "any", req: false, desc: "[min, max] (default [0.85, 1.15])" }, hue_shift: { type: "number", req: false, desc: "max degrees (default 20)" }, value_jitter: { type: "number", req: false }, drop_small: { type: "number", req: false, desc: "0-1 (default 0.25)" }, mirror: { type: "boolean", req: false }, rotate: { type: "boolean", req: false }, rotation_jitter: { type: "number", req: false }, name: { type: "string", req: false }, parent: { type: "string", req: false } } },
  ];
  const NAMES = C.map((c) => c.name);

  function validate(op, a) {
    const lower = (v) => String(v == null ? "" : v).toLowerCase().replace(/[\s-]/g, "_");
    if (op === "structure_build") {
      if (!a.kind) return "kind is required: " + STRUCTURES.join(", ");
      if (!STRUCTURES.includes(lower(a.kind))) return `unknown kind '${a.kind}' - use ${STRUCTURES.join(", ")}`;
      if (a.style != null && !STYLES.includes(lower(a.style))) return `unknown style '${a.style}' - use ${STYLES.join(", ")}`;
      if (a.roof != null && lower(a.kind) !== "tower" && lower(a.kind) !== "watchtower" && lower(a.kind) !== "castle_wall" && lower(a.kind) !== "gatehouse" && a.roof !== false && !ROOFS.includes(lower(a.roof))) return `roof must be ${ROOFS.join("|")}`;
      if (a.floors != null && !(Number(a.floors) >= 1 && Number(a.floors) <= 8)) return "floors must be 1-8";
      if (a.points != null && (!Array.isArray(a.points) || a.points.length < 2 || !a.points.every((p) => Array.isArray(p) && p.length >= 2 && p.slice(0, 3).every((n) => Number.isFinite(Number(n)))))) return "points must be [[x,z] or [x,y,z], ...] with at least 2 entries";
    }
    if (op === "vehicle_build") {
      if (!a.kind) return "kind is required: " + VEHICLES.join(", ");
      if (!VEHICLES.includes(lower(a.kind))) return `unknown kind '${a.kind}' - use ${VEHICLES.join(", ")}`;
    }
    if (op === "weapon_build") {
      if (!a.kind) return "kind is required: " + WEAPONS.join(", ");
      if (!WEAPONS.includes(lower(a.kind))) return `unknown kind '${a.kind}' - use ${WEAPONS.join(", ")}`;
      if (a.style != null && !WEAPON_STYLES.includes(lower(a.style))) return `unknown style '${a.style}' - use ${WEAPON_STYLES.join(", ")}`;
    }
    if (op === "furniture_build") {
      if (!a.kind) return "kind is required: " + FURNITURE.join(", ");
      if (!FURNITURE.includes(lower(a.kind))) return `unknown kind '${a.kind}' - use ${FURNITURE.join(", ")}`;
      if (a.style != null && !FURNITURE_STYLES.includes(lower(a.style))) return `unknown style '${a.style}' - use ${FURNITURE_STYLES.join(", ")}`;
    }
    if (op === "mesh_shape_create") {
      const shape = a.shape != null ? a.shape : a.kind;
      if (!shape) return "shape is required: " + SHAPES.join(", ");
      if (!SHAPES.includes(lower(shape))) return `unknown shape '${shape}' - use ${SHAPES.join(", ")}`;
      if (lower(shape) === "lathe" && (!Array.isArray(a.profile) || a.profile.length < 2)) return "lathe needs profile [[radius, y], ...] with at least 2 points";
      if (a.segments != null && !(Number(a.segments) >= 3 && Number(a.segments) <= 256)) return "segments must be 3-256";
      if (a.subdivisions != null && !(Number(a.subdivisions) >= 0 && Number(a.subdivisions) <= 4)) return "subdivisions must be 0-4";
      const segs = Number(a.segments || 32), rings = Number(a.rings || 16);
      if (segs * rings > 20000) return "segments x rings is too dense (EditableMesh limit 20000 triangles)";
    }
    if (op === "model_detail") {
      if (!a.path && !a.model) return "path is required";
      const ops = Array.isArray(a.ops) ? a.ops : a.op ? [a.op] : [];
      const bad = ops.filter((o) => !DETAIL_OPS.includes(lower(o)));
      if (bad.length) return `unknown ops [${bad.join(", ")}] - use ${DETAIL_OPS.join(", ")}`;
    }
    if (op === "model_variant") {
      if (!a.path && !a.model) return "path is required";
      if (a.count != null && !(Number(a.count) >= 1 && Number(a.count) <= 12)) return "count must be 1-12";
    }
    if (a.position != null && !Array.isArray(a.position)) return "position must be an array like [x, y, z]";
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
    const body = `local __a = HttpService:JSONDecode([==[${json}]==])\nreturn MK.run(${JSON.stringify(op)}, __a)`;
    return { code: FULL_LIB + "\n" + body, lib: FULL_LIB, body };
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
  RobloxScriptSkills.MODELKIT_COMMANDS = NAMES.slice();
  RobloxScriptSkills.MODELKIT_VERSION = VERSION;
  RobloxScriptSkills.MODELKIT_LIB = FULL_LIB;
  RobloxScriptSkills.MODELKIT_ENUMS = Object.freeze({ STRUCTURES, STYLES, ROOFS, VEHICLES, WEAPONS, WEAPON_STYLES, FURNITURE, FURNITURE_STYLES, SHAPES, DETAIL_OPS });
  RobloxScriptSkills.validateModelKit = validate;
})();
