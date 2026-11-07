#!/usr/bin/env python3
"""Verify pack (2.12.1) - place_checkpoint + ui_test against the miniature Roblox DataModel.

tests/test-verify-pack.js checks the pack statically (registration, params, validation,
wiring). This script runs the REAL generated Luau in tests/roblox_sim.py:

  place_checkpoint  save a model -> entry in ServerStorage._TotalCheckpoints with attributes;
                    mutate the model (colour, size, delete a part, add a part, edit a script);
                    diff names exactly those changes; restore brings the saved tree back under
                    the original parent (diff is empty again); a Lighting checkpoint restores
                    properties + children; list / delete; validation errors are explicit.
  ui_test           a ScreenGui with a Total_Action button + Total_Controller, a ui_state_toggle
                    button, a button wired by an external LocalScript and a DEAD button:
                    classification, simulated toggle / close / open clicks against expect,
                    unsimulable clicks reported, phone touch-size warnings, the live_plan
                    (user_mouse_input with PlayerGui paths), expect_only against the state.

Everything here is a MOCK of Roblox; a real Studio run is still the final word.

    pip install lupa && python3 tests/verify-sim.py          (from the TotalScript root)
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
const S=RobloxScriptSkills; const want=JSON.parse(process.argv[1]); const out={programs:{}, libLen:S.VERIFY_LIB.length};
for(const [k,[n,a]] of Object.entries(want)){ let r; try{ r=S.buildLuau(n,a);}catch(e){ r={err:String(e)}; } out.programs[k]=r&&r.code?r.code:("--ERR "+(r&&r.err)); }
process.stdout.write(JSON.stringify(out));
"""

