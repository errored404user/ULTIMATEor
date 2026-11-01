// TotalScript — Featured Public Skill packs (2.2.1)
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
//     mocked Roblox sim (tests/public-pack-sim.py) can compile every one.
//
// This file is DOM-free at top level (node loads it for the tests).
(function (root) {
  "use strict";
  const VERSION = "2.2.1";
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
folder:SetAttribute("Version", "2.2.1")

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
    references: [ref("Character pathfinding", "characters/pathfinding"), ref("Humanoid", "reference/engine/classes/Humanoid")],
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
folder:SetAttribute("Version", "2.2.1")
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
folder:SetAttribute("Version", "2.2.1")

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
folder:SetAttribute("Version", "2.2.1")
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

  // ── abilities ────────────────────────────────────────────────────────────
  const GUI_POLISH = {
    kind: "ability", name: "gui_polish_pass", title: "GUI Polish Pass",
    description: "A disciplined polish routine for an EXISTING ScreenGui: inspect, audit, fix responsiveness for phone + desktop, apply the design tokens, wire hover / press states and micro-tweens, verify with a preview, report before/after. Uses only real ui_* commands, one per message, and never rebuilds a screen that works.",
    tags: ["ui", "polish", "responsive", "quality"], triggers: ["polish gui", "improve ui", "make the ui look better", "responsive", "juice the menu"],
    expert: "ui_ux", version: 1,
    usage: 'gui_polish_pass {screen:"StarterGui.MainMenu", style:"sleek"}',
    params: [
      { name: "screen", type: "string", required: true, description: "Path of the ScreenGui to polish, e.g. StarterGui.HUD" },
      { name: "style", type: "string", required: false, default: "", description: "Token style to apply (sleek | cartoon | minimal | glass | horror | scifi | fantasy | retro | ...) - empty keeps the installed tokens" },
      { name: "mobile", type: "boolean", required: false, default: true, description: "Also verify / fix the phone layout" },
    ],
    instructions: "Polish {{screen}} without changing what it does. Work strictly in this order and show the evidence of each step (the command output), never a description of what you would do. If a step finds nothing to fix, say so and move on - do not invent problems. Style requested: '{{style}}' (empty = keep tokens). Mobile pass: {{mobile}}.",
    steps: [
      "ui_inspect {path:\"{{screen}}\"} - learn the real tree: names, classes, sizes, text. Stop with an ERROR if the screen does not exist; never create a new one in this ability.",
      "ui_audit {path:\"{{screen}}\"} - record every finding (offset-only sizes, missing anchors, TextScaled without UITextSizeConstraint, missing padding/corners, unreadable contrast, overlapping siblings).",
      "ui_responsive_check {path:\"{{screen}}\"} at desktop, then (if mobile) phone - note which elements break.",
      "ui_responsive_fix {path:\"{{screen}}\"} / ui_make_responsive for the elements that broke - scale sizes, anchor presets, UISizeConstraint and UITextSizeConstraint; keep pixel values only for strokes and paddings.",
      "If a style was given: design_tokens_set {style:\"{{style}}\"} then ui_apply_tokens {path:\"{{screen}}\"} (colours, corner radii, strokes, fonts from the tokens - no hand-picked colours).",
      "ui_states_wire {path:\"{{screen}}\"} for every button: hover / press / disabled states; ui_tween for the two or three micro-interactions that matter (menu open, button press, value change) with 0.12-0.25 s durations - no bouncing everything.",
      "ui_audit again and ui_preview {path:\"{{screen}}\"} - attach the preview and compare with the first audit. Every finding fixed or explicitly deferred with a reason.",
      "Report: a two-column before/after of the audit findings, the exact commands run, and anything you could not verify (e.g. 'phone layout not previewed because ...').",
    ],
    commands: ["ui_inspect", "ui_audit", "ui_responsive_check", "ui_responsive_fix", "ui_make_responsive", "design_tokens_set", "ui_apply_tokens", "ui_states_wire", "ui_tween", "ui_preview"],
    references: [ref("UI position and size", "ui/position-and-size"), ref("Size modifiers", "ui/size-modifiers"), ref("Appearance modifiers", "ui/appearance-modifiers"), ref("UI animation", "ui/animation"), ref("UIAspectRatioConstraint", "reference/engine/classes/UIAspectRatioConstraint")],
  };

  const RELEASE_CHECK = {
    kind: "ability", name: "release_checklist", title: "Release Checklist",
    description: "A pre-publish inspection of the whole place with real tools: diagnostics audit, script lint + deprecations, project health, model checks (unanchored / huge parts), UI responsiveness, console errors - then fixes ONLY what the evidence shows and ends with a go / no-go table. Nothing is published by this ability.",
    tags: ["quality", "release", "audit", "lint"], triggers: ["release checklist", "ready to publish", "pre-publish check", "audit my game", "ship check", "qa pass"],
    expert: "debug_repair", version: 1,
    usage: "release_checklist {fix:true}",
    params: [
      { name: "fix", type: "boolean", required: false, default: true, description: "Apply the safe automatic fixes (deprecations, common diagnostics) after reporting them" },
      { name: "scope", type: "string", required: false, default: "", description: "Optional path to limit the model / UI checks to (default: whole place)" },
    ],
    instructions: "Run a release inspection. Fixes allowed: {{fix}}. Scope: '{{scope}}' (empty = whole place). Rules: every verdict must quote the command output it came from; never mark a row PASS without evidence; never publish, never change gameplay numbers, never delete anything - fixes are limited to deprecations, lint-safe rewrites and the diagnostics_fix_common set, and each fix is followed by script_check on the touched script.",
    steps: [
      "diagnostics_audit {} - the engine-level issues (missing services, broken requires, infinite yields).",
      "project_health_report {} and workspace_stats {} - part counts, script counts, oversized assets, StreamingEnabled, physics load.",
      "script_lint {} across all scripts, then script_deprecations_fix only if fix is true; script_check each script you touched.",
      "model_check {path: scope or Workspace} - unanchored static geometry, CanCollide on decorations, parts far from origin, missing PrimaryPart on models that move.",
      "ui_responsive_check on every ScreenGui under StarterGui (list them with ui_find or instance_find_class first) - phone and desktop.",
      "get_console_output {} after a short Play test if the user allows it - any red lines block the release.",
      "If fix is true: diagnostics_fix_common {} for the safe set; re-run diagnostics_audit to prove it.",
      "Final table: row per check (Diagnostics, Health, Lint, Models, UI, Console) with PASS / FAIL / NOT CHECKED, the evidence line, and the remaining manual to-dos (thumbnails, descriptions, game passes, moderation) - stated as things the user does in the Creator Dashboard, not as done.",
    ],
    commands: ["diagnostics_audit", "project_health_report", "workspace_stats", "script_lint", "script_deprecations_fix", "script_check", "model_check", "ui_responsive_check", "ui_find", "instance_find_class", "get_console_output", "diagnostics_fix_common"],
    references: [ref("Streaming", "workspace/streaming"), ref("Data stores best practices", "cloud-services/data-stores/best-practices")],
  };

  const GAME_FEEL = {
    kind: "ability", name: "game_feel_pass", title: "Game Feel Pass",
    description: "Adds juice to an existing mechanic with measured doses: camera shake on impact, hit flash highlight, particle burst + sound event, a short hit-stop, and UI punch on value changes - each wired to the mechanic's real event (not a demo loop), each with restrained numbers, each verified at Play. Uses the fx_/sfx_/camera_/ui_ packs rather than hand-written effect code.",
    tags: ["juice", "vfx", "sfx", "polish", "combat"], triggers: ["game feel", "juice", "screen shake", "hit feedback", "make it feel good", "impact"],
    expert: "vfx", version: 1,
    usage: 'game_feel_pass {mechanic:"sword hit", script:"ServerScriptService.Combat", intensity:"medium"}',
    params: [
      { name: "mechanic", type: "string", required: true, description: "What should feel better (e.g. 'sword hit', 'coin pickup', 'door open', 'jump landing')" },
      { name: "script", type: "string", required: false, default: "", description: "Path of the script where the event happens (found with script_search if empty)" },
      { name: "intensity", type: "string", required: false, default: "medium", enum: ["subtle", "medium", "heavy"], description: "Overall dose" },
    ],
    instructions: "Improve the feel of '{{mechanic}}' at intensity '{{intensity}}'. Find the real event first (script '{{script}}' or script_search); every effect is triggered from that event, never from a timer. Doses: subtle = shake 0.15/0.1 s, flash 0.08 s, no hit-stop; medium = shake 0.35/0.18 s, flash 0.12 s, hit-stop 0.05 s; heavy = shake 0.6/0.25 s, flash 0.15 s, hit-stop 0.08 s. Add at most five effects; remove any that makes the mechanic harder to read. Never invent sound asset ids - define sfx events with sfx_event_define and leave the id empty if the user has none, saying so.",
    steps: [
      "script_search / script_read the mechanic's script and quote the exact line (event, function) the effects will hang off. If there is none, stop and say what is missing.",
      "camera_shake preset for the intensity, fired from that event on the affected client (RemoteEvent if the event is server-side - remote_event_create).",
      "highlight_add on the hit target for the flash duration (then highlight_clear), or ui_tween a flash on the HUD element for UI events.",
      "fx_burst (or fx_sparks / fx_puff matching the material) at the impact position, pooled, 8-16 particles - verify with vfx_validate.",
      "sfx_event_define + sfx_event_play for the impact (layered: thump + material tail); empty SoundId if none provided.",
      "Hit-stop (medium/heavy only): script_insert a 0.05-0.08 s pause of the attacker/target animation speed (never a global wait).",
      "UI punch for value changes: ui_tween the number label scale 1.0 -> 1.2 -> 1.0 in 0.18 s.",
      "Play-test with get_console_output; report the five effects, their numbers, where they are wired, and what was intentionally left out.",
    ],
    commands: ["script_search", "script_read", "script_insert", "camera_shake", "remote_event_create", "highlight_add", "highlight_clear", "fx_burst", "fx_sparks", "fx_puff", "vfx_validate", "sfx_event_define", "sfx_event_play", "ui_tween", "get_console_output"],
    references: [ref("Particle emitters", "effects/particle-emitters"), ref("Highlighting", "effects/highlighting"), ref("Sound", "sound"), ref("Camera", "workspace/camera")],
  };

  // ── work mode ────────────────────────────────────────────────────────────
  const JAM_MODE = {
    kind: "mode", name: "prototype_sprint", title: "Prototype Sprint", badge: "JAM",
    description: "Game-jam work mode: a playable loop in the fewest messages. Grey-box first, one system per message, blueprints and featured skills before custom code, verify at Play after every system, polish only after the loop closes.",
    sub: "Playable loop first, polish last", note: "Best for jams, pitches and 'can this idea work' tests. Switch back to Totality for production quality.",
    toast: "Prototype Sprint - playable loop first", base: "creation",
    tags: ["jam", "prototype", "speed"], triggers: ["game jam", "prototype", "quick test", "mvp", "proof of concept"],
    expert: "gameplay_systems", version: 1,
    mandate: [
      "PROTOTYPE SPRINT. Goal: the smallest loop a player can enjoy end-to-end (spawn -> act -> reward -> repeat) running at Play before anything is pretty.",
      "Order of work, one system per message: 1) grey-box the space with part_create / model_build (no materials, no decoration); 2) the core verb (move / hit / collect / build) with the matching blueprint_install or featured public skill (collectible_spawner, zone_system, npc_patrol_chase, keycard_door_system, damage_numbers_pro, boss_health_bar) before any hand-written system; 3) the reward (leaderstats_int + the stat the skill feeds); 4) the loop closer (round / respawn / shop) via blueprint_install; 5) only now: one HUD (ui_screen_generate hud) and one feedback pass (game_feel_pass).",
      "Verify after every system with get_console_output and a one-line Play check; a red line is fixed before the next system. Keep numbers in attributes so they can be tuned without edits.",
      "Forbidden until the loop closes: textures, lighting presets, cutscenes, custom fonts, more than one UI screen, refactors. Say 'deferred: <thing>' instead of doing it.",
      "Finish each message with the loop status: which of the five steps are done and the single next step.",
    ].join("\n"),
    focus: ["part_create", "model_build", "blueprint_list", "blueprint_install", "blueprint_verify", "leaderstats_int", "spawn_location_create", "ui_screen_generate", "get_console_output", "humanoid_set", "instance_find", "script_check", "tag_add", "proximity_prompt_create", "remote_event_create"],
    references: [ref("Leaderboards", "players/leaderboards"), ref("Attributes", "scripting/attributes")],
  };

  const PACKS = [
    {
      id: PACK_ID, title: "Featured by TotalScript", version: VERSION,
      description: "Seven complete gameplay systems (damage numbers, NPC brain, keycard doors, dialogue trees, collectibles, zones, boss bar), three disciplined procedures (GUI polish, release checklist, game feel) and a game-jam work mode. Curated, idempotent, settings as attributes, no invented asset ids.",
      items: [DAMAGE_NUMBERS, NPC_BRAIN, DOOR, DIALOGUE, COLLECTIBLES, ZONES, BOSS_BAR, GUI_POLISH, RELEASE_CHECK, GAME_FEEL, JAM_MODE],
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
      return { kind: it.kind, name: it.name, title: it.title, description: it.description, version: it.version, installed: !!have, installedVersion: have ? have.version : 0, modified: !!(have && Array.isArray(have.history) && have.history.length), upToDate: !!(have && have.version >= it.version) };
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
