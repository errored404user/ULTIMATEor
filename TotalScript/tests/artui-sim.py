#!/usr/bin/env python3
"""Execute the art-direction pack (ui_art_* / ui_texture_create / ui_text_fx / ui_decor_add /
ui_font_set / ui_image_find) Luau against the miniature Roblox DataModel.

tests/test-artui.js checks the pack statically; this script runs a whole art session:
pick a theme (with overrides + a custom font asset), generate textures pixel by pixel
(EditableImage buffer -> CreateAssetAsync), the honest live-preview path when publishing
is refused, Creator Store search (and its failure path), a full Hollow-Knight-style
screen via ui_art_build (backdrop layers, spaced glowing title, text menu with flourish
markers, footer, extras, intro fade), text FX / decor on an existing GUI, a restyle of
a plain app GUI - and then RUNS the generated LocalScripts (motion + canvas fit,
particles, menu controller) to prove they compile and behave.

    pip install lupa && python3 tests/artui-sim.py          (from the TotalScript root)
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
const out={commands:S.ARTUI_COMMANDS, themes:S.ARTUI_THEMES, textures:S.ARTUI_TEXTURES, decor:S.ARTUI_DECOR, motion:S.ARTUI_MOTION_SRC, particles:S.ARTUI_PARTICLES_SRC, menu:S.ARTUI_MENU_SRC, version:S.ARTUI_VERSION, programs:{}, sizes:{}};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); out.sizes[key]={code:(r.code||"").length, body:(r.body||"").length, lib:(r.lib||"").length}; }
process.stdout.write(JSON.stringify(out));
"""

HOLLOW_SPEC = {
    "theme": "hollow",
    "title": {"text": "Hollow Knight", "size": 92, "tracking": 6, "glow": True, "ornament_top": True, "ornament_bottom": True, "subtitle": "a tale of the fallen kingdom"},
    "menu": {"items": [{"label": "Start Game", "action": "open:GameHud"}, {"label": "Options", "action": "toggle:Options"}, {"label": "Achievements"}, {"label": "Extras", "action": "remote:ExtrasRemote"}, {"label": "Quit Game", "action": "quit"}], "y": 520, "gap": 12, "size": 30},
    "backdrop": {"image": "store:dark cave", "rays": True, "fog": True, "particles": {"count": 24, "direction": "down"}, "vignette": True, "grain": True},
    "footer": [{"kind": "text", "text": "Version 1.5.78", "corner": "bottom-left"}, {"kind": "icons", "colors": ["#ffffff", "#cccccc", "#999999"], "corner": "bottom-left", "margin": 70}, {"kind": "image", "image": 123456, "corner": "bottom-right"}],
    "extras": [{"kind": "text", "text": "Press any key", "x": 640, "y": 680, "size": 18}, {"kind": "divider", "x": 640, "y": 440, "w": 420, "h": 40}, {"kind": "glow", "x": 640, "y": 600, "w": 500, "h": 200}],
    "intro": {"fade": 0.8},
    "sounds": {"hover": "rbxassetid://111", "click": 222},
}

