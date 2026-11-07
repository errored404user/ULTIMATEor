// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript environment pack (2.11.0) - procedural terrain, maps, water,
// biome painting, foliage / rock scatter and ground-following roads.
//
// Before this pack the agent could only FillBlock / FillBall a region of one
// material (terrain_fill_region, terrain_height ...) and the forest / road
// commands of the x100 pack were NOT_IMPLEMENTED stubs. Everything here is
// real Luau that runs in Studio through the normal skill path:
//
//   terrain_generate     fBm heightfield -> WriteVoxels, 12 biomes, water, slope / height materials
//   terrain_shape        mountain / hill / crater / plateau / valley / ridge / volcano / basin / dune / flatten / raise / lower on EXISTING terrain
//   terrain_path         river / canal / ravine / road / trail / ridge along smoothed waypoints
//   terrain_water        ocean / lake / pond (basin carve + fill) + Terrain water look
//   terrain_paint_biome  repaint existing terrain by height + slope rules (10 palettes), occupancy untouched
//   terrain_info         read-only survey: bounds, heights, material histogram, flat spots, water
//   environment_scatter  trees / rocks / bushes / grass / crystals ... on the real ground (raycast), or clone a template
//   road_build           part road along a spline that follows the ground (lines, curbs)
//   map_generate         one call: terrain + water + spawn + foliage + lighting from 12 presets
//
// The Luau is one shared library (ENV) + a tiny body per call, so main.js
// caches the library in Studio after the first run (runSkillLuau). Plain Lua
// syntax only (no +=, continue, ::) so tests/luau-parse-check.py and the
// mocked DataModel in tests/environment-sim.py can read it. Nothing here
// invents asset ids: every prop is built from Parts / WedgeParts.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;
  const VERSION = "2.11.0";

  const BIOMES = ["plains", "hills", "mountains", "island", "archipelago", "desert", "tundra", "canyon", "volcanic", "swamp", "mesa", "alpine"];
  const SHAPE_OPS = ["mountain", "hill", "crater", "plateau", "valley", "ridge", "volcano", "basin", "dune", "flatten", "raise", "lower"];
  const PATH_KINDS = ["river", "canal", "ravine", "road", "trail", "ridge"];
  const WATER_KINDS = ["ocean", "lake", "pond"];
  const PALETTES = ["temperate", "desert", "arctic", "volcanic", "swamp", "autumn", "alien", "cave", "jungle", "savanna"];
  const PROP_KINDS = ["pine", "oak", "birch", "palm", "dead_tree", "bush", "rock", "boulder", "grass", "flower", "mushroom", "cactus", "crystal", "log", "stump"];
  const MAP_PRESETS = ["island_survival", "green_valley", "arena", "archipelago", "canyon_run", "snow_peaks", "volcano", "swamp", "desert_oasis", "highlands", "lake_district", "crater"];
  const FOLIAGE = ["none", "light", "medium", "dense"];
  const ROAD_MATERIALS = ["Asphalt", "Concrete", "Cobblestone", "Ground", "WoodPlanks", "Brick", "Pavement", "Slate", "Sand"];

  // -- shared Luau library ------------------------------------------------
  const LIB = String.raw`
local HttpService = game:GetService("HttpService")
local Lighting = game:GetService("Lighting")
local Terrain = workspace.Terrain
local ENV = {}
ENV.VERSION = "__VERSION__"
ENV.RES = 4
ENV.MAX_COLUMNS = 512
ENV.MAX_VOXELS = 9000000
local AIR, WATER = Enum.Material.Air, Enum.Material.Water
local function okj(d, t) return HttpService:JSONEncode({ ok = true, data = d or {}, text = t or "" }) end
local function failj(m) return HttpService:JSONEncode({ ok = false, error = tostring(m) }) end
ENV.okj = okj ENV.failj = failj
local function num(v, d, lo, hi) local n = tonumber(v) if n == nil then n = d end if lo and n < lo then n = lo end if hi and n > hi then n = hi end return n end
local function vec(a, dx, dy, dz) if typeof(a) == "Vector3" then return a end if type(a) ~= "table" then return Vector3.new(dx or 0, dy or 0, dz or 0) end return Vector3.new(num(a[1], dx or 0), num(a[2], dy or 0), num(a[3], dz or 0)) end
local function snap(v) return math.floor(v / 4 + 0.5) * 4 end
local function clamp(v, a, b) if v < a then return a end if v > b then return b end return v end
local function smooth(t) t = clamp(t, 0, 1) return t * t * (3 - 2 * t) end
ENV.num = num ENV.vec = vec ENV.snap = snap ENV.clamp = clamp ENV.smooth = smooth

local MATS = { grass = "Grass", leafygrass = "LeafyGrass", rock = "Rock", sand = "Sand", water = "Water", snow = "Snow", mud = "Mud", ice = "Ice", basalt = "Basalt",
  lava = "CrackedLava", crackedlava = "CrackedLava", ground = "Ground", dirt = "Ground", asphalt = "Asphalt", concrete = "Concrete", slate = "Slate", limestone = "Limestone",
  sandstone = "Sandstone", salt = "Salt", pavement = "Pavement", brick = "Brick", cobblestone = "Cobblestone", woodplanks = "WoodPlanks", wood = "WoodPlanks", glacier = "Glacier", air = "Air" }
local function enumMat(n) local okE, v = pcall(function() return Enum.Material[n] end) if okE then return v end return nil end
function ENV.mat(name, default)
  if typeof(name) == "EnumItem" then return name end
  if name == nil or name == "" then return default end
  local key = MATS[tostring(name):lower():gsub("[%s_]", "")]
  local m = key and enumMat(key) or enumMat(tostring(name))
  return m or default
end

-- noise ----------------------------------------------------------------------
function ENV.fbm(x, z, seed, octaves, lac, gain)
  local amp, freq, sum, norm = 1, 1, 0, 0
  for o = 1, octaves do
    sum = sum + amp * math.noise(x * freq + seed * 0.731, z * freq - seed * 0.419, seed * 0.137 + o * 17.17)
    norm = norm + amp amp = amp * gain freq = freq * lac
  end
  return (sum / norm) * 2
end
function ENV.ridged(x, z, seed, octaves)
  local amp, freq, sum, norm = 1, 1, 0, 0
  for o = 1, octaves do
    local n = 1 - math.abs(math.noise(x * freq + seed * 0.37, z * freq + seed * 0.91, seed * 0.5 + o * 9.3)) * 2
    if n < 0 then n = 0 end
    sum = sum + n * n * amp norm = norm + amp amp = amp * 0.5 freq = freq * 2.1
  end
  return sum / norm
end

-- biomes ---------------------------------------------------------------------
ENV.BIOMES = {
  plains =      { amp = 10, scale = 240, octaves = 4, top = "Grass", slope = "Rock", under = "Ground", beach = "Sand", peak = "Snow", slopeTan = 1.1 },
  hills =       { amp = 28, scale = 200, octaves = 5, top = "Grass", slope = "Rock", under = "Ground", beach = "Sand", peak = "Snow", slopeTan = 1.0 },
  mountains =   { amp = 95, scale = 340, octaves = 6, ridged = 0.6, lift = 0.3, snowLine = 0.55, top = "Grass", slope = "Rock", under = "Rock", beach = "Sand", peak = "Snow", slopeTan = 0.9 },
  island =      { amp = 48, scale = 220, octaves = 5, mask = "island", sea = 0, water = true, beachBand = 6, top = "Grass", slope = "Rock", under = "Sandstone", beach = "Sand", peak = "Snow", snowLine = 0.9 },
  archipelago = { amp = 38, scale = 160, octaves = 5, mask = "archipelago", sea = 4, water = true, beachBand = 5, top = "LeafyGrass", slope = "Rock", under = "Sandstone", beach = "Sand", peak = "Snow" },
  desert =      { amp = 16, scale = 170, octaves = 3, dunes = true, top = "Sand", slope = "Sandstone", under = "Sandstone", beach = "Sand", peak = "Sand", slopeTan = 1.4 },
  tundra =      { amp = 20, scale = 210, octaves = 4, top = "Snow", slope = "Glacier", under = "Ice", beach = "Snow", peak = "Snow", slopeTan = 0.9 },
  canyon =      { amp = 64, scale = 280, octaves = 4, canyon = true, sea = -32, water = true, beachBand = 2, terrace = 10, top = "Sandstone", slope = "Rock", under = "Rock", beach = "Sand", peak = "Sandstone", slopeTan = 0.8 },
  volcanic =    { amp = 56, scale = 230, octaves = 5, volcano = true, top = "Basalt", slope = "Rock", under = "Rock", beach = "Basalt", peak = "Basalt", slopeTan = 1.0, lava = true },
  swamp =       { amp = 6, scale = 120, octaves = 4, sea = -0.5, water = true, beachBand = 3, top = "Mud", slope = "Ground", under = "Mud", beach = "Mud", peak = "Mud", slopeTan = 2 },
  mesa =        { amp = 42, scale = 250, octaves = 4, terrace = 11, top = "Sandstone", slope = "Rock", under = "Sandstone", beach = "Sand", peak = "Sandstone", slopeTan = 0.7 },
  alpine =      { amp = 72, scale = 300, octaves = 6, ridged = 0.5, lift = 0.35, sea = -10, water = true, beachBand = 3, snowLine = 0.5, top = "LeafyGrass", slope = "Rock", under = "Rock", beach = "Ground", peak = "Snow", slopeTan = 0.9 },
}

-- heightfield ------------------------------------------------------------------
-- o: cx, cz, sx, sz, base, amp, scale, octaves, seed, mask, ridged, terrace, dunes, canyon, volcano
function ENV.field(o)
  local res = ENV.RES
  local nx = clamp(math.floor(num(o.sx, 512, 16) / res + 0.5), 4, ENV.MAX_COLUMNS)
  local nz = clamp(math.floor(num(o.sz, 512, 16) / res + 0.5), 4, ENV.MAX_COLUMNS)
  local cx, cz = snap(num(o.cx, 0)), snap(num(o.cz, 0))
  local sx, sz = nx * res, nz * res
  local x0, z0 = snap(cx - sx / 2) + res / 2, snap(cz - sz / 2) + res / 2 -- grid-aligned region start even for an odd column count
  local seed = num(o.seed, 1)
  local amp, scale, oct = num(o.amp, 20, 0), math.max(8, num(o.scale, 200)), clamp(math.floor(num(o.octaves, 4)), 1, 8)
  local base = num(o.base, 0)
  local H, minH, maxH = {}, math.huge, -math.huge
  for i = 1, nx do
    local row = {}
    H[i] = row
    local wx = x0 + (i - 1) * res
    for j = 1, nz do
      local wz = z0 + (j - 1) * res
      local u, v = wx / scale, wz / scale
      local n = ENV.fbm(u, v, seed, oct, 2.0, 0.5)
      if o.ridged and o.ridged > 0 then n = n * (1 - o.ridged) + (ENV.ridged(u, v, seed, oct) * 2 - 1) * o.ridged end
      local h = n * amp
      if o.dunes then h = (math.abs(math.sin(u * 5 + n * 2.5)) - 0.5) * amp * 1.2 + n * amp * 0.4 end
      if o.canyon then local r = ENV.ridged(u * 0.55 + 3, v * 0.55 - 7, seed + 5, 3) local g = smooth(clamp((r - 0.3) / 0.6, 0, 1)) h = amp * 0.45 + n * amp * 0.25 - g * amp * 1.15 - r * r * amp * 0.3 end
      local mx, mz = (wx - cx) / (sx / 2), (wz - cz) / (sz / 2)
      local d = math.sqrt(mx * mx + mz * mz)
      if o.mask == "island" then
        local edge = smooth(1 - (d - 0.45) / 0.5)
        h = (h + amp * 0.55) * edge - amp * 0.6 * (1 - edge)
      elseif o.mask == "archipelago" then
        local m = ENV.fbm(u * 0.5 + 100, v * 0.5 + 100, seed + 9, 3, 2, 0.5)
        local edge = smooth(1 - (d - 0.75) / 0.25)
        h = h * 0.6 + (m * 1.4 - 0.25) * amp - (1 - edge) * amp
      end
      if o.volcano then
        local cone = clamp(1 - d / 0.85, 0, 1)
        local crater = clamp(1 - d / 0.2, 0, 1)
        h = h * 0.35 + cone * cone * amp * 1.7 - crater * crater * amp * 1.1
      end
      if o.terrace and o.terrace > 0 then
        local t = o.terrace
        local f = h / t
        local fl = math.floor(f)
        h = (fl + smooth((f - fl - 0.65) / 0.35)) * t
      end
      h = base + h + (o.lift or 0) * amp
      row[j] = h
      if h < minH then minH = h end
      if h > maxH then maxH = h end
    end
  end
  return { H = H, nx = nx, nz = nz, res = res, x0 = x0, z0 = z0, cx = cx, cz = cz, sx = sx, sz = sz, minH = minH, maxH = maxH }
end
function ENV.slopeAt(F, i, j)
  local H, res = F.H, F.res
  local i0, i1 = math.max(1, i - 1), math.min(F.nx, i + 1)
  local j0, j1 = math.max(1, j - 1), math.min(F.nz, j + 1)
  local dx = (H[i1][j] - H[i0][j]) / ((i1 - i0) * res)
  local dz = (H[i][j1] - H[i][j0]) / ((j1 - j0) * res)
  return math.sqrt(dx * dx + dz * dz)
end
-- material rules: p.top/slope/under/beach/peak (EnumItems), p.slopeTan, p.snowLine (abs y), p.sea (abs y or nil), p.beachBand
function ENV.topMat(F, i, j, h, p)
  if p.snowLine and h >= p.snowLine then return p.peak end
  if ENV.slopeAt(F, i, j) > (p.slopeTan or 1) then return p.slope end
  if p.sea and h <= p.sea + (p.beachBand or 0) then return p.beach end
  return p.top
end

-- surface read (existing terrain) -----------------------------------------------
-- Returns F with H (surface y per column), T (top material), has (had terrain), plus yMin/yMax
function ENV.surface(cx, cz, sx, sz, yMin, yMax)
  local res = ENV.RES
  local nx = clamp(math.floor(num(sx, 128, 8) / res + 0.5), 2, ENV.MAX_COLUMNS)
  local nz = clamp(math.floor(num(sz, 128, 8) / res + 0.5), 2, ENV.MAX_COLUMNS)
  cx, cz = snap(cx), snap(cz)
  yMin, yMax = snap(yMin), snap(yMax)
  if yMax - yMin < res * 2 then yMax = yMin + res * 2 end
  local wx0, wz0 = snap(cx - nx * res / 2), snap(cz - nz * res / 2)
  local F = { H = {}, T = {}, has = {}, nx = nx, nz = nz, res = res, x0 = wx0 + res / 2, z0 = wz0 + res / 2, cx = cx, cz = cz, sx = nx * res, sz = nz * res, yMin = yMin, yMax = yMax, minH = math.huge, maxH = -math.huge, count = 0, water = 0, hist = {} }
  for i = 1, nx do F.H[i] = {} F.T[i] = {} F.has[i] = {} end
  local chunk = 32
  for ci = 1, nx, chunk do
    for cj = 1, nz, chunk do
      local ni, nj = math.min(chunk, nx - ci + 1), math.min(chunk, nz - cj + 1)
      local region = Region3.new(Vector3.new(wx0 + (ci - 1) * res, yMin, wz0 + (cj - 1) * res), Vector3.new(wx0 + (ci - 1 + ni) * res, yMax, wz0 + (cj - 1 + nj) * res))
      local mats, occs = Terrain:ReadVoxels(region, res)
      local ny = mats.Size.Y
      for a = 1, ni do
        local i = ci + a - 1
        for b = 1, nj do
          local j = cj + b - 1
          local h, top = nil, nil
          for y = ny, 1, -1 do
            local m = mats[a][y][b]
            if m == WATER then F.water = F.water + 1
            elseif m ~= AIR and occs[a][y][b] > 0.02 then
              if not h then h = yMin + (y - 1) * res + occs[a][y][b] * res top = m end
              F.hist[m.Name] = (F.hist[m.Name] or 0) + 1
            end
          end
          F.has[i][j] = h ~= nil
          if h then F.count = F.count + 1 if h < F.minH then F.minH = h end if h > F.maxH then F.maxH = h end end
          F.H[i][j] = h or yMin
          F.T[i][j] = top
        end
      end
    end
  end
  if F.count == 0 then F.minH, F.maxH = yMin, yMin end
  return F
end

-- voxel write ------------------------------------------------------------------
-- F: field (H + optional T/has), p: floorY, topY, topAt(i,j,h) / underAt(i,j,h) -> EnumItem, water (abs y or nil),
-- fill (EnumItem for the water slot), keep (true = merge with existing voxels: solids below the new surface keep their material, water above it survives),
-- touch(i,j) -> bool (optional: columns that return false are left exactly as they are)
function ENV.write(F, p)
  local res = F.res
  local floorY = snap(p.floorY or (F.minH - 16))
  local topY = snap(p.topY or math.max(F.maxH, p.water or -math.huge)) + res * 2
  if topY <= floorY then topY = floorY + res end
  local ny = (topY - floorY) / res
  local total = F.nx * F.nz * ny
  if total > ENV.MAX_VOXELS then return nil, ("region is %.0f voxels (limit %d) - use a smaller size or height range"):format(total, ENV.MAX_VOXELS) end
  local chunk = 32
  local written, t0 = 0, os.clock()
  local wx0, wz0 = F.x0 - res / 2, F.z0 - res / 2
  local fillMat = p.fill or WATER
  for ci = 1, F.nx, chunk do
    for cj = 1, F.nz, chunk do
      local ni, nj = math.min(chunk, F.nx - ci + 1), math.min(chunk, F.nz - cj + 1)
      local region = Region3.new(Vector3.new(wx0 + (ci - 1) * res, floorY, wz0 + (cj - 1) * res), Vector3.new(wx0 + (ci - 1 + ni) * res, topY, wz0 + (cj - 1 + nj) * res))
      local mats, occs
      if p.keep then mats, occs = Terrain:ReadVoxels(region, res) else
        mats, occs = {}, {}
        for a = 1, ni do mats[a] = {} occs[a] = {} for y = 1, ny do mats[a][y] = {} occs[a][y] = {} for b = 1, nj do mats[a][y][b] = AIR occs[a][y][b] = 0 end end end
      end
      for a = 1, ni do
        local i = ci + a - 1
        for b = 1, nj do
          local j = cj + b - 1
          local h = F.H[i][j]
          local topM = (not p.touch or p.touch(i, j)) and p.topAt(i, j, h) or nil
          for y = 1, (topM and ny or 0) do
            local vy0 = floorY + (y - 1) * res
            local fill = (h - vy0) / res
            local oldM, oldO = mats[a][y][b], occs[a][y][b]
            local wasSolid = oldM ~= AIR and oldM ~= WATER and oldO > 0.02
            local m, occ
            if fill >= 1 then
              if h - vy0 > res * 1.5 then m = (p.keep and wasSolid) and oldM or p.underAt(i, j, h) else m = topM end
              occ = 1
            elseif fill > 0.04 then
              m, occ = topM, fill
            else
              m, occ = AIR, 0
              if p.water and vy0 < p.water then m = fillMat if vy0 + res <= p.water then occ = 1 else occ = (p.water - vy0) / res end
              elseif p.keep and oldM == WATER then m, occ = WATER, oldO end
            end
            mats[a][y][b] = m occs[a][y][b] = occ
          end
        end
      end
      Terrain:WriteVoxels(region, res, mats, occs)
      written = written + math.floor(ni * nj * ny + 0.5)
      if os.clock() - t0 > 0.4 then task.wait() t0 = os.clock() end
    end
  end
  return written, nil, floorY, topY
end

-- helpers for commands -------------------------------------------------------------
function ENV.rules(biome, overrides, base, amp)
  local o = overrides or {}
  local r = {}
  r.top = ENV.mat(o.top, ENV.mat(biome.top, Enum.Material.Grass))
  r.slope = ENV.mat(o.slope, ENV.mat(biome.slope, Enum.Material.Rock))
  r.under = ENV.mat(o.under, ENV.mat(biome.under, Enum.Material.Ground))
  r.beach = ENV.mat(o.beach, ENV.mat(biome.beach, Enum.Material.Sand))
  r.peak = ENV.mat(o.peak, ENV.mat(biome.peak, Enum.Material.Snow))
  r.slopeTan = num(o.slope_tan, biome.slopeTan or 1)
  r.beachBand = num(o.beach_band, biome.beachBand or 4)
  if o.snow_line ~= nil then r.snowLine = num(o.snow_line, nil) elseif biome.snowLine then r.snowLine = base + amp * biome.snowLine end
  return r
end
function ENV.flatSpots(F, sea, n)
  local best = {}
  local step = math.max(1, math.floor(F.nx / 48))
  for i = 3, F.nx - 2, step do
    for j = 3, F.nz - 2, step do
      local h = F.H[i][j]
      if (not sea) or h > sea + 3 then
        local lo, hi = h, h
        for di = -2, 2 do for dj = -2, 2 do local v = F.H[i + di][j + dj] if v < lo then lo = v end if v > hi then hi = v end end end
        local dx, dz = (i - F.nx / 2) / F.nx, (j - F.nz / 2) / F.nz
        local score = (hi - lo) + math.sqrt(dx * dx + dz * dz) * 6
        best[#best + 1] = { score = score, x = F.x0 + (i - 1) * F.res, z = F.z0 + (j - 1) * F.res, y = h, range = hi - lo, i = i, j = j }
      end
    end
  end
  table.sort(best, function(a, b) return a.score < b.score end)
  local out = {}
  for k = 1, math.min(n or 3, #best) do out[k] = best[k] end
  return out
end
function ENV.flattenField(F, x, z, radius, h)
  local res = F.res
  for i = 1, F.nx do
    local wx = F.x0 + (i - 1) * res
    for j = 1, F.nz do
      local wz = F.z0 + (j - 1) * res
      local d = math.sqrt((wx - x) ^ 2 + (wz - z) ^ 2)
      if d < radius * 1.6 then
        local t = smooth(1 - (d - radius) / (radius * 0.6))
        if d <= radius then t = 1 end
        F.H[i][j] = F.H[i][j] + (h - F.H[i][j]) * t
      end
    end
  end
end
function ENV.container(name)
  local root = workspace:FindFirstChild("Environment")
  if not root then root = Instance.new("Folder") root.Name = "Environment" root.Parent = workspace end
  if not name or name == "" then return root end
  local old = root:FindFirstChild(name)
  if old then old:Destroy() end
  local f = Instance.new("Folder") f.Name = name f.Parent = root
  return f
end
function ENV.groundAt(x, z, yTop, exclude)
  local params = RaycastParams.new()
  params.FilterType = Enum.RaycastFilterType.Exclude
  params.FilterDescendantsInstances = exclude or {}
  params.IgnoreWater = false
  local r = workspace:Raycast(Vector3.new(x, yTop, z), Vector3.new(0, -(yTop + 600), 0), params)
  if not r then return nil end
  return r.Position, r.Normal, r.Material, r.Instance
end
function ENV.spline(points, samples)
  local n = #points
  if n < 2 then return points end
  local pts = {}
  local function P(k) k = clamp(k, 1, n) return points[k] end
  local per = math.max(2, math.floor(samples / (n - 1)))
  for s = 1, n - 1 do
    local p0, p1, p2, p3 = P(s - 1), P(s), P(s + 1), P(s + 2)
    for k = 0, per - 1 do
      local t = k / per
      local t2, t3 = t * t, t * t * t
      pts[#pts + 1] = Vector3.new(
        0.5 * ((2 * p1.X) + (-p0.X + p2.X) * t + (2 * p0.X - 5 * p1.X + 4 * p2.X - p3.X) * t2 + (-p0.X + 3 * p1.X - 3 * p2.X + p3.X) * t3),
        0.5 * ((2 * p1.Y) + (-p0.Y + p2.Y) * t + (2 * p0.Y - 5 * p1.Y + 4 * p2.Y - p3.Y) * t2 + (-p0.Y + 3 * p1.Y - 3 * p2.Y + p3.Y) * t3),
        0.5 * ((2 * p1.Z) + (-p0.Z + p2.Z) * t + (2 * p0.Z - 5 * p1.Z + 4 * p2.Z - p3.Z) * t2 + (-p0.Z + 3 * p1.Z - 3 * p2.Z + p3.Z) * t3))
    end
  end
  pts[#pts + 1] = points[n]
  return pts
end
function ENV.points(list)
  local out = {}
  for _, p in ipairs(list or {}) do
    if type(p) == "table" then
      if #p >= 3 then out[#out + 1] = Vector3.new(num(p[1], 0), num(p[2], 0), num(p[3], 0))
      elseif #p == 2 then out[#out + 1] = Vector3.new(num(p[1], 0), 0 / 0, num(p[2], 0)) end
    end
  end
  return out
end
-- columns within R of a polyline: touch[i][j] = { d = distance, y = interpolated line y } (sparse, per segment bbox)
function ENV.rasterize(F, line, R)
  local res, touch = F.res, {}
  for k = 1, #line - 1 do
    local p0, p1 = line[k], line[k + 1]
    local i0 = clamp(math.floor((math.min(p0.X, p1.X) - R - F.x0) / res), 1, F.nx)
    local i1 = clamp(math.ceil((math.max(p0.X, p1.X) + R - F.x0) / res) + 1, 1, F.nx)
    local j0 = clamp(math.floor((math.min(p0.Z, p1.Z) - R - F.z0) / res), 1, F.nz)
    local j1 = clamp(math.ceil((math.max(p0.Z, p1.Z) + R - F.z0) / res) + 1, 1, F.nz)
    local abx, abz = p1.X - p0.X, p1.Z - p0.Z
    local l2 = abx * abx + abz * abz
    for i = i0, i1 do
      local wx = F.x0 + (i - 1) * res
      local row = touch[i]
      for j = j0, j1 do
        local wz = F.z0 + (j - 1) * res
        local t = 0
        if l2 > 0 then t = clamp(((wx - p0.X) * abx + (wz - p0.Z) * abz) / l2, 0, 1) end
        local px, pz = p0.X + abx * t, p0.Z + abz * t
        local d = math.sqrt((wx - px) ^ 2 + (wz - pz) ^ 2)
        if d < R then
          if not row then row = {} touch[i] = row end
          local e = row[j]
          if not e or d < e.d then row[j] = { d = d, y = p0.Y + (p1.Y - p0.Y) * t } end
        end
      end
    end
  end
  return touch
end

-- props ------------------------------------------------------------------------
local function part(parent, shape, size, cf, color, material, name)
  local p = Instance.new("Part")
  p.Name = name or "Part"
  p.Shape = shape or Enum.PartType.Block
  p.Size = size
  p.CFrame = cf
  p.Color = color
  p.Material = material or Enum.Material.SmoothPlastic
  p.Anchored = true
  p.CastShadow = true
  p.TopSurface = Enum.SurfaceType.Smooth
  p.BottomSurface = Enum.SurfaceType.Smooth
  p.Parent = parent
  return p
end
local function wedge(parent, size, cf, color, material)
  local w = Instance.new("WedgePart")
  w.Size = size w.CFrame = cf w.Color = color w.Material = material or Enum.Material.Grass w.Anchored = true w.Parent = parent
  return w
end
local function jitter(rng, c, amt)
  local h, s, v = c:ToHSV()
  return Color3.fromHSV((h + rng:NextNumber(-amt * 0.08, amt * 0.08)) % 1, clamp(s + rng:NextNumber(-amt * 0.25, amt * 0.25), 0, 1), clamp(v + rng:NextNumber(-amt * 0.3, amt * 0.3), 0, 1))
end
ENV.PALETTE = { leaf = Color3.fromRGB(58, 125, 52), leaf2 = Color3.fromRGB(86, 150, 60), trunk = Color3.fromRGB(96, 68, 44), rock = Color3.fromRGB(110, 110, 112), snow = Color3.fromRGB(236, 240, 245), flower = Color3.fromRGB(230, 90, 120), crystal = Color3.fromRGB(120, 200, 255), cactus = Color3.fromRGB(80, 140, 70) }
ENV.PROPS = {}
local PR = ENV.PROPS
function PR.pine(m, rng, s, pal, cf)
  local trunk = part(m, Enum.PartType.Cylinder, Vector3.new(7 * s, 0.9 * s, 0.9 * s), cf * CFrame.new(0, 3.5 * s, 0) * CFrame.Angles(0, 0, math.rad(90)), pal.trunk, Enum.Material.Wood, "Trunk")
  local leaf = jitter(rng, pal.leaf, 1)
  for k = 0, 3 do
    local r = (4.2 - k * 0.9) * s
    part(m, Enum.PartType.Cylinder, Vector3.new(1.6 * s, r, r), cf * CFrame.new(0, (3.2 + k * 1.7) * s, 0) * CFrame.Angles(0, 0, math.rad(90)), leaf, Enum.Material.Grass, "Leaves")
  end
  return trunk
end
function PR.oak(m, rng, s, pal, cf)
  local trunk = part(m, Enum.PartType.Cylinder, Vector3.new(6 * s, 1.3 * s, 1.3 * s), cf * CFrame.new(0, 3 * s, 0) * CFrame.Angles(0, 0, math.rad(90)), pal.trunk, Enum.Material.Wood, "Trunk")
  local leaf = jitter(rng, pal.leaf, 1)
  part(m, Enum.PartType.Ball, Vector3.new(7, 6, 7) * s, cf * CFrame.new(0, 8 * s, 0), leaf, Enum.Material.Grass, "Canopy")
  for k = 1, 3 do
    local a = k * 2.1 + rng:NextNumber(0, 1)
    part(m, Enum.PartType.Ball, Vector3.new(4.5, 4, 4.5) * s, cf * CFrame.new(math.cos(a) * 2.6 * s, (7 + rng:NextNumber(-0.5, 1)) * s, math.sin(a) * 2.6 * s), jitter(rng, pal.leaf2, 1), Enum.Material.Grass, "Canopy")
  end
  return trunk
end
function PR.birch(m, rng, s, pal, cf)
  local trunk = part(m, Enum.PartType.Cylinder, Vector3.new(9 * s, 0.7 * s, 0.7 * s), cf * CFrame.new(0, 4.5 * s, 0) * CFrame.Angles(0, 0, math.rad(90)), Color3.fromRGB(225, 225, 215), Enum.Material.SmoothPlastic, "Trunk")
  for k = 1, 4 do
    local a = k * 1.6
    part(m, Enum.PartType.Ball, Vector3.new(3.2, 2.6, 3.2) * s, cf * CFrame.new(math.cos(a) * 1.4 * s, (7 + k * 0.6) * s, math.sin(a) * 1.4 * s), jitter(rng, Color3.fromRGB(150, 190, 70), 1), Enum.Material.Grass, "Canopy")
  end
  return trunk
end
function PR.palm(m, rng, s, pal, cf)
  local lean = CFrame.Angles(0, rng:NextNumber(0, 6.28), math.rad(rng:NextNumber(6, 14)))
  local trunk
  for k = 0, 4 do
    trunk = part(m, Enum.PartType.Block, Vector3.new(0.9, 2, 0.9) * s, cf * lean * CFrame.new(0, (1 + k * 1.9) * s, 0), pal.trunk, Enum.Material.Wood, "Trunk")
  end
  local top = cf * lean * CFrame.new(0, 10.2 * s, 0)
  for k = 1, 6 do
    wedge(m, Vector3.new(1.2 * s, 0.3 * s, 5 * s), top * CFrame.Angles(0, k * 1.047, 0) * CFrame.new(0, 0, -2.6 * s) * CFrame.Angles(math.rad(-25), 0, 0), jitter(rng, pal.leaf2, 0.6), Enum.Material.Grass)
  end
  return trunk
end
function PR.dead_tree(m, rng, s, pal, cf)
  local c = Color3.fromRGB(70, 60, 52)
  local trunk = part(m, Enum.PartType.Cylinder, Vector3.new(8 * s, 1.1 * s, 1.1 * s), cf * CFrame.new(0, 4 * s, 0) * CFrame.Angles(0, 0, math.rad(90)), c, Enum.Material.Wood, "Trunk")
  for k = 1, 3 do
    part(m, Enum.PartType.Cylinder, Vector3.new(4 * s, 0.5 * s, 0.5 * s), cf * CFrame.new(0, (5 + k) * s, 0) * CFrame.Angles(0, k * 2.1, math.rad(40 + k * 10)) * CFrame.new(1.8 * s, 0, 0), c, Enum.Material.Wood, "Branch")
  end
  return trunk
end
function PR.bush(m, rng, s, pal, cf)
  local b
  for k = 1, 4 do
    local a = k * 1.57 + rng:NextNumber(0, 0.8)
    b = part(m, Enum.PartType.Ball, Vector3.new(2.4, 1.8, 2.4) * s, cf * CFrame.new(math.cos(a) * 0.8 * s, 0.8 * s, math.sin(a) * 0.8 * s), jitter(rng, pal.leaf2, 1), Enum.Material.Grass, "Bush")
  end
  return b
end
function PR.rock(m, rng, s, pal, cf)
  local r
  for k = 1, 2 do
    r = part(m, Enum.PartType.Block, Vector3.new(rng:NextNumber(1.6, 2.6), rng:NextNumber(1, 1.8), rng:NextNumber(1.6, 2.6)) * s, cf * CFrame.new((k - 1.5) * s, 0.5 * s, 0) * CFrame.Angles(rng:NextNumber(-0.3, 0.3), rng:NextNumber(0, 3), rng:NextNumber(-0.3, 0.3)), jitter(rng, pal.rock, 0.5), Enum.Material.Slate, "Rock")
  end
  return r
end
function PR.boulder(m, rng, s, pal, cf)
  local r = part(m, Enum.PartType.Ball, Vector3.new(rng:NextNumber(4, 6), rng:NextNumber(3, 4.5), rng:NextNumber(4, 6)) * s, cf * CFrame.new(0, 1.2 * s, 0) * CFrame.Angles(0, rng:NextNumber(0, 3), 0), jitter(rng, pal.rock, 0.5), Enum.Material.Rock, "Boulder")
  part(m, Enum.PartType.Block, Vector3.new(2.5, 1.5, 2.5) * s, cf * CFrame.new(2.4 * s, 0.6 * s, 1 * s) * CFrame.Angles(0.2, rng:NextNumber(0, 3), 0.1), jitter(rng, pal.rock, 0.5), Enum.Material.Slate, "Rock")
  return r
end
function PR.grass(m, rng, s, pal, cf)
  local g
  for k = 1, 5 do
    g = wedge(m, Vector3.new(0.25 * s, rng:NextNumber(0.9, 1.6) * s, 0.5 * s), cf * CFrame.Angles(0, k * 1.26 + rng:NextNumber(0, 0.5), 0) * CFrame.new(0.3 * s, 0.6 * s, 0) * CFrame.Angles(math.rad(rng:NextNumber(-15, 15)), 0, 0), jitter(rng, pal.leaf2, 0.8), Enum.Material.Grass)
  end
  return g
end
function PR.flower(m, rng, s, pal, cf)
  local stem = part(m, Enum.PartType.Cylinder, Vector3.new(1.2 * s, 0.15 * s, 0.15 * s), cf * CFrame.new(0, 0.6 * s, 0) * CFrame.Angles(0, 0, math.rad(90)), pal.leaf2, Enum.Material.Grass, "Stem")
  part(m, Enum.PartType.Ball, Vector3.new(0.7, 0.4, 0.7) * s, cf * CFrame.new(0, 1.3 * s, 0), jitter(rng, pal.flower, 1.5), Enum.Material.SmoothPlastic, "Petals")
  return stem
end
function PR.mushroom(m, rng, s, pal, cf)
  local stem = part(m, Enum.PartType.Cylinder, Vector3.new(1.4 * s, 0.6 * s, 0.6 * s), cf * CFrame.new(0, 0.7 * s, 0) * CFrame.Angles(0, 0, math.rad(90)), Color3.fromRGB(230, 220, 200), Enum.Material.SmoothPlastic, "Stem")
  part(m, Enum.PartType.Ball, Vector3.new(2, 1, 2) * s, cf * CFrame.new(0, 1.5 * s, 0), jitter(rng, Color3.fromRGB(190, 60, 50), 0.8), Enum.Material.SmoothPlastic, "Cap")
  return stem
end
function PR.cactus(m, rng, s, pal, cf)
  local body = part(m, Enum.PartType.Cylinder, Vector3.new(5 * s, 1.4 * s, 1.4 * s), cf * CFrame.new(0, 2.5 * s, 0) * CFrame.Angles(0, 0, math.rad(90)), jitter(rng, pal.cactus, 0.6), Enum.Material.Grass, "Body")
  for k = 1, 2 do
    local side = k == 1 and 1 or -1
    part(m, Enum.PartType.Cylinder, Vector3.new(2 * s, 0.9 * s, 0.9 * s), cf * CFrame.new(side * 1.3 * s, 2.8 * s, 0), pal.cactus, Enum.Material.Grass, "Arm")
    part(m, Enum.PartType.Cylinder, Vector3.new(2.2 * s, 0.9 * s, 0.9 * s), cf * CFrame.new(side * 2.1 * s, 4 * s, 0) * CFrame.Angles(0, 0, math.rad(90)), pal.cactus, Enum.Material.Grass, "Arm")
  end
  return body
end
function PR.crystal(m, rng, s, pal, cf)
  local c
  for k = 1, 4 do
    local h = rng:NextNumber(2.5, 5) * s
    c = part(m, Enum.PartType.Block, Vector3.new(0.9 * s, h, 0.9 * s), cf * CFrame.new(rng:NextNumber(-1, 1) * s, h / 2 - 0.3 * s, rng:NextNumber(-1, 1) * s) * CFrame.Angles(rng:NextNumber(-0.35, 0.35), rng:NextNumber(0, 3), rng:NextNumber(-0.35, 0.35)), jitter(rng, pal.crystal, 0.8), Enum.Material.Neon, "Crystal")
    c.Transparency = 0.15
  end
  local l = Instance.new("PointLight") l.Color = pal.crystal l.Range = 10 * s l.Brightness = 1.2 l.Parent = c
  return c
end
function PR.log(m, rng, s, pal, cf)
  return part(m, Enum.PartType.Cylinder, Vector3.new(6 * s, 1.3 * s, 1.3 * s), cf * CFrame.new(0, 0.65 * s, 0) * CFrame.Angles(0, rng:NextNumber(0, 3), 0), pal.trunk, Enum.Material.Wood, "Log")
end
function PR.stump(m, rng, s, pal, cf)
  return part(m, Enum.PartType.Cylinder, Vector3.new(1.4 * s, 1.8 * s, 1.8 * s), cf * CFrame.new(0, 0.7 * s, 0) * CFrame.Angles(0, 0, math.rad(90)), pal.trunk, Enum.Material.Wood, "Stump")
end

-- scatter ----------------------------------------------------------------------
-- o: kinds (list), count, cx, cz, sx, sz, seed, spacing, scaleMin, scaleMax, slopeMax (deg), avoidWater, onMaterials (set or nil), template (Instance or nil), container (Folder), palette (table), yTop, align
function ENV.scatter(o)
  local rng = Random.new(num(o.seed, 7))
  local kinds = o.kinds
  local count = clamp(math.floor(num(o.count, 60)), 1, 800)
  local sx, sz = math.max(8, num(o.sx, 200)), math.max(8, num(o.sz, 200))
  local cell = math.max(num(o.spacing, 0), math.sqrt((sx * sz) / (count * 1.8)))
  local nx, nz = math.max(1, math.floor(sx / cell)), math.max(1, math.floor(sz / cell))
  local cellX, cellZ = sx / nx, sz / nz
  local cells = {}
  for i = 0, nx - 1 do for j = 0, nz - 1 do cells[#cells + 1] = { i, j } end end
  for k = #cells, 2, -1 do local r = rng:NextInteger(1, k) cells[k], cells[r] = cells[r], cells[k] end
  local placed, skipped = 0, { water = 0, slope = 0, material = 0, air = 0 }
  local slopeCos = math.cos(math.rad(clamp(num(o.slopeMax, 35), 0, 89)))
  local pal = {}
  for k, v in pairs(ENV.PALETTE) do pal[k] = v end
  for k, v in pairs(o.palette or {}) do if typeof(v) == "Color3" then pal[k] = v end end
  local exclude = { o.container.Parent or o.container }
  local byKind = {}
  for _, c in ipairs(cells) do
    if placed >= count then break end
    local x = o.cx - sx / 2 + (c[1] + rng:NextNumber(0.15, 0.85)) * cellX
    local z = o.cz - sz / 2 + (c[2] + rng:NextNumber(0.15, 0.85)) * cellZ
    local pos, normal, material = ENV.groundAt(x, z, o.yTop or 400, exclude)
    local reason = nil
    if not pos then reason = "air"
    elseif o.avoidWater and material == WATER then reason = "water"
    elseif normal and normal.Y < slopeCos then reason = "slope"
    elseif o.onMaterials and material and not o.onMaterials[material.Name] then reason = "material" end
    if reason then skipped[reason] = skipped[reason] + 1 else
      local kind = kinds[rng:NextInteger(1, #kinds)]
      local s = rng:NextNumber(num(o.scaleMin, 0.8), num(o.scaleMax, 1.3))
      local cf = CFrame.new(pos) * CFrame.Angles(0, rng:NextNumber(0, 6.283), 0)
      if o.align and normal then local side = normal:Cross(Vector3.new(1, 0, 0)) if side.Magnitude < 0.01 then side = normal:Cross(Vector3.new(0, 0, 1)) end cf = CFrame.lookAlong(pos, side, normal) * CFrame.Angles(0, rng:NextNumber(0, 6.283), 0) end
      local model = Instance.new("Model")
      if o.template then
        local clone = o.template:Clone()
        model:Destroy()
        model = clone
        model.Name = o.template.Name
        if model:IsA("Model") then
          local okP = pcall(function() model:ScaleTo(s) end)
          model:PivotTo(cf * CFrame.new(0, (model:GetExtentsSize().Y / 2), 0))
        elseif model:IsA("BasePart") then model.CFrame = cf * CFrame.new(0, model.Size.Y / 2, 0) end
      else
        model.Name = kind
        local primary = PR[kind](model, rng, s, pal, cf)
        if primary then model.PrimaryPart = primary end
      end
      model:SetAttribute("EnvKind", kind) model:SetAttribute("EnvScale", s)
      model.Parent = o.container
      placed = placed + 1
      byKind[kind] = (byKind[kind] or 0) + 1
    end
  end
  return placed, skipped, byKind
end

-- lighting presets for map_generate ------------------------------------------
ENV.LIGHT = {
  island_survival = { clock = 13.5, ambient = { 110, 120, 125 }, outdoor = { 140, 150, 155 }, fogEnd = 1800, atmo = { density = 0.32, haze = 1.2, color = { 199, 205, 220 } }, clouds = { cover = 0.45, density = 0.6 } },
  green_valley = { clock = 10.5, ambient = { 105, 115, 105 }, outdoor = { 130, 140, 130 }, fogEnd = 2200, atmo = { density = 0.3, haze = 1.6, color = { 190, 205, 215 } }, clouds = { cover = 0.55, density = 0.55 } },
  arena = { clock = 12, ambient = { 120, 120, 120 }, outdoor = { 150, 150, 150 }, fogEnd = 3000, atmo = { density = 0.2, haze = 0.6, color = { 210, 215, 225 } }, clouds = { cover = 0.2, density = 0.4 } },
  archipelago = { clock = 15, ambient = { 115, 125, 135 }, outdoor = { 150, 160, 170 }, fogEnd = 2600, atmo = { density = 0.28, haze = 1.0, color = { 205, 215, 235 } }, clouds = { cover = 0.35, density = 0.5 } },
  canyon_run = { clock = 16.5, ambient = { 130, 110, 90 }, outdoor = { 170, 140, 110 }, fogEnd = 2400, atmo = { density = 0.36, haze = 2.0, color = { 230, 190, 150 } }, clouds = { cover = 0.15, density = 0.3 } },
  snow_peaks = { clock = 11, ambient = { 125, 135, 150 }, outdoor = { 160, 170, 190 }, fogEnd = 1500, atmo = { density = 0.42, haze = 2.4, color = { 215, 225, 240 } }, clouds = { cover = 0.7, density = 0.7 } },
  volcano = { clock = 18.2, ambient = { 90, 60, 50 }, outdoor = { 120, 80, 60 }, fogEnd = 900, atmo = { density = 0.5, haze = 3.0, color = { 120, 70, 50 } }, clouds = { cover = 0.8, density = 0.8, color = { 70, 45, 40 } } },
  swamp = { clock = 7.5, ambient = { 90, 100, 85 }, outdoor = { 110, 125, 105 }, fogEnd = 500, atmo = { density = 0.55, haze = 3.4, color = { 150, 170, 140 } }, clouds = { cover = 0.9, density = 0.7 } },
  desert_oasis = { clock = 14, ambient = { 140, 125, 100 }, outdoor = { 190, 170, 140 }, fogEnd = 2800, atmo = { density = 0.3, haze = 1.8, color = { 240, 215, 170 } }, clouds = { cover = 0.1, density = 0.3 } },
  highlands = { clock = 9, ambient = { 100, 110, 115 }, outdoor = { 130, 140, 145 }, fogEnd = 1700, atmo = { density = 0.38, haze = 2.2, color = { 185, 200, 215 } }, clouds = { cover = 0.65, density = 0.6 } },
  lake_district = { clock = 8, ambient = { 110, 118, 125 }, outdoor = { 145, 150, 160 }, fogEnd = 1400, atmo = { density = 0.4, haze = 2.6, color = { 200, 210, 225 } }, clouds = { cover = 0.5, density = 0.5 } },
  crater = { clock = 17.5, ambient = { 110, 100, 95 }, outdoor = { 150, 130, 120 }, fogEnd = 2000, atmo = { density = 0.34, haze = 1.5, color = { 210, 180, 160 } }, clouds = { cover = 0.3, density = 0.4 } },
}
function ENV.applyLight(name)
  local L = ENV.LIGHT[name]
  if not L then return false end
  Lighting.ClockTime = L.clock
  Lighting.Ambient = Color3.fromRGB(L.ambient[1], L.ambient[2], L.ambient[3])
  Lighting.OutdoorAmbient = Color3.fromRGB(L.outdoor[1], L.outdoor[2], L.outdoor[3])
  Lighting.FogEnd = L.fogEnd
  Lighting.FogStart = L.fogEnd * 0.35
  Lighting.FogColor = Color3.fromRGB(L.atmo.color[1], L.atmo.color[2], L.atmo.color[3])
  local atmo = Lighting:FindFirstChildOfClass("Atmosphere") or Instance.new("Atmosphere")
  atmo.Density = L.atmo.density atmo.Haze = L.atmo.haze atmo.Color = Color3.fromRGB(L.atmo.color[1], L.atmo.color[2], L.atmo.color[3]) atmo.Decay = Color3.fromRGB(L.atmo.color[1] * 0.6, L.atmo.color[2] * 0.6, L.atmo.color[3] * 0.6) atmo.Glare = 0.15 atmo.Offset = 0.2
  atmo.Parent = Lighting
  local clouds = Terrain:FindFirstChildOfClass("Clouds") or Instance.new("Clouds")
  clouds.Cover = L.clouds.cover clouds.Density = L.clouds.density
  if L.clouds.color then clouds.Color = Color3.fromRGB(L.clouds.color[1], L.clouds.color[2], L.clouds.color[3]) else clouds.Color = Color3.fromRGB(255, 255, 255) end
  clouds.Enabled = true clouds.Parent = Terrain
  return true
end

-- =======================================================================
-- commands
-- =======================================================================
local CMD = {}
ENV.CMD = CMD

function CMD.terrain_generate(a)
  local biomeName = tostring(a.biome or "hills"):lower()
  local biome = ENV.BIOMES[biomeName]
  if not biome then return failj("unknown biome '" .. biomeName .. "' - use plains, hills, mountains, island, archipelago, desert, tundra, canyon, volcanic, swamp, mesa or alpine") end
  local c = vec(a.center, 0, 0, 0)
  local size = a.size
  local sx, sz = 512, 512
  if type(size) == "table" then sx, sz = num(size[1], 512), num(size[2] or size[3], 512) elseif tonumber(size) then sx, sz = tonumber(size), tonumber(size) end
  if sx > ENV.MAX_COLUMNS * 4 or sz > ENV.MAX_COLUMNS * 4 then return failj(("size %.0fx%.0f is above the %d stud limit per axis - generate the map in tiles (several calls with different centers)"):format(sx, sz, ENV.MAX_COLUMNS * 4)) end
  local amp = num(a.height, biome.amp, 0, 400)
  local base = c.Y
  local F = ENV.field({ cx = c.X, cz = c.Z, sx = sx, sz = sz, base = base, amp = amp, scale = num(a.scale, biome.scale, 8), octaves = num(a.octaves, biome.octaves), seed = num(a.seed, 1),
    mask = biome.mask, ridged = biome.ridged, terrace = biome.terrace, dunes = biome.dunes, canyon = biome.canyon, volcano = biome.volcano, lift = biome.lift })
  local water = biome.water or false
  if a.water ~= nil then water = a.water and true or false end
  local sea = nil
  if water then sea = (a.sea_level ~= nil) and num(a.sea_level, base) or (base + (biome.sea or 0)) end
  local rules = ENV.rules(biome, a.materials, base, amp)
  rules.sea = sea
  local written, err = ENV.write(F, {
    floorY = F.minH - num(a.depth, 16, 4, 200), water = sea, keep = false,
    topAt = function(i, j, h) return ENV.topMat(F, i, j, h, rules) end,
    underAt = function() return rules.under end,
  })
  if not written then return failj(err) end
  local lavaPool = nil
  if biome.lava and biome.volcano then
    local craterH = F.H[math.floor(F.nx / 2)][math.floor(F.nz / 2)]
    local lavaY = craterH + 6
    local r = math.min(sx, sz) * 0.09
    Terrain:FillCylinder(CFrame.new(F.cx, lavaY - 3, F.cz), 6, r, Enum.Material.CrackedLava)
    lavaPool = { x = F.cx, y = math.floor(lavaY * 10) / 10, z = F.cz, radius = math.floor(r) }
  end
  local spots = ENV.flatSpots(F, sea, 3)
  local flat = {}
  for k, s in ipairs(spots) do flat[k] = { x = math.floor(s.x), y = math.floor(s.y * 10) / 10, z = math.floor(s.z), range = math.floor(s.range * 10) / 10 } end
  local root = ENV.container(nil)
  root:SetAttribute("TerrainBiome", biomeName) root:SetAttribute("TerrainSeed", num(a.seed, 1)) root:SetAttribute("TerrainCenter", Vector3.new(F.cx, base, F.cz)) root:SetAttribute("TerrainSize", Vector3.new(F.sx, amp, F.sz))
  return okj({ biome = biomeName, seed = num(a.seed, 1), columns = F.nx * F.nz, voxels = written, size = { F.sx, F.sz }, center = { F.cx, base, F.cz },
    min_height = math.floor(F.minH * 10) / 10, max_height = math.floor(F.maxH * 10) / 10, sea_level = sea, water = water, lava = lavaPool,
    materials = { top = rules.top.Name, slope = rules.slope.Name, under = rules.under.Name, beach = rules.beach.Name, peak = rules.peak.Name, snow_line = rules.snowLine },
    flat_spots = flat, note = "Terrain in the region was replaced (WriteVoxels). Same seed + size + center rebuilds the same ground. Next: environment_scatter for trees / rocks, terrain_path for rivers and roads, terrain_info to read it back." },
    ("generated %s terrain %.0fx%.0f studs (heights %.0f to %.0f%s)"):format(biomeName, F.sx, F.sz, F.minH, F.maxH, sea and (", water at " .. sea) or ""))
end

-- shape delta functions (d = distance / radius, 0 at centre)
local SHAPES = {}
SHAPES.mountain = function(d, h, n) return (smooth(1 - d) ^ 1.6 + n * 0.12 * smooth(1 - d)) * h end
SHAPES.hill = function(d, h) return smooth(1 - d) * h end
SHAPES.crater = function(d, h) local rim = clamp(1 - math.abs(d - 0.85) / 0.25, 0, 1) return -smooth(1 - d / 0.85) * h + rim * rim * h * 0.3 end
SHAPES.plateau = function(d, h) if d < 0.75 then return h end return smooth(1 - (d - 0.75) / 0.25) * h end
SHAPES.valley = function(d, h) return -smooth(1 - d) * h end
SHAPES.ridge = SHAPES.mountain
SHAPES.volcano = function(d, h) local cone = clamp(1 - d, 0, 1) local crater = clamp(1 - d / 0.3, 0, 1) return cone * cone * h * 1.3 - crater * crater * h * 0.8 end
SHAPES.basin = function(d, h) if d < 0.6 then return -h end return -smooth(1 - (d - 0.6) / 0.4) * h end
SHAPES.dune = function(d, h, n, ax) return smooth(1 - d) * h * (0.5 + 0.5 * math.sin(ax * 3.5)) end
SHAPES.raise = function(d, h) if d < 0.8 then return h end return smooth(1 - (d - 0.8) / 0.2) * h end
SHAPES.lower = function(d, h) if d < 0.8 then return -h end return -smooth(1 - (d - 0.8) / 0.2) * h end

function CMD.terrain_shape(a)
  local op = tostring(a.op or "hill"):lower()
  if not (SHAPES[op] or op == "flatten") then return failj("unknown op '" .. op .. "' - use mountain, hill, crater, plateau, valley, ridge, volcano, basin, dune, flatten, raise or lower") end
  local c = vec(a.center, 0, 0, 0)
  local radius = num(a.radius, 48, 8, 1000)
  local height = num(a.height, op == "flatten" and 0 or 24, 0, 400)
  local length = num(a.length, radius * 3, radius)
  local dir = math.rad(num(a.direction, 0))
  local seed = num(a.seed, 3)
  local ext = (op == "ridge" or op == "valley" or op == "dune") and math.max(radius, length / 2) or radius
  local sx, sz = ext * 2.3, ext * 2.3
  local yMin, yMax = c.Y - num(a.y_range, 120, 16), c.Y + num(a.y_range, 120, 16) + height
  local F = ENV.surface(c.X, c.Z, sx, sz, yMin, yMax)
  local baseline = c.Y
  if a.level ~= nil then baseline = num(a.level, c.Y)
  elseif F.count > 0 then local sum, n = 0, 0 for i = 1, F.nx do for j = 1, F.nz do if F.has[i][j] then sum = sum + F.H[i][j] n = n + 1 end end end baseline = sum / n end
  local topM = ENV.mat(a.material, nil)
  local underM = ENV.mat(a.under, Enum.Material.Rock)
  local newTop = topM or Enum.Material.Grass
  local changed, res = 0, F.res
  local cosD, sinD = math.cos(dir), math.sin(dir)
  local touched = {}
  local oldMin = (F.count > 0) and F.minH or baseline
  for i = 1, F.nx do
    local wx = F.x0 + (i - 1) * res
    for j = 1, F.nz do
      local wz = F.z0 + (j - 1) * res
      local dx, dz = wx - c.X, wz - c.Z
      local d
      local ax = dx * cosD + dz * sinD
      if op == "ridge" or op == "valley" or op == "dune" then
        local across = -dx * sinD + dz * cosD
        local along = clamp(math.abs(ax) - length / 2 + radius, 0, 1e9)
        d = math.sqrt(across * across + along * along) / radius
      else d = math.sqrt(dx * dx + dz * dz) / radius end
      if d < 1 then
        touched[i] = touched[i] or {} touched[i][j] = true
        local cur = F.has[i][j] and F.H[i][j] or baseline
        local newH
        if op == "flatten" then
          newH = cur + (baseline - cur) * smooth(1 - d)
        else
          local n = ENV.fbm(wx / 40, wz / 40, seed, 3, 2, 0.5)
          newH = cur + SHAPES[op](d, height, n, ax / 10)
        end
        if math.abs(newH - F.H[i][j]) > 0.01 or not F.has[i][j] then changed = changed + 1 end
        F.H[i][j] = newH
        F.has[i][j] = true
      end
    end
  end
  F.minH, F.maxH = math.huge, -math.huge
  for i = 1, F.nx do for j = 1, F.nz do if F.has[i][j] then local h = F.H[i][j] if h < F.minH then F.minH = h end if h > F.maxH then F.maxH = h end end end end
  local fillLevel = (a.fill_level ~= nil) and num(a.fill_level, nil) or nil
  local fillMat = ENV.mat(a.fill_material, (op == "volcano") and Enum.Material.CrackedLava or WATER)
  if op == "volcano" and fillLevel == nil and a.fill_material ~= false then fillLevel = baseline + height * 0.3 end
  local written, err = ENV.write(F, {
    floorY = math.min(F.minH, oldMin) - 4, topY = math.max(F.maxH, fillLevel or -math.huge), keep = true, water = fillLevel, fill = fillMat,
    touch = function(i, j) return touched[i] ~= nil and touched[i][j] == true end,
    topAt = function(i, j) return topM or F.T[i][j] or newTop end,
    underAt = function() return underM end,
  })
  if not written then return failj(err) end
  local root = ENV.container(nil)
  root:SetAttribute("TerrainLastShape", op .. " @" .. math.floor(c.X) .. "," .. math.floor(c.Z))
  return okj({ op = op, center = { c.X, c.Y, c.Z }, radius = radius, height = height, columns_changed = changed, voxels = written, baseline = math.floor(baseline * 10) / 10,
    min_height = math.floor(F.minH * 10) / 10, max_height = math.floor(F.maxH * 10) / 10, fill_level = fillLevel, fill_material = fillLevel and fillMat.Name or nil,
    note = "Columns inside the footprint were rewritten from the surface down (overhangs inside it are filled). Water above the new surface was kept." },
    ("%s: %d columns reshaped around (%.0f, %.0f), heights now %.0f to %.0f"):format(op, changed, c.X, c.Z, F.minH, F.maxH))
end

function CMD.terrain_path(a)
  local kind = tostring(a.kind or "river"):lower()
  local KINDS = { river = { width = 14, depth = 6, water = true, mat = "Sand", bank = 8 }, canal = { width = 10, depth = 5, water = true, mat = "Concrete", bank = 2 }, ravine = { width = 18, depth = 28, water = false, mat = "Rock", bank = 10 },
    road = { width = 12, depth = 0, water = false, mat = "Asphalt", bank = 6 }, trail = { width = 5, depth = 0, water = false, mat = "Ground", bank = 3 }, ridge = { width = 16, depth = -14, water = false, mat = "Rock", bank = 12 } }
  local K = KINDS[kind]
  if not K then return failj("unknown kind '" .. kind .. "' - use river, canal, ravine, road, trail or ridge") end
  local raw = ENV.points(a.points)
  if #raw < 2 then return failj("points must list at least 2 waypoints as [x,z] or [x,y,z]") end
  local width = num(a.width, K.width, 2, 200)
  local depth = num(a.depth, K.depth, -200, 200)
  local bank = num(a.bank, K.bank, 0, 200)
  local water = K.water
  if a.water ~= nil then water = a.water and true or false end
  local mat = ENV.mat(a.material, ENV.mat(K.mat, Enum.Material.Sand))
  local minX, maxX, minZ, maxZ = math.huge, -math.huge, math.huge, -math.huge
  local anyY, sumY = false, 0
  for _, p in ipairs(raw) do
    if p.X < minX then minX = p.X end if p.X > maxX then maxX = p.X end if p.Z < minZ then minZ = p.Z end if p.Z > maxZ then maxZ = p.Z end
    if p.Y == p.Y then anyY = true sumY = sumY + p.Y end
  end
  local pad = width / 2 + bank + 8
  local cx, cz = (minX + maxX) / 2, (minZ + maxZ) / 2
  local sx, sz = (maxX - minX) + pad * 2, (maxZ - minZ) + pad * 2
  if sx > ENV.MAX_COLUMNS * 4 or sz > ENV.MAX_COLUMNS * 4 then return failj("the path spans more than 2048 studs - split it into two terrain_path calls") end
  local guessY = anyY and (sumY / #raw) or num(a.level, 0)
  local yMin, yMax = guessY - 100, guessY + 140
  local F = ENV.surface(cx, cz, sx, sz, yMin, yMax)
  -- y for points without one: the surface under them (or the fallback)
  local pts = {}
  for k, p in ipairs(raw) do
    local y = p.Y
    if y ~= y then
      local i = clamp(math.floor((p.X - F.x0) / F.res + 0.5) + 1, 1, F.nx)
      local j = clamp(math.floor((p.Z - F.z0) / F.res + 0.5) + 1, 1, F.nz)
      y = F.has[i][j] and F.H[i][j] or guessY
    end
    pts[k] = Vector3.new(p.X, y, p.Z)
  end
  local smoothPath = (a.smooth == nil) and true or (a.smooth and true or false)
  local line = smoothPath and ENV.spline(pts, math.max(16, math.floor(math.max(sx, sz) / 4))) or pts
  local half = width / 2
  local changed, res = 0, F.res
  local lowest = math.huge
  local near = ENV.rasterize(F, line, half + bank)
  for i, row in pairs(near) do
    for j, e in pairs(row) do
      local d, py = e.d, e.y
      local cur = F.has[i][j] and F.H[i][j] or py
      local target = py - depth
      if kind == "road" or kind == "trail" then target = py end
      local t = (d <= half) and 1 or smooth(1 - (d - half) / math.max(bank, 0.001))
      local newH = cur + (target - cur) * t
      if math.abs(newH - cur) > 0.01 or not F.has[i][j] then changed = changed + 1 end
      F.H[i][j] = newH
      F.has[i][j] = true
      if d <= half then F.T[i][j] = mat end
      if newH < lowest then lowest = newH end
      if newH < F.minH then F.minH = newH end
      if newH > F.maxH then F.maxH = newH end
    end
  end
  local written, err = ENV.write(F, {
    floorY = math.min(F.minH, yMin) - 4, topY = F.maxH, keep = true,
    touch = function(i, j) return near[i] ~= nil and near[i][j] ~= nil end,
    water = nil,
    topAt = function(i, j) return F.T[i][j] or Enum.Material.Ground end,
    underAt = function(i, j) return F.T[i][j] or Enum.Material.Rock end,
  })
  if not written then return failj(err) end
  local waterVoxels = 0
  if water and depth > 0 then
    for k = 1, #line - 1 do
      local p0, p1 = line[k], line[k + 1]
      local seg = (p1 - p0)
      local len = seg.Magnitude
      if len > 0.5 then
        local mid = (p0 + p1) / 2
        local cf = CFrame.lookAt(Vector3.new(mid.X, mid.Y - depth * 0.5 - 0.5, mid.Z), Vector3.new(p1.X, mid.Y - depth * 0.5 - 0.5, p1.Z))
        Terrain:FillBlock(cf, Vector3.new(width - 1, math.max(1, depth - 1), len + 1), WATER)
        waterVoxels = waterVoxels + math.floor((width * depth * len) / 64)
      end
    end
  end
  return okj({ kind = kind, waypoints = #raw, samples = #line, width = width, depth = depth, material = mat.Name, water = water and depth > 0, columns_changed = changed, voxels = written, water_voxels_est = waterVoxels,
    lowest = math.floor(lowest * 10) / 10, note = kind == "river" and "The river bed follows your waypoints' heights (give [x,y,z] to control the fall; [x,z] samples the ground). Water was filled per segment just under the bed line." or "Columns within width/2 take the material; the bank blends back to the old ground." },
    ("%s carved along %d waypoints (%d samples, width %.0f)"):format(kind, #raw, #line, width))
end

function CMD.terrain_water(a)
  local kind = tostring(a.kind or "lake"):lower()
  if kind ~= "ocean" and kind ~= "lake" and kind ~= "pond" then return failj("unknown kind '" .. kind .. "' - use ocean, lake or pond") end
  local c = vec(a.center, 0, 0, 0)
  local level = (a.level ~= nil) and num(a.level, c.Y) or c.Y
  local style = a.style or {}
  if style.wave_size ~= nil then Terrain.WaterWaveSize = num(style.wave_size, 0.15, 0, 1) end
  if style.wave_speed ~= nil then Terrain.WaterWaveSpeed = num(style.wave_speed, 10, 0, 100) end
  if style.transparency ~= nil then Terrain.WaterTransparency = num(style.transparency, 0.3, 0, 1) end
  if style.reflectance ~= nil then Terrain.WaterReflectance = num(style.reflectance, 1, 0, 1) end
  if type(style.color) == "table" then Terrain.WaterColor = Color3.fromRGB(num(style.color[1], 12), num(style.color[2], 84), num(style.color[3], 92)) end
  local shore = ENV.mat(a.shore, Enum.Material.Sand)
  if kind == "ocean" then
    local size = a.size
    local sx, sz = 1024, 1024
    if type(size) == "table" then sx, sz = num(size[1], 1024), num(size[2] or size[3], 1024) elseif tonumber(size) then sx, sz = tonumber(size), tonumber(size) end
    sx, sz = math.min(sx, ENV.MAX_COLUMNS * 4), math.min(sz, ENV.MAX_COLUMNS * 4)
    local depth = num(a.depth, 40, 4, 400)
    local F = ENV.surface(c.X, c.Z, sx, sz, level - depth - 8, level + 8)
    local floorY = snap(level - depth)
    local shoreBand = num(a.shore_band, 4)
    for i = 1, F.nx do for j = 1, F.nz do
      if not F.has[i][j] then F.H[i][j] = floorY F.has[i][j] = true F.T[i][j] = shore
      elseif F.H[i][j] <= level + shoreBand and a.shore ~= false then F.T[i][j] = shore end
    end end
    F.minH = math.min(F.minH, floorY)
    local written, err = ENV.write(F, { floorY = floorY - 4, topY = math.max(level, F.maxH), keep = true, water = level,
      topAt = function(i, j) return F.T[i][j] or shore end, underAt = function(i, j) return F.T[i][j] or Enum.Material.Sandstone end })
    if not written then return failj(err) end
    return okj({ kind = kind, level = level, size = { F.sx, F.sz }, depth = depth, voxels = written, shore = shore.Name, note = "Air below the level became Water across the region; columns with no terrain got a sea floor " .. depth .. " studs down. Existing land above the level is untouched." }, ("ocean filled to y=%.0f over %.0fx%.0f"):format(level, F.sx, F.sz))
  end
  -- lake / pond: carve a bowl then fill
  local radius = num(a.radius, kind == "pond" and 14 or 48, 4, 1000)
  local depth = num(a.depth, kind == "pond" and 4 or 12, 1, 200)
  local F = ENV.surface(c.X, c.Z, radius * 2.6, radius * 2.6, level - depth - 24, level + 60)
  local res, changed = F.res, 0
  local touched = {}
  for i = 1, F.nx do
    local wx = F.x0 + (i - 1) * res
    for j = 1, F.nz do
      local wz = F.z0 + (j - 1) * res
      local d = math.sqrt((wx - c.X) ^ 2 + (wz - c.Z) ^ 2) / radius
      if d < 1.3 then
        touched[i] = touched[i] or {} touched[i][j] = true
        local cur = F.has[i][j] and F.H[i][j] or level
        local bowl = level - depth * smooth(1 - d / 0.95) ^ 0.8
        local t = (d <= 0.95) and 1 or smooth(1 - (d - 0.95) / 0.35)
        local newH = cur + (math.min(bowl, cur) - cur) * t
        if d < 0.95 and newH > level - 0.5 then newH = level - 0.5 - depth * 0.1 end
        if math.abs(newH - cur) > 0.01 then changed = changed + 1 end
        F.H[i][j] = newH F.has[i][j] = true
        if d < 1.15 and newH <= level + 2 and a.shore ~= false then F.T[i][j] = shore end
        if newH < F.minH then F.minH = newH end
      end
    end
  end
  -- water only inside the bowl: write with a per-column water flag via a wrapped topAt (the writer fills every air voxel below level, so clip by column)
  local inside = {}
  for i = 1, F.nx do inside[i] = {} local wx = F.x0 + (i - 1) * res for j = 1, F.nz do local wz = F.z0 + (j - 1) * res inside[i][j] = math.sqrt((wx - c.X) ^ 2 + (wz - c.Z) ^ 2) <= radius * 0.97 end end
  local written, err = ENV.write(F, { floorY = F.minH - 4, topY = math.max(level, F.maxH), keep = true, water = nil,
    touch = function(i, j) return touched[i] ~= nil and touched[i][j] == true end,
    topAt = function(i, j) return F.T[i][j] or shore end, underAt = function(i, j) return F.T[i][j] or Enum.Material.Rock end })
  if not written then return failj(err) end
  -- fill the bowl with water voxels (per column so the shore stays dry)
  local filled = 0
  local chunk = 32
  local floorY = snap(F.minH - 4)
  local topY = snap(level) + res
  local ny = (topY - floorY) / res
  local wx0, wz0 = F.x0 - res / 2, F.z0 - res / 2
  for ci = 1, F.nx, chunk do for cj = 1, F.nz, chunk do
    local ni, nj = math.min(chunk, F.nx - ci + 1), math.min(chunk, F.nz - cj + 1)
    local region = Region3.new(Vector3.new(wx0 + (ci - 1) * res, floorY, wz0 + (cj - 1) * res), Vector3.new(wx0 + (ci - 1 + ni) * res, topY, wz0 + (cj - 1 + nj) * res))
    local mats, occs = Terrain:ReadVoxels(region, res)
    local touched = false
    for aI = 1, ni do for b = 1, nj do
      if inside[ci + aI - 1][cj + b - 1] then
        for y = 1, ny do
          local vy0 = floorY + (y - 1) * res
          if mats[aI][y][b] == AIR and vy0 < level then
            mats[aI][y][b] = WATER occs[aI][y][b] = (vy0 + res <= level) and 1 or (level - vy0) / res
            filled = filled + 1 touched = true
          end
        end
      end
    end end
    if touched then Terrain:WriteVoxels(region, res, mats, occs) end
  end end
  return okj({ kind = kind, center = { c.X, level, c.Z }, level = level, radius = radius, depth = depth, columns_changed = changed, water_voxels = filled, shore = shore.Name,
    note = "A bowl was carved below the water level and only its inside was flooded - the shore stays dry. style sets the Terrain water look place-wide." },
    ("%s carved and filled at (%.0f, %.0f) radius %.0f, level %.0f"):format(kind, c.X, c.Z, radius, level))
end

ENV.PALETTES = {
  temperate = { top = "Grass", slope = "Rock", under = "Ground", beach = "Sand", peak = "Snow", slope_tan = 1.0, snow_rel = 0.8 },
  desert = { top = "Sand", slope = "Sandstone", under = "Sandstone", beach = "Sand", peak = "Sandstone", slope_tan = 1.3, snow_rel = 2 },
  arctic = { top = "Snow", slope = "Glacier", under = "Ice", beach = "Snow", peak = "Snow", slope_tan = 0.9, snow_rel = 2 },
  volcanic = { top = "Basalt", slope = "Rock", under = "Rock", beach = "Basalt", peak = "CrackedLava", slope_tan = 1.0, snow_rel = 0.9 },
  swamp = { top = "Mud", slope = "Ground", under = "Mud", beach = "Mud", peak = "LeafyGrass", slope_tan = 1.5, snow_rel = 2 },
  autumn = { top = "LeafyGrass", slope = "Rock", under = "Ground", beach = "Sand", peak = "Snow", slope_tan = 1.0, snow_rel = 0.85 },
  alien = { top = "Salt", slope = "Slate", under = "Basalt", beach = "Salt", peak = "Glacier", slope_tan = 1.0, snow_rel = 0.75 },
  cave = { top = "Slate", slope = "Rock", under = "Rock", beach = "Mud", peak = "Limestone", slope_tan = 0.8, snow_rel = 2 },
  jungle = { top = "LeafyGrass", slope = "Mud", under = "Ground", beach = "Sand", peak = "Rock", slope_tan = 1.2, snow_rel = 2 },
  savanna = { top = "Ground", slope = "Sandstone", under = "Sandstone", beach = "Sand", peak = "Rock", slope_tan = 1.1, snow_rel = 2 },
}
function CMD.terrain_paint_biome(a)
  local name = tostring(a.palette or a.biome or "temperate"):lower()
  local P = ENV.PALETTES[name]
  if not P then return failj("unknown palette '" .. name .. "' - use temperate, desert, arctic, volcanic, swamp, autumn, alien, cave, jungle or savanna") end
  local c = vec(a.center, 0, 0, 0)
  local size = a.size
  local sx, sz = 512, 512
  if type(size) == "table" then sx, sz = num(size[1], 512), num(size[2] or size[3], 512) elseif tonumber(size) then sx, sz = tonumber(size), tonumber(size) end
  local yMin, yMax = c.Y - num(a.y_range, 150, 16), c.Y + num(a.y_range, 150, 16)
  local F = ENV.surface(c.X, c.Z, sx, sz, yMin, yMax)
  if F.count == 0 then return failj(("no terrain found in %.0fx%.0f studs around (%.0f, %.0f) between y=%.0f and y=%.0f - run terrain_generate first or move the center"):format(sx, sz, c.X, c.Z, yMin, yMax)) end
  local o = a.rules or {}
  local rules = { top = ENV.mat(o.top, ENV.mat(P.top)), slope = ENV.mat(o.slope, ENV.mat(P.slope)), under = ENV.mat(o.under, ENV.mat(P.under)), beach = ENV.mat(o.beach, ENV.mat(P.beach)), peak = ENV.mat(o.peak, ENV.mat(P.peak)),
    slopeTan = num(o.slope_tan, P.slope_tan), beachBand = num(o.beach_band, 3) }
  if o.snow_line ~= nil then rules.snowLine = num(o.snow_line, nil) elseif P.snow_rel < 1.5 then rules.snowLine = F.minH + (F.maxH - F.minH) * P.snow_rel end
  if o.water_level ~= nil then rules.sea = num(o.water_level, nil) elseif F.water > 0 then rules.sea = nil end
  local res, chunk = F.res, 32
  local wx0, wz0 = F.x0 - res / 2, F.z0 - res / 2
  local counts, repainted = {}, 0
  for ci = 1, F.nx, chunk do for cj = 1, F.nz, chunk do
    local ni, nj = math.min(chunk, F.nx - ci + 1), math.min(chunk, F.nz - cj + 1)
    local region = Region3.new(Vector3.new(wx0 + (ci - 1) * res, snap(yMin), wz0 + (cj - 1) * res), Vector3.new(wx0 + (ci - 1 + ni) * res, snap(yMax), wz0 + (cj - 1 + nj) * res))
    local mats, occs = Terrain:ReadVoxels(region, res)
    local ny = mats.Size.Y
    local touched = false
    for aI = 1, ni do
      local i = ci + aI - 1
      for b = 1, nj do
        local j = cj + b - 1
        if F.has[i][j] then
          local h = F.H[i][j]
          local topM = ENV.topMat(F, i, j, h, rules)
          for y = 1, ny do
            local m = mats[aI][y][b]
            if m ~= AIR and m ~= WATER and occs[aI][y][b] > 0.02 then
              local vy0 = snap(yMin) + (y - 1) * res
              local want = (h - vy0 > res * 1.5) and rules.under or topM
              if a.repaint_under == false and want == rules.under then want = m end
              if m ~= want then mats[aI][y][b] = want touched = true repainted = repainted + 1 end
              counts[want.Name] = (counts[want.Name] or 0) + 1
            end
          end
        end
      end
    end
    if touched then Terrain:WriteVoxels(region, res, mats, occs) end
  end end
  return okj({ palette = name, columns = F.count, voxels_repainted = repainted, materials = counts, rules = { top = rules.top.Name, slope = rules.slope.Name, under = rules.under.Name, beach = rules.beach.Name, peak = rules.peak.Name, slope_tan = rules.slopeTan, snow_line = rules.snowLine, water_level = rules.sea },
    note = "Only materials changed - occupancy, caves and overhangs are exactly as before. rules.{top,slope,under,beach,peak,slope_tan,snow_line,water_level,beach_band} override the palette; repaint_under=false keeps deep voxels." },
    ("repainted %d voxels in %d columns with the %s palette"):format(repainted, F.count, name))
end

function CMD.terrain_info(a)
  local c = vec(a.center, 0, 0, 0)
  local size = a.size
  local sx, sz = 512, 512
  if type(size) == "table" then sx, sz = num(size[1], 512), num(size[2] or size[3], 512) elseif tonumber(size) then sx, sz = tonumber(size), tonumber(size) end
  local yMin, yMax = c.Y - num(a.y_range, 200, 16), c.Y + num(a.y_range, 200, 16)
  local F = ENV.surface(c.X, c.Z, sx, sz, yMin, yMax)
  local hist = {}
  for m, n in pairs(F.hist) do hist[#hist + 1] = { material = m, voxels = n } end
  table.sort(hist, function(p, q) return p.voxels > q.voxels end)
  while #hist > 10 do table.remove(hist) end
  local sum, n = 0, 0
  local bx0, bx1, bz0, bz1 = math.huge, -math.huge, math.huge, -math.huge
  for i = 1, F.nx do for j = 1, F.nz do if F.has[i][j] then sum = sum + F.H[i][j] n = n + 1 local wx, wz = F.x0 + (i - 1) * F.res, F.z0 + (j - 1) * F.res if wx < bx0 then bx0 = wx end if wx > bx1 then bx1 = wx end if wz < bz0 then bz0 = wz end if wz > bz1 then bz1 = wz end end end end
  local heights = {}
  for _, p in ipairs(a.points or {}) do
    if type(p) == "table" and #p >= 2 then
      local px, pz = num(p[1], 0), num(p[#p], 0)
      local i = clamp(math.floor((px - F.x0) / F.res + 0.5) + 1, 1, F.nx)
      local j = clamp(math.floor((pz - F.z0) / F.res + 0.5) + 1, 1, F.nz)
      heights[#heights + 1] = { x = px, z = pz, height = F.has[i][j] and math.floor(F.H[i][j] * 10) / 10 or nil, material = F.T[i][j] and F.T[i][j].Name or nil, slope = F.has[i][j] and math.floor(math.deg(math.atan(ENV.slopeAt(F, i, j)))) or nil }
    end
  end
  local spots = ENV.flatSpots(F, nil, 3)
  local flat = {}
  for k, s in ipairs(spots) do if F.has[s.i][s.j] then flat[#flat + 1] = { x = math.floor(s.x), y = math.floor(s.y * 10) / 10, z = math.floor(s.z), range = math.floor(s.range * 10) / 10 } end end
  local root = workspace:FindFirstChild("Environment")
  local groups = {}
  if root then for _, f in ipairs(root:GetChildren()) do groups[#groups + 1] = { name = f.Name, children = #f:GetChildren() } end end
  return okj({ has_terrain = F.count > 0, scanned = { center = { F.cx, c.Y, F.cz }, size = { F.sx, F.sz }, y_min = yMin, y_max = yMax }, columns_with_terrain = F.count, coverage = math.floor(F.count / (F.nx * F.nz) * 1000) / 10,
    bounds = F.count > 0 and { x = { bx0, bx1 }, z = { bz0, bz1 }, y = { math.floor(F.minH * 10) / 10, math.floor(F.maxH * 10) / 10 } } or nil, mean_height = n > 0 and math.floor(sum / n * 10) / 10 or nil,
    water_voxels = F.water, materials = hist, heights = heights, flat_spots = flat, environment_groups = groups,
    water_look = { wave_size = Terrain.WaterWaveSize, wave_speed = Terrain.WaterWaveSpeed, transparency = Terrain.WaterTransparency, reflectance = Terrain.WaterReflectance },
    biome = root and root:GetAttribute("TerrainBiome") or nil, seed = root and root:GetAttribute("TerrainSeed") or nil,
    note = F.count > 0 and "Read-only. Surface = topmost solid voxel per 4-stud column inside the scanned box; caves below it are not listed." or "No terrain inside the scanned box - widen size / y_range or generate some with terrain_generate." },
    F.count > 0 and ("terrain: %d columns, heights %.0f to %.0f, %d water voxels"):format(F.count, F.minH, F.maxH, F.water) or "no terrain in the scanned region")
end

function CMD.environment_scatter(a)
  local kinds = {}
  local list = a.kinds
  if type(list) == "string" then list = { list } end
  if type(list) ~= "table" or #list == 0 then list = { a.kind or "pine" } end
  for _, k in ipairs(list) do local n = tostring(k):lower():gsub("[%s%-]", "_") if PR[n] then kinds[#kinds + 1] = n end end
  local template = nil
  if a.template and a.template ~= "" then
    local okR, inst = pcall(function()
      local cur = game
      for seg in tostring(a.template):gmatch("[^%.]+") do if seg ~= "game" then cur = cur:FindFirstChild(seg) if not cur then return nil end end end
      return cur
    end)
    template = okR and inst or nil
    if not template then return failj("template not found at '" .. tostring(a.template) .. "'") end
    if #kinds == 0 then kinds = { template.Name } end
  elseif #kinds == 0 then return failj("no known kinds - use pine, oak, birch, palm, dead_tree, bush, rock, boulder, grass, flower, mushroom, cactus, crystal, log, stump (or template = path of your own model)") end
  local c = vec(a.center, 0, 60, 0)
  local size = a.size
  local sx, sz = 200, 200
  if type(size) == "table" then sx, sz = num(size[1], 200), num(size[2] or size[3], 200) elseif tonumber(size) then sx, sz = tonumber(size), tonumber(size) end
  if a.radius then sx, sz = num(a.radius, 100) * 2, num(a.radius, 100) * 2 end
  local name = tostring(a.name or (template and (template.Name .. "s") or (kinds[1] .. "s")))
  local container = ENV.container(name)
  local onMats = nil
  if type(a.on_materials) == "table" and #a.on_materials > 0 then onMats = {} for _, m in ipairs(a.on_materials) do local e = ENV.mat(m, nil) if e then onMats[e.Name] = true end end end
  local pal = {}
  if type(a.palette) == "table" then for k, v in pairs(a.palette) do if type(v) == "table" and #v >= 3 then pal[k] = Color3.fromRGB(num(v[1], 128), num(v[2], 128), num(v[3], 128)) end end end
  local scale = a.scale
  local smin, smax = 0.8, 1.3
  if type(scale) == "table" then smin, smax = num(scale[1], 0.8, 0.05), num(scale[2], smin, smin) elseif tonumber(scale) then smin, smax = tonumber(scale), tonumber(scale) end
  local avoidWater = (a.avoid_water == nil) and true or (a.avoid_water and true or false)
  local placed, skipped, byKind = ENV.scatter({ kinds = kinds, count = a.count, cx = c.X, cz = c.Z, sx = sx, sz = sz, seed = a.seed, spacing = a.min_spacing, scaleMin = smin, scaleMax = smax, slopeMax = a.slope_max,
    avoidWater = avoidWater, onMaterials = onMats, template = template, container = container, palette = pal, yTop = c.Y + num(a.height_above, 300, 10), align = a.align_to_ground and true or false })
  container:SetAttribute("EnvSeed", num(a.seed, 7)) container:SetAttribute("EnvCenter", Vector3.new(c.X, c.Y, c.Z)) container:SetAttribute("EnvSize", Vector3.new(sx, 0, sz))
  if placed == 0 then
    container:Destroy()
    return failj(("nothing placed: %d spots hit no ground, %d water, %d too steep, %d wrong material - raise center.y above the terrain, lower slope_max, or check avoid_water / on_materials"):format(skipped.air, skipped.water, skipped.slope, skipped.material))
  end
  return okj({ group = container:GetFullName(), placed = placed, requested = clamp(math.floor(num(a.count, 60)), 1, 800), by_kind = byKind, skipped = skipped, area = { sx, sz }, center = { c.X, c.Y, c.Z }, seed = num(a.seed, 7),
    note = "Every prop sits on a real downward raycast hit (terrain or anchored parts), grouped under Workspace.Environment." .. (template and " Your template was cloned (ScaleTo when it is a Model)." or " Props are Part / WedgePart models with EnvKind / EnvScale attributes - no asset ids.") .. " Re-running with the same name replaces the group." },
    ("placed %d props (%s) under %s"):format(placed, table.concat(kinds, ", "), container:GetFullName()))
end

function CMD.road_build(a)
  local raw = ENV.points(a.points)
  if #raw < 2 then return failj("points must list at least 2 waypoints as [x,z] or [x,y,z]") end
  local width = num(a.width, 12, 2, 80)
  local mat = ENV.mat(a.material, Enum.Material.Asphalt)
  local color = (type(a.color) == "table" and #a.color >= 3) and Color3.fromRGB(num(a.color[1], 60), num(a.color[2], 60), num(a.color[3], 62)) or (mat == Enum.Material.Asphalt and Color3.fromRGB(58, 58, 62) or mat == Enum.Material.Ground and Color3.fromRGB(120, 95, 70) or Color3.fromRGB(150, 150, 150))
  local name = tostring(a.name or "Road")
  local follow = (a.follow_ground == nil) and true or (a.follow_ground and true or false)
  local container = ENV.container(name)
  local pts = {}
  local maxY = -math.huge
  for _, p in ipairs(raw) do if p.Y == p.Y and p.Y > maxY then maxY = p.Y end end
  if maxY == -math.huge then maxY = num(a.height_above, 300) end
  for k, p in ipairs(raw) do
    local y = p.Y
    if follow or y ~= y then
      local pos = ENV.groundAt(p.X, p.Z, maxY + 200, { container })
      if pos then y = pos.Y elseif y ~= y then y = 0 end
    end
    pts[k] = Vector3.new(p.X, y, p.Z)
  end
  local segLen = num(a.segment, 6, 2, 40)
  local total = 0
  for k = 1, #pts - 1 do total = total + (pts[k + 1] - pts[k]).Magnitude end
  local smoothPath = (a.smooth == nil) and true or (a.smooth and true or false)
  local line = smoothPath and ENV.spline(pts, math.max(8, math.floor(total / segLen))) or pts
  if follow then
    for k, p in ipairs(line) do
      local pos = ENV.groundAt(p.X, p.Z, maxY + 200, { container })
      if pos then line[k] = Vector3.new(p.X, pos.Y, p.Z) end
    end
  end
  local thick = num(a.thickness, 0.6, 0.2, 6)
  local lift = num(a.lift, 0.15, 0, 5)
  local model = Instance.new("Model") model.Name = name .. "Surface" model.Parent = container
  local segs = 0
  for k = 1, #line - 1 do
    local p0, p1 = line[k], line[k + 1]
    local d = p1 - p0
    local len = d.Magnitude
    if len > 0.2 then
      local mid = (p0 + p1) / 2 + Vector3.new(0, lift, 0)
      local cf = CFrame.lookAt(mid, mid + d)
      local seg = part(model, Enum.PartType.Block, Vector3.new(width, thick, len + math.min(width * 0.35, 2)), cf, color, mat, "Segment" .. k)
      segs = segs + 1
      if a.lines then
        local l = part(model, Enum.PartType.Block, Vector3.new(0.35, thick * 0.3, len * 0.55), cf * CFrame.new(0, thick * 0.5 + 0.02, 0), Color3.fromRGB(240, 220, 90), Enum.Material.SmoothPlastic, "Line")
        l.CastShadow = false
      end
      if a.curbs then
        for side = -1, 1, 2 do part(model, Enum.PartType.Block, Vector3.new(0.8, thick + 0.5, len + math.min(width * 0.35, 2)), cf * CFrame.new(side * (width / 2 + 0.4), 0.25, 0), Color3.fromRGB(170, 170, 170), Enum.Material.Concrete, "Curb") end
      end
      if k == 1 then model.PrimaryPart = seg end
    end
  end
  if a.paint_terrain then
    for k = 1, #line - 1 do
      local p0, p1 = line[k], line[k + 1]
      local d = p1 - p0
      if d.Magnitude > 0.2 then
        local mid = (p0 + p1) / 2
        Terrain:FillBlock(CFrame.lookAt(mid - Vector3.new(0, 2, 0), mid - Vector3.new(0, 2, 0) + d), Vector3.new(width + 2, 4, d.Magnitude + 1), ENV.mat(a.paint_terrain, mat))
      end
    end
  end
  container:SetAttribute("RoadWidth", width) container:SetAttribute("RoadLength", math.floor(total))
  return okj({ group = container:GetFullName(), segments = segs, length = math.floor(total), width = width, material = mat.Name, follow_ground = follow, lines = a.lines and true or false, curbs = a.curbs and true or false, samples = #line,
    note = "Segments are anchored Parts laid along a Catmull-Rom spline; with follow_ground each sample is raycast onto terrain / anchored parts. For a road carved INTO terrain use terrain_path {kind:'road'}." },
    ("built %s: %d segments, %.0f studs, width %.0f"):format(name, segs, total, width))
end

ENV.MAPS = {
  island_survival = { biome = "island", height = 48, foliage = { "palm", "oak", "bush", "rock", "grass" }, on = { "Grass", "LeafyGrass", "Ground" }, water_style = { 0.2, 10, { 20, 110, 130 }, 0.35 } },
  green_valley = { biome = "hills", height = 36, river = true, foliage = { "oak", "pine", "birch", "bush", "flower", "grass", "rock" }, on = { "Grass", "LeafyGrass", "Ground" } },
  arena = { biome = "plains", height = 6, flatten = 0.35, foliage = { "rock", "boulder", "bush" }, on = { "Grass", "Ground" }, ring = true },
  archipelago = { biome = "archipelago", height = 40, foliage = { "palm", "bush", "rock", "grass" }, on = { "LeafyGrass", "Grass", "Ground" }, water_style = { 0.25, 12, { 24, 120, 140 }, 0.3 } },
  canyon_run = { biome = "canyon", height = 64, river = true, foliage = { "cactus", "rock", "boulder", "dead_tree" }, on = { "Sandstone", "Sand", "Rock", "Ground" } },
  snow_peaks = { biome = "mountains", height = 110, foliage = { "pine", "rock", "boulder", "dead_tree" }, on = { "Grass", "Snow", "Rock", "Ground" }, snow = true },
  volcano = { biome = "volcanic", height = 64, foliage = { "rock", "boulder", "dead_tree", "crystal" }, on = { "Basalt", "Rock" } },
  swamp = { biome = "swamp", height = 7, foliage = { "dead_tree", "mushroom", "bush", "log", "grass" }, on = { "Mud", "Ground", "LeafyGrass" }, water_style = { 0.05, 4, { 60, 80, 50 }, 0.5 } },
  desert_oasis = { biome = "desert", height = 18, oasis = true, foliage = { "cactus", "rock", "palm", "boulder" }, on = { "Sand", "Sandstone" } },
  highlands = { biome = "mesa", height = 44, foliage = { "pine", "rock", "boulder", "bush", "stump" }, on = { "Sandstone", "Grass", "Ground", "Rock" } },
  lake_district = { biome = "alpine", height = 60, foliage = { "pine", "birch", "bush", "rock", "flower", "grass" }, on = { "LeafyGrass", "Grass", "Ground" }, water_style = { 0.1, 8, { 30, 90, 110 }, 0.4 } },
  crater = { biome = "hills", height = 30, crater = true, foliage = { "rock", "boulder", "crystal", "dead_tree" }, on = { "Grass", "Rock", "Ground", "Basalt" } },
}
function CMD.map_generate(a)
  local presetName = tostring(a.preset or "green_valley"):lower()
  local P = ENV.MAPS[presetName]
  if not P then return failj("unknown preset '" .. presetName .. "' - use island_survival, green_valley, arena, archipelago, canyon_run, snow_peaks, volcano, swamp, desert_oasis, highlands, lake_district or crater") end
  local c = vec(a.center, 0, 0, 0)
  local size = num(a.size, 512, 64, ENV.MAX_COLUMNS * 4)
  local seed = num(a.seed, 42)
  local biome = ENV.BIOMES[P.biome]
  local amp = num(a.height, P.height, 0, 400)
  local F = ENV.field({ cx = c.X, cz = c.Z, sx = size, sz = size, base = c.Y, amp = amp, scale = biome.scale * (size / 512) ^ 0.5, octaves = biome.octaves, seed = seed, mask = biome.mask, ridged = biome.ridged, terrace = biome.terrace, dunes = biome.dunes, canyon = biome.canyon, volcano = biome.volcano, lift = biome.lift })
  local sea = nil
  if biome.water then sea = c.Y + (biome.sea or 0) end
  if P.crater then
    for i = 1, F.nx do for j = 1, F.nz do
      local wx, wz = F.x0 + (i - 1) * F.res, F.z0 + (j - 1) * F.res
      local d = math.sqrt((wx - F.cx) ^ 2 + (wz - F.cz) ^ 2) / (size * 0.32)
      if d < 1.3 then F.H[i][j] = F.H[i][j] + SHAPES.crater(math.min(d, 1), amp * 1.2) * (d < 1 and 1 or smooth(1 - (d - 1) / 0.3)) end
    end end
    sea = c.Y - amp * 0.45
  end
  if P.oasis then
    for i = 1, F.nx do for j = 1, F.nz do
      local wx, wz = F.x0 + (i - 1) * F.res, F.z0 + (j - 1) * F.res
      local d = math.sqrt((wx - F.cx) ^ 2 + (wz - F.cz) ^ 2) / (size * 0.12)
      if d < 1.4 then local t = smooth(1 - d / 1.4) F.H[i][j] = F.H[i][j] + (c.Y - 6 - F.H[i][j]) * t end
    end end
    sea = c.Y - 1
  end
  if P.flatten then
    for i = 1, F.nx do for j = 1, F.nz do F.H[i][j] = c.Y + (F.H[i][j] - c.Y) * P.flatten end end
  end
  if P.ring then
    for i = 1, F.nx do for j = 1, F.nz do
      local wx, wz = F.x0 + (i - 1) * F.res, F.z0 + (j - 1) * F.res
      local d = math.sqrt((wx - F.cx) ^ 2 + (wz - F.cz) ^ 2) / (size * 0.5)
      if d > 0.78 then F.H[i][j] = F.H[i][j] + smooth((d - 0.78) / 0.2) * amp * 5 end
    end end
  end
  F.minH, F.maxH = math.huge, -math.huge
  for i = 1, F.nx do for j = 1, F.nz do local h = F.H[i][j] if h < F.minH then F.minH = h end if h > F.maxH then F.maxH = h end end end
  -- spawn: flattest high spot near the centre, flattened to a pad
  local spawn = nil
  local wantSpawn = (a.spawn == nil) and true or (a.spawn and true or false)
  local spots = ENV.flatSpots(F, sea, 1)
  if spots[1] then
    local s = spots[1]
    ENV.flattenField(F, s.x, s.z, 14, s.y)
    spawn = { x = s.x, y = s.y, z = s.z }
  end
  local rules = ENV.rules(biome, a.materials, c.Y, amp)
  rules.sea = sea
  if P.snow then rules.snowLine = c.Y + amp * 0.45 end
  local written, err = ENV.write(F, { floorY = F.minH - 20, water = sea, keep = false, topAt = function(i, j, h) return ENV.topMat(F, i, j, h, rules) end, underAt = function() return rules.under end })
  if not written then return failj(err) end
  local lava = nil
  if biome.lava then
    local lavaY = F.H[math.floor(F.nx / 2)][math.floor(F.nz / 2)] + 6
    Terrain:FillCylinder(CFrame.new(F.cx, lavaY - 3, F.cz), 6, size * 0.09, Enum.Material.CrackedLava)
    lava = { x = F.cx, y = math.floor(lavaY * 10) / 10, z = F.cz }
  end
  if P.water_style then Terrain.WaterWaveSize = P.water_style[1] Terrain.WaterWaveSpeed = P.water_style[2] Terrain.WaterColor = Color3.fromRGB(P.water_style[3][1], P.water_style[3][2], P.water_style[3][3]) Terrain.WaterTransparency = P.water_style[4] end
  -- river across the valley / canyon
  local river = nil
  if P.river and a.river ~= false then
    local rng = Random.new(seed + 11)
    local pts = {}
    local n = 5
    for k = 0, n do
      local t = k / n
      local x = F.cx - size / 2 + 8 + (size - 16) * t
      local z = F.cz + math.sin(t * 3.1 + rng:NextNumber(0, 1)) * size * 0.18
      pts[#pts + 1] = { x, z }
    end
    local r = HttpService:JSONDecode(CMD.terrain_path({ kind = "river", points = pts, width = math.max(8, size / 40), depth = 5 }))
    river = r.ok and { waypoints = #pts, columns = r.data.columns_changed } or { error = r.error }
  end
  -- foliage
  local density = tostring(a.foliage or "medium"):lower()
  local per = ({ none = 0, light = 0.35, medium = 0.8, dense = 1.5 })[density] or 0.8
  local scatter = nil
  if per > 0 and a.foliage ~= false then
    local count = clamp(math.floor((size * size) / 10000 * per * 30), 10, 600)
    local onMats = {}
    for _, m in ipairs(P.on) do onMats[m] = true end
    local container = ENV.container(presetName .. "_foliage")
    local placed, skipped, byKind = ENV.scatter({ kinds = P.foliage, count = count, cx = F.cx, cz = F.cz, sx = size - 16, sz = size - 16, seed = seed + 3, spacing = 6, scaleMin = 0.8, scaleMax = 1.35, slopeMax = 38, avoidWater = true, onMaterials = onMats, container = container, yTop = F.maxH + 60 })
    scatter = { group = container:GetFullName(), placed = placed, requested = count, by_kind = byKind, skipped = skipped }
    if spawn then for _, m in ipairs(container:GetChildren()) do local okP, pv = pcall(function() return m:GetPivot().Position end) if okP and (Vector3.new(pv.X, 0, pv.Z) - Vector3.new(spawn.x, 0, spawn.z)).Magnitude < 16 then m:Destroy() scatter.placed = scatter.placed - 1 end end end
  end
  -- spawn pad
  local spawnPath = nil
  if wantSpawn and spawn then
    local f = ENV.container("Spawn")
    local pad = Instance.new("Part") pad.Name = "SpawnPad" pad.Size = Vector3.new(14, 1, 14) pad.Anchored = true pad.Material = Enum.Material.SmoothPlastic pad.Color = Color3.fromRGB(70, 75, 85) pad.CFrame = CFrame.new(spawn.x, spawn.y + 0.5, spawn.z) pad.Parent = f
    local sp = Instance.new("SpawnLocation") sp.Name = "SpawnLocation" sp.Size = Vector3.new(8, 1, 8) sp.Anchored = true sp.Transparency = 1 sp.CanCollide = false sp.Neutral = true sp.Duration = 0 sp.CFrame = CFrame.new(spawn.x, spawn.y + 1.2, spawn.z) sp.Parent = f
    spawnPath = sp:GetFullName()
  end
  local lit = false
  if a.lighting ~= false then lit = ENV.applyLight(presetName) end
  local root = ENV.container(nil)
  root:SetAttribute("MapPreset", presetName) root:SetAttribute("MapSeed", seed) root:SetAttribute("MapSize", size) root:SetAttribute("TerrainBiome", P.biome) root:SetAttribute("TerrainSeed", seed) root:SetAttribute("TerrainCenter", Vector3.new(F.cx, c.Y, F.cz))
  return okj({ preset = presetName, biome = P.biome, seed = seed, size = size, center = { F.cx, c.Y, F.cz }, voxels = written, min_height = math.floor(F.minH * 10) / 10, max_height = math.floor(F.maxH * 10) / 10, sea_level = sea, lava = lava,
    spawn = spawn and { x = math.floor(spawn.x), y = math.floor(spawn.y * 10) / 10, z = math.floor(spawn.z), path = spawnPath } or nil, river = river, foliage = scatter, lighting = lit and presetName or false,
    materials = { top = rules.top.Name, slope = rules.slope.Name, under = rules.under.Name, beach = rules.beach.Name, peak = rules.peak.Name },
    note = "Everything is rebuildable from preset + seed + size + center (stored as attributes on Workspace.Environment). Follow with terrain_shape / terrain_path for hand edits, environment_scatter for more props, terrain_info to inspect, total_screenshot to look." },
    ("map '%s' generated: %.0fx%.0f studs, heights %.0f to %.0f%s%s"):format(presetName, size, size, F.minH, F.maxH, spawn and (", spawn at " .. math.floor(spawn.x) .. "," .. math.floor(spawn.z)) or "", scatter and (", " .. scatter.placed .. " props") or ""))
end

function ENV.run(op, a)
  local fn = CMD[op]
  if not fn then return failj("unknown environment command " .. tostring(op)) end
  local okR, res = pcall(fn, a or {})
  if not okR then return failj("environment " .. op .. " failed: " .. tostring(res)) end
  return res
end
`.replace("__VERSION__", VERSION);

  // -- JS side: commands, validation, builder -----------------------------
  const pt = (desc) => ({ type: "array", req: false, desc });
  const C = [
    { name: "terrain_generate", description: "Procedural voxel terrain from a seeded fBm heightfield (WriteVoxels): 12 biomes with their own relief, masks and materials (plains, hills, mountains, island, archipelago, desert, tundra, canyon, volcanic, swamp, mesa, alpine), water to a sea level, slope / height / beach / snow material rules. Replaces terrain in the region; returns heights, materials and flat spots.",
      params: { biome: { type: "string", req: false, desc: "plains|hills|mountains|island|archipelago|desert|tundra|canyon|volcanic|swamp|mesa|alpine (default hills)" }, center: pt("[x, base_y, z] - base_y is the mean ground level (default [0,0,0])"), size: { type: "any", req: false, desc: "[x, z] studs, max 2048 each (default [512,512])" }, seed: { type: "number", req: false, desc: "same seed = same ground" },
        height: { type: "number", req: false, desc: "relief amplitude in studs (biome default)" }, scale: { type: "number", req: false, desc: "feature size in studs (biome default)" }, octaves: { type: "number", req: false, desc: "1-8 noise octaves" }, water: { type: "boolean", req: false, desc: "fill water up to sea_level" }, sea_level: { type: "number", req: false, desc: "absolute y of the water (default biome offset from base_y)" },
        materials: { type: "object", req: false, desc: "{top, slope, under, beach, peak, snow_line, slope_tan, beach_band} overrides" }, depth: { type: "number", req: false, desc: "ground thickness under the lowest point (default 16)" } } },
    { name: "terrain_shape", description: "Sculpt EXISTING terrain: mountain, hill, crater, plateau, valley, ridge, volcano, basin, dune, flatten, raise or lower around a point (ridge / valley / dune have length + direction). Reads the surface, adds the shape, rewrites only the touched columns; optional fill (water / lava) to a level.",
      params: { op: { type: "string", req: true, desc: "mountain|hill|crater|plateau|valley|ridge|volcano|basin|dune|flatten|raise|lower" }, center: pt("[x, y, z] - y centres the vertical scan"), level: { type: "number", req: false, desc: "baseline y for empty columns and the flatten target (default: mean of the existing ground)" }, radius: { type: "number", req: false, desc: "footprint radius in studs (default 48)" }, height: { type: "number", req: false, desc: "studs up (or down for crater / valley / basin / lower)" },
        length: { type: "number", req: false, desc: "ridge / valley / dune length" }, direction: { type: "number", req: false, desc: "ridge / valley / dune heading in degrees" }, material: { type: "string", req: false, desc: "surface material for the reshaped columns (default keeps the existing one)" }, fill_level: { type: "number", req: false, desc: "flood the hole up to this y" }, fill_material: { type: "string", req: false, desc: "Water (default) or CrackedLava - volcano defaults to lava" }, seed: { type: "number", req: false }, y_range: { type: "number", req: false, desc: "how far above / below center.y to scan (default 120)" } } },
    { name: "terrain_path", description: "Carve or raise a smooth path through terrain along waypoints: river / canal (cut + water), ravine (deep cut), road / trail (flatten + paint), ridge (raise). Catmull-Rom smoothed; banks blend into the old ground.",
      params: { kind: { type: "string", req: false, desc: "river|canal|ravine|road|trail|ridge (default river)" }, points: { type: "array", req: true, desc: "[[x,z] or [x,y,z], ...] at least 2 - y controls the fall of a river" }, width: { type: "number", req: false }, depth: { type: "number", req: false, desc: "cut depth (negative raises)" }, bank: { type: "number", req: false, desc: "blend width outside the path" }, material: { type: "string", req: false, desc: "bed / surface material" }, water: { type: "boolean", req: false, desc: "fill the cut with water (river / canal default true)" }, smooth: { type: "boolean", req: false, desc: "spline through the points (default true)" } } },
    { name: "terrain_water", description: "Water bodies: ocean (fill every air voxel below a level across a region, sea floor where there is no land), lake / pond (carve a bowl and flood only its inside, dry shore), plus the place-wide water look (waves, colour, transparency, reflectance).",
      params: { kind: { type: "string", req: false, desc: "ocean|lake|pond (default lake)" }, center: pt("[x, level_y, z]"), level: { type: "number", req: false, desc: "water surface y (default center.y)" }, radius: { type: "number", req: false, desc: "lake / pond radius" }, size: { type: "any", req: false, desc: "ocean region [x, z] (default 1024)" }, depth: { type: "number", req: false, desc: "bowl depth / ocean floor depth" }, shore: { type: "string", req: false, desc: "shore material (default Sand; false = keep)" }, style: { type: "object", req: false, desc: "{wave_size, wave_speed, color:[r,g,b], transparency, reflectance}" } } },
    { name: "terrain_paint_biome", description: "Repaint existing terrain by height + slope rules without touching its shape: 10 palettes (temperate, desert, arctic, volcanic, swamp, autumn, alien, cave, jungle, savanna) or explicit rules {top, slope, under, beach, peak, snow_line, slope_tan, water_level, beach_band}.",
      params: { palette: { type: "string", req: false, desc: "temperate|desert|arctic|volcanic|swamp|autumn|alien|cave|jungle|savanna" }, center: pt("[x, y, z] scan centre"), size: { type: "any", req: false, desc: "[x, z] studs (default 512)" }, rules: { type: "object", req: false, desc: "material overrides, see description" }, y_range: { type: "number", req: false, desc: "scan half-height (default 150)" }, repaint_under: { type: "boolean", req: false, desc: "false keeps deep voxels as they are" } } },
    { name: "terrain_info", description: "Read-only terrain survey of a region: coverage, bounds, min / mean / max height, material histogram, water voxels, heights + slope at given points, flattest spots, Environment groups and the stored biome / seed. Use it to verify what terrain_* actually did.",
      params: { center: pt("[x, y, z] (default origin)"), size: { type: "any", req: false, desc: "[x, z] studs (default 512)" }, y_range: { type: "number", req: false, desc: "scan half-height (default 200)" }, points: { type: "array", req: false, desc: "[[x,z], ...] to sample height / material / slope" } } },
    { name: "environment_scatter", description: "Scatter props on the REAL ground (downward raycast onto terrain or anchored parts): built-in Part models pine, oak, birch, palm, dead_tree, bush, rock, boulder, grass, flower, mushroom, cactus, crystal, log, stump - or clone your own template model. Seeded jittered grid, min spacing, scale range, slope limit, water avoidance, material filter; grouped under Workspace.Environment.<name>.",
      params: { kinds: { type: "array", req: false, desc: "[\"pine\",\"rock\",...] (or kind: one name)" }, kind: { type: "string", req: false }, template: { type: "string", req: false, desc: "path of a Model / Part to clone instead of built-ins" }, count: { type: "number", req: false, desc: "props to place, max 800 (default 60)" }, center: pt("[x, y_above_ground, z] - rays start at y (default [0,60,0])"), size: { type: "any", req: false, desc: "[x, z] area (default 200)" }, radius: { type: "number", req: false, desc: "circular-ish area instead of size" },
        seed: { type: "number", req: false }, min_spacing: { type: "number", req: false }, scale: { type: "array", req: false, desc: "[min, max] scale (default [0.8,1.3])" }, slope_max: { type: "number", req: false, desc: "max ground slope in degrees (default 35)" }, avoid_water: { type: "boolean", req: false, desc: "default true" }, on_materials: { type: "array", req: false, desc: "only place on these terrain materials" }, palette: { type: "object", req: false, desc: "{leaf, leaf2, trunk, rock, flower, crystal, cactus} as [r,g,b]" }, align_to_ground: { type: "boolean", req: false }, name: { type: "string", req: false, desc: "group name (re-run replaces it)" } } },
    { name: "road_build", description: "Part-built road along a Catmull-Rom spline that follows the ground (raycast per sample): width, material (Asphalt, Concrete, Cobblestone, Ground, WoodPlanks, Brick, Pavement...), colour, centre lines, curbs, optional terrain paint underneath. For a road carved into terrain use terrain_path {kind:'road'}.",
      params: { points: { type: "array", req: true, desc: "[[x,z] or [x,y,z], ...] at least 2" }, width: { type: "number", req: false, desc: "default 12" }, material: { type: "string", req: false }, color: { type: "array", req: false, desc: "[r,g,b]" }, lines: { type: "boolean", req: false, desc: "dashed centre line" }, curbs: { type: "boolean", req: false }, follow_ground: { type: "boolean", req: false, desc: "default true" }, smooth: { type: "boolean", req: false, desc: "default true" }, segment: { type: "number", req: false, desc: "segment length (default 6)" }, thickness: { type: "number", req: false }, paint_terrain: { type: "string", req: false, desc: "also paint the terrain under the road with this material" }, name: { type: "string", req: false } } },
    { name: "map_generate", description: "A whole playable environment in one call from a preset: island_survival, green_valley, arena, archipelago, canyon_run, snow_peaks, volcano, swamp, desert_oasis, highlands, lake_district, crater. Terrain + water + (river) + spawn pad on the flattest spot + biome foliage / rocks + matching Lighting / Atmosphere / Clouds. Seeded and rebuildable.",
      params: { preset: { type: "string", req: false, desc: "one of the 12 presets (default green_valley)" }, size: { type: "number", req: false, desc: "studs per side, 64-2048 (default 512)" }, seed: { type: "number", req: false }, center: pt("[x, base_y, z]"), height: { type: "number", req: false, desc: "relief amplitude override" }, foliage: { type: "string", req: false, desc: "none|light|medium|dense (default medium)" }, spawn: { type: "boolean", req: false, desc: "place a SpawnLocation (default true)" }, lighting: { type: "boolean", req: false, desc: "apply the preset lighting (default true)" }, river: { type: "boolean", req: false, desc: "valley / canyon river (default true)" }, materials: { type: "object", req: false, desc: "{top, slope, under, beach, peak} overrides" } } },
  ];
  const NAMES = C.map((c) => c.name);

  function isNumArr(v, n) { return Array.isArray(v) && v.length >= n && v.slice(0, n).every((x) => Number.isFinite(Number(x))); }
  function validate(op, a) {
    const lower = (v) => String(v == null ? "" : v).toLowerCase();
    if (op === "terrain_generate" && a.biome != null && !BIOMES.includes(lower(a.biome))) return `unknown biome '${a.biome}' - use ${BIOMES.join(", ")}`;
    if (op === "terrain_generate" && a.size != null) { const sz = Array.isArray(a.size) ? a.size : [a.size, a.size]; if (sz.some((v) => Number(v) > 2048)) return "size is limited to 2048 studs per axis - generate bigger maps in tiles (several calls with different centers)"; if (sz.some((v) => Number(v) < 16)) return "size must be at least 16 studs"; }
    if (op === "terrain_shape") {
      if (!a.op) return "op is required: " + SHAPE_OPS.join(", ");
      if (!SHAPE_OPS.includes(lower(a.op))) return `unknown op '${a.op}' - use ${SHAPE_OPS.join(", ")}`;
    }
    if (op === "terrain_path" || op === "road_build") {
      if (!Array.isArray(a.points) || a.points.length < 2) return "points must be an array of at least 2 waypoints ([x,z] or [x,y,z])";
      if (!a.points.every((p) => isNumArr(p, 2))) return "every waypoint must be [x,z] or [x,y,z] numbers";
      if (a.points.length > 64) return "at most 64 waypoints per call";
      if (op === "terrain_path" && a.kind != null && !PATH_KINDS.includes(lower(a.kind))) return `unknown kind '${a.kind}' - use ${PATH_KINDS.join(", ")}`;
    }
    if (op === "terrain_water" && a.kind != null && !WATER_KINDS.includes(lower(a.kind))) return `unknown kind '${a.kind}' - use ${WATER_KINDS.join(", ")}`;
    if (op === "terrain_paint_biome" && a.palette != null && !PALETTES.includes(lower(a.palette))) return `unknown palette '${a.palette}' - use ${PALETTES.join(", ")}`;
    if (op === "environment_scatter") {
      const kinds = Array.isArray(a.kinds) ? a.kinds : a.kinds ? [a.kinds] : a.kind ? [a.kind] : [];
      const bad = kinds.filter((k) => !PROP_KINDS.includes(lower(k).replace(/[\s-]/g, "_")));
      if (!a.template && kinds.length && bad.length === kinds.length) return `no known kinds in [${kinds.join(", ")}] - use ${PROP_KINDS.join(", ")} or template`;
      if (a.count != null && !(Number(a.count) >= 1 && Number(a.count) <= 800)) return "count must be 1-800";
    }
    if (op === "map_generate") {
      if (a.preset != null && !MAP_PRESETS.includes(lower(a.preset))) return `unknown preset '${a.preset}' - use ${MAP_PRESETS.join(", ")}`;
      if (a.foliage != null && a.foliage !== false && !FOLIAGE.includes(lower(a.foliage))) return `foliage must be ${FOLIAGE.join("|")}`;
      if (a.size != null && !(Number(a.size) >= 64 && Number(a.size) <= 2048)) return "size must be 64-2048 studs";
    }
    for (const k of ["center", "size"]) if (a[k] != null && !Array.isArray(a[k]) && !(k === "size" && Number.isFinite(Number(a[k])))) return `${k} must be an array like [x, y, z]`;
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
    const body = `local __a = HttpService:JSONDecode([==[${json}]==])\nreturn ENV.run(${JSON.stringify(op)}, __a)`;
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
  RobloxScriptSkills.ENVIRONMENT_COMMANDS = NAMES.slice();
  RobloxScriptSkills.ENVIRONMENT_VERSION = VERSION;
  RobloxScriptSkills.ENVIRONMENT_LIB = LIB;
  RobloxScriptSkills.ENVIRONMENT_ENUMS = Object.freeze({ BIOMES, SHAPE_OPS, PATH_KINDS, WATER_KINDS, PALETTES, PROP_KINDS, MAP_PRESETS, FOLIAGE, ROAD_MATERIALS });
  RobloxScriptSkills.validateEnvironment = validate;
})();
