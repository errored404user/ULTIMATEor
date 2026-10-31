# TotalScript studio rig (1.99.8) - lighting, cameras, world and renders.
# Sent to Blender as execute_code like blender_ops.py / blender_asset.py;
# tokens CMD / ARGS / OUT / MESH are filled by TotalScript.
#
# Commands (the blender_ prefix is stripped)
#   light_rig    {preset, target?, strength?, warmth?, backdrop?}
#                three_point | product | sun | overcast | night | neon | dramatic | interior_warm
#                Lights live in the Total_Studio collection and are sized / powered from the
#                target's bounding sphere, so the same preset reads the same on a 0.3 m prop
#                and a 12 m building.
#   camera_rig   {preset, target?, lens?, dof?, fstop?, aspect?, name?, turntable?, frames?, margin?}
#                hero | product | front | side | back | top | closeup | wide | iso
#                Frames the target's bounding sphere with the real field of view (margin 15 %),
#                makes it the scene camera, optional depth of field focused on the target and an
#                optional turntable pivot (linear 360 deg over N frames).
#   world_setup  {preset, strength?, color?, sun_elevation?, sun_rotation?, hdri?}
#                studio_grey | white | black | sky | night | hdri   (hdri = a LOCAL file path; nothing
#                is downloaded)
#   render_setup {engine?, quality?, width?, height?, transparent?, denoise?, samples?,
#                 view_transform?, exposure?, format?, fps?, output?}
#                engine eevee | cycles | workbench (version-mapped), quality preview | standard | final
#   render_shot  {target?, views?, camera?, size?, path?}
#                renders the scene camera (or one preset view per entry in views) and returns
#                render_files so TotalScript attaches the PNGs to the reply.
#   turntable    {target?, frames?, size?, fps?, format?, path?}
#                png frame sequence (default) or mp4 (FFmpeg H.264 when the build has it) plus four
#                quarter-turn stills attached to the reply.
#   studio_clear {}
#                removes the Total_Studio rig (lights, cameras, pivot, backdrop) - the user's scene
#                and assets are untouched.
#
# Plain bpy only, so it also runs in background Blender. Nothing here uploads anything.
import bpy
import json
import math
import os
import time
import traceback
from mathutils import Vector, Euler

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
STUDIO = "Total_Studio"
VERSION = "1.99.8"


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


def classify_exception(exc, cmd=""):
    """Same shape as blender_ops.py / blender_asset.py: class + Fix line, never a bare traceback."""
    msg = str(exc)
    tb = traceback.format_exc()[-1200:]
    cls = "runtime"
    fix = "Read the message; retry with the named parameter fixed."
    low = msg.lower()
    if "enum" in low and "not found in" in low:
        cls = "invalid_enum"
        fix = "Use one of the allowed values listed in the message."
    elif "context is incorrect" in low or "poll()" in low:
        cls = "context"
        fix = "Operator needs a UI context - TotalScript's named tools avoid operators; report this command."
    elif isinstance(exc, (KeyError, AttributeError)):
        cls = "api_version"
        fix = "This Blender build lacks the property; TotalScript guards most of them - report the Blender version (%s)." % blender_version()
    elif isinstance(exc, (OSError, IOError)):
        cls = "filesystem"
        fix = "Check the output folder exists and is writable (TotalScript uses the workspace folder)."
    return {"ok": False, "error": "[blender] %s: %s" % (cls, msg), "error_class": cls, "command": cmd, "fix": fix, "traceback": tb}


def blender_version():
    try:
        return ".".join(str(x) for x in bpy.app.version)
    except Exception:
        return "unknown"


def fnum(v, d=0.0):
    try:
        return float(v)
    except Exception:
        return float(d)


def fbool(v, d=False):
    if v is None:
        return d
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return bool(v)


def workspace_dir():
    folder = os.path.dirname(OUT) if OUT else ""
    if folder and os.path.isdir(folder):
        return folder
    folder = os.path.join(os.path.expanduser("~"), "Documents", "TotalScript")
    os.makedirs(folder, exist_ok=True)
    return folder


def scene():
    return bpy.context.scene


def link(obj, coll):
    try:
        coll.objects.link(obj)
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
    data = getattr(obj, "data", None)
    try:
        bpy.data.objects.remove(obj, do_unlink=True)
    except Exception:
        return
    for pool in (getattr(bpy.data, "lights", None), getattr(bpy.data, "cameras", None), getattr(bpy.data, "meshes", None)):
        try:
            if data is not None and pool is not None and data in list(pool) and getattr(data, "users", 0) == 0:
                pool.remove(data)
        except Exception:
            pass


def studio_objects(kind=None):
    coll = bpy.data.collections.get(STUDIO)
    if coll is None:
        return []
    objs = list(coll.all_objects) if hasattr(coll, "all_objects") else list(coll.objects)
    return [o for o in objs if kind is None or o.get("total_studio") == kind]


def clear_kind(kind):
    for o in studio_objects(kind):
        remove_object(o)


def kelvin_rgb(k):
    """Approximate black-body colour (Tanner Helland fit), linear-ish 0..1."""
    t = max(1000.0, min(12000.0, fnum(k, 5500.0))) / 100.0
    if t <= 66:
        r = 1.0
        g = max(0.0, min(1.0, (99.4708025861 * math.log(t) - 161.1195681661) / 255.0))
        b = 0.0 if t <= 19 else max(0.0, min(1.0, (138.5177312231 * math.log(t - 10) - 305.0447927307) / 255.0))
    else:
        r = max(0.0, min(1.0, 329.698727446 * ((t - 60) ** -0.1332047592) / 255.0))
        g = max(0.0, min(1.0, 288.1221695283 * ((t - 60) ** -0.0755148492) / 255.0))
        b = 1.0
    return (r, g, b)


