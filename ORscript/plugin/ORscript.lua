--!nocheck
-- ORscript Studio plugin  (ORscript 1.53.0)
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
--   * 1.24.0 FULL STUDIO CONTROL: run/pause/stop, settings(), selection,
--     camera, script-editor documents, change history, any service method or
--     property (studio_service_call), persistent toolbar macros, Save /
--     Publish dialogs, TestService, Output log, viewport ray
--   * 1.24.0 OTHER PLUGINS: discovery (widgets, saves, PluginDebugService,
--     shared/_G APIs), the ORscript plugin bus other plugins can register on
--     (shared.ORscript / CoreGui.ORscriptBus), invoking their Bindables /
--     modules, reading their source, showing / hiding their panels
--   * 1.24.0 ECLIPSE ANIMATOR bridge: detect, open on a rig, hand ORscript
--     clips to Eclipse through <rig>.AnimSaves, import Eclipse saves / Module
--     Exporter tables as KeyframeSequences, preview clips in edit mode
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

local VERSION = "1.53.0"
local DEFAULT_BRIDGE = "http://127.0.0.1:3000"
local CLIENT_ID = "studio-plugin-" .. tostring(math.random(100000, 999999))
local CAPABILITIES = {
	"plugin_execute_luau", "csg_union", "csg_negate", "csg_separate", "open_script", "script_live_update",
	"studio_import_file", "studio_publish_selection", "studio_prompt_asset_id", "studio_insert_asset",
	"studio_place_info", "studio_select_tool", "studio_undo", "studio_redo", "studio_notify",
	"screenshot_frame", "gamepass_handler_create", "developer_product_handler_create", "studio_plugin_ping",
	-- 1.24.0
	"studio_playtest", "studio_settings", "studio_selection", "studio_camera", "studio_script_editor", "studio_history",
	"studio_service_call", "studio_macro", "studio_save", "studio_output", "studio_test_run", "studio_mouse",
	"plugins_list", "plugin_widget", "plugin_invoke", "plugin_module_call", "plugin_source_read",
	"eclipse_status", "eclipse_open", "eclipse_handoff", "eclipse_import", "eclipse_play",
	-- 1.45.0 animation publishing
	"animation_export", "animation_apply",
}
local ORSCRIPT_ENV = {} -- helper table exposed to plugin_execute_luau as `ORscript` (filled below)

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
mkLabel("Open Cloud API key (optional - lets or-core create game passes / products and publish animations without a browser session; scopes game-pass:write, developer-product:write, asset:write; stored only in this plugin's settings and sent to 127.0.0.1)", 146, 44, 11, Color3.fromRGB(150, 154, 164))
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
		ORscript = ORSCRIPT_ENV,
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

-- ═════════════════════ 1.24.0: full Studio control ═════════════════════
-- Everything below runs with plugin security inside Studio. Together with
-- plugin_execute_luau (which exposes `plugin` and the `ORscript` helper table)
-- this is the complete surface Studio offers a plugin: run/pause/stop,
-- settings(), selection, camera, the script editor documents, change history,
-- any service method (studio_service_call), toolbar macros, Save-to-Roblox,
-- TestService, the Output log and a mouse/camera ray.
local CoreGui = game:GetService("CoreGui")
local LogService = game:GetService("LogService")
local TestService = game:GetService("TestService")
local UserInputService = game:GetService("UserInputService")
local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")
local ServerStorage = game:GetService("ServerStorage")

