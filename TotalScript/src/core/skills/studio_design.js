// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript DESIGN pack (1.29.0) - real, shippable Roblox UI instead of pictures
// of UI. Layered on RobloxScriptSkills exactly like studio_modes.js.
//
//   design_tokens_set / design_tokens_get   one style sheet for the whole game
//   design_kit_install                      ReplicatedStorage.Total_Design.{Tokens,UIKit,Responsive}
//   ui_from_spec                            declarative tree (px on a 1280x720 canvas) -> ScreenGui
//   ui_screen_generate                      11 complete screens (shop, inventory, hud, main_menu, ...)
//   ui_component_place                      drop one kit component into an existing GUI
//   ui_apply_tokens                         restyle any existing GUI tree to the tokens
//   ui_make_responsive                      scale sizes, aspect/size/text constraints, safe insets
//   ui_gamepad_focus                        NextSelection chain + selection cursor for controllers
//   ui_states_wire                          hover / press / sounds / actions on any existing UI
//   ui_audit                                contrast, touch targets, overlaps, palette drift, ...
//   ui_export_spec                          GUI tree -> spec JSON (tweak and rebuild)
//   ui_preview                              show a screen (phone/tablet/desktop scale) for total_screenshot
//
// Everything generated is plain instances + ModuleScripts/LocalScripts the user
// can edit. Runtime behaviour (hover, press, open/close tweens, actions,
// progress bars, toggles, tabs, toasts) lives in ONE generic LocalScript
// (Total_Controller) that talks to the kit - no per-button spaghetti.
//
// Convention: JS source uses double-quoted strings; Luau string literals use
// single quotes except values produced by q()/jj(). Never put a raw newline
// inside a Luau string - tests/test-luau-syntax.js enforces it. Luau module
// sources below are template literals passed through q(), so they may contain
// anything but "${".
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const KIT_VERSION = "1.29.0";
  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  const nn = (v, d = 0) => { const x = Number(v); return isFinite(x) ? String(x) : String(d); };
  const bb = (v, d = false) => (v === undefined || v === null || v === "" ? (d ? "true" : "false") : (v === true || v === "true" || v === 1 || v === "1" || v === "yes") ? "true" : "false");
  const jj = (v) => { try { return q(JSON.stringify(v === undefined ? null : v)); } catch { return q("null"); } };
  const ident = (v, d) => { const s = String(v || d || "Screen").replace(/[^A-Za-z0-9_]/g, ""); return /^[A-Za-z_]/.test(s) ? s : "_" + s; };
  const NAMED = { red: [235, 70, 70], green: [60, 200, 120], blue: [70, 130, 255], gold: [255, 196, 60], yellow: [255, 226, 80], purple: [160, 90, 255], cyan: [60, 220, 255], pink: [255, 110, 190], orange: [255, 140, 50], white: [250, 250, 252], black: [14, 14, 18], grey: [120, 124, 140], gray: [120, 124, 140] };
  const parseColor = (v, d) => {
    if (Array.isArray(v) && v.length >= 3 && v.every((x) => isFinite(Number(x)))) return v.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(Number(x)))));
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (NAMED[s]) return NAMED[s];
      if (/^#?[0-9a-f]{6}$/.test(s)) { const h = s.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
      if (/^#?[0-9a-f]{3}$/.test(s)) { const h = s.replace("#", ""); return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]; }
      const parts = s.replace(/^rgba?\s*\(/, "").replace(/\)\s*$/, "").split(/[\s,]+/).filter(Boolean).map(Number);
      if (parts.length >= 3 && parts.every(isFinite)) return parts.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(x))));
    }
    return d || null;
  };
  const hex = (c) => "#" + c.map((x) => ("0" + Math.max(0, Math.min(255, Math.round(x))).toString(16)).slice(-2)).join("");
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));

  // ───────────────────────── TOKEN PRESETS ─────────────────────────
  // Every preset is a complete style sheet. Overrides are merged on top.
  const PRESETS = {
    midnight: { primary: [88, 120, 255], secondary: [255, 186, 72], surface: [20, 22, 32], surface_alt: [30, 33, 46], text: [240, 242, 250], text_muted: [150, 156, 178], success: [70, 210, 130], danger: [240, 80, 90], warning: [255, 180, 60], stroke: [255, 255, 255], font: "GothamMedium", font_bold: "GothamBold", radius: 12 },
    clean_light: { primary: [40, 100, 255], secondary: [255, 140, 40], surface: [250, 250, 253], surface_alt: [236, 238, 245], text: [24, 26, 36], text_muted: [96, 102, 124], success: [36, 170, 100], danger: [220, 60, 70], warning: [230, 150, 30], stroke: [0, 0, 0], font: "GothamMedium", font_bold: "GothamBold", radius: 10 },
    candy: { primary: [255, 96, 160], secondary: [255, 210, 70], surface: [255, 244, 250], surface_alt: [255, 228, 240], text: [60, 30, 50], text_muted: [150, 110, 135], success: [70, 200, 140], danger: [240, 70, 90], warning: [255, 170, 50], stroke: [255, 120, 180], font: "FredokaOne", font_bold: "FredokaOne", radius: 18 },
    neon: { primary: [0, 255, 200], secondary: [255, 0, 170], surface: [8, 10, 20], surface_alt: [16, 20, 36], text: [230, 255, 250], text_muted: [120, 170, 170], success: [90, 255, 150], danger: [255, 70, 110], warning: [255, 220, 60], stroke: [0, 255, 200], font: "Arcade", font_bold: "Arcade", radius: 6 },
    royal_gold: { primary: [212, 170, 60], secondary: [120, 40, 160], surface: [26, 20, 32], surface_alt: [40, 30, 50], text: [250, 240, 220], text_muted: [180, 165, 140], success: [110, 200, 120], danger: [220, 80, 80], warning: [255, 200, 90], stroke: [212, 170, 60], font: "Garamond", font_bold: "Garamond", radius: 8 },
    forest: { primary: [80, 190, 110], secondary: [230, 160, 60], surface: [18, 30, 24], surface_alt: [28, 46, 36], text: [236, 246, 238], text_muted: [150, 180, 160], success: [120, 220, 140], danger: [230, 90, 80], warning: [240, 190, 70], stroke: [120, 200, 140], font: "GothamMedium", font_bold: "GothamBold", radius: 14 },
    horror: { primary: [170, 20, 30], secondary: [120, 120, 130], surface: [10, 8, 10], surface_alt: [22, 18, 20], text: [220, 210, 205], text_muted: [120, 110, 110], success: [90, 140, 90], danger: [255, 40, 40], warning: [200, 140, 40], stroke: [120, 20, 30], font: "Creepster", font_bold: "Creepster", radius: 2 },
    ocean: { primary: [40, 170, 230], secondary: [255, 170, 80], surface: [12, 28, 44], surface_alt: [20, 44, 66], text: [230, 244, 255], text_muted: [140, 180, 205], success: [70, 210, 150], danger: [240, 90, 90], warning: [255, 200, 80], stroke: [90, 200, 255], font: "GothamMedium", font_bold: "GothamBold", radius: 14 },
    sakura: { primary: [245, 120, 160], secondary: [120, 200, 170], surface: [255, 250, 252], surface_alt: [255, 236, 243], text: [70, 40, 55], text_muted: [160, 120, 140], success: [90, 190, 140], danger: [230, 80, 100], warning: [250, 180, 70], stroke: [245, 150, 180], font: "Nunito", font_bold: "Nunito", radius: 16 },
    retro: { primary: [255, 204, 0], secondary: [0, 180, 255], surface: [30, 30, 40], surface_alt: [48, 48, 64], text: [255, 255, 255], text_muted: [170, 170, 190], success: [80, 220, 100], danger: [255, 80, 80], warning: [255, 170, 0], stroke: [255, 255, 255], font: "PressStart2P", font_bold: "PressStart2P", radius: 0 },
  };
  const PRESET_NAMES = Object.keys(PRESETS);

  function tokensFrom(a) {
    a = a || {};
    const presetName = PRESET_NAMES.includes(String(a.preset || "").toLowerCase()) ? String(a.preset).toLowerCase() : "midnight";
    const p = PRESETS[presetName];
    const col = (k, d) => parseColor(a[k], null) || d;
    const primary = col("primary", p.primary);
    const surface = col("surface", p.surface);
    const text = col("text", p.text);
    const radius = isFinite(Number(a.radius)) ? Math.max(0, Math.min(40, Number(a.radius))) : p.radius;
    const spacing = isFinite(Number(a.spacing)) ? Math.max(2, Math.min(40, Number(a.spacing))) : 12;
    const font = String(a.font || p.font).replace(/[^A-Za-z0-9]/g, "") || "GothamMedium";
    const fontBold = String(a.font_bold || (a.font ? a.font : p.font_bold)).replace(/[^A-Za-z0-9]/g, "") || font;
    return {
      preset: presetName,
      name: String(a.name || presetName).slice(0, 40),
      palette: {
        Primary: primary, PrimaryHover: mix(primary, [255, 255, 255], 0.14), PrimaryPressed: mix(primary, [0, 0, 0], 0.18),
        Secondary: col("secondary", p.secondary), Surface: surface, SurfaceAlt: col("surface_alt", p.surface_alt),
        Text: text, TextMuted: col("text_muted", p.text_muted), Success: col("success", p.success), Danger: col("danger", p.danger),
        Warning: col("warning", p.warning), Stroke: col("stroke", p.stroke), Overlay: [0, 0, 0],
      },
      radius: { sm: Math.round(radius * 0.5), md: radius, lg: Math.round(radius * 1.6), pill: 999 },
      spacing: { xs: Math.round(spacing / 3), sm: Math.round(spacing * 2 / 3), md: spacing, lg: Math.round(spacing * 5 / 3), xl: Math.round(spacing * 8 / 3) },
      font: { Family: font, Bold: fontBold, Sizes: { title: 40, h1: 28, h2: 22, body: 18, caption: 14 } },
      stroke: { thickness: isFinite(Number(a.stroke_thickness)) ? Number(a.stroke_thickness) : 1.5, transparency: isFinite(Number(a.stroke_transparency)) ? Number(a.stroke_transparency) : 0.55 },
      motion: { fast: 0.1, normal: 0.2, slow: 0.35, style: "Quad" },
      sounds: { hover: String(a.hover_sound || ""), click: String(a.click_sound || "") },
      rarity: { common: [160, 165, 180], uncommon: [90, 200, 110], rare: [80, 140, 255], epic: [170, 90, 255], legendary: [255, 190, 60], mythic: [255, 80, 100] },
    };
  }
  const luaColor = (c) => "Color3.fromRGB(" + c.map((x) => Math.max(0, Math.min(255, Math.round(x)))).join(", ") + ")";
  function tokensModuleSource(T) {
    const pal = Object.entries(T.palette).map(([k, v]) => "\t" + k + " = " + luaColor(v) + ",").join("\n");
    const rar = Object.entries(T.rarity).map(([k, v]) => "\t" + k + " = " + luaColor(v) + ",").join("\n");
    return [
      "-- TotalScript design tokens (" + T.name + ", preset " + T.preset + ") - generated by design_tokens_set. Edit freely;",
      "-- every kit component and every generated screen reads this module at runtime.",
      "local T = {}",
      "T.preset = " + q(T.preset),
      "T.name = " + q(T.name),
      "T.palette = {", pal, "}",
      "T.radius = { sm = " + nn(T.radius.sm) + ", md = " + nn(T.radius.md) + ", lg = " + nn(T.radius.lg) + ", pill = 999 }",
      "T.spacing = { xs = " + nn(T.spacing.xs) + ", sm = " + nn(T.spacing.sm) + ", md = " + nn(T.spacing.md) + ", lg = " + nn(T.spacing.lg) + ", xl = " + nn(T.spacing.xl) + " }",
      "T.font = { Family = " + q(T.font.Family) + ", Bold = " + q(T.font.Bold) + ", Sizes = { title = 40, h1 = 28, h2 = 22, body = 18, caption = 14 } }",
      "T.stroke = { thickness = " + nn(T.stroke.thickness, 1.5) + ", transparency = " + nn(T.stroke.transparency, 0.55) + " }",
      "T.motion = { fast = 0.1, normal = 0.2, slow = 0.35, style = \"Quad\" }",
      "T.sounds = { hover = " + q(T.sounds.hover) + ", click = " + q(T.sounds.click) + " }",
      "T.rarity = {", rar, "}",
      "return T",
    ].join("\n");
  }
  const DEFAULT_TOKENS = tokensFrom({});

  // ───────────────────────── LUAU MODULES (written into the place) ─────────────────────────
  const UIKIT_SRC = `-- TotalScript UIKit (generated by design_kit_install, v${KIT_VERSION}). Safe to edit; re-run with force=true to reset.
-- Every function returns the created instance (and, for containers, the content frame).
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")
local SoundService = game:GetService("SoundService")
local RunService = game:GetService("RunService")

local UIKit = {}
UIKit.VERSION = "${KIT_VERSION}"

local folder = script.Parent
local cachedTokens = nil

local function fallbackTokens()
	return {
		palette = {
			Primary = Color3.fromRGB(88, 120, 255), PrimaryHover = Color3.fromRGB(112, 139, 255), PrimaryPressed = Color3.fromRGB(72, 98, 209),
			Secondary = Color3.fromRGB(255, 186, 72), Surface = Color3.fromRGB(20, 22, 32), SurfaceAlt = Color3.fromRGB(30, 33, 46),
			Text = Color3.fromRGB(240, 242, 250), TextMuted = Color3.fromRGB(150, 156, 178), Success = Color3.fromRGB(70, 210, 130),
			Danger = Color3.fromRGB(240, 80, 90), Warning = Color3.fromRGB(255, 180, 60), Stroke = Color3.fromRGB(255, 255, 255), Overlay = Color3.fromRGB(0, 0, 0),
		},
		radius = { sm = 6, md = 12, lg = 19, pill = 999 },
		spacing = { xs = 4, sm = 8, md = 12, lg = 20, xl = 32 },
		font = { Family = "GothamMedium", Bold = "GothamBold", Sizes = { title = 40, h1 = 28, h2 = 22, body = 18, caption = 14 } },
		stroke = { thickness = 1.5, transparency = 0.55 },
		motion = { fast = 0.1, normal = 0.2, slow = 0.35, style = "Quad" },
		sounds = { hover = "", click = "" },
		rarity = { common = Color3.fromRGB(160, 165, 180), uncommon = Color3.fromRGB(90, 200, 110), rare = Color3.fromRGB(80, 140, 255), epic = Color3.fromRGB(170, 90, 255), legendary = Color3.fromRGB(255, 190, 60), mythic = Color3.fromRGB(255, 80, 100) },
	}
end

function UIKit.tokens(fresh)
	if cachedTokens and not fresh then
		return cachedTokens
	end
	local base = fallbackTokens()
	local m = folder and folder:FindFirstChild("Tokens")
	if m and m:IsA("ModuleScript") then
		local okR, t = false, nil
		if RunService:IsEdit() then
			-- design-time: read the live Source so design_tokens_set is picked up without a require cache hit
			local okL, f = pcall(loadstring, m.Source)
			if okL and type(f) == "function" then
				okR, t = pcall(f)
			end
		end
		if not (okR and type(t) == "table") then
			okR, t = pcall(require, m)
		end
		if okR and type(t) == "table" then
			for k, v in pairs(t) do
				if type(v) == "table" and type(base[k]) == "table" then
					for k2, v2 in pairs(v) do
						base[k][k2] = v2
					end
				else
					base[k] = v
				end
			end
		end
	end
	cachedTokens = base
	return base
end

local function T()
	return UIKit.tokens()
end

local function fontOf(name)
	local okF, f = pcall(function()
		return Enum.Font[name]
	end)
	if okF and f then
		return f
	end
	return Enum.Font.GothamMedium
end

local function luminance(c)
	local function ch(v)
		if v <= 0.03928 then
			return v / 12.92
		end
		return ((v + 0.055) / 1.055) ^ 2.4
	end
	return 0.2126 * ch(c.R) + 0.7152 * ch(c.G) + 0.0722 * ch(c.B)
end

function UIKit.luminance(c)
	return luminance(c)
end

function UIKit.contrast(a, b)
	local la, lb = luminance(a), luminance(b)
	if la < lb then
		la, lb = lb, la
	end
	return (la + 0.05) / (lb + 0.05)
end

function UIKit.textOn(bg)
	local t = T()
	if UIKit.contrast(bg, t.palette.Text) >= UIKit.contrast(bg, Color3.fromRGB(16, 16, 22)) then
		return t.palette.Text
	end
	return Color3.fromRGB(16, 16, 22)
end

function UIKit.corner(inst, r)
	local c = inst:FindFirstChildOfClass("UICorner") or Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, r or T().radius.md)
	c.Parent = inst
	return c
end

function UIKit.stroke(inst, color, thickness, transparency)
	local t = T()
	local s = inst:FindFirstChildOfClass("UIStroke") or Instance.new("UIStroke")
	s.Color = color or t.palette.Stroke
	s.Thickness = thickness or t.stroke.thickness
	s.Transparency = transparency or t.stroke.transparency
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	s.Parent = inst
	return s
end

function UIKit.padding(inst, all, vertical)
	local p = inst:FindFirstChildOfClass("UIPadding") or Instance.new("UIPadding")
	local h = all or T().spacing.md
	local v = vertical or h
	p.PaddingLeft = UDim.new(0, h)
	p.PaddingRight = UDim.new(0, h)
	p.PaddingTop = UDim.new(0, v)
	p.PaddingBottom = UDim.new(0, v)
	p.Parent = inst
	return p
end

function UIKit.textFit(label, maxSize, minSize)
	label.TextScaled = true
	label.TextWrapped = true
	local c = label:FindFirstChildOfClass("UITextSizeConstraint") or Instance.new("UITextSizeConstraint")
	c.MinTextSize = minSize or 9
	c.MaxTextSize = maxSize or T().font.Sizes.body
	c.Parent = label
	return c
end

function UIKit.layout(inst, direction, gap, hAlign, vAlign)
	local l = inst:FindFirstChildOfClass("UIListLayout") or Instance.new("UIListLayout")
	l.FillDirection = (direction == "row") and Enum.FillDirection.Horizontal or Enum.FillDirection.Vertical
	l.Padding = UDim.new(0, gap or T().spacing.sm)
	l.SortOrder = Enum.SortOrder.LayoutOrder
	l.HorizontalAlignment = hAlign or Enum.HorizontalAlignment.Left
	l.VerticalAlignment = vAlign or Enum.VerticalAlignment.Top
	l.Parent = inst
	return l
end

local function sound(id, volume)
	if not id or id == "" then
		return
	end
	local s = Instance.new("Sound")
	s.SoundId = id
	s.Volume = volume or 0.5
	s.PlayOnRemove = true
	s.Parent = SoundService
	s:Destroy()
end

local function tween(inst, props, time, style)
	local t = T()
	local okS, es = pcall(function()
		return Enum.EasingStyle[style or t.motion.style]
	end)
	local tw = TweenService:Create(inst, TweenInfo.new(time or t.motion.fast, (okS and es) or Enum.EasingStyle.Quad, Enum.EasingDirection.Out), props)
	tw:Play()
	return tw
end
UIKit.tween = tween

-- Idempotence guards live in weak tables, NOT attributes: attributes are cloned from
-- StarterGui into PlayerGui and saved with the place, which would make every client
-- believe its buttons were already wired by the design-time pass.
local wiredSet = setmetatable({}, { __mode = "k" })
local progressSet = setmetatable({}, { __mode = "k" })
local toggleSet = setmetatable({}, { __mode = "k" })
local tabsSet = setmetatable({}, { __mode = "k" })

-- Hover / press / disabled states for any GuiButton. Idempotent per UIKit instance.
function UIKit.wireButton(btn)
	if not btn:IsA("GuiButton") or wiredSet[btn] then
		return
	end
	wiredSet[btn] = true
	local t = T()
	local base = btn.BackgroundColor3
	local hasBg = btn.BackgroundTransparency < 0.95
	local hoverCol = btn:GetAttribute("Total_HoverColor") or base:Lerp(Color3.new(1, 1, 1), 0.12)
	local pressCol = base:Lerp(Color3.new(0, 0, 0), 0.18)
	local scale = btn:FindFirstChild("Total_PressScale")
	if not scale then
		scale = Instance.new("UIScale")
		scale.Name = "Total_PressScale"
		scale.Parent = btn
	end
	local function restore()
		if hasBg then
			tween(btn, { BackgroundColor3 = btn:GetAttribute("Total_BaseColor") or base }, t.motion.fast)
		end
		tween(scale, { Scale = 1 }, t.motion.fast)
	end
	btn.AutoButtonColor = false
	btn.MouseEnter:Connect(function()
		if btn:GetAttribute("Total_Disabled") then
			return
		end
		if hasBg then
			tween(btn, { BackgroundColor3 = hoverCol }, t.motion.fast)
		end
		tween(scale, { Scale = 1.03 }, t.motion.fast)
		sound(t.sounds.hover, 0.25)
	end)
	btn.MouseLeave:Connect(restore)
	btn.MouseButton1Down:Connect(function()
		if btn:GetAttribute("Total_Disabled") then
			return
		end
		if hasBg then
			tween(btn, { BackgroundColor3 = pressCol }, t.motion.fast)
		end
		tween(scale, { Scale = 0.97 }, t.motion.fast)
	end)
	btn.MouseButton1Up:Connect(restore)
	btn.Activated:Connect(function()
		sound(t.sounds.click, 0.5)
	end)
	btn.SelectionGained:Connect(function()
		tween(scale, { Scale = 1.04 }, t.motion.fast)
	end)
	btn.SelectionLost:Connect(restore)
end

function UIKit.setDisabled(btn, disabled)
	btn:SetAttribute("Total_Disabled", disabled and true or nil)
	btn.Active = not disabled
	btn.AutoButtonColor = false
	tween(btn, { BackgroundTransparency = disabled and 0.5 or 0 }, T().motion.fast)
end

function UIKit.selectionCursor()
	local t = T()
	local f = Instance.new("Frame")
	f.Name = "Total_SelectionCursor"
	f.BackgroundTransparency = 1
	f.Size = UDim2.new(1, 8, 1, 8)
	f.Position = UDim2.new(0, -4, 0, -4)
	UIKit.corner(f, t.radius.md)
	UIKit.stroke(f, t.palette.Primary, 3, 0)
	return f
end

-- ───────── primitives ─────────
function UIKit.Label(props)
	props = props or {}
	local t = T()
	local role = props.role or "body"
	local l = Instance.new("TextLabel")
	l.Name = props.name or "Label"
	l.BackgroundTransparency = 1
	l.Size = props.size or UDim2.new(1, 0, 0, t.font.Sizes[role] and (t.font.Sizes[role] + 10) or 28)
	l.Position = props.position or UDim2.new()
	l.AnchorPoint = props.anchor or Vector2.new()
	l.Text = props.text or ""
	l.RichText = props.rich ~= false
	l.Font = fontOf((props.bold or role == "title" or role == "h1" or role == "h2") and t.font.Bold or t.font.Family)
	l.TextColor3 = props.color or (props.muted and t.palette.TextMuted) or t.palette.Text
	l.TextXAlignment = props.align or Enum.TextXAlignment.Left
	l.TextYAlignment = props.valign or Enum.TextYAlignment.Center
	UIKit.textFit(l, props.maxSize or t.font.Sizes[role] or t.font.Sizes.body)
	if props.strokeText then
		l.TextStrokeTransparency = 0.6
	end
	l.LayoutOrder = props.order or 0
	l.ZIndex = props.z or 1
	l.Parent = props.parent
	return l
end

function UIKit.Image(props)
	props = props or {}
	local i = Instance.new("ImageLabel")
	i.Name = props.name or "Image"
	i.BackgroundTransparency = 1
	i.Image = props.image or ""
	i.ScaleType = props.scaleType or Enum.ScaleType.Fit
	i.Size = props.size or UDim2.new(0, 64, 0, 64)
	i.Position = props.position or UDim2.new()
	i.AnchorPoint = props.anchor or Vector2.new()
	if props.color then
		i.ImageColor3 = props.color
	end
	if props.radius then
		UIKit.corner(i, props.radius)
	end
	i.LayoutOrder = props.order or 0
	i.Parent = props.parent
	return i
end

function UIKit.Panel(props)
	props = props or {}
	local t = T()
	local f = Instance.new("Frame")
	f.Name = props.name or "Panel"
	f.BackgroundColor3 = props.color or (props.alt and t.palette.SurfaceAlt) or t.palette.Surface
	f.BackgroundTransparency = props.transparency or 0
	f.BorderSizePixel = 0
	f.Size = props.size or UDim2.new(0, 400, 0, 300)
	f.Position = props.position or UDim2.new(0.5, 0, 0.5, 0)
	f.AnchorPoint = props.anchor or Vector2.new(0.5, 0.5)
	f.ClipsDescendants = props.clip == true
	if props.radius ~= false then
		UIKit.corner(f, props.radius or t.radius.lg)
	end
	if props.stroke ~= false then
		UIKit.stroke(f, props.strokeColor, props.strokeThickness, props.strokeTransparency)
	end
	if props.padding ~= false then
		UIKit.padding(f, props.padding or t.spacing.md)
	end
	if props.layout then
		local l = UIKit.layout(f, props.layout, props.gap, props.hAlign, props.vAlign)
		if props.wrap then
			pcall(function()
				l.Wraps = true
			end)
		end
	end
	if props.gradient then
		local g = Instance.new("UIGradient")
		g.Color = ColorSequence.new(f.BackgroundColor3, props.gradient)
		g.Rotation = props.gradientRotation or 90
		g.Parent = f
	end
	f.LayoutOrder = props.order or 0
	f.ZIndex = props.z or 1
	f.Parent = props.parent
	return f, f
end

function UIKit.Row(props)
	props = props or {}
	props.layout = "row"
	props.radius = props.radius or false
	if props.stroke == nil then
		props.stroke = false
	end
	if props.transparency == nil then
		props.transparency = 1
	end
	if props.padding == nil then
		props.padding = false
	end
	props.name = props.name or "Row"
	props.size = props.size or UDim2.new(1, 0, 0, 48)
	props.anchor = props.anchor or Vector2.new()
	props.position = props.position or UDim2.new()
	props.vAlign = props.vAlign or Enum.VerticalAlignment.Center
	return UIKit.Panel(props)
end

function UIKit.Column(props)
	props = props or {}
	props.layout = "column"
	props.radius = props.radius or false
	if props.stroke == nil then
		props.stroke = false
	end
	if props.transparency == nil then
		props.transparency = 1
	end
	if props.padding == nil then
		props.padding = false
	end
	props.name = props.name or "Column"
	props.size = props.size or UDim2.new(1, 0, 1, 0)
	props.anchor = props.anchor or Vector2.new()
	props.position = props.position or UDim2.new()
	return UIKit.Panel(props)
end

function UIKit.Grid(props)
	props = props or {}
	local t = T()
	props.name = props.name or "Grid"
	props.radius = props.radius or false
	if props.stroke == nil then
		props.stroke = false
	end
	if props.transparency == nil then
		props.transparency = 1
	end
	if props.padding == nil then
		props.padding = false
	end
	props.size = props.size or UDim2.new(1, 0, 1, 0)
	props.anchor = props.anchor or Vector2.new()
	props.position = props.position or UDim2.new()
	local f = UIKit.Panel(props)
	local g = Instance.new("UIGridLayout")
	g.CellSize = props.cell or UDim2.new(0, 120, 0, 120)
	g.CellPadding = UDim2.new(0, props.gap or t.spacing.sm, 0, props.gap or t.spacing.sm)
	g.SortOrder = Enum.SortOrder.LayoutOrder
	g.HorizontalAlignment = props.hAlign or Enum.HorizontalAlignment.Left
	g.Parent = f
	if props.cellAspect and props.cellAspect > 0 then
		local ar = Instance.new("UIAspectRatioConstraint")
		ar.AspectRatio = props.cellAspect
		ar.DominantAxis = Enum.DominantAxis.Width
		ar.Parent = g
	end
	return f, f
end

function UIKit.ScrollList(props)
	props = props or {}
	local t = T()
	local s = Instance.new("ScrollingFrame")
	s.Name = props.name or "List"
	s.BackgroundColor3 = props.color or t.palette.SurfaceAlt
	s.BackgroundTransparency = props.transparency or 1
	s.BorderSizePixel = 0
	s.Size = props.size or UDim2.new(1, 0, 1, 0)
	s.Position = props.position or UDim2.new()
	s.AnchorPoint = props.anchor or Vector2.new()
	s.ScrollBarThickness = 6
	s.ScrollBarImageColor3 = t.palette.Primary
	s.ScrollingDirection = (props.direction == "row") and Enum.ScrollingDirection.X or Enum.ScrollingDirection.Y
	s.AutomaticCanvasSize = (props.direction == "row") and Enum.AutomaticSize.X or Enum.AutomaticSize.Y
	s.CanvasSize = UDim2.new()
	s.ElasticBehavior = Enum.ElasticBehavior.WhenScrollable
	if props.grid then
		local g = Instance.new("UIGridLayout")
		g.CellSize = props.cell or UDim2.new(0, 120, 0, 120)
		g.CellPadding = UDim2.new(0, props.gap or t.spacing.sm, 0, props.gap or t.spacing.sm)
		g.SortOrder = Enum.SortOrder.LayoutOrder
		g.Parent = s
		if props.cellAspect and props.cellAspect > 0 then
			local ar = Instance.new("UIAspectRatioConstraint")
			ar.AspectRatio = props.cellAspect
			ar.DominantAxis = Enum.DominantAxis.Width
			ar.Parent = g
		end
	else
		UIKit.layout(s, props.direction or "column", props.gap)
	end
	if props.padding then
		UIKit.padding(s, props.padding)
	end
	if props.radius then
		UIKit.corner(s, props.radius)
	end
	s.LayoutOrder = props.order or 0
	s.Parent = props.parent
	return s, s
end

function UIKit.Button(props)
	props = props or {}
	local t = T()
	local variant = props.variant or "primary"
	local bg = t.palette.Primary
	if variant == "secondary" then
		bg = t.palette.Secondary
	elseif variant == "danger" then
		bg = t.palette.Danger
	elseif variant == "success" then
		bg = t.palette.Success
	elseif variant == "ghost" then
		bg = t.palette.SurfaceAlt
	elseif variant == "surface" then
		bg = t.palette.Surface
	end
	if props.color then
		bg = props.color
	end
	local b = Instance.new("TextButton")
	b.Name = props.name or "Button"
	b.AutoButtonColor = false
	b.BackgroundColor3 = bg
	b.BackgroundTransparency = (variant == "ghost" and props.color == nil) and 0.25 or 0
	b.BorderSizePixel = 0
	b.Size = props.size or UDim2.new(0, 200, 0, 48)
	b.Position = props.position or UDim2.new()
	b.AnchorPoint = props.anchor or Vector2.new()
	b.Text = ""
	b.Font = fontOf(t.font.Bold)
	b.TextColor3 = props.textColor or UIKit.textOn(bg)
	b.Selectable = true
	b:SetAttribute("Total_BaseColor", bg)
	UIKit.corner(b, props.radius or t.radius.md)
	if variant == "ghost" or props.outline then
		UIKit.stroke(b, props.outlineColor or t.palette.Stroke)
	end
	local label = UIKit.Label({ name = "Label", text = props.text or "Button", role = props.role or "body", bold = true, align = Enum.TextXAlignment.Center, color = b.TextColor3, size = UDim2.new(1, -16, 1, -8), position = UDim2.new(0.5, 0, 0.5, 0), anchor = Vector2.new(0.5, 0.5), parent = b, maxSize = props.maxSize or 22 })
	if props.icon and props.icon ~= "" then
		local ic = UIKit.Image({ name = "Icon", image = props.icon, size = UDim2.new(0, 24, 0, 24), position = UDim2.new(0, 12, 0.5, 0), anchor = Vector2.new(0, 0.5), parent = b, color = b.TextColor3 })
		ic.ZIndex = b.ZIndex + 1
		label.Position = UDim2.new(0.5, 14, 0.5, 0)
		label.Size = UDim2.new(1, -52, 1, -8)
	end
	if props.action then
		b:SetAttribute("Total_Action", props.action)
	end
	if props.item then
		b:SetAttribute("Total_Item", props.item)
	end
	b.LayoutOrder = props.order or 0
	b.ZIndex = props.z or 1
	label.ZIndex = b.ZIndex + 1
	b.Parent = props.parent
	UIKit.wireButton(b)
	return b
end

function UIKit.IconButton(props)
	props = props or {}
	local t = T()
	local b = Instance.new("ImageButton")
	b.Name = props.name or "IconButton"
	b.AutoButtonColor = false
	b.BackgroundColor3 = props.color or t.palette.SurfaceAlt
	b.BackgroundTransparency = props.transparency or 0
	b.BorderSizePixel = 0
	b.Size = props.size or UDim2.new(0, 44, 0, 44)
	b.Position = props.position or UDim2.new()
	b.AnchorPoint = props.anchor or Vector2.new()
	b.Image = props.image or ""
	b.ImageColor3 = props.iconColor or UIKit.textOn(b.BackgroundColor3)
	b.ScaleType = Enum.ScaleType.Fit
	b.Selectable = true
	b:SetAttribute("Total_BaseColor", b.BackgroundColor3)
	UIKit.corner(b, props.radius or t.radius.md)
	UIKit.padding(b, props.padding or 10)
	if props.outline then
		UIKit.stroke(b)
	end
	if props.text and props.text ~= "" and (props.image == nil or props.image == "") then
		UIKit.Label({ name = "Glyph", text = props.text, bold = true, align = Enum.TextXAlignment.Center, color = b.ImageColor3, size = UDim2.new(1, 0, 1, 0), parent = b, maxSize = 24 })
	end
	if props.action then
		b:SetAttribute("Total_Action", props.action)
	end
	b.LayoutOrder = props.order or 0
	b.ZIndex = props.z or 1
	b.Parent = props.parent
	UIKit.wireButton(b)
	return b
end

function UIKit.Divider(props)
	props = props or {}
	local t = T()
	local f = Instance.new("Frame")
	f.Name = props.name or "Divider"
	f.BackgroundColor3 = props.color or t.palette.Stroke
	f.BackgroundTransparency = props.transparency or 0.8
	f.BorderSizePixel = 0
	f.Size = props.size or UDim2.new(1, 0, 0, 2)
	f.LayoutOrder = props.order or 0
	f.Parent = props.parent
	return f
end

function UIKit.Spacer(props)
	props = props or {}
	local f = Instance.new("Frame")
	f.Name = props.name or "Spacer"
	f.BackgroundTransparency = 1
	f.Size = props.size or UDim2.new(0, 12, 0, 12)
	f.LayoutOrder = props.order or 0
	f.Parent = props.parent
	return f
end

function UIKit.Input(props)
	props = props or {}
	local t = T()
	local b = Instance.new("TextBox")
	b.Name = props.name or "Input"
	b.BackgroundColor3 = props.color or t.palette.SurfaceAlt
	b.BorderSizePixel = 0
	b.Size = props.size or UDim2.new(1, 0, 0, 44)
	b.Position = props.position or UDim2.new()
	b.AnchorPoint = props.anchor or Vector2.new()
	b.Font = fontOf(t.font.Family)
	b.Text = props.text or ""
	b.PlaceholderText = props.placeholder or "Type here..."
	b.PlaceholderColor3 = t.palette.TextMuted
	b.TextColor3 = t.palette.Text
	b.ClearTextOnFocus = false
	b.TextXAlignment = Enum.TextXAlignment.Left
	UIKit.textFit(b, props.maxSize or t.font.Sizes.body)
	UIKit.corner(b, props.radius or t.radius.md)
	UIKit.stroke(b)
	UIKit.padding(b, t.spacing.sm, 0)
	b.LayoutOrder = props.order or 0
	b.Parent = props.parent
	return b
end

-- ───────── composites ─────────
function UIKit.Window(props)
	props = props or {}
	local t = T()
	local win = UIKit.Panel({ name = props.name or "Window", size = props.size or UDim2.new(0, 720, 0, 480), position = props.position, anchor = props.anchor, parent = props.parent, padding = false, radius = props.radius or t.radius.lg, color = props.color, clip = true })
	win:SetAttribute("Total_Window", true)
	local header = UIKit.Panel({ name = "Header", size = UDim2.new(1, 0, 0, 56), position = UDim2.new(), anchor = Vector2.new(), parent = win, alt = true, radius = false, stroke = false, padding = t.spacing.md, layout = "row", gap = t.spacing.sm, vAlign = Enum.VerticalAlignment.Center })
	UIKit.corner(header, t.radius.lg)
	local fill = Instance.new("Frame")
	fill.Name = "HeaderFill"
	fill.BackgroundColor3 = header.BackgroundColor3
	fill.BorderSizePixel = 0
	fill.Size = UDim2.new(1, 0, 0.5, 0)
	fill.Position = UDim2.new(0, 0, 0.5, 0)
	fill.ZIndex = 0
	fill.Parent = header
	if props.icon and props.icon ~= "" then
		UIKit.Image({ name = "Icon", image = props.icon, size = UDim2.new(0, 28, 0, 28), parent = header, order = 0 })
	end
	UIKit.Label({ name = "Title", text = props.title or props.name or "Window", role = "h2", size = UDim2.new(1, -120, 1, 0), parent = header, order = 1 })
	local side = UIKit.Row({ name = "HeaderRight", size = UDim2.new(0, 0, 1, 0), parent = header, order = 9, gap = t.spacing.sm })
	side.AutomaticSize = Enum.AutomaticSize.X
	side:FindFirstChildOfClass("UIListLayout").HorizontalAlignment = Enum.HorizontalAlignment.Right
	if props.closable ~= false then
		UIKit.IconButton({ name = "Close", text = "X", action = "close", size = UDim2.new(0, 36, 0, 36), parent = side, order = 99, color = t.palette.Danger, iconColor = UIKit.textOn(t.palette.Danger) })
	end
	local body = Instance.new("Frame")
	body.Name = "Body"
	body.BackgroundTransparency = 1
	body.Size = UDim2.new(1, 0, 1, -56)
	body.Position = UDim2.new(0, 0, 0, 56)
	body.Parent = win
	UIKit.padding(body, props.padding or t.spacing.md)
	if props.layout then
		UIKit.layout(body, props.layout, props.gap)
	end
	local anim = Instance.new("UIScale")
	anim.Name = "Total_Anim"
	anim.Parent = win
	return win, body, header
end

function UIKit.CurrencyPill(props)
	props = props or {}
	local t = T()
	local pill = UIKit.Panel({ name = props.name or "Currency", size = props.size or UDim2.new(0, 150, 0, 40), position = props.position, anchor = props.anchor or Vector2.new(), parent = props.parent, alt = true, radius = 999, padding = t.spacing.sm, layout = "row", gap = t.spacing.xs, vAlign = Enum.VerticalAlignment.Center })
	pill.LayoutOrder = props.order or 0
	if props.stat then
		pill:SetAttribute("Total_Stat", props.stat)
	end
	local icon
	if props.icon and props.icon ~= "" then
		icon = UIKit.Image({ name = "Icon", image = props.icon, size = UDim2.new(0, 24, 0, 24), parent = pill, order = 0, color = props.color })
	else
		icon = UIKit.Panel({ name = "Icon", size = UDim2.new(0, 22, 0, 22), parent = pill, color = props.color or t.palette.Secondary, radius = 999, stroke = false, padding = false, anchor = Vector2.new(), position = UDim2.new() })
		icon.LayoutOrder = 0
	end
	local value = UIKit.Label({ name = "Value", text = tostring(props.value or "0"), bold = true, size = UDim2.new(1, -34, 1, 0), parent = pill, order = 1, maxSize = 20 })
	if props.action then
		local plus = UIKit.IconButton({ name = "Add", text = "+", action = props.action, size = UDim2.new(0, 26, 0, 26), parent = pill, order = 2, color = t.palette.Success, radius = 999, padding = 2 })
		plus.LayoutOrder = 2
	end
	return pill, value
end

function UIKit.ProgressBar(props)
	props = props or {}
	local t = T()
	local bar = UIKit.Panel({ name = props.name or "Progress", size = props.size or UDim2.new(1, 0, 0, 22), position = props.position, anchor = props.anchor or Vector2.new(), parent = props.parent, alt = true, radius = 999, padding = false, stroke = props.stroke ~= false, clip = true })
	bar.LayoutOrder = props.order or 0
	local v = math.clamp(tonumber(props.value) or 0, 0, 1)
	bar:SetAttribute("Total_Progress", v)
	local fill = Instance.new("Frame")
	fill.Name = "Fill"
	fill.BackgroundColor3 = props.color or t.palette.Primary
	fill.BorderSizePixel = 0
	fill.Size = UDim2.new(v, 0, 1, 0)
	fill.Parent = bar
	UIKit.corner(fill, 999)
	local g = Instance.new("UIGradient")
	g.Color = ColorSequence.new(fill.BackgroundColor3, fill.BackgroundColor3:Lerp(Color3.new(1, 1, 1), 0.25))
	g.Rotation = 0
	g.Parent = fill
	if props.label ~= false then
		local l = UIKit.Label({ name = "Label", text = props.label or (math.floor(v * 100 + 0.5) .. "%"), role = "caption", bold = true, align = Enum.TextXAlignment.Center, size = UDim2.new(1, 0, 1, 0), parent = bar, maxSize = 14 })
		l.ZIndex = fill.ZIndex + 1
		l.TextStrokeTransparency = 0.7
	end
	UIKit.bindProgress(bar)
	return bar, fill
end

function UIKit.bindProgress(bar)
	if progressSet[bar] then
		return
	end
	progressSet[bar] = true
	local fill = bar:FindFirstChild("Fill")
	local label = bar:FindFirstChild("Label")
	bar:GetAttributeChangedSignal("Total_Progress"):Connect(function()
		local v = math.clamp(tonumber(bar:GetAttribute("Total_Progress")) or 0, 0, 1)
		if fill then
			tween(fill, { Size = UDim2.new(v, 0, 1, 0) }, T().motion.normal)
		end
		if label and label:IsA("TextLabel") and not bar:GetAttribute("Total_LabelLocked") then
			label.Text = math.floor(v * 100 + 0.5) .. "%"
		end
	end)
end

function UIKit.Toggle(props)
	props = props or {}
	local t = T()
	-- The whole row is the button (>=44 px touch target); the switch is a visual child.
	local row = Instance.new("TextButton")
	row.Name = props.name or "Toggle"
	row.Text = ""
	row.AutoButtonColor = false
	row.BackgroundTransparency = 1
	row.BorderSizePixel = 0
	row.Size = props.size or UDim2.new(1, 0, 0, 44)
	row.LayoutOrder = props.order or 0
	row.Selectable = true
	row.Parent = props.parent
	UIKit.Label({ name = "Label", text = props.text or props.name or "Option", size = UDim2.new(1, -80, 1, 0), parent = row, anchor = Vector2.new(0, 0.5), position = UDim2.new(0, 0, 0.5, 0) })
	local sw = Instance.new("Frame")
	sw.Name = "Switch"
	sw.BackgroundColor3 = t.palette.SurfaceAlt
	sw.BorderSizePixel = 0
	sw.Size = UDim2.new(0, 64, 0, 32)
	sw.AnchorPoint = Vector2.new(1, 0.5)
	sw.Position = UDim2.new(1, 0, 0.5, 0)
	sw.Parent = row
	UIKit.corner(sw, 999)
	UIKit.stroke(sw)
	local knob = Instance.new("Frame")
	knob.Name = "Knob"
	knob.BackgroundColor3 = t.palette.Text
	knob.BorderSizePixel = 0
	knob.Size = UDim2.new(0, 24, 0, 24)
	knob.AnchorPoint = Vector2.new(0, 0.5)
	knob.Position = UDim2.new(0, 4, 0.5, 0)
	knob.Parent = sw
	UIKit.corner(knob, 999)
	row:SetAttribute("Total_Toggle", props.value == true)
	if props.setting then
		row:SetAttribute("Total_Setting", props.setting)
	end
	UIKit.bindToggle(row)
	return row, row
end

function UIKit.bindToggle(sw)
	if toggleSet[sw] then
		return
	end
	toggleSet[sw] = true
	local t = T()
	local track = sw:FindFirstChild("Switch") or sw
	local knob = track:FindFirstChild("Knob")
	local function paint(instant)
		local on = sw:GetAttribute("Total_Toggle") == true
		local props = { BackgroundColor3 = on and t.palette.Primary or t.palette.SurfaceAlt }
		if instant then
			track.BackgroundColor3 = props.BackgroundColor3
			if knob then
				knob.Position = on and UDim2.new(1, -28, 0.5, 0) or UDim2.new(0, 4, 0.5, 0)
			end
		else
			tween(track, props, t.motion.fast)
			if knob then
				tween(knob, { Position = on and UDim2.new(1, -28, 0.5, 0) or UDim2.new(0, 4, 0.5, 0) }, t.motion.fast)
			end
		end
	end
	paint(true)
	sw:GetAttributeChangedSignal("Total_Toggle"):Connect(function()
		paint(false)
	end)
	sw.Activated:Connect(function()
		sw:SetAttribute("Total_Toggle", not (sw:GetAttribute("Total_Toggle") == true))
	end)
end

function UIKit.ItemCard(props)
	props = props or {}
	local t = T()
	local rarity = string.lower(tostring(props.rarity or "common"))
	local rc = t.rarity[rarity] or t.rarity.common
	local card = UIKit.Panel({ name = props.name or ("Item_" .. tostring(props.item or props.title or "Item")), size = props.size or UDim2.new(0, 160, 0, 200), parent = props.parent, alt = true, radius = t.radius.md, padding = t.spacing.sm, layout = "column", gap = t.spacing.xs, hAlign = Enum.HorizontalAlignment.Center, strokeColor = rc, strokeTransparency = 0.1, strokeThickness = 2 })
	card.LayoutOrder = props.order or 0
	card:SetAttribute("Total_Item", props.item or props.title or card.Name)
	card:SetAttribute("Total_Rarity", rarity)
	local art = UIKit.Panel({ name = "Art", size = UDim2.new(1, 0, 0.5, 0), parent = card, color = rc:Lerp(t.palette.Surface, 0.75), radius = t.radius.sm, stroke = false, padding = false, anchor = Vector2.new(), position = UDim2.new() })
	art:SetAttribute("Total_Derived", true)
	art.LayoutOrder = 0
	if props.icon and props.icon ~= "" then
		UIKit.Image({ name = "Icon", image = props.icon, size = UDim2.new(0.8, 0, 0.8, 0), position = UDim2.new(0.5, 0, 0.5, 0), anchor = Vector2.new(0.5, 0.5), parent = art })
	else
		UIKit.Label({ name = "Glyph", text = string.sub(tostring(props.title or "?"), 1, 1), role = "title", bold = true, align = Enum.TextXAlignment.Center, size = UDim2.new(1, 0, 1, 0), parent = art, color = rc }):SetAttribute("Total_Decorative", true)
	end
	if props.badge then
		local badge = UIKit.Panel({ name = "Badge", size = UDim2.new(0, 0, 0, 20), position = UDim2.new(0, 6, 0, 6), anchor = Vector2.new(), parent = art, color = rc, radius = 999, stroke = false, padding = 6 })
		badge.AutomaticSize = Enum.AutomaticSize.X
		UIKit.Label({ name = "Text", text = tostring(props.badge), role = "caption", bold = true, align = Enum.TextXAlignment.Center, size = UDim2.new(0, 0, 1, 0), parent = badge, color = UIKit.textOn(rc), maxSize = 12 }).AutomaticSize = Enum.AutomaticSize.X
	end
	UIKit.Label({ name = "Title", text = props.title or "Item", bold = true, align = Enum.TextXAlignment.Center, size = UDim2.new(1, 0, 0, 24), parent = card, order = 1, maxSize = 18 })
	if props.subtitle then
		UIKit.Label({ name = "Subtitle", text = props.subtitle, role = "caption", muted = true, align = Enum.TextXAlignment.Center, size = UDim2.new(1, 0, 0, 16), parent = card, order = 2 })
	end
	local priceText = props.price ~= nil and (tostring(props.price) .. (props.currency and (" " .. tostring(props.currency)) or "")) or (props.buttonText or "Select")
	local btn = UIKit.Button({ name = "Buy", text = priceText, size = UDim2.new(1, 0, 0, 36), parent = card, order = 3, action = props.action or "remote:Total_Shop_Buy", item = props.item or props.title, variant = props.variant or "primary", maxSize = 16 })
	btn:SetAttribute("Total_Value", props.price)
	return card, btn
end

function UIKit.Slot(props)
	props = props or {}
	local t = T()
	local rarity = string.lower(tostring(props.rarity or "common"))
	local rc = t.rarity[rarity] or t.rarity.common
	local slot = Instance.new("ImageButton")
	slot.Name = props.name or ("Slot" .. tostring(props.index or ""))
	slot.AutoButtonColor = false
	slot.BackgroundColor3 = t.palette.SurfaceAlt
	slot.BorderSizePixel = 0
	slot.Size = props.size or UDim2.new(0, 72, 0, 72)
	slot.Image = props.icon or ""
	slot.ScaleType = Enum.ScaleType.Fit
	slot.LayoutOrder = props.order or props.index or 0
	slot.Selectable = true
	slot:SetAttribute("Total_BaseColor", slot.BackgroundColor3)
	slot:SetAttribute("Total_Item", props.item or "")
	slot:SetAttribute("Total_Action", props.action or ("toggle:" .. (props.detail or "Detail")))
	UIKit.corner(slot, t.radius.sm)
	UIKit.stroke(slot, (props.item and props.item ~= "") and rc or t.palette.Stroke, 2, (props.item and props.item ~= "") and 0.1 or 0.7)
	UIKit.padding(slot, 8)
	if props.count and tonumber(props.count) and tonumber(props.count) > 1 then
		local c = UIKit.Label({ name = "Count", text = tostring(props.count), role = "caption", bold = true, align = Enum.TextXAlignment.Right, size = UDim2.new(1, 0, 0, 16), position = UDim2.new(0, 0, 1, -16), parent = slot, maxSize = 13 })
		c.TextStrokeTransparency = 0.5
	end
	if props.hotkey then
		UIKit.Label({ name = "Hotkey", text = tostring(props.hotkey), role = "caption", muted = true, size = UDim2.new(0, 20, 0, 14), position = UDim2.new(0, 0, 0, 0), parent = slot, maxSize = 12 })
	end
	slot.Parent = props.parent
	UIKit.wireButton(slot)
	return slot
end

function UIKit.Tabs(props)
	props = props or {}
	local t = T()
	local names = props.tabs or { "Tab 1", "Tab 2" }
	local vertical = props.vertical == true
	local root = Instance.new("Frame")
	root.Name = props.name or "Tabs"
	root.BackgroundTransparency = 1
	root.Size = props.size or UDim2.new(1, 0, 1, 0)
	root.Position = props.position or UDim2.new()
	root.AnchorPoint = props.anchor or Vector2.new()
	root.LayoutOrder = props.order or 0
	root:SetAttribute("Total_Tabs", true)
	local barSize = vertical and UDim2.new(0, props.barSize or 170, 1, 0) or UDim2.new(1, 0, 0, props.barSize or 44)
	local bar = UIKit.Panel({ name = "TabBar", size = barSize, position = UDim2.new(), anchor = Vector2.new(), parent = root, transparency = 1, stroke = false, radius = false, padding = false, layout = vertical and "column" or "row", gap = t.spacing.xs })
	local pages = Instance.new("Frame")
	pages.Name = "Pages"
	pages.BackgroundTransparency = 1
	if vertical then
		pages.Size = UDim2.new(1, -((props.barSize or 170) + t.spacing.md), 1, 0)
		pages.Position = UDim2.new(0, (props.barSize or 170) + t.spacing.md, 0, 0)
	else
		pages.Size = UDim2.new(1, 0, 1, -((props.barSize or 44) + t.spacing.sm))
		pages.Position = UDim2.new(0, 0, 0, (props.barSize or 44) + t.spacing.sm)
	end
	pages.Parent = root
	local pageFrames = {}
	for i, nm in ipairs(names) do
		local btn = UIKit.Button({ name = "Tab_" .. tostring(nm), text = tostring(nm), variant = (i == 1) and "primary" or "ghost", size = vertical and UDim2.new(1, 0, 0, 40) or UDim2.new(0, math.max(90, 12 * #tostring(nm) + 24), 1, 0), parent = bar, order = i, maxSize = 16 })
		btn:SetAttribute("Total_Tab", tostring(nm))
		local page = Instance.new("Frame")
		page.Name = "Page_" .. tostring(nm)
		page.BackgroundTransparency = 1
		page.Size = UDim2.new(1, 0, 1, 0)
		page.Visible = (i == 1)
		page:SetAttribute("Total_Page", tostring(nm))
		page.Parent = pages
		pageFrames[tostring(nm)] = page
	end
	UIKit.bindTabs(root)
	root.Parent = props.parent
	return root, pages, pageFrames
end

function UIKit.bindTabs(root)
	if tabsSet[root] then
		return
	end
	tabsSet[root] = true
	local t = T()
	local bar = root:FindFirstChild("TabBar")
	local pages = root:FindFirstChild("Pages")
	if not (bar and pages) then
		return
	end
	local function select(name)
		for _, b in ipairs(bar:GetChildren()) do
			if b:IsA("GuiButton") and b:GetAttribute("Total_Tab") then
				local on = b:GetAttribute("Total_Tab") == name
				local col = on and t.palette.Primary or t.palette.SurfaceAlt
				b:SetAttribute("Total_BaseColor", col)
				tween(b, { BackgroundColor3 = col, BackgroundTransparency = on and 0 or 0.25 }, t.motion.fast)
				local lbl = b:FindFirstChild("Label")
				if lbl and lbl:IsA("TextLabel") then
					lbl.TextColor3 = UIKit.textOn(col)
				end
			end
		end
		for _, p in ipairs(pages:GetChildren()) do
			if p:IsA("GuiObject") and p:GetAttribute("Total_Page") then
				p.Visible = (p:GetAttribute("Total_Page") == name)
			end
		end
		root:SetAttribute("Total_ActiveTab", name)
	end
	for _, b in ipairs(bar:GetChildren()) do
		if b:IsA("GuiButton") and b:GetAttribute("Total_Tab") then
			b.Activated:Connect(function()
				select(b:GetAttribute("Total_Tab"))
			end)
		end
	end
	if root:GetAttribute("Total_ActiveTab") == nil then
		for _, b in ipairs(bar:GetChildren()) do
			if b:IsA("GuiButton") and b:GetAttribute("Total_Tab") then
				root:SetAttribute("Total_ActiveTab", b:GetAttribute("Total_Tab"))
				break
			end
		end
	end
end

function UIKit.Toast(props)
	props = props or {}
	local t = T()
	local kind = props.kind or "info"
	local accent = t.palette.Primary
	if kind == "success" then
		accent = t.palette.Success
	elseif kind == "error" or kind == "danger" then
		accent = t.palette.Danger
	elseif kind == "warning" then
		accent = t.palette.Warning
	end
	local toast = UIKit.Panel({ name = "Toast", size = UDim2.new(1, 0, 0, 56), parent = props.parent, alt = true, radius = t.radius.md, padding = t.spacing.sm, layout = "row", gap = t.spacing.sm, vAlign = Enum.VerticalAlignment.Center, anchor = Vector2.new(), position = UDim2.new() })
	toast.LayoutOrder = -math.floor(os.clock() * 1000)
	local barAccent = UIKit.Panel({ name = "Accent", size = UDim2.new(0, 6, 1, 0), parent = toast, color = accent, radius = 999, stroke = false, padding = false, anchor = Vector2.new(), position = UDim2.new() })
	barAccent.LayoutOrder = 0
	UIKit.Label({ name = "Text", text = props.text or "", size = UDim2.new(1, -20, 1, 0), parent = toast, order = 1, maxSize = 16 })
	toast.BackgroundTransparency = 1
	tween(toast, { BackgroundTransparency = 0 }, t.motion.normal)
	task.delay(props.duration or 3.5, function()
		if toast.Parent then
			local tw = tween(toast, { BackgroundTransparency = 1 }, t.motion.slow)
			for _, d in ipairs(toast:GetDescendants()) do
				if d:IsA("TextLabel") then
					tween(d, { TextTransparency = 1 }, t.motion.slow)
				elseif d:IsA("Frame") then
					tween(d, { BackgroundTransparency = 1 }, t.motion.slow)
				elseif d:IsA("UIStroke") then
					tween(d, { Transparency = 1 }, t.motion.slow)
				end
			end
			tw.Completed:Wait()
			toast:Destroy()
		end
	end)
	return toast
end

-- Re-bind runtime behaviour on a whole tree (used by Total_Controller after clone / respawn).
function UIKit.bindAll(root)
	local function bind(d)
		if d:IsA("GuiButton") then
			UIKit.wireButton(d)
			if d:GetAttribute("Total_Toggle") ~= nil then
				UIKit.bindToggle(d)
			end
		elseif d:IsA("GuiObject") then
			if d:GetAttribute("Total_Progress") ~= nil then
				UIKit.bindProgress(d)
			end
			if d:GetAttribute("Total_Tabs") then
				UIKit.bindTabs(d)
			end
		end
	end
	bind(root)
	for _, d in ipairs(root:GetDescendants()) do
		bind(d)
	end
end

function UIKit.setWindowOpen(win, open, instant)
	local t = T()
	local anim = win:FindFirstChild("Total_Anim")
	if not anim then
		anim = Instance.new("UIScale")
		anim.Name = "Total_Anim"
		anim.Parent = win
	end
	if open then
		win.Visible = true
		if instant then
			anim.Scale = 1
		else
			anim.Scale = 0.92
			tween(anim, { Scale = 1 }, t.motion.normal, "Back")
		end
	else
		if instant then
			win.Visible = false
		else
			local tw = tween(anim, { Scale = 0.92 }, t.motion.fast)
			tw.Completed:Connect(function()
				if anim.Scale <= 0.93 then
					win.Visible = false
					anim.Scale = 1
				end
			end)
		end
	end
	win:SetAttribute("Total_Open", open and true or false)
end

return UIKit
`;

  const RESPONSIVE_SRC = `-- TotalScript Responsive (generated by design_kit_install, v${KIT_VERSION}).
-- Generated screens already use scale-based sizes measured on a 1280x720
-- canvas, so they shrink and grow with the viewport by construction. This
-- module handles what scale alone cannot: safe-area insets, touch-size
-- targets, text floors on tiny screens, and a px() helper for scripts.
local UserInputService = game:GetService("UserInputService")
local GuiService = game:GetService("GuiService")

local Responsive = {}
Responsive.BASE = Vector2.new(1280, 720)

function Responsive.viewport()
	local cam = workspace.CurrentCamera
	if cam then
		return cam.ViewportSize
	end
	return Responsive.BASE
end

function Responsive.factor()
	local vp = Responsive.viewport()
	return math.min(vp.X / Responsive.BASE.X, vp.Y / Responsive.BASE.Y)
end

function Responsive.px(n)
	return n * Responsive.factor()
end

function Responsive.isTouch()
	return UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled
end

function Responsive.isGamepad()
	return UserInputService.GamepadEnabled and not UserInputService.KeyboardEnabled and not UserInputService.TouchEnabled
end

local function insetPadding(root)
	if not root:IsA("GuiObject") then
		return
	end
	local okI, topLeft = pcall(function()
		return GuiService:GetGuiInset()
	end)
	local top = (okI and topLeft and topLeft.Y) or 36
	local anchoredTop = root.AnchorPoint.Y <= 0.01 and root.Position.Y.Scale <= 0.02 and root.Position.Y.Offset < top
	if anchoredTop and root:GetAttribute("Total_SafeTop") == nil then
		root:SetAttribute("Total_SafeTop", true)
		root.Position = root.Position + UDim2.new(0, 0, 0, top)
	end
end

local function touchTargets(root, minPx)
	for _, d in ipairs(root:GetDescendants()) do
		if d:IsA("GuiButton") then
			local c = d:FindFirstChildOfClass("UISizeConstraint")
			if not c then
				c = Instance.new("UISizeConstraint")
				c.Parent = d
			end
			c.MinSize = Vector2.new(math.max(c.MinSize.X, minPx), math.max(c.MinSize.Y, minPx))
		end
	end
end

local function textFloors(root, minSize)
	for _, d in ipairs(root:GetDescendants()) do
		if (d:IsA("TextLabel") or d:IsA("TextButton") or d:IsA("TextBox")) and d.TextScaled then
			local c = d:FindFirstChildOfClass("UITextSizeConstraint")
			if not c then
				c = Instance.new("UITextSizeConstraint")
				c.MaxTextSize = math.max(minSize, d.TextSize > 0 and d.TextSize or 18)
				c.Parent = d
			end
			c.MinTextSize = math.max(c.MinTextSize, minSize)
		end
	end
end

function Responsive.attach(screenGui, opts)
	opts = opts or {}
	local function apply()
		local touch = Responsive.isTouch()
		for _, root in ipairs(screenGui:GetChildren()) do
			if root:IsA("GuiObject") then
				if screenGui.IgnoreGuiInset then
					insetPadding(root)
				end
				touchTargets(root, touch and (opts.touchMin or 44) or (opts.mouseMin or 28))
				textFloors(root, touch and (opts.textMinTouch or 12) or (opts.textMin or 10))
			end
		end
		screenGui:SetAttribute("Total_Touch", touch)
		screenGui:SetAttribute("Total_Gamepad", Responsive.isGamepad())
		screenGui:SetAttribute("Total_Factor", Responsive.factor())
	end
	apply()
	local cam = workspace.CurrentCamera
	if cam then
		cam:GetPropertyChangedSignal("ViewportSize"):Connect(apply)
	end
	UserInputService.LastInputTypeChanged:Connect(apply)
	return apply
end

return Responsive
`;

  // One generic LocalScript per generated ScreenGui. It never contains screen-
  // specific code: everything is attribute driven (Total_Action, Total_Window,
  // Total_OpenKey, Total_StartHidden, Total_Progress, Total_Toggle, Total_Tabs, Total_Typewriter).
  const CONTROLLER_SRC = `-- Total_Controller (generated by TotalScript design pack v${KIT_VERSION}). Generic runtime for a generated ScreenGui:
-- hover/press states, open/close tweens, Total_Action buttons, keybind, gamepad back button, progress/toggle/tab bindings.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")
local GuiService = game:GetService("GuiService")
local TweenService = game:GetService("TweenService")

local gui = script.Parent
while gui and not gui:IsA("LayerCollector") do
	gui = gui.Parent
end
if not gui then
	return
end
local design = ReplicatedStorage:WaitForChild("Total_Design", 10)
local UIKit = design and require(design:WaitForChild("UIKit"))
local Responsive = design and require(design:WaitForChild("Responsive"))
if not UIKit then
	warn("[Total_Controller] ReplicatedStorage.Total_Design.UIKit missing - run design_kit_install")
	return
end
if Responsive then
	Responsive.attach(gui)
end
local T = UIKit.tokens()

local function windows()
	local out = {}
	for _, c in ipairs(gui:GetDescendants()) do
		if c:IsA("GuiObject") and c:GetAttribute("Total_Window") then
			out[#out + 1] = c
		end
	end
	return out
end

local function windowOf(inst)
	local n = inst
	while n and n ~= gui do
		if n:IsA("GuiObject") and n:GetAttribute("Total_Window") then
			return n
		end
		n = n.Parent
	end
	return nil
end

local function toggleTarget(name)
	local el = gui:FindFirstChild(name, true)
	if el and el:IsA("GuiObject") then
		if el:GetAttribute("Total_Window") then
			UIKit.setWindowOpen(el, not el.Visible)
		else
			el.Visible = not el.Visible
		end
		return true
	end
	local pg = Players.LocalPlayer and Players.LocalPlayer:FindFirstChildOfClass("PlayerGui")
	local other = pg and pg:FindFirstChild(name)
	if other and other:IsA("LayerCollector") then
		local wins = {}
		for _, c in ipairs(other:GetDescendants()) do
			if c:IsA("GuiObject") and c:GetAttribute("Total_Window") then
				wins[#wins + 1] = c
			end
		end
		if #wins > 0 then
			for _, w in ipairs(wins) do
				UIKit.setWindowOpen(w, not w.Visible)
			end
		else
			other.Enabled = not other.Enabled
		end
		return true
	end
	return false
end

local function remoteNamed(name)
	local remotes = ReplicatedStorage:FindFirstChild("Remotes")
	return (remotes and remotes:FindFirstChild(name)) or ReplicatedStorage:FindFirstChild(name, true)
end

local function runAction(btn)
	local act = btn:GetAttribute("Total_Action")
	if type(act) ~= "string" or act == "" then
		return
	end
	if act == "close" then
		local win = windowOf(btn)
		if win then
			UIKit.setWindowOpen(win, false)
		else
			gui.Enabled = false
		end
	elseif string.sub(act, 1, 7) == "toggle:" then
		if not toggleTarget(string.sub(act, 8)) then
			warn("[Total_Controller] nothing named " .. string.sub(act, 8) .. " to toggle")
		end
	elseif string.sub(act, 1, 5) == "open:" then
		local el = gui:FindFirstChild(string.sub(act, 6), true)
		if el and el:IsA("GuiObject") then
			if el:GetAttribute("Total_Window") then
				UIKit.setWindowOpen(el, true)
			else
				el.Visible = true
			end
		end
	elseif string.sub(act, 1, 7) == "remote:" then
		local name = string.sub(act, 8)
		local r = remoteNamed(name)
		local payload = { item = btn:GetAttribute("Total_Item"), value = btn:GetAttribute("Total_Value"), button = btn.Name }
		if r and r:IsA("RemoteEvent") then
			r:FireServer(payload)
		elseif r and r:IsA("RemoteFunction") then
			task.spawn(function()
				local okI, res = pcall(r.InvokeServer, r, payload)
				if okI and type(res) == "table" and res.message then
					local stack = gui:FindFirstChild("Toasts", true)
					if stack then
						UIKit.Toast({ parent = stack, text = tostring(res.message), kind = res.ok == false and "error" or "success" })
					end
				elseif not okI then
					warn("[Total_Controller] " .. name .. " failed: " .. tostring(res))
				end
			end)
		elseif r and r:IsA("BindableEvent") then
			r:Fire(payload)
		else
			warn("[Total_Controller] remote not found: " .. name)
		end
	elseif string.sub(act, 1, 6) == "print:" then
		print(string.sub(act, 7))
	elseif act == "print" then
		print("[Total_Controller] " .. btn:GetFullName() .. " clicked")
	end
end

local typewriterSet = setmetatable({}, { __mode = "k" })
local actionSet = setmetatable({}, { __mode = "k" })

local function typewriter(label)
	if typewriterSet[label] then
		return
	end
	typewriterSet[label] = true
	local function play()
		local total = utf8.len(label.ContentText)
		if not total or total == 0 then
			total = utf8.len(label.Text) or #label.Text
		end
		label.MaxVisibleGraphemes = 0
		local cps = tonumber(label:GetAttribute("Total_Typewriter")) or 40
		local tw = TweenService:Create(label, TweenInfo.new(math.max(0.1, total / cps), Enum.EasingStyle.Linear), { MaxVisibleGraphemes = total })
		tw:Play()
	end
	label:GetPropertyChangedSignal("Text"):Connect(play)
	play()
end

local function wire(d)
	if d:IsA("GuiButton") then
		UIKit.wireButton(d)
		if not actionSet[d] then
			actionSet[d] = true
			d.Activated:Connect(function()
				runAction(d)
			end)
		end
	end
	if (d:IsA("TextLabel") or d:IsA("TextButton")) and d:GetAttribute("Total_Typewriter") then
		typewriter(d)
	end
end

UIKit.bindAll(gui)
for _, d in ipairs(gui:GetDescendants()) do
	wire(d)
end
gui.DescendantAdded:Connect(function(d)
	task.defer(function()
		wire(d)
		if d:IsA("GuiObject") then
			UIKit.bindAll(d)
		end
	end)
end)

for _, w in ipairs(windows()) do
	if w:GetAttribute("Total_StartHidden") then
		UIKit.setWindowOpen(w, false, true)
	end
end

local keyName = gui:GetAttribute("Total_OpenKey")
UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end
	if keyName and input.KeyCode.Name == keyName then
		for _, w in ipairs(windows()) do
			UIKit.setWindowOpen(w, not w.Visible)
		end
	elseif input.KeyCode == Enum.KeyCode.ButtonB then
		for _, w in ipairs(windows()) do
			if w.Visible and w:GetAttribute("Total_StartHidden") then
				UIKit.setWindowOpen(w, false)
			end
		end
	end
end)

-- Controller focus: when a window opens on a gamepad, select its first button.
for _, w in ipairs(windows()) do
	w:GetPropertyChangedSignal("Visible"):Connect(function()
		if w.Visible and gui:GetAttribute("Total_Gamepad") then
			for _, d in ipairs(w:GetDescendants()) do
				if d:IsA("GuiButton") and d.Selectable and d.Visible then
					GuiService.SelectedObject = d
					break
				end
			end
		elseif not w.Visible and GuiService.SelectedObject and GuiService.SelectedObject:IsDescendantOf(w) then
			GuiService.SelectedObject = nil
		end
	end)
end
`;

  // Screen-specific feeds (only written for the kinds that need live data).
  const HUD_FEED_SRC = `-- Total_HudFeed (generated). Binds currency pills (Total_Stat) to leaderstats and the health bar (Total_Progress) to the Humanoid.
local Players = game:GetService("Players")
local player = Players.LocalPlayer
local gui = script.Parent
while gui and not gui:IsA("LayerCollector") do
	gui = gui.Parent
end
if not gui then
	return
end

local function fmt(n)
	n = tonumber(n) or 0
	if n >= 1e9 then
		return string.format("%.1fB", n / 1e9)
	elseif n >= 1e6 then
		return string.format("%.1fM", n / 1e6)
	elseif n >= 1e4 then
		return string.format("%.1fK", n / 1e3)
	end
	return tostring(math.floor(n + 0.5))
end

local function bindStat(pill)
	local statName = pill:GetAttribute("Total_Stat")
	local value = pill:FindFirstChild("Value")
	if not (statName and value) then
		return
	end
	local function hook()
		local stats = player:FindFirstChild("leaderstats")
		local v = stats and stats:FindFirstChild(statName)
		if v and v:IsA("ValueBase") then
			value.Text = fmt(v.Value)
			v.Changed:Connect(function()
				value.Text = fmt(v.Value)
			end)
			return true
		end
		return false
	end
	if not hook() then
		player.ChildAdded:Connect(function(c)
			if c.Name == "leaderstats" then
				task.wait()
				hook()
			end
		end)
	end
end

for _, d in ipairs(gui:GetDescendants()) do
	if d:GetAttribute("Total_Stat") then
		bindStat(d)
	end
end

local function bindHealth(bar)
	local function onChar(char)
		local hum = char:WaitForChild("Humanoid", 10)
		if not hum then
			return
		end
		local function upd()
			bar:SetAttribute("Total_Progress", hum.MaxHealth > 0 and hum.Health / hum.MaxHealth or 0)
			local label = bar:FindFirstChild("Label")
			if label and label:IsA("TextLabel") then
				bar:SetAttribute("Total_LabelLocked", true)
				label.Text = math.floor(hum.Health + 0.5) .. " / " .. math.floor(hum.MaxHealth + 0.5)
			end
		end
		hum.HealthChanged:Connect(upd)
		hum:GetPropertyChangedSignal("MaxHealth"):Connect(upd)
		upd()
	end
	if player.Character then
		task.spawn(onChar, player.Character)
	end
	player.CharacterAdded:Connect(onChar)
end

local health = gui:FindFirstChild("Health", true)
if health and health:GetAttribute("Total_Progress") ~= nil then
	bindHealth(health)
end
`;

  const LEADERBOARD_FEED_SRC = `-- Total_LeaderboardFeed (generated). Fills the rows list from every player's leaderstats.<stat>, refreshed every 2 s.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local gui = script.Parent
while gui and not gui:IsA("LayerCollector") do
	gui = gui.Parent
end
if not gui then
	return
end
local design = ReplicatedStorage:WaitForChild("Total_Design", 10)
local UIKit = design and require(design:WaitForChild("UIKit"))
local list = gui:FindFirstChild("Rows", true)
if not (UIKit and list) then
	return
end
local statName = gui:GetAttribute("Total_Stat") or "Coins"
local T = UIKit.tokens()

local function refresh()
	local entries = {}
	for _, p in ipairs(Players:GetPlayers()) do
		local stats = p:FindFirstChild("leaderstats")
		local v = stats and stats:FindFirstChild(statName)
		entries[#entries + 1] = { name = p.DisplayName, value = (v and tonumber(v.Value)) or 0, me = p == Players.LocalPlayer }
	end
	table.sort(entries, function(a, b)
		return a.value > b.value
	end)
	for _, c in ipairs(list:GetChildren()) do
		if c:IsA("GuiObject") then
			c:Destroy()
		end
	end
	for i, e in ipairs(entries) do
		if i > 10 then
			break
		end
		local row = UIKit.Row({ name = "Row" .. i, size = UDim2.new(1, 0, 0, 36), parent = list, gap = T.spacing.sm, padding = T.spacing.sm })
		row.LayoutOrder = i
		row.BackgroundTransparency = e.me and 0 or 1
		row.BackgroundColor3 = T.palette.Primary:Lerp(T.palette.Surface, 0.6)
		UIKit.corner(row, T.radius.sm)
		UIKit.Label({ name = "Rank", text = "#" .. i, bold = true, size = UDim2.new(0, 36, 1, 0), parent = row, order = 0, maxSize = 16, color = i == 1 and T.palette.Secondary or T.palette.TextMuted })
		UIKit.Label({ name = "Name", text = e.name, size = UDim2.new(1, -120, 1, 0), parent = row, order = 1, maxSize = 16 })
		UIKit.Label({ name = "Value", text = tostring(e.value), bold = true, align = Enum.TextXAlignment.Right, size = UDim2.new(0, 76, 1, 0), parent = row, order = 2, maxSize = 16 })
	end
end

refresh()
while task.wait(2) do
	refresh()
end
`;

  const NOTIFY_FEED_SRC = `-- Total_NotifyFeed (generated). Server: ReplicatedStorage.Remotes.Total_Notify:FireClient(player, text, kind). Client: ReplicatedStorage.Total_Design.NotifyLocal:Fire(text, kind).
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local gui = script.Parent
while gui and not gui:IsA("LayerCollector") do
	gui = gui.Parent
end
if not gui then
	return
end
local design = ReplicatedStorage:WaitForChild("Total_Design", 10)
local UIKit = design and require(design:WaitForChild("UIKit"))
local stack = gui:FindFirstChild("Toasts", true)
if not (UIKit and stack) then
	return
end
local function show(text, kind, duration)
	UIKit.Toast({ parent = stack, text = tostring(text), kind = kind or "info", duration = tonumber(duration) or 3.5 })
end
local remotes = ReplicatedStorage:FindFirstChild("Remotes")
local remote = remotes and remotes:FindFirstChild("Total_Notify")
if remote and remote:IsA("RemoteEvent") then
	remote.OnClientEvent:Connect(show)
end
local localEv = design:FindFirstChild("NotifyLocal")
if localEv and localEv:IsA("BindableEvent") then
	localEv.Event:Connect(show)
end
`;

  const LOADING_SRC = `-- Total_Loading (generated, ReplicatedFirst). Replaces the default loading screen with the generated one, shows asset preload progress, fades out.
local ReplicatedFirst = game:GetService("ReplicatedFirst")
local ContentProvider = game:GetService("ContentProvider")
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")
local template = script.Parent:FindFirstChildOfClass("ScreenGui") or ReplicatedFirst:FindFirstChildOfClass("ScreenGui")
if not template then
	return
end
local gui = template:Clone()
gui.Enabled = true
gui.Parent = playerGui
pcall(function()
	ReplicatedFirst:RemoveDefaultLoadingScreen()
end)

local bar = gui:FindFirstChild("Progress", true)
local tip = gui:FindFirstChild("Tip", true)
local tips = {}
if tip and tip:GetAttribute("Total_Tips") then
	for s in string.gmatch(tip:GetAttribute("Total_Tips"), "[^|]+") do
		tips[#tips + 1] = s
	end
end

local function setProgress(v)
	if bar then
		bar:SetAttribute("Total_Progress", math.clamp(v, 0, 1))
		local fill = bar:FindFirstChild("Fill")
		if fill then
			fill.Size = UDim2.new(math.clamp(v, 0, 1), 0, 1, 0)
		end
		local label = bar:FindFirstChild("Label")
		if label and label:IsA("TextLabel") then
			label.Text = math.floor(v * 100 + 0.5) .. "%"
		end
	end
end

task.spawn(function()
	local i = 0
	while gui.Parent and #tips > 0 do
		i = i % #tips + 1
		tip.Text = tips[i]
		task.wait(3)
	end
end)

setProgress(0.05)
if not game:IsLoaded() then
	game.Loaded:Wait()
end
setProgress(0.4)
local assets = {}
for _, d in ipairs(workspace:GetDescendants()) do
	if d:IsA("MeshPart") or d:IsA("Decal") or d:IsA("Texture") or d:IsA("Sound") then
		assets[#assets + 1] = d
		if #assets >= 60 then
			break
		end
	end
end
local done = 0
ContentProvider:PreloadAsync(assets, function()
	done = done + 1
	setProgress(0.4 + 0.6 * (done / math.max(1, #assets)))
end)
setProgress(1)
task.wait(0.4)
for _, d in ipairs(gui:GetDescendants()) do
	if d:IsA("GuiObject") then
		TweenService:Create(d, TweenInfo.new(0.5), { BackgroundTransparency = 1 }):Play()
	end
	if d:IsA("TextLabel") then
		TweenService:Create(d, TweenInfo.new(0.5), { TextTransparency = 1 }):Play()
	end
	if d:IsA("UIStroke") then
		TweenService:Create(d, TweenInfo.new(0.5), { Transparency = 1 }):Play()
	end
end
task.wait(0.55)
gui:Destroy()
`;

  function shopServerSource(items) {
    const entries = (items || []).map((it) => "\t[" + q(String(it.item || it.id || it.name || it.title)) + "] = { price = " + nn(it.price, 0) + ", currency = " + q(String(it.currency || "Coins")) + " },").join("\n");
    return `-- Total_ShopServer (generated). Validates Total_Shop_Buy purchases against CATALOG and charges leaderstats.<currency>.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local remotes = ReplicatedStorage:FindFirstChild("Remotes") or Instance.new("Folder")
remotes.Name = "Remotes"
remotes.Parent = ReplicatedStorage
local buy = remotes:FindFirstChild("Total_Shop_Buy") or Instance.new("RemoteEvent")
buy.Name = "Total_Shop_Buy"
buy.Parent = remotes
local notify = remotes:FindFirstChild("Total_Notify") or Instance.new("RemoteEvent")
notify.Name = "Total_Notify"
notify.Parent = remotes

local CATALOG = {
${entries}
}

local lastBuy = {}

local function grant(player, id, entry)
	-- TODO: give the item: clone a Tool from ServerStorage, unlock a pet, set an attribute...
	player:SetAttribute("Owns_" .. id, true)
end

buy.OnServerEvent:Connect(function(player, payload)
	if type(payload) ~= "table" then
		return
	end
	local id = tostring(payload.item or "")
	local entry = CATALOG[id]
	if not entry then
		warn(("[Total_Shop] %s asked for unknown item %q"):format(player.Name, id))
		return
	end
	local now = os.clock()
	if lastBuy[player] and now - lastBuy[player] < 0.4 then
		return
	end
	lastBuy[player] = now
	local stats = player:FindFirstChild("leaderstats")
	local cur = stats and stats:FindFirstChild(entry.currency)
	if not (cur and cur:IsA("ValueBase")) then
		notify:FireClient(player, "No " .. entry.currency .. " stat yet", "error")
		return
	end
	if (tonumber(cur.Value) or 0) < entry.price then
		notify:FireClient(player, "Not enough " .. entry.currency, "error")
		return
	end
	cur.Value = cur.Value - entry.price
	grant(player, id, entry)
	notify:FireClient(player, "Bought " .. id .. "!", "success")
	print(("[Total_Shop] %s bought %s for %d %s"):format(player.Name, id, entry.price, entry.currency))
end)

Players.PlayerRemoving:Connect(function(p)
	lastBuy[p] = nil
end)
`;
  }

  function dailyServerSource(rewards) {
    const list = (rewards || []).map((r) => "\t" + nn(r, 0) + ",").join("\n");
    return `-- Total_DailyServer (generated). Total_Daily_Claim RemoteFunction: one claim per 20 h, streak advances day 1..N then wraps.
-- Persistence: DataStore "Total_DailyRewards" (key = UserId) with an in-memory cache; when Studio API access is
-- disabled or the store errors, the session falls back to memory and warns once.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")

local remotes = ReplicatedStorage:FindFirstChild("Remotes") or Instance.new("Folder")
remotes.Name = "Remotes"
remotes.Parent = ReplicatedStorage
local claim = remotes:FindFirstChild("Total_Daily_Claim") or Instance.new("RemoteFunction")
claim.Name = "Total_Daily_Claim"
claim.Parent = remotes

local REWARDS = {
${list}
}
local COOLDOWN = 20 * 3600
local CLAIMS = {}
local store = nil
local storeWarned = false
pcall(function()
	store = DataStoreService:GetDataStore("Total_DailyRewards")
end)

local function storeFail(err)
	if not storeWarned then
		storeWarned = true
		warn("[Total_DailyServer] DataStore unavailable, using session memory: " .. tostring(err))
	end
end

local function loadRec(player)
	local rec = CLAIMS[player.UserId]
	if rec then
		return rec
	end
	rec = { day = 0, last = 0 }
	if store then
		local okG, saved = pcall(store.GetAsync, store, tostring(player.UserId))
		if okG and type(saved) == "table" then
			rec.day = tonumber(saved.day) or 0
			rec.last = tonumber(saved.last) or 0
		elseif not okG then
			storeFail(saved)
		end
	end
	CLAIMS[player.UserId] = rec
	return rec
end

local function saveRec(player, rec)
	if not store then
		return
	end
	task.spawn(function()
		local okS, err = pcall(store.SetAsync, store, tostring(player.UserId), { day = rec.day, last = rec.last })
		if not okS then
			storeFail(err)
		end
	end)
end

claim.OnServerInvoke = function(player, payload)
	local rec = loadRec(player)
	local now = os.time()
	if now - rec.last < COOLDOWN then
		local left = COOLDOWN - (now - rec.last)
		return { ok = false, day = rec.day, message = ("Come back in %dh %02dm"):format(left // 3600, (left % 3600) // 60) }
	end
	if now - rec.last > COOLDOWN * 2.4 then
		rec.day = 0
	end
	rec.day = rec.day % #REWARDS + 1
	rec.last = now
	CLAIMS[player.UserId] = rec
	saveRec(player, rec)
	local amount = REWARDS[rec.day] or 0
	local stats = player:FindFirstChild("leaderstats")
	local coins = stats and stats:FindFirstChild("Coins")
	if coins and coins:IsA("ValueBase") then
		coins.Value = coins.Value + amount
	end
	player:SetAttribute("DailyDay", rec.day)
	return { ok = true, day = rec.day, reward = amount, message = ("Day %d reward: +%d"):format(rec.day, amount) }
end

Players.PlayerAdded:Connect(function(p)
	local rec = loadRec(p)
	p:SetAttribute("DailyDay", rec.day)
end)

Players.PlayerRemoving:Connect(function(p)
	local rec = CLAIMS[p.UserId]
	if rec and store then
		pcall(store.SetAsync, store, tostring(p.UserId), { day = rec.day, last = rec.last })
	end
	CLAIMS[p.UserId] = nil
end)
`;
  }

  const DAILY_CLIENT_SRC = `-- Total_DailyClient (generated). Highlights the current day card from the player's DailyDay attribute.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local player = Players.LocalPlayer
local gui = script.Parent
while gui and not gui:IsA("LayerCollector") do
	gui = gui.Parent
end
if not gui then
	return
end
local design = ReplicatedStorage:WaitForChild("Total_Design", 10)
local UIKit = design and require(design:WaitForChild("UIKit"))
if not UIKit then
	return
end
local T = UIKit.tokens()
local function paint()
	local day = tonumber(player:GetAttribute("DailyDay")) or 0
	for _, c in ipairs(gui:GetDescendants()) do
		local n = tonumber(c:GetAttribute("Total_Day"))
		if n then
			local stroke = c:FindFirstChildOfClass("UIStroke")
			local claimed = n <= day
			if stroke then
				stroke.Color = claimed and T.palette.Success or (n == day + 1 and T.palette.Primary or T.palette.Stroke)
				stroke.Transparency = (claimed or n == day + 1) and 0 or 0.6
			end
			local badge = c:FindFirstChild("State", true)
			if badge and badge:IsA("TextLabel") then
				badge.Text = claimed and "CLAIMED" or (n == day + 1 and "TODAY" or "")
			end
		end
	end
end
paint()
player:GetAttributeChangedSignal("DailyDay"):Connect(paint)
`;

  // ───────────────────────── LUAU HEAD (design-time helpers) ─────────────────────────
  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local ReplicatedStorage=game:GetService('ReplicatedStorage')",
    "local ReplicatedFirst=game:GetService('ReplicatedFirst')",
    "local ServerScriptService=game:GetService('ServerScriptService')",
    "local StarterGui=game:GetService('StarterGui')",
    "local StarterPlayer=game:GetService('StarterPlayer')",
    "local Players=game:GetService('Players')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local KIT_VERSION=" + q(KIT_VERSION),
    "local BASE_W,BASE_H=1280,720",
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end",
    "local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end if lp=='workspace' then return workspace end if lp=='startergui' then return StarterGui end if lp=='playergui' then local pl=Players:GetPlayers()[1] return pl and pl:FindFirstChildOfClass('PlayerGui') or StarterGui end local n=game for _,s in ipairs(string.split(p,'.')) do if s~='' then local nxt=n:FindFirstChild(s) if not nxt then for _,ch in ipairs(n:GetChildren()) do if ch.Name:lower()==s:lower() then nxt=ch break end end end if not nxt and n==game then local okS,svc=pcall(function() return game:GetService(s) end) if okS then nxt=svc end end if not nxt and n==game then nxt=StarterGui:FindFirstChild(s,true) or ReplicatedStorage:FindFirstChild(s,true) or ReplicatedFirst:FindFirstChild(s,true) end if not nxt then return nil end n=nxt end end return n end",
    "local function need(p,what) local i=resolve(p) if not i then error((what or 'instance')..' not found: '..tostring(p)) end return i end",
    "local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('TotalScript design') end) return okW and w or nil end",
    "local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end",
    "local function folder(parent,name) local f=parent:FindFirstChild(name) if not f then f=Instance.new('Folder') f.Name=name f.Parent=parent end return f end",
    "local function designFolder() return folder(ReplicatedStorage,'Total_Design') end",
    "local function writeModule(parent,name,src,force) local m=parent:FindFirstChild(name) if m and m:IsA('ModuleScript') then if force or m:GetAttribute('Total_Version')~=KIT_VERSION then m.Source=src m:SetAttribute('Total_Version',KIT_VERSION) return m,'updated' end return m,'kept' end if m then m:Destroy() end m=Instance.new('ModuleScript') m.Name=name m.Source=src m:SetAttribute('Total_Version',KIT_VERSION) m.Parent=parent return m,'created' end",
    "local function writeScript(class,parent,name,src,force) local s=parent:FindFirstChild(name) if s and s.ClassName==class then if force or s:GetAttribute('Total_Generated') then s.Source=src s:SetAttribute('Total_Generated',true) return s,'updated' end return s,'kept' end if s then s:Destroy() end s=Instance.new(class) s.Name=name s.Source=src s:SetAttribute('Total_Generated',true) s.Parent=parent return s,'created' end",
    "local UIKIT_SRC=" + q(UIKIT_SRC),
    "local RESPONSIVE_SRC=" + q(RESPONSIVE_SRC),
    "local CONTROLLER_SRC=" + q(CONTROLLER_SRC),
    "local DEFAULT_TOKENS_SRC=" + q(tokensModuleSource(DEFAULT_TOKENS)),
    "local DEFAULT_TOKENS_JSON=" + jj(DEFAULT_TOKENS),
    "local function ensureKit(force) local d=designFolder() local r={} local _,a=writeModule(d,'UIKit',UIKIT_SRC,force) r.UIKit=a local _2,b=writeModule(d,'Responsive',RESPONSIVE_SRC,force) r.Responsive=b if not d:FindFirstChild('Tokens') then writeModule(d,'Tokens',DEFAULT_TOKENS_SRC,true) r.Tokens='created' if d:GetAttribute('TokensJSON')==nil then d:SetAttribute('TokensJSON',DEFAULT_TOKENS_JSON) end else r.Tokens='kept' end if not d:FindFirstChild('NotifyLocal') then local be=Instance.new('BindableEvent') be.Name='NotifyLocal' be.Parent=d end return d,r end",
    "local function kit() local d=ensureKit(false) local m=d:FindFirstChild('UIKit') local okR,res=pcall(require,m) if okR and type(res)=='table' then pcall(function() res.tokens(true) end) return res end local f,err=loadstring(m.Source) if not f then error('UIKit failed to compile: '..tostring(err)) end local env=setmetatable({script=m},{__index=getfenv()}) setfenv(f,env) return f() end",
    "local function readTokens() local d=designFolder() local js=d:GetAttribute('TokensJSON') local okJ,t=pcall(function() return HttpService:JSONDecode(js) end) if okJ and type(t)=='table' then return t end return HttpService:JSONDecode(DEFAULT_TOKENS_JSON) end",
    "local function c3(arr) if typeof(arr)=='Color3' then return arr end if type(arr)=='table' and #arr>=3 then return Color3.fromRGB(tonumber(arr[1]) or 0,tonumber(arr[2]) or 0,tonumber(arr[3]) or 0) end if type(arr)=='string' then local h=arr:gsub('#','') if #h==6 then return Color3.fromRGB(tonumber(h:sub(1,2),16) or 0,tonumber(h:sub(3,4),16) or 0,tonumber(h:sub(5,6),16) or 0) end end return nil end",
    "local function hexOf(c) return string.format('#%02x%02x%02x',math.floor(c.R*255+0.5),math.floor(c.G*255+0.5),math.floor(c.B*255+0.5)) end",
    "local function lum(c) local function ch(v) if v<=0.03928 then return v/12.92 end return ((v+0.055)/1.055)^2.4 end return 0.2126*ch(c.R)+0.7152*ch(c.G)+0.0722*ch(c.B) end",
    "local function contrast(a,b) local la,lb=lum(a),lum(b) if la<lb then la,lb=lb,la end return (la+0.05)/(lb+0.05) end",
    "local function pxSize(g,pw,ph) return g.Size.X.Scale*pw+g.Size.X.Offset, g.Size.Y.Scale*ph+g.Size.Y.Offset end",
    "local function pxPos(g,pw,ph) local w,h=pxSize(g,pw,ph) return g.Position.X.Scale*pw+g.Position.X.Offset-g.AnchorPoint.X*w, g.Position.Y.Scale*ph+g.Position.Y.Offset-g.AnchorPoint.Y*h end",
    "local function screenGui(parentPath,name,opts) opts=opts or {} local parent=parentPath and resolve(parentPath) or StarterGui if not parent then parent=StarterGui end local sg=parent:FindFirstChild(name) if sg and not sg:IsA('ScreenGui') then sg:Destroy() sg=nil end if sg and opts.replace~=false then sg:Destroy() sg=nil end if not sg then sg=Instance.new('ScreenGui') sg.Name=name sg.ResetOnSpawn=false sg.IgnoreGuiInset=true sg.ZIndexBehavior=Enum.ZIndexBehavior.Sibling sg.Parent=parent end if opts.display_order then sg.DisplayOrder=tonumber(opts.display_order) or 0 end if opts.open_key then sg:SetAttribute('Total_OpenKey',tostring(opts.open_key)) end return sg end",
    "local function enumX(v) v=tostring(v or 'start'):lower() if v=='center' or v=='middle' then return Enum.HorizontalAlignment.Center end if v=='end' or v=='right' then return Enum.HorizontalAlignment.Right end return Enum.HorizontalAlignment.Left end",
    "local function enumY(v) v=tostring(v or 'start'):lower() if v=='center' or v=='middle' then return Enum.VerticalAlignment.Center end if v=='end' or v=='bottom' then return Enum.VerticalAlignment.Bottom end return Enum.VerticalAlignment.Top end",
    "local function textAlign(v) v=tostring(v or 'left'):lower() if v=='center' then return Enum.TextXAlignment.Center end if v=='right' then return Enum.TextXAlignment.Right end return Enum.TextXAlignment.Left end",
    // ---- declarative spec builder (px on a 1280x720 canvas -> scale sizes) ----
    [
      "local DEFAULT_PX={Panel={400,300},Window={720,480},Button={200,48},IconButton={44,44},Label={'fill',30},Title={'fill',56},Image={120,120},ItemCard={160,200},Slot={72,72},CurrencyPill={150,40},ProgressBar={'fill',22},Toggle={'fill',44},Input={'fill',44},Tabs={'fill','fill'},ScrollList={'fill','fill'},Row={'fill',48},Column={'fill','fill'},Grid={'fill','fill'},Divider={'fill',2},Spacer={12,12},Toasts={340,400}}",
      "local ANCHORS={center={0.5,0.5},top={0.5,0},bottom={0.5,1},left={0,0.5},right={1,0.5},['top-left']={0,0},['top-right']={1,0},['bottom-left']={0,1},['bottom-right']={1,1},topleft={0,0},topright={1,0},bottomleft={0,1},bottomright={1,1}}",
      "local function dim(v,total,fallback) if v==nil then return nil end if type(v)=='number' then return v end local s=tostring(v) if s=='fill' or s=='100%' then return total end local pct=s:match('^(%-?[%d%.]+)%%$') if pct then return total*(tonumber(pct) or 0)/100 end local n=tonumber(s) if n then return n end return fallback end",
      "local function nodeSize(node,kind,pw,ph) local d=DEFAULT_PX[kind] or {200,48} local function dimH(v,fb) if ph>0 then return dim(v,ph,fb) end if type(v)=='number' then return v end if v=='fill' or v=='100%' then return fb end return dim(v,fb,fb) end local w,h if type(node.size)=='table' then w,h=dim(node.size[1],pw,d[1]),dimH(node.size[2],d[2]) elseif node.size=='fill' then w,h=pw,(ph>0 and ph or d[2]) end w=dim(node.width,pw,d[1]) or w or d[1] h=dimH(node.height,d[2]) or h or d[2] if type(w)~='number' then w=dim(w,pw,200) or 200 end if type(h)~='number' then h=(ph>0 and dim(h,ph,48)) or 48 end if w>pw*1.0001 then w=pw end if ph>0 and h>ph*1.0001 then h=ph end return w,h end",
      "local function nodeUDim(w,h,pw,ph) if ph<=0 then return UDim2.new(pw>0 and w/pw or 0,0,0,h) end return UDim2.new(pw>0 and w/pw or 0,0,h/ph,0) end",
      "local function applyPosition(inst,node,w,h,pw,ph,inLayout) if inLayout then return end local a=node.anchor if type(a)=='string' and ANCHORS[a:lower()] then local ap=ANCHORS[a:lower()] local mx=tonumber(node.margin) or 0 local my=tonumber(node.margin) or 0 if type(node.margin)=='table' then mx=tonumber(node.margin[1]) or 0 my=tonumber(node.margin[2]) or mx end inst.AnchorPoint=Vector2.new(ap[1],ap[2]) local ox=(ap[1]==0 and mx) or (ap[1]==1 and -mx) or 0 local oy=(ap[2]==0 and my) or (ap[2]==1 and -my) or 0 inst.Position=UDim2.new(ap[1],0,ap[2],0)+UDim2.new(pw>0 and ox/pw or 0,0,ph>0 and oy/ph or 0,0) return end if type(node.position)=='table' then local x=dim(node.position[1],pw,0) or 0 local y=dim(node.position[2],ph,0) or 0 local apx,apy=0,0 if type(a)=='table' then apx,apy=tonumber(a[1]) or 0,tonumber(a[2]) or 0 end inst.AnchorPoint=Vector2.new(apx,apy) inst.Position=UDim2.new(pw>0 and x/pw or 0,0,ph>0 and y/ph or 0,0) return end if node.parentIsRoot then inst.AnchorPoint=Vector2.new(0.5,0.5) inst.Position=UDim2.new(0.5,0,0.5,0) end end",
      "local function applyProps(inst,props) if type(props)~='table' then return end for k,v in pairs(props) do pcall(function() if type(v)=='table' and #v==3 and tonumber(v[1]) then inst[k]=Color3.fromRGB(tonumber(v[1]) or 0,tonumber(v[2]) or 0,tonumber(v[3]) or 0) elseif type(v)=='table' and #v==4 then inst[k]=UDim2.new(tonumber(v[1]) or 0,tonumber(v[2]) or 0,tonumber(v[3]) or 0,tonumber(v[4]) or 0) elseif type(v)=='table' and #v==2 then inst[k]=Vector2.new(tonumber(v[1]) or 0,tonumber(v[2]) or 0) elseif type(v)=='string' and v:sub(1,5)=='Enum.' then local parts=string.split(v,'.') inst[k]=Enum[parts[2]][parts[3]] elseif type(v)=='string' and k=='Font' then inst.Font=Enum.Font[v] else inst[k]=v end end) end end",
      "local function buildNode(K,T,node,parent,pw,ph,inLayout,order,created)",
      " if type(node)~='table' then return nil end",
      " local kind=tostring(node.kind or node.type or 'Panel')",
      " local w,h=nodeSize(node,kind,pw,ph)",
      " local size=nodeUDim(w,h,pw,ph)",
      " local gap=tonumber(node.gap) or T.spacing.sm",
      " local pad=node.padding",
      " if pad==nil and (kind=='Panel' or kind=='Window') then pad=T.spacing.md end",
      " local inst,content",
      " local childW,childH=nil,nil",
      " local common={name=node.name,size=size,parent=parent,order=order,text=node.text,image=node.image or node.icon,action=node.action,item=node.item,variant=node.variant,color=c3(node.color),gap=gap,padding=pad,layout=node.layout,hAlign=enumX(node.align),vAlign=enumY(node.valign),align=textAlign(node.align),role=node.role,bold=node.bold,muted=node.muted,anchor=Vector2.new(),position=UDim2.new()}",
      " if kind=='Panel' then common.alt=node.alt==true common.transparency=tonumber(node.transparency) common.radius=node.radius common.stroke=node.stroke~=false common.gradient=c3(node.gradient) common.clip=node.clip==true inst,content=K.Panel(common)",
      " elseif kind=='Window' then common.title=node.title or node.text common.closable=node.closable~=false common.icon=node.icon inst,content=K.Window(common) if node.start_hidden or node.hidden then inst:SetAttribute('Total_StartHidden',true) end",
      " elseif kind=='Row' then common.padding=node.padding common.transparency=tonumber(node.transparency) if node.color then common.transparency=0 end inst,content=K.Row(common)",
      " elseif kind=='Column' then common.padding=node.padding common.transparency=tonumber(node.transparency) if node.color then common.transparency=0 end inst,content=K.Column(common)",
      " elseif kind=='Grid' then local cols=tonumber(node.columns) local cw,chh if type(node.cell)=='table' then cw,chh=dim(node.cell[1],w,120),dim(node.cell[2],(ph>0 and h or 720),120) end if cols and cols>0 then local padPx=tonumber(node.padding) or 0 cw=(w-padPx*2-gap*(cols-1))/cols chh=chh or (tonumber(node.cell_height) or cw) end cw=cw or 120 chh=chh or cw common.cell=UDim2.new(w>0 and cw/w or 0,0,0,chh) common.cellAspect=cw/math.max(1,chh) common.padding=node.padding inst,content=K.Grid(common) childW,childH=cw,chh",
      " elseif kind=='ScrollList' then common.direction=node.direction or 'column' common.grid=node.grid==true common.transparency=tonumber(node.transparency) if node.color then common.transparency=0 end if node.grid then local cols=tonumber(node.columns) or 4 local cw=(w-gap*(cols-1)-12)/cols local chh=tonumber(node.cell_height) or cw common.cell=UDim2.new(w>0 and cw/w or 0,0,0,chh) common.cellAspect=cw/math.max(1,chh) childW,childH=cw,chh else childW,childH=w-12,0 end inst,content=K.ScrollList(common)",
      " elseif kind=='Button' then common.icon=node.icon common.maxSize=tonumber(node.max_text) common.outline=node.outline==true inst=K.Button(common)",
      " elseif kind=='IconButton' then common.text=node.glyph or node.text common.image=node.image or node.icon common.outline=node.outline==true common.transparency=tonumber(node.transparency) inst=K.IconButton(common)",
      " elseif kind=='Label' or kind=='Title' then if kind=='Title' and not node.role then common.role='title' end common.color=c3(node.color) common.maxSize=tonumber(node.max_text) common.strokeText=node.stroke_text==true inst=K.Label(common) if node.typewriter then inst:SetAttribute('Total_Typewriter',tonumber(node.typewriter) or 40) end",
      " elseif kind=='Image' then common.radius=tonumber(node.radius) if node.fit=='crop' then common.scaleType=Enum.ScaleType.Crop elseif node.fit=='stretch' then common.scaleType=Enum.ScaleType.Stretch end inst=K.Image(common)",
      " elseif kind=='ItemCard' then common.title=node.title or node.text common.subtitle=node.subtitle common.price=node.price common.currency=node.currency common.rarity=node.rarity common.icon=node.icon or node.image common.badge=node.badge common.buttonText=node.button_text inst=K.ItemCard(common)",
      " elseif kind=='Slot' then common.index=tonumber(node.index) common.rarity=node.rarity common.icon=node.icon or node.image common.count=node.count common.hotkey=node.hotkey common.detail=node.detail inst=K.Slot(common)",
      " elseif kind=='CurrencyPill' then common.value=node.value common.stat=node.stat common.icon=node.icon or node.image common.action=node.action inst=K.CurrencyPill(common)",
      " elseif kind=='ProgressBar' then common.value=tonumber(node.value) or 0 common.label=node.label common.stroke=node.stroke~=false inst=K.ProgressBar(common)",
      " elseif kind=='Toggle' then common.value=node.value==true common.setting=node.setting inst=K.Toggle(common)",
      " elseif kind=='Input' then common.placeholder=node.placeholder inst=K.Input(common)",
      " elseif kind=='Tabs' then common.tabs=node.tabs or {'Tab 1','Tab 2'} common.vertical=node.vertical==true common.barSize=tonumber(node.bar_size) local pages,pageFrames inst,pages,pageFrames=K.Tabs(common) if type(node.pages)=='table' then local names=common.tabs local barPx=common.barSize or (common.vertical and 170 or 44) local ppw,pph=w,h if common.vertical then ppw=w-barPx-T.spacing.md else pph=h-barPx-T.spacing.sm end for i,pageNode in ipairs(node.pages) do local nm=tostring(names[i] or ('Tab '..i)) local pf=pageFrames[nm] if pf and type(pageNode)=='table' then if pageNode.layout then K.layout(pf,pageNode.layout,tonumber(pageNode.gap) or gap,enumX(pageNode.align),enumY(pageNode.valign)) end if pageNode.padding then K.padding(pf,tonumber(pageNode.padding)) end for j,ch in ipairs(pageNode.children or {}) do buildNode(K,T,ch,pf,ppw,pph,pageNode.layout~=nil,j,created) end end end end content=nil",
      " elseif kind=='Divider' then common.transparency=tonumber(node.transparency) inst=K.Divider(common)",
      " elseif kind=='Spacer' then inst=K.Spacer(common)",
      " elseif kind=='Toasts' then common.transparency=1 common.stroke=false common.radius=false common.padding=false common.layout='column' common.vAlign=Enum.VerticalAlignment.Bottom inst,content=K.Column(common) inst.Name=node.name or 'Toasts'",
      " else common.alt=node.alt==true inst,content=K.Panel(common) end",
      " if not inst then return nil end",
      " if node.name then inst.Name=tostring(node.name) end",
      " if node.z then inst.ZIndex=tonumber(node.z) or inst.ZIndex end",
      " if node.visible==false then inst.Visible=false end",
      " if node.attributes then for k,v in pairs(node.attributes) do pcall(function() inst:SetAttribute(tostring(k),v) end) end end",
      " applyPosition(inst,node,w,h,pw,ph,inLayout)",
      " applyProps(inst,node.props or node.properties)",
      " created[#created+1]=inst:GetFullName()",
      " if content and type(node.children)=='table' then local cpw,cph=w,h if kind=='Window' then cph=h-56 end if childW then cpw,cph=childW,childH else local padPx=(type(pad)=='number' and pad) or ((kind=='Panel' or kind=='Window') and T.spacing.md) or 0 cpw=math.max(1,cpw-padPx*2) if cph>0 then cph=math.max(1,cph-padPx*2) end end for i,ch in ipairs(node.children) do buildNode(K,T,ch,content,cpw,cph,node.layout~=nil or kind=='Row' or kind=='Column' or kind=='Grid' or kind=='ScrollList' or kind=='Toasts',i,created) end end",
      " return inst",
      "end",
      "local function buildScreen(spec,opts)",
      " opts=opts or {}",
      " local K=kit() local T=K.tokens(true)",
      " local name=tostring(spec.name or opts.name or 'Total_Screen')",
      " local sg=screenGui(opts.parent or spec.parent,name,{replace=opts.replace,open_key=spec.open_key or opts.open_key,display_order=spec.display_order})",
      " if spec.ignore_inset==false then sg.IgnoreGuiInset=false end",
      " local created={}",
      " local roots=spec.children or spec.roots or {}",
      " if spec.kind and not spec.children then roots={spec} end",
      " for i,node in ipairs(roots) do node.parentIsRoot=true local inst=buildNode(K,T,node,sg,BASE_W,BASE_H,false,i,created) if inst and inst:IsA('GuiObject') then local w,h=nodeSize(node,tostring(node.kind or 'Panel'),BASE_W,BASE_H) if node.aspect~=false and node.size~='fill' then local ar=inst:FindFirstChildOfClass('UIAspectRatioConstraint') or Instance.new('UIAspectRatioConstraint') ar.AspectRatio=w/math.max(1,h) ar.AspectType=Enum.AspectType.ScaleWithParentSize ar.DominantAxis=Enum.DominantAxis.Width ar.Parent=inst end if node.max_scale~=false then local sc=inst:FindFirstChildOfClass('UISizeConstraint') or Instance.new('UISizeConstraint') sc.MaxSize=Vector2.new(math.floor(w*(tonumber(node.max_scale) or 1.5)),math.floor(h*(tonumber(node.max_scale) or 1.5))) sc.Parent=inst end end end",
      " if opts.controller~=false then writeScript('LocalScript',sg,'Total_Controller',CONTROLLER_SRC,true) end",
      " return sg,created",
      "end",
    ].join("\n"),
  ].join("\n");

  // ───────────────────────── SCREEN TEMPLATES (JS specs, px on 1280x720) ─────────────────────────
  const defaultItems = (n, currency) => {
    const names = ["Sword", "Shield", "Potion", "Bow", "Helmet", "Boots", "Ring", "Amulet", "Staff", "Cloak", "Gem", "Key"];
    const rar = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
    return Array.from({ length: n }, (_, i) => ({ item: names[i % names.length] + (i >= names.length ? i : ""), title: names[i % names.length], price: (i + 1) * 100, currency, rarity: rar[Math.min(rar.length - 1, Math.floor(i / 2))] }));
  };
  const normItems = (items, currency, n) => {
    if (!Array.isArray(items) || !items.length) return defaultItems(n, currency);
    return items.slice(0, 48).map((it, i) => typeof it === "string" ? { item: it, title: it, price: (i + 1) * 100, currency } : { item: String(it.item || it.id || it.name || it.title || ("Item" + (i + 1))), title: String(it.title || it.name || it.item || ("Item " + (i + 1))), subtitle: it.subtitle || it.description, price: it.price, currency: it.currency || currency, rarity: it.rarity, icon: it.icon || it.image, badge: it.badge });
  };

  function screenSpec(kind, a) {
    a = a || {};
    const title = a.title || "";
    const currency = String(a.currency || "Coins");
    const name = ident(a.name || ({ main_menu: "MainMenu", hud: "HUD", shop: "Shop", inventory: "Inventory", settings: "Settings", leaderboard: "Leaderboard", daily_rewards: "DailyRewards", quest_log: "QuestLog", loading: "LoadingScreen", dialog: "Dialog", notification_stack: "Notifications" }[kind] || "Screen"));
    const extras = { scripts: [], server: null, replicatedFirst: false, remotes: [] };
    let spec = null;
    if (kind === "shop") {
      const items = normItems(a.items, currency, 8);
      const tabs = Array.isArray(a.tabs) && a.tabs.length ? a.tabs.map(String).slice(0, 8) : ["Featured", "Weapons", "Armor", "Pets"];
      const perTab = tabs.map((t, i) => ({ layout: "column", children: [{ kind: "ScrollList", name: "Items_" + ident(t), grid: true, columns: 4, size: ["fill", "fill"], gap: 12, cell_height: 200, children: (i === 0 ? items : items.filter((_, j) => j % tabs.length === i % tabs.length || items.length <= 4)).map((it) => ({ kind: "ItemCard", ...it, action: "remote:Total_Shop_Buy" })) }] }));
      spec = { name, open_key: a.open_key || "B", children: [
        { kind: "Window", name: "ShopWindow", title: title || "Shop", size: [900, 560], start_hidden: a.start_hidden !== false, children: [
          { kind: "Row", name: "TopRow", size: ["fill", 40], gap: 12, children: [
            { kind: "CurrencyPill", name: "Coins", stat: currency, value: "0", size: [150, 40] },
            { kind: "Label", text: a.subtitle || "Tap an item to buy it. Prices update live.", muted: true, size: [500, 40], role: "caption" },
          ] },
          { kind: "Tabs", name: "Categories", size: ["fill", "80%"], tabs, vertical: true, bar_size: 170, pages: perTab, position: [0, 52] },
        ] },
        { kind: "Toasts", name: "Toasts", size: [340, 300], anchor: "top-right", margin: 16, aspect: false },
      ] };
      extras.server = { name: "Total_ShopServer", source: shopServerSource(items) };
      extras.remotes = ["Total_Shop_Buy", "Total_Notify"];
      extras.scripts.push({ name: "Total_NotifyFeed", source: NOTIFY_FEED_SRC });
    } else if (kind === "inventory") {
      const slots = Math.max(4, Math.min(60, Number(a.slots) || 20));
      const owned = Array.isArray(a.items) ? normItems(a.items, currency, 0) : [];
      spec = { name, open_key: a.open_key || "E", children: [
        { kind: "Window", name: "InventoryWindow", title: title || "Inventory", size: [860, 540], start_hidden: a.start_hidden !== false, children: [
          { kind: "ScrollList", name: "Slots", grid: true, columns: 6, size: [520, "fill"], gap: 10, cell_height: 80, children: Array.from({ length: slots }, (_, i) => { const it = owned[i]; return { kind: "Slot", index: i + 1, item: it ? it.item : "", rarity: it ? it.rarity : "common", icon: it ? it.icon : "", hotkey: i < 9 ? String(i + 1) : undefined, detail: "Detail" }; }) },
          { kind: "Panel", name: "Detail", alt: true, size: [290, "fill"], position: [538, 0], layout: "column", gap: 10, children: [
            { kind: "Panel", name: "Preview", size: ["fill", 160], alt: false },
            { kind: "Label", name: "ItemName", text: owned[0] ? owned[0].title : "Select an item", role: "h2", bold: true, size: ["fill", 32] },
            { kind: "Label", name: "ItemDesc", text: a.description || "Item details appear here.", muted: true, size: ["fill", 70], valign: "top" },
            { kind: "Spacer", size: ["fill", 8] },
            { kind: "Button", name: "Equip", text: "Equip", size: ["fill", 44], action: "remote:Total_Inventory_Equip" },
            { kind: "Button", name: "Drop", text: "Drop", variant: "danger", size: ["fill", 40], action: "remote:Total_Inventory_Drop" },
          ] },
        ] },
      ] };
      extras.remotes = ["Total_Inventory_Equip", "Total_Inventory_Drop"];
    } else if (kind === "hud") {
      const stats = Array.isArray(a.stats) && a.stats.length ? a.stats.map(String).slice(0, 4) : [currency, "Gems"];
      spec = { name, children: [
        { kind: "Row", name: "TopLeft", size: [420, 44], anchor: "top-left", margin: [16, 12], gap: 10, aspect: false, children: stats.map((s) => ({ kind: "CurrencyPill", name: s, stat: s, value: "0", size: [150, 40] })) },
        { kind: "Row", name: "TopRight", size: [220, 48], anchor: "top-right", margin: [16, 12], gap: 8, align: "end", aspect: false, children: [
          { kind: "IconButton", name: "ShopButton", glyph: "$", action: "toggle:Shop", size: [44, 44] },
          { kind: "IconButton", name: "InventoryButton", glyph: "I", action: "toggle:Inventory", size: [44, 44] },
          { kind: "IconButton", name: "SettingsButton", glyph: "*", action: "toggle:Settings", size: [44, 44] },
        ] },
        { kind: "Column", name: "BottomLeft", size: [320, 70], anchor: "bottom-left", margin: [16, 16], gap: 6, aspect: false, children: [
          { kind: "ProgressBar", name: "Health", value: 1, label: "100 / 100", color: [240, 80, 90], size: ["fill", 26] },
          { kind: "ProgressBar", name: "XP", value: 0.35, label: "Level 1", color: [88, 120, 255], size: ["fill", 18] },
        ] },
        { kind: "Row", name: "Hotbar", size: [9 * 60 + 8 * 8, 60], anchor: "bottom", margin: [0, 16], gap: 8, align: "center", aspect: false, children: Array.from({ length: 9 }, (_, i) => ({ kind: "Slot", index: i + 1, hotkey: String(i + 1), size: [60, 60], action: "print:hotbar " + (i + 1) })) },
        { kind: "Toasts", name: "Toasts", size: [340, 300], anchor: "top-right", margin: [16, 72], aspect: false },
      ] };
      extras.scripts.push({ name: "Total_HudFeed", source: HUD_FEED_SRC }, { name: "Total_NotifyFeed", source: NOTIFY_FEED_SRC });
      extras.remotes = ["Total_Notify"];
    } else if (kind === "main_menu") {
      const buttons = Array.isArray(a.buttons) && a.buttons.length ? a.buttons.map(String).slice(0, 6) : ["Play", "Shop", "Settings", "Credits"];
      spec = { name, children: [
        { kind: "Panel", name: "Backdrop", size: "fill", aspect: false, max_scale: false, radius: 0, stroke: false, padding: 0, color: a.background_color || undefined, gradient: a.background_gradient || [10, 10, 16], children: a.background_image ? [{ kind: "Image", name: "Art", image: a.background_image, size: "fill", fit: "crop", anchor: "center" }] : [] },
        { kind: "Column", name: "Menu", size: [420, 520], anchor: "left", margin: [96, 0], gap: 14, align: "start", valign: "center", children: [
          { kind: "Title", name: "GameTitle", text: title || "My Game", size: ["fill", 72], max_text: 48, bold: true, stroke_text: true },
          { kind: "Label", name: "Tagline", text: a.subtitle || "Press Play to start your adventure", muted: true, size: ["fill", 28] },
          { kind: "Spacer", size: ["fill", 10] },
          ...buttons.map((b, i) => ({ kind: "Button", name: ident(b), text: b, size: ["fill", 56], variant: i === 0 ? "primary" : "ghost", action: i === 0 ? "remote:Total_Menu_Play" : "toggle:" + ident(b), max_text: 24 })),
        ] },
        { kind: "Row", name: "TopRight", size: [320, 44], anchor: "top-right", margin: [20, 16], gap: 10, align: "end", aspect: false, children: [{ kind: "CurrencyPill", name: currency, stat: currency, value: "0", size: [150, 40] }] },
        { kind: "Label", name: "Version", text: a.version || "v1.0.0", muted: true, role: "caption", size: [200, 20], anchor: "bottom-left", margin: [16, 10], aspect: false },
      ] };
      extras.remotes = ["Total_Menu_Play"];
    } else if (kind === "settings") {
      const toggles = Array.isArray(a.toggles) && a.toggles.length ? a.toggles.map(String).slice(0, 10) : ["Music", "Sound Effects", "Shadows", "Camera Shake", "Show Tips"];
      spec = { name, open_key: a.open_key || "P", children: [
        { kind: "Window", name: "SettingsWindow", title: title || "Settings", size: [620, 520], start_hidden: a.start_hidden !== false, children: [
          { kind: "ScrollList", name: "Options", size: ["fill", "80%"], gap: 6, children: [
            ...toggles.map((t) => ({ kind: "Toggle", name: ident(t), text: t, value: true, setting: ident(t).toLowerCase(), size: ["fill", 46] })),
            { kind: "Divider" },
            { kind: "Row", name: "VolumeRow", size: ["fill", 46], gap: 10, children: [
              { kind: "Label", text: "Master volume", size: [220, 40] },
              { kind: "IconButton", name: "VolDown", glyph: "-", size: [36, 36], action: "print:volume down" },
              { kind: "ProgressBar", name: "Volume", value: 0.7, size: [200, 20] },
              { kind: "IconButton", name: "VolUp", glyph: "+", size: [36, 36], action: "print:volume up" },
            ] },
          ] },
          { kind: "Row", name: "Footer", size: ["fill", 48], position: [0, "86%"], gap: 10, align: "end", children: [
            { kind: "Button", name: "Reset", text: "Reset", variant: "ghost", size: [140, 44], action: "print:reset settings" },
            { kind: "Button", name: "Save", text: "Save", variant: "success", size: [160, 44], action: "close" },
          ] },
        ] },
      ] };
      extras.scripts.push({ name: "Total_SettingsStore", source: SETTINGS_STORE_SRC });
    } else if (kind === "leaderboard") {
      spec = { name, children: [
        { kind: "Panel", name: "Board", size: [300, 420], anchor: "right", margin: [16, 0], layout: "column", gap: 8, attributes: {}, children: [
          { kind: "Label", text: title || ("Top " + currency), role: "h2", bold: true, align: "center", size: ["fill", 36] },
          { kind: "Divider" },
          { kind: "ScrollList", name: "Rows", size: ["fill", "86%"], gap: 4 },
        ] },
      ] };
      extras.screenAttributes = { Total_Stat: currency };
      extras.scripts.push({ name: "Total_LeaderboardFeed", source: LEADERBOARD_FEED_SRC });
    } else if (kind === "daily_rewards") {
      const rewards = Array.isArray(a.rewards) && a.rewards.length ? a.rewards.map((r) => Number(r) || 0).slice(0, 7) : [100, 150, 200, 300, 400, 600, 1000];
      spec = { name, open_key: a.open_key || "R", children: [
        { kind: "Window", name: "DailyWindow", title: title || "Daily Rewards", size: [820, 440], start_hidden: a.start_hidden !== false, children: [
          { kind: "Label", text: a.subtitle || "Come back every day for bigger rewards!", muted: true, align: "center", size: ["fill", 30] },
          { kind: "Grid", name: "Days", columns: 7, size: ["fill", 220], position: [0, 40], gap: 10, children: rewards.map((r, i) => ({ kind: "Panel", name: "Day" + (i + 1), alt: true, layout: "column", gap: 4, align: "center", attributes: { Total_Day: i + 1 }, children: [
            { kind: "Label", text: "Day " + (i + 1), role: "caption", muted: true, align: "center", size: ["fill", 18] },
            { kind: "Label", text: "+" + r, role: "h2", bold: true, align: "center", size: ["fill", 40], color: i === rewards.length - 1 ? [255, 190, 60] : undefined },
            { kind: "Label", name: "State", text: i === 0 ? "TODAY" : "", role: "caption", bold: true, align: "center", size: ["fill", 16] },
          ] })) },
          { kind: "Button", name: "Claim", text: "Claim today's reward", size: [320, 52], position: ["50%", 300], anchor: [0.5, 0], action: "remote:Total_Daily_Claim", variant: "success", max_text: 22 },
        ] },
        { kind: "Toasts", name: "Toasts", size: [340, 300], anchor: "top-right", margin: 16, aspect: false },
      ] };
      extras.server = { name: "Total_DailyServer", source: dailyServerSource(rewards) };
      extras.remotes = ["Total_Daily_Claim"];
      extras.scripts.push({ name: "Total_DailyClient", source: DAILY_CLIENT_SRC });
    } else if (kind === "quest_log") {
      const quests = Array.isArray(a.quests) && a.quests.length ? a.quests.slice(0, 20).map((qq, i) => typeof qq === "string" ? { title: qq, progress: 0, reward: 100 } : { title: String(qq.title || qq.name || ("Quest " + (i + 1))), progress: Number(qq.progress) || 0, reward: qq.reward != null ? qq.reward : 100, description: qq.description }) : [{ title: "Collect 10 coins", progress: 0.4, reward: 100 }, { title: "Defeat 3 slimes", progress: 0, reward: 250 }, { title: "Talk to the blacksmith", progress: 1, reward: 50 }];
      spec = { name, open_key: a.open_key || "Q", children: [
        { kind: "Window", name: "QuestWindow", title: title || "Quests", size: [680, 520], start_hidden: a.start_hidden !== false, children: [
          { kind: "ScrollList", name: "Quests", size: ["fill", "fill"], gap: 10, children: quests.map((qq, i) => ({ kind: "Panel", name: "Quest" + (i + 1), alt: true, size: ["fill", 96], layout: "column", gap: 6, children: [
            { kind: "Row", size: ["fill", 26], gap: 8, children: [
              { kind: "Label", text: qq.title, bold: true, size: [380, 26] },
              { kind: "CurrencyPill", name: "Reward", value: "+" + qq.reward, size: [120, 26] },
            ] },
            { kind: "Label", text: qq.description || "", muted: true, role: "caption", size: ["fill", 18] },
            { kind: "ProgressBar", name: "Progress", value: qq.progress, size: ["fill", 16], color: qq.progress >= 1 ? [70, 210, 130] : undefined },
          ] })) },
        ] },
      ] };
    } else if (kind === "loading") {
      const tips = Array.isArray(a.tips) && a.tips.length ? a.tips.map(String) : ["Tip: hold Shift to sprint", "Tip: visit the shop for upgrades", "Tip: daily rewards grow every day"];
      spec = { name, children: [
        { kind: "Panel", name: "Backdrop", size: "fill", aspect: false, max_scale: false, radius: 0, stroke: false, padding: 0, gradient: [10, 10, 16], children: [
          { kind: "Column", name: "Center", size: [560, 260], anchor: "center", gap: 18, align: "center", valign: "center", children: [
            { kind: "Title", name: "GameTitle", text: title || "Loading", align: "center", size: ["fill", 72], max_text: 48, bold: true, stroke_text: true },
            { kind: "Label", name: "Subtitle", text: a.subtitle || "Loading your world...", muted: true, align: "center", size: ["fill", 26] },
            { kind: "ProgressBar", name: "Progress", value: 0.05, size: [480, 22] },
            { kind: "Label", name: "Tip", text: tips[0], role: "caption", muted: true, align: "center", size: ["fill", 22], attributes: { Total_Tips: tips.join("|") } },
          ] },
        ] },
      ] };
      extras.replicatedFirst = true;
    } else if (kind === "dialog") {
      const choices = Array.isArray(a.choices) && a.choices.length ? a.choices.map(String).slice(0, 4) : ["Continue", "Goodbye"];
      spec = { name, children: [
        { kind: "Window", name: "DialogBox", title: a.speaker || "Villager", size: [820, 220], anchor: "bottom", margin: [0, 24], start_hidden: a.start_hidden === true, closable: false, children: [
          { kind: "Row", size: ["fill", "fill"], gap: 16, children: [
            { kind: "Panel", name: "Portrait", alt: true, size: [120, 120], padding: 0, children: a.portrait ? [{ kind: "Image", image: a.portrait, size: "fill" }] : [] },
            { kind: "Column", size: [640, "fill"], gap: 10, children: [
              { kind: "Label", name: "Line", text: a.text || "Welcome, traveller! The road ahead is dangerous...", size: ["fill", 70], valign: "top", typewriter: 45 },
              { kind: "Row", name: "Choices", size: ["fill", 44], gap: 10, children: choices.map((c, i) => ({ kind: "Button", name: ident(c), text: c, size: [180, 42], variant: i === 0 ? "primary" : "ghost", action: i === choices.length - 1 ? "close" : "remote:Total_Dialog_Choice", item: c, max_text: 18 })) },
            ] },
          ] },
        ] },
      ] };
      extras.remotes = ["Total_Dialog_Choice"];
    } else if (kind === "notification_stack") {
      spec = { name, children: [{ kind: "Toasts", name: "Toasts", size: [340, 400], anchor: a.anchor || "top-right", margin: [16, 16], aspect: false }] };
      extras.scripts.push({ name: "Total_NotifyFeed", source: NOTIFY_FEED_SRC });
      extras.remotes = ["Total_Notify"];
    }
    return { spec, extras };
  }

  const SETTINGS_STORE_SRC = `-- Total_SettingsStore (generated). Persists every Total_Setting toggle to player attributes (Setting_<name>) and restores them on join.
local Players = game:GetService("Players")
local player = Players.LocalPlayer
local gui = script.Parent
while gui and not gui:IsA("LayerCollector") do
	gui = gui.Parent
end
if not gui then
	return
end
for _, d in ipairs(gui:GetDescendants()) do
	local key = d:GetAttribute("Total_Setting")
	if key and d:GetAttribute("Total_Toggle") ~= nil then
		local saved = player:GetAttribute("Setting_" .. key)
		if saved ~= nil then
			d:SetAttribute("Total_Toggle", saved == true)
		end
		d:GetAttributeChangedSignal("Total_Toggle"):Connect(function()
			player:SetAttribute("Setting_" .. key, d:GetAttribute("Total_Toggle") == true)
		end)
	end
end
`;

  const SCREEN_KINDS = ["main_menu", "hud", "shop", "inventory", "settings", "leaderboard", "daily_rewards", "quest_log", "loading", "dialog", "notification_stack"];

  // ───────────────────────── COMMAND BODIES ─────────────────────────
  const B = {};

  B.design_tokens_set = (a) => {
    const T = tokensFrom(a);
    return [
      "local rec=wp()",
      "local d=designFolder()",
      "local m,how=writeModule(d,'Tokens'," + q(tokensModuleSource(T)) + ",true)",
      "d:SetAttribute('TokensJSON'," + jj(T) + ")",
      "d:SetAttribute('Preset'," + q(T.preset) + ")",
      "ensureKit(false)",
      "pcall(function() local K=kit() K.tokens(true) end)",
      "wpDone(rec)",
      "return ok({path=m:GetFullName(),how=how,preset=" + q(T.preset) + ",palette=HttpService:JSONDecode(" + jj(Object.fromEntries(Object.entries(T.palette).map(([k, v]) => [k, hex(v)]))) + "),font=" + q(T.font.Family) + ",radius=" + nn(T.radius.md) + "},'design tokens '..how..': preset " + T.preset + ", primary " + hex(T.palette.Primary) + ", surface " + hex(T.palette.Surface) + ", font " + T.font.Family + " - every kit component and ui_from_spec / ui_screen_generate / ui_apply_tokens now use them')",
    ].join("\n");
  };

  B.design_tokens_get = () => [
    "local d=ReplicatedStorage:FindFirstChild('Total_Design')",
    "if not d then return ok({installed=false,presets=" + jj(PRESET_NAMES) + ",tokens=HttpService:JSONDecode(DEFAULT_TOKENS_JSON)},'no design system yet - defaults shown; call design_tokens_set {preset} to create one') end",
    "local t=readTokens()",
    "local pal={} for k,v in pairs(t.palette or {}) do local c=c3(v) pal[k]=c and hexOf(c) or tostring(v) end",
    "return ok({installed=true,path=d:GetFullName(),preset=t.preset,name=t.name,palette=pal,font=t.font,radius=t.radius,spacing=t.spacing,kit=d:FindFirstChild('UIKit')~=nil,kit_version=d:FindFirstChild('UIKit') and d.UIKit:GetAttribute('Total_Version') or nil,presets=" + jj(PRESET_NAMES) + "},'design tokens: preset '..tostring(t.preset)..', primary '..tostring(pal.Primary)..', surface '..tostring(pal.Surface)..', font '..tostring(t.font and t.font.Family))",
  ].join("\n");

  B.design_kit_install = (a) => [
    "local rec=wp()",
    "local d,r=ensureKit(" + bb(a.force) + ")",
    "local K=kit()",
    "wpDone(rec)",
    "local fns={} for k,v in pairs(K) do if type(v)=='function' then fns[#fns+1]=k end end table.sort(fns)",
    "return ok({path=d:GetFullName(),files=r,version=KIT_VERSION,components=fns},'UIKit '..tostring(r.UIKit)..', Responsive '..tostring(r.Responsive)..', Tokens '..tostring(r.Tokens)..' in '..d:GetFullName()..' ('..#fns..' functions: require(ReplicatedStorage.Total_Design.UIKit))')",
  ].join("\n");

  B.ui_from_spec = (a) => {
    let spec = a.spec;
    if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch { throw new Error("spec must be a JSON object (got an unparsable string)"); } }
    if (!spec || typeof spec !== "object") throw new Error("missing required param 'spec' (object with children[])");
    if (a.name) spec.name = ident(a.name);
    if (!spec.name) spec.name = "Total_Screen";
    if (a.open_key) spec.open_key = String(a.open_key);
    return [
      "local spec=HttpService:JSONDecode(" + jj(spec) + ")",
      "local rec=wp()",
      "local sg,created=buildScreen(spec,{parent=" + (a.parent ? q(String(a.parent)) : "nil") + ",replace=" + bb(a.replace, true) + ",controller=" + bb(a.controller, true) + "})",
      "wpDone(rec)",
      "return ok({path=sg:GetFullName(),count=#created,items=created},'built '..sg:GetFullName()..' from spec: '..#created..' instance(s), scale-based sizes from a 1280x720 canvas, Total_Controller attached - now total_screenshot {target:\"studio\"} to judge it')",
    ].join("\n");
  };

  B.ui_screen_generate = (a) => {
    const kind = String(a.kind || "").toLowerCase().replace(/[\s-]+/g, "_");
    if (!SCREEN_KINDS.includes(kind)) throw new Error("kind must be one of " + SCREEN_KINDS.join("|"));
    const { spec, extras } = screenSpec(kind, a);
    if (a.open_key) spec.open_key = String(a.open_key);
    const lines = [
      "local spec=HttpService:JSONDecode(" + jj(spec) + ")",
      "local rec=wp()",
      "local sg,created=buildScreen(spec,{parent=" + (extras.replicatedFirst ? "'ReplicatedFirst'" : (a.parent ? q(String(a.parent)) : "nil")) + ",replace=" + bb(a.replace, true) + ",controller=" + (extras.replicatedFirst ? "false" : "true") + "})",
      "local written={}",
    ];
    if (extras.screenAttributes) for (const [k, v] of Object.entries(extras.screenAttributes)) lines.push("sg:SetAttribute(" + q(k) + "," + q(String(v)) + ")");
    for (const r of extras.remotes) lines.push("do local rf=folder(ReplicatedStorage,'Remotes') if not rf:FindFirstChild(" + q(r) + ") then local re=Instance.new(" + (r === "Total_Daily_Claim" ? "'RemoteFunction'" : "'RemoteEvent'") + ") re.Name=" + q(r) + " re.Parent=rf written[#written+1]=re:GetFullName() end end");
    for (const s of extras.scripts) lines.push("do local s,how=writeScript('LocalScript',sg," + q(s.name) + "," + q(s.source) + ",true) written[#written+1]=s:GetFullName()..' ('..how..')' end");
    if (extras.server) lines.push("do local s,how=writeScript('Script',ServerScriptService," + q(extras.server.name) + "," + q(extras.server.source) + "," + bb(a.overwrite_server, false) + ") written[#written+1]=s:GetFullName()..' ('..how..')' end");
    if (extras.replicatedFirst) lines.push("do local s,how=writeScript('LocalScript',ReplicatedFirst,'Total_Loading'," + q(LOADING_SRC) + ",true) written[#written+1]=s:GetFullName()..' ('..how..')' end");
    lines.push("wpDone(rec)");
    lines.push("return ok({path=sg:GetFullName(),kind=" + q(kind) + ",count=#created,items=created,written=written,open_key=" + (spec.open_key ? q(spec.open_key) : "nil") + "},'" + kind + " screen '..sg:GetFullName()..': '..#created..' instance(s)'..(#written>0 and (', scripts: '..table.concat(written,', ')) or '')..'" + (spec.open_key ? " - toggles with key " + spec.open_key : "") + ". Review with total_screenshot {target:\"studio\"}; tune with ui_set_* or edit and ui_from_spec again')");
    return lines.join("\n");
  };

  const COMPONENT_KINDS = ["Button", "IconButton", "Panel", "Window", "Row", "Column", "Grid", "ScrollList", "Label", "Title", "Image", "ItemCard", "Slot", "CurrencyPill", "ProgressBar", "Toggle", "Input", "Tabs", "Divider", "Spacer", "Toasts"];
  B.ui_component_place = (a) => {
    if (!a.kind) throw new Error("missing required param 'kind'");
    if (!a.parent) throw new Error("missing required param 'parent'");
    if (!COMPONENT_KINDS.includes(String(a.kind))) throw new Error("unknown component kind '" + String(a.kind) + "' - use one of: " + COMPONENT_KINDS.join(", "));
    const node = Object.assign({}, a.props || {}, { kind: String(a.kind), name: a.name, text: a.text, size: a.size, position: a.position, anchor: a.anchor, action: a.action, variant: a.variant, image: a.image, value: a.value, item: a.item, children: a.children });
    for (const k of Object.keys(node)) if (node[k] === undefined) delete node[k];
    return [
      "local parent=need(" + q(String(a.parent)) + ",'parent')",
      "if not (parent:IsA('GuiObject') or parent:IsA('LayerCollector')) then return fail('parent must be a GuiObject or ScreenGui: '..parent.ClassName) end",
      "local K=kit() local T=K.tokens(true)",
      "local pw,ph=BASE_W,BASE_H",
      "if parent:IsA('GuiObject') then local okA=pcall(function() pw,ph=parent.AbsoluteSize.X,parent.AbsoluteSize.Y end) if not okA or pw<=0 or ph<=0 then pw,ph=pxSize(parent,BASE_W,BASE_H) end end",
      "local inLayout=parent:FindFirstChildOfClass('UIListLayout')~=nil or parent:FindFirstChildOfClass('UIGridLayout')~=nil",
      "local node=HttpService:JSONDecode(" + jj(node) + ")",
      "local created={}",
      "local rec=wp()",
      "local inst=buildNode(K,T,node,parent,math.max(1,pw),math.max(1,ph),inLayout,#parent:GetChildren()+1,created)",
      "wpDone(rec)",
      "if not inst then return fail('unknown component kind: '..tostring(node.kind)) end",
      "return ok({path=inst:GetFullName(),count=#created,items=created},'placed '..tostring(node.kind)..' '..inst:GetFullName()..(inLayout and ' (parent has a layout: position ignored, LayoutOrder used)' or ''))",
    ].join("\n");
  };

  B.ui_apply_tokens = (a) => [
    "local root=need(" + q(String(a.path || "StarterGui")) + ",'gui')",
    "local K=kit() local T=K.tokens(true) local P=T.palette",
    "local fontMain,fontBold=T.font.Family,T.font.Bold",
    "local keepImages=" + bb(a.keep_images, true),
    "local n=0 local rec=wp()",
    "local function isDark(c) return lum(c)<0.35 end",
    "local function visit(g)",
    " if g:IsA('GuiButton') then",
    "  if g:IsA('TextButton') or (g:IsA('ImageButton') and (g.Image=='' or not keepImages)) then local base=g:GetAttribute('Total_Variant')=='ghost' and P.SurfaceAlt or P.Primary if g.BackgroundTransparency<0.95 then g.BackgroundColor3=base g:SetAttribute('Total_BaseColor',base) end if g:IsA('TextButton') then g.TextColor3=K.textOn(g.BackgroundColor3) pcall(function() g.Font=Enum.Font[fontBold] end) end end",
    "  K.corner(g,T.radius.md) n=n+1",
    " elseif g:IsA('TextLabel') or g:IsA('TextBox') then",
    "  local bgHost=g.Parent local bg=P.Surface while bgHost and bgHost:IsA('GuiObject') do if bgHost.BackgroundTransparency<0.5 then bg=bgHost.BackgroundColor3 break end bgHost=bgHost.Parent end",
    "  local muted=g.TextTransparency>0.25 or (g:IsA('TextLabel') and g.TextSize>0 and g.TextSize<13 and not g.TextScaled)",
    "  local col=muted and P.TextMuted or P.Text if contrast(col,bg)<3 then col=K.textOn(bg) end g.TextColor3=col",
    "  pcall(function() g.Font=Enum.Font[(g:IsA('TextLabel') and (g.Font==Enum.Font.GothamBold or g.Font==Enum.Font.SourceSansBold or g.Font==Enum.Font.GothamBlack)) and fontBold or fontMain] end)",
    "  if g:IsA('TextBox') then g.BackgroundColor3=P.SurfaceAlt K.corner(g,T.radius.md) end n=n+1",
    " elseif g:IsA('ScrollingFrame') then g.ScrollBarImageColor3=P.Primary if g.BackgroundTransparency<0.5 then g.BackgroundColor3=P.SurfaceAlt end n=n+1",
    " elseif g:IsA('Frame') or g:IsA('CanvasGroup') then",
    "  if g.BackgroundTransparency<0.5 then local pc=g.Parent and g.Parent:IsA('GuiObject') and g.Parent.BackgroundTransparency<0.5 and g.Parent.BackgroundColor3 or nil local lu=lum(g.BackgroundColor3) if g.Name=='Fill' or (g.Parent and g.Parent:GetAttribute('Total_Progress')) then g.BackgroundColor3=P.Primary elseif pc and math.abs(lum(pc)-lu)>0.04 then g.BackgroundColor3=(lum(pc)<lu)==isDark(P.Surface) and P.SurfaceAlt or P.Surface else g.BackgroundColor3=P.Surface end if g:FindFirstChildOfClass('UICorner') or #g:GetChildren()>2 then K.corner(g,T.radius.lg) end local s=g:FindFirstChildOfClass('UIStroke') if s then s.Color=P.Stroke s.Transparency=T.stroke.transparency s.Thickness=T.stroke.thickness end n=n+1 end",
    " elseif g:IsA('ImageLabel') and not keepImages then g.ImageColor3=P.Text end",
    " if g:IsA('GuiObject') then local s=g:FindFirstChildOfClass('UIStroke') if s and not g:GetAttribute('Total_Rarity') then s.Color=P.Stroke end end",
    "end",
    "if root:IsA('GuiObject') then visit(root) end",
    "for _,d in ipairs(root:GetDescendants()) do if d:IsA('GuiObject') then visit(d) end end",
    "wpDone(rec)",
    "return ok({path=root:GetFullName(),restyled=n,preset=T.preset},'restyled '..n..' widget(s) under '..root:GetFullName()..' to the '..tostring(T.preset)..' tokens (font '..fontMain..', radius '..T.radius.md..') - screenshot to confirm contrast')",
  ].join("\n");

  B.ui_make_responsive = (a) => [
    "local root=need(" + q(String(a.path || "StarterGui")) + ",'gui')",
    "local maxScale=" + nn(a.max_scale, 1.5),
    "local guis={} if root:IsA('LayerCollector') then guis={root} elseif root:IsA('GuiObject') then guis={root:FindFirstAncestorWhichIsA('LayerCollector') or root} else for _,d in ipairs(root:GetDescendants()) do if d:IsA('LayerCollector') then guis[#guis+1]=d end end end",
    "local rec=wp() local converted,constrained,texts,scripts=0,0,0,0",
    "for _,sg in ipairs(guis) do",
    " if sg:IsA('LayerCollector') then",
    "  for _,r in ipairs(sg:GetChildren()) do if r:IsA('GuiObject') then",
    "   local w,h=pxSize(r,BASE_W,BASE_H)",
    "   if (r.Size.X.Scale==0 or r.Size.Y.Scale==0) and w>0 and h>0 then local x,y=pxPos(r,BASE_W,BASE_H) r.Size=UDim2.new(w/BASE_W,0,h/BASE_H,0) r.Position=UDim2.new((x+r.AnchorPoint.X*w)/BASE_W,0,(y+r.AnchorPoint.Y*h)/BASE_H,0) converted=converted+1 end",
    "   if w<BASE_W*0.98 or h<BASE_H*0.98 then local ar=r:FindFirstChildOfClass('UIAspectRatioConstraint') if not ar then ar=Instance.new('UIAspectRatioConstraint') ar.AspectRatio=w/math.max(1,h) ar.AspectType=Enum.AspectType.ScaleWithParentSize ar.DominantAxis=Enum.DominantAxis.Width ar.Parent=r constrained=constrained+1 end local sc=r:FindFirstChildOfClass('UISizeConstraint') if not sc then sc=Instance.new('UISizeConstraint') sc.MaxSize=Vector2.new(math.floor(w*maxScale),math.floor(h*maxScale)) sc.Parent=r end end",
    "  end end",
    "  for _,d in ipairs(sg:GetDescendants()) do if (d:IsA('TextLabel') or d:IsA('TextButton') or d:IsA('TextBox')) then if not d.TextScaled then local sz=d.TextSize>0 and d.TextSize or 18 d.TextScaled=true local c=d:FindFirstChildOfClass('UITextSizeConstraint') or Instance.new('UITextSizeConstraint') c.MinTextSize=9 c.MaxTextSize=sz c.Parent=d texts=texts+1 elseif not d:FindFirstChildOfClass('UITextSizeConstraint') then local c=Instance.new('UITextSizeConstraint') c.MinTextSize=9 c.MaxTextSize=math.max(12,d.TextSize>0 and d.TextSize or 24) c.Parent=d texts=texts+1 end end end",
    "  if not sg:FindFirstChild('Total_Controller') and not sg:FindFirstChild('Total_Responsive') then ensureKit(false) writeScript('LocalScript',sg,'Total_Responsive'," + q("-- Total_Responsive (generated by ui_make_responsive): safe insets, touch targets, text floors.\nlocal ReplicatedStorage = game:GetService(\"ReplicatedStorage\")\nlocal design = ReplicatedStorage:WaitForChild(\"Total_Design\", 10)\nlocal Responsive = design and require(design:WaitForChild(\"Responsive\"))\nif Responsive then\n\tResponsive.attach(script.Parent)\nend\n") + ",true) scripts=scripts+1 end",
    " end",
    "end",
    "wpDone(rec)",
    "return ok({guis=#guis,converted_roots=converted,aspect_constraints=constrained,text_constraints=texts,scripts=scripts},'responsive pass on '..#guis..' ScreenGui(s): '..converted..' root(s) converted offset->scale, '..constrained..' aspect/size constraint(s), '..texts..' text constraint(s), '..scripts..' Total_Responsive script(s). Verify with ui_audit and total_screenshot')",
  ].join("\n");

  B.ui_gamepad_focus = (a) => [
    "local root=need(" + q(String(a.path || "StarterGui")) + ",'gui')",
    "local K=kit()",
    "local btns={} for _,d in ipairs(root:GetDescendants()) do if d:IsA('GuiButton') and d.Visible and d.Selectable~=false then local okA,ax=pcall(function() return d.AbsolutePosition end) local pos=okA and ax or Vector2.new() btns[#btns+1]={b=d,x=pos.X,y=pos.Y,w=d.AbsoluteSize.X,h=d.AbsoluteSize.Y} end end",
    "if #btns==0 then return fail('no GuiButtons under '..root:GetFullName()) end",
    "for _,e in ipairs(btns) do e.b.Selectable=true e.cx=e.x+e.w/2 e.cy=e.y+e.h/2 end",
    "local function nearest(from,dir) local best,bd=nil,math.huge for _,o in ipairs(btns) do if o~=from then local dx,dy=o.cx-from.cx,o.cy-from.cy local okDir=false if dir=='right' then okDir=dx>4 and math.abs(dy)<math.max(from.h,o.h)*1.5+math.abs(dx)*0.6 elseif dir=='left' then okDir=dx<-4 and math.abs(dy)<math.max(from.h,o.h)*1.5+math.abs(dx)*0.6 elseif dir=='down' then okDir=dy>4 and math.abs(dx)<math.max(from.w,o.w)*1.5+math.abs(dy)*0.6 elseif dir=='up' then okDir=dy<-4 and math.abs(dx)<math.max(from.w,o.w)*1.5+math.abs(dy)*0.6 end if okDir then local dist=dx*dx+dy*dy+((dir=='left' or dir=='right') and dy*dy*3 or dx*dx*3) if dist<bd then bd=dist best=o end end end end return best end",
    "local rec=wp() local links=0",
    "local cursor=root:FindFirstChild('Total_SelectionCursor',true) if not cursor then cursor=K.selectionCursor() cursor.Parent=(root:IsA('LayerCollector') and root) or root:FindFirstAncestorWhichIsA('LayerCollector') or root cursor.Visible=false end",
    "for _,e in ipairs(btns) do local r,l,d,u=nearest(e,'right'),nearest(e,'left'),nearest(e,'down'),nearest(e,'up') e.b.NextSelectionRight=r and r.b or nil e.b.NextSelectionLeft=l and l.b or nil e.b.NextSelectionDown=d and d.b or nil e.b.NextSelectionUp=u and u.b or nil e.b.SelectionImageObject=cursor links=links+((r and 1 or 0)+(l and 1 or 0)+(d and 1 or 0)+(u and 1 or 0)) end",
    "table.sort(btns,function(p,q2) if math.abs(p.cy-q2.cy)>16 then return p.cy<q2.cy end return p.cx<q2.cx end)",
    "btns[1].b:SetAttribute('Total_FirstFocus',true)",
    "if root:IsA('GuiObject') then root.SelectionGroup=true end",
    "wpDone(rec)",
    "return ok({buttons=#btns,links=links,first=btns[1].b:GetFullName()},'gamepad focus: '..#btns..' button(s), '..links..' NextSelection link(s), selection cursor from tokens; first focus '..btns[1].b.Name..'. Total_Controller selects the first button when a window opens on a controller')",
  ].join("\n");

  B.ui_states_wire = (a) => [
    "local root=need(" + q(String(a.path || "StarterGui")) + ",'gui')",
    "ensureKit(false)",
    "local guis={} if root:IsA('LayerCollector') then guis={root} elseif root:IsA('GuiObject') then guis={root:FindFirstAncestorWhichIsA('LayerCollector')} else for _,d in ipairs(root:GetDescendants()) do if d:IsA('LayerCollector') then guis[#guis+1]=d end end end",
    "local rec=wp() local written={} local buttons=0",
    "for _,sg in ipairs(guis) do if sg then local s,how=writeScript('LocalScript',sg,'Total_Controller',CONTROLLER_SRC,true) written[#written+1]=sg.Name..' ('..how..')' for _,d in ipairs(sg:GetDescendants()) do if d:IsA('GuiButton') then buttons=buttons+1 if d.AutoButtonColor then d.AutoButtonColor=false end if " + bb(a.default_action, false) + " and d:GetAttribute('Total_Action')==nil then d:SetAttribute('Total_Action','print') end end end end end",
    "wpDone(rec)",
    "return ok({screens=written,buttons=buttons},'Total_Controller on '..#written..' ScreenGui(s): hover/press tweens, click sounds, Total_Action buttons (close | toggle:<Name> | open:<Name> | remote:<Name> | print:<msg>), Total_Window open/close tweens, Total_OpenKey, gamepad B to close - '..buttons..' button(s) covered. Set Total_Action attributes with attribute_set to give buttons behaviour without code')",
  ].join("\n");

  B.ui_audit = (a) => [
    "local root=resolve(" + q(String(a.path || "StarterGui")) + ") or StarterGui",
    "local T=readTokens() local pal={} for k,v in pairs(T.palette or {}) do local c=c3(v) if c then pal[k]=c end end local hasTokens=ReplicatedStorage:FindFirstChild('Total_Design')~=nil",
    "local issues={} local counts={error=0,warn=0,info=0}",
    "local limit=" + nn(a.limit, 60),
    "local function add(sev,rule,inst,fix) counts[sev]=(counts[sev] or 0)+1 if #issues<limit then issues[#issues+1]={severity=sev,rule=rule,path=inst:GetFullName(),fix=fix} end end",
    "local function bgOf(g) local n=g while n and n:IsA('GuiObject') do if n.BackgroundTransparency<0.5 then return n.BackgroundColor3 end n=n.Parent end return (hasTokens and pal.Surface) or Color3.fromRGB(80,80,80) end",
    "local function nearPalette(c) if not hasTokens then return true end for _,p in pairs(pal) do if math.abs(p.R-c.R)+math.abs(p.G-c.G)+math.abs(p.B-c.B)<0.11 then return true end end return false end",
    "local function sizeOf(g) local pw,ph=BASE_W,BASE_H if g.Parent and g.Parent:IsA('GuiObject') then pw,ph=sizeOf(g.Parent) end return pxSize(g,pw,ph) end",
    "local function rectOf(g) local pw,ph=BASE_W,BASE_H if g.Parent and g.Parent:IsA('GuiObject') then pw,ph=sizeOf(g.Parent) end local w,h=pxSize(g,pw,ph) local x,y=pxPos(g,pw,ph) return x,y,w,h end",
    "local total=0",
    "local function visit(g)",
    " total=total+1",
    " local w,h=sizeOf(g)",
    " if g.Parent and g.Parent:IsA('LayerCollector') and (g.Size.X.Scale==0 and g.Size.Y.Scale==0) and (w<BASE_W*0.98) then add('warn','offset_only_root',g,'ui_make_responsive converts root sizes to scale + aspect constraint') end",
    " if (g:IsA('TextLabel') or g:IsA('TextButton') or g:IsA('TextBox')) and g.TextTransparency<0.9 and g.Text~='' then",
    "  local cr=contrast(g.TextColor3,bgOf(g)) local stroked=(g.TextStrokeTransparency or 1)<0.6 or (g:FindFirstChildOfClass('UIStroke') and g:FindFirstChildOfClass('UIStroke').Transparency<0.6) if g:GetAttribute('Total_Decorative') or stroked then cr=math.max(cr,4.5) end if cr<3 then add('error','low_contrast',g,string.format('contrast %.1f:1 (<3) - use tokens Text/TextMuted on Surface or ui_apply_tokens',cr)) elseif cr<4.5 then add('warn','weak_contrast',g,string.format('contrast %.1f:1 (<4.5) - acceptable for large text only',cr)) end",
    "  if not g.TextScaled and g.TextSize<12 then add('warn','tiny_text',g,'TextSize '..g.TextSize..' <12 - raise or TextScaled + UITextSizeConstraint') end",
    "  if g.TextScaled and not g:FindFirstChildOfClass('UITextSizeConstraint') then add('info','unbounded_text_scale',g,'add UITextSizeConstraint so text does not balloon on large screens') end",
    "  if g.TextScaled and h<14 then add('warn','text_box_too_short',g,'label is '..math.floor(h)..'px tall at 720p') end",
    " end",
    " if g:IsA('GuiButton') and g.Visible and (w<36 or h<36) and g.Parent and not g.Parent:IsA('ScrollingFrame') then add('warn','small_touch_target',g,string.format('%dx%d px at 720p (<36) - mobile taps will miss',math.floor(w),math.floor(h))) end",
    " if g:IsA('ImageLabel') or g:IsA('ImageButton') then if g.Image=='' and g.BackgroundTransparency>0.9 and #g:GetChildren()==0 then add('warn','empty_image',g,'no Image and nothing inside - invisible widget') end end",
    " if hasTokens and g.BackgroundTransparency<0.5 and not g:GetAttribute('Total_Rarity') and not g:GetAttribute('Total_Derived') and g.Name~='Fill' and not nearPalette(g.BackgroundColor3) then add('info','palette_drift',g,'background '..hexOf(g.BackgroundColor3)..' is not a token colour - ui_apply_tokens or design_tokens_set') end",
    " if g.BackgroundTransparency<0.5 and g:IsA('Frame') and w>40 and h>40 and not g:FindFirstChildOfClass('UICorner') then local sib=false for _,s in ipairs(g.Parent:GetChildren()) do if s~=g and s:IsA('Frame') and s:FindFirstChildOfClass('UICorner') then sib=true break end end if sib then add('info','inconsistent_corners',g,'siblings have UICorner, this frame does not') end end",
    " if g:IsA('ScrollingFrame') and g.AutomaticCanvasSize==Enum.AutomaticSize.None and g.CanvasSize==UDim2.new() then add('warn','static_canvas',g,'CanvasSize is 0 and AutomaticCanvasSize is None - nothing will scroll') end",
    " if not (g:FindFirstChildOfClass('UIListLayout') or g:FindFirstChildOfClass('UIGridLayout')) then local kids={} for _,c in ipairs(g:GetChildren()) do if c:IsA('GuiObject') and c.Visible and c.BackgroundTransparency<0.9 then kids[#kids+1]=c end end for i=1,#kids do for j=i+1,#kids do local ax,ay,aw,ah=rectOf(kids[i]) local bx,by,bw,bh=rectOf(kids[j]) local ox=math.min(ax+aw,bx+bw)-math.max(ax,bx) local oy=math.min(ay+ah,by+bh)-math.max(ay,by) if ox>8 and oy>8 and ox*oy>0.25*math.min(aw*ah,bw*bh) and kids[i].ZIndex==kids[j].ZIndex then add('warn','overlap',kids[j],'overlaps '..kids[i].Name..' by '..math.floor(ox)..'x'..math.floor(oy)..'px - reposition or use a layout') end end end end",
    "end",
    "local function walk(n) for _,c in ipairs(n:GetChildren()) do if c:IsA('GuiObject') then visit(c) walk(c) elseif c:IsA('LayerCollector') or c:IsA('Folder') then walk(c) end end end",
    "if root:IsA('GuiObject') then visit(root) end",
    "walk(root)",
    "local sgs={} local function collect(n) if n:IsA('ScreenGui') then sgs[#sgs+1]=n end for _,c in ipairs(n:GetChildren()) do collect(c) end end collect(root)",
    "for _,sg in ipairs(sgs) do if sg.ZIndexBehavior==Enum.ZIndexBehavior.Global then add('info','zindex_global',sg,'ZIndexBehavior Global makes nesting fragile - prefer Sibling') end if not sg:FindFirstChildWhichIsA('LocalScript',true) then add('info','no_runtime',sg,'no LocalScript: buttons have no hover/press/actions - ui_states_wire') end end",
    "local score=math.max(0,100-counts.error*12-counts.warn*4-counts.info*1)",
    "return ok({path=root:GetFullName(),widgets=total,screens=#sgs,score=score,counts=counts,issues=issues,tokens=hasTokens},string.format('UI audit of %s: %d widget(s) in %d screen(s) - score %d/100 (%d error, %d warn, %d info)%s',root:GetFullName(),total,#sgs,score,counts.error,counts.warn,counts.info,(#issues>0 and ('. First: '..issues[1].rule..' at '..issues[1].path) or '. Clean.')))",
  ].join("\n");

  B.ui_export_spec = (a) => [
    "local root=need(" + q(String(a.path || "")) + ",'gui')",
    "local maxNodes=" + nn(a.limit, 400) + " local count=0",
    "local function kindOf(g) if g:IsA('TextButton') then return 'Button' elseif g:IsA('ImageButton') then return (g:GetAttribute('Total_Item')~=nil) and 'Slot' or 'IconButton' elseif g:IsA('TextLabel') then return 'Label' elseif g:IsA('ImageLabel') then return 'Image' elseif g:IsA('TextBox') then return 'Input' elseif g:IsA('ScrollingFrame') then return 'ScrollList' elseif g:GetAttribute('Total_Window') then return 'Window' elseif g:GetAttribute('Total_Progress')~=nil then return 'ProgressBar' elseif g:GetAttribute('Total_Tabs') then return 'Tabs' elseif g:FindFirstChildOfClass('UIGridLayout') then return 'Grid' elseif g:FindFirstChildOfClass('UIListLayout') then return g.UIListLayout.FillDirection==Enum.FillDirection.Horizontal and 'Row' or 'Column' end return 'Panel' end",
    "local function export(g,pw,ph,depth)",
    " count=count+1 if count>maxNodes or depth>12 then return nil end",
    " local w,h=pxSize(g,pw,ph) local x,y=pxPos(g,pw,ph)",
    " local node={kind=kindOf(g),name=g.Name,size={math.floor(w+0.5),math.floor(h+0.5)},position={math.floor(x+0.5),math.floor(y+0.5)}}",
    " if g.AnchorPoint.X~=0 or g.AnchorPoint.Y~=0 then node.position={math.floor(x+g.AnchorPoint.X*w+0.5),math.floor(y+g.AnchorPoint.Y*h+0.5)} node.anchor={g.AnchorPoint.X,g.AnchorPoint.Y} end",
    " if g.BackgroundTransparency<0.95 then node.color=hexOf(g.BackgroundColor3) if g.BackgroundTransparency>0 then node.transparency=g.BackgroundTransparency end else node.transparency=1 end",
    " if g:IsA('TextLabel') or g:IsA('TextButton') or g:IsA('TextBox') then node.text=g.Text node.text_color=hexOf(g.TextColor3) node.font=g.Font.Name if g.TextXAlignment==Enum.TextXAlignment.Center then node.align='center' elseif g.TextXAlignment==Enum.TextXAlignment.Right then node.align='right' end end",
    " if g:IsA('ImageLabel') or g:IsA('ImageButton') then node.image=g.Image end",
    " local act=g:GetAttribute('Total_Action') if act then node.action=act end local item=g:GetAttribute('Total_Item') if item then node.item=item end",
    " local corner=g:FindFirstChildOfClass('UICorner') if corner then node.radius=corner.CornerRadius.Offset end",
    " local ll=g:FindFirstChildOfClass('UIListLayout') if ll then node.layout=(ll.FillDirection==Enum.FillDirection.Horizontal) and 'row' or 'column' node.gap=ll.Padding.Offset end",
    " local gl=g:FindFirstChildOfClass('UIGridLayout') if gl then node.layout='grid' node.cell={math.floor(gl.CellSize.X.Scale*w+gl.CellSize.X.Offset+0.5),math.floor(gl.CellSize.Y.Scale*h+gl.CellSize.Y.Offset+0.5)} node.gap=gl.CellPadding.X.Offset end",
    " local pd=g:FindFirstChildOfClass('UIPadding') if pd then node.padding=pd.PaddingLeft.Offset end",
    " if not g.Visible then node.visible=false end",
    " local kids={} for _,c in ipairs(g:GetChildren()) do if c:IsA('GuiObject') and not (node.kind=='Button' and c.Name=='Label') and c.Name~='Total_SelectionCursor' then local cn=export(c,w,h,depth+1) if cn then kids[#kids+1]=cn end end end",
    " if #kids>0 then node.children=kids end",
    " return node",
    "end",
    "local spec",
    "if root:IsA('LayerCollector') then local roots={} for _,c in ipairs(root:GetChildren()) do if c:IsA('GuiObject') then local n=export(c,BASE_W,BASE_H,0) if n then roots[#roots+1]=n end end end spec={name=root.Name,open_key=root:GetAttribute('Total_OpenKey'),children=roots}",
    "elseif root:IsA('GuiObject') then local pw,ph=BASE_W,BASE_H if root.Parent and root.Parent:IsA('GuiObject') then pw,ph=pxSize(root.Parent,BASE_W,BASE_H) end spec={name=(root:FindFirstAncestorWhichIsA('LayerCollector') or root).Name,children={export(root,pw,ph,0)}}",
    "else return fail('path must be a ScreenGui or GuiObject') end",
    "return ok({spec=spec,nodes=count,truncated=count>maxNodes},'exported '..math.min(count,maxNodes)..' node(s) from '..root:GetFullName()..' as a ui_from_spec tree (px on 1280x720). Edit and rebuild with ui_from_spec {spec, replace:true}')",
  ].join("\n");

  B.ui_preview = (a) => [
    "local root=need(" + q(String(a.path || "")) + ",'gui')",
    "local sg=root:IsA('LayerCollector') and root or root:FindFirstAncestorWhichIsA('LayerCollector')",
    "if not sg then return fail('not inside a ScreenGui: '..root:GetFullName()) end",
    "pcall(function() StarterGui.ShowDevelopmentGui=true end)",
    "local device=" + q(String(a.device || "desktop").toLowerCase()),
    "local factor=({phone=0.55,tablet=0.8,desktop=1,console=1.15})[device] or 1",
    "local restore=" + bb(a.restore, false),
    "local visible=" + bb(a.visible, true),
    "sg.Enabled=true",
    "local touched=0",
    "for _,c in ipairs(sg:GetChildren()) do if c:IsA('GuiObject') then",
    " if c:GetAttribute('Total_Window') or c==root or root==sg then c.Visible=visible end",
    " local ps=c:FindFirstChild('Total_PreviewScale') if restore or factor==1 then if ps then ps:Destroy() end else if not ps then ps=Instance.new('UIScale') ps.Name='Total_PreviewScale' ps.Parent=c end ps.Scale=factor end touched=touched+1",
    "end end",
    "if root:IsA('GuiObject') then root.Visible=visible local n=root.Parent while n and n:IsA('GuiObject') do n.Visible=true n=n.Parent end end",
    "local cam=workspace.CurrentCamera local vp=cam and cam.ViewportSize or Vector2.new(0,0)",
    "return ok({screen=sg:GetFullName(),device=device,factor=factor,viewport={vp.X,vp.Y},roots=touched,restored=restore},(restore and 'preview scale removed' or ('previewing '..sg.Name..' as '..device..' (x'..factor..')'))..' - call total_screenshot {target:\"studio\"} now, then ui_preview {path, restore:true} before shipping')",
  ].join("\n");

  // ───────────────────────── CATALOGUE ─────────────────────────
  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const SPEC_DOC = "spec = {name, open_key?, children:[node]}; node = {kind: Window|Panel|Row|Column|Grid|ScrollList|Tabs|Button|IconButton|Label|Title|Image|ItemCard|Slot|CurrencyPill|ProgressBar|Toggle|Input|Divider|Spacer|Toasts, name?, text?, size:[w,h] px on a 1280x720 canvas ('fill' / '50%' allowed), position:[x,y] px OR anchor:'center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right' + margin, layout:'row|column', gap, padding, align, variant:'primary|secondary|ghost|danger|success', action:'close|toggle:<Name>|open:<Name>|remote:<RemoteName>|print:<msg>', item, value, rarity, icon/image, color [r,g,b]|'#hex', children:[...]}. Sizes become scale (responsive by construction); Window gets header+close; Tabs takes tabs:[names] + pages:[{layout, children}].";
  const C = [
    { name: "design_tokens_set", description: "Create or replace the game's design system (ReplicatedStorage.Total_Design.Tokens ModuleScript): palette, radius, spacing, fonts, motion. Presets: " + PRESET_NAMES.join("|") + ". Any colour can be overridden ([r,g,b], '#hex' or a name). Every kit component, ui_from_spec, ui_screen_generate and ui_apply_tokens read these tokens, so one call restyles everything built afterwards.", params: { preset: S("string", false, PRESET_NAMES.join("|") + " (default midnight)"), name: S("string", false, "style name"), primary: S("array", false, "[r,g,b] accent"), secondary: S("array", false), surface: S("array", false, "panel background"), surface_alt: S("array", false), text: S("array", false), text_muted: S("array", false), success: S("array", false), danger: S("array", false), warning: S("array", false), stroke: S("array", false), font: S("string", false, "Enum.Font name e.g. GothamMedium, FredokaOne, Arcade"), font_bold: S("string", false), radius: S("number", false, "base corner radius px (default per preset)"), spacing: S("number", false, "base spacing px (default 12)"), stroke_thickness: S("number", false), stroke_transparency: S("number", false), hover_sound: S("string", false, "rbxassetid"), click_sound: S("string", false, "rbxassetid") } },
    { name: "design_tokens_get", description: "Read the active design tokens (palette as hex, font, radius, spacing, kit version) or the defaults when no design system exists yet. Call before designing so new screens match.", params: {} },
    { name: "design_kit_install", description: "Install/refresh the runtime UI kit: ReplicatedStorage.Total_Design.UIKit (Button, IconButton, Panel, Window, Row, Column, Grid, ScrollList, Label, Image, ItemCard, Slot, CurrencyPill, ProgressBar, Toggle, Input, Tabs, Toast, wireButton, bindAll, setWindowOpen, contrast helpers) + Responsive (safe insets, touch targets, text floors) + default Tokens. Idempotent; force=true overwrites user edits. Other commands install it automatically.", params: { force: S("boolean", false) } },
    { name: "ui_from_spec", description: "Build a complete, responsive ScreenGui from a declarative tree - THE way to turn a reference image, Paint sketch or layout description into real UI. Measure the design on a 1280x720 canvas and write nodes in px; the builder converts to scale, adds aspect/size constraints, kit styling (tokens), header/close for Window, and one generic Total_Controller LocalScript (hover/press, open/close tweens, Total_Action buttons, keybind, gamepad). " + SPEC_DOC, params: { spec: S("object", true, "the tree (see description)"), name: S("string", false, "ScreenGui name (overrides spec.name)"), parent: S("string", false, "default StarterGui"), open_key: S("string", false, "Enum.KeyCode name that toggles the windows"), replace: S("boolean", false, "replace an existing ScreenGui of the same name (default true)"), controller: S("boolean", false, "write Total_Controller (default true)") } },
    { name: "ui_screen_generate", description: "Generate a complete production screen with its runtime scripts in one call: kind = " + SCREEN_KINDS.join("|") + ". shop: window + category tabs + item cards + Total_Shop_Buy RemoteEvent + validated Total_ShopServer (charges leaderstats) + toasts. inventory: slot grid + detail panel + Equip/Drop remotes. hud: currency pills bound to leaderstats, health/XP bars bound to the Humanoid, hotbar, quick buttons that toggle Shop/Inventory/Settings, toast stack. main_menu: backdrop, title, buttons, currency, version. settings: persisted toggles + volume row. leaderboard: live top-10 from leaderstats. daily_rewards: 7 day cards + Total_Daily_Claim RemoteFunction server. quest_log, loading (ReplicatedFirst with preload progress), dialog (typewriter + choices), notification_stack (Total_Notify remote -> toasts). Everything uses the design tokens; edit afterwards with ui_set_* or ui_export_spec -> ui_from_spec.", params: { kind: S("string", true, SCREEN_KINDS.join("|")), name: S("string", false, "ScreenGui name"), title: S("string", false), subtitle: S("string", false), currency: S("string", false, "leaderstats name (default Coins)"), items: S("array", false, "shop/inventory items [{item,title,price,currency,rarity,icon,subtitle,badge}] or names"), tabs: S("array", false, "shop categories"), slots: S("number", false, "inventory slot count (default 20)"), stats: S("array", false, "hud currency stats"), buttons: S("array", false, "main_menu button labels"), toggles: S("array", false, "settings toggle labels"), rewards: S("array", false, "daily reward amounts (7)"), quests: S("array", false, "[{title,progress,reward,description}]"), tips: S("array", false, "loading tips"), speaker: S("string", false, "dialog speaker"), text: S("string", false, "dialog line"), choices: S("array", false, "dialog choices"), portrait: S("string", false, "dialog portrait image"), background_image: S("string", false, "main_menu art"), background_gradient: S("array", false), version: S("string", false), open_key: S("string", false, "toggle key (defaults: shop B, inventory E, settings P, quests Q, daily R)"), start_hidden: S("boolean", false, "windows start closed (default true)"), anchor: S("string", false, "notification_stack corner"), parent: S("string", false), replace: S("boolean", false), overwrite_server: S("boolean", false, "overwrite an existing server Script (default false)") } },
    { name: "ui_component_place", description: "Place ONE kit component into an existing GUI (same node schema as ui_from_spec: kind, text, size px, position/anchor, action, variant, children...). Sizes are relative to the parent's current size; parents with a layout ignore position.", params: { kind: S("string", true, "Button|IconButton|Panel|Window|Row|Column|Grid|ScrollList|Label|Title|Image|ItemCard|Slot|CurrencyPill|ProgressBar|Toggle|Input|Tabs|Divider|Spacer|Toasts"), parent: S("string", true, "GuiObject or ScreenGui path"), name: S("string", false), text: S("string", false), size: S("array", false, "[w,h] px"), position: S("array", false, "[x,y] px"), anchor: S("string", false), action: S("string", false), variant: S("string", false), image: S("string", false), value: S("number", false), item: S("string", false), children: S("array", false, "child nodes"), props: S("object", false, "extra node fields (rarity, price, tabs, placeholder, ...)") } },
    { name: "ui_apply_tokens", description: "Restyle an EXISTING GUI tree (any origin) to the design tokens: surfaces by luminance, buttons to Primary with contrast-safe text, labels to Text/TextMuted, fonts, corner radii, strokes, scrollbars. Images are kept unless keep_images=false.", params: { path: S("string", true, "ScreenGui or frame path"), keep_images: S("boolean", false, "default true") } },
    { name: "ui_make_responsive", description: "Make existing UI survive every screen: offset-only roots -> scale sizes (measured on 1280x720), UIAspectRatioConstraint + UISizeConstraint on roots, TextScaled + UITextSizeConstraint on every text, and an Total_Responsive LocalScript (safe insets, 44px touch targets, text floors on phones).", params: { path: S("string", false, "ScreenGui/frame/StarterGui (default StarterGui)"), max_scale: S("number", false, "max growth of roots on huge screens (default 1.5)") } },
    { name: "ui_gamepad_focus", description: "Controller support for existing UI: computes NextSelectionUp/Down/Left/Right between all buttons from their geometry, attaches a token-coloured selection cursor, marks the first focus. Pair with ui_states_wire so windows auto-select their first button on a gamepad.", params: { path: S("string", false, "ScreenGui or frame (default StarterGui)") } },
    { name: "ui_states_wire", description: "Give ANY existing UI runtime behaviour without writing code: writes the generic Total_Controller LocalScript into each ScreenGui - hover/press tweens, click sounds, Total_Action attributes (close | toggle:<Name> | open:<Name> | remote:<Name> | print:<msg>), Total_Window open/close animation, Total_OpenKey keybind, gamepad B closes. default_action=true gives unlabelled buttons a print action so clicks are visible in Output.", params: { path: S("string", false, "default StarterGui"), default_action: S("boolean", false) } },
    { name: "ui_audit", description: "Design QA report for a GUI tree: text contrast (WCAG ratios), tiny/unbounded text, touch targets <36px, offset-only roots, overlapping siblings, empty images, static scroll canvases, palette drift from the tokens, inconsistent corners, ZIndex Global, screens without runtime scripts. Returns issues with a fix hint each and a 0-100 score. Run after every screen and before hand-off.", params: { path: S("string", false, "ScreenGui/frame/StarterGui (default StarterGui)"), limit: S("number", false, "max issues listed (default 60)") } },
    { name: "ui_export_spec", description: "Reverse a GUI tree into a ui_from_spec JSON tree (kinds, px sizes/positions on 1280x720, text, colours, images, layouts, actions) so you can tweak and rebuild it, or copy a layout to another screen.", params: { path: S("string", true, "ScreenGui or GuiObject"), limit: S("number", false, "max nodes (default 400)") } },
    { name: "ui_preview", description: "Stage a screen for a screenshot in edit mode: enables StarterGui.ShowDevelopmentGui, shows hidden windows, optional device scale (phone 0.55 / tablet 0.8 / desktop 1 / console 1.15) via a temporary Total_PreviewScale. Follow with total_screenshot {target:'studio'}; call again with restore:true before shipping.", params: { path: S("string", true, "ScreenGui or window path"), device: S("string", false, "phone|tablet|desktop|console"), visible: S("boolean", false, "default true"), restore: S("boolean", false, "remove preview scale") } },
  ];

  function buildDesign(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))"; return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + (e && e.message ? e.message : e) };
    }
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = buildDesign(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const have = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!have.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.DESIGN_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.DESIGN_PRESETS = PRESET_NAMES.slice();
  RobloxScriptSkills.DESIGN_SCREENS = SCREEN_KINDS.slice();
  // Exposed for tests: the Luau that gets written into the place.
  RobloxScriptSkills.DESIGN_LUA = { UIKit: UIKIT_SRC, Responsive: RESPONSIVE_SRC, Controller: CONTROLLER_SRC, HudFeed: HUD_FEED_SRC, LeaderboardFeed: LEADERBOARD_FEED_SRC, NotifyFeed: NOTIFY_FEED_SRC, Loading: LOADING_SRC, DailyClient: DAILY_CLIENT_SRC, SettingsStore: SETTINGS_STORE_SRC, ShopServer: shopServerSource(defaultItems(3, "Coins")), DailyServer: dailyServerSource([1, 2, 3]), Tokens: tokensModuleSource(DEFAULT_TOKENS) };
  RobloxScriptSkills.designTokens = tokensFrom;
  RobloxScriptSkills.designScreenSpec = screenSpec;
})();