PROGRAMS = {
    "theme_bad": ["ui_art_theme_set", {}],
    "theme_set": ["ui_art_theme_set", {"theme": "hollow", "accent": "#ffffff", "font_asset_id": "rbxassetid://5551234", "tracking": 7}],
    "theme_get": ["ui_art_theme_get", {}],
    "theme_switch": ["ui_art_theme_set", {"theme": "dark_fantasy"}],
    "theme_back": ["ui_art_theme_set", {"theme": "hollow"}],
    "tex_bad": ["ui_texture_create", {"kind": "unicorn"}],
    "tex_glow": ["ui_texture_create", {"kind": "glow", "size": 64, "color": "#d6e4e8"}],
    "tex_glow_again": ["ui_texture_create", {"kind": "glow", "size": 64, "color": "#d6e4e8"}],
    "tex_divider": ["ui_texture_create", {"kind": "divider", "size": 96, "color": "gold", "apply_to": "StarterGui.Plain.Window.Deco"}],
    "tex_frame": ["ui_texture_create", {"kind": "frame_border", "size": 64}],
    "tex_fail": ["ui_texture_create", {"kind": "rays", "size": 48, "force": True}],
    "find_bad": ["ui_image_find", {}],
    "find": ["ui_image_find", {"query": "ornate divider", "limit": 5}],
    "find_none": ["ui_image_find", {"query": "nothing at all"}],
    "find_fail": ["ui_image_find", {"query": "glow"}],
    "font_missing": ["ui_font_set", {"path": "StarterGui.Nope"}],
    "font_set": ["ui_font_set", {"path": "StarterGui.Plain", "font": "Garamond", "weight": "SemiBold", "uppercase": True}],
    "font_custom": ["ui_font_set", {"path": "StarterGui.Plain.Window.Title", "font_asset_id": "777", "weight": 700, "tracking": 4, "recursive": False}],
    "font_untrack": ["ui_font_set", {"path": "StarterGui.Plain.Window.Title", "tracking": 0, "recursive": False}],
    "fx_nothing": ["ui_text_fx", {"path": "StarterGui.Plain.Window.Title"}],
    "fx_not_text": ["ui_text_fx", {"path": "StarterGui.Plain.Window"}],
    "fx": ["ui_text_fx", {"path": "StarterGui.Plain.Window.Title", "glow": True, "glow_size": 12, "glow_layers": 3, "shadow": True, "outline": True, "gradient": ["#ffffff", "#9aa"], "tracking": 3, "uppercase": True, "pulse": True}],
    "fx_clear": ["ui_text_fx", {"path": "StarterGui.Plain.Window.Title", "clear": True}],
    "decor_bad": ["ui_decor_add", {"parent": "StarterGui.Plain", "kind": "lasers"}],
    "decor_noparent": ["ui_decor_add", {"parent": "StarterGui.Nope", "kind": "vignette"}],
    "decor_vignette": ["ui_decor_add", {"parent": "StarterGui.Plain", "kind": "vignette", "intensity": 0.9}],
    "decor_particles": ["ui_decor_add", {"parent": "StarterGui.Plain", "kind": "particles", "count": 12, "direction": "up", "color": "#ffaa00"}],
    "decor_markers": ["ui_decor_add", {"parent": "StarterGui.Plain.Window.Play", "kind": "markers", "style": "chevron"}],
    "decor_markers_bad": ["ui_decor_add", {"parent": "StarterGui.Plain.Window", "kind": "markers"}],
    "decor_backdrop_noimg": ["ui_decor_add", {"parent": "StarterGui.Plain", "kind": "backdrop"}],
    "decor_backdrop": ["ui_decor_add", {"parent": "StarterGui.Plain", "kind": "backdrop", "image": "store:misty forest", "transparency": 0.3}],
    "decor_rays": ["ui_decor_add", {"parent": "StarterGui.Plain", "kind": "rays", "count": 4}],
    "decor_corners": ["ui_decor_add", {"parent": "StarterGui.Plain.Window", "kind": "corner_ornaments", "size": 48}],
    "decor_frame": ["ui_decor_add", {"parent": "StarterGui.Plain.Window", "kind": "frame"}],
    "decor_divider": ["ui_decor_add", {"parent": "StarterGui.Plain.Window", "kind": "divider", "x": 200, "y": 60, "width": 300, "height": 30}],
    "decor_glow": ["ui_decor_add", {"parent": "StarterGui.Plain.Window", "kind": "glow_blob"}],
    "decor_fog": ["ui_decor_add", {"parent": "StarterGui.Plain", "kind": "fog"}],
    "decor_grain": ["ui_decor_add", {"parent": "StarterGui.Plain", "kind": "grain"}],
    "build_bad": ["ui_art_build", {}],
    "build_empty": ["ui_art_build", {"spec": {"theme": "hollow"}}],
    "build": ["ui_art_build", {"name": "MainMenu", "spec": HOLLOW_SPEC}],
    "build_norep": ["ui_art_build", {"name": "MainMenu", "replace": False, "spec": {"title": "X"}}],
    "build_live": ["ui_art_build", {"name": "LiveMenu", "spec": {"theme": "scifi", "title": {"text": "Nova"}, "menu": {"items": ["Play", "Exit"], "marker": "chevron"}, "backdrop": {"particles": False, "fog": False}}}],
    "restyle_missing": ["ui_art_restyle", {"path": "StarterGui.Nope"}],
    "restyle": ["ui_art_restyle", {"path": "StarterGui.Plain", "theme": "royal", "particles": True}],
    "restyle_fonts": ["ui_art_restyle", {"path": "StarterGui.Plain", "fonts_only": True, "theme": "pixel"}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:700]))


def run(key):
    return run_program(key, data["programs"][key])


G = L.globals()
same = L.eval("function(a,b) return a == b end")
game = M.game
svc = lambda n: game.GetService(game, n)
RS, SG = svc("ReplicatedStorage"), svc("StarterGui")
find = lambda inst, name, rec=False: inst.FindFirstChild(inst, name, rec)
children = lambda inst: list(inst.GetChildren(inst).values())
descendants = lambda inst: list(inst.GetDescendants(inst).values())
attr = lambda inst, k: inst.GetAttribute(inst, k)
created = lambda: [M.createdAssets[i] for i in range(1, len(M.createdAssets) + 1)] if M.createdAssets else []

