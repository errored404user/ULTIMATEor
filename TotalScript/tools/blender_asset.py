# TotalScript asset builder (1.99.5). Sent to Blender as execute_code like
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
#   asset_bake     {name, size, maps, margin, samples, apply}   (1.99.2) Cycles-bakes the procedural
#                                         family graphs to PNGs (base_color / roughness / metallic /
#                                         normal / emission) in <workspace>/total_textures - local files
#
# 1.93.0: parts may use shape "generator" (tree_branches, canopy_cluster, terrain,
# rock_cluster, crystal_cluster, stairs) and every material family gets a procedural
# shader graph (texture: "flat" turns it off).
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


# ─────────────────────────── procedural generators (1.99.2) ─────────────────
# part.shape == "generator" + part.generator = {kind, seed, ...}. Every generator
# returns ONE bmesh in local space with the part's pos as BASE point (footprint
# centre, z = 0 at ground contact; trees keep the trunk foot at the origin).
# Deterministic per seed (random.Random), so rebuilding a spec gives the same asset.
import random

GENERATORS = ("tree_branches", "canopy_cluster", "terrain", "rock_cluster", "crystal_cluster", "stairs")


def _basis(d):
    d = Vector(d).normalized()
    helper = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
    u = d.cross(helper).normalized()
    v = d.cross(u).normalized()
    return d, u, v


def _ring(bm, centre, u, v, radius, segs):
    out = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        out.append(bm.verts.new(tuple(Vector(centre) + (u * math.cos(a) + v * math.sin(a)) * radius)))
    return out


def _bridge(bm, ring_a, ring_b):
    n = len(ring_a)
    for i in range(n):
        try:
            bm.faces.new((ring_a[i], ring_a[(i + 1) % n], ring_b[(i + 1) % n], ring_b[i]))
        except ValueError:
            pass


def _fan(bm, ring, apex, flip=False):
    n = len(ring)
    for i in range(n):
        tri = (ring[i], apex, ring[(i + 1) % n]) if not flip else (ring[i], ring[(i + 1) % n], apex)
        try:
            bm.faces.new(tri)
        except ValueError:
            pass


def bm_append(dst, src, translate=(0, 0, 0), scale=1.0):
    """Copy src's faces into dst (portable: no bmesh.ops needed)."""
    t = Vector(translate)
    lut = {}
    for v in src.verts:
        lut[v.index if hasattr(v, "index") else id(v)] = dst.verts.new(tuple(Vector(v.co) * scale + t))
    for f in src.faces:
        try:
            dst.faces.new([lut[v.index if hasattr(v, "index") else id(v)] for v in f.verts])
        except (ValueError, KeyError):
            pass


def _fbm(p, octaves, seed):
    from mathutils import noise
    offs = Vector((seed * 13.7, seed * 7.3, seed * 3.1))
    n, amp, freq, tot = 0.0, 1.0, 1.0, 0.0
    for _ in range(max(1, octaves)):
        q = Vector(p) * freq + offs
        try:
            n += noise.noise(q) * amp
        except TypeError:
            n += noise.noise(q, noise_basis="PERLIN_ORIGINAL") * amp
        tot += amp
        amp *= 0.5
        freq *= 2.07
    return n / tot


def _displace_bm(bm, strength, scale, octaves, seed):
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * _fbm(Vector(v.co) / max(1e-4, scale), octaves, seed) * strength


def tree_skeleton(g, height, base_radius):
    """Recursive branch list [(start, end, r0, r1, level)] shared by the trunk and
    canopy generators so leaves sit on the real tips (same seed -> same tree)."""
    rng = random.Random(int(fnum(g.get("seed"), 3)))
    levels = int(max(1, min(5, fnum(g.get("levels"), 3))))
    per = int(max(1, min(5, fnum(g.get("branches"), 3))))
    spread = math.radians(max(5.0, min(80.0, fnum(g.get("spread"), 38.0))))
    shrink = max(0.4, min(0.85, fnum(g.get("length_ratio"), 0.62)))
    out = []
    trunk_len = height * max(0.3, min(0.8, fnum(g.get("trunk_ratio"), 0.45)))

    def grow(start, d, length, radius, level):
        d = Vector(d).normalized()
        # gentle wander + up bias so branches arc instead of pointing straight
        steps = 3
        cur = Vector(start)
        segs = []
        for i in range(steps):
            wob = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.4, 0.8))) * (0.18 if level else 0.06)
            d = (d + wob * 0.5 + Vector((0, 0, 0.08 if level == 0 else 0.03))).normalized()
            nxt = cur + d * (length / steps)
            segs.append((cur.copy(), nxt.copy()))
            cur = nxt
        r_end = radius * (0.35 if level < levels else 0.05)
        for i, (a, b) in enumerate(segs):
            t0 = i / float(steps)
            t1 = (i + 1) / float(steps)
            out.append((a, b, radius + (r_end - radius) * t0, radius + (r_end - radius) * t1, level))
        if level >= levels:
            return
        # children of one node fan out evenly in azimuth; successive levels
        # rotate the fan by a quarter turn so 2-branch trees fill a round crown,
        # and the fork angle opens with the level (twigs lean out more than limbs)
        az0 = rng.uniform(0, 2 * math.pi) + level * (math.pi / 2.0)
        fork = min(math.radians(80.0), spread * (1.0 + 0.22 * level))
        for k in range(per):
            t = rng.uniform(0.45, 0.95) if level else rng.uniform(0.6, 1.0)
            idx = min(steps - 1, int(t * steps))
            a, b = segs[idx]
            at = a + (b - a) * ((t * steps) - idx)
            az = az0 + k * (2 * math.pi / per) + rng.uniform(-0.3, 0.3)
            _, u, v = _basis(d)
            nd = (d * math.cos(fork) + (u * math.cos(az) + v * math.sin(az)) * math.sin(fork)).normalized()
            grow(at, nd, length * shrink * rng.uniform(0.85, 1.1), radius * 0.55, level + 1)

    grow(Vector((0, 0, 0)), Vector((0, 0, 1)), trunk_len, base_radius, 0)
    # fit the skeleton to the requested envelope (positions only, radii stay):
    # the planner gives tree_height / tree_width so trunk + canopy agree exactly.
    fit_h = fnum(g.get("tree_height"), height)
    fit_w = fnum(g.get("tree_width"), 0.0)
    pts = [p for seg in out for p in (seg[0], seg[1])]
    if pts:
        max_z = max(p.z for p in pts)
        span_x = max(p.x for p in pts) - min(p.x for p in pts)
        span_y = max(p.y for p in pts) - min(p.y for p in pts)
        kz = fit_h / max_z if max_z > 1e-6 and fit_h > 0 else 1.0
        # x and y are fitted separately (clamped) so a 2-branch skeleton still
        # fills a round crown instead of a plane
        kx = max(0.5, min(3.0, fit_w / span_x)) if span_x > 1e-6 and fit_w > 0 else 1.0
        ky = max(0.5, min(3.0, fit_w / span_y)) if span_y > 1e-6 and fit_w > 0 else 1.0
        if abs(kz - 1.0) > 1e-6 or abs(kx - 1.0) > 1e-6 or abs(ky - 1.0) > 1e-6:
            out = [(Vector((a.x * kx, a.y * ky, a.z * kz)), Vector((b.x * kx, b.y * ky, b.z * kz)), r0, r1, lv) for (a, b, r0, r1, lv) in out]
    return out


