// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript verify pack (2.13.0) - place checkpoints and UI wiring tests.
//
//   place_checkpoint {op:save|restore|list|diff|delete, path, name}
//       Scoped "time machine": save = Clone() of one subtree (or a service's
//       properties + children) into ServerStorage._TotalCheckpoints.<name>
//       with label / time / source / counts as attributes; restore = destroy
//       the current subtree and clone the saved one back under the original
//       parent; diff = walk saved vs current by path and report added /
//       removed / changed instances (class, Size, CFrame, Color, Material,
//       Transparency, Visible, Text, Source hash); list / delete manage them.
//       Not a replacement for Studio's undo: it is the thing the agent calls
//       BEFORE a risky generator and after a bad result ("restore shop_v1").
//
//   ui_test {path, actions?, expect?, expect_only?}
//       The UI equivalent of the play-test / console loop. Static: every
//       GuiButton under path is classified as wired (Total_Action attribute
//       from the design pack, a Total_Toggle / click LocalScript on the
//       button, or any script in the GUI / StarterPlayerScripts that names
//       the button together with Activated / MouseButton1Click) or DEAD.
//       Simulated: actions [{click:"Shop"}] are applied with the real
//       Total_Controller semantics (close / toggle:X / open:X / remote:X /
//       print) and ui_state_toggle scripts on a virtual visibility state,
//       then expect [{path, Visible:true}] is evaluated. Touch targets are
//       measured at 1280x720 and 844x390. A live_plan lists the exact
//       user_mouse_input calls for Play mode, because a plugin cannot
//       synthesize clicks (VirtualInputManager is RobloxScriptSecurity).
//       expect_only:true evaluates the expectations against the live state
//       (PlayerGui when the game runs) - that is the second half of the plan.
//
// Plain Lua syntax only (no +=, continue, ::) so tests/luau-parse-check.py and
// the mocked DataModel in tests/verify-sim.py can run it.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;
  const VERSION = "2.13.0";
  const CP_OPS = ["save", "restore", "list", "diff", "delete"];
  const STORE = "_TotalCheckpoints";
  const MAX_SAVE = 20000;

  const LIB = String.raw`
local HttpService = game:GetService("HttpService")
local ServerStorage = game:GetService("ServerStorage")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local VF = {}
VF.VERSION = "__VERSION__"
local STORE = "__STORE__"
local MAX_SAVE = __MAX_SAVE__
local function okj(d, t) return HttpService:JSONEncode({ ok = true, data = d or {}, text = t or "" }) end
local function failj(m) return HttpService:JSONEncode({ ok = false, error = tostring(m) }) end
local function parentOf(path)
  if path == nil or path == "" then return workspace end
  if tostring(path):lower() == "game" then return game end
  local node = game
  for seg in tostring(path):gsub("^game%.", ""):gmatch("[^%.]+") do
    local nxt = nil
    if node == game then
      if seg:lower() == "workspace" then nxt = workspace
      else local okS, s = pcall(function() return game:GetService(seg) end) nxt = okS and s or game:FindFirstChild(seg) end
    else nxt = node:FindFirstChild(seg) end
    if not nxt then error("path not found: " .. tostring(path) .. " (at '" .. seg .. "')") end
    node = nxt
  end
  return node
end
local function isService(inst) return inst ~= nil and inst.Parent == game end
local function countDesc(inst) local n = 0 for _, _d in ipairs(inst:GetDescendants()) do n = n + 1 end return n end
local function store(create)
  local f = ServerStorage:FindFirstChild(STORE)
  if not f and create then f = Instance.new("Folder") f.Name = STORE f.Parent = ServerStorage end
  return f
end
local function waypoint(label) pcall(function() local chs = game:GetService("ChangeHistoryService") if chs and chs.SetWaypoint then chs:SetWaypoint(label) end end) end
local function strhash(s)
  local h = 5381
  for i = 1, #s do h = (h * 33 + string.byte(s, i)) % 4294967296 end
  return h
end
local function r2(v) return math.floor(v * 100 + 0.5) / 100 end
local function propsOfService(inst)
  local out = {}
  local names
  local id = inst.Name -- services are named after their class (Lighting, Workspace, SoundService)
  if id == "Lighting" then names = { "Ambient", "OutdoorAmbient", "Brightness", "ClockTime", "TimeOfDay", "FogEnd", "FogStart", "FogColor", "GlobalShadows", "ExposureCompensation", "EnvironmentDiffuseScale", "EnvironmentSpecularScale", "ColorShift_Top", "ColorShift_Bottom", "GeographicLatitude", "ShadowSoftness" }
  elseif id == "Workspace" then names = { "Gravity", "FallenPartsDestroyHeight", "StreamingEnabled" }
  elseif id == "SoundService" then names = { "AmbientReverb", "DistanceFactor", "DopplerScale", "RolloffScale", "RespectFilteringEnabled" }
  else names = {} end
  for _, k in ipairs(names) do
    local okG, v = pcall(function() return inst[k] end)
    if okG and v ~= nil then
      local t = typeof(v)
      if t == "Color3" then out[k] = { "Color3", r2(v.R), r2(v.G), r2(v.B) }
      elseif t == "EnumItem" then out[k] = { "Enum", tostring(v.EnumType), v.Name }
      elseif t == "number" or t == "boolean" or t == "string" then out[k] = v end
    end
  end
  return out
end
local function applyServiceProps(inst, props)
  local n = 0
  for k, v in pairs(props or {}) do
    local okS = pcall(function()
      if type(v) == "table" and v[1] == "Color3" then inst[k] = Color3.new(v[2], v[3], v[4])
      elseif type(v) == "table" and v[1] == "Enum" then inst[k] = Enum[v[2]][v[3]]
      else inst[k] = v end
    end)
    if okS then n = n + 1 end
  end
  return n
end
local function skipChild(c)
  if c:IsA("Terrain") or c:IsA("Camera") then return true end
  if c:IsA("Model") then local okP, pl = pcall(function() return Players:GetPlayerFromCharacter(c) end) if okP and pl ~= nil then return true end end
  return false
end

-- key props compared by diff (per class family)
local function sig(inst)
  local s = { class = inst.ClassName }
  if inst:IsA("BasePart") then
    local cf = inst.CFrame
    local x, y, z = cf.X, cf.Y, cf.Z
    local okA, rx, ry, rz = pcall(function() return cf:ToEulerAnglesXYZ() end)
    s.size = { r2(inst.Size.X), r2(inst.Size.Y), r2(inst.Size.Z) }
    s.pos = { r2(x), r2(y), r2(z) }
    if okA then s.rot = { r2(math.deg(rx)), r2(math.deg(ry)), r2(math.deg(rz)) } end
    s.color = { r2(inst.Color.R), r2(inst.Color.G), r2(inst.Color.B) }
    s.material = inst.Material.Name
    s.transparency = r2(inst.Transparency)
    s.anchored = inst.Anchored
  elseif inst:IsA("GuiObject") then
    local sz, ps = inst.Size, inst.Position
    s.size = { r2(sz.X.Scale), sz.X.Offset, r2(sz.Y.Scale), sz.Y.Offset }
    s.pos = { r2(ps.X.Scale), ps.X.Offset, r2(ps.Y.Scale), ps.Y.Offset }
    s.visible = inst.Visible
    s.transparency = r2(inst.BackgroundTransparency)
    s.color = { r2(inst.BackgroundColor3.R), r2(inst.BackgroundColor3.G), r2(inst.BackgroundColor3.B) }
    local okT, txt = pcall(function() return inst.Text end)
    if okT and type(txt) == "string" then s.text = txt end
  elseif inst:IsA("LuaSourceContainer") then
    local okS, src = pcall(function() return inst.Source end)
    if okS and type(src) == "string" then s.source = strhash(src) s.lines = select(2, src:gsub("\n", "\n")) + 1 end
  elseif inst:IsA("Light") then
    s.brightness = r2(inst.Brightness) s.range = r2(inst.Range) s.enabled = inst.Enabled
    s.color = { r2(inst.Color.R), r2(inst.Color.G), r2(inst.Color.B) }
  elseif inst:IsA("ValueBase") then
    local okV, v = pcall(function() return inst.Value end)
    if okV then s.value = tostring(v) end
  end
  return s
end
local function flat(root, includeRoot)
  local out = {}
  local function key(inst, prefix)
    return (prefix == "" and "" or prefix .. ".") .. inst.Name
  end
  local function walk(inst, prefix)
    local seen = {}
    for _, c in ipairs(inst:GetChildren()) do
      if not skipChild(c) then
        local k = key(c, prefix)
        local n = (seen[k] or 0) + 1 seen[k] = n
        if n > 1 then k = k .. "#" .. n end
        out[k] = sig(c)
        walk(c, k)
      end
    end
  end
  if includeRoot then out[root.Name] = sig(root) walk(root, root.Name) else walk(root, "") end
  return out
end
local function same(a, b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= "table" then return a == b end
  for k, v in pairs(a) do if not same(v, b[k]) then return false end end
  for k, _v in pairs(b) do if a[k] == nil then return false end end
  return true
end
local function diffMaps(saved, current, cap)
  local added, removed, changed = {}, {}, {}
  local nA, nR, nC = 0, 0, 0
  for k, s in pairs(saved) do
    local c = current[k]
    if c == nil then nR = nR + 1 if #removed < cap then removed[#removed + 1] = k .. " (" .. s.class .. ")" end
    else
      local fields = {}
      for f, v in pairs(s) do if not same(v, c[f]) then fields[#fields + 1] = f end end
      for f, _v in pairs(c) do if s[f] == nil then fields[#fields + 1] = f end end
      if #fields > 0 then table.sort(fields) nC = nC + 1 if #changed < cap then changed[#changed + 1] = { path = k, class = c.class, fields = fields } end end
    end
  end
  for k, c in pairs(current) do if saved[k] == nil then nA = nA + 1 if #added < cap then added[#added + 1] = k .. " (" .. c.class .. ")" end end end
  table.sort(added) table.sort(removed)
  return { added = added, removed = removed, changed = changed, added_count = nA, removed_count = nR, changed_count = nC }
end

local function entryOf(f, name, sourcePath)
  if name and name ~= "" then
    local e = f:FindFirstChild(name)
    if e then return e end
    return nil
  end
  local best
  for _, e in ipairs(f:GetChildren()) do
    if (sourcePath == nil or e:GetAttribute("Total_Source") == sourcePath) and (best == nil or (tonumber(e:GetAttribute("Total_Time")) or 0) >= (tonumber(best:GetAttribute("Total_Time")) or 0)) then best = e end
  end
  return best
end
local function describe(e)
  return { name = e.Name, label = e:GetAttribute("Total_Label"), source = e:GetAttribute("Total_Source"), class = e:GetAttribute("Total_Class"), kind = e:GetAttribute("Total_Kind"), count = e:GetAttribute("Total_Count"), time = e:GetAttribute("Total_Time"), age_s = os.time() - (tonumber(e:GetAttribute("Total_Time")) or os.time()) }
end
local function savedRoot(e)
  local kind = e:GetAttribute("Total_Kind")
  if kind == "service" then return e:FindFirstChild("Children") end
  local sv = e:FindFirstChild("Saved")
  return sv and sv:GetChildren()[1] or nil
end

function VF.checkpoint(a)
  local op = tostring(a.op or "save"):lower()
  if op == "list" then
    local f = store(false)
    local items = {}
    if f then for _, e in ipairs(f:GetChildren()) do items[#items + 1] = describe(e) end end
    table.sort(items, function(x, y) return (tonumber(x.time) or 0) > (tonumber(y.time) or 0) end)
    return okj({ count = #items, checkpoints = items, store = "ServerStorage." .. STORE }, #items == 0 and "no checkpoints yet - place_checkpoint {op:'save', path:'Workspace.Shop', name:'shop_v1'} before a risky change" or (#items .. " checkpoint(s)"))
  end
  if op == "delete" then
    local f = store(false)
    if not f then return okj({ removed = 0 }, "nothing to delete") end
    local n = 0
    if a.name == "*" or a.all == true then for _, e in ipairs(f:GetChildren()) do e:Destroy() n = n + 1 end
    else local e = entryOf(f, a.name, a.path) if not e then return failj("checkpoint not found: " .. tostring(a.name or a.path)) end e:Destroy() n = 1 end
    return okj({ removed = n }, "removed " .. n .. " checkpoint(s)")
  end
  if op == "save" then
    if a.path == nil or a.path == "" then return failj("path is required (e.g. 'Workspace.Shop', 'StarterGui.ShopGui', 'Lighting')") end
    local inst = parentOf(a.path)
    if inst == game then return failj("cannot checkpoint the whole game - pick a service or a subtree") end
    local n = countDesc(inst)
    if n > MAX_SAVE then return failj("subtree has " .. n .. " descendants (limit " .. MAX_SAVE .. ") - checkpoint a narrower path") end
    local f = store(true)
    local name = tostring(a.name or ("cp_" .. os.time()))
    local old = f:FindFirstChild(name)
    if old then if a.replace == false then return failj("checkpoint '" .. name .. "' exists - pass replace:true or another name") end old:Destroy() end
    local e = Instance.new("Folder") e.Name = name
    local kind = isService(inst) and "service" or "instance"
    local saved = 0
    if kind == "service" then
      local pv = Instance.new("StringValue") pv.Name = "Props" pv.Value = HttpService:JSONEncode(propsOfService(inst)) pv.Parent = e
      local ch = Instance.new("Folder") ch.Name = "Children" ch.Parent = e
      for _, c in ipairs(inst:GetChildren()) do
        if not skipChild(c) and c.Archivable ~= false then local okC, cl = pcall(function() return c:Clone() end) if okC and cl then cl.Parent = ch saved = saved + 1 end end
      end
    else
      local sv = Instance.new("Folder") sv.Name = "Saved" sv.Parent = e
      local okC, cl = pcall(function() return inst:Clone() end)
      if not okC or not cl then e:Destroy() return failj("Clone() failed for " .. inst:GetFullName() .. " (Archivable=false?)") end
      cl.Parent = sv saved = 1
    end
    local mv = Instance.new("StringValue") mv.Name = "Map" mv.Value = HttpService:JSONEncode(flat(inst, kind ~= "service")) mv.Parent = e
    e:SetAttribute("Total_Label", tostring(a.label or name))
    e:SetAttribute("Total_Source", inst:GetFullName())
    e:SetAttribute("Total_Class", inst.ClassName)
    e:SetAttribute("Total_Kind", kind)
    e:SetAttribute("Total_Count", n)
    e:SetAttribute("Total_Time", os.time())
    e.Parent = f
    return okj({ name = name, source = inst:GetFullName(), kind = kind, descendants = n, saved_children = saved, store = "ServerStorage." .. STORE .. "." .. name }, "checkpoint '" .. name .. "' saved for " .. inst:GetFullName() .. " (" .. n .. " descendants). Restore with place_checkpoint {op:'restore', name:'" .. name .. "'}; compare later with {op:'diff', name:'" .. name .. "'}")
  end
  local f = store(false)
  if not f then return failj("no checkpoints exist yet (ServerStorage." .. STORE .. " missing)") end
  local e = entryOf(f, a.name, a.path)
  if not e then return failj("checkpoint not found: " .. tostring(a.name or a.path or "(latest)") .. " - place_checkpoint {op:'list'}") end
  local source = e:GetAttribute("Total_Source")
  local kind = e:GetAttribute("Total_Kind")
  if op == "diff" then
    local okP, inst = pcall(parentOf, a.path or source)
    if not okP or not inst then return okj({ name = e.Name, source = source, missing = true }, "the checkpointed instance " .. tostring(source) .. " no longer exists - restore recreates it") end
    local mapV = e:FindFirstChild("Map")
    local saved = mapV and HttpService:JSONDecode(mapV.Value) or flat(savedRoot(e) or e, kind ~= "service")
    local current = flat(inst, kind ~= "service")
    local d = diffMaps(saved, current, tonumber(a.limit) or 60)
    local total = d.added_count + d.removed_count + d.changed_count
    local text
    if total == 0 then text = "no differences between checkpoint '" .. e.Name .. "' and " .. inst:GetFullName() .. " - nothing changed since the save"
    else text = "since checkpoint '" .. e.Name .. "': " .. d.added_count .. " added, " .. d.removed_count .. " removed, " .. d.changed_count .. " changed under " .. inst:GetFullName() end
    d.name = e.Name d.source = source d.identical = total == 0
    return okj(d, text)
  end
  if op == "restore" then
    local parentPath = source:match("^(.*)%.[^%.]+$")
    local leaf = source:match("([^%.]+)$")
    if kind == "service" then
      local inst = parentOf(source)
      local pv = e:FindFirstChild("Props")
      local nProps = pv and applyServiceProps(inst, HttpService:JSONDecode(pv.Value)) or 0
      waypoint("TotalScript checkpoint restore " .. e.Name)
      local removed, added = 0, 0
      for _, c in ipairs(inst:GetChildren()) do if not skipChild(c) and c.Archivable ~= false then c:Destroy() removed = removed + 1 end end
      local ch = e:FindFirstChild("Children")
      if ch then for _, c in ipairs(ch:GetChildren()) do local cl = c:Clone() cl.Parent = inst added = added + 1 end end
      waypoint("TotalScript checkpoint restored " .. e.Name)
      return okj({ name = e.Name, source = source, kind = kind, props_applied = nProps, removed = removed, restored = added }, "restored '" .. e.Name .. "' into " .. source .. ": " .. nProps .. " properties, " .. removed .. " child(ren) removed, " .. added .. " restored (Terrain / Camera / player characters untouched)")
    end
    local savedInst = savedRoot(e)
    if not savedInst then return failj("checkpoint '" .. e.Name .. "' has no saved instance") end
    local okPar, parent = pcall(parentOf, parentPath)
    if not okPar or not parent then return failj("the original parent " .. tostring(parentPath) .. " no longer exists - recreate it first, then restore") end
    waypoint("TotalScript checkpoint restore " .. e.Name)
    local removed = 0
    local cur = parent:FindFirstChild(leaf)
    while cur do cur:Destroy() removed = removed + 1 cur = parent:FindFirstChild(leaf) end
    local cl = savedInst:Clone()
    cl.Parent = parent
    waypoint("TotalScript checkpoint restored " .. e.Name)
    return okj({ name = e.Name, source = source, kind = kind, removed = removed, restored = cl:GetFullName(), descendants = countDesc(cl) }, "restored '" .. e.Name .. "' -> " .. cl:GetFullName() .. " (" .. countDesc(cl) .. " descendants; " .. removed .. " current copy(ies) replaced). The checkpoint is kept; delete it with {op:'delete', name:'" .. e.Name .. "'} when done")
  end
  return failj("unknown op '" .. op .. "' - use save | restore | list | diff | delete")
end

-- ------------------------- ui_test -------------------------
local function guiRootOf(inst)
  local n = inst
  while n and n ~= game do if n:IsA("LayerCollector") then return n end n = n.Parent end
  return nil
end
local function liveGui(path)
  -- in Play mode StarterGui is copied to every PlayerGui: prefer the live copy
  local okR, running = pcall(function() return RunService:IsRunning() end)
  if okR and running and tostring(path):match("^StarterGui%.") then
    local p = Players:GetPlayers()[1]
    local pg = p and p:FindFirstChildOfClass("PlayerGui")
    if pg then
      local okL, inst = pcall(parentOf, "Players." .. p.Name .. ".PlayerGui." .. tostring(path):gsub("^StarterGui%.", ""))
      if okL and inst then return inst, true end
    end
  end
  return parentOf(path), false
end
local function relName(inst, root)
  local parts = {}
  local n = inst
  while n and n ~= root do table.insert(parts, 1, n.Name) n = n.Parent end
  return table.concat(parts, ".")
end
local function absSize(inst, screenW, screenH)
  -- walks the ancestor chain: size = scale * parent + offset (UIScale / constraints ignored)
  local chain = {}
  local n = inst
  while n and not n:IsA("LayerCollector") do if n:IsA("GuiObject") then table.insert(chain, 1, n) end n = n.Parent end
  local w, h = screenW, screenH
  for _, g in ipairs(chain) do
    local s = g.Size
    w = s.X.Scale * w + s.X.Offset
    h = s.Y.Scale * h + s.Y.Offset
  end
  return w, h
end
local function scriptsOf(root)
  local out = {}
  for _, d in ipairs(root:GetDescendants()) do if d:IsA("LuaSourceContainer") then out[#out + 1] = d end end
  local sps = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts")
  if sps then for _, d in ipairs(sps:GetDescendants()) do if d:IsA("LuaSourceContainer") then out[#out + 1] = d end end end
  return out
end
local function srcOf(s) local okS, src = pcall(function() return s.Source end) return okS and type(src) == "string" and src or "" end
local function plainFind(hay, needle) return string.find(hay, needle, 1, true) ~= nil end
local CLICK_WORDS = { "Activated", "MouseButton1Click", "MouseButton1Down", "MouseButton1Up", "InputBegan" }
local function hasClickWord(src) for _, w in ipairs(CLICK_WORDS) do if plainFind(src, w) then return w end end return nil end
local function wiringOf(btn, root, scripts)
  local act = btn:GetAttribute("Total_Action")
  if type(act) == "string" and act ~= "" then
    if root:FindFirstChild("Total_Controller", true) or root:FindFirstChildOfClass("LocalScript") then return "attribute", "Total_Action=" .. act, act end
    return "attribute_no_controller", "Total_Action=" .. act .. " but no Total_Controller LocalScript in the GUI (run ui_states_wire)", act
  end
  for _, d in ipairs(btn:GetDescendants()) do
    if d:IsA("LuaSourceContainer") then
      local src = srcOf(d)
      local mode = src:match("^%-%- TotalScript ui_state_toggle: (%a+)")
      if mode then return "toggle_script", d.Name .. " (ui_state_toggle " .. mode .. ")", "script_toggle:" .. mode .. ":" .. (src:match('local TARGET = "([^"]*)"') or "") end
      local w = hasClickWord(src)
      if w then return "own_script", d.Name .. " (" .. w .. ")", nil end
    end
  end
  for _, s in ipairs(scripts) do
    if not s:IsDescendantOf(btn) then
      local src = srcOf(s)
      local named = plainFind(src, '"' .. btn.Name .. '"') or plainFind(src, "'" .. btn.Name .. "'") or plainFind(src, "." .. btn.Name .. ".") or plainFind(src, "." .. btn.Name .. ":")
      if named then
        local w = hasClickWord(src)
        if w then return "external_script", s:GetFullName() .. " (" .. w .. ")", nil end
      end
    end
  end
  return nil, "no Total_Action attribute, no click script on the button, no script in the GUI / StarterPlayerScripts names it with Activated / MouseButton1Click", nil
end
local function findIn(root, name)
  if name == nil then return nil end
  local okP, inst = pcall(parentOf, name)
  if okP and inst and inst ~= workspace then return inst end
  return root:FindFirstChild(tostring(name), true)
end
local function isGuiButton(o) return o:IsA("GuiButton") end

function VF.uiTest(a)
  if a.path == nil or a.path == "" then return failj("path is required (a ScreenGui or Frame, e.g. 'StarterGui.ShopGui')") end
  local root, live = liveGui(a.path)
  if not root:IsA("GuiBase2d") and not root:IsA("LayerCollector") then return failj(root:GetFullName() .. " is a " .. root.ClassName .. ", not a GUI") end
  local gui = guiRootOf(root) or root
  local scripts = scriptsOf(gui)
  local buttons = {}
  if isGuiButton(root) then buttons[#buttons + 1] = root end
  for _, d in ipairs(root:GetDescendants()) do if isGuiButton(d) then buttons[#buttons + 1] = d end end
  local wired, dead, small = {}, {}, {}
  local byName = {}
  local actionOf = {}
  for _, b in ipairs(buttons) do
    local how, detail, act = wiringOf(b, gui, scripts)
    local rel = relName(b, gui)
    byName[b.Name] = byName[b.Name] or b
    local wD, hD = absSize(b, 1280, 720)
    local wP, hP = absSize(b, 844, 390)
    local row = { name = b.Name, path = b:GetFullName(), rel = rel, how = how, detail = detail, size_desktop = { math.floor(wD + 0.5), math.floor(hD + 0.5) }, size_phone = { math.floor(wP + 0.5), math.floor(hP + 0.5) }, visible = b.Visible, active = b.Active }
    if how and how ~= "attribute_no_controller" then wired[#wired + 1] = row else dead[#dead + 1] = row end
    if math.min(wP, hP) < 36 then small[#small + 1] = { name = b.Name, path = b:GetFullName(), phone_px = { math.floor(wP + 0.5), math.floor(hP + 0.5) } } end
    actionOf[b] = act
  end
  -- expect_only: just read the live state
  local function visibleState()
    local st = {}
    for _, d in ipairs(gui:GetDescendants()) do if d:IsA("GuiObject") then st[d] = d.Visible end end
    st[gui] = gui.Enabled
    return st
  end
  local state = visibleState()
  local function windowOf(inst) local n = inst while n and n ~= gui do if n:IsA("GuiObject") and n:GetAttribute("Total_Window") then return n end n = n.Parent end return nil end
  local simulated, unsimulated = {}, {}
  if not a.expect_only then
    for i, step in ipairs(a.actions or {}) do
      local target = step.click or step.press or step.tap
      local b = target and (findIn(root, target)) or nil
      if not b or not isGuiButton(b) then unsimulated[#unsimulated + 1] = { step = i, click = tostring(target), reason = "no GuiButton named " .. tostring(target) .. " under " .. root:GetFullName() }
      else
        local act = actionOf[b]
        local effect = nil
        if act == nil then
          local how = nil for _, r in ipairs(wired) do if r.path == b:GetFullName() then how = r.how end end
          unsimulated[#unsimulated + 1] = { step = i, click = b.Name, reason = how and ("wired by " .. how .. " - custom script behaviour cannot be simulated statically; use the live_plan") or "DEAD BUTTON - nothing is wired to it" }
        elseif act == "close" then
          local win = windowOf(b)
          if win then state[win] = false effect = win.Name .. ".Visible=false" else state[gui] = false effect = gui.Name .. ".Enabled=false" end
        elseif act:sub(1, 7) == "toggle:" then
          local el = gui:FindFirstChild(act:sub(8), true)
          if el and el:IsA("GuiObject") then state[el] = not state[el] effect = el.Name .. ".Visible=" .. tostring(state[el]) else unsimulated[#unsimulated + 1] = { step = i, click = b.Name, reason = "Total_Action '" .. act .. "' targets nothing named " .. act:sub(8) .. " inside " .. gui.Name .. " (Total_Controller would warn at runtime)" } end
        elseif act:sub(1, 5) == "open:" then
          local el = gui:FindFirstChild(act:sub(6), true)
          if el and el:IsA("GuiObject") then state[el] = true effect = el.Name .. ".Visible=true" else unsimulated[#unsimulated + 1] = { step = i, click = b.Name, reason = "Total_Action '" .. act .. "' targets nothing named " .. act:sub(6) } end
        elseif act:sub(1, 7) == "remote:" then
          local rname = act:sub(8)
          local RS = game:GetService("ReplicatedStorage")
          local r = RS:FindFirstChild(rname, true)
          effect = r and ("fires " .. r.ClassName .. " " .. r:GetFullName() .. " (server behaviour not simulated)") or nil
          if not r then unsimulated[#unsimulated + 1] = { step = i, click = b.Name, reason = "Total_Action '" .. act .. "' but no remote named " .. rname .. " exists in ReplicatedStorage" } end
        elseif act:sub(1, 6) == "print:" or act == "print" then effect = "prints to the output only (placeholder action)"
        elseif act:sub(1, 14) == "script_toggle:" then
          local mode, tname = act:match("^script_toggle:(%a+):(.*)$")
          local el = tname and tname ~= "" and (gui:FindFirstChild(tname:match("([^%.]+)$") or tname, true)) or nil
          if el and el:IsA("GuiObject") then
            if mode == "open" then state[el] = true elseif mode == "close" then state[el] = false elseif mode == "destroy" then state[el] = false else state[el] = not state[el] end
            effect = el.Name .. ".Visible=" .. tostring(state[el]) .. " (ui_state_toggle " .. mode .. ")"
          else unsimulated[#unsimulated + 1] = { step = i, click = b.Name, reason = "ui_state_toggle target '" .. tostring(tname) .. "' not found in " .. gui.Name } end
        end
        if effect then simulated[#simulated + 1] = { step = i, click = b.Name, action = act, effect = effect } end
      end
    end
  end
  local results, failedN = {}, 0
  for i, ex in ipairs(a.expect or {}) do
    local el = findIn(root, ex.path or ex.name)
    local row = { expect = i, path = tostring(ex.path or ex.name) }
    if not el then row.pass = false row.reason = "not found" failedN = failedN + 1
    else
      row.pass = true
      local checks = {}
      for k, want in pairs(ex) do
        if k ~= "path" and k ~= "name" then
          local got
          if k == "Visible" and el:IsA("GuiObject") then got = state[el] if got == nil then got = el.Visible end
          elseif k == "Enabled" and el:IsA("LayerCollector") then got = state[el] if got == nil then got = el.Enabled end
          else local okG, v = pcall(function() return el[k] end) got = okG and v or nil if typeof(got) == "Color3" then got = { r2(got.R), r2(got.G), r2(got.B) } elseif typeof(got) == "EnumItem" then got = got.Name end end
          local hit = (got == want) or (type(got) == "table" and same(got, want)) or (tostring(got) == tostring(want))
          checks[#checks + 1] = { prop = k, want = want, got = got, pass = hit }
          if not hit then row.pass = false end
        end
      end
      row.checks = checks
      if not row.pass then failedN = failedN + 1 end
    end
    results[#results + 1] = row
  end
  -- live plan: the exact calls for Play mode
  local plan = {}
  local pgPrefix = "game.Players.LocalPlayer.PlayerGui." .. gui.Name
  plan[#plan + 1] = { tool = "start_stop_play", arguments = { is_start = true }, note = "clicks only work while the game runs (datamodel Client)" }
  for _, step in ipairs(a.actions or {}) do
    local target = step.click or step.press or step.tap
    local b = target and findIn(root, target) or nil
    if b and isGuiButton(b) then plan[#plan + 1] = { tool = "user_mouse_input", arguments = { datamodel_type = "Client", actions = { { action = "mouseButtonClick", mouse_button = "left", instance_path = pgPrefix .. "." .. relName(b, gui) } } } } end
  end
  if #(a.expect or {}) > 0 then plan[#plan + 1] = { tool = "ui_test", arguments = { path = a.path, expect = a.expect, expect_only = true }, note = "re-evaluates the expectations against the live PlayerGui" } end
  plan[#plan + 1] = { tool = "get_console_output", arguments = {}, note = "Total_Controller warns about missing targets / remotes" }
  local verdict
  if a.expect_only then verdict = (failedN == 0 and "all expectations hold on the " .. (live and "LIVE" or "edit-mode") .. " state" or (failedN .. " expectation(s) fail on the " .. (live and "LIVE" or "edit-mode") .. " state"))
  else
    local parts = { #buttons .. " button(s): " .. #wired .. " wired, " .. #dead .. " DEAD" }
    if #small > 0 then parts[#parts + 1] = #small .. " too small for phones (<36 px)" end
    if #(a.actions or {}) > 0 then parts[#parts + 1] = #simulated .. " click(s) simulated, " .. #unsimulated .. " not simulable" end
    if #(a.expect or {}) > 0 then parts[#parts + 1] = (#results - failedN) .. "/" .. #results .. " expectations pass (simulated state)" end
    verdict = table.concat(parts, "; ")
  end
  local data = { gui = gui:GetFullName(), root = root:GetFullName(), live = live, buttons = #buttons, wired = wired, dead = dead, small_targets = small, simulated = simulated, not_simulated = unsimulated, expectations = results, failed_expectations = failedN, live_plan = plan, verified = a.expect_only and (live and "live_state" or "edit_state") or "static_and_simulated" }
  return okj(data, "ui_test " .. root:GetFullName() .. ": " .. verdict .. ". " .. (a.expect_only and "" or "Static + simulated only - to PROVE it, run the live_plan (user_mouse_input needs Play mode)."))
end

function VF.run(op, a)
  if op == "place_checkpoint" then return VF.checkpoint(a) end
  if op == "ui_test" then return VF.uiTest(a) end
  return failj("unknown verify op " .. tostring(op))
end
`.replace("__VERSION__", VERSION).replace("__STORE__", STORE).replace("__MAX_SAVE__", String(MAX_SAVE));

  const C = [
    { name: "place_checkpoint", description: "Scoped time machine for the place: save a copy of one subtree (model, folder, ScreenGui, script tree) or a service (Lighting / Workspace / SoundService: properties + children) into ServerStorage._TotalCheckpoints.<name>, restore it in one call (current copy destroyed, saved copy cloned back under the original parent, Terrain / Camera / player characters untouched), diff the saved tree against the current one (added / removed / changed instances with the fields that differ: class, Size, CFrame, Color, Material, Transparency, Visible, Text, Source), list or delete checkpoints. Call it BEFORE a risky generator or restyle and after a bad result. Not a replacement for Ctrl+Z, but it survives across turns and names what changed.",
      params: {
        op: { type: "string", req: true, desc: "save|restore|list|diff|delete" },
        path: { type: "string", req: false, desc: "dotted path of the subtree or service (save; optional for restore/diff when name is given, e.g. 'Workspace.Shop', 'StarterGui.ShopGui', 'Lighting')" },
        name: { type: "string", req: false, desc: "checkpoint name (default cp_<time>); '*' with delete removes all" },
        label: { type: "string", req: false, desc: "human label stored with the checkpoint" },
        replace: { type: "boolean", req: false, desc: "save over an existing name (default true)" },
        limit: { type: "number", req: false, desc: "diff: max rows per list (default 60)" },
      } },
    { name: "ui_test", description: "Prove that a GUI's buttons are wired instead of assuming it: lists every GuiButton under path as wired (Total_Action attribute + Total_Controller, ui_state_toggle / click LocalScript on the button, or a script in the GUI / StarterPlayerScripts that names it with Activated / MouseButton1Click) or DEAD; simulates actions [{click:'Shop'}] with the real Total_Controller semantics (close, toggle:X, open:X, remote:X, print) on a virtual visibility state and evaluates expect [{path:'Shop.Window', Visible:true}]; measures touch targets at 1280x720 and 844x390 (phones need >= 36 px); returns live_plan = the exact user_mouse_input + ui_test {expect_only:true} calls for Play mode, because a plugin cannot synthesize clicks. expect_only:true evaluates the expectations against the live PlayerGui while the game runs.",
      params: {
        path: { type: "string", req: true, desc: "ScreenGui or Frame to test (e.g. 'StarterGui.ShopGui')" },
        actions: { type: "array", req: false, desc: "[{click:'ButtonName'}] applied in order (names or dotted paths under path)" },
        expect: { type: "array", req: false, desc: "[{path:'Window', Visible:true}, {path:'Title', Text:'SHOP'}] evaluated after the actions" },
        expect_only: { type: "boolean", req: false, desc: "skip static analysis / simulation and evaluate expect against the current (live) state" },
      } },
  ];
  const NAMES = C.map((c) => c.name);

  function validate(op, a) {
    if (op === "place_checkpoint") {
      const o = String(a.op || "save").toLowerCase();
      if (!CP_OPS.includes(o)) return `op must be ${CP_OPS.join("|")}`;
      if (o === "save" && !a.path) return "save needs path (e.g. 'Workspace.Shop')";
      if ((o === "restore" || o === "diff") && !a.name && !a.path) return `${o} needs name or path`;
      if (a.name != null && !/^[\w .\-]{1,80}$|^\*$/.test(String(a.name))) return "name: letters, digits, space, _ - . (max 80)";
    }
    if (op === "ui_test") {
      if (!a.path) return "path is required (a ScreenGui or Frame)";
      if (a.actions != null && !Array.isArray(a.actions)) return "actions must be an array like [{click:'Shop'}]";
      if (Array.isArray(a.actions) && a.actions.some((s) => !s || typeof s !== "object" || !(s.click || s.press || s.tap))) return "each action needs click:'ButtonName'";
      if (a.expect != null && !Array.isArray(a.expect)) return "expect must be an array like [{path:'Window', Visible:true}]";
      if (Array.isArray(a.expect) && a.expect.some((e) => !e || typeof e !== "object" || !(e.path || e.name))) return "each expectation needs path (or name) plus the properties to check";
    }
    return null;
  }

  function build(op, args) {
    if (!NAMES.includes(op)) return null;
    const a = args || {};
    const pre = validate(op, a);
    if (pre) return { err: `ERROR ${op}: ${pre}` };
    let json;
    try { json = JSON.stringify(a); } catch (e) { return { err: `ERROR ${op}: arguments are not serialisable` }; }
    if (json.includes("]==]")) return { err: `ERROR ${op}: arguments contain ']==]'` };
    const body = `local __a = HttpService:JSONDecode([==[${json}]==])\nreturn VF.run(${JSON.stringify(op)}, __a)`;
    return { code: LIB + "\n" + body, lib: LIB, body };
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = build(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const names = new Set(NAMES);
  const arr = RobloxScriptSkills.SKILL_COMMANDS;
  for (let i = arr.length - 1; i >= 0; i--) if (names.has(arr[i].name)) arr.splice(i, 1);
  for (const c of C) arr.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.VERIFY_COMMANDS = NAMES.slice();
  RobloxScriptSkills.VERIFY_VERSION = VERSION;
  RobloxScriptSkills.VERIFY_LIB = LIB;
  RobloxScriptSkills.validateVerify = validate;
})();
