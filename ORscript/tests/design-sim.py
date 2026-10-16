#!/usr/bin/env python3
"""Execute the DESIGN pack's Luau against a miniature Roblox DataModel.

tests/luau-parse-check.py proves the generated programs *parse*. This script goes
one step further for the design pack (src/core/skills/studio_design.js), whose
Luau builds whole ScreenGuis and writes ModuleScripts/LocalScripts that are then
required at runtime: it runs every command inside a small Lua model of Roblox
(Instance tree, Color3/UDim2/Vector2/Enum, services, signals, require/loadstring,
task.*) and asserts the JSON results, instance counts, controller behaviour
(button actions close windows, toggles flip, tabs switch) and the audit output.

    pip install lupa && python3 tests/design-sim.py          (from the ORscript root)

It is not a Roblox engine: layout engines, rendering and replication are not
modelled. It catches the class of bugs a blind-written Luau program has - nil
indexing, wrong argument shapes, missing 'end's at runtime paths, properties set
on the wrong instance, scripts that error on load.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
try:
    from lupa import LuaRuntime
except Exception:  # pragma: no cover
    print("SKIP  lupa is not installed (pip install lupa)")
    sys.exit(0)

GEN = r"""
const fs=require("fs"), vm=require("vm");
global.window=global; global.chrome={storage:{local:{get:(k,cb)=>cb&&cb({}),set:()=>{}}},runtime:{getURL:(p)=>p}};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills;
const out={commands:S.DESIGN_COMMANDS, screens:S.DESIGN_SCREENS, presets:S.DESIGN_PRESETS, lua:S.DESIGN_LUA, programs:{}};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "tokens_set": ["design_tokens_set", {"preset": "neon", "primary": "#ff8800", "font": "Arcade", "radius": 4}],
    "tokens_get": ["design_tokens_get", {}],
    "kit": ["design_kit_install", {"force": True}],
    "shop": ["ui_screen_generate", {"kind": "shop", "title": "Gem Shop", "items": [{"item": "Sword", "price": 100, "rarity": "rare"}, {"item": "Shield", "price": 250, "rarity": "epic"}, "Potion"], "tabs": ["All", "Gear"]}],
    "inventory": ["ui_screen_generate", {"kind": "inventory", "slots": 12, "items": ["Sword", "Potion"]}],
    "hud": ["ui_screen_generate", {"kind": "hud", "stats": ["Coins", "Gems"]}],
    "main_menu": ["ui_screen_generate", {"kind": "main_menu", "title": "Blade Realms", "buttons": ["Play", "Shop", "Settings"]}],
    "settings": ["ui_screen_generate", {"kind": "settings"}],
    "leaderboard": ["ui_screen_generate", {"kind": "leaderboard", "currency": "Wins"}],
    "daily": ["ui_screen_generate", {"kind": "daily_rewards", "rewards": [10, 20, 30, 40, 50, 60, 100]}],
    "quests": ["ui_screen_generate", {"kind": "quest_log", "quests": [{"title": "Find the key", "progress": 0.5, "reward": 20}]}],
    "loading": ["ui_screen_generate", {"kind": "loading", "title": "Blade Realms", "tips": ["a", "b"]}],
    "dialog": ["ui_screen_generate", {"kind": "dialog", "speaker": "Guard", "text": "Halt!", "choices": ["Yes", "No", "Bye"]}],
    "notify": ["ui_screen_generate", {"kind": "notification_stack"}],
    "from_spec": ["ui_from_spec", {"name": "Custom", "open_key": "M", "spec": {"children": [
        {"kind": "Window", "name": "Win", "title": "Custom", "size": [600, 400], "start_hidden": True, "children": [
            {"kind": "Tabs", "name": "T", "tabs": ["One", "Two"], "size": ["fill", "fill"], "pages": [
                {"layout": "column", "gap": 8, "children": [{"kind": "Label", "text": "Hello"}, {"kind": "Button", "name": "Go", "text": "Go", "action": "print:go"}, {"kind": "ProgressBar", "name": "PB", "value": 0.25}, {"kind": "Toggle", "name": "Tg", "text": "Music", "value": True, "setting": "music"}]},
                {"children": [{"kind": "Grid", "name": "G", "columns": 3, "size": ["fill", 200], "children": [{"kind": "Slot", "index": 1}, {"kind": "Slot", "index": 2, "item": "Gem", "rarity": "legendary"}]}]}
            ]}
        ]},
        {"kind": "Button", "name": "Floating", "text": "Open", "anchor": "bottom-right", "margin": 20, "action": "toggle:Win"}
    ]}}],
    "place": ["ui_component_place", {"kind": "CurrencyPill", "parent": "StarterGui.HUD.TopLeft", "name": "Extra", "props": {"stat": "Gold", "value": "12"}}],
    "place_bad": ["ui_component_place", {"kind": "Nope", "parent": "StarterGui.HUD.TopLeft"}],
    "audit": ["ui_audit", {"path": "StarterGui"}],
    "export": ["ui_export_spec", {"path": "StarterGui.Shop"}],
    "apply": ["ui_apply_tokens", {"path": "StarterGui.Legacy"}],
    "responsive": ["ui_make_responsive", {"path": "StarterGui.Legacy"}],
    "gamepad": ["ui_gamepad_focus", {"path": "StarterGui.Legacy"}],
    "states": ["ui_states_wire", {"path": "StarterGui.Legacy", "default_action": True}],
    "preview": ["ui_preview", {"path": "StarterGui.Shop", "device": "phone"}],
    "preview_restore": ["ui_preview", {"path": "StarterGui.Shop", "restore": True}],
    "audit_legacy": ["ui_audit", {"path": "StarterGui.Legacy"}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))

