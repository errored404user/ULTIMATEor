#!/usr/bin/env python3
"""Offline checks for plugin/TotalScript.lua (no Studio needed).

1. Parses the whole plugin with a real Lua parser (Luau-only syntax such as
   `continue` / `+=` is rewritten first) - catches missing `end`s and typos.
2. Executes the Eclipse Animator conversion logic (tableToKeyframeSequence,
   posesFor, rigJoints, toCFrame, fromJson, easingFrom) against a stubbed
   Roblox API with an R6-style rig and asserts the KeyframeSequence shape.

Run: python3 tests/plugin-lua-check.py   (needs `pip install lupa`)
"""
import re, sys, os
try:
    from lupa import lua54
except ImportError:
    print("SKIP  lupa not installed (pip install lupa)"); sys.exit(0)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, "plugin", "TotalScript.lua"), encoding="utf-8").read()

def luau_to_lua(s):
    s = re.sub(r"\bcontinue\b", "do end", s)
    s = re.sub(r'(\b[\w\.\[\]"]+)\s*([+\-*/%^]|\.\.)=\s*', lambda m: f"{m.group(1)} = {m.group(1)} {m.group(2)} ", s)
    return s

L = lua54.LuaRuntime()
L.compile(luau_to_lua(src))
print("PASS  plugin/TotalScript.lua parses (Lua 5.4 parser, Luau sugar rewritten)")

def grab(a, b):
    i = src.index(a); j = src.index(b, i); return src[i:j]
