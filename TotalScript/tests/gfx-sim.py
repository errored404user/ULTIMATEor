#!/usr/bin/env python3
"""Execute the Thumbnail & Icon Studio (gfx_*) Luau against the miniature Roblox DataModel.

tests/test-gfx-pack.js checks the pack statically; tests/luau-parse-check.py proves the
programs parse. This script runs a whole photo session - stage, subjects (dummy, avatar,
R6), poses + faces, props, camera presets, overlay, FX, lighting tweaks, capture prep,
brief, teardown - inside tests/roblox_sim.py and asserts the instance tree, Motor6D C0
bookkeeping, Lighting snapshot/restore, camera maths and the JSON contracts main.js
relies on for the crop step.

    pip install lupa && python3 tests/gfx-sim.py          (from the TotalScript root)
"""
import json, math, os, subprocess, sys

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
global.window=global; global.chrome={storage:{local:{get:(k,cb)=>cb&&cb({}),set:()=>{}}},runtime:{getURL:(p)=>p}};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills;
const out={commands:S.GFX_COMMANDS, styles:S.GFX_STYLES, poses:S.GFX_POSES, faces:S.GFX_FACES, cameras:S.GFX_CAMERAS, fx:S.GFX_FX, programs:{}};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "subject_no_stage": ["gfx_subject_add", {"source": "dummy"}],
    "stage": ["gfx_stage_create", {"style": "cinematic", "kind": "thumbnail"}],
    "stage_again": ["gfx_stage_create", {"style": "cartoony", "replace": False}],
    "dummy_hero": ["gfx_subject_add", {"source": "dummy", "pose": "hero", "face": "happy", "slot": "left", "name": "Hero"}],
    "avatar_shocked": ["gfx_subject_add", {"source": "player:1", "pose": "scared", "face": "shocked", "slot": "right", "scale": 1.2}],
    "avatar_404": ["gfx_subject_add", {"source": "player:404"}],
    "avatar_by_name": ["gfx_subject_add", {"source": "user:Builderman", "slot": "far_right", "name": "Builder"}],
    "r6": ["gfx_subject_add", {"source": "r6", "pose": "victory", "slot": "back_left", "name": "Classic"}],
    "pose_reset": ["gfx_pose", {"path": "Workspace.TOTAL_GFX.Stage.Subjects.Hero", "reset": True}],
    "pose_jump": ["gfx_pose", {"path": "Workspace.TOTAL_GFX.Stage.Subjects.Hero", "pose": "jump", "face": "shocked", "head_yaw": 15}],
    "pose_face_id": ["gfx_pose", {"path": "Workspace.TOTAL_GFX.Stage.Subjects.Hero", "face_id": "123456"}],
    "pose_bad": ["gfx_pose", {"path": "Workspace.TOTAL_GFX.Stage.Subjects.Hero", "pose": "moonwalk"}],
    "prop": ["gfx_prop_add", {"source": "Workspace.Sword", "slot": "front", "float": True, "glow": True}],
    "prop_tool": ["gfx_prop_add", {"source": "Workspace.Blaster", "slot": "back_right", "name": "Gun"}],
    "cam_hero": ["gfx_camera", {"preset": "hero_low"}],
    "cam_close": ["gfx_camera", {"preset": "closeup", "target": "Workspace.TOTAL_GFX.Stage.Subjects.Hero"}],
    "cam_dutch": ["gfx_camera", {"preset": "dutch", "fov": 45, "distance_scale": 1.5}],
    "overlay": ["gfx_overlay", {"title": "Epic Quest", "subtitle": "update 2", "badge": "new", "logo_image": "rbxassetid://1"}],
    "overlay_clear": ["gfx_overlay", {"clear": True}],
    "overlay_icon": ["gfx_overlay", {"title": "Q", "style": "neon", "aspect": 1, "position": "center", "guides": False}],
    "fx_sparkles": ["gfx_fx", {"kind": "sparkles", "intensity": 2}],
    "fx_attach": ["gfx_fx", {"kind": "magic", "attach": "Workspace.TOTAL_GFX.Stage.Subjects.Hero", "color": "#ff0000"}],
    "fx_rays": ["gfx_fx", {"kind": "rays"}],
    "fx_bad": ["gfx_fx", {"kind": "lasers"}],
    "fx_clear": ["gfx_fx", {"kind": "smoke", "clear": True}],
    "light_neon": ["gfx_lighting", {"style": "neon"}],
    "light_tweak": ["gfx_lighting", {"bloom": 1.5, "saturation": 0.2, "dof": 0, "time": 18.5, "rim_color": "#00ff00", "key_brightness": 7}],
    "capture": ["gfx_capture", {}],
    "capture_icon": ["gfx_capture", {"kind": "icon", "name": "My Game!"}],
    "capture_custom": ["gfx_capture", {"width": 1280, "height": 720, "hide_overlay": True, "keep_guides": True}],
    "brief": ["gfx_brief", {"title": "Epic Quest", "genre": "RPG", "style": "cartoony", "subjects": ["a knight", "a dragon pet"], "badge": "NEW"}],
    "brief_icon": ["gfx_brief", {"kind": "icon", "style": "horror"}],
    "teardown": ["gfx_teardown", {}],
    "teardown_again": ["gfx_teardown", {}],
    "stage_icon": ["gfx_stage_create", {"style": "chroma", "kind": "icon", "size": 80, "position": {"x": 10, "y": 500, "z": -20}}],
    "capture_icon2": ["gfx_capture", {}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:500]))


