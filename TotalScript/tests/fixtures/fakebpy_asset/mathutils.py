"""Minimal mathutils stand-in for tests (Vector / Matrix / Euler / noise).
Only what tools/blender_asset.py and the dump code touch. MOCK - not Blender."""
import math


class Vector:
    def __init__(self, xyz=(0.0, 0.0, 0.0)):
        xyz = list(xyz)
        while len(xyz) < 3:
            xyz.append(0.0)
        self.x, self.y, self.z = [float(v) for v in xyz[:3]]

    def __iter__(self):
        return iter((self.x, self.y, self.z))

    def __len__(self):
        return 3

    def __getitem__(self, i):
        return (self.x, self.y, self.z)[i]

    def __setitem__(self, i, v):
        if i == 0:
            self.x = float(v)
        elif i == 1:
            self.y = float(v)
        else:
            self.z = float(v)

    def __add__(self, o):
        return Vector((self.x + o[0], self.y + o[1], self.z + o[2]))

    def __sub__(self, o):
        return Vector((self.x - o[0], self.y - o[1], self.z - o[2]))

    def __mul__(self, s):
        if isinstance(s, (int, float)):
            return Vector((self.x * s, self.y * s, self.z * s))
        return Vector((self.x * s[0], self.y * s[1], self.z * s[2]))

    __rmul__ = __mul__

    def __truediv__(self, s):
        return Vector((self.x / s, self.y / s, self.z / s))

    def __neg__(self):
        return Vector((-self.x, -self.y, -self.z))

    def __iadd__(self, o):
        self.x += o[0]
        self.y += o[1]
        self.z += o[2]
        return self

    def copy(self):
        return Vector((self.x, self.y, self.z))

    @property
    def length(self):
        return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z)

    def normalized(self):
        l = self.length
        return Vector((self.x / l, self.y / l, self.z / l)) if l > 1e-12 else Vector((0, 0, 0))

    def dot(self, o):
        return self.x * o[0] + self.y * o[1] + self.z * o[2]

    def cross(self, o):
        return Vector((self.y * o[2] - self.z * o[1], self.z * o[0] - self.x * o[2], self.x * o[1] - self.y * o[0]))

    def angle(self, o, fallback=None):
        d = self.length * Vector(o).length
        if d < 1e-12:
            if fallback is not None:
                return fallback
            raise ValueError("zero length")
        return math.acos(max(-1.0, min(1.0, self.dot(o) / d)))

    def to_track_quat(self, track, up):
        return _Quat()

    def __repr__(self):
        return "Vector((%.4f, %.4f, %.4f))" % (self.x, self.y, self.z)


class _Quat:
    def to_euler(self):
        return Euler((0.0, 0.0, 0.0))


class Matrix:
    def __init__(self, rows=None):
        self.rows = [list(r) for r in rows] if rows else [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

    @staticmethod
    def Identity(n=4):
        m = Matrix()
        if n == 3:
            m.rows = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        return m

    @staticmethod
    def Translation(t):
        return Matrix([[1, 0, 0, t[0]], [0, 1, 0, t[1]], [0, 0, 1, t[2]], [0, 0, 0, 1]])

    @staticmethod
    def Rotation(angle, size, axis):
        c, s = math.cos(angle), math.sin(angle)
        if axis == "X":
            r = [[1, 0, 0], [0, c, -s], [0, s, c]]
        elif axis == "Y":
            r = [[c, 0, s], [0, 1, 0], [-s, 0, c]]
        else:
            r = [[c, -s, 0], [s, c, 0], [0, 0, 1]]
        m = Matrix([[r[0][0], r[0][1], r[0][2], 0], [r[1][0], r[1][1], r[1][2], 0], [r[2][0], r[2][1], r[2][2], 0], [0, 0, 0, 1]])
        if size == 3:
            m.rows = r
        return m

    @staticmethod
    def Scale(f, size, axis=None):
        m = Matrix()
        for i in range(3):
            m.rows[i][i] = f
        return m

    def __matmul__(self, o):
        if isinstance(o, Matrix):
            n = len(self.rows)
            out = [[sum(self.rows[i][k] * o.rows[k][j] for k in range(n)) for j in range(n)] for i in range(n)]
            return Matrix(out)
        r = self.rows
        if len(r) == 3:
            return Vector([r[i][0] * o[0] + r[i][1] * o[1] + r[i][2] * o[2] for i in range(3)])
        return Vector([r[i][0] * o[0] + r[i][1] * o[1] + r[i][2] * o[2] + r[i][3] for i in range(3)])

    @property
    def translation(self):
        return Vector((self.rows[0][3], self.rows[1][3], self.rows[2][3]))

    def to_3x3(self):
        return Matrix([r[:3] for r in self.rows[:3]])

    def to_4x4(self):
        if len(self.rows) == 4:
            return Matrix(self.rows)
        return Matrix([self.rows[0] + [0], self.rows[1] + [0], self.rows[2] + [0], [0, 0, 0, 1]])

    def transposed(self):
        n = len(self.rows)
        return Matrix([[self.rows[j][i] for j in range(n)] for i in range(n)])

    def inverted_safe(self):
        # rotations only in these tests: inverse == transpose for the 3x3 part
        return self.transposed()

    def copy(self):
        return Matrix(self.rows)


class Euler(list):
    def __init__(self, angles=(0.0, 0.0, 0.0), order="XYZ"):
        super().__init__([float(a) for a in angles])
        self.order = order

    @property
    def x(self):
        return self[0]

    @property
    def y(self):
        return self[1]

    @property
    def z(self):
        return self[2]

    def to_matrix(self):
        return (Matrix.Rotation(self[2], 3, "Z") @ Matrix.Rotation(self[1], 3, "Y") @ Matrix.Rotation(self[0], 3, "X"))


class _Noise:
    @staticmethod
    def noise(v, noise_basis=None):
        x, y, z = float(v[0]), float(v[1]), float(v[2])
        return math.sin(x * 1.7 + 0.3) * math.cos(y * 1.3 - 0.2) * math.sin(z * 0.9 + 1.1)


noise = _Noise()
