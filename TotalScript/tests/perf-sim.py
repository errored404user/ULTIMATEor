#!/usr/bin/env python3
"""Perf pack (2.16.0) - perf_audit / perf_fix against the miniature Roblox DataModel.

tests/test-perf-pack.js checks the pack statically (registration, params, validation,
wiring, scoring rules). This script runs the REAL generated Luau in tests/roblox_sim.py
on a deliberately slow place:

  perf_audit   counts exactly the planted problems - free unanchored parts (characters,
               vehicles and welded parts excluded), tiny shadow casters, Precise meshes,
               heavy / TotalVFX-owned emitters, shadow lights, busy script loops with
               path:line, empty containers, post effects - and scores them by the
               published rules; a scoped audit only sees its subtree
  perf_fix     dry_run counts without touching anything; the real run anchors / unshadows /
               re-fidelities / caps / keeps the 8 strongest shadow lights / deletes empty
               containers, never rewrites scripts, re-scores higher; streaming is only
               applied when asked; unknown ops are refused before Luau

Everything here is a MOCK of Roblox; a real Studio run is still the final word.

    pip install lupa && python3 tests/perf-sim.py          (from the TotalScript root)
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
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills; const want=JSON.parse(process.argv[1]); const out={programs:{}, libLen:S.PERF_LIB.length};
for(const [k,[n,a]] of Object.entries(want)){ let r; try{ r=S.buildLuau(n,a);}catch(e){ r={err:String(e)}; } out.programs[k]=r&&r.code?r.code:("--ERR "+(r&&r.err)); }
process.stdout.write(JSON.stringify(out));
"""

WANT = {
    "audit": ["perf_audit", {}],
    "audit_scoped": ["perf_audit", {"path": "Workspace.Lamps"}],
    "audit_missing": ["perf_audit", {"path": "Workspace.Nope"}],
    "fix_dry": ["perf_fix", {"dry_run": True}],
    "fix_real": ["perf_fix", {}],
    "audit_after": ["perf_audit", {}],
    "fix_streaming": ["perf_fix", {"ops": ["streaming"]}],
    "fix_bad_op": ["perf_fix", {"ops": ["delete_everything"]}],
    "fix_bad_type": ["perf_fix", {"ops": "anchor_free"}],
}

gen = subprocess.run(["node", "-e", GEN, json.dumps(WANT)], capture_output=True, text=True)
if gen.returncode != 0:
    print("FAIL  generator: " + gen.stderr[-1500:])
    sys.exit(1)
data = json.loads(gen.stdout)
programs = data["programs"]

passed = failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS  " + name)
    else:
        failed += 1
        print("FAIL  " + name + ("  -- " + str(detail)[:900] if detail != "" else ""))

L, M, run = make_runtime()
L.globals()["M"] = M
lua = L.execute