def run(key):
    return run_program(key, data["programs"][key])


same = L.eval("function(a,b) return a == b end")
dist = L.eval("function(a,b) return (a-b).Magnitude end")
look_dot = L.eval("function(cf,p) return cf.LookVector:Dot((p-cf.Position).Unit) end")
G = L.globals()
game = M.game
svc = lambda n: game.GetService(game, n)
WS, LIGHT, SG, CAM = svc("Workspace"), svc("Lighting"), svc("StarterGui"), None
CAM = WS.CurrentCamera
find = lambda inst, name, rec=False: inst.FindFirstChild(inst, name, rec)
children = lambda inst: list(inst.GetChildren(inst).values())
desc = lambda inst: list(inst.GetDescendants(inst).values())
attr = lambda inst, k: inst.GetAttribute(inst, k)
count = lambda inst, cls: sum(1 for d in desc(inst) if d.IsA(d, cls))


def gfx_effects():
    return [c for c in children(LIGHT) if attr(c, "TOTAL_GFX")]


# ───────────────────────── catalogue ─────────────────────────
ok("11 gfx commands registered", len(data["commands"]) == 11 and data["commands"][0] == "gfx_stage_create", data["commands"])
ok("6 styles / 13 poses / 9 faces / 8 cameras / 7 fx", (len(data["styles"]), len(data["poses"]), len(data["faces"]), len(data["cameras"]), len(data["fx"])) == (6, 13, 9, 8, 7))
for k in ("pose_bad", "fx_bad"):
    ok(k + " rejected at build time with the allowed list", data["programs"][k].startswith("--ERR") and "use one of" in data["programs"][k], data["programs"][k][:200])

# ───────────────────────── stage ─────────────────────────
r = run("subject_no_stage")
ok("subject without a stage fails clearly", r.get("ok") is False and "gfx_stage_create" in r.get("error", ""), r)