# ───────────────────────── miniature Roblox ─────────────────────────
ROBLOX = r"""
local M = {}
local CLASSES = {
  Instance={}, Folder={"Instance"}, LuaSourceContainer={"Instance"}, ModuleScript={"LuaSourceContainer"}, LocalScript={"LuaSourceContainer"}, Script={"LuaSourceContainer"},
  RemoteEvent={"Instance"}, RemoteFunction={"Instance"}, BindableEvent={"Instance"}, BindableFunction={"Instance"}, ValueBase={"Instance"}, IntValue={"ValueBase"}, NumberValue={"ValueBase"}, StringValue={"ValueBase"}, Color3Value={"ValueBase"},
  Sound={"Instance"}, Camera={"Instance"}, Humanoid={"Instance"}, Model={"Instance"}, Player={"Instance"}, PlayerGui={"Instance"},
  GuiBase2d={"Instance"}, LayerCollector={"GuiBase2d"}, ScreenGui={"LayerCollector"}, SurfaceGui={"LayerCollector"},
  GuiObject={"GuiBase2d"}, Frame={"GuiObject"}, ScrollingFrame={"GuiObject"}, CanvasGroup={"GuiObject"}, ViewportFrame={"GuiObject"},
  GuiButton={"GuiObject"}, TextButton={"GuiButton"}, ImageButton={"GuiButton"}, TextLabel={"GuiObject"}, ImageLabel={"GuiObject"}, TextBox={"GuiObject"},
  UIBase={"Instance"}, UIComponent={"UIBase"}, UIConstraint={"UIComponent"}, UILayout={"UIComponent"}, UIGridStyleLayout={"UILayout"},
  UICorner={"UIComponent"}, UIStroke={"UIComponent"}, UIPadding={"UIComponent"}, UIListLayout={"UIGridStyleLayout"}, UIGridLayout={"UIGridStyleLayout"},
  UIAspectRatioConstraint={"UIConstraint"}, UISizeConstraint={"UIConstraint"}, UITextSizeConstraint={"UIConstraint"}, UIScale={"UIComponent"}, UIGradient={"UIComponent"},
  Service={"Instance"},
}
local function isa(cls, want)
  local c = cls
  while c do
    if c == want then return true end
    local p = CLASSES[c]
    c = p and p[1] or nil
  end
  return false
end

-- data types
local Color3 = {}
Color3.__index = Color3
function Color3.new(r,g,b) return setmetatable({R=r or 0,G=g or 0,B=b or 0}, Color3) end
function Color3.fromRGB(r,g,b) return Color3.new((r or 0)/255,(g or 0)/255,(b or 0)/255) end
function Color3:Lerp(o,t) return Color3.new(self.R+(o.R-self.R)*t, self.G+(o.G-self.G)*t, self.B+(o.B-self.B)*t) end
Color3.__eq = function(a,b) return math.abs(a.R-b.R)<1e-6 and math.abs(a.G-b.G)<1e-6 and math.abs(a.B-b.B)<1e-6 end
Color3.__tostring = function(c) return string.format("Color3(%.2f,%.2f,%.2f)", c.R, c.G, c.B) end
local Vector2 = {}
Vector2.__index = Vector2
function Vector2.new(x,y) return setmetatable({X=x or 0,Y=y or 0}, Vector2) end
Vector2.__add = function(a,b) return Vector2.new(a.X+b.X,a.Y+b.Y) end
Vector2.__eq = function(a,b) return a.X==b.X and a.Y==b.Y end
local UDim = {}
UDim.__index = UDim
function UDim.new(s,o) return setmetatable({Scale=s or 0,Offset=o or 0}, UDim) end
UDim.__eq = function(a,b) return a.Scale==b.Scale and a.Offset==b.Offset end
local UDim2 = {}
UDim2.__index = UDim2
function UDim2.new(sx,ox,sy,oy) return setmetatable({X=UDim.new(sx,ox),Y=UDim.new(sy,oy)}, UDim2) end
function UDim2.fromScale(x,y) return UDim2.new(x,0,y,0) end
function UDim2.fromOffset(x,y) return UDim2.new(0,x,0,y) end
UDim2.__add = function(a,b) return UDim2.new(a.X.Scale+b.X.Scale,a.X.Offset+b.X.Offset,a.Y.Scale+b.Y.Scale,a.Y.Offset+b.Y.Offset) end
UDim2.__eq = function(a,b) return a.X==b.X and a.Y==b.Y end
local function ColorSequence_new(a,b) return {Keypoints={a,b or a}} end
local function NumberSequence_new(a,b) return {Keypoints={a,b or a}} end
local function TweenInfo_new(t,style,dir) return {Time=t or 1,EasingStyle=style,EasingDirection=dir} end
local function Rect_new(a,b,c,d) return {Min=Vector2.new(a,b),Max=Vector2.new(c,d)} end
local Enum = setmetatable({}, {__index=function(t,k) local e=setmetatable({}, {__index=function(t2,k2) local v={Name=k2,EnumType=k} rawset(t2,k2,v) return v end}) rawset(t,k,e) return e end})

-- signals
local Signal = {}
Signal.__index = Signal
function Signal.new() return setmetatable({h={}}, Signal) end
function Signal:Connect(fn) local c={fn=fn,Connected=true} self.h[#self.h+1]=c function c:Disconnect() self.Connected=false end return c end
function Signal:Once(fn) return self:Connect(fn) end
function Signal:Wait() return nil end
function Signal:Fire(...) for _,c in ipairs(self.h) do if c.Connected then c.fn(...) end end end
M.firedSignals = 0

-- instances
local Instance = {}
local Inst = {}
local EVENTS = {Activated=1,MouseEnter=1,MouseLeave=1,MouseButton1Down=1,MouseButton1Up=1,MouseButton1Click=1,SelectionGained=1,SelectionLost=1,DescendantAdded=1,ChildAdded=1,ChildRemoved=1,Changed=1,CharacterAdded=1,HealthChanged=1,PlayerRemoving=1,PlayerAdded=1,Loaded=1,InputBegan=1,InputEnded=1,LastInputTypeChanged=1,Completed=1,OnClientEvent=1,OnServerEvent=1,Event=1,Focused=1,FocusLost=1,AncestryChanged=1,Destroying=1}
local DEFAULTS = {Size=function() return UDim2.new(0,100,0,100) end, Position=function() return UDim2.new() end, AnchorPoint=function() return Vector2.new() end,
  BackgroundColor3=function() return Color3.new(1,1,1) end, BackgroundTransparency=0, BorderSizePixel=1, TextColor3=function() return Color3.new(0,0,0) end, TextTransparency=0, TextStrokeTransparency=1, TextSize=14, Text="", TextScaled=false, TextWrapped=false, RichText=false,
  Visible=true, ZIndex=1, Image="", ImageTransparency=0, ImageColor3=function() return Color3.new(1,1,1) end, Font=function() return Enum.Font.Legacy end, Enabled=true, Active=false, AutoButtonColor=true, ClipsDescendants=false,
  CanvasSize=function() return UDim2.new() end, AutomaticCanvasSize=function() return Enum.AutomaticSize.None end, AutomaticSize=function() return Enum.AutomaticSize.None end, ZIndexBehavior=function() return Enum.ZIndexBehavior.Sibling end, IgnoreGuiInset=false, ResetOnSpawn=true, DisplayOrder=0,
  TextXAlignment=function() return Enum.TextXAlignment.Center end, TextYAlignment=function() return Enum.TextYAlignment.Center end, ScrollBarThickness=12, LayoutOrder=0, Scale=1, Transparency=0, Thickness=1, CornerRadius=function() return UDim.new() end,
  MinSize=function() return Vector2.new() end, MaxSize=function() return Vector2.new(math.huge,math.huge) end, MinTextSize=1, MaxTextSize=100, AspectRatio=1, Source="", Value=0, Volume=0.5, PlayOnRemove=false, MaxVisibleGraphemes=-1, ContentText="",
  PaddingLeft=function() return UDim.new() end, PaddingRight=function() return UDim.new() end, PaddingTop=function() return UDim.new() end, PaddingBottom=function() return UDim.new() end, Padding=function() return UDim.new() end,
  CellSize=function() return UDim2.new(0,100,0,100) end, CellPadding=function() return UDim2.new() end, FillDirection=function() return Enum.FillDirection.Vertical end, PlaceholderText="", ClearTextOnFocus=true, SelectionGroup=false,
  Health=100, MaxHealth=100, ShowDevelopmentGui=true, ScaleType=function() return Enum.ScaleType.Stretch end, Rotation=0,
}
M.created = 0
local function new(class, name)
  assert(CLASSES[class], "unknown class " .. tostring(class))
  local o = {__class=class, __props={Name=name or class}, __children={}, __attrs={}, __signals={}, __attrSignals={}, __propSignals={}}
  M.created = M.created + 1
  return setmetatable(o, Inst)
end
Instance.new = function(class, parent) local o = new(class) if parent then o.Parent = parent end return o end

local function absSize(o)
  if not isa(o.__class, "GuiBase2d") then return Vector2.new(1280,720) end
  if isa(o.__class, "LayerCollector") then return Vector2.new(1280,720) end
  local p = o.__props.Parent
  local ps = p and absSize(p) or Vector2.new(1280,720)
  local s = o.Size
  return Vector2.new(s.X.Scale*ps.X+s.X.Offset, s.Y.Scale*ps.Y+s.Y.Offset)
end
local function absPos(o)
  if not isa(o.__class, "GuiObject") then return Vector2.new(0,0) end
  local p = o.__props.Parent
  local pp = (p and isa(p.__class,"GuiObject")) and absPos(p) or Vector2.new(0,0)
  local ps = p and absSize(p) or Vector2.new(1280,720)
  local sz = absSize(o)
  local pos = o.Position
  return Vector2.new(pp.X + pos.X.Scale*ps.X + pos.X.Offset - o.AnchorPoint.X*sz.X, pp.Y + pos.Y.Scale*ps.Y + pos.Y.Offset - o.AnchorPoint.Y*sz.Y)
end

local methods = {}
function methods:IsA(c) return isa(self.__class, c) end
function methods:GetChildren() local out={} for i,c in ipairs(self.__children) do out[i]=c end return out end
function methods:GetDescendants() local out={} local function walk(n) for _,c in ipairs(n.__children) do out[#out+1]=c walk(c) end end walk(self) return out end
function methods:FindFirstChild(name, recursive) for _,c in ipairs(self.__children) do if c.__props.Name==name then return c end end if recursive then for _,c in ipairs(self.__children) do local r=c:FindFirstChild(name,true) if r then return r end end end return nil end
function methods:WaitForChild(name) return self:FindFirstChild(name) end
function methods:FindFirstChildOfClass(cls) for _,c in ipairs(self.__children) do if c.__class==cls then return c end end return nil end
function methods:FindFirstChildWhichIsA(cls, recursive) for _,c in ipairs(self.__children) do if isa(c.__class,cls) then return c end end if recursive then for _,c in ipairs(self.__children) do local r=c:FindFirstChildWhichIsA(cls,true) if r then return r end end end return nil end
function methods:FindFirstAncestorWhichIsA(cls) local p=self.__props.Parent while p do if isa(p.__class,cls) then return p end p=p.__props.Parent end return nil end
function methods:IsDescendantOf(a) local p=self.__props.Parent while p do if p==a then return true end p=p.__props.Parent end return false end
function methods:GetFullName() local parts={} local n=self while n and n.__class~="DataModel" do table.insert(parts,1,n.__props.Name) n=n.__props.Parent end return table.concat(parts,".") end
function methods:Destroy() self.Parent=nil self.__destroyed=true end
function methods:ClearAllChildren() for _,c in ipairs(self:GetChildren()) do c:Destroy() end end
function methods:Clone() local c=new(self.__class) for k,v in pairs(self.__props) do if k~="Parent" then c.__props[k]=v end end for k,v in pairs(self.__attrs) do c.__attrs[k]=v end for _,ch in ipairs(self.__children) do local cc=ch:Clone() cc.Parent=c end return c end
function methods:SetAttribute(k,v) local old=self.__attrs[k] self.__attrs[k]=v if old~=v and self.__attrSignals[k] then self.__attrSignals[k]:Fire() end end
function methods:GetAttribute(k) return self.__attrs[k] end
function methods:GetAttributes() local t={} for k,v in pairs(self.__attrs) do t[k]=v end return t end
function methods:GetAttributeChangedSignal(k) local s=self.__attrSignals[k] if not s then s=Signal.new() self.__attrSignals[k]=s end return s end
function methods:GetPropertyChangedSignal(k) local s=self.__propSignals[k] if not s then s=Signal.new() self.__propSignals[k]=s end return s end
-- service-ish methods
function methods:GetService(name) return M.services[name] or error("unknown service "..tostring(name)) end
function methods:JSONEncode(v) return M.jsonEncode(v) end
function methods:JSONDecode(s) return M.jsonDecode(s) end
function methods:Create(inst, info, props)
  -- tweens finish instantly; Completed is sticky so handlers connected after Play() still run (as they would a few frames later in Roblox)
  local sig = Signal.new() local done = false
  local tw = {Completed = setmetatable({}, {__index = function(_, k)
    if k == "Connect" or k == "Once" then return function(_, fn) if done then fn(Enum.PlaybackState.Completed) return {Connected=false, Disconnect=function() end} end return sig:Connect(fn) end end
    if k == "Wait" then return function() return Enum.PlaybackState.Completed end end
  end})}
  function tw:Play() for k,v in pairs(props) do inst[k]=v end done = true sig:Fire(Enum.PlaybackState.Completed) end
  function tw:Cancel() end
  function tw:Pause() end
  return tw
end
function methods:IsEdit() return M.isEdit end
function methods:IsRunning() return not M.isEdit end
function methods:IsStudio() return true end
function methods:GetGuiInset() return Vector2.new(0,36), Vector2.new(0,0) end
function methods:GetPlayers() return {} end
function methods:TryBeginRecording() return "rec" end
function methods:FinishRecording() end
function methods:RemoveDefaultLoadingScreen() end
function methods:PreloadAsync(list, cb) if cb then for _,a in ipairs(list) do cb(a, Enum.AssetFetchStatus.Success) end end end
function methods:IsLoaded() return true end
function methods:FireServer(...) M.fired[#M.fired+1]={self.__props.Name, ...} end
function methods:FireClient(plr, ...) M.fired[#M.fired+1]={self.__props.Name, plr and plr.Name or "?", ...} end
function methods:FireAllClients(...) M.fired[#M.fired+1]={self.__props.Name, "all", ...} end
function methods:Fire(...) M.fired[#M.fired+1]={self.__props.Name, ...} if self.Event then self.Event:Fire(...) end end
function methods:InvokeServer(...) if self.OnServerInvoke then return self.OnServerInvoke(M.fakePlayer, ...) end return nil end
function methods:FindFirstChildOfClassOrNil() return nil end
function methods:GetDataStore(name)
  M.datastores[name] = M.datastores[name] or {}
  local data = M.datastores[name]
  return {GetAsync=function(_, key) M.dsCalls = M.dsCalls + 1 return data[key] end, SetAsync=function(_, key, v) M.dsCalls = M.dsCalls + 1 data[key] = v end, UpdateAsync=function(_, key, fn) data[key] = fn(data[key]) return data[key] end}
end
M.datastores = {}
M.dsCalls = 0

Inst.__index = function(o, k)
  if methods[k] then return methods[k] end
  local v = rawget(o, "__props")[k]
  if v ~= nil then return v end
  if k == "ClassName" then return o.__class end
  if k == "AbsoluteSize" then return absSize(o) end
  if k == "AbsolutePosition" then return absPos(o) end
  if k == "AbsoluteWindowSize" then return absSize(o) end
  if EVENTS[k] then local s=o.__signals[k] if not s then s=Signal.new() o.__signals[k]=s end return s end
  if k == "Selectable" then return isa(o.__class, "GuiButton") end
  if k == "ContentText" then return o.__props.Text or "" end
  local d = DEFAULTS[k]
  if d ~= nil then if type(d)=="function" then return d() end return d end
  -- child access by name (Roblox allows frame.Child)
  for _,c in ipairs(o.__children) do if c.__props.Name==k then return c end end
  if k == "Parent" then return nil end
  return nil
end
Inst.__newindex = function(o, k, v)
  if k == "Parent" then
    local old = o.__props.Parent
    if old then for i,c in ipairs(old.__children) do if c==o then table.remove(old.__children,i) break end end end
    o.__props.Parent = v
    if v then
      v.__children[#v.__children+1] = o
      local n = v
      while n do if n.__signals.DescendantAdded then n.__signals.DescendantAdded:Fire(o) end n = n.__props.Parent end
      if v.__signals.ChildAdded then v.__signals.ChildAdded:Fire(o) end
    end
    return
  end
  if k == "Name" then assert(type(v)=="string", "Name must be a string") end
  if (k == "Size" or k == "Position" or k == "CellSize" or k == "CanvasSize") and getmetatable(v) ~= UDim2 then error(k .. " must be a UDim2 (got " .. type(v) .. ")") end
  if (k == "BackgroundColor3" or k == "TextColor3" or k == "ImageColor3" or k == "Color" and o.__class ~= "UIGradient") and getmetatable(v) ~= Color3 then error(k .. " must be a Color3 on " .. o.__class) end
  if k == "AnchorPoint" and getmetatable(v) ~= Vector2 then error("AnchorPoint must be a Vector2") end
  if k == "LayoutOrder" or k == "ZIndex" then if type(v) ~= "number" then error(k .. " must be a number") end end
  if k == "Text" and type(v) ~= "string" then error("Text must be a string (got " .. type(v) .. ")") end
  local old = o.__props[k]
  o.__props[k] = v
  if old ~= v and o.__propSignals[k] then o.__propSignals[k]:Fire() end
end
Inst.__tostring = function(o) return o.__props.Name end
Inst.__eq = function(a,b) return rawequal(a,b) end

-- data model
local game = new("Service", "game") game.__class = "DataModel" CLASSES.DataModel = {"Instance"}
M.game = game
M.services = {}
local function service(name, class) local s = new(class or "Service", name) s.Parent = game M.services[name] = s return s end
local workspace = service("Workspace")
local cam = new("Camera", "Camera") cam.ViewportSize = Vector2.new(1280,720) cam.Parent = workspace workspace.CurrentCamera = cam
local ReplicatedStorage = service("ReplicatedStorage")
service("ReplicatedFirst") service("ServerScriptService") service("DataStoreService") service("ServerStorage") service("StarterGui") service("StarterPlayer") service("SoundService") service("ContentProvider")
local HttpService = service("HttpService")
local TweenService = service("TweenService")
local RunService = service("RunService")
local UIS = service("UserInputService") UIS.TouchEnabled = false UIS.KeyboardEnabled = true UIS.GamepadEnabled = false
local GuiService = service("GuiService")
local Players = service("Players")
service("ChangeHistoryService")
M.isEdit = true
M.fired = {}

-- player for runtime phases
local player = new("Player", "Tester") player.DisplayName = "Tester" player.UserId = 1
local pg = new("PlayerGui", "PlayerGui") pg.Parent = player
local stats = new("Folder", "leaderstats") stats.Parent = player
local coins = new("IntValue", "Coins") coins.Value = 500 coins.Parent = stats
M.fakePlayer = player
M.playerGui = pg

-- script execution
local function envFor(scriptInst)
  local env = setmetatable({script = scriptInst}, {__index = _G})
  return env
end
local moduleCache = {}
local function runModule(m)
  if moduleCache[m] then return moduleCache[m] end
  local f, err = load(m.Source, "=" .. m:GetFullName(), "t", envFor(m))
  if not f then error("module " .. m:GetFullName() .. " failed to compile: " .. tostring(err)) end
  local r = f()
  moduleCache[m] = r
  return r
end
M.runModule = runModule
M.invalidate = function() moduleCache = {} end
function M.runScript(s, asPlayer)
  if asPlayer then Players.LocalPlayer = player end
  local f, err = load(s.Source, "=" .. s:GetFullName(), "t", envFor(s))
  if not f then error("script " .. s:GetFullName() .. " failed to compile: " .. tostring(err)) end
  return f()
end

-- globals the Luau programs expect
_G.game = game
_G.workspace = workspace
_G.Instance = Instance
_G.Color3 = Color3
_G.Vector2 = Vector2
_G.UDim = UDim
_G.UDim2 = UDim2
_G.ColorSequence = {new = ColorSequence_new}
_G.NumberSequence = {new = NumberSequence_new}
_G.TweenInfo = {new = TweenInfo_new}
_G.Rect = {new = Rect_new}
_G.Enum = Enum
_G.typeof = function(v) if type(v)=="table" and rawget(v,"__class") then return "Instance" end local mt=getmetatable(v) if mt==Color3 then return "Color3" elseif mt==Vector2 then return "Vector2" elseif mt==UDim2 then return "UDim2" end return type(v) end
_G.require = runModule
_G.loadstring = function(src) return load(src, "=loadstring", "t", setmetatable({}, {__index=_G})) end
_G.getfenv = function() return _G end
_G.setfenv = function(f, env) return f end
-- task.spawn/defer run the function as a coroutine: the first task.wait() inside it yields and the
-- thread is parked forever (background loops such as tip rotation or polling feeds). On the main
-- thread task.wait() returns immediately, with a budget so an accidental busy loop is reported.
local function runThread(f, ...)
  local co = coroutine.create(f)
  local okR, err = coroutine.resume(co, ...)
  if not okR then error(err, 0) end
end
_G.task = {spawn=runThread, defer=runThread, delay=function(t,f,...) M.delayed[#M.delayed+1]={f=f,args={...}} end,
  wait=function(t) if coroutine.isyieldable() then coroutine.yield() return t or 0 end M.waits=M.waits+1 if M.waits>200 then error("simulated wait budget exceeded (infinite loop?)") end return t or 0 end}
M.delayed = {}
M.waits = 0
_G.tick = os.clock
_G.utf8 = utf8
string.split = function(s, sep) local out={} for piece in (s..sep):gmatch("(.-)"..sep:gsub("%p","%%%0")) do out[#out+1]=piece end return out end
math.clamp = function(v,a,b) return math.max(a, math.min(b, v)) end
_G.warn = function(...) M.warnings[#M.warnings+1]=table.concat({...}," ") end
M.warnings = {}
_G.print = function(...) M.prints[#M.prints+1]=table.concat({...}," ") end
M.prints = {}
return M
"""

