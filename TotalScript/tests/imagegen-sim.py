#!/usr/bin/env python3
"""Image Studio (2.2.1) Studio-side Luau against the miniature Roblox DataModel.

src/core/imagegen.js ships the Luau that turns an RGBA payload into an
EditableImage bound to an ImageLabel (live) or published as an Image asset.
This sim executes exactly that Luau on tests/roblox_sim.py and checks the
JSON it returns tells the truth: created / reused labels, target resolution,
live vs published mode, publish failure fallback, bad payloads.

    pip install lupa && python3 tests/imagegen-sim.py          (from the TotalScript root)

Mocked: no live Studio; the simulator is a miniature DataModel (EditableImage,
WritePixelsBuffer, CreateAssetAsync and Content are data-only stand-ins).
"""
import base64, json, os, subprocess, sys

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

px = base64.b64encode(bytes([255, 0, 0, 255] * 4)).decode("ascii")  # 2x2 red RGBA
GEN = r"""
const I=require(process.cwd()+"/src/core/imagegen.js");
const b64=%s;
const out={};
out.plain=I.studioLuau({w:2,h:2,b64,name:"Logo",kind:"gui_icon"});
out.again=I.studioLuau({w:2,h:2,b64,name:"Logo",kind:"gui_icon"});
out.target=I.studioLuau({w:2,h:2,b64,name:"Splash",kind:"gui_background",target:"StarterGui.HUD"});
out.label=I.studioLuau({w:2,h:2,b64,name:"X",kind:"gui_panel",target:"StarterGui.HUD.Title",slice:{x:1,y:1,w:1,h:1}});
out.intoLabel=I.studioLuau({w:2,h:2,b64,name:"X",kind:"gui_panel",target:"StarterGui.HUD.Pic"});
out.badTarget=I.studioLuau({w:2,h:2,b64,name:"X",kind:"gui_panel",target:"StarterGui.Nope.Deeper"});
out.notGui=I.studioLuau({w:2,h:2,b64,name:"X",kind:"gui_panel",target:"Workspace.Crate"});
out.publish=I.studioLuau({w:2,h:2,b64,name:"Pub",kind:"gui_button",publish:true});
out.publishFail=I.studioLuau({w:2,h:2,b64,name:"PubFail",kind:"gui_button",publish:true});
out.badPayload=I.studioLuau({w:4,h:4,b64,name:"Bad",kind:"gui_panel"});
out.texture=I.studioLuau({w:2,h:2,b64,name:"Tile",kind:"texture"});
process.stdout.write(JSON.stringify(out));
""" % json.dumps(px)
gen = subprocess.run(["node", "-e", GEN], capture_output=True, text=True)
if gen.returncode != 0:
    print("FAIL  node generator: " + gen.stderr[:800])
    sys.exit(1)
LUA = json.loads(gen.stdout)
for code in LUA.values():
    assert "+=" not in code and "\ncontinue" not in code, "Luau must stay plain Lua 5.x for the sim"

L, M, run = make_runtime()

SETUP = r"""
local ws=workspace
local crate=Instance.new("Part") crate.Name="Crate" crate.Parent=ws
local gui=Instance.new("ScreenGui") gui.Name="HUD" gui.Parent=game:GetService("StarterGui")
local tl=Instance.new("TextLabel") tl.Name="Title" tl.Parent=gui
local pic=Instance.new("ImageLabel") pic.Name="Pic" pic.Parent=gui
return "ok"
"""
setup_fn = L.eval("function(M) " + SETUP + " end")
assert setup_fn(M) == "ok"

results = []
def ok(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else "  -> " + str(detail)[:400]))

def exec_json(code):
    return run("imagegen", code)

def count(class_name):
    return L.eval("function(c) local n=0 for _,d in ipairs(game:GetService('StarterGui'):GetDescendants()) do if d:IsA(c) then n=n+1 end end return n end")(class_name)