cam0 = CAM.CFrame
clock0 = LIGHT.ClockTime
r = run("stage")
ok("stage_create ok", r.get("ok") is True and r["data"]["style"] == "cinematic" and r["data"]["kind"] == "thumbnail", r)
root = find(WS, "TOTAL_GFX")
stage = root and find(root, "Stage")
ok("Workspace.TOTAL_GFX.Stage model built", stage is not None and stage.ClassName == "Model")
ok("floor + backdrop + 8 cove slabs", stage and find(stage, "Floor") and find(stage, "Backdrop") and sum(1 for c in children(stage) if c.Name.startswith("Cove_")) == 8)
lights = stage and find(stage, "Lights")
ok("3-point light rig (Key/Fill/Rim SpotLights)", lights and all(find(lights, n) and find(lights, n).FindFirstChildOfClass(find(lights, n), "SpotLight") for n in ("Key", "Fill", "Rim")))
key = find(lights, "Key")
ok("key light aims at the subject spot (LookVector points toward stage origin)", key and (key.CFrame.LookVector.Y < 0) and abs(key.CFrame.LookVector.Magnitude - 1) < 1e-6)
ok("Subjects / Props / FX folders", all(find(stage, n) for n in ("Subjects", "Props", "FX")))
ok("stage pivot at (0,1000,0), size attribute 120", abs(stage.GetPivot(stage).Position.Y - 1000) < 1e-6 and attr(stage, "Size") == 120)
ok("every stage part anchored and non-colliding", all(p.Anchored and not p.CanCollide for p in desc(stage) if p.IsA(p, "BasePart")))
ok("Lighting snapshot taken before restyling", attr(root, "HasSnapshot") is True and attr(root, "Snap_ClockTime") == clock0)
ok("cinematic lighting applied (ClockTime 17.4, Brightness 2)", abs(LIGHT.ClockTime - 17.4) < 1e-6 and LIGHT.Brightness == 2)
effs = gfx_effects()
ok("5 tagged post effects (Bloom, ColorCorrection, DOF, Atmosphere, SunRays)", sorted(e.ClassName for e in effs) == sorted(["BloomEffect", "ColorCorrectionEffect", "DepthOfFieldEffect", "Atmosphere", "SunRaysEffect"]), [e.ClassName for e in effs])
ok("camera snapshotted and moved to the stage", attr(root, "CamSaved") is True and not same(CAM.CFrame, cam0) and CAM.CFrame.Position.Y > 900)
ok("camera looks at the stage (distance within 60 studs of origin)", dist(CAM.CFrame.Position, stage.GetPivot(stage).Position) < 60 and r["data"]["camera"]["preset"] == "three_quarter")
ok("ShowDevelopmentGui enabled so the overlay renders in edit mode", SG.ShowDevelopmentGui is True)
r = run("stage_again")
ok("second stage with replace:false refused", r.get("ok") is False and "replace" in r.get("error", ""), r)

# ───────────────────────── subjects ─────────────────────────
r = run("dummy_hero")
ok("dummy subject ok (R15 hero, 8 joints posed)", r.get("ok") is True and r["data"]["rig"] == "R15" and r["data"]["joints"] == 8, r)
subjects = find(stage, "Subjects")
hero = find(subjects, "Hero")
ok("subject parented under Stage.Subjects with the given name", hero is not None)
ok("classic head reports the face_id hint", "face_id" in r["data"]["face"], r["data"]["face"])
ok("all subject parts anchored, no collisions", all(p.Anchored and not p.CanCollide for p in desc(hero) if p.IsA(p, "BasePart")))
hum = hero.FindFirstChildOfClass(hero, "Humanoid")
ok("humanoid name/health display hidden", hum and hum.NameDisplayDistance == 0)
rs = find(hero, "RightShoulder", True)
ok("posed Motor6D keeps its original C0 in TOTAL_C0 and C0 changed", rs and attr(rs, "TOTAL_C0") is not None and not same(rs.C0, attr(rs, "TOTAL_C0")))
bbcf, bbsz = hero.GetBoundingBox(hero)
ok("subject feet on the stage floor (bbox bottom = 1000)", abs((bbcf.Position.Y - bbsz.Y / 2) - 1000) < 0.01, bbcf.Position.Y - bbsz.Y / 2)
ok("left slot = -X of the stage origin", hero.GetPivot(hero).Position.X < -5)
ok("subject faces the camera (+Z look)", hero.GetPivot(hero).LookVector.Z > 0.99)
ok("pose attribute recorded", attr(hero, "Total_GFX_Pose") == "hero")