def gen_tree_branches(g, size, segments):
    bm = bmesh.new()
    sx, sy, sz = size
    base_r = max(0.01, min(sx, sy) / 2.0)
    segs = max(5, min(16, int(segments) if segments else 8))
    branches = tree_skeleton(g, sz, base_r)
    # consecutive segments of one branch share their ring (continuous tube);
    # every branch is capped at both ends so the mesh has no open boundary.
    prev_b, prev_ring = None, None
    n = len(branches)
    for i, (a, b, r0, r1, level) in enumerate(branches):
        d, u, v = _basis(b - a)
        cont = prev_b is not None and (a - prev_b).length < 1e-6
        ring_a = prev_ring if cont else _ring(bm, a, u, v, max(0.004, r0), segs)
        ring_b = _ring(bm, b, u, v, max(0.003, r1), segs)
        _bridge(bm, ring_a, ring_b)
        if not cont:
            _fan(bm, ring_a, bm.verts.new(tuple(a - d * r0 * 0.3)))
        last = i + 1 >= n or (branches[i + 1][0] - b).length > 1e-6
        if last:
            _fan(bm, ring_b, bm.verts.new(tuple(b + d * max(r1, 0.003) * 1.5)), flip=True)
        prev_b, prev_ring = b, ring_b
    return bm, {"branches": len(branches)}


def gen_canopy_cluster(g, size, subdivisions):
    bm = bmesh.new()
    sx, sy, sz = size
    base_r = max(0.01, fnum(g.get("trunk_radius"), min(sx, sy) * 0.04))
    branches = tree_skeleton(g, sz, base_r)
    levels = int(max(1, min(5, fnum(g.get("levels"), 3))))
    tips = [b for (a, b, r0, r1, level) in branches if level >= max(1, levels - 1)]
    if not tips:
        tips = [b for (a, b, r0, r1, level) in branches]
    rng = random.Random(int(fnum(g.get("seed"), 3)) + 101)
    rng.shuffle(tips)
    tips = tips[:int(max(1, min(28, fnum(g.get("blobs"), 14))))]
    leaf_r = max(0.05, fnum(g.get("leaf_radius"), sz * 0.16))
    sub = int(max(1, min(3, subdivisions or 2)))
    for t in tips:
        tmp = bmesh.new()
        r = leaf_r * rng.uniform(0.7, 1.25)
        try:
            bmesh.ops.create_icosphere(tmp, subdivisions=sub, radius=r)
        except TypeError:
            bmesh.ops.create_icosphere(tmp, subdivisions=sub, diameter=r * 2)
        bmesh.ops.scale(tmp, vec=(1.0, 1.0, rng.uniform(0.65, 0.9)), verts=tmp.verts)
        _displace_bm(tmp, r * 0.18, r * 0.9, 2, fnum(g.get("seed"), 3) + t.x)
        bm_append(bm, tmp, translate=(t.x, t.y, t.z - r * 0.15))
        tmp.free()
    return bm, {"blobs": len(tips)}


def gen_terrain(g, size):
    bm = bmesh.new()
    sx, sy, sz = size
    n = int(max(4, min(96, fnum(g.get("resolution"), 24))))
    octaves = int(max(1, min(8, fnum(g.get("octaves"), 4))))
    seed = fnum(g.get("seed"), 3)
    freq = max(0.2, fnum(g.get("frequency"), 1.6))
    falloff = str(g.get("falloff") or "none")
    plateau = fnum(g.get("plateau"), 0.0)
    grid = []
    hmin, hmax = 1e9, -1e9
    heights = []
    for j in range(n + 1):
        row = []
        for i in range(n + 1):
            x = (i / float(n) - 0.5)
            y = (j / float(n) - 0.5)
            h = _fbm(Vector((x * freq, y * freq, 0.37)), octaves, seed)
            h = (h + 1.0) * 0.5  # 0..1
            if falloff == "island":
                rr = min(1.0, math.sqrt(x * x + y * y) * 2.0)
                h *= max(0.0, 1.0 - rr * rr)
            elif falloff == "edges":
                h *= max(0.0, 1.0 - max(abs(x), abs(y)) * 2.0) ** 0.5
            if plateau > 0:
                h = min(h, plateau)
            row.append(h)
            hmin, hmax = min(hmin, h), max(hmax, h)
        heights.append(row)
    span = max(1e-6, hmax - hmin)
    for j in range(n + 1):
        row = []
        for i in range(n + 1):
            h = (heights[j][i] - hmin) / span
            row.append(bm.verts.new(((i / float(n) - 0.5) * sx, (j / float(n) - 0.5) * sy, h * sz)))
        grid.append(row)
    for j in range(n):
        for i in range(n):
            try:
                bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
            except ValueError:
                pass
    if g.get("skirt", True):
        # closed solid: side walls + bottom so Studio gets a manifold tile
        base = -sz * 0.08
        edge = [grid[0][i] for i in range(n + 1)] + [grid[j][n] for j in range(1, n + 1)] + [grid[n][i] for i in range(n - 1, -1, -1)] + [grid[j][0] for j in range(n - 1, 0, -1)]
        bottom = [bm.verts.new((v.co.x, v.co.y, base)) for v in edge]
        m = len(edge)
        for k in range(m):
            try:
                bm.faces.new((edge[(k + 1) % m], edge[k], bottom[k], bottom[(k + 1) % m]))
            except ValueError:
                pass
        try:
            bm.faces.new(list(reversed(bottom)))
        except ValueError:
            pass
    return bm, {"resolution": n, "octaves": octaves, "falloff": falloff}


