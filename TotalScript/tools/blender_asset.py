# TotalScript asset builder (1.84.0). Sent to Blender as execute_code like
# blender_ops.py; tokens CMD / ARGS / OUT / MESH are filled by TotalScript.
#
# Commands
#   asset_build    {spec}                 build a TotalAssetPlan spec: parts with roles, scale-relative
#                                         bevels, boolean cuts / grooves / insets / tapers, displacement,
#                                         PBR materials, UVs, smoothing policy, named hierarchy, origin,
#                                         attachments; returns metrics + the validation report
#   asset_validate {name}                 mesh integrity of an asset (non-manifold, loose, degenerate,
#                                         inconsistent normals, unapplied scale, UVs, names, budgets)
#   asset_inspect  {name, views, size}    neutral preview scene in its own collection, renders
#                                         front / side / top / iso PNGs, removes the scene again
#   asset_export   {name, format, path}   explicit FBX / GLB / OBJ export with fixed settings, then
#                                         checks the file (exists, size, header) and lists textures
#
# Everything is plain bpy / bmesh so it also runs in background Blender
# (blender_once.py). Nothing here uploads anything anywhere.
import bpy
import bmesh
import json
import math
import os
import traceback
from mathutils import Vector, Matrix, Euler

CMD = """__TOTAL_CMD__"""
ARGS = json.loads(r"""__TOTAL_ARGS__""")
if not isinstance(ARGS, dict):
    ARGS = {}
OUT = __TOTAL_OUT__
MESH = __TOTAL_MESH__
if not OUT:
    OUT = "total_status.json"
result = None
WRAP = 3000


def write_wrapped(path, text):
    if not path:
        return ""
    try:
        folder = os.path.dirname(path)
        if folder:
            os.makedirs(folder, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(text[i:i + WRAP] for i in range(0, len(text), WRAP)))
        return path
    except Exception:
        return ""


def emit(payload):
    global result
    result = payload
    try:
        print("TOTAL_MESH_JSON:" + json.dumps(payload, ensure_ascii=True, separators=(",", ":")), flush=True)
    except Exception:
        print("TOTAL_MESH_JSON:{\"ok\":false,\"error\":\"unserializable result\"}", flush=True)
    try:
        write_wrapped(OUT, json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    except Exception:
        pass
    return payload

def blender_version():
    try:
        return ".".join(str(x) for x in bpy.app.version)
    except Exception:
        return ""


def classify_exception(exc, cmd=""):
    """Turn a bpy exception into a structured, actionable error (1.84.0).

    Mirrors TotalCommandContract.classify on the extension side so the model sees
    the SAME categories whether the failure was caught before or inside Blender.
    """
    import re as _re
    msg = str(exc) or exc.__class__.__name__
    out = {"ok": False, "error": msg[:700], "error_class": "runtime_error", "command": str(cmd), "blender": blender_version(), "deterministic": False}
    m = _re.search(r'enum "([^"]*)" not found in \(([^)]*)\)', msg)
    if m:
        allowed = [a.strip().strip("'") for a in m.group(2).split(",") if a.strip()]
        out.update({"error_class": "invalid_enum", "deterministic": True, "value": m.group(1), "allowed": allowed,
                    "hint": "'" + m.group(1) + "' is not a valid choice here - use one of: " + ", ".join(allowed)})
        return out
    if isinstance(exc, TypeError) and "unexpected keyword" in msg:
        m = _re.search(r"keyword argument '([^']+)'", msg)
        out.update({"error_class": "unknown_parameter", "deterministic": True, "parameter": m.group(1) if m else "",
                    "hint": "this Blender version does not accept that argument - drop it or use blender_introspect to see what exists"})
        return out
    if isinstance(exc, AttributeError):
        m = _re.search(r"has no attribute '([^']+)'", msg)
        out.update({"error_class": "api_incompatibility", "deterministic": True, "attribute": m.group(1) if m else "",
                    "hint": "the property/operator does not exist in Blender " + (blender_version() or "?") + " - check blender_introspect before setting it"})
        return out
    if "context is incorrect" in msg or "poll() failed" in msg:
        out.update({"error_class": "invalid_context", "deterministic": False,
                    "hint": "the operator needs a different mode/selection - select the objects (blender_select) and make sure they are visible and in Object mode"})
        return out
    if isinstance(exc, KeyError):
        out.update({"error_class": "resource_missing", "deterministic": False, "hint": "the named datablock does not exist - list objects/materials first and use the exact name"})
        return out
    if isinstance(exc, (ValueError, IndexError)):
        out.update({"error_class": "invalid_parameter", "deterministic": True, "hint": "a parameter has the wrong shape or value - check the schema and the error text"})
        return out
    if isinstance(exc, (OSError, IOError)):
        out.update({"error_class": "io_error", "deterministic": False, "hint": "file/path problem - make sure the folder exists and is writable"})
        return out
    out["trace"] = traceback.format_exc()[-600:]
    return out


def workspace_dir():
    folder = os.path.dirname(OUT) if OUT else ""
    if folder and os.path.isdir(folder):
        return folder
    folder = os.path.join(os.path.expanduser("~"), "Documents", "TotalScript")
    os.makedirs(folder, exist_ok=True)
    return folder


def fnum(v, d=0.0):
    try:
        return float(v)
    except Exception:
        return float(d)


def v3(v, d=(0.0, 0.0, 0.0)):
    if isinstance(v, (list, tuple)) and len(v) >= 3:
        return (fnum(v[0]), fnum(v[1]), fnum(v[2]))
    return tuple(d)


def ident(name, fallback="Part"):
    s = "".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in str(name or ""))
    if not s or not (s[0].isalpha() or s[0] == "_"):
        s = fallback + ("_" + s if s else "")
    return s


# ─────────────────────────── scene helpers ───────────────────────────────────

def scene():
    return bpy.context.scene


def link(obj, coll):
    try:
        coll.objects.link(obj)
    except Exception:
        pass


def unlink_everywhere(obj):
    for c in list(obj.users_collection):
        try:
            c.objects.unlink(obj)
        except Exception:
            pass


def get_collection(name, create=True):
    coll = bpy.data.collections.get(name)
    if coll is None and create:
        coll = bpy.data.collections.new(name)
        scene().collection.children.link(coll)
    elif coll is not None:
        try:
            if coll.name not in [c.name for c in scene().collection.children]:
                scene().collection.children.link(coll)
        except Exception:
            pass
    return coll


def remove_object(obj):
    try:
        data = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        if data is not None and isinstance(data, bpy.types.Mesh) and data.users == 0:
            bpy.data.meshes.remove(data)
    except Exception:
        pass


def clear_collection(coll):
    for o in list(coll.objects):
        remove_object(o)
    for child in list(coll.children):
        clear_collection(child)
        try:
            bpy.data.collections.remove(child)
        except Exception:
            pass


def asset_objects(name):
    """(root empty, collection, mesh objects) of an asset built by asset_build."""
    coll = bpy.data.collections.get(name)
    root = bpy.data.objects.get(name)
    meshes = []
    if coll is not None:
        meshes = [o for o in coll.all_objects if o.type == "MESH"]
    elif root is not None:
        if root.type == "MESH":
            # a plain mesh object (not built by asset_build): validate / export it alone
            meshes = [root]
            root = None
        else:
            meshes = [o for o in root.children_recursive if o.type == "MESH"] if hasattr(root, "children_recursive") else [o for o in bpy.data.objects if o.parent == root and o.type == "MESH"]
    return root, coll, meshes


