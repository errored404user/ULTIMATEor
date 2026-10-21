// SPDX-License-Identifier: GPL-3.0-or-later
// Extra Roblox Studio commands extension suite (deduplicated production tools).
// Extends RobloxScriptSkills with high-utility Studio primitives and automation helpers.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  function luaStr(s) {
    return '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ") + '"';
  }
  function num3(v, d) {
    const a = Array.isArray(v) ? v : d;
    return [
      Number(a[0]) || d[0] || 0,
      Number(a[1]) || d[1] || 0,
      Number(a[2]) || d[2] || 0,
    ];
  }
  function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  function bool(v, d) {
    if (v === true || v === "true") return "true";
    if (v === false || v === "false") return "false";
    return d ? "true" : "false";
  }

  const HEAD = [
    'local HttpService=game:GetService("HttpService")',
    "local function resolve(p) if not p or p=='' then return nil end p=tostring(p) local lp=p:lower() if lp=='game' then return game end if lp=='workspace' or lp=='space' then return workspace end if lp=='camera' or lp=='cam' then return workspace.CurrentCamera end if lp=='player' or lp=='me' or lp=='char' or lp=='character' then local pl=game:GetService('Players'):GetPlayers()[1] return pl and pl.Character or workspace:FindFirstChildOfClass('Model') end if lp=='hrp' or lp=='root' or lp=='humanoidrootpart' then local pl=game:GetService('Players'):GetPlayers()[1] local c=pl and pl.Character return c and (c:FindFirstChild('HumanoidRootPart') or c.PrimaryPart) or workspace:FindFirstChild('Baseplate') end if lp=='spawn' then return workspace:FindFirstChildOfClass('SpawnLocation') end if lp=='baseplate' or lp=='ground' then return workspace:FindFirstChild('Baseplate') or workspace:FindFirstChildWhichIsA('BasePart') end if p:sub(1,5)=='game.' then p=p:sub(6) end local n=game for _,s in ipairs(string.split(p,'.')) do if s~='' then local nxt=n:FindFirstChild(s) if not nxt then for _,ch in ipairs(n:GetChildren()) do if ch.Name:lower()==s:lower() then nxt=ch break end end end if not nxt and n==game then local ok,svc=pcall(function() return game:GetService(s) end) if ok then nxt=svc end end if not nxt then nxt=workspace:FindFirstChild(s,true) or game:GetService('ReplicatedStorage'):FindFirstChild(s,true) or game:GetService('ServerStorage'):FindFirstChild(s,true) end if not nxt then return nil end n=nxt end end return n end",
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=m}) end",
  ].join("\n");

  function wrap(body) {
    return { code: HEAD + "\n" + (body), lib: HEAD, body: (body) };
  }

  function buildSuite(op, a) {
    a = a || {};
    const path = luaStr(a.path || a.target_path || "");

    if (op === "reflectance_set") {
      const ref = num(a.reflectance, 0);
      return wrap(`local i=resolve(${path}) if not i or not i:IsA("BasePart") then return fail("need a BasePart path") end i.Reflectance=${ref} return ok({path=i:GetFullName(),reflectance=i.Reflectance},"reflectance set")`);
    }
    if (op === "cancollide_set") {
      const col = bool(a.cancollide, true);
      return wrap(`local i=resolve(${path}) if not i then return fail("path not found") end if i:IsA("BasePart") then i.CanCollide=${col} return ok({path=i:GetFullName(),cancollide=i.CanCollide},"cancollide set") elseif i:IsA("Model") then local count=0 for _,p in ipairs(i:GetDescendants()) do if p:IsA("BasePart") then p.CanCollide=${col} count=count+1 end end return ok({path=i:GetFullName(),modified=count},"model cancollide set") else return fail("need BasePart or Model") end`);
    }
    if (op === "align_position_create") {
      const p0 = luaStr(a.part0 || "");
      const p1 = luaStr(a.part1 || "");
      return wrap(`local i0=resolve(${p0}) local i1=resolve(${p1}) if not i0 or not i0:IsA("BasePart") or not i1 or not i1:IsA("BasePart") then return fail("need valid part0 and part1 BaseParts") end local a0=Instance.new("Attachment") a0.Name="AlignAttachment0" a0.Parent=i0 local a1=Instance.new("Attachment") a1.Name="AlignAttachment1" a1.Parent=i1 local ap=Instance.new("AlignPosition") ap.Attachment0=a0 ap.Attachment1=a1 ap.Parent=i0 return ok({path=ap:GetFullName()},"AlignPosition created")`);
    }
    if (op === "align_orientation_create") {
      const p0 = luaStr(a.part0 || "");
      const p1 = luaStr(a.part1 || "");
      return wrap(`local i0=resolve(${p0}) local i1=resolve(${p1}) if not i0 or not i0:IsA("BasePart") or not i1 or not i1:IsA("BasePart") then return fail("need valid part0 and part1 BaseParts") end local a0=Instance.new("Attachment") a0.Name="AlignAttachment0" a0.Parent=i0 local a1=Instance.new("Attachment") a1.Name="AlignAttachment1" a1.Parent=i1 local ao=Instance.new("AlignOrientation") ao.Attachment0=a0 ao.Attachment1=a1 ao.Parent=i0 return ok({path=ao:GetFullName()},"AlignOrientation created")`);
    }
    if (op === "rigid_constraint_create") {
      const p0 = luaStr(a.part0 || "");
      const p1 = luaStr(a.part1 || "");
      return wrap(`local i0=resolve(${p0}) local i1=resolve(${p1}) if not i0 or not i0:IsA("BasePart") or not i1 or not i1:IsA("BasePart") then return fail("need valid part0 and part1 BaseParts") end local a0=Instance.new("Attachment") a0.Name="RigidAttachment0" a0.Parent=i0 local a1=Instance.new("Attachment") a1.Name="RigidAttachment1" a1.Parent=i1 local rc=Instance.new("RigidConstraint") rc.Attachment0=a0 rc.Attachment1=a1 rc.Parent=i0 return ok({path=rc:GetFullName()},"RigidConstraint created")`);
    }
    if (op === "billboard_gui_create") {
      const name = luaStr(a.name || "BillboardGui");
      const sz = num3(a.size, [4, 2, 0]);
      return wrap(`local i=resolve(${path}) if not i then return fail("path not found") end local bg=Instance.new("BillboardGui") bg.Name=${name} bg.Size=UDim2.new(0,${sz[0]*10},0,${sz[1]*10}) bg.AlwaysOnTop=true bg.Parent=i return ok({path=bg:GetFullName()},"BillboardGui created")`);
    }
    if (op === "particle_emitter_create") {
      const name = luaStr(a.name || "ParticleEmitter");
      const rate = num(a.rate, 20);
      const texture = luaStr(a.texture || "rbxassetid://241837157");
      return wrap(`local i=resolve(${path}) if not i then return fail("path not found") end local pe=Instance.new("ParticleEmitter") pe.Name=${name} pe.Rate=${rate} pe.Texture=${texture} pe.Parent=i return ok({path=pe:GetFullName()},"ParticleEmitter created")`);
    }
    if (op === "trail_create") {
      const p0 = luaStr(a.part0 || "");
      const p1 = luaStr(a.part1 || "");
      return wrap(`local i0=resolve(${p0}) local i1=resolve(${p1}) if not i0 or not i0:IsA("BasePart") or not i1 or not i1:IsA("BasePart") then return fail("need valid part0 and part1 BaseParts") end local a0=Instance.new("Attachment") a0.Name="TrailAttachment0" a0.Parent=i0 local a1=Instance.new("Attachment") a1.Name="TrailAttachment1" a1.Parent=i1 local tr=Instance.new("Trail") tr.Attachment0=a0 tr.Attachment1=a1 tr.Parent=i0 return ok({path=tr:GetFullName()},"Trail created")`);
    }
    if (op === "beam_create") {
      const p0 = luaStr(a.part0 || "");
      const p1 = luaStr(a.part1 || "");
      return wrap(`local i0=resolve(${p0}) local i1=resolve(${p1}) if not i0 or not i0:IsA("BasePart") or not i1 or not i1:IsA("BasePart") then return fail("need valid part0 and part1 BaseParts") end local a0=Instance.new("Attachment") a0.Name="BeamAttachment0" a0.Parent=i0 local a1=Instance.new("Attachment") a1.Name="BeamAttachment1" a1.Parent=i1 local bm=Instance.new("Beam") bm.Attachment0=a0 bm.Attachment1=a1 bm.Parent=i0 return ok({path=bm:GetFullName()},"Beam created")`);
    }
    if (op === "surface_light_add") {
      const br = num(a.brightness, 1);
      const rg = num(a.range, 16);
      return wrap(`local i=resolve(${path}) if not i or not i:IsA("BasePart") then return fail("need BasePart path") end local sl=Instance.new("SurfaceLight") sl.Brightness=${br} sl.Range=${rg} sl.Parent=i return ok({path=sl:GetFullName()},"SurfaceLight added")`);
    }
    if (op === "decal_add") {
      const id = luaStr(a.texture || a.decal_id || "");
      const face = luaStr(a.face || "Front");
      return wrap(`local i=resolve(${path}) if not i or not i:IsA("BasePart") then return fail("need BasePart path") end local d=Instance.new("Decal") d.Texture=${id} pcall(function() d.Face=Enum.NormalId[${face}] or Enum.NormalId.Front end) d.Parent=i return ok({path=d:GetFullName()},"Decal added")`);
    }
    if (op === "texture_add") {
      const id = luaStr(a.texture || "");
      const face = luaStr(a.face || "Front");
      const studsU = num(a.studs_per_tile_u, 10);
      const studsV = num(a.studs_per_tile_v, 10);
      return wrap(`local i=resolve(${path}) if not i or not i:IsA("BasePart") then return fail("need BasePart path") end local t=Instance.new("Texture") t.Texture=${id} t.StudsPerTileU=${studsU} t.StudsPerTileV=${studsV} pcall(function() t.Face=Enum.NormalId[${face}] or Enum.NormalId.Front end) t.Parent=i return ok({path=t:GetFullName()},"Texture added")`);
    }
    if (op === "sound_stop") {
      return wrap(`local i=resolve(${path}) if not i or not i:IsA("Sound") then return fail("need Sound path") end i:Stop() return ok({path=i:GetFullName()},"sound stopped")`);
    }
    if (op === "dialog_create") {
      const prompt = luaStr(a.prompt || "Hello!");
      return wrap(`local i=resolve(${path}) if not i or not i:IsA("BasePart") then return fail("need BasePart path") end local d=Instance.new("Dialog") d.InitialPrompt=${prompt} d.Parent=i return ok({path=d:GetFullName()},"Dialog created")`);
    }
    if (op === "proximity_prompt_create") {
      const text = luaStr(a.text || a.action_text || "Interact");
      const objectText = luaStr(a.object_text || "");
      return wrap(`local i=resolve(${path}) if not i then return fail("path not found") end local pp=Instance.new("ProximityPrompt") pp.ActionText=${text} pp.ObjectText=${objectText} pp.Parent=i return ok({path=pp:GetFullName()},"ProximityPrompt created")`);
    }
    if (op === "click_detector_create") {
      const dist = num(a.max_distance, 32);
      return wrap(`local i=resolve(${path}) if not i or not i:IsA("BasePart") then return fail("need BasePart path") end local cd=Instance.new("ClickDetector") cd.MaxActivationDistance=${dist} cd.Parent=i return ok({path=cd:GetFullName()},"ClickDetector created")`);
    }
    if (op === "camera_type_set") {
      const type = luaStr(a.camera_type || "Custom");
      return wrap(`local cam=workspace.CurrentCamera if not cam then return fail("CurrentCamera not found") end pcall(function() cam.CameraType=Enum.CameraType[${type}] or Enum.CameraType.Custom end) return ok({type=tostring(cam.CameraType)},"camera type set")`);
    }
    if (op === "camera_field_of_view_set") {
      const fov = num(a.fov || a.field_of_view, 70);
      return wrap(`local cam=workspace.CurrentCamera if not cam then return fail("CurrentCamera not found") end cam.FieldOfView=${fov} return ok({fov=cam.FieldOfView},"camera FOV set")`);
    }
    if (op === "team_create") {
      const name = luaStr(a.name || "Team");
      const c = num3(a.color, [255, 0, 0]);
      return wrap(`local ts=game:GetService("Teams") local t=Instance.new("Team") t.Name=${name} t.TeamColor=BrickColor.new(Color3.fromRGB(${c[0]},${c[1]},${c[2]})) t.Parent=ts return ok({path=t:GetFullName()},"Team created")`);
    }
    if (op === "spawn_location_create") {
      const pos = num3(a.position, [0, 0.5, 0]);
      const name = luaStr(a.name || "SpawnLocation");
      return wrap(`local sp=Instance.new("SpawnLocation") sp.Name=${name} sp.Size=Vector3.new(6,1,6) sp.Position=Vector3.new(${pos[0]},${pos[1]},${pos[2]}) sp.Anchored=true sp.Parent=workspace return ok({path=sp:GetFullName()},"SpawnLocation created")`);
    }
    if (op === "character_teleport") {
      const pos = num3(a.position, [0, 5, 0]);
      return wrap(`local pl=game:GetService("Players"):GetPlayers()[1] if not pl or not pl.Character then return fail("no live player character found") end pl.Character:PivotTo(CFrame.new(${pos[0]},${pos[1]},${pos[2]})) return ok({position={${pos[0]},${pos[1]},${pos[2]}}},"character teleported")`);
    }
    if (op === "humanoid_health_set") {
      const hp = num(a.health, 100);
      return wrap(`local pl=game:GetService("Players"):GetPlayers()[1] local char=pl and pl.Character or workspace:FindFirstChildOfClass("Model") local hum=char and char:FindFirstChildOfClass("Humanoid") if not hum then return fail("Humanoid not found") end hum.Health=${hp} return ok({health=hum.Health},"humanoid health set")`);
    }
    if (op === "humanoid_max_health_set") {
      const maxHp = num(a.max_health, 100);
      return wrap(`local pl=game:GetService("Players"):GetPlayers()[1] local char=pl and pl.Character or workspace:FindFirstChildOfClass("Model") local hum=char and char:FindFirstChildOfClass("Humanoid") if not hum then return fail("Humanoid not found") end hum.MaxHealth=${maxHp} return ok({maxHealth=hum.MaxHealth},"humanoid max health set")`);
    }
    if (op === "starter_gui_screen_create") {
      const name = luaStr(a.name || "ScreenGui");
      return wrap(`local sg=game:GetService("StarterGui") local gui=Instance.new("ScreenGui") gui.Name=${name} gui.ResetOnSpawn=false gui.Parent=sg return ok({path=gui:GetFullName()},"StarterGui ScreenGui created")`);
    }
    if (op === "text_label_create") {
      const name = luaStr(a.name || "TextLabel");
      const txt = luaStr(a.text || "Label");
      return wrap(`local i=resolve(${path}) if not i then return fail("parent path not found") end local tl=Instance.new("TextLabel") tl.Name=${name} tl.Text=${txt} tl.Size=UDim2.new(0,200,0,50) tl.Parent=i return ok({path=tl:GetFullName()},"TextLabel created")`);
    }
    if (op === "text_button_create") {
      const name = luaStr(a.name || "TextButton");
      const txt = luaStr(a.text || "Button");
      return wrap(`local i=resolve(${path}) if not i then return fail("parent path not found") end local tb=Instance.new("TextButton") tb.Name=${name} tb.Text=${txt} tb.Size=UDim2.new(0,200,0,50) tb.Parent=i return ok({path=tb:GetFullName()},"TextButton created")`);
    }
    if (op === "image_label_create") {
      const name = luaStr(a.name || "ImageLabel");
      const img = luaStr(a.image || "");
      return wrap(`local i=resolve(${path}) if not i then return fail("parent path not found") end local il=Instance.new("ImageLabel") il.Name=${name} il.Image=${img} il.Size=UDim2.new(0,100,0,100) il.Parent=i return ok({path=il:GetFullName()},"ImageLabel created")`);
    }
    if (op === "frame_create") {
      const name = luaStr(a.name || "Frame");
      return wrap(`local i=resolve(${path}) if not i then return fail("parent path not found") end local f=Instance.new("Frame") f.Name=${name} f.Size=UDim2.new(0,200,0,200) f.Parent=i return ok({path=f:GetFullName()},"Frame created")`);
    }
    if (op === "ui_corner_create") {
      const rad = num(a.radius, 8);
      return wrap(`local i=resolve(${path}) if not i then return fail("parent GuiObject path not found") end local uc=Instance.new("UICorner") uc.CornerRadius=UDim.new(0,${rad}) uc.Parent=i return ok({path=uc:GetFullName()},"UICorner created")`);
    }
    if (op === "ui_stroke_create") {
      const thickness = num(a.thickness, 2);
      const c = num3(a.color, [0, 0, 0]);
      return wrap(`local i=resolve(${path}) if not i then return fail("parent GuiObject path not found") end local us=Instance.new("UIStroke") us.Thickness=${thickness} us.Color=Color3.fromRGB(${c[0]},${c[1]},${c[2]}) us.Parent=i return ok({path=us:GetFullName()},"UIStroke created")`);
    }
    if (op === "ui_gradient_create") {
      return wrap(`local i=resolve(${path}) if not i then return fail("parent GuiObject path not found") end local ug=Instance.new("UIGradient") ug.Parent=i return ok({path=ug:GetFullName()},"UIGradient created")`);
    }
    if (op === "ui_list_layout_create") {
      const dir = luaStr(a.direction || "Vertical");
      return wrap(`local i=resolve(${path}) if not i then return fail("parent GuiObject path not found") end local ull=Instance.new("UIListLayout") pcall(function() ull.FillDirection=Enum.FillDirection[${dir}] or Enum.FillDirection.Vertical end) ull.Parent=i return ok({path=ull:GetFullName()},"UIListLayout created")`);
    }
    if (op === "ui_grid_layout_create") {
      const w = num(a.cell_width, 100);
      const h = num(a.cell_height, 100);
      return wrap(`local i=resolve(${path}) if not i then return fail("parent GuiObject path not found") end local ugl=Instance.new("UIGridLayout") ugl.CellSize=UDim2.new(0,${w},0,${h}) ugl.Parent=i return ok({path=ugl:GetFullName()},"UIGridLayout created")`);
    }

    return null;
  }

  const EXTRA_40_TOOLS = [
    { name: "reflectance_set", description: "Set BasePart Reflectance (0 to 1).", params: { path: { type: "string", req: true }, reflectance: { type: "number", req: true } } },
    { name: "cancollide_set", description: "Set BasePart or Model CanCollide state.", params: { path: { type: "string", req: true }, cancollide: { type: "boolean", req: true } } },
    { name: "align_position_create", description: "Create an AlignPosition constraint and Attachments between two parts.", params: { part0: { type: "string", req: true }, part1: { type: "string", req: true } } },
    { name: "align_orientation_create", description: "Create an AlignOrientation constraint and Attachments between two parts.", params: { part0: { type: "string", req: true }, part1: { type: "string", req: true } } },
    { name: "rigid_constraint_create", description: "Create a RigidConstraint and Attachments between two parts.", params: { part0: { type: "string", req: true }, part1: { type: "string", req: true } } },
    { name: "billboard_gui_create", description: "Create a 3D BillboardGui attached to an instance.", params: { path: { type: "string", req: true }, name: { type: "string", req: false }, size: { type: "array", req: false } } },
    { name: "particle_emitter_create", description: "Create a ParticleEmitter with custom rate and texture.", params: { path: { type: "string", req: true }, name: { type: "string", req: false }, rate: { type: "number", req: false }, texture: { type: "string", req: false } } },
    { name: "trail_create", description: "Create a Trail effect between two parts.", params: { part0: { type: "string", req: true }, part1: { type: "string", req: true } } },
    { name: "beam_create", description: "Create a visual Beam between two parts.", params: { part0: { type: "string", req: true }, part1: { type: "string", req: true } } },
    { name: "surface_light_add", description: "Add a SurfaceLight to a BasePart.", params: { path: { type: "string", req: true }, brightness: { type: "number", req: false }, range: { type: "number", req: false } } },
    { name: "decal_add", description: "Add a Decal texture onto a BasePart face.", params: { path: { type: "string", req: true }, texture: { type: "string", req: true }, face: { type: "string", req: false } } },
    { name: "texture_add", description: "Add a repeating Texture onto a BasePart face.", params: { path: { type: "string", req: true }, texture: { type: "string", req: true }, face: { type: "string", req: false }, studs_per_tile_u: { type: "number", req: false }, studs_per_tile_v: { type: "number", req: false } } },
    { name: "sound_stop", description: "Stop a playing Sound instance.", params: { path: { type: "string", req: true } } },
    { name: "dialog_create", description: "Create an NPC conversation Dialog on a BasePart.", params: { path: { type: "string", req: true }, prompt: { type: "string", req: false } } },
    { name: "proximity_prompt_create", description: "Create a ProximityPrompt on an instance for interaction.", params: { path: { type: "string", req: true }, text: { type: "string", req: false }, object_text: { type: "string", req: false } } },
    { name: "click_detector_create", description: "Create a ClickDetector on a BasePart.", params: { path: { type: "string", req: true }, max_distance: { type: "number", req: false } } },
    { name: "camera_type_set", description: "Set workspace.CurrentCamera CameraType (Custom, Scriptable, Fixed, Attach, Follow).", params: { camera_type: { type: "string", req: true } } },
    { name: "camera_field_of_view_set", description: "Set workspace.CurrentCamera FieldOfView (degrees).", params: { fov: { type: "number", req: true } } },
    { name: "team_create", description: "Create a Team in Teams service.", params: { name: { type: "string", req: true }, color: { type: "array", req: false } } },
    { name: "spawn_location_create", description: "Create a SpawnLocation part.", params: { name: { type: "string", req: false }, position: { type: "array", req: false } } },
    { name: "character_teleport", description: "Teleport the player character to a world position.", params: { position: { type: "array", req: true } } },
    { name: "humanoid_health_set", description: "Set current Humanoid Health.", params: { health: { type: "number", req: true } } },
    { name: "humanoid_max_health_set", description: "Set Humanoid MaxHealth.", params: { max_health: { type: "number", req: true } } },
    { name: "starter_gui_screen_create", description: "Create a ScreenGui inside StarterGui.", params: { name: { type: "string", req: false } } },
    { name: "text_label_create", description: "Create a TextLabel UI element.", params: { path: { type: "string", req: true }, text: { type: "string", req: false }, name: { type: "string", req: false } } },
    { name: "text_button_create", description: "Create a TextButton UI element.", params: { path: { type: "string", req: true }, text: { type: "string", req: false }, name: { type: "string", req: false } } },
    { name: "image_label_create", description: "Create an ImageLabel UI element.", params: { path: { type: "string", req: true }, image: { type: "string", req: false }, name: { type: "string", req: false } } },
    { name: "frame_create", description: "Create a Frame UI element.", params: { path: { type: "string", req: true }, name: { type: "string", req: false } } },
    { name: "ui_corner_create", description: "Add rounded corners to a UI frame or button using UICorner.", params: { path: { type: "string", req: true }, radius: { type: "number", req: false } } },
    { name: "ui_stroke_create", description: "Add an outline stroke to a UI element using UIStroke.", params: { path: { type: "string", req: true }, thickness: { type: "number", req: false }, color: { type: "array", req: false } } },
    { name: "ui_gradient_create", description: "Add a UIGradient color transition to a UI element.", params: { path: { type: "string", req: true } } },
    { name: "ui_list_layout_create", description: "Add a UIListLayout to automatically arrange child UI elements.", params: { path: { type: "string", req: true }, direction: { type: "string", req: false } } },
    { name: "ui_grid_layout_create", description: "Add a UIGridLayout to automatically arrange child UI elements in a grid.", params: { path: { type: "string", req: true }, cell_width: { type: "number", req: false }, cell_height: { type: "number", req: false } } },
  ];

  const origBuildLuau = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = buildSuite(op, args);
    if (extra) return extra;
    return origBuildLuau(op, args);
  };

  for (const c of EXTRA_40_TOOLS) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
})();
