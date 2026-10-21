#!/usr/bin/env python3
"""Execute the 1.52.0 animation-engine Studio ops (rig_info / build) against the
miniature Roblox DataModel with REAL rigs (R15 + R6 built from Motor6Ds), and
prove the Luau side writes exactly the Pose CFrames the JS engine predicts.

    pip install lupa && python3 tests/anim-sim.py          (from the ORscript root)
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
global.window=global;
vm.runInThisContext(fs.readFileSync("src/core/animlib.js","utf8"),{filename:"animlib.js"});
const E=require("./src/core/animengine.js");
const out={programs:{}, expect:{}};
const prompt="extremely fluid anime sword combo with anticipation, rapid strikes, a spinning finisher and a dramatic landing";
const clip=E.generate(prompt,{quality:"high",name:"SwordCombo"});
const idle=E.generate("looping idle, calm breathing",{quality:"balanced",name:"IdleLoop"});
const r15=E.defaultRigInfo("R15"), r6=E.defaultRigInfo("R6");
// the sim rigs have identity C0 rotations -> expectation uses identity c0; the "real R6" case patches C0 in Lua and expects the engine's R6_C0 table
const ident=(info)=>({rigType:info.rigType,bones:info.bones.map(b=>({name:b.name,parent:b.parent,c0:[1,0,0,0,1,0,0,0,1]}))});
out.programs.rig_info=RSAnim.buildLuau("rig_info",{}).code;
out.programs.rig_info_named=RSAnim.buildLuau("rig_info",{name:"SwordCombo"}).code;
out.programs.build_r15=RSAnim.buildLuau("build",E.toBuildArgs(clip,r15)).code;
out.programs.build_r15_again=RSAnim.buildLuau("build",Object.assign(E.toBuildArgs(clip,r15),{overwrite:false})).code;
out.programs.build_idle=RSAnim.buildLuau("build",E.toBuildArgs(idle,r15)).code;
out.programs.build_r6=RSAnim.buildLuau("build",E.toBuildArgs(clip,r6)).code;
out.programs.build_r6_real=RSAnim.buildLuau("build",Object.assign(E.toBuildArgs(clip,r6),{name:"SwordComboR6Real"})).code;
out.programs.build_wrong_bones=RSAnim.buildLuau("build",Object.assign(E.toBuildArgs(clip,r6),{name:"Wrong"})).code; // R6 bone names on an R15 rig
const unit={name:"Unit",duration:1,loop:false,priority:"Action",fps:30,quality:"fast",params:{},prompt:"unit",rigType:"R6",stages:[],keys:[{t:0,poses:{r_shoulder:{rot:[90,0,0]},l_shoulder:{rot:[90,0,0]},root:{rot:[0,0,0],pos:[0,0.5,0]}},ease:["Linear","Out"],tag:"start"},{t:1,poses:{r_shoulder:{rot:[0,0,90]}},ease:["Linear","Out"],tag:"end"}]};
out.programs.build_unit=RSAnim.buildLuau("build",E.toBuildArgs(unit,r6)).code;
out.programs.build_empty=RSAnim.buildLuau("build",{name:"Empty",duration:1,bones:["Head"],keys:[]}).err||"--ERR none";
out.programs.inspect=RSAnim.buildLuau("inspect",{}).code;
out.programs.simulate=RSAnim.buildLuau("simulate",{all:true}).code;
out.programs.preview=RSAnim.buildLuau("preview",{t:0.5}).code;
out.expect.r15=E.toStudio(clip,ident(r15)).keyframes;
out.expect.r6=E.toStudio(clip,ident(r6)).keyframes;
out.expect.r6real=E.toStudio(clip,r6).keyframes;
out.expect.keys=clip.keys.length; out.expect.duration=clip.duration; out.expect.idleKeys=idle.keys.length;
out.expect.markers=E.toBuildArgs(clip,r15).keys.reduce((n,k)=>n+k.m.length,0);
process.stdout.write(JSON.stringify(out));
"""

data = json.loads(subprocess.check_output(["node", "-e", GEN], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:600]))


def run(key):
    return run_program(key, data["programs"][key])


G = L.globals()
game = M.game
svc = lambda n: game.GetService(game, n)
WS, SS = svc("Workspace"), svc("ServerStorage")
find = lambda inst, name, rec=False: inst.FindFirstChild(inst, name, rec)
children = lambda inst: list(inst.GetChildren(inst).values())

# ───────────────────────── no rig ─────────────────────────
res = run("rig_info")
ok("rig_info without a rig fails with a clear error", not res["ok"] and "no rig" in res["error"], res)
res = run("build_r15")
ok("build without a rig fails (no fabricated animation)", not res["ok"] and "no rig" in res["error"], res)

