#!/usr/bin/env python3
"""Shared miniature Roblox DataModel (Lua, run with lupa) for the simulator tests.

tests/design-sim.py (DESIGN pack) and tests/gfx-sim.py (Thumbnail & Icon Studio) both
execute generated Luau against this model: Instance tree with class inheritance,
Color3 / Vector2 / Vector3 / CFrame (real 3x3 rotation maths) / UDim / UDim2 / Enum /
sequences, services (Workspace + CurrentCamera, Lighting, Players with R15/R6 rig
factories, StarterGui, Selection, HttpService JSON, TweenService, RunService ...),
signals, attributes, Model pivots / bounding boxes / ScaleTo, require/loadstring and
task.*. It is not an engine (no rendering, no physics, no joint solving) - it catches
the class of bugs a blind-written Luau program has: nil indexing, wrong argument
shapes, wrong property types, scripts that error on load.

    from roblox_sim import ROBLOX, make_runtime
    L, M, run_program = make_runtime()
"""
import json

ROBLOX = r"""
local M = {}
local CLASSES = {
  Instance={}, Folder={"Instance"}, LuaSourceContainer={"Instance"}, ModuleScript={"LuaSourceContainer"}, LocalScript={"LuaSourceContainer"}, Script={"LuaSourceContainer"},
  RemoteEvent={"Instance"}, RemoteFunction={"Instance"}, BindableEvent={"Instance"}, BindableFunction={"Instance"}, ValueBase={"Instance"}, IntValue={"ValueBase"}, NumberValue={"ValueBase"}, StringValue={"ValueBase"}, Color3Value={"ValueBase"},
  Sound={"Instance"}, Camera={"Instance"}, Humanoid={"Instance"}, Player={"Instance"}, PlayerGui={"Instance"},
  PVInstance={"Instance"}, Model={"PVInstance"}, Tool={"Model"}, Accessory={"Model"}, BasePart={"PVInstance"}, Part={"BasePart"}, MeshPart={"BasePart"}, WedgePart={"BasePart"}, UnionOperation={"BasePart"}, TrussPart={"BasePart"},
  KeyframeSequence={"Instance"}, Keyframe={"Instance"}, Pose={"Instance"}, KeyframeMarker={"Instance"}, Animation={"Instance"},
  Attachment={"Instance"}, Decal={"Instance"}, Texture={"Decal"}, JointInstance={"Instance"}, Motor6D={"JointInstance"}, Weld={"JointInstance"}, WeldConstraint={"Instance"}, HumanoidDescription={"Instance"}, FaceControls={"Instance"},
  ParticleEmitter={"Instance"}, Beam={"Instance"}, Trail={"Instance"}, Highlight={"Instance"}, Light={"Instance"}, SpotLight={"Light"}, PointLight={"Light"}, SurfaceLight={"Light"},
  PostEffect={"Instance"}, BloomEffect={"PostEffect"}, ColorCorrectionEffect={"PostEffect"}, DepthOfFieldEffect={"PostEffect"}, SunRaysEffect={"PostEffect"}, BlurEffect={"PostEffect"}, Atmosphere={"Instance"}, Sky={"Instance"}, Clouds={"Instance"},
  GuiBase2d={"Instance"}, LayerCollector={"GuiBase2d"}, ScreenGui={"LayerCollector"}, SurfaceGui={"LayerCollector"},
  GuiObject={"GuiBase2d"}, Frame={"GuiObject"}, ScrollingFrame={"GuiObject"}, CanvasGroup={"GuiObject"}, ViewportFrame={"GuiObject"},
  GuiButton={"GuiObject"}, TextButton={"GuiButton"}, ImageButton={"GuiButton"}, TextLabel={"GuiObject"}, ImageLabel={"GuiObject"}, TextBox={"GuiObject"},
  UIBase={"Instance"}, UIComponent={"UIBase"}, UIConstraint={"UIComponent"}, UILayout={"UIComponent"}, UIGridStyleLayout={"UILayout"},
  UICorner={"UIComponent"}, UIStroke={"UIComponent"}, UIPadding={"UIComponent"}, UIListLayout={"UIGridStyleLayout"}, UIGridLayout={"UIGridStyleLayout"},
  UIAspectRatioConstraint={"UIConstraint"}, UISizeConstraint={"UIConstraint"}, UITextSizeConstraint={"UIConstraint"}, UIScale={"UIComponent"}, UIGradient={"UIComponent"},
  Service={"Instance"}, EditableImage={"Instance"},
  SpawnLocation={"BasePart"}, Seat={"BasePart"}, StarterPlayerScripts={"Instance"}, StarterCharacterScripts={"Instance"}, Backpack={"Instance"}, StarterGear={"Instance"}, BillboardGui={"LayerCollector"}, Animation={"Instance"}, Team={"Instance"}, BoolValue={"ValueBase"}, ObjectValue={"ValueBase"}, Constraint={"Instance"}, AlignPosition={"Constraint"}, AlignOrientation={"Constraint"}, BodyVelocity={"Instance"}, Configuration={"Instance"}, Tags={"Instance"},
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
function Color3.fromHSV(h,s,v) local i=math.floor(h*6)%6 local f=h*6-math.floor(h*6) local p,q,t2=v*(1-s),v*(1-f*s),v*(1-(1-f)*s) local r,g,b if i==0 then r,g,b=v,t2,p elseif i==1 then r,g,b=q,v,p elseif i==2 then r,g,b=p,v,t2 elseif i==3 then r,g,b=p,q,v elseif i==4 then r,g,b=t2,p,v else r,g,b=v,p,q end return Color3.new(r,g,b) end
function Color3:Lerp(o,t) return Color3.new(self.R+(o.R-self.R)*t, self.G+(o.G-self.G)*t, self.B+(o.B-self.B)*t) end
Color3.__eq = function(a,b) return math.abs(a.R-b.R)<1e-6 and math.abs(a.G-b.G)<1e-6 and math.abs(a.B-b.B)<1e-6 end
Color3.__tostring = function(c) return string.format("Color3(%.2f,%.2f,%.2f)", c.R, c.G, c.B) end
local Vector2 = {}
Vector2.__index = Vector2
function Vector2.new(x,y) return setmetatable({X=x or 0,Y=y or 0}, Vector2) end
Vector2.__add = function(a,b) return Vector2.new(a.X+b.X,a.Y+b.Y) end
Vector2.__eq = function(a,b) return a.X==b.X and a.Y==b.Y end
local Vector3 = {}
Vector3.__index = function(v, k)
  if k == "Magnitude" then return math.sqrt(v.X*v.X + v.Y*v.Y + v.Z*v.Z) end
  if k == "Unit" then local m = v.Magnitude if m == 0 then return Vector3.new(0,0,0) end return Vector3.new(v.X/m, v.Y/m, v.Z/m) end
  return Vector3[k]
end
function Vector3.new(x,y,z) return setmetatable({X=x or 0,Y=y or 0,Z=z or 0}, Vector3) end
Vector3.zero = nil
Vector3.__add = function(a,b) return Vector3.new(a.X+b.X,a.Y+b.Y,a.Z+b.Z) end
Vector3.__sub = function(a,b) return Vector3.new(a.X-b.X,a.Y-b.Y,a.Z-b.Z) end
Vector3.__unm = function(a) return Vector3.new(-a.X,-a.Y,-a.Z) end
Vector3.__mul = function(a,b) if type(a)=="number" then return Vector3.new(a*b.X,a*b.Y,a*b.Z) end if type(b)=="number" then return Vector3.new(a.X*b,a.Y*b,a.Z*b) end return Vector3.new(a.X*b.X,a.Y*b.Y,a.Z*b.Z) end
Vector3.__div = function(a,b) if type(b)=="number" then return Vector3.new(a.X/b,a.Y/b,a.Z/b) end return Vector3.new(a.X/b.X,a.Y/b.Y,a.Z/b.Z) end
Vector3.__eq = function(a,b) return math.abs(a.X-b.X)<1e-6 and math.abs(a.Y-b.Y)<1e-6 and math.abs(a.Z-b.Z)<1e-6 end
Vector3.__tostring = function(v) return string.format("%.3f, %.3f, %.3f", v.X, v.Y, v.Z) end
function Vector3:Dot(o) return self.X*o.X+self.Y*o.Y+self.Z*o.Z end
function Vector3:Cross(o) return Vector3.new(self.Y*o.Z-self.Z*o.Y, self.Z*o.X-self.X*o.Z, self.X*o.Y-self.Y*o.X) end
function Vector3:Lerp(o,t) return self+(o-self)*t end
Vector3.zero = Vector3.new(0,0,0) Vector3.one = Vector3.new(1,1,1) Vector3.xAxis = Vector3.new(1,0,0) Vector3.yAxis = Vector3.new(0,1,0) Vector3.zAxis = Vector3.new(0,0,1)
-- CFrame: position + row-major 3x3 rotation (R[1..9] = r00 r01 r02 r10 r11 r12 r20 r21 r22), same conventions as Roblox
local CFrame = {}
local function cfMake(p, R) return setmetatable({__p=p, __R=R}, CFrame) end
local IDENT = {1,0,0, 0,1,0, 0,0,1}
local function rotX(a) local c,s=math.cos(a),math.sin(a) return {1,0,0, 0,c,-s, 0,s,c} end
local function rotY(a) local c,s=math.cos(a),math.sin(a) return {c,0,s, 0,1,0, -s,0,c} end
local function rotZ(a) local c,s=math.cos(a),math.sin(a) return {c,-s,0, s,c,0, 0,0,1} end
local function mmul(A,B) local C={} for i=0,2 do for j=0,2 do local s=0 for k=0,2 do s=s+A[i*3+k+1]*B[k*3+j+1] end C[i*3+j+1]=s end end return C end
local function mvec(A,v) return Vector3.new(A[1]*v.X+A[2]*v.Y+A[3]*v.Z, A[4]*v.X+A[5]*v.Y+A[6]*v.Z, A[7]*v.X+A[8]*v.Y+A[9]*v.Z) end
local function mT(A) return {A[1],A[4],A[7], A[2],A[5],A[8], A[3],A[6],A[9]} end
function CFrame.new(x,y,z, ...)
  if x == nil then return cfMake(Vector3.new(0,0,0), IDENT) end
  if getmetatable(x) == Vector3 then
    if getmetatable(y) == Vector3 then return CFrame.lookAt(x, y) end
    return cfMake(Vector3.new(x.X,x.Y,x.Z), IDENT)
  end
  local extra = {...}
  if #extra >= 9 then return cfMake(Vector3.new(x,y,z), {extra[1],extra[2],extra[3],extra[4],extra[5],extra[6],extra[7],extra[8],extra[9]}) end
  return cfMake(Vector3.new(x or 0,y or 0,z or 0), IDENT)
end
CFrame.identity = CFrame.new()
function CFrame.Angles(rx,ry,rz) return cfMake(Vector3.new(0,0,0), mmul(mmul(rotX(rx or 0), rotY(ry or 0)), rotZ(rz or 0))) end
CFrame.fromEulerAnglesXYZ = CFrame.Angles
function CFrame.fromEulerAnglesYXZ(rx,ry,rz) return cfMake(Vector3.new(0,0,0), mmul(mmul(rotY(ry or 0), rotX(rx or 0)), rotZ(rz or 0))) end
function CFrame.fromOrientation(rx,ry,rz) return CFrame.fromEulerAnglesYXZ(rx,ry,rz) end
function CFrame.fromAxisAngle(axis, a) local u=axis.Unit local c,s=math.cos(a),math.sin(a) local t=1-c return cfMake(Vector3.new(0,0,0), {t*u.X*u.X+c, t*u.X*u.Y-s*u.Z, t*u.X*u.Z+s*u.Y, t*u.X*u.Y+s*u.Z, t*u.Y*u.Y+c, t*u.Y*u.Z-s*u.X, t*u.X*u.Z-s*u.Y, t*u.Y*u.Z+s*u.X, t*u.Z*u.Z+c}) end
function CFrame.lookAt(eye, target, up)
  up = up or Vector3.new(0,1,0)
  local z = (eye - target) if z.Magnitude < 1e-9 then z = Vector3.new(0,0,1) end z = z.Unit
  if math.abs(up.Unit:Dot(z)) > 0.999 then up = Vector3.new(0,0,1) end
  local x = up:Cross(z).Unit
  local y = z:Cross(x)
  return cfMake(Vector3.new(eye.X,eye.Y,eye.Z), {x.X,y.X,z.X, x.Y,y.Y,z.Y, x.Z,y.Z,z.Z})
end
CFrame.lookAlong = function(eye, dir, up) return CFrame.lookAt(eye, eye + dir, up) end
CFrame.__index = function(cf, k)
  local R = rawget(cf, "__R") local p = rawget(cf, "__p")
  if k == "Position" then return p end
  if k == "X" then return p.X elseif k == "Y" then return p.Y elseif k == "Z" then return p.Z end
  if k == "LookVector" then return Vector3.new(-R[3],-R[6],-R[9]) end
  if k == "RightVector" or k == "XVector" then return Vector3.new(R[1],R[4],R[7]) end
  if k == "UpVector" or k == "YVector" then return Vector3.new(R[2],R[5],R[8]) end
  if k == "ZVector" then return Vector3.new(R[3],R[6],R[9]) end
  if k == "Rotation" then return cfMake(Vector3.new(0,0,0), R) end
  return CFrame[k]
end
CFrame.__mul = function(a,b)
  if getmetatable(b) == Vector3 then return mvec(a.__R, b) + a.__p end
  return cfMake(mvec(a.__R, b.__p) + a.__p, mmul(a.__R, b.__R))
end
CFrame.__add = function(a,v) return cfMake(a.__p + v, a.__R) end
CFrame.__sub = function(a,v) return cfMake(a.__p - v, a.__R) end
CFrame.__eq = function(a,b) if a.__p ~= b.__p then return false end for i=1,9 do if math.abs(a.__R[i]-b.__R[i])>1e-6 then return false end end return true end
CFrame.__tostring = function(cf) return "CFrame(" .. tostring(cf.__p) .. ")" end
function CFrame:Inverse() local Rt = mT(self.__R) return cfMake(-mvec(Rt, self.__p), Rt) end
function CFrame:ToWorldSpace(o) return self * o end
function CFrame:ToObjectSpace(o) return self:Inverse() * o end
function CFrame:PointToWorldSpace(v) return self * v end
function CFrame:PointToObjectSpace(v) return self:Inverse() * v end
function CFrame:VectorToWorldSpace(v) return mvec(self.__R, v) end
function CFrame:VectorToObjectSpace(v) return mvec(mT(self.__R), v) end
function CFrame:Lerp(o,t)
  -- real rotational slerp (axis-angle of the relative rotation), like Roblox - needed for the animation sampler checks
  local Ra, Rb = self.__R, o.__R
  local Rrel = mmul(mT(Ra), Rb)
  local c = math.max(-1, math.min(1, (Rrel[1] + Rrel[5] + Rrel[9] - 1) / 2))
  local ang = math.acos(c)
  local R
  if ang < 1e-7 then R = Ra
  else
    local s2 = 2 * math.sin(ang)
    local axis = Vector3.new((Rrel[8] - Rrel[6]) / s2, (Rrel[3] - Rrel[7]) / s2, (Rrel[4] - Rrel[2]) / s2)
    R = mmul(Ra, CFrame.fromAxisAngle(axis, ang * t).__R)
  end
  return cfMake(self.__p:Lerp(o.__p,t), R)
end
function CFrame:GetComponents() local R=self.__R return self.__p.X,self.__p.Y,self.__p.Z,R[1],R[2],R[3],R[4],R[5],R[6],R[7],R[8],R[9] end
function CFrame:ToEulerAnglesYXZ() local R=self.__R local rx=math.asin(math.max(-1,math.min(1,-R[6]))) local ry=math.atan(R[3],R[9]) local rz=math.atan(R[4],R[5]) return rx,ry,rz end
function CFrame:ToOrientation() return self:ToEulerAnglesYXZ() end
function CFrame:ToEulerAnglesXYZ() local R=self.__R local ry=math.asin(math.max(-1,math.min(1,R[3]))) local rx=math.atan(-R[6],R[9]) local rz=math.atan(-R[2],R[1]) return rx,ry,rz end
function CFrame:Orthonormalize() return self end
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
local function ColorSequence_new(a,b) if type(a)=="table" and getmetatable(a)==nil then return {Keypoints=a} end return {Keypoints={{Time=0,Value=a},{Time=1,Value=b or a}}} end
local function NumberSequence_new(a,b) if type(a)=="table" then return {Keypoints=a} end return {Keypoints={{Time=0,Value=a},{Time=1,Value=b or a}}} end
local function NumberSequenceKeypoint_new(t,v,e) return {Time=t,Value=v,Envelope=e or 0} end
local function ColorSequenceKeypoint_new(t,v) return {Time=t,Value=v} end
local function NumberRange_new(a,b) return {Min=a,Max=b or a} end
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
local EVENTS = {Ended=1,Played=1,Stopped=1,Activated=1,MouseEnter=1,MouseLeave=1,MouseButton1Down=1,MouseButton1Up=1,MouseButton1Click=1,SelectionGained=1,SelectionLost=1,DescendantAdded=1,ChildAdded=1,ChildRemoved=1,Changed=1,CharacterAdded=1,HealthChanged=1,PlayerRemoving=1,PlayerAdded=1,Loaded=1,InputBegan=1,InputEnded=1,LastInputTypeChanged=1,Completed=1,OnClientEvent=1,OnServerEvent=1,Event=1,Focused=1,FocusLost=1,AncestryChanged=1,Destroying=1,Died=1,Touched=1,TouchEnded=1,Heartbeat=1,Stepped=1,RenderStepped=1,Chatted=1,StateChanged=1,Equipped=1,Unequipped=1,Running=1,Jumping=1,AttributeChanged=1,PromptGamePassPurchaseFinished=1,PromptProductPurchaseFinished=1,PromptPurchaseFinished=1,PlayerMembershipChanged=1,ProcessReceipt=0}
local DEFAULTS = {Size=function() return UDim2.new(0,100,0,100) end, Position=function() return UDim2.new() end, AnchorPoint=function() return Vector2.new() end,
  BackgroundColor3=function() return Color3.new(1,1,1) end, BackgroundTransparency=0, BorderSizePixel=1, TextColor3=function() return Color3.new(0,0,0) end, TextTransparency=0, TextStrokeTransparency=1, TextSize=14, Text="", TextScaled=false, TextWrapped=false, RichText=false,
  Visible=true, ZIndex=1, Image="", ImageTransparency=0, ImageColor3=function() return Color3.new(1,1,1) end, Font=function() return Enum.Font.Legacy end, Enabled=true, Active=false, AutoButtonColor=true, ClipsDescendants=false,
  CanvasSize=function() return UDim2.new() end, AutomaticCanvasSize=function() return Enum.AutomaticSize.None end, AutomaticSize=function() return Enum.AutomaticSize.None end, ZIndexBehavior=function() return Enum.ZIndexBehavior.Sibling end, IgnoreGuiInset=false, ResetOnSpawn=true, DisplayOrder=0,
  TextXAlignment=function() return Enum.TextXAlignment.Center end, TextYAlignment=function() return Enum.TextYAlignment.Center end, ScrollBarThickness=12, LayoutOrder=0, Scale=1, Transparency=0, Thickness=1, CornerRadius=function() return UDim.new() end,
  MinSize=function() return Vector2.new() end, MaxSize=function() return Vector2.new(math.huge,math.huge) end, MinTextSize=1, MaxTextSize=100, AspectRatio=1, Source="", Value=0, Volume=0.5, PlayOnRemove=false, MaxVisibleGraphemes=-1, ContentText="",
  PaddingLeft=function() return UDim.new() end, PaddingRight=function() return UDim.new() end, PaddingTop=function() return UDim.new() end, PaddingBottom=function() return UDim.new() end, Padding=function() return UDim.new() end,
  CellSize=function() return UDim2.new(0,100,0,100) end, CellPadding=function() return UDim2.new() end, FillDirection=function() return Enum.FillDirection.Vertical end, PlaceholderText="", ClearTextOnFocus=true, SelectionGroup=false,
  Health=100, MaxHealth=100, ShowDevelopmentGui=true, ScaleType=function() return Enum.ScaleType.Stretch end, Rotation=0,
  -- 3D / lighting
  Anchored=false, CanCollide=true, CanQuery=true, CanTouch=true, CastShadow=true, Massless=false, Material=function() return Enum.Material.Plastic end, Color=function() return Color3.fromRGB(163,162,165) end, Reflectance=0,
  Brightness=1, Range=8, Angle=90, Shadows=false, FieldOfView=70, Intensity=0, Threshold=1, Contrast=0, Saturation=0, TintColor=function() return Color3.new(1,1,1) end,
  FarIntensity=0.75, NearIntensity=0.75, FocusDistance=0.05, InFocusRadius=10, Spread=1, Density=0.395, Offset=0, Glare=0, Haze=0, Rate=20, LightEmission=0, LightInfluence=1, Drag=0, FillTransparency=0.5, OutlineTransparency=0,
  ClockTime=14, FogEnd=100000, FogStart=0, ExposureCompensation=0, GlobalShadows=true, EnvironmentDiffuseScale=0, EnvironmentSpecularScale=0, ShadowSoftness=0.2, Ambient=function() return Color3.fromRGB(70,70,70) end, OutdoorAmbient=function() return Color3.fromRGB(70,70,70) end, FogColor=function() return Color3.fromRGB(192,192,192) end,
  HipHeight=2, WalkSpeed=16, JumpPower=50, RigType=function() return Enum.HumanoidRigType.R15 end, DisplayDistanceType=function() return Enum.HumanoidDisplayDistanceType.Viewer end, HealthDisplayType=function() return Enum.HumanoidHealthDisplayType.DisplayWhenDamaged end, NameDisplayDistance=100,
  Texture="", Face=function() return Enum.NormalId.Front end, Archivable=true, Locked=false, Enabled=true,
  -- animation data (KeyframeSequence / Keyframe / Pose)
  Loop=false, Priority=function() return Enum.AnimationPriority.Core end, Time=0, Weight=1, EasingStyle=function() return Enum.PoseEasingStyle.Linear end, EasingDirection=function() return Enum.PoseEasingDirection.In end,
}
local PART_DEFAULTS = {Size=function() return Vector3.new(4,1,2) end, CFrame=function() return CFrame.new() end}
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
-- Animation data API (1.52.0): KeyframeSequence/Keyframe/Pose hierarchies + BasePart:GetJoints
function methods:GetKeyframes() local out={} for _,c in ipairs(self.__children) do if c.__class=="Keyframe" then out[#out+1]=c end end return out end
function methods:GetPoses() local out={} for _,c in ipairs(self.__children) do if c.__class=="Pose" then out[#out+1]=c end end return out end
function methods:GetSubPoses() return self:GetPoses() end
function methods:AddPose(p) p.Parent=self end
function methods:AddSubPose(p) p.Parent=self end
function methods:RemovePose(p) p.Parent=nil end
function methods:GetMarkers() local out={} for _,c in ipairs(self.__children) do if c.__class=="KeyframeMarker" then out[#out+1]=c end end return out end
function methods:AddMarker(m) m.Parent=self end
function methods:GetJoints()
  local out={} local root=self while root.__props.Parent do root=root.__props.Parent end
  for _,d in ipairs(root:GetDescendants()) do if isa(d.__class,"JointInstance") and (d.__props.Part0==self or d.__props.Part1==self) then out[#out+1]=d end end
  return out
end
local function cloneTree(self, map)
  local c=new(self.__class) map[self]=c
  for k,v in pairs(self.__props) do if k~="Parent" then c.__props[k]=v end end
  for k,v in pairs(self.__attrs) do c.__attrs[k]=v end
  for _,ch in ipairs(self.__children) do local cc=cloneTree(ch, map) cc.Parent=c end
  return c
end
-- Instance references inside the cloned tree (PrimaryPart, Motor6D.Part0/Part1, ObjectValue.Value ...) are remapped to the copies, as Roblox does
function methods:Clone()
  local map = {}
  local c = cloneTree(self, map)
  for old, copy in pairs(map) do for k,v in pairs(copy.__props) do if type(v)=="table" and rawget(v,"__class") and map[v] then copy.__props[k]=map[v] end end end
  return c
end
function methods:SetAttribute(k,v) local old=self.__attrs[k] self.__attrs[k]=v if old~=v and self.__attrSignals[k] then self.__attrSignals[k]:Fire() end end
function methods:GetAttribute(k) return self.__attrs[k] end
function methods:GetAttributes() local t={} for k,v in pairs(self.__attrs) do t[k]=v end return t end
function methods:GetAttributeChangedSignal(k) local s=self.__attrSignals[k] if not s then s=Signal.new() self.__attrSignals[k]=s end return s end
function methods:GetPropertyChangedSignal(k) local s=self.__propSignals[k] if not s then s=Signal.new() self.__propSignals[k]=s end return s end
-- PVInstance / Model geometry
local function partsOf(m) local out={} if isa(m.__class,"BasePart") then out[1]=m end for _,d in ipairs(m:GetDescendants()) do if isa(d.__class,"BasePart") then out[#out+1]=d end end return out end
local function aabb(m)
  local mn, mx
  for _,p in ipairs(partsOf(m)) do
    local cf, h = p.CFrame, p.Size*0.5
    for _,sx in ipairs({-1,1}) do for _,sy in ipairs({-1,1}) do for _,sz in ipairs({-1,1}) do
      local c = cf * Vector3.new(h.X*sx, h.Y*sy, h.Z*sz)
      if not mn then mn, mx = c, c else mn = Vector3.new(math.min(mn.X,c.X),math.min(mn.Y,c.Y),math.min(mn.Z,c.Z)) mx = Vector3.new(math.max(mx.X,c.X),math.max(mx.Y,c.Y),math.max(mx.Z,c.Z)) end
    end end end
  end
  return mn, mx
end
function methods:GetPivot()
  if isa(self.__class, "BasePart") then local po = self.__props.PivotOffset if po then return self.CFrame * po end return self.CFrame end
  local pp = self.__props.PrimaryPart if pp then return pp:GetPivot() end
  local wp = self.__props.WorldPivot if wp then return wp end
  local mn, mx = aabb(self) if mn then return CFrame.new((mn+mx)*0.5) end
  return CFrame.new()
end
function methods:PivotTo(cf)
  assert(getmetatable(cf) == CFrame, "PivotTo expects a CFrame")
  local old = self:GetPivot() local delta = cf * old:Inverse()
  for _,p in ipairs(partsOf(self)) do p.CFrame = delta * p.CFrame end
  if not isa(self.__class, "BasePart") then self.__props.WorldPivot = cf end
end
function methods:GetBoundingBox() local mn, mx = aabb(self) if not mn then return self:GetPivot(), Vector3.new(0,0,0) end return CFrame.new((mn+mx)*0.5), mx-mn end
function methods:GetExtentsSize() local _, s = self:GetBoundingBox() return s end
function methods:GetScale() return self.__props.__scale or 1 end
function methods:ScaleTo(s)
  local cur = self.__props.__scale or 1 local f = s / cur local pv = self:GetPivot()
  for _,p in ipairs(partsOf(self)) do local rel = pv:Inverse() * p.CFrame p.Size = p.Size * f p.CFrame = pv * cfMake(rel.Position * f, rel.__R) end
  self.__props.__scale = s
end
function methods:MoveTo(v) self:PivotTo(CFrame.new(v)) end
function methods:SetPrimaryPartCFrame(cf) self:PivotTo(cf) end
function methods:GetPrimaryPartCFrame() return self:GetPivot() end
-- Players: avatar rigs (R15 by default) with the 15 Motor6Ds the GFX pack poses
local function rigPart(parent, name, size, pos)
  local p = new("Part", name) p.Size = size p.CFrame = CFrame.new(pos) p.Parent = parent return p
end
local function motor(name, p0, p1, joint)
  local m = new("Motor6D", name) m.Part0 = p0 m.Part1 = p1 m.C0 = p0.CFrame:Inverse() * CFrame.new(joint) m.C1 = p1.CFrame:Inverse() * CFrame.new(joint) m.Parent = p1 return m
end
function M.buildRig(rigType, name, dynamicHead)
  local m = new("Model", name or "Dummy")
  local hum = new("Humanoid", "Humanoid") hum.Parent = m
  local r6 = rigType == Enum.HumanoidRigType.R6
  hum.RigType = r6 and Enum.HumanoidRigType.R6 or Enum.HumanoidRigType.R15
  local hrp = rigPart(m, "HumanoidRootPart", Vector3.new(2,2,1), Vector3.new(0,3.5,0)) hrp.Transparency = 1
  local head = rigPart(m, "Head", Vector3.new(1.2,1.2,1.2), Vector3.new(0,5.9,0))
  if dynamicHead then local fc = new("FaceControls", "FaceControls") fc.Parent = head else local d = new("Decal", "face") d.Texture = "rbxasset://textures/face.png" d.Parent = head end
  if r6 then
    local torso = rigPart(m, "Torso", Vector3.new(2,2,1), Vector3.new(0,3.5,0))
    local la = rigPart(m, "Left Arm", Vector3.new(1,2,1), Vector3.new(-1.5,3.5,0)) local ra = rigPart(m, "Right Arm", Vector3.new(1,2,1), Vector3.new(1.5,3.5,0))
    local ll = rigPart(m, "Left Leg", Vector3.new(1,2,1), Vector3.new(-0.5,1.5,0)) local rl = rigPart(m, "Right Leg", Vector3.new(1,2,1), Vector3.new(0.5,1.5,0))
    motor("RootJoint", hrp, torso, Vector3.new(0,3.5,0)) motor("Neck", torso, head, Vector3.new(0,4.5,0))
    motor("Left Shoulder", torso, la, Vector3.new(-1,4.5,0)) motor("Right Shoulder", torso, ra, Vector3.new(1,4.5,0))
    motor("Left Hip", torso, ll, Vector3.new(-0.5,2.5,0)) motor("Right Hip", torso, rl, Vector3.new(0.5,2.5,0))
  else
    local lower = rigPart(m, "LowerTorso", Vector3.new(2,0.4,1), Vector3.new(0,3.5,0))
    local upper = rigPart(m, "UpperTorso", Vector3.new(2,1.6,1), Vector3.new(0,4.5,0))
    motor("Root", hrp, lower, Vector3.new(0,3.5,0)) motor("Waist", lower, upper, Vector3.new(0,3.7,0)) motor("Neck", upper, head, Vector3.new(0,5.3,0))
    for _,side in ipairs({{"Left",-1},{"Right",1}}) do
      local n, sx = side[1], side[2]
      local ua = rigPart(m, n.."UpperArm", Vector3.new(1,1.4,1), Vector3.new(1.5*sx,4.6,0))
      local la = rigPart(m, n.."LowerArm", Vector3.new(1,1.2,1), Vector3.new(1.5*sx,3.4,0))
      local hand = rigPart(m, n.."Hand", Vector3.new(1,0.3,1), Vector3.new(1.5*sx,2.55,0))
      motor(n.."Shoulder", upper, ua, Vector3.new(1.0*sx,5.1,0)) motor(n.."Elbow", ua, la, Vector3.new(1.5*sx,4.0,0)) motor(n.."Wrist", la, hand, Vector3.new(1.5*sx,2.7,0))
      local ul = rigPart(m, n.."UpperLeg", Vector3.new(1,1.5,1), Vector3.new(0.5*sx,2.55,0))
      local ll = rigPart(m, n.."LowerLeg", Vector3.new(1,1.5,1), Vector3.new(0.5*sx,1.05,0))
      local foot = rigPart(m, n.."Foot", Vector3.new(1,0.3,1), Vector3.new(0.5*sx,0.15,0))
      motor(n.."Hip", lower, ul, Vector3.new(0.5*sx,3.3,0)) motor(n.."Knee", ul, ll, Vector3.new(0.5*sx,1.8,0)) motor(n.."Ankle", ll, foot, Vector3.new(0.5*sx,0.3,0))
    end
  end
  m.PrimaryPart = hrp
  return m
end
function methods:CreateHumanoidModelFromDescription(desc, rigType) return M.buildRig(rigType, "Dummy", false) end
function methods:CreateHumanoidModelFromUserId(uid) if uid == 404 then error("HTTP 404 (Not Found)") end local m = M.buildRig(Enum.HumanoidRigType.R15, "Player"..tostring(uid), true) return m end
function methods:GetUserIdFromNameAsync(name) if name == "Nobody" then error("Unknown user") end return 1 end
function methods:Set(list) M.selection = list end
function methods:Get() return M.selection or {} end
-- service-ish methods
function methods:GetService(name) return M.services[name] or error("unknown service "..tostring(name)) end
function methods:JSONEncode(v) return M.jsonEncode(v) end
function methods:JSONDecode(s) return M.jsonDecode(s) end
-- TweenService:GetValue with TweenService's own direction semantics (In = the style curve forward: slow start)
function methods:GetValue(alpha, style, direction)
  local a = math.max(0, math.min(1, tonumber(alpha) or 0))
  local sn = style and style.Name or "Linear"
  local function fwd(x)
    if sn == "Linear" then return x
    elseif sn == "Quad" then return x * x
    elseif sn == "Cubic" then return x * x * x
    elseif sn == "Quart" then return x * x * x * x
    elseif sn == "Quint" then return x * x * x * x * x
    elseif sn == "Sine" then return 1 - math.cos(x * math.pi / 2)
    elseif sn == "Back" then local c1 = 1.70158 return (c1 + 1) * x * x * x - c1 * x * x
    elseif sn == "Elastic" then if x == 0 or x == 1 then return x end return -math.pow(2, 10 * x - 10) * math.sin((x * 10 - 10.75) * (2 * math.pi) / 3)
    elseif sn == "Bounce" then local y = 1 - x local n1, d1 = 7.5625, 2.75 local r if y < 1 / d1 then r = n1 * y * y elseif y < 2 / d1 then y = y - 1.5 / d1 r = n1 * y * y + 0.75 elseif y < 2.5 / d1 then y = y - 2.25 / d1 r = n1 * y * y + 0.9375 else y = y - 2.625 / d1 r = n1 * y * y + 0.984375 end return 1 - r
    end
    return x
  end
  local dn = direction and direction.Name or "In"
  if dn == "Out" then return 1 - fwd(1 - a) end
  if dn == "InOut" then if a < 0.5 then return fwd(a * 2) / 2 end return 1 - fwd((1 - a) * 2) / 2 end
  return fwd(a)
end
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
function methods:GetPlayers() local out={} for i,p in ipairs(M.players or {}) do out[i]=p end return out end
M.players = {}
function methods:TryBeginRecording() return "rec" end
function methods:FinishRecording() end
function methods:RemoveDefaultLoadingScreen() end
function methods:PreloadAsync(list, cb) if cb then for _,a in ipairs(list) do cb(a, Enum.AssetFetchStatus.Success) end end end
function methods:IsLoaded() return true end
function methods:FireServer(...) M.fired[#M.fired+1]={self.__props.Name, ...} end
-- 1.78.0 art pack: EditableImage + CreateAssetAsync (AssetService) and TextService:GetTextSize
function methods:CreateEditableImage(opts) local e = new("EditableImage", "EditableImage") e.Size = (opts and opts.Size) or Vector2.new(512,512) e.__pixels = nil return e end
function methods:WritePixelsBuffer(pos, size, buf) self.__pixels = buf self.__pixelsSize = size M.pixelWrites = (M.pixelWrites or 0) + 1 end
function methods:DrawCircle() end
function methods:DrawLine() end
function methods:DrawRectangle() end
function methods:CreateAssetAsync(obj, assetType, opts)
  M.createdAssets = M.createdAssets or {}
  local id = 900000 + #M.createdAssets + 1
  M.createdAssets[#M.createdAssets+1] = {object=obj, assetType=assetType and assetType.Name or nil, name=opts and opts.Name or nil, id=id}
  if M.failCreateAsset then error("CreateAssetAsync is not permitted in this context") end
  return Enum.CreateAssetResult.Success, id
end
function methods:GetFreeDecals(query, page) M.decalQueries = M.decalQueries or {} M.decalQueries[#M.decalQueries+1] = {query=tostring(query), page=page} if M.failDecals then error("HttpError: Forbidden") end if tostring(query):find("nothing") then return {{Results={}}} end return {{Results={{AssetId=1234567, Name="Ornate divider "..tostring(query), CreatorName="sim"}, {AssetId=7654321, Name="Soft glow", CreatorName="sim"}}}} end
function methods:Play() self.IsPlaying = true self.Playing = true M.soundsPlayed = (M.soundsPlayed or 0) + 1 end
function methods:Stop() self.IsPlaying = false self.Playing = false end
function methods:GetTextSize(text, size, font, frame) return Vector2.new(#tostring(text) * size * 0.55, size) end
function methods:FireClient(plr, ...) M.fired[#M.fired+1]={self.__props.Name, plr and plr.Name or "?", ...} end
function methods:FireAllClients(...) M.fired[#M.fired+1]={self.__props.Name, "all", ...} end
function methods:Fire(...) M.fired[#M.fired+1]={self.__props.Name, ...} if self.Event then self.Event:Fire(...) end end
function methods:InvokeServer(...) if self.OnServerInvoke then return self.OnServerInvoke(M.fakePlayer, ...) end return nil end
function methods:FindFirstChildOfClassOrNil() return nil end
function methods:FindFirstAncestorOfClass(cls) local p=self.__props.Parent while p do if p.__class==cls then return p end p=p.__props.Parent end return nil end
function methods:FindFirstAncestor(name) local p=self.__props.Parent while p do if p.__props.Name==name then return p end p=p.__props.Parent end return nil end
function methods:IsAncestorOf(d) return d:IsDescendantOf(self) end
function methods:IsServer() return true end
function methods:IsClient() return M.isEdit end
function methods:GetPlayerFromCharacter(model) if M.fakePlayer and model==M.fakePlayer.Character then return M.fakePlayer end for _,p in ipairs(M.players or {}) do if p.Character==model then return p end end return nil end
function methods:GetPlayerByUserId(uid) if M.fakePlayer and M.fakePlayer.UserId==uid then return M.fakePlayer end for _,p in ipairs(M.players or {}) do if p.UserId==uid then return p end end return nil end
function methods:GetNameFromUserIdAsync(uid) return "User"..tostring(uid) end
function methods:BindToClose(fn) M.closeHandlers[#M.closeHandlers+1]=fn end
M.closeHandlers = {}
function methods:TakeDamage(n) self.Health = math.max(0, (self.Health or 100) - n) if self.Health <= 0 and self.__signals.Died then self.__signals.Died:Fire() end end
function methods:LoadCharacter() M.loads = (M.loads or 0) + 1 end
function methods:Kick(reason) M.kicked[#M.kicked+1] = {self.__props.Name, reason} end
M.kicked = {}
function methods:GetRankInGroup() return 0 end
function methods:IsInGroup() return false end
function methods:AddItem(inst, t) M.debris[#M.debris+1] = {inst, t} end
M.debris = {}
function methods:GetPartBoundsInBox(cf, size, params) local out={} local half=size*0.5 for _,p in ipairs(M.services.Workspace:GetDescendants()) do if isa(p.__class,"BasePart") then local rel=cf:Inverse()*p.CFrame.Position if math.abs(rel.X)<=half.X and math.abs(rel.Y)<=half.Y and math.abs(rel.Z)<=half.Z then local skip=false if params and params.FilterDescendantsInstances then for _,f in ipairs(params.FilterDescendantsInstances) do if p==f or p:IsDescendantOf(f) then skip=true end end end if not skip then out[#out+1]=p end end end end return out end
function methods:GetPartsInPart() return {} end
function methods:UserOwnsGamePassAsync() return false end
function methods:PromptGamePassPurchase() M.prompts[#M.prompts+1]="gamepass" end
function methods:PromptProductPurchase() M.prompts[#M.prompts+1]="product" end
M.prompts = {}
function methods:SetCore(name, data) M.cores[#M.cores+1] = {name, data} end
M.cores = {}
function methods:GenerateGUID() M.guid = (M.guid or 0) + 1 return "guid-"..M.guid end
function methods:BindAction() end
function methods:UnbindAction() end
function methods:SetTitle() end
function methods:SetPosition() end
function methods:LoadAnimation() return {Play=function() end, Stop=function() end} end
function methods:GetOrderedDataStore(name)
  M.ordered[name] = M.ordered[name] or {}
  local data = M.ordered[name]
  return {SetAsync=function(_, key, v) data[key] = v end, GetAsync=function(_, key) return data[key] end, UpdateAsync=function(_, key, fn) data[key] = fn(data[key]) return data[key] end,
    GetSortedAsync=function(_, asc, n) local rows={} for k,v in pairs(data) do rows[#rows+1]={key=k,value=v} end table.sort(rows, function(a,b) if asc then return a.value<b.value end return a.value>b.value end) local page={} for i=1,math.min(n or 10,#rows) do page[i]=rows[i] end return {GetCurrentPage=function() return page end, IsFinished=true, AdvanceToNextPageAsync=function() end} end}
end
M.ordered = {}
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
  if o.__class == "Pose" and k == "CFrame" then return CFrame.new() end
  if isa(o.__class, "BasePart") then
    if k == "Size" then return PART_DEFAULTS.Size() end
    if k == "CFrame" then return PART_DEFAULTS.CFrame() end
    if k == "Position" then return o.CFrame.Position end
    if k == "Orientation" then local rx,ry,rz = o.CFrame:ToOrientation() return Vector3.new(math.deg(rx),math.deg(ry),math.deg(rz)) end
  end
  if o.__class == "Camera" and k == "CFrame" then return CFrame.new(0,10,20) end
  if o.__class == "Camera" and k == "Focus" then return CFrame.new() end
  if o.__class == "Model" and k == "PrimaryPart" then return nil end
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
  if isa(o.__class, "BasePart") or o.__class == "Camera" then
    if k == "Size" and getmetatable(v) ~= Vector3 then error("BasePart.Size must be a Vector3 (got " .. type(v) .. ")") end
    if (k == "CFrame" or k == "Focus") and getmetatable(v) ~= CFrame then error(k .. " must be a CFrame (got " .. type(v) .. ")") end
    if k == "Position" then if getmetatable(v) ~= Vector3 then error("BasePart.Position must be a Vector3") end local cf = o.CFrame o.__props.CFrame = cfMake(v, cf.__R) return end
    if k == "Color" and getmetatable(v) ~= Color3 then error("BasePart.Color must be a Color3") end
  elseif isa(o.__class, "GuiBase2d") or isa(o.__class, "UIBase") then
    if (k == "Size" or k == "Position" or k == "CellSize" or k == "CanvasSize") and getmetatable(v) ~= UDim2 then error(k .. " must be a UDim2 (got " .. type(v) .. ")") end
    if (k == "BackgroundColor3" or k == "TextColor3" or k == "ImageColor3" or k == "Color" and o.__class ~= "UIGradient") and getmetatable(v) ~= Color3 then error(k .. " must be a Color3 on " .. o.__class) end
  end
  if isa(o.__class, "Light") and k == "Color" and getmetatable(v) ~= Color3 then error("Light.Color must be a Color3") end
  if o.__class == "ParticleEmitter" and k == "Color" and (type(v) ~= "table" or v.Keypoints == nil) then error("ParticleEmitter.Color must be a ColorSequence") end
  if (k == "C0" or k == "C1" or k == "Transform" or k == "WorldPivot" or k == "PivotOffset") and getmetatable(v) ~= CFrame then error(k .. " must be a CFrame") end
  if k == "Lifetime" or k == "Speed" or k == "RotSpeed" then if type(v) ~= "table" or v.Min == nil then error(k .. " must be a NumberRange") end end
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
game.CreatorType = Enum.CreatorType.User game.CreatorId = 1 game.PlaceId = 12345 game.JobId = "job" game.PrivateServerId = ""
M.services = {}
local function service(name, class) local s = new(class or "Service", name) s.Parent = game M.services[name] = s return s end
local workspace = service("Workspace")
local cam = new("Camera", "Camera") cam.ViewportSize = Vector2.new(1280,720) cam.CFrame = CFrame.new(0,10,20) cam.FieldOfView = 70 cam.Parent = workspace workspace.CurrentCamera = cam
service("Lighting") service("Selection") service("CollectionService") service("StarterPack") service("Teams") service("Chat") service("TextService") service("MarketplaceService") service("Debris")
M.selection = {}
local ReplicatedStorage = service("ReplicatedStorage")
service("ReplicatedFirst") service("ServerScriptService") service("DataStoreService") service("ServerStorage") service("StarterGui") service("StarterPlayer") service("SoundService") service("ContentProvider")
local HttpService = service("HttpService")
service("AssetService")
local TweenService = service("TweenService")
local RunService = service("RunService")
local UIS = service("UserInputService") UIS.TouchEnabled = false UIS.KeyboardEnabled = true UIS.GamepadEnabled = false
local GuiService = service("GuiService")
local Players = service("Players")
service("ChangeHistoryService")
-- Services the x200/x100 preludes fetch up front; plain Service instances so a
-- program that merely names them does not abort before its own logic runs.
service("PathfindingService") service("PhysicsService") service("BadgeService") service("TeleportService") service("MessagingService") service("MemoryStoreService") service("TextChatService") service("ProximityPromptService") service("ContextActionService") service("LogService") service("Stats") service("VirtualInputManager") service("InsertService") service("AssetService") service("MaterialService") service("LocalizationService") service("PolicyService") service("SocialService") service("VoiceChatService") service("AvatarEditorService")
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
_G.Vector3 = Vector3
_G.CFrame = CFrame
_G.NumberRange = {new = NumberRange_new}
_G.NumberSequenceKeypoint = {new = NumberSequenceKeypoint_new}
_G.ColorSequenceKeypoint = {new = ColorSequenceKeypoint_new}
_G.UDim = UDim
_G.UDim2 = UDim2
_G.ColorSequence = {new = ColorSequence_new}
_G.NumberSequence = {new = NumberSequence_new}
_G.TweenInfo = {new = TweenInfo_new}
_G.Rect = {new = Rect_new}
_G.Enum = Enum
_G.typeof = function(v) if type(v)=="table" and rawget(v,"__class") then return "Instance" end local mt=getmetatable(v) if mt==Color3 then return "Color3" elseif mt==Vector2 then return "Vector2" elseif mt==Vector3 then return "Vector3" elseif mt==CFrame then return "CFrame" elseif mt==UDim2 then return "UDim2" elseif mt==UDim then return "UDim" elseif type(v)=="table" and v.EnumType then return "EnumItem" end return type(v) end
_G.require = runModule
_G.loadstring = function(src) return load(src, "=loadstring", "t", setmetatable({}, {__index=_G})) end
_G.getfenv = function() return _G end
_G.setfenv = function(f, env) local i=1 while true do local name=debug.getupvalue(f,i) if not name then break end if name=="_ENV" then debug.setupvalue(f,i,env) break end i=i+1 end return f end
-- task.spawn/defer run the function as a coroutine: the first task.wait() inside it yields and the
-- thread is parked forever (background loops such as tip rotation or polling feeds). On the main
-- thread task.wait() returns immediately, with a budget so an accidental busy loop is reported.
local function runThread(f, ...)
  local co = type(f) == "thread" and f or coroutine.create(f)
  local okR, err = coroutine.resume(co, ...)
  if not okR then error(err, 0) end
end
_G.task = {spawn=function(f, ...) runThread(f, ...) return f end, defer=runThread, cancel=function() end, delay=function(t,f,...) M.delayed[#M.delayed+1]={f=f,args={...}} end,
  wait=function(t) if coroutine.isyieldable() then coroutine.yield() return t or 0 end M.waits=M.waits+1 if M.waits>200 then error("simulated wait budget exceeded (infinite loop?)") end return t or 0 end}
M.delayed = {}
M.waits = 0
_G.tick = os.clock
_G.Random = {new = function(seed) local st = seed or os.time() local function nxt() st = (st * 1103515245 + 12345) % 2147483648 return st / 2147483648 end return {NextNumber=function(_, a, b) local r = nxt() if a == nil then return r end return a + (b - a) * r end, NextInteger=function(_, a, b) return a + math.floor(nxt() * (b - a + 1)) end} end}
_G.OverlapParams = {new = function() return {FilterDescendantsInstances = {}, FilterType = nil, MaxParts = 0} end}
_G.RaycastParams = {new = function() return {FilterDescendantsInstances = {}} end}
_G.utf8 = utf8
-- 1.78.0: Font / buffer / Content for the art pack (data-only stand-ins)
_G.Font = {
  new = function(family, weight, style) return {Family=family, Weight=weight or Enum.FontWeight.Regular, Style=style or Enum.FontStyle.Normal, __font=true} end,
  fromEnum = function(e) return {Family="rbxasset://fonts/families/"..tostring(e.Name)..".json", Weight=Enum.FontWeight.Regular, Style=Enum.FontStyle.Normal, __font=true} end,
  fromName = function(name, weight, style) return {Family="rbxasset://fonts/families/"..tostring(name)..".json", Weight=weight or Enum.FontWeight.Regular, Style=style or Enum.FontStyle.Normal, __font=true} end,
  fromId = function(id, weight, style) return {Family="rbxassetid://"..tostring(id), Weight=weight or Enum.FontWeight.Regular, Style=style or Enum.FontStyle.Normal, __font=true} end,
}
_G.buffer = {
  create = function(n) return {__n=n, __b={}} end,
  len = function(b) return b.__n end,
  writeu8 = function(b, o, v) if o < 0 or o >= b.__n then error("buffer access out of bounds") end b.__b[o] = math.floor(v) % 256 end,
  readu8 = function(b, o) if o < 0 or o >= b.__n then error("buffer access out of bounds") end return b.__b[o] or 0 end,
  fill = function(b, o, v, n) for i = o, o + (n or (b.__n - o)) - 1 do b.__b[i] = v end end,
}
_G.Content = { fromObject = function(o) return {Object=o, SourceType="Object", __content=true} end, fromAssetId = function(id) return {Uri="rbxassetid://"..tostring(id), SourceType="Uri", __content=true} end, fromUri = function(u) return {Uri=u, SourceType="Uri", __content=true} end, none = {SourceType="None", __content=true} }
string.split = function(s, sep) local out={} for piece in (s..sep):gmatch("(.-)"..sep:gsub("%p","%%%0")) do out[#out+1]=piece end return out end
math.clamp = function(v,a,b) return math.max(a, math.min(b, v)) end
math.round = math.round or function(x) if x >= 0 then return math.floor(x + 0.5) end return math.ceil(x - 0.5) end
_G.warn = function(...) M.warnings[#M.warnings+1]=table.concat({...}," ") end
M.warnings = {}
_G.print = function(...) M.prints[#M.prints+1]=table.concat({...}," ") end
M.prints = {}
return M
"""


def make_runtime():
    """Create a LuaRuntime with the DataModel loaded and JSON bridged to Python.

    Returns (L, M, run_program) where run_program(key, code) executes a generated
    program and returns the decoded JSON result dict (or {"ok": False, "error": ...}).
    """
    from lupa import LuaRuntime
    L = LuaRuntime(unpack_returned_tuples=True)
    M = L.execute(ROBLOX)

    def lua_to_py(v, depth=0):
        if hasattr(v, "items") and hasattr(v, "keys"):
            if depth > 40:
                raise ValueError("JSONEncode: table nesting too deep (cycle?)")
            keys = list(v.keys())
            if not keys:
                return []  # Roblox encodes an empty table as []
            if "__class" in keys:
                raise ValueError("JSONEncode: cannot encode an Instance (" + str(v["__props"]["Name"]) + ") - Roblox would error too")
            if "__R" in keys:
                raise ValueError("JSONEncode: cannot encode a CFrame - Roblox would error too")
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
    M.lua_to_py = lua_to_py
    M.py_to_lua = py_to_lua

    def run_program(key, code):
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

    return L, M, run_program
