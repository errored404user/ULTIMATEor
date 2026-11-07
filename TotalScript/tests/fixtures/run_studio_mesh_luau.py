#!/usr/bin/env python3
"""Run the Luau that studioMeshLuau() generates under lupa with a small Roblox
stand-in (tests only). Prints a JSON report of what the code did to the stub
DataModel: parts, their CFrames / colours / attributes, EditableMesh calls."""
import json, sys
import lupa
from lupa import LuaRuntime

code = open(sys.argv[1], encoding="utf-8").read()
mode = sys.argv[2] if len(sys.argv) > 2 else "editable"   # editable | noeditable | publishfail
lua = LuaRuntime(unpack_returned_tuples=True)
G = lua.globals()

def to_lua(v):
    if isinstance(v, dict):
        t = lua.table()
        for k, val in v.items(): t[k] = to_lua(val)
        return t
    if isinstance(v, list):
        t = lua.table()
        for i, val in enumerate(v): t[i + 1] = to_lua(val)
        return t
    return v

report = {"parts": [], "meshes": [], "destroyed": [], "published": []}
G.py_json_decode = lambda s: to_lua(json.loads(s))
G.py_report = lambda kind, payload: report[kind].append(json.loads(payload))
G.py_mode = mode
lua.execute(r'''
math.clamp = function(v, a, b) return math.max(a, math.min(b, v)) end
Vector3 = { new = function(x, y, z) return { x = x, y = y, z = z, _t = "Vector3" } end }
CFrame = { new = function(x, y, z) return { x = x, y = y, z = z, _t = "CFrame" } end }
Color3 = { new = function(r, g, b) return { r = r, g = g, b = b, _t = "Color3" } end }
Enum = { Material = { SmoothPlastic = "SmoothPlastic" }, CollisionFidelity = { Default = "Default" }, AssetType = { Mesh = "Mesh" }, CreateAssetResult = { Success = "Success" } }
Content = { fromObject = function(o) return { obj = o } end }
local nextId = 1000
local function newInstance(class, name)
  local inst = { ClassName = class, Name = name or class, _children = {}, _attrs = {} }
  function inst:IsA(c) return c == self.ClassName or (c == "BasePart" and (self.ClassName == "Part" or self.ClassName == "MeshPart")) end
  function inst:FindFirstChild(n) for _, c in ipairs(self._children) do if c.Name == n then return c end end return nil end
  function inst:FindFirstChildWhichIsA(c) for _, ch in ipairs(self._children) do if ch:IsA(c) then return ch end end return nil end
  function inst:SetAttribute(k, v) self._attrs[k] = v end
  function inst:GetFullName() if self._parent and self._parent ~= game then return self._parent:GetFullName() .. "." .. self.Name end return self.Name end
  function inst:Destroy()
    py_report("destroyed", '{"name":"' .. self.Name .. '"}')
    if self._parent then for i, c in ipairs(self._parent._children) do if c == self then table.remove(self._parent._children, i) break end end end
    self._parent = nil
  end
  return setmetatable(inst, { __index = function(t, k) if k == "Parent" then return rawget(t, "_parent") end return nil end,
    __newindex = function(t, k, v)
      if k == "Parent" then
        if rawget(t, "_parent") then for i, c in ipairs(rawget(t, "_parent")._children) do if c == t then table.remove(rawget(t, "_parent")._children, i) break end end end
        rawset(t, "_parent", v); if v then table.insert(v._children, t) end
      else rawset(t, k, v) end
    end })
end
Instance = { new = function(class) return newInstance(class) end }
game = newInstance("DataModel", "game")
workspace = newInstance("Workspace", "Workspace"); workspace.Parent = game
local Lighting = newInstance("Lighting", "Lighting"); Lighting.Parent = game
local existing = newInstance("Model", "Total_Imported"); existing.Parent = workspace
local HttpService = { JSONDecode = function(self, s) return py_json_decode(s) end }
local function newEditableMesh()
  local em = { verts = {}, tris = {}, normals = 0, faceNormals = 0, removedUnused = false, id = nextId }
  nextId = nextId + 1
  function em:AddVertex(v) table.insert(self.verts, v) return #self.verts end
  function em:AddTriangle(a, b, c) table.insert(self.tris, { a, b, c }) return #self.tris end
  function em:AddNormal() self.normals = self.normals + 1 return self.normals end
  function em:SetFaceNormals(fid, t) self.faceNormals = self.faceNormals + 1 end
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
    mp.Size = Vector3.new(1, 1, 1)
    py_report("meshes", string.format('{"verts":%d,"tris":%d,"normals":%d,"faceNormals":%d,"removedUnused":%s,"fidelity":"%s"}', #em.verts, #em.tris, em.normals, em.faceNormals, tostring(em.removedUnused), tostring(opts and opts.CollisionFidelity)))
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
  error("no service " .. n)
end
''')
try:
    fn = lua.eval("function(src) local f, e = load(src, '=studio'); if not f then error(e) end return f() end")
    result = fn(code)
except Exception as e:
    print(json.dumps({"error": str(e)})); sys.exit(1)

def walk(inst, out, path):
    for ch in list(inst["_children"].values()):
        p = path + "." + ch["Name"]
        if ch["ClassName"] in ("Part", "MeshPart"):
            cf = ch["CFrame"]; col = ch["Color"]
            out.append({"path": p, "class": ch["ClassName"], "name": ch["Name"], "anchored": bool(ch["Anchored"]),
                        "cframe": [cf["x"], cf["y"], cf["z"]] if cf else None,
                        "color": [round(col["r"], 3), round(col["g"], 3), round(col["b"], 3)] if col else None,
                        "attrs": dict(ch["_attrs"].items()), "size": [ch["Size"]["x"], ch["Size"]["y"], ch["Size"]["z"]] if ch["Size"] else None})
        walk(ch, out, p)
ws = G.workspace
walk(ws, report["parts"], "Workspace")
models = [c["Name"] + ":" + c["ClassName"] for c in ws["_children"].values()]
report["workspaceChildren"] = models
imp = ws.FindFirstChild(ws, "Total_Imported")
report["primaryPart"] = imp and imp["PrimaryPart"] and imp["PrimaryPart"]["Name"] or None
report["result"] = result
print(json.dumps(report))
