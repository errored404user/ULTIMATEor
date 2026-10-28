"""bpy stand-in for tools/blender_asset.py + the blender_ops.py dump (tests only).
MOCK, not Blender. Real enough to exercise: data-blocks, objects with
transforms / parents / custom props / modifiers, meshes with polygons, loop
triangles, UV layers and materials, Principled node trees, collections, the
scene render settings, and the operators the scripts call. Boolean / decimate /
bevel modifiers are RECORDED, never computed (applying a stack copies the mesh).
Exports and renders write small files with the right header so file checks run."""
import math
import os
from mathutils import Vector, Matrix, Euler


# ───────────────────────── data-blocks ─────────────────────────
class _Props(dict):
    pass


class _IDBlock:
    def __init__(self, name):
        self.name = name
        self._props = {}
        self.users = 1

    def __getitem__(self, k):
        return self._props[k]

    def __setitem__(self, k, v):
        self._props[k] = v

    def get(self, k, d=None):
        return self._props.get(k, d)

    def keys(self):
        return list(self._props.keys())


class _Vertex:
    def __init__(self, co, i):
        self.co = Vector(co)
        self.index = i
        self.normal = Vector((0, 0, 1))


class _Loop:
    def __init__(self, vi, i):
        self.vertex_index = vi
        self.index = i
        self.normal = Vector((0, 0, 1))


class _Polygon:
    def __init__(self, verts, loop_start, smooth, mat, mesh):
        self.vertices = list(verts)
        self.loop_start = loop_start
        self.loop_indices = list(range(loop_start, loop_start + len(verts)))
        self.use_smooth = smooth
        self.material_index = mat
        self._mesh = mesh

    @property
    def normal(self):
        vs = [self._mesh.vertices[i].co for i in self.vertices]
        n = Vector((0, 0, 0))
        for i in range(1, len(vs) - 1):
            n += (vs[i] - vs[0]).cross(vs[i + 1] - vs[0])
        return n.normalized() if n.length > 1e-12 else Vector((0, 0, 1))


class _LoopTri:
    def __init__(self, verts, loops, mat, normal):
        self.vertices = tuple(verts)
        self.loops = tuple(loops)
        self.material_index = mat
        self.split_normals = (normal, normal, normal)


class _UV:
    def __init__(self):
        self.uv = Vector((0, 0, 0))


class _UVLayer:
    def __init__(self, name, n):
        self.name = name
        self.data = [_UV() for _ in range(n)]


class _UVLayers(list):
    def __init__(self, mesh):
        super().__init__()
        self.mesh = mesh

    def new(self, name="UVMap"):
        l = _UVLayer(name, len(self.mesh.loops))
        self.append(l)
        return l

    def get(self, name):
        for l in self:
            if l.name == name:
                return l
        return None

    @property
    def active(self):
        return self[0] if self else None


class Mesh(_IDBlock):
    def __init__(self, name):
        super().__init__(name)
        self.vertices = []
        self.polygons = []
        self.loops = []
        self.loop_triangles = []
        self.materials = _MatList()
        self.uv_layers = _UVLayers(self)
        self.applied_modifiers = []
        self.use_auto_smooth = False
        self.auto_smooth_angle = 0.0

    def set_geometry(self, verts, faces, smooth=None, mats=None):
        self.vertices = [_Vertex(v, i) for i, v in enumerate(verts)]
        self.loops = []
        self.polygons = []
        for fi, f in enumerate(faces):
            start = len(self.loops)
            for vi in f:
                self.loops.append(_Loop(vi, len(self.loops)))
            self.polygons.append(_Polygon(f, start, bool(smooth[fi]) if smooth else False, int(mats[fi]) if mats else 0, self))
        self.uv_layers = _UVLayers(self)
        self.loop_triangles = []

    def calc_loop_triangles(self):
        out = []
        for p in self.polygons:
            ids = p.vertices
            n = p.normal
            for i in range(1, len(ids) - 1):
                out.append(_LoopTri((ids[0], ids[i], ids[i + 1]), (p.loop_indices[0], p.loop_indices[i], p.loop_indices[i + 1]), p.material_index, n))
        self.loop_triangles = out

    def copy_from(self, other):
        self.set_geometry([tuple(v.co) for v in other.vertices], [p.vertices for p in other.polygons], [p.use_smooth for p in other.polygons], [p.material_index for p in other.polygons])
        for m in other.materials:
            self.materials.append(m)
        if other.uv_layers:
            l = self.uv_layers.new(other.uv_layers[0].name)
            for a, b in zip(l.data, other.uv_layers[0].data):
                a.uv = b.uv
        self.applied_modifiers = list(other.applied_modifiers)