WANT = {
    "list_empty": ["place_checkpoint", {"op": "list"}],
    "save_shop": ["place_checkpoint", {"op": "save", "path": "Workspace.Shop", "name": "shop_v1", "label": "before restyle"}],
    "save_missing": ["place_checkpoint", {"op": "save", "path": "Workspace.Nothing"}],
    "save_game": ["place_checkpoint", {"op": "save", "path": "game"}],
    "diff_clean": ["place_checkpoint", {"op": "diff", "name": "shop_v1"}],
    "diff_dirty": ["place_checkpoint", {"op": "diff", "name": "shop_v1"}],
    "restore_shop": ["place_checkpoint", {"op": "restore", "name": "shop_v1"}],
    "diff_after_restore": ["place_checkpoint", {"op": "diff", "name": "shop_v1"}],
    "restore_unknown": ["place_checkpoint", {"op": "restore", "name": "nope"}],
    "save_lighting": ["place_checkpoint", {"op": "save", "path": "Lighting", "name": "light_v1"}],
    "restore_lighting": ["place_checkpoint", {"op": "restore", "name": "light_v1"}],
    "list_two": ["place_checkpoint", {"op": "list"}],
    "delete_one": ["place_checkpoint", {"op": "delete", "name": "light_v1"}],
    "delete_all": ["place_checkpoint", {"op": "delete", "name": "*"}],
    "bad_op": ["place_checkpoint", {"op": "zap"}],
    "ui_static": ["ui_test", {"path": "StarterGui.ShopGui"}],
    "ui_sim": ["ui_test", {"path": "StarterGui.ShopGui", "actions": [{"click": "OpenShop"}, {"click": "Toggle2"}, {"click": "Custom"}, {"click": "Dead"}, {"click": "Ghost"}],
                            "expect": [{"path": "Window", "Visible": True}, {"path": "Panel2", "Visible": True}, {"path": "Title", "Text": "SHOP"}, {"path": "Nowhere", "Visible": True}]}],
    "ui_close": ["ui_test", {"path": "StarterGui.ShopGui", "actions": [{"click": "OpenShop"}, {"click": "Close"}], "expect": [{"path": "Window", "Visible": False}]}],
    "ui_expect_only": ["ui_test", {"path": "StarterGui.ShopGui", "expect_only": True, "expect": [{"path": "Window", "Visible": False}, {"path": "Title", "Text": "SHOP"}]}],
    "ui_not_gui": ["ui_test", {"path": "Workspace.Shop"}],
    "ui_bad_actions": ["ui_test", {"path": "StarterGui.ShopGui", "actions": ["OpenShop"]}],
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
lua = L.execute

# ── fixtures ──────────────────────────────────────────────────────────────
lua(r"""
local shop = Instance.new("Model") shop.Name = "Shop"
local floor = Instance.new("Part") floor.Name = "Floor" floor.Size = Vector3.new(20, 1, 20) floor.CFrame = CFrame.new(0, 0.5, 0) floor.Anchored = true floor.Color = Color3.new(0.5, 0.5, 0.5) floor.Parent = shop
local wall = Instance.new("Part") wall.Name = "Wall" wall.Size = Vector3.new(20, 8, 1) wall.CFrame = CFrame.new(0, 5, -10) wall.Anchored = true wall.Parent = shop
local sign = Instance.new("Part") sign.Name = "Sign" sign.Size = Vector3.new(6, 2, 0.5) sign.CFrame = CFrame.new(0, 9, -9.5) sign.Anchored = true sign.Parent = shop
local lamp = Instance.new("PointLight") lamp.Name = "Lamp" lamp.Brightness = 2 lamp.Parent = sign
local s = Instance.new("Script") s.Name = "Logic" s.Source = "print('v1')" s.Parent = shop
shop.PrimaryPart = floor shop.Parent = workspace

local sg = Instance.new("ScreenGui") sg.Name = "ShopGui" sg.Parent = game:GetService("StarterGui")
local win = Instance.new("Frame") win.Name = "Window" win.Size = UDim2.new(0.5, 0, 0.6, 0) win.Visible = false win:SetAttribute("Total_Window", true) win.Parent = sg
local title = Instance.new("TextLabel") title.Name = "Title" title.Text = "SHOP" title.Size = UDim2.new(1, 0, 0.1, 0) title.Parent = win
local close = Instance.new("TextButton") close.Name = "Close" close.Size = UDim2.new(0.1, 0, 0.1, 0) close:SetAttribute("Total_Action", "close") close.Parent = win
local open = Instance.new("TextButton") open.Name = "OpenShop" open.Size = UDim2.new(0, 160, 0, 48) open:SetAttribute("Total_Action", "toggle:Window") open.Parent = sg
local panel2 = Instance.new("Frame") panel2.Name = "Panel2" panel2.Size = UDim2.new(0.3, 0, 0.3, 0) panel2.Visible = false panel2.Parent = sg
local t2 = Instance.new("TextButton") t2.Name = "Toggle2" t2.Size = UDim2.new(0, 120, 0, 20) t2.Parent = sg
local ls = Instance.new("LocalScript") ls.Name = "Total_Toggle" ls.Source = '-- TotalScript ui_state_toggle: toggle\nlocal TARGET = "StarterGui.ShopGui.Panel2"\nscript.Parent.Activated:Connect(function() end)' ls.Parent = t2
local custom = Instance.new("ImageButton") custom.Name = "Custom" custom.Size = UDim2.new(0, 60, 0, 60) custom.Parent = sg
local dead = Instance.new("TextButton") dead.Name = "Dead" dead.Size = UDim2.new(0, 200, 0, 50) dead.Parent = sg
local ctrl = Instance.new("LocalScript") ctrl.Name = "Total_Controller" ctrl.Source = "-- Total_Controller" ctrl.Parent = sg
local ext = Instance.new("LocalScript") ext.Name = "ShopClient" ext.Source = 'local b = gui:WaitForChild("Custom")\nb.MouseButton1Click:Connect(function() print("custom") end)' ext.Parent = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts") or sg
""")

ok("generator: VERIFY_LIB is a single shared library (> 20k chars, cached by main.js after the first run)", data["libLen"] > 20000, data["libLen"])

# ── checkpoints ──────────────────────────────────────────────────────────
r = run("list_empty", programs["list_empty"])
ok("list with no store: ok, count 0, tells how to save", r.get("ok") and r["data"]["count"] == 0 and "save" in r["text"], r)

r = run("save_shop", programs["save_shop"])
ok("save Workspace.Shop: entry shop_v1 under ServerStorage._TotalCheckpoints, kind instance, 5 descendants", r.get("ok") and r["data"]["name"] == "shop_v1" and r["data"]["kind"] == "instance" and r["data"]["descendants"] == 5 and r["data"]["store"].endswith("._TotalCheckpoints.shop_v1"), r)
attrs = L.eval("function() local e = game:GetService('ServerStorage')._TotalCheckpoints.shop_v1 return M.jsonEncode({label=e:GetAttribute('Total_Label'), src=e:GetAttribute('Total_Source'), cls=e:GetAttribute('Total_Class'), n=e:GetAttribute('Total_Count'), saved=#e.Saved:GetChildren(), savedName=e.Saved:GetChildren()[1].Name, savedParts=#e.Saved:GetChildren()[1]:GetDescendants(), map=e.Map.Value}) end")()
attrs = json.loads(attrs)
ok("the entry carries label / source / class / count attributes and a full Clone (5 descendants) plus a Map", attrs["label"] == "before restyle" and attrs["src"] == "Workspace.Shop" and attrs["cls"] == "Model" and attrs["n"] == 5 and attrs["saved"] == 1 and attrs["savedName"] == "Shop" and attrs["savedParts"] == 5 and '"Shop.Floor"' in attrs["map"], attrs)
ok("the original is untouched by save", L.eval("function() return #workspace.Shop:GetDescendants() end")() == 5)

r = run("save_missing", programs["save_missing"])
ok("save of a missing path fails with the path named", not r.get("ok") and "Workspace.Nothing" in r["error"], r)
r = run("save_game", programs["save_game"])
ok("save of the whole game is refused", not r.get("ok") and "whole game" in r["error"], r)

r = run("diff_clean", programs["diff_clean"])
ok("diff right after save: identical, 0/0/0", r.get("ok") and r["data"]["identical"] is True and r["data"]["added_count"] == 0 and r["data"]["removed_count"] == 0 and r["data"]["changed_count"] == 0 and "nothing changed" in r["text"], r)

lua(r"""
local shop = workspace.Shop
shop.Wall.Color = Color3.new(1, 0, 0)
shop.Floor.Size = Vector3.new(30, 1, 30)
shop.Sign:Destroy()
local door = Instance.new("Part") door.Name = "Door" door.Parent = shop
shop.Logic.Source = "print('v2')"
""")
r = run("diff_dirty", programs["diff_dirty"])
d = r.get("data", {})
ok("diff after edits: Door added; Sign (+ its Lamp) removed; Wall color, Floor size, Logic source changed - nothing else", r.get("ok") and d["added_count"] == 1 and d["added"] == ["Shop.Door (Part)"] and d["removed_count"] == 2 and sorted(d["removed"]) == ["Shop.Sign (Part)", "Shop.Sign.Lamp (PointLight)"] and d["changed_count"] == 3 and {c["path"]: c["fields"] for c in d["changed"]} == {"Shop.Wall": ["color"], "Shop.Floor": ["size"], "Shop.Logic": ["source"]}, d)
ok("diff text summarises counts", "1 added, 2 removed, 3 changed" in r.get("text", ""), r.get("text"))

r = run("restore_shop", programs["restore_shop"])
ok("restore: current Shop replaced (1 removed), restored at Workspace.Shop with 5 descendants", r.get("ok") and r["data"]["removed"] == 1 and r["data"]["restored"] == "Workspace.Shop" and r["data"]["descendants"] == 5, r)
after = json.loads(L.eval("function() local s = workspace.Shop return M.jsonEncode({sign = s:FindFirstChild('Sign') ~= nil, door = s:FindFirstChild('Door') ~= nil, wallR = s.Wall.Color.R, floorX = s.Floor.Size.X, src = s.Logic.Source, one = #workspace:GetChildren()}) end")())
ok("restored tree has Sign back, no Door, the wall is not red any more, 20-stud floor, v1 script", after["sign"] and not after["door"] and after["wallR"] < 0.9 and after["floorX"] == 20 and after["src"] == "print('v1')", after)
ok("only one Shop exists in Workspace after restore", L.eval("function() local n = 0 for _, c in ipairs(workspace:GetChildren()) do if c.Name == 'Shop' then n = n + 1 end end return n end")() == 1)
r = run("diff_after_restore", programs["diff_after_restore"])
ok("diff after restore is identical again (the checkpoint is kept)", r.get("ok") and r["data"]["identical"] is True, r)
r = run("restore_unknown", programs["restore_unknown"])
ok("restore of an unknown name fails and points at {op:'list'}", not r.get("ok") and "not found" in r["error"] and "list" in r["error"], r)

lua("local L = game:GetService('Lighting') L.Brightness = 2 L.ClockTime = 14 local sky = Instance.new('Sky') sky.Name = 'Sky' sky.Parent = L local bloom = Instance.new('BloomEffect') bloom.Name = 'Bloom' bloom.Parent = L")
r = run("save_lighting", programs["save_lighting"])
ok("save Lighting: kind service, 2 children cloned, properties stored", r.get("ok") and r["data"]["kind"] == "service" and r["data"]["saved_children"] == 2 and json.loads(L.eval("function() return game:GetService('ServerStorage')._TotalCheckpoints.light_v1.Props.Value end")()).get("Brightness") == 2, r)
lua("local L = game:GetService('Lighting') L.Brightness = 0.3 L.ClockTime = 2 L.Sky:Destroy() local fog = Instance.new('Atmosphere') fog.Name = 'Atmosphere' fog.Parent = L")
r = run("restore_lighting", programs["restore_lighting"])
light = json.loads(L.eval("function() local L = game:GetService('Lighting') return M.jsonEncode({b = L.Brightness, c = L.ClockTime, sky = L:FindFirstChild('Sky') ~= nil, atm = L:FindFirstChild('Atmosphere') ~= nil, bloom = L:FindFirstChild('Bloom') ~= nil, n = #L:GetChildren()}) end")())
ok("restore Lighting: Brightness 2 / ClockTime 14 back, Sky + Bloom back, Atmosphere gone", r.get("ok") and r["data"]["props_applied"] >= 2 and light["b"] == 2 and light["c"] == 14 and light["sky"] and light["bloom"] and not light["atm"] and light["n"] == 2, (r, light))

r = run("list_two", programs["list_two"])
ok("list: 2 checkpoints newest first with source / kind / count / age", r.get("ok") and r["data"]["count"] == 2 and {c["name"] for c in r["data"]["checkpoints"]} == {"shop_v1", "light_v1"} and all("age_s" in c and "source" in c for c in r["data"]["checkpoints"]), r)
r = run("delete_one", programs["delete_one"])
ok("delete one by name", r.get("ok") and r["data"]["removed"] == 1 and L.eval("function() return #game:GetService('ServerStorage')._TotalCheckpoints:GetChildren() end")() == 1, r)
r = run("delete_all", programs["delete_all"])
ok("delete '*' clears the store", r.get("ok") and r["data"]["removed"] == 1 and L.eval("function() return #game:GetService('ServerStorage')._TotalCheckpoints:GetChildren() end")() == 0, r)
r = run("bad_op", programs["bad_op"])
ok("unknown op is rejected before any Luau runs", not r.get("ok") and "save|restore|list|diff|delete" in r["error"], r)

# ── ui_test ──────────────────────────────────────────────────────────────
r = run("ui_static", programs["ui_static"])
d = r.get("data", {})
byname = {b["name"]: b for b in d.get("wired", []) + d.get("dead", [])}
ok("static: 5 buttons found under StarterGui.ShopGui", r.get("ok") and d.get("buttons") == 5, r)
ok("OpenShop + Close are wired by Total_Action (controller present)", byname.get("OpenShop", {}).get("how") == "attribute" and "toggle:Window" in byname["OpenShop"]["detail"] and byname.get("Close", {}).get("how") == "attribute", byname)
ok("Toggle2 is wired by its ui_state_toggle LocalScript", byname.get("Toggle2", {}).get("how") == "toggle_script" and "ui_state_toggle toggle" in byname["Toggle2"]["detail"], byname.get("Toggle2"))
ok("Custom is wired by an external LocalScript (StarterPlayerScripts) that names it + MouseButton1Click", byname.get("Custom", {}).get("how") == "external_script" and "MouseButton1Click" in byname["Custom"]["detail"], byname.get("Custom"))
ok("Dead is reported as DEAD with the reason", [b["name"] for b in d.get("dead", [])] == ["Dead"] and "no Total_Action" in d["dead"][0]["detail"], d.get("dead"))
ok("touch sizes: Toggle2 (120x20 offset) flagged < 36 px on phones; the 0.1-scale Close inside the 0.5/0.6 window is 42x23 on phone -> flagged; OpenShop 160x48 fine", {s["name"] for s in d.get("small_targets", [])} == {"Toggle2", "Close"} and byname["OpenShop"]["size_phone"] == [160, 48] and byname["Close"]["size_desktop"] == [64, 43], d.get("small_targets"))
ok("verdict names counts and says static only", "5 button(s): 4 wired, 1 DEAD" in r.get("text", "") and "Static + simulated only" in r["text"], r.get("text"))
ok("live_plan: start_stop_play first, then get_console_output; no clicks without actions", d.get("live_plan") and d["live_plan"][0]["tool"] == "start_stop_play" and d["live_plan"][-1]["tool"] == "get_console_output" and len(d["live_plan"]) == 2, d.get("live_plan"))

r = run("ui_sim", programs["ui_sim"])
d = r.get("data", {})
sim = {s["click"]: s for s in d.get("simulated", [])}
uns = {s["click"]: s for s in d.get("not_simulated", [])}
ok("simulated: OpenShop toggles Window visible, Toggle2 shows Panel2 (ui_state_toggle)", sim.get("OpenShop", {}).get("effect") == "Window.Visible=true" and sim.get("Toggle2", {}).get("effect", "").startswith("Panel2.Visible=true"), sim)
ok("not simulable: Custom (external script), Dead (DEAD BUTTON), Ghost (no such button) - each with a reason", "custom script" in uns.get("Custom", {}).get("reason", "") and "DEAD BUTTON" in uns.get("Dead", {}).get("reason", "") and "no GuiButton named Ghost" in uns.get("Ghost", {}).get("reason", ""), uns)
ex = {e["path"]: e for e in d.get("expectations", [])}
ok("expectations: Window visible PASS, Panel2 visible PASS, Title text PASS, Nowhere -> not found FAIL", ex["Window"]["pass"] and ex["Panel2"]["pass"] and ex["Title"]["pass"] and ex["Nowhere"]["pass"] is False and ex["Nowhere"]["reason"] == "not found" and d["failed_expectations"] == 1, ex)
ok("the simulation never mutates the real GUI (Window still hidden in Studio)", L.eval("function() return game:GetService('StarterGui').ShopGui.Window.Visible end")() is False)
plan = d.get("live_plan", [])
clicks = [p for p in plan if p["tool"] == "user_mouse_input"]
ok("live_plan: 4 user_mouse_input clicks (Ghost skipped) with PlayerGui instance paths + a ui_test {expect_only} re-check", len(clicks) == 4 and clicks[0]["arguments"]["actions"][0] == {"action": "mouseButtonClick", "mouse_button": "left", "instance_path": "game.Players.LocalPlayer.PlayerGui.ShopGui.OpenShop"} and clicks[0]["arguments"]["datamodel_type"] == "Client" and any(p["tool"] == "ui_test" and p["arguments"].get("expect_only") is True for p in plan), plan)
ok("verified field is honest: static_and_simulated", d.get("verified") == "static_and_simulated")

r = run("ui_close", programs["ui_close"])
d = r.get("data", {})
ok("close: OpenShop opens Window, Close (Total_Action close inside the Total_Window) hides it -> expect Visible:false passes", r.get("ok") and d["simulated"][1]["effect"] == "Window.Visible=false" and d["expectations"][0]["pass"] and d["failed_expectations"] == 0, d.get("simulated"))

r = run("ui_expect_only", programs["ui_expect_only"])
d = r.get("data", {})
ok("expect_only: evaluates the current (edit-mode) state, no simulation, verified=edit_state", r.get("ok") and d["verified"] == "edit_state" and d["failed_expectations"] == 0 and d["simulated"] == [] and "edit-mode" in r["text"], r)

r = run("ui_not_gui", programs["ui_not_gui"])
ok("a non-GUI path is rejected with its class", not r.get("ok") and "Model" in r["error"], r)
r = run("ui_bad_actions", programs["ui_bad_actions"])
ok("bare-string actions are rejected before any Luau runs", not r.get("ok") and "click:'ButtonName'" in r["error"], r)

print("\n%s verify-sim: %d passed, %d failed" % ("OK   " if failed == 0 else "FAIL ", passed, failed))
sys.exit(1 if failed else 0)
