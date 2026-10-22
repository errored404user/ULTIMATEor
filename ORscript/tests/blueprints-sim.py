#!/usr/bin/env python3
"""Execute the System Blueprints (blueprint_*) Luau against the miniature Roblox DataModel.

tests/test-blueprints.js checks the pack statically; tests/luau-parse-check.py proves every
program and every library source parses. This script installs blueprints into
tests/roblox_sim.py, checks the instance layout, Config round-trips (JSON -> Lua table source
-> table), demo content, the edit-mode verification (structure + SelfTest), then BOOTS the
installed systems the way CoreServer does at Play and drives them with a fake player:
profile load, currency, shop purchase, checkpoints, quests auto-claim, pets hatch, rounds
state machine, combat hit, tycoon claim/buy/collect, admin command, sprint, leaderboards,
save + BindToClose. Finally it removes everything and checks nothing is left behind.

    pip install lupa && python3 tests/blueprints-sim.py          (from the ORscript root)
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
const out={commands:S.BLUEPRINT_COMMANDS, names:S.BLUEPRINT_NAMES, version:S.BLUEPRINT_VERSION, catalog:S.BLUEPRINT_CATALOG, order:S.blueprintOrder("pets"), programs:{}};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "list": ["blueprint_list", {}],
    "list_tag": ["blueprint_list", {"tag": "economy"}],
    "status_empty": ["blueprint_status", {}],
    "verify_empty": ["blueprint_verify", {}],
    "install_unknown": ["blueprint_install", {"name": "spaceships"}],
    "install_noname": ["blueprint_install", {}],
    "configure_nocfg": ["blueprint_configure", {"name": "pets"}],
    "remove_noname": ["blueprint_remove", {}],
    "install_pets": ["blueprint_install", {"name": "pets"}],
    "install_pets_again": ["blueprint_install", {"name": "pets"}],
    "install_currency_cfg": ["blueprint_install", {"name": "currency", "config": {"Currencies": [{"Name": "Coins", "Start": 250, "Leaderstat": True}]}}],
    "configure_pets": ["blueprint_configure", {"name": "pets", "config": {"MaxPets": 10, "Follow": {"Distance": 6}, "Note": "it's \"quoted\"\nline2"}}],
    "configure_missing": ["blueprint_configure", {"name": "tycoon", "config": {"Plots": 2}}],
    "configure_reset": ["blueprint_configure", {"name": "pets", "reset": True}],
    "install_all": ["blueprint_install", {"name": "all", "config": {"tycoon": {"Plots": 2}, "admin": {"Users": [{"UserId": 1, "Rank": "Admin"}]}, "currency": {"Currencies": [{"Name": "Coins", "Start": 250, "Leaderstat": True}, {"Name": "Gems", "Start": 0, "Leaderstat": True}]}}}],
    "status_full": ["blueprint_status", {}],
    "verify_all": ["blueprint_verify", {}],
    "verify_combat": ["blueprint_verify", {"name": "combat"}],
    "remove_pets": ["blueprint_remove", {"name": "pets"}],
    "remove_currency": ["blueprint_remove", {"name": "currency"}],
    "remove_all": ["blueprint_remove", {"name": "all"}],
    "status_after": ["blueprint_status", {}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:700]))


def run(key):
    M.waits = 0
    return run_program(key, data["programs"][key])


G = L.globals()
game = M.game
svc = lambda n: game.GetService(game, n)
WS, RS, SSS, SS, SP = svc("Workspace"), svc("ReplicatedStorage"), svc("ServerScriptService"), svc("ServerStorage"), svc("StarterPlayer")
find = lambda inst, name, rec=False: inst.FindFirstChild(inst, name, rec)
children = lambda inst: list(inst.GetChildren(inst).values()) if inst is not None else []
desc = lambda inst: list(inst.GetDescendants(inst).values())
attr = lambda inst, k: inst.GetAttribute(inst, k)
same = L.eval("function(a,b) return a == b end")
count = L.eval("function(t) return #t end")
lua_load = L.eval("function(src) local f,e=load(src,'=cfg') if not f then return nil,e end local okR,res=pcall(f) if not okR then return nil,res end return res end")
path = lambda p: L.eval("function(p) local n=game for _,s in ipairs(string.split(p,'.')) do n=n and n:FindFirstChild(s) end return n end")(p)


def two(res):
    """lupa returns a bare value for single returns and a tuple for multiple returns."""
    if isinstance(res, tuple):
        return (res[0], res[1] if len(res) > 1 else None)
    return (res, None)


def verify_summary(v):
    fails = []
    for s in v:
        for c in s.get("checks", []):
            if not c.get("ok"):
                fails.append(s["name"] + ": " + c["name"] + (" - " + c["detail"] if c.get("detail") else ""))
    return fails


# ───────────────────────── catalogue ─────────────────────────
ok("6 blueprint commands registered", data["commands"] == ["blueprint_list", "blueprint_install", "blueprint_configure", "blueprint_verify", "blueprint_remove", "blueprint_status"], data["commands"])
ok("12 blueprints in the catalogue", len(data["names"]) == 12 and set(data["names"]) == {"currency", "shop", "pets", "combat", "rounds", "checkpoints", "quests", "tycoon", "leaderboards", "admin", "anticheat", "sprint"}, data["names"])
ok("pack version 1.31.0", data["version"] == "1.31.0")
ok("dependency order resolves pets -> currency first", data["order"]["order"] == ["currency", "pets"], data["order"])
ok("catalogue entries carry api / remotes / bus / next_steps", all(c["api"] and c["summary"] and isinstance(c["next_steps"], list) and len(c["next_steps"]) >= 1 for c in data["catalog"]))
for k, frag in (("install_unknown", "unknown blueprint"), ("install_noname", "name is required"), ("configure_nocfg", "config object is required"), ("remove_noname", "name is required")):
    ok(k + " rejected at build time", data["programs"][k].startswith("--ERR") and frag in data["programs"][k], data["programs"][k][:200])

r = run("list")
ok("blueprint_list: 12 entries, none installed", r.get("ok") is True and r["data"]["count"] == 12 and r["data"]["installed_count"] == 0 and all(e["installed"] is False for e in r["data"]["blueprints"]), r)
r = run("list_tag")
ok("blueprint_list tag=economy filters (currency, shop, pets, tycoon)", r.get("ok") is True and {e["name"] for e in r["data"]["blueprints"]} == {"currency", "shop", "pets", "tycoon"}, r)
r = run("status_empty")
ok("status on an empty place", r.get("ok") is True and r["data"]["systems"] == [] and r["data"]["core"]["module"] is False and len(r["data"]["not_installed"]) == 12, r)
r = run("verify_empty")
ok("verify on an empty place reports nothing installed", r.get("ok") is True and "no blueprints installed" in r.get("text", ""), r)

# ───────────────────────── install pets (+ currency dependency) ─────────────────────────
r = run("install_pets")
ok("install pets ok, currency installed first", r.get("ok") is True and r["data"]["installed"] == ["currency", "pets"], r)
ok("Core created (module + server + client)", r["data"]["core"] == {"Core": "created", "CoreServer": "created", "CoreClient": "created"}, r["data"].get("core"))
core = path("ReplicatedStorage.OR_Systems.Core")
ok("ReplicatedStorage.OR_Systems.Core ModuleScript with OR_Version", core is not None and core.ClassName == "ModuleScript" and attr(core, "OR_Version") == "1.31.0" and "Core.Data" in core.Source)
pets = path("ReplicatedStorage.OR_Systems.Pets")
cur = path("ReplicatedStorage.OR_Systems.Currency")
ok("system folders tagged OR_Blueprint / OR_BlueprintVersion / OR_Depends", pets is not None and attr(pets, "OR_Blueprint") == "pets" and attr(pets, "OR_BlueprintVersion") == "1.31.0" and attr(pets, "OR_Depends") == '["currency"]' and attr(cur, "OR_Blueprint") == "currency")
ok("Config + Remotes under each system", all(find(f, "Config") is not None and find(f, "Config").ClassName == "ModuleScript" and find(f, "Remotes") is not None for f in (pets, cur)))
cfg_src = find(pets, "Config").Source
cfg_tbl = lua_load(cfg_src)
ok("Pets Config source is a readable Lua table that loads", cfg_src.startswith("-- Pets config") and cfg_tbl is not None and cfg_tbl["MaxPets"] == 50 and cfg_tbl["Eggs"][1]["Pets"][5]["Id"] == "dragon" and cfg_tbl["Follow"]["Distance"] == 4, cfg_src[:300])
cfg_json = json.loads(attr(find(pets, "Config"), "OR_ConfigJSON"))
ok("OR_ConfigJSON mirrors the defaults", cfg_json["MaxPets"] == 50 and cfg_json["Eggs"][0]["Pets"][0]["Id"] == "dog" and cfg_json["ModelsFolder"] == "ReplicatedStorage.OR_Systems.Pets.Models")
ok("ServerScriptService.OR_Systems: CoreServer Script + Currency.Service + Pets.Service", path("ServerScriptService.OR_Systems.CoreServer") is not None and path("ServerScriptService.OR_Systems.CoreServer").ClassName == "Script" and path("ServerScriptService.OR_Systems.Pets.Service").ClassName == "ModuleScript" and path("ServerScriptService.OR_Systems.Currency.Service") is not None)
ok("StarterPlayerScripts.OR_Systems: CoreClient + PetsClient (currency has no client)", path("StarterPlayer.StarterPlayerScripts.OR_Systems.CoreClient").ClassName == "LocalScript" and path("StarterPlayer.StarterPlayerScripts.OR_Systems.PetsClient") is not None and path("StarterPlayer.StarterPlayerScripts.OR_Systems.CurrencyClient") is None)
ok("ReplicatedStorage.Remotes.OR_Notify RemoteEvent", path("ReplicatedStorage.Remotes.OR_Notify") is not None and path("ReplicatedStorage.Remotes.OR_Notify").ClassName == "RemoteEvent")
v = r["data"]["verify"]
ok("install verified both systems with zero failures", r["data"]["verify_failed"] == 0 and [s["name"] for s in v] == ["currency", "pets"], verify_summary(v))
pet_checks = [c["name"] for c in v[1]["checks"]]
ok("pets self-tests ran in edit mode (odds, roll, capacity)", sum(1 for n in pet_checks if n.startswith("self-test:")) >= 3 and "Service compiles and requires Core" in pet_checks, pet_checks)
ok("next_steps mention API access + egg UI", any("API services" in s for s in r["data"]["next_steps"]) and any("egg UI" in s for s in r["data"]["next_steps"]))
ok("no warnings during install", len(list(M.warnings.values())) == 0, list(M.warnings.values()))

n_before = len(desc(RS)) + len(desc(SSS)) + len(desc(SP))
r = run("install_pets_again")
ok("re-install keeps Service/Config and creates nothing new", r.get("ok") is True and any("Service (kept)" in w for w in r["data"]["written"]) and any("Config (merged)" in w for w in r["data"]["written"]) and len(desc(RS)) + len(desc(SSS)) + len(desc(SP)) == n_before, r["data"]["written"])

r = run("install_currency_cfg")
cj = json.loads(attr(path("ReplicatedStorage.OR_Systems.Currency.Config"), "OR_ConfigJSON"))
ok("install with config overrides: arrays replace wholesale, other keys keep defaults", r.get("ok") is True and len(cj["Currencies"]) == 1 and cj["Currencies"][0]["Start"] == 250 and cj["Data"]["StoreName"] == "OR_Profiles" and cj["Rewards"]["OnKill"]["Coins"] == 10, cj)

r = run("configure_pets")
cj = json.loads(attr(path("ReplicatedStorage.OR_Systems.Pets.Config"), "OR_ConfigJSON"))
ok("configure deep-merges (MaxPets 10, Follow.Distance 6, Follow.Height kept)", r.get("ok") is True and cj["MaxPets"] == 10 and cj["Follow"]["Distance"] == 6 and cj["Follow"]["Height"] == 1.5 and sorted(r["data"]["changed_keys"]) == ["Follow", "MaxPets", "Note"], r)
t = lua_load(path("ReplicatedStorage.OR_Systems.Pets.Config").Source)
ok("configured Config source round-trips (quotes + newline escaped by %q)", t is not None and t["MaxPets"] == 10 and t["Note"] == "it's \"quoted\"\nline2" and t["Follow"]["Distance"] == 6, path("ReplicatedStorage.OR_Systems.Pets.Config").Source[-400:])
ok("configure re-verifies the system", r["data"]["verify"]["failed"] == 0 and r["data"]["verify"]["passed"] >= 8, r["data"]["verify"])
r = run("configure_missing")
ok("configure on a system that is not installed fails clearly", r.get("ok") is False and "not installed" in r.get("error", ""), r)
r = run("configure_reset")
cj = json.loads(attr(path("ReplicatedStorage.OR_Systems.Pets.Config"), "OR_ConfigJSON"))
ok("configure reset restores defaults", r.get("ok") is True and cj["MaxPets"] == 50 and "Note" not in cj, cj)

# ───────────────────────── install everything ─────────────────────────
r = run("install_all")
ok("install all: 12 systems", r.get("ok") is True and len(r["data"]["installed"]) == 12 and r["data"]["installed"][0] == "currency", r)
ok("dependencies before dependants (currency < shop/pets/tycoon)", r["data"]["installed"].index("currency") < min(r["data"]["installed"].index(k) for k in ("shop", "pets", "tycoon")))
ok("all 12 verified with zero failures", r["data"]["verify_failed"] == 0 and len(r["data"]["verify"]) == 12, verify_summary(r["data"]["verify"]))
total_checks = sum(len(s["checks"]) for s in r["data"]["verify"])
ok("verification is substantial (>= 100 checks incl. self-tests)", total_checks >= 100, total_checks)
ok("per-system config applied when installing several (tycoon Plots 2, admin Users)", json.loads(attr(path("ReplicatedStorage.OR_Systems.Tycoon.Config"), "OR_ConfigJSON"))["Plots"] == 2 and json.loads(attr(path("ReplicatedStorage.OR_Systems.Admin.Config"), "OR_ConfigJSON"))["Users"][0]["UserId"] == 1)
cp = find(WS, "OR_Checkpoints")
ok("demo obby course: Start SpawnLocation + 10 checkpoints with Stage attributes", cp is not None and attr(cp, "OR_BlueprintDemo") == "checkpoints" and find(cp, "Start").ClassName == "SpawnLocation" and all(find(cp, "Checkpoint%d" % i) is not None and attr(find(cp, "Checkpoint%d" % i), "Stage") == i for i in range(1, 11)))
ty = find(WS, "OR_Tycoons")
plots = [c for c in children(ty)] if ty else []
ok("demo tycoon: 2 plots with ClaimPad/CashPad/Collector/Conveyor/Buttons/Objects", len(plots) == 2 and all(find(p, n) is not None for p in plots for n in ("ClaimPad", "CashPad", "Collector", "Conveyor", "Buttons", "Objects", "Base")), [p.Name for p in plots])
objs = children(find(plots[0], "Objects")) if plots else []
ok("plot objects follow Config.Buttons (3 droppers with Spout + 1 upgrade)", len(objs) == 4 and sum(1 for o in objs if attr(o, "Dropper")) == 3 and all(find(o, "Spout") is not None for o in objs if attr(o, "Dropper")) and {attr(b, "ButtonId") for b in children(find(plots[0], "Buttons"))} == {"dropper1", "dropper2", "upgrade_value", "dropper3"}, [o.Name for o in objs])
ok("conveyor pushes toward the collector (anchored, velocity +Z)", find(plots[0], "Conveyor").Anchored and find(plots[0], "Conveyor").AssemblyLinearVelocity.Z > 0)
lb = find(WS, "OR_Leaderboards")
ok("demo leaderboard parts CoinsBoard + KillsBoard", lb is not None and find(lb, "CoinsBoard") is not None and find(lb, "KillsBoard") is not None and find(lb, "CoinsBoard").IsA(find(lb, "CoinsBoard"), "BasePart"))
arena = path("ReplicatedStorage.OR_Systems.Rounds.Maps.DemoArena")
ok("demo arena in Rounds.Maps with 4 spawn parts (not in Workspace)", arena is not None and sum(1 for d in desc(arena) if d.Name.startswith("Spawn")) == 4 and find(WS, "DemoArena") is None)
tools = find(SS, "OR_Tools")
sword = tools and find(tools, "Sword")
ok("combat weapon Tools generated in ServerStorage.OR_Tools (Sword, FireStaff; Fists has no Tool)", sword is not None and find(tools, "FireStaff") is not None and find(tools, "Fists") is None and sword.ClassName == "Tool")
ok("weapon Tool has Handle + OR_WeaponClient LocalScript + Cooldown attribute + OR_Blueprint tag", find(sword, "Handle") is not None and find(sword, "OR_WeaponClient").ClassName == "LocalScript" and "FireServer" in find(sword, "OR_WeaponClient").Source and attr(sword, "Cooldown") == 0.6 and attr(sword, "OR_Blueprint") == "combat")
ok("shop did not duplicate the Sword tool", sum(1 for t in children(tools) if t.Name == "Sword") == 1 and sorted(r["data"]["tools"])[0].endswith("FireStaff"), r["data"]["tools"])
ok("no warnings from install all", len(list(M.warnings.values())) == 0, list(M.warnings.values()))

r = run("list")
ok("blueprint_list after install reports 12 installed with versions", r["data"]["installed_count"] == 12 and all(e["installed_version"] == "1.31.0" for e in r["data"]["blueprints"]), r["data"]["installed_count"])
r = run("status_full")
ok("status: 12 systems, no problems, 2 generated tools, core complete", r.get("ok") is True and len(r["data"]["systems"]) == 12 and r["data"]["problems"] == [] and len(r["data"]["generated_tools"]) == 2 and r["data"]["core"]["module"] and r["data"]["core"]["server"] and r["data"]["core"]["client"] and r["data"]["core"]["notify_remote"], r)
ok("status lists missing dependencies as empty and config keys", all(s["missing_dependencies"] == [] and len(s["config_keys"]) >= 2 and s["service"] for s in r["data"]["systems"]))
r = run("verify_all")
ok("verify all: zero failures", r.get("ok") is True and r["data"]["failed"] == 0 and len(r["data"]["systems"]) == 12 and r["data"]["failures"] == [], r["data"].get("failures"))
r = run("verify_combat")
cn = [c["name"] for c in r["data"]["systems"][0]["checks"]]
ok("verify combat: cooldown / damage pipeline self-tests", r["data"]["failed"] == 0 and any("cooldown" in n.lower() for n in cn), cn)

# ───────────────────────── runtime boot (what CoreServer does at Play) ─────────────────────────
Players = svc("Players")
player = M.fakePlayer
player.Parent = Players
M.players[1] = player
rig = M.buildRig(G.Enum.HumanoidRigType.R15, "Tester", False)
rig.Parent = WS
player.Character = rig
M.isEdit = False
M.invalidate()
M.waits = 0
boot_err = None
try:
    M.runScript(path("ServerScriptService.OR_Systems.CoreServer"))
except Exception as e:
    boot_err = e
ok("CoreServer boots the Data layer and all 12 services without error", boot_err is None, boot_err)
Core = M.runModule(core)
use = lambda n: Core["Use"](n)
Currency, Shop, Pets, Combat, Rounds, Checkpoints, Quests, Tycoon, Leaderboards, Admin, Anticheat, Sprint = [use(n) for n in ("Currency", "Shop", "Pets", "Combat", "Rounds", "Checkpoints", "Quests", "Tycoon", "Leaderboards", "Admin", "Anticheat", "Sprint")]
ok("every Service resolved through Core.Use", all(x is not None for x in (Currency, Shop, Pets, Combat, Rounds, Checkpoints, Quests, Tycoon, Leaderboards, Admin, Anticheat, Sprint)), list(M.warnings.values()))
ok("profile loaded for the existing player (session lock written to the DataStore)", Core["Data"]["IsLoaded"](player) is True and "OR_Profiles_v1" in list(M.datastores.keys()) and M.datastores["OR_Profiles_v1"]["p_1"]["__lock"] is not None, list(M.datastores.keys()))
ok("Currency: start balance 250 (configured) + Gems 0, leaderstats mirrored", Currency["Get"](player, "Coins") == 250 and Currency["Get"](player, "Gems") == 0 and Core["Leaderstats"]["Get"](player, "Coins") == 250)
Currency["Add"](player, "Coins", 100, "test")
ok("Currency.Add -> 350, leaderstat follows", Currency["Get"](player, "Coins") == 350 and Core["Leaderstats"]["Get"](player, "Coins") == 350)
ok("Currency.Changed reached Leaderboards (OrderedDataStore row for user 1)", "OR_Leaderboard_Coins" in list(M.ordered.keys()) and M.ordered["OR_Leaderboard_Coins"]["1"] == 350, [(k, dict(v)) for k, v in M.ordered.items()])
okP, err = two(Shop["Purchase"](player, "speed_boost"))
ok("Shop.Purchase speed_boost: paid 150, owned, WalkSpeed boost applied", okP is True and Currency["Get"](player, "Coins") == 200 and Shop["Owns"](player, "speed_boost") is True and find(rig, "Humanoid").WalkSpeed == 24, (okP, err))
okP, err = two(Shop["Purchase"](player, "speed_boost"))
ok("buying it twice is refused", okP is False and err, (okP, err))
okP, err = two(Shop["Purchase"](player, "golden_trail"))
ok("cannot afford Gems item", okP is False, (okP, err))
okS, _ = two(Checkpoints["SetStage"](player, 3, "touch"))
ok("Checkpoints.SetStage 3 -> Stage leaderstat + OnCheckpoint reward", okS is True and Core["Leaderstats"]["Get"](player, "Stage") == 3 and Currency["Get"](player, "Coins") == 205)
okS, why = two(Checkpoints["SetStage"](player, 1, "touch"))
ok("going backwards is refused unless AllowBackwards", okS is False and why == "backwards", (okS, why))
snap = {q["Id"]: q for q in M.lua_to_py(Quests["Snapshot"](player))}
ok("quests tracked progress from the Bus (stage_10 max-mode = 3, earn_500 = 105)", snap["stage_10"]["Progress"] == 3 and snap["earn_500"]["Progress"] == 105, snap)
Currency["Add"](player, "Coins", 1000, "grind")
snap = {q["Id"]: q for q in M.lua_to_py(Quests["Snapshot"](player))}
ok("earn_500 completed + auto-claimed -> 5 Gems paid through Currency.Request", snap["earn_500"]["Claimed"] is True and snap["earn_500"]["Progress"] == 500 and Currency["Get"](player, "Gems") == 5, (snap["earn_500"], Currency["Get"](player, "Gems")))
pet, perr = two(Pets["Hatch"](player, "basic_egg"))
inv = M.lua_to_py(Pets["Inventory"](player))
ok("Pets.Hatch: paid 100, pet in inventory with a rarity from the egg", pet is not None and Currency["Get"](player, "Coins") == 1105 and len(inv) == 1 and inv[0]["Rarity"] in ("Common", "Rare", "Epic", "Legendary"), (perr, inv))
snap = {q["Id"]: q for q in M.lua_to_py(Quests["Snapshot"](player))}
ok("hatch counted for the hatch_3 quest", snap["hatch_3"]["Progress"] == 1, snap["hatch_3"])
# combat: an enemy rig right in front of the player, sword equipped
enemy = M.buildRig(G.Enum.HumanoidRigType.R15, "Enemy", False)
enemy.Parent = WS
L.eval("function(e, r) e:PivotTo(r:GetPivot() * CFrame.new(0, 0, -4)) end")(enemy, rig)
swordClone = sword.Clone(sword)
swordClone.Parent = rig
hits, herr = two(Combat["Attack"](player, "Sword"))
ok("Combat.Attack Sword hits the enemy in the hitbox (25 damage)", hits == 1 and find(enemy, "Humanoid").Health == 75, (hits, herr, find(enemy, "Humanoid").Health))
hits, herr = two(Combat["Attack"](player, "Sword"))
ok("second swing inside the cooldown is refused", hits == 0 and herr is not None, (hits, herr))
hits, herr = two(Combat["Attack"](player, "Fists"))
ok("Fists (no Tool) attack goes through the same pipeline (i-frames block the instant follow-up)", hits == 0 or hits == 1, (hits, herr))
# tycoon
plot1 = plots[0]
okT, terr = two(Tycoon["Claim"](player, plot1))
ok("Tycoon.Claim plot 1", okT is True and attr(plot1, "Owner") == 1 and same(Tycoon["PlotOf"](player), plot1), (okT, terr))
okT, terr = two(Tycoon["Buy"](player, "dropper3"))
ok("locked button refused (requires upgrade_value)", okT is False and "requires" in str(terr), (okT, terr))
okT, terr = two(Tycoon["Buy"](player, "dropper1"))
d1 = find(find(plot1, "Objects"), "Dropper1")
ok("free starter dropper bought -> object revealed (Enabled attr, parts visible)", okT is True and attr(d1, "Enabled") is True and find(d1, "Spout").Transparency == 0, terr)
coins0 = Currency["Get"](player, "Coins")
okT, terr = two(Tycoon["Buy"](player, "dropper2"))
ok("dropper2 costs 150 Coins", okT is True and Currency["Get"](player, "Coins") == coins0 - 150, (okT, terr))
ore = G.Instance.new("Part")
ore.Name = "Ore"
ore.SetAttribute(ore, "Value", 40)
find(plot1, "Collector").Touched.Fire(find(plot1, "Collector").Touched, ore)
collected = Tycoon["Collect"](player)
ok("ore touching the collector banks its value; CashPad collect pays it out", collected == 40 and Currency["Get"](player, "Coins") == coins0 - 150 + 40, collected)
# rounds
ph = Rounds["Tick"](1)
ok("Rounds: Waiting -> Intermission once MinPlayers present", ph == "Intermission", ph)
ph = Rounds["Tick"](100)
cur_map = find(WS, "OR_CurrentMap")
ok("Rounds: Intermission -> Round, DemoArena cloned into Workspace, player alive + teleported up to the arena", ph == "Round" and cur_map is not None and count(Rounds["Alive"]()) == 1 and rig.GetPivot(rig).Position.Y > 100, (ph, rig.GetPivot(rig).Position.Y))
st = path("ReplicatedStorage.OR_Systems.Rounds.State")
ok("State folder replicates Phase/TimeLeft/Map", st is not None and find(st, "Phase").Value == "Round" and find(st, "Map").Value == "DemoArena" and find(st, "TimeLeft").Value > 0)
coins_before_win = Currency["Get"](player, "Coins")
ph = Rounds["Tick"](500)
ok("Rounds: timer ends the round -> Results, winner rewarded (+50 Coins), map removed", ph == "Results" and find(st, "Winner").Value == "Tester" and Currency["Get"](player, "Coins") == coins_before_win + 50 and find(WS, "OR_CurrentMap") is None, (ph, find(st, "Winner").Value))
snap = {q["Id"]: q for q in M.lua_to_py(Quests["Snapshot"](player))}
ok("win_round quest auto-claimed (+3 Gems)", snap["win_round"]["Claimed"] is True and Currency["Get"](player, "Gems") == 8, snap["win_round"])
# admin
okA, msg = two(Admin["Execute"](player, ":rank"))
ok("Admin: place creator is Owner", okA is True and msg.startswith("Owner"), (okA, msg))
cb = Currency["Get"](player, "Coins")
okA, msg = two(Admin["Execute"](player, ":give me Coins 10"))
ok("Admin :give me Coins 10", okA is True and Currency["Get"](player, "Coins") == cb + 10, (okA, msg))
okA, msg = two(Admin["Execute"](player, ":fly me"))
ok("unknown admin command reported", okA is False and "unknown command" in msg, msg)
ok("plain chat is not a command", two(Admin["Execute"](player, "hello"))[0] is False)
# sprint + anticheat
Sprint["Set"](player, True)
ok("Sprint.Set true -> WalkSpeed 24 and OR_MaxSpeed attribute for the anticheat", find(rig, "Humanoid").WalkSpeed == 24 and attr(player, "OR_MaxSpeed") == 24 and Sprint["IsSprinting"](player) is True)
Sprint["Set"](player, False)
ok("Sprint.Set false -> WalkSpeed back to 16", find(rig, "Humanoid").WalkSpeed == 16)
ok("Anticheat has no strikes against a legit player", Anticheat["Strikes"](player) == 0)
# leaderboards
rows = M.lua_to_py(Leaderboards["Refresh"]("Coins"))
board = find(lb, "CoinsBoard")
row1 = board and find(board, "Row1", True)
ok("Leaderboards.Refresh reads the OrderedDataStore and renders the SurfaceGui board", rows and rows[0]["UserId"] == 1 and rows[0]["Name"] == "Tester" and row1 is not None and "Tester" in row1.Text, (rows, row1 and row1.Text))
# save / close
ok("Core.Data.Save writes the profile (Currency + Shop + Pets + Quests + Checkpoints)", Core["Data"]["Save"](player) is True and all(k in M.lua_to_py(M.datastores["OR_Profiles_v1"]["p_1"]) for k in ("Currency", "Shop", "Pets", "Quests", "Checkpoints", "Tycoon")), list(M.lua_to_py(M.datastores["OR_Profiles_v1"]["p_1"]).keys()))
ok("BindToClose registered to flush profiles", len(list(M.closeHandlers.values())) >= 1)
status = M.lua_to_py(Core["Data"]["Status"]())
ok("Core.Data.Status reports 1 profile, store enabled", status["profiles"] == 1 and status["store"] is True and status["started"] is True, status)
Players.PlayerRemoving.Fire(Players.PlayerRemoving, player)
ok("PlayerRemoving releases the session lock and drops the profile", Core["Data"]["IsLoaded"](player) is False and M.datastores["OR_Profiles_v1"]["p_1"]["__lock"] is None)
warns = [w for w in M.warnings.values() if "READ-ONLY" in w or "failed" in w]
ok("no load/save failures were warned", len(warns) == 0, warns)

# ───────────────────────── removal ─────────────────────────
M.isEdit = True
r = run("remove_pets")
ok("remove pets: its 3 folders gone, currency stays, nothing depends on pets", r.get("ok") is True and path("ReplicatedStorage.OR_Systems.Pets") is None and path("ServerScriptService.OR_Systems.Pets") is None and path("StarterPlayer.StarterPlayerScripts.OR_Systems.PetsClient") is None and path("ReplicatedStorage.OR_Systems.Currency") is not None and r["data"]["warnings"] == [] and "pets" not in r["data"]["remaining"], r)
r = run("remove_currency")
ok("remove currency warns about shop + tycoon depending on it", r.get("ok") is True and any("shop depends on currency" in w for w in r["data"]["warnings"]) and any("tycoon depends on currency" in w for w in r["data"]["warnings"]), r["data"]["warnings"])
r = run("remove_all")
ok("remove all: Core + OR_Systems roots + tools + demo content gone", r.get("ok") is True and r["data"].get("core_removed") is True and find(RS, "OR_Systems") is None and find(SSS, "OR_Systems") is None and path("StarterPlayer.StarterPlayerScripts.OR_Systems") is None and find(SS, "OR_Tools") is None and find(WS, "OR_Checkpoints") is None and find(WS, "OR_Tycoons") is None and find(WS, "OR_Leaderboards") is None, r)
ok("player profiles untouched by removal", "p_1" in list(M.datastores["OR_Profiles_v1"].keys()) and "never deleted" in r["data"]["kept_data"])
r = run("status_after")
ok("status after removal: nothing installed", r.get("ok") is True and r["data"]["systems"] == [] and "no blueprints installed" in r.get("text", ""), r)

passed = sum(results)
print("\n%d passed, %d failed" % (passed, len(results) - passed))
sys.exit(0 if passed == len(results) else 1)
