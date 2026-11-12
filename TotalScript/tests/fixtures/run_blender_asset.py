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
ASSET_CMDS = {"asset_build", "asset_validate", "asset_inspect", "asset_export", "asset_bake"}
STUDIO_CMDS = {"light_rig", "camera_rig", "world_setup", "render_setup", "render_shot", "turntable", "studio_clear"}
SRC = {"asset": open(os.path.join(ROOT, "tools", "blender_asset.py"), encoding="utf-8").read(), "ops": open(os.path.join(ROOT, "tools", "blender_ops.py"), encoding="utf-8").read(), "studio": open(os.path.join(ROOT, "tools", "blender_studio.py"), encoding="utf-8").read()}
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
    if args.get("add_base_texture"):
        # 2.0.0: a real (fake) image block linked straight into Base Color, the
        # way a textured Blender material looks - dump must carry it as RGBA.
        mat = bpy.data.materials.get(args["add_base_texture"])
        if mat is None:
            return {"ok": False, "error": "no material " + args["add_base_texture"]}
        w, h = int(args.get("w") or 64), int(args.get("h") or 32)
        img = bpy.data.images.new(str(args.get("image") or "albedo.png"), w, h)
        img.filepath = "/tmp/" + img.name
        n = mat.node_tree.nodes.new("ShaderNodeTexImage")
        n.image = img
        bsdf = next((x for x in mat.node_tree.nodes if x.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            return {"ok": False, "error": "material has no Principled BSDF"}
        mat.node_tree.links.new(n.outputs["Color"], bsdf.inputs["Base Color"])
        return {"ok": True, "material": mat.name, "image": img.name, "size": [w, h]}
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
    src = SRC["asset"] if cmd in ASSET_CMDS else SRC["studio"] if cmd in STUDIO_CMDS else SRC["ops"]
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
print(json.dumps({"results": results, "log": bpy.LOG, "scene": {"world": bpy.context.scene.world.name if bpy.context.scene.world else None, "res": [bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y], "samples": bpy.context.scene.cycles.samples, "eevee_samples": bpy.context.scene.eevee.taa_render_samples, "transparent": bpy.context.scene.render.film_transparent, "view_transform": bpy.context.scene.view_settings.view_transform, "fps": bpy.context.scene.render.fps, "frames": [bpy.context.scene.frame_start, bpy.context.scene.frame_end], "lights": [{"name": o.name, "type": o.data.type, "energy": o.data.energy, "color": list(o.data.color), "props": dict(o._props)} for o in bpy.data.objects if o.type == "LIGHT"], "cameras": [{"name": o.name, "lens": o.data.lens, "dof": o.data.dof.use_dof, "focus": o.data.dof.focus_distance, "loc": list(o.location), "props": dict(o._props)} for o in bpy.data.objects if o.type == "CAMERA"]}, "scene_engine": bpy.context.scene.render.engine, "scene_camera": bpy.context.scene.camera.name if bpy.context.scene.camera else None, "objects": [{"name": o.name, "type": o.type, "parent": o.parent.name if o.parent else None, "modifiers": [m.type for m in o.modifiers], "applied": list(o.data.applied_modifiers) if o.type == "MESH" else [], "props": dict(o._props), "mats": [m.name for m in o.data.materials] if o.type == "MESH" else [], "uv": bool(o.data.uv_layers) if o.type == "MESH" else None, "smooth": (sum(1 for p in o.data.polygons if p.use_smooth), len(o.data.polygons)) if o.type == "MESH" else None, "collections": [c.name for c in o.users_collection]} for o in bpy.data.objects], "collections": [c.name for c in bpy.data.collections], "materials": [{"name": m.name, "nodes": [n.type for n in m.node_tree.nodes] if m.node_tree else [], "links": len(m.node_tree.links) if m.node_tree else 0, "props": dict(m._props), "images": [n.image.name for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image is not None] if m.node_tree else []} for m in bpy.data.materials]}, default=lambda o: sorted(o) if isinstance(o, set) else str(o)))
