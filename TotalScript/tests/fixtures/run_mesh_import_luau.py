#!/usr/bin/env python3
"""Run the Luau from src/core/meshimport.js (importer, then verifier) under
lupa with a Roblox stand-in - tests only, MOCK Studio. Modes:
  editable     EditableMesh works (AddVertex/AddTriangle/AddNormal/AddUV ...)
  noeditable   CreateEditableMesh errors -> bounding-box fallback
  nouv         AddUV is missing (older client) -> importer must still succeed
  publishfail  CreateAssetAsync returns Failure
Usage: run_mesh_import_luau.py import.luau [verify.luau] [mode]
Prints one JSON line: {import=<result string>, verify=<decoded JSON or null>, parts=[...], em=[...], published=[...], destroyed=[...]}"""
import json
import sys
import lupa
from lupa import LuaRuntime

imp_path = sys.argv[1]
ver_path = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] not in ("editable", "noeditable", "nouv", "publishfail") else None
mode = sys.argv[-1] if sys.argv[-1] in ("editable", "noeditable", "nouv", "publishfail") else "editable"
lua = LuaRuntime(unpack_returned_tuples=True)
G = lua.globals()
report = {"em": [], "published": [], "destroyed": []}


def to_lua(v):
    if isinstance(v, dict):
        t = lua.table()
        for k, val in v.items():
            t[k] = to_lua(val)
        return t
    if isinstance(v, list):
        t = lua.table()
        for i, val in enumerate(v):
            t[i + 1] = to_lua(val)
        return t
    return v


def from_lua(v):
    if lupa.lua_type(v) == "table":
        keys = list(v.keys())
        if keys and all(isinstance(k, int) for k in keys):
            return [from_lua(v[k]) for k in sorted(keys)]
        return {str(k): from_lua(v[k]) for k in keys if not str(k).startswith("_")}
    return v


G.py_json_decode = lambda s: to_lua(json.loads(s))
G.py_json_encode = lambda t: json.dumps(from_lua(t))
G.py_report = lambda kind, payload: report[kind].append(json.loads(payload))
G.py_mode = mode
lua.execute(r'''
math.clamp = function(v, a, b) return math.max(a, math.min(b, v)) end
local function vec3(x, y, z) return setmetatable({ X = x, Y = y, Z = z, x = x, y = y, z = z, _t = "Vector3" }, { __index = function(t, k) return nil end }) end
Vector3 = { new = vec3 }
Vector2 = { new = function(x, y) return { X = x, Y = y, _t = "Vector2" } end }
CFrame = { new = function(x, y, z) return { X = x, Y = y, Z = z, x = x, y = y, z = z, Position = vec3(x, y, z), _t = "CFrame" } end }
Color3 = { new = function(r, g, b) return { r = r, g = g, b = b, _t = "Color3" } end }
local function enumClass(prefix) return setmetatable({}, { __index = function(t, k) local v = "Enum." .. prefix .. "." .. k rawset(t, k, v) return v end }) end
Enum = { Material = enumClass("Material"), CollisionFidelity = enumClass("CollisionFidelity"), AssetType = { Mesh = "Mesh" }, CreateAssetResult = { Success = "Success" } }
Content = { fromObject = function(o) return { obj = o } end }
local nextId = 1000
local function newInstance(class, name)
  local inst = { ClassName = class, Name = name or class, _children = {}, _attrs = {}, Anchored = false, CanCollide = true, Reflectance = 0, Transparency = 0, Material = "Enum.Material.Plastic", Size = vec3(1, 1, 1) }
  function inst:IsA(c) return c == self.ClassName or (c == "BasePart" and (self.ClassName == "Part" or self.ClassName == "MeshPart")) end
  function inst:FindFirstChild(n) for _, c in ipairs(self._children) do if c.Name == n then return c end end return nil end
  function inst:FindFirstChildWhichIsA(c) for _, ch in ipairs(self._children) do if ch:IsA(c) then return ch end end return nil end
  function inst:GetChildren() local out = {} for i, c in ipairs(self._children) do out[i] = c end return out end
  function inst:SetAttribute(k, v) self._attrs[k] = v end
  function inst:GetAttribute(k) return self._attrs[k] end
  function inst:GetFullName() if self._parent and self._parent ~= game then return self._parent:GetFullName() .. "." .. self.Name end return self.Name end
  function inst:GetPivot() return rawget(self, "WorldPivot") or (rawget(self, "PrimaryPart") and rawget(self, "PrimaryPart").CFrame) or CFrame.new(0, 0, 0) end
  function inst:Destroy()
    py_report("destroyed", '{"name":"' .. self.Name .. '"}')
    if self._parent then for i, c in ipairs(self._parent._children) do if c == self then table.remove(self._parent._children, i) break end end end
    self._parent = nil
  end
  return setmetatable(inst, { __index = function(t, k) if k == "Parent" then return rawget(t, "_parent") end if k == "Position" then local cf = rawget(t, "CFrame") return cf and cf.Position or vec3(0, 0, 0) end return nil end,
    __newindex = function(t, k, v)
      if k == "Parent" then
        if rawget(t, "_parent") then for i, c in ipairs(rawget(t, "_parent")._children) do if c == t then table.remove(rawget(t, "_parent")._children, i) break end end end
        rawset(t, "_parent", v); if v then table.insert(v._children, t) end
      elseif k == "Position" then rawset(t, "CFrame", CFrame.new(v.X, v.Y, v.Z))
      else rawset(t, k, v) end
    end })
end
Instance = { new = function(class) return newInstance(class) end }
game = newInstance("DataModel", "game")
workspace = newInstance("Workspace", "Workspace"); workspace.Parent = game
local Lighting = newInstance("Lighting", "Lighting"); Lighting.Parent = game
local ReplicatedStorage = newInstance("ReplicatedStorage", "ReplicatedStorage"); ReplicatedStorage.Parent = game
local existing = newInstance("Model", "Total_Imported"); existing.Parent = workspace
local HttpService = { JSONDecode = function(self, s) return py_json_decode(s) end, JSONEncode = function(self, t) return py_json_encode(t) end }
local function newEditableMesh()
  local em = { verts = {}, tris = {}, normals = 0, faceNormals = 0, uvs = 0, faceUVs = 0, removedUnused = false, id = nextId }
  nextId = nextId + 1
  function em:AddVertex(v) table.insert(self.verts, v) return #self.verts end
  function em:AddTriangle(a, b, c) table.insert(self.tris, { a, b, c }) return #self.tris end
  function em:AddNormal(n) self.normals = self.normals + 1 return self.normals end
  function em:SetFaceNormals(fid, t) self.faceNormals = self.faceNormals + 1 end
  if py_mode ~= "nouv" then
    function em:AddUV(uv) self.uvs = self.uvs + 1 return self.uvs end
    function em:SetFaceUVs(fid, t) self.faceUVs = self.faceUVs + 1 end
  end
  function em:RemoveUnused() self.removedUnused = true end
  return em
end
local AssetService = {
  CreateEditableMesh = function(self)
    if py_mode == "noeditable" then error("EditableMesh is not enabled") end
    return newEditableMesh()
  end,
  CreateMeshPartAsync = function(self, content, opts)
    local em = content.obj
    if #em.tris == 0 then error("empty mesh") end
    local mp = newInstance("MeshPart", "MeshPart")
    mp._em = em
    -- extent from the vertices, like the engine
    local minx, miny, minz, maxx, maxy, maxz = math.huge, math.huge, math.huge, -math.huge, -math.huge, -math.huge
    for _, v in ipairs(em.verts) do
      if v.X < minx then minx = v.X end if v.Y < miny then miny = v.Y end if v.Z < minz then minz = v.Z end
      if v.X > maxx then maxx = v.X end if v.Y > maxy then maxy = v.Y end if v.Z > maxz then maxz = v.Z end
    end
    mp.Size = vec3(maxx - minx, maxy - miny, maxz - minz)
    py_report("em", string.format('{"verts":%d,"tris":%d,"normals":%d,"faceNormals":%d,"uvs":%d,"faceUVs":%d,"removedUnused":%s,"fidelity":"%s"}', #em.verts, #em.tris, em.normals, em.faceNormals, em.uvs, em.faceUVs, tostring(em.removedUnused), tostring(opts and opts.CollisionFidelity)))
    return mp
  end,
  CreateAssetAsync = function(self, em, assetType, params)
    if py_mode == "publishfail" then return "Failure", "moderation rejected" end
    py_report("published", string.format('{"name":"%s","type":"%s"}', params.Name, tostring(assetType)))
    return "Success", 123450000 + em.id
  end,
}
game.GetService = function(self, n)
  if n == "HttpService" then return HttpService end
  if n == "AssetService" then return AssetService end
  if n == "ReplicatedStorage" then return ReplicatedStorage end
  if n == "Lighting" then return Lighting end
  error("no service " .. n)
end
''')
run = lua.eval("function(src) local f, e = load(src, '=studio'); if not f then error(e) end return f() end")
out = {"mode": mode}
try:
    out["import"] = run(open(imp_path, encoding="utf-8").read())