r = run("avatar_shocked")
ok("player avatar subject ok (CreateHumanoidModelFromUserId)", r.get("ok") is True and "avatar of user 1" in r["data"]["how"] and r["data"]["face"].startswith("FaceControls"), r)
av = find(subjects, "Player1")
fc = av and find(av, "FaceControls", True)
ok("FaceControls preset applied (JawDrop 0.85, brows up)", fc and abs(fc.JawDrop - 0.85) < 1e-6 and fc.LeftInnerBrowRaiser == 1)
ok("scale 1.2 applied via Model:ScaleTo", av and abs(av.GetScale(av) - 1.2) < 1e-6)
bbcf, bbsz = av.GetBoundingBox(av)
ok("scaled avatar still stands on the floor", abs((bbcf.Position.Y - bbsz.Y / 2) - 1000) < 0.01)
ok("right slot = +X", av.GetPivot(av).Position.X > 5)
r = run("avatar_404")
ok("missing avatar fails with a hint to use dummy", r.get("ok") is False and "could not load avatar 404" in r["error"] and "dummy" in r["error"], r)
r = run("avatar_by_name")
ok("user:Name resolves through GetUserIdFromNameAsync", r.get("ok") is True and find(subjects, "Builder") is not None, r)
r = run("r6")
ok("R6 rig posed through the approximate mapping", r.get("ok") is True and r["data"]["rig"].startswith("R6") and r["data"]["joints"] >= 3, r)
classic = find(subjects, "Classic")
ok("R6 'Right Shoulder' C0 changed", classic and not same(find(classic, "Right Shoulder", True).C0, attr(find(classic, "Right Shoulder", True), "TOTAL_C0")))
ok("4 subjects on stage", len(children(subjects)) == 4)

# ───────────────────────── pose ─────────────────────────
r = run("pose_reset")
ok("pose reset restores every saved C0", r.get("ok") is True and same(rs.C0, attr(rs, "TOTAL_C0")), r)
r = run("pose_jump")
ok("jump pose + shocked face + head yaw", r.get("ok") is True and r["data"]["pose"] == "jump" and r["data"]["joints"] == 11, r)
bbcf, bbsz = hero.GetBoundingBox(hero)
ok("jump lifts the subject 2.5 studs", abs((bbcf.Position.Y - bbsz.Y / 2) - 1002.5) < 0.01, bbcf.Position.Y - bbsz.Y / 2)
r = run("pose_face_id")
ok("face_id sets the head decal texture", r.get("ok") is True and r["data"]["face"] == "decal rbxassetid://123456" and find(hero, "face", True).Texture == "rbxassetid://123456", r)

# ───────────────────────── props ─────────────────────────
L.execute("""
local ws = game:GetService('Workspace')
local sword = Instance.new('Model') sword.Name = 'Sword'
local blade = Instance.new('Part') blade.Name = 'Blade' blade.Size = Vector3.new(0.4, 4, 0.2) blade.CFrame = CFrame.new(5, 2, 5) blade.Parent = sword
local s = Instance.new('Script') s.Name = 'Damage' s.Parent = blade
sword.PrimaryPart = blade sword.Parent = ws
local tool = Instance.new('Tool') tool.Name = 'Blaster'
local h = Instance.new('Part') h.Name = 'Handle' h.Size = Vector3.new(1, 1, 3) h.Parent = tool
local ls = Instance.new('LocalScript') ls.Parent = tool
tool.Parent = ws
""")
r = run("prop")
ok("prop added (float + glow)", r.get("ok") is True and r["data"]["float"] is True and r["data"]["glow"] is True, r)
props = find(stage, "Props")
sword = find(props, "Sword")
ok("prop cloned under Stage.Props, original untouched", sword is not None and find(WS, "Sword") is not None and find(find(WS, "Sword"), "Damage", True) is not None)
ok("scripts stripped from the clone", count(sword, "LuaSourceContainer") == 0)
ok("glow = PointLight + Highlight", count(sword, "PointLight") == 1 and count(sword, "Highlight") == 1)
ok("floating prop is lifted and tilted", sword.GetPivot(sword).Position.Y > 1002 and abs(sword.GetPivot(sword).UpVector.Y) < 0.999)
r = run("prop_tool")
gun = find(props, "Gun")
ok("Tool prop converted to a Model of its parts", r.get("ok") is True and gun is not None and gun.ClassName == "Model" and count(gun, "BasePart") == 1 and count(gun, "LocalScript") == 0, r)

