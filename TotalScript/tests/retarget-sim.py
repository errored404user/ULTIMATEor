#!/usr/bin/env python3
"""animation_retarget + animation_library (2.11.0) against the miniature Roblox DataModel.

Builds an R15 rig AND an R6 rig from Motor6Ds, writes a real engine clip on the R15, then
runs the REAL generated Luau:

  retarget R15 -> R6   same keyframe count / times, canonical R6 pose tree, 'Left Arm' CFrame
                       == LeftUpperArm * LeftLowerArm of the source (composed), Torso ==
                       LowerTorso * UpperTorso, hand / foot poses reported as dropped, Loop /
                       Priority / easing / markers copied, pinned to the R6 rig, opened
  retarget R6 -> R15   upper joint carries the pose, lower joints identity, round trip keeps
                       the composed rotation; same-type refusal; save_as / overwrite;
                       scale_positions; unknown rig_path
  library              list (rig types, tags, active marker), tag, search by text / tag / rig,
                       export (all keyframes), rename (follows the active clip), delete, unknown op

Mock DataModel only - a real Studio run is still the final word.

    pip install lupa && python3 tests/retarget-sim.py          (from the TotalScript root)
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
vm.runInThisContext(fs.readFileSync("src/core/animlib.js","utf8"),{filename:"animlib.js"});
const E=require("./src/core/animengine.js");
const out={programs:{}, errors:{}};
const clip=E.generate("heavy two-handed overhead slam with a long wind-up",{quality:"balanced",name:"Slam"});
const r15=E.defaultRigInfo("R15");
const P=(k,op,a)=>{ const b=RSAnim.buildLuau(op,a); if(b.err){ out.errors[k]=b.err; out.programs[k]="return '--ERR'"; } else out.programs[k]=b.code; };
P("select_r15","select_rig",{path:"Workspace.R15Dummy"});
P("build_slam","build",Object.assign(E.toBuildArgs(clip,r15),{loop:true}));
P("set_marker","set_marker",{t:0,name:"Hit",value:"slam"});
P("ease","set_easing",{t:0,style:"Bounce",direction:"In",bones:["LeftUpperArm"]});
P("to_r6","retarget",{to:"r6"});
P("to_r6_again","retarget",{to:"R6",name:"Slam"});
P("to_r6_overwrite","retarget",{to:"R6",name:"Slam",overwrite:true,save_as:"SlamSix",scale_positions:2});
P("same_type","retarget",{to:"R15",name:"Slam"});
P("back_to_r15","retarget",{to:"R15",name:"Slam_R6",save_as:"SlamBack"});
P("bad_rig_path","retarget",{to:"R6",name:"Slam",rig_path:"Workspace.Nope",save_as:"X"});
P("missing_clip","retarget",{to:"R6",name:"Ghost"});
P("lib_list","library",{});
P("lib_tag","library",{op:"tag",name:"Slam",tags:["combat","heavy"],notes:"overhead slam, 2 hands"});
P("lib_tag_csv","library",{op:"tag",name:"Slam_R6",tags:"combat, r6"});
P("lib_search","library",{op:"search",query:"overhead"});
P("lib_search_tag","library",{op:"search",tag:"r6"});
P("lib_search_rig","library",{op:"search",rig:"R15"});
P("lib_export","library",{op:"export",name:"Slam"});
P("lib_rename","library",{op:"rename",name:"SlamBack",new_name:"SlamBackR15"});
P("lib_rename_clash","library",{op:"rename",name:"SlamSix",new_name:"Slam"});
P("lib_delete","library",{op:"delete",name:"SlamSix"});
P("lib_list_after","library",{op:"list"});
P("lib_bad_op","library",{op:"nope"});
P("to_bad","retarget",{to:"R7"});
P("lib_rename_noname","library",{op:"rename",new_name:"Z"});
process.stdout.write(JSON.stringify(out));
"""
gen = subprocess.run(["node", "-e", GEN], capture_output=True, text=True)
if gen.returncode != 0:
    print("FAIL  generator: " + gen.stderr[-1500:])
    sys.exit(1)
data = json.loads(gen.stdout)
programs, errors = data["programs"], data["errors"]

passed = failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS  " + name)
    else:
        failed += 1
        print("FAIL  " + name + ("  -- " + str(detail)[:900] if detail != "" else ""))

