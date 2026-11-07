// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript ART DIRECTION pack (1.78.0) - cinematic / stylised GUIs, layered
// on RobloxScriptSkills exactly like studio_cutscene.js.
//
// Why: the design kit (design_tokens_set / ui_from_spec / ui_screen_generate)
// is an APP kit - one palette, one Enum.Font, rounded panels and pills. A
// Hollow-Knight-style title screen is 80% things the kit cannot express:
// ornaments and image assets, glowing serif capitals with letter spacing,
// ambient ink motes, light rays, a vignette, flourish selection markers, an
// intro fade. This pack adds exactly those primitives and one builder that
// composes them:
//
//   ui_art_theme_set / ui_art_theme_get   named looks (hollow, dark_fantasy, arcane,
//                                         scifi, cartoon, horror, royal, minimal_lux,
//                                         pixel) + any override, custom font assets
//   ui_texture_create                     procedural textures drawn pixel by pixel with
//                                         EditableImage (glow, soft_circle, ring, vignette,
//                                         noise, fog, gradient_linear/radial, sparkle,
//                                         divider, flourish, frame_border, rays, grain)
//                                         and PUBLISHED as image assets through
//                                         AssetService:CreateAssetAsync (cached in
//                                         ReplicatedStorage.Total_Art.Textures); when
//                                         publishing is not allowed in the current
//                                         context the texture stays a live in-memory
//                                         preview and the result says so honestly.
//   ui_image_find                         free decals from the Creator Store
//                                         (InsertService:GetFreeDecals)
//   ui_font_set                           any Enum.Font family with weight / style, or a
//                                         custom font asset id, uppercase, tracking
//   ui_text_fx                            layered glow, shadow, outline, gradient,
//                                         letter spacing, pulse - on any text
//   ui_decor_add                          vignette, backdrop, rays, particles, fog,
//                                         divider, frame, corner_ornaments, markers,
//                                         glow_blob, grain - on any GUI
//   ui_art_build                          a whole cinematic screen (backdrop + title +
//                                         menu + footer + extras + intro) with its
//                                         motion / menu controllers
//   ui_art_restyle                        re-dress an existing ScreenGui (fonts, colours,
//                                         strokes, frames, vignette, particles)
//
// Image sources accepted everywhere an image is taken: a number / "rbxassetid://N",
// "store:<query>" (first free decal hit), "tex:<kind>" (generated texture), "" (none).
(function () {
  "use strict";
  if (typeof RobloxScriptSkills === "undefined" || !RobloxScriptSkills || typeof RobloxScriptSkills.buildLuau !== "function") return;
  if (RobloxScriptSkills.ARTUI_VERSION) return;

  const VERSION = "1.78.0";
  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  const nn = (v, d = 0) => { const x = Number(v); return isFinite(x) ? String(x) : String(d); };
  const bb = (v, d = false) => (v === undefined || v === null || v === "" ? (d ? "true" : "false") : (v === true || v === "true" || v === 1 || v === "1" || v === "yes") ? "true" : "false");
  const ident = (v, d) => { const s = String(v || d || "Art").replace(/[^A-Za-z0-9_]/g, ""); return /^[A-Za-z_]/.test(s) ? s : "_" + s; };
  const num = (v) => { const x = Number(v); return isFinite(x) ? x : null; };
  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const NAMED = { white: "#ffffff", black: "#000000", gold: "#d4af37", silver: "#c0c0c0", bone: "#e8e4d8", ink: "#05060a", crimson: "#b3172b", blood: "#7a0f1a", cyan: "#22d3ee", teal: "#14b8a6", violet: "#7c5cff", purple: "#6d28d9", amber: "#f59e0b", orange: "#f97316", lime: "#84cc16", green: "#22c55e", blue: "#3b82f6", pink: "#ec4899", grey: "#808080", gray: "#808080" };
  // Any colour notation -> "#rrggbb" or null.
  function hex(v) {
    if (v == null || v === "") return null;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (NAMED[s]) return NAMED[s];
      const m = s.match(/^#?([0-9a-f]{6})$/); if (m) return "#" + m[1];
      const m3 = s.match(/^#?([0-9a-f]{3})$/); if (m3) return "#" + m3[1].split("").map((c) => c + c).join("");
      const p = s.split(/[\s,]+/).map(Number); if (p.length >= 3 && p.every(isFinite)) v = p; else return null;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) v = [v.r, v.g, v.b];
    if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => isFinite(Number(x)))) {
      let a = v.slice(0, 3).map(Number); if (a.every((x) => x <= 1)) a = a.map((x) => x * 255);
      return "#" + a.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
    }
    return null;
  }
  const hexQ = (v, d) => { const h = hex(v) || hex(d); return h ? q(h) : "nil"; };
  const imgQ = (v) => (v == null ? "nil" : q(typeof v === "number" ? String(v) : String(v)));
  const FONT_WEIGHTS = { thin: "Thin", extralight: "ExtraLight", light: "Light", regular: "Regular", normal: "Regular", medium: "Medium", semibold: "SemiBold", bold: "Bold", extrabold: "ExtraBold", heavy: "Heavy", black: "Heavy" };
  const weightQ = (v, d) => { if (v == null || v === "") return d ? q(d) : "nil"; const n = Number(v); if (isFinite(n)) return String(n); return q(FONT_WEIGHTS[String(v).replace(/[^a-z]/gi, "").toLowerCase()] || "Regular"); };
  const FONT_NAMES = ["Garamond", "Bodoni", "Antique", "Fantasy", "Merriweather", "Fondamento", "GrenzeGotisch", "Creepster", "SpecialElite", "Michroma", "Sarpanch", "Jura", "Oswald", "JosefinSans", "Nunito", "Ubuntu", "TitilliumWeb", "Roboto", "RobotoCondensed", "RobotoMono", "FredokaOne", "LuckiestGuy", "Bangers", "Cartoon", "PermanentMarker", "Kalam", "PatrickHand", "IndieFlower", "AmaticSC", "DenkOne", "Arcade", "Code", "SciFi", "Highway", "Gotham", "GothamMedium", "GothamBold", "GothamBlack", "BuilderSans", "BuilderSansMedium", "BuilderSansBold", "BuilderSansExtraBold", "SourceSans", "SourceSansBold", "SourceSansSemibold", "SourceSansLight", "Arial", "ArialBold"];
  const THEME_IDS = ["hollow", "dark_fantasy", "arcane", "scifi", "cartoon", "horror", "royal", "minimal_lux", "pixel"];
  const TEX_KINDS = ["glow", "soft_circle", "ring", "vignette", "noise", "fog", "gradient_linear", "gradient_radial", "sparkle", "divider", "flourish", "frame_border", "rays", "grain"];
  const DECOR_KINDS = ["vignette", "backdrop", "rays", "particles", "fog", "divider", "frame", "corner_ornaments", "markers", "glow_blob", "grain"];

  // ── LocalScript sources (plain Luau, Lua-5.4-safe for the simulator) ────────
  // Total_ArtMotion: ambient motion for anything carrying the TotalMotion
  // attribute (pulse | drift | sway | spin | breathe) + keeps a 1280x720 canvas
  // fitted to the viewport (Frame with attribute TotalCanvas and a UIScale).
  const MOTION_SRC = [
    "-- TotalScript art pack " + VERSION + " - ambient motion + canvas fit (generated by ui_art_build / ui_decor_add)",
    "local RunService = game:GetService(\"RunService\")",
    "local gui = script.Parent",
    "local items = {}",
    "local function scan()",
    "  items = {}",
    "  for _, d in ipairs(gui:GetDescendants()) do",
    "    local kind = d:GetAttribute(\"TotalMotion\")",
    "    if kind and d:IsA(\"GuiObject\") then",
    "      local base = {kind = kind, obj = d, speed = tonumber(d:GetAttribute(\"MotionSpeed\")) or 1, amp = tonumber(d:GetAttribute(\"MotionAmp\")) or 1, phase = math.random() * 6.283}",
    "      base.pos = d.Position base.rot = d.Rotation",
    "      base.stroke = d:FindFirstChildOfClass(\"UIStroke\")",
    "      base.scale = d:FindFirstChildOfClass(\"UIScale\")",
    "      if d:IsA(\"ImageLabel\") or d:IsA(\"ImageButton\") then base.t = d.ImageTransparency elseif d:IsA(\"TextLabel\") or d:IsA(\"TextButton\") then base.t = d.TextTransparency else base.t = d.BackgroundTransparency end",
    "      if base.stroke then base.st = base.stroke.Transparency end",
    "      items[#items + 1] = base",
    "    end",
    "  end",
    "end",
    "local function fitCanvas()",
    "  local cam = workspace.CurrentCamera",
    "  if not cam then return end",
    "  local vs = cam.ViewportSize",
    "  for _, d in ipairs(gui:GetDescendants()) do",
    "    local spec = d:GetAttribute(\"TotalCanvas\")",
    "    if spec and d:IsA(\"GuiObject\") then",
    "      local w, h = tostring(spec):match(\"^(%d+)x(%d+)$\")",
    "      w, h = tonumber(w) or 1280, tonumber(h) or 720",
    "      local sc = d:FindFirstChildOfClass(\"UIScale\")",
    "      if sc and vs.X > 0 and vs.Y > 0 then sc.Scale = math.min(vs.X / w, vs.Y / h) end",
    "    end",
    "  end",
    "end",
    "scan() fitCanvas()",
    "gui.DescendantAdded:Connect(function() task.defer(scan) end)",
    "local cam = workspace.CurrentCamera",
    "if cam then cam:GetPropertyChangedSignal(\"ViewportSize\"):Connect(fitCanvas) end",
    "RunService.RenderStepped:Connect(function()",
    "  local t = os.clock()",
    "  for _, it in ipairs(items) do",
    "    local o = it.obj",
    "    if o.Parent then",
    "      local w = math.sin(t * it.speed + it.phase)",
    "      if it.kind == \"pulse\" then",
    "        local tr = math.clamp(it.t + (w * 0.5 + 0.5) * 0.35 * it.amp, 0, 1)",
    "        if o:IsA(\"ImageLabel\") or o:IsA(\"ImageButton\") then o.ImageTransparency = tr elseif o:IsA(\"TextLabel\") or o:IsA(\"TextButton\") then o.TextTransparency = tr else o.BackgroundTransparency = tr end",
    "        if it.stroke then it.stroke.Transparency = math.clamp(it.st + (w * 0.5 + 0.5) * 0.4 * it.amp, 0, 1) end",
    "      elseif it.kind == \"drift\" then",
    "        o.Position = it.pos + UDim2.new(0, w * 18 * it.amp, 0, math.cos(t * it.speed * 0.7 + it.phase) * 10 * it.amp)",
    "      elseif it.kind == \"sway\" then",
    "        o.Rotation = it.rot + w * 2.5 * it.amp",
    "      elseif it.kind == \"spin\" then",
    "        o.Rotation = it.rot + (t * 12 * it.speed) % 360",
    "      elseif it.kind == \"breathe\" and it.scale then",
    "        it.scale.Scale = 1 + (w * 0.5 + 0.5) * 0.04 * it.amp",
    "      end",
    "    end",
    "  end",
    "end)",
  ].join("\n");

  // Total_ArtParticles: motes / embers / snow / sparks inside its parent frame.
  const PARTICLES_SRC = [
    "-- TotalScript art pack " + VERSION + " - ambient particles (attributes on the parent frame: Count, Color, Image, SizeMin, SizeMax, Speed, Direction, Drift, Opacity)",
    "local RunService = game:GetService(\"RunService\")",
    "local holder = script.Parent",
    "local count = math.clamp(tonumber(holder:GetAttribute(\"Count\")) or 40, 1, 400)",
    "local color = holder:GetAttribute(\"Color\") or Color3.new(0, 0, 0)",
    "local image = tostring(holder:GetAttribute(\"Image\") or \"\")",
    "local sMin = tonumber(holder:GetAttribute(\"SizeMin\")) or 3",
    "local sMax = tonumber(holder:GetAttribute(\"SizeMax\")) or 9",
    "local speed = tonumber(holder:GetAttribute(\"Speed\")) or 0.05",
    "local dir = tostring(holder:GetAttribute(\"Direction\") or \"up\")",
    "local drift = tonumber(holder:GetAttribute(\"Drift\")) or 0.02",
    "local opacity = math.clamp(tonumber(holder:GetAttribute(\"Opacity\")) or 0.85, 0, 1)",
    "local rng = Random.new()",
    "local parts = {}",
    "local function make(i)",
    "  local p",
    "  if image ~= \"\" then p = Instance.new(\"ImageLabel\") p.Image = image p.ImageColor3 = color p.BackgroundTransparency = 1",
    "  else p = Instance.new(\"Frame\") p.BackgroundColor3 = color p.BorderSizePixel = 0 local c = Instance.new(\"UICorner\") c.CornerRadius = UDim.new(1, 0) c.Parent = p end",
    "  p.Name = \"P\" .. i",
    "  p.AnchorPoint = Vector2.new(0.5, 0.5)",
    "  p.ZIndex = holder.ZIndex",
    "  p.Parent = holder",
    "  return p",
    "end",
    "local function reset(it, fresh)",
    "  it.size = rng:NextNumber(sMin, sMax)",
    "  it.x = rng:NextNumber(0, 1)",
    "  it.life = rng:NextNumber(0.5, 1)",
    "  it.phase = rng:NextNumber(0, 6.283)",
    "  it.v = speed * rng:NextNumber(0.5, 1.4)",
    "  if fresh then it.y = rng:NextNumber(0, 1) elseif dir == \"down\" then it.y = -0.05 elseif dir == \"drift\" then it.y = rng:NextNumber(0, 1) it.x = -0.05 else it.y = 1.05 end",
    "  it.obj.Size = UDim2.new(0, it.size, 0, it.size)",
    "end",
    "for i = 1, count do local it = {obj = make(i)} reset(it, true) parts[i] = it end",
    "local last = os.clock()",
    "RunService.RenderStepped:Connect(function()",
    "  local now = os.clock()",
    "  local dt = math.min(0.1, now - last) last = now",
    "  for _, it in ipairs(parts) do",
    "    if dir == \"down\" then it.y = it.y + it.v * dt elseif dir == \"drift\" then it.x = it.x + it.v * dt else it.y = it.y - it.v * dt end",
    "    local sway = math.sin(now * 0.8 + it.phase) * drift",
    "    local x = (dir == \"drift\") and it.x or (it.x + sway)",
    "    local y = (dir == \"drift\") and (it.y + sway) or it.y",
    "    if y < -0.06 or y > 1.06 or x > 1.06 or x < -0.08 then reset(it, false) x, y = it.x, it.y end",
    "    local edge = math.min(1, math.min(y + 0.06, 1.06 - y) * 8)",
    "    local a = 1 - opacity * it.life * math.clamp(edge, 0, 1)",
    "    it.obj.Position = UDim2.new(x, 0, y, 0)",
    "    if it.obj:IsA(\"ImageLabel\") then it.obj.ImageTransparency = a else it.obj.BackgroundTransparency = a end",
    "  end",
    "end)",
  ].join("\n");

  // Total_ArtMenu: hover / focus / keyboard / gamepad for TotalMenuItem buttons,
  // flourish markers, intro fade, actions.
  const MENU_SRC = [
    "-- TotalScript art pack " + VERSION + " - menu controller (hover, markers, keyboard / gamepad, actions, intro fade)",
    "local TweenService = game:GetService(\"TweenService\")",
    "local UserInputService = game:GetService(\"UserInputService\")",
    "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")",
    "local SoundService = game:GetService(\"SoundService\")",
    "local gui = script.Parent",
    "local accent = gui:GetAttribute(\"Accent\") or Color3.new(1, 1, 1)",
    "local textColor = gui:GetAttribute(\"TextColor\") or Color3.new(0.9, 0.9, 0.9)",
    "local hoverSound = tostring(gui:GetAttribute(\"HoverSound\") or \"\")",
    "local clickSound = tostring(gui:GetAttribute(\"ClickSound\") or \"\")",
    "local function play(uri) if uri == \"\" then return end local s = Instance.new(\"Sound\") s.SoundId = uri s.Volume = 0.5 s.Parent = SoundService s:Play() s.Ended:Connect(function() s:Destroy() end) end",
    "local items = {}",
    "for _, d in ipairs(gui:GetDescendants()) do if d:GetAttribute(\"TotalMenuItem\") and d:IsA(\"GuiButton\") then items[#items + 1] = d end end",
    "table.sort(items, function(a, b) return (tonumber(a:GetAttribute(\"TotalMenuItem\")) or 0) < (tonumber(b:GetAttribute(\"TotalMenuItem\")) or 0) end)",
    "local selected = nil",
    "local function markers(btn) return btn:FindFirstChild(\"MarkerL\"), btn:FindFirstChild(\"MarkerR\") end",
    "local function setState(btn, on)",
    "  local ti = TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)",
    "  local scale = btn:FindFirstChildOfClass(\"UIScale\")",
    "  if scale then TweenService:Create(scale, ti, {Scale = on and 1.06 or 1}):Play() end",
    "  if btn:IsA(\"TextButton\") then TweenService:Create(btn, ti, {TextColor3 = on and accent or textColor}):Play() end",
    "  local stroke = btn:FindFirstChildOfClass(\"UIStroke\")",
    "  if stroke then TweenService:Create(stroke, ti, {Transparency = on and 0.35 or 1}):Play() end",
    "  local l, r = markers(btn)",
    "  for _, m in ipairs({l, r}) do",
    "    if m then",
    "      local goal = {}",
    "      if m:IsA(\"ImageLabel\") then goal.ImageTransparency = on and 0 or 1 else goal.BackgroundTransparency = on and 0 or 1 end",
    "      local base = m:GetAttribute(\"BasePos\") if not base then m:SetAttribute(\"BasePos\", m.Position) base = m.Position end",
    "      local dx = (m.Name == \"MarkerL\") and -10 or 10",
    "      goal.Position = on and base or (base + UDim2.new(0, dx, 0, 0))",
    "      TweenService:Create(m, ti, goal):Play()",
    "    end",
    "  end",
    "end",
    "local function select(btn, silent)",
    "  if selected == btn then return end",
    "  if selected then setState(selected, false) end",
    "  selected = btn",
    "  if btn then setState(btn, true) if not silent then play(hoverSound) end end",
    "end",
    "local function doAction(btn)",
    "  play(clickSound)",
    "  local action = tostring(btn:GetAttribute(\"Action\") or \"\")",
    "  local bus = ReplicatedStorage:FindFirstChild(\"Total_Art\") and ReplicatedStorage.Total_Art:FindFirstChild(\"MenuSelected\")",
    "  if bus then bus:Fire(gui.Name, btn.Name, action) end",
    "  local kind, arg = action:match(\"^(%w+):(.*)$\")",
    "  kind = kind or action",
    "  if kind == \"close\" then gui.Enabled = false",
    "  elseif kind == \"open\" or kind == \"toggle\" then",
    "    local target = gui.Parent and gui.Parent:FindFirstChild(arg or \"\") or gui:FindFirstChild(arg or \"\", true)",
    "    if target then",
    "      if target:IsA(\"LayerCollector\") then target.Enabled = (kind == \"open\") and true or not target.Enabled",
    "      elseif target:IsA(\"GuiObject\") then target.Visible = (kind == \"open\") and true or not target.Visible end",
    "      if kind == \"open\" and btn:GetAttribute(\"CloseSelf\") then gui.Enabled = false end",
    "    end",
    "  elseif kind == \"remote\" then",
    "    local r = ReplicatedStorage:FindFirstChild(arg or \"\", true)",
    "    if r and r:IsA(\"RemoteEvent\") then r:FireServer(btn.Name) end",
    "  elseif kind == \"print\" then print(arg or btn.Name)",
    "  elseif kind == \"quit\" then print(\"[TotalArt] quit requested from \" .. gui.Name)",
    "  end",
    "end",
    "for i, btn in ipairs(items) do",
    "  setState(btn, false)",
    "  btn.MouseEnter:Connect(function() select(btn) end)",
    "  btn.SelectionGained:Connect(function() select(btn) end)",
    "  btn.Activated:Connect(function() doAction(btn) end)",
    "end",
    "UserInputService.InputBegan:Connect(function(input, gp)",
    "  if gp or not gui.Enabled or #items == 0 then return end",
    "  local k = input.KeyCode",
    "  local idx = 0 for i, b in ipairs(items) do if b == selected then idx = i end end",
    "  if k == Enum.KeyCode.Down or k == Enum.KeyCode.S or k == Enum.KeyCode.DPadDown then select(items[idx % #items + 1])",
    "  elseif k == Enum.KeyCode.Up or k == Enum.KeyCode.W or k == Enum.KeyCode.DPadUp then select(items[(idx - 2) % #items + 1])",
    "  elseif (k == Enum.KeyCode.Return or k == Enum.KeyCode.Space or k == Enum.KeyCode.ButtonA) and selected then doAction(selected) end",
    "end)",
    "local fade = gui:FindFirstChild(\"Fade\", true)",
    "if fade and fade:IsA(\"GuiObject\") then",
    "  fade.Visible = true fade.BackgroundTransparency = 0",
    "  local tw = TweenService:Create(fade, TweenInfo.new(tonumber(gui:GetAttribute(\"IntroFade\")) or 1.4, Enum.EasingStyle.Sine, Enum.EasingDirection.Out), {BackgroundTransparency = 1})",
    "  tw:Play() tw.Completed:Connect(function() fade.Visible = false end)",
    "end",
    "if gui:GetAttribute(\"SelectFirst\") ~= false and items[1] then task.delay(0.2, function() select(items[1], true) end) end",
  ].join("\n");

  // ── ui_art_build: the cinematic screen builder ──────────────────────────────
  // spec (JS object, JSON-shipped to Luau):
  // { theme?, name?, colors?:{accent,text,glow,ornament,backdrop,backdrop2,panel,particles},
  //   font?:{name, weight, asset_id, tracking, uppercase},
  //   backdrop?:{image?, tint?, transparency?, gradient?:true, rays?:true, fog?:true, particles?:true|{count,color,direction,image,size_min,size_max}, vignette?:true, grain?:false},
  //   title?:{text, image?, size?, y?, tracking?, glow?, glow_size?, ornament_top?:true|image, ornament_bottom?:true|image, emblem?:image, subtitle?, subtitle_size?},
  //   menu?:{items:[{label, action?, name?}], y?, gap?, size?, marker?, align?:'center'|'left', x?},
  //   footer?:[{kind:'text'|'image'|'icons', text?, image?, images?:[...], colors?:[...], corner?:'bottom-left'|'bottom-right'|'top-left'|'top-right', size?, margin?}],
  //   extras?:[{kind:'text'|'image'|'divider'|'frame'|'glow', x,y,w,h,text?,image?,size?,color?,rotation?,z?}],
  //   intro?:{fade?:seconds, select_first?:bool}, sounds?:{hover, click} }
  const ART_BUILD = [
    "local function artBuild(spec,parentPath,replace)",
    " local t=themeGet(spec.theme) if type(spec.colors)=='table' then for k,v in pairs(spec.colors) do if type(v)=='string' then t[k]=v end end end",
    " local font=type(spec.font)=='table' and spec.font or {} if font.name then t.font=font.name end if font.weight then t.weight=font.weight end if font.asset_id then t.fontAssetId=font.asset_id end if font.tracking~=nil then t.tracking=font.tracking end if font.uppercase~=nil then t.uppercase=font.uppercase end",
    " local face,fam=themeFont(t) local bold=themeFont(t,math.min(900,(tonumber(t.weight) or 400)+100))",
    " local parent=resolve(parentPath) or StarterGui local name=tostring(spec.name or 'ArtScreen')",
    " local old=parent:FindFirstChild(name) if old then if replace==false then error('ScreenGui '..name..' already exists - pass replace:true') end old:Destroy() end",
    " local gui=mk('ScreenGui',name,nil,{IgnoreGuiInset=true,ResetOnSpawn=false,ZIndexBehavior=Enum.ZIndexBehavior.Sibling,DisplayOrder=tonumber(spec.display_order) or 10})",
    " gui:SetAttribute('TotalArt',ART_VERSION) gui:SetAttribute('ArtTheme',t.id) gui:SetAttribute('Accent',themeColor(t,'accent')) gui:SetAttribute('TextColor',themeColor(t,'text'))",
    " local bd=type(spec.backdrop)=='table' and spec.backdrop or {}",
    " local back=mk('Frame','Backdrop',gui,{BackgroundColor3=themeColor(t,'backdrop2'),BorderSizePixel=0,Size=UDim2.new(1,0,1,0),ZIndex=1})",
    " local notes={}",
    " if bd.image then local uri,note=imageUri(bd.image,t) if uri then decorBackdrop(back,t,uri,bd.tint and hexColor(bd.tint) or nil,tonumber(bd.transparency) or 0.1,1) notes[#notes+1]='backdrop image '..uri else notes[#notes+1]='backdrop image skipped: '..tostring(note) end end",
    " if bd.gradient~=false then local tex=texture('gradient_radial',256,themeColor(t,'backdrop'),themeColor(t,'backdrop2'),{softness=0.4},true,false) texNote(tex) if tex.uri or tex.live then local g=mk('ImageLabel','Light',back,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0.5,0,0.42,0),Size=UDim2.new(1.6,0,2.2,0),ZIndex=2,ImageTransparency=bd.image and 0.55 or 0.1}) applyTex(g,tex) else local gr=Instance.new('UIGradient') gr.Rotation=90 gr.Color=ColorSequence.new(themeColor(t,'backdrop'),themeColor(t,'backdrop2')) gr.Parent=back end end",
    " if bd.fog then decorFog(back,t,themeColor(t,'muted'),0.6,3) end",
    " if (bd.rays==nil and t.rays) or bd.rays then decorRays(back,t,themeColor(t,'glow'),5,0.45,4) end",
    " if bd.particles~=false then local pc=type(bd.particles)=='table' and bd.particles or {} decorParticles(back,t,pc.color and hexColor(pc.color) or themeColor(t,'particles'),tonumber(pc.count) or 36,pc.image and (imageUri(pc.image,t) or '') or '',pc.direction or ((t.id=='hollow' or t.id=='horror') and 'down' or 'up'),tonumber(pc.speed) or 0.04,tonumber(pc.size_min) or 3,tonumber(pc.size_max) or 9,5) end",
    " if bd.vignette~=false then decorVignette(back,t,themeColor(t,'backdrop2'),0.85,7) end",
    " if bd.grain then decorGrain(back,t,1,8) end",
    " local canvas=mk('Frame','Canvas',gui,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0.5,0,0.5,0),Size=UDim2.new(0,1280,0,720),ZIndex=10}) canvas:SetAttribute('TotalCanvas','1280x720')",
    " local sc=Instance.new('UIScale') sc.Parent=canvas local cam=workspace.CurrentCamera if cam and cam.ViewportSize.X>0 then sc.Scale=math.min(cam.ViewportSize.X/1280,cam.ViewportSize.Y/720) end",
    " local built={}",
    " local ti=type(spec.title)=='table' and spec.title or (type(spec.title)=='string' and {text=spec.title} or nil)",
    " if ti then local ty=tonumber(ti.y) or 215 local tsize=tonumber(ti.size) or 96 local tf=mk('Frame','Title',canvas,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0,640,0,ty),Size=UDim2.new(0,980,0,260),ZIndex=11})",
    "  if ti.glow~=false then decorGlowBlob(tf,t,themeColor(t,'glow'),900,360,0.55,11,'TitleGlow') end",
    "  if ti.image then local uri,note=imageUri(ti.image,t) if uri then mk('ImageLabel','TitleImage',tf,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0.5,0,0.5,0),Size=UDim2.new(1,0,1,0),ZIndex=14,Image=uri,ScaleType=Enum.ScaleType.Fit}) built[#built+1]='title image' else notes[#notes+1]='title image skipped: '..tostring(note) end end",
    "  if ti.text then local lbl=pxLabel(tf,'TitleText',tostring(ti.text),bold,tsize,themeColor(t,'text'),490,130,960,tsize*1.3,14) if t.uppercase and ti.uppercase~=false then lbl.Text=string.upper(lbl.Text) end local tr=tonumber(ti.tracking) or tonumber(t.tracking) or 0 if tr>0 then trackText(lbl,tr,bold) end if ti.glow~=false then textGlow(lbl,themeColor(t,'glow'),tonumber(ti.glow_size) or 14,4,true) for _,c in ipairs(lbl:GetChildren()) do if c:GetAttribute('TotalArtChar') then local s=Instance.new('UIStroke') s.Color=themeColor(t,'glow') s.Thickness=2 s.Transparency=0.45 s.Parent=c end end end built[#built+1]='title \"'..tostring(ti.text)..'\"' end",
    "  local function ornament(key,yy,rot) local v=ti[key] if v==nil or v==false then return end local uri=nil if type(v)=='string' then uri=imageUri(v,t) end if not uri then local tex=texture('divider',512,themeColor(t,'ornament'),themeColor(t,'ornament'),{thickness=0.02},true,false) texNote(tex) if tex.uri or tex.live then local img=mk('ImageLabel',key,tf,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0.5,0,0,yy),Size=UDim2.new(0,760,0,70),Rotation=rot,ZIndex=13,ScaleType=Enum.ScaleType.Fit}) applyTex(img,tex) else decorDivider(tf,t,themeColor(t,'ornament'),640,40,490,yy,13,key) end else mk('ImageLabel',key,tf,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0.5,0,0,yy),Size=UDim2.new(0,760,0,90),ZIndex=13,Image=uri,ScaleType=Enum.ScaleType.Fit}) end built[#built+1]=key end",
    "  ornament('ornament_top',40,0) ornament('ornament_bottom',225,180)",
    "  if ti.emblem then local uri,note=imageUri(ti.emblem,t) if uri then mk('ImageLabel','Emblem',tf,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0),Position=UDim2.new(0.5,0,0,215),Size=UDim2.new(0,70,0,90),ZIndex=15,Image=uri,ScaleType=Enum.ScaleType.Fit}) built[#built+1]='emblem' else notes[#notes+1]='emblem skipped: '..tostring(note) end end",
    "  if ti.subtitle then local sub=pxLabel(tf,'Subtitle',tostring(ti.subtitle),face,tonumber(ti.subtitle_size) or 24,themeColor(t,'muted'),490,245,800,34,14) if t.uppercase then sub.Text=string.upper(sub.Text) end end",
    " end",
    " local me=type(spec.menu)=='table' and spec.menu or nil",
    " if me and type(me.items)=='table' and #me.items>0 then local my=tonumber(me.y) or 520 local gap=tonumber(me.gap) or 14 local msize=tonumber(me.size) or 30 local menu=mk('Frame','Menu',canvas,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0,tonumber(me.x) or 640,0,my),Size=UDim2.new(0,560,0,#me.items*(msize+gap)),ZIndex=12})",
    "  local ll=Instance.new('UIListLayout') ll.FillDirection=Enum.FillDirection.Vertical ll.HorizontalAlignment=(me.align=='left') and Enum.HorizontalAlignment.Left or Enum.HorizontalAlignment.Center ll.VerticalAlignment=Enum.VerticalAlignment.Center ll.SortOrder=Enum.SortOrder.LayoutOrder ll.Padding=UDim.new(0,gap) ll.Parent=menu",
    "  for i,it in ipairs(me.items) do if type(it)=='string' then it={label=it} end local label=tostring(it.label or it.text or ('Item '..i)) local bname=tostring(it.name or label:gsub('[^%w]','')) if bname=='' then bname='Item'..i end",
    "   local b=mk('TextButton',bname,menu,{BackgroundTransparency=1,AutoButtonColor=false,Text=(t.uppercase and string.upper(label) or label),TextColor3=themeColor(t,'text'),TextSize=msize,Size=UDim2.new(0,420,0,msize+6),LayoutOrder=i,ZIndex=13,TextXAlignment=(me.align=='left') and Enum.TextXAlignment.Left or Enum.TextXAlignment.Center}) b.FontFace=bold b:SetAttribute('TotalMenuItem',i) b:SetAttribute('Action',tostring(it.action or ('print:'..label))) if it.close_self then b:SetAttribute('CloseSelf',true) end",
    "   local us=Instance.new('UIScale') us.Parent=b local st=Instance.new('UIStroke') st.ApplyStrokeMode=Enum.ApplyStrokeMode.Contextual st.Color=themeColor(t,'glow') st.Thickness=1.5 st.Transparency=1 st.Parent=b",
    "   if (me.marker or t.marker)~='none' then decorMarkers(b,t,themeColor(t,'accent'),me.marker or t.marker,msize*1.9,13) end",
    "  end built[#built+1]=#me.items..' menu items' end",
    " if type(spec.footer)=='table' then for i,f in ipairs(spec.footer) do local corner=tostring(f.corner or 'bottom-left') local m=tonumber(f.margin) or 40 local ax=(corner:find('right') and 1 or 0) local ay=(corner:find('top') and 0 or 1) local px=(ax==1) and (1280-m) or m local py=(ay==1) and (720-m) or m local fsize=tonumber(f.size) or 18",
    "  if f.kind=='image' and f.image then local uri=imageUri(f.image,t) if uri then mk('ImageLabel','Footer'..i,canvas,{BackgroundTransparency=1,AnchorPoint=Vector2.new(ax,ay),Position=UDim2.new(0,px,0,py),Size=UDim2.new(0,tonumber(f.width) or 90,0,tonumber(f.height) or 90),ZIndex=12,Image=uri,ScaleType=Enum.ScaleType.Fit}) end",
    "  elseif f.kind=='icons' then local row=mk('Frame','Footer'..i,canvas,{BackgroundTransparency=1,AnchorPoint=Vector2.new(ax,ay),Position=UDim2.new(0,px,0,py),Size=UDim2.new(0,200,0,fsize+4),ZIndex=12}) local rl=Instance.new('UIListLayout') rl.FillDirection=Enum.FillDirection.Horizontal rl.Padding=UDim.new(0,6) rl.HorizontalAlignment=(ax==1) and Enum.HorizontalAlignment.Right or Enum.HorizontalAlignment.Left rl.VerticalAlignment=Enum.VerticalAlignment.Center rl.Parent=row local imgs=type(f.images)=='table' and f.images or {} local cols=type(f.colors)=='table' and f.colors or {} for k=1,math.max(#imgs,#cols) do if imgs[k] then local uri=imageUri(imgs[k],t) if uri then mk('ImageLabel','Icon'..k,row,{BackgroundTransparency=1,Size=UDim2.new(0,fsize+4,0,fsize+4),LayoutOrder=k,ZIndex=12,Image=uri}) end else local d=mk('Frame','Icon'..k,row,{BackgroundColor3=hexColor(cols[k],themeColor(t,'accent')),BorderSizePixel=0,Size=UDim2.new(0,fsize,0,fsize),LayoutOrder=k,ZIndex=12}) local c=Instance.new('UICorner') c.CornerRadius=UDim.new(1,0) c.Parent=d end end",
    "  else local l=mk('TextLabel','Footer'..i,canvas,{BackgroundTransparency=1,Text=tostring(f.text or ''),TextColor3=themeColor(t,'muted'),TextSize=fsize,AnchorPoint=Vector2.new(ax,ay),Position=UDim2.new(0,px,0,py),Size=UDim2.new(0,360,0,fsize+6),ZIndex=12,TextXAlignment=(ax==1) and Enum.TextXAlignment.Right or Enum.TextXAlignment.Left}) l.FontFace=face end",
    " end built[#built+1]=#spec.footer..' footer item(s)' end",
    " if type(spec.extras)=='table' then for i,e in ipairs(spec.extras) do local x,y,w,h=tonumber(e.x) or 640,tonumber(e.y) or 360,tonumber(e.w) or 200,tonumber(e.h) or 40 local col=e.color and hexColor(e.color) or themeColor(t,'text') local z=tonumber(e.z) or 12",
    "  if e.kind=='image' and e.image then local uri=imageUri(e.image,t) if uri then mk('ImageLabel',tostring(e.name or ('Extra'..i)),canvas,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0,x,0,y),Size=UDim2.new(0,w,0,h),Rotation=tonumber(e.rotation) or 0,ZIndex=z,Image=uri,ScaleType=Enum.ScaleType.Fit,ImageColor3=e.color and col or Color3.new(1,1,1)}) end",
    "  elseif e.kind=='divider' then decorDivider(canvas,t,col,w,h,x,y,z,tostring(e.name or ('Extra'..i)))",
    "  elseif e.kind=='glow' then local g=decorGlowBlob(canvas,t,col,w,h,tonumber(e.intensity) or 0.6,z,tostring(e.name or ('Extra'..i))) if g then g.Position=UDim2.new(0,x,0,y) end",
    "  elseif e.kind=='frame' then local fr=mk('Frame',tostring(e.name or ('Extra'..i)),canvas,{BackgroundColor3=themeColor(t,'panel'),BackgroundTransparency=tonumber(e.transparency) or 0.25,BorderSizePixel=0,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0,x,0,y),Size=UDim2.new(0,w,0,h),ZIndex=z}) local c=Instance.new('UICorner') c.CornerRadius=UDim.new(0,tonumber(t.radius) or 0) c.Parent=fr decorFrame(fr,t,themeColor(t,'ornament'),z+1)",
    "  else local l=pxLabel(canvas,tostring(e.name or ('Extra'..i)),tostring(e.text or ''),(tonumber(e.size) or 20)>=28 and bold or face,tonumber(e.size) or 20,col,x,y,w,h,z) if e.uppercase or (t.uppercase and (tonumber(e.size) or 20)>=28) then l.Text=string.upper(l.Text) end if e.glow then textGlow(l,themeColor(t,'glow'),8,3,false) end end",
    " end built[#built+1]=#spec.extras..' extra(s)' end",
    " local intro=type(spec.intro)=='table' and spec.intro or {} if intro.fade~=false then local fd=mk('Frame','Fade',gui,{BackgroundColor3=Color3.new(0,0,0),BorderSizePixel=0,Size=UDim2.new(1,0,1,0),ZIndex=100,BackgroundTransparency=1,Visible=false}) gui:SetAttribute('IntroFade',tonumber(intro.fade) or 1.4) end if intro.select_first==false then gui:SetAttribute('SelectFirst',false) end",
    " if type(spec.sounds)=='table' then if spec.sounds.hover then gui:SetAttribute('HoverSound',imageUri(spec.sounds.hover,t) or tostring(spec.sounds.hover)) end if spec.sounds.click then gui:SetAttribute('ClickSound',imageUri(spec.sounds.click,t) or tostring(spec.sounds.click)) end end",
    " ensureScript(gui,'Total_ArtMotion',MOTION_SRC) if me then ensureScript(gui,'Total_ArtMenu',MENU_SRC) end artRoot()",
    " gui.Parent=parent",
    " return gui,t,fam,built,notes",
    "end",
  ].join("\n");

  // ── Luau library shared by every command ────────────────────────────────────
  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local ReplicatedStorage=game:GetService('ReplicatedStorage')",
    "local StarterGui=game:GetService('StarterGui')",
    "local AssetService=game:GetService('AssetService')",
    "local InsertService=game:GetService('InsertService')",
    "local TweenService=game:GetService('TweenService')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local ART_VERSION=" + q(VERSION),
    "local MOTION_SRC=" + q(MOTION_SRC),
    "local PARTICLES_SRC=" + q(PARTICLES_SRC),
    "local MENU_SRC=" + q(MENU_SRC),
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end",
    "local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end local cur=game for seg in p:gmatch('[^%.]+') do local nxt=nil if cur==game then local okS,s=pcall(function() return game:GetService(seg) end) if okS and s then nxt=s end if not nxt and seg:lower()=='workspace' then nxt=workspace end end if not nxt then nxt=cur:FindFirstChild(seg) end if not nxt then local w=cur:FindFirstChild('FX_'..seg) if w and w:GetAttribute('TotalArtFX') then nxt=w:FindFirstChild(seg) end end if not nxt then return nil end cur=nxt end return cur end",
    "local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('TotalScript art') end) return okW and w or nil end",
    "local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end",
    "local function folder(parent,name) local f=parent:FindFirstChild(name) if not f then f=Instance.new('Folder') f.Name=name f.Parent=parent end return f end",
    "local function fmt(n) n=tonumber(n) or 0 if math.abs(n-math.floor(n+0.5))<1e-6 then return tostring(math.floor(n+0.5)) end local s=string.format('%.3f',n) s=s:gsub('0+$','') s=s:gsub('%.$','') return s end",
    "local function hexColor(h,d) if typeof(h)=='Color3' then return h end if type(h)~='string' then return d end local s=h:gsub('#','') if #s~=6 then return d end local r,g,b=tonumber(s:sub(1,2),16),tonumber(s:sub(3,4),16),tonumber(s:sub(5,6),16) if not r or not g or not b then return d end return Color3.fromRGB(r,g,b) end",
    "local function hexOf(c) return string.format('#%02x%02x%02x',math.floor(c.R*255+0.5),math.floor(c.G*255+0.5),math.floor(c.B*255+0.5)) end",
    "local function mix(a,b,t) return Color3.new(a.R+(b.R-a.R)*t,a.G+(b.G-a.G)*t,a.B+(b.B-a.B)*t) end",
    // themes
    "local THEMES={",
    "hollow={label='Hollow - pale serif capitals with a soft glow, ink motes, grey cave light, flourish markers',font='Garamond',weight=600,accent='#f2f6f6',text='#dfe6e6',muted='#8d9797',glow='#d6e4e8',ornament='#e3eaea',backdrop='#2a2d31',backdrop2='#050607',panel='#121418',radius=2,marker='flourish',particles='#000000',uppercase=true,tracking=5,rays=true},",
    "dark_fantasy={label='Dark fantasy - parchment gold on near-black, embers, ornate frames',font='Fondamento',weight=700,accent='#e2b85a',text='#e8dcc0',muted='#8c7f66',glow='#ffb347',ornament='#c9a24a',backdrop='#1b1410',backdrop2='#060403',panel='#14100c',radius=3,marker='flourish',particles='#ff9a3c',uppercase=true,tracking=3,rays=false},",
    "arcane={label='Arcane - violet runes, cyan glow, drifting sparks',font='GrenzeGotisch',weight=600,accent='#9d7bff',text='#e6e0ff',muted='#8f86b3',glow='#6ee7ff',ornament='#b69cff',backdrop='#15102a',backdrop2='#05030c',panel='#120d24',radius=4,marker='diamond',particles='#8be9ff',uppercase=false,tracking=2,rays=true},",
    "scifi={label='Sci-fi - thin tech sans, cyan edges, scanlines, chevron markers',font='Michroma',weight=500,accent='#38e8ff',text='#d9f6ff',muted='#6f98a6',glow='#22d3ee',ornament='#38e8ff',backdrop='#07131c',backdrop2='#02070b',panel='#0a1620',radius=0,marker='chevron',particles='#38e8ff',uppercase=true,tracking=6,rays=false},",
    "cartoon={label='Cartoon - chunky rounded display font, bright outline, confetti',font='FredokaOne',weight=800,accent='#ffd93d',text='#ffffff',muted='#dbe4ff',glow='#ff8c42',ornament='#ffffff',backdrop='#2f6cff',backdrop2='#1f3fbf',panel='#1d47d6',radius=18,marker='dot',particles='#ffffff',uppercase=false,tracking=0,rays=true},",
    "horror={label='Horror - scratched serif, blood red on black, grain, slow pulse',font='Creepster',weight=400,accent='#b3172b',text='#cfc6c0',muted='#6b5f5a',glow='#7a0f1a',ornament='#5a0a12',backdrop='#120a0a',backdrop2='#030101',panel='#0e0707',radius=0,marker='dash',particles='#2a0608',uppercase=true,tracking=4,rays=false},",
    "royal={label='Royal - gold leaf on deep blue velvet, crests, double frames',font='Bodoni',weight=700,accent='#f0cf6a',text='#f6ecd2',muted='#a89a78',glow='#f0cf6a',ornament='#d4af37',backdrop='#101a3a',backdrop2='#050816',panel='#0d1430',radius=6,marker='flourish',particles='#f0cf6a',uppercase=true,tracking=4,rays=true},",
    "minimal_lux={label='Minimal luxury - hairline serif, ivory on charcoal, lots of air',font='Merriweather',weight=300,accent='#ffffff',text='#ece9e4',muted='#8a8784',glow='#ffffff',ornament='#bdb8b0',backdrop='#1c1c1e',backdrop2='#0a0a0b',panel='#161618',radius=0,marker='dash',particles='#ffffff',uppercase=true,tracking=8,rays=false},",
    "pixel={label='Pixel - arcade bitmap font, hard edges, scanlines, no glow blur',font='Arcade',weight=400,accent='#ffe66d',text='#f4f4f4',muted='#9aa0b0',glow='#ffe66d',ornament='#f4f4f4',backdrop='#1a1a2e',backdrop2='#0b0b16',panel='#16213e',radius=0,marker='chevron',particles='#ffe66d',uppercase=true,tracking=2,rays=false}}",
    "local THEME_ORDER={'hollow','dark_fantasy','arcane','scifi','cartoon','horror','royal','minimal_lux','pixel'}",
    "local function artRoot() local r=folder(ReplicatedStorage,'Total_Art') if not r:FindFirstChild('MenuSelected') then local b=Instance.new('BindableEvent') b.Name='MenuSelected' b.Parent=r end return r end",
    "local function texFolder() return folder(artRoot(),'Textures') end",
    "local function themeGet(id) local r=ReplicatedStorage:FindFirstChild('Total_Art') id=id or (r and r:GetAttribute('art_theme')) or 'hollow' if not THEMES[id] then id='hollow' end local t={} for k,v in pairs(THEMES[id]) do t[k]=v end t.id=id if r then for k,v in pairs(r:GetAttributes()) do local key=k:match('^art_(.+)$') if key and key~='theme' then if typeof(v)=='Color3' then v=hexOf(v) end t[key]=v end end end return t end",
    "local function themeColor(t,key,d) return hexColor(t[key],d or Color3.new(1,1,1)) end",
    // fonts
    "local WEIGHTS={[100]='Thin',[200]='ExtraLight',[300]='Light',[400]='Regular',[500]='Medium',[600]='SemiBold',[700]='Bold',[800]='ExtraBold',[900]='Heavy'}",
    "local function weightEnum(w) if typeof(w)=='EnumItem' then return w end if type(w)=='number' then w=WEIGHTS[math.clamp(math.floor(w/100+0.5)*100,100,900)] end local okE,e=pcall(function() return Enum.FontWeight[tostring(w or 'Regular')] end) if okE and e then return e end return Enum.FontWeight.Regular end",
    "local function fontFace(name,weight,style,assetId) local st=(tostring(style or ''):lower()=='italic') and Enum.FontStyle.Italic or Enum.FontStyle.Normal local w=weightEnum(weight) local id=tostring(assetId or '') id=(id:gsub('^rbxassetid://','')) if id~='' and id~='0' and id~='nil' then return Font.new('rbxassetid://'..id,w,st),'rbxassetid://'..id end local fam local okF=pcall(function() fam=Font.fromEnum(Enum.Font[tostring(name or 'GothamMedium')]).Family end) if not okF or not fam then fam=Font.fromEnum(Enum.Font.GothamMedium).Family end return Font.new(fam,w,st),fam end",
    "local function themeFont(t,weight) return fontFace(t.font,weight or t.weight,nil,t.fontAssetId) end",
    "local function isText(g) return g:IsA('TextLabel') or g:IsA('TextButton') or g:IsA('TextBox') end",
    // textures: procedural pixels
    "local function hash2(x,y,seed) local n=math.sin(x*127.1+y*311.7+(seed or 0)*74.7)*43758.5453 return n-math.floor(n) end",
    "local function vnoise(x,y,seed) local xi,yi=math.floor(x),math.floor(y) local xf,yf=x-xi,y-yi local u,v=xf*xf*(3-2*xf),yf*yf*(3-2*yf) local a,b,c,d=hash2(xi,yi,seed),hash2(xi+1,yi,seed),hash2(xi,yi+1,seed),hash2(xi+1,yi+1,seed) local ab=a+(b-a)*u local cd=c+(d-c)*u return ab+(cd-ab)*v end",
    "local function fbm(x,y,seed) return vnoise(x,y,seed)*0.5+vnoise(x*2.03,y*2.03,seed+1)*0.25+vnoise(x*4.07,y*4.07,seed+2)*0.125+vnoise(x*8.1,y*8.1,seed+3)*0.0625 end",
    "local function smooth(e0,e1,x) local t=math.clamp((x-e0)/math.max(1e-6,e1-e0),0,1) return t*t*(3-2*t) end",
    "local function newGrid(w,h) local g={} for i=1,w*h do g[i]=0 end return g end",
    "local function stamp(g,w,h,px,py,rad,val) local x0,x1=math.max(0,math.floor(px-rad)),math.min(w-1,math.ceil(px+rad)) local y0,y1=math.max(0,math.floor(py-rad)),math.min(h-1,math.ceil(py+rad)) for y=y0,y1 do for x=x0,x1 do local d=math.sqrt((x+0.5-px)^2+(y+0.5-py)^2) if d<rad then local a=val*(1-smooth(rad*0.55,rad,d)) local i=y*w+x+1 if a>g[i] then g[i]=a end end end end end",
    "local function curve(g,w,h,fn,n,rad,val) for i=0,n do local t=i/n local x,y,r=fn(t) stamp(g,w,h,x,y,(r or 1)*rad,val) end end",
    "local function spiral(g,w,h,cx,cy,R,turns,dirn,rad,val,start) curve(g,w,h,function(t) local a=(start or 0)+t*turns*6.283*dirn local r=R*(1-t*0.82) return cx+math.cos(a)*r,cy+math.sin(a)*r,1-t*0.55 end,math.floor(R*turns*6),rad,val) end",
    "local function makeImage(w,h,fn) local img=AssetService:CreateEditableImage({Size=Vector2.new(w,h)}) local buf=buffer.create(w*h*4) local idx=0 for y=0,h-1 do local v=(y+0.5)/h for x=0,w-1 do local u=(x+0.5)/w local r,gg,b,a=fn(u,v,x,y) buffer.writeu8(buf,idx,math.clamp(math.floor(r*255+0.5),0,255)) buffer.writeu8(buf,idx+1,math.clamp(math.floor(gg*255+0.5),0,255)) buffer.writeu8(buf,idx+2,math.clamp(math.floor(b*255+0.5),0,255)) buffer.writeu8(buf,idx+3,math.clamp(math.floor(a*255+0.5),0,255)) idx=idx+4 end end img:WritePixelsBuffer(Vector2.new(0,0),Vector2.new(w,h),buf) return img end",
    // kind -> pixel function. c1/c2 Color3, o = {intensity, softness, thickness, seed, count}
    "local function texFn(kind,w,h,c1,c2,o) local I=tonumber(o.intensity) or 1 local soft=tonumber(o.softness) or 0.5 local th=tonumber(o.thickness) or 0.06 local seed=tonumber(o.seed) or 7 local cnt=math.max(1,math.floor(tonumber(o.count) or 12))",
    " if kind=='glow' then return function(u,v) local d=math.sqrt((u-0.5)^2+(v-0.5)^2)*2 local a=math.clamp(1-d,0,1)^(1.2+soft*3) return c1.R,c1.G,c1.B,math.clamp(a*I,0,1) end",
    " elseif kind=='soft_circle' then return function(u,v) local d=math.sqrt((u-0.5)^2+(v-0.5)^2)*2 return c1.R,c1.G,c1.B,math.clamp((1-smooth(1-soft*0.9-0.02,0.98,d))*I,0,1) end",
    " elseif kind=='ring' then return function(u,v) local d=math.sqrt((u-0.5)^2+(v-0.5)^2)*2 local a=math.exp(-((d-(1-th*2-0.04))/math.max(0.01,th))^2) return c1.R,c1.G,c1.B,math.clamp(a*I,0,1) end",
    " elseif kind=='vignette' then return function(u,v) local d=math.sqrt((u-0.5)^2+((v-0.5)*1.15)^2)*1.6 local a=smooth(0.45+ (1-soft)*0.35,1.25,d) return c1.R,c1.G,c1.B,math.clamp(a*I,0,1) end",
    " elseif kind=='noise' then return function(u,v) local n=fbm(u*6,v*6,seed) return c1.R,c1.G,c1.B,math.clamp(n*I,0,1) end",
    " elseif kind=='grain' then return function(u,v,x,y) local n=hash2(x,y,seed) return c1.R,c1.G,c1.B,math.clamp(n*0.35*I,0,1) end",
    " elseif kind=='fog' then return function(u,v) local n=fbm(u*3+seed,v*3,seed) local d=math.sqrt((u-0.5)^2+(v-0.5)^2)*2 local a=math.clamp((n-0.25)*1.6,0,1)*math.clamp(1-d,0,1)^1.2 return c1.R,c1.G,c1.B,math.clamp(a*I,0,1) end",
    " elseif kind=='gradient_linear' then return function(u,v) local c=mix(c1,c2,v) return c.R,c.G,c.B,math.clamp(I,0,1) end",
    " elseif kind=='gradient_radial' then return function(u,v) local d=math.clamp(math.sqrt((u-0.5)^2+(v-0.5)^2)*2,0,1) local c=mix(c1,c2,d^(0.6+soft)) return c.R,c.G,c.B,math.clamp(I,0,1) end",
    " elseif kind=='sparkle' then return function(u,v) local x,y=(u-0.5)*2,(v-0.5)*2 local arm=math.max((1-math.abs(x))^6*(1-math.abs(y)*3),(1-math.abs(y))^6*(1-math.abs(x)*3)) local d=math.sqrt(x*x+y*y) local core=math.clamp(1-d*4,0,1) local a=math.clamp(math.max(arm,core)*I,0,1) return c1.R,c1.G,c1.B,a end",
    " elseif kind=='rays' then return function(u,v) local x,y=(u-0.5)*2,(v-0.5)*2 local ang=math.atan(y,x) local d=math.sqrt(x*x+y*y) local a=0 for i=1,cnt do local ca=(i/cnt)*6.283+hash2(i,seed,0)*0.5 local da=math.atan(math.sin(ang-ca),math.cos(ang-ca)) local wdt=0.05+hash2(i,seed,1)*0.08 a=math.max(a,math.exp(-(da/wdt)^2)*(0.5+hash2(i,seed,2)*0.5)) end a=a*math.clamp(1-d,0,1)^0.8 return c1.R,c1.G,c1.B,math.clamp(a*I,0,1) end",
    " else local g=newGrid(w,h) local rad=math.max(1,th*w*0.5)",
    "  if kind=='divider' then curve(g,w,h,function(t) local x=0.06+t*0.88 return x*w,h*0.5,1-math.abs(t-0.5)*1.4 end,w,rad,1) spiral(g,w,h,w*0.085,h*0.5,h*0.3,0.75,1,rad*0.8,0.9,3.1416) spiral(g,w,h,w*0.915,h*0.5,h*0.3,0.75,-1,rad*0.8,0.9,0) curve(g,w,h,function(t) local a=t*6.283 return w*0.5+math.cos(a)*h*0.17,h*0.5+math.sin(a)*h*0.17,1 end,60,rad*0.8,1) stamp(g,w,h,w*0.5,h*0.5,h*0.05,1)",
    "  elseif kind=='flourish' then spiral(g,w,h,w*0.3,h*0.5,h*0.36,1.1,1,rad,1,3.1416) curve(g,w,h,function(t) return w*(0.3+t*0.62),h*(0.5-0.12*math.sin(t*3.1416)),1-t*0.6 end,w,rad,1) stamp(g,w,h,w*0.92,h*0.5,rad*1.5,1)",
    "  elseif kind=='frame_border' then local m=w*0.08 curve(g,w,h,function(t) local p=t*4 local x,y if p<1 then x,y=m+(w-2*m)*p,m elseif p<2 then x,y=w-m,m+(h-2*m)*(p-1) elseif p<3 then x,y=w-m-(w-2*m)*(p-2),h-m else x,y=m,h-m-(h-2*m)*(p-3) end return x,y,1 end,w*4,rad,1) local m2=m*1.6 curve(g,w,h,function(t) local p=t*4 local x,y if p<1 then x,y=m2+(w-2*m2)*p,m2 elseif p<2 then x,y=w-m2,m2+(h-2*m2)*(p-1) elseif p<3 then x,y=w-m2-(w-2*m2)*(p-2),h-m2 else x,y=m2,h-m2-(h-2*m2)*(p-3) end return x,y,1 end,w*4,rad*0.6,0.7) for _,c in ipairs({{m,m,1,1},{w-m,m,-1,1},{w-m,h-m,-1,-1},{m,h-m,1,-1}}) do spiral(g,w,h,c[1]+c[3]*w*0.05,c[2]+c[4]*h*0.05,w*0.045,0.9,c[3]*c[4],rad*0.8,0.9,0) end",
    "  end",
    "  return function(u,v,x,y) local a=g[y*w+x+1] or 0 return c1.R,c1.G,c1.B,math.clamp(a*I,0,1) end end end",
    // publish / cache. Returns tex = {uri=?, live=?, id=?, cached=bool, error=?}
    "local function texKey(kind,size,c1,c2,o) return kind..'_'..size..'_'..hexOf(c1):sub(2)..'_'..hexOf(c2):sub(2)..'_'..fmt(o.intensity or 1)..'_'..fmt(o.softness or 0.5)..'_'..fmt(o.thickness or 0.06)..'_'..fmt(o.seed or 7)..'_'..fmt(o.count or 12) end",
    "local function texPublished(key) local f=ReplicatedStorage:FindFirstChild('Total_Art') f=f and f:FindFirstChild('Textures') local v=f and f:FindFirstChild(key) if v and v:IsA('StringValue') and v.Value:match('^rbxassetid://%d+$') then return v.Value end return nil end",
    "local LIVE={}",
    "local function texture(kind,size,c1,c2,o,publish,force) o=o or {} size=math.clamp(math.floor(tonumber(size) or 256),16,1024) local key=texKey(kind,size,c1,c2,o) local tex={kind=kind,key=key,size=size} if not force then local uri=texPublished(key) if uri then tex.uri=uri tex.cached=true return tex end end local okI,img=pcall(function() return makeImage(size,size,texFn(kind,size,size,c1,c2,o)) end) if not okI then tex.error='EditableImage failed: '..tostring(img) return tex end tex.live=img LIVE[#LIVE+1]=img if publish==false then return tex end local okP,res,id=pcall(function() return AssetService:CreateAssetAsync(img,Enum.AssetType.Image,{Name='TotalArt_'..kind,Description='Generated by TotalScript art pack '..ART_VERSION..' ('..key..')'}) end) if okP and res==Enum.CreateAssetResult.Success and id then tex.uri='rbxassetid://'..tostring(id) tex.id=id tex.live=nil local v=Instance.new('StringValue') v.Name=key v.Value=tex.uri v:SetAttribute('Kind',kind) v:SetAttribute('Size',size) v.Parent=texFolder() else tex.error=okP and ('CreateAssetAsync returned '..tostring(res)) or tostring(res) end return tex end",
    "local function applyTex(img,tex) if tex.uri then img.Image=tex.uri img:SetAttribute('TotalTexture',tex.key) return true elseif tex.live then local okC=pcall(function() img.ImageContent=Content.fromObject(tex.live) end) img:SetAttribute('TotalTexture',tex.key) img:SetAttribute('TotalTextureLive',true) return okC end return false end",
    "local TEXLOG={}",
    "local function texNote(tex) if tex.uri then TEXLOG[#TEXLOG+1]=tex.kind..(tex.cached and ' (cached)' or ' (published '..tostring(tex.id or '')..')') elseif tex.live then TEXLOG[#TEXLOG+1]=tex.kind..' (LIVE PREVIEW ONLY - publish failed: '..tostring(tex.error)..')' else TEXLOG[#TEXLOG+1]=tex.kind..' (unavailable: '..tostring(tex.error)..')' end end",
    // image resolution: number, rbxassetid://, store:<query>, tex:<kind>, '' -> nil
    "local function findDecals(query,page) local okD,res=pcall(function() return InsertService:GetFreeDecals(tostring(query),tonumber(page) or 0) end) if not okD then return nil,tostring(res) end local list=(type(res)=='table' and res[1] and res[1].Results) or (type(res)=='table' and res) or {} local out={} for _,it in ipairs(list) do if type(it)=='table' and it.AssetId then out[#out+1]={id=it.AssetId,name=it.Name,creator=it.CreatorName} end end return out end",
    "local function imageUri(v,t,fallbackKind) if v==nil then return nil end if type(v)=='number' then return 'rbxassetid://'..math.floor(v) end v=tostring(v) if v=='' or v=='none' then return nil end if v:match('^%d+$') then return 'rbxassetid://'..v end if v:match('^rbxassetid://') or v:match('^rbxasset://') or v:match('^http') then return v end local sq=v:match('^store:(.+)$') if sq then local list,err=findDecals(sq,0) if list and list[1] then return 'rbxassetid://'..list[1].id,('store '..sq..' -> '..tostring(list[1].name)) end return nil,('store search failed for '..sq..': '..tostring(err or 'no hits')) end local tk=v:match('^tex:(%w+)$') if tk then local tex=texture(tk,256,themeColor(t,'ornament'),themeColor(t,'backdrop2'),{},true,false) texNote(tex) return tex.uri,tex end return nil,'unknown image '..v end",
    // generic GUI helpers
    "local function mk(cls,name,parent,props) local g=Instance.new(cls) g.Name=name if props then for k,v in pairs(props) do g[k]=v end end g.Parent=parent return g end",
    "local function pxLabel(parent,name,text,face,size,color,x,y,w,h,z) local l=mk('TextLabel',name,parent,{BackgroundTransparency=1,Text=text,TextColor3=color,TextSize=size,Size=UDim2.new(0,w,0,h),Position=UDim2.new(0,x,0,y),AnchorPoint=Vector2.new(0.5,0.5),ZIndex=z or 5,TextXAlignment=Enum.TextXAlignment.Center,TextYAlignment=Enum.TextYAlignment.Center}) l.FontFace=face return l end",
    "local function hasLayout(p) if not p then return false end for _,c in ipairs(p:GetChildren()) do if c:IsA('UIListLayout') or c:IsA('UIGridLayout') or c:IsA('UITableLayout') or c:IsA('UIPageLayout') then return true end end return false end",
    "local function fxWrap(label) local p=label.Parent if p and p:IsA('Frame') and p:GetAttribute('TotalArtFX') then return p end if not hasLayout(p) then return p end local wrap=Instance.new('Frame') wrap.Name='FX_'..label.Name wrap:SetAttribute('TotalArtFX',true) wrap.BackgroundTransparency=1 wrap.Size=label.Size wrap.Position=label.Position wrap.AnchorPoint=label.AnchorPoint wrap.LayoutOrder=label.LayoutOrder wrap.ZIndex=label.ZIndex wrap.Visible=label.Visible wrap.AutomaticSize=label.AutomaticSize wrap.Parent=p label.Size=UDim2.new(1,0,1,0) label.Position=UDim2.new(0,0,0,0) label.AnchorPoint=Vector2.new(0,0) label.Parent=wrap if label.ZIndex<3 then label.ZIndex=3 end return wrap end",
    "local function fxClear(label) local p=label.Parent if p then for _,c in ipairs(p:GetChildren()) do if c:GetAttribute('TotalArtGlow') and (p:GetAttribute('TotalArtFX') or c:GetAttribute('TotalArtGlowOf')==label.Name) then c:Destroy() end end end for _,c in ipairs(label:GetChildren()) do if c:GetAttribute('TotalArtGlow') then c:Destroy() end end end",
    "local function fxUnwrap(label) local p=label.Parent if p and p:GetAttribute('TotalArtFX') then label.Size=p.Size label.Position=p.Position label.AnchorPoint=p.AnchorPoint label.LayoutOrder=p.LayoutOrder label.Parent=p.Parent p:Destroy() end end",
    "local function glowClone(label,wrap,name,z) local c=Instance.new(label.ClassName) c:SetAttribute('TotalArtGlow',true) c.BackgroundTransparency=1 if wrap:GetAttribute('TotalArtFX') then c.Name=name c.Size=UDim2.new(1,0,1,0) c.Position=UDim2.new(0,0,0,0) else c.Name=label.Name..'_'..name c:SetAttribute('TotalArtGlowOf',label.Name) c.Size=label.Size c.Position=label.Position c.AnchorPoint=label.AnchorPoint c.LayoutOrder=label.LayoutOrder c.Visible=label.Visible end c.Text=label.Text c.TextSize=label.TextSize c.TextScaled=label.TextScaled c.TextWrapped=label.TextWrapped c.TextXAlignment=label.TextXAlignment c.TextYAlignment=label.TextYAlignment c.FontFace=label.FontFace c.RichText=label.RichText c.ZIndex=z c.Parent=wrap if c:IsA('TextButton') then c.Active=false c.AutoButtonColor=false end return c end",
    "local function textGlow(label,color,size,layers,pulse) local wrap=fxWrap(label) fxClear(label) if label.ZIndex<3 then label.ZIndex=3 end layers=math.clamp(math.floor(layers or 3),1,6) for i=1,layers do local c=glowClone(label,wrap,'Glow'..i,label.ZIndex-1) c.TextColor3=color c.TextTransparency=1 local s=Instance.new('UIStroke') s.ApplyStrokeMode=Enum.ApplyStrokeMode.Contextual s.Color=color s.Thickness=size*i/layers s.Transparency=0.45+0.5*(i-1)/layers s.LineJoinMode=Enum.LineJoinMode.Round s.Parent=c if pulse then c:SetAttribute('TotalMotion','pulse') c:SetAttribute('MotionSpeed',1.1) c:SetAttribute('MotionAmp',0.7) end end return wrap end",
    "local function textShadow(label,color,dx,dy) local wrap=fxWrap(label) if label.ZIndex<3 then label.ZIndex=3 end local c=glowClone(label,wrap,'Shadow',label.ZIndex-2) c.TextColor3=color c.TextTransparency=0.35 c.Position=c.Position+UDim2.new(0,dx,0,dy) return c end",
    "local function trackText(label,spacing,face) local text=(label.Text~='' and label.Text) or label:GetAttribute('TotalTrackText') or '' label:SetAttribute('TotalTrackText',text) label:SetAttribute('TotalTracking',spacing) for _,c in ipairs(label:GetChildren()) do if c:GetAttribute('TotalArtChar') or c:IsA('UIListLayout') then c:Destroy() end end label.Text='' local ll=Instance.new('UIListLayout') ll.FillDirection=Enum.FillDirection.Horizontal ll.HorizontalAlignment=(label.TextXAlignment==Enum.TextXAlignment.Left and Enum.HorizontalAlignment.Left) or (label.TextXAlignment==Enum.TextXAlignment.Right and Enum.HorizontalAlignment.Right) or Enum.HorizontalAlignment.Center ll.VerticalAlignment=Enum.VerticalAlignment.Center ll.SortOrder=Enum.SortOrder.LayoutOrder ll.Padding=UDim.new(0,spacing) ll.Parent=label local i=0 for _,ch in utf8.codes(text) do i=i+1 local s=utf8.char(ch) local c=Instance.new('TextLabel') c.Name='Ch'..i c:SetAttribute('TotalArtChar',true) c.LayoutOrder=i c.BackgroundTransparency=1 c.Text=(s==' ') and '  ' or s c.TextSize=label.TextSize c.TextColor3=label.TextColor3 c.TextTransparency=label.TextTransparency c.FontFace=face or label.FontFace c.AutomaticSize=Enum.AutomaticSize.X c.Size=UDim2.new(0,0,1,0) c.ZIndex=label.ZIndex c.Parent=label end return i end",
    "local function untrack(label) local text=label:GetAttribute('TotalTrackText') if not text then return end for _,c in ipairs(label:GetChildren()) do if c:GetAttribute('TotalArtChar') or c:IsA('UIListLayout') then c:Destroy() end end label.Text=text label:SetAttribute('TotalTracking',nil) label:SetAttribute('TotalTrackText',nil) end",
    "local function setFontDeep(root,face,recursive,upper) local n=0 local list=recursive and root:GetDescendants() or {root} if recursive then table.insert(list,1,root) end for _,g in ipairs(list) do if isText(g) then g.FontFace=face if upper then local t=g:GetAttribute('TotalText') or g.Text g:SetAttribute('TotalText',t) g.Text=string.upper(t) end n=n+1 for _,c in ipairs(g:GetChildren()) do if c:GetAttribute('TotalArtChar') then c.FontFace=face end end end end return n end",
    "local function ensureScript(parent,name,src) local s=parent:FindFirstChild(name) if s and not s:IsA('LocalScript') then s:Destroy() s=nil end if not s then s=Instance.new('LocalScript') s.Name=name s.Parent=parent end if s:GetAttribute('TotalVersion')~=ART_VERSION then s.Source=src s:SetAttribute('TotalVersion',ART_VERSION) end return s end",
    "local function screenOf(g) local cur=g while cur and not cur:IsA('LayerCollector') do cur=cur.Parent end return cur end",
    "local function ensureMotion(g) local sg=screenOf(g) if sg then ensureScript(sg,'Total_ArtMotion',MOTION_SRC) end end",
    // decor builders (parent = any GuiObject / ScreenGui). Return created instance.
    "local function decorVignette(parent,t,color,intensity,z) local old=parent:FindFirstChild('Vignette') if old then old:Destroy() end local tex=texture('vignette',512,color,color,{intensity=intensity,softness=0.5},true,false) texNote(tex) if tex.uri or tex.live then local img=mk('ImageLabel','Vignette',parent,{BackgroundTransparency=1,Size=UDim2.new(1,0,1,0),ZIndex=z,ScaleType=Enum.ScaleType.Stretch}) applyTex(img,tex) return img end local f=mk('Frame','Vignette',parent,{BackgroundTransparency=1,Size=UDim2.new(1,0,1,0),ZIndex=z}) for _,e in ipairs({{'Top',0,UDim2.new(1,0,0.35,0),UDim2.new(0,0,0,0),90},{'Bottom',0,UDim2.new(1,0,0.35,0),UDim2.new(0,0,0.65,0),270},{'Left',0,UDim2.new(0.25,0,1,0),UDim2.new(0,0,0,0),0},{'Right',0,UDim2.new(0.25,0,1,0),UDim2.new(0.75,0,0,0),180}}) do local s=mk('Frame',e[1],f,{BackgroundColor3=color,BorderSizePixel=0,Size=e[3],Position=e[4],ZIndex=z}) local gr=Instance.new('UIGradient') gr.Rotation=e[5] gr.Transparency=NumberSequence.new({NumberSequenceKeypoint.new(0,1),NumberSequenceKeypoint.new(1,1-intensity*0.9)}) gr.Parent=s end return f end",
    "local function decorRays(parent,t,color,count,intensity,z) local old=parent:FindFirstChild('Rays') if old then old:Destroy() end local f=mk('Frame','Rays',parent,{BackgroundTransparency=1,Size=UDim2.new(1,0,1,0),ZIndex=z,ClipsDescendants=true}) f:SetAttribute('TotalMotion','sway') f:SetAttribute('MotionSpeed',0.25) f:SetAttribute('MotionAmp',0.8) count=math.clamp(math.floor(count or 5),1,12) for i=1,count do local x=0.2+0.6*(i-0.5)/count+(hash2(i,3,1)-0.5)*0.1 local r=mk('Frame','Ray'..i,f,{BackgroundColor3=color,BorderSizePixel=0,AnchorPoint=Vector2.new(0.5,0),Position=UDim2.new(x,0,-0.15,0),Size=UDim2.new(0.035+hash2(i,5,2)*0.05,0,1.5,0),Rotation=(hash2(i,9,3)-0.5)*22,ZIndex=z,BackgroundTransparency=0}) local gr=Instance.new('UIGradient') gr.Rotation=90 gr.Transparency=NumberSequence.new({NumberSequenceKeypoint.new(0,1-intensity*0.45),NumberSequenceKeypoint.new(0.55,1-intensity*0.12),NumberSequenceKeypoint.new(1,1)}) gr.Parent=r local gx=Instance.new('UIGradient') gx.Name='Soft' gx.Transparency=NumberSequence.new({NumberSequenceKeypoint.new(0,1),NumberSequenceKeypoint.new(0.5,0),NumberSequenceKeypoint.new(1,1)}) gx.Parent=r r:SetAttribute('TotalMotion','pulse') r:SetAttribute('MotionSpeed',0.3+hash2(i,2,4)*0.4) r:SetAttribute('MotionAmp',0.5) end return f end",
    "local function decorParticles(parent,t,color,count,image,dir,speed,sizeMin,sizeMax,z) local old=parent:FindFirstChild('Particles') if old then old:Destroy() end local f=mk('Frame','Particles',parent,{BackgroundTransparency=1,Size=UDim2.new(1,0,1,0),ZIndex=z,ClipsDescendants=true}) f:SetAttribute('Count',count) f:SetAttribute('Color',color) f:SetAttribute('Image',image or '') f:SetAttribute('Direction',dir or 'up') f:SetAttribute('Speed',speed or 0.05) f:SetAttribute('SizeMin',sizeMin or 3) f:SetAttribute('SizeMax',sizeMax or 9) f:SetAttribute('Opacity',0.85) ensureScript(f,'Total_ArtParticles',PARTICLES_SRC) return f end",
    "local function decorFog(parent,t,color,intensity,z) local old=parent:FindFirstChild('Fog') if old then old:Destroy() end local tex=texture('fog',512,color,color,{intensity=intensity,seed=3},true,false) texNote(tex) if not (tex.uri or tex.live) then return nil,tex.error end local f=mk('Frame','Fog',parent,{BackgroundTransparency=1,Size=UDim2.new(1,0,1,0),ZIndex=z,ClipsDescendants=true}) for i=1,2 do local img=mk('ImageLabel','Layer'..i,f,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(i==1 and 0.35 or 0.65,0,i==1 and 0.6 or 0.45,0),Size=UDim2.new(1.4,0,1.4,0),ZIndex=z,ImageTransparency=0.15,ScaleType=Enum.ScaleType.Stretch}) applyTex(img,tex) img:SetAttribute('TotalMotion','drift') img:SetAttribute('MotionSpeed',0.12*i) img:SetAttribute('MotionAmp',2.5) end return f end",
    "local function decorGrain(parent,t,intensity,z) local old=parent:FindFirstChild('Grain') if old then old:Destroy() end local tex=texture('grain',256,Color3.new(1,1,1),Color3.new(1,1,1),{intensity=intensity,seed=11},true,false) texNote(tex) if not (tex.uri or tex.live) then return nil,tex.error end local img=mk('ImageLabel','Grain',parent,{BackgroundTransparency=1,Size=UDim2.new(1,0,1,0),ZIndex=z,ScaleType=Enum.ScaleType.Tile,TileSize=UDim2.new(0,256,0,256),ImageTransparency=0.75}) applyTex(img,tex) return img end",
    "local function decorDivider(parent,t,color,w,h,x,y,z,name) local old=parent:FindFirstChild(name or 'Divider') if old then old:Destroy() end local tex=texture('divider',512,color,color,{thickness=0.02},true,false) texNote(tex) if tex.uri or tex.live then local img=mk('ImageLabel',name or 'Divider',parent,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0,x,0,y),Size=UDim2.new(0,w,0,h),ZIndex=z,ScaleType=Enum.ScaleType.Fit}) applyTex(img,tex) return img end local f=mk('Frame',name or 'Divider',parent,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0,x,0,y),Size=UDim2.new(0,w,0,h),ZIndex=z}) local line=mk('Frame','Line',f,{BackgroundColor3=color,BorderSizePixel=0,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0.5,0,0.5,0),Size=UDim2.new(1,0,0,2),ZIndex=z}) local gr=Instance.new('UIGradient') gr.Transparency=NumberSequence.new({NumberSequenceKeypoint.new(0,1),NumberSequenceKeypoint.new(0.5,0),NumberSequenceKeypoint.new(1,1)}) gr.Parent=line local gem=mk('Frame','Gem',f,{BackgroundColor3=color,BorderSizePixel=0,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0.5,0,0.5,0),Size=UDim2.new(0,h*0.5,0,h*0.5),Rotation=45,ZIndex=z+1}) return f end",
    "local function decorFrame(parent,t,color,z) local old=parent:FindFirstChild('ArtFrame') if old then old:Destroy() end local tex=texture('frame_border',256,color,color,{thickness=0.03},true,false) texNote(tex) if tex.uri or tex.live then local img=mk('ImageLabel','ArtFrame',parent,{BackgroundTransparency=1,Size=UDim2.new(1,0,1,0),ZIndex=z,ScaleType=Enum.ScaleType.Slice,SliceCenter=Rect.new(60,60,196,196)}) applyTex(img,tex) return img end local s=parent:FindFirstChildOfClass('UIStroke') or Instance.new('UIStroke') s.Color=color s.Thickness=2 s.Transparency=0.2 s.Parent=parent return s end",
    "local function decorCorners(parent,t,color,size,z) for _,n in ipairs({'CornerTL','CornerTR','CornerBR','CornerBL'}) do local old=parent:FindFirstChild(n) if old then old:Destroy() end end local tex=texture('flourish',256,color,color,{thickness=0.035},true,false) texNote(tex) if not (tex.uri or tex.live) then return nil,tex.error end local made={} for i,c in ipairs({{'CornerTL',0,0,0,0,0},{'CornerTR',1,0,1,0,90},{'CornerBR',1,1,1,1,180},{'CornerBL',0,1,0,1,270}}) do local img=mk('ImageLabel',c[1],parent,{BackgroundTransparency=1,AnchorPoint=Vector2.new(c[4],c[5]),Position=UDim2.new(c[2],0,c[3],0),Size=UDim2.new(0,size,0,size),Rotation=c[6],ZIndex=z}) applyTex(img,tex) made[#made+1]=img end return made[1] end",
    "local function decorMarkers(btn,t,color,style,size,z) for _,n in ipairs({'MarkerL','MarkerR'}) do local old=btn:FindFirstChild(n) if old then old:Destroy() end end style=style or t.marker or 'flourish' local made={} if style=='flourish' then local tex=texture('flourish',256,color,color,{thickness=0.035},true,false) texNote(tex) if tex.uri or tex.live then for _,m in ipairs({{'MarkerL',0,-size*0.6,0},{'MarkerR',1,size*0.6,180}}) do local img=mk('ImageLabel',m[1],btn,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(m[2],m[3],0.5,0),Size=UDim2.new(0,size,0,size*0.5),Rotation=m[4],ZIndex=z,ImageTransparency=1}) applyTex(img,tex) made[#made+1]=img end return made end style='diamond' end for _,m in ipairs({{'MarkerL',0,-size*0.45},{'MarkerR',1,size*0.45}}) do local s=size*0.22 local f=mk('Frame',m[1],btn,{BackgroundColor3=color,BorderSizePixel=0,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(m[2],m[3],0.5,0),Size=UDim2.new(0,s,0,(style=='dash') and 2 or s),Rotation=(style=='diamond') and 45 or (style=='chevron' and ((m[1]=='MarkerL') and 45 or -135) or 0),ZIndex=z,BackgroundTransparency=1}) if style=='dot' then local c=Instance.new('UICorner') c.CornerRadius=UDim.new(1,0) c.Parent=f end if style=='chevron' then f.Size=UDim2.new(0,s,0,s) local st=Instance.new('UIStroke') st.Color=color st.Thickness=2 st.Parent=f f.BackgroundTransparency=1 end made[#made+1]=f end return made end",
    "local function decorGlowBlob(parent,t,color,w,h,intensity,z,name) name=name or 'GlowBlob' local old=parent:FindFirstChild(name) if old then old:Destroy() end local tex=texture('glow',256,color,color,{intensity=intensity,softness=0.6},true,false) texNote(tex) if not (tex.uri or tex.live) then return nil,tex.error end local img=mk('ImageLabel',name,parent,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0.5,0,0.5,0),Size=UDim2.new(0,w,0,h),ZIndex=z,ImageTransparency=0.1}) applyTex(img,tex) img:SetAttribute('TotalMotion','pulse') img:SetAttribute('MotionSpeed',0.8) img:SetAttribute('MotionAmp',0.6) return img end",
    "local function decorBackdrop(parent,t,uri,tint,transparency,z) local old=parent:FindFirstChild('BackdropArt') if old then old:Destroy() end local img=mk('ImageLabel','BackdropArt',parent,{BackgroundTransparency=1,AnchorPoint=Vector2.new(0.5,0.5),Position=UDim2.new(0.5,0,0.5,0),Size=UDim2.new(1.04,0,1.04,0),ZIndex=z,ScaleType=Enum.ScaleType.Crop,Image=uri or '',ImageTransparency=transparency or 0.1,ImageColor3=tint or Color3.new(1,1,1)}) img:SetAttribute('TotalMotion','drift') img:SetAttribute('MotionSpeed',0.08) img:SetAttribute('MotionAmp',0.6) return img end",
    "local function describe(g) return g and g:GetFullName() or nil end",
  ].join("\n") + "\n" + ART_BUILD;

  // ── commands ────────────────────────────────────────────────────────────────
  const B = {};

  B.ui_art_theme_set = (a) => {
    const theme = THEME_IDS.includes(String(a.theme || "").toLowerCase()) ? String(a.theme).toLowerCase() : null;
    const over = [];
    const put = (k, v) => { if (v !== "nil") over.push("['" + k + "']=" + v); };
    if (a.font) put("font", q(String(a.font)));
    if (a.font_weight != null && a.font_weight !== "") put("weight", weightQ(a.font_weight));
    if (a.font_asset_id != null && a.font_asset_id !== "") put("fontAssetId", q(String(a.font_asset_id).replace(/^rbxassetid:\/\//, "")));
    for (const k of ["accent", "text", "muted", "glow", "ornament", "backdrop", "backdrop2", "panel", "particles"]) if (a[k] != null) put(k, hexQ(a[k]));
    if (a.radius != null) put("radius", nn(a.radius));
    if (a.tracking != null) put("tracking", nn(a.tracking));
    if (a.marker) put("marker", q(String(a.marker)));
    if (a.uppercase != null) put("uppercase", bb(a.uppercase));
    if (a.rays != null) put("rays", bb(a.rays));
    if (!theme && !over.length) return "return fail('ui_art_theme_set: pass theme (" + THEME_IDS.join("|") + ") and/or overrides (font, font_weight, font_asset_id, accent, text, muted, glow, ornament, backdrop, panel, radius, tracking, marker, uppercase)')";
    return [
      "local rec=wp() local r=artRoot()",
      theme ? "r:SetAttribute('art_theme'," + q(theme) + ") for k,_ in pairs(r:GetAttributes()) do if k:match('^art_') and k~='art_theme' then r:SetAttribute(k,nil) end end" : "",
      "local over={" + over.join(",") + "} local nOver=0 for k,v in pairs(over) do nOver=nOver+1 if type(v)=='string' and v:match('^#%x%x%x%x%x%x$') then r:SetAttribute('art_'..k,hexColor(v)) else r:SetAttribute('art_'..k,v) end end",
      "wpDone(rec) local t=themeGet() local face,fam=themeFont(t)",
      "return ok({theme=t.id,label=t.label,font=t.font,font_family=fam,weight=t.weight,font_asset_id=t.fontAssetId,accent=t.accent,text=t.text,glow=t.glow,ornament=t.ornament,backdrop=t.backdrop,panel=t.panel,radius=t.radius,marker=t.marker,tracking=t.tracking,uppercase=t.uppercase,path=r:GetFullName()},'art theme '..t.id..(nOver>0 and (' with '..nOver..' override(s)') or '')..' - '..tostring(t.label)..'. Everything built next by ui_art_build / ui_art_restyle / ui_decor_add uses it. For an exact typeface upload a TTF (Creator Dashboard -> Fonts) and pass font_asset_id.')",
    ].join("\n");
  };

  B.ui_art_theme_get = () => [
    "local t=themeGet() local face,fam=themeFont(t) local list={} for _,id in ipairs(THEME_ORDER) do list[#list+1]={id=id,label=THEMES[id].label,font=THEMES[id].font} end",
    "local texs={} local f=ReplicatedStorage:FindFirstChild('Total_Art') f=f and f:FindFirstChild('Textures') if f then for _,v in ipairs(f:GetChildren()) do if v:IsA('StringValue') then texs[#texs+1]={key=v.Name,uri=v.Value,kind=v:GetAttribute('Kind')} end end end",
    "return ok({theme=t.id,label=t.label,font=t.font,font_family=fam,weight=t.weight,font_asset_id=t.fontAssetId,accent=t.accent,text=t.text,muted=t.muted,glow=t.glow,ornament=t.ornament,backdrop=t.backdrop,backdrop2=t.backdrop2,panel=t.panel,radius=t.radius,marker=t.marker,tracking=t.tracking,uppercase=t.uppercase,themes=list,fonts=" + "{" + FONT_NAMES.map(q).join(",") + "}" + ",textures=texs,texture_kinds={" + TEX_KINDS.map(q).join(",") + "}},'active art theme '..t.id..' ('..#texs..' published texture(s)); '..#list..' themes available')",
  ].join("\n");

  B.ui_texture_create = (a) => {
    const kind = TEX_KINDS.includes(String(a.kind || "").toLowerCase()) ? String(a.kind).toLowerCase() : null;
    if (!kind) return "return fail('ui_texture_create: kind must be one of " + TEX_KINDS.join("|") + "')";
    const size = Math.max(16, Math.min(1024, Math.round(num(a.size) || 256)));
    return [
      "local t=themeGet() local c1=hexColor(" + hexQ(a.color) + ",themeColor(t,'ornament')) local c2=hexColor(" + hexQ(a.color2) + ",themeColor(t,'backdrop2'))",
      "local rec=wp() local tex=texture(" + q(kind) + "," + size + ",c1,c2,{intensity=" + nn(a.intensity, 1) + ",softness=" + nn(a.softness, 0.5) + ",thickness=" + nn(a.thickness, kind === "frame_border" ? 0.03 : (kind === "divider" || kind === "flourish") ? 0.025 : 0.06) + ",seed=" + nn(a.seed, 7) + ",count=" + nn(a.count, 12) + "}," + bb(a.publish, true) + "," + bb(a.force, false) + ") wpDone(rec)",
      "local applied=nil local target=resolve(" + q(a.apply_to || "") + ") if target and (target:IsA('ImageLabel') or target:IsA('ImageButton')) then applied=applyTex(target,tex) and target:GetFullName() or nil end",
      "if tex.uri then return ok({kind=tex.kind,key=tex.key,size=tex.size,uri=tex.uri,id=tex.id,cached=tex.cached==true,published=true,applied_to=applied,cache='ReplicatedStorage.Total_Art.Textures.'..tex.key},'texture '..tex.kind..' -> '..tex.uri..(tex.cached and ' (from cache)' or ' (published as a new image asset)')..'. Use it as image on any ImageLabel / ui_decor_add / ui_art_build; the id is cached so repeats are free.') end",
      "if tex.live then return ok({kind=tex.kind,key=tex.key,size=tex.size,uri=nil,published=false,live_preview=true,applied_to=applied,error=tex.error},'texture '..tex.kind..' was generated but could NOT be published as an asset ('..tostring(tex.error)..'). '..(applied and ('It is shown live on '..applied..' (ImageContent) - this preview does not survive saving / publishing the place. ') or '')..'Fixes: run the command through the TotalScript Studio plugin (a locally installed plugin may call CreateAssetAsync), or pass your own image id (ui_image_find {query} finds free decals), or keep the texture-free fallbacks (vignette / divider / markers still build without images).') end",
      "return fail('texture '..tex.kind..' failed: '..tostring(tex.error))",
    ].join("\n");
  };

  B.ui_image_find = (a) => {
    const query = String(a.query || a.q || "").trim();
    if (!query) return "return fail('ui_image_find needs query (e.g. \"ornate divider\", \"glow\", \"fantasy frame\")')";
    const limit = Math.max(1, Math.min(25, Math.round(num(a.limit) || 10)));
    return [
      "local list,err=findDecals(" + q(query) + "," + nn(a.page, 0) + ")",
      "if not list then return fail('Creator Store search is not available here: '..tostring(err)..'. Give the asset id directly (image: 123456) or generate one with ui_texture_create.') end",
      "local out={} for i,it in ipairs(list) do if i>" + limit + " then break end out[#out+1]={id=it.id,uri='rbxassetid://'..it.id,name=it.name,creator=it.creator} end",
      "return ok({query=" + q(query) + ",count=#out,images=out},#out==0 and ('no free decals for '..'" + query.replace(/'/g, "") + "'..' - try other words or ui_texture_create') or (#out..' free decal(s) for '..'" + query.replace(/'/g, "") + "'..' - use the uri as image on ImageLabels, ui_decor_add or ui_art_build; preview with total_screenshot before you keep it'))",
    ].join("\n");
  };

  B.ui_font_set = (a) => {
    if (!a.path) return "return fail('ui_font_set needs path (a TextLabel / TextButton / any GUI; recursive:true restyles every text under it)')";
    return [
      "local g=resolve(" + q(a.path) + ") if not g then return fail('not found: " + String(a.path).replace(/'/g, "") + "') end",
      "local t=themeGet() local face,fam=fontFace(" + (a.font ? q(String(a.font)) : "t.font") + "," + (a.weight != null && a.weight !== "" ? weightQ(a.weight) : "t.weight") + "," + (a.style ? q(String(a.style)) : "nil") + "," + (a.font_asset_id != null && a.font_asset_id !== "" ? q(String(a.font_asset_id)) : "t.fontAssetId") + ")",
      "local rec=wp() local n=setFontDeep(g,face," + bb(a.recursive, !a.path || true) + "," + bb(a.uppercase, false) + ")",
      "local tracked=0 if " + nn(a.tracking, -1) + ">=0 and isText(g) then if " + nn(a.tracking, -1) + "==0 then untrack(g) else tracked=trackText(g," + nn(a.tracking, 0) + ",face) end end",
      "wpDone(rec) if n==0 then return fail('no text objects under '..g:GetFullName()) end",
      "return ok({path=g:GetFullName(),font_family=fam,weight=tostring(face.Weight.Name),style=tostring(face.Style.Name),changed=n,tracked_letters=tracked},'font '..fam..' '..tostring(face.Weight.Name)..' on '..n..' text object(s)'..(tracked>0 and (' - '..tracked..' letters spaced') or '')..'. Any Enum.Font name works (" + FONT_NAMES.slice(0, 12).join(", ") + ", ...); font_asset_id uses an uploaded TTF.')",
    ].join("\n");
  };

  B.ui_text_fx = (a) => {
    if (!a.path) return "return fail('ui_text_fx needs path to a TextLabel / TextButton')";
    const off = Array.isArray(a.shadow_offset) ? a.shadow_offset : [2, 3];
    const grad = Array.isArray(a.gradient) ? a.gradient.map((c) => hex(c)).filter(Boolean) : null;
    return [
      "local g=resolve(" + q(a.path) + ") if not g then return fail('not found: " + String(a.path).replace(/'/g, "") + "') end if not isText(g) then return fail(g:GetFullName()..' is not a text object') end",
      "local t=themeGet() local rec=wp() local done={}",
      bb(a.clear, false) === "true" ? "fxClear(g) untrack(g) for _,c in ipairs(g:GetChildren()) do if c:IsA('UIStroke') or c:IsA('UIGradient') then c:Destroy() end end fxUnwrap(g) g:SetAttribute('TotalMotion',nil) done[#done+1]='cleared'" : "",
      bb(a.uppercase, false) === "true" ? "local tt=g:GetAttribute('TotalText') or g:GetAttribute('TotalTrackText') or g.Text g:SetAttribute('TotalText',tt) local wasTracked=g:GetAttribute('TotalTracking') if wasTracked then untrack(g) end g.Text=string.upper(tt) if wasTracked then trackText(g,wasTracked) end done[#done+1]='uppercase'" : "",
      a.tracking != null ? (num(a.tracking) > 0 ? "trackText(g," + nn(a.tracking) + ") done[#done+1]='tracking '..fmt(" + nn(a.tracking) + ")" : "untrack(g) done[#done+1]='tracking off'") : "",
      bb(a.glow, a.glow_color != null || a.glow_size != null) === "true" ? "textGlow(g,hexColor(" + hexQ(a.glow_color) + ",themeColor(t,'glow'))," + nn(a.glow_size, 10) + "," + nn(a.glow_layers, 3) + "," + bb(a.pulse, false) + ") done[#done+1]='glow' for _,c in ipairs(g:GetChildren()) do if c:GetAttribute('TotalArtChar') then local s=c:FindFirstChildOfClass('UIStroke') or Instance.new('UIStroke') s.Color=hexColor(" + hexQ(a.glow_color) + ",themeColor(t,'glow')) s.Thickness=math.max(1," + nn(a.glow_size, 10) + "*0.18) s.Transparency=0.55 s.Parent=c end end" : "",
      bb(a.shadow, a.shadow_color != null) === "true" ? "textShadow(g,hexColor(" + hexQ(a.shadow_color, "#000000") + ",Color3.new(0,0,0))," + nn(off[0], 2) + "," + nn(off[1], 3) + ") done[#done+1]='shadow'" : "",
      bb(a.outline, a.outline_color != null || a.outline_thickness != null) === "true" ? "local s=g:FindFirstChildOfClass('UIStroke') or Instance.new('UIStroke') s.ApplyStrokeMode=Enum.ApplyStrokeMode.Contextual s.Color=hexColor(" + hexQ(a.outline_color) + ",themeColor(t,'ornament')) s.Thickness=" + nn(a.outline_thickness, 1.5) + " s.Transparency=" + nn(a.outline_transparency, 0.2) + " s.LineJoinMode=Enum.LineJoinMode.Round s.Parent=g done[#done+1]='outline'" : "",
      grad && grad.length >= 2 ? "local gr=g:FindFirstChildOfClass('UIGradient') or Instance.new('UIGradient') gr.Rotation=" + nn(a.gradient_rotation, 90) + " gr.Color=ColorSequence.new(hexColor(" + q(grad[0]) + "),hexColor(" + q(grad[grad.length - 1]) + ")) gr.Parent=g done[#done+1]='gradient'" : "",
      bb(a.pulse, false) === "true" ? "g:SetAttribute('TotalMotion','pulse') g:SetAttribute('MotionSpeed',1.1) g:SetAttribute('MotionAmp',0.4) ensureMotion(g) done[#done+1]='pulse'" : "",
      "if #done>0 then ensureMotion(g) end wpDone(rec)",
      "if #done==0 then return fail('nothing to do - pass glow / shadow / outline / gradient / tracking / uppercase / pulse (or clear:true)') end",
      "local wrap=g.Parent and g.Parent:GetAttribute('TotalArtFX') and g.Parent:GetFullName() or nil",
      "return ok({path=g:GetFullName(),wrapper=wrap,applied=done},table.concat(done,', ')..' on '..g.Name..(wrap and (' (layers live in '..wrap..')') or '')..'. Glow = stacked UIStroke layers behind the text, so it works without any image asset; total_screenshot to judge the strength.')",
    ].filter(Boolean).join("\n");
  };

  B.ui_decor_add = (a) => {
    const kind = DECOR_KINDS.includes(String(a.kind || "").toLowerCase()) ? String(a.kind).toLowerCase() : null;
    if (!kind) return "return fail('ui_decor_add: kind must be one of " + DECOR_KINDS.join("|") + "')";
    const parent = a.parent || a.path || "";
    if (!parent) return "return fail('ui_decor_add needs parent (ScreenGui or Frame path; a button for markers)')";
    const z = nn(a.zindex, kind === "vignette" || kind === "grain" ? 8 : kind === "backdrop" ? 1 : 2);
    const colorExpr = (dKey) => "hexColor(" + hexQ(a.color) + ",themeColor(t,'" + dKey + "'))";
    const body = {
      vignette: "made=decorVignette(p,t," + colorExpr("backdrop2") + "," + nn(a.intensity, 0.85) + "," + z + ")",
      backdrop: "local uri,note=imageUri(" + imgQ(a.image) + ",t) if not uri then return fail('backdrop needs image (asset id, rbxassetid://, store:<query> or tex:<kind>)'..(note and (' - '..tostring(note)) or '')) end made=decorBackdrop(p,t,uri," + (a.tint != null ? "hexColor(" + hexQ(a.tint) + ")" : "nil") + "," + nn(a.transparency, 0.1) + "," + z + ")",
      rays: "made=decorRays(p,t," + colorExpr("glow") + "," + nn(a.count, 5) + "," + nn(a.intensity, 0.6) + "," + z + ")",
      particles: "made=decorParticles(p,t," + colorExpr("particles") + "," + nn(a.count, 40) + "," + (a.image != null ? "(imageUri(" + imgQ(a.image) + ",t) or '')" : "''") + "," + q(String(a.direction || "up")) + "," + nn(a.speed, 0.05) + "," + nn(a.size_min, 3) + "," + nn(a.size_max, 9) + "," + z + ")",
      fog: "made,err=decorFog(p,t," + colorExpr("muted") + "," + nn(a.intensity, 0.7) + "," + z + ")",
      divider: "made=decorDivider(p,t," + colorExpr("ornament") + "," + nn(a.width || a.size, 520) + "," + nn(a.height, 60) + "," + nn(a.x, 640) + "," + nn(a.y, 360) + "," + z + "," + q(ident(a.name, "Divider")) + ")",
      frame: "made=decorFrame(p,t," + colorExpr("ornament") + "," + z + ")",
      corner_ornaments: "made,err=decorCorners(p,t," + colorExpr("ornament") + "," + nn(a.size, 96) + "," + z + ")",
      markers: "if not p:IsA('GuiButton') and not p:IsA('TextLabel') then return fail('markers go on a button / label (parent='..p:GetFullName()..')') end local list=decorMarkers(p,t," + colorExpr("accent") + "," + (a.style ? q(String(a.style)) : "nil") + "," + nn(a.size, 56) + "," + z + ") made=list[1] for _,m in ipairs(list) do if m:IsA('ImageLabel') then m.ImageTransparency=0 else m.BackgroundTransparency=0 end end",
      glow_blob: "made,err=decorGlowBlob(p,t," + colorExpr("glow") + "," + nn(a.width || a.size, 700) + "," + nn(a.height || a.size, 320) + "," + nn(a.intensity, 0.8) + "," + z + "," + q(ident(a.name, "GlowBlob")) + ")",
      grain: "made,err=decorGrain(p,t," + nn(a.intensity, 1) + "," + z + ")",
    }[kind];
    return [
      "local p=resolve(" + q(parent) + ") if not p then return fail('parent not found: " + String(parent).replace(/'/g, "") + "') end if not (p:IsA('GuiObject') or p:IsA('LayerCollector')) then return fail(p:GetFullName()..' is not a GUI container') end",
      "local t=themeGet() local rec=wp() local made,err",
      body,
      "if made then ensureMotion(made) end wpDone(rec)",
      "if not made then return fail('" + kind + " could not be built: '..tostring(err or 'texture unavailable')..' (see textures below) '..table.concat(TEXLOG,'; ')) end",
      "return ok({kind=" + q(kind) + ",path=made:GetFullName(),parent=p:GetFullName(),textures=TEXLOG},'" + kind + " added at '..made:GetFullName()..(#TEXLOG>0 and (' - textures: '..table.concat(TEXLOG,'; ')) or '')..'. Motion / particles run in Play mode (LocalScripts); total_screenshot in a playtest to judge it.')",
    ].join("\n");
  };

  B.ui_art_restyle = (a) => {
    if (!a.path) return "return fail('ui_art_restyle needs path to a ScreenGui (or any Frame)')";
    const theme = THEME_IDS.includes(String(a.theme || "").toLowerCase()) ? q(String(a.theme).toLowerCase()) : "nil";
    return [
      "local root=resolve(" + q(a.path) + ") if not root then return fail('not found: " + String(a.path).replace(/'/g, "") + "') end",
      "local t=themeGet(" + theme + ") local face=themeFont(t) local bold=themeFont(t,math.min(900,(tonumber(t.weight) or 400)+200))",
      "local rec=wp() local n={text=0,titles=0,panels=0,buttons=0,strokes=0}",
      "local textC,mutedC,accentC,panelC,ornC,glowC=themeColor(t,'text'),themeColor(t,'muted'),themeColor(t,'accent'),themeColor(t,'panel'),themeColor(t,'ornament'),themeColor(t,'glow')",
      "local fontsOnly=" + bb(a.fonts_only, false) + " local maxTitle=0 for _,g in ipairs(root:GetDescendants()) do if isText(g) and not g:GetAttribute('TotalArtGlow') and not g:GetAttribute('TotalArtChar') then maxTitle=math.max(maxTitle,g.TextSize) end end",
      "for _,g in ipairs(root:GetDescendants()) do",
      " if g:GetAttribute('TotalArtGlow') or g:GetAttribute('TotalArtChar') then",
      " elseif isText(g) then local title=(g.TextSize>=math.max(26,maxTitle*0.8)) g.FontFace=title and bold or face n.text=n.text+1 if not fontsOnly then g.TextColor3=(g.TextSize<14) and mutedC or textC if t.uppercase and title then local tt=g:GetAttribute('TotalText') or g.Text g:SetAttribute('TotalText',tt) g.Text=string.upper(tt) end if title then n.titles=n.titles+1 textGlow(g,glowC,8,3,false) end end if g:IsA('TextButton') then n.buttons=n.buttons+1 g.AutoButtonColor=false end",
      " elseif not fontsOnly and g:IsA('Frame') and g.BackgroundTransparency<0.98 and g.AbsoluteSize.X>=120 and g.AbsoluteSize.Y>=60 and not g:GetAttribute('TotalArtFX') then g.BackgroundColor3=panelC g.BackgroundTransparency=math.max(g.BackgroundTransparency,0.08) n.panels=n.panels+1 local c=g:FindFirstChildOfClass('UICorner') if c then c.CornerRadius=UDim.new(0,tonumber(t.radius) or 0) end local s=g:FindFirstChildOfClass('UIStroke') or Instance.new('UIStroke') s.Color=ornC s.Thickness=1 s.Transparency=0.35 s.Parent=g n.strokes=n.strokes+1 if " + bb(a.frames, true) + " then decorFrame(g,t,ornC,g.ZIndex+1) end",
      " end",
      "end",
      "local sg=screenOf(root) or root",
      "if " + bb(a.vignette, true) + " and not fontsOnly then decorVignette(sg,t,themeColor(t,'backdrop2'),0.7,9) end",
      "if " + bb(a.particles, false) + " then decorParticles(sg,t,themeColor(t,'particles'),30,'','up',0.04,2,6,9) end",
      "ensureMotion(sg) sg:SetAttribute('Accent',accentC) sg:SetAttribute('TextColor',textC) wpDone(rec)",
      "return ok({path=root:GetFullName(),theme=t.id,text=n.text,titles=n.titles,panels=n.panels,buttons=n.buttons,textures=TEXLOG},'restyled '..root.Name..' as '..t.id..': '..n.text..' text objects (font '..tostring(t.font)..', '..n.titles..' titles glowing), '..n.panels..' panels re-dressed'..(#TEXLOG>0 and (' - textures: '..table.concat(TEXLOG,'; ')) or '')..'. Layout untouched; ui_text_fx / ui_decor_add for individual pieces, total_screenshot to judge.')",
    ].join("\n");
  };


  B.ui_art_build = (a) => {
    const spec = (a.spec && typeof a.spec === "object") ? a.spec : null;
    if (!spec) return "return fail('ui_art_build needs spec:{theme?, title:{text, size?, tracking?, glow?, ornament_top?, ornament_bottom?, emblem?, subtitle?}, menu:{items:[{label, action?}], y?, gap?, size?, marker?}, backdrop?:{image?, rays?, fog?, particles?, vignette?}, footer?:[{kind:text|image|icons, text?, image?, images?, corner?}], extras?:[...], font?:{name, weight, asset_id, tracking, uppercase}, colors?:{accent, text, glow, ornament, backdrop}, intro?:{fade}, sounds?:{hover, click}}')";
    if (!spec.title && !(spec.menu && spec.menu.items && spec.menu.items.length) && !(spec.extras && spec.extras.length)) return "return fail('ui_art_build: the spec has no title, no menu items and no extras - nothing to draw')";
    const name = ident(a.name || spec.name, "ArtScreen");
    const json = JSON.stringify(Object.assign({}, spec, { name }));
    if (json.length > 12000) return "return fail('ui_art_build: spec too large (" + json.length + " chars) - split extras across ui_decor_add calls')";
    return [
      "local spec=HttpService:JSONDecode(" + q(json) + ")",
      "local rec=wp() local gui,t,fam,built,notes=artBuild(spec," + q(a.parent || "StarterGui") + "," + bb(a.replace, true) + ") wpDone(rec)",
      "local items={} local menu=gui:FindFirstChild('Canvas') and gui.Canvas:FindFirstChild('Menu') if menu then for _,b in ipairs(menu:GetChildren()) do if b:IsA('TextButton') then items[#items+1]={name=b.Name,action=b:GetAttribute('Action')} end end end",
      "local live=0 local pub=0 for _,l in ipairs(TEXLOG) do if l:find('LIVE PREVIEW') then live=live+1 elseif l:find('published') or l:find('cached') then pub=pub+1 end end",
      "return ok({path=gui:GetFullName(),theme=t.id,font_family=fam,built=built,menu=items,textures=TEXLOG,textures_published=pub,textures_live_only=live,notes=notes,canvas='1280x720 (root UIScale fits any viewport; backdrop layers fill the screen)',controllers={'Total_ArtMotion','Total_ArtMenu'},bus='ReplicatedStorage.Total_Art.MenuSelected (gui, item, action)'},'built '..gui:GetFullName()..' ('..t.id..'): '..table.concat(built,', ')..'. Textures: '..(#TEXLOG>0 and table.concat(TEXLOG,'; ') or 'none needed')..(live>0 and ('. WARNING: '..live..' texture(s) are live previews only (publishing failed) - they vanish on save; pass your own image ids or run via the TotalScript plugin.') or '')..(#notes>0 and ('. Notes: '..table.concat(notes,'; ')) or '')..'. Particles, glow pulse, hover markers and the intro fade run in Play mode - studio_playtest + total_screenshot to judge; tweak with ui_text_fx / ui_decor_add / ui_font_set {font_asset_id} for an exact typeface.')",
    ].join("\n");
  };

  // ── catalogue ───────────────────────────────────────────────────────────────
  const IMG_DESC = "asset id | rbxassetid://N | store:<query> (first free decal) | tex:<kind> (generated texture)";
  const C = [
    { name: "ui_art_theme_set", description: "Pick the ART DIRECTION every cinematic GUI command uses: " + THEME_IDS.join("|") + " (serif capitals + glow + ink motes, parchment gold + embers, violet runes, cyan tech, chunky cartoon, blood-red horror, gold on velvet, hairline luxury, arcade pixel) - and override any part: font (any Enum.Font name), font_weight, font_asset_id (uploaded TTF for an exact typeface), accent / text / glow / ornament / backdrop / panel colours, radius, tracking, marker style, uppercase. Stored in ReplicatedStorage.Total_Art.", params: { theme: S("string", false, THEME_IDS.join("|")), font: S("string", false, "Enum.Font name, e.g. Garamond, Fondamento, Michroma, FredokaOne"), font_weight: S("string", false, "Thin..Heavy or 100-900"), font_asset_id: S("string", false, "rbxassetid of an uploaded font"), accent: S("string", false, "#hex"), text: S("string", false), muted: S("string", false), glow: S("string", false), ornament: S("string", false), backdrop: S("string", false), backdrop2: S("string", false), panel: S("string", false), particles: S("string", false), radius: S("number", false), tracking: S("number", false, "letter spacing px for titles"), marker: S("string", false, "flourish|diamond|chevron|dot|dash|none"), uppercase: S("boolean", false), rays: S("boolean", false) } },
    { name: "ui_art_theme_get", hidden: true, description: "Read the active art theme, the theme list, usable font names, texture kinds and the published texture cache.", params: {} },
    { name: "ui_texture_create", description: "Draw a texture pixel by pixel (EditableImage) and publish it as an image asset you can use anywhere (cached per kind/colour/size in ReplicatedStorage.Total_Art.Textures): " + TEX_KINDS.join("|") + ". No external art needed for glows, vignettes, fog, light rays, ornamental dividers, flourish markers or 9-slice frames. If publishing is not permitted the result says live_preview:true and explains the alternatives - never a silent fake.", params: { kind: S("string", true, TEX_KINDS.join("|")), size: S("number", false, "px, 16-1024 (default 256)"), color: S("string", false, "#hex (default theme ornament)"), color2: S("string", false, "second colour for gradients"), intensity: S("number", false, "alpha multiplier 0-1.5"), softness: S("number", false, "0-1"), thickness: S("number", false, "line thickness 0-0.2 for divider/flourish/frame_border/ring"), seed: S("number", false), count: S("number", false, "rays count"), apply_to: S("string", false, "ImageLabel path to receive it"), publish: S("boolean", false, "default true"), force: S("boolean", false, "ignore the cache") } },
    { name: "ui_image_find", hidden: true, description: "Search free decals on the Creator Store (InsertService:GetFreeDecals) - returns ids/uris for ImageLabels, ui_decor_add and ui_art_build (image: store:<query> does this inline).", params: { query: S("string", true), page: S("number", false), limit: S("number", false, "default 10") } },
    { name: "ui_font_set", description: "Typography with real power: any Enum.Font family (Garamond, Bodoni, Fondamento, GrenzeGotisch, Michroma, Merriweather, FredokaOne, Creepster, ...) with weight (Thin..Heavy / 100-900) and style, or a custom uploaded font via font_asset_id; recursive over a whole GUI; uppercase; tracking = letter spacing in px (splits the label into spaced glyphs). Writes FontFace, so weights work.", params: { path: S("string", true), font: S("string", false, "Enum.Font name (default theme font)"), weight: S("string", false), style: S("string", false, "Normal|Italic"), font_asset_id: S("string", false), recursive: S("boolean", false, "default true"), uppercase: S("boolean", false), tracking: S("number", false, "px between letters (0 = off)") } },
    { name: "ui_text_fx", description: "Cinematic text effects on any TextLabel/TextButton without image assets: glow (stacked soft UIStroke layers behind the text, optional pulse), shadow, outline, vertical gradient, tracking (letter spacing), uppercase; clear:true removes them. Use on titles, menu items, HUD numbers.", params: { path: S("string", true), glow: S("boolean", false), glow_color: S("string", false, "#hex (default theme glow)"), glow_size: S("number", false, "px (default 10)"), glow_layers: S("number", false, "1-6"), pulse: S("boolean", false, "slow breathing glow"), shadow: S("boolean", false), shadow_color: S("string", false), shadow_offset: S("array", false, "[x,y] px"), outline: S("boolean", false), outline_color: S("string", false), outline_thickness: S("number", false), gradient: S("array", false, "[#top, #bottom]"), tracking: S("number", false), uppercase: S("boolean", false), clear: S("boolean", false) } },
    { name: "ui_decor_add", description: "Add one layer of atmosphere to any ScreenGui / Frame / button: " + DECOR_KINDS.join("|") + ". vignette darkens the edges; backdrop = full-bleed image with slow drift; rays = soft light shafts; particles = ink motes / embers / snow (LocalScript, count/direction/speed/colour/image); fog = drifting noise layers; divider = ornamental line with end curls; frame = 9-slice ornate border; corner_ornaments = flourishes in the 4 corners; markers = the << >> selection ornaments beside a button; glow_blob = soft light behind a title; grain = film grain. Textures are generated + published automatically (falls back to gradient frames when images are impossible).", params: { parent: S("string", true, "ScreenGui / Frame path (a button for markers)"), kind: S("string", true, DECOR_KINDS.join("|")), color: S("string", false, "#hex (default from theme)"), intensity: S("number", false, "0-1"), count: S("number", false, "rays / particles"), image: S("string", false, IMG_DESC + " (backdrop, particles)"), direction: S("string", false, "particles: up|down|drift"), speed: S("number", false), size: S("number", false, "px for markers / corner_ornaments / divider width"), width: S("number", false), height: S("number", false), x: S("number", false, "divider centre px on the 1280x720 canvas"), y: S("number", false), style: S("string", false, "markers: flourish|diamond|chevron|dot|dash"), tint: S("string", false), transparency: S("number", false), zindex: S("number", false), name: S("string", false) } },
    { name: "ui_art_build", description: "Build a COMPLETE cinematic screen (title screen, pause, chapter card, results) in one call from an art spec - the way to clone a reference like a Hollow Knight menu: backdrop (image or generated light + fog + rays + particles + vignette + grain), title (any font / uploaded font, letter spacing, layered glow with pulse, ornaments above/below, emblem, subtitle), text-only menu with flourish/diamond/chevron markers, hover glow + scale, keyboard + gamepad navigation, actions (open:/toggle:/close/remote:/print:), footer corners (version text, icons, studio logo), extras (text / image / divider / frame / glow at px positions), intro fade, hover/click sounds. Authored on a 1280x720 canvas that a root UIScale fits to any viewport; backdrop layers fill the whole screen. Returns which textures were published vs live-only.", params: { spec: S("object", true, "{theme?, title:{text, image?, size?, y?, tracking?, glow?, glow_size?, ornament_top?, ornament_bottom?, emblem?, subtitle?}, menu:{items:[{label, action?, name?}], y?, gap?, size?, marker?, align?}, backdrop?:{image?, tint?, gradient?, rays?, fog?, particles?|{count,color,direction,image}, vignette?, grain?}, footer?:[{kind:text|image|icons, text?, image?, images?, colors?, corner?, size?}], extras?:[{kind:text|image|divider|frame|glow, x, y, w, h, text?, image?, size?, color?, glow?}], font?:{name, weight, asset_id, tracking, uppercase}, colors?:{accent, text, muted, glow, ornament, backdrop, backdrop2, panel, particles}, intro?:{fade, select_first}, sounds?:{hover, click}}; images: " + IMG_DESC), name: S("string", false, "ScreenGui name (default ArtScreen)"), parent: S("string", false, "default StarterGui"), replace: S("boolean", false, "default true") } },
    { name: "ui_art_restyle", description: "Re-dress an EXISTING ScreenGui (HUD, shop, inventory, settings - anything from ui_screen_generate / ui_from_spec / ui_build_spec) in the active art theme without touching its layout or scripts: theme fonts via FontFace (titles heavier), uppercase titles with layered glow, panel colours + corner radius + ornament strokes + optional 9-slice ornate frames, vignette, optional particles. fonts_only:true changes typography only.", params: { path: S("string", true), theme: S("string", false, THEME_IDS.join("|") + " (default active theme)"), frames: S("boolean", false, "ornate 9-slice frames on panels (default true)"), vignette: S("boolean", false, "default true"), particles: S("boolean", false, "default false"), fonts_only: S("boolean", false) } },
  ];

  function buildArt(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))";
      return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + (e && e.message || e) };
    }
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = buildArt(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const names = new Set(C.map((c) => c.name));
  const arr = RobloxScriptSkills.SKILL_COMMANDS; // mutate in place (studio_skills keeps its own reference)
  for (let i = arr.length - 1; i >= 0; i--) if (names.has(arr[i].name)) arr.splice(i, 1);
  for (const c of C) arr.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.ARTUI_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.ARTUI_THEMES = THEME_IDS.slice();
  RobloxScriptSkills.ARTUI_TEXTURES = TEX_KINDS.slice();
  RobloxScriptSkills.ARTUI_DECOR = DECOR_KINDS.slice();
  RobloxScriptSkills.ARTUI_FONTS = FONT_NAMES.slice();
  RobloxScriptSkills.ARTUI_MOTION_SRC = MOTION_SRC;
  RobloxScriptSkills.ARTUI_PARTICLES_SRC = PARTICLES_SRC;
  RobloxScriptSkills.ARTUI_MENU_SRC = MENU_SRC;
  RobloxScriptSkills.ARTUI_VERSION = VERSION;
})();
