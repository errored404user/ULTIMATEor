import os
from mathutils import Vector, Matrix
class _V:
    def __init__(self, co): self.co = Vector(co)
class _P:
    def __init__(self, ids, smooth=False): self.vertices = ids; self.use_smooth = smooth
class _LT:
    def __init__(self, ids): self.vertices = ids
class Mesh:
    def __init__(self, verts, polys, smooth=False, with_lt=True):
        self.vertices = [_V(v) for v in verts]
        self.polygons = [_P(p, smooth) for p in polys]
        self._lt = with_lt
        self.loop_triangles = []
    def calc_loop_triangles(self):
        if not self._lt: return
        out = []
        for p in self.polygons:
            ids = list(p.vertices)
            for i in range(1, len(ids)-1): out.append(_LT((ids[0], ids[i], ids[i+1])))
        self.loop_triangles = out
class _Input:
    def __init__(self, v): self.default_value = v
class _Node:
    def __init__(self): self.type = "BSDF_PRINCIPLED"; self.inputs = {"Base Color": _Input((0.8, 0.2, 0.1, 1.0))}
class _Tree:
    def __init__(self): self.nodes = [_Node()]
class Material:
    def __init__(self, nodes=True):
        self.use_nodes = nodes; self.node_tree = _Tree() if nodes else None; self.diffuse_color = (0.5, 0.5, 0.5, 1)
class Object:
    def __init__(self, name, mesh, mat=None, loc=(0,0,0)):
        self.name = name; self.type = "MESH"; self.data = mesh; self.active_material = mat; self.material_slots = []
        self.matrix_world = Matrix.Translation(loc)
    def evaluated_get(self, dg): return self
    def to_mesh(self): return self.data
    def to_mesh_clear(self): pass
    def select_set(self, v): pass
def cube(size=1.0):
    s = size/2
    verts = [(-s,-s,-s),(s,-s,-s),(s,s,-s),(-s,s,-s),(-s,-s,s),(s,-s,s),(s,s,s),(-s,s,s)]
    polys = [(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    return verts, polys
cv, cp = cube(2.0)
# a dense mesh: fan of 25k triangles
dense_v = [(0,0,0)] + [(i*0.001, 0, 1) for i in range(25002)]
dense_p = [(0, i+1, i+2) for i in range(25000)]
class _Objects(list):
    def get(self, n):
        for o in self:
            if o.name == n: return o
        return None
    def keys(self): return [o.name for o in self]
OBJS = _Objects([
    Object("Cube", Mesh(cv, cp, smooth=False), Material(), loc=(1, 2, 3)),
    Object("Ball", Mesh(cv, cp, smooth=True), Material(nodes=False), loc=(0, 0, 0)),
    Object("Dense", Mesh(dense_v, dense_p), None),
    Object("Empty", Mesh([(0,0,0)], [], with_lt=False), None),
])
class _Data: objects = OBJS
data = _Data()
class _Ctx:
    selected_objects = []
    def evaluated_depsgraph_get(self): return None
    class view_layer:
        class objects: active = None
    scene = None
context = _Ctx()
class _App: tempdir = "/tmp"
app = _App()
class ops: pass