# ─────────────────────────── target bounds ──────────────────────────────────

def target_meshes(name):
    """Mesh objects of the target: an asset collection, a single object (+children),
    or - with no name - every visible mesh outside the Total_* helper collections."""
    name = str(name or "")
    if name:
        coll = bpy.data.collections.get(name)
        if coll is not None:
            objs = list(coll.all_objects) if hasattr(coll, "all_objects") else list(coll.objects)
            return [o for o in objs if o.type == "MESH"], name
        obj = bpy.data.objects.get(name)
        if obj is not None:
            kids = list(obj.children_recursive) if hasattr(obj, "children_recursive") else [o for o in bpy.data.objects if o.parent == obj]
            return [o for o in [obj] + kids if o.type == "MESH"], name
        return [], name
    out = []
    for o in bpy.data.objects:
        if o.type != "MESH" or getattr(o, "hide_render", False):
            continue
        if any(c.name.startswith("Total_Studio") or c.name.startswith("Total_Inspect") for c in getattr(o, "users_collection", [])):
            continue
        out.append(o)
    return out, "scene"


def world_corners(obj):
    mw = obj.matrix_world
    pts = []
    try:
        for c in obj.bound_box:
            pts.append(mw @ Vector(c))
    except Exception:
        pts.append(Vector(obj.location))
    return pts


def target_bounds(name):
    meshes, label = target_meshes(name)
    if not meshes:
        return None
    lo = [1e18, 1e18, 1e18]
    hi = [-1e18, -1e18, -1e18]
    for o in meshes:
        for p in world_corners(o):
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    lo_v, hi_v = Vector(lo), Vector(hi)
    centre = (lo_v + hi_v) / 2.0
    radius = max(0.05, (hi_v - lo_v).length / 2.0)
    return {"label": label, "lo": lo_v, "hi": hi_v, "centre": centre, "radius": radius, "count": len(meshes), "dims": [round(hi[i] - lo[i], 4) for i in range(3)]}


def aim(obj, at):
    direction = Vector(at) - Vector(obj.location)
    if direction.length < 1e-9:
        return
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


# ─────────────────────────── lights ─────────────────────────────────────────

LIGHT_PRESETS = {
    # name: list of (role, type, direction (x, y, z) * R*dist_mult, energy per R^2, size mult, kelvin offset, extra)
    "three_point": {"lights": [("Key", "AREA", (1.0, -1.0, 1.2), 3.0, 1000.0, 1.5, 0), ("Fill", "AREA", (-1.4, -0.6, 0.6), 3.0, 350.0, 2.2, 600), ("Rim", "AREA", (0.4, 1.4, 1.0), 3.0, 650.0, 1.0, 1200)], "world": ("studio_grey", 0.25), "note": "classic key / fill / rim - the neutral default for props"},
    "product": {"lights": [("Top", "AREA", (0.0, -0.4, 2.4), 2.6, 1400.0, 3.0, 0), ("Left", "AREA", (-1.6, -0.9, 0.5), 3.0, 450.0, 2.5, 0), ("Right", "AREA", (1.6, -0.9, 0.5), 3.0, 450.0, 2.5, 0), ("Back", "AREA", (0.0, 1.8, 0.9), 3.0, 500.0, 2.0, 800)], "world": ("white", 0.6), "backdrop": True, "note": "softbox product table: top light + symmetric fills + separation light, white sweep"},
    "sun": {"lights": [("Sun", "SUN", (0.8, -0.6, 1.0), 10.0, 4.0, 0.0, -300), ("SkyFill", "AREA", (-1.0, -1.0, 2.0), 4.0, 200.0, 4.0, 2500)], "world": ("sky", 0.6), "note": "warm sun ~45 deg with a cool sky fill; world = procedural sky"},
    "overcast": {"lights": [("Dome", "AREA", (0.0, 0.0, 3.0), 2.5, 900.0, 6.0, 1200), ("Soft", "SUN", (0.3, -0.5, 1.0), 10.0, 1.2, 0.0, 1000)], "world": ("studio_grey", 1.0), "note": "big soft dome + weak soft sun, light grey world - shadowless read of the forms"},
    "night": {"lights": [("Moon", "SUN", (-0.6, 0.8, 1.0), 10.0, 0.25, 0.0, 3500), ("Rim", "AREA", (0.8, 1.2, 0.8), 3.0, 180.0, 1.2, 2000), ("Lamp", "POINT", (0.9, -0.9, 0.9), 2.0, 60.0, 0.3, -2600)], "world": ("night", 0.08), "note": "cool moon + warm practical point light, near-black blue world"},
    "neon": {"lights": [("Key", "AREA", (0.6, -1.2, 1.0), 3.0, 180.0, 1.5, 0), ("Magenta", "AREA", (-1.4, 0.6, 0.6), 2.8, 700.0, 1.2, 0, (1.0, 0.1, 0.7)), ("Cyan", "AREA", (1.4, 0.8, 0.5), 2.8, 700.0, 1.2, 0, (0.1, 0.85, 1.0))], "world": ("black", 1.0), "note": "dim key + magenta / cyan rim pair on black - sci-fi / cyber reads"},
    "dramatic": {"lights": [("Key", "SPOT", (1.3, -0.9, 1.6), 3.2, 2500.0, 0.3, -800), ("Fill", "AREA", (-1.2, -1.0, 0.3), 3.5, 40.0, 2.5, 1500)], "world": ("black", 1.0), "note": "one hard spot high on the side, almost no fill - long shadows, horror / cinematic"},
    "interior_warm": {"lights": [("Lamp1", "POINT", (0.9, -0.5, 1.3), 2.2, 220.0, 0.35, -2800), ("Lamp2", "POINT", (-0.8, 0.7, 1.1), 2.2, 160.0, 0.35, -2800), ("Bounce", "AREA", (0.0, -1.2, 0.2), 3.0, 120.0, 3.0, -1500)], "world": ("studio_grey", 0.15), "note": "two warm practicals + a floor bounce - cosy interior"},
}


