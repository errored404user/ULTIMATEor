// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript cutscene pack (1.77.0) - REAL cutscenes, layered on
// RobloxScriptSkills exactly like studio_modes.js.
//
// Until 1.76 `cutscene_camera_track` was a stub that answered "configured" and
// created nothing - the prompts told the model to use it, so every cutscene
// request ended in a confident report and an unchanged place. This pack
// replaces it with a data model + a client runtime + Studio tooling:
//
//   ReplicatedStorage.TotalCutscenes/
//     CutscenePlayer      ModuleScript  - client runtime: letterbox, fade, FOV,
//                                        eased camera moves, hold, skip, HUD /
//                                        character freeze, restore, Completed
//     PlayCutscene        RemoteEvent   - server -> client "play <name>", client ->
//                                        server "<name> finished/skipped"
//     <Name>              ModuleScript  - one cutscene: `return { shots = {...} }`
//                                        (source generated from the ShotsJSON
//                                        attribute, so the commands can edit it)
//   StarterPlayer.StarterPlayerScripts.TotalCutsceneClient  LocalScript - listens
//   ServerScriptService.TotalCutsceneTrigger_<Name>         Script      - spawn /
//                                        touch / proximity trigger (cutscene_trigger)
//
// Commands: cutscene_create, cutscene_shot_add, cutscene_shot_from_camera,
//           cutscene_shots_from_path, cutscene_preview, cutscene_trigger,
//           cutscene_list, cutscene_delete, cutscene_camera_track (legacy name,
//           now a real alias of cutscene_create).
//
// Convention: JS source uses double-quoted strings; Luau string literals use
// single quotes except values produced by q()/jj(). Never put a raw newline
// inside a Luau string - tests/test-luau-syntax.js enforces it. Embedded
// script sources are plain Lua 5.4 compatible (no `+=`, no `continue`) so the
// simulator can compile and run them.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const VERSION = "1.77.0";
  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  const nn = (v, d = 0) => { const x = Number(v); return isFinite(x) ? String(x) : String(d); };
  const bb = (v, d = false) => (v === undefined || v === null || v === "" ? (d ? "true" : "false") : (v === true || v === "true" || v === 1 || v === "1" || v === "yes") ? "true" : "false");
  const ident = (v, d) => { const s = String(v || d || "Cutscene").replace(/[^A-Za-z0-9_]/g, ""); return /^[A-Za-z_]/.test(s) ? s : "_" + s; };
  const num = (v) => { const x = Number(v); return isFinite(x) ? x : null; };
  const vecArr = (a) => {
    if (typeof a === "string") { const p = a.split(/[\s,]+/).map(Number); if (p.length >= 3 && p.every(isFinite)) a = p; else return null; }
    if (a && typeof a === "object" && !Array.isArray(a)) a = [a.x, a.y, a.z];
    if (!Array.isArray(a) || a.length < 3 || !a.slice(0, 3).every((x) => isFinite(Number(x)))) return null;
    return a.slice(0, 3).map(Number);
  };
  const EASINGS = { linear: "Linear", sine: "Sine", back: "Back", quad: "Quad", quart: "Quart", quint: "Quint", bounce: "Bounce", elastic: "Elastic", exponential: "Exponential", circular: "Circular", cubic: "Cubic" };
  const easingName = (v, d) => EASINGS[String(v || "").replace(/[^A-Za-z]/g, "").toLowerCase()] || EASINGS[String(d || "").toLowerCase()] || "Sine";
  const dirName = (v, d) => { const s = String(v || d || "InOut").toLowerCase(); return s === "in" ? "In" : s === "out" ? "Out" : "InOut"; };

  // ── shot normalisation (JS side): one shot -> a Luau table literal ──────────
  // Accepted shapes per shot:
  //   {position:[x,y,z], look_at:[x,y,z] | "Workspace.Boss"}   explicit camera
  //   {cframe:[12 numbers]}                                     raw CFrame
  //   {part:"Workspace.CamPath.Shot1"}                          marker part (camera looks along its LookVector)
  //   {target:"Workspace.Boss", preset:"wide|closeup|hero_low|top_down|side|behind", distance?, height?}
  // plus fov, duration (travel time to the NEXT shot), hold (seconds to stay on
  // this shot first), easing, direction, roll (degrees), name.
  function shotLiteral(s, i) {
    if (typeof s === "string") s = { part: s };
    if (!s || typeof s !== "object") throw new Error("shot " + (i + 1) + " must be an object");
    const f = [];
    f.push("name=" + q(s.name || s.label || ("shot" + (i + 1))));
    const pos = vecArr(s.position || s.from || s.pos);
    const cfr = Array.isArray(s.cframe) && s.cframe.length >= 12 && s.cframe.slice(0, 12).every((x) => isFinite(Number(x))) ? s.cframe.slice(0, 12).map(Number) : null;
    if (cfr) f.push("cframe={" + cfr.join(",") + "}");
    else if (s.part) f.push("part=" + q(s.part));
    else if (s.target) {
      f.push("target=" + q(s.target) + ",preset=" + q(String(s.preset || s.angle || "wide").toLowerCase()));
      if (num(s.distance) !== null) f.push("distance=" + nn(s.distance));
      if (num(s.height) !== null) f.push("height=" + nn(s.height));
    } else if (pos) {
      f.push("pos=Vector3.new(" + pos.join(",") + ")");
      const look = vecArr(s.look_at || s.look || s.target_position);
      if (look) f.push("look=Vector3.new(" + look.join(",") + ")");
      else if (typeof (s.look_at || s.look) === "string" && (s.look_at || s.look)) f.push("lookPath=" + q(s.look_at || s.look));
    } else throw new Error("shot " + (i + 1) + ": give position (+ look_at), cframe, part or target");
    if (num(s.fov) !== null) f.push("fov=" + nn(s.fov));
    if (num(s.duration) !== null) f.push("duration=" + nn(s.duration));
    if (num(s.hold) !== null) f.push("hold=" + nn(s.hold));
    if (num(s.roll) !== null) f.push("roll=" + nn(s.roll));
    f.push("easing=" + q((easingName(s.easing || s.style, "Sine"))));
    f.push("direction=" + q(dirName(s.direction, "InOut")));
    return "{" + f.join(",") + "}";
  }
  function shotsLiteral(list, defaults) {
    if (!Array.isArray(list)) throw new Error("shots must be an array of shot objects");
    return "{" + list.map((s, i) => shotLiteral(Object.assign({}, defaults || {}, s && typeof s === "object" ? s : { part: s }), i)).join(",") + "}";
  }
  const optsLiteral = (a) => {
    const f = [];
    if (a.letterbox !== undefined) f.push("letterbox=" + bb(a.letterbox, true));
    if (num(a.fade_in) !== null) f.push("fade_in=" + nn(a.fade_in));
    if (num(a.fade_out) !== null) f.push("fade_out=" + nn(a.fade_out));
    if (num(a.fade) !== null) { f.push("fade_in=" + nn(a.fade)); f.push("fade_out=" + nn(a.fade)); }
    if (a.skip !== undefined) f.push("skip=" + bb(a.skip, true));
    if (a.hide_hud !== undefined) f.push("hide_hud=" + bb(a.hide_hud, true));
    if (a.freeze_player !== undefined) f.push("freeze_player=" + bb(a.freeze_player, true));
    if (num(a.blur) !== null) f.push("blur=" + nn(a.blur));
    return "{" + f.join(",") + "}";
  };

  // ── embedded runtime: ReplicatedStorage.TotalCutscenes.CutscenePlayer ──────
  const RUNTIME_SRC = [
    "-- TotalScript CutscenePlayer " + VERSION + " (client). Generated by cutscene_create; safe to edit.",
    "-- local Player = require(game:GetService(\"ReplicatedStorage\").TotalCutscenes.CutscenePlayer)",
    "-- Player.play(\"Intro\")            -- yields until the cutscene ends or is skipped; returns true when it played to the end",
    "-- Player.play(\"Intro\", {restore_camera = false})",
    "-- Player.stop()  Player.isPlaying()  Player.Completed.Event:Connect(function(name, skipped) end)",
    "local Players = game:GetService(\"Players\")",
    "local RunService = game:GetService(\"RunService\")",
    "local TweenService = game:GetService(\"TweenService\")",
    "local UserInputService = game:GetService(\"UserInputService\")",
    "local StarterGui = game:GetService(\"StarterGui\")",
    "local Lighting = game:GetService(\"Lighting\")",
    "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")",
    "local M = {}",
    "M.Completed = Instance.new(\"BindableEvent\")",
    "local playing = nil",
    "local function cfOf(s) if typeof(s.cf) == \"CFrame\" then return s.cf end local c = s.cf return CFrame.new(c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12]) end",
    "local function loadData(x)",
    "  if type(x) == \"table\" then return x end",
    "  local folder = ReplicatedStorage:FindFirstChild(\"TotalCutscenes\")",
    "  local m = folder and folder:FindFirstChild(tostring(x))",
    "  if not m or not m:IsA(\"ModuleScript\") then error(\"cutscene not found: \" .. tostring(x)) end",
    "  local d = require(m)",
    "  if type(d) ~= \"table\" then error(\"cutscene module \" .. m.Name .. \" must return a table\") end",
    "  d.name = d.name or m.Name",
    "  return d",
    "end",
    "local function makeGui(data)",
    "  local gui = Instance.new(\"ScreenGui\")",
    "  gui.Name = \"TotalCutscene\" gui.IgnoreGuiInset = true gui.ResetOnSpawn = false gui.DisplayOrder = 1000 gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling",
    "  local top = Instance.new(\"Frame\") top.Name = \"BarTop\" top.BackgroundColor3 = Color3.new(0, 0, 0) top.BorderSizePixel = 0 top.AnchorPoint = Vector2.new(0, 0) top.Position = UDim2.new(0, 0, 0, 0) top.Size = UDim2.new(1, 0, 0, 0) top.ZIndex = 10 top.Parent = gui",
    "  local bottom = Instance.new(\"Frame\") bottom.Name = \"BarBottom\" bottom.BackgroundColor3 = Color3.new(0, 0, 0) bottom.BorderSizePixel = 0 bottom.AnchorPoint = Vector2.new(0, 1) bottom.Position = UDim2.new(0, 0, 1, 0) bottom.Size = UDim2.new(1, 0, 0, 0) bottom.ZIndex = 10 bottom.Parent = gui",
    "  local fade = Instance.new(\"Frame\") fade.Name = \"Fade\" fade.BackgroundColor3 = Color3.new(0, 0, 0) fade.BorderSizePixel = 0 fade.Size = UDim2.new(1, 0, 1, 0) fade.BackgroundTransparency = 1 fade.ZIndex = 20 fade.Parent = gui",
    "  local hint = Instance.new(\"TextLabel\") hint.Name = \"SkipHint\" hint.BackgroundTransparency = 1 hint.AnchorPoint = Vector2.new(1, 1) hint.Position = UDim2.new(1, -24, 1, -18) hint.Size = UDim2.new(0, 260, 0, 24) hint.Font = Enum.Font.Gotham hint.TextSize = 14 hint.TextXAlignment = Enum.TextXAlignment.Right hint.TextColor3 = Color3.fromRGB(235, 235, 240) hint.TextStrokeTransparency = 0.7 hint.TextTransparency = 1 hint.ZIndex = 30",
    "  hint.Text = UserInputService.TouchEnabled and \"Tap to skip\" or \"Press Space to skip\" hint.Visible = data.skip ~= false hint.Parent = gui",
    "  local skipBtn = Instance.new(\"TextButton\") skipBtn.Name = \"SkipButton\" skipBtn.BackgroundTransparency = 1 skipBtn.Text = \"\" skipBtn.Size = UDim2.new(1, 0, 1, 0) skipBtn.ZIndex = 25 skipBtn.Visible = data.skip ~= false and UserInputService.TouchEnabled skipBtn.Parent = gui",
    "  local blur = nil",
    "  if (tonumber(data.blur) or 0) > 0 then blur = Instance.new(\"BlurEffect\") blur.Name = \"TotalCutsceneBlur\" blur.Size = 0 blur.Parent = Lighting end",
    "  local player = Players.LocalPlayer",
    "  gui.Parent = player and player:FindFirstChildOfClass(\"PlayerGui\") or player",
    "  local api = {gui = gui, skipBtn = skipBtn}",
    "  local function tween(inst, t, props) if t <= 0 then for k, v in pairs(props) do inst[k] = v end return end TweenService:Create(inst, TweenInfo.new(t, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), props):Play() end",
    "  function api.barsIn(t) local h = 0.12 tween(top, t, {Size = UDim2.new(1, 0, h, 0)}) tween(bottom, t, {Size = UDim2.new(1, 0, h, 0)}) tween(hint, t, {TextTransparency = 0.25}) if blur then tween(blur, t, {Size = tonumber(data.blur) or 0}) end end",
    "  function api.barsOut(t) tween(top, t, {Size = UDim2.new(1, 0, 0, 0)}) tween(bottom, t, {Size = UDim2.new(1, 0, 0, 0)}) tween(hint, t, {TextTransparency = 1}) if blur then tween(blur, t, {Size = 0}) end end",
    "  function api.fadeTo(alpha, t) tween(fade, t, {BackgroundTransparency = 1 - alpha}) end",
    "  function api.destroy() if blur then blur:Destroy() end gui:Destroy() end",
    "  return api",
    "end",
    "function M.play(nameOrData, opts)",
    "  opts = opts or {}",
    "  local data = loadData(nameOrData)",
    "  local shots = data.shots or {}",
    "  if #shots == 0 then error(\"cutscene \" .. tostring(data.name) .. \" has no shots\") end",
    "  if playing then M.stop() local t0 = os.clock() while playing and os.clock() - t0 < 2 do RunService.RenderStepped:Wait() end end",
    "  local cam = workspace.CurrentCamera",
    "  local player = Players.LocalPlayer",
    "  local prevType, prevCF, prevFov, prevSubject = cam.CameraType, cam.CFrame, cam.FieldOfView, cam.CameraSubject",
    "  local state = {name = data.name, skipped = false, done = false}",
    "  playing = state",
    "  local ui = makeGui(data)",
    "  if data.hide_hud ~= false then pcall(function() StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.All, false) end) end",
    "  local hum = player and player.Character and player.Character:FindFirstChildOfClass(\"Humanoid\")",
    "  local prevWalk, prevJump, prevJumpHeight = nil, nil, nil",
    "  if data.freeze_player ~= false and hum then prevWalk, prevJump, prevJumpHeight = hum.WalkSpeed, hum.JumpPower, hum.JumpHeight hum.WalkSpeed = 0 pcall(function() hum.JumpPower = 0 hum.JumpHeight = 0 end) end",
    "  local conns = {}",
    "  if data.skip ~= false then",
    "    conns[#conns + 1] = UserInputService.InputBegan:Connect(function(input, gp) if gp then return end if input.KeyCode == Enum.KeyCode.Space or input.KeyCode == Enum.KeyCode.Return or input.KeyCode == Enum.KeyCode.ButtonB or input.KeyCode == Enum.KeyCode.ButtonA then state.skipped = true end end)",
    "    conns[#conns + 1] = ui.skipBtn.Activated:Connect(function() state.skipped = true end)",
    "  end",
    "  cam.CameraType = Enum.CameraType.Scriptable",
    "  cam.CFrame = cfOf(shots[1]) cam.FieldOfView = shots[1].fov or prevFov",
    "  local fadeIn = tonumber(data.fade_in) or 0",
    "  if fadeIn > 0 then ui.fadeTo(1, 0) end",
    "  if data.letterbox ~= false then ui.barsIn(0.6) else ui.barsIn(0) end",
    "  if fadeIn > 0 then ui.fadeTo(0, fadeIn) end",
    "  local function waitFrames(seconds, f)",
    "    local t0 = os.clock()",
    "    while not state.skipped do",
    "      local k = seconds <= 0 and 1 or math.min(1, (os.clock() - t0) / seconds)",
    "      f(k)",
    "      if k >= 1 then break end",
    "      RunService.RenderStepped:Wait()",
    "    end",
    "  end",
    "  for i = 1, #shots do",
    "    if state.skipped then break end",
    "    local a, b = shots[i], shots[i + 1]",
    "    local cfa, fa = cfOf(a), a.fov or cam.FieldOfView",
    "    local hold = tonumber(a.hold) or 0",
    "    if hold > 0 then waitFrames(hold, function() cam.CFrame = cfa cam.FieldOfView = fa end) end",
    "    if b and not state.skipped then",
    "      local dur = math.max(0.01, tonumber(a.duration) or 2)",
    "      local style = Enum.EasingStyle[a.easing or \"Sine\"] or Enum.EasingStyle.Sine",
    "      local dir = Enum.EasingDirection[a.direction or \"InOut\"] or Enum.EasingDirection.InOut",
    "      local cfb, fb = cfOf(b), b.fov or fa",
    "      waitFrames(dur, function(k) local e = TweenService:GetValue(k, style, dir) cam.CFrame = cfa:Lerp(cfb, e) cam.FieldOfView = fa + (fb - fa) * e end)",
    "    end",
    "  end",
    "  local fadeOut = tonumber(data.fade_out) or 0",
    "  if fadeOut > 0 and not state.skipped then ui.fadeTo(1, fadeOut) waitFrames(fadeOut, function() end) end",
    "  for _, c in ipairs(conns) do c:Disconnect() end",
    "  ui.barsOut(0.35)",
    "  cam.FieldOfView = prevFov",
    "  cam.CameraType = prevType",
    "  if prevType ~= Enum.CameraType.Scriptable then cam.CameraSubject = hum or prevSubject end",
    "  if opts.restore_camera ~= false and data.restore_camera ~= false then cam.CFrame = prevCF end",
    "  if fadeOut > 0 and not state.skipped then ui.fadeTo(0, 0.4) end",
    "  if data.hide_hud ~= false then pcall(function() StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.All, true) end) end",
    "  if hum and prevWalk then hum.WalkSpeed = prevWalk pcall(function() hum.JumpPower = prevJump hum.JumpHeight = prevJumpHeight end) end",
    "  task.delay(0.8, function() ui.destroy() end)",
    "  playing = nil state.done = true",
    "  M.Completed:Fire(data.name, state.skipped)",
    "  return not state.skipped",
    "end",
    "function M.stop() if playing then playing.skipped = true end end",
    "function M.isPlaying() return playing ~= nil end",
    "function M.duration(nameOrData) local d = loadData(nameOrData) local t = 0 for i, s in ipairs(d.shots or {}) do t = t + (tonumber(s.hold) or 0) if i < #d.shots then t = t + (tonumber(s.duration) or 2) end end return t end",
    "return M",
  ].join("\n");

  // StarterPlayerScripts.TotalCutsceneClient - plays what the server asks for
  // and reports back; a client script can also fire the same remote locally.
  const CLIENT_SRC = [
    "-- TotalScript cutscene client " + VERSION + ". Server: ReplicatedStorage.TotalCutscenes.PlayCutscene:FireClient(player, \"Intro\")",
    "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")",
    "local folder = ReplicatedStorage:WaitForChild(\"TotalCutscenes\")",
    "local Player = require(folder:WaitForChild(\"CutscenePlayer\"))",
    "local remote = folder:WaitForChild(\"PlayCutscene\")",
    "remote.OnClientEvent:Connect(function(name, opts)",
    "  local okP, res = pcall(Player.play, name, opts)",
    "  if not okP then warn(\"[TotalCutscenes] \" .. tostring(res)) end",
    "  remote:FireServer(name, okP and res == true)",
    "end)",
  ].join("\n");

  // ServerScriptService.TotalCutsceneTrigger_<Name>
  function triggerSrc(name, kind, partPath, delay, once, cooldown, prompt) {
    const L = [
      "-- TotalScript cutscene trigger " + VERSION + " - plays \"" + name + "\" on " + kind + ". Generated by cutscene_trigger; safe to edit.",
      "local Players = game:GetService(\"Players\")",
      "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")",
      "local NAME = \"" + name + "\"",
      "local DELAY = " + nn(delay, 0),
      "local ONCE = " + bb(once, true),
      "local COOLDOWN = " + nn(cooldown, 5),
      "local remote = ReplicatedStorage:WaitForChild(\"TotalCutscenes\"):WaitForChild(\"PlayCutscene\")",
      "local seen = {}",
      "local lastAt = {}",
      "local function play(player)",
      "  if not player or not player.Parent then return end",
      "  if ONCE and seen[player.UserId] then return end",
      "  local now = os.clock()",
      "  if lastAt[player.UserId] and now - lastAt[player.UserId] < COOLDOWN then return end",
      "  lastAt[player.UserId] = now",
      "  seen[player.UserId] = true",
      "  if DELAY > 0 then task.wait(DELAY) end",
      "  if player.Parent then remote:FireClient(player, NAME) end",
      "end",
      "remote.OnServerEvent:Connect(function(player, name, finished) if name == NAME then player:SetAttribute(\"TotalCutscene_\" .. NAME, finished and \"finished\" or \"skipped\") end end)",
      "Players.PlayerRemoving:Connect(function(player) seen[player.UserId] = nil lastAt[player.UserId] = nil end)",
    ];
    if (kind === "spawn") {
      L.push(
        "local function hook(player) player.CharacterAdded:Connect(function() task.spawn(play, player) end) if player.Character then task.spawn(play, player) end end",
        "Players.PlayerAdded:Connect(hook)",
        "for _, p in ipairs(Players:GetPlayers()) do hook(p) end"
      );
    } else if (kind === "touch") {
      L.push(
        "local part = " + luaPath(partPath),
        "if not part then warn(\"[TotalCutsceneTrigger] part not found: " + partPath + "\") return end",
        "part.Touched:Connect(function(hit) local player = Players:GetPlayerFromCharacter(hit and hit.Parent) if player then task.spawn(play, player) end end)"
      );
    } else if (kind === "proximity") {
      L.push(
        "local part = " + luaPath(partPath),
        "if not part then warn(\"[TotalCutsceneTrigger] part not found: " + partPath + "\") return end",
        "local pp = part:FindFirstChild(\"TotalCutscenePrompt\") or Instance.new(\"ProximityPrompt\")",
        "pp.Name = \"TotalCutscenePrompt\" pp.ActionText = \"" + String(prompt || "Watch").replace(/["\\]/g, "") + "\" pp.ObjectText = NAME pp.HoldDuration = 0 pp.MaxActivationDistance = 10 pp.RequiresLineOfSight = false pp.Parent = part",
        "pp.Triggered:Connect(function(player) task.spawn(play, player) end)"
      );
    }
    return L.join("\n");
  }
  // "Workspace.Zone.Pad" -> a nil-safe walk from the service down (Lua 5.4 compatible).
  function luaPath(p) {
    const segs = String(p || "").replace(/^game\./i, "").split(".").filter(Boolean);
    if (!segs.length) return "nil";
    const svc = /^workspace$/i.test(segs[0]) ? "Workspace" : segs[0].replace(/["\\]/g, "");
    const rest = segs.slice(1).map((x) => "\"" + x.replace(/["\\]/g, "") + "\"");
    return "(function() local cur = game:GetService(\"" + svc + "\") for _, seg in ipairs({" + rest.join(", ") + "}) do cur = cur and cur:FindFirstChild(seg) end return cur end)()";
  }

  // ── Luau library for the commands ─────────────────────────────────────────
  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local ReplicatedStorage=game:GetService('ReplicatedStorage')",
    "local ServerScriptService=game:GetService('ServerScriptService')",
    "local StarterPlayer=game:GetService('StarterPlayer')",
    "local TweenService=game:GetService('TweenService')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local RUNTIME_VERSION=" + q(VERSION),
    "local RUNTIME_SRC=" + q(RUNTIME_SRC),
    "local CLIENT_SRC=" + q(CLIENT_SRC),
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end",
    "local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end local cur=game for seg in p:gmatch('[^%.]+') do local nxt=nil if cur==game then local okS,svc=pcall(function() return game:GetService(seg) end) if okS and svc then nxt=svc end if not nxt and seg:lower()=='workspace' then nxt=workspace end end if not nxt then nxt=cur:FindFirstChild(seg) end if not nxt then return nil end cur=nxt end return cur end",
    "local function bboxOf(root) if root:IsA('BasePart') then return root.CFrame,root.Size end if root:IsA('Model') then local cf,sz=root:GetBoundingBox() return cf,sz end if root:IsA('Attachment') then return root.WorldCFrame,Vector3.new(1,1,1) end return CFrame.new(),Vector3.new(1,1,1) end",
    "local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('TotalScript cutscene') end) return okW and w or nil end",
    "local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end",
    "local function folder(parent,name) local f=parent:FindFirstChild(name) if not f then f=Instance.new('Folder') f.Name=name f.Parent=parent end return f end",
    "local function csRoot() return folder(ReplicatedStorage,'TotalCutscenes') end",
    "local function csFind(name) local r=ReplicatedStorage:FindFirstChild('TotalCutscenes') local m=r and r:FindFirstChild(tostring(name or '')) if m and m:IsA('ModuleScript') and m:GetAttribute('TotalCutscene') then return m end return nil end",
    "local function csAll() local out={} local r=ReplicatedStorage:FindFirstChild('TotalCutscenes') if r then for _,m in ipairs(r:GetChildren()) do if m:IsA('ModuleScript') and m:GetAttribute('TotalCutscene') then out[#out+1]=m end end end table.sort(out,function(a,b) return a.Name<b.Name end) return out end",
    "local function csLoad(m) local raw=m:GetAttribute('ShotsJSON') local okD,d=pcall(function() return HttpService:JSONDecode(raw or '') end) if not okD or type(d)~='table' then d={} end d.name=m.Name d.shots=d.shots or {} return d end",
    "local function cfArr(cf) return {cf:GetComponents()} end",
    "local function arrCf(c) return CFrame.new(c[1],c[2],c[3],c[4],c[5],c[6],c[7],c[8],c[9],c[10],c[11],c[12]) end",
    "local function csDuration(d) local t=0 for i,s in ipairs(d.shots) do t=t+(tonumber(s.hold) or 0) if i<#d.shots then t=t+(tonumber(s.duration) or 2) end end return t end",
    "local function fmt(n) n=tonumber(n) or 0 if math.abs(n-math.floor(n+0.5))<1e-6 then return tostring(math.floor(n+0.5)) end local s=string.format('%.4f',n) s=s:gsub('0+$','') s=s:gsub('%.$','') return s end",
    "local function luaStr(s) return string.format('%q',tostring(s)) end",
    "local function csRender(d) local L={} L[#L+1]='-- TotalScript cutscene '..luaStr(d.name)..' ('..#d.shots..' shots, '..fmt(csDuration(d))..'s) - generated by cutscene_create; edit with cutscene_shot_add / cutscene_shot_from_camera or by hand (keep this shape).' L[#L+1]='-- Play on the client: require(game.ReplicatedStorage.TotalCutscenes.CutscenePlayer).play('..luaStr(d.name)..')   Server: ReplicatedStorage.TotalCutscenes.PlayCutscene:FireClient(player, '..luaStr(d.name)..')' L[#L+1]='-- duration = seconds to travel to the NEXT shot; hold = seconds to stay on this shot first; easing/direction = Enum.EasingStyle / Enum.EasingDirection names.' L[#L+1]='return {' L[#L+1]='  name = '..luaStr(d.name)..',' L[#L+1]='  letterbox = '..tostring(d.letterbox~=false)..', fade_in = '..fmt(d.fade_in or 0)..', fade_out = '..fmt(d.fade_out or 0)..', skip = '..tostring(d.skip~=false)..', hide_hud = '..tostring(d.hide_hud~=false)..', freeze_player = '..tostring(d.freeze_player~=false)..', blur = '..fmt(d.blur or 0)..',' L[#L+1]='  shots = {' for i,s in ipairs(d.shots) do local parts={} for j=1,12 do parts[j]=fmt(s.cf[j]) end L[#L+1]='    { name = '..luaStr(s.name or ('shot'..i))..', cf = CFrame.new('..table.concat(parts,', ')..'), fov = '..fmt(s.fov or 70)..', duration = '..fmt(s.duration or 2)..', hold = '..fmt(s.hold or 0)..', easing = '..luaStr(s.easing or 'Sine')..', direction = '..luaStr(s.direction or 'InOut')..' },' end L[#L+1]='  },' L[#L+1]='}' return table.concat(L,'\\n') end",
    "local function csSave(m,d) m:SetAttribute('TotalCutscene',true) m:SetAttribute('ShotsJSON',HttpService:JSONEncode(d)) m:SetAttribute('Shots',#d.shots) m:SetAttribute('Duration',csDuration(d)) m.Source=csRender(d) end",
    "local function csEnsureRuntime() local root=csRoot() local made={} local pl=root:FindFirstChild('CutscenePlayer') if not pl or not pl:IsA('ModuleScript') then if pl then pl:Destroy() end pl=Instance.new('ModuleScript') pl.Name='CutscenePlayer' pl.Parent=root made[#made+1]='CutscenePlayer' end if pl:GetAttribute('TotalVersion')~=RUNTIME_VERSION then pl.Source=RUNTIME_SRC pl:SetAttribute('TotalVersion',RUNTIME_VERSION) end local ev=root:FindFirstChild('PlayCutscene') if not ev or not ev:IsA('RemoteEvent') then if ev then ev:Destroy() end ev=Instance.new('RemoteEvent') ev.Name='PlayCutscene' ev.Parent=root made[#made+1]='PlayCutscene' end local sps=StarterPlayer:FindFirstChild('StarterPlayerScripts') if sps then local cl=sps:FindFirstChild('TotalCutsceneClient') if not cl or not cl:IsA('LocalScript') then if cl then cl:Destroy() end cl=Instance.new('LocalScript') cl.Name='TotalCutsceneClient' cl.Parent=sps made[#made+1]='TotalCutsceneClient' end if cl:GetAttribute('TotalVersion')~=RUNTIME_VERSION then cl.Source=CLIENT_SRC cl:SetAttribute('TotalVersion',RUNTIME_VERSION) end end return made end",
    "local function camPreset(c,sz,preset,dist,height) local r=math.max(sz.X,sz.Y,sz.Z,1) local look=c.LookVector local right=c.RightVector local d=tonumber(dist) or r*(preset=='closeup' and 0.9 or preset=='hero_low' and 1.6 or preset=='top_down' and 2.5 or 2.2) local pos if preset=='closeup' then pos=c.Position+look*d+Vector3.new(0,sz.Y*0.15,0) elseif preset=='hero_low' then pos=c.Position+(look*0.8+right*0.6).Unit*d-Vector3.new(0,sz.Y*0.35,0) elseif preset=='top_down' then pos=c.Position+Vector3.new(0.01,d,0.01) elseif preset=='side' then pos=c.Position+right*d+Vector3.new(0,sz.Y*0.2,0) elseif preset=='behind' then pos=c.Position-look*d+Vector3.new(0,sz.Y*0.5,0) else pos=c.Position+(look+right*0.35).Unit*d+Vector3.new(0,sz.Y*0.45,0) end if height~=nil then pos=Vector3.new(pos.X,c.Position.Y+tonumber(height),pos.Z) end return CFrame.lookAt(pos,c.Position) end",
    "local function csResolveShot(s,i) local cf if s.cframe then cf=arrCf(s.cframe) elseif s.part then local p=resolve(s.part) if not p then error('shot '..i..': part not found: '..tostring(s.part)) end cf=bboxOf(p) elseif s.target then local t=resolve(s.target) if not t then error('shot '..i..': target not found: '..tostring(s.target)) end local c,sz=bboxOf(t) cf=camPreset(c,sz,tostring(s.preset or 'wide'),s.distance,s.height) elseif s.pos then local look=s.look if not look and s.lookPath then local li=resolve(s.lookPath) if not li then error('shot '..i..': look_at not found: '..tostring(s.lookPath)) end local lc=bboxOf(li) look=lc.Position end if look then cf=CFrame.lookAt(s.pos,look) else cf=CFrame.new(s.pos) end else error('shot '..i..': give position (+ look_at), cframe, part or target') end if (tonumber(s.roll) or 0)~=0 then cf=cf*CFrame.Angles(0,0,math.rad(tonumber(s.roll))) end return {name=s.name or ('shot'..i),cf=cfArr(cf),fov=math.clamp(tonumber(s.fov) or 70,1,120),duration=math.max(0.05,tonumber(s.duration) or 2),hold=math.max(0,tonumber(s.hold) or 0),easing=s.easing or 'Sine',direction=s.direction or 'InOut'} end",
    "local function csSummary(m) local d=csLoad(m) local names={} for i,s in ipairs(d.shots) do names[i]=(s.name or ('shot'..i))..' ('..fmt(s.fov or 70)..'deg'..(i<#d.shots and (' -> '..fmt(s.duration or 2)..'s '..tostring(s.easing or 'Sine')) or '')..((tonumber(s.hold) or 0)>0 and (' hold '..fmt(s.hold)..'s') or '')..')' end return {name=m.Name,path=m:GetFullName(),shots=#d.shots,duration=csDuration(d),letterbox=d.letterbox~=false,fade_in=d.fade_in or 0,fade_out=d.fade_out or 0,skip=d.skip~=false,shot_list=names} end",
    "local function usage(name) return 'Play it: server -> ReplicatedStorage.TotalCutscenes.PlayCutscene:FireClient(player, '..luaStr(name)..')  |  client -> require(ReplicatedStorage.TotalCutscenes.CutscenePlayer).play('..luaStr(name)..')  |  cutscene_trigger {name, trigger: spawn | touch | proximity} wires it; cutscene_preview {name} plays it on the Studio camera now.' end",
  ].join("\n");

  const B = {};

  // Create (or replace) a cutscene from a list of shots.
  B.cutscene_create = (a) => {
    const name = ident(a.name, "Cutscene");
    const shots = shotsLiteral(a.shots || a.keyframes || [], { fov: a.fov, duration: a.duration, hold: a.hold, easing: a.easing, direction: a.direction });
    return [
      "local name=" + q(name) + " local input=" + shots + " local opts=" + optsLiteral(a) + " local replace=" + bb(a.replace, true),
      "if #input<2 then return fail('a cutscene needs at least 2 shots (got '..#input..') - each shot: {position:[x,y,z], look_at:[x,y,z]|path} or {target:path, preset:wide|closeup|hero_low|top_down|side|behind} or {part:path} or {cframe:[12 numbers]}, plus fov / duration / hold / easing') end",
      "local existing=csFind(name) if existing and not replace then return fail('cutscene '..name..' already exists - pass replace:true, use cutscene_shot_add, or pick another name') end",
      "local d={name=name,shots={},letterbox=opts.letterbox,fade_in=opts.fade_in,fade_out=opts.fade_out,skip=opts.skip,hide_hud=opts.hide_hud,freeze_player=opts.freeze_player,blur=opts.blur}",
      "for i,s in ipairs(input) do d.shots[i]=csResolveShot(s,i) end",
      "local rec=wp() local made=csEnsureRuntime()",
      "local m=existing if not m then m=Instance.new('ModuleScript') m.Name=name m.Parent=csRoot() end csSave(m,d) wpDone(rec)",
      "local sum=csSummary(m) sum.runtime_created=made sum.usage=usage(name)",
      "return ok(sum,'cutscene '..name..': '..#d.shots..' shots, '..fmt(csDuration(d))..'s total ('..table.concat(sum.shot_list,'; ')..'). '..(#made>0 and ('Runtime installed: '..table.concat(made,', ')..'. ') or '')..'Next: cutscene_preview {name:'..luaStr(name)..'} to watch it on the Studio camera, then cutscene_trigger to wire it into the game.')",
    ].join("\n");
  };
  // Legacy name (was a stub until 1.76): same contract as cutscene_create.
  B.cutscene_camera_track = (a) => {
    const list = a.shots || a.keyframes || a.keys || a.track;
    if (!Array.isArray(list) || list.length < 2) return "return fail('cutscene_camera_track now builds a REAL cutscene and needs shots: pass shots:[{position:[x,y,z], look_at:[x,y,z]|path, fov?, duration?, hold?, easing?}, ...] (at least 2) - or call cutscene_create with the same parameters; duration/fov alone create nothing')";
    return B.cutscene_create(Object.assign({}, a, { shots: list }));
  };

  // Append one shot (or several) to an existing cutscene.
  B.cutscene_shot_add = (a) => {
    const name = ident(a.name, "Cutscene");
    // Either shots:[...] (each may carry its own name) or ONE shot given as the
    // top-level params (name is the cutscene then; shot_name names the shot).
    const list = Array.isArray(a.shots) ? a.shots : [(() => { const c = Object.assign({}, a.shot || a); delete c.name; delete c.index; if (a.shot_name) c.name = a.shot_name; return c; })()];
    const shots = shotsLiteral(list, {});
    return [
      "local m=csFind(" + q(name) + ") if not m then return fail('no cutscene named " + name + " - cutscene_list shows the existing ones, cutscene_create makes a new one') end",
      "local input=" + shots + " local at=" + (num(a.index) !== null ? nn(a.index) : "nil"),
      "local rec=wp() local d=csLoad(m) local added={} local base=#d.shots",
      "for i,s in ipairs(input) do local shot=csResolveShot(s,base+i) if at and at>=1 and at<=#d.shots+1 then table.insert(d.shots,at,shot) at=at+1 else d.shots[#d.shots+1]=shot end added[#added+1]=shot.name end",
      "csSave(m,d) wpDone(rec)",
      "local sum=csSummary(m)",
      "return ok(sum,'added '..#added..' shot(s) to '..m.Name..' - now '..#d.shots..' shots, '..fmt(csDuration(d))..'s. cutscene_preview {name:'..luaStr(m.Name)..'} to check the move.')",
    ].join("\n");
  };

  // Capture the current Studio camera as the next shot.
  B.cutscene_shot_from_camera = (a) => {
    const name = ident(a.name, "Cutscene");
    return [
      "local cam=workspace.CurrentCamera if not cam then return fail('no Studio camera') end",
      "local m=csFind(" + q(name) + ") local rec=wp() local made={} if not m then made=csEnsureRuntime() m=Instance.new('ModuleScript') m.Name=" + q(name) + " m.Parent=csRoot() csSave(m,{name=" + q(name) + ",shots={}}) end",
      "local d=csLoad(m) local shot={name=" + (a.shot_name ? q(a.shot_name) : "nil") + ",cf=cfArr(cam.CFrame),fov=math.clamp(" + (num(a.fov) !== null ? nn(a.fov) : "cam.FieldOfView") + ",1,120),duration=math.max(0.05," + nn(a.duration, 2) + "),hold=math.max(0," + nn(a.hold, 0) + "),easing=" + q((easingName(a.easing, "Sine"))) + ",direction=" + q(dirName(a.direction, "InOut")) + "} shot.name=shot.name or ('shot'..(#d.shots+1))",
      "d.shots[#d.shots+1]=shot csSave(m,d) wpDone(rec)",
      "local p=cam.CFrame.Position local sum=csSummary(m) sum.captured={position={p.X,p.Y,p.Z},fov=shot.fov,name=shot.name}",
      "return ok(sum,'captured the Studio camera as shot '..#d.shots..' of '..m.Name..' at ('..fmt(p.X)..', '..fmt(p.Y)..', '..fmt(p.Z)..') fov '..fmt(shot.fov)..'. '..(#d.shots<2 and 'Move the camera (camera_look_at / camera_dolly or by hand) and capture again - a cutscene needs 2+ shots.' or 'cutscene_preview {name:'..luaStr(m.Name)..'} plays it.'))",
    ].join("\n");
  };

  // Build a cutscene from camera marker parts in a folder / model (Shot1, Shot2, ...).
  B.cutscene_shots_from_path = (a) => {
    const name = ident(a.name, "Cutscene");
    return [
      "local root=resolve(" + q(a.path || "") + ") if not root then return fail('path not found: " + String(a.path || "").replace(/'/g, "") + " - a Folder or Model holding camera marker parts (Shot1, Shot2, ... each part looks where the camera should look)') end",
      "local parts={} for _,c in ipairs(root:GetChildren()) do if c:IsA('BasePart') then parts[#parts+1]=c end end",
      "if #parts<2 then return fail('need at least 2 BasePart markers under '..root:GetFullName()..' (got '..#parts..')') end",
      "local function key(p) local n=tonumber(p.Name:match('(%d+)%s*$')) return n or math.huge end table.sort(parts,function(x,y) local kx,ky=key(x),key(y) if kx~=ky then return kx<ky end return x.Name<y.Name end)",
      "local name=" + q(name) + " local existing=csFind(name) if existing and not " + bb(a.replace, true) + " then return fail('cutscene '..name..' already exists - pass replace:true') end",
      "local opts=" + optsLiteral(a) + " local rec=wp() local made=csEnsureRuntime() local d={name=name,shots={},letterbox=opts.letterbox,fade_in=opts.fade_in,fade_out=opts.fade_out,skip=opts.skip,hide_hud=opts.hide_hud,freeze_player=opts.freeze_player,blur=opts.blur}",
      "for i,p in ipairs(parts) do d.shots[i]={name=p.Name,cf=cfArr(p.CFrame),fov=math.clamp(tonumber(p:GetAttribute('FOV')) or " + nn(a.fov, 70) + ",1,120),duration=math.max(0.05,tonumber(p:GetAttribute('Duration')) or " + nn(a.duration, 2) + "),hold=math.max(0,tonumber(p:GetAttribute('Hold')) or " + nn(a.hold, 0) + "),easing=p:GetAttribute('Easing') or " + q((easingName(a.easing, "Sine"))) + ",direction=p:GetAttribute('Direction') or " + q(dirName(a.direction, "InOut")) + "} end",
      "local m=existing if not m then m=Instance.new('ModuleScript') m.Name=name m.Parent=csRoot() end csSave(m,d) wpDone(rec)",
      "local sum=csSummary(m) sum.markers=#parts sum.runtime_created=made sum.usage=usage(name)",
      "return ok(sum,'cutscene '..name..' built from '..#parts..' marker parts under '..root.Name..' ('..fmt(csDuration(d))..'s). Per-part attributes FOV / Duration / Hold / Easing / Direction override the defaults. cutscene_preview {name:'..luaStr(name)..'} to watch it.')",
    ].join("\n");
  };

  // Play a cutscene on the Studio camera (edit mode), with FOV, then restore.
  B.cutscene_preview = (a) => {
    const name = ident(a.name, "Cutscene");
    return [
      "local m=csFind(" + q(name) + ") if not m then return fail('no cutscene named " + name + " - cutscene_list') end",
      "local d=csLoad(m) if #d.shots<2 then return fail('cutscene '..m.Name..' has '..#d.shots..' shot(s) - add shots first (cutscene_shot_add / cutscene_shot_from_camera)') end",
      "local cam=workspace.CurrentCamera if not cam then return fail('no Studio camera') end local speed=math.max(0.1," + nn(a.speed, 1) + ") local fromShot=math.clamp(" + nn(a.from_shot, 1) + ",1,#d.shots) local restore=" + bb(a.restore, true),
      "local startCF,startFov,startType=cam.CFrame,cam.FieldOfView,cam.CameraType",
      "cam.CameraType=Enum.CameraType.Scriptable cam.CFrame=arrCf(d.shots[fromShot].cf) cam.FieldOfView=d.shots[fromShot].fov or startFov",
      "task.spawn(function() for i=fromShot,#d.shots do local s,nxt=d.shots[i],d.shots[i+1] local cfa,fa=arrCf(s.cf),s.fov or startFov local hold=(tonumber(s.hold) or 0)/speed if hold>0 then local t0=os.clock() while os.clock()-t0<hold do cam.CFrame=cfa cam.FieldOfView=fa task.wait() end end if nxt then local dur=math.max(0.05,(tonumber(s.duration) or 2)/speed) local st=Enum.EasingStyle[s.easing or 'Sine'] or Enum.EasingStyle.Sine local dr=Enum.EasingDirection[s.direction or 'InOut'] or Enum.EasingDirection.InOut local cfb,fb=arrCf(nxt.cf),nxt.fov or fa local t0=os.clock() while true do local k=math.min(1,(os.clock()-t0)/dur) local e=TweenService:GetValue(k,st,dr) cam.CFrame=cfa:Lerp(cfb,e) cam.FieldOfView=fa+(fb-fa)*e if k>=1 then break end task.wait() end end end task.wait(0.25) cam.FieldOfView=startFov cam.CameraType=startType==Enum.CameraType.Scriptable and Enum.CameraType.Fixed or startType if restore then cam.CFrame=startCF end end)",
      "local sum=csSummary(m) sum.speed=speed sum.preview_seconds=csDuration(d)/speed",
      "return ok(sum,'previewing '..m.Name..' on the Studio camera: '..#d.shots..' shots over '..fmt(csDuration(d)/speed)..'s'..(speed~=1 and (' (speed x'..fmt(speed)..')') or '')..' - letterbox / fade / skip only show in Play mode (studio_playtest). total_screenshot mid-way to judge the framing; adjust with cutscene_shot_add {index} or re-create.')",
    ].join("\n");
  };

  // Wire a cutscene into the game.
  B.cutscene_trigger = (a) => {
    const name = ident(a.name, "Cutscene");
    const kind = /^(touch|proximity|remote|spawn)$/.test(String(a.trigger || a.kind || "").toLowerCase()) ? String(a.trigger || a.kind).toLowerCase() : "spawn";
    const part = String(a.part || a.path || "");
    if ((kind === "touch" || kind === "proximity") && !part) return "return fail('cutscene_trigger " + kind + " needs part: the BasePart (full path) the player touches / interacts with')";
    const src = kind === "remote" ? "" : triggerSrc(name, kind, part, num(a.delay) || 0, a.once === undefined ? true : a.once, num(a.cooldown) === null ? 5 : num(a.cooldown), a.prompt_text || a.action_text || "Watch");
    return [
      "local m=csFind(" + q(name) + ") if not m then return fail('no cutscene named " + name + " - create it first (cutscene_create)') end",
      "local kind=" + q(kind) + " local rec=wp() local made=csEnsureRuntime()",
      kind === "remote"
        ? "wpDone(rec) return ok({name=m.Name,trigger='remote',remote='ReplicatedStorage.TotalCutscenes.PlayCutscene',runtime_created=made},'no script needed: from any server Script call ReplicatedStorage.TotalCutscenes.PlayCutscene:FireClient(player, '..luaStr(m.Name)..'); the client answers on the same remote with OnServerEvent(player, name, finished). From a LocalScript: require(ReplicatedStorage.TotalCutscenes.CutscenePlayer).play('..luaStr(m.Name)..').')"
        : [
          (kind === "touch" || kind === "proximity") ? "local part=resolve(" + q(part) + ") if not part or not part:IsA('BasePart') then wpDone(rec) return fail('part not found or not a BasePart: " + part.replace(/'/g, "") + "') end" : "",
          "local sname='TotalCutsceneTrigger_'..m.Name local old=ServerScriptService:FindFirstChild(sname) if old then old:Destroy() end",
          "local s=Instance.new('Script') s.Name=sname s.Source=" + q(src) + " s:SetAttribute('Cutscene',m.Name) s:SetAttribute('Trigger',kind) s.Parent=ServerScriptService wpDone(rec)",
          "return ok({name=m.Name,trigger=kind,script=s:GetFullName(),part=" + ((kind === "touch" || kind === "proximity") ? "part:GetFullName()" : "nil") + ",once=" + bb(a.once === undefined ? true : a.once, true) + ",delay=" + nn(a.delay, 0) + ",runtime_created=made},'trigger installed: '..s:GetFullName()..' plays '..m.Name..' on '..kind.." + (kind === "spawn" ? "' (every time a character spawns; once per player by default)'" : kind === "touch" ? "' of '..part:GetFullName()..' (5s cooldown; once per player by default)'" : "' prompt on '..part:GetFullName()") + "..'. Test it with studio_playtest / start_stop_play - the letterbox, fade and skip only exist in Play mode.')",
        ].filter(Boolean).join("\n"),
    ].join("\n");
  };

  B.cutscene_list = () => [
    "local out={} for _,m in ipairs(csAll()) do out[#out+1]=csSummary(m) end",
    "local root=ReplicatedStorage:FindFirstChild('TotalCutscenes') local rt=root and root:FindFirstChild('CutscenePlayer') local triggers={} for _,s in ipairs(ServerScriptService:GetChildren()) do if s:IsA('Script') and s:GetAttribute('Cutscene') then triggers[#triggers+1]={script=s.Name,cutscene=s:GetAttribute('Cutscene'),trigger=s:GetAttribute('Trigger')} end end",
    "return ok({cutscenes=out,count=#out,runtime=rt and rt:GetFullName() or nil,runtime_version=rt and rt:GetAttribute('TotalVersion') or nil,triggers=triggers},#out==0 and 'no cutscenes yet - cutscene_create {name, shots:[...]} makes one' or (#out..' cutscene(s): '..(function() local n={} for i,c in ipairs(out) do n[i]=c.name..' ('..c.shots..' shots, '..fmt(c.duration)..'s)' end return table.concat(n,', ') end)()))",
  ].join("\n");

  B.cutscene_delete = (a) => {
    const name = ident(a.name, "Cutscene");
    return [
      "local m=csFind(" + q(name) + ") if not m then return fail('no cutscene named " + name + "') end",
      "local rec=wp() local removed={m:GetFullName()} m:Destroy() local t=ServerScriptService:FindFirstChild('TotalCutsceneTrigger_" + name + "') if t then removed[#removed+1]=t:GetFullName() t:Destroy() end wpDone(rec)",
      "return ok({removed=removed},'deleted cutscene " + name + " (and its trigger script if any); the shared runtime stays for the other cutscenes')",
    ].join("\n");
  };

  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const SHOT_DESC = "array of shots (2+). Each: {position:[x,y,z], look_at:[x,y,z] | \"Workspace.Boss\"} | {target:\"Workspace.Boss\", preset:\"wide|closeup|hero_low|top_down|side|behind\", distance?, height?} | {part:\"Workspace.CamPath.Shot1\"} | {cframe:[12 numbers]}; plus fov? (deg), duration? (seconds to travel to the NEXT shot, default 2), hold? (seconds to stay on this shot first), easing? (Sine|Quad|Cubic|Linear|Back|...), direction? (In|Out|InOut), roll? (deg), name?";
  const C = [
    { name: "cutscene_create", description: "Create a REAL cutscene: ReplicatedStorage.TotalCutscenes.<Name> (ModuleScript with the shot list) plus the shared client runtime (CutscenePlayer: eased camera moves between shots, FOV, hold, letterbox bars, fade in/out, skip with Space / tap, HUD hidden, character frozen, camera restored, Completed event), the PlayCutscene RemoteEvent and the StarterPlayerScripts client. Then cutscene_preview to watch it in Studio and cutscene_trigger to wire it.", params: { name: S("string", true, "cutscene name (identifier)"), shots: S("array", true, SHOT_DESC), letterbox: S("boolean", false, "black bars (default true)"), fade_in: S("number", false, "seconds from black (default 0)"), fade_out: S("number", false, "seconds to black at the end (default 0)"), skip: S("boolean", false, "allow Space / tap to skip (default true)"), hide_hud: S("boolean", false, "hide the core GUI while playing (default true)"), freeze_player: S("boolean", false, "WalkSpeed/Jump 0 while playing (default true)"), blur: S("number", false, "BlurEffect size while playing (default 0)"), fov: S("number", false, "default FOV for shots without one (70)"), duration: S("number", false, "default travel seconds for shots without one (2)"), easing: S("string", false, "default easing (Sine)"), replace: S("boolean", false, "overwrite an existing cutscene of that name (default true)") } },
    { name: "cutscene_shot_add", description: "Append shots to an existing cutscene (or insert at index). Same shot shapes as cutscene_create.", params: { name: S("string", true), shots: S("array", true, SHOT_DESC), index: S("number", false, "insert position (1-based); default append") } },
    { name: "cutscene_shot_from_camera", description: "Capture the CURRENT Studio camera (CFrame + FOV) as the next shot of a cutscene (creates the cutscene if missing). Frame with camera_look_at / camera_dolly or by hand, capture, move, capture again.", params: { name: S("string", true), duration: S("number", false, "travel seconds to the next shot (default 2)"), hold: S("number", false, "seconds to stay on this shot (default 0)"), fov: S("number", false, "override the camera FOV"), easing: S("string", false), direction: S("string", false), shot_name: S("string", false) } },
    { name: "cutscene_shots_from_path", description: "Build a cutscene from camera marker parts under a Folder/Model (sorted Shot1, Shot2, ...; each part's LookVector is the camera direction; per-part attributes FOV / Duration / Hold / Easing / Direction override the defaults).", params: { name: S("string", true), path: S("string", true, "Folder or Model holding the marker parts"), duration: S("number", false), hold: S("number", false), fov: S("number", false), easing: S("string", false), letterbox: S("boolean", false), fade_in: S("number", false), fade_out: S("number", false), replace: S("boolean", false) } },
    { name: "cutscene_preview", description: "Play a cutscene on the Studio camera right now (edit mode): every shot, easing and FOV change, then the camera is restored. Letterbox / fade / skip only exist in Play mode. total_screenshot mid-way to judge framing.", params: { name: S("string", true), speed: S("number", false, "playback multiplier (default 1)"), from_shot: S("number", false, "start at this shot (1-based)"), restore: S("boolean", false, "restore the camera afterwards (default true)") } },
    { name: "cutscene_trigger", description: "Wire a cutscene into the game with a server Script (ServerScriptService.TotalCutsceneTrigger_<Name>): spawn = when the character spawns, touch = when a player touches a part, proximity = ProximityPrompt on a part, remote = no script, just the FireClient recipe. Once per player by default.", params: { name: S("string", true), trigger: S("string", true, "spawn | touch | proximity | remote"), part: S("string", false, "BasePart path for touch / proximity"), once: S("boolean", false, "only once per player (default true)"), delay: S("number", false, "seconds before it starts (default 0)"), cooldown: S("number", false, "seconds between repeats per player when once=false (default 5)"), prompt_text: S("string", false, "ProximityPrompt action text (default Watch)") } },
    { name: "cutscene_list", description: "List every cutscene (shots, duration, options), the runtime version and the trigger scripts.", params: {} },
    { name: "cutscene_delete", description: "Delete a cutscene module and its trigger script (the shared runtime stays).", params: { name: S("string", true) } },
    { name: "cutscene_camera_track", hidden: true, description: "Legacy name for cutscene_create (it was a no-op stub before 1.77): builds a real cutscene from shots:[...] - prefer cutscene_create.", params: { name: S("string", true), shots: S("array", true, SHOT_DESC), fov: S("number", false), duration: S("number", false) } },
  ];

  function buildCutscene(op, args) {
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
    const extra = buildCutscene(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  // Replace any earlier (stub) catalogue entry of the same name with the real one.
  const names = new Set(C.map((c) => c.name));
  // Mutate IN PLACE: studio_skills.js keeps its own reference to this array
  // (describeCommands reads it), so reassigning would split the catalogue.
  const arr = RobloxScriptSkills.SKILL_COMMANDS;
  for (let i = arr.length - 1; i >= 0; i--) if (names.has(arr[i].name)) arr.splice(i, 1);
  for (const c of C) arr.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.CUTSCENE_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.CUTSCENE_RUNTIME_SRC = RUNTIME_SRC;
  RobloxScriptSkills.CUTSCENE_CLIENT_SRC = CLIENT_SRC;
  RobloxScriptSkills.CUTSCENE_VERSION = VERSION;
})();