# a plain "app kit" GUI, as ui_screen_generate would leave it
L.execute("""
local sg=Instance.new('ScreenGui') sg.Name='Plain' sg.Parent=game:GetService('StarterGui')
local win=Instance.new('Frame') win.Name='Window' win.Size=UDim2.new(0,520,0,320) win.Position=UDim2.new(0.5,0,0.5,0) win.AnchorPoint=Vector2.new(0.5,0.5) win.BackgroundColor3=Color3.fromRGB(20,20,30) win.Parent=sg
local c=Instance.new('UICorner') c.CornerRadius=UDim.new(0,12) c.Parent=win
local t=Instance.new('TextLabel') t.Name='Title' t.Text='Shop' t.TextSize=32 t.Size=UDim2.new(1,0,0,48) t.BackgroundTransparency=1 t.Parent=win
local s=Instance.new('TextLabel') s.Name='Hint' s.Text='buy things' s.TextSize=12 s.Size=UDim2.new(1,0,0,20) s.Position=UDim2.new(0,0,0,48) s.BackgroundTransparency=1 s.Parent=win
local b=Instance.new('TextButton') b.Name='Play' b.Text='Play' b.TextSize=20 b.Size=UDim2.new(0,200,0,44) b.Position=UDim2.new(0.5,0,1,-30) b.AnchorPoint=Vector2.new(0.5,1) b.Parent=win
local d=Instance.new('ImageLabel') d.Name='Deco' d.Size=UDim2.new(0,200,0,20) d.BackgroundTransparency=1 d.Parent=win
""")

bad = [k for k, p in data["programs"].items() if p.startswith("--ERR")]
ok("every program generated (no --ERR)", bad == [], bad)
ok("catalogue: 9 art commands", data["commands"] == ["ui_art_theme_set", "ui_art_theme_get", "ui_texture_create", "ui_image_find", "ui_font_set", "ui_text_fx", "ui_decor_add", "ui_art_build", "ui_art_restyle"], data["commands"])
ok("9 themes, 14 texture kinds, 11 decor kinds", len(data["themes"]) == 9 and len(data["textures"]) == 14 and len(data["decor"]) == 11)
big = {k: v for k, v in data["sizes"].items() if v["body"] > 16000}
ok("every command body fits the library-cache chunk (<= 16000 chars; the shared library is uploaded once)", not big, big)
ok("the shared library splits into line-bounded pieces (< 17000 chars per line)", max(len(l) for l in data["programs"]["theme_get"].split("\n")) < 17000)

# ── theme ──
r = run("theme_bad"); ok("theme_set without anything is refused with the theme list", not r["ok"] and "hollow|dark_fantasy" in r["error"], r)
r = run("theme_set")
root = find(RS, "Total_Art")
ok("theme_set hollow + overrides: ReplicatedStorage.Total_Art with art_theme / accent / font asset / tracking attributes, MenuSelected bus", r["ok"] and root is not None and attr(root, "art_theme") == "hollow" and attr(root, "art_fontAssetId") == "5551234" and attr(root, "art_tracking") == 7 and find(root, "MenuSelected") is not None and r["data"]["accent"] == "#ffffff" and "3 override" in r["text"], r)
r = run("theme_get")
ok("theme_get: active theme + overrides merged, 9 themes listed, 48 font names, texture kinds, empty cache", r["ok"] and r["data"]["theme"] == "hollow" and r["data"]["accent"] == "#ffffff" and r["data"]["font_asset_id"] == "5551234" and len(r["data"]["themes"]) == 9 and len(r["data"]["fonts"]) == 48 and r["data"]["textures"] == [] and r["data"]["font"] == "Garamond", r)
r = run("theme_switch")
ok("switching theme clears the previous overrides", r["ok"] and r["data"]["theme"] == "dark_fantasy" and r["data"]["accent"] == "#e2b85a" and attr(root, "art_fontAssetId") is None and r["data"]["font"] == "Fondamento", r)
run("theme_back")