helpers = grab("local function pathsOf(list)", "local function pluginUrl")
eclipse = grab("local ECLIPSE_ID", "local function animLibFolder")
bus = grab("local KNOWN_PLUGINS = {", "local function widgetContainers()")
calltarget = grab("local function callTarget(target, command, args)", "function H.plugin_invoke(a)")
STUBS = r'''
Color3 = { new = function(r,g,b) return {r,g,b} end, fromRGB = function(r,g,b) return {r,g,b} end }
Vector2 = { new = function(x,y) return {x,y} end } UDim2 = { new = function(...) return {...} end }
NumberRange = { new = function(a,b) return {a,b} end } BrickColor = { new = function(n) return {n} end }
shared = {}
CFrameMT = {} CFrameMT.__index = CFrameMT
CFrame = {}
function CFrame.new(x,y,z,...) return setmetatable({x=x or 0,y=y or 0,z=z or 0}, CFrameMT) end
function CFrame.fromOrientation(a,b,c) return setmetatable({rot={a,b,c}}, CFrameMT) end
function CFrame.lookAt(p,q) return setmetatable({look=true}, CFrameMT) end
CFrameMT.__mul = function(a,b) return setmetatable({mul=true}, CFrameMT) end
CFrameMT.__sub = function(a,b) return a end
Vector3 = {zero = {X=0,Y=0,Z=0}}
Vector3MT = {}
function Vector3.new(x,y,z) return setmetatable({X=x,Y=y,Z=z}, Vector3MT) end
Enum = setmetatable({}, {__index=function(t,e) local tb = setmetatable({}, {__index=function(_,i) return setmetatable({Name=i,enum=e}, {__tostring=function(s) return "Enum."..e.."."..i end, __name="EnumItem"}) end}) rawset(t,e,tb) return tb end})
function typeof(v)
  local mt = getmetatable(v)
  if mt == CFrameMT then return "CFrame" end
  if mt == Vector3MT then return "Vector3" end
  if type(v)=="table" and rawget(v, "__inst") then return "Instance" end
  if mt and mt.__name=="EnumItem" then return "EnumItem" end
  return type(v)
end
local Inst = {} Inst.__index = Inst
local SUPER = {Motor6D="JointInstance", Part="BasePart", MeshPart="BasePart", BasePart="PVInstance", Model="PVInstance"}
function Inst:IsA(c) local k = self.ClassName while k do if k == c then return true end k = SUPER[k] end return false end
function Inst:GetChildren() return self.children end
function Inst:GetDescendants() local out = {} local function walk(i) for _, c in ipairs(i.children) do out[#out+1]=c walk(c) end end walk(self) return out end
function Inst:FindFirstChild(n, rec) for _, c in ipairs(self.children) do if c.Name == n then return c end end if rec then for _, d in ipairs(self:GetDescendants()) do if d.Name == n then return d end end end return nil end
function Inst:FindFirstChildWhichIsA(c, rec) for _, d in ipairs(rec and self:GetDescendants() or self.children) do if d:IsA(c) then return d end end return nil end
function Inst:FindFirstChildOfClass(c) for _, d in ipairs(self.children) do if d.ClassName == c then return d end end return nil end
function Inst:GetFullName() return (self.Parent and self.Parent.GetFullName and self.Parent:GetFullName() .. "." or "") .. self.Name end
function Inst:AddPose(p) p.Parent = self end
function Inst:AddSubPose(p) p.Parent = self end
function Inst:GetSubPoses() return self.children end
function Inst:SetAttribute() end
Instance = {}
function Instance.new(cls)
  local i = { ClassName = cls, Name = cls, children = {}, __inst = true, Time = 0, Weight = 1 }
  return setmetatable(i, { __index = Inst, __newindex = function(t, k, v)
    if k == "Parent" then
      local old = rawget(t, "Parent")
      if old then for idx, c in ipairs(old.children) do if c == t then table.remove(old.children, idx) break end end end
      rawset(t, "Parent", v) if v then table.insert(v.children, t) end
    else rawset(t, k, v) end
  end })
end
workspace = Instance.new("Workspace") workspace.Name = "Workspace"
game = { GetService = function(_, n) return Instance.new(n) end }
Selection = { Get = function() return {} end }
ServerStorage = Instance.new("ServerStorage") ReplicatedStorage = Instance.new("ReplicatedStorage")
local function resolve(p) return nil end
local function need(p, what) local i = resolve(p) if not i then error((what or "instance") .. " not found: " .. tostring(p)) end return i end
local function log() end
local H = {}
local function findWidget() return {} end
local function widgetInfo() return {} end
local function sharedTables() return {} end
local function record() end
local function commit() end
VERSION = "test"
local KeyframeSequenceProvider = {}
local CoreGui = Instance.new("CoreGui")
'''
TEST = r'''
local rig = Instance.new("Model") rig.Name = "Rig" rig.Parent = workspace
local hum = Instance.new("Humanoid") hum.Parent = rig
local hrp = Instance.new("Part") hrp.Name = "HumanoidRootPart" hrp.Parent = rig
local torso = Instance.new("Part") torso.Name = "Torso" torso.Parent = rig
local head = Instance.new("Part") head.Name = "Head" head.Parent = rig
local larm = Instance.new("Part") larm.Name = "Left Arm" larm.Parent = rig
local function motor(name, p0, p1) local m = Instance.new("Motor6D") m.Name = name m.Part0 = p0 m.Part1 = p1 m.Parent = p0 end
motor("RootJoint", hrp, torso) motor("Neck", torso, head) motor("Left Shoulder", torso, larm)
rig.PrimaryPart = hrp
-- a Blender-style bone chain on a MeshPart
local mesh = Instance.new("MeshPart") mesh.Name = "Body" mesh.Parent = rig
motor("BodyJoint", torso, mesh)
local bone = Instance.new("Bone") bone.Name = "Spine" bone.Parent = mesh
local bone2 = Instance.new("Bone") bone2.Name = "Spine2" bone2.Parent = bone

local dataA = { Looped = true, Priority = "Action", Keyframes = {
  { Time = 0, Poses = { Torso = CFrame.new(0,0,0), Head = { Position = {0,0,0}, Rotation = {0,10,0} }, Spine2 = CFrame.new(0,0,1) }, Easing = "Cubic" },
  { Time = 0.5, Poses = { Neck = {0,0,0, 1,0,0, 0,1,0, 0,0,1}, ["Left Shoulder"] = CFrame.new(0,1,0), Bogus = CFrame.new() }, Easing = { Style = "Bezier", Direction = "InOut" } },
} }
local ks, info = tableToKeyframeSequence(dataA, rig, "A")
assert(info.keyframes == 2 and info.shape == "keyframes" and math.abs(info.length - 0.5) < 1e-6, "shape A")
assert(#info.unknown_joints == 1 and info.unknown_joints[1] == "bogus", "unknown joint reported: " .. table.concat(info.unknown_joints, ","))
assert(ks.Loop == true and tostring(ks.Priority) == "Enum.AnimationPriority.Action", "loop/priority")
local kf1 = ks.children[1]
assert(#kf1.children == 1 and kf1.children[1].Name == "HumanoidRootPart", "single root pose")
local rootPose = kf1.children[1]
assert(#rootPose.children == 1 and rootPose.children[1].Name == "Torso", "torso under root")
local names = {} for _, p in ipairs(rootPose.children[1].children) do names[#names+1] = p.Name end table.sort(names)
assert(table.concat(names, ",") == "Body,Head,Left Arm", "children of torso: " .. table.concat(names, ","))
local spine2 = kf1:FindFirstChild("Spine2", true)
assert(spine2 and spine2.Parent.Name == "Spine" and spine2.Parent.Parent.Name == "Body" and typeof(spine2.CFrame) == "CFrame", "bone chain nested under its MeshPart")
local kf2 = ks.children[2]
local headPose = kf2:FindFirstChild("Head", true)
assert(headPose and typeof(headPose.CFrame) == "CFrame", "Neck alias → Head pose")
assert(tostring(headPose.EasingStyle) == "Enum.PoseEasingStyle.Cubic" and tostring(headPose.EasingDirection) == "Enum.PoseEasingDirection.InOut", "bezier→cubic inout")
local total = 0 for _, d in ipairs(kf2:GetDescendants()) do if d.ClassName == "Pose" then total = total + 1 end end
assert(total == 7, "one pose per joint (7), got " .. total)

local dataB = { FPS = 60, Tracks = { Torso = { { Frame = 0, CFrame = CFrame.new() }, { Frame = 30, CFrame = CFrame.new(0,1,0) } }, Head = { Keyframes = { { Frame = 30, Value = {0,0,0,0,0,0} } } } } }
local ks2, info2 = tableToKeyframeSequence(dataB, rig, "B")
assert(info2.shape == "tracks" and info2.frame_based and info2.keyframes == 2 and math.abs(info2.length - 0.5) < 1e-6, "tracks shape")
local ks3, info3 = tableToKeyframeSequence({ keyframes = { ["0"] = { Torso = CFrame.new() }, ["1.5"] = { Torso = CFrame.new(1,0,0) } } }, rig, "C")
assert(info3.shape == "time_map" and info3.keyframes == 2 and math.abs(info3.length - 1.5) < 1e-6, "time map")
local okU, errU = pcall(tableToKeyframeSequence, { foo = 1, bar = { baz = 2 } }, rig, "D")
assert(not okU and tostring(errU):find("unrecognised animation table") and tostring(errU):find("bar=table{baz:number}"), "summary in error: " .. tostring(errU))
local okE, errE = pcall(tableToKeyframeSequence, { Keyframes = { { Time = 0, Poses = { Torso = "not a cframe" } } } }, rig, "E")
assert(not okE and tostring(errE):find("no keyframes with CFrames"), "empty error: " .. tostring(errE))
assert(typeof(toCFrame("1, 2, 3")) == "CFrame" and typeof(toCFrame({1,2,3,4,5,6,7})) == "CFrame" and toCFrame({1,2}) == nil and typeof(toCFrame({pos = {1,2,3}, rot = {0,90,0}})) == "CFrame", "toCFrame")
assert(tostring(fromJson("Enum.Material.Neon")) == "Enum.Material.Neon", "enum from string")
assert(typeof(fromJson({__type="Vector3", value={1,2,3}})) == "Vector3" and fromJson({__type="Color3", value={255,0,0}}) ~= nil, "datatypes from json")
assert(fromJson({a = "Enum.Material.Neon", b = {1,2}}).b[2] == 2, "nested json passthrough")
local byName = rigJoints(rig)
assert(byName["neck"].part == head and byName["left shoulder"].part == larm and byName["torso"].parent == "HumanoidRootPart" and byName["spine2"].parent == "Spine", "joint aliases")
assert(tostring(easingFrom("Linear").style) == "Enum.PoseEasingStyle.Linear" and easingFrom(nil) == nil and easingFrom("weird") == nil, "easing")
assert(toJson({ v = Vector3.new(1,2,3), e = Enum.Material.Neon, f = function() end }).f == "<function>", "toJson")
local okR, errR = pcall(rigOf, {})
assert(okR, "rigOf finds the workspace rig: " .. tostring(errR))
print("PASS  Eclipse conversion logic: 3 export shapes, bone chains, aliases, easing, errors")
'''
BUS_TEST = r'''
assert(knownFor("Eclipse Animator v1.0956").id == "eclipse_animator" and knownFor("MoonAnimator2Saves").id == "moon_animator" and knownFor("nothing") == nil, "knownFor")
BUS.register({ name = "DemoPlugin", version = "1.0", commands = { hello = function(args) return "hi " .. tostring(args and args.who) end } })
assert(BUS.list()[1].name == "DemoPlugin" and BUS.list()[1].commands[1] == "hello", "bus list")
assert(BUS.invoke("DemoPlugin", "hello", { who = "TotalScript" }) == "hi TotalScript", "bus invoke")
local okB, errB = pcall(BUS.invoke, "DemoPlugin", "nope", {})
assert(not okB and tostring(errB):find("has no command"), "bus unknown command")
assert(busFn.OnInvoke("version") == VERSION and busFn.OnInvoke("list")[1].name == "DemoPlugin", "TotalScriptBus BindableFunction ops")
shared.EclipseAPI = { GetVersion = function() return "1.0956" end, Add = function(a, b) return a + b end }
local how, res = callTarget("shared.EclipseAPI", "GetVersion", nil)
assert(how == "global" and res[1] == "1.0956", "shared table call")
local how2, res2 = callTarget("EclipseAPI", "Add", { 2, 3 })
assert(how2 == "global" and res2[1] == 5, "bare shared name + array args")
local how3, res3 = callTarget("DemoPlugin", "hello", { who = "bus" })
assert(how3 == "bus" and res3 == "hi bus", "bus via callTarget")
local okT, errT = pcall(callTarget, "Missing", "x", nil)
assert(not okT and tostring(errT):find("plugins_list shows what is reachable"), "unknown target error")
print("PASS  plugin bus: register / list / invoke, TotalScriptBus ops, shared-table and bus targets")
'''
code = luau_to_lua(STUBS + helpers + bus + calltarget + eclipse + TEST + BUS_TEST)
try:
    L.execute(code)
except Exception as e:
    msg = str(e)
    m = re.search(r":(\d+):", msg)
    if m:
        ln = int(m.group(1)); lines = code.split("\n")
        print("\n".join(f"{i+1}: {lines[i]}" for i in range(max(0, ln-4), min(len(lines), ln+2))))
    print("FAIL ", msg[:800]); sys.exit(1)
