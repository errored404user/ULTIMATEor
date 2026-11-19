// SPDX-License-Identifier: GPL-3.0-or-later
// TotalScript "Modelcraft" skill pack (1.70.0): the two commands that turn the
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
    "local function uniqueChildName(parent,base) base=tostring(base or 'Model'):gsub('%.','_') if base=='' then base='Model' end local candidate,suffix=base,2 while parent and parent:FindFirstChild(candidate) do candidate=base..'_'..suffix suffix=suffix+1 end return candidate end",
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
      "if count>1 then holder=Instance.new('Model') holder.Name=uniqueChildName(parentI,baseName..'s') holder.Parent=parentI end",
      "for i=1,count do",
      PF.replace(/\n/g, "\n "),
      " local primary=Pf[kind]() M.Name=baseName if count>1 then M.Name=baseName..i else M.Name=uniqueChildName(parentI,baseName) end",
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
      "return ok({path=(holder and holder:GetFullName()) or first.path,kind=kind,count=count,parts=total,size=first.size,models=out,scale=SCALE},kind..' x'..count..' placed ('..total..' parts, '..first.size[1]..'x'..first.size[2]..'x'..first.size[3]..' studs). Run model_check on it, then total_screenshot.')",
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
      "local allowUnanchored=" + bb(a.allow_unanchored, false) + " local loose={} for _,p in ipairs(parts) do if not p.Anchored then loose[#loose+1]=p.Name end end",
      "if #loose>0 and not allowUnanchored then issue('high','unanchored',#loose..' unanchored part(s): '..names(loose),'static props must be Anchored (model_anchor_fix); set allow_unanchored=true only for an intentional physics rig',10) end",
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
      // 1.98.0 - hierarchy / pivot / collision / budget (the things a Studio builder checks before shipping a prop)
      "local DEFAULT_NAMES={Part=true,MeshPart=true,WedgePart=true,CornerWedgePart=true,TrussPart=true,Union=true,UnionOperation=true,Model=true,SpawnLocation=true}",
      "local unnamed={} for _,p in ipairs(parts) do if DEFAULT_NAMES[p.Name] then unnamed[#unnamed+1]=p.Name end end for _,d in ipairs(root:GetDescendants()) do if d:IsA('Model') and DEFAULT_NAMES[d.Name] then unnamed[#unnamed+1]=d.Name end end",
      "if #unnamed>0 then issue('medium','default-names',#unnamed..' instance(s) still carry a class name ('..names(unnamed)..')','name every part by its role (Trunk, Seat, LegFL, RoofL...) so scripts, selections and later edits can find them',math.min(10,2*#unnamed)) end",
      "local maxParts=" + nn(a.max_parts, 400) + " if n>maxParts then issue('medium','part-budget',n..' parts (budget '..maxParts..')','merge repeated trims, use one Texture/MeshPart instead of many slivers, or split into reusable sub-models (model_prefab count=)',8) end",
      "if root:IsA('Model') and root.PrimaryPart then local pv=root:GetPivot().Position local cx,cz=(mn.X+mx.X)/2,(mn.Z+mx.Z)/2 local high=pv.Y>groundY+size.Y*0.25+0.5 local outside=pv.X<mn.X-0.5 or pv.X>mx.X+0.5 or pv.Z<mn.Z-0.5 or pv.Z>mx.Z+0.5 if high or outside then issue('low','pivot-off',string.format('pivot at (%s, %s, %s) is %s the model (bottom-centre is (%s, %s, %s))',r2(pv.X),r2(pv.Y),r2(pv.Z),outside and 'outside' or 'high in',r2(cx),r2(groundY),r2(cz)),'put the pivot at the bottom-centre (model_center_pivot) so PivotTo / placement lands on the ground and rotation turns around the base',4) end end",
      "local clutter={} for i=1,n do local lo,p=boxes[i][1],boxes[i][3] local sz=p.Size if p.CanCollide and math.max(sz.X,sz.Y,sz.Z)<0.6 and lo.Y>groundY+tol then clutter[#clutter+1]=p.Name end end",
      "if #clutter>=4 then issue('low','collide-clutter',#clutter..' tiny decorative part(s) still collide: '..names(clutter),'set CanCollide=false on trims, bolts, leaves and other sub-0.6-stud detail - fewer physics contacts and nothing for players to snag on',3) end",
      "if score<0 then score=0 end local verdict='pass' if score<80 then verdict='fail' end",
      "local mats={} for _,p in ipairs(parts) do local nm=tostring(p.Material):gsub('Enum.Material.','') mats[nm]=(mats[nm] or 0)+1 end",
      "local summary=root:GetFullName()..': '..verdict..' '..score..'/100, '..n..' parts, '..r2(size.X)..'x'..r2(size.Y)..'x'..r2(size.Z)..' studs, '..#issues..' issue(s)'",
      "if verdict=='fail' then summary=summary..' - fix the high ones, then model_check again' else summary=summary..' - take total_screenshot to judge the silhouette' end",
      "return ok({path=root:GetFullName(),score=score,verdict=verdict,parts=n,size=v3(size),min=v3(mn),max=v3(mx),bottom_y=r2(groundY),colours=paletteN,materials=mats,issues=issues},summary)",
    ].join("\n");
  };

  const MODEL_CREATE_ALIASES = {
    house: ["structure_build", "house"], hut: ["structure_build", "house"], cabin: ["structure_build", "house"],
    castle: ["structure_build", "castle_wall"], fortress: ["structure_build", "castle_wall"], wall: ["structure_build", "castle_wall"],
    watchtower: ["structure_build", "watchtower"], stairs: ["structure_build", "staircase"], spiral_stairs: ["structure_build", "spiral_staircase"],
    cottage: ["model_prefab", "cottage"], tree: ["model_prefab", "tree"], oak: ["model_prefab", "tree"], oak_tree: ["model_prefab", "tree"], pine: ["model_prefab", "pine"],
    bush: ["model_prefab", "bush"], shrub: ["model_prefab", "bush"], boulder: ["model_prefab", "rock"], stone: ["model_prefab", "rock"],
    table: ["model_prefab", "table"], chair: ["model_prefab", "chair"], bench: ["model_prefab", "bench"], crate: ["model_prefab", "crate"], box: ["model_prefab", "crate"],
    barrel: ["model_prefab", "barrel"], lamp: ["model_prefab", "lamp_post"], streetlight: ["model_prefab", "lamp_post"], lamp_post: ["model_prefab", "lamp_post"],
    torch: ["model_prefab", "torch"], lantern: ["model_prefab", "torch"], door: ["model_prefab", "door"], window: ["model_prefab", "window"],
    pillar: ["model_prefab", "pillar"], column: ["model_prefab", "pillar"], arch: ["model_prefab", "arch"], archway: ["structure_build", "archway"],
    well: ["model_prefab", "well"], campfire: ["model_prefab", "campfire"], sign: ["model_prefab", "sign"], bed: ["model_prefab", "bed"],
    bookshelf: ["model_prefab", "bookshelf"], bookcase: ["model_prefab", "bookshelf"], chest: ["model_prefab", "chest"], market: ["model_prefab", "market_stall"],
    couch: ["furniture_build", "sofa"], sofa: ["furniture_build", "sofa"], wardrobe: ["furniture_build", "wardrobe"], desk: ["furniture_build", "desk"],
    fridge: ["furniture_build", "fridge"], refrigerator: ["furniture_build", "fridge"], oven: ["furniture_build", "oven"], sink: ["furniture_build", "sink"],
    bathtub: ["furniture_build", "bathtub"], tub: ["furniture_build", "bathtub"], toilet: ["furniture_build", "toilet"], piano: ["furniture_build", "piano"],
    lampstand: ["furniture_build", "floor_lamp"], robot: ["generic", "robot"], mech: ["generic", "robot"], android: ["generic", "robot"], golem: ["generic", "robot"],
    dragon: ["generic", "dragon"], dinosaur: ["generic", "dragon"], creature: ["generic", "dragon"], monster: ["generic", "dragon"],
    spaceship: ["generic", "spaceship"], starship: ["generic", "spaceship"], spacecraft: ["generic", "spaceship"], rocket: ["generic", "spaceship"],
    portal: ["generic", "portal"], gateway: ["generic", "portal"], rift: ["generic", "portal"], crystal: ["generic", "crystal"], relic: ["generic", "crystal"], artifact: ["generic", "crystal"],
  };
  const MODEL_TEXT_ALIASES = [
    ["space ship", "spaceship"], ["star ship", "starship"], ["spacecraft", "spacecraft"], ["lamp post", "lamp_post"], ["street light", "streetlight"],
    ["book shelf", "bookshelf"], ["book case", "bookcase"], ["spiral staircase", "spiral_staircase"], ["spiral stairs", "spiral_stairs"],
    ["castle wall", "castle_wall"], ["gate house", "gatehouse"], ["market stall", "market"], ["floor lamp", "floor_lamp"], ["bar stool", "bar_stool"],
    ["great sword", "greatsword"], ["battle axe", "battleaxe"], ["cross bow", "crossbow"], ["sci fi", "scifi"], ["sci-fi", "scifi"],
  ];
  const MODEL_COLOR_WORDS = { red: "#c83228", crimson: "#aa1e32", orange: "#e68228", yellow: "#ebd246", gold: "#dcaa3c", green: "#46823c", blue: "#326ec8", navy: "#243260", purple: "#7846aa", violet: "#7850c8", pink: "#e678aa", cyan: "#3cbed2", teal: "#288c8c", white: "#f0f0ec", black: "#202024", brown: "#704c30", wood: "#8c623c", stone: "#787670", silver: "#bec0c6" };
  function modelToken(value) { return String(value == null ? "" : value).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
  function modelPhraseIndex(text, phrase) {
    const words = modelToken(phrase).replace(/_/g, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return -1;
    const source = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+");
    const m = new RegExp("(^|[^a-z0-9])(" + source + ")(?:s)?(?=$|[^a-z0-9])", "i").exec(text);
    return m ? m.index + m[1].length : -1;
  }
  function modelRecipe(args) {
    const kit = RobloxScriptSkills.MODELKIT_ENUMS || {};
    const normalize = modelToken;
    const direct = (raw) => {
      const k = normalize(raw);
      if (!k) return null;
      if (MODEL_CREATE_ALIASES[k]) return { builder: MODEL_CREATE_ALIASES[k][0], kind: MODEL_CREATE_ALIASES[k][1], matched: k };
      if ((kit.STRUCTURES || []).includes(k)) return { builder: "structure_build", kind: k, matched: k };
      if ((kit.VEHICLES || []).includes(k)) return { builder: "vehicle_build", kind: k, matched: k };
      if ((kit.WEAPONS || []).includes(k)) return { builder: "weapon_build", kind: k, matched: k };
      if ((kit.FURNITURE || []).includes(k)) return { builder: "furniture_build", kind: k, matched: k };
      if ((kit.SHAPES || []).includes(k)) return { builder: "mesh_shape_create", kind: k, matched: k };
      if ((RobloxScriptSkills.PREFAB_KINDS || KINDS).includes(k)) return { builder: "model_prefab", kind: k, matched: k };
      return null;
    };
    const forcedBuilder = normalize(args.builder);
    if (forcedBuilder && ["structure_build", "vehicle_build", "weapon_build", "furniture_build", "mesh_shape_create", "model_prefab"].includes(forcedBuilder)) {
      const hinted = direct(args.kind || args.type || args.asset_kind);
      if (hinted && hinted.builder === forcedBuilder) return hinted;
      const defaults = { structure_build: "house", vehicle_build: "car", weapon_build: "sword", furniture_build: "sofa", mesh_shape_create: "crystal", model_prefab: "crate" };
      return { builder: forcedBuilder, kind: (args.kind && normalize(args.kind)) || defaults[forcedBuilder], matched: "explicit builder" };
    }
    const explicit = direct(args.kind || args.type || args.asset_kind);
    if (explicit) return explicit;
    let text = [args.request, args.prompt, args.concept, args.description, args.task, args.name, args.kind].filter((x) => typeof x === "string").join(" ").toLowerCase();
    for (const [phrase, replacement] of MODEL_TEXT_ALIASES) text = text.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), replacement.replace(/_/g, " "));
    const candidates = [];
    const add = (phrase, route) => { const at = modelPhraseIndex(text, phrase); if (at >= 0) candidates.push({ at, length: phrase.length, ...route, matched: phrase }); };
    for (const [kind, route] of Object.entries(MODEL_CREATE_ALIASES)) add(kind.replace(/_/g, " "), { builder: route[0], kind: route[1] });
    for (const [builder, kinds] of [["structure_build", kit.STRUCTURES || []], ["vehicle_build", kit.VEHICLES || []], ["weapon_build", kit.WEAPONS || []], ["furniture_build", kit.FURNITURE || []], ["mesh_shape_create", kit.SHAPES || []], ["model_prefab", RobloxScriptSkills.PREFAB_KINDS || KINDS]]) {
      for (const kind of kinds) add(kind.replace(/_/g, " "), { builder, kind });
    }
    for (const [phrase, kind] of [["spaceship", "spaceship"], ["starship", "spaceship"], ["spacecraft", "spaceship"], ["rocket", "spaceship"], ["robot", "robot"], ["mech", "robot"], ["android", "robot"], ["golem", "robot"], ["dragon", "dragon"], ["dinosaur", "dragon"], ["creature", "dragon"], ["monster", "dragon"], ["portal", "portal"], ["gateway", "portal"], ["rift", "portal"], ["crystal", "crystal"], ["relic", "crystal"], ["artifact", "crystal"]]) add(phrase, { builder: "generic", kind });
    const nonModifierCandidates = candidates.filter((c) => c.kind !== "crystal");
    const pool = nonModifierCandidates.length ? nonModifierCandidates : candidates;
    pool.sort((a, b) => a.at - b.at || b.length - a.length);
    if (pool.length) return pool[0];
    return { builder: "generic", kind: "hero_prop", matched: "safe fallback" };
  }
  function modelStyleFor(text, builder, explicit) {
    const t = String(explicit || "").toLowerCase() + " " + text;
    const find = (re) => re.test(t);
    if (builder === "structure_build") {
      if (find(/\b(scifi|sci[ -]?fi|cyberpunk|futuristic|space)\b/)) return "scifi";
      if (find(/\b(desert|sandstone|dune)\b/)) return "desert";
      if (find(/\b(industrial|factory|steampunk)\b/)) return "industrial";
      if (find(/\b(stone|ruin|dungeon)\b/)) return "stone";
      if (find(/\b(rustic|wooden|village)\b/)) return "rustic";
      if (find(/\b(fantasy|magic|enchanted)\b/)) return "fantasy";
      if (find(/\b(modern|minimal)\b/)) return "modern";
      if (find(/\b(medieval|castle|knight)\b/)) return "medieval";
      return "";
    }
    if (builder === "furniture_build") {
      if (find(/\b(scifi|sci[ -]?fi|cyberpunk|futuristic)\b/)) return "scifi";
      if (find(/\b(royal|king|queen|palace|regal)\b/)) return "royal";
      if (find(/\b(cozy|soft|cottagecore)\b/)) return "cozy";
      if (find(/\b(rustic|wooden|vintage)\b/)) return "rustic";
      if (find(/\b(modern|minimal)\b/)) return "modern";
      return "";
    }
    if (builder === "weapon_build") {
      if (find(/\b(crystal|glowing|enchanted|magic|magical)\b/)) return "crystal";
      if (find(/\b(scifi|sci[ -]?fi|cyberpunk|futuristic|laser)\b/)) return "scifi";
      if (find(/\b(wooden|primitive)\b/)) return "wooden";
      if (find(/\b(gold|golden|royal)\b/)) return "gold";
      if (find(/\b(dark|shadow|obsidian|gothic)\b/)) return "dark";
      if (find(/\biron\b/)) return "iron";
      return "";
    }
    return "";
  }
  function genericModelParts(kind, text, args) {
    const themeText = String(args.style || "") + " " + text;
    const sciFiPalette = { base: [32, 43, 62], body: [74, 91, 115], trim: [154, 174, 190], glow: [50, 224, 240], material: "Metal" };
    const fantasyPalette = { base: [56, 49, 88], body: [112, 79, 157], trim: [210, 179, 107], glow: [105, 229, 246], material: "Slate" };
    const crystalPalette = { base: [34, 38, 76], body: [82, 91, 171], trim: [174, 121, 230], glow: [84, 229, 255], material: "Slate" };
    let palette = kind === "spaceship" || kind === "robot" ? sciFiPalette : kind === "dragon" || kind === "portal" ? fantasyPalette : kind === "crystal" ? crystalPalette : { base: [86, 70, 54], body: [148, 112, 72], trim: [206, 169, 91], glow: [255, 184, 70], material: "Wood" };
    if (/\b(scifi|sci[ -]?fi|cyberpunk|futuristic|space)\b/i.test(themeText)) palette = sciFiPalette;
    else if (/\b(crystal|gem|ice|arcane)\b/i.test(themeText)) palette = crystalPalette;
    else if (/\b(fantasy|magic|enchanted)\b/i.test(themeText)) palette = fantasyPalette;
    else if (/\b(horror|dark|gothic|shadow)\b/i.test(themeText)) palette = { base: [35, 34, 40], body: [79, 43, 50], trim: [128, 79, 74], glow: [211, 43, 56], material: "Slate" };
    else if (/\b(desert|sand|dune)\b/i.test(themeText)) palette = { base: [112, 83, 52], body: [194, 158, 100], trim: [226, 202, 150], glow: [219, 104, 56], material: "Sandstone" };
    else if (/\b(modern|minimal|industrial)\b/i.test(themeText)) palette = { base: [54, 63, 72], body: [116, 128, 137], trim: [190, 197, 202], glow: [48, 190, 205], material: "Metal" };
    else if (/\b(royal|gold|golden)\b/i.test(themeText)) palette = { base: [55, 39, 28], body: [142, 101, 45], trim: [230, 187, 82], glow: [255, 224, 140], material: "Metal" };
    else if (/\b(rustic|wooden|medieval)\b/i.test(themeText)) palette = { base: [86, 70, 54], body: [148, 112, 72], trim: [206, 169, 91], glow: [255, 184, 70], material: "Wood" };
    const customMain = parseColor(args.color), customTrim = parseColor(args.color2), customAccent = parseColor(args.accent);
    const rgb255 = (c, fallback) => !c ? fallback : c.map((x) => Math.round(Math.max(0, Math.min(255, Math.max(...c) <= 1 ? x * 255 : x))));
    if (customMain) palette.body = rgb255(customMain, palette.body);
    if (customTrim) palette.trim = rgb255(customTrim, palette.trim);
    if (customAccent) palette.glow = rgb255(customAccent, palette.glow);
    const shape = (name, size, position, color, material = palette.material, form = "Block", collidable = true) => ({ name, size, position, color, material, shape: form, collidable });
    let parts;
    if (kind === "spaceship") parts = [
      shape("Keel", [3.2, 1, 9], [0, 1.5, 0], palette.body), shape("Bow", [3.2, 1.5, 3.2], [0, 1.5, -5.5], palette.trim, "Metal", "Wedge"),
      shape("Canopy", [1.8, 1.2, 2.5], [0, 2.5, -1.6], palette.glow, "Glass", "Ball", false),
      shape("WingL", [4.4, 0.55, 2.2], [-3, 1.45, 0.4], palette.trim, "Metal", "Wedge"), shape("WingR", [4.4, 0.55, 2.2], [3, 1.45, 0.4], palette.trim, "Metal", "Wedge"),
      shape("EngineL", [1.1, 1, 2.4], [-1, 1.3, 4.1], palette.base, "Metal", "Cylinder"), shape("EngineR", [1.1, 1, 2.4], [1, 1.3, 4.1], palette.base, "Metal", "Cylinder"),
      shape("EngineGlowL", [0.45, 0.45, 0.2], [-1, 1.3, 5.35], palette.glow, "Neon", "Ball", false), shape("EngineGlowR", [0.45, 0.45, 0.2], [1, 1.3, 5.35], palette.glow, "Neon", "Ball", false),
      shape("TailFin", [0.8, 1.8, 0.5], [0, 2.4, 3.8], palette.trim, "Metal", "Wedge"),
    ];
    else if (kind === "robot") parts = [
      shape("FootL", [1.1, 0.6, 1.5], [-0.8, 0.3, -0.2], palette.base), shape("FootR", [1.1, 0.6, 1.5], [0.8, 0.3, -0.2], palette.base),
      shape("LegL", [0.75, 1.2, 0.75], [-0.8, 1.1, -0.2], palette.trim, "Metal"), shape("LegR", [0.75, 1.2, 0.75], [0.8, 1.1, -0.2], palette.trim, "Metal"),
      shape("Torso", [2.2, 1.7, 1.2], [0, 2.6, 0], palette.body, "Metal"), shape("ArmL", [0.65, 1.5, 0.75], [-1.45, 2.45, 0], palette.base, "Metal"), shape("ArmR", [0.65, 1.5, 0.75], [1.45, 2.45, 0], palette.base, "Metal"),
      shape("ShoulderL", [0.9, 0.8, 1.35], [-1.25, 3.15, 0], palette.trim, "Metal"), shape("ShoulderR", [0.9, 0.8, 1.35], [1.25, 3.15, 0], palette.trim, "Metal"),
      shape("Head", [1.3, 1.15, 1.15], [0, 4.0, 0], palette.body, "Metal"), shape("Visor", [0.9, 0.25, 0.16], [0, 4.0, -0.5], palette.glow, "Neon", "Block", false),
    ];
    else if (kind === "dragon") parts = [
      shape("Body", [3, 1.9, 4], [0, 2.4, 0], palette.body, "Slate", "Ball"), shape("Neck", [1.4, 1.3, 1.6], [0, 2.8, -2], palette.body, "Slate"),
      shape("Head", [1.6, 1.2, 1.5], [0, 3.1, -2.9], palette.body, "Slate", "Ball"), shape("Muzzle", [1.1, 0.5, 1], [0, 2.8, -3.95], palette.trim, "Slate", "Wedge"),
      shape("TailBase", [1.4, 1.1, 1.7], [0, 2, 2.5], palette.body, "Slate", "Wedge"), shape("TailTip", [0.9, 0.7, 1.7], [0, 1.8, 3.95], palette.trim, "Slate", "Wedge"),
      shape("LegFL", [0.65, 1.25, 0.7], [-1, 0.95, -1.1], palette.base, "Slate"), shape("LegFR", [0.65, 1.25, 0.7], [1, 0.95, -1.1], palette.base, "Slate"),
      shape("LegBL", [0.65, 1.25, 0.7], [-1, 0.95, 1.1], palette.base, "Slate"), shape("LegBR", [0.65, 1.25, 0.7], [1, 0.95, 1.1], palette.base, "Slate"),
      shape("WingL", [2.4, 0.2, 2.8], [-2.2, 2.9, 0.5], palette.trim, "Slate", "Wedge", false), shape("WingR", [2.4, 0.2, 2.8], [2.2, 2.9, 0.5], palette.trim, "Slate", "Wedge", false),
    ];
    else if (kind === "portal") parts = [
      shape("Threshold", [6, 0.6, 1.2], [0, 0.3, 0], palette.base, "Slate"), shape("PillarL", [1, 6, 1], [-2.5, 3.3, 0], palette.body, "Slate"),
      shape("PillarR", [1, 6, 1], [2.5, 3.3, 0], palette.body, "Slate"), shape("Header", [5.8, 1, 1], [0, 6.5, 0], palette.trim, "Metal"),
      shape("PortalField", [4.1, 5.4, 0.16], [0, 3.4, 0], palette.glow, "Neon", "Block", false),
    ];
    else parts = [
      shape("Plinth", [4, 0.6, 4], [0, 0.3, 0], palette.base, "Slate"), shape("Core", [2.6, 2.5, 2.6], [0, 1.95, 0], palette.body, palette.material),
      shape("LowerBand", [3, 0.35, 3], [0, 3.2, 0], palette.trim, "Metal"), shape("Crown", [1.8, 0.9, 1.8], [0, 3.8, 0], palette.body, "Metal", kind === "crystal" ? "Wedge" : "Block"),
      shape("Accent", [0.8, 0.8, 0.8], [0, 4.5, 0], palette.glow, "Neon", kind === "crystal" ? "Wedge" : "Ball", false),
      shape("SideL", [0.55, 1.5, 0.55], [-1.5, 1.5, 0], palette.trim, "Metal"), shape("SideR", [0.55, 1.5, 0.55], [1.5, 1.5, 0], palette.trim, "Metal"),
    ];
    const scale = Math.max(0.1, Math.min(10, Number(args.scale) || 1));
    const rawSize = Array.isArray(args.size) && args.size.length >= 3 ? args.size.slice(0, 3).map(Number) : [Number(args.width), Number(args.height), Number(args.depth)];
    const ext = [0, 1, 2].map((axis) => Math.max(...parts.map((p) => p.position[axis] + p.size[axis] / 2)) - Math.min(...parts.map((p) => p.position[axis] - p.size[axis] / 2)));
    const factors = rawSize.map((n, i) => Number.isFinite(n) && n > 0 ? Math.max(0.1, Math.min(10, n / ext[i])) : scale);
    return parts.map((p) => ({ ...p, size: p.size.map((n, i) => Math.max(0.1, n * factors[i])), position: p.position.map((n, i) => n * factors[i]) }));
  }
  function modelCreateBuild(args) {
    const request = [args.request, args.prompt, args.concept, args.description, args.task, args.name, args.kind].find((x) => typeof x === "string" && x.trim()) || "";
    const text = String(request).slice(0, 2000).toLowerCase();
    const recipe = modelRecipe(args);
    const detailLevelRaw = String(args.detail_level || args.quality || "hero").toLowerCase();
    const detailLevel = ["standard", "hero", "ultra"].includes(detailLevelRaw) ? detailLevelRaw : "hero";
    const seedText = text + "|" + recipe.builder + "|" + recipe.kind;
    let hash = 2166136261; for (let i = 0; i < seedText.length; i++) hash = Math.imul(hash ^ seedText.charCodeAt(i), 16777619);
    const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : ((hash >>> 0) % 2147483646) + 1;
    const style = modelStyleFor(text, recipe.builder, args.style);
    const buildArgs = Object.assign({}, args);
    for (const k of ["request", "prompt", "concept", "description", "task", "builder", "category", "detail_level", "quality", "detail_ops", "expect_size"]) delete buildArgs[k];
    buildArgs.position = args.position || [0, 0, 0]; buildArgs.name = args.name || recipe.kind.replace(/(^|_)([a-z])/g, (m, s, c) => c.toUpperCase()); buildArgs.seed = seed;
    if (recipe.builder === "structure_build" || recipe.builder === "vehicle_build" || recipe.builder === "weapon_build" || recipe.builder === "furniture_build") buildArgs.kind = recipe.kind;
    else if (recipe.builder === "mesh_shape_create") buildArgs.shape = recipe.kind;
    else if (recipe.builder === "model_prefab") buildArgs.kind = recipe.kind;
    if (style) buildArgs.style = style;
    if (!args.color) {
      const colorHit = Object.entries(MODEL_COLOR_WORDS).find(([word]) => modelPhraseIndex(text, word) >= 0);
      if (colorHit) buildArgs.color = colorHit[1];
    }
    let dynamic = false;
    if (recipe.builder === "weapon_build") { buildArgs.as_tool = args.as_tool === true; dynamic = buildArgs.as_tool; }
    if (recipe.builder === "vehicle_build") { buildArgs.drivable = args.drivable === true || /\b(drivable|driveable|working vehicle|working car|can drive)\b/.test(text); dynamic = buildArgs.drivable; }
    const rawScale = Number(args.scale);
    const scaleFactor = Number.isFinite(rawScale) && rawScale > 0 ? Math.max(0.1, Math.min(10, rawScale)) : 1;
    const rawRotation = Number(args.rotation_y ?? args.rotation);
    const rotationY = Number.isFinite(rawRotation) ? Math.max(-3600, Math.min(3600, rawRotation)) : 0;
    if (recipe.builder === "model_prefab") buildArgs.rotation_y = rotationY;
    else if (recipe.builder !== "generic") buildArgs.rotation = rotationY;
    const applyModelScale = scaleFactor !== 1 && ["structure_build", "vehicle_build", "weapon_build", "furniture_build"].includes(recipe.builder);
    let build;
    if (recipe.builder === "generic") {
      const parts = genericModelParts(recipe.kind, text, buildArgs);
      const json = JSON.stringify(parts);
      if (json.includes("]==]")) throw new Error("generic recipe data contains an invalid delimiter");
      const parent = args.parent || "";
      const code = [
        "local __record=wp('model_create') local __spec=HttpService:JSONDecode([==[" + json + "]==])",
        "local __parent=" + (parent ? "need(" + q(parent) + ",'parent')" : "workspace") + " local __model=Instance.new('Model') __model.Name=uniqueChildName(__parent," + q(buildArgs.name) + ")",
        "local __made={} for _,s in ipairs(__spec) do local p if s.shape=='Wedge' then p=Instance.new('WedgePart') else p=Instance.new('Part') if s.shape=='Ball' then p.Shape=Enum.PartType.Ball elseif s.shape=='Cylinder' then p.Shape=Enum.PartType.Cylinder end end",
        "p.Name=s.name p.Size=Vector3.new(s.size[1],s.size[2],s.size[3]) p.CFrame=CFrame.new(s.position[1],s.position[2],s.position[3]) p.Anchored=true p.CanCollide=s.collidable~=false p.Color=Color3.fromRGB(s.color[1],s.color[2],s.color[3]) local okM,mt=pcall(function() return Enum.Material[s.material] end) p.Material=okM and mt or Enum.Material.SmoothPlastic p.TopSurface=Enum.SurfaceType.Smooth p.BottomSurface=Enum.SurfaceType.Smooth p.Parent=__model __made[#__made+1]=p end",
        "__model.PrimaryPart=__made[1] local __cf,__size=__model:GetBoundingBox() local __foot=CFrame.new(__cf.Position-Vector3.new(0,__size.Y/2,0)) __model.PrimaryPart.PivotOffset=__model.PrimaryPart.CFrame:ToObjectSpace(__foot) __model.WorldPivot=__foot __model:PivotTo(CFrame.new(" + vec(buildArgs.position, [0, 0, 0]) + ")*CFrame.Angles(0,math.rad(" + rotationY + "),0)) __model.Parent=__parent __model:SetAttribute('TotalScriptRecipe'," + q(recipe.kind) + ") wpDone(__record)",
        "return ok({path=__model:GetFullName(),parts=#__made,size=v3(__size),recipe=" + q(recipe.kind) + "},'built '.." + q(recipe.kind.replace(/_/g, " ")) + "..' model with '..#__made..' named parts')",
      ].join("\n");
      build = { lib: HEAD, body: code };
    } else {
      build = RobloxScriptSkills.buildLuau(recipe.builder, buildArgs);
      if (!build || build.err || typeof build.lib !== "string" || typeof build.body !== "string") throw new Error(build && build.err || "no builder is available for " + recipe.builder);
    }
    const checkArgs = { path: "__TOTALSCRIPT_MODEL_PATH__", max_parts: 400, allow_unanchored: dynamic };
    if (Array.isArray(args.expect_size)) checkArgs.expect_size = args.expect_size;
    const check = RobloxScriptSkills.buildLuau("model_check", checkArgs);
    if (!check || check.err || typeof check.body !== "string") throw new Error(check && check.err || "model_check is unavailable");
    const detailOps = Array.isArray(args.detail_ops) ? args.detail_ops : detailLevel === "standard" ? [] : recipe.builder === "structure_build" ? (detailLevel === "ultra" ? ["trim", "rivets"] : ["trim"]) : recipe.builder === "furniture_build" ? (detailLevel === "ultra" ? ["bevel", "trim"] : ["bevel"]) : recipe.builder === "vehicle_build" && !dynamic ? (detailLevel === "ultra" ? ["rivets", "trim"] : ["rivets"]) : [];
    let detail = null;
    if (detailOps.length && !dynamic) {
      detail = RobloxScriptSkills.buildLuau("model_detail", { path: "__TOTALSCRIPT_MODEL_PATH__", ops: detailOps, budget: detailLevel === "ultra" ? 160 : 90, seed });
      if (!detail || detail.err || typeof detail.body !== "string") throw new Error(detail && detail.err || "model_detail is unavailable");
    }
    const detailBody = detail ? detail.body.replace('return MK.run("model_detail", __a)', '__a.path = __modelPath\nreturn MK.run("model_detail", __a)') : "";
    const checkBody = check.body.replace('local root=need("__TOTALSCRIPT_MODEL_PATH__",\'model\')', 'local root=need(__modelPath,\'model\')');
    if (checkBody === check.body) throw new Error("model_check path binding could not be composed safely");
    const libraries = [HEAD, build.lib, detail && detail.lib, check.lib].filter((lib, i, all) => typeof lib === "string" && lib && all.indexOf(lib) === i);
    if (libraries.length < 1) throw new Error("model_create could not assemble its local builders");
    const lib = libraries.join("\n");
    const scaleCode = applyModelScale
      ? buildArgs.as_tool
        ? " local __scaled=resolve(__modelPath) if not __scaled or not __scaled:IsA('Tool') then return fail('uniform scale requested but the builder returned no Tool') end local __handle=__scaled:FindFirstChild('Handle') if not __handle or not __handle:IsA('BasePart') then __scaled:Destroy() return fail('uniform scale requested but the Tool has no BasePart Handle') end local __scaleModel=Instance.new('Model') __scaleModel.Name='__TotalScriptScaleWrapper' __scaleModel.Parent=__scaled for _,__child in ipairs(__scaled:GetChildren()) do if __child~=__scaleModel then __child.Parent=__scaleModel end end __scaleModel.PrimaryPart=__handle local __scaleOk,__scaleErr=pcall(function() __scaleModel:ScaleTo(" + scaleFactor + ") local _,__scaledSize=__scaleModel:GetBoundingBox() __buildData.bounds={r2(__scaledSize.X),r2(__scaledSize.Y),r2(__scaledSize.Z)} end) for _,__child in ipairs(__scaleModel:GetChildren()) do __child.Parent=__scaled end __scaleModel:Destroy() if not __scaleOk then __scaled:Destroy() return fail('uniform scale failed: '..tostring(__scaleErr)) end __scaled:SetAttribute('TotalScriptScale'," + scaleFactor + ") __buildData.scale_applied=" + scaleFactor
        : " local __scaled=resolve(__modelPath) if not __scaled or not __scaled:IsA('Model') then return fail('uniform scale requested but the builder returned no Model') end local __scaleOk,__scaleErr=pcall(function() __scaled:ScaleTo(" + scaleFactor + ") local _,__scaledSize=__scaled:GetBoundingBox() __buildData.bounds={r2(__scaledSize.X),r2(__scaledSize.Y),r2(__scaledSize.Z)} end) if not __scaleOk then __scaled:Destroy() return fail('uniform scale failed: '..tostring(__scaleErr)) end __scaled:SetAttribute('TotalScriptScale'," + scaleFactor + ") __buildData.scale_applied=" + scaleFactor
      : "";
    const body = [
      "local function __buildModel()\n" + build.body + "\nend",
      "local __buildRunOk,__buildRaw=pcall(__buildModel) if not __buildRunOk then return fail(tostring(__buildRaw)) end local __buildOk,__built=pcall(function() return HttpService:JSONDecode(__buildRaw) end)",
      "if not __buildOk or type(__built)~='table' or __built.ok~=true then return __buildRaw end",
      "local __buildData=__built.data or __built local __modelPath=__buildData.path if type(__modelPath)~='string' or __modelPath=='' then return fail('builder succeeded but returned no model path') end" + scaleCode,
      detail ? "local function __detailModel(__modelPath)\n" + detailBody + "\nend local __detailRunOk,__detailRaw=pcall(__detailModel,__modelPath) local __detailParseOk,__details=false,nil if __detailRunOk then __detailParseOk,__details=pcall(function() return HttpService:JSONDecode(__detailRaw) end) end if not __detailParseOk or type(__details)~='table' then __details={ok=false,error=__detailRunOk and 'detail result was not JSON' or tostring(__detailRaw)} end local __detailOK=__detailRunOk and __detailParseOk and __details.ok==true" : "local __details=nil local __detailOK=true",
      "local function __checkModel(__modelPath)\n" + checkBody + "\nend",
      "local __checkRaw=__checkModel(__modelPath) local __checkOk,__quality=pcall(function() return HttpService:JSONDecode(__checkRaw) end) if not __checkOk or type(__quality)~='table' then __quality={ok=false,error='model_check returned invalid JSON'} end",
      detail ? "local __detailRolledBack=false if not __detailOK or not __quality.ok or (__quality.score and __quality.score<80) then local __target=resolve(__modelPath) local __folder=__target and __target:FindFirstChild('Detail') if __folder then __folder:Destroy() __detailRolledBack=true __checkRaw=__checkModel(__modelPath) local __retryOk,__retry=pcall(function() return HttpService:JSONDecode(__checkRaw) end) if __retryOk and type(__retry)=='table' then __quality=__retry else __quality={ok=false,error='model_check retry failed after detail rollback'} end end end" : "local __detailRolledBack=false",
      "local __route={builder=" + q(recipe.builder) + ",kind=" + q(recipe.kind) + ",matched=" + q(recipe.matched) + ",style=" + q(style || "project/default") + ",detail_level=" + q(detailLevel) + ",scale=" + scaleFactor + ",seed=" + seed + "}",
      "local __scoreText=__quality.ok and (tostring(__quality.score)..'/100 '..tostring(__quality.verdict)) or 'score unavailable' local __text='Built '..tostring(__modelPath)..' with '..tostring(__route.builder)..' ('..tostring(__route.kind)..'); model_check '..__scoreText..(__detailRolledBack and '; optional details removed to preserve the score' or '')..'. Run total_screenshot to review the silhouette.'",
      "return HttpService:JSONEncode({ok=true,data={path=__modelPath,recipe=__route,builder=__buildData,detail=__details,detail_rolled_back=__detailRolledBack,quality=__quality},text=__text})",
    ].join("\n");
    return { lib, body };
  }
  B.model_create = (a) => {
    if (!RobloxScriptSkills.MODELKIT_LIB) throw new Error("the model kit is not loaded; update TotalScript and reload the page");
    return modelCreateBuild(a || {});
  };

  const S = (t, req, desc) => ({ type: t, req: !!req, desc });
  const C = [
    { name: "model_create", description: "One-call cross-provider model builder. Forward the user's original request (or kind); it deterministically selects a typed recipe, applies proportion, palette, requested yaw and uniform scale, adds safe hero detail where appropriate, and runs model_check before returning the path and score. No hand-authored parts array needed. Static visual models by default.", params: { request: S("string", false, "Original user request; pass it verbatim so the local recipe router can choose the best builder"), kind: S("string", false, "catalog kind, e.g. tower, car, sword, sofa, tree, or an archetype such as dragon / spaceship / portal"), builder: S("string", false, "optional override; normally leave unset"), name: S("string", false), position: S("array", false, "[x,y,z] ground point; defaults to [0,0,0]"), rotation_y: S("number", false, "yaw in degrees; clamped to ±3600"), parent: S("string", false), style: S("string", false, "medieval|fantasy|scifi|rustic|modern|industrial|desert|stone|cozy|royal|crystal|wooden|gold|dark"), size: S("array", false, "[width,height,depth] for the built-in fallback or structure"), scale: S("number", false), width: S("number", false), height: S("number", false), depth: S("number", false), length: S("number", false), floors: S("number", false), roof: S("string", false), drivable: S("boolean", false, "default static; true requests a working vehicle rig"), as_tool: S("boolean", false, "default false; true only for a wearable weapon Tool"), color: S("string", false, "hex or named color"), color2: S("string", false), accent: S("string", false), detail_level: S("string", false, "standard|hero (default)|ultra"), detail_ops: S("array", false, "optional override: trim|rivets|planks|wear|bevel|moss"), seed: S("number", false, "same request + seed rebuilds the same variation"), expect_size: S("array", false, "[width,height,depth] critic target") } },
    { name: "model_prefab", description: "Place a hand-proportioned multi-part prop (anchored Model, bottom-centre pivot, PrimaryPart, palette + materials). Use instead of free-handing common props; count + spacing lay a row along local X. Then model_check + total_screenshot.", params: { kind: S("string", true, KINDS.join("|")), position: S("array", true, "[x,y,z] bottom-centre"), name: S("string", false), scale: S("number", false, "default 1"), rotation_y: S("number", false, "degrees"), color: S("string", false, "main (hex/rgb/name)"), color2: S("string", false, "trim"), accent: S("string", false, "glow / handle / awning"), material: S("string", false, "cottage walls"), roof_material: S("string", false), count: S("number", false), spacing: S("number", false, "default width+1"), seed: S("number", false), parent: S("string", false) } },
    { name: "model_check", description: "Geometry critic: floating / buried parts, slivers, unanchored, palette, pivot, scale, default names, collisions and part budget. Score 0-100; pass>=80. Use allow_unanchored=true only for intentional physics rigs such as a drivable vehicle; static props must remain anchored. Run after every non-automatic build.", params: { path: S("string", true), expect_size: S("array", false, "[w,h,d]"), expect_parts: S("number", false, "minimum"), max_parts: S("number", false, "part budget (default 400)"), allow_unanchored: S("boolean", false, "true only for intentionally dynamic rigs"), limit: S("number", false, "names per issue (12)") } },
  ];

  function buildModelcraft(op, args) {
    const fn = B[op];
    if (!fn) return null;
    try {
      const generated = fn(args || {});
      if (generated && typeof generated === "object" && typeof generated.lib === "string" && typeof generated.body === "string") {
        return { code: generated.lib + "\n" + generated.body, lib: generated.lib, body: generated.body };
      }
      const body = generated;
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
