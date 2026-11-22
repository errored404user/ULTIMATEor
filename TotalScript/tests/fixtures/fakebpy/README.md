Minimal stand-in for Blender's `bpy` / `mathutils` so `tools/blender_ops.py`
can be executed by plain CPython in `tests/test-blender-send.js`:
a flat-shaded cube with a Principled material at (1, 2, 3), a smooth cube with
a node-less material, a 25,000-triangle fan (over Studio's EditableMesh
limit) and a face-less mesh. Not shipped in the extension zip's runtime path.
