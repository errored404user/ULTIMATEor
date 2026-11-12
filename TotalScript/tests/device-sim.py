#!/usr/bin/env python3
"""Device pack (2.21.0) - device_audit + device_fix against the miniature Roblox DataModel.

tests/test-device-pack.js checks the pack statically (registration, params, validation,
wiring, prompt budget). This script runs the REAL generated Luau in tests/roblox_sim.py
on a deliberately bad HUD + a clean one:

  device_audit   touch targets under 36 px (error < 28), offset-only sizes, elements leaving
                 the phone screen, topbar overlap under IgnoreGuiInset, the touch-control
                 zones, unbounded TextScaled, TextSize < 14, clipped text, stretched images,
                 ScreenInsets None, Selectable = false, no SelectedObject entry, keyboard-only
                 LocalScripts (KeyCode + InputBegan without ContextActionService / touch /
                 gamepad) vs a script with ContextActionService; a clean GUI reports nothing;
                 path scoping; limit.
  device_fix     default ops add UITextSizeConstraint / UISizeConstraint / Selectable /
                 ScreenInsets exactly once (idempotent); scale_sizes converts offset-only
                 Size / Position to Scale and adds aspect constraints; audit after fix drops
                 the mechanical findings; validation errors are explicit.

Everything here is a MOCK of Roblox; the Studio device emulator is still the final word.

    pip install lupa && python3 tests/device-sim.py          (from the TotalScript root)
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
const S=RobloxScriptSkills; const want=JSON.parse(process.argv[1]); const out={programs:{}, libLen:S.DEVICE_LIB.length};
for(const [k,[n,a]] of Object.entries(want)){ let r; try{ r=S.buildLuau(n,a);}catch(e){ r={err:String(e)}; } out.programs[k]=r&&r.code?r.code:("--ERR "+(r&&r.err)); }
process.stdout.write(JSON.stringify(out));
"""

