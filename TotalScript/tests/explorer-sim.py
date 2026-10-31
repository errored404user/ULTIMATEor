#!/usr/bin/env python3
"""Explorer & Inspector probes (2.0.0) against the miniature Roblox DataModel.

src/core/explorer.js ships the READ-ONLY Luau the Explorer tab runs through
execute_luau (root services, children of a path, properties of a path, name
search) plus the one write it allows (Selection:Set). This sim executes exactly
that Luau on tests/roblox_sim.py and asserts the JSON describes the place
truthfully, then feeds it back through the module's state/render functions.

    pip install lupa && python3 tests/explorer-sim.py          (from the TotalScript root)

Mocked: no live Studio is involved; the simulator is a miniature DataModel.
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
const X=require(process.cwd()+"/src/core/explorer.js");
const out={root:X.rootLua(), children:{}, props:{}, search:{}, select:{}};
for (const p of ["Workspace","game.Workspace.Hero","workspace.hero","ServerStorage","Workspace.Nope"]) out.children[p]=X.childrenLua(p, 3);
out.childrenAll=X.childrenLua("Workspace", 200);
for (const p of ["Workspace.Hero","Workspace.Crate","ServerScriptService.Main","ReplicatedStorage.Clips.Wave","StarterGui.HUD","StarterGui.HUD.Title","Workspace.Hero.Humanoid","Lighting","Workspace.Nope.Missing"]) out.props[p]=X.propsLua(p);
for (const q of ["crate","Script","zzz",""]) out.search[q]=X.searchLua(q, 5);
out.select["Workspace.Crate"]=X.selectLua("Workspace.Crate"); out.select["Workspace.Nope"]=X.selectLua("Workspace.Nope");
process.stdout.write(JSON.stringify(out));
"""
gen = subprocess.run(["node", "-e", GEN], capture_output=True, text=True)
if gen.returncode != 0:
    print("FAIL  node generator: " + gen.stderr[:800])
    sys.exit(1)
LUA = json.loads(gen.stdout)
all_code = [LUA["root"], LUA["childrenAll"]] + list(LUA["children"].values()) + list(LUA["props"].values()) + list(LUA["search"].values()) + list(LUA["select"].values())
for code in all_code:
    assert "+=" not in code and "\ncontinue" not in code, "probe Luau must stay plain Lua 5.x for the sim"

L, M, run = make_runtime()

SETUP = r"""
local ws=workspace
local hero=M.buildRig(Enum.HumanoidRigType.R15,"Hero") hero.Parent=ws
local an=Instance.new("Animator") an.Parent=hero:FindFirstChildOfClass("Humanoid")
local crate=Instance.new("Part") crate.Name="Crate" crate.Size=Vector3.new(4,4,4) crate.Anchored=true crate.Color=Color3.fromRGB(255,0,0) crate.Parent=ws
crate:SetAttribute("Kind","loot") crate:SetAttribute("Weight",3)
local s=Instance.new("Script") s.Name="Main" s.Source="print('hi')\nprint('two')" s.Parent=game:GetService("ServerScriptService")
local clips=Instance.new("Folder") clips.Name="Clips" clips.Parent=game:GetService("ReplicatedStorage")
local ks=Instance.new("KeyframeSequence") ks.Name="Wave" ks.Loop=true ks.Parent=clips
for i=0,2 do local k=Instance.new("Keyframe") k.Time=i*0.5 k.Parent=ks end
local gui=Instance.new("ScreenGui") gui.Name="HUD" gui.Parent=game:GetService("StarterGui")
local tl=Instance.new("TextLabel") tl.Name="Title" tl.Text="Hello world" tl.Parent=gui
for i=1,5 do local f=Instance.new("Frame") f.Name="F"..i f.Parent=gui end
for i=1,6 do local p=Instance.new("Part") p.Name="Filler"..i p.Parent=ws end
game:GetService("Selection"):Set({hero})
return "ok"
"""
setup_fn = L.eval("function(M) " + SETUP + " end")
assert setup_fn(M) == "ok"

results = []
def ok(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else "  -> " + str(detail)[:400]))

