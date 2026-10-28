#!/usr/bin/env python3
"""Line-oriented Studio stand-in for the provider e2e harnesses (1.85.0).

Reads one JSON object per line on stdin - {"id": n, "code": "<luau>"} - runs the
Luau against the miniature DataModel in tests/roblox_sim.py (lupa) and answers
{"id": n, "ok": bool, "text": "<what Studio's execute_luau would print/return>"}.

The DataModel persists for the life of the process, so a second command can
inspect what the first one built - that is what lets the e2e harness check a
VERIFIABLE result (a Part named X with the requested size, anchored) instead
of a canned "OK".

MOCKED: this is not Roblox Studio. It catches wrong shapes, nil indexing and
load errors; it does not render, run physics or solve joints.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tests"))
try:
    from roblox_sim import make_runtime
    L, M, run_program = make_runtime()
except Exception as e:  # pragma: no cover
    sys.stdout.write(json.dumps({"id": 0, "ok": False, "text": "SIM UNAVAILABLE: " + str(e), "unavailable": True}) + "\n")
    sys.stdout.flush()
    sys.exit(0)

sys.stdout.write(json.dumps({"id": 0, "ok": True, "text": "ready"}) + "\n")
sys.stdout.flush()


def run(code):
    """Execute like the plugin's execute_luau: print() lines + the returned value."""
    fn = L.eval("""
function(src)
  local logs = {}
  local env = setmetatable({}, { __index = _G })
  env.print = function(...)
    local t = {}
    for i = 1, select('#', ...) do t[#t + 1] = tostring(select(i, ...)) end
    logs[#logs + 1] = table.concat(t, ' ')
  end
  local f, e = load(src, '=execute_luau', 't', env)
  if not f then return false, 'Luau compile error: ' .. tostring(e), logs end
  local ok, res = pcall(f)
  if not ok then return false, 'Luau runtime error: ' .. tostring(res), logs end
  if type(res) == 'table' then return true, jsonEncode(res), logs end
  return true, res == nil and '' or tostring(res), logs
end
""")
    L.globals().jsonEncode = M.jsonEncode
    ok, text, logs = fn(code)
    lines = []
    try:
        for i in range(1, len(logs) + 1):
            lines.append(str(logs[i]))
    except Exception:
        pass
    out = "\n".join(lines)
    if text:
        out = (out + "\n" if out else "") + str(text)
    return bool(ok), out


for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        msg = json.loads(raw)
    except Exception:
        continue
    if msg.get("op") == "quit":
        break
    code = str(msg.get("code") or "")
    try:
        ok, text = run(code)
    except Exception as e:  # pragma: no cover
        ok, text = False, "SIM ERROR: " + str(e)
    sys.stdout.write(json.dumps({"id": msg.get("id"), "ok": ok, "text": text}) + "\n")
    sys.stdout.flush()
