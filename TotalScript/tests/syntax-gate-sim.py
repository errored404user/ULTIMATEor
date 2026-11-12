#!/usr/bin/env python3
"""Write-time syntax gate (1.99.8) against the miniature Roblox DataModel.

Every command that writes AI-authored Luau into a script Source
(script_set_source, script_append, script_create, script_module,
script_replace, script_insert) now compiles the RESULTING source with
loadstring BEFORE writing. A Luau syntax error is returned as the command
result and the script is left exactly as it was; `unchecked: true` bypasses
the gate. script_check itself is fixed: loadstring returns nil+message on a
syntax error (it never throws), so the old pcall-only check reported every
broken script as "compiles clean".

The lupa runtime (Lua 5.4/5.5) has no `loadstring`; Studio plugins do. The
sim installs `loadstring = load` to model Studio, and ALSO runs one program
with loadstring removed to prove the fallback: the write proceeds and the
result says syntax="unchecked" instead of pretending.

    pip install lupa && python3 tests/syntax-gate-sim.py      (from the TotalScript root)

Mocked: no live Studio is involved; the simulator is a miniature DataModel.
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
const C=require(process.cwd()+"/src/core/command_contract.js");
const S=RobloxScriptSkills;
const want=JSON.parse(process.argv[1]); const out={};
for(const [key,[op,args]] of Object.entries(want)){
  const prep=C.prepare(op,args);
  const rec={ok:prep.ok,args:prep.args,corrections:prep.corrections,message:prep.message||""};
  if(prep.ok){ const r=S.buildLuau(op,prep.args); rec.code=r.code||("--ERR "+r.err); }
  out[key]=rec;
}
const reg=S.SKILL_COMMANDS.filter(c=>/^(script_set_source|script_append|script_create|script_module|script_replace|script_insert)$/.test(c.name));
out.__reg=reg.map(c=>({name:c.name,hasUnchecked:!!(c.params&&c.params.unchecked),desc:c.description}));
process.stdout.write(JSON.stringify(out));
"""

GOOD = "local M = {}\nfunction M.hello()\n\treturn 'hi'\nend\nreturn M"
BAD = "local M = {}\nfunction M.hello(\n\treturn 'hi'\nend\nreturn M"      # missing ')'
PROGRAMS = {
    "create_good": ["script_create", {"kind": "module", "name": "GateMod", "parent": "ServerStorage", "source": GOOD}],
    "create_bad": ["script_create", {"kind": "server", "name": "GateBad", "parent": "ServerScriptService", "source": BAD}],
    "create_bad_unchecked": ["script_create", {"kind": "server", "name": "GateForced", "parent": "ServerScriptService", "source": BAD, "unchecked": True}],
    "create_fenced": ["script_create", {"kind": "server", "name": "GateFenced", "parent": "ServerScriptService", "source": "```lua\nprint('fenced')\n```"}],
    "module_bad": ["script_module", {"name": "GateModBad", "source": "local M = { return M"}],
    "set_good": ["script_set_source", {"path": "ServerStorage.GateMod", "source": "return 42"}],
    "set_bad": ["script_set_source", {"path": "ServerStorage.GateMod", "source": "return 42 +"}],
    "set_bad_unchecked": ["script_set_source", {"path": "ServerScriptService.GateForced", "source": "if x then", "unchecked": True}],
    "append_good": ["script_append", {"path": "ServerStorage.GateMod", "source": "-- trailing comment"}],
    "append_bad": ["script_append", {"path": "ServerStorage.GateMod", "source": "function broken("}],
    "replace_good": ["script_replace", {"path": "ServerStorage.GateMod", "find": "42", "replace": "43"}],
    "replace_bad": ["script_replace", {"path": "ServerStorage.GateMod", "find": "43", "replace": "43 +"}],
    "insert_good": ["script_insert", {"path": "ServerStorage.GateMod", "text": "local y = 1", "position": "top"}],
    "insert_bad": ["script_insert", {"path": "ServerStorage.GateMod", "text": "local z = (", "position": "top"}],
    "check_good": ["script_check", {"path": "ServerStorage.GateMod"}],
    "check_bad": ["script_check", {"source": BAD}],
    "check_bad_path": ["script_check", {"path": "ServerScriptService.GateForced"}],
    "set_no_loadstring": ["script_set_source", {"path": "ServerStorage.GateMod", "source": "return 7"}],
}