# ───────────────────────── camera ─────────────────────────
r = run("cam_hero")
ok("hero_low: fov 50, camera below the aim point (looking up)", r.get("ok") is True and r["data"]["camera"]["fov"] == 50 and r["data"]["camera"]["position"][1] < r["data"]["camera"]["target"][1], r)
ok("hero_low distance covers all 4 subjects + props", r["data"]["camera"]["subjects"] == 6 and r["data"]["camera"]["distance"] > 20)
d_all = r["data"]["camera"]["distance"]
ok("DOF focus follows the camera distance", any(e.ClassName == "DepthOfFieldEffect" and abs(e.FocusDistance - d_all) < 1e-6 for e in gfx_effects()))
ok("camera Focus set near the target", dist(CAM.Focus.Position, stage.GetPivot(stage).Position) < 40)
r = run("cam_close")
ok("closeup on a target: much shorter distance, fov 40, focused_on reported", r.get("ok") is True and r["data"]["camera"]["distance"] < d_all * 0.5 and r["data"]["camera"]["fov"] == 40 and r["data"]["camera"]["focused_on"].endswith("Hero"), r)
ok("camera CFrame actually looks at the hero", look_dot(CAM.CFrame, hero.GetPivot(hero).Position) > 0.9)
r = run("cam_dutch")
ok("dutch: fov override + distance_scale + roll", r.get("ok") is True and r["data"]["camera"]["fov"] == 45 and r["data"]["camera"]["distance"] > d_all and abs(CAM.CFrame.UpVector.X) > 0.05, r)
ok("camera result includes the frame box in viewport pixels", r["data"]["frame_px"]["w"] == 1280 and r["data"]["frame_px"]["h"] == 720 and r["data"]["viewport"]["w"] == 1280)

# ───────────────────────── overlay ─────────────────────────
r = run("overlay")
ok("overlay ok (Title, Subtitle, Badge, Logo)", r.get("ok") is True and r["data"]["created"] == ["Title", "Subtitle", "Badge", "Logo"] and r["data"]["font"] == "Michroma", r)
ov = find(SG, "Total_GFX_Overlay")
ok("StarterGui.Total_GFX_Overlay ScreenGui, IgnoreGuiInset, DisplayOrder 1000", ov and ov.ClassName == "ScreenGui" and ov.IgnoreGuiInset is True and ov.DisplayOrder == 1000)
box = find(ov, "Box")
title = box and find(box, "Title")
ok("title TextScaled + uppercase + UIStroke + UIGradient + shadow", title and title.TextScaled is True and title.Text == "EPIC QUEST" and title.FindFirstChildOfClass(title, "UIStroke") and title.FindFirstChildOfClass(title, "UIGradient") and find(box, "TitleShadow") is not None)
ok("stroke thickness scales with the frame (>= 4 px at 720p)", title.FindFirstChildOfClass(title, "UIStroke").Thickness >= 4)
guides = find(ov, "Guides")
ok("guides: 4 masks + safe area + 4 third lines, visible", guides and guides.Visible is True and all(find(guides, n) for n in ("Left", "Right", "Top", "Bottom", "SafeArea")) and sum(1 for c in children(guides) if c.Name.startswith("Third_")) == 4)
ok("16:9 box fills a 16:9 viewport (masks zero-width)", find(guides, "Left").Size.X.Scale == 0 and abs(box.Size.X.Scale - 1) < 1e-9)
badge = find(box, "Badge")
ok("badge pill: UICorner, uppercase text, rotated", badge and badge.FindFirstChildOfClass(badge, "UICorner") and find(badge, "Text").Text == "NEW" and badge.Rotation == -8)
ok("logo ImageLabel with aspect constraint", find(box, "Logo") and find(box, "Logo").FindFirstChildOfClass(find(box, "Logo"), "UIAspectRatioConstraint"))
r = run("overlay_icon")
ov = find(SG, "Total_GFX_Overlay")
box = find(ov, "Box")
ok("overlay rebuilt for 1:1 (old one replaced, neon font Arcade, guides hidden)", r.get("ok") is True and len([c for c in children(SG) if c.Name == "Total_GFX_Overlay"]) == 1 and r["data"]["font"] == "Arcade" and find(ov, "Guides").Visible is False, r)
ok("1:1 box is centred and 720 px wide on a 1280x720 viewport", abs(box.Size.X.Scale - 720 / 1280) < 1e-6 and abs(box.Position.X.Scale - (1280 - 720) / 2 / 1280) < 1e-6)
ok("center placement anchors the title at 0.5,0.5", find(box, "Title").AnchorPoint.X == 0.5 and find(box, "Title").Position.Y.Scale == 0.5)
r = run("overlay_clear")
ok("overlay clear removes the ScreenGui", r.get("ok") is True and find(SG, "Total_GFX_Overlay") is None, r)
run("overlay")

