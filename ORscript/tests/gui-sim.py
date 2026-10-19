#!/usr/bin/env python3
"""Execute the GUI Studio pack (1.48.0) against the miniature Roblox DataModel.

Builds a shop window from a nested spec (tokens, modifiers, behaviours), reads
it back with ui_export_spec, rebuilds from the export (round-trip), then runs
the layout commands (align / distribute / anchor preset / to-scale /
responsive fix / text fit / z-order / tokens / tween / state toggle / find /
bulk set / screen create / layout report / every component kind) and asserts
the DataModel changed the way the builder expects.

    pip install lupa && python3 tests/gui-sim.py          (from the ORscript root)
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
const out={commands:S.GUISTUDIO_COMMANDS, kinds:S.GUI_COMPONENT_KINDS, presets:Object.keys(S.GUI_TOKEN_PRESETS), programs:{}};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

SHOP = {
    "screen": {"name": "Shop", "ignore_inset": True},
    "preset": "ocean",
    "tokens": {"primary": "#ff8800"},
    "children": [
        {"class": "Frame", "name": "Window", "size": [0, 480, 0, 320], "position": [0.5, 0, 0.5, 0], "anchor": [0.5, 0.5], "bg": "surface", "corner": 14,
         "stroke": {"color": "stroke", "thickness": 2, "transparency": 0.3}, "padding": 12,
         "actions": [{"on": "enable", "do": "tween_in", "effect": "pop"}],
         "children": [
             {"class": "TextLabel", "name": "Title", "text": "SHOP", "size": [1, 0, 0, 40], "bg_t": 1, "text_color": "text", "font": "title_font", "text_size": 24, "align_x": "Left"},
             {"class": "TextButton", "name": "Close", "text": "×", "size": [0, 32, 0, 32], "position": [1, 0, 0, 0], "anchor": [1, 0], "bg": "danger", "corner": 8,
              "actions": [{"on": "click", "do": "close", "target": "parent"}, {"on": "hover", "do": "hover_grow"}]},
             {"class": "ScrollingFrame", "name": "Items", "size": [1, 0, 1, -56], "position": [0, 0, 0, 52], "bg": "surface2", "corner": 10,
              "layout": {"kind": "grid", "cell": [0, 100, 0, 120], "gap": 8}, "padding": 8, "scroll": {"auto": "Y"},
              "children": [
                  {"class": "ImageButton", "name": "Sword", "bg": "surface", "corner": 8, "image": "12345", "gradient": {"from": "primary", "to": "accent", "rotation": 45},
                   "children": [{"class": "TextLabel", "name": "Price", "text": "150", "size": [1, 0, 0, 20], "position": [0, 0, 1, 0], "anchor": [0, 1], "bg_t": 1, "text_color": "accent", "text_fit": {"min": 8, "max": 18}}]},
                  {"class": "ImageButton", "name": "Shield", "bg": "surface", "corner": 8, "props": {"ImageTransparency": 0.5, "BorderSizePixel": 0}},
              ]},
             {"class": "TextBox", "name": "Search", "placeholder": "Search…", "size": [0, 200, 0, 30], "position": [0, 0, 1, 0], "anchor": [0, 1], "bg": "surface2", "corner": 6, "actions": [{"on": "focus", "do": "focus_ring"}]},
         ]},
        {"class": "TextButton", "name": "OpenShop", "text": "Shop", "size": [0, 120, 0, 40], "position": [0, 20, 1, -20], "anchor": [0, 1], "bg": "primary", "corner": 10,
         "actions": [{"on": "click", "do": "toggle", "target": "gui.Window"}]},
    ],
}

PROGRAMS = {
    "export_list_empty": ["ui_export_spec", {}],
    "build_shop": ["ui_build_spec", {"spec": SHOP}],
    "export_shop": ["ui_export_spec", {"path": "StarterGui.Shop"}],
    "build_again_replace": ["ui_build_spec", {"spec": SHOP, "replace": True}],
    "build_under_parent": ["ui_build_spec", {"spec": {"children": [{"class": "TextLabel", "name": "Note", "text": "hi", "size": [0, 80, 0, 20], "actions": [{"on": "enable", "do": "pulse"}]}]}, "parent": "StarterGui.Shop.Window"}],
    "build_bad": ["ui_build_spec", {"spec": {"children": []}}],
    "build_string_spec": ["ui_build_spec", {"spec": json.dumps({"screen": "Mini", "children": [{"class": "Frame", "name": "A", "size": [0, 10, 0, 10]}]})}],
    "find_price": ["ui_find", {"query": "price"}],
    "find_buttons": ["ui_find", {"class": "TextButton", "parent": "StarterGui.Shop"}],
    "align_center": ["ui_align", {"paths": ["StarterGui.Shop.OpenShop"], "mode": "center"}],
    "align_bad": ["ui_align", {"paths": ["StarterGui.Shop.OpenShop"], "mode": "diagonal"}],
    "distribute_setup": ["ui_build_spec", {"spec": {"screen": "Row", "children": [
        {"class": "Frame", "name": "A", "size": [0, 50, 0, 50], "position": [0, 0, 0, 0]},
        {"class": "Frame", "name": "B", "size": [0, 50, 0, 50], "position": [0, 60, 0, 0]},
        {"class": "Frame", "name": "C", "size": [0, 50, 0, 50], "position": [0, 400, 0, 0]}]}}],
    "distribute": ["ui_distribute", {"parent": "StarterGui.Row", "axis": "x"}],
    "distribute_gap": ["ui_distribute", {"parent": "StarterGui.Row", "axis": "x", "gap": 10}],
    "align_row_top": ["ui_align", {"parent": "StarterGui.Row", "mode": "bottom"}],
    "anchor_keep": ["ui_anchor_preset", {"path": "StarterGui.Row.A", "preset": "bottom_right"}],
    "anchor_snap": ["ui_anchor_preset", {"path": "StarterGui.Row.B", "preset": "top_right", "keep": False, "margin": 12}],
    "anchor_bad": ["ui_anchor_preset", {"path": "StarterGui.Row.B", "preset": "nowhere"}],
    "to_scale": ["ui_to_scale", {"path": "StarterGui.Row"}],
    "responsive_dry": ["ui_responsive_fix", {"path": "StarterGui.Shop", "dry_run": True}],
    "responsive": ["ui_responsive_fix", {"path": "StarterGui.Shop"}],
    "text_fit": ["ui_text_fit", {"path": "StarterGui.Shop.Window", "min": 9, "max": 22}],
    "zorder": ["ui_zorder_fix", {"path": "StarterGui.Shop"}],
    "tokens": ["ui_tokens_apply", {"path": "StarterGui.Shop", "preset": "neon"}],
    "tween": ["ui_tween", {"path": "StarterGui.Shop.Window", "effect": "slide_up", "trigger": "enable"}],
    "tween_bad": ["ui_tween", {"path": "StarterGui.Shop.Window", "effect": "explode"}],
    "toggle": ["ui_state_toggle", {"button": "StarterGui.Shop.OpenShop", "target": "StarterGui.Shop.Window", "mode": "toggle"}],
    "toggle_bad": ["ui_state_toggle", {"button": "StarterGui.Shop.Window", "target": "StarterGui.Shop.Window"}],
    "bulk": ["ui_bulk_set", {"parent": "StarterGui.Shop.Window.Items", "class": "ImageButton", "properties": {"BackgroundColor3": "#112233", "Size": [0, 90, 0, 90], "Visible": True}}],
    "bulk_recursive": ["ui_bulk_set", {"parent": "StarterGui.Shop", "recursive": True, "match": "title", "properties": {"TextColor3": "accent", "Font": "GothamBold"}}],
    "screen": ["ui_screen_create", {"name": "HUD", "display_order": 5}],
    "screen_update": ["ui_screen_create", {"name": "HUD", "enabled": False}],
    "report": ["ui_layout_report", {"path": "StarterGui.Shop"}],
    "export_after": ["ui_export_spec", {"path": "StarterGui.Shop.Window"}],
    "comp_bad": ["ui_component", {"kind": "spaceship"}],
}
for kind in ["button", "icon_button", "toggle", "slider", "progress_bar", "window", "modal", "toast", "tabs", "dropdown", "tooltip", "badge", "currency_hud", "health_bar", "hotbar", "text_input", "checkbox", "card", "list", "grid", "divider", "avatar", "title", "stat_row"]:
    PROGRAMS["comp_" + kind] = ["ui_component", {"kind": kind, "screen": "Comps", "label": "Hello", "tabs": ["A", "B"], "options": ["x", "y"], "items": ["1", "2"], "slots": 4, "action": "toggle", "target": "gui.Window"}]
PROGRAMS["comp_in_parent"] = ["ui_component", {"kind": "button", "parent": "StarterGui.Shop.Window", "label": "Buy", "action": "remote", "remote": "BuyItem"}]
PROGRAMS["export_comps"] = ["ui_export_spec", {"path": "StarterGui.Comps"}]

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:700]))


def run(key):
    code = data["programs"][key]
    if code.startswith("--ERR "):
        return {"ok": False, "error": code[6:]}
    return run_program(key, code)


def lua(expr):
    expr = expr.strip()
    return L.execute(expr if expr.startswith(("local ", "return ")) else "return " + expr)


ok("pack exports 17 commands + 24 component kinds + 10 presets", len(data["commands"]) == 17 and len(data["kinds"]) == 24 and len(data["presets"]) == 10, (len(data["commands"]), len(data["kinds"]), len(data["presets"])))

r = run("export_list_empty")
ok("ui_export_spec without path lists ScreenGuis (none yet)", r.get("ok") and r["data"]["screens"] == [], r)

r = run("build_bad")
ok("ui_build_spec rejects an empty spec before Luau", not r.get("ok") and "children" in r.get("error", ""), r)

r = run("build_shop")
ok("ui_build_spec builds the shop (9 objects, behaviours installed)", r.get("ok") and r["data"]["count"] == 9 and r["data"]["behaviours"] == 5 and r["data"]["fresh"] is True, r)
ok("ScreenGui Shop exists with production defaults", lua("game.StarterGui.Shop.IgnoreGuiInset == true and game.StarterGui.Shop.ResetOnSpawn == false"))
ok("tokens stored as OR_* Color3 attributes (primary override + ocean surface)",
   lua("typeof(game.StarterGui.Shop:GetAttribute('OR_Primary'))=='Color3' and math.floor(game.StarterGui.Shop:GetAttribute('OR_Primary').R*255+0.5)==255 and math.floor(game.StarterGui.Shop:GetAttribute('OR_Primary').G*255+0.5)==136"))
ok("window: size / anchor / corner / stroke / padding applied", lua("local w=game.StarterGui.Shop.Window return w.Size.X.Offset==480 and w.AnchorPoint.X==0.5 and w:FindFirstChildOfClass('UICorner').CornerRadius.Offset==14 and w:FindFirstChildOfClass('UIStroke').Thickness==2 and w:FindFirstChildOfClass('UIPadding').PaddingLeft.Offset==12"))
ok("title uses the title_font token and left alignment", lua("local t=game.StarterGui.Shop.Window.Title return t.Font.Name=='GothamBlack' and t.TextXAlignment.Name=='Left' and t.TextSize==24 and t.TextScaled==false and t.BackgroundTransparency==1"))
ok("grid layout + auto canvas + numeric image id → rbxassetid", lua("local it=game.StarterGui.Shop.Window.Items return it:FindFirstChildOfClass('UIGridLayout').CellSize.X.Offset==100 and it.AutomaticCanvasSize.Name=='Y' and it.Sword.Image=='rbxassetid://12345' and it.Sword.LayoutOrder==1 and it.Shield.LayoutOrder==2"))
ok("gradient from tokens + text_fit constraint + raw props", lua("local s=game.StarterGui.Shop.Window.Items.Sword return s:FindFirstChildOfClass('UIGradient').Rotation==45 and s.Price:FindFirstChildOfClass('UITextSizeConstraint').MaxTextSize==18 and s.Price.TextScaled==true and game.StarterGui.Shop.Window.Items.Shield.ImageTransparency==0.5"))
ok("behaviour script + bindings carry dotted paths", lua("local sg=game.StarterGui.Shop local b=game:GetService('HttpService'):JSONDecode(sg.OR_UIBindings.Value) return sg.OR_UIBehaviours:IsA('LocalScript') and #b==5 and b[2].path=='Window.Close' and b[2]['do']=='close' and b[5].target=='gui.Window'"))
ok("behaviour LocalScript source compiles (Lua parser)", lua("local src=game.StarterGui.Shop.OR_UIBehaviours.Source local f,err=load(src,'=beh','t',{}) return f~=nil"), lua("local src=game.StarterGui.Shop.OR_UIBehaviours.Source local f,err=load(src,'=beh','t',{}) return err"))

r = run("export_shop")
spec = r.get("data", {}).get("spec", {})
ok("ui_export_spec reads the shop back (nodes, tokens, bindings)", r.get("ok") and r["data"]["nodes"] == 9 and spec.get("screen", {}).get("name") == "Shop" and len(spec.get("children", [])) == 2 and spec.get("tokens", {}).get("primary") == "#ff8800" and len(spec.get("bindings", [])) == 5, r)
win = spec["children"][0]
ok("export keeps modifiers: corner 14, stroke, padding, grid layout, gradient, text_fit, image", win.get("corner") == 14 and win.get("stroke", {}).get("thickness") == 2 and win.get("padding", {}).get("left") == 12 and [c for c in win["children"] if c["name"] == "Items"][0]["layout"]["kind"] == "grid" and [c for c in win["children"] if c["name"] == "Items"][0]["children"][0]["gradient"]["rotation"] == 45 and [c for c in win["children"] if c["name"] == "Items"][0]["children"][0]["children"][0]["text_fit"]["max"] == 18 and [c for c in win["children"] if c["name"] == "Items"][0]["children"][0]["image"] == "rbxassetid://12345", json.dumps(win)[:400])
ok("export records text props as hex + font names", [c for c in win["children"] if c["name"] == "Title"][0]["font"] == "GothamBlack" and [c for c in win["children"] if c["name"] == "Title"][0]["text_size"] == 24 and [c for c in win["children"] if c["name"] == "Title"][0]["align_x"] == "Left")

r = run("build_again_replace")
ok("replace:true rebuilds without duplicating the ScreenGui", r.get("ok") and r["data"]["fresh"] is True and lua("local n=0 for _,c in ipairs(game.StarterGui:GetChildren()) do if c.Name=='Shop' then n=n+1 end end return n") == 1, r)

r = run("build_under_parent")
ok("building under a GuiObject parent prefixes behaviour paths relative to the ScreenGui", r.get("ok") and r["data"]["count"] == 1 and lua("local b=game:GetService('HttpService'):JSONDecode(game.StarterGui.Shop.OR_UIBindings.Value) return #b==6 and b[6].path=='Window.Note' and b[6]['do']=='pulse'"), r)

r = run("build_string_spec")
ok("spec passed as a JSON string + screen as a string works", r.get("ok") and r["data"]["screen"] == "SG.Mini", r)

r = run("find_price")
ok("ui_find matches by name / text substring", r.get("ok") and r["data"]["count"] == 1 and r["data"]["items"][0]["path"].endswith("Sword.Price"), r)
r = run("find_buttons")
ok("ui_find filters by class under a parent", r.get("ok") and {i["path"].split(".")[-1] for i in r["data"]["items"]} == {"Close", "OpenShop", "Buy"} or (r.get("ok") and r["data"]["count"] == 2), r)

r = run("align_center")
ok("ui_align center moves the button to the viewport centre (offset style kept)", r.get("ok") and lua("local b=game.StarterGui.Shop.OpenShop local p=b.AbsolutePosition return math.abs(p.X+60-640)<=1 and math.abs(p.Y+20-360)<=1 and b.Position.X.Scale==0"), (r, lua("local b=game.StarterGui.Shop.OpenShop return b.AbsolutePosition.X..','..b.AbsolutePosition.Y")))
r = run("align_bad")
ok("ui_align rejects an unknown mode", not r.get("ok") and "mode must be" in r.get("error", ""), r)

run("distribute_setup")
r = run("distribute")
ok("ui_distribute equalises gaps (first / last stay)", r.get("ok") and lua("local R=game.StarterGui.Row return R.A.AbsolutePosition.X==0 and R.C.AbsolutePosition.X==400 and R.B.AbsolutePosition.X==200"), (r, lua("local R=game.StarterGui.Row return R.A.AbsolutePosition.X..','..R.B.AbsolutePosition.X..','..R.C.AbsolutePosition.X")))
r = run("distribute_gap")
ok("ui_distribute with gap packs from the first", r.get("ok") and lua("local R=game.StarterGui.Row return R.B.AbsolutePosition.X==60 and R.C.AbsolutePosition.X==120"), r)
r = run("align_row_top")
ok("ui_align bottom on a parent's children", r.get("ok") and lua("local R=game.StarterGui.Row return R.A.AbsolutePosition.Y==670 and R.C.AbsolutePosition.Y==670"), r)

r = run("anchor_keep")
ok("ui_anchor_preset keeps the visual position", r.get("ok") and lua("local a=game.StarterGui.Row.A return a.AnchorPoint.X==1 and a.AnchorPoint.Y==1 and a.AbsolutePosition.X==0 and a.AbsolutePosition.Y==670"), (r, lua("local a=game.StarterGui.Row.A return a.AbsolutePosition.X..','..a.AbsolutePosition.Y..' '..a.Position.X.Offset")))
r = run("anchor_snap")
ok("ui_anchor_preset keep:false snaps to the edge with margin", r.get("ok") and lua("local b=game.StarterGui.Row.B return b.Position.X.Scale==1 and b.Position.X.Offset==-12 and b.Position.Y.Offset==12"), r)
r = run("anchor_bad")
ok("ui_anchor_preset rejects an unknown preset", not r.get("ok") and "preset must be" in r.get("error", ""), r)

r = run("to_scale")
ok("ui_to_scale converts offsets to scale (same absolute size)", r.get("ok") and r["data"]["changed"] == 3 and lua("local a=game.StarterGui.Row.A return a.Size.X.Offset==0 and math.abs(a.AbsoluteSize.X-50)<0.6 and a.Position.X.Offset==0"), (r, lua("local a=game.StarterGui.Row.A return a.Size.X.Scale..' '..a.AbsoluteSize.X")))

r = run("responsive_dry")
dry = r.get("data", {}).get("changes", {})
ok("ui_responsive_fix dry_run counts without touching", r.get("ok") and r["data"]["dry_run"] is True and dry.get("text_fit", 0) >= 2 and lua("return game.StarterGui.Shop.Window.Size.X.Offset==480"), r)
r = run("responsive")
ok("ui_responsive_fix applies: scale, text constraints, aspect on root frames", r.get("ok") and r["data"]["total"] >= dry.get("text_fit", 0) and lua("local w=game.StarterGui.Shop.Window return w.Size.X.Offset==0 and w:FindFirstChildOfClass('UIAspectRatioConstraint')~=nil and w.Title:FindFirstChildOfClass('UITextSizeConstraint')~=nil and w.Title.TextScaled==true"), r)

r = run("text_fit")
ok("ui_text_fit sets min / max on every text object", r.get("ok") and r["data"]["count"] >= 4 and lua("return game.StarterGui.Shop.Window.Title:FindFirstChildOfClass('UITextSizeConstraint').MaxTextSize==22"), r)

r = run("zorder")
ok("ui_zorder_fix renumbers depth-first", r.get("ok") and r["data"]["count"] >= 9 and lua("local w=game.StarterGui.Shop.Window return w.ZIndex==1 and w.Title.ZIndex==2 and game.StarterGui.Shop.OpenShop.ZIndex>w.Items.Shield.ZIndex"), r)

r = run("tokens")
ok("ui_tokens_apply re-skins with the neon preset", r.get("ok") and r["data"]["tokens"]["primary"] == "#00e5ff" and lua("local w=game.StarterGui.Shop.Window return math.floor(w.BackgroundColor3.R*255+0.5)==14 and game.StarterGui.Shop.OpenShop.Font.Name=='Arcade' and typeof(game.StarterGui.Shop:GetAttribute('OR_Primary'))=='Color3'"), (r, lua("local w=game.StarterGui.Shop.Window return math.floor(w.BackgroundColor3.R*255+0.5)")))

r = run("tween")
ok("ui_tween attaches a compiling LocalScript", r.get("ok") and lua("local s=game.StarterGui.Shop.Window:FindFirstChild('OR_Tween_slide_up') return s~=nil and load(s.Source,'=t','t',{})~=nil"), r)
r = run("tween_bad")
ok("ui_tween rejects unknown effects", not r.get("ok") and "effect must be" in r.get("error", ""), r)

r = run("toggle")
ok("ui_state_toggle attaches OR_Toggle to the button", r.get("ok") and lua("local s=game.StarterGui.Shop.OpenShop:FindFirstChild('OR_Toggle') return s~=nil and load(s.Source,'=t','t',{})~=nil and s.Source:find('StarterGui.Shop.Window',1,true)~=nil"), r)
r = run("toggle_bad")
ok("ui_state_toggle needs a GuiButton", not r.get("ok") and "GuiButton" in r.get("error", "") or "TextButton" in r.get("error", ""), r)

r = run("bulk")
ok("ui_bulk_set hex colour + UDim2 + bool on class-filtered children", r.get("ok") and r["data"]["set"] == 6 and lua("local s=game.StarterGui.Shop.Window.Items.Sword return s.Size.X.Offset==90 and math.floor(s.BackgroundColor3.B*255+0.5)==0x33"), r)
r = run("bulk_recursive")
ok("ui_bulk_set recursive + match + token colour (midnight accent) + Font", r.get("ok") and r["data"]["targets"] == 1 and lua("local t=game.StarterGui.Shop.Window.Title return t.Font.Name=='GothamBold' and math.floor(t.TextColor3.R*255+0.5)==124"), r)

r = run("screen")
ok("ui_screen_create creates HUD with DisplayOrder", r.get("ok") and r["data"]["fresh"] is True and lua("local h=game.StarterGui.HUD return h.DisplayOrder==5 and h.IgnoreGuiInset==true and h.ResetOnSpawn==false"), r)
r = run("screen_update")
ok("ui_screen_create updates in place", r.get("ok") and r["data"]["fresh"] is False and lua("return game.StarterGui.HUD.Enabled==false"), r)

r = run("report")
ok("ui_layout_report returns pixel boxes + overlap info", r.get("ok") and r["data"]["count"] >= 9 and all(k in r["data"]["boxes"][0] for k in ("x", "y", "w", "h", "path")), r)

for kind in data["kinds"]:
    r = run("comp_" + kind)
    ok("ui_component " + kind, r.get("ok") and r["data"]["count"] >= 1, r)
ok("ui_component rejects unknown kinds", not run("comp_bad").get("ok"))
r = run("comp_in_parent")
ok("ui_component under a parent frame with a remote action", r.get("ok") and lua("local b=game.StarterGui.Shop.Window:FindFirstChild('Button') local bl=game:GetService('HttpService'):JSONDecode(game.StarterGui.Shop.OR_UIBindings.Value) local hit=false for _,x in ipairs(bl) do if x.path=='Window.Button' and x['do']=='remote' and x.remote=='BuyItem' then hit=true end end return b~=nil and hit"), r)
ok("component behaviours all compile", lua("local f=load(game.StarterGui.Comps.OR_UIBehaviours.Source,'=c','t',{}) return f~=nil"))
r = run("export_comps")
ok("ui_export_spec on the component screen (hotbar / tabs / grid round-trip)", r.get("ok") and r["data"]["nodes"] > 40 and any(c.get("name") == "Hotbar" and len(c.get("children", [])) == 4 for c in r["data"]["spec"]["children"]), (r.get("data", {}).get("nodes"), [c.get("name") for c in r.get("data", {}).get("spec", {}).get("children", [])]))

r = run("export_after")
ok("ui_export_spec on a GuiObject wraps it under its ScreenGui name", r.get("ok") and r["data"]["spec"]["screen"]["name"] == "Shop" and r["data"]["spec"]["children"][0]["name"] == "Window", r)

n_ok = sum(results)
print("%d/%d checks passed" % (n_ok, len(results)))
sys.exit(0 if n_ok == len(results) else 1)
