#!/usr/bin/env python3
"""Featured Public Skills (2.4.0) against the miniature Roblox DataModel.

tests/test-public-packs.js checks the pack statically (validation, registration, UI,
command). This script does what a user would: installs the pack into PublicSkills in
node, builds the real Luau for every skill with realistic arguments, runs each
installer in the mocked DataModel (tests/roblox_sim.py), checks what got installed,
COMPILES every embedded Script / LocalScript / ModuleScript, and then RUNS the ones
that can run without a frame loop: the door controller (locked -> denied, key ->
opens -> RequestOpen closes), the dialogue server (valid action accepted, bogus action
ignored) and client (panel, typewriter, branching), the zone server (one tick: enter,
damage, leave), the collectible server (spawn, touch -> stat, respawn queued) and
client (spin), the boss bar (bind, drain, death), damage numbers (server fire, client
popup) and the NPC brain (compiles; dead humanoid -> State 'dead').

Everything here is a MOCK of Roblox; a real Studio run is still the final word.

    pip install lupa && python3 tests/public-pack-sim.py          (from the TotalScript root)
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
global.navigator={userAgent:"node"}; global.location={hostname:"chatgpt.com",href:"https://chatgpt.com/"};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/main.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
for(const f of ["src/core/skill_intel.js","src/core/skill_refs.js","src/core/public_skills.js","src/core/public_packs.js"]) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills, PS=window.PublicSkills, PP=window.TotalPublicPacks;
const reserved=new Set(S.SKILL_COMMANDS.map(c=>c.name).concat(PS.managementTools().map(t=>t.name)));
const inst=PP.install(PS, PP.PACK_ID, {reserved});
const want=JSON.parse(process.argv[1]);
const out={installed:inst.installed.map(i=>i.name), errors:inst.errors, warnings:inst.warnings, programs:{}};
for(const [key,[name,args]] of Object.entries(want)){ const r=PS.buildLuau(name,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

WANT = {
    "damage": ["damage_numbers_pro", {"crit_threshold": 25, "font": "FredokaOne"}],
    "npc": ["npc_patrol_chase", {"npc": "Workspace.Guard", "waypoints": "Workspace.GuardPath", "damage": 10}],
    "npc_missing": ["npc_patrol_chase", {"npc": "Workspace.Nope"}],
    "door": ["keycard_door_system", {"door": "Workspace.LabDoor", "motion": "slide", "key": "Keycard", "auto_close": 3}],
    "gate": ["keycard_door_system", {"door": "Workspace.Gate", "motion": "swing"}],
    "dialogue": ["dialogue_tree_system", {"npc": "Workspace.Merchant"}],
    "dialogue_bad": ["dialogue_tree_system", {"npc": "Workspace.Merchant", "tree": {"start": "x", "nodes": {}}}],
    "coins": ["collectible_spawner", {"name": "Coin", "count": 6, "area": "Workspace.CoinZone", "respawn": 15}],
    "zone": ["zone_system", {"zone": "Workspace.Lava", "kind": "damage", "amount": 20, "message": "Lava!"}],
    "zone_safe": ["zone_system", {"zone": "Workspace.Lobby", "kind": "safe", "message": "Safe zone"}],
    "boss": ["boss_health_bar", {"boss": "Workspace.Dragon", "title": "Ancient Dragon", "phases": 3}],
    "boss_bad": ["boss_health_bar", {"boss": "Workspace.LabDoor"}],
    "cp": ["checkpoint_system", {"checkpoints": "Workspace.Checkpoints", "stat_name": "Stage", "celebrate": True}],
    "cp_bad": ["checkpoint_system", {"checkpoints": "Workspace.Nope"}],
    "gui": ["gui_polish_kit", {"screen": "StarterGui.HUD", "style": "cartoon", "accent": "#FF8800"}],
    "gui_bad": ["gui_polish_kit", {"screen": "Workspace.Lava"}],
    "feel": ["game_feel_kit", {"intensity": "heavy", "demo": True}],
    "audit": ["place_audit_report", {"fix_deprecated": True}],
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
        print("FAIL  " + name + ("  -- " + str(detail)[:700] if detail != "" else ""))

ok("pack installs 11 items with no errors and no warnings", len(data["installed"]) == 11 and not data["errors"] and not data["warnings"], (data["errors"], data["warnings"]))

L, M, run = make_runtime()
L.globals()["M"] = M  # the Lua snippets below reach the sim's hooks (fakePlayer, fired, delayed, runScript) through M
lua = L.execute

# ── scene ───────────────────────────────────────────────────────────────────
lua(r"""
local function part(name, parent, pos, size)
  local p = Instance.new("Part") p.Name = name p.Size = size or Vector3.new(4, 1, 4) p.CFrame = CFrame.new(pos or Vector3.new()) p.Anchored = true p.Parent = parent or workspace return p