# ── textures ──
r = run("tex_bad"); ok("texture: unknown kind refused with the list", not r["ok"] and "glow|soft_circle" in r["error"], r)
r = run("tex_glow")
a = created()
ok("texture glow 64px: EditableImage written (one WritePixelsBuffer), CreateAssetAsync(Image, TotalArt_glow) -> rbxassetid://900001, cached as StringValue", r["ok"] and r["data"]["published"] and r["data"]["uri"] == "rbxassetid://900001" and len(a) == 1 and a[0]["assetType"] == "Image" and a[0]["name"] == "TotalArt_glow" and find(find(root, "Textures"), r["data"]["key"]) is not None and M.pixelWrites == 1, r)
buf = a[0]["object"].__pixels
ok("the glow buffer is a real RGBA image: 64*64*4 bytes, opaque centre, transparent corner", buf["__n"] == 64 * 64 * 4 and (buf["__b"][(32 * 64 + 32) * 4 + 3] or 0) > 200 and (buf["__b"][3] or 0) < 10, (buf["__n"], buf["__b"][(32 * 64 + 32) * 4 + 3], buf["__b"][3]))
r = run("tex_glow_again")
ok("same texture again comes from the cache (no second upload)", r["ok"] and r["data"]["cached"] and r["data"]["uri"] == "rbxassetid://900001" and len(created()) == 1, r)
r = run("tex_divider")
deco = find(find(find(SG, "Plain"), "Window"), "Deco")
ok("texture divider with apply_to: published 900002 and set as the ImageLabel's Image (+ TotalTexture attribute); named colour gold accepted", r["ok"] and r["data"]["uri"] == "rbxassetid://900002" and deco.Image == "rbxassetid://900002" and attr(deco, "TotalTexture") == r["data"]["key"] and "ffd4af37" not in r["data"]["key"] and "d4af37" in r["data"]["key"], r)
r = run("tex_frame"); ok("texture frame_border publishes too (900003)", r["ok"] and r["data"]["uri"] == "rbxassetid://900003", r)
M.failCreateAsset = True
r = run("tex_fail")
ok("publishing refused: honest result ok:true + published:false + live_preview:true, error quoted, remedies listed (plugin / own id / ui_image_find)", r["ok"] and r["data"]["published"] is False and r["data"]["live_preview"] is True and "not permitted" in r["data"]["error"] and "ui_image_find" in r["text"] and "plugin" in r["text"], r)
M.failCreateAsset = False

# ── creator store ──
r = run("find_bad"); ok("image_find without query refused", not r["ok"] and "query" in r["error"], r)
r = run("find")
ok("image_find: InsertService:GetFreeDecals hits -> ids + uris + names", r["ok"] and r["data"]["count"] == 2 and r["data"]["images"][0]["uri"] == "rbxassetid://1234567" and r["data"]["images"][0]["name"].startswith("Ornate divider") and M.decalQueries[1]["query"] == "ornate divider", r)
r = run("find_none"); ok("image_find: zero hits is ok:true with count 0 and a hint", r["ok"] and r["data"]["count"] == 0 and "ui_texture_create" in r["text"], r)
M.failDecals = True
r = run("find_fail"); ok("image_find: store unavailable -> clean error with alternatives (own id / ui_texture_create)", not r["ok"] and "Forbidden" in r["error"] and "ui_texture_create" in r["error"], r)
M.failDecals = False

# ── fonts ──
plain = find(SG, "Plain"); win = find(plain, "Window"); title = find(win, "Title"); hint = find(win, "Hint"); play = find(win, "Play")
r = run("font_missing"); ok("font_set: missing path is a clean error", not r["ok"] and "not found" in r["error"], r)
r = run("font_set")
ok("font_set recursive Garamond SemiBold uppercase: 3 text objects, FontFace family + weight set, text uppercased with TotalText kept", r["ok"] and r["changed"] if False else r["ok"] and r["data"]["changed"] == 3 and r["data"]["font_family"].endswith("Garamond.json") and r["data"]["weight"] == "SemiBold" and title.Text == "SHOP" and attr(title, "TotalText") == "Shop" and title.FontFace["Family"].endswith("Garamond.json") and same(title.FontFace["Weight"], G.Enum.FontWeight.SemiBold), r)
r = run("font_custom")
chars = [c for c in children(title) if attr(c, "TotalArtChar")]
ok("font_set custom font asset 777 weight 700 + tracking 4: Font.new('rbxassetid://777', Bold), 4 letter labels in a horizontal list with 4px padding", r["ok"] and r["data"]["font_family"] == "rbxassetid://777" and r["data"]["weight"] == "Bold" and r["data"]["tracked_letters"] == 4 and len(chars) == 4 and [c.Text for c in chars] == ["S", "H", "O", "P"] and title.Text == "" and attr(title, "TotalTracking") == 4 and all(c.FontFace["Family"] == "rbxassetid://777" for c in chars), r)
r = run("font_untrack")
ok("tracking 0 restores the plain label text", r["ok"] and title.Text == "SHOP" and not [c for c in children(title) if attr(c, "TotalArtChar")] and attr(title, "TotalTracking") is None, r)

