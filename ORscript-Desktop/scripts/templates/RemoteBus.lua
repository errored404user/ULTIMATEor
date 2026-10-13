--!strict
-- RemoteBus.lua (ModuleScript, ReplicatedStorage/Shared)
-- One place to declare remotes. Server side validates payload shapes and
-- rate-limits per player; client side gets typed helpers.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")

local FOLDER_NAME = "Remotes"
local RATE_LIMIT_PER_SECOND = 20

local RemoteBus = {}

local function folder(): Folder
	local existing = ReplicatedStorage:FindFirstChild(FOLDER_NAME)
	if existing then
		return existing :: Folder
	end
	local created = Instance.new("Folder")
	created.Name = FOLDER_NAME
	created.Parent = ReplicatedStorage
	return created
end

local function remote(name: string, className: "RemoteEvent" | "RemoteFunction"): Instance
	local root = folder()
	local existing = root:FindFirstChild(name)
	if existing then
		return existing
	end
	if RunService:IsClient() then
		return root:WaitForChild(name)
	end
	local created = Instance.new(className)
	created.Name = name
	created.Parent = root
	return created
end

type Validator = (...any) -> boolean

local buckets: { [Player]: { count: number, resetAt: number } } = {}

local function allowed(player: Player): boolean
	local now = os.clock()
	local bucket = buckets[player]
	if not bucket or now >= bucket.resetAt then
		bucket = { count = 0, resetAt = now + 1 }
		buckets[player] = bucket
	end
	bucket.count += 1
	return bucket.count <= RATE_LIMIT_PER_SECOND
end

if RunService:IsServer() then
	Players.PlayerRemoving:Connect(function(player)
		buckets[player] = nil
	end)
end

-- Server: RemoteBus.OnEvent("Jump", validator, function(player, ...) end)
function RemoteBus.OnEvent(name: string, validator: Validator?, handler: (Player, ...any) -> ()): RBXScriptConnection
	local event = remote(name, "RemoteEvent") :: RemoteEvent
	return event.OnServerEvent:Connect(function(player, ...)
		if not allowed(player) then
			return
		end
		if validator and not validator(...) then
			warn(("[RemoteBus] %s sent an invalid %s payload"):format(player.Name, name))
			return
		end
		handler(player, ...)
	end)
end

-- Server: RemoteBus.OnInvoke("GetProfile", validator, function(player, ...) return ... end)
function RemoteBus.OnInvoke(name: string, validator: Validator?, handler: (Player, ...any) -> ...any)
	local fn = remote(name, "RemoteFunction") :: RemoteFunction
	fn.OnServerInvoke = function(player, ...)
		if not allowed(player) then
			return nil
		end
		if validator and not validator(...) then
			return nil
		end
		return handler(player, ...)
	end
end

function RemoteBus.FireClient(name: string, player: Player, ...: any)
	(remote(name, "RemoteEvent") :: RemoteEvent):FireClient(player, ...)
end

function RemoteBus.FireAllClients(name: string, ...: any)
	(remote(name, "RemoteEvent") :: RemoteEvent):FireAllClients(...)
end

-- Client helpers
function RemoteBus.Fire(name: string, ...: any)
	(remote(name, "RemoteEvent") :: RemoteEvent):FireServer(...)
end

function RemoteBus.Invoke(name: string, ...: any): ...any
	return (remote(name, "RemoteFunction") :: RemoteFunction):InvokeServer(...)
end

function RemoteBus.OnClientEvent(name: string, handler: (...any) -> ()): RBXScriptConnection
	return (remote(name, "RemoteEvent") :: RemoteEvent).OnClientEvent:Connect(handler)
end

return RemoteBus