# ───────────────────────── fx ─────────────────────────
r = run("fx_sparkles")
fxf = find(stage, "FX")
ok("sparkles emitter on an invisible stage volume, rate doubled", r.get("ok") is True and count(fxf, "ParticleEmitter") == 1 and r["data"]["rate"] == 80, r)
pe = fxf.FindFirstChildWhichIsA(fxf, "ParticleEmitter", True)
ok("emitter has NumberRange lifetime/speed, ColorSequence, texture", pe and pe.Lifetime["Min"] == 1 and pe.Color["Keypoints"] is not None and pe.Texture.startswith("rbxasset://"))
r = run("fx_attach")
hrp = find(hero, "HumanoidRootPart")
ok("attached fx lives in the subject's HumanoidRootPart with the colour override", r.get("ok") is True and r["data"]["attached"].endswith("Hero") and find(hrp, "FX_magic") is not None, r)
r = run("fx_rays")
ok("rays = SunRays effect tagged TOTAL_GFX + rim boosted", r.get("ok") is True and find(LIGHT, "Total_GFX_Rays") is not None and find(lights, "Rim").Light.Brightness == 6, r)
r = run("fx_clear")
ok("fx clear empties Stage.FX and removes the rays", r.get("ok") is True and len(children(fxf)) == 0 and find(LIGHT, "Total_GFX_Rays") is None, r)

# ───────────────────────── lighting ─────────────────────────
r = run("light_neon")
ok("restyle to neon: ClockTime 0, 3 effects, rig + backdrop recoloured", r.get("ok") is True and LIGHT.ClockTime == 0 and sorted(e.ClassName for e in gfx_effects()) == sorted(["BloomEffect", "ColorCorrectionEffect", "Atmosphere"]) and attr(stage, "Style") == "neon", r)
ok("backdrop takes the neon colour", abs(find(stage, "Backdrop").Color.R - 12 / 255) < 1e-6 and abs(find(stage, "Backdrop").Color.B - 30 / 255) < 1e-6)
r = run("light_tweak")
bloom = [e for e in gfx_effects() if e.ClassName == "BloomEffect"][0]
ok("tweaks: bloom 1.5, saturation 0.2, time 18.5, rim colour, key brightness", r.get("ok") is True and bloom.Intensity == 1.5 and LIGHT.ClockTime == 18.5 and find(lights, "Key").Light.Brightness == 7 and abs(find(lights, "Rim").Light.Color.G - 1) < 1e-6, r)
ok("dof 0 removes the DOF effect", not any(e.ClassName == "DepthOfFieldEffect" for e in gfx_effects()))
ok("change list reported", set(r["data"]["changed"]) >= {"bloom", "color", "time", "rig lights", "dof"}, r["data"]["changed"])

