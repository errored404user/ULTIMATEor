#!/usr/bin/env python3
"""Environment pack (2.2.5) against the miniature Roblox DataModel.

tests/test-environment-pack.js checks the pack statically (registration, params,
validation, wiring). This script runs the REAL generated Luau for all nine commands
in tests/roblox_sim.py, which for 2.2.5 grew a 4-stud voxel Terrain store
(Read/WriteVoxels, FillBlock / FillBall / FillCylinder), Region3, a deterministic
math.noise and an opt-in downward Raycast (terrain column top / anchored part top).

What is checked is what the commands promise: voxels really written, the same seed
rebuilding the same heights, shapes changing only their footprint, rivers lowering the
ground under the line and leaving water, lakes flooding only the bowl, repaint
changing materials but not occupancy, props standing on raycast hits, roads following
the ground, and map presets producing terrain + spawn + foliage + lighting.

Everything here is a MOCK of Roblox; a real Studio run is still the final word.

    pip install lupa && python3 tests/environment-sim.py          (from the TotalScript root)
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
try:
    from roblox_sim import make_runtime
except Exception as e:  # pragma: no cover
    print("SKIP  " + str(e))
    sys.exit(0)
try:
    import lupa  # noqa: F401
except Exception:  # pragma: no cover
    print("SKIP  lupa is not installed (pip install lupa)")
    sys.exit(0)

GEN = r"""
const fs=require("fs"), vm=require("vm");
global.window=global;
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills; const want=JSON.parse(process.argv[1]); const out={programs:{}, libLen:S.ENVIRONMENT_LIB.length};
for(const [k,[n,a]] of Object.entries(want)){ let r; try{ r=S.buildLuau(n,a);}catch(e){ r={err:String(e)}; } out.programs[k]=r&&r.code?r.code:("--ERR "+(r&&r.err)); }
process.stdout.write(JSON.stringify(out));
"""

C = [0, 0, 0]
WANT = {
    # generation + determinism
    "gen_hills": ["terrain_generate", {"biome": "hills", "size": 256, "seed": 3, "center": C}],
    "gen_hills_again": ["terrain_generate", {"biome": "hills", "size": 256, "seed": 3, "center": C}],
    "gen_island": ["terrain_generate", {"biome": "island", "size": 256, "seed": 7, "center": [1000, 0, 0]}],
    "gen_alpine": ["terrain_generate", {"biome": "alpine", "size": 192, "seed": 5, "center": [2000, 0, 0]}],
    "gen_volcanic": ["terrain_generate", {"biome": "volcanic", "size": 192, "seed": 2, "center": [3000, 0, 0]}],
    "gen_too_big": ["terrain_generate", {"biome": "plains", "size": 4096}],
    # survey
    "info_hills": ["terrain_info", {"size": 256, "center": C, "points": [[0, 0], [40, 40], [-60, 60]]}],
    "info_empty": ["terrain_info", {"size": 128, "center": [9000, 0, 9000]}],
    # sculpt
    "shape_crater": ["terrain_shape", {"op": "crater", "center": [40, 0, 40], "radius": 40, "height": 20}],
    "shape_mountain": ["terrain_shape", {"op": "mountain", "center": [-70, 0, -70], "radius": 36, "height": 50, "material": "Snow"}],
    "shape_flatten": ["terrain_shape", {"op": "flatten", "center": [60, 0, -60], "radius": 24, "level": 2}],
    "shape_void": ["terrain_shape", {"op": "hill", "center": [5000, 0, 5000], "radius": 30}],
    # routes
    "path_river": ["terrain_path", {"kind": "river", "points": [[-120, -120], [0, -20], [120, 100]], "width": 12, "depth": 6}],
    "path_road": ["terrain_path", {"kind": "road", "points": [[-100, 80], [0, 90], [100, 70]], "width": 10}],
    # water
    "water_lake": ["terrain_water", {"kind": "lake", "center": [-60, 0, 60], "radius": 30, "level": 4}],
    "water_ocean": ["terrain_water", {"kind": "ocean", "center": [1000, 0, 0], "size": 256, "level": 0, "style": {"transparency": 0.5, "wave_size": 0.3}}],
    # repaint
    "paint_desert": ["terrain_paint_biome", {"palette": "desert", "center": C, "size": 256}],
    # props + roads
    "scatter": ["environment_scatter", {"kinds": ["pine", "rock", "bush"], "count": 60, "center": C, "size": 200, "seed": 5, "name": "forest"}],
    "scatter_again": ["environment_scatter", {"kinds": ["oak"], "count": 10, "center": C, "size": 200, "seed": 6, "name": "forest"}],
    "scatter_template": ["environment_scatter", {"template": "Workspace.Lamp", "count": 8, "center": C, "size": 120, "seed": 1, "name": "lamps", "slope_max": 89}],
    "scatter_nothing": ["environment_scatter", {"kinds": ["pine"], "count": 10, "center": [9000, 0, 9000], "size": 100}],
    "road": ["road_build", {"points": [[-100, 0], [0, 0], [80, 60]], "width": 10, "material": "Asphalt", "lines": True, "curbs": True}],
    # whole maps
    "map_island": ["map_generate", {"preset": "island_survival", "size": 256, "seed": 11, "center": [600, 0, 600]}],
    "map_volcano": ["map_generate", {"preset": "volcano", "size": 192, "seed": 2, "center": [-600, 0, 600], "foliage": "none"}],
    "map_arena": ["map_generate", {"preset": "arena", "size": 128, "seed": 4, "center": [-600, 0, -600]}],
}

gen = subprocess.run(["node", "-e", GEN, json.dumps(WANT)], capture_output=True, text=True)
if gen.returncode != 0:
    print("FAIL  generator: " + gen.stderr[-1500:])
    sys.exit(1)
data = json.loads(gen.stdout)
programs = data["programs"]

passed = failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS  " + name)
    else:
        failed += 1
        print("FAIL  " + name + ("  -- " + str(detail)[:700] if detail != "" else ""))

L, M, run = make_runtime()
L.globals()["M"] = M
M.raycastEnabled = True
lua = L.execute

# a lamp template for the template path + an anchored platform under part of the forest area
lua(r"""
local lamp = Instance.new("Model") lamp.Name = "Lamp"
local post = Instance.new("Part") post.Name = "Post" post.Size = Vector3.new(1, 8, 1) post.CFrame = CFrame.new(0, 4, 0) post.Anchored = true post.Parent = lamp
lamp.PrimaryPart = post lamp.Parent = workspace
""")

_top = L.eval("function(x, z) local y, m = M.terrainTop(x, z, 400) return y end")
_topm = L.eval("function(x, z) local y, m = M.terrainTop(x, z, 400) return m end")
_solid = L.eval("function(x, z) local y, m = M.terrainTop(x, z, 400, true) return y end")
def top(x, z): return _top(x, z)
def topm(x, z): return _topm(x, z)
def solid(x, z): return _solid(x, z)

def heights_signature(center, size):
    # sample the voxel store top at a grid of columns (independent of the pack's own reader)
    f = L.eval("function(cx, cz, size) local out = {} for x = -size/2 + 8, size/2 - 8, 16 do for z = -size/2 + 8, size/2 - 8, 16 do local y = M.terrainTop(cx + x, cz + z, 400) out[#out+1] = y and math.floor(y * 10) / 10 or -999 end end return table.concat(out, ',') end")
    return f(center[0], center[2], size)

# ── generation ────────────────────────────────────────────────────────────────
r = run("gen_hills", programs["gen_hills"])
ok("terrain_generate hills: ok, 4096 columns, voxels written through WriteVoxels", r.get("ok") and r["data"]["columns"] == 4096 and r["data"]["voxels"] > 10000 and M.terrainWrites > 0, r)
ok("terrain_generate hills: heights are a real range around the base (not flat, not symmetric noise artefacts)", r.get("ok") and r["data"]["min_height"] < -3 and r["data"]["max_height"] > 3 and r["data"]["max_height"] - r["data"]["min_height"] > 8, r.get("data"))
ok("terrain_generate hills: no water for a dry biome, materials reported", r.get("ok") and r["data"]["water"] is False and r["data"]["materials"]["top"] == "Grass", r.get("data"))
ok("terrain_generate hills: flat spots are inside the region and carry x/y/z/range", r.get("ok") and len(r["data"]["flat_spots"]) >= 1 and all(abs(s["x"]) <= 128 and abs(s["z"]) <= 128 and "range" in s for s in r["data"]["flat_spots"]), r.get("data", {}).get("flat_spots"))
sig1 = heights_signature(C, 256)
ok("voxel store: the written surface is readable by an independent column scan (no -999 holes)", "-999" not in sig1 and len(sig1) > 100, sig1[:120])
r2 = run("gen_hills_again", programs["gen_hills_again"])
sig2 = heights_signature(C, 256)
ok("terrain_generate: same seed + size + center rebuilds the identical surface", r2.get("ok") and sig1 == sig2, (sig1[:80], sig2[:80]))
attrs = L.eval("function() local e = workspace:FindFirstChild('Environment') return e and e:GetAttribute('TerrainBiome'), e and e:GetAttribute('TerrainSeed') end")()
ok("terrain_generate: biome + seed stored as attributes on Workspace.Environment", attrs[0] == "hills" and attrs[1] == 3, attrs)

r = run("gen_island", programs["gen_island"])
ok("terrain_generate island: water at sea level 0, land above it, sandstone under", r.get("ok") and r["data"]["water"] is True and r["data"]["sea_level"] == 0 and r["data"]["max_height"] > 10 and r["data"]["min_height"] < -5 and r["data"]["materials"]["under"] == "Sandstone", r.get("data"))
water_island = L.eval("function() local n = 0 for k, v in pairs(M.voxels) do if v.m == 'Water' then n = n + 1 end end return n end")()
ok("terrain_generate island: Water voxels really exist in the store", water_island > 500, water_island)
edge = top(1000 - 124, -124)
ok("terrain_generate island: the corner of the island region is under the sea (mask falls off)", edge is not None and edge < 0, edge)

r = run("gen_alpine", programs["gen_alpine"])
ok("terrain_generate alpine: lifted relief (mean well above the lakes), snow line reported", r.get("ok") and r["data"]["max_height"] > 25 and r["data"]["sea_level"] < 0 and r["data"]["materials"]["snow_line"] > 0, r.get("data"))
r = run("gen_volcanic", programs["gen_volcanic"])
ok("terrain_generate volcanic: cone + crater and a lava pool (FillCylinder with CrackedLava)", r.get("ok") and r["data"].get("lava") and r["data"]["lava"]["radius"] > 0 and M.terrainFills >= 1, r.get("data"))
lava = L.eval("function() local n = 0 for k, v in pairs(M.voxels) do if v.m == 'CrackedLava' then n = n + 1 end end return n end")()
ok("terrain_generate volcanic: CrackedLava voxels exist", lava > 0, lava)
r = run("gen_too_big", programs["gen_too_big"])
ok("terrain_generate: 4096 studs per side is refused with a tiling hint (no partial write)", (not r.get("ok")) and "tiles" in str(r.get("error", "")), r)

# ── survey ────────────────────────────────────────────────────────────────────
r = run("info_hills", programs["info_hills"])
d = r.get("data", {})
ok("terrain_info: full coverage, bounds, mean, histogram, point heights with slope + material", r.get("ok") and d.get("coverage") == 100 and d["columns_with_terrain"] == 4096 and len(d["materials"]) >= 2 and len(d["heights"]) == 3 and all("slope" in h and h.get("material") for h in d["heights"]), d)
ok("terrain_info: point heights agree with the independent column scan (within a voxel)", r.get("ok") and all(abs(h["height"] - top(h["x"], h["z"])) <= 4.01 for h in d["heights"]), d.get("heights"))
ok("terrain_info: reports the stored biome / seed (last generation: volcanic / 2) and the water look", r.get("ok") and d.get("biome") == "volcanic" and d.get("seed") == 2 and "wave_size" in d.get("water_look", {}), d)
r = run("info_empty", programs["info_empty"])
ok("terrain_info on an empty region: ok with has_terrain=false and a next-step note (not an error)", r.get("ok") and r["data"]["has_terrain"] is False and "terrain_generate" in r["data"]["note"], r)

# ── sculpt ────────────────────────────────────────────────────────────────────
before_far = top(-100, -100)
before_center = top(40, 40)
r = run("shape_crater", programs["shape_crater"])
after_far = top(-100, -100)
after_center = top(40, 40)
ok("terrain_shape crater: ok, columns changed only inside the footprint, centre lowered, far column untouched", r.get("ok") and 100 < r["data"]["columns_changed"] < 600 and after_center < before_center - 5 and after_far == before_far, (r.get("data"), before_center, after_center, before_far, after_far))
ok("terrain_shape crater: reports baseline + new height range (finite, from existing columns)", r.get("ok") and -200 < r["data"]["min_height"] < r["data"]["max_height"] < 200, r.get("data"))
r = run("shape_mountain", programs["shape_mountain"])
peak = top(-70, -70)
mat = topm(-70, -70)
ok("terrain_shape mountain: peak raised by about the height with the requested surface material", r.get("ok") and peak > 25 and mat == "Snow", (r.get("data"), peak, mat))
r = run("shape_flatten", programs["shape_flatten"])
flat = [top(x, z) for x, z in [(60, -60), (64, -56), (56, -64), (68, -60)]]
ok("terrain_shape flatten {level}: the pad sits at the level (+-1 voxel) across its centre", r.get("ok") and all(abs(h - 2) <= 4.01 for h in flat), (r.get("data"), flat))
r = run("shape_void", programs["shape_void"])
void_top = top(5000, 5000)
ok("terrain_shape on empty ground: builds the hill from the baseline (no -120 floor), min/max from real columns", r.get("ok") and r["data"]["min_height"] >= -1 and r["data"]["max_height"] > 10 and void_top is not None and void_top > 15, (r.get("data"), void_top))

# ── routes ────────────────────────────────────────────────────────────────────
before_on = solid(0, -20)
before_off = top(60, -110)
r = run("path_river", programs["path_river"])
after_on = (solid(0, -20), topm(0, -20))
after_off = top(60, -110)
ok("terrain_path river: ok, solid ground under the waypoint lowered by about the depth, far column untouched", r.get("ok") and r["data"]["columns_changed"] > 100 and after_on[0] < before_on - 3 and after_off == before_off, (r.get("data"), before_on, after_on, before_off, after_off))
ok("terrain_path river: the column top under the line is now Water (filled just under the bed line)", after_on[1] == "Water", after_on)
ok("terrain_path river: 3 waypoints became a smooth sampled spline (> 20 samples)", r.get("ok") and r["data"]["samples"] > 20 and r["data"]["waypoints"] == 3, r.get("data"))
r = run("path_road", programs["path_road"])
road_mat = topm(0, 90)
ok("terrain_path road: ok, painted with the road material, no water", r.get("ok") and r["data"]["water"] is False and road_mat == r["data"]["material"], (r.get("data"), road_mat))

# ── water ─────────────────────────────────────────────────────────────────────
r = run("water_lake", programs["water_lake"])
inside = (top(-60, 60), topm(-60, 60))
shore = (top(-60 + 42, 60), topm(-60 + 42, 60))
ok("terrain_water lake: ok, water voxels filled, the bowl centre is Water at the level", r.get("ok") and r["data"]["water_voxels"] > 50 and inside[1] == "Water" and abs(inside[0] - 4) <= 4.01, (r.get("data"), inside))
ok("terrain_water lake: the shore outside the radius stays dry", shore[1] != "Water", shore)
r = run("water_ocean", programs["water_ocean"])
wt = L.eval("function() return workspace.Terrain.WaterTransparency, workspace.Terrain.WaterWaveSize end")()
ok("terrain_water ocean: ok over the island region, style applied to Terrain water properties", r.get("ok") and r["data"]["kind"] == "ocean" and abs(wt[0] - 0.5) < 1e-6 and abs(wt[1] - 0.3) < 1e-6, (r.get("data"), wt))

# ── repaint ───────────────────────────────────────────────────────────────────
occ_before = L.eval("function() local s = 0 for k, v in pairs(M.voxels) do if v.m ~= 'Water' then s = s + v.o end end return s end")()
r = run("paint_desert", programs["paint_desert"])
occ_after = L.eval("function() local s = 0 for k, v in pairs(M.voxels) do if v.m ~= 'Water' then s = s + v.o end end return s end")()
sand = L.eval("function() local n = 0 for k, v in pairs(M.voxels) do if v.m == 'Sand' or v.m == 'Sandstone' then n = n + 1 end end return n end")()
ok("terrain_paint_biome desert: ok, thousands of voxels repainted, Sand / Sandstone now dominate", r.get("ok") and r["data"]["voxels_repainted"] > 1000 and sand > 5000, (r.get("data"), sand))
ok("terrain_paint_biome: total solid occupancy unchanged (shape untouched)", abs(occ_before - occ_after) < 1e-6, (occ_before, occ_after))

# ── props ─────────────────────────────────────────────────────────────────────
r = run("scatter", programs["scatter"])
d = r.get("data", {})
ok("environment_scatter: ok, 60 placed, three kinds present, group under Workspace.Environment", r.get("ok") and d.get("placed") == 60 and set(d.get("by_kind", {})) == {"pine", "rock", "bush"} and d.get("group") == "Workspace.Environment.forest", d)
on_ground = L.eval(r"""function()
  local g = workspace.Environment.forest local bad, n = 0, 0
  for _, m in ipairs(g:GetChildren()) do
    n = n + 1
    local cf, size = m:GetBoundingBox() local y = M.terrainTop(cf.Position.X, cf.Position.Z, 400)
    local bottom = cf.Position.Y - size.Y / 2
    if not y or bottom > y + 1 or bottom < y - 4 then bad = bad + 1 end
    if m:GetAttribute("EnvKind") == nil then bad = bad + 1 end
  end
  return n, bad