def make_light(name, ltype, coll):
    ld = bpy.data.lights.new(name, ltype)
    lo = bpy.data.objects.new(name, ld)
    link(lo, coll)
    lo["total_studio"] = "light"
    return lo, ld


def build_light_rig(preset, target, strength, warmth, backdrop):
    p = LIGHT_PRESETS.get(preset)
    if p is None:
        return {"ok": False, "error": "unknown light preset '%s'" % preset, "error_class": "invalid_enum", "allowed": sorted(LIGHT_PRESETS.keys()), "fix": "Pick one of the allowed presets."}
    b = target_bounds(target)
    if b is None:
        return {"ok": False, "error": "no mesh objects found for target '%s' - build or import something first (blender_asset_build) or pass target: an asset / object / collection name" % (target or "scene"), "error_class": "resource_missing"}
    coll = get_collection(STUDIO)
    clear_kind("light")
    if not backdrop:
        clear_kind("backdrop")
    R, C = b["radius"], b["centre"]
    made = []
    base_k = fnum(warmth, 5500.0)
    for row in p["lights"]:
        role, ltype, d, dist_mult, energy, size_mult, k_off = row[:7]
        colour = row[7] if len(row) > 7 else kelvin_rgb(base_k + k_off)
        lo, ld = make_light("%s_%s" % (STUDIO, role), ltype, coll)
        dv = Vector(d).normalized()
        lo.location = C + dv * R * dist_mult
        aim(lo, C)
        ld.color = colour
        if ltype == "SUN":
            ld.energy = energy * strength
            try:
                ld.angle = math.radians(0.53 if size_mult == 0 else 8.0)
            except Exception:
                pass
        else:
            # inverse-square: power scales with the square of the rig radius (distance ~ R)
            ld.energy = energy * strength * max(0.05, R * R)
            if ltype == "AREA":
                try:
                    ld.shape = "RECTANGLE" if role in ("Top", "Dome") else "SQUARE"
                    ld.size = R * size_mult
                    if ld.shape == "RECTANGLE":
                        ld.size_y = R * size_mult * 0.6
                except Exception:
                    pass
            elif ltype == "SPOT":
                try:
                    ld.spot_size = math.radians(42.0)
                    ld.spot_blend = 0.25
                    ld.shadow_soft_size = R * size_mult
                except Exception:
                    pass
            elif ltype == "POINT":
                try:
                    ld.shadow_soft_size = R * size_mult
                except Exception:
                    pass
        lo["total_studio_role"] = role
        made.append({"name": lo.name, "role": role, "type": ltype, "energy": round(ld.energy, 2), "color": [round(c, 3) for c in colour], "location": [round(v, 3) for v in lo.location]})
    if backdrop or (p.get("backdrop") and backdrop is not False):
        make_backdrop(b, coll, preset)
    world_preset, world_strength = p["world"]
    world = apply_world(world_preset, world_strength * strength, None, None, None, None)
    return {"ok": True, "preset": preset, "target": b["label"], "target_dims_m": b["dims"], "radius_m": round(R, 3), "lights": made, "backdrop": bool(studio_objects("backdrop")), "world": world, "strength": strength, "warmth_k": base_k, "note": p["note"] + ". Rig lives in %s; blender_studio_clear removes it." % STUDIO}


def make_backdrop(b, coll, preset):
    clear_kind("backdrop")
    import bmesh
    R, C, lo = b["radius"], b["centre"], b["lo"]
    bm = bmesh.new()
    # floor + swept back wall (a quarter-round sweep so the horizon never shows)
    w = R * 8.0
    depth = R * 6.0
    rows = []
    rows.append([bm.verts.new((-w, -depth, 0.0)), bm.verts.new((w, -depth, 0.0))])
    segs = 8
    r = R * 2.0  # radius of the floor-to-wall sweep
    for i in range(segs + 1):
        a = (math.pi / 2.0) * i / segs
        y = depth * 0.5 + r * math.sin(a)
        z = r * (1.0 - math.cos(a))
        rows.append([bm.verts.new((-w, y, z)), bm.verts.new((w, y, z))])
    rows.append([bm.verts.new((-w, depth * 0.5 + r, r + R * 6.0)), bm.verts.new((w, depth * 0.5 + r, r + R * 6.0))])
    for i in range(len(rows) - 1):
        try:
            bm.faces.new((rows[i][0], rows[i][1], rows[i + 1][1], rows[i + 1][0]))
        except ValueError:
            pass
    me = bpy.data.meshes.new(STUDIO + "_Backdrop")
    bm.to_mesh(me)
    bm.free()
    plane = bpy.data.objects.new(STUDIO + "_Backdrop", me)
    plane.location = (C.x, C.y, lo.z - 0.002)
    mat = bpy.data.materials.get(STUDIO + "_Sweep") or bpy.data.materials.new(STUDIO + "_Sweep")
    grey = 0.85 if preset == "product" else 0.35
    mat.diffuse_color = (grey, grey, grey, 1.0)
    try:
        mat.use_nodes = True
        for n in mat.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                n.inputs["Base Color"].default_value = (grey, grey, grey, 1.0)
                n.inputs["Roughness"].default_value = 0.9
    except Exception:
        pass
    me.materials.append(mat)
    for poly in me.polygons:
        poly.use_smooth = True
    link(plane, get_collection(STUDIO))
    plane["total_studio"] = "backdrop"
    try:
        plane.is_shadow_catcher = False
    except Exception:
        pass
    return plane


