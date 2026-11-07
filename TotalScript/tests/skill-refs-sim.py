#!/usr/bin/env python3
"""tests/skill-refs-sim.py — parse every reference example in src/core/skill_refs.js
with a real Lua parser (lupa), so the "tested patterns" the AI copies from are at
least syntactically valid Luau-compatible Lua.

    pip install lupa && python3 tests/skill-refs-sim.py          (from the TotalScript root)

Honesty note: `load` compiles the chunk; nothing is executed and no Roblox API is
mocked here — Roblox-only syntax (type annotations, `continue`, `+=`) is kept OUT
of the examples on purpose so the stock parser can check them. Run-time behaviour
in Studio is NOT covered by this file.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
try:
    import lupa  # noqa: F401
    from lupa import LuaRuntime
except ImportError:
    print("SKIP  lupa not installed (pip install lupa)")
    sys.exit(0)

DUMP = "const R=require(process.argv[1]);process.stdout.write(JSON.stringify(R.all().map(e=>({id:e.id,examples:e.examples}))));"
data = json.loads(subprocess.run(["node", "-e", DUMP, os.path.join(ROOT, "src/core/skill_refs.js")], capture_output=True, text=True, check=True).stdout)

lua = LuaRuntime(unpack_returned_tuples=True)
load = lua.eval("function(src, name) local f, err = load(src, name, 't') if f then return true, '' end return false, err end")

passed = failed = 0
for entry in data:
    for ex in entry["examples"]:
        name = f"{entry['id']} / {ex['title']}"
        body = ex["body"]
        ok, err = load(body, "=" + entry["id"])
        lines = body.count("\n") + 1
        # the shape rules the JS test also enforces, repeated here so a parser pass
        # cannot hide a Roblox-only construct
        shape = ("`" not in body) and (" continue" not in body) and ("+=" not in body) and ("-=" not in body) and ("..=" not in body)
        if ok and shape:
            passed += 1
            print(f"PASS  {name} ({lines} lines)")
        else:
            failed += 1
            print(f"FAIL  {name}: {err or 'shape rule violated'}")

print(f"\n{passed} parsed, {failed} failed")
sys.exit(1 if failed else 0)