end""")()
ok("environment_scatter: every prop's bounding-box bottom sits on the terrain column top (raycast hit) and carries EnvKind", on_ground[0] == 60 and on_ground[1] == 0, on_ground)
anchored = L.eval("function() for _, p in ipairs(workspace.Environment.forest:GetDescendants()) do if p:IsA('BasePart') and not p.Anchored then return false end end return true end")()
ok("environment_scatter: all prop parts are anchored", anchored)
r = run("scatter_again", programs["scatter_again"])
cnt = L.eval("function() return #workspace.Environment.forest:GetChildren() end")()
ok("environment_scatter: re-running with the same name REPLACES the group (10 oaks, not 70 props)", r.get("ok") and cnt == 10 and r["data"]["by_kind"].get("oak") == 10, (cnt, r.get("data")))
r = run("scatter_template", programs["scatter_template"])
lamps = L.eval("function() local g = workspace.Environment:FindFirstChild('lamps') if not g then return -1 end local n = 0 for _, m in ipairs(g:GetChildren()) do if m.Name == 'Lamp' and m:FindFirstChild('Post') then n = n + 1 end end return n end")()
ok("environment_scatter {template}: clones the user's model (Lamp with its Post) - built-ins untouched", r.get("ok") and lamps == 8 and r["data"]["placed"] == 8, (r.get("data"), lamps))
r = run("scatter_nothing", programs["scatter_nothing"])
ok("environment_scatter over nothing: honest failure that says why (every raycast missed) instead of a fake success", (not r.get("ok")) and "nothing placed" in str(r.get("error", "")), r)

r = run("road", programs["road"])
d = r.get("data", {})
ok("road_build: ok, dozens of segments, length about the spline, lines + curbs built", r.get("ok") and d.get("segments", 0) >= 20 and 150 < d.get("length", 0) < 260 and d.get("lines") is True and d.get("curbs") is True, d)
road_fit = L.eval(r"""function()
  local g = workspace.Environment.Road local segs, bad = 0, 0
  for _, p in ipairs(g:GetDescendants()) do
    if p:IsA("BasePart") and p.Name:sub(1, 7) == "Segment" then
      segs = segs + 1
      local y = M.terrainTop(p.Position.X, p.Position.Z, 400)
      if not y or math.abs((p.Position.Y - p.Size.Y / 2) - y) > 6 then bad = bad + 1 end
      if not p.Anchored then bad = bad + 1 end
    end
  end
  return segs, bad