# ─────────────────────────── world ──────────────────────────────────────────

WORLD_PRESETS = {"studio_grey": (0.18, 0.18, 0.19), "white": (0.92, 0.92, 0.92), "black": (0.0, 0.0, 0.0), "night": (0.01, 0.015, 0.035), "sky": None, "hdri": None}


def world_nodes():
    world = scene().world
    if world is None:
        world = bpy.data.worlds.new("World")
        scene().world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = None
    out = None
    for n in nt.nodes:
        if n.type == "BACKGROUND" and bg is None:
            bg = n
        if n.type == "OUTPUT_WORLD":
            out = n
    if out is None:
        out = nt.nodes.new("ShaderNodeOutputWorld")
    if bg is None:
        bg = nt.nodes.new("ShaderNodeBackground")
        nt.links.new(bg.outputs[0], out.inputs[0])
    return world, nt, bg, out


def drop_total_world_nodes(nt):
    for n in list(nt.nodes):
        if str(getattr(n, "name", "")).startswith("Total_World_"):
            try:
                nt.nodes.remove(n)
            except Exception:
                pass


def apply_world(preset, strength, color, sun_elevation, sun_rotation, hdri):
    preset = str(preset or "studio_grey")
    if preset not in WORLD_PRESETS:
        return {"ok": False, "error": "unknown world preset '%s'" % preset, "error_class": "invalid_enum", "allowed": sorted(WORLD_PRESETS.keys())}
    world, nt, bg, out = world_nodes()
    drop_total_world_nodes(nt)
    strength = max(0.0, fnum(strength, 1.0))
    info = {"preset": preset, "strength": strength}
    if preset == "sky":
        sky = nt.nodes.new("ShaderNodeTexSky")
        sky.name = "Total_World_Sky"
        try:
            sky.sky_type = "NISHITA"
            sky.sun_elevation = math.radians(fnum(sun_elevation, 35.0))
            sky.sun_rotation = math.radians(fnum(sun_rotation, 140.0))
            sky.sun_intensity = 1.0
            sky.sun_size = math.radians(1.0)
            sky.altitude = 0.0
            sky.air_density = 1.0
            sky.dust_density = 1.0
        except Exception:
            pass
        nt.links.new(sky.outputs[0], bg.inputs[0])
        info.update({"sun_elevation": fnum(sun_elevation, 35.0), "sun_rotation": fnum(sun_rotation, 140.0), "sky": "NISHITA"})
    elif preset == "hdri":
        path = str(hdri or "")
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "hdri needs a LOCAL image file path (.hdr / .exr) - TotalScript does not download environment maps", "error_class": "resource_missing", "fix": "Pass hdri: the absolute path of a file on this machine, or use preset: sky."}
        try:
            img = bpy.data.images.load(path, check_existing=True)
        except Exception as e:
            return {"ok": False, "error": "could not load HDRI: %s" % e, "error_class": "filesystem"}
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.name = "Total_World_HDRI"
        env.image = img
        nt.links.new(env.outputs[0], bg.inputs[0])
        info["hdri"] = path
    else:
        rgb = list(color)[:3] if isinstance(color, (list, tuple)) and len(color) >= 3 else list(WORLD_PRESETS[preset])
        rgb = [max(0.0, min(1.0, fnum(c, 0.0))) for c in rgb]
        try:
            for l in list(nt.links):
                if l.to_node == bg and l.to_socket == bg.inputs[0]:
                    nt.links.remove(l)
        except Exception:
            pass
        bg.inputs[0].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
        info["color"] = [round(c, 3) for c in rgb]
    bg.inputs[1].default_value = strength
    try:
        world["total_world_preset"] = preset
    except Exception:
        pass
    info["ok"] = True
    return info


# ─────────────────────────── camera ─────────────────────────────────────────

CAMERA_PRESETS = {
    # direction (from centre, normalised later), distance multiplier, default lens, dof default, fstop
    "hero": {"dir": (1.0, -1.0, 0.35), "dist": 1.0, "lens": 50, "dof": True, "fstop": 2.8, "note": "low three-quarter - makes props feel big"},
    "product": {"dir": (1.0, -1.0, 0.6), "dist": 1.0, "lens": 65, "dof": True, "fstop": 4.0, "note": "eye-level three-quarter, slight telephoto - catalogue shot"},
    "front": {"dir": (0.0, -1.0, 0.12), "dist": 1.0, "lens": 50, "dof": False, "fstop": 5.6, "note": "orthographic-feeling front elevation"},
    "side": {"dir": (1.0, 0.0, 0.12), "dist": 1.0, "lens": 50, "dof": False, "fstop": 5.6, "note": "side elevation"},
    "back": {"dir": (0.0, 1.0, 0.12), "dist": 1.0, "lens": 50, "dof": False, "fstop": 5.6, "note": "back elevation"},
    "top": {"dir": (0.0, -0.0001, 1.0), "dist": 1.0, "lens": 50, "dof": False, "fstop": 5.6, "note": "plan view"},
    "closeup": {"dir": (0.6, -1.0, 0.35), "dist": 0.55, "lens": 85, "dof": True, "fstop": 2.0, "note": "detail / material read - shallow focus"},
    "wide": {"dir": (1.0, -1.0, 0.45), "dist": 1.6, "lens": 28, "dof": False, "fstop": 8.0, "note": "environment / building context"},
    "iso": {"dir": (1.0, -1.0, 0.82), "dist": 1.15, "lens": 50, "dof": False, "fstop": 8.0, "note": "isometric-style overview"},
}


