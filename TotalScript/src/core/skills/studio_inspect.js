// TotalScript 1.33 — read-only Studio inspection pack.
// Replaces the former 100 filler inspect_*/query_* commands (which all emitted
// the same child-listing Luau and, worse, referenced helpers that were never
// defined - every one of them failed at runtime with "attempt to call a nil
// value") with TWO real commands:
//   inspect_service  {service, depth?, limit?}            - bounded tree + key properties
//   query_instances  {class|kind, root?, name?, limit?}   - class / health queries across the place
// The 100 legacy names stay callable (hidden aliases → the two builders) so
// older transcripts, saved task lists and memories keep working, but they are
// no longer advertised in the catalogue, the reminder, or the embedded index.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const LUA = String.raw`local HttpService=game:GetService('HttpService')
local A=HttpService:JSONDecode([==[__ARGS__]==])
local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t}) end
local function fail(m) return HttpService:JSONEncode({ok=false,error=m}) end
local function resolve(p)
  if p==nil or p=='' then return nil end
  p=tostring(p)
  if p=='game' then return game end
  if p:lower()=='workspace' then return workspace end
  if p:sub(1,5)=='game.' then p=p:sub(6) end
  local x=game
  for s in string.gmatch(p,'[^.]+') do
    local nx=x:FindFirstChild(s)
    if not nx and x==game then local okS,svc=pcall(function() return game:GetService(s) end) if okS then nx=svc end end
    if not nx then return nil end
    x=nx
  end
  return x