def gen_rock_cluster(g, size, subdivisions):
    bm = bmesh.new()
    sx, sy, sz = size
    rng = random.Random(int(fnum(g.get("seed"), 3)) + 7)
    count = int(max(1, min(24, fnum(g.get("count"), 6))))
    sub = int(max(1, min(3, subdivisions or 2)))
    rocks = []
    for k in range(count):
        big = k == 0
        fz = rng.uniform(0.6, 0.9)
        # hero boulder reaches the part height; satellites are 30-70 % of it
        r = (sz / (2.0 * fz)) * (1.0 if big else rng.uniform(0.3, 0.7))
        ang = rng.uniform(0, 2 * math.pi)
        rad = 0.0 if big else rng.uniform(0.25, 0.5)
        cx, cy = math.cos(ang) * rad * sx, math.sin(ang) * rad * sy
        tmp = bmesh.new()
        try:
            bmesh.ops.create_icosphere(tmp, subdivisions=sub, radius=1.0)
        except TypeError:
            bmesh.ops.create_icosphere(tmp, subdivisions=sub, diameter=2.0)
        bmesh.ops.scale(tmp, vec=(r * rng.uniform(0.9, 1.4), r * rng.uniform(0.8, 1.2), r * fz), verts=tmp.verts)
        _displace_bm(tmp, r * 0.16, r * 1.1, 2, fnum(g.get("seed"), 3) + k)
        # flatten the buried part so every rock sits on z = 0
        lowest = min(v.co.z for v in tmp.verts)
        for v in tmp.verts:
            v.co.z -= lowest
            if v.co.z < r * 0.12:
                v.co.z = 0.0 if v.co.z < r * 0.04 else v.co.z
        bm_append(bm, tmp, translate=(cx, cy, 0.0))
        rocks.append({"r": round(r, 3), "pos": [round(cx, 3), round(cy, 3)]})
        tmp.free()
    return bm, {"rocks": len(rocks)}


def gen_crystal_cluster(g, size):
    bm = bmesh.new()
    sx, sy, sz = size
    rng = random.Random(int(fnum(g.get("seed"), 3)) + 11)
    count = int(max(1, min(20, fnum(g.get("count"), 7))))
    sides = int(max(4, min(8, fnum(g.get("sides"), 6))))
    made = 0
    for k in range(count):
        main = k == 0
        h = sz * (1.0 if main else rng.uniform(0.35, 0.8))
        r = max(0.01, h * max(0.08, min(0.3, fnum(g.get("thickness"), 0.16))))
        tilt = 0.0 if main else math.radians(rng.uniform(8, 28))
        az = rng.uniform(0, 2 * math.pi)
        d = Vector((math.sin(tilt) * math.cos(az), math.sin(tilt) * math.sin(az), math.cos(tilt)))
        rad = 0.0 if main else rng.uniform(0.15, 0.45)
        base = Vector((math.cos(az + 1.3) * rad * sx, math.sin(az + 1.3) * rad * sy, -h * 0.08))
        _, u, v = _basis(d)
        body = h * 0.72
        ring0 = _ring(bm, base, u, v, r, sides)
        ring1 = _ring(bm, base + d * body, u, v, r * 0.92, sides)
        _bridge(bm, ring0, ring1)
        apex = bm.verts.new(tuple(base + d * h))
        _fan(bm, ring1, apex, flip=True)
        try:
            bm.faces.new(list(reversed(ring0)))
        except ValueError:
            pass
        made += 1
    return bm, {"crystals": made, "sides": sides}


def gen_stairs(g, size):
    bm = bmesh.new()
    sx, sy, sz = size
    steps = int(max(2, min(40, fnum(g.get("steps"), 8))))
    rise = sz / steps
    run = sy / steps
    nosing = max(0.0, min(run * 0.3, fnum(g.get("nosing"), 0.0)))
    prof = [(0.0, 0.0)]
    for i in range(steps):
        y0 = i * run
        prof.append((y0 - (nosing if i else 0.0), (i + 1) * rise))
        prof.append((y0 + run, (i + 1) * rise))
    prof.append((sy, 0.0))
    left = [bm.verts.new((-sx / 2.0, y, z)) for (y, z) in prof]
    right = [bm.verts.new((sx / 2.0, y, z)) for (y, z) in prof]
    m = len(prof)
    for i in range(m):
        try:
            bm.faces.new((left[i], left[(i + 1) % m], right[(i + 1) % m], right[i]))
        except ValueError:
            pass
    try:
        bm.faces.new(list(reversed(left)))
        bm.faces.new(right)
    except ValueError:
        pass
    return bm, {"steps": steps, "rise": round(rise, 4), "run": round(run, 4)}