end
local function rig(name, pos, health)
  local m = Instance.new("Model") m.Name = name
  local root = part("HumanoidRootPart", m, pos, Vector3.new(2, 2, 1))
  local head = part("Head", m, pos + Vector3.new(0, 1.5, 0), Vector3.new(2, 1, 1))
  local hum = Instance.new("Humanoid") hum.MaxHealth = health or 100 hum.Health = health or 100 hum.WalkSpeed = 16 hum.JumpPower = 50 hum.JumpHeight = 7.2 hum.UseJumpPower = true hum.Parent = m
  m.PrimaryPart = root
  m.Parent = workspace
  return m, hum, root
end
_G.Guard = rig("Guard", Vector3.new(20, 3, 0), 100)
local path = Instance.new("Folder") path.Name = "GuardPath" path.Parent = workspace
for i = 1, 3 do part("WP" .. i, path, Vector3.new(20 + i * 5, 1, 0)) end
_G.LabDoor = part("LabDoor", workspace, Vector3.new(0, 4, 10), Vector3.new(6, 8, 1))
local gate = Instance.new("Model") gate.Name = "Gate" gate.Parent = workspace
part("Left", gate, Vector3.new(-2, 4, 30), Vector3.new(4, 8, 1)) part("Right", gate, Vector3.new(2, 4, 30), Vector3.new(4, 8, 1))
_G.Merchant = rig("Merchant", Vector3.new(0, 3, -10), 100)
_G.CoinZone = part("CoinZone", workspace, Vector3.new(50, 1, 50), Vector3.new(40, 1, 40))
_G.Lava = part("Lava", workspace, Vector3.new(-50, 2, 0), Vector3.new(20, 4, 20))
local lobby = Instance.new("Folder") lobby.Name = "Lobby" lobby.Parent = workspace
part("SafeA", lobby, Vector3.new(100, 2, 0), Vector3.new(10, 4, 10)) part("SafeB", lobby, Vector3.new(110, 2, 0), Vector3.new(10, 4, 10))
_G.Dragon = rig("Dragon", Vector3.new(0, 3, 60), 2000)
local sp = Instance.new("SpawnLocation") sp.Name = "SpawnLocation" sp.Parent = workspace
-- the fake player gets a character + backpack
local player = M.fakePlayer
local ch, chum, croot = rig("Tester", Vector3.new(0, 3, 0), 100)
player.Character = ch
local bp = Instance.new("Backpack") bp.Name = "Backpack" bp.Parent = player
M.players = { player }
_G.Char = ch _G.CharHum = chum _G.CharRoot = croot
-- 2.2.3: checkpoints (named out of order on purpose), a HUD to polish, and audit bait
local cps = Instance.new("Folder") cps.Name = "Checkpoints" cps.Parent = workspace
_G.CP3 = part("Checkpoint3", cps, Vector3.new(30, 1, -40)) _G.CP1 = part("Checkpoint1", cps, Vector3.new(10, 1, -40)) _G.CP2 = part("Checkpoint2", cps, Vector3.new(20, 1, -40))
local hud = Instance.new("ScreenGui") hud.Name = "HUD" hud.Parent = game.StarterGui
local panel = Instance.new("Frame") panel.Name = "Panel" panel.Size = UDim2.new(0, 300, 0, 200) panel.Parent = hud
local play = Instance.new("TextButton") play.Name = "Play" play.Text = "Play" play.Size = UDim2.new(0, 120, 0, 40) play.Parent = panel
local title = Instance.new("TextLabel") title.Name = "Title" title.Text = "Hello" title.Size = UDim2.new(0, 200, 0, 30) title.Parent = panel
_G.HUD = hud _G.PlayBtn = play
local loose = part("Loose", workspace, Vector3.new(0, 5, -80)) loose.Anchored = false
part("Far", workspace, Vector3.new(9000, 1, 0))
local empty = Instance.new("Folder") empty.Name = "Empty" empty.Parent = workspace
local old = Instance.new("Script") old.Name = "Old" old.Source = "wait(1)\nspawn(function() print(1) end)\nlocal bv = Instance.new('BodyVelocity')\nworkspace.Part:Remove()\n" old.Parent = game.ServerScriptService
local bad = Instance.new("LocalScript") bad.Name = "Bad" bad.Source = "local ds = game:GetService('DataStoreService')" bad.Parent = game.StarterGui
""")

def runp(key):
    return run(key, programs[key])

def compile_sources(container_names=None):
    """Compile every LuaSourceContainer in the DataModel; returns (count, failures)."""
    res = lua(r"""
    local n, bad = 0, {}
    for _, d in ipairs(game:GetDescendants()) do
      if d:IsA("LuaSourceContainer") and d.Source and d.Source ~= "" then
        n = n + 1
        local f, err = load(d.Source, "=" .. d:GetFullName())
        if not f then bad[#bad + 1] = d:GetFullName() .. ": " .. tostring(err) end
      end
    end
    return n, table.concat(bad, " | ")
    """)
    return res

# ── 1. damage numbers ────────────────────────────────────────────────────────
r = runp("damage")
ok("damage_numbers_pro installs folder + remote + server + client", r.get("ok") and len(r.get("installed", [])) == 3 and r.get("crit_threshold") == 25, r)
ok("  settings as attributes on ReplicatedStorage.DamageNumbers", lua('local f = game.ReplicatedStorage.DamageNumbers return f:GetAttribute("Font") == "FredokaOne" and f:GetAttribute("ShowHeal") == true and f:FindFirstChild("Show").ClassName == "RemoteEvent"'))
lua(r"""M.runScript(game.ServerScriptService.DamageNumbersServer)""")
before = len(list(M.fired.values()))
lua(r"""local hum = _G.Dragon:FindFirstChildOfClass("Humanoid") hum.Health = 1970 hum.HealthChanged:Fire(1970)""")
fired = lua("local f = M.fired[#M.fired] return f and f[1], f and f[2], f and f[4]")
ok("  server: Humanoid.HealthChanged -30 -> Show:FireAllClients(position, delta, name)", fired[0] == "Show" and fired[1] == "all" and fired[2] == -30, fired)
lua(r"""M.runScript(game.StarterPlayer.StarterPlayerScripts.DamageNumbersClient, true)""")
lua(r"""game.ReplicatedStorage.DamageNumbers.Show.OnClientEvent:Fire(Vector3.new(0, 5, 60), -30, "Dragon")
game.ReplicatedStorage.DamageNumbers.Show.OnClientEvent:Fire(Vector3.new(0, 5, 60), 12, "Dragon")""")
pop = lua(r"""local holder = workspace.CurrentCamera:FindFirstChild("DamageNumbers") if not holder then return "no holder" end
local labels = {} for _, d in ipairs(holder:GetDescendants()) do if d:IsA("TextLabel") then labels[#labels+1] = d.Text .. "|" .. d.Font.Name end end return table.concat(labels, ",")""")
ok("  client: -30 pops as a CRIT ('-30!'), +12 as a heal, in the chosen font, inside a camera-only folder", pop == "-30!|FredokaOne,+12|FredokaOne", pop)

# ── 2. NPC brain ─────────────────────────────────────────────────────────────
r = runp("npc")
ok("npc_patrol_chase writes the brain + attributes, keeps the waypoint folder path", r.get("ok") and r.get("brain") == "Workspace.Guard.NPCBrain" and r.get("waypoints") == "Workspace.GuardPath" and lua('return _G.Guard:GetAttribute("DetectRange") == 30 and _G.Guard:GetAttribute("Damage") == 10 and _G.Guard.PrimaryPart.Name == "HumanoidRootPart"'), r)
r = runp("npc_missing")
ok("  missing NPC -> honest error, nothing written", not r.get("ok") and "not found" in r.get("error", ""), r)
lua(r"""local hum = _G.Guard:FindFirstChildOfClass("Humanoid") hum.Health = 0 M.runScript(_G.Guard.NPCBrain)""")
ok("  brain compiles and runs; a dead NPC parks with State 'dead' instead of looping", lua('return _G.Guard:GetAttribute("State")') == "dead")

# ── 3. doors ─────────────────────────────────────────────────────────────────
r = runp("door")
ok("keycard_door_system on a Part: prompt + controller + attributes (slide along x by its own width)", r.get("ok") and r.get("axis") == "x" and r.get("distance") == 6 and "Keycard" in r.get("key", "") and lua('return _G.LabDoor:FindFirstChild("DoorPrompt") ~= nil and _G.LabDoor:FindFirstChild("DoorController") ~= nil and _G.LabDoor:GetAttribute("Open") == false'), r)
r2 = runp("gate")
ok("  on a Model: largest part becomes PrimaryPart, every part anchored, swing motion", r2.get("ok") and r2.get("motion") == "swing" and r2.get("parts") == 2 and lua('return workspace.Gate.PrimaryPart ~= nil and workspace.Gate.Left.Anchored == true'), r2)
lua(r"""M.runScript(_G.LabDoor.DoorController)""")
x0 = lua("return _G.LabDoor.CFrame.Position.X")
lua(r"""_G.LabDoor.DoorPrompt.Triggered:Fire(M.fakePlayer)""")
denied = lua('return _G.LabDoor:GetAttribute("LastDenied"), _G.LabDoor:GetAttribute("Open"), _G.LabDoor.DoorPrompt.ActionText')
ok("  no keycard -> denied: LastDenied = player, stays closed, prompt shows the locked text", denied[0] == 1 and denied[1] == False and denied[2] == "Locked - keycard required", denied)
lua(r"""local t = Instance.new("Tool") t.Name = "Keycard" t.Parent = M.fakePlayer.Backpack _G.LabDoor.DoorPrompt.Triggered:Fire(M.fakePlayer)""")
opened = lua('return _G.LabDoor:GetAttribute("Open"), _G.LabDoor.CFrame.Position.X, _G.LabDoor.DoorPrompt.ActionText, #M.delayed')
ok("  with the Keycard tool in the backpack -> opens: Open=true, slid 6 studs on x, prompt says Close, auto-close scheduled", opened[0] == True and abs(opened[1] - (x0 + 6)) < 0.01 and opened[2] == "Close" and opened[3] >= 1, (x0, opened))
lua(r"""_G.LabDoor:SetAttribute("RequestOpen", false)""")
closed = lua('return _G.LabDoor:GetAttribute("Open"), _G.LabDoor.CFrame.Position.X')
ok("  scripting API: RequestOpen=false closes it back to the original CFrame", closed[0] == False and abs(closed[1] - x0) < 0.01, closed)

# ── 4. dialogue ──────────────────────────────────────────────────────────────
r = runp("dialogue_bad")
ok("dialogue_tree_system rejects a tree whose start node is missing", not r.get("ok") and "nodes[start]" in r.get("error", ""), r)
r = runp("dialogue")
ok("  demo tree installs: module + prompt + server + client, 5 nodes, no warnings", r.get("ok") and r.get("nodes") == 5 and r.get("tree") == "ReplicatedStorage.Dialogue.Trees.Merchant" and r.get("warnings") == [] and lua('return _G.Merchant.HumanoidRootPart:FindFirstChild("DialoguePrompt"):GetAttribute("DialogueTree") == "Merchant"'), r)
tree_ok = lua(r"""local t = require(game.ReplicatedStorage.Dialogue.Trees.Merchant) return type(t) == "table" and t.start == "greet" and #t.nodes.greet.choices == 3 and t.nodes.bridge.choices[1].action == "accept_quest_planks" """)
ok("  the tree ModuleScript requires back into the same table (JSON round-trip)", tree_ok)
lua(r"""M.runScript(game.ServerScriptService.DialogueServer)
_G.actions = {}
game.ServerScriptService.DialogueServer.OnAction.Event:Connect(function(p, tree, node, action) _G.actions[#_G.actions+1] = tree .. ":" .. node .. ":" .. action end)
game.ReplicatedStorage.Dialogue.Action.OnServerEvent:Fire(M.fakePlayer, "Merchant", "bridge", "accept_quest_planks")""")
acted = lua('return _G.actions[1], M.fakePlayer:GetAttribute("LastDialogueAction")')
ok("  server: a real choice action reaches OnAction + LastDialogueAction (player 10 studs from the NPC)", acted[0] == "Merchant:bridge:accept_quest_planks" and acted[1] == "Merchant:bridge:accept_quest_planks", acted)
lua(r"""game.ReplicatedStorage.Dialogue.Action.OnServerEvent:Fire(M.fakePlayer, "Merchant", "bridge", "give_me_everything")
game.ReplicatedStorage.Dialogue.Action.OnServerEvent:Fire(M.fakePlayer, "Merchant", "greet", "accept_quest_planks")""")
ok("  server: an action the node does not offer (or the wrong node) is ignored", lua("return #_G.actions") == 1)
lua(r"""M.runScript(game.StarterPlayer.StarterPlayerScripts.DialogueClient, true)
game.ProximityPromptService.PromptTriggered:Fire(_G.Merchant.HumanoidRootPart.DialoguePrompt, M.fakePlayer)""")
ui = lua(r"""local gui = M.playerGui:FindFirstChild("DialogueUI") if not gui then return "no gui" end
local panel = gui.Panel local buttons = {} for _, c in ipairs(panel:GetDescendants()) do if c:IsA("TextButton") then buttons[#buttons+1] = c end end
local body for _, c in ipairs(panel:GetChildren()) do if c:IsA("TextLabel") and c.RichText then body = c end end
local name for _, c in ipairs(panel:GetChildren()) do if c:IsA("TextLabel") and c.TextSize == 17 then name = c end end
return gui.Enabled, name and name.Text, #buttons, body and body.Text""")
ok("  client: E on the prompt opens the panel - speaker 'Merchant', 3 choice buttons, typewriter started", ui[0] == True and ui[1] == "Merchant" and ui[2] == 3 and isinstance(ui[3], str) and len(ui[3]) >= 1 and len(ui[3]) < 20, ui)
lua(r"""local gui = M.playerGui.DialogueUI local first for _, c in ipairs(gui.Panel:GetDescendants()) do if c:IsA("TextButton") and not first then first = c end end
first.Activated:Fire() _G.firstBtn = first""")
full = lua(r"""for _, c in ipairs(M.playerGui.DialogueUI.Panel:GetChildren()) do if c:IsA("TextLabel") and c.RichText then return c.Text end end""")
ok("  client: clicking while typing completes the text instead of choosing", full.startswith("Oh, a traveller!"), full)
lua(r"""_G.firstBtn.Activated:Fire()""")
branch = lua(r"""local n = 0 for _, c in ipairs(M.playerGui.DialogueUI.Panel:GetDescendants()) do if c:IsA("TextButton") then n = n + 1 end end return n""")
ok("  client: choosing 'What happened to the bridge?' branches to a node with 2 choices", branch == 2, branch)

# ── 5. collectibles ──────────────────────────────────────────────────────────
r = runp("coins")
ok("collectible_spawner installs template (coin cylinder, sparkle, empty SoundId), folder attributes, server + client", r.get("ok") and r.get("stat") == "Coins" and r.get("count") == 6 and lua('local t = game.ServerStorage.Collectibles.CoinTemplate return t.Shape == Enum.PartType.Cylinder and t.Sparkle.ClassName == "ParticleEmitter" and t.Pickup.SoundId == "" and workspace.Collectibles:GetAttribute("AreaPath") == "Workspace.CoinZone"'), r)
lua(r"""M.runScript(game.ServerScriptService.CollectibleServer)""")
spawned = lua(r"""local n, tagged, inside = 0, 0, 0 for _, c in ipairs(workspace.Collectibles:GetChildren()) do n = n + 1 if c:HasTag("Collectible") then tagged = tagged + 1 end local p = c.Position if math.abs(p.X - 50) <= 20 and math.abs(p.Z - 50) <= 20 then inside = inside + 1 end end return n, tagged, inside""")
ok("  server: 6 tagged pieces spawned inside the CoinZone footprint; leaderstat Coins exists", spawned[0] == 6 and spawned[1] == 6 and spawned[2] == 6 and lua('return M.fakePlayer.leaderstats:FindFirstChild("Coins") ~= nil'), spawned)
coins0 = lua("return M.fakePlayer.leaderstats.Coins.Value")
lua(r"""local piece = workspace.Collectibles:GetChildren()[1] _G.piece = piece piece.Touched:Fire(_G.CharRoot) piece.Touched:Fire(_G.CharRoot)""")
after = lua('return M.fakePlayer.leaderstats.Coins.Value, _G.piece:GetAttribute("Taken"), _G.piece.CanTouch, #M.delayed')
ok("  touch -> +1 Coin exactly once (second touch ignored), Taken=true, destroy + respawn scheduled", after[0] == coins0 + 1 and after[1] == True and after[2] == False and after[3] >= 3, (coins0, after))
lua(r"""M.runScript(game.StarterPlayer.StarterPlayerScripts.CollectibleClient, true)""")
spin = lua(r"""local p = workspace.Collectibles:GetChildren()[2] local before = p.CFrame game.RunService.Heartbeat:Fire(0.5) local after = p.CFrame return (after.Position - before.Position).Magnitude > 0.01 or (after.LookVector - before.LookVector).Magnitude > 0.01""")
ok("  client: one Heartbeat spins / bobs a piece (client-side CFrame only)", spin == True)

# ── 6. zones ─────────────────────────────────────────────────────────────────
r = runp("zone")
ok("zone_system tags the lava part with kind/amount/message and installs the shared scripts", r.get("ok") and r.get("parts") == 1 and r.get("amount") == 20 and lua('return _G.Lava:HasTag("Zone") and _G.Lava:GetAttribute("ZoneKind") == "damage" and game.ServerScriptService.ZoneServer:GetAttribute("Tick") == 0.5'), r)
r2 = runp("zone_safe")
ok("  a Folder of parts -> every part becomes a safe zone; earlier lava tags survive", r2.get("ok") and r2.get("parts") == 2 and r2.get("amount") == 0 and lua('return workspace.Lobby.SafeA:GetAttribute("ZoneKind") == "safe" and _G.Lava:GetAttribute("ZoneKind") == "damage"'), r2)
lua(r"""
_G.zoneCo = coroutine.create(function() M.runScript(game.ServerScriptService.ZoneServer) end)
coroutine.resume(_G.zoneCo) -- parks at the first task.wait(TICK)
_G.Char:PivotTo(CFrame.new(-50, 3, 0)) -- step into the lava
coroutine.resume(_G.zoneCo)
""")
tick1 = lua('return _G.CharHum.Health, M.fakePlayer:GetAttribute("Zone"), M.fired[#M.fired][1], M.fired[#M.fired][3]')
ok("  server tick: character inside Lava -> enter (Zone attr, banner message) + 20/s * 0.5 s = 10 damage", abs(tick1[0] - 90) < 0.01 and tick1[1] == "Lava" and tick1[2] == "Message" and tick1[3] == "Lava!", tick1)
lua(r"""coroutine.resume(_G.zoneCo)""")
ok("  second tick: another 10 damage, still inside", abs(lua("return _G.CharHum.Health") - 80) < 0.01)
lua(r"""_G.Char:PivotTo(CFrame.new(100, 3, 0)) coroutine.resume(_G.zoneCo)""")
tick3 = lua('return _G.CharHum.Health, M.fakePlayer:GetAttribute("Zone"), M.fakePlayer:GetAttribute("InSafeZone"), _G.Char:FindFirstChild("ZoneSafe") ~= nil')
ok("  moving into the safe zone: leaves Lava (no more damage), InSafeZone=true, invisible ForceField added", abs(tick3[0] - 80) < 0.01 and tick3[1] == "SafeA" and tick3[2] == True and tick3[3] == True, tick3)
lua(r"""_G.Char:PivotTo(CFrame.new(0, 3, 0)) coroutine.resume(_G.zoneCo)""")
ok("  leaving the safe zone removes the ForceField and the attributes", lua('return M.fakePlayer:GetAttribute("InSafeZone") == nil and M.fakePlayer:GetAttribute("Zone") == nil and _G.Char:FindFirstChild("ZoneSafe") == nil'))
lua(r"""M.runScript(game.StarterPlayer.StarterPlayerScripts.ZoneClient, true) game.ReplicatedStorage.Zones.Message.OnClientEvent:Fire("Lava!", "damage", true)""")
banner = lua('local g = M.playerGui:FindFirstChild("ZoneBanner") local b = g and g:FindFirstChildWhichIsA("TextLabel") return b and b.Visible, b and b.Text, b and b.Position.Y.Offset')
ok("  client: the banner slides in with the message", banner[0] == True and banner[1] == "Lava!" and banner[2] == 24, banner)

# ── 7. boss bar ──────────────────────────────────────────────────────────────
r = runp("boss_bad")
ok("boss_health_bar refuses a non-Model target", not r.get("ok") and "Model" in r.get("error", ""), r)
r = runp("boss")
ok("  tags the Dragon with BossBar + attributes, installs the shared client", r.get("ok") and r.get("phases") == 3 and r.get("health") == 2000 and lua('return _G.Dragon:HasTag("BossBar") and _G.Dragon:GetAttribute("BossTitle") == "Ancient Dragon"'), r)
lua(r"""local hum = _G.Dragon:FindFirstChildOfClass("Humanoid") hum.Health = 2000 M.runScript(game.StarterPlayer.StarterPlayerScripts.BossBarClient, true)""")
bar = lua(r"""local g = M.playerGui:FindFirstChild("BossBar") if not g then return "no gui" end
local title for _, d in ipairs(g:GetDescendants()) do if d:IsA("TextLabel") and d.TextSize == 20 then title = d end end
local ticks = 0 local fill for _, d in ipairs(g:GetDescendants()) do if d:IsA("Frame") and d.Size.X.Offset == 2 then ticks = ticks + 1 end if d:IsA("Frame") and d.ZIndex == 2 then fill = d end end
_G.fill = fill
return g.Enabled, title and title.Text, ticks, fill and fill.Size.X.Scale""")
ok("  client binds the nearest tagged boss: shown, 'ANCIENT DRAGON', 2 phase ticks, full bar", bar[0] == True and bar[1] == "ANCIENT DRAGON" and bar[2] == 2 and bar[3] == 1, bar)
lua(r"""local hum = _G.Dragon:FindFirstChildOfClass("Humanoid") hum.Health = 1000 hum.HealthChanged:Fire(1000)""")
drained = lua(r"""local hp for _, d in ipairs(M.playerGui.BossBar:GetDescendants()) do if d:IsA("TextLabel") and d.TextSize == 12 then hp = d end end return _G.fill.Size.X.Scale, hp and hp.Text""")
ok("  half health -> fill 0.5, '1000 / 2000' (tweened; ghost lags behind)", abs(drained[0] - 0.5) < 0.001 and drained[1] == "1000 / 2000", drained)
lua(r"""local hum = _G.Dragon:FindFirstChildOfClass("Humanoid") hum.Health = 0 hum.HealthChanged:Fire(0)""")
ok("  death -> hide scheduled (task.delay queued), fill at 0", lua("return _G.fill.Size.X.Scale") == 0 and lua("return #M.delayed") >= 4)

# ── 8. checkpoints ────────────────────────────────────────────────────────────
r = runp("cp_bad")
ok("checkpoint_system: missing holder -> honest error", not r.get("ok") and "not found" in r.get("error", ""), r)
r = runp("cp")
ok("  3 parts ordered by the number in their name (Checkpoint1 first, 3 last), tags + Stage attributes, server inside the folder, client shared", r.get("ok") and r.get("stages") == 3 and r.get("order") == "name" and r.get("first") == "Checkpoint1" and r.get("last") == "Checkpoint3" and lua('return _G.CP1:GetAttribute("Stage") == 1 and _G.CP3:GetAttribute("Stage") == 3 and _G.CP2:HasTag("Checkpoint") and workspace.Checkpoints:HasTag("CheckpointSet") and workspace.Checkpoints:FindFirstChild("CheckpointServer") ~= nil and game.StarterPlayer.StarterPlayerScripts:FindFirstChild("CheckpointClient") ~= nil'), r)
lua(r"""M.runScript(workspace.Checkpoints.CheckpointServer)""")
ok("  server: leaderstat Stage = 0 created for the present player", lua('return M.fakePlayer.leaderstats.Stage.Value') == 0)
lua(r"""_G.CP1.Touched:Fire(_G.CharRoot)""")
touched = lua(r"""local f = M.fired[#M.fired] return M.fakePlayer.leaderstats.Stage.Value, f and f[1], f and f[3], f and f[4], M.fakePlayer:GetAttribute("Checkpoint")""")
ok("  touching checkpoint 1 -> Stage 1, CheckpointReached:FireClient(1, 3), attribute Checkpoint = 1", touched[0] == 1 and touched[1] == "CheckpointReached" and touched[2] == 1 and touched[3] == 3 and touched[4] == 1, touched)
lua(r"""_G.CP3.Touched:Fire(_G.CharRoot)""")
ok("  a second touch inside the 0.25 s debounce window is ignored (still 1)", lua('return M.fakePlayer.leaderstats.Stage.Value') == 1)
SPIN = 'local t = os.clock() while os.clock() - t < 0.3 do end'  # plain Lua os.clock is CPU time, so burn it instead of sleeping
lua(SPIN + ' _G.CP3.Touched:Fire(_G.CharRoot)')
lua(SPIN + ' _G.CP2.Touched:Fire(_G.CharRoot)')
ok("  progress only moves forward: 3 after checkpoint 3, still 3 after walking back onto 2", lua('return M.fakePlayer.leaderstats.Stage.Value') == 3)
lua(r"""workspace.Checkpoints.SetStage:Fire(M.fakePlayer, 2)""")
placed = lua(r"""return M.fakePlayer.leaderstats.Stage.Value, (_G.Char:GetPivot().Position - _G.CP2.Position).Magnitude""")
ok("  SetStage bindable: stage 2 and the character is pivoted on top of checkpoint 2 (offset 4 + half height)", placed[0] == 2 and abs(placed[1] - 4.5) < 0.01, placed)
lua(r"""M.runScript(game.StarterPlayer.StarterPlayerScripts.CheckpointClient, true)""")
lua(r"""workspace.Checkpoints.CheckpointReached.OnClientEvent:Fire(2, 3)""")
painted = lua(r"""local g = M.playerGui:FindFirstChild("CheckpointBanner") local b = g and g:FindFirstChild("Banner")
return b and b.Text, b and b.Visible, _G.CP1.Color == workspace.Checkpoints:GetAttribute("DoneColor"), _G.CP3.Color == workspace.Checkpoints:GetAttribute("NextColor"), _G.CP2:FindFirstChild("CheckpointSparkle") ~= nil""")
ok("  client: banner 'Checkpoint 2 / 3' shown, reached parts green, next one yellow, sparkle emitter on the reached part", painted[0] == "Checkpoint 2 / 3" and painted[1] == True and painted[2] == True and painted[3] == True and painted[4] == True, painted)

# ── 9. gui polish kit ─────────────────────────────────────────────────────────
r = runp("gui_bad")
ok("gui_polish_kit refuses a Part", not r.get("ok") and "not a ScreenGui" in r.get("error", ""), r)
r = runp("gui")
ok("  cartoon style on StarterGui.HUD: 3 panels, 2 texts, 1 button, padding on the crowded frame, FredokaOne, 16px corners, 3px stroke", r.get("ok") and r.get("panels") == 3 and r.get("texts") == 2 and r.get("buttons") == 1 and r.get("paddings") == 1 and r.get("font") == "FredokaOne" and r.get("corner") == 16 and r.get("stroke") == 3, r)
added = lua(r"""local p = _G.HUD.Panel
return p.TS_Corner.CornerRadius.Offset, p.TS_Stroke.Thickness, p.TS_Padding.PaddingLeft.Offset, _G.HUD.Panel.Title.TextScaled, _G.HUD.Panel.Title.TS_TextSize.MaxTextSize, tostring(_G.HUD.Panel.Title.Font), _G.PlayBtn.AutoButtonColor, _G.PlayBtn:GetAttribute("TS_Hover"), _G.HUD.TS_Scale ~= nil, _G.HUD.TS_PolishClient ~= nil""")
ok("  TS_* elements: corner 16, stroke 3, padding 10, TextScaled + max 36, Font FredokaOne, button AutoButtonColor off + TS_Hover, UIScale + client in the ScreenGui", added[0] == 16 and added[1] == 3 and added[2] == 10 and added[3] == True and added[4] == 36 and added[5] == "Enum.Font.FredokaOne" and added[6] == False and added[7] == True and added[8] == True and added[9] == True, added)
r2 = runp("gui")
ok("  running it again updates in place (still exactly one TS_Corner per panel)", r2.get("ok") and lua('local n = 0 for _, c in ipairs(_G.HUD.Panel:GetChildren()) do if c.Name == "TS_Corner" then n = n + 1 end end return n') == 1)
lua(r"""M.runScript(_G.HUD.TS_PolishClient, true)""")
hovered = lua(r"""_G.PlayBtn.MouseEnter:Fire() local a = _G.PlayBtn.Size.X.Offset _G.PlayBtn.MouseButton1Down:Fire() local b = _G.PlayBtn.Size.X.Offset _G.PlayBtn.MouseLeave:Fire() return a, b, _G.PlayBtn.Size.X.Offset, _G.HUD.TS_Scale.Scale""")
ok("  client: hover grows the button to 124.8 px, press shrinks to 115.2, leave restores 120; viewport 1280 -> scale 1", abs(hovered[0] - 124.8) < 0.01 and abs(hovered[1] - 115.2) < 0.01 and hovered[2] == 120 and hovered[3] == 1, hovered)

# ── 10. game feel kit ─────────────────────────────────────────────────────────
r = runp("feel")
ok("game_feel_kit installs folder + remote + Client / Server modules + runner, heavy dose 1.6", r.get("ok") and r.get("dose") == 1.6 and r.get("demo") == True and lua('local f = game.ReplicatedStorage.GameFeel return f.Feel:IsA("RemoteEvent") and f.Client:IsA("ModuleScript") and f.Server:IsA("ModuleScript") and game.StarterPlayer.StarterPlayerScripts.GameFeelClient ~= nil and f:GetAttribute("Intensity") == "heavy"'), r)
lua(r"""M.runScript(game.StarterPlayer.StarterPlayerScripts.GameFeelClient, true)""")
shook = lua(r"""local Feel = M.runModule(game.ReplicatedStorage.GameFeel.Client)
local cam = workspace.CurrentCamera local before = cam.CFrame.Position
game.ReplicatedStorage.GameFeel.Feel.OnClientEvent:Fire("shake", { strength = 0.5 })
local t1 = Feel.trauma
Feel.Step(1 / 60)
local moved = (cam.CFrame.Position - before).Magnitude
local t2 = Feel.trauma
for i = 1, 200 do Feel.Step(1 / 60) end
return t1, moved > 0, t2 < t1, Feel.trauma""")
ok("  remote 'shake' 0.5 x dose 1.6 -> trauma 0.8, RenderStepped step moves the camera and decays trauma, 200 frames later it is 0", abs(shook[0] - 0.8) < 1e-6 and shook[1] == True and shook[2] == True and shook[3] == 0, shook)
flashed = lua(r"""game.ReplicatedStorage.GameFeel.Feel.OnClientEvent:Fire("flash", { duration = 0.2, peak = 0.5 })
local g = M.playerGui:FindFirstChild("GameFeelFlash") local f = g and g:FindFirstChild("Flash")
return f ~= nil, f and f.Size.X.Scale, f and f.BackgroundTransparency""")
ok("  remote 'flash' builds the full-screen frame and tweens it back to transparent", flashed[0] == True and flashed[1] == 1 and flashed[2] == 1, flashed)
demo = lua(r"""local Feel = M.runModule(game.ReplicatedStorage.GameFeel.Client) Feel.trauma = 0
_G.CharHum.Health = 70 _G.CharHum.HealthChanged:Fire(70)
return Feel.trauma > 0, workspace.CurrentCamera.FieldOfView""")
ok("  demo hook: the local character losing 30 HP shakes (trauma > 0) and the FOV kick tweened back to base", demo[0] == True and demo[1] == 70, demo)
impact = lua(r"""local S = M.runModule(game.ReplicatedStorage.GameFeel.Server)
local n = S.Impact(_G.CharRoot.Position + Vector3.new(30, 0, 0), 1, 60)
local f = M.fired[#M.fired]
local far = S.Impact(_G.CharRoot.Position + Vector3.new(500, 0, 0), 1, 60)
return n, f and f[1], f and f[3], f and f[4] and f[4].strength, far""")
ok("  server Impact: 30 studs inside a 60 radius -> 1 player hit with strength 0.5 (falloff); 500 studs away -> nobody", impact[0] == 1 and impact[1] == "Feel" and impact[2] == "shake" and abs(impact[3] - 0.5) < 1e-6 and impact[4] == 0, impact)

# ── 11. place audit report ────────────────────────────────────────────────────
r = runp("audit")
checks = {f.split(" ")[1] + ":" + f.split(" ")[2] for f in r.get("findings", [])}
ok("place_audit_report scans the whole place: client DataStore error, deprecated APIs in Old (wait/spawn/BodyVelocity/:Remove), loose part, far part, empty folder; no false 'no_spawn'", r.get("ok") and "client_datastore:StarterGui.Bad" in checks and "deprecated_api:ServerScriptService.Old" in checks and "unanchored_part:Workspace.Loose" in checks and "far_from_origin:Workspace.Far" in checks and "empty_folder:Workspace.Empty" in checks and not any(c.startswith("no_spawn") for c in checks), r.get("findings"))
old_src = lua('return game.ServerScriptService.Old.Source')
ok("  fix_deprecated rewrote wait/spawn to task.* in exactly 1 script, left BodyVelocity / :Remove reported only", r.get("fixed") == 1 and old_src.startswith("task.wait(1)\ntask.spawn(") and "BodyVelocity" in old_src and ":Remove()" in old_src, old_src)
ok("  score / verdict honest (errors -> blocked), report ModuleScript written to ServerStorage and it requires back", r.get("errors") >= 1 and r.get("verdict").startswith("blocked") and r.get("score") < 100 and r.get("report") == "ServerStorage.TotalScriptAuditReport" and lua('local rep = M.runModule(game.ServerStorage.TotalScriptAuditReport) return type(rep) == "table" and rep.score and #rep.findings') == r.get("total"), r)
ok("  the unanchored character root is NOT flagged (character models are skipped)", not any(c.endswith("HumanoidRootPart") for c in checks))

# ── compile every embedded script ────────────────────────────────────────────
n, bad = compile_sources()
ok("every installed Script / LocalScript / ModuleScript compiles (%d sources)" % n, n == 22 and bad == "", bad)
ok("no Luau-only syntax the mocked parser cannot read slipped in (+= / continue / `::` types)", lua(r"""for _, d in ipairs(game:GetDescendants()) do if d:IsA("LuaSourceContainer") and (d.Source:find("+=", 1, true) or d.Source:find("\ncontinue", 1, true) or d.Source:find("::", 1, true)) then return false end end return true"""))

print("public-pack-sim: %d passed, %d failed (MOCKED DataModel - not Studio)" % (passed, failed))
sys.exit(1 if failed else 0)