end
local function srcOf(i) local okS,s=pcall(function() return i.Source end) if okS and type(s)=='string' then return s end return nil end
local function brief(i)
  local b={name=i.Name,class=i.ClassName,children=#i:GetChildren()}
  if i:IsA('BasePart') then
    b.size={i.Size.X,i.Size.Y,i.Size.Z} b.anchored=i.Anchored b.canCollide=i.CanCollide b.material=i.Material.Name
  elseif i:IsA('LuaSourceContainer') then
    local s=srcOf(i) b.sourceChars=s and #s or nil
    if i:IsA('BaseScript') then b.enabled=i.Enabled end
  elseif i:IsA('Model') then
    b.primaryPart=i.PrimaryPart and i.PrimaryPart.Name or nil
  elseif i:IsA('ScreenGui') then b.enabled=i.Enabled
  elseif i:IsA('GuiObject') then b.visible=i.Visible
  elseif i:IsA('Sound') then b.soundId=i.SoundId b.playing=i.Playing b.volume=i.Volume
  elseif i:IsA('ValueBase') then local okV,v=pcall(function() return i.Value end) if okV then b.value=tostring(v) end
  elseif i:IsA('Attachment') then b.position={i.Position.X,i.Position.Y,i.Position.Z}
  elseif i:IsA('Light') then b.brightness=i.Brightness b.range=i.Range b.enabled=i.Enabled
  elseif i:IsA('ProximityPrompt') then b.actionText=i.ActionText b.objectText=i.ObjectText
  end
  local okA,attrs=pcall(function() return i:GetAttributes() end)
  if okA and next(attrs)~=nil then local n=0 for _ in pairs(attrs) do n=n+1 end b.attributes=n end
  return b
end
local function props(inst,names)
  local out={}
  for _,n in ipairs(names) do local okP,v=pcall(function() return inst[n] end) if okP and v~=nil then if typeof(v)=='EnumItem' then out[n]=v.Name elseif typeof(v)=='Color3' then out[n]={math.floor(v.R*255+0.5),math.floor(v.G*255+0.5),math.floor(v.B*255+0.5)} elseif typeof(v)=='Vector3' then out[n]={v.X,v.Y,v.Z} elseif type(v)=='number' or type(v)=='boolean' or type(v)=='string' then out[n]=v else out[n]=tostring(v) end end end
  return out
end
local function fullName(i) if i==game then return 'game' end return i:GetFullName() end
local function servicePropsFor(inst)
  if inst==nil then return nil end
  if inst==workspace then return props(inst,{'Gravity','FallenPartsDestroyHeight','StreamingEnabled','StreamingMinRadius','StreamingTargetRadius','PhysicsSteppingMethod','SignalBehavior'}) end
  if inst.ClassName=='Lighting' then return props(inst,{'ClockTime','TimeOfDay','Brightness','Ambient','OutdoorAmbient','GlobalShadows','Technology','EnvironmentDiffuseScale','EnvironmentSpecularScale','ExposureCompensation','FogStart','FogEnd','ShadowSoftness'}) end
  if inst.ClassName=='Terrain' then return props(inst,{'WaterColor','WaterTransparency','WaterWaveSize','WaterWaveSpeed','Decoration'}) end
  if inst.ClassName=='Players' then return props(inst,{'MaxPlayers','RespawnTime','CharacterAutoLoads'}) end
  if inst.ClassName=='StarterPlayer' then return props(inst,{'CameraMaxZoomDistance','CameraMinZoomDistance','CharacterWalkSpeed','CharacterJumpPower','CharacterJumpHeight','CharacterUseJumpPower','EnableMouseLockOption','HealthDisplayDistance','NameDisplayDistance'}) end
  if inst.ClassName=='SoundService' then return props(inst,{'AmbientReverb','DistanceFactor','DopplerScale','RolloffScale','RespectFilteringEnabled'}) end
  if inst.ClassName=='StarterGui' then return props(inst,{'ShowDevelopmentGui','ScreenOrientation','ResetPlayerGuiOnSpawn'}) end
  return nil
end
local ROOTS={'Workspace','Lighting','ReplicatedFirst','ReplicatedStorage','ServerScriptService','ServerStorage','StarterGui','StarterPack','StarterPlayer','Teams','SoundService','Players','TextChatService','MaterialService','Chat'}
local function pool(root)
  local out={}
  local function take(r) local okD,d=pcall(function() return r:GetDescendants() end) if okD then for _,i in ipairs(d) do out[#out+1]=i end end end
  if root==game then
    for _,n in ipairs(ROOTS) do local okS,s=pcall(function() return game:GetService(n) end) if okS and s then out[#out+1]=s take(s) end end
  else out[#out+1]=root take(root) end
  return out
end
local function inspect()
  local want=A.service or A.path or A.target or 'Workspace'
  local root=resolve(want)
  if not root then return fail('not found: '..tostring(want)..' (use a service name like Workspace, Lighting, ServerScriptService or a dotted path)') end
  local depth=tonumber(A.depth) or 2
  local limit=tonumber(A.limit) or 80
  local count=0
  local truncated=false
  local function walk(i,d)
    local b=brief(i) b.path=i:GetFullName()
    if d<depth then
      local kids={}
      for _,c in ipairs(i:GetChildren()) do
        if count>=limit then truncated=true break end
        count=count+1
        kids[#kids+1]=walk(c,d+1)
      end
      if #kids>0 then b.items=kids end
    end
    return b
  end
  local tree=walk(root,0)
  tree.truncated=truncated or nil
  local okD,desc=pcall(function() return #root:GetDescendants() end)
  tree.descendantCount=okD and desc or nil
  tree.props=servicePropsFor(root)
  local note=truncated and (' - truncated at limit '..limit..'; raise limit or inspect a child path') or ''
  return ok(tree,'inspected '..root:GetFullName()..' ('..count..' nodes, depth '..depth..')'..note)
end
local function query()
  local kind=tostring(A.kind or 'class')
  local rootP=A.root or A.path or A.target
  local root=game
  if rootP~=nil and rootP~='' then root=resolve(rootP) if not root then return fail('root not found: '..tostring(rootP)) end end
  local rootName=fullName(root)
  local limit=tonumber(A.limit) or 60
  local classes={}
  for c in string.gmatch(tostring(A.class or ''),'[^,%s]+') do classes[#classes+1]=c end
  local nameQ=(A.name~=nil and A.name~='') and tostring(A.name):lower() or nil
  local items={} local total=0
  local function add(i,extra)
    total=total+1
    if #items<limit then local b=brief(i) b.path=i:GetFullName() if extra then for k,v in pairs(extra) do b[k]=v end end items[#items+1]=b end
  end
  local function nameOk(i) return (nameQ==nil) or (i.Name:lower():find(nameQ,1,true)~=nil) end
  local function classOk(i)
    if #classes==0 then return true end
    for _,c in ipairs(classes) do if c=='Instance' or i.ClassName==c or i:IsA(c) then return true end end
    return false
  end
  local P=pool(root)
  local label=kind
  if kind=='class' then
    if #classes==0 and nameQ==nil then return fail('give class (e.g. Script, RemoteEvent, BasePart, ScreenGui; comma list allowed), name, or kind') end
    for _,i in ipairs(P) do if classOk(i) and nameOk(i) then add(i) end end
    label=(#classes>0 and table.concat(classes,'|') or 'any')..(nameQ and (' named *'..nameQ..'*') or '')
  elseif kind=='unanchored' then
    for _,i in ipairs(P) do if i:IsA('BasePart') and not i.Anchored and nameOk(i) then local okJ,j=pcall(function() return #i:GetJoints() end) add(i,{joints=okJ and j or nil}) end end
  elseif kind=='empty_scripts' then
    for _,i in ipairs(P) do if i:IsA('LuaSourceContainer') and nameOk(i) then local s=srcOf(i) if s~=nil and s:match('^%s*$') then add(i) end end end
  elseif kind=='duplicates' then
    local groups={}
    for _,i in ipairs(P) do if i.Parent and nameOk(i) then local key=i.Parent:GetFullName()..'/'..i.Name groups[key]=(groups[key] or 0)+1 end end
    local seen={}
    for _,i in ipairs(P) do if i.Parent then local key=i.Parent:GetFullName()..'/'..i.Name if groups[key] and groups[key]>1 and not seen[key] then seen[key]=true add(i,{copies=groups[key]}) end end end
  elseif kind=='deep' then
    local minDepth=tonumber(A.depth) or 8
    for _,i in ipairs(P) do local d=0 local x=i while x and x~=game do d=d+1 x=x.Parent end if d>minDepth and nameOk(i) then add(i,{depth=d}) end end
  elseif kind=='counts' then
    local rows={}
    local kids=root==game and {} or root:GetChildren()
    if root==game then for _,n in ipairs(ROOTS) do local okS,s=pcall(function() return game:GetService(n) end) if okS and s then kids[#kids+1]=s end end end
    for _,c in ipairs(kids) do local okD,d=pcall(function() return #c:GetDescendants() end) rows[#rows+1]={path=c:GetFullName(),class=c.ClassName,descendants=okD and d or 0} end
    table.sort(rows,function(a,b) return a.descendants>b.descendants end)
    return ok({root=rootName,rows=rows},'descendant counts for '..#rows..' children of '..rootName)
  elseif kind=='attributes' then
    for _,i in ipairs(P) do local okA,attrs=pcall(function() return i:GetAttributes() end) if okA and next(attrs)~=nil and nameOk(i) then local t={} for k,v in pairs(attrs) do t[k]=tostring(v) end add(i,{attrs=t}) end end
  elseif kind=='tags' then
    local CS=game:GetService('CollectionService')
    local rows={}
    local okT,tags=pcall(function() return CS:GetAllTags() end)
    if okT then for _,tag in ipairs(tags) do local okG,list=pcall(function() return CS:GetTagged(tag) end) local sample={} if okG then for n,i in ipairs(list) do if n>5 then break end sample[#sample+1]=i:GetFullName() end end rows[#rows+1]={tag=tag,count=okG and #list or 0,sample=sample} end end
    table.sort(rows,function(a,b) return a.count>b.count end)
    return ok({tags=rows},#rows..' CollectionService tags')
  elseif kind=='leaderstats' then
    for _,i in ipairs(P) do if i:IsA('LuaSourceContainer') then local s=srcOf(i) if s and s:find('leaderstats',1,true) then add(i,{mentions='leaderstats'}) end end end
    for _,pl in ipairs(game:GetService('Players'):GetPlayers()) do local ls=pl:FindFirstChild('leaderstats') if ls then local vals={} for _,v in ipairs(ls:GetChildren()) do local okV,x=pcall(function() return v.Value end) vals[v.Name]=okV and tostring(x) or '?' end add(ls,{player=pl.Name,values=vals}) end end
  elseif kind=='datastores' then
    for _,i in ipairs(P) do if i:IsA('LuaSourceContainer') then local s=srcOf(i) if s and s:find('DataStoreService',1,true) then local stores={} for nm in s:gmatch('Get[%a]*DataStore%s*%(%s*["\']([^"\']+)') do stores[#stores+1]=nm end add(i,{stores=stores}) end end end
  elseif kind=='characters' then
    for _,pl in ipairs(game:GetService('Players'):GetPlayers()) do if pl.Character then local h=pl.Character:FindFirstChildOfClass('Humanoid') add(pl.Character,{player=pl.Name,health=h and h.Health or nil}) end end
    for _,i in ipairs(P) do if i:IsA('Model') and i:FindFirstChildOfClass('Humanoid') and not game:GetService('Players'):GetPlayerFromCharacter(i) and nameOk(i) then local h=i:FindFirstChildOfClass('Humanoid') add(i,{npc=true,health=h and h.Health or nil,rigType=h and h.RigType.Name or nil}) end end
  elseif kind=='settings_workspace' then return ok({workspace=servicePropsFor(workspace),terrain=servicePropsFor(workspace:FindFirstChildOfClass('Terrain'))},'workspace settings')
  elseif kind=='settings_lighting' then
    local L=game:GetService('Lighting') local fx={} for _,c in ipairs(L:GetChildren()) do fx[#fx+1]={name=c.Name,class=c.ClassName,enabled=(pcall(function() return c.Enabled end) and c.Enabled) or nil} end
    return ok({lighting=servicePropsFor(L),effects=fx},'lighting settings + '..#fx..' effects')
  elseif kind=='settings_streaming' then return ok(props(workspace,{'StreamingEnabled','StreamingMinRadius','StreamingTargetRadius','StreamingIntegrityMode','StreamOutBehavior','ModelStreamingBehavior'}),'streaming settings')
  elseif kind=='collision_groups' then
    local PS=game:GetService('PhysicsService')
    local okG,groups=pcall(function() return PS:GetRegisteredCollisionGroups() end)
    local counts={}
    for _,i in ipairs(P) do if i:IsA('BasePart') then counts[i.CollisionGroup]=(counts[i.CollisionGroup] or 0)+1 end end
    local rows={}
    if okG then for _,g in ipairs(groups) do rows[#rows+1]={name=g.name,mask=g.mask,parts=counts[g.name] or 0} end end
    return ok({groups=rows,partsByGroup=counts},#rows..' collision groups')
  elseif kind=='network_ownership' then
    for _,i in ipairs(P) do if i:IsA('BasePart') and not i.Anchored and nameOk(i) then local okO,owner=pcall(function() return i:GetNetworkOwner() end) local okA,auto=pcall(function() return i:GetNetworkOwnershipAuto() end) add(i,{owner=okO and (owner and owner.Name or 'server') or 'n/a',auto=okA and auto or nil}) end end
  else
    return fail('unknown kind '..kind..' (class|unanchored|empty_scripts|duplicates|deep|counts|attributes|tags|leaderstats|datastores|characters|settings_workspace|settings_lighting|settings_streaming|collision_groups|network_ownership)')
  end
  return ok({root=rootName,kind=kind,total=total,shown=#items,items=items},'query '..label..': '..total..' match(es) under '..rootName..(total>#items and (' (showing '..#items..'; raise limit or narrow root)') or ''))
end
if A.mode=='inspect' then return inspect() end
return query()`;

  const KINDS = "class|unanchored|empty_scripts|duplicates|deep|counts|attributes|tags|leaderstats|datastores|characters|settings_workspace|settings_lighting|settings_streaming|collision_groups|network_ownership";

  const C = [
    {
      name: "inspect_service",
      description: "Read-only tree of a service or any instance path: names, classes, child counts and key properties (part size/anchored, script source size, GUI enabled, values) down to `depth`, plus service settings for Workspace/Lighting/Terrain/Players/StarterPlayer/SoundService. Use before editing an unfamiliar place; raise depth/limit or inspect a child path to see more.",
      params: {
        service: { type: "string", req: true, desc: "Workspace | Lighting | ReplicatedStorage | ServerScriptService | StarterGui | ... or a dotted path like Workspace.House" },
        depth: { type: "number", req: false, desc: "levels below the root to expand (default 2)" },
        limit: { type: "number", req: false, desc: "max nodes returned (default 80)" },
      },
    },
    {
      name: "query_instances",
      description: "Read-only search across the place (or under `root`). class = IsA filter, comma list allowed (Script, LocalScript, ModuleScript, RemoteEvent, BasePart, MeshPart, ScreenGui, GuiButton, Sound, ParticleEmitter, Constraint, Tool, Seat, Folder, ValueBase, Attachment, Humanoid ...). kind = health/settings report instead of a class list: " + KINDS.replace(/\|/g, ", ") + ". Returns paths + brief properties; `name` filters by substring.",
      params: {
        class: { type: "string", req: false, desc: "class or comma list (IsA); required unless kind/name given" },
        kind: { type: "string", req: false, desc: KINDS + " (default class)" },
        root: { type: "string", req: false, desc: "path to search under (default whole place)" },
        name: { type: "string", req: false, desc: "case-insensitive name substring filter" },
        limit: { type: "number", req: false, desc: "max items returned (default 60)" },
      },
    },
  ];

  // Legacy names → preset args. `target` on the legacy call maps to root/service.
  const SERVICE_ALIASES = ["workspace","lighting","replicatedstorage","serverstorage","serverscriptservice","startergui","starterpack","starterplayer","soundservice","teams","textchatservice","materialservice","collectionservice","physicsservice","pathfindingservice","teleportservice","marketplaceservice","datastoreservice","memorystoreservice","messagingservice","badgeservice","tweenservice","runservice","httpservice","userinputservice","contextactionservice","players","camera","terrain","coregui","voicechatservice","proximitypromptservice","localizationservice","policyservice","socialservice","avatareditorservice","assetservice","insertservice","chat","debris"];
  const SERVICE_NAMES = { workspace:"Workspace", lighting:"Lighting", replicatedstorage:"ReplicatedStorage", serverstorage:"ServerStorage", serverscriptservice:"ServerScriptService", startergui:"StarterGui", starterpack:"StarterPack", starterplayer:"StarterPlayer", soundservice:"SoundService", teams:"Teams", textchatservice:"TextChatService", materialservice:"MaterialService", collectionservice:"CollectionService", physicsservice:"PhysicsService", pathfindingservice:"PathfindingService", teleportservice:"TeleportService", marketplaceservice:"MarketplaceService", datastoreservice:"DataStoreService", memorystoreservice:"MemoryStoreService", messagingservice:"MessagingService", badgeservice:"BadgeService", tweenservice:"TweenService", runservice:"RunService", httpservice:"HttpService", userinputservice:"UserInputService", contextactionservice:"ContextActionService", players:"Players", camera:"Workspace.Camera", terrain:"Workspace.Terrain", coregui:"CoreGui", voicechatservice:"VoiceChatService", proximitypromptservice:"ProximityPromptService", localizationservice:"LocalizationService", policyservice:"PolicyService", socialservice:"SocialService", avatareditorservice:"AvatarEditorService", assetservice:"AssetService", insertservice:"InsertService", chat:"Chat", debris:"Debris" };
  const QUERY_ALIASES = {
    query_models: { class: "Model" }, query_parts: { class: "BasePart" }, query_meshes: { class: "MeshPart,SpecialMesh" }, query_unions: { class: "UnionOperation" },
    query_scripts: { class: "Script" }, query_localscripts: { class: "LocalScript" }, query_modulescripts: { class: "ModuleScript" },
    query_remotes: { class: "RemoteEvent,RemoteFunction,UnreliableRemoteEvent" }, query_remoteevents: { class: "RemoteEvent" }, query_remotefunctions: { class: "RemoteFunction" },
    query_screen_guis: { class: "ScreenGui" }, query_frames: { class: "Frame,ScrollingFrame" }, query_text_labels: { class: "TextLabel" }, query_buttons: { class: "GuiButton" }, query_image_labels: { class: "ImageLabel" }, query_viewports: { class: "ViewportFrame" },
    query_particle_emitters: { class: "ParticleEmitter" }, query_beams: { class: "Beam" }, query_trails: { class: "Trail" }, query_lights: { class: "Light" }, query_sounds: { class: "Sound" },
    query_attachments: { class: "Attachment" }, query_constraints: { class: "Constraint" }, query_welds: { class: "WeldConstraint,Weld,Motor6D" }, query_prompts: { class: "ProximityPrompt" },
    query_tools: { class: "Tool" }, query_seats: { class: "Seat,VehicleSeat" }, query_vehicles: { class: "VehicleSeat" }, query_spawn_locations: { class: "SpawnLocation" }, query_folders: { class: "Folder" }, query_values: { class: "ValueBase" },
    query_attributes: { kind: "attributes" }, query_tags: { kind: "tags" }, query_animations: { class: "Animation,Animator,AnimationController" }, query_keyframes: { class: "KeyframeSequence" }, query_cameras: { class: "Camera" },
    query_teams: { class: "Team" }, query_players: { class: "Player" }, query_characters: { kind: "characters" }, query_humanoids: { class: "Humanoid" }, query_backpacks: { class: "Backpack" },
    query_leaderstats: { kind: "leaderstats" }, query_datastores: { kind: "datastores" }, query_bindables: { class: "BindableEvent,BindableFunction" }, query_events: { class: "RemoteEvent,BindableEvent,UnreliableRemoteEvent" },
    query_folders_in_workspace: { class: "Folder", root: "Workspace" }, query_scripts_in_server: { class: "Script,ModuleScript", root: "ServerScriptService" }, query_scripts_in_replicated: { class: "Script,LocalScript,ModuleScript", root: "ReplicatedStorage" },
    query_ui_in_startergui: { class: "ScreenGui,GuiObject", root: "StarterGui" }, query_assets_in_replicated: { class: "Instance", root: "ReplicatedStorage" },
    query_unanchored_parts: { kind: "unanchored" }, query_empty_scripts: { kind: "empty_scripts" }, query_duplicate_names: { kind: "duplicates" }, query_deep_children: { kind: "deep" }, query_descendant_counts: { kind: "counts" },
    query_streaming_settings: { kind: "settings_streaming" }, query_workspace_settings: { kind: "settings_workspace" }, query_lighting_settings: { kind: "settings_lighting" }, query_collision_groups: { kind: "collision_groups" }, query_network_ownership: { kind: "network_ownership" },
  };
  const LEGACY = {};
  for (const s of SERVICE_ALIASES) LEGACY["inspect_" + s] = { mode: "inspect", service: SERVICE_NAMES[s] };
  for (const [k, v] of Object.entries(QUERY_ALIASES)) LEGACY[k] = Object.assign({ mode: "query" }, v);
  for (const [name, preset] of Object.entries(LEGACY)) {
    C.push({
      name, hidden: true,
      description: (preset.mode === "inspect" ? "Legacy alias of inspect_service {service:\"" + preset.service + "\"}." : "Legacy alias of query_instances " + JSON.stringify(Object.assign({}, preset, { mode: undefined })).replace(/,"mode":undefined|"mode":undefined,?/g, "") + ".") + " Prefer the new command.",
      params: { target: { type: "string", req: false, desc: "optional instance path override" }, limit: { type: "number", req: false, desc: "max items" } },
    });
  }

  function argsFor(op, args) {
    const a = Object.assign({}, args || {});
    if (op === "inspect_service") { a.mode = "inspect"; return a; }
    if (op === "query_instances") { a.mode = "query"; return a; }
    const preset = LEGACY[op];
    if (!preset) return null;
    const merged = Object.assign({}, preset);
    if (a.target) { if (preset.mode === "inspect") merged.service = a.target; else merged.root = a.target; }
    for (const k of ["depth", "limit", "name", "class", "kind", "root", "service"]) if (a[k] != null && a[k] !== "") merged[k] = a[k];
    return merged;
  }

  function build(op, args) {
    const a = argsFor(op, args);
    if (!a) return null;
    let json = JSON.stringify(a);
    // Long-bracket literal: make sure the payload can never close it early.
    json = json.replace(/\]==\]/g, "] == ]");
    return { code: LUA.replace("__ARGS__", json) };
  }

  const names = new Set(C.map((x) => x.name));
  const prior = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    if (names.has(op)) return build(op, args);
    return typeof prior === "function" ? prior(op, args) : null;
  };
  RobloxScriptSkills.INSPECT_COMMANDS = C;
  // Duplicate setters/creators from earlier packs: a richer command with the
  // same effect already exists (listed after the arrow). Still callable.
  const HIDDEN_DUPLICATES = {
    spawn_location: "spawn_location_create", click_detector: "click_detector_create", billboard: "billboard_gui_create",
    humanoid_max_health_set: "player_max_health", physics_linear_set: "linear_velocity_create", web_api: "api_request",
    cancollide_set: "collision_set / set_property", massless_set: "set_property", can_touch_set: "set_property", can_query_set: "set_property",
    // 1.70.0: two more one-property duplicates so the catalogue stays under budget with model_prefab / model_check added.
    physics_pivot_set: "pivot_set", cast_shadow_set: "set_property",
  };
  for (const [name, better] of Object.entries(HIDDEN_DUPLICATES)) {
    const c = RobloxScriptSkills.SKILL_COMMANDS.find((x) => x && x.name === name);
    if (c && !/^Legacy alias/.test(String(c.description || ""))) { c.hidden = true; c.description = String(c.description || "") + " (Legacy alias; prefer " + better + ".)"; }
  }
  for (const c of C) {
    const existing = RobloxScriptSkills.SKILL_COMMANDS.find((x) => x.name === c.name);
    if (existing) { Object.assign(existing, c); continue; }
    RobloxScriptSkills.SKILL_COMMANDS.push(c);
  }
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name);
})();
