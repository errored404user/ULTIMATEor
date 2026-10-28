#!/usr/bin/env python3
"""Run tools/blender_asset.py (and blender_ops.py dump) against the fake bpy in
fixtures/fakebpy_asset - tests only, MOCK Blender. Input: a JSON file with a
list of [command, args] steps; every step is executed the way TotalScript
sends it (token substitution + exec, stdout captured) in ONE process so later
steps see the objects earlier steps built. Output: one JSON line with the list
of parsed TOTAL_MESH_JSON results plus the mock's operator log."""
import contextlib
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(HERE, "fakebpy_asset"))
import bpy  # noqa: E402  (the fake)

steps = json.load(open(sys.argv[1], encoding="utf-8"))
workdir = sys.argv[2] if len(sys.argv) > 2 else os.path.join("/tmp", "total_asset_test")
os.makedirs(workdir, exist_ok=True)
ASSET_CMDS = {"asset_build", "asset_validate", "asset_inspect", "asset_export"}
SRC = {"asset": open(os.path.join(ROOT, "tools", "blender_asset.py"), encoding="utf-8").read(), "ops": open(os.path.join(ROOT, "tools", "blender_ops.py"), encoding="utf-8").read()}
results = []
def fake_step(args):
    """Mutate the mock scene the way a user / older file could: broken meshes,
    missing texture files, default names - so the validators have something to find."""
    if args.get("add_broken_mesh"):
        me = bpy.data.meshes.new("Broken")
        # a quad, a zero-area triangle, and a loose vertex
        me.set_geometry([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (2, 2, 0), (2, 2, 0), (3, 3, 0), (9, 9, 9)], [(0, 1, 2, 3), (4, 5, 6)])
        o = bpy.data.objects.new(str(args["add_broken_mesh"]), me)
        o.scale = (2.0, 2.0, 2.0)
        bpy.context.scene.collection.objects.link(o)
        return {"ok": True, "object": o.name}
    if args.get("add_missing_texture"):
        mat = bpy.data.materials.get(args["add_missing_texture"])
        if mat is None:
            return {"ok": False, "error": "no material " + args["add_missing_texture"]}
        n = mat.node_tree.nodes.new("ShaderNodeTexImage")

        class _Img:
            name = "rust_albedo.png"
            filepath = "/nonexistent/textures/rust_albedo.png"
            packed_file = None
        n.image = _Img()
        return {"ok": True, "material": mat.name}
    if args.get("rename"):
        o = bpy.data.objects.get(args["rename"][0])
        if o:
            o.name = args["rename"][1]
        return {"ok": bool(o)}
    return {"ok": False, "error": "unknown fake step"}


for cmd, args in steps:
    if cmd == "__fake__":
        results.append({"cmd": cmd, "result": fake_step(args or {}), "exception": None, "stdout_len": 0})
        continue
    src = SRC["asset"] if cmd in ASSET_CMDS else SRC["ops"]
    code = src.replace("__TOTAL_CMD__", cmd).replace("__TOTAL_ARGS__", json.dumps(args or {})).replace("__TOTAL_OUT__", json.dumps(os.path.join(workdir, "total_status.json"))).replace("__TOTAL_MESH__", json.dumps(os.path.join(workdir, "total_mesh.json")))
    buf = io.StringIO()
    err = None
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "<" + cmd + ">", "exec"), {"__name__": "__total__"})
    except Exception as e:  # the real addon reports exceptions the same way
        import traceback
        err = {"exception": type(e).__name__, "message": str(e), "traceback": traceback.format_exc()[-2000:]}
    out = buf.getvalue()
    parsed = None
    for line in out.splitlines():
        if line.startswith("TOTAL_MESH_JSON:"):
            try:
                parsed = json.loads(line[len("TOTAL_MESH_JSON:"):])
            except Exception:
                parsed = {"ok": False, "error": "unparsable TOTAL_MESH_JSON"}
    results.append({"cmd": cmd, "result": parsed, "exception": err, "stdout_len": len(out)})
print(json.dumps({"results": results, "log": bpy.LOG, "scene_engine": bpy.context.scene.render.engine, "scene_camera": bpy.context.scene.camera.name if bpy.context.scene.camera else None, "objects": [{"name": o.name, "type": o.type, "parent": o.parent.name if o.parent else None, "modifiers": [m.type for m in o.modifiers], "applied": list(o.data.applied_modifiers) if o.type == "MESH" else [], "props": dict(o._props), "mats": [m.name for m in o.data.materials] if o.type == "MESH" else [], "uv": bool(o.data.uv_layers) if o.type == "MESH" else None, "smooth": (sum(1 for p in o.data.polygons if p.use_smooth), len(o.data.polygons)) if o.type == "MESH" else None, "collections": [c.name for c in o.users_collection]} for o in bpy.data.objects], "collections": [c.name for c in bpy.data.collections]}, default=lambda o: sorted(o) if isinstance(o, set) else str(o)))