lua(r"""
local function part(name, size, parent, anchored) local p = Instance.new("Part") p.Name = name p.Size = size p.Anchored = anchored == true p.CastShadow = false p.Parent = parent return p end
-- 30 free unanchored parts + 5 anchored
local junk = Instance.new("Folder") junk.Name = "Junk" junk.Parent = workspace
for i = 1, 30 do part("Free" .. i, Vector3.new(4, 4, 4), junk, false) end
for i = 1, 5 do part("Fixed" .. i, Vector3.new(4, 4, 4), junk, true) end
-- a welded unanchored part is NOT free
local base = part("WeldBase", Vector3.new(4, 1, 4), junk, true)
local welded = part("Welded", Vector3.new(1, 1, 1), junk, false)
local w = Instance.new("WeldConstraint") w.Part0 = base w.Part1 = welded w.Parent = welded
-- a character-like NPC and a vehicle keep their unanchored parts
local npc = Instance.new("Model") npc.Name = "Guard" npc.Parent = workspace
Instance.new("Humanoid").Parent = npc
for _, n in ipairs({ "Head", "Torso", "Left Arm" }) do part(n, Vector3.new(2, 2, 1), npc, false) end
local car = Instance.new("Model") car.Name = "Kart" car.Parent = workspace
local seat = Instance.new("VehicleSeat") seat.Name = "Seat" seat.Size = Vector3.new(2, 1, 2) seat.Parent = car car.PrimaryPart = seat
for i = 1, 4 do part("Wheel" .. i, Vector3.new(2, 2, 1), car, false) end
-- 60 tiny shadow casters (anchored so they are not free)
local deco = Instance.new("Folder") deco.Name = "Deco" deco.Parent = workspace
for i = 1, 60 do local p = part("Bolt" .. i, Vector3.new(0.5, 0.5, 0.5), deco, true) p.CastShadow = true end
-- meshes: two Precise collision (one small -> Box, one large -> Hull), one Precise render
local meshes = Instance.new("Folder") meshes.Name = "Meshes" meshes.Parent = workspace
local m1 = Instance.new("MeshPart") m1.Name = "SmallRock" m1.Size = Vector3.new(2, 2, 2) m1.Anchored = true m1.CollisionFidelity = Enum.CollisionFidelity.PreciseConvexDecomposition m1.Parent = meshes
local m2 = Instance.new("MeshPart") m2.Name = "BigRock" m2.Size = Vector3.new(10, 6, 8) m2.Anchored = true m2.CollisionFidelity = Enum.CollisionFidelity.PreciseConvexDecomposition m2.RenderFidelity = Enum.RenderFidelity.Precise m2.Parent = meshes
local m3 = Instance.new("MeshPart") m3.Name = "Statue" m3.Size = Vector3.new(3, 6, 3) m3.Anchored = true m3.CollisionFidelity = Enum.CollisionFidelity.Hull m3.Parent = meshes
-- 12 shadow lights with different strengths
local lamps = Instance.new("Folder") lamps.Name = "Lamps" lamps.Parent = workspace
for i = 1, 12 do local p = part("Lamp" .. i, Vector3.new(1, 1, 1), lamps, true) local l = Instance.new("PointLight") l.Range = i * 4 l.Brightness = 1 l.Shadows = true l.Parent = p end
-- emitters: heavy rate, long lifetime, TotalVFX-owned heavy (ignored), normal
local fx = Instance.new("Folder") fx.Name = "FX" fx.Parent = workspace
local e1 = Instance.new("ParticleEmitter") e1.Name = "Fountain" e1.Rate = 500 e1.Lifetime = NumberRange.new(1, 2) e1.Parent = part("FxA", Vector3.new(1, 1, 1), fx, true)
local e2 = Instance.new("ParticleEmitter") e2.Name = "Fog" e2.Rate = 20 e2.Lifetime = NumberRange.new(5, 30) e2.Parent = part("FxB", Vector3.new(1, 1, 1), fx, true)
local owned = part("FxC", Vector3.new(1, 1, 1), fx, true) owned:SetAttribute("TotalVFX", "2.2.0")
local e3 = Instance.new("ParticleEmitter") e3.Name = "Owned" e3.Rate = 900 e3.Lifetime = NumberRange.new(1, 1) e3.Parent = owned
local e4 = Instance.new("ParticleEmitter") e4.Name = "Normal" e4.Rate = 30 e4.Lifetime = NumberRange.new(1, 2) e4.Parent = part("FxD", Vector3.new(1, 1, 1), fx, true)
-- empty containers + a model without PrimaryPart
local empty = Instance.new("Folder") empty.Name = "EmptyFolder" empty.Parent = workspace
local emptyM = Instance.new("Model") emptyM.Name = "EmptyModel" emptyM.Parent = workspace
local noPP = Instance.new("Model") noPP.Name = "Loose" noPP.Parent = workspace part("A", Vector3.new(1, 1, 1), noPP, true)
-- scripts
local SSS = game:GetService("ServerScriptService")
local s1 = Instance.new("Script") s1.Name = "Spinner" s1.Source = "local n = 0\nwhile true do\n  n = n + 1\nend\n" s1.Parent = SSS
local s2 = Instance.new("Script") s2.Name = "Poller" s2.Source = "while wait() do\n  print('tick')\nend\n" s2.Parent = SSS
local s3 = Instance.new("Script") s3.Name = "Good" s3.Source = "while true do\n  task.wait(1)\nend\ngame:GetService('RunService').Heartbeat:Connect(function() end)\n" s3.Parent = SSS
-- post effects
for _, c in ipairs({ "BloomEffect", "ColorCorrectionEffect", "BlurEffect", "DepthOfFieldEffect", "SunRaysEffect" }) do local e = Instance.new(c) e.Enabled = true e.Parent = game:GetService("Lighting") end
""")