def evaluated_mesh(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    return ev, ev.to_mesh()


def apply_modifiers(obj):
    """Bake the modifier stack into the mesh without operators (works in
    background mode). Used for destructive construction steps (booleans,
    decimate); the finishing stack (bevel / mirror / array / weighted normal)
    is kept live so the asset stays editable."""
    try:
        dg = bpy.context.evaluated_depsgraph_get()
        ev = obj.evaluated_get(dg)
        new = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    except TypeError:
        dg = bpy.context.evaluated_depsgraph_get()
        new = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    old = obj.data
    new.name = old.name + "_tmp"
    obj.modifiers.clear()
    obj.data = new
    try:
        name = old.name
        bpy.data.meshes.remove(old)
        new.name = name
    except Exception:
        pass
    return obj


def tri_count(obj):
    try:
        ev, me = evaluated_mesh(obj)
        me.calc_loop_triangles()
        n = len(me.loop_triangles)
        ev.to_mesh_clear()
        return n
    except Exception:
        try:
            return sum(max(0, len(p.vertices) - 2) for p in obj.data.polygons)
        except Exception:
            return 0


# ─────────────────────────── primitive construction ─────────────────────────

def bm_primitive(shape, size, segments=24, subdivisions=2):
    bm = bmesh.new()
    sx, sy, sz = [max(1e-4, float(x)) for x in size]
    if shape == "box":
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    elif shape in ("cylinder", "cone"):
        r2 = 0.0 if shape == "cone" else 1.0
        try:
            bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=max(3, int(segments)), radius1=1.0, radius2=r2, depth=1.0)
        except TypeError:
            bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=max(3, int(segments)), diameter1=2.0, diameter2=r2 * 2.0, depth=1.0)
        bmesh.ops.scale(bm, vec=(sx / 2.0, sy / 2.0, sz), verts=bm.verts)
    elif shape == "sphere":
        seg = max(6, int(segments))
        try:
            bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(4, seg // 2), radius=1.0)
        except TypeError:
            bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(4, seg // 2), diameter=2.0)
        bmesh.ops.scale(bm, vec=(sx / 2.0, sy / 2.0, sz / 2.0), verts=bm.verts)
    elif shape == "ico":
        try:
            bmesh.ops.create_icosphere(bm, subdivisions=max(1, min(4, int(subdivisions))), radius=1.0)
        except TypeError:
            bmesh.ops.create_icosphere(bm, subdivisions=max(1, min(4, int(subdivisions))), diameter=2.0)
        bmesh.ops.scale(bm, vec=(sx / 2.0, sy / 2.0, sz / 2.0), verts=bm.verts)
    elif shape == "torus":
        # major radius from x, minor from z (tube thickness)
        major = sx / 2.0
        minor = max(1e-4, sz / 2.0)
        seg = max(6, int(segments))
        rings = max(4, int(segments) // 2)
        verts = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            ring = []
            for j in range(rings):
                b = 2 * math.pi * j / rings
                r = major + minor * math.cos(b)
                ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), minor * math.sin(b))))
            verts.append(ring)
        for i in range(seg):
            for j in range(rings):
                a0 = verts[i][j]
                a1 = verts[i][(j + 1) % rings]
                b0 = verts[(i + 1) % seg][j]
                b1 = verts[(i + 1) % seg][(j + 1) % rings]
                try:
                    bm.faces.new((a0, b0, b1, a1))
                except ValueError:
                    pass
        bmesh.ops.scale(bm, vec=(1.0, sy / sx if sx else 1.0, 1.0), verts=bm.verts)
    else:
        raise ValueError("unknown shape " + str(shape))
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def bm_bounds(bm):
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    zs = [v.co.z for v in bm.verts]
    if not xs:
        return (0, 0, 0), (0, 0, 0)
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def op_taper(bm, op):
    axis = {"x": 0, "y": 1, "z": 2}.get(str(op.get("axis") or "z"), 2)
    top = fnum(op.get("top"), 1.0)
    bottom = fnum(op.get("bottom"), 1.0)
    lo, hi = bm_bounds(bm)
    span = hi[axis] - lo[axis]
    if span <= 1e-9:
        return
    for v in bm.verts:
        t = (v.co[axis] - lo[axis]) / span
        f = bottom + (top - bottom) * t
        co = list(v.co)
        for a in range(3):
            if a != axis:
                co[a] *= f
        v.co = Vector(co)


def op_bulge(bm, op):
    amount = fnum(op.get("amount"), 0.1)
    lo, hi = bm_bounds(bm)
    span = hi[2] - lo[2]
    if span <= 1e-9:
        return
    for v in bm.verts:
        t = (v.co.z - lo[2]) / span
        f = 1.0 + amount * math.sin(math.pi * t)
        v.co.x *= f
        v.co.y *= f


def op_flatten_bottom(bm, op):
    level = fnum(op.get("level"), 0.1)
    lo, hi = bm_bounds(bm)
    cut = lo[2] + (hi[2] - lo[2]) * level
    for v in bm.verts:
        if v.co.z < cut:
            v.co.z = cut


def op_displace(bm, op):
    from mathutils import noise
    strength = fnum(op.get("strength"), 0.05)
    scale = max(1e-4, fnum(op.get("scale"), 1.0))
    detail = max(1, int(fnum(op.get("detail"), 1)))
    seed = fnum(op.get("seed"), 1.0)
    bm.normal_update()
    offs = Vector((seed * 13.7, seed * 7.3, seed * 3.1))
    for v in bm.verts:
        p = (v.co / scale) + offs
        n = 0.0
        amp = 1.0
        freq = 1.0
        tot = 0.0
        for _ in range(detail):
            try:
                n += noise.noise(p * freq) * amp
            except TypeError:
                n += noise.noise(p * freq, noise_basis="PERLIN_ORIGINAL") * amp
            tot += amp
            amp *= 0.5
            freq *= 2.1
        v.co += v.normal * (n / tot) * strength


def op_inset(bm, op, size):
    faces_sel = str(op.get("faces") or "top")
    thickness = max(0.0, fnum(op.get("thickness"), 0.01))
    depth = fnum(op.get("depth"), 0.0)
    bm.normal_update()
    want = []
    for f in bm.faces:
        n = f.normal
        pick = False
        if faces_sel in ("top", "+z"):
            pick = n.z > 0.7
        elif faces_sel in ("bottom", "-z"):
            pick = n.z < -0.7
        elif faces_sel == "sides":
            pick = abs(n.z) < 0.3
        elif faces_sel == "x":
            pick = abs(n.x) > 0.7
        elif faces_sel == "y":
            pick = abs(n.y) > 0.7
        elif faces_sel == "caps":
            pick = abs(n.z) > 0.7
        elif faces_sel == "all":
            pick = True
        if pick:
            want.append(f)
    if not want:
        return 0
    minext = min(size)
    thickness = min(thickness, minext * 0.45)
    res = bmesh.ops.inset_individual(bm, faces=want, thickness=thickness, depth=0.0, use_even_offset=True)
    if abs(depth) > 1e-9:
        # push the inner faces along their normal (negative = recess)
        bm.normal_update()
        inner = want
        for f in inner:
            for v in f.verts:
                pass
        moved = set()
        for f in inner:
            n = f.normal.copy()
            for v in f.verts:
                if v.index in moved:
                    continue
                v.co += n * depth
                moved.add(v.index)
    return len(want)


