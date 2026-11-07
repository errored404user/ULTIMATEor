// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript library pack (2.13.0) - reusable asset kits and the shared
// project style every generator reads.
//
//   kit_save {path, name?, tags?, category?, description?, replace?}
//       Copies one Model / Part / Folder / ScreenGui into
//       ServerStorage._TotalKits.<name> (Folder: attributes Total_Kit,
//       Total_Source, Total_Class, Total_Tags, Total_Category, Total_Desc,
//       Total_Count, Total_Size, Total_Time; child "Asset" = the clone).
//       Terrain / Camera / services / player characters / trees over 20000
//       descendants are refused. The kit is also a valid `template` for
//       environment_scatter and a source for model_variant.
//   kit_place {name, position|cframe|points, count?, spacing?, grid?, rotation?,
//              scale?, jitter?, seed?, snap_to_ground?, parent?, name_as?}
//       Clones the kit's Asset into the place at one or many slots: a single
//       position, a line (count + spacing along +X / direction), a grid
//       ([cols, rows]), or explicit points. scale uses Model:ScaleTo (parts
//       are resized around their pivot), rotation in degrees around Y (or
//       [x,y,z]), jitter randomises position / yaw / scale per slot with a
//       seed, snap_to_ground raycasts each slot down onto terrain / anchored
//       parts. Everything lands under one Model per call
//       (Workspace.Kits.<name>_<n> by default) so a bad batch is one delete.
//   kit_library {op:list|info|delete|tag|rename, name?, tags?, query?, category?}
//       Browse / curate the kit store.
//
//   project_style {op:set|get|clear|presets, preset?, genre?, primary?, ...}
//       ONE style record for the place (ServerStorage._TotalStyle, attributes)
//       that the other packs resolve their defaults from: model kit styles
//       (structure / weapon / furniture), the cinematic UI theme
//       (ReplicatedStorage.Total_Art.art_theme), the VFX default palette
//       (TotalVFX.DefaultPalette), the project brief palette + genre
//       (ServerStorage._TotalBrief, checked by quality_audit), lighting preset,
//       design tokens preset, terrain palette, materials and font. `set`
//       writes the record and the stores it can write directly, then lists
//       the follow-up commands for the two it cannot (style_lighting_apply,
//       design_tokens_set). `get` reports the record AND whether each
//       consumer store is in sync. Presets reference only ids that exist in
//       those packs (checked by tests/test-library-pack.js).
//
// Plain Lua syntax only (no +=, continue, ::) so tests/luau-parse-check.py and
// the mocked DataModel in tests/library-sim.py can run it.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;
  const VERSION = "2.13.0";
  const STORE = "_TotalKits";
  const STYLE_STORE = "_TotalStyle";
  const MAX_SAVE = 20000;
  const MAX_PLACE = 200;
  const KIT_OPS = ["list", "info", "delete", "tag", "rename"];
  const STYLE_OPS = ["set", "get", "clear", "presets"];

  // Every id below exists in the pack it targets (test-library-pack.js greps them):
  //   ui_theme    -> studio_artui   ui_art_theme_set.theme
  //   ui_tokens   -> studio_design  design_tokens_set.preset
  //   vfx         -> studio_vfxpro  vfx_theme_set.palette
  //   lighting    -> lighting_set_preset.preset
  //   model/weapon/furniture -> studio_modelkit STYLES / WSTYLES / FSTYLES
  //   terrain     -> studio_environment terrain_paint_biome.palette
  //   genre       -> studio_quality style_guide.genre
  const PRESETS = {
    medieval:   { genre: "medieval",   ui_theme: "dark_fantasy", ui_tokens: "royal_gold",  vfx: "ember",    lighting: "sunset_warm",     model: "medieval",   weapon: "iron",    furniture: "rustic", terrain: "temperate", material: "Cobblestone", trim_material: "WoodPlanks", font: "Garamond",    palette: ["#6b4a2b", "#8c8c86", "#c9a227", "#3b2f22", "#1b1511", "#e8dcc4"] },
    fantasy:    { genre: "fantasy",    ui_theme: "arcane",       ui_tokens: "royal_gold",  vfx: "arcane",   lighting: "fantasy_vibrant", model: "fantasy",    weapon: "crystal", furniture: "royal",  terrain: "temperate", material: "Marble",      trim_material: "Wood",       font: "Fantasy",     palette: ["#5b3fa6", "#2e8b6e", "#e0b23a", "#35425a", "#15121f", "#f1e9ff"] },
    scifi:      { genre: "scifi",      ui_theme: "scifi",        ui_tokens: "midnight",    vfx: "electric", lighting: "space_void",      model: "scifi",      weapon: "scifi",   furniture: "scifi",  terrain: "alien",     material: "Metal",       trim_material: "Neon",       font: "SciFi",       palette: ["#1f2a44", "#3a4a6b", "#2ee6ff", "#9aa6b8", "#0a0d16", "#e6f4ff"] },
    cyberpunk:  { genre: "cyberpunk",  ui_theme: "scifi",        ui_tokens: "neon",        vfx: "electric", lighting: "cyberpunk",       model: "industrial", weapon: "scifi",   furniture: "modern", terrain: "cave",      material: "Metal",       trim_material: "Neon",       font: "Code",        palette: ["#140a24", "#2a1a4a", "#ff2bd6", "#00e5ff", "#07030f", "#f5e6ff"] },
    horror:     { genre: "horror",     ui_theme: "horror",       ui_tokens: "horror",      vfx: "blood",    lighting: "horror_dark",     model: "stone",      weapon: "dark",    furniture: "rustic", terrain: "swamp",     material: "Concrete",    trim_material: "Wood",       font: "Creepster",   palette: ["#1a1a1a", "#3b2f2f", "#8b0000", "#5a5a52", "#050505", "#c7c2b8"] },
    cozy:       { genre: "cozy",       ui_theme: "cartoon",      ui_tokens: "clean_light", vfx: "nature",   lighting: "sunset_warm",     model: "rustic",     weapon: "wooden",  furniture: "cozy",   terrain: "autumn",    material: "WoodPlanks",  trim_material: "Fabric",     font: "Cartoon",     palette: ["#c9956b", "#7fa36a", "#e8a33d", "#d9cbb3", "#4a3a2a", "#fff6e8"] },
    nature:     { genre: "nature",     ui_theme: "hollow",       ui_tokens: "forest",      vfx: "nature",   lighting: "realistic_noon",  model: "rustic",     weapon: "wooden",  furniture: "rustic", terrain: "temperate", material: "Wood",        trim_material: "Grass",      font: "Merriweather", palette: ["#3f6b3a", "#7a5c3a", "#d6b84a", "#8f9a7a", "#1e2a1b", "#eef3e4"] },
    desert:     { genre: "desert",     ui_theme: "hollow",       ui_tokens: "royal_gold",  vfx: "dust",     lighting: "realistic_noon",  model: "desert",     weapon: "gold",    furniture: "royal",  terrain: "desert",    material: "Sandstone",   trim_material: "Wood",       font: "Garamond",    palette: ["#c9a46a", "#a66d3a", "#2a9d8f", "#e0cfa8", "#4a3520", "#fbf3e0"] },
    cartoon:    { genre: "cartoon",    ui_theme: "cartoon",      ui_tokens: "candy",       vfx: "holy",     lighting: "fantasy_vibrant", model: "modern",     weapon: "gold",    furniture: "cozy",   terrain: "temperate", material: "SmoothPlastic", trim_material: "SmoothPlastic", font: "FredokaOne", palette: ["#ff6b6b", "#4ecdc4", "#ffe66d", "#f7f7f7", "#2b2d42", "#ffffff"] },
    winter:     { genre: "winter",     ui_theme: "minimal_lux",  ui_tokens: "ocean",       vfx: "frost",    lighting: "overcast_moody",  model: "stone",      weapon: "steel",   furniture: "cozy",   terrain: "arctic",    material: "Ice",         trim_material: "Snow",       font: "Michroma",    palette: ["#9fc5e8", "#5d7f9a", "#e8f4ff", "#c9d6df", "#1f2f3a", "#ffffff"] },
    industrial: { genre: "industrial", ui_theme: "minimal_lux",  ui_tokens: "midnight",    vfx: "steel",    lighting: "overcast_moody",  model: "industrial", weapon: "steel",   furniture: "modern", terrain: "cave",      material: "DiamondPlate", trim_material: "Metal",     font: "Oswald",      palette: ["#4a4a4a", "#7a6a55", "#ff8c00", "#9a9a9a", "#1a1a1a", "#e0e0e0"] },
    luxury:     { genre: "city",       ui_theme: "minimal_lux",  ui_tokens: "royal_gold",  vfx: "holy",     lighting: "realistic_noon",  model: "modern",     weapon: "gold",    furniture: "royal",  terrain: "temperate", material: "Marble",      trim_material: "Metal",      font: "Michroma",    palette: ["#0f0f12", "#2b2b33", "#d4af37", "#8a8a94", "#000000", "#f6f1e7"] },
  };
  const PRESET_IDS = Object.keys(PRESETS);
  const ROLES = ["primary", "secondary", "accent", "neutral", "dark", "light"];
  const FIELDS = ["genre", "ui_theme", "ui_tokens", "vfx", "lighting", "model", "weapon", "furniture", "terrain", "material", "trim_material", "font"];
  // request-key -> record field (the model may use either spelling)
  const ALIASES = { ui_theme: "ui_theme", art_theme: "ui_theme", ui_tokens: "ui_tokens", tokens: "ui_tokens", design_tokens: "ui_tokens", vfx: "vfx", vfx_palette: "vfx", lighting: "lighting", lighting_preset: "lighting", model: "model", model_style: "model", weapon: "weapon", weapon_style: "weapon", furniture: "furniture", furniture_style: "furniture", terrain: "terrain", terrain_palette: "terrain", material: "material", trim_material: "trim_material", trim: "trim_material", font: "font", genre: "genre" };

  const LIB = String.raw`
local HttpService = game:GetService("HttpService")
local ServerStorage = game:GetService("ServerStorage")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")
local KT = {}
KT.VERSION = "__VERSION__"
local STORE = "__STORE__"
local STYLE_STORE = "__STYLE_STORE__"
local MAX_SAVE = __MAX_SAVE__
local MAX_PLACE = __MAX_PLACE__
local PRESETS = HttpService:JSONDecode([==[__PRESETS__]==])
local ROLES = { "primary", "secondary", "accent", "neutral", "dark", "light" }
local FIELDS = { "genre", "ui_theme", "ui_tokens", "vfx", "lighting", "model", "weapon", "furniture", "terrain", "material", "trim_material", "font" }
local function okj(d, t) return HttpService:JSONEncode({ ok = true, data = d or {}, text = t or "" }) end
local function failj(m) return HttpService:JSONEncode({ ok = false, error = tostring(m) }) end
local function resolve(path)
  if path == nil or path == "" then return nil end
  if tostring(path):lower() == "game" then return game end
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
local function countDesc(inst) local n = 0 for _, _d in ipairs(inst:GetDescendants()) do n = n + 1 end return n end
local function r2(v) return math.floor(v * 100 + 0.5) / 100 end
local function num(v, d) local n = tonumber(v) if n == nil then return d end return n end
local function vec3(v, d)
  if type(v) == "table" and #v == 3 then return Vector3.new(num(v[1], 0), num(v[2], 0), num(v[3], 0)) end
  if type(v) == "table" and v.x ~= nil then return Vector3.new(num(v.x, 0), num(v.y, 0), num(v.z, 0)) end
  return d
end
local function rng(seed)
  local s = math.floor(num(seed, 1)) % 2147483647
  if s <= 0 then s = s + 2147483646 end
  return function(lo, hi) s = (s * 48271) % 2147483647 local r = (s - 1) / 2147483646 if lo == nil then return r end return lo + (hi - lo) * r end
end
local function isCharacter(inst)
  local okC, res = pcall(function()
    for _, p in ipairs(Players:GetPlayers()) do if p.Character and (inst == p.Character or inst:IsDescendantOf(p.Character)) then return true end end
    return false
  end)
  return okC and res or false
end
local function store(create)
  local f = ServerStorage:FindFirstChild(STORE)
  if not f and create then f = Instance.new("Folder") f.Name = STORE f.Parent = ServerStorage end
  return f
end
local function kitOf(name)
  local f = store(false)
  if not f or name == nil then return nil end
  local k = f:FindFirstChild(tostring(name))
  if k and k:IsA("Folder") and k:FindFirstChild("Asset") then return k end
  return nil
end
local function splitTags(v)
  local out = {}
  if type(v) == "table" then for _, t in ipairs(v) do local s = tostring(t):lower():gsub("^%s+", ""):gsub("%s+$", "") if s ~= "" then out[#out + 1] = s end end
  elseif v ~= nil then for t in tostring(v):gmatch("[^,;%s]+") do out[#out + 1] = t:lower() end end
  return out
end
local function extents(inst)
  local okE, size = pcall(function()
    if inst:IsA("Model") then return inst:GetExtentsSize() end
    if inst:IsA("BasePart") then return inst.Size end
    local mn, mx = nil, nil
    for _, d in ipairs(inst:GetDescendants()) do
      if d:IsA("BasePart") then
        local p, s = d.Position, d.Size
        local a, b = p - s / 2, p + s / 2
        if not mn then mn, mx = a, b else mn = Vector3.new(math.min(mn.X, a.X), math.min(mn.Y, a.Y), math.min(mn.Z, a.Z)) mx = Vector3.new(math.max(mx.X, b.X), math.max(mx.Y, b.Y), math.max(mx.Z, b.Z)) end
      end
    end
    if mn then return mx - mn end
    return Vector3.new(0, 0, 0)
  end)
  if okE and size then return size end
  return Vector3.new(0, 0, 0)
end
local function kitInfo(k)
  local a = k:FindFirstChild("Asset")
  return {
    name = k.Name, class = k:GetAttribute("Total_Class"), source = k:GetAttribute("Total_Source"), tags = splitTags(k:GetAttribute("Total_Tags")),
    category = k:GetAttribute("Total_Category"), description = k:GetAttribute("Total_Desc"), descendants = k:GetAttribute("Total_Count"),
    size = k:GetAttribute("Total_Size"), age_s = os.time() - (tonumber(k:GetAttribute("Total_Time")) or os.time()), path = "ServerStorage." .. STORE .. "." .. k.Name,
    asset = a and a.ClassName or nil,
  }
end

-- ------------------------- kits -------------------------
function KT.save(a)
  if a.path == nil or a.path == "" then return failj("path is required (Model / Part / Folder / ScreenGui to save as a kit)") end
  local inst = resolve(a.path)
  if inst == game or inst.Parent == game then return failj("cannot save a service or the game as a kit - pick a Model, Part, Folder or ScreenGui") end
  if inst:IsA("Terrain") or inst:IsA("Camera") then return failj("cannot save " .. inst.ClassName .. " as a kit") end
  if isCharacter(inst) then return failj("cannot save a player character as a kit") end
  local n = countDesc(inst)
  if n > MAX_SAVE then return failj("kit too big: " .. n .. " descendants (max " .. MAX_SAVE .. ")") end
  local name = tostring(a.name or inst.Name):gsub("[^%w_%-%. ]", "")
  if name == "" then name = "kit_" .. os.time() end
  local f = store(true)
  local old = f:FindFirstChild(name)
  if old and a.replace == false then return failj("kit '" .. name .. "' already exists - pass replace:true or another name") end
  local okC, clone = pcall(function() return inst:Clone() end)
  if not okC or not clone then return failj("could not clone " .. inst:GetFullName() .. ": " .. tostring(clone)) end
  waypoint("TotalScript kit_save " .. name)
  if old then old:Destroy() end
  local k = Instance.new("Folder")
  k.Name = name
  clone.Parent = k
  local wrap = clone
  if not clone:IsA("Model") and not clone:IsA("BasePart") and not clone:IsA("LayerCollector") then
    -- Folders of parts become a Model so kit_place can pivot / scale them as one thing
    local m = Instance.new("Model") m.Name = clone.Name
    for _, c in ipairs(clone:GetChildren()) do c.Parent = m end
    clone:Destroy()
    wrap = m
    wrap.Parent = k
  end
  if wrap:IsA("Model") and not wrap.PrimaryPart then
    local best, bestV = nil, -1
    for _, d in ipairs(wrap:GetDescendants()) do if d:IsA("BasePart") then local v = d.Size.X * d.Size.Y * d.Size.Z if v > bestV then best, bestV = d, v end end end
    if best then wrap.PrimaryPart = best end
  end
  wrap.Name = "Asset"
  wrap:SetAttribute("Total_AssetName", inst.Name)
  local size = extents(wrap)
  k:SetAttribute("Total_Kit", KT.VERSION)
  k:SetAttribute("Total_Source", inst:GetFullName())
  k:SetAttribute("Total_Class", inst.ClassName)
  k:SetAttribute("Total_Tags", table.concat(splitTags(a.tags), ","))
  k:SetAttribute("Total_Category", tostring(a.category or ""))
  k:SetAttribute("Total_Desc", tostring(a.description or ""))
  k:SetAttribute("Total_Count", n)
  k:SetAttribute("Total_Size", string.format("%.1fx%.1fx%.1f", size.X, size.Y, size.Z))
  k:SetAttribute("Total_Time", os.time())
  k.Parent = f
  waypoint("TotalScript kit_save " .. name .. " done")
  local info = kitInfo(k)
  return okj(info, "KIT saved: '" .. name .. "' from " .. inst:GetFullName() .. " (" .. inst.ClassName .. ", " .. n .. " descendants, " .. info.size .. " studs) at ServerStorage." .. STORE .. "." .. name .. ". Place copies with kit_place {name:'" .. name .. "', position:[x,y,z]} (count / grid / points for many); environment_scatter {template:'ServerStorage." .. STORE .. "." .. name .. ".Asset'} spreads it over terrain.")
end

local function groundY(x, y, z, ignore)
  local okR, hit = pcall(function()
    local params = RaycastParams.new()
    params.FilterType = Enum.RaycastFilterType.Exclude
    params.FilterDescendantsInstances = ignore or {}
    return workspace:Raycast(Vector3.new(x, y + 500, z), Vector3.new(0, -1500, 0), params)
  end)
  if okR and hit then return hit.Position.Y end
  return nil
end

function KT.place(a)
  local k = kitOf(a.name)
  if not k then
    local f = store(false)
    local names = {}
    if f then for _, c in ipairs(f:GetChildren()) do names[#names + 1] = c.Name end end
    return failj("kit '" .. tostring(a.name) .. "' not found - kit_library {op:'list'}; saved kits: " .. (#names > 0 and table.concat(names, ", ") or "(none - kit_save first)"))
  end
  local asset = k:FindFirstChild("Asset")
  local parent = workspace
  if a.parent ~= nil and a.parent ~= "" then parent = resolve(a.parent) end
  -- slots
  local slots = {}
  local base = vec3(a.position, nil)
  local baseCF = nil
  if type(a.cframe) == "table" and #a.cframe >= 3 then baseCF = CFrame.new(num(a.cframe[1], 0), num(a.cframe[2], 0), num(a.cframe[3], 0)) base = baseCF.Position end
  if type(a.points) == "table" and #a.points > 0 then
    for i, p in ipairs(a.points) do if i > MAX_PLACE then break end local v = vec3(p, nil) if v then slots[#slots + 1] = v end end
  else
    if not base then return failj("position [x,y,z] (or cframe / points) is required") end
    local count = math.max(1, math.min(MAX_PLACE, math.floor(num(a.count, 1))))
    local size = extents(asset)
    local spacing = num(a.spacing, math.max(size.X, size.Z, 1) + 2)
    if type(a.grid) == "table" and #a.grid >= 1 then
      local cols = math.max(1, math.floor(num(a.grid[1], 1)))
      local rows = math.max(1, math.floor(num(a.grid[2], math.ceil(count / cols))))
      local total = math.min(MAX_PLACE, cols * rows)
      local sz = num(a.spacing_z, spacing)
      for i = 0, total - 1 do
        local cx, cz = i % cols, math.floor(i / cols)
        slots[#slots + 1] = base + Vector3.new(cx * spacing, 0, cz * sz)
      end
    else
      local dir = vec3(a.direction, Vector3.new(1, 0, 0))
      if dir.Magnitude == 0 then dir = Vector3.new(1, 0, 0) end
      dir = dir.Unit
      for i = 0, count - 1 do slots[#slots + 1] = base + dir * (i * spacing) end
    end
  end
  if #slots == 0 then return failj("no slots - give position, points or grid") end
  -- rotation / scale / jitter
  local rot = a.rotation
  local rx, ry, rz = 0, 0, 0
  if type(rot) == "table" then rx, ry, rz = num(rot[1], 0), num(rot[2], 0), num(rot[3], 0) elseif rot ~= nil then ry = num(rot, 0) end
  local scale = num(a.scale, 1)
  if scale <= 0 then scale = 1 end
  local jit = a.jitter
  local jPos, jYaw, jScale = 0, 0, 0
  if type(jit) == "table" then jPos, jYaw, jScale = num(jit.position or jit.pos or jit[1], 0), num(jit.rotation or jit.yaw or jit[2], 0), num(jit.scale or jit[3], 0)
  elseif jit == true then jPos, jYaw, jScale = 0.5, 180, 0.15
  elseif jit ~= nil then jPos = num(jit, 0) end
  local rand = rng(a.seed or 7)
  local group = Instance.new("Model")
  local baseName = tostring(a.name_as or (asset:GetAttribute("Total_AssetName") or k.Name))
  group.Name = (a.group_name and tostring(a.group_name)) or (k.Name .. "_" .. (#slots > 1 and "x" .. #slots or "placed"))
  local placed, snapped, skipped = {}, 0, 0
  waypoint("TotalScript kit_place " .. k.Name)
  for i, slot in ipairs(slots) do
    local c = asset:Clone()
    c.Name = #slots > 1 and (baseName .. "_" .. i) or baseName
    pcall(function() c:SetAttribute("Total_AssetName", nil) end)
    c:SetAttribute("Total_Kit", k.Name)
    local s = scale
    if jScale > 0 then s = s * (1 + rand(-jScale, jScale)) end
    local yaw = ry
    if jYaw > 0 then yaw = yaw + rand(-jYaw, jYaw) end
    local pos = slot
    if jPos > 0 then pos = pos + Vector3.new(rand(-jPos, jPos), 0, rand(-jPos, jPos)) end
    c.Parent = group
    local okS = pcall(function()
      if s ~= 1 then
        if c:IsA("Model") then c:ScaleTo(s)
        elseif c:IsA("BasePart") then c.Size = c.Size * s end
      end
    end)
    if not okS and s ~= 1 then skipped = skipped + 1 end
    local size = extents(c)
    local y = pos.Y
    if a.snap_to_ground == true then
      local gy = groundY(pos.X, pos.Y, pos.Z, { group, parent ~= workspace and parent or nil })
      if gy then y = gy + size.Y / 2 snapped = snapped + 1 end
    end
    local cf = CFrame.new(pos.X, y, pos.Z) * CFrame.Angles(math.rad(rx), math.rad(yaw), math.rad(rz))
    if baseCF and #slots == 1 and type(a.cframe) == "table" and #a.cframe >= 6 then
      cf = CFrame.new(num(a.cframe[1], 0), num(a.cframe[2], 0), num(a.cframe[3], 0)) * CFrame.Angles(math.rad(num(a.cframe[4], 0)), math.rad(num(a.cframe[5], 0)), math.rad(num(a.cframe[6], 0)))
    end
    pcall(function() c:PivotTo(cf) end)
    placed[#placed + 1] = { name = c.Name, position = { r2(cf.Position.X), r2(cf.Position.Y), r2(cf.Position.Z) }, scale = r2(s), yaw = r2(yaw) }
  end
  if #placed == 1 then
    -- a single copy does not need a wrapper Model
    local only = group:GetChildren()[1]
    only.Parent = parent
    group:Destroy()
    group = only
  else
    group.Parent = parent
    if group:IsA("Model") and not group.PrimaryPart then
      local first = group:GetChildren()[1]
      if first and first:IsA("Model") then group.PrimaryPart = first.PrimaryPart elseif first and first:IsA("BasePart") then group.PrimaryPart = first end
    end
  end
  waypoint("TotalScript kit_place " .. k.Name .. " done")
  return okj({ kit = k.Name, count = #placed, path = group:GetFullName(), placed = placed, snapped = snapped, scale_skipped = skipped },
    "PLACED " .. #placed .. " x '" .. k.Name .. "' at " .. group:GetFullName() .. (snapped > 0 and (" (" .. snapped .. " snapped to ground)") or "") .. (skipped > 0 and (" - " .. skipped .. " could not be scaled") or "") .. ". Verify with total_screenshot; undo by deleting that path or Ctrl+Z.")
end

function KT.library(a)
  local op = tostring(a.op or "list"):lower()
  local f = store(false)
  if op == "list" then
    local out = {}
    local q = a.query and tostring(a.query):lower() or nil
    local tag = a.tag and tostring(a.tag):lower() or nil
    local cat = a.category and tostring(a.category):lower() or nil
    if f then
      for _, k in ipairs(f:GetChildren()) do
        if k:IsA("Folder") and k:FindFirstChild("Asset") then
          local info = kitInfo(k)
          local hit = true
          if q and not (k.Name:lower():find(q, 1, true) or tostring(info.description or ""):lower():find(q, 1, true) or table.concat(info.tags, ","):find(q, 1, true)) then hit = false end
          if tag then local has = false for _, t in ipairs(info.tags) do if t == tag then has = true end end if not has then hit = false end end
          if cat and tostring(info.category or ""):lower() ~= cat then hit = false end
          if hit then out[#out + 1] = info end
        end
      end
    end
    table.sort(out, function(x, y) return x.age_s < y.age_s end)
    local names = {}
    for _, i in ipairs(out) do names[#names + 1] = i.name .. " (" .. tostring(i.class) .. ", " .. tostring(i.size) .. (#i.tags > 0 and (", " .. table.concat(i.tags, "/")) or "") .. ")" end
    return okj({ count = #out, kits = out, store = "ServerStorage." .. STORE }, #out > 0 and (#out .. " kit(s): " .. table.concat(names, "; ")) or "no kits saved yet - kit_save {path, name, tags} stores one")
  end
  if op == "info" then
    local k = kitOf(a.name)
    if not k then return failj("kit '" .. tostring(a.name) .. "' not found") end
    local info = kitInfo(k)
    local asset = k:FindFirstChild("Asset")
    local classes = {}
    for _, d in ipairs(asset:GetDescendants()) do classes[d.ClassName] = (classes[d.ClassName] or 0) + 1 end
    info.classes = classes
    return okj(info, "kit '" .. k.Name .. "': " .. tostring(info.class) .. " from " .. tostring(info.source) .. ", " .. tostring(info.descendants) .. " descendants, " .. tostring(info.size) .. " studs")
  end
  if op == "delete" then
    if not f then return okj({ removed = 0 }, "nothing to delete") end
    local n = 0
    if tostring(a.name) == "*" then
      for _, k in ipairs(f:GetChildren()) do k:Destroy() n = n + 1 end
    else
      local k = kitOf(a.name)
      if not k then return failj("kit '" .. tostring(a.name) .. "' not found") end
      k:Destroy() n = 1
    end
    return okj({ removed = n }, "removed " .. n .. " kit(s)")
  end
  if op == "tag" then
    local k = kitOf(a.name)
    if not k then return failj("kit '" .. tostring(a.name) .. "' not found") end
    local tags = splitTags(a.tags)
    if a.add == true then
      local cur = splitTags(k:GetAttribute("Total_Tags"))
      local seen = {}
      for _, t in ipairs(cur) do seen[t] = true end
      for _, t in ipairs(tags) do if not seen[t] then cur[#cur + 1] = t seen[t] = true end end
      tags = cur
    end
    k:SetAttribute("Total_Tags", table.concat(tags, ","))
    if a.category ~= nil then k:SetAttribute("Total_Category", tostring(a.category)) end
    if a.description ~= nil then k:SetAttribute("Total_Desc", tostring(a.description)) end
    return okj(kitInfo(k), "kit '" .. k.Name .. "' tags: " .. (#tags > 0 and table.concat(tags, ", ") or "(none)"))
  end
  if op == "rename" then
    local k = kitOf(a.name)
    if not k then return failj("kit '" .. tostring(a.name) .. "' not found") end
    local to = tostring(a.to or a.new_name or ""):gsub("[^%w_%-%. ]", "")
    if to == "" then return failj("rename needs to:'NewName'") end
    if f:FindFirstChild(to) then return failj("a kit named '" .. to .. "' already exists") end
    local from = k.Name
    k.Name = to
    return okj(kitInfo(k), "kit '" .. from .. "' renamed to '" .. to .. "'")
  end
  return failj("op must be list|info|delete|tag|rename")
end

-- ------------------------- project style -------------------------
local function hexToColor(h)
  local s = tostring(h or ""):gsub("#", "")
  if #s ~= 6 then return nil end
  local r, g, b = tonumber(s:sub(1, 2), 16), tonumber(s:sub(3, 4), 16), tonumber(s:sub(5, 6), 16)
  if not r or not g or not b then return nil end
  return Color3.fromRGB(r, g, b)
end
local function colorToHex(c)
  return string.format("#%02x%02x%02x", math.floor(c.R * 255 + 0.5), math.floor(c.G * 255 + 0.5), math.floor(c.B * 255 + 0.5))
end
local function styleFolder(create)
  local f = ServerStorage:FindFirstChild(STYLE_STORE)
  if not f and create then f = Instance.new("Folder") f.Name = STYLE_STORE f.Parent = ServerStorage end
  return f
end
local function readStyle()
  local f = styleFolder(false)
  if not f then return nil end
  local rec = { preset = f:GetAttribute("Preset"), palette = {}, updated = f:GetAttribute("Updated") }
  for _, k in ipairs(FIELDS) do rec[k] = f:GetAttribute(k) end
  for _, r in ipairs(ROLES) do local hx = f:GetAttribute(r .. "_hex") if hx then rec.palette[r] = hx end end
  return rec
end
local function syncReport(rec)
  local out = {}
  local art = ReplicatedStorage:FindFirstChild("Total_Art")
  local artTheme = art and art:GetAttribute("art_theme") or nil
  out[#out + 1] = { store = "ReplicatedStorage.Total_Art.art_theme", consumer = "ui_art_* (cinematic GUI)", wanted = rec.ui_theme, current = artTheme, in_sync = (rec.ui_theme == nil) or (artTheme == rec.ui_theme) }
  local vfx = ReplicatedStorage:FindFirstChild("TotalVFX")
  local vfxPal = vfx and vfx:GetAttribute("DefaultPalette") or nil
  out[#out + 1] = { store = "ReplicatedStorage.TotalVFX.DefaultPalette", consumer = "vfx_* (TotalVFX runtime)", wanted = rec.vfx, current = vfxPal, in_sync = (rec.vfx == nil) or (vfxPal == rec.vfx), note = (not vfx) and "runtime not installed yet - vfx_library_install will read the style" or nil }
  local brief = ServerStorage:FindFirstChild("_TotalBrief")
  local briefGenre = brief and brief:GetAttribute("Genre") or nil
  out[#out + 1] = { store = "ServerStorage._TotalBrief.genre/palette", consumer = "quality_audit palette check", wanted = rec.genre, current = briefGenre, in_sync = (rec.genre == nil) or (briefGenre == rec.genre) }
  out[#out + 1] = { store = "ServerStorage._TotalStyle.model/weapon/furniture", consumer = "structure_build / vehicle_build / weapon_build / furniture_build defaults", wanted = tostring(rec.model) .. "/" .. tostring(rec.weapon) .. "/" .. tostring(rec.furniture), current = "read live by the model kit", in_sync = true }
  local design = ReplicatedStorage:FindFirstChild("Total_Design")
  local tokens = design and design:FindFirstChild("Tokens") or nil
  out[#out + 1] = { store = "ReplicatedStorage.Total_Design.Tokens", consumer = "ui_build / screen_generate tokens", wanted = rec.ui_tokens, current = tokens and "installed (preset unknown)" or nil, in_sync = tokens ~= nil, note = "written by design_tokens_set {preset:'" .. tostring(rec.ui_tokens) .. "'} - not writable from here" }
  out[#out + 1] = { store = "Lighting", consumer = "lighting recipe", wanted = rec.lighting, current = nil, in_sync = false, note = "apply with style_lighting_apply {genre:'" .. tostring(rec.genre) .. "'} or lighting_set_preset {preset:'" .. tostring(rec.lighting) .. "'}" }
  return out
end
local function nextSteps(rec)
  local n = {}
  n[#n + 1] = "style_lighting_apply {genre:'" .. tostring(rec.genre) .. "'}  (or lighting_set_preset {preset:'" .. tostring(rec.lighting) .. "'})"
  n[#n + 1] = "design_tokens_set {preset:'" .. tostring(rec.ui_tokens) .. "'}  (UI tokens module)"
  n[#n + 1] = "vfx_library_install {}  (picks the style's palette '" .. tostring(rec.vfx) .. "' when installed after the style)"
  return n
end
function KT.style(a)
  local op = tostring(a.op or "set"):lower()
  if op == "presets" then
    local list = {}
    for id, p in pairs(PRESETS) do list[#list + 1] = { id = id, genre = p.genre, ui_theme = p.ui_theme, vfx = p.vfx, lighting = p.lighting, model = p.model, palette = p.palette } end
    table.sort(list, function(x, y) return x.id < y.id end)
    local ids = {}
    for _, p in ipairs(list) do ids[#ids + 1] = p.id end
    return okj({ presets = list }, "style presets: " .. table.concat(ids, ", ") .. " - project_style {op:'set', preset:'...'} applies one; any field can be overridden")
  end
  if op == "get" then
    local rec = readStyle()
    if not rec then return okj({ set = false, presets = (function() local ids = {} for id in pairs(PRESETS) do ids[#ids + 1] = id end table.sort(ids) return ids end)() }, "no project style set - project_style {op:'set', preset:'medieval'} (presets: " .. #(function() local t = {} for k in pairs(PRESETS) do t[#t + 1] = k end return t end)() .. ") or pass genre / colours directly") end
    rec.set = true
    rec.sync = syncReport(rec)
    rec.next = nextSteps(rec)
    local off = {}
    for _, s in ipairs(rec.sync) do if not s.in_sync then off[#off + 1] = s.store end end
    return okj(rec, "PROJECT STYLE '" .. tostring(rec.preset or rec.genre) .. "': genre " .. tostring(rec.genre) .. ", palette " .. tostring(rec.palette.primary) .. " / " .. tostring(rec.palette.secondary) .. " / accent " .. tostring(rec.palette.accent) .. ", UI " .. tostring(rec.ui_theme) .. " + tokens " .. tostring(rec.ui_tokens) .. ", VFX " .. tostring(rec.vfx) .. ", lighting " .. tostring(rec.lighting) .. ", models " .. tostring(rec.model) .. "/" .. tostring(rec.weapon) .. "/" .. tostring(rec.furniture) .. ", materials " .. tostring(rec.material) .. "+" .. tostring(rec.trim_material) .. ", font " .. tostring(rec.font) .. (#off > 0 and (". NOT in sync: " .. table.concat(off, ", ")) or ". All writable stores in sync") .. ".")
  end
  if op == "clear" then
    local f = styleFolder(false)
    if f then f:Destroy() end
    return okj({ cleared = f ~= nil }, f and "project style cleared (consumer stores left as they are)" or "no project style was set")
  end
  if op ~= "set" then return failj("op must be set|get|clear|presets") end
  local presetId = a.preset and tostring(a.preset):lower():gsub("[%s%-]", "_") or nil
  local base = nil
  if presetId then
    base = PRESETS[presetId]
    if not base then
      local ids = {}
      for id in pairs(PRESETS) do ids[#ids + 1] = id end
      table.sort(ids)
      return failj("unknown preset '" .. presetId .. "' - one of: " .. table.concat(ids, ", "))
    end
  end
  local cur = readStyle() or { palette = {} }
  local rec = { palette = {} }
  for _, k in ipairs(FIELDS) do rec[k] = (a[k] ~= nil and a[k] ~= "") and tostring(a[k]) or (base and base[k]) or cur[k] end
  for i, r in ipairs(ROLES) do
    local v = a[r]
    local hx = nil
    if type(v) == "table" and #v == 3 then
      local mx = math.max(num(v[1], 0), num(v[2], 0), num(v[3], 0))
      local c = mx <= 1 and Color3.new(num(v[1], 0), num(v[2], 0), num(v[3], 0)) or Color3.fromRGB(num(v[1], 0), num(v[2], 0), num(v[3], 0))
      hx = colorToHex(c)
    elseif v ~= nil and v ~= "" then
      if not hexToColor(v) then return failj(r .. " must be a hex colour like #c9a227 or [r,g,b]") end
      hx = "#" .. tostring(v):gsub("#", ""):lower()
    end
    rec.palette[r] = hx or (base and base.palette[i]) or cur.palette[r]
  end
  if not rec.genre and not presetId and not rec.palette.primary then return failj("set needs a preset, a genre or at least primary/accent colours") end
  rec.preset = presetId or cur.preset or (rec.genre and ("custom:" .. rec.genre)) or "custom"
  waypoint("TotalScript project_style set")
  local f = styleFolder(true)
  f:SetAttribute("TotalStyle", KT.VERSION)
  f:SetAttribute("Preset", rec.preset)
  f:SetAttribute("Updated", os.time())
  for _, k in ipairs(FIELDS) do f:SetAttribute(k, rec[k]) end
  for _, r in ipairs(ROLES) do
    local hx = rec.palette[r]
    f:SetAttribute(r .. "_hex", hx)
    local c = hexToColor(hx)
    if c then f:SetAttribute(r, c) end
  end
  local sv = f:FindFirstChild("Style")
  if not sv then sv = Instance.new("StringValue") sv.Name = "Style" sv.Parent = f end
  sv.Value = HttpService:JSONEncode(rec)
  -- fan-out to the stores the other packs read
  local applied = {}
  if a.apply ~= false then
    if rec.ui_theme then
      local art = ReplicatedStorage:FindFirstChild("Total_Art")
      if not art then art = Instance.new("Folder") art.Name = "Total_Art" art.Parent = ReplicatedStorage end
      art:SetAttribute("art_theme", rec.ui_theme)
      applied[#applied + 1] = "Total_Art.art_theme=" .. rec.ui_theme
    end
    if rec.vfx then
      local vfx = ReplicatedStorage:FindFirstChild("TotalVFX")
      if vfx then vfx:SetAttribute("DefaultPalette", rec.vfx) applied[#applied + 1] = "TotalVFX.DefaultPalette=" .. rec.vfx end
    end
    if rec.genre or rec.palette.primary then
      local b = ServerStorage:FindFirstChild("_TotalBrief")
      if not b then b = Instance.new("StringValue") b.Name = "_TotalBrief" b.Value = "{}" b.Parent = ServerStorage end
      local okJ, cur = pcall(function() return HttpService:JSONDecode(b.Value) end)
      if not okJ or type(cur) ~= "table" then cur = {} end
      if rec.genre then cur.genre = rec.genre cur.style = rec.genre end
      local pal = {}
      for _, r in ipairs(ROLES) do if rec.palette[r] then pal[#pal + 1] = rec.palette[r] end end
      if #pal > 0 then cur.palette = pal end
      if not cur.title or cur.title == "" then cur.title = tostring(rec.preset) end
      cur.updated_at = os.time()
      b.Value = HttpService:JSONEncode(cur)
      b:SetAttribute("Title", tostring(cur.title))
      b:SetAttribute("Genre", tostring(cur.genre or ""))
      applied[#applied + 1] = "_TotalBrief.genre/palette"
    end
  end
  waypoint("TotalScript project_style set done")
  rec.applied = applied
  rec.next = nextSteps(rec)
  rec.sync = syncReport(rec)
  return okj(rec, "PROJECT STYLE set: '" .. tostring(rec.preset) .. "' - genre " .. tostring(rec.genre) .. ", palette " .. tostring(rec.palette.primary) .. " / " .. tostring(rec.palette.secondary) .. " / accent " .. tostring(rec.palette.accent) .. ", UI theme " .. tostring(rec.ui_theme) .. ", tokens " .. tostring(rec.ui_tokens) .. ", VFX " .. tostring(rec.vfx) .. ", lighting " .. tostring(rec.lighting) .. ", models " .. tostring(rec.model) .. " / weapons " .. tostring(rec.weapon) .. " / furniture " .. tostring(rec.furniture) .. ", materials " .. tostring(rec.material) .. " + " .. tostring(rec.trim_material) .. ", font " .. tostring(rec.font) .. ". Written: " .. (#applied > 0 and table.concat(applied, ", ") or "record only") .. ". From now on structure_build / weapon_build / furniture_build / ui_art_* / vfx_library_install default to it. Still to run: " .. table.concat(rec.next, "; ") .. ".")
end

function KT.run(op, a)
  a = a or {}
  local okR, res = pcall(function()
    if op == "kit_save" then return KT.save(a) end
    if op == "kit_place" then return KT.place(a) end
    if op == "kit_library" then return KT.library(a) end
    if op == "project_style" then return KT.style(a) end
    return failj("unknown op " .. tostring(op))
  end)
  if okR then return res end
  return failj(res)
end
`.replace("__VERSION__", VERSION).replace("__STORE__", STORE).replace("__STYLE_STORE__", STYLE_STORE).replace("__MAX_SAVE__", String(MAX_SAVE)).replace("__MAX_PLACE__", String(MAX_PLACE)).replace("__PRESETS__", JSON.stringify(PRESETS));

  const C = [
    { name: "kit_save", description: "Save a Model / Part / Folder / ScreenGui as a reusable KIT in ServerStorage._TotalKits.<name> (clone + source / class / size / tags / category / description attributes; a Folder of parts becomes a Model with a PrimaryPart so it can be pivoted and scaled). Use it the moment a prop, building, enemy, pickup or UI panel looks right, then kit_place copies instead of regenerating. Refuses services, Terrain, Camera, player characters and trees over 20000 descendants. The kit is a valid environment_scatter template (ServerStorage._TotalKits.<name>.Asset).",
      params: {
        path: { type: "string", req: true, desc: "dotted path of the thing to save (e.g. 'Workspace.Lamp', 'Workspace.Props.Crate', 'StarterGui.ShopGui')" },
        name: { type: "string", req: false, desc: "kit name (default the instance name)" },
        tags: { type: "any", req: false, desc: "tags: 'prop,street,light' or ['prop','street']" },
        category: { type: "string", req: false, desc: "free category (prop | building | enemy | pickup | ui | vehicle | nature ...)" },
        description: { type: "string", req: false, desc: "one line for kit_library listings" },
        replace: { type: "boolean", req: false, desc: "overwrite an existing kit of that name (default true)" },
      } },
    { name: "kit_place", description: "Place copies of a saved kit: one position, a line (count + spacing + direction), a grid ([cols, rows]) or explicit points; rotation in degrees (Y or [x,y,z]), scale (Model:ScaleTo / part Size), jitter {position, rotation, scale} with a seed for natural variation, snap_to_ground raycasts each copy onto terrain / anchored parts. Many copies land in ONE wrapper Model (Workspace.<kit>_xN) so a bad batch is one delete; a single copy is placed directly. Max 200 per call.",
      params: {
        name: { type: "string", req: true, desc: "kit name from kit_save / kit_library" },
        position: { type: "any", req: false, desc: "[x,y,z] of the first copy (pivot)" },
        cframe: { type: "any", req: false, desc: "[x,y,z] or [x,y,z,rx,ry,rz] (degrees) for a single exact placement" },
        points: { type: "any", req: false, desc: "[[x,y,z], ...] explicit slots (overrides count / grid)" },
        count: { type: "number", req: false, desc: "copies along direction (default 1, max 200)" },
        spacing: { type: "number", req: false, desc: "studs between copies (default footprint + 2)" },
        direction: { type: "any", req: false, desc: "[x,y,z] line direction (default [1,0,0])" },
        grid: { type: "any", req: false, desc: "[cols, rows] grid from position (+X / +Z); spacing_z for the row gap" },
        rotation: { type: "any", req: false, desc: "degrees around Y, or [x,y,z]" },
        scale: { type: "number", req: false, desc: "uniform scale (default 1)" },
        jitter: { type: "any", req: false, desc: "true (0.5 studs / 180 deg / 15%) or {position, rotation, scale}" },
        seed: { type: "number", req: false, desc: "jitter seed (default 7)" },
        snap_to_ground: { type: "boolean", req: false, desc: "raycast each copy down onto terrain / anchored parts" },
        parent: { type: "string", req: false, desc: "parent path (default Workspace)" },
        name_as: { type: "string", req: false, desc: "name for the copies (default the saved instance name; _1.._N when many)" },
        group_name: { type: "string", req: false, desc: "name of the wrapper Model when count > 1" },
      } },
    { name: "kit_library", description: "Browse and curate the kit store: list (filter by query / tag / category, newest first), info (classes inside, size, source), delete (name or '*'), tag (set or add tags / category / description), rename.",
      params: {
        op: { type: "string", req: false, desc: "list|info|delete|tag|rename (default list)" },
        name: { type: "string", req: false, desc: "kit name (info / delete / tag / rename); '*' deletes all" },
        query: { type: "string", req: false, desc: "list: substring of name / description / tags" },
        tag: { type: "string", req: false, desc: "list: only kits with this tag" },
        category: { type: "string", req: false, desc: "list filter, or new category with op tag" },
        tags: { type: "any", req: false, desc: "tag: new tags ('a,b' or array)" },
        add: { type: "boolean", req: false, desc: "tag: add to the existing tags instead of replacing" },
        description: { type: "string", req: false, desc: "tag: new description" },
        to: { type: "string", req: false, desc: "rename: the new name" },
      } },
    { name: "project_style", description: "ONE art direction for the whole place (ServerStorage._TotalStyle) that the generators resolve their defaults from: set {preset: " + PRESET_IDS.join("|") + "} or any mix of genre / palette (primary, secondary, accent, neutral, dark, light as hex) / material + trim_material / font / ui_theme (ui_art_theme_set ids) / ui_tokens (design_tokens_set presets) / vfx (TotalVFX palette) / lighting (lighting_set_preset) / model + weapon + furniture (model kit styles) / terrain (terrain_paint_biome palette). set also writes the stores it can (Total_Art.art_theme, TotalVFX.DefaultPalette, the _TotalBrief genre + palette for quality_audit) and lists the follow-ups it cannot (style_lighting_apply, design_tokens_set). After it, structure_build / weapon_build / furniture_build / ui_art_* / vfx_library_install default to the style when you omit style / theme / palette. get shows the record and whether every consumer store is in sync; clear removes the record; presets lists them.",
      params: {
        op: { type: "string", req: false, desc: "set|get|clear|presets (default set)" },
        preset: { type: "string", req: false, desc: PRESET_IDS.join("|") },
        genre: { type: "string", req: false, desc: "style_guide genre (medieval, fantasy, scifi, cyberpunk, horror, cozy, nature, desert, winter, tropical, city, cartoon, candy, industrial, underwater, space)" },
        primary: { type: "any", req: false, desc: "hex '#6b4a2b' or [r,g,b]" },
        secondary: { type: "any", req: false, desc: "hex or [r,g,b]" },
        accent: { type: "any", req: false, desc: "hex or [r,g,b]" },
        neutral: { type: "any", req: false, desc: "hex or [r,g,b]" },
        dark: { type: "any", req: false, desc: "hex or [r,g,b]" },
        light: { type: "any", req: false, desc: "hex or [r,g,b]" },
        material: { type: "string", req: false, desc: "main Enum.Material name" },
        trim_material: { type: "string", req: false, desc: "trim Enum.Material name" },
        font: { type: "string", req: false, desc: "Enum.Font name for UI" },
        ui_theme: { type: "string", req: false, desc: "hollow|dark_fantasy|arcane|scifi|cartoon|horror|royal|minimal_lux|pixel" },
        ui_tokens: { type: "string", req: false, desc: "midnight|clean_light|candy|neon|royal_gold|forest|horror|ocean|sakura|retro" },
        vfx: { type: "string", req: false, desc: "ember|frost|arcane|holy|void|nature|toxic|electric|steel|blood|dust" },
        lighting: { type: "string", req: false, desc: "cyberpunk|sunset_warm|warm_night|horror_dark|fantasy_vibrant|overcast_moody|realistic_noon|vaporwave|space_void" },
        model: { type: "string", req: false, desc: "medieval|rustic|modern|fantasy|scifi|desert|stone|industrial" },
        weapon: { type: "string", req: false, desc: "steel|iron|gold|dark|crystal|wooden|scifi" },
        furniture: { type: "string", req: false, desc: "modern|rustic|royal|scifi|cozy" },
        terrain: { type: "string", req: false, desc: "temperate|desert|arctic|volcanic|swamp|autumn|alien|cave|jungle|savanna" },
        apply: { type: "boolean", req: false, desc: "also write the consumer stores (default true)" },
      } },
  ];
  const NAMES = C.map((c) => c.name);

  function validate(op, a) {
    if (op === "kit_save") {
      if (!a.path) return "path is required (the Model / Part / Folder / ScreenGui to save)";
      if (a.name != null && !/^[\w .\-]{1,80}$/.test(String(a.name))) return "name: letters, digits, space, _ - . (max 80)";
    }
    if (op === "kit_place") {
      if (!a.name) return "name is required (a kit from kit_save / kit_library)";
      const isVec = (v) => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => Number.isFinite(Number(n)));
      if (a.position != null && !isVec(a.position)) return "position must be [x,y,z]";
      if (a.cframe != null && !(isVec(a.cframe) && (a.cframe.length === 3 || a.cframe.length === 6))) return "cframe must be [x,y,z] or [x,y,z,rx,ry,rz]";
      if (a.points != null && !(Array.isArray(a.points) && a.points.length && a.points.every(isVec))) return "points must be [[x,y,z], ...]";
      if (a.position == null && a.cframe == null && a.points == null) return "give position [x,y,z], cframe or points";
      if (a.count != null && !(Number(a.count) >= 1 && Number(a.count) <= MAX_PLACE)) return `count must be 1-${MAX_PLACE}`;
      if (a.grid != null && !(Array.isArray(a.grid) && a.grid.length >= 1 && a.grid.every((n) => Number(n) >= 1))) return "grid must be [cols, rows]";
      if (a.scale != null && !(Number(a.scale) > 0 && Number(a.scale) <= 50)) return "scale must be > 0 and <= 50";
    }
    if (op === "kit_library") {
      const o = String(a.op || "list").toLowerCase();
      if (!KIT_OPS.includes(o)) return `op must be ${KIT_OPS.join("|")}`;
      if (o !== "list" && !a.name) return `${o} needs name`;
      if (o === "rename" && !(a.to || a.new_name)) return "rename needs to:'NewName'";
    }
    if (op === "project_style") {
      const o = String(a.op || "set").toLowerCase();
      if (!STYLE_OPS.includes(o)) return `op must be ${STYLE_OPS.join("|")}`;
      if (o === "set") {
        const p = a.preset != null ? String(a.preset).toLowerCase().replace(/[\s-]/g, "_") : null;
        if (p && !PRESETS[p]) return `unknown preset '${a.preset}' - one of: ${PRESET_IDS.join(", ")}`;
        for (const r of ROLES) {
          const v = a[r];
          if (v == null || v === "") continue;
          const okHex = typeof v === "string" && /^#?[0-9a-fA-F]{6}$/.test(v);
          const okVec = Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)));
          if (!okHex && !okVec) return `${r} must be a hex colour like #c9a227 or [r,g,b]`;
        }
        const hasAny = p || a.genre || ROLES.some((r) => a[r] != null && a[r] !== "") || FIELDS.some((k) => a[k] != null && a[k] !== "") || Object.keys(ALIASES).some((k) => a[k] != null && a[k] !== "");
        if (!hasAny) return `set needs a preset (${PRESET_IDS.join("|")}), a genre, colours or any style field`;
      }
    }
    return null;
  }

  function normalizeStyleArgs(a) {
    const out = Object.assign({}, a);
    for (const [k, field] of Object.entries(ALIASES)) if (a[k] != null && a[k] !== "" && out[field] == null) out[field] = a[k];
    return out;
  }

  function build(op, args) {
    if (!NAMES.includes(op)) return null;
    let a = args || {};
    const pre = validate(op, a);
    if (pre) return { err: `ERROR ${op}: ${pre}` };
    if (op === "project_style") a = normalizeStyleArgs(a);
    let json;
    try { json = JSON.stringify(a); } catch (e) { return { err: `ERROR ${op}: arguments are not serialisable` }; }
    if (json.includes("]==]")) return { err: `ERROR ${op}: arguments contain ']==]'` };
    const body = `local __a = HttpService:JSONDecode([==[${json}]==])\nreturn KT.run(${JSON.stringify(op)}, __a)`;
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
  RobloxScriptSkills.LIBRARY_COMMANDS = NAMES.slice();
  RobloxScriptSkills.LIBRARY_VERSION = VERSION;
  RobloxScriptSkills.LIBRARY_LIB = LIB;
  RobloxScriptSkills.STYLE_PRESETS = PRESETS;
  RobloxScriptSkills.validateLibrary = validate;
})();
