--!nocheck
-- ORscript Studio plugin  (ORscript 1.23.0)
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- A tiny worker that lives INSIDE Roblox Studio and lets ORscript (the browser
-- extension, through the or-core desktop bridge on 127.0.0.1:3000) do work the
-- MCP helper cannot or does it faster:
--   * plugin-level APIs: CSG union/negate/separate, open a script at a line,
--     live script edits that the open editor picks up, FBX / file import
--     prompts, publish the selection, insert assets by id, ribbon tool,
--     undo/redo, camera framing for screenshots, place/user info
--   * execute_luau without the 20 s MCP round trip (or-core routes execute_luau
--     here while the plugin is connected; the MCP helper stays the fallback)
--   * monetisation helpers: writes the game-pass / developer-product handler
--     scripts and reports the universe id so ORscript can create the passes
--     through your roblox.com session or an Open Cloud key
--
-- Install: or-core copies this file to %LOCALAPPDATA%\Roblox\Plugins\ORscript.lua
-- (Windows) / ~/Documents/Roblox/Plugins/ORscript.lua (macOS) at startup, or
-- copy it there yourself. Studio loads local plugins on the next start / reload.
-- The first HTTP call asks you to allow requests to 127.0.0.1 - click Allow.
--
-- Protocol (all JSON over HTTP to or-core):
--   POST /api/plugin/hello   {client_id, version, place_name, place_id, universe_id, user_id, user_name, studio_version, capabilities, open_cloud_key?}
--   GET  /api/plugin/poll?client_id=...   -> {ok, job:{id,name,args}|null}   (long poll, ~20 s)
--   POST /api/plugin/result  {id, ok, result, error?}

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")
local ScriptEditorService = game:GetService("ScriptEditorService")
local StudioService = game:GetService("StudioService")
local InsertService = game:GetService("InsertService")
local RunService = game:GetService("RunService")
local ServerScriptService = game:GetService("ServerScriptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local MarketplaceService = game:GetService("MarketplaceService")

if not plugin then return end
if RunService:IsRunning() then return end -- edit mode only; play-test DataModels do not run the worker

local VERSION = "1.23.0"
local DEFAULT_BRIDGE = "http://127.0.0.1:3000"
local CLIENT_ID = "studio-plugin-" .. tostring(math.random(100000, 999999))
local CAPABILITIES = {
	"plugin_execute_luau", "csg_union", "csg_negate", "csg_separate", "open_script", "script_live_update",
	"studio_import_file", "studio_publish_selection", "studio_prompt_asset_id", "studio_insert_asset",
	"studio_place_info", "studio_select_tool", "studio_undo", "studio_redo", "studio_notify",
	"screenshot_frame", "gamepass_handler_create", "developer_product_handler_create", "studio_plugin_ping",
}

local hello -- defined with the worker loop below
local enabled = plugin:GetSetting("ORscriptEnabled")
if enabled == nil then enabled = true end
local bridgeUrl = plugin:GetSetting("ORscriptBridgeUrl") or DEFAULT_BRIDGE
local openCloudKey = plugin:GetSetting("ORscriptOpenCloudKey") or ""

-- ───────────────────────── widget ─────────────────────────
local toolbar = plugin:CreateToolbar("ORscript")
local button = toolbar:CreateButton("ORscriptPanel", "ORscript bridge status, settings and log", "rbxassetid://6031075931", "ORscript")
local widget = plugin:CreateDockWidgetPluginGui("ORscriptWidget", DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 340, 460, 260, 240))
widget.Title = "ORscript " .. VERSION
widget.Name = "ORscriptWidget"

local root = Instance.new("Frame")
root.Size = UDim2.new(1, 0, 1, 0)
root.BackgroundColor3 = Color3.fromRGB(24, 26, 32)
root.BorderSizePixel = 0
root.Parent = widget

local function mkLabel(text, y, h, size, color, bold)
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.Position = UDim2.new(0, 12, 0, y)
	l.Size = UDim2.new(1, -24, 0, h or 20)
	l.Font = bold and Enum.Font.GothamBold or Enum.Font.Gotham
	l.TextSize = size or 14
	l.TextColor3 = color or Color3.fromRGB(230, 232, 238)
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextWrapped = true
	l.Text = text
	l.Parent = root
	return l
