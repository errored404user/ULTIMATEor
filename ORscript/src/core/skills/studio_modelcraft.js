// SPDX-License-Identifier: GPL-3.0-or-later
// ORscript "Modelcraft" skill pack (1.70.0): the two commands that turn the
// agent's free-hand part soup into believable props.
//
//   model_prefab - 24 hand-tuned, proportioned props (tree, pine, bush, rock,
//                  table, chair, bench, crate, barrel, lamp_post, torch, door,
//                  window, pillar, arch, well, campfire, sign, bed, bookshelf,
//                  chest, fence, market_stall, cottage). Each is a palette-
//                  driven multi-part Model with a bottom-centre pivot, anchored,
//                  PrimaryPart set, optional row placement (count / spacing).
//   model_check  - geometry critic for ANY model: floating parts, buried
//                  (deep-overlap) parts, slivers, unanchored parts, default
//                  grey Plastic, palette sprawl, missing PrimaryPart, scale vs
//                  the expected size. Returns a 0-100 score, a pass/fail
//                  verdict and concrete fixes so the agent can self-correct
//                  before it calls a build "done".
//
// Same patch pattern as studio_ultimate.js. JS strings are double-quoted, every
// Luau string literal is single-quoted, no raw newline inside a Luau string and
// no Luau-only syntax (+=, if-expressions, continue) so tests/roblox_sim.py can
// execute every program for real.
(function () {
  if (typeof RobloxScriptSkills === "undefined") return;

  const q = (s) => '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  const nn = (v, d = 0) => { const x = Number(v); return isFinite(x) ? String(x) : String(d); };
  const bb = (v, d = false) => (v === undefined || v === null || v === "" ? (d ? "true" : "false") : (v === true || v === "true" || v === 1 || v === "1" || v === "yes") ? "true" : "false");
  const NAMED = { red: [200, 48, 40], green: [70, 130, 60], blue: [50, 110, 200], gold: [220, 170, 60], yellow: [235, 210, 70], purple: [120, 70, 170], cyan: [60, 190, 210], pink: [230, 120, 170], orange: [230, 130, 40], white: [240, 240, 236], black: [28, 28, 32], grey: [128, 128, 132], gray: [128, 128, 132], brown: [112, 76, 48], wood: [140, 98, 60], stone: [120, 118, 112], teal: [40, 140, 140], navy: [36, 50, 96], cream: [236, 228, 206], sand: [214, 196, 150] };
  const parseColor = (v) => {
    if (Array.isArray(v) && v.length >= 3 && v.every((x) => isFinite(Number(x)))) return v.slice(0, 3).map(Number);
    if (v && typeof v === "object" && isFinite(Number(v.r))) return [v.r, v.g, v.b].map(Number);
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (NAMED[s]) return NAMED[s];
      if (/^#?[0-9a-f]{6}$/.test(s)) { const h = s.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
      const parts = s.split(/[\s,]+/).map(Number);
      if (parts.length >= 3 && parts.every(isFinite)) return parts.slice(0, 3);
    }
    return null;
  };
  const cc = (v) => { const c = parseColor(v); return c ? "Color3.fromRGB(" + c.map((x) => Math.max(0, Math.min(255, Math.round(x)))).join(",") + ")" : "nil"; };
  const vec = (a, d) => {
    if (typeof a === "string") { const p = a.split(/[\s,]+/).map(Number); if (p.length >= 3 && p.every(isFinite)) a = p; }
    if (a && typeof a === "object" && !Array.isArray(a)) a = [a.x, a.y, a.z];
    if (!Array.isArray(a) || a.length < 3 || !a.slice(0, 3).every((x) => isFinite(Number(x)))) { if (!d) return "nil"; a = d; }
    return "Vector3.new(" + nn(a[0]) + "," + nn(a[1]) + "," + nn(a[2]) + ")";
  };
  const mat = (v) => { const m = String(v || "").replace(/[^A-Za-z]/g, ""); return m ? "Enum.Material." + m[0].toUpperCase() + m.slice(1) : "nil"; };

  // ---------------------------------------------------------------- prelude
  const HEAD = [
    "local HttpService=game:GetService('HttpService')",
    "local ChangeHistoryService=game:GetService('ChangeHistoryService')",
    "local function ok(d,t) d=d or {} d.ok=true if t then d.text=t end return HttpService:JSONEncode(d) end",
    "local function fail(m) return HttpService:JSONEncode({ok=false,error=tostring(m)}) end",
    "local function resolve(p) if p==nil or p=='' then return nil end p=tostring(p):gsub('^game%.',''):gsub('^Game%.','') local cur=game for seg in p:gmatch('[^%.]+') do local nx=cur:FindFirstChild(seg) if not nx and cur==game then local okS,svc=pcall(game.GetService,game,seg) if okS then nx=svc end end if not nx then return nil end cur=nx end return cur end",
    "local function need(p,what) local i=resolve(p) if not i then error((what or 'instance')..' not found: '..tostring(p),0) end return i end",
    "local function allParts(root) local out={} if root:IsA('BasePart') then out[1]=root end for _,d in ipairs(root:GetDescendants()) do if d:IsA('BasePart') then out[#out+1]=d end end return out end",
    "local function r2(x) return math.floor(x*100+0.5)/100 end",
    "local function v3(v) return {r2(v.X),r2(v.Y),r2(v.Z)} end",
    "local function wp(name) local okR,rec=pcall(function() return ChangeHistoryService:TryBeginRecording(name,name) end) if okR then return rec end return nil end",
    "local function wpDone(rec) if rec then pcall(function() ChangeHistoryService:FinishRecording(rec,Enum.FinishRecordingOperation.Commit) end) end end",
    // world-space AABB of an oriented part
    "local function aabb(p) local cf,h=p.CFrame,p.Size/2 local r,u,l=cf.RightVector,cf.UpVector,cf.LookVector local ex=Vector3.new(math.abs(r.X)*h.X+math.abs(u.X)*h.Y+math.abs(l.X)*h.Z,math.abs(r.Y)*h.X+math.abs(u.Y)*h.Y+math.abs(l.Y)*h.Z,math.abs(r.Z)*h.X+math.abs(u.Z)*h.Y+math.abs(l.Z)*h.Z) return cf.Position-ex,cf.Position+ex end",
    "local function isAxisAligned(p) local r,u=p.CFrame.RightVector,p.CFrame.UpVector local function a(v) return math.abs(math.abs(v.X)+math.abs(v.Y)+math.abs(v.Z)-1)<0.01 end return a(r) and a(u) end",
  ].join("\n");

  // ---------------------------------------------------------------- prefab library (Luau)
  // Builders work in unit studs with the prop's bottom-centre at the origin and
  // its front toward -Z; add() scales, rotates and parents. Palette P: a=main,
  // b=secondary / trim, c=accent, k=dark, w=light; R = seeded Random.
  const PF = [
    "local M=Instance.new('Model') local made={} local S=SCALE local P=PAL local R=RNG",
    "local function add(name,sx,sy,sz,x,y,z,color,material,shape,rx,ry,rz,extra) local p if shape=='Wedge' then p=Instance.new('WedgePart') elseif shape=='Corner' then p=Instance.new('CornerWedgePart') else p=Instance.new('Part') if shape=='Ball' then p.Shape=Enum.PartType.Ball elseif shape=='Cylinder' then p.Shape=Enum.PartType.Cylinder end end",
    " p.Name=name p.Size=Vector3.new(sx*S,sy*S,sz*S) p.CFrame=CFrame.new(x*S,y*S,z*S)*CFrame.Angles(math.rad(rx or 0),math.rad(ry or 0),math.rad(rz or 0)) p.Anchored=true p.CanCollide=true p.Color=color p.Material=material p.TopSurface=Enum.SurfaceType.Smooth p.BottomSurface=Enum.SurfaceType.Smooth",
    " if extra then for k,v in pairs(extra) do pcall(function() p[k]=v end) end end p.Parent=M made[#made+1]=p return p end",
    // vertical cylinder (Roblox cylinders lie along X, so roll 90 about Z)
    "local function cylY(name,r,h,x,y,z,color,material,extra) return add(name,h,r*2,r*2,x,y,z,color,material,'Cylinder',0,0,90,extra) end",
    "local function cylX(name,r,len,x,y,z,color,material,ry) return add(name,len,r*2,r*2,x,y,z,color,material,'Cylinder',0,ry or 0,0) end",
    "local function light(p,color,range,bright) local l=Instance.new('PointLight') l.Color=color l.Range=(range or 12)*S l.Brightness=bright or 1.5 l.Shadows=true l.Parent=p return l end",
    "local function fire(p,size) pcall(function() local f=Instance.new('Fire') f.Size=(size or 4)*S f.Heat=6 f.Parent=p end) end",
    "local function jit(a) return R:NextNumber(-a,a) end",
    "local W=Enum.Material.Wood local WP=Enum.Material.WoodPlanks local MT=Enum.Material.Metal local SL=Enum.Material.Slate local CB=Enum.Material.Cobblestone local FB=Enum.Material.Fabric local GL=Enum.Material.Glass local NE=Enum.Material.Neon local CO=Enum.Material.Concrete local BR=Enum.Material.Brick local GR=Enum.Material.Grass",
    "local Pf={}",
    "Pf.tree=function() cylY('Trunk',0.7,6,0,3,0,P.k,W) cylY('Root',1.0,0.6,0,0.3,0,P.k,W) add('Canopy',7.2,7.2,7.2,0,8.6,0,P.a,GR,'Ball') add('Canopy2',5.2,5.2,5.2,2.1+jit(0.4),7.4,0.9+jit(0.4),P.b,GR,'Ball') add('Canopy3',5,5,5,-2+jit(0.4),7.7,-1.2+jit(0.4),P.b,GR,'Ball') add('CanopyTop',4.4,4.4,4.4,0.4+jit(0.3),10.8,-0.3,P.a,GR,'Ball') return 'Trunk' end",
    "Pf.pine=function() cylY('Trunk',0.5,4.5,0,2.25,0,P.k,W) add('Tier1',7,3,7,0,5.2,0,P.a,GR,nil,0,0,0) add('Tier2',5.6,2.6,5.6,0,7.4,0,P.b,GR,nil,0,45,0) add('Tier3',4.2,2.4,4.2,0,9.4,0,P.a,GR,nil,0,0,0) add('Tier4',2.8,2.2,2.8,0,11.2,0,P.b,GR,nil,0,45,0) add('Tip',1.4,1.8,1.4,0,12.9,0,P.a,GR) return 'Trunk' end",
    "Pf.bush=function() add('Bush',3.4,2.8,3.4,0,1.4,0,P.a,GR,'Ball') add('Bush2',2.6,2.2,2.6,1.3+jit(0.3),1.1,0.7,P.b,GR,'Ball') add('Bush3',2.4,2,2.4,-1.2,1,-0.6+jit(0.3),P.b,GR,'Ball') add('Bush4',1.8,1.6,1.8,0.3,2.2,-0.9,P.a,GR,'Ball') return 'Bush' end",
    "Pf.rock=function() add('Rock',4,2.4,3.4,0,1.1,0,P.a,SL,nil,8,20+jit(15),5) add('Rock2',2.6,1.8,2.2,1.6,0.8,0.8,P.b,SL,nil,-10,55,12) add('Rock3',2,1.4,1.8,-1.5,0.6,-0.6,P.b,SL,nil,15,-30,-8) add('Pebble',0.9,0.6,0.8,2.4,0.3,-1.2,P.a,SL,nil,0,jit(40),0) return 'Rock' end",
    "Pf.table=function() add('Top',6,0.3,3,0,2.85,0,P.a,WP) add('Apron',5.4,0.5,2.4,0,2.45,0,P.k,W) for _,sx in ipairs({-1,1}) do for _,sz in ipairs({-1,1}) do add('Leg',0.4,2.7,0.4,sx*2.6,1.35,sz*1.1,P.k,W) end end return 'Top' end",
    "Pf.chair=function() add('Seat',2,0.3,2,0,1.65,0,P.a,WP) for _,sx in ipairs({-1,1}) do for _,sz in ipairs({-1,1}) do add('Leg',0.25,1.5,0.25,sx*0.8,0.75,sz*0.8,P.k,W) end end add('BackPostL',0.25,2.3,0.25,-0.85,2.95,0.85,P.k,W) add('BackPostR',0.25,2.3,0.25,0.85,2.95,0.85,P.k,W) add('BackRest',1.95,1.1,0.2,0,3.45,0.85,P.a,WP) return 'Seat' end",
    "Pf.bench=function() add('Seat',6,0.3,1.6,0,1.65,0,P.a,WP) add('LegL',0.3,1.5,1.4,-2.6,0.75,0,P.k,W) add('LegR',0.3,1.5,1.4,2.6,0.75,0,P.k,W) add('Stretcher',5,0.2,0.2,0,0.9,0,P.k,W) add('Back',6,1.4,0.25,0,2.75,0.68,P.a,WP) add('BackPostL',0.3,1.6,0.3,-2.6,2.3,0.68,P.k,W) add('BackPostR',0.3,1.6,0.3,2.6,2.3,0.68,P.k,W) return 'Seat' end",
    "Pf.crate=function() add('Body',3,3,3,0,1.5,0,P.a,WP) for _,sx in ipairs({-1,1}) do for _,sz in ipairs({-1,1}) do add('Edge',0.3,3.05,0.3,sx*1.4,1.5,sz*1.4,P.k,W) end end add('BandA',3.1,0.3,3.1,0,0.2,0,P.k,W) add('BandB',3.1,0.3,3.1,0,2.8,0,P.k,W) add('BandC',3.1,0.3,3.1,0,1.5,0,P.k,W) return 'Body' end",
    "Pf.barrel=function() cylY('Body',1.2,3.2,0,1.6,0,P.a,WP) cylY('Bulge',1.3,1.2,0,1.6,0,P.a,WP) cylY('BandA',1.28,0.25,0,0.6,0,P.b,MT) cylY('BandB',1.28,0.25,0,2.6,0,P.b,MT) cylY('Lid',1.0,0.1,0,3.22,0,P.k,W) return 'Body' end",
    "Pf.lamp_post=function() cylY('Base',0.7,0.5,0,0.25,0,P.k,MT) cylY('Pole',0.22,9.4,0,5.2,0,P.a,MT) add('Collar',0.7,0.3,0.7,0,9.9,0,P.k,MT) add('Arm',2.2,0.2,0.2,1,10,0,P.a,MT) add('Hanger',0.15,0.5,0.15,1.9,9.75,0,P.a,MT) local lamp=add('Lamp',1.2,1.1,1.2,1.9,8.95,0,P.c,NE) add('Cap',1.6,0.2,1.6,1.9,9.6,0,P.k,MT) add('Finial',0.3,0.3,0.3,0,10.25,0,P.k,MT) light(lamp,P.c,22,2) return 'Pole' end",
    "Pf.torch=function() cylY('Handle',0.16,2.2,0,1.1,0,P.k,W) cylY('Wrap',0.2,0.5,0,1.9,0,P.b,FB) local f=add('Flame',0.8,0.9,0.8,0,2.5,0,P.c,NE,'Ball',0,0,0,{CanCollide=false}) light(f,P.c,14,1.6) fire(f,3) return 'Handle' end",
    "Pf.door=function() add('PostL',0.5,7.5,0.5,-2.25,3.75,0,P.k,W) add('PostR',0.5,7.5,0.5,2.25,3.75,0,P.k,W) add('Lintel',5,0.5,0.5,0,7.75,0,P.k,W) add('Slab',4,7,0.3,0,3.5,0,P.a,WP) add('PlankA',0.12,6.6,0.08,-0.7,3.5,-0.19,P.k,W) add('PlankB',0.12,6.6,0.08,0.7,3.5,-0.19,P.k,W) add('Brace',4,0.4,0.08,0,2,-0.19,P.k,W) add('Brace2',4,0.4,0.08,0,5,-0.19,P.k,W) add('Handle',0.35,0.35,0.35,1.5,3.6,-0.3,P.c,MT,'Ball') return 'Slab' end",
    "Pf.window=function() add('Sill',4.8,0.3,0.6,0,0.15,0,P.k,W) add('Head',4.6,0.3,0.4,0,4.45,0,P.k,W) add('JambL',0.3,4.6,0.4,-2.15,2.3,0,P.k,W) add('JambR',0.3,4.6,0.4,2.15,2.3,0,P.k,W) add('Pane',4,4,0.15,0,2.3,0,P.c,GL,nil,0,0,0,{Transparency=0.45,Reflectance=0.1}) add('MullionV',0.15,4,0.2,0,2.3,0,P.a,W) add('MullionH',4,0.15,0.2,0,2.3,0,P.a,W) return 'Pane' end",
    "Pf.pillar=function() add('Plinth',3,0.6,3,0,0.3,0,P.b,CO) add('Base',2.6,0.3,2.6,0,0.75,0,P.a,CO) cylY('Shaft',1,8.4,0,5.1,0,P.a,CO) add('Neck',2.6,0.3,2.6,0,9.45,0,P.a,CO) add('Capital',3,0.6,3,0,9.9,0,P.b,CO) return 'Shaft' end",
    "Pf.arch=function() add('PierL',1.4,8,1.4,-3.4,4,0,P.a,CO) add('PierR',1.4,8,1.4,3.4,4,0,P.a,CO) add('FootL',1.8,0.5,1.8,-3.4,0.25,0,P.b,CO) add('FootR',1.8,0.5,1.8,3.4,0.25,0,P.b,CO) add('ImpostL',1.8,0.4,1.8,-3.4,8.2,0,P.b,CO) add('ImpostR',1.8,0.4,1.8,3.4,8.2,0,P.b,CO) add('Lintel',8.4,1.4,1.4,0,9.1,0,P.a,CO) add('SpringL',1.2,1.2,1.4,-2.3,7.9,0,P.a,CO,'Wedge',0,-90,0) add('SpringR',1.2,1.2,1.4,2.3,7.9,0,P.a,CO,'Wedge',0,90,0) add('Keystone',1.2,1.8,1.6,0,9.3,0,P.b,CO) return 'Lintel' end",
    "Pf.well=function() for i=1,10 do local a=(i-1)/10*math.pi*2 add('Stone',1.6,2,0.8,math.cos(a)*2.1,1,math.sin(a)*2.1,P.a,CB,nil,0,-math.deg(a)+90,0) end cylY('Rim',2.6,0.3,0,2.15,0,P.b,CO) cylY('Water',1.7,0.2,0,1.0,0,P.c,GL,{Transparency=0.3,CanCollide=false}) cylY('Floor',1.7,0.2,0,0.1,0,P.k,SL) add('PostL',0.4,5.2,0.4,-2.2,3.6,0,P.k,W) add('PostR',0.4,5.2,0.4,2.2,3.6,0,P.k,W) cylX('Axle',0.15,5,0,5.6,0,P.k,W) cylX('Crank',0.08,0.8,2.6,5.6,0,P.k,W,90) cylY('Rope',0.05,1.6,0,4.8,0,P.w,FB) cylY('Bucket',0.5,0.7,0,3.65,0,P.b,MT) add('RoofL',5.8,0.25,2.6,0,6.95,-1.05,P.b,WP,nil,35,0,0) add('RoofR',5.8,0.25,2.6,0,6.95,1.05,P.b,WP,nil,-35,0,0) add('Ridge',5.9,0.3,0.4,0,7.7,0,P.k,W) return 'Rim' end",
    "Pf.campfire=function() for i=1,7 do local a=(i-1)/7*math.pi*2 add('Stone',0.95,0.7,0.85,math.cos(a)*1.6,0.33,math.sin(a)*1.6,P.b,SL,'Ball',0,jit(30),0) end cylX('Log',0.25,2.8,0,0.45,0,P.k,W,0) cylX('Log2',0.25,2.8,0,0.5,0,P.k,W,60) cylX('Log3',0.25,2.8,0,0.55,0,P.k,W,120) cylY('Ash',1.1,0.15,0,0.08,0,P.a,SL) local f=add('Flame',1.1,1.4,1.1,0,1.4,0,P.c,NE,'Ball',0,0,0,{Transparency=0.15,CanCollide=false}) light(f,P.c,18,2) fire(f,5) return 'Ash' end",
    "Pf.sign=function() cylY('Post',0.2,4.2,0,2.1,0,P.k,W) add('Board',3.2,1.6,0.2,0,3.4,0,P.a,WP) add('FrameT',3.3,0.15,0.25,0,4.25,0,P.k,W) add('FrameB',3.3,0.15,0.25,0,2.55,0,P.k,W) add('Bracket',0.3,0.6,0.3,0,2.3,-0.1,P.k,MT) return 'Board' end",
    "Pf.bed=function() add('Frame',4.4,0.7,7.2,0,0.75,0,P.k,W) for _,sx in ipairs({-1,1}) do for _,sz in ipairs({-1,1}) do add('Leg',0.4,0.45,0.4,sx*2,0.22,sz*3.4,P.k,W) end end add('Mattress',4,0.55,6.8,0,1.38,0,P.w,FB) add('Blanket',4.1,0.25,4.3,0,1.78,-1.15,P.a,FB) add('BlanketFold',4.1,0.3,0.5,0,1.8,1.05,P.b,FB) add('Pillow',2.9,0.45,1.2,0,1.88,2.6,P.w,FB) add('Headboard',4.4,2.6,0.3,0,2.3,3.55,P.k,W) add('Footboard',4.4,1.2,0.3,0,1.3,-3.55,P.k,W) return 'Frame' end",
    "Pf.bookshelf=function() add('Back',4,7,0.25,0,3.5,0.5,P.k,W) add('SideL',0.25,7,1.3,-1.9,3.5,0,P.a,WP) add('SideR',0.25,7,1.3,1.9,3.5,0,P.a,WP) add('Top',4,0.25,1.3,0,6.9,0,P.a,WP) local cols={P.a,P.b,P.c,P.w,P.k} for s=1,4 do local y=0.15+(s-1)*1.75 add('Shelf',3.6,0.2,1.2,0,y,0,P.a,WP) local x=-1.55 local n=0 while x<1.4 and n<8 do n=n+1 local w=0.3+R:NextNumber(0,0.25) local h=1.0+R:NextNumber(0,0.4) add('Book',w,h,0.9,x+w/2,y+0.1+h/2,-0.05,cols[(s+n)%5+1],FB) x=x+w+0.04 end end return 'Back' end",
    "Pf.chest=function() add('Body',3,1.6,2,0,0.8,0,P.a,WP) cylX('Lid',1,3,0,1.6,0,P.a,WP) add('LidCap',3.05,0.8,2.05,0,1.6,0,P.a,WP) add('BandL',0.25,1.65,2.1,-1,0.8,0,P.b,MT) add('BandR',0.25,1.65,2.1,1,0.8,0,P.b,MT) cylX('LidBandL',1.03,0.25,-1,1.6,0,P.b,MT) cylX('LidBandR',1.03,0.25,1,1.6,0,P.b,MT) add('Latch',0.5,0.6,0.15,0,1.45,-1.08,P.c,MT) add('FootL',3.2,0.2,2.2,0,0.1,0,P.k,W) return 'Body' end",
    "Pf.fence=function() add('PostL',0.45,3.8,0.45,-3,1.9,0,P.k,W) add('PostR',0.45,3.8,0.45,3,1.9,0,P.k,W) add('CapL',0.6,0.2,0.6,-3,3.9,0,P.k,W) add('CapR',0.6,0.2,0.6,3,3.9,0,P.k,W) add('RailTop',6.3,0.3,0.2,0,2.9,0,P.a,WP) add('RailLow',6.3,0.3,0.2,0,1.3,0,P.a,WP) for i=-2,2 do add('Picket',0.5,3.2,0.12,i*1.1,1.75,-0.16,P.a,WP) end return 'RailTop' end",
    "Pf.market_stall=function() add('Counter',8,2.4,2.4,0,1.2,0.4,P.k,WP) add('CounterTop',8.4,0.3,2.8,0,2.55,0.4,P.a,WP) add('Skirt',8,0.5,0.1,0,0.3,-0.85,P.b,W) for _,sx in ipairs({-1,1}) do for _,sz in ipairs({-1.6,1.9}) do add('Post',0.4,8,0.4,sx*3.9,4,sz,P.k,W) end end add('Beam',8.2,0.3,0.3,0,8,-1.6,P.k,W) add('Beam2',8.2,0.3,0.3,0,8.6,1.9,P.k,W) for i=0,7 do local c=P.c if i%2==0 then c=P.w end add('Awning',1.05,0.15,4.4,-3.675+i*1.05,8.35,0.15,c,FB,nil,-10,0,0) end add('Crate',1.6,1.6,1.6,-2.4,3.5,0.3,P.b,WP) add('Crate2',1.4,1.4,1.4,2.2,3.4,0.5,P.b,WP) add('Sack',1.2,1.1,1.2,0,3.25,0.2,P.w,FB,'Ball') return 'Counter' end",
    "Pf.cottage=function() add('Plinth',12.6,0.4,10.6,0,0.2,0,P.b,CO) add('Floor',12,0.5,10,0,0.55,0,P.k,WP) add('WallBack',12,8,0.5,0,4.3,4.75,P.a,P.m) add('WallFrontL',4,8,0.5,-4,4.3,-4.75,P.a,P.m) add('WallFrontR',4,8,0.5,4,4.3,-4.75,P.a,P.m) add('DoorLintel',4,1,0.5,0,7.8,-4.75,P.a,P.m) add('Door',3.8,6.9,0.25,0,3.75,-4.75,P.k,WP) add('DoorFrame',4.4,0.4,0.6,0,7.45,-4.75,P.b,W) add('Knob',0.3,0.3,0.3,1.4,3.6,-4.95,P.c,MT,'Ball')",
    " for _,sx in ipairs({-1,1}) do local x=sx*5.75 add('WallSideF',0.5,8,4,x,4.3,-3,P.a,P.m) add('WallSideB',0.5,8,3,x,4.3,3.5,P.a,P.m) add('Spandrel',0.5,2.7,3,x,1.65,0.5,P.a,P.m) add('WindowLintel',0.5,2.3,3,x,7.15,0.5,P.a,P.m) add('Window',0.2,3,3,x,4.5,0.5,P.c,GL,nil,0,0,0,{Transparency=0.4}) add('WindowFrame',0.6,3.4,0.3,x,4.5,-1.1,P.b,W) add('WindowFrame',0.6,3.4,0.3,x,4.5,2.1,P.b,W) add('WindowSill',0.8,0.3,3.6,x,2.95,0.5,P.b,W) add('WindowHead',0.6,0.3,3.6,x,6.1,0.5,P.b,W) add('Mullion',0.3,3,0.15,x,4.5,0.5,P.b,W) end",
    " add('CornerFL',0.6,8,0.6,-5.9,4.3,-4.9,P.b,W) add('CornerFR',0.6,8,0.6,5.9,4.3,-4.9,P.b,W) add('CornerBL',0.6,8,0.6,-5.9,4.3,4.9,P.b,W) add('CornerBR',0.6,8,0.6,5.9,4.3,4.9,P.b,W)",
    " add('RoofL',13.4,0.4,6.4,0,9.8,-2.75,P.w,P.r,nil,30,0,0) add('RoofR',13.4,0.4,6.4,0,9.8,2.75,P.w,P.r,nil,-30,0,0) add('Ridge',13.6,0.5,0.8,0,11.4,0,P.k,W)",
    " for _,sx in ipairs({-1,1}) do add('GableF',0.5,2.9,5,sx*5.75,9.75,-2.5,P.a,P.m,'Wedge',0,0,0) add('GableB',0.5,2.9,5,sx*5.75,9.75,2.5,P.a,P.m,'Wedge',0,180,0) end",
    " add('Chimney',1.4,4.2,1.4,3.2,10.4,-2,P.b,BR) add('ChimneyCap',1.8,0.3,1.8,3.2,12.6,-2,P.k,CO) add('Step',4.6,0.4,1.4,0,0.2,-5.9,P.b,CO) return 'Floor' end",
    "Pf.tree_oak=Pf.tree Pf.fence_section=Pf.fence Pf.stall=Pf.market_stall Pf.house=Pf.cottage Pf.lamp=Pf.lamp_post Pf.column=Pf.pillar Pf.boulder=Pf.rock Pf.bookcase=Pf.bookshelf Pf.desk=Pf.table Pf.lantern=Pf.torch",
  ].join("\n");

  const KINDS = ["tree", "pine", "bush", "rock", "table", "chair", "bench", "crate", "barrel", "lamp_post", "torch", "door", "window", "pillar", "arch", "well", "campfire", "sign", "bed", "bookshelf", "chest", "fence", "market_stall", "cottage"];
  const ALIASES = { tree_oak: "tree", oak: "tree", fence_section: "fence", stall: "market_stall", house: "cottage", hut: "cottage", lamp: "lamp_post", streetlight: "lamp_post", street_light: "lamp_post", street_lamp: "lamp_post", oak_tree: "tree", pine_tree: "pine", camp_fire: "campfire", book_shelf: "bookshelf", market: "market_stall", small_house: "cottage", column: "pillar", boulder: "rock", stone: "rock", bookcase: "bookshelf", shelf: "bookshelf", desk: "table", lantern: "torch", fire: "campfire", bonfire: "campfire", gate: "arch", archway: "arch", shrub: "bush", spruce: "pine", fir: "pine", box: "crate", keg: "barrel", seat: "chair", signpost: "sign" };
  // Default palettes per kind: a main, b secondary/trim, c accent, k dark, w light; m wall material, r roof material (cottage)
  const PALETTES = {
    tree: { a: [66, 128, 54], b: [84, 146, 62], c: [120, 170, 70], k: [92, 61, 36], w: [230, 226, 210] },
    pine: { a: [38, 96, 52], b: [48, 112, 60], c: [80, 140, 80], k: [84, 56, 34], w: [230, 226, 210] },
    bush: { a: [60, 122, 50], b: [78, 140, 60], c: [120, 170, 70], k: [70, 48, 30], w: [230, 226, 210] },
    rock: { a: [104, 102, 100], b: [120, 116, 112], c: [140, 136, 130], k: [70, 68, 66], w: [190, 186, 180] },
    table: { a: [150, 106, 62], b: [120, 84, 50], c: [220, 170, 60], k: [88, 58, 34], w: [236, 228, 206] },
    chair: { a: [150, 106, 62], b: [120, 84, 50], c: [220, 170, 60], k: [88, 58, 34], w: [236, 228, 206] },
    bench: { a: [140, 98, 56], b: [120, 84, 50], c: [220, 170, 60], k: [70, 48, 30], w: [236, 228, 206] },
    crate: { a: [168, 126, 76], b: [140, 100, 58], c: [220, 170, 60], k: [96, 66, 38], w: [236, 228, 206] },
    barrel: { a: [128, 88, 50], b: [96, 96, 100], c: [220, 170, 60], k: [80, 54, 30], w: [236, 228, 206] },
    lamp_post: { a: [46, 48, 54], b: [70, 72, 78], c: [255, 214, 140], k: [28, 30, 34], w: [236, 228, 206] },
    torch: { a: [110, 74, 42], b: [120, 56, 40], c: [255, 150, 50], k: [84, 56, 34], w: [236, 228, 206] },
    door: { a: [128, 86, 48], b: [96, 64, 36], c: [214, 170, 70], k: [78, 52, 30], w: [236, 228, 206] },
    window: { a: [236, 228, 206], b: [120, 84, 50], c: [170, 210, 240], k: [88, 58, 34], w: [236, 228, 206] },
    pillar: { a: [204, 198, 186], b: [176, 170, 158], c: [214, 170, 70], k: [120, 116, 110], w: [236, 232, 224] },
    arch: { a: [190, 184, 172], b: [160, 154, 144], c: [214, 170, 70], k: [110, 106, 100], w: [236, 232, 224] },
    well: { a: [124, 118, 108], b: [150, 144, 134], c: [70, 140, 190], k: [84, 56, 34], w: [236, 228, 206] },
    campfire: { a: [60, 56, 54], b: [112, 108, 104], c: [255, 130, 40], k: [78, 52, 30], w: [236, 228, 206] },
    sign: { a: [168, 126, 76], b: [120, 84, 50], c: [214, 170, 70], k: [84, 56, 34], w: [236, 228, 206] },
    bed: { a: [128, 62, 76], b: [100, 46, 60], c: [214, 170, 70], k: [96, 66, 38], w: [236, 232, 224] },
    bookshelf: { a: [150, 106, 62], b: [120, 60, 50], c: [60, 90, 140], k: [88, 58, 34], w: [220, 200, 160] },
    chest: { a: [140, 96, 56], b: [92, 92, 96], c: [220, 170, 60], k: [80, 54, 30], w: [236, 228, 206] },
    fence: { a: [196, 178, 140], b: [160, 140, 100], c: [214, 170, 70], k: [108, 84, 54], w: [236, 228, 206] },
    market_stall: { a: [170, 128, 78], b: [150, 106, 62], c: [196, 60, 54], k: [96, 66, 38], w: [240, 234, 216] },
    cottage: { a: [228, 218, 196], b: [136, 130, 120], c: [160, 200, 230], k: [92, 62, 38], w: [150, 70, 56] },
  };

  const B = {};
  B.model_prefab = (a) => {
    const raw = String(a.kind || a.type || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const kind = ALIASES[raw] || raw;
    if (!KINDS.includes(kind)) throw new Error("unknown prefab kind '" + raw + "'. Kinds: " + KINDS.join(", "));
    const pal = Object.assign({}, PALETTES[kind]);
    const over = { a: a.color, b: a.color2 ?? a.trim_color, c: a.accent ?? a.color3, k: a.dark_color, w: a.light_color };
    for (const k of Object.keys(over)) { const c = parseColor(over[k]); if (c) pal[k] = c; }
    const palLua = "{a=" + cc(pal.a) + ",b=" + cc(pal.b) + ",c=" + cc(pal.c) + ",k=" + cc(pal.k) + ",w=" + cc(pal.w) + ",m=" + (a.material ? mat(a.material) : "Enum.Material." + (kind === "cottage" ? "Plaster" : "Wood")) + ",r=" + (a.roof_material ? mat(a.roof_material) : "Enum.Material.Slate") + "}";
    const scale = Math.max(0.1, Math.min(20, Number(a.scale) || 1));
    const count = Math.max(1, Math.min(60, Math.round(Number(a.count) || 1)));
    const name = a.name || kind.replace(/(^|_)([a-z])/g, (m, s, c) => c.toUpperCase());
    return [
      "local SCALE=" + nn(scale) + " local PAL=" + palLua + " local RNG=Random.new(" + nn(a.seed ?? 7) + ")",
      "local parentI=" + (a.parent ? "need(" + q(a.parent) + ",'parent')" : "workspace"),
      "local pos=" + vec(a.position, [0, 0, 0]) + " local rotY=math.rad(" + nn(a.rotation_y ?? a.rotation ?? 0) + ") local count=" + count + " local spacing=" + nn(a.spacing ?? 0),
      "local kind=" + q(kind) + " local baseName=" + q(name) + " local rec=wp('model_prefab '..kind) local out={} local total=0 local holder",
      "if count>1 then holder=Instance.new('Model') holder.Name=baseName..'s' holder.Parent=parentI end",
      "for i=1,count do",
      PF.replace(/\n/g, "\n "),
      " local primary=Pf[kind]() M.Name=baseName if count>1 then M.Name=baseName..i end",
      " local prim=M:FindFirstChild(primary) if prim then M.PrimaryPart=prim end",
      // bottom-centre pivot: lowest point of the model, centred on its footprint
      " local mn,mx for _,p in ipairs(made) do local lo,hi=aabb(p) if not mn then mn,mx=lo,hi else mn=Vector3.new(math.min(mn.X,lo.X),math.min(mn.Y,lo.Y),math.min(mn.Z,lo.Z)) mx=Vector3.new(math.max(mx.X,hi.X),math.max(mx.Y,hi.Y),math.max(mx.Z,hi.Z)) end end",
      // Roblox ignores WorldPivot once PrimaryPart is set, so the pivot goes through the primary's PivotOffset (identity rotation at the footprint centre)
      " local foot=Vector3.new((mn.X+mx.X)/2,mn.Y,(mn.Z+mx.Z)/2) if M.PrimaryPart then M.PrimaryPart.PivotOffset=M.PrimaryPart.CFrame:ToObjectSpace(CFrame.new(foot)) else M.WorldPivot=CFrame.new(foot) end",
      " local step=spacing if step==0 then step=(mx.X-mn.X)+1 end local off=(i-1)*step-(count-1)*step/2",
      " local target=CFrame.new(pos)*CFrame.Angles(0,rotY,0)*CFrame.new(off,0,0) M:PivotTo(target) M.Parent=holder or parentI",
      " total=total+#made out[#out+1]={path=M:GetFullName(),parts=#made,size=v3(mx-mn)}",
      "end",
      "wpDone(rec) local first=out[1]",
      "return ok({path=(holder and holder:GetFullName()) or first.path,kind=kind,count=count,parts=total,size=first.size,models=out,scale=SCALE},kind..' x'..count..' placed ('..total..' parts, '..first.size[1]..'x'..first.size[2]..'x'..first.size[3]..' studs). Run model_check on it, then or_screenshot.')",
    ].join("\n");
  };

  B.model_check = (a) => {
    const expectSize = vec(a.expect_size || a.size);
    return [
      "local root=need(" + q(a.path) + ",'model') local parts=allParts(root)",
      "if #parts==0 then return fail('no BaseParts under '..root:GetFullName()) end",
      "local expectSize=" + expectSize + " local expectParts=" + (a.expect_parts != null ? nn(a.expect_parts) : "nil") + " local maxList=" + nn(a.limit ?? 12),
      "local issues={} local score=100 local function issue(sev,kind,msg,fix,pts) issues[#issues+1]={severity=sev,kind=kind,message=msg,fix=fix} score=score-pts end",
      "local n=#parts local boxes={} local mn,mx for i,p in ipairs(parts) do local lo,hi=aabb(p) boxes[i]={lo,hi,p} if not mn then mn,mx=lo,hi else mn=Vector3.new(math.min(mn.X,lo.X),math.min(mn.Y,lo.Y),math.min(mn.Z,lo.Z)) mx=Vector3.new(math.max(mx.X,hi.X),math.max(mx.Y,hi.Y),math.max(mx.Z,hi.Z)) end end",
      "local size=mx-mn local groundY=mn.Y",
      "local function names(list) local t={} for i=1,math.min(#list,maxList) do t[#t+1]=list[i] end local s=table.concat(t,', ') if #list>maxList then s=s..' (+'..(#list-maxList)..' more)' end return s end",
      // floating: nothing touches the part (expanded by tol) and it is not resting on the ground plane
      "local tol=0.2 local floating={} local buried={} local pairsSeen=0",
      "for i=1,n do local lo,hi,p=boxes[i][1],boxes[i][2],boxes[i][3] local touched=false",
      " if lo.Y<=groundY+tol then touched=true end",
      " local volI=(hi.X-lo.X)*(hi.Y-lo.Y)*(hi.Z-lo.Z)",
      " for j=1,n do if j~=i then local lo2,hi2,p2=boxes[j][1],boxes[j][2],boxes[j][3]",
      "  local ox=math.min(hi.X,hi2.X)-math.max(lo.X,lo2.X) local oy=math.min(hi.Y,hi2.Y)-math.max(lo.Y,lo2.Y) local oz=math.min(hi.Z,hi2.Z)-math.max(lo.Z,lo2.Z)",
      "  if ox>-tol and oy>-tol and oz>-tol then touched=true end",
      "  if j>i and ox>0.05 and oy>0.05 and oz>0.05 and isAxisAligned(p) and isAxisAligned(p2) then local volJ=(hi2.X-lo2.X)*(hi2.Y-lo2.Y)*(hi2.Z-lo2.Z) local inter=ox*oy*oz local small=math.min(volI,volJ) if small>0 and inter/small>0.97 and #buried<40 then local victim=p if volJ<volI then victim=p2 end buried[#buried+1]=victim.Name..' in '..(victim==p and p2.Name or p.Name) end end",
      " end end",
      " if not touched then floating[#floating+1]=p.Name end",
      "end",
      "if #floating>0 then issue('high','floating',#floating..' part(s) touch nothing: '..names(floating),'move them until they rest on / overlap a neighbour by 0.05-0.2 studs or lower them to the ground (model_snap_to_ground for the whole model)',math.min(30,6*#floating)) end",
      "if #buried>0 then issue('medium','buried',#buried..' part(s) are mostly inside another part: '..names(buried),'delete the hidden part or shrink it - buried parts waste draw calls and z-fight',math.min(25,5*#buried)) end",
      // slivers and giants
      "local slivers={} local giants={} for _,p in ipairs(parts) do local s=p.Size local m=math.min(s.X,s.Y,s.Z) if m<0.05 then slivers[#slivers+1]=p.Name end if math.max(s.X,s.Y,s.Z)>2048 then giants[#giants+1]=p.Name end end",
      "if #slivers>0 then issue('medium','sliver',#slivers..' part(s) thinner than 0.05: '..names(slivers),'Roblox clamps parts to 0.05 minimum; use 0.1-0.25 for trims and panes',math.min(10,3*#slivers)) end",
      "if #giants>0 then issue('low','oversize',#giants..' part(s) larger than 2048 studs: '..names(giants),'split into tiles',5) end",
      // anchoring
      "local loose={} for _,p in ipairs(parts) do if not p.Anchored then loose[#loose+1]=p.Name end end",
      "if #loose>0 then issue('high','unanchored',#loose..' unanchored part(s): '..names(loose),'static props must be Anchored (model_anchor_fix)',10) end",
      // default look
      "local defaults={} local palette={} local paletteN=0 local plastic=0 for _,p in ipairs(parts) do local c=p.Color local key=math.floor(c.R*7+0.5)..','..math.floor(c.G*7+0.5)..','..math.floor(c.B*7+0.5) if not palette[key] then palette[key]=true paletteN=paletteN+1 end",
      " local grey=math.abs(c.R*255-163)<6 and math.abs(c.G*255-162)<6 and math.abs(c.B*255-165)<6 if p.Material==Enum.Material.Plastic then plastic=plastic+1 if grey then defaults[#defaults+1]=p.Name end end end",
      "if #defaults>0 then local pts=10 if #defaults*2>n then pts=20 end issue('high','unstyled',#defaults..' part(s) still default grey Plastic: '..names(defaults),'give every part a deliberate Color + Material (Wood/WoodPlanks/Slate/Concrete/Metal/Fabric...) - model_paint',pts) end",
      "if plastic==n and n>2 then issue('medium','flat-material','every part is Plastic','mix 2-3 materials so light reads differently on trim vs body',6) end",
      "if paletteN>9 then issue('low','palette-sprawl',paletteN..' distinct colours','limit a prop to <=5 colours plus one accent',6) end",
      // structure
      "if root:IsA('Model') and not root.PrimaryPart then issue('low','no-primary','Model has no PrimaryPart','set PrimaryPart to the base part (model_center_pivot)',4) end",
      "if n==1 and root:IsA('Model') then issue('medium','single-part','a Model with one part has no silhouette','build props from 3+ masses: base, body, top/trim',8) end",
      "if expectSize then local function off(a,b) if b<=0 then return 0 end return math.abs(a-b)/b end local ex=off(size.X,expectSize.X) local ey=off(size.Y,expectSize.Y) local ez=off(size.Z,expectSize.Z) local worst=math.max(ex,ey,ez) if worst>0.25 then issue('high','scale','size '..r2(size.X)..'x'..r2(size.Y)..'x'..r2(size.Z)..' vs expected '..r2(expectSize.X)..'x'..r2(expectSize.Y)..'x'..r2(expectSize.Z)..' ('..math.floor(worst*100)..'% off)','rescale with model_build / resize parts; humanoid is 5 studs tall, a door 7x4, a table 3 high',math.min(20,math.floor(worst*20))) end end",
      "if expectParts and n<expectParts then issue('medium','too-few-parts',n..' parts, expected at least '..expectParts,'add detail masses: trims, legs, bands, caps, posts',8) end",
      "if score<0 then score=0 end local verdict='pass' if score<80 then verdict='fail' end",
      "local mats={} for _,p in ipairs(parts) do local nm=tostring(p.Material):gsub('Enum.Material.','') mats[nm]=(mats[nm] or 0)+1 end",
      "local summary=root:GetFullName()..': '..verdict..' '..score..'/100, '..n..' parts, '..r2(size.X)..'x'..r2(size.Y)..'x'..r2(size.Z)..' studs, '..#issues..' issue(s)'",
      "if verdict=='fail' then summary=summary..' - fix the high ones, then model_check again' else summary=summary..' - take or_screenshot to judge the silhouette' end",
      "return ok({path=root:GetFullName(),score=score,verdict=verdict,parts=n,size=v3(size),min=v3(mn),max=v3(mx),bottom_y=r2(groundY),colours=paletteN,materials=mats,issues=issues},summary)",
    ].join("\n");
  };

  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const C = [
    { name: "model_prefab", description: "Place a hand-proportioned multi-part prop (anchored Model, bottom-centre pivot, PrimaryPart, palette + materials). Use instead of free-handing common props; count + spacing lay a row along local X. Then model_check + or_screenshot.", params: { kind: S("string", true, KINDS.join("|")), position: S("array", true, "[x,y,z] bottom-centre"), name: S("string", false), scale: S("number", false, "default 1"), rotation_y: S("number", false, "degrees"), color: S("string", false, "main (hex/rgb/name)"), color2: S("string", false, "trim"), accent: S("string", false, "glow / handle / awning"), material: S("string", false, "cottage walls"), roof_material: S("string", false), count: S("number", false), spacing: S("number", false, "default width+1"), seed: S("number", false), parent: S("string", false) } },
    { name: "model_check", description: "Geometry critic: floating parts, parts buried inside others, slivers, unanchored, default grey Plastic, flat materials, palette sprawl, no PrimaryPart, size vs expectation. Score 0-100, pass>=80, issues with fixes. Run after every build and fix the high issues.", params: { path: S("string", true), expect_size: S("array", false, "[w,h,d]"), expect_parts: S("number", false, "minimum"), limit: S("number", false, "names per issue (12)") } },
  ];

  function buildModelcraft(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const body = fn(args || {});
      const tailLuau = "\nlocal okRun,resRun=pcall(function()\n" + body + "\nend)\nif okRun then return resRun end\nreturn fail((tostring(resRun):gsub('^.-:%d+:%s*','')))";
      return { code: HEAD + "\n" + tailLuau, lib: HEAD, body: tailLuau };
    } catch (e) {
      return { err: "ERROR building command " + op + ": " + e };
    }
  }

  const origBuild = RobloxScriptSkills.buildLuau;
  RobloxScriptSkills.buildLuau = function (op, args) {
    const extra = buildModelcraft(op, args);
    if (extra) return extra;
    return origBuild(op, args);
  };
  const have = new Set(RobloxScriptSkills.SKILL_COMMANDS.map((c) => c.name));
  for (const c of C) if (!have.has(c.name)) RobloxScriptSkills.SKILL_COMMANDS.push(c);
  RobloxScriptSkills.SKILL_OPS = RobloxScriptSkills.SKILL_COMMANDS.map(function (c) { return c.name; });
  RobloxScriptSkills.MODELCRAFT_COMMANDS = C.map((c) => c.name);
  RobloxScriptSkills.PREFAB_KINDS = KINDS.slice();
})();
