#!/usr/bin/env python3
"""Command contract (1.84.0) end to end against the miniature Roblox DataModel.

Runs the SAME path main.js takes for a Studio skill - TotalCommandContract.prepare()
then RobloxScriptSkills.buildLuau() - and executes the generated Luau in the lupa
simulator with a STRICT Enum.Material (unknown names raise "X is not a valid
EnumItem" exactly like Studio). Asserts that:

  * an invalid material is rejected before any Luau is built (schema answer),
  * an alias / lower-case / "Enum.Material.X" spelling is normalized and applied,
  * the Luau that reaches Studio verifies by read-back and never silently keeps
    Plastic (the pre-1.84 pcall swallow),
  * part_create reports material_applied honestly when the enum is bad.

    pip install lupa && python3 tests/contract-sim.py          (from the TotalScript root)

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
const fs=require("fs"), vm=require("vm");
global.window=global; global.chrome={storage:{local:{get:(k,cb)=>cb&&cb({}),set:()=>{}}},runtime:{getURL:(p)=>p}};
const manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const bundle=manifest.content_scripts.find(c=>c.js&&c.js.includes("src/core/skills/studio_skills.js"));
for(const f of bundle.js.filter(f=>/src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f,"utf8"),{filename:f});
const C=require(process.cwd()+"/src/core/command_contract.js");
const S=RobloxScriptSkills;
const want=JSON.parse(process.argv[1]); const out={};
for(const [key,[op,args]] of Object.entries(want)){
  const prep=C.prepare(op,args);
  const rec={ok:prep.ok,args:prep.args,corrections:prep.corrections,message:prep.message||"",problems:prep.problems};
  if(prep.ok){ const r=S.buildLuau(op,prep.args); rec.code=r.code||("--ERR "+r.err); }
  out[key]=rec;
}
process.stdout.write(JSON.stringify(out));
"""

PROGRAMS = {
    "create": ["part_create", {"name": "Crate", "position": [0, 2, 0], "size": [4, 4, 4], "material": "wood planks", "colour": "#8b5a2b"}],
    "create_bad_enum": ["part_create", {"name": "Bad", "position": [8, 2, 0], "size": [2, 2, 2], "material": "Steel"}],
    "set_alias": ["material_set", {"target_path": "Workspace.Crate", "material": "Enum.Material.Neon"}],
    "set_lower": ["material_set", {"path": "Workspace.Crate", "material": "smoothplastic", "color": [0.2, 0.4, 1]}],
    "set_invalid": ["material_set", {"path": "Workspace.Crate", "material": "Steel"}],
    "set_missing": ["material_set", {"path": "Workspace.Crate"}],
    "set_nopart": ["material_set", {"path": "Workspace.Crate", "material": "Metal"}],
    "set_notfound": ["material_set", {"path": "Workspace.Nope", "material": "Metal"}],
    "transparency_range": ["transparency_set", {"path": "Workspace.Crate", "transparency": 5}],
    "transparency_str": ["transparency_set", {"path": "Workspace.Crate", "transparency": "0.5"}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:600]))


# Strict Enum.Material like Studio: unknown names raise instead of auto-creating.
L.execute(r"""
local real = {}
for _, n in ipairs({"Plastic","Wood","Slate","Concrete","CorrodedMetal","DiamondPlate","Foil","Grass","Ice","Marble","Granite","Brick","Pebble","Sand","Fabric","SmoothPlastic","Metal","WoodPlanks","Cobblestone","Air","Water","Rock","Glacier","Snow","Sandstone","Mud","Basalt","Ground","CrackedLava","Neon","Glass","Asphalt","LeafyGrass","Salt","Limestone","Pavement","ForceField","Cardboard","Carpet","CeramicTiles","ClayRoofTiles","RoofShingles","Leather","Plaster","Rubber"}) do
  real[n] = {Name=n, EnumType="Material"}
end
rawset(Enum, "Material", setmetatable({}, {__index=function(_, k) local v = real[k] if v == nil then error(tostring(k) .. " is not a valid EnumItem") end return v end}))
""")


def run(key):
    rec = data[key]
    if not rec["ok"]:
        return {"ok": False, "rejected": True, "message": rec["message"]}
    return run_program(key, rec["code"])


G = L.globals()
game = M.game
svc = lambda n: game.GetService(game, n)
WS = svc("Workspace")
find = lambda inst, name, rec=False: inst.FindFirstChild(inst, name, rec)

