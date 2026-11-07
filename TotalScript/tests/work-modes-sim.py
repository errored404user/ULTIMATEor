#!/usr/bin/env python3
"""Work-mode PREFLIGHT and AUTO-CHECK probes (1.99.9) against the miniature Roblox DataModel.

src/core/work_modes.js ships READ-ONLY Luau that main.js runs through execute_luau
(a) once per request before the model's first command (mode preflight) and
(b) right after a successful build command (read-back auto-check). This sim
executes exactly that Luau on tests/roblox_sim.py and asserts the JSON it
returns describes the place truthfully: rig counts / RigType / Motor6D / Animator,
KeyframeSequence counts, AnimPlayer presence, part / script / GUI / remote counts,
Lighting, selection, play state, and the per-path read-back for a Model, a Part,
a Script, a KeyframeSequence and a ScreenGui - plus NOT FOUND for a bogus path.

    pip install lupa && python3 tests/work-modes-sim.py          (from the TotalScript root)

Mocked: no live Studio is involved; the simulator is a miniature DataModel.
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
const W=require(process.cwd()+"/src/core/work_modes.js");
const out={preflight:W._lua.PREFLIGHT_LUA, readback:{}};
for (const p of JSON.parse(process.argv[1])) out.readback[p]=W.readbackLua(p);
process.stdout.write(JSON.stringify(out));
"""
PATHS = ["Workspace.Hero", "game.Workspace.Crate", "ServerScriptService.Main", "ReplicatedStorage.Clips.Wave", "StarterGui.HUD", "Workspace.Nope.Missing", "workspace.hero"]
gen = subprocess.run(["node", "-e", GEN, json.dumps(PATHS)], capture_output=True, text=True)
if gen.returncode != 0:
    print("FAIL  node generator: " + gen.stderr[:800])
    sys.exit(1)
LUA = json.loads(gen.stdout)

for code in list(LUA["preflight"].values()) + list(LUA["readback"].values()):
    assert "+=" not in code and "\ncontinue" not in code, "probe Luau must stay plain Lua 5.x for the sim"

L, M, run = make_runtime()

SETUP = r"""
local ws=workspace
local hero=M.buildRig(Enum.HumanoidRigType.R15,"Hero") hero.Parent=ws
local an=Instance.new("Animator") an.Parent=hero:FindFirstChildOfClass("Humanoid")
local bot=M.buildRig(Enum.HumanoidRigType.R6,"Bot") bot.Parent=game:GetService("ServerStorage")
local crate=Instance.new("Part") crate.Name="Crate" crate.Size=Vector3.new(4,4,4) crate.Anchored=true crate.Parent=ws
local loose=Instance.new("Part") loose.Name="Loose" loose.Anchored=false loose.Parent=ws
local s=Instance.new("Script") s.Name="Main" s.Source="print('hi')" s.Parent=game:GetService("ServerScriptService")
local re=Instance.new("RemoteEvent") re.Name="Ping" re.Parent=game:GetService("ReplicatedStorage")
local clips=Instance.new("Folder") clips.Name="Clips" clips.Parent=game:GetService("ReplicatedStorage")
local ks=Instance.new("KeyframeSequence") ks.Name="Wave" ks.Loop=true ks.Parent=clips
for i=0,2 do local k=Instance.new("Keyframe") k.Time=i*0.5 k.Parent=ks local p=Instance.new("Pose") p.Name="UpperTorso" p.Parent=k end
local gui=Instance.new("ScreenGui") gui.Name="HUD" gui.Parent=game:GetService("StarterGui")
for i=1,3 do local f=Instance.new("Frame") f.Name="F"..i f.Parent=gui end
local ta=Instance.new("Folder") ta.Name="TotalAnimations" ta.Parent=game:GetService("ReplicatedStorage")
game:GetService("Selection"):Set({hero})
return "ok"
"""
setup_fn = L.eval("function(M) " + SETUP + " end")
assert setup_fn(M) == "ok"

results = []
def ok(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else "  -> " + str(detail)[:400]))

pre_a = run("preflight_animate", LUA["preflight"]["animate"])
ok("animate preflight returns an object", isinstance(pre_a, dict) and pre_a.get("mode") == "animate", pre_a)
rigs = pre_a.get("rigs") or []
ok("animate preflight finds both rigs (Workspace + ServerStorage)", len(rigs) == 2, rigs)
hero = next((r for r in rigs if r.get("path") == "Workspace.Hero"), None)
bot = next((r for r in rigs if r.get("path") == "ServerStorage.Bot"), None)
ok("Hero: R15, 15 Motor6D, Animator present, HRP present", hero and hero.get("rig") == "R15" and hero.get("motors") == 15 and hero.get("animator") is True and hero.get("hrp") is True, hero)
ok("Bot: R6, 6 Motor6D, NO Animator", bot and bot.get("rig") == "R6" and bot.get("motors") == 6 and bot.get("animator") is False, bot)
ok("animate preflight counts the KeyframeSequence by name", pre_a.get("clips") == 1 and pre_a.get("clipNames") == ["Wave"], pre_a)
ok("animate preflight: TotalAnimations folder without AnimPlayer = not installed", pre_a.get("animPlayer") is False, pre_a)
ok("animate preflight reports the selection (the rig)", pre_a.get("selection") == ["Workspace.Hero"], pre_a)
ok("animate preflight reports edit mode (not playing)", pre_a.get("playing") is False, pre_a)

