"""bmesh stand-in with REAL (if simple) geometry so the builder's tri counts,
manifold checks and inset / taper / displace maths run for real. MOCK - not
Blender: booleans (modifiers) are not computed, see bpy.py."""
import math
from mathutils import Vector


class BMVert:
    def __init__(self, co, index):
        self.co = Vector(co)
        self.index = index
        self.normal = Vector((0, 0, 1))
        self.link_edges = []
        self.link_faces = []
        self.select = False


class BMEdge:
    def __init__(self, a, b):
        self.verts = (a, b)
        self.link_faces = []
        self.smooth = True
        self.select = False

    @property
    def is_manifold(self):
        return len(self.link_faces) == 2

    @property
    def is_boundary(self):
        return len(self.link_faces) == 1

    @property
    def is_wire(self):
        return len(self.link_faces) == 0

    @property
    def is_contiguous(self):
        if len(self.link_faces) != 2:
            return False
        a, b = self.link_faces
        va, vb = self.verts
        return _dir(a, va, vb) != _dir(b, va, vb)


def _dir(face, va, vb):
    vs = face.verts
    n = len(vs)
    for i in range(n):
        if vs[i] is va and vs[(i + 1) % n] is vb:
            return 1
        if vs[i] is vb and vs[(i + 1) % n] is va:
            return -1
    return 0


class BMFace:
    def __init__(self, verts, index):
        self.verts = list(verts)
        self.index = index
        self.smooth = False
        self.material_index = 0
        self.select = False
        self.normal = Vector((0, 0, 1))
        self.edges = []

    def calc_area(self):
        a = 0.0
        v0 = self.verts[0].co
        for i in range(1, len(self.verts) - 1):
            a += (self.verts[i].co - v0).cross(self.verts[i + 1].co - v0).length / 2.0
        return a

    def calc_center_median(self):
        c = Vector((0, 0, 0))
        for v in self.verts:
            c += v.co
        return c / len(self.verts)

    def update_normal(self):
        v0 = self.verts[0].co
        n = Vector((0, 0, 0))
        for i in range(1, len(self.verts) - 1):
            n += (self.verts[i].co - v0).cross(self.verts[i + 1].co - v0)
        self.normal = n.normalized() if n.length > 1e-12 else Vector((0, 0, 1))


class _Seq(list):
    def __init__(self, bm, kind):
        super().__init__()
        self.bm = bm
        self.kind = kind

    def new(self, *args):
        if self.kind == "verts":
            v = BMVert(args[0], len(self))
            self.append(v)
            return v
        if self.kind == "faces":
            verts = list(args[0])
            if len(set(id(v) for v in verts)) != len(verts):
                raise ValueError("face with repeated verts")
            for f in self:
                if set(id(v) for v in f.verts) == set(id(v) for v in verts):
                    raise ValueError("face exists")
            f = BMFace(verts, len(self))
            self.append(f)
            n = len(verts)
            for i in range(n):
                a, b = verts[i], verts[(i + 1) % n]
                e = self.bm._edge(a, b)
                e.link_faces.append(f)
                f.edges.append(e)
                a.link_faces.append(f)
            f.update_normal()
            return f
        raise TypeError("cannot create " + self.kind)

    def ensure_lookup_table(self):
        for i, x in enumerate(self):
            x.index = i

    def remove(self, x):
        if self.kind == "faces":
            for e in x.edges:
                if x in e.link_faces:
                    e.link_faces.remove(x)
            for v in x.verts:
                if x in v.link_faces:
                    v.link_faces.remove(x)
        list.remove(self, x)


class BMesh:
    def __init__(self):
        self.verts = _Seq(self, "verts")
        self.edges = _Seq(self, "edges")
        self.faces = _Seq(self, "faces")
        self._emap = {}

    def _edge(self, a, b):
        key = (min(id(a), id(b)), max(id(a), id(b)))
        e = self._emap.get(key)
        if e is None:
            e = BMEdge(a, b)
            self._emap[key] = e
            self.edges.append(e)
            a.link_edges.append(e)
            b.link_edges.append(e)
        return e

    def normal_update(self):
        for f in self.faces:
            f.update_normal()
        for v in self.verts:
            n = Vector((0, 0, 0))
            for f in v.link_faces:
                n += f.normal
            v.normal = n.normalized() if n.length > 1e-12 else Vector((0, 0, 1))

    def from_mesh(self, me):
        vs = [self.verts.new(tuple(v.co)) for v in me.vertices]
        for p in me.polygons:
            try:
                f = self.faces.new([vs[i] for i in p.vertices])
                f.smooth = p.use_smooth
                f.material_index = p.material_index
            except ValueError:
                pass
        self.normal_update()

    def to_mesh(self, me):
        self.normal_update()
        me.set_geometry([tuple(v.co) for v in self.verts], [[self.verts.index(v) if v.index is None else v.index for v in f.verts] for f in self._reindexed()], [f.smooth for f in self.faces], [f.material_index for f in self.faces])

    def _reindexed(self):
        for i, v in enumerate(self.verts):
            v.index = i
        return self.faces

    def free(self):
        pass


def new():
    return BMesh()