L = LuaRuntime(unpack_returned_tuples=True)
M = L.execute(ROBLOX)


def lua_to_py(v, depth=0):
    """Convert a Lua table (from lupa) into Python recursively."""
    if hasattr(v, "items") and hasattr(v, "keys"):
        if depth > 40:
            raise ValueError("JSONEncode: table nesting too deep (cycle?)")
        keys = list(v.keys())
        if not keys:
            return []  # Roblox encodes an empty table as []
        if "__class" in keys:
            raise ValueError("JSONEncode: cannot encode an Instance (" + str(v["__props"]["Name"]) + ") - Roblox would error too")
        if keys and all(isinstance(k, int) for k in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
            return [lua_to_py(v[k], depth + 1) for k in range(1, len(keys) + 1)]
        return {str(k): lua_to_py(v[k], depth + 1) for k in keys}
    return v


def py_to_lua(v):
    if isinstance(v, dict):
        t = L.table()
        for k, val in v.items():
            t[k] = py_to_lua(val)
        return t
    if isinstance(v, list):
        t = L.table()
        for i, val in enumerate(v):
            t[i + 1] = py_to_lua(val)
        return t
    return v


def _enc(v):
    try:
        return json.dumps(lua_to_py(v))
    except Exception as e:
        return json.dumps({"ok": False, "error": "JSONEncode failed: " + str(e)})
M.jsonEncode = _enc
M.jsonDecode = lambda s: py_to_lua(json.loads(s))

same = L.eval("function(a,b) return a == b end")
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:400]))