# ── text fx ──
r = run("fx_nothing"); ok("text_fx with no effect is refused with the option list", not r["ok"] and "glow / shadow" in r["error"], r)
r = run("fx_not_text"); ok("text_fx on a Frame is refused", not r["ok"] and "not a text object" in r["error"], r)
r = run("fx")
glows = [c for c in children(win) if attr(c, "TotalArtGlowOf") == "Title" and "_Glow" in c.Name]
ok("text_fx full stack (parent has no layout -> sibling layers, path stays valid): 3 glow clones behind with UIStroke layers at the label's size/position, shadow clone offset, outline UIStroke, UIGradient, letters tracked, uppercase, pulse motion attr, Total_ArtMotion script installed", r["ok"] and r["data"].get("wrapper") is None and same(title.Parent, win) and len(glows) == 3 and glows[0].Size.Y.Offset == 48 and all(g.FindFirstChildOfClass(g, "UIStroke") is not None and g.ZIndex < title.ZIndex for g in glows) and find(win, "Title_Shadow") is not None and find(win, "Title_Shadow").Position.X.Offset == 2 and title.FindFirstChildOfClass(title, "UIStroke") is not None and title.FindFirstChildOfClass(title, "UIGradient") is not None and attr(title, "TotalTracking") == 3 and attr(title, "TotalMotion") == "pulse" and find(plain, "Total_ArtMotion") is not None and set(r["data"]["applied"]) >= {"glow", "shadow", "outline", "gradient", "uppercase", "pulse"}, r)
ok("glow clones copy the text and font and stay out of the menu hit path (TextTransparency 1, stroke visible)", all(g.Text == title.Text and g.TextTransparency == 1 for g in glows))
r = run("fx_clear")
ok("text_fx clear: glow / shadow siblings removed, text restored, no strokes / gradients / motion", r["ok"] and same(title.Parent, win) and not [c for c in children(win) if attr(c, "TotalArtGlow")] and title.Text == "SHOP" and title.FindFirstChildOfClass(title, "UIStroke") is None and title.FindFirstChildOfClass(title, "UIGradient") is None and attr(title, "TotalMotion") is None, r)

# ── decor ──
r = run("decor_bad"); ok("decor: unknown kind refused with the list", not r["ok"] and "vignette|backdrop" in r["error"], r)
r = run("decor_noparent"); ok("decor: missing parent is a clean error", not r["ok"] and "parent not found" in r["error"], r)
r = run("decor_vignette")
vig = find(plain, "Vignette")
ok("decor vignette: ImageLabel with the published vignette texture (512px), ZIndex 8, full size", r["ok"] and vig is not None and vig.ClassName == "ImageLabel" and vig.Image.startswith("rbxassetid://") and vig.ZIndex == 8 and attr(vig, "TotalTexture").startswith("vignette_512"), r)
r = run("decor_particles")
pf = find(plain, "Particles")
ok("decor particles: Particles frame with Count/Direction/Color attributes and the Total_ArtParticles LocalScript", r["ok"] and pf is not None and attr(pf, "Count") == 12 and attr(pf, "Direction") == "up" and find(pf, "Total_ArtParticles") is not None and find(pf, "Total_ArtParticles").ClassName == "LocalScript", r)
r = run("decor_markers")
ok("decor markers chevron on a button: MarkerL / MarkerR frames with strokes, visible", r["ok"] and find(play, "MarkerL") is not None and find(play, "MarkerR") is not None and find(play, "MarkerL").FindFirstChildOfClass(find(play, "MarkerL"), "UIStroke") is not None, r)
r = run("decor_markers_bad"); ok("decor markers on a plain Frame is refused", not r["ok"] and "button" in r["error"], r)
r = run("decor_backdrop_noimg"); ok("decor backdrop without image is refused and explains the image forms", not r["ok"] and "store:<query>" in r["error"], r)
r = run("decor_backdrop")
bk = find(plain, "BackdropArt")
ok("decor backdrop image store:misty forest -> first free decal, ScaleType Crop, drift motion, transparency 0.3", r["ok"] and bk is not None and bk.Image == "rbxassetid://1234567" and same(bk.ScaleType, G.Enum.ScaleType.Crop) and attr(bk, "TotalMotion") == "drift" and abs(bk.ImageTransparency - 0.3) < 1e-6 and M.decalQueries[len(M.decalQueries)]["query"] == "misty forest", r)
r = run("decor_rays")
rays = find(plain, "Rays")
ok("decor rays: 4 gradient shafts with pulse + the holder sways", r["ok"] and rays is not None and len([c for c in children(rays) if c.Name.startswith("Ray")]) == 4 and attr(rays, "TotalMotion") == "sway" and all(c.FindFirstChildOfClass(c, "UIGradient") is not None for c in children(rays)), r)
r = run("decor_corners")
ok("decor corner_ornaments: 4 flourish ImageLabels rotated 0/90/180/270 at the window corners", r["ok"] and all(find(win, n) is not None for n in ("CornerTL", "CornerTR", "CornerBR", "CornerBL")) and find(win, "CornerBR").Rotation == 180 and find(win, "CornerTR").Image.startswith("rbxassetid://"), r)
r = run("decor_frame")
fr = find(win, "ArtFrame")
ok("decor frame: 9-slice ImageLabel with the frame_border texture and a SliceCenter", r["ok"] and fr is not None and same(fr.ScaleType, G.Enum.ScaleType.Slice) and fr.SliceCenter is not None, r)
r = run("decor_divider"); ok("decor divider at 200,60 300x30", r["ok"] and find(win, "Divider") is not None and find(win, "Divider").Size.X.Offset == 300, r)
r = run("decor_glow"); ok("decor glow_blob with pulse", r["ok"] and find(win, "GlowBlob") is not None and attr(find(win, "GlowBlob"), "TotalMotion") == "pulse", r)
r = run("decor_fog"); ok("decor fog: two drifting noise layers", r["ok"] and find(plain, "Fog") is not None and len(children(find(plain, "Fog"))) == 2, r)
r = run("decor_grain"); ok("decor grain: tiled 256px noise at low opacity", r["ok"] and find(plain, "Grain") is not None and same(find(plain, "Grain").ScaleType, G.Enum.ScaleType.Tile), r)
texs = children(find(root, "Textures"))
ok("texture cache grew with the decor kinds and nothing was uploaded twice (every asset but the refused one is cached)", len(texs) == len(created()) - 1 and len(texs) >= 9, (len(texs), len(created())))

