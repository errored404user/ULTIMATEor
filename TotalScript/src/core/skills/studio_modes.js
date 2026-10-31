// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript work-mode skill pack (1.22.0): additions for the three work modes,
// layered on RobloxScriptSkills exactly like studio_ultimate.js.
//
//   ULTIMATE   script_diff, script_format, script_deprecations_fix,
//              module_scaffold, remote_scaffold, datastore_profile_scaffold,
//              tag_scaffold, project_health_report
//   VISUALIZER lighting_time_lapse, lighting_snapshot, lighting_restore,
//              fx_dissolve, fx_shockwave, fx_light_rig, postfx_cinematic,
//              ui_progress_bar, ui_tooltip, ui_responsive_check
//   ANIMATOR   tween_sequence, camera_orbit_preview, camera_dolly,
//              animation_loop_set, animation_reverse, animation_retime,
//              animation_mirror, rig_joints_inspect, rig_pose_reset
//
// Convention: JS source uses double-quoted strings; Luau string literals use
// single quotes except values produced by q()/jj(). Never put a raw newline
// inside a Luau string - tests/test-luau-syntax.js enforces it.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  const nn = (v, d = 0) => { const x = Number(v); return isFinite(x) ? String(x) : String(d); };
  const bb = (v, d = false) => (v === undefined || v === null || v === "" ? (d ? "true" : "false") : (v === true || v === "true" || v === 1 || v === "1" || v === "yes") ? "true" : "false");
  const jj = (v) => { try { return q(JSON.stringify(v === undefined ? null : v)); } catch { return q("null"); } };
  const ident = (v, d) => { const s = String(v || d || "Thing").replace(/[^A-Za-z0-9_]/g, ""); return /^[A-Za-z_]/.test(s) ? s : "_" + s; };
  const NAMED = { red: [255, 60, 60], green: [60, 220, 110], blue: [60, 140, 255], gold: [255, 200, 60], yellow: [255, 230, 70], purple: [170, 90, 255], cyan: [70, 230, 255], pink: [255, 120, 200], orange: [255, 150, 50], white: [255, 255, 255], black: [15, 15, 15] };
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
  const easing = (v, d) => { const s = String(v || d || "Quad").replace(/[^A-Za-z]/g, ""); return /^(Linear|Sine|Back|Quad|Quart|Quint|Bounce|Elastic|Exponential|Circular|Cubic)$/i.test(s) ? "Enum.EasingStyle." + s[0].toUpperCase() + s.slice(1) : "Enum.EasingStyle.Quad"; };
  const edir = (v, d) => { const s = String(v || d || "Out"); return /^(In|Out|InOut)$/i.test(s) ? "Enum.EasingDirection." + s[0].toUpperCase() + s.slice(1).replace(/out/i, "Out") : "Enum.EasingDirection.Out"; };

  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local ServerStorage=game:GetService('ServerStorage')",
    "local ReplicatedStorage=game:GetService('ReplicatedStorage')",
    "local ServerScriptService=game:GetService('ServerScriptService')",
    "local Lighting=game:GetService('Lighting')",
    "local TweenService=game:GetService('TweenService')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end",
    "local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end local cur=game for seg in p:gmatch('[^%.]+') do local nxt=cur:FindFirstChild(seg) if not nxt then local okS,svc=pcall(function() return game:GetService(seg) end) if okS and svc and cur==game then nxt=svc end end if not nxt then return nil end cur=nxt end return cur end",
    "local function need(p,what) local i=resolve(p) if not i then error((what or 'instance')..' not found: '..tostring(p)) end return i end",
    "local function lines(src) local out={} for l in (src..'\\n'):gmatch('(.-)\\n') do out[#out+1]=l end if out[#out]=='' then out[#out]=nil end return out end",
    "local function isScript(i) return i:IsA('LuaSourceContainer') end",
    "local function scriptsUnder(root) local out={} if root and isScript(root) then out[1]=root end for _,d in ipairs((root or game):GetDescendants()) do if isScript(d) then out[#out+1]=d end end return out end",
    "local function wp() local okW,w=pcall(function() return ChangeHistoryService:TryBeginRecording('TotalScript') end) return okW and w or nil end",
    "local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end",
    "local function folder(parent,name) local f=parent:FindFirstChild(name) if not f then f=Instance.new('Folder') f.Name=name f.Parent=parent end return f end",
    "local function newScript(class,name,parent,src) local old=parent:FindFirstChild(name) if old and old:IsA('LuaSourceContainer') then return old,false end local s=Instance.new(class) s.Name=name s.Source=src s.Parent=parent return s,true end",
    "local function bboxOf(root) if root:IsA('BasePart') then return root.CFrame,root.Size end if root:IsA('Model') then local cf,sz=root:GetBoundingBox() return cf,sz end return CFrame.new(),Vector3.new(1,1,1) end",
    "local function findKS(name) local n=tostring(name or ''):lower() local best=nil for _,d in ipairs(game:GetDescendants()) do if d:IsA('KeyframeSequence') and (n=='' or d.Name:lower()==n) then if d:IsDescendantOf(ServerStorage) or not best then best=d end end end if not best and n~='' then for _,d in ipairs(game:GetDescendants()) do if d:IsA('KeyframeSequence') and d.Name:lower():find(n,1,true) then best=d break end end end return best end",
    "local function ksLength(ks) local len=0 for _,k in ipairs(ks:GetKeyframes()) do if k.Time>len then len=k.Time end end return len end",
  ].join("\n");

  const B = {};

  // ───────────────────────── ULTIMATE ─────────────────────────
  B.script_diff = (a) => [
    "local s=need(" + q(a.path) + ",'script') if not isScript(s) then return fail('not a script: '..s:GetFullName()) end",
    "local want=" + q(a.backup || "") + " local other=" + (a.other ? "resolve(" + q(a.other) + ")" : "nil"),
    "local src,label=nil,nil",
    "if other and isScript(other) then src=other.Source label=other:GetFullName() else",
    "  local root=ServerStorage:FindFirstChild('RobloxScript') local bk=root and root:FindFirstChild('Backups') if not bk then return fail('no backups folder - run script_backup first or pass other=<script path>') end",
    "  local key=s:GetFullName() local best=nil for _,b in ipairs(bk:GetChildren()) do if b:IsA('LuaSourceContainer') and (b:GetAttribute('Original')==key or b.Name:find(s.Name,1,true)) and (want=='' or b.Name:find(want,1,true)) then if not best or (b:GetAttribute('At') or 0)>(best:GetAttribute('At') or 0) then best=b end end end",
    "  if not best then return fail('no backup found for '..key) end src=best.Source label=best.Name end",
    "local A,Bl=lines(src),lines(s.Source) local n,m=#A,#Bl",
    "if n*m>600*600 then local first=nil for i=1,math.max(n,m) do if A[i]~=Bl[i] then first=i break end end return ok({against=label,old_lines=n,new_lines=m,first_difference=first},'too large for a full diff; first differing line '..tostring(first)) end",
    "local L={} for i=0,n do L[i]={} for j=0,m do L[i][j]=0 end end",
    "for i=n,1,-1 do for j=m,1,-1 do if A[i]==Bl[j] then L[i][j]=L[i+1][j+1]+1 else L[i][j]=math.max(L[i+1][j],L[i][j+1]) end end end",
    "local out,i,j,added,removed={},1,1,0,0 local maxOut=" + nn(a.limit, 160),
    "while i<=n or j<=m do if i<=n and j<=m and A[i]==Bl[j] then i+=1 j+=1 elseif j<=m and (i>n or L[i][j+1]>=L[i+1][j]) then if #out<maxOut then out[#out+1]='+'..j..' '..Bl[j] end added+=1 j+=1 else if #out<maxOut then out[#out+1]='-'..i..' '..A[i] end removed+=1 i+=1 end end",
    "return ok({against=label,added=added,removed=removed,old_lines=n,new_lines=m,diff=table.concat(out,'\\n')},'+'..added..' -'..removed..' lines vs '..label)",
  ].join("\n");

  B.script_format = (a) => [
    "local s=need(" + q(a.path) + ",'script') if not isScript(s) then return fail('not a script: '..s:GetFullName()) end",
    "local useTabs=" + bb(a.tabs, true) + " local width=" + nn(a.indent, 4) + " local dry=" + bb(a.dry_run, false),
    "local ls=lines(s.Source) local out,changed={},0 local unit=useTabs and '\\t' or string.rep(' ',width)",
    "for _,l in ipairs(ls) do local lead,rest=l:match('^([ \\t]*)(.-)%s*$') local cols=0 for ch in lead:gmatch('.') do if ch=='\\t' then cols+=width else cols+=1 end end local levels=math.floor(cols/width+0.5) local nl=string.rep(unit,levels)..rest if nl~=l then changed+=1 end out[#out+1]=nl end",
    "while #out>0 and out[#out]=='' do out[#out]=nil end",
    "local src=table.concat(out,'\\n')..'\\n'",
    "if not dry and changed>0 then local rec=wp() s.Source=src wpDone(rec) end",
    "return ok({path=s:GetFullName(),changed_lines=changed,lines=#out,dry_run=dry},(dry and 'would change ' or 'reformatted ')..changed..' line(s)')",
  ].join("\n");

  B.script_deprecations_fix = (a) => [
    "local root=" + (a.path ? "need(" + q(a.path) + ",'script or container')" : "game") + " local dry=" + bb(a.dry_run, false),
    "local rules={{'([^%w_%.:])wait%(','%1task.wait('},{'^wait%(','task.wait('},{'([^%w_%.:])spawn%(','%1task.spawn('},{'^spawn%(','task.spawn('},{'([^%w_%.:])delay%(','%1task.delay('},{'^delay%(','task.delay('},{':connect%(',':Connect('},{':disconnect%(',':Disconnect('},{':wait%(',':Wait('},{'%.findFirstChild%(','.FindFirstChild('},{':findFirstChild%(',':FindFirstChild('},{':getChildren%(',':GetChildren('},{':getService%(',':GetService('},{'%.ypcall%(','.pcall('}}",
    "local report={} local total=0",
    "for _,s in ipairs(scriptsUnder(root)) do local src=s.Source local count=0 for _,r in ipairs(rules) do local n src,n=src:gsub(r[1],r[2]) count+=n end",
    "  local bodyMoved=0 src,bodyMoved=src:gsub('game%.Workspace','workspace') count+=bodyMoved",
    "  if count>0 then total+=count report[#report+1]={path=s:GetFullName(),fixes=count} if not dry then local rec=wp() s.Source=src wpDone(rec) end end end",
    "return ok({dry_run=dry,scripts=#report,fixes=total,report=report},(dry and 'would apply ' or 'applied ')..total..' modernisation(s) in '..#report..' script(s)')",
  ].join("\n");

  B.module_scaffold = (a) => {
    const name = ident(a.name, "MyModule");
    const kind = String(a.kind || "module").toLowerCase();
    const methods = Array.isArray(a.methods) ? a.methods.map((m) => ident(m)) : [];
    const parentExpr = a.parent ? "need(" + q(a.parent) + ",'parent')" : (kind === "service" ? "ServerScriptService" : "ReplicatedStorage");
    const body = [];
    body.push("--!strict");
    body.push("-- " + name + " (" + kind + ") - generated by TotalScript module_scaffold; fill in the TODOs.");
    if (kind === "class") {
      body.push("local " + name + " = {}", name + ".__index = " + name, "", "export type " + name + " = typeof(setmetatable({} :: { _connections: { RBXScriptConnection } }, " + name + "))", "",
        "function " + name + ".new(): " + name, "\tlocal self = setmetatable({}, " + name + ")", "\tself._connections = {}", "\treturn self", "end", "");
      for (const m of methods) body.push("function " + name + ":" + m + "()", "\t-- TODO: implement " + m, "end", "");
      body.push("function " + name + ":Destroy()", "\tfor _, c in ipairs(self._connections) do", "\t\tc:Disconnect()", "\tend", "\ttable.clear(self._connections)", "end", "", "return " + name);
    } else if (kind === "service" || kind === "controller") {
      body.push("local Players = game:GetService(\"Players\")", "local RunService = game:GetService(\"RunService\")", "", "local " + name + " = {}", name + ".Name = \"" + name + "\"", "", "local started = false", "",
        "function " + name + ".Init()", "\t-- TODO: resolve dependencies here (no yielding)", "end", "",
        "function " + name + ".Start()", "\tif started then return end", "\tstarted = true", "\t-- TODO: connect signals, start loops", "end", "");
      for (const m of methods) body.push("function " + name + "." + m + "(...)", "\t-- TODO: implement " + m, "end", "");
      body.push("return " + name);
    } else {
      body.push("local " + name + " = {}", "");
      for (const m of methods) body.push("function " + name + "." + m + "(...)", "\t-- TODO: implement " + m, "end", "");
      if (!methods.length) body.push("function " + name + ".example(value: number): number", "\treturn value * 2", "end", "");
      body.push("return " + name);
    }
    return [
      "local parent=" + parentExpr,
      "local s,created=newScript('ModuleScript'," + q(name) + ",parent," + q(body.join("\n")) + ")",
      "if not created then return fail('a script named '..s.Name..' already exists at '..s:GetFullName()..' - pick another name or script_read it') end",
      "return ok({path=s:GetFullName(),kind=" + q(kind) + ",methods=" + jj(methods) + "},'created '..s:GetFullName())",
    ].join("\n");
  };

  B.remote_scaffold = (a) => {
    const name = ident(a.name, "MyRemote");
    const isFn = /function/i.test(String(a.kind || "event"));
    const cls = isFn ? "RemoteFunction" : "RemoteEvent";
    const rate = nn(a.rate_per_second, 10);
    const server = [
      "--!strict", "-- Server handler for " + name + " - generated by TotalScript remote_scaffold. Validate EVERYTHING the client sends.",
      "local Players = game:GetService(\"Players\")", "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")", "",
      "local remote = ReplicatedStorage:WaitForChild(\"Remotes\"):WaitForChild(\"" + name + "\") :: " + cls, "",
      "local RATE_PER_SECOND = " + rate, "local buckets: { [Player]: { count: number, at: number } } = {}", "",
      "local function allowed(player: Player): boolean", "\tlocal now = os.clock()", "\tlocal b = buckets[player]", "\tif not b or now - b.at >= 1 then", "\t\tbuckets[player] = { count = 1, at = now }", "\t\treturn true", "\tend", "\tb.count += 1", "\treturn b.count <= RATE_PER_SECOND", "end", "",
      "local function validate(payload: any): (boolean, string?)", "\tif typeof(payload) ~= \"table\" then", "\t\treturn false, \"payload must be a table\"", "\tend", "\t-- TODO: check every field (type, range, ownership)", "\treturn true", "end", "",
      isFn
        ? "remote.OnServerInvoke = function(player: Player, payload: any)\n\tif not allowed(player) then return { ok = false, error = \"rate limited\" } end\n\tlocal valid, why = validate(payload)\n\tif not valid then return { ok = false, error = why } end\n\t-- TODO: do the work on the server (authoritative)\n\treturn { ok = true }\nend"
        : "remote.OnServerEvent:Connect(function(player: Player, payload: any)\n\tif not allowed(player) then return end\n\tlocal valid, why = validate(payload)\n\tif not valid then\n\t\twarn((\"[%s] rejected %s: %s\"):format(script.Name, player.Name, tostring(why)))\n\t\treturn\n\tend\n\t-- TODO: do the work on the server (authoritative)\nend)",
      "", "Players.PlayerRemoving:Connect(function(player)", "\tbuckets[player] = nil", "end)",
    ].join("\n");
    const client = [
      "--!strict", "-- Client side for " + name + " - generated by TotalScript remote_scaffold. The client only ASKS; the server decides.",
      "local ReplicatedStorage = game:GetService(\"ReplicatedStorage\")", "",
      "local remote = ReplicatedStorage:WaitForChild(\"Remotes\"):WaitForChild(\"" + name + "\") :: " + cls, "",
      "local " + name + "Client = {}", "",
      isFn
        ? "function " + name + "Client.request(payload: { [string]: any })\n\tlocal ok, result = pcall(function()\n\t\treturn remote:InvokeServer(payload)\n\tend)\n\tif not ok then\n\t\twarn(\"" + name + " failed: \" .. tostring(result))\n\t\treturn nil\n\tend\n\treturn result\nend"
        : "function " + name + "Client.send(payload: { [string]: any })\n\tremote:FireServer(payload)\nend",
      "", "return " + name + "Client",
    ].join("\n");
    return [
      "local remotes=folder(ReplicatedStorage,'Remotes')",
      "local r=remotes:FindFirstChild(" + q(name) + ") if not r then r=Instance.new(" + q(cls) + ") r.Name=" + q(name) + " r.Parent=remotes end",
      "local srv=newScript('Script'," + q(name + "Handler") + "," + (a.server_parent ? "need(" + q(a.server_parent) + ",'server parent')" : "ServerScriptService") + "," + q(server) + ")",
      "local cli=newScript('ModuleScript'," + q(name + "Client") + ",ReplicatedStorage," + q(client) + ")",
      "return ok({remote=r:GetFullName(),server=srv:GetFullName(),client=cli:GetFullName(),class=r.ClassName},'remote '..r.Name..' with validated server handler and client module')",
    ].join("\n");
  };

  B.datastore_profile_scaffold = (a) => {
    const name = ident(a.name, "PlayerData");
    const store = String(a.store || name + "_v1").replace(/"/g, "");
    const template = a.template && typeof a.template === "object" ? a.template : { Coins: 0, Level: 1, Inventory: [] };
    const toLua = (v) => Array.isArray(v) ? "{" + v.map(toLua).join(", ") + "}" : v && typeof v === "object" ? "{ " + Object.entries(v).map(([k, x]) => (/^[A-Za-z_]\w*$/.test(k) ? k : "[\"" + k + "\"]") + " = " + toLua(x)).join(", ") + " }" : typeof v === "string" ? "\"" + v.replace(/"/g, "\\\"") + "\"" : String(v);
    const src = [
      "--!strict", "-- " + name + ": session-locked player profiles - generated by TotalScript datastore_profile_scaffold.",
      "local DataStoreService = game:GetService(\"DataStoreService\")", "local Players = game:GetService(\"Players\")", "local RunService = game:GetService(\"RunService\")", "",
      "local STORE_NAME = \"" + store + "\"", "local AUTOSAVE_SECONDS = " + nn(a.autosave_seconds, 120), "local RETRIES = 4", "",
      "export type Profile = { Coins: number, Level: number, Inventory: { any }, _version: number, _lock: string? }", "",
      "local TEMPLATE: { [string]: any } = " + toLua(template), "TEMPLATE._version = 1", "",
      "local store = DataStoreService:GetDataStore(STORE_NAME)", "local sessionId = game.JobId .. \"_\" .. tostring(os.time())", "local profiles: { [Player]: { [string]: any } } = {}", "", "local " + name + " = {}", "",
      "local function deepCopy(t: { [string]: any }): { [string]: any }", "\tlocal out = {}", "\tfor k, v in pairs(t) do", "\t\tout[k] = if typeof(v) == \"table\" then deepCopy(v) else v", "\tend", "\treturn out", "end", "",
      "local function reconcile(data: { [string]: any }): { [string]: any }", "\tfor k, v in pairs(TEMPLATE) do", "\t\tif data[k] == nil then", "\t\t\tdata[k] = if typeof(v) == \"table\" then deepCopy(v) else v", "\t\tend", "\tend", "\treturn data", "end", "",
      "local function withRetry(fn: () -> any): (boolean, any)", "\tlocal lastErr", "\tfor attempt = 1, RETRIES do", "\t\tlocal ok, res = pcall(fn)", "\t\tif ok then return true, res end", "\t\tlastErr = res", "\t\ttask.wait(0.5 * 2 ^ (attempt - 1))", "\tend", "\treturn false, lastErr", "end", "",
      "local function key(player: Player): string", "\treturn \"p_\" .. player.UserId", "end", "",
      "function " + name + ".Load(player: Player): { [string]: any }?", "\tlocal ok, data = withRetry(function()", "\t\treturn store:UpdateAsync(key(player), function(old)", "\t\t\told = old or deepCopy(TEMPLATE)", "\t\t\tif old._lock and old._lock ~= sessionId and (os.time() - (old._lockAt or 0)) < 300 then", "\t\t\t\treturn nil -- locked by another live server; abort the write", "\t\t\tend", "\t\t\told._lock = sessionId", "\t\t\told._lockAt = os.time()", "\t\t\treturn old", "\t\tend)", "\tend)", "\tif not ok or data == nil then", "\t\twarn((\"[%s] could not load %s: %s\"):format(script.Name, player.Name, tostring(data)))", "\t\tplayer:Kick(\"Your data is still saving from another server. Please rejoin in a moment.\")", "\t\treturn nil", "\tend", "\tprofiles[player] = reconcile(data)", "\treturn profiles[player]", "end", "",
      "function " + name + ".Get(player: Player): { [string]: any }?", "\treturn profiles[player]", "end", "",
      "function " + name + ".Save(player: Player, release: boolean?)", "\tlocal data = profiles[player]", "\tif not data then return end", "\tif release then", "\t\tdata._lock = nil", "\t\tdata._lockAt = nil", "\tend", "\tlocal ok, err = withRetry(function()", "\t\treturn store:UpdateAsync(key(player), function()", "\t\t\treturn data", "\t\tend)", "\tend)", "\tif not ok then", "\t\twarn((\"[%s] save failed for %s: %s\"):format(script.Name, player.Name, tostring(err)))", "\tend", "\tif release then profiles[player] = nil end", "end", "",
      "Players.PlayerAdded:Connect(function(player)", "\t" + name + ".Load(player)", "end)", "Players.PlayerRemoving:Connect(function(player)", "\t" + name + ".Save(player, true)", "end)", "",
      "task.spawn(function()", "\twhile true do", "\t\ttask.wait(AUTOSAVE_SECONDS)", "\t\tfor player in pairs(profiles) do", "\t\t\t" + name + ".Save(player, false)", "\t\tend", "\tend", "end)", "",
      "if not RunService:IsStudio() then", "\tgame:BindToClose(function()", "\t\tfor player in pairs(profiles) do", "\t\t\t" + name + ".Save(player, true)", "\t\tend", "\tend)", "end", "",
      "return " + name,
    ].join("\n");
    return [
      "local parent=" + (a.parent ? "need(" + q(a.parent) + ",'parent')" : "ServerScriptService"),
      "local s,created=newScript('ModuleScript'," + q(name) + ",parent," + q(src) + ")",
      "if not created then return fail('a script named '..s.Name..' already exists at '..s:GetFullName()) end",
      "return ok({path=s:GetFullName(),store=" + q(store) + ",template=" + jj(template) + "},'created session-locked profile module '..s:GetFullName())",
    ].join("\n");
  };

  B.tag_scaffold = (a) => {
    const tag = String(a.tag || "Interactive").replace(/[^A-Za-z0-9_]/g, "");
    const name = ident(a.name, tag + "Handler");
    const src = [
      "--!strict", "-- CollectionService handler for tag \"" + tag + "\" - generated by TotalScript tag_scaffold.",
      "local CollectionService = game:GetService(\"CollectionService\")", "", "local TAG = \"" + tag + "\"", "local bound: { [Instance]: { RBXScriptConnection } } = {}", "",
      "local function setup(inst: Instance)", "\tif bound[inst] then return end", "\tlocal connections = {}", "\tbound[inst] = connections", "\t-- TODO: behaviour for every " + tag + " instance", "\tif inst:IsA(\"BasePart\") then", "\t\ttable.insert(connections, inst.Touched:Connect(function(hit)", "\t\t\t-- TODO", "\t\tend))", "\tend", "end", "",
      "local function teardown(inst: Instance)", "\tlocal connections = bound[inst]", "\tif not connections then return end", "\tfor _, c in ipairs(connections) do", "\t\tc:Disconnect()", "\tend", "\tbound[inst] = nil", "end", "",
      "for _, inst in ipairs(CollectionService:GetTagged(TAG)) do", "\tsetup(inst)", "end", "CollectionService:GetInstanceAddedSignal(TAG):Connect(setup)", "CollectionService:GetInstanceRemovedSignal(TAG):Connect(teardown)",
    ].join("\n");
    return [
      "local parent=" + (a.parent ? "need(" + q(a.parent) + ",'parent')" : (bb(a.client, false) === "true" ? "game:GetService('StarterPlayer'):WaitForChild('StarterPlayerScripts')" : "ServerScriptService")),
      "local s,created=newScript(" + (bb(a.client, false) === "true" ? "'LocalScript'" : "'Script'") + "," + q(name) + ",parent," + q(src) + ")",
      "if not created then return fail('a script named '..s.Name..' already exists at '..s:GetFullName()) end",
      "local tagged=0 pcall(function() tagged=#game:GetService('CollectionService'):GetTagged(" + q(tag) + ") end)",
      "return ok({path=s:GetFullName(),tag=" + q(tag) + ",currently_tagged=tagged},'created '..s:GetFullName()..' for tag '..'" + tag + "')",
    ].join("\n");
  };

  B.project_health_report = (a) => [
    "local limit=" + nn(a.limit, 25) + " local r={scripts=0,modules=0,local_scripts=0,deprecated_calls=0,deprecated_scripts={},unanchored_parts=0,unanchored_examples={},models_without_primary=0,models_without_primary_examples={},remotes=0,remotes_without_handler={},strict_scripts=0,long_scripts={},free_floating_scripts={},empty_scripts={},tags={}}",
    "local depPat={'[^%w_%.:]wait%(','^wait%(','[^%w_%.:]spawn%(','^spawn%(','[^%w_%.:]delay%(','^delay%(',':connect%(',':wait%(','Instance%.new%([^,%)]+,'}",
    "local allSrc={}",
    "for _,s in ipairs(scriptsUnder(game)) do if s:IsA('ModuleScript') then r.modules+=1 elseif s:IsA('LocalScript') then r.local_scripts+=1 else r.scripts+=1 end local src=s.Source allSrc[#allSrc+1]=src",
    "  if src:match('^%s*%-%-!strict') then r.strict_scripts+=1 end",
    "  local n=0 for _,p in ipairs(depPat) do n+=select(2,src:gsub(p,'')) end if n>0 then r.deprecated_calls+=n if #r.deprecated_scripts<limit then r.deprecated_scripts[#r.deprecated_scripts+1]={path=s:GetFullName(),calls=n} end end",
    "  local lc=#lines(src) if lc>600 and #r.long_scripts<limit then r.long_scripts[#r.long_scripts+1]={path=s:GetFullName(),lines=lc} end",
    "  if src:match('^%s*$') and #r.empty_scripts<limit then r.empty_scripts[#r.empty_scripts+1]=s:GetFullName() end",
    "  if s:IsA('Script') and not s:IsA('ModuleScript') and s:IsDescendantOf(workspace) and #r.free_floating_scripts<limit then r.free_floating_scripts[#r.free_floating_scripts+1]=s:GetFullName() end end",
    "local joined=table.concat(allSrc,'\\n')",
    "for _,d in ipairs(workspace:GetDescendants()) do if d:IsA('BasePart') and not d.Anchored and not d:FindFirstAncestorOfClass('Model') then r.unanchored_parts+=1 if #r.unanchored_examples<limit then r.unanchored_examples[#r.unanchored_examples+1]=d:GetFullName() end elseif d:IsA('BasePart') and not d.Anchored then local m=d:FindFirstAncestorOfClass('Model') if not (m and m:FindFirstChildOfClass('Humanoid')) then r.unanchored_parts+=1 if #r.unanchored_examples<limit then r.unanchored_examples[#r.unanchored_examples+1]=d:GetFullName() end end end",
    "  if d:IsA('Model') and not d.PrimaryPart and not d:FindFirstChildOfClass('Humanoid') and d:FindFirstChildWhichIsA('BasePart',true) then r.models_without_primary+=1 if #r.models_without_primary_examples<limit then r.models_without_primary_examples[#r.models_without_primary_examples+1]=d:GetFullName() end end end",
    "for _,d in ipairs(ReplicatedStorage:GetDescendants()) do if d:IsA('RemoteEvent') or d:IsA('RemoteFunction') then r.remotes+=1 if not joined:find(d.Name,1,true) and #r.remotes_without_handler<limit then r.remotes_without_handler[#r.remotes_without_handler+1]=d:GetFullName() end end end",
    "pcall(function() for _,t in ipairs(game:GetService('CollectionService'):GetAllTags()) do r.tags[#r.tags+1]={tag=t,count=#game:GetService('CollectionService'):GetTagged(t)} end end)",
    "local score=100 score-=math.min(30,r.deprecated_calls) score-=math.min(20,r.unanchored_parts) score-=math.min(15,r.models_without_primary*3) score-=math.min(15,#r.remotes_without_handler*5) score-=math.min(10,#r.free_floating_scripts*2) r.score=math.max(0,score)",
    "return ok(r,'health score '..r.score..'/100: '..r.deprecated_calls..' deprecated call(s), '..r.unanchored_parts..' unanchored part(s), '..r.models_without_primary..' model(s) without PrimaryPart, '..#r.remotes_without_handler..' remote(s) without a handler')",
  ].join("\n");

  // ───────────────────────── VISUALIZER ─────────────────────────
  B.lighting_time_lapse = (a) => [
    "local from,to,dur=" + nn(a.from, 6) + "," + nn(a.to, 18) + "," + nn(a.duration, 6),
    "local keep=" + bb(a.keep_end, true) + " local start=Lighting.ClockTime",
    "task.spawn(function() local t0=os.clock() while true do local k=math.min(1,(os.clock()-t0)/math.max(0.1,dur)) Lighting.ClockTime=from+(to-from)*k if k>=1 then break end task.wait() end if not keep then Lighting.ClockTime=start end end)",
    "return ok({from=from,to=to,duration=dur,restores=not keep},'sweeping ClockTime '..from..' -> '..to..' over '..dur..'s (watch the viewport, then total_screenshot)')",
  ].join("\n");

  const LIGHT_PROPS = "{'Ambient','Brightness','ColorShift_Bottom','ColorShift_Top','EnvironmentDiffuseScale','EnvironmentSpecularScale','GlobalShadows','OutdoorAmbient','ShadowSoftness','ClockTime','GeographicLatitude','ExposureCompensation','FogColor','FogEnd','FogStart','Technology'}";
  B.lighting_snapshot = (a) => [
    "local name=" + q(a.name || "default") + " local root=folder(folder(ServerStorage,'RobloxScript'),'LightingSnapshots')",
    "local old=root:FindFirstChild(name) if old then old:Destroy() end",
    "local snap=Instance.new('Folder') snap.Name=name snap.Parent=root local props={}",
    "for _,p in ipairs(" + LIGHT_PROPS + ") do local okP,v=pcall(function() return Lighting[p] end) if okP then if typeof(v)=='EnumItem' then v=v.Name end if typeof(v)=='Color3' then props[p]={v.R*255,v.G*255,v.B*255} else props[p]=v end end end",
    "snap:SetAttribute('Props',HttpService:JSONEncode(props)) snap:SetAttribute('At',os.time())",
    "local n=0 for _,c in ipairs(Lighting:GetChildren()) do if c:IsA('PostEffect') or c:IsA('Atmosphere') or c:IsA('Sky') or c:IsA('Clouds') then local cl=c:Clone() cl.Parent=snap n+=1 end end",
    "return ok({name=name,path=snap:GetFullName(),effects=n},'saved lighting snapshot '..name..' ('..n..' effect(s))')",
  ].join("\n");
  B.lighting_restore = (a) => [
    "local name=" + q(a.name || "default") + " local root=ServerStorage:FindFirstChild('RobloxScript') root=root and root:FindFirstChild('LightingSnapshots') local snap=root and root:FindFirstChild(name)",
    "if not snap then local names={} if root then for _,c in ipairs(root:GetChildren()) do names[#names+1]=c.Name end end return fail('no lighting snapshot named '..name..(#names>0 and ' (have: '..table.concat(names,', ')..')' or ' - run lighting_snapshot first')) end",
    "local rec=wp() local props=HttpService:JSONDecode(snap:GetAttribute('Props') or '{}')",
    "for p,v in pairs(props) do pcall(function() if p=='Technology' then Lighting.Technology=Enum.Technology[v] elseif typeof(v)=='table' then Lighting[p]=Color3.fromRGB(v[1],v[2],v[3]) else Lighting[p]=v end end) end",
    "for _,c in ipairs(Lighting:GetChildren()) do if c:IsA('PostEffect') or c:IsA('Atmosphere') or c:IsA('Sky') or c:IsA('Clouds') then c:Destroy() end end",
    "local n=0 for _,c in ipairs(snap:GetChildren()) do local cl=c:Clone() cl.Parent=Lighting n+=1 end wpDone(rec)",
    "return ok({name=name,effects=n},'restored lighting snapshot '..name)",
  ].join("\n");

  B.fx_dissolve = (a) => [
    "local root=need(" + q(a.path) + ",'instance') local dur=" + nn(a.duration, 1.2) + " local destroy=" + bb(a.destroy, false) + " local col=" + cc(a.color, [120, 200, 255]),
    "local parts={} if root:IsA('BasePart') then parts[1]=root end for _,d in ipairs(root:GetDescendants()) do if d:IsA('BasePart') then parts[#parts+1]=d end end",
    "if #parts==0 then return fail('no BaseParts under '..root:GetFullName()) end",
    "local info=TweenInfo.new(dur,Enum.EasingStyle.Quad,Enum.EasingDirection.In)",
    "for _,p in ipairs(parts) do local att=Instance.new('Attachment') att.Name='Total_Dissolve' att.Parent=p local e=Instance.new('ParticleEmitter') e.Name='Dissolve' e.Color=ColorSequence.new(col) e.LightEmission=0.8 e.Size=NumberSequence.new({NumberSequenceKeypoint.new(0,0.35),NumberSequenceKeypoint.new(1,0)}) e.Transparency=NumberSequence.new({NumberSequenceKeypoint.new(0,0.2),NumberSequenceKeypoint.new(1,1)}) e.Lifetime=NumberRange.new(0.6,1.1) e.Speed=NumberRange.new(1,3) e.Rate=math.clamp(p.Size.Magnitude*12,20,200) e.SpreadAngle=Vector2.new(180,180) e.Parent=att TweenService:Create(p,info,{Transparency=1}):Play() task.delay(dur,function() e.Enabled=false task.delay(1.2,function() att:Destroy() end) if destroy then p:Destroy() end end) end",
    "return ok({path=root:GetFullName(),parts=#parts,duration=dur,destroy=destroy},'dissolving '..#parts..' part(s) over '..dur..'s')",
  ].join("\n");

  B.fx_shockwave = (a) => [
    "local pos=" + vec(a.position, [0, 1, 0]) + " local radius=" + nn(a.radius, 24) + " local dur=" + nn(a.duration, 0.6) + " local col=" + cc(a.color, [255, 200, 90]) + " local thick=" + nn(a.thickness, 0.6),
    "local ring=Instance.new('Part') ring.Name='Total_Shockwave' ring.Shape=Enum.PartType.Cylinder ring.Anchored=true ring.CanCollide=false ring.CanQuery=false ring.CastShadow=false ring.Material=Enum.Material.Neon ring.Color=col ring.Size=Vector3.new(0.2,1,1) ring.CFrame=CFrame.new(pos)*CFrame.Angles(0,0,math.rad(90)) ring.Parent=workspace",
    "local mesh=Instance.new('SpecialMesh') mesh.MeshType=Enum.MeshType.FileMesh mesh.MeshId='rbxassetid://3270017' mesh.Scale=Vector3.new(0.1,0.1,0.1) mesh.Parent=ring",
    "local light=Instance.new('PointLight') light.Color=col light.Brightness=4 light.Range=radius/2 light.Parent=ring",
    "local info=TweenInfo.new(dur,Enum.EasingStyle.Quart,Enum.EasingDirection.Out)",
    "TweenService:Create(mesh,info,{Scale=Vector3.new(radius,radius,thick)}):Play() TweenService:Create(ring,info,{Transparency=1}):Play() TweenService:Create(light,info,{Brightness=0}):Play()",
    "task.delay(dur+0.05,function() ring:Destroy() end)",
    "return ok({position={pos.X,pos.Y,pos.Z},radius=radius,duration=dur},'shockwave fired at '..tostring(pos))",
  ].join("\n");

  B.fx_light_rig = (a) => [
    "local target=need(" + q(a.target || a.path) + ",'target') local cf,sz=bboxOf(target) local r=math.max(sz.X,sz.Y,sz.Z)*" + nn(a.distance_scale, 1.6) + " local keyC=" + cc(a.key_color, [255, 244, 224]) + " local fillC=" + cc(a.fill_color, [180, 200, 255]) + " local rimC=" + cc(a.rim_color, [255, 255, 255]) + " local intensity=" + nn(a.intensity, 1),
    "local old=workspace:FindFirstChild('Total_LightRig_'..target.Name) if old then old:Destroy() end",
    "local rig=Instance.new('Model') rig.Name='Total_LightRig_'..target.Name rig.Parent=workspace",
    "local function lamp(name,offset,color,bright,range,angle) local p=Instance.new('Part') p.Name=name p.Size=Vector3.new(0.5,0.5,0.5) p.Anchored=true p.CanCollide=false p.CanQuery=false p.Transparency=1 p.CFrame=CFrame.new(cf.Position+offset,cf.Position) p.Parent=rig local l=Instance.new('SpotLight') l.Color=color l.Brightness=bright*intensity l.Range=range l.Angle=angle l.Shadows=true l.Face=Enum.NormalId.Front l.Parent=p return p end",
    "lamp('Key',Vector3.new(r*0.8,r*0.9,r*0.8),keyC,3,r*3,70) lamp('Fill',Vector3.new(-r*0.9,r*0.4,r*0.6),fillC,1.2,r*3,90) lamp('Rim',Vector3.new(-r*0.2,r*0.8,-r),rimC,2.2,r*3,60)",
    "return ok({rig=rig:GetFullName(),target=target:GetFullName(),radius=r},'3-point light rig (key/fill/rim) around '..target.Name..' - total_screenshot to judge, delete the rig model when done')",
  ].join("\n");

  B.postfx_cinematic = (a) => {
    const preset = String(a.preset || "filmic").toLowerCase();
    return [
      "local preset=" + q(preset) + " local strength=" + nn(a.strength, 1),
      "local P={filmic={bloom={0.6,24,0.9},cc={0.08,0.12,-0.05,{255,248,236}},dof={0.25,12,0.05},sun={0.12,10}},noir={bloom={0.3,12,1.2},cc={0.15,0.35,-1,{235,235,245}},dof={0.4,10,0.05},sun={0,0}},dreamy={bloom={1.1,40,0.6},cc={0.05,-0.1,0.1,{255,228,244}},dof={0.55,8,0.05},sun={0.25,14}},vivid={bloom={0.5,18,1.1},cc={0.05,0.2,0.35,{255,255,255}},dof={0,0,0},sun={0.1,8}},horror={bloom={0.2,10,1.3},cc={-0.1,0.3,-0.55,{200,215,235}},dof={0.5,6,0.05},sun={0,0}},clean={bloom={0,0,1},cc={0,0,0,{255,255,255}},dof={0,0,0},sun={0,0}}}",
      "local cfg=P[preset] if not cfg then local names={} for k in pairs(P) do names[#names+1]=k end return fail('unknown preset '..preset..' (use '..table.concat(names,', ')..')') end",
      "local rec=wp() for _,c in ipairs(Lighting:GetChildren()) do if c:IsA('BloomEffect') or c:IsA('ColorCorrectionEffect') or c:IsA('DepthOfFieldEffect') or c:IsA('SunRaysEffect') then if c.Name:sub(1,6)=='Total_' or c.Name:sub(1,3)=='OR_' then c:Destroy() else c.Enabled=false end end end",
      "local b=Instance.new('BloomEffect') b.Name='Total_Bloom' b.Intensity=cfg.bloom[1]*strength b.Size=cfg.bloom[2] b.Threshold=cfg.bloom[3] b.Parent=Lighting",
      "local c=Instance.new('ColorCorrectionEffect') c.Name='Total_Color' c.Brightness=cfg.cc[1]*strength c.Contrast=cfg.cc[2]*strength c.Saturation=cfg.cc[3]*strength c.TintColor=Color3.fromRGB(cfg.cc[4][1],cfg.cc[4][2],cfg.cc[4][3]) c.Parent=Lighting",
      "if cfg.dof[1]>0 then local d=Instance.new('DepthOfFieldEffect') d.Name='Total_DoF' d.FarIntensity=cfg.dof[1]*strength d.FocusDistance=cfg.dof[2] d.InFocusRadius=math.max(10,cfg.dof[2]*2) d.NearIntensity=cfg.dof[3] d.Parent=Lighting end",
      "if cfg.sun[1]>0 then local s=Instance.new('SunRaysEffect') s.Name='Total_Sun' s.Intensity=cfg.sun[1]*strength s.Spread=cfg.sun[2]/10 s.Parent=Lighting end",
      "wpDone(rec) return ok({preset=preset,strength=strength},'post-FX preset '..preset..' applied (Total_* effects in Lighting; previous effects disabled, not deleted)')",
    ].join("\n");
  };

  B.ui_progress_bar = (a) => [
    "local screenName=" + q(a.screen || "HUD") + " local name=" + q(a.name || "ProgressBar") + " local value=math.clamp(" + nn(a.value, 0.65) + ",0,1) local fillC=" + cc(a.color, [90, 200, 120]) + " local backC=" + cc(a.background, [20, 22, 28]) + " local label=" + q(a.label || "") + " local w,h=" + nn(a.width, 320) + "," + nn(a.height, 22),
    "local sg=game:GetService('StarterGui') local screen=sg:FindFirstChild(screenName) if not screen then screen=Instance.new('ScreenGui') screen.Name=screenName screen.ResetOnSpawn=false screen.Parent=sg end",
    "local old=screen:FindFirstChild(name) if old then old:Destroy() end",
    "local back=Instance.new('Frame') back.Name=name back.Size=UDim2.new(0,w,0,h) back.Position=" + (a.position ? "UDim2.new(" + nn((a.position || [])[0], 0.5) + ",0," + nn((a.position || [])[1], 0.9) + ",0)" : "UDim2.new(0.5,0,0.9,0)") + " back.AnchorPoint=Vector2.new(0.5,0.5) back.BackgroundColor3=backC back.BorderSizePixel=0 back.Parent=screen",
    "local corner=Instance.new('UICorner') corner.CornerRadius=UDim.new(0,math.floor(h/2)) corner.Parent=back local stroke=Instance.new('UIStroke') stroke.Color=Color3.fromRGB(255,255,255) stroke.Transparency=0.85 stroke.Thickness=1 stroke.Parent=back",
    "local fill=Instance.new('Frame') fill.Name='Fill' fill.Size=UDim2.new(value,0,1,0) fill.BackgroundColor3=fillC fill.BorderSizePixel=0 fill.Parent=back local fc=Instance.new('UICorner') fc.CornerRadius=UDim.new(0,math.floor(h/2)) fc.Parent=fill",
    "local grad=Instance.new('UIGradient') grad.Color=ColorSequence.new({ColorSequenceKeypoint.new(0,fillC),ColorSequenceKeypoint.new(1,fillC:Lerp(Color3.new(1,1,1),0.25))}) grad.Parent=fill",
    "local tl=Instance.new('TextLabel') tl.Name='Label' tl.BackgroundTransparency=1 tl.Size=UDim2.new(1,0,1,0) tl.Font=Enum.Font.GothamBold tl.TextSize=math.max(10,math.floor(h*0.6)) tl.TextColor3=Color3.fromRGB(255,255,255) tl.TextStrokeTransparency=0.6 tl.Text=(label~='' and label..'  ' or '')..math.floor(value*100+0.5)..'%' tl.Parent=back",
    "back:SetAttribute('Value',value)",
    "local ctl=Instance.new('LocalScript') ctl.Name='Bind' ctl.Source='local bar=script.Parent local fill=bar:WaitForChild(\"Fill\") local label=bar:WaitForChild(\"Label\") local TweenService=game:GetService(\"TweenService\") local function apply(v) v=math.clamp(tonumber(v) or 0,0,1) TweenService:Create(fill,TweenInfo.new(0.25,Enum.EasingStyle.Quad,Enum.EasingDirection.Out),{Size=UDim2.new(v,0,1,0)}):Play() local t=label.Text:match(\"^(.-)%d+%%$\") or \"\" label.Text=t..math.floor(v*100+0.5)..\"%\" end bar:GetAttributeChangedSignal(\"Value\"):Connect(function() apply(bar:GetAttribute(\"Value\")) end) apply(bar:GetAttribute(\"Value\"))' ctl.Parent=back",
    "return ok({path=back:GetFullName(),value=value},'progress bar '..name..' created - drive it by setting the Value attribute (0..1)')",
  ].join("\n");

  B.ui_tooltip = (a) => [
    "local target=need(" + q(a.path) + ",'GuiObject') if not target:IsA('GuiObject') then return fail('ui_tooltip needs a GuiObject (button, frame, label)') end",
    "local text=" + q(a.text || "Tooltip") + " local delay=" + nn(a.delay, 0.35),
    "local old=target:FindFirstChild('Total_Tooltip') if old then old:Destroy() end",
    "local ls=Instance.new('LocalScript') ls.Name='Total_Tooltip' ls:SetAttribute('Text',text) ls:SetAttribute('Delay',delay)",
    "ls.Source='local host=script.Parent local TEXT=script:GetAttribute(\"Text\") or \"\" local DELAY=script:GetAttribute(\"Delay\") or 0.35 local TweenService=game:GetService(\"TweenService\") local gui=host:FindFirstAncestorWhichIsA(\"LayerCollector\") local tip=Instance.new(\"TextLabel\") tip.Name=\"Tooltip\" tip.AutomaticSize=Enum.AutomaticSize.XY tip.Size=UDim2.new(0,0,0,0) tip.AnchorPoint=Vector2.new(0.5,1) tip.BackgroundColor3=Color3.fromRGB(18,20,26) tip.TextColor3=Color3.fromRGB(240,240,245) tip.Font=Enum.Font.Gotham tip.TextSize=14 tip.Text=TEXT tip.Visible=false tip.ZIndex=1000 tip.BackgroundTransparency=1 tip.TextTransparency=1 tip.Parent=gui local pad=Instance.new(\"UIPadding\") pad.PaddingLeft=UDim.new(0,10) pad.PaddingRight=UDim.new(0,10) pad.PaddingTop=UDim.new(0,6) pad.PaddingBottom=UDim.new(0,6) pad.Parent=tip local corner=Instance.new(\"UICorner\") corner.CornerRadius=UDim.new(0,6) corner.Parent=tip local token=0 local function show() token+=1 local my=token task.delay(DELAY,function() if my~=token then return end local p=host.AbsolutePosition local s=host.AbsoluteSize tip.Position=UDim2.new(0,p.X+s.X/2,0,p.Y-6) tip.Visible=true TweenService:Create(tip,TweenInfo.new(0.15),{BackgroundTransparency=0.08,TextTransparency=0}):Play() end) end local function hide() token+=1 TweenService:Create(tip,TweenInfo.new(0.12),{BackgroundTransparency=1,TextTransparency=1}):Play() task.delay(0.13,function() if tip.TextTransparency>=0.99 then tip.Visible=false end end) end host.MouseEnter:Connect(show) host.MouseLeave:Connect(hide) host.Destroying:Connect(function() tip:Destroy() end)'",
    "ls.Parent=target",
    "return ok({path=target:GetFullName(),text=text},'tooltip attached to '..target.Name)",
  ].join("\n");

  B.ui_responsive_check = (a) => [
    "local sg=game:GetService('StarterGui') local root=" + (a.screen ? "need(" + q(a.screen) + ",'ScreenGui')" : "sg") + " local limit=" + nn(a.limit, 40),
    "local r={screens=0,objects=0,offset_only_size=0,offset_only_examples={},no_anchor_center=0,text_not_scaled=0,text_not_scaled_examples={},tiny_text=0,missing_constraints={},overlapping_layouts=0,notes={}}",
    "local function isOffsetOnly(u) return u.X.Scale==0 and u.Y.Scale==0 and (u.X.Offset>0 or u.Y.Offset>0) end",
    "for _,d in ipairs(root:GetDescendants()) do if d:IsA('ScreenGui') then r.screens+=1 if not d.IgnoreGuiInset then r.notes[#r.notes+1]=d.Name..': IgnoreGuiInset=false (36px top inset will shift your layout)' end end",
    "  if d:IsA('GuiObject') then r.objects+=1",
    "    if isOffsetOnly(d.Size) and d.AutomaticSize==Enum.AutomaticSize.None and not d:FindFirstChildOfClass('UIListLayout') then r.offset_only_size+=1 if #r.offset_only_examples<limit then r.offset_only_examples[#r.offset_only_examples+1]=d:GetFullName()..' '..tostring(d.Size) end end",
    "    if d:IsA('TextLabel') or d:IsA('TextButton') or d:IsA('TextBox') then if not d.TextScaled and d.AutomaticSize==Enum.AutomaticSize.None and (d.Size.X.Scale>0 or d.Size.Y.Scale>0) and not d:FindFirstChildOfClass('UITextSizeConstraint') then r.text_not_scaled+=1 if #r.text_not_scaled_examples<limit then r.text_not_scaled_examples[#r.text_not_scaled_examples+1]=d:GetFullName() end end if d.TextSize<11 and not d.TextScaled then r.tiny_text+=1 end if d.TextScaled and not d:FindFirstChildOfClass('UITextSizeConstraint') and #r.missing_constraints<limit then r.missing_constraints[#r.missing_constraints+1]=d:GetFullName()..' (TextScaled without UITextSizeConstraint)' end end",
    "    if d.Size.X.Scale>0 and d.Size.Y.Scale>0 and not d:FindFirstChildOfClass('UIAspectRatioConstraint') and (d:IsA('ImageLabel') or d:IsA('ImageButton')) and #r.missing_constraints<limit then r.missing_constraints[#r.missing_constraints+1]=d:GetFullName()..' (scaled image without UIAspectRatioConstraint)' end",
    "    local layouts=0 for _,c in ipairs(d:GetChildren()) do if c:IsA('UIGridStyleLayout') then layouts+=1 end end if layouts>1 then r.overlapping_layouts+=1 end end end",
    "local score=100-math.min(40,r.offset_only_size*2)-math.min(25,r.text_not_scaled*2)-math.min(10,r.tiny_text*2)-math.min(15,#r.missing_constraints)-r.overlapping_layouts*5 r.score=math.max(0,score)",
    "return ok(r,'responsive score '..r.score..'/100 across '..r.objects..' GuiObjects: '..r.offset_only_size..' offset-only sizes, '..r.text_not_scaled..' unscaled texts, '..#r.missing_constraints..' missing constraint(s)')",
  ].join("\n");

  // ───────────────────────── ANIMATOR ─────────────────────────
  B.tween_sequence = (a) => {
    const steps = Array.isArray(a.steps) ? a.steps : [];
    return [
      "local target=need(" + q(a.path) + ",'instance') local steps=HttpService:JSONDecode(" + jj(steps) + ") local loop=" + bb(a.loop, false) + " local yoyo=" + bb(a.reverse, false),
      "if #steps==0 then return fail('steps must be a non-empty array of {props:{Prop=value}, time?, style?, direction?, delay?}') end",
      "local function val(v) if typeof(v)=='table' then if v.x then return Vector3.new(v.x,v.y,v.z) end if #v==3 then return Vector3.new(v[1],v[2],v[3]) end if #v==4 then return UDim2.new(v[1],v[2],v[3],v[4]) end if v.r then return Color3.fromRGB(v.r,v.g,v.b) end end return v end",
      "local function props(step) local out={} for k,v in pairs(step.props or step.properties or {}) do local cur=target[k] local nv=val(v) if typeof(cur)=='CFrame' and typeof(nv)=='Vector3' then nv=CFrame.new(nv) end if typeof(cur)=='Color3' and typeof(nv)=='Vector3' then nv=Color3.fromRGB(nv.X,nv.Y,nv.Z) end out[k]=nv end return out end",
      "local tweens={} for i,step in ipairs(steps) do local st=Enum.EasingStyle[step.style or 'Quad'] or Enum.EasingStyle.Quad local dir=Enum.EasingDirection[step.direction or 'Out'] or Enum.EasingDirection.Out tweens[i]=TweenService:Create(target,TweenInfo.new(tonumber(step.time) or 0.5,st,dir,0,false,tonumber(step.delay) or 0),props(step)) end",
      "task.spawn(function() repeat for i=1,#tweens do tweens[i]:Play() tweens[i].Completed:Wait() end if yoyo then for i=#tweens,1,-1 do tweens[i]:Play() tweens[i].Completed:Wait() end end until not loop end)",
      "local total=0 for _,s in ipairs(steps) do total+=(tonumber(s.time) or 0.5)+(tonumber(s.delay) or 0) end",
      "return ok({path=target:GetFullName(),steps=#steps,total_seconds=total,loop=loop},'playing '..#steps..' tween step(s) on '..target.Name..' ('..total..'s)')",
    ].join("\n");
  };

  B.camera_orbit_preview = (a) => [
    "local target=need(" + q(a.target || a.path) + ",'target') local cf,sz=bboxOf(target) local radius=" + (a.radius ? nn(a.radius) : "math.max(sz.X,sz.Y,sz.Z)*1.8") + " local height=" + (a.height ? nn(a.height) : "sz.Y*0.6") + " local dur=" + nn(a.duration, 6) + " local turns=" + nn(a.turns, 1),
    "local cam=workspace.CurrentCamera if not cam then return fail('no camera') end local startCF=cam.CFrame cam.CameraType=Enum.CameraType.Scriptable",
    "task.spawn(function() local t0=os.clock() while true do local k=math.min(1,(os.clock()-t0)/math.max(0.1,dur)) local ang=k*turns*math.pi*2 local pos=cf.Position+Vector3.new(math.cos(ang)*radius,height,math.sin(ang)*radius) cam.CFrame=CFrame.lookAt(pos,cf.Position) if k>=1 then break end task.wait() end if " + bb(a.restore, false) + " then cam.CFrame=startCF end cam.CameraType=Enum.CameraType.Fixed end)",
    "return ok({target=target:GetFullName(),radius=radius,height=height,duration=dur},'orbiting the Studio camera around '..target.Name..' for '..dur..'s - total_screenshot mid-way to review')",
  ].join("\n");

  B.camera_dolly = (a) => [
    "local from=" + vec(a.from, [0, 10, 20]) + " local to=" + vec(a.to, [0, 6, 8]) + " local dur=" + nn(a.duration, 3) + " local look=" + (a.look_at ? "(function() local i=resolve(" + q(a.look_at) + ") if i then local c=bboxOf(i) return c.Position end return " + vec(a.look_at, [0, 0, 0]) + " end)()" : "nil") + " local st=" + easing(a.style, "Sine") + " local dir=" + edir(a.direction, "InOut"),
    "local cam=workspace.CurrentCamera if not cam then return fail('no camera') end cam.CameraType=Enum.CameraType.Scriptable",
    "task.spawn(function() local t0=os.clock() while true do local k=math.min(1,(os.clock()-t0)/math.max(0.05,dur)) local e=TweenService:GetValue(k,st,dir) local pos=from:Lerp(to,e) cam.CFrame=look and CFrame.lookAt(pos,look) or CFrame.new(pos)*(cam.CFrame-cam.CFrame.Position) if k>=1 then break end task.wait() end cam.CameraType=Enum.CameraType.Fixed end)",
    "return ok({from={from.X,from.Y,from.Z},to={to.X,to.Y,to.Z},duration=dur},'camera dolly '..dur..'s')",
  ].join("\n");

  B.animation_loop_set = (a) => [
    "local ks=findKS(" + q(a.name || "") + ") if not ks then return fail('no KeyframeSequence named '..tostring(" + q(a.name || "") + ")..' - animation_create / animation_open first or query_animations') end",
    "local rec=wp() " + (a.looped === undefined || a.looped === null ? "" : "ks.Loop=" + bb(a.looped, true) + " ") + (a.priority ? "pcall(function() ks.Priority=Enum.AnimationPriority[" + q(String(a.priority)) + "] end) " : "") + "wpDone(rec)",
    "return ok({path=ks:GetFullName(),loop=ks.Loop,priority=ks.Priority.Name,length=ksLength(ks)},ks.Name..': loop='..tostring(ks.Loop)..', priority='..ks.Priority.Name)",
  ].join("\n");

  B.animation_reverse = (a) => [
    "local ks=findKS(" + q(a.name || "") + ") if not ks then return fail('no KeyframeSequence named '..tostring(" + q(a.name || "") + ")) end",
    "local len=ksLength(ks) local rec=wp() local n=0 for _,k in ipairs(ks:GetKeyframes()) do k.Time=len-k.Time n+=1 end wpDone(rec)",
    "return ok({path=ks:GetFullName(),keyframes=n,length=len},'reversed '..n..' keyframe(s) of '..ks.Name..' - animation_preview to check')",
  ].join("\n");

  B.animation_retime = (a) => [
    "local ks=findKS(" + q(a.name || "") + ") if not ks then return fail('no KeyframeSequence named '..tostring(" + q(a.name || "") + ")) end",
    "local len=ksLength(ks) if len<=0 then return fail('animation has no duration') end local factor=" + (a.length ? "(" + nn(a.length) + ")/len" : "1/math.max(0.01," + nn(a.speed, 1) + ")"),
    "local rec=wp() local n=0 for _,k in ipairs(ks:GetKeyframes()) do k.Time=k.Time*factor n+=1 end wpDone(rec)",
    "return ok({path=ks:GetFullName(),keyframes=n,old_length=len,new_length=len*factor},ks.Name..' retimed '..string.format('%.2f',len)..'s -> '..string.format('%.2f',len*factor)..'s')",
  ].join("\n");

  B.animation_mirror = (a) => [
    "local ks=findKS(" + q(a.name || "") + ") if not ks then return fail('no KeyframeSequence named '..tostring(" + q(a.name || "") + ")) end",
    "local copyName=" + q(a.copy_name || "") + " if copyName~='' then local cl=ks:Clone() cl.Name=copyName cl.Parent=ks.Parent ks=cl end",
    "local function swapName(n) if n:find('Left',1,true) then return (n:gsub('Left','Right')) elseif n:find('Right',1,true) then return (n:gsub('Right','Left')) end return n end",
    "local function mirrorCF(cf) local x,y,z,r00,r01,r02,r10,r11,r12,r20,r21,r22=cf:GetComponents() return CFrame.new(-x,y,z,r00,-r01,-r02,-r10,r11,r12,-r20,r21,r22) end",
    "local rec=wp() local poses=0 for _,k in ipairs(ks:GetKeyframes()) do for _,p in ipairs(k:GetDescendants()) do if p:IsA('Pose') then p.Name=swapName(p.Name) p.CFrame=mirrorCF(p.CFrame) poses+=1 end end end wpDone(rec)",
    "return ok({path=ks:GetFullName(),poses=poses,copied=copyName~=''},'mirrored '..poses..' pose(s) left<->right in '..ks.Name..' - animation_preview to verify the rig convention')",
  ].join("\n");

  B.rig_joints_inspect = (a) => [
    "local rig=need(" + q(a.rig || a.path) + ",'rig') local out={} local n=0",
    "for _,d in ipairs(rig:GetDescendants()) do if d:IsA('Motor6D') or d:IsA('AnimationConstraint') then n+=1 if n<=" + nn(a.limit, 80) + " then local p0=d:IsA('Motor6D') and d.Part0 or d.Attachment0 and d.Attachment0.Parent local p1=d:IsA('Motor6D') and d.Part1 or d.Attachment1 and d.Attachment1.Parent local tr=d:IsA('Motor6D') and d.Transform or CFrame.new() local rx,ry,rz=tr:ToEulerAnglesYXZ() out[#out+1]={name=d.Name,class=d.ClassName,part0=p0 and p0.Name or nil,part1=p1 and p1.Name or nil,parent=d.Parent and d.Parent.Name or nil,transform_deg={math.deg(rx),math.deg(ry),math.deg(rz)}} end end end",
    "local hum=rig:FindFirstChildOfClass('Humanoid') local anim=rig:FindFirstChildWhichIsA('Animator',true)",
    "return ok({rig=rig:GetFullName(),rig_type=hum and hum.RigType.Name or 'none',joints=n,animator=anim~=nil,list=out},rig.Name..': '..n..' joint(s), rig type '..(hum and hum.RigType.Name or 'none'))",
  ].join("\n");

  B.rig_pose_reset = (a) => [
    "local rig=need(" + q(a.rig || a.path) + ",'rig') local rec=wp() local n=0",
    "for _,d in ipairs(rig:GetDescendants()) do if d:IsA('Motor6D') then d.Transform=CFrame.new() n+=1 end end",
    "local hum=rig:FindFirstChildOfClass('Humanoid') if hum then local animator=hum:FindFirstChildOfClass('Animator') if animator then for _,t in ipairs(animator:GetPlayingAnimationTracks()) do t:Stop(0) end end end wpDone(rec)",
    "return ok({rig=rig:GetFullName(),joints_reset=n},'reset '..n..' Motor6D transform(s) on '..rig.Name)",
  ].join("\n");

  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const C = [
    // ULTIMATE
    { name: "script_diff", description: "Line diff of a script against its latest script_backup (or against another script with other=). Shows +added / -removed lines so you can review a rewrite before trusting it.", params: { path: S("string", true), backup: S("string", false, "backup name or part of it (default latest)"), other: S("string", false, "compare with this script instead of a backup"), limit: S("number", false, "max diff lines (default 160)") } },
    { name: "script_format", description: "Normalise indentation (tabs by default, or spaces with tabs=false) and strip trailing whitespace in a script. dry_run previews the count.", params: { path: S("string", true), tabs: S("boolean", false, "default true"), indent: S("number", false, "columns per level (default 4)"), dry_run: S("boolean", false) } },
    { name: "script_deprecations_fix", description: "Modernise deprecated API usage across a script or container: wait/spawn/delay -> task.*, :connect/:wait -> :Connect/:Wait, lowercase findFirstChild/getChildren/getService, game.Workspace -> workspace. dry_run previews counts.", params: { path: S("string", false, "script or container (default whole game)"), dry_run: S("boolean", false) } },
    { name: "module_scaffold", description: "Create a typed --!strict ModuleScript skeleton: kind=module (plain table), class (new/Destroy with connection cleanup), service or controller (Init/Start lifecycle). methods become stub functions.", params: { name: S("string", true), kind: S("string", false, "module | class | service | controller"), parent: S("string", false, "default ReplicatedStorage (services: ServerScriptService)"), methods: S("array", false, "method names") } },
    { name: "remote_scaffold", description: "Create a RemoteEvent/RemoteFunction in ReplicatedStorage.Remotes PLUS a validated, rate-limited server handler Script and a client ModuleScript - the full contract for one remote.", params: { name: S("string", true), kind: S("string", false, "event | function"), rate_per_second: S("number", false, "per-player rate limit (default 10)"), server_parent: S("string", false, "default ServerScriptService") } },
    { name: "datastore_profile_scaffold", description: "Create a session-locked player profile ModuleScript: template reconcile, UpdateAsync with retry/backoff, autosave loop, PlayerRemoving + BindToClose flush. template is the default data table.", params: { name: S("string", false, "module name (default PlayerData)"), store: S("string", false, "DataStore name (default <name>_v1)"), template: S("object", false, "default profile fields"), autosave_seconds: S("number", false, "default 120"), parent: S("string", false, "default ServerScriptService") } },
    { name: "tag_scaffold", description: "Create a CollectionService handler script for a tag (setup/teardown per tagged instance, connections cleaned up). client=true makes a LocalScript in StarterPlayerScripts.", params: { tag: S("string", true), name: S("string", false, "script name (default <Tag>Handler)"), client: S("boolean", false), parent: S("string", false) } },
    { name: "project_health_report", description: "One-call audit of the whole place: deprecated API calls per script, --!strict coverage, unanchored parts, Models without PrimaryPart, remotes with no handler, scripts loose in Workspace, overlong/empty scripts, CollectionService tags, and a 0-100 health score. Run before and after big work.", params: { limit: S("number", false, "examples per category (default 25)") } },
    // VISUALIZER
    { name: "lighting_time_lapse", description: "Sweep Lighting.ClockTime from one hour to another over a duration to judge the scene across the day (keep_end=false restores the original time).", params: { from: S("number", false, "start hour (default 6)"), to: S("number", false, "end hour (default 18)"), duration: S("number", false, "seconds (default 6)"), keep_end: S("boolean", false, "default true") } },
    { name: "lighting_snapshot", description: "Save every Lighting property plus Atmosphere/Sky/Clouds/PostEffects under a name (ServerStorage.RobloxScript.LightingSnapshots) so you can experiment and go back.", params: { name: S("string", false, "default 'default'") } },
    { name: "lighting_restore", description: "Restore a lighting snapshot made with lighting_snapshot (properties and effects).", params: { name: S("string", false, "default 'default'") } },
    { name: "fx_dissolve", description: "Dissolve a part or model: transparency tween plus edge particles per part; destroy=true removes it at the end. Great for despawns, teleports, deaths.", params: { path: S("string", true), duration: S("number", false, "seconds (default 1.2)"), color: S("string", false, "particle colour"), destroy: S("boolean", false) } },
    { name: "fx_shockwave", description: "Expanding neon ring + light flash at a position (impact, landing, ability). Self-cleaning.", params: { position: S("array", true, "[x,y,z]"), radius: S("number", false, "final radius (default 24)"), duration: S("number", false, "default 0.6"), color: S("string", false), thickness: S("number", false) } },
    { name: "fx_light_rig", description: "Photography-style 3-point light rig (key / fill / rim SpotLights) around a model for hero shots and screenshots. Creates Workspace.Total_LightRig_<name>; delete it when done.", params: { target: S("string", true), intensity: S("number", false, "multiplier (default 1)"), distance_scale: S("number", false, "default 1.6"), key_color: S("string", false), fill_color: S("string", false), rim_color: S("string", false) } },
    { name: "postfx_cinematic", description: "Apply a complete post-processing look in one call: filmic | noir | dreamy | vivid | horror | clean (Bloom + ColorCorrection + DepthOfField + SunRays as Total_* effects; existing effects are disabled, not deleted).", params: { preset: S("string", false, "default filmic"), strength: S("number", false, "0.5-1.5 (default 1)") } },
    { name: "ui_progress_bar", description: "Build a polished progress/health/XP bar (rounded track, gradient fill, label) in a ScreenGui, driven by its Value attribute (0..1) through a bundled LocalScript.", params: { screen: S("string", false, "ScreenGui name (default HUD)"), name: S("string", false), value: S("number", false, "0..1"), color: S("string", false), background: S("string", false), label: S("string", false), width: S("number", false), height: S("number", false), position: S("array", false, "[xScale, yScale]") } },
    { name: "ui_tooltip", description: "Attach a hover tooltip (fade in/out, positioned above the element) to any GuiObject via a small LocalScript.", params: { path: S("string", true, "GuiObject path"), text: S("string", true), delay: S("number", false, "hover delay seconds (default 0.35)") } },
    { name: "ui_responsive_check", description: "Audit StarterGui (or one ScreenGui) for layouts that break on other screens: offset-only sizes, unscaled text, tiny text, scaled images without aspect constraints, TextScaled without size constraints, duplicate layouts, IgnoreGuiInset. Returns a 0-100 score with examples.", params: { screen: S("string", false, "ScreenGui path (default all StarterGui)"), limit: S("number", false, "examples per category") } },
    // ANIMATOR
    { name: "tween_sequence", description: "Play a chain of tweens on one instance: steps=[{props:{Position:[x,y,z]|Size|Transparency|Color:{r,g,b}...}, time?, style?, direction?, delay?}], optional loop and reverse (yoyo). Previews in Studio.", params: { path: S("string", true), steps: S("array", true, "ordered tween steps"), loop: S("boolean", false), reverse: S("boolean", false, "play back in reverse after the last step") } },
    { name: "camera_orbit_preview", description: "Orbit the Studio camera around a model/part for a few seconds (turntable) - take total_screenshot mid-way to review silhouettes from every side.", params: { target: S("string", true), radius: S("number", false, "default from the bounding box"), height: S("number", false), duration: S("number", false, "default 6"), turns: S("number", false, "default 1"), restore: S("boolean", false, "return camera to its start") } },
    { name: "camera_dolly", description: "Move the Studio camera from one point to another with easing, optionally keeping a target in frame - cinematic preview of a camera beat.", params: { from: S("array", true, "[x,y,z]"), to: S("array", true, "[x,y,z]"), duration: S("number", false, "default 3"), look_at: S("string", false, "instance path or [x,y,z]"), style: S("string", false, "EasingStyle (default Sine)"), direction: S("string", false, "EasingDirection (default InOut)") } },
    { name: "animation_loop_set", description: "Set Loop and/or Priority (Idle|Movement|Action|Action2|Action3|Action4|Core) on an existing KeyframeSequence by name.", params: { name: S("string", true), looped: S("boolean", false), priority: S("string", false) } },
    { name: "animation_reverse", description: "Reverse a KeyframeSequence in time (t -> length - t) - turn a draw into a sheathe, a stand-up into a sit-down.", params: { name: S("string", true) } },
    { name: "animation_retime", description: "Change the speed or total length of a KeyframeSequence by scaling every keyframe time (speed=2 halves the length; or pass length in seconds).", params: { name: S("string", true), speed: S("number", false, "multiplier"), length: S("number", false, "new total length in seconds") } },
    { name: "animation_mirror", description: "Mirror a KeyframeSequence left<->right (swaps Left*/Right* poses and reflects every pose CFrame). copy_name mirrors into a new clip instead of editing in place.", params: { name: S("string", true), copy_name: S("string", false) } },
    { name: "rig_joints_inspect", description: "List every Motor6D / AnimationConstraint on a rig with Part0/Part1 and the current Transform in degrees - the joint names you need for animation_set_pose.", params: { rig: S("string", true), limit: S("number", false, "default 80") } },
    { name: "rig_pose_reset", description: "Reset every Motor6D.Transform on a rig to identity and stop playing tracks - clean slate before keying a new pose.", params: { rig: S("string", true) } },
  ];

  function buildModes(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))"; return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + e };
    }
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = buildModes(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const have = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!have.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.MODE_COMMANDS = C.map((c) => c.name);
})();