def run(key):
    code = data["programs"][key]
    if code.startswith("--ERR"):
        return {"ok": False, "error": code}
    fn = L.eval("function(src) local f,e=load(src,'=" + key + "') if not f then return 'COMPILE: '..tostring(e) end local okR,res=pcall(f) if not okR then return 'RUNTIME: '..tostring(res) end return res end")
    out = fn(code)
    try:
        parsed = json.loads(out)
        if not isinstance(parsed, dict):
            return {"ok": False, "error": "non-object result: " + str(out)[:300]}
        return parsed
    except Exception:
        return {"ok": False, "error": str(out)[:600]}


G = L.globals()
game = M.game
SG = lambda: game.GetService(game, "StarterGui")


def count_desc(inst, cls=None):
    n = 0
    for d in list(inst.GetDescendants(inst).values()):
        if cls is None or d.IsA(d, cls):
            n += 1
    return n


# ───────────────────────── 1. tokens + kit ─────────────────────────
r = run("tokens_get")
ok("design_tokens_get before install reports defaults", r.get("ok") and r["data"]["installed"] is False and "midnight" in r["data"]["presets"], r)
r = run("tokens_set")
ok("design_tokens_set writes Tokens + kit", r.get("ok") and r["data"]["preset"] == "neon" and r["data"]["palette"]["Primary"] == "#ff8800" and r["data"]["font"] == "Arcade", r)
design = game.GetService(game, "ReplicatedStorage").FindFirstChild(game.GetService(game, "ReplicatedStorage"), "OR_Design")
ok("OR_Design folder has Tokens, UIKit, Responsive, NotifyLocal", design and all(design.FindFirstChild(design, n) for n in ["Tokens", "UIKit", "Responsive", "NotifyLocal"]))
tokens_src = design.FindFirstChild(design, "Tokens").Source
ok("Tokens ModuleScript source carries the override", 'Primary = Color3.fromRGB(255, 136, 0)' in tokens_src and 'Family = "Arcade"' in tokens_src, tokens_src[:200])
r = run("tokens_get")
ok("design_tokens_get after install", r.get("ok") and r["data"]["installed"] and r["data"]["palette"]["Primary"] == "#ff8800" and r["data"]["kit"], r)
r = run("kit")
ok("design_kit_install force refresh lists components", r.get("ok") and "Button" in r["data"]["components"] and "Window" in r["data"]["components"] and "ItemCard" in r["data"]["components"], r)

