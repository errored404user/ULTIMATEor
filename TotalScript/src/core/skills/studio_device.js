// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript device pack (2.10.0) - mobile / tablet / console readiness.
//
//   device_audit {path?, devices?, limit?}
//       Lays every ScreenGui (or the one under path) out on a phone (844x390),
//       a tablet (1180x820), a console TV (1920x1080) and the PC baseline
//       (1280x720) with a real UDim2 / AnchorPoint / UIPadding / UIScale /
//       UISizeConstraint / UIAspectRatioConstraint / UIListLayout pass, then
//       reports deterministic findings: touch targets under 36 px, offset-only
//       sizes that swallow a phone screen, elements that leave the screen,
//       things under the Roblox topbar or on top of the default touch controls,
//       text that is too small / unbounded TextScaled / clipped, images that
//       stretch, ScreenGuis that opt out of safe insets, buttons a gamepad can
//       not reach, and LocalScripts whose actions are keyboard-only (KeyCode +
//       InputBegan without ContextActionService / touch / gamepad). Lines,
//       never a score. Every finding names the device, the instance and the
//       device_fix op (or the manual step) that clears it.
//
//   device_fix {path?, ops?, min_touch?, min_text?, max_text?, baseline?}
//       Applies the mechanical fixes in one undoable step: text_constraints
//       (UITextSizeConstraint under every TextScaled text), min_touch_size
//       (UISizeConstraint MinSize for buttons that measured small on the
//       phone), selectable (GuiButtons back to Selectable = true), safe_insets
//       (ScreenInsets None -> DeviceSafeInsets), scale_sizes (opt-in: convert
//       offset-only Size / Position to Scale relative to the baseline
//       resolution, with a UIAspectRatioConstraint for square-ish elements),
//       aspect_images (opt-in: UIAspectRatioConstraint on scale-sized images).
//       Scripts are never rewritten - keyboard-only input is reported with the
//       exact ContextActionService change for script_set_source / multi_edit.
//
// Plain Lua syntax only (no +=, continue, ::) so tests/luau-parse-check.py and
// the mocked DataModel in tests/device-sim.py can run it.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;
  const VERSION = "2.10.0";
  const DEVICES = ["phone", "tablet", "console", "pc"];
  const FIX_OPS = ["text_constraints", "min_touch_size", "selectable", "safe_insets", "scale_sizes", "aspect_images"];
  const DEFAULT_OPS = ["text_constraints", "min_touch_size", "selectable", "safe_insets"];

  const LIB = String.raw`
local HttpService = game:GetService("HttpService")
local StarterGui = game:GetService("StarterGui")
local StarterPlayer = game:GetService("StarterPlayer")
local Players = game:GetService("Players")
local DV = {}
DV.VERSION = "__VERSION__"
local TOPBAR = 58
local TOUCH_MIN = 36
local TOUCH_ZONE = 220
local DEVICES = {
  { id = "phone", w = 844, h = 390, touch = true, gamepad = false, label = "phone 844x390 (iPhone-class landscape)" },
  { id = "tablet", w = 1180, h = 820, touch = true, gamepad = false, label = "tablet 1180x820" },
  { id = "console", w = 1920, h = 1080, touch = false, gamepad = true, label = "console 1920x1080 (TV, gamepad)" },
  { id = "pc", w = 1280, h = 720, touch = false, gamepad = false, label = "PC 1280x720 baseline" },
}
local function okj(d, t) return HttpService:JSONEncode({ ok = true, data = d or {}, text = t or "" }) end
local function failj(m) return HttpService:JSONEncode({ ok = false, error = tostring(m) }) end
local function r1(v) return math.floor(v * 10 + 0.5) / 10 end
local function px(v) return math.floor((tonumber(v) or 0) + 0.5) end
local function resolve(path)
  if path == nil or path == "" then return nil end
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
local function waypoint(label) pcall(function() local chs = game:GetService("ChangeHistoryService") if chs and chs.SetWaypoint then chs:SetWaypoint(label) end end) end
local function isVisible(inst)
  local node = inst
  while node and not node:IsA("LayerCollector") do
    if node:IsA("GuiObject") and node.Visible == false then return false end
    node = node.Parent
  end
  if node and node:IsA("LayerCollector") and node.Enabled == false then return false end
  return true
end
local function childOfClass(inst, cls)
  for _, c in ipairs(inst:GetChildren()) do if c:IsA(cls) then return c end end
  return nil
end
local function udimPx(u, ref) return (u.Scale or 0) * ref + (u.Offset or 0) end
-- ------------------------- layout -------------------------
-- rect = { x, y, w, h } in screen pixels. Parent content rect already has the
-- parent's UIPadding removed.
local function contentRect(inst, r)
  local pad = childOfClass(inst, "UIPadding")
  if not pad then return r end
  local l, rt = udimPx(pad.PaddingLeft, r.w), udimPx(pad.PaddingRight, r.w)
  local t, b = udimPx(pad.PaddingTop, r.h), udimPx(pad.PaddingBottom, r.h)
  return { x = r.x + l, y = r.y + t, w = math.max(0, r.w - l - rt), h = math.max(0, r.h - t - b) }
end
local function rectOf(inst, pr)
  local sz, pos, ap = inst.Size, inst.Position, inst.AnchorPoint
  local w = sz.X.Scale * pr.w + sz.X.Offset
  local h = sz.Y.Scale * pr.h + sz.Y.Offset
  local sc = childOfClass(inst, "UIScale")
  if sc then w = w * (sc.Scale or 1) h = h * (sc.Scale or 1) end
  local szc = childOfClass(inst, "UISizeConstraint")
  if szc then
    local mn, mx = szc.MinSize, szc.MaxSize
    if mn then w = math.max(w, mn.X) h = math.max(h, mn.Y) end
    if mx then w = math.min(w, mx.X) h = math.min(h, mx.Y) end
  end
  local ar = childOfClass(inst, "UIAspectRatioConstraint")
  if ar and (ar.AspectRatio or 0) > 0 then
    local ratio = ar.AspectRatio
    local axis = ar.DominantAxis and ar.DominantAxis.Name or "Width"
    if axis == "Height" then w = h * ratio else h = w / ratio end
  end
  local x = pr.x + pos.X.Scale * pr.w + pos.X.Offset - ap.X * w
  local y = pr.y + pos.Y.Scale * pr.h + pos.Y.Offset - ap.Y * h
  return { x = x, y = y, w = w, h = h }
end
-- walk a LayerCollector / GuiObject tree at one device size; visit(inst, rect, rootRect, gui)
local function walk(gui, dev, visit)
  local screen = { x = 0, y = 0, w = dev.w, h = dev.h }
  local root = { x = 0, y = TOPBAR, w = dev.w, h = dev.h - TOPBAR }
  local ignore = gui:IsA("ScreenGui") and gui.IgnoreGuiInset == true
  if ignore then root = { x = 0, y = 0, w = dev.w, h = dev.h } end
  local function rec(parent, pr)
    local content = contentRect(parent, pr)
    local list = childOfClass(parent, "UIListLayout")
    local cursor = 0
    local padPx = 0
    if list then
      local horizontal = list.FillDirection and list.FillDirection.Name == "Horizontal"
      padPx = udimPx(list.Padding, horizontal and content.w or content.h)
      list = horizontal and "h" or "v"
    end
    for _, c in ipairs(parent:GetChildren()) do
      if c:IsA("GuiObject") then
        local r = rectOf(c, content)
        if list == "v" then r.y = content.y + cursor cursor = cursor + r.h + padPx
        elseif list == "h" then r.x = content.x + cursor cursor = cursor + r.w + padPx end
        visit(c, r, screen, root, gui)
        rec(c, r)
      end
    end
  end
  rec(gui, root)
  return screen, root
end
local function approxTextWidth(text, size)
  local n = 0
  for _ in tostring(text or ""):gmatch("[^\128-\191]") do n = n + 1 end
  return n * size * 0.52
end
local function full(inst) local okN, s = pcall(function() return inst:GetFullName() end) return okN and s or "?" end
-- ------------------------- rules -------------------------
local function auditGui(gui, out, seen, limitPer)
  local function add(rule, sev, inst, dev, detail, fix)
    local key = rule .. "|" .. full(inst) .. "|" .. (dev or "-")
    if seen[key] then return end
    seen[key] = true
    out.counts[rule] = (out.counts[rule] or 0) + 1
    if #out.findings < limitPer then
      out.findings[#out.findings + 1] = { rule = rule, severity = sev, path = full(inst), class = inst.ClassName, device = dev, detail = detail, fix = fix }
    else out.truncated = out.truncated + 1 end
  end
  -- ScreenGui-level
  if gui:IsA("ScreenGui") then
    local okI, insets = pcall(function() return gui.ScreenInsets end)
    if okI and insets and insets.Name == "None" then add("safe_insets", "warn", gui, "console", "ScreenInsets = None: nothing keeps this GUI out of the TV overscan / notch areas", "device_fix op safe_insets (ScreenInsets = DeviceSafeInsets)") end
  end
  local buttons, selectable = 0, 0
  for _, dev in ipairs(DEVICES) do
    walk(gui, dev, function(inst, r, screen, root, g)
      if not isVisible(inst) then return end
      local isBtn = inst:IsA("GuiButton")
      local isText = inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox")
      local isImg = inst:IsA("ImageLabel") or inst:IsA("ImageButton")
      local minSide = math.min(r.w, r.h)
      if dev.id == "pc" then
        if isBtn then buttons = buttons + 1 if inst.Selectable ~= false then selectable = selectable + 1 end end
        if isBtn and inst.Selectable == false then add("gamepad_unreachable", "error", inst, "console", "Selectable = false: a controller can never focus this button", "device_fix op selectable") end
        local sz = inst.Size
        if sz.X.Scale == 0 and sz.Y.Scale == 0 and (sz.X.Offset >= 300 or sz.Y.Offset >= 200) then
          add("offset_only_size", "warn", inst, "phone", string.format("Size is offset-only %dx%d px: that is %d%% of a phone's width / %d%% of its height", px(sz.X.Offset), px(sz.Y.Offset), px(sz.X.Offset / 844 * 100), px(sz.Y.Offset / 390 * 100)), "device_fix op scale_sizes (opt-in) or author sizes in Scale with UISizeConstraint")
        end
        if isText then
          local scaled = inst.TextScaled == true
          if scaled and not childOfClass(inst, "UITextSizeConstraint") then add("text_unbounded", "warn", inst, "phone", "TextScaled without UITextSizeConstraint: shrinks below legibility on phones and balloons on TVs", "device_fix op text_constraints") end
          if not scaled and (inst.TextSize or 14) < 14 then add("text_small", "warn", inst, "phone", "TextSize " .. tostring(inst.TextSize) .. " px is below the 14 px phone minimum", "set TextSize >= 14 or TextScaled + UITextSizeConstraint") end
          if not scaled and (inst.TextSize or 14) < 18 and inst.TextWrapped ~= true then add("text_tv", "info", inst, "console", "TextSize " .. tostring(inst.TextSize) .. " px reads small from a couch (ten-foot UI wants >= 18 px at 1080p)", "TextScaled + UITextSizeConstraint {MinTextSize 14, MaxTextSize 48}") end
          if not scaled and inst.TextWrapped ~= true and (inst.Text or "") ~= "" then
            local need = approxTextWidth(inst.Text, inst.TextSize or 14)
            if need > r.w + 4 then add("text_clipped", "warn", inst, "pc", string.format("'%s' needs ~%d px but the box is %d px wide", tostring(inst.Text):sub(1, 24), px(need), px(r.w)), "TextScaled / TextWrapped, a wider box or AutomaticSize") end
          end
        end
        if isImg and inst.Size.X.Scale > 0 and inst.Size.Y.Scale > 0 and not childOfClass(inst, "UIAspectRatioConstraint") then
          local ratio = r.h > 0 and r.w / r.h or 1
          local st = inst.ScaleType and inst.ScaleType.Name or "Stretch"
          if ratio > 0.5 and ratio < 2 and st == "Stretch" then add("image_stretch", "warn", inst, "phone", "scale-sized image without UIAspectRatioConstraint: it is a different shape on every aspect ratio", "device_fix op aspect_images (opt-in) or ScaleType Fit") end
        end
        if inst:IsA("ScrollingFrame") and (inst.ScrollBarThickness or 12) < 8 then add("scrollbar_thin", "info", inst, "phone", "ScrollBarThickness " .. tostring(inst.ScrollBarThickness) .. " px is hard to grab with a finger", "ScrollBarThickness >= 8 (touch scrolls the content anyway)") end
      end
      if dev.touch then
        if (isBtn or inst:IsA("TextBox")) and minSide < TOUCH_MIN and not (dev.id == "tablet" and seen["touch_target|" .. full(inst) .. "|phone"]) then
          add("touch_target", minSide < 28 and "error" or "warn", inst, dev.id, string.format("%dx%d px on %s (needs >= %d px per side)", px(r.w), px(r.h), dev.id, TOUCH_MIN), "device_fix op min_touch_size (UISizeConstraint MinSize) or a bigger Scale size")
        end
        if dev.id == "phone" and (isBtn or inst:IsA("TextBox")) then
          local bottom = r.y + r.h > screen.h - TOUCH_ZONE
          local left = r.x < TOUCH_ZONE
          local right = r.x + r.w > screen.w - TOUCH_ZONE
          if bottom and (left or right) then add("touch_controls_overlap", "warn", inst, "phone", "sits in the " .. (left and "bottom-left thumbstick" or "bottom-right jump button") .. " zone of the default touch controls", "move it up / inward, or disable the default controls (StarterPlayer.DevTouchMovementMode) on purpose") end
        end
      end
      if dev.id == "phone" or dev.id == "console" then
        local over = (r.x < -2) or (r.y < -2) or (r.x + r.w > screen.w + 2) or (r.y + r.h > screen.h + 2)
        if over and r.w > 0 and r.h > 0 then add("offscreen", "error", inst, dev.id, string.format("rect %d,%d %dx%d leaves the %dx%d screen", px(r.x), px(r.y), px(r.w), px(r.h), screen.w, screen.h), "Scale positions / AnchorPoint instead of pixel offsets; device_fix op scale_sizes (opt-in)") end
      end
      if dev.id == "phone" and g:IsA("ScreenGui") and g.IgnoreGuiInset == true and r.y < TOPBAR and r.y + r.h > 0 and (isBtn or isText) then
        add("topbar_overlap", "warn", inst, "phone", "IgnoreGuiInset GUI: this element sits under the Roblox topbar (chat / leaderboard / menu buttons)", "IgnoreGuiInset = false for the HUD, or keep the top 58 px empty")
      end
    end)
  end
  return buttons, selectable
end
local function scriptsUnder(root, out)
  for _, d in ipairs(root:GetDescendants()) do if d:IsA("LocalScript") or d:IsA("ModuleScript") then out[#out + 1] = d end end
end
local function auditScripts(guis, out, seen, limitPer)
  local scripts = {}
  for _, g in ipairs(guis) do scriptsUnder(g, scripts) end
  local sps = StarterPlayer:FindFirstChild("StarterPlayerScripts")
  if sps then scriptsUnder(sps, scripts) end
  local scs = StarterPlayer:FindFirstChild("StarterCharacterScripts")
  if scs then scriptsUnder(scs, scripts) end
  local setsSelection = false
  local keyboardOnly = {}
  for _, s in ipairs(scripts) do
    local okS, src = pcall(function() return s.Source end)
    src = okS and src or ""
    if src:find("SelectedObject") or src:find("SelectionGroup") or src:find("GuiNavigationEnabled") then setsSelection = true end
    local usesKey = src:find("Enum%.KeyCode%.") and (src:find("InputBegan") or src:find("InputEnded") or src:find("IsKeyDown"))
    local hasFallback = src:find("ContextActionService") or src:find("BindAction") or src:find("UserInputType%.Touch") or src:find("TouchTap") or src:find("TouchStarted") or src:find("Gamepad") or src:find("TouchEnabled")
    if usesKey and not hasFallback then
      local keys, keySeen = {}, {}
      for k in src:gmatch("Enum%.KeyCode%.(%w+)") do if not keySeen[k] then keySeen[k] = true keys[#keys + 1] = k end end
      table.sort(keys)
      keyboardOnly[#keyboardOnly + 1] = { path = full(s), keys = keys }
      local key = "keyboard_only|" .. full(s)
      if not seen[key] then
        seen[key] = true
        out.counts.keyboard_only = (out.counts.keyboard_only or 0) + 1
        if #out.findings < limitPer then
          out.findings[#out.findings + 1] = { rule = "keyboard_only", severity = "error", path = full(s), class = s.ClassName, device = "phone", detail = "binds " .. table.concat(keys, ", ") .. " through InputBegan with no touch / gamepad path: phones and consoles can never trigger it", fix = "ContextActionService:BindAction(name, handler, true, Enum.KeyCode." .. tostring(keys[1] or "E") .. ", Enum.KeyCode.ButtonX) - the 'true' creates the touch button; keep the handler, drop the InputBegan branch (script_set_source / multi_edit)" }
        else out.truncated = out.truncated + 1 end
      end
    end
    if src:find(":GetMouse%(%)") and not (src:find("UserInputService") or src:find("ContextActionService")) then
      local key = "mouse_api|" .. full(s)
      if not seen[key] then
        seen[key] = true
        out.counts.mouse_api = (out.counts.mouse_api or 0) + 1
        if #out.findings < limitPer then out.findings[#out.findings + 1] = { rule = "mouse_api", severity = "info", path = full(s), class = s.ClassName, device = "phone", detail = "Player:GetMouse() only: works for taps but there is no hover and no gamepad cursor", fix = "UserInputService.InputBegan / GetMouseLocation, or UserInputService.GamepadEnabled checks" } end
      end
    end
  end
  return setsSelection, keyboardOnly, #scripts
end
function DV.audit(a)
  local limitPer = tonumber(a.limit) or 80
  local guis = {}
  if a.path and a.path ~= "" then
    local inst = resolve(a.path)
    if not (inst:IsA("LayerCollector") or inst:IsA("GuiObject")) then error("path must be a ScreenGui or GuiObject, got " .. inst.ClassName) end
    guis[1] = inst
  else
    for _, c in ipairs(StarterGui:GetChildren()) do if c:IsA("ScreenGui") then guis[#guis + 1] = c end end
  end
  local out = { findings = {}, counts = {}, truncated = 0 }
  local seen = {}
  local totalButtons, totalSelectable = 0, 0
  for _, g in ipairs(guis) do
    local b, s = auditGui(g, out, seen, limitPer)
    totalButtons = totalButtons + b
    totalSelectable = totalSelectable + s
  end
  local setsSelection, keyboardOnly, nScripts = auditScripts(guis, out, seen, limitPer)
  if totalButtons > 0 and not setsSelection then
    out.counts.gamepad_entry = 1
    out.findings[#out.findings + 1] = { rule = "gamepad_entry", severity = "info", path = guis[1] and full(guis[1]) or "StarterGui", class = "ScreenGui", device = "console", detail = totalButtons .. " button(s) but no script ever sets GuiService.SelectedObject: controller users must press the select button and hunt for focus", fix = "when a menu opens: GuiService.SelectedObject = firstButton; group buttons with SelectionGroup / NextSelectionDown" }
  end
  -- place-level facts (information, not findings)
  local okO, orient = pcall(function() return StarterGui.ScreenOrientation.Name end)
  local okT, touchMode = pcall(function() return StarterPlayer.DevTouchMovementMode.Name end)
  local okC, camMode = pcall(function() return StarterPlayer.DevTouchCameraMovementMode.Name end)
  local bySev = { error = 0, warn = 0, info = 0 }
  local byDevice = {}
  for _, f in ipairs(out.findings) do
    bySev[f.severity] = (bySev[f.severity] or 0) + 1
    byDevice[f.device] = byDevice[f.device] or { error = 0, warn = 0, info = 0 }
    byDevice[f.device][f.severity] = byDevice[f.device][f.severity] + 1
  end
  local fixOps, fixSeen = {}, {}
  for _, f in ipairs(out.findings) do
    local op = tostring(f.fix or ""):match("device_fix op ([%w_]+)")
    if op and not fixSeen[op] then fixSeen[op] = true fixOps[#fixOps + 1] = op end
  end
  local names = {}
  for _, g in ipairs(guis) do names[#names + 1] = g.Name end
  local parts = {}
  for _, id in ipairs({ "phone", "tablet", "console", "pc" }) do
    local d = byDevice[id]
    if d then parts[#parts + 1] = id .. ": " .. d.error .. " blocker(s), " .. d.warn .. " warning(s), " .. d.info .. " note(s)" end
  end
  local verdict
  if #out.findings == 0 then verdict = "no device findings in " .. #guis .. " GUI(s) / " .. nScripts .. " script(s) - layout, text, touch targets, gamepad reach and input bindings all pass the deterministic checks"
  else verdict = table.concat(parts, "; ") end
  local data = {
    guis = names, scripts_checked = nScripts, buttons = totalButtons, selectable_buttons = totalSelectable,
    devices = { phone = "844x390 touch", tablet = "1180x820 touch", console = "1920x1080 gamepad", pc = "1280x720" },
    findings = out.findings, counts = out.counts, truncated = out.truncated, by_severity = bySev, by_device = byDevice,
    keyboard_only_scripts = keyboardOnly, fix_ops = fixOps,
    place = { screen_orientation = okO and orient or "?", touch_movement = okT and touchMode or "?", touch_camera = okC and camMode or "?" },
    verified = "static_layout_simulation",
  }
  local nextStep = ""
  if #fixOps > 0 then nextStep = " Next: device_fix {ops:[\"" .. table.concat(fixOps, "\",\"") .. "\"]} clears the mechanical ones in one undoable step" .. (#keyboardOnly > 0 and ("; " .. #keyboardOnly .. " script(s) need the ContextActionService change by hand") or "") .. "."
  elseif #keyboardOnly > 0 then nextStep = " Next: " .. #keyboardOnly .. " script(s) need the ContextActionService change (see keyboard_only_scripts)." end
  return okj(data, "device_audit (" .. #guis .. " GUI(s), " .. nScripts .. " script(s)): " .. verdict .. "." .. nextStep .. " Simulated layout - confirm on the Studio device emulator (Test tab) for the final word.")
end
-- ------------------------- fix -------------------------
function DV.fix(a)
  local ops = {}
  for _, o in ipairs(a.ops or { "text_constraints", "min_touch_size", "selectable", "safe_insets" }) do ops[tostring(o)] = true end
  local minTouch = tonumber(a.min_touch) or TOUCH_MIN
  local minText = tonumber(a.min_text) or 12
  local maxText = tonumber(a.max_text) or 48
  local bw = tonumber(a.baseline and a.baseline[1]) or 1280
  local bh = tonumber(a.baseline and a.baseline[2]) or 720
  local guis = {}
  if a.path and a.path ~= "" then
    local inst = resolve(a.path)
    if not (inst:IsA("LayerCollector") or inst:IsA("GuiObject")) then error("path must be a ScreenGui or GuiObject, got " .. inst.ClassName) end
    guis[1] = inst
  else
    for _, c in ipairs(StarterGui:GetChildren()) do if c:IsA("ScreenGui") then guis[#guis + 1] = c end end
  end
  local changes, counts = {}, {}
  local function note(op, inst, what)
    counts[op] = (counts[op] or 0) + 1
    if #changes < 60 then changes[#changes + 1] = { op = op, path = full(inst), change = what } end
  end
  local phone = DEVICES[1]
  for _, g in ipairs(guis) do
    if ops.safe_insets and g:IsA("ScreenGui") then
      local okI, insets = pcall(function() return g.ScreenInsets end)
      if okI and insets and insets.Name == "None" then g.ScreenInsets = Enum.ScreenInsets.DeviceSafeInsets note("safe_insets", g, "ScreenInsets None -> DeviceSafeInsets") end
    end
    local small = {}
    if ops.min_touch_size then
      walk(g, phone, function(inst, r)
        if (inst:IsA("GuiButton") or inst:IsA("TextBox")) and isVisible(inst) and math.min(r.w, r.h) < minTouch then small[inst] = r end
      end)
    end
    for _, inst in ipairs(g:GetDescendants()) do
      if inst:IsA("GuiObject") then
        if ops.text_constraints and (inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox")) and inst.TextScaled == true and not childOfClass(inst, "UITextSizeConstraint") then
          local c = Instance.new("UITextSizeConstraint")
          c.MinTextSize = minText
          c.MaxTextSize = maxText
          c.Parent = inst
          note("text_constraints", inst, "UITextSizeConstraint " .. minText .. ".." .. maxText)
        end
        if ops.selectable and inst:IsA("GuiButton") and inst.Selectable == false then inst.Selectable = true note("selectable", inst, "Selectable = true") end
        if small[inst] then
          local c = childOfClass(inst, "UISizeConstraint")
          if not c then c = Instance.new("UISizeConstraint") c.Parent = inst end
          local mn = c.MinSize or Vector2.new(0, 0)
          c.MinSize = Vector2.new(math.max(mn.X, minTouch), math.max(mn.Y, minTouch))
          note("min_touch_size", inst, string.format("UISizeConstraint MinSize %d,%d (was %dx%d px on the phone)", px(minTouch), px(minTouch), px(small[inst].w), px(small[inst].h)))
        end
        if ops.scale_sizes then
          local sz, pos = inst.Size, inst.Position
          local parentW, parentH = bw, bh
          local p = inst.Parent
          if p and p:IsA("GuiObject") then
            -- after the parent was converted (descendants come in tree order) its scale is relative to ITS parent; use the baseline-pixel size
            local pr = rectOf(p, { x = 0, y = 0, w = bw, h = bh - TOPBAR })
            parentW, parentH = math.max(1, pr.w), math.max(1, pr.h)
          else parentH = bh - TOPBAR end
          if sz.X.Scale == 0 and sz.Y.Scale == 0 and (sz.X.Offset > 0 or sz.Y.Offset > 0) then
            local ratio = sz.Y.Offset > 0 and sz.X.Offset / sz.Y.Offset or 1
            inst.Size = UDim2.new(r1(sz.X.Offset / parentW * 1000) / 1000, 0, r1(sz.Y.Offset / parentH * 1000) / 1000, 0)
            if ratio > 0.5 and ratio < 2 and not childOfClass(inst, "UIAspectRatioConstraint") then
              local ar = Instance.new("UIAspectRatioConstraint") ar.AspectRatio = r1(ratio * 100) / 100 ar.Parent = inst
            end
            note("scale_sizes", inst, string.format("Size %dx%d px -> Scale %.3f,%.3f", px(sz.X.Offset), px(sz.Y.Offset), sz.X.Offset / parentW, sz.Y.Offset / parentH))
          end
          if pos.X.Offset ~= 0 or pos.Y.Offset ~= 0 then
            -- pixel offsets become scale too (also the "Scale 1, Offset -90" corner idiom, which breaks once the size is scale)
            local nx = r1((pos.X.Scale + pos.X.Offset / parentW) * 1000) / 1000
            local ny = r1((pos.Y.Scale + pos.Y.Offset / parentH) * 1000) / 1000
            inst.Position = UDim2.new(nx, 0, ny, 0)
            note("scale_sizes", inst, string.format("Position {%.2f, %d},{%.2f, %d} -> Scale %.3f,%.3f", pos.X.Scale, px(pos.X.Offset), pos.Y.Scale, px(pos.Y.Offset), nx, ny))
          end
        end
        if ops.aspect_images and (inst:IsA("ImageLabel") or inst:IsA("ImageButton")) and inst.Size.X.Scale > 0 and inst.Size.Y.Scale > 0 and not childOfClass(inst, "UIAspectRatioConstraint") then
          local r = rectOf(inst, { x = 0, y = 0, w = bw, h = bh - TOPBAR })
          local ratio = r.h > 0 and r.w / r.h or 1
          if ratio > 0.5 and ratio < 2 then
            local ar = Instance.new("UIAspectRatioConstraint") ar.AspectRatio = r1(ratio * 100) / 100 ar.Parent = inst
            note("aspect_images", inst, string.format("UIAspectRatioConstraint %.2f", ratio))
          end
        end
      end
    end
  end
  local total = 0
  for _, n in pairs(counts) do total = total + n end
  if total > 0 then waypoint("TotalScript device_fix") end
  local names = {}
  for _, g in ipairs(guis) do names[#names + 1] = g.Name end
  local parts = {}
  for _, op in ipairs({ "text_constraints", "min_touch_size", "selectable", "safe_insets", "scale_sizes", "aspect_images" }) do if counts[op] then parts[#parts + 1] = counts[op] .. " " .. op end end
  return okj({ guis = names, applied = total, counts = counts, changes = changes, truncated_changes = math.max(0, total - #changes), undo = total > 0 and "one Ctrl+Z (ChangeHistory waypoint 'TotalScript device_fix')" or "nothing changed" },
    "device_fix: " .. (total > 0 and (total .. " change(s): " .. table.concat(parts, ", ")) or "nothing to change for the requested ops") .. ". Next: device_audit again; keyboard-only scripts still need the ContextActionService edit.")
end
function DV.run(op, a)
  if op == "device_audit" then return DV.audit(a) end
  if op == "device_fix" then return DV.fix(a) end
  return failj("unknown device op " .. tostring(op))
end
`.replace("__VERSION__", VERSION);

  const C = [
    { name: "device_audit", description: "Mobile / tablet / console readiness of the GUIs and input scripts: lays out every ScreenGui (or path) on a phone 844x390, tablet 1180x820, console 1920x1080 and the 1280x720 PC baseline (UDim2, AnchorPoint, UIPadding, UIScale, UISizeConstraint, UIAspectRatioConstraint, UIListLayout honoured) and reports concrete findings - touch targets under 36 px, offset-only sizes that swallow a phone, elements leaving the screen, under the topbar or on the default touch controls, text too small / TextScaled without UITextSizeConstraint / clipped, images that stretch, ScreenInsets None, buttons with Selectable false, no GuiService.SelectedObject entry for controllers, LocalScripts whose actions are keyboard-only (Enum.KeyCode + InputBegan without ContextActionService / touch / gamepad). Each finding names the device and the device_fix op or the manual step. Lines, not a score; simulated layout - the Studio device emulator is the final word.",
      params: {
        path: { type: "string", req: false, desc: "one ScreenGui or GuiObject (e.g. 'StarterGui.ShopGui'); omit for every ScreenGui under StarterGui" },
        limit: { type: "number", req: false, desc: "max findings returned (default 80; counts stay complete)" },
      } },
    { name: "device_fix", description: "Apply the mechanical device fixes from device_audit in one undoable step: text_constraints (UITextSizeConstraint min_text..max_text under every TextScaled text), min_touch_size (UISizeConstraint MinSize for buttons / TextBoxes that measure under min_touch px on the phone), selectable (GuiButtons back to Selectable = true), safe_insets (ScreenInsets None -> DeviceSafeInsets); opt-in: scale_sizes (offset-only Size / Position -> Scale relative to baseline [1280,720], UIAspectRatioConstraint for square-ish elements), aspect_images (UIAspectRatioConstraint on scale-sized images). Scripts are never rewritten - keyboard-only input needs the ContextActionService change via script_set_source / multi_edit.",
      params: {
        path: { type: "string", req: false, desc: "one ScreenGui or GuiObject; omit for every ScreenGui under StarterGui" },
        ops: { type: "array", req: false, desc: "subset of text_constraints | min_touch_size | selectable | safe_insets | scale_sizes | aspect_images (default: the first four)" },
        min_touch: { type: "number", req: false, desc: "minimum touch target in px (default 36)" },
        min_text: { type: "number", req: false, desc: "UITextSizeConstraint.MinTextSize (default 12)" },
        max_text: { type: "number", req: false, desc: "UITextSizeConstraint.MaxTextSize (default 48)" },
        baseline: { type: "array", req: false, desc: "[width, height] the offsets were authored for (default [1280, 720]) - scale_sizes only" },
      } },
  ];
  const NAMES = C.map((c) => c.name);

  function validate(op, a) {
    if (op === "device_audit") {
      if (a.limit != null && !(Number(a.limit) >= 1 && Number(a.limit) <= 500)) return "limit must be 1..500";
    }
    if (op === "device_fix") {
      if (a.ops != null) {
        if (!Array.isArray(a.ops) || a.ops.length === 0) return `ops must be a non-empty array of ${FIX_OPS.join(" | ")}`;
        const bad = a.ops.filter((o) => !FIX_OPS.includes(String(o)));
        if (bad.length) return `unknown op(s) ${bad.join(", ")} - use ${FIX_OPS.join(" | ")}`;
      }
      if (a.min_touch != null && !(Number(a.min_touch) >= 24 && Number(a.min_touch) <= 96)) return "min_touch must be 24..96 px";
      if (a.min_text != null && !(Number(a.min_text) >= 8 && Number(a.min_text) <= 40)) return "min_text must be 8..40";
      if (a.max_text != null && !(Number(a.max_text) >= 12 && Number(a.max_text) <= 200)) return "max_text must be 12..200";
      if (a.min_text != null && a.max_text != null && Number(a.min_text) > Number(a.max_text)) return "min_text must not exceed max_text";
      if (a.baseline != null && !(Array.isArray(a.baseline) && a.baseline.length === 2 && a.baseline.every((n) => Number(n) >= 320 && Number(n) <= 7680))) return "baseline must be [width, height] in px";
    }
    if (a.path != null && typeof a.path !== "string") return "path must be a dotted string path";
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
    const body = `local __a = HttpService:JSONDecode([==[${json}]==])\nreturn DV.run(${JSON.stringify(op)}, __a)`;
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
  RobloxScriptSkills.DEVICE_COMMANDS = NAMES.slice();
  RobloxScriptSkills.DEVICE_VERSION = VERSION;
  RobloxScriptSkills.DEVICE_LIB = LIB;
  RobloxScriptSkills.DEVICE_FIX_OPS = FIX_OPS.slice();
  RobloxScriptSkills.DEVICE_DEFAULT_OPS = DEFAULT_OPS.slice();
  RobloxScriptSkills.DEVICE_DEVICES = DEVICES.slice();
  RobloxScriptSkills.validateDevice = validate;
})();