end""")()
ok("road_build: segments are anchored and sit on the ground under them (follow_ground raycasts)", road_fit[0] >= 20 and road_fit[1] <= road_fit[0] * 0.15, road_fit)

# ── maps ──────────────────────────────────────────────────────────────────────
r = run("map_island", programs["map_island"])
d = r.get("data", {})
ok("map_generate island_survival: ok with terrain, sea level, spawn pad, foliage and lighting", r.get("ok") and d.get("voxels", 0) > 10000 and d.get("sea_level") == 0 and d.get("spawn") and d.get("foliage", {}).get("placed", 0) > 10 and d.get("lighting") == "island_survival", d)
spawn = L.eval("function() local s = workspace.Environment.Spawn:FindFirstChildOfClass('SpawnLocation') if not s then return nil end local y = M.terrainTop(s.Position.X, s.Position.Z, 400) return s.Anchored, s.Position.Y, y end")()
ok("map_generate: a real anchored SpawnLocation stands on (or just above) the flattened pad", spawn and spawn[0] is True and spawn[2] is not None and -1 <= spawn[1] - spawn[2] <= 6, spawn)
ok("map_generate: spawn is above the water", d.get("spawn", {}).get("y", -1) > d.get("sea_level", 0) + 1, d.get("spawn"))
light = L.eval("function() local L = game:GetService('Lighting') return L.ClockTime, L:FindFirstChildOfClass('Atmosphere') ~= nil, workspace.Terrain:FindFirstChildOfClass('Clouds') ~= nil end")()
ok("map_generate: lighting preset applied (ClockTime set, Atmosphere + Clouds instances)", light[0] is not None and light[1] is True and light[2] is True, light)
attrs = L.eval("function() local e = workspace.Environment return e:GetAttribute('MapPreset'), e:GetAttribute('MapSeed'), e:GetAttribute('MapSize') end")()
ok("map_generate: preset / seed / size stored on Workspace.Environment for rebuilds", attrs[0] == "island_survival" and attrs[1] == 11 and attrs[2] == 256, attrs)
r = run("map_volcano", programs["map_volcano"])
d = r.get("data", {})
ok("map_generate volcano {foliage:'none'}: lava pool reported, no foliage group created", r.get("ok") and d.get("lava") and not d.get("foliage"), d)
r = run("map_arena", programs["map_arena"])
d = r.get("data", {})
ok("map_generate arena (128): flattened floor with a raised ring - small maps work", r.get("ok") and d.get("voxels", 0) > 1000 and d.get("max_height", 0) - d.get("min_height", 0) > 10, d)

ok("no simulated wait budget blown / no Lua warnings about missing API", M.waits < 200 and not [w for w in list(M.warnings.values()) if "attempt to" in w], list(M.warnings.values())[:3])
ok("generated library is ASCII only (StringValue byte length == char length for the lib cache)", data["libLen"] > 40000)

print("\n%s  environment-sim: %d passed, %d failed (mocked Terrain voxel store - a real Studio run is still the final word)" % ("OK" if failed == 0 else "FAIL", passed, failed))
sys.exit(1 if failed else 0)
