#!/usr/bin/env python3
"""Execute the Project Index (project_index_*) Luau against the miniature Roblox DataModel.

tests/test-project-index.js checks the pack statically; this script builds a fake place
(modules, server scripts, LocalScripts, remotes, a DataStore, tags, TODOs, a require cycle,
an orphan module, a remote fired but never handled, a remote referenced without an instance)
in tests/roblox_sim.py and runs the six commands end to end: extraction per script, require
resolution + required_by, hubs / orphans / cycles, remote producers vs consumers + mismatches,
conventions (indent, naming, strict ratio, wait style, frameworks), the PROJECT MAP text,
storage round-trip through ServerStorage.Total_ProjectIndex, search, per-script lookup, graph
queries, then edits a script and checks stale detection + project_index_changes.

    pip install lupa && python3 tests/project-index-sim.py          (from the TotalScript root)
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
const out={commands:S.PROJECT_COMMANDS, version:S.PROJECT_INDEX_VERSION, programs:{}};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "summary_none": ["project_index_summary", {}],
    "changes_none": ["project_index_changes", {}],
    "search_noquery": ["project_index_search", {}],
    "search_badkind": ["project_index_search", {"query": "x", "kind": "planet"}],
    "script_nopath": ["project_index_script", {}],
    "graph_badkind": ["project_index_graph", {"kind": "spaghetti"}],
    "build_dry": ["project_index_build", {"dry_run": True}],
    "build": ["project_index_build", {}],
    "build_again": ["project_index_build", {}],
    "build_scope": ["project_index_build", {"scope": "ServerScriptService", "dry_run": True}],
    "build_scope_bad": ["project_index_build", {"scope": "ServerScriptService.Nope", "dry_run": True}],
    "summary": ["project_index_summary", {}],
    "summary_short": ["project_index_summary", {"max_chars": 300}],
    "search_fn": ["project_index_search", {"query": "AddCoins"}],
    "search_remote": ["project_index_search", {"query": "BuyItem", "kind": "remote"}],
    "search_require": ["project_index_search", {"query": "Signal", "kind": "require"}],
    "search_ds": ["project_index_search", {"query": "PlayerData", "kind": "datastore"}],
    "search_tag": ["project_index_search", {"query": "Coin", "kind": "tag"}],
    "search_service": ["project_index_search", {"query": "DataStoreService", "kind": "service"}],
    "search_path": ["project_index_search", {"query": "Modules.", "kind": "path"}],
    "search_todo": ["project_index_search", {"query": "", "kind": "todo"}],
    "search_none": ["project_index_search", {"query": "zzzzqq"}],
    "search_limit": ["project_index_search", {"query": "e", "limit": 3}],
    "script_full": ["project_index_script", {"path": "ServerScriptService.Server.ShopServer"}],
    "script_suffix": ["project_index_script", {"path": "Modules.Currency"}],
    "script_name": ["project_index_script", {"path": "Signal"}],
    "script_ambiguous": ["project_index_script", {"path": "Util"}],
    "script_missing": ["project_index_script", {"path": "Nope.Nothing"}],
    "graph_req": ["project_index_graph", {}],
    "graph_root": ["project_index_graph", {"root": "ShopServer", "depth": 1}],
    "graph_remotes": ["project_index_graph", {"kind": "remotes"}],
    "graph_remotes_filter": ["project_index_graph", {"kind": "remotes", "root": "buy"}],
    "changes": ["project_index_changes", {}],
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


game = M.game
svc = lambda n: game.GetService(game, n)
RS, SSS, SS, SP, SG = svc("ReplicatedStorage"), svc("ServerScriptService"), svc("ServerStorage"), svc("StarterPlayer"), svc("StarterGui")
attr = lambda inst, k: inst.GetAttribute(inst, k)
path = lambda p: L.eval("function(p) local n=game for _,s in ipairs(string.split(p,'.')) do n=n and n:FindFirstChild(s) end return n end")(p)
mk = L.eval("function(cls,name,parent,src) local i=Instance.new(cls) i.Name=name if src then i.Source=src end i.Parent=parent return i end")

# ───────────────────────── fake project ─────────────────────────
modules = mk("Folder", "Modules", RS)
remotes = mk("Folder", "Remotes", RS)
for n in ("BuyItem", "CoinsChanged", "RequestTeleport", "UnusedRemote"):
    mk("RemoteEvent", n, remotes)
mk("RemoteFunction", "GetInventory", remotes)
server = mk("Folder", "Server", SSS)
sps = mk("Folder", "StarterPlayerScripts", SP)
client = mk("Folder", "Client", sps)
util_a = mk("Folder", "UtilA", modules)
util_b = mk("Folder", "UtilB", modules)

mk("ModuleScript", "Signal", modules, "--!strict\nlocal Signal = {}\nSignal.__index = Signal\n\nfunction Signal.new()\n\treturn setmetatable({ _handlers = {} }, Signal)\nend\n\nfunction Signal:Connect(fn)\n\ttable.insert(self._handlers, fn)\nend\n\nfunction Signal:Fire(...)\n\tfor _, h in ipairs(self._handlers) do\n\t\ttask.spawn(h, ...)\n\tend\nend\n\nreturn Signal\n")
mk("ModuleScript", "Currency", modules, "--!strict\nlocal ReplicatedStorage = game:GetService(\"ReplicatedStorage\")\nlocal DataStoreService = game:GetService(\"DataStoreService\")\nlocal Signal = require(ReplicatedStorage.Modules.Signal)\nlocal store = DataStoreService:GetDataStore(\"PlayerData\")\n\nlocal Currency = {}\nCurrency.Changed = Signal.new()\n\nfunction Currency.AddCoins(player, amount)\n\t-- TODO: clamp amount\n\tlocal coins = player.leaderstats.Coins\n\tcoins.Value = coins.Value + amount\n\tCurrency.Changed:Fire(player, coins.Value)\nend\n\nfunction Currency.GetCoins(player)\n\treturn player.leaderstats.Coins.Value\nend\n\nreturn Currency\n")
mk("ModuleScript", "Inventory", modules, "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")\nlocal Currency = require(ReplicatedStorage.Modules.Currency)\nlocal Shop = require(ReplicatedStorage.Modules.ShopData)\n\nlocal Inventory = {}\n\nfunction Inventory.Add(player, itemId)\n\tlocal list = Inventory.Get(player)\n\ttable.insert(list, itemId)\nend\n\nfunction Inventory.Get(player)\n\treturn {}\nend\n\nreturn Inventory\n")
mk("ModuleScript", "ShopData", modules, "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")\nlocal Inventory = require(ReplicatedStorage.Modules.Inventory) -- cycle on purpose\n\nreturn {\n\tItems = { { Id = \"sword\", Price = 100 }, { Id = \"shield\", Price = 50 } },\n}\n")
mk("ModuleScript", "LonelyHelper", modules, "local LonelyHelper = {}\nfunction LonelyHelper.nothing()\nend\nreturn LonelyHelper\n")
mk("ModuleScript", "Util", util_a, "return { a = 1 }\n")
mk("ModuleScript", "Util", util_b, "return { b = 2 }\n")

mk("Script", "ShopServer", server, "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")\nlocal Players = game:GetService(\"Players\")\nlocal CollectionService = game:GetService(\"CollectionService\")\nlocal Currency = require(ReplicatedStorage.Modules.Currency)\nlocal Inventory = require(ReplicatedStorage.Modules.Inventory)\nlocal Util = require(ReplicatedStorage.Modules.UtilA.Util)\nlocal Remotes = ReplicatedStorage:WaitForChild(\"Remotes\")\nlocal BuyItem = Remotes:WaitForChild(\"BuyItem\")\nlocal CoinsChanged = Remotes:WaitForChild(\"CoinsChanged\")\nlocal GetInventory = Remotes:WaitForChild(\"GetInventory\")\n\nlocal function handleBuy(player, itemId)\n\tif Currency.GetCoins(player) < 100 then\n\t\treturn\n\tend\n\tCurrency.AddCoins(player, -100)\n\tInventory.Add(player, itemId)\n\tCoinsChanged:FireClient(player, Currency.GetCoins(player))\nend\n\nBuyItem.OnServerEvent:Connect(handleBuy)\nGetInventory.OnServerInvoke = function(player)\n\treturn Inventory.Get(player)\nend\n\nfor _, coin in ipairs(CollectionService:GetTagged(\"Coin\")) do\n\tcoin.Touched:Connect(function(hit)\n\t\t-- FIXME: debounce\n\t\twait(0.1)\n\tend)\nend\n")
mk("Script", "Teleporter", server, "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")\nlocal Remotes = ReplicatedStorage.Remotes\n\nlocal function teleport(player, target)\n\ttask.wait(0.2)\nend\n\nRemotes.RequestTeleport.OnServerEvent:Connect(teleport)\nReplicatedStorage.Remotes.GhostRemote.OnServerEvent:Connect(function() end)\n")
mk("ModuleScript", "SecretConfig", SS, "return { Secret = true }\n")

mk("LocalScript", "ShopUI", client, "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")\nlocal Players = game:GetService(\"Players\")\nlocal Remotes = ReplicatedStorage:WaitForChild(\"Remotes\")\nlocal BuyItem = Remotes:WaitForChild(\"BuyItem\")\nlocal CoinsChanged = Remotes:WaitForChild(\"CoinsChanged\")\nlocal GetInventory = Remotes:WaitForChild(\"GetInventory\")\nlocal ShopData = require(ReplicatedStorage.Modules.ShopData)\n\nlocal function onBuyClicked(itemId)\n\tBuyItem:FireServer(itemId)\nend\n\nCoinsChanged.OnClientEvent:Connect(function(coins)\n\tprint(coins)\nend)\n\nlocal inv = GetInventory:InvokeServer()\n")
mk("LocalScript", "HudController", client, "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")\nlocal Remotes = ReplicatedStorage:WaitForChild(\"Remotes\")\nlocal CoinsChanged = Remotes:WaitForChild(\"CoinsChanged\")\n\nlocal function refresh_hud(coins)\n\ttask.wait()\nend\n\nCoinsChanged.OnClientEvent:Connect(refresh_hud)\n")
mk("LocalScript", "LoadingScreen", svc("ReplicatedFirst"), "wait(1)\nscript.Parent = nil\n")
# Total_Systems blueprint marker (installed blueprints list)
orsys = mk("Folder", "Total_Systems", RS)
cur = mk("Folder", "Currency", orsys)
L.eval("function(f) f:SetAttribute('Total_Blueprint','currency') end")(cur)
mk("ModuleScript", "Config", cur, "return { Currencies = {} }\n")

# ───────────────────────── build-time rejections / no index ─────────────────────────
ok("6 project commands registered", data["commands"] == ["project_index_build", "project_index_summary", "project_index_search", "project_index_script", "project_index_graph", "project_index_changes"], data["commands"])
ok("pack version 1.32.0", data["version"] == "1.32.0")
for k, frag in (("search_noquery", "query is required"), ("search_badkind", "unknown kind"), ("script_nopath", "path is required"), ("graph_badkind", "requires' or 'remotes")):
    ok(k + " rejected at build time", data["programs"][k].startswith("--ERR") and frag in data["programs"][k], data["programs"][k][:200])
for k in ("summary_none", "changes_none"):
    r = run(k)
    ok(k + " fails cleanly without an index", r.get("ok") is False and "project_index_build" in r.get("error", ""), r)
r = run("build_scope_bad")
ok("build with an unknown scope fails", r.get("ok") is False and "scope not found" in r.get("error", ""), r)

# ───────────────────────── dry run ─────────────────────────
r = run("build_dry")
ok("dry run ok, nothing written", r.get("ok") is True and r["data"]["written"] is False and path("ServerStorage.Total_ProjectIndex") is None, r)
d = r["data"]
ok("counts: 14 scripts (9 modules, 2 server, 3 client incl. ReplicatedFirst)", d["counts"]["scripts"] == 14 and d["counts"]["modules"] == 9 and d["counts"]["server"] == 2 and d["counts"]["client"] == 3, d["counts"])
ok("first build: everything 'added', no previous", len(d["added"]) == 14 and d["modified"] == [] and d["removed"] == [] and d.get("previous") is None, (len(d["added"]), d.get("previous")))
ok("map_text present and bounded", isinstance(d["map_text"], str) and d["map_text"].startswith("PROJECT MAP") and len(d["map_text"]) <= 1500, d.get("map_text"))
ok("conventions: tabs, PascalCase functions, camelCase locals (service/require locals ignored), task.wait, game:GetService", d["conventions"]["indent"] == "tabs" and d["conventions"]["function_case"] == "Pascal" and d["conventions"]["variable_case"] == "camel" and d["conventions"]["wait_style"] == "task.wait" and d["conventions"]["service_access"] == "game:GetService", d["conventions"])
ok("strict ratio counted (2 of 14 = 14%)", d["conventions"]["strict_ratio"] == 14, d["conventions"]["strict_ratio"])
ok("legacy wait() calls counted (2)", d["conventions"]["legacy_wait_calls"] == 2, d["conventions"]["legacy_wait_calls"])
ok("style_guide sentence mentions tabs + PascalCase + strict percentage", "indent with tabs" in d["conventions"]["style_guide"] and "PascalCase" in d["conventions"]["style_guide"] and "14%" in d["conventions"]["style_guide"], d["conventions"]["style_guide"])
ok("frameworks: TotalScript blueprints detected via Total_Systems", any(f["name"] == "TotalScript blueprints" for f in d["conventions"]["frameworks"]) or d["blueprints"] == ["currency"], (d["conventions"]["frameworks"], d["blueprints"]))
ok("blueprints installed list = [currency]", d["blueprints"] == ["currency"], d["blueprints"])
hubs = {h["path"]: h["required_by"] for h in d["hubs"]}
ok("hubs: Currency required by 2 (Inventory, ShopServer), Signal by 1, ShopData by 2, deterministic order", d["hubs"][0]["path"] == "ReplicatedStorage.Modules.Currency" and d["hubs"][1]["path"] == "ReplicatedStorage.Modules.Inventory" and hubs.get("ReplicatedStorage.Modules.Currency") == 2 and hubs.get("ReplicatedStorage.Modules.Signal") == 1 and hubs.get("ReplicatedStorage.Modules.ShopData") == 2, hubs)
ok("orphans: LonelyHelper, SecretConfig, UtilB.Util (never required; Total_Systems + Config excluded)", set(d["orphans"]) == {"ReplicatedStorage.Modules.LonelyHelper", "ServerStorage.SecretConfig", "ReplicatedStorage.Modules.UtilB.Util"}, d["orphans"])
ok("require cycle Inventory <-> ShopData found", len(d["cycles"]) == 1 and set(d["cycles"][0]) == {"ReplicatedStorage.Modules.Inventory", "ReplicatedStorage.Modules.ShopData"}, d["cycles"])
mm = {m["remote"]: m["issue"] for m in d["mismatches"]}
ok("mismatch: RequestTeleport handled but never fired", "never fired" in mm.get("RequestTeleport", ""), mm)
ok("mismatch: UnusedRemote unused instance", "unused" in mm.get("UnusedRemote", ""), mm)
ok("mismatch: GhostRemote referenced but no instance", "no RemoteEvent" in mm.get("GhostRemote", ""), mm)
ok("BuyItem / CoinsChanged / GetInventory are NOT mismatches", not any(k in mm for k in ("BuyItem", "CoinsChanged", "GetInventory")), mm)
ok("map text lists Remotes with producer -> consumer and Issues", "Remotes:" in d["map_text"] and "BuyItem" in d["map_text"] and "Issues:" in d["map_text"] and "cycle" in d["map_text"], d["map_text"])
ok("map text shows Layout + Hubs + Blueprints", "Layout:" in d["map_text"] and "Hubs" in d["map_text"] and "Blueprints installed: currency" in d["map_text"], d["map_text"])

# ───────────────────────── real build + storage ─────────────────────────
r = run("build")
ok("build writes ServerStorage.Total_ProjectIndex", r.get("ok") is True and r["data"]["written"] is True and r["data"]["bytes"] > 1000, r.get("data", {}).get("bytes"))
mod = path("ServerStorage.Total_ProjectIndex")
ok("index module is a ModuleScript with Total_Version / BuiltAt / Scripts attributes", mod is not None and mod.ClassName == "ModuleScript" and attr(mod, "Total_Version") == "1.32.0" and attr(mod, "Scripts") == 14 and attr(mod, "BuiltAt"), mod and (attr(mod, "Total_Version"), attr(mod, "Scripts")))
ok("index module source is a loadable Lua module returning the decoded JSON", mod.Source.startswith("-- Total_ProjectIndex") and "return HttpService:JSONDecode([===[" in mod.Source and mod.Source.rstrip().endswith("]===])"), mod.Source[:120])
compiled = L.eval("function(src) local f,e=load(src,'=idx') return f~=nil, e end")(mod.Source)
ok("index module compiles", (compiled[0] if isinstance(compiled, tuple) else compiled) is True, compiled)
stored = json.loads(mod.Source.split("[===[", 1)[1].rsplit("]===]", 1)[0])
ok("stored JSON has scripts / remotes / conventions / layout / hubs / cycles", all(k in stored for k in ("scripts", "remotes", "conventions", "layout", "hubs", "cycles", "mismatches", "counts", "blueprints")), list(stored.keys()))
ok("stored index is not itself indexed (Total_ProjectIndex skipped)", all(e["name"] != "Total_ProjectIndex" for e in stored["scripts"]))
shop = next(e for e in stored["scripts"] if e["path"] == "ServerScriptService.Server.ShopServer")
ok("ShopServer entry: class, lines, hash, functions with lines", shop["class"] == "Script" and shop["lines"] == 31 and len(shop["hash"]) == 14 and any(f["name"] == "handleBuy" and f["line"] == 12 for f in shop["functions"]), {k: shop[k] for k in ("class", "lines", "hash", "functions")})
ok("ShopServer requires resolved (Currency, Inventory, UtilA.Util)", {r_["resolved"] for r_ in shop["requires"]} == {"ReplicatedStorage.Modules.Currency", "ReplicatedStorage.Modules.Inventory", "ReplicatedStorage.Modules.UtilA.Util"}, shop["requires"])
ok("ambiguous Util require resolved to the UtilA one and flagged ambiguous=2", any(r_["name"] == "Util" and r_.get("ambiguous") == 2 for r_ in shop["requires"]), shop["requires"])
ok("ShopServer remotes: BuyItem server_handle, CoinsChanged server_fire, GetInventory server_handle (resolved through locals)", {(x["name"], x["op"]) for x in shop["remotes"]} == {("BuyItem", "server_handle"), ("CoinsChanged", "server_fire"), ("GetInventory", "server_handle")}, shop["remotes"])
ok("ShopServer services + tags + todos", set(shop["services"]) == {"ReplicatedStorage", "Players", "CollectionService"} and shop["tags"] == ["Coin"] and len(shop["todos"]) == 1, (shop["services"], shop["tags"], shop["todos"]))
ok("ShopServer style: tabs, legacy wait 1, get_service 3", shop["style"]["tabs"] > 5 and shop["style"]["wait_old"] == 1 and shop["style"]["get_service"] == 3, shop["style"])
curm = next(e for e in stored["scripts"] if e["path"] == "ReplicatedStorage.Modules.Currency")
ok("Currency entry: strict, datastore PlayerData, exports AddCoins/GetCoins, returns Currency, required_by 2", curm["strict"] is True and curm["datastores"] == ["PlayerData"] and set(curm["exports"]) == {"AddCoins", "GetCoins"} and curm.get("returns") == "Currency" and set(curm["required_by"]) == {"ReplicatedStorage.Modules.Inventory", "ServerScriptService.Server.ShopServer"}, {k: curm.get(k) for k in ("strict", "datastores", "exports", "returns", "required_by")})
tele = next(e for e in stored["scripts"] if e["name"] == "Teleporter")
ok("Teleporter remotes resolved via dotted access (RequestTeleport, GhostRemote)", {(x["name"], x["op"]) for x in tele["remotes"]} == {("RequestTeleport", "server_handle"), ("GhostRemote", "server_handle")}, tele["remotes"])
ui = next(e for e in stored["scripts"] if e["name"] == "ShopUI")
ok("ShopUI remotes: BuyItem client_fire, CoinsChanged client_handle, GetInventory client_fire", {(x["name"], x["op"]) for x in ui["remotes"]} == {("BuyItem", "client_fire"), ("CoinsChanged", "client_handle"), ("GetInventory", "client_fire")}, ui["remotes"])
hud = next(e for e in stored["scripts"] if e["name"] == "HudController")
ok("snake_case function counted in HudController", hud["style"]["fn_case"].get("snake") == 1, hud["style"])
rem = {x["name"]: x for x in stored["remotes"]}
ok("remote matrix: BuyItem fired_by ShopUI, handled_by ShopServer", rem["BuyItem"]["fired_by"] == ["StarterPlayer.StarterPlayerScripts.Client.ShopUI"] and rem["BuyItem"]["handled_by"] == ["ServerScriptService.Server.ShopServer"], rem["BuyItem"])
ok("remote matrix: CoinsChanged handled by ShopUI + HudController", set(rem["CoinsChanged"]["handled_by"]) == {"StarterPlayer.StarterPlayerScripts.Client.ShopUI", "StarterPlayer.StarterPlayerScripts.Client.HudController"} and rem["CoinsChanged"]["fired_by"] == ["ServerScriptService.Server.ShopServer"], rem["CoinsChanged"])
ok("remote matrix: GetInventory is a RemoteFunction with path", rem["GetInventory"]["class"] == "RemoteFunction" and rem["GetInventory"]["path"] == "ReplicatedStorage.Remotes.GetInventory", rem["GetInventory"])
ok("remote matrix: GhostRemote missing_instance", rem["GhostRemote"].get("missing_instance") is True, rem.get("GhostRemote"))
lay = stored["layout"]
ok("layout: ReplicatedStorage children ranked by script count (Modules first)", lay["ReplicatedStorage"][0]["name"] == "Modules" and lay["ReplicatedStorage"][0]["scripts"] == 7, lay["ReplicatedStorage"])
ok("layout: StarterPlayerScripts.Client has 2 scripts", lay["StarterPlayerScripts"][0]["name"] == "Client" and lay["StarterPlayerScripts"][0]["scripts"] == 2, lay.get("StarterPlayerScripts"))

r = run("build_again")
ok("rebuild with no edits: +0 / ~0 / -0 and previous recorded", r.get("ok") is True and r["data"]["added"] == [] and r["data"]["modified"] == [] and r["data"]["removed"] == [] and r["data"]["previous"]["scripts"] == 14, r.get("data", {}).get("previous"))
ok("rebuild text mentions the diff", "+0 / ~0 / -0" in r.get("text", ""), r.get("text"))
r = run("build_scope")
ok("scoped dry build indexes only ServerScriptService (2 scripts)", r.get("ok") is True and r["data"]["counts"]["scripts"] == 2 and r["data"]["written"] is False, r.get("data", {}).get("counts"))
ok("scoped dry build did not disturb the stored index", attr(path("ServerStorage.Total_ProjectIndex"), "Scripts") == 14)

# ───────────────────────── summary ─────────────────────────
r = run("summary")
ok("summary ok, not stale, counts preserved", r.get("ok") is True and r["data"]["stale"]["stale"] is False and r["data"]["counts"]["scripts"] == 14, r.get("data", {}).get("stale"))
ok("summary returns map_text as the text and datastores / tags / todo files / largest scripts", r["text"].startswith("PROJECT MAP") and r["data"]["datastores"] == ["PlayerData"] and r["data"]["tags"] == ["Coin"] and len(r["data"]["todo_files"]) == 2 and r["data"]["largest_scripts"][0]["path"] == "ServerScriptService.Server.ShopServer", {k: r["data"].get(k) for k in ("datastores", "tags", "todo_files")})
ok("summary map text ends with the usage hint", "project_index_search" in r["data"]["map_text"], r["data"]["map_text"][-200:])
r = run("summary_short")
ok("summary max_chars truncates the map", len(r["data"]["map_text"]) <= 300 and r["data"]["map_text"].endswith("..."), len(r["data"]["map_text"]))

# ───────────────────────── search ─────────────────────────
r = run("search_fn")
ok("search AddCoins finds the function (with line) and the export", r.get("ok") is True and any(h["kind"] == "function" and h["path"] == "ReplicatedStorage.Modules.Currency" and h["line"] == 10 for h in r["data"]["hits"]) and any(h["kind"] == "export" for h in r["data"]["hits"]), r.get("data"))
r = run("search_remote")
ok("search kind=remote BuyItem: 2 script uses + the instance row", r["data"]["total"] == 3 and {h["kind"] for h in r["data"]["hits"]} == {"remote", "remote_instance"}, r["data"])
r = run("search_require")
ok("search kind=require Signal -> Currency requires it (resolved)", r["data"]["total"] == 1 and r["data"]["hits"][0]["path"] == "ReplicatedStorage.Modules.Currency" and "-> ReplicatedStorage.Modules.Signal" in r["data"]["hits"][0]["match"], r["data"])
r = run("search_ds")
ok("search kind=datastore PlayerData", r["data"]["total"] == 1 and r["data"]["hits"][0]["kind"] == "datastore", r["data"])
r = run("search_tag")
ok("search kind=tag Coin", r["data"]["total"] == 1 and r["data"]["hits"][0]["path"] == "ServerScriptService.Server.ShopServer", r["data"])
r = run("search_service")
ok("search kind=service DataStoreService -> Currency only", r["data"]["total"] == 1 and r["data"]["hits"][0]["path"] == "ReplicatedStorage.Modules.Currency", r["data"])
r = run("search_path")
ok("search kind=path 'Modules.' -> 7 module paths", r["data"]["total"] == 7 and all(h["kind"] == "path" for h in r["data"]["hits"]), r["data"]["total"])
r = run("search_todo")
ok("search kind=todo lists the 2 scripts with TODO/FIXME", r["data"]["total"] == 2 and {h["path"] for h in r["data"]["hits"]} == {"ReplicatedStorage.Modules.Currency", "ServerScriptService.Server.ShopServer"}, r["data"])
r = run("search_none")
ok("search with no hits", r["data"]["total"] == 0 and r["data"]["hits"] == [] and "0 match" in r["text"], r)
r = run("search_limit")
ok("search limit truncates and reports truncated", len(r["data"]["hits"]) == 3 and r["data"]["truncated"] is True and r["data"]["total"] > 3 and "showing 3" in r["text"], r["data"]["total"])

# ───────────────────────── per-script ─────────────────────────
r = run("script_full")
ok("script by full path: not stale, exists, partners resolved", r.get("ok") is True and r["data"]["stale"] is False and r["data"]["exists"] is True and r["data"]["hash"] == r["data"]["current_hash"], r)
partners = {(p["remote"], p["op"]): p["other_side"] for p in r["data"]["remote_partners"]}
ok("ShopServer remote partners: BuyItem handled here, fired by ShopUI", partners.get(("BuyItem", "server_handle")) == ["StarterPlayer.StarterPlayerScripts.Client.ShopUI"], partners)
ok("ShopServer CoinsChanged fired here -> handled by both clients", set(partners.get(("CoinsChanged", "server_fire"), [])) == {"StarterPlayer.StarterPlayerScripts.Client.ShopUI", "StarterPlayer.StarterPlayerScripts.Client.HudController"}, partners)
ok("script text summarises lines / functions / requires / required_by", "31 lines" in r["text"] and "2 function(s)" in r["text"] and "3 require(s)" in r["text"], r["text"])
r = run("script_suffix")
ok("script by suffix Modules.Currency", r.get("ok") is True and r["data"]["path"] == "ReplicatedStorage.Modules.Currency" and len(r["data"]["required_by"]) == 2, r)
r = run("script_name")
ok("script by unique name Signal", r.get("ok") is True and r["data"]["path"] == "ReplicatedStorage.Modules.Signal" and r["data"]["strict"] is True, r)
r = run("script_ambiguous")
ok("ambiguous name Util is rejected with both candidates", r.get("ok") is False and "ambiguous" in r["error"] and "UtilA.Util" in r["error"] and "UtilB.Util" in r["error"], r)
r = run("script_missing")
ok("unknown script path fails cleanly", r.get("ok") is False and "not in the index" in r["error"], r)

# ───────────────────────── graph ─────────────────────────
r = run("graph_req")
ok("requires graph: edges, nodes ranked, cycles, orphans, unresolved", r.get("ok") is True and len(r["data"]["edges"]) == 8 and r["data"]["nodes"][0]["path"] == "ReplicatedStorage.Modules.Currency" and r["data"]["nodes"][0]["required_by"] == 2 and r["data"]["nodes"][2]["path"] == "ReplicatedStorage.Modules.ShopData" and len(r["data"]["cycles"]) == 1 and len(r["data"]["orphans"]) == 3 and r["data"]["unresolved"] == [], {k: r["data"].get(k) for k in ("edges", "unresolved")})
ok("graph text", "cycle(s)" in r["text"] and "orphan" in r["text"], r["text"])
r = run("graph_root")
ok("graph root=ShopServer depth 1: its 3 requires only", r.get("ok") is True and r["data"]["root"] == "ShopServer" and {e["to"] for e in r["data"]["edges"]} == {"ReplicatedStorage.Modules.Currency", "ReplicatedStorage.Modules.Inventory", "ReplicatedStorage.Modules.UtilA.Util"} and all(e["from"] == "ServerScriptService.Server.ShopServer" for e in r["data"]["edges"]), r["data"]["edges"])
r = run("graph_remotes")
ok("remotes graph: 6 rows (5 instances + ghost), mismatches 3, no wrong-side handlers", r.get("ok") is True and len(r["data"]["remotes"]) == 6 and len(r["data"]["mismatches"]) == 3 and r["data"]["wrong_side"] == [], (len(r["data"]["remotes"]), len(r["data"]["mismatches"]), r["data"]["wrong_side"]))
r = run("graph_remotes_filter")
ok("remotes graph filter 'buy' -> BuyItem only", len(r["data"]["remotes"]) == 1 and r["data"]["remotes"][0]["name"] == "BuyItem", r["data"]["remotes"])

# ───────────────────────── changes + stale ─────────────────────────
r = run("changes")
ok("changes with nothing edited: not stale", r.get("ok") is True and r["data"]["stale"] is False and "no changes" in r["text"], r)
shop_inst = path("ServerScriptService.Server.ShopServer")
shop_inst.Source = shop_inst.Source + "\nlocal function newHelper()\nend\n"
mk("Script", "Brand", server, "print('new')\n")
path("ReplicatedStorage.Modules.LonelyHelper").Destroy(path("ReplicatedStorage.Modules.LonelyHelper"))
r = run("changes")
ok("changes after edits: +Brand, ~ShopServer, -LonelyHelper", r.get("ok") is True and r["data"]["stale"] is True and r["data"]["added"] == ["ServerScriptService.Server.Brand"] and r["data"]["modified"] == ["ServerScriptService.Server.ShopServer"] and r["data"]["removed"] == ["ReplicatedStorage.Modules.LonelyHelper"], r.get("data"))
det = r["data"]["details"][0]
ok("modified detail: +3 lines, new function newHelper", det["delta_lines"] == 3 and det["new_functions"] == ["newHelper"] and det["removed_functions"] == [], det)
ok("changes text", "+1 added, ~1 modified, -1 removed" in r["text"], r["text"])
r = run("script_full")
ok("script lookup reports stale after the edit", r.get("ok") is True and r["data"]["stale"] is True and "STALE" in r["text"], r.get("text"))
r = run("summary")
ok("summary flags stale (1 new / 1 changed / 1 removed) and appends the warning", r["data"]["stale"] == {"added": 1, "changed_size": 1, "removed": 1, "stale": True} and "STALE" in r["data"]["map_text"], r["data"].get("stale"))
r = run("build")
ok("rebuild after edits reports the diff and refreshes", r.get("ok") is True and r["data"]["added"] == ["ServerScriptService.Server.Brand"] and r["data"]["modified"] == ["ServerScriptService.Server.ShopServer"] and r["data"]["removed"] == ["ReplicatedStorage.Modules.LonelyHelper"] and attr(path("ServerStorage.Total_ProjectIndex"), "Scripts") == 14, r.get("data", {}).get("counts"))
r = run("summary")
ok("summary current again", r["data"]["stale"]["stale"] is False)

print("\n%d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