def frame_distance(cam_data, radius, aspect, margin):
    """Distance so the bounding sphere fits the narrower field of view."""
    try:
        fov = float(cam_data.angle)
    except Exception:
        fov = math.radians(39.6)
    aspect = max(0.2, fnum(aspect, 1.0))
    # sensor fit AUTO: cam.angle spans the LARGER image side; the other side is narrower
    if aspect >= 1.0:
        other = 2.0 * math.atan(math.tan(fov / 2.0) / aspect)
    else:
        other = 2.0 * math.atan(math.tan(fov / 2.0) * aspect)
    fov_eff = min(fov, other)
    return radius / math.sin(max(0.05, fov_eff / 2.0)) * max(1.0, fnum(margin, 1.15))


def place_camera(cam, cam_data, b, preset, lens, aspect, margin):
    p = CAMERA_PRESETS[preset]
    cam_data.lens = fnum(lens, p["lens"])
    try:
        cam_data.sensor_fit = "AUTO"
        cam_data.clip_start = max(0.001, b["radius"] * 0.01)
        cam_data.clip_end = max(100.0, b["radius"] * 60.0)
    except Exception:
        pass
    dist = frame_distance(cam_data, b["radius"], aspect, margin) * p["dist"]
    d = Vector(p["dir"]).normalized()
    cam.location = b["centre"] + d * dist
    aim(cam, b["centre"])
    return dist


def build_camera_rig(preset, target, lens, dof, fstop, aspect, name, turntable, frames, margin):
    if preset not in CAMERA_PRESETS:
        return {"ok": False, "error": "unknown camera preset '%s'" % preset, "error_class": "invalid_enum", "allowed": sorted(CAMERA_PRESETS.keys())}
    b = target_bounds(target)
    if b is None:
        return {"ok": False, "error": "no mesh objects found for target '%s'" % (target or "scene"), "error_class": "resource_missing", "fix": "Build / import the asset first or pass target: an asset, object or collection name."}
    coll = get_collection(STUDIO)
    cam_name = str(name or (STUDIO + "_Cam"))
    sc = scene()
    rx, ry = sc.render.resolution_x, sc.render.resolution_y
    if aspect is None:
        aspect = (rx / float(ry)) if ry else 1.0
    cam = bpy.data.objects.get(cam_name)
    if cam is not None and cam.type != "CAMERA":
        cam_name = STUDIO + "_Cam"
        cam = bpy.data.objects.get(cam_name)
    if cam is None:
        cam_data = bpy.data.cameras.new(cam_name)
        cam = bpy.data.objects.new(cam_name, cam_data)
        link(cam, coll)
    cam_data = cam.data
    cam["total_studio"] = "camera"
    cam.parent = None
    dist = place_camera(cam, cam_data, b, preset, lens, aspect, margin)
    p = CAMERA_PRESETS[preset]
    use_dof = p["dof"] if dof is None else fbool(dof)
    try:
        cam_data.dof.use_dof = use_dof
        cam_data.dof.focus_distance = dist
        cam_data.dof.aperture_fstop = fnum(fstop, p["fstop"])
    except Exception:
        use_dof = False
    sc.camera = cam
    info = {"ok": True, "preset": preset, "camera": cam.name, "target": b["label"], "target_dims_m": b["dims"], "distance_m": round(dist, 3), "lens_mm": cam_data.lens, "dof": use_dof, "fstop": fnum(fstop, p["fstop"]) if use_dof else None, "aspect": round(float(aspect), 3), "location": [round(v, 3) for v in cam.location], "note": p["note"]}
    clear_kind("pivot")
    if fbool(turntable):
        n = int(max(8, min(720, fnum(frames, 48))))
        pivot = bpy.data.objects.new(STUDIO + "_Pivot", None)
        pivot.empty_display_type = "PLAIN_AXES"
        pivot.location = b["centre"]
        pivot["total_studio"] = "pivot"
        link(pivot, coll)
        # parent the camera without moving it (parent inverse = pivot world inverse)
        cam.parent = pivot
        try:
            cam.matrix_parent_inverse = pivot.matrix_world.inverted()
        except Exception:
            pass
        pivot.rotation_euler = Euler((0.0, 0.0, 0.0), "XYZ")
        pivot.keyframe_insert(data_path="rotation_euler", frame=1)
        pivot.rotation_euler = Euler((0.0, 0.0, math.pi * 2.0), "XYZ")
        pivot.keyframe_insert(data_path="rotation_euler", frame=n + 1)
        try:
            for fc in pivot.animation_data.action.fcurves:
                for kp in fc.keyframe_points:
                    kp.interpolation = "LINEAR"
        except Exception:
            pass
        sc.frame_start = 1
        sc.frame_end = n
        try:
            sc.frame_set(1)
        except Exception:
            pass
        info.update({"turntable": True, "frames": n, "pivot": pivot.name, "frame_range": [1, n]})
    else:
        info["turntable"] = False
    return info