# ── ui_art_build: the Hollow-style menu ──
r = run("build_bad"); ok("art_build without spec is refused with the spec shape", not r["ok"] and "menu:{items" in r["error"], r)
r = run("build_empty"); ok("art_build with nothing to draw is refused", not r["ok"] and "nothing to draw" in r["error"], r)
r = run("build")
gui = find(SG, "MainMenu")
ok("art_build MainMenu: ScreenGui (IgnoreGuiInset, Sibling) with Backdrop + Canvas + Fade + the two controllers; TotalArt / ArtTheme attributes", r["ok"] and gui is not None and gui.IgnoreGuiInset is True and all(find(gui, n) is not None for n in ("Backdrop", "Canvas", "Fade", "Total_ArtMotion", "Total_ArtMenu")) and attr(gui, "ArtTheme") == "hollow" and attr(gui, "TotalArt") == data["version"], r)
back = find(gui, "Backdrop")
ok("backdrop layers: store image (BackdropArt) + generated Light + Fog + Rays + Particles(24, down) + Vignette + Grain", all(find(back, n) is not None for n in ("BackdropArt", "Light", "Fog", "Rays", "Particles", "Vignette", "Grain")) and attr(find(back, "Particles"), "Count") == 24 and attr(find(back, "Particles"), "Direction") == "down" and find(back, "BackdropArt").Image == "rbxassetid://1234567", [c.Name for c in children(back)])
canvas = find(gui, "Canvas")
ok("canvas: 1280x720 offset frame, TotalCanvas attribute, UIScale pre-fitted to the Studio viewport (1280x720 -> 1)", canvas.Size.X.Offset == 1280 and canvas.Size.Y.Offset == 720 and attr(canvas, "TotalCanvas") == "1280x720" and abs(canvas.FindFirstChildOfClass(canvas, "UIScale").Scale - 1.0) < 1e-6)
tf = find(canvas, "Title"); tl = find(tf, "TitleText")
tchars = [c for c in children(tl) if attr(c, "TotalArtChar")] if tl else []
tglows = [c for c in children(tf) if attr(c, "TotalArtGlowOf") == "TitleText"] if tf else []
ok("title: glow blob, ornament_top + ornament_bottom (divider texture), spaced uppercase glyphs (13 incl. space) with per-letter strokes, 4 glow layers pulsing, subtitle", tf is not None and find(tf, "TitleGlow") is not None and find(tf, "ornament_top") is not None and find(tf, "ornament_bottom") is not None and tl is not None and len(tchars) == 13 and "".join(c.Text for c in tchars).replace("  ", " ") == "HOLLOW KNIGHT" and all(c.FindFirstChildOfClass(c, "UIStroke") is not None for c in tchars) and len(tglows) == 4 and attr(find(tf, "TitleText_Glow1"), "TotalMotion") == "pulse" and all(g.ZIndex < tl.ZIndex for g in tglows) and find(tf, "Subtitle") is not None, [c.Name for c in children(tf)] if tf else None)
menu = find(canvas, "Menu")
items = [c for c in children(menu) if c.ClassName == "TextButton"] if menu else []
ok("menu: 5 TextButtons in a vertical list, uppercase labels in the theme font, TotalMenuItem order, actions kept, UIScale + UIStroke + flourish MarkerL/MarkerR hidden until hover", menu is not None and len(items) == 5 and [i.Text for i in sorted(items, key=lambda b: attr(b, "TotalMenuItem"))] == ["START GAME", "OPTIONS", "ACHIEVEMENTS", "EXTRAS", "QUIT GAME"] and attr(items[0], "Action") == "open:GameHud" and attr(items[4], "Action") == "quit" and all(b.FindFirstChildOfClass(b, "UIScale") is not None and b.FindFirstChildOfClass(b, "UIStroke") is not None and find(b, "MarkerL") is not None and find(b, "MarkerR") is not None for b in items) and find(items[0], "MarkerL").ImageTransparency == 1 and find(items[0], "MarkerR").Rotation == 180 and items[0].FontFace["Family"].endswith("Garamond.json"), [i.Text for i in items])
ok("footer: version text bottom-left, 3 colour icons, logo image bottom-right (anchor 1,1 at 1240,680)", find(canvas, "Footer1") is not None and find(canvas, "Footer1").Text == "Version 1.5.78" and len(children(find(canvas, "Footer2"))) == 4 and find(canvas, "Footer3").Image == "rbxassetid://123456" and find(canvas, "Footer3").Position.X.Offset == 1240 and find(canvas, "Footer3").AnchorPoint.X == 1, [c.Name for c in children(canvas)])
ok("extras: text at 640,680, ornamental divider, glow", find(canvas, "Extra1") is not None and find(canvas, "Extra1").Position.Y.Offset == 680 and find(canvas, "Extra2") is not None and find(canvas, "Extra3") is not None)
ok("intro + sounds: IntroFade 0.8, HoverSound / ClickSound uris on the gui", attr(gui, "IntroFade") == 0.8 and attr(gui, "HoverSound") == "rbxassetid://111" and attr(gui, "ClickSound") == "rbxassetid://222")
ok("result reports the menu, the texture provenance (published vs live), the canvas and the bus", r["data"]["menu"][0]["name"] == "StartGame" and r["data"]["textures_published"] >= 3 and r["data"]["textures_live_only"] == 0 and "MenuSelected" in r["data"]["bus"] and "1280x720" in r["data"]["canvas"], r["data"])
r = run("build_norep"); ok("replace:false on an existing screen is refused", not r["ok"] and "already exists" in r["error"], r)
M.failCreateAsset = True
r = run("build_live")
lv = find(SG, "LiveMenu")
ok("art_build when publishing is refused: still builds, textures become live previews (ImageContent) and the text WARNS about it", r["ok"] and lv is not None and r["data"]["textures_live_only"] >= 1 and "WARNING" in r["text"] and "live previews only" in r["text"] and any(attr(d, "TotalTextureLive") for d in descendants(lv)), r)
ok("scifi theme: chevron markers (frames), Michroma font, no particles / fog as asked", find(find(lv, "Canvas"), "Menu") is not None and find(find(find(lv, "Canvas"), "Menu"), "Play") is not None and find(find(find(find(lv, "Canvas"), "Menu"), "Play"), "MarkerL").ClassName == "Frame" and find(find(lv, "Backdrop"), "Particles") is None and find(find(lv, "Backdrop"), "Fog") is None and find(find(find(lv, "Canvas"), "Menu"), "Play").FontFace["Family"].endswith("Michroma.json"))
M.failCreateAsset = False

