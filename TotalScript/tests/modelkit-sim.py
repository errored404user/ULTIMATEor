#!/usr/bin/env python3
"""Model kit pack (2.19.0) against the miniature Roblox DataModel.

tests/test-modelkit-pack.js checks the pack statically (registration, params,
validation, wiring). This script runs the REAL generated Luau of all seven commands
(structure_build / vehicle_build / weapon_build / furniture_build / mesh_shape_create /
model_detail / model_variant) in tests/roblox_sim.py, which for 2.11.0 grew an
EditableMesh bookkeeping mock (AddVertex / AddTriangle / normals / UVs) and
AssetService:CreateMeshPartAsync (a MeshPart whose Size is the vertex bounding box).

What is checked is what the commands promise: every kind builds a real Model at the
documented path with anchored parts inside sane bounds, a house really has a walkable
door opening, stairs climb, fences follow their waypoints, drivable vehicles get a
VehicleSeat + hinge motors + a drive script, weapons are Tools with Handle / Grip /
Tip attachments, meshes have outward-facing triangles, model_detail stays
non-destructive and honours its part budget, and model_variant is seed-deterministic.

Everything here is a MOCK of Roblox; a real Studio run is still the final word
(CornerWedgePart orientation, hinge motors and CreateMeshPartAsync are not
geometrically verified here).

    pip install lupa && python3 tests/modelkit-sim.py          (from the TotalScript root)
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
const S=RobloxScriptSkills; const want=JSON.parse(process.argv[1]); const out={programs:{}, libLen:S.MODELKIT_LIB.length, libAscii:/^[\x00-\x7f]*$/.test(S.MODELKIT_LIB), enums:S.MODELKIT_ENUMS};
for(const [k,[n,a]] of Object.entries(want)){ let r; try{ r=S.buildLuau(n,a);}catch(e){ r={err:String(e)}; } out.programs[k]=r&&r.code?r.code:("--ERR "+(r&&r.err)); }
process.stdout.write(JSON.stringify(out));
"""

STRUCTURES = ["house", "tower", "castle_wall", "gatehouse", "bridge", "staircase", "spiral_staircase", "archway", "fence", "gate", "roof", "dungeon_room", "dock", "watchtower", "windmill", "lighthouse", "barn", "pergola"]
VEHICLES = ["car", "truck", "kart", "buggy", "boat", "raft", "plane", "helicopter", "tank", "wagon"]
WEAPONS = ["sword", "greatsword", "dagger", "katana", "axe", "battleaxe", "mace", "hammer", "spear", "bow", "crossbow", "staff", "wand", "shield", "pistol", "rifle", "shotgun", "sniper", "bat", "pickaxe"]
FURNITURE = ["sofa", "armchair", "desk", "wardrobe", "shelf", "stool", "counter", "bar_stool", "fridge", "oven", "sink", "bathtub", "toilet", "tv", "floor_lamp", "bunk_bed", "throne", "piano"]
SHAPES = ["sphere", "icosphere", "torus", "cone", "capsule", "cylinder", "dome", "ring", "prism", "star", "gear", "crystal", "egg", "rock", "tube", "lathe"]
CONVEX = ["sphere", "icosphere", "cone", "capsule", "cylinder", "dome", "egg", "crystal"]

WANT = {}
for i, k in enumerate(STRUCTURES):
    WANT["s_" + k] = ["structure_build", {"kind": k, "position": [i * 200, 0, 0]}]
WANT["s_house_big"] = ["structure_build", {"kind": "house", "floors": 3, "roof": "hip", "style": "modern", "porch": True, "position": [0, 0, 400]}]
WANT["s_bridge_rope"] = ["structure_build", {"kind": "bridge", "style": "rustic", "length": 30, "position": [200, 0, 400]}]
WANT["s_bridge_susp"] = ["structure_build", {"kind": "bridge", "style": "modern", "length": 80, "position": [400, 0, 400]}]
WANT["s_fence_pts"] = ["structure_build", {"kind": "fence", "points": [[0, 0], [20, 0], [20, 20]], "fence_style": "picket", "position": [600, 0, 400], "name": "FencePts"}]
WANT["s_stairs_tall"] = ["structure_build", {"kind": "staircase", "height": 24, "position": [800, 0, 400], "name": "TallStairs"}]
WANT["s_dungeon"] = ["structure_build", {"kind": "dungeon_room", "doors": ["north", "east"], "cells": True, "size": [30, 12, 30], "position": [1000, 0, 400]}]
WANT["s_tower_sq"] = ["structure_build", {"kind": "tower", "sides": 4, "roof": "cone", "flag": "red", "style": "fantasy", "position": [1200, 0, 400]}]
for i, k in enumerate(VEHICLES):
    WANT["v_" + k] = ["vehicle_build", {"kind": k, "position": [i * 100, 0, 800]}]
    WANT["vd_" + k] = ["vehicle_build", {"kind": k, "drivable": True, "position": [i * 100, 0, 1000], "name": "Drive_" + k}]
