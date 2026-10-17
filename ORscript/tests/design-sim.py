#!/usr/bin/env python3
"""Execute the DESIGN pack's Luau against a miniature Roblox DataModel.

tests/luau-parse-check.py proves the generated programs *parse*. This script goes
one step further for the design pack (src/core/skills/studio_design.js), whose
Luau builds whole ScreenGuis and writes ModuleScripts/LocalScripts that are then
required at runtime: it runs every command inside a small Lua model of Roblox
(Instance tree, Color3/UDim2/Vector2/Enum, services, signals, require/loadstring,
task.*) and asserts the JSON results, instance counts, controller behaviour
(button actions close windows, toggles flip, tabs switch) and the audit output.

    pip install lupa && python3 tests/design-sim.py          (from the ORscript root)

It is not a Roblox engine: layout engines, rendering and replication are not
modelled. It catches the class of bugs a blind-written Luau program has - nil
indexing, wrong argument shapes, missing 'end's at runtime paths, properties set
on the wrong instance, scripts that error on load.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
try:
    from lupa import LuaRuntime
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
const out={commands:S.DESIGN_COMMANDS, screens:S.DESIGN_SCREENS, presets:S.DESIGN_PRESETS, lua:S.DESIGN_LUA, programs:{}};
const want=JSON.parse(process.argv[1]);
for(const [key,[op,args]] of Object.entries(want)){ const r=S.buildLuau(op,args); out.programs[key]=r.code||("--ERR "+r.err); }
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "tokens_set": ["design_tokens_set", {"preset": "neon", "primary": "#ff8800", "font": "Arcade", "radius": 4}],
    "tokens_get": ["design_tokens_get", {}],
    "kit": ["design_kit_install", {"force": True}],
    "shop": ["ui_screen_generate", {"kind": "shop", "title": "Gem Shop", "items": [{"item": "Sword", "price": 100, "rarity": "rare"}, {"item": "Shield", "price": 250, "rarity": "epic"}, "Potion"], "tabs": ["All", "Gear"]}],
    "inventory": ["ui_screen_generate", {"kind": "inventory", "slots": 12, "items": ["Sword", "Potion"]}],
    "hud": ["ui_screen_generate", {"kind": "hud", "stats": ["Coins", "Gems"]}],
    "main_menu": ["ui_screen_generate", {"kind": "main_menu", "title": "Blade Realms", "buttons": ["Play", "Shop", "Settings"]}],
    "settings": ["ui_screen_generate", {"kind": "settings"}],
    "leaderboard": ["ui_screen_generate", {"kind": "leaderboard", "currency": "Wins"}],
    "daily": ["ui_screen_generate", {"kind": "daily_rewards", "rewards": [10, 20, 30, 40, 50, 60, 100]}],
    "quests": ["ui_screen_generate", {"kind": "quest_log", "quests": [{"title": "Find the key", "progress": 0.5, "reward": 20}]}],
    "loading": ["ui_screen_generate", {"kind": "loading", "title": "Blade Realms", "tips": ["a", "b"]}],
    "dialog": ["ui_screen_generate", {"kind": "dialog", "speaker": "Guard", "text": "Halt!", "choices": ["Yes", "No", "Bye"]}],
    "notify": ["ui_screen_generate", {"kind": "notification_stack"}],
    "from_spec": ["ui_from_spec", {"name": "Custom", "open_key": "M", "spec": {"children": [
        {"kind": "Window", "name": "Win", "title": "Custom", "size": [600, 400], "start_hidden": True, "children": [
            {"kind": "Tabs", "name": "T", "tabs": ["One", "Two"], "size": ["fill", "fill"], "pages": [
                {"layout": "column", "gap": 8, "children": [{"kind": "Label", "text": "Hello"}, {"kind": "Button", "name": "Go", "text": "Go", "action": "print:go"}, {"kind": "ProgressBar", "name": "PB", "value": 0.25}, {"kind": "Toggle", "name": "Tg", "text": "Music", "value": True, "setting": "music"}]},
                {"children": [{"kind": "Grid", "name": "G", "columns": 3, "size": ["fill", 200], "children": [{"kind": "Slot", "index": 1}, {"kind": "Slot", "index": 2, "item": "Gem", "rarity": "legendary"}]}]}
            ]}
        ]},
        {"kind": "Button", "name": "Floating", "text": "Open", "anchor": "bottom-right", "margin": 20, "action": "toggle:Win"}
    ]}}],
    "place": ["ui_component_place", {"kind": "CurrencyPill", "parent": "StarterGui.HUD.TopLeft", "name": "Extra", "props": {"stat": "Gold", "value": "12"}}],
    "place_bad": ["ui_component_place", {"kind": "Nope", "parent": "StarterGui.HUD.TopLeft"}],
    "audit": ["ui_audit", {"path": "StarterGui"}],
    "export": ["ui_export_spec", {"path": "StarterGui.Shop"}],
    "apply": ["ui_apply_tokens", {"path": "StarterGui.Legacy"}],
    "responsive": ["ui_make_responsive", {"path": "StarterGui.Legacy"}],
    "gamepad": ["ui_gamepad_focus", {"path": "StarterGui.Legacy"}],
    "states": ["ui_states_wire", {"path": "StarterGui.Legacy", "default_action": True}],
    "preview": ["ui_preview", {"path": "StarterGui.Shop", "device": "phone"}],
    "preview_restore": ["ui_preview", {"path": "StarterGui.Shop", "restore": True}],
    "audit_legacy": ["ui_audit", {"path": "StarterGui.Legacy"}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))

# ───────────────────────── miniature Roblox ─────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from roblox_sim import ROBLOX  # shared miniature DataModel (also used by gfx-sim.py)

L = LuaRuntime(unpack_returned_tuples=True)
M = L.execute(ROBLOX)


def lua_to_py(v, depth=0):
    """Convert a Lua table (from lupa) into Python recursively."""
    if hasattr(v, "items") and hasattr(v, "keys"):
        if depth > 40:
            raise ValueError("JSONEncode: table nesting too deep (cycle?)")
        keys = list(v.keys())
        if not keys:
            return []  # Roblox encodes an empty table as []
        if "__class" in keys:
            raise ValueError("JSONEncode: cannot encode an Instance (" + str(v["__props"]["Name"]) + ") - Roblox would error too")
        if keys and all(isinstance(k, int) for k in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
            return [lua_to_py(v[k], depth + 1) for k in range(1, len(keys) + 1)]
        return {str(k): lua_to_py(v[k], depth + 1) for k in keys}
    return v


def py_to_lua(v):
    if isinstance(v, dict):
        t = L.table()
        for k, val in v.items():
            t[k] = py_to_lua(val)
        return t
    if isinstance(v, list):
        t = L.table()
        for i, val in enumerate(v):
            t[i + 1] = py_to_lua(val)
        return t
    return v


def _enc(v):
    try:
        return json.dumps(lua_to_py(v))
    except Exception as e:
        return json.dumps({"ok": False, "error": "JSONEncode failed: " + str(e)})
M.jsonEncode = _enc
M.jsonDecode = lambda s: py_to_lua(json.loads(s))

same = L.eval("function(a,b) return a == b end")
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:400]))


def run(key):
    code = data["programs"][key]
    if code.startswith("--ERR"):
        return {"ok": False, "error": code}
    fn = L.eval("function(src) local f,e=load(src,'=" + key + "') if not f then return 'COMPILE: '..tostring(e) end local okR,res=pcall(f) if not okR then return 'RUNTIME: '..tostring(res) end return res end")
    out = fn(code)
    try:
        parsed = json.loads(out)
        if not isinstance(parsed, dict):
            return {"ok": False, "error": "non-object result: " + str(out)[:300]}
        return parsed
    except Exception:
        return {"ok": False, "error": str(out)[:600]}


G = L.globals()
game = M.game
SG = lambda: game.GetService(game, "StarterGui")


def count_desc(inst, cls=None):
    n = 0
    for d in list(inst.GetDescendants(inst).values()):
        if cls is None or d.IsA(d, cls):
            n += 1
    return n


# ───────────────────────── 1. tokens + kit ─────────────────────────
r = run("tokens_get")
ok("design_tokens_get before install reports defaults", r.get("ok") and r["data"]["installed"] is False and "midnight" in r["data"]["presets"], r)
r = run("tokens_set")
ok("design_tokens_set writes Tokens + kit", r.get("ok") and r["data"]["preset"] == "neon" and r["data"]["palette"]["Primary"] == "#ff8800" and r["data"]["font"] == "Arcade", r)
design = game.GetService(game, "ReplicatedStorage").FindFirstChild(game.GetService(game, "ReplicatedStorage"), "OR_Design")
ok("OR_Design folder has Tokens, UIKit, Responsive, NotifyLocal", design and all(design.FindFirstChild(design, n) for n in ["Tokens", "UIKit", "Responsive", "NotifyLocal"]))
tokens_src = design.FindFirstChild(design, "Tokens").Source
ok("Tokens ModuleScript source carries the override", 'Primary = Color3.fromRGB(255, 136, 0)' in tokens_src and 'Family = "Arcade"' in tokens_src, tokens_src[:200])
r = run("tokens_get")
ok("design_tokens_get after install", r.get("ok") and r["data"]["installed"] and r["data"]["palette"]["Primary"] == "#ff8800" and r["data"]["kit"], r)
r = run("kit")
ok("design_kit_install force refresh lists components", r.get("ok") and "Button" in r["data"]["components"] and "Window" in r["data"]["components"] and "ItemCard" in r["data"]["components"], r)

# UIKit itself runs inside the simulator (edit mode)
K = M.runModule(design.FindFirstChild(design, "UIKit"))
T = K.tokens(True)
ok("UIKit.tokens() merges Tokens over fallback (edit-mode loadstring path)", abs(T.palette.Primary.R - 1.0) < 1e-6 and abs(T.palette.Primary.G - 136 / 255) < 1e-6 and T.font.Family == "Arcade", (T.palette.Primary.R, T.font.Family))

# ───────────────────────── 2. every screen kind ─────────────────────────
expect = {"shop": ("Shop", 120), "inventory": ("Inventory", 100), "hud": ("HUD", 120), "main_menu": ("MainMenu", 40), "settings": ("Settings", 80), "leaderboard": ("Leaderboard", 10), "daily": ("DailyRewards", 100), "quests": ("QuestLog", 30), "loading": ("LoadingScreen", 20), "dialog": ("Dialog", 40), "notify": ("Notifications", 3)}
WINDOWED = {"shop", "inventory", "main_menu", "settings", "leaderboard", "daily", "quests", "dialog"}
for key, (name, minCount) in expect.items():
    r = run(key)
    parentName = "ReplicatedFirst" if key == "loading" else "StarterGui"
    parent = game.GetService(game, parentName)
    sg = parent.FindFirstChild(parent, name)
    n = count_desc(sg) if sg is not None else 0
    ok("ui_screen_generate %s builds %s.%s (%d instances, want >=%d)" % (key, parentName, name, n, minCount), r.get("ok") and sg is not None and n >= minCount, r if not r.get("ok") else r["text"][:160])
    if sg is None:
        continue
    if key != "loading":
        ok("  %s has OR_Controller" % key, sg.FindFirstChild(sg, "OR_Controller") is not None)
    ok("  %s roots use scale sizes (no offset-only roots)" % key, all((c.Size.X.Scale > 0 or c.Size.X.Offset == 0) for c in sg.GetChildren(sg).values() if c.IsA(c, "GuiObject")))
    if key in WINDOWED:
        ok("  %s window root has aspect + size constraints" % key, any(c.IsA(c, "GuiObject") and c.FindFirstChildOfClass(c, "UIAspectRatioConstraint") and c.FindFirstChildOfClass(c, "UISizeConstraint") for c in sg.GetChildren(sg).values()))
    ok("  %s text is TextScaled with a size constraint" % key, all((not d.IsA(d, "TextLabel")) or (d.TextScaled and d.FindFirstChildOfClass(d, "UITextSizeConstraint")) for d in sg.GetDescendants(sg).values()))

RS = game.GetService(game, "ReplicatedStorage")
remotes = RS.FindFirstChild(RS, "Remotes")
ok("remotes folder created with shop/daily/notify remotes", remotes and all(remotes.FindFirstChild(remotes, n) for n in ["OR_Shop_Buy", "OR_Daily_Claim", "OR_Notify", "OR_Inventory_Equip"]))
SSS = game.GetService(game, "ServerScriptService")
ok("server scripts written (OR_ShopServer, OR_DailyServer)", SSS.FindFirstChild(SSS, "OR_ShopServer") and SSS.FindFirstChild(SSS, "OR_DailyServer"))
shopSrc = SSS.FindFirstChild(SSS, "OR_ShopServer").Source
ok("shop server CATALOG lists the requested items", '["Sword"] = { price = 100' in shopSrc and '["Potion"]' in shopSrc, shopSrc[:300])
shop = SG().FindFirstChild(SG(), "Shop")
win = shop.FindFirstChild(shop, "ShopWindow")
ok("shop window: header title, close button (OR_Action close), tabs, item cards", win.GetAttribute(win, "OR_Window") is True and win.FindFirstChild(win, "Header").FindFirstChild(win.FindFirstChild(win, "Header"), "Title").Text == "Gem Shop" and win.FindFirstChild(win, "Close", True).GetAttribute(win.FindFirstChild(win, "Close", True), "OR_Action") == "close" and win.FindFirstChild(win, "Categories", True) is not None and count_desc(win, "TextButton") >= 5)
cards = [d for d in win.GetDescendants(win).values() if d.GetAttribute(d, "OR_Rarity")]
ok("shop item cards carry OR_Item / OR_Rarity and a Buy button bound to the remote", len(cards) >= 3 and all(c.FindFirstChild(c, "Buy") and c.FindFirstChild(c, "Buy").GetAttribute(c.FindFirstChild(c, "Buy"), "OR_Action") == "remote:OR_Shop_Buy" for c in cards), len(cards))
ok("shop window starts hidden + toggles with B", win.GetAttribute(win, "OR_StartHidden") is True and shop.GetAttribute(shop, "OR_OpenKey") == "B")
hud = SG().FindFirstChild(SG(), "HUD")
ok("hud: currency pills bound to leaderstats, health bar, hotbar slots, feeds", hud.FindFirstChild(hud, "Coins", True).GetAttribute(hud.FindFirstChild(hud, "Coins", True), "OR_Stat") == "Coins" and hud.FindFirstChild(hud, "Health", True).GetAttribute(hud.FindFirstChild(hud, "Health", True), "OR_Progress") == 1 and count_desc(hud.FindFirstChild(hud, "Hotbar"), "ImageButton") == 9 and hud.FindFirstChild(hud, "OR_HudFeed") and hud.FindFirstChild(hud, "OR_NotifyFeed"))

# ───────────────────────── 3. ui_from_spec custom tree ─────────────────────────
r = run("from_spec")
custom = SG().FindFirstChild(SG(), "Custom")
ok("ui_from_spec builds the custom screen", r.get("ok") and custom is not None and r["data"]["count"] >= 9 and count_desc(custom) >= 60, r)
tabs = custom.FindFirstChild(custom, "T", True)
pages = tabs.FindFirstChild(tabs, "Pages")
ok("tabs: 2 tab buttons, 2 pages, first visible", tabs.GetAttribute(tabs, "OR_Tabs") is True and len([c for c in pages.GetChildren(pages).values()]) == 2 and pages.FindFirstChild(pages, "Page_One").Visible is True and pages.FindFirstChild(pages, "Page_Two").Visible is False)
pb = custom.FindFirstChild(custom, "PB", True)
ok("progress bar: Fill 25% + OR_Progress attribute", pb and abs(pb.FindFirstChild(pb, "Fill").Size.X.Scale - 0.25) < 1e-6 and pb.GetAttribute(pb, "OR_Progress") == 0.25)
grid = custom.FindFirstChild(custom, "G", True)
ok("grid: 3 columns -> UIGridLayout with aspect constraint, 2 slots", grid.FindFirstChildOfClass(grid, "UIGridLayout") and grid.FindFirstChildOfClass(grid, "UIGridLayout").FindFirstChildOfClass(grid.FindFirstChildOfClass(grid, "UIGridLayout"), "UIAspectRatioConstraint") and count_desc(grid, "ImageButton") == 2)
floating = custom.FindFirstChild(custom, "Floating")
ok("anchored root button: AnchorPoint (1,1), position 1,1 minus margin", floating.AnchorPoint.X == 1 and floating.AnchorPoint.Y == 1 and floating.Position.X.Scale < 1 and floating.Position.Y.Scale < 1 and floating.GetAttribute(floating, "OR_Action") == "toggle:Win")
ok("ScrollList children (settings) use offset heights, scale widths", all(c.Size.Y.Offset > 0 and c.Size.Y.Scale == 0 for c in SG().FindFirstChild(SG(), "Settings").FindFirstChild(SG().FindFirstChild(SG(), "Settings"), "Options", True).GetChildren(SG().FindFirstChild(SG(), "Settings").FindFirstChild(SG().FindFirstChild(SG(), "Settings"), "Options", True)).values() if c.IsA(c, "GuiObject")))

# ───────────────────────── 4. component place / errors ─────────────────────────
r = run("place")
ok("ui_component_place adds a pill into the HUD row", r.get("ok") and hud.FindFirstChild(hud, "Extra", True) is not None and "layout" in r["text"], r)
r = run("place_bad")
ok("ui_component_place rejects an unknown kind cleanly", r.get("ok") is False and "unknown component kind" in r.get("error", ""), r)

# ───────────────────────── 5. export / audit on generated UI ─────────────────────────
r = run("export")
ok("ui_export_spec round-trips the shop into a spec tree", r.get("ok") and r["data"]["spec"]["name"] == "Shop" and r["data"]["spec"]["children"][0]["kind"] == "Window" and r["data"]["nodes"] > 20, r if not r.get("ok") else r["data"]["nodes"])
r = run("audit")
if r.get("ok") and r["data"]["score"] < 70:
    for i in r["data"]["issues"]:
        print("      audit:", i["rule"], i["path"], i.get("detail", ""))
ok("ui_audit scores the generated screens high (no errors)", r.get("ok") and r["data"]["counts"]["error"] == 0 and r["data"]["score"] >= 70, r if not r.get("ok") else (r["data"]["score"], r["data"]["counts"], [i["rule"] + ":" + i["path"] for i in r["data"]["issues"][:6]]))

# ───────────────────────── 6. legacy UI: apply tokens / responsive / gamepad / states / audit ─────────────────────────
legacy = L.eval("""function(StarterGui)
  local sg=Instance.new('ScreenGui') sg.Name='Legacy' sg.ZIndexBehavior=Enum.ZIndexBehavior.Global sg.Parent=StarterGui
  local f=Instance.new('Frame') f.Name='Main' f.Size=UDim2.new(0,400,0,300) f.Position=UDim2.new(0,100,0,100) f.BackgroundColor3=Color3.fromRGB(200,200,200) f.Parent=sg
  local t=Instance.new('TextLabel') t.Name='Title' t.Size=UDim2.new(1,0,0,30) t.Text='Old title' t.TextSize=10 t.TextColor3=Color3.fromRGB(190,190,190) t.BackgroundTransparency=1 t.Parent=f
  for i=1,4 do local b=Instance.new('TextButton') b.Name='B'..i b.Size=UDim2.new(0,20,0,20) b.Position=UDim2.new(0,10+(i-1)*30,0,60) b.Text='b'..i b.BackgroundColor3=Color3.fromRGB(1,2,3) b.Parent=f end
  local o1=Instance.new('Frame') o1.Name='O1' o1.Size=UDim2.new(0,100,0,100) o1.Position=UDim2.new(0,0,0,150) o1.Parent=f
  local o2=Instance.new('Frame') o2.Name='O2' o2.Size=UDim2.new(0,100,0,100) o2.Position=UDim2.new(0,40,0,170) o2.Parent=f
  local s=Instance.new('ScrollingFrame') s.Name='S' s.Size=UDim2.new(0,100,0,50) s.Position=UDim2.new(0,250,0,150) s.Parent=f
  return sg
