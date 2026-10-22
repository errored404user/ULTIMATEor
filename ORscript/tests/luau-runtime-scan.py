#!/usr/bin/env python3
"""Runtime scan of every Studio skill command (1.33).

luau-parse-check.py only parses the generated Luau. This test EXECUTES each
command's program (sample args) inside tests/roblox_sim.py and fails on the
error classes that can only be programming mistakes in the pack itself:

  * "attempt to call a nil value (global 'x')"   - helper missing from the prelude
  * "attempt to index a nil value (global 'x')"  - service/local never declared
  * instruction budget exhausted                 - unbounded loop
  * compile errors (other than Luau-only syntax the Lua 5.4 parser rejects)

Everything else ("player not found", "need a BasePart path", unknown classes
the simulator does not model, ...) is a legitimate runtime answer and is only
counted.  Run: python3 tests/luau-runtime-scan.py
"""
import collections
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
os.chdir(ROOT)
sys.path.insert(0, HERE)
try:
    from roblox_sim import make_runtime
except Exception as e:  # lupa missing
    print("SKIP  roblox_sim unavailable:", e)
    sys.exit(0)

DUMP = r"""
const fs=require("fs"), vm=require("vm");
global.window=global; global.chrome={storage:{local:{get:(k,cb)=>cb&&cb({}),set:()=>{}}},runtime:{getURL:(p)=>p}};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
function sample(p){const t=String(p.type||"").toLowerCase();if(/\[\]|array|list/.test(t))return /number|num/.test(t)?[1,2,3]:["a","b"];if(/number|int|float/.test(t))return 1;if(/bool/.test(t))return true;if(/object|dict|map|json/.test(t))return {a:1};return (p.enum&&p.enum[0])||(p.desc&&/path/i.test(p.desc)?"Workspace.Part":"Test");}
const out=[];
for(const c of RobloxScriptSkills.SKILL_COMMANDS){const args={};for(const [k,v] of Object.entries(c.params||{}))args[k]=sample(v||{});let r;try{r=RobloxScriptSkills.buildLuau(c.name,args);}catch(e){r={err:String(e)};}if(r&&r.code)out.push({name:c.name,code:r.code});else out.push({name:c.name,err:(r&&r.err)||"no code"});}
fs.writeFileSync(process.argv[1], JSON.stringify(out));
"""

prog_file = os.path.join("/tmp", "or-runtime-scan-%d.json" % os.getpid())
subprocess.check_call(["node", "-e", DUMP, prog_file])
programs = json.load(open(prog_file))
os.unlink(prog_file)

L, M, run = make_runtime()
L.execute("""
local ws=game:GetService('Workspace')
local p=Instance.new('Part') p.Name='Part' p.Anchored=true p.Parent=ws
local m=Instance.new('Model') m.Name='Rig' m.Parent=ws
local h=Instance.new('Part') h.Name='HumanoidRootPart' h.Parent=m m.PrimaryPart=h
local hum=Instance.new('Humanoid') hum.Parent=m
""")

# Real Roblox globals the simulator does not model (not pack bugs).
ROBLOX_GLOBALS = {"BrickColor", "Region3", "Region3int16", "Random", "NumberRange", "Ray", "Rect", "Font", "Axes", "Faces",
                  "PhysicalProperties", "UDim", "Vector2int16", "Vector3int16", "TweenInfo", "DateTime", "buffer", "bit32",
                  "utf8", "CatalogSearchParams", "OverlapParams", "RaycastParams", "PathWaypoint", "DockWidgetPluginGuiInfo",
                  "ColorSequenceKeypoint", "NumberSequenceKeypoint", "FloatCurveKeypoint", "RotationCurveKeypoint", "SharedTable",
                  "plugin", "settings", "shared", "gcinfo", "elapsedTime", "tick", "typeof", "warn", "delay", "spawn", "wait"}
# Luau syntax the Lua 5.4 parser used by the simulator rejects (if-expressions,
# compound assignment, type annotations, string interpolation, continue).
LUAU_ONLY = re.compile(r"[=(,{]\s*if\s|\+=|-=|\*=|/=|\.\.=|::\s*[A-Za-z]|`|\bcontinue\b")

bad = collections.OrderedDict()
other = collections.Counter()
ran = 0
for p in programs:
    if p.get("err"):
        # Builders validate enum-like params; a clear "unknown X / must be" is
        # the intended answer to our generic sample args. Only JS exceptions count.
        if re.search(r"TypeError|ReferenceError|RangeError|SyntaxError|is not a function|Cannot read", p["err"]):
            bad[p["name"]] = "BUILD: " + p["err"][:160]
        continue
    ran += 1
    M.waits = 0
    L.execute("debug.sethook(function() error('INSTRUCTION_BUDGET') end, '', 20000000)")
    try:
        r = run(p["name"], p["code"])
    except Exception as e:
        r = {"ok": False, "error": "PYEXC " + str(e)}
    L.execute("debug.sethook()")
    if not isinstance(r, dict):
        continue
    err = "" if r.get("ok") else str(r.get("error", ""))
    if not err:
        continue
    if "INSTRUCTION_BUDGET" in err:
        bad[p["name"]] = "unbounded loop (instruction budget)"
    elif re.search(r"attempt to (call|index) a nil value \(global '", err):
        g = re.search(r"\(global '([^']+)'\)", err).group(1)
        if g not in ROBLOX_GLOBALS:
            bad[p["name"]] = err[:160]
        else:
            other["sim lacks Roblox global " + g] += 1
    elif re.search(r"attempt to (add|perform arithmetic on) a string", err):
        bad[p["name"]] = err[:160]  # Lua concatenation written with "+"
    elif err.startswith("COMPILE:") and not LUAU_ONLY.search(p["code"]):
        bad[p["name"]] = err[:160]
    else:
        other[re.sub(r"[\d\"']", "", err)[:60]] += 1

print("executed %d programs; %d legitimate runtime answers in %d classes" % (ran, sum(other.values()), len(other)))
if bad:
    print("FAIL  %d command(s) with pack-level runtime bugs:" % len(bad))
    for name, why in bad.items():
        print("   ", name, "->", why)
    sys.exit(1)
print("OK    no nil-global calls, unbounded loops or compile errors in any Studio command")