# ─────────────────────────── render settings ────────────────────────────────

QUALITY = {
    "preview": {"cycles": 64, "eevee": 16, "pct": 50, "denoise": True},
    "standard": {"cycles": 256, "eevee": 64, "pct": 100, "denoise": True},
    "final": {"cycles": 1024, "eevee": 128, "pct": 100, "denoise": True},
}


def engine_ids():
    sc = scene()
    try:
        return set(getattr(it, "identifier", str(it)) for it in sc.render.bl_rna.properties["engine"].enum_items)
    except Exception:
        return set()


def resolve_engine(word):
    """eevee / cycles / workbench (or a raw identifier) -> the identifier this Blender has."""
    ids = engine_ids()
    w = str(word or "").strip()
    low = w.lower()
    if low in ("eevee", "blender_eevee", "blender_eevee_next", "eevee_next"):
        for cand in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            if cand in ids or not ids:
                return cand
    if low in ("cycles",):
        return "CYCLES"
    if low in ("workbench", "blender_workbench"):
        return "BLENDER_WORKBENCH"
    if w in ids:
        return w
    return None


def engine_settings(engine):
    sc = scene()
    if engine == "CYCLES":
        return getattr(sc, "cycles", None), "cycles"
    if engine.startswith("BLENDER_EEVEE"):
        return (getattr(sc, "eevee", None) or getattr(sc, "eevee_next", None)), "eevee"
    return None, "workbench"


def apply_render_setup(a):
    sc = scene()
    ids = engine_ids()
    info = {"ok": True}
    if a.get("engine") is not None:
        engine = resolve_engine(a.get("engine"))
        if engine is None or (ids and engine not in ids):
            return {"ok": False, "error": "unsupported render engine '%s'" % a.get("engine"), "error_class": "invalid_enum", "allowed": ["eevee", "cycles", "workbench"] + sorted(ids), "fix": "Use eevee | cycles | workbench - TotalScript maps the version-specific identifier."}
        sc.render.engine = engine
    engine = sc.render.engine
    settings, family = engine_settings(engine)
    quality = str(a.get("quality") or "").lower()
    if quality:
        q = QUALITY.get(quality)
        if q is None:
            return {"ok": False, "error": "unknown quality '%s'" % quality, "error_class": "invalid_enum", "allowed": sorted(QUALITY.keys())}
        samples = int(fnum(a.get("samples"), q[family] if family in q else 0))
        sc.render.resolution_percentage = q["pct"]
        denoise = fbool(a.get("denoise"), q["denoise"])
    else:
        samples = int(fnum(a.get("samples"), 0))
        denoise = a.get("denoise")
    if settings is not None:
        if samples > 0:
            if family == "cycles":
                settings.samples = samples
                try:
                    settings.use_adaptive_sampling = True
                except Exception:
                    pass
            else:
                try:
                    settings.taa_render_samples = samples
                except Exception:
                    pass
        if denoise is not None and family == "cycles":
            try:
                settings.use_denoising = fbool(denoise)
            except Exception:
                pass
        if family == "eevee":
            for attr, val in (("use_gtao", True), ("use_shadows", True), ("use_raytracing", True), ("use_soft_shadows", True)):
                try:
                    setattr(settings, attr, val)
                except Exception:
                    pass
    info.update({"engine": engine, "engine_family": family, "samples": samples or None, "denoise": fbool(denoise) if denoise is not None else None, "quality": quality or None})
    w = int(fnum(a.get("width"), 0))
    h = int(fnum(a.get("height"), 0))
    if w > 0:
        sc.render.resolution_x = max(16, min(8192, w))
    if h > 0:
        sc.render.resolution_y = max(16, min(8192, h))
    if a.get("transparent") is not None:
        try:
            sc.render.film_transparent = fbool(a.get("transparent"))
        except Exception:
            pass
    vt = a.get("view_transform")
    if vt is not None:
        try:
            vs = sc.view_settings
            want = str(vt)
            avail = set()
            try:
                avail = set(getattr(it, "identifier", str(it)) for it in vs.bl_rna.properties["view_transform"].enum_items)
            except Exception:
                pass
            alias = {"agx": "AgX", "filmic": "Filmic", "standard": "Standard", "khronos": "Khronos PBR Neutral"}
            want = alias.get(want.lower(), want)
            if avail and want not in avail:
                want = "AgX" if "AgX" in avail else ("Filmic" if "Filmic" in avail else "Standard")
            vs.view_transform = want
            info["view_transform"] = want
        except Exception:
            pass
    if a.get("exposure") is not None:
        try:
            sc.view_settings.exposure = fnum(a.get("exposure"), 0.0)
            info["exposure"] = fnum(a.get("exposure"), 0.0)
        except Exception:
            pass
    fmt = a.get("format")
    if fmt is not None:
        f = str(fmt).upper()
        allowed = {"PNG": "PNG", "JPEG": "JPEG", "JPG": "JPEG", "EXR": "OPEN_EXR", "OPEN_EXR": "OPEN_EXR", "WEBP": "WEBP"}
        if f not in allowed:
            return {"ok": False, "error": "unsupported image format '%s'" % fmt, "error_class": "invalid_enum", "allowed": sorted(allowed.keys())}
        sc.render.image_settings.file_format = allowed[f]
        try:
            sc.render.image_settings.color_mode = "RGBA" if allowed[f] in ("PNG", "OPEN_EXR", "WEBP") and getattr(sc.render, "film_transparent", False) else "RGB"
        except Exception:
            pass
        info["format"] = allowed[f]
    if a.get("fps") is not None:
        try:
            sc.render.fps = int(max(1, min(240, fnum(a.get("fps"), 24))))
            info["fps"] = sc.render.fps
        except Exception:
            pass
    if a.get("output"):
        sc.render.filepath = str(a.get("output"))
    info.update({"resolution": [sc.render.resolution_x, sc.render.resolution_y], "resolution_percentage": sc.render.resolution_percentage, "transparent": bool(getattr(sc.render, "film_transparent", False)), "output": sc.render.filepath, "blender": blender_version()})
    try:
        sc["total_render_setup"] = json.dumps({k: v for k, v in info.items() if k != "ok"})
    except Exception:
        pass
    return info