L, M, run_program = make_runtime()
L.globals()["M"] = M
def run(key):
    return run_program(key, programs[key])

L.execute("local M=...; local ws=M.game:GetService('Workspace'); local a=M.buildRig(Enum.HumanoidRigType.R15, 'R15Dummy'); a.Parent=ws; local b=M.buildRig(Enum.HumanoidRigType.R6, 'R6Dummy'); b.Parent=ws", M)

ok("JS: 'to' must be R6 or R15; rename needs a name", "R6 or R15" in errors.get("to_bad", "") and "'name' is required" in errors.get("lib_rename_noname", ""), errors)
r = run("select_r15"); ok("setup: R15 rig selected", r["ok"], r)
r = run("build_slam"); ok("setup: engine clip 'Slam' built on the R15 (looping)", r["ok"] and r["data"]["keyframes"] > 2, r)
run("set_marker"); r = run("ease"); ok("setup: marker + Bounce/In easing on LeftUpperArm at t=0", r["ok"], r)

LUA_CF = r"""
function(clipName, t, bone)
  local lib = game:GetService('ServerStorage'):FindFirstChild('RobloxScript') or game:GetService('ServerStorage'):FindFirstChild('AnimScript')
  local anim = lib.AnimLib:FindFirstChild(clipName)
  if not anim then return nil end
  for _, kf in ipairs(anim:GetKeyframes()) do
    if math.abs(kf.Time - t) < 0.001 then
      local found
      local function scan(p) if p.Name == bone then found = p end for _, s in ipairs(p:GetSubPoses()) do scan(s) end end
      for _, p in ipairs(kf:GetPoses()) do scan(p) end
      if found then return found end
    end
  end
  return nil
end
"""
poseAt = L.eval(LUA_CF)
def cfnums(cf):
    comps = cf.GetComponents(cf)
    comps = list(comps.values()) if hasattr(comps, "values") else list(comps)
    return [round(float(x), 4) for x in comps]
def mul(a, b):
    return L.eval("function(a, b) return a * b end")(a, b)
def approx(a, b, tol=1e-3):
    return len(a) == len(b) and all(abs(a[i] - b[i]) < tol for i in range(len(a)))
def scaled(nums, k):
    return [nums[0] * k, nums[1] * k, nums[2] * k] + nums[3:]