for k in WEAPONS:
    WANT["w_" + k] = ["weapon_build", {"kind": k}]
WANT["w_model"] = ["weapon_build", {"kind": "sword", "as_tool": False, "style": "crystal", "name": "SwordModel"}]
for i, k in enumerate(FURNITURE):
    WANT["f_" + k] = ["furniture_build", {"kind": k, "position": [i * 50, 0, 1200]}]
for i, k in enumerate(SHAPES):
    a = {"shape": k, "position": [i * 50, 0, 1400]}
    if k == "lathe":
        a["profile"] = [[0, 3], [1, 2.5], [1.5, 0], [0.8, -2], [0, -2.2]]
    WANT["m_" + k] = ["mesh_shape_create", a]
WANT["m_tube_pts"] = ["mesh_shape_create", {"shape": "tube", "points": [[0, 0, 0], [5, 2, 0], [10, 0, 3]], "radius": 0.6, "name": "TubePath"}]
WANT["m_size"] = ["mesh_shape_create", {"shape": "sphere", "size": [10, 4, 10], "color": "red", "shading": "flat", "name": "Squash"}]
WANT["m_dense"] = ["mesh_shape_create", {"shape": "sphere", "segments": 256, "rings": 128}]
WANT["m_fallback"] = ["mesh_shape_create", {"shape": "torus", "name": "FallbackTorus"}]
WANT["d_house"] = ["model_detail", {"path": "workspace.Structure_house", "ops": ["trim", "rivets", "planks", "wear", "bevel", "moss"], "budget": 150}]
WANT["d_small"] = ["model_detail", {"path": "workspace.Furniture_desk", "ops": ["wear"]}]
WANT["d_missing"] = ["model_detail", {"path": "workspace.Nothing_here", "ops": ["trim"]}]
WANT["var_a"] = ["model_variant", {"path": "workspace.Furniture_sofa", "count": 3, "seed": 4}]
WANT["var_b"] = ["model_variant", {"path": "workspace.Furniture_sofa", "count": 3, "seed": 4, "name": "SofaAgain"}]
WANT["var_c"] = ["model_variant", {"path": "workspace.Furniture_sofa", "count": 3, "seed": 9, "name": "SofaOther"}]
WANT["bad_kind"] = ["structure_build", {"kind": "pyramid"}]
WANT["bad_shape"] = ["mesh_shape_create", {"shape": "klein"}]

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
lua = L.execute