local function pathsOf(list)
	local t = {}
	for _, i in ipairs(list) do t[#t + 1] = i:GetFullName() end
	return t
end
local function listArg(v)
	if v == nil then return {} end
	if type(v) == "table" then return v end
	return { v }
end
-- instances named by a.paths / a.path, else the selection
local function targets(a)
	local list = listArg(a.paths)
	if #list == 0 and a.path then list = { a.path } end
	if #list == 0 then return Selection:Get() end
	local out = {}
	for _, p in ipairs(list) do out[#out + 1] = need(p) end
	return out
end
local function numbers(v, n)
	if typeof(v) == "Vector3" then return { v.X, v.Y, v.Z } end
	if type(v) == "string" then
		local t = {}
		for num in v:gmatch("[-%d%.eE]+") do t[#t + 1] = tonumber(num) end
		v = t
	end
	if type(v) ~= "table" then return nil end
	local t = {}
	for i = 1, (n or #v) do t[i] = tonumber(v[i]) if t[i] == nil then return nil end end
	return t
end
local function toVector3(v)
	if typeof(v) == "Vector3" then return v end
	if type(v) == "table" and v.X ~= nil then return Vector3.new(tonumber(v.X) or 0, tonumber(v.Y) or 0, tonumber(v.Z) or 0) end
	if type(v) == "table" and v.x ~= nil then return Vector3.new(tonumber(v.x) or 0, tonumber(v.y) or 0, tonumber(v.z) or 0) end
	local t = numbers(v, 3)
	return t and Vector3.new(t[1], t[2], t[3]) or nil
end
local function toCFrame(v)
	if typeof(v) == "CFrame" then return v end
	if typeof(v) == "Vector3" then return CFrame.new(v) end
	if type(v) == "table" then
		if v.Position ~= nil or v.position ~= nil or v.pos ~= nil then
			local pos = toVector3(v.Position or v.position or v.pos) or Vector3.zero
			local rot = v.Rotation or v.rotation or v.Orientation or v.orientation or v.rot
			local r = rot and numbers(rot, 3)
			if r then return CFrame.new(pos) * CFrame.fromOrientation(math.rad(r[1]), math.rad(r[2]), math.rad(r[3])) end
			local look = toVector3(v.LookVector or v.lookVector or v.look)
			if look then return CFrame.lookAt(pos, pos + look) end
			return CFrame.new(pos)
		end
		if v.components then return toCFrame(v.components) end
		local t = numbers(v)
		if t and #t == 12 then return CFrame.new(table.unpack(t)) end
		if t and #t == 7 then return CFrame.new(t[1], t[2], t[3], t[4], t[5], t[6], t[7]) end
		if t and #t == 6 then return CFrame.new(t[1], t[2], t[3]) * CFrame.fromOrientation(math.rad(t[4]), math.rad(t[5]), math.rad(t[6])) end
		if t and #t == 3 then return CFrame.new(t[1], t[2], t[3]) end
	elseif type(v) == "string" then
		return toCFrame(numbers(v))
	end
	return nil
end
local function enumFrom(s)
	if typeof(s) == "EnumItem" then return s end
	if type(s) ~= "string" then return nil end
	local e, item = s:match("^Enum%.(%w+)%.(%w+)$")
	if not e then return nil end
	local okE, v = pcall(function() return Enum[e][item] end)
	return okE and v or nil
end
-- JSON → Studio value: "Enum.X.Y", instance paths, {__type="Vector3"|"CFrame"|"Color3"|"UDim2"|"Vector2"|"NumberRange"|"BrickColor"}, plain values
local function fromJson(v)
	if type(v) == "string" then
		local e = enumFrom(v)
		if e then return e end
		if v:match("^game%.") or v:match("^Workspace%.") or v:match("^workspace%.") then
			local inst = resolve(v)
			if inst then return inst end
		end
		return v
	elseif type(v) == "table" then
		local ty = v.__type or v.type
		if ty == "Vector3" then return toVector3(v.value or v) end
		if ty == "CFrame" then return toCFrame(v.value or v) end
		if ty == "Color3" then local t = numbers(v.value or v, 3) return t and ((t[1] > 1 or t[2] > 1 or t[3] > 1) and Color3.fromRGB(t[1], t[2], t[3]) or Color3.new(t[1], t[2], t[3])) end
		if ty == "Vector2" then local t = numbers(v.value or v, 2) return t and Vector2.new(t[1], t[2]) end
		if ty == "UDim2" then local t = numbers(v.value or v, 4) return t and UDim2.new(t[1], t[2], t[3], t[4]) end
		if ty == "NumberRange" then local t = numbers(v.value or v, 2) return t and NumberRange.new(t[1], t[2]) end
		if ty == "BrickColor" then return BrickColor.new(tostring(v.value or v[1])) end
		if ty == "Instance" then return resolve(v.value or v.path) end
		local out = {}
		for k, x in pairs(v) do if k ~= "__type" then out[k] = fromJson(x) end end
		return out
	end
	return v
end
-- Studio value → JSON-safe (depth/size limited)
local function toJson(v, depth)
	depth = depth or 0
	local ty = typeof(v)
	if ty == "Instance" then return v:GetFullName() end
	if ty == "EnumItem" then return tostring(v) end
	if ty == "Vector3" then return { v.X, v.Y, v.Z } end
	if ty == "Vector2" then return { v.X, v.Y } end
	if ty == "CFrame" then return { v:GetComponents() } end
	if ty == "Color3" then return { math.floor(v.R * 255 + 0.5), math.floor(v.G * 255 + 0.5), math.floor(v.B * 255 + 0.5) } end
	if ty == "UDim2" then return { v.X.Scale, v.X.Offset, v.Y.Scale, v.Y.Offset } end
	if ty == "function" or ty == "thread" or ty == "userdata" or ty == "RBXScriptSignal" or ty == "RBXScriptConnection" then return "<" .. ty .. ">" end
	if ty == "table" then
		if depth > 5 then return "<table>" end
		local out, n = {}, 0
		for k, x in pairs(v) do
			n = n + 1
			if n > 200 then out["__truncated"] = true break end
			out[type(k) == "number" and k or tostring(k)] = toJson(x, depth + 1)
		end
		return out
	end
	return v
end
local function pluginUrl(assetId) return "https://create.roblox.com/store/asset/" .. tostring(assetId) end

-- ───────────── run / pause / stop ─────────────
function H.studio_playtest(a)
	local action = tostring(a.action or "state"):lower()
	local function state()
		return { running = RunService:IsRunning(), run_mode = RunService:IsRunMode(), edit = RunService:IsEdit(), studio = RunService:IsStudio() }
	end
	if action == "state" then return state() end
	if action == "run" or action == "start" then
		if RunService:IsRunning() then return { already = true, state = state() } end
		RunService:Run()
		task.wait(0.5)
		return { started = true, mode = "Run (server simulation in this DataModel; the plugin keeps working)", state = state(), hint = "studio_playtest {action:'stop'} to return to edit mode; Play Solo (F5) has no plugin API - ask the user" }
	elseif action == "pause" then
		RunService:Pause()
		return { paused = true, state = state() }
	elseif action == "stop" then
		RunService:Stop()
		task.wait(0.5)
		return { stopped = true, state = state() }
	end
	error("action must be state|run|pause|stop")
end

-- ───────────── settings() ─────────────
local SETTING_CATEGORIES = { "Studio", "Rendering", "Physics", "Network", "Lua", "Debug", "Diagnostics", "Game Options", "Task Scheduler" }
function H.studio_settings(a)
	local category = tostring(a.category or "Studio")
	local holder
	if category:lower() == "usergamesettings" or category:lower() == "user" then
		holder = UserSettings():GetService("UserGameSettings")
	else
		local okC, c = pcall(function() return settings():GetService(category) end)
		if not okC or not c then
			local okI, c2 = pcall(function() return settings()[category] end)
			if okI then c = c2 end
		end
		holder = c
	end
	if not holder then error("unknown settings category '" .. category .. "' (try " .. table.concat(SETTING_CATEGORIES, ", ") .. ", UserGameSettings)") end
	local name = a.name and tostring(a.name) or nil
	if not name then
		local out = { category = category, path = holder:GetFullName(), hint = "pass name (e.g. Theme, 'Camera Speed', QualityLevel, 'Auto-Save Enabled') to read, name+value to write" }
		if category == "Studio" then
			pcall(function() out.theme = tostring(holder.Theme) end)
			pcall(function() local t = {} for _, th in ipairs(holder:GetAvailableThemes()) do t[#t + 1] = th.Name end out.available_themes = t end)
		end
		return out
	end
	if a.value == nil then
		local okR, val = pcall(function() return holder[name] end)
		if not okR then error("cannot read " .. category .. "." .. name .. ": " .. tostring(val)) end
		return { category = category, name = name, value = toJson(val) }
	end
	local value = fromJson(a.value)
	if category == "Studio" and name == "Theme" and type(value) == "string" then
		local wanted = value:lower()
		for _, th in ipairs(holder:GetAvailableThemes()) do if th.Name:lower() == wanted then value = th end end
	end
	local okW, errW = pcall(function() holder[name] = value end)
	if not okW then error("cannot write " .. category .. "." .. name .. ": " .. tostring(errW)) end
	local after
	pcall(function() after = toJson(holder[name]) end)
	return { category = category, name = name, value = after, written = true }
end

-- ───────────── selection ─────────────
function H.studio_selection(a)
	local action = tostring(a.action or "get"):lower()
	if action == "get" then
		local out = {}
		for _, s in ipairs(Selection:Get()) do out[#out + 1] = { path = s:GetFullName(), class = s.ClassName } end
		return { selection = out, count = #out }
	elseif action == "clear" then
		Selection:Set({})
		return { count = 0 }
	elseif action == "set" or action == "add" or action == "remove" then
		local items = targets(a)
		if action == "set" then Selection:Set(items)
		elseif action == "add" then Selection:Add(items)
		else Selection:Remove(items) end
		return { count = #Selection:Get(), selection = pathsOf(Selection:Get()) }
	elseif action == "by_class" or action == "by_name" or action == "descendants" then
		local root = a.root and need(a.root, "root") or workspace
		local cls = a.class_name and tostring(a.class_name) or nil
		local pat = a.name_pattern and tostring(a.name_pattern) or nil
		local hits = {}
		for _, d in ipairs(root:GetDescendants()) do
			if (not cls or d:IsA(cls)) and (not pat or d.Name:lower():find(pat:lower(), 1, true)) then
				hits[#hits + 1] = d
				if #hits >= (tonumber(a.limit) or 500) then break end
			end
		end
		Selection:Set(hits)
		return { count = #hits, selection = pathsOf(hits) }
	end
	error("action must be get|set|add|remove|clear|by_class|by_name")
end

-- ───────────── camera ─────────────
function H.studio_camera(a)
	local cam = workspace.CurrentCamera
	if not cam then error("no camera") end
	local action = tostring(a.action or "get"):lower()
	if action == "get" then
		return { position = toJson(cam.CFrame.Position), look_vector = toJson(cam.CFrame.LookVector), cframe = toJson(cam.CFrame), fov = cam.FieldOfView, focus = toJson(cam.Focus.Position), type = tostring(cam.CameraType) }
	elseif action == "set" then
		local cf = a.cframe and toCFrame(a.cframe)
		if not cf then
			local pos = toVector3(a.position)
			local look = toVector3(a.look_at)
			if not pos then error("set needs cframe or position (+ optional look_at)") end
			cf = look and CFrame.lookAt(pos, look) or CFrame.new(pos) * (cam.CFrame - cam.CFrame.Position)
		end
		cam.CameraType = Enum.CameraType.Scriptable
		cam.CFrame = cf
		if a.fov then cam.FieldOfView = math.clamp(tonumber(a.fov) or 70, 1, 120) end
		cam.CameraType = Enum.CameraType.Fixed
		return { position = toJson(cam.CFrame.Position), fov = cam.FieldOfView }
	elseif action == "look_at" then
		local target = a.path and need(a.path, "target") or Selection:Get()[1]
		local pos = toVector3(a.position) or (target and (target:IsA("Model") and target:GetPivot().Position or target:IsA("BasePart") and target.Position))
		if not pos then error("look_at needs path (model/part) or position") end
		cam.CameraType = Enum.CameraType.Scriptable
		cam.CFrame = CFrame.lookAt(cam.CFrame.Position, pos)
		cam.CameraType = Enum.CameraType.Fixed
		return { looking_at = toJson(pos) }
	elseif action == "focus" or action == "orbit" then
		return H.screenshot_frame({ path = a.path, yaw = a.yaw, pitch = a.pitch, distance = a.distance, fov = a.fov, hide_selection = a.hide_selection == true })
	elseif action == "fov" then
		cam.FieldOfView = math.clamp(tonumber(a.fov) or 70, 1, 120)
		return { fov = cam.FieldOfView }
	end
	error("action must be get|set|look_at|focus|fov")
end

-- ───────────── script editor documents ─────────────
local function docFor(s)
	for _, d in ipairs(ScriptEditorService:GetScriptDocuments()) do
		local okS, scr = pcall(function() return d:GetScript() end)
		if okS and scr == s then return d end
	end
	return nil
end
function H.studio_script_editor(a)
	local action = tostring(a.action or "list"):lower()
	if action == "list" then
		local out = {}
		for _, d in ipairs(ScriptEditorService:GetScriptDocuments()) do
			local entry = { command_bar = d:IsCommandBar() }
			pcall(function() local s = d:GetScript() entry.path = s and s:GetFullName() or nil end)
			pcall(function() entry.lines = d:GetLineCount() end)
			pcall(function() local l, c = d:GetSelectionStart() entry.cursor = { line = l, char = c } end)
			out[#out + 1] = entry
		end
		local active = StudioService.ActiveScript
		return { documents = out, count = #out, active = active and active:GetFullName() or nil }
	end
	local s = need(a.path, "script")
	if not s:IsA("LuaSourceContainer") then error("not a script: " .. s:GetFullName()) end
	if action == "open" then
		local okO, errO = pcall(function() return ScriptEditorService:OpenScriptDocumentAsync(s) end)
		if not okO then plugin:OpenScript(s, tonumber(a.line) or 1) end
		local d = docFor(s)
		if d and a.line then pcall(function() d:ForceSetSelectionAsync(tonumber(a.line), 1) end) end
		return { path = s:GetFullName(), open = d ~= nil, via = okO and "ScriptEditorService" or "plugin:OpenScript" }
	elseif action == "close" then
		local d = docFor(s)
		if not d then return { path = s:GetFullName(), open = false } end
		local okC, errC = pcall(function() return d:CloseAsync() end)
		return { path = s:GetFullName(), closed = okC, error = (not okC) and tostring(errC) or nil }
	elseif action == "text" then
		local d = docFor(s)
		local text = d and d:GetText() or ScriptEditorService:GetEditorSource(s)
		local from = tonumber(a.start_line)
		local to = tonumber(a.end_line)
		if from or to then
			local lines = text:split("\n")
			local out = {}
			for i = math.max(1, from or 1), math.min(#lines, to or #lines) do out[#out + 1] = string.format("%d| %s", i, lines[i]) end
			return { __text = table.concat(out, "\n") }
		end
		return { __text = text:sub(1, tonumber(a.max_chars) or 60000) }
	elseif action == "find" then
		local query = tostring(a.query or "")
		if query == "" then error("find needs query") end
		local text = ScriptEditorService:GetEditorSource(s)
		local hits = {}
		for i, line in ipairs(text:split("\n")) do
			if line:lower():find(query:lower(), 1, true) then hits[#hits + 1] = { line = i, text = line:sub(1, 200) } end
			if #hits >= 100 then break end
		end
		return { path = s:GetFullName(), hits = hits, count = #hits }
	elseif action == "cursor" or action == "goto" then
		local d = docFor(s)
		if not d then
			plugin:OpenScript(s, tonumber(a.line) or 1)
			return { path = s:GetFullName(), line = tonumber(a.line) or 1, via = "plugin:OpenScript" }
		end
		local okS, errS = pcall(function() return d:ForceSetSelectionAsync(tonumber(a.line) or 1, tonumber(a.char) or 1, tonumber(a.end_line), tonumber(a.end_char)) end)
		if not okS then error("cursor failed: " .. tostring(errS)) end
		return { path = s:GetFullName(), line = tonumber(a.line) or 1 }
	elseif action == "insert" or action == "replace_range" then
		local text = tostring(a.text or "")
		local rec = record("script editor edit")
		local d = docFor(s)
		local okE, errE
		if d then
			local sl = tonumber(a.start_line) or tonumber(a.line) or (d:GetLineCount() + 1)
			local sc = tonumber(a.start_char) or 1
			local el = action == "insert" and sl or (tonumber(a.end_line) or sl)
			local ec = action == "insert" and sc or (tonumber(a.end_char) or 1)
			if action == "insert" and sl > d:GetLineCount() then
				sl = d:GetLineCount(); el = sl
				sc = #d:GetLine(sl) + 1; ec = sc
				text = "\n" .. text
			end
			okE, errE = pcall(function() return d:EditTextAsync(text, sl, sc, el, ec) end)
		else
			local src = ScriptEditorService:GetEditorSource(s)
			local lines = src:split("\n")
			local sl = tonumber(a.start_line) or tonumber(a.line) or (#lines + 1)
			if action == "insert" then
				table.insert(lines, math.clamp(sl, 1, #lines + 1), text)
			else
				local el = tonumber(a.end_line) or sl
				for _ = sl, el do table.remove(lines, sl) end
				table.insert(lines, sl, text)
			end
			local newSrc = table.concat(lines, "\n")
			okE, errE = pcall(function() ScriptEditorService:UpdateSourceAsync(s, function() return newSrc end) end)
			if not okE then s.Source = newSrc okE = true end
		end
		commit(rec)
		if not okE then error("edit failed: " .. tostring(errE)) end
		return { path = s:GetFullName(), edited = true, open_in_editor = d ~= nil }
	end
	error("action must be list|open|close|text|find|cursor|insert|replace_range")
end

-- ───────────── change history ─────────────
function H.studio_history(a)
	local action = tostring(a.action or "status"):lower()
	if action == "undo" then return H.studio_undo(a) end
	if action == "redo" then return H.studio_redo(a) end
	if action == "waypoint" then
		ChangeHistoryService:SetWaypoint(tostring(a.label or "ORscript"))
		return { waypoint = tostring(a.label or "ORscript") }
	end
	if action == "enable" or action == "disable" then
		ChangeHistoryService:SetEnabled(action == "enable")
		return { enabled = action == "enable" }
	end
	local out = {}
	pcall(function() out.can_undo = ChangeHistoryService:GetCanUndo() end)
	pcall(function() out.can_redo = ChangeHistoryService:GetCanRedo() end)
	pcall(function() out.enabled = ChangeHistoryService:IsEnabled() end)
	return out
end

-- ───────────── any service method / property ─────────────
function H.studio_service_call(a)
	local svcName = tostring(a.service or "")
	if svcName == "" then error("service is required (e.g. StudioService, ScriptEditorService, Lighting, Terrain, PhysicsService, CollectionService, plugin, settings)") end
	local obj
	if svcName == "plugin" then obj = plugin
	elseif svcName == "settings" then obj = settings()
	elseif svcName == "game" then obj = game
	elseif svcName:match("^game%.") or svcName:match("^Workspace") then obj = need(svcName)
	else
		local okS, svc = pcall(function() return game:GetService(svcName) end)
		if not okS or not svc then obj = resolve(svcName) end
		obj = obj or svc
	end
	if not obj then error("unknown service/instance '" .. svcName .. "'") end
	local args = {}
	for i, v in ipairs(listArg(a.args)) do args[i] = fromJson(v) end
	if a.property then
		local prop = tostring(a.property)
		if a.value ~= nil then
			local rec = record("set " .. prop)
			local okW, errW = pcall(function() obj[prop] = fromJson(a.value) end)
			commit(rec)
			if not okW then error("cannot set " .. prop .. ": " .. tostring(errW)) end
		end
		local okR, val = pcall(function() return obj[prop] end)
		if not okR then error("cannot read " .. prop .. ": " .. tostring(val)) end
		return { target = svcName, property = prop, value = toJson(val) }
	end
	local method = tostring(a.method or "")
	if method == "" then error("method (or property) is required") end
	local fn = obj[method]
	if type(fn) ~= "function" then error(svcName .. "." .. method .. " is not a method") end
	local rec = record(svcName .. ":" .. method)
	local results = { pcall(fn, obj, table.unpack(args)) }
	commit(rec)
	if not results[1] then error(svcName .. ":" .. method .. " failed: " .. tostring(results[2])) end
	local out = {}
	for i = 2, #results do out[#out + 1] = toJson(results[i]) end
	return { target = svcName, method = method, results = out }
end

-- ───────────── toolbar macros (persisted) ─────────────
local macroButtons = {}
local function loadMacros() local m = plugin:GetSetting("ORscriptMacros") return type(m) == "table" and m or {} end
local function installMacro(m)
	if macroButtons[m.name] then return end
	local okB, btn = pcall(function() return toolbar:CreateButton("ORscriptMacro_" .. m.name, m.tooltip or ("ORscript macro " .. m.name), m.icon or "rbxassetid://6031071053", m.name) end)
	if not okB then return end
	btn.ClickableWhenViewportHidden = true
	btn.Click:Connect(function()
		local okR, res = pcall(function() return H.plugin_execute_luau({ code = m.code }) end)
		if okR then log("macro " .. m.name .. ": " .. tostring(res and res.__text or "ok")) else warn("[ORscript] macro " .. m.name .. " failed: " .. tostring(res)) end
		btn:SetActive(false)
	end)
	macroButtons[m.name] = btn
end
function H.studio_macro(a)
	local action = tostring(a.action or (a.code and "create" or "list")):lower()
	local macros = loadMacros()
	if action == "list" then
		local out = {}
		for _, m in ipairs(macros) do out[#out + 1] = { name = m.name, tooltip = m.tooltip, bytes = #tostring(m.code or "") } end
		return { macros = out, count = #out }
	end
	local name = tostring(a.name or ""):gsub("[^%w_ %-]", "")
	if name == "" then error("name is required") end
	if action == "create" or action == "update" then
		local code = tostring(a.code or "")
		if code == "" then error("code (Luau run on click, plugin context) is required") end
		local fn, err = loadstring(code)
		if not fn then error("macro code has a syntax error: " .. tostring(err)) end
		local found = false
		for _, m in ipairs(macros) do if m.name == name then m.code = code m.tooltip = a.tooltip or m.tooltip m.icon = a.icon or m.icon found = true end end
		if not found then macros[#macros + 1] = { name = name, code = code, tooltip = a.tooltip, icon = a.icon } end
		plugin:SetSetting("ORscriptMacros", macros)
		for _, m in ipairs(macros) do if m.name == name then installMacro(m) end end
		return { name = name, created = not found, hint = "the button is in the ORscript toolbar; studio_macro {action:'run', name} runs it from here" }
	elseif action == "run" then
		for _, m in ipairs(macros) do if m.name == name then return H.plugin_execute_luau({ code = m.code }) end end
		error("no macro named " .. name)
	elseif action == "remove" then
		local kept = {}
		for _, m in ipairs(macros) do if m.name ~= name then kept[#kept + 1] = m end end
		plugin:SetSetting("ORscriptMacros", kept)
		if macroButtons[name] then pcall(function() macroButtons[name].Enabled = false end) macroButtons[name] = nil end
		return { name = name, removed = #kept ~= #macros, hint = "toolbar buttons disappear fully after Studio reloads plugins" }
	end
	error("action must be create|update|run|remove|list")
end
for _, m in ipairs(loadMacros()) do pcall(installMacro, m) end

-- ───────────── save / publish ─────────────
function H.studio_save(a)
	local action = tostring(a.action or "selection_to_roblox"):lower()
	if action == "selection_to_roblox" or action == "publish_selection" then
		return H.studio_publish_selection(a)
	elseif action == "prompt_save_selection" or action == "save_selection_file" then
		if a.paths then Selection:Set(targets(a)) end
		if #Selection:Get() == 0 then error("select (or pass paths for) the instances to save") end
		local okS = plugin:PromptSaveSelection(tostring(a.name or "ORscript selection"))
		return { saved = okS == true, prompted = true }
	elseif action == "place" or action == "publish_place" then
		error("Studio exposes no plugin API to save or publish the PLACE - ask the user to press Ctrl+S / Alt+P (Team Create autosaves). Models/animations CAN be published with studio_save {action:'selection_to_roblox'}.")
	end
	error("action must be selection_to_roblox|prompt_save_selection")
end

-- ───────────── TestService + Output ─────────────
local function logs(count, level)
	local out = {}
	local hist = LogService:GetLogHistory()
	local want = level and tostring(level):lower() or nil
	for i = #hist, 1, -1 do
		local e = hist[i]
		local kind = tostring(e.messageType):gsub("Enum%.MessageType%.Message", ""):lower()
		if not want or want == "all" or kind:find(want, 1, true) then
			table.insert(out, 1, { t = e.timestamp, kind = kind, text = tostring(e.message):sub(1, 500) })
			if #out >= (count or 50) then break end
		end
	end
	return out
end
function H.studio_output(a)
	return { messages = logs(tonumber(a.count) or 50, a.level), hint = "level=error|warning|info|output" }
end
function H.studio_test_run(a)
	local before = #LogService:GetLogHistory()
	local okT, errT = pcall(function() TestService:Run() end)
	task.wait(tonumber(a.wait) or 1)
	local hist = LogService:GetLogHistory()
	local out = {}
	for i = before + 1, #hist do out[#out + 1] = { kind = tostring(hist[i].messageType):gsub("Enum%.MessageType%.Message", ""), text = tostring(hist[i].message):sub(1, 500) } end
	if not okT then error("TestService:Run failed: " .. tostring(errT)) end
	return { ran = true, messages = out, hint = "TestService:Check/Require/Error calls in scripts and TestService children run here" }
end

-- ───────────── mouse / viewport ray ─────────────
function H.studio_mouse(a)
	local cam = workspace.CurrentCamera
	if not cam then error("no camera") end
	local loc
	pcall(function() loc = UserInputService:GetMouseLocation() end)
	local ray
	if a.viewport_x and a.viewport_y then
		ray = cam:ViewportPointToRay(tonumber(a.viewport_x), tonumber(a.viewport_y))
	elseif loc and tostring(a.action or ""):lower() ~= "center" then
		ray = cam:ViewportPointToRay(loc.X, loc.Y)
	else
		ray = cam:ViewportPointToRay(cam.ViewportSize.X / 2, cam.ViewportSize.Y / 2)
	end
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = {}
	local hit = workspace:Raycast(ray.Origin, ray.Direction * (tonumber(a.distance) or 5000), params)
	return {
		mouse = loc and { loc.X, loc.Y } or nil,
		viewport = { cam.ViewportSize.X, cam.ViewportSize.Y },
		hit = hit and { path = hit.Instance:GetFullName(), position = toJson(hit.Position), normal = toJson(hit.Normal), material = tostring(hit.Material), distance = hit.Distance } or nil,
	}
end

-- ═════════════════════ 1.24.0: other plugins ═════════════════════
-- Studio keeps every plugin in its own sandbox: there is no API to call into
-- another plugin's closures or to click its buttons. What IS reachable, and
-- what the commands below use:
--   * the ORscript plugin bus (shared.ORscript / _G.ORscript and the
--     CoreGui.ORscriptBus BindableFunction) - any plugin can register
--     commands there and ORscript invokes them (plugins_list → plugin_invoke)
--   * other plugins' widgets in CoreGui / PluginGuiService: read their UI,
--     show / hide them (plugin_widget)
--   * BindableFunctions, ModuleScripts and shared/_G tables that plugins leave
--     in the DataModel (plugin_invoke, plugin_module_call)
--   * their source when "Plugin Debugging Enabled" is on (PluginDebugService:
--     plugin_source_read) - so the agent can learn a plugin's real API
--   * their footprints: save folders / exported modules (Eclipse Animator,
--     Moon Animator, the Roblox Animation Editor, Rojo, F3X ...)
local KNOWN_PLUGINS = {
	{ id = "eclipse_animator", name = "Eclipse Animator", match = { "eclipse" }, asset_id = 86116556258301, kind = "animation",
		notes = "flagship animator (riftkuro / Seventh Eclipse, released Oct 2026): IK/FK, layers, graph editor, Blender armature import, physics, Module Exporter. ORscript bridge: eclipse_status / eclipse_open / eclipse_handoff / eclipse_import / eclipse_play" },
	{ id = "moon_animator", name = "Moon Animator 2", match = { "moon animator", "moonanimator" }, asset_id = 4725618216, kind = "animation", notes = "saves under ServerStorage.MoonAnimator2Saves (per rig); exports KeyframeSequences the animation_* commands can import" },
	{ id = "roblox_animation_editor", name = "Roblox Animation Editor", match = { "animsaves", "animationclipeditor", "animation editor" }, kind = "animation", notes = "built in; saves KeyframeSequences under <rig>.AnimSaves" },
	{ id = "f3x", name = "Building Tools by F3X", match = { "f3x", "building tools" }, asset_id = 142785488, kind = "building" },
	{ id = "rojo", name = "Rojo", match = { "rojo" }, kind = "sync", notes = "file sync; ORscript edits through ScriptEditorService are picked up by Rojo two-way sync" },
	{ id = "tag_editor", name = "Tag Editor", match = { "tag editor", "tageditor" }, kind = "tags" },
	{ id = "archimedes", name = "Archimedes", match = { "archimedes" }, kind = "building" },
	{ id = "gapfill", name = "GapFill", match = { "gapfill", "gap fill" }, kind = "building" },
	{ id = "brushtool", name = "Brushtool", match = { "brushtool" }, kind = "building" },
	{ id = "orscript", name = "ORscript", match = { "orscript" }, kind = "agent" },
}
local function knownFor(text)
	local t = tostring(text or ""):lower()
	for _, k in ipairs(KNOWN_PLUGINS) do
		for _, m in ipairs(k.match) do if t:find(m, 1, true) then return k end end
	end
	return nil
end

-- plugin bus
local BUS = { version = VERSION, plugins = {} }
function BUS.register(spec)
	if type(spec) ~= "table" or type(spec.name) ~= "string" then error("ORscript.register expects {name, version?, description?, commands = {name = function|BindableFunction}}") end
	BUS.plugins[spec.name] = { name = spec.name, version = spec.version, description = spec.description, commands = spec.commands or {}, registered_at = os.time() }
	log("plugin registered on the ORscript bus: " .. spec.name)
	return true
end
function BUS.unregister(name) BUS.plugins[tostring(name)] = nil return true end
function BUS.list()
	local out = {}
	for name, p in pairs(BUS.plugins) do
		local cmds = {}
		for c in pairs(p.commands) do cmds[#cmds + 1] = c end
		table.sort(cmds)
		out[#out + 1] = { name = name, version = p.version, description = p.description, commands = cmds }
	end
	return out
end
function BUS.invoke(pluginName, command, args)
	local p = BUS.plugins[tostring(pluginName)]
	if not p then error("no plugin named '" .. tostring(pluginName) .. "' on the ORscript bus") end
	local fn = p.commands[tostring(command)]
	if fn == nil then error("plugin '" .. tostring(pluginName) .. "' has no command '" .. tostring(command) .. "'") end
	if typeof(fn) == "Instance" and fn:IsA("BindableFunction") then return fn:Invoke(args) end
	if type(fn) ~= "function" then error("command '" .. tostring(command) .. "' is not callable") end
	return fn(args)
end
function BUS.execute(code) return H.plugin_execute_luau({ code = code }) end
function BUS.resolve(p) return resolve(p) end
pcall(function() shared.ORscript = BUS end)
pcall(function() _G.ORscript = BUS end)
local busFn = CoreGui:FindFirstChild("ORscriptBus")
if not busFn then
	busFn = Instance.new("BindableFunction")
	busFn.Name = "ORscriptBus"
	busFn.Parent = CoreGui
end
busFn.OnInvoke = function(op, ...)
	op = tostring(op)
	if op == "register" then return BUS.register(...) end
	if op == "unregister" then return BUS.unregister(...) end
	if op == "list" then return BUS.list() end
	if op == "invoke" then return BUS.invoke(...) end
	if op == "execute" then local r = BUS.execute(...) return r and r.__text or r end
	if op == "version" then return VERSION end
	error("ORscriptBus ops: register|unregister|list|invoke|execute|version")
end

local function widgetContainers()
	local list = {}
	for _, svcName in ipairs({ "CoreGui", "PluginGuiService" }) do
		local okS, svc = pcall(function() return game:GetService(svcName) end)
		if okS and svc then
			local okC, kids = pcall(function() return svc:GetChildren() end)
			if okC then for _, k in ipairs(kids) do list[#list + 1] = k end end
		end
	end
	return list
end
local function isForeignGui(i)
	if not (i:IsA("PluginGui") or i:IsA("ScreenGui")) then return false end
	if i:IsA("ScreenGui") and (i.Name:match("^Roblox") or i.Name:match("^Core") or i.Name == "TeleportGui" or i.Name == "PlayerList") then return false end
	return true
end
local function widgetInfo(g, deep)
	local info = { name = g.Name, class = g.ClassName, path = g:GetFullName() }
	pcall(function() info.title = g.Title end)
	pcall(function() info.enabled = g.Enabled end)
	local buttons, boxes, texts, total = 0, 0, {}, 0
	local okD = pcall(function()
		for _, d in ipairs(g:GetDescendants()) do
			total = total + 1
			if d:IsA("GuiButton") then buttons = buttons + 1 end
			if d:IsA("TextBox") then boxes = boxes + 1 end
			if (d:IsA("TextLabel") or d:IsA("TextButton")) and #texts < (deep and 60 or 12) then
				local t = tostring(d.Text or ""):gsub("%s+", " ")
				if t ~= "" and #t < 80 then texts[#texts + 1] = t end
			end
		end
	end)
	info.readable = okD
	info.descendants, info.buttons, info.textboxes, info.texts = total, buttons, boxes, texts
	local k = knownFor((info.title or "") .. " " .. g.Name)
	if k then info.known = k.id end
	return info
end
local function findWidget(query)
	local q = tostring(query or ""):lower()
	if q == "" then error("name (widget name/title, e.g. 'eclipse') is required") end
	local hits = {}
	for _, g in ipairs(widgetContainers()) do
		if isForeignGui(g) then
			local title = ""
			pcall(function() title = tostring(g.Title or "") end)
			if g.Name:lower():find(q, 1, true) or title:lower():find(q, 1, true) then hits[#hits + 1] = g end
		end
	end
	return hits
end
local function footprints()
	local out = {}
	local roots = { ServerStorage, ReplicatedStorage, workspace, game:GetService("StarterGui"), game:GetService("Lighting"), ServerScriptService }
	for _, r in ipairs(roots) do
		for _, d in ipairs(r:GetChildren()) do
			local k = knownFor(d.Name)
			if k and k.id ~= "orscript" then out[#out + 1] = { plugin = k.id, path = d:GetFullName(), class = d.ClassName, children = #d:GetChildren() } end
		end
	end
	-- rig-local saves (AnimSaves, Eclipse / Moon per-rig folders)
	for _, m in ipairs(workspace:GetChildren()) do
		if m:IsA("Model") then
			for _, c in ipairs(m:GetChildren()) do
				local k = knownFor(c.Name)
				if k and k.kind == "animation" then out[#out + 1] = { plugin = k.id, path = c:GetFullName(), class = c.ClassName, children = #c:GetChildren(), rig = m.Name } end
			end
		end
	end
	return out
end
local function debugPlugins()
	local out = {}
	pcall(function()
		local pds = game:GetService("PluginDebugService")
		for _, p in ipairs(pds:GetChildren()) do
			local scripts = 0
			for _, d in ipairs(p:GetDescendants()) do if d:IsA("LuaSourceContainer") then scripts = scripts + 1 end end
			local k = knownFor(p.Name)
			out[#out + 1] = { name = p.Name, class = p.ClassName, scripts = scripts, known = k and k.id or nil }
		end
	end)
	return out
end
local function sharedTables()
	local out = {}
	for _, pair in ipairs({ { "shared", shared }, { "_G", _G } }) do
		pcall(function()
			for k, v in pairs(pair[2]) do
				if k ~= "ORscript" then
					local entry = { key = pair[1] .. "." .. tostring(k), type = typeof(v) }
					if type(v) == "table" then
						local fns = {}
						for fk, fv in pairs(v) do if type(fv) == "function" and #fns < 30 then fns[#fns + 1] = tostring(fk) end end
						table.sort(fns)
						entry.functions = fns
					end
					out[#out + 1] = entry
				end
			end
		end)
	end
	return out
end

function H.plugins_list(a)
	local widgets = {}
	for _, g in ipairs(widgetContainers()) do if isForeignGui(g) then widgets[#widgets + 1] = widgetInfo(g, false) end end
	local fp = footprints()
	local dbg = debugPlugins()
	local sh = sharedTables()
	local detected = {}
	local function mark(id, how)
		for _, k in ipairs(KNOWN_PLUGINS) do
			if k.id == id then
				detected[id] = detected[id] or { id = id, name = k.name, kind = k.kind, asset_id = k.asset_id, notes = k.notes, evidence = {} }
				table.insert(detected[id].evidence, how)
			end
		end
	end
	for _, w in ipairs(widgets) do if w.known then mark(w.known, "widget " .. (w.title or w.name)) end end
	for _, f in ipairs(fp) do mark(f.plugin, "instance " .. f.path) end
	for _, d in ipairs(dbg) do if d.known then mark(d.known, "PluginDebugService " .. d.name) end end
	for _, s in ipairs(sh) do local k = knownFor(s.key) if k then mark(k.id, "global " .. s.key) end end
	local list = {}
	for _, d in pairs(detected) do list[#list + 1] = d end
	table.sort(list, function(x, y) return x.name < y.name end)
	return {
		detected = list,
		bus = BUS.list(),
		widgets = widgets,
		footprints = fp,
		debug_plugins = dbg,
		shared_globals = sh,
		how_to_use = {
			"plugin_widget {name, action:'show'|'hide'|'tree'} - open/inspect another plugin's panel",
			"plugin_invoke {plugin, command, args} - call a command a plugin registered on the ORscript bus (shared.ORscript.register) or any BindableFunction / shared table function by path",
			"plugin_module_call {path, method, args} - require a ModuleScript a plugin exposes and call it",
			"plugin_source_read {plugin, script} - read a plugin's source when Plugin Debugging is enabled (File → Studio Settings → Plugin Debugging Enabled)",
			"Studio does not let a plugin click another plugin's buttons; when a plugin has no bus/module/Bindable API, drive it through its saves/exports (see eclipse_* for Eclipse Animator) or ask the user to press the button",
		},
	}
end

local function guiTree(root, depth, maxDepth, out, budget)
	if depth > maxDepth or #out >= budget then return end
	for _, c in ipairs(root:GetChildren()) do
		if c:IsA("GuiObject") then
			local entry = { path = c:GetFullName(), class = c.ClassName, name = c.Name, visible = c.Visible }
			pcall(function() if c:IsA("TextLabel") or c:IsA("TextButton") or c:IsA("TextBox") then entry.text = tostring(c.Text):sub(1, 120) end end)
			pcall(function() if c:IsA("ImageButton") or c:IsA("ImageLabel") then entry.image = c.Image end end)
			out[#out + 1] = entry
			if #out >= budget then return end
		end
		guiTree(c, depth + 1, maxDepth, out, budget)
	end
end
function H.plugin_widget(a)
	local hits = findWidget(a.name or a.widget or a.plugin)
	if #hits == 0 then
		local names = {}
		for _, g in ipairs(widgetContainers()) do if isForeignGui(g) then local t = "" pcall(function() t = g.Title end) names[#names + 1] = g.Name .. (t ~= "" and (" (" .. t .. ")") or "") end end
		error("no plugin widget matches '" .. tostring(a.name or a.widget or a.plugin) .. "'. Widgets: " .. table.concat(names, ", "))
	end
	local g = hits[1]
	local action = tostring(a.action or "info"):lower()
	if action == "show" or action == "hide" or action == "toggle" then
		local want = action == "show" or (action == "toggle" and not g.Enabled)
		local okE, errE = pcall(function() g.Enabled = want end)
		if not okE then error("cannot change " .. g.Name .. ".Enabled: " .. tostring(errE)) end
		return { widget = g.Name, enabled = g.Enabled, matched = #hits }
	elseif action == "tree" or action == "find" then
		local out = {}
		local okT = pcall(function() guiTree(g, 1, tonumber(a.depth) or 6, out, tonumber(a.limit) or 400) end)
		if action == "find" then
			local q = tostring(a.text or ""):lower()
			local f = {}
			for _, e in ipairs(out) do if (e.text or ""):lower():find(q, 1, true) or e.name:lower():find(q, 1, true) then f[#f + 1] = e end end
			out = f
		end
		return { widget = g.Name, readable = okT, nodes = out, count = #out }
	elseif action == "click" then
		local q = tostring(a.text or a.button or ""):lower()
		local out = {}
		pcall(function() guiTree(g, 1, 8, out, 600) end)
		local found
		for _, e in ipairs(out) do if (e.class == "TextButton" or e.class == "ImageButton") and ((e.text or ""):lower():find(q, 1, true) or e.name:lower():find(q, 1, true)) then found = e break end end
		-- Studio gives plugins no way to synthesize input inside another plugin's
		-- widget (VirtualInputManager is Roblox-script security and targets the
		-- 3D viewport). Report the exact button so the user can press it.
		return { clicked = false, widget = g.Name, button = found, reason = "Studio does not allow a plugin to click another plugin's buttons", hint = found and ("ask the user to press '" .. (found.text or found.name) .. "' in " .. (g.Title or g.Name)) or "no matching button; use plugin_widget {action:'tree'}" }
	end
	return { widget = widgetInfo(g, true), matched = #hits }
end

local function callTarget(target, command, args)
	target = tostring(target or "")
	-- 1) bus plugin
	if BUS.plugins[target] then return "bus", BUS.invoke(target, command, args) end
	-- 2) shared/_G table
	local tbl
	if target:match("^shared%.") then pcall(function() tbl = shared[target:sub(8)] end)
	elseif target:match("^_G%.") then pcall(function() tbl = _G[target:sub(4)] end)
	else pcall(function() tbl = shared[target] end) if tbl == nil then pcall(function() tbl = _G[target] end) end end
	if type(tbl) == "table" then
		local fn = tbl[command]
		if type(fn) ~= "function" then error("'" .. target .. "' has no function '" .. tostring(command) .. "'") end
		local list = listArg(args)
		local conv = {}
		for i, v in ipairs(list) do conv[i] = fromJson(v) end
		if #conv == 0 and type(args) == "table" then conv = { fromJson(args) } end
		return "global", { fn(table.unpack(conv)) }
	elseif type(tbl) == "function" then
		return "global", { tbl(fromJson(args)) }
	end
	-- 3) BindableFunction / ModuleScript in the DataModel or CoreGui
	local inst = resolve(target) or CoreGui:FindFirstChild(target, true)
	if inst and inst:IsA("BindableFunction") then return "bindable", { inst:Invoke(command, fromJson(args)) } end
	if inst and inst:IsA("ModuleScript") then
		local m = require(inst)
		if type(m) == "function" then return "module", { m(fromJson(args)) } end
		if type(m) ~= "table" or type(m[command]) ~= "function" then error("module " .. inst:GetFullName() .. " has no function '" .. tostring(command) .. "'") end
		local list = listArg(args)
		local conv = {}
		for i, v in ipairs(list) do conv[i] = fromJson(v) end
		if #conv == 0 and type(args) == "table" then conv = { fromJson(args) } end
		local okM, r1, r2, r3 = pcall(m[command], table.unpack(conv))
		if not okM then
			-- method-style call (self first)
			local okS, s1, s2, s3 = pcall(m[command], m, table.unpack(conv))
			if not okS then error("call failed: " .. tostring(r1) .. " / with self: " .. tostring(s1)) end
			return "module", { s1, s2, s3 }
		end
		return "module", { r1, r2, r3 }
	end
	error("no bus plugin, shared/_G table, BindableFunction or ModuleScript named '" .. target .. "'. plugins_list shows what is reachable.")
end
function H.plugin_invoke(a)
	local target = a.plugin or a.target or a.path
	if not target then error("plugin (bus name, shared.X / _G.X, or a BindableFunction / ModuleScript path) is required") end
	local how, res = callTarget(target, tostring(a.command or a.method or ""), a.args)
	return { target = tostring(target), via = how, result = toJson(res) }
end
function H.plugin_module_call(a)
	local inst = need(a.path, "module")
	if not inst:IsA("ModuleScript") then error("not a ModuleScript: " .. inst:GetFullName()) end
	local okR, m = pcall(require, inst)
	if not okR then error("require failed: " .. tostring(m)) end
	if not a.method then
		local info = { path = inst:GetFullName(), type = typeof(m) }
		if type(m) == "table" then
			local keys = {}
			for k, v in pairs(m) do keys[#keys + 1] = tostring(k) .. ":" .. typeof(v) if #keys >= 80 then break end end
			table.sort(keys)
			info.keys = keys
		end
		return info
	end
	local how, res = callTarget(inst:GetFullName(), tostring(a.method), a.args)
	return { path = inst:GetFullName(), via = how, result = toJson(res) }
end
function H.plugin_source_read(a)
	local okP, pds = pcall(function() return game:GetService("PluginDebugService") end)
	if not okP or not pds then error("PluginDebugService unavailable") end
	local q = tostring(a.plugin or ""):lower()
	local hit
	for _, p in ipairs(pds:GetChildren()) do
		if q == "" or p.Name:lower():find(q, 1, true) then hit = p break end
	end
	if not hit then
		local names = {}
		for _, p in ipairs(pds:GetChildren()) do names[#names + 1] = p.Name end
		error("no plugin matches '" .. q .. "' in PluginDebugService (" .. (#names == 0 and "empty - enable File → Studio Settings → Debugger → 'Plugin Debugging Enabled' and reload plugins" or table.concat(names, ", ")) .. ")")
	end
	local scripts = {}
	for _, d in ipairs(hit:GetDescendants()) do if d:IsA("LuaSourceContainer") then scripts[#scripts + 1] = d end end
	if not a.script then
		local out = {}
		for _, s in ipairs(scripts) do out[#out + 1] = { path = s:GetFullName(), class = s.ClassName, bytes = #s.Source } end
		return { plugin = hit.Name, scripts = out, count = #out }
	end
	local wanted = tostring(a.script):lower()
	for _, s in ipairs(scripts) do
		if s.Name:lower() == wanted or s:GetFullName():lower():find(wanted, 1, true) then
			local src = s.Source
			local offset = tonumber(a.offset) or 1
			local max = tonumber(a.max_chars) or 40000
			return { __text = ("-- %s (%d bytes, from %d)\n%s"):format(s:GetFullName(), #src, offset, src:sub(offset, offset + max - 1)) }
		end
	end
	error("no script '" .. tostring(a.script) .. "' in plugin " .. hit.Name)
end

-- ═════════════════════ Eclipse Animator bridge ═════════════════════
-- Eclipse Animator (create.roblox.com/store/asset/86116556258301) is a normal
-- Studio plugin working on Motor6D / Bone rigs. The lingua franca between it,
-- the Roblox Animation Editor, Moon Animator and ORscript's animation_*
-- commands is the KeyframeSequence. These commands keep both directions
-- honest: ORscript → Eclipse through <rig>.AnimSaves (the standard import
-- location) and Eclipse → ORscript by converting its exports (KeyframeSequence
-- saves or Module Exporter tables) into KeyframeSequences in
-- ServerStorage.RobloxScript.AnimLib, which animation_import / animation_open
-- then edit and preview.
local ECLIPSE_ID = 86116556258301
local function eclipseWidgets()
	local okW, hits = pcall(findWidget, "eclipse")
	return okW and hits or {}
end
local function eclipseInstances()
	local out = {}
	local roots = { ServerStorage, ReplicatedStorage, workspace, game:GetService("StarterGui"), game:GetService("StarterPlayer") }
	for _, r in ipairs(roots) do
		for _, d in ipairs(r:GetDescendants()) do
			if d.Name:lower():find("eclipse", 1, true) and (d:IsA("Folder") or d:IsA("Configuration") or d:IsA("ModuleScript") or d:IsA("KeyframeSequence") or d:IsA("Model") or d:IsA("StringValue")) then
				local info = { path = d:GetFullName(), class = d.ClassName, children = #d:GetChildren() }
				if d:IsA("Folder") or d:IsA("Configuration") then
					local ks, mods = 0, 0
					for _, x in ipairs(d:GetDescendants()) do if x:IsA("KeyframeSequence") then ks = ks + 1 elseif x:IsA("ModuleScript") then mods = mods + 1 end end
					info.keyframe_sequences, info.modules = ks, mods
				end
				out[#out + 1] = info
				if #out >= 60 then return out end
			end
		end
	end
	return out
end
local function rigOf(a)
	local rig = a.rig_path and need(a.rig_path, "rig") or a.rig and need(a.rig, "rig") or nil
	if not rig then
		for _, s in ipairs(Selection:Get()) do if s:IsA("Model") then rig = s break end end
	end
	if not rig then
		for _, m in ipairs(workspace:GetChildren()) do
			if m:IsA("Model") and (m:FindFirstChildOfClass("Humanoid") or m:FindFirstChildOfClass("AnimationController")) then rig = m break end
		end
	end
	if not rig then error("no rig: pass rig_path or select a rig Model (Humanoid / AnimationController)") end
	return rig
end
local function rigRootPart(rig)
	return rig.PrimaryPart or rig:FindFirstChild("HumanoidRootPart") or rig:FindFirstChild("Torso") or rig:FindFirstChildWhichIsA("BasePart", true)
end
-- joint map: name (part name, Motor6D name, bone name, lowercase) → { part|bone, parentName }
local function rigJoints(rig)
	local root = rigRootPart(rig)
	local byName, order = {}, {}
	local function add(name, part, parent)
		if name == nil or name == "" then return end
		local lower = tostring(name):lower()
		if not byName[lower] then byName[lower] = { part = part, parent = parent } end
	end
	if root then add(root.Name, root, nil) order[#order + 1] = root.Name end
	for _, d in ipairs(rig:GetDescendants()) do
		if d:IsA("Motor6D") and d.Part0 and d.Part1 then
			add(d.Part1.Name, d.Part1, d.Part0.Name)
			add(d.Name, d.Part1, d.Part0.Name)
			order[#order + 1] = d.Part1.Name
		elseif d:IsA("Bone") then
			local parent = d.Parent
			add(d.Name, d, parent and parent.Name or nil)
			order[#order + 1] = d.Name
		end
	end
	return byName, order, root
end
-- place a Pose for every rig joint (identity unless cfByName has a value), nested by hierarchy
local function posesFor(kf, rig, cfByName, easing)
	local byName, order, root = rigJoints(rig)
	-- keys may be part names, Motor6D names or bone names → canonical part name
	local canon, unknown = {}, {}
	for key, cf in pairs(cfByName) do
		local j = byName[tostring(key):lower()]
		if j then canon[j.part.Name:lower()] = cf else unknown[#unknown + 1] = tostring(key) end
	end
	cfByName = canon
	local poses = {}
	local function poseFor(name)
		local key = tostring(name):lower()
		if poses[key] then return poses[key] end
		local j = byName[key]
		if not j then return nil end
		local p = Instance.new("Pose")
		p.Name = j.part.Name
		p.Weight = 1
		local cf = cfByName[key]
		if cf then p.CFrame = cf end
		if easing then
			if easing.style then pcall(function() p.EasingStyle = easing.style end) end
			if easing.direction then pcall(function() p.EasingDirection = easing.direction end) end
		end
		poses[key] = p
		if j.parent then
			local parentPose = poseFor(j.parent)
			if parentPose then parentPose:AddSubPose(p) else kf:AddPose(p) end
		else
			kf:AddPose(p)
		end
		return p
	end
	for _, n in ipairs(order) do poseFor(n) end
	return unknown
end
local function easingFrom(v)
	if v == nil then return nil end
	local out = {}
	local styleName, dirName
	if type(v) == "string" then styleName = v
	elseif type(v) == "table" then styleName = v.Style or v.style or v.EasingStyle or v[1] dirName = v.Direction or v.direction or v.EasingDirection or v[2] end
	if typeof(styleName) == "EnumItem" then out.style = styleName
	elseif type(styleName) == "string" then
		local s = styleName:lower()
		if s:find("bezier") or s:find("cubic") or s:find("smooth") or s:find("sine") or s:find("quad") or s:find("quart") or s:find("quint") or s:find("expo") or s:find("circ") then out.style = Enum.PoseEasingStyle.Cubic
		elseif s:find("bounce") then out.style = Enum.PoseEasingStyle.Bounce
		elseif s:find("elastic") then out.style = Enum.PoseEasingStyle.Elastic
		elseif s:find("constant") or s:find("step") or s:find("hold") then out.style = Enum.PoseEasingStyle.Constant
		elseif s:find("linear") then out.style = Enum.PoseEasingStyle.Linear end
	end
	if typeof(dirName) == "EnumItem" then out.direction = dirName
	elseif type(dirName) == "string" then
		local d = dirName:lower()
		if d == "inout" or d:find("in_out") or d:find("in%-out") then out.direction = Enum.PoseEasingDirection.InOut
		elseif d:find("out") then out.direction = Enum.PoseEasingDirection.Out
		elseif d:find("in") then out.direction = Enum.PoseEasingDirection.In end
	end
	return (out.style or out.direction) and out or nil
end
local function firstKey(t, names)
	for _, n in ipairs(names) do if t[n] ~= nil then return t[n], n end end
	return nil
end
local function summarize(t)
	local keys = {}
	if type(t) ~= "table" then return typeof(t) end
	local n = 0
	for k, v in pairs(t) do
		n = n + 1
		if n <= 25 then
			local desc = typeof(v)
			if type(v) == "table" then
				local sub, c = {}, 0
				for sk, sv in pairs(v) do c = c + 1 if c <= 8 then sub[#sub + 1] = tostring(sk) .. ":" .. typeof(sv) end end
				desc = "table{" .. table.concat(sub, ",") .. (c > 8 and ",…" or "") .. "}"
			end
			keys[#keys + 1] = tostring(k) .. "=" .. desc
		end
	end
	return table.concat(keys, "; ") .. (n > 25 and (" … (" .. n .. " keys)") or "")
end
-- Generic keyframe table → KeyframeSequence. Understands the shapes animation
-- exporters commonly write (per-keyframe poses, or per-joint tracks), CFrames as
-- CFrame values, 12/7/6/3-number tables or {Position, Rotation} tables, times in
-- seconds or frames (fps from the table or `fps`).
local function tableToKeyframeSequence(data, rig, name, fpsOverride)
	if type(data) ~= "table" then error("exported module returned " .. typeof(data) .. ", expected a table") end
	local meta = {}
	local fps = tonumber(fpsOverride) or tonumber((firstKey(data, { "FPS", "fps", "FrameRate", "frameRate", "Framerate", "framerate" })))
	local looped = firstKey(data, { "Looped", "looped", "Loop", "loop" })
	local priority = firstKey(data, { "Priority", "priority" })
	local kfList = firstKey(data, { "Keyframes", "keyframes", "Frames", "frames", "KeyFrames", "Poses", "poses", "Data", "data" })
	local tracks = firstKey(data, { "Tracks", "tracks", "Joints", "joints", "Bones", "bones", "Channels", "channels" })
	local frames = {} -- time → { cf = { [jointLower] = CFrame }, easing = … , name = … }
	local cfCount = 0
	local function frameAt(t)
		t = tonumber(t) or 0
		local key = math.floor(t * 10000 + 0.5) / 10000
		frames[key] = frames[key] or { cf = {}, easing = {} }
		return frames[key]
	end
	local function timeOf(entry, index)
		local t, k = firstKey(entry, { "Time", "time", "t", "T", "Seconds", "seconds" })
		if t ~= nil then return tonumber(t) or 0 end
		local f = firstKey(entry, { "Frame", "frame", "F", "Index", "index" })
		if f ~= nil then meta.frame_based = true return (tonumber(f) or 0) / (fps or 60) end
		return index
	end
	local function addPoseMap(frame, map, easing)
		if type(map) ~= "table" then return end
		for joint, v in pairs(map) do
			local cf
			if type(v) == "table" and v.CFrame ~= nil then cf = toCFrame(v.CFrame)
			elseif type(v) == "table" and (v.cframe ~= nil or v.Value ~= nil or v.value ~= nil or v.Transform ~= nil) then cf = toCFrame(v.cframe or v.Value or v.value or v.Transform)
			else cf = toCFrame(v) end
			if cf then
				cfCount = cfCount + 1
				frame.cf[tostring(joint):lower()] = cf
				local e = type(v) == "table" and easingFrom(v.Easing or v.easing or v.EasingStyle) or easing
				if e then frame.easing[tostring(joint):lower()] = e end
			end
		end
	end
	if type(kfList) == "table" and #kfList > 0 and type(kfList[1]) == "table" then
		-- array of keyframes
		for i, entry in ipairs(kfList) do
			local t = timeOf(entry, (i - 1) / (fps or 30))
			local fr = frameAt(t)
			fr.name = firstKey(entry, { "Name", "name" })
			local easing = easingFrom(firstKey(entry, { "Easing", "easing", "EasingStyle", "Ease", "ease" }))
			local map = firstKey(entry, { "Poses", "poses", "Joints", "joints", "Bones", "bones", "CFrames", "cframes", "Values", "values", "Transforms", "transforms", "Data", "data" })
			if map == nil then
				map = {}
				for k, v in pairs(entry) do if type(k) == "string" and (typeof(v) == "CFrame" or type(v) == "table") and not ({ Time = 1, time = 1, Frame = 1, frame = 1, Easing = 1, easing = 1, Name = 1, name = 1, Markers = 1, markers = 1 })[k] then map[k] = v end end
			end
			addPoseMap(fr, map, easing)
		end
		meta.shape = "keyframes"
	elseif type(kfList) == "table" and next(kfList) ~= nil and type(next(kfList)) ~= "number" then
		-- map time → poses
		for t, map in pairs(kfList) do
			local tt = tonumber(t) or tonumber(tostring(t):match("[%d%.]+")) or 0
			if meta.frame_based == nil and tt == math.floor(tt) and tt > 10 then meta.frame_based = true end
			addPoseMap(frameAt(meta.frame_based and tt / (fps or 60) or tt), map)
		end
		meta.shape = "time_map"
	elseif type(tracks) == "table" then
		for joint, track in pairs(tracks) do
			local keys = type(track) == "table" and (firstKey(track, { "Keyframes", "keyframes", "Keys", "keys", "Frames", "frames" }) or track) or {}
			if type(keys) == "table" then
				for i, k in ipairs(keys) do
					local t = type(k) == "table" and timeOf(k, (i - 1) / (fps or 30)) or 0
					local v = type(k) == "table" and (k.CFrame or k.cframe or k.Value or k.value or k.Transform or k) or k
					local cf = toCFrame(v)
					if cf then
						cfCount = cfCount + 1
						local fr = frameAt(t)
						fr.cf[tostring(joint):lower()] = cf
						local e = type(k) == "table" and easingFrom(k.Easing or k.easing or k.EasingStyle) or nil
						if e then fr.easing[tostring(joint):lower()] = e end
					end
				end
			end
		end
		meta.shape = "tracks"
	else
		error("unrecognised animation table - top level: " .. summarize(data) .. ". Convert it with execute_luau into {Keyframes = {{Time=, Poses={[joint]=CFrame}}, …}} and call eclipse_import again, or point path at a KeyframeSequence.")
	end
	local times = {}
	for t in pairs(frames) do times[#times + 1] = t end
	table.sort(times)
	if #times == 0 or cfCount == 0 then error("the export contained no keyframes with CFrames (shape " .. tostring(meta.shape) .. ") - joint values must be CFrames, 12/7/6/3-number tables or {Position, Rotation}") end
	local ks = Instance.new("KeyframeSequence")
	ks.Name = name
	if looped ~= nil then ks.Loop = looped == true end
	if priority ~= nil then local e = enumFrom("Enum.AnimationPriority." .. tostring(priority)) or (typeof(priority) == "EnumItem" and priority) if e then ks.Priority = e end end
	local unknownAll, posed = {}, 0
	local jointMap = rigJoints(rig)
	for _, t in ipairs(times) do
		local fr = frames[t]
		local kf = Instance.new("Keyframe")
		kf.Time = t
		if fr.name then kf.Name = tostring(fr.name) end
		-- apply per-joint easing after building (posesFor sets a shared easing only)
		local unknown = posesFor(kf, rig, fr.cf, nil)
		for joint, e in pairs(fr.easing) do
			local j = jointMap[joint]
			local p = j and kf:FindFirstChild(j.part.Name, true) or nil
			if p and p:IsA("Pose") then
				if e.style then pcall(function() p.EasingStyle = e.style end) end
				if e.direction then pcall(function() p.EasingDirection = e.direction end) end
			end
		end
		for _, u in ipairs(unknown) do unknownAll[u] = true end
		posed = posed + 1
		kf.Parent = ks
	end
	local unknownList = {}
	for u in pairs(unknownAll) do unknownList[#unknownList + 1] = u end
	table.sort(unknownList)
	return ks, { keyframes = posed, length = times[#times], fps = fps, frame_based = meta.frame_based == true, shape = meta.shape, unknown_joints = unknownList }
end
local function animLibFolder()
	local rsroot = ServerStorage:FindFirstChild("RobloxScript") or ServerStorage:FindFirstChild("AnimScript")
	if not rsroot then rsroot = Instance.new("Folder") rsroot.Name = "RobloxScript" rsroot.Parent = ServerStorage end
	local lib = rsroot:FindFirstChild("AnimLib")
	if not lib then lib = Instance.new("Folder") lib.Name = "AnimLib" lib.Parent = rsroot end
	return lib
end
local function animSaves(rig)
	local f = rig:FindFirstChild("AnimSaves")
	if not f then f = Instance.new("Folder") f.Name = "AnimSaves" f.Parent = rig end
	return f
end
local function findKeyframeSequence(inst)
	if inst:IsA("KeyframeSequence") then return inst end
	for _, d in ipairs(inst:GetDescendants()) do if d:IsA("KeyframeSequence") then return d end end
	return nil
end

function H.eclipse_status(a)
	local widgets = {}
	for _, g in ipairs(eclipseWidgets()) do widgets[#widgets + 1] = widgetInfo(g, false) end
	local inst = eclipseInstances()
	local onBus = BUS.plugins["Eclipse Animator"] or BUS.plugins["EclipseAnimator"] or BUS.plugins["eclipse"]
	local globals = {}
	for _, s in ipairs(sharedTables()) do if s.key:lower():find("eclipse", 1, true) then globals[#globals + 1] = s end end
	local installed = #widgets > 0 or onBus ~= nil or #globals > 0
	local version
	for _, w in ipairs(widgets) do local v = tostring(w.title or ""):match("v?(%d+%.%d+[%.%d]*)") if v then version = v end end
	return {
		installed = installed,
		evidence = { widgets = #widgets, instances = #inst, bus = onBus ~= nil, globals = #globals },
		version = version,
		widgets = widgets,
		instances = inst,
		globals = globals,
		asset_id = ECLIPSE_ID,
		store_url = pluginUrl(ECLIPSE_ID),
		workflow = {
			"ORscript → Eclipse: eclipse_handoff {animation|path, rig_path} copies the KeyframeSequence into <rig>.AnimSaves and opens Eclipse on the rig; import it from Eclipse's library/import menu",
			"Eclipse → ORscript: export from Eclipse (Save / Module Exporter / publish) then eclipse_import {path} converts it into ServerStorage.RobloxScript.AnimLib for animation_open / animation_preview / animation_retime …",
			"eclipse_play {path, rig_path} previews any KeyframeSequence on the rig in edit mode (Animator:StepAnimations)",
			installed and "Eclipse Animator is installed in this Studio" or ("Eclipse Animator not detected - the user can get it at " .. pluginUrl(ECLIPSE_ID) .. " (Creator Store plugin by riftkuro); ORscript's animation_* commands work without it"),
		},
	}
end
function H.eclipse_open(a)
	local rig = nil
	pcall(function() rig = rigOf(a) end)
	if rig then Selection:Set({ rig }) end
	local widgets = eclipseWidgets()
	local shown = {}
	for _, g in ipairs(widgets) do
		local okE = pcall(function() g.Enabled = true end)
		if okE then shown[#shown + 1] = g.Name end
	end
	if #widgets == 0 then
		return { opened = false, rig = rig and rig:GetFullName() or nil, reason = "no Eclipse Animator widget found - if it is installed, ask the user to click Eclipse Animator in the Plugins tab (widgets exist only after the first open); otherwise install from " .. pluginUrl(ECLIPSE_ID) }
	end
	return { opened = true, widgets = shown, rig = rig and rig:GetFullName() or nil, hint = "the rig is selected; in Eclipse create/open the animation for it. Use eclipse_handoff first if ORscript already built the clip." }
end
function H.eclipse_handoff(a)
	local rig = rigOf(a)
	local src
	if a.path then src = need(a.path, "animation") end
	if not src and a.animation then
		local lib = animLibFolder()
		src = lib:FindFirstChild(tostring(a.animation))
		if not src then error("no AnimLib animation named '" .. tostring(a.animation) .. "' (animation_list shows them)") end
	end
	if not src then
		local lib = animLibFolder()
		local active = lib:FindFirstChild("Active")
		src = active and active:IsA("StringValue") and lib:FindFirstChild(active.Value) or nil
		if not src then error("pass animation (AnimLib name) or path (KeyframeSequence)") end
	end
	local ks = findKeyframeSequence(src)
	if not ks then error(src:GetFullName() .. " contains no KeyframeSequence") end
	local rec = record("eclipse handoff")
	local copy = ks:Clone()
	copy.Name = tostring(a.name or ks.Name)
	for _, c in ipairs(copy:GetChildren()) do if not c:IsA("Keyframe") then c:Destroy() end end
	local saves = animSaves(rig)
	local old = saves:FindFirstChild(copy.Name)
	if old then old:Destroy() end
	copy.Parent = saves
	local export = ServerStorage:FindFirstChild("ORscriptAnimations")
	if not export then export = Instance.new("Folder") export.Name = "ORscriptAnimations" export.Parent = ServerStorage end
	local copy2 = copy:Clone()
	local old2 = export:FindFirstChild(copy2.Name)
	if old2 then old2:Destroy() end
	copy2.Parent = export
	commit(rec)
	local opened = H.eclipse_open({ rig_path = rig:GetFullName() })
	local n = 0
	for _, c in ipairs(copy:GetChildren()) do if c:IsA("Keyframe") then n = n + 1 end end
	return { animsaves = copy:GetFullName(), export = copy2:GetFullName(), keyframes = n, rig = rig:GetFullName(), eclipse = opened, hint = "in Eclipse Animator import the clip from the rig's AnimSaves (Import / Library → from place). Publish from Eclipse or with studio_save {action:'selection_to_roblox'} on the KeyframeSequence." }
end
function H.eclipse_import(a)
	local rig = rigOf(a)
	local src = need(a.path, "export")
	local lib = animLibFolder()
	local name = tostring(a.name or src.Name):gsub("[^%w_%- ]", "")
	if name == "" then name = "EclipseImport" end
	if not src:IsA("ModuleScript") and not src:IsA("Animation") and not findKeyframeSequence(src) then
		for _, d in ipairs(src:GetDescendants()) do if d:IsA("ModuleScript") then src = d break end end
	end
	local rec = record("eclipse import")
	local ks, info
	local okC, errC = pcall(function()
		if src:IsA("ModuleScript") then
			local okR, data = pcall(require, src)
			if not okR then error("require failed: " .. tostring(data)) end
			if type(data) == "function" then data = data(rig) end
			ks, info = tableToKeyframeSequence(data, rig, name, a.fps)
			info.source = "module"
		elseif src:IsA("Animation") then
			local id = tonumber(tostring(src.AnimationId):match("%d+"))
			if not id then error("Animation has no AnimationId") end
			local got = KeyframeSequenceProvider:GetKeyframeSequenceAsync("rbxassetid://" .. id)
			ks = got:Clone()
			ks.Name = name
			info = { source = "asset " .. id }
		else
			local found = findKeyframeSequence(src)
			if not found then error(src:GetFullName() .. " is a " .. src.ClassName .. " without a KeyframeSequence or exported ModuleScript inside") end
			ks = found:Clone()
			ks.Name = name
			info = { source = "keyframesequence " .. found:GetFullName() }
		end
	end)
	if not okC then commit(rec) error(tostring(errC)) end
	local old = lib:FindFirstChild(name)
	if old and a.overwrite ~= true then commit(rec) error("AnimLib already has '" .. name .. "' - pass overwrite=true or another name") end
	if old then old:Destroy() end
	ks.Parent = lib
	ks:SetAttribute("RS_RigPath", rig:GetFullName())
	ks:SetAttribute("Source", "EclipseAnimator")
	local active = lib:FindFirstChild("Active")
	if active and active:IsA("StringValue") then active.Value = name end
	local saves = animSaves(rig)
	local old2 = saves:FindFirstChild(name)
	if old2 then old2:Destroy() end
	local copy = ks:Clone()
	copy.Parent = saves
	commit(rec)
	local n, length = 0, 0
	for _, c in ipairs(ks:GetChildren()) do if c:IsA("Keyframe") then n = n + 1 if c.Time > length then length = c.Time end end end
	info = info or {}
	info.animlib = ks:GetFullName()
	info.animsaves = copy:GetFullName()
	info.keyframes = n
	info.length = length
	info.rig = rig:GetFullName()
	info.hint = "now animation_open {name:'" .. name .. "'} / animation_preview; animation_retime if fps was guessed (frame_based=true)"
	return info
end
local previewState = nil
function H.eclipse_play(a)
	local rig = rigOf(a)
	local action = tostring(a.action or "play"):lower()
	if action == "stop" then
		if previewState then previewState.stop = true previewState = nil end
		return { stopped = true }
	end
	local src = a.path and need(a.path, "animation") or nil
	if not src and a.animation then src = animLibFolder():FindFirstChild(tostring(a.animation)) end
	if not src then error("pass path (KeyframeSequence / Animation) or animation (AnimLib name)") end
	local animId
	local ks = findKeyframeSequence(src)
	if ks then
		local okR, id = pcall(function() return KeyframeSequenceProvider:RegisterKeyframeSequence(ks) end)
		if not okR then error("RegisterKeyframeSequence failed: " .. tostring(id)) end
		animId = id
	elseif src:IsA("Animation") then animId = src.AnimationId
	else error(src:GetFullName() .. " is neither a KeyframeSequence nor an Animation") end
	local animator = rig:FindFirstChildWhichIsA("Animator", true)
	if not animator then
		local host = rig:FindFirstChildOfClass("Humanoid") or rig:FindFirstChildOfClass("AnimationController")
		if not host then error("rig has no Humanoid / AnimationController") end
		animator = Instance.new("Animator")
		animator.Parent = host
	end
	local anim = Instance.new("Animation")
	anim.AnimationId = animId
	local track = animator:LoadAnimation(anim)
	track.Looped = a.loop == true
	if previewState then previewState.stop = true end
	local st = { stop = false }
	previewState = st
	local speed = tonumber(a.speed) or 1
	local duration = tonumber(a.duration) or (track.Length > 0 and (a.loop == true and 6 or track.Length / math.max(speed, 0.01)) or 3)
	track:Play(0.1, 1, speed)
	task.spawn(function()
		local t0 = os.clock()
		local last = t0
		while not st.stop and os.clock() - t0 < duration + 0.3 do
			local now = os.clock()
			pcall(function() animator:StepAnimations(now - last) end)
			last = now
			task.wait()
		end
		pcall(function() track:Stop(0) end)
		pcall(function() animator:StepAnimations(0) end)
		anim:Destroy()
	end)
	return { playing = true, animation_id = animId, length = track.Length, duration = duration, rig = rig:GetFullName(), hint = "or_screenshot during playback or eclipse_play {action:'stop'}; the rig returns to rest when the preview ends" }
end

-- ───────────── 1.45.0 animation publishing ─────────────
-- Studio has no Luau API that uploads an animation and a plugin cannot write
-- .rbxm binaries, but it CAN walk a KeyframeSequence and emit the equivalent
-- .rbxmx (Roblox XML). The extension (roblox.com session) or or-core (Open
-- Cloud key) uploads that as an Animation asset; animation_apply then wires
-- the returned id into ReplicatedStorage.Animations.
local function xmlEsc(v)
	return (tostring(v):gsub("[&<>\"']", { ["&"] = "&amp;", ["<"] = "&lt;", [">"] = "&gt;", ['"'] = "&quot;", ["'"] = "&apos;" }))
end
local function xmlNum(n)
	n = tonumber(n) or 0
	if n ~= n or n == math.huge or n == -math.huge then n = 0 end
	if n == math.floor(n) and math.abs(n) < 1e15 then return string.format("%d", n) end
	return string.format("%.9g", n)
end
local function xmlCFrame(name, cf)
	local keys = { "X", "Y", "Z", "R00", "R01", "R02", "R10", "R11", "R12", "R20", "R21", "R22" }
	local vals = { cf:GetComponents() }
	local parts = {}
	for i, k in ipairs(keys) do parts[#parts + 1] = "<" .. k .. ">" .. xmlNum(vals[i]) .. "</" .. k .. ">" end
	return '<CoordinateFrame name="' .. name .. '">' .. table.concat(parts) .. "</CoordinateFrame>"
end
local function poseXml(pose, out, st)
	st.ref = st.ref + 1
	st.poses = st.poses + 1
	out[#out + 1] = '<Item class="Pose" referent="RBX' .. st.ref .. '"><Properties>'
	out[#out + 1] = xmlCFrame("CFrame", pose.CFrame)
	out[#out + 1] = '<token name="EasingDirection">' .. tostring(pose.EasingDirection.Value) .. '</token>'
	out[#out + 1] = '<token name="EasingStyle">' .. tostring(pose.EasingStyle.Value) .. '</token>'
	out[#out + 1] = '<string name="Name">' .. xmlEsc(pose.Name) .. '</string>'
	out[#out + 1] = '<float name="Weight">' .. xmlNum(pose.Weight) .. '</float>'
	out[#out + 1] = '</Properties>'
	for _, child in ipairs(pose:GetChildren()) do
		if child:IsA("Pose") then poseXml(child, out, st) end
	end
	out[#out + 1] = '</Item>'
end
local function keyframeSequenceXml(ks)
	local st = { ref = 1, poses = 0, markers = 0 }
	local out = {}
	out[#out + 1] = '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">'
	out[#out + 1] = '<Meta name="ExplicitAutoJoints">true</Meta><External>null</External><External>nil</External>'
	out[#out + 1] = '<Item class="KeyframeSequence" referent="RBX1"><Properties>'
	out[#out + 1] = '<float name="AuthoredHipHeight">' .. xmlNum(ks.AuthoredHipHeight) .. '</float>'
	out[#out + 1] = '<bool name="Loop">' .. tostring(ks.Loop == true) .. '</bool>'
	out[#out + 1] = '<string name="Name">' .. xmlEsc(ks.Name) .. '</string>'
	out[#out + 1] = '<token name="Priority">' .. tostring(ks.Priority.Value) .. '</token>'
	out[#out + 1] = '</Properties>'
	local frames = ks:GetKeyframes()
	table.sort(frames, function(x, y) return x.Time < y.Time end)
	local length = 0
	for _, kf in ipairs(frames) do
		st.ref = st.ref + 1
		if kf.Time > length then length = kf.Time end
		out[#out + 1] = '<Item class="Keyframe" referent="RBX' .. st.ref .. '"><Properties>'
		out[#out + 1] = '<string name="Name">' .. xmlEsc(kf.Name) .. '</string>'
		out[#out + 1] = '<float name="Time">' .. xmlNum(kf.Time) .. '</float>'
		out[#out + 1] = '</Properties>'
		for _, child in ipairs(kf:GetChildren()) do
			if child:IsA("Pose") then
				poseXml(child, out, st)
			elseif child:IsA("KeyframeMarker") then
				st.ref = st.ref + 1
				st.markers = st.markers + 1
				out[#out + 1] = '<Item class="KeyframeMarker" referent="RBX' .. st.ref .. '"><Properties><string name="Name">' .. xmlEsc(child.Name) .. '</string><string name="Value">' .. xmlEsc(child.Value) .. '</string></Properties></Item>'
			end
		end
		out[#out + 1] = '</Item>'
	end
	out[#out + 1] = '</Item></roblox>'
	return table.concat(out), #frames, st.poses, st.markers, length
end
local function animationSource(a)
	local src
	if a.path then src = need(a.path, "animation") end
	local clip = a.animation or a.clip
	if not src and clip then
		local lib = animLibFolder()
		src = lib:FindFirstChild(tostring(clip))
		if not src and a.rig_path then
			local rig = resolve(a.rig_path)
			local saves = rig and rig:FindFirstChild("AnimSaves")
			src = saves and saves:FindFirstChild(tostring(clip)) or nil
		end
		if not src then
			for _, root in ipairs({ ServerStorage, ReplicatedStorage, workspace }) do
				for _, d in ipairs(root:GetDescendants()) do
					if d:IsA("KeyframeSequence") and d.Name == tostring(clip) then src = d break end
				end
				if src then break end
			end
		end
		if not src then error("no KeyframeSequence named '" .. tostring(clip) .. "' (animation_list shows AnimLib clips; or pass path)") end
	end
	if not src then
		for _, sel in ipairs(Selection:Get()) do local k = findKeyframeSequence(sel) if k then src = k break end end
	end
	if not src then
		local lib = animLibFolder()
		local active = lib:FindFirstChild("Active")
		src = active and active:IsA("StringValue") and lib:FindFirstChild(active.Value) or nil
	end
	if not src then error("pass path (a KeyframeSequence), animation (AnimLib / AnimSaves clip name) or select one in the Explorer") end
	local ks = findKeyframeSequence(src)
	if not ks then error(src:GetFullName() .. " contains no KeyframeSequence") end
	return ks
end
function H.animation_export(a)
	local ks = animationSource(a)
	local xml, frames, poses, markers, length = keyframeSequenceXml(ks)
	if frames == 0 then error(ks:GetFullName() .. " has no Keyframes - nothing to publish") end
	if poses == 0 then error(ks:GetFullName() .. " has keyframes but no Poses - nothing would move") end
	if #xml > 1500000 then error(ks:GetFullName() .. " serialises to " .. #xml .. " bytes - too large; reduce keyframes (animation_retime) or split the clip") end
	local okU, userId = pcall(function() return StudioService:GetUserId() end)
	return {
		name = ks.Name,
		path = ks:GetFullName(),
		xml = xml,
		bytes = #xml,
		keyframes = frames,
		poses = poses,
		markers = markers,
		length = length,
		loop = ks.Loop,
		priority = ks.Priority.Name,
		creator_type = (tostring(game.CreatorType):gsub("^Enum%.CreatorType%.", "")),
		creator_id = game.CreatorId,
		user_id = okU and userId or 0,
	}
end
function H.animation_apply(a)
	local id = tonumber(a.asset_id or a.assetId or a.id)
	if not id or id < 1 then error("asset_id required (the published animation id)") end
	id = math.floor(id)
	local name = tostring(a.name or "Animation")
	local rec = record("animation publish")
	local src = a.path and resolve(a.path) or nil
	local ks = src and findKeyframeSequence(src) or nil
	if ks then
		pcall(function()
			ks:SetAttribute("PublishedAssetId", id)
			ks:SetAttribute("PublishedAt", os.date("!%Y-%m-%dT%H:%M:%SZ"))
		end)
		if not a.name then name = ks.Name end
	end
	local parent = a.parent and need(a.parent, "parent") or nil
	if not parent then
		parent = ReplicatedStorage:FindFirstChild("Animations")
		if not parent then parent = Instance.new("Folder") parent.Name = "Animations" parent.Parent = ReplicatedStorage end
	end
	local anim = parent:FindFirstChild(name)
	if not (anim and anim:IsA("Animation")) then anim = Instance.new("Animation") anim.Name = name anim.Parent = parent end
	anim.AnimationId = "rbxassetid://" .. tostring(id)
	anim:SetAttribute("PublishedAt", os.date("!%Y-%m-%dT%H:%M:%SZ"))
	local rigCopy
	if a.rig_path then
		local rig = resolve(a.rig_path)
		if rig then
			local folder = rig:FindFirstChild("Animations")
			if not folder then folder = Instance.new("Folder") folder.Name = "Animations" folder.Parent = rig end
			local old = folder:FindFirstChild(name)
			if old then old:Destroy() end
			rigCopy = anim:Clone()
			rigCopy.Parent = folder
		end
	end
	commit(rec)
	pcall(function() Selection:Set({ anim }) end)
	return {
		path = anim:GetFullName(),
		animation_id = anim.AnimationId,
		asset_id = id,
		source = ks and ks:GetFullName() or nil,
		rig_copy = rigCopy and rigCopy:GetFullName() or nil,
		play = 'local anim = game.ReplicatedStorage.Animations:WaitForChild("' .. name:gsub('"', '') .. '") local track = humanoid:FindFirstChildOfClass("Animator"):LoadAnimation(anim) track:Play()',
		hint = "a freshly uploaded animation can take ~10-60 s to load in Studio; it is private to the creator (user or group) that owns it",
	}
end

-- expose helpers to plugin_execute_luau code as the `ORscript` global
for k, v in pairs({
	resolve = resolve, need = need, toJson = toJson, fromJson = fromJson, toCFrame = toCFrame, toVector3 = toVector3,
	bus = BUS, plugins = function() return H.plugins_list({}) end, widgets = findWidget, log = log,
	record = record, commit = commit, handlers = H, version = VERSION,
}) do ORSCRIPT_ENV[k] = v end

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
	-- 1.35.0: a bridge hiccup right as a job finishes used to drop the result on
	-- the floor (or-core then waited out its full timeout). Retry the POST a few
	-- times with a short backoff before giving up; the work itself is not redone.
	local delivered = false
	for attempt = 1, 4 do
		local okP, errP = request("POST", "/api/plugin/result", result)
		if okP then delivered = true break end
		if attempt < 4 then task.wait(attempt * 0.75) else log("result for " .. tostring(job.name) .. " not delivered: " .. tostring(errP)) end
	end
	return delivered
end

local unloading = false
plugin.Unloading:Connect(function() unloading = true end)

task.spawn(function()
	pcall(function() HttpService.HttpEnabled = true end)
	local connected = false
	local lastHello = 0
	-- 1.35.0: while or-core is down, back off from 3 s up to 15 s between hellos
	-- (instead of knocking every 3 s for hours); the first successful hello
	-- resets it. A failed poll also waits a little longer each time in a row so a
	-- restarting bridge is not hammered, and the whole loop body is pcall-guarded
	-- so one unexpected error can never kill the poller for the session.
	local offlineWait, pollFailures = 3, 0
	while not unloading do
		local okLoop, errLoop = pcall(function()
			if not enabled then
				setStatus("paused", false)
				task.wait(1)
				return
			end
			if os.clock() - lastHello > 25 or not connected then
				connected = hello()
				lastHello = os.clock()
				if not connected then
					task.wait(offlineWait)
					offlineWait = math.min(15, offlineWait + 3)
					return
				end
				offlineWait = 3
			end
			local data, err = request("GET", "/api/plugin/poll?client_id=" .. CLIENT_ID)
			if not data then
				connected = false
				pollFailures = pollFailures + 1
				setStatus("lost or-core: " .. tostring(err), false)
				task.wait(math.min(10, 2 * pollFailures))
			else
				pollFailures = 0
				if data.job then task.spawn(runJob, data.job) end
			end
		end)
		if not okLoop then
			log("poll loop error: " .. tostring(errLoop))
			task.wait(2)
		end
	end
end)

log("ORscript plugin " .. VERSION .. " loaded - open the ORscript panel from the Plugins tab")
