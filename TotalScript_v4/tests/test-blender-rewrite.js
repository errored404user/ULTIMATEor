"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  -> " + String(extra).slice(0, 500) : "")); }
}

const bg = read("background.js");
const ops = read("tools/blender_ops.py");
const asset = read("tools/blender_asset.py");
const studio = read("tools/blender_studio.py");
const oncePy = read("tools/blender_once.py");
const oncePs = read("tools/blender_once.ps1");
const shimPy = read("tools/launch_blender_mcp.py");

// 1. Transport O(N) framing & bug fixes
ok("T1 blender_once.py uses O(N) _JsonFrameScanner + 64KB chunks + TCP_NODELAY",
  oncePy.includes("class _JsonFrameScanner") && oncePy.includes("RECV_CHUNK = 65536") && oncePy.includes("TCP_NODELAY"));
ok("T2 blender_once.ps1 uses O(N) TotalJsonFrameScanner + 64KB chunks + NoDelay",
  oncePs.includes("TotalJsonFrameScanner") && oncePs.includes("byte[] 65536") && oncePs.includes("NoDelay = $true"));
ok("T3 launch_blender_mcp.py fixes top-level return SyntaxError in blender_export_fbx",
  !shimPy.includes("return {'filepath': fp, 'objects': selected}") && shimPy.includes("TOTAL_MESH_JSON:"));

// 2. Extract and run wrapBlenderUserCode against real CPython + fakebpy_asset (simulating Blender 4.3)
const mWrap = bg.match(/function wrapBlenderUserCode\(code\) \{[\s\S]*?\n\}/);
ok("W1 wrapBlenderUserCode extracted from background.js", !!mWrap);
const ctx = {};
vm.runInNewContext(mWrap[0], ctx);

const legacyAiCode = `
import bpy
bpy.context.scene.render.engine = 'BLENDER_EEVEE_NEXT'
mat = ts_principled('HeroMetal', color=(0.2, 0.5, 0.8), metallic=0.9, roughness=0.25)
bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
bsdf.inputs['Specular'].default_value = 0.6
bsdf.inputs['Transmission'].default_value = 0.1
bsdf.inputs['Emission'].default_value = (0.1, 0.4, 0.9, 1.0)
n, fac, a, b, out = ts_mix_rgb(mat.node_tree, 'MULTIPLY', 0.5, 'TestMix')
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
obj = ts_make_mesh('CompatCube', bm, material=mat, smooth_angle=30.0)
obj.data.use_auto_smooth = True
obj.data.auto_smooth_angle = 0.52
obj.data.calc_normals_split()
print('COMPAT_DONE:' + obj.name + ':' + n.type + ':' + str(round(bsdf.inputs['Specular IOR Level'].default_value, 2)))
`;

const wrapped = ctx.wrapBlenderUserCode(legacyAiCode);
const pyExec = spawnSync("python3", ["-c", `
import sys, os
sys.path.insert(0, ${JSON.stringify(path.join(root, "tests", "fixtures", "fakebpy_asset"))})
import bpy
bpy.app.version = (4, 3, 2)
exec(compile(${JSON.stringify(wrapped)}, '<wrapped>', 'exec'), {'__name__': '__main__'})
`], { encoding: "utf8", timeout: 10000 });

const out = String(pyExec.stdout || "") + String(pyExec.stderr || "");
ok("W2 wrapBlenderUserCode executes legacy Blender 3.x AI code cleanly on Blender 4.3 with zero errors",
  pyExec.status === 0 && out.includes("COMPAT_DONE:CompatCube:MIX:0.6"), out);