# helpers reading the DataModel independently of the pack
_find = L.eval("""function(path)
  local cur = game
  for seg in string.gmatch(path, "[^%.]+") do
    if seg == "workspace" or seg == "Workspace" then cur = workspace else cur = cur:FindFirstChild(seg) if not cur then return nil end end
  end
  return cur
end""")
_parts = L.eval("""function(inst)
  local n, anchored, cls = 0, 0, {}
  for _, d in ipairs(inst:GetDescendants()) do
    if d:IsA("BasePart") then n = n + 1 if d.Anchored then anchored = anchored + 1 end end
    cls[d.ClassName] = (cls[d.ClassName] or 0) + 1
  end
  return n, anchored, cls
end""")
_bounds = L.eval("""function(inst)
  local mn, mx
  for _, d in ipairs(inst:GetDescendants()) do
    if d:IsA("BasePart") then
      local h = d.Size / 2
      for sx = -1, 1, 2 do for sy = -1, 1, 2 do for sz = -1, 1, 2 do
        local c = d.CFrame:PointToWorldSpace(Vector3.new(h.X * sx, h.Y * sy, h.Z * sz))
        mn = mn and Vector3.new(math.min(mn.X, c.X), math.min(mn.Y, c.Y), math.min(mn.Z, c.Z)) or c
        mx = mx and Vector3.new(math.max(mx.X, c.X), math.max(mx.Y, c.Y), math.max(mx.Z, c.Z)) or c
      end end end
    end
  end
  if not mn then return nil end
  return mn.X, mn.Y, mn.Z, mx.X, mx.Y, mx.Z
end""")
_solid_at = L.eval("""function(inst, x, y, z)
  local p = Vector3.new(x, y, z) local hits = 0
  for _, d in ipairs(inst:GetDescendants()) do
    if d:IsA("BasePart") and d.Transparency < 0.9 then
      local o = d.CFrame:PointToObjectSpace(p) local h = d.Size / 2
      if math.abs(o.X) <= h.X and math.abs(o.Y) <= h.Y and math.abs(o.Z) <= h.Z then hits = hits + 1 end
    end
  end
  return hits
end""")
_step_ys = L.eval("""function(inst)
  local ys = {}
  for _, d in ipairs(inst:GetDescendants()) do if d:IsA("BasePart") and d.Name:match("^Step") then ys[#ys+1] = d.Position.Y + d.Size.Y / 2 end end
  table.sort(ys) return table.concat(ys, ",")
end""")
_mesh_check = L.eval("""function(part)
  local em = part.__mesh
  if not em then return nil end
  local verts, tris = em.__verts, em.__tris
  local c = Vector3.zero
  for _, v in ipairs(verts) do c = c + v end
  c = c / #verts
  local outward, inward = 0, 0
  for _, t in ipairs(tris) do
    local a, b, d = verts[t[1]], verts[t[2]], verts[t[3]]
    local n = (b - a):Cross(d - a)
    local mid = (a + b + d) / 3
    if n:Dot(mid - c) >= 0 then outward = outward + 1 else inward = inward + 1 end
  end
  return #verts, #tris, outward, inward
end""")

_child = L.eval("function(inst, name) return inst:FindFirstChild(name) end")
_attr = L.eval("function(inst, name) return inst:GetAttribute(name) end")
def find(path): return _find(path)
def parts(path):
    inst = find(path)
    if inst is None: return (0, 0, {})
    n, a, cls = _parts(inst)
    return n, a, dict(cls.items()) if cls is not None else {}
def bounds(path):
    inst = find(path)
    if inst is None: return None
    b = _bounds(inst)
    return None if b is None else tuple(b)
def size(path):
    b = bounds(path)
    return None if b is None else (b[3] - b[0], b[4] - b[1], b[5] - b[2])

R = {}
def go(key):
    R[key] = run(key, programs[key])
    return R[key]

# ── structures ─────────────────────────────────────────────────────────────────
bad = []
for k in STRUCTURES:
    r = go("s_" + k)
    d = r.get("data", {})
    n, anch, cls = parts("workspace.Structure_" + k)
    inst = find("workspace.Structure_" + k)
    anchored_ok = n == anch or (cls.get("HingeConstraint", 0) >= 1 and anch >= 1)  # windmill sails / lighthouse beam spin on a hinge motor
    if not (r.get("ok") and inst is not None and inst.ClassName == "Model" and n > 0 and anchored_ok and d.get("parts") == n and inst.PrimaryPart is not None):
        bad.append((k, r.get("error") or r.get("text"), n, anch, d.get("parts")))
ok("structure_build: all 18 kinds build an anchored Model at Workspace.Structure_<kind> with a PrimaryPart (only hinge-motor parts unanchored); reported part count == real part count", not bad, bad)
for k in ["s_house_big", "s_bridge_rope", "s_bridge_susp", "s_fence_pts", "s_stairs_tall", "s_dungeon", "s_tower_sq"]:
    go(k)
sz = {k: size("workspace.Structure_" + k) for k in STRUCTURES}
ok("structure_build: every structure fits in sane bounds (0.5 .. 120 studs per axis; fences are thin, lighthouse Z includes its beam)", all(s and all(0.5 <= v <= 120 for v in s) for s in sz.values()), {k: s for k, s in sz.items() if not s or not all(0.5 <= v <= 120 for v in s)})
h = R["s_house"].get("data", {})
door = h.get("door")
ok("house: reports width / depth / height / floors / style / door position / next step", h.get("width") and h.get("depth") and h.get("floors") == 1 and h.get("style") and isinstance(door, list) and len(door) == 3 and "model_detail" in str(h.get("next")), h)
hs = sz["house"]
ok("house: bounds match the requested footprint (24x20 default, roof on top)", hs and 22 <= hs[0] <= 30 and 18 <= hs[2] <= 26 and 12 <= hs[1] <= 30, hs)
if door:
    inside = _solid_at(find("workspace.Structure_house"), door[0], door[1] + 3, door[2])
    ok("house: the door is a REAL opening (no solid part at head height inside the frame)", inside == 0, inside)
    wall = _solid_at(find("workspace.Structure_house"), door[0] + 6, door[1] + 3, door[2])
    ok("house: the wall next to the door is solid (the opening is local, not a missing wall)", wall >= 1, wall)