except Exception as e:
    print(json.dumps({"error": "import: " + str(e)}))
    sys.exit(1)
if ver_path:
    try:
        raw = run(open(ver_path, encoding="utf-8").read())
        out["verify"] = json.loads(raw) if isinstance(raw, str) else raw
    except Exception as e:
        out["verify_error"] = str(e)


def walk(inst, acc, path):
    for ch in list(inst["_children"].values()):
        p = path + "." + ch["Name"]
        if ch["ClassName"] in ("Part", "MeshPart"):
            cf = ch["CFrame"]
            col = ch["Color"]
            acc.append({"path": p, "class": ch["ClassName"], "name": ch["Name"], "anchored": bool(ch["Anchored"]), "can_collide": bool(ch["CanCollide"]), "material": ch["Material"], "reflectance": ch["Reflectance"], "transparency": ch["Transparency"],
                        "cframe": [cf["X"], cf["Y"], cf["Z"]] if cf else None, "color": [round(col["r"], 3), round(col["g"], 3), round(col["b"], 3)] if col else None,
                        "attrs": dict(ch["_attrs"].items()), "size": [round(ch["Size"]["X"], 3), round(ch["Size"]["Y"], 3), round(ch["Size"]["Z"], 3)] if ch["Size"] else None,
                        "attachments": [{"name": a["Name"], "pos": [a["Position"]["X"], a["Position"]["Y"], a["Position"]["Z"]] if a["Position"] else None} for a in ch["_children"].values() if a["ClassName"] == "Attachment"]})
        elif ch["ClassName"] == "Model":
            pv = ch["WorldPivot"]
            acc.append({"path": p, "class": "Model", "name": ch["Name"], "primary": ch["PrimaryPart"] and ch["PrimaryPart"]["Name"] or None, "pivot": [pv["X"], pv["Y"], pv["Z"]] if pv else None, "attrs": dict(ch["_attrs"].items()), "children": len(list(ch["_children"].values()))})
        walk(ch, acc, p)


tree = []
walk(G.workspace, tree, "Workspace")
out["tree"] = tree
out.update(report)
print(json.dumps(out))