// Test structured error reporting when user code genuinely raises
const badWrapped = ctx.wrapBlenderUserCode("x = 1 / 0");
const pyErr = spawnSync("python3", ["-c", `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(root, "tests", "fixtures", "fakebpy_asset"))})
import bpy
bpy.app.version = (5, 0, 0)
exec(compile(${JSON.stringify(badWrapped)}, '<wrapped_err>', 'exec'), {'__name__': '__main__'})
`], { encoding: "utf8", timeout: 10000 });
const errOut = String(pyErr.stdout || "");
const errLine = errOut.split(/\r?\n/).find((l) => l.startsWith("TOTAL_MESH_JSON:"));
const errJson = errLine ? JSON.parse(errLine.slice("TOTAL_MESH_JSON:".length)) : null;
ok("W3 wrapBlenderUserCode catches runtime exceptions and emits structured TOTAL_MESH_JSON with line & hint",
  errJson && errJson.ok === false && errJson.blender === "5.0.0" && errJson.line === 1 && /ZeroDivisionError/.test(errJson.error) && !!errJson.hint, errOut);

// 3. Verify blender_asset.py uses ShaderNodeMix (RGBA) instead of removed ShaderNodeMixRGB on Blender 4.x/5.0
const pyMat = spawnSync("python3", ["-c", `
import sys, json, os, io, contextlib
sys.path.insert(0, ${JSON.stringify(path.join(root, "tests", "fixtures", "fakebpy_asset"))})
import bpy
bpy.app.version = (4, 4, 0)
src = open(${JSON.stringify(path.join(root, "tools", "blender_asset.py"))}, encoding='utf-8').read()
spec = {
  "name": "MixTestAsset", "category": "prop", "style": "realistic", "dims": [1, 1, 1], "studs_per_meter": 3.5,
  "materials": {
    "wood": {"family": "wood", "color": [0.4, 0.25, 0.15], "roughness": 0.7, "wear": True},
    "stone": {"family": "stone", "color": [0.5, 0.5, 0.5], "roughness": 0.8},
    "metal": {"family": "steel", "color": [0.7, 0.72, 0.75], "metallic": 1.0, "roughness": 0.3},
    "paint": {"family": "painted_metal", "color": [0.2, 0.4, 0.7], "metallic": 0.6, "roughness": 0.4},
    "cloth": {"family": "fabric", "color": [0.6, 0.2, 0.2], "roughness": 0.9},
    "glass": {"family": "glass", "color": [0.8, 0.95, 1.0], "roughness": 0.05, "alpha": 0.3}
  },
  "parts": [
    {"name": "Base", "role": "primary", "shape": "box", "size": [1, 1, 0.5], "pos": [0, 0, 0.25], "material": "wood"},
    {"name": "Cap", "role": "secondary", "shape": "cylinder", "size": [0.5, 0.5, 0.5], "pos": [0, 0, 0.75], "material": "paint"}
  ]
}
code = src.replace("__TOTAL_CMD__", "asset_build").replace("__TOTAL_ARGS__", json.dumps({"spec": spec})).replace("__TOTAL_OUT__", '""').replace("__TOTAL_MESH__", '""')
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    exec(compile(code, '<asset_build>', 'exec'), {'__name__': '__total__'})
mix_rgb = [n.name for m in bpy.data.materials if m.node_tree for n in m.node_tree.nodes if n.bl_idname == 'ShaderNodeMixRGB']
mix_v4 = [n.name for m in bpy.data.materials if m.node_tree for n in m.node_tree.nodes if n.bl_idname == 'ShaderNodeMix' and getattr(n, 'data_type', None) == 'RGBA']
print(json.dumps({"mix_rgb": mix_rgb, "mix_v4_count": len(mix_v4), "out_ok": '"ok":true' in buf.getvalue()}))
`], { encoding: "utf8", timeout: 10000 });
const matRes = pyMat.status === 0 ? JSON.parse(String(pyMat.stdout || "{}").trim()) : null;
ok("A1 blender_asset.py uses ShaderNodeMix (RGBA) with ZERO deprecated ShaderNodeMixRGB nodes on Blender 4.4+",
  matRes && matRes.out_ok === true && matRes.mix_rgb.length === 0 && matRes.mix_v4_count >= 5, String(pyMat.stdout) + String(pyMat.stderr));