# UIKit itself runs inside the simulator (edit mode)
K = M.runModule(design.FindFirstChild(design, "UIKit"))
T = K.tokens(True)
ok("UIKit.tokens() merges Tokens over fallback (edit-mode loadstring path)", abs(T.palette.Primary.R - 1.0) < 1e-6 and abs(T.palette.Primary.G - 136 / 255) < 1e-6 and T.font.Family == "Arcade", (T.palette.Primary.R, T.font.Family))

# ───────────────────────── 2. every screen kind ─────────────────────────
expect = {"shop": ("Shop", 120), "inventory": ("Inventory", 100), "hud": ("HUD", 120), "main_menu": ("MainMenu", 40), "settings": ("Settings", 80), "leaderboard": ("Leaderboard", 10), "daily": ("DailyRewards", 100), "quests": ("QuestLog", 30), "loading": ("LoadingScreen", 20), "dialog": ("Dialog", 40), "notify": ("Notifications", 3)}
WINDOWED = {"shop", "inventory", "main_menu", "settings", "leaderboard", "daily", "quests", "dialog"}
for key, (name, minCount) in expect.items():
    r = run(key)
    parentName = "ReplicatedFirst" if key == "loading" else "StarterGui"
    parent = game.GetService(game, parentName)
    sg = parent.FindFirstChild(parent, name)
    n = count_desc(sg) if sg is not None else 0
    ok("ui_screen_generate %s builds %s.%s (%d instances, want >=%d)" % (key, parentName, name, n, minCount), r.get("ok") and sg is not None and n >= minCount, r if not r.get("ok") else r["text"][:160])
    if sg is None:
        continue
    if key != "loading":
        ok("  %s has OR_Controller" % key, sg.FindFirstChild(sg, "OR_Controller") is not None)
    ok("  %s roots use scale sizes (no offset-only roots)" % key, all((c.Size.X.Scale > 0 or c.Size.X.Offset == 0) for c in sg.GetChildren(sg).values() if c.IsA(c, "GuiObject")))
    if key in WINDOWED:
        ok("  %s window root has aspect + size constraints" % key, any(c.IsA(c, "GuiObject") and c.FindFirstChildOfClass(c, "UIAspectRatioConstraint") and c.FindFirstChildOfClass(c, "UISizeConstraint") for c in sg.GetChildren(sg).values()))
    ok("  %s text is TextScaled with a size constraint" % key, all((not d.IsA(d, "TextLabel")) or (d.TextScaled and d.FindFirstChildOfClass(d, "UITextSizeConstraint")) for d in sg.GetDescendants(sg).values()))