end
local function mkBox(placeholder, y, value)
	local b = Instance.new("TextBox")
	b.Position = UDim2.new(0, 12, 0, y)
	b.Size = UDim2.new(1, -24, 0, 28)
	b.BackgroundColor3 = Color3.fromRGB(36, 39, 48)
	b.BorderSizePixel = 0
	b.Font = Enum.Font.Code
	b.TextSize = 13
	b.TextColor3 = Color3.fromRGB(235, 236, 240)
	b.PlaceholderText = placeholder
	b.ClearTextOnFocus = false
	b.Text = value or ""
	b.TextXAlignment = Enum.TextXAlignment.Left
	local pad = Instance.new("UIPadding") pad.PaddingLeft = UDim.new(0, 8) pad.Parent = b
	local c = Instance.new("UICorner") c.CornerRadius = UDim.new(0, 6) c.Parent = b
	b.Parent = root
	return b
end
local function mkButton(text, y, x, w)
	local b = Instance.new("TextButton")
	b.Position = UDim2.new(0, x or 12, 0, y)
	b.Size = UDim2.new(0, w or 150, 0, 28)
	b.BackgroundColor3 = Color3.fromRGB(241, 196, 15)
	b.BorderSizePixel = 0
	b.Font = Enum.Font.GothamBold
	b.TextSize = 13
	b.TextColor3 = Color3.fromRGB(28, 24, 10)
	b.Text = text
	local c = Instance.new("UICorner") c.CornerRadius = UDim.new(0, 6) c.Parent = b
	b.Parent = root
	return b
end

mkLabel("ORscript Studio bridge", 10, 22, 17, Color3.fromRGB(241, 196, 15), true)
local statusLabel = mkLabel("starting…", 34, 20, 13, Color3.fromRGB(180, 184, 194))
local placeLabel = mkLabel("", 54, 36, 12, Color3.fromRGB(150, 154, 164))
mkLabel("Bridge URL (or-core)", 94, 18, 12, Color3.fromRGB(150, 154, 164))
local urlBox = mkBox(DEFAULT_BRIDGE, 112, bridgeUrl)
mkLabel("Open Cloud API key (optional - lets or-core create game passes / products without a browser session; stored only in this plugin's settings and sent to 127.0.0.1)", 146, 44, 11, Color3.fromRGB(150, 154, 164))
local keyBox = mkBox("rbx-cloud key with Game Passes + Developer Products write access", 192, openCloudKey)
local toggleBtn = mkButton(enabled and "Pause worker" or "Resume worker", 230, 12, 150)
local saveBtn = mkButton("Save settings", 230, 172, 150)
mkLabel("Log", 268, 18, 12, Color3.fromRGB(150, 154, 164))
local logBox = Instance.new("TextLabel")
logBox.Position = UDim2.new(0, 12, 0, 286)
logBox.Size = UDim2.new(1, -24, 1, -298)
logBox.BackgroundColor3 = Color3.fromRGB(18, 19, 24)
logBox.BorderSizePixel = 0
logBox.Font = Enum.Font.Code
logBox.TextSize = 12
logBox.TextColor3 = Color3.fromRGB(200, 204, 214)
logBox.TextXAlignment = Enum.TextXAlignment.Left
logBox.TextYAlignment = Enum.TextYAlignment.Bottom
logBox.TextWrapped = true
logBox.Text = ""
local lc = Instance.new("UICorner") lc.CornerRadius = UDim.new(0, 6) lc.Parent = logBox
local lp = Instance.new("UIPadding") lp.PaddingLeft = UDim.new(0, 8) lp.PaddingRight = UDim.new(0, 8) lp.PaddingBottom = UDim.new(0, 6) lp.Parent = logBox
logBox.Parent = root

local logLines = {}
local function log(msg)
	local line = os.date("%H:%M:%S") .. "  " .. tostring(msg)
	table.insert(logLines, line)
	while #logLines > 60 do table.remove(logLines, 1) end
	logBox.Text = table.concat(logLines, "\n")