# ───────────────────────── R15 rig ─────────────────────────
L.execute("local M=...; local rig=M.buildRig(Enum.HumanoidRigType.R15, 'R15Dummy'); rig.Parent=M.game:GetService('Workspace')", M)
res = run("rig_info")
ok("rig_info detects R15 with 15 bones", res["ok"] and res["data"]["rigType"] == "R15" and len(res["data"]["bones"]) == 15 and res["data"]["root"] == "HumanoidRootPart", res)
names = [b["name"] for b in res["data"]["bones"]]
ok("rig_info lists the R15 bone names with parents", "LowerTorso" in names and "RightHand" in names and next(b for b in res["data"]["bones"] if b["name"] == "Head")["parent"] == "UpperTorso", res["data"]["bones"][:4])
ok("rig_info reports no stored clip yet", res["data"].get("clip") is None and res["data"]["animations"] == [], res["data"].get("clip"))

res = run("build_r15")
ok("build writes the sword combo (keyframes, poses, markers)", res["ok"] and res["data"]["keyframes"] == data["expect"]["keys"] and res["data"]["bones"] == 15 and res["data"]["missingBones"] == [] and res["data"]["markers"] == data["expect"]["markers"], res)
lib = find(find(SS, "RobloxScript"), "AnimLib")
seq = find(lib, "SwordCombo")
ok("KeyframeSequence lives in the AnimLib with Duration + attributes", seq is not None and seq.Loop is False and seq.Priority.Name == "Action" and abs(find(seq, "Duration").Value - data["expect"]["duration"]) < 1e-6 and seq.GetAttribute(seq, "OR_Prompt").startswith("extremely fluid") and seq.GetAttribute(seq, "OR_Quality") == "high", seq and seq.GetAttributes(seq))
kfs = list(seq.GetKeyframes(seq).values())
ok("one Keyframe per engine key, times ascending", len(kfs) == data["expect"]["keys"] and all(kfs[i].Time < kfs[i + 1].Time for i in range(len(kfs) - 1)), [k.Time for k in kfs][:6])
saves = find(find(WS, "R15Dummy"), "AnimSaves")
ok("a copy is saved under rig.AnimSaves for the Animation Editor", saves is not None and find(saves, "SwordCombo") is not None and len(list(find(saves, "SwordCombo").GetKeyframes(find(saves, "SwordCombo")).values())) == len(kfs), saves)


def pose_by_name(kf):
    out = {}

    def walk(p):
        out[p.Name] = p
        for sub in p.GetSubPoses(p).values():
            walk(sub)
    for p in kf.GetPoses(kf).values():
        walk(p)
    return out


def cf_numbers(cf):
    R = cf.__R
    p = cf.Position
    return [p.X, p.Y, p.Z] + [R[i] for i in range(1, 10)]


def compare(kfs, expected, label):
    worst = 0.0
    checked = 0
    for kf, exp in zip(kfs, expected):
        poses = pose_by_name(kf)
        for e in exp["poses"]:
            got = cf_numbers(poses[e["bone"]].CFrame)
            for a, b in zip(got, e["cf"]):
                worst = max(worst, abs(a - b))
            checked += 1
    ok(label + " (%d poses, max |delta| %.2e)" % (checked, worst), checked > 0 and worst < 2e-3, worst)


compare(kfs, data["expect"]["r15"], "R15 Pose CFrames equal the JS engine's toStudio() matrices")
poses0 = pose_by_name(kfs[0])
ok("pose tree is nested per Motor6D chain (HumanoidRootPart > LowerTorso > UpperTorso > Head)", poses0["Head"].Parent.Name == "UpperTorso" and poses0["UpperTorso"].Parent.Name == "LowerTorso" and poses0["LowerTorso"].Parent.Name == "HumanoidRootPart", {k: v.Parent.Name for k, v in poses0.items()})
ok("easing is applied to every pose of the keyframe", all(p.EasingStyle.Name in ("CubicV2", "Linear", "Elastic", "Bounce", "Constant") for p in poses0.values()), [p.EasingStyle.Name for p in poses0.values()][:3])
impact = next((k for k in kfs if any(m.Name == "impact" for m in k.GetMarkers(k).values())), None)
ok("impact keyframes carry KeyframeMarkers", impact is not None, None)

res = run("build_r15_again")
ok("build refuses to overwrite silently (overwrite=false)", not res["ok"] and "ALREADY EXISTS" in res["error"], res)
res = run("rig_info_named")
ok("rig_info returns the stored engine attributes for refine", res["ok"] and res["data"]["clip"]["name"] == "SwordCombo" and res["data"]["clip"]["quality"] == "high" and res["data"]["clip"]["keyframes"] == data["expect"]["keys"] and "attackSpeed" in res["data"]["clip"]["params"], res["data"].get("clip"))
res = run("inspect")
ok("existing animation_inspect works on the engine-built clip", res["ok"] and len(res["data"]["keyframes"]) == data["expect"]["keys"], res)
res = run("build_idle")
ok("second clip (idle loop) builds and becomes active", res["ok"] and res["data"]["keyframes"] == data["expect"]["idleKeys"] and find(lib, "IdleLoop").Loop is True and find(lib, "IdleLoop").Priority.Name == "Idle", res)
res = run("build_wrong_bones")
ok("R6 bone names on an R15 rig are rejected with both bone lists", not res["ok"] and "wrong rig type" in res["error"] and "Right Arm" in res["error"] and "RightUpperArm" in res["error"], res)
ok("empty clip is rejected before reaching Studio", data["programs"]["build_empty"].startswith("ERROR") and "no keyframes" in data["programs"]["build_empty"], data["programs"]["build_empty"])
res = run("simulate")
ok("animation_simulate QA sweep runs on the engine clip", res["ok"], res)