RS = game.GetService(game, "ReplicatedStorage")
remotes = RS.FindFirstChild(RS, "Remotes")
ok("remotes folder created with shop/daily/notify remotes", remotes and all(remotes.FindFirstChild(remotes, n) for n in ["OR_Shop_Buy", "OR_Daily_Claim", "OR_Notify", "OR_Inventory_Equip"]))
SSS = game.GetService(game, "ServerScriptService")
ok("server scripts written (OR_ShopServer, OR_DailyServer)", SSS.FindFirstChild(SSS, "OR_ShopServer") and SSS.FindFirstChild(SSS, "OR_DailyServer"))
shopSrc = SSS.FindFirstChild(SSS, "OR_ShopServer").Source
ok("shop server CATALOG lists the requested items", '["Sword"] = { price = 100' in shopSrc and '["Potion"]' in shopSrc, shopSrc[:300])
shop = SG().FindFirstChild(SG(), "Shop")
win = shop.FindFirstChild(shop, "ShopWindow")
ok("shop window: header title, close button (OR_Action close), tabs, item cards", win.GetAttribute(win, "OR_Window") is True and win.FindFirstChild(win, "Header").FindFirstChild(win.FindFirstChild(win, "Header"), "Title").Text == "Gem Shop" and win.FindFirstChild(win, "Close", True).GetAttribute(win.FindFirstChild(win, "Close", True), "OR_Action") == "close" and win.FindFirstChild(win, "Categories", True) is not None and count_desc(win, "TextButton") >= 5)
cards = [d for d in win.GetDescendants(win).values() if d.GetAttribute(d, "OR_Rarity")]
ok("shop item cards carry OR_Item / OR_Rarity and a Buy button bound to the remote", len(cards) >= 3 and all(c.FindFirstChild(c, "Buy") and c.FindFirstChild(c, "Buy").GetAttribute(c.FindFirstChild(c, "Buy"), "OR_Action") == "remote:OR_Shop_Buy" for c in cards), len(cards))
ok("shop window starts hidden + toggles with B", win.GetAttribute(win, "OR_StartHidden") is True and shop.GetAttribute(shop, "OR_OpenKey") == "B")
hud = SG().FindFirstChild(SG(), "HUD")
ok("hud: currency pills bound to leaderstats, health bar, hotbar slots, feeds", hud.FindFirstChild(hud, "Coins", True).GetAttribute(hud.FindFirstChild(hud, "Coins", True), "OR_Stat") == "Coins" and hud.FindFirstChild(hud, "Health", True).GetAttribute(hud.FindFirstChild(hud, "Health", True), "OR_Progress") == 1 and count_desc(hud.FindFirstChild(hud, "Hotbar"), "ImageButton") == 9 and hud.FindFirstChild(hud, "OR_HudFeed") and hud.FindFirstChild(hud, "OR_NotifyFeed"))

# ───────────────────────── 3. ui_from_spec custom tree ─────────────────────────
r = run("from_spec")
custom = SG().FindFirstChild(SG(), "Custom")
ok("ui_from_spec builds the custom screen", r.get("ok") and custom is not None and r["data"]["count"] >= 9 and count_desc(custom) >= 60, r)
tabs = custom.FindFirstChild(custom, "T", True)
pages = tabs.FindFirstChild(tabs, "Pages")
ok("tabs: 2 tab buttons, 2 pages, first visible", tabs.GetAttribute(tabs, "OR_Tabs") is True and len([c for c in pages.GetChildren(pages).values()]) == 2 and pages.FindFirstChild(pages, "Page_One").Visible is True and pages.FindFirstChild(pages, "Page_Two").Visible is False)
pb = custom.FindFirstChild(custom, "PB", True)
ok("progress bar: Fill 25% + OR_Progress attribute", pb and abs(pb.FindFirstChild(pb, "Fill").Size.X.Scale - 0.25) < 1e-6 and pb.GetAttribute(pb, "OR_Progress") == 0.25)
grid = custom.FindFirstChild(custom, "G", True)
ok("grid: 3 columns -> UIGridLayout with aspect constraint, 2 slots", grid.FindFirstChildOfClass(grid, "UIGridLayout") and grid.FindFirstChildOfClass(grid, "UIGridLayout").FindFirstChildOfClass(grid.FindFirstChildOfClass(grid, "UIGridLayout"), "UIAspectRatioConstraint") and count_desc(grid, "ImageButton") == 2)
floating = custom.FindFirstChild(custom, "Floating")
ok("anchored root button: AnchorPoint (1,1), position 1,1 minus margin", floating.AnchorPoint.X == 1 and floating.AnchorPoint.Y == 1 and floating.Position.X.Scale < 1 and floating.Position.Y.Scale < 1 and floating.GetAttribute(floating, "OR_Action") == "toggle:Win")
ok("ScrollList children (settings) use offset heights, scale widths", all(c.Size.Y.Offset > 0 and c.Size.Y.Scale == 0 for c in SG().FindFirstChild(SG(), "Settings").FindFirstChild(SG().FindFirstChild(SG(), "Settings"), "Options", True).GetChildren(SG().FindFirstChild(SG(), "Settings").FindFirstChild(SG().FindFirstChild(SG(), "Settings"), "Options", True)).values() if c.IsA(c, "GuiObject")))

# ───────────────────────── 4. component place / errors ─────────────────────────
r = run("place")
ok("ui_component_place adds a pill into the HUD row", r.get("ok") and hud.FindFirstChild(hud, "Extra", True) is not None and "layout" in r["text"], r)
r = run("place_bad")
ok("ui_component_place rejects an unknown kind cleanly", r.get("ok") is False and "unknown component kind" in r.get("error", ""), r)