root = run("root", LUA["root"])
roots = root.get("roots") or []
names = [r.get("name") for r in roots]
ok("root probe lists the services (Workspace first)", names and names[0] == "Workspace" and "ReplicatedStorage" in names and "StarterGui" in names, names)
ws = next((r for r in roots if r.get("name") == "Workspace"), {})
ok("root probe counts Workspace children (Camera + Hero + Crate + 6 fillers = 9)", ws.get("n") == 9 and ws.get("path") == "Workspace", ws)
ok("root probe reports the Studio selection", root.get("selection") == ["Workspace.Hero"], root)

ch = run("children_ws", LUA["children"]["Workspace"])
ok("children probe (cap 3): found, 3 rows, more=6", ch.get("found") is True and len(ch.get("children") or []) == 3 and ch.get("more") == 6, ch)
ch_all = run("children_ws_all", LUA["childrenAll"])
rows = {c["name"]: c for c in ch_all.get("children") or []}
ok("children probe (cap 200): all 9 rows with class/childCount/path", len(rows) == 9 and rows["Hero"]["class"] == "Model" and rows["Hero"]["n"] > 10 and rows["Crate"]["path"] == "Workspace.Crate" and rows["Crate"]["n"] == 0 and ch_all.get("more") == 0, ch_all)
ch = run("children_hero", LUA["children"]["game.Workspace.Hero"])
ok("children probe resolves a game. prefix", ch.get("found") is True and ch.get("path") == "Workspace.Hero", ch)
ch = run("children_ci", LUA["children"]["workspace.hero"])
ok("children probe resolves case-insensitively", ch.get("found") is True and ch.get("path") == "Workspace.Hero", ch)
ch = run("children_empty", LUA["children"]["ServerStorage"])
ok("children probe on an empty service: found with 0 rows", ch.get("found") is True and ch.get("children") == [] and ch.get("more") == 0, ch)
ch = run("children_missing", LUA["children"]["Workspace.Nope"])
ok("children probe on a missing path says found=false", ch.get("found") is False and ch.get("path") == "Workspace.Nope", ch)

p = run("props_hero", LUA["props"]["Workspace.Hero"])
ok("props Model: class, parent, BoundingBox, 16 parts, PrimaryPart", p.get("found") is True and p.get("class") == "Model" and p.get("parent") == "Workspace" and p["props"].get("Parts") == 16 and isinstance(p["props"].get("BoundingBox"), list) and p["props"].get("PrimaryPart"), p)
p = run("props_crate", LUA["props"]["Workspace.Crate"])
pp = p.get("props") or {}
ok("props Part: Size 4x4x4, Anchored, Color #ff0000, Material name", pp.get("Size") == [4, 4, 4] and pp.get("Anchored") is True and pp.get("Color") == "#ff0000" and isinstance(pp.get("Material"), str), p)
ok("props Part: attributes Kind/Weight as strings, attributeCount 2", p.get("attributes", {}).get("Kind") == "loot" and p.get("attributes", {}).get("Weight") == "3" and p.get("attributeCount") == 2, p)
p = run("props_script", LUA["props"]["ServerScriptService.Main"])
ok("props Script: SourceLength and FirstLine (no whole source)", p["props"].get("SourceLength") == len("print('hi')\nprint('two')") and p["props"].get("FirstLine") == "print('hi')" and "Source" not in p["props"], p)
p = run("props_ks", LUA["props"]["ReplicatedStorage.Clips.Wave"])
ok("props KeyframeSequence: 3 keyframes, Loop true, Priority", p["props"].get("Keyframes") == 3 and p["props"].get("Loop") is True and isinstance(p["props"].get("Priority"), str), p)
p = run("props_gui", LUA["props"]["StarterGui.HUD"])
ok("props ScreenGui: Enabled, GuiObjects count 6 (5 frames + label)", "Enabled" in p["props"] and p["props"].get("GuiObjects") == 6, p)
p = run("props_label", LUA["props"]["StarterGui.HUD.Title"])
ok("props TextLabel: Text, Size/Position as UDim2 strings, Visible", p["props"].get("Text") == "Hello world" and isinstance(p["props"].get("Size"), str) and "Visible" in p["props"], p)
p = run("props_hum", LUA["props"]["Workspace.Hero.Humanoid"])
ok("props Humanoid: RigType R15, Animator true, WalkSpeed", p["props"].get("RigType") == "R15" and p["props"].get("Animator") is True and "WalkSpeed" in p["props"], p)
p = run("props_lighting", LUA["props"]["Lighting"])
ok("props Lighting: ClockTime, Brightness, Ambient (Technology enum absent in the sim)", p["props"].get("ClockTime") == 14 and "Brightness" in p["props"] and p["props"].get("Ambient", "").startswith("#"), p)
p = run("props_missing", LUA["props"]["Workspace.Nope.Missing"])
ok("props on a missing path says found=false", p.get("found") is False, p)

