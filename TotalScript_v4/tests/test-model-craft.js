// 1.70.0: Modelcraft pack - model_prefab (24 proportioned props) + model_check
// (geometry critic), the PivotOffset fix in model_build / model_center_pivot /
// model_hollow_box, the prompt rewrite and the dead-code removals of the same
// release. Luau is executed for real in tests/roblox_sim.py when python3 + lupa
// are available (the runtime half is skipped - and says so - otherwise).
const fs = require("fs"), vm = require("vm"), cp = require("child_process"), path = require("path");
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) passed++; else { failed++; console.error("FAIL  " + name + (extra ? " :: " + extra : "")); } }

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundle = manifest.content_scripts.find((c) => c.js.includes("src/core/skills/studio_skills.js"));
const files = bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f));
global.window = global;
global.chrome = { runtime: { sendMessage() {}, onMessage: { addListener() {} } }, storage: { local: { get(k, cb) { cb && cb({}); }, set() {} } } };
for (const f of files) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = RobloxScriptSkills;

// ── wiring ──
ok("pack is in every bundle right after studio_ultimate.js", manifest.content_scripts.every((c) => !c.js.includes("src/core/skills/studio_ultimate.js") || c.js[c.js.indexOf("src/core/skills/studio_ultimate.js") + 1] === "src/core/skills/studio_modelcraft.js"));
ok("codecraft.html loads the pack", fs.readFileSync("codecraft.html", "utf8").includes('src="src/core/skills/studio_modelcraft.js"'));
ok("model_create + model_prefab + model_check are visible, registered once, and included in SKILL_OPS", ["model_create", "model_prefab", "model_check"].every((n) => S.SKILL_COMMANDS.filter((c) => c.name === n && !c.hidden).length === 1 && S.SKILL_OPS.includes(n)) && S.MODELCRAFT_COMMANDS.includes("model_create"));
ok("24 prefab kinds exported", Array.isArray(S.PREFAB_KINDS) && S.PREFAB_KINDS.length === 24 && ["tree", "cottage", "lamp_post", "market_stall", "fence"].every((k) => S.PREFAB_KINDS.includes(k)));
ok("kind param lists every kind for the model", S.SKILL_COMMANDS.find((c) => c.name === "model_prefab").params.kind.desc.split("|").length === 24);
const src = fs.readFileSync("src/core/skills/studio_modelcraft.js", "utf8");
ok("no Luau-only syntax (so the simulator really executes it)", !/\+=|-=|\.\.=|\bcontinue\b|=\s*if\s/.test(src.replace(/\/\/.*$/gm, "")));
ok("catalogue stays under the visible budget with the two new commands (two one-property duplicates hidden)", S.SKILL_COMMANDS.filter((c) => !c.hidden).length < 700 /* 1.77.0: +8 cutscene commands; 1.78.0: +7 art commands; 1.82.0: +15 VFX / SFX / sequence commands */ && S.hiddenCommandNames().has("physics_pivot_set") && S.hiddenCommandNames().has("cast_shadow_set") && S.SKILL_OPS.includes("physics_pivot_set"));

