#!/usr/bin/env python3
"""1.51.2 LUAU LIBRARY CACHE — run the real main.js transport helpers against
the miniature Roblox DataModel.

Every skill program is "library + body". main.js used to split any program over
LUAU_CHUNK_MAX (18 000 chars) into 2-5 execute_luau round trips through a
ServerStorage buffer + loadstring - the GUI Studio / design / quality commands
are 34-78 KB, so EVERY GUI command paid that price and every extra trip was a
chance for a bridge error the model then looped on. Now the library is uploaded
once (non-archivable StringValue under ServerStorage._ORLuauLib) and each
command ships only its body.

This test extracts luauLongStr / luauLibHash / luauLibExecCode /
luauLibUploadCode / splitLuauPieces verbatim from main.js, generates the Luau
for ui_build_spec + ui_layout_report + quality_audit, and executes the probe →
upload → run sequence in the simulator.

    pip install lupa && python3 tests/luau-lib-sim.py          (from the ORscript root)
"""
import json, os, re, subprocess, sys

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
const main=fs.readFileSync("src/core/main.js","utf8");
// the transport helpers, verbatim from main.js
const cut=(from,to)=>{const a=main.indexOf(from), b=main.indexOf(to,a); if(a<0||b<0) throw new Error("anchor missing: "+from); return main.slice(a,b);};
const helpers = "const LUAU_CHUNK_MAX = 18000;\n" + cut("  function luauLongStr(s) {", "  function wrapLuauChunk(") + cut("  const LUAU_LIB_FOLDER", "  // Run a built skill program");
vm.runInThisContext(helpers + "\nglobalThis.__H={luauLibHash,luauLibExecCode,luauLibUploadCode,splitLuauPieces,LUAU_CHUNK_MAX};");
const H=globalThis.__H; const S=RobloxScriptSkills;
const want=JSON.parse(process.argv[1]); const out={programs:{}};
for(const [key,[op,args]] of Object.entries(want)){
  const b=S.buildLuau(op,args);
  if(b.err){ out.programs[key]={err:b.err}; continue; }
  const id=H.luauLibHash(b.lib);
  const pieces=H.splitLuauPieces(b.lib, H.LUAU_CHUNK_MAX-700);
  out.programs[key]={ id, codeLen:b.code.length, libLen:b.lib.length, bodyLen:b.body.length, exec:H.luauLibExecCode(id,b.body), uploads:pieces.map((p,i)=>H.luauLibUploadCode(id,p,i,pieces.length)), pieceJoin:pieces.join("")===b.lib, maxPiece:Math.max(...pieces.map(p=>p.length)) };
  out.programs[key].execLen=out.programs[key].exec.length;
}
process.stdout.write(JSON.stringify(out));
"""

SPEC = {"screen": {"name": "Shop"}, "preset": "ocean", "children": [
    {"class": "Frame", "name": "Window", "size": [0, 480, 0, 320], "position": [0.5, 0, 0.5, 0], "anchor": [0.5, 0.5], "bg": "surface", "corner": 14, "padding": 12,
     "children": [{"class": "TextLabel", "name": "Title", "text": "SHOP", "size": [1, 0, 0, 40], "bg_t": 1},
                  {"class": "TextButton", "name": "Close", "text": "×", "size": [0, 32, 0, 32], "position": [1, 0, 0, 0], "anchor": [1, 0], "bg": "danger",
                   "actions": [{"on": "click", "do": "close", "target": "parent"}]}]}]}
PROGRAMS = {
    "build": ["ui_build_spec", {"spec": SPEC, "replace": True}],
    "report": ["ui_layout_report", {"path": "StarterGui.Shop"}],
    "audit": ["quality_audit", {"path": "StarterGui.Shop"}],
    "tokens": ["design_tokens_set", {"preset": "ocean"}],
}
data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:700]))


RUN = L.eval("function(src) local f,e=load(src,'=exec') if not f then return 'COMPILE: '..tostring(e) end local okR,res=pcall(f) if not okR then return 'RUNTIME: '..tostring(res) end if type(res)=='table' then return HttpService and 'TABLE' or 'TABLE' end return tostring(res) end")


def lua(expr):
    expr = expr.strip()
    return L.execute(expr if expr.startswith(("local ", "return ")) else "return " + expr)


b = data["programs"]["build"]
ok("ui_build_spec is library + body (library > 18 KB, body small, exec program fits one trip)", b["libLen"] > 18000 and b["bodyLen"] < 8000 and b["execLen"] < 18000, (b["libLen"], b["bodyLen"], b["execLen"]))
ok("library pieces re-join to the exact library and each piece fits the transport", b["pieceJoin"] and b["maxPiece"] <= 18000 - 700 and len(b["uploads"]) >= 2, (b["maxPiece"], len(b["uploads"])))
ok("library id is content-addressed (hash + byte length)", re.match(r"^lib_[0-9a-f]{8}_\d+$", b["id"]) is not None, b["id"])

# 1. probe before any upload → OR_LIB_MISSING, nothing built
r0 = RUN(b["exec"])
ok("probe without the library answers OR_LIB_MISSING <id> and builds nothing", r0 == "OR_LIB_MISSING " + b["id"] and lua("game.StarterGui:FindFirstChild('Shop')") is None, r0)
# 2. upload pieces
parts = [RUN(u) for u in b["uploads"]]
ok("every upload piece acknowledges OR_LIB_PART i/n", all(p == "OR_LIB_PART %d/%d" % (i + 1, len(parts)) for i, p in enumerate(parts)), parts)
ok("library lives in a NON-archivable ServerStorage folder + StringValue (never saved with the place)",
   lua("game.ServerStorage._ORLuauLib.Archivable") is False and lua("game.ServerStorage._ORLuauLib['%s'].Archivable" % b["id"]) is False, "")
ok("stored library is byte-exact", lua("#game.ServerStorage._ORLuauLib['%s'].Value" % b["id"]) == int(b["id"].split("_")[-1]), lua("#game.ServerStorage._ORLuauLib['%s'].Value" % b["id"]))
# 3. run for real
r1 = RUN(b["exec"])
j1 = json.loads(r1) if r1.startswith("{") else {"ok": False, "error": r1}
ok("exec with the library runs the body: ui_build_spec builds the ScreenGui", j1.get("ok") is True and lua("game.StarterGui.Shop.Window.Title.Text") == "SHOP", r1[:300])
ok("the body ran through loadstring(lib .. body): ok envelope from the pack's own wrapper", "data" in j1 and isinstance(j1["data"], dict), list(j1.keys()))

# 4. a second GUI command shares the same library → no upload needed
rep = data["programs"]["report"]
ok("ui_layout_report shares the GUI Studio library (same id)", rep["id"] == b["id"], (rep["id"], b["id"]))
r2 = RUN(rep["exec"])
j2 = json.loads(r2) if r2.startswith("{") else {"ok": False, "error": r2}
ok("second command runs in ONE trip with the cached library", j2.get("ok") is True and not r2.startswith("OR_LIB_MISSING"), r2[:300])

# 5. other packs have their own libraries and coexist
for key in ("audit", "tokens"):
    p = data["programs"][key]
    ok(key + ": its own library id, exec program fits one trip", p["id"] != b["id"] and p["execLen"] < 18000, (p["id"], p["execLen"]))
    first = RUN(p["exec"])
    ok(key + ": probe → OR_LIB_MISSING before upload", first.startswith("OR_LIB_MISSING"), first)
    ups = [RUN(u) for u in p["uploads"]]
    ok(key + ": upload acknowledged", all(u.startswith("OR_LIB_PART") for u in ups), ups)
    res = RUN(p["exec"])
    jr = json.loads(res) if res.startswith("{") else {"ok": False, "error": res}
    ok(key + ": runs with its library", jr.get("ok") is True, res[:300])
ok("three libraries coexist in the cache folder", lua("#game.ServerStorage._ORLuauLib:GetChildren()") == 3, lua("#game.ServerStorage._ORLuauLib:GetChildren()"))

# 6. a corrupted / truncated library is detected by the byte-length probe (no half-library ever runs)
L.execute("game.ServerStorage._ORLuauLib['%s'].Value = 'broken'" % b["id"])
r3 = RUN(b["exec"])
ok("truncated library → OR_LIB_MISSING again (re-upload instead of running garbage)", r3 == "OR_LIB_MISSING " + b["id"], r3)
parts = [RUN(u) for u in b["uploads"]]
r4 = RUN(b["exec"])
ok("re-upload replaces the value in place and the command runs again", all(p.startswith("OR_LIB_PART") for p in parts) and r4.startswith("{") and json.loads(r4).get("ok") is True, r4[:200])

# 7. eviction keeps the folder bounded
L.execute("for i=1,20 do local v=Instance.new('StringValue') v.Name='lib_0000000'..i..'_1' v.Value='x' v:SetAttribute('used', i) v.Parent=game.ServerStorage._ORLuauLib end")
RUN(b["uploads"][0])
ok("upload prunes the least recently used libraries down to the cap (12)", lua("#game.ServerStorage._ORLuauLib:GetChildren()") <= 12 and lua("game.ServerStorage._ORLuauLib:FindFirstChild('%s')" % b["id"]) is not None, lua("#game.ServerStorage._ORLuauLib:GetChildren()"))

n = len(results)
print("%d/%d checks passed" % (sum(results), n))
sys.exit(0 if all(results) else 1)