data = json.loads(subprocess.check_output(["node", "-e", GEN, json.dumps(PROGRAMS)], text=True))
L, M, run_program = make_runtime()
results = []


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond or not detail else " — " + str(detail)[:600]))


# Studio plugins / the command bar have loadstring; model it with Lua's load.
L.execute("loadstring = function(src) return load(src, '=chunk') end")


# The ultimate pack's prelude uses Luau compound assignment (`n+=1`); the sim's
# plain Lua needs it desugared (same rewrite as tests/luau-parse-check.py).
COMPOUND = re.compile(r"(\b[A-Za-z_][\w\.\[\]'\"#]*)\s*(\+|-|\*|/|\.\.)=(?!=)")


def run(key):
    rec = data[key]
    if not rec["ok"]:
        return {"ok": False, "rejected": True, "message": rec["message"]}
    return run_program(key, COMPOUND.sub(lambda m: m.group(1) + "=" + m.group(1) + m.group(2), rec["code"]))


game = M.game
svc = lambda n: game.GetService(game, n)
SS, SSS = svc("ServerStorage"), svc("ServerScriptService")
find = lambda inst, name, rec=False: inst.FindFirstChild(inst, name, rec)
src_of = lambda inst: inst.Source if inst is not None else None

# ── registrations ──
reg = {r["name"]: r for r in data["__reg"]}
ok("all six write commands declare the `unchecked` parameter", len(reg) == 6 and all(r["hasUnchecked"] for r in reg.values()), reg)
ok("descriptions say the source is syntax-checked and nothing is written on error", all("syntax" in r["desc"].lower() for r in reg.values()), [r["desc"][:80] for r in reg.values()])

# ── script_create ──
r = run("create_good")
mod = find(SS, "GateMod")
ok("script_create with valid Luau creates the module and reports syntax=ok", r.get("ok") and mod is not None and r["data"]["syntax"] == "ok" and src_of(mod) == GOOD, r)
r = run("create_bad")
ok("script_create with broken Luau is refused as SYNTAX ERROR", (not r.get("ok")) and "SYNTAX ERROR" in str(r.get("error", "")) and "not created" in str(r.get("error", "")), r)
ok("...and the script does NOT exist", find(SSS, "GateBad") is None)
ok("...the error names the Luau problem (loadstring message included)", any(w in str(r.get("error", "")).lower() for w in ("expected", "')'", "unexpected", "near")), r)
r = run("create_bad_unchecked")
ok("script_create unchecked=true writes the broken source anyway", r.get("ok") and find(SSS, "GateForced") is not None and src_of(find(SSS, "GateForced")) == BAD, r)
rec = data["create_fenced"]
ok("contract strips a wrapping ```lua fence from `source` before Luau is built (fence_stripped correction)", rec["ok"] and rec["args"]["source"] == "print('fenced')" and any(c["kind"] == "fence_stripped" for c in rec["corrections"]), rec)
r = run("create_fenced")
ok("...and the fenced script compiles and is created", r.get("ok") and src_of(find(SSS, "GateFenced")) == "print('fenced')", r)
r = run("module_bad")
ok("script_module with broken Luau is refused and not created", (not r.get("ok")) and "SYNTAX ERROR" in str(r.get("error", "")) and find(find(SS, "Total_Modules") or SS, "GateModBad") is None, r)

