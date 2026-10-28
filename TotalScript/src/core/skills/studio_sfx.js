// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript production SFX pack (1.92.0) - sound EVENTS instead of loose
// Sound instances, layered on RobloxScriptSkills like studio_cutscene.js.
//
// Why (Phase 115 audit): sound_library / jingle / ambient_loop shipped
// consecutive made-up asset ids (1837875052..60), impact_sound_effect and
// friends answered "configured" and created nothing, and no command could say
// whether an id actually loads. This pack never invents an id:
//   * the built-in catalogue only references engine-bundled files
//     (rbxasset://sounds/... shipped inside the Roblox client - the same files
//     RbxCharacterSounds and the classic tools use); events that have no
//     bundled counterpart are shipped as `missing` and say so;
//   * sfx_event_define accepts the user's own rbxassetid:// ids and verifies
//     them in Studio (MarketplaceService:GetProductInfo type 3 = Audio,
//     ContentProvider:PreloadAsync status) - the report says verified /
//     unavailable / unverifiable, never "done".
//
//   ReplicatedStorage.TotalSFX          ModuleScript - runtime: TotalSFX.play(event, where, opts) -> Sound | nil, reason
//   ReplicatedStorage.TotalSFX.Events   ModuleScript - the event table (generated from the EventsJSON attribute)
//   SoundService.Master/{SFX,UI,Music,Ambience}  SoundGroups - mixing buses (created on install, reused if present)
//
// Commands: sfx_library_install, sfx_event_define, sfx_event_play, sfx_validate, sfx_events_list.
// Conventions as in studio_vfxpro.js (plain Lua 5.4 runtime, no raw newlines in Luau strings).
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const VERSION = "1.92.0";
  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  const num = (v) => { const x = Number(v); return isFinite(x) ? x : null; };
  const lua = RobloxScriptSkills.luaLiteral || function lua(v) {
    if (v === null || v === undefined) return "nil";
    if (typeof v === "number") return isFinite(v) ? String(v) : "0";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return q(v);
    if (Array.isArray(v)) return "{" + v.map(lua).join(",") + "}";
    return "{" + Object.keys(v).filter((k) => v[k] !== undefined).map((k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : "[" + q(k) + "]") + "=" + lua(v[k])).join(",") + "}";
  };
  const eventName = (v) => String(v || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

  // Engine-bundled files. Source: Roblox client content/sounds (RbxCharacterSounds,
  // classic gear). These are referenced by path, not by a numeric id, so they
  // cannot be "invented"; whether a given client build still ships one is what
  // sfx_validate / PreloadAsync answers in Studio.
  const ENGINE = (file) => "rbxasset://sounds/" + file;
  const CATALOGUE = {
    impact: { ids: [ENGINE("metal.ogg")], volume: 0.55, pitch: [0.92, 1.08], spatial: true, min: 8, max: 80, group: "SFX", cooldown: 0.04, note: "classic sword hit (metal); replace with a licensed impact for shipping" },
    hit: { ids: [ENGINE("collide.wav")], volume: 0.5, pitch: [0.95, 1.1], spatial: true, min: 8, max: 70, group: "SFX", cooldown: 0.04 },
    swing: { ids: [ENGINE("swordslash.wav")], volume: 0.5, pitch: [0.94, 1.06], spatial: true, min: 6, max: 50, group: "SFX", cooldown: 0.05 },
    swing_heavy: { ids: [ENGINE("swordlunge.wav")], volume: 0.55, pitch: [0.9, 1.0], spatial: true, min: 6, max: 50, group: "SFX", cooldown: 0.05 },
    unsheath: { ids: [ENGINE("unsheath.wav")], volume: 0.5, pitch: [0.97, 1.03], spatial: true, min: 6, max: 40, group: "SFX", cooldown: 0.1 },
    whoosh: { ids: [ENGINE("swoosh.wav")], volume: 0.45, pitch: [0.9, 1.1], spatial: true, min: 6, max: 50, group: "SFX", cooldown: 0.05 },
    zap: { ids: [ENGINE("electronicpingshort.wav")], volume: 0.45, pitch: [0.85, 1.15], spatial: true, min: 8, max: 60, group: "SFX", cooldown: 0.03 },
    explosion: { ids: [ENGINE("Rocket shot.wav")], volume: 0.7, pitch: [0.85, 0.95], spatial: true, min: 20, max: 200, group: "SFX", cooldown: 0.1, note: "stand-in (rocket shot); replace with a licensed explosion" },
    release: { ids: [ENGINE("paintball.wav")], volume: 0.5, pitch: [0.9, 1.05], spatial: true, min: 8, max: 70, group: "SFX", cooldown: 0.05 },
    rocket_launch: { ids: [ENGINE("Shoulder fired rocket.wav")], volume: 0.6, pitch: [0.95, 1.05], spatial: true, min: 12, max: 120, group: "SFX", cooldown: 0.1 },
    rocket_fly: { ids: [ENGINE("Rocket whoosh 01.wav")], volume: 0.5, pitch: [0.95, 1.05], spatial: true, min: 10, max: 90, group: "SFX", cooldown: 0.1 },
    teleport: { ids: [ENGINE("flashbulb.wav")], volume: 0.45, pitch: [0.9, 1.0], spatial: true, min: 8, max: 60, group: "SFX", cooldown: 0.1, note: "stand-in (flash); replace with a licensed whoosh/shimmer" },
    camera: { ids: [ENGINE("flashbulb.wav")], volume: 0.4, pitch: [1, 1], spatial: false, group: "UI", cooldown: 0.1 },
    glass_break: { ids: [ENGINE("glassbreak.wav")], volume: 0.6, pitch: [0.95, 1.05], spatial: true, min: 10, max: 90, group: "SFX", cooldown: 0.05 },
    ui_click: { ids: [ENGINE("button.wav")], volume: 0.35, pitch: [0.98, 1.02], spatial: false, group: "UI", cooldown: 0.03 },
    ui_confirm: { ids: [ENGINE("clickfast.wav")], volume: 0.35, pitch: [1, 1], spatial: false, group: "UI", cooldown: 0.05 },
    ui_toggle: { ids: [ENGINE("switch.wav")], volume: 0.35, pitch: [0.98, 1.02], spatial: false, group: "UI", cooldown: 0.05 },
    victory: { ids: [ENGINE("victory.wav")], volume: 0.5, pitch: [1, 1], spatial: false, group: "UI", cooldown: 1 },
    jump: { ids: [ENGINE("action_jump.mp3")], volume: 0.45, pitch: [0.95, 1.05], spatial: true, min: 6, max: 40, group: "SFX", cooldown: 0.1 },
    land: { ids: [ENGINE("action_jump_land.mp3")], volume: 0.5, pitch: [0.95, 1.05], spatial: true, min: 6, max: 40, group: "SFX", cooldown: 0.1 },
    footstep: { ids: [ENGINE("action_footsteps_plastic.mp3")], volume: 0.35, pitch: [0.9, 1.1], spatial: true, min: 4, max: 30, group: "SFX", cooldown: 0.12 },
    splash: { ids: [ENGINE("impact_water.mp3")], volume: 0.5, pitch: [0.95, 1.05], spatial: true, min: 8, max: 60, group: "SFX", cooldown: 0.1 },
    fall: { ids: [ENGINE("action_falling.mp3")], volume: 0.4, pitch: [1, 1], spatial: true, min: 6, max: 40, group: "SFX", cooldown: 0.2 },
    get_up: { ids: [ENGINE("action_get_up.mp3")], volume: 0.4, pitch: [1, 1], spatial: true, min: 6, max: 40, group: "SFX", cooldown: 0.2 },
    death: { ids: [ENGINE("uuhhh.mp3")], volume: 0.5, pitch: [0.95, 1.05], spatial: true, min: 8, max: 60, group: "SFX", cooldown: 0.5 },
    ouch: { ids: [ENGINE("Kid saying Ouch.wav")], volume: 0.45, pitch: [0.95, 1.05], spatial: true, min: 6, max: 40, group: "SFX", cooldown: 0.2 },
    ghost: { ids: [ENGINE("HalloweenGhost.wav")], volume: 0.45, pitch: [0.9, 1.0], spatial: true, min: 10, max: 80, group: "SFX", cooldown: 0.5 },
    // No bundled counterpart - shipped as missing so the report is honest and
    // the model asks for / verifies a real asset instead of inventing one.
    charge: { ids: [], volume: 0.5, pitch: [0.95, 1.05], spatial: true, min: 8, max: 60, group: "SFX", cooldown: 0.1, missing: "no engine-bundled charge-up sound - define one with sfx_event_define {name:'charge', sound_ids:[...]}" },
    heal: { ids: [], volume: 0.5, pitch: [0.97, 1.03], spatial: true, min: 8, max: 60, group: "SFX", cooldown: 0.1, missing: "no engine-bundled heal chime - define one with sfx_event_define" },
    shield: { ids: [], volume: 0.5, pitch: [0.97, 1.03], spatial: true, min: 8, max: 60, group: "SFX", cooldown: 0.1, missing: "no engine-bundled shield sound - define one with sfx_event_define" },
    ui_error: { ids: [], volume: 0.35, pitch: [1, 1], spatial: false, group: "UI", cooldown: 0.1, missing: "no engine-bundled error buzz - define one with sfx_event_define" },
    music: { ids: [], volume: 0.3, pitch: [1, 1], spatial: false, group: "Music", loop: true, cooldown: 1, missing: "music is always a licensed asset you own - define it with sfx_event_define" },
    ambience: { ids: [], volume: 0.3, pitch: [1, 1], spatial: true, min: 20, max: 200, group: "Ambience", loop: true, cooldown: 1, missing: "ambience loop - define it with sfx_event_define" },
  };
  const CATALOGUE_NAMES = Object.keys(CATALOGUE);
  const GROUPS = { Master: 1, SFX: 0.9, UI: 0.8, Music: 0.6, Ambience: 0.7 };

  const RUNTIME_SRC = [
    "-- TotalScript SFX runtime (TotalSFX) " + VERSION + " - generated by sfx_library_install. Events live in script.Events (regenerated by sfx_event_define).",
    "-- TotalSFX.play(event, where, opts) -> Sound | nil, reason   where: nil (2D) | Vector3 | BasePart | Attachment   opts: {volume=mul, pitch=mul, loop=bool}",
    "-- TotalSFX.stop(event) / stopAll() / events() / get(event) / preload(names) -> {event = status} / setGroupVolume(group, v). Event data is read from script.Events' EventsJSON attribute (always current; the Source is the readable copy).",
    "-- Ids are never invented here: every event is either an engine-bundled rbxasset://sounds file, an id you verified with sfx_event_define, or `missing` (play returns nil, 'missing').",
    "local SoundService = game:GetService('SoundService')",
    "local ContentProvider = game:GetService('ContentProvider')",
    "local Debris = game:GetService('Debris')",
    "local M = {}",
    "M.VERSION = '" + VERSION + "'",
    "M.GROUPS = " + lua(GROUPS),
    "M.DEFAULT_EVENTS = " + lua(CATALOGUE),
    "local rng = Random.new()",
    "local lastPlay = {}",
    "local playing = {}",
    "local HttpService = game:GetService('HttpService')",
    "local cacheRaw, cacheTable = nil, nil",
    "local function events() local data = script:FindFirstChild('Events') if data and data:IsA('ModuleScript') then local raw = data:GetAttribute('EventsJSON') if type(raw) == 'string' and raw ~= '' then if raw ~= cacheRaw then local okD, t = pcall(function() return HttpService:JSONDecode(raw) end) if okD and type(t) == 'table' then cacheRaw, cacheTable = raw, t end end if cacheTable then return cacheTable end end local okR, t = pcall(require, data) if okR and type(t) == 'table' then return t end end return M.DEFAULT_EVENTS end",
    "function M.events() local out = {} for name, def in pairs(events()) do out[#out + 1] = {name = name, ids = def.ids, status = (#(def.ids or {}) == 0) and 'missing' or (def.verified and 'verified' or (tostring(def.ids[1]):sub(1, 9) == 'rbxasset:' and 'engine-bundled' or 'unverified')), group = def.group, spatial = def.spatial == true, note = def.note or def.missing} end table.sort(out, function(a, b) return a.name < b.name end) return out end",
    "function M.get(name) return events()[name] end",
    "function M.groups() local master = SoundService:FindFirstChild('Master') if not master then master = Instance.new('SoundGroup') master.Name = 'Master' master.Volume = M.GROUPS.Master master.Parent = SoundService end for name, vol in pairs(M.GROUPS) do if name ~= 'Master' and not master:FindFirstChild(name) then local g = Instance.new('SoundGroup') g.Name = name g.Volume = vol g.Parent = master end end return master end",
    "function M.setGroupVolume(name, v) local master = M.groups() local g = name == 'Master' and master or master:FindFirstChild(name) if not g then error('TotalSFX: unknown group ' .. tostring(name)) end g.Volume = math.clamp(tonumber(v) or 1, 0, 2) return g end",
    "local function groupOf(name) local master = M.groups() return master:FindFirstChild(name or 'SFX') or master end",
    "local function anchorAt(pos) local p = Instance.new('Part') p.Name = 'TotalSFX_Anchor' p.Anchored = true p.CanCollide = false p.CanQuery = false p.CanTouch = false p.Transparency = 1 p.Size = Vector3.new(0.2, 0.2, 0.2) p.CFrame = CFrame.new(pos) local root = workspace:FindFirstChild('TotalSFXRuntime') if not root then root = Instance.new('Folder') root.Name = 'TotalSFXRuntime' root.Parent = workspace end p.Parent = root return p end",
    "function M.play(name, where, opts) opts = opts or {} local def = events()[name] if not def then return nil, 'unknown event ' .. tostring(name) end if not def.ids or #def.ids == 0 then return nil, 'missing' end local now = os.clock() if def.cooldown and lastPlay[name] and now - lastPlay[name] < def.cooldown then return nil, 'cooldown' end lastPlay[name] = now local s = Instance.new('Sound') s.Name = 'SFX_' .. name s.SoundId = def.ids[rng:NextInteger(1, #def.ids)] s.Volume = (def.volume or 0.5) * (tonumber(opts.volume) or 1) local pr = def.pitch or {1, 1} s.PlaybackSpeed = rng:NextNumber(pr[1], pr[2]) * (tonumber(opts.pitch) or 1) s.Looped = opts.loop == true or def.loop == true s.SoundGroup = groupOf(def.group) local anchor = nil if def.spatial and where ~= nil then s.RollOffMode = Enum.RollOffMode.InverseTapered s.RollOffMinDistance = def.min or 8 s.RollOffMaxDistance = def.max or 80 if typeof(where) == 'Vector3' then anchor = anchorAt(where) s.Parent = anchor elseif typeof(where) == 'Instance' then s.Parent = where else return nil, 'where must be nil, Vector3, BasePart or Attachment' end else s.Parent = SoundService end playing[name] = playing[name] or {} table.insert(playing[name], s) s.Ended:Connect(function() s:Destroy() if anchor then anchor:Destroy() end end) if not s.Looped then Debris:AddItem(s, 12) if anchor then Debris:AddItem(anchor, 12) end end s:Play() return s end",
    "function M.stop(name) for _, s in ipairs(playing[name] or {}) do if s.Parent then s:Stop() s:Destroy() end end playing[name] = {} end",
    "function M.stopAll() for name in pairs(playing) do M.stop(name) end end",
    "function M.preload(names) local list = {} local byId = {} local evs = events() for name, def in pairs(evs) do if not names or table.find(names, name) then for _, id in ipairs(def.ids or {}) do local s = Instance.new('Sound') s.SoundId = id list[#list + 1] = s byId[id] = byId[id] or {} table.insert(byId[id], name) end end end local status = {} for name, def in pairs(evs) do if not names or table.find(names, name) then status[name] = (#(def.ids or {}) == 0) and 'missing' or 'pending' end end if #list > 0 then pcall(function() ContentProvider:PreloadAsync(list, function(id, st) for _, name in ipairs(byId[id] or {}) do status[name] = (st == Enum.AssetFetchStatus.Success) and 'loaded' or 'failed' end end) end) for _, s in ipairs(list) do s:Destroy() end end for name, st in pairs(status) do if st == 'pending' then status[name] = 'unverified' end end return status end",
    "return M",
  ].join("\n");

  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local ReplicatedStorage=game:GetService('ReplicatedStorage')",
    "local SoundService=game:GetService('SoundService')",
    "local ContentProvider=game:GetService('ContentProvider')",
    "local MarketplaceService=game:GetService('MarketplaceService')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local RUNTIME_VERSION=" + q(VERSION),
    "local RUNTIME_SRC=" + q(RUNTIME_SRC),
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end",
    "local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end if lp=='workspace' then return workspace end local cur=game for seg in p:gmatch('[^%.]+') do if cur==game and seg:lower()=='workspace' then cur=workspace else local nxt=cur:FindFirstChild(seg) if not nxt and cur==game then local okS,svc=pcall(function() return game:GetService(seg) end) if okS then nxt=svc end end if not nxt then return nil end cur=nxt end end return cur end",
    "local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('TotalScript SFX') end) return okW and w or nil end",
    "local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end",
    "local function luaStr(s) return string.format('%q',tostring(s)) end",
    "local function fmt(n) n=tonumber(n) or 0 if math.abs(n-math.floor(n+0.5))<1e-6 then return tostring(math.floor(n+0.5)) end local s=string.format('%.4f',n) s=s:gsub('0+$','') s=s:gsub('%.$','') return s end",
    "local function renderEvents(evs) local names={} for k in pairs(evs) do names[#names+1]=k end table.sort(names) local L={} L[#L+1]='-- TotalScript SFX events (generated by sfx_event_define / sfx_library_install; edit with those commands, not by hand)' L[#L+1]='return {' for _,k in ipairs(names) do local d=evs[k] local ids={} for i,id in ipairs(d.ids or {}) do ids[i]=luaStr(id) end local pr=d.pitch or {1,1} L[#L+1]='  '..k..' = {ids = {'..table.concat(ids,', ')..'}, volume = '..fmt(d.volume or 0.5)..', pitch = {'..fmt(pr[1])..', '..fmt(pr[2])..'}, spatial = '..tostring(d.spatial==true)..', min = '..fmt(d.min or 8)..', max = '..fmt(d.max or 80)..', group = '..luaStr(d.group or 'SFX')..', cooldown = '..fmt(d.cooldown or 0.05)..(d.loop and ', loop = true' or '')..(d.verified and ', verified = true' or '')..(d.note and (', note = '..luaStr(d.note)) or '')..(d.missing and (', missing = '..luaStr(d.missing)) or '')..'},' end L[#L+1]='}' return table.concat(L,'\\n') end",
    "local function ensureRuntime() local made={} local mod=ReplicatedStorage:FindFirstChild('TotalSFX') if mod and not mod:IsA('ModuleScript') then mod:Destroy() mod=nil end if not mod then mod=Instance.new('ModuleScript') mod.Name='TotalSFX' mod.Parent=ReplicatedStorage made[#made+1]='TotalSFX' end if mod:GetAttribute('TotalVersion')~=RUNTIME_VERSION then mod.Source=RUNTIME_SRC mod:SetAttribute('TotalVersion',RUNTIME_VERSION) mod:SetAttribute('TotalSFX',true) if #made==0 then made[#made+1]='TotalSFX (upgraded)' end end local data=mod:FindFirstChild('Events') if not data then data=Instance.new('ModuleScript') data.Name='Events' data.Parent=mod local lib=require(mod) local evs={} for k,v in pairs(lib.DEFAULT_EVENTS) do evs[k]=v end data:SetAttribute('EventsJSON',HttpService:JSONEncode(evs)) data.Source=renderEvents(evs) made[#made+1]='TotalSFX.Events' end return mod,data,made end",
    "local function loadEvents(data) local okD,evs=pcall(function() return HttpService:JSONDecode(data:GetAttribute('EventsJSON') or '') end) if not okD or type(evs)~='table' then evs={} end return evs end",
    "local function saveEvents(data,evs) data:SetAttribute('EventsJSON',HttpService:JSONEncode(evs)) data.Source=renderEvents(evs) data:SetAttribute('Events',(function() local n=0 for _ in pairs(evs) do n=n+1 end return n end)()) end",
    "local function ensureGroups() local master=SoundService:FindFirstChild('Master') local made={} if not master then master=Instance.new('SoundGroup') master.Name='Master' master.Volume=1 master.Parent=SoundService made[#made+1]='Master' end for _,g in ipairs({{'SFX',0.9},{'UI',0.8},{'Music',0.6},{'Ambience',0.7}}) do if not master:FindFirstChild(g[1]) then local sg=Instance.new('SoundGroup') sg.Name=g[1] sg.Volume=g[2] sg.Parent=master made[#made+1]=g[1] end end return made end",
    "local function normId(id) id=tostring(id or ''):gsub('^%s+',''):gsub('%s+$','') if id=='' then return nil end if id:match('^%d+$') then return 'rbxassetid://'..id end local n=id:match('^rbxassetid://(%d+)$') or id:match('^https?://www%.roblox%.com/asset/%?id=(%d+)$') or id:match('^http://www%.roblox%.com/asset/%?id=(%d+)$') if n then return 'rbxassetid://'..n end if id:match('^rbxasset://') then return id end return nil end",
    "local function verifyId(id) local rec={id=id} local n=id:match('^rbxassetid://(%d+)$') if n then local okI,info=pcall(function() return MarketplaceService:GetProductInfo(tonumber(n)) end) if okI and type(info)=='table' then rec.name=info.Name rec.asset_type=info.AssetTypeId if info.AssetTypeId==3 then rec.status='verified' else rec.status='not-audio' rec.reason='asset type '..tostring(info.AssetTypeId)..' is not Audio (3)' end else rec.status='unverifiable' rec.reason='GetProductInfo failed: '..tostring(info) end else rec.status='engine-bundled' end local s=Instance.new('Sound') s.SoundId=id local fetched=nil pcall(function() ContentProvider:PreloadAsync({s},function(_,st) fetched=st end) end) s:Destroy() if fetched~=nil then rec.preload=(fetched==Enum.AssetFetchStatus.Success) and 'loaded' or 'failed' if rec.preload=='failed' and rec.status~='not-audio' then rec.status='unavailable' rec.reason='PreloadAsync reported '..tostring(fetched.Name)..' - private, moderated or deleted audio' end end return rec end",
  ].join("\n");

  const B = {};

  B.sfx_library_install = () => [
    "local rec=wp() local mod,data,made=ensureRuntime() local groups=ensureGroups() wpDone(rec)",
    "local lib=require(mod) local list=lib.events() local bundled,missing,user=0,0,0 for _,e in ipairs(list) do if e.status=='missing' then missing=missing+1 elseif e.status=='engine-bundled' then bundled=bundled+1 else user=user+1 end end",
    "local missingNames={} for _,e in ipairs(list) do if e.status=='missing' then missingNames[#missingNames+1]=e.name end end",
    "return ok({module=mod:GetFullName(),version=lib.VERSION,installed=made,groups_created=groups,events=#list,engine_bundled=bundled,user_defined=user,missing=missingNames,usage='local SFX=require(game.ReplicatedStorage.TotalSFX) SFX.play(\"impact\", hitPosition) -- 2D: SFX.play(\"ui_click\"); returns nil, reason when an event has no verified asset'},",
    "  'TotalSFX '..lib.VERSION..' ready at '..mod:GetFullName()..': '..#list..' events ('..bundled..' engine-bundled, '..user..' user-defined, '..missing..' missing: '..table.concat(missingNames,', ')..'). Missing events play nothing until you sfx_event_define them with real asset ids; sfx_validate checks every id in this Studio.')",
  ].join("\n");

  B.sfx_event_define = (a) => {
    const name = eventName(a.name || a.event);
    if (!name) return "return fail('name is required (snake_case event name such as fireball_release)')";
    let ids = Array.isArray(a.sound_ids) ? a.sound_ids : (a.sound_id || a.id ? [a.sound_id || a.id] : (Array.isArray(a.ids) ? a.ids : []));
    ids = ids.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 8);
    if (!ids.length) return "return fail('sound_ids is required: one or more rbxassetid:// ids you own / have verified (random variation when several). TotalScript does not invent sound ids.')";
    const def = {};
    if (num(a.volume) !== null) def.volume = Math.max(0, Math.min(2, num(a.volume)));
    const spread = num(a.pitch_spread);
    if (spread !== null) def.pitch = [Math.max(0.5, 1 - Math.abs(spread)), Math.min(2, 1 + Math.abs(spread))];
    if (a.spatial !== undefined) def.spatial = a.spatial === true || a.spatial === "true";
    if (num(a.min_distance) !== null) def.min = num(a.min_distance);
    if (num(a.max_distance) !== null) def.max = num(a.max_distance);
    if (a.group) def.group = String(a.group);
    if (num(a.cooldown) !== null) def.cooldown = Math.max(0, num(a.cooldown));
    if (a.loop !== undefined) def.loop = a.loop === true || a.loop === "true";
    if (a.note) def.note = String(a.note).slice(0, 200);
    const allowUnverified = a.allow_unverified === true || a.allow_unverified === "true";
    return [
      "local rec=wp() local mod,data=ensureRuntime() local evs=loadEvents(data)",
      "local raw=" + lua(ids) + " local ids={} local checks={} local bad={}",
      "for _,r in ipairs(raw) do local id=normId(r) if not id then bad[#bad+1]=tostring(r)..' (not an asset id)' else local v=verifyId(id) checks[#checks+1]=v if v.status=='verified' or v.status=='engine-bundled' then ids[#ids+1]=id elseif v.status=='unverifiable' and " + (allowUnverified ? "true" : "false") + " then ids[#ids+1]=id else bad[#bad+1]=id..' ('..v.status..(v.reason and (': '..v.reason) or '')..')' end end end",
      "if #ids==0 then wpDone(rec) return fail('no usable audio id for event " + name + ": '..table.concat(bad,'; ')..'. Use an audio asset you own or that is public, or pass allow_unverified:true when GetProductInfo is blocked in this Studio.') end",
      "local prev=evs[" + q(name) + "] or {}",
      "local def=" + lua(def),
      "local spatial=true if def.spatial~=nil then spatial=def.spatial elseif prev.spatial~=nil then spatial=prev.spatial end local loop=nil if def.loop~=nil then loop=def.loop elseif prev.loop then loop=true end",
      "local merged={ids=ids,volume=def.volume or prev.volume or 0.5,pitch=def.pitch or prev.pitch or {0.97,1.03},spatial=spatial,min=def.min or prev.min or 8,max=def.max or prev.max or 80,group=def.group or prev.group or 'SFX',cooldown=def.cooldown or prev.cooldown or 0.05,loop=loop,note=def.note or prev.note,verified=true}",
      "if merged.group~='SFX' and merged.group~='UI' and merged.group~='Music' and merged.group~='Ambience' then merged.group='SFX' end",
      "evs[" + q(name) + "]=merged saveEvents(data,evs) ensureGroups() wpDone(rec)",
      "return ok({event=" + q(name) + ",ids=ids,checks=checks,rejected=bad,definition=merged,module=data:GetFullName()},'SFX event " + name + " defined with '..#ids..' asset(s) ('..(function() local s={} for _,c in ipairs(checks) do s[#s+1]=c.id..' = '..c.status..(c.preload and (' / preload '..c.preload) or '') end return table.concat(s,', ') end)()..')'..(#bad>0 and ('; rejected: '..table.concat(bad,'; ')) or '')..'. Play it: TotalSFX.play(\"" + name + "\", position) or sfx_event_play.')",
    ].join("\n");
  };

  B.sfx_event_play = (a) => {
    const name = eventName(a.event || a.name);
    if (!name) return "return fail('event is required (sfx_events_list shows them)')";
    const path = a.path || a.parent_path || "";
    const pos = Array.isArray(a.position) && a.position.length >= 3 ? a.position.slice(0, 3).map((x) => num(x) || 0) : null;
    const vol = num(a.volume);
    return [
      "local mod=ensureRuntime() local lib=require(mod)",
      path ? "local where=resolve(" + q(path) + ") if not where then return fail('path not found: " + String(path).replace(/'/g, "") + "') end if where:IsA('Model') then where=where.PrimaryPart or where:FindFirstChildWhichIsA('BasePart') end" : (pos ? "local where=Vector3.new(" + pos.join(",") + ")" : "local where=nil"),
      "local def=lib.get(" + q(name) + ") if not def then return fail('unknown SFX event " + name + " - sfx_events_list shows the catalogue; sfx_event_define adds one') end",
      "local s,reason=lib.play(" + q(name) + ",where," + (vol !== null ? "{volume=" + vol + "}" : "nil") + ")",
      "if not s then if reason=='missing' then return fail('event " + name + " has no asset: '..tostring(def.missing or 'define it with sfx_event_define {name, sound_ids}')..' - nothing was played') end return fail('could not play " + name + ": '..tostring(reason)) end",
      "return ok({event=" + q(name) + ",sound=s:GetFullName(),sound_id=s.SoundId,volume=s.Volume,playback_speed=s.PlaybackSpeed,spatial=def.spatial==true and where~=nil,group=s.SoundGroup and s.SoundGroup.Name or nil,is_loaded=s.IsLoaded,note='playing in Studio now; IsLoaded false means the asset did not decode (private / moderated) - run sfx_validate'},'SFX " + name + " -> '..s.SoundId..' at '..s:GetFullName()..(s.IsLoaded and '' or ' (NOT loaded yet - check sfx_validate)'))",
    ].join("\n");
  };

  B.sfx_validate = (a) => {
    const only = Array.isArray(a.events) ? a.events.map(eventName).filter(Boolean) : null;
    return [
      "local mod,data=ensureRuntime() local lib=require(mod) local evs=loadEvents(data)",
      "local only=" + (only ? lua(only) : "nil"),
      "local report={} local counts={verified=0,engine_bundled=0,missing=0,unavailable=0,unverifiable=0,not_audio=0}",
      "local names={} for k in pairs(evs) do if not only or table.find(only,k) then names[#names+1]=k end end table.sort(names)",
      "for _,k in ipairs(names) do local d=evs[k] local entry={event=k,ids={}} if #(d.ids or {})==0 then entry.status='missing' entry.reason=d.missing or 'no asset id' counts.missing=counts.missing+1 else local worst='verified' for _,id in ipairs(d.ids) do local v=verifyId(id) entry.ids[#entry.ids+1]=v if v.status=='engine-bundled' and worst=='verified' then worst='engine-bundled' end if v.status=='unverifiable' and (worst=='verified' or worst=='engine-bundled') then worst='unverifiable' end if v.status=='unavailable' or v.status=='not-audio' then worst=v.status end end entry.status=worst local key=worst:gsub('%-','_') counts[key]=(counts[key] or 0)+1 end report[#report+1]=entry end",
      "local problems={} for _,e in ipairs(report) do if e.status~='verified' and e.status~='engine-bundled' then problems[#problems+1]=e.event..' = '..e.status end end",
      "return ok({events=#report,counts=counts,report=report,problems=problems,runtime=mod:GetFullName(),note='verified = GetProductInfo says Audio; engine-bundled = rbxasset:// file shipped with the client (preload status included when Studio reports it); unavailable = preload failed (private / moderated); unverifiable = GetProductInfo blocked here'},",
      "  'SFX validation: '..#report..' events - '..counts.verified..' verified, '..counts.engine_bundled..' engine-bundled, '..counts.missing..' missing, '..counts.unavailable..' unavailable, '..counts.unverifiable..' unverifiable, '..counts.not_audio..' not audio'..(#problems>0 and ('. Needs attention: '..table.concat(problems,', ')) or '. All events have real assets.'))",
    ].join("\n");
  };

  B.sfx_events_list = () => [
    "local mod=ensureRuntime() local lib=require(mod) local list=lib.events()",
    "return ok({events=list,count=#list,groups={'Master','SFX','UI','Music','Ambience'}},#list..' SFX events (sfx_event_define adds / overrides one; sfx_validate checks the ids)')",
  ].join("\n");

  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const C = [
    { name: "sfx_library_install", description: "Install / upgrade TotalSFX (ReplicatedStorage.TotalSFX runtime + Events table + SoundService Master/SFX/UI/Music/Ambience SoundGroups): named sound EVENTS with volume, pitch variation, spatial roll-off, cooldown and cleanup. The built-in catalogue only uses engine-bundled rbxasset://sounds files (" + CATALOGUE_NAMES.filter((n) => CATALOGUE[n].ids.length).join(", ") + "); events without a bundled file (" + CATALOGUE_NAMES.filter((n) => !CATALOGUE[n].ids.length).join(", ") + ") are reported as missing until sfx_event_define gives them a real id. Scripts: require(ReplicatedStorage.TotalSFX).play(event, positionOrPart).", params: {} },
    { name: "sfx_event_define", description: "Define or override a sound event from asset ids YOU provide (never invented): each id is checked in Studio (MarketplaceService audio type + PreloadAsync) and the result says verified / unavailable / unverifiable. Several ids = random variation.", params: { name: S("string", true, "event name, e.g. fireball_release, ui_click, footstep"), sound_ids: S("array", true, "[\"rbxassetid://123\", \"456\"] audio asset ids (1-8)"), volume: S("number", false, "0-2 (default 0.5)"), pitch_spread: S("number", false, "random PlaybackSpeed +/- (default 0.03)"), spatial: S("boolean", false, "3D with roll-off (default true; false for UI)"), min_distance: S("number", false, "RollOffMinDistance studs (default 8)"), max_distance: S("number", false, "RollOffMaxDistance studs (default 80)"), group: S("string", false, "SFX | UI | Music | Ambience"), cooldown: S("number", false, "seconds between plays (default 0.05)"), loop: S("boolean", false, "looping (music / ambience)"), allow_unverified: S("boolean", false, "accept ids GetProductInfo cannot check in this Studio (still preload-tested)") } },
    { name: "sfx_event_play", description: "Play a TotalSFX event now (2D, at a position or on a part) and report the actual SoundId, group and IsLoaded. Missing events fail loudly instead of playing silence.", params: { event: S("string", true, "event name"), path: S("string", false, "BasePart / Attachment / Model to play on (spatial)"), position: S("array", false, "[x,y,z] world position (spatial)"), volume: S("number", false, "multiplier") } },
    { name: "sfx_validate", description: "Check every TotalSFX event's asset ids in this Studio: verified (Audio asset) / engine-bundled / missing / unavailable (private, moderated, deleted) / unverifiable. Real diagnostics, no guesses.", params: { events: S("array", false, "only these event names") } },
    { name: "sfx_events_list", hidden: true, description: "List TotalSFX events with their status.", params: {} },
  ];

  function buildSfx(op, args) {
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
    const extra = buildSfx(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const names = new Set(C.map((c) => c.name));
  const arr = RobloxScriptSkills.SKILL_COMMANDS;
  for (let i = arr.length - 1; i >= 0; i--) if (names.has(arr[i].name)) arr.splice(i, 1);
  for (const c of C) arr.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.SFX_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.SFX_CATALOGUE = CATALOGUE;
  RobloxScriptSkills.SFX_EVENT_NAMES = CATALOGUE_NAMES;
  RobloxScriptSkills.SFX_RUNTIME_SRC = RUNTIME_SRC;
  RobloxScriptSkills.SFX_VERSION = VERSION;
  RobloxScriptSkills.sfxEventName = eventName;
})();
