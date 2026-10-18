#!/usr/bin/env python3
"""Execute the Quality Gate pack (1.47.0) against the miniature Roblox DataModel.

Builds a deliberately bad place - default grey Plastic blocks called "Part", an
unanchored model without PrimaryPart, untouched Lighting, a white 1px-border
ScreenGui in SourceSans with Offset-only sizes, scripts with wait() / LocalPlayer
on the server / a DataStore without pcall - then runs quality_audit, quality_fix,
style_lighting_apply, brief_set / brief_get and quality_audit again and asserts
the score moves the way a reviewer would expect.

    pip install lupa && python3 tests/quality-sim.py          (from the ORscript root)
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
global.window=global; global.chrome={storage:{local:{get:(k,cb)=>cb&&cb({}),set:()=>{}}},runtime:{getURL:(p)=>p}};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const S=RobloxScriptSkills;
const out={commands:S.QUALITY_COMMANDS, genres:S.QUALITY_GENRES, pass:S.QUALITY_PASS_SCORE, programs:{}, guides:{}};
for(const g of S.QUALITY_GENRES) out.guides[g]=S.styleGuideLocal({genre:g});
out.guides.list=S.styleGuideLocal({});
out.guides.alias=S.styleGuideLocal({genre:"Castle Kingdom"});
out.guides.neon=S.styleGuideLocal({genre:"neon city"});
out.guides.compact=S.styleGuideLocal({genre:"horror", compact:true});
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "audit_empty": ["quality_audit", {}],
    "audit_bad": ["quality_audit", {}],
    "audit_build_only": ["quality_audit", {"scope": "build"}],
    "audit_ui_path": ["quality_audit", {"path": "StarterGui.Shop"}],
    "audit_scripts": ["quality_audit", {"scope": "scripts"}],
    "fix_dry": ["quality_fix", {"dry_run": True}],
    "fix": ["quality_fix", {}],
    "fix_again": ["quality_fix", {}],
    "audit_after_fix": ["quality_audit", {}],
    "lighting": ["style_lighting_apply", {"genre": "medieval"}],
    "lighting_again": ["style_lighting_apply", {"genre": "horror", "strength": 0.8, "keep_time": True}],
    "brief_missing": ["brief_get", {}],
    "brief_set": ["brief_set", {"title": "Castle Siege", "genre": "castle", "scale": "walls 14 studs", "must_have": ["gatehouse", "banners"], "avoid": "neon"}],
    "brief_merge": ["brief_set", {"title": "Castle Siege", "notes": "two towers"}],
    "brief_get": ["brief_get", {}],
    "brief_no_title": ["brief_set", {"genre": "scifi"}],
    "audit_final": ["quality_audit", {}],
    "style_guide_luau": ["style_guide", {"genre": "winter"}],
    "lighting_bad": ["style_lighting_apply", {"genre": "nope"}],
    "audit_bad_path": ["quality_audit", {"path": "Workspace.DoesNotExist"}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:600]))


def run(key):
    return run_program(key, data["programs"][key])


def finding(res, kind):
    return next((f for f in res["data"]["findings"] if f["kind"] == kind), None)


G = L.globals()
game = M.game
svc = lambda n: game.GetService(game, n)
WS, LIGHT, SG, SSS, SS, RS = svc("Workspace"), svc("Lighting"), svc("StarterGui"), svc("ServerScriptService"), svc("ServerStorage"), svc("ReplicatedStorage")
find = lambda inst, name, rec=False: inst.FindFirstChild(inst, name, rec)
children = lambda inst: list(inst.GetChildren(inst).values())
desc = lambda inst: list(inst.GetDescendants(inst).values())

# ───────────────────────── catalogue + style guides ─────────────────────────
ok("6 quality commands registered", data["commands"] == ["style_guide", "brief_set", "brief_get", "style_lighting_apply", "quality_audit", "quality_fix"], data["commands"])
ok("16 genres, pass score 85", len(data["genres"]) == 16 and data["pass"] == 85, (len(data["genres"]), data["pass"]))
for g in data["genres"]:
    sg = data["guides"][g]
    d = sg["data"]
    roles = ["base", "secondary", "accent", "ground", "trim", "glow"]
    good = sg["ok"] and d["genre"] == g and all(k in d for k in ("palette", "materials", "lighting", "ui", "scale", "motifs", "vfx", "sfx", "avoid", "recipe"))
    good = good and all(d["palette"][r]["hex"].startswith("#") and len(d["palette"][r]["hex"]) == 7 and len(d["palette"][r]["rgb"]) == 3 for r in roles)
    good = good and 0 <= d["lighting"]["ClockTime"] <= 24 and "atmosphere" in d["lighting"] and "bloom" in d["lighting"] and d["lighting"]["preset"] in ("cyberpunk", "sunset_warm", "warm_night", "horror_dark", "fantasy_vibrant", "overcast_moody", "realistic_noon", "vaporwave", "space_void")
    good = good and d["lighting"]["postfx"] in ("filmic", "noir", "dreamy", "vivid", "horror", "clean")
    good = good and d["ui"]["tokens_preset"] in ("midnight", "clean_light", "candy", "neon", "royal_gold", "forest", "horror", "ocean", "sakura", "retro")
    good = good and len(d["recipe"]) == 5 and d["recipe"][0].startswith("brief_set") and "quality_audit" in d["recipe"][4] and len(d["avoid"]) >= 3 and len(d["motifs"]) >= 5
    ok("style_guide " + g + " is complete and points at real presets", good, json.dumps(d)[:300])
ok("style_guide without genre lists all 16", data["guides"]["list"]["ok"] and len(data["guides"]["list"]["data"]["genres"]) == 16 and "pass genre" in data["guides"]["list"]["text"])
ok("alias 'Castle Kingdom' -> medieval", data["guides"]["alias"]["data"]["genre"] == "medieval")
ok("alias 'neon city' -> cyberpunk", data["guides"]["neon"]["data"]["genre"] == "cyberpunk")
ok("compact guide = palette only", data["guides"]["compact"]["data"]["genre"] == "horror" and "palette" in data["guides"]["compact"]["data"] and "materials" not in data["guides"]["compact"]["data"])
ok("text carries the hex numbers", "#" in data["guides"]["medieval"]["text"] and "ClockTime" in data["guides"]["medieval"]["text"])
ok("unknown genre builds an error at build time (style_lighting_apply)", data["programs"]["lighting_bad"].startswith("--ERR") and "needs genre" in data["programs"]["lighting_bad"])

# ───────────────────────── empty place ─────────────────────────
r = run("audit_empty")
ok("audit on an empty place runs", r.get("ok"), r)
ok("empty place: lighting untouched is flagged, no build/ui/script noise", r["data"]["score"] < 100 and finding(r, "lighting_untouched") and not finding(r, "default_grey") and not finding(r, "raw_default_frames"), r.get("text"))
ok("audit text leads with QUALITY n/100", str(r["text"]).startswith("QUALITY "), r["text"])

# ───────────────────────── build the bad place ─────────────────────────
L.execute(r"""
local game=_G.game or game
local WS=game:GetService('Workspace')
local base=Instance.new('Part') base.Name='Baseplate' base.Size=Vector3.new(512,20,512) base.Anchored=true base.Parent=WS
local hut=Instance.new('Model') hut.Name='Model' hut.Parent=WS
for i=1,14 do local p=Instance.new('Part') p.Name='Part' p.Size=(i%3==0) and Vector3.new(12,1,12) or Vector3.new(1,12,12) p.Anchored=(i%2==0) p.Parent=hut end
for i=1,5 do local p=Instance.new('Part') p.Name='Part' p.Parent=WS end
local npc=Instance.new('Model') npc.Name='Guard' npc.Parent=WS local h=Instance.new('Humanoid') h.Parent=npc local hp=Instance.new('Part') hp.Name='Part' hp.Parent=npc
local SG=game:GetService('StarterGui')
local gui=Instance.new('ScreenGui') gui.Name='Shop' gui.Parent=SG
local root=Instance.new('Frame') root.Name='Main' root.Size=UDim2.new(0,400,0,300) root.Parent=gui
for i=1,4 do local b=Instance.new('TextButton') b.Name='Buy'..i b.Text='Buy' b.Parent=root end
local l=Instance.new('TextLabel') l.Text='Shop' l.Parent=root
local SSS=game:GetService('ServerScriptService')
local s1=Instance.new('Script') s1.Name='Script' s1.Source='wait(1) print("hi") local p=game.Players.LocalPlayer local ds=game:GetService("DataStoreService"):GetDataStore("x") ds:GetAsync("k")' s1.Parent=SSS
local s2=Instance.new('LocalScript') s2.Name='Client' s2.Source='print(1)' s2.Parent=SSS
local RS=game:GetService('ReplicatedStorage')
local m=Instance.new('ModuleScript') m.Name='Config' m.Source='return {}' m.Parent=RS
local m2=Instance.new('ModuleScript') m2.Name='Types' m2.Source='--!strict\nexport type T = {}\nreturn {}' m2.Parent=RS
""")

r = run("audit_bad")
ok("bad place audits", r.get("ok"), r)
d = r["data"]
ok("score is a failing grade and pass=false", d["score"] < 60 and d["pass"] is False and d["grade"] in ("D", "F"), (d["score"], d["grade"]))
ok("counts: 20 parts (humanoid skipped), 1 model", d["counts"]["parts"] == 20 and d["counts"]["models"] == 1, d["counts"])
ok("default_grey high with examples", finding(r, "default_grey") and finding(r, "default_grey")["severity"] == "high" and len(finding(r, "default_grey")["examples"]) == 6, finding(r, "default_grey"))
ok("baseplate is not counted as default grey", d["counts"]["default_grey"] == 19, d["counts"])
ok("unanchored flagged (7 odd parts + 5 loose)", finding(r, "unanchored") and d["counts"]["unanchored"] == 12, d["counts"])
ok("no_primary_part flagged", finding(r, "no_primary_part") and d["counts"]["models_without_primary"] == 1)
ok("default_names flagged (parts + 'Model')", finding(r, "default_names") and d["counts"]["default_names"] == 20, d["counts"])
ok("loose_parts flagged", finding(r, "loose_parts") and d["counts"]["loose_in_workspace"] == 5)
ok("monotone_material + flat_palette + boxy", finding(r, "monotone_material") and finding(r, "flat_palette") and finding(r, "boxy"))
ok("lighting_untouched + no_atmosphere + no_post_stack", finding(r, "lighting_untouched") and finding(r, "no_atmosphere") and finding(r, "no_post_stack"))
u = d["counts"]["ui"]
ok("ui counts: raw frames, fonts, unscaled, offset-only root, no layout", u["raw_default_frames"] == 6 and u["default_font"] == 5 and u["unscaled_text"] == 5 and u["offset_only_roots"] == 1 and u["containers_without_layout"] == 1, u)
ok("offset_only_roots and raw_default_frames findings carry fixes", finding(r, "offset_only_roots") and "ui_make_responsive" in finding(r, "offset_only_roots")["fix"] and finding(r, "raw_default_frames") and "design_tokens_set" in finding(r, "raw_default_frames")["fix"])
s = d["counts"]["scripts"]
ok("script counts: legacy wait, LocalScript in server, LocalPlayer in Script, DataStore w/o pcall, 1 module w/o strict", s["scanned"] == 4 and s["legacy_wait"] == 1 and s["localscript_in_server"] == 1 and s["localplayer_in_server_script"] == 1 and s["datastore_without_pcall"] == 1 and s["modules_without_strict"] == 1 and s["default_names"] == 1, s)
ok("high findings sort first", d["findings"][0]["severity"] == "high" and all(d["findings"][i]["weight"] >= d["findings"][i + 1]["weight"] for i in range(len(d["findings"]) - 1)), [(f["kind"], f["weight"]) for f in d["findings"]])
ok("verdict says FAIL and names quality_fix", "FAIL" in r["text"] and "quality_fix" in r["text"], r["text"])

r = run("audit_build_only")
ok("scope build: no ui / script / lighting findings", r["ok"] and finding(r, "default_grey") and not finding(r, "raw_default_frames") and not finding(r, "legacy_wait") and not finding(r, "lighting_untouched"), r.get("text"))
r = run("audit_ui_path")
ok("path StarterGui.Shop audits only that gui", r["ok"] and "StarterGui.Shop" in r["data"]["scope"] and finding(r, "raw_default_frames") and not finding(r, "default_grey") and not finding(r, "lighting_untouched"), r.get("text"))
r = run("audit_scripts")
ok("scope scripts: high localplayer/localscript/datastore findings", r["ok"] and finding(r, "localplayer_in_server") and finding(r, "localscript_in_server") and finding(r, "datastore_without_pcall") and finding(r, "legacy_wait"), r.get("text"))
r = run("audit_bad_path")
ok("unknown path -> clean error", r.get("ok") is False and "not found" in r.get("error", ""), r)

# ───────────────────────── quality_fix ─────────────────────────
r = run("fix_dry")
ok("dry run reports without changing", r["ok"] and r["data"]["dry_run"] is True and r["data"]["summary"]["anchored"] == 12 and "DRY RUN" in r["text"], r)
hut = find(WS, "Model")
ok("dry run left the tree untouched", hut is not None and hut.PrimaryPart is None and sum(1 for p in desc(WS) if p.IsA(p, "BasePart") and not p.Anchored) == 13, None)
r = run("fix")
ok("quality_fix applies", r["ok"] and r["data"]["summary"]["anchored"] == 12 and r["data"]["summary"]["primary_part_set"] == 1 and r["data"]["summary"]["renamed"] == 20, r.get("data"))
hut = next((m for m in children(WS) if m.IsA(m, "Model") and m.Name.endswith("Model_1")), None)
ok("model renamed by material and got the largest part as PrimaryPart", hut is not None and hut.PrimaryPart is not None and hut.PrimaryPart.Size.X * hut.PrimaryPart.Size.Y * hut.PrimaryPart.Size.Z == 144, hut and hut.Name)
names = sorted(set(p.Name.rsplit("_", 1)[0] for p in children(hut) if p.IsA(p, "BasePart")))
ok("parts renamed by material + role (Plastic Slab / Wall)", names == ["PlasticSlab", "PlasticWall"], names)
guard = find(WS, "Guard")
ok("humanoid model untouched (name, part stays 'Part' and unanchored)", guard is not None and find(guard, "Part") is not None and not find(guard, "Part").Anchored)
ok("baseplate kept its name", find(WS, "Baseplate") is not None)
root = find(find(SG, "Shop"), "Main")
ok("ui fix: borders 0, UICorner added, TextScaled + constraint on labels/buttons, font replaced", root.BorderSizePixel == 0 and root.FindFirstChildOfClass(root, "UICorner") is not None and all(b.TextScaled and b.FindFirstChildOfClass(b, "UITextSizeConstraint") is not None for b in children(root) if b.IsA(b, "TextButton")) and r["data"]["summary"]["ui_fonts_replaced"] == 5 and r["data"]["summary"]["ui_text_scaled"] == 5, r["data"]["summary"])
r = run("fix_again")
ok("second quality_fix finds nothing mechanical", r["ok"] and "nothing mechanical" in r["text"], r)

r = run("audit_after_fix")
d2 = r["data"]
ok("score improved after the mechanical fixes but still fails (palette/lighting are design work)", d2["score"] > d["score"] and d2["pass"] is False and not finding(r, "unanchored") and not finding(r, "no_primary_part") and not finding(r, "default_names") and not finding(r, "raw_default_frames") and finding(r, "default_grey") and finding(r, "lighting_untouched"), (d["score"], d2["score"], [f["kind"] for f in d2["findings"]]))

# ───────────────────────── lighting + brief ─────────────────────────
r = run("lighting")
ok("style_lighting_apply medieval", r["ok"] and r["data"]["genre"] == "medieval" and abs(LIGHT.ClockTime - 17.5) < 1e-6 and LIGHT.Brightness == 2, r)
effects = [c.ClassName for c in children(LIGHT)]
ok("Atmosphere + Bloom + ColorCorrection created once", effects.count("Atmosphere") == 1 and effects.count("BloomEffect") == 1 and effects.count("ColorCorrectionEffect") == 1, effects)
r = run("lighting_again")
ok("re-apply reuses the effects and keep_time keeps the clock", r["ok"] and abs(LIGHT.ClockTime - 17.5) < 1e-6 and [c.ClassName for c in children(LIGHT)].count("Atmosphere") == 1 and find(LIGHT, "OR_Atmosphere").GetAttribute(find(LIGHT, "OR_Atmosphere"), "OR_Style") == "horror", r)
r = run("brief_missing")
ok("brief_get before brief_set explains the order", r["ok"] and r["data"]["has_brief"] is False and "style_guide" in r["text"], r)
r = run("brief_no_title")
ok("brief_set without title errors", r.get("ok") is False and "title" in r["error"], r)
r = run("brief_set")
b = r["data"]["brief"]
ok("brief_set resolves the alias and fills the palette from the guide", r["ok"] and b["genre"] == "medieval" and len(b["palette"]) == 6 and b["palette"][0] == "#7a746c" and b["must_have"] == ["gatehouse", "banners"] and b["avoid"] == ["neon"], b)
ok("brief stored in ServerStorage._ORBrief", find(SS, "_ORBrief") is not None and json.loads(find(SS, "_ORBrief").Value)["title"] == "Castle Siege")
r = run("brief_merge")
ok("brief_set merges (notes added, palette kept)", r["ok"] and r["data"]["brief"]["notes"] == "two towers" and len(r["data"]["brief"]["palette"]) == 6, r["data"]["brief"])
r = run("brief_get")
ok("brief_get reads it back", r["ok"] and r["data"]["brief"]["title"] == "Castle Siege" and "must have: gatehouse; banners" in r["text"], r["text"])

# recolour most parts to something far from the medieval palette -> off_brief_palette
L.execute(r"""
local WS=game:GetService('Workspace')
local i=0 for _,p in ipairs(WS:GetDescendants()) do if p:IsA('BasePart') and p.Name~='Baseplate' and not p.Parent:FindFirstChildOfClass('Humanoid') then i=i+1 p.Color=(i%4==0) and Color3.fromRGB(122,116,108) or Color3.fromRGB(0,255,0) p.Material=(i%2==0) and Enum.Material.Brick or Enum.Material.Wood end end
""")
r = run("audit_final")
d3 = r["data"]
ok("audit sees the brief and flags off-palette parts", d3["brief"] and d3["brief"]["title"] == "Castle Siege" and finding(r, "off_brief_palette") and d3["counts"]["off_brief_palette"] >= 12, (d3["counts"].get("off_brief_palette"), [f["kind"] for f in d3["findings"]]))
ok("grey / lighting findings gone after recolour + style_lighting_apply", not finding(r, "default_grey") and not finding(r, "lighting_untouched") and not finding(r, "no_atmosphere") and not finding(r, "monotone_material"), [f["kind"] for f in d3["findings"]])
ok("score keeps climbing", d3["score"] > d2["score"], (d2["score"], d3["score"]))
r = run("style_guide_luau")
ok("style_guide Luau fallback returns the guide", r["ok"] and r["data"]["genre"] == "winter" and r["data"]["palette"]["base"]["hex"] == "#ecf2fa", r)

n_ok = sum(results)
print(f"\n{n_ok}/{len(results)} checks passed")
sys.exit(0 if n_ok == len(results) else 1)