# ── script_set_source ──
r = run("set_good")
ok("script_set_source valid: written, syntax=ok", r.get("ok") and src_of(mod) == "return 42" and r["data"]["syntax"] == "ok", r)
r = run("set_bad")
ok("script_set_source broken: SYNTAX ERROR, nothing written", (not r.get("ok")) and "SYNTAX ERROR" in str(r.get("error", "")) and "nothing written" in str(r.get("error", "")), r)
ok("...source unchanged", src_of(mod) == "return 42")
ok("...the error tells the model how to proceed (fix and resend / unchecked=true)", "resend" in str(r.get("error", "")) and "unchecked=true" in str(r.get("error", "")), r)
r = run("set_bad_unchecked")
ok("script_set_source unchecked=true writes and reports syntax=unchecked", r.get("ok") and src_of(find(SSS, "GateForced")) == "if x then" and r["data"]["syntax"] == "unchecked", r)

# ── script_append ──
r = run("append_good")
ok("script_append valid: combined source written", r.get("ok") and src_of(mod) == "return 42\n-- trailing comment", r)
r = run("append_bad")
ok("script_append whose COMBINED source breaks is refused", (not r.get("ok")) and "SYNTAX ERROR" in str(r.get("error", "")) and "combined source" in str(r.get("error", "")), r)
ok("...source unchanged after refused append", src_of(mod) == "return 42\n-- trailing comment")

# ── script_replace / script_insert ──
r = run("replace_good")
ok("script_replace valid result: written", r.get("ok") and src_of(mod).startswith("return 43"), r)
r = run("replace_bad")
ok("script_replace that would break the script is refused", (not r.get("ok")) and "SYNTAX ERROR" in str(r.get("error", "")) and "nothing changed" in str(r.get("error", "")), r)
ok("...source unchanged after refused replace", src_of(mod).startswith("return 43"))
r = run("insert_good")
ok("script_insert valid result: written at top", r.get("ok") and src_of(mod).startswith("local y = 1\nreturn 43"), r)
r = run("insert_bad")
ok("script_insert that would break the script is refused", (not r.get("ok")) and "SYNTAX ERROR" in str(r.get("error", "")) and "nothing inserted" in str(r.get("error", "")), r)
ok("...source unchanged after refused insert", src_of(mod).startswith("local y = 1\nreturn 43"))

# ── script_check (the fixed command) ──
r = run("check_good")
ok("script_check on a clean script: compiles clean, syntax=ok", r.get("ok") and r["data"]["syntax"] == "ok", r)
r = run("check_bad")
ok("script_check on broken source REPORTS the compile error (pre-1.99.8 said 'clean')", (not r.get("ok")) and "COMPILE ERROR" in str(r.get("error", "")), r)
r = run("check_bad_path")
ok("script_check by path on the forced-broken script reports the error", (not r.get("ok")) and "COMPILE ERROR" in str(r.get("error", "")), r)

# ── no loadstring (e.g. a restricted context): honest fallback ──
L.execute("loadstring = nil")
r = run("set_no_loadstring")
ok("without loadstring the write proceeds and reports syntax=unchecked (never pretends it checked)", r.get("ok") and src_of(mod) == "return 7" and r["data"]["syntax"] == "unchecked", r)
r = run("check_good")
ok("without loadstring script_check says so instead of 'compiles clean'", (not r.get("ok")) and "not available" in str(r.get("error", "")), r)

# ── classification: the loop maps the refusal to SYNTAX_ERROR (deterministic → repeat guard applies) ──
CLS = r"""
const C=require(process.cwd()+"/src/core/command_contract.js");
const msgs=JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(msgs.map(m=>{const c=C.classify("script_set_source", m);return c&&c.code;})));
"""
L.execute("loadstring = function(src) return load(src, '=chunk') end")
r = run("set_bad")
codes = json.loads(subprocess.check_output(["node", "-e", CLS, json.dumps(["ERROR: " + str(r.get("error", ""))])], text=True))
ok("the refusal classifies as SYNTAX_ERROR for the loop guard", codes == ["SYNTAX_ERROR"], codes)

n_pass, n_fail = sum(results), len(results) - sum(results)
print(("OK    " if not n_fail else "FAIL  ") + "syntax-gate-sim: %d passed, %d failed (mocked - no live Studio)" % (n_pass, n_fail))
sys.exit(1 if n_fail else 0)