# ───────────────────────── 5. export / audit on generated UI ─────────────────────────
r = run("export")
ok("ui_export_spec round-trips the shop into a spec tree", r.get("ok") and r["data"]["spec"]["name"] == "Shop" and r["data"]["spec"]["children"][0]["kind"] == "Window" and r["data"]["nodes"] > 20, r if not r.get("ok") else r["data"]["nodes"])
r = run("audit")
if r.get("ok") and r["data"]["score"] < 70:
    for i in r["data"]["issues"]:
        print("      audit:", i["rule"], i["path"], i.get("detail", ""))
ok("ui_audit scores the generated screens high (no errors)", r.get("ok") and r["data"]["counts"]["error"] == 0 and r["data"]["score"] >= 70, r if not r.get("ok") else (r["data"]["score"], r["data"]["counts"], [i["rule"] + ":" + i["path"] for i in r["data"]["issues"][:6]]))

# ───────────────────────── 6. legacy UI: apply tokens / responsive / gamepad / states / audit ─────────────────────────
legacy = L.eval("""function(StarterGui)
  local sg=Instance.new('ScreenGui') sg.Name='Legacy' sg.ZIndexBehavior=Enum.ZIndexBehavior.Global sg.Parent=StarterGui
  local f=Instance.new('Frame') f.Name='Main' f.Size=UDim2.new(0,400,0,300) f.Position=UDim2.new(0,100,0,100) f.BackgroundColor3=Color3.fromRGB(200,200,200) f.Parent=sg
  local t=Instance.new('TextLabel') t.Name='Title' t.Size=UDim2.new(1,0,0,30) t.Text='Old title' t.TextSize=10 t.TextColor3=Color3.fromRGB(190,190,190) t.BackgroundTransparency=1 t.Parent=f
  for i=1,4 do local b=Instance.new('TextButton') b.Name='B'..i b.Size=UDim2.new(0,20,0,20) b.Position=UDim2.new(0,10+(i-1)*30,0,60) b.Text='b'..i b.BackgroundColor3=Color3.fromRGB(1,2,3) b.Parent=f end
  local o1=Instance.new('Frame') o1.Name='O1' o1.Size=UDim2.new(0,100,0,100) o1.Position=UDim2.new(0,0,0,150) o1.Parent=f
  local o2=Instance.new('Frame') o2.Name='O2' o2.Size=UDim2.new(0,100,0,100) o2.Position=UDim2.new(0,40,0,170) o2.Parent=f
  local s=Instance.new('ScrollingFrame') s.Name='S' s.Size=UDim2.new(0,100,0,50) s.Position=UDim2.new(0,250,0,150) s.Parent=f
  return sg
end""")(SG())
r = run("audit_legacy")
rules = {i["rule"] for i in r["data"]["issues"]} if r.get("ok") else set()
ok("ui_audit flags the legacy UI: contrast, tiny text, small targets, offset root, overlap, static canvas, zindex, no runtime", r.get("ok") and {"low_contrast", "tiny_text", "small_touch_target", "offset_only_root", "overlap", "static_canvas", "zindex_global", "no_runtime"} <= rules and r["data"]["score"] < 70, (r.get("data", {}).get("score"), sorted(rules)))
r = run("apply")
main = legacy.FindFirstChild(legacy, "Main")
ok("ui_apply_tokens restyles buttons to Primary and labels to token text", r.get("ok") and r["data"]["restyled"] >= 6 and same(main.FindFirstChild(main, "B1").BackgroundColor3, T.palette.Primary) and main.FindFirstChild(main, "Title").Font.Name in ("Arcade",), r)
r = run("responsive")
ok("ui_make_responsive converts the offset root to scale + constraints + OR_Responsive", r.get("ok") and r["data"]["converted_roots"] == 1 and main.Size.X.Scale > 0 and main.Size.X.Offset == 0 and main.FindFirstChildOfClass(main, "UIAspectRatioConstraint") and legacy.FindFirstChild(legacy, "OR_Responsive") and main.FindFirstChild(main, "Title").TextScaled is True, r)
r = run("gamepad")
b1, b2 = main.FindFirstChild(main, "B1"), main.FindFirstChild(main, "B2")
ok("ui_gamepad_focus links neighbours and adds a selection cursor", r.get("ok") and r["data"]["buttons"] == 4 and same(b1.NextSelectionRight, b2) and same(b2.NextSelectionLeft, b1) and b1.SelectionImageObject is not None and b1.Selectable is True, r)
r = run("states")
ok("ui_states_wire writes OR_Controller and default print actions", r.get("ok") and legacy.FindFirstChild(legacy, "OR_Controller") and b1.GetAttribute(b1, "OR_Action") == "print", r)
r = run("preview")
ok("ui_preview phone adds OR_PreviewScale 0.55 and shows the window", r.get("ok") and r["data"]["factor"] == 0.55 and win.FindFirstChild(win, "OR_PreviewScale") and win.Visible is True, r)
r = run("preview_restore")
ok("ui_preview restore removes the scale", r.get("ok") and win.FindFirstChild(win, "OR_PreviewScale") is None, r)

