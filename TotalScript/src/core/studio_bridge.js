// Studio MCP-style commands (Luau fallbacks). MCP keeps priority when connected.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  function luaStr(s) {
    return '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ") + '"';
  }
  function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (d || 0);
  }
  function num3(v, d) {
    const a = Array.isArray(v) ? v : d;
    return [num(a[0], d[0]), num(a[1], d[1]), num(a[2], d[2])];
  }

  const HEAD = [
    'local HttpService=game:GetService("HttpService")',
    "local function resolve(p) if not p or p=='' then return nil end p=tostring(p) if p=='game' then return game end if p:sub(1,5)=='game.' then p=p:sub(6) end local n=game for _,s in ipairs(string.split(p,'.')) do if s~='' then local nxt=n:FindFirstChild(s) if not nxt and n==game then local ok,svc=pcall(function() return game:GetService(s) end) if ok then nxt=svc end end if not nxt then return nil end n=nxt end end return n end",
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(code,message,details) if message==nil then message=code code='STUDIO_OPERATION_FAILED' end return HttpService:JSONEncode({ok=false,error={code=code,message=message,details=details}}) end",
    "local function sel() local s=game:GetService('Selection'):Get() return s end",
    "local function resolveLoose(p) if not p or p=='' then return nil end p=tostring(p):gsub('^%s+',''):gsub('%s+$',''):gsub('/','.'):gsub('^Game%.','game.'):gsub('^workspace%.','Workspace.'):gsub('^workspace$','Workspace') local inst=resolve(p) if inst then return inst end local last=p:match('([^%.]+)$') or p local lp=last:lower() local best=nil for _,root in ipairs({workspace,game:GetService('ReplicatedStorage'),game:GetService('ServerStorage'),game:GetService('ServerScriptService'),game:GetService('StarterGui'),game:GetService('StarterPlayer'),game:GetService('Lighting'),game:GetService('StarterPack'),game:GetService('SoundService')}) do if root.Name:lower()==lp then return root end for _,d in ipairs(root:GetDescendants()) do if d.Name==last then return d end if not best and d.Name:lower()==lp then best=d end end end return best end",
    "local function firstTarget(p) if p and p~='' then return resolveLoose(p) end local s=sel() return s[1] end",
  ].join("\n");

  function wrap(body) {
    return { code: HEAD + "\n" + body };
  }

  // Models name the target many ways; every spelling resolves to the same path.
  // Accept the path under any of the usual keys, and tolerate what rich-text
  // chats do to it: wrapping backticks / quotes, typographic quotes, trailing
  // punctuation, non-breaking spaces, a "game:GetService('X')" spelling and
  // Windows-style backslashes (1.33 - "Notion cannot get_children path").
  function cleanPath(v) {
    let p = String(v == null ? "" : v).replace(/[\u00A0\u2000-\u200A\u202F\u3000]/g, " ").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
    for (let i = 0; i < 2; i++) {
      p = p.replace(/^[`'"\u2018\u2019\u201C\u201D]+|[`'"\u2018\u2019\u201C\u201D]+$/g, "").trim();
      p = p.replace(/[.,;:!?]+$/, "").trim();
    }
    p = p.replace(/\\/g, ".").replace(/\s*[>\u2192]\s*/g, ".");
    p = p.replace(/^game\s*:\s*GetService\s*\(\s*["']([A-Za-z]+)["']\s*\)/, "$1");
    p = p.replace(/\s*\.\s*/g, ".").replace(/\.{2,}/g, ".").replace(/^\./, "").replace(/\.$/, "");
    return p;
  }
  function pathArg(a) {
    for (const k of ["path", "target", "instance", "instance_path", "object", "parent", "name", "query"]) {
      if (a && typeof a[k] === "string" && cleanPath(a[k])) return cleanPath(a[k]);
      if (a && a[k] && typeof a[k] === "object" && typeof a[k].path === "string" && cleanPath(a[k].path)) return cleanPath(a[k].path);
    }
    return "";
  }
  function buildBridge(op, a) {
    a = a || {};
    if (op === "search_game_tree") {
      const q = luaStr(a.query || a.name || a.q || "");
      const cls = luaStr(a.className || a.class || "");
      const limit = Math.max(1, Math.min(80, num(a.limit, 25)));
      const root = luaStr(a.root || a.path || "game");
      return wrap(
        [
          `local q=${q} local cls=${cls} local limit=${limit} local root=resolve(${root}) or game`,
          "q=string.lower(q) cls=string.lower(cls)",
          "local hits={} local n=0",
          "local function consider(inst)",
          " if n>=limit then return end",
          " local name=string.lower(inst.Name) local cn=string.lower(inst.ClassName)",
          " local okN=(q=='' or string.find(name,q,1,true) or string.find(cn,q,1,true))",
          " local okC=(cls=='' or cn==cls)",
          " if okN and okC then n+=1 hits[n]={name=inst.Name,className=inst.ClassName,path=inst:GetFullName()} end",
          "end",
          "consider(root)",
          "for _,d in ipairs(root:GetDescendants()) do consider(d) if n>=limit then break end end",
          "return ok({count=n,items=hits}, n==0 and 'no matches' or ('found '..n))",
        ].join("\n")
      );
    }
    if (op === "inspect_instance") {
      const path = luaStr(pathArg(a));
      return wrap(
        [
          `local inst=firstTarget(${path}) if not inst then return fail("NOT_FOUND","nothing to inspect for path "..tostring(${path}).." (use a full path like game.Workspace.House.Door, or search_game_tree {query} first; with no path the current Selection is used)") end`,
          "local keys={'Name','ClassName','Parent','Anchored','CanCollide','CanTouch','CanQuery','CastShadow','Transparency','Reflectance','Material','BrickColor','Color','Size','CFrame','Position','Orientation','Shape','MeshId','TextureID','TextureId','SoundId','AnimationId','Image','Value','Enabled','Disabled','Source','MaxHealth','Health','WalkSpeed','JumpPower','HipHeight','Text','TextColor3','BackgroundColor3','Visible','ZIndex','LayoutOrder'}",
          "local props={}",
          "for _,k in ipairs(keys) do local okv,v=pcall(function() return inst[k] end) if okv and v~=nil then local tv=typeof(v) if tv=='Instance' then props[k]=v:GetFullName() elseif tv=='Vector3' then props[k]={v.X,v.Y,v.Z} elseif tv=='Color3' then props[k]={math.floor(v.R*255+0.5),math.floor(v.G*255+0.5),math.floor(v.B*255+0.5)} elseif tv=='CFrame' then local p=v.Position props[k]={p.X,p.Y,p.Z} elseif tv=='EnumItem' then props[k]=tostring(v) elseif tv=='string' or tv=='number' or tv=='boolean' then props[k]=v else props[k]=tostring(v) end end end",
          "local kids={} for _,c in ipairs(inst:GetChildren()) do kids[#kids+1]={name=c.Name,className=c.ClassName} end",
          "local tags={} pcall(function() tags=game:GetService('CollectionService'):GetTags(inst) end)",
          "local attrs={} pcall(function() attrs=inst:GetAttributes() end)",
          "local uid='' pcall(function() uid=tostring(inst.UniqueId) end)",
          "return ok({path=inst:GetFullName(),className=inst.ClassName,uniqueId=uid,properties=props,children=kids,tags=tags,attributes=attrs}, inst:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "script_read") {
      const path = luaStr(a.path || a.target || "");
      return wrap(
        [
          `local requested=${path}`,
          "if requested=='' then return fail('INVALID_INSTANCE','script_read requires an exact path',{requestedPath=requested}) end",
          "local function resolveExact(p)",
          " p=tostring(p) if p=='game' then return game,nil end if p:sub(1,5)=='game.' then p=p:sub(6) end",
          " local n=game local consumed='game'",
          " for _,segment in ipairs(string.split(p,'.')) do",
          "  if segment~='' then",
          "   local matches={} for _,child in ipairs(n:GetChildren()) do if child.Name==segment then matches[#matches+1]=child end end",
          "   if #matches==0 and n==game then local oks,svc=pcall(function() return game:GetService(segment) end) if oks and svc then matches={svc} end end",
          "   if #matches==0 then return nil,{code='SCRIPT_NOT_FOUND',message='No instance named '..segment..' below '..consumed,segment=segment,parent=consumed} end",
          "   if #matches>1 then local choices={} for _,v in ipairs(matches) do choices[#choices+1]={name=v.Name,className=v.ClassName,path=v:GetFullName()} end return nil,{code='INVALID_INSTANCE',message='Path is ambiguous because duplicate names exist below '..consumed,segment=segment,parent=consumed,matches=choices} end",
          "   n=matches[1] consumed=consumed..'.'..segment",
          "  end",
          " end return n,nil",
          "end",
          "local inst,resolveError=resolveExact(requested)",
          "if not inst then return fail(resolveError.code,resolveError.message,resolveError) end",
          "if inst==game or inst.Parent==nil then return fail('INVALID_INSTANCE','Target is destroyed, detached, or not a script',{requestedPath=requested}) end",
          "if not (inst:IsA('Script') or inst:IsA('LocalScript') or inst:IsA('ModuleScript')) then return fail('SCRIPT_NOT_READABLE','Target must be a Script, LocalScript, or ModuleScript',{path=inst:GetFullName(),className=inst.ClassName}) end",
          "local readOk,srcOrError=pcall(function() return inst.Source end)",
          "if not readOk then return fail('SCRIPT_NOT_READABLE','Studio denied access to script Source',{path=inst:GetFullName(),className=inst.ClassName,reason=tostring(srcOrError)}) end",
          "if typeof(srcOrError)~='string' then return fail('BRIDGE_PROTOCOL_ERROR','Studio returned a non-string Source',{path=inst:GetFullName(),sourceType=typeof(srcOrError)}) end",
          "if srcOrError=='' then return fail('SCRIPT_SOURCE_EMPTY','Script Source is empty',{path=inst:GetFullName(),className=inst.ClassName,length=0}) end",
          "local encodedOk,encoded=pcall(function() return ok({path=inst:GetFullName(),className=inst.ClassName,length=#srcOrError,source=srcOrError},inst:GetFullName()..' '..#srcOrError..' chars') end)",
          "if not encodedOk then return fail('BRIDGE_PROTOCOL_ERROR','Could not serialize script Source',{path=inst:GetFullName(),reason=tostring(encoded)}) end",
          "return encoded",
        ].join("\n")
      );
    }
    if (op === "script_search" || op === "script_grep") {
      const pat = luaStr(a.pattern || a.query || a.q || "");
      const root = luaStr(a.root || a.path || a.scope || "game");
      const limit = Math.max(1, Math.min(40, num(a.limit, 20)));
      return wrap(
        [
          `local pat=${pat} if pat=='' then return fail("pattern required") end`,
          `local root=resolve(${root}) or game local limit=${limit}`,
          "local hits={} local n=0",
          "local function walk(inst)",
          " if n>=limit then return end",
          " if inst:IsA('LuaSourceContainer') then",
          "  local src='' pcall(function() src=inst.Source end)",
          "  local i=1 local line=1",
          "  for text in string.gmatch(src..'\\n','([^\\n]*)\\n') do",
          "   if string.find(text,pat,1,true) then n+=1 hits[n]={path=inst:GetFullName(),line=line,excerpt=string.sub(text,1,180)} if n>=limit then return end end",
          "   line+=1",
          "  end",
          " end",
          " for _,c in ipairs(inst:GetChildren()) do walk(c) if n>=limit then return end end",
          "end",
          "walk(root)",
          "return ok({count=n,pattern=pat,items=hits}, n==0 and 'no matches' or ('found '..n))",
        ].join("\n")
      );
    }
    if (op === "get_studio_state") {
      return wrap(
        [
          "local rs=game:GetService('RunService')",
          "local sel=sel() local items={}",
          "for _,i in ipairs(sel) do items[#items+1]={name=i.Name,className=i.ClassName,path=i:GetFullName()} end",
          "local cam=workspace.CurrentCamera",
          "local camPos=cam and {cam.CFrame.Position.X,cam.CFrame.Position.Y,cam.CFrame.Position.Z} or nil",
          "local st={edit=not rs:IsRunning(),playing=rs:IsRunning(),studio=rs:IsStudio(),client=rs:IsClient(),server=rs:IsServer(),placeId=tonumber(game.PlaceId) or 0,gameId=tonumber(game.GameId) or 0,jobId=tostring(game.JobId or ''),placeName=tostring(game.Name or ''),selection=items,camera=camPos}",
          "return ok(st, st.playing and 'play' or 'edit')",
        ].join("\n")
      );
    }
    if (op === "start_stop_play") {
      const start = a.is_start !== false && a.start !== false && a.action !== "stop";
      return wrap(
        [
          `local wantStart=${start ? "true" : "false"}`,
          "local rs=game:GetService('RunService') local playing=rs:IsRunning()",
          "if wantStart then",
          " if playing then return ok({playing=true},'already playing') end",
          " return fail('cannot start Play from Edit Luau — press Play in Studio (Studio MCP start_stop_play if connected)')",
          "else",
          " return ok({playing=playing}, playing and 'still playing — press Stop in Studio' or 'already stopped')",
          "end",
        ].join("\n")
      );
    }
    if (op === "get_console_output") {
      const limit = Math.max(1, Math.min(80, num(a.limit, 40)));
      return wrap(
        [
          `local limit=${limit}`,
          "local hist={} pcall(function() hist=game:GetService('LogService'):GetLogHistory() end)",
          "local items={} local n=#hist local from=math.max(1,n-limit+1)",
          "for i=from,n do local e=hist[i] if e then items[#items+1]={message=tostring(e.message or e.Message or ''),timestamp=tostring(e.timestamp or ''),type=tostring(e.messageType or e.Type or '')} end end",
          "return ok({count=#items,items=items}, #items..' log line(s)')",
        ].join("\n")
      );
    }
    if (op === "search_creator_store") {
      const q = luaStr(a.query || a.q || a.keyword || "");
      const limit = Math.max(1, Math.min(20, num(a.limit, 8)));
      return wrap(
        [
          `local q=${q} if q=='' then return fail("query required") end local limit=${limit}`,
          "local url='https://catalog.roblox.com/v1/search/items/details?Category=1&Limit=10&Keyword='..HttpService:UrlEncode(q)",
          "local body='' local okH,res=pcall(function() return HttpService:GetAsync(url) end)",
          "if not okH then return fail('catalog search blocked: '..tostring(res)..' — pass assetId to insert_from_creator_store') end",
          "local dec=HttpService:JSONDecode(res)",
          "local items={} for _,it in ipairs(dec.data or dec.Items or {}) do items[#items+1]={id=it.id or it.AssetId,name=it.name or it.Name,itemType=it.itemType or it.ItemType} if #items>=limit then break end end",
          "return ok({count=#items,items=items}, #items==0 and 'no catalog hits' or ('found '..#items))",
        ].join("\n")
      );
    }
    if (op === "insert_from_creator_store") {
      const id = Math.floor(num(a.assetId || a.id || a.asset_id, 0));
      const parent = luaStr(a.parent || a.path || "Workspace");
      const name = luaStr(a.name || "");
      if (!id) return { err: "ERROR: insert_from_creator_store needs assetId" };
      return wrap(
        [
          `local id=${id} local parent=resolve(${parent}) or workspace`,
          "local InsertService=game:GetService('InsertService')",
          "local okL,model=pcall(function() return InsertService:LoadAsset(id) end)",
          "if not okL or not model then return fail('LoadAsset failed: '..tostring(model)) end",
          "model.Parent=parent",
          `if ${name}~='' then pcall(function() model.Name=${name} end) end`,
          "game:GetService('Selection'):Set({model})",
          "return ok({path=model:GetFullName(),assetId=id}, 'inserted '..model:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "generate_mesh") {
      const name = luaStr(a.name || "Total_Mesh");
      const meshId = luaStr(a.meshId || a.mesh_id || a.id || "");
      const sz = num3(a.size, [4, 4, 4]);
      const pos = num3(a.position || a.cframe, [0, 6, 0]);
      return wrap(
        [
          `local p=Instance.new('MeshPart') p.Name=${name} p.Size=Vector3.new(${sz[0]},${sz[1]},${sz[2]}) p.Position=Vector3.new(${pos[0]},${pos[1]},${pos[2]}) p.Anchored=true p.Material=Enum.Material.SmoothPlastic`,
          `if ${meshId}~='' then pcall(function() p.MeshId=${meshId} end) end`,
          "p.Parent=workspace game:GetService('Selection'):Set({p})",
          "return ok({path=p:GetFullName()}, 'mesh '..p:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "generate_material") {
      const path = luaStr(a.path || a.target || "");
      const mat = String(a.material || a.name || "SmoothPlastic").replace(/[^A-Za-z]/g, "") || "SmoothPlastic";
      const col = num3(a.color, [180, 180, 190]);
      return wrap(
        [
          `local inst=firstTarget(${path}) if not inst then return fail("select a part or pass path") end`,
          "if not inst:IsA('BasePart') then inst=inst:FindFirstChildWhichIsA('BasePart',true) end",
          "if not inst then return fail('no BasePart') end",
          `pcall(function() inst.Material=Enum.Material.${mat} end)`,
          `pcall(function() inst.Color=Color3.fromRGB(${col[0]},${col[1]},${col[2]}) end)`,
          "return ok({path=inst:GetFullName(),material=tostring(inst.Material)}, inst:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "generate_procedural_model") {
      const kind = String(a.kind || a.type || a.name || "crate").toLowerCase().replace(/[^a-z_]/g, "") || "crate";
      const pos = num3(a.position, [0, 5, 0]);
      const scale = num(a.scale, 1) || 1;
      const name = luaStr(a.name || ("Total_" + kind));
      return wrap(
        [
          `local kind=${luaStr(kind)} local s=${scale} local origin=Vector3.new(${pos[0]},${pos[1]},${pos[2]})`,
          `local model=Instance.new('Model') model.Name=${name}`,
          "local function part(nm,size,off,col,mat)",
          " local p=Instance.new('Part') p.Name=nm p.Anchored=true p.Size=size p.CFrame=CFrame.new(origin+off) p.Color=col p.Material=mat or Enum.Material.SmoothPlastic p.TopSurface=Enum.SurfaceType.Smooth p.BottomSurface=Enum.SurfaceType.Smooth p.Parent=model return p",
          "end",
          "if kind=='house' then",
          " part('Floor',Vector3.new(16*s,1,12*s),Vector3.new(0,0.5*s,0),Color3.fromRGB(145,120,90),Enum.Material.Wood)",
          " part('WallN',Vector3.new(16*s,10*s,1),Vector3.new(0,6*s,-5.5*s),Color3.fromRGB(210,200,185),Enum.Material.Brick)",
          " part('WallS',Vector3.new(16*s,10*s,1),Vector3.new(0,6*s,5.5*s),Color3.fromRGB(210,200,185),Enum.Material.Brick)",
          " part('WallW',Vector3.new(1,10*s,12*s),Vector3.new(-7.5*s,6*s,0),Color3.fromRGB(210,200,185),Enum.Material.Brick)",
          " part('WallE',Vector3.new(1,10*s,12*s),Vector3.new(7.5*s,6*s,0),Color3.fromRGB(210,200,185),Enum.Material.Brick)",
          " part('Roof',Vector3.new(18*s,1,14*s),Vector3.new(0,11.5*s,0),Color3.fromRGB(140,55,45),Enum.Material.Slate)",
          " part('Door',Vector3.new(3*s,7*s,0.4),Vector3.new(0,4*s,6.1*s),Color3.fromRGB(90,60,40),Enum.Material.Wood)",
          "elseif kind=='tree' then",
          " part('Trunk',Vector3.new(1.4*s,8*s,1.4*s),Vector3.new(0,4*s,0),Color3.fromRGB(110,75,40),Enum.Material.Wood)",
          " part('Leaves',Vector3.new(7*s,5*s,7*s),Vector3.new(0,10*s,0),Color3.fromRGB(55,140,70),Enum.Material.Grass)",
          "elseif kind=='tower' then",
          " part('Shaft',Vector3.new(6*s,18*s,6*s),Vector3.new(0,9*s,0),Color3.fromRGB(160,160,170),Enum.Material.Brick)",
          " part('Crown',Vector3.new(8*s,2*s,8*s),Vector3.new(0,19*s,0),Color3.fromRGB(90,90,100),Enum.Material.Slate)",
          "elseif kind=='stairs' then",
          " for i=0,7 do part('Step'..i,Vector3.new(6*s,0.5*s,1.2*s),Vector3.new(0,(i+0.5)*0.5*s,i*1.1*s),Color3.fromRGB(175,175,180),Enum.Material.Concrete) end",
          "elseif kind=='platform' then",
          " part('Deck',Vector3.new(20*s,1,20*s),Vector3.new(0,0.5*s,0),Color3.fromRGB(70,140,210),Enum.Material.Neon)",
          "elseif kind=='rock' then",
          " part('Rock',Vector3.new(5*s,4*s,6*s),Vector3.new(0,2*s,0),Color3.fromRGB(120,118,112),Enum.Material.Slate)",
          "elseif kind=='lamp' then",
          " part('Pole',Vector3.new(0.4*s,10*s,0.4*s),Vector3.new(0,5*s,0),Color3.fromRGB(50,50,55),Enum.Material.Metal)",
          " local bulb=part('Bulb',Vector3.new(1.6*s,1.6*s,1.6*s),Vector3.new(0,10.4*s,0),Color3.fromRGB(255,230,140),Enum.Material.Neon)",
          " local l=Instance.new('PointLight') l.Brightness=2 l.Range=24*s l.Parent=bulb",
          "else",
          " part('Crate',Vector3.new(3*s,3*s,3*s),Vector3.new(0,1.5*s,0),Color3.fromRGB(170,120,70),Enum.Material.Wood)",
          "end",
          "local primary=model:FindFirstChildWhichIsA('BasePart') if primary then model.PrimaryPart=primary end",
          "model.Parent=workspace game:GetService('Selection'):Set({model})",
          "return ok({path=model:GetFullName(),kind=kind,parts=#model:GetChildren()}, 'built '..model:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "character_navigation") {
      const path = luaStr(a.path || a.target || a.character || "");
      const dest = num3(a.destination || a.position || a.to, [0, 0, 0]);
      return wrap(
        [
          `local inst=firstTarget(${path}) if not inst then return fail("select a character or pass path") end`,
          "local hum=inst:FindFirstChildOfClass('Humanoid')",
          "if not hum and inst:IsA('Humanoid') then hum=inst inst=inst.Parent end",
          "if not hum and inst.Parent then hum=inst.Parent:FindFirstChildOfClass('Humanoid') end",
          "if not hum then return fail('no Humanoid on '..inst:GetFullName()) end",
          `local dest=Vector3.new(${dest[0]},${dest[1]},${dest[2]})`,
          "hum:MoveTo(dest)",
          "return ok({path=inst:GetFullName(),destination={dest.X,dest.Y,dest.Z}}, 'MoveTo '..inst:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "user_keyboard_input") {
      const key = String(a.key || a.keycode || a.code || "W").replace(/[^A-Za-z0-9]/g, "") || "W";
      const down = a.down !== false && a.state !== "up";
      return wrap(
        [
          `local key=Enum.KeyCode.${key} local down=${down ? "true" : "false"}`,
          "local vim=game:GetService('VirtualInputManager')",
          "vim:SendKeyEvent(down,key,false,game)",
          "return ok({key=tostring(key),down=down}, 'key '..tostring(key))",
        ].join("\n")
      );
    }
    if (op === "user_mouse_input") {
      const x = num(a.x, 400);
      const y = num(a.y, 300);
      const btn = Math.max(0, Math.min(2, num(a.button, 0)));
      const down = a.down !== false && a.state !== "up";
      return wrap(
        [
          `local vim=game:GetService('VirtualInputManager')`,
          `vim:SendMouseMoveEvent(${x},${y},game)`,
          `vim:SendMouseButtonEvent(${x},${y},${btn},${a.down === false || a.state === "up" ? "false" : "true"},game,0)`,
          `return ok({x=${x},y=${y},button=${btn}}, 'mouse')`,
        ].join("\n")
      );
    }
    if (op === "wait_job_finished") {
      const sec = Math.max(0.2, Math.min(12, num(a.seconds || a.timeout || a.duration, 1.5)));
      return wrap(
        [
          `local n=${sec} task.wait(n)`,
          "local rs=game:GetService('RunService')",
          "return ok({waited=n,playing=rs:IsRunning()}, 'waited '..n..'s')",
        ].join("\n")
      );
    }
    if (op === "list_roblox_studios") {
      return wrap(
        [
          "local rs=game:GetService('RunService')",
          "local studio={id=tostring(game.JobId or game.PlaceId),placeId=tonumber(game.PlaceId) or 0,gameId=tonumber(game.GameId) or 0,name=tostring(game.Name or ''),active=true,playing=rs:IsRunning()}",
          "return ok({studios={studio},count=1}, game.Name)",
        ].join("\n")
      );
    }
    if (op === "set_active_studio") {
      const id = luaStr(a.studio_id || a.id || a.studioId || "");
      return wrap(
        [
          `local want=${id}`,
          "local cur=tostring(game.JobId or game.PlaceId)",
          "if want~='' and want~=cur and want~=tostring(game.PlaceId) then return fail('this session is '..cur..' — reopen that place to switch') end",
          "return ok({active=cur,placeId=tonumber(game.PlaceId) or 0}, 'active studio '..cur)",
        ].join("\n")
      );
    }
    if (op === "get_template") {
      const q = luaStr(a.query || a.name || a.q || "");
      return wrap(
        [
          "local q=" + q + " if q=='' then return fail('query required') end",
          "local ql=string.lower(q)",
          "local hit=nil",
          "local function consider(inst) if hit then return end local n=string.lower(inst.Name) if n==ql or string.find(n,ql,1,true) then hit=inst end end",
          "for _,root in ipairs({workspace, game:GetService('ReplicatedStorage'), game:GetService('ServerStorage'), game:GetService('StarterGui'), game:GetService('StarterPack'), game:GetService('Lighting')}) do consider(root) for _,d in ipairs(root:GetDescendants()) do consider(d) if hit then break end end if hit then break end end",
          "if not hit then return fail('no template') end",
          "local copy=hit:Clone() copy.Name=hit.Name..'_Copy' copy.Parent=workspace",
          "pcall(function() if copy:IsA('Model') and copy.PrimaryPart then copy:PivotTo(CFrame.new(0,6,0)) elseif copy:IsA('BasePart') then copy.Position=Vector3.new(0,6,0) end end)",
          "game:GetService('Selection'):Set({copy})",
          "return ok({path=copy:GetFullName(),from=hit:GetFullName()}, 'copied '..hit:GetFullName()..' -> '..copy:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "script_new") {
      const kind = String(a.className || a.kind || a.type || "Script").replace(/[^A-Za-z]/g, "") || "Script";
      const parent = luaStr(a.parent || a.path || "ServerScriptService");
      const name = luaStr(a.name || "Total_Script");
      const src = luaStr(a.source || a.code || "-- TotalScript");
      return wrap(
        [
          "local okN,sc=pcall(function() return Instance.new(\"" + kind + "\") end)",
          "if not okN or not sc then return fail('script_new: '..tostring(sc)) end",
          "sc.Name=" + name,
          "pcall(function() sc.Source=" + src + " end)",
          "sc.Parent=resolve(" + parent + ") or game:GetService('ServerScriptService')",
          "return ok({path=sc:GetFullName(),className=sc.ClassName}, 'script '..sc:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "set_primary_part") {
      const path = luaStr(a.path || a.target || "");
      const child = luaStr(a.part || a.child || "");
      return wrap(
        [
          "local m=firstTarget(" + path + ") if not m then return fail('not found') end",
          "if not m:IsA('Model') then return fail('need a Model') end",
          "local p=nil if " + child + "~='' then p=m:FindFirstChild(" + child + ",true) end",
          "if not p then p=m:FindFirstChildWhichIsA('BasePart',true) end",
          "if not p then return fail('no BasePart') end",
          "m.PrimaryPart=p",
          "return ok({path=m:GetFullName(),primary=p.Name}, 'PrimaryPart '..p.Name)",
        ].join("\n")
      );
    }
    if (op === "select_class") {
      const cls = luaStr(a.className || a.class || a.name || "Part");
      const root = luaStr(a.root || a.path || "Workspace");
      const limit = Math.max(1, Math.min(80, Number(a.limit) || 25));
      return wrap(
        [
          "local cls=" + cls + " local root=resolve(" + root + ") or workspace local limit=" + limit,
          "local items={} for _,d in ipairs(root:GetDescendants()) do if d:IsA(cls) then items[#items+1]=d if #items>=limit then break end end end",
          "game:GetService('Selection'):Set(items)",
          "local rows={} for _,i in ipairs(items) do rows[#rows+1]={name=i.Name,path=i:GetFullName()} end",
          "return ok({count=#items,items=rows}, 'selected '..#items..' '..cls)",
        ].join("\n")
      );
    }
    if (op === "snap_position") {
      const path = luaStr(a.path || a.target || "");
      const grid = Number(a.grid) || 1;
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('not found') end local g=" + grid,
          "local function snap(v) return Vector3.new(math.floor(v.X/g+0.5)*g, math.floor(v.Y/g+0.5)*g, math.floor(v.Z/g+0.5)*g) end",
          "if inst:IsA('Model') and inst.PrimaryPart then inst:PivotTo(CFrame.new(snap(inst:GetPivot().Position))) elseif inst:IsA('BasePart') then inst.Position=snap(inst.Position) else return fail('need BasePart or Model') end",
          "return ok({path=inst:GetFullName()}, 'snapped '..inst:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "camera_focus") {
      const path = luaStr(a.path || a.target || "");
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('not found') end",
          "local cam=workspace.CurrentCamera if not cam then return fail('no camera') end",
          "local pos=Vector3.new(0,5,0) pcall(function() if inst:IsA('BasePart') then pos=inst.Position elseif inst:IsA('Model') then pos=inst:GetPivot().Position end end)",
          "pcall(function() cam.CFrame=CFrame.new(pos+Vector3.new(12,8,12), pos) end)",
          "return ok({path=inst:GetFullName()}, 'focused '..inst:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "particle_add") {
      const path = luaStr(a.path || a.target || "");
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('not found') end",
          "if not inst:IsA('BasePart') then inst=inst:FindFirstChildWhichIsA('BasePart',true) end",
          "if not inst then return fail('no BasePart') end",
          "local p=Instance.new('ParticleEmitter') p.Rate=20 p.Lifetime=NumberRange.new(0.4,1.2) p.Speed=NumberRange.new(2,6) p.Parent=inst",
          "return ok({path=p:GetFullName()}, 'particle '..p:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "highlight_clear") {
      return wrap(
        [
          "local n=0 for _,d in ipairs(workspace:GetDescendants()) do if d:IsA('Highlight') then d:Destroy() n+=1 end end",
          "return ok({removed=n}, 'cleared '..n..' highlight(s)')",
        ].join("\n")
      );
    }
    if (op === "duplicate_n") {
      const path = luaStr(a.path || a.target || "");
      const n = Math.max(1, Math.min(20, Number(a.count || a.n) || 1));
      const off = Number(a.offset) || 4;
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('not found') end",
          "local copies={} for i=1," + n + " do local c=inst:Clone() c.Parent=inst.Parent pcall(function() if c:IsA('BasePart') then c.Position=inst.Position+Vector3.new(i*" + off + ",0,0) elseif c:IsA('Model') then c:PivotTo(inst:GetPivot()*CFrame.new(i*" + off + ",0,0)) end end) copies[#copies+1]=c:GetFullName() end",
          "return ok({count=#copies,items=copies}, 'duplicated '..#copies)",
        ].join("\n")
      );
    }
    if (op === "instance_new") {
      const cls = String(a.className || a.class || "Part").replace(/[^A-Za-z0-9_]/g, "") || "Part";
      const parent = luaStr(a.parent || a.path || "Workspace");
      const name = luaStr(a.instanceName || a.objectName || a.name || "");
      return wrap(
        [
          "local okN,inst=pcall(function() return Instance.new(\"" + cls + "\") end)",
          "if not okN or not inst then return fail('Instance.new failed: '..tostring(inst)) end",
          "local parent=resolve(" + parent + ") or workspace inst.Parent=parent",
          "if " + name + "~='' then inst.Name=" + name + " end",
          "pcall(function() game:GetService('Selection'):Set({inst}) end)",
          "return ok({path=inst:GetFullName(),className=inst.ClassName}, 'new '..inst:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "get_service") {
      const svc = luaStr(a.service || a.name || a.className || "");
      return wrap(
        [
          "local n=" + svc + " if n=='' then return fail('service name required') end",
          "local okS,s=pcall(function() return game:GetService(n) end)",
          "if not okS or not s then return fail('GetService failed: '..tostring(s)) end",
          "return ok({path=s:GetFullName(),className=s.ClassName}, s:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "get_children") {
      const path = luaStr(pathArg(a));
      const cls = luaStr(a.className || a.class || a.class_name || "");
      const limit = Math.max(1, Math.min(300, num(a.limit, 200)));
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('NOT_FOUND','nothing found for path '..tostring(" + path + ")..' (use a full path like game.Workspace.House.Door, or search_game_tree {query} first; with no path the current Selection is used)') end",
          "local cls=string.lower(" + cls + ") local limit=" + limit + " local all=inst:GetChildren() local items={} for _,c in ipairs(all) do if cls=='' or string.lower(c.ClassName)==cls or (pcall(function() return c:IsA(" + cls + ") end) and c:IsA(" + cls + ")) then items[#items+1]={name=c.Name,className=c.ClassName,path=c:GetFullName()} if #items>=limit then break end end end",
          "return ok({count=#items,total=#all,path=inst:GetFullName(),className=inst.ClassName,items=items}, #items..' of '..#all..' children of '..inst:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "get_descendants") {
      const path = luaStr(pathArg(a));
      const limit = Math.max(1, Math.min(80, Number(a.limit) || 40));
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('not found') end local limit=" + limit,
          "local items={} for _,c in ipairs(inst:GetDescendants()) do items[#items+1]={name=c.Name,className=c.ClassName,path=c:GetFullName()} if #items>=limit then break end end",
          "return ok({count=#items,path=inst:GetFullName(),items=items}, #items..' descendants')",
        ].join("\n")
      );
    }
    if (op === "find_first_child") {
      const path = luaStr(a.path || a.target || "game");
      const name = luaStr(a.child || a.name || a.childName || "");
      const rec = a.recursive !== false && a.recursive !== "false";
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('not found') end",
          "local n=" + name + " if n=='' then return fail('child name required') end",
          "local ch=inst:FindFirstChild(n," + (rec ? "true" : "false") + ")",
          "if not ch then return fail('no child '..n) end",
          "return ok({path=ch:GetFullName(),className=ch.ClassName}, ch:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "wait_for_child") {
      const path = luaStr(a.path || a.target || "game");
      const name = luaStr(a.child || a.name || a.childName || "");
      const timeout = Math.max(0.1, Math.min(15, Number(a.timeout) || 5));
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('not found') end",
          "local n=" + name + " if n=='' then return fail('child name required') end",
          "local ch=inst:WaitForChild(n," + timeout + ")",
          "if not ch then return fail('WaitForChild timed out: '..n) end",
          "return ok({path=ch:GetFullName(),className=ch.ClassName}, ch:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "pivot_to") {
      const path = luaStr(a.path || a.target || "");
      const pos = (Array.isArray(a.position || a.cframe) ? (a.position || a.cframe) : [0, 5, 0]);
      const x = Number(pos[0]) || 0, y = Number(pos[1]) || 0, z = Number(pos[2]) || 0;
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('not found') end",
          "if not inst.PivotTo then return fail('no PivotTo on '..inst.ClassName) end",
          "inst:PivotTo(CFrame.new(" + x + "," + y + "," + z + "))",
          "return ok({path=inst:GetFullName(),position={" + x + "," + y + "," + z + "}}, 'pivoted '..inst:GetFullName())",
        ].join("\n")
      );
    }
    if (op === "register_collision_group") {
      const g = luaStr(a.group || a.name || "TotalGroup");
      return wrap(
        [
          "local g=" + g + " if g=='' then return fail('group required') end",
          "pcall(function() game:GetService('PhysicsService'):RegisterCollisionGroup(g) end)",
          "return ok({group=g}, 'collision group '..g)",
        ].join("\n")
      );
    }
    if (op === "get_datastore") {
      const n = luaStr(a.name || a.datastore || "TotalData");
      return wrap(
        [
          "local n=" + n + " if n=='' then return fail('name required') end",
          "local okD,ds=pcall(function() return game:GetService('DataStoreService'):GetDataStore(n) end)",
          "if not okD then return fail('GetDataStore: '..tostring(ds)) end",
          "return ok({name=n}, 'DataStore '..n)",
        ].join("\n")
      );
    }
    if (op === "set_waypoint") {
      const n = luaStr(a.name || a.label || "TotalScript waypoint");
      return wrap(
        [
          "pcall(function() game:GetService('ChangeHistoryService'):SetWaypoint(" + n + ") end)",
          "return ok({waypoint=" + n + "}, 'waypoint')",
        ].join("\n")
      );
    }
    if (op === "debris_add") {
      const path = luaStr(a.path || a.target || "");
      const life = Math.max(0, Math.min(60, Number(a.lifetime || a.seconds) || 5));
      return wrap(
        [
          "local inst=firstTarget(" + path + ") if not inst then return fail('not found') end",
          "game:GetService('Debris'):AddItem(inst," + life + ")",
          "return ok({path=inst:GetFullName(),lifetime=" + life + "}, 'Debris '..inst:GetFullName())",
        ].join("\n")
      );
    }
    return null;
  }

  const BRIDGE = [
    { name: "search_game_tree", description: "Search the DataModel by name/class. Returns paths.", params: { query: { type: "string", req: true }, className: { type: "string", req: false }, root: { type: "string", req: false }, limit: { type: "number", req: false } } },
    { name: "inspect_instance", description: "Dump properties, attributes, children, tags and UniqueId of one instance. path is a full path (game.Workspace.House.Door) or just a name (searched under the common services); omit it to inspect the current Selection.", params: { path: { type: "string", req: false } } },
    { name: "script_read", description: "Read a Script/LocalScript/ModuleScript Source.", params: { path: { type: "string", req: true } } },
    { name: "script_search", description: "Find a literal string inside script sources.", params: { pattern: { type: "string", req: true }, root: { type: "string", req: false }, limit: { type: "number", req: false } } },
    { name: "script_grep", description: "Alias of script_search.", params: { pattern: { type: "string", req: true }, root: { type: "string", req: false } } },
    { name: "get_studio_state", description: "Edit/play, PlaceId, GameId, selection, camera.", params: {} },
    { name: "start_stop_play", description: "Report or request Play/Stop. MCP wins when connected.", params: { is_start: { type: "boolean", req: false } } },
    { name: "get_console_output", description: "Last Output window lines (LogService).", params: { limit: { type: "number", req: false } } },
    { name: "search_creator_store", description: "Search the Roblox catalog/Creator Store by keyword.", params: { query: { type: "string", req: true }, limit: { type: "number", req: false } } },
    { name: "insert_from_creator_store", description: "InsertService:LoadAsset into Workspace (or parent).", params: { assetId: { type: "number", req: true }, parent: { type: "string", req: false }, name: { type: "string", req: false } } },
    { name: "generate_mesh", description: "Create an anchored MeshPart (optional MeshId).", params: { name: { type: "string", req: false }, meshId: { type: "string", req: false }, size: { type: "array", req: false }, position: { type: "array", req: false } } },
    { name: "generate_material", description: "Apply Material + Color to a part or the selection.", params: { path: { type: "string", req: false }, material: { type: "string", req: false }, color: { type: "array", req: false } } },
    { name: "generate_procedural_model", description: "Build a named model from parts: house, tree, tower, stairs, platform, rock, lamp, crate.", params: { kind: { type: "string", req: false }, name: { type: "string", req: false }, position: { type: "array", req: false }, scale: { type: "number", req: false } } },
    { name: "character_navigation", description: "Humanoid:MoveTo a destination.", params: { path: { type: "string", req: false }, destination: { type: "array", req: true } } },
    { name: "user_keyboard_input", description: "VirtualInputManager key event (Play/client).", params: { key: { type: "string", req: true }, down: { type: "boolean", req: false } } },
    { name: "user_mouse_input", description: "VirtualInputManager mouse move/click.", params: { x: { type: "number", req: false }, y: { type: "number", req: false }, button: { type: "number", req: false }, down: { type: "boolean", req: false } } },
    { name: "wait_job_finished", description: "Wait a short time, then return play state.", params: { seconds: { type: "number", req: false } } },
    { name: "list_roblox_studios", description: "List the Studio session this plugin is in.", params: {} },
    { name: "set_active_studio", description: "Confirm this session is the active Studio (cannot hop places).", params: { studio_id: { type: "string", req: false } } },
    { name: "get_template", description: "Search the place (then Creator Store) for a named template and CLONE it into Workspace.", params: { name: { type: "string", req: true } } },
    { name: "script_new", description: "Create a Script, LocalScript, or ModuleScript.", params: { className: { type: "string", req: false }, parent: { type: "string", req: false }, name: { type: "string", req: false }, source: { type: "string", req: false } } },
    { name: "set_primary_part", description: "Set Model.PrimaryPart.", params: { path: { type: "string", req: false }, part: { type: "string", req: false } } },
    { name: "select_class", description: "Select descendants of a class.", params: { className: { type: "string", req: true }, root: { type: "string", req: false } } },
    { name: "snap_position", description: "Snap a part/model to a grid.", params: { path: { type: "string", req: false }, grid: { type: "number", req: false } } },
    { name: "camera_focus", description: "Point the Studio camera at an instance.", params: { path: { type: "string", req: false } } },
    { name: "particle_add", description: "Add a ParticleEmitter to a part.", params: { path: { type: "string", req: false } } },
    { name: "highlight_clear", description: "Remove Highlight instances in Workspace.", params: {} },
    { name: "duplicate_n", description: "Clone an instance N times along X.", params: { path: { type: "string", req: false }, count: { type: "number", req: false } } },
    { name: "http_get", description: "Fetch official Roblox Engine API / create.roblox.com docs. url or query.", params: { url: { type: "string", req: false }, query: { type: "string", req: false } } },
    { name: "skill", description: "Specialized Studio knowledge: debug, remotes, pathfinding, datastore, ui, physics, tween.", params: { name: { type: "string", req: false, desc: "debug|remotes|pathfinding|datastore|ui|physics|tween" } } },
    { name: "instance_new", description: "Instance.new(className) parented into the place.", params: { className: { type: "string", req: true }, parent: { type: "string", req: false }, name: { type: "string", req: false } } },
    { name: "get_service", description: "game:GetService(name).", params: { service: { type: "string", req: true } } },
    { name: "get_children", description: ":GetChildren() of an instance - name, class and full path of each child. path is a full path (game.Workspace.House) or just an instance name (searched under Workspace/ReplicatedStorage/ServerStorage/StarterGui...); omit it to use the current Selection. className filters (e.g. Model, BasePart).", params: { path: { type: "string", req: false }, className: { type: "string", req: false }, limit: { type: "number", req: false, desc: "default 200" } } },
    { name: "get_descendants", description: ":GetDescendants() on a path or the selection.", params: { path: { type: "string", req: false }, limit: { type: "number", req: false } } },
    { name: "find_first_child", description: ":FindFirstChild(name, recursive?).", params: { path: { type: "string", req: false }, name: { type: "string", req: true }, recursive: { type: "boolean", req: false } } },
    { name: "wait_for_child", description: ":WaitForChild(name, timeout).", params: { path: { type: "string", req: false }, name: { type: "string", req: true }, timeout: { type: "number", req: false } } },
    { name: "pivot_to", description: ":PivotTo(CFrame) on a Model or BasePart.", params: { path: { type: "string", req: false }, position: { type: "array", req: true } } },
    { name: "register_collision_group", description: "PhysicsService:RegisterCollisionGroup(name).", params: { group: { type: "string", req: true } } },
    { name: "get_datastore", description: "DataStoreService:GetDataStore(name).", params: { name: { type: "string", req: true } } },
    { name: "set_waypoint", description: "ChangeHistoryService:SetWaypoint for undo.", params: { name: { type: "string", req: false } } },
    { name: "debris_add", description: "Debris:AddItem(instance, lifetime).", params: { path: { type: "string", req: true }, lifetime: { type: "number", req: false } } },
  ];

  const orig = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = buildBridge(op, args);
    if (extra) return extra;
    return orig(op, args);
  };
  // Never advertise the same command twice: an earlier skill file may already
  // define script_grep / instance_new with different parameter names. The
  // bridge handler above accepts both spellings, so merge the parameter docs
  // into the existing catalogue entry instead of listing a conflicting twin.
  for (const c of BRIDGE) {
    const existing = RobloxScriptSkills.SKILL_COMMANDS.find(function (x) { return x.name === c.name; });
    if (!existing) { RobloxScriptSkills.SKILL_COMMANDS.push(c); continue; }
    existing.params = existing.params || {};
    for (const k of Object.keys(c.params || {})) {
      if (!existing.params[k]) existing.params[k] = Object.assign({}, c.params[k], { req: false, desc: (c.params[k].desc ? c.params[k].desc + " " : "") + "(alias)" });
    }
  }
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
})();
