// 200 extra Roblox Studio commands for ORscript (x200 catalogue).
// Patches RobloxScriptSkills after studio_skills.js loads (same pattern as studio_daily.js).
// Convention: JS source uses double-quoted strings; every Luau string literal uses
// single quotes, so the two never fight. Values are interpolated with q/nn/bb/vv/cc.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ") + '"';
  const nn = (v, d = 0) => { const x = Number(v); return isFinite(x) ? String(x) : String(d); };
  const bb = (v, d = false) => (v === undefined || v === null ? (d ? "true" : "false") : v ? "true" : "false");
    const parseColor = (v, d = [163, 162, 165]) => {
    if (Array.isArray(v) && v.length >= 3) return [isFinite(Number(v[0]))?Number(v[0]):d[0], isFinite(Number(v[1]))?Number(v[1]):d[1], isFinite(Number(v[2]))?Number(v[2]):d[2]];
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      const named = { red:[255,50,50], green:[50,255,100], blue:[50,150,255], gold:[255,200,50], yellow:[255,230,60], purple:[180,80,255], cyan:[50,230,255], pink:[255,120,200], orange:[255,130,40], white:[255,255,255], black:[20,20,20], grey:[150,150,150], neon:[0,255,180] };
      if (named[s]) return named[s];
      if (s.startsWith("#") && s.length === 7) {
        const r = parseInt(s.slice(1,3), 16), g = parseInt(s.slice(3,5), 16), b = parseInt(s.slice(5,7), 16);
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
      }
    }
    return d;
  };
  const cc = (a, d) => { const c = parseColor(a, d); return "Color3.fromRGB(" + c[0] + "," + c[1] + "," + c[2] + ")"; };

  const vv = (a, d) => {
    if (typeof a === "string" && a.trim().includes(",")) {
      const parts = a.split(",").map(x => Number(x.trim()));
      if (parts.length >= 3 && parts.every(isFinite)) a = parts;
    }
    a = Array.isArray(a) ? a : d || [0, 0, 0];
    return "Vector3.new(" + nn(a[0]) + "," + nn(a[1]) + "," + nn(a[2]) + ")";
  };
  const strArr = (a, d) => "{" + (Array.isArray(a) && a.length ? a : d || []).map(q).join(",") + "}";
  // Lua table of resolved Instances from a list of paths (for RaycastParams etc.).
  const instArr = (a, d) => "(function() local t={} for _,p in ipairs(" + strArr(a, d) + ") do local i=resolve(p) if i then t[#t+1]=i end end return t end)()";
  const cls = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "") || "";

  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local Workspace=workspace",
    "local Players=game:GetService('Players')",
    "local ReplicatedStorage=game:GetService('ReplicatedStorage')",
    "local ServerScriptService=game:GetService('ServerScriptService')",
    "local ServerStorage=game:GetService('ServerStorage')",
    "local StarterGui=game:GetService('StarterGui')",
    "local StarterPack=game:GetService('StarterPack')",
    "local StarterPlayer=game:GetService('StarterPlayer')",
    "local Lighting=game:GetService('Lighting')",
    "local Teams=game:GetService('Teams')",
    "local Debris=game:GetService('Debris')",
    "local TweenService=game:GetService('TweenService')",
    "local CollectionService=game:GetService('CollectionService')",
    "local PathfindingService=game:GetService('PathfindingService')",
    "local NavigationService=game:GetService('NavigationService')",
    "local DataStoreService=game:GetService('DataStoreService')",
    "local OrderedDataStoreService=game:GetService('OrderedDataStoreService')",
    "local SessionLockStoreService=game:GetService('SessionLockStoreService')",
    "local MarketplaceService=game:GetService('MarketplaceService')",
    "local UserInputService=game:GetService('UserInputService')",
    "local ContextActionService=game:GetService('ContextActionService')",
    "local RunService=game:GetService('RunService')",
    "local MaterialService=game:GetService('MaterialService')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local function resolve(p) if not p or p=='' then return nil end p=tostring(p) local lp=p:lower() if lp=='game' then return game end if lp=='workspace' or lp=='space' then return workspace end if lp=='camera' or lp=='cam' then return workspace.CurrentCamera end if lp=='player' or lp=='me' or lp=='char' or lp=='character' then local pl=Players:GetPlayers()[1] return pl and pl.Character or workspace:FindFirstChildOfClass('Model') end if lp=='hrp' or lp=='root' or lp=='humanoidrootpart' then local pl=Players:GetPlayers()[1] local c=pl and pl.Character return c and (c:FindFirstChild('HumanoidRootPart') or c.PrimaryPart) or workspace:FindFirstChild('Baseplate') end if lp=='spawn' then return workspace:FindFirstChildOfClass('SpawnLocation') end if lp=='baseplate' or lp=='ground' then return workspace:FindFirstChild('Baseplate') or workspace:FindFirstChildWhichIsA('BasePart') end if p:sub(1,5)=='game.' then p=p:sub(6) end local node=game for _,s in ipairs(string.split(p,'.')) do if s~='' then local nxt=node:FindFirstChild(s) if not nxt then for _,ch in ipairs(node:GetChildren()) do if ch.Name:lower()==s:lower() then nxt=ch break end end end if not nxt and node==game then local okc,svc=pcall(function() return game:GetService(s) end) if okc then nxt=svc end end if not nxt then nxt=workspace:FindFirstChild(s,true) or ReplicatedStorage:FindFirstChild(s,true) or ServerStorage:FindFirstChild(s,true) end if not nxt then return nil end node=nxt end end return node end",
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=m}) end",
    "local function firstPlayer() local ps=Players:GetPlayers() return ps[1] or nil end",
    "local function playerByName(name) for _,pl in ipairs(Players:GetPlayers()) do if pl.Name==name or pl.DisplayName==name then return pl end end return nil end",
    "local function findPlayer(p) if not p or p=='' then return firstPlayer() end if type(p)=='number' or (type(p)=='string' and p:match('^%d+$')) then return Players:GetPlayerByUserId(tonumber(p)) end return playerByName(p) or firstPlayer() end",
    "local function charOf(pl) if not pl then return nil end return pl.Character or nil end",
    "local function humOf(pl) local c=charOf(pl) if not c then return nil end return c:FindFirstChildOfClass('Humanoid') end",
    "local function hrpOf(pl) local c=charOf(pl) if not c then return nil end return c:FindFirstChild('HumanoidRootPart') or c:FindFirstChild('Head') end",
    "local function partOf(i) if not i then return nil end if type(i)=='string' then i=resolve(i) end if not i then return nil end if i:IsA('BasePart') then return i end if i:IsA('Model') or i:IsA('Folder') or i:IsA('Tool') or i:IsA('Accessory') then return i.PrimaryPart or i:FindFirstChildOfClass('BasePart') or i:FindFirstChild('Handle') or i:FindFirstChild('HumanoidRootPart') end return nil end",
    "local function centerOf(i) if not i then return Vector3.new() end if i:IsA('BasePart') then return i.Position end local okc,pos=pcall(function() return i:Pivot().Position end) if okc then return pos end return Vector3.new() end",
    "local function allParts(root) local out={} for _,d in ipairs(root:GetDescendants()) do if d:IsA('BasePart') then out[#out+1]=d end end return out end",
    "local function paths(insts,cap) local out={} for _,i in ipairs(insts) do if #out>=(cap or 40) then break end out[#out+1]=i:GetFullName() end return out end",
    "local function mkScript(kind,name,parent,src) local s=Instance.new(kind) s.Name=name s.Source=src or '' s.Parent=parent return s end",
  ].join("\n");

  const B = {};

  // ── A. Instances & query (28) ─────────────────────────────────────────
  B.instance_new = function (a) {
    return "local parent=resolve(" + q(a.parent || "Workspace") + ") or workspace\n" +
      "local inst=Instance.new('" + (cls(a.class) || "Part") + "')\n" +
      "inst.Name='" + (a.name || (cls(a.class) || "Part")) + "'\n" +
      "inst.Parent=parent\n" +
      "return ok({path=inst:GetFullName(),class=inst.ClassName},'created '..inst:GetFullName())";
  };
  B.instance_descendants = function (a) {
    return "local root=resolve(" + q(a.path || "Workspace") + ") if not root then return fail('path not found') end\n" +
      "local out={} for _,d in ipairs(root:GetDescendants()) do if #out>=" + nn(a.limit, 40) + " then break end out[#out+1]=d:GetFullName()..' ['..d.ClassName..']' end\n" +
      "return ok({count=#out,items=out},'listed '..#out..' descendants')";
  };
  B.instance_find = function (a) {
    return "local root=resolve(" + q(a.path || "Workspace") + ") if not root then return fail('path not found') end\n" +
      "local found=root:FindFirstChild(" + q(a.name || "") + ",true)\n" +
      "if not found then return fail('no instance named ' .. " + q(a.name || "") + " .. ' under ' .. " + q(a.path || "Workspace") + ") end\n" +
      "return ok({path=found:GetFullName(),class=found.ClassName},'found '..found:GetFullName())";
  };
  B.instance_find_class = function (a) {
    return "local root=resolve(" + q(a.path || "Workspace") + ") if not root then return fail('path not found') end\n" +
      "local out={} for _,d in ipairs(root:GetDescendants()) do if d.ClassName=='" + (cls(a.class) || "Part") + "' then out[#out+1]=d:GetFullName() if #out>=" + nn(a.limit, 40) + " then break end end end\n" +
      "if #out==0 then return fail('no ' .. '" + (cls(a.class) || "Part") + "' .. ' under ' .. " + q(a.path || "Workspace") + ") end\n" +
      "return ok({count=#out,items=out},'found '..tostring(#out)..' " + (cls(a.class) || "Part") + " instances')";
  };
  B.instance_count = function (a) {
    return "local c_filter='" + (cls(a.class) || "") + "'\n" +
      "local root=resolve(" + q(a.path || "Workspace") + ") if not root then return fail('path not found') end\n" +
      "local total=0 local byClass={} for _,d in ipairs(root:GetDescendants()) do total+=1 if c_filter~='' then if d.ClassName==c_filter then byClass[d.ClassName]=(byClass[d.ClassName] or 0)+1 end else byClass[d.ClassName]=(byClass[d.ClassName] or 0)+1 end end\n" +
      "return ok({total=total,byClass=byClass},'holds '..total..' descendants')";
  };
  B.instance_ancestors = function (a) {
    return "local root=resolve(" + q(a.path || "Workspace") + ") if not root then return fail('path not found') end\n" +
      "local chain={} local n=root while n do chain[#chain+1]=n:GetFullName() n=n.Parent end\n" +
      "return ok({ancestors=chain},'ancestor chain')";
  };
  B.instance_is_ancestor = function (a) {
    return "local a1=resolve(" + q(a.a || "") + ") local a2=resolve(" + q(a.b || "") + ")\n" +
      "if not a1 then return fail('a not found') end if not a2 then return fail('b not found') end\n" +
      "local is=a1:IsAncestorOf(a2)\n" +
      "return ok({ancestor=is},if is then 'a is an ancestor of b' else 'a is NOT an ancestor of b')";
  };
  B.property_copy = function (a) {
    return "local from=resolve(" + q(a["from"] || "") + ") local to=resolve(" + q(a.to || "") + ")\n" +
      "if not from then return fail('from not found') end if not to then return fail('to not found') end\n" +
      "local names=" + strArr(a.names, []) + "\n" +
      "if #names==0 then return fail('pass names: list of property names to copy') end\n" +
      "local copied=0 for _,p in ipairs(names) do local okv=pcall(function() to[p]=from[p] end) if okv then copied+=1 end end\n" +
      "return ok({copied=copied},'copied '..copied..' properties')";
  };
  B.instance_look_at = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "local t=resolve(" + q(a.target || "") + ") if not t then return fail('target not found') end\n" +
      "local tp=centerOf(t) local dir=tp-p.Position if dir.Magnitude<0.01 then return fail('same position') end\n" +
      "p.CFrame=CFrame.lookAt(p.Position,tp)\n" +
      "return ok({cframe=tostring(p.CFrame)},'oriented '..p:GetFullName()..' at target')";
  };
  B.instance_bounding_box = function (a) {
    return "local i=resolve(" + q(a.path || "") + ") if not i then return fail('path not found') end\n" +
      "local okc,box=pcall(function() return i:GetBoundingBox() end)\n" +
      "if not okc then return fail('no bounding box') end\n" +
      "return ok({min={box.Min.x,box.Min.y,box.Min.z},max={box.Max.x,box.Max.y,box.Max.z},size={box.Max.x-box.Min.x,box.Max.y-box.Min.y,box.Max.z-box.Min.z}},'bounding box')";
  };
  B.instance_surface_area = function (a) {
    return "local i=resolve(" + q(a.path || "") + ") if not i then return fail('path not found') end\n" +
      "local area=0 for _,p in ipairs(allParts(i)) do area+=p.SurfaceArea end\n" +
      "return ok({surfaceArea=math.floor(area*10)/10},'total surface area')";
  };
  B.instance_mass_get = function (a) {
    return "local i=resolve(" + q(a.path || "") + ") if not i then return fail('path not found') end\n" +
      "local mass=0 for _,p in ipairs(allParts(i)) do mass+=p.Mass end\n" +
      "return ok({mass=math.floor(mass*10)/10},'total mass')";
  };
  B.distance_measure = function (a) {
    return "local a1=resolve(" + q(a.a || "") + ") local a2=resolve(" + q(a.b || "") + ")\n" +
      "local p1=centerOf(a1 or resolve('Workspace')) local p2=centerOf(a2 or resolve('Workspace'))\n" +
      "local d=(p1-p2).Magnitude\n" +
      "return ok({distance=math.floor(d*10)/10,from={p1.x,p1.y,p1.z},to={p2.x,p2.y,p2.z}},'distance')";
  };
  B.part_at = function (a) {
    return "local pos=" + vv(a.position || a.point) + "\n" +
      "local best=nil local bestD=math.huge\n" +
      "for _,p in ipairs(Workspace:GetDescendants()) do if p:IsA('BasePart') then local d=(p.Position-pos).Magnitude if d<bestD then bestD=d best=p end end end\n" +
      "if not best or bestD>3 then return fail('no part within 3 studs of '..tostring(pos)) end\n" +
      "return ok({path=best:GetFullName(),distance=math.floor(bestD*10)/10},'nearest part to point')";
  };
  B.part_above = function (a) {
    return "local pos=" + vv(a.position || a.point) + "\n" +
      "local best=nil local bestH=math.huge\n" +
      "for _,p in ipairs(Workspace:GetDescendants()) do if p:IsA('BasePart') and p.CanCollide then local dx=p.Position.x-pos.x local dz=p.Position.z-pos.z if math.abs(dx)<=p.Size.X/2+1 and math.abs(dz)<=p.Size.Z/2+1 and p.Position.y>pos.y then if p.Position.y<bestH then best=p bestH=p.Position.y end end end end\n" +
      "if not best then return fail('no collidable part above point') end\n" +
      "return ok({path=best:GetFullName(),height=math.floor((bestH-pos.y)*10)/10},'lowest part above point')";
  };
  B.nearest_part = function (a) {
    return "local cls_filter='" + (cls(a.class) || "") + "'\n" +
      "local pos=" + vv(a.position || a.point) + "\n" +
      "local best=nil local bestD=math.huge\n" +
      "for _,p in ipairs(Workspace:GetDescendants()) do if p:IsA('BasePart') and (cls_filter=='' or p.ClassName==cls_filter) then local d=(p.Position-pos).Magnitude if d<bestD then bestD=d best=p end end end\n" +
      "if not best then return fail('no part found') end\n" +
      "return ok({path=best:GetFullName(),distance=math.floor(bestD*10)/10},'nearest part')";
  };
  B.overlap_box = function (a) {
    return "local pos=" + vv(a.position) + " local sz=" + vv(a.size, [10, 10, 10]) + "\n" +
      "local minB=pos-sz/2 local maxB=pos+sz/2\n" +
      "local out={} for _,p in ipairs(Workspace:GetDescendants()) do if p:IsA('BasePart') then local box=p:GetBoundingBox() if box.Min<=maxB and box.Max>=minB then out[#out+1]=p:GetFullName() if #out>=40 then break end end end end\n" +
      "return ok({count=#out,items=out},'parts inside region')";
  };
  B.overlap_sphere = function (a) {
    return "local pos=" + vv(a.position) + " local r=" + nn(a.radius, 10) + "\n" +
      "local out={} for _,p in ipairs(Workspace:GetDescendants()) do if p:IsA('BasePart') then local d=(p.Position-pos).Magnitude if d<=r+math.max(p.Size.X,p.Size.Y,p.Size.Z)/2 then out[#out+1]=p:GetFullName() if #out>=40 then break end end end end\n" +
      "return ok({count=#out,items=out},'parts inside sphere')";
  };
  B.raycast_do = function (a) {
    return "local from=" + vv(a["from"]) + " local to=" + vv(a.to) + "\n" +
      "local params=RaycastParams.new() params.FilterType=Enum.RaycastFilterType.Blacklist params.FilterDescendantsInstances=" + instArr(a.blacklist, []) + "\n" +
      "local hit=Workspace:Raycast(from,to,params)\n" +
      "if not hit then return fail('raycast hit nothing') end\n" +
      "return ok({part=hit.Instance:GetFullName(),position={hit.Position.x,hit.Position.y,hit.Position.z},normal={hit.Normal.x,hit.Normal.y,hit.Normal.z},distance=math.floor(hit.Distance*10)/10},'raycast hit')";
  };
  B.swept_ray = function (a) {
    return "local from=" + vv(a["from"]) + " local to=" + vv(a.to) + " local r=" + nn(a.radius, 2) + "\n" +
      "local params=RaycastParams.new() params.FilterType=Enum.RaycastFilterType.Blacklist params.FilterDescendantsInstances=" + instArr(a.blacklist, []) + "\n" +
      "local hits=Workspace:SweptSphereWithExtensions(from,to,Vector2.new(r,r),params)\n" +
      "local out={} for _,h in ipairs(hits) do out[#out+1]=h.Instance:GetFullName()..' @ '..tostring(math.floor(h.Distance*10)/10) end\n" +
      "if #out==0 then return fail('swept sphere hit nothing') end\n" +
      "return ok({count=#out,items=out},'swept sphere hits')";
  };
  B.grid_clone = function (a) {
    return "local src=resolve(" + q(a.path || "") + ") if not src then return fail('path not found') end\n" +
      "local rows=" + nn(a.rows, 2) + " local cols=" + nn(a.cols, 2) + " local gap=" + nn(a.spacing, 6) + "\n" +
      "local made=0 for i=1,rows do for j=1,cols do local c=src:Clone() local off=Vector3.new((j-1)*gap,0,(i-1)*gap) if c:IsA('BasePart') then c.CFrame=c.CFrame+off else pcall(function() c:PivotTo(c:Pivot()*CFrame.new(off)) end) end c.Parent=src.Parent made+=1 end end\n" +
      "return ok({clones=made},'cloned into grid')";
  };
  B.mirror_model = function (a) {
    var axis = String(a.axis || "z").toLowerCase();
    return "local m=resolve(" + q(a.path || "") + ") if not m then return fail('path not found') end\n" +
      "local pivot=m:Pivot()\n" +
      "local flip=CFrame.fromMatrix(" + (axis === "x" ? "Vector3.new(-1,0,0),Vector3.new(0,1,0),Vector3.new(0,0,1)" : "Vector3.new(1,0,0),Vector3.new(0,1,0),Vector3.new(0,0,-1)") + ")\n" +
      "m:PivotTo(pivot*flip*CFrame.invert(pivot))\n" +
      "return ok({pivot={pivot.Position.x,pivot.Position.y,pivot.Position.z}},'mirrored along " + axis + "')";
  };
  B.rotate_model = function (a) {
    var axis = String(a.axis || "y").toLowerCase();
    var v = axis === "x" ? "Vector3.x" : axis === "z" ? "Vector3.z" : "Vector3.y";
    return "local m=resolve(" + q(a.path || "") + ") if not m then return fail('path not found') end\n" +
      "local pivot=m:Pivot()\n" +
      "m:PivotTo(pivot*CFrame.fromAxisAngle(" + v + ",math.rad(" + nn(a.degrees, 90) + ")))\n" +
      "return ok({degrees=" + nn(a.degrees, 90) + "},'rotated')";
  };
  B.flatten_model = function (a) {
    return "local m=resolve(" + q(a.path || "") + ") if not m then return fail('path not found') end\n" +
      "local parts=allParts(m) if #parts==0 then return fail('no parts') end\n" +
      "local minY=math.huge for _,p in ipairs(parts) do minY=math.min(minY,p.Position.y-p.Size.Y/2) end\n" +
      "for _,p in ipairs(parts) do local dy=minY-(p.Position.y-p.Size.Y/2) p.CFrame=p.CFrame+CFrame.new(0,dy,0) end\n" +
      "return ok({parts=#parts},'flattened to lowest part')";
  };
  B.raise_model = function (a) {
    return "local m=resolve(" + q(a.path || "") + ") if not m then return fail('path not found') end\n" +
      "local parts=allParts(m) if #parts==0 then return fail('no parts') end\n" +
      "local minY=math.huge for _,p in ipairs(parts) do minY=math.min(minY,p.Position.y-p.Size.Y/2) end\n" +
      "local dy=" + nn(a.height, 2) + "-minY\n" +
      "for _,p in ipairs(parts) do p.CFrame=p.CFrame+CFrame.new(0,dy,0) end\n" +
      "return ok({raisedBy=math.floor(dy*10)/10},'raised')";
  };
  B.workspace_stats = function (a) {
    return "local parts=0 local models=0 local scripts=0 local total=0\n" +
      "for _,d in ipairs(Workspace:GetDescendants()) do total+=1 if d:IsA('BasePart') then parts+=1 elseif d:IsA('Model') then models+=1 elseif d:IsA('LuaSourceContainer') then scripts+=1 end end\n" +
      "return ok({parts=parts,models=models,scripts=scripts,total=total},'workspace stats')";
  };
  B.tree_outline = function (a) {
    return "local root=resolve(" + q(a.path || "Workspace") + ") if not root then return fail('path not found') end\n" +
      "local lines={} local cap=60\n" +
      "local function walk(n,depth) for _,c in ipairs(n:GetChildren()) do if #lines>=cap then return end lines[#lines+1]=string.rep('  ',depth)..c.Name..' ['..c.ClassName..']' if depth<4 then walk(c,depth+1) end end end\n" +
      "walk(root,0)\n" +
      "return ok({lines=lines},'tree outline')";
  };

  // ── B. Physics & constraints (22) ─────────────────────────────────────
  B.physics_impulse = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p:ApplyImpulse(" + vv(a.impulse, [0, 50, 0]) + ")\n" +
      "return ok({impulse=" + vv(a.impulse, [0, 50, 0]) + "},'impulse applied')";
  };
  B.physics_force = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "local secs=" + nn(a.seconds, 1) + " local step=1/60 local t=0\n" +
      "while t<secs do p:ApplyForce(" + vv(a.force, [0, 100, 0]) + "*step) t+=step task.wait(step) end\n" +
      "return ok({seconds=secs},'force applied for '..secs..'s')";
  };
  B.physics_torque = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p:ApplyTorque(" + vv(a.torque, [0, 0, 100]) + ")\n" +
      "return ok({torque=" + vv(a.torque, [0, 0, 100]) + "},'torque applied')";
  };
  B.physics_mass_set = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p.Mass=" + nn(a.mass, 50) + "\n" +
      "return ok({mass=" + nn(a.mass, 50) + "},'mass set')";
  };
  B.physics_density_set = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p.Density=" + nn(a.density, 1000) + "\n" +
      "return ok({density=" + nn(a.density, 1000) + "},'density set')";
  };
  B.physics_friction_set = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p.Friction=" + nn(a.friction, 1) + "\n" +
      "return ok({friction=" + nn(a.friction, 1) + "},'friction set')";
  };
  B.physics_elasticity_set = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p.Elasticity=" + nn(a.elasticity, 0.5) + "\n" +
      "return ok({elasticity=" + nn(a.elasticity, 0.5) + "},'elasticity set')";
  };
  B.physics_velocity_set = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p.Velocity=" + vv(a.velocity, [0, 0, 0]) + "\n" +
      "return ok({velocity=" + vv(a.velocity, [0, 0, 0]) + "},'velocity set')";
  };
  B.physics_linear_set = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "local lvp=Instance.new('LinearVelocity') lvp.RelativeTo=Enum.ActuatorRelativeTo.World lvp.VectorVelocity=" + vv(a.velocity, [0, 0, 0]) + " lvp.MaxForce=1e5 lvp.Parent=p\n" +
      "return ok({path=lvp:GetFullName()},'LinearVelocity attached')";
  };
  B.physics_angular_set = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "local avp=Instance.new('AngularVelocity') avp.RelativeTo=Enum.ActuatorRelativeTo.World avp.AngularVelocity=" + vv(a.velocity, [0, 0, 0]) + " avp.MaxTorque=1e5 avp.Parent=p\n" +
      "return ok({path=avp:GetFullName()},'AngularVelocity attached')";
  };
  B.physics_pivot_set = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p.PivotLocation=" + vv(a.position) + "\n" +
      "return ok({pivot=" + vv(a.position) + "},'pivot set')";
  };
  B.physics_root_set = function (a) {
    return "local m=resolve(" + q(a.path || "") + ") if not m then return fail('path not found') end\n" +
      "local part=partOf(resolve(" + q(a.part || a.root_part || "") + "))\n" +
      "if not part then return fail('root part not found') end\n" +
      "if not m:IsA('Model') then return fail('path is not a Model') end\n" +
      "m.PrimaryPart=part\n" +
      "return ok({primaryPart=part:GetFullName()},'PrimaryPart set')";
  };
  B.physics_anchor_all = function (a) {
    return "local m=resolve(" + q(a.path || "") + ") if not m then return fail('path not found') end\n" +
      "local n=0 for _,p in ipairs(allParts(m)) do p.Anchored=" + bb(a.anchored, true) + " n+=1 end\n" +
      "return ok({parts=n,anchored=" + bb(a.anchored, true) + "},'anchored set')";
  };
  B.physics_lock = function (a) {
    return "local m=resolve(" + q(a.path || "") + ") if not m then return fail('path not found') end\n" +
      "local parts=allParts(m) if #parts==0 then return fail('no parts') end\n" +
      "local root=parts[1] for _,p in ipairs(parts) do p.Anchored=true local w=Instance.new('WeldConstraint') w.Part0=root w.Part1=p w.Parent=root end\n" +
      "return ok({parts=#parts},'locked: anchored + welded')";
  };
  B.constraints_clear = function (a) {
    return "local m=resolve(" + q(a.path || "") + ") if not m then return fail('path not found') end\n" +
      "local n=0 for _,d in ipairs(m:GetDescendants()) do if d:IsA('BaseConstraint') or d:IsA('BasePart') and d:IsA('Weld') then d:Destroy() n+=1 end end\n" +
      "for _,d in ipairs(m:GetDescendants()) do if d:IsA('Motor6D') or d:IsA('Weld') then d:Destroy() n+=1 end end\n" +
      "return ok({removed=n},'constraints cleared')";
  };
  B.constraint_create = function (a) {
    var t = { weld: "WeldConstraint", motor6d: "Motor6D", hinge: "HingeConstraint", pivot: "PivotConstraint", ball: "BallSocketConstraint", prismatic: "PrismaticConstraint" }[String(a.type || "weld").toLowerCase()];
    return "local p0=partOf(resolve(" + q(a.part0 || "") + ")) local p1=partOf(resolve(" + q(a.part1 || "") + "))\n" +
      "if not p0 then return fail('part0 not found') end if not p1 then return fail('part1 not found') end\n" +
      "local c=Instance.new('" + t + "')\n" +
      (t === "Motor6D" || t === "Weld" ? "c.Part0=p0 c.Part1=p1\n" : "c.Part0=p0 c.Part1=p1\n") +
      "c.Parent=p0\n" +
      "return ok({path=c:GetFullName(),type='" + t + "'},'constraint created')";
  };
  B.motor6d_set = function (a) {
    return "local c=resolve(" + q(a.path || "") + ") if not c then return fail('path not found') end\n" +
      "if not c:IsA('Motor6D') and not c:IsA('Weld') then return fail('not a Motor6D/Weld') end\n" +
      "if c:IsA('Motor6D') then if " + bb(a.limits != null, false) + " then c.U0Enabled=" + bb(a.u0) + " c.U1Enabled=" + bb(a.u1) + " c.U2Enabled=" + bb(a.u2) + " end if " + bb(a.motor != null, false) + " then c.MaxMotorForce=" + nn(a.motor_force, 1000) + " c.DesiredVelocity=" + nn(a.motor, 0) + " end end\n" +
      "return ok({path=c:GetFullName()},'motor6d tuned')";
  };
  B.physics_parts_on_ray = function (a) {
    return "local from=" + vv(a["from"]) + " local to=" + vv(a.to) + " local r=" + nn(a.radius, 2) + "\n" +
      "local params=RaycastParams.new() params.FilterType=Enum.RaycastFilterType.Blacklist\n" +
      "local hits=Workspace:SweptSphereWithExtensions(from,to,Vector2.new(r,r),params)\n" +
      "local out={} for _,h in ipairs(hits) do if h:IsA('BasePart') then out[#out+1]=h:GetFullName() end end\n" +
      "return ok({count=#out,items=out},'parts along ray')";
  };
  B.spring_adjust = function (a) {
    return "local c=resolve(" + q(a.path || "") + ") if not c then return fail('path not found') end\n" +
      "if not c:IsA('SpringConstraint') then return fail('not a SpringConstraint') end\n" +
      "c.Rigidness=" + nn(a.rigidness, 100) + " if " + bb(a.length != null, false) + " then c.Length=" + nn(a.length, 1) + " end\n" +
      "return ok({rigidness=" + nn(a.rigidness, 100) + "},'spring adjusted')";
  };
  B.trampoline_set = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p.TrampolineForce=" + nn(a.force, 100) + "\n" +
      "return ok({force=" + nn(a.force, 100) + "},'trampoline force set')";
  };
  B.float_part = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p.Anchored=false\n" +
      "local lvp=Instance.new('LinearVelocity') lvp.RelativeTo=Enum.ActuatorRelativeTo.World lvp.VectorVelocity=Vector3.new(0," + nn(a.height, 2) + ",0) lvp.MaxForce=1e6 lvp.Parent=p\n" +
      "return ok({path=lvp:GetFullName()},'floating '..tostring(" + nn(a.height, 2) + ")..' studs above origin')";
  };
  B.physics_zero = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "p.Velocity=Vector3.new() p.RotVelocity=Vector3.new()\n" +
      "return ok({},'velocities zeroed')";
  };

  // ── C. Players & characters (22) ──────────────────────────────────────
  B.players_list = function (a) {
    return "local ps=Players:GetPlayers() local out={} for _,pl in ipairs(ps) do out[#out+1]={name=pl.Name,userId=pl.UserId,character=pl.Character and pl.Character:GetFullName() or nil} end\n" +
      "return ok({count=#ps,players=out},'players in game')";
  };
  B.player_find = function (a) {
    return "local pl=findPlayer(" + q(a.player || a.name || a.id || "") + ")\n" +
      "if not pl then return fail('player not found') end\n" +
      "return ok({name=pl.Name,userId=pl.UserId,displayname=pl.DisplayName,path=pl:GetFullName()},'player found')";
  };
  B.player_count = function (a) {
    return "return ok({count=#Players:GetPlayers()},'player count')";
  };
  B.player_kill = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local hum=humOf(pl) if not hum then return fail('no humanoid') end\n" +
      "hum.Health=0\n" +
      "return ok({player=pl.Name},'killed')";
  };
  B.player_heal = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local hum=humOf(pl) if not hum then return fail('no humanoid') end\n" +
      "hum.Health=hum.MaxHealth\n" +
      "return ok({health=hum.Health},'fully healed')";
  };
  B.player_damage = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local hum=humOf(pl) if not hum then return fail('no humanoid') end\n" +
      "hum:TakeDamage(" + nn(a.amount, 10) + ")\n" +
      "return ok({health=hum.Health},'dealt '..tostring(" + nn(a.amount, 10) + ")..' damage')";
  };
  B.player_max_health = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local hum=humOf(pl) if not hum then return fail('no humanoid') end\n" +
      "hum.MaxHealth=" + nn(a.health, 100) + " hum.Health=hum.MaxHealth\n" +
      "return ok({maxHealth=hum.MaxHealth},'max health set')";
  };
  B.player_godmode = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local on=" + bb(a.on, true) + "\n" +
      "local tag='ORGodmode_'..tostring(pl.UserId)\n" +
      "if on then pl:SetAttribute(tag,true) local hum=humOf(pl) if hum then hum.Health=hum.MaxHealth end else pl:SetAttribute(tag,false) end\n" +
      "return ok({godmode=on},'godmode ' .. (if on then 'ON' else 'OFF'))";
  };
  B.player_kick = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "pl:Kick(" + q(a.reason || "Kicked by ORscript") + ")\n" +
      "return ok({player=pl.Name},'kicked')";
  };
  B.player_rename = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "pl.DisplayName=" + q(a.displayname || a.name || "") + "\n" +
      "return ok({displayname=pl.DisplayName},'renamed')";
  };
  B.player_teleport = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local hrp=hrpOf(pl) if not hrp then return fail('no character') end\n" +
      "hrp.CFrame=CFrame.new(" + vv(a.position) + ")\n" +
      "return ok({position=" + vv(a.position) + "},'teleported')";
  };
  B.player_climb = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local hum=humOf(pl) if not hum then return fail('no humanoid') end\n" +
      "hum.ClimbSpeed=" + nn(a.speed, 60) + "\n" +
      "return ok({climbSpeed=hum.ClimbSpeed},'climb speed set')";
  };
  B.player_swim = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local hum=humOf(pl) if not hum then return fail('no humanoid') end\n" +
      "hum.SwimSpeed=" + nn(a.speed, 22) + "\n" +
      "return ok({swimSpeed=hum.SwimSpeed},'swim speed set')";
  };
  B.humanoid_list = function (a) {
    return "local out={} for _,d in ipairs(Workspace:GetDescendants()) do if d:IsA('Humanoid') then out[#out+1]=d:GetFullName()..' health='..tostring(d.Health)..' walk='..tostring(d.WalkSpeed) end end\n" +
      "return ok({count=#out,items=out},'humanoids')";
  };
  B.ragdoll_make = function (a) {
    return "local target=resolve(" + q(a.path || "") + ")\n" +
      "local pl=findPlayer(" + q(a.player || a.path || "") + ")\n" +
      "local hum=if target and target:IsA('Humanoid') then target elseif pl then humOf(pl) else nil\n" +
      "if not hum then return fail('humanoid not found') end\n" +
      "local c=hum.Parent local n=0 for _,d in ipairs(c:GetDescendants()) do if d:IsA('Motor6D') then d:Destroy() n+=1 end end\n" +
      "return ok({removed=n},'ragdoll: '..(if n>0 then 'motors removed' else 'already loose'))";
  };
  B.ragdoll_restore = function (a) {
    return "local hum=resolve(" + q(a.path || "") + ") local pl=findPlayer(" + q(a.player || "") + ")\n" +
      "hum=if hum and hum:IsA('Humanoid') then hum elseif pl then humOf(pl) else nil\n" +
      "if not hum then return fail('humanoid not found') end\n" +
      "local okc,err=pcall(function() hum:RestoreRig() end)\n" +
      "return ok({restored=okc},'rig restored')";
  };
  B.tools_list = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local c=charOf(pl) local out={} if c then for _,d in ipairs(c:GetChildren()) do if d:IsA('Tool') then out[#out+1]=d:GetFullName() end end end\n" +
      "return ok({count=#out,items=out},'tools on character')";
  };
  B.tool_equip = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local c=charOf(pl) if not c then return fail('no character') end\n" +
      "local tool=resolve(" + q(a.tool || a.path || "") + ")\n" +
      "if not tool then local t=StarterPack:FindFirstChild(" + q(a.tool || a.name || "") + ",true) if t and t:IsA('Tool') then tool=t end end\n" +
      "if not tool or not tool:IsA('Tool') then return fail('tool not found') end\n" +
      "local given=tool:Clone() given.Parent=c:WaitForChild('HumanoidRootPart')\n" +
      "return ok({tool=given:GetFullName()},'equipped')";
  };
  B.tool_strip = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local c=charOf(pl) if not c then return fail('no character') end\n" +
      "local n=0 for _,d in ipairs(c:GetChildren()) do if d:IsA('Tool') then d:Destroy() n+=1 end end\n" +
      "return ok({removed=n},'tools stripped')";
  };
  B.head_position = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local hrp=hrpOf(pl) if not hrp then return fail('no character') end\n" +
      "return ok({position={hrp.Position.x,hrp.Position.y,hrp.Position.z},cframe=tostring(hrp.CFrame)},'head position')";
  };
  B.player_attr = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "pl:SetAttribute(" + q(a.key || "") + "," + q(a.value || "") + ")\n" +
      "return ok({key=" + q(a.key || "") + "},'player attribute set')";
  };
  B.respawn_player = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local c=charOf(pl) if c then c:Destroy() end\n" +
      "task.wait(1)\n" +
      "return ok({player=pl.Name},'respawned')";
  };

  // ── D. Remotes, chat & economy (16) ───────────────────────────────────
  B.remote_function_create = function (a) {
    return "local parent=resolve(" + q(a.parent || "ReplicatedStorage") + ") or ReplicatedStorage\n" +
      "local rf=Instance.new('RemoteFunction') rf.Name=" + q(a.name || "RemoteFunction") + " rf.Parent=parent\n" +
      "return ok({path=rf:GetFullName()},'RemoteFunction created')";
  };
  B.remote_folder = function (a) {
    return "local parent=resolve(" + q(a.parent || "ReplicatedStorage") + ") or ReplicatedStorage\n" +
      "local folder=parent:FindFirstChild(" + q(a.name || "Remotes") + ") or Instance.new('Folder')\n" +
      "folder.Name=" + q(a.name || "Remotes") + " folder.Parent=parent\n" +
      "local names=" + strArr(a.events, ["Chat", "Buy", "Notify"]) + "\n" +
      "local made=0 for _,n in ipairs(names) do if not folder:FindFirstChild(n) then local e=Instance.new('RemoteEvent') e.Name=n e.Parent=folder made+=1 end end\n" +
      "return ok({path=folder:GetFullName(),created=made},'remote folder ready')";
  };
  B.remotes_list = function (a) {
    return "local out={} for _,d in ipairs(ReplicatedStorage:GetDescendants()) do if d:IsA('RemoteEvent') or d:IsA('RemoteFunction') or d:IsA('BindableEvent') or d:IsA('BindableFunction') then out[#out+1]=d:GetFullName()..' ['..d.ClassName..']' end end\n" +
      "return ok({count=#out,items=out},'remotes in ReplicatedStorage')";
  };
  B.remote_fire = function (a) {
    return "local rem=resolve(" + q(a.name || a.path || "") + ") or ReplicatedStorage:FindFirstChild(" + q(a.name || "") + ",true)\n" +
      "if not rem or not (rem:IsA('RemoteEvent') or rem:IsA('BindableEvent')) then return fail('remote not found') end\n" +
      "local pl=findPlayer(" + q(a.player || "") + ") or firstPlayer()\n" +
      "if rem:IsA('RemoteEvent') then if pl then rem:FireClient(pl," + q(a.payload || "") + ") else rem:FireServer(" + q(a.payload || "") + ") end end\n" +
      "return ok({remote=rem:GetFullName()},'fired')";
  };
  B.remote_handler = function (a) {
    var behavior = String(a.behavior || "echo").toLowerCase();
    var name = String(a.name || "Remote").replace(/[^A-Za-z0-9_]/g, "");
    var inner;
    if (behavior === "count") inner = "local counter=0\nrem.OnServerEvent:Connect(function(pl,arg1) counter+=1 print('[OR] " + name + " fired ' + counter + ' times from ' + pl.Name) end)";
    else if (behavior === "print") inner = "rem.OnServerEvent:Connect(function(pl,arg1) print('[OR] " + name + " from ' .. pl.Name .. ': ' .. tostring(arg1)) end)";
    else inner = "rem.OnServerEvent:Connect(function(pl,arg1) local echo=ReplicatedStorage:FindFirstChild('" + name + "_Echo') if echo then echo:FireClient(pl,'echo: ' + tostring(arg1)) end end)";
    var src = "local ReplicatedStorage=game:GetService('ReplicatedStorage')\nlocal rem=ReplicatedStorage:FindFirstChild('" + name + "',true)\nif not rem then warn('OR handler: remote not found') return end\n" + inner + "\n";
    return "local old=ServerScriptService:FindFirstChild('OR_Handler_" + name + "') if old then old:Destroy() end\n" +
      "local s=mkScript('Script','OR_Handler_" + name + "',ServerScriptService,[==[" + "\n" + src + "\n]==])\n" +
      "return ok({script=s:GetFullName()},'server handler wired (' .. '" + behavior + "' .. ')')";
  };
  B.bindable_event_create = function (a) {
    return "local be=Instance.new('BindableEvent') be.Name=" + q(a.name || "BindableEvent") + " be.Parent=ReplicatedStorage\n" +
      "return ok({path=be:GetFullName()},'BindableEvent created')";
  };
  B.bindable_function_create = function (a) {
    return "local bf=Instance.new('BindableFunction') bf.Name=" + q(a.name || "BindableFunction") + " bf.Parent=ReplicatedStorage\n" +
      "return ok({path=bf:GetFullName()},'BindableFunction created')";
  };
  B.replicated_first = function (a) {
    return "local parent=ServerStorage:FindFirstChild('ReplicatedFirst') or Instance.new('Folder')\n" +
      "parent.Name='ReplicatedFirst' parent.Parent=ServerStorage\n" +
      "local s=mkScript('Script'," + q(a.name || "ReplicatedFirst") + ",parent," + q(a.source || "-- runs before all other server scripts") + ")\n" +
      "return ok({path=s:GetFullName()},'ReplicatedFirst script created')";
  };
  B.network_ping = function (a) {
    return "local out={} for _,pl in ipairs(Players:GetPlayers()) do out[#out+1]={name=pl.Name,ping=pl.Ping} end\n" +
      "table.sort(out,function(x,y) return x.ping<y.ping end)\n" +
      "return ok({players=out},'pings')";
  };
  B.network_owner = function (a) {
    return "local m=resolve(" + q(a.path || "") + ") if not m then return fail('path not found') end\n" +
      "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local parts=allParts(m) for _,p in ipairs(parts) do p:SetNetworkOwner(pl) end\n" +
      "return ok({parts=#parts},'network owner set')";
  };
  B.chat_say = function (a) {
    return "local Chat=game:GetService('Chat') local pl=firstPlayer()\n" +
      "if not pl then return fail('no player in session') end\n" +
      "local okc,err=pcall(function() Chat:Say(pl," + q(a.text || "hello") + ") end)\n" +
      "return ok({said=okc},'said: ' .. '" + String(a.text || "hello") + "')";
  };
  B.chat_announce = function (a) {
    return "local pl=firstPlayer() if not pl then return fail('no player in session') end\n" +
      "local gui=pl:FindFirstChildOfClass('PlayerGui') if not gui then return fail('no PlayerGui') end\n" +
      "local old=gui:FindFirstChild('OR_Announce') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Announce' sg.IgnoreGuiInset=true sg.DisplayOrder=50 sg.Parent=gui\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(0,420,0,56) lbl.Position=UDim2.new(0.5,-210,0,42) lbl.BackgroundTransparency=1 lbl.TextScaled=true lbl.Font=Enum.Font.GothamBold lbl.TextXAlignment=Enum.TextXAlignment.Center lbl.Text=" + q(a.text || "Announcement") + " lbl.TextColor3=Color3.fromRGB(255,255,255) lbl.TextShadowColor=Color3.new() lbl.TextTransparency=0.15 lbl.Parent=sg\n" +
      "local bar=Instance.new('Frame') bar.Size=UDim2.new(1,0,1,0) bar.BackgroundColor3=(" + cc(a.color, [30, 30, 40]) + ") bar.BackgroundTransparency=0.25 bar.BorderSizePixel=0 bar.Parent=lbl\n" +
      "lbl:BringToFront()\n" +
      "task.delay(" + nn(a.seconds, 4) + ",function() sg:Destroy() end)\n" +
      "return ok({seconds=" + nn(a.seconds, 4) + "},'announcement shown')";
  };
  B.leaderstats_add = function (a) {
    return "local name=" + q(a.stat || "Score") + "\n" +
      "local n=0 for _,pl in ipairs(Players:GetPlayers()) do local ls=pl:FindFirstChild('leaderstats') if ls then if not ls:FindFirstChild(name) then local v=Instance.new('IntValue') v.Name=name v.Value=" + nn(a["default"], 0) + " v.Parent=ls end n+=1 end end\n" +
      "return ok({players=n},'leaderstat ' .. '" + (a.stat || "Score") + "' .. ' ready')";
  };
  B.leaderstats_set = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local ls=pl:FindFirstChild('leaderstats') if not ls then return fail('no leaderstats folder') end\n" +
      "local stat=ls:FindFirstChild(" + q(a.stat || "Score") + ") if not stat then return fail('no stat named ' + '" + (a.stat || "Score") + "') end\n" +
      "stat.Value=" + nn(a.value, 0) + "\n" +
      "return ok({value=stat.Value},'leaderstat set')";
  };
  B.premium_check = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local okc,isPremium=pcall(function() return MarketplaceService:UserHasLicenseForGame(pl.UserId,game.PlaceId,Enum.ProductType.Premium) end)\n" +
      "if not okc then return fail('premium check unavailable: ' + tostring(isPremium)) end\n" +
      "return ok({premium=isPremium},'premium check for ' + pl.Name)";
  };
  B.gamepass_check = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local okc,owns=pcall(function() return MarketplaceService:UserOwnsGamePassAsync(pl.UserId," + nn(a.passid, 0) + ") end)\n" +
      "if not okc then return fail('gamepass check unavailable (place must be published): ' + tostring(owns)) end\n" +
      "return ok({owns=owns},'gamepass ' .. '" + nn(a.passid, 0) + "' .. ' check')";
  };
  B.gamepass_list = function (a) {
    return "local okc,list=pcall(function() return MarketplaceService:GetGamePassesForCurrentUniverse() end)\n" +
      "if not okc then return fail('universe not published: ' + tostring(list)) end\n" +
      "local out={} for _,p in ipairs(list) do out[#out+1]={id=p.Id,name=p.Name} end\n" +
      "return ok({count=#out,passes=out},'game passes for this universe')";
  };

  // ── E. DataStores (15) ────────────────────────────────────────────────
  B.ds_get = function (a) {
    return "local okc,val=pcall(function() return DataStoreService:GetDataStore('" + (a.store || "PlayerData") + "'):GetAsync(" + q(a.key || "") + ") end)\n" +
      "if not okc then return fail('datastore error: ' + tostring(val)) end\n" +
      "return ok({key=" + q(a.key || "") + ",value=val},'datastore get')";
  };
  B.ds_set = function (a) {
    return "local okc,err=pcall(function() DataStoreService:GetDataStore('" + (a.store || "PlayerData") + "'):SetAsync(" + q(a.key || "") + "," + q(a.value || "") + ") end)\n" +
      "if not okc then return fail('datastore error: ' + tostring(err)) end\n" +
      "return ok({key=" + q(a.key || "") + "},'datastore set')";
  };
  B.ds_update = function (a) {
    return "local okc,err=pcall(function() DataStoreService:GetDataStore('" + (a.store || "PlayerData") + "'):UpdateAsync(" + q(a.key || "") + ",function(cur) return (tonumber(cur) or 0) + " + nn(a.delta, 1) + " end) end)\n" +
      "if not okc then return fail('datastore error: ' + tostring(err)) end\n" +
      "return ok({key=" + q(a.key || "") + ",delta=" + nn(a.delta, 1) + "},'datastore updated')";
  };
  B.ds_remove = function (a) {
    return "local okc,err=pcall(function() DataStoreService:GetDataStore('" + (a.store || "PlayerData") + "'):RemoveAsync(" + q(a.key || "") + ") end)\n" +
      "if not okc then return fail('datastore error: ' + tostring(err)) end\n" +
      "return ok({key=" + q(a.key || "") + "},'datastore key removed')";
  };
  B.ds_get_many = function (a) {
    return "local keys=" + strArr(a.keys, []) + "\n" +
      "if #keys==0 then return fail('pass keys: [ ... ]') end\n" +
      "local okc,vals=pcall(function() return DataStoreService:GetDataStore('" + (a.store || "PlayerData") + "'):GetAsync(keys) end)\n" +
      "if not okc then return fail('datastore error: ' + tostring(vals)) end\n" +
      "return ok({values=vals},'datastore get many')";
  };
  B.ds_set_many = function (a) {
    var pairs = (a.pairs || a.values || []).map(function (kv) {
      var k = Array.isArray(kv) ? String(kv[0]) : String(kv);
      var v = Array.isArray(kv) ? String(kv[1]) : String(kv);
      return k + "=" + q(v);
    }).join(",");
    return "local vals={" + (pairs || "") + "}\n" +
      "if next(vals)==nil then return fail('pass pairs: array of key/value pairs') end\n" +
      "local okc,err=pcall(function() DataStoreService:GetDataStore('" + (a.store || "PlayerData") + "'):SetAsync(vals) end)\n" +
      "if not okc then return fail('datastore error: ' + tostring(err)) end\n" +
      "return ok({count=" + (a.pairs || a.values || []).length + "},'datastore set many')";
  };
  B.ds_incr = function (a) {
    return "local okc,newVal=pcall(function() return DataStoreService:GetDataStore('" + (a.store || "PlayerData") + "'):IncrementAsync(" + q(a.key || "") + "," + nn(a.delta, 1) + ") end)\n" +
      "if not okc then return fail('datastore error: ' + tostring(newVal)) end\n" +
      "return ok({key=" + q(a.key || "") + ",value=newVal},'incremented')";
  };
  B.ds_sorted = function (a) {
    return "local okc,page=pcall(function() local it=OrderedDataStoreService:GetOrderedDataStore('" + (a.store || "Leaderboard") + "'):GetSortedAsync(" + bb(a.ascending, false) + "," + nn(a.limit, 10) + ") return it:GetCurrentPage() end)\n" +
      "if not okc then return fail('ordered datastore error: ' + tostring(page)) end\n" +
      "local out={} for k,v in pairs(page) do out[#out+1]={key=k,value=v} end\n" +
      "table.sort(out,function(x,y) return x.value>y.value end)\n" +
      "return ok({entries=out},'sorted top ' + '" + nn(a.limit, 10) + "')";
  };
  B.ds_ping = function (a) {
    return "local okc,val=pcall(function() return DataStoreService:GetDataStore('" + (a.store || "PlayerData") + "'):GetAsync('__or_ping__') end)\n" +
      "if not okc then return fail('datastore UNAVAILABLE: ' + tostring(val) + ' (publish the place / enable Studio access to API services)') end\n" +
      "return ok({available=true},'datastore reachable')";
  };
  B.session_lock_acquire = function (a) {
    return "local okc,lock=pcall(function() return SessionLockStoreService:GetSessionLockStore('" + (a.store || "Locks") + "'):AcquireLock(" + q(a.key || "") + "," + nn(a.ttl, 15) + ") end)\n" +
      "if not okc then return fail('lock busy or error: ' + tostring(lock)) end\n" +
      "return ok({locked=true,key=" + q(a.key || "") + "},'session lock acquired')";
  };
  B.session_lock_release = function (a) {
    return "local okc,err=pcall(function() return SessionLockStoreService:GetSessionLockStore('" + (a.store || "Locks") + "'):ReleaseLock(" + q(a.key || "") + ") end)\n" +
      "if not okc then return fail('release error: ' + tostring(err)) end\n" +
      "return ok({key=" + q(a.key || "") + "},'session lock released')";
  };
  B.ordered_set = function (a) {
    return "local okc,err=pcall(function() OrderedDataStoreService:GetOrderedDataStore('" + (a.store || "Leaderboard") + "'):SetAsync(" + q(a.key || "") + "," + nn(a.score, 0) + ") end)\n" +
      "if not okc then return fail('ordered datastore error: ' + tostring(err)) end\n" +
      "return ok({key=" + q(a.key || "") + ",score=" + nn(a.score, 0) + "},'score saved')";
  };
  B.ordered_get = function (a) {
    return "local okc,score=pcall(function() return OrderedDataStoreService:GetOrderedDataStore('" + (a.store || "Leaderboard") + "'):GetAsync(" + q(a.key || "") + ") end)\n" +
      "if not okc then return fail('ordered datastore error: ' + tostring(score)) end\n" +
      "return ok({key=" + q(a.key || "") + ",score=score},'score loaded')";
  };
  B.profile_setup = function (a) {
    var fields = (a.fields || ["Coins", "Level", "Skin"]).map(String);
    return "local fields={" + fields.map(q).join(",") + "}\n" +
      "local old=ServerScriptService:FindFirstChild('OR_ProfileSystem') if old then old:Destroy() end\n" +
      "local src='local Players=game:GetService(\\'Players\\')\\nlocal DSS=game:GetService(\\'DataStoreService\\')\\nlocal store=DSS:GetDataStore(\\'" + (a.store || "PlayerProfiles") + "\\')\\nlocal FIELDS={" + fields.map(q).join(",") + "}\\nlocal function defaultProfile() local p={} for _,f in ipairs(FIELDS) do p[f]=0 end return p end\\nPlayers.PlayerAdded:Connect(function(pl)\\n local ok,prof=pcall(function() return store:GetAsync(\\'p_\\'..tostring(pl.UserId)) end)\\n if not ok or not type(prof)==\\'table\\' then prof=defaultProfile() end\\n pl:SetAttribute(\\'ProfileLoaded\\',true)\\n for _,f in ipairs(FIELDS) do pl:SetAttribute(\\'P_\\'..f,prof[f] or 0) end\\n local function save() local p={} for _,f in ipairs(FIELDS) do p[f]=pl:GetAttribute(\\'P_\\'..f) or 0 end pcall(function() store:SetAsync(\\'p_\\'..tostring(pl.UserId),p) end) end\\n pl:SetAttribute(\\'ORSave\\',save)\\n task.spawn(function() while task.wait(30) do if pl.Parent then save() end end end)\\n pl.PlayerRemoving:Connect(save)\\nend)\\n'\n" +
      "local s=mkScript('Script','OR_ProfileSystem',ServerScriptService,src)\n" +
      "return ok({script=s:GetFullName(),fields=fields},'profile save/load wired')";
  };
  B.ds_json_put = function (a) {
    return "local okc,err=pcall(function() DataStoreService:GetDataStore('" + (a.store || "PlayerData") + "'):SetAsync(" + q(a.key || "") + "," + q(a.json || "{}") + ") end)\n" +
      "if not okc then return fail('datastore error: ' + tostring(err)) end\n" +
      "return ok({key=" + q(a.key || "") + "},'json string saved')";
  };

  // ── F. UI & screens (21) ──────────────────────────────────────────────
  function guiTarget(a) {
    return "local pl=firstPlayer() if not pl then return fail('no player session (open the place / start play solo)') end\n" +
      "local pgui=pl:WaitForChild('PlayerGui')\n";
  }
  B.toast_show = function (a) {
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Toast') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Toast' sg.IgnoreGuiInset=true sg.DisplayOrder=99 sg.Parent=pgui\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(0,320,0,40) lbl.Position=UDim2.new(0.5,-160,1,-84) lbl.BackgroundColor3=Color3.fromRGB(24,24,28) lbl.BackgroundTransparency=0.15 lbl.BorderSizePixel=0 lbl.Text=" + q(a.text || "Toast") + " lbl.Font=Enum.Font.GothamMedium lbl.TextScaled=true lbl.TextColor3=Color3.fromRGB(255,255,255) lbl.Parent=sg\n" +
      "local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,8) cr.Parent=lbl\n" +
      "task.delay(" + nn(a.seconds, 2.5) + ",function() if sg.Parent then sg:Destroy() end end)\n" +
      "return ok({seconds=" + nn(a.seconds, 2.5) + "},'toast shown')";
  };
  B.dialog_confirm = function (a) {
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Dialog') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Dialog' sg.ResetOnSpawn=false sg.DisplayOrder=120 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local box=Instance.new('Frame') box.Size=UDim2.new(0,340,0,150) box.Position=UDim2.new(0.5,-170,0.5,-75) box.BackgroundColor3=Color3.fromRGB(22,22,26) box.BorderSizePixel=0 box.Parent=sg\n" +
      "local t=Instance.new('TextLabel') t.Size=UDim2.new(1,-24,0,34) t.Position=UDim2.new(0,12,0,10) t.BackgroundTransparency=1 t.Text=" + q(a.title || "Confirm?") + " t.Font=Enum.Font.GothamBold t.TextXAlignment=Enum.TextXAlignment.Left t.TextColor3=Color3.new(1,1,1) t.TextScaled=true t.Parent=box\n" +
      "local d=Instance.new('TextLabel') d.Size=UDim2.new(1,-24,0,44) d.Position=UDim2.new(0,12,0,52) d.BackgroundTransparency=1 d.Text=" + q(a.text || "Continue?") + " d.Font=Enum.Font.Gotham d.TextXAlignment=Enum.TextXAlignment.Left d.TextYAlignment=Enum.TextYAlignment.Top d.TextColor3=Color3.fromRGB(200,200,205) d.TextWrapped=true d.TextScaled=true d.Parent=box\n" +
      "local yes=Instance.new('TextButton') yes.Size=UDim2.new(0,110,0,38) yes.Position=UDim2.new(1,-130,1,-50) yes.BackgroundColor3=(" + cc(a.color, [80, 160, 255]) + ") yes.BorderSizePixel=0 yes.Text='Yes' yes.Font=Enum.Font.GothamBold yes.TextColor3=Color3.new(1,1,1) yes.TextScaled=true yes.Parent=box\n" +
      "local no=Instance.new('TextButton') no.Size=UDim2.new(0,110,0,38) no.Position=UDim2.new(0,12,1,-50) no.BackgroundColor3=Color3.fromRGB(45,45,52) no.BorderSizePixel=0 no.Text='No' no.Font=Enum.Font.GothamBold no.TextColor3=Color3.new(1,1,1) no.TextScaled=true no.Parent=box\n" +
      "local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,10) cr.Parent=box yes.CornerRadius=UDim.new(0,8) no.CornerRadius=UDim.new(0,8)\n" +
      "yes.MouseButton1Click:Connect(function() sg:Destroy() end) no.MouseButton1Click:Connect(function() sg:Destroy() end)\n" +
      "task.delay(" + nn(a.seconds, 15) + ",function() if sg.Parent then sg:Destroy() end end)\n" +
      "return ok({},'confirm dialog shown')";
  };
  B.progress_show = function (a) {
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Progress') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Progress' sg.DisplayOrder=100 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local box=Instance.new('Frame') box.Size=UDim2.new(0,300,0,54) box.Position=UDim2.new(0.5,-150,1,-90) box.BackgroundColor3=Color3.fromRGB(20,20,24) box.BackgroundTransparency=0.2 box.BorderSizePixel=0 box.Parent=sg\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(1,-16,0,20) lbl.Position=UDim2.new(0,8,0,6) lbl.BackgroundTransparency=1 lbl.Text=" + q(a.label || "Loading") + " lbl.Font=Enum.Font.GothamMedium lbl.TextXAlignment=Enum.TextXAlignment.Left lbl.TextColor3=Color3.new(1,1,1) lbl.TextScaled=true lbl.Parent=box\n" +
      "local track=Instance.new('Frame') track.Size=UDim2.new(1,-16,0,10) track.Position=UDim2.new(0,8,1,-20) track.BackgroundColor3=Color3.fromRGB(50,50,58) track.BorderSizePixel=0 track.Parent=box\n" +
      "local fill=Instance.new('Frame') fill.Size=UDim2.new(" + Math.max(0, Math.min(1, (a.value != null ? Number(a.value) : 0.2))) + ",0,1,0) fill.BackgroundColor3=(" + cc(a.color, [80, 160, 255]) + ") fill.BorderSizePixel=0 fill.Parent=track\n" +
      "task.spawn(function() for i=1,60 do task.wait(0.03) fill.Size=UDim2.new(math.min(1,fill.Size.X.Scale+i*0.012),0,1,0) end end)\n" +
      "task.delay(" + nn(a.seconds, 3) + ",function() if sg.Parent then sg:Destroy() end end)\n" +
      "return ok({startValue=" + nn(a.value, 0.2) + "},'progress bar animating')";
  };
  B.loading_show = function (a) {
    var hide = a.hide === true;
    return guiTarget(a) +
      "local sg=pgui:FindFirstChild('OR_Loading')\n" +
      (hide ? "if not sg then return fail('no loading screen to hide') end sg:Destroy()\nreturn ok({},'loading screen hidden')" :
      "if sg then sg:Destroy() end\n" +
      "sg=Instance.new('ScreenGui') sg.Name='OR_Loading' sg.ResetOnSpawn=false sg.DisplayOrder=200 sg.IgnoreGuiInset=true sg.ZIndexBehavior=Enum.ZIndexBehavior.Sibling sg.Parent=pgui\n" +
      "local bg=Instance.new('Frame') bg.Size=UDim2.new(1,0,1,0) bg.BackgroundColor3=Color3.fromRGB(10,10,12) bg.BorderSizePixel=0 bg.Parent=sg\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(0,400,0,40) lbl.Position=UDim2.new(0.5,-200,0.5,-20) lbl.BackgroundTransparency=1 lbl.Text=" + q(a.text || "Loading...") + " lbl.Font=Enum.Font.GothamBold lbl.TextColor3=Color3.new(1,1,1) lbl.TextScaled=true lbl.Parent=bg\n" +
      "return ok({},'loading screen shown (call loading_show {hide:true} to dismiss)')");
  };
  B.shop_ui = function (a) {
    var items = (a.items && a.items.length ? a.items : ["Sword 250", "Shield 150", "Boots 100", "Potion 50"]);
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Shop') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Shop' sg.DisplayOrder=80 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local panel=Instance.new('Frame') panel.Size=UDim2.new(0,340,0," + (70 + items.length * 52) + ") panel.Position=UDim2.new(1,-352,0.5," + (-(35 + items.length * 26)) + ") panel.BackgroundColor3=Color3.fromRGB(20,20,25) panel.BackgroundTransparency=0.15 panel.BorderSizePixel=0 panel.Parent=sg\n" +
      "local head=Instance.new('TextLabel') head.Size=UDim2.new(1,-20,0,30) head.Position=UDim2.new(0,10,0,8) head.BackgroundTransparency=1 head.Text='SHOP' head.Font=Enum.Font.GothamBold head.TextXAlignment=Enum.TextXAlignment.Left head.TextColor3=Color3.new(1,1,1) head.TextScaled=true head.Parent=panel\n" +
      "local items=" + strArr(items.map(String), []) + "\n" +
      "for i,item in ipairs(items) do local btn=Instance.new('TextButton') btn.Size=UDim2.new(1,-20,0,44) btn.Position=UDim2.new(0,10,0,44+(i-1)*50) btn.BackgroundColor3=Color3.fromRGB(40,40,48) btn.BorderSizePixel=0 btn.Text=item btn.Font=Enum.Font.GothamMedium btn.TextXAlignment=Enum.TextXAlignment.Left btn.TextColor3=Color3.new(1,1,1) btn.TextScaled=true btn.Parent=panel local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,8) cr.Parent=btn btn.MouseButton1Click:Connect(function() local rem=ReplicatedStorage:FindFirstChild('Buy',true) if rem then rem:FireServer(item) end end) end\n" +
      "return ok({items=items},'shop UI shown (buttons fire Buy RemoteEvent)')";
  };
  B.inventory_ui = function (a) {
    var slots = Math.max(1, Math.min(12, parseInt(a.size, 10) || 6));
    var cols = slots <= 6 ? slots : 6;
    var rows = Math.ceil(slots / cols);
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Inventory') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Inventory' sg.DisplayOrder=70 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local panel=Instance.new('Frame') panel.Size=UDim2.new(0," + (cols * 52 + 16) + ",0," + (rows * 52 + 50) + ") panel.Position=UDim2.new(0,12,1," + (-(rows * 52 + 56)) + ") panel.BackgroundColor3=Color3.fromRGB(18,18,22) panel.BackgroundTransparency=0.15 panel.BorderSizePixel=0 panel.Parent=sg\n" +
      "local head=Instance.new('TextLabel') head.Size=UDim2.new(1,-16,0,24) head.Position=UDim2.new(0,8,0,6) head.BackgroundTransparency=1 head.Text='INVENTORY' head.Font=Enum.Font.GothamBold head.TextXAlignment=Enum.TextXAlignment.Left head.TextColor3=Color3.new(1,1,1) head.TextScaled=true head.Parent=panel\n" +
      "for i=1," + slots + " do local slot=Instance.new('Frame') local c=(i-1)%" + cols + " local r=math.floor((i-1)/" + cols + ") slot.Size=UDim2.new(0,44,0,44) slot.Position=UDim2.new(0,8+c*52,0,34+r*52) slot.BackgroundColor3=Color3.fromRGB(38,38,46) slot.BorderSizePixel=0 slot.Parent=panel local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,6) cr.Parent=slot end\n" +
      "return ok({slots=" + slots + "},'inventory grid shown')";
  };
  B.chat_ui = function (a) {
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_ChatUI') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_ChatUI' sg.DisplayOrder=60 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local box=Instance.new('Frame') box.Size=UDim2.new(0,300,0," + nn(a.height, 220) + ") box.Position=UDim2.new(0,12,1," + (-(nn(a.height, 220) + 12)) + ") box.BackgroundColor3=Color3.fromRGB(16,16,20) box.BackgroundTransparency=0.25 box.BorderSizePixel=0 box.Parent=sg\n" +
      "local list=Instance.new('ScrollingFrame') list.Size=UDim2.new(1,-12,1,-40) list.Position=UDim2.new(0,6,0,6) list.BackgroundTransparency=1 list.BorderSizePixel=0 list.ScrollBarThickness=4 list.CanvasSize=UDim2.new(0,0,0,600) list.AutomaticCanvasSize=Enum.AutomaticSize.Y list.Parent=box\n" +
      "local ui=Instance.new('UIListLayout') ui.SortOrder=Enum.SortOrder.LayoutOrder ui.Padding=UDim.new(0,4) ui.Parent=list\n" +
      "local bar=Instance.new('Frame') bar.Size=UDim2.new(1,-12,0,30) bar.Position=UDim2.new(0,6,1,-36) bar.BackgroundColor3=Color3.fromRGB(32,32,40) bar.BorderSizePixel=0 bar.Parent=box\n" +
      "local tb=Instance.new('TextBox') tb.Size=UDim2.new(1,-80,1,0) tb.Position=UDim2.new(0,4,0,0) tb.BackgroundTransparency=1 tb.PlaceholderText='Message...' tb.Text='' tb.Font=Enum.Font.Gotham tb.TextColor3=Color3.new(1,1,1) tb.ClearTextOnFocus=false tb.Parent=bar\n" +
      "local send=Instance.new('TextButton') send.Size=UDim2.new(0,70,1,-6) send.Position=UDim2.new(1,-74,0,3) send.BackgroundColor3=(" + cc(a.color, [80, 160, 255]) + ") send.BorderSizePixel=0 send.Text='Send' send.Font=Enum.Font.GothamBold send.TextColor3=Color3.new(1,1,1) send.TextScaled=true send.Parent=bar\n" +
      "local function addLine(t) local l=Instance.new('TextLabel') l.Size=UDim2.new(1,0,0,20) l.BackgroundTransparency=1 l.Text=t l.Font=Enum.Font.Gotham l.TextColor3=Color3.fromRGB(230,230,235) l.TextXAlignment=Enum.TextXAlignment.Left l.TextWrapped=true l.Parent=list end\n" +
      "send.MouseButton1Click:Connect(function() local msg=tb.Text:sub(1,200) if msg~='' then addLine(pl.Name..': '..msg) tb.Text='' local rem=ReplicatedStorage:FindFirstChild('ChatSend',true) if rem then rem:FireServer(msg) end end end)\n" +
      "tb.FocusLost:Connect(function(enter) if enter then send.MouseButton1Click:Fire() end end)\n" +
      "return ok({},'chat UI shown (send fires ChatSend RemoteEvent)')";
  };
  B.tabs_ui = function (a) {
    var tabs = (a.tabs && a.tabs.length ? a.tabs : ["Home", "Stats", "Shop"]);
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Tabs') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Tabs' sg.DisplayOrder=65 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local panel=Instance.new('Frame') panel.Size=UDim2.new(0,320,0,360) panel.Position=UDim2.new(0.5,-160,0.5,-180) panel.BackgroundColor3=Color3.fromRGB(18,18,22) panel.BackgroundTransparency=0.1 panel.BorderSizePixel=0 panel.Parent=sg\n" +
      "local tabs=" + strArr(tabs.map(String), []) + "\n" +
      "for i,t in ipairs(tabs) do local btn=Instance.new('TextButton') btn.Size=UDim2.new(0,96,0,34) btn.Position=UDim2.new(0,8+(i-1)*100,0,8) btn.BackgroundColor3=Color3.fromRGB(34,34,42) btn.BorderSizePixel=0 btn.Text=t btn.Font=Enum.Font.GothamMedium btn.TextColor3=Color3.new(1,1,1) btn.TextScaled=true btn.Parent=panel local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,8) cr.Parent=btn end\n" +
      "local content=Instance.new('Frame') content.Size=UDim2.new(1,-16,1,-60) content.Position=UDim2.new(0,8,0,50) content.BackgroundColor3=Color3.fromRGB(28,28,34) content.BorderSizePixel=0 content.Parent=panel\n" +
      "local label=Instance.new('TextLabel') label.Size=UDim2.new(1,0,1,0) label.BackgroundTransparency=1 label.Text='Select a tab' label.Font=Enum.Font.Gotham label.TextColor3=Color3.fromRGB(180,180,188) label.TextScaled=true label.Parent=content\n" +
      "return ok({tabs=tabs},'tab panel shown')";
  };
  B.dropdown_ui = function (a) {
    var items = (a.items && a.items.length ? a.items : ["Option A", "Option B", "Option C"]);
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Dropdown') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Dropdown' sg.DisplayOrder=75 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local panel=Instance.new('Frame') panel.Size=UDim2.new(0,220,0," + (50 + items.length * 36) + ") panel.Position=UDim2.new(0.5,-110,0.3,0) panel.BackgroundColor3=Color3.fromRGB(18,18,22) panel.BackgroundTransparency=0.1 panel.BorderSizePixel=0 panel.Parent=sg\n" +
      "local head=Instance.new('TextLabel') head.Size=UDim2.new(1,-16,0,26) head.Position=UDim2.new(0,8,0,8) head.BackgroundTransparency=1 head.Text=" + q(a.title || "Choose") + " head.Font=Enum.Font.GothamBold head.TextXAlignment=Enum.TextXAlignment.Left head.TextColor3=Color3.new(1,1,1) head.TextScaled=true head.Parent=panel\n" +
      "local items=" + strArr(items.map(String), []) + "\n" +
      "for i,item in ipairs(items) do local btn=Instance.new('TextButton') btn.Size=UDim2.new(1,-16,0,32) btn.Position=UDim2.new(0,8,0,36+(i-1)*36) btn.BackgroundColor3=Color3.fromRGB(36,36,44) btn.BorderSizePixel=0 btn.Text=item btn.Font=Enum.Font.GothamMedium btn.TextXAlignment=Enum.TextXAlignment.Left btn.TextColor3=Color3.new(1,1,1) btn.TextScaled=true btn.Parent=panel local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,7) cr.Parent=btn btn.MouseButton1Click:Connect(function() panel:Destroy() local rem=ReplicatedStorage:FindFirstChild('Choose',true) if rem then rem:FireServer(item) end end) end\n" +
      "return ok({items=items},'dropdown shown (picks fire Choose RemoteEvent)')";
  };
  B.slider_ui = function (a) {
    var min = Number(a.min != null ? a.min : 0); var max = Number(a.max != null ? a.max : 100);
    var val = Math.max(min, Math.min(max, Number(a.value != null ? a.value : (min + max) / 2)));
    var frac = max > min ? (val - min) / (max - min) : 0;
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Slider') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Slider' sg.DisplayOrder=75 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local panel=Instance.new('Frame') panel.Size=UDim2.new(0,280,0,84) panel.Position=UDim2.new(0.5,-140,0.5,-42) panel.BackgroundColor3=Color3.fromRGB(18,18,22) panel.BackgroundTransparency=0.1 panel.BorderSizePixel=0 panel.Parent=sg\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(1,-16,0,24) lbl.Position=UDim2.new(0,8,0,8) lbl.BackgroundTransparency=1 lbl.Text=" + q(a.label || "Value") + " lbl.Font=Enum.Font.GothamBold lbl.TextXAlignment=Enum.TextXAlignment.Left lbl.TextColor3=Color3.new(1,1,1) lbl.TextScaled=true lbl.Parent=panel\n" +
      "local track=Instance.new('Frame') track.Size=UDim2.new(1,-16,0,10) track.Position=UDim2.new(0,8,0,44) track.BackgroundColor3=Color3.fromRGB(48,48,58) track.BorderSizePixel=0 track.Parent=panel\n" +
      "local fill=Instance.new('Frame') fill.Size=UDim2.new(" + frac + ",0,1,0) fill.BackgroundColor3=(" + cc(a.color, [80, 160, 255]) + ") fill.BorderSizePixel=0 fill.Parent=track\n" +
      "local knob=Instance.new('Frame') knob.Size=UDim2.new(0,20,0,20) knob.Position=UDim2.new(" + frac + ",-10,0.5,-10) knob.BackgroundColor3=Color3.new(1,1,1) knob.BorderSizePixel=0 knob.Parent=track local kc=Instance.new('UICorner') kc.CornerRadius=UDim.new(1,0) kc.Parent=knob\n" +
      "local dragging=false knob.InputBegan:Connect(function(i) if i.UserInputType==Enum.UserInputType.MouseButton1 or i.UserInputType==Enum.UserInputType.Touch then dragging=true end end)\n" +
      "UserInputService.InputEnded:Connect(function(i) if i.UserInputType==Enum.UserInputType.MouseButton1 or i.UserInputType==Enum.UserInputType.Touch then dragging=false end end)\n" +
      "UserInputService.InputChanged:Connect(function(i) if dragging and i.UserInputType==Enum.UserInputType.MouseMovement then local mx=UserInputService:GetMouseLocation().X local r=track.AbsolutePosition.X local w=track.AbsoluteSize.X local f=math.clamp((mx-r)/w,0,1) local v=" + min + "+f*(" + max + "-" + min + ") fill.Size=UDim2.new(f,0,1,0) knob.Position=UDim2.new(f,-10,0.5,-10) lbl.Text=" + q(a.label || "Value") + "..' = '..tostring(math.floor(v)) end end)\n" +
      "task.delay(" + nn(a.seconds, 30) + ",function() if sg.Parent then sg:Destroy() end end)\n" +
      "return ok({min=" + min + ",max=" + max + ",value=" + val + "},'slider shown (drag to set)')";
  };
  B.toggle_ui = function (a) {
    var on = a.on !== false;
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Toggle') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Toggle' sg.DisplayOrder=75 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local panel=Instance.new('Frame') panel.Size=UDim2.new(0,220,0,60) panel.Position=UDim2.new(0.5,-110,0.2,0) panel.BackgroundColor3=Color3.fromRGB(18,18,22) panel.BackgroundTransparency=0.1 panel.BorderSizePixel=0 panel.Parent=sg\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(1,-70,1,0) lbl.Position=UDim2.new(0,10,0,0) lbl.BackgroundTransparency=1 lbl.Text=" + q(a.label || "Enabled") + " lbl.Font=Enum.Font.GothamMedium lbl.TextXAlignment=Enum.TextXAlignment.Left lbl.TextColor3=Color3.new(1,1,1) lbl.TextScaled=true lbl.Parent=panel\n" +
      "local state=" + bb(on, true) + "\n" +
      "local track=Instance.new('Frame') track.Size=UDim2.new(0,46,0,24) track.Position=UDim2.new(1,-56,0.5,-12) track.BackgroundColor3=if state then (" + cc(a.color, [80, 200, 120]) + ") else Color3.fromRGB(58,58,66) track.BorderSizePixel=0 track.Parent=panel local tc=Instance.new('UICorner') tc.CornerRadius=UDim.new(1,0) tc.Parent=track\n" +
      "local knob=Instance.new('Frame') knob.Size=UDim2.new(0,18,0,18) knob.Position=UDim2.new(1,if state then -26 else 4,0.5,-9) knob.BackgroundColor3=Color3.new(1,1,1) knob.BorderSizePixel=0 knob.Parent=track local kc=Instance.new('UICorner') kc.CornerRadius=UDim.new(1,0) kc.Parent=knob\n" +
      "track.MouseButton1Click:Connect(function() state=not state track.BackgroundColor3=if state then (" + cc(a.color, [80, 200, 120]) + ") else Color3.fromRGB(58,58,66) knob.Position=UDim2.new(1,if state then -26 else 4,0.5,-9) end)\n" +
      "task.delay(" + nn(a.seconds, 30) + ",function() if sg.Parent then sg:Destroy() end end)\n" +
      "return ok({on=" + bb(on, true) + "},'toggle shown')";
  };
  B.colors_ui = function (a) {
    var presets = [[255, 255, 255], [255, 80, 80], [80, 200, 120], [80, 160, 255], [255, 200, 60], [180, 120, 255], [120, 120, 120], [20, 20, 24]];
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Colors') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Colors' sg.DisplayOrder=76 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local panel=Instance.new('Frame') panel.Size=UDim2.new(0,176,0,120) panel.Position=UDim2.new(0.5,-88,0.3,0) panel.BackgroundColor3=Color3.fromRGB(18,18,22) panel.BackgroundTransparency=0.1 panel.BorderSizePixel=0 panel.Parent=sg\n" +
      "local presets={" + presets.map(function (c) { return "Color3.fromRGB(" + c[0] + "," + c[1] + "," + c[2] + ")"; }).join(",") + "}\n" +
      "for i,c in ipairs(presets) do local sw=Instance.new('Frame') sw.Size=UDim2.new(0,38,0,38) local col=(i-1)%4 local row=math.floor((i-1)/4) sw.Position=UDim2.new(0,8+col*40,0,8+row*44) sw.BackgroundColor3=c sw.BorderSizePixel=0 sw.Parent=panel local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,6) cr.Parent=sw sw.MouseButton1Click:Connect(function() panel:Destroy() end) end\n" +
      "task.delay(" + nn(a.seconds, 20) + ",function() if sg.Parent then sg:Destroy() end end)\n" +
      "return ok({presets=#presets},'color picker shown')";
  };
  B.tooltip_add = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "local old=p:FindFirstChild('OR_Tooltip') if old then old:Destroy() end\n" +
      "local sg=Instance.new('SurfaceGui') sg.Name='OR_Tooltip' sg.SurfaceType=Enum.SurfaceType.Top sg.Face=Enum.NormalId.Top sg.Size=UDim2.fromOffset(160,44) sg.AlwaysOnTop=true sg.Parent=p\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(1,0,1,0) lbl.BackgroundColor3=Color3.fromRGB(20,20,24) lbl.BackgroundTransparency=0.1 lbl.BorderSizePixel=0 lbl.Text=" + q(a.text || "Tooltip") + " lbl.Font=Enum.Font.GothamMedium lbl.TextColor3=Color3.new(1,1,1) lbl.TextWrapped=true lbl.TextScaled=true lbl.Visible=false lbl.Parent=sg\n" +
      "local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,8) cr.Parent=lbl\n" +
      "local hit=p:FindFirstChildOfClass('BasePart')\n" +
      "p.Touched:Connect(function() lbl.Visible=true task.delay(3,function() lbl.Visible=false end) end)\n" +
      "return ok({path=sg:GetFullName()},'tooltip on touch')";
  };
  B.tooltip_remove = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "local old=p:FindFirstChild('OR_Tooltip')\n" +
      "if not old then return fail('no tooltip on part') end\n" +
      "old:Destroy()\n" +
      "return ok({},'tooltip removed')";
  };
  B.countdown_show = function (a) {
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Countdown') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Countdown' sg.DisplayOrder=150 sg.IgnoreGuiInset=true sg.ZIndexBehavior=Enum.ZIndexBehavior.Sibling sg.Parent=pgui\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(1,0,0,160) lbl.Position=UDim2.new(0,0,0.5,-80) lbl.BackgroundTransparency=1 lbl.Text='" + nn(a.seconds, 5) + "' lbl.Font=Enum.Font.GothamBlack lbl.TextColor3=(" + cc(a.color, [255, 180, 60]) + ") lbl.TextScaled=true lbl.Parent=sg\n" +
      "local n=" + nn(a.seconds, 5) + "\n" +
      "for i=n,1,-1 do lbl.Text=tostring(i) if i>1 then task.wait(1) end end\n" +
      "lbl.Text='GO' task.wait(0.8) sg:Destroy()\n" +
      "return ok({seconds=n},'countdown running')";
  };
  B.timer_show = function (a) {
    var down = String(a.mode || "up").toLowerCase().indexOf("down") === 0;
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Timer') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Timer' sg.DisplayOrder=90 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(0,150,0,44) lbl.Position=UDim2.new(0.5,-75,0,8) lbl.BackgroundColor3=Color3.fromRGB(18,18,22) lbl.BackgroundTransparency=0.2 lbl.BorderSizePixel=0 lbl.Text='0.0s' lbl.Font=Enum.Font.GothamBold lbl.TextColor3=Color3.new(1,1,1) lbl.TextScaled=true lbl.Parent=sg\n" +
      "local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,8) cr.Parent=lbl\n" +
      "local t=0 local running=true\n" +
      "task.spawn(function() while running and t<" + (down ? nn(a.seconds, 60) : 3600) + " do t+=task.wait(0.1) lbl.Text=tostring(math.floor(t*10)/10)..'s' end running=false task.wait(0.4) sg:Destroy() end)\n" +
      "return ok({mode=" + q(down ? "down" : "up") + "},'timer running')";
  };
  B.waypoint_arrow = function (a) {
    return guiTarget(a) +
      "local target=partOf(resolve(" + q(a.path || "") + ")) if not target then return fail('part not found') end\n" +
      "local old=pgui:FindFirstChild('OR_Waypoint') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Waypoint' sg.DisplayOrder=110 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local arrow=Instance.new('Frame') arrow.Size=UDim2.new(0,26,0,26) arrow.BackgroundColor3=(" + cc(a.color, [255, 120, 60]) + ") arrow.BorderSizePixel=0 arrow.Parent=sg\n" +
      "local cl=Instance.new('UIAspectRatioConstraint') cl.AspectRatio=1 cl.Parent=arrow local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,6) cr.Parent=arrow\n" +
      "local hrp=hrpOf(firstPlayer()) or partOf(resolve('Workspace'))\n" +
      "local cam=Workspace.CurrentCamera\n" +
      "RunService.RenderStepped:Connect(function() if not sg.Parent then return end local _,screen=cam:WorldToViewportPoint(target.Position) if screen then arrow.Position=UDim2.new(0,screen.X-13,0,screen.Y-13) arrow.Visible=screen.Z>0 else arrow.Visible=false end end)\n" +
      "return ok({target=target:GetFullName()},'waypoint arrow tracking part')";
  };
  B.crosshair_set = function (a) {
    return guiTarget(a) +
      "local old=pgui:FindFirstChild('OR_Crosshair') if old then old:Destroy() end\n" +
      "local sg=Instance.new('ScreenGui') sg.Name='OR_Crosshair' sg.DisplayOrder=95 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local dot=Instance.new('Frame') dot.Size=UDim2.new(0," + nn(a.size, 4) + ",0," + nn(a.size, 4) + ") dot.Position=UDim2.new(0.5," + (-(nn(a.size, 4) / 2)) + ",0.5," + (-(nn(a.size, 4) / 2)) + ") dot.BackgroundColor3=(" + cc(a.color, [255, 255, 255]) + ") dot.BorderSizePixel=0 dot.Parent=sg\n" +
      "local dc=Instance.new('UICorner') dc.CornerRadius=UDim.new(1,0) dc.Parent=dot\n" +
      "return ok({size=" + nn(a.size, 4) + "},'crosshair set')";
  };
  B.fps_counter = function (a) {
    var off = a.on === false;
    return guiTarget(a) +
      "local sg=pgui:FindFirstChild('OR_FPS')\n" +
      (off ? "if not sg then return fail('no fps counter') end sg:Destroy()\nreturn ok({},'fps counter hidden')" :
      "if sg then return ok({},'already showing') end\n" +
      "sg=Instance.new('ScreenGui') sg.Name='OR_FPS' sg.DisplayOrder=96 sg.IgnoreGuiInset=true sg.Parent=pgui\n" +
      "local lbl=Instance.new('TextLabel') lbl.Size=UDim2.new(0,64,0,22) lbl.Position=UDim2.new(1,-72,0,8) lbl.BackgroundColor3=Color3.fromRGB(18,18,22) lbl.BackgroundTransparency=0.25 lbl.BorderSizePixel=0 lbl.Text='60 FPS' lbl.Font=Enum.Font.GothamBold lbl.TextColor3=Color3.fromRGB(140,255,160) lbl.TextScaled=true lbl.Parent=sg\n" +
      "local cr=Instance.new('UICorner') cr.CornerRadius=UDim.new(0,6) cr.Parent=lbl\n" +
      "local frames=0\n" +
      "RunService.Heartbeat:Connect(function() frames+=1 end)\n" +
      "task.spawn(function() while sg.Parent do task.wait(1) lbl.Text=tostring(frames)..' FPS' frames=0 end end)\n" +
      "return ok({},'fps counter shown')");
  };
  B.gui_hide_all = function (a) {
    return guiTarget(a) +
      "local n=0 for _,sg in ipairs(pgui:GetChildren()) do if sg:IsA('ScreenGui') and not sg.Name:match('^OR_') then sg.Enabled=false n+=1 end end\n" +
      "return ok({hidden=n},'third-party screens hidden (OR_ screens kept)')";
  };
  B.gui_show_all = function (a) {
    return guiTarget(a) +
      "local n=0 for _,sg in ipairs(pgui:GetChildren()) do if sg:IsA('ScreenGui') and not sg.Enabled then sg.Enabled=true n+=1 end end\n" +
      "return ok({shown=n},'screens restored')";
  };

  // ── G. Input, camera & motion (15) ────────────────────────────────────
  B.input_bind = function (a) {
    var key = String(a.key || "E").toUpperCase();
    var action = String(a.action || "ORAction").replace(/[^A-Za-z0-9_]/g, "");
    var keycode = { E: "Enum.KeyCode.E", Q: "Enum.KeyCode.Q", R: "Enum.KeyCode.R", F: "Enum.KeyCode.F", C: "Enum.KeyCode.C", V: "Enum.KeyCode.V", B: "Enum.KeyCode.B", G: "Enum.KeyCode.G", H: "Enum.KeyCode.H", X: "Enum.KeyCode.X", Z: "Enum.KeyCode.Z", SPACE: "Enum.KeyCode.Space", LEFTSHIFT: "Enum.KeyCode.LeftShift" }[key] || "Enum.KeyCode." + key;
    return "local old=ServerScriptService:FindFirstChild('OR_Bind_" + action + "') if old then old:Destroy() end\n" +
      "local src='local Players=game:GetService(\\'Players\\')\\nlocal CAS=game:GetService(\\'ContextActionService\\')\\nlocal Remotes=game:GetService(\\'ReplicatedStorage\\')\\nCAS:BindAction('" + action + "',function() local rem=Remotes:FindFirstChild('" + action + "_Fired',true) if rem then rem:FireServer() end print(\\'[OR] " + action + " triggered\\') end,false," + keycode + ")\\n'\n" +
      "local s=mkScript('Script','OR_Bind_" + action + "',ServerScriptService,src)\n" +
      "return ok({script=s:GetFullName(),key='" + key + "'},'key " + key + " bound to " + action + "')";
  };
  B.input_unbind = function (a) {
    var action = String(a.action || "").replace(/[^A-Za-z0-9_]/g, "");
    return "local s=ServerScriptService:FindFirstChild('OR_Bind_" + action + "')\n" +
      "if not s then return fail('no binding named ' .. '" + action + "') end\n" +
      "local CAS=game:GetService('ContextActionService') pcall(function() CAS:UnbindAction('" + action + "') end)\n" +
      "s:Destroy()\n" +
      "return ok({action='" + action + "'},'binding removed')";
  };
  B.mouse_pos_get = function (a) {
    return "local pos=UserInputService:GetMouseLocation()\n" +
      "return ok({x=pos.X,y=pos.Y},'mouse position')";
  };
  B.mouse_region = function (a) {
    return "local g=resolve(" + q(a.path || "") + ") if not g then return fail('path not found') end\n" +
      "if not g:IsA('GuiObject') then return fail('not a GuiObject') end\n" +
      "local old=g:FindFirstChildOfClass('MouseRegion') if old then old:Destroy() end\n" +
      "local mr=Instance.new('MouseRegion') mr.Parent=g\n" +
      "return ok({path=mr:GetFullName()},'MouseRegion added')";
  };
  B.gamepad_rumble = function (a) {
    return "local okc,err=pcall(function() UserInputService:VibrateRumble(Enum.UserInputType.Gamepad1," + nn(a.left, 0.8) + "," + nn(a.right, 0.8) + "," + nn(a.duration, 0.5) + ") end)\n" +
      "if not okc then return fail('rumble unavailable in Studio: ' + tostring(err)) end\n" +
      "return ok({left=" + nn(a.left, 0.8) + ",right=" + nn(a.right, 0.8) + "},'rumble fired')";
  };
  B.haptics = function (a) {
    var kind = { pistol: "Pistol", rifle: "Rifle", heavy: "Rifle" }[String(a.type || "pistol").toLowerCase()] || "Pistol";
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local c=charOf(pl) if not c then return fail('no character') end\n" +
      "local okc,err=pcall(function() pl:FireHapticFeedback(Enum.HapticFeedback." + kind + ",40," + nn(a.duration, 0.4) + ") end)\n" +
      "if not okc then return fail('haptics unavailable in Studio: ' + tostring(err)) end\n" +
      "return ok({type='" + kind + "'},'haptic feedback fired')";
  };
  B.camera_type = function (a) {
    var mode = String(a.mode || "Scriptable").toLowerCase() === "custom" ? "Custom" : "Scriptable";
    return "local cam=Workspace.CurrentCamera if not cam then return fail('no camera') end\n" +
      "cam.CameraType=Enum.CameraType." + mode + "\n" +
      "return ok({cameraType='" + mode + "'},'camera type set')";
  };
  B.camera_fov = function (a) {
    return "local cam=Workspace.CurrentCamera if not cam then return fail('no camera') end\n" +
      "local t=cam.CameraType if t==Enum.CameraType.Scriptable then cam.FieldOfView=" + nn(a.fov, 70) + " return ok({fov=" + nn(a.fov, 70) + "},'fov set') end\n" +
      "cam.CFrame=cam.CFrame cam.FieldOfView=" + nn(a.fov, 70) + "\n" +
      "return ok({fov=" + nn(a.fov, 70) + "},'fov set (custom camera)')";
  };
  B.camera_zoom = function (a) {
    var dir = String(a.dir || "in").toLowerCase();
    var amt = Math.abs(Number(nn(a.amount, 10)));
    var delta = (dir === "out" ? amt : -amt);
    return "local cam=Workspace.CurrentCamera if not cam then return fail('no camera') end\n" +
      "local before=cam.FieldOfView\n" +
      "cam.FieldOfView=math.clamp(before+(" + delta + "),1,120)\n" +
      "return ok({from=before,to=cam.FieldOfView,dir='" + (dir === "out" ? "out" : "in") + "'},'camera FOV '..string.format('%.0f',before)..' -> '..string.format('%.0f',cam.FieldOfView))";
  };
  B.camera_shake = function (a) {
    return "local cam=Workspace.CurrentCamera if not cam then return fail('no camera') end\n" +
      "local base=cam.CFrame local t=0 local secs=" + nn(a.seconds, 0.5) + " local strength=" + nn(a.strength, 1) + "\n" +
      "while t<secs do local s=(math.random()-0.5)*2*strength cam.CFrame=base+CFrame.new(s, (math.random()-0.5)*2*strength, (math.random()-0.5)*2*strength) t+=task.wait(1/30) end\n" +
      "cam.CFrame=base\n" +
      "return ok({seconds=secs},'camera shaken')";
  };
  B.camera_reset = function (a) {
    return "local cam=Workspace.CurrentCamera if not cam then return fail('no camera') end\n" +
      "cam.CameraType=Enum.CameraType.Scriptable cam.CameraSubject=nil\n" +
      "return ok({},'camera reset to default')";
  };
  B.tween_cancel = function (a) {
    return "local i=resolve(" + q(a.path || "") + ") if not i then return fail('path not found') end\n" +
      "local n=#TweenService:GetTweens(i) for _,tw in ipairs(TweenService:GetTweens(i)) do tw:Cancel() end\n" +
      "return ok({cancelled=n},'tweens cancelled')";
  };
  B.tweens_list = function (a) {
    return "local i=resolve(" + q(a.path || "Workspace") + ") or Workspace\n" +
      "local out={} for _,tw in ipairs(TweenService:GetTweens(i)) do out[#out+1]=tostring(tw) end\n" +
      "return ok({count=#out,items=out},'active tweens')";
  };
  B.tween_speed = function (a) {
    return "local i=resolve(" + q(a.path || "") + ") if not i then return fail('path not found') end\n" +
      "local n=0 for _,tw in ipairs(TweenService:GetTweens(i)) do tw.PlaybackSpeed=" + nn(a.speed, 1) + " n+=1 end\n" +
      "if n==0 then return fail('no tweens on instance') end\n" +
      "return ok({tweens=n,speed=" + nn(a.speed, 1) + "},'tween speed set')";
  };
  B.screen_shake = function (a) {
    return "local g=resolve(" + q(a.path || "") + ") if not g then return fail('path not found') end\n" +
      "if not g:IsA('GuiObject') then return fail('not a GuiObject') end\n" +
      "local base=g.Position local t=0 local secs=" + nn(a.seconds, 0.4) + " local strength=" + nn(a.strength, 8) + "\n" +
      "while t<secs do local s=(math.random()-0.5)*strength g.Position=base+UDim2.new(0,s,0,s) t+=task.wait(1/30) end\n" +
      "g.Position=base\n" +
      "return ok({seconds=secs},'gui shaken')";
  };
  B.snap_to_grid = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "local grid=" + nn(a.size, 4) + " if grid<=0 then return fail('grid must be > 0') end\n" +
      "local pos=p.Position p.CFrame=CFrame.new(math.floor(pos.x/grid+0.5)*grid, math.floor(pos.y/grid+0.5)*grid, math.floor(pos.z/grid+0.5)*grid)\n" +
      "return ok({position={p.Position.x,p.Position.y,p.Position.z}},'snapped to ' .. '" + nn(a.size, 4) + "' .. '-stud grid')";
  };

  // ── H. Lighting & weather (16) ────────────────────────────────────────
  B.fog_set = function (a) {
    return "Lighting.FogColor=" + cc(a.color, [40, 40, 60]) + "\n" +
      "Lighting.FogStart=" + nn(a.start, 100) + " Lighting.FogEnd=" + nn(a["end"], 2000) + "\n" +
      "return ok({fogStart=" + nn(a.start, 100) + ",fogEnd=" + nn(a["end"], 2000) + "},'fog set')";
  };
  B.ambient_set = function (a) {
    return "Lighting.Ambient=" + cc(a.color, [120, 120, 120]) + "\n" +
      "if " + bb(a.brightness != null, false) + " then Lighting.Brightness=" + nn(a.brightness, 2) + " end\n" +
      "return ok({ambient=true},'ambient set')";
  };
  B.exposure_set = function (a) {
    return "local film=Lighting:FindFirstChildOfClass('Film') or Instance.new('Film') film.Parent=Lighting\n" +
      "film.ExposureCompensation=" + nn(a.value, 0) + "\n" +
      "return ok({exposure=" + nn(a.value, 0) + "},'exposure set')";
  };
  B.film_grain = function (a) {
    return "local film=Lighting:FindFirstChildOfClass('Film') or Instance.new('Film') film.Parent=Lighting\n" +
      "film.GrainIntensity=" + nn(a.intensity, 0.2) + "\n" +
      "return ok({grain=" + nn(a.intensity, 0.2) + "},'film grain set')";
  };
  B.film_contrast = function (a) {
    return "local film=Lighting:FindFirstChildOfClass('Film') or Instance.new('Film') film.Parent=Lighting\n" +
      "film.Contrast=" + nn(a.value, 0.1) + "\n" +
      "return ok({contrast=" + nn(a.value, 0.1) + "},'film contrast set')";
  };
  B.film_motion_blur = function (a) {
    return "local film=Lighting:FindFirstChildOfClass('Film') or Instance.new('Film') film.Parent=Lighting\n" +
      "film.MotionBlurIntensity=" + nn(a.intensity, 0.5) + "\n" +
      "return ok({motionBlur=" + nn(a.intensity, 0.5) + "},'motion blur set')";
  };
  B.light_flicker = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + "))\n" +
      "local light=if p then p:FindFirstChildOfClass('PointLight') else nil\n" +
      "if not light then light=Instance.new('PointLight') light.Color=" + cc(a.color, [255, 180, 90]) + " light.Brightness=2 light.Range=14 if p then light.Parent=p else light.Parent=Lighting end end\n" +
      "task.spawn(function() while light.Parent do light.Brightness=1.4+math.random()*1.4 task.wait(0.06) end end)\n" +
      "return ok({path=light:GetFullName()},'flickering candle light on')";
  };
  B.light_pulse = function (a) {
    return "local p=partOf(resolve(" + q(a.path || "") + ")) if not p then return fail('part not found') end\n" +
      "local light=p:FindFirstChildOfClass('PointLight') or p:FindFirstChildOfClass('SpotLight') if not light then return fail('no light on part') end\n" +
      "local lo=" + nn(a.min, 0.5) + " local hi=" + nn(a.max, 3) + " local speed=" + nn(a.speed, 1) + "\n" +
      "task.spawn(function() local t=0 while light.Parent do t+=task.wait(1/30) local k=(math.sin(t*speed*6.28)+1)/2 light.Brightness=lo+(hi-lo)*k end end)\n" +
      "return ok({min=lo,max=hi},'light pulsing')";
  };
  B.water_body = function (a) {
    return "local pos=" + vv(a.position, [0, 0, 0]) + " local sz=" + vv(a.size, [40, 2, 40]) + "\n" +
      "local w=Instance.new('Part') w.Name='OR_Water' w.Size=sz w.Position=pos w.Anchored=true w.CanCollide=false w.Transparency=0.35 w.Material=Enum.Material.Water w.Color=" + cc(a.color, [60, 120, 200]) + " w.TopSurface=Enum.SurfaceType.Smooth w.BottomSurface=Enum.SurfaceType.Smooth w.Parent=Workspace\n" +
      "return ok({path=w:GetFullName()},'water body created')";
  };
  B.weather_snow = function (a) {
    var off = a.on === false;
    return (off ? "local w=Lighting:FindFirstChild('OR_Weather') if w then w:Destroy() end return ok({},'weather off')" :
      "local w=Lighting:FindFirstChild('OR_Weather') if w then for _,c in ipairs(w:GetChildren()) do c:Destroy() end else w=Instance.new('Part') w.Name='OR_Weather' w.Anchored=true w.CanCollide=false w.Transparency=1 w.Size=Vector3.new(2,2,2) w.Position=Vector3.new(0,20,0) w.Parent=Lighting end\n" +
      "local pe=Instance.new('ParticleEmitter') pe.Name='Snow' pe.Parent=w\n" +
      "pe.Rate=220 pe.Lifetime=NumberRange.new(6,10) pe.Speed=NumberRange.new(2,5) pe.SpreadAngle=Vector2.new(180,180) pe.EmissionDirection=Enum.NormalId.Bottom pe.Acceleration=Vector3.new(0,-2,0) pe.ParticleColor=ColorSequence.new(Color3.new(1,1,1)) pe.Size=NumberSequence.new(0.15) pe.Transparency=NumberSequence.new(0.4) pe.LightEmission=0.2\n" +
      "pe.Enabled=true\n" +
      "return ok({},'snowfall on')");
  };
  B.weather_rain = function (a) {
    var off = a.on === false;
    return (off ? "local w=Lighting:FindFirstChild('OR_Weather') if w then w:Destroy() end return ok({},'weather off')" :
      "local w=Lighting:FindFirstChild('OR_Weather') if w then for _,c in ipairs(w:GetChildren()) do c:Destroy() end else w=Instance.new('Part') w.Name='OR_Weather' w.Anchored=true w.CanCollide=false w.Transparency=1 w.Size=Vector3.new(2,2,2) w.Position=Vector3.new(0,40,0) w.Parent=Lighting end\n" +
      "local pe=Instance.new('ParticleEmitter') pe.Name='Rain' pe.Parent=w\n" +
      "pe.Rate=900 pe.Lifetime=NumberRange.new(1,2) pe.Speed=NumberRange.new(30,50) pe.SpreadAngle=Vector2.new(2,2) pe.EmissionDirection=Enum.NormalId.Bottom pe.Acceleration=Vector3.new(0,-98,0) pe.ParticleColor=ColorSequence.new(Color3.fromRGB(150,180,220)) pe.Size=NumberSequence.new(0.12) pe.Transparency=NumberSequence.new(0.5) pe.StretchToSize=8\n" +
      "pe.Enabled=true\n" +
      "return ok({},'rain on')");
  };
  B.weather_storm = function (a) {
    var off = a.on === false;
    return (off ? "local w=Lighting:FindFirstChild('OR_Weather') if w then w:Destroy() end Lighting.Brightness=2 return ok({},'storm off')" :
      "local w=Lighting:FindFirstChild('OR_Weather') if w then for _,c in ipairs(w:GetChildren()) do c:Destroy() end else w=Instance.new('Part') w.Name='OR_Weather' w.Anchored=true w.CanCollide=false w.Transparency=1 w.Size=Vector3.new(2,2,2) w.Position=Vector3.new(0,40,0) w.Parent=Lighting end\n" +
      "local pe=Instance.new('ParticleEmitter') pe.Name='StormRain' pe.Parent=w\n" +
      "pe.Rate=1200 pe.Lifetime=NumberRange.new(0.8,1.6) pe.Speed=NumberRange.new(40,70) pe.SpreadAngle=Vector2.new(4,4) pe.EmissionDirection=Enum.NormalId.Bottom pe.Acceleration=Vector3.new(0,-98,0) pe.ParticleColor=ColorSequence.new(Color3.fromRGB(120,150,200)) pe.Size=NumberSequence.new(0.14) pe.Transparency=NumberSequence.new(0.5) pe.StretchToSize=10\n" +
      "pe.Enabled=true\n" +
      "local flash=Instance.new('PointLight') flash.Name='Flash' flash.Color=Color3.fromRGB(220,225,255) flash.Brightness=0 flash.Range=500 flash.Parent=Lighting\n" +
      "task.spawn(function() while flash.Parent do task.wait(4+math.random()*8) flash.Brightness=14 task.wait(0.08) flash.Brightness=0 task.wait(0.1) flash.Brightness=6 task.wait(0.12) flash.Brightness=0 end end)\n" +
      "Lighting.Brightness=1 Lighting.Ambient=Color3.fromRGB(70,70,90) Lighting.ClockTime=12\n" +
      "return ok({},'thunderstorm on (rain + lightning flashes)')");
  };
  B.clouds_set = function (a) {
    return "local c=Lighting:FindFirstChildOfClass('Clouds') or Instance.new('Clouds') c.Parent=Lighting\n" +
      "c.Density=" + nn(a.density, 0.4) + " c.Speed=" + nn(a.speed, 10) + "\n" +
      "return ok({density=" + nn(a.density, 0.4) + ",speed=" + nn(a.speed, 10) + "},'clouds set')";
  };
  B.atmosphere_setup = function (a) {
    return "local at=Lighting:FindFirstChildOfClass('Atmosphere') or Instance.new('Atmosphere') at.Parent=Lighting\n" +
      "if " + bb(a.density != null, false) + " then at.Density=" + nn(a.density, 0.5) + " end\n" +
      "if " + bb(a.fog != null, false) + " then at.FogColor=" + cc(a.fog, [120, 120, 140]) + " end\n" +
      "if " + bb(a.offset != null, false) + " then at.Offset=" + nn(a.offset, 0.1) + " end\n" +
      "return ok({path=at:GetFullName()},'atmosphere set')";
  };
  B.sun_set_angle = function (a) {
    var ang = Number(a.angle != null ? a.angle : 90);
    var hour = ((360 - ang) / 360) * 12;
    return "Lighting.ClockTime=" + (Math.round(hour * 100) / 100) + "\n" +
      "return ok({angle=" + ang + ",clockTime=" + (Math.round(hour * 100) / 100) + "},'sun angle set')";
  };
  B.day_night_cycle = function (a) {
    var minutes = nn(a.minutes, 2);
    return "local old=ServerScriptService:FindFirstChild('OR_DayNightCycle') if old then old:Destroy() end\n" +
      "local s=mkScript('Script','OR_DayNightCycle',ServerScriptService,'local Lighting=game:GetService(\\'Lighting\\')\\nlocal speed=" + minutes + "/(24*60)\\nwhile true do Lighting.ClockTime=(Lighting.ClockTime+speed)%(24) task.wait(1) end\\n')\n" +
      "return ok({script=s:GetFullName(),minutesPerDay=" + minutes + "},'day/night cycle running')";
  };

  // ── I. Audio (12) ─────────────────────────────────────────────────────
  B.audio_mute_all = function (a) {
    return "local n=0 for _,s in ipairs(game:GetDescendants()) do if s:IsA('Sound') then s.PlaybackLoudness=-80 n+=1 end end\n" +
      "return ok({muted=n},'all sounds muted (PlaybackLoudness -80)')";
  };
  B.audio_unmute_all = function (a) {
    return "local n=0 for _,s in ipairs(game:GetDescendants()) do if s:IsA('Sound') and s.PlaybackLoudness<-70 then s.PlaybackLoudness=0 n+=1 end end\n" +
      "return ok({unmuted=n},'muted sounds restored')";
  };
  B.audio_volume = function (a) {
    return "local n=0 for _,s in ipairs(game:GetDescendants()) do if s:IsA('Sound') then s.Volume=" + nn(a.volume, 0.5) + " n+=1 end end\n" +
      "return ok({sounds=n,volume=" + nn(a.volume, 0.5) + "},'all sound volumes set')";
  };
  B.audio_stop_all = function (a) {
    return "local n=0 for _,s in ipairs(game:GetDescendants()) do if s:IsA('Sound') and s.IsPlaying then s:Stop() n+=1 end end\n" +
      "return ok({stopped=n},'all sounds stopped')";
  };
  B.audio_loop = function (a) {
    return "local i=resolve(" + q(a.path || "") + ") local s=if i and i:IsA('Sound') then i else (i and i:FindFirstChildOfClass('Sound'))\n" +
      "if not s then return fail('sound not found') end\n" +
      "s.Looped=" + bb(a.loop, true) + "\n" +
      "return ok({looped=" + bb(a.loop, true) + "},'sound looped')";
  };
  B.audio_pitch = function (a) {
    return "local i=resolve(" + q(a.path || "") + ") local s=if i and i:IsA('Sound') then i else (i and i:FindFirstChildOfClass('Sound'))\n" +
      "if not s then return fail('sound not found') end\n" +
      "s.Pitch=" + nn(a.pitch, 1) + "\n" +
      "return ok({pitch=" + nn(a.pitch, 1) + "},'pitch set')";
  };
  B.audio_pan = function (a) {
    return "local i=resolve(" + q(a.path || "") + ") local s=if i and i:IsA('Sound') then i else (i and i:FindFirstChildOfClass('Sound'))\n" +
      "if not s then return fail('sound not found') end\n" +
      "s.Pan=" + nn(a.pan, 0) + "\n" +
      "return ok({pan=" + nn(a.pan, 0) + "},'pan set')";
  };
  B.audio_id = function (a) {
    return "local i=resolve(" + q(a.path || "") + ") local s=if i and i:IsA('Sound') then i else (i and i:FindFirstChildOfClass('Sound'))\n" +
      "if not s then return fail('sound not found') end\n" +
      "s.SoundId='rbxassetid://" + nn(a.assetid, 0) + "'\n" +
      "return ok({assetId=" + nn(a.assetid, 0) + "},'sound asset set')";
  };
  B.sound_library = function (a) {
    return "local folder=ReplicatedStorage:FindFirstChild('OR_SoundLibrary') or Instance.new('Folder')\n" +
      "folder.Name='OR_SoundLibrary' folder.Parent=ReplicatedStorage\n" +
      "local presets={{'Click','1837875052'},{'Pop','1837875053'},{'Win','1837875056'},{'Lose','1837875057'},{'Alert','1837875058'},{'Whoosh','1837875059'}}\n" +
      "local made=0 for _,p in ipairs(presets) do if not folder:FindFirstChild(p[1]) then local s=Instance.new('Sound') s.Name=p[1] s.SoundId='rbxassetid://'..p[2] s.Parent=folder made+=1 end end\n" +
      "return ok({created=made,folder=folder:GetFullName()},'sound library ready')";
  };
  B.jingle = function (a) {
    var ids = { win: "1837875056", lose: "1837875057", click: "1837875052", pop: "1837875053", alert: "1837875058", whoosh: "1837875059" };
    var kind = String(a.kind || "click").toLowerCase();
    var id = ids[kind] || ids.click;
    return "local s=Instance.new('Sound') s.SoundId='rbxassetid://" + id + "' s.Parent=Lighting s:Play()\n" +
      "Debris:AddItem(s,4)\n" +
      "return ok({kind='" + kind + "'},'jingle playing')";
  };
  B.ambient_loop = function (a) {
    return "local old=Lighting:FindFirstChild('OR_Ambient') if old then old:Destroy() end\n" +
      "local s=Instance.new('Sound') s.Name='OR_Ambient' s.SoundId='rbxassetid://" + nn(a.assetid, 1837875060) + "' s.Looped=true s.Volume=" + nn(a.volume, 0.3) + " s.Parent=Lighting s:Play()\n" +
      "return ok({path=s:GetFullName()},'ambient loop playing')";
  };
  B.voice_radio = function (a) {
    return "local old=ReplicatedStorage:FindFirstChild('OR_VoiceRadio') if old then old:Destroy() end\n" +
      "local vr=Instance.new('VoiceRadio') vr.Name='OR_VoiceRadio' vr.Radius=60 vr.Parent=ReplicatedStorage\n" +
      "return ok({path=vr:GetFullName(),radius=60},'VoiceRadio created (team talk within 60 studs)')";
  };

  // ── J. VFX & particles (12) ───────────────────────────────────────────
  function emitterAt(a, make) {
    return "local pos=" + vv(a.position || a.point, [0, 5, 0]) + "\n" +
      "local host=Instance.new('Part') host.Name='OR_FX_' .. '" + (a.name || "fx") + "' host.Anchored=true host.CanCollide=false host.Transparency=1 host.Size=Vector3.new(0.5,0.5,0.5) host.Position=pos host.Parent=Workspace\n" +
      make + "\n" +
      "local pe=host:FindFirstChildOfClass('ParticleEmitter')\n" +
      "task.delay(6,function() if host.Parent then host:Destroy() end end)\n" +
      "return ok({path=host:GetFullName()},'burst at point')";
  }
  B.fx_puff = function (a) {
    return emitterAt(a, "local pe=Instance.new('ParticleEmitter') pe.Name='Puff' pe.Parent=host\n" +
      "pe.Lifetime=NumberRange.new(0.5,1) pe.Rate=0 pe.BurstCount=40 pe.Speed=NumberRange.new(4,10) pe.SpreadAngle=Vector2.new(180,180) pe.Acceleration=Vector3.new(0,-4,0) pe.ParticleColor=ColorSequence.new(" + cc(a.color, [200, 200, 200]) + ") pe.Size=NumberSequence.new(0.3,0.9) pe.Transparency=NumberSequence.new(0.3,1)");
  };
  B.fx_bubbles = function (a) {
    return emitterAt(a, "local pe=Instance.new('ParticleEmitter') pe.Name='Bubbles' pe.Parent=host\n" +
      "pe.Lifetime=NumberRange.new(0.8,1.6) pe.Rate=0 pe.BurstCount=30 pe.Speed=NumberRange.new(3,8) pe.SpreadAngle=Vector2.new(120,120) pe.EmissionDirection=Enum.NormalId.Top pe.Acceleration=Vector3.new(0,6,0) pe.ParticleColor=ColorSequence.new(Color3.fromRGB(170,220,255)) pe.Size=NumberSequence.new(0.12,0.2) pe.Transparency=NumberSequence.new(0.1,0.9) pe.LightEmission=0.4");
  };
  B.fx_confetti = function (a) {
    var count = nn(a.count, 60);
    return emitterAt(a, "local pe=Instance.new('ParticleEmitter') pe.Name='Confetti' pe.Parent=host\n" +
      "pe.Lifetime=NumberRange.new(2,3.5) pe.Rate=0 pe.BurstCount=" + count + " pe.Speed=NumberRange.new(8,16) pe.SpreadAngle=Vector2.new(60,60) pe.EmissionDirection=Enum.NormalId.Top pe.Acceleration=Vector3.new(0,-20,0) pe.ParticleColor=ColorSequence.new({ColorSequenceKeypoint.new(Color3.fromRGB(255,80,80),0),ColorSequenceKeypoint.new(Color3.fromRGB(80,200,255),0.5),ColorSequenceKeypoint.new(Color3.fromRGB(255,220,80),1)}) pe.Size=NumberSequence.new(0.14) pe.Transparency=NumberSequence.new(0,1) pe.Rotation=NumberRange.new(0,360)");
  };
  B.fx_sparks = function (a) {
    return emitterAt(a, "local pe=Instance.new('ParticleEmitter') pe.Name='Sparks' pe.Parent=host\n" +
      "pe.Lifetime=NumberRange.new(0.25,0.6) pe.Rate=0 pe.BurstCount=50 pe.Speed=NumberRange.new(14,30) pe.SpreadAngle=Vector2.new(180,180) pe.Acceleration=Vector3.new(0,-30,0) pe.ParticleColor=ColorSequence.new(Color3.fromRGB(255,200,80)) pe.Size=NumberSequence.new(0.08) pe.Transparency=NumberSequence.new(0,1) pe.LightEmission=1 pe.Enabled=false");
  };
  B.fx_smoke_burst = function (a) {
    return emitterAt(a, "local pe=Instance.new('ParticleEmitter') pe.Name='Smoke' pe.Parent=host\n" +
      "pe.Lifetime=NumberRange.new(1.5,2.5) pe.Rate=0 pe.BurstCount=25 pe.Speed=NumberRange.new(2,6) pe.SpreadAngle=Vector2.new(180,180) pe.Acceleration=Vector3.new(0,8,0) pe.ParticleColor=ColorSequence.new(" + cc(a.color, [90, 90, 90]) + ") pe.Size=NumberSequence.new(0.8,3) pe.Transparency=NumberSequence.new(0.2,1)");
  };
  B.fx_ring = function (a) {
    return "local pos=" + vv(a.position || a.point, [0, 2, 0]) + " local r=" + nn(a.radius, 6) + "\n" +
      "local ring=Instance.new('Part') ring.Name='OR_ShockRing' ring.Shape=Enum.PartType.Ball ring.Size=Vector3.new(2,2,2) ring.Anchored=true ring.CanCollide=false ring.Material=Enum.Material.Neon ring.Color=" + cc(a.color, [120, 200, 255]) + " ring.Transparency=0.2 ring.Position=pos ring.Parent=Workspace\n" +
      "local t=0 local secs=0.6\n" +
      "while t<secs do t+=task.wait(1/40) ring.Size=Vector3.new((2+r*(t/secs)*2),0.6,(2+r*(t/secs)*2)) ring.Transparency=0.2+(t/secs)*0.8 end\n" +
      "ring:Destroy()\n" +
      "return ok({radius=r},'shockwave ring')";
  };
  B.fx_aura = function (a) {
    return "local pl=findPlayer(" + q(a.player || "") + ") if not pl then return fail('player not found') end\n" +
      "local c=charOf(pl) if not c then return fail('no character') end\n" +
      "local hrp=c:FindFirstChild('HumanoidRootPart') if not hrp then return fail('no HRP') end\n" +
      "local old=hrp:FindFirstChild('OR_Aura') if old then old:Destroy() end\n" +
      "local pe=Instance.new('ParticleEmitter') pe.Name='OR_Aura' pe.Parent=hrp\n" +
      "pe.Rate=24 pe.Lifetime=NumberRange.new(0.8,1.4) pe.Speed=NumberRange.new(0.5,1.5) pe.SpreadAngle=Vector2.new(180,180) pe.Acceleration=Vector3.new(0,-2,0) pe.ParticleColor=ColorSequence.new((" + cc(a.color, [120, 200, 255]) + ").Color:ToRGB()) pe.Size=NumberSequence.new(0.15,0.02) pe.Transparency=NumberSequence.new(0.1,1) pe.LightEmission=0.8\n" +
      "task.delay(" + nn(a.seconds, 10) + ",function() if pe.Parent then pe:Destroy() end end)\n" +
      "return ok({seconds=" + nn(a.seconds, 10) + "},'aura on character')";
  };
  B.fx_magic_circle = function (a) {
    return "local p=partOf(resolve(" + q(a.path || a.part || "") + "))\n" +
      "local pos=if p then p.Position else " + vv(a.position || a.point, [0, 1, 0]) + "\n" +
      "local r=" + nn(a.radius, 8) + " local parent=p or Workspace\n" +
      "local group=Instance.new('Folder') group.Name='OR_MagicCircle' group.Parent=parent\n" +
      "local n=8 for i=1,n do local beam=Instance.new('Beam') local a0=math.rad(i*45) local a1=math.rad((i+1)*45) local p0=Vector3.new(math.cos(a0)*r,0,math.sin(a0)*r) local p1=Vector3.new(math.cos(a1)*r,0,math.sin(a1)*r) local att0=Instance.new('Attachment') att0.Parent=group att0.Position=p0 local att1=Instance.new('Attachment') att1.Parent=group att1.Position=p1 beam.Attachment0=att0 beam.Attachment1=att1 beam.Width0=0.25 beam.Width1=0.25 beam.Color=ColorSequence.new(" + cc(a.color, [140, 100, 255]) + ") beam.FaceCamera=false beam.Parent=group end\n" +
      "local pe=Instance.new('ParticleEmitter') local host=Instance.new('Part') host.Name='host' host.Anchored=true host.CanCollide=false host.Transparency=1 host.Size=Vector3.new(0.5,0.5,0.5) host.Parent=group host.CFrame=CFrame.new(pos) pe.Parent=host pe.Rate=18 pe.Lifetime=NumberRange.new(1,2) pe.Speed=NumberRange.new(1,3) pe.SpreadAngle=Vector2.new(180,180) pe.Acceleration=Vector3.new(0,3,0) pe.Color=ColorSequence.new(" + cc(a.color, [140, 100, 255]) + ") pe.Size=NumberSequence.new(0.1,0.01) pe.LightEmission=0.9\n" +
      "task.delay(" + nn(a.seconds, 15) + ",function() if group.Parent then group:Destroy() end end)\n" +
      "return ok({beams=n,radius=r},'magic circle running')";
  };
  B.fx_lightning = function (a) {
    return "local pos=" + vv(a.position || a.point, [0, 30, 0]) + "\n" +
      "local top=Vector3.new(pos.X,pos.Y+40,pos.Z)\n" +
      "local beam=Instance.new('Beam')\n" +
      "local g=Instance.new('Folder') g.Name='OR_Bolt' g.Parent=Workspace\n" +
      "local a0=Instance.new('Attachment') a0.Parent=g a0.WorldPosition=top local a1=Instance.new('Attachment') a1.Parent=g a1.WorldPosition=pos\n" +
      "beam.Attachment0=a0 beam.Attachment1=a1 beam.Width0=0.6 beam.Width1=0.25 beam.Color=ColorSequence.new(Color3.new(1,1,1)) beam.FaceCamera=true beam.Parent=g\n" +
      "local flash=Instance.new('PointLight') flash.Color=Color3.fromRGB(200,210,255) flash.Brightness=30 flash.Range=200 flash.Position=pos+Vector3.new(0,10,0) flash.Parent=Workspace\n" +
      "task.wait(0.12)\n" +
      "g:Destroy() flash:Destroy()\n" +
      "return ok({strike=tostring(pos)},'lightning strike')";
  };
  B.fx_trails_clear = function (a) {
    var scope = a.path ? "resolve(" + q(a.path) + ") or Workspace" : "Workspace";
    return "local root=" + scope + "\n" +
      "local n=0 for _,d in ipairs(root:GetDescendants()) do if d:IsA('Trail') then d:Destroy() n+=1 end end\n" +
      "return ok({removed=n},'trails cleared')";
  };
  B.fx_emitters_clear = function (a) {
    var scope = a.path ? "resolve(" + q(a.path) + ") or Workspace" : "Workspace";
    return "local root=" + scope + "\n" +
      "local n=0 for _,d in ipairs(root:GetDescendants()) do if d:IsA('ParticleEmitter') then d:Destroy() n+=1 end end\n" +
      "return ok({removed=n},'particle emitters cleared')";
  };
  B.fx_burst = function (a) {
    var kind = String(a.kind || "fire").toLowerCase();
    var colors = { fire: "255,140,40", ice: "140,220,255", electric: "120,160,255", spark: "255,200,80", poison: "120,255,80" }[kind] || "255,140,40";
    return emitterAt(a, "local pe=Instance.new('ParticleEmitter') pe.Name='Burst' pe.Parent=host\n" +
      "pe.Lifetime=NumberRange.new(0.4,1) pe.Rate=0 pe.BurstCount=" + nn(a.count, 40) + " pe.Speed=NumberRange.new(6,20) pe.SpreadAngle=Vector2.new(180,180) pe.Acceleration=Vector3.new(0,-10,0) pe.ParticleColor=ColorSequence.new(Color3.fromRGB(" + colors + ")) pe.Size=NumberSequence.new(0.3,0.05) pe.Transparency=NumberSequence.new(0,1) pe.LightEmission=1");
  };

  // ── K. Terrain, world & place (11) ────────────────────────────────────
  function terraMat(a) {
    var m = { grass: "Grass", rock: "Rock", sand: "Sand", water: "Water", snow: "Snow", mud: "Mud", ice: "Ice", basalt: "Basalt", lava: "Lava", leafygrass: "LeafyGrass", ground: "Ground" }[String(a.material || "rock").toLowerCase()];
    return m || "Rock";
  }
  B.terrain_height = function (a) {
    var m = terraMat(a);
    return "local pos=" + vv(a.position) + " local h=" + nn(a.height, 10) + " local sz=" + vv(a.size, [8, 8, 8]) + "\n" +
      "local terr=Workspace.Terrain\n" +
      "local region=Region3.new(pos+Vector3.new(-sz.X/2,h-12,-sz.Z/2),pos+Vector3.new(sz.X/2,h,sz.Z/2))\n" +
      "pcall(function() terr:FillBlocks(region,Enum.Material." + m + ",BrickColor.new('dark stone gray')) end)\n" +
      "return ok({position=" + vv(a.position) + ",topHeight=" + nn(a.height, 10) + ",material='" + m + "'},'terrain raised')";
  };
  B.terrain_clear_region = function (a) {
    return "local from=" + vv(a["from"]) + " local to=" + vv(a.to) + "\n" +
      "local region=Region3.new(from,to)\n" +
      "local terr=Workspace.Terrain pcall(function() terr:Clear(region) end)\n" +
      "return ok({},'terrain region cleared')";
  };
  B.terrain_lava = function (a) {
    return "local pos=" + vv(a.position, [0, 0, 0]) + " local sz=" + vv(a.size, [16, 2, 16]) + "\n" +
      "local terr=Workspace.Terrain local region=Region3.new(pos-sz/2+Vector3.new(0,1,0),pos+sz/2)\n" +
      "pcall(function() terr:FillBlocks(region,Enum.Material.Lava,BrickColor.new('reddish brown')) end)\n" +
      "return ok({position=" + vv(a.position, [0, 0, 0]) + "},'lava pool poured')";
  };
  B.terrain_paint = function (a) {
    var m = { grass: "Grass", rock: "Rock", sand: "Sand", water: "Water", snow: "Snow", mud: "Mud", ice: "Ice", basalt: "Basalt", lava: "Lava", leafygrass: "LeafyGrass", ground: "Ground" }[String(a.material || "grass").toLowerCase()] || "Grass";
    return "local pos=" + vv(a.position, [0, 1, 0]) + " local sz=" + vv(a.size, [10, 2, 10]) + "\n" +
      "local terr=Workspace.Terrain local region=Region3.new(pos-sz/2,pos+sz/2)\n" +
      "pcall(function() terr:FillBlocks(region,Enum.Material." + m + ",BrickColor.new('brown')) end)\n" +
      "return ok({material='" + m + "'},'terrain painted')";
  };
  B.boundary_set = function (a) {
    return "Workspace.BoundsMin=Vector3.new(-" + nn(a.size, 500) + ",-50,-" + nn(a.size, 500) + ")\n" +
      "Workspace.BoundsMax=Vector3.new(" + nn(a.size, 500) + ",200," + nn(a.size, 500) + ")\n" +
      "return ok({size=" + nn(a.size, 500) + "},'workspace boundary set')";
  };
  B.ground_make = function (a) {
    return "local pos=" + vv(a.position, [0, 0, 0]) + " local sz=" + vv(a.size, [100, 1, 100]) + "\n" +
      "local g=Instance.new('Part') g.Name='OR_Ground' g.Size=sz g.Position=pos g.Anchored=true g.Material=Enum.Material." + (function () { var m = { grass: "Grass", sand: "Sand", rock: "Rock", concrete: "Concrete", wood: "Wood" }[String(a.material || "grass").toLowerCase()]; return m || "Grass"; })() + " g.Color=" + cc(a.color, [90, 140, 80]) + " g.TopSurface=Enum.SurfaceType.Smooth g.Parent=Workspace\n" +
      "return ok({path=g:GetFullName()},'ground created')";
  };
  B.place_info = function (a) {
    return "local okc,universe=pcall(function() return game:GetService('GamePassService') and game.PlaceId end)\n" +
      "return ok({placeId=game.PlaceId,jobId=game.JobId,name=game.Name,version=game.PlaceVersion},'place info')";
  };
  B.place_rename = function (a) {
    return "local okc,err=pcall(function() game.Name=" + q(a.name || "") + " end)\n" +
      "if not okc then return fail('cannot rename in this context: ' + tostring(err)) end\n" +
      "return ok({name=game.Name},'place renamed (save to persist)')";
  };
  B.workspace_clear = function (a) {
    return "local n=#Workspace:GetChildren()\n" +
      "for _,c in ipairs(Workspace:GetChildren()) do if not c:IsA('Terrain') and c.Name~='Camera' then c:Destroy() end end\n" +
      "return ok({removed=n},'workspace cleared (terrain + camera kept)')";
  };
  B.workspace_export = function (a) {
    return "local function dump(i,depth) local d={name=i.Name,class=i.ClassName} if depth<6 then d.children={} for _,c in ipairs(i:GetChildren()) do d.children[#d.children+1]=dump(c,depth+1) end end if i:IsA('BasePart') then d.pos={i.Position.x,i.Position.y,i.Position.z} d.size={i.Size.x,i.Size.y,i.Size.z} end return d end\n" +
      "local data=dump(Workspace,0)\n" +
      "local json=HttpService:JSONEncode(data)\n" +
      "local old=ReplicatedStorage:FindFirstChild('OR_Export') if old then old:Destroy() end\n" +
      "local v=Instance.new('StringValue') v.Name='OR_Export' v.Value=json v.Parent=ReplicatedStorage\n" +
      "return ok({bytes=#json},'workspace exported to ReplicatedStorage.OR_Export ('..#json..' bytes)')";
  };
  B.workspace_import = function (a) {
    return "local v=ReplicatedStorage:FindFirstChild('OR_Export') if not v then return fail('no export found (run workspace_export first)') end\n" +
      "local okc,data=pcall(function() return HttpService:JSONDecode(v.Value) end)\n" +
      "if not okc then return fail('export corrupt: ' + tostring(data)) end\n" +
      "local function build(d,parent) local i=Instance.new(d.class or 'Folder') i.Name=d.name or d.class or 'Item' i.Parent=parent if d.pos and i:IsA('BasePart') then i.Position=Vector3.new(d.pos[1],d.pos[2],d.pos[3]) end if d.size and i:IsA('BasePart') then i.Size=Vector3.new(d.size[1],d.size[2],d.size[3]) end if d.children then for _,c in ipairs(d.children) do build(c,i) end end return i end\n" +
      "local count=0 local function countTree(d) count+=1 if d.children then for _,c in ipairs(d.children) do countTree(c) end end end countTree(data)\n" +
      "local m=Instance.new('Model') m.Name='OR_Restore' m.Parent=Workspace build(data,m)\n" +
      "return ok({instances=count},'workspace restored into ' .. m:GetFullName())";
  };

  // ── L. Scripts & diagnostics (10) ─────────────────────────────────────
  B.script_create = function (a) {
    var kind = { server: "Script", client: "LocalScript", module: "ModuleScript", localscript: "LocalScript" }[String(a.kind || "server").toLowerCase()] || "Script";
    return "local parent=resolve(" + q(a.parent || (kind === "Script" ? "ServerScriptService" : kind === "ModuleScript" ? "ServerStorage" : "StarterPlayer.StarterPlayerScripts")) + ") or " + (kind === "Script" ? "ServerScriptService" : kind === "ModuleScript" ? "ServerStorage" : "StarterPlayer:FindFirstChild('StarterPlayerScripts') or StarterPlayer") + "\n" +
      "local s=mkScript('" + kind + "'," + q(a.name || "OR_Script") + ",parent," + q(a.source || "") + ")\n" +
      "return ok({path=s:GetFullName(),kind='" + kind + "'},'script created')";
  };
  B.script_module = function (a) {
    return "local parent=ServerStorage:FindFirstChild('OR_Modules') or Instance.new('Folder') parent.Name='OR_Modules' parent.Parent=ServerStorage\n" +
      "local m=mkScript('ModuleScript'," + q(a.name || "OR_Module") + ",parent," + q(a.source || "local M={} return M") + ")\n" +
      "return ok({path=m:GetFullName(),require='local " + (a.name || "OR_Module") + "=require(ServerStorage.OR_Modules." + (a.name || "OR_Module") + ")'},'module created')";
  };
  B.script_reload = function (a) {
    return "local s=resolve(" + q(a.path || "") + ") if not s then return fail('script not found') end\n" +
      "if not s:IsA('BaseScript') then return fail('not a script') end\n" +
      "s.Disabled=true task.wait(0.2) s.Disabled=false\n" +
      "return ok({path=s:GetFullName()},'script reloaded')";
  };
  B.script_grep = function (a) {
    return "local needle=" + q(String(a.text || a.query || "").toLowerCase()) + "\n" +
      "local root=resolve(" + q(a.path || "game") + ") or game\n" +
      "local hits={} for _,d in ipairs(root:GetDescendants()) do if d:IsA('LuaSourceContainer') and d.Source:lower():find(needle,1,true) then hits[#hits+1]=d:GetFullName() if #hits>=20 then break end end end\n" +
      "if #hits==0 then return fail('no scripts contain ' + '" + String(a.text || a.query || "") + "') end\n" +
      "return ok({count=#hits,items=hits},'grep hits')";
  };
  B.script_stats = function (a) {
    return "local total=0 local lines=0 local out={} for _,d in ipairs(game:GetDescendants()) do if d:IsA('LuaSourceContainer') then total+=1 lines+=#(string.split(d.Source,'\\n')) out[#out+1]=d:GetFullName()..' ('..#d.Source..' chars)' if #out>=25 then break end end end\n" +
      "return ok({scripts=total,totalLines=lines,items=out},'script stats')";
  };
  B.api_request = function (a) {
    var url = q(a.url || a.endpoint || "");
    var method = q(String(a.method || "GET").toUpperCase());
    var body = q(typeof a.body === "object" ? JSON.stringify(a.body) : String(a.body || ""));
    return "local hs=game:GetService('HttpService')\n" +
      "local url=" + url + " local method=" + method + " local body=" + body + "\n" +
      "if url=='' then return fail('url required') end\n" +
      "local okreq,res=pcall(function() return hs:RequestAsync({Url=url,Method=method,Headers={['Content-Type']='application/json'},Body=body~='' and body or nil}) end)\n" +
      "if not okreq then return fail('Web API request failed: ' + tostring(res)) end\n" +
      "local dec; pcall(function() dec=hs:JSONDecode(res.Body) end)\n" +
      "return ok({status=res.StatusCode,data=dec,body=res.Body:sub(1,4000)},'Web API ' .. method .. ' ' .. tostring(res.StatusCode))";
  };
  B.web_api = B.api_request;
  B.api_json_get = function (a) {
    return B.api_request({ url: a.url, method: "GET", headers: a.headers });
  };
  B.api_json_post = function (a) {
    return B.api_request({ url: a.url, method: "POST", body: a.body, headers: a.headers });
  };
  B.script_check = function (a) {
    return "local src=" + q(a.source || a.path ? (a.source != null ? a.source : "") : "") + "\n" +
      "if src=='' then local p=resolve(" + q(a.path || "") + ") if not p or not p:IsA('LuaSourceContainer') then return fail('pass source: or path: of an existing script') end src=p.Source end\n" +
      "local okc,err=pcall(function() local f=loadstring(src) return f end)\n" +
      "if not okc then return fail('COMPILE ERROR: ' + tostring(err)) end\n" +
      "return ok({chars=#src},'source compiles clean')";
  };
  B.log_tag = function (a) {
    var tag = String(a.tag || "OR").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "OR";
    var src = "local realprint = print\nprint = function(...) realprint('[" + tag + "]', ...) end\nwarn('[" + tag + "] console tag active')";
    return "local old=ServerScriptService:FindFirstChild('OR_LogTag') if old then old:Destroy() end\n" +
      "local s=mkScript('Script','OR_LogTag',ServerScriptService," + q(src) + ")\n" +
      "return ok({tag='" + tag + "',path=s:GetFullName()},'server output will be prefixed with [" + tag + "] at play time (ServerScriptService.OR_LogTag)')";
  };
  B.game_stats = function (a) {
    return "local parts=0 for _,d in ipairs(Workspace:GetDescendants()) do if d:IsA('BasePart') then parts+=1 end end\n" +
      "return ok({players=#Players:GetPlayers(),parts=parts,placeId=game.PlaceId,clockTime=Lighting.ClockTime},'game stats')";
  };
  B.gc_run = function (a) {
    return "local before=collectgarbage('count')\n" +
      "collectgarbage('collect') task.wait(0.2) collectgarbage('collect')\n" +
      "local after=collectgarbage('count')\n" +
      "return ok({freedKB=math.floor((before-after)/1),remainingKB=math.floor(after)},'garbage collected')";
  };
  B.memory_get = function (a) {
    return "local kb=collectgarbage('count')\n" +
      "return ok({luaMB=math.floor(kb/102.4)/10},'Lua memory in use')";
  };

  const C = [
    { name: "api_request", description: "Perform any REST / Web API call (GET, POST, PUT, DELETE, PATCH) with custom JSON payload and HTTP headers.", params: { url: { type: "string", req: true, desc: "full https API URL" }, method: { type: "string", req: false, desc: "GET|POST|PUT|DELETE|PATCH" }, body: { type: "json", req: false, desc: "JSON body object or string" }, headers: { type: "json", req: false, desc: "HTTP headers object" } } },
    { name: "web_api", description: "Perform any REST / Web API call (GET, POST, PUT, DELETE, PATCH) with custom payload.", params: { url: { type: "string", req: true, desc: "full https API URL" }, method: { type: "string", req: false, desc: "GET|POST|PUT|DELETE|PATCH" }, body: { type: "json", req: false, desc: "JSON body object" } } },
    { name: "api_json_get", description: "Fetch data from a JSON REST API endpoint (GET) and return parsed JSON data.", params: { url: { type: "string", req: true, desc: "JSON API endpoint URL" }, headers: { type: "json", req: false, desc: "custom headers" } } },
    { name: "api_json_post", description: "Send JSON payload to a REST API endpoint (POST) and return response data.", params: { url: { type: "string", req: true, desc: "JSON API endpoint URL" }, body: { type: "json", req: true, desc: "JSON payload object" }, headers: { type: "json", req: false, desc: "custom headers" } } },
    { name: "instance_new", description: "Create a new Roblox instance (Part, Model, Folder, Script, SurfaceGui...) and parent it.", params: { class: { type: "string", req: false, desc: "class name, e.g. Part" }, name: { type: "string", req: false}, parent: { type: "string", req: false, desc: "parent path, default Workspace" } } },
    { name: "instance_descendants", description: "List full paths of descendants under a path (up to limit).", params: { path: { type: "string", req: false}, limit: { type: "number", req: false} } },
    { name: "instance_find", description: "Find instances by exact Name under a path (default Workspace).", params: { name: { type: "string", req: false, desc: "exact Name to match" }, path: { type: "string", req: false} } },
    { name: "instance_find_class", description: "Find instances of a class (Part, Tool, Sound, ScreenGui...) under a path.", params: { class: { type: "string", req: false}, path: { type: "string", req: false}, limit: { type: "number", req: false} } },
    { name: "instance_count", description: "Count instances of a class (or everything) under a path.", params: { class: { type: "string", req: false, desc: "empty = all" }, path: { type: "string", req: false} } },
    { name: "instance_ancestors", description: "List the ancestor chain (parent paths) of an instance up to game.", params: { path: { type: "string", req: true} } },
    { name: "instance_is_ancestor", description: "Check whether instance a is an ancestor of instance b.", params: { a: { type: "string", req: true, desc: "ancestor path" }, b: { type: "string", req: true, desc: "descendant path" } } },
    { name: "property_copy", description: "Copy property values from one instance to another.", params: { from: { type: "string", req: true, desc: "source path" }, to: { type: "string", req: true, desc: "target path" }, names: { type: "array", req: true, desc: "list of property names to copy" } } },
    { name: "instance_look_at", description: "Rotate a part so it faces another instance (CFrame.lookAt).", params: { path: { type: "string", req: true, desc: "part to rotate" }, target: { type: "string", req: true, desc: "instance to face" } } },
    { name: "instance_bounding_box", description: "Get min/max corners and overall size of an instance's bounding box.", params: { path: { type: "string", req: true} } },
    { name: "instance_surface_area", description: "Total SurfaceArea (studs^2) of all BaseParts inside an instance.", params: { path: { type: "string", req: true} } },
    { name: "instance_mass_get", description: "Total Mass (kg) of all BaseParts inside an instance.", params: { path: { type: "string", req: true} } },
    { name: "distance_measure", description: "Distance in studs between two instances (center to center).", params: { a: { type: "string", req: true}, b: { type: "string", req: true} } },
    { name: "part_at", description: "First BasePart at a world position (point occupancy query).", params: { position: { type: "array", req: true, desc: "[x,y,z]" } } },
    { name: "part_above", description: "First BasePart above a world position (ground check).", params: { position: { type: "array", req: true, desc: "[x,y,z]" } } },
    { name: "nearest_part", description: "Nearest BasePart to a world position, optionally of a class.", params: { position: { type: "array", req: true, desc: "[x,y,z]" }, class: { type: "string", req: false} } },
    { name: "overlap_box", description: "List BaseParts inside a box (position = center, size = extent).", params: { position: { type: "array", req: true, desc: "center [x,y,z]" }, size: { type: "array", req: true, desc: "extent [x,y,z]" } } },
    { name: "overlap_sphere", description: "List BaseParts inside a sphere (position = center).", params: { position: { type: "array", req: true, desc: "center [x,y,z]" }, radius: { type: "number", req: false} } },
    { name: "raycast_do", description: "Raycast from the camera toward a point; returns hit part, position, normal.", params: { to: { type: "array", req: true, desc: "end [x,y,z]" }, blacklist: { type: "array", req: false, desc: "paths to ignore" } } },
    { name: "swept_ray", description: "Swept ray from the camera toward a point (thick beam, returns hits).", params: { to: { type: "array", req: true, desc: "end [x,y,z]" }, radius: { type: "number", req: false} } },
    { name: "grid_clone", description: "Clone an instance into a rows x cols grid of copies.", params: { path: { type: "string", req: true}, rows: { type: "number", req: false}, cols: { type: "number", req: false}, spacing: { type: "number", req: false, desc: "studs between copies" } } },
    { name: "mirror_model", description: "Mirror an instance across its X or Z axis.", params: { path: { type: "string", req: true}, axis: { type: "string", req: false, desc: "x or z" } } },
    { name: "rotate_model", description: "Rotate an instance around its pivot by degrees.", params: { path: { type: "string", req: true}, degrees: { type: "number", req: false}, axis: { type: "string", req: false, desc: "x|y|z" } } },
    { name: "flatten_model", description: "Lay all parts of an instance flat at their base Y (floor layout).", params: { path: { type: "string", req: true} } },
    { name: "raise_model", description: "Raise all parts of an instance to a target Y height.", params: { path: { type: "string", req: true}, height: { type: "number", req: false} } },
    { name: "workspace_stats", description: "Workspace inventory: part/model counts by class + totals.", params: {} },
    { name: "tree_outline", description: "Compact name:class tree outline of an instance hierarchy.", params: { path: { type: "string", req: false} } },
    { name: "physics_impulse", description: "Apply an instant impulse (Vector3) to a part.", params: { path: { type: "string", req: true}, impulse: { type: "array", req: true, desc: "[x,y,z]" } } },
    { name: "physics_force", description: "Push a part with a force (Vector3) for N seconds.", params: { path: { type: "string", req: true}, force: { type: "array", req: true, desc: "[x,y,z]" }, seconds: { type: "number", req: false} } },
    { name: "physics_torque", description: "Apply a torque (Vector3) to spin a part.", params: { path: { type: "string", req: true}, torque: { type: "array", req: true, desc: "[x,y,z]" } } },
    { name: "physics_mass_set", description: "Set a part's Mass (kg).", params: { path: { type: "string", req: true}, mass: { type: "number", req: true} } },
    { name: "physics_density_set", description: "Set a part's Density.", params: { path: { type: "string", req: true}, density: { type: "number", req: true} } },
    { name: "physics_friction_set", description: "Set a part's Friction (0-10).", params: { path: { type: "string", req: true}, friction: { type: "number", req: true} } },
    { name: "physics_elasticity_set", description: "Set a part's Elasticity / bounce (0-1).", params: { path: { type: "string", req: true}, elasticity: { type: "number", req: true} } },
    { name: "physics_velocity_set", description: "Set a part's Velocity (Vector3 studs/s, part-relative).", params: { path: { type: "string", req: true}, velocity: { type: "array", req: true, desc: "[x,y,z]" } } },
    { name: "physics_linear_set", description: "Set a part's LinearVelocity (world-relative studs/s).", params: { path: { type: "string", req: true}, velocity: { type: "array", req: true, desc: "[x,y,z]" } } },
    { name: "physics_angular_set", description: "Set a part's AngularVelocity (radians/s).", params: { path: { type: "string", req: true}, velocity: { type: "array", req: true, desc: "[x,y,z]" } } },
    { name: "physics_pivot_set", description: "Move a part's Pivot to a world position.", params: { path: { type: "string", req: true}, position: { type: "array", req: true, desc: "[x,y,z]" } } },
    { name: "physics_root_set", description: "Point a model's HumanoidRootPart at a specific part.", params: { path: { type: "string", req: true, desc: "model" }, root_part: { type: "string", req: true, desc: "part path" } } },
    { name: "physics_anchor_all", description: "Anchor or unanchor every BasePart under a path.", params: { path: { type: "string", req: false}, anchored: { type: "boolean", req: false, desc: "true=anchor, false=free" } } },
    { name: "physics_lock", description: "Anchor a part and zero its velocity (fully stop it).", params: { path: { type: "string", req: true} } },
    { name: "constraints_clear", description: "Remove all Motor6D/Weld/constraint children from a model or part.", params: { path: { type: "string", req: true} } },
    { name: "constraint_create", description: "Create a constraint between two parts: weld, motor6d, hinge, pivot, ball, prismatic.", params: { part0: { type: "string", req: true}, part1: { type: "string", req: true}, type: { type: "string", req: false, desc: "weld|motor6d|hinge|pivot|ball|prismatic" } } },
    { name: "motor6d_set", description: "Tune a Motor6D: motor speed/force and U0-U2 limits.", params: { path: { type: "string", req: true, desc: "Motor6D path" }, motor: { type: "number", req: false, desc: "DesiredVelocity rad/s" }, motor_force: { type: "number", req: false, desc: "MaxMotorForce" }, u0: { type: "boolean", req: false}, u1: { type: "boolean", req: false}, u2: { type: "boolean", req: false}, limits: { type: "boolean", req: false, desc: "true=apply u0-u2" } } },
    { name: "physics_parts_on_ray", description: "List BaseParts intersecting a line from 'from' to 'to' (swept sphere).", params: { from: { type: "array", req: false, desc: "start [x,y,z]" }, to: { type: "array", req: true, desc: "end [x,y,z]" }, radius: { type: "number", req: false} } },
    { name: "spring_adjust", description: "Tune a SpringConstraint: Length and Rigidness.", params: { path: { type: "string", req: true}, length: { type: "number", req: false}, rigidness: { type: "number", req: false} } },
    { name: "trampoline_set", description: "Set a part's TrampolineForce (jump pad power).", params: { path: { type: "string", req: true}, force: { type: "number", req: false} } },
    { name: "float_part", description: "Make a part hover at a world Y height (LinearVelocity float).", params: { path: { type: "string", req: true}, height: { type: "number", req: false} } },
    { name: "physics_zero", description: "Zero a part's velocity and angular velocity (stop it dead).", params: { path: { type: "string", req: true} } },
    { name: "players_list", description: "List all players: name, UserId, character path.", params: {} },
    { name: "player_find", description: "Find a player by name or UserId; returns character + humanoid info.", params: { player: { type: "string", req: false, desc: "name or user id" }, name: { type: "string", req: false}, id: { type: "string", req: false} } },
    { name: "player_count", description: "Number of players currently in the game.", params: {} },
    { name: "player_kill", description: "Kill a player's character (Health=0); it respawns normally.", params: { player: { type: "string", req: false} } },
    { name: "player_heal", description: "Fully heal a player's Humanoid.", params: { player: { type: "string", req: false} } },
    { name: "player_damage", description: "Deal damage to a player's Humanoid.", params: { player: { type: "string", req: false}, amount: { type: "number", req: true} } },
    { name: "player_max_health", description: "Set a player's Humanoid MaxHealth (heals to it).", params: { player: { type: "string", req: false}, health: { type: "number", req: false} } },
    { name: "player_godmode", description: "Toggle a player's god mode (infinite health / no fall damage).", params: { player: { type: "string", req: false}, on: { type: "boolean", req: false} } },
    { name: "player_kick", description: "Kick a player from the game with a reason message.", params: { player: { type: "string", req: true}, reason: { type: "string", req: false} } },
    { name: "player_rename", description: "Set a player's DisplayName for this session.", params: { player: { type: "string", req: false}, displayname: { type: "string", req: true} } },
    { name: "player_teleport", description: "Teleport a player's character to a world position.", params: { player: { type: "string", req: false}, position: { type: "array", req: true, desc: "[x,y,z]" } } },
    { name: "player_climb", description: "Set a player's ClimbSpeed (wall/ledge climbing power).", params: { player: { type: "string", req: false}, speed: { type: "number", req: false} } },
    { name: "player_swim", description: "Set a player's SwimSpeed.", params: { player: { type: "string", req: false}, speed: { type: "number", req: false} } },
    { name: "humanoid_list", description: "List all Humanoids: owner, health, walk speed, position.", params: {} },
    { name: "ragdoll_make", description: "Ragdoll a character: joints become BallSockets (physics tumble).", params: { player: { type: "string", req: false}, path: { type: "string", req: false, desc: "character path instead of player" } } },
    { name: "ragdoll_restore", description: "Restore a ragdolled character's joints.", params: { player: { type: "string", req: false}, path: { type: "string", req: false} } },
    { name: "tools_list", description: "List Tools in a player's Backpack and character.", params: { player: { type: "string", req: false} } },
    { name: "tool_equip", description: "Give a player a Tool (by StarterPack name or path) and equip it.", params: { player: { type: "string", req: false}, name: { type: "string", req: false, desc: "tool name" }, tool: { type: "string", req: false}, path: { type: "string", req: false} } },
    { name: "tool_strip", description: "Remove all Tools from a player's Backpack and character.", params: { player: { type: "string", req: false} } },
    { name: "head_position", description: "World position of a player's Head.", params: { player: { type: "string", req: false} } },
    { name: "player_attr", description: "Get or set an Attribute on a player (omit value to read).", params: { player: { type: "string", req: false}, key: { type: "string", req: true}, value: { type: "string", req: false} } },
    { name: "respawn_player", description: "Force-respawn a player's character.", params: { player: { type: "string", req: false} } },
    { name: "remote_function_create", description: "Create a RemoteFunction in ReplicatedStorage (or a folder).", params: { name: { type: "string", req: true}, parent: { type: "string", req: false} } },
    { name: "remote_folder", description: "Create a folder in ReplicatedStorage pre-filled with RemoteEvents.", params: { name: { type: "string", req: true}, events: { type: "number", req: false, desc: "how many RemoteEvents to seed" } } },
    { name: "remotes_list", description: "List every RemoteEvent/RemoteFunction in ReplicatedStorage.", params: {} },
    { name: "remote_fire", description: "Fire a RemoteEvent with a string payload (to a player if known, else FireServer).", params: { name: { type: "string", req: true, desc: "remote name or path" }, payload: { type: "string", req: false}, player: { type: "string", req: false} } },
    { name: "remote_handler", description: "Wire a server script reacting to a RemoteEvent: echo back, print, or count fires.", params: { name: { type: "string", req: true, desc: "RemoteEvent name" }, behavior: { type: "string", req: false, desc: "echo|print|count" } } },
    { name: "bindable_event_create", description: "Create a BindableEvent in ServerStorage.", params: { name: { type: "string", req: true} } },
    { name: "bindable_function_create", description: "Create a BindableFunction in ServerStorage.", params: { name: { type: "string", req: true} } },
    { name: "replicated_first", description: "Create a ReplicatedFirst server script (runs before all other server scripts).", params: { name: { type: "string", req: false}, source: { type: "string", req: false, desc: "Lua source" } } },
    { name: "network_ping", description: "Ping of every player (sorted).", params: {} },
    { name: "network_owner", description: "Set NetworkOwner of a model's parts to a player (client physics).", params: { path: { type: "string", req: true}, player: { type: "string", req: true} } },
    { name: "chat_say", description: "Send a chat message as the local player.", params: { text: { type: "string", req: true} } },
    { name: "chat_announce", description: "Broadcast a colored announcement to everyone for N seconds.", params: { text: { type: "string", req: true}, color: { type: "array", req: false}, seconds: { type: "number", req: false} } },
    { name: "leaderstats_add", description: "Create a leaderstats folder + stat for the local player.", params: { stat: { type: "string", req: true, desc: "stat name, e.g. Coins" } } },
    { name: "leaderstats_set", description: "Set a value in a player's leaderstats.", params: { player: { type: "string", req: false}, stat: { type: "string", req: true}, value: { type: "number", req: true} } },
    { name: "premium_check", description: "Is the player Roblox Premium?", params: { player: { type: "string", req: false} } },
    { name: "gamepass_check", description: "Does the player own a game pass? (UserOwnsGamePassAsync)", params: { player: { type: "string", req: false}, passid: { type: "number", req: true} } },
    { name: "ds_get", description: "DataStore GetAsync: read a value by key (pcall-safe).", params: { key: { type: "string", req: true}, store: { type: "string", req: false} } },
    { name: "ds_set", description: "DataStore SetAsync: write a value by key.", params: { key: { type: "string", req: true}, value: { type: "string", req: true}, store: { type: "string", req: false} } },
    { name: "ds_update", description: "DataStore UpdateAsync: atomically read-modify-write a numeric key.", params: { key: { type: "string", req: true}, delta: { type: "number", req: false}, store: { type: "string", req: false} } },
    { name: "ds_remove", description: "DataStore RemoveAsync: delete a key.", params: { key: { type: "string", req: true}, store: { type: "string", req: false} } },
    { name: "ds_get_many", description: "DataStore GetAsync for several keys at once.", params: { keys: { type: "array", req: true}, store: { type: "string", req: false} } },
    { name: "ds_set_many", description: "DataStore SetAsync a whole {key=value} table.", params: { pairs: { type: "array", req: true}, store: { type: "string", req: false} } },
    { name: "ds_incr", description: "Increment a DataStore counter (UpdateAsync +delta).", params: { key: { type: "string", req: true}, delta: { type: "number", req: false}, store: { type: "string", req: false} } },
    { name: "ds_sorted", description: "OrderedDataStore GetSortedAsync (leaderboard read).", params: { store: { type: "string", req: false}, limit: { type: "number", req: false}, ascending: { type: "boolean", req: false} } },
    { name: "ds_ping", description: "Touch a DataStore to test connectivity (GetAsync nil).", params: { store: { type: "string", req: false} } },
    { name: "session_lock_acquire", description: "Acquire a SessionLockStore lock (prevents double-join data races).", params: { key: { type: "string", req: true}, store: { type: "string", req: false}, ttl: { type: "number", req: false, desc: "seconds to hold" } } },
    { name: "session_lock_release", description: "Release a SessionLockStore lock.", params: { key: { type: "string", req: true}, store: { type: "string", req: false} } },
    { name: "ordered_set", description: "OrderedDataStore UpdateAsync: set/update a leaderboard score.", params: { key: { type: "string", req: true}, score: { type: "number", req: true}, store: { type: "string", req: false} } },
    { name: "ordered_get", description: "OrderedDataStore GetAsync: read a leaderboard score.", params: { key: { type: "string", req: true}, store: { type: "string", req: false} } },
    { name: "profile_setup", description: "Build a player profile system: leaderstats + attributes + 30s autosave to a DataStore.", params: { fields: { type: "array", req: false, desc: "stat names like Coins, Level" }, store: { type: "string", req: false} } },
    { name: "ds_json_put", description: "Store a JSON string under a DataStore key.", params: { key: { type: "string", req: true}, json: { type: "string", req: true}, store: { type: "string", req: false} } },
    { name: "toast_show", description: "Show a toast popup to the player (auto-hides).", params: { text: { type: "string", req: false}, seconds: { type: "number", req: false} } },
    { name: "dialog_confirm", description: "Modal-style confirm dialog with title and accent color.", params: { text: { type: "string", req: false}, title: { type: "string", req: false}, color: { type: "array", req: false}, seconds: { type: "number", req: false} } },
    { name: "progress_show", description: "Progress bar UI (value 0-1) with a label.", params: { value: { type: "number", req: false, desc: "0..1" }, label: { type: "string", req: false}, color: { type: "array", req: false}, seconds: { type: "number", req: false} } },
    { name: "loading_show", description: "Full-screen loading overlay with text (hide=true removes it).", params: { text: { type: "string", req: false}, hide: { type: "boolean", req: false} } },
    { name: "shop_ui", description: "Shop panel with item buttons; clicks fire a Buy RemoteEvent with the item text.", params: { items: { type: "array", req: false} } },
    { name: "inventory_ui", description: "Inventory slot grid (N slots).", params: { size: { type: "number", req: false, desc: "slot count 1-12" } } },
    { name: "chat_ui", description: "In-game chat feed UI; Send fires a ChatSend RemoteEvent with the message.", params: { color: { type: "array", req: false}, height: { type: "number", req: false} } },
    { name: "tabs_ui", description: "Tab bar UI with named tabs.", params: { tabs: { type: "array", req: true, desc: "tab names" } } },
    { name: "dropdown_ui", description: "Dropdown selector UI with option labels.", params: { title: { type: "string", req: false}, items: { type: "array", req: true, desc: "option labels" } } },
    { name: "slider_ui", description: "Slider UI (min..max) with a label.", params: { label: { type: "string", req: false}, min: { type: "number", req: false}, max: { type: "number", req: false}, value: { type: "number", req: false}, color: { type: "array", req: false}, seconds: { type: "number", req: false} } },
    { name: "toggle_ui", description: "Toggle switch UI with a label (click flips state).", params: { label: { type: "string", req: false}, on: { type: "boolean", req: false}, color: { type: "array", req: false}, seconds: { type: "number", req: false} } },
    { name: "colors_ui", description: "Color swatch picker UI (8 presets).", params: { seconds: { type: "number", req: false} } },
    { name: "tooltip_add", description: "Surface label that appears on the part for 3s when touched.", params: { path: { type: "string", req: true, desc: "part" }, text: { type: "string", req: true} } },
    { name: "tooltip_remove", description: "Remove the OR tooltip from a part.", params: { path: { type: "string", req: true} } },
    { name: "countdown_show", description: "Big on-screen countdown (N..GO) for events.", params: { seconds: { type: "number", req: true}, color: { type: "array", req: false} } },
    { name: "timer_show", description: "On-screen elapsed/remaining timer (mode up counts up, down counts to 0).", params: { seconds: { type: "number", req: false}, mode: { type: "string", req: false, desc: "up|down" } } },
    { name: "waypoint_arrow", description: "Screen arrow that tracks a part (follow-wayfinding marker).", params: { path: { type: "string", req: true, desc: "part to track" }, color: { type: "array", req: false} } },
    { name: "crosshair_set", description: "Custom crosshair at screen center.", params: { color: { type: "array", req: false}, size: { type: "number", req: false} } },
    { name: "fps_counter", description: "Live FPS counter HUD.", params: { on: { type: "boolean", req: false} } },
    { name: "gui_hide_all", description: "Hide all OR_* ScreenGuis created by these tools.", params: {} },
    { name: "gui_show_all", description: "Re-show all OR_* ScreenGuis.", params: {} },
    { name: "input_bind", description: "Bind a key to an action via ContextActionService; firing it triggers <action>_Fired RemoteEvent + print.", params: { key: { type: "string", req: true, desc: "E, Q, R, F, C, V, B, G, H, X, Z, SPACE, LEFTSHIFT" }, action: { type: "string", req: false, desc: "action name" } } },
    { name: "input_unbind", description: "Unbind a ContextActionService action.", params: { action: { type: "string", req: true} } },
    { name: "mouse_pos_get", description: "Current mouse viewport position + world point under the cursor.", params: {} },
    { name: "mouse_region", description: "Is the mouse currently over the part at a path?", params: { path: { type: "string", req: true} } },
    { name: "gamepad_rumble", description: "Rumble the local gamepad (left/right motors, duration).", params: { left: { type: "number", req: false}, right: { type: "number", req: false}, duration: { type: "number", req: false} } },
    { name: "haptics", description: "Fire HapticFeedback for a player (controller vibration).", params: { player: { type: "string", req: false}, type: { type: "string", req: false, desc: "pistol|rifle|heavy" }, duration: { type: "number", req: false} } },
    { name: "camera_type", description: "Set the camera type (Scriptable or Custom).", params: { mode: { type: "string", req: false, desc: "scriptable|custom" } } },
    { name: "camera_fov", description: "Set camera FOV (degrees).", params: { fov: { type: "number", req: true} } },
    { name: "camera_zoom", description: "Zoom the camera FOV in or out by an amount.", params: { amount: { type: "number", req: false}, dir: { type: "string", req: false, desc: "in|out" } } },
    { name: "camera_shake", description: "Shake the camera for N seconds.", params: { seconds: { type: "number", req: false}, strength: { type: "number", req: false} } },
    { name: "camera_reset", description: "Reset the camera to default (Scriptable, FOV 70).", params: {} },
    { name: "tween_cancel", description: "Cancel all active tweens on an instance.", params: { path: { type: "string", req: true} } },
    { name: "tweens_list", description: "List active tweens (optionally for one instance).", params: { path: { type: "string", req: false} } },
    { name: "tween_speed", description: "Set PlaybackSpeed on active tweens (global or one instance).", params: { speed: { type: "number", req: true}, path: { type: "string", req: false} } },
    { name: "screen_shake", description: "Shake a part/model around its position for N seconds.", params: { path: { type: "string", req: true}, seconds: { type: "number", req: false}, strength: { type: "number", req: false} } },
    { name: "snap_to_grid", description: "Snap a part's position to the nearest grid point.", params: { path: { type: "string", req: true}, size: { type: "number", req: false, desc: "grid spacing in studs" } } },
    { name: "fog_set", description: "Set Lighting fog (start distance + fog color).", params: { start: { type: "number", req: false, desc: "FogStart" }, color: { type: "array", req: false} } },
    { name: "ambient_set", description: "Set Lighting ambient brightness + color.", params: { brightness: { type: "number", req: false}, color: { type: "array", req: false} } },
    { name: "exposure_set", description: "Set Lighting.ExposureCompensation (-3..3).", params: { value: { type: "number", req: true} } },
    { name: "film_grain", description: "Film effect: GrainIntensity (0..1).", params: { intensity: { type: "number", req: false} } },
    { name: "film_contrast", description: "Film effect: Contrast (-1..1).", params: { value: { type: "number", req: false} } },
    { name: "film_motion_blur", description: "Film effect: MotionBlurIntensity (0..1).", params: { intensity: { type: "number", req: false} } },
    { name: "light_flicker", description: "Make a light flicker like a candle (random intensity loop).", params: { path: { type: "string", req: false, desc: "light path; default = first PointLight/Part" }, color: { type: "array", req: false} } },
    { name: "light_pulse", description: "Pulse a light's brightness between min and max at a speed.", params: { path: { type: "string", req: false}, min: { type: "number", req: false}, max: { type: "number", req: false}, speed: { type: "number", req: false} } },
    { name: "water_body", description: "Create a flat water volume (Water material) at a position.", params: { position: { type: "array", req: false, desc: "center [x,y,z]" }, size: { type: "array", req: false, desc: "[x,y,z]" }, color: { type: "array", req: false} } },
    { name: "weather_snow", description: "Toggle global snowfall particles.", params: { on: { type: "boolean", req: false} } },
    { name: "weather_rain", description: "Toggle global rain particles.", params: { on: { type: "boolean", req: false} } },
    { name: "weather_storm", description: "Toggle storm: heavy rain + lightning flashes + dark lighting.", params: { on: { type: "boolean", req: false} } },
    { name: "clouds_set", description: "Set sky cloud coverage (Cloudiness) and scroll speed.", params: { density: { type: "number", req: false, desc: "0..1" }, speed: { type: "number", req: false} } },
    { name: "atmosphere_setup", description: "Set Atmosphere: Density, Offset and fog settings.", params: { density: { type: "number", req: false}, offset: { type: "number", req: false}, fog: { type: "number", req: false} } },
    { name: "sun_set_angle", description: "Set the time of day from a sun angle (0-360, 90 = noon).", params: { angle: { type: "number", req: true} } },
    { name: "day_night_cycle", description: "Start a day/night cycle script (full cycle in N minutes).", params: { minutes: { type: "number", req: false} } },
    { name: "audio_mute_all", description: "Mute every Sound in the game.", params: {} },
    { name: "audio_unmute_all", description: "Restore all Sound volumes to 0.5.", params: {} },
    { name: "audio_volume", description: "Set Volume on every Sound in the game.", params: { volume: { type: "number", req: true, desc: "0..10" } } },
    { name: "audio_stop_all", description: "Stop every playing Sound.", params: {} },
    { name: "audio_loop", description: "Set a Sound's Looped on/off.", params: { path: { type: "string", req: true}, loop: { type: "boolean", req: false} } },
    { name: "audio_pitch", description: "Set a Sound's Pitch.", params: { path: { type: "string", req: true}, pitch: { type: "number", req: false} } },
    { name: "audio_pan", description: "Set a Sound's Pan (-1..1).", params: { path: { type: "string", req: true}, pan: { type: "number", req: false} } },
    { name: "audio_id", description: "Point a Sound at an asset id (rbxassetid) and play it.", params: { path: { type: "string", req: false}, assetid: { type: "number", req: true} } },
    { name: "sound_library", description: "Install a small preset sound library (Click/Pop/Win/Lose/Alert/Whoosh) in ReplicatedStorage.", params: {} },
    { name: "jingle", description: "Play a preset jingle (win, lose, click, alert, pop, whoosh).", params: { kind: { type: "string", req: true, desc: "win|lose|click|alert|pop|whoosh" } } },
    { name: "ambient_loop", description: "Start a looping ambient Sound from an asset id.", params: { assetid: { type: "number", req: true}, volume: { type: "number", req: false} } },
    { name: "voice_radio", description: "Create a VoiceRadio in ReplicatedStorage (team talk within 60 studs).", params: {} },
    { name: "fx_puff", description: "Dust puff particle burst at a point.", params: { position: { type: "array", req: false, desc: "[x,y,z]" }, color: { type: "array", req: false} } },
    { name: "fx_bubbles", description: "Bubble particle burst at a point.", params: { position: { type: "array", req: false} } },
    { name: "fx_confetti", description: "Confetti burst at a point.", params: { position: { type: "array", req: false}, count: { type: "number", req: false} } },
    { name: "fx_sparks", description: "Spark particle burst at a point.", params: { position: { type: "array", req: false} } },
    { name: "fx_smoke_burst", description: "Smoke burst at a point.", params: { position: { type: "array", req: false}, color: { type: "array", req: false} } },
    { name: "fx_ring", description: "Expanding energy ring at a point.", params: { position: { type: "array", req: false}, radius: { type: "number", req: false}, color: { type: "array", req: false} } },
    { name: "fx_aura", description: "Aura particles around a player for N seconds.", params: { player: { type: "string", req: false}, seconds: { type: "number", req: false}, color: { type: "array", req: false} } },
    { name: "fx_magic_circle", description: "Floating magic circle under a part/player.", params: { position: { type: "array", req: false}, radius: { type: "number", req: false}, color: { type: "array", req: false}, seconds: { type: "number", req: false}, part: { type: "string", req: false, desc: "part path instead of position" }, path: { type: "string", req: false} } },
    { name: "fx_lightning", description: "Lightning strike effect (flash + beam) at a point.", params: { position: { type: "array", req: false} } },
    { name: "fx_trails_clear", description: "Remove all OR trail effects.", params: { path: { type: "string", req: false} } },
    { name: "fx_emitters_clear", description: "Remove all OR particle hosts (OR_FX_*).", params: { path: { type: "string", req: false} } },
    { name: "fx_burst", description: "Particle burst by element kind.", params: { kind: { type: "string", req: false, desc: "fire|ice|electric|spark|poison" }, count: { type: "number", req: false}, position: { type: "array", req: false} } },
    { name: "terrain_height", description: "Raise terrain to a target top height with a material.", params: { position: { type: "array", req: false, desc: "region center [x,y,z]" }, height: { type: "number", req: true, desc: "target top Y" }, size: { type: "array", req: false, desc: "region extent [x,y,z]" }, material: { type: "string", req: false, desc: "rock|grass|sand|water|snow|mud|ice|basalt|lava" } } },
    { name: "terrain_clear_region", description: "Clear terrain (dig to air) between two Region3 corners.", params: { from: { type: "array", req: true, desc: "corner [x,y,z]" }, to: { type: "array", req: true, desc: "corner [x,y,z]" } } },
    { name: "terrain_lava", description: "Fill a terrain region with glowing Lava material.", params: { position: { type: "array", req: false}, size: { type: "array", req: false} } },
    { name: "terrain_paint", description: "Paint a terrain region with a material.", params: { position: { type: "array", req: false}, size: { type: "array", req: false}, material: { type: "string", req: false} } },
    { name: "boundary_set", description: "Set Workspace Bounds to a box (keeps players in the area).", params: { size: { type: "number", req: false, desc: "half-extent in studs" } } },
    { name: "ground_make", description: "Create a large ground plate (anchored part).", params: { position: { type: "array", req: false}, size: { type: "array", req: false}, color: { type: "array", req: false}, material: { type: "string", req: false, desc: "grass|sand|rock|concrete|wood" } } },
    { name: "place_info", description: "Place id, job id, name, version.", params: {} },
    { name: "place_rename", description: "Set the place name (needs Studio save to persist).", params: { name: { type: "string", req: true} } },
    { name: "workspace_clear", description: "Destroy all Workspace children (keeps Terrain + Camera).", params: {} },
    { name: "workspace_export", description: "Export the workspace tree (names/classes/part pos+size) to ReplicatedStorage.OR_Export.", params: {} },
    { name: "workspace_import", description: "Restore the last workspace_export into a new Model (OR_Restore).", params: {} },
    { name: "script_create", description: "Create a Script/LocalScript with source under a parent service.", params: { kind: { type: "string", req: false, desc: "server|client|module" }, name: { type: "string", req: false}, parent: { type: "string", req: false}, source: { type: "string", req: false, desc: "Lua source" } } },
    { name: "script_module", description: "Create a ModuleScript under ServerStorage.OR_Modules; returns the require() path.", params: { name: { type: "string", req: false}, source: { type: "string", req: false} } },
    { name: "script_reload", description: "Re-apply a script's Source (reload after edits).", params: { path: { type: "string", req: true} } },
    { name: "script_grep", description: "Search script sources for text; returns matching paths + lines.", params: { query: { type: "string", req: true}, path: { type: "string", req: false, desc: "scope path" } } },
    { name: "script_stats", description: "Script inventory: counts per service (SSS/SPS/ServerStorage/StarterGui...).", params: {} },
    { name: "script_check", description: "Syntax-check Lua source with loadstring; reports the first error line.", params: { source: { type: "string", req: false, desc: "Lua code to check" }, path: { type: "string", req: false, desc: "...or check an existing script" } } },
    { name: "log_tag", description: "Install a print hook that prefixes console output with [TAG].", params: { tag: { type: "string", req: false} } },
    { name: "game_stats", description: "Quick snapshot: players, parts, place id, ClockTime.", params: {} },
    { name: "gc_run", description: "Force a garbage-collection cycle and report freed KB.", params: {} },
    { name: "memory_get", description: "Current Lua memory usage in MB.", params: {} },
  ];

  function buildX200(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      return { code: HEAD + "\n" + fn(args || {}) };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + e };
    }
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = buildX200(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  for (const c of C) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
})();