class _MatList(list):
    def append(self, m):
        list.append(self, m)


class _Input:
    def __init__(self, v):
        self.default_value = v


class _Socket:
    pass


class _Node:
    def __init__(self, ntype):
        self.type = {"ShaderNodeBsdfPrincipled": "BSDF_PRINCIPLED", "ShaderNodeOutputMaterial": "OUTPUT_MATERIAL", "ShaderNodeTexNoise": "TEX_NOISE", "ShaderNodeValToRGB": "VALTORGB", "ShaderNodeMixRGB": "MIX_RGB", "ShaderNodeTexImage": "TEX_IMAGE"}.get(ntype, ntype)
        self.name = ntype
        self.image = None
        self.inputs = _Inputs()
        self.outputs = {0: _Socket(), "Fac": _Socket(), "Color": _Socket(), "BSDF": _Socket()}
        if self.type == "BSDF_PRINCIPLED":
            for k, v in (("Base Color", (0.8, 0.8, 0.8, 1.0)), ("Metallic", 0.0), ("Roughness", 0.5), ("Alpha", 1.0), ("Emission Color", (0.0, 0.0, 0.0, 1.0)), ("Emission Strength", 0.0)):
                self.inputs[k] = _Input(v)
        if self.type == "TEX_NOISE":
            self.inputs["Scale"] = _Input(5.0)
        if self.type == "MIX_RGB":
            self.inputs["Fac"] = _Input(0.5)
            self.inputs["Color1"] = _Input((0, 0, 0, 1))
            self.inputs["Color2"] = _Input((0, 0, 0, 1))
            self.blend_type = "MIX"
        if self.type == "VALTORGB":
            class _E:
                def __init__(self):
                    self.position = 0.0

            class _R:
                elements = [_E(), _E()]
            self.color_ramp = _R()


class _Inputs(dict):
    def get(self, k, d=None):
        return dict.get(self, k, d)


class _Nodes(list):
    def new(self, ntype):
        n = _Node(ntype)
        self.append(n)
        return n


class _Links:
    def __init__(self):
        self.count = 0

    def new(self, a, b):
        self.count += 1


class _Tree:
    def __init__(self):
        self.nodes = _Nodes()
        self.links = _Links()


class Material(_IDBlock):
    def __init__(self, name):
        super().__init__(name)
        self._use_nodes = False
        self.node_tree = None
        self.diffuse_color = (0.8, 0.8, 0.8, 1.0)
        self.metallic = 0.0
        self.roughness = 0.5
        self.blend_method = "OPAQUE"

    @property
    def use_nodes(self):
        return self._use_nodes

    @use_nodes.setter
    def use_nodes(self, v):
        self._use_nodes = bool(v)
        if v and self.node_tree is None:
            self.node_tree = _Tree()
            self.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
            self.node_tree.nodes.new("ShaderNodeOutputMaterial")


