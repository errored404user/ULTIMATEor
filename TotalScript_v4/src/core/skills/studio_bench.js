// TotalScript — Benchmark pack (1.99.6)
//
// quality_audit scores how a place LOOKS (palette, materials, lighting, UI
// polish) and project_health_report counts hygiene (deprecated calls, strict
// coverage, anchoring, PrimaryParts). Neither answers the questions a reviewer
// asks when two builds of the same request are put side by side: is it
// exploitable, will it hold 40 players, does it survive a server crash, do the
// buttons do anything. This pack is that scorecard - the same checks every
// time, deterministic numbers, a stored history so a before / after delta is
// one call:
//
//   bench_targets   the rubric itself (categories, every check, its weight and
//                   the exact fix command) - JS only, no Studio round-trip. Read
//                   it BEFORE building so the work is done to the benchmark.
//   bench_run       score the place (or one path) 0-100 across SECURITY /
//                   PERFORMANCE / ROBUSTNESS / ARCHITECTURE / UI WIRING with
//                   findings + fix commands, and append the run to
//                   ServerStorage._TotalBench so the next run reports the delta.
//   bench_history   the stored runs (overall + per-category) and the trend.
//
// Every check is a heuristic over instance trees and script Source text - it
// never executes game code and never edits anything (bench_run is read-only
// apart from the _TotalBench StringValue it appends to).
(() => {
  if (typeof RobloxScriptSkills === "undefined") return;
  const BENCH_VERSION = "1.99.6";
  const PASS_SCORE = 85;

  const q = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "").replace(/\n/g, "\\n") + "'";
  const jj = (o) => q(JSON.stringify(o));
  const nn = (v, d) => (isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);

  // ───────────────────────── rubric ─────────────────────────
  // weight = points taken off the category (0-100) when the check fails at
  // full severity; several checks scale with the number of offenders up to
  // that cap. Category weights sum to 100 for the overall score.
  const CATEGORIES = [
    { id: "security", weight: 30, title: "Security", summary: "Nothing the client sends is trusted; no backdoors, secrets or server APIs on the client." },
    { id: "performance", weight: 25, title: "Performance", summary: "No busy loops, per-frame tree scans, debounce-less Touched spam, hot emitters or shadow-casting light farms." },
    { id: "robustness", weight: 20, title: "Robustness", summary: "Saves survive crashes (pcall + BindToClose + PlayerRemoving), connections are cleaned up, nothing is left as a stub." },
    { id: "architecture", weight: 15, title: "Architecture", summary: "Modules over monoliths, no _G, named remotes, no runtime require-by-id." },
    { id: "ui_wiring", weight: 10, title: "UI wiring", summary: "Every button is referenced by a LocalScript, text scales, roots are not offset-only." },
  ];
  const CHECKS = [
    // security
    { id: "remote_unhandled", cat: "security", weight: 10, per: 4, severity: "high", title: "RemoteEvent / RemoteFunction with no server handler", detail: "no Script's Source mentions the remote's name next to OnServerEvent / OnServerInvoke", fix: "remote_handler {name} or script_create the real handler in ServerScriptService" },
    { id: "remote_unvalidated", cat: "security", weight: 12, per: 4, severity: "high", title: "Server handler that never validates its arguments", detail: "OnServerEvent / OnServerInvoke body without typeof / type / math.clamp / assert / a cooldown", fix: "script_set_source: start every handler with typeof checks, math.clamp on numbers and a per-player cooldown table" },
    { id: "client_damage_trusted", cat: "security", weight: 10, per: 2, severity: "high", title: "Server applies a client-supplied damage / amount", detail: "OnServerEvent handler that calls TakeDamage / changes Health or currency without clamping or looking the value up server-side", fix: "script_set_source: look the weapon / price up in a server table, never take the number from the remote" },
    { id: "datastore_on_client", cat: "security", weight: 10, per: 1, severity: "high", title: "DataStoreService used from a LocalScript", detail: "DataStores only exist on the server - this silently fails and tells exploiters the key names", fix: "move the save code to a Script in ServerScriptService (datastore_setup / profile_setup) and talk to it through a RemoteEvent" },
    { id: "require_by_id", cat: "security", weight: 25, per: 1, severity: "high", title: "require(<asset id>) at runtime", detail: "a numeric require pulls code you did not write at run time - the classic backdoor", fix: "script_set_source: paste the module into ReplicatedStorage / ServerStorage and require the instance" },
    { id: "loadstring_used", cat: "security", weight: 15, per: 1, severity: "high", title: "loadstring / getfenv / setfenv", detail: "needs LoadStringEnabled and executes text as code", fix: "script_set_source: replace with explicit functions or a command table" },
    { id: "secret_in_script", cat: "security", weight: 20, per: 1, severity: "high", title: "API key / bearer token inside a script", detail: "token-shaped literal next to key / secret / Bearer", fix: "move the secret to HttpService:GetSecret (Secrets Store) and rotate the leaked key" },
    { id: "http_no_pcall", cat: "security", weight: 4, per: 2, severity: "medium", title: "HttpService call without pcall", detail: "RequestAsync / GetAsync / PostAsync outside pcall - one outage errors the whole script", fix: "script_set_source: wrap in pcall and handle the failure branch" },
    // performance
    { id: "busy_loop", cat: "performance", weight: 10, per: 3, severity: "high", title: "while true do ... wait() loop", detail: "legacy wait() throttles to 30 Hz and the loop never ends - use task.wait() with a real exit, or an event", fix: "script_deprecations_fix {path} then script_set_source: replace the loop with RunService.Heartbeat or a bounded task.wait loop" },
    { id: "per_frame_scan", cat: "performance", weight: 12, per: 2, severity: "high", title: "GetDescendants / GetChildren inside a RenderStepped / Heartbeat / Stepped handler", detail: "walks the tree every frame", fix: "script_set_source: cache the list once (CollectionService tags via tag_scaffold) and only react to ChildAdded / DescendantAdded" },
    { id: "touched_no_debounce", cat: "performance", weight: 8, per: 4, severity: "medium", title: "Touched handler without a debounce", detail: ".Touched:Connect with no debounce / cooldown / tick / os.clock / table of recent hits", fix: "script_set_source: add a per-player debounce table with a 0.5-1 s cooldown" },
    { id: "particles_hot", cat: "performance", weight: 8, per: 1, severity: "medium", title: "ParticleEmitter budget exceeded", detail: "one emitter above 500 particles/s or the place above 2500 particles/s in total", fix: "set_property Rate 10-120 per emitter (fx_create_emitter defaults are within budget), shorter Lifetime, Enabled=false until needed" },
    { id: "shadow_lights", cat: "performance", weight: 6, per: 1, severity: "medium", title: "Too many shadow-casting lights", detail: "more than 24 Point/Spot/Surface lights with Shadows=true", fix: "set_property Shadows=false on fill lights, keep shadows for 4-8 key lights" },
    { id: "script_per_part", cat: "performance", weight: 8, per: 1, severity: "medium", title: "One script per part", detail: "more than 30 Scripts parented to BaseParts - each one is its own thread and copy of the logic", fix: "one Script in ServerScriptService that iterates CollectionService:GetTagged(tag) (tag_scaffold), delete the per-part copies" },
    { id: "part_budget", cat: "performance", weight: 10, per: 1, severity: "medium", title: "Part count over budget", detail: "more than 20000 BaseParts in scope (8000 is already heavy for mobile)", fix: "model_optimize {path} and union / MeshPart the repeated trims, cull hidden faces, StreamingEnabled" },
    { id: "unions_heavy", cat: "performance", weight: 6, per: 1, severity: "low", title: "Many UnionOperations", detail: "more than 200 unions - CSG geometry is expensive to load and collide", fix: "replace repeated unions with MeshParts (blender_export_fbx + mesh_import_verify) or plain parts (model_optimize first)" },
    { id: "decals_heavy", cat: "performance", weight: 4, per: 1, severity: "low", title: "Decal / Texture count very high", detail: "more than 1500 Decals + Textures", fix: "material_set / SurfaceAppearance on MeshParts instead of per-face decals" },
    // robustness
    { id: "datastore_no_pcall", cat: "robustness", weight: 25, per: 3, severity: "high", title: "DataStore call without pcall", detail: "GetAsync / SetAsync / UpdateAsync / IncrementAsync / RemoveAsync outside a pcall", fix: "datastore_setup / profile_setup, or script_set_source wrapping every call in pcall with retry" },
    { id: "no_bind_to_close", cat: "robustness", weight: 20, per: 1, severity: "high", title: "Writes to DataStores but no game:BindToClose", detail: "server shutdown loses the last session's data", fix: "datastore_setup / profile_setup (both register BindToClose), or script_set_source adding game:BindToClose(saveAll)" },
    { id: "no_save_on_leave", cat: "robustness", weight: 15, per: 1, severity: "high", title: "Writes to DataStores but never on PlayerRemoving", detail: "no Players.PlayerRemoving handler in any script that saves", fix: "datastore_setup / profile_setup, or script_set_source: save in Players.PlayerRemoving" },
    { id: "no_connection_cleanup", cat: "robustness", weight: 10, per: 1, severity: "medium", title: "Many connections, no cleanup", detail: "more than 15 :Connect( across scripts and not one :Disconnect( / Maid / Janitor / Trove / Destroying hook", fix: "module_scaffold a Maid / Janitor style cleanup helper and disconnect in Destroying / CharacterRemoving" },
    { id: "stub_scripts", cat: "robustness", weight: 12, per: 3, severity: "medium", title: "Placeholder scripts", detail: "Source shorter than 20 characters or still containing -- TODO", fix: "write the real logic with script_set_source, or instance_destroy the placeholder" },
    { id: "debug_prints", cat: "robustness", weight: 6, per: 1, severity: "low", title: "print spam in server scripts", detail: "more than 12 print( calls across server scripts", fix: "script_lint then script_set_source: keep warn / error, remove the prints" },
    { id: "disabled_scripts", cat: "robustness", weight: 4, per: 1, severity: "low", title: "Disabled scripts left in the place", detail: "Scripts with Enabled=false (Disabled=true) that will never run", fix: "instance_destroy them or set_property Enabled=true if they are meant to run" },
    // architecture
    { id: "globals_used", cat: "architecture", weight: 15, per: 3, severity: "medium", title: "_G / shared globals", detail: "_G. or shared. used as a module system", fix: "module_scaffold + require(ReplicatedStorage.Modules.X) instead of _G" },
    { id: "monolith", cat: "architecture", weight: 15, per: 1, severity: "medium", title: "No ModuleScripts", detail: "6+ scripts and fewer than 1 in 5 is a ModuleScript", fix: "module_scaffold shared systems (Config, Remotes, Util) and require them" },
    { id: "default_remote_names", cat: "architecture", weight: 10, per: 2, severity: "medium", title: "Remotes still named RemoteEvent / RemoteFunction", detail: "scripts cannot target them without ambiguity", fix: "instance_rename to Verb+Noun names (BuyItem, RequestSpawn), remote_scaffold for new ones" },
    { id: "server_api_on_client", cat: "architecture", weight: 10, per: 2, severity: "medium", title: "LocalPlayer in a server Script / server-only service in a LocalScript", detail: "Players.LocalPlayer is nil on the server; ServerStorage / ServerScriptService are invisible on the client", fix: "script_set_source: split the logic, pass the player from the remote argument" },
    { id: "script_misplaced", cat: "architecture", weight: 10, per: 3, severity: "medium", title: "Script in a container where it never runs", detail: "LocalScript under ServerScriptService / ServerStorage, or Script under StarterPlayerScripts / StarterGui / ReplicatedFirst", fix: "instance_move to ServerScriptService (Script) or StarterPlayerScripts (LocalScript)" },
    { id: "long_script", cat: "architecture", weight: 8, per: 2, severity: "low", title: "Overlong scripts", detail: "more than 700 lines in one script", fix: "module_scaffold the independent parts and require them" },
    // ui wiring
    { id: "dead_buttons", cat: "ui_wiring", weight: 40, per: 4, severity: "high", title: "Buttons no LocalScript references", detail: "TextButton / ImageButton whose Name appears in no LocalScript / ModuleScript Source and that carries no script of its own", fix: "ui_bind_button {path, action} or script_create a LocalScript that connects Activated for each button" },
    { id: "text_not_scaled", cat: "ui_wiring", weight: 30, per: 6, severity: "medium", title: "Text objects with a fixed TextSize", detail: "TextScaled=false and no UITextSizeConstraint", fix: "ui_responsive_fix {path} (TextScaled + UITextSizeConstraint everywhere)" },
    { id: "offset_only_root", cat: "ui_wiring", weight: 30, per: 3, severity: "medium", title: "Root frames sized in Offset only", detail: "direct child of a ScreenGui with Size Scale 0 on both axes and no UIScale / UIAspectRatioConstraint", fix: "ui_responsive_fix {path} or ui_screen_generate the screen from the standard" },
  ];
  const CHECK_BY_ID = Object.fromEntries(CHECKS.map((c) => [c.id, c]));

  function targetsLocal(a) {
    const want = String((a && (a.category || a.suite)) || "all").toLowerCase();
    const cats = CATEGORIES.filter((c) => want === "all" || c.id === want || c.id.startsWith(want));
    if (!cats.length) return { ok: false, error: "unknown category '" + want + "' - pass one of " + CATEGORIES.map((c) => c.id).join(", ") + " or all" };
    const data = {
      version: BENCH_VERSION, pass_score: PASS_SCORE,
      grades: { S: 95, A: 85, B: 70, C: 50, D: 0 },
      categories: cats.map((c) => ({ id: c.id, weight: c.weight, title: c.title, summary: c.summary, checks: CHECKS.filter((k) => k.cat === c.id).map((k) => ({ id: k.id, weight: k.weight, severity: k.severity, title: k.title, detail: k.detail, fix: k.fix })) })),
      workflow: ["bench_targets (read the rubric)", "build with the fixes already applied (handlers validate, pcall + BindToClose, modules, tagged scripts, TextScaled)", "bench_run (score + findings)", "apply the fix command on each finding, highest weight first", "bench_run again - report the delta and the grade"],
    };
    const lines = ["BENCH TARGETS " + BENCH_VERSION + " - pass " + PASS_SCORE + " (S>=95 A>=85 B>=70 C>=50)"];
    for (const c of data.categories) {
      lines.push(c.title.toUpperCase() + " (" + c.weight + "%): " + c.summary);
      for (const k of c.checks) lines.push("  - " + k.id + " [-" + k.weight + ", " + k.severity + "] " + k.title + " -> " + k.fix);
    }
    lines.push("Workflow: " + data.workflow.join(" -> "));
    return { ok: true, data, text: lines.join("\n") };
  }

  // ───────────────────────── Luau library ─────────────────────────
  const HEAD = `local HttpService=game:GetService('HttpService')
local Workspace=game:GetService('Workspace')
local StarterGui=game:GetService('StarterGui')
local ServerStorage=game:GetService('ServerStorage')
local BENCH_VERSION=${q(BENCH_VERSION)}
local PASS_SCORE=${PASS_SCORE}
local CHECKS=HttpService:JSONDecode(${jj(Object.fromEntries(CHECKS.map((c) => [c.id, { cat: c.cat, weight: c.weight, per: c.per, severity: c.severity, title: c.title, fix: c.fix }])))})
local CATS=HttpService:JSONDecode(${jj(CATEGORIES.map((c) => ({ id: c.id, weight: c.weight, title: c.title })))})
local function ok(d,t) return HttpService:JSONEncode({ok=true,data=d,text=t or ''}) end
local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end
local function resolve(p) if p==nil or p=='' then return nil end if typeof(p)=='Instance' then return p end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local lp=p:lower() if lp=='game' then return game end local cur=game for seg in p:gmatch('[^%.]+') do local nxt=cur:FindFirstChild(seg) if not nxt and cur==game then local okS,s=pcall(function() return game:GetService(seg) end) if okS then nxt=s end end if not nxt then return nil end cur=nxt end return cur end
local function need(p,what) local i=resolve(p) if not i then error((what or 'instance')..' not found: '..tostring(p)) end return i end
local function short(i) local okN,n=pcall(function() return i:GetFullName() end) n=okN and n or tostring(i) return (n:gsub('^Workspace%.','WS.'):gsub('^StarterGui%.','SG.'):gsub('^ServerScriptService%.','SSS.'):gsub('^ReplicatedStorage%.','RS.'):gsub('^ServerStorage%.','SS.'):gsub('^StarterPlayer%.','SP.')) end
local function getp(i,k) local okP,v=pcall(function() return i[k] end) if okP then return v end return nil end
local function cnt(s,pat) local n=0 for _ in s:gmatch(pat) do n=n+1 end return n end
local function has(s,pat) return s:find(pat)~=nil end
local function skipTree(i) local n=i.Name return n=='TOTAL_GFX' or n=='Terrain' or n=='Camera' or n:sub(1,6)=='_Total' end
local function skipAnc(i) local p=i while p and p~=game do if skipTree(p) then return true end p=p.Parent end return false end
local function under(i,svcName) local okS,s=pcall(function() return game:GetService(svcName) end) if not okS or not s then return false end return i==s or i:IsDescendantOf(s) end
local function benchStore(create) local f=ServerStorage:FindFirstChild('_TotalBench') if not f and create then f=Instance.new('StringValue') f.Name='_TotalBench' f.Value='[]' f.Parent=ServerStorage end return f end
local function benchRead() local f=benchStore(false) if not f then return {} end local okJ,j=pcall(function() return HttpService:JSONDecode(f.Value) end) if okJ and type(j)=='table' then return j end return {} end
local function grade(s) if s>=95 then return 'S' elseif s>=85 then return 'A' elseif s>=70 then return 'B' elseif s>=50 then return 'C' end return 'D' end
local function mkRoots(pathArg) local R={build={},ui={},scripts={},scoped=false} if pathArg and pathArg~='' then local r=need(pathArg,'path') R.scoped=true if r:IsA('LayerCollector') or r:IsA('GuiObject') or r:IsDescendantOf(StarterGui) then R.ui={r} R.scripts={r} elseif r:IsA('LuaSourceContainer') then R.scripts={r} else R.build={r} R.ui={r} R.scripts={r} end return R end R.build={Workspace} R.ui={StarterGui} local svcs={'ServerScriptService','ServerStorage','ReplicatedStorage','ReplicatedFirst','StarterGui','StarterPlayer','StarterPack','Workspace'} for _,n in ipairs(svcs) do local okS,s=pcall(function() return game:GetService(n) end) if okS and s then R.scripts[#R.scripts+1]=s end end return R end
local function eachDesc(roots,fn,limit) local n=0 local seen={} for _,r in ipairs(roots) do if not seen[r] then seen[r]=true if not skipTree(r) then fn(r) n=n+1 end for _,d in ipairs(r:GetDescendants()) do if limit and n>=limit then return n end if not seen[d] and not skipAnc(d) then seen[d]=true fn(d) n=n+1 end end end end return n end`;

  // ───────────────────────── builders ─────────────────────────
  const B = {};

  B.bench_run = (a) => {
    const suite = String(a.suite || a.category || "all").toLowerCase();
    if (suite !== "all" && !CATEGORIES.some((c) => c.id === suite)) throw new Error("unknown suite '" + suite + "' - pass all | " + CATEGORIES.map((c) => c.id).join(" | "));
    const cfg = { path: a.path || "", suite, limit: Math.max(100, Math.min(40000, nn(a.limit, 12000))), max_scripts: Math.max(5, Math.min(600, nn(a.max_scripts, 250))), max_findings: Math.max(5, Math.min(80, nn(a.max_findings, 30))), save: a.save !== false, label: String(a.label || "").slice(0, 60) };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local R=mkRoots(A.path) local suite=A.suite",
      "local function want(c) return suite=='all' or suite==c end",
      "local F={} local counts={} local penalty={}",
      "local function ex(list) local t={} for i=1,math.min(5,#list) do t[i]=type(list[i])=='string' and list[i] or short(list[i]) end if #list>5 then t[#t+1]='+'..(#list-5)..' more' end return t end",
      "local function add(id,n,msg,paths) local k=CHECKS[id] if not k or not want(k.cat) then return end n=n or 1 local w=math.min(k.weight,math.ceil(k.weight*n/math.max(1,k.per))) if n>=k.per then w=k.weight end penalty[k.cat]=(penalty[k.cat] or 0)+w F[#F+1]={id=id,category=k.cat,severity=k.severity,weight=w,count=n,title=k.title,message=msg,fix=k.fix,examples=ex(paths or {})} end",
      // scripts
      "local scripts={} local skipped=0",
      "eachDesc(R.scripts,function(d) if d:IsA('LuaSourceContainer') and #scripts<A.max_scripts then local okS,src=pcall(function() return d.Source end) if okS and type(src)=='string' then scripts[#scripts+1]={inst=d,src=src,low=src:lower(),cls=d.ClassName} else skipped=skipped+1 end end end,A.limit)",
      "counts.scripts=#scripts counts.scripts_unreadable=skipped",
      "local serverSrc,clientSrc='','' local nServer,nClient,nModule=0,0,0",
      "for _,s in ipairs(scripts) do if s.cls=='Script' then nServer=nServer+1 serverSrc=serverSrc..'\\n'..s.src elseif s.cls=='LocalScript' then nClient=nClient+1 clientSrc=clientSrc..'\\n'..s.low else nModule=nModule+1 clientSrc=clientSrc..'\\n'..s.low end end",
      "counts.server_scripts=nServer counts.local_scripts=nClient counts.module_scripts=nModule",
      // remotes
      "local remotes={} eachDesc(R.scoped and R.scripts or {game:GetService('ReplicatedStorage'),Workspace,game:GetService('ReplicatedFirst')},function(d) if d:IsA('RemoteEvent') or d:IsA('RemoteFunction') then remotes[#remotes+1]=d end end,A.limit)",
      "counts.remotes=#remotes",
      "local function esc(s) return (s:gsub('[%^%$%(%)%%%.%[%]%*%+%-%?]','%%%0')) end",
      "local function chunkFor(src,nm) local p=src:find(esc(nm)..'[\"\\'%)%]]*%s*%.%s*OnServer') if not p then return src end local st=src:find('OnServer',p,true) local nxt=st and src:find('OnServer',st+8,true) return src:sub(p,nxt and nxt-1 or #src) end",
      "do local unhandled,unval,trust,defnames={},{},{},{}",
      " for _,r in ipairs(remotes) do",
      "  local nm=r.Name if nm=='RemoteEvent' or nm=='RemoteFunction' then defnames[#defnames+1]=r end",
      "  local handler=nil",
      "  for _,s in ipairs(scripts) do if s.cls=='Script' and has(s.src,esc(nm)) and (has(s.src,'OnServerEvent') or has(s.src,'OnServerInvoke')) then handler=s break end end",
      "  if not handler then unhandled[#unhandled+1]=r else",
      "   local b=chunkFor(handler.src,nm)",
      "   local validates=has(b,'typeof%s*%(') or has(b,'%f[%w_]type%s*%(') or has(b,'math%.clamp') or has(b,'%f[%w_]assert%s*%(') or has(b,'[cC]ooldown') or has(b,'[dD]ebounce') or has(b,'os%.clock') or has(b,'%f[%w_]tick%s*%(')",
      "   if not validates then unval[#unval+1]=r end",
      "   if has(b,'OnServerEvent') and (has(b,'TakeDamage%s*%(') or has(b,'%.Health%s*=') or has(b,'%.Value%s*=%s*[%w_%.]+%s*[%+%-]')) and not (has(b,'math%.clamp') or has(b,'math%.min')) then trust[#trust+1]=r end",
      "  end",
      " end",
      " counts.remotes_unhandled=#unhandled counts.remotes_unvalidated=#unval",
      " if #unhandled>0 then add('remote_unhandled',#unhandled,#unhandled..' remote(s) with no server handler.',unhandled) end",
      " if #unval>0 then add('remote_unvalidated',#unval,#unval..' server handler(s) never validate arguments.',unval) end",
      " if #trust>0 then add('client_damage_trusted',#trust,#trust..' handler(s) apply a client-supplied number.',trust) end",
      " if #defnames>0 then add('default_remote_names',#defnames,#defnames..' remote(s) still named RemoteEvent / RemoteFunction.',defnames) end",
      "end",
      // per-script checks
      "do local dsClient,reqId,loadstr,secret,httpNo,busy,frame,touched,dsNo,stubs,disabled,globals,misplaced,longs,apiWrong={},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
      " local writes,bindClose,leaveSave,connects,disconnects,prints=false,false,false,0,0,0",
      " for _,s in ipairs(scripts) do local src,low,d=s.src,s.low,s.inst",
      "  local lines=cnt(src,'\\n')+1",
      "  if s.cls=='LocalScript' and has(src,'DataStoreService') then dsClient[#dsClient+1]=d end",
      "  if has(src,'require%s*%(%s*%d%d%d%d+') then reqId[#reqId+1]=d end",
      "  if has(src,'%f[%w_]loadstring%s*%(') or has(src,'%f[%w_]getfenv%s*%(') or has(src,'%f[%w_]setfenv%s*%(') then loadstr[#loadstr+1]=d end",
      "  do local sec=src:match('Bearer%s+([%w%-_%.]+)') or low:match('api_?key%s*=%s*[\"\\']([%w%-_]+)[\"\\']') or low:match('secret%s*=%s*[\"\\']([%w%-_]+)[\"\\']') or low:match('token%s*=%s*[\"\\']([%w%-_%.]+)[\"\\']') or low:match('%f[%w_][%w_]*key%s*=%s*[\"\\']([%w%-_%.]+)[\"\\']') or src:match('[\"\\'](sk_live_[%w_]+)[\"\\']') or src:match('[\"\\'](ghp_[%w]+)[\"\\']') if sec and #sec>=16 then secret[#secret+1]=d end end",
      "  local httpCalls=cnt(src,':RequestAsync%s*%(')+cnt(src,':PostAsync%s*%(')+((has(src,'HttpService') and not has(src,'DataStoreService')) and cnt(src,':GetAsync%s*%(') or 0) if httpCalls>0 and not has(src,'%f[%w_]pcall%s*%(') then httpNo[#httpNo+1]=d end",
      "  if has(src,'while%s+true%s+do') and has(src,'%f[%w_]wait%s*%(') and not has(src,'task%.wait') then busy[#busy+1]=d end",
      "  if (has(src,'RenderStepped') or has(src,'Heartbeat') or has(src,'%.Stepped')) and (has(src,'GetDescendants%s*%(') or has(src,'GetChildren%s*%(')) then frame[#frame+1]=d end",
      "  if has(src,'%.Touched:[cC]onnect') and not (has(low,'debounce') or has(low,'cooldown') or has(src,'%f[%w_]tick%s*%(') or has(src,'os%.clock') or has(low,'lasthit') or has(low,'recent')) then touched[#touched+1]=d end",
      "  local dsCalls=cnt(src,':GetAsync%s*%(')+cnt(src,':SetAsync%s*%(')+cnt(src,':UpdateAsync%s*%(')+cnt(src,':IncrementAsync%s*%(')+cnt(src,':RemoveAsync%s*%(')",
      "  if has(src,'DataStoreService') and dsCalls>0 then if not has(src,'%f[%w_]pcall%s*%(') then dsNo[#dsNo+1]=d end if has(src,':SetAsync') or has(src,':UpdateAsync') or has(src,':IncrementAsync') then writes=true end end",
      "  if has(src,'BindToClose') then bindClose=true end if has(src,'PlayerRemoving') and (dsCalls>0 or has(low,'save')) then leaveSave=true end",
      "  connects=connects+cnt(src,':[cC]onnect%s*%(') disconnects=disconnects+cnt(src,':Disconnect%s*%(')+cnt(src,'%f[%w_]Maid%f[^%w_]')+cnt(src,'%f[%w_]Janitor%f[^%w_]')+cnt(src,'%f[%w_]Trove%f[^%w_]')+cnt(src,'%.Destroying')",
      "  if s.cls=='Script' then prints=prints+cnt(src,'%f[%w_]print%s*%(') end",
      "  local trimmed=src:gsub('^%s+',''):gsub('%s+$','') if (#trimmed<20 and s.cls~='ModuleScript') or #trimmed<8 or has(src,'%-%-%s*TODO') then stubs[#stubs+1]=d end",
      "  local en=getp(d,'Enabled') local dis=getp(d,'Disabled') if (s.cls~='ModuleScript') and (en==false or dis==true) then disabled[#disabled+1]=d end",
      "  if has(src,'%f[%w_]_G%.') or has(src,'%f[%w_]shared%.') then globals[#globals+1]=d end",
      "  if (s.cls=='LocalScript' and (under(d,'ServerScriptService') or under(d,'ServerStorage'))) or (s.cls=='Script' and (under(d,'StarterPlayer') or under(d,'StarterGui') or under(d,'ReplicatedFirst')) and not tostring(getp(d,'RunContext') or ''):find('Client')) then misplaced[#misplaced+1]=d end",
      "  if lines>700 then longs[#longs+1]=d end",
      "  if (s.cls=='Script' and has(src,'LocalPlayer') and not under(d,'StarterGui') and not under(d,'StarterPlayer')) or (s.cls=='LocalScript' and (has(src,'ServerStorage') or has(src,'ServerScriptService'))) then apiWrong[#apiWrong+1]=d end",
      " end",
      " counts.datastore_writes=writes counts.connects=connects counts.prints=prints",
      " if #dsClient>0 then add('datastore_on_client',#dsClient,#dsClient..' LocalScript(s) touch DataStoreService.',dsClient) end",
      " if #reqId>0 then add('require_by_id',#reqId,#reqId..' script(s) require a numeric asset id at runtime.',reqId) end",
      " if #loadstr>0 then add('loadstring_used',#loadstr,#loadstr..' script(s) use loadstring / getfenv / setfenv.',loadstr) end",
      " if #secret>0 then add('secret_in_script',#secret,#secret..' script(s) contain a token-shaped secret.',secret) end",
      " if #httpNo>0 then add('http_no_pcall',#httpNo,#httpNo..' script(s) call HttpService outside pcall.',httpNo) end",
      " if #busy>0 then add('busy_loop',#busy,#busy..' script(s) run while true do ... wait() loops.',busy) end",
      " if #frame>0 then add('per_frame_scan',#frame,#frame..' script(s) walk the tree inside a per-frame handler.',frame) end",
      " if #touched>0 then add('touched_no_debounce',#touched,#touched..' Touched handler(s) without a debounce.',touched) end",
      " if #dsNo>0 then add('datastore_no_pcall',#dsNo,#dsNo..' script(s) call DataStores without pcall.',dsNo) end",
      " if writes and not bindClose then add('no_bind_to_close',1,'DataStores are written but no script calls game:BindToClose.',{}) end",
      " if writes and not leaveSave then add('no_save_on_leave',1,'DataStores are written but nothing saves in Players.PlayerRemoving.',{}) end",
      " if connects>15 and disconnects==0 then add('no_connection_cleanup',1,connects..' :Connect( calls and no Disconnect / Maid / Janitor / Destroying anywhere.',{}) end",
      " if #stubs>0 then add('stub_scripts',#stubs,#stubs..' placeholder script(s) (empty or -- TODO).',stubs) end",
      " if prints>12 then add('debug_prints',1,prints..' print( calls across server scripts.',{}) end",
      " if #disabled>0 then add('disabled_scripts',#disabled,#disabled..' disabled script(s).',disabled) end",
      " if #globals>0 then add('globals_used',#globals,#globals..' script(s) use _G / shared.',globals) end",
      " if #scripts>=6 and nModule*5<#scripts then add('monolith',1,nModule..' ModuleScript(s) for '..#scripts..' scripts.',{}) end",
      " if #misplaced>0 then add('script_misplaced',#misplaced,#misplaced..' script(s) in a container where they never run.',misplaced) end",
      " if #apiWrong>0 then add('server_api_on_client',#apiWrong,#apiWrong..' script(s) use the other side\\'s API (LocalPlayer on the server / ServerStorage on the client).',apiWrong) end",
      " if #longs>0 then add('long_script',#longs,#longs..' script(s) over 700 lines.',longs) end",
      "end",
      // build / instance budgets
      "if want('performance') and #R.build>0 then",
      " local parts,unions,decals,shadowL,hotE,rateSum,perPart,maxRate=0,0,0,0,{},0,{},0",
      " eachDesc(R.build,function(d)",
      "  if d:IsA('BasePart') then parts=parts+1 if d:IsA('UnionOperation') then unions=unions+1 end",
      "  elseif d:IsA('Decal') then decals=decals+1",
      "  elseif d:IsA('Light') then if getp(d,'Shadows')==true then shadowL=shadowL+1 end",
      "  elseif d:IsA('ParticleEmitter') then local r=tonumber(getp(d,'Rate')) or 0 if getp(d,'Enabled')==false then r=0 end rateSum=rateSum+r if r>maxRate then maxRate=r end if r>500 then hotE[#hotE+1]=d end",
      "  elseif d:IsA('Script') then local p=d.Parent if p and p:IsA('BasePart') then perPart[#perPart+1]=d end end",
      " end,A.limit)",
      " counts.parts=parts counts.unions=unions counts.decals=decals counts.shadow_lights=shadowL counts.particle_rate=rateSum counts.scripts_in_parts=#perPart",
      " if #hotE>0 or rateSum>2500 then add('particles_hot',1,'Particle budget: '..math.floor(rateSum)..'/s in total, hottest emitter '..math.floor(maxRate)..'/s.',hotE) end",
      " if shadowL>24 then add('shadow_lights',1,shadowL..' lights cast shadows.',{}) end",
      " if #perPart>30 then add('script_per_part',1,#perPart..' Scripts live inside BaseParts.',perPart) end",
      " if parts>20000 then add('part_budget',1,parts..' BaseParts in scope.',{}) end",
      " if unions>200 then add('unions_heavy',1,unions..' UnionOperations.',{}) end",
      " if decals>1500 then add('decals_heavy',1,decals..' Decals / Textures.',{}) end",
      "end",
      // ui wiring
      "if want('ui_wiring') and #R.ui>0 then",
      " local dead,fixedText,offRoots,buttons,texts,roots={},{},{},0,0,0",
      " eachDesc(R.ui,function(d)",
      "  if d:IsA('GuiButton') then buttons=buttons+1 local nm=d.Name:lower() local own=d:FindFirstChildWhichIsA('LuaSourceContainer',true) local generic=(nm=='textbutton' or nm=='imagebutton' or nm=='button') if not own and (generic or not clientSrc:find(esc(nm),1,true)) then dead[#dead+1]=d end end",
      "  if d:IsA('TextLabel') or d:IsA('TextButton') or d:IsA('TextBox') then texts=texts+1 if getp(d,'TextScaled')~=true and not d:FindFirstChildOfClass('UITextSizeConstraint') then fixedText[#fixedText+1]=d end end",
      "  if d:IsA('GuiObject') and d.Parent and d.Parent:IsA('LayerCollector') then roots=roots+1 local sz=getp(d,'Size') local scaleFree=sz and sz.X.Scale==0 and sz.Y.Scale==0 and (sz.X.Offset>0 or sz.Y.Offset>0) if scaleFree and not d:FindFirstChildOfClass('UIAspectRatioConstraint') and not d.Parent:FindFirstChildOfClass('UIScale') and not d:FindFirstChildOfClass('UIScale') then offRoots[#offRoots+1]=d end end",
      " end,A.limit)",
      " counts.buttons=buttons counts.text_objects=texts counts.ui_roots=roots counts.dead_buttons=#dead",
      " if #dead>0 then add('dead_buttons',#dead,#dead..' of '..buttons..' button(s) are referenced by no LocalScript.',dead) end",
      " if #fixedText>0 then add('text_not_scaled',#fixedText,#fixedText..' of '..texts..' text object(s) use a fixed TextSize.',fixedText) end",
      " if #offRoots>0 then add('offset_only_root',#offRoots,#offRoots..' root frame(s) sized in Offset only.',offRoots) end",
      "end",
      // scores
      "local cats={} local overall,wsum=0,0",
      "for _,c in ipairs(CATS) do if want(c.id) then local s=math.max(0,100-(penalty[c.id] or 0)) cats[c.id]=s overall=overall+s*c.weight wsum=wsum+c.weight end end",
      "overall=wsum>0 and math.floor(overall/wsum+0.5) or 100",
      "table.sort(F,function(x,y) if x.weight~=y.weight then return x.weight>y.weight end return x.id<y.id end)",
      "local shown={} for i=1,math.min(#F,A.max_findings) do shown[i]=F[i] end",
      // history
      "local prev,delta=nil,nil local hist=benchRead()",
      "if not R.scoped and suite=='all' then for i=#hist,1,-1 do if type(hist[i])=='table' and hist[i].overall then prev=hist[i] break end end",
      " if prev then delta=overall-prev.overall end",
      " if A.save then local st=benchStore(true) hist[#hist+1]={t=os.time(),overall=overall,grade=grade(overall),cats=cats,findings=#F,label=A.label} while #hist>12 do table.remove(hist,1) end st.Value=HttpService:JSONEncode(hist) end",
      "end",
      "local order={} for _,c in ipairs(CATS) do if cats[c.id] then order[#order+1]=c.id..' '..cats[c.id] end end",
      "local head='BENCH '..overall..'/100 ('..grade(overall)..(overall>=PASS_SCORE and ', pass' or ', below '..PASS_SCORE)..') - '..table.concat(order,' | ')..(delta and (' | delta '..(delta>=0 and '+' or '')..delta..' vs last run') or '')",
      "local lines={head}",
      "for _,f in ipairs(shown) do lines[#lines+1]='- ['..f.category..' -'..f.weight..' '..f.severity..'] '..f.id..': '..f.message..(#f.examples>0 and (' e.g. '..table.concat(f.examples,', ')) or '')..' -> FIX: '..f.fix end",
      "if #F>#shown then lines[#lines+1]='('..(#F-#shown)..' more finding(s) - raise max_findings)' end",
      "if #F==0 then lines[#lines+1]='No findings in scope ('..counts.scripts..' scripts read).' end",
      "lines[#lines+1]='Next: fix the top finding, then bench_run again - the delta is reported automatically.'",
      "return ok({version=BENCH_VERSION,overall=overall,grade=grade(overall),pass=overall>=PASS_SCORE,pass_score=PASS_SCORE,categories=cats,findings=shown,total_findings=#F,counts=counts,scope=A.path~='' and A.path or 'game',suite=suite,previous=prev and prev.overall or nil,delta=delta},table.concat(lines,'\\n'))",
    ].join("\n");
  };

  B.bench_history = (a) => {
    const cfg = { clear: a.clear === true, limit: Math.max(1, Math.min(12, nn(a.limit, 12))) };
    return [
      "local A=HttpService:JSONDecode(" + jj(cfg) + ")",
      "local st=benchStore(false)",
      "if A.clear then if st then st:Destroy() end return ok({cleared=true,runs={}},'Benchmark history cleared.') end",
      "local hist=benchRead() local runs={} local first=math.max(1,#hist-A.limit+1)",
      "for i=first,#hist do runs[#runs+1]=hist[i] end",
      "if #runs==0 then return ok({runs={},count=0},'No benchmark runs stored yet - bench_run first.') end",
      "local lines={'BENCH HISTORY ('..#runs..' run(s), newest last)'}",
      "for i,r in ipairs(runs) do local c={} for _,cat in ipairs(CATS) do if r.cats and r.cats[cat.id] then c[#c+1]=cat.id:sub(1,4)..' '..r.cats[cat.id] end end lines[#lines+1]=i..'. '..tostring(r.overall)..'/100 '..tostring(r.grade or grade(r.overall or 0))..(r.label and r.label~='' and (' ['..r.label..']') or '')..' - '..table.concat(c,' ')..' - '..tostring(r.findings or 0)..' finding(s)' end",
      "local trend=(#runs>=2) and (runs[#runs].overall-runs[1].overall) or 0",
      "local best=0 for _,r in ipairs(runs) do if (r.overall or 0)>best then best=r.overall end end",
      "lines[#lines+1]='Trend: '..(trend>=0 and '+' or '')..trend..' over '..#runs..' run(s); best '..best..'.'",
      "return ok({runs=runs,count=#runs,trend=trend},table.concat(lines,'\\n'))",
    ].join("\n");
  };

  // ───────────────────────── catalogue ─────────────────────────
  const S = (type, req, desc) => ({ type, req: !!req, desc: desc || "" });
  const C = [
    { name: "bench_targets", description: "The benchmark rubric (no Studio needed): 5 categories (security 30 / performance 25 / robustness 20 / architecture 15 / ui_wiring 10), every check with its weight, severity and the exact fix command, plus the pass score (85) and grades (S/A/B/C/D). Read it BEFORE building so handlers validate, saves pcall + BindToClose, scripts use modules and tags, and buttons are wired from the start - then bench_run proves it.", params: { category: S("string", false, "all (default) | security | performance | robustness | architecture | ui_wiring") } },
    { name: "bench_run", description: "Score the place (or one path) 0-100 the way a reviewer comparing two builds would - SECURITY (unhandled / unvalidated remotes, client-trusted damage, DataStore on the client, require-by-id, loadstring, secrets, HTTP without pcall), PERFORMANCE (while-true-wait loops, GetDescendants inside RenderStepped / Heartbeat, Touched without debounce, particle / shadow-light / part budgets, one-script-per-part), ROBUSTNESS (DataStore without pcall, no BindToClose, no PlayerRemoving save, no connection cleanup, stub scripts, print spam), ARCHITECTURE (_G, no modules, default remote names, misplaced scripts, wrong-side APIs, overlong scripts) and UI WIRING (buttons no LocalScript references, fixed TextSize, offset-only roots). Returns the overall score + grade, per-category scores, findings sorted by weight with the exact fix command, and the delta against the previous run (history kept in ServerStorage._TotalBench). Read-only apart from that history value. Complements quality_audit (look) and project_health_report (hygiene).", params: { path: S("string", false, "limit to one container / GUI / script (default whole game)"), suite: S("string", false, "all (default) | security | performance | robustness | architecture | ui_wiring"), max_findings: S("number", false, "findings to list (default 30, max 80)"), max_scripts: S("number", false, "scripts to read (default 250)"), label: S("string", false, "tag stored with this run, e.g. 'after remotes fix'"), save: S("boolean", false, "false = do not append to the history") } },
    { name: "bench_history", description: "List the stored bench_run results (up to 12, newest last) with per-category scores, labels and the overall trend; clear:true removes the history.", params: { limit: S("number", false, "runs to list (default 12)"), clear: S("boolean", false) } },
  ];

  function buildBench(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      const m = body.match(/^local A=HttpService:JSONDecode\(('(?:[^'\\]|\\.)*')\)\n/);
      if (m) {
        const lib = HEAD + "\nlocal function TOTAL_RUN_" + op + "(A)\n" + body.slice(m[0].length) + "\nend";
        const tailLuau = "\nlocal okRun,resRun=pcall(function()\nlocal A=HttpService:JSONDecode(" + m[1] + ")\nreturn TOTAL_RUN_" + op + "(A)\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))";
        return { code: lib + "\n" + tailLuau, lib, body: tailLuau };
      }
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))";
      return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + (e && e.message ? e.message : e) };
    }
  }

  const prevBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    if (B[op]) return buildBench(op, args);
    if (op === "bench_targets") {
      const r = targetsLocal(args || {});
      if (!r.ok) return { err: "ERROR building command bench_targets: " + r.error };
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\nreturn ok(HttpService:JSONDecode(" + jj(r.data) + ")," + q(r.text) + ")\nend)\nif okRun then return resRun end\nreturn fail(resRun)";
      return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    }
    return prevBuild.call(RobloxScriptSkills, op, args);
  };
  const names = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!names.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name);
  RobloxScriptSkills.BENCH_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.BENCH_CHECKS = CHECKS.map((c) => c.id);
  RobloxScriptSkills.BENCH_CATEGORIES = CATEGORIES.map((c) => c.id);
  RobloxScriptSkills.BENCH_PASS_SCORE = PASS_SCORE;
  RobloxScriptSkills.BENCH_VERSION = BENCH_VERSION;
  RobloxScriptSkills.benchTargetsLocal = targetsLocal;
  RobloxScriptSkills.benchCheck = (id) => CHECK_BY_ID[id] || null;
})();