WANT = {
    "audit_all": ["device_audit", {}],
    "audit_bad": ["device_audit", {"path": "StarterGui.BadHud"}],
    "audit_clean": ["device_audit", {"path": "StarterGui.CleanHud"}],
    "audit_limit": ["device_audit", {"path": "StarterGui.BadHud", "limit": 3}],
    "audit_not_gui": ["device_audit", {"path": "Workspace"}],
    "audit_bad_limit": ["device_audit", {"limit": 0}],
    "fix_default": ["device_fix", {"path": "StarterGui.BadHud"}],
    "fix_again": ["device_fix", {"path": "StarterGui.BadHud"}],
    "fix_scale": ["device_fix", {"path": "StarterGui.BadHud", "ops": ["scale_sizes", "aspect_images"]}],
    "fix_bad_op": ["device_fix", {"ops": ["make_it_pretty"]}],
    "fix_bad_touch": ["device_fix", {"min_touch": 5}],
    "fix_bad_text": ["device_fix", {"min_text": 30, "max_text": 20}],
    "audit_after": ["device_audit", {"path": "StarterGui.BadHud"}],
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
local SG = game:GetService("StarterGui")
local SP = game:GetService("StarterPlayer")
local sps = SP:FindFirstChild("StarterPlayerScripts")
if not sps then sps = Instance.new("StarterPlayerScripts") sps.Name = "StarterPlayerScripts" sps.Parent = SP end

-- a HUD authored for a 1920-wide monitor with every classic mistake
local bad = Instance.new("ScreenGui") bad.Name = "BadHud" bad.IgnoreGuiInset = true bad.ScreenInsets = Enum.ScreenInsets.None bad.Parent = SG
local panel = Instance.new("Frame") panel.Name = "Panel" panel.Size = UDim2.new(0, 900, 0, 500) panel.Position = UDim2.new(0, 100, 0, 100) panel.Parent = bad
local tiny = Instance.new("TextButton") tiny.Name = "Tiny" tiny.Size = UDim2.new(0, 24, 0, 24) tiny.Position = UDim2.new(0, 10, 0, 10) tiny.Text = "x" tiny.Parent = panel
local smallish = Instance.new("ImageButton") smallish.Name = "Smallish" smallish.Size = UDim2.new(0, 32, 0, 32) smallish.Position = UDim2.new(0, 50, 0, 10) smallish.Parent = panel
local far = Instance.new("TextButton") far.Name = "FarRight" far.Size = UDim2.new(0, 120, 0, 48) far.Position = UDim2.new(0, 1700, 0, 900) far.Text = "Menu" far.Parent = bad
local coins = Instance.new("TextLabel") coins.Name = "Coins" coins.Size = UDim2.new(0, 60, 0, 20) coins.Position = UDim2.new(0.5, 0, 0.9, 0) coins.Text = "999,999,999 COINS" coins.TextSize = 14 coins.Parent = bad
local top = Instance.new("TextLabel") top.Name = "TopTitle" top.Size = UDim2.new(1, 0, 0, 40) top.Position = UDim2.new(0, 0, 0, 0) top.Text = "WELCOME TO THE BEST GAME EVER MADE BY ANYONE" top.TextSize = 12 top.Parent = bad
local scaled = Instance.new("TextLabel") scaled.Name = "Scaled" scaled.Size = UDim2.new(0.3, 0, 0.1, 0) scaled.Position = UDim2.new(0.35, 0, 0.5, 0) scaled.TextScaled = true scaled.Text = "SCORE" scaled.Parent = bad
local jump = Instance.new("TextButton") jump.Name = "Attack" jump.Size = UDim2.new(0, 80, 0, 80) jump.Position = UDim2.new(1, -90, 1, -90) jump.Text = "ATK" jump.Parent = bad
local nosel = Instance.new("TextButton") nosel.Name = "NoSelect" nosel.Size = UDim2.new(0.2, 0, 0.1, 0) nosel.Position = UDim2.new(0.4, 0, 0.2, 0) nosel.Selectable = false nosel.Text = "Play" nosel.Parent = bad
local icon = Instance.new("ImageLabel") icon.Name = "Icon" icon.Size = UDim2.new(0.1, 0, 0.15, 0) icon.Position = UDim2.new(0.8, 0, 0.3, 0) icon.Image = "rbxassetid://1" icon.Parent = bad
local keys = Instance.new("LocalScript") keys.Name = "Abilities" keys.Source = [[
local UIS = game:GetService("UserInputService")
UIS.InputBegan:Connect(function(input, gp)
  if gp then return end
  if input.KeyCode == Enum.KeyCode.E then print("dash") end
  if input.KeyCode == Enum.KeyCode.Q then print("block") end
end)
]] keys.Parent = sps
local good = Instance.new("LocalScript") good.Name = "Sprint" good.Source = [[
local CAS = game:GetService("ContextActionService")
CAS:BindAction("Sprint", function() end, true, Enum.KeyCode.LeftShift, Enum.KeyCode.ButtonL3)
]] good.Parent = sps
local mouse = Instance.new("LocalScript") mouse.Name = "Aim" mouse.Source = "local m = game.Players.LocalPlayer:GetMouse()\nm.Button1Down:Connect(function() end)" mouse.Parent = bad

-- a HUD done right
local clean = Instance.new("ScreenGui") clean.Name = "CleanHud" clean.Parent = SG
local bar = Instance.new("Frame") bar.Name = "Bar" bar.Size = UDim2.new(0.4, 0, 0.08, 0) bar.Position = UDim2.new(0.3, 0, 0.02, 0) bar.Parent = clean
local hp = Instance.new("TextLabel") hp.Name = "HP" hp.Size = UDim2.new(1, 0, 1, 0) hp.TextScaled = true hp.Text = "100" hp.Parent = bar
local c1 = Instance.new("UITextSizeConstraint") c1.MinTextSize = 14 c1.MaxTextSize = 40 c1.Parent = hp
local btn = Instance.new("TextButton") btn.Name = "Shop" btn.Size = UDim2.new(0.12, 0, 0.1, 0) btn.Position = UDim2.new(0.44, 0, 0.5, 0) btn.Text = "Shop" btn.TextScaled = true btn.Parent = clean
local c2 = Instance.new("UITextSizeConstraint") c2.MinTextSize = 14 c2.MaxTextSize = 32 c2.Parent = btn
local sc = Instance.new("UISizeConstraint") sc.MinSize = Vector2.new(44, 44) sc.Parent = btn
local nav = Instance.new("LocalScript") nav.Name = "Nav" nav.Source = "game:GetService('GuiService').SelectedObject = script.Parent.Shop" nav.Parent = clean
""")

ok("generator: DEVICE_LIB is one shared library (> 12k chars, cached by main.js after the first run)", data["libLen"] > 12000, data["libLen"])

def rules(r): return sorted(set(f["rule"] for f in r["data"]["findings"]))
def by(r, rule): return [f for f in r["data"]["findings"] if f["rule"] == rule]

# ── audit: the bad HUD ────────────────────────────────────────────────────
r = run("audit_bad", programs["audit_bad"])
ok("audit BadHud: ok, verified static_layout_simulation, 1 GUI, scripts counted (Aim inside + 2 in StarterPlayerScripts)", r.get("ok") and r["data"]["verified"] == "static_layout_simulation" and r["data"]["guis"] == ["BadHud"] and r["data"]["scripts_checked"] == 3, r)
tt = by(r, "touch_target")
ok("touch targets: Tiny 24 px is an error, Smallish 32 px a warning, both on the phone, once each (tablet deduped)", len(tt) == 2 and {f["path"].split(".")[-1]: (f["severity"], f["device"]) for f in tt} == {"Tiny": ("error", "phone"), "Smallish": ("warn", "phone")}, tt)
ok("offset-only 900x500 panel flagged with phone percentages", any("Panel" in f["path"] and "107%" in f["detail"] for f in by(r, "offset_only_size")), by(r, "offset_only_size"))
off = by(r, "offscreen")
ok("FarRight at 1700,900 px and the 900x500 panel leave the phone screen; both still fit a 1920x1080 TV (no console row)", {(f["path"].split(".")[-1], f["device"]) for f in off} == {("FarRight", "phone"), ("Panel", "phone")}, off)
ok("TopTitle under the topbar (IgnoreGuiInset) + TextSize 12 too small (phone) + ten-foot note (console); Coins 60 px box clips its 17-char text", any("TopTitle" in f["path"] for f in by(r, "topbar_overlap")) and any("TopTitle" in f["path"] for f in by(r, "text_small")) and any("TopTitle" in f["path"] and f["device"] == "console" for f in by(r, "text_tv")) and any("Coins" in f["path"] and "needs ~124 px" in f["detail"] for f in by(r, "text_clipped")), [f for f in r["data"]["findings"] if "TopTitle" in f["path"] or "Coins" in f["path"]])
ok("TextScaled without UITextSizeConstraint flagged (Scaled), fix op text_constraints", any("Scaled" in f["path"] and "text_constraints" in f["fix"] for f in by(r, "text_unbounded")), by(r, "text_unbounded"))
ok("Attack button sits in the bottom-right jump zone on the phone", any("Attack" in f["path"] and "jump" in f["detail"] for f in by(r, "touch_controls_overlap")), by(r, "touch_controls_overlap"))
ok("NoSelect: Selectable=false is a console error with fix op selectable", any("NoSelect" in f["path"] and f["severity"] == "error" and f["device"] == "console" for f in by(r, "gamepad_unreachable")), by(r, "gamepad_unreachable"))
ok("scale-sized Icon without aspect constraint flagged image_stretch", any("Icon" in f["path"] for f in by(r, "image_stretch")), by(r, "image_stretch"))
ok("ScreenInsets None flagged with fix op safe_insets", any(f["path"].endswith("BadHud") and "safe_insets" in f["fix"] for f in by(r, "safe_insets")), by(r, "safe_insets"))
ko = by(r, "keyboard_only")
ok("Abilities (KeyCode E/Q + InputBegan, no CAS) is keyboard-only with the ContextActionService fix; Sprint (BindAction) is not", len(ko) == 1 and ko[0]["path"].endswith("Abilities") and "E, Q" in ko[0]["detail"] and "BindAction" in ko[0]["fix"] and r["data"]["keyboard_only_scripts"][0]["keys"] == ["E", "Q"], ko)
ok("Aim (GetMouse only) is an info note", any(f["path"].endswith("Aim") and f["severity"] == "info" for f in by(r, "mouse_api")), by(r, "mouse_api"))
ok("no script sets SelectedObject inside BadHud's scope -> gamepad_entry note; buttons counted", any(f["rule"] == "gamepad_entry" for f in r["data"]["findings"]) and r["data"]["buttons"] == 5 and r["data"]["selectable_buttons"] == 4, r["data"]["buttons"])
ok("fix_ops lists the mechanical ops in finding order and the text names the next step", set(r["data"]["fix_ops"]) == {"safe_insets", "selectable", "scale_sizes", "text_constraints", "aspect_images", "min_touch_size"} and "device_fix {ops:" in r["text"] and "ContextActionService" in r["text"] and "device emulator" in r["text"], (r["data"]["fix_ops"], r["text"]))
ok("by_device / by_severity totals agree with the findings", sum(r["data"]["by_severity"].values()) == len(r["data"]["findings"]) and sum(sum(d.values()) for d in r["data"]["by_device"].values()) == len(r["data"]["findings"]), (r["data"]["by_severity"], r["data"]["by_device"]))
ok("place facts reported (orientation / touch movement names or '?')", set(r["data"]["place"].keys()) == {"screen_orientation", "touch_movement", "touch_camera"}, r["data"]["place"])

# ── audit: the clean HUD ──────────────────────────────────────────────────
r = run("audit_clean", programs["audit_clean"])
ok("CleanHud: the GUI itself has no findings (scale sizes, constraints, 44 px min, SelectedObject set) - only the place-wide keyboard-only script remains", r.get("ok") and rules(r) == ["keyboard_only"] and r["data"]["buttons"] == 1, r)
lua("game:GetService('StarterPlayer').StarterPlayerScripts.Abilities.Source = 'local CAS = game:GetService(\"ContextActionService\")'")
r = run("audit_clean", programs["audit_clean"])
ok("...and once that script uses ContextActionService the audit is completely clean, in words", r.get("ok") and r["data"]["findings"] == [] and "no device findings" in r["text"], r)
lua("game:GetService('StarterPlayer').StarterPlayerScripts.Abilities.Source = 'UIS.InputBegan:Connect(function(input) if input.KeyCode == Enum.KeyCode.E then end if input.KeyCode == Enum.KeyCode.Q then end end)'")

r = run("audit_all", programs["audit_all"])
ok("audit without path covers both ScreenGuis and the StarterPlayerScripts once", r.get("ok") and sorted(r["data"]["guis"]) == ["BadHud", "CleanHud"] and r["data"]["scripts_checked"] == 4 and len(by(r, "keyboard_only")) == 1, (r["data"]["guis"], r["data"]["scripts_checked"]))

r = run("audit_limit", programs["audit_limit"])
ok("limit 3 caps the returned findings (+ the gamepad_entry note) while counts stay complete", r.get("ok") and len(r["data"]["findings"]) <= 4 and r["data"]["truncated"] > 0 and sum(r["data"]["counts"].values()) > 4, (len(r["data"]["findings"]), r["data"]["truncated"]))

r = run("audit_not_gui", programs["audit_not_gui"])
ok("path to Workspace is refused in words", not r.get("ok") and "ScreenGui or GuiObject" in r.get("error", ""), r)
ok("limit 0 is refused by the validator before any Luau runs", programs["audit_bad_limit"].startswith("--ERR") and "1..500" in programs["audit_bad_limit"], programs["audit_bad_limit"][:120])

# ── fix ───────────────────────────────────────────────────────────────────
r = run("fix_default", programs["fix_default"])
c = r["data"]["counts"] if r.get("ok") else {}
ok("default fix: 1 text constraint (Scaled), 2 min-touch constraints (Tiny, Smallish), 1 selectable, 1 safe_insets; undo = one waypoint", r.get("ok") and c.get("text_constraints") == 1 and c.get("min_touch_size") == 2 and c.get("selectable") == 1 and c.get("safe_insets") == 1 and r["data"]["applied"] == 5 and "waypoint" in r["data"]["undo"], r)
state = json.loads(L.eval("""function()
  local g = game:GetService('StarterGui').BadHud
  local sc = g.Panel.Tiny:FindFirstChildOfClass('UISizeConstraint')
  local tc = g.Scaled:FindFirstChildOfClass('UITextSizeConstraint')
  return M.jsonEncode({ insets = g.ScreenInsets.Name, sel = g.NoSelect.Selectable, minx = sc and sc.MinSize.X, miny = sc and sc.MinSize.Y, tmin = tc and tc.MinTextSize, tmax = tc and tc.MaxTextSize })
end""")())
ok("instances really changed: ScreenInsets DeviceSafeInsets, Selectable true, UISizeConstraint 36x36 on Tiny, UITextSizeConstraint 12..48 on Scaled", state == {"insets": "DeviceSafeInsets", "sel": True, "minx": 36, "miny": 36, "tmin": 12, "tmax": 48}, state)
r = run("fix_again", programs["fix_again"])
ok("running the default fix again changes nothing (idempotent)", r.get("ok") and r["data"]["applied"] == 0 and "nothing to change" in r["text"], r)

r = run("fix_scale", programs["fix_scale"])
ok("scale_sizes + aspect_images: panel / buttons / labels converted, Icon gets an aspect constraint", r.get("ok") and r["data"]["counts"].get("scale_sizes", 0) >= 6 and r["data"]["counts"].get("aspect_images") == 1, r)
conv = json.loads(L.eval("""function()
  local g = game:GetService('StarterGui').BadHud
  local p = g.Panel
  return M.jsonEncode({ sx = p.Size.X.Scale, sy = p.Size.Y.Scale, ox = p.Size.X.Offset, px = p.Position.X.Scale, ar = p:FindFirstChildOfClass('UIAspectRatioConstraint') ~= nil, tinyx = p.Tiny.Size.X.Scale, icon = g.Icon:FindFirstChildOfClass('UIAspectRatioConstraint') ~= nil })
end""")())
ok("Panel 900x500 @1280x720 -> Scale 0.703 x 0.755 (height relative to the 662 px area under the topbar), offset 0, aspect 1.8 added; Tiny is scaled relative to the panel", abs(conv["sx"] - 0.703) < 0.002 and abs(conv["sy"] - 0.755) < 0.002 and conv["ox"] == 0 and abs(conv["px"] - 0.078) < 0.002 and conv["ar"] and 0.02 < conv["tinyx"] < 0.03 and conv["icon"], conv)

r = run("audit_after", programs["audit_after"])
left = rules(r)
ok("audit after the fixes: offset_only_size, text_unbounded, gamepad_unreachable, safe_insets and image_stretch are gone; keyboard_only (script) remains", not ({"offset_only_size", "text_unbounded", "gamepad_unreachable", "safe_insets", "image_stretch"} & set(left)) and "keyboard_only" in left, left)
ok("what scale_sizes could not know is still reported honestly: FarRight was authored for 1920 px (baseline 1280 -> still off-screen) and its 48 px height became 24 px on the phone", {f["path"].split(".")[-1] for f in by(r, "offscreen")} == {"FarRight"} and {f["path"].split(".")[-1] for f in by(r, "touch_target")} == {"FarRight"}, (by(r, "offscreen"), by(r, "touch_target")))

ok("unknown fix op refused by the validator", programs["fix_bad_op"].startswith("--ERR") and "make_it_pretty" in programs["fix_bad_op"], programs["fix_bad_op"][:160])
ok("min_touch 5 refused", programs["fix_bad_touch"].startswith("--ERR") and "24..96" in programs["fix_bad_touch"])
ok("min_text > max_text refused", programs["fix_bad_text"].startswith("--ERR") and "must not exceed" in programs["fix_bad_text"])

print(f"\ndevice-sim: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