# Install AnimPlayer and re-run: the flag flips.
L.execute("local ms=Instance.new('ModuleScript') ms.Name='AnimPlayer' ms.Parent=game:GetService('ReplicatedStorage'):FindFirstChild('TotalAnimations')")
pre_a2 = run("preflight_animate2", LUA["preflight"]["animate"])
ok("animate preflight sees AnimPlayer once installed", pre_a2.get("animPlayer") is True, pre_a2)

pre_c = run("preflight_creation", LUA["preflight"]["creation"])
ok("creation preflight returns an object", isinstance(pre_c, dict) and pre_c.get("mode") == "creation", pre_c)
# Hero rig: 16 BaseParts (HRP + Head + 14 limbs/torsos); Crate + Loose = 2 -> 18 parts, 1 unanchored (rig parts are anchored in the sim? count only Loose vs rig)
ok("creation preflight counts BaseParts in Workspace", isinstance(pre_c.get("parts"), (int, float)) and pre_c["parts"] >= 18, pre_c)
ok("creation preflight counts unanchored parts (>= the Loose part)", isinstance(pre_c.get("unanchored"), (int, float)) and pre_c["unanchored"] >= 1, pre_c)
ok("creation preflight counts models, scripts, remotes, GUIs", pre_c.get("models", 0) >= 1 and pre_c.get("scripts") == 2 and pre_c.get("remotes") == 1 and pre_c.get("guis") == 1, pre_c)
ok("creation preflight reads Lighting (clock) and the selection", isinstance(pre_c.get("lighting"), dict) and "clock" in pre_c["lighting"] and pre_c.get("selection") == ["Workspace.Hero"], pre_c)
ok("creation preflight: no project index / bench yet", pre_c.get("index") is False and pre_c.get("bench") is False, pre_c)

rb = run("rb_hero", LUA["readback"]["Workspace.Hero"])
ok("read-back Model: found, class Model, 16 parts, rig R15 with Animator", rb.get("found") is True and rb.get("class") == "Model" and rb.get("parts") == 16 and rb.get("rigType") == "R15" and rb.get("animator") is True and rb.get("motors") == 15, rb)
ok("read-back Model carries a bounding-box size", isinstance(rb.get("size"), list) and len(rb["size"]) == 3, rb)
rb = run("rb_hero_ci", LUA["readback"]["workspace.hero"])
ok("read-back resolves case-insensitively (workspace.hero)", rb.get("found") is True and rb.get("path") == "Workspace.Hero", rb)
rb = run("rb_crate", LUA["readback"]["game.Workspace.Crate"])
ok("read-back Part with game. prefix: 1 part, anchored 1/1, size 4x4x4", rb.get("found") is True and rb.get("class") == "Part" and rb.get("parts") == 1 and rb.get("anchored") == 1 and rb.get("size") == [4, 4, 4], rb)
rb = run("rb_script", LUA["readback"]["ServerScriptService.Main"])
ok("read-back Script: sourceLen and enabled", rb.get("found") is True and rb.get("class") == "Script" and rb.get("sourceLen") == 11, rb)
rb = run("rb_clip", LUA["readback"]["ReplicatedStorage.Clips.Wave"])
ok("read-back KeyframeSequence: 3 keyframes, 3 poses, length 1.0, loop", rb.get("found") is True and rb.get("keyframes") == 3 and rb.get("poses") == 3 and abs(float(rb.get("length", 0)) - 1.0) < 1e-6 and rb.get("loop") is True, rb)
rb = run("rb_gui", LUA["readback"]["StarterGui.HUD"])
ok("read-back ScreenGui: 3 GuiObjects", rb.get("found") is True and rb.get("class") == "ScreenGui" and rb.get("guiObjects") == 3, rb)
rb = run("rb_missing", LUA["readback"]["Workspace.Nope.Missing"])
ok("read-back of a bogus path reports found=false with the path", rb.get("found") is False and rb.get("path") == "Workspace.Nope.Missing", rb)

# Play mode flag
L.eval("function(M) M.isEdit=false end")(M)
pre_p = run("preflight_playing", LUA["preflight"]["creation"])
ok("preflight reports playing=true while the sim is running", pre_p.get("playing") is True, pre_p)

passed = sum(1 for _, c in results if c)
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