class _Modifier:
    def __init__(self, name, mtype):
        self.name = name
        self.type = mtype
        self.object = None
        self.operation = "DIFFERENCE"
        self.solver = "EXACT"
        self.use_self = False
        self.ratio = 1.0
        self.width = 0.0
        self.segments = 1
        self.limit_method = "NONE"
        self.angle_limit = 0.0
        self.harden_normals = False
        self.miter_outer = "MITER_SHARP"
        self.use_axis = [False, False, False]
        self.use_clip = False
        self.mirror_object = None
        self.count = 1
        self.use_relative_offset = True
        self.use_constant_offset = False
        self.constant_offset_displace = (0, 0, 0)
        self.levels = 0
        self.render_levels = 0
        self.keep_sharp = False
        self.show_viewport = True
        self.show_render = True
        self._frozen = True

    def __setattr__(self, key, value):
        if getattr(self, "_frozen", False) and not key.startswith("_"):
            if key not in self.__dict__:
                raise AttributeError("'%sModifier' object has no attribute '%s'" % (self.type.title().replace("_", ""), key))
            allowed = _MOD_ENUMS.get(key)
            if allowed and value not in allowed:
                raise TypeError('bpy_struct: item.attr = val: enum "%s" not found in (%s)' % (value, ", ".join("'" + a + "'" for a in allowed)))
        object.__setattr__(self, key, value)


# Blender's real modifier enum (subset) - modifiers.new() with anything else raises
# the exact TypeError text bpy produces, so the error classifier can be tested.
MODIFIER_TYPES = ("SUBSURF", "BEVEL", "SOLIDIFY", "MIRROR", "ARRAY", "BOOLEAN", "DECIMATE", "TRIANGULATE", "REMESH", "WELD", "DISPLACE", "WEIGHTED_NORMAL", "EDGE_SPLIT", "SHRINKWRAP", "SIMPLE_DEFORM", "WIREFRAME", "SCREW", "SKIN", "SMOOTH", "CAST", "CURVE", "LATTICE", "HOOK", "ARMATURE")
_MOD_ENUMS = {"limit_method": ("NONE", "ANGLE", "WEIGHT", "VGROUP"), "operation": ("INTERSECT", "UNION", "DIFFERENCE"), "solver": ("FAST", "EXACT"), "miter_outer": ("MITER_SHARP", "MITER_PATCH", "MITER_ARC")}


class _Modifiers(list):
    def new(self, name, type):
        if type not in MODIFIER_TYPES:
            raise TypeError('ObjectModifiers.new(): error with argument 2, "type" -  enum "%s" not found in (%s)' % (type, ", ".join("'" + t + "'" for t in MODIFIER_TYPES)))
        m = _Modifier(name, type)
        self.append(m)
        return m

    def get(self, name):
        for m in self:
            if m.name == name:
                return m
        return None

    def remove(self, m):
        list.remove(self, m)


class _Slot:
    def __init__(self, m):
        self.material = m


class Object(_IDBlock):
    def __init__(self, name, data):
        super().__init__(name)
        self.data = data
        self.type = "MESH" if isinstance(data, Mesh) else ("CAMERA" if isinstance(data, Camera) else ("LIGHT" if isinstance(data, Light) else "EMPTY"))
        self.location = Vector((0, 0, 0))
        self.rotation_euler = Euler((0, 0, 0))
        self.scale = Vector((1, 1, 1))
        self.parent = None
        self.matrix_parent_inverse = Matrix.Identity(4)
        self.modifiers = _Modifiers()
        self.hide_render = False
        self.display_type = "TEXTURED"
        self.empty_display_type = "PLAIN_AXES"
        self.empty_display_size = 1.0
        self._selected = False
        self.users_collection = []
        self.active_material = None
        self.mode = "OBJECT"

    @property
    def material_slots(self):
        return [_Slot(m) for m in (self.data.materials if isinstance(self.data, Mesh) else [])]

    @property
    def children(self):
        return [o for o in data.objects if o.parent is self]

    @property
    def children_recursive(self):
        out = []
        for c in self.children:
            out.append(c)
            out += c.children_recursive
        return out

    @property
    def matrix_local(self):
        rot = self.rotation_euler.to_matrix().to_4x4()
        sc = Matrix.Identity(4)
        for i in range(3):
            sc.rows[i][i] = self.scale[i]
        return Matrix.Translation(self.location) @ rot @ sc

    @property
    def matrix_world(self):
        m = self.matrix_local
        if self.parent is not None:
            return self.parent.matrix_world @ self.matrix_parent_inverse @ m
        return m

    @matrix_world.setter
    def matrix_world(self, m):
        self.location = m.translation
        # rotation is not decomposed by the mock (cutters are deleted anyway)

    @property
    def bound_box(self):
        if not isinstance(self.data, Mesh) or not self.data.vertices:
            return [(0, 0, 0)] * 8
        xs = [v.co.x for v in self.data.vertices]
        ys = [v.co.y for v in self.data.vertices]
        zs = [v.co.z for v in self.data.vertices]
        return [(x, y, z) for x in (min(xs), max(xs)) for y in (min(ys), max(ys)) for z in (min(zs), max(zs))]

    def evaluated_get(self, dg):
        return self

    def to_mesh(self):
        return self.data

    def to_mesh_clear(self):
        pass

    def select_set(self, v):
        self._selected = bool(v)