def bm_generate(gen, size, segments, subdivisions):
    g = gen if isinstance(gen, dict) else {}
    kind = str(g.get("kind") or "")
    size = [max(1e-4, float(x)) for x in size]
    if kind == "tree_branches":
        bm, info = gen_tree_branches(g, size, segments)
    elif kind == "canopy_cluster":
        bm, info = gen_canopy_cluster(g, size, subdivisions)
    elif kind == "terrain":
        bm, info = gen_terrain(g, size)
    elif kind == "rock_cluster":
        bm, info = gen_rock_cluster(g, size, subdivisions)
    elif kind == "crystal_cluster":
        bm, info = gen_crystal_cluster(g, size)
    elif kind == "stairs":
        bm, info = gen_stairs(g, size)
    else:
        raise ValueError("unknown generator kind '%s' (%s)" % (kind, ", ".join(GENERATORS)))
    # pos of a generator part is its BASE point: x/y centred on the footprint,
    # z = 0 at the ground contact. Tree kinds are left untouched so trunk and
    # canopy (two parts, same skeleton) keep their shared origin at the foot.
    lo, hi = bm_bounds(bm)
    if kind not in ("tree_branches", "canopy_cluster"):
        c = Vector(((lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, lo[2]))
        for v in bm.verts:
            v.co -= c
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    info["kind"] = kind
    info["extent_m"] = [round(hi[i] - lo[i], 4) for i in range(3)]
    return bm, info


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


# ─────────────────────────── procedural materials (1.99.2) ──────────────────
# Each material FAMILY gets a real shader graph instead of a flat Principled:
# wood grain, stone / concrete / brick breakup, brushed metal, edge-worn paint,
# leather / fabric micro-bump, glass transmission, energy pulse, foliage
# variation, crystal. Everything is driven from Object texture coordinates so
# it works before any unwrap, and Base Color's default_value keeps the flat
# colour (what the Studio importer reads - Roblox cannot run these graphs; bake
# them with blender_asset_bake when you need image textures).
TEX_PREFIX = "Total_Tex_"


def _node(nt, ntype, name, **props):
    n = nt.nodes.new(ntype)
    n.name = TEX_PREFIX + name
    try:
        n.label = name
    except Exception:
        pass
    for k, v in props.items():
        try:
            setattr(n, k, v)
        except Exception:
            pass
    return n


def _set(n, key, value):
    try:
        n.inputs[key].default_value = value
        return True
    except Exception:
        return False


def _set_any(n, keys, value):
    for k in keys:
        if _set(n, k, value):
            return k
    return None


_BASE_SRC = [None]


def _lnk(nt, a, a_out, b, b_in):
    try:
        nt.links.new(a.outputs[a_out], b.inputs[b_in])
        if b_in == "Base Color":
            _BASE_SRC[0] = (a, a_out)
        return True
    except Exception:
        return False


def _drop_tex_nodes(nt):
    for n in list(nt.nodes):
        if str(getattr(n, "name", "")).startswith(TEX_PREFIX):
            try:
                nt.nodes.remove(n)
            except Exception:
                pass


def _shade(col, k):
    return tuple(max(0.0, min(1.0, c * k)) for c in col[:3]) + (1.0,)


def _ramp(nt, name, dark, light, p0=0.3, p1=0.7):
    r = _node(nt, "ShaderNodeValToRGB", name)
    try:
        el = r.color_ramp.elements
        el[0].position = p0
        el[0].color = dark
        el[1].position = p1
        el[1].color = light
    except Exception:
        pass
    return r


def _coords(nt, scale):
    tc = _node(nt, "ShaderNodeTexCoord", "Coords")
    mp = _node(nt, "ShaderNodeMapping", "Mapping")
    try:
        mp.vector_type = "POINT"
    except Exception:
        pass
    _set(mp, "Scale", (scale, scale, scale))
    _lnk(nt, tc, "Object", mp, "Vector")
    return mp


def _bump(nt, bsdf, src, src_out, strength, distance=0.01):
    b = _node(nt, "ShaderNodeBump", "Bump")
    _set(b, "Strength", strength)
    _set(b, "Distance", distance)
    _lnk(nt, src, src_out, b, "Height")
    _lnk(nt, b, "Normal", bsdf, "Normal")
    return b


def _rough_var(nt, bsdf, src, src_out, lo, hi):
    mr = _node(nt, "ShaderNodeMapRange", "RoughRange")
    _set(mr, "From Min", 0.3)
    _set(mr, "From Max", 0.7)
    _set(mr, "To Min", max(0.02, lo))
    _set(mr, "To Max", min(1.0, hi))
    _lnk(nt, src, src_out, mr, "Value")
    _lnk(nt, mr, "Result", bsdf, "Roughness")
    return mr


def texture_graph(mat, nt, bsdf, m, col):
    """Build the family graph. Returns a short description (or None for flat)."""
    family = str(m.get("family") or "")
    rough = max(0.03, min(1.0, fnum(m.get("roughness"), 0.5)))
    tscale = max(0.05, fnum(m.get("texture_scale"), 1.0))
    _drop_tex_nodes(nt)
    _BASE_SRC[0] = None
    mp = _coords(nt, tscale)
    used = []
    if family in ("wood", "planks", "bark"):
        wave = _node(nt, "ShaderNodeTexWave", "Grain")
        try:
            wave.wave_type = "BANDS"
            wave.bands_direction = "Z" if family == "bark" else "X"
            wave.wave_profile = "SIN"
        except Exception:
            pass
        _set(wave, "Scale", 3.0 if family == "planks" else 4.5)
        _set(wave, "Distortion", 6.0 if family == "bark" else 2.5)
        _set(wave, "Detail", 3.0)
        _set(wave, "Detail Scale", 1.4)
        noise = _node(nt, "ShaderNodeTexNoise", "Fibre")
        _set(noise, "Scale", 14.0)
        _set(noise, "Detail", 6.0)
        _set(noise, "Roughness", 0.6)
        mix = _node(nt, "ShaderNodeMixRGB", "GrainMix")
        try:
            mix.blend_type = "MULTIPLY"
        except Exception:
            pass
        _set(mix, "Fac", 0.5)
        ramp = _ramp(nt, "GrainRamp", _shade(col, 0.5 if family == "bark" else 0.62), _shade(col, 1.12), 0.25, 0.75)
        _lnk(nt, mp, "Vector", wave, "Vector")
        _lnk(nt, mp, "Vector", noise, "Vector")
        _lnk(nt, wave, "Fac", mix, "Color1")
        _lnk(nt, noise, "Fac", mix, "Color2")
        _lnk(nt, mix, "Color", ramp, "Fac")
        _lnk(nt, ramp, "Color", bsdf, "Base Color")
        _bump(nt, bsdf, mix, "Color", 0.55 if family == "bark" else 0.25, 0.02 if family == "bark" else 0.006)
        _rough_var(nt, bsdf, noise, "Fac", rough - 0.12, rough + 0.1)
        used = ["wave grain", "noise fibre", "ramp", "bump", "roughness variation"]
    elif family in ("stone", "concrete", "brick"):
        noise = _node(nt, "ShaderNodeTexNoise", "Breakup")
        _set(noise, "Scale", 18.0 if family != "concrete" else 26.0)
        _set(noise, "Detail", 7.0)
        _set(noise, "Roughness", 0.65)
        _lnk(nt, mp, "Vector", noise, "Vector")
        if family == "brick":
            brick = _node(nt, "ShaderNodeTexBrick", "Bricks")
            _set(brick, "Scale", 4.0)
            _set(brick, "Mortar Size", 0.02)
            _set(brick, "Bias", 0.0)
            _set(brick, "Color1", _shade(col, 1.0))
            _set(brick, "Color2", _shade(col, 0.82))
            _set(brick, "Mortar", (0.55, 0.53, 0.5, 1.0))
            _lnk(nt, mp, "Vector", brick, "Vector")
            mix = _node(nt, "ShaderNodeMixRGB", "DirtMix")
            try:
                mix.blend_type = "MULTIPLY"
            except Exception:
                pass
            _set(mix, "Fac", 0.3)
            _lnk(nt, brick, "Color", mix, "Color1")
            _lnk(nt, noise, "Fac", mix, "Color2")
            _lnk(nt, mix, "Color", bsdf, "Base Color")
            _bump(nt, bsdf, brick, "Fac", 0.6, 0.02)
            used = ["brick pattern", "dirt noise", "mortar bump"]
        else:
            vor = _node(nt, "ShaderNodeTexVoronoi", "Cells")
            try:
                vor.feature = "F1"
                vor.distance = "EUCLIDEAN"
            except Exception:
                pass
            _set(vor, "Scale", 6.0 if family == "stone" else 2.5)
            _set(vor, "Randomness", 1.0)
            mix = _node(nt, "ShaderNodeMixRGB", "CellMix")
            try:
                mix.blend_type = "OVERLAY"
            except Exception:
                pass
            _set(mix, "Fac", 0.45 if family == "stone" else 0.2)
            ramp = _ramp(nt, "StoneRamp", _shade(col, 0.7), _shade(col, 1.1), 0.3, 0.7)
            _lnk(nt, mp, "Vector", vor, "Vector")
            _lnk(nt, noise, "Fac", mix, "Color1")
            _lnk(nt, vor, "Distance", mix, "Color2")
            _lnk(nt, mix, "Color", ramp, "Fac")
            _lnk(nt, ramp, "Color", bsdf, "Base Color")
            _bump(nt, bsdf, mix, "Color", 0.4, 0.015)
            _rough_var(nt, bsdf, noise, "Fac", rough - 0.1, min(1.0, rough + 0.08))
            used = ["voronoi cells", "noise breakup", "ramp", "bump", "roughness variation"]
    elif family in ("steel", "dark_steel", "chrome", "gold"):
        brush = _node(nt, "ShaderNodeMapping", "BrushStretch")
        _set(brush, "Scale", (1.0, 40.0, 1.0))
        _lnk(nt, mp, "Vector", brush, "Vector")
        noise = _node(nt, "ShaderNodeTexNoise", "Brushing")
        _set(noise, "Scale", 30.0)
        _set(noise, "Detail", 4.0)
        _set(noise, "Roughness", 0.5)
        _lnk(nt, brush, "Vector", noise, "Vector")
        spot = _node(nt, "ShaderNodeTexNoise", "Smudge")
        _set(spot, "Scale", 4.0)
        _set(spot, "Detail", 2.0)
        _lnk(nt, mp, "Vector", spot, "Vector")
        mix = _node(nt, "ShaderNodeMixRGB", "RoughMix")
        _set(mix, "Fac", 0.35)
        _lnk(nt, noise, "Fac", mix, "Color1")
        _lnk(nt, spot, "Fac", mix, "Color2")
        spread = 0.04 if family == "chrome" else 0.12
        _rough_var(nt, bsdf, mix, "Color", rough - spread, rough + spread)
        tintr = _ramp(nt, "TintRamp", _shade(col, 0.93), _shade(col, 1.04), 0.35, 0.65)
        _lnk(nt, spot, "Fac", tintr, "Fac")
        _lnk(nt, tintr, "Color", bsdf, "Base Color")
        _bump(nt, bsdf, noise, "Fac", 0.03, 0.002)
        try:
            _set_any(bsdf, ("Anisotropic", "Anisotropy"), 0.0 if family == "chrome" else 0.35)
        except Exception:
            pass
        used = ["stretched brushing noise", "smudge", "roughness variation", "micro bump", "anisotropy"]
    elif family == "painted_metal":
        geo = _node(nt, "ShaderNodeNewGeometry", "Geometry")
        wear = _ramp(nt, "EdgeWear", (0.0, 0.0, 0.0, 1.0), (1.0, 1.0, 1.0, 1.0), 0.52, 0.6)
        _lnk(nt, geo, "Pointiness", wear, "Fac")
        noise = _node(nt, "ShaderNodeTexNoise", "PaintNoise")
        _set(noise, "Scale", 22.0)
        _set(noise, "Detail", 5.0)
        _lnk(nt, mp, "Vector", noise, "Vector")
        gate = _node(nt, "ShaderNodeMixRGB", "WearGate")
        try:
            gate.blend_type = "MULTIPLY"
        except Exception:
            pass
        _set(gate, "Fac", 1.0)
        _lnk(nt, wear, "Color", gate, "Color1")
        _lnk(nt, noise, "Fac", gate, "Color2")
        mixc = _node(nt, "ShaderNodeMixRGB", "PaintMix")
        _set(mixc, "Color1", _shade(col, 1.0))
        _set(mixc, "Color2", (0.55, 0.56, 0.58, 1.0))
        _lnk(nt, gate, "Color", mixc, "Fac")
        _lnk(nt, mixc, "Color", bsdf, "Base Color")
        mixm = _node(nt, "ShaderNodeMapRange", "MetalMix")
        _set(mixm, "From Min", 0.0)
        _set(mixm, "From Max", 1.0)
        _set(mixm, "To Min", max(0.0, min(1.0, fnum(m.get("metallic"), 0.6))))
        _set(mixm, "To Max", 1.0)
        _lnk(nt, gate, "Color", mixm, "Value")
        _lnk(nt, mixm, "Result", bsdf, "Metallic")
        _rough_var(nt, bsdf, noise, "Fac", rough - 0.08, rough + 0.12)
        _bump(nt, bsdf, noise, "Fac", 0.06, 0.003)
        used = ["pointiness edge wear (Cycles; Eevee shows paint only)", "paint noise", "metal reveal", "roughness variation"]
    elif family in ("leather", "fabric", "rubber"):
        noise = _node(nt, "ShaderNodeTexNoise", "Grain")
        _set(noise, "Scale", 80.0 if family == "fabric" else (45.0 if family == "leather" else 30.0))
        _set(noise, "Detail", 8.0 if family != "rubber" else 3.0)
        _set(noise, "Roughness", 0.7)
        _lnk(nt, mp, "Vector", noise, "Vector")
        if family == "fabric":
            weave = _node(nt, "ShaderNodeTexWave", "Weave")
            try:
                weave.wave_type = "BANDS"
                weave.bands_direction = "DIAGONAL"
            except Exception:
                pass
            _set(weave, "Scale", 60.0)
            _set(weave, "Distortion", 1.0)
            _lnk(nt, mp, "Vector", weave, "Vector")
            mix = _node(nt, "ShaderNodeMixRGB", "WeaveMix")
            _set(mix, "Fac", 0.5)
            _lnk(nt, weave, "Fac", mix, "Color1")
            _lnk(nt, noise, "Fac", mix, "Color2")
            _bump(nt, bsdf, mix, "Color", 0.25, 0.002)
            _set_any(bsdf, ("Sheen Weight", "Sheen"), 0.6)
        else:
            _bump(nt, bsdf, noise, "Fac", 0.18 if family == "leather" else 0.08, 0.002)
        ramp = _ramp(nt, "ToneRamp", _shade(col, 0.85), _shade(col, 1.08), 0.35, 0.65)
        _lnk(nt, noise, "Fac", ramp, "Fac")
        _lnk(nt, ramp, "Color", bsdf, "Base Color")
        _rough_var(nt, bsdf, noise, "Fac", rough - 0.08, min(1.0, rough + 0.06))
        used = ["micro-grain noise", "weave" if family == "fabric" else "bump", "tone ramp", "roughness variation"]
    elif family in ("glass", "crystal"):
        _set_any(bsdf, ("Transmission Weight", "Transmission"), 1.0 if family == "glass" else 0.7)
        _set(bsdf, "IOR", 1.45 if family == "glass" else 1.6)
        _set(bsdf, "Roughness", 0.04 if family == "glass" else rough)
        try:
            mat.use_screen_refraction = True
        except Exception:
            pass
        try:
            mat.blend_method = "BLEND"
            mat.surface_render_method = "BLENDED"
        except Exception:
            pass
        if family == "crystal":
            noise = _node(nt, "ShaderNodeTexNoise", "Flaws")
            _set(noise, "Scale", 9.0)
            _set(noise, "Detail", 3.0)
            _lnk(nt, mp, "Vector", noise, "Vector")
            _bump(nt, bsdf, noise, "Fac", 0.08, 0.004)
            em = m.get("emission") or col
            e = [max(0.0, min(1.0, fnum(c, 0.0))) for c in list(em)[:3]]
            _set_any(bsdf, ("Emission Color", "Emission"), (e[0], e[1], e[2], 1.0))
            if fnum(m.get("emission_strength"), 0.0) <= 0:
                _set(bsdf, "Emission Strength", 0.35)
            used = ["transmission 0.7 / IOR 1.6", "internal flaw bump", "faint emission"]
        else:
            used = ["transmission 1.0 / IOR 1.45", "screen-space refraction"]
    elif family == "energy":
        noise = _node(nt, "ShaderNodeTexNoise", "Pulse")
        _set(noise, "Scale", 3.0)
        _set(noise, "Detail", 2.0)
        _lnk(nt, mp, "Vector", noise, "Vector")
        em = m.get("emission") or col
        e = [max(0.0, min(1.0, fnum(c, 0.0))) for c in list(em)[:3]]
        ramp = _ramp(nt, "PulseRamp", (e[0], e[1], e[2], 1.0), _shade(e, 1.6), 0.35, 0.7)
        _lnk(nt, noise, "Fac", ramp, "Fac")
        if not _lnk(nt, ramp, "Color", bsdf, "Emission Color"):
            _lnk(nt, ramp, "Color", bsdf, "Emission")
        used = ["noise pulse", "emission ramp"]
    elif family == "foliage":
        noise = _node(nt, "ShaderNodeTexNoise", "LeafVar")
        _set(noise, "Scale", 25.0)
        _set(noise, "Detail", 4.0)
        _lnk(nt, mp, "Vector", noise, "Vector")
        ramp = _ramp(nt, "LeafRamp", _shade(col, 0.78), _shade(col, 1.22), 0.3, 0.7)
        _lnk(nt, noise, "Fac", ramp, "Fac")
        _lnk(nt, ramp, "Color", bsdf, "Base Color")
        _bump(nt, bsdf, noise, "Fac", 0.12, 0.003)
        _set_any(bsdf, ("Subsurface Weight", "Subsurface"), 0.08)
        try:
            _set_any(bsdf, ("Subsurface Color",), (col[0], col[1], col[2], 1.0))
        except Exception:
            pass
        used = ["colour variation", "leaf bump", "light subsurface"]
    else:
        noise = _node(nt, "ShaderNodeTexNoise", "Finish")
        _set(noise, "Scale", 35.0)
        _set(noise, "Detail", 3.0)
        _lnk(nt, mp, "Vector", noise, "Vector")
        _rough_var(nt, bsdf, noise, "Fac", rough - 0.05, min(1.0, rough + 0.05))
        used = ["roughness variation"]
    # tidy the editor a little (no effect on render)
    try:
        x = -1400
        for n in nt.nodes:
            if str(n.name).startswith(TEX_PREFIX):
                n.location = (x, 300)
                x += 180
    except Exception:
        pass
    return {"family": family or "default", "scale": tscale, "features": used}, _BASE_SRC[0]


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
    # 1.98.0 family shader graph (procedural textures) unless the spec says flat.
    # Blender-only: Base Color keeps the flat colour as default_value, which is what
    # the Studio importer reads; blender_asset_bake turns the graph into PNGs.
    tex_mode = str(m.get("texture") or "procedural")
    base_src = None
    if tex_mode != "flat":
        try:
            info, base_src = texture_graph(mat, nt, bsdf, m, col)
            mat["total_texture"] = json.dumps(info)
        except Exception as e:
            mat["total_texture"] = json.dumps({"error": str(e)[:200]})
    else:
        _drop_tex_nodes(nt)
        mat["total_texture"] = json.dumps({"family": str(m.get("family") or ""), "features": ["flat"]})
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
            wear_mix = [n for n in nt.nodes if n.name == "TotalWearMix"]
            if base_src and wear_mix:
                # the family graph feeds the wear multiply instead of a flat colour
                nt.links.new(base_src[0].outputs[base_src[1]], wear_mix[0].inputs["Color1"])
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
    gen_info = None
    if shape == "generator":
        bm, gen_info = bm_generate(part.get("generator"), size, segments if part.get("segments") else None, subdiv if part.get("subdivisions") else None)
    else:
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
        uv_mode = unwrap(obj, shape in ("ico", "sphere", "generator") or "displace" in applied)
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
    if gen_info:
        obj["total_generator"] = str(gen_info.get("kind") or "")
    return obj, {"name": name, "object": obj.name, "shape": shape, "generator": gen_info, "ops": applied, "modifiers": mods, "smooth": smooth_mode, "uv": uv_mode, "material": mat_id}


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
    # leave the whole asset selected (smart_project left only the last organic
    # part selected, so a bare blender_send_to_studio sent one part) - 1.98.0
    try:
        for o in bpy.context.view_layer.objects:
            try:
                o.select_set(o.get("total_asset") == name and o.type == "MESH")
            except Exception:
                pass
        bpy.context.view_layer.objects.active = built[0][0] if built else root
    except Exception:
        pass
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


# ─────────────────────────── texture baking (1.99.2) ────────────────────────
# Cycles bakes the procedural graphs into PNGs per material (base colour,
# roughness, metallic, normal, emission) in <workspace>/total_textures. Local
# files only: Roblox needs them uploaded by the user as image assets before a
# SurfaceAppearance can use them - TotalScript never uploads.
BAKE_MAPS = ("base_color", "roughness", "metallic", "normal", "emission")


def _find_nodes(nt):
    bsdf = out = None
    for n in nt.nodes:
        if n.type == "BSDF_PRINCIPLED" and bsdf is None:
            bsdf = n
        if n.type == "OUTPUT_MATERIAL":
            out = n
    return bsdf, out


def _input_link(nt, node, key):
    """(from_node, from_socket) feeding node.inputs[key], or None."""
    try:
        sock = node.inputs[key]
        for l in nt.links:
            if l.to_node == node and l.to_socket == sock:
                return (l.from_node, l.from_socket)
    except Exception:
        pass
    return None


def _unlink_input(nt, node, key):
    try:
        sock = node.inputs[key]
        for l in list(nt.links):
            if l.to_node == node and l.to_socket == sock:
                nt.links.remove(l)
    except Exception:
        pass


def bake_asset(name, size, maps, margin, samples, apply):
    root, coll, meshes = asset_objects(name)
    if not meshes:
        return {"ok": False, "error": "no mesh objects found for asset '%s'" % name, "error_class": "resource_missing"}
    engines = set()
    try:
        engines = set(getattr(it, "identifier", str(it)) for it in scene().render.bl_rna.properties["engine"].enum_items)
    except Exception:
        pass
    if engines and "CYCLES" not in engines:
        return {"ok": False, "error": "texture baking needs the Cycles engine, which this Blender build does not list", "error_class": "api_version", "allowed": sorted(engines)}
    no_uv = [o.name for o in meshes if not getattr(o.data, "uv_layers", None) or len(o.data.uv_layers) == 0]
    if no_uv:
        return {"ok": False, "error": "these meshes have no UV map, so there is nothing to bake into: %s" % ", ".join(no_uv), "error_class": "resource_missing", "fix": "Rebuild with spec.uv true (default) or run blender_uv_unwrap on them first."}
    maps = [str(m) for m in (maps or list(BAKE_MAPS))]
    if not maps or any(m not in BAKE_MAPS for m in maps):
        return {"ok": False, "error": "maps must be a subset of %s" % ", ".join(BAKE_MAPS), "error_class": "invalid_enum", "allowed": list(BAKE_MAPS), "got": maps}
    size = int(max(64, min(4096, fnum(size, 1024))))
    margin = int(max(0, min(64, fnum(margin, 4))))
    samples = int(max(1, min(256, fnum(samples, 16))))
    sc = scene()
    folder = os.path.join(workspace_dir(), "total_textures")
    os.makedirs(folder, exist_ok=True)
    saved = {"engine": sc.render.engine, "cy_samples": None, "cy_denoise": None}
    cy = getattr(sc, "cycles", None)
    if cy is not None:
        saved["cy_samples"] = getattr(cy, "samples", None)
        saved["cy_denoise"] = getattr(cy, "use_denoising", None)
    sc.render.engine = "CYCLES"
    if cy is not None:
        try:
            cy.samples = samples
            cy.use_denoising = False
        except Exception:
            pass
    # material -> objects using it
    by_mat = {}
    for o in meshes:
        for mt in o.data.materials:
            if mt is not None and getattr(mt, "use_nodes", False):
                by_mat.setdefault(mt.name, (mt, []))[1].append(o)
    if not by_mat:
        sc.render.engine = saved["engine"]
        return {"ok": False, "error": "the asset has no node materials to bake", "error_class": "resource_missing"}
    baked = []
    problems = []
    try:
        for mat_name, (mat, objs) in by_mat.items():
            nt = mat.node_tree
            bsdf, out = _find_nodes(nt)
            if bsdf is None or out is None:
                problems.append("%s: no Principled BSDF / output" % mat_name)
                continue
            target = nt.nodes.new("ShaderNodeTexImage")
            target.name = "Total_Bake_Target"
            try:
                target.label = "Total bake target"
            except Exception:
                pass
            images = {}
            for mp in maps:
                img_name = "Total_%s_%s_%s" % (ident(name, "Asset"), ident(mat_name.split("_")[-1], "Mat"), mp)
                old = bpy.data.images.get(img_name)
                if old is not None:
                    try:
                        bpy.data.images.remove(old)
                    except Exception:
                        pass
                img = bpy.data.images.new(img_name, width=size, height=size, alpha=(mp == "base_color"))
                if mp != "base_color":
                    try:
                        img.colorspace_settings.name = "Non-Color"
                    except Exception:
                        pass
                target.image = img
                nt.nodes.active = target
                try:
                    bpy.ops.object.select_all(action="DESELECT")
                except Exception:
                    pass
                for o in objs:
                    try:
                        o.select_set(True)
                    except Exception:
                        pass
                bpy.context.view_layer.objects.active = objs[0]
                restore = []
                try:
                    if mp == "base_color":
                        # metals have a black diffuse colour: bake with metallic forced to 0
                        link = _input_link(nt, bsdf, "Metallic")
                        val = bsdf.inputs["Metallic"].default_value
                        _unlink_input(nt, bsdf, "Metallic")
                        bsdf.inputs["Metallic"].default_value = 0.0
                        restore.append(("metallic", link, val))
                        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=margin, use_clear=True, use_selected_to_active=False)
                    elif mp == "roughness":
                        bpy.ops.object.bake(type="ROUGHNESS", margin=margin, use_clear=True, use_selected_to_active=False)
                    elif mp == "normal":
                        bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=margin, use_clear=True, use_selected_to_active=False)
                    elif mp == "emission":
                        bpy.ops.object.bake(type="EMIT", margin=margin, use_clear=True, use_selected_to_active=False)
                    elif mp == "metallic":
                        # no METALLIC pass: route the metallic source through an emission shader
                        emit_n = nt.nodes.new("ShaderNodeEmission")
                        emit_n.name = "Total_Bake_Emit"
                        link = _input_link(nt, bsdf, "Metallic")
                        if link:
                            nt.links.new(link[1], emit_n.inputs["Color"])
                        else:
                            v = float(bsdf.inputs["Metallic"].default_value)
                            emit_n.inputs["Color"].default_value = (v, v, v, 1.0)
                        emit_n.inputs["Strength"].default_value = 1.0
                        surf = _input_link(nt, out, "Surface")
                        nt.links.new(emit_n.outputs["Emission"], out.inputs["Surface"])
                        restore.append(("surface", surf, emit_n))
                        bpy.ops.object.bake(type="EMIT", margin=margin, use_clear=True, use_selected_to_active=False)
                finally:
                    for kind, link, extra in restore:
                        if kind == "metallic":
                            bsdf.inputs["Metallic"].default_value = extra
                            if link:
                                try:
                                    nt.links.new(link[1], bsdf.inputs["Metallic"])
                                except Exception:
                                    pass
                        elif kind == "surface":
                            try:
                                nt.nodes.remove(extra)
                            except Exception:
                                pass
                            try:
                                nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
                            except Exception:
                                pass
                path = os.path.join(folder, img_name + ".png")
                img.filepath_raw = path
                img.file_format = "PNG"
                img.save()
                ok = os.path.exists(path) and os.path.getsize(path) > 0
                images[mp] = {"path": path, "ok": ok, "bytes": os.path.getsize(path) if ok else 0}
                if ok:
                    mat["total_tex_" + mp] = path
            if apply:
                # rewire the Principled inputs to the baked images (graph nodes stay, unlinked)
                x = -600
                for mp, info in images.items():
                    if not info["ok"]:
                        continue
                    tex = nt.nodes.new("ShaderNodeTexImage")
                    tex.name = "Total_Baked_" + mp
                    tex.image = bpy.data.images.get(os.path.basename(info["path"])[:-4])
                    try:
                        tex.location = (x, -400)
                    except Exception:
                        pass
                    x += 260
                    if mp == "base_color":
                        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
                    elif mp == "roughness":
                        nt.links.new(tex.outputs["Color"], bsdf.inputs["Roughness"])
                    elif mp == "metallic":
                        nt.links.new(tex.outputs["Color"], bsdf.inputs["Metallic"])
                    elif mp == "emission":
                        sock = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
                        if sock is not None:
                            nt.links.new(tex.outputs["Color"], sock)
                    elif mp == "normal":
                        nm = nt.nodes.new("ShaderNodeNormalMap")
                        nm.name = "Total_Baked_NormalMap"
                        nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
                        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
                mat["total_baked"] = True
            try:
                nt.nodes.remove(target)
            except Exception:
                pass
            baked.append({"material": mat_name, "objects": [o.name for o in objs], "images": images})
    except Exception as e:
        return {"ok": False, "error": "bake failed: %s" % e, "error_class": "runtime", "traceback": traceback.format_exc()[-1500:], "baked": baked}
    finally:
        try:
            sc.render.engine = saved["engine"]
            if cy is not None and saved["cy_samples"] is not None:
                cy.samples = saved["cy_samples"]
            if cy is not None and saved["cy_denoise"] is not None:
                cy.use_denoising = saved["cy_denoise"]
        except Exception:
            pass
    total_ok = sum(1 for b in baked for i in b["images"].values() if i["ok"])
    return {
        "ok": total_ok > 0 and not problems,
        "asset": name,
        "size": size,
        "maps": maps,
        "samples": samples,
        "materials": baked,
        "problems": problems,
        "textures_dir": folder,
        "files": [i["path"] for b in baked for i in b["images"].values() if i["ok"]],
        "applied": bool(apply),
        "roblox": "Local PNGs only. To use them in Studio: upload each map yourself (Creator Hub / Asset Manager -> image assets), then build a SurfaceAppearance (ColorMap / RoughnessMap / MetalnessMap / NormalMap) on the imported MeshPart with those asset ids. TotalScript does not upload and will not invent asset ids; the Studio import keeps the flat colours until you do.",
    }


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
        if cmd == "asset_bake":
            if not name:
                return emit({"ok": False, "error": "asset_bake needs name"})
            maps = ARGS.get("maps")
            if isinstance(maps, str):
                maps = [m.strip() for m in maps.split(",") if m.strip()]
            return emit(bake_asset(name, ARGS.get("size"), maps if isinstance(maps, list) else None, ARGS.get("margin"), ARGS.get("samples"), ARGS.get("apply") is not False))
        return emit({"ok": False, "error": "unknown asset command '%s' (asset_build, asset_validate, asset_inspect, asset_export, asset_bake)" % cmd})
    except Exception as e:
        return emit(classify_exception(e, CMD))


main()