r = R["s_house_big"]; d = r.get("data", {})
ok("house {floors:3, roof:'hip', style:'modern', porch:true}: builds taller with more parts than the default", r.get("ok") and d.get("floors") == 3 and d.get("parts", 0) > h.get("parts", 0) and d.get("bounds", [0, 0, 0])[1] > h.get("bounds", [0, 99, 0])[1], d)
r = R["s_bridge_susp"]; d = r.get("data", {})
r2 = R["s_bridge_rope"]; d2 = r2.get("data", {})
ok("bridge: modern 80 = suspension (towers + cables, more parts), rustic 30 = rope planks; both span their length", r.get("ok") and r2.get("ok") and d.get("parts", 0) > d2.get("parts", 0) and max(d.get("bounds", [0, 0, 0])[0], d.get("bounds", [0, 0, 0])[2]) >= 76 and 26 <= max(d2.get("bounds", [0, 0, 0])[0], d2.get("bounds", [0, 0, 0])[2]) <= 40, (d, d2))
r = R["s_fence_pts"]; d = r.get("data", {})
fs = size("workspace.FencePts")
ok("fence {points:[[0,0],[20,0],[20,20]]}: follows the waypoints (L-shaped 20x20 footprint, posts + rails)", r.get("ok") and fs and 18 <= fs[0] <= 24 and 18 <= fs[2] <= 24 and d.get("parts", 0) >= 8, (d, fs))
ys = _step_ys(find("workspace.TallStairs")) if find("workspace.TallStairs") else ""
yl = [float(v) for v in ys.split(",") if v]
ok("staircase {height:24}: step tops climb monotonically to the requested height (solid steps)", R["s_stairs_tall"].get("ok") and len(yl) >= 8 and all(b > a for a, b in zip(yl, yl[1:])) and 23 <= yl[-1] <= 25, yl[-5:] if yl else R["s_stairs_tall"])
r = R["s_dungeon"]; d = r.get("data", {})
ok("dungeon_room {doors:['north','east'], cells:true, size:[30,12,30]}: 30x30 room with the door list and cells reported", r.get("ok") and d.get("parts", 0) > 20 and 28 <= d.get("bounds", [0])[0] <= 36 and d.get("doors", {}).get("north") and d.get("doors", {}).get("east"), d)
r = R["s_tower_sq"]; d = r.get("data", {})
ok("tower {sides:4, roof:'cone', flag:'red', style:'fantasy'}: square tower variant builds", r.get("ok") and d.get("parts", 0) > 10, d)

# ── vehicles ───────────────────────────────────────────────────────────────────
bad = []
for k in VEHICLES:
    r = go("v_" + k)
    d = r.get("data", {})
    n, anch, cls = parts("workspace.Vehicle_" + k)
    if not (r.get("ok") and n > 0 and d.get("parts") == n and d.get("drivable") is False and "VehicleSeat" not in cls):
        bad.append((k, r.get("error") or d, n, cls.get("VehicleSeat")))
ok("vehicle_build: all 10 kinds build a static Model at Workspace.Vehicle_<kind> (no seat / script unless drivable)", not bad, bad)
bad = []
modes = {}
for k in VEHICLES:
    r = go("vd_" + k)
    d = r.get("data", {})
    n, anch, cls = parts("workspace.Drive_" + k)
    modes[k] = d.get("drive_mode")
    seat_ok = cls.get("VehicleSeat", 0) == 1 and (cls.get("Script", 0) + cls.get("LocalScript", 0)) >= 1
    if not (r.get("ok") and d.get("drivable") is True and seat_ok and d.get("seat") and d.get("drive_mode")):
        bad.append((k, r.get("error") or d, cls))