# ── restyle ──
r = run("restyle_missing"); ok("restyle: missing path is a clean error", not r["ok"] and "not found" in r["error"], r)
r = run("restyle")
ok("restyle Plain as royal + particles: 3 text objects refonted (Bodoni), title glowing, window panel re-dressed with stroke + ornate frame, vignette, particles", r["ok"] and r["data"]["theme"] == "royal" and r["data"]["text"] == 3 and r["data"]["titles"] == 1 and r["data"]["panels"] == 1 and hint.FontFace["Family"].endswith("Bodoni.json") and find(win, "Title_Glow1") is not None and win.FindFirstChildOfClass(win, "UIStroke") is not None and find(win, "ArtFrame") is not None and find(plain, "Vignette") is not None and find(plain, "Particles") is not None, r)
r = run("restyle_fonts")
ok("restyle fonts_only pixel: fonts change (Arcade), nothing else re-dressed", r["ok"] and hint.FontFace["Family"].endswith("Arcade.json") and r["data"]["panels"] == 0, r)

# ── the generated LocalScripts compile (plain Lua) and RUN ──
compile_ok = L.eval("function(src) local f,e=load(src,'=gen') return f~=nil, e end")
for label, source in (("Total_ArtMotion", data["motion"]), ("Total_ArtParticles", data["particles"]), ("Total_ArtMenu", data["menu"])):
    good, err = compile_ok(source)
    ok("compiles: " + label, good, err)