// ── builders ──
const K = S.PREFAB_KINDS;
const autoTower = S.buildLuau("model_create", { request: "build a medieval watchtower", position: [0, 0, 0] });
const autoSword = S.buildLuau("model_create", { request: "a glowing crystal sword", position: [40, 0, 0] });
const autoSofa = S.buildLuau("model_create", { request: "a cozy red sofa", position: [80, 0, 0] });
const autoTree = S.buildLuau("model_create", { request: "an oak tree", position: [120, 0, 0] });
const autoDragon = S.buildLuau("model_create", { request: "a fantasy dragon", position: [160, 0, 0] });
const autoFallback = S.buildLuau("model_create", {});
const autoScaleTower = S.buildLuau("model_create", { request: "watchtower", position: [200, 0, 0], scale: 2 });
const autoRotDragon = S.buildLuau("model_create", { request: "a fantasy dragon", name: "YawDragon", position: [240, 0, 0], rotation_y: 37, rotation: 81 });
const autoRotTyped = S.buildLuau("model_create", { request: "a watchtower", name: "YawTower", position: [260, 0, 0], rotation_y: 37, rotation: 81 });
const autoRotClamped = S.buildLuau("model_create", { request: "a fantasy dragon", name: "ClampedDragon", position: [270, 0, 0], rotation_y: 99999 });
const autoScaledVehicle = S.buildLuau("model_create", { request: "a drivable car", name: "ScaleCar", position: [280, 0, 0], scale: 1.5 });
const autoScaledTool = S.buildLuau("model_create", { request: "a crystal sword", name: "ScaleSword", position: [320, 0, 0], as_tool: true, scale: 2 });
const autoBaseTool = S.buildLuau("model_create", { request: "a crystal sword", name: "BaseSword", position: [360, 0, 0], as_tool: true });
const autoRoute = (r) => { const m = r && r.body && /local __route=\{builder="([^"]+)",kind="([^"]+)"/.exec(r.body); return m ? m[1] + ":" + m[2] : ""; };
ok("model_create routes weak-model natural requests to the typed builder and treats crystal as a sword style", autoRoute(autoTower) === "structure_build:watchtower" && autoRoute(autoSword) === "weapon_build:sword" && autoRoute(autoSofa) === "furniture_build:sofa" && autoRoute(autoTree) === "model_prefab:tree" && autoRoute(autoDragon) === "generic:dragon" && autoRoute(autoFallback) === "generic:hero_prop", [autoRoute(autoTower), autoRoute(autoSword), autoRoute(autoSofa), autoRoute(autoTree), autoRoute(autoDragon), autoRoute(autoFallback)]);
ok("model_create is a one-call composed build + optional detail + real model_check, with the normal cached library/body contract", [autoTower, autoSword, autoSofa, autoTree, autoDragon, autoFallback].every((r) => r && !r.err && r.code === r.lib + "\n" + r.body && r.body.includes("__checkModel(__modelPath)") && r.body.includes("model_check") && r.body.includes("total_screenshot")) && autoTower.lib.includes(S.MODELKIT_LIB) && autoTree.lib.includes("local function need") && autoTower.body.includes('MK.run("model_detail", __a)') && autoTower.body.includes("not __quality.ok"));
ok("model_create scales static, drivable and Tool builds, reports the applied factor, and records the requested scale", /ScaleTo\(2\)/.test(autoScaleTower.body) && /ScaleTo\(1\.5\)/.test(autoScaledVehicle.body) && /__scaleModel:ScaleTo\(2\)/.test(autoScaledTool.body) && /scale=2/.test(autoScaleTower.body) && /scale=1\.5/.test(autoScaledVehicle.body) && /scale_applied=2/.test(autoScaledTool.body));
ok("model_create exposes bounded yaw, prefers rotation_y to legacy rotation, and forwards it to generic and typed builders", Object.prototype.hasOwnProperty.call(S.SKILL_COMMANDS.find((c) => c.name === "model_create").params, "rotation_y") && autoRotDragon.body.includes("math.rad(37)") && !autoRotDragon.body.includes("math.rad(81)") && autoRotTyped.body.includes('"rotation":37') && !autoRotTyped.body.includes('"rotation":81') && autoRotClamped.body.includes("math.rad(3600)"));
const programs = {};
let i = 0;
for (const k of K) { const r = S.buildLuau("model_prefab", { kind: k, position: [i * 40, 0, 0], name: "P_" + k, seed: 3 }); ok("model_prefab " + k + " builds", r && !r.err && /^local HttpService/.test(r.code)); programs["prefab_" + k] = r.code; i++; }
for (const k of K) programs["check_" + k] = S.buildLuau("model_check", { path: "Workspace.P_" + k }).code;
programs.prefab_row = S.buildLuau("model_prefab", { kind: "fence", position: [0, 0, 100], count: 4, rotation_y: 90, color: "#aa6633" }).code;
programs.prefab_alias = S.buildLuau("model_prefab", { kind: "street light", position: "10, 0, 10", scale: 1.5, parent: "Workspace" }).code;
programs.check_expect = S.buildLuau("model_check", { path: "Workspace.P_table", expect_size: [6, 3, 3], expect_parts: 4 }).code;
programs.check_bad = S.buildLuau("model_check", { path: "Workspace.Bad", expect_size: [10, 10, 10] }).code;
programs.check_missing = S.buildLuau("model_check", { path: "Workspace.Nope" }).code;
programs.check_budget = S.buildLuau("model_check", { path: "Workspace.P_table", max_parts: 3 }).code;
// model_build (studio_ultimate) uses Luau `+=` which the Lua 5.4 simulator cannot parse - desugar it for the runtime half only.
programs.model_build = S.buildLuau("model_build", { name: "MB", parts: [{ name: "Pole", size: [8, 1, 1], position: [0, 4, 0], rotation: [0, 0, 90], shape: "Cylinder", color: "#333333", material: "Metal" }, { name: "Base", size: [3, 0.5, 3], position: [0, 0.25, 0], color: "#555555", material: "Metal" }], primary: "Pole", position: [50, 10, 20] }).code.replace(/([A-Za-z_][\w.]*)\s*\+=\s*/g, "$1=$1+");
programs.auto_tower = autoTower.code;
programs.auto_sword = autoSword.code;
programs.auto_sofa = autoSofa.code;
programs.auto_tree = autoTree.code;
programs.auto_dragon = autoDragon.code;
programs.auto_fallback = autoFallback.code;
programs.auto_scale_tower = autoScaleTower.code;
programs.auto_rot_dragon = autoRotDragon.code;
programs.auto_rot_typed = autoRotTyped.code;
programs.auto_rot_clamped = autoRotClamped.code;
programs.auto_scaled_vehicle = autoScaledVehicle.code;
programs.auto_scaled_tool = autoScaledTool.code;
programs.auto_base_tool = autoBaseTool.code;
ok("unknown kind is a build error that lists the kinds", /unknown prefab kind 'spaceship'/.test(S.buildLuau("model_prefab", { kind: "spaceship", position: [0, 0, 0] }).err || ""));
ok("alias 'street light' resolves to lamp_post", /local kind="lamp_post"/.test(programs.prefab_alias));
ok("colour override reaches the palette", /a=Color3\.fromRGB\(170,102,51\)/.test(programs.prefab_row));
ok("pivot goes through PrimaryPart.PivotOffset (WorldPivot is ignored once PrimaryPart is set)", /M\.PrimaryPart\.PivotOffset=M\.PrimaryPart\.CFrame:ToObjectSpace\(CFrame\.new\(foot\)\)/.test(programs.prefab_tree));
const ult = fs.readFileSync("src/core/skills/studio_ultimate.js", "utf8");
ok("model_build / model_center_pivot / model_hollow_box got the same PivotOffset fix", (ult.match(/PrimaryPart\.PivotOffset=m\.PrimaryPart\.CFrame:ToObjectSpace\(/g) || []).length >= 3);
ok("model_check 1.98.0 rules present in the Luau (default-names, part-budget, pivot-off, collide-clutter) + max_parts param", ["'default-names'", "'part-budget'", "'pivot-off'", "'collide-clutter'"].every((k) => fs.readFileSync("src/core/skills/studio_modelcraft.js", "utf8").includes(k)) && S.SKILL_COMMANDS.find((c) => c.name === "model_check").params.max_parts);
ok("model_check scores floating / buried / sliver / unanchored / unstyled / scale / primary", ["'floating'", "'buried'", "'sliver'", "'unanchored'", "'unstyled'", "'flat-material'", "'palette-sprawl'", "'no-primary'", "'scale'", "'too-few-parts'"].every((k) => programs.check_bad.includes(k)));

// ── prompts ──
const config = fs.readFileSync("src/core/config.js", "utf8");
ok("MODELING MANDATE preserves proportion / form / palette / critic rules and prefers the deterministic model_create front door for one asset", /MODELING MANDATE \(equal weight/.test(config) && /SCALE FIRST \(1 stud ≈ 0\.28 m\): humanoid 5 tall × 4 wide, door 7×4/.test(config) && /- FORM: 3\+ masses per prop/.test(config) && /- ROUTE: model_create \{request, position\} is the default one-asset path/.test(config) && /static unless drivable:true \/ as_tool:true is requested/.test(config) && /- SURFACE: ≤5 colours \+ 1 accent/.test(config) && /- PROVE: model_check \{path, expect_size\} after every build/.test(config));
ok("full + tight FIRST MOVE and BUILD playbook route one asset through model_create and environments through map_generate", /a single asset → model_create \{request\}; an environment → map_generate/.test(config) && /one asset → model_create \{request\}; environment → map_generate/.test(config) && /MODELING MANDATE: one asset → model_create \{request\}/.test(config) && /- ROUTE: model_create \{request, position\} is the default one-asset path/.test(config) && /- BUILD: .*model_create \{request: original description, position\} for one asset.*repair model_check <80.*specific builders for exact \/ multi-piece work/.test(config));
ok("NEVER list forbids free-handing a prefab prop or shipping under 80", /a free-handed prop that model_prefab covers, a model_check below 80/.test(config));

// ── 1.70.0 dead-code removals ──
const main = fs.readFileSync("src/core/main.js", "utf8");
ok("roadmap subsystem gone from main.js / overlay.css", !/ROADMAP_KEY|roadmapHtml|rsRoadmapV2/.test(main) && !/\.rs-roadmap/.test(fs.readFileSync("overlay.css", "utf8")) && !fs.existsSync("tests/test-roadmap.js"));
ok("runTool uses toolName (roadmapName rename)", !/roadmapName/.test(main) && /const toolName = bareToolName\(name\)/.test(main));
ok("seven unreferenced forwarder files removed", ["agent_skills", "studio_100", "studio_200", "studio_daily", "studio_gui", "studio_plus", "studio_skills"].every((n) => !fs.existsSync("src/core/" + n + ".js")));
ok("dead symbols removed", !/function keybindLabel|function setReasoningModeOverride|const BRAND_NAME\b|COMMAND_LOOKUP_TOOLS/.test(main) && !/function pyLiteral/.test(fs.readFileSync("background.js", "utf8")) && !/function scalePose/.test(fs.readFileSync("src/core/animengine.js", "utf8")) && !/TEXT_DELTA_TYPE_RE/.test(fs.readFileSync("src/providers/stream-net.js", "utf8")));

// ── runtime (python3 + lupa) ──
fs.writeFileSync(path.join(require("os").tmpdir(), "total-modelcraft-programs.json"), JSON.stringify(programs));
const py = `
import json, sys
sys.path.insert(0, "tests")
try:
    from roblox_sim import make_runtime
except Exception as e:
    print(json.dumps({"skip": "lupa unavailable: " + str(e)})); sys.exit(0)
L, M, run = make_runtime()
P = json.load(open(sys.argv[1]))
L.execute("""
local m=Instance.new('Model') m.Name='Bad' m.Parent=workspace
local a=Instance.new('Part') a.Size=Vector3.new(4,1,4) a.CFrame=CFrame.new(0,0.5,0) a.Anchored=false a.Parent=m
local b=Instance.new('Part') b.Size=Vector3.new(1,1,1) b.CFrame=CFrame.new(0,5,0) b.Anchored=true b.Parent=m
local c=Instance.new('Part') c.Size=Vector3.new(0.9,0.9,0.9) c.CFrame=CFrame.new(0,0.5,0) c.Anchored=true c.Parent=m
local d=Instance.new('Part') d.Size=Vector3.new(0.02,2,2) d.CFrame=CFrame.new(2,1,0) d.Anchored=true d.Parent=m
-- 1.98.0: default names, pivot high above the base, tiny colliding trims
for i=1,4 do local e=Instance.new('Part') e.Name='Part' e.Size=Vector3.new(0.3,0.3,0.3) e.CFrame=CFrame.new(-1.5+i*0.4,1.1,0) e.Anchored=true e.CanCollide=true e.Parent=m end
m.PrimaryPart=b
""")
out = {}
for k in P:
    if k.startswith("prefab_") or k.startswith("auto_") or k == "model_build": out[k] = run(k, P[k])
for k in P:
    if k.startswith("check_"): out[k] = run(k, P[k])
out["mb_geom"] = L.execute("local m=workspace.MB local cf,sz=m:GetBoundingBox() local p=m:GetPivot().Position return {cx=cf.Position.X,cy=cf.Position.Y,cz=cf.Position.Z,sx=sz.X,sy=sz.Y,sz=sz.Z,px=p.X,py=p.Y,pz=p.Z,rx=m.Pole.CFrame.RightVector.X,ry=m.Pole.CFrame.RightVector.Y}")
out["mb_geom"] = dict(out["mb_geom"].items())
out["lamp_geom"] = dict(L.execute("local m=workspace.P_lamp_post local p=m.Pole return {rx=p.CFrame.RightVector.X,ry=p.CFrame.RightVector.Y,y=p.Position.Y,px=m:GetPivot().Position.X,py=m:GetPivot().Position.Y}").items())
out["row"] = dict(L.execute("local h=workspace:FindFirstChild('Fences') local xs={} for _,m in ipairs(h:GetChildren()) do xs[#xs+1]=m:GetPivot().Position.Z end table.sort(xs) return {n=#h:GetChildren(),first=xs[1],last=xs[#xs]}").items())
out["sofa_state"] = dict(L.execute("local m=workspace:FindFirstChild('Sofa') local d=m and m:FindFirstChild('Detail') return {has_detail=d~=nil,detail_parts=d and #d:GetChildren() or 0}").items())
out["tool_scale_geom"] = dict(L.execute("local s=workspace:FindFirstChild('ScaleSword') local b=workspace:FindFirstChild('BaseSword') local _,ss=s:GetBoundingBox() local _,bs=b:GetBoundingBox() local h=s:FindFirstChild('Handle') return {scx=ss.X,scy=ss.Y,scz=ss.Z,bx=bs.X,by=bs.Y,bz=bs.Z,class=s.ClassName,base_class=b.ClassName,handle_direct=h and h.Parent==s,handle_unanchored=h and not h.Anchored,wrapper=s:FindFirstChild('__TotalScriptScaleWrapper')~=nil,scale=s:GetAttribute('TotalScriptScale')}").items())
out["yaw_geom"] = dict(L.execute("local g=workspace:FindFirstChild('YawDragon') local t=workspace:FindFirstChild('YawTower') local p=g:GetPivot() local q=t:GetPivot() return {grx=p.RightVector.X,grz=p.RightVector.Z,trx=q.RightVector.X,trz=q.RightVector.Z}").items())
print(json.dumps(out))
`;
let rt = null;
try {
  const res = cp.spawnSync("python3", ["-c", py, path.join(require("os").tmpdir(), "total-modelcraft-programs.json")], { encoding: "utf8", timeout: 120000 });
  rt = JSON.parse(res.stdout.trim().split("\n").pop());
} catch (e) { rt = { skip: "python3 unavailable: " + e.message }; }
if (rt && rt.skip) {
  console.log("SKIP  runtime half (" + rt.skip + ")");
} else {
  for (const k of K) {
    const r = rt["prefab_" + k] || {};
    ok("sim: prefab " + k + " builds a model with 3+ parts and a sane height", r.ok === true && r.parts >= 3 && r.size && r.size[1] > 1 && r.size[1] < 40, JSON.stringify(r).slice(0, 200));
    const c = rt["check_" + k] || {};
    ok("sim: model_check passes its own library (" + k + ")", c.ok === true && c.verdict === "pass" && c.score === 100 && c.issues && c.issues.length === 0, JSON.stringify(c.issues || c).slice(0, 300));
  }
  for (const [key, builder, kind] of [["auto_tower", "structure_build", "watchtower"], ["auto_sword", "weapon_build", "sword"], ["auto_sofa", "furniture_build", "sofa"], ["auto_tree", "model_prefab", "tree"], ["auto_dragon", "generic", "dragon"], ["auto_fallback", "generic", "hero_prop"]]) {
    const r = rt[key] || {}, d = r.data || {}, q = d.quality || {}, recipe = d.recipe || {};
    ok("sim: model_create " + key + " builds the routed model and internally passes model_check >= 80", r.ok === true && typeof d.path === "string" && d.path.length > 0 && recipe.builder === builder && recipe.kind === kind && q.ok === true && q.score >= 80 && q.verdict === "pass", JSON.stringify({ result: r, path: d.path, recipe, quality: q }).slice(0, 500));
  }
  const sofaBuild = rt.auto_sofa || {}, sofaData = sofaBuild.data || {}, sofaDetail = sofaData.detail || {}, sofaQuality = sofaData.quality || {};
  ok("sim: model_create removes optional bevel details when they lower the critic score and preserves the passing base sofa", sofaBuild.ok === true && sofaData.detail_rolled_back === true && sofaDetail.ok === true && sofaDetail.data && sofaDetail.data.parts_added > 0 && sofaQuality.score >= 80 && sofaQuality.verdict === "pass", JSON.stringify({ rolled_back: sofaData.detail_rolled_back, detail: sofaDetail, quality: sofaQuality.score }).slice(0, 500));
  const scaledTool = rt.auto_scaled_tool || {}, toolData = scaledTool.data || {}, toolBuilder = toolData.builder || {}, toolQuality = toolData.quality || {}, tg = rt.tool_scale_geom || {};
  ok("sim: model_create scales a wearable Tool through a temporary Model, preserves the direct Handle, cleans the wrapper, doubles bounds, and passes the critic", scaledTool.ok === true && toolBuilder.scale_applied === 2 && Array.isArray(toolBuilder.bounds) && toolQuality.ok === true && toolQuality.score >= 80 && tg.class === "Tool" && tg.base_class === "Tool" && tg.handle_direct === true && tg.handle_unanchored === true && tg.wrapper === false && tg.scale === 2 && Math.abs(tg.scx - 2 * tg.bx) < 0.06 && Math.abs(tg.scy - 2 * tg.by) < 0.06 && Math.abs(tg.scz - 2 * tg.bz) < 0.06, JSON.stringify({ result: scaledTool, geometry: tg }).slice(0, 700));
  const scaleTower = rt.auto_scale_tower || {}, scaleTowerData = scaleTower.data || {}, scaleTowerBuilder = scaleTowerData.builder || {}, scaleTowerQuality = scaleTowerData.quality || {};
  const scaleVehicle = rt.auto_scaled_vehicle || {}, scaleVehicleData = scaleVehicle.data || {}, scaleVehicleBuilder = scaleVehicleData.builder || {}, scaleVehicleQuality = scaleVehicleData.quality || {};
  ok("sim: model_create applies Model:ScaleTo to a watchtower and a drivable vehicle before checking each result", scaleTower.ok === true && scaleTowerBuilder.scale_applied === 2 && scaleTowerQuality.ok === true && scaleTowerQuality.score >= 80 && scaleTowerQuality.verdict === "pass" && scaleVehicle.ok === true && scaleVehicleBuilder.scale_applied === 1.5 && scaleVehicleQuality.ok === true && scaleVehicleQuality.score >= 80 && scaleVehicleQuality.verdict === "pass", JSON.stringify({ tower: [scaleTowerBuilder, scaleTowerQuality.score], vehicle: [scaleVehicleBuilder, scaleVehicleQuality.score] }).slice(0, 500));
  const yg = rt.yaw_geom || {};
  ok("sim: yaw reaches the generic dragon and typed watchtower pivots at the requested 37 degrees", Math.abs(yg.grx - Math.cos(37 * Math.PI / 180)) < 0.02 && Math.abs(yg.grz + Math.sin(37 * Math.PI / 180)) < 0.02 && Math.abs(yg.trx - Math.cos(37 * Math.PI / 180)) < 0.02 && Math.abs(yg.trz + Math.sin(37 * Math.PI / 180)) < 0.02, JSON.stringify(yg));
  ok("sim: cottage is a real building (walls, openings, roof, chimney: 40+ parts, ~13.6 wide, ~12.8 tall)", rt.prefab_cottage.parts >= 40 && Math.abs(rt.prefab_cottage.size[0] - 13.6) < 0.5 && Math.abs(rt.prefab_cottage.size[1] - 12.75) < 0.5, JSON.stringify(rt.prefab_cottage.size));
  ok("sim: table matches the reference dimensions 6 x 3 x 3", JSON.stringify(rt.prefab_table.size) === "[6,3,3]", JSON.stringify(rt.prefab_table.size));
  ok("sim: lamp post stays upright after PivotTo (rotated-cylinder PrimaryPart no longer tilts the model) and lands on its bottom-centre", Math.abs(rt.lamp_geom.ry) > 0.99 && Math.abs(rt.lamp_geom.px - (K.indexOf("lamp_post") * 40)) < 0.01 && Math.abs(rt.lamp_geom.py) < 0.01, JSON.stringify(rt.lamp_geom));
  ok("sim: row placement makes a holder with 4 fences spread along the rotated axis", rt.row.n === 4 && rt.row.last - rt.row.first > 15, JSON.stringify(rt.row));
  ok("sim: model_build pivot = requested bottom-centre, rotation preserved", Math.abs(rt.mb_geom.px - 50) < 0.01 && Math.abs(rt.mb_geom.py - 10) < 0.01 && Math.abs(rt.mb_geom.pz - 20) < 0.01 && Math.abs(rt.mb_geom.cy - 14) < 0.01 && Math.abs(rt.mb_geom.ry) > 0.99, JSON.stringify(rt.mb_geom));
  ok("sim: model_check with expect_size / expect_parts passes a correct table", rt.check_expect.ok === true && rt.check_expect.verdict === "pass");
  const bad = rt.check_bad || {};
  const kinds = (bad.issues || []).map((x) => x.kind);
  ok("sim: the critic catches a deliberately bad model (floating, buried, sliver, unanchored, unstyled, scale) and fails it", bad.ok === true && bad.verdict === "fail" && bad.score < 50 && ["floating", "buried", "sliver", "unanchored", "unstyled", "scale"].every((k) => kinds.includes(k)), JSON.stringify(kinds));
  ok("sim: every issue carries a concrete fix", (bad.issues || []).every((x) => typeof x.fix === "string" && x.fix.length > 10));
  ok("sim: 1.98.0 rules fire on the bad model - default-names (4x 'Part'), pivot-off (PrimaryPart 5 studs up), collide-clutter (4 tiny colliders)", ["default-names", "pivot-off", "collide-clutter"].every((k) => kinds.includes(k)), JSON.stringify(kinds));
  ok("sim: pivot-off message names the bottom-centre to move to", /bottom-centre is \(/.test((bad.issues || []).find((x) => x.kind === "pivot-off")?.message || ""), JSON.stringify((bad.issues || []).find((x) => x.kind === "pivot-off")));
  ok("sim: part-budget respects max_parts", (rt.check_budget || {}).issues && rt.check_budget.issues.some((x) => x.kind === "part-budget" && /budget 3\)/.test(x.message)), JSON.stringify(rt.check_budget || {}).slice(0, 300));
  ok("sim: missing path is a clean fail()", rt.check_missing.ok === false && /not found/.test(rt.check_missing.error));
}

// ── README / versions ──
const readme = fs.readFileSync("README.md", "utf8");
ok("README 1.70.0 changelog documents the pack and the removals", /\*\*1\.70\.0 — /.test(readme) && /model_prefab/.test(readme) && /model_check/.test(readme) && /roadmap/i.test(readme.slice(readme.indexOf("**1.70.0 — "), readme.indexOf("**1.70.0 — ") + 4000)));
ok("test listed in README", readme.includes("tests/test-model-craft.js"));
ok("README explains shared model_create routing, critic limits, mock-only evidence, and no image-provider scope", /## Cross-provider Roblox model creation/.test(readme) && /model_create \{request/.test(readme) && /not an image-generation API/.test(readme) && /not a visual-quality guarantee/.test(readme) && /no live Roblox Studio visual pass or provider-to-provider quality result is claimed/.test(readme));
ok("version pins 4.0.0", manifest.version === "4.0.0" && /local VERSION = "4\.0\.0"/.test(fs.readFileSync("plugin/TotalScript.lua", "utf8")) && /^version = "4\.0\.0"/m.test(fs.readFileSync("agent/Cargo.toml", "utf8")));

console.log((failed ? "FAIL  " : "OK    ") + "test-model-craft: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
