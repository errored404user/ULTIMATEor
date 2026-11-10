// TotalScript — Featured Public Skill packs (2.20.0)
//
// Ready-made, high-quality Public Skills that ship WITH the extension so anyone
// can install them in one click (cards panel → Public → "Featured by
// TotalScript" → Install), with the command public_skill_import
// {data:"featured"}, or from the pack file public_skills/totalscript-featured
// .orskills.json (the same definitions, exported by tests/build-public-pack.js
// so the file and this module can never drift).
//
// Every item is an ordinary Public Skill definition — it goes through the same
// validate() / importPack() path as a file somebody hands you, lands in
// chrome.storage.local like any other item, can be edited, exported, improved
// with AI, disabled or deleted. Nothing here is privileged; "featured" only
// means it is bundled and curated. Installing is always explicit (no
// auto-install), re-installing an item you edited asks before replacing.
//
// Design rules for the pack (kept honest on purpose):
//   • each skill is a complete SYSTEM (server + client + config) in one call,
//     not a wrapper around a single built-in command;
//   • idempotent: running a skill again replaces its own earlier install;
//   • no asset ids are invented — sounds/images are left as hooks (SoundId "")
//     and said so in the result;
//   • settings live as Attributes on the installed instances so people tweak
//     them in the Properties panel without touching code;
//   • the embedded scripts are plain Luau that also parses as Lua 5.x so the
//     mocked Roblox sim (tests/public-pack-sim.py) can compile every one;
//   • 2.20.0: every item carries `knowledge` (when / before / after - what the
//     AI reads when the skill's triggers match) and a `verify` block (runs after
//     the command with args/result in scope; a pass is what makes the installed
//     copy VERIFIED on the user's place - bundling never pre-verifies anything).
//
// This file is DOM-free at top level (node loads it for the tests).
(function (root) {
  "use strict";
  const VERSION = "2.20.0";
  const PACK_ID = "totalscript_featured";
  const AUTHOR = "TotalScript";
  const DOCS = "https://create.roblox.com/docs/";
  const ref = (title, path) => ({ title, url: DOCS + path });

  // ── shared Luau prelude (installer side) ────────────────────────────────
  const PRELUDE = String.raw`
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local function resolve(path)
  if typeof(path) == "Instance" then return path end
  if type(path) ~= "string" or path == "" then return nil end
  local cur = game
  for seg in string.gmatch(path, "[^%.]+") do
    if cur == game and (seg == "game" or seg == "Game") then
      -- skip the optional leading "game."
    elseif cur == game and (seg == "Workspace" or seg == "workspace") then
      cur = workspace
    else
      local nxt = cur:FindFirstChild(seg)
      if not nxt and cur == game then
        local okS, s = pcall(function() return game:GetService(seg) end)
        if okS then nxt = s end
      end
      if not nxt then return nil end
      cur = nxt
    end
  end
  return cur
end
local function ensure(parent, class, name)
  local inst = parent:FindFirstChild(name)
  if inst and inst.ClassName ~= class then inst:Destroy() inst = nil end
  if not inst then inst = Instance.new(class) inst.Name = name inst.Parent = parent end
  return inst
end
local function setSource(parent, class, name, src)
  local old = parent:FindFirstChild(name)
  if old then old:Destroy() end
  local s = Instance.new(class)
  s.Name = name
  s.Source = src
  s.Parent = parent
  return s
end
local function hexColor(hex, fallback)
  if typeof(hex) == "Color3" then return hex end
  if type(hex) ~= "string" then return fallback end
  local h = string.gsub(hex, "#", "")
  if #h ~= 6 then return fallback end
  local r, g, b = tonumber(string.sub(h, 1, 2), 16), tonumber(string.sub(h, 3, 4), 16), tonumber(string.sub(h, 5, 6), 16)
  if not (r and g and b) then return fallback end
  return Color3.fromRGB(r, g, b)
end
local function num(v, default, lo, hi)
  local n = tonumber(v)
  if n == nil then n = default end
  if lo and n < lo then n = lo end
  if hi and n > hi then n = hi end
  return n
end
local function waypoint(label) pcall(function() ChangeHistoryService:SetWaypoint(label) end) end
local StarterPlayerScripts = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts") or (function()
  local f = Instance.new("StarterPlayerScripts") f.Parent = game:GetService("StarterPlayer") return f
end)()
`;

  // ── 1. damage_numbers_pro ────────────────────────────────────────────────
  const DAMAGE_NUMBERS = {
    kind: "skill", name: "damage_numbers_pro", title: "Damage Numbers Pro",
    description: "Floating damage / heal / CRIT numbers over every character and NPC (server detects Humanoid health changes, clients draw tweened BillboardGui numbers). One call installs ReplicatedStorage.DamageNumbers (RemoteEvent + settings as attributes), a server Script and a client LocalScript; re-running replaces the install.",
    tags: ["combat", "ui", "vfx", "feedback"], triggers: ["damage numbers", "floating text", "hit numbers", "crit popup", "damage popup"],
    expert: "gameplay_systems", version: 1,
    usage: 'damage_numbers_pro {scope:"all", crit_threshold:25, show_heal:true}',
    params: [
      { name: "scope", type: "string", required: false, default: "all", enum: ["all", "players", "npcs"], description: "Which humanoids get numbers" },
      { name: "crit_threshold", type: "number", required: false, default: 25, description: "A single hit >= this shows as a bigger gold CRIT" },
      { name: "show_heal", type: "boolean", required: false, default: true, description: "Show green +N for healing" },
      { name: "scale", type: "number", required: false, default: 1, description: "Size multiplier (0.5-3)" },
      { name: "font", type: "string", required: false, default: "GothamBold", description: "Enum.Font name (GothamBold, FredokaOne, Bangers, Arcade, ...)" },
      { name: "damage_color", type: "string", required: false, default: "#FF5A5A", description: "Hex colour for damage" },
      { name: "crit_color", type: "string", required: false, default: "#FFC83D", description: "Hex colour for crits" },
      { name: "heal_color", type: "string", required: false, default: "#4ADE80", description: "Hex colour for heals" },
    ],
    references: [ref("BillboardGui", "reference/engine/classes/BillboardGui"), ref("TweenService", "reference/engine/classes/TweenService"), ref("Humanoid", "reference/engine/classes/Humanoid"), ref("Remote events", "scripting/events/remote")],
    knowledge: String.raw`## When to use
- The user wants hit / heal / CRIT numbers floating over characters or NPCs - combat feedback, "damage popups", "floating text".

## Before running
- Nothing to prepare: it watches every Humanoid (scope: all / players / npcs). Run it once; a re-run only updates the settings.

## After running
- Tell the user the settings are Attributes on ReplicatedStorage.DamageNumbers (CritThreshold, colours, Scale, Font) - tweak them in Properties, no code.
- Other scripts can fire ReplicatedStorage.DamageNumbers.Show (player, position, amount, kind) for custom numbers.
- Sounds are not included (no invented asset ids): offer to add a hit SFX hook if asked.`,
    verify: { note: "folder + RemoteEvent + server/client scripts exist with settings attributes", luau: String.raw`local folder = find("ReplicatedStorage.DamageNumbers")
check(folder, "ReplicatedStorage.DamageNumbers missing")
check(folder:FindFirstChild("Show") and folder.Show:IsA("RemoteEvent"), "Show RemoteEvent missing")
check(folder:GetAttribute("CritThreshold") ~= nil, "CritThreshold attribute missing")
local server = find("ServerScriptService.DamageNumbersServer")
check(server and server:IsA("Script") and #server.Source > 200, "DamageNumbersServer script missing or empty")
local client = find("StarterPlayer.StarterPlayerScripts.DamageNumbersClient")
check(client and client:IsA("LocalScript") and #client.Source > 200, "DamageNumbersClient missing or empty")
return { ok = true, detail = "folder + RemoteEvent + server + client present; CritThreshold=" .. tostring(folder:GetAttribute("CritThreshold")) }` },
    luau: PRELUDE + String.raw`
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local folder = ensure(ReplicatedStorage, "Folder", "DamageNumbers")
ensure(folder, "RemoteEvent", "Show")
folder:SetAttribute("Scope", args.scope or "all")
folder:SetAttribute("CritThreshold", num(args.crit_threshold, 25, 1, 1000000))
folder:SetAttribute("ShowHeal", args.show_heal ~= false)
folder:SetAttribute("Scale", num(args.scale, 1, 0.5, 3))
folder:SetAttribute("Font", tostring(args.font or "GothamBold"))
folder:SetAttribute("DamageColor", hexColor(args.damage_color, Color3.fromRGB(255, 90, 90)))
folder:SetAttribute("CritColor", hexColor(args.crit_color, Color3.fromRGB(255, 200, 61)))
folder:SetAttribute("HealColor", hexColor(args.heal_color, Color3.fromRGB(74, 222, 128)))
folder:SetAttribute("Version", "2.20.0")

setSource(ServerScriptService, "Script", "DamageNumbersServer", [==[
-- Damage Numbers Pro (TotalScript featured skill) - server side.
-- Watches every Humanoid in Workspace and tells clients where a number should pop.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local folder = ReplicatedStorage:WaitForChild("DamageNumbers")
local remote = folder:WaitForChild("Show")
local scope = folder:GetAttribute("Scope") or "all"
local lastHealth = {}

local function anchorOf(model)
  return model:FindFirstChild("Head") or model:FindFirstChild("HumanoidRootPart") or model:FindFirstChildWhichIsA("BasePart")
end

local function watch(humanoid)
  if lastHealth[humanoid] ~= nil then return end
  local model = humanoid.Parent
  if not model then return end
  local isPlayer = Players:GetPlayerFromCharacter(model) ~= nil
  if scope == "players" and not isPlayer then return end
  if scope == "npcs" and isPlayer then return end
  lastHealth[humanoid] = humanoid.Health
  humanoid.HealthChanged:Connect(function(health)
    local previous = lastHealth[humanoid]
    lastHealth[humanoid] = health
    if previous == nil then return end
    local delta = health - previous
    if math.abs(delta) < 0.5 then return end
    local part = anchorOf(model)
    if not part then return end
    remote:FireAllClients(part.Position + Vector3.new(0, 1.5, 0), delta, model.Name)
  end)
  humanoid.Destroying:Connect(function() lastHealth[humanoid] = nil end)
end

for _, inst in ipairs(workspace:GetDescendants()) do
  if inst:IsA("Humanoid") then watch(inst) end
end
workspace.DescendantAdded:Connect(function(inst)
  if inst:IsA("Humanoid") then task.defer(watch, inst) end
end)
]==])

setSource(StarterPlayerScripts, "LocalScript", "DamageNumbersClient", [==[
-- Damage Numbers Pro (TotalScript featured skill) - client side.
-- Draws the numbers: rise + fade tween, punch-in scale, CRIT styling, heals in green.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local Debris = game:GetService("Debris")
local folder = ReplicatedStorage:WaitForChild("DamageNumbers")
local remote = folder:WaitForChild("Show")
local player = Players.LocalPlayer

local critAt = folder:GetAttribute("CritThreshold") or 25
local showHeal = folder:GetAttribute("ShowHeal") ~= false
local scale = folder:GetAttribute("Scale") or 1
local colors = {
  damage = folder:GetAttribute("DamageColor") or Color3.fromRGB(255, 90, 90),
  crit = folder:GetAttribute("CritColor") or Color3.fromRGB(255, 200, 61),
  heal = folder:GetAttribute("HealColor") or Color3.fromRGB(74, 222, 128),
}
local font = Enum.Font.GothamBold
pcall(function() font = Enum.Font[folder:GetAttribute("Font") or "GothamBold"] end)

local holder = Instance.new("Folder")
holder.Name = "DamageNumbers"
holder.Parent = workspace.CurrentCamera -- client-only container, never replicates
local rng = Random.new()

local function pop(position, delta, who)
  if delta > 0 and not showHeal then return end
  local kind = "damage"
  if delta > 0 then kind = "heal" elseif math.abs(delta) >= critAt then kind = "crit" end

  local anchor = Instance.new("Part")
  anchor.Anchored = true
  anchor.CanCollide = false
  anchor.CanQuery = false
  anchor.CanTouch = false
  anchor.Transparency = 1
  anchor.Size = Vector3.new(0.2, 0.2, 0.2)
  anchor.CFrame = CFrame.new(position + Vector3.new(rng:NextNumber(-1, 1), 0, rng:NextNumber(-1, 1)))
  anchor.Parent = holder

  local bb = Instance.new("BillboardGui")
  bb.AlwaysOnTop = true
  bb.LightInfluence = 0
  bb.Size = UDim2.fromScale((kind == "crit" and 5.5 or 4) * scale, (kind == "crit" and 2 or 1.4) * scale)
  bb.Parent = anchor

  local label = Instance.new("TextLabel")
  label.BackgroundTransparency = 1
  label.Size = UDim2.fromScale(1, 1)
  label.Font = font
  label.TextScaled = true
  label.TextColor3 = colors[kind]
  label.TextStrokeColor3 = Color3.new(0, 0, 0)
  label.TextStrokeTransparency = 0.25
  local amount = math.floor(math.abs(delta) + 0.5)
  if delta > 0 then label.Text = "+" .. amount else label.Text = "-" .. amount end
  if kind == "crit" then label.Text = label.Text .. "!" end
  label.Parent = bb

  local punch = Instance.new("UIScale")
  punch.Scale = kind == "crit" and 1.7 or 1.25
  punch.Parent = label
  TweenService:Create(punch, TweenInfo.new(0.18, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Scale = 1 }):Play()

  local rise = Vector3.new(0, kind == "crit" and 4 or 2.5, 0)
  TweenService:Create(bb, TweenInfo.new(0.9, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { StudsOffset = rise }):Play()
  task.delay(0.4, function()
    TweenService:Create(label, TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.In), { TextTransparency = 1, TextStrokeTransparency = 1 }):Play()
  end)
  Debris:AddItem(anchor, 1.1)
end

remote.OnClientEvent:Connect(pop)
]==])

waypoint("TotalScript: damage_numbers_pro")
return {
  installed = { "ReplicatedStorage.DamageNumbers (RemoteEvent Show + settings attributes)", "ServerScriptService.DamageNumbersServer", "StarterPlayer.StarterPlayerScripts.DamageNumbersClient" },
  scope = folder:GetAttribute("Scope"), crit_threshold = folder:GetAttribute("CritThreshold"),
  tweak = "Change the attributes on ReplicatedStorage.DamageNumbers (CritThreshold, ShowHeal, Scale, Font, colours) - no code edits needed.",
  test = "Press Play, damage any Humanoid (e.g. humanoid_set or a kill brick) and numbers pop above the head.",
}
`,
  };

  // ── 2. npc_patrol_chase ──────────────────────────────────────────────────
  const NPC_BRAIN = {
    kind: "skill", name: "npc_patrol_chase", title: "NPC Patrol & Chase Brain",
    description: "Gives an existing NPC (Model with Humanoid + HumanoidRootPart) a complete AI brain: patrols waypoints (a Folder of Parts) or random points around home, detects the nearest player, chases with PathfindingService (re-paths, jumps), attacks on cooldown, gives up at lose range and returns home. All numbers are attributes on the NPC model.",
    tags: ["npc", "ai", "pathfinding", "combat"], triggers: ["npc ai", "enemy ai", "patrol", "chase player", "zombie brain", "guard"],
    expert: "gameplay_systems", version: 1,
    usage: 'npc_patrol_chase {npc:"Workspace.Guard", waypoints:"Workspace.GuardPath", detect_range:30, damage:10}',
    params: [
      { name: "npc", type: "string", required: true, description: "Path to the NPC Model (needs Humanoid + HumanoidRootPart), e.g. Workspace.Zombie" },
      { name: "waypoints", type: "string", required: false, default: "", description: "Optional path to a Folder of Parts walked in name order; empty = random points around home" },
      { name: "patrol_radius", type: "number", required: false, default: 25, description: "Random patrol radius when no waypoints" },
      { name: "detect_range", type: "number", required: false, default: 30, description: "Studs at which a player is noticed" },
      { name: "lose_range", type: "number", required: false, default: 50, description: "Studs at which the chase is abandoned" },
      { name: "walk_speed", type: "number", required: false, default: 10 },
      { name: "chase_speed", type: "number", required: false, default: 18 },
      { name: "attack_range", type: "number", required: false, default: 4 },
      { name: "damage", type: "number", required: false, default: 10, description: "Damage per hit (0 = never attacks, just follows)" },
      { name: "attack_cooldown", type: "number", required: false, default: 1.2 },
    ],
    references: [ref("Character pathfinding", "characters/pathfinding"), ref("PathfindingService", "reference/engine/classes/PathfindingService"), ref("Humanoid", "reference/engine/classes/Humanoid"), ref("Humanoid.MoveTo", "reference/engine/classes/Humanoid#MoveTo"), ref("Attributes", "scripting/attributes")],
    knowledge: String.raw`## When to use
- An NPC / enemy / guard / zombie model should patrol and chase players - "enemy AI", "make the zombie follow me".

## Before running
- The model needs a Humanoid and a HumanoidRootPart (R6/R15 rigs or rig_generate output). Use search_game_tree to get its exact path.
- Waypoints are optional: a Folder of Parts walked in name order; without it the NPC wanders within patrol_radius of home.

## After running
- Every tuning value is an Attribute on the model (DetectRange, LoseRange, WalkSpeed, ChaseSpeed, AttackRange, Damage, AttackCooldown); State shows idle / patrol / chase / attack / dead live.
- damage 0 makes a follower that never attacks. Suggest a Playtest to see it move; the brain only runs in Play.`,
    verify: { note: "the NPC has a Humanoid, the NPCBrain script and its tuning attributes", luau: String.raw`local npc = find(args.npc)
check(npc, "NPC not found at " .. tostring(args.npc))
check(npc:FindFirstChildOfClass("Humanoid"), "no Humanoid in " .. npc:GetFullName())
local brain = npc:FindFirstChild("NPCBrain")
check(brain and brain:IsA("Script") and #brain.Source > 500, "NPCBrain script missing or empty")
check(npc:GetAttribute("DetectRange") ~= nil and npc:GetAttribute("State") ~= nil, "DetectRange / State attributes missing")
return { ok = true, detail = npc:GetFullName() .. " has NPCBrain, DetectRange=" .. tostring(npc:GetAttribute("DetectRange")) }` },
    luau: PRELUDE + String.raw`
local npc = resolve(args.npc)
if not npc then return { ok = false, error = "NPC not found at '" .. tostring(args.npc) .. "' - give the full path, e.g. Workspace.Zombie" } end
if not npc:IsA("Model") then return { ok = false, error = npc:GetFullName() .. " is a " .. npc.ClassName .. ", the NPC must be a Model" } end
local humanoid = npc:FindFirstChildOfClass("Humanoid")
local rootPart = npc:FindFirstChild("HumanoidRootPart")
if not humanoid or not rootPart then return { ok = false, error = npc:GetFullName() .. " needs a Humanoid and a HumanoidRootPart (use a rig from the Rig Builder or model_build with a humanoid)" } end
local waypointsPath = ""
if args.waypoints and args.waypoints ~= "" then
  local f = resolve(args.waypoints)
  if not f then return { ok = false, error = "waypoints folder not found at '" .. tostring(args.waypoints) .. "'" } end
  local n = 0
  for _, c in ipairs(f:GetChildren()) do if c:IsA("BasePart") then n = n + 1 end end
  if n == 0 then return { ok = false, error = f:GetFullName() .. " has no Parts to use as waypoints" } end
  waypointsPath = f:GetFullName()
end
npc.PrimaryPart = rootPart
npc:SetAttribute("WaypointsPath", waypointsPath)
npc:SetAttribute("PatrolRadius", num(args.patrol_radius, 25, 4, 500))
npc:SetAttribute("DetectRange", num(args.detect_range, 30, 2, 1000))
npc:SetAttribute("LoseRange", math.max(num(args.lose_range, 50, 2, 2000), num(args.detect_range, 30, 2, 1000)))
npc:SetAttribute("WalkSpeed", num(args.walk_speed, 10, 1, 100))
npc:SetAttribute("ChaseSpeed", num(args.chase_speed, 18, 1, 100))
npc:SetAttribute("AttackRange", num(args.attack_range, 4, 1, 50))
npc:SetAttribute("Damage", num(args.damage, 10, 0, 100000))
npc:SetAttribute("AttackCooldown", num(args.attack_cooldown, 1.2, 0.1, 60))
npc:SetAttribute("State", "idle")
humanoid.WalkSpeed = npc:GetAttribute("WalkSpeed")
for _, p in ipairs(npc:GetDescendants()) do if p:IsA("BasePart") then p.Anchored = false end end

setSource(npc, "Script", "NPCBrain", [==[
-- NPC Patrol & Chase Brain (TotalScript featured skill).
-- States: patrol -> chase -> (attack) -> return -> patrol. Tune via attributes on the model.
local Players = game:GetService("Players")
local PathfindingService = game:GetService("PathfindingService")
local model = script.Parent
local humanoid = model:WaitForChild("Humanoid")
local root = model:WaitForChild("HumanoidRootPart")

local function attr(name, default)
  local v = model:GetAttribute(name)
  if v == nil then return default end
  return v
end
local DETECT = attr("DetectRange", 30)
local LOSE = attr("LoseRange", 50)
local WALK = attr("WalkSpeed", 10)
local CHASE = attr("ChaseSpeed", 18)
local ATTACK_RANGE = attr("AttackRange", 4)
local DAMAGE = attr("Damage", 10)
local COOLDOWN = attr("AttackCooldown", 1.2)
local RADIUS = attr("PatrolRadius", 25)
local home = root.Position
local rng = Random.new()

for _, p in ipairs(model:GetDescendants()) do
  if p:IsA("BasePart") then pcall(function() p:SetNetworkOwner(nil) end) end
end

-- waypoints: Folder of Parts (attribute WaypointsPath, walked in name order) or random points around home
local waypoints = {}
do
  local path = attr("WaypointsPath", "")
  if path ~= "" then
    local cur = game
    for seg in string.gmatch(path, "[^%.]+") do
      if cur then
        if cur == game and seg == "Workspace" then cur = workspace else cur = cur:FindFirstChild(seg) end
      end
    end
    if cur and cur ~= game then
      for _, p in ipairs(cur:GetChildren()) do if p:IsA("BasePart") then table.insert(waypoints, p) end end
      table.sort(waypoints, function(a, b) return a.Name < b.Name end)
    end
  end
end
local wpIndex = 0
local function nextPatrolTarget()
  if #waypoints > 0 then
    wpIndex = wpIndex % #waypoints + 1
    return waypoints[wpIndex].Position
  end
  local a = rng:NextNumber(0, math.pi * 2)
  local d = rng:NextNumber(RADIUS * 0.3, RADIUS)
  return home + Vector3.new(math.cos(a) * d, 0, math.sin(a) * d)
end

local function nearestPlayer(maxDist)
  local best, bestD = nil, maxDist
  for _, plr in ipairs(Players:GetPlayers()) do
    local ch = plr.Character
    local hum = ch and ch:FindFirstChildOfClass("Humanoid")
    local hrp = ch and ch:FindFirstChild("HumanoidRootPart")
    if hum and hrp and hum.Health > 0 then
      local d = (hrp.Position - root.Position).Magnitude
      if d < bestD then best, bestD = hrp, d end
    end
  end
  return best, bestD
end

local agent = { AgentRadius = 2, AgentHeight = 5, AgentCanJump = true, WaypointSpacing = 4 }
pcall(function()
  local size = model:GetExtentsSize()
  agent.AgentRadius = math.max(1, math.min(size.X, size.Z) / 2)
  agent.AgentHeight = math.max(2, size.Y)
end)

local generation = 0
-- Walk to goal along a computed path. abort() is polled between waypoints; returns true when the goal was reached.
local function walkTo(goal, speed, abort)
  generation = generation + 1
  local myGen = generation
  humanoid.WalkSpeed = speed
  local path = PathfindingService:CreatePath(agent)
  local okCompute = pcall(function() path:ComputeAsync(root.Position, goal) end)
  if not okCompute or path.Status ~= Enum.PathStatus.Success then
    humanoid:MoveTo(goal) -- straight-line fallback (MoveToFinished has its own 8 s timeout)
    return humanoid.MoveToFinished:Wait()
  end
  local points = path:GetWaypoints()
  for i = 2, #points do
    if generation ~= myGen then return false end
    if abort and abort() then return false end
    local wp = points[i]
    if wp.Action == Enum.PathWaypointAction.Jump then humanoid.Jump = true end
    humanoid:MoveTo(wp.Position)
    local reached = humanoid.MoveToFinished:Wait()
    if not reached then return false end
  end
  return true
end

local lastAttack = 0
local function tryAttack(hrp)
  if DAMAGE <= 0 then return end
  local ch = hrp.Parent
  local hum = ch and ch:FindFirstChildOfClass("Humanoid")
  if not hum or hum.Health <= 0 then return end
  if os.clock() - lastAttack < COOLDOWN then return end
  lastAttack = os.clock()
  hum:TakeDamage(DAMAGE)
  model:SetAttribute("LastAttackAt", os.clock())
end

local state, target = "patrol", nil
local function noticePlayer()
  local hrp = nearestPlayer(DETECT)
  if hrp then target = hrp state = "chase" return true end
  return false
end

task.spawn(function()
  while model.Parent and humanoid.Health > 0 do
    model:SetAttribute("State", state)
    if state == "patrol" then
      walkTo(nextPatrolTarget(), WALK, noticePlayer)
      if state == "patrol" and not noticePlayer() then task.wait(rng:NextNumber(0.8, 2.5)) end
    elseif state == "chase" then
      local hrp = target
      local tch = hrp and hrp.Parent
      local thum = tch and tch:FindFirstChildOfClass("Humanoid")
      if not hrp or not tch or not thum or thum.Health <= 0 or (hrp.Position - root.Position).Magnitude > LOSE then
        target = nil
        state = "return"
      else
        local d = (hrp.Position - root.Position).Magnitude
        if d <= ATTACK_RANGE then
          humanoid:MoveTo(root.Position)
          local flat = Vector3.new(hrp.Position.X, root.Position.Y, hrp.Position.Z)
          if (flat - root.Position).Magnitude > 0.1 then root.CFrame = CFrame.lookAt(root.Position, flat) end
          tryAttack(hrp)
          task.wait(0.15)
        elseif d < 14 then
          humanoid.WalkSpeed = CHASE
          humanoid:MoveTo(hrp.Position) -- close and in the open: direct pursuit, re-aimed every 0.2 s
          task.wait(0.2)
        else
          local goal = hrp.Position
          walkTo(goal, CHASE, function()
            return not hrp.Parent or (hrp.Position - goal).Magnitude > 6 or (hrp.Position - root.Position).Magnitude <= ATTACK_RANGE
          end)
        end
      end
    elseif state == "return" then
      walkTo(home, WALK, noticePlayer)
      if state == "return" then state = "patrol" end
    else
      state = "patrol"
    end
    task.wait()
  end
  model:SetAttribute("State", "dead")
end)
]==])

waypoint("TotalScript: npc_patrol_chase " .. npc.Name)
return {
  npc = npc:GetFullName(), brain = npc:GetFullName() .. ".NPCBrain", waypoints = waypointsPath ~= "" and waypointsPath or "random points within " .. tostring(npc:GetAttribute("PatrolRadius")) .. " studs of home",
  attributes = { "DetectRange", "LoseRange", "WalkSpeed", "ChaseSpeed", "AttackRange", "Damage", "AttackCooldown", "PatrolRadius", "WaypointsPath", "State (live)" },
  test = "Press Play and walk within DetectRange: the model's State attribute goes patrol -> chase -> return. Set Damage to 0 for a harmless follower.",
}
`,
  };

  // ── 3. keycard_door_system ───────────────────────────────────────────────
  const DOOR = {
    kind: "skill", name: "keycard_door_system", title: "Keycard Door System",
    description: "Turns any Part or Model into a working door: ProximityPrompt to open/close, slide / swing / fade motion tweened over the whole model, optional key requirement (a Tool name in the backpack or a player attribute), locked message, auto-close timer, Open attribute + RequestOpen attribute as a scripting API. Re-running on the same door updates it.",
    tags: ["door", "interaction", "proximity prompt", "tween", "building"], triggers: ["door", "sliding door", "keycard", "locked door", "open door prompt", "gate"],
    expert: "gameplay_systems", version: 1,
    usage: 'keycard_door_system {door:"Workspace.LabDoor", motion:"slide", key:"Keycard", auto_close:3}',
    params: [
      { name: "door", type: "string", required: true, description: "Path to the door Part or Model" },
      { name: "motion", type: "string", required: false, default: "slide", enum: ["slide", "swing", "fade"], description: "slide along an axis, swing 90 degrees on its edge, or fade out and let players through" },
      { name: "axis", type: "string", required: false, default: "auto", enum: ["auto", "x", "y", "z"], description: "Slide / hinge axis in the door's local space (auto = its widest horizontal side)" },
      { name: "distance", type: "number", required: false, default: 0, description: "Slide distance in studs (0 = the door's own width)" },
      { name: "open_time", type: "number", required: false, default: 0.6, description: "Seconds for the open / close tween" },
      { name: "auto_close", type: "number", required: false, default: 3, description: "Seconds before it closes itself (0 = stays open)" },
      { name: "key", type: "string", required: false, default: "", description: "Tool name the player must carry (Backpack or hand); empty = no key" },
      { name: "key_attribute", type: "string", required: false, default: "", description: "Alternatively a Player attribute that must be truthy, e.g. HasRedKey" },
      { name: "prompt_text", type: "string", required: false, default: "Open" },
      { name: "locked_text", type: "string", required: false, default: "Locked - keycard required" },
    ],
    references: [ref("Proximity prompts", "ui/proximity-prompts"), ref("ProximityPrompt", "reference/engine/classes/ProximityPrompt"), ref("TweenService", "reference/engine/classes/TweenService"), ref("Tools", "players/tools")],
    knowledge: String.raw`## When to use
- A door / gate should open from a ProximityPrompt, optionally locked behind a keycard Tool or a player attribute.

## Before running
- The door is a Part or a Model (every BasePart inside moves together). Get its path with search_game_tree; do not guess.
- motion: slide (default, along the widest side), swing (90 degrees on its edge) or fade (walk-through).

## After running
- Settings are Attributes on the door (Motion, Axis, Distance, OpenTime, AutoClose, KeyTool, KeyAttribute, PromptText, LockedText). Open is the live state.
- Other scripts: door:SetAttribute("RequestOpen", true). Give the player the key Tool (players/tools) if key was set.`,
    verify: { note: "door has DoorController, a DoorPrompt and Motion/Open attributes", luau: String.raw`local door = find(args.door)
check(door, "door not found at " .. tostring(args.door))
local ctl = door:FindFirstChild("DoorController")
check(ctl and ctl:IsA("Script") and #ctl.Source > 300, "DoorController script missing")
local prompt = door:FindFirstChild("DoorPrompt", true)
check(prompt and prompt:IsA("ProximityPrompt"), "DoorPrompt ProximityPrompt missing")
check(door:GetAttribute("Motion") ~= nil and door:GetAttribute("Open") ~= nil, "Motion / Open attributes missing")
return { ok = true, detail = door:GetFullName() .. " motion=" .. tostring(door:GetAttribute("Motion")) .. " key=" .. tostring(door:GetAttribute("KeyTool")) }` },
    luau: PRELUDE + String.raw`
local door = resolve(args.door)
if not door then return { ok = false, error = "door not found at '" .. tostring(args.door) .. "'" } end
local rootPart
if door:IsA("BasePart") then rootPart = door
elseif door:IsA("Model") then
  rootPart = door.PrimaryPart
  if not rootPart then
    local best, bestV = nil, -1
    for _, p in ipairs(door:GetDescendants()) do
      if p:IsA("BasePart") then local v = p.Size.X * p.Size.Y * p.Size.Z if v > bestV then best, bestV = p, v end end
    end
    rootPart = best
    if rootPart then door.PrimaryPart = rootPart end
  end
else
  return { ok = false, error = door:GetFullName() .. " is a " .. door.ClassName .. " - the door must be a Part or a Model" }
end
if not rootPart then return { ok = false, error = door:GetFullName() .. " has no BasePart" } end
local size = door:IsA("Model") and door:GetExtentsSize() or rootPart.Size
local axis = tostring(args.axis or "auto")
if axis == "auto" then axis = (size.Z > size.X) and "z" or "x" end
local motion = tostring(args.motion or "slide")
local distance = num(args.distance, 0, 0, 500)
if distance <= 0 then
  if axis == "y" then distance = size.Y elseif axis == "z" then distance = size.Z else distance = size.X end
end
local parts = 0
for _, p in ipairs(door:IsA("BasePart") and { door } or door:GetDescendants()) do
  if p:IsA("BasePart") then p.Anchored = true parts = parts + 1 end
end
door:SetAttribute("Motion", motion)
door:SetAttribute("Axis", axis)
door:SetAttribute("Distance", distance)
door:SetAttribute("OpenTime", num(args.open_time, 0.6, 0.05, 30))
door:SetAttribute("AutoClose", num(args.auto_close, 3, 0, 3600))
door:SetAttribute("KeyTool", tostring(args.key or ""))
door:SetAttribute("KeyAttribute", tostring(args.key_attribute or ""))
door:SetAttribute("PromptText", tostring(args.prompt_text or "Open"))
door:SetAttribute("LockedText", tostring(args.locked_text or "Locked - keycard required"))
door:SetAttribute("Open", false)
local prompt = ensure(rootPart, "ProximityPrompt", "DoorPrompt")
prompt.ActionText = door:GetAttribute("PromptText")
prompt.ObjectText = door.Name
prompt.HoldDuration = 0
prompt.MaxActivationDistance = 10
prompt.RequiresLineOfSight = false

setSource(door, "Script", "DoorController", [==[
-- Keycard Door System (TotalScript featured skill).
-- API for other scripts: door:SetAttribute("RequestOpen", true/false); read door:GetAttribute("Open").
local TweenService = game:GetService("TweenService")
local door = script.Parent
local root = door:IsA("BasePart") and door or (door.PrimaryPart or door:FindFirstChildWhichIsA("BasePart", true))
local prompt = root and root:FindFirstChild("DoorPrompt")
local function attr(n, d) local v = door:GetAttribute(n) if v == nil then return d end return v end
local motion = attr("Motion", "slide")
local distance = attr("Distance", 6)
local axis = attr("Axis", "x")
local openTime = attr("OpenTime", 0.6)
local autoClose = attr("AutoClose", 3)
local keyTool = attr("KeyTool", "")
local keyAttr = attr("KeyAttribute", "")
local promptText = attr("PromptText", "Open")
local lockedText = attr("LockedText", "Locked - keycard required")

local function pivot() if door:IsA("Model") then return door:GetPivot() end return root.CFrame end
local closedCF = pivot()
local size = door:IsA("Model") and door:GetExtentsSize() or root.Size
local function openCF()
  if motion == "swing" then
    local half = (axis == "z" and size.Z or size.X) / 2
    local edge = axis == "z" and Vector3.new(0, 0, -half) or Vector3.new(-half, 0, 0)
    return closedCF * CFrame.new(edge) * CFrame.Angles(0, math.rad(90), 0) * CFrame.new(-edge)
  end
  local offset = Vector3.new(distance, 0, 0)
  if axis == "y" then offset = Vector3.new(0, distance, 0) elseif axis == "z" then offset = Vector3.new(0, 0, distance) end
  return closedCF * CFrame.new(offset)
end

local parts = {}
for _, p in ipairs(door:IsA("BasePart") and { door } or door:GetDescendants()) do
  if p:IsA("BasePart") then
    table.insert(parts, p)
    if p:GetAttribute("BaseTransparency") == nil then p:SetAttribute("BaseTransparency", p.Transparency) end
  end
end
local function fade(on)
  for _, p in ipairs(parts) do
    local target = on and 0.85 or (p:GetAttribute("BaseTransparency") or 0)
    TweenService:Create(p, TweenInfo.new(openTime), { Transparency = target }):Play()
    p.CanCollide = not on
  end
end

local cfv = Instance.new("CFrameValue")
cfv.Value = closedCF
cfv.Changed:Connect(function(cf)
  if door:IsA("Model") then door:PivotTo(cf) else root.CFrame = cf end
end)

local isOpen, busy = false, false
local function setOpen(on)
  if busy then return end
  busy = true
  isOpen = on
  door:SetAttribute("Open", on)
  if motion == "fade" then
    fade(on)
    task.wait(openTime)
  else
    local tw = TweenService:Create(cfv, TweenInfo.new(openTime, Enum.EasingStyle.Quad, Enum.EasingDirection.InOut), { Value = on and openCF() or closedCF })
    tw:Play()
    tw.Completed:Wait()
  end
  busy = false
  if prompt then prompt.ActionText = on and "Close" or promptText end
end

local function hasKey(player)
  if keyTool == "" and keyAttr == "" then return true end
  if keyAttr ~= "" and player:GetAttribute(keyAttr) then return true end
  if keyTool ~= "" then
    local ch = player.Character
    if ch and ch:FindFirstChild(keyTool) then return true end
    local backpack = player:FindFirstChildOfClass("Backpack")
    if backpack and backpack:FindFirstChild(keyTool) then return true end
  end
  return false
end

if prompt then
  prompt.ActionText = promptText
  prompt.Triggered:Connect(function(player)
    if busy then return end
    if not isOpen and not hasKey(player) then
      door:SetAttribute("LastDenied", player.UserId)
      prompt.ActionText = lockedText
      task.delay(1.5, function() if prompt.ActionText == lockedText then prompt.ActionText = promptText end end)
      return
    end
    setOpen(not isOpen)
    if isOpen and autoClose > 0 then
      task.delay(autoClose, function() if isOpen and not busy then setOpen(false) end end)
    end
  end)
end

door:GetAttributeChangedSignal("RequestOpen"):Connect(function()
  local want = door:GetAttribute("RequestOpen")
  if want ~= nil and want ~= isOpen then setOpen(want == true) end
end)
]==])

waypoint("TotalScript: keycard_door_system " .. door.Name)
return {
  door = door:GetFullName(), parts = parts, motion = motion, axis = axis, distance = distance,
  key = (door:GetAttribute("KeyTool") ~= "" and ("Tool '" .. door:GetAttribute("KeyTool") .. "'")) or (door:GetAttribute("KeyAttribute") ~= "" and ("player attribute " .. door:GetAttribute("KeyAttribute"))) or "none",
  api = "door:SetAttribute('RequestOpen', true) opens it from any script; door:GetAttribute('Open') is the live state.",
  note = "All door parts were anchored (a tweened door must be). No sound is attached - add a Sound to the door and play it on the Open attribute if you want one.",
}
`,
  };

  // ── 4. dialogue_tree_system ──────────────────────────────────────────────
  const DIALOGUE = {
    kind: "skill", name: "dialogue_tree_system", title: "Dialogue Tree System",
    description: "Branching NPC dialogue with a styled on-screen panel: speaker name, typewriter text, choice buttons, Esc to leave. The tree is a ModuleScript (ReplicatedStorage.Dialogue.Trees.<Name>) you can edit; choices may carry an action string that is validated on the server and fired to ServerScriptService.DialogueServer.OnAction (BindableEvent) for your quests / shops. A demo tree is installed when none is given.",
    tags: ["npc", "dialogue", "ui", "quests"], triggers: ["dialogue", "npc talk", "conversation", "dialog tree", "quest giver", "talk to npc"],
    expert: "ui_ux", version: 1,
    usage: 'dialogue_tree_system {npc:"Workspace.Merchant", title:"Merchant", tree:{start:"hi", nodes:{hi:{text:"Welcome!", choices:[{text:"Bye", next:null}]}}}}',
    params: [
      { name: "npc", type: "string", required: true, description: "Path to the NPC Model (or any Part) that gets the Talk prompt" },
      { name: "title", type: "string", required: false, default: "", description: "Speaker name shown in the panel (default: the NPC's name)" },
      { name: "tree", type: "object", required: false, description: "{start:'nodeId', nodes:{id:{speaker?, text, choices:[{text, next (node id or null to end), action?}]}}} - omit for a demo tree" },
      { name: "typewriter_speed", type: "number", required: false, default: 40, description: "Characters per second (0 = instant)" },
      { name: "accent", type: "string", required: false, default: "#22D3EE", description: "Hex accent colour" },
      { name: "prompt_text", type: "string", required: false, default: "Talk" },
    ],
    references: [ref("Proximity prompts", "ui/proximity-prompts"), ref("Rich text", "ui/rich-text"), ref("Remote events", "scripting/events/remote"), ref("UI animation", "ui/animation")],
    knowledge: String.raw`## When to use
- NPC conversations, quest givers, branching dialogue with choices - "talk to the NPC", "dialog tree".

## Before running
- Needs the NPC path (Model or Part). Without a tree param a demo tree is installed so the user can see the UI immediately.
- A real tree is {start, nodes:{id:{speaker?, text, choices:[{text, next, action?}]}}}; keep ids short, end a branch with next = null.

## After running
- Trees live as ModuleScripts under ReplicatedStorage.Dialogue.Trees (one per NPC) - editable in Studio. Accent and TypewriterSpeed are Attributes on the folder.
- Choice actions reach the server through ReplicatedStorage.Dialogue.Action and ServerScriptService.DialogueServer's OnAction BindableEvent - wire quests there.`,
    verify: { note: "Dialogue folder/remote/tree module + server/client, NPC prompt wired", luau: String.raw`local folder = find("ReplicatedStorage.Dialogue")
check(folder, "ReplicatedStorage.Dialogue missing")
check(folder:FindFirstChild("Action") and folder.Action:IsA("RemoteEvent"), "Action RemoteEvent missing")
local trees = folder:FindFirstChild("Trees")
check(trees and trees:FindFirstChildOfClass("ModuleScript"), "no tree ModuleScript under Dialogue.Trees")
check(find("ServerScriptService.DialogueServer"), "DialogueServer missing")
check(find("StarterPlayer.StarterPlayerScripts.DialogueClient"), "DialogueClient missing")
local npc = find(args.npc)
check(npc and npc:GetAttribute("DialogueTree") ~= nil, "NPC has no DialogueTree attribute")
check(npc:FindFirstChild("DialoguePrompt", true), "DialoguePrompt missing on the NPC")
return { ok = true, detail = "tree " .. tostring(npc:GetAttribute("DialogueTree")) .. " wired to " .. npc:GetFullName() }` },
    luau: PRELUDE + String.raw`
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local npc = resolve(args.npc)
if not npc then return { ok = false, error = "npc not found at '" .. tostring(args.npc) .. "'" } end
local promptPart = npc:IsA("BasePart") and npc or (npc:IsA("Model") and (npc.PrimaryPart or npc:FindFirstChild("Head") or npc:FindFirstChild("HumanoidRootPart") or npc:FindFirstChildWhichIsA("BasePart", true)))
if not promptPart then return { ok = false, error = npc:GetFullName() .. " has no BasePart to hold the prompt" } end
local title = tostring(args.title or "")
if title == "" then title = npc.Name end
local treeName = string.gsub(npc.Name, "[^%w_]", "")
if treeName == "" then treeName = "Dialogue" end

local tree = args.tree
if type(tree) ~= "table" then
  tree = {
    start = "greet",
    nodes = {
      greet = { speaker = title, text = "Oh, a traveller! Haven't seen one of those since the bridge fell.", choices = {
        { text = "What happened to the bridge?", next = "bridge" },
        { text = "Do you have anything to trade?", next = "trade" },
        { text = "Just passing through.", next = "bye" } } },
      bridge = { text = "Storm took it last winter. The miller says he can rebuild it... if someone brings him <b>5 planks</b>.", choices = {
        { text = "I'll find the planks.", next = "accept", action = "accept_quest_planks" },
        { text = "Not my problem.", next = "bye" } } },
      accept = { text = "Bless you. The old sawmill north of here should still have some.", choices = { { text = "On my way.", next = nil } } },
      trade = { text = "Only a lantern and some rope. Open the stall and have a look.", choices = {
        { text = "Show me.", next = nil, action = "open_shop" },
        { text = "Maybe later.", next = "bye" } } },
      bye = { text = "Safe roads, traveller.", choices = {} },
    },
  }
end
if type(tree.nodes) ~= "table" or type(tree.start) ~= "string" or tree.nodes[tree.start] == nil then
  return { ok = false, error = "tree must be {start:'id', nodes:{id:{text, choices:[{text,next,action?}]}}} and nodes[start] must exist" }
end
local warnings, nodeCount = {}, 0
for id, node in pairs(tree.nodes) do
  nodeCount = nodeCount + 1
  if type(node.text) ~= "string" or node.text == "" then table.insert(warnings, "node '" .. tostring(id) .. "' has no text") end
  for i, c in ipairs(node.choices or {}) do
    if type(c.text) ~= "string" then table.insert(warnings, "node '" .. tostring(id) .. "' choice " .. i .. " has no text") end
    if c.next ~= nil and tree.nodes[c.next] == nil then table.insert(warnings, "node '" .. tostring(id) .. "' choice " .. i .. " points at unknown node '" .. tostring(c.next) .. "'") end
  end
end

local folder = ensure(ReplicatedStorage, "Folder", "Dialogue")
ensure(folder, "RemoteEvent", "Action")
local trees = ensure(folder, "Folder", "Trees")
folder:SetAttribute("Accent", hexColor(args.accent, Color3.fromRGB(34, 211, 238)))
folder:SetAttribute("TypewriterSpeed", num(args.typewriter_speed, 40, 0, 400))
folder:SetAttribute("Version", "2.20.0")
local json = HttpService:JSONEncode(tree)
local mod = setSource(trees, "ModuleScript", treeName, "-- Dialogue tree for " .. title .. " (edit freely; choices: {text, next = node id or nil to end, action = optional string sent to the server})\nlocal HttpService = game:GetService(\"HttpService\")\nreturn HttpService:JSONDecode([=====[" .. json .. "]=====])\n")
mod:SetAttribute("NPC", npc:GetFullName())
mod:SetAttribute("Title", title)

local prompt = ensure(promptPart, "ProximityPrompt", "DialoguePrompt")
prompt.ActionText = tostring(args.prompt_text or "Talk")
prompt.ObjectText = title
prompt.HoldDuration = 0
prompt.MaxActivationDistance = 10
prompt.RequiresLineOfSight = false
prompt:SetAttribute("DialogueTree", treeName)
npc:SetAttribute("DialogueTree", treeName)

setSource(ServerScriptService, "Script", "DialogueServer", [==[
-- Dialogue Tree System (TotalScript featured skill) - server side.
-- Validates choice actions against the tree and the player's distance, then fires
-- script.OnAction (BindableEvent) with (player, treeName, nodeId, action) for your own scripts.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local folder = ReplicatedStorage:WaitForChild("Dialogue")
local remote = folder:WaitForChild("Action")
local trees = folder:WaitForChild("Trees")
local bind = script:FindFirstChild("OnAction")
if not bind then bind = Instance.new("BindableEvent") bind.Name = "OnAction" bind.Parent = script end
local lastAt = {}

local function resolvePath(path)
  local cur = game
  for seg in string.gmatch(path or "", "[^%.]+") do
    if cur then
      if cur == game and seg == "Workspace" then cur = workspace else cur = cur:FindFirstChild(seg) end
    end
  end
  if cur == game then return nil end
  return cur
end

remote.OnServerEvent:Connect(function(player, treeName, nodeId, action)
  if type(treeName) ~= "string" or type(nodeId) ~= "string" or type(action) ~= "string" then return end
  local now = os.clock()
  if lastAt[player] and now - lastAt[player] < 0.2 then return end
  lastAt[player] = now
  local mod = trees:FindFirstChild(treeName)
  if not mod or not mod:IsA("ModuleScript") then return end
  local ok, tree = pcall(require, mod)
  if not ok or type(tree) ~= "table" or type(tree.nodes) ~= "table" then return end
  local node = tree.nodes[nodeId]
  if type(node) ~= "table" then return end
  local valid = false
  for _, c in ipairs(node.choices or {}) do if type(c) == "table" and c.action == action then valid = true end end
  if not valid then return end
  local npc = resolvePath(mod:GetAttribute("NPC"))
  local ch = player.Character
  local hrp = ch and ch:FindFirstChild("HumanoidRootPart")
  if npc and hrp then
    local pos = npc:IsA("Model") and npc:GetPivot().Position or (npc:IsA("BasePart") and npc.Position)
    if pos and (pos - hrp.Position).Magnitude > 25 then return end
  end
  player:SetAttribute("LastDialogueAction", treeName .. ":" .. nodeId .. ":" .. action)
  bind:Fire(player, treeName, nodeId, action)
end)
Players.PlayerRemoving:Connect(function(p) lastAt[p] = nil end)
]==])

setSource(StarterPlayerScripts, "LocalScript", "DialogueClient", [==[
-- Dialogue Tree System (TotalScript featured skill) - client side UI.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ProximityPromptService = game:GetService("ProximityPromptService")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")
local folder = ReplicatedStorage:WaitForChild("Dialogue")
local trees = folder:WaitForChild("Trees")
local remote = folder:WaitForChild("Action")
local accent = folder:GetAttribute("Accent") or Color3.fromRGB(34, 211, 238)
local cps = folder:GetAttribute("TypewriterSpeed") or 40
local player = Players.LocalPlayer

local gui = Instance.new("ScreenGui")
gui.Name = "DialogueUI"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.DisplayOrder = 50
gui.Enabled = false
gui.Parent = player:WaitForChild("PlayerGui")

local function corner(inst, r) local c = Instance.new("UICorner") c.CornerRadius = UDim.new(0, r) c.Parent = inst return c end
local function stroke(inst, color, transparency, thickness) local s = Instance.new("UIStroke") s.Color = color s.Transparency = transparency s.Thickness = thickness s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border s.Parent = inst return s end
local function padding(inst, px) local p = Instance.new("UIPadding") p.PaddingTop = UDim.new(0, px) p.PaddingBottom = UDim.new(0, px) p.PaddingLeft = UDim.new(0, px + 4) p.PaddingRight = UDim.new(0, px + 4) p.Parent = inst return p end

local panel = Instance.new("Frame")
panel.Name = "Panel"
panel.AnchorPoint = Vector2.new(0.5, 1)
panel.Position = UDim2.new(0.5, 0, 1, -28)
panel.Size = UDim2.new(0.56, 0, 0, 0)
panel.AutomaticSize = Enum.AutomaticSize.Y
panel.BackgroundColor3 = Color3.fromRGB(14, 16, 22)
panel.BackgroundTransparency = 0.06
panel.BorderSizePixel = 0
panel.Parent = gui
corner(panel, 14)
stroke(panel, accent, 0.45, 2)
padding(panel, 14)
local sizeLimit = Instance.new("UISizeConstraint")
sizeLimit.MinSize = Vector2.new(320, 0)
sizeLimit.MaxSize = Vector2.new(760, 10000)
sizeLimit.Parent = panel
local list = Instance.new("UIListLayout")
list.SortOrder = Enum.SortOrder.LayoutOrder
list.Padding = UDim.new(0, 10)
list.Parent = panel

local nameTag = Instance.new("TextLabel")
nameTag.LayoutOrder = 1
nameTag.BackgroundTransparency = 1
nameTag.Size = UDim2.new(1, 0, 0, 20)
nameTag.Font = Enum.Font.GothamBold
nameTag.TextSize = 17
nameTag.TextXAlignment = Enum.TextXAlignment.Left
nameTag.TextColor3 = accent
nameTag.Parent = panel

local body = Instance.new("TextLabel")
body.LayoutOrder = 2
body.BackgroundTransparency = 1
body.Size = UDim2.new(1, 0, 0, 0)
body.AutomaticSize = Enum.AutomaticSize.Y
body.Font = Enum.Font.Gotham
body.TextSize = 19
body.TextWrapped = true
body.RichText = true
body.TextXAlignment = Enum.TextXAlignment.Left
body.TextYAlignment = Enum.TextYAlignment.Top
body.TextColor3 = Color3.fromRGB(240, 242, 248)
body.Parent = panel

local choices = Instance.new("Frame")
choices.LayoutOrder = 3
choices.BackgroundTransparency = 1
choices.Size = UDim2.new(1, 0, 0, 0)
choices.AutomaticSize = Enum.AutomaticSize.Y
choices.Parent = panel
local choiceList = Instance.new("UIListLayout")
choiceList.SortOrder = Enum.SortOrder.LayoutOrder
choiceList.Padding = UDim.new(0, 6)
choiceList.Parent = choices

local hint = Instance.new("TextLabel")
hint.LayoutOrder = 4
hint.BackgroundTransparency = 1
hint.Size = UDim2.new(1, 0, 0, 14)
hint.Font = Enum.Font.Gotham
hint.TextSize = 12
hint.TextXAlignment = Enum.TextXAlignment.Right
hint.TextColor3 = Color3.fromRGB(150, 156, 170)
hint.Text = "click a choice  -  Esc to leave"
hint.Parent = panel

local session = 0
local talking = false
local fullText = ""
local typing = false

local function stopTyping() typing = false body.Text = fullText end

local function typewrite(text, mySession)
  fullText = text
  if cps <= 0 then body.Text = text return end
  typing = true
  local shown = ""
  for _, code in utf8.codes(text) do
    if session ~= mySession or not typing then break end
    shown = shown .. utf8.char(code)
    body.Text = shown
    task.wait(1 / cps)
  end
  if session == mySession then body.Text = text end
  typing = false
end

local function clearChoices() for _, c in ipairs(choices:GetChildren()) do if c:IsA("GuiButton") then c:Destroy() end end end

local function close()
  talking = false
  session = session + 1
  clearChoices()
  TweenService:Create(panel, TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.In), { Position = UDim2.new(0.5, 0, 1, 40) }):Play()
  task.delay(0.2, function() if not talking then gui.Enabled = false end end)
end

local showNode
local function addChoice(order, text, onClick)
  local b = Instance.new("TextButton")
  b.LayoutOrder = order
  b.AutoButtonColor = false
  b.Size = UDim2.new(1, 0, 0, 34)
  b.BackgroundColor3 = Color3.fromRGB(28, 32, 42)
  b.BorderSizePixel = 0
  b.Font = Enum.Font.GothamMedium
  b.TextSize = 16
  b.TextXAlignment = Enum.TextXAlignment.Left
  b.TextColor3 = Color3.fromRGB(230, 234, 242)
  b.Text = "   " .. tostring(order) .. ".  " .. text
  b.Parent = choices
  corner(b, 8)
  local s = stroke(b, accent, 0.8, 1)
  b.MouseEnter:Connect(function() TweenService:Create(b, TweenInfo.new(0.12), { BackgroundColor3 = Color3.fromRGB(38, 44, 58) }):Play() s.Transparency = 0.2 end)
  b.MouseLeave:Connect(function() TweenService:Create(b, TweenInfo.new(0.12), { BackgroundColor3 = Color3.fromRGB(28, 32, 42) }):Play() s.Transparency = 0.8 end)
  b.Activated:Connect(function()
    if typing then stopTyping() return end
    onClick()
  end)
end

showNode = function(tree, treeName, nodeId, defaultSpeaker)
  local node = tree.nodes[nodeId]
  if not node then close() return end
  session = session + 1
  local mySession = session
  clearChoices()
  nameTag.Text = tostring(node.speaker or defaultSpeaker or "")
  local list2 = node.choices or {}
  if #list2 == 0 then
    addChoice(1, node.next and "Continue" or "Leave", function()
      if node.next then showNode(tree, treeName, node.next, defaultSpeaker) else close() end
    end)
  else
    for i, c in ipairs(list2) do
      addChoice(i, tostring(c.text or "..."), function()
        if type(c.action) == "string" and c.action ~= "" then remote:FireServer(treeName, nodeId, c.action) end
        if c.next then showNode(tree, treeName, c.next, defaultSpeaker) else close() end
      end)
    end
  end
  task.spawn(typewrite, tostring(node.text or ""), mySession)
end

local function start(treeName)
  local mod = trees:FindFirstChild(treeName)
  if not mod then return end
  local ok, tree = pcall(require, mod)
  if not ok or type(tree) ~= "table" or type(tree.nodes) ~= "table" then return end
  talking = true
  gui.Enabled = true
  panel.Position = UDim2.new(0.5, 0, 1, 40)
  TweenService:Create(panel, TweenInfo.new(0.22, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Position = UDim2.new(0.5, 0, 1, -28) }):Play()
  showNode(tree, treeName, tree.start, mod:GetAttribute("Title") or treeName)
end

ProximityPromptService.PromptTriggered:Connect(function(prompt, plr)
  if plr ~= player then return end
  local treeName = prompt:GetAttribute("DialogueTree")
  if treeName and not talking then start(treeName) end
end)
UserInputService.InputBegan:Connect(function(input, processed)
  if talking and input.KeyCode == Enum.KeyCode.Escape then close() end
end)
]==])

waypoint("TotalScript: dialogue_tree_system " .. npc.Name)
return {
  npc = npc:GetFullName(), tree = trees:GetFullName() .. "." .. treeName, nodes = nodeCount, start = tree.start, warnings = warnings,
  installed = { "ReplicatedStorage.Dialogue (Action RemoteEvent, Trees folder, attributes Accent / TypewriterSpeed)", "ServerScriptService.DialogueServer (+ OnAction BindableEvent for your scripts)", "StarterPlayer.StarterPlayerScripts.DialogueClient", promptPart:GetFullName() .. ".DialoguePrompt" },
  hook = "Connect ServerScriptService.DialogueServer.OnAction.Event:Connect(function(player, treeName, nodeId, action) ... end) to react to choice actions (e.g. accept_quest_planks, open_shop).",
  test = "Press Play, walk to the NPC, press E: the panel types the first node; choices branch; Esc leaves.",
}
`,
  };

  // ── 5. collectible_spawner ───────────────────────────────────────────────
  const COLLECTIBLES = {
    kind: "skill", name: "collectible_spawner", title: "Collectible Spawner",
    description: "Spawns spinning, bobbing collectibles (coins / gems / orbs) across an area, awards a leaderstat on touch (server-authoritative, one pickup per part), plays a sparkle burst + shrink tween, and respawns each one elsewhere after a delay. Installs the template in ServerStorage.Collectibles, a server Script and a client LocalScript that animates only nearby pieces.",
    tags: ["collectibles", "coins", "pickups", "leaderstats", "economy"], triggers: ["coins", "collectibles", "pickups", "gems", "orbs", "spawn coins", "collect"],
    expert: "gameplay_systems", version: 1,
    usage: 'collectible_spawner {name:"Coin", count:24, area:"Workspace.CoinZone", stat:"Coins", value:1, respawn:15}',
    params: [
      { name: "name", type: "string", required: false, default: "Coin", description: "Collectible name (also the leaderstat default)" },
      { name: "count", type: "number", required: false, default: 20, description: "How many exist at once (1-200)" },
      { name: "area", type: "string", required: false, default: "", description: "Path to a Part whose footprint is the spawn area (pieces land on whatever is under it)" },
      { name: "center", type: "string", required: false, default: "", description: "Without an area: Part/Model the spawn circle is centred on (default: the first SpawnLocation or the origin)" },
      { name: "radius", type: "number", required: false, default: 40, description: "Spawn circle radius when no area is given" },
      { name: "stat", type: "string", required: false, default: "", description: "leaderstats name to add to (default: name + 's', e.g. Coins); created if missing" },
      { name: "value", type: "number", required: false, default: 1, description: "Amount per pickup" },
      { name: "respawn", type: "number", required: false, default: 15, description: "Seconds until a collected piece respawns (0 = never)" },
      { name: "shape", type: "string", required: false, default: "coin", enum: ["coin", "gem", "orb"] },
      { name: "color", type: "string", required: false, default: "#FFC83D", description: "Hex colour" },
    ],
    references: [ref("Leaderboards", "players/leaderboards"), ref("CollectionService", "reference/engine/classes/CollectionService"), ref("Particle emitters", "effects/particle-emitters"), ref("Raycasting", "workspace/raycasting")],
    knowledge: String.raw`## When to use
- Coins / gems / orbs scattered in an area that add to a leaderstat and respawn - "spawn 20 coins", "collectibles".

## Before running
- area (a Part footprint) gives the best placement; otherwise a circle around center / the first SpawnLocation. Pieces are raycast onto whatever is under them.
- count 1-200. The leaderstat (stat) is created if missing.

## After running
- Workspace.Collectibles holds the live pieces (Attributes Count / Respawn / Stat / Radius); ServerStorage.Collectibles keeps the template - restyle it and re-run.
- Tell the user to Playtest: touching a piece increments the stat, respawn after \`respawn\` seconds (0 = never).`,
    verify: { note: "template, Workspace.Collectibles with Count/Stat, server + client", luau: String.raw`local store = find("ServerStorage.Collectibles")
check(store and store:FindFirstChildWhichIsA("BasePart", true), "template missing under ServerStorage.Collectibles")
local folder = find("Workspace.Collectibles")
check(folder, "Workspace.Collectibles missing")
check(folder:GetAttribute("Count") ~= nil and folder:GetAttribute("Stat") ~= nil, "Count / Stat attributes missing")
check(find("ServerScriptService.CollectibleServer"), "CollectibleServer missing")
check(find("StarterPlayer.StarterPlayerScripts.CollectibleClient"), "CollectibleClient missing")
return { ok = true, detail = tostring(folder:GetAttribute("Count")) .. " x " .. tostring(folder:GetAttribute("Template")) .. " -> leaderstat " .. tostring(folder:GetAttribute("Stat")) }` },
    luau: PRELUDE + String.raw`
local ServerStorage = game:GetService("ServerStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local name = string.gsub(tostring(args.name or "Coin"), "[^%w_ ]", "")
if name == "" then name = "Coin" end
local stat = tostring(args.stat or "")
if stat == "" then stat = name .. "s" end
local area = nil
if args.area and args.area ~= "" then
  area = resolve(args.area)
  if not area or not area:IsA("BasePart") then return { ok = false, error = "area must be the path of a Part (got '" .. tostring(args.area) .. "')" } end
end
local center = nil
if args.center and args.center ~= "" then
  center = resolve(args.center)
  if not center then return { ok = false, error = "center not found at '" .. tostring(args.center) .. "'" } end
end
if not area and not center then
  for _, d in ipairs(workspace:GetDescendants()) do if d:IsA("SpawnLocation") then center = d break end end
end
local shape = tostring(args.shape or "coin")
local color = hexColor(args.color, Color3.fromRGB(255, 200, 61))

local store = ensure(ServerStorage, "Folder", "Collectibles")
local old = store:FindFirstChild(name .. "Template") if old then old:Destroy() end
local template = Instance.new("Part")
template.Name = name .. "Template"
template.Material = Enum.Material.Neon
template.Color = color
template.Anchored = true
template.CanCollide = false
template.CanQuery = false
template.CastShadow = false
template.TopSurface = Enum.SurfaceType.Smooth
template.BottomSurface = Enum.SurfaceType.Smooth
if shape == "coin" then
  template.Shape = Enum.PartType.Cylinder
  template.Size = Vector3.new(0.35, 2.2, 2.2)
  template.Material = Enum.Material.Metal
  template.CFrame = CFrame.new(0, 0, 0) * CFrame.Angles(0, 0, math.rad(90)) * CFrame.Angles(math.rad(90), 0, 0)
elseif shape == "gem" then
  template.Shape = Enum.PartType.Block
  template.Size = Vector3.new(1.4, 1.4, 1.4)
  template.CFrame = CFrame.new(0, 0, 0) * CFrame.Angles(math.rad(45), 0, math.rad(45))
else
  template.Shape = Enum.PartType.Ball
  template.Size = Vector3.new(1.6, 1.6, 1.6)
end
template:SetAttribute("Value", num(args.value, 1, 0, 1000000))
local light = Instance.new("PointLight") light.Color = color light.Brightness = 1.2 light.Range = 8 light.Parent = template
local sparkle = Instance.new("ParticleEmitter")
sparkle.Name = "Sparkle"
sparkle.Enabled = false
sparkle.Rate = 0
sparkle.Lifetime = NumberRange.new(0.35, 0.7)
sparkle.Speed = NumberRange.new(6, 12)
sparkle.SpreadAngle = Vector2.new(180, 180)
sparkle.Color = ColorSequence.new(color)
sparkle.Size = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.5), NumberSequenceKeypoint.new(1, 0) })
sparkle.Transparency = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0), NumberSequenceKeypoint.new(1, 1) })
sparkle.LightEmission = 1
sparkle.Parent = template
local pickupSound = Instance.new("Sound") pickupSound.Name = "Pickup" pickupSound.SoundId = "" pickupSound.Volume = 0.6 pickupSound.Parent = template
template.Parent = store

local folder = ensure(workspace, "Folder", "Collectibles")
folder:ClearAllChildren()
folder:SetAttribute("Template", template.Name)
folder:SetAttribute("Count", math.floor(num(args.count, 20, 1, 200)))
folder:SetAttribute("Respawn", num(args.respawn, 15, 0, 86400))
folder:SetAttribute("Stat", stat)
folder:SetAttribute("Radius", num(args.radius, 40, 2, 2000))
folder:SetAttribute("AreaPath", area and area:GetFullName() or "")
folder:SetAttribute("CenterPath", center and center:GetFullName() or "")
folder:SetAttribute("Version", "2.20.0")

setSource(ServerScriptService, "Script", "CollectibleServer", [==[
-- Collectible Spawner (TotalScript featured skill) - server side.
-- Spawns pieces on the ground inside the area / circle, awards the leaderstat once per piece, respawns.
local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")
local ServerStorage = game:GetService("ServerStorage")
local TweenService = game:GetService("TweenService")
local folder = workspace:WaitForChild("Collectibles")
local template = ServerStorage:WaitForChild("Collectibles"):WaitForChild(folder:GetAttribute("Template"))
local COUNT = folder:GetAttribute("Count") or 20
local RESPAWN = folder:GetAttribute("Respawn") or 15
local STAT = folder:GetAttribute("Stat") or "Coins"
local RADIUS = folder:GetAttribute("Radius") or 40
local rng = Random.new()

local function resolvePath(path)
  local cur = game
  for seg in string.gmatch(path or "", "[^%.]+") do
    if cur then
      if cur == game and seg == "Workspace" then cur = workspace else cur = cur:FindFirstChild(seg) end
    end
  end
  if cur == game then return nil end
  return cur
end
local area = resolvePath(folder:GetAttribute("AreaPath"))
local center = resolvePath(folder:GetAttribute("CenterPath"))

local function ensureStat(player)
  local ls = player:FindFirstChild("leaderstats")
  if not ls then ls = Instance.new("Folder") ls.Name = "leaderstats" ls.Parent = player end
  local v = ls:FindFirstChild(STAT)
  if not v then v = Instance.new("IntValue") v.Name = STAT v.Parent = ls end
  return v
end
Players.PlayerAdded:Connect(ensureStat)
for _, p in ipairs(Players:GetPlayers()) do ensureStat(p) end

local rayParams = RaycastParams.new()
rayParams.FilterType = Enum.RaycastFilterType.Exclude
rayParams.FilterDescendantsInstances = { folder }
local function randomPosition()
  local origin, halfX, halfZ, top
  if area and area:IsA("BasePart") then
    origin = area.Position
    halfX, halfZ = area.Size.X / 2, area.Size.Z / 2
    top = area.Position.Y + area.Size.Y / 2 + 60
  else
    local c = Vector3.new(0, 10, 0)
    if center and center:IsA("BasePart") then c = center.Position elseif center and center:IsA("Model") then c = center:GetPivot().Position end
    origin = c
    halfX, halfZ = RADIUS, RADIUS
    top = c.Y + 80
  end
  local x = origin.X + rng:NextNumber(-halfX, halfX)
  local z = origin.Z + rng:NextNumber(-halfZ, halfZ)
  local hit = workspace:Raycast(Vector3.new(x, top, z), Vector3.new(0, -500, 0), rayParams)
  local y = origin.Y + 2.5
  if hit then y = hit.Position.Y + 2.5 end
  return Vector3.new(x, y, z)
end

local spawnOne
local function collect(part, player)
  if part:GetAttribute("Taken") then return end
  part:SetAttribute("Taken", true)
  part.CanTouch = false
  local stat = ensureStat(player)
  stat.Value = stat.Value + (part:GetAttribute("Value") or 1)
  local fx = part:FindFirstChild("Sparkle")
  if fx then fx:Emit(14) end
  local snd = part:FindFirstChild("Pickup")
  if snd and snd.SoundId ~= "" then snd:Play() end
  TweenService:Create(part, TweenInfo.new(0.25, Enum.EasingStyle.Back, Enum.EasingDirection.In), { Size = part.Size * 0.05, Transparency = 1 }):Play()
  task.delay(0.4, function() part:Destroy() end)
  if RESPAWN > 0 then task.delay(RESPAWN, spawnOne) end
end

spawnOne = function()
  local part = template:Clone()
  part.Name = string.gsub(template.Name, "Template$", "")
  part.Position = randomPosition()
  part:SetAttribute("Taken", false)
  CollectionService:AddTag(part, "Collectible")
  part.Parent = folder
  part.Touched:Connect(function(hit)
    local ch = hit.Parent
    local player = ch and Players:GetPlayerFromCharacter(ch)
    if not player then return end
    local hum = ch:FindFirstChildOfClass("Humanoid")
    if not hum or hum.Health <= 0 then return end
    collect(part, player)
  end)
end

for _ = 1, COUNT do spawnOne() end
]==])

setSource(StarterPlayerScripts, "LocalScript", "CollectibleClient", [==[
-- Collectible Spawner (TotalScript featured skill) - client side spin + bob (nearby pieces only).
local CollectionService = game:GetService("CollectionService")
local RunService = game:GetService("RunService")
local active = {}
local function add(p) if p:IsA("BasePart") then active[p] = { base = p.CFrame, phase = math.random() * 6.28 } end end
local function remove(p) active[p] = nil end
for _, p in ipairs(CollectionService:GetTagged("Collectible")) do add(p) end
CollectionService:GetInstanceAddedSignal("Collectible"):Connect(add)
CollectionService:GetInstanceRemovedSignal("Collectible"):Connect(remove)
local t = 0
RunService.Heartbeat:Connect(function(dt)
  t = t + dt
  local cam = workspace.CurrentCamera
  local camPos = cam and cam.CFrame.Position
  for p, s in pairs(active) do
    if not p.Parent then
      active[p] = nil
    elseif p:GetAttribute("Taken") ~= true then
      local pos = s.base.Position
      if not camPos or (pos - camPos).Magnitude < 250 then
        local rot = s.base - pos
        local bob = math.sin(t * 2 + s.phase) * 0.35
        p.CFrame = CFrame.new(pos + Vector3.new(0, bob, 0)) * CFrame.Angles(0, t * 2 + s.phase, 0) * rot
      end
    end
  end
end)
]==])

waypoint("TotalScript: collectible_spawner " .. name)
return {
  name = name, stat = stat, count = folder:GetAttribute("Count"), respawn = folder:GetAttribute("Respawn"), shape = shape,
  area = area and area:GetFullName() or ("circle r=" .. tostring(folder:GetAttribute("Radius")) .. " around " .. (center and center:GetFullName() or "the origin")),
  installed = { "ServerStorage.Collectibles." .. template.Name, "Workspace.Collectibles (spawned at Play; attributes Count / Respawn / Stat / Radius / AreaPath)", "ServerScriptService.CollectibleServer", "StarterPlayer.StarterPlayerScripts.CollectibleClient" },
  note = "Pieces appear when the game runs (press Play). The Pickup Sound has an empty SoundId on purpose - set one you own to hear it.",
}
`,
  };

  // ── 6. zone_system ───────────────────────────────────────────────────────
  const ZONES = {
    kind: "skill", name: "zone_system", title: "Zone System",
    description: "Makes a Part (or every Part in a Folder/Model) a gameplay zone: safe (ForceField + InSafeZone attribute), damage / heal per second, speed or jump boost while inside (restored on exit), message banner, or kill. One shared server loop (GetPartBoundsInBox per tick) handles every tagged zone; enter / leave are tracked per player; the client shows the banner. Call it once per zone kind.",
    tags: ["zones", "areas", "safe zone", "damage", "world"], triggers: ["safe zone", "kill zone", "lava", "speed zone", "heal zone", "area trigger", "region"],
    expert: "gameplay_systems", version: 1,
    usage: 'zone_system {zone:"Workspace.Lobby.SafeArea", kind:"safe", message:"Safe zone"} / {zone:"Workspace.Lava", kind:"damage", amount:20}',
    params: [
      { name: "zone", type: "string", required: true, description: "Path to a Part, or a Folder / Model whose Parts all become zones" },
      { name: "kind", type: "string", required: true, enum: ["safe", "damage", "heal", "speed", "jump", "message", "kill"] },
      { name: "amount", type: "number", required: false, default: 0, description: "damage/heal per second, WalkSpeed for speed, JumpPower for jump (defaults: 20 / 10 / 32 / 100)" },
      { name: "message", type: "string", required: false, default: "", description: "Banner shown on entering (optional for every kind)" },
      { name: "tick", type: "number", required: false, default: 0.5, description: "Seconds between zone checks (0.1-2)" },
      { name: "invisible", type: "boolean", required: false, default: false, description: "Make the zone parts fully transparent + non-colliding" },
    ],
    references: [ref("Attributes", "scripting/attributes"), ref("CollectionService", "reference/engine/classes/CollectionService"), ref("Humanoid", "reference/engine/classes/Humanoid"), ref("Remote events", "scripting/events/remote")],
    knowledge: String.raw`## When to use
- Safe zones, lava / kill bricks, heal pads, speed or jump areas, "show a banner when entering the arena".

## Before running
- zone is a Part, or a Folder / Model whose Parts all become zones. kind decides the effect; amount is per second for damage / heal, WalkSpeed for speed, JumpPower for jump.
- invisible:true hides and uncollides the zone parts (good for trigger volumes).

## After running
- Each zone Part carries ZoneKind / ZoneAmount / ZoneMessage Attributes + the tag Zone - change them live. ServerScriptService.ZoneServer.Tick is the check interval.
- Players expose Zone / InSafeZone Attributes while inside - other scripts (PvP toggles, shops) can read them.`,
    verify: { note: "Zones remote, server + client, and at least one tagged Zone part under the target", luau: String.raw`local CollectionService = game:GetService("CollectionService")
check(find("ReplicatedStorage.Zones.Message"), "ReplicatedStorage.Zones.Message missing")
check(find("ServerScriptService.ZoneServer"), "ZoneServer missing")
check(find("StarterPlayer.StarterPlayerScripts.ZoneClient"), "ZoneClient missing")
local target = find(args.zone)
check(target, "zone not found at " .. tostring(args.zone))
local tagged = 0
for _, p in ipairs(CollectionService:GetTagged("Zone")) do if p == target or p:IsDescendantOf(target) then tagged = tagged + 1 end end
check(tagged > 0, "no Part under " .. target:GetFullName() .. " carries the Zone tag")
return { ok = true, detail = tostring(tagged) .. " zone part(s) tagged, kind=" .. tostring(args.kind) }` },
    luau: PRELUDE + String.raw`
local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local target = resolve(args.zone)
if not target then return { ok = false, error = "zone not found at '" .. tostring(args.zone) .. "'" } end
local kind = tostring(args.kind or "")
local defaults = { damage = 20, heal = 10, speed = 32, jump = 100, safe = 0, message = 0, kill = 0 }
if defaults[kind] == nil then return { ok = false, error = "kind must be safe | damage | heal | speed | jump | message | kill" } end
local amount = num(args.amount, 0, 0, 100000)
if amount <= 0 then amount = defaults[kind] end
local message = tostring(args.message or "")
local parts = {}
if target:IsA("BasePart") then table.insert(parts, target)
else for _, p in ipairs(target:GetDescendants()) do if p:IsA("BasePart") then table.insert(parts, p) end end end
if #parts == 0 then return { ok = false, error = target:GetFullName() .. " contains no Parts" } end
for _, p in ipairs(parts) do
  CollectionService:AddTag(p, "Zone")
  p:SetAttribute("ZoneKind", kind)
  p:SetAttribute("ZoneAmount", amount)
  p:SetAttribute("ZoneMessage", message)
  p.Anchored = true
  if args.invisible == true then p.Transparency = 1 p.CanCollide = false end
  if kind ~= "kill" and kind ~= "damage" then p.CanCollide = false end
end

local folder = ensure(ReplicatedStorage, "Folder", "Zones")
ensure(folder, "RemoteEvent", "Message")
folder:SetAttribute("Version", "2.20.0")
local server = setSource(ServerScriptService, "Script", "ZoneServer", [==[
-- Zone System (TotalScript featured skill) - server side.
-- Every Part tagged "Zone" with attributes ZoneKind / ZoneAmount / ZoneMessage is checked each tick.
local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local remote = ReplicatedStorage:WaitForChild("Zones"):WaitForChild("Message")
local TICK = script:GetAttribute("Tick") or 0.5
local inside = {}
local saved = {}

local function humOf(player) local ch = player.Character return ch and ch:FindFirstChildOfClass("Humanoid") end

local function enter(player, zone, kind, amount, message)
  local hum = humOf(player)
  if kind == "safe" then
    player:SetAttribute("InSafeZone", true)
    local ch = player.Character
    if ch and not ch:FindFirstChild("ZoneSafe") then
      local ff = Instance.new("ForceField") ff.Name = "ZoneSafe" ff.Visible = false ff.Parent = ch
    end
  elseif kind == "speed" and hum then
    saved[player] = saved[player] or {}
    if saved[player].WalkSpeed == nil then saved[player].WalkSpeed = hum.WalkSpeed end
    hum.WalkSpeed = amount
  elseif kind == "jump" and hum then
    saved[player] = saved[player] or {}
    if saved[player].JumpPower == nil then
      saved[player].JumpPower = hum.JumpPower
      saved[player].JumpHeight = hum.JumpHeight
      saved[player].UseJumpPower = hum.UseJumpPower
    end
    hum.UseJumpPower = true
    hum.JumpPower = amount
  elseif kind == "kill" and hum then
    hum.Health = 0
  end
  player:SetAttribute("Zone", zone.Name)
  if message ~= "" then remote:FireClient(player, message, kind, true) end
end

local function leave(player, zone, kind)
  local hum = humOf(player)
  local s = saved[player]
  if kind == "safe" then
    player:SetAttribute("InSafeZone", nil)
    local ch = player.Character
    local ff = ch and ch:FindFirstChild("ZoneSafe")
    if ff then ff:Destroy() end
  elseif kind == "speed" and hum and s and s.WalkSpeed ~= nil then
    hum.WalkSpeed = s.WalkSpeed
    s.WalkSpeed = nil
  elseif kind == "jump" and hum and s and s.JumpPower ~= nil then
    hum.UseJumpPower = s.UseJumpPower
    hum.JumpPower = s.JumpPower
    hum.JumpHeight = s.JumpHeight
    s.JumpPower = nil
  end
  if player:GetAttribute("Zone") == zone.Name then player:SetAttribute("Zone", nil) end
  remote:FireClient(player, "", kind, false)
end

local function tickEffects(player, kind, amount)
  local hum = humOf(player)
  if not hum or hum.Health <= 0 then return end
  if kind == "damage" then
    if not player:GetAttribute("InSafeZone") then hum:TakeDamage(amount * TICK) end
  elseif kind == "heal" then
    hum.Health = math.min(hum.MaxHealth, hum.Health + amount * TICK)
  end
end

Players.PlayerRemoving:Connect(function(p) inside[p] = nil saved[p] = nil end)
Players.PlayerAdded:Connect(function(p)
  p.CharacterAdded:Connect(function() inside[p] = nil saved[p] = nil p:SetAttribute("InSafeZone", nil) p:SetAttribute("Zone", nil) end)
end)

local overlap = OverlapParams.new()
overlap.FilterType = Enum.RaycastFilterType.Include
while true do
  task.wait(TICK)
  local chars, byChar = {}, {}
  for _, plr in ipairs(Players:GetPlayers()) do
    if plr.Character then table.insert(chars, plr.Character) byChar[plr.Character] = plr end
  end
  local now = {}
  if #chars > 0 then
    overlap.FilterDescendantsInstances = chars
    for _, zone in ipairs(CollectionService:GetTagged("Zone")) do
      if zone:IsA("BasePart") and zone.Parent then
        local kind = zone:GetAttribute("ZoneKind") or "message"
        local amount = zone:GetAttribute("ZoneAmount") or 0
        local message = zone:GetAttribute("ZoneMessage") or ""
        for _, part in ipairs(workspace:GetPartBoundsInBox(zone.CFrame, zone.Size, overlap)) do
          local model = part:FindFirstAncestorOfClass("Model")
          local plr = model and byChar[model]
          if plr then
            now[plr] = now[plr] or {}
            if not now[plr][zone] then
              now[plr][zone] = true
              inside[plr] = inside[plr] or {}
              if not inside[plr][zone] then
                inside[plr][zone] = true
                enter(plr, zone, kind, amount, message)
              end
              tickEffects(plr, kind, amount)
            end
          end
        end
      end
    end
  end
  for plr, zones in pairs(inside) do
    for zone in pairs(zones) do
      if not (now[plr] and now[plr][zone]) then
        zones[zone] = nil
        if zone.Parent then leave(plr, zone, zone:GetAttribute("ZoneKind") or "message") end
      end
    end
  end
end
]==])
server:SetAttribute("Tick", num(args.tick, 0.5, 0.1, 2))

setSource(StarterPlayerScripts, "LocalScript", "ZoneClient", [==[
-- Zone System (TotalScript featured skill) - client banner.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local remote = ReplicatedStorage:WaitForChild("Zones"):WaitForChild("Message")
local player = Players.LocalPlayer
local colors = { safe = Color3.fromRGB(74, 222, 128), damage = Color3.fromRGB(255, 90, 90), kill = Color3.fromRGB(255, 90, 90), heal = Color3.fromRGB(96, 200, 255), speed = Color3.fromRGB(255, 200, 61), jump = Color3.fromRGB(255, 200, 61), message = Color3.fromRGB(34, 211, 238) }

local gui = Instance.new("ScreenGui")
gui.Name = "ZoneBanner"
gui.ResetOnSpawn = false
gui.DisplayOrder = 40
gui.Parent = player:WaitForChild("PlayerGui")
local banner = Instance.new("TextLabel")
banner.AnchorPoint = Vector2.new(0.5, 0)
banner.Position = UDim2.new(0.5, 0, 0, -60)
banner.Size = UDim2.new(0, 0, 0, 40)
banner.AutomaticSize = Enum.AutomaticSize.X
banner.BackgroundColor3 = Color3.fromRGB(14, 16, 22)
banner.BackgroundTransparency = 0.1
banner.BorderSizePixel = 0
banner.Font = Enum.Font.GothamBold
banner.TextSize = 18
banner.TextColor3 = Color3.fromRGB(240, 242, 248)
banner.Text = ""
banner.Visible = false
banner.Parent = gui
local corner = Instance.new("UICorner") corner.CornerRadius = UDim.new(0, 10) corner.Parent = banner
local pad = Instance.new("UIPadding") pad.PaddingLeft = UDim.new(0, 18) pad.PaddingRight = UDim.new(0, 18) pad.Parent = banner
local stroke = Instance.new("UIStroke") stroke.Thickness = 2 stroke.Transparency = 0.3 stroke.Parent = banner

local shownAt = 0
local function hide(stamp)
  if stamp ~= shownAt then return end
  local tw = TweenService:Create(banner, TweenInfo.new(0.25, Enum.EasingStyle.Quad, Enum.EasingDirection.In), { Position = UDim2.new(0.5, 0, 0, -60) })
  tw:Play()
  tw.Completed:Connect(function() if stamp == shownAt then banner.Visible = false end end)
end
remote.OnClientEvent:Connect(function(message, kind, entering)
  if not entering or message == "" then
    if not entering then hide(shownAt) end
    return
  end
  shownAt = os.clock()
  local stamp = shownAt
  banner.Text = message
  stroke.Color = colors[kind] or colors.message
  banner.Visible = true
  banner.Position = UDim2.new(0.5, 0, 0, -60)
  TweenService:Create(banner, TweenInfo.new(0.3, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Position = UDim2.new(0.5, 0, 0, 24) }):Play()
  task.delay(2.5, function() hide(stamp) end)
end)
]==])

waypoint("TotalScript: zone_system " .. kind)
return {
  zone = target:GetFullName(), parts = #parts, kind = kind, amount = amount, message = message,
  installed = { "ReplicatedStorage.Zones.Message", "ServerScriptService.ZoneServer (attribute Tick)", "StarterPlayer.StarterPlayerScripts.ZoneClient" },
  attributes = "Each zone Part: ZoneKind / ZoneAmount / ZoneMessage (+ tag Zone). Players get InSafeZone and Zone attributes while inside.",
  note = "Call zone_system again for other parts / kinds - the shared scripts are replaced, the tags and attributes on earlier zones stay.",
}
`,
  };

  // ── 7. boss_health_bar ───────────────────────────────────────────────────
  const BOSS_BAR = {
    kind: "skill", name: "boss_health_bar", title: "Boss Health Bar",
    description: "A cinematic top-of-screen boss bar for any Model with a Humanoid: title, phase ticks, smooth fill tween with a white damage-lag ghost bar, colour shifting through phases, hit shake, auto-hide on death, optional show range. Fully client-side (health already replicates), so it costs nothing on the server. Tag more bosses by calling it again.",
    tags: ["boss", "ui", "combat", "health bar"], triggers: ["boss bar", "boss health", "enemy health bar", "raid boss", "boss fight ui"],
    expert: "ui_ux", version: 1,
    usage: 'boss_health_bar {boss:"Workspace.Dragon", title:"ANCIENT DRAGON", phases:3, accent:"#FF4D6D"}',
    params: [
      { name: "boss", type: "string", required: true, description: "Path to the boss Model (needs a Humanoid)" },
      { name: "title", type: "string", required: false, default: "", description: "Name on the bar (default: model name)" },
      { name: "phases", type: "number", required: false, default: 3, description: "Phase segments drawn on the bar (1-10)" },
      { name: "accent", type: "string", required: false, default: "#FF4D6D", description: "Hex colour at full health (shifts towards orange / red as phases drop)" },
      { name: "show_range", type: "number", required: false, default: 0, description: "Only show when the player is within this many studs (0 = always)" },
      { name: "hide_on_death", type: "boolean", required: false, default: true },
    ],
    references: [ref("Humanoid", "reference/engine/classes/Humanoid"), ref("UI animation", "ui/animation"), ref("CollectionService", "reference/engine/classes/CollectionService"), ref("Position and size", "ui/position-and-size")],
    knowledge: String.raw`## When to use
- A big top-of-screen health bar with phase segments for a boss / elite enemy.

## Before running
- The boss Model needs a Humanoid. phases 1-10 draws segments; show_range hides the bar until the player is near.

## After running
- The model is tagged BossBar with BossTitle / BossPhases / BossAccent / BossShowRange / BossHideOnDeath Attributes; one StarterPlayerScripts.BossBarClient serves every tagged boss - tag more models for more bosses.
- Pair it with npc_patrol_chase for a boss that fights back; damage_numbers_pro for hit feedback.`,
    verify: { note: "boss tagged BossBar with title/phases, BossBarClient present", luau: String.raw`local CollectionService = game:GetService("CollectionService")
local boss = find(args.boss)
check(boss, "boss not found at " .. tostring(args.boss))
check(boss:FindFirstChildOfClass("Humanoid"), "boss has no Humanoid")
check(CollectionService:HasTag(boss, "BossBar"), "BossBar tag missing on " .. boss:GetFullName())
check(boss:GetAttribute("BossTitle") ~= nil and boss:GetAttribute("BossPhases") ~= nil, "BossTitle / BossPhases attributes missing")
local client = find("StarterPlayer.StarterPlayerScripts.BossBarClient")
check(client and client:IsA("LocalScript"), "BossBarClient missing")
return { ok = true, detail = tostring(boss:GetAttribute("BossTitle")) .. " / " .. tostring(boss:GetAttribute("BossPhases")) .. " phases" }` },
    luau: PRELUDE + String.raw`
local CollectionService = game:GetService("CollectionService")
local boss = resolve(args.boss)
if not boss then return { ok = false, error = "boss not found at '" .. tostring(args.boss) .. "'" } end
if not boss:IsA("Model") then return { ok = false, error = boss:GetFullName() .. " must be a Model with a Humanoid" } end
local humanoid = boss:FindFirstChildOfClass("Humanoid")
if not humanoid then return { ok = false, error = boss:GetFullName() .. " has no Humanoid - the bar follows Humanoid.Health" } end
local title = tostring(args.title or "")
if title == "" then title = boss.Name end
CollectionService:AddTag(boss, "BossBar")
boss:SetAttribute("BossTitle", title)
boss:SetAttribute("BossPhases", math.floor(num(args.phases, 3, 1, 10)))
boss:SetAttribute("BossAccent", hexColor(args.accent, Color3.fromRGB(255, 77, 109)))
boss:SetAttribute("BossShowRange", num(args.show_range, 0, 0, 100000))
boss:SetAttribute("BossHideOnDeath", args.hide_on_death ~= false)

setSource(StarterPlayerScripts, "LocalScript", "BossBarClient", [==[
-- Boss Health Bar (TotalScript featured skill) - client side. Follows the nearest Model tagged "BossBar".
local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")
local TweenService = game:GetService("TweenService")
local RunService = game:GetService("RunService")
local player = Players.LocalPlayer

local gui = Instance.new("ScreenGui")
gui.Name = "BossBar"
gui.ResetOnSpawn = false
gui.DisplayOrder = 45
gui.Enabled = false
gui.Parent = player:WaitForChild("PlayerGui")

local frame = Instance.new("Frame")
frame.AnchorPoint = Vector2.new(0.5, 0)
frame.Position = UDim2.new(0.5, 0, 0, 18)
frame.Size = UDim2.new(0.5, 0, 0, 54)
frame.BackgroundTransparency = 1
frame.Parent = gui
local limit = Instance.new("UISizeConstraint") limit.MinSize = Vector2.new(320, 54) limit.MaxSize = Vector2.new(820, 54) limit.Parent = frame

local title = Instance.new("TextLabel")
title.BackgroundTransparency = 1
title.Size = UDim2.new(1, 0, 0, 24)
title.Font = Enum.Font.GothamBlack
title.TextSize = 20
title.TextColor3 = Color3.fromRGB(245, 245, 250)
title.TextStrokeTransparency = 0.4
title.Text = ""
title.Parent = frame

local track = Instance.new("Frame")
track.Position = UDim2.new(0, 0, 0, 30)
track.Size = UDim2.new(1, 0, 0, 18)
track.BackgroundColor3 = Color3.fromRGB(18, 18, 24)
track.BorderSizePixel = 0
track.ClipsDescendants = true
track.Parent = frame
local tc = Instance.new("UICorner") tc.CornerRadius = UDim.new(0, 9) tc.Parent = track
local ts = Instance.new("UIStroke") ts.Thickness = 2 ts.Color = Color3.fromRGB(60, 60, 72) ts.Parent = track

local ghost = Instance.new("Frame")
ghost.Size = UDim2.new(1, 0, 1, 0)
ghost.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
ghost.BackgroundTransparency = 0.25
ghost.BorderSizePixel = 0
ghost.ZIndex = 1
ghost.Parent = track
local gc = Instance.new("UICorner") gc.CornerRadius = UDim.new(0, 9) gc.Parent = ghost

local fill = Instance.new("Frame")
fill.Size = UDim2.new(1, 0, 1, 0)
fill.BorderSizePixel = 0
fill.ZIndex = 2
fill.Parent = track
local fc = Instance.new("UICorner") fc.CornerRadius = UDim.new(0, 9) fc.Parent = fill
local grad = Instance.new("UIGradient")
grad.Rotation = 90
grad.Color = ColorSequence.new({ ColorSequenceKeypoint.new(0, Color3.fromRGB(255, 255, 255)), ColorSequenceKeypoint.new(1, Color3.fromRGB(170, 170, 170)) })
grad.Parent = fill

local hp = Instance.new("TextLabel")
hp.BackgroundTransparency = 1
hp.Size = UDim2.new(1, 0, 1, 0)
hp.Font = Enum.Font.GothamBold
hp.TextSize = 12
hp.TextColor3 = Color3.fromRGB(255, 255, 255)
hp.TextStrokeTransparency = 0.3
hp.ZIndex = 4
hp.Parent = track

local ticks = {}
local function drawTicks(n)
  for _, t in ipairs(ticks) do t:Destroy() end
  ticks = {}
  for i = 1, n - 1 do
    local t = Instance.new("Frame")
    t.AnchorPoint = Vector2.new(0.5, 0)
    t.Position = UDim2.new(i / n, 0, 0, 0)
    t.Size = UDim2.new(0, 2, 1, 0)
    t.BackgroundColor3 = Color3.fromRGB(10, 10, 14)
    t.BackgroundTransparency = 0.15
    t.BorderSizePixel = 0
    t.ZIndex = 3
    t.Parent = track
    table.insert(ticks, t)
  end
end

local current, conns = nil, {}
local function disconnectAll() for _, c in ipairs(conns) do c:Disconnect() end conns = {} end

local function phaseColor(accent, frac)
  -- full health = accent; last third = hot orange/red
  local hot = Color3.fromRGB(255, 96, 40)
  if frac > 0.5 then return accent end
  return accent:Lerp(hot, (0.5 - frac) / 0.5)
end

local function bind(model)
  disconnectAll()
  current = model
  if not model then gui.Enabled = false return end
  local hum = model:FindFirstChildOfClass("Humanoid")
  if not hum then gui.Enabled = false current = nil return end
  local accent = model:GetAttribute("BossAccent") or Color3.fromRGB(255, 77, 109)
  local phases = model:GetAttribute("BossPhases") or 3
  local hideOnDeath = model:GetAttribute("BossHideOnDeath") ~= false
  title.Text = string.upper(tostring(model:GetAttribute("BossTitle") or model.Name))
  drawTicks(phases)
  local lastFrac = math.clamp(hum.Health / math.max(1, hum.MaxHealth), 0, 1)
  fill.Size = UDim2.new(lastFrac, 0, 1, 0)
  ghost.Size = UDim2.new(lastFrac, 0, 1, 0)
  fill.BackgroundColor3 = phaseColor(accent, lastFrac)
  hp.Text = math.floor(hum.Health + 0.5) .. " / " .. math.floor(hum.MaxHealth + 0.5)
  gui.Enabled = true
  frame.Position = UDim2.new(0.5, 0, 0, 18)
  local function update()
    local frac = math.clamp(hum.Health / math.max(1, hum.MaxHealth), 0, 1)
    local drop = lastFrac - frac
    lastFrac = frac
    hp.Text = math.floor(hum.Health + 0.5) .. " / " .. math.floor(hum.MaxHealth + 0.5)
    TweenService:Create(fill, TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { Size = UDim2.new(frac, 0, 1, 0), BackgroundColor3 = phaseColor(accent, frac) }):Play()
    task.delay(0.35, function() if current == model then TweenService:Create(ghost, TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { Size = UDim2.new(frac, 0, 1, 0) }):Play() end end)
    if drop >= 0.05 then
      frame.Position = UDim2.new(0.5, 6, 0, 18)
      TweenService:Create(frame, TweenInfo.new(0.3, Enum.EasingStyle.Elastic, Enum.EasingDirection.Out), { Position = UDim2.new(0.5, 0, 0, 18) }):Play()
    end
    if hum.Health <= 0 and hideOnDeath then
      task.delay(1.2, function()
        if current == model then
          TweenService:Create(frame, TweenInfo.new(0.4), { Position = UDim2.new(0.5, 0, 0, -80) }):Play()
          task.delay(0.45, function() if current == model then gui.Enabled = false end end)
        end
      end)
    end
  end
  table.insert(conns, hum.HealthChanged:Connect(update))
  table.insert(conns, hum:GetPropertyChangedSignal("MaxHealth"):Connect(update))
  table.insert(conns, model.AncestryChanged:Connect(function() if not model:IsDescendantOf(workspace) then bind(nil) end end))
end

local function pick()
  local ch = player.Character
  local hrp = ch and ch:FindFirstChild("HumanoidRootPart")
  local best, bestD = nil, math.huge
  for _, model in ipairs(CollectionService:GetTagged("BossBar")) do
    if model:IsA("Model") and model:IsDescendantOf(workspace) then
      local hum = model:FindFirstChildOfClass("Humanoid")
      if hum and hum.Health > 0 then
        local range = model:GetAttribute("BossShowRange") or 0
        local d = 0
        if hrp then d = (model:GetPivot().Position - hrp.Position).Magnitude end
        if range <= 0 or d <= range then
          if d < bestD then best, bestD = model, d end
        end
      end
    end
  end
  if best ~= current then bind(best) end
end

local acc = 0
RunService.Heartbeat:Connect(function(dt)
  acc = acc + dt
  if acc >= 0.5 then acc = 0 pick() end
end)
CollectionService:GetInstanceAddedSignal("BossBar"):Connect(pick)
CollectionService:GetInstanceRemovedSignal("BossBar"):Connect(function(m) if m == current then bind(nil) end pick() end)
pick()
]==])

waypoint("TotalScript: boss_health_bar " .. boss.Name)
return {
  boss = boss:GetFullName(), title = title, phases = boss:GetAttribute("BossPhases"), health = humanoid.MaxHealth,
  installed = { "tag BossBar + attributes BossTitle / BossPhases / BossAccent / BossShowRange / BossHideOnDeath on the model", "StarterPlayer.StarterPlayerScripts.BossBarClient (shared by every tagged boss)" },
  test = "Press Play, damage the boss (humanoid_set or any weapon): the bar drains with a white lag ghost, shakes on big hits and hides on death.",
}
`,
  };

  // ── 8. checkpoint_system ─────────────────────────────────────────────────
  const CHECKPOINTS = {
    kind: "skill", name: "checkpoint_system", title: "Checkpoint System",
    description: "Turns a Folder / Model of parts into a complete obby checkpoint system: numbered stages (from the part names or the folder order), a leaderstat that only moves forward, respawn on top of the last checkpoint, a slide-in 'Checkpoint 3 / 12' banner, reached / next checkpoints recoloured on the client, optional sparkle burst, and a SetStage bindable for other scripts. Progress lives for the session (no DataStore is written - say so if persistence is wanted).",
    tags: ["obby", "checkpoint", "leaderstats", "gameplay"], triggers: ["checkpoint", "checkpoints", "obby stages", "respawn at checkpoint", "stage counter"],
    expert: "gameplay_systems", version: 1,
    usage: 'checkpoint_system {checkpoints:"Workspace.Checkpoints", stat_name:"Stage", celebrate:true}',
    params: [
      { name: "checkpoints", type: "string", required: true, description: "Path to the Folder / Model holding the checkpoint parts (every BasePart inside counts)" },
      { name: "stat_name", type: "string", required: false, default: "Stage", description: "Leaderstat name shown on the player list" },
      { name: "order", type: "string", required: false, default: "name", enum: ["name", "folder"], description: "name = number in the part name (Checkpoint7, CP_7); folder = the order the parts sit in the folder" },
      { name: "respawn_offset", type: "number", required: false, default: 4, description: "Studs above the checkpoint the character spawns at (1-20)" },
      { name: "done_color", type: "string", required: false, default: "#3DDC84", description: "Hex colour of checkpoints already reached (client only)" },
      { name: "next_color", type: "string", required: false, default: "#FFD166", description: "Hex colour of the next checkpoint (client only)" },
      { name: "celebrate", type: "boolean", required: false, default: true, description: "Sparkle burst + banner when a new checkpoint is reached" },
    ],
    references: [ref("Leaderboards", "players/leaderboards"), ref("CollectionService", "reference/engine/classes/CollectionService"), ref("Attributes", "scripting/attributes"), ref("BasePart.Touched", "reference/engine/classes/BasePart#Touched"), ref("Player.CharacterAdded", "reference/engine/classes/Player#CharacterAdded")],
    knowledge: String.raw`## When to use
- Obby / race stages: touch a checkpoint, respawn there, leaderstat Stage, celebration on reaching a new one.

## Before running
- checkpoints is a Folder / Model holding the stage parts; numbered names (1, 2, 3 or Stage1...) define the order, otherwise folder order.

## After running
- Every part gets the tag Checkpoint + a Stage attribute; the holder gets CheckpointSet + StatName / RespawnOffset / DoneColor / NextColor / Celebrate / Total; the server script lives inside the holder, the client in StarterPlayerScripts.
- Other scripts: fire holder.SetStage (BindableEvent) with (player, stage); listen to holder.CheckpointReached.`,
    verify: { note: "holder tagged CheckpointSet with server script, events and staged parts; client present", luau: String.raw`local CollectionService = game:GetService("CollectionService")
local holder = find(args.checkpoints)
check(holder, "holder not found at " .. tostring(args.checkpoints))
check(CollectionService:HasTag(holder, "CheckpointSet"), "CheckpointSet tag missing on the holder")
local server = holder:FindFirstChild("CheckpointServer")
check(server and server:IsA("Script"), "CheckpointServer script missing inside the holder")
check(holder:FindFirstChild("CheckpointReached") and holder:FindFirstChild("SetStage"), "CheckpointReached / SetStage events missing")
local staged = 0
for _, p in ipairs(holder:GetDescendants()) do if p:IsA("BasePart") and p:GetAttribute("Stage") ~= nil then staged = staged + 1 end end
check(staged > 0, "no part under the holder has a Stage attribute")
check(find("StarterPlayer.StarterPlayerScripts.CheckpointClient"), "CheckpointClient missing")
return { ok = true, detail = tostring(staged) .. " stage(s) in " .. holder:GetFullName() }` },
    luau: PRELUDE + String.raw`
local CollectionService = game:GetService("CollectionService")
local ServerScriptService = game:GetService("ServerScriptService")
local holder = resolve(args.checkpoints)
if not holder then return { ok = false, error = "checkpoints not found at '" .. tostring(args.checkpoints) .. "' - give the Folder / Model that holds the checkpoint parts" } end
local parts = {}
for _, d in ipairs(holder:GetDescendants()) do
  if d:IsA("BasePart") then parts[#parts + 1] = d end
end
if holder:IsA("BasePart") then parts[#parts + 1] = holder end
if #parts == 0 then return { ok = false, error = holder:GetFullName() .. " holds no parts - add one Part per checkpoint first (part_create / model_build)" } end

local statName = tostring(args.stat_name or "")
if statName == "" then statName = "Stage" end
local order = tostring(args.order or "name")
local offset = num(args.respawn_offset, 4, 1, 20)
local doneColor = hexColor(args.done_color, Color3.fromRGB(61, 220, 132))
local nextColor = hexColor(args.next_color, Color3.fromRGB(255, 209, 102))
local celebrate = args.celebrate ~= false

-- order the parts: by the number in their name when every part has one, else folder order
local numbered = 0
local keyed = {}
for i, p in ipairs(parts) do
  local n = string.match(p.Name, "(%d+)%s*$")
  if n then numbered = numbered + 1 end
  keyed[i] = { part = p, n = tonumber(n or "0") or 0, i = i }
end
if order == "name" and numbered == #parts then
  table.sort(keyed, function(a, b) if a.n == b.n then return a.i < b.i end return a.n < b.n end)
end
local stages = {}
for _, old in ipairs(CollectionService:GetTagged("Checkpoint")) do
  if old:IsDescendantOf(holder) or old == holder then CollectionService:RemoveTag(old, "Checkpoint") end
end
for idx, k in ipairs(keyed) do
  local p = k.part
  p.Anchored = true
  p:SetAttribute("Stage", idx)
  CollectionService:AddTag(p, "Checkpoint")
  stages[idx] = p.Name
end
holder:SetAttribute("StatName", statName)
holder:SetAttribute("RespawnOffset", offset)
holder:SetAttribute("DoneColor", doneColor)
holder:SetAttribute("NextColor", nextColor)
holder:SetAttribute("Celebrate", celebrate)
holder:SetAttribute("Total", #keyed)
CollectionService:AddTag(holder, "CheckpointSet")

local reached = ensure(holder, "RemoteEvent", "CheckpointReached")
local setStage = ensure(holder, "BindableEvent", "SetStage")

setSource(holder, "Script", "CheckpointServer", [==[
-- Checkpoint System (TotalScript featured skill) - server. Lives inside the checkpoint folder.
local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")
local holder = script.Parent
local statName = holder:GetAttribute("StatName") or "Stage"
local offset = holder:GetAttribute("RespawnOffset") or 4
local reachedEvent = holder:WaitForChild("CheckpointReached")
local setStageEvent = holder:WaitForChild("SetStage")

local byStage = {}
local total = 0
local function index()
  byStage = {}
  total = 0
  for _, p in ipairs(CollectionService:GetTagged("Checkpoint")) do
    if p:IsDescendantOf(holder) or p == holder then
      local s = p:GetAttribute("Stage")
      if s then byStage[s] = p if s > total then total = s end end
    end
  end
  holder:SetAttribute("Total", total)
end
index()

local function statOf(player)
  local ls = player:FindFirstChild("leaderstats")
  if not ls then ls = Instance.new("Folder") ls.Name = "leaderstats" ls.Parent = player end
  local v = ls:FindFirstChild(statName)
  if not v then v = Instance.new("IntValue") v.Name = statName v.Value = 0 v.Parent = ls end
  return v
end

local function placeAt(character, stage)
  local p = byStage[stage]
  if not p or not character then return end
  local root = character:FindFirstChild("HumanoidRootPart") or character.PrimaryPart
  if not root then return end
  local top = p.Position + Vector3.new(0, p.Size.Y / 2 + offset, 0)
  character:PivotTo(CFrame.new(top))
end

local function setStage(player, stage, silent)
  local v = statOf(player)
  stage = math.clamp(math.floor(tonumber(stage) or 0), 0, math.max(total, 0))
  if stage == v.Value then return false end
  v.Value = stage
  player:SetAttribute("Checkpoint", stage)
  if not silent then reachedEvent:FireClient(player, stage, total) end
  return true
end

local lastTouch = {}
local function onTouch(p, hit)
  local character = hit and hit.Parent
  local player = character and Players:GetPlayerFromCharacter(character)
  if not player then return end
  local hum = character:FindFirstChildOfClass("Humanoid")
  if not hum or hum.Health <= 0 then return end
  local stage = p:GetAttribute("Stage")
  if not stage then return end
  local now = os.clock()
  local last = lastTouch[player]
  if last and now - last < 0.25 then return end
  lastTouch[player] = now
  local v = statOf(player)
  if stage > v.Value then setStage(player, stage) end
end

local hooked = {}
local function hook(p)
  if hooked[p] then return end
  hooked[p] = true
  p.Touched:Connect(function(hit) onTouch(p, hit) end)
end
for _, p in pairs(byStage) do hook(p) end
CollectionService:GetInstanceAddedSignal("Checkpoint"):Connect(function(p) index() if p:IsDescendantOf(holder) then hook(p) end end)
CollectionService:GetInstanceRemovedSignal("Checkpoint"):Connect(index)

Players.PlayerAdded:Connect(function(player)
  statOf(player)
  player.CharacterAdded:Connect(function(character)
    local v = statOf(player)
    if v.Value > 0 then
      task.wait(0.1)
      placeAt(character, v.Value)
    end
  end)
end)
for _, player in ipairs(Players:GetPlayers()) do statOf(player) end
Players.PlayerRemoving:Connect(function(player) lastTouch[player] = nil end)

-- other scripts: holder.SetStage:Fire(player, stage) (clamped; 0 resets to the start)
setStageEvent.Event:Connect(function(player, stage)
  if typeof(player) == "Instance" and player:IsA("Player") then
    setStage(player, stage)
    if player.Character then placeAt(player.Character, statOf(player).Value) end
  end
end)
]==])

setSource(StarterPlayerScripts, "LocalScript", "CheckpointClient", [==[
-- Checkpoint System (TotalScript featured skill) - client: banner, colours, sparkles.
local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")
local TweenService = game:GetService("TweenService")
local player = Players.LocalPlayer

local holder = nil
for _, h in ipairs(CollectionService:GetTagged("CheckpointSet")) do holder = h end
if not holder then
  CollectionService:GetInstanceAddedSignal("CheckpointSet"):Wait()
  holder = CollectionService:GetTagged("CheckpointSet")[1]
end
local doneColor = holder:GetAttribute("DoneColor") or Color3.fromRGB(61, 220, 132)
local nextColor = holder:GetAttribute("NextColor") or Color3.fromRGB(255, 209, 102)
local celebrate = holder:GetAttribute("Celebrate") ~= false
local reachedEvent = holder:WaitForChild("CheckpointReached")

local gui = Instance.new("ScreenGui")
gui.Name = "CheckpointBanner"
gui.ResetOnSpawn = false
gui.DisplayOrder = 40
gui.Parent = player:WaitForChild("PlayerGui")
local banner = Instance.new("TextLabel")
banner.Name = "Banner"
banner.AnchorPoint = Vector2.new(0.5, 0)
banner.Position = UDim2.new(0.5, 0, 0, -60)
banner.Size = UDim2.new(0, 360, 0, 48)
banner.BackgroundColor3 = Color3.fromRGB(20, 22, 28)
banner.BackgroundTransparency = 0.15
banner.TextColor3 = Color3.fromRGB(255, 255, 255)
banner.Font = Enum.Font.GothamBold
banner.TextScaled = true
banner.Text = ""
banner.Visible = false
banner.Parent = gui
local corner = Instance.new("UICorner") corner.CornerRadius = UDim.new(0, 12) corner.Parent = banner
local stroke = Instance.new("UIStroke") stroke.Thickness = 2 stroke.Color = nextColor stroke.Parent = banner
local pad = Instance.new("UIPadding") pad.PaddingLeft = UDim.new(0, 16) pad.PaddingRight = UDim.new(0, 16) pad.PaddingTop = UDim.new(0, 8) pad.PaddingBottom = UDim.new(0, 8) pad.Parent = banner

local original = {}
local function paint(stage)
  for _, p in ipairs(CollectionService:GetTagged("Checkpoint")) do
    if p:IsDescendantOf(holder) or p == holder then
      local s = p:GetAttribute("Stage") or 0
      if original[p] == nil then original[p] = p.Color end
      if s <= stage then p.Color = doneColor
      elseif s == stage + 1 then p.Color = nextColor
      else p.Color = original[p] end
    end
  end
end

local function sparkle(stage)
  for _, p in ipairs(CollectionService:GetTagged("Checkpoint")) do
    if p:GetAttribute("Stage") == stage then
      local e = Instance.new("ParticleEmitter")
      e.Name = "CheckpointSparkle"
      e.Color = ColorSequence.new(doneColor)
      e.Size = NumberSequence.new(0.6, 0)
      e.Lifetime = NumberRange.new(0.6, 1.1)
      e.Speed = NumberRange.new(6, 12)
      e.SpreadAngle = Vector2.new(180, 180)
      e.Rate = 0
      e.Parent = p
      pcall(function() e:Emit(40) end)
      task.delay(2, function() e:Destroy() end)
    end
  end
end

local showing = nil
local function show(stage, total)
  banner.Text = "Checkpoint " .. tostring(stage) .. " / " .. tostring(total)
  banner.Visible = true
  banner.Position = UDim2.new(0.5, 0, 0, -60)
  TweenService:Create(banner, TweenInfo.new(0.35, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Position = UDim2.new(0.5, 0, 0, 24) }):Play()
  local token = {}
  showing = token
  task.delay(2.2, function()
    if showing ~= token then return end
    local t = TweenService:Create(banner, TweenInfo.new(0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.In), { Position = UDim2.new(0.5, 0, 0, -60) })
    t:Play()
    t.Completed:Connect(function() if showing == token then banner.Visible = false end end)
  end)
end

reachedEvent.OnClientEvent:Connect(function(stage, total)
  paint(stage)
  if celebrate then show(stage, total) sparkle(stage) end
end)
paint(player:GetAttribute("Checkpoint") or 0)
CollectionService:GetInstanceAddedSignal("Checkpoint"):Connect(function() paint(player:GetAttribute("Checkpoint") or 0) end)
]==])

waypoint("TotalScript: checkpoint_system " .. holder.Name)
return {
  holder = holder:GetFullName(), stages = #keyed, order = (order == "name" and numbered == #parts) and "name" or "folder", stat = statName, first = stages[1], last = stages[#stages],
  installed = { "tag Checkpoint + attribute Stage on every part (tag CheckpointSet on the holder)", holder:GetFullName() .. ".CheckpointServer (leaderstat, forward-only progress, respawn on the last checkpoint)", holder:GetFullName() .. ".CheckpointReached (RemoteEvent) + .SetStage (BindableEvent for other scripts)", "StarterPlayer.StarterPlayerScripts.CheckpointClient (banner, colours, sparkles)" },
  note = "Progress is per session; wire a DataStore if it must survive rejoin. Attributes StatName / RespawnOffset / DoneColor / NextColor / Celebrate on the holder tweak it live.",
  test = "Press Play, walk onto checkpoint 1 then 2: the banner slides in, the leaderstat climbs, reset the character and you respawn on checkpoint 2.",
}
`,
  };

  // ── 9. gui_polish_kit ────────────────────────────────────────────────────
  const GUI_POLISH_KIT = {
    kind: "skill", name: "gui_polish_kit", title: "GUI Polish Kit",
    description: "Polishes an EXISTING ScreenGui (or any frame inside one) in one pass without changing what it does: a consistent style (sleek / cartoon / minimal / glass) with rounded corners, strokes, padding on crowded containers, one font family and scaled text with min / max sizes, hover / press micro-tweens on every button, and a viewport-aware UIScale so it reads on phones and 4K. Every element it adds is named TS_* so running it again updates instead of stacking.",
    tags: ["ui", "polish", "responsive", "style"], triggers: ["polish gui", "improve ui", "make the ui look better", "round the corners", "consistent ui", "button hover"],
    expert: "ui_ux", version: 1,
    usage: 'gui_polish_kit {screen:"StarterGui.MainMenu", style:"sleek", accent:"#22D3EE"}',
    params: [
      { name: "screen", type: "string", required: true, description: "Path of the ScreenGui (or a Frame inside one) to polish, e.g. StarterGui.HUD" },
      { name: "style", type: "string", required: false, default: "sleek", enum: ["sleek", "cartoon", "minimal", "glass"], description: "Look: sleek (10px corners, thin stroke), cartoon (16px, thick stroke), minimal (6px, no stroke), glass (translucent panels, soft stroke)" },
      { name: "accent", type: "string", required: false, default: "#22D3EE", description: "Hex accent used for strokes and button hover" },
      { name: "font", type: "string", required: false, default: "", description: "Enum.Font name for every text (default per style: GothamMedium / FredokaOne / Gotham / GothamMedium)" },
      { name: "corner", type: "number", required: false, default: 0, description: "Corner radius in px (0 = style default)" },
      { name: "hover", type: "boolean", required: false, default: true, description: "Hover / press tweens on buttons" },
      { name: "text_scale", type: "boolean", required: false, default: true, description: "TextScaled + UITextSizeConstraint (10-36 px) on every text" },
    ],
    references: [ref("Appearance modifiers", "ui/appearance-modifiers"), ref("UICorner", "reference/engine/classes/UICorner"), ref("UIStroke", "reference/engine/classes/UIStroke"), ref("UIPadding", "reference/engine/classes/UIPadding"), ref("UITextSizeConstraint", "reference/engine/classes/UITextSizeConstraint"), ref("UI animation", "ui/animation")],
    knowledge: String.raw`## When to use
- An existing ScreenGui looks flat / inconsistent: rounded corners, strokes, padding, text-size constraints, hover tweens and a UIScale in one pass.

## Before running
- screen is the ScreenGui (or a Frame inside one) path - StarterGui.HUD style. Style names: sleek / cartoon / minimal / glass. It never changes layout or positions, only adds TS_* UI children.

## After running
- Everything it added is named TS_Corner / TS_Stroke / TS_Padding / TS_TextSize / TS_Scale, so a re-run updates them and they are easy to remove. Hover tweens come from rootGui.TS_PolishClient.
- Follow with total_screenshot and judge the result like an art director; adjust accent / corner and re-run.`,
    verify: { note: "TS_* polish instances exist under the target and TS_PolishClient in the ScreenGui", luau: String.raw`local target = find(args.screen)
check(target, "screen not found at " .. tostring(args.screen))
local rootGui = target:IsA("LayerCollector") and target or (target:FindFirstAncestorWhichIsA("LayerCollector") or target)
local added = 0
for _, d in ipairs(target:GetDescendants()) do if string.sub(d.Name, 1, 3) == "TS_" then added = added + 1 end end
check(added > 0, "no TS_* polish instances under " .. target:GetFullName() .. " (empty GUI?)")
local client = rootGui:FindFirstChild("TS_PolishClient")
check(client and client:IsA("LocalScript"), "TS_PolishClient missing in " .. rootGui:GetFullName())
return { ok = true, detail = tostring(added) .. " TS_* instances + TS_PolishClient in " .. rootGui:GetFullName() }` },
    luau: PRELUDE + String.raw`
local target = resolve(args.screen)
if not target then return { ok = false, error = "nothing at '" .. tostring(args.screen) .. "' - give a ScreenGui path such as StarterGui.HUD" } end
if not (target:IsA("LayerCollector") or target:IsA("GuiObject")) then return { ok = false, error = target:GetFullName() .. " is a " .. target.ClassName .. ", not a ScreenGui / Frame" } end
local rootGui = target
if not rootGui:IsA("LayerCollector") then rootGui = target:FindFirstAncestorWhichIsA("LayerCollector") or target end

local STYLES = {
  sleek = { corner = 10, stroke = 1, strokeT = 0.35, font = "GothamMedium", glass = false, pad = 8 },
  cartoon = { corner = 16, stroke = 3, strokeT = 0, font = "FredokaOne", glass = false, pad = 10 },
  minimal = { corner = 6, stroke = 0, strokeT = 1, font = "Gotham", glass = false, pad = 6 },
  glass = { corner = 12, stroke = 1, strokeT = 0.5, font = "GothamMedium", glass = true, pad = 10 },
}
local styleName = tostring(args.style or "sleek")
local S = STYLES[styleName] or STYLES.sleek
if not STYLES[styleName] then styleName = "sleek" end
local accent = hexColor(args.accent, Color3.fromRGB(34, 211, 238))
local fontName = tostring(args.font or "")
if fontName == "" then fontName = S.font end
local font = nil
pcall(function() font = Enum.Font[fontName] end)
if not font then fontName = S.font pcall(function() font = Enum.Font[fontName] end) end
local radius = math.floor(num(args.corner, 0, 0, 64))
if radius == 0 then radius = S.corner end
local hover = args.hover ~= false
local textScale = args.text_scale ~= false

local counts = { panels = 0, texts = 0, buttons = 0, paddings = 0, skipped = 0 }
local function isUi(inst) return inst:IsA("UIComponent") or inst:IsA("UIBase") end
local function hasLayout(inst)
  for _, c in ipairs(inst:GetChildren()) do if c:IsA("UIListLayout") or c:IsA("UIGridLayout") or c:IsA("UIPadding") then return true end end
  return false
end
local function guiChildren(inst)
  local n = 0
  for _, c in ipairs(inst:GetChildren()) do if c:IsA("GuiObject") then n = n + 1 end end
  return n
end

local function panel(inst)
  if inst.BackgroundTransparency >= 1 then return end
  counts.panels = counts.panels + 1
  local c = ensure(inst, "UICorner", "TS_Corner")
  c.CornerRadius = UDim.new(0, radius)
  if S.stroke > 0 then
    local st = ensure(inst, "UIStroke", "TS_Stroke")
    st.Thickness = S.stroke
    st.Color = accent
    st.Transparency = S.strokeT
    pcall(function() st.ApplyStrokeMode = Enum.ApplyStrokeMode.Border end)
  else
    local old = inst:FindFirstChild("TS_Stroke") if old then old:Destroy() end
  end
  inst.BorderSizePixel = 0
  if S.glass and not inst:IsA("GuiButton") and inst.BackgroundTransparency < 0.25 then inst.BackgroundTransparency = 0.25 end
  if not hasLayout(inst) and guiChildren(inst) >= 2 then
    local p = ensure(inst, "UIPadding", "TS_Padding")
    p.PaddingLeft = UDim.new(0, S.pad) p.PaddingRight = UDim.new(0, S.pad) p.PaddingTop = UDim.new(0, S.pad) p.PaddingBottom = UDim.new(0, S.pad)
    counts.paddings = counts.paddings + 1
  end
end

local function text(inst)
  counts.texts = counts.texts + 1
  if font then inst.Font = font end
  if textScale then
    inst.TextScaled = true
    inst.TextWrapped = true
    local k = ensure(inst, "UITextSizeConstraint", "TS_TextSize")
    k.MinTextSize = 10
    k.MaxTextSize = 36
  end
end

local function button(inst)
  counts.buttons = counts.buttons + 1
  inst.AutoButtonColor = false
  inst:SetAttribute("TS_Hover", hover)
  inst:SetAttribute("TS_Accent", accent)
end

local function visit(inst)
  if isUi(inst) then return end
  if inst:IsA("GuiObject") then
    panel(inst)
    if inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox") then text(inst) end
    if inst:IsA("GuiButton") then button(inst) end
  elseif inst ~= target and not inst:IsA("LayerCollector") and not inst:IsA("LuaSourceContainer") then
    counts.skipped = counts.skipped + 1
  end
end
visit(target)
for _, d in ipairs(target:GetDescendants()) do visit(d) end

-- viewport-aware scale on the root (one per ScreenGui)
local scaleHost = rootGui
if scaleHost:IsA("LayerCollector") then
  local sc = ensure(scaleHost, "UIScale", "TS_Scale")
  sc.Scale = 1
end
rootGui:SetAttribute("TS_Style", styleName)
rootGui:SetAttribute("TS_Accent", accent)

setSource(rootGui, "LocalScript", "TS_PolishClient", [==[
-- GUI Polish Kit (TotalScript featured skill) - hover / press tweens + viewport scale. Lives inside the ScreenGui.
local TweenService = game:GetService("TweenService")
local root = script.Parent
local accent = root:GetAttribute("TS_Accent") or Color3.fromRGB(34, 211, 238)
local quick = TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)

local bound = {}
local function bind(btn)
  if bound[btn] or not btn:IsA("GuiButton") or btn:GetAttribute("TS_Hover") == false then return end
  bound[btn] = true
  local baseSize = btn.Size
  local baseColor = btn.BackgroundColor3
  local function to(scale, tint)
    local w = UDim2.new(baseSize.X.Scale * scale, baseSize.X.Offset * scale, baseSize.Y.Scale * scale, baseSize.Y.Offset * scale)
    local props = { Size = w }
    if tint and btn.BackgroundTransparency < 1 then props.BackgroundColor3 = baseColor:Lerp(accent, tint) end
    if not tint and btn.BackgroundTransparency < 1 then props.BackgroundColor3 = baseColor end
    TweenService:Create(btn, quick, props):Play()
  end
  btn.MouseEnter:Connect(function() to(1.04, 0.25) end)
  btn.MouseLeave:Connect(function() to(1, nil) end)
  btn.MouseButton1Down:Connect(function() to(0.96, 0.45) end)
  btn.MouseButton1Up:Connect(function() to(1.04, 0.25) end)
  btn:SetAttribute("TS_Bound", true)
end
for _, d in ipairs(root:GetDescendants()) do bind(d) end
root.DescendantAdded:Connect(bind)

local scale = root:FindFirstChild("TS_Scale")
local camera = workspace.CurrentCamera
local function fit()
  if not scale or not camera then return end
  local w = camera.ViewportSize.X
  local s = w / 1280
  if s < 0.75 then s = 0.75 elseif s > 1.25 then s = 1.25 end
  scale.Scale = s
end
fit()
if camera then camera:GetPropertyChangedSignal("ViewportSize"):Connect(fit) end
]==])

waypoint("TotalScript: gui_polish_kit " .. target.Name)
return {
  target = target:GetFullName(), style = styleName, font = fontName, corner = radius, stroke = S.stroke, accent = tostring(accent),
  panels = counts.panels, texts = counts.texts, buttons = counts.buttons, paddings = counts.paddings, skipped = counts.skipped,
  installed = { "TS_Corner / TS_Stroke / TS_Padding / TS_TextSize inside the elements (re-run updates them)", rootGui:GetFullName() .. ".TS_Scale (UIScale 0.75-1.25 from the viewport width)", rootGui:GetFullName() .. ".TS_PolishClient (hover / press tweens on buttons, live scale)" },
  note = "Nothing was repositioned; layout stays yours. Set attribute TS_Hover=false on a button to opt it out.",
  test = "Press Play: hover and press any button (grows 4 %, tints towards the accent); resize the window and the whole GUI scales with it.",
}
`,
  };

  // ── 10. game_feel_kit ────────────────────────────────────────────────────
  const GAME_FEEL_KIT = {
    kind: "skill", name: "game_feel_kit", title: "Game Feel Kit",
    description: "Installs a reusable juice toolkit: a client module (Shake with a trauma model that decays smoothly, Flash, FOV Kick, Punch for GUI elements, Highlight on an instance) driven by one RemoteEvent, a server module (Impact(position, strength, radius) with distance falloff, Flash / Shake for one or every player) and the client runner on RenderStepped. Intensity presets scale everything; an optional demo hook shakes and flashes red whenever the local character takes damage so it can be felt immediately.",
    tags: ["juice", "camera shake", "vfx", "polish", "combat"], triggers: ["game feel", "juice", "screen shake", "camera shake", "hit feedback", "make it feel good", "impact"],
    expert: "vfx", version: 1,
    usage: 'game_feel_kit {intensity:"medium", demo:true}',
    params: [
      { name: "intensity", type: "string", required: false, default: "medium", enum: ["subtle", "medium", "heavy"], description: "Global dose for shake / flash / kick" },
      { name: "flash_color", type: "string", required: false, default: "#FFFFFF", description: "Default hex colour of the screen flash" },
      { name: "max_distance", type: "number", required: false, default: 60, description: "Impact radius in studs beyond which nobody feels it (5-500)" },
      { name: "demo", type: "boolean", required: false, default: false, description: "Shake + red flash when the local character loses health (remove later or keep as hit feedback)" },
    ],
    references: [ref("Camera", "workspace/camera"), ref("RunService.RenderStepped", "reference/engine/classes/RunService#RenderStepped"), ref("TweenService", "reference/engine/classes/TweenService"), ref("Remote events", "scripting/events/remote"), ref("Highlighting", "effects/highlighting")],
    knowledge: String.raw`## When to use
- Juice: camera shake, screen flash, hit-stop / FOV kick that any script can call - "make hits feel heavy", "game feel".

## Before running
- Nothing to prepare. intensity subtle / medium / heavy sets the global dose; demo:true wires shake + red flash to the local character losing health (remove later).

## After running
- API: require(ReplicatedStorage.GameFeel.Client).Shake / Flash / Kick on the client; require(ReplicatedStorage.GameFeel.Server).Impact(position, strength) on the server (replicated through the Feel RemoteEvent, limited by MaxDistance).
- Attributes on ReplicatedStorage.GameFeel: Intensity / Dose / FlashColor / MaxDistance / Demo.`,
    verify: { note: "GameFeel folder with Feel remote, Client/Server modules, attributes, client script", luau: String.raw`local folder = find("ReplicatedStorage.GameFeel")
check(folder, "ReplicatedStorage.GameFeel missing")
check(folder:FindFirstChild("Feel") and folder.Feel:IsA("RemoteEvent"), "Feel RemoteEvent missing")
check(folder:FindFirstChild("Client") and folder.Client:IsA("ModuleScript"), "Client ModuleScript missing")
check(folder:FindFirstChild("Server") and folder.Server:IsA("ModuleScript"), "Server ModuleScript missing")
check(folder:GetAttribute("Intensity") ~= nil, "Intensity attribute missing")
check(find("StarterPlayer.StarterPlayerScripts.GameFeelClient"), "GameFeelClient missing")
return { ok = true, detail = "GameFeel " .. tostring(folder:GetAttribute("Intensity")) .. " (Client + Server modules, Feel remote)" }` },
    luau: PRELUDE + String.raw`
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local DOSES = { subtle = 0.6, medium = 1, heavy = 1.6 }
local intensity = tostring(args.intensity or "medium")
local dose = DOSES[intensity]
if not dose then intensity = "medium" dose = 1 end
local flash = hexColor(args.flash_color, Color3.fromRGB(255, 255, 255))
local maxDistance = num(args.max_distance, 60, 5, 500)
local demo = args.demo == true

local folder = ensure(ReplicatedStorage, "Folder", "GameFeel")
folder:SetAttribute("Intensity", intensity)
folder:SetAttribute("Dose", dose)
folder:SetAttribute("FlashColor", flash)
folder:SetAttribute("MaxDistance", maxDistance)
folder:SetAttribute("Demo", demo)
local remote = ensure(folder, "RemoteEvent", "Feel")

setSource(folder, "ModuleScript", "Client", [==[
-- Game Feel Kit (TotalScript featured skill) - client module. require(ReplicatedStorage.GameFeel.Client)
local TweenService = game:GetService("TweenService")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local folder = script.Parent
local dose = folder:GetAttribute("Dose") or 1
local defaultFlash = folder:GetAttribute("FlashColor") or Color3.fromRGB(255, 255, 255)

local Feel = {}
Feel.trauma = 0
Feel.maxOffset = 0.6
Feel.maxAngle = math.rad(3)
Feel.decay = 1.6
Feel.seed = math.random() * 100
Feel.enabled = true
local flashFrame = nil
local baseFov = nil

local function camera() return workspace.CurrentCamera end

-- trauma model: shake strength = trauma^2, trauma decays linearly, so big hits linger and taps barely register
function Feel.Shake(strength, duration)
  strength = (tonumber(strength) or 0.5) * dose
  Feel.trauma = math.min(1, Feel.trauma + strength)
  if duration then Feel.decay = math.max(0.4, 1 / math.max(0.05, duration)) end
end

function Feel.Impact(position, strength, radius)
  local char = Players.LocalPlayer and Players.LocalPlayer.Character
  local root = char and char:FindFirstChild("HumanoidRootPart")
  local falloff = 1
  if root and typeof(position) == "Vector3" then
    local d = (root.Position - position).Magnitude
    radius = tonumber(radius) or (folder:GetAttribute("MaxDistance") or 60)
    if d >= radius then return end
    falloff = 1 - d / radius
  end
  Feel.Shake((tonumber(strength) or 0.5) * falloff)
end

local function ensureFlash()
  if flashFrame and flashFrame.Parent then return flashFrame end
  local player = Players.LocalPlayer
  local gui = Instance.new("ScreenGui")
  gui.Name = "GameFeelFlash"
  gui.ResetOnSpawn = false
  gui.IgnoreGuiInset = true
  gui.DisplayOrder = 90
  gui.Parent = player:WaitForChild("PlayerGui")
  local f = Instance.new("Frame")
  f.Name = "Flash"
  f.Size = UDim2.new(1, 0, 1, 0)
  f.BackgroundColor3 = defaultFlash
  f.BackgroundTransparency = 1
  f.BorderSizePixel = 0
  f.ZIndex = 50
  f.Parent = gui
  flashFrame = f
  return f
end

function Feel.Flash(color, duration, peak)
  local f = ensureFlash()
  f.BackgroundColor3 = (typeof(color) == "Color3" and color) or defaultFlash
  peak = math.clamp((tonumber(peak) or 0.35) * dose, 0.05, 0.9)
  f.BackgroundTransparency = 1 - peak
  TweenService:Create(f, TweenInfo.new(tonumber(duration) or 0.25, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { BackgroundTransparency = 1 }):Play()
end

function Feel.Kick(degrees, duration)
  local cam = camera()
  if not cam then return end
  if not baseFov then baseFov = cam.FieldOfView end
  degrees = (tonumber(degrees) or 6) * dose
  cam.FieldOfView = baseFov + degrees
  TweenService:Create(cam, TweenInfo.new(tonumber(duration) or 0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { FieldOfView = baseFov }):Play()
end

function Feel.Punch(guiObject, amount, duration)
  if not (guiObject and guiObject:IsA("GuiObject")) then return end
  amount = 1 + (tonumber(amount) or 0.15) * dose
  local base = guiObject:GetAttribute("FeelBaseSize") or guiObject.Size
  guiObject:SetAttribute("FeelBaseSize", base)
  guiObject.Size = UDim2.new(base.X.Scale * amount, base.X.Offset * amount, base.Y.Scale * amount, base.Y.Offset * amount)
  TweenService:Create(guiObject, TweenInfo.new(tonumber(duration) or 0.25, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Size = base }):Play()
end

function Feel.Highlight(instance, color, duration)
  if typeof(instance) ~= "Instance" then return end
  local h = Instance.new("Highlight")
  h.Name = "FeelHighlight"
  h.FillColor = (typeof(color) == "Color3" and color) or defaultFlash
  h.FillTransparency = 0.4
  h.OutlineTransparency = 0
  h.Parent = instance
  task.delay(tonumber(duration) or 0.15, function() h:Destroy() end)
end

function Feel.Hit(position, strength)
  Feel.Impact(position, strength or 0.5)
  Feel.Kick(4, 0.25)
end

-- the runner: applied every frame on top of whatever the camera scripts did
local noise = { 0.3, -0.7, 0.9, -0.2, 0.6, -0.9, 0.1, 0.8, -0.5, 0.4 }
local function sample(t, k)
  local i = math.floor(t * 20 + k) % #noise + 1
  local j = i % #noise + 1
  local f = (t * 20 + k) % 1
  return noise[i] + (noise[j] - noise[i]) * f
end
function Feel.Step(dt)
  if not Feel.enabled or Feel.trauma <= 0 then return end
  local cam = camera()
  if not cam then return end
  local s = Feel.trauma * Feel.trauma
  local t = os.clock() + Feel.seed
  local ox = Feel.maxOffset * s * sample(t, 0)
  local oy = Feel.maxOffset * s * sample(t, 3)
  local rz = Feel.maxAngle * s * sample(t, 6)
  cam.CFrame = cam.CFrame * CFrame.new(ox, oy, 0) * CFrame.Angles(0, 0, rz)
  Feel.trauma = math.max(0, Feel.trauma - Feel.decay * dt)
end
Feel.lastOffset = sample

return Feel
]==])

setSource(folder, "ModuleScript", "Server", [==[
-- Game Feel Kit (TotalScript featured skill) - server module. require(ReplicatedStorage.GameFeel.Server)
local Players = game:GetService("Players")
local folder = script.Parent
local remote = folder:WaitForChild("Feel")
local Server = {}

local function send(player, kind, data) remote:FireClient(player, kind, data) end

-- Impact(position, strength, radius): everyone whose character is inside the radius shakes, scaled by distance
function Server.Impact(position, strength, radius)
  radius = tonumber(radius) or (folder:GetAttribute("MaxDistance") or 60)
  local hit = 0
  for _, player in ipairs(Players:GetPlayers()) do
    local char = player.Character
    local root = char and char:FindFirstChild("HumanoidRootPart")
    if root then
      local d = (root.Position - position).Magnitude
      if d < radius then
        hit = hit + 1
        send(player, "shake", { strength = (tonumber(strength) or 0.5) * (1 - d / radius) })
      end
    end
  end
  return hit
end
function Server.Shake(player, strength, duration) send(player, "shake", { strength = strength, duration = duration }) end
function Server.Flash(player, color, duration, peak) send(player, "flash", { color = color, duration = duration, peak = peak }) end
function Server.Kick(player, degrees, duration) send(player, "kick", { degrees = degrees, duration = duration }) end
function Server.Highlight(player, instance, color, duration) send(player, "highlight", { instance = instance, color = color, duration = duration }) end
function Server.All(kind, data) remote:FireAllClients(kind, data) end
return Server
]==])

setSource(StarterPlayerScripts, "LocalScript", "GameFeelClient", [==[
-- Game Feel Kit (TotalScript featured skill) - client runner: remote -> module, RenderStepped shake, optional damage demo.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local folder = ReplicatedStorage:WaitForChild("GameFeel")
local Feel = require(folder:WaitForChild("Client"))
local remote = folder:WaitForChild("Feel")

remote.OnClientEvent:Connect(function(kind, data)
  data = type(data) == "table" and data or {}
  if kind == "shake" then Feel.Shake(data.strength, data.duration)
  elseif kind == "flash" then Feel.Flash(data.color, data.duration, data.peak)
  elseif kind == "kick" then Feel.Kick(data.degrees, data.duration)
  elseif kind == "highlight" then Feel.Highlight(data.instance, data.color, data.duration)
  elseif kind == "impact" then Feel.Impact(data.position, data.strength, data.radius)
  elseif kind == "hit" then Feel.Hit(data.position, data.strength) end
end)

RunService.RenderStepped:Connect(function(dt) Feel.Step(dt) end)

if folder:GetAttribute("Demo") then
  local player = Players.LocalPlayer
  local function watch(character)
    local hum = character:WaitForChild("Humanoid")
    local last = hum.Health
    hum.HealthChanged:Connect(function(h)
      if h < last then
        local amount = math.clamp((last - h) / math.max(1, hum.MaxHealth), 0.05, 1)
        Feel.Shake(0.3 + amount * 0.7)
        Feel.Flash(Color3.fromRGB(255, 60, 60), 0.3, 0.2 + amount * 0.4)
        Feel.Kick(3 + amount * 6, 0.3)
      end
      last = h
    end)
  end
  if player.Character then watch(player.Character) end
  player.CharacterAdded:Connect(watch)
end
]==])

waypoint("TotalScript: game_feel_kit " .. intensity)
return {
  folder = folder:GetFullName(), intensity = intensity, dose = dose, max_distance = maxDistance, demo = demo,
  installed = { "ReplicatedStorage.GameFeel (attributes Intensity / Dose / FlashColor / MaxDistance / Demo)", "ReplicatedStorage.GameFeel.Feel (RemoteEvent)", "ReplicatedStorage.GameFeel.Client (ModuleScript: Shake / Impact / Flash / Kick / Punch / Highlight / Hit)", "ReplicatedStorage.GameFeel.Server (ModuleScript: Impact / Shake / Flash / Kick / Highlight / All)", "StarterPlayer.StarterPlayerScripts.GameFeelClient (runner)" },
  usage = { server = 'local Feel = require(game.ReplicatedStorage.GameFeel.Server) Feel.Impact(part.Position, 0.8, 40)', client = 'local Feel = require(game.ReplicatedStorage.GameFeel.Client) Feel.Shake(0.5) Feel.Flash(Color3.new(1,1,1), 0.2) Feel.Punch(label, 0.2)' },
  test = demo and "Press Play and take damage (humanoid_set Health or fall): the camera shakes, the screen flashes red and the FOV kicks." or "Press Play, then from a server script call require(ReplicatedStorage.GameFeel.Server).Impact(position, 0.8) near the player.",
}
`,
  };

  // ── 11. place_audit_report ───────────────────────────────────────────────
  const PLACE_AUDIT = {
    kind: "skill", name: "place_audit_report", title: "Place Audit Report",
    description: "A pre-publish health check that reads everything and invents nothing: loose unanchored parts, deprecated script APIs (wait / spawn / delay / BodyMovers / :connect / Humanoid:LoadAnimation), LocalScripts touching DataStores, disabled scripts, print spam, empty folders, models without a PrimaryPart, parts far from the origin, missing SpawnLocation, empty Sounds / Decals, duplicate names, streaming hints. Writes a readable report ModuleScript into ServerStorage, returns a score with the top findings, and applies the one safe fix (wait/spawn/delay to task.*) only when asked.",
    tags: ["quality", "audit", "release", "lint"], triggers: ["audit my game", "release checklist", "ready to publish", "pre-publish check", "health check", "find problems"],
    expert: "debug_repair", version: 1,
    usage: 'place_audit_report {scope:"", fix_deprecated:false}',
    params: [
      { name: "scope", type: "string", required: false, default: "", description: "Path to audit (empty = the whole place: Workspace, ReplicatedStorage, ServerScriptService, ServerStorage, StarterGui, StarterPlayer, StarterPack, Lighting)" },
      { name: "fix_deprecated", type: "boolean", required: false, default: false, description: "Rewrite bare wait( / spawn( / delay( to task.wait( / task.spawn( / task.delay( inside the scanned scripts" },
      { name: "max_findings", type: "number", required: false, default: 40, description: "How many findings to list in the result (5-200); the report file always has all of them" },
      { name: "far_distance", type: "number", required: false, default: 5000, description: "Studs from the origin beyond which a part is flagged (physics precision)" },
    ],
    references: [ref("task library", "reference/engine/libraries/task"), ref("Streaming", "workspace/streaming"), ref("Improve performance", "performance-optimization/improve"), ref("Client-server boundary", "scripting/security/client-server-boundary"), ref("SpawnLocation", "reference/engine/classes/SpawnLocation")],
    knowledge: String.raw`## When to use
- "Audit my place", "what is wrong with my game", before publishing, after importing a model - a read-mostly health report.

## Before running
- scope empty = whole place; a path limits it. fix_deprecated:true is the ONLY mutation (wait/spawn/delay -> task.*); everything else is reported.

## After running
- The report is ServerStorage.TotalScriptAuditReport (ModuleScript) - open it in Studio. Summarise verdict + top findings; each row names the instance.
- Offer the next step per finding (e.g. anchor loose parts, delete empty scripts), but do not fix silently.`,
    verify: { note: "the audit report ModuleScript exists and the result carried a verdict", luau: String.raw`local report = find("ServerStorage.TotalScriptAuditReport")
check(report and report:IsA("ModuleScript"), "ServerStorage.TotalScriptAuditReport missing")
check(#report.Source > 50, "report is empty")
check(result == nil or result.verdict ~= nil, "command result has no verdict")
return { ok = true, detail = "report " .. tostring(#report.Source) .. " chars" .. (result and result.verdict and (", verdict " .. tostring(result.verdict)) or "") }` },
    luau: PRELUDE + String.raw`
local ServerStorage = game:GetService("ServerStorage")
local Lighting = game:GetService("Lighting")
local Players = game:GetService("Players")
local scopePath = tostring(args.scope or "")
local roots = {}
if scopePath ~= "" then
  local s = resolve(scopePath)
  if not s then return { ok = false, error = "scope not found at '" .. scopePath .. "'" } end
  roots[1] = s
else
  for _, name in ipairs({ "Workspace", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPlayer", "StarterPack", "Lighting", "ReplicatedFirst" }) do
    local okS, svc = pcall(function() return game:GetService(name) end)
    if okS and svc then roots[#roots + 1] = svc end
  end
end
local fixDeprecated = args.fix_deprecated == true
local maxFindings = math.floor(num(args.max_findings, 40, 5, 200))
local farDistance = num(args.far_distance, 5000, 500, 100000)

local findings = {}
local counts = { error = 0, warn = 0, info = 0 }
local function add(severity, check, inst, detail)
  counts[severity] = (counts[severity] or 0) + 1
  findings[#findings + 1] = { severity = severity, check = check, path = inst and inst:GetFullName() or "", detail = detail or "" }
end

local function inCharacter(inst)
  local m = inst:FindFirstAncestorOfClass("Model")
  while m do
    if m:FindFirstChildOfClass("Humanoid") then return true end
    m = m:FindFirstAncestorOfClass("Model")
  end
  return false
end
local function hasJoint(part)
  for _, c in ipairs(part:GetChildren()) do
    if c:IsA("JointInstance") or c:IsA("WeldConstraint") or c:IsA("Constraint") or c:IsA("Attachment") then return true end
  end
  return false
end

local DEPRECATED = {
  { pat = "^wait%(", pat2 = "[^%w_%.:]wait%(", label = "wait()", fix = "task.wait(" },
  { pat = "^spawn%(", pat2 = "[^%w_%.:]spawn%(", label = "spawn()", fix = "task.spawn(" },
  { pat = "^delay%(", pat2 = "[^%w_%.:]delay%(", label = "delay()", fix = "task.delay(" },
  { pat2 = "Body(%a+)", label = "BodyMover", bodies = true },
  { pat2 = ":connect%(", label = ":connect()" },
  { pat2 = ":Remove%(%)", label = ":Remove()" },
  { pat2 = "Humanoid:LoadAnimation", label = "Humanoid:LoadAnimation" },
  { pat2 = "%.Stepped:Connect%(", label = "RunService.Stepped" },
}
local BODIES = { BodyVelocity = true, BodyGyro = true, BodyPosition = true, BodyForce = true, BodyThrust = true, BodyAngularVelocity = true, RocketPropulsion = true }

local fixed = 0
local scriptsSeen = 0
local partsSeen = 0
local unanchored = 0
local function auditScript(s)
  scriptsSeen = scriptsSeen + 1
  local src = s.Source or ""
  if s:IsA("Script") or s:IsA("LocalScript") then
    local okD, disabled = pcall(function() return s.Disabled end)
    if okD and disabled then add("info", "disabled_script", s, "Disabled - delete it or enable it on purpose") end
  end
  local hits = {}
  local rewritten = false
  for _, d in ipairs(DEPRECATED) do
    local found = false
    if d.bodies then
      for name in string.gmatch(src, "Body(%a+)") do if BODIES["Body" .. name] then found = "Body" .. name end end
    else
      if d.pat and string.find(src, d.pat) then found = true end
      if not found and string.find(src, d.pat2) then found = true end
    end
    if found then hits[#hits + 1] = (found == true) and d.label or tostring(found) end
    if found and fixDeprecated and d.fix then
      local before = src
      src = string.gsub(src, d.pat2, function(m) return string.sub(m, 1, 1) .. d.fix end)
      if d.pat then src = string.gsub(src, d.pat, d.fix) end
      if src ~= before then rewritten = true end
    end
  end
  if rewritten then fixed = fixed + 1 end
  if #hits > 0 then add("warn", "deprecated_api", s, table.concat(hits, ", ") .. (fixDeprecated and " (wait/spawn/delay rewritten to task.*)" or " - use task.wait / task.spawn / task.delay, constraints, :Connect, Animator:LoadAnimation")) end
  if src ~= (s.Source or "") then s.Source = src end
  local prints = select(2, string.gsub(src, "[^%w_]print%(", ""))
  if string.find(src, "^print%(") then prints = prints + 1 end
  if prints >= 5 then add("info", "print_spam", s, tostring(prints) .. " print() calls - strip debug output before release") end
  if s:IsA("LocalScript") and string.find(src, "DataStoreService") then add("error", "client_datastore", s, "a LocalScript cannot use DataStoreService - move saving to a server Script") end
  if s:IsA("LocalScript") and string.find(src, "ServerStorage") then add("warn", "client_serverstorage", s, "ServerStorage does not exist on the client") end
  if string.find(src, "game%.Workspace") then add("info", "game_workspace", s, "use the workspace global") end
end

local names = {}
local function auditInstance(inst)
  if inst:IsA("LuaSourceContainer") then auditScript(inst) return end
  if inst:IsA("BasePart") then
    partsSeen = partsSeen + 1
    if not inst.Anchored and not inCharacter(inst) and not hasJoint(inst) and not inst:FindFirstAncestorOfClass("Tool") then
      unanchored = unanchored + 1
      if unanchored <= 25 then add("warn", "unanchored_part", inst, "unanchored with no joint - it will fall at Play") end
    end
    local d = inst.Position.Magnitude
    if d > farDistance then add("warn", "far_from_origin", inst, string.format("%.0f studs from the origin - physics precision drops", d)) end
  elseif inst:IsA("Folder") then
    if #inst:GetChildren() == 0 then add("info", "empty_folder", inst, "empty Folder") end
  elseif inst:IsA("Model") then
    local n = 0
    for _, c in ipairs(inst:GetDescendants()) do if c:IsA("BasePart") then n = n + 1 end end
    if n >= 2 and not inst.PrimaryPart and not inst:FindFirstChildOfClass("Humanoid") then add("info", "no_primary_part", inst, tostring(n) .. " parts and no PrimaryPart - PivotTo / GetPivot use a computed centre") end
  elseif inst:IsA("Sound") then
    if (inst.SoundId or "") == "" then add("warn", "empty_sound", inst, "SoundId is empty - it will never play") end
  elseif inst:IsA("Decal") then
    if (inst.Texture or "") == "" then add("warn", "empty_decal", inst, "Texture is empty") end
  end
end

for _, root in ipairs(roots) do
  auditInstance(root)
  for _, d in ipairs(root:GetDescendants()) do auditInstance(d) end
end
if unanchored > 25 then add("warn", "unanchored_part", nil, tostring(unanchored - 25) .. " more unanchored parts not listed") end

-- place-level checks
local wsRoot = nil
for _, r in ipairs(roots) do if r == workspace then wsRoot = r end end
if wsRoot then
  local spawns = 0
  for _, d in ipairs(workspace:GetDescendants()) do if d:IsA("SpawnLocation") then spawns = spawns + 1 end end
  if spawns == 0 then add("error", "no_spawn", workspace, "no SpawnLocation - players spawn at the origin (spawn_location_create)") end
  local seen = {}
  for _, c in ipairs(workspace:GetChildren()) do
    if seen[c.Name] then names[c.Name] = (names[c.Name] or 1) + 1 else seen[c.Name] = true end
  end
  for n, k in pairs(names) do add("info", "duplicate_name", workspace, string.format("%d children named '%s' - FindFirstChild returns only the first", k, n)) end
  local okStream, streaming = pcall(function() return workspace.StreamingEnabled end)
  if okStream and streaming == false and partsSeen > 5000 then add("info", "streaming_off", workspace, tostring(partsSeen) .. " parts with StreamingEnabled off - consider enabling streaming") end
  local okTech, tech = pcall(function() return Lighting.Technology end)
  if okTech and tech and tostring(tech) == "Enum.Technology.Compatibility" then add("info", "legacy_lighting", Lighting, "Lighting.Technology is Compatibility - Future / ShadowMap look far better") end
end

local order = { error = 1, warn = 2, info = 3 }
table.sort(findings, function(a, b) if order[a.severity] == order[b.severity] then return a.path < b.path end return order[a.severity] < order[b.severity] end)
local score = 100 - counts.error * 15 - counts.warn * 4 - counts.info * 1
if score < 0 then score = 0 end
local verdict = "ship it"
if counts.error > 0 then verdict = "blocked: fix the errors first" elseif score < 70 then verdict = "needs a cleanup pass" elseif score < 90 then verdict = "good, a few warnings" end

-- the report file: a ModuleScript anyone can require or read
local lines = {}
lines[#lines + 1] = "-- TotalScript place audit (" .. os.date("%Y-%m-%d %H:%M") .. ") - scope: " .. (scopePath ~= "" and scopePath or "whole place")
lines[#lines + 1] = string.format("-- score %d/100 - %s - %d errors, %d warnings, %d infos; %d scripts, %d parts scanned%s", score, verdict, counts.error, counts.warn, counts.info, scriptsSeen, partsSeen, fixDeprecated and (", " .. fixed .. " scripts fixed") or "")
lines[#lines + 1] = "return {"
lines[#lines + 1] = string.format("  score = %d, verdict = %q, errors = %d, warnings = %d, infos = %d, scripts = %d, parts = %d, fixed = %d,", score, verdict, counts.error, counts.warn, counts.info, scriptsSeen, partsSeen, fixed)
lines[#lines + 1] = "  findings = {"
for _, f in ipairs(findings) do
  lines[#lines + 1] = string.format("    { severity = %q, check = %q, path = %q, detail = %q },", f.severity, f.check, f.path, f.detail)
end
lines[#lines + 1] = "  },"
lines[#lines + 1] = "}"
local report = setSource(ServerStorage, "ModuleScript", "TotalScriptAuditReport", table.concat(lines, "\n"))

local top = {}
for i = 1, math.min(maxFindings, #findings) do
  local f = findings[i]
  top[i] = f.severity .. " " .. f.check .. " " .. f.path .. (f.detail ~= "" and (" - " .. f.detail) or "")
end

waypoint("TotalScript: place_audit_report")
return {
  score = score, verdict = verdict, errors = counts.error, warnings = counts.warn, infos = counts.info, scripts = scriptsSeen, parts = partsSeen, fixed = fixed,
  report = report:GetFullName(), scope = scopePath ~= "" and scopePath or "whole place", listed = #top, total = #findings,
  findings = top,
  note = "Every row names the instance it came from - open it in the Explorer. Only wait/spawn/delay were rewritten, and only with fix_deprecated=true; everything else is reported, not changed.",
}
`,
  };

  const PACKS = [
    {
      id: PACK_ID, title: "Featured by TotalScript", version: VERSION,
      description: "Eleven complete skills - real Luau systems installed in one call: damage numbers, NPC brain, keycard doors, dialogue trees, collectibles, zones, boss bar, checkpoints, GUI polish kit, game feel kit and a place audit report. Every one carries its docs references. Curated, idempotent, settings as attributes, no invented asset ids.",
      items: [DAMAGE_NUMBERS, NPC_BRAIN, DOOR, DIALOGUE, COLLECTIBLES, ZONES, BOSS_BAR, CHECKPOINTS, GUI_POLISH_KIT, GAME_FEEL_KIT, PLACE_AUDIT],
    },
  ];
  for (const p of PACKS) for (const it of p.items) { it.author = it.author || AUTHOR; it.source = "import"; it.pack = p.id; }

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const get = (id) => PACKS.find((p) => p.id === (id || PACK_ID)) || null;
  const list = () => PACKS.map((p) => ({ id: p.id, title: p.title, version: p.version, description: p.description, count: p.items.length, items: p.items.map((i) => ({ kind: i.kind, name: i.name, title: i.title, description: i.description, version: i.version })) }));
  const items = (id) => { const p = get(id); return p ? clone(p.items) : []; };
  const item = (name) => { for (const p of PACKS) { const it = p.items.find((i) => i.name === name); if (it) return clone(it); } return null; };
  // Export-format object identical to what Public tab → Export all writes, so the
  // pack file in the repo and a share code are both just this.
  function packObject(id) {
    const p = get(id);
    if (!p) return null;
    return { format: "totalscript-public-skill-pack", formatVersion: 1, app: "TotalScript", pack: p.id, title: p.title, version: p.version, exportedAt: "bundled", count: p.items.length, items: clone(p.items) };
  }
  const packJson = (id) => { const o = packObject(id); return o ? JSON.stringify(o, null, 2) : null; };
  // Per-item install status against a PublicSkills instance (never installs).
  function status(PS, id) {
    const p = get(id);
    if (!p) return [];
    return p.items.map((it) => {
      const inst = PS && typeof PS.find === "function" ? PS.find(it.name) : null;
      const have = inst && inst.kind === it.kind ? inst : null;
      return { kind: it.kind, name: it.name, title: it.title, description: it.description, version: it.version, references: Array.isArray(it.references) ? it.references.length : 0, verify: !!(it.verify && it.verify.luau), knowledge: !!it.knowledge, installed: !!have, installedVersion: have ? have.version : 0, modified: !!(have && Array.isArray(have.history) && have.history.length), upToDate: !!(have && have.version >= it.version) };
    });
  }
  // Install (or update) items through the normal import path. names: optional subset.
  function install(PS, id, opts) {
    opts = opts || {};
    const p = get(id);
    if (!p || !PS || typeof PS.importPack !== "function") return { ok: false, errors: [p ? "Public Skills module unavailable" : `unknown pack '${id}'`], installed: [], skipped: [], warnings: [] };
    const want = Array.isArray(opts.names) && opts.names.length ? new Set(opts.names) : null;
    const defs = p.items.filter((it) => !want || want.has(it.name)).map((it) => clone(it));
    if (!defs.length) return { ok: false, errors: ["no matching items in the pack"], installed: [], skipped: [], warnings: [] };
    return PS.importPack(defs, { reserved: opts.reserved, replace: !!opts.replace, source: "import" });
  }

  const api = Object.freeze({ VERSION, PACK_ID, AUTHOR, PACKS, get, list, items, item, packObject, packJson, status, install });
  root.TotalPublicPacks = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