# ───────────────────────── R6 rig ─────────────────────────
L.execute("local M=...; local ws=M.game:GetService('Workspace'); ws:FindFirstChild('R15Dummy'):Destroy(); local rig=M.buildRig(Enum.HumanoidRigType.R6, 'R6Dummy'); rig.Parent=ws", M)
res = run("rig_info")
ok("rig_info detects R6 with 6 bones", res["ok"] and res["data"]["rigType"] == "R6" and len(res["data"]["bones"]) == 6 and "Right Arm" in [b["name"] for b in res["data"]["bones"]], res)
res = run("build_r6")
ok("build maps the same clip onto R6 (6 bones, elbows/knees folded)", res["ok"] and res["data"]["bones"] == 6 and res["data"]["missingBones"] == [], res)
seq6 = find(lib, "SwordCombo")
kfs6 = list(seq6.GetKeyframes(seq6).values())
compare(kfs6, data["expect"]["r6"], "R6 (identity C0) Pose CFrames equal the engine prediction")
# real R6 joint frames: rotate the shoulder/hip C0s like the classic rig and rebuild under another name
L.execute("""local M=...; local rig=M.game:GetService('Workspace'):FindFirstChild('R6Dummy')
local function rot(name, r) local m=rig:FindFirstChild(name,true) m.C0 = CFrame.new(m.C0.Position) * CFrame.new(0,0,0, table.unpack(r)) end
rot('Right Shoulder', {0,0,1, 0,1,0, -1,0,0}) rot('Right Hip', {0,0,1, 0,1,0, -1,0,0})
rot('Left Shoulder', {0,0,-1, 0,1,0, 1,0,0}) rot('Left Hip', {0,0,-1, 0,1,0, 1,0,0})
rot('RootJoint', {-1,0,0, 0,0,1, 0,1,0}) rot('Neck', {-1,0,0, 0,0,1, 0,1,0})""", M)
res = run("build_r6_real")
ok("build on a real-frame R6 rig succeeds", res["ok"], res)
seq6r = find(lib, "SwordComboR6Real")
compare(list(seq6r.GetKeyframes(seq6r).values()), data["expect"]["r6real"], "real R6 C0 frames: Luau conjugation equals the engine's R6_C0 prediction")
# unit check of the classic-rig convention: a +90 X (forward swing) on the right shoulder becomes a +90 rotation about the
# joint's LOCAL Z (whose axis is world X on R6); the left shoulder becomes -90 about local Z; a root lift of 0.5 studs
# becomes a local-Z translation because the RootJoint frame maps local Z to world up.
res = run("build_unit")
ok("unit clip builds on the real-frame R6 rig", res["ok"], res)
unit = find(lib, "Unit")
ukf = list(unit.GetKeyframes(unit).values())
up = pose_by_name(ukf[0])
Rr = up["Right Arm"].CFrame.__R
Rl = up["Left Arm"].CFrame.__R
ok("R6 right arm forward swing = +90 about local Z (classic Motor6D convention)", abs(Rr[1]) < 1e-6 and abs(Rr[2] + 1) < 1e-6 and abs(Rr[4] - 1) < 1e-6 and abs(Rr[9] - 1) < 1e-6, Rr)
ok("R6 left arm forward swing = -90 about local Z", abs(Rl[1]) < 1e-6 and abs(Rl[2] - 1) < 1e-6 and abs(Rl[4] + 1) < 1e-6 and abs(Rl[9] - 1) < 1e-6, Rl)
tp = up["Torso"].CFrame.Position
ok("R6 root lift of 0.5 studs lands on the RootJoint's local Z axis", abs(tp.X) < 1e-6 and abs(tp.Y) < 1e-6 and abs(tp.Z - 0.5) < 1e-6, (tp.X, tp.Y, tp.Z))
Rr2 = pose_by_name(ukf[1])["Right Arm"].CFrame.__R
ok("R6 right arm +90 Z (sideways raise) = -90 about local X", abs(Rr2[1] - 1) < 1e-6 and abs(Rr2[5]) < 1e-6 and abs(Rr2[6] - 1) < 1e-6 and abs(Rr2[8] + 1) < 1e-6, Rr2)

print("\n%d/%d passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