# ───────────────────────── 7. RUNTIME: controller + feeds as a client ─────────────────────────
M.isEdit = False
M.invalidate()
# clone StarterGui screens into PlayerGui like Roblox does, then run their LocalScripts
pgui = M.playerGui
clone_run = L.eval("""function(M, src, pg)
  local c = src:Clone() c.Parent = pg
  local ran, errs = 0, {}
  for _, d in ipairs(c:GetDescendants()) do
    if d:IsA('LocalScript') then
      local okR, err = pcall(M.runScript, d, true)
      ran = ran + 1
      if not okR then errs[#errs+1] = d.Name .. ': ' .. tostring(err) end
    end
  end
  return c, ran, errs
end""")
pshop, ran, errs = clone_run(M, shop, pgui)
ok("Shop LocalScripts run on a client (OR_Controller + OR_NotifyFeed)", ran == 2 and len(list(errs.values())) == 0, list(errs.values()))
pwin = pshop.FindFirstChild(pshop, "ShopWindow")
ok("controller: OR_StartHidden window is hidden on load", pwin.Visible is False)
# open with key B
inputB = py_to_lua({"KeyCode": {"Name": "B"}, "UserInputType": {"Name": "Keyboard"}})
UIS = game.GetService(game, "UserInputService")
UIS.InputBegan.Fire(UIS.InputBegan, inputB, False)
ok("controller: OR_OpenKey B opens the window (tween to scale 1)", pwin.Visible is True and pwin.FindFirstChild(pwin, "OR_Anim").Scale == 1)
closeBtn = pwin.FindFirstChild(pwin, "Close", True)
closeBtn.Activated.Fire(closeBtn.Activated)
ok("controller: Close button action hides the window", pwin.Visible is False and pwin.GetAttribute(pwin, "OR_Open") is False)
buy = [d for d in pwin.GetDescendants(pwin).values() if d.GetAttribute(d, "OR_Action") == "remote:OR_Shop_Buy"][0]
before = len(list(M.fired.values()))
buy.Activated.Fire(buy.Activated)
fired = list(M.fired.values())
last = lua_to_py(fired[-1]) if len(fired) > before else None
ok("controller: Buy button fires OR_Shop_Buy with {item}", last and last[0] == "OR_Shop_Buy" and last[1]["item"] in ("Sword", "Shield", "Potion"), last)
# hover state tween + tabs
tabBtns = [d for d in pwin.GetDescendants(pwin).values() if d.GetAttribute(d, "OR_Tab")]
tabBtns[1].Activated.Fire(tabBtns[1].Activated)
tabsRoot = pwin.FindFirstChild(pwin, "Categories", True)
pagesP = tabsRoot.FindFirstChild(tabsRoot, "Pages")
ok("controller/UIKit: clicking tab 2 switches pages", tabsRoot.GetAttribute(tabsRoot, "OR_ActiveTab") == "Gear" and pagesP.FindFirstChild(pagesP, "Page_Gear").Visible is True and pagesP.FindFirstChild(pagesP, "Page_All").Visible is False)
b = buy
base = b.BackgroundColor3
b.MouseEnter.Fire(b.MouseEnter)
hovered = b.BackgroundColor3
b.MouseLeave.Fire(b.MouseLeave)
ok("UIKit.wireButton: hover lightens, leave restores", not same(hovered, base) and same(b.BackgroundColor3, base) and b.FindFirstChild(b, "OR_PressScale") is not None)

# shop server handles the purchase
server = SSS.FindFirstChild(SSS, "OR_ShopServer")
M.runScript(server, False)
buyRemote = remotes.FindFirstChild(remotes, "OR_Shop_Buy")
buyRemote.OnServerEvent.Fire(buyRemote.OnServerEvent, M.fakePlayer, py_to_lua({"item": "Sword"}))
coinsV = M.fakePlayer.FindFirstChild(M.fakePlayer, "leaderstats").FindFirstChild(M.fakePlayer.FindFirstChild(M.fakePlayer, "leaderstats"), "Coins")
ok("OR_ShopServer: validates, charges 100 Coins, grants, notifies", coinsV.Value == 400 and M.fakePlayer.GetAttribute(M.fakePlayer, "Owns_Sword") is True and any("Bought Sword" in str(lua_to_py(f)) for f in list(M.fired.values())), coinsV.Value)
buyRemote.OnServerEvent.Fire(buyRemote.OnServerEvent, M.fakePlayer, py_to_lua({"item": "Nothing"}))
ok("OR_ShopServer: unknown item is refused with a warning", coinsV.Value == 400 and any("unknown item" in w for w in list(M.warnings.values())))

# HUD feeds
phud, ran, errs = clone_run(M, hud, pgui)
ok("HUD LocalScripts run (controller, hud feed, notify feed)", ran == 3 and len(list(errs.values())) == 0, list(errs.values()))
pill = phud.FindFirstChild(phud, "Coins", True)
ok("OR_HudFeed: currency pill shows leaderstats.Coins (400)", pill.FindFirstChild(pill, "Value").Text == "400", pill.FindFirstChild(pill, "Value").Text)
coinsV.Value = 12500
coinsV.Changed.Fire(coinsV.Changed)
ok("OR_HudFeed: live update formats 12.5K", pill.FindFirstChild(pill, "Value").Text == "12.5K", pill.FindFirstChild(pill, "Value").Text)

# settings toggles persist to player attributes
pset, ran, errs = clone_run(M, SG().FindFirstChild(SG(), "Settings"), pgui)
sw = [d for d in pset.GetDescendants(pset).values() if d.GetAttribute(d, "OR_Setting") == "music"][0]
sw.Activated.Fire(sw.Activated)
ok("Settings: toggle flips OR_Toggle and persists Setting_music", len(list(errs.values())) == 0 and sw.GetAttribute(sw, "OR_Toggle") is False and M.fakePlayer.GetAttribute(M.fakePlayer, "Setting_music") is False, list(errs.values()))

# daily server
M.runScript(SSS.FindFirstChild(SSS, "OR_DailyServer"), False)
claim = remotes.FindFirstChild(remotes, "OR_Daily_Claim")
res = lua_to_py(claim.InvokeServer(claim, py_to_lua({})))
res2 = lua_to_py(claim.InvokeServer(claim, py_to_lua({})))
ok("OR_DailyServer: first claim pays day 1 (+10), second is on cooldown", res["ok"] is True and res["day"] == 1 and res["reward"] == 10 and res2["ok"] is False and "Come back" in res2["message"], (res, res2))
ok("OR_DailyServer: claim persisted to DataStore OR_DailyRewards", M.dsCalls >= 2 and lua_to_py(M.datastores["OR_DailyRewards"]["1"])["day"] == 1, (M.dsCalls,))

# dialog typewriter + leaderboard feed + loading script compile
pdlg, ran, errs = clone_run(M, SG().FindFirstChild(SG(), "Dialog"), pgui)
line = pdlg.FindFirstChild(pdlg, "Line", True)
ok("Dialog: typewriter label animates MaxVisibleGraphemes", len(list(errs.values())) == 0 and line.MaxVisibleGraphemes == len(line.Text) and len(line.Text) > 0, (list(errs.values()), line.MaxVisibleGraphemes))
plb_errs = None
try:
    plb, ran, errs = clone_run(M, SG().FindFirstChild(SG(), "Leaderboard"), pgui)
    plb_errs = list(errs.values())
except Exception as e:  # the feed loops with task.wait; the simulator's wait budget stops it
    plb_errs = [str(e)]
ok("Leaderboard feed runs until the simulated wait budget (no runtime error before it)", plb_errs is not None and all("wait budget" in e for e in plb_errs), plb_errs)
RF = game.GetService(game, "ReplicatedFirst")
loadingScript = RF.FindFirstChild(RF, "OR_Loading")
M.waits = 0  # the leaderboard poll loop above deliberately spent the main-thread wait budget
resL = L.eval("function(M,s) local okR, err = pcall(M.runScript, s, true) return {okR, err} end")(M, loadingScript)
okL, errL = resL[1], resL[2]
ok("OR_Loading runs end-to-end (preload, progress, fade, destroy)", okL and pgui.FindFirstChild(pgui, "LoadingScreen") is None, errL)

failed = results.count(False)
print("\n%d passed, %d failed" % (len(results) - failed, failed))
sys.exit(1 if failed else 0)