end""")(SG())
r = run("audit_legacy")
rules = {i["rule"] for i in r["data"]["issues"]} if r.get("ok") else set()
ok("ui_audit flags the legacy UI: contrast, tiny text, small targets, offset root, overlap, static canvas, zindex, no runtime", r.get("ok") and {"low_contrast", "tiny_text", "small_touch_target", "offset_only_root", "overlap", "static_canvas", "zindex_global", "no_runtime"} <= rules and r["data"]["score"] < 70, (r.get("data", {}).get("score"), sorted(rules)))
r = run("apply")
main = legacy.FindFirstChild(legacy, "Main")
ok("ui_apply_tokens restyles buttons to Primary and labels to token text", r.get("ok") and r["data"]["restyled"] >= 6 and same(main.FindFirstChild(main, "B1").BackgroundColor3, T.palette.Primary) and main.FindFirstChild(main, "Title").Font.Name in ("Arcade",), r)
r = run("responsive")
ok("ui_make_responsive converts the offset root to scale + constraints + OR_Responsive", r.get("ok") and r["data"]["converted_roots"] == 1 and main.Size.X.Scale > 0 and main.Size.X.Offset == 0 and main.FindFirstChildOfClass(main, "UIAspectRatioConstraint") and legacy.FindFirstChild(legacy, "OR_Responsive") and main.FindFirstChild(main, "Title").TextScaled is True, r)
r = run("gamepad")
b1, b2 = main.FindFirstChild(main, "B1"), main.FindFirstChild(main, "B2")
ok("ui_gamepad_focus links neighbours and adds a selection cursor", r.get("ok") and r["data"]["buttons"] == 4 and same(b1.NextSelectionRight, b2) and same(b2.NextSelectionLeft, b1) and b1.SelectionImageObject is not None and b1.Selectable is True, r)
r = run("states")
ok("ui_states_wire writes OR_Controller and default print actions", r.get("ok") and legacy.FindFirstChild(legacy, "OR_Controller") and b1.GetAttribute(b1, "OR_Action") == "print", r)
r = run("preview")
ok("ui_preview phone adds OR_PreviewScale 0.55 and shows the window", r.get("ok") and r["data"]["factor"] == 0.55 and win.FindFirstChild(win, "OR_PreviewScale") and win.Visible is True, r)
r = run("preview_restore")
ok("ui_preview restore removes the scale", r.get("ok") and win.FindFirstChild(win, "OR_PreviewScale") is None, r)

# ───────────────────────── 7. RUNTIME: controller + feeds as a client ─────────────────────────
M.isEdit = False
M.invalidate()
# clone StarterGui screens into PlayerGui like Roblox does, then run their LocalScripts
pgui = M.playerGui
clone_run = L.eval("""function(M, src, pg)
  local c = src:Clone() c.Parent = pg
  local ran, errs = 0, {}
  for _, d in ipairs(c:GetDescendants()) do
    if d:IsA('LocalScript') then
      local okR, err = pcall(M.runScript, d, true)
      ran = ran + 1
      if not okR then errs[#errs+1] = d.Name .. ': ' .. tostring(err) end
    end
  end
  return c, ran, errs
end""")
pshop, ran, errs = clone_run(M, shop, pgui)
ok("Shop LocalScripts run on a client (OR_Controller + OR_NotifyFeed)", ran == 2 and len(list(errs.values())) == 0, list(errs.values()))
pwin = pshop.FindFirstChild(pshop, "ShopWindow")
ok("controller: OR_StartHidden window is hidden on load", pwin.Visible is False)
# open with key B
inputB = py_to_lua({"KeyCode": {"Name": "B"}, "UserInputType": {"Name": "Keyboard"}})
UIS = game.GetService(game, "UserInputService")
UIS.InputBegan.Fire(UIS.InputBegan, inputB, False)
ok("controller: OR_OpenKey B opens the window (tween to scale 1)", pwin.Visible is True and pwin.FindFirstChild(pwin, "OR_Anim").Scale == 1)
closeBtn = pwin.FindFirstChild(pwin, "Close", True)
closeBtn.Activated.Fire(closeBtn.Activated)
ok("controller: Close button action hides the window", pwin.Visible is False and pwin.GetAttribute(pwin, "OR_Open") is False)
buy = [d for d in pwin.GetDescendants(pwin).values() if d.GetAttribute(d, "OR_Action") == "remote:OR_Shop_Buy"][0]
before = len(list(M.fired.values()))
buy.Activated.Fire(buy.Activated)
fired = list(M.fired.values())
last = lua_to_py(fired[-1]) if len(fired) > before else None
ok("controller: Buy button fires OR_Shop_Buy with {item}", last and last[0] == "OR_Shop_Buy" and last[1]["item"] in ("Sword", "Shield", "Potion"), last)
# hover state tween + tabs
tabBtns = [d for d in pwin.GetDescendants(pwin).values() if d.GetAttribute(d, "OR_Tab")]
tabBtns[1].Activated.Fire(tabBtns[1].Activated)
tabsRoot = pwin.FindFirstChild(pwin, "Categories", True)
pagesP = tabsRoot.FindFirstChild(tabsRoot, "Pages")
ok("controller/UIKit: clicking tab 2 switches pages", tabsRoot.GetAttribute(tabsRoot, "OR_ActiveTab") == "Gear" and pagesP.FindFirstChild(pagesP, "Page_Gear").Visible is True and pagesP.FindFirstChild(pagesP, "Page_All").Visible is False)
b = buy
base = b.BackgroundColor3
b.MouseEnter.Fire(b.MouseEnter)
hovered = b.BackgroundColor3
b.MouseLeave.Fire(b.MouseLeave)
ok("UIKit.wireButton: hover lightens, leave restores", not same(hovered, base) and same(b.BackgroundColor3, base) and b.FindFirstChild(b, "OR_PressScale") is not None)

# shop server handles the purchase
server = SSS.FindFirstChild(SSS, "OR_ShopServer")
M.runScript(server, False)
buyRemote = remotes.FindFirstChild(remotes, "OR_Shop_Buy")
buyRemote.OnServerEvent.Fire(buyRemote.OnServerEvent, M.fakePlayer, py_to_lua({"item": "Sword"}))
coinsV = M.fakePlayer.FindFirstChild(M.fakePlayer, "leaderstats").FindFirstChild(M.fakePlayer.FindFirstChild(M.fakePlayer, "leaderstats"), "Coins")
ok("OR_ShopServer: validates, charges 100 Coins, grants, notifies", coinsV.Value == 400 and M.fakePlayer.GetAttribute(M.fakePlayer, "Owns_Sword") is True and any("Bought Sword" in str(lua_to_py(f)) for f in list(M.fired.values())), coinsV.Value)
buyRemote.OnServerEvent.Fire(buyRemote.OnServerEvent, M.fakePlayer, py_to_lua({"item": "Nothing"}))
ok("OR_ShopServer: unknown item is refused with a warning", coinsV.Value == 400 and any("unknown item" in w for w in list(M.warnings.values())))

# HUD feeds
phud, ran, errs = clone_run(M, hud, pgui)
ok("HUD LocalScripts run (controller, hud feed, notify feed)", ran == 3 and len(list(errs.values())) == 0, list(errs.values()))
pill = phud.FindFirstChild(phud, "Coins", True)
ok("OR_HudFeed: currency pill shows leaderstats.Coins (400)", pill.FindFirstChild(pill, "Value").Text == "400", pill.FindFirstChild(pill, "Value").Text)
coinsV.Value = 12500
coinsV.Changed.Fire(coinsV.Changed)
ok("OR_HudFeed: live update formats 12.5K", pill.FindFirstChild(pill, "Value").Text == "12.5K", pill.FindFirstChild(pill, "Value").Text)

# settings toggles persist to player attributes
pset, ran, errs = clone_run(M, SG().FindFirstChild(SG(), "Settings"), pgui)
sw = [d for d in pset.GetDescendants(pset).values() if d.GetAttribute(d, "OR_Setting") == "music"][0]
sw.Activated.Fire(sw.Activated)
ok("Settings: toggle flips OR_Toggle and persists Setting_music", len(list(errs.values())) == 0 and sw.GetAttribute(sw, "OR_Toggle") is False and M.fakePlayer.GetAttribute(M.fakePlayer, "Setting_music") is False, list(errs.values()))

# daily server
M.runScript(SSS.FindFirstChild(SSS, "OR_DailyServer"), False)
claim = remotes.FindFirstChild(remotes, "OR_Daily_Claim")
res = lua_to_py(claim.InvokeServer(claim, py_to_lua({})))
res2 = lua_to_py(claim.InvokeServer(claim, py_to_lua({})))
ok("OR_DailyServer: first claim pays day 1 (+10), second is on cooldown", res["ok"] is True and res["day"] == 1 and res["reward"] == 10 and res2["ok"] is False and "Come back" in res2["message"], (res, res2))
ok("OR_DailyServer: claim persisted to DataStore OR_DailyRewards", M.dsCalls >= 2 and lua_to_py(M.datastores["OR_DailyRewards"]["1"])["day"] == 1, (M.dsCalls,))

# dialog typewriter + leaderboard feed + loading script compile
pdlg, ran, errs = clone_run(M, SG().FindFirstChild(SG(), "Dialog"), pgui)
line = pdlg.FindFirstChild(pdlg, "Line", True)
ok("Dialog: typewriter label animates MaxVisibleGraphemes", len(list(errs.values())) == 0 and line.MaxVisibleGraphemes == len(line.Text) and len(line.Text) > 0, (list(errs.values()), line.MaxVisibleGraphemes))
plb_errs = None
try:
    plb, ran, errs = clone_run(M, SG().FindFirstChild(SG(), "Leaderboard"), pgui)
    plb_errs = list(errs.values())
except Exception as e:  # the feed loops with task.wait; the simulator's wait budget stops it
    plb_errs = [str(e)]
ok("Leaderboard feed runs until the simulated wait budget (no runtime error before it)", plb_errs is not None and all("wait budget" in e for e in plb_errs), plb_errs)
RF = game.GetService(game, "ReplicatedFirst")
loadingScript = RF.FindFirstChild(RF, "OR_Loading")
M.waits = 0  # the leaderboard poll loop above deliberately spent the main-thread wait budget
resL = L.eval("function(M,s) local okR, err = pcall(M.runScript, s, true) return {okR, err} end")(M, loadingScript)
okL, errL = resL[1], resL[2]
ok("OR_Loading runs end-to-end (preload, progress, fade, destroy)", okL and pgui.FindFirstChild(pgui, "LoadingScreen") is None, errL)

failed = results.count(False)
print("\n%d passed, %d failed" % (len(results) - failed, failed))
sys.exit(1 if failed else 0)