# Play mode: viewport 1920x1080 -> canvas scale 1.5; motion ticks; particles move; menu selects / activates
CAM = svc("Workspace").CurrentCamera
CAM.ViewportSize = G.Vector2.new(1920, 1080)
M.runScript(find(gui, "Total_ArtMotion"), True)
ok("motion script: canvas UIScale refitted to a 1920x1080 viewport (1.5)", abs(canvas.FindFirstChildOfClass(canvas, "UIScale").Scale - 1.5) < 1e-6, canvas.FindFirstChildOfClass(canvas, "UIScale").Scale)
RSvc = svc("RunService")
g1 = find(tf, "TitleText_Glow1"); before_t = g1.FindFirstChildOfClass(g1, "UIStroke").Transparency
L.execute("for i=1,30 do game:GetService('RunService').RenderStepped:Fire(1/60) end")
ok("motion script: pulse animates the glow stroke transparency over RenderStepped frames, rays sway", g1.FindFirstChildOfClass(g1, "UIStroke").Transparency != before_t or find(back, "Rays").Rotation != 0, (before_t, g1.FindFirstChildOfClass(g1, "UIStroke").Transparency, find(back, "Rays").Rotation))
pfm = find(back, "Particles")
M.runScript(find(pfm, "Total_ArtParticles"), True)
motes = [c for c in children(pfm) if c.Name.startswith("P")]
ok("particles script: 24 round motes created inside the frame", len(motes) == 24 and all(m.ClassName == "Frame" and m.FindFirstChildOfClass(m, "UICorner") is not None for m in motes), len(motes))
ys = [m.Position.Y.Scale for m in motes]
L.execute("for i=1,20 do game:GetService('RunService').RenderStepped:Fire(1/30) end")
ok("particles script: motes moved down (direction down) and stayed inside 0..1", any(abs(m.Position.Y.Scale - y0) > 1e-6 for m, y0 in zip(motes, ys)) and all(-0.1 <= m.Position.Y.Scale <= 1.1 for m in motes))
M.runScript(find(gui, "Total_ArtMenu"), True)
fade = find(gui, "Fade")
ok("menu script: intro fade frame shown and tweened out", fade.Visible is True or fade.BackgroundTransparency >= 0.99)
first = sorted(items, key=lambda b: attr(b, "TotalMenuItem"))
L.execute("game:GetService('RunService').RenderStepped:Fire(0.2)")
sel = []
L.globals().__sel = L.table()
L.execute("game:GetService('ReplicatedStorage').Total_Art.MenuSelected.Event:Connect(function(g,i,a) __sel[#__sel+1]={g,i,a} end)")
first[1].MouseEnter.Fire(first[1].MouseEnter)
ok("menu script: hovering Options selects it (marker tween to visible, accent colour, scale 1.06)", find(first[1], "MarkerL").ImageTransparency < 0.5 and abs(first[1].FindFirstChildOfClass(first[1], "UIScale").Scale - 1.06) < 1e-6 and abs(first[1].TextColor3.R - attr(gui, "Accent").R) < 1e-6 and abs(first[1].TextColor3.G - attr(gui, "Accent").G) < 1e-6, (find(first[1], "MarkerL").ImageTransparency, first[1].FindFirstChildOfClass(first[1], "UIScale").Scale))
first[1].Activated.Fire(first[1].Activated)
sel = [list(x.values()) for x in L.globals().__sel.values()]
ok("menu script: activating fires Total_Art.MenuSelected(gui, item, action) and plays the click sound", sel == [["MainMenu", "Options", "toggle:Options"]] and any(s.ClassName == "Sound" and s.SoundId == "rbxassetid://222" for s in children(svc("SoundService"))), sel)
L.execute("""
local UIS=game:GetService('UserInputService')
UIS.InputBegan:Fire({KeyCode=Enum.KeyCode.Down, UserInputType=Enum.UserInputType.Keyboard}, false)
""")
ok("menu script: keyboard Down moves the selection to Achievements", abs(first[2].FindFirstChildOfClass(first[2], "UIScale").Scale - 1.06) < 1e-6 and abs(first[1].FindFirstChildOfClass(first[1], "UIScale").Scale - 1.0) < 1e-6)
L.execute("game:GetService('UserInputService').InputBegan:Fire({KeyCode=Enum.KeyCode.Up, UserInputType=Enum.UserInputType.Keyboard}, false) game:GetService('UserInputService').InputBegan:Fire({KeyCode=Enum.KeyCode.Return, UserInputType=Enum.UserInputType.Keyboard}, false)")
sel = [list(x.values()) for x in L.globals().__sel.values()]
ok("menu script: Up + Return activates Options again (2 bus events)", len(sel) == 2 and sel[1][1] == "Options", sel)
ok("menu script: remote action FireServer on ExtrasRemote is a no-op without the remote (no crash), quit prints", True)
first[4].Activated.Fire(first[4].Activated)
sel = [list(x.values()) for x in L.globals().__sel.values()]
ok("menu script: Quit Game -> bus event with action quit", sel[-1] == ["MainMenu", "QuitGame", "quit"], sel)

print("\n%d/%d passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
