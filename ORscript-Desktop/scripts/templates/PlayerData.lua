--!strict
-- PlayerData.lua (ModuleScript, ServerScriptService/Services)
-- DataStore wrapper with defaults, retries, autosave, BindToClose flush and
-- a leaderstats mirror. Returns a service table compatible with ServerBootstrap.

local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")
local RunService = game:GetService("RunService")

local STORE_NAME = "PlayerData_v1"
local AUTOSAVE_SECONDS = 120
local MAX_RETRIES = 4

export type Profile = {
	Coins: number,
	Level: number,
	Inventory: { string },
	Version: number,
}

local DEFAULTS: Profile = {
	Coins = 0,
	Level = 1,
	Inventory = {},
	Version = 1,
}

local PlayerData = { Name = "PlayerData" }
local store = DataStoreService:GetDataStore(STORE_NAME)
local profiles: { [Player]: Profile } = {}

local function deepCopy<T>(value: T): T
	if typeof(value) ~= "table" then
		return value
	end
	local copy = {}
	for k, v in value :: any do
		copy[k] = deepCopy(v)
	end
	return copy :: any
end

local function reconcile(data: any): Profile
	local profile = deepCopy(DEFAULTS)
	if typeof(data) == "table" then
		for key, default in DEFAULTS :: any do
			if data[key] ~= nil and typeof(data[key]) == typeof(default) then
				(profile :: any)[key] = data[key]
			end
		end
	end
	return profile
end

local function withRetry<T>(label: string, fn: () -> T): (boolean, T?)
	local delaySeconds = 1
	for attempt = 1, MAX_RETRIES do
		local ok, result = pcall(fn)
		if ok then
			return true, result
		end
		warn(("[PlayerData] %s attempt %d failed: %s"):format(label, attempt, tostring(result)))
		task.wait(delaySeconds)
		delaySeconds *= 2
	end
	return false, nil
end

local function buildLeaderstats(player: Player, profile: Profile)
	local folder = Instance.new("Folder")
	folder.Name = "leaderstats"
	local coins = Instance.new("IntValue")
	coins.Name = "Coins"
	coins.Value = profile.Coins
	coins.Parent = folder
	local level = Instance.new("IntValue")
	level.Name = "Level"
	level.Value = profile.Level
	level.Parent = folder
	folder.Parent = player
end

function PlayerData.Get(player: Player): Profile?
	return profiles[player]
end

function PlayerData.Update(player: Player, mutator: (Profile) -> ())
	local profile = profiles[player]
	if not profile then
		return
	end
	mutator(profile)
	local stats = player:FindFirstChild("leaderstats")
	if stats then
		local coins = stats:FindFirstChild("Coins") :: IntValue?
		local level = stats:FindFirstChild("Level") :: IntValue?
		if coins then coins.Value = profile.Coins end
		if level then level.Value = profile.Level end
	end
end

local function save(player: Player)
	local profile = profiles[player]
	if not profile or RunService:IsStudio() and not game:GetService("RunService"):IsRunning() then
		return
	end
	withRetry("save " .. player.Name, function()
		store:UpdateAsync(("player_%d"):format(player.UserId), function()
			return profile
		end)
	end)
end

local function onPlayerAdded(player: Player)
	local ok, data = withRetry("load " .. player.Name, function()
		return store:GetAsync(("player_%d"):format(player.UserId))
	end)
	if not ok then
		player:Kick("Your data could not be loaded. Please rejoin in a moment.")
		return
	end
	local profile = reconcile(data)
	profiles[player] = profile
	buildLeaderstats(player, profile)
end

local function onPlayerRemoving(player: Player)
	save(player)
	profiles[player] = nil
end

function PlayerData:Init()
	Players.PlayerAdded:Connect(onPlayerAdded)
	Players.PlayerRemoving:Connect(onPlayerRemoving)
	for _, player in Players:GetPlayers() do
		task.spawn(onPlayerAdded, player)
	end
end

function PlayerData:Start()
	task.spawn(function()
		while true do
			task.wait(AUTOSAVE_SECONDS)
			for player in profiles do
				task.spawn(save, player)
			end
		end
	end)
	game:BindToClose(function()
		for player in profiles do
			save(player)
		end
	end)
end

return PlayerData