def make_cutter(shape, size, pos, rot_deg, coll, name):
    bm = bm_primitive(shape if shape in ("box", "cylinder", "sphere") else "box", size, segments=24)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    obj.location = pos
    obj.rotation_euler = Euler([math.radians(a) for a in rot_deg], "XYZ")
    link(obj, coll)
    obj.display_type = "WIRE"
    return obj


def boolean_cut(obj, cutters):
    """Difference-boolean a list of cutter objects out of obj, bake the result,
    delete the cutters. Returns the number of cutters that produced geometry."""
    done = 0
    for c in cutters:
        mod = obj.modifiers.new(name="TotalCut", type="BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.object = c
        try:
            mod.solver = "EXACT"
        except Exception:
            pass
        try:
            mod.use_self = False
        except Exception:
            pass
        done += 1
    bpy.context.view_layer.update()
    apply_modifiers(obj)
    for c in cutters:
        remove_object(c)
    return done


def op_cut_objects(obj, op, part, coll):
    shape = str(op.get("shape") or "box")
    size = v3(op.get("size"), (0.1, 0.1, 0.1))
    rel = v3(op.get("pos"))
    rot = v3(op.get("rot"))
    cutters = []
    base = obj.matrix_world
    specs = [rel]
    if op.get("mirror") == "x":
        specs.append((-rel[0], rel[1], rel[2]))
    elif op.get("mirror") == "y":
        specs.append((rel[0], -rel[1], rel[2]))
    for i, r in enumerate(specs):
        world = base @ Vector(r)
        c = make_cutter(shape, size, world, rot, coll, obj.name + "_cut%d" % i)
        # inherit the part rotation so cut rot is relative to the part
        c.matrix_world = base @ Matrix.Translation(Vector(r)) @ Euler([math.radians(a) for a in rot], "XYZ").to_matrix().to_4x4()
        c.scale = (1, 1, 1)
        cutters.append(c)
    return boolean_cut(obj, cutters)


def op_grooves_objects(obj, op, part, coll):
    """Panel lines / fuller / stave lines as boolean grooves. faces: top |
    sides | x | y | ring (bands around a cylinder) | ring_vertical (flutes)."""
    count = int(fnum(op.get("count"), 1))
    if count <= 0:
        return 0
    size = [float(x) for x in part["size"]]
    width = max(0.0008, fnum(op.get("width"), 0.01))
    depth = max(0.0005, fnum(op.get("depth"), 0.005))
    axis = str(op.get("axis") or "z")
    faces = str(op.get("faces") or "top")
    length = fnum(op.get("length"), 0.0)
    off_z = fnum(op.get("offset_z"), 0.0)
    ai = {"x": 0, "y": 1, "z": 2}.get(axis, 2)
    base = obj.matrix_world
    cutters = []
    span = size[ai]
    if faces in ("ring", "ring_vertical"):
        r = max(size[0], size[1]) / 2.0
        if faces == "ring":
            for i in range(count):
                z = -size[2] / 2.0 + size[2] * (i + 1) / (count + 1)
                # annulus: big short cylinder minus an inner cylinder -> two cutters would be
                # needed; use a thin tall box ring approximated by 4 boxes is wrong for round
                # parts, so cut with a hollow ring built from bmesh instead.
                me = bpy.data.meshes.new(obj.name + "_ring")
                bm = bmesh.new()
                seg = 32
                outer = r * 1.5
                inner = r - depth
                lo = []
                hi = []
                for k in range(seg):
                    a = 2 * math.pi * k / seg
                    lo.append((bm.verts.new((inner * math.cos(a), inner * math.sin(a), -width / 2)), bm.verts.new((outer * math.cos(a), outer * math.sin(a), -width / 2))))
                    hi.append((bm.verts.new((inner * math.cos(a), inner * math.sin(a), width / 2)), bm.verts.new((outer * math.cos(a), outer * math.sin(a), width / 2))))
                for k in range(seg):
                    k2 = (k + 1) % seg
                    bm.faces.new((lo[k][0], lo[k][1], lo[k2][1], lo[k2][0]))
                    bm.faces.new((hi[k][0], hi[k2][0], hi[k2][1], hi[k][1]))
                    bm.faces.new((lo[k][1], hi[k][1], hi[k2][1], lo[k2][1]))
                    bm.faces.new((lo[k][0], lo[k2][0], hi[k2][0], hi[k][0]))
                bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
                bm.to_mesh(me)
                bm.free()
                c = bpy.data.objects.new(obj.name + "_ring%d" % i, me)
                link(c, coll)
                c.matrix_world = base @ Matrix.Translation(Vector((0, 0, z)))
                cutters.append(c)
        else:
            for i in range(count):
                a = 2 * math.pi * i / count
                rel = Vector((math.cos(a) * r, math.sin(a) * r, 0.0))
                c = make_cutter("box", (depth * 2, width, size[2] * 0.8 if not length else length), base @ rel, (0, 0, 0), coll, obj.name + "_flute%d" % i)
                c.matrix_world = base @ Matrix.Translation(rel) @ Matrix.Rotation(a, 4, "Z")
                cutters.append(c)
    else:
        # grooves across `faces`, spaced along `axis`
        groove_len = length if length else None
        for i in range(count):
            t = (i + 1) / (count + 1)
            pos_along = -span / 2.0 + span * t + off_z
            sizes = []
            offsets = []
            if faces == "top":
                s = [size[0] * 0.9, size[1] * 0.9, depth * 2]
                s[ai] = width
                if groove_len:
                    s[(ai + 1) % 3 if ai != 2 else 0] = groove_len
                o = [0, 0, size[2] / 2.0]
                o[ai] = pos_along
                sizes.append(s)
                offsets.append(o)
            elif faces in ("sides", "x", "y"):
                for ax in ((0, 1) if faces == "sides" else ((0,) if faces == "x" else (1,))):
                    if ax == ai:
                        continue
                    for sgn in (1, -1):
                        s = [size[0] * 0.9, size[1] * 0.9, size[2] * 0.9]
                        s[ax] = depth * 2
                        s[ai] = width
                        if groove_len:
                            s[3 - ax - ai] = groove_len
                        o = [0, 0, 0]
                        o[ax] = sgn * size[ax] / 2.0
                        o[ai] = pos_along
                        sizes.append(s)
                        offsets.append(o)
            for k, (s, o) in enumerate(zip(sizes, offsets)):
                c = make_cutter("box", s, base @ Vector(o), (0, 0, 0), coll, obj.name + "_groove%d_%d" % (i, k))
                c.matrix_world = base @ Matrix.Translation(Vector(o))
                cutters.append(c)
    if not cutters:
        return 0
    return boolean_cut(obj, cutters)


# ─────────────────────────── UVs / smoothing / materials ────────────────────

def box_project_uvs(obj, texel=1.0):
    """Deterministic box projection (world-size based so a 1 m face spans
    `texel` UV units) - works in background mode; smart_project is tried
    first for organic shapes."""
    me = obj.data
    uv = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    me.calc_loop_triangles()
    data = uv.data
    for poly in me.polygons:
        n = poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if ax == 0:
                u, v = co.y, co.z
            elif ax == 1:
                u, v = co.x, co.z
            else:
                u, v = co.x, co.y
            data[li].uv = (u * texel + 0.5, v * texel + 0.5)
    return uv.name


def unwrap(obj, organic):
    if organic:
        try:
            bpy.context.view_layer.objects.active = obj
            for o in bpy.context.view_layer.objects:
                try:
                    o.select_set(o == obj)
                except Exception:
                    pass
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
            bpy.ops.object.mode_set(mode="OBJECT")
            return "smart_project"
        except Exception:
            try:
                bpy.ops.object.mode_set(mode="OBJECT")
            except Exception:
                pass
    box_project_uvs(obj)
    return "box_projection"


def set_smoothing(obj, mode, angle_deg=30.0):
    me = obj.data
    smooth = mode in ("smooth", "auto")
    for p in me.polygons:
        p.use_smooth = smooth
    if mode == "auto":
        done = False
        if hasattr(me, "use_auto_smooth"):
            try:
                me.use_auto_smooth = True
                me.auto_smooth_angle = math.radians(angle_deg)
                done = True
            except Exception:
                done = False
        if not done:
            # Blender 4.1+: sharp edges by angle
            try:
                bm = bmesh.new()
                bm.from_mesh(me)
                bm.normal_update()
                for e in bm.edges:
                    if len(e.link_faces) == 2:
                        a = e.link_faces[0].normal.angle(e.link_faces[1].normal, 0.0)
                        e.smooth = a <= math.radians(angle_deg)
                bm.to_mesh(me)
                bm.free()
                done = True
            except Exception:
                done = False
    return mode


def principled(mat_name, m):
    mat = bpy.data.materials.get(mat_name)
    if mat is None:
        mat = bpy.data.materials.new(mat_name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = None
    for n in nt.nodes:
        if n.type == "BSDF_PRINCIPLED":
            bsdf = n
            break
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = None
        for n in nt.nodes:
            if n.type == "OUTPUT_MATERIAL":
                out = n
        if out is None:
            out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    col = list(m.get("color") or [0.8, 0.8, 0.8])[:3]
    col = [max(0.0, min(1.0, fnum(c, 0.8))) for c in col]
    alpha = max(0.0, min(1.0, fnum(m.get("alpha"), 1.0)))
    bsdf.inputs["Base Color"].default_value = (col[0], col[1], col[2], 1.0)
    for key, val in (("Metallic", fnum(m.get("metallic"), 0.0)), ("Roughness", fnum(m.get("roughness"), 0.5)), ("Alpha", alpha)):
        inp = bsdf.inputs.get(key)
        if inp is not None:
            inp.default_value = max(0.0, min(1.0, val))
    em = m.get("emission")
    strength = fnum(m.get("emission_strength"), 0.0)
    sock = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
    if sock is not None:
        if em and strength > 0:
            e = [max(0.0, min(1.0, fnum(c, 0.0))) for c in list(em)[:3]]
            sock.default_value = (e[0], e[1], e[2], 1.0)
        else:
            sock.default_value = (0.0, 0.0, 0.0, 1.0)
    s_in = bsdf.inputs.get("Emission Strength")
    if s_in is not None:
        s_in.default_value = strength if (em and strength > 0) else 0.0
    if alpha < 1.0:
        try:
            mat.blend_method = "BLEND"
        except Exception:
            pass
        try:
            mat.surface_render_method = "BLENDED"
        except Exception:
            pass
    # procedural wear (horror / worn styles): noise -> colour ramp -> mix into base colour.
    # Blender-only: Roblox receives the flat base colour (said in the import report).
    if m.get("wear"):
        try:
            if not any(n.name == "TotalWearMix" for n in nt.nodes):
                tex = nt.nodes.new("ShaderNodeTexNoise")
                tex.inputs["Scale"].default_value = 9.0
                ramp = nt.nodes.new("ShaderNodeValToRGB")
                ramp.color_ramp.elements[0].position = 0.42
                ramp.color_ramp.elements[1].position = 0.62
                mix = nt.nodes.new("ShaderNodeMixRGB")
                mix.name = "TotalWearMix"
                mix.blend_type = "MULTIPLY"
                mix.inputs["Fac"].default_value = 0.55
                mix.inputs["Color1"].default_value = (col[0], col[1], col[2], 1.0)
                nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
                nt.links.new(ramp.outputs["Color"], mix.inputs["Color2"])
                nt.links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])
        except Exception:
            pass
    mat["total_roblox"] = str(m.get("roblox") or "Plastic")
    mat["total_family"] = str(m.get("family") or "")
    try:
        mat.diffuse_color = (col[0], col[1], col[2], alpha)
        mat.metallic = max(0.0, min(1.0, fnum(m.get("metallic"), 0.0)))
        mat.roughness = max(0.0, min(1.0, fnum(m.get("roughness"), 0.5)))
    except Exception:
        pass
    return mat


