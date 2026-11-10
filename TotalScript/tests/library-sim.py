#!/usr/bin/env python3
"""Library pack (2.18.0) - kit_save / kit_place / kit_library / project_style against
the miniature Roblox DataModel.

tests/test-library-pack.js checks the pack statically (registration, params, validation,
wiring, preset ids). This script runs the REAL generated Luau in tests/roblox_sim.py:

  kit_save       a Model becomes ServerStorage._TotalKits.<name> (Asset clone + attributes),
                 a Folder of parts is wrapped into a Model with a PrimaryPart, services /
                 Terrain / unknown paths are refused, replace:false protects a name
  kit_place      single copy (direct), line (count + spacing), grid, explicit points,
                 rotation / scale / jitter with a seed (deterministic), snap_to_ground
                 via the sim raycast, wrapper Model naming, 200 cap, unknown kit error
  kit_library    list (filters), info, tag (+add), rename, delete one / all
  project_style  presets list; set preset -> _TotalStyle attributes + palette, writes
                 Total_Art.art_theme, TotalVFX.DefaultPalette (when installed) and the
                 _TotalBrief genre / palette; overrides win over the preset; get reports
                 sync; clear; bad preset / colour are refused; the model kit reads the
                 style for its default structure / weapon / furniture style

Everything here is a MOCK of Roblox; a real Studio run is still the final word.

    pip install lupa && python3 tests/library-sim.py          (from the TotalScript root)
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
try:
    from roblox_sim import make_runtime
except Exception as e:  # pragma: no cover
    print("SKIP  " + str(e))
    sys.exit(0)
try:
    import lupa  # noqa: F401
except Exception:  # pragma: no cover
    print("SKIP  lupa is not installed (pip install lupa)")
    sys.exit(0)

GEN = r"""
const fs=require("fs"), vm=require("vm");
global.window=global;
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills; const want=JSON.parse(process.argv[1]); const out={programs:{}, libLen:S.LIBRARY_LIB.length};
for(const [k,[n,a]] of Object.entries(want)){ let r; try{ r=S.buildLuau(n,a);}catch(e){ r={err:String(e)}; } out.programs[k]=r&&r.code?r.code:("--ERR "+(r&&r.err)); }
process.stdout.write(JSON.stringify(out));
"""

WANT = {
    "lib_empty": ["kit_library", {"op": "list"}],
    "save_lamp": ["kit_save", {"path": "Workspace.Lamp", "tags": "prop, street", "category": "prop", "description": "street lamp"}],
    "save_folder": ["kit_save", {"path": "Workspace.Crates", "name": "CrateStack", "tags": ["prop"]}],
    "save_again_protected": ["kit_save", {"path": "Workspace.Lamp", "replace": False}],
    "save_service": ["kit_save", {"path": "Lighting"}],
    "save_terrain": ["kit_save", {"path": "Workspace.Terrain"}],
    "save_missing": ["kit_save", {"path": "Workspace.Nope"}],
    "place_one": ["kit_place", {"name": "Lamp", "position": [10, 0, 10], "rotation": 90}],
    "place_line": ["kit_place", {"name": "Lamp", "position": [0, 0, 0], "count": 4, "spacing": 8, "direction": [0, 0, 1]}],
    "place_grid": ["kit_place", {"name": "CrateStack", "position": [50, 0, 50], "grid": [3, 2], "spacing": 5, "scale": 2, "group_name": "CrateYard"}],
    "place_points": ["kit_place", {"name": "Lamp", "points": [[1, 0, 1], [2, 0, 2], [3, 0, 3]], "jitter": {"position": 0.5, "rotation": 180, "scale": 0.2}, "seed": 3, "name_as": "Post"}],
    "place_points_same_seed": ["kit_place", {"name": "Lamp", "points": [[1, 0, 1], [2, 0, 2], [3, 0, 3]], "jitter": {"position": 0.5, "rotation": 180, "scale": 0.2}, "seed": 3, "name_as": "Post", "group_name": "Posts2"}],
    "place_snap": ["kit_place", {"name": "Lamp", "position": [100, 50, 100], "snap_to_ground": True, "name_as": "Snapped"}],
    "place_unknown": ["kit_place", {"name": "Nothing", "position": [0, 0, 0]}],
    "place_parent": ["kit_place", {"name": "Lamp", "position": [0, 0, 0], "parent": "Workspace.Props", "name_as": "InProps"}],
    "lib_list": ["kit_library", {"op": "list"}],
    "lib_tag_filter": ["kit_library", {"op": "list", "tag": "street"}],
    "lib_query": ["kit_library", {"op": "list", "query": "crate"}],
    "lib_info": ["kit_library", {"op": "info", "name": "Lamp"}],
    "lib_tag_add": ["kit_library", {"op": "tag", "name": "Lamp", "tags": "night", "add": True}],
    "lib_rename": ["kit_library", {"op": "rename", "name": "CrateStack", "to": "Crates"}],
    "lib_delete": ["kit_library", {"op": "delete", "name": "Crates"}],
    "lib_delete_all": ["kit_library", {"op": "delete", "name": "*"}],
    "style_presets": ["project_style", {"op": "presets"}],
    "style_get_none": ["project_style", {"op": "get"}],
    "style_set_medieval": ["project_style", {"preset": "medieval", "vfx_palette": "frost", "accent": "#ff0000"}],
    "style_get": ["project_style", {"op": "get"}],
    "style_set_override": ["project_style", {"op": "set", "model_style": "scifi", "primary": [0, 128, 255]}],
    "style_bad_preset": ["project_style", {"preset": "steampunk"}],
    "style_clear": ["project_style", {"op": "clear"}],
    "style_get_after_clear": ["project_style", {"op": "get"}],
    "style_set_genre_only": ["project_style", {"genre": "horror"}],
    "mk_house_default": ["structure_build", {"kind": "house", "position": [200, 0, 200]}],
    "mk_sword_default": ["weapon_build", {"kind": "sword", "position": [210, 0, 200]}],
    "mk_sofa_default": ["furniture_build", {"kind": "sofa", "position": [220, 0, 200]}],
}

gen = subprocess.run(["node", "-e", GEN, json.dumps(WANT)], capture_output=True, text=True)
if gen.returncode != 0:
    print("FAIL  generator: " + gen.stderr[-1500:])
    sys.exit(1)
data = json.loads(gen.stdout)
programs = data["programs"]

passed = failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS  " + name)
    else:
        failed += 1
        print("FAIL  " + name + ("  -- " + str(detail)[:900] if detail != "" else ""))

L, M, run = make_runtime()
L.globals()["M"] = M
M.raycastEnabled = True
lua = L.execute

lua(r"""
local lamp = Instance.new("Model") lamp.Name = "Lamp"
local post = Instance.new("Part") post.Name = "Post" post.Size = Vector3.new(1, 8, 1) post.CFrame = CFrame.new(0, 4, 0) post.Anchored = true post.Parent = lamp
local head = Instance.new("Part") head.Name = "Head" head.Size = Vector3.new(2, 1, 2) head.CFrame = CFrame.new(0, 8.5, 0) head.Anchored = true head.Parent = lamp
local light = Instance.new("PointLight") light.Parent = head
lamp.PrimaryPart = post lamp.Parent = workspace
local crates = Instance.new("Folder") crates.Name = "Crates"
for i = 1, 3 do local c = Instance.new("Part") c.Name = "Crate" .. i c.Size = Vector3.new(2, 2, 2) c.CFrame = CFrame.new(i * 2, 1, 0) c.Anchored = true c.Parent = crates end
crates.Parent = workspace
local ground = Instance.new("Part") ground.Name = "Ground" ground.Size = Vector3.new(400, 1, 400) ground.CFrame = CFrame.new(100, 9.5, 100) ground.Anchored = true ground.Parent = workspace
local props = Instance.new("Folder") props.Name = "Props" props.Parent = workspace
""")

ok("generator: LIBRARY_LIB is one shared library (> 20k chars, cached by main.js)", data["libLen"] > 20000, data["libLen"])

# ── kit_save ──────────────────────────────────────────────────────────────
r = run("lib_empty", programs["lib_empty"])
ok("kit_library list with no store: ok, count 0, tells how to save", r.get("ok") and r["data"]["count"] == 0 and "kit_save" in r["text"], r)

r = run("save_lamp", programs["save_lamp"])
ok("kit_save Workspace.Lamp: kit 'Lamp' with tags prop/street, category prop, Model class, 3 descendants, size string", r.get("ok") and r["data"]["name"] == "Lamp" and r["data"]["tags"] == ["prop", "street"] and r["data"]["category"] == "prop" and r["data"]["class"] == "Model" and r["data"]["descendants"] == 3 and "x" in str(r["data"]["size"]), r)
st = json.loads(L.eval("function() local k = game:GetService('ServerStorage')._TotalKits.Lamp local a = k:FindFirstChild('Asset') return M.jsonEncode({asset = a and a.ClassName, pp = a and a.PrimaryPart and a.PrimaryPart.Name, src = k:GetAttribute('Total_Source'), ver = k:GetAttribute('Total_Kit'), orig = a:GetAttribute('Total_AssetName'), n = #a:GetDescendants()}) end")())
ok("the store holds Folder Lamp > Asset (Model, PrimaryPart Post, 3 descendants, Total_Source Workspace.Lamp, Total_Kit version)", st["asset"] == "Model" and st["pp"] == "Post" and st["src"] == "Workspace.Lamp" and st["ver"] == "2.18.0" and st["orig"] == "Lamp" and st["n"] == 3, st)
ok("the original Lamp is untouched", L.eval("function() return workspace:FindFirstChild('Lamp') ~= nil and #workspace.Lamp:GetDescendants() end")() == 3)

r = run("save_folder", programs["save_folder"])
ok("kit_save of a Folder of parts: wrapped into a Model with a PrimaryPart (largest part)", r.get("ok") and r["data"]["name"] == "CrateStack" and L.eval("function() local a = game:GetService('ServerStorage')._TotalKits.CrateStack.Asset return a.ClassName == 'Model' and a.PrimaryPart ~= nil and #a:GetChildren() == 3 end")(), r)
r = run("save_again_protected", programs["save_again_protected"])
ok("replace:false refuses an existing name", not r.get("ok") and "already exists" in r["error"], r)
r = run("save_service", programs["save_service"])
ok("a service cannot be a kit", not r.get("ok") and "service" in r["error"], r)
r = run("save_terrain", programs["save_terrain"])
ok("Terrain cannot be a kit", not r.get("ok") and "Terrain" in r["error"], r)
r = run("save_missing", programs["save_missing"])
ok("unknown path is an explicit error", not r.get("ok") and "path not found" in r["error"], r)

# ── kit_place ─────────────────────────────────────────────────────────────
r = run("place_one", programs["place_one"])
ok("single placement: placed directly in Workspace as 'Lamp' at [10,0,10], yaw 90", r.get("ok") and r["data"]["count"] == 1 and r["data"]["path"] == "Workspace.Lamp" and r["data"]["placed"][0]["position"] == [10, 0, 10] and r["data"]["placed"][0]["yaw"] == 90, r)
n_lamps = L.eval("function() local n = 0 for _, c in ipairs(workspace:GetChildren()) do if c.Name == 'Lamp' then n = n + 1 end end return n end")()
ok("…so Workspace now has two Lamps (the source and the copy) and the copy carries Total_Kit", n_lamps == 2 and L.eval("function() for _, c in ipairs(workspace:GetChildren()) do if c.Name == 'Lamp' and c:GetAttribute('Total_Kit') == 'Lamp' then return c:GetPivot().Position.X end end return nil end")() == 10)

r = run("place_line", programs["place_line"])
ok("line of 4 along +Z, spacing 8: wrapper Model Lamp_x4 with Lamp_1..Lamp_4 at z = 0, 8, 16, 24", r.get("ok") and r["data"]["count"] == 4 and r["data"]["path"] == "Workspace.Lamp_x4" and [p["position"][2] for p in r["data"]["placed"]] == [0, 8, 16, 24] and [p["name"] for p in r["data"]["placed"]] == ["Lamp_1", "Lamp_2", "Lamp_3", "Lamp_4"], r)
ok("…the wrapper really holds four Models and has a PrimaryPart", L.eval("function() local g = workspace:FindFirstChild('Lamp_x4') return g and #g:GetChildren() == 4 and g.PrimaryPart ~= nil end")())

r = run("place_grid", programs["place_grid"])
ok("grid 3x2 from [50,0,50] spacing 5, scale 2, custom group name: 6 copies in Workspace.CrateYard, x in {50,55,60}, z in {50,55}", r.get("ok") and r["data"]["count"] == 6 and r["data"]["path"] == "Workspace.CrateYard" and sorted(set(p["position"][0] for p in r["data"]["placed"])) == [50, 55, 60] and sorted(set(p["position"][2] for p in r["data"]["placed"])) == [50, 55] and all(p["scale"] == 2 for p in r["data"]["placed"]), r)
ok("…scale 2 really doubled the crates (ScaleTo): a crate part is 4 studs wide", abs(L.eval("function() local g = workspace.CrateYard local m = g:GetChildren()[1] for _, d in ipairs(m:GetDescendants()) do if d:IsA('BasePart') then return d.Size.X end end end")() - 4) < 1e-6)

r = run("place_points", programs["place_points"])
r2 = run("place_points_same_seed", programs["place_points_same_seed"])
ok("explicit points + jitter: 3 copies named Post_1..3, positions within 0.5 of the points, scales within 20%, yaw within 180", r.get("ok") and r["data"]["count"] == 3 and all(abs(p["position"][0] - (i + 1)) <= 0.5 + 1e-6 and abs(p["position"][2] - (i + 1)) <= 0.5 + 1e-6 and 0.8 - 1e-6 <= p["scale"] <= 1.2 + 1e-6 and abs(p["yaw"]) <= 180 for i, p in enumerate(r["data"]["placed"])) and r["data"]["placed"][0]["name"] == "Post_1", r)
ok("…jitter is seeded: the same seed reproduces the same positions / scales / yaws", r2.get("ok") and [(p["position"], p["scale"], p["yaw"]) for p in r2["data"]["placed"]] == [(p["position"], p["scale"], p["yaw"]) for p in r["data"]["placed"]])
ok("…and at least one copy actually moved / turned / rescaled (jitter is not a no-op)", any(p["yaw"] != 0 or p["scale"] != 1 for p in r["data"]["placed"]), r["data"]["placed"])

r = run("place_snap", programs["place_snap"])
ok("snap_to_ground: a copy asked at y=50 lands on the Ground part top (y=10) plus half its height", r.get("ok") and r["data"]["snapped"] == 1 and abs(r["data"]["placed"][0]["position"][1] - (10 + 4.5)) < 0.6, r)

r = run("place_unknown", programs["place_unknown"])
ok("unknown kit: error lists the saved kits", not r.get("ok") and "not found" in r["error"] and "Lamp" in r["error"] and "CrateStack" in r["error"], r)
r = run("place_parent", programs["place_parent"])
ok("parent path honoured: Workspace.Props.InProps", r.get("ok") and r["data"]["path"] == "Workspace.Props.InProps" and L.eval("function() return workspace.Props:FindFirstChild('InProps') ~= nil end")(), r)

# ── kit_library ───────────────────────────────────────────────────────────
r = run("lib_list", programs["lib_list"])
ok("list: 2 kits with class / size / tags in the text", r.get("ok") and r["data"]["count"] == 2 and "Lamp (Model" in r["text"] and "CrateStack" in r["text"], r)
r = run("lib_tag_filter", programs["lib_tag_filter"])
ok("list tag:'street' → only Lamp", r.get("ok") and [k["name"] for k in r["data"]["kits"]] == ["Lamp"], r)
r = run("lib_query", programs["lib_query"])
ok("list query:'crate' matches the name case-insensitively", r.get("ok") and [k["name"] for k in r["data"]["kits"]] == ["CrateStack"], r)
r = run("lib_info", programs["lib_info"])
ok("info: classes inside the asset (2 Parts, 1 PointLight), source, size", r.get("ok") and r["data"]["classes"] == {"Part": 2, "PointLight": 1} and r["data"]["source"] == "Workspace.Lamp", r)
r = run("lib_tag_add", programs["lib_tag_add"])
ok("tag add:true keeps prop/street and adds night", r.get("ok") and r["data"]["tags"] == ["prop", "street", "night"], r)
r = run("lib_rename", programs["lib_rename"])
ok("rename CrateStack → Crates", r.get("ok") and r["data"]["name"] == "Crates" and L.eval("function() local f = game:GetService('ServerStorage')._TotalKits return f:FindFirstChild('Crates') ~= nil and f:FindFirstChild('CrateStack') == nil end")(), r)
r = run("lib_delete", programs["lib_delete"])
ok("delete one", r.get("ok") and r["data"]["removed"] == 1)
r = run("lib_delete_all", programs["lib_delete_all"])
ok("delete '*' clears the store", r.get("ok") and r["data"]["removed"] == 1 and L.eval("function() return #game:GetService('ServerStorage')._TotalKits:GetChildren() end")() == 0)

# ── project_style ─────────────────────────────────────────────────────────
r = run("style_presets", programs["style_presets"])
ok("presets: 12 ids, each with genre / ui_theme / vfx / lighting / model / 6-colour palette", r.get("ok") and len(r["data"]["presets"]) == 12 and all(len(p["palette"]) == 6 and p["ui_theme"] and p["vfx"] and p["lighting"] and p["model"] for p in r["data"]["presets"]), r)
r = run("style_get_none", programs["style_get_none"])
ok("get with no style: set=false, names the presets", r.get("ok") and r["data"]["set"] is False and "medieval" in r["text"], r)

lua("local v = Instance.new('ModuleScript') v.Name = 'TotalVFX' v.Parent = game:GetService('ReplicatedStorage')")
r = run("style_set_medieval", programs["style_set_medieval"])
ok("set preset medieval + vfx override frost + accent #ff0000: record returned with the override winning", r.get("ok") and r["data"]["preset"] == "medieval" and r["data"]["genre"] == "medieval" and r["data"]["vfx"] == "frost" and r["data"]["palette"]["accent"] == "#ff0000" and r["data"]["palette"]["primary"] == "#6b4a2b" and r["data"]["model"] == "medieval" and r["data"]["weapon"] == "iron" and r["data"]["furniture"] == "rustic" and r["data"]["ui_theme"] == "dark_fantasy", r)
st = json.loads(L.eval("function() local SS = game:GetService('ServerStorage') local RS = game:GetService('ReplicatedStorage') local f = SS._TotalStyle local b = SS:FindFirstChild('_TotalBrief') local brief = b and M.jsonDecode(b.Value) or {} return M.jsonEncode({model = f:GetAttribute('model'), weapon = f:GetAttribute('weapon'), accent_hex = f:GetAttribute('accent_hex'), accentR = f:GetAttribute('accent') and f:GetAttribute('accent').R, art = RS.Total_Art:GetAttribute('art_theme'), vfx = RS.TotalVFX:GetAttribute('DefaultPalette'), briefGenre = brief.genre, briefPal = brief.palette, briefTitle = brief.title, styleJson = f.Style.Value ~= ''}) end")())
ok("_TotalStyle attributes: model/weapon ids, accent hex + Color3, Style JSON", st["model"] == "medieval" and st["weapon"] == "iron" and st["accent_hex"] == "#ff0000" and abs(st["accentR"] - 1) < 1e-6 and st["styleJson"], st)
ok("fan-out: Total_Art.art_theme = dark_fantasy, TotalVFX.DefaultPalette = frost, _TotalBrief genre medieval + 6-colour palette + title", st["art"] == "dark_fantasy" and st["vfx"] == "frost" and st["briefGenre"] == "medieval" and len(st["briefPal"]) == 6 and st["briefPal"][2] == "#ff0000" and st["briefTitle"] == "medieval", st)
ok("…the text names what was written and what is still to run (style_lighting_apply / design_tokens_set)", "Total_Art.art_theme=dark_fantasy" in r["text"] and "style_lighting_apply" in r["text"] and "design_tokens_set" in r["text"], r["text"])

r = run("style_get", programs["style_get"])
ok("get: set=true, sync report has 6 stores, art / vfx / brief in sync, Lighting + tokens flagged", r.get("ok") and r["data"]["set"] is True and len(r["data"]["sync"]) == 6 and all(s["in_sync"] for s in r["data"]["sync"] if s["store"].startswith(("ReplicatedStorage.Total_Art", "ReplicatedStorage.TotalVFX", "ServerStorage._TotalBrief"))) and any(s["store"] == "Lighting" and not s["in_sync"] for s in r["data"]["sync"]) and "NOT in sync" in r["text"], r)

r = run("style_set_override", programs["style_set_override"])
ok("second set merges: model_style alias → model scifi, primary [0,128,255] → #0080ff, everything else kept (preset medieval, weapon iron)", r.get("ok") and r["data"]["model"] == "scifi" and r["data"]["palette"]["primary"] == "#0080ff" and r["data"]["weapon"] == "iron" and r["data"]["preset"] == "medieval", r)
r = run("style_bad_preset", programs["style_bad_preset"])
ok("bad preset refused before Luau (JS validation names the list)", str(programs["style_bad_preset"]).startswith("--ERR") and "steampunk" in programs["style_bad_preset"] and "medieval" in programs["style_bad_preset"], programs["style_bad_preset"][:200])

# model kit reads the style
r = run("mk_house_default", programs["mk_house_default"])
ok("structure_build without style now builds in the project's model style (scifi)", r.get("ok") and r["data"]["style"] == "scifi" and L.eval("function() for _, m in ipairs(workspace:GetChildren()) do if m:IsA('Model') and m:GetAttribute('StructureKind') == 'house' then return m:GetAttribute('StructureStyle') end end return nil end")() == "scifi", r)
r = run("mk_sword_default", programs["mk_sword_default"])
ok("weapon_build without style uses the project's weapon style (iron)", r.get("ok") and r["data"]["style"] == "iron", r)
r = run("mk_sofa_default", programs["mk_sofa_default"])
ok("furniture_build without style uses the project's furniture style (rustic)", r.get("ok") and r["data"]["style"] == "rustic", r)

r = run("style_clear", programs["style_clear"])
ok("clear removes the record", r.get("ok") and r["data"]["cleared"] is True and L.eval("function() return game:GetService('ServerStorage'):FindFirstChild('_TotalStyle') == nil end")())
r = run("style_get_after_clear", programs["style_get_after_clear"])
ok("get after clear: set=false", r.get("ok") and r["data"]["set"] is False)
r = run("style_set_genre_only", programs["style_set_genre_only"])
ok("set with only a genre: record 'custom:horror', no preset fields forced, brief genre horror", r.get("ok") and r["data"]["preset"] == "custom:horror" and r["data"]["genre"] == "horror" and r["data"].get("model") is None and L.eval("function() return game:GetService('ServerStorage')._TotalBrief:GetAttribute('Genre') end")() == "horror", r)

print("\n%s library-sim: %d passed, %d failed (mocked DataModel - a real Studio run is still the final word)" % ("OK " if failed == 0 else "FAIL", passed, failed))
sys.exit(1 if failed else 0)