class ops:
    @staticmethod
    def create_cube(bm, size=1.0, **kw):
        s = size / 2.0
        c = [bm.verts.new(p) for p in ((-s, -s, -s), (s, -s, -s), (s, s, -s), (-s, s, -s), (-s, -s, s), (s, -s, s), (s, s, s), (-s, s, s))]
        for q in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            bm.faces.new([c[i] for i in q])
        return {"verts": c}

    @staticmethod
    def create_cone(bm, cap_ends=True, cap_tris=False, segments=24, radius1=1.0, radius2=1.0, depth=1.0, **kw):
        h = depth / 2.0
        bot = [bm.verts.new((radius1 * math.cos(2 * math.pi * i / segments), radius1 * math.sin(2 * math.pi * i / segments), -h)) for i in range(segments)]
        if radius2 > 1e-9:
            top = [bm.verts.new((radius2 * math.cos(2 * math.pi * i / segments), radius2 * math.sin(2 * math.pi * i / segments), h)) for i in range(segments)]
            for i in range(segments):
                bm.faces.new([bot[i], bot[(i + 1) % segments], top[(i + 1) % segments], top[i]])
            if cap_ends:
                bm.faces.new(list(reversed(bot)))
                bm.faces.new(top)
        else:
            apex = bm.verts.new((0, 0, h))
            for i in range(segments):
                bm.faces.new([bot[i], bot[(i + 1) % segments], apex])
            if cap_ends:
                bm.faces.new(list(reversed(bot)))
        return {}

    @staticmethod
    def create_uvsphere(bm, u_segments=16, v_segments=8, radius=1.0, **kw):
        rings = []
        for j in range(1, v_segments):
            phi = math.pi * j / v_segments
            rings.append([bm.verts.new((radius * math.sin(phi) * math.cos(2 * math.pi * i / u_segments), radius * math.sin(phi) * math.sin(2 * math.pi * i / u_segments), radius * math.cos(phi))) for i in range(u_segments)])
        top = bm.verts.new((0, 0, radius))
        bot = bm.verts.new((0, 0, -radius))
        for i in range(u_segments):
            bm.faces.new([top, rings[0][i], rings[0][(i + 1) % u_segments]])
            bm.faces.new([bot, rings[-1][(i + 1) % u_segments], rings[-1][i]])
        for j in range(len(rings) - 1):
            for i in range(u_segments):
                bm.faces.new([rings[j][i], rings[j + 1][i], rings[j + 1][(i + 1) % u_segments], rings[j][(i + 1) % u_segments]])
        return {}

    @staticmethod
    def create_icosphere(bm, subdivisions=2, radius=1.0, **kw):
        t = (1 + 5 ** 0.5) / 2
        pts = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
        faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
        pts = [Vector(p).normalized() for p in pts]
        cache = {}

        def mid(a, b):
            k = (min(a, b), max(a, b))
            if k not in cache:
                pts.append(((pts[a] + pts[b]) / 2).normalized())
                cache[k] = len(pts) - 1
            return cache[k]
        for _ in range(max(0, subdivisions - 1)):
            nf = []
            for a, b, c in faces:
                ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
                nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
            faces = nf
        vs = [bm.verts.new(tuple(p * radius)) for p in pts]
        for a, b, c in faces:
            bm.faces.new([vs[a], vs[b], vs[c]])
        return {}

    @staticmethod
    def create_grid(bm, x_segments=1, y_segments=1, size=1.0, **kw):
        vs = [bm.verts.new(p) for p in ((-size, -size, 0), (size, -size, 0), (size, size, 0), (-size, size, 0))]
        bm.faces.new(vs)
        return {}

    @staticmethod
    def scale(bm, vec=(1, 1, 1), verts=None, **kw):
        for v in verts or bm.verts:
            v.co = Vector((v.co.x * vec[0], v.co.y * vec[1], v.co.z * vec[2]))

    @staticmethod
    def recalc_face_normals(bm, faces=None, **kw):
        for f in faces or bm.faces:
            f.update_normal()
        return {}

    @staticmethod
    def inset_individual(bm, faces=None, thickness=0.0, depth=0.0, use_even_offset=True, **kw):
        # like Blender: the input face KEEPS its identity and becomes the inner
        # face; a ring of new quads connects it to the old outline
        for f in list(faces or []):
            c = f.calc_center_median()
            outer = list(f.verts)
            inner = []
            for v in outer:
                d = c - v.co
                l = d.length
                t = min(thickness, l * 0.9)
                inner.append(bm.verts.new(tuple(v.co + (d / l) * t if l > 1e-9 else v.co)))
            for e in f.edges:
                if f in e.link_faces:
                    e.link_faces.remove(f)
            for v in outer:
                if f in v.link_faces:
                    v.link_faces.remove(f)
            f.verts = inner
            f.edges = []
            n = len(inner)
            for i in range(n):
                e = bm._edge(inner[i], inner[(i + 1) % n])
                e.link_faces.append(f)
                f.edges.append(e)
                inner[i].link_faces.append(f)
            for i in range(n):
                bm.faces.new([outer[i], outer[(i + 1) % n], inner[(i + 1) % n], inner[i]])
            f.update_normal()
        return {"faces": list(faces or [])}