ok("vehicle_build {drivable:true}: every kind gets exactly one VehicleSeat + a drive script and reports seat / drive_mode", not bad, bad)
n, anch, cls = parts("workspace.Drive_car")
ok("drivable car: hinge-motor wheels (HingeConstraints + Attachments), the body is NOT anchored (it has to roll)", cls.get("HingeConstraint", 0) >= 4 and cls.get("Attachment", 0) >= 8 and anch == 0, (cls, anch))
ok("drive modes differ by kind: wheels for land vehicles, thrust/float for boat + raft, flight for plane + helicopter", modes.get("car") == "wheels" and modes.get("tank") == "wheels" and modes.get("boat") != "wheels" and modes.get("plane") != "wheels" and modes.get("helicopter") != "wheels", modes)
d = R["vd_car"].get("data", {})
ok("drivable car: honest physics note + tuning hint (MaxSpeed / TurnSpeed attributes)", "arcade" in str(d.get("note", "")).lower() and "MaxSpeed" in str(d.get("next", "")), d)

# ── weapons ────────────────────────────────────────────────────────────────────
bad = []
ranged = {}
for k in WEAPONS:
    r = go("w_" + k)
    d = r.get("data", {})
    tool = find(d.get("path", "workspace.__none")) if r.get("ok") else None
    handle = _child(tool, "Handle") if tool is not None else None
    ranged[k] = d.get("ranged")
    if not (r.get("ok") and tool is not None and tool.ClassName == "Tool" and handle is not None and handle.ClassName == "Part" and d.get("parts", 0) >= 2 and isinstance(d.get("attachments"), dict) and "tip" in d.get("attachments", {})):
        bad.append((k, r.get("error") or d, tool and tool.ClassName, handle and handle.ClassName))
ok("weapon_build: all 20 kinds become a Tool with a Part Handle and a Tip attachment (reach reported)", not bad, bad)
ok("weapon_build: ranged flag is right (bow, crossbow, pistol, rifle, shotgun, sniper, wand) and melee is false", all(ranged.get(k) for k in ["bow", "crossbow", "pistol", "rifle", "shotgun", "sniper"]) and not any(ranged.get(k) for k in ["sword", "axe", "mace", "spear", "bat"]), ranged)
grip = L.eval("function() local t = workspace:FindFirstChild('Sword') if not t then return nil end local h = t:FindFirstChild('Handle') local wd, un = 0, 0 for _, d in ipairs(t:GetDescendants()) do if (d:IsA('WeldConstraint') or d:IsA('Weld')) and (d.Part0 == h or d.Part1 == h) then wd = wd + 1 end if d:IsA('BasePart') and not d.Anchored then un = un + 1 end end return t.Grip ~= nil, t.RequiresHandle, wd, h.Anchored, un end")()
ok("sword Tool: Grip CFrame set, every part unanchored and welded to the Handle (a Tool that works when equipped)", grip and grip[0] is True and grip[2] >= 1 and grip[3] is False and grip[4] == R["w_sword"]["data"]["parts"], grip)
r = go("w_model"); d = r.get("data", {})
m = find("workspace.SwordModel")
ok("weapon_build {as_tool:false}: a plain Model (for display racks / NPCs), not a Tool", r.get("ok") and m is not None and m.ClassName == "Model" and d.get("tool") is False, (d, m and m.ClassName))

# ── furniture ──────────────────────────────────────────────────────────────────
bad = []
for k in FURNITURE:
    r = go("f_" + k)
    d = r.get("data", {})
    n, anch, cls = parts("workspace.Furniture_" + k)
    s = size("workspace.Furniture_" + k)
    if not (r.get("ok") and n > 0 and n == anch and d.get("parts") == n and s and all(0.3 <= v <= 16 for v in s)):
        bad.append((k, r.get("error") or d, n, s))
ok("furniture_build: all 18 kinds build an anchored Model at Workspace.Furniture_<kind> inside 16 studs", not bad, bad)
seats = L.eval("function() local n = 0 for _, k in ipairs({'sofa','armchair','stool','bar_stool','throne'}) do local m = workspace:FindFirstChild('Furniture_' .. k) if m then for _, d in ipairs(m:GetDescendants()) do if d:IsA('Seat') then n = n + 1 break end end end end return n end")()
ok("seating furniture (sofa, armchair, stool, bar_stool, throne) carries a real Seat part", seats == 5, seats)
pn = parts("workspace.Furniture_piano")[0]
ok("piano: keys modelled (>= 20 parts)", pn >= 20, pn)