end
local function setStatus(text, ok)
	statusLabel.Text = text
	statusLabel.TextColor3 = ok and Color3.fromRGB(110, 220, 140) or Color3.fromRGB(235, 120, 110)
end

button.Click:Connect(function() widget.Enabled = not widget.Enabled end)
toggleBtn.MouseButton1Click:Connect(function()
	enabled = not enabled
	plugin:SetSetting("ORscriptEnabled", enabled)
	toggleBtn.Text = enabled and "Pause worker" or "Resume worker"
	log(enabled and "worker resumed" or "worker paused")
end)
saveBtn.MouseButton1Click:Connect(function()
	bridgeUrl = (urlBox.Text ~= "" and urlBox.Text or DEFAULT_BRIDGE):gsub("/+$", "")
	openCloudKey = keyBox.Text or ""
	plugin:SetSetting("ORscriptBridgeUrl", bridgeUrl)
	plugin:SetSetting("ORscriptOpenCloudKey", openCloudKey)
	log("settings saved (" .. bridgeUrl .. (openCloudKey ~= "" and ", Open Cloud key set" or "") .. ")")
	task.spawn(function() pcall(function() hello() end) end)
end)

-- ───────────────────────── helpers ─────────────────────────
local function placeInfo()
	local userId, userName = 0, ""
	pcall(function() userId = StudioService:GetUserId() end)
	pcall(function() userName = game:GetService("Players"):GetNameFromUserIdAsync(userId) end)
	return {
		place_name = game.Name,
		place_id = game.PlaceId,
		universe_id = game.GameId,
		creator_id = game.CreatorId,
		creator_type = tostring(game.CreatorType),
		user_id = userId,
		user_name = userName,
		studio_version = version(),
		is_published = game.GameId > 0,
	}
end
placeLabel.Text = string.format("%s  ·  place %d  ·  universe %d", game.Name, game.PlaceId, game.GameId)

local function resolve(p)
	if p == nil or p == "" then return nil end
	if typeof(p) == "Instance" then return p end
	p = tostring(p):gsub("^%s+", ""):gsub("%s+$", ""):gsub("/", "."):gsub("^Game%.", "game."):gsub("^workspace%.", "Workspace.")
	if p == "game" then return game end
	if p:sub(1, 5) == "game." then p = p:sub(6) end
	local cur = game
	for seg in p:gmatch("[^%.]+") do
		local nxt = cur:FindFirstChild(seg)
		if not nxt and cur == game then
			local okS, svc = pcall(function() return game:GetService(seg) end)
			if okS then nxt = svc end
		end
		if not nxt then
			-- bare-name fallback on the last segment
			if cur == game then
				for _, r in ipairs({ workspace, ReplicatedStorage, game:GetService("ServerStorage"), ServerScriptService, game:GetService("StarterGui"), game:GetService("StarterPlayer"), game:GetService("Lighting") }) do
					local hit = r:FindFirstChild(seg, true)
					if hit then nxt = hit break end
				end
			end
			if not nxt then return nil end
		end
		cur = nxt
	end
	return cur
end
local function need(p, what)
	local i = resolve(p)
	if not i then error((what or "instance") .. " not found: " .. tostring(p)) end
	return i
end
local function record(label)
	local okR, rec = pcall(function() return ChangeHistoryService:TryBeginRecording("ORscript " .. tostring(label)) end)
	return okR and rec or nil