ok("generator: PERF_LIB is one shared library (> 12k chars, cached by main.js)", data["libLen"] > 12000, data["libLen"])

r = run("audit", programs["audit"])
m = r.get("data", {}).get("metrics", {})
ok("audit runs and returns score / grade / penalties / metrics / findings / fix_ops / rules", r.get("ok") and isinstance(r["data"]["score"], int) and r["data"]["grade"] and isinstance(r["data"]["findings"], list) and isinstance(r["data"]["fix_ops"], list) and len(r["data"]["rules"]) == 11, r)
ok("free parts = 30 exactly (anchored, welded, NPC limbs and kart wheels excluded)", m.get("free_parts") == 30, m)
ok("60 tiny shadow casters; 3 mesh parts, 2 Precise collision + 1 Precise render", m.get("shadow_small") == 60 and m.get("mesh_parts") == 3 and m.get("precise_collision") == 2 and m.get("precise_render") == 1, m)
ok("emitters: 4 enabled, rate sums all four (1450/s), heavy = 3 (500/s, 30 s lifetime, owned 900/s - the audit still counts it)", m.get("emitters") == 4 and m.get("emitter_rate") == 1450 and m.get("heavy_emitters") == 3, m)
ok("12 lights all shadowed; 1 humanoid; 2 empty containers; 1 model without PrimaryPart (Guard has a Humanoid and is skipped)", m.get("lights") == 12 and m.get("shadow_lights") == 12 and m.get("humanoids") == 1 and m.get("empty_containers") == 2 and m.get("models_no_primary") == 1, m)
ok("scripts: 3 server scripts, 2 busy loops (Spinner: loop without wait; Poller: while wait()), 1 Heartbeat handler", m.get("scripts") == 3 and m.get("busy_loops") == 2 and m.get("heartbeat_handlers") == 1, m)
ok("5 post effects, streaming off, edit mode", m.get("post_effects") == 5 and m.get("streaming_enabled") is False and m.get("mode") == "edit", m)
pen = {p["id"]: p["points"] for p in r["data"]["penalties"]}
ok("penalties follow the published rules: free_parts -1 (30/20), shadow_small -1 (60/50), heavy_emitters -6, shadow_lights -5, busy_loops -10, post_fx -5; no parts / streaming penalty under the thresholds", pen == {"free_parts": 1, "shadow_small": 1, "heavy_emitters": 6, "shadow_lights": 5, "busy_loops": 10, "post_fx": 5}, pen)
ok("score = 100 - 28 = 72 (needs work)", r["data"]["score"] == 72 and r["data"]["grade"] == "needs work", r["data"]["score"])
f = {x["id"]: x for x in r["data"]["findings"]}
ok("findings: busy loops carry path:line and the script_replace fix; free parts / shadows / meshes / emitters / lights point at perf_fix ops", any(x["id"] == "busy_loop" and "ServerScriptService.Spinner:2" in x["detail"] and "script_replace" in x["fix"] for x in r["data"]["findings"]) and any(x["id"] == "busy_loop" and "Poller:1" in x["detail"] for x in r["data"]["findings"]) and f["free_parts"]["fix"] == "perf_fix {ops:['anchor_free']}" and f["heavy_emitters"]["count"] == 3 and "light_shadows" in f["shadow_lights"]["fix"] and "mesh_collision" in f["precise_mesh"]["fix"], r["data"]["findings"][:3])
ok("findings sorted high -> medium -> low; fix_ops lists the mechanical ops without streaming", r["data"]["findings"][0]["severity"] == "high" and r["data"]["findings"][-1]["severity"] == "low" and set(r["data"]["fix_ops"]) == {"anchor_free", "shadows_small", "mesh_collision", "emitter_caps", "light_shadows", "empty_containers"}, r["data"]["fix_ops"])
ok("text: score, counts, penalties, perf_fix hint, and the honesty line about heuristics", "PERF 72/100" in r["text"] and "30 free unanchored" in r["text"] and "2 busy loops" in r["text"] and "perf_fix {ops:" in r["text"] and "not a measured frame time" in r["text"], r["text"])

