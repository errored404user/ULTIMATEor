// TotalScript — Project Index (BUILD pack, 1.32.0)
//
// Lemonade AI's "codebase awareness" is a hosted index of your place. TotalScript keeps one
// INSIDE the place (ServerStorage.Total_ProjectIndex): every script hashed and outlined
// (functions, requires, remotes, services, DataStores, tags, TODOs, --!strict), the require
// graph with required_by / hubs / orphans / cycles, remote producers vs consumers with
// mismatch detection, the folder layout, the coding conventions in use (indentation,
// naming, strict ratio, frameworks) and the installed blueprints - plus a compact
// PROJECT MAP string that main.js re-injects into the chat so the model works from a
// map instead of re-reading every script. Stale detection by hash, so "what changed
// since the last index" is one command.
//
//   project_index_build      scan + hash + outline every script, write the index, diff vs previous
//   project_index_summary    architecture map from the index (+ cheap staleness check) - the prompt text
//   project_index_search     find symbols / requires / remotes / services / datastores / tags / paths
//   project_index_script     one script's entry: outline, requires, required_by, remote partners, stale?
//   project_index_graph      require graph (edges, hubs, orphans, cycles) or remote matrix (+ mismatches)
//   project_index_changes    rehash now vs the stored index: added / modified / removed (no write)
(() => {
  if (typeof RobloxScriptSkills === "undefined") return;
  const PI_VERSION = "1.32.0";

  const q = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "").replace(/\n/g, "\\n") + "'";
  const jj = (o) => q(JSON.stringify(o));
  const nn = (v, d) => (isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
  const bb = (v, d) => (v === undefined || v === null ? (d ? "true" : "false") : v ? "true" : "false");

  // ───────────────────────── Luau head ─────────────────────────
  const HEAD = `local HttpService=game:GetService('HttpService')
local ServerStorage=game:GetService('ServerStorage')
local ReplicatedStorage=game:GetService('ReplicatedStorage')
local ChangeHistoryService=game:GetService('ChangeHistoryService')
local PI_VERSION=${q(PI_VERSION)}
local INDEX_NAME='Total_ProjectIndex'
local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end
local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end
local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end if lp=='workspace' then return game:GetService('Workspace') end local n=game for _,seg in ipairs(string.split(p,'.')) do if seg~='' then local nx=nil if n==game then local okS,s=pcall(function() return game:GetService(seg) end) if okS and s then nx=s end end if not nx then nx=n:FindFirstChild(seg) end if not nx then return nil end n=nx end end return n end
local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('TotalScript Project Index') end) return okW and w or nil end
local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end
local SKIP={CoreGui=true,CorePackages=true,PluginGuiService=true,RobloxPluginGuiService=true,RobloxReplicatedStorage=true,CSGDictionaryService=true,Visit=true,LuaWebService=true,InsertService=true,ScriptContext=true,TestService=true}
local ROOTS={'ServerScriptService','ServerStorage','ReplicatedStorage','ReplicatedFirst','StarterPlayer','StarterGui','StarterPack','Workspace','Lighting','SoundService','Teams','Chat'}
local function roots(scope) if scope and scope~='' then local r=resolve(scope) if not r then error('scope not found: '..tostring(scope)) end return {r} end local out={} for _,n in ipairs(ROOTS) do local okS,s=pcall(function() return game:GetService(n) end) if okS and s then out[#out+1]=s end end return out end
local function isScript(i) local okI,r=pcall(function() return i:IsA('LuaSourceContainer') end) return okI and r end
local function collectScripts(scope,maxN) local out={} local function walk(n) if #out>=maxN then return end local nm,cn='','' pcall(function() nm=n.Name cn=n.ClassName end) if SKIP[cn] or SKIP[nm] then return end if nm==INDEX_NAME then return end if isScript(n) then out[#out+1]=n end local okC,ch=pcall(function() return n:GetChildren() end) if okC and type(ch)=='table' then for _,c in ipairs(ch) do walk(c) if #out>=maxN then return end end end end for _,r in ipairs(roots(scope)) do walk(r) end return out end
local function hashOf(s) local h=5381 local n=#s local i=1 while i<=n do local j=math.min(n,i+511) local bytes={string.byte(s,i,j)} for _,b in ipairs(bytes) do h=(h*33+b)%4294967296 end i=j+1 end return string.format('%08x%06x',h,n%16777216) end
local function lines(src) local out={} for l in (src..'\\n'):gmatch('(.-)\\n') do out[#out+1]=l end if out[#out]=='' then out[#out]=nil end return out end
local function lastName(expr) expr=tostring(expr or '') local s=expr:match('["\\']([%w_ ]+)["\\']%s*%)?%s*$') if s then return s end local last=nil for seg in expr:gmatch('%.([%w_]+)') do last=seg end if last then return last end local w=expr:match('([%w_]+)%s*$') return w end
local function remoteVar(l) local v=l:match('([%w_%.:]+)%s*:%s*Fire[%w]*Server%s*%(') or l:match('([%w_%.:]+)%s*:%s*Fire[%w]*Client[s]?%s*%(') or l:match('([%w_%.:]+)%s*:%s*Invoke[%w]*%s*%(') or l:match('([%w_%.:]+)%s*%.%s*On[%w]*Event') or l:match('([%w_%.:]+)%s*%.%s*On[%w]*Invoke') return v end
local function remoteOp(l) if l:find(':FireServer',1,true) or l:find(':InvokeServer',1,true) then return 'client_fire' elseif l:find(':FireClient',1,true) or l:find(':FireAllClients',1,true) or l:find(':InvokeClient',1,true) then return 'server_fire' elseif l:find('.OnServerEvent',1,true) or l:find('.OnServerInvoke',1,true) then return 'server_handle' elseif l:find('.OnClientEvent',1,true) or l:find('.OnClientInvoke',1,true) then return 'client_handle' end return nil end
local function nameCase(n) n=tostring(n):match('([%w_]+)$') or '' if n=='' or #n<2 then return nil end if n:find('_') and n==n:lower() then return 'snake' end if n==n:upper() and n:find('_') then return 'CONST' end if n:sub(1,1):match('%u') then return 'Pascal' end if n:sub(1,1):match('%l') then return 'camel' end return 'other' end
local FRAMEWORKS={{'Knit','Knit%.Create[SC]'},{'Knit','require%(.-Knit%)'},{'ProfileService','ProfileService'},{'ProfileStore','ProfileStore'},{'DataStore2','DataStore2'},{'Fusion','Fusion'},{'Roact','Roact'},{'React','ReactRoblox'},{'Promise','Promise%.new'},{'Rodux','Rodux'},{'Matter','Matter%.World'},{'Iris','Iris%.'},{'TestEZ','TestEZ'},{'TotalScript blueprints','Total_Systems'},{'TotalScript design kit','Total_Design'}}
local function analyze(s) local src='' pcall(function() src=s.Source or '' end) local ls=lines(src) local e={path=s:GetFullName(),name=s.Name,class=s.ClassName,lines=#ls,chars=#src,hash=hashOf(src),strict=(src:match('^%-%-!strict')~=nil) or (src:match('\\n%-%-!strict')~=nil),disabled=false,functions={},requires={},services={},remotes={},datastores={},tags={},todos={},exports={},frameworks={}} pcall(function() if s:IsA('BaseScript') then e.disabled=s.Disabled end end) local vars={} local svcSet,dsSet,tagSet,fwSet={},{},{},{} local caseCounts={fn={},var={}} local tabs,spaces=0,0 local waitOld,waitNew,getSvc,dotSvc=0,0,0,0 local retName=nil for i,l in ipairs(ls) do if l:match('^\\t') then tabs=tabs+1 elseif l:match('^  ') then spaces=spaces+1 end local f=l:match('^%s*local%s+function%s+([%w_%.:]+)') or l:match('^%s*function%s+([%w_%.:]+)') or l:match('^%s*([%w_%.]+)%s*=%s*function%s*%(') if f then if #e.functions<80 then e.functions[#e.functions+1]={name=f,line=i} end local c=nameCase(f) if c then caseCounts.fn[c]=(caseCounts.fn[c] or 0)+1 end if f:find('[%.:]') and not f:match('%.On%u') then e.exports[#e.exports+1]=f:match('[%.:]([%w_]+)$') end end local lv=l:match('^%s*local%s+([%a_][%w_]*)%s*=') if lv then local c=nameCase(lv) local rhs=l:match('=%s*(.*)$') or '' if c and not (l:find('GetService',1,true) or l:find('require',1,true) or l:find('WaitForChild',1,true) or l:find('%.new%(') or l:find('script%.') or l:find('setmetatable',1,true) or rhs:match('^{%s*}%s*$') or rhs:match('^[%u][%w_]*[%.:]')) then caseCounts.var[c]=(caseCounts.var[c] or 0)+1 end local nm=l:match('WaitForChild%s*%(%s*["\\']([%w_ ]+)["\\']') or l:match('%.([%w_]+)%s*$') if nm then vars[lv]=nm end end for r in l:gmatch('require%s*%(%s*([^%)\\n]+)%)') do if #e.requires<60 then e.requires[#e.requires+1]={target=r,name=lastName(r),line=i} end end for sv in l:gmatch('GetService%s*%(%s*["\\']([%w]+)["\\']') do svcSet[sv]=true getSvc=getSvc+1 end if l:match('game%.[%u][%w]+') and not l:match('game%.Name') then dotSvc=dotSvc+1 end for ds in l:gmatch('Get[%w]*DataStore%s*%(%s*["\\']([^"\\']+)["\\']') do dsSet[ds]=true end for tg in l:gmatch('GetTagged%s*%(%s*["\\']([^"\\']+)["\\']') do tagSet[tg]=true end for tg in l:gmatch('AddTag%s*%(%s*[%w_%.]*%s*,?%s*["\\']([^"\\']+)["\\']') do tagSet[tg]=true end local op=remoteOp(l) if op then local v=remoteVar(l) local rn=nil if v then rn=vars[v:match('([%w_]+)$') or ''] or v:match('%.([%w_]+)$') or v:match('^([%w_]+)$') end if #e.remotes<60 then e.remotes[#e.remotes+1]={name=rn or '?',op=op,line=i} end end if l:match('%-%-%s*TODO') or l:match('%-%-%s*FIXME') or l:match('%-%-%s*HACK') or l:match('%-%-%s*XXX') then e.todos[#e.todos+1]=i end if l:match('[^%w_%.]wait%s*%(') or l:match('^wait%s*%(') then waitOld=waitOld+1 end if l:find('task.wait',1,true) then waitNew=waitNew+1 end for _,fw in ipairs(FRAMEWORKS) do if l:find(fw[2]) then fwSet[fw[1]]=true end end local rn=l:match('^%s*return%s+([%a_][%w_]*)%s*$') if rn then retName=rn end end for k in pairs(svcSet) do e.services[#e.services+1]=k end table.sort(e.services) for k in pairs(dsSet) do e.datastores[#e.datastores+1]=k end for k in pairs(tagSet) do e.tags[#e.tags+1]=k end for k in pairs(fwSet) do e.frameworks[#e.frameworks+1]=k end table.sort(e.frameworks) if retName then e.returns=retName end e.style={tabs=tabs,spaces=spaces,fn_case=caseCounts.fn,var_case=caseCounts.var,wait_old=waitOld,wait_new=waitNew,get_service=getSvc,dot_service=dotSvc} return e end
local function layoutOf() local out={} for _,n in ipairs({'ReplicatedStorage','ServerScriptService','ServerStorage','ReplicatedFirst','StarterGui','StarterPack'}) do local okS,s=pcall(function() return game:GetService(n) end) if okS and s then local kids={} for _,c in ipairs(s:GetChildren()) do local cnt=0 for _,d in ipairs(c:GetDescendants()) do if isScript(d) then cnt=cnt+1 end end if isScript(c) then cnt=cnt+1 end kids[#kids+1]={name=c.Name,class=c.ClassName,scripts=cnt} end table.sort(kids,function(a,b) return a.scripts>b.scripts end) out[n]=kids end end local sp=game:GetService('StarterPlayer') for _,n in ipairs({'StarterPlayerScripts','StarterCharacterScripts'}) do local f=sp:FindFirstChild(n) if f then local kids={} for _,c in ipairs(f:GetChildren()) do local cnt=0 for _,d in ipairs(c:GetDescendants()) do if isScript(d) then cnt=cnt+1 end end if isScript(c) then cnt=cnt+1 end kids[#kids+1]={name=c.Name,class=c.ClassName,scripts=cnt} end table.sort(kids,function(a,b) return a.scripts>b.scripts end) out[n]=kids end end return out end
local function remoteInstances() local out={} for _,d in ipairs(ReplicatedStorage:GetDescendants()) do if d:IsA('RemoteEvent') or d:IsA('RemoteFunction') or d:IsA('UnreliableRemoteEvent') then out[#out+1]={name=d.Name,class=d.ClassName,path=d:GetFullName()} end end table.sort(out,function(a,b) return a.name<b.name end) return out end
local function blueprintsInstalled() local out={} local rs=ReplicatedStorage:FindFirstChild('Total_Systems') if rs then for _,c in ipairs(rs:GetChildren()) do if c:IsA('Folder') and c:GetAttribute('Total_Blueprint') then out[#out+1]=c:GetAttribute('Total_Blueprint') end end end table.sort(out) return out end
local function buildIndex(scope,maxN) local scripts=collectScripts(scope,maxN) local entries={} local byName={} local byPath={} for _,s in ipairs(scripts) do local e=analyze(s) entries[#entries+1]=e byPath[e.path]=e if e.class=='ModuleScript' then byName[e.name]=byName[e.name] or {} table.insert(byName[e.name],e.path) end end
 -- require resolution + required_by
 for _,e in ipairs(entries) do e.required_by={} end
 local edges={} for _,e in ipairs(entries) do for _,r in ipairs(e.requires) do local cands=r.name and byName[r.name] or nil if cands and #cands==1 then r.resolved=cands[1] elseif cands then local best=nil for _,c in ipairs(cands) do if e.path:sub(1,#e.path:match('^(.*)%.[^%.]+$') or 0)==c:sub(1,#(e.path:match('^(.*)%.[^%.]+$') or '')) then best=c end end r.resolved=best or cands[1] r.ambiguous=#cands end if r.resolved and byPath[r.resolved] then local rb=byPath[r.resolved].required_by if #rb<80 then rb[#rb+1]=e.path end edges[#edges+1]={from=e.path,to=r.resolved} end end end
 -- remotes: instances + producers/consumers
 local remotes={} for _,ri in ipairs(remoteInstances()) do remotes[ri.name]=remotes[ri.name] or {name=ri.name,class=ri.class,path=ri.path,fired_by={},handled_by={}} end
 local referenced={} for _,e in ipairs(entries) do for _,r in ipairs(e.remotes) do if r.name~='?' then referenced[r.name]=true remotes[r.name]=remotes[r.name] or {name=r.name,class='?',path=nil,fired_by={},handled_by={},missing_instance=true} local rec=remotes[r.name] local list=(r.op=='client_fire' or r.op=='server_fire') and rec.fired_by or rec.handled_by local seen=false for _,p in ipairs(list) do if p==e.path then seen=true end end if not seen and #list<40 then list[#list+1]=e.path end end end end
 local remoteList={} local mismatches={} for name,rec in pairs(remotes) do remoteList[#remoteList+1]=rec if rec.missing_instance then mismatches[#mismatches+1]={remote=name,issue='referenced in scripts but no RemoteEvent/RemoteFunction instance in ReplicatedStorage',scripts=rec.fired_by} elseif #rec.fired_by>0 and #rec.handled_by==0 then mismatches[#mismatches+1]={remote=name,issue='fired but never handled',scripts=rec.fired_by} elseif #rec.handled_by>0 and #rec.fired_by==0 then mismatches[#mismatches+1]={remote=name,issue='handled but never fired',scripts=rec.handled_by} elseif #rec.fired_by==0 and #rec.handled_by==0 then mismatches[#mismatches+1]={remote=name,issue='unused remote instance',scripts={}} end end table.sort(remoteList,function(a,b) return a.name<b.name end) table.sort(mismatches,function(a,b) return a.remote<b.remote end)
 -- conventions
 local tabs,spaces,strict,fnCase,varCase,waitOld,waitNew,getSvc,dotSvc,fw=0,0,0,{},{},0,0,0,0,{} local modules,server,client=0,0,0 local todoCount=0 for _,e in ipairs(entries) do tabs=tabs+e.style.tabs spaces=spaces+e.style.spaces if e.strict then strict=strict+1 end for k,v in pairs(e.style.fn_case) do fnCase[k]=(fnCase[k] or 0)+v end for k,v in pairs(e.style.var_case) do varCase[k]=(varCase[k] or 0)+v end waitOld=waitOld+e.style.wait_old waitNew=waitNew+e.style.wait_new getSvc=getSvc+e.style.get_service dotSvc=dotSvc+e.style.dot_service for _,f in ipairs(e.frameworks) do fw[f]=(fw[f] or 0)+1 end if e.class=='ModuleScript' then modules=modules+1 elseif e.class=='LocalScript' or (e.class=='Script' and (e.path:find('^StarterPlayer') or e.path:find('^StarterGui') or e.path:find('^ReplicatedFirst'))) then client=client+1 else server=server+1 end todoCount=todoCount+#e.todos end
 local function top(t) local best,bn=nil,0 for k,v in pairs(t) do if v>bn then best,bn=k,v end end return best end
 local fwList={} for k,v in pairs(fw) do fwList[#fwList+1]={name=k,scripts=v} end table.sort(fwList,function(a,b) return a.scripts>b.scripts end)
 local conv={indent=(tabs>=spaces) and 'tabs' or 'spaces',function_case=top(fnCase) or 'Pascal',variable_case=top(varCase) or 'camel',strict_ratio=(#entries>0) and math.floor(strict/#entries*100+0.5) or 0,wait_style=(waitNew>=waitOld) and 'task.wait' or 'wait()',service_access=(getSvc>=dotSvc) and 'game:GetService' or 'game.Service',frameworks=fwList,legacy_wait_calls=waitOld}
 local caseNames={Pascal='PascalCase',camel='camelCase',snake='snake_case',lower='lowercase',other='mixed'}
 conv.style_guide='indent with '..conv.indent..'; functions '..(caseNames[conv.function_case] or conv.function_case)..', locals '..(caseNames[conv.variable_case] or conv.variable_case)..'; --!strict in '..conv.strict_ratio..'% of scripts; '..conv.wait_style..'; '..conv.service_access..(#fwList>0 and ('; frameworks: '..(function() local n={} for i=1,math.min(4,#fwList) do n[#n+1]=fwList[i].name end return table.concat(n,', ') end)()) or '')
 -- hubs / orphans / cycles
 local hubs={} for _,e in ipairs(entries) do if e.class=='ModuleScript' and #e.required_by>0 then hubs[#hubs+1]={path=e.path,required_by=#e.required_by} end end table.sort(hubs,function(a,b) if a.required_by~=b.required_by then return a.required_by>b.required_by end return a.path<b.path end) local hubTop={} for i=1,math.min(8,#hubs) do hubTop[i]=hubs[i] end
 local orphans={} for _,e in ipairs(entries) do if e.class=='ModuleScript' and #e.required_by==0 and not e.path:find('Total_Systems',1,true) and e.name~='Config' then orphans[#orphans+1]=e.path end end table.sort(orphans)
 local adj={} for _,ed in ipairs(edges) do adj[ed.from]=adj[ed.from] or {} table.insert(adj[ed.from],ed.to) end local cycles={} local state={} local stack={} local function dfs(n) state[n]=1 stack[#stack+1]=n for _,m in ipairs(adj[n] or {}) do if state[m]==1 then local cyc={} local started=false for _,x in ipairs(stack) do if x==m then started=true end if started then cyc[#cyc+1]=x end end if #cycles<10 then cycles[#cycles+1]=cyc end elseif not state[m] then dfs(m) end end stack[#stack]=nil state[n]=2 end for n in pairs(adj) do if not state[n] then dfs(n) end end
 local idx={version=PI_VERSION,built_at=os.time(),place={id=game.PlaceId,name=game.Name},counts={scripts=#entries,modules=modules,server=server,client=client,remotes=#remoteList,todos=todoCount,edges=#edges},layout=layoutOf(),scripts=entries,remotes=remoteList,mismatches=mismatches,conventions=conv,hubs=hubTop,orphans=orphans,cycles=cycles,blueprints=blueprintsInstalled(),scope=scope or ''}
 return idx end
local function indexModule() return ServerStorage:FindFirstChild(INDEX_NAME) end
local function readIndex() local m=indexModule() if not m or not m:IsA('ModuleScript') then return nil end local js=m.Source:match('%[===%[(.-)%]===%]') if not js then return nil end local okD,d=pcall(function() return HttpService:JSONDecode(js) end) if okD and type(d)=='table' then return d end return nil end
local function needIndex() local idx=readIndex() if not idx then error('no project index yet - run project_index_build first') end return idx end
local function writeIndex(idx) local m=indexModule() if m and not m:IsA('ModuleScript') then m:Destroy() m=nil end if not m then m=Instance.new('ModuleScript') m.Name=INDEX_NAME m.Parent=ServerStorage end local js=HttpService:JSONEncode(idx) m.Source='-- Total_ProjectIndex (generated by TotalScript project_index_build '..PI_VERSION..'). Machine-written map of this place: scripts, requires, remotes, conventions.\\n-- Do not edit; rebuild with project_index_build. Read it with require() for tooling.\\nlocal HttpService=game:GetService(\\'HttpService\\')\\nreturn HttpService:JSONDecode([===['..js..']===])\\n' m:SetAttribute('Total_Version',PI_VERSION) m:SetAttribute('BuiltAt',idx.built_at) m:SetAttribute('Scripts',idx.counts.scripts) return m,#js end
local function diffIndex(old,new) local added,modified,removed={},{},{} if not old then for _,e in ipairs(new.scripts) do added[#added+1]=e.path end return added,modified,removed end local om={} for _,e in ipairs(old.scripts) do om[e.path]=e end local nm={} for _,e in ipairs(new.scripts) do nm[e.path]=e local o=om[e.path] if not o then added[#added+1]=e.path elseif o.hash~=e.hash then modified[#modified+1]=e.path end end for _,e in ipairs(old.scripts) do if not nm[e.path] then removed[#removed+1]=e.path end end table.sort(added) table.sort(modified) table.sort(removed) return added,modified,removed end
local function short(p) return (tostring(p):gsub('^ReplicatedStorage%.','RS.'):gsub('^ServerScriptService%.','SSS.'):gsub('^ServerStorage%.','SS.'):gsub('^StarterPlayer%.StarterPlayerScripts%.','SPS.'):gsub('^StarterPlayer%.StarterCharacterScripts%.','SCS.'):gsub('^StarterGui%.','SG.')) end
local function mapText(idx,maxChars) maxChars=maxChars or 1500 local c=idx.counts local out={} local when=os.date('!%Y-%m-%d %H:%M',idx.built_at or 0) out[#out+1]='PROJECT MAP ('..tostring(idx.place and idx.place.name or 'place')..', indexed '..when..' UTC): '..c.scripts..' scripts = '..c.modules..' modules / '..c.server..' server / '..c.client..' client; '..c.remotes..' remotes; '..c.todos..' TODOs' out[#out+1]='Style: '..tostring(idx.conventions and idx.conventions.style_guide or '') local lay={} for _,svc in ipairs({'ReplicatedStorage','ServerScriptService','ServerStorage','StarterPlayerScripts','StarterGui'}) do local kids=idx.layout and idx.layout[svc] if kids and #kids>0 then local parts={} for i=1,math.min(5,#kids) do if kids[i].scripts>0 then parts[#parts+1]=kids[i].name..'('..kids[i].scripts..')' end end if #parts>0 then lay[#lay+1]=svc..'.{'..table.concat(parts,', ')..'}' end end end if #lay>0 then out[#out+1]='Layout: '..table.concat(lay,'; ') end if idx.hubs and #idx.hubs>0 then local h={} for i=1,math.min(6,#idx.hubs) do h[#h+1]=short(idx.hubs[i].path)..' <- '..idx.hubs[i].required_by end out[#out+1]='Hubs (most required): '..table.concat(h,', ') end if idx.remotes and #idx.remotes>0 then local r={} for i=1,math.min(10,#idx.remotes) do local rec=idx.remotes[i] local f=#rec.fired_by>0 and short(rec.fired_by[1]) or '-' local hnd=#rec.handled_by>0 and short(rec.handled_by[1]) or '-' r[#r+1]=rec.name..' ('..(rec.class=='RemoteFunction' and 'RF' or (rec.class=='?' and '??' or 'RE'))..': '..f..' -> '..hnd..')' end out[#out+1]='Remotes: '..table.concat(r,'; ')..(#idx.remotes>10 and (' +'..(#idx.remotes-10)..' more') or '') end local issues={} if idx.mismatches and #idx.mismatches>0 then local names={} for i=1,math.min(5,#idx.mismatches) do names[#names+1]=idx.mismatches[i].remote..' ('..idx.mismatches[i].issue..')' end issues[#issues+1]=#idx.mismatches..' remote issue(s): '..table.concat(names,', ') end if idx.orphans and #idx.orphans>0 then local o={} for i=1,math.min(4,#idx.orphans) do o[#o+1]=short(idx.orphans[i]) end issues[#issues+1]=#idx.orphans..' module(s) never required: '..table.concat(o,', ') end if idx.cycles and #idx.cycles>0 then local cc={} for _,p in ipairs(idx.cycles[1]) do cc[#cc+1]=short(p) end issues[#issues+1]=#idx.cycles..' require cycle(s): '..table.concat(cc,' -> ') end if idx.conventions and (idx.conventions.legacy_wait_calls or 0)>0 then issues[#issues+1]=idx.conventions.legacy_wait_calls..' legacy wait() call(s)' end if #issues>0 then out[#out+1]='Issues: '..table.concat(issues,'; ') end if idx.blueprints and #idx.blueprints>0 then out[#out+1]='Blueprints installed: '..table.concat(idx.blueprints,', ') end out[#out+1]='Use project_index_search / project_index_script instead of reading every script; project_index_changes tells you what moved since this map.' local txt=table.concat(out,'\\n') if #txt>maxChars then txt=txt:sub(1,maxChars-3)..'...' end return txt end
local function staleCheck(idx,maxN) local scripts=collectScripts(idx.scope~='' and idx.scope or nil,maxN) local byPath={} for _,e in ipairs(idx.scripts) do byPath[e.path]=e end local changed,added,seen=0,0,{} for _,s in ipairs(scripts) do local p=s:GetFullName() seen[p]=true local e=byPath[p] if not e then added=added+1 else local src='' pcall(function() src=s.Source or '' end) if #src~=e.chars then changed=changed+1 end end end local removed=0 for p in pairs(byPath) do if not seen[p] then removed=removed+1 end end return {added=added,changed_size=changed,removed=removed,stale=(added+changed+removed)>0} end
local function findEntry(idx,path) local p=tostring(path or '') if p=='' then return nil end p=p:gsub('^game%.','') for _,e in ipairs(idx.scripts) do if e.path==p then return e end end local lp=p:lower() local best=nil for _,e in ipairs(idx.scripts) do if e.path:lower():sub(-#lp)==lp or e.name:lower()==lp then if best then return nil,'ambiguous: '..best.path..' | '..e.path end best=e end end return best end
`;

  // ───────────────────────── command bodies ─────────────────────────
  const B = {};

  B.project_index_build = (a) => [
    "local scope=" + q(a.scope || "") + " if scope=='' then scope=nil end",
    "local maxN=" + nn(a.max_scripts, 600),
    "local old=readIndex()",
    "local idx=buildIndex(scope,maxN)",
    "local added,modified,removed=diffIndex(old,idx)",
    "local bytes=0 if not " + bb(a.dry_run, false) + " then local rec=wp() local _,n=writeIndex(idx) bytes=n wpDone(rec) end",
    "local map=mapText(idx," + nn(a.max_chars, 1500) + ")",
    // 1.37.1: the first build of a 600-script place used to echo every path
    // three times (added + hubs + map) - tens of KB that the MCP transport and
    // the chat both choke on. Keep the counts exact, cap the path lists.
    "local function capList(t,n) if #t<=n then return t,0 end local o={} for i=1,n do o[i]=t[i] end return o,#t-n end",
    "local addedTotal,modifiedTotal,removedTotal=#added,#modified,#removed local addedMore,modifiedMore,removedMore added,addedMore=capList(added,60) modified,modifiedMore=capList(modified,60) removed,removedMore=capList(removed,60)",
    "local r={version=PI_VERSION,written=not " + bb(a.dry_run, false) + ",module='ServerStorage.'..INDEX_NAME,bytes=bytes,counts=idx.counts,previous=old and {built_at=old.built_at,scripts=old.counts.scripts} or nil,added=added,modified=modified,removed=removed,added_total=addedTotal,modified_total=modifiedTotal,removed_total=removedTotal,lists_truncated=(addedMore+modifiedMore+removedMore)>0 and ('added +'..addedMore..', modified +'..modifiedMore..', removed +'..removedMore..' more (use project_index_search / project_index_changes for details)') or nil,conventions=idx.conventions,hubs=idx.hubs,orphans=idx.orphans,cycles=idx.cycles,mismatches=idx.mismatches,blueprints=idx.blueprints,truncated=(#idx.scripts>=maxN),map_text=map}",
    "return ok(r,'indexed '..idx.counts.scripts..' scripts ('..idx.counts.modules..' modules, '..idx.counts.remotes..' remotes)'..(old and (': +'..addedTotal..' / ~'..modifiedTotal..' / -'..removedTotal..' since '..os.date('!%H:%M',old.built_at or 0)..' UTC') or '')..(#idx.mismatches>0 and ('; '..#idx.mismatches..' remote issue(s)') or '')..(#idx.cycles>0 and ('; '..#idx.cycles..' require cycle(s)') or ''))",
  ].join("\n");

  B.project_index_changes = (a) => [
    "local old=needIndex()",
    "local idx=buildIndex(old.scope~='' and old.scope or nil," + nn(a.max_scripts, 600) + ")",
    "local added,modified,removed=diffIndex(old,idx)",
    "local details={} local om={} for _,e in ipairs(old.scripts) do om[e.path]=e end for _,e in ipairs(idx.scripts) do local o=om[e.path] if o and o.hash~=e.hash then local newFns,gone={},{} local of={} for _,f in ipairs(o.functions) do of[f.name]=true end local nf={} for _,f in ipairs(e.functions) do nf[f.name]=true if not of[f.name] then newFns[#newFns+1]=f.name end end for _,f in ipairs(o.functions) do if not nf[f.name] then gone[#gone+1]=f.name end end details[#details+1]={path=e.path,lines=e.lines,delta_lines=e.lines-o.lines,new_functions=newFns,removed_functions=gone,requires_changed=#e.requires~=#o.requires,remotes_changed=#e.remotes~=#o.remotes} end end",
    "local stale=(#added+#modified+#removed)>0",
    "return ok({indexed_at=old.built_at,stale=stale,added=added,modified=modified,removed=removed,details=details,hint=stale and 'run project_index_build to refresh the map' or 'index is current'},stale and ('+'..#added..' added, ~'..#modified..' modified, -'..#removed..' removed since the index') or 'no changes since the index')",
  ].join("\n");

  B.project_index_summary = (a) => [
    "local idx=needIndex()",
    "local st=staleCheck(idx," + nn(a.max_scripts, 600) + ")",
    "local map=mapText(idx," + nn(a.max_chars, 1500) + ")",
    "if st.stale then map=map..'\\n(STALE: '..st.added..' new / '..st.changed_size..' changed / '..st.removed..' removed scripts since the index - run project_index_build)' end",
    "local ds,tags={},{} local dsSet,tagSet={},{} for _,e in ipairs(idx.scripts) do for _,d in ipairs(e.datastores or {}) do dsSet[d]=true end for _,t in ipairs(e.tags or {}) do tagSet[t]=true end end for k in pairs(dsSet) do ds[#ds+1]=k end for k in pairs(tagSet) do tags[#tags+1]=k end table.sort(ds) table.sort(tags)",
    "local todoFiles={} for _,e in ipairs(idx.scripts) do if #e.todos>0 then todoFiles[#todoFiles+1]={path=e.path,count=#e.todos} end end table.sort(todoFiles,function(a,b) return a.count>b.count end)",
    "local biggest={} for _,e in ipairs(idx.scripts) do biggest[#biggest+1]={path=e.path,lines=e.lines} end table.sort(biggest,function(a,b) return a.lines>b.lines end) local big={} for i=1,math.min(8,#biggest) do big[i]=biggest[i] end",
    "return ok({version=idx.version,built_at=idx.built_at,place=idx.place,counts=idx.counts,stale=st,layout=idx.layout,conventions=idx.conventions,hubs=idx.hubs,orphans=idx.orphans,cycles=idx.cycles,remotes=idx.remotes,mismatches=idx.mismatches,datastores=ds,tags=tags,todo_files=todoFiles,largest_scripts=big,blueprints=idx.blueprints,map_text=map},map)",
  ].join("\n");

  B.project_index_search = (a) => {
    const query = String(a.query ?? a.q ?? a.symbol ?? "").trim();
    const kind = String(a.kind || "any").toLowerCase();
    const KINDS = ["any", "symbol", "function", "require", "remote", "service", "datastore", "tag", "path", "export", "todo"];
    if (!KINDS.includes(kind)) throw new Error("unknown kind '" + kind + "' - use one of: " + KINDS.join(", "));
    if (!query && kind !== "todo") throw new Error("query is required (kind 'todo' is the only kind that lists without one)");
    return [
      "local idx=needIndex()",
      "local qstr=" + q(query.toLowerCase()) + " local kind=" + q(kind) + " local limit=" + nn(a.limit, 40),
      "local function m(s) return s~=nil and tostring(s):lower():find(qstr,1,true)~=nil end",
      "local hits={} local total=0",
      "local function add(e,what,detail,line) total=total+1 if #hits<limit then hits[#hits+1]={path=e.path,class=e.class,kind=what,match=detail,line=line} end end",
      "for _,e in ipairs(idx.scripts) do",
      " if (kind=='any' or kind=='path') and (m(e.path)) then add(e,'path',e.path) end",
      " if kind=='any' or kind=='symbol' or kind=='function' then for _,f in ipairs(e.functions) do if m(f.name) then add(e,'function',f.name,f.line) end end end",
      " if kind=='any' or kind=='export' then for _,x in ipairs(e.exports or {}) do if m(x) then add(e,'export',x) end end end",
      " if kind=='any' or kind=='require' then for _,r in ipairs(e.requires) do if m(r.target) or m(r.name) or m(r.resolved) then add(e,'require',r.target..(r.resolved and (' -> '..r.resolved) or ''),r.line) end end end",
      " if kind=='any' or kind=='remote' then for _,r in ipairs(e.remotes) do if m(r.name) then add(e,'remote',r.name..' ('..r.op..')',r.line) end end end",
      " if kind=='any' or kind=='service' then for _,s in ipairs(e.services) do if m(s) then add(e,'service',s) end end end",
      " if kind=='any' or kind=='datastore' then for _,s in ipairs(e.datastores or {}) do if m(s) then add(e,'datastore',s) end end end",
      " if kind=='any' or kind=='tag' then for _,s in ipairs(e.tags or {}) do if m(s) then add(e,'tag',s) end end end",
      " if kind=='todo' and #e.todos>0 and (qstr=='' or m(e.path)) then add(e,'todo',#e.todos..' TODO line(s)',e.todos[1]) end",
      "end",
      "for _,r in ipairs(idx.remotes) do if (kind=='any' or kind=='remote') and m(r.name) then total=total+1 if #hits<limit then hits[#hits+1]={path=r.path or '(no instance)',class=r.class,kind='remote_instance',match=r.name..' fired_by '..#r.fired_by..' handled_by '..#r.handled_by} end end end",
      "return ok({query=" + q(query) + ",kind=kind,total=total,hits=hits,truncated=total>#hits,indexed_at=idx.built_at},total..' match(es) for '.." + q(query) + "..(total>#hits and (' (showing '..#hits..')') or ''))",
    ].join("\n");
  };

  B.project_index_script = (a) => {
    const p = String(a.path || a.name || "").trim();
    if (!p) throw new Error("path is required");
    return [
      "local idx=needIndex()",
      "local e,err=findEntry(idx," + q(p) + ")",
      "if not e then error(err or ('script not in the index: '.." + q(p) + "..' (run project_index_build or check the path)')) end",
      "local inst=resolve(e.path) local stale=false local cur=nil if inst and isScript(inst) then local src='' pcall(function() src=inst.Source or '' end) cur=hashOf(src) stale=cur~=e.hash end",
      "local partners={} for _,r in ipairs(e.remotes) do for _,rec in ipairs(idx.remotes) do if rec.name==r.name then local other=(r.op=='client_fire' or r.op=='server_fire') and rec.handled_by or rec.fired_by partners[#partners+1]={remote=r.name,op=r.op,other_side=other,missing_instance=rec.missing_instance or false} end end end",
      "local resolvedReqs={} for _,r in ipairs(e.requires) do resolvedReqs[#resolvedReqs+1]={target=r.target,resolved=r.resolved,ambiguous=r.ambiguous,line=r.line} end",
      "local r={path=e.path,class=e.class,exists=inst~=nil,stale=stale,hash=e.hash,current_hash=cur,lines=e.lines,chars=e.chars,strict=e.strict,disabled=e.disabled,returns=e.returns,functions=e.functions,exports=e.exports,requires=resolvedReqs,required_by=e.required_by,remotes=e.remotes,remote_partners=partners,services=e.services,datastores=e.datastores,tags=e.tags,todos=e.todos,frameworks=e.frameworks,style=e.style,indexed_at=idx.built_at}",
      "return ok(r,e.path..': '..e.lines..' lines, '..#e.functions..' function(s), '..#e.requires..' require(s), required by '..#e.required_by..', '..#e.remotes..' remote use(s)'..(stale and ' - STALE (source changed since the index)' or '')..((not inst) and ' - instance no longer exists' or ''))",
    ].join("\n");
  };

  B.project_index_graph = (a) => {
    const kind = String(a.kind || "requires").toLowerCase();
    if (!["requires", "remotes"].includes(kind)) throw new Error("kind must be 'requires' or 'remotes'");
    return [
      "local idx=needIndex()",
      "local root=" + q(a.root || a.path || "") + " local depth=" + nn(a.depth, 3) + " local limit=" + nn(a.limit, 200),
      kind === "requires"
        ? [
            "local byPath={} for _,e in ipairs(idx.scripts) do byPath[e.path]=e end",
            "local edges={} local nodes={} local function addNode(p) if not nodes[p] then local e=byPath[p] nodes[p]={path=p,class=e and e.class or '?',required_by=e and #e.required_by or 0,requires=e and #e.requires or 0} end end",
            "if root~='' then local e,err=findEntry(idx,root) if not e then error(err or ('not in the index: '..root)) end local seen={} local function walk(p,d) if seen[p] then return end seen[p]=true addNode(p) local x=byPath[p] if not x or d>=depth then return end for _,r in ipairs(x.requires) do if r.resolved then edges[#edges+1]={from=p,to=r.resolved} walk(r.resolved,d+1) end end for _,rb in ipairs(x.required_by) do if d==0 then edges[#edges+1]={from=rb,to=p} addNode(rb) end end end walk(e.path,0)",
            "else for _,e in ipairs(idx.scripts) do for _,r in ipairs(e.requires) do if r.resolved and #edges<limit then edges[#edges+1]={from=e.path,to=r.resolved} addNode(e.path) addNode(r.resolved) end end end end",
            "local nodeList={} for _,n in pairs(nodes) do nodeList[#nodeList+1]=n end table.sort(nodeList,function(a,b) if a.required_by~=b.required_by then return a.required_by>b.required_by end return a.path<b.path end)",
            "local unresolved={} for _,e in ipairs(idx.scripts) do for _,r in ipairs(e.requires) do if not r.resolved and not r.target:match('^%d+$') then unresolved[#unresolved+1]={from=e.path,target=r.target,line=r.line} end end end",
            "return ok({kind='requires',root=root~='' and root or nil,nodes=nodeList,edges=edges,hubs=idx.hubs,orphans=idx.orphans,cycles=idx.cycles,unresolved=unresolved,truncated=#edges>=limit},#nodeList..' module node(s), '..#edges..' require edge(s), '..#idx.cycles..' cycle(s), '..#idx.orphans..' orphan module(s), '..#unresolved..' unresolved require(s)')",
          ].join("\n")
        : [
            "local rows={} for _,r in ipairs(idx.remotes) do if root=='' or r.name:lower():find(root:lower(),1,true) then rows[#rows+1]={name=r.name,class=r.class,path=r.path,fired_by=r.fired_by,handled_by=r.handled_by,missing_instance=r.missing_instance or false} end end",
            "local sideOf={} for _,e in ipairs(idx.scripts) do sideOf[e.path]=e.class end",
            "local wrongSide={} for _,r in ipairs(idx.remotes) do for _,p in ipairs(r.handled_by) do if sideOf[p]=='LocalScript' then for _,e in ipairs(idx.scripts) do if e.path==p then for _,u in ipairs(e.remotes) do if u.name==r.name and u.op=='server_handle' then wrongSide[#wrongSide+1]={remote=r.name,script=p,issue='OnServerEvent/OnServerInvoke in a LocalScript'} end end end end end end end",
            "return ok({kind='remotes',remotes=rows,mismatches=idx.mismatches,wrong_side=wrongSide},#rows..' remote(s), '..#idx.mismatches..' issue(s)'..(#wrongSide>0 and (', '..#wrongSide..' handled on the wrong side') or ''))",
          ].join("\n"),
    ].join("\n");
  };

  // ───────────────────────── command specs ─────────────────────────
  const S = (type, req, desc) => ({ type, req: !!req, desc: desc || "" });
  const C = [
    { name: "project_index_build", description: "Index the whole place (or a scope) into ServerStorage.Total_ProjectIndex: every script hashed and outlined (functions + lines, requires resolved to modules, remotes fired/handled, services, DataStores, tags, TODOs, --!strict), folder layout, require graph (hubs, orphans, cycles), remote producer/consumer matrix with mismatches, coding conventions (indent, naming, strict ratio, wait style, frameworks) and installed blueprints. Returns the diff vs the previous index and a compact PROJECT MAP text that TotalScript re-injects into the chat. Run it first on an unknown place and again after big changes.", params: { scope: S("string", false, "limit to one instance path (default: all script services)"), max_scripts: S("number", false, "default 600"), dry_run: S("boolean", false, "compute but do not write"), max_chars: S("number", false, "map text budget (default 1500)") } },
    { name: "project_index_summary", description: "Architecture map from the stored index (no rescan, cheap): counts, layout per service, conventions / style guide to match, hubs (most required modules), orphans, cycles, remotes with producers -> consumers, mismatches, DataStores, tags, TODO files, largest scripts, installed blueprints, plus a quick staleness check. Use it at the start of a task instead of reading scripts one by one.", params: { max_chars: S("number", false, "map text budget (default 1500)"), max_scripts: S("number", false) } },
    { name: "project_index_search", description: "Search the index (not the raw sources): functions / symbols, exports, require targets, remote names, services, DataStore names, tags, script paths or TODOs. Returns script path + line for each hit so you can script_read a range instead of a whole file.", params: { query: S("string", true, "substring, case-insensitive"), kind: S("string", false, "any|symbol|function|export|require|remote|service|datastore|tag|path|todo (default any)"), limit: S("number", false, "default 40") } },
    { name: "project_index_script", description: "Everything the index knows about one script: outline (functions + lines), exports, requires (resolved) and required_by, remotes used with the other side (which script handles / fires each), services, DataStores, tags, TODOs, style, frameworks - and whether the source changed since the index (stale). Accepts a full path, a suffix or a unique name.", params: { path: S("string", true, "full path, suffix or unique script name") } },
    { name: "project_index_graph", description: "kind 'requires': module dependency graph - all edges (or the neighbourhood of root to depth), nodes ranked by required_by, hubs, orphan modules, require cycles, unresolved requires. kind 'remotes': every remote with fired_by / handled_by scripts, mismatches (fired but never handled, handled but never fired, referenced but no instance, unused instance) and handlers on the wrong side.", params: { kind: S("string", false, "requires|remotes (default requires)"), root: S("string", false, "script path (requires) or remote name filter (remotes)"), depth: S("number", false, "default 3"), limit: S("number", false, "max edges (default 200)") } },
    { name: "project_index_changes", description: "What changed since the last index without rewriting it: added / modified / removed scripts by hash, and per modified script the line delta, new / removed functions and whether requires or remotes changed. Use before trusting an old map or to summarise your own edits.", params: { max_scripts: S("number", false) } },
  ];

  function buildProject(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))"; return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + (e && e.message ? e.message : e) };
    }
  }

  const prevBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    if (B[op]) return buildProject(op, args);
    return prevBuild.call(RobloxScriptSkills, op, args);
  };
  const names = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!names.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name);
  RobloxScriptSkills.PROJECT_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.PROJECT_INDEX_VERSION = PI_VERSION;
})();