src = run("lib_list")
slam_meta = next(c for c in src["data"]["clips"] if c["name"] == "Slam")
times = [kf["t"] for kf in run_program("probe", programs["lib_export"])["data"]["keyframes"]]
mid = times[len(times) // 2]

r = run("to_r6")
ok("retarget R15 -> R6: ok, from R15 to R6, same keyframe count, saved as Slam_R6, pinned to R6Dummy and opened", r["ok"] and r["data"]["from"] == "R15" and r["data"]["to"] == "R6" and r["data"]["keyframes"] == slam_meta["keyframes"] and r["data"]["name"] == "Slam_R6" and r["data"]["rig"] == "R6Dummy" and r["data"]["pinned"] is True and r["data"]["inspect"]["bones"] == ["Head", "HumanoidRootPart", "Left Arm", "Left Leg", "Right Arm", "Right Leg", "Torso"], r)
ok("joint map reported: UpperArm*LowerArm -> Left Arm etc, hands / feet dropped listed as approximations, no unmapped joints", any(m.startswith("LeftUpperArm*LeftLowerArm -> Left Arm") for m in r["data"]["mapped"]) and any("LowerTorso*UpperTorso -> Torso" == m for m in r["data"]["mapped"]) and r["data"]["unmapped"] == [] and any("composed" in x for x in r["data"]["approximations"]), r["data"])
k = r["data"]["scale_positions"]
ok("positions scaled by the rig height ratio (R6 dummy / R15 dummy), a number between 0.5 and 1.5 reported as scale_positions", isinstance(k, (int, float)) and 0.5 < k < 1.5 and k != 0, k)
la = poseAt("Slam_R6", mid, "Left Arm"); ua = poseAt("Slam", mid, "LeftUpperArm"); lo = poseAt("Slam", mid, "LeftLowerArm")
ok("Left Arm CFrame == LeftUpperArm * LeftLowerArm of the source at the middle keyframe (position x scale)", la is not None and approx(cfnums(la.CFrame), scaled(cfnums(mul(ua.CFrame, lo.CFrame)), k)), (la and cfnums(la.CFrame), ua and cfnums(mul(ua.CFrame, lo.CFrame)), k))
to = poseAt("Slam_R6", mid, "Torso"); lt = poseAt("Slam", mid, "LowerTorso"); ut = poseAt("Slam", mid, "UpperTorso")
ok("Torso CFrame == LowerTorso * UpperTorso (position x scale)", to is not None and approx(cfnums(to.CFrame), scaled(cfnums(mul(lt.CFrame, ut.CFrame)), k)), (to and cfnums(to.CFrame), lt and cfnums(lt.CFrame), ut and cfnums(ut.CFrame)))
st = L.eval("function() local lib = game:GetService('ServerStorage'):FindFirstChild('RobloxScript') or game:GetService('ServerStorage'):FindFirstChild('AnimScript') local a = lib.AnimLib.Slam_R6 local kf0 for _, kf in ipairs(a:GetKeyframes()) do if kf.Time == 0 then kf0 = kf end end local la local function scan(p) if p.Name == 'Left Arm' then la = p end for _, s in ipairs(p:GetSubPoses()) do scan(s) end end for _, p in ipairs(kf0:GetPoses()) do scan(p) end return M.jsonEncode({loop = a.Loop, prio = a.Priority.Name, markers = #kf0:GetMarkers(), marker = (function() for _, mk in ipairs(kf0:GetMarkers()) do if mk.Name == 'Hit' then return mk.Value end end return nil end)(), ease = la.EasingStyle.Name, dir = la.EasingDirection.Name, attr = a:GetAttribute('Total_Retarget'), src = a:GetAttribute('Total_Source'), active = lib.AnimLib:FindFirstChild('Active').Value, pin = a:GetAttribute('RS_RigPath')}) end")()
st = json.loads(st)
ok("Loop / Priority / markers (engine ready + Hit) / easing (Bounce In from LeftUpperArm) copied; attributes Total_Retarget=R15->R6, Total_Source=Slam; active clip is Slam_R6; RS_RigPath = Workspace.R6Dummy", st["loop"] is True and st["prio"] == "Action" and st["markers"] == 2 and st["marker"] == "slam" and st["ease"] == "Bounce" and st["dir"] == "In" and st["attr"] == "R15->R6" and st["src"] == "Slam" and st["active"] == "Slam_R6" and st["pin"].endswith("R6Dummy"), st)
ok("text names source / target / keyframes / pin and the elbow-bend caveat", "retargeted 'Slam' (R15) -> 'Slam_R6' (R6)" in r["text"] and "Pinned to rig 'R6Dummy'" in r["text"] and "elbow / knee" in r["text"], r["text"])

r = run("to_r6_again"); ok("second retarget to the same name refuses without overwrite", not r["ok"] and "ALREADY EXISTS" in r["error"], r)
r = run("to_r6_overwrite")
ok("save_as + overwrite + scale_positions:2 -> 'SlamSix' with positions doubled", r["ok"] and r["data"]["name"] == "SlamSix" and r["data"]["scale_positions"] == 2, r)
la2 = poseAt("SlamSix", mid, "Left Arm")
p1 = cfnums(la.CFrame)[:3]; p2 = cfnums(la2.CFrame)[:3]
ok("…SlamSix Left Arm position == 2 x Slam_R6 position, rotation identical", all(abs(p2[i] - 2 * p1[i]) < 1e-3 for i in range(3)) and cfnums(la.CFrame)[3:] == cfnums(la2.CFrame)[3:], (p1, p2))
r = run("same_type"); ok("R15 clip -> R15 refused ('already an R15 animation')", not r["ok"] and "already an R15" in r["error"], r)
r = run("bad_rig_path"); ok("unknown rig_path is an explicit error", not r["ok"] and "rig_path" in r["error"], r)
r = run("missing_clip"); ok("missing source clip is an explicit error", not r["ok"] and "Ghost" in r["error"], r)

r = run("back_to_r15")
ok("retarget R6 -> R15 ('Slam_R6' -> 'SlamBack'): R15 pose tree, pinned to R15Dummy, approximations say lower joints stay identity", r["ok"] and r["data"]["from"] == "R6" and r["data"]["to"] == "R15" and r["data"]["rig"] == "R15Dummy" and "LeftUpperArm" in r["data"]["inspect"]["bones"] and "LeftHand" in r["data"]["inspect"]["bones"] and any("stay identity" in x for x in r["data"]["approximations"]), r)
up = poseAt("SlamBack", mid, "LeftUpperArm"); low = poseAt("SlamBack", mid, "LeftLowerArm"); hand = poseAt("SlamBack", mid, "LeftHand")
ident = cfnums(L.eval("function() return CFrame.new() end")())
kb = r["data"]["scale_positions"]
ok("round trip: LeftUpperArm == composed 'Left Arm' (position x inverse scale); LeftLowerArm and LeftHand identity", approx(cfnums(up.CFrame), scaled(cfnums(la.CFrame), kb)) and abs(kb * k - 1) < 0.01 and cfnums(low.CFrame) == ident and cfnums(hand.CFrame) == ident, (cfnums(up.CFrame), cfnums(la.CFrame), kb, k))

r = run("lib_list")
names = [c["name"] for c in r["data"]["clips"]]
ok("library list: 4 clips sorted, with rig_type, keyframes, loop, retarget lineage, active marker on SlamBack", r["ok"] and names == ["Slam", "SlamBack", "SlamSix", "Slam_R6"] and {c["name"]: c["rig_type"] for c in r["data"]["clips"]} == {"Slam": "R15", "SlamBack": "R15", "SlamSix": "R6", "Slam_R6": "R6"} and next(c for c in r["data"]["clips"] if c["name"] == "SlamBack")["active"] is True and next(c for c in r["data"]["clips"] if c["name"] == "Slam_R6")["retarget"] == "R15->R6" and "SlamBack*" in r["text"], r)
r = run("lib_tag"); ok("tag Slam with [combat, heavy] + notes", r["ok"] and r["data"]["tags"] == ["combat", "heavy"] and r["data"]["notes"] == "overhead slam, 2 hands" and "[combat, heavy]" in r["text"], r)
r = run("lib_tag_csv"); ok("tag with a comma list trims spaces", r["ok"] and r["data"]["tags"] == ["combat", "r6"], r)
r = run("lib_search"); ok("search 'overhead' hits the notes of Slam only", r["ok"] and [c["name"] for c in r["data"]["clips"]] == ["Slam"], r)
r = run("lib_search_tag"); ok("search tag:r6 hits Slam_R6 only", r["ok"] and [c["name"] for c in r["data"]["clips"]] == ["Slam_R6"], r)
r = run("lib_search_rig"); ok("search rig:R15 hits Slam + SlamBack", r["ok"] and [c["name"] for c in r["data"]["clips"]] == ["Slam", "SlamBack"], r)
r = run("lib_export")
ok("export: every keyframe with bones in degrees + meta tags, not truncated", r["ok"] and len(r["data"]["keyframes"]) == slam_meta["keyframes"] and r["data"]["truncated"] is False and "LeftUpperArm" in r["data"]["keyframes"][0]["bones"] and r["data"]["meta"]["tags"] == ["combat", "heavy"] and any(mk["name"] == "Hit" for mk in r["data"]["keyframes"][0]["markers"]), r)
r = run("lib_rename"); ok("rename SlamBack -> SlamBackR15 follows the active clip", r["ok"] and r["data"]["name"] == "SlamBackR15" and L.eval("function() local lib = game:GetService('ServerStorage'):FindFirstChild('RobloxScript') or game:GetService('ServerStorage'):FindFirstChild('AnimScript') return lib.AnimLib:FindFirstChild('Active').Value end")() == "SlamBackR15", r)
r = run("lib_rename_clash"); ok("rename onto an existing name refused", not r["ok"] and "already exists" in r["error"], r)
r = run("lib_delete"); ok("delete SlamSix", r["ok"] and r["data"]["deleted"] == "SlamSix", r)
r = run("lib_list_after"); ok("list after: Slam, SlamBackR15, Slam_R6", r["ok"] and [c["name"] for c in r["data"]["clips"]] == ["Slam", "SlamBackR15", "Slam_R6"], r)
r = run("lib_bad_op"); ok("unknown library op refused in JS before Luau", not r["ok"] or "--ERR" in programs["lib_bad_op"], r)

print("\n%s retarget-sim: %d passed, %d failed (mocked DataModel - a real Studio run is still the final word)" % ("OK " if failed == 0 else "FAIL", passed, failed))
sys.exit(1 if failed else 0)