end
local function commit(rec)
	if rec then pcall(function() ChangeHistoryService:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
end
local function newScript(class, name, parent, src)
	local old = parent:FindFirstChild(name)
	if old and old:IsA("LuaSourceContainer") then
		return old, false
	end
	local s = Instance.new(class)
	s.Name = name
	s.Source = src
	s.Parent = parent
	return s, true
end
local function encode(v)
	local okE, s = pcall(function() return HttpService:JSONEncode(v) end)
	return okE and s or tostring(v)
end

-- ───────────────────────── job handlers ─────────────────────────
local H = {}

function H.studio_plugin_ping(a)
	return { pong = true, version = VERSION, place = placeInfo() }
end

function H.studio_place_info(a)
	local info = placeInfo()
	info.selection = {}
	for _, s in ipairs(Selection:Get()) do table.insert(info.selection, s:GetFullName()) end
	info.active_script = StudioService.ActiveScript and StudioService.ActiveScript:GetFullName() or nil
	info.camera = workspace.CurrentCamera and tostring(workspace.CurrentCamera.CFrame.Position) or nil
	return info
end

-- execute_luau in plugin context. Prints are captured; the return value is
-- rendered exactly like the MCP helper does (string as-is, table as JSON).
function H.plugin_execute_luau(a)
	local code = tostring(a.code or "")
	if code == "" then error("code is required") end
	local fn, err = loadstring(code, "=ORscript")
	if not fn then error("Luau syntax error: " .. tostring(err)) end
	local out = {}
	local env = setmetatable({
		plugin = plugin,
		print = function(...) local parts = {} for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end out[#out + 1] = table.concat(parts, " ") end,
		warn = function(...) local parts = {} for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end out[#out + 1] = "[warn] " .. table.concat(parts, " ") end,
	}, { __index = getfenv() })
	setfenv(fn, env)
	local rec = record("execute_luau")
	local results = { pcall(fn) }
	commit(rec)
	if not results[1] then
		error(tostring(results[2]))
	end
	local text = table.concat(out, "\n")
	if #results > 1 then
		local r = results[2]
		local rendered
		if typeof(r) == "string" then rendered = r
		elseif typeof(r) == "table" then rendered = encode(r)
		else rendered = tostring(r) end
		text = text ~= "" and (text .. "\n" .. rendered) or rendered
	end
	return { __text = text }
end

local function csgParts(paths)
	local parts = {}
	for _, p in ipairs(paths or {}) do
		local inst = need(p, "part")
		if inst:IsA("BasePart") then table.insert(parts, inst)
		else for _, d in ipairs(inst:GetDescendants()) do if d:IsA("BasePart") then table.insert(parts, d) end end end
	end
	return parts
end
function H.csg_union(a)
	local paths = a.paths or (a.path and { a.path }) or {}
	if #paths == 0 then
		for _, s in ipairs(Selection:Get()) do table.insert(paths, s) end
	end
	local parts = csgParts(paths)
	if #parts < 2 then error("csg_union needs at least two BaseParts (paths array or a selection)") end
	local rec = record("union")
	local union = plugin:Union(parts)
	if a.name and a.name ~= "" then union.Name = tostring(a.name) end
	union.Parent = union.Parent or parts[1].Parent or workspace
	commit(rec)
	Selection:Set({ union })
	return { path = union:GetFullName(), parts = #parts, class = union.ClassName }
end
function H.csg_negate(a)
	local parts = csgParts(a.paths or (a.path and { a.path }) or {})
	if #parts == 0 then for _, s in ipairs(Selection:Get()) do if s:IsA("BasePart") then table.insert(parts, s) end end end
	if #parts == 0 then error("csg_negate needs a part path or a selection") end
	local rec = record("negate")
	local negated = plugin:Negate(parts)
	commit(rec)
	local out = {}
	for _, n in ipairs(negated) do table.insert(out, n:GetFullName()) end
	Selection:Set(negated)
	return { negated = out, count = #out, hint = "csg_union the negated part together with the part it should cut" }
end
function H.csg_separate(a)
	local inst = a.path and need(a.path, "union") or Selection:Get()[1]
	if not inst then error("csg_separate needs a union path or a selection") end
	local list = {}
	if inst:IsA("UnionOperation") then table.insert(list, inst)
	else for _, d in ipairs(inst:GetDescendants()) do if d:IsA("UnionOperation") then table.insert(list, d) end end end
	if #list == 0 then error("no UnionOperation at " .. inst:GetFullName()) end
	local rec = record("separate")
	local pieces = plugin:Separate(list)
	commit(rec)
	local out = {}
	for _, p in ipairs(pieces) do table.insert(out, p:GetFullName()) end
	return { pieces = out, count = #out }
end

function H.open_script(a)
	local s = need(a.path, "script")
	if not s:IsA("LuaSourceContainer") then error("not a script: " .. s:GetFullName()) end
	plugin:OpenScript(s, tonumber(a.line) or 1)
	return { path = s:GetFullName(), line = tonumber(a.line) or 1 }
end
function H.script_live_update(a)
	local s = need(a.path, "script")
	if not s:IsA("LuaSourceContainer") then error("not a script: " .. s:GetFullName()) end
	local src = tostring(a.source or "")
	local rec = record("script edit")
	local okU, errU = pcall(function()
		ScriptEditorService:UpdateSourceAsync(s, function() return src end)
	end)
	if not okU then s.Source = src end
	commit(rec)
	return { path = s:GetFullName(), bytes = #src, via = okU and "ScriptEditorService" or "Source" }
end

function H.studio_import_file(a)
	local kind = tostring(a.kind or "file"):lower()
	if kind == "fbx_rig" or kind == "rig" then
		local m = plugin:ImportFbxRig(a.r15 == true)
		if not m then error("import cancelled") end
		return { path = m:GetFullName(), kind = "rig" }
	elseif kind == "fbx_animation" or kind == "animation" then
		local rig = a.rig_path and need(a.rig_path, "rig") or Selection:Get()[1]
		if not rig then error("fbx_animation needs rig_path or a selected rig") end
		local ks = plugin:ImportFbxAnimation(rig, a.is_r15 == true)
		if not ks then error("import cancelled") end
		return { path = ks:GetFullName(), kind = "animation" }
	else
		local okF, file = pcall(function() return StudioService:PromptImportFile(a.extensions) end)
		if not okF then error("import failed: " .. tostring(file)) end
		if not file then error("import cancelled") end
		local size = 0
		pcall(function() size = file.Size end)
		local text = nil
		if a.read_text ~= false and size < 1000000 then pcall(function() text = file:GetBinaryContents() end) end
		return { name = file.Name, size = size, text = text and text:sub(1, 20000) or nil }
	end
end
function H.studio_publish_selection(a)
	if a.paths then Selection:Set((function() local t = {} for _, p in ipairs(a.paths) do table.insert(t, need(p)) end return t end)()) end
	if #Selection:Get() == 0 then error("select (or pass paths for) the model to publish") end
	plugin:SaveSelectedToRoblox()
	return { prompted = true, hint = "finish the Publish dialog in Studio; use creator.getPublishedAsset {assetId} afterwards" }
end
function H.studio_prompt_asset_id(a)
	local id = plugin:PromptForExistingAssetId(tostring(a.asset_type or "Model"))
	if not id or id < 1 then error("no asset chosen") end
	return { asset_id = id }
end
function H.studio_insert_asset(a)
	local id = tonumber(a.asset_id or a.id)
	if not id then error("asset_id is required") end
	local parent = a.parent and need(a.parent, "parent") or workspace
	local rec = record("insert asset")
	local okI, model = pcall(function() return InsertService:LoadAsset(id) end)
	if not okI then commit(rec) error("LoadAsset failed: " .. tostring(model)) end
	local kids = model:GetChildren()
	local out = {}
	for _, k in ipairs(kids) do k.Parent = parent table.insert(out, k:GetFullName()) end
	model:Destroy()
	commit(rec)
	Selection:Set((function() local t = {} for _, p in ipairs(out) do local i = resolve(p) if i then table.insert(t, i) end end return t end)())
	return { inserted = out, count = #out }
end
function H.studio_select_tool(a)
	local map = { select = Enum.RibbonTool.Select, move = Enum.RibbonTool.Move, scale = Enum.RibbonTool.Scale, rotate = Enum.RibbonTool.Rotate, transform = Enum.RibbonTool.Transform, none = Enum.RibbonTool.None }
	local tool = map[tostring(a.tool or "select"):lower()]
	if not tool then error("tool must be select|move|scale|rotate|transform|none") end
	plugin:SelectRibbonTool(tool, UDim2.new())
	return { tool = tool.Name }
end
function H.studio_undo(a)
	local n = math.clamp(tonumber(a.steps) or 1, 1, 50)
	for _ = 1, n do ChangeHistoryService:Undo() end
	return { undone = n }
end
function H.studio_redo(a)
	local n = math.clamp(tonumber(a.steps) or 1, 1, 50)
	for _ = 1, n do ChangeHistoryService:Redo() end
	return { redone = n }
end
function H.studio_notify(a)
	local text = tostring(a.title or "ORscript") .. (a.message and (": " .. tostring(a.message)) or "")
	log(text)
	if tostring(a.kind or ""):lower() == "warn" then warn("[ORscript] " .. text) else print("[ORscript] " .. text) end
	widget.Enabled = true
	return { shown = true }
end

-- Frame the Studio camera on a target so the next screen_capture / or_screenshot
-- is a deliberate shot (orbit angle in degrees, distance as a multiple of the
-- target's size). Optionally clears the selection so no blue outline shows.
function H.screenshot_frame(a)
	local cam = workspace.CurrentCamera
	if not cam then error("no camera") end
	local target = a.path and need(a.path, "target") or Selection:Get()[1]
	local cf, size
	if target then
		if target:IsA("Model") then cf, size = target:GetBoundingBox()
		elseif target:IsA("BasePart") then cf, size = target.CFrame, target.Size
		else cf, size = CFrame.new(), Vector3.new(10, 10, 10) end
	else
		cf, size = CFrame.new(0, 5, 0), Vector3.new(40, 10, 40)
	end
	local radius = math.max(size.X, size.Y, size.Z) * (tonumber(a.distance) or 1.8) + 2
	local yaw = math.rad(tonumber(a.yaw) or 35)
	local pitch = math.rad(tonumber(a.pitch) or 22)
	local offset = Vector3.new(math.sin(yaw) * math.cos(pitch), math.sin(pitch), math.cos(yaw) * math.cos(pitch)) * radius
	cam.CameraType = Enum.CameraType.Scriptable
	cam.CFrame = CFrame.lookAt(cf.Position + offset, cf.Position)
	if a.fov then cam.FieldOfView = math.clamp(tonumber(a.fov) or 70, 20, 120) end
	cam.CameraType = Enum.CameraType.Fixed
	if a.hide_selection ~= false then Selection:Set({}) end
	return { target = target and target:GetFullName() or nil, camera = { cam.CFrame.Position.X, cam.CFrame.Position.Y, cam.CFrame.Position.Z }, radius = radius, hint = "now call or_screenshot {target:'studio'}" }
end

-- Monetisation handlers: real production scripts for a pass / product id.
local function luaStr(s) return string.format("%q", tostring(s or "")) end
function H.gamepass_handler_create(a)
	local id = tonumber(a.gamepass_id or a.id)
	if not id then error("gamepass_id is required (create the pass first with gamepass_create)") end
	local name = tostring(a.name or ("GamePass" .. id)):gsub("[^%w_]", "")
	local benefit = tostring(a.benefit or "custom"):lower()
	local amount = tonumber(a.amount) or 0
	local grant
	if benefit == "speed" then grant = "\t\tlocal char = player.Character\n\t\tlocal hum = char and char:FindFirstChildOfClass(\"Humanoid\")\n\t\tif hum then hum.WalkSpeed = " .. tostring(amount > 0 and amount or 32) .. " end\n\t\tplayer.CharacterAdded:Connect(function(c)\n\t\t\tlocal h = c:WaitForChild(\"Humanoid\")\n\t\t\th.WalkSpeed = " .. tostring(amount > 0 and amount or 32) .. "\n\t\tend)"
	elseif benefit == "coins" or benefit == "currency" then grant = "\t\tlocal stats = player:FindFirstChild(\"leaderstats\")\n\t\tlocal coins = stats and (stats:FindFirstChild(\"Coins\") or stats:FindFirstChild(\"Cash\"))\n\t\tif coins then coins.Value += " .. tostring(amount > 0 and amount or 100) .. " end"
	elseif benefit == "tool" then grant = "\t\tlocal tool = game:GetService(\"ServerStorage\"):FindFirstChild(" .. luaStr(a.tool_name or name) .. ")\n\t\tif tool then\n\t\t\ttool:Clone().Parent = player:WaitForChild(\"Backpack\")\n\t\t\ttool:Clone().Parent = player:WaitForChild(\"StarterGear\")\n\t\tend"
	else grant = "\t\t-- TODO: grant the " .. name .. " benefit here" end
	local src = table.concat({
		"--!strict",
		"-- " .. name .. " game pass handler (id " .. tostring(id) .. ") - generated by ORscript gamepass_handler_create.",
		"local MarketplaceService = game:GetService(\"MarketplaceService\")",
		"local Players = game:GetService(\"Players\")",
		"",
		"local GAMEPASS_ID = " .. tostring(id),
		"local owners: { [Player]: boolean } = {}",
		"",
		"local function grant(player: Player)",
		"\tif owners[player] then return end",
		"\towners[player] = true",
		grant,
		"end",
		"",
		"local function check(player: Player)",
		"\tlocal ok, owns = pcall(function()",
		"\t\treturn MarketplaceService:UserOwnsGamePassAsync(player.UserId, GAMEPASS_ID)",
		"\tend)",
		"\tif ok and owns then grant(player) end",
		"end",
		"",
		"Players.PlayerAdded:Connect(check)",
		"for _, p in ipairs(Players:GetPlayers()) do task.spawn(check, p) end",
		"Players.PlayerRemoving:Connect(function(p) owners[p] = nil end)",
		"",
		"MarketplaceService.PromptGamePassPurchaseFinished:Connect(function(player, passId, purchased)",
		"\tif purchased and passId == GAMEPASS_ID then grant(player) end",
		"end)",
		"",
		"-- Client: MarketplaceService:PromptGamePassPurchase(Players.LocalPlayer, " .. tostring(id) .. ")",
	}, "\n")
	local rec = record("gamepass handler")
	local s, created = newScript("Script", name .. "PassHandler", ServerScriptService, src)
	local folder = ReplicatedStorage:FindFirstChild("Monetization") or Instance.new("Folder")
	folder.Name = "Monetization"
	folder.Parent = ReplicatedStorage
	local marker = folder:FindFirstChild(name) or Instance.new("IntValue")
	marker.Name = name
	marker.Value = id
	marker:SetAttribute("Kind", "GamePass")
	marker.Parent = folder
	commit(rec)
	return { script = s:GetFullName(), created = created, marker = marker:GetFullName(), gamepass_id = id, benefit = benefit }
end
function H.developer_product_handler_create(a)
	local id = tonumber(a.product_id or a.id)
	if not id then error("product_id is required") end
	local name = tostring(a.name or ("Product" .. id)):gsub("[^%w_]", "")
	local src = table.concat({
		"--!strict",
		"-- " .. name .. " developer product (id " .. tostring(id) .. ") - generated by ORscript developer_product_handler_create.",
		"-- NOTE: only ONE script may set MarketplaceService.ProcessReceipt. Merge into your existing receipt router if you have one.",
		"local MarketplaceService = game:GetService(\"MarketplaceService\")",
		"local Players = game:GetService(\"Players\")",
		"local DataStoreService = game:GetService(\"DataStoreService\")",
		"",
		"local PRODUCT_ID = " .. tostring(id),
		"local receipts = DataStoreService:GetDataStore(\"ORscript_Receipts\")",
		"",
		"local function grant(player: Player): boolean",
		"\t-- TODO: give the " .. name .. " purchase (return false to retry later)",
		"\treturn true",
		"end",
		"",
		"MarketplaceService.ProcessReceipt = function(info)",
		"\tif info.ProductId ~= PRODUCT_ID then return Enum.ProductPurchaseDecision.NotProcessedYet end",
		"\tlocal key = info.PlayerId .. \"_\" .. info.PurchaseId",
		"\tlocal already = false",
		"\tpcall(function() already = receipts:GetAsync(key) == true end)",
		"\tif already then return Enum.ProductPurchaseDecision.PurchaseGranted end",
		"\tlocal player = Players:GetPlayerByUserId(info.PlayerId)",
		"\tif not player then return Enum.ProductPurchaseDecision.NotProcessedYet end",
		"\tlocal ok, granted = pcall(grant, player)",
		"\tif not (ok and granted) then return Enum.ProductPurchaseDecision.NotProcessedYet end",
		"\tpcall(function() receipts:SetAsync(key, true) end)",
		"\treturn Enum.ProductPurchaseDecision.PurchaseGranted",
		"end",
		"",
		"-- Client: MarketplaceService:PromptProductPurchase(Players.LocalPlayer, " .. tostring(id) .. ")",
	}, "\n")
	local rec = record("product handler")
	local s, created = newScript("Script", name .. "ProductHandler", ServerScriptService, src)
	commit(rec)
	return { script = s:GetFullName(), created = created, product_id = id }
end

-- ───────────────────────── worker loop ─────────────────────────
local function request(method, path, body)
	local okH, res = pcall(function()
		return HttpService:RequestAsync({
			Url = bridgeUrl .. path,
			Method = method,
			Headers = { ["Content-Type"] = "application/json" },
			Body = body and HttpService:JSONEncode(body) or nil,
		})
	end)
	if not okH then return nil, tostring(res) end
	if not res.Success then return nil, "HTTP " .. tostring(res.StatusCode) .. " " .. tostring(res.Body):sub(1, 200) end
	local okJ, data = pcall(function() return HttpService:JSONDecode(res.Body) end)
	if not okJ then return nil, "bad JSON from bridge" end
	return data, nil
end

hello = function()
	local info = placeInfo()
	info.client_id = CLIENT_ID
	info.version = VERSION
	info.capabilities = CAPABILITIES
	if openCloudKey ~= "" then info.open_cloud_key = openCloudKey end
	local data, err = request("POST", "/api/plugin/hello", info)
	if data and data.ok then
		setStatus("connected to or-core " .. tostring(data.version or "") .. (data.key_set and "  ·  Open Cloud key set" or ""), true)
		return true
	end
	setStatus("or-core not reachable at " .. bridgeUrl .. " (" .. tostring(err or (data and data.error) or "?") .. ")", false)
	return false
end

local function runJob(job)
	local handler = H[job.name]
	local started = os.clock()
	local result
	if not handler then
		result = { id = job.id, ok = false, error = "unknown plugin command '" .. tostring(job.name) .. "' (plugin " .. VERSION .. ")" }
	else
		local okR, res = pcall(handler, job.args or {})
		if okR then
			if typeof(res) == "table" and res.__text ~= nil then
				result = { id = job.id, ok = true, result = res.__text, text = true }
			else
				result = { id = job.id, ok = true, result = res }
			end
		else
			result = { id = job.id, ok = false, error = tostring(res):gsub("^.-:%d+:%s*", "") }
		end
	end
	result.elapsed_ms = math.floor((os.clock() - started) * 1000)
	log(string.format("%s %s (%d ms)", result.ok and "ok " or "ERR", tostring(job.name), result.elapsed_ms))
	request("POST", "/api/plugin/result", result)
end

local unloading = false
plugin.Unloading:Connect(function() unloading = true end)

task.spawn(function()
	pcall(function() HttpService.HttpEnabled = true end)
	local connected = false
	local lastHello = 0
	while not unloading do
		if not enabled then
			setStatus("paused", false)
			task.wait(1)
			continue
		end
		if os.clock() - lastHello > 25 or not connected then
			connected = hello()
			lastHello = os.clock()
			if not connected then task.wait(3) continue end
		end
		local data, err = request("GET", "/api/plugin/poll?client_id=" .. CLIENT_ID)
		if not data then
			connected = false
			setStatus("lost or-core: " .. tostring(err), false)
			task.wait(2)
		elseif data.job then
			task.spawn(runJob, data.job)
		end
	end
end)

log("ORscript plugin " .. VERSION .. " loaded - open the ORscript panel from the Plugins tab")