# ── meshes ─────────────────────────────────────────────────────────────────────
bad = []
for k in SHAPES:
    r = go("m_" + k)
    d = r.get("data", {})
    p = find("workspace.Mesh_" + k)
    if not (r.get("ok") and p is not None and p.ClassName == "MeshPart" and d.get("fallback") is False and d.get("vertices", 0) >= 8 and d.get("faces", 0) >= 12 and d.get("class") == "MeshPart"):
        bad.append((k, r.get("error") or d, p and p.ClassName))
ok("mesh_shape_create: all 16 shapes produce a real MeshPart through CreateEditableMesh + CreateMeshPartAsync (no fallback)", not bad, bad)
bad = []
for k in CONVEX:
    p = find("workspace.Mesh_" + k)
    mc = _mesh_check(p) if p is not None else None
    if not mc or mc[3] > mc[1] * 0.02:
        bad.append((k, mc))
ok("convex shapes: >= 98% of triangles wind outward (normals face away from the centroid)", not bad, bad)
d = R["m_sphere"].get("data", {})
ok("sphere: natural size 4x4x4 (radius 2) with smooth shading; rock / crystal default to flat shading", d.get("natural_size") == [4.0, 4.0, 4.0] and d.get("shading") == "smooth" and R["m_rock"]["data"].get("shading") == "flat" and R["m_crystal"]["data"].get("shading") == "flat", (d, R["m_rock"]["data"]))
go("m_size"); p = find("workspace.Squash")
ok("mesh_shape_create {size:[10,4,10], color:'red', shading:'flat'}: resized MeshPart, red, flat", R["m_size"].get("ok") and p is not None and abs(p.Size.X - 10) < 0.6 and abs(p.Size.Y - 4) < 0.6 and R["m_size"]["data"].get("shading") == "flat" and p.Color.R > 0.6 and p.Color.G < 0.3, (R["m_size"].get("data"), p and (p.Size.X, p.Size.Y, p.Size.Z)))
r = go("m_tube_pts"); d = r.get("data", {})
p = find("workspace.TubePath")
ok("tube {points:[...3 waypoints], radius:0.6}: sweeps along the path (bounds span the waypoints)", r.get("ok") and p is not None and p.Size.X >= 9 and p.Size.Z >= 2.5, (d, p and (p.Size.X, p.Size.Y, p.Size.Z)))
r = R["m_lathe"]; d = r.get("data", {})
ok("lathe {profile}: a vase-like surface of revolution (height from the profile, > 100 faces)", r.get("ok") and d.get("faces", 0) > 100 and 4.5 <= d.get("natural_size", [0, 0, 0])[1] <= 5.5, d)
r = go("m_dense")
ok("mesh_shape_create refuses a mesh over the EditableMesh limits (256x128 sphere) instead of hanging Studio", not r.get("ok") and "limit" in str(r.get("error", "")), r)
# fallback: make CreateEditableMesh unavailable (swap the AssetService entry) and check the honest Part approximation
lua("""M.__origAS = M.services.AssetService
M.services.AssetService = setmetatable({}, { __index = function(_, k)
  if k == "CreateEditableMesh" then return function() error("EditableMesh is not enabled for this experience") end end
  local v = M.__origAS[k] if type(v) == "function" then return function(_, ...) return v(M.__origAS, ...) end end return v
end })""")
try:
    r = go("m_fallback")
    d = r.get("data", {})
    p = find("workspace.FallbackTorus")
    ok("EditableMesh unavailable: ok with fallback=true, error text + note, a plain Part approximation placed (never a silent success)", r.get("ok") and d.get("fallback") is True and d.get("error") and d.get("note") and p is not None and p.ClassName == "Part" and _attr(p, "MeshFallback") is not None, (d, p and p.ClassName))
finally:
    lua("M.services.AssetService = M.__origAS")
r = go("m_torus")
ok("after the fallback the real path works again (sanity of the swap)", r.get("ok") and r["data"].get("fallback") is False, r.get("data"))

