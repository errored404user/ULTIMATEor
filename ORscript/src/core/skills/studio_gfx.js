// ORscript — Thumbnail & Icon Studio (GFX pack, 1.30.0)
//
// ForgeGUI sells static thumbnail *images*. This pack stages the real thing inside
// Roblox Studio - a cyclorama stage far from the map, a 3-point light rig, posed
// characters with expressive faces, props, particle beats, a title overlay with
// 16:9 / 1:1 guides and a cinematic / cartoony / horror / neon / clean / chroma
// post stack - then `gfx_capture` photographs the viewport through the Studio MCP,
// crops it to the aspect box and hands back a finished 1920x1080 thumbnail or
// 512x512 icon PNG (downloaded + attached to the chat). `gfx_brief` writes the
// art-director brief / image-generation prompt for providers that can paint.
//
//   gfx_stage_create     cyclorama + light rig + style lighting (+ camera)
//   gfx_subject_add      dummy / player avatar / existing model onto the stage, posed
//   gfx_pose             pose an R15/R6 rig (hero, point, jump, wave, scared, victory...) + face
//   gfx_prop_add         clone a prop (sword, chest, pet) onto a slot, optionally floating
//   gfx_camera           frame the subjects: hero_low, three_quarter, front, closeup, dutch, wide, icon
//   gfx_overlay          title / subtitle / badge / logo + aspect guides (edit-mode ScreenGui)
//   gfx_fx               sparkles, embers, smoke, confetti, snow, magic, rays
//   gfx_lighting         re-style or fine-tune the post stack (bloom, saturation, DOF, fog)
//   gfx_capture          prepare + photograph + crop -> PNG (composite in main.js)
//   gfx_brief            art-director brief + image-gen prompt + CTR checklist
//   gfx_teardown         restore Lighting / camera, remove overlay and stage
(() => {
  if (typeof RobloxScriptSkills === "undefined") return;
  const GFX_VERSION = "1.30.0";

  const q = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "").replace(/\n/g, "\\n") + "'";
  const jj = (o) => q(JSON.stringify(o));
  const nn = (v, d) => (isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);

  // ───────────────────────── styles ─────────────────────────
  const STYLES = {
    cinematic: { backdrop: [18, 18, 24], floor: [24, 24, 30], key: [255, 236, 210], fill: [180, 190, 220], rim: [120, 160, 255], accent: [255, 196, 64], title: [255, 255, 255], gradient: [[255, 255, 255], [201, 214, 255]], stroke: [0, 0, 0], font: "Michroma", rotation: 0, material: "SmoothPlastic" },
    cartoony: { backdrop: [90, 200, 255], floor: [120, 215, 255], key: [255, 255, 240], fill: [255, 230, 240], rim: [255, 180, 220], accent: [255, 92, 150], title: [255, 242, 59], gradient: [[255, 246, 168], [255, 159, 26]], stroke: [58, 29, 0], font: "FredokaOne", rotation: -4, material: "SmoothPlastic" },
    horror: { backdrop: [8, 8, 12], floor: [14, 12, 16], key: [180, 200, 255], fill: [60, 70, 90], rim: [200, 30, 30], accent: [200, 30, 30], title: [229, 229, 229], gradient: [[255, 255, 255], [139, 0, 0]], stroke: [0, 0, 0], font: "Creepster", rotation: 2, material: "Slate" },
    neon: { backdrop: [12, 4, 30], floor: [18, 8, 40], key: [0, 255, 230], fill: [120, 60, 255], rim: [255, 0, 200], accent: [0, 255, 225], title: [0, 255, 225], gradient: [[0, 255, 225], [255, 0, 200]], stroke: [11, 0, 48], font: "Arcade", rotation: 0, material: "SmoothPlastic" },
    clean: { backdrop: [235, 235, 240], floor: [235, 235, 240], key: [255, 255, 255], fill: [255, 255, 255], rim: [255, 255, 255], accent: [40, 90, 255], title: [17, 17, 17], gradient: [[17, 17, 17], [60, 60, 70]], stroke: [255, 255, 255], font: "GothamBlack", rotation: 0, material: "SmoothPlastic" },
    chroma: { backdrop: [0, 255, 0], floor: [0, 255, 0], key: [255, 255, 255], fill: [255, 255, 255], rim: [255, 255, 255], accent: [255, 255, 255], title: [255, 255, 255], gradient: [[255, 255, 255], [255, 255, 255]], stroke: [0, 0, 0], font: "GothamBlack", rotation: 0, material: "SmoothPlastic" },
  };
  const STYLE_NAMES = Object.keys(STYLES);
  const styleOf = (s) => (STYLES[String(s || "").toLowerCase()] ? String(s).toLowerCase() : "cinematic");

  // Lighting recipes per style (numbers only; colours as [r,g,b]).
  const LIGHTING = {
    cinematic: { ClockTime: 17.4, Brightness: 2, Ambient: [40, 40, 50], OutdoorAmbient: [70, 70, 85], ExposureCompensation: 0.15, GlobalShadows: true, ShadowSoftness: 0.2, FogEnd: 100000, effects: { Bloom: { Intensity: 0.6, Size: 32, Threshold: 0.9 }, ColorCorrection: { Contrast: 0.18, Saturation: 0.08, TintColor: [255, 245, 235] }, DepthOfField: { FarIntensity: 0.25, InFocusRadius: 14, NearIntensity: 0.3 }, Atmosphere: { Density: 0.25, Haze: 1, Glare: 0.2, Color: [199, 170, 107] }, SunRays: { Intensity: 0.08, Spread: 0.6 } } },
    cartoony: { ClockTime: 13, Brightness: 3, Ambient: [120, 120, 120], OutdoorAmbient: [150, 150, 150], ExposureCompensation: 0.35, GlobalShadows: true, ShadowSoftness: 0.5, FogEnd: 100000, effects: { Bloom: { Intensity: 0.35, Size: 24, Threshold: 1.2 }, ColorCorrection: { Contrast: 0.1, Saturation: 0.4, Brightness: 0.03 }, SunRays: { Intensity: 0.12, Spread: 0.8 } } },
    horror: { ClockTime: 0.5, Brightness: 0.6, Ambient: [10, 10, 20], OutdoorAmbient: [20, 20, 35], ExposureCompensation: -0.4, GlobalShadows: true, ShadowSoftness: 0.1, FogStart: 0, FogColor: [10, 10, 15], fogByStage: 2.2, effects: { Bloom: { Intensity: 0.3, Size: 48, Threshold: 0.7 }, ColorCorrection: { Contrast: 0.3, Saturation: -0.5, TintColor: [170, 190, 230] }, Atmosphere: { Density: 0.5, Haze: 3, Glare: 0, Color: [70, 80, 100] } } },
    neon: { ClockTime: 0, Brightness: 0.4, Ambient: [10, 0, 25], OutdoorAmbient: [20, 5, 40], ExposureCompensation: 0.1, GlobalShadows: true, ShadowSoftness: 0.3, FogEnd: 100000, effects: { Bloom: { Intensity: 1.2, Size: 56, Threshold: 0.6 }, ColorCorrection: { Contrast: 0.25, Saturation: 0.3, TintColor: [220, 200, 255] }, Atmosphere: { Density: 0.35, Haze: 2, Glare: 0.6, Color: [120, 40, 200] } } },
    clean: { ClockTime: 12, Brightness: 2.5, Ambient: [140, 140, 140], OutdoorAmbient: [180, 180, 180], ExposureCompensation: 0.2, GlobalShadows: true, ShadowSoftness: 0.8, FogEnd: 100000, effects: { ColorCorrection: { Contrast: 0.05, Saturation: 0.05 } } },
    chroma: { ClockTime: 12, Brightness: 1.5, Ambient: [200, 200, 200], OutdoorAmbient: [200, 200, 200], ExposureCompensation: 0, GlobalShadows: false, ShadowSoftness: 1, FogEnd: 100000, effects: {} },
  };

  // R15 poses: joint -> [x, y, z] degrees applied as C0 * CFrame.Angles. lift = studs.
  const POSES = {
    idle: { joints: {}, lift: 0 },
    hero: { joints: { RightShoulder: [20, 0, 18], LeftShoulder: [20, 0, -18], RightElbow: [30, 0, 0], LeftElbow: [30, 0, 0], Neck: [-6, 0, 0], RightHip: [0, 0, 8], LeftHip: [0, 0, -8], Waist: [-3, 0, 0] }, lift: 0 },
    point: { joints: { RightShoulder: [85, 0, 10], RightElbow: [5, 0, 0], LeftShoulder: [12, 0, -12], LeftElbow: [20, 0, 0], Neck: [0, -8, 0], Waist: [0, -10, 0] }, lift: 0 },
    jump: { joints: { RightShoulder: [160, 0, 25], LeftShoulder: [160, 0, -25], RightElbow: [-15, 0, 0], LeftElbow: [-15, 0, 0], RightHip: [35, 0, 10], RightKnee: [-70, 0, 0], LeftHip: [-20, 0, -10], LeftKnee: [-35, 0, 0], Waist: [6, 0, 0], Neck: [-10, 0, 0] }, lift: 2.5 },
    wave: { joints: { RightShoulder: [172, 0, 20], RightElbow: [-25, 0, 25], LeftShoulder: [8, 0, -8], Neck: [0, 10, -6] }, lift: 0 },
    scared: { joints: { RightShoulder: [110, 0, 28], LeftShoulder: [110, 0, -28], RightElbow: [-65, 0, 0], LeftElbow: [-65, 0, 0], Neck: [12, 0, 0], Waist: [-12, 0, 0], RightHip: [-10, 0, 10], LeftHip: [10, 0, -10] }, lift: 0 },
    victory: { joints: { RightShoulder: [170, 0, 28], LeftShoulder: [170, 0, -28], RightElbow: [-10, 0, 0], LeftElbow: [-10, 0, 0], Neck: [-16, 0, 0], Waist: [-4, 0, 0] }, lift: 0 },
    run: { joints: { RightShoulder: [60, 0, 6], LeftShoulder: [-50, 0, -6], RightElbow: [60, 0, 0], LeftElbow: [60, 0, 0], RightHip: [-50, 0, 0], LeftHip: [40, 0, 0], RightKnee: [-20, 0, 0], LeftKnee: [-70, 0, 0], Waist: [14, 0, 0], Neck: [-10, 0, 0] }, lift: 0.6 },
    think: { joints: { RightShoulder: [60, 0, 6], RightElbow: [120, 0, 0], LeftShoulder: [10, 0, -6], Neck: [6, 12, 0], Waist: [2, 0, 0] }, lift: 0 },
    sit: { joints: { RightHip: [90, 0, 4], LeftHip: [90, 0, -4], RightKnee: [-90, 0, 0], LeftKnee: [-90, 0, 0], RightShoulder: [30, 0, 8], LeftShoulder: [30, 0, -8] }, lift: -1.6 },
    dab: { joints: { RightShoulder: [120, 0, -45], RightElbow: [-60, 0, 0], LeftShoulder: [70, 0, -70], Neck: [12, 20, 28], Waist: [0, 0, 14] }, lift: 0 },
    fight: { joints: { RightShoulder: [70, 0, 15], RightElbow: [110, 0, 0], LeftShoulder: [60, 0, -10], LeftElbow: [100, 0, 0], Waist: [0, 24, 0], RightHip: [-8, 0, 12], LeftHip: [8, 0, -12], Neck: [4, -12, 0] }, lift: 0 },
    crossed_arms: { joints: { RightShoulder: [80, 0, -28], RightElbow: [85, 0, 0], LeftShoulder: [80, 0, 28], LeftElbow: [85, 0, 0], Neck: [-4, 0, 0], RightHip: [0, 0, 6], LeftHip: [0, 0, -6] }, lift: 0 },
  };
  const POSE_NAMES = Object.keys(POSES);

  // FaceControls presets (dynamic heads). Classic decal heads use face_id.
  const FACES = {
    neutral: {},
    happy: { LeftCheekRaiser: 1, RightCheekRaiser: 1, LeftLipCornerPuller: 1, RightLipCornerPuller: 1, LeftEyeClosed: 0.2, RightEyeClosed: 0.2, LeftOuterBrowRaiser: 0.3, RightOuterBrowRaiser: 0.3, JawDrop: 0.25 },
    shocked: { JawDrop: 0.85, LeftInnerBrowRaiser: 1, RightInnerBrowRaiser: 1, LeftOuterBrowRaiser: 1, RightOuterBrowRaiser: 1, LeftEyeUpperLidRaiser: 1, RightEyeUpperLidRaiser: 1, Funneler: 0.4 },
    angry: { LeftBrowLowerer: 1, RightBrowLowerer: 1, LeftNoseWrinkler: 0.5, RightNoseWrinkler: 0.5, LeftLipCornerDown: 0.6, RightLipCornerDown: 0.6, JawDrop: 0.3, LeftUpperLipRaiser: 0.5, RightUpperLipRaiser: 0.5, Corrugator: 0.8 },
    scared: { JawDrop: 0.6, LeftInnerBrowRaiser: 1, RightInnerBrowRaiser: 1, LeftEyeUpperLidRaiser: 1, RightEyeUpperLidRaiser: 1, LeftLipStretcher: 0.8, RightLipStretcher: 0.8 },
    smirk: { RightLipCornerPuller: 1, RightCheekRaiser: 0.6, LeftBrowLowerer: 0.3, RightOuterBrowRaiser: 0.5, RightDimpler: 0.5 },
    determined: { LeftBrowLowerer: 0.7, RightBrowLowerer: 0.7, LipsTogether: 1, LipPresser: 0.5, LeftEyeClosed: 0.1, RightEyeClosed: 0.1 },
    laughing: { JawDrop: 0.7, LeftCheekRaiser: 1, RightCheekRaiser: 1, LeftLipCornerPuller: 1, RightLipCornerPuller: 1, LeftEyeClosed: 0.7, RightEyeClosed: 0.7 },
    wink: { LeftEyeClosed: 1, RightLipCornerPuller: 0.8, RightCheekRaiser: 0.5 },
  };
  const FACE_NAMES = Object.keys(FACES);
  const FACE_PROPS = ["ChinRaiser", "ChinRaiserUpperLip", "Corrugator", "EyesLookDown", "EyesLookLeft", "EyesLookRight", "EyesLookUp", "FlatPucker", "Funneler", "JawDrop", "JawLeft", "JawRight", "LeftBrowLowerer", "LeftCheekPuff", "LeftCheekRaiser", "LeftDimpler", "LeftEyeClosed", "LeftEyeUpperLidRaiser", "LeftInnerBrowRaiser", "LeftLipCornerDown", "LeftLipCornerPuller", "LeftLipStretcher", "LeftLowerLipDepressor", "LeftNoseWrinkler", "LeftOuterBrowRaiser", "LeftUpperLipRaiser", "LipPresser", "LipsTogether", "LowerLipSuck", "MouthLeft", "MouthRight", "Pucker", "RightBrowLowerer", "RightCheekPuff", "RightCheekRaiser", "RightDimpler", "RightEyeClosed", "RightEyeUpperLidRaiser", "RightInnerBrowRaiser", "RightLipCornerDown", "RightLipCornerPuller", "RightLipStretcher", "RightLowerLipDepressor", "RightNoseWrinkler", "RightOuterBrowRaiser", "RightUpperLipRaiser", "TongueDown", "TongueOut", "TongueUp", "UpperLipSuck"];

  const CAMERAS = {
    hero_low: { pitch: 12, yaw: -25, dist: 1.15, bias: 0.05, roll: 0, fov: 50 },
    three_quarter: { pitch: -12, yaw: 35, dist: 1.2, bias: 0.1, roll: 0, fov: 55 },
    front: { pitch: -4, yaw: 0, dist: 1.1, bias: 0.1, roll: 0, fov: 50 },
    closeup: { pitch: 0, yaw: -15, dist: 0.55, bias: 0.35, roll: 0, fov: 40 },
    top_down: { pitch: -55, yaw: 20, dist: 1.3, bias: 0, roll: 0, fov: 60 },
    dutch: { pitch: 5, yaw: -30, dist: 1.1, bias: 0.1, roll: 12, fov: 55 },
    wide: { pitch: -8, yaw: 15, dist: 2.0, bias: 0.1, roll: 0, fov: 65 },
    icon: { pitch: -6, yaw: -20, dist: 1.0, bias: 0.15, roll: 0, fov: 35 },
  };
  const CAMERA_NAMES = Object.keys(CAMERAS);

  const FX = {
    sparkles: { Texture: "rbxasset://textures/particles/sparkles_main.dds", Rate: 40, Lifetime: [1, 2.2], Speed: [1, 3], Size: [0.3, 0.9], LightEmission: 1, colors: [[255, 255, 255], [255, 220, 120]], Acceleration: [0, 1, 0], Drag: 1, Rotation: [0, 360], RotSpeed: [-60, 60] },
    embers: { Texture: "rbxasset://textures/particles/fire_main.dds", Rate: 30, Lifetime: [1.5, 3], Speed: [2, 5], Size: [0.2, 0.6], LightEmission: 1, colors: [[255, 170, 60], [255, 60, 0]], Acceleration: [0, 4, 0], Drag: 0.5, Rotation: [0, 360], RotSpeed: [-90, 90] },
    smoke: { Texture: "rbxasset://textures/particles/smoke_main.dds", Rate: 8, Lifetime: [4, 7], Speed: [0.5, 1.5], Size: [6, 14], LightEmission: 0, colors: [[120, 120, 130], [60, 60, 70]], Acceleration: [0, 0.4, 0], Drag: 0.2, Rotation: [0, 360], RotSpeed: [-10, 10], Transparency: [0.6, 1] },
    confetti: { Texture: "rbxasset://textures/particles/sparkles_main.dds", Rate: 60, Lifetime: [2, 4], Speed: [4, 9], Size: [0.25, 0.5], LightEmission: 0.4, colors: [[255, 80, 120], [80, 200, 255], [255, 230, 80]], Acceleration: [0, -6, 0], Drag: 1.5, Rotation: [0, 360], RotSpeed: [-200, 200] },
    snow: { Texture: "rbxasset://textures/particles/smoke_main.dds", Rate: 50, Lifetime: [4, 7], Speed: [1, 2], Size: [0.2, 0.5], LightEmission: 0.6, colors: [[255, 255, 255], [220, 235, 255]], Acceleration: [0, -1.5, 0], Drag: 0.3, Rotation: [0, 360], RotSpeed: [-20, 20], fromTop: true },
    magic: { Texture: "rbxasset://textures/particles/sparkles_main.dds", Rate: 50, Lifetime: [1, 2.5], Speed: [2, 4], Size: [0.2, 0.7], LightEmission: 1, colors: [[120, 220, 255], [200, 80, 255]], Acceleration: [0, 2, 0], Drag: 2, Rotation: [0, 360], RotSpeed: [-120, 120] },
    rays: { sunrays: true },
  };
  const FX_NAMES = Object.keys(FX);

  // ───────────────────────── Luau head ─────────────────────────
  const HEAD = `local HttpService=game:GetService('HttpService')
local Lighting=game:GetService('Lighting')
local Players=game:GetService('Players')
local StarterGui=game:GetService('StarterGui')
local ReplicatedStorage=game:GetService('ReplicatedStorage')
local Selection=game:GetService('Selection')
local ChangeHistoryService=game:GetService('ChangeHistoryService')
local Workspace=game:GetService('Workspace')
local GFX_VERSION=${q(GFX_VERSION)}
local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end
local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end
local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end if lp=='workspace' then return Workspace end local n=game for _,seg in ipairs(string.split(p,'.')) do if seg~='' then local nx=nil if n==game then local okS,s=pcall(function() return game:GetService(seg) end) if okS and s then nx=s end end if not nx then nx=n:FindFirstChild(seg) end if not nx then return nil end n=nx end end return n end
local function need(p,what) local i=resolve(p) if not i then error((what or 'instance')..' not found: '..tostring(p)) end return i end
local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('ORscript GFX') end) return okW and w or nil end
local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end
local function folder(parent,name) local f=parent:FindFirstChild(name) if not f then f=Instance.new('Folder') f.Name=name f.Parent=parent end return f end
local function c3(v) if typeof(v)=='Color3' then return v end if type(v)=='table' then return Color3.fromRGB(tonumber(v[1]) or 0,tonumber(v[2]) or 0,tonumber(v[3]) or 0) end if type(v)=='string' then local h=v:gsub('#','') if #h==6 then return Color3.fromRGB(tonumber(h:sub(1,2),16) or 0,tonumber(h:sub(3,4),16) or 0,tonumber(h:sub(5,6),16) or 0) end end return nil end
local function setProps(inst,props) for k,v in pairs(props or {}) do pcall(function() inst[k]=v end) end end
local function gfxRoot() local r=Workspace:FindFirstChild('OR_GFX') if not r then r=Instance.new('Folder') r.Name='OR_GFX' r.Parent=Workspace r:SetAttribute('OR_Version',GFX_VERSION) end return r end
local function findStage() local r=Workspace:FindFirstChild('OR_GFX') local s=r and r:FindFirstChild('Stage') return r,s end
local function needStage() local r,s=findStage() if not (r and s) then error('no GFX stage - run gfx_stage_create first') end return r,s end
local function stageOrigin(s) return s:GetPivot().Position end
local function stageSize(s) return tonumber(s:GetAttribute('Size')) or 120 end
local function stageAspect(s) return tonumber(s:GetAttribute('Aspect')) or (16/9) end
local SNAP_KEYS={'ClockTime','Brightness','Ambient','OutdoorAmbient','FogEnd','FogStart','FogColor','ExposureCompensation','GlobalShadows','EnvironmentDiffuseScale','EnvironmentSpecularScale','ShadowSoftness'}
local function snapshotLighting(r) if r:GetAttribute('HasSnapshot') then return end for _,k in ipairs(SNAP_KEYS) do pcall(function() r:SetAttribute('Snap_'..k,Lighting[k]) end) end r:SetAttribute('HasSnapshot',true) end
local function restoreLighting(r) if not r:GetAttribute('HasSnapshot') then return false end for _,k in ipairs(SNAP_KEYS) do local v=r:GetAttribute('Snap_'..k) if v~=nil then pcall(function() Lighting[k]=v end) end end return true end
local function clearGfxEffects() local n=0 for _,e in ipairs(Lighting:GetChildren()) do if e:GetAttribute('OR_GFX') then e:Destroy() n=n+1 end end return n end
local function effect(class,name,props) local e=Instance.new(class) e.Name=name setProps(e,props) e:SetAttribute('OR_GFX',true) e.Parent=Lighting return e end
local function camera() return Workspace.CurrentCamera end
local function saveCamera(r) if r:GetAttribute('CamSaved') then return end local cam=camera() if not cam then return end r:SetAttribute('CamSaved',true) pcall(function() r:SetAttribute('Snap_CamCF',cam.CFrame) r:SetAttribute('Snap_FOV',cam.FieldOfView) end) end
local function restoreCamera(r) local cam=camera() if not (cam and r:GetAttribute('CamSaved')) then return false end local cf=r:GetAttribute('Snap_CamCF') local fov=r:GetAttribute('Snap_FOV') if typeof(cf)=='CFrame' then cam.CFrame=cf end if fov then cam.FieldOfView=fov end r:SetAttribute('CamSaved',nil) return true end
local function bboxOf(inst) if inst:IsA('BasePart') then return inst.CFrame,inst.Size end if inst:IsA('Model') then local okB,cf,sz=pcall(function() return inst:GetBoundingBox() end) if okB and cf then return cf,sz end return inst:GetPivot(),Vector3.new(4,6,4) end return nil end
local function subjectsBox(s) local mn,mx=nil,nil local function add(inst) local cf,sz=bboxOf(inst) if not cf then return end local p=cf.Position local h=sz*0.5 local a,b=p-h,p+h if not mn then mn,mx=a,b else mn=Vector3.new(math.min(mn.X,a.X),math.min(mn.Y,a.Y),math.min(mn.Z,a.Z)) mx=Vector3.new(math.max(mx.X,b.X),math.max(mx.Y,b.Y),math.max(mx.Z,b.Z)) end end for _,fname in ipairs({'Subjects','Props'}) do local f=s:FindFirstChild(fname) if f then for _,c in ipairs(f:GetChildren()) do add(c) end end end if not mn then local o=stageOrigin(s) return o+Vector3.new(0,3,0),Vector3.new(4,6,4),0 end local n=0 for _,fname in ipairs({'Subjects','Props'}) do local f=s:FindFirstChild(fname) if f then n=n+#f:GetChildren() end end return (mn+mx)*0.5,(mx-mn),n end
local CAMERAS=HttpService:JSONDecode(${jj(CAMERAS)})
local function frameCamera(s,presetName,o) local P=CAMERAS[presetName] or CAMERAS.three_quarter o=o or {} local center,size,count=subjectsBox(s) local fov=tonumber(o.fov) or P.fov local pitch=tonumber(o.pitch) or P.pitch local yaw=tonumber(o.yaw) or P.yaw local roll=tonumber(o.roll) or P.roll local distScale=(tonumber(o.distance_scale) or 1)*P.dist local bias=tonumber(o.height_bias) or P.bias local radius=math.max(size.X,size.Y,size.Z)*0.5*1.15 local dist=radius/math.tan(math.rad(fov)*0.5)*distScale local target=center+Vector3.new(0,bias*size.Y,0)+Vector3.new(tonumber(o.look_x) or 0,tonumber(o.look_y) or 0,tonumber(o.look_z) or 0) local rot=CFrame.Angles(0,math.rad(yaw),0)*CFrame.Angles(math.rad(pitch),0,0) local pos=target-rot.LookVector*dist local cf=CFrame.lookAt(pos,target) if roll~=0 then cf=cf*CFrame.Angles(0,0,math.rad(roll)) end local cam=camera() if cam then cam.FieldOfView=fov cam.CFrame=cf cam.Focus=CFrame.new(target) end s:SetAttribute('CameraPreset',presetName) s:SetAttribute('CameraDistance',dist) for _,e in ipairs(Lighting:GetChildren()) do if e:IsA('DepthOfFieldEffect') and e:GetAttribute('OR_GFX') then e.FocusDistance=dist end end return {preset=presetName,fov=fov,distance=dist,subjects=count,target={target.X,target.Y,target.Z},position={pos.X,pos.Y,pos.Z}} end
local function viewportBox(aspect) local cam=camera() local vw,vh=1280,720 if cam then vw,vh=cam.ViewportSize.X,cam.ViewportSize.Y end if vw<=0 or vh<=0 then vw,vh=1280,720 end local bw,bh if vw/vh>aspect then bh=vh bw=vh*aspect else bw=vw bh=vw/aspect end return {x=(vw-bw)/2/vw,y=(vh-bh)/2/vh,w=bw/vw,h=bh/vh,px={x=(vw-bw)/2,y=(vh-bh)/2,w=bw,h=bh},viewport={w=vw,h=vh}} end
local function overlayGui() return StarterGui:FindFirstChild('OR_GFX_Overlay') end
local STYLES=HttpService:JSONDecode(${jj(STYLES)})
local function fontOf(name) local okF,f=pcall(function() return Enum.Font[name] end) if okF and f then return f end return Enum.Font.GothamBlack end
local POSES=HttpService:JSONDecode(${jj(POSES)})
local FACES=HttpService:JSONDecode(${jj(FACES)})
local FACE_PROPS=HttpService:JSONDecode(${jj(FACE_PROPS)})
local R6_NAMES={RightShoulder='Right Shoulder',LeftShoulder='Left Shoulder',RightHip='Right Hip',LeftHip='Left Hip',Neck='Neck',Waist='RootJoint'}
local function motorsOf(model) local m={} for _,d in ipairs(model:GetDescendants()) do if d:IsA('Motor6D') then m[d.Name]=d end end return m end
local function resetPose(model) local n=0 for _,d in ipairs(model:GetDescendants()) do if d:IsA('Motor6D') then local c0=d:GetAttribute('OR_C0') if typeof(c0)=='CFrame' then d.C0=c0 n=n+1 end end end return n end
local function applyPose(model,poseName,mirror) local P=POSES[poseName] if not P then error('unknown pose '..tostring(poseName)) end local motors=motorsOf(model) local isR6=motors['Right Shoulder']~=nil and motors.RightShoulder==nil resetPose(model) local applied=0 for joint,ang in pairs(P.joints) do local j=joint if mirror then if j:sub(1,5)=='Right' then j='Left'..j:sub(6) elseif j:sub(1,4)=='Left' then j='Right'..j:sub(5) end end local x,y,z=ang[1],ang[2],ang[3] if mirror then y=-y z=-z end local m=motors[j] if isR6 and R6_NAMES[j] then m=motors[R6_NAMES[j]] end if m then if typeof(m:GetAttribute('OR_C0'))~='CFrame' then m:SetAttribute('OR_C0',m.C0) end local base=m:GetAttribute('OR_C0') if isR6 then local side=(j:sub(1,5)=='Right') and 1 or -1 m.C0=base*CFrame.Angles(math.rad(z*side),math.rad(y),math.rad(-x*side)) else m.C0=base*CFrame.Angles(math.rad(x),math.rad(y),math.rad(z)) end applied=applied+1 end end model:SetAttribute('OR_GFX_Pose',poseName) return applied,P.lift or 0,isR6 end
local function applyFace(model,faceName,faceId) local head=model:FindFirstChild('Head') if not head then return 'no head' end local fc=head:FindFirstChildOfClass('FaceControls') if faceName and faceName~='' then local F=FACES[faceName] if not F then error('unknown face '..tostring(faceName)) end if fc then for _,p in ipairs(FACE_PROPS) do pcall(function() fc[p]=0 end) end for k,v in pairs(F) do pcall(function() fc[k]=v end) end model:SetAttribute('OR_GFX_Face',faceName) return 'FaceControls '..faceName end end if faceId and faceId~='' then local decal=nil for _,d in ipairs(head:GetChildren()) do if d:IsA('Decal') then decal=d end end if not decal then decal=Instance.new('Decal') decal.Name='face' decal.Face=Enum.NormalId.Front decal.Parent=head end local id=tostring(faceId) if not id:find('://') then id='rbxassetid://'..id end decal.Texture=id model:SetAttribute('OR_GFX_Face',id) return 'decal '..id end if faceName and faceName~='' and not fc then return 'classic head (no FaceControls) - pass face_id for a decal face' end return 'unchanged' end
local function slotOffset(slot,S) local u=S*0.09 local t={center=Vector3.new(0,0,0),left=Vector3.new(-u,0,0),right=Vector3.new(u,0,0),far_left=Vector3.new(-u*2,0,0),far_right=Vector3.new(u*2,0,0),front=Vector3.new(0,0,u*0.8),back=Vector3.new(0,0,-u*0.8),back_left=Vector3.new(-u*1.5,0,-u*0.8),back_right=Vector3.new(u*1.5,0,-u*0.8)} return t[tostring(slot or 'center')] or t.center end
local function placeOnStage(model,s,slot,yaw,scale,lift,ox,oz) local S=stageSize(s) local o=stageOrigin(s) if scale and scale>0 and scale~=1 and model:IsA('Model') then pcall(function() model:ScaleTo(scale) end) end local cf,sz=bboxOf(model) local bottom=cf.Position.Y-sz.Y*0.5 local pivot=model:GetPivot() local feet=pivot.Position.Y-bottom local off=slotOffset(slot,S)+Vector3.new(tonumber(ox) or 0,0,tonumber(oz) or 0) local target=CFrame.new(o+off+Vector3.new(0,feet+(lift or 0),0))*CFrame.Angles(0,math.rad(180+(tonumber(yaw) or 0)),0) model:PivotTo(target) return target end
local function overlaySetGuides(visible) local g=overlayGui() local gd=g and g:FindFirstChild('Guides',true) if gd then gd.Visible=visible and true or false end return gd~=nil end
`;

  // ───────────────────────── commands ─────────────────────────
  const B = {};

  B.gfx_stage_create = (a) => {
    const style = styleOf(a.style);
    const kind = String(a.kind || "thumbnail").toLowerCase() === "icon" ? "icon" : "thumbnail";
    const aspect = kind === "icon" ? 1 : (a.aspect ? nn(a.aspect, 16 / 9) : 16 / 9);
    const size = Math.max(40, Math.min(600, nn(a.size, 120)));
    const pos = a.position && typeof a.position === "object" ? [nn(a.position.x, 0), nn(a.position.y, 1000), nn(a.position.z, 0)] : (Array.isArray(a.position) ? [nn(a.position[0], 0), nn(a.position[1], 1000), nn(a.position[2], 0)] : [0, 1000, 0]);
    const cfg = { style, kind, aspect, size, pos, backdrop: a.backdrop_color || null, floor: a.floor_color || null, camera: a.camera || (kind === "icon" ? "icon" : "three_quarter"), replace: a.replace !== false, lighting: a.lighting !== false, name: a.name || "Stage" };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local ST=STYLES[A.style] local L=HttpService:JSONDecode(" + jj(LIGHTING) + ")[A.style]",
      "local rec=wp() local r=gfxRoot() snapshotLighting(r) saveCamera(r)",
      "local old=r:FindFirstChild('Stage') if old then if A.replace then old:Destroy() else return fail('a stage already exists - pass replace:true or gfx_teardown first') end end",
      "local S=A.size local O=Vector3.new(A.pos[1],A.pos[2],A.pos[3])",
      "local s=Instance.new('Model') s.Name='Stage' s:SetAttribute('Size',S) s:SetAttribute('Style',A.style) s:SetAttribute('Kind',A.kind) s:SetAttribute('Aspect',A.aspect) s:SetAttribute('OR_Version',GFX_VERSION)",
      "local back=c3(A.backdrop) or c3(ST.backdrop) local floorC=c3(A.floor) or c3(ST.floor) local mat=Enum.Material[ST.material] or Enum.Material.SmoothPlastic",
      "local function part(name,size,cf,color,parent) local p=Instance.new('Part') p.Name=name p.Anchored=true p.CanCollide=false p.CanQuery=false p.CanTouch=false p.CastShadow=(A.style~='chroma') p.Material=mat p.Color=color p.Size=size p.CFrame=cf p.TopSurface=Enum.SurfaceType.Smooth p.BottomSurface=Enum.SurfaceType.Smooth p.Parent=parent or s return p end",
      "local R=S*0.15",
      "local floor=part('Floor',Vector3.new(S*1.6,1,S-R),CFrame.new(O+Vector3.new(0,-0.5,R*0.5)),floorC)",
      "part('Backdrop',Vector3.new(S*1.6,S*0.75,1),CFrame.new(O+Vector3.new(0,R+S*0.375,-S*0.5-0.5)),back)",
      "local C=Vector3.new(0,R,-S*0.5+R) local n=8 for i=1,n do local a0=(i-1)/n*math.pi*0.5 local a1=i/n*math.pi*0.5 local am=(a0+a1)*0.5 local P=O+C+Vector3.new(0,-math.cos(am)*R,-math.sin(am)*R) local chord=2*R*math.sin((a1-a0)*0.5) part('Cove_'..i,Vector3.new(S*1.6,0.3,chord*1.08),CFrame.new(P)*CFrame.Angles(am,0,0),back) end",
      "local lights=Instance.new('Model') lights.Name='Lights' lights.Parent=s",
      "local function light(name,pos,color,bright,angle,shadows,range) local p=Instance.new('Part') p.Name=name p.Anchored=true p.CanCollide=false p.CanQuery=false p.CanTouch=false p.Transparency=1 p.CastShadow=false p.Size=Vector3.new(1,1,1) p.CFrame=CFrame.lookAt(pos,O+Vector3.new(0,3.5,0)) p.Parent=lights local sl=Instance.new('SpotLight') sl.Name='Light' sl.Face=Enum.NormalId.Front sl.Angle=angle sl.Brightness=bright sl.Range=range or S*1.3 sl.Shadows=shadows sl.Color=color sl.Parent=p return p end",
      "light('Key',O+Vector3.new(-S*0.22,S*0.28,S*0.3),c3(ST.key),A.style=='clean' and 1.5 or 3,65,A.style~='chroma')",
      "light('Fill',O+Vector3.new(S*0.28,S*0.18,S*0.32),c3(ST.fill),A.style=='clean' and 1 or 1.2,80,false)",
      "light('Rim',O+Vector3.new(S*0.05,S*0.3,-S*0.2),c3(ST.rim),A.style=='chroma' and 0 or 4,55,false)",
      "if A.style=='neon' then light('Accent',O+Vector3.new(-S*0.3,S*0.08,-S*0.1),c3(ST.accent),5,70,false,S) end",
      "for _,fname in ipairs({'Subjects','Props','FX'}) do local f=Instance.new('Folder') f.Name=fname f.Parent=s end",
      "s.WorldPivot=CFrame.new(O) s.Parent=r",
      "if A.lighting then clearGfxEffects() for k,v in pairs(L) do if k~='effects' and k~='fogByStage' then local val=v if type(v)=='table' then val=c3(v) end pcall(function() Lighting[k]=val end) end end if L.fogByStage then Lighting.FogEnd=S*L.fogByStage end",
      " for name,props in pairs(L.effects or {}) do local p={} for k,v in pairs(props) do p[k]=(type(v)=='table') and c3(v) or v end if name=='Bloom' then effect('BloomEffect','OR_GFX_Bloom',p) elseif name=='ColorCorrection' then effect('ColorCorrectionEffect','OR_GFX_Color',p) elseif name=='DepthOfField' then effect('DepthOfFieldEffect','OR_GFX_DOF',p) elseif name=='SunRays' then effect('SunRaysEffect','OR_GFX_SunRays',p) elseif name=='Atmosphere' then effect('Atmosphere','OR_GFX_Atmosphere',p) end end end",
      "local cam=frameCamera(s,A.camera,{})",
      "pcall(function() StarterGui.ShowDevelopmentGui=true end)",
      "wpDone(rec)",
      "return ok({path=s:GetFullName(),style=A.style,kind=A.kind,aspect=A.aspect,size=S,origin={O.X,O.Y,O.Z},camera=cam,lighting_effects=A.lighting and #Lighting:GetChildren() or 0},'GFX stage ready at '..s:GetFullName()..' ('..A.style..', '..A.kind..', '..S..' studs, '..(A.aspect>1.5 and '16:9' or '1:1')..'). Next: gfx_subject_add {source:\"dummy\"|\"player:USERID\"|path, pose, face}, gfx_prop_add, gfx_overlay {title}, gfx_fx, then gfx_capture. Lighting + camera were snapshotted - gfx_teardown restores them.')",
    ].join("\n");
  };

  B.gfx_subject_add = (a) => {
    const src = String(a.source || "dummy").trim();
    const pose = POSES[String(a.pose || "").toLowerCase()] ? String(a.pose).toLowerCase() : "hero";
    const face = a.face ? String(a.face).toLowerCase() : "";
    if (face && !FACES[face]) throw new Error("unknown face '" + face + "' - use one of: " + FACE_NAMES.join(", "));
    const cfg = { source: src, name: a.name || "", slot: a.slot || "center", yaw: nn(a.yaw, 0), scale: nn(a.scale, 1), pose, face, face_id: a.face_id ? String(a.face_id) : "", mirror: a.mirror === true, ox: nn(a.offset_x, 0), oz: nn(a.offset_z, 0), lift: nn(a.lift, 0), reframe: a.reframe !== false };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local r,s=needStage() local rec=wp()",
      "local model=nil local how=''",
      "local src=A.source local lsrc=src:lower()",
      "if lsrc=='dummy' or lsrc=='r15' or lsrc=='r6' then local okM,m=pcall(function() return Players:CreateHumanoidModelFromDescription(Instance.new('HumanoidDescription'),lsrc=='r6' and Enum.HumanoidRigType.R6 or Enum.HumanoidRigType.R15) end) if not okM then return fail('could not create a dummy rig: '..tostring(m)) end model=m how='dummy '..(lsrc=='r6' and 'R6' or 'R15')",
      "elseif lsrc:match('^player:') or lsrc:match('^user:') or lsrc:match('^%d+$') then local idStr=src:gsub('^[pP]layer:',''):gsub('^[uU]ser:','') local uid=tonumber(idStr) if not uid then local okU,id=pcall(function() return Players:GetUserIdFromNameAsync(idStr) end) if not okU then return fail('unknown username '..idStr..': '..tostring(id)) end uid=id end local okM,m=pcall(function() return Players:CreateHumanoidModelFromUserId(uid) end) if not okM then return fail('could not load avatar '..tostring(uid)..': '..tostring(m)..' (Studio needs internet; try source:\"dummy\")') end model=m how='avatar of user '..tostring(uid)",
      "else local inst=need(src,'subject') if inst:IsA('Model') or inst:IsA('BasePart') then model=inst:Clone() how='clone of '..inst:GetFullName() else return fail('source must be a Model or BasePart: '..inst.ClassName) end end",
      "local subjects=s:FindFirstChild('Subjects') or Instance.new('Folder',s) subjects.Name='Subjects'",
      "if A.name~='' then model.Name=A.name elseif model.Name=='' or model.Name=='Model' then model.Name='Subject'..tostring(#subjects:GetChildren()+1) end",
      "local existing=subjects:FindFirstChild(model.Name) if existing then existing:Destroy() end",
      "model.Parent=subjects",
      "local hum=model:FindFirstChildOfClass('Humanoid') if hum then pcall(function() hum.DisplayDistanceType=Enum.HumanoidDisplayDistanceType.None hum.HealthDisplayType=Enum.HumanoidHealthDisplayType.AlwaysOff hum.NameDisplayDistance=0 end) end",
      "for _,d in ipairs(model:GetDescendants()) do if d:IsA('BasePart') then d.Anchored=true d.CanCollide=false end end",
      "local applied,lift,isR6=0,0,false if hum then applied,lift,isR6=applyPose(model,A.pose,A.mirror) end",
      "local faceNote=hum and applyFace(model,A.face,A.face_id) or 'not a character'",
      "placeOnStage(model,s,A.slot,A.yaw,A.scale,lift+A.lift,A.ox,A.oz)",
      "local cam=nil if A.reframe then cam=frameCamera(s,s:GetAttribute('CameraPreset') or 'three_quarter',{}) end",
      "wpDone(rec)",
      "return ok({path=model:GetFullName(),how=how,pose=A.pose,joints=applied,rig=isR6 and 'R6 (approximate pose mapping)' or 'R15',face=faceNote,slot=A.slot,camera=cam},'subject '..model.Name..' ('..how..') on slot '..A.slot..', pose '..A.pose..' ('..applied..' joints), face: '..faceNote..'. Screenshot (or_screenshot / gfx_capture) to judge; gfx_pose to change the pose or face.')",
    ].join("\n");
  };

  B.gfx_pose = (a) => {
    if (!a.path) throw new Error("missing required param 'path'");
    const pose = a.pose ? String(a.pose).toLowerCase() : "";
    if (pose && !POSES[pose]) throw new Error("unknown pose '" + pose + "' - use one of: " + POSE_NAMES.join(", "));
    const face = a.face ? String(a.face).toLowerCase() : "";
    if (face && !FACES[face]) throw new Error("unknown face '" + face + "' - use one of: " + FACE_NAMES.join(", "));
    const cfg = { path: String(a.path), pose, face, face_id: a.face_id ? String(a.face_id) : "", mirror: a.mirror === true, reset: a.reset === true, head_yaw: nn(a.head_yaw, 0), head_pitch: nn(a.head_pitch, 0), lift: a.lift == null ? null : nn(a.lift, 0) };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local model=need(A.path,'rig') if model:IsA('BasePart') then model=model:FindFirstAncestorWhichIsA('Model') or model end",
      "if not model:IsA('Model') then return fail('path must be a character Model') end",
      "local rec=wp() local r,s=findStage()",
      "local applied,lift,isR6=0,0,false",
      "if A.reset then applied=resetPose(model) end",
      "if A.pose~='' then applied,lift,isR6=applyPose(model,A.pose,A.mirror) end",
      "if A.head_yaw~=0 or A.head_pitch~=0 then local motors=motorsOf(model) local neck=motors.Neck if neck then if typeof(neck:GetAttribute('OR_C0'))~='CFrame' then neck:SetAttribute('OR_C0',neck.C0) end neck.C0=neck.C0*CFrame.Angles(math.rad(A.head_pitch),math.rad(A.head_yaw),0) applied=applied+1 end end",
      "local faceNote=applyFace(model,A.face,A.face_id)",
      "if s and model:IsDescendantOf(s) then local slotName=model:GetAttribute('OR_GFX_Slot') local pivot=model:GetPivot() local liftNow=(A.lift~=nil) and A.lift or lift local o=stageOrigin(s) local cf,sz=bboxOf(model) local bottom=cf.Position.Y-sz.Y*0.5 local dy=(o.Y+liftNow)-bottom model:PivotTo(pivot+Vector3.new(0,dy,0)) end",
      "wpDone(rec)",
      "return ok({path=model:GetFullName(),pose=A.pose~='' and A.pose or model:GetAttribute('OR_GFX_Pose'),joints=applied,rig=isR6 and 'R6 (approximate)' or 'R15',face=faceNote,poses=" + jj(POSE_NAMES) + ",faces=" + jj(FACE_NAMES) + "},'posed '..model.Name..(A.pose~='' and (' as '..A.pose) or '')..' ('..applied..' joints), face: '..faceNote..'. Original C0s are kept in OR_C0 attributes - gfx_pose {reset:true} restores them.')",
    ].join("\n");
  };

  B.gfx_prop_add = (a) => {
    if (!a.source) throw new Error("missing required param 'source'");
    const cfg = { source: String(a.source), name: a.name || "", slot: a.slot || "right", yaw: nn(a.yaw, 0), pitch: nn(a.pitch, 0), scale: nn(a.scale, 1), float: a.float === true, lift: nn(a.lift, 0), ox: nn(a.offset_x, 0), oz: nn(a.offset_z, 0), glow: a.glow === true, glow_color: a.glow_color || null, reframe: a.reframe !== false };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local r,s=needStage() local rec=wp()",
      "local inst=need(A.source,'prop') if not (inst:IsA('Model') or inst:IsA('BasePart') or inst:IsA('Tool')) then return fail('source must be a Model, BasePart or Tool: '..inst.ClassName) end",
      "local prop=inst:Clone() if prop:IsA('Tool') then local m=Instance.new('Model') m.Name=prop.Name for _,c in ipairs(prop:GetChildren()) do if c:IsA('BasePart') then c.Parent=m end end prop=m end",
      "local props=s:FindFirstChild('Props') or Instance.new('Folder',s) props.Name='Props'",
      "if A.name~='' then prop.Name=A.name end local existing=props:FindFirstChild(prop.Name) if existing then existing:Destroy() end",
      "for _,d in ipairs(prop:GetDescendants()) do if d:IsA('BasePart') then d.Anchored=true d.CanCollide=false elseif d:IsA('LuaSourceContainer') then d:Destroy() end end if prop:IsA('BasePart') then prop.Anchored=true prop.CanCollide=false end",
      "prop.Parent=props",
      "local lift=A.lift+(A.float and 3 or 0)",
      "local target=placeOnStage(prop,s,A.slot,A.yaw,A.scale,lift,A.ox,A.oz)",
      "if A.float or A.pitch~=0 then prop:PivotTo(prop:GetPivot()*CFrame.Angles(math.rad(A.pitch+(A.float and -18 or 0)),0,math.rad(A.float and 12 or 0))) end",
      "if A.glow then local host=prop:IsA('BasePart') and prop or (prop.PrimaryPart or prop:FindFirstChildWhichIsA('BasePart',true)) if host then local pl=Instance.new('PointLight') pl.Name='OR_GFX_Glow' pl.Brightness=3 pl.Range=14 pl.Color=c3(A.glow_color) or c3(STYLES[s:GetAttribute('Style') or 'cinematic'].accent) pl.Parent=host local hl=Instance.new('Highlight') hl.Name='OR_GFX_Highlight' hl.FillTransparency=1 hl.OutlineColor=pl.Color hl.OutlineTransparency=0.2 hl.Parent=prop end end",
      "local cam=nil if A.reframe then cam=frameCamera(s,s:GetAttribute('CameraPreset') or 'three_quarter',{}) end",
      "wpDone(rec)",
      "return ok({path=prop:GetFullName(),slot=A.slot,float=A.float,glow=A.glow,camera=cam},'prop '..prop.Name..' placed on slot '..A.slot..(A.float and ' (floating, tilted)' or '')..(A.glow and ' with glow' or '')..'. Camera reframed to include it.')",
    ].join("\n");
  };

  B.gfx_camera = (a) => {
    const preset = CAMERAS[String(a.preset || "").toLowerCase()] ? String(a.preset).toLowerCase() : "";
    const cfg = { preset, fov: a.fov == null ? null : nn(a.fov, 50), pitch: a.pitch == null ? null : nn(a.pitch, 0), yaw: a.yaw == null ? null : nn(a.yaw, 0), roll: a.roll == null ? null : nn(a.roll, 0), distance_scale: a.distance_scale == null ? null : nn(a.distance_scale, 1), height_bias: a.height_bias == null ? null : nn(a.height_bias, 0), look_x: nn(a.look_x, 0), look_y: nn(a.look_y, 0), look_z: nn(a.look_z, 0), target: a.target ? String(a.target) : "" };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local r,s=needStage() saveCamera(r)",
      "local presetName=A.preset~='' and A.preset or (s:GetAttribute('CameraPreset') or 'three_quarter')",
      "local o={} for _,k in ipairs({'fov','pitch','yaw','roll','distance_scale','height_bias','look_x','look_y','look_z'}) do o[k]=A[k] end",
      "local cam=frameCamera(s,presetName,o)",
      "if A.target~='' then local t=need(A.target,'target') local cf,sz=bboxOf(t) if cf then local camI=camera() local P=CAMERAS[presetName] local fov=o.fov or P.fov local radius=math.max(sz.X,sz.Y,sz.Z)*0.5*1.15 local dist=radius/math.tan(math.rad(fov)*0.5)*((o.distance_scale or 1)*P.dist) local rot=CFrame.Angles(0,math.rad(o.yaw or P.yaw),0)*CFrame.Angles(math.rad(o.pitch or P.pitch),0,0) local target=cf.Position+Vector3.new(0,(o.height_bias or P.bias)*sz.Y,0) local pos=target-rot.LookVector*dist local ccf=CFrame.lookAt(pos,target) if (o.roll or P.roll)~=0 then ccf=ccf*CFrame.Angles(0,0,math.rad(o.roll or P.roll)) end camI.CFrame=ccf camI.Focus=CFrame.new(target) cam.distance=dist cam.target={target.X,target.Y,target.Z} cam.position={pos.X,pos.Y,pos.Z} cam.focused_on=t:GetFullName() end end",
      "local box=viewportBox(stageAspect(s))",
      "return ok({camera=cam,presets=" + jj(CAMERA_NAMES) + ",viewport=box.viewport,frame_px=box.px},'camera '..presetName..' (fov '..string.format('%.0f',cam.fov)..', distance '..string.format('%.1f',cam.distance)..' studs). Screenshot to judge the framing; tweak with pitch/yaw/roll/distance_scale/height_bias or another preset.')",
    ].join("\n");
  };

  B.gfx_overlay = (a) => {
    const style = a.style ? styleOf(a.style) : "";
    const cfg = {
      style, title: a.title == null ? "" : String(a.title), subtitle: a.subtitle == null ? "" : String(a.subtitle), badge: a.badge == null ? "" : String(a.badge),
      position: String(a.position || "bottom").toLowerCase(), rotation: a.rotation == null ? null : nn(a.rotation, 0), font: a.font ? String(a.font) : "",
      title_color: a.title_color || null, stroke_color: a.stroke_color || null, gradient: Array.isArray(a.gradient) ? a.gradient.slice(0, 2) : null, accent: a.accent_color || null,
      guides: a.guides !== false, aspect: a.aspect == null ? null : nn(a.aspect, 16 / 9), logo_image: a.logo_image ? String(a.logo_image) : "", title_scale: Math.max(0.3, Math.min(1.5, nn(a.title_scale, 1))), clear: a.clear === true,
      uppercase: a.uppercase !== false,
    };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local r,s=findStage() local styleName=A.style~='' and A.style or (s and s:GetAttribute('Style')) or 'cinematic' local ST=STYLES[styleName] or STYLES.cinematic",
      "local aspect=A.aspect or (s and stageAspect(s)) or (16/9)",
      "local rec=wp() local old=overlayGui() if old then old:Destroy() end",
      "if A.clear then wpDone(rec) return ok({removed=old~=nil},'overlay removed') end",
      "local g=Instance.new('ScreenGui') g.Name='OR_GFX_Overlay' g.IgnoreGuiInset=true g.ResetOnSpawn=false g.DisplayOrder=1000 g.ZIndexBehavior=Enum.ZIndexBehavior.Sibling g:SetAttribute('OR_GFX',true) g:SetAttribute('Aspect',aspect)",
      "local box=viewportBox(aspect)",
      "local frame=Instance.new('Frame') frame.Name='Box' frame.BackgroundTransparency=1 frame.Position=UDim2.new(box.x,0,box.y,0) frame.Size=UDim2.new(box.w,0,box.h,0) frame.Parent=g",
      "local ar=Instance.new('UIAspectRatioConstraint') ar.AspectRatio=aspect ar.DominantAxis=Enum.DominantAxis.Width ar.Parent=frame",
      "local guides=Instance.new('Frame') guides.Name='Guides' guides.BackgroundTransparency=1 guides.Size=UDim2.new(1,0,1,0) guides.Visible=A.guides guides.ZIndex=5 guides.Parent=g",
      "local function mask(name,pos,size) local m=Instance.new('Frame') m.Name=name m.BackgroundColor3=Color3.new(0,0,0) m.BackgroundTransparency=0.45 m.BorderSizePixel=0 m.Position=pos m.Size=size m.Parent=guides end",
      "mask('Left',UDim2.new(0,0,0,0),UDim2.new(box.x,0,1,0)) mask('Right',UDim2.new(box.x+box.w,0,0,0),UDim2.new(1-box.x-box.w,0,1,0)) mask('Top',UDim2.new(box.x,0,0,0),UDim2.new(box.w,0,box.y,0)) mask('Bottom',UDim2.new(box.x,0,box.y+box.h,0),UDim2.new(box.w,0,1-box.y-box.h,0))",
      "local safe=Instance.new('Frame') safe.Name='SafeArea' safe.BackgroundTransparency=1 safe.Position=UDim2.new(box.x+box.w*0.05,0,box.y+box.h*0.05,0) safe.Size=UDim2.new(box.w*0.9,0,box.h*0.9,0) safe.Parent=guides local ss=Instance.new('UIStroke') ss.Thickness=1 ss.Color=Color3.fromRGB(255,255,255) ss.Transparency=0.5 ss.Parent=safe",
      "for i=1,2 do local v=Instance.new('Frame') v.Name='Third_V'..i v.BackgroundColor3=Color3.new(1,1,1) v.BackgroundTransparency=0.7 v.BorderSizePixel=0 v.Position=UDim2.new(box.x+box.w*i/3,0,box.y,0) v.Size=UDim2.new(0,1,box.h,0) v.Parent=guides local h=Instance.new('Frame') h.Name='Third_H'..i h.BackgroundColor3=Color3.new(1,1,1) h.BackgroundTransparency=0.7 h.BorderSizePixel=0 h.Position=UDim2.new(box.x,0,box.y+box.h*i/3,0) h.Size=UDim2.new(box.w,0,0,1) h.Parent=guides end",
      "local bh=box.px.h local font=fontOf(A.font~='' and A.font or ST.font)",
      "local titleC=c3(A.title_color) or c3(ST.title) local strokeC=c3(A.stroke_color) or c3(ST.stroke) local accent=c3(A.accent) or c3(ST.accent) local g1=A.gradient and c3(A.gradient[1]) or c3(ST.gradient[1]) local g2=A.gradient and c3(A.gradient[2]) or c3(ST.gradient[2])",
      "local function text(name,str,size,pos,anchor,color,weight,z) local t=Instance.new('TextLabel') t.Name=name t.BackgroundTransparency=1 t.Text=str t.TextColor3=color t.Font=font t.TextScaled=true t.TextWrapped=true t.Size=size t.Position=pos t.AnchorPoint=anchor t.ZIndex=z or 10 t.Parent=frame local st=Instance.new('UIStroke') st.Thickness=math.max(1,bh*weight) st.Color=strokeC st.LineJoinMode=Enum.LineJoinMode.Round st.ApplyStrokeMode=Enum.ApplyStrokeMode.Contextual st.Parent=t return t,st end",
      "local titleStr=A.uppercase and string.upper(A.title) or A.title",
      "local placements={bottom={pos=UDim2.new(0.5,0,0.8,0),anchor=Vector2.new(0.5,0.5),size=UDim2.new(0.9,0,0.26,0),sub=UDim2.new(0.5,0,0.95,0)},top={pos=UDim2.new(0.5,0,0.2,0),anchor=Vector2.new(0.5,0.5),size=UDim2.new(0.9,0,0.26,0),sub=UDim2.new(0.5,0,0.36,0)},center={pos=UDim2.new(0.5,0,0.5,0),anchor=Vector2.new(0.5,0.5),size=UDim2.new(0.9,0,0.3,0),sub=UDim2.new(0.5,0,0.68,0)},left={pos=UDim2.new(0.05,0,0.5,0),anchor=Vector2.new(0,0.5),size=UDim2.new(0.55,0,0.34,0),sub=UDim2.new(0.05,0,0.7,0)},right={pos=UDim2.new(0.95,0,0.5,0),anchor=Vector2.new(1,0.5),size=UDim2.new(0.55,0,0.34,0),sub=UDim2.new(0.95,0,0.7,0)}}",
      "local PL=placements[A.position] or placements.bottom",
      "local created={} if A.title~='' then local sz=UDim2.new(PL.size.X.Scale*A.title_scale,0,PL.size.Y.Scale*A.title_scale,0) local t,st=text('Title',titleStr,sz,PL.pos,PL.anchor,titleC,0.0075,10) t.Rotation=A.rotation or ST.rotation local gr=Instance.new('UIGradient') gr.Rotation=90 gr.Color=ColorSequence.new(g1,g2) gr.Parent=t local shadow=t:Clone() shadow.Name='TitleShadow' shadow.TextColor3=Color3.new(0,0,0) shadow.TextTransparency=0.35 shadow.ZIndex=9 shadow.Position=PL.pos+UDim2.new(0,bh*0.012,0,bh*0.014) local sg=shadow:FindFirstChildOfClass('UIGradient') if sg then sg:Destroy() end local sst=shadow:FindFirstChildOfClass('UIStroke') if sst then sst.Transparency=1 end shadow.Parent=frame created[#created+1]='Title' end",
      "if A.subtitle~='' then local anchor=PL.anchor local pos=PL.sub local t=text('Subtitle',A.subtitle,UDim2.new(0.8,0,0.09,0),pos,Vector2.new(anchor.X,0.5),Color3.new(1,1,1),0.004,10) t.Rotation=(A.rotation or ST.rotation)*0.5 created[#created+1]='Subtitle' end",
      "if A.badge~='' then local b=Instance.new('Frame') b.Name='Badge' b.BackgroundColor3=accent b.BorderSizePixel=0 b.AnchorPoint=Vector2.new(0,0) b.Position=UDim2.new(0.05,0,0.06,0) b.Size=UDim2.new(0.2,0,0.1,0) b.Rotation=-8 b.ZIndex=12 b.Parent=frame local c=Instance.new('UICorner') c.CornerRadius=UDim.new(0.5,0) c.Parent=b local bs=Instance.new('UIStroke') bs.Thickness=math.max(1,bh*0.004) bs.Color=strokeC bs.Parent=b local bt=Instance.new('TextLabel') bt.Name='Text' bt.BackgroundTransparency=1 bt.Size=UDim2.new(0.85,0,0.7,0) bt.Position=UDim2.new(0.5,0,0.5,0) bt.AnchorPoint=Vector2.new(0.5,0.5) bt.Text=string.upper(A.badge) bt.TextScaled=true bt.Font=font bt.TextColor3=Color3.new(1,1,1) bt.ZIndex=13 bt.Parent=b local bts=Instance.new('UIStroke') bts.Thickness=math.max(1,bh*0.003) bts.Color=strokeC bts.Parent=bt created[#created+1]='Badge' end",
      "if A.logo_image~='' then local img=Instance.new('ImageLabel') img.Name='Logo' img.BackgroundTransparency=1 img.Image=A.logo_image img.AnchorPoint=Vector2.new(1,0) img.Position=UDim2.new(0.95,0,0.05,0) img.Size=UDim2.new(0.16,0,0.16,0) img.ZIndex=12 img.ScaleType=Enum.ScaleType.Fit img.Parent=frame local la=Instance.new('UIAspectRatioConstraint') la.AspectRatio=1 la.Parent=img created[#created+1]='Logo' end",
      "g.Parent=StarterGui pcall(function() StarterGui.ShowDevelopmentGui=true end)",
      "wpDone(rec)",
      "return ok({path=g:GetFullName(),created=created,aspect=aspect,box=box,font=font.Name,style=styleName,guides=A.guides},'overlay: '..table.concat(created,', ')..' ('..styleName..', font '..font.Name..', aspect '..(aspect>1.5 and '16:9' or string.format('%.2f',aspect))..'). Guides (masks, safe area, thirds) are visible for composing and hidden automatically by gfx_capture.')",
    ].join("\n");
  };

  B.gfx_fx = (a) => {
    const kind = FX[String(a.kind || "").toLowerCase()] ? String(a.kind).toLowerCase() : "";
    if (!kind) throw new Error("missing/unknown param 'kind' - use one of: " + FX_NAMES.join(", "));
    const cfg = { kind, preset: FX[kind], attach: a.attach ? String(a.attach) : "", intensity: Math.max(0.1, Math.min(5, nn(a.intensity, 1))), color: a.color || null, color2: a.color2 || null, name: a.name || ("FX_" + kind), clear: a.clear === true };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local r,s=needStage() local rec=wp() local fxf=s:FindFirstChild('FX') or Instance.new('Folder',s) fxf.Name='FX'",
      "if A.clear then local n=#fxf:GetChildren() fxf:ClearAllChildren() for _,e in ipairs(Lighting:GetChildren()) do if e.Name=='OR_GFX_Rays' then e:Destroy() end end wpDone(rec) return ok({cleared=n},'stage FX cleared') end",
      "local P=A.preset local S=stageSize(s) local O=stageOrigin(s)",
      "if P.sunrays then local e=Lighting:FindFirstChild('OR_GFX_Rays') or effect('SunRaysEffect','OR_GFX_Rays',{}) e.Intensity=0.18*A.intensity e.Spread=0.9 local rim=s:FindFirstChild('Rim',true) if rim and rim:FindFirstChildOfClass('SpotLight') then rim.Light.Brightness=rim.Light.Brightness*1.5 end wpDone(rec) return ok({effect=e:GetFullName()},'god rays on (SunRays '..string.format('%.2f',e.Intensity)..', rim boosted). Best with the sun behind the subject - try gfx_lighting {time:17.6}.') end",
      "local host=nil local attached=''",
      "if A.attach~='' then local t=need(A.attach,'attach') host=t:IsA('BasePart') and t or (t:FindFirstChild('HumanoidRootPart') or t.PrimaryPart or t:FindFirstChildWhichIsA('BasePart',true)) attached=t:GetFullName() end",
      "if not host then host=Instance.new('Part') host.Name=A.name host.Anchored=true host.CanCollide=false host.CanQuery=false host.CanTouch=false host.Transparency=1 host.CastShadow=false host.Size=Vector3.new(S*0.6,S*0.35,S*0.3) host.CFrame=CFrame.new(O+Vector3.new(0,P.fromTop and S*0.4 or S*0.12,S*0.05)) host.Parent=fxf end",
      "local pe=Instance.new('ParticleEmitter') pe.Name=A.name pe.Texture=P.Texture pe.Rate=P.Rate*A.intensity pe.Lifetime=NumberRange.new(P.Lifetime[1],P.Lifetime[2]) pe.Speed=NumberRange.new(P.Speed[1],P.Speed[2]) pe.Rotation=NumberRange.new(P.Rotation[1],P.Rotation[2]) pe.RotSpeed=NumberRange.new(P.RotSpeed[1],P.RotSpeed[2]) pe.LightEmission=P.LightEmission pe.LightInfluence=0.2 pe.Acceleration=Vector3.new(P.Acceleration[1],P.Acceleration[2],P.Acceleration[3]) pe.Drag=P.Drag pe.SpreadAngle=Vector2.new(35,35) pe.EmissionDirection=P.fromTop and Enum.NormalId.Bottom or Enum.NormalId.Top pe.Size=NumberSequence.new({NumberSequenceKeypoint.new(0,P.Size[1]),NumberSequenceKeypoint.new(0.5,P.Size[2]),NumberSequenceKeypoint.new(1,P.Size[1]*0.4)}) local ta=P.Transparency and P.Transparency[1] or 0 pe.Transparency=NumberSequence.new({NumberSequenceKeypoint.new(0,1),NumberSequenceKeypoint.new(0.15,ta),NumberSequenceKeypoint.new(0.8,ta+0.2),NumberSequenceKeypoint.new(1,1)})",
      "local c1=c3(A.color) or c3(P.colors[1]) local c2=c3(A.color2) or c3(P.colors[2] or P.colors[1]) pe.Color=ColorSequence.new(c1,c2)",
      "if host:IsA('BasePart') and host.Parent~=fxf then pe.Rate=pe.Rate*0.5 end",
      "pe:SetAttribute('OR_GFX',true) pe.Parent=host",
      "wpDone(rec)",
      "return ok({path=pe:GetFullName(),kind=A.kind,attached=attached,rate=pe.Rate,kinds=" + jj(FX_NAMES) + "},A.kind..' particles '..(attached~='' and ('attached to '..attached) or 'over the stage')..' (rate '..string.format('%.0f',pe.Rate)..'). Particles need a moment to fill - wait ~1 s before gfx_capture. gfx_fx {clear:true} removes them.')",
    ].join("\n");
  };

  B.gfx_lighting = (a) => {
    const style = a.style ? styleOf(a.style) : "";
    const cfg = { style, time: a.time == null ? null : nn(a.time, 14), brightness: a.brightness == null ? null : nn(a.brightness, 2), exposure: a.exposure == null ? null : nn(a.exposure, 0), bloom: a.bloom == null ? null : nn(a.bloom, 0.5), saturation: a.saturation == null ? null : nn(a.saturation, 0), contrast: a.contrast == null ? null : nn(a.contrast, 0), tint: a.tint || null, dof: a.dof == null ? null : nn(a.dof, 0.3), fog: a.fog == null ? null : nn(a.fog, 0), key_color: a.key_color || null, rim_color: a.rim_color || null, key_brightness: a.key_brightness == null ? null : nn(a.key_brightness, 3), rim_brightness: a.rim_brightness == null ? null : nn(a.rim_brightness, 4), shadows: a.shadows == null ? null : a.shadows !== false };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local r,s=findStage() if not r then r=gfxRoot() end snapshotLighting(r) local rec=wp()",
      "local changed={}",
      "if A.style~='' then local L=HttpService:JSONDecode(" + jj(LIGHTING) + ")[A.style] clearGfxEffects() for k,v in pairs(L) do if k~='effects' and k~='fogByStage' then local val=v if type(v)=='table' then val=c3(v) end pcall(function() Lighting[k]=val end) end end if L.fogByStage and s then Lighting.FogEnd=stageSize(s)*L.fogByStage end for name,props in pairs(L.effects or {}) do local p={} for k,v in pairs(props) do p[k]=(type(v)=='table') and c3(v) or v end if name=='Bloom' then effect('BloomEffect','OR_GFX_Bloom',p) elseif name=='ColorCorrection' then effect('ColorCorrectionEffect','OR_GFX_Color',p) elseif name=='DepthOfField' then effect('DepthOfFieldEffect','OR_GFX_DOF',p) elseif name=='SunRays' then effect('SunRaysEffect','OR_GFX_SunRays',p) elseif name=='Atmosphere' then effect('Atmosphere','OR_GFX_Atmosphere',p) end end if s then s:SetAttribute('Style',A.style) local ST=STYLES[A.style] for _,n in ipairs({'Key','Fill','Rim'}) do local p=s:FindFirstChild(n,true) if p and p:FindFirstChild('Light') then p.Light.Color=c3(ST[n:lower()]) end end for _,n in ipairs({'Floor','Backdrop'}) do local p=s:FindFirstChild(n) if p then p.Color=c3(n=='Floor' and ST.floor or ST.backdrop) end end for i=1,8 do local p=s:FindFirstChild('Cove_'..i) if p then p.Color=c3(ST.backdrop) end end end changed[#changed+1]='style '..A.style end",
      "local function fx(class,name) local e=nil for _,c in ipairs(Lighting:GetChildren()) do if c:IsA(class) and c:GetAttribute('OR_GFX') then e=c end end if not e then e=effect(class,name,{}) end return e end",
      "if A.time~=nil then Lighting.ClockTime=A.time changed[#changed+1]='time' end",
      "if A.brightness~=nil then Lighting.Brightness=A.brightness changed[#changed+1]='brightness' end",
      "if A.exposure~=nil then Lighting.ExposureCompensation=A.exposure changed[#changed+1]='exposure' end",
      "if A.shadows~=nil then Lighting.GlobalShadows=A.shadows changed[#changed+1]='shadows' end",
      "if A.bloom~=nil then local e=fx('BloomEffect','OR_GFX_Bloom') e.Intensity=A.bloom e.Size=math.max(24,math.min(64,24+A.bloom*30)) e.Threshold=math.max(0.5,1.3-A.bloom*0.5) changed[#changed+1]='bloom' end",
      "if A.saturation~=nil or A.contrast~=nil or A.tint then local e=fx('ColorCorrectionEffect','OR_GFX_Color') if A.saturation~=nil then e.Saturation=A.saturation end if A.contrast~=nil then e.Contrast=A.contrast end if A.tint then e.TintColor=c3(A.tint) or e.TintColor end changed[#changed+1]='color' end",
      "if A.dof~=nil then local e=fx('DepthOfFieldEffect','OR_GFX_DOF') e.FarIntensity=A.dof e.NearIntensity=A.dof*0.8 e.InFocusRadius=14 e.FocusDistance=(s and tonumber(s:GetAttribute('CameraDistance'))) or 30 if A.dof<=0 then e:Destroy() end changed[#changed+1]='dof' end",
      "if A.fog~=nil then if A.fog<=0 then Lighting.FogEnd=100000 else local S=s and stageSize(s) or 120 Lighting.FogStart=0 Lighting.FogEnd=S*(3.5-math.min(3,A.fog)*1) end changed[#changed+1]='fog' end",
      "if s then local key=s:FindFirstChild('Key',true) local rim=s:FindFirstChild('Rim',true) if key and key:FindFirstChild('Light') then if A.key_color then key.Light.Color=c3(A.key_color) or key.Light.Color end if A.key_brightness~=nil then key.Light.Brightness=A.key_brightness end end if rim and rim:FindFirstChild('Light') then if A.rim_color then rim.Light.Color=c3(A.rim_color) or rim.Light.Color end if A.rim_brightness~=nil then rim.Light.Brightness=A.rim_brightness end end if A.key_color or A.rim_color or A.key_brightness~=nil or A.rim_brightness~=nil then changed[#changed+1]='rig lights' end end",
      "wpDone(rec)",
      "local effs={} for _,e in ipairs(Lighting:GetChildren()) do if e:GetAttribute('OR_GFX') then effs[#effs+1]=e.Name end end",
      "return ok({changed=changed,effects=effs,clock=Lighting.ClockTime,brightness=Lighting.Brightness,exposure=Lighting.ExposureCompensation,styles=" + jj(STYLE_NAMES) + "},'lighting updated: '..(#changed>0 and table.concat(changed,', ') or 'nothing')..'. Screenshot to judge; gfx_teardown restores the original Lighting.')",
    ].join("\n");
  };

  // Runs in Studio BEFORE the photo: hides guides, clears selection, returns the crop box.
  // main.js intercepts gfx_capture, runs this, photographs via screen_capture, crops & saves.
  B.gfx_capture = (a) => {
    const kind = String(a.kind || "").toLowerCase();
    const cfg = { aspect: a.aspect == null ? null : nn(a.aspect, 16 / 9), kind, width: a.width == null ? null : Math.round(nn(a.width, 1920)), height: a.height == null ? null : Math.round(nn(a.height, 1080)), name: a.name ? String(a.name).replace(/[^A-Za-z0-9_\-]+/g, "_") : "", hide_overlay: a.hide_overlay === true, keep_guides: a.keep_guides === true, settle_ms: Math.max(0, Math.min(5000, nn(a.settle_ms, 700))) };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local r,s=findStage()",
      "local kind=A.kind~='' and A.kind or (s and s:GetAttribute('Kind')) or 'thumbnail'",
      "local aspect=A.aspect or (kind=='icon' and 1 or (s and stageAspect(s)) or (16/9))",
      "local ow,oh=A.width,A.height if not ow or not oh then if kind=='icon' then ow,oh=512,512 else ow,oh=1920,1080 end if A.aspect and not (A.width and A.height) then oh=math.floor(ow/aspect+0.5) end end",
      "overlaySetGuides(A.keep_guides) local g=overlayGui() if g then g.Enabled=not A.hide_overlay end",
      "pcall(function() StarterGui.ShowDevelopmentGui=true end) pcall(function() Selection:Set({}) end)",
      "local box=viewportBox(aspect)",
      "local cam=camera() local warnings={} if cam and (cam.ViewportSize.X<ow*0.75) then warnings[#warnings+1]='viewport is only '..math.floor(cam.ViewportSize.X)..' px wide - the output will be upscaled; maximise the 3D view or hide panels for a sharper capture' end",
      "if not s then warnings[#warnings+1]='no GFX stage - capturing whatever the camera sees' end",
      "local name=A.name~='' and A.name or ((s and s:GetAttribute('Title')) or ('OR_'..kind))",
      "return ok({aspect=aspect,kind=kind,box={x=box.x,y=box.y,w=box.w,h=box.h},viewport=box.viewport,out={w=ow,h=oh},file=name..'_'..ow..'x'..oh..'.png',settle_ms=A.settle_ms,overlay=g~=nil,warnings=warnings},'capture prepared: '..ow..'x'..oh..' from a '..string.format('%.0fx%.0f',box.px.w,box.px.h)..' viewport box. ORscript now photographs the viewport (screen_capture), crops it to the box and attaches the PNG.')",
    ].join("\n");
  };

  B.gfx_brief = (a) => {
    const style = styleOf(a.style || "cinematic");
    const kind = String(a.kind || "thumbnail").toLowerCase() === "icon" ? "icon" : "thumbnail";
    const title = String(a.title || "").trim();
    const genre = String(a.genre || "").trim();
    const mood = String(a.mood || "").trim();
    const subjects = Array.isArray(a.subjects) ? a.subjects.map(String) : (a.subjects ? [String(a.subjects)] : []);
    const colors = Array.isArray(a.colors) ? a.colors.map(String) : [];
    const ST = STYLES[style];
    const hex = (c) => "#" + c.map((x) => ("0" + Math.round(x).toString(16)).slice(-2)).join("");
    const palette = colors.length ? colors : [hex(ST.accent), hex(ST.title), hex(ST.backdrop)];
    const styleWords = {
      cinematic: "cinematic Roblox render, dramatic rim light, volumetric haze, shallow depth of field, high contrast, 4k, unreal-engine quality",
      cartoony: "bright cartoony Roblox render, saturated colours, thick outlines, big expressive face, bouncy pose, clean sky-blue backdrop",
      horror: "dark horror Roblox render, cold blue moonlight, fog, red accent light, grainy, terrified expressive face",
      neon: "neon cyberpunk Roblox render, cyan and magenta rim lights, strong bloom, reflective floor, night",
      clean: "clean studio Roblox render, white cyclorama, soft shadows, product-shot lighting, minimal",
      chroma: "Roblox character render on a flat green screen, even lighting, no shadows, centered",
    }[style];
    const who = subjects.length ? subjects.join(" and ") : "one Roblox avatar as the hero character";
    const face = a.face ? String(a.face) : (style === "horror" ? "scared" : "excited");
    const prompt = `${kind === "icon" ? "Square Roblox game icon (1:1)" : "Roblox game thumbnail (16:9, 1920x1080)"}${genre ? " for a " + genre + " game" : ""}: ${who}, ${face} expressive face looking at the camera, ${a.pose ? String(a.pose) + " pose" : "dynamic hero pose"}, ${styleWords}${mood ? ", mood: " + mood : ""}. Palette ${palette.join(", ")}. ${title ? `Large bold title text "${title}" ${kind === "icon" ? "kept short" : "in the lower third"}, thick ${hex(ST.stroke)} outline, readable at thumbnail size.` : "No text."} Composition: subject on the left third, clear silhouette, strong foreground/background separation, nothing important near the edges (5% safe area).`;
    const negative = "blurry, low contrast, watermark, extra limbs, deformed hands, tiny unreadable text, cluttered background, cropped head, grey default Roblox lighting";
    const checklist = [
      "ONE focal character with a big readable face (shocked/excited faces lift CTR) - closeup or hero_low camera",
      "Title <= 3 words, ultra-bold, high-contrast outline, lower third (thumbnail) or none (icon); it must read at 10% size",
      "Rule of thirds: subject on a third line, eyes near the upper third; keep 5% safe margins (platform UI covers corners)",
      "Colour: saturated subject against a darker or complementary backdrop; one accent colour; avoid grey",
      "Depth: rim light + slight DOF/haze separates the subject from the backdrop",
      "Icon and thumbnail must share palette, title style and character so the pair reads as one game",
      "Test: shrink to 200 px wide (ui_preview / zoom out) - if the face and title still read, ship it",
      "No misleading content; show real gameplay elements (weapon, pet, map) as props",
    ];
    const studio = [
      `gfx_stage_create {style:"${style}", kind:"${kind}"}`,
      `gfx_subject_add {source:"player:<userId>" | "dummy", pose:"${a.pose || (style === "horror" ? "scared" : "hero")}", face:"${face === "excited" ? "shocked" : face}", slot:"left"}`,
      `gfx_prop_add {source:"<Workspace.Sword>", slot:"right", float:true, glow:true}`,
      `gfx_overlay {title:${JSON.stringify(title || "TITLE")}${a.badge ? ", badge:" + JSON.stringify(String(a.badge)) : ""}, position:"bottom"}`,
      `gfx_fx {kind:"${style === "horror" ? "smoke" : style === "neon" ? "magic" : "sparkles"}"}`,
      `gfx_camera {preset:"${kind === "icon" ? "icon" : "hero_low"}"}`,
      `gfx_capture {kind:"${kind}"}`,
    ];
    const data = { kind, style, title, palette, prompt, negative_prompt: negative, size: kind === "icon" ? "512x512 (upload 512x512 PNG)" : "1920x1080 PNG/JPG", checklist, studio_recipe: studio };
    return [
      "local D=HttpService:JSONDecode(" + jj(data) + ")",
      "local r,s=findStage() if s then s:SetAttribute('Title'," + q(title || "") + ") end",
      "return ok(D,'GFX brief for a '..D.style..' '..D.kind..'. In Studio run the studio_recipe (7 commands) and gfx_capture; if your chat can generate images, paste data.prompt as the image prompt and use the Studio capture as the reference image.')",
    ].join("\n");
  };

  B.gfx_teardown = (a) => {
    const cfg = { keep_stage: a.keep_stage === true, keep_overlay: a.keep_overlay === true, keep_lighting: a.keep_lighting === true };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local r=Workspace:FindFirstChild('OR_GFX') local rec=wp() local done={}",
      "local g=overlayGui() if g and not A.keep_overlay then g:Destroy() done[#done+1]='overlay removed' end",
      "if r then",
      " if not A.keep_lighting then local n=clearGfxEffects() if restoreLighting(r) then done[#done+1]='Lighting restored ('..n..' effects removed)' end end",
      " if restoreCamera(r) then done[#done+1]='camera restored' end",
      " local s=r:FindFirstChild('Stage') if s and not A.keep_stage then s:Destroy() done[#done+1]='stage removed' end",
      " if not A.keep_stage and not A.keep_lighting then r:Destroy() done[#done+1]='OR_GFX folder removed' end",
      "end",
      "wpDone(rec)",
      "if #done==0 then return ok({done=done},'nothing to tear down (no GFX stage, overlay or snapshot)') end",
      "return ok({done=done},'GFX teardown: '..table.concat(done,'; '))",
    ].join("\n");
  };

  // ───────────────────────── catalogue ─────────────────────────
  const S = (type, req, desc) => ({ type, req: !!req, desc: desc || "" });
  const C = [
    { name: "gfx_stage_create", description: "Build a thumbnail/icon photo stage far from the map: cyclorama (floor + cove + backdrop), 3-point SpotLight rig, style lighting + post stack (cinematic | cartoony | horror | neon | clean | chroma), camera framed, Lighting + camera snapshotted for gfx_teardown. kind icon = 1:1, thumbnail = 16:9.", params: { style: S("string", false, STYLE_NAMES.join("|")), kind: S("string", false, "thumbnail|icon"), size: S("number", false, "stage width in studs (default 120)"), backdrop_color: S("string", false, "hex / [r,g,b] override"), floor_color: S("string", false), camera: S("string", false, CAMERA_NAMES.join("|")), position: S("object", false, "{x,y,z} stage origin (default 0,1000,0)"), lighting: S("boolean", false, "apply style lighting (default true)"), replace: S("boolean", false, "replace an existing stage (default true)") } },
    { name: "gfx_subject_add", description: "Put a character on the stage: source 'dummy' (default R15 rig), 'r6', 'player:USERID' / 'user:Name' (real avatar via CreateHumanoidModelFromUserId), or a Workspace model path (cloned). Anchored, posed (hero, point, jump, wave, scared, victory, run, think, sit, dab, fight, crossed_arms), face preset on dynamic heads (happy, shocked, angry, scared, smirk, determined, laughing, wink) or face_id decal, placed on a slot facing the camera; camera reframed.", params: { source: S("string", false, "dummy|r6|player:ID|user:Name|path"), pose: S("string", false, POSE_NAMES.join("|")), face: S("string", false, FACE_NAMES.join("|")), face_id: S("string", false, "decal asset id for classic heads"), slot: S("string", false, "center|left|right|far_left|far_right|front|back|back_left|back_right"), yaw: S("number", false, "degrees, 0 = facing camera"), scale: S("number", false), name: S("string", false), mirror: S("boolean", false), offset_x: S("number", false), offset_z: S("number", false), lift: S("number", false), reframe: S("boolean", false, "default true") } },
    { name: "gfx_pose", description: "Re-pose a rig on (or off) the stage: pose preset + face preset / face_id, optional head_yaw / head_pitch, mirror, lift; reset:true restores the original Motor6D C0s (kept in OR_C0 attributes). R15 exact, R6 approximate.", params: { path: S("string", true, "character Model"), pose: S("string", false, POSE_NAMES.join("|")), face: S("string", false, FACE_NAMES.join("|")), face_id: S("string", false), head_yaw: S("number", false), head_pitch: S("number", false), mirror: S("boolean", false), lift: S("number", false), reset: S("boolean", false) } },
    { name: "gfx_prop_add", description: "Clone a prop (Model / Part / Tool: sword, chest, pet, vehicle) onto a stage slot; float:true lifts and tilts it (floating weapon trope); glow adds a PointLight + Highlight in the style accent. Scripts are stripped from the clone.", params: { source: S("string", true, "instance path"), slot: S("string", false, "center|left|right|far_left|far_right|front|back|back_left|back_right"), scale: S("number", false), yaw: S("number", false), pitch: S("number", false), float: S("boolean", false), glow: S("boolean", false), glow_color: S("string", false), lift: S("number", false), offset_x: S("number", false), offset_z: S("number", false), name: S("string", false), reframe: S("boolean", false) } },
    { name: "gfx_camera", description: "Frame the stage subjects (or a target) with a preset - hero_low (looking up, heroic), three_quarter, front, closeup (face), top_down, dutch (rolled), wide, icon - and optional fov / pitch / yaw / roll / distance_scale / height_bias overrides. Sets the Studio camera + Focus and DOF focus distance; returns the 16:9 or 1:1 frame box in viewport pixels.", params: { preset: S("string", false, CAMERA_NAMES.join("|")), target: S("string", false, "frame this instance instead of all subjects"), fov: S("number", false), pitch: S("number", false, "degrees, + looks up"), yaw: S("number", false), roll: S("number", false), distance_scale: S("number", false, "1 = preset distance"), height_bias: S("number", false, "0..0.5 aims higher on the subject"), look_x: S("number", false), look_y: S("number", false), look_z: S("number", false) } },
    { name: "gfx_overlay", description: "Title overlay for the shot (edit-mode ScreenGui StarterGui.OR_GFX_Overlay): huge TextScaled title with style font (Michroma / FredokaOne / Creepster / Arcade / GothamBlack), gradient, thick outline + drop shadow, optional subtitle, badge pill (NEW / UPDATE / x2), logo image, plus composition guides (aspect masks, 5% safe area, thirds) that gfx_capture hides automatically. clear:true removes it.", params: { title: S("string", false), subtitle: S("string", false), badge: S("string", false), position: S("string", false, "bottom|top|center|left|right"), style: S("string", false, STYLE_NAMES.join("|")), font: S("string", false, "Enum.Font name"), title_color: S("string", false), stroke_color: S("string", false), gradient: S("array", false, "[colorTop, colorBottom]"), accent_color: S("string", false), rotation: S("number", false), title_scale: S("number", false), uppercase: S("boolean", false, "default true"), logo_image: S("string", false, "rbxassetid://"), aspect: S("number", false), guides: S("boolean", false, "default true"), clear: S("boolean", false) } },
    { name: "gfx_fx", description: "Particle beat on the stage or attached to a subject/prop: sparkles, embers, smoke, confetti, snow, magic, or rays (SunRays + rim boost). intensity scales rate; color/color2 override the preset. clear:true removes stage FX.", params: { kind: S("string", true, FX_NAMES.join("|")), attach: S("string", false, "subject/prop path (emits from its root part)"), intensity: S("number", false, "0.1-5 (default 1)"), color: S("string", false), color2: S("string", false), name: S("string", false), clear: S("boolean", false) } },
    { name: "gfx_lighting", description: "Re-style (style) or fine-tune the shot lighting: time, brightness, exposure, shadows, bloom, saturation, contrast, tint, dof (0 removes), fog (0 removes), rig key/rim colour + brightness. Lighting is snapshotted first; gfx_teardown restores it.", params: { style: S("string", false, STYLE_NAMES.join("|")), time: S("number", false, "ClockTime 0-24"), brightness: S("number", false), exposure: S("number", false), shadows: S("boolean", false), bloom: S("number", false, "0-2"), saturation: S("number", false, "-1..1"), contrast: S("number", false, "-1..1"), tint: S("string", false), dof: S("number", false, "0-1"), fog: S("number", false, "0-3"), key_color: S("string", false), rim_color: S("string", false), key_brightness: S("number", false), rim_brightness: S("number", false) } },
    { name: "gfx_capture", description: "Photograph the shot: hides the guides, clears the selection, photographs the Studio viewport through the MCP, crops to the 16:9 / 1:1 box and returns a finished PNG (thumbnail 1920x1080, icon 512x512, or width/height) - downloaded to the browser and attached to the chat for you to judge. Works without a stage too (captures the current camera).", params: { kind: S("string", false, "thumbnail|icon (default from stage)"), name: S("string", false, "file name stem"), width: S("number", false), height: S("number", false), aspect: S("number", false), hide_overlay: S("boolean", false, "capture without the title"), keep_guides: S("boolean", false), settle_ms: S("number", false, "wait before the photo (default 700)") } },
    { name: "gfx_brief", description: "Art-director brief for a thumbnail or icon: image-generation prompt + negative prompt (for chats that can paint, using the Studio capture as reference), palette, platform size, a CTR checklist (face, <=3-word title, thirds, safe area, contrast, icon/thumbnail pairing) and the exact 7-command Studio recipe for this style.", params: { title: S("string", false), genre: S("string", false), style: S("string", false, STYLE_NAMES.join("|")), kind: S("string", false, "thumbnail|icon"), mood: S("string", false), subjects: S("array", false, "who/what is in the shot"), colors: S("array", false, "hex palette"), pose: S("string", false), face: S("string", false), badge: S("string", false) } },
    { name: "gfx_teardown", description: "Leave no trace: remove the overlay and stage, delete the GFX post effects, restore the snapshotted Lighting and camera. keep_stage / keep_overlay / keep_lighting to keep parts.", params: { keep_stage: S("boolean", false), keep_overlay: S("boolean", false), keep_lighting: S("boolean", false) } },
  ];

  function buildGfx(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      return { code: HEAD + "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))" };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + (e && e.message ? e.message : e) };
    }
  }

  const prevBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    if (B[op]) return buildGfx(op, args);
    return prevBuild.call(RobloxScriptSkills, op, args);
  };
  const names = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!names.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name);
  RobloxScriptSkills.GFX_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.GFX_STYLES = STYLE_NAMES;
  RobloxScriptSkills.GFX_POSES = POSE_NAMES;
  RobloxScriptSkills.GFX_FACES = FACE_NAMES;
  RobloxScriptSkills.GFX_CAMERAS = CAMERA_NAMES;
  RobloxScriptSkills.GFX_FX = FX_NAMES;
  RobloxScriptSkills.GFX_VERSION = GFX_VERSION;
})();