r = run("audit_scoped", programs["audit_scoped"])
ok("scoped audit (Workspace.Lamps) sees only its 12 lamps: 12 parts, 12 shadow lights, 0 free parts, no scripts", r.get("ok") and r["data"]["metrics"]["parts"] == 12 and r["data"]["metrics"]["shadow_lights"] == 12 and r["data"]["metrics"]["free_parts"] == 0 and r["data"]["metrics"]["scripts"] == 0 and r["data"]["scope"] == "Workspace.Lamps", r)
r = run("audit_missing", programs["audit_missing"])
ok("unknown path is an explicit error", not r.get("ok") and "path not found" in r["error"], r)

r = run("fix_dry", programs["fix_dry"])
c = r.get("data", {}).get("counts", {})
ok("dry run counts: anchor 30, shadows 60, mesh_collision 2 + mesh_render 1, emitter_caps 1 + lifetime 1 (owned emitter skipped), light_shadows 4 (12 - 8 kept), empty_containers 2", r.get("ok") and r["data"]["dry_run"] is True and c == {"anchor_free": 30, "shadows_small": 60, "mesh_collision": 2, "mesh_render": 1, "emitter_caps": 1, "emitter_lifetime": 1, "light_shadows": 4, "empty_containers": 2}, c)
ok("…and nothing changed", L.eval("function() return workspace.Junk.Free1.Anchored == false and workspace.Deco.Bolt1.CastShadow == true and workspace.FX.FxA.Fountain.Rate == 500 and workspace:FindFirstChild('EmptyFolder') ~= nil and #workspace.Lamps.Lamp1:GetChildren() == 1 end")())
ok("…text says DRY RUN and the score stays 72 -> 72", "DRY RUN" in r["text"] and r["data"]["score_before"] == 72 and r["data"]["score_after"] == 72, r["text"])