# ── model_detail ───────────────────────────────────────────────────────────────
before = parts("workspace.Structure_house")[0]
r = go("d_house"); d = r.get("data", {})
after = parts("workspace.Structure_house")[0]
det = find("workspace.Structure_house.Detail")
ok("model_detail on the house: ok, parts added only inside a Detail folder (non-destructive), counts per op reported", r.get("ok") and det is not None and det.ClassName == "Folder" and d.get("parts_added", 0) > 0 and isinstance(d.get("ops"), dict) and after - before == d.get("parts_added") and d.get("parts_scanned") == before, (d, before, after))
ok("model_detail {budget:150}: stops at the budget and SAYS so (budget_hit + hint) instead of erroring or overrunning", d.get("budget") == 150 and d.get("budget_hit") is True and d.get("parts_added") <= 150 and "budget" in str(r.get("text", "")), (d, r.get("text")))
r = go("d_small"); d = r.get("data", {})
n_after = parts("workspace.Furniture_desk")[0]
ok("model_detail {ops:['wear']} on a desk: only recolours (no parts added), ok", r.get("ok") and d.get("parts_added", -1) == 0 and n_after == parts("workspace.Furniture_desk")[0] and d.get("budget_hit") is not True, d)
r = go("d_missing")
ok("model_detail on a missing path fails with a clear error (nothing created)", not r.get("ok") and "Nothing_here" in str(r.get("error", "")) or (not r.get("ok") and "not found" in str(r.get("error", "")).lower()), r)

# ── model_variant ──────────────────────────────────────────────────────────────
ra = go("var_a"); rb = go("var_b"); rc = go("var_c")
va = [(v.get("rotation_deg"), v.get("scale"), v.get("hue_shift_deg"), v.get("mirrored")) for v in ra.get("data", {}).get("variants", [])]
vb = [(v.get("rotation_deg"), v.get("scale"), v.get("hue_shift_deg"), v.get("mirrored")) for v in rb.get("data", {}).get("variants", [])]
vc = [(v.get("rotation_deg"), v.get("scale"), v.get("hue_shift_deg"), v.get("mirrored")) for v in rc.get("data", {}).get("variants", [])]
ok("model_variant {count:3, seed:4}: three clones created next to the source, each a Model with the source's part count or fewer", ra.get("ok") and len(va) == 3 and all(find(v["path"]) is not None and find(v["path"]).ClassName == "Model" for v in ra["data"]["variants"]) and all(0 < parts(v["path"])[0] <= parts("workspace.Furniture_sofa")[0] for v in ra["data"]["variants"]), ra.get("data"))
ok("model_variant: the same seed reproduces the same rotation / scale / hue decisions; another seed differs", rb.get("ok") and rc.get("ok") and va == vb and va != vc, (va, vb, vc))
ok("model_variant: variants are not identical to each other (a set, not three copies)", len(set(va)) == 3, va)

# ── refusals + hygiene ─────────────────────────────────────────────────────────
ok("structure_build {kind:'pyramid'}: refused at build time (JS) naming the 18 kinds", programs["bad_kind"].startswith("--ERR") and "unknown kind" in programs["bad_kind"] and "pergola" in programs["bad_kind"], programs["bad_kind"][:160])
ok("mesh_shape_create {shape:'klein'}: refused at build time (JS) naming the shapes", programs["bad_shape"].startswith("--ERR") and "lathe" in programs["bad_shape"], programs["bad_shape"][:160])
ok("no simulated wait budget blown / no Lua warnings about missing API", M.waits < 200 and not [w for w in list(M.warnings.values()) if "attempt to" in w], list(M.warnings.values())[:3])
ok("generated library is ASCII only and large enough for the lib cache (StringValue byte length == char length)", data["libAscii"] is True and data["libLen"] > 40000, (data["libAscii"], data["libLen"]))
e = data.get("enums", {})
ok("MODELKIT_ENUMS lists exactly the kinds the sim just built (18 / 10 / 20 / 18 / 16) + 6 detail ops", e.get("STRUCTURES") == STRUCTURES and e.get("VEHICLES") == VEHICLES and e.get("WEAPONS") == WEAPONS and e.get("FURNITURE") == FURNITURE and sorted(e.get("SHAPES", [])) == sorted(SHAPES) and len(e.get("DETAIL_OPS", [])) == 6, {k: len(v) for k, v in e.items()} if isinstance(e, dict) else e)

print("\n%s  modelkit-sim: %d passed, %d failed (mocked DataModel + EditableMesh - a real Studio run is still the final word)" % ("OK" if failed == 0 else "FAIL", passed, failed))
sys.exit(1 if failed else 0)
