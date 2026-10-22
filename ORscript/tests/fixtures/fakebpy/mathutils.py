class Vector:
    def __init__(self, xyz): self.x, self.y, self.z = [float(v) for v in xyz]
    def __iter__(self): return iter((self.x, self.y, self.z))
class Matrix:
    def __init__(self, rows): self.rows = rows
    def __matmul__(self, v):
        r = self.rows
        return Vector([r[i][0]*v.x + r[i][1]*v.y + r[i][2]*v.z + r[i][3] for i in range(3)])
    @staticmethod
    def Identity(n=4): return Matrix([[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]])
    @staticmethod
    def Translation(t): return Matrix([[1,0,0,t[0]],[0,1,0,t[1]],[0,0,1,t[2]],[0,0,0,1]])
