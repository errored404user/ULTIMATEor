// SPDX-License-Identifier: MIT
// src/core/explorer.js — TotalExplorer (2.0.0): the Explorer & Inspector panel.
//
// A live view of the Studio DataModel inside the extension (cards panel →
// "Explorer" tab): browse services and their children, inspect the properties
// that matter for the selected instance, select it in Studio, copy its path,
// and SET IT AS THE TARGET of the next request - the path then rides to the
// model with the first tool result ("USER TARGET … use it as the parent / rig /
// subject unless the user names another") and the preflight's Selection probe
// sees the Studio selection too.
//
// Pure: no DOM, no chrome.*, no fetch. main.js wires the probes through the
// bridge (execute_luau, Edit datamodel, read-only except Selection:Set) and
// renders the HTML this module produces from its state object.
//
//   PROBES  rootLua()  childrenLua(path, cap)  propsLua(path)  searchLua(q, cap)  selectLua(path)
//   STATE   createState()  applyRoot/applyChildren/applyProps/applySearch(state, data)
//           toggle(state, path)  select(state, path)  setTarget(state, path|null)
//   RENDER  render(state) → HTML (escaped)   targetBrief(target) → text for the model
const TotalExplorer = (() => {
  "use strict";
  const VERSION = "2.0.0";
  const ROOTS = ["Workspace", "ReplicatedStorage", "ServerStorage", "ServerScriptService", "StarterGui", "StarterPack", "StarterPlayer", "Lighting", "SoundService", "ReplicatedFirst", "Teams"];
  const CHILD_CAP = 200;
  const SEARCH_CAP = 60;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lq = (s) => "'" + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n") + "'";
  const PROBE_MARK = "-- TotalScript explorer probe (read-only)";

  // ── Luau ───────────────────────────────────────────────────────────────────
  const LUA_RESOLVE = [
    "local function resolve(p)",
    " p=tostring(p or '') if p=='' then return nil end",
    " if p:sub(1,5)=='game.' then p=p:sub(6) end",
    " if p=='' then return game end",
    " if p:lower()=='workspace' then return workspace end",
    " local n=game",
    " for _,s in ipairs(string.split(p,'.')) do",
    "  if s~='' then",
    "   local nxt=n:FindFirstChild(s)",
    "   if not nxt then for _,ch in ipairs(n:GetChildren()) do if ch.Name:lower()==s:lower() then nxt=ch break end end end",
    "   if not nxt and n==game then local ok,svc=pcall(function() return game:GetService(s) end) if ok then nxt=svc end end",
    "   if not nxt then return nil end",
    "   n=nxt",
    "  end",
    " end",
    " return n",
    "end",
  ].join("\n");
  const LUA_ROW = [
    "local function row(c) local n=0 pcall(function() n=#c:GetChildren() end) return {name=c.Name,class=c.ClassName,n=n,path=c:GetFullName()} end",
  ].join("\n");

  function rootLua() {
    return [
      PROBE_MARK,
      "local hs=game:GetService('HttpService')",
      LUA_ROW,
      "local out={roots={}}",
      "for _,n in ipairs({" + ROOTS.map(lq).join(",") + "}) do",
      " local ok,svc=pcall(function() return game:GetService(n) end)",
      " if ok and svc then out.roots[#out.roots+1]=row(svc) end",
      "end",
      "pcall(function() out.selection={} for i,s in ipairs(game:GetService('Selection'):Get()) do if i>5 then break end out.selection[#out.selection+1]=s:GetFullName() end end)",
      "return hs:JSONEncode(out)",
    ].join("\n");
  }
  function childrenLua(path, cap) {
    cap = Math.max(1, Math.min(CHILD_CAP, Number(cap) || CHILD_CAP));
    return [
      PROBE_MARK,
      "local hs=game:GetService('HttpService')",
      LUA_RESOLVE,
      LUA_ROW,
      "local t=resolve(" + lq(path) + ")",
      "if not t then return hs:JSONEncode({found=false,path=" + lq(path) + "}) end",
      "local kids=t:GetChildren()",
      "local out={found=true,path=t:GetFullName(),children={},more=0}",
      "for i,c in ipairs(kids) do if i>" + cap + " then out.more=#kids-" + cap + " break end out.children[#out.children+1]=row(c) end",
      "return hs:JSONEncode(out)",
    ].join("\n");
  }
  function propsLua(path) {
    return [
      PROBE_MARK,
      "local hs=game:GetService('HttpService')",
      LUA_RESOLVE,
      "local t=resolve(" + lq(path) + ")",
      "if not t then return hs:JSONEncode({found=false,path=" + lq(path) + "}) end",
      "local function r3(v) return math.floor(v*1000+0.5)/1000 end",
      "local function v3(v) return {r3(v.X),r3(v.Y),r3(v.Z)} end",
      "local function col(c) return string.format('#%02x%02x%02x',math.floor(c.R*255+0.5),math.floor(c.G*255+0.5),math.floor(c.B*255+0.5)) end",
      "local p={}",
      "local function put(k,f) pcall(function() local v=f() if v~=nil then p[k]=v end end) end",
      "if t:IsA('BasePart') then put('Position',function() return v3(t.Position) end) put('Size',function() return v3(t.Size) end) put('Anchored',function() return t.Anchored end) put('CanCollide',function() return t.CanCollide end) put('Material',function() return t.Material.Name end) put('Color',function() return col(t.Color) end) put('Transparency',function() return r3(t.Transparency) end) put('Reflectance',function() return r3(t.Reflectance) end) end",
      "if t:IsA('MeshPart') then put('MeshId',function() return t.MeshId end) put('TextureID',function() return t.TextureID end) end",
      "if t:IsA('Model') then put('PrimaryPart',function() return t.PrimaryPart and t.PrimaryPart.Name or '(none)' end) put('BoundingBox',function() local cf,sz=t:GetBoundingBox() return v3(sz) end) put('Parts',function() local n=0 for _,d in ipairs(t:GetDescendants()) do if d:IsA('BasePart') then n=n+1 end end return n end) end",
      "if t:IsA('Humanoid') then put('RigType',function() return t.RigType.Name end) put('Health',function() return t.Health end) put('MaxHealth',function() return t.MaxHealth end) put('WalkSpeed',function() return t.WalkSpeed end) put('Animator',function() return t:FindFirstChildOfClass('Animator')~=nil end) end",
      "if t:IsA('LuaSourceContainer') then put('SourceLength',function() return #t.Source end) put('FirstLine',function() return (string.match(t.Source,'^[^\\n]*') or ''):sub(1,120) end) put('Enabled',function() return t.Enabled end) put('RunContext',function() return t.RunContext.Name end) end",
      "if t:IsA('LayerCollector') then put('Enabled',function() return t.Enabled end) put('DisplayOrder',function() return t.DisplayOrder end) put('GuiObjects',function() local n=0 for _,d in ipairs(t:GetDescendants()) do if d:IsA('GuiObject') then n=n+1 end end return n end) end",
      "if t:IsA('GuiObject') then put('Size',function() return tostring(t.Size) end) put('Position',function() return tostring(t.Position) end) put('AnchorPoint',function() return tostring(t.AnchorPoint) end) put('Visible',function() return t.Visible end) put('ZIndex',function() return t.ZIndex end) put('BackgroundColor3',function() return col(t.BackgroundColor3) end) put('BackgroundTransparency',function() return r3(t.BackgroundTransparency) end) end",
      "if t:IsA('TextLabel') or t:IsA('TextButton') or t:IsA('TextBox') then put('Text',function() return tostring(t.Text):sub(1,120) end) put('TextColor3',function() return col(t.TextColor3) end) put('TextSize',function() return t.TextSize end) put('Font',function() return t.FontFace.Family:match('[^/]+$') or t.Font.Name end) end",
      "if t:IsA('ImageLabel') or t:IsA('ImageButton') then put('Image',function() return t.Image end) end",
      "if t:IsA('KeyframeSequence') then put('Keyframes',function() return #t:GetKeyframes() end) put('Loop',function() return t.Loop end) put('Priority',function() return t.Priority.Name end) end",
      "if t:IsA('Animation') then put('AnimationId',function() return t.AnimationId end) end",
      "if t:IsA('Light') then put('Brightness',function() return r3(t.Brightness) end) put('Color',function() return col(t.Color) end) put('Enabled',function() return t.Enabled end) put('Range',function() return t.Range end) end",
      "if t:IsA('Sound') then put('SoundId',function() return t.SoundId end) put('Volume',function() return r3(t.Volume) end) put('Looped',function() return t.Looped end) put('Playing',function() return t.Playing end) end",
      "if t:IsA('ValueBase') then put('Value',function() return tostring(t.Value):sub(1,200) end) end",
      "if t:IsA('Attachment') then put('Position',function() return v3(t.Position) end) end",
      "if t:IsA('ParticleEmitter') then put('Rate',function() return t.Rate end) put('Enabled',function() return t.Enabled end) put('Texture',function() return t.Texture end) end",
      "if t:IsA('Decal') then put('Texture',function() return t.Texture end) put('Face',function() return t.Face.Name end) put('Transparency',function() return r3(t.Transparency) end) end",
      "if t:IsA('Camera') then put('CFramePosition',function() return v3(t.CFrame.Position) end) put('FieldOfView',function() return r3(t.FieldOfView) end) end",
      "if t==game:GetService('Lighting') then put('ClockTime',function() return r3(t.ClockTime) end) put('Technology',function() return t.Technology.Name end) put('Brightness',function() return r3(t.Brightness) end) put('Ambient',function() return col(t.Ambient) end) end",
      "local attrs={} local na=0 pcall(function() for k,v in pairs(t:GetAttributes()) do na=na+1 if na<=20 then attrs[k]=tostring(v):sub(1,80) end end end)",
      "local tags={} pcall(function() tags=game:GetService('CollectionService'):GetTags(t) end)",
      "local out={found=true,path=t:GetFullName(),name=t.Name,class=t.ClassName,parent=(t.Parent and t.Parent:GetFullName() or ''),children=#t:GetChildren(),props=p,attributes=attrs,attributeCount=na,tags=tags}",
      "return hs:JSONEncode(out)",
    ].join("\n");
  }
  function searchLua(query, cap) {
    cap = Math.max(1, Math.min(SEARCH_CAP, Number(cap) || SEARCH_CAP));
    const q = String(query || "").trim().toLowerCase();
    return [
      PROBE_MARK,
      "local hs=game:GetService('HttpService')",
      LUA_ROW,
      "local q=" + lq(q),
      "local out={query=q,results={},more=0}",
      "if q=='' then return hs:JSONEncode(out) end",
      "local n=0",
      "for _,svcName in ipairs({" + ROOTS.map(lq).join(",") + "}) do",
      " local ok,svc=pcall(function() return game:GetService(svcName) end)",
      " if ok and svc then for _,d in ipairs(svc:GetDescendants()) do",
      "  if d.Name:lower():find(q,1,true) or d.ClassName:lower()==q then n=n+1 if n<=" + cap + " then out.results[#out.results+1]=row(d) end end",
      " end end",
      "end",
      "out.more=math.max(0,n-" + cap + ")",
      "return hs:JSONEncode(out)",
    ].join("\n");
  }
  function selectLua(path) {
    return [
      "-- TotalScript explorer: select in Studio (Selection only, nothing else changes)",
      "local hs=game:GetService('HttpService')",
      LUA_RESOLVE,
      "local t=resolve(" + lq(path) + ")",
      "if not t then return hs:JSONEncode({found=false,path=" + lq(path) + "}) end",
      "game:GetService('Selection'):Set({t})",
      "return hs:JSONEncode({found=true,path=t:GetFullName(),selected=true})",
    ].join("\n");
  }

  function parse(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    try { const v = JSON.parse(s); if (v && typeof v === "object") return v; } catch {}
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) { try { const v = JSON.parse(s.slice(a, b + 1)); if (v && typeof v === "object") return v; } catch {} }
    return null;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  function createState() {
    return { nodes: {}, roots: [], selected: "", props: null, target: null, loading: {}, error: "", query: "", results: null, selection: [], loadedAt: 0 };
  }
  const normPath = (p) => String(p || "").replace(/^game\./, "");
  function node(state, path) { path = normPath(path); if (!state.nodes[path]) state.nodes[path] = { path, name: path.split(".").pop(), class: "?", n: 0, children: null, open: false }; return state.nodes[path]; }
  function applyRow(state, r) { const nd = node(state, r.path); nd.name = String(r.name || nd.name); nd.class = String(r.class || "?"); nd.n = Number(r.n) || 0; if (nd.n === 0) nd.children = []; return nd; }
  function applyRoot(state, data) {
    if (!data || !Array.isArray(data.roots)) { state.error = "The place could not be read (root probe failed)."; return state; }
    state.error = ""; state.roots = data.roots.map((r) => applyRow(state, r).path); state.selection = Array.isArray(data.selection) ? data.selection.map(String) : []; state.loadedAt = Date.now();
    return state;
  }
  function applyChildren(state, path, data) {
    const nd = node(state, path); delete state.loading[nd.path];
    if (!data || data.found === false || !Array.isArray(data.children)) { nd.children = []; nd.error = data && data.found === false ? "not found" : "could not be read"; return state; }
    nd.error = ""; nd.children = data.children.map((r) => applyRow(state, r).path); nd.more = Number(data.more) || 0; nd.open = true;
    return state;
  }
  function applyProps(state, path, data) {
    delete state.loading["props:" + normPath(path)];
    if (!data || data.found === false) { state.props = { path: normPath(path), missing: true }; return state; }
    state.props = { path: data.path, name: data.name, class: data.class, parent: data.parent, children: data.children, props: data.props || {}, attributes: data.attributes || {}, attributeCount: data.attributeCount || 0, tags: Array.isArray(data.tags) ? data.tags : [] };
    const nd = node(state, data.path); if (data.class) nd.class = data.class; if (data.name) nd.name = data.name;
    return state;
  }
  function applySearch(state, data) {
    delete state.loading.search;
    if (!data || !Array.isArray(data.results)) { state.results = { error: "search failed", rows: [], more: 0 }; return state; }
    state.results = { rows: data.results.map((r) => applyRow(state, r).path), more: Number(data.more) || 0, query: data.query };
    return state;
  }
  // toggle → "load" when children are unknown (caller runs childrenLua), else flips open
  function toggle(state, path) { const nd = node(state, path); if (nd.children === null) { if (state.loading[nd.path]) return "loading"; state.loading[nd.path] = true; return "load"; } nd.open = !nd.open; return nd.open ? "open" : "closed"; }
  function select(state, path) { state.selected = normPath(path); state.props = null; state.loading["props:" + state.selected] = true; return state.selected; }
  function setTarget(state, path) {
    if (!path) { state.target = null; return null; }
    const nd = node(state, path);
    state.target = { path: nd.path, class: nd.class, name: nd.name, at: Date.now() };
    return state.target;
  }
  function expandTo(state, path) { const parts = normPath(path).split("."); for (let i = 1; i < parts.length; i++) { const p = parts.slice(0, i).join("."); const nd = node(state, p); if (nd.children) nd.open = true; } }

  // ── Render ─────────────────────────────────────────────────────────────────
  const ICON = { Workspace: "▣", ReplicatedStorage: "⇄", ServerStorage: "▤", ServerScriptService: "⚙", StarterGui: "▭", StarterPack: "⚔", StarterPlayer: "☺", Lighting: "☀", SoundService: "♪", ReplicatedFirst: "⇡", Teams: "⚑", Model: "◫", Part: "▪", MeshPart: "◆", UnionOperation: "◈", Script: "≡", LocalScript: "≡", ModuleScript: "≣", Folder: "▸", ScreenGui: "▭", Frame: "▢", TextLabel: "T", TextButton: "⏺", ImageLabel: "▦", Humanoid: "☺", KeyframeSequence: "◷", Animation: "◷", RemoteEvent: "⇝", RemoteFunction: "⇝", Sound: "♪", PointLight: "✦", SpotLight: "✦", SurfaceLight: "✦", ParticleEmitter: "✧", Camera: "◉", Attachment: "•", Decal: "▨", Texture: "▨" };
  const icon = (cls) => ICON[cls] || "·";
  function rowHtml(state, nd, depth) {
    const sel = state.selected === nd.path;
    const isTarget = state.target && state.target.path === nd.path;
    const inSel = state.selection.includes(nd.path);
    const hasKids = nd.children === null ? nd.n > 0 : nd.children.length > 0;
    const loading = !!state.loading[nd.path];
    const caret = hasKids ? (loading ? "◌" : nd.open ? "▾" : "▸") : "·";
    return '<div class="rs-ex-row' + (sel ? " on" : "") + (isTarget ? " rs-ex-target" : "") + '" style="--d:' + depth + '" data-ex-path="' + esc(nd.path) + '" role="treeitem" aria-expanded="' + (hasKids ? (nd.open ? "true" : "false") : "false") + '" aria-selected="' + (sel ? "true" : "false") + '">'
      + '<button type="button" class="rs-ex-caret" data-ex-toggle="' + esc(nd.path) + '" aria-label="' + (nd.open ? "Collapse" : "Expand") + '"' + (hasKids ? "" : " disabled") + '>' + caret + '</button>'
      + '<button type="button" class="rs-ex-name" data-ex-select="' + esc(nd.path) + '" title="' + esc(nd.path) + '"><i class="rs-ex-ico" aria-hidden="true">' + icon(nd.class) + '</i><span>' + esc(nd.name) + '</span><small>' + esc(nd.class) + (nd.n ? " · " + nd.n : "") + '</small>' + (isTarget ? '<b class="rs-ex-pill">target</b>' : "") + (inSel ? '<b class="rs-ex-pill rs-ex-pill-sel">selected in Studio</b>' : "") + '</button>'
      + '</div>';
  }
  function treeHtml(state, paths, depth, out) {
    for (const p of paths) {
      const nd = state.nodes[p]; if (!nd) continue;
      out.push(rowHtml(state, nd, depth));
      if (nd.open && nd.children && nd.children.length) {
        treeHtml(state, nd.children, depth + 1, out);
        if (nd.more) out.push('<div class="rs-ex-more" style="--d:' + (depth + 1) + '">… ' + nd.more + ' more (search to find them)</div>');
      }
      if (nd.open && nd.error) out.push('<div class="rs-ex-more" style="--d:' + (depth + 1) + '">' + esc(nd.error) + '</div>');
    }
    return out;
  }
  function fmtVal(v) {
    if (Array.isArray(v)) return v.map((x) => (typeof x === "number" ? (Math.round(x * 100) / 100) : String(x))).join(", ");
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
    return String(v);
  }
  function propsHtml(state) {
    const P = state.props;
    if (!state.selected) return '<div class="rs-ex-empty">Select an instance to inspect it.</div>';
    if (!P) return '<div class="rs-ex-empty">Reading ' + esc(state.selected) + '…</div>';
    if (P.missing) return '<div class="rs-ex-empty">' + esc(P.path) + ' is not in the place any more. <button type="button" class="rs-ex-btn" data-ex-action="refresh">Refresh</button></div>';
    const isTarget = state.target && state.target.path === P.path;
    const rows = Object.keys(P.props || {}).map((k) => '<tr><th>' + esc(k) + '</th><td>' + esc(fmtVal(P.props[k])) + (/^#[0-9a-f]{6}$/i.test(String(P.props[k])) ? ' <i class="rs-ex-swatch" style="background:' + esc(P.props[k]) + '"></i>' : "") + '</td></tr>').join("");
    const attrs = Object.keys(P.attributes || {}).map((k) => '<tr><th>@' + esc(k) + '</th><td>' + esc(P.attributes[k]) + '</td></tr>').join("");
    return '<div class="rs-ex-head"><i class="rs-ex-ico" aria-hidden="true">' + icon(P.class) + '</i><div><b>' + esc(P.name) + '</b> <small>' + esc(P.class) + '</small><div class="rs-ex-path" title="' + esc(P.path) + '">' + esc(P.path) + '</div></div></div>'
      + '<div class="rs-ex-actions">'
      + '<button type="button" class="rs-ex-btn rs-ex-btn-primary" data-ex-action="' + (isTarget ? "untarget" : "target") + '">' + (isTarget ? "✓ Target of the next request (click to clear)" : "Use as target for the next request") + '</button>'
      + '<button type="button" class="rs-ex-btn" data-ex-action="studio-select">Select in Studio</button>'
      + '<button type="button" class="rs-ex-btn" data-ex-action="copy">Copy path</button>'
      + '<button type="button" class="rs-ex-btn" data-ex-action="ask">Ask the AI about it</button>'
      + '<button type="button" class="rs-ex-btn" data-ex-action="refresh">Refresh</button>'
      + '</div>'
      + '<table class="rs-ex-props"><tbody>'
      + '<tr><th>Parent</th><td>' + esc(P.parent || "—") + '</td></tr><tr><th>Children</th><td>' + esc(P.children) + '</td></tr>' + rows + attrs
      + (P.attributeCount > 20 ? '<tr><th>…</th><td>' + (P.attributeCount - 20) + ' more attributes</td></tr>' : "")
      + (P.tags && P.tags.length ? '<tr><th>Tags</th><td>' + esc(P.tags.join(", ")) + '</td></tr>' : "")
      + '</tbody></table>';
  }
  function render(state) {
    const tree = state.error ? '<div class="rs-ex-empty">' + esc(state.error) + ' <button type="button" class="rs-ex-btn" data-ex-action="reload">Retry</button></div>'
      : !state.roots.length ? '<div class="rs-ex-empty">' + (state.loading.root ? "Reading the place…" : 'Start the agent, then <button type="button" class="rs-ex-btn" data-ex-action="reload">load the place</button>.') + '</div>'
      : (state.results ? searchHtml(state) : treeHtml(state, state.roots, 0, []).join(""));
    const t = state.target;
    return '<div class="rs-ex" data-rs-explorer="' + VERSION + '">'
      + '<div class="rs-ex-bar">'
      + '<input type="search" class="rs-ex-search" data-ex-search placeholder="Search by name or class…" value="' + esc(state.query) + '" aria-label="Search the place">'
      + '<button type="button" class="rs-ex-btn" data-ex-action="reload" title="Re-read the services">↻</button>'
      + (t ? '<span class="rs-ex-targetchip" title="' + esc(t.path) + '">Target: <b>' + esc(t.name) + '</b> <small>' + esc(t.class) + '</small><button type="button" data-ex-action="untarget" aria-label="Clear target">×</button></span>' : "")
      + '</div>'
      + '<div class="rs-ex-split"><div class="rs-ex-tree" role="tree" aria-label="Studio explorer">' + tree + '</div><div class="rs-ex-inspector">' + propsHtml(state) + '</div></div>'
      + '</div>';
  }
  function searchHtml(state) {
    const R = state.results;
    if (R.error) return '<div class="rs-ex-empty">' + esc(R.error) + '</div>';
    if (!R.rows.length) return '<div class="rs-ex-empty">Nothing named like "' + esc(R.query) + '". <button type="button" class="rs-ex-btn" data-ex-action="clear-search">Back to the tree</button></div>';
    return '<div class="rs-ex-more">' + R.rows.length + (R.more ? "+" : "") + ' result' + (R.rows.length === 1 ? "" : "s") + ' for "' + esc(R.query) + '" <button type="button" class="rs-ex-btn" data-ex-action="clear-search">Back to the tree</button></div>'
      + R.rows.map((p) => rowHtml(state, state.nodes[p], 0)).join("");
  }

  // ── Target brief for the model ─────────────────────────────────────────────
  function targetBrief(target) {
    if (!target || !target.path) return "";
    return "━━━ USER TARGET (System note from TotalScript, not the user) ━━━\n"
      + "The user picked " + target.path + " [" + (target.class || "Instance") + "] in the Explorer panel as the target of this request. Treat it as the parent / rig / subject / thing to edit unless the user names another instance explicitly. Read it back (inspect_instance / script_read / ui_inspect as fits) before changing it; never recreate it from scratch.\n"
      + "Do not acknowledge this note; act on it.";
  }
  function targetTag(target) { return target && target.path ? "target=" + target.path : ""; }

  return Object.freeze({ VERSION, ROOTS, CHILD_CAP, SEARCH_CAP, PROBE_MARK, rootLua, childrenLua, propsLua, searchLua, selectLua, parse, createState, applyRoot, applyChildren, applyProps, applySearch, toggle, select, setTarget, expandTo, render, targetBrief, targetTag, normPath, _esc: esc });
})();
try { if (typeof module !== "undefined" && module.exports) module.exports = TotalExplorer; } catch {}
try { if (typeof window !== "undefined") window.TotalExplorer = TotalExplorer; } catch {}