s = run("search_crate", LUA["search"]["crate"])
ok("search 'crate' finds Workspace.Crate", any(r.get("path") == "Workspace.Crate" for r in s.get("results") or []), s)
s = run("search_script", LUA["search"]["Script"])
ok("search by class name 'Script' finds ServerScriptService.Main", any(r.get("path") == "ServerScriptService.Main" for r in s.get("results") or []), s)
s = run("search_zzz", LUA["search"]["zzz"])
ok("search with no hit returns an empty list", s.get("results") == [] and s.get("more") == 0, s)
s = run("search_empty", LUA["search"][""])
ok("empty search is a no-op", s.get("results") == [], s)

sel = run("select_crate", LUA["select"]["Workspace.Crate"])
now_sel = L.eval("(function() local t={} for _,s in ipairs(game:GetService('Selection'):Get()) do t[#t+1]=s:GetFullName() end return table.concat(t,',') end)()")
ok("select probe sets the Studio selection to the path", sel.get("selected") is True and now_sel == "Workspace.Crate", (sel, now_sel))
sel = run("select_missing", LUA["select"]["Workspace.Nope"])
ok("select probe on a missing path leaves the selection alone", sel.get("found") is False and L.eval("(function() return game:GetService('Selection'):Get()[1]:GetFullName() end)()") == "Workspace.Crate", sel)

# Feed the real probe output back through the module's state + render.
FEED = r"""
const X=require(process.cwd()+"/src/core/explorer.js");
const d=JSON.parse(process.argv[1]);
const st=X.createState();
X.applyRoot(st,d.root);
const step=X.toggle(st,"Workspace");
X.applyChildren(st,"Workspace",d.children);
X.select(st,"Workspace.Crate"); X.applyProps(st,"Workspace.Crate",d.props);
X.setTarget(st,"Workspace.Crate");
const html=X.render(st);
process.stdout.write(JSON.stringify({step, roots:st.roots.length, open:st.nodes.Workspace.open, kids:st.nodes.Workspace.children.length, html, brief:X.targetBrief(st.target)}));
"""
feed = subprocess.run(["node", "-e", FEED, json.dumps({"root": root, "children": ch_all, "props": run("props_crate2", LUA["props"]["Workspace.Crate"])})], capture_output=True, text=True)
ok("module accepts the sim output (node feed ran)", feed.returncode == 0, feed.stderr[:300])
F = json.loads(feed.stdout) if feed.returncode == 0 else {}
ok("state: toggle asks to load, roots applied, Workspace open with 9 children", F.get("step") == "load" and F.get("roots", 0) >= 10 and F.get("open") is True and F.get("kids") == 9, F)
html = F.get("html", "")
ok("render: tree rows for Hero and Crate, Crate marked target + selected", 'data-ex-select="Workspace.Hero"' in html and 'data-ex-select="Workspace.Crate"' in html and "rs-ex-target" in html and 'aria-selected="true"' in html, html[:300])
ok("render: inspector shows the Part properties and the attribute", "<th>Size</th><td>4, 4, 4" in html and "<th>@Kind</th><td>loot" in html and "#ff0000" in html, html[-900:])
ok("render: target chip + untarget action present", "Target: <b>Crate</b>" in html and 'data-ex-action="untarget"' in html, html[:600])
ok("target brief names the path and asks for a read-back first", "Workspace.Crate [Part]" in F.get("brief", "") and "Read it back" in F.get("brief", ""), F.get("brief"))

n_ok = sum(1 for _, c in results if c)
print("\n%d passed, %d failed" % (n_ok, len(results) - n_ok))
sys.exit(0 if n_ok == len(results) else 1)