# 1. plain: creates StarterGui.TotalImages.Logo bound live
r = exec_json(LUA["plain"])
ok("plain: ok + live mode + created under StarterGui.TotalImages", r.get("ok") is True and r["data"]["mode"] == "live" and r["data"]["path"] == "StarterGui.TotalImages.Logo" and r["data"]["created"] is True, r)
ok("plain: pixels were written (WritePixelsBuffer called) and the note says session-only", M.pixelWrites == 1 and "not saved with the place" in r["data"]["note"], r)
ok("plain: gui_icon gets an aspect constraint and Fit scaling", count("UIAspectRatioConstraint") == 1 and r["data"]["scale_type"] == "Fit", r)
attrs = L.eval("function() local g=game:GetService('StarterGui').TotalImages.Logo return g:GetAttribute('TotalImage'), g:GetAttribute('TotalImageMode'), g:GetAttribute('TotalImageSize') end")()
ok("plain: attributes record name / mode / size", tuple(attrs) == ("Logo", "live", "2x2"), attrs)

# 2. again: same name reuses the label (no duplicate)
r2 = exec_json(LUA["again"])
ok("again: the existing label is reused (created=false), still one Logo", r2.get("ok") is True and r2["data"]["created"] is False and count("ImageLabel") == 2, r2)  # Pic + Logo

# 3. target = a ScreenGui → child ImageLabel filling it
r3 = exec_json(LUA["target"])
ok("target ScreenGui: child ImageLabel created inside it, Crop scaling for a background", r3.get("ok") is True and r3["data"]["path"] == "StarterGui.HUD.Splash" and r3["data"]["created"] is True and r3["data"]["scale_type"] == "Crop", r3)

# 4. target = a TextLabel (GuiObject, not an image) → child ImageLabel + 9-slice
r4 = exec_json(LUA["label"])
sl = L.eval("function() local g=game:GetService('StarterGui').HUD.Title:FindFirstChild('X') return g and g.ClassName, g and tostring(g.ScaleType and g.ScaleType.Name) end")()
ok("target GuiObject: ImageLabel child created; slice args switch ScaleType to Slice", r4.get("ok") is True and tuple(sl) == ("ImageLabel", "Slice"), (r4, list(sl)))

# 5. target = an existing ImageLabel → bound in place, nothing created
r5 = exec_json(LUA["intoLabel"])
ok("target ImageLabel: bound in place (created=false), path is the label itself", r5.get("ok") is True and r5["data"]["created"] is False and r5["data"]["path"] == "StarterGui.HUD.Pic", r5)

# 6. failures are honest JSON, never a Luau error
r6 = exec_json(LUA["badTarget"])
ok("missing target → ok:false with a hint, nothing created", r6.get("ok") is False and "target not found" in r6["error"] and "hint" in r6, r6)
r7 = exec_json(LUA["notGui"])
ok("non-GUI target → ok:false naming the class", r7.get("ok") is False and "Part" in r7["error"], r7)
r8 = exec_json(LUA["badPayload"])
ok("payload shorter than w*h*4 → ok:false 'pixel payload' (no EditableImage created)", r8.get("ok") is False and "pixel payload" in r8["error"], r8)

# 7. publish → CreateAssetAsync(Image) → rbxassetid on .Image, mode published
before = len(M.createdAssets) if M.createdAssets else 0
r9 = exec_json(LUA["publish"])
created = list(M.createdAssets.values()) if M.createdAssets else []
img = L.eval("function() return game:GetService('StarterGui').TotalImages.Pub.Image end")()
ok("publish: CreateAssetAsync called with AssetType Image, mode published, Image = rbxassetid://<id>", r9.get("ok") is True and r9["data"]["mode"] == "published" and len(created) == before + 1 and created[-1]["assetType"] == "Image" and img == "rbxassetid://" + str(r9["data"]["asset_id"]), (r9, img))

# 8. publish refused by Studio → falls back to live and reports publish_error
M.failCreateAsset = True
r10 = exec_json(LUA["publishFail"])
M.failCreateAsset = False
ok("publish failure: falls back to the live preview and carries publish_error", r10.get("ok") is True and r10["data"]["mode"] == "live" and "not permitted" in str(r10["data"].get("publish_error")), r10)

# 9. texture kind tiles
r11 = exec_json(LUA["texture"])
ok("texture kind: ScaleType Tile", r11.get("ok") is True and r11["data"]["scale_type"] == "Tile", r11)

ok("no Luau warnings / errors leaked during the run", len(list(M.warnings.values())) == 0 if M.warnings else True, list(M.warnings.values()) if M.warnings else [])

passed = sum(1 for _, c in results if c)
print("imagegen-sim: %d/%d passed (lupa + roblox_sim, MOCKED Studio)" % (passed, len(results)))
sys.exit(0 if passed == len(results) else 1)
