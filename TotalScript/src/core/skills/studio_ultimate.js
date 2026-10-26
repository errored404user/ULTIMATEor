// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript "Ultimate" skill pack: Luau engineering, modeling and project-memory
// commands layered on RobloxScriptSkills (same patch pattern as studio_200.js).
//
//   script_*  - safe source surgery (replace / insert / delete lines), outline,
//               usages, symbol rename, lint, TODO scan, require graph, backups.
//   model_*   - build from spec, report, pivot/ground/align/distribute, radial
//               arrays, walls / shells / pipes, paint, anchor fix, CSG, export.
//   memory_*  - structured access to game.ServerStorage.RobloxScript.Memory
//               (the shared project handbook) so the agent never has to
//               hand-edit the ModuleScript with multi_edit.
//
// Convention: JS source uses double-quoted strings; every Luau string literal
// uses single quotes. Values are interpolated with q/nn/bb/vv/cc/jj. Never put
// a raw newline inside a Luau string - tests/test-luau-syntax.js enforces it.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  const nn = (v, d = 0) => { const x = Number(v); return isFinite(x) ? String(x) : String(d); };
  const bb = (v, d = false) => (v === undefined || v === null || v === "" ? (d ? "true" : "false") : (v === true || v === "true" || v === 1 || v === "1" || v === "yes") ? "true" : "false");
  const jj = (v) => { try { return q(JSON.stringify(v === undefined ? null : v)); } catch { return q("null"); } };
  const NAMED = { red: [255, 50, 50], green: [50, 255, 100], blue: [50, 150, 255], gold: [255, 200, 50], yellow: [255, 230, 60], purple: [180, 80, 255], cyan: [50, 230, 255], pink: [255, 120, 200], orange: [255, 130, 40], white: [255, 255, 255], black: [20, 20, 20], gray: [128, 128, 128], grey: [128, 128, 128], brown: [120, 80, 40], stone: [150, 150, 145], wood: [160, 110, 60] };
  const parseColor = (v, d) => {
    if (Array.isArray(v) && v.length >= 3 && v.every((x) => isFinite(Number(x)))) return v.slice(0, 3).map(Number);
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (NAMED[s]) return NAMED[s];
      if (/^#?[0-9a-f]{6}$/.test(s)) { const h = s.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
      const parts = s.split(/[\s,]+/).map(Number);
      if (parts.length >= 3 && parts.every(isFinite)) return parts.slice(0, 3);
    }
    return d || null;
  };
  const cc = (v, d) => { const c = parseColor(v, d); return c ? "Color3.fromRGB(" + c.map((x) => Math.max(0, Math.min(255, Math.round(x)))).join(",") + ")" : "nil"; };
  const vec = (a, d) => {
    if (typeof a === "string") { const p = a.split(/[\s,]+/).map(Number); if (p.length >= 3 && p.every(isFinite)) a = p; }
    if (a && typeof a === "object" && !Array.isArray(a)) a = [a.x, a.y, a.z];
    if (!Array.isArray(a) || a.length < 3 || !a.slice(0, 3).every((x) => isFinite(Number(x)))) a = d || [0, 0, 0];
    return "Vector3.new(" + nn(a[0]) + "," + nn(a[1]) + "," + nn(a[2]) + ")";
  };
  const axis = (v) => { const a = String(v || "x").trim().toLowerCase(); return a === "y" || a === "z" ? a : "x"; };
  const mat = (v) => { const m = String(v || "").replace(/[^A-Za-z]/g, ""); return m ? "Enum.Material." + m[0].toUpperCase() + m.slice(1) : "nil"; };

  // Shared Luau prelude (kept small: every command pays for it).
  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local ServerStorage=game:GetService('ServerStorage')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end",
    "local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end if lp=='workspace' then return workspace end local cur=game for seg in p:gmatch('[^%.]+') do local nxt=nil if cur==game then local okS,svc=pcall(function() return game:GetService(seg) end) if okS and svc then nxt=svc end end if not nxt then nxt=cur:FindFirstChild(seg) end if not nxt then return nil end cur=nxt end return cur end",
    "local function need(p,what) local i=resolve(p) if not i then error((what or 'instance')..' not found: '..tostring(p)) end return i end",
    "local function allParts(root) local out={} if root:IsA('BasePart') then out[1]=root end for _,d in ipairs(root:GetDescendants()) do if d:IsA('BasePart') then out[#out+1]=d end end return out end",
    "local function bbox(root) if root:IsA('BasePart') then return root.CFrame,root.Size end if root:IsA('Model') then local cf,sz=root:GetBoundingBox() return cf,sz end local mn,mx=nil,nil for _,p in ipairs(allParts(root)) do local h=p.Size/2 local a,b=p.Position-h,p.Position+h mn=mn and Vector3.new(math.min(mn.X,a.X),math.min(mn.Y,a.Y),math.min(mn.Z,a.Z)) or a mx=mx and Vector3.new(math.max(mx.X,b.X),math.max(mx.Y,b.Y),math.max(mx.Z,b.Z)) or b end if not mn then return CFrame.new(),Vector3.new() end return CFrame.new((mn+mx)/2),mx-mn end",
    "local function moveBy(root,delta) if root:IsA('BasePart') then root.CFrame=root.CFrame+delta elseif root:IsA('PVInstance') then root:PivotTo(root:GetPivot()+delta) else for _,p in ipairs(allParts(root)) do p.CFrame=p.CFrame+delta end end end",
    "local function lines(src) local out={} for l in (src..'\\n'):gmatch('(.-)\\n') do out[#out+1]=l end if out[#out]=='' then out[#out]=nil end return out end",
    "local function isScript(i) return i:IsA('LuaSourceContainer') end",
    "local function scriptsUnder(root) local out={} if root and isScript(root) then out[1]=root end for _,d in ipairs((root or game):GetDescendants()) do if isScript(d) then out[#out+1]=d end end return out end",
    "local function wp(root) local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('TotalScript') end) return okW and w or nil end",
    "local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end",
    "local function plainCount(s,needle) local n,i=0,1 while true do local a,b=string.find(s,needle,i,true) if not a then break end n+=1 i=b+1 end return n end",
    "local function escPat(s) return (tostring(s):gsub('[%^%$%(%)%%%.%[%]%*%+%-%?]','%%%0')) end",
  ].join("\n");

  // Memory handbook helpers (only prepended by memory_* builders).
  const MEM = [
    "local MEM_SKELETON='# Project memory\\n## Overview\\n## Where things live\\n## Conventions\\n## Key systems\\n## Decisions & gotchas\\n## User preferences\\n## Open questions / TODO'",
    "local function memModule(create) local folder=ServerStorage:FindFirstChild('RobloxScript') if not folder then if not create then return nil end folder=Instance.new('Folder') folder.Name='RobloxScript' folder.Parent=ServerStorage end local m=folder:FindFirstChild('Memory') if not m then if not create then return nil end m=Instance.new('ModuleScript') m.Name='Memory' m.Source='return [==[\\n'..MEM_SKELETON..'\\n]==]' m.Parent=folder end return m end",
    "local function memBody(m) local src=m.Source local body=src:match('%[==%[\\n?(.-)\\n?%]==%]') if not body then body=src:match('%[%[\\n?(.-)\\n?%]%]') end return body or MEM_SKELETON end",
    "local function memParse(body) local secs,order={},{} local cur='_head' secs[cur]={} order[1]=cur for _,line in ipairs(lines(body)) do local h=line:match('^##%s+(.-)%s*$') if h then cur=h if not secs[cur] then secs[cur]={} order[#order+1]=cur end else table.insert(secs[cur],line) end end return secs,order end",
    "local function memJoin(secs,order) local out={} for _,name in ipairs(order) do local body=secs[name] while #body>0 and body[#body]:match('^%s*$') do body[#body]=nil end if name~='_head' then out[#out+1]='## '..name end for _,l in ipairs(body) do out[#out+1]=l end end return table.concat(out,'\\n') end",
    "local function memFind(secs,order,name) if not name or name=='' then return nil end local ln=tostring(name):lower() for _,n in ipairs(order) do if n~='_head' and n:lower()==ln then return n end end for _,n in ipairs(order) do if n~='_head' and n:lower():find(ln,1,true) then return n end end return nil end",
    "local function memSave(m,body) body=body:gsub('%]==%]','] == ]') if #body>14000 then error('memory would exceed 14000 characters ('..#body..'); compress or remove obsolete facts first') end m.Source='return [==[\\n'..body..'\\n]==]' return #body end",
  ].join("\n");

  const B = {};

  // ───────────────────────── script_* ─────────────────────────
  B.script_replace = (a) => {
    const pattern = bb(a.pattern || a.lua_pattern, false);
    const all = bb(a.all, true);
    const expected = a.expected === undefined || a.expected === null || a.expected === "" ? "nil" : nn(a.expected, -1);
    return [
      "local s=need(" + q(a.path) + ",'script') if not isScript(s) then return fail('not a script: '..s:GetFullName()) end",
      "local find,rep,usePat,all,expected=" + q(a.find ?? a.old ?? a.query ?? "") + "," + q(a.replace ?? a.new ?? a.replacement ?? "") + "," + pattern + "," + all + "," + expected,
      "if find=='' then return fail('find must not be empty') end",
      "local src=s.Source local count",
      "if usePat then local okP,err=pcall(string.find,'',find) if not okP then return fail('invalid Lua pattern: '..tostring(err)) end count=select(2,src:gsub(find,'')) if count>0 then local repEsc=(rep:gsub('%%','%%%%')) if all then src=src:gsub(find,repEsc) else src=src:gsub(find,repEsc,1) count=1 end end",
      "else count=plainCount(src,find) if count>0 then local out,i={},1 local done=0 while true do local x,y=string.find(src,find,i,true) if not x or (not all and done>=1) then break end out[#out+1]=src:sub(i,x-1) out[#out+1]=rep i=y+1 done+=1 end out[#out+1]=src:sub(i) src=table.concat(out) if not all then count=done end end end",
      "if count==0 then return fail('no match for the given text in '..s:GetFullName()..' - script_read it and copy the exact text') end",
      "if expected and expected>=0 and count~=expected then return fail('expected '..expected..' match(es) but found '..count..'; nothing changed - refine the find text or pass expected='..count) end",
      "local rec=wp() s.Source=src wpDone(rec)",
      "return ok({path=s:GetFullName(),replaced=count,lines=#lines(src)},'replaced '..count..' occurrence(s)')",
    ].join("\n");
  };
  B.script_insert = (a) => [
    "local s=need(" + q(a.path) + ",'script') if not isScript(s) then return fail('not a script: '..s:GetFullName()) end",
    "local text,lineNo,afterMark,beforeMark,pos=" + q(a.text ?? a.content ?? a.code ?? "") + "," + (a.line ? nn(a.line) : "nil") + "," + q(a.after || "") + "," + q(a.before || "") + "," + q(String(a.position || "").toLowerCase()),
    "if text=='' then return fail('text must not be empty') end",
    "local ls=lines(s.Source) local idx",
    "if lineNo then idx=math.clamp(math.floor(lineNo),1,#ls+1)",
    "elseif afterMark~='' then for i,l in ipairs(ls) do if l:find(afterMark,1,true) then idx=i+1 break end end if not idx then return fail('marker not found: '..afterMark) end",
    "elseif beforeMark~='' then for i,l in ipairs(ls) do if l:find(beforeMark,1,true) then idx=i break end end if not idx then return fail('marker not found: '..beforeMark) end",
    "elseif pos=='top' then idx=1 else idx=#ls+1 end",
    "local ins=lines(text) for k=#ins,1,-1 do table.insert(ls,idx,ins[k]) end",
    "local rec=wp() s.Source=table.concat(ls,'\\n') wpDone(rec)",
    "return ok({path=s:GetFullName(),at_line=idx,inserted=#ins,lines=#ls},'inserted '..#ins..' line(s) at line '..idx)",
  ].join("\n");
  B.script_delete_lines = (a) => [
    "local s=need(" + q(a.path) + ",'script') if not isScript(s) then return fail('not a script: '..s:GetFullName()) end",
    "local a1,b1=" + nn(a.start ?? a.from ?? 1, 1) + "," + nn(a.end ?? a.to ?? a.start ?? 1, 1),
    "local ls=lines(s.Source) if a1<1 or b1>#ls or a1>b1 then return fail('range '..a1..'-'..b1..' outside 1-'..#ls) end",
    "local removed={} for i=b1,a1,-1 do removed[#removed+1]=ls[i] table.remove(ls,i) end",
    "local rec=wp() s.Source=table.concat(ls,'\\n') wpDone(rec)",
    "return ok({path=s:GetFullName(),removed=b1-a1+1,lines=#ls,preview=(removed[#removed] or ''):sub(1,120)},'deleted lines '..a1..'-'..b1)",
  ].join("\n");
  B.script_outline = (a) => [
    "local s=need(" + q(a.path) + ",'script') if not isScript(s) then return fail('not a script: '..s:GetFullName()) end",
    "local ls=lines(s.Source) local fns,reqs,conns,remotes,services,todo={},{},{},{},{},{}",
    "for i,l in ipairs(ls) do",
    "  local f=l:match('^%s*local%s+function%s+([%w_%.:]+)') or l:match('^%s*function%s+([%w_%.:]+)') or l:match('^%s*([%w_%.]+)%s*=%s*function%s*%(')",
    "  if f then fns[#fns+1]={name=f,line=i} end",
    "  for r in l:gmatch('require%s*%(?%s*([^%)\\n]+)%)') do reqs[#reqs+1]={target=r,line=i} end",
    "  local ev=l:match('([%w_%.:]+)[:%.]Connect%s*%(') if ev then conns[#conns+1]={signal=ev,line=i} end",
    "  if l:find('FireServer',1,true) or l:find('FireClient',1,true) or l:find('InvokeServer',1,true) or l:find('OnServerEvent',1,true) or l:find('OnClientEvent',1,true) then remotes[#remotes+1]=i end",
    "  for sv in l:gmatch('GetService%s*%(%s*[\\'\"]([%w]+)[\\'\"]') do services[sv]=true end",
    "  if l:match('%-%-%s*TODO') or l:match('%-%-%s*FIXME') or l:match('%-%-%s*HACK') then todo[#todo+1]=i end",
    "end",
    "local svc={} for k in pairs(services) do svc[#svc+1]=k end table.sort(svc)",
    "return ok({path=s:GetFullName(),class=s.ClassName,enabled=(not s:IsA('BaseScript')) or (not s.Disabled),lines=#ls,chars=#s.Source,functions=fns,requires=reqs,connections=conns,remote_lines=remotes,services=svc,todo_lines=todo},#fns..' function(s), '..#reqs..' require(s), '..#conns..' connection(s), '..#ls..' lines')",
  ].join("\n");
  B.script_find_usages = (a) => [
    "local root=" + (a.root || a.path ? "need(" + q(a.root || a.path) + ",'root')" : "game"),
    "local sym=" + q(a.symbol ?? a.name ?? a.query ?? "") + " if sym=='' then return fail('symbol required') end",
    "local pat='%f[%w_]'..escPat(sym)..'%f[^%w_]' local cap=" + nn(a.limit, 60),
    "local hits,total,files={},0,0",
    "for _,s in ipairs(scriptsUnder(root)) do local src=s.Source if src:find(sym,1,true) then local n=0 local first={} for i,l in ipairs(lines(src)) do if l:find(pat) then n+=1 if #first<4 then first[#first+1]={line=i,text=l:sub(1,140)} end end end if n>0 then files+=1 total+=n if #hits<cap then hits[#hits+1]={path=s:GetFullName(),count=n,lines=first} end end end end",
    "return ok({symbol=sym,scripts=files,total=total,hits=hits},total..' usage(s) of '..sym..' in '..files..' script(s)')",
  ].join("\n");
  B.script_rename_symbol = (a) => [
    "local root=" + (a.root ? "need(" + q(a.root) + ",'root')" : "game"),
    "local old,new,dry=" + q(a.old ?? a.from ?? "") + "," + q(a.new ?? a.to ?? "") + "," + bb(a.dry_run, false),
    "if old=='' or new=='' then return fail('old and new required') end if not new:match('^[%a_][%w_%.]*$') then return fail('new must be a valid identifier') end",
    "local pat='%f[%w_]'..escPat(old)..'%f[^%w_]' local rep=new:gsub('%%','%%%%') local changed,total={},0 local rec=if dry then nil else wp()",
    "for _,s in ipairs(scriptsUnder(root)) do local src=s.Source if src:find(old,1,true) then local out,n=src:gsub(pat,rep) if n>0 then total+=n changed[#changed+1]={path=s:GetFullName(),count=n} if not dry then s.Source=out end end end end",
    "wpDone(rec)",
    "return ok({old=old,new=new,dry_run=dry,scripts=#changed,total=total,changed=changed},(dry and 'would rename ' or 'renamed ')..total..' occurrence(s) in '..#changed..' script(s)')",
  ].join("\n");
  B.script_lint = (a) => [
    "local root=" + (a.path || a.root ? "need(" + q(a.path || a.root) + ",'script or folder')" : "game"),
    "local cap=" + nn(a.limit, 80) + " local issues,count={},0",
    "local rules={",
    "  {'deprecated wait() - use task.wait()','^%s*wait%s*%(',true},{'deprecated wait() - use task.wait()','[^%w_%.:]wait%s*%(',true},",
    "  {'deprecated spawn()/delay() - use task.spawn/task.delay','[^%w_%.:]spawn%s*%(',true},{'deprecated delay() - use task.delay','[^%w_%.:]delay%s*%(',true},",
    "  {'lowercase :connect() is deprecated - use :Connect()',':connect%s*%(',false},{'lowercase :wait() is deprecated - use :Wait()',':wait%s*%(',false},",
    "  {'Instance.new(class, parent) second argument is slow - set .Parent last','Instance%.new%s*%([^,%)]+,',false},",
    "  {'FindFirstChild chain in a loop is slow - cache references','for .-FindFirstChild.-FindFirstChild',false},",
    "  {'game.Workspace/Players via dot - prefer game:GetService()','game%.Workspace%.','game%.Players'},",
    "  {'possible global assignment (missing local)','^%s*[%a_][%w_]*%s*=[^=]',false},",
    "  {'while true do without a wait inside the line - verify the loop yields','while%s+true%s+do%s*$',false},",
    "  {'print() left in code - remove or route through a logger','^%s*print%s*%(',false},",
    "}",
    "local declared={}",
    "for _,s in ipairs(scriptsUnder(root)) do local ls=lines(s.Source) local locals={} for i,l in ipairs(ls) do",
    "  local trimmed=l:gsub('^%s+','') if trimmed:sub(1,2)~='--' then",
    "    for ln in l:gmatch('local%s+([%a_][%w_]*)') do locals[ln]=true end",
    "    for _,r in ipairs(rules) do local label,pat=r[1],r[2] local hit=l:find(pat) if hit and label:find('global assignment',1,true) then local nm=l:match('^%s*([%a_][%w_]*)%s*=') hit=nm and not locals[nm] and nm~='_' and not l:match('^%s*local') or false end",
    "      if hit then count+=1 if #issues<cap then issues[#issues+1]={path=s:GetFullName(),line=i,issue=label,text=trimmed:sub(1,120)} end break end end",
    "  end end end",
    "return ok({issues=count,shown=#issues,items=issues},count..' lint issue(s) found')",
  ].join("\n");
  B.script_todo = (a) => [
    "local root=" + (a.root || a.path ? "need(" + q(a.root || a.path) + ",'root')" : "game") + " local cap=" + nn(a.limit, 80),
    "local items,count={},0 for _,s in ipairs(scriptsUnder(root)) do if s.Source:find('TODO',1,true) or s.Source:find('FIXME',1,true) or s.Source:find('HACK',1,true) then for i,l in ipairs(lines(s.Source)) do local tag=l:match('%-%-%s*(TODO)') or l:match('%-%-%s*(FIXME)') or l:match('%-%-%s*(HACK)') if tag then count+=1 if #items<cap then items[#items+1]={path=s:GetFullName(),line=i,tag=tag,text=(l:gsub('^%s+','')):sub(1,140)} end end end end end",
    "return ok({count=count,items=items},count..' TODO/FIXME/HACK comment(s)')",
  ].join("\n");
  B.script_requires = (a) => [
    "local root=" + (a.root || a.path ? "need(" + q(a.root || a.path) + ",'root')" : "game"),
    "local modules,byName={},{} for _,s in ipairs(scriptsUnder(root)) do if s:IsA('ModuleScript') then modules[#modules+1]=s byName[s.Name]=(byName[s.Name] or 0)+1 end end",
    "local usedBy={} local edges,total={},0",
    "for _,s in ipairs(scriptsUnder(root)) do local src=s.Source if src:find('require',1,true) then for i,l in ipairs(lines(src)) do for target in l:gmatch('require%s*%(%s*([^%)]+)%)') do total+=1 local nm=target:match('([%a_][%w_]*)%s*$') or target:match('[\\'\"]([^\\'\"]+)[\\'\"]') or target local asset=target:match('^%s*(%d+)%s*$') if #edges<200 then edges[#edges+1]={from=s:GetFullName(),target=target,line=i,asset_id=asset} end if nm then usedBy[nm]=(usedBy[nm] or 0)+1 end end end end end",
    "local orphans={} for _,m in ipairs(modules) do if not usedBy[m.Name] and #orphans<60 then orphans[#orphans+1]=m:GetFullName() end end",
    "local dup={} for n,c in pairs(byName) do if c>1 then dup[#dup+1]=n..' x'..c end end",
    "return ok({modules=#modules,requires=total,edges=edges,orphan_modules=orphans,duplicate_module_names=dup},#modules..' module(s), '..total..' require(s), '..#orphans..' never required by name')",
  ].join("\n");
  B.script_backup = (a) => [
    "local s=need(" + q(a.path) + ",'script') if not isScript(s) then return fail('not a script: '..s:GetFullName()) end",
    "local folder=ServerStorage:FindFirstChild('RobloxScript') if not folder then folder=Instance.new('Folder') folder.Name='RobloxScript' folder.Parent=ServerStorage end",
    "local bk=folder:FindFirstChild('Backups') if not bk then bk=Instance.new('Folder') bk.Name='Backups' bk.Parent=folder end",
    "local stamp=os.date('!%Y%m%d_%H%M%S') local copy=Instance.new('ModuleScript') copy.Name=s.Name..'__'..stamp copy.Source=s.Source copy:SetAttribute('OriginalPath',s:GetFullName()) copy:SetAttribute('OriginalClass',s.ClassName) copy:SetAttribute('SavedAt',stamp) copy.Parent=bk",
    "local keep=" + nn(a.keep, 10) + " local mine={} for _,c in ipairs(bk:GetChildren()) do if c:GetAttribute('OriginalPath')==s:GetFullName() then mine[#mine+1]=c end end table.sort(mine,function(x,y) return tostring(x:GetAttribute('SavedAt'))<tostring(y:GetAttribute('SavedAt')) end) while #mine>keep do mine[1]:Destroy() table.remove(mine,1) end",
    "return ok({backup=copy:GetFullName(),chars=#s.Source,kept=#mine},'backup saved: '..copy.Name)",
  ].join("\n");
  B.script_restore = (a) => [
    "local s=need(" + q(a.path) + ",'script') if not isScript(s) then return fail('not a script: '..s:GetFullName()) end",
    "local bk=ServerStorage:FindFirstChild('RobloxScript') bk=bk and bk:FindFirstChild('Backups') if not bk then return fail('no backups folder (use script_backup first)') end",
    "local want=" + q(a.backup || "") + " local pick=nil local latest=''",
    "for _,c in ipairs(bk:GetChildren()) do if c:GetAttribute('OriginalPath')==s:GetFullName() then if want~='' then if c.Name==want or c.Name:find(want,1,true) then pick=c end elseif tostring(c:GetAttribute('SavedAt'))>=latest then latest=tostring(c:GetAttribute('SavedAt')) pick=c end end end",
    "if not pick then return fail('no matching backup for '..s:GetFullName()) end",
    "local rec=wp() s.Source=pick.Source wpDone(rec)",
    "return ok({path=s:GetFullName(),restored_from=pick.Name,chars=#pick.Source},'restored from '..pick.Name)",
  ].join("\n");
  B.script_backups_list = (a) => [
    "local bk=ServerStorage:FindFirstChild('RobloxScript') bk=bk and bk:FindFirstChild('Backups') if not bk then return ok({items={}},'no backups yet') end",
    "local filter=" + q(a.path || "") + " local items={} for _,c in ipairs(bk:GetChildren()) do local op=tostring(c:GetAttribute('OriginalPath') or '') if filter=='' or op:find(filter,1,true) then items[#items+1]={name=c.Name,original=op,saved_at=c:GetAttribute('SavedAt'),chars=#c.Source} end end",
    "table.sort(items,function(x,y) return tostring(x.saved_at)>tostring(y.saved_at) end)",
    "return ok({items=items},#items..' backup(s)')",
  ].join("\n");

  // ───────────────────────── model_* ─────────────────────────
  B.model_build = (a) => {
    const parts = Array.isArray(a.parts) ? a.parts : (typeof a.parts === "string" ? (() => { try { return JSON.parse(a.parts); } catch { return []; } })() : []);
    return [
      "local spec=HttpService:JSONDecode(" + jj(parts) + ") if type(spec)~='table' or #spec==0 then return fail('parts must be a non-empty array of {name,size,position,color,material,shape,anchored,transparency,rotation}') end",
      "local parent=" + (a.parent || a.parent_path ? "need(" + q(a.parent || a.parent_path) + ",'parent')" : "workspace"),
      "local rec=wp() local m=Instance.new('Model') m.Name=" + q(a.name || "Model") + " local made={}",
      "local function v3(t,d) if type(t)=='table' then return Vector3.new(tonumber(t[1] or t.x) or d.X,tonumber(t[2] or t.y) or d.Y,tonumber(t[3] or t.z) or d.Z) elseif type(t)=='string' then local x,y,z=t:match('([%-%d%.]+)[,%s]+([%-%d%.]+)[,%s]+([%-%d%.]+)') if x then return Vector3.new(tonumber(x),tonumber(y),tonumber(z)) end end return d end",
      "local function col(t) if type(t)=='table' then return Color3.fromRGB(tonumber(t[1]) or 163,tonumber(t[2]) or 162,tonumber(t[3]) or 165) elseif type(t)=='string' then local h=t:match('^#?(%x%x%x%x%x%x)$') if h then return Color3.fromRGB(tonumber(h:sub(1,2),16),tonumber(h:sub(3,4),16),tonumber(h:sub(5,6),16)) end local okB,bc=pcall(BrickColor.new,t) if okB and bc and bc.Name~='Medium stone grey' or (okB and t=='Medium stone grey') then return bc.Color end end return nil end",
      "for i,p in ipairs(spec) do if type(p)=='table' then local shape=tostring(p.shape or p.className or 'Part') local part if shape=='Wedge' or shape=='WedgePart' then part=Instance.new('WedgePart') elseif shape=='Corner' or shape=='CornerWedgePart' then part=Instance.new('CornerWedgePart') elseif shape=='Truss' or shape=='TrussPart' then part=Instance.new('TrussPart') else part=Instance.new('Part') if shape=='Ball' or shape=='Sphere' then part.Shape=Enum.PartType.Ball elseif shape=='Cylinder' then part.Shape=Enum.PartType.Cylinder elseif shape=='Wedge' then part.Shape=Enum.PartType.Wedge end end",
      "  part.Name=tostring(p.name or ('Part'..i)) part.Size=v3(p.size,Vector3.new(4,1,2)) local pos=v3(p.position or p.pos,Vector3.new(0,i*2,0)) local rot=v3(p.rotation or p.rot,Vector3.new()) part.CFrame=CFrame.new(pos)*CFrame.Angles(math.rad(rot.X),math.rad(rot.Y),math.rad(rot.Z))",
      "  part.Anchored=(p.anchored~=false) local c=col(p.color) if c then part.Color=c end if p.material then local okM,mt=pcall(function() return Enum.Material[tostring(p.material)] end) if okM and mt then part.Material=mt end end if p.transparency then part.Transparency=tonumber(p.transparency) or 0 end if p.reflectance then part.Reflectance=tonumber(p.reflectance) or 0 end if p.cancollide~=nil then part.CanCollide=p.cancollide and true or false end",
      "  if type(p.attributes)=='table' then for k,v in pairs(p.attributes) do pcall(function() part:SetAttribute(k,v) end) end end",
      "  part.Parent=m made[#made+1]=part end end",
      "if #made==0 then m:Destroy() return fail('no valid part specs') end",
      "local primaryName=" + q(a.primary || "") + " local prim=nil if primaryName~='' then prim=m:FindFirstChild(primaryName) end m.PrimaryPart=prim or made[1]",
      "local cf,sz=m:GetBoundingBox() local footCF=CFrame.new(cf.Position-Vector3.new(0,sz.Y/2,0)) m.PrimaryPart.PivotOffset=m.PrimaryPart.CFrame:ToObjectSpace(footCF) m.WorldPivot=footCF",
      (a.position ? "m:PivotTo(CFrame.new(" + vec(a.position) + "))" : "-- keep authored positions"),
      "m.Parent=parent wpDone(rec)",
      "return ok({path=m:GetFullName(),parts=#made,size={sz.X,sz.Y,sz.Z},primary=m.PrimaryPart.Name},'built '..m.Name..' with '..#made..' part(s)')",
    ].join("\n");
  };
  B.model_report = (a) => [
    "local root=need(" + q(a.path) + ",'model')",
    "local parts=allParts(root) local mats,unanch,meshes,unions,scripts,mass,tris={},0,0,0,0,0,0 local classes={}",
    "for _,p in ipairs(parts) do local mn=p.Material.Name mats[mn]=(mats[mn] or 0)+1 if not p.Anchored then unanch+=1 end if p:IsA('MeshPart') then meshes+=1 elseif p:IsA('UnionOperation') then unions+=1 end pcall(function() mass+=p:GetMass() end) end",
    "for _,d in ipairs(root:GetDescendants()) do classes[d.ClassName]=(classes[d.ClassName] or 0)+1 if isScript(d) then scripts+=1 end end",
    "local cf,sz=bbox(root) local matList={} for k,v in pairs(mats) do matList[#matList+1]={material=k,count=v} end table.sort(matList,function(x,y) return x.count>y.count end)",
    "local top={} for k,v in pairs(classes) do top[#top+1]={class=k,count=v} end table.sort(top,function(x,y) return x.count>y.count end) while #top>12 do top[#top]=nil end",
    "local prim=root:IsA('Model') and root.PrimaryPart and root.PrimaryPart.Name or nil",
    "return ok({path=root:GetFullName(),class=root.ClassName,parts=#parts,mesh_parts=meshes,unions=unions,unanchored=unanch,scripts=scripts,total_mass=math.floor(mass*100)/100,size={math.floor(sz.X*100)/100,math.floor(sz.Y*100)/100,math.floor(sz.Z*100)/100},center={math.floor(cf.X*100)/100,math.floor(cf.Y*100)/100,math.floor(cf.Z*100)/100},primary_part=prim,materials=matList,classes=top,descendants=#root:GetDescendants()},#parts..' part(s), '..unanch..' unanchored, size '..string.format('%.1f x %.1f x %.1f',sz.X,sz.Y,sz.Z))",
  ].join("\n");
  B.model_center_pivot = (a) => [
    "local m=need(" + q(a.path) + ",'model') if not m:IsA('Model') then return fail('model_center_pivot needs a Model') end",
    "local cf,sz=m:GetBoundingBox() local bottom=" + bb(a.bottom, true),
    "local rec=wp() local pivotCF=if bottom then CFrame.new(cf.Position-Vector3.new(0,sz.Y/2,0)) else CFrame.new(cf.Position) m.WorldPivot=pivotCF if m.PrimaryPart then m.PrimaryPart.PivotOffset=m.PrimaryPart.CFrame:ToObjectSpace(pivotCF) end wpDone(rec)",
    "local p=m:GetPivot().Position return ok({path=m:GetFullName(),pivot={p.X,p.Y,p.Z},bottom=bottom},'pivot set to bounding-box '..(bottom and 'bottom center' or 'center'))",
  ].join("\n");
  B.model_snap_to_ground = (a) => [
    "local m=need(" + q(a.path) + ",'model') local cf,sz=bbox(m) local parts=allParts(m)",
    "local rp=RaycastParams.new() rp.FilterType=Enum.RaycastFilterType.Exclude rp.FilterDescendantsInstances={m} rp.IgnoreWater=" + bb(a.ignore_water, true),
    "local origin=cf.Position local res=workspace:Raycast(origin+Vector3.new(0,sz.Y/2,0),Vector3.new(0,-" + nn(a.max_distance, 500) + ",0),rp)",
    "if not res then return fail('nothing below the model within range') end",
    "local bottomY=cf.Position.Y-sz.Y/2 local dy=(res.Position.Y+" + nn(a.offset, 0) + ")-bottomY",
    "local rec=wp() moveBy(m,Vector3.new(0,dy,0)) wpDone(rec)",
    "return ok({path=m:GetFullName(),moved_y=math.floor(dy*1000)/1000,landed_on=res.Instance:GetFullName()},string.format('snapped %.2f studs onto %s',dy,res.Instance.Name))",
  ].join("\n");
  B.model_align = (a) => {
    const paths = Array.isArray(a.paths) ? a.paths : String(a.paths || a.path || "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    return [
      "local list={} for _,p in ipairs(HttpService:JSONDecode(" + jj(paths) + ")) do local i=resolve(p) if i then list[#list+1]=i end end",
      "if #list<2 then return fail('give at least two existing paths') end",
      "local ax,mode=" + q(axis(a.axis)) + "," + q(String(a.mode || "center").toLowerCase()) + " local comp=({x='X',y='Y',z='Z'})[ax]",
      "local function edge(i) local cf,sz=bbox(i) local c=cf.Position[comp] local h=sz[comp]/2 if mode=='min' then return c-h elseif mode=='max' then return c+h end return c end",
      "local target=edge(list[1]) local moved=0 local rec=wp()",
      "for k=2,#list do local d=target-edge(list[k]) if math.abs(d)>1e-4 then moveBy(list[k],Vector3.new(ax=='x' and d or 0,ax=='y' and d or 0,ax=='z' and d or 0)) moved+=1 end end wpDone(rec)",
      "return ok({axis=ax,mode=mode,reference=list[1]:GetFullName(),moved=moved},'aligned '..moved..' object(s) on '..ax..' ('..mode..')')",
    ].join("\n");
  };
  B.model_distribute = (a) => {
    const paths = Array.isArray(a.paths) ? a.paths : String(a.paths || a.path || "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    return [
      "local list={} for _,p in ipairs(HttpService:JSONDecode(" + jj(paths) + ")) do local i=resolve(p) if i then list[#list+1]=i end end",
      "if #list<3 and " + (a.gap === undefined ? "true" : "false") + " then return fail('give at least three paths (or two plus gap)') end",
      "local ax=" + q(axis(a.axis)) + " local comp=({x='X',y='Y',z='Z'})[ax] local gap=" + (a.gap === undefined || a.gap === null || a.gap === "" ? "nil" : nn(a.gap)),
      "local function c(i) return (bbox(i)).Position[comp] end local function s(i) local _,sz=bbox(i) return sz[comp] end",
      "table.sort(list,function(x,y) return c(x)<c(y) end)",
      "local rec=wp() local moved=0",
      "if gap then local cursor=c(list[1])+s(list[1])/2 for k=2,#list do local want=cursor+gap+s(list[k])/2 local d=want-c(list[k]) if math.abs(d)>1e-4 then moveBy(list[k],Vector3.new(ax=='x' and d or 0,ax=='y' and d or 0,ax=='z' and d or 0)) moved+=1 end cursor=want+s(list[k])/2 end",
      "else local first,last=c(list[1]),c(list[#list]) local step=(last-first)/(#list-1) for k=2,#list-1 do local want=first+step*(k-1) local d=want-c(list[k]) if math.abs(d)>1e-4 then moveBy(list[k],Vector3.new(ax=='x' and d or 0,ax=='y' and d or 0,ax=='z' and d or 0)) moved+=1 end end end",
      "wpDone(rec) return ok({axis=ax,count=#list,moved=moved,gap=gap},'distributed '..#list..' object(s) along '..ax)",
    ].join("\n");
  };
  B.model_array_radial = (a) => [
    "local src=need(" + q(a.path) + ",'source') if not (src:IsA('BasePart') or src:IsA('Model')) then return fail('source must be a Part or Model') end",
    "local count,radius=" + nn(a.count, 8) + "," + nn(a.radius, 10) + " if count<1 or count>200 then return fail('count must be 1-200') end",
    "local center=" + (a.center ? vec(a.center) : "src:GetPivot().Position") + " local face=" + bb(a.face_center, true) + " local startDeg,sweep=" + nn(a.start_angle, 0) + "," + nn(a.sweep, 360),
    "local parent=" + (a.parent ? "need(" + q(a.parent) + ",'parent')" : "src.Parent") + " local holder=Instance.new('Model') holder.Name=" + q(a.name || "") + "~='' and " + q(a.name || "") + " or (src.Name..'_Radial')",
    "local rec=wp() local made={} local step=if count>1 and sweep>=360 then 360/count else (count>1 and sweep/(count-1) or 0)",
    "for i=0,count-1 do local ang=math.rad(startDeg+step*i) local pos=center+Vector3.new(math.cos(ang)*radius,0,math.sin(ang)*radius) local c=src:Clone() c.Name=src.Name..'_'..(i+1) local cf=if face then CFrame.lookAt(pos,Vector3.new(center.X,pos.Y,center.Z)) else CFrame.new(pos)*(src:GetPivot()-src:GetPivot().Position) c:PivotTo(cf) c.Parent=holder made[#made+1]=c end",
    "holder.Parent=parent " + (bb(a.keep_source, true) === "true" ? "" : "src:Destroy()") + " wpDone(rec)",
    "return ok({path=holder:GetFullName(),count=#made,radius=radius},'placed '..#made..' copies in a circle of radius '..radius)",
  ].join("\n");
  B.model_wall = (a) => [
    "local p1,p2=" + vec(a.from, [0, 0, 0]) + "," + vec(a.to, [10, 0, 0]) + " local h,t=" + nn(a.height, 10) + "," + nn(a.thickness, 1),
    "local flat=Vector3.new(p2.X-p1.X,0,p2.Z-p1.Z) local len=flat.Magnitude if len<0.05 then return fail('from and to are the same point') end",
    "local parent=" + (a.parent ? "need(" + q(a.parent) + ",'parent')" : "workspace"),
    "local rec=wp() local w=Instance.new('Part') w.Name=" + q(a.name || "Wall") + " w.Anchored=true w.Size=Vector3.new(len,h,t) local mid=(p1+p2)/2 w.CFrame=CFrame.lookAt(Vector3.new(mid.X,math.min(p1.Y,p2.Y)+h/2,mid.Z),Vector3.new(mid.X,math.min(p1.Y,p2.Y)+h/2,mid.Z)+flat.Unit:Cross(Vector3.yAxis))",
    "w.Material=" + mat(a.material || "Concrete") + " or Enum.Material.Concrete local c=" + cc(a.color, [160, 160, 155]) + " if c then w.Color=c end w.TopSurface=Enum.SurfaceType.Smooth w.BottomSurface=Enum.SurfaceType.Smooth w.Parent=parent wpDone(rec)",
    "return ok({path=w:GetFullName(),length=math.floor(len*100)/100,height=h,thickness=t},string.format('wall %.1f long, %.1f high',len,h))",
  ].join("\n");
  B.model_hollow_box = (a) => [
    "local pos,size,t=" + vec(a.position, [0, 10, 0]) + "," + vec(a.size, [20, 10, 20]) + "," + nn(a.thickness, 1) + " local openTop=" + bb(a.open_top, false) + " local openBottom=" + bb(a.open_bottom, false),
    "if size.X<=t*2 or size.Z<=t*2 or size.Y<=t then return fail('size too small for the given thickness') end",
    "local parent=" + (a.parent ? "need(" + q(a.parent) + ",'parent')" : "workspace"),
    "local rec=wp() local m=Instance.new('Model') m.Name=" + q(a.name || "Room") + " local matv=" + mat(a.material || "Concrete") + " or Enum.Material.Concrete local c=" + cc(a.color, [170, 170, 165]),
    "local function slab(n,sz,off) local p=Instance.new('Part') p.Name=n p.Anchored=true p.Size=sz p.CFrame=CFrame.new(pos+off) p.Material=matv if c then p.Color=c end p.TopSurface=Enum.SurfaceType.Smooth p.BottomSurface=Enum.SurfaceType.Smooth p.Parent=m return p end",
    "local hx,hy,hz=size.X/2,size.Y/2,size.Z/2",
    "if not openBottom then slab('Floor',Vector3.new(size.X,t,size.Z),Vector3.new(0,-hy+t/2,0)) end",
    "if not openTop then slab('Ceiling',Vector3.new(size.X,t,size.Z),Vector3.new(0,hy-t/2,0)) end",
    "local wallH=size.Y-(openBottom and 0 or t)-(openTop and 0 or t) local wallY=(openBottom and -hy or -hy+t)+wallH/2",
    "slab('WallNorth',Vector3.new(size.X,wallH,t),Vector3.new(0,wallY,-hz+t/2)) slab('WallSouth',Vector3.new(size.X,wallH,t),Vector3.new(0,wallY,hz-t/2))",
    "slab('WallWest',Vector3.new(t,wallH,size.Z-2*t),Vector3.new(-hx+t/2,wallY,0)) slab('WallEast',Vector3.new(t,wallH,size.Z-2*t),Vector3.new(hx-t/2,wallY,0))",
    "m.PrimaryPart=m:FindFirstChild('Floor') or m:FindFirstChild('WallNorth') local footCF=CFrame.new(pos-Vector3.new(0,hy,0)) m.WorldPivot=footCF if m.PrimaryPart then m.PrimaryPart.PivotOffset=m.PrimaryPart.CFrame:ToObjectSpace(footCF) end m.Parent=parent wpDone(rec)",
    "return ok({path=m:GetFullName(),parts=#m:GetChildren(),size={size.X,size.Y,size.Z}},'hollow box '..m.Name..' with '..#m:GetChildren()..' slabs')",
  ].join("\n");
  B.model_pipe = (a) => {
    const pts = Array.isArray(a.points) ? a.points : [];
    return [
      "local raw=HttpService:JSONDecode(" + jj(pts) + ") local pts={} for _,p in ipairs(raw) do if type(p)=='table' and #p>=3 then pts[#pts+1]=Vector3.new(tonumber(p[1]) or 0,tonumber(p[2]) or 0,tonumber(p[3]) or 0) end end",
      "if #pts<2 then return fail('points must contain at least two [x,y,z] entries') end",
      "local r=" + nn(a.radius, 0.5) + " local parent=" + (a.parent ? "need(" + q(a.parent) + ",'parent')" : "workspace") + " local joints=" + bb(a.joints, true),
      "local rec=wp() local m=Instance.new('Model') m.Name=" + q(a.name || "Pipe") + " local matv=" + mat(a.material || "Metal") + " or Enum.Material.Metal local c=" + cc(a.color, [120, 120, 125]),
      "for i=1,#pts-1 do local a1,b1=pts[i],pts[i+1] local len=(b1-a1).Magnitude if len>0.01 then local seg=Instance.new('Part') seg.Name='Segment'..i seg.Anchored=true seg.Shape=Enum.PartType.Cylinder seg.Size=Vector3.new(len,r*2,r*2) seg.CFrame=CFrame.lookAt((a1+b1)/2,b1)*CFrame.Angles(0,math.rad(90),0) seg.Material=matv if c then seg.Color=c end seg.Parent=m end",
      "  if joints and i<#pts-1 then local j=Instance.new('Part') j.Name='Joint'..i j.Anchored=true j.Shape=Enum.PartType.Ball j.Size=Vector3.new(r*2,r*2,r*2) j.CFrame=CFrame.new(b1) j.Material=matv if c then j.Color=c end j.Parent=m end end",
      "m.PrimaryPart=m:FindFirstChild('Segment1') m.Parent=parent wpDone(rec)",
      "return ok({path=m:GetFullName(),segments=#pts-1,radius=r},'pipe with '..(#pts-1)..' segment(s)')",
    ].join("\n");
  };
  B.model_paint = (a) => [
    "local root=need(" + q(a.path) + ",'model') local onlyClass=" + q(a.only_class || "") + " local n=0 local rec=wp()",
    "local c=" + cc(a.color, null) + " local matv=" + mat(a.material) + " local tr=" + (a.transparency === undefined || a.transparency === "" ? "nil" : nn(a.transparency)) + " local rf=" + (a.reflectance === undefined || a.reflectance === "" ? "nil" : nn(a.reflectance)) + " local cs=" + (a.cast_shadow === undefined ? "nil" : bb(a.cast_shadow)),
    "if not c and not matv and tr==nil and rf==nil and cs==nil then return fail('give at least one of color, material, transparency, reflectance, cast_shadow') end",
    "for _,p in ipairs(allParts(root)) do if onlyClass=='' or p.ClassName==onlyClass then if c then p.Color=c end if matv then p.Material=matv end if tr~=nil then p.Transparency=tr end if rf~=nil then p.Reflectance=rf end if cs~=nil then p.CastShadow=cs end n+=1 end end",
    "wpDone(rec) return ok({path=root:GetFullName(),parts=n},'painted '..n..' part(s)')",
  ].join("\n");
  B.model_anchor_fix = (a) => [
    "local root=need(" + q(a.path) + ",'model') local anchored=" + bb(a.anchored, true) + " local weld=" + bb(a.weld, false) + " local parts=allParts(root) if #parts==0 then return fail('no parts under '..root:GetFullName()) end",
    "local rec=wp() local n,welds=0,0 for _,p in ipairs(parts) do if p.Anchored~=anchored then p.Anchored=anchored n+=1 end end",
    "if weld then local prim=(root:IsA('Model') and root.PrimaryPart) or parts[1] if root:IsA('Model') and not root.PrimaryPart then root.PrimaryPart=prim end for _,p in ipairs(parts) do if p~=prim then local has=false for _,c in ipairs(p:GetChildren()) do if c:IsA('WeldConstraint') and (c.Part0==prim or c.Part1==prim) then has=true break end end if not has then local w=Instance.new('WeldConstraint') w.Part0=prim w.Part1=p w.Parent=p welds+=1 end end end end",
    "wpDone(rec) return ok({path=root:GetFullName(),parts=#parts,changed=n,welds_added=welds,anchored=anchored},(anchored and 'anchored ' or 'unanchored ')..n..' part(s)'..(weld and (', '..welds..' weld(s) added') or ''))",
  ].join("\n");
  B.model_optimize = (a) => [
    "local root=need(" + q(a.path) + ",'model') local smallShadow=" + nn(a.shadow_threshold, 0.75) + " local fidelity=" + q(a.mesh_fidelity || "") + " local dry=" + bb(a.dry_run, false),
    "local rec=if dry then nil else wp() local shadows,fid,emptyC,dupW,surf=0,0,0,0,0",
    "for _,p in ipairs(allParts(root)) do if p.CastShadow and p.Size.X*p.Size.Y*p.Size.Z<smallShadow then shadows+=1 if not dry then p.CastShadow=false end end",
    "  if p.TopSurface~=Enum.SurfaceType.Smooth or p.BottomSurface~=Enum.SurfaceType.Smooth then surf+=1 if not dry then p.TopSurface=Enum.SurfaceType.Smooth p.BottomSurface=Enum.SurfaceType.Smooth end end",
    "  if fidelity~='' and p:IsA('MeshPart') then local okF,want=pcall(function() return Enum.CollisionFidelity[fidelity] end) if okF and want and p.CollisionFidelity~=want then fid+=1 if not dry then pcall(function() p.CollisionFidelity=want end) end end end",
    "  local seen={} for _,c in ipairs(p:GetChildren()) do if c:IsA('WeldConstraint') then local key=tostring(c.Part0)..'|'..tostring(c.Part1) if seen[key] then dupW+=1 if not dry then c:Destroy() end else seen[key]=true end end end end",
    "for _,d in ipairs(root:GetDescendants()) do if (d:IsA('Folder') or d:IsA('Model')) and #d:GetChildren()==0 then emptyC+=1 if not dry then d:Destroy() end end end",
    "wpDone(rec) return ok({path=root:GetFullName(),dry_run=dry,shadows_disabled=shadows,surfaces_smoothed=surf,collision_fidelity_changed=fid,empty_containers_removed=emptyC,duplicate_welds_removed=dupW},(dry and 'would change: ' or 'changed: ')..shadows..' shadows, '..surf..' surfaces, '..fid..' fidelity, '..emptyC..' empty containers, '..dupW..' duplicate welds')",
  ].join("\n");
  B.model_union = (a) => {
    const paths = Array.isArray(a.paths) ? a.paths : String(a.paths || "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    return [
      "local list={} for _,p in ipairs(HttpService:JSONDecode(" + jj(paths) + ")) do local i=resolve(p) if i and i:IsA('BasePart') then list[#list+1]=i end end",
      "if #list<2 then return fail('give at least two BaseParts to union') end",
      "local main=table.remove(list,1) local rec=wp() local okU,res=pcall(function() return main:UnionAsync(list,Enum.CollisionFidelity." + (String(a.fidelity || "Default").replace(/[^A-Za-z]/g, "") || "Default") + ") end)",
      "if not okU or not res then wpDone(rec) return fail('UnionAsync failed: '..tostring(res)) end",
      "res.Name=" + q(a.name || "Union") + " res.Parent=main.Parent res.Anchored=main.Anchored " + (bb(a.keep_sources, false) === "true" ? "" : "main:Destroy() for _,p in ipairs(list) do p:Destroy() end"),
      "wpDone(rec) return ok({path=res:GetFullName(),sources=#list+1},'union created from '..(#list+1)..' parts')",
    ].join("\n");
  };
  B.model_subtract = (a) => {
    const negs = Array.isArray(a.negatives) ? a.negatives : String(a.negatives || "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    return [
      "local main=need(" + q(a.path) + ",'part') if not main:IsA('BasePart') then return fail('path must be a BasePart') end",
      "local list={} for _,p in ipairs(HttpService:JSONDecode(" + jj(negs) + ")) do local i=resolve(p) if i and i:IsA('BasePart') then list[#list+1]=i end end",
      "if #list==0 then return fail('negatives must list at least one BasePart') end",
      "local rec=wp() local okU,res=pcall(function() return main:SubtractAsync(list,Enum.CollisionFidelity." + (String(a.fidelity || "Default").replace(/[^A-Za-z]/g, "") || "Default") + ") end)",
      "if not okU or not res then wpDone(rec) return fail('SubtractAsync failed: '..tostring(res)) end",
      "res.Name=" + q(a.name || "") + "~='' and " + q(a.name || "") + " or main.Name res.Parent=main.Parent res.Anchored=main.Anchored main:Destroy() " + (bb(a.keep_negatives, false) === "true" ? "" : "for _,p in ipairs(list) do p:Destroy() end"),
      "wpDone(rec) return ok({path=res:GetFullName(),negatives=#list},'subtracted '..#list..' part(s)')",
    ].join("\n");
  };
  B.model_rotate_about = (a) => [
    "local root=need(" + q(a.path) + ",'model') local deg=" + nn(a.degrees, 90) + " local ax=" + q(axis(a.axis || "y")),
    "local pivot=" + (a.pivot ? vec(a.pivot) : "(bbox(root)).Position"),
    "local rot=if ax=='x' then CFrame.Angles(math.rad(deg),0,0) elseif ax=='z' then CFrame.Angles(0,0,math.rad(deg)) else CFrame.Angles(0,math.rad(deg),0)",
    "local rec=wp() local n=0 if root:IsA('PVInstance') then local cf=root:GetPivot() root:PivotTo(CFrame.new(pivot)*rot*CFrame.new(-pivot)*cf) n=1 else for _,p in ipairs(allParts(root)) do p.CFrame=CFrame.new(pivot)*rot*CFrame.new(-pivot)*p.CFrame n+=1 end end wpDone(rec)",
    "return ok({path=root:GetFullName(),degrees=deg,axis=ax,pivot={pivot.X,pivot.Y,pivot.Z}},string.format('rotated %.1f deg about %s',deg,ax))",
  ].join("\n");
  B.model_export_spec = (a) => [
    "local root=need(" + q(a.path) + ",'model') local cap=" + nn(a.limit, 120) + " local relative=" + bb(a.relative, true),
    "local origin=if relative then root:IsA('PVInstance') and root:GetPivot().Position or (bbox(root)).Position else Vector3.new()",
    "local parts=allParts(root) local spec={} for i,p in ipairs(parts) do if i>cap then break end local pos=p.Position-origin local rx,ry,rz=p.CFrame:ToEulerAnglesXYZ() local c=p.Color local shape=p.ClassName if p:IsA('Part') then shape=p.Shape.Name end",
    "  spec[#spec+1]={name=p.Name,shape=shape,size={math.floor(p.Size.X*1000)/1000,math.floor(p.Size.Y*1000)/1000,math.floor(p.Size.Z*1000)/1000},position={math.floor(pos.X*1000)/1000,math.floor(pos.Y*1000)/1000,math.floor(pos.Z*1000)/1000},rotation={math.floor(math.deg(rx)*10)/10,math.floor(math.deg(ry)*10)/10,math.floor(math.deg(rz)*10)/10},color={math.floor(c.R*255+0.5),math.floor(c.G*255+0.5),math.floor(c.B*255+0.5)},material=p.Material.Name,anchored=p.Anchored,transparency=p.Transparency} end",
    "return ok({name=root.Name,origin={origin.X,origin.Y,origin.Z},total=#parts,exported=#spec,parts=spec},'exported '..#spec..' of '..#parts..' part(s) - feed `parts` back into model_build to rebuild it')",
  ].join("\n");

  // ───────────────────────── memory_* ─────────────────────────
  B.memory_read = (a) => MEM + "\n" + [
    "local m=memModule(" + bb(a.create, true) + ") if not m then return ok({exists=false,text=''},'no project memory yet') end",
    "local body=memBody(m) local want=" + q(a.section || "") + " if want~='' then local secs,order=memParse(body) local name=memFind(secs,order,want) if not name then return fail('section not found: '..want..' (have: '..table.concat(order,', ',2)..')') end local txt=table.concat(secs[name],'\\n') return ok({exists=true,section=name,text=txt,chars=#txt},txt) end",
    "local secs,order=memParse(body) local names={} for i=2,#order do names[#names+1]=order[i] end",
    "return ok({exists=true,path=m:GetFullName(),chars=#body,sections=names,text=body},body)",
  ].join("\n");
  B.memory_update_section = (a) => MEM + "\n" + [
    "local m=memModule(true) local body=memBody(m) local secs,order=memParse(body)",
    "local want,content=" + q(a.section || "") + "," + q(a.content ?? a.text ?? "") + " if want=='' then return fail('section required') end",
    "local name=memFind(secs,order,want) local created=false if not name then name=want secs[name]={} order[#order+1]=name created=true end",
    "secs[name]=lines(content) local n=memSave(m,memJoin(secs,order))",
    "return ok({section=name,chars=n,created=created},'memory section '..name..' updated ('..n..' chars total)')",
  ].join("\n");
  B.memory_add_fact = (a) => MEM + "\n" + [
    "local m=memModule(true) local body=memBody(m) local secs,order=memParse(body)",
    "local want,fact=" + q(a.section || "Decisions & gotchas") + "," + q(a.fact ?? a.text ?? "") + " fact=fact:gsub('^%s*[%-%*]%s*',''):gsub('%s+$','') if fact=='' then return fail('fact required') end",
    "local name=memFind(secs,order,want) if not name then name=want secs[name]={} order[#order+1]=name end",
    "for _,l in ipairs(secs[name]) do if l:gsub('^%s*[%-%*]%s*',''):lower()==fact:lower() then return ok({section=name,duplicate=true},'already recorded in '..name) end end",
    "table.insert(secs[name],'- '..fact) local n=memSave(m,memJoin(secs,order))",
    "return ok({section=name,chars=n,facts=#secs[name]},'fact added to '..name)",
  ].join("\n");
  B.memory_remove_fact = (a) => MEM + "\n" + [
    "local m=memModule(false) if not m then return fail('no project memory yet') end local body=memBody(m) local secs,order=memParse(body)",
    "local want,match=" + q(a.section || "") + "," + q(a.match ?? a.text ?? "") + " if match=='' then return fail('match text required') end local removed=0",
    "for _,name in ipairs(order) do if want=='' or name==memFind(secs,order,want) then local keep={} for _,l in ipairs(secs[name]) do if l:lower():find(match:lower(),1,true) then removed+=1 else keep[#keep+1]=l end end secs[name]=keep end end",
    "if removed==0 then return fail('no line matched: '..match) end local n=memSave(m,memJoin(secs,order))",
    "return ok({removed=removed,chars=n},'removed '..removed..' line(s)')",
  ].join("\n");
  B.memory_search = (a) => MEM + "\n" + [
    "local m=memModule(false) if not m then return ok({hits={}},'no project memory yet') end local body=memBody(m) local secs,order=memParse(body)",
    "local qv=(" + q(a.query || "") + "):lower() if qv=='' then return fail('query required') end local hits={}",
    "for _,name in ipairs(order) do for _,l in ipairs(secs[name]) do if l:lower():find(qv,1,true) then hits[#hits+1]={section=name,text=l} end end end",
    "return ok({query=qv,hits=hits},#hits..' line(s) match')",
  ].join("\n");

  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const C = [
    { name: "script_replace", description: "Safe find-and-replace inside ONE script's Source (plain text by default, Lua pattern with pattern=true). Refuses when nothing matches or when expected count differs - nothing is written on failure.", params: { path: S("string", true, "script path"), find: S("string", true, "exact text to find"), replace: S("string", true, "replacement text"), all: S("boolean", false, "replace every occurrence (default true)"), pattern: S("boolean", false, "treat find as a Lua pattern"), expected: S("number", false, "fail unless exactly this many matches") } },
    { name: "script_insert", description: "Insert lines into a script at a 1-based line, after/before the first line containing a marker, or at top/bottom. Never overwrites existing lines.", params: { path: S("string", true), text: S("string", true, "lines to insert"), line: S("number", false), after: S("string", false, "marker text; insert after that line"), before: S("string", false, "marker text; insert before that line"), position: S("string", false, "top | bottom") } },
    { name: "script_delete_lines", description: "Delete an inclusive 1-based line range from a script.", params: { path: S("string", true), start: S("number", true), end: S("number", true) } },
    { name: "script_outline", description: "Structural outline of a script: functions with line numbers, require() targets, signal connections, remote usage lines, services, TODO lines. Read this before editing a long script.", params: { path: S("string", true) } },
    { name: "script_find_usages", description: "Find every whole-word usage of a symbol across all scripts (optionally under root) with line previews.", params: { symbol: S("string", true), root: S("string", false, "limit to this container"), limit: S("number", false) } },
    { name: "script_rename_symbol", description: "Whole-word rename of an identifier across scripts (dry_run=true previews counts). Use after script_find_usages.", params: { old: S("string", true), new: S("string", true), root: S("string", false), dry_run: S("boolean", false) } },
    { name: "script_lint", description: "Heuristic Luau lint across a script or container: deprecated wait/spawn/delay/:connect, Instance.new(class,parent), suspected globals, stray prints, risky loops.", params: { path: S("string", false, "script or folder; default whole game"), limit: S("number", false) } },
    { name: "script_todo", description: "List TODO/FIXME/HACK comments across scripts with paths and line numbers.", params: { root: S("string", false), limit: S("number", false) } },
    { name: "script_requires", description: "Require graph: every require() edge, modules never required by name (orphans) and duplicate module names.", params: { root: S("string", false) } },
    { name: "script_backup", description: "Snapshot a script's Source into ServerStorage.RobloxScript.Backups (keeps the last N per script). Do this before large rewrites.", params: { path: S("string", true), keep: S("number", false, "default 10") } },
    { name: "script_restore", description: "Restore a script's Source from its latest (or a named) backup made by script_backup.", params: { path: S("string", true), backup: S("string", false, "backup name or part of it; default latest") } },
    { name: "script_backups_list", description: "List script backups (optionally filtered by original path).", params: { path: S("string", false) } },

    { name: "model_build", description: "Build a Model from a JSON parts spec in one call: [{name,size:[x,y,z],position:[x,y,z],rotation:[deg],color:[r,g,b]|'#hex'|BrickColor,material,shape:Block|Ball|Cylinder|Wedge|Corner|Truss,anchored,transparency,reflectance,cancollide,attributes}]. Sets PrimaryPart and a bottom-center pivot.", params: { name: S("string", true), parts: S("array", true, "array of part specs (positions are world or relative to `position`)"), parent: S("string", false, "default workspace"), primary: S("string", false, "name of the PrimaryPart"), position: S("array", false, "pivot the finished model here") } },
    { name: "model_report", description: "Deep report on a model: part/mesh/union counts, unanchored parts, scripts, mass, bounding size and center, material and class histograms, PrimaryPart.", params: { path: S("string", true) } },
    { name: "model_center_pivot", description: "Set a Model's pivot to its bounding-box bottom center (default) or exact center.", params: { path: S("string", true), bottom: S("boolean", false, "default true") } },
    { name: "model_snap_to_ground", description: "Raycast down and move the model so its bounding-box bottom rests on whatever is below.", params: { path: S("string", true), offset: S("number", false, "extra lift in studs"), max_distance: S("number", false), ignore_water: S("boolean", false) } },
    { name: "model_align", description: "Align several parts/models to the FIRST one on an axis (min | center | max edge).", params: { paths: S("array", true, "two or more instance paths"), axis: S("string", false, "x | y | z (default x)"), mode: S("string", false, "min | center | max (default center)") } },
    { name: "model_distribute", description: "Space parts/models evenly along an axis between the outermost two, or with a fixed gap between bounding boxes.", params: { paths: S("array", true), axis: S("string", false), gap: S("number", false, "fixed gap in studs; omit to spread evenly") } },
    { name: "model_array_radial", description: "Clone a part/model N times around a circle (pillars, seats, fence posts). Copies go into a new Model.", params: { path: S("string", true), count: S("number", true), radius: S("number", true), center: S("array", false, "default: source pivot"), face_center: S("boolean", false, "rotate copies to face the center (default true)"), start_angle: S("number", false), sweep: S("number", false, "degrees covered (default 360)"), name: S("string", false), parent: S("string", false), keep_source: S("boolean", false, "default true") } },
    { name: "model_wall", description: "Create an anchored wall segment between two ground points with height and thickness.", params: { from: S("array", true, "[x,y,z]"), to: S("array", true, "[x,y,z]"), height: S("number", false, "default 10"), thickness: S("number", false, "default 1"), material: S("string", false), color: S("string", false), name: S("string", false), parent: S("string", false) } },
    { name: "model_hollow_box", description: "Build a hollow room/shell (floor, ceiling, four walls) as a Model - the fastest way to block out interiors.", params: { position: S("array", true, "center [x,y,z]"), size: S("array", true, "[x,y,z] outer size"), thickness: S("number", false, "default 1"), open_top: S("boolean", false), open_bottom: S("boolean", false), material: S("string", false), color: S("string", false), name: S("string", false), parent: S("string", false) } },
    { name: "model_pipe", description: "Run cylinders (with ball joints) through a list of points - pipes, rails, cables, tree branches.", params: { points: S("array", true, "[[x,y,z],...] at least two"), radius: S("number", false, "default 0.5"), joints: S("boolean", false, "default true"), material: S("string", false), color: S("string", false), name: S("string", false), parent: S("string", false) } },
    { name: "model_paint", description: "Apply color / material / transparency / reflectance / cast_shadow to every part under a model (optionally one class only).", params: { path: S("string", true), color: S("string", false), material: S("string", false), transparency: S("number", false), reflectance: S("number", false), cast_shadow: S("boolean", false), only_class: S("string", false, "e.g. MeshPart") } },
    { name: "model_anchor_fix", description: "Anchor (or unanchor) every part under a model and optionally weld all parts to the PrimaryPart with WeldConstraints.", params: { path: S("string", true), anchored: S("boolean", false, "default true"), weld: S("boolean", false) } },
    { name: "model_optimize", description: "Performance pass on a model: disable CastShadow on tiny parts, smooth surfaces, optional MeshPart CollisionFidelity, remove empty containers and duplicate welds. dry_run previews counts.", params: { path: S("string", true), shadow_threshold: S("number", false, "volume below which shadows are disabled (default 0.75)"), mesh_fidelity: S("string", false, "Box | Hull | Default | PreciseConvexDecomposition"), dry_run: S("boolean", false) } },
    { name: "model_union", description: "CSG union of two or more BaseParts (UnionAsync). Sources are destroyed unless keep_sources=true.", params: { paths: S("array", true), name: S("string", false), fidelity: S("string", false), keep_sources: S("boolean", false) } },
    { name: "model_subtract", description: "CSG subtract: cut the negative parts out of a part (SubtractAsync) - doors, windows, holes.", params: { path: S("string", true, "the part to cut"), negatives: S("array", true, "parts to subtract"), name: S("string", false), fidelity: S("string", false), keep_negatives: S("boolean", false) } },
    { name: "model_rotate_about", description: "Rotate a part/model by degrees around an axis through a world pivot (default: its bounding-box center).", params: { path: S("string", true), degrees: S("number", true), axis: S("string", false, "x | y | z (default y)"), pivot: S("array", false, "[x,y,z]") } },
    { name: "model_export_spec", description: "Export a model as a JSON parts spec (relative to its pivot) - inspect it, tweak numbers, feed back into model_build.", params: { path: S("string", true), limit: S("number", false, "max parts (default 120)"), relative: S("boolean", false, "default true") } },

    { name: "memory_read", description: "Read the shared project memory handbook (game.ServerStorage.RobloxScript.Memory) or one section of it. Creates the skeleton if missing.", params: { section: S("string", false, "e.g. Conventions"), create: S("boolean", false, "default true") } },
    { name: "memory_update_section", description: "Replace the body of ONE memory section atomically (created if new). Other sections are preserved; document is kept under 14k chars.", params: { section: S("string", true), content: S("string", true, "new section body (markdown bullets)") } },
    { name: "memory_add_fact", description: "Append one verified fact as a bullet to a memory section (deduplicated). Default section: Decisions & gotchas.", params: { section: S("string", false), fact: S("string", true) } },
    { name: "memory_remove_fact", description: "Remove memory lines containing the match text (optionally within one section) - use when a recorded fact turned out stale.", params: { match: S("string", true), section: S("string", false) } },
    { name: "memory_search", description: "Search the project memory for a phrase and get matching lines with their sections.", params: { query: S("string", true) } },
  ];

  function buildUltimate(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      // Every body runs inside pcall so a runtime error (missing instance, bad
      // API) comes back as a clean fail() instead of a raw Luau stack trace.
      const body = fn(args || {});
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))"; return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + e };
    }
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = buildUltimate(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const have = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!have.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.ULTIMATE_COMMANDS = C.map((c) => c.name);
})();