r = run("fix_real", programs["fix_real"])
ok("real fix: same counts, score 72 -> 83 (busy loops, post fx and the owned heavy emitter remain)", r.get("ok") and r["data"]["dry_run"] is False and r["data"]["counts"] == c and r["data"]["score_before"] == 72 and r["data"]["score_after"] == 83, r)
st = json.loads(L.eval("function() local ws = workspace local keep, off = 0, 0 for i = 1, 12 do local l = ws.Lamps['Lamp' .. i].PointLight if l.Shadows then keep = keep + 1 else off = off + 1 end end return M.jsonEncode({free1 = ws.Junk.Free1.Anchored, welded = ws.Junk.Welded.Anchored, npc = ws.Guard.Head.Anchored, wheel = ws.Kart.Wheel1.Anchored, bolt = ws.Deco.Bolt1.CastShadow, small = ws.Meshes.SmallRock.CollisionFidelity.Name, big = ws.Meshes.BigRock.CollisionFidelity.Name, bigR = ws.Meshes.BigRock.RenderFidelity.Name, statue = ws.Meshes.Statue.CollisionFidelity.Name, rate = ws.FX.FxA.Fountain.Rate, fogMax = ws.FX.FxB.Fog.Lifetime.Max, owned = ws.FX.FxC.Owned.Rate, keep = keep, off = off, strongest = ws.Lamps.Lamp12.PointLight.Shadows, weakest = ws.Lamps.Lamp1.PointLight.Shadows, emptyF = ws:FindFirstChild('EmptyFolder') ~= nil, emptyM = ws:FindFirstChild('EmptyModel') ~= nil, loose = ws:FindFirstChild('Loose') ~= nil, spinner = game:GetService('ServerScriptService').Spinner.Source}) end")())
ok("free parts anchored; welded / NPC / kart parts left unanchored", st["free1"] is True and st["welded"] is False and st["npc"] is False and st["wheel"] is False, st)
ok("tiny parts no longer cast shadows; small Precise mesh -> Box, big -> Hull, Precise render -> Automatic, Hull mesh untouched", st["bolt"] is False and st["small"] == "Box" and st["big"] == "Hull" and st["bigR"] == "Automatic" and st["statue"] == "Hull", st)
ok("emitter caps: Fountain 500 -> 200, Fog lifetime 30 -> 10, TotalVFX-owned 900 untouched", st["rate"] == 200 and st["fogMax"] == 10 and st["owned"] == 900, st)
ok("lights: the 8 strongest keep shadows (Lamp12 yes, Lamp1 no), 4 turned off", st["keep"] == 8 and st["off"] == 4 and st["strongest"] is True and st["weakest"] is False, st)
ok("empty Folder / Model deleted, the Model with children kept, scripts untouched", st["emptyF"] is False and st["emptyM"] is False and st["loose"] is True and "while true do" in st["spinner"], st)
ok("text names the counts, the score change and the remaining busy loops", "PERF FIX applied" in r["text"] and "anchor_free 30" in r["text"] and "72 -> 83" in r["text"] and "2 busy script loop(s)" in r["text"], r["text"])
ok("streaming was NOT touched by the default op set", L.eval("function() return workspace.StreamingEnabled ~= true end")())

r = run("audit_after", programs["audit_after"])
ok("audit after the fix: free 0, shadow_small 0, precise 0, heavy emitters 1 (owned), shadow lights 8, empties 0; score 83 with busy_loops + post_fx + heavy_emitters(owned) penalties", r.get("ok") and r["data"]["metrics"]["free_parts"] == 0 and r["data"]["metrics"]["shadow_small"] == 0 and r["data"]["metrics"]["precise_collision"] == 0 and r["data"]["metrics"]["heavy_emitters"] == 1 and r["data"]["metrics"]["shadow_lights"] == 8 and r["data"]["metrics"]["empty_containers"] == 0 and r["data"]["score"] == 83, r["data"]["metrics"])

r = run("fix_streaming", programs["fix_streaming"])
ok("explicit streaming op enables StreamingEnabled with 64 / 256 radii and warns about WaitForChild", r.get("ok") and r["data"]["counts"] == {"streaming": 1} and L.eval("function() return workspace.StreamingEnabled == true and workspace.StreamingMinRadius == 64 and workspace.StreamingTargetRadius == 256 end")() and "WaitForChild" in r["text"], r)
ok("unknown op refused before Luau, naming the valid ops", str(programs["fix_bad_op"]).startswith("--ERR") and "delete_everything" in programs["fix_bad_op"] and "anchor_free|shadows_small" in programs["fix_bad_op"], programs["fix_bad_op"][:200])
ok("ops must be an array", str(programs["fix_bad_type"]).startswith("--ERR") and "array" in programs["fix_bad_type"], programs["fix_bad_type"][:200])

print("\n%s perf-sim: %d passed, %d failed (mocked DataModel - a real Studio run is still the final word)" % ("OK " if failed == 0 else "FAIL", passed, failed))
sys.exit(1 if failed else 0)