# ─────────────────────────── build ───────────────────────────────────────────

def build_part(spec, part, coll, mats, style):
    name = ident(part.get("name"), "Part")
    obj_name = "%s_%s" % (ident(spec.get("name"), "Asset"), name)
    shape = str(part.get("shape") or "box")
    size = v3(part.get("size"), (0.1, 0.1, 0.1))
    segments = int(fnum(part.get("segments"), style.get("cylinder_segments", 24)))
    subdiv = int(fnum(part.get("subdivisions"), 2))
    bm = bm_primitive(shape, size, segments=segments, subdivisions=subdiv)
    ops = [o for o in (part.get("ops") or []) if isinstance(o, dict)]
    applied = []
    # vertex-level ops first (they reshape the primitive before any boolean)
    for op in ops:
        kind = str(op.get("op") or "")
        if kind == "taper":
            op_taper(bm, op)
        elif kind == "bulge":
            op_bulge(bm, op)
        elif kind == "displace":
            op_displace(bm, op)
        elif kind == "flatten_bottom":
            op_flatten_bottom(bm, op)
        elif kind == "inset":
            op_inset(bm, op, size)
        else:
            continue
        applied.append(kind)
    bm.normal_update()
    me = bpy.data.meshes.new(obj_name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(obj_name, me)
    link(obj, coll)
    obj.location = v3(part.get("pos"))
    obj.rotation_euler = Euler([math.radians(a) for a in v3(part.get("rot"))], "XYZ")
    obj.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()
    # boolean-level ops (bake immediately, cutters removed)
    for op in ops:
        kind = str(op.get("op") or "")
        if kind == "cut":
            if op_cut_objects(obj, op, part, coll):
                applied.append("cut")
        elif kind == "grooves":
            if op_grooves_objects(obj, op, part, coll):
                applied.append("grooves")
    for op in ops:
        if str(op.get("op") or "") == "decimate":
            mod = obj.modifiers.new(name="TotalDecimate", type="DECIMATE")
            mod.ratio = max(0.05, min(1.0, fnum(op.get("ratio"), 0.7)))
            apply_modifiers(obj)
            applied.append("decimate")
    # smoothing policy per surface type
    smooth_mode = str(part.get("smooth") or "auto")
    set_smoothing(obj, smooth_mode, fnum(style.get("smooth_angle"), 30.0))
    # material
    mat_id = str(part.get("material") or "")
    mat = mats.get(mat_id)
    if mat is not None:
        obj.data.materials.append(mat)
    # UVs
    uv_mode = None
    if spec.get("uv", True):
        uv_mode = unwrap(obj, shape in ("ico", "sphere") or "displace" in applied)
    # non-destructive finishing stack (kept live, exported with modifiers applied)
    mods = []
    bev = part.get("bevel")
    if isinstance(bev, dict) and fnum(bev.get("width"), 0) > 0:
        mod = obj.modifiers.new(name="Bevel", type="BEVEL")
        mod.width = min(fnum(bev.get("width"), 0.01), min(size) * 0.45)
        mod.segments = max(1, int(fnum(bev.get("segments"), 2)))
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(fnum(bev.get("angle"), 30.0))
        try:
            mod.harden_normals = bool(bev.get("harden_normals", True)) and smooth_mode != "flat"
        except Exception:
            pass
        try:
            mod.miter_outer = "MITER_ARC" if mod.segments >= 2 else "MITER_SHARP"
        except Exception:
            pass
        mods.append("Bevel(%.4g, %d)" % (mod.width, mod.segments))
    if part.get("mirror") in ("x", "y", "z"):
        mod = obj.modifiers.new(name="Mirror", type="MIRROR")
        ax = {"x": 0, "y": 1, "z": 2}[part["mirror"]]
        mod.use_axis = [ax == 0, ax == 1, ax == 2]
        mod.use_clip = True
        root = bpy.data.objects.get(ident(spec.get("name"), "Asset"))
        if root is not None:
            mod.mirror_object = root
        mods.append("Mirror(%s)" % part["mirror"])
    arr = part.get("array")
    if isinstance(arr, dict) and int(fnum(arr.get("count"), 1)) > 1:
        mod = obj.modifiers.new(name="Array", type="ARRAY")
        mod.count = int(fnum(arr.get("count"), 2))
        mod.use_relative_offset = False
        mod.use_constant_offset = True
        mod.constant_offset_displace = v3(arr.get("offset"), (0, 0, 0.1))
        mods.append("Array(%d)" % mod.count)
    if int(fnum(style.get("subdiv"), 0)) > 0 and shape == "box" and bev:
        mod = obj.modifiers.new(name="Subdivision", type="SUBSURF")
        mod.levels = 1
        mod.render_levels = 1
        mods.append("Subdivision(1)")
    if smooth_mode != "flat":
        try:
            mod = obj.modifiers.new(name="WeightedNormal", type="WEIGHTED_NORMAL")
            mod.keep_sharp = True
            mods.append("WeightedNormal")
        except Exception:
            pass
    # custom properties -> read back by dump_meshes / the Studio importer
    obj["total_asset"] = ident(spec.get("name"), "Asset")
    obj["total_role"] = str(part.get("role") or "secondary")
    obj["total_collision"] = str(part.get("collision") or "box")
    obj["total_can_collide"] = bool(part.get("can_collide", True))
    obj["total_material"] = mat_id
    if part.get("pivot_group"):
        obj["total_pivot_group"] = str(part["pivot_group"])
    return obj, {"name": name, "object": obj.name, "shape": shape, "ops": applied, "modifiers": mods, "smooth": smooth_mode, "uv": uv_mode, "material": mat_id}


def build_asset(spec):
    name = ident(spec.get("name"), "Asset")
    parts = spec.get("parts") or []
    if not isinstance(parts, list) or not parts:
        return {"ok": False, "error": "spec.parts is empty"}
    mats_spec = spec.get("materials") or {}
    if not isinstance(mats_spec, dict) or not mats_spec:
        return {"ok": False, "error": "spec.materials is empty"}
    style = spec.get("style_profile") or {}
    replace = ARGS.get("replace") is not False
    coll = bpy.data.collections.get(name)
    if coll is not None and replace:
        clear_collection(coll)
        old_root = bpy.data.objects.get(name)
        if old_root is not None:
            remove_object(old_root)
    coll = get_collection(name)
    # root empty = asset origin / pivot; parts and attachments are its children
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.25
    link(root, coll)
    root["total_asset"] = name
    root["total_studs_per_meter"] = fnum(spec.get("studs_per_meter"), 3.5)
    root["total_origin"] = str(spec.get("origin") or "bottom")
    root["total_category"] = str(spec.get("category") or "")
    root["total_style"] = str(spec.get("style") or "")
    mats = {}
    for mid, m in mats_spec.items():
        if isinstance(m, dict):
            mats[mid] = principled("%s_%s" % (name, ident(mid, "Mat")), m)
    built = []
    errors = []
    origin_shift = Vector(v3(spec.get("origin_pos"))) if spec.get("origin_pos") else Vector((0, 0, 0))
    for part in parts:
        if not isinstance(part, dict):
            errors.append("part is not an object")
            continue
        try:
            obj, info = build_part(spec, part, coll, mats, style)
            obj.location = Vector(obj.location) - origin_shift
            obj.parent = root
            obj.matrix_parent_inverse = Matrix.Identity(4)
            built.append((obj, info))
        except Exception as e:
            errors.append("%s: %s" % (part.get("name"), str(e)))
    attachments = []
    for att in spec.get("attachments") or []:
        if not isinstance(att, dict) or not att.get("name"):
            continue
        # object names are global in Blender: two kit pieces both need "SnapLeft",
        # so the clean Roblox name lives in a property and the object gets an asset prefix
        att_name = ident(att["name"], "Attachment")
        a = bpy.data.objects.new("ATT_%s_%s" % (name, att_name), None)
        a.empty_display_type = "SPHERE"
        a.empty_display_size = 0.05
        a.location = Vector(v3(att.get("pos"))) - origin_shift
        a["total_attachment"] = True
        a["total_attachment_name"] = att_name
        a["total_asset"] = name
        link(a, coll)
        a.parent = root
        a.matrix_parent_inverse = Matrix.Identity(4)
        attachments.append(a.name)
    bpy.context.view_layer.update()
    metrics = asset_metrics(name)
    budget = spec.get("budget") or {}
    over = []
    if budget.get("tris") and metrics["total_tris"] > fnum(budget["tris"]) :
        over.append("triangles %d > budget %d" % (metrics["total_tris"], int(fnum(budget["tris"]))))
    if budget.get("parts") and len(built) > int(fnum(budget["parts"])):
        over.append("parts %d > budget %d" % (len(built), int(fnum(budget["parts"]))))
    validation = validate_asset(name, spec)
    return {
        "ok": not errors and validation.get("errors", 0) == 0,
        "asset": name,
        "collection": coll.name,
        "root": root.name,
        "parts": [dict(info, tris=m["tris"]) for (obj, info), m in zip(built, metrics["parts"])],
        "part_errors": errors,
        "materials": sorted(mats.keys()),
        "attachments": attachments,
        "total_tris": metrics["total_tris"],
        "bounds_m": metrics["bounds"],
        "dims_m": metrics["dims"],
        "spec_dims_m": spec.get("dims"),
        "studs_per_meter": fnum(spec.get("studs_per_meter"), 3.5),
        # Roblox axis order (X, Y up, Z) so the value can go straight into mesh_import_verify {extent}
        "dims_studs": [round(metrics["dims"][i] * fnum(spec.get("studs_per_meter"), 3.5), 2) for i in (0, 2, 1)],
        "dims_studs_axes": "Roblox X, Y (up), Z - Blender Z is Roblox Y",
        "budget": budget,
        "over_budget": over,
        "validation": validation,
        "note": "Built in Blender only. Nothing is in Studio yet: run blender_asset_validate / blender_asset_inspect, then blender_send_to_studio {objects:[...]} or blender_asset_export.",
    }


def asset_metrics(name):
    root, coll, meshes = asset_objects(name)
    parts = []
    total = 0
    lo = [1e9, 1e9, 1e9]
    hi = [-1e9, -1e9, -1e9]
    for o in meshes:
        t = tri_count(o)
        total += t
        parts.append({"name": o.name, "tris": t})
        try:
            for corner in o.bound_box:
                w = o.matrix_world @ Vector(corner)
                for i in range(3):
                    lo[i] = min(lo[i], w[i])
                    hi[i] = max(hi[i], w[i])
        except Exception:
            pass
    if not meshes:
        lo = [0, 0, 0]
        hi = [0, 0, 0]
    dims = [round(hi[i] - lo[i], 4) for i in range(3)]
    return {"parts": parts, "total_tris": total, "bounds": {"min": [round(x, 4) for x in lo], "max": [round(x, 4) for x in hi]}, "dims": dims}


# ─────────────────────────── validate ───────────────────────────────────────

def validate_asset(name, spec=None):
    root, coll, meshes = asset_objects(name)
    issues = []

    def add(level, code, msg, obj=None):
        issues.append({"level": level, "code": code, "msg": msg, "object": obj})

    if not meshes:
        add("error", "missing", "no mesh objects found for asset '%s' (collection or root empty)" % name)
        return {"ok": False, "errors": 1, "warnings": 0, "issues": issues, "parts": []}
    parts = []
    total = 0
    boxes = []
    for o in meshes:
        rep = {"name": o.name}
        if any(abs(s - 1.0) > 1e-4 for s in o.scale):
            add("warning", "scale", "object scale is %s - apply scale before export so bevels / normals / collisions match" % [round(s, 3) for s in o.scale], o.name)
        if any(s < 0 for s in o.scale):
            add("error", "negative-scale", "negative scale flips normals", o.name)
        import re
        if re.search(r"\.\d{3}$", o.name) or re.match(r"^(Cube|Cylinder|Sphere|Cone|Torus|Plane|Icosphere)(\.\d+)?$", o.name):
            add("warning", "name", "default / numbered name - rename it so the Studio hierarchy stays stable", o.name)
        try:
            ev, me = evaluated_mesh(o)
        except Exception as e:
            add("error", "evaluate", "could not evaluate mesh: %s" % e, o.name)
            continue
        me.calc_loop_triangles()
        tris = len(me.loop_triangles)
        total += tris
        rep["tris"] = tris
        rep["verts"] = len(me.vertices)
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        non_manifold = sum(1 for e in bm.edges if not e.is_manifold)
        boundary = sum(1 for e in bm.edges if e.is_boundary)
        loose = sum(1 for v in bm.verts if not v.link_edges)
        wire = sum(1 for e in bm.edges if e.is_wire)
        degenerate = sum(1 for f in bm.faces if f.calc_area() < 1e-10)
        flipped = sum(1 for e in bm.edges if len(e.link_faces) == 2 and not e.is_contiguous)
        bm.free()
        rep.update({"non_manifold_edges": non_manifold, "boundary_edges": boundary, "loose_verts": loose, "wire_edges": wire, "degenerate_faces": degenerate, "inconsistent_normal_edges": flipped})
        if tris == 0:
            add("error", "empty", "mesh has no faces", o.name)
        if degenerate:
            add("error", "degenerate", "%d zero-area faces" % degenerate, o.name)
        if loose or wire:
            add("error", "loose", "%d loose vertices / %d wire edges" % (loose, wire), o.name)
        if flipped:
            add("error", "normals", "%d edges with inconsistent face winding - recalculate normals" % flipped, o.name)
        if non_manifold - boundary > 0:
            add("warning", "non-manifold", "%d non-manifold edges (boolean leftovers?) - fine for rendering, breaks precise collision / booleans" % (non_manifold - boundary), o.name)
        elif boundary > 0:
            add("info", "open", "%d boundary edges (open mesh)" % boundary, o.name)
        if not me.materials or all(m is None for m in me.materials):
            add("error", "material", "no material assigned", o.name)
        if not me.uv_layers:
            add("warning", "uv", "no UV layer", o.name)
        else:
            try:
                uv = me.uv_layers.active.data
                zero = sum(1 for p in me.polygons if abs(sum((uv[p.loop_indices[i]].uv.x * uv[p.loop_indices[(i + 1) % len(p.loop_indices)]].uv.y - uv[p.loop_indices[(i + 1) % len(p.loop_indices)]].uv.x * uv[p.loop_indices[i]].uv.y) for i in range(len(p.loop_indices)))) < 1e-9)
                if zero:
                    add("warning", "uv-zero", "%d faces with zero UV area" % zero, o.name)
            except Exception:
                pass
        smooth = sum(1 for p in me.polygons if p.use_smooth)
        rep["shading"] = "flat" if smooth * 2 < max(1, len(me.polygons)) else "smooth"
        if tris > 20000:
            add("error", "tris", "%d triangles - EditableMesh / mesh bridge limit is 20000 per part" % tris, o.name)
        try:
            ws = [o.matrix_world @ Vector(c) for c in o.bound_box]
            boxes.append((o.name, [min(w[i] for w in ws) for i in range(3)], [max(w[i] for w in ws) for i in range(3)]))
        except Exception:
            pass
        ev.to_mesh_clear()
        parts.append(rep)
    # overlap estimate (AABB) between sibling parts: >80 % of the smaller box
    # inside another is probably a hidden / duplicated piece
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            inter = 1.0
            va = 1.0
            vb = 1.0
            for k in range(3):
                inter *= max(0.0, min(a[2][k], b[2][k]) - max(a[1][k], b[1][k]))
                va *= max(1e-9, a[2][k] - a[1][k])
                vb *= max(1e-9, b[2][k] - b[1][k])
            if inter > 0 and inter / min(va, vb) > 0.8:
                add("info", "overlap", "%s is mostly inside %s (%.0f %% of its box) - expected for cores / insets, wasteful otherwise" % ((a[0], b[0], 100 * inter / min(va, vb)) if va < vb else (b[0], a[0], 100 * inter / min(va, vb))))
    if spec:
        dims = spec.get("dims")
        m = asset_metrics(name)
        if isinstance(dims, list) and len(dims) >= 3:
            for k in range(3):
                want = fnum(dims[k], 0)
                got = m["dims"][k]
                if want > 0 and abs(got - want) / want > 0.25:
                    add("warning", "dims", "built %s extent %.3f m differs from spec %.3f m by more than 25 %%" % ("xyz"[k], got, want))
        budget = spec.get("budget") or {}
        if budget.get("tris") and total > fnum(budget["tris"]) * 1.5:
            add("error", "budget", "%d triangles exceed the %d budget by more than 50 %%" % (total, int(fnum(budget["tris"]))))
        elif budget.get("tris") and total > fnum(budget["tris"]):
            add("warning", "budget", "%d triangles over the %d budget" % (total, int(fnum(budget["tris"]))))
    errors = sum(1 for i in issues if i["level"] == "error")
    warnings = sum(1 for i in issues if i["level"] == "warning")
    return {"ok": errors == 0, "errors": errors, "warnings": warnings, "issues": issues, "parts": parts, "total_tris": total, "structural_only": True, "note": "structural checks only - silhouette, proportion and material reads need blender_asset_inspect renders"}


# ─────────────────────────── inspect (preview renders) ──────────────────────

def inspect_asset(name, views, size):
    root, coll, meshes = asset_objects(name)
    if not meshes:
        return {"ok": False, "error": "no mesh objects found for asset '%s'" % name}
    m = asset_metrics(name)
    lo = Vector(m["bounds"]["min"])
    hi = Vector(m["bounds"]["max"])
    centre = (lo + hi) / 2.0
    radius = max(0.05, (hi - lo).length / 2.0)
    sc = scene()
    saved = {"camera": sc.camera, "engine": sc.render.engine, "x": sc.render.resolution_x, "y": sc.render.resolution_y, "pct": sc.render.resolution_percentage, "fp": sc.render.filepath, "fmt": sc.render.image_settings.file_format, "film": getattr(sc.render, "film_transparent", False)}
    inspect = get_collection("Total_Inspect")
    clear_collection(inspect)
    # hide every other collection's non-asset objects? No - keep the user's
    # scene; only the asset collection and inspect collection render by
    # temporarily hiding other top-level collections from render.
    hidden = []
    for child in sc.collection.children:
        if child.name not in (coll.name if coll else name, "Total_Inspect"):
            try:
                if not child.hide_render:
                    child.hide_render = True
                    hidden.append(child)
            except Exception:
                pass
    stray = []
    for o in sc.collection.objects:
        try:
            if not o.hide_render:
                o.hide_render = True
                stray.append(o)
        except Exception:
            pass
    renders = []
    try:
        cam_data = bpy.data.cameras.new("Total_Inspect_Cam")
        cam_data.lens = 50
        cam = bpy.data.objects.new("Total_Inspect_Cam", cam_data)
        link(cam, inspect)
        sc.camera = cam
        # neutral three-point lighting + backdrop plane
        for lname, pos, energy in (("Key", (1, -1, 1.2), 1000), ("Fill", (-1.4, -0.6, 0.6), 400), ("Rim", (0.4, 1.4, 1.0), 600)):
            ld = bpy.data.lights.new("Total_Inspect_" + lname, "AREA")
            ld.energy = energy * max(0.2, radius * radius)
            ld.size = radius * 1.5
            lo_ = bpy.data.objects.new("Total_Inspect_" + lname, ld)
            lo_.location = centre + Vector(pos) * radius * 3.0
            link(lo_, inspect)
            direction = centre - lo_.location
            lo_.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        bmp = bmesh.new()
        bmesh.ops.create_grid(bmp, x_segments=1, y_segments=1, size=radius * 12)
        pm = bpy.data.meshes.new("Total_Inspect_Backdrop")
        bmp.to_mesh(pm)
        bmp.free()
        plane = bpy.data.objects.new("Total_Inspect_Backdrop", pm)
        plane.location = (centre.x, centre.y, lo.z - 0.001)
        bmat = bpy.data.materials.get("Total_Inspect_Grey") or bpy.data.materials.new("Total_Inspect_Grey")
        bmat.diffuse_color = (0.42, 0.42, 0.42, 1.0)
        pm.materials.append(bmat)
        link(plane, inspect)
        engines = set()
        try:
            engines = set(getattr(it, "identifier", str(it)) for it in sc.render.bl_rna.properties["engine"].enum_items)
        except Exception:
            pass
        engine = "BLENDER_WORKBENCH" if "BLENDER_WORKBENCH" in engines or not engines else sorted(engines)[0]
        sc.render.engine = engine
        if engine == "BLENDER_WORKBENCH":
            try:
                sh = sc.display.shading
                sh.light = "STUDIO"
                sh.color_type = "MATERIAL"
                sh.show_cavity = True
                sh.show_shadows = True
            except Exception:
                pass
        sc.render.resolution_x = int(size)
        sc.render.resolution_y = int(size)
        sc.render.resolution_percentage = 100
        sc.render.image_settings.file_format = "PNG"
        folder = workspace_dir()
        fov = cam_data.angle if hasattr(cam_data, "angle") else math.radians(39.6)
        dist = radius / math.tan(fov / 2.0) * 1.25
        dirs = {"front": Vector((0, -1, 0)), "back": Vector((0, 1, 0)), "side": Vector((1, 0, 0)), "left": Vector((-1, 0, 0)), "top": Vector((0, -0.0001, 1)), "iso": Vector((1, -1, 0.8)).normalized(), "closeup": Vector((0.6, -1, 0.35)).normalized()}
        for view in views:
            d = dirs.get(str(view))
            if d is None:
                continue
            f = dist * (0.55 if view == "closeup" else 1.0)
            cam.location = centre + d.normalized() * f
            cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
            path = os.path.join(folder, "total_inspect_%s_%s.png" % (ident(name, "Asset"), view))
            sc.render.filepath = path
            bpy.ops.render.render(write_still=True)
            ok = os.path.exists(path) and os.path.getsize(path) > 0
            renders.append({"view": view, "path": path, "ok": ok, "bytes": os.path.getsize(path) if ok else 0})
    except Exception as e:
        return {"ok": False, "error": "inspect render failed: %s" % e, "traceback": traceback.format_exc()[-1500:], "renders": renders}
    finally:
        # restore the user's scene and remove the preview rig
        try:
            sc.camera = saved["camera"]
            sc.render.engine = saved["engine"]
            sc.render.resolution_x = saved["x"]
            sc.render.resolution_y = saved["y"]
            sc.render.resolution_percentage = saved["pct"]
            sc.render.filepath = saved["fp"]
            sc.render.image_settings.file_format = saved["fmt"]
        except Exception:
            pass
        for child in hidden:
            try:
                child.hide_render = False
            except Exception:
                pass
        for o in stray:
            try:
                o.hide_render = False
            except Exception:
                pass
        if ARGS.get("keep") is not True:
            try:
                clear_collection(inspect)
                bpy.data.collections.remove(inspect)
            except Exception:
                pass
    good = [r for r in renders if r["ok"]]
    return {"ok": bool(good), "asset": name, "renders": renders, "render_files": [r["path"] for r in good], "dims_m": m["dims"], "total_tris": m["total_tris"], "checklist": ["silhouette readable in front / side / top?", "primary > secondary > tertiary mass hierarchy?", "bevels visible but not mushy at this distance?", "materials separate (metal / wood / glass / emissive) without reading as coloured plastic?", "any part floating, intersecting or hidden?"], "note": "Preview rig lived in Total_Inspect and was removed; the asset collection is untouched."}


# ─────────────────────────── export ─────────────────────────────────────────

FBX_SETTINGS = dict(use_selection=True, apply_unit_scale=True, apply_scale_options="FBX_SCALE_ALL", global_scale=1.0, bake_space_transform=True, object_types={"MESH", "EMPTY"}, use_mesh_modifiers=True, mesh_smooth_type="FACE", use_triangles=False, use_custom_props=True, add_leaf_bones=False, bake_anim=False, path_mode="COPY", embed_textures=True, axis_forward="-Z", axis_up="Y")
GLTF_SETTINGS = dict(export_format="GLB", use_selection=True, export_apply=True, export_yup=True, export_materials="EXPORT", export_normals=True, export_texcoords=True, export_extras=True, export_cameras=False, export_lights=False, export_animations=False)
OBJ_SETTINGS = dict(export_selected_objects=True, apply_modifiers=True, export_materials=True, export_normals=True, export_uv=True, forward_axis="NEGATIVE_Z", up_axis="Y", export_triangulated_mesh=False)
HEADERS = {"fbx": (b"Kaydara FBX Binary", b"; FBX"), "glb": (b"glTF",), "obj": (b"# Blender", b"o ", b"v ", b"mtllib")}


def select_asset(name):
    root, coll, meshes = asset_objects(name)
    objs = list(meshes)
    if root is not None:
        objs.append(root)
        for o in bpy.data.objects:
            if o.parent == root and o.type == "EMPTY" and o not in objs:
                objs.append(o)
    for o in bpy.data.objects:
        try:
            o.select_set(False)
        except Exception:
            pass
    for o in objs:
        try:
            o.select_set(True)
        except Exception:
            pass
    if meshes:
        try:
            bpy.context.view_layer.objects.active = meshes[0]
        except Exception:
            pass
    return objs, meshes


def export_asset(name, fmt, path):
    fmt = str(fmt or "fbx").lower().lstrip(".")
    if fmt == "gltf":
        fmt = "glb"
    if fmt not in ("fbx", "glb", "obj"):
        return {"ok": False, "error": "unsupported export format '%s' - supported: fbx, glb (glTF binary), obj" % fmt}
    objs, meshes = select_asset(name)
    if not meshes:
        return {"ok": False, "error": "no mesh objects found for asset '%s' - build it first (blender_asset_build)" % name}
    folder = workspace_dir()
    if not path:
        path = os.path.join(folder, "%s.%s" % (ident(name, "Asset"), fmt))
    path = os.path.abspath(os.path.expanduser(str(path)))
    if not path.lower().endswith("." + fmt):
        path += "." + fmt
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except Exception as e:
        return {"ok": False, "error": "cannot create export folder: %s" % e}
    # validation gate: refuse to export broken geometry silently
    val = validate_asset(name)
    if val.get("errors", 0) and ARGS.get("force") is not True:
        return {"ok": False, "error": "asset has %d structural errors - fix them or pass force:true" % val["errors"], "validation": val}
    for mod in ("io_scene_fbx", "bl_ext.blender_org.io_scene_fbx", "io_scene_gltf2", "bl_ext.blender_org.io_scene_gltf2", "io_scene_obj"):
        try:
            bpy.ops.preferences.addon_enable(module=mod)
        except Exception:
            pass
    settings = None
    try:
        if fmt == "fbx":
            settings = dict(FBX_SETTINGS)
            try:
                bpy.ops.export_scene.fbx(filepath=path, **settings)
            except TypeError:
                settings.pop("use_triangles", None)
                settings.pop("bake_space_transform", None)
                bpy.ops.export_scene.fbx(filepath=path, **settings)
        elif fmt == "glb":
            settings = dict(GLTF_SETTINGS)
            try:
                bpy.ops.export_scene.gltf(filepath=path, **settings)
            except TypeError:
                settings.pop("export_extras", None)
                bpy.ops.export_scene.gltf(filepath=path, **settings)
        else:
            settings = dict(OBJ_SETTINGS)
            if hasattr(bpy.ops.wm, "obj_export"):
                bpy.ops.wm.obj_export(filepath=path, **settings)
            else:
                settings = dict(use_selection=True, use_mesh_modifiers=True, use_materials=True, use_normals=True, use_uvs=True, axis_forward="-Z", axis_up="Y")
                bpy.ops.export_scene.obj(filepath=path, **settings)
    except Exception as e:
        return {"ok": False, "error": "%s export failed: %s" % (fmt.upper(), e), "settings": settings}
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return {"ok": False, "error": "%s export reported success but %s is missing or empty" % (fmt.upper(), path), "settings": settings}
    header_ok = None
    try:
        with open(path, "rb") as f:
            head = f.read(64)
        header_ok = any(head.startswith(h) or h in head for h in HEADERS[fmt])
    except Exception:
        header_ok = None
    textures = []
    seen_mats = set()
    for o in meshes:
        for slot in o.material_slots:
            mat = slot.material
            if mat is None or not mat.use_nodes or mat.name in seen_mats:
                continue
            seen_mats.add(mat.name)
            for n in mat.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image is not None:
                    fp = ""
                    try:
                        fp = bpy.path.abspath(n.image.filepath) if n.image.filepath else ""
                    except Exception:
                        fp = ""
                    textures.append({"material": mat.name, "image": n.image.name, "filepath": fp, "exists": bool(fp and os.path.exists(fp)), "packed": bool(getattr(n.image, "packed_file", None))})
    missing_tex = [t for t in textures if not t["exists"] and not t["packed"]]
    total_tris = sum(tri_count(o) for o in meshes)
    spm = None
    root = bpy.data.objects.get(name)
    try:
        if root is not None and root.get("total_studs_per_meter"):
            spm = float(root["total_studs_per_meter"])
    except Exception:
        spm = None
    return {
        "ok": not missing_tex,
        "asset": name,
        "format": fmt,
        "filepath": path,
        "bytes": os.path.getsize(path),
        "header_ok": header_ok,
        "objects": [o.name for o in meshes],
        "tris": total_tris,
        "materials": sorted(set(s.material.name for o in meshes for s in o.material_slots if s.material)),
        "textures": textures,
        "missing_textures": missing_tex,
        "settings": {k: (sorted(v) if isinstance(v, set) else v) for k, v in (settings or {}).items()},
        "axes": "forward -Z, up Y (Roblox Y-up)",
        "units": "metres; 1 m = %s studs in the spec - the file itself is NOT rescaled: set the 3D Importer scale (or use blender_send_to_studio, which applies it)" % (spm if spm else "?"),
        "validation": val,
        "error": ("textures referenced but not on disk / packed: %s" % ", ".join(t["image"] for t in missing_tex)) if missing_tex else None,
        "note": "Local file only - nothing was uploaded to Roblox. Import it with Studio's 3D Importer, or use blender_send_to_studio for the mesh bridge.",
    }


# ─────────────────────────── dispatch ───────────────────────────────────────

def main():
    cmd = CMD.strip().split("/")[-1]
    if cmd.startswith("blender_"):
        cmd = cmd[len("blender_"):]
    try:
        if cmd == "asset_build":
            spec = ARGS.get("spec")
            if isinstance(spec, str):
                try:
                    spec = json.loads(spec)
                except Exception:
                    spec = None
            if not isinstance(spec, dict):
                return emit({"ok": False, "error": "asset_build needs spec (object) - get one from blender_asset_plan {brief} or pass your own"})
            return emit(build_asset(spec))
        raw = str(ARGS.get("name") or ARGS.get("asset") or "")
        # built assets carry sanitised names; a user-made "Cube.001" is looked up as typed
        name = raw if (raw and (bpy.data.collections.get(raw) is not None or bpy.data.objects.get(raw) is not None)) else ident(raw, "")
        if cmd == "asset_validate":
            if not name:
                return emit({"ok": False, "error": "asset_validate needs name (the asset / collection name)"})
            return emit(dict(validate_asset(name, ARGS.get("spec") if isinstance(ARGS.get("spec"), dict) else None), asset=name))
        if cmd == "asset_inspect":
            if not name:
                return emit({"ok": False, "error": "asset_inspect needs name"})
            views = ARGS.get("views") or ["front", "side", "top", "iso"]
            if not isinstance(views, list):
                views = [str(views)]
            size = int(max(128, min(2048, fnum(ARGS.get("size"), 640))))
            return emit(inspect_asset(name, [str(v) for v in views][:7], size))
        if cmd == "asset_export":
            if not name:
                return emit({"ok": False, "error": "asset_export needs name"})
            return emit(export_asset(name, ARGS.get("format") or "fbx", ARGS.get("path") or ARGS.get("filepath") or ""))
        return emit({"ok": False, "error": "unknown asset command '%s' (asset_build, asset_validate, asset_inspect, asset_export)" % cmd})
    except Exception as e:
        return emit(classify_exception(e, CMD))


main()