// 4. Verify blender_ops.py rewritten commands (24 modifiers, stats, set_render per-engine samples, principled v2, Blender 5.0 slotted actions)
const pyOps = spawnSync("python3", ["-c", `
import sys, json, io, contextlib
sys.path.insert(0, ${JSON.stringify(path.join(root, "tests", "fixtures", "fakebpy_asset"))})
import bpy
bpy.app.version = (5, 0, 0)
src = open(${JSON.stringify(path.join(root, "tools", "blender_ops.py"))}, encoding='utf-8').read()
def run(cmd, args):
    code = src.replace("__TOTAL_CMD__", cmd).replace("__TOTAL_ARGS__", json.dumps(args)).replace("__TOTAL_OUT__", '""').replace("__TOTAL_MESH__", '""')
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(code, '<ops>', 'exec'), {'__name__': '__total__'})
    for line in reversed(buf.getvalue().splitlines()):
        if line.startswith("TOTAL_MESH_JSON:"):
            return json.loads(line[len("TOTAL_MESH_JSON:"):])
    return None

# Create mesh object
me = bpy.data.meshes.new("Prop")
me.set_geometry([(0,0,2),(1,0,2),(1,1,2),(0,1,2),(0,0,3),(1,0,3),(1,1,3),(0,1,3)], [(0,1,2,3),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
obj = bpy.data.objects.new("Prop", me)
bpy.context.scene.collection.objects.link(obj)
bpy.context.view_layer.objects.active = obj

r_intro = run("introspect", {"name": "Prop"})
r_mod = run("add_modifier", {"name": "Prop", "type": "WEIGHTED_NORMAL"})
r_mat = run("principled_material", {"objects": ["Prop"], "material": "PBR_V2", "color": [0.1, 0.6, 0.9], "metallic": 0.8, "roughness": 0.2, "coat": 0.5, "emission": [0.1, 0.8, 1.0], "emission_strength": 2.0})
r_drop = run("drop_to_ground", {"objects": ["Prop"]})
r_stats = run("stats", {"objects": ["Prop"]})
r_ren = run("set_render", {"engine": "eevee", "samples": 48, "width": 1280, "height": 720})

# Simulate Blender 5.0 Slotted Action (no top-level .fcurves)
class _CB:
    fcurves = [1, 2, 3]
class _Strip:
    channelbags = [_CB()]
class _Layer:
    strips = [_Strip()]
class _SlotAction:
    name = "Spin5"
    frame_range = (1, 48)
    layers = [_Layer()]
class _AnimData:
    action = _SlotAction()
obj.animation_data = _AnimData()
r_anim = run("animation_list", {})

print(json.dumps({
    "mod_count": len(r_intro.get("modifier_types") or []),
    "wn_ok": r_mod.get("ok"),
    "mat_ok": r_mat.get("ok"),
    "diffuse": list(bpy.data.materials.get("PBR_V2").diffuse_color)[:3],
    "drop_z": round(float(obj.location.z), 3),
    "stats_tris": r_stats.get("total_tris"),
    "ren_engine": r_ren.get("engine"),
    "eevee_samples": bpy.context.scene.eevee.taa_render_samples,
    "anim_fcurves": r_anim["animations"][0]["fcurves"] if r_anim.get("animations") else 0
}))
`], { encoding: "utf8", timeout: 10000 });
const opsRes = pyOps.status === 0 ? JSON.parse(String(pyOps.stdout || "{}").trim()) : null;
ok("O1 blender_ops.py supports 24 modifiers (incl. WEIGHTED_NORMAL), syncs PBR v2 + diffuse_color, drops via evaluated bounds, sets EEVEE samples, and reads Blender 5.0 Slotted Actions",
  opsRes && opsRes.mod_count >= 24 && opsRes.wn_ok && opsRes.mat_ok && Math.abs(opsRes.diffuse[2] - 0.9) < 0.01 && Math.abs(opsRes.drop_z - (-2.0)) < 0.01 && opsRes.stats_tris === 12 && opsRes.eevee_samples === 48 && opsRes.anim_fcurves === 3,
  String(pyOps.stdout) + String(pyOps.stderr));

// 5. Verify blender_studio.py updates view_layer and supports Slotted Actions
ok("S1 blender_studio.py updates view_layer in target_bounds and handles Blender 5.0 Slotted Actions",
  studio.includes("bpy.context.view_layer.update()") && studio.includes("channelbags"));

console.log(`test-blender-rewrite: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