# ───────────────────────── capture ─────────────────────────
r = run("capture")
ok("capture prep ok: 1920x1080 thumbnail, full-frame box on a 16:9 viewport", r.get("ok") is True and r["data"]["out"] == {"w": 1920, "h": 1080} and r["data"]["box"] == {"x": 0, "y": 0, "w": 1, "h": 1}, r)
ok("capture prep hides the guides, keeps the overlay, clears the selection", find(find(SG, "Total_GFX_Overlay"), "Guides").Visible is False and find(SG, "Total_GFX_Overlay").Enabled is True and len(M.selection) == 0)
ok("file name + settle + upscale warning (viewport narrower than 3/4 of the output)", r["data"]["file"] == "Total_thumbnail_1920x1080.png" and r["data"]["settle_ms"] == 700 and any("upscaled" in w for w in r["data"]["warnings"]), r["data"])
r = run("capture_icon")
ok("icon capture: 512x512 from a centred 1:1 box, sanitised name", r.get("ok") is True and r["data"]["out"] == {"w": 512, "h": 512} and abs(r["data"]["box"]["w"] - 720 / 1280) < 1e-9 and r["data"]["box"]["h"] == 1 and r["data"]["file"] == "My_Game__512x512.png", r)
r = run("capture_custom")
ok("custom size + hide_overlay + keep_guides", r.get("ok") is True and r["data"]["out"] == {"w": 1280, "h": 720} and find(SG, "Total_GFX_Overlay").Enabled is False and find(find(SG, "Total_GFX_Overlay"), "Guides").Visible is True, r)

# ───────────────────────── brief ─────────────────────────
r = run("brief")
d = r.get("data", {})
ok("brief: prompt mentions title, subjects, cartoony style and 16:9", r.get("ok") is True and "Epic Quest" in d.get("prompt", "") and "a knight and a dragon pet" in d["prompt"] and "cartoony" in d["prompt"] and "16:9" in d["prompt"], r)
ok("brief: negative prompt, 8-point CTR checklist, 7-command Studio recipe with the badge", d.get("negative_prompt") and len(d.get("checklist", [])) == 8 and len(d.get("studio_recipe", [])) == 7 and 'badge:"NEW"' in d["studio_recipe"][3])
ok("brief stores the title on the stage for capture file names", attr(stage, "Title") == "Epic Quest")
r = run("brief_icon")
ok("icon brief: square, horror, scared face, no text when no title", r.get("ok") is True and r["data"]["prompt"].startswith("Square Roblox game icon") and "scared" in r["data"]["prompt"] and "No text." in r["data"]["prompt"] and r["data"]["size"].startswith("512"), r)

# ───────────────────────── teardown ─────────────────────────
r = run("teardown")
ok("teardown ok", r.get("ok") is True and len(r["data"]["done"]) >= 4, r)
ok("Lighting restored to the snapshot (ClockTime back)", LIGHT.ClockTime == clock0 and len(gfx_effects()) == 0)
ok("camera restored", same(CAM.CFrame, cam0) and CAM.FieldOfView == 70)
ok("overlay, stage and TOTAL_GFX folder removed", find(SG, "Total_GFX_Overlay") is None and find(WS, "TOTAL_GFX") is None)
ok("original Sword still in Workspace", find(WS, "Sword") is not None)
r = run("teardown_again")
ok("second teardown is a clean no-op", r.get("ok") is True and "nothing to tear down" in r.get("text", ""), r)

# ───────────────────────── icon stage ─────────────────────────
r = run("stage_icon")
stage = find(find(WS, "TOTAL_GFX"), "Stage")
ok("chroma icon stage: 1:1, size 80, custom origin, no post effects, no shadows", r.get("ok") is True and r["data"]["aspect"] == 1 and attr(stage, "Size") == 80 and abs(stage.GetPivot(stage).Position.Z + 20) < 1e-6 and len(gfx_effects()) == 0 and LIGHT.GlobalShadows is False, r)
ok("chroma backdrop is pure green", find(stage, "Backdrop").Color.G == 1 and find(stage, "Backdrop").Color.R == 0)
ok("icon camera preset selected", r["data"]["camera"]["preset"] == "icon" and r["data"]["camera"]["fov"] == 35)
r = run("capture_icon2")
ok("capture inherits kind=icon from the stage (512x512, 1:1 box)", r.get("ok") is True and r["data"]["kind"] == "icon" and r["data"]["out"]["w"] == 512 and abs(r["data"]["box"]["w"] - 0.5625) < 1e-9, r)
ok("no warnings from the Lua model (warn() never called)", len(list(M.warnings.values())) == 0, list(M.warnings.values()))

passed = sum(results)
print("\n%d passed, %d failed" % (passed, len(results) - passed))
sys.exit(0 if passed == len(results) else 1)
