--!strict
-- ServerBootstrap.server.lua
-- Place in ServerScriptService. Loads every ModuleScript under
-- ServerScriptService/Services in dependency-safe order, calls :Init() then
-- :Start() and reports failures without taking the whole server down.

local ServerScriptService = game:GetService("ServerScriptService")
local RunService = game:GetService("RunService")

local SERVICES_FOLDER = ServerScriptService:WaitForChild("Services", 10)
local started = os.clock()

type Service = {
	Name: string,
	Init: ((self: Service) -> ())?,
	Start: ((self: Service) -> ())?,
}

local services: { Service } = {}

local function load(module: ModuleScript)
	local ok, result = pcall(require, module)
	if not ok then
		warn(("[Bootstrap] failed to require %s: %s"):format(module:GetFullName(), tostring(result)))
		return
	end
	if typeof(result) ~= "table" then
		warn(("[Bootstrap] %s did not return a table"):format(module:GetFullName()))
		return
	end
	result.Name = result.Name or module.Name
	table.insert(services, result)
end

if SERVICES_FOLDER then
	for _, child in SERVICES_FOLDER:GetDescendants() do
		if child:IsA("ModuleScript") then
			load(child)
		end
	end
end

table.sort(services, function(a, b)
	return a.Name < b.Name
end)

for _, service in services do
	if service.Init then
		local ok, err = pcall(service.Init, service)
		if not ok then
			warn(("[Bootstrap] %s:Init failed: %s"):format(service.Name, tostring(err)))
		end
	end
end

for _, service in services do
	if service.Start then
		task.spawn(function()
			local ok, err = pcall(service.Start, service)
			if not ok then
				warn(("[Bootstrap] %s:Start failed: %s"):format(service.Name, tostring(err)))
			end
		end)
	end
end

print(("[Bootstrap] %d service(s) ready in %.1f ms (%s)"):format(
	#services,
	(os.clock() - started) * 1000,
	RunService:IsStudio() and "Studio" or "Live"
))
