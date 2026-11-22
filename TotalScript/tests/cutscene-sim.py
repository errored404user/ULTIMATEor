#!/usr/bin/env python3
"""Execute the cutscene pack (cutscene_*) Luau against the miniature Roblox DataModel.

tests/test-cutscene.js checks the pack statically; this script runs a whole authoring
session - create from explicit / target-preset / marker-part shots, add a shot, capture
the Studio camera, list, preview, wire a spawn / touch / proximity trigger, delete -
inside tests/roblox_sim.py and then RUNS the generated client runtime (CutscenePlayer)
and the generated LocalScript / trigger Script to prove they compile and behave:
camera scriptable while playing, restored afterwards, HUD / character restored,
Completed fired, the remote round-trip recorded.

    pip install lupa && python3 tests/cutscene-sim.py          (from the TotalScript root)
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
global.window=global; global.chrome={storage:{local:{get:(k,cb)=>cb&&cb({}),set:()=>{}}},runtime:{getURL:(p)=>p}};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills;
const out={commands:S.CUTSCENE_COMMANDS, runtime:S.CUTSCENE_RUNTIME_SRC, client:S.CUTSCENE_CLIENT_SRC, version:S.CUTSCENE_VERSION, programs:{}};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "too_few": ["cutscene_create", {"name": "Intro", "shots": [{"position": [0, 10, 20], "look_at": [0, 0, 0]}]}],
    "bad_shot": ["cutscene_create", {"name": "Intro", "shots": [{"position": [0, 10, 20], "look_at": [0, 0, 0]}, {"fov": 50}]}],
    "missing_target": ["cutscene_create", {"name": "Intro", "shots": [{"position": [0, 10, 20], "look_at": [0, 0, 0]}, {"target": "Workspace.Nope"}]}],
    "create": ["cutscene_create", {"name": "Intro", "fade_in": 0.5, "fade_out": 0.25, "blur": 12, "shots": [
        {"name": "wide", "position": [0, 10, 20], "look_at": [0, 0, 0], "fov": 60, "duration": 0.02},
        {"name": "hero", "target": "Workspace.Boss", "preset": "hero_low", "fov": 45, "duration": 0.02, "hold": 0.01, "easing": "quad", "direction": "out"},
        {"name": "top", "target": "Workspace.Boss", "preset": "top_down", "distance": 30, "hold": 0.01, "duration": 0.05},
    ]}],
    "create_again_norep": ["cutscene_create", {"name": "Intro", "replace": False, "shots": [{"position": [0, 0, 0]}, {"position": [1, 1, 1]}]}],
    "legacy_noargs": ["cutscene_camera_track", {"duration": 5, "fov": 70}],
    "legacy_real": ["cutscene_camera_track", {"name": "Legacy", "shots": [{"position": [0, 5, 10], "look_at": "Workspace.Boss"}, {"position": [10, 5, 0], "look_at": "Workspace.Boss", "roll": 10}]}],
    "add": ["cutscene_shot_add", {"name": "Intro", "shots": [{"cframe": [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1], "fov": 80, "name": "end"}]}],
    "add_single": ["cutscene_shot_add", {"name": "Intro", "part": "Workspace.CamPath.Shot2", "index": 2, "shot_name": "marker", "duration": 0.05}],
    "add_missing": ["cutscene_shot_add", {"name": "Nope", "shots": [{"position": [0, 0, 0]}]}],
    "from_camera_new": ["cutscene_shot_from_camera", {"name": "Captured", "hold": 1}],
    "from_camera_again": ["cutscene_shot_from_camera", {"name": "Captured", "fov": 30, "duration": 4}],
    "from_path": ["cutscene_shots_from_path", {"name": "Path", "path": "Workspace.CamPath", "duration": 1.5, "letterbox": False}],
    "from_path_bad": ["cutscene_shots_from_path", {"name": "Path2", "path": "Workspace.Empty"}],
    "list": ["cutscene_list", {}],
    "preview": ["cutscene_preview", {"name": "Intro", "speed": 2}],
    "preview_missing": ["cutscene_preview", {"name": "Nope"}],
    "trigger_spawn": ["cutscene_trigger", {"name": "Intro", "trigger": "spawn", "delay": 1}],
    "trigger_touch": ["cutscene_trigger", {"name": "Legacy", "trigger": "touch", "part": "Workspace.Pad", "once": False}],
    "trigger_prox": ["cutscene_trigger", {"name": "Path", "trigger": "proximity", "part": "Workspace.Pad", "prompt_text": "Look"}],
    "trigger_touch_nopart": ["cutscene_trigger", {"name": "Intro", "trigger": "touch"}],
    "trigger_remote": ["cutscene_trigger", {"name": "Intro", "trigger": "remote"}],
    "delete": ["cutscene_delete", {"name": "Legacy"}],
    "list_after": ["cutscene_list", {}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:600]))


def run(key):
    return run_program(key, data["programs"][key])


G = L.globals()
same = L.eval("function(a,b) return a == b end")
game = M.game
svc = lambda n: game.GetService(game, n)
WS, RS, SSS, SP = svc("Workspace"), svc("ReplicatedStorage"), svc("ServerScriptService"), svc("StarterPlayer")
CAM = WS.CurrentCamera
find = lambda inst, name, rec=False: inst.FindFirstChild(inst, name, rec)
children = lambda inst: list(inst.GetChildren(inst).values())
attr = lambda inst, k: inst.GetAttribute(inst, k)

# scene: a boss model, a touch pad, a camera path with marker parts, StarterPlayerScripts
L.execute("""
local boss=Instance.new('Model') boss.Name='Boss' boss.Parent=workspace
local body=Instance.new('Part') body.Name='Body' body.Size=Vector3.new(6,10,4) body.CFrame=CFrame.new(0,5,0) body.Parent=boss boss.PrimaryPart=body
local pad=Instance.new('Part') pad.Name='Pad' pad.Size=Vector3.new(8,1,8) pad.CFrame=CFrame.new(20,0.5,0) pad.Parent=workspace
local path=Instance.new('Folder') path.Name='CamPath' path.Parent=workspace
for i,p in ipairs({{-20,8,20},{0,12,30},{20,8,20}}) do local m=Instance.new('Part') m.Name='Shot'..(4-i) m.CFrame=CFrame.lookAt(Vector3.new(p[1],p[2],p[3]),Vector3.new(0,5,0)) m.Parent=path end
path:FindFirstChild('Shot1'):SetAttribute('FOV',40) path:FindFirstChild('Shot1'):SetAttribute('Hold',0.5)
local empty=Instance.new('Folder') empty.Name='Empty' empty.Parent=workspace
local sps=Instance.new('StarterPlayerScripts') sps.Name='StarterPlayerScripts' sps.Parent=game:GetService('StarterPlayer')
""")

ok("every program generated (no --ERR) except the shape-less shot, which the JS side already rejects", [k for k, p in data["programs"].items() if p.startswith("--ERR")] == ["bad_shot"], [k for k, p in data["programs"].items() if p.startswith("--ERR")])
ok("catalogue: 9 cutscene commands incl. the legacy name", data["commands"] == ["cutscene_create", "cutscene_shot_add", "cutscene_shot_from_camera", "cutscene_shots_from_path", "cutscene_preview", "cutscene_trigger", "cutscene_list", "cutscene_delete", "cutscene_camera_track"], data["commands"])

# ── validation ──
r = run("too_few"); ok("create: 1 shot is refused with the shot shapes explained", not r["ok"] and "at least 2 shots" in r["error"], r)
r = run("bad_shot"); ok("create: a shot without position/target/part/cframe is refused (no silent default)", not r["ok"] and "shot 2" in r["error"], r)
r = run("missing_target"); ok("create: a missing target path is a clean error", not r["ok"] and "target not found" in r["error"], r)
ok("nothing was created by the failed attempts", find(RS, "TotalCutscenes") is None)

# ── create ──
r = run("create")
ok("create: ok with 3 shots; duration = holds + travels except the last shot, travel floored at 0.05s (0.05 + 0.05 + 0.01 + 0.01)", r["ok"] and r["data"]["shots"] == 3 and abs(r["data"]["duration"] - 0.12) < 1e-6, r)
root = find(RS, "TotalCutscenes")
mod = root and find(root, "Intro")
ok("create: ReplicatedStorage.TotalCutscenes.Intro ModuleScript with attributes", mod is not None and mod.ClassName == "ModuleScript" and attr(mod, "TotalCutscene") is True and attr(mod, "Shots") == 3 and attr(mod, "ShotsJSON"))
rt = root and find(root, "CutscenePlayer"); ev = root and find(root, "PlayCutscene"); cl = find(find(SP, "StarterPlayerScripts"), "TotalCutsceneClient")
ok("create: shared runtime installed once - CutscenePlayer ModuleScript (versioned), PlayCutscene RemoteEvent, StarterPlayerScripts.TotalCutsceneClient LocalScript", rt is not None and rt.ClassName == "ModuleScript" and attr(rt, "TotalVersion") == data["version"] and ev is not None and ev.ClassName == "RemoteEvent" and cl is not None and cl.ClassName == "LocalScript" and sorted(r["data"]["runtime_created"]) == ["CutscenePlayer", "PlayCutscene", "TotalCutsceneClient"], r["data"].get("runtime_created"))
ok("create: result text tells the next step (preview, trigger) and carries the usage recipe", "cutscene_preview" in r["text"] and "FireClient" in r["data"]["usage"])
src = mod.Source
ok("module source is readable Luau: return { name, options, shots = { {name, cf = CFrame.new(12 numbers), fov, duration, hold, easing, direction} } }", src.startswith("-- TotalScript cutscene \"Intro\"") and 'name = "Intro"' in src and "letterbox = true, fade_in = 0.5, fade_out = 0.25" in src and "blur = 12" in src and src.count("cf = CFrame.new(") == 3 and 'easing = "Quad", direction = "Out"' in src, src[:400])
loaded = M.runModule(mod)
ok("module source compiles and requires to the data: 3 shots, CFrame values, fov 60/45/70", loaded is not None and len(list(loaded["shots"].values())) == 3 and loaded["shots"][1]["fov"] == 60 and loaded["shots"][2]["fov"] == 45 and G.typeof(loaded["shots"][1]["cf"]) == "CFrame")
shot1 = loaded["shots"][1]
look_dot = L.eval("function(cf,p) return cf.LookVector:Dot((p-cf.Position).Unit) end")
ok("shot 1 (explicit position + look_at) looks at the origin from (0,10,20)", abs(shot1["cf"].Position.X) < 1e-6 and abs(shot1["cf"].Position.Y - 10) < 1e-6 and look_dot(shot1["cf"], G.Vector3.new(0, 0, 0)) > 0.999)
shot2 = loaded["shots"][2]
ok("shot 2 (target preset hero_low) sits below the boss centre and looks at it", shot2["cf"].Position.Y < 5 and look_dot(shot2["cf"], G.Vector3.new(0, 5, 0)) > 0.999, (shot2["cf"].Position.X, shot2["cf"].Position.Y, shot2["cf"].Position.Z))
shot3 = loaded["shots"][3]
ok("shot 3 (top_down, distance 30) is 30 studs above and looks down", abs(shot3["cf"].Position.Y - 35) < 1e-6 and look_dot(shot3["cf"], G.Vector3.new(0, 5, 0)) > 0.999)
r = run("create_again_norep"); ok("create: replace:false refuses to overwrite", not r["ok"] and "already exists" in r["error"], r)

# ── legacy name ──
r = run("legacy_noargs"); ok("cutscene_camera_track with only duration/fov (the old stub call) FAILS loudly instead of 'configured'", not r["ok"] and "needs shots" in r["error"] and "create nothing" in r["error"], r)
r = run("legacy_real"); ok("cutscene_camera_track with shots builds a real cutscene (look_at as a path, roll)", r["ok"] and r["data"]["shots"] == 2 and find(root, "Legacy") is not None, r)

# ── add / capture / path ──
r = run("add"); ok("shot_add: raw cframe shot appended -> 4 shots, named 'end'", r["ok"] and r["data"]["shots"] == 4 and r["data"]["shot_list"][3].startswith("end ("), r)
r = run("add_single"); ok("shot_add: single shot from top-level params (part marker) inserted at index 2 with shot_name", r["ok"] and r["data"]["shots"] == 5 and r["data"]["shot_list"][1].startswith("marker ("), r)
d = json.loads(attr(mod, "ShotsJSON"))
ok("ShotsJSON keeps the order wide, marker, hero, top, end and the module source was regenerated to 5 CFrames", [s["name"] for s in d["shots"]] == ["wide", "marker", "hero", "top", "end"] and mod.Source.count("cf = CFrame.new(") == 5 and attr(mod, "Shots") == 5)
r = run("add_missing"); ok("shot_add: unknown cutscene is a clean error", not r["ok"] and "no cutscene named Nope" in r["error"])
CAM.CFrame = G.CFrame.lookAt(G.Vector3.new(3, 4, 5), G.Vector3.new(0, 0, 0)); CAM.FieldOfView = 55
r = run("from_camera_new"); ok("shot_from_camera: creates the cutscene and captures the Studio camera (pos 3,4,5 fov 55) as shot 1, says 2+ needed", r["ok"] and r["data"]["shots"] == 1 and r["data"]["captured"]["position"] == [3, 4, 5] and r["data"]["captured"]["fov"] == 55 and "needs 2+" in r["text"], r)
r = run("from_camera_again"); ok("shot_from_camera: second capture with fov override -> 2 shots, duration from the first", r["ok"] and r["data"]["shots"] == 2 and r["data"]["captured"]["fov"] == 30 and abs(r["data"]["duration"] - (1 + 2)) < 1e-6, r)
r = run("from_path"); ok("shots_from_path: 3 marker parts sorted Shot1..3, per-part FOV/Hold attributes honoured, letterbox off", r["ok"] and r["data"]["markers"] == 3 and r["data"]["shot_list"][0].startswith("Shot1 (40deg") and "hold 0.5s" in r["data"]["shot_list"][0] and r["data"]["letterbox"] is False and abs(r["data"]["duration"] - (0.5 + 1.5 + 1.5)) < 1e-6, r)
r = run("from_path_bad"); ok("shots_from_path: fewer than 2 markers is refused", not r["ok"] and "at least 2 BasePart markers" in r["error"], r)

# ── list / preview ──
r = run("list"); ok("list: 4 cutscenes with shots + duration, runtime version reported", r["ok"] and r["data"]["count"] == 4 and [c["name"] for c in r["data"]["cutscenes"]] == ["Captured", "Intro", "Legacy", "Path"] and r["data"]["runtime_version"] == data["version"], r)
CAM.CameraType = G.Enum.CameraType.Fixed
r = run("preview")
# the sim parks the spawned loop at its first task.wait(), i.e. a few microseconds into the first travel
ok("preview: camera goes Scriptable on shot 1 (pos ~0,10,20, fov ~60), preview seconds halved by speed 2, tells the AI to screenshot", r["ok"] and same(CAM.CameraType, G.Enum.CameraType.Scriptable) and abs(CAM.CFrame.Position.Z - 20) < 0.05 and abs(CAM.CFrame.Position.Y - 10) < 0.05 and abs(CAM.FieldOfView - 60) < 0.1 and abs(r["data"]["preview_seconds"] - r["data"]["duration"] / 2) < 1e-9 and "total_screenshot" in r["text"], (r, CAM.FieldOfView))
r = run("preview_missing"); ok("preview: unknown cutscene is a clean error", not r["ok"])

# ── triggers ──
r = run("trigger_spawn"); ts = find(SSS, "TotalCutsceneTrigger_Intro")
ok("trigger spawn: ServerScriptService.TotalCutsceneTrigger_Intro Script with attributes and DELAY/ONCE baked in", r["ok"] and ts is not None and ts.ClassName == "Script" and attr(ts, "Cutscene") == "Intro" and attr(ts, "Trigger") == "spawn" and "local DELAY = 1" in ts.Source and "local ONCE = true" in ts.Source and "CharacterAdded" in ts.Source, r)
r = run("trigger_touch"); tt = find(SSS, "TotalCutsceneTrigger_Legacy")
ok("trigger touch: script walks to the part nil-safely, once=false, Touched handler", r["ok"] and tt is not None and 'game:GetService("Workspace")' in tt.Source and '"Pad"' in tt.Source and "local ONCE = false" in tt.Source and "part.Touched:Connect" in tt.Source and r["data"]["part"] == "Workspace.Pad", r)
r = run("trigger_prox"); tp = find(SSS, "TotalCutsceneTrigger_Path")
ok("trigger proximity: ProximityPrompt with the action text", r["ok"] and tp is not None and 'pp.ActionText = "Look"' in tp.Source and "pp.Triggered:Connect" in tp.Source, r)
r = run("trigger_touch_nopart"); ok("trigger touch without part is refused", not r["ok"] and "needs part" in r["error"])
r = run("trigger_remote"); ok("trigger remote: no script, FireClient recipe", r["ok"] and r["data"]["trigger"] == "remote" and "FireClient" in r["text"] and find(SSS, "TotalCutsceneTrigger_Intro").GetAttribute(find(SSS, "TotalCutsceneTrigger_Intro"), "Trigger") == "spawn")

# ── the generated scripts compile (plain Lua) ──
compile_ok = L.eval("function(src) local f,e=load(src,'=gen') return f~=nil, e end")
for label, source in (("CutscenePlayer runtime", data["runtime"]), ("TotalCutsceneClient", data["client"]), ("spawn trigger", ts.Source), ("touch trigger", tt.Source), ("proximity trigger", tp.Source)):
    good, err = compile_ok(source)
    ok("compiles: " + label, good, err)

# ── run the runtime for real: client script + remote round trip ──
# run the LocalScript as the local player, then fire the remote as the server would
M.invalidate()  # the sim caches require() results; Intro changed since the first require above
M.runScript(cl, True)
rtmod = M.runModule(rt)
fired = []
L.globals().__completed = L.table()
L.execute("require(game:GetService('ReplicatedStorage').TotalCutscenes.CutscenePlayer).Completed.Event:Connect(function(name, skipped) __completed[#__completed+1]={name=name, skipped=skipped} end)")
CAM.CameraType = G.Enum.CameraType.Custom; CAM.FieldOfView = 70
before = CAM.CFrame
L.execute("game:GetService('ReplicatedStorage').TotalCutscenes.PlayCutscene.OnClientEvent:Fire('Intro')")
comp = list(L.globals().__completed.values())
ok("runtime: OnClientEvent('Intro') played the cutscene to the end and fired Completed(name, skipped=false)", len(comp) == 1 and comp[0]["name"] == "Intro" and comp[0]["skipped"] is False, comp)
ok("runtime: camera type and FOV restored after the cutscene (Custom / 70), CFrame restored", same(CAM.CameraType, G.Enum.CameraType.Custom) and CAM.FieldOfView == 70 and abs(CAM.CFrame.Position.X - before.Position.X) < 1e-6)
ok("runtime: client reported back on the remote (FireServer name, finished=true)", any(len(f) >= 3 and f[0] == "PlayCutscene" and f[1] == "Intro" and f[2] is True for f in [list(x.values()) for x in M.fired.values()]), [list(x.values()) for x in M.fired.values()])
gui = find(M.fakePlayer.FindFirstChildOfClass(M.fakePlayer, "PlayerGui"), "TotalCutscene")
ok("runtime: letterbox gui (BarTop / BarBottom / Fade / SkipHint) was built under PlayerGui and the blur effect was added to Lighting", gui is not None and all(find(gui, n) is not None for n in ("BarTop", "BarBottom", "Fade", "SkipHint")) and find(svc("Lighting"), "TotalCutsceneBlur") is not None)
cur = json.loads(attr(mod, "ShotsJSON"))["shots"]
expect = sum((s.get("hold") or 0) for s in cur) + sum((s.get("duration") or 2) for s in cur[:-1])
ok("runtime: not playing afterwards; duration() helper matches the 5-shot module data", rtmod.isPlaying() is False and abs(rtmod.duration("Intro") - expect) < 1e-6, (rtmod.duration("Intro"), expect))
err = L.eval("function() local okP,e=pcall(require(game:GetService('ReplicatedStorage').TotalCutscenes.CutscenePlayer).play,'Nope') return okP, tostring(e) end")()
ok("runtime: unknown cutscene errors cleanly", err[0] is False and "cutscene not found: Nope" in err[1], err)

# ── delete ──
r = run("delete"); ok("delete: module + its touch trigger removed, runtime kept", r["ok"] and len(r["data"]["removed"]) == 2 and find(root, "Legacy") is None and find(SSS, "TotalCutsceneTrigger_Legacy") is None and find(root, "CutscenePlayer") is not None, r)
r = run("list_after"); ok("list after delete: 3 cutscenes, 2 triggers", r["ok"] and r["data"]["count"] == 3 and len(r["data"]["triggers"]) == 2, r)

print("\n%d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