# ─────────────────────────── renders ────────────────────────────────────────

def render_still(path):
    sc = scene()
    sc.render.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    dt = time.time() - t0
    ok = os.path.exists(path) and os.path.getsize(path) > 0
    return {"path": path, "ok": ok, "bytes": os.path.getsize(path) if ok else 0, "seconds": round(dt, 2)}


def do_render_shot(a):
    sc = scene()
    folder = str(a.get("path") or "")
    if folder and not os.path.isdir(folder):
        try:
            os.makedirs(folder, exist_ok=True)
        except Exception:
            folder = ""
    if not folder:
        folder = workspace_dir()
    size = a.get("size")
    saved = {"x": sc.render.resolution_x, "y": sc.render.resolution_y, "fp": sc.render.filepath, "cam": sc.camera, "fmt": sc.render.image_settings.file_format}
    if size:
        s = int(max(128, min(4096, fnum(size, 960))))
        aspect = saved["x"] / float(saved["y"]) if saved["y"] else 1.0
        sc.render.resolution_x = s
        sc.render.resolution_y = int(max(16, round(s / aspect)))
    sc.render.image_settings.file_format = "PNG"
    used_res = [sc.render.resolution_x, sc.render.resolution_y]
    views = a.get("views")
    renders = []
    tag = str(a.get("target") or "scene").replace(" ", "_")
    try:
        if views:
            if not isinstance(views, list):
                views = [str(views)]
            bad = [v for v in views if str(v) not in CAMERA_PRESETS]
            if bad:
                return {"ok": False, "error": "unknown view(s) %s" % ", ".join(str(v) for v in bad), "error_class": "invalid_enum", "allowed": sorted(CAMERA_PRESETS.keys())}
            for v in [str(v) for v in views][:7]:
                r = build_camera_rig(v, a.get("target"), a.get("lens"), a.get("dof"), a.get("fstop"), None, a.get("camera") or None, False, None, a.get("margin"))
                if not r.get("ok"):
                    return r
                item = render_still(os.path.join(folder, "total_shot_%s_%s.png" % (tag, v)))
                item["view"] = v
                item["camera"] = r["camera"]
                renders.append(item)
        else:
            cam = None
            if a.get("camera"):
                cam = bpy.data.objects.get(str(a.get("camera")))
                if cam is None or cam.type != "CAMERA":
                    return {"ok": False, "error": "camera '%s' not found" % a.get("camera"), "error_class": "resource_missing", "allowed": [o.name for o in bpy.data.objects if o.type == "CAMERA"]}
                sc.camera = cam
            if sc.camera is None:
                return {"ok": False, "error": "no scene camera - run blender_camera_rig {preset} first or pass views:[...]", "error_class": "resource_missing"}
            item = render_still(os.path.join(folder, "total_shot_%s.png" % tag))
            item["camera"] = sc.camera.name
            renders.append(item)
    except Exception as e:
        return {"ok": False, "error": "render failed: %s" % e, "error_class": "runtime", "traceback": traceback.format_exc()[-1200:], "renders": renders}
    finally:
        sc.render.resolution_x = saved["x"]
        sc.render.resolution_y = saved["y"]
        sc.render.filepath = saved["fp"]
        sc.render.image_settings.file_format = saved["fmt"]
        if views and saved["cam"] is not None and bpy.data.objects.get(saved["cam"].name) is not None:
            sc.camera = saved["cam"]
    good = [r for r in renders if r["ok"]]
    return {"ok": bool(good), "renders": renders, "render_files": [r["path"] for r in good], "engine": sc.render.engine, "resolution": used_res, "seconds": round(sum(r["seconds"] for r in renders), 2), "note": "Rendered with the current engine / quality (blender_render_setup) and world (blender_world_setup); the PNGs are attached. Nothing is uploaded."}


