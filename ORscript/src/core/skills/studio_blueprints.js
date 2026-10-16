// ORscript — System Blueprints (BUILD pack, 1.31.0)
//
// Lemonade AI sells "complete systems" generated per prompt. ORscript ships them as
// built-in skills instead: twelve production-grade Roblox systems (currency + data,
// shop, pets, combat, rounds, checkpoints, quests, tycoon, leaderboards, admin,
// anticheat, sprint) sharing one Core (Signal bus, remotes, DataStore profiles with
// session locks, receipts, leaderstats, notifications). Every blueprint installs as a
// Config ModuleScript (edit it or use blueprint_configure), a server Service module,
// an optional client LocalScript and, where it helps, demo content - then verifies
// itself with structural checks plus the Service's own SelfTest() in edit mode.
//
//   blueprint_list        catalogue + what is installed
//   blueprint_install     install one / several / all (dependencies first), configure, demo, verify
//   blueprint_configure   merge or replace a system's Config
//   blueprint_verify      compile + self-test one or all systems
//   blueprint_remove      uninstall (keeps player data; demo / tools optional)
//   blueprint_status      versions, dependency health, remotes, next steps
(() => {
  if (typeof RobloxScriptSkills === "undefined") return;
  const LIB = (typeof window !== "undefined" && window.__ORBlueprintLib) || null;
  if (!LIB || !LIB.BLUEPRINTS || !LIB.CORE_SRC) return;
  const BP_VERSION = LIB.VERSION || "1.31.0";
  const BP = LIB.BLUEPRINTS;
  const NAMES = Object.keys(BP);

  const q = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "").replace(/\n/g, "\\n") + "'";
  const jj = (o) => q(JSON.stringify(o));
  const bb = (v, d) => (v === undefined || v === null ? (d ? "true" : "false") : v ? "true" : "false");

  const NEXT_STEPS = {
    currency: ["Enable Studio access to API services (Game Settings > Security) so DataStore profiles save in Studio.", "Edit Config.Currencies / Rewards; other systems pay through Core.Bus 'Currency.Request'."],
    shop: ["Set GamePassId / ProductId values in Config.Items and Config.CurrencyPacks (cloud_gamepass_create / developer_product_handler_create can create them).", "Put real Tool instances in ServerStorage.OR_Tools named like Config.Items[*].Data.Tool."],
    pets: ["Drop pet Models named by pet Id into ReplicatedStorage.OR_Systems.Pets.Models (placeholders are used until then).", "Wire an egg UI to the Hatch / Chances remotes (ui_screen_generate shop works as a base)."],
    combat: ["Weapon Tools were generated in ServerStorage.OR_Tools - swap Handles for your meshes and add an Animation child.", "Tune Config.Weapons / StatusEffects; Combat.Kill feeds Currency, Quests, Rounds and Leaderboards automatically."],
    rounds: ["Add map Models with Spawn parts to ReplicatedStorage.OR_Systems.Rounds.Maps (a DemoArena was generated).", "Replace the generated timer HUD with your own HUD (ui_screen_generate hud) reading the State folder."],
    checkpoints: ["Build your course: parts named Checkpoint1..N (or with a Stage attribute) under Workspace.OR_Checkpoints.", "Set Config.SkipProductId to sell stage skips."],
    quests: ["Edit Config.Quests - Event names are Bus topics: Combat.Kill, Currency.Earned, Checkpoints.Reached, Pets.Hatched, Shop.Purchased, Round.Won.", "Build a quest panel on the GetQuests / Claim remotes."],
    tycoon: ["Demo plots are at Workspace.OR_Tycoons (x >= 300) - move them, reskin the droppers, extend Config.Buttons.", "Requires Currency (installed automatically)."],
    leaderboards: ["Board parts exist at Workspace.OR_Leaderboards - move them into your lobby.", "OrderedDataStores need API access enabled; boards refresh every Config.RefreshSeconds."],
    admin: ["Add your UserIds to Config.Users (or GroupId + GroupRanks); the place creator is Owner by default.", "Commands: :kick :ban :tp :bring :to :give :speed :heal :kill :respawn :stage :announce :rank."],
    anticheat: ["Playtest first - raise Config.MaxSpeedMultiplier / MaxAirTime if your game has launch pads or flight.", "Sprint publishes OR_MaxSpeed so faster movement is allowed automatically."],
    sprint: ["Change Config.Key / SprintSpeed; the stamina bar hides when full.", "Mobile gets a Sprint button via ContextActionService."],
  };

  // ───────────────────────── catalogue (metadata only; sources stay in the lib) ─────────────────────────
  const CATALOG = NAMES.map((k) => {
    const b = BP[k];
    return { name: k, system: b.system, title: b.title, summary: b.summary, tags: b.tags || [], depends: b.depends || [], bus: b.bus || {}, api: b.api || [], remotes: b.remotes || [], config_keys: Object.keys(b.config || {}), has_client: !!b.client, next_steps: NEXT_STEPS[k] || [] };
  });
  const SYSTEM_NAMES = {};
  for (const k of NAMES) SYSTEM_NAMES[k] = BP[k].system;

  function normNames(v) {
    if (v == null || v === "") return [];
    if (Array.isArray(v)) return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    const s = String(v).trim().toLowerCase();
    if (s === "all" || s === "*") return NAMES.slice();
    return s.split(/[\s,]+/).filter(Boolean);
  }
  function resolveOrder(wanted, withDeps) {
    const out = [];
    const seen = new Set();
    const missing = [];
    const visit = (k, stack) => {
      if (seen.has(k)) return;
      if (!BP[k]) { missing.push(k); return; }
      if (stack.includes(k)) return;
      for (const d of BP[k].depends || []) if (withDeps) visit(d, stack.concat(k));
      seen.add(k);
      out.push(k);
    };
    for (const k of wanted) visit(k, []);
    return { order: out, missing };
  }

  // ───────────────────────── Luau head ─────────────────────────
  const HEAD = `local HttpService=game:GetService('HttpService')
local ReplicatedStorage=game:GetService('ReplicatedStorage')
local ServerScriptService=game:GetService('ServerScriptService')
local ServerStorage=game:GetService('ServerStorage')
local StarterPlayer=game:GetService('StarterPlayer')
local StarterPack=game:GetService('StarterPack')
local Workspace=game:GetService('Workspace')
local ChangeHistoryService=game:GetService('ChangeHistoryService')
local BP_VERSION=${q(BP_VERSION)}
local SYSTEM_NAMES=HttpService:JSONDecode(${jj(SYSTEM_NAMES)})
local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end
local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end
local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end if lp=='workspace' then return Workspace end local n=game for _,seg in ipairs(string.split(p,'.')) do if seg~='' then local nx=nil if n==game then local okS,s=pcall(function() return game:GetService(seg) end) if okS and s then nx=s end end if not nx then nx=n:FindFirstChild(seg) end if not nx then return nil end n=nx end end return n end
local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('ORscript Blueprints') end) return okW and w or nil end
local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end
local function folder(parent,name) local f=parent:FindFirstChild(name) if not f then f=Instance.new('Folder') f.Name=name f.Parent=parent end return f end
local function rsRoot() return folder(ReplicatedStorage,'OR_Systems') end
local function sssRoot() return folder(ServerScriptService,'OR_Systems') end
local function spsRoot() local sps=StarterPlayer:FindFirstChild('StarterPlayerScripts') if not sps then sps=Instance.new('StarterPlayerScripts') sps.Parent=StarterPlayer end return folder(sps,'OR_Systems') end
local function writeModule(parent,name,src,force) local m=parent:FindFirstChild(name) if m and m:IsA('ModuleScript') then if force or m:GetAttribute('OR_Version')~=BP_VERSION then m.Source=src m:SetAttribute('OR_Version',BP_VERSION) return m,'updated' end return m,'kept' end if m then m:Destroy() end m=Instance.new('ModuleScript') m.Name=name m.Source=src m:SetAttribute('OR_Version',BP_VERSION) m.Parent=parent return m,'created' end
local function writeScript(class,parent,name,src,force) local s=parent:FindFirstChild(name) if s and s.ClassName==class then if force or s:GetAttribute('OR_Version')~=BP_VERSION then s.Source=src s:SetAttribute('OR_Version',BP_VERSION) return s,'updated' end return s,'kept' end if s then s:Destroy() end s=Instance.new(class) s.Name=name s.Source=src s:SetAttribute('OR_Version',BP_VERSION) s.Parent=parent return s,'created' end
local function installedSystems() local out={} local rs=ReplicatedStorage:FindFirstChild('OR_Systems') if not rs then return out end for _,c in ipairs(rs:GetChildren()) do if c:IsA('Folder') and c:GetAttribute('OR_Blueprint') then out[#out+1]={key=c:GetAttribute('OR_Blueprint'),system=c.Name,version=c:GetAttribute('OR_BlueprintVersion') or '?',folder=c} end end table.sort(out,function(a,b) return a.key<b.key end) return out end
local function findSystem(key) local rs=ReplicatedStorage:FindFirstChild('OR_Systems') if not rs then return nil end for _,c in ipairs(rs:GetChildren()) do if c:IsA('Folder') and c:GetAttribute('OR_Blueprint')==key then return c end end local sn=SYSTEM_NAMES[key] local f=sn and rs:FindFirstChild(sn) if f and f:IsA('Folder') and f:GetAttribute('OR_Blueprint') then return f end return nil end
local function isInstalled(key) return findSystem(key)~=nil end
local function dependsOf(sys) local js=sys and sys:GetAttribute('OR_Depends') if type(js)~='string' or js=='' then return {} end local okD,d=pcall(function() return HttpService:JSONDecode(js) end) return okD and d or {} end
-- Lua serialisation for Config modules
local KEYWORDS={['and']=1,['break']=1,['do']=1,['else']=1,['elseif']=1,['end']=1,['false']=1,['for']=1,['function']=1,['if']=1,['in']=1,['local']=1,['nil']=1,['not']=1,['or']=1,['repeat']=1,['return']=1,['then']=1,['true']=1,['until']=1,['while']=1}
local function isIdent(k) return type(k)=='string' and string.match(k,'^[%a_][%w_]*$')~=nil and KEYWORDS[k]==nil end
local function isArray(t) if type(t)~='table' then return false end local n=#t if n==0 then return next(t)==nil end for k in pairs(t) do if type(k)~='number' or k<1 or k>n or k~=math.floor(k) then return false end end return true end
local function toLua(v,ind) ind=ind or '' local t=type(v) if t=='string' then return string.format('%q',v) elseif t=='number' then if v==math.floor(v) and math.abs(v)<1e15 then return string.format('%d',v) end return string.format('%.14g',v) elseif t=='boolean' then return tostring(v) elseif t~='table' then return 'nil' end if next(v)==nil then return '{}' end local out={} local ind2=ind..'\\t' if isArray(v) then for i=1,#v do out[#out+1]=ind2..toLua(v[i],ind2) end else local keys={} for k in pairs(v) do keys[#keys+1]=k end table.sort(keys,function(a,b) return tostring(a)<tostring(b) end) for _,k in ipairs(keys) do local ks=isIdent(k) and k or ('['..toLua(k,ind2)..']') out[#out+1]=ind2..ks..' = '..toLua(v[k],ind2) end end return '{\\n'..table.concat(out,',\\n')..',\\n'..ind..'}' end
local function deepCopy(v) if type(v)~='table' then return v end local o={} for k,x in pairs(v) do o[k]=deepCopy(x) end return o end
local function deepMerge(base,over) if type(over)~='table' then return base end if type(base)~='table' then base={} end for k,v in pairs(over) do if type(v)=='table' and type(base[k])=='table' and not isArray(v) and not isArray(base[k]) then deepMerge(base[k],v) else base[k]=deepCopy(v) end end return base end
local function readConfig(sys) local cm=sys and sys:FindFirstChild('Config') if not cm then return nil end local js=cm:GetAttribute('OR_ConfigJSON') if type(js)=='string' and js~='' then local okD,d=pcall(function() return HttpService:JSONDecode(js) end) if okD and type(d)=='table' then return d end end local okR,res=pcall(function() local f=loadstring(cm.Source) return f and f() end) if okR and type(res)=='table' then return res end return nil end
local function writeConfig(sys,systemName,cfg) local cm=sys:FindFirstChild('Config') if cm and not cm:IsA('ModuleScript') then cm:Destroy() cm=nil end if not cm then cm=Instance.new('ModuleScript') cm.Name='Config' cm.Parent=sys end cm.Source='-- '..systemName..' config (generated by ORscript blueprints '..BP_VERSION..'). Edit here or with blueprint_configure; the Service reads it on start.\\nreturn '..toLua(cfg)..'\\n' cm:SetAttribute('OR_ConfigJSON',HttpService:JSONEncode(cfg)) cm:SetAttribute('OR_Version',BP_VERSION) return cm end
-- edit-mode loader: compiles module sources fresh (no require cache) so verify sees the current Config
local function freshRequire(m,seen) seen=seen or {} if seen[m]~=nil then return seen[m] end local f,err=loadstring(m.Source) if not f then error(m.Name..' failed to compile: '..tostring(err)) end local env=setmetatable({script=m},{__index=getfenv()}) env.require=function(x) if typeof(x)=='Instance' and x:IsA('ModuleScript') and (x:GetAttribute('OR_Version')~=nil or x.Name=='Config' or x.Name=='Core') then return freshRequire(x,seen) end return require(x) end setfenv(f,env) local r=f() seen[m]=r return r end
local function ensureCore(force,report) local rs=rsRoot() local _,a=writeModule(rs,'Core',CORE_SRC,force) local sss=sssRoot() local _2,b=writeScript('Script',sss,'CoreServer',CORE_SERVER_SRC,force) local _3,c=writeScript('LocalScript',spsRoot(),'CoreClient',CORE_CLIENT_SRC,force) local remotes=folder(ReplicatedStorage,'Remotes') if not remotes:FindFirstChild('OR_Notify') then local ev=Instance.new('RemoteEvent') ev.Name='OR_Notify' ev.Parent=remotes end if report then report.core={Core=a,CoreServer=b,CoreClient=c} end return rs end
local function toolsFolder() return folder(ServerStorage,'OR_Tools') end
local function makeTool(name,key,size,color,cooldown,clientSrc) local tf=toolsFolder() if tf:FindFirstChild(name) or StarterPack:FindFirstChild(name) then return nil end local t=Instance.new('Tool') t.Name=name t.RequiresHandle=true t.CanBeDropped=false t:SetAttribute('OR_Blueprint',key) if cooldown then t:SetAttribute('Cooldown',cooldown) end local h=Instance.new('Part') h.Name='Handle' h.Size=size h.Color=color h.Material=Enum.Material.Metal h.CanCollide=false h.Parent=t t.Grip=CFrame.new(0,-size.Y/2+0.5,0) if clientSrc then local ls=Instance.new('LocalScript') ls.Name='OR_WeaponClient' ls.Source=clientSrc ls.Parent=t end t.Parent=tf return t end
local TOOLS={}
TOOLS.combat=function(cfg,extra,report) local made={} for name,w in pairs(cfg.Weapons or {}) do if w.Tool then local staff=(w.Range or 0)>15 local t=makeTool(name,'combat',staff and Vector3.new(0.6,6,0.6) or Vector3.new(0.8,4,0.8),staff and Color3.fromRGB(120,60,200) or Color3.fromRGB(200,200,210),w.Cooldown or 0.5,extra and extra.toolClient) if t then made[#made+1]=t:GetFullName() end end end return made end
TOOLS.shop=function(cfg,extra,report) local made={} for _,item in ipairs(cfg.Items or {}) do if item.Type=='tool' and item.Data and item.Data.Tool then local t=makeTool(item.Data.Tool,'shop',Vector3.new(1,3,1),Color3.fromRGB(230,180,60),nil,nil) if t then made[#made+1]=t:GetFullName()..' (placeholder)' end end end return made end
local function part(name,size,cf,color,parent,props) local p=Instance.new('Part') p.Name=name p.Size=size p.CFrame=cf p.Anchored=true p.TopSurface=Enum.SurfaceType.Smooth p.BottomSurface=Enum.SurfaceType.Smooth if color then p.Color=color end for k,v in pairs(props or {}) do pcall(function() p[k]=v end) end p.Parent=parent return p end
local function label(parent,text,face) local g=Instance.new('SurfaceGui') g.Face=face or Enum.NormalId.Top g.SizingMode=Enum.SurfaceGuiSizingMode.PixelsPerStud g.PixelsPerStud=30 local l=Instance.new('TextLabel') l.Size=UDim2.new(1,0,1,0) l.BackgroundTransparency=1 l.TextScaled=true l.Font=Enum.Font.GothamBlack l.TextColor3=Color3.new(1,1,1) l.TextStrokeTransparency=0.3 l.Text=text l.Parent=g g.Parent=parent return l end
local function billboard(parent,text) local b=Instance.new('BillboardGui') b.Size=UDim2.new(0,170,0,56) b.StudsOffset=Vector3.new(0,3,0) b.AlwaysOnTop=false local l=Instance.new('TextLabel') l.Size=UDim2.new(1,0,1,0) l.BackgroundColor3=Color3.fromRGB(16,16,22) l.BackgroundTransparency=0.25 l.TextScaled=true l.Font=Enum.Font.GothamBold l.TextColor3=Color3.new(1,1,1) l.Text=text l.Parent=b local c=Instance.new('UICorner') c.CornerRadius=UDim.new(0,8) c.Parent=l b.Parent=parent return l end
local function demoFolder(path,key,defaultName) local f=resolve(path) if f then return f,false end local segs=string.split(tostring(path or ''),'.') local parent=Workspace if #segs>=2 then local p=resolve(table.concat(segs,'.',1,#segs-1)) if p then parent=p end end local name=segs[#segs] if name==nil or name=='' then name=defaultName end f=Instance.new('Folder') f.Name=name f:SetAttribute('OR_BlueprintDemo',key) f.Parent=parent return f,true end
local DEMO={}
DEMO.checkpoints=function(cfg,sys) local f,fresh=demoFolder(cfg.Folder or 'Workspace.OR_Checkpoints','checkpoints','OR_Checkpoints') if not fresh and #f:GetChildren()>0 then return nil end f:SetAttribute('OR_BlueprintDemo','checkpoints') local n=math.max(1,math.floor(tonumber(cfg.DemoCount) or 10)) local sp=tonumber(cfg.DemoSpacing) or 18 local origin=Vector3.new(0,80,120) local start=Instance.new('SpawnLocation') start.Name='Start' start.Size=Vector3.new(14,1,14) start.Anchored=true start.CFrame=CFrame.new(origin) start.Color=Color3.fromRGB(60,160,90) start.Parent=f label(start,'START') local made={f:GetFullName()} for i=1,n do local pos=origin+Vector3.new((i%2==0) and 5 or -5,i*1.5,i*sp) local hue=(i-1)/n local plat=part('Platform'..i,Vector3.new(12,1,12),CFrame.new(pos),Color3.fromHSV(hue,0.5,0.8),f) local cp=part('Checkpoint'..i,Vector3.new(6,0.4,6),CFrame.new(pos+Vector3.new(0,0.7,0)),Color3.fromHSV(hue,0.9,1),f,{Material=Enum.Material.Neon,CanCollide=false}) cp:SetAttribute('Stage',i) label(cp,tostring(i)) if i==n then label(plat,'FINISH') end end return made end
DEMO.tycoon=function(cfg,sys) local f,fresh=demoFolder(cfg.PlotsFolder or 'Workspace.OR_Tycoons','tycoon','OR_Tycoons') if not fresh and #f:GetChildren()>0 then return nil end f:SetAttribute('OR_BlueprintDemo','tycoon') local made={f:GetFullName()} local count=math.max(1,math.floor(tonumber(cfg.Plots) or 4)) for i=1,count do local o=Vector3.new(300+(i-1)*90,0,300) local plot=Instance.new('Model') plot.Name='Plot'..i local base=part('Base',Vector3.new(70,1,70),CFrame.new(o+Vector3.new(0,0.5,0)),Color3.fromRGB(70,72,80),plot) plot.PrimaryPart=base part('ClaimPad',Vector3.new(8,0.4,8),CFrame.new(o+Vector3.new(0,1.2,-30)),Color3.fromRGB(80,220,120),plot,{Material=Enum.Material.Neon}) local cash=part('CashPad',Vector3.new(6,0.4,6),CFrame.new(o+Vector3.new(-20,1.2,-30)),Color3.fromRGB(255,200,60),plot,{Material=Enum.Material.Neon}) label(cash,'$') part('Collector',Vector3.new(10,4,3),CFrame.new(o+Vector3.new(0,3,21)),Color3.fromRGB(40,40,48),plot) local conv=part('Conveyor',Vector3.new(6,1,36),CFrame.new(o+Vector3.new(0,1.5,2)),Color3.fromRGB(30,30,36),plot) conv.AssemblyLinearVelocity=Vector3.new(0,0,8) local sign=part('Sign',Vector3.new(12,4,0.6),CFrame.new(o+Vector3.new(0,9,-34)),Color3.fromRGB(20,20,26),plot) local sl=label(sign,'Unclaimed',Enum.NormalId.Back) sl.Name='OwnerSign' local buttons=folder(plot,'Buttons') local objects=folder(plot,'Objects') local dropperIdx=0 local upgradeIdx=0 for j,b in ipairs(cfg.Buttons or {}) do local bp=part('Button_'..b.Id,Vector3.new(5,0.4,5),CFrame.new(o+Vector3.new(-28+(j-1)*9,1.2,-20)),Color3.fromRGB(90,160,255),buttons,{Material=Enum.Material.Neon}) bp:SetAttribute('ButtonId',b.Id) billboard(bp,tostring(b.Name)..'\\n$'..tostring(b.Cost or 0)) if b.Unlocks then local obj=Instance.new('Model') obj.Name=b.Unlocks if string.find(string.lower(b.Unlocks),'dropper') then dropperIdx=dropperIdx+1 obj:SetAttribute('Dropper',true) obj:SetAttribute('ValueMultiplier',1+(dropperIdx-1)*0.5) local z=-12+(dropperIdx-1)*8 part('Pole',Vector3.new(1,7,1),CFrame.new(o+Vector3.new(4,4.5,z)),Color3.fromRGB(60,60,70),obj) part('Arm',Vector3.new(5,0.6,1),CFrame.new(o+Vector3.new(2,7.7,z)),Color3.fromRGB(60,60,70),obj) local spout=part('Spout',Vector3.new(2,2,2),CFrame.new(o+Vector3.new(0,7,z)),Color3.fromRGB(255,120,60),obj) obj.PrimaryPart=spout else upgradeIdx=upgradeIdx+1 local block=part('Block',Vector3.new(4,4,4),CFrame.new(o+Vector3.new(22,3,-14+(upgradeIdx-1)*7)),Color3.fromRGB(255,200,60),obj,{Material=Enum.Material.Neon}) obj.PrimaryPart=block end obj.Parent=objects end end plot.Parent=f made[#made+1]=plot:GetFullName() end return made end
DEMO.leaderboards=function(cfg,sys) local made={} for i,b in ipairs(cfg.Boards or {}) do if not resolve(b.Part) then local segs=string.split(tostring(b.Part or ''),'.') local name=segs[#segs] local parentPath=#segs>1 and table.concat(segs,'.',1,#segs-1) or 'Workspace' local parent=resolve(parentPath) if not parent and #segs>=2 then local f=demoFolder(parentPath,'leaderboards','OR_Leaderboards') parent=f end parent=parent or Workspace local p=part(name,Vector3.new(12,14,1),CFrame.new(Vector3.new(-30+(i-1)*16,8,-80)),Color3.fromRGB(18,18,24),parent) p:SetAttribute('OR_BlueprintDemo','leaderboards') made[#made+1]=p:GetFullName() end end return made end
DEMO.rounds=function(cfg,sys) local maps=resolve(cfg.MapsFolder) if not maps then maps=folder(sys,'Maps') end if #maps:GetChildren()>0 then return nil end local m=Instance.new('Model') m.Name='DemoArena' m:SetAttribute('OR_BlueprintDemo','rounds') local o=Vector3.new(0,150,0) local floor=part('Floor',Vector3.new(90,1,90),CFrame.new(o),Color3.fromRGB(90,110,120),m) m.PrimaryPart=floor for k,d in ipairs({Vector3.new(0,0,45),Vector3.new(0,0,-45),Vector3.new(45,0,0),Vector3.new(-45,0,0)}) do part('Wall'..k,(d.X==0) and Vector3.new(90,8,1) or Vector3.new(1,8,90),CFrame.new(o+d+Vector3.new(0,4,0)),Color3.fromRGB(60,70,80),m) end for k,c in ipairs({Vector3.new(30,0,30),Vector3.new(-30,0,30),Vector3.new(30,0,-30),Vector3.new(-30,0,-30)}) do part('Spawn'..k,Vector3.new(4,1,4),CFrame.new(o+c+Vector3.new(0,0.6,0)),Color3.fromRGB(255,220,80),m,{CanCollide=false,Transparency=0.5}) end for k=1,4 do local a=(k-1)*math.pi/2 part('Pillar'..k,Vector3.new(4,10,4),CFrame.new(o+Vector3.new(math.cos(a)*14,5.5,math.sin(a)*14)),Color3.fromRGB(120,120,130),m) end m.Parent=maps return {m:GetFullName()} end
local function installSystem(key,meta,defaults,serviceSrc,clientSrc,overrides,opts,report) local sys=folder(rsRoot(),meta.system) local fresh=sys:GetAttribute('OR_Blueprint')==nil sys:SetAttribute('OR_Blueprint',key) sys:SetAttribute('OR_BlueprintVersion',BP_VERSION) sys:SetAttribute('OR_Depends',HttpService:JSONEncode(meta.depends or {})) folder(sys,'Remotes') local existing=(not opts.reset_config) and readConfig(sys) or nil local cfg=deepMerge(deepMerge(deepCopy(defaults),existing or {}),overrides or {}) writeConfig(sys,meta.system,cfg) local ss=folder(sssRoot(),meta.system) ss:SetAttribute('OR_Blueprint',key) local _,how=writeModule(ss,'Service',serviceSrc,opts.force or fresh) report.written[#report.written+1]=ss:GetFullName()..'.Service ('..how..')' if clientSrc then local _2,h2=writeScript('LocalScript',spsRoot(),meta.system..'Client',clientSrc,opts.force or fresh) report.written[#report.written+1]='StarterPlayerScripts.OR_Systems.'..meta.system..'Client ('..h2..')' end report.written[#report.written+1]=sys:GetFullName()..'.Config ('..(existing and 'merged' or 'created')..')' if opts.demo~=false and DEMO[key] then local okD,made=pcall(DEMO[key],cfg,sys) if okD then for _,x in ipairs(made or {}) do report.demo[#report.demo+1]=x end else report.warnings[#report.warnings+1]='demo '..key..': '..tostring(made) end end report.installed[#report.installed+1]=key return cfg end
local function verifySystem(key) local r={name=key,checks={},passed=0,failed=0} local function check(name,okC,detail) local c={name=name,ok=okC and true or false} if detail~=nil then c.detail=tostring(detail) end r.checks[#r.checks+1]=c if okC then r.passed=r.passed+1 else r.failed=r.failed+1 end end local sys=findSystem(key) check('ReplicatedStorage.OR_Systems.'..tostring(SYSTEM_NAMES[key] or key)..' installed',sys~=nil) if not sys then return r end r.system=sys.Name r.version=sys:GetAttribute('OR_BlueprintVersion') local cm=sys:FindFirstChild('Config') check('Config module',cm~=nil and cm:IsA('ModuleScript')) check('Remotes folder',sys:FindFirstChild('Remotes')~=nil) local core=ReplicatedStorage:FindFirstChild('OR_Systems') and ReplicatedStorage.OR_Systems:FindFirstChild('Core') check('Core module',core~=nil) local sss=ServerScriptService:FindFirstChild('OR_Systems') check('CoreServer boot script',sss~=nil and sss:FindFirstChild('CoreServer')~=nil) local ss=sss and sss:FindFirstChild(sys.Name) local svc=ss and ss:FindFirstChild('Service') check('Service module',svc~=nil and svc:IsA('ModuleScript')) for _,d in ipairs(dependsOf(sys)) do check('dependency '..tostring(d)..' installed',isInstalled(d)) end if r.version~=BP_VERSION then check('blueprint version '..tostring(r.version)..' == '..BP_VERSION..' (reinstall with force to update)',false) end if cm and svc and core then local seen={} local okC,cfgOrErr=pcall(freshRequire,cm,seen) check('Config compiles',okC and type(cfgOrErr)=='table',(not okC) and cfgOrErr or nil) local okS,svcOrErr=pcall(freshRequire,svc,seen) check('Service compiles and requires Core',okS and type(svcOrErr)=='table',(not okS) and svcOrErr or nil) if okS and type(svcOrErr)=='table' then check('Service exposes Start()',type(svcOrErr.Start)=='function') if type(svcOrErr.SelfTest)=='function' then local okT,res=pcall(svcOrErr.SelfTest) if not okT then check('SelfTest runs',false,res) else for _,c in ipairs(res or {}) do check('self-test: '..tostring(c.name),c.ok) end end end end end return r end
local function statusReport() local list=installedSystems() local out={version=BP_VERSION,systems={},problems={}} local rs=ReplicatedStorage:FindFirstChild('OR_Systems') local core=rs and rs:FindFirstChild('Core') local sss=ServerScriptService:FindFirstChild('OR_Systems') local sps=StarterPlayer:FindFirstChild('StarterPlayerScripts') local spsR=sps and sps:FindFirstChild('OR_Systems') out.core={module=core~=nil,version=core and core:GetAttribute('OR_Version') or nil,server=sss~=nil and sss:FindFirstChild('CoreServer')~=nil,client=spsR~=nil and spsR:FindFirstChild('CoreClient')~=nil,notify_remote=ReplicatedStorage:FindFirstChild('Remotes')~=nil and ReplicatedStorage.Remotes:FindFirstChild('OR_Notify')~=nil} if #list>0 and not core then out.problems[#out.problems+1]='Core module missing - run blueprint_install again' end if core and core:GetAttribute('OR_Version')~=BP_VERSION then out.problems[#out.problems+1]='Core is version '..tostring(core:GetAttribute('OR_Version'))..', pack is '..BP_VERSION..' (blueprint_install force:true refreshes it)' end for _,s in ipairs(list) do local sys=s.folder local remotes={} local rf=sys:FindFirstChild('Remotes') if rf then for _,x in ipairs(rf:GetChildren()) do remotes[#remotes+1]=x.Name..':'..x.ClassName end end local cfg=readConfig(sys) local keys={} for k in pairs(cfg or {}) do keys[#keys+1]=tostring(k) end table.sort(keys) local missing={} for _,d in ipairs(dependsOf(sys)) do if not isInstalled(d) then missing[#missing+1]=d end end local ss=sss and sss:FindFirstChild(s.system) local entry={name=s.key,system=s.system,version=s.version,service=ss~=nil and ss:FindFirstChild('Service')~=nil,client=spsR~=nil and spsR:FindFirstChild(s.system..'Client')~=nil,remotes=remotes,config_keys=keys,missing_dependencies=missing} out.systems[#out.systems+1]=entry for _,d in ipairs(missing) do out.problems[#out.problems+1]=s.key..' needs '..d..' (blueprint_install '..d..')' end if not entry.service then out.problems[#out.problems+1]=s.key..' has no Service module (reinstall)' end end local tools={} local tf=ServerStorage:FindFirstChild('OR_Tools') if tf then for _,t in ipairs(tf:GetChildren()) do if t:GetAttribute('OR_Blueprint') then tools[#tools+1]=t.Name..' ('..t:GetAttribute('OR_Blueprint')..')' end end end out.generated_tools=tools return out end
`;

  // Core sources are only embedded by commands that need them (install) to keep the other programs small.
  const CORE_DEFS = "local CORE_SRC=" + q(LIB.CORE_SRC) + "\nlocal CORE_SERVER_SRC=" + q(LIB.CORE_SERVER_SRC) + "\nlocal CORE_CLIENT_SRC=" + q(LIB.CORE_CLIENT_SRC) + "\n";
  const CORE_STUBS = "local CORE_SRC,CORE_SERVER_SRC,CORE_CLIENT_SRC='','',''\n";

  // ───────────────────────── command bodies ─────────────────────────
  const B = {};

  B.blueprint_list = (a) => {
    const tag = a.tag ? String(a.tag).toLowerCase() : "";
    const list = CATALOG.filter((c) => !tag || c.tags.includes(tag) || c.name.includes(tag) || c.title.toLowerCase().includes(tag));
    return [
      "local catalog=HttpService:JSONDecode(" + jj(list.map((c) => ({ name: c.name, system: c.system, title: c.title, summary: c.summary, tags: c.tags, depends: c.depends, api: c.api, remotes: c.remotes, bus: c.bus, has_client: c.has_client, config_keys: c.config_keys }))) + ")",
      "local installed={} for _,s in ipairs(installedSystems()) do installed[s.key]=s.version end",
      "local out={} local n=0 for _,c in ipairs(catalog) do c.installed=installed[c.name]~=nil c.installed_version=installed[c.name] if not " + bb(a.installed_only, false) + " or c.installed then out[#out+1]=c if c.installed then n=n+1 end end end",
      "return ok({version=BP_VERSION,count=#out,installed_count=n,blueprints=out,usage='blueprint_install {name:\"pets\"} installs with dependencies, demo content and a self-test; blueprint_install {name:\"all\"} installs everything.'},#out..' blueprints ('..n..' installed)')",
    ].join("\n");
  };

  B.blueprint_install = (a) => {
    const wanted = normNames(a.name || a.names || a.blueprint || a.blueprints);
    if (!wanted.length) throw new Error("name is required (one of: " + NAMES.join(", ") + ", or 'all')");
    const withDeps = a.install_dependencies !== false;
    const { order, missing } = resolveOrder(wanted, withDeps);
    if (missing.length) throw new Error("unknown blueprint(s): " + missing.join(", ") + " (known: " + NAMES.join(", ") + ")");
    const cfgIn = a.config && typeof a.config === "object" ? a.config : a.params && typeof a.params === "object" ? a.params : {};
    const perSystem = Object.keys(cfgIn).length > 0 && Object.keys(cfgIn).every((k) => BP[k] && cfgIn[k] && typeof cfgIn[k] === "object" && !Array.isArray(cfgIn[k]));
    const overridesFor = (k) => {
      if (perSystem) return cfgIn[k] || {};
      return wanted.includes(k) ? cfgIn : {};
    };
    const opts = { force: !!a.force, demo: a.demo !== false, reset_config: !!a.reset_config };
    const lines = [
      "local opts=HttpService:JSONDecode(" + jj(opts) + ")",
      "local report={installed={},written={},demo={},tools={},warnings={},skipped={}}",
      "local cfgs,extras={},{}",
      "local rec=wp()",
      "ensureCore(opts.force,report)",
    ];
    if (!withDeps) {
      for (const k of order) for (const d of BP[k].depends || []) if (!order.includes(d)) lines.push("if not isInstalled(" + q(d) + ") then report.warnings[#report.warnings+1]=" + q(k + " depends on " + d + " which is not installed (install_dependencies:false)") + " end");
    }
    for (const k of order) {
      const b = BP[k];
      const meta = { system: b.system, depends: b.depends || [] };
      const extra = b.toolClient ? { toolClient: b.toolClient } : null;
      lines.push("extras[" + q(k) + "]=" + (extra ? "{toolClient=" + q(extra.toolClient) + "}" : "nil"));
      lines.push("cfgs[" + q(k) + "]=installSystem(" + q(k) + ",HttpService:JSONDecode(" + jj(meta) + "),HttpService:JSONDecode(" + jj(b.config || {}) + ")," + q(b.service) + "," + (b.client ? q(b.client) : "nil") + ",HttpService:JSONDecode(" + jj(overridesFor(k)) + "),opts,report)");
    }
    lines.push("for _,k in ipairs({'combat','shop'}) do if cfgs[k] and TOOLS[k] then local okT,made=pcall(TOOLS[k],cfgs[k],extras[k],report) if okT then for _,x in ipairs(made or {}) do report.tools[#report.tools+1]=x end else report.warnings[#report.warnings+1]='tools '..k..': '..tostring(made) end end end");
    lines.push("wpDone(rec)");
    if (a.verify !== false) {
      lines.push("report.verify={} local failed=0 for _,k in ipairs(report.installed) do local okV,r=pcall(verifySystem,k) if okV then report.verify[#report.verify+1]=r failed=failed+r.failed else report.verify[#report.verify+1]={name=k,error=tostring(r),failed=1,passed=0} failed=failed+1 end end report.verify_failed=failed");
    }
    const steps = [];
    for (const k of order) for (const s of NEXT_STEPS[k] || []) steps.push(k + ": " + s);
    steps.push("Press Play to boot: ServerScriptService.OR_Systems.CoreServer starts the Data layer and every installed Service; use blueprint_status / blueprint_verify any time.");
    lines.push("report.next_steps=HttpService:JSONDecode(" + jj(steps) + ")");
    lines.push("report.layout={replicated='ReplicatedStorage.OR_Systems.{Core,<System>.{Config,Remotes}}',server='ServerScriptService.OR_Systems.{CoreServer,<System>.Service}',client='StarterPlayer.StarterPlayerScripts.OR_Systems.{CoreClient,<System>Client}',tools='ServerStorage.OR_Tools'}");
    lines.push("local txt='installed '..table.concat(report.installed,', ')..' (v'..BP_VERSION..')' if report.verify_failed then txt=txt..(report.verify_failed==0 and ' - all self-tests passed' or ' - '..report.verify_failed..' check(s) failed, see verify') end if #report.demo>0 then txt=txt..'; demo content: '..#report.demo..' item(s)' end");
    lines.push("return ok(report,txt)");
    return { body: lines.join("\n"), core: true };
  };

  B.blueprint_configure = (a) => {
    const names = normNames(a.name || a.blueprint);
    if (names.length !== 1) throw new Error("name must be exactly one blueprint (" + NAMES.join(", ") + ")");
    const k = names[0];
    if (!BP[k]) throw new Error("unknown blueprint: " + k);
    const cfg = a.config && typeof a.config === "object" ? a.config : a.params && typeof a.params === "object" ? a.params : null;
    if (!cfg && !a.reset) throw new Error("config object is required (or reset:true to restore defaults)");
    return [
      "local sys=findSystem(" + q(k) + ")",
      "if not sys then error(" + q(k + " is not installed - blueprint_install first") + ") end",
      "local defaults=HttpService:JSONDecode(" + jj(BP[k].config || {}) + ")",
      "local over=HttpService:JSONDecode(" + jj(cfg || {}) + ")",
      "local existing=readConfig(sys) or {}",
      "local cfg",
      a.reset ? "cfg=deepMerge(deepCopy(defaults),over)" : a.replace ? "cfg=deepMerge(deepCopy(defaults),over)" : "cfg=deepMerge(deepMerge(deepCopy(defaults),existing),over)",
      "local rec=wp() local cm=writeConfig(sys,sys.Name,cfg) wpDone(rec)",
      "local changed={} for key in pairs(over) do changed[#changed+1]=tostring(key) end table.sort(changed)",
      "local r={name=" + q(k) + ",system=sys.Name,module=cm:GetFullName(),changed_keys=changed,config=cfg}",
      "if " + bb(a.verify, true) + " then local okV,v=pcall(verifySystem," + q(k) + ") r.verify=okV and v or {error=tostring(v)} end",
      "return ok(r,'updated '..cm:GetFullName()..' ('..#changed..' key(s))'..((r.verify and r.verify.failed and r.verify.failed>0) and ' - '..r.verify.failed..' check(s) failed' or ''))",
    ].join("\n");
  };

  B.blueprint_verify = (a) => {
    const names = normNames(a.name || a.names || "all");
    const all = !a.name || names.length === NAMES.length;
    for (const k of names) if (!BP[k]) throw new Error("unknown blueprint: " + k);
    return [
      "local targets={}",
      all ? "for _,s in ipairs(installedSystems()) do targets[#targets+1]=s.key end" : "for _,k in ipairs(HttpService:JSONDecode(" + jj(names) + ")) do targets[#targets+1]=k end",
      "if #targets==0 then return ok({systems={},passed=0,failed=0},'no blueprints installed') end",
      "local out={systems={},passed=0,failed=0,failures={}}",
      "for _,k in ipairs(targets) do local okV,r=pcall(verifySystem,k) if not okV then r={name=k,checks={{name='verify crashed',ok=false,detail=tostring(r)}},passed=0,failed=1} end out.systems[#out.systems+1]=r out.passed=out.passed+r.passed out.failed=out.failed+r.failed for _,c in ipairs(r.checks) do if not c.ok then out.failures[#out.failures+1]=k..': '..c.name..(c.detail and (' - '..c.detail) or '') end end end",
      "return ok(out,out.passed..' passed, '..out.failed..' failed across '..#out.systems..' system(s)')",
    ].join("\n");
  };

  B.blueprint_remove = (a) => {
    const names = normNames(a.name || a.names || a.blueprint);
    if (!names.length) throw new Error("name is required (blueprint name, list, or 'all')");
    for (const k of names) if (!BP[k]) throw new Error("unknown blueprint: " + k);
    return [
      "local names=HttpService:JSONDecode(" + jj(names) + ")",
      "local report={removed={},warnings={},kept_data='player DataStore profiles are never deleted'}",
      "local rec=wp()",
      "local want={} for _,k in ipairs(names) do want[k]=true end",
      "for _,s in ipairs(installedSystems()) do if not want[s.key] then for _,d in ipairs(dependsOf(s.folder)) do if want[d] then report.warnings[#report.warnings+1]=s.key..' depends on '..d..' and stays installed' end end end end",
      "for _,k in ipairs(names) do local sys=findSystem(k) local sn=sys and sys.Name or SYSTEM_NAMES[k] if sys then report.removed[#report.removed+1]=sys:GetFullName() sys:Destroy() end local sss=ServerScriptService:FindFirstChild('OR_Systems') local ss=sss and sn and sss:FindFirstChild(sn) if ss then report.removed[#report.removed+1]=ss:GetFullName() ss:Destroy() end local sps=StarterPlayer:FindFirstChild('StarterPlayerScripts') local spsR=sps and sps:FindFirstChild('OR_Systems') local cl=spsR and sn and spsR:FindFirstChild(sn..'Client') if cl then report.removed[#report.removed+1]=cl:GetFullName() cl:Destroy() end",
      " if not " + bb(a.keep_tools, false) + " then local tf=ServerStorage:FindFirstChild('OR_Tools') if tf then for _,t in ipairs(tf:GetChildren()) do if t:GetAttribute('OR_Blueprint')==k then report.removed[#report.removed+1]=t:GetFullName() t:Destroy() end end end end",
      " if not " + bb(a.keep_demo, false) + " then local function sweep(parent) for _,c in ipairs(parent:GetChildren()) do if c:GetAttribute('OR_BlueprintDemo')==k then report.removed[#report.removed+1]=c:GetFullName() c:Destroy() elseif c:IsA('Folder') or c:IsA('Model') then sweep(c) end end end sweep(Workspace) end",
      "end",
      "local left=installedSystems()",
      "if #left==0 and " + bb(a.remove_core, true) + " then local rs=ReplicatedStorage:FindFirstChild('OR_Systems') if rs then report.removed[#report.removed+1]=rs:GetFullName() rs:Destroy() end local sss=ServerScriptService:FindFirstChild('OR_Systems') if sss then report.removed[#report.removed+1]=sss:GetFullName() sss:Destroy() end local sps=StarterPlayer:FindFirstChild('StarterPlayerScripts') local spsR=sps and sps:FindFirstChild('OR_Systems') if spsR then report.removed[#report.removed+1]=spsR:GetFullName() spsR:Destroy() end local tf=ServerStorage:FindFirstChild('OR_Tools') if tf and #tf:GetChildren()==0 then tf:Destroy() end report.core_removed=true end",
      "wpDone(rec)",
      "report.remaining={} for _,s in ipairs(left) do report.remaining[#report.remaining+1]=s.key end",
      "return ok(report,'removed '..table.concat(names,', ')..' ('..#report.removed..' instance(s))'..(report.core_removed and ', Core removed' or ''))",
    ].join("\n");
  };

  B.blueprint_status = () => [
    "local st=statusReport()",
    "st.catalog=HttpService:JSONDecode(" + jj(NAMES) + ")",
    "st.not_installed={} local have={} for _,s in ipairs(st.systems) do have[s.name]=true end for _,k in ipairs(st.catalog) do if not have[k] then st.not_installed[#st.not_installed+1]=k end end",
    "local names={} for _,s in ipairs(st.systems) do names[#names+1]=s.name..' v'..tostring(s.version) end",
    "return ok(st,(#st.systems==0 and 'no blueprints installed' or (#st.systems..' installed: '..table.concat(names,', ')))..(#st.problems>0 and (' - '..#st.problems..' problem(s)') or ''))",
  ].join("\n");

  // ───────────────────────── command specs ─────────────────────────
  const S = (type, req, desc) => ({ type, req: !!req, desc: desc || "" });
  const NAME_DESC = NAMES.join("|") + "|all";
  const C = [
    { name: "blueprint_list", description: "Catalogue of the built-in system blueprints (" + NAMES.join(", ") + ") with summary, dependencies, server API, remotes, Bus topics and whether each is installed in this place. Filter by tag/word.", params: { tag: S("string", false, "economy|gameplay|progression|monetization|security|... or a word"), installed_only: S("boolean", false) } },
    { name: "blueprint_install", description: "Install one, several or all blueprints as real systems: shared Core (Signal bus, Core.Remote, DataStore profiles with session locks + autosave + BindToClose, single ProcessReceipt dispatcher, leaderstats, notifications) + per-system Config ModuleScript (defaults merged with your config), server Service ModuleScript, client LocalScript, generated weapon Tools / demo course / plots / boards / arena, then a structural + SelfTest verification in edit mode. Dependencies (e.g. shop -> currency) install first. Re-running keeps your edited Config and only refreshes code when the pack version changed (force:true rewrites).", params: { name: S("string", true, NAME_DESC + " (string, list or comma-separated)"), config: S("object", false, "Config overrides for the named system, or {blueprint:{...}} per system when installing several"), force: S("boolean", false, "rewrite Service/Client/Core even if present (Config is kept)"), reset_config: S("boolean", false, "discard an existing Config"), demo: S("boolean", false, "generate demo content when the place has none (default true)"), verify: S("boolean", false, "run blueprint_verify after install (default true)"), install_dependencies: S("boolean", false, "default true") } },
    { name: "blueprint_configure", description: "Change a system's Config: deep-merges the given keys into the current Config (arrays replace), rewrites the Config ModuleScript (readable Lua table) + OR_ConfigJSON, then re-verifies. replace:true starts from defaults; reset:true restores defaults.", params: { name: S("string", true, NAMES.join("|")), config: S("object", false, "keys to merge, e.g. {Currencies:[...], Rewards:{OnKill:{Coins:25}}}"), replace: S("boolean", false), reset: S("boolean", false), verify: S("boolean", false, "default true") } },
    { name: "blueprint_verify", description: "Verify one or all installed blueprints without pressing Play: folders / Config / Service / CoreServer present, dependencies installed, version current, Config and Service compile against Core, Start() exposed, and the Service's SelfTest() (pure logic: shop validation, pet odds, combat cooldowns, round state machine, quest progress, tycoon gates, anticheat rules, sprint stamina...). Returns every check with ok/detail.", params: { name: S("string", false, NAME_DESC + " (default all installed)") } },
    { name: "blueprint_remove", description: "Uninstall blueprint(s): removes the ReplicatedStorage / ServerScriptService / StarterPlayerScripts system folders, generated Tools and demo content (keep_tools / keep_demo to keep them). Warns about systems that depend on the removed one. Core is removed when nothing remains (remove_core:false to keep). Player DataStore data is never touched.", params: { name: S("string", true, NAME_DESC), keep_demo: S("boolean", false), keep_tools: S("boolean", false), remove_core: S("boolean", false, "default true when no system remains") } },
    { name: "blueprint_status", description: "Health of the installed systems: Core version and boot scripts, each system's version, Service/Client presence, remotes, config keys, missing dependencies, generated tools, problems list and the not-yet-installed catalogue.", params: {} },
  ];

  function buildBlueprint(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const res = fn(args || {});
      const body = typeof res === "string" ? res : res.body;
      const defs = typeof res === "object" && res.core ? CORE_DEFS : CORE_STUBS;
      return { code: defs + HEAD + "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))" };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + (e && e.message ? e.message : e) };
    }
  }

  const prevBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    if (B[op]) return buildBlueprint(op, args);
    return prevBuild.call(RobloxScriptSkills, op, args);
  };
  const names = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!names.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name);
  RobloxScriptSkills.BLUEPRINT_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.BLUEPRINT_NAMES = NAMES.slice();
  RobloxScriptSkills.BLUEPRINT_CATALOG = CATALOG;
  RobloxScriptSkills.BLUEPRINT_VERSION = BP_VERSION;
  RobloxScriptSkills.blueprintOrder = (names, withDeps) => resolveOrder(normNames(names), withDeps !== false);
})();