class Camera(_IDBlock):
    def __init__(self, name):
        super().__init__(name)
        self.lens = 50
        self.angle = math.radians(39.6)


class Light(_IDBlock):
    def __init__(self, name, ltype):
        super().__init__(name)
        self.type = ltype
        self.energy = 10
        self.size = 1


class _CollObjects(list):
    def link(self, o):
        if o not in self:
            self.append(o)
            o.users_collection.append(self._coll)

    def unlink(self, o):
        if o in self:
            self.remove(o)
            if self._coll in o.users_collection:
                o.users_collection.remove(self._coll)


class _CollChildren(list):
    def link(self, c):
        if c not in self:
            self.append(c)


class Collection(_IDBlock):
    def __init__(self, name):
        super().__init__(name)
        self.objects = _CollObjects()
        self.objects._coll = self
        self.children = _CollChildren()
        self.hide_render = False

    @property
    def all_objects(self):
        out = list(self.objects)
        for c in self.children:
            out += c.all_objects
        return out


class _Blocks(list):
    def __init__(self, factory, kind):
        super().__init__()
        self.factory = factory
        self.kind = kind

    def new(self, name, *args, **kw):
        base = name
        n = 1
        while self.get(name) is not None:
            name = "%s.%03d" % (base, n)
            n += 1
        b = self.factory(name, *args)
        self.append(b)
        return b

    def get(self, name):
        for b in self:
            if b.name == name:
                return b
        return None

    def remove(self, b, do_unlink=True):
        if b in self:
            self.remove_block(b)

    def remove_block(self, b):
        list.remove(self, b)
        if self.kind == "objects":
            for c in list(b.users_collection):
                c.objects.unlink(b)
            for o in list(self):
                if o.parent is b:
                    o.parent = None

    def new_from_object(self, ev, preserve_all_data_layers=False, depsgraph=None):
        me = self.new(ev.data.name + "_eval")
        me.copy_from(ev.data)
        me.applied_modifiers += [m.type for m in ev.modifiers]
        return me


class _Data:
    def __init__(self):
        self.objects = _Blocks(Object, "objects")
        self.meshes = _Blocks(Mesh, "meshes")
        self.materials = _Blocks(Material, "materials")
        self.collections = _Blocks(Collection, "collections")
        self.cameras = _Blocks(Camera, "cameras")
        self.lights = _Blocks(Light, "lights")


data = _Data()


# ───────────────────────── scene / context ─────────────────────────
class _EnumItem:
    def __init__(self, i):
        self.identifier = i


class _Render:
    def __init__(self):
        self.engine = "BLENDER_EEVEE_NEXT"
        self.resolution_x = 1920
        self.resolution_y = 1080
        self.resolution_percentage = 100
        self.filepath = "/tmp/render"
        self.film_transparent = False

        class _IS:
            file_format = "PNG"
        self.image_settings = _IS()

        class _P:
            enum_items = [_EnumItem("BLENDER_WORKBENCH"), _EnumItem("BLENDER_EEVEE_NEXT"), _EnumItem("CYCLES")]

        class _RNA:
            properties = {"engine": _P()}
        self.bl_rna = _RNA()


class _Shading:
    light = "STUDIO"
    color_type = "MATERIAL"
    show_cavity = False
    show_shadows = False


class _Display:
    shading = _Shading()