def do_turntable(a):
    sc = scene()
    n = int(max(8, min(720, fnum(a.get("frames"), 48))))
    pivot = studio_objects("pivot")
    if not pivot or sc.camera is None or sc.camera.parent is None or sc.camera.parent.get("total_studio") != "pivot":
        r = build_camera_rig(str(a.get("preset") or "product"), a.get("target"), a.get("lens"), a.get("dof"), a.get("fstop"), None, None, True, n, a.get("margin"))
        if not r.get("ok"):
            return r
    folder = str(a.get("path") or "")
    if not folder:
        folder = os.path.join(workspace_dir(), "total_turntable")
    os.makedirs(folder, exist_ok=True)
    fmt = str(a.get("format") or "png").lower()
    if fmt not in ("png", "mp4"):
        return {"ok": False, "error": "format must be png | mp4", "error_class": "invalid_enum", "allowed": ["png", "mp4"]}
    saved = {"x": sc.render.resolution_x, "y": sc.render.resolution_y, "fp": sc.render.filepath, "fmt": sc.render.image_settings.file_format}
    # the frame range stays 1..n afterwards on purpose: the turntable is scrubbable in the timeline
    size = a.get("size")
    if size:
        s = int(max(128, min(2048, fnum(size, 640))))
        aspect = saved["x"] / float(saved["y"]) if saved["y"] else 1.0
        sc.render.resolution_x = s
        sc.render.resolution_y = int(max(16, round(s / aspect)))
    if a.get("fps") is not None:
        try:
            sc.render.fps = int(max(1, min(120, fnum(a.get("fps"), 24))))
        except Exception:
            pass
    sc.frame_start = 1
    sc.frame_end = n
    out = {"ok": False, "frames": n, "folder": folder, "format": fmt}
    t0 = time.time()
    try:
        stills = []
        for k in range(4):
            fr = 1 + (n * k) // 4
            try:
                sc.frame_set(fr)
            except Exception:
                pass
            sc.render.image_settings.file_format = "PNG"
            stills.append(render_still(os.path.join(folder, "total_turntable_still_%02d.png" % k)))
        try:
            sc.frame_set(1)
        except Exception:
            pass
        if fmt == "png":
            sc.render.image_settings.file_format = "PNG"
            sc.render.filepath = os.path.join(folder, "frame_")
            bpy.ops.render.render(animation=True)
            files = sorted(f for f in os.listdir(folder) if f.startswith("frame_") and f.lower().endswith(".png"))
            out.update({"ok": len(files) >= max(1, n // 2), "frame_files": len(files), "first_frame": os.path.join(folder, files[0]) if files else None})
        else:
            sc.render.image_settings.file_format = "FFMPEG"
            try:
                sc.render.ffmpeg.format = "MPEG4"
                sc.render.ffmpeg.codec = "H264"
                sc.render.ffmpeg.constant_rate_factor = "MEDIUM"
                sc.render.ffmpeg.ffmpeg_preset = "GOOD"
            except Exception as e:
                return dict(out, error="this Blender build has no FFmpeg video output (%s) - use format: png" % e, error_class="api_version")
            sc.render.filepath = os.path.join(folder, "turntable_")
            bpy.ops.render.render(animation=True)
            vids = sorted((f for f in os.listdir(folder) if f.startswith("turntable_") and f.lower().endswith((".mp4", ".mkv", ".mov"))), key=lambda f: os.path.getmtime(os.path.join(folder, f)))
            video = os.path.join(folder, vids[-1]) if vids else None
            out.update({"ok": bool(video) and os.path.getsize(video) > 0, "video": video})
        out["stills"] = stills
        out["render_files"] = [s["path"] for s in stills if s["ok"]]
    except Exception as e:
        out.update({"error": "turntable render failed: %s" % e, "error_class": "runtime", "traceback": traceback.format_exc()[-1200:]})
    finally:
        sc.render.resolution_x = saved["x"]
        sc.render.resolution_y = saved["y"]
        sc.render.filepath = saved["fp"]
        sc.render.image_settings.file_format = saved["fmt"]
    out["seconds"] = round(time.time() - t0, 2)
    out["fps"] = getattr(sc.render, "fps", None)
    out["engine"] = sc.render.engine
    out["note"] = "Four quarter-turn stills are attached; the full sequence / video is a local file in the folder above (nothing is uploaded). Frame range stays 1..%d for re-renders." % n
    return out


def do_clear():
    coll = bpy.data.collections.get(STUDIO)
    removed = []
    if coll is None:
        return {"ok": True, "removed": [], "note": "no %s rig in the scene" % STUDIO}
    sc = scene()
    for o in list(coll.all_objects) if hasattr(coll, "all_objects") else list(coll.objects):
        if sc.camera is o:
            sc.camera = None
        removed.append(o.name)
        remove_object(o)
    try:
        bpy.data.collections.remove(coll)
    except Exception:
        pass
    others = [o for o in bpy.data.objects if o.type == "CAMERA"]
    if sc.camera is None and others:
        sc.camera = others[0]
    return {"ok": True, "removed": removed, "scene_camera": sc.camera.name if sc.camera else None}


# ─────────────────────────── dispatch ───────────────────────────────────────

def main():
    cmd = CMD.strip().split("/")[-1]
    if cmd.startswith("blender_"):
        cmd = cmd[len("blender_"):]
    a = ARGS
    try:
        if cmd == "light_rig":
            r = build_light_rig(str(a.get("preset") or "three_point"), a.get("target"), max(0.05, fnum(a.get("strength"), 1.0)), a.get("warmth"), a.get("backdrop"))
            return emit(r)
        if cmd == "camera_rig":
            return emit(build_camera_rig(str(a.get("preset") or "product"), a.get("target"), a.get("lens"), a.get("dof"), a.get("fstop"), a.get("aspect"), a.get("name"), a.get("turntable"), a.get("frames"), a.get("margin")))
        if cmd == "world_setup":
            return emit(apply_world(a.get("preset") or "studio_grey", a.get("strength") if a.get("strength") is not None else 1.0, a.get("color"), a.get("sun_elevation"), a.get("sun_rotation"), a.get("hdri")))
        if cmd == "render_setup":
            return emit(apply_render_setup(a))
        if cmd == "render_shot":
            return emit(do_render_shot(a))
        if cmd == "turntable":
            return emit(do_turntable(a))
        if cmd == "studio_clear":
            return emit(do_clear())
        return emit({"ok": False, "error": "unknown studio command '%s' (light_rig, camera_rig, world_setup, render_setup, render_shot, turntable, studio_clear)" % cmd})
    except Exception as e:
        return emit(classify_exception(e, CMD))


main()