# ───────────────────────── part_create ─────────────────────────────
rec = data["create"]
ok("part_create: 'wood planks' + colour alias normalized before build", rec["ok"] and rec["args"]["material"] == "WoodPlanks" and rec["args"]["color"] == [139, 90, 43] and "colour" not in rec["args"], rec)
r = run("create")
crate = find(WS, "Crate")
ok("part_create ran and the material was applied (read back)", r.get("ok") and crate is not None and crate.Material.Name == "WoodPlanks" and r["data"]["material"] == "WoodPlanks" and r["data"]["material_applied"] is True, r)

rec = data["create_bad_enum"]
ok("part_create with 'Steel' is rejected by the contract (not a Roblox Material)", not rec["ok"] and "INVALID_ENUM" in rec["message"] and "Steel" in rec["message"] and "NOT run" in rec["message"], rec["message"][:300])
ok("rejection names the schema and the fix", "Schema: part_create" in rec["message"] and "Fix only the listed parameter" in rec["message"], rec["message"][:300])

# ───────────────────────── material_set ────────────────────────────
rec = data["set_alias"]
ok("material_set: target_path -> path, Enum.Material.Neon -> Neon", rec["ok"] and rec["args"] == {"path": "Workspace.Crate", "material": "Neon"}, rec)
r = run("set_alias")
ok("material_set Neon applied + verified by read-back", r.get("ok") and r["data"]["count"] == 1 and r["data"]["verified"] == 1 and crate.Material.Name == "Neon", r)

rec = data["set_lower"]
ok("material_set: smoothplastic -> SmoothPlastic, 0-1 colour scaled to 0-255", rec["ok"] and rec["args"]["material"] == "SmoothPlastic" and rec["args"]["color"] == [51, 102, 255], rec)
r = run("set_lower")
ok("material_set SmoothPlastic applied", r.get("ok") and crate.Material.Name == "SmoothPlastic", r)

rec = data["set_invalid"]
ok("material_set 'Steel' never reaches Studio", not rec["ok"] and rec["problems"][0]["code"] == "invalid_enum" and "INVALID_ENUM" in rec["message"], rec["message"][:200])
ok("...and the part keeps its real material (no silent Plastic fallback)", crate.Material.Name == "SmoothPlastic")

rec = data["set_missing"]
ok("material_set without material -> MISSING_PARAMS with the enum choices", not rec["ok"] and "MISSING_PARAMS" in rec["message"] and "Enum.Material" in rec["message"], rec["message"][:300])

# Luau-level guard: even if a bad name slipped past the contract the generated Luau must fail loudly.
bad_code = data["set_nopart"]["code"].replace("Enum.Material.Metal", "Enum.Material.Steel")
r = run_program("luau_guard", bad_code)
ok("Luau guard: invalid Enum.Material fails instead of being swallowed", (not r.get("ok")) and "not a valid Enum.Material" in str(r.get("error", "")), r)
ok("...and nothing changed", crate.Material.Name == "SmoothPlastic")

# material_set on a container with no parts is an honest failure.
folder = L.eval("function(ws) local f=Instance.new('Folder') f.Name='Crate' f.Parent=ws return f end")(WS)
crate.Parent = None
r = run("set_nopart")
ok("material_set on a Folder without parts fails honestly", (not r.get("ok")) and "no BasePart" in str(r.get("error", "")), r)
folder.Parent = None
crate.Parent = WS

r = run("set_notfound")
ok("material_set on a missing path reports the path", (not r.get("ok")) and "Workspace.Nope" in str(r.get("error", "")), r)

# ───────────────────────── ranges / coercion ───────────────────────
rec = data["transparency_range"]
ok("transparency 5 is rejected (0..1), not clamped", not rec["ok"] and "0..1" in rec["message"], rec["message"][:200])
rec = data["transparency_str"]
ok("transparency '0.5' coerced to number", rec["ok"] and rec["args"]["transparency"] == 0.5, rec)
r = run("transparency_str")
ok("transparency applied", r.get("ok") and abs(crate.Transparency - 0.5) < 1e-9, r)

n = len(results)
p = sum(results)
print(("OK    " if p == n else "FAILED ") + "contract-sim: %d/%d passed (mocked DataModel - no live Studio)" % (p, n))
sys.exit(0 if p == n else 1)