class Scene(_IDBlock):
    def __init__(self, name):
        super().__init__(name)
        self.collection = Collection("Scene Collection")
        self.camera = None
        self.render = _Render()
        self.display = _Display()


scene_block = Scene("Scene")


class _VLObjects:
    active = None

    def __iter__(self):
        return iter(list(data.objects))


class _ViewLayer:
    objects = _VLObjects()

    def update(self):
        pass


class _Context:
    scene = scene_block
    view_layer = _ViewLayer()

    @property
    def selected_objects(self):
        return [o for o in data.objects if o._selected]

    def evaluated_depsgraph_get(self):
        return None

    def temp_override(self, **kw):
        import contextlib
        return contextlib.nullcontext()


context = _Context()
LOG = {"renders": [], "exports": [], "ops": []}


# ───────────────────────── operators ─────────────────────────
class _OpResult(set):
    pass


def _finished():
    return _OpResult({"FINISHED"})


class _ObjectOps:
    @staticmethod
    def mode_set(mode="OBJECT", **kw):
        LOG["ops"].append("object.mode_set:" + mode)
        if mode == "EDIT" and os.environ.get("FAKEBPY_NO_EDIT") == "1":
            raise RuntimeError("edit mode unavailable in background")
        return _finished()

    @staticmethod
    def select_all(action="SELECT", **kw):
        for o in data.objects:
            o._selected = action == "SELECT"
        return _finished()

    @staticmethod
    def shade_smooth(**kw):
        return _finished()


class _MeshOps:
    @staticmethod
    def select_all(action="SELECT", **kw):
        return _finished()


class _UVOps:
    @staticmethod
    def smart_project(angle_limit=1.15, island_margin=0.0, **kw):
        o = context.view_layer.objects.active
        if o is not None and isinstance(o.data, Mesh):
            l = o.data.uv_layers.get("UVMap") or o.data.uv_layers.new("UVMap")
            for p in o.data.polygons:
                n = len(p.loop_indices)
                for k, li in enumerate(p.loop_indices):
                    a = 2 * math.pi * k / n
                    l.data[li].uv = Vector((0.5 + 0.4 * math.cos(a), 0.5 + 0.4 * math.sin(a), 0))
        LOG["ops"].append("uv.smart_project")
        return _finished()


class _RenderOps:
    @staticmethod
    def render(write_still=False, **kw):
        fp = scene_block.render.filepath
        if write_still:
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\n" + b"fake-render" * 8)
        LOG["renders"].append({"filepath": fp, "engine": scene_block.render.engine, "res": (scene_block.render.resolution_x, scene_block.render.resolution_y), "camera": scene_block.camera.name if scene_block.camera else None})
        return _finished()


def _write(fp, header, kw):
    if os.environ.get("FAKEBPY_EXPORT_FAIL") == "1":
        raise RuntimeError("export operator failed (simulated)")
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "wb") as f:
        f.write(header + b"\n" + ("\n".join("%s=%s" % (k, v) for k, v in sorted(kw.items()))).encode())
    LOG["exports"].append({"filepath": fp, "settings": dict(kw), "selected": [o.name for o in data.objects if o._selected]})
    return _finished()


class _ExportSceneOps:
    @staticmethod
    def fbx(filepath="", **kw):
        return _write(filepath, b"Kaydara FBX Binary  \x00", kw)

    @staticmethod
    def gltf(filepath="", **kw):
        return _write(filepath, b"glTF", kw)


class _WMOps:
    @staticmethod
    def obj_export(filepath="", **kw):
        return _write(filepath, b"# Blender fake OBJ\no Thing\nv 0 0 0", kw)


class _PrefOps:
    @staticmethod
    def addon_enable(module=""):
        return _finished()


class ops:
    object = _ObjectOps()
    mesh = _MeshOps()
    uv = _UVOps()
    render = _RenderOps()
    export_scene = _ExportSceneOps()
    wm = _WMOps()
    preferences = _PrefOps()


class path:
    @staticmethod
    def abspath(p):
        return os.path.abspath(p)


class types:
    Mesh = Mesh
    Object = Object
    Material = Material


class _App:
    tempdir = "/tmp"


app = _App()
