/// 3x3 matrix stored row-major.
#[derive(Debug, Copy, Clone)]
pub struct Matrix33 {
    pub data: [[f64; 3]; 3],
}

impl Matrix33 {
    #[inline]
    pub fn new(data: [[f64; 3]; 3]) -> Self {
        Self { data }
    }

    #[inline]
    pub fn transpose(self) -> Matrix33 {
        let d = self.data;
        Matrix33 {
            data: [
                [d[0][0], d[1][0], d[2][0]],
                [d[0][1], d[1][1], d[2][1]],
                [d[0][2], d[1][2], d[2][2]],
            ],
        }
    }

    #[inline]
    pub fn det(&self) -> f64 {
        let [[a, b, c], [d, e, f], [g, h, i]] = self.data;
        a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    }

    pub fn inverse(&self) -> Option<Self> {
        let det = self.det();
        if det.abs() <= 1e-10 {
            return None;
        }
        let inv = 1.0 / det;
        let [[a, b, c], [d, e, f], [g, h, i]] = self.data;
        Some(Self {
            data: [
                [
                    (e * i - f * h) * inv,
                    (c * h - b * i) * inv,
                    (b * f - c * e) * inv,
                ],
                [
                    (f * g - d * i) * inv,
                    (a * i - c * g) * inv,
                    (c * d - a * f) * inv,
                ],
                [
                    (d * h - e * g) * inv,
                    (b * g - a * h) * inv,
                    (a * e - b * d) * inv,
                ],
            ],
        })
    }

    #[inline]
    pub fn mul_vec(&self, v: Vec3) -> Vec3 {
        let d = &self.data;
        Vec3 {
            x: d[0][0] * v.x + d[0][1] * v.y + d[0][2] * v.z,
            y: d[1][0] * v.x + d[1][1] * v.y + d[1][2] * v.z,
            z: d[2][0] * v.x + d[2][1] * v.y + d[2][2] * v.z,
        }
    }
}

/// Dense 3-vector.
#[derive(Debug, Copy, Clone, PartialEq, PartialOrd)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    #[inline]
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    #[inline]
    pub fn add(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x + other.x, self.y + other.y, self.z + other.z)
    }

    #[inline]
    pub fn sub(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }

    #[inline]
    pub fn scale(self, s: f64) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }

    #[inline]
    pub fn dot(self, other: Vec3) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    #[inline]
    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }

    #[inline]
    pub fn dist(self, other: Vec3) -> f64 {
        self.sub(other).norm()
    }

    /// Squared distance — avoids the sqrt in hot loops (compare against cutoff²).
    #[inline]
    pub fn dist2(self, other: Vec3) -> f64 {
        let d = self.sub(other);
        d.dot(d)
    }
}

/// Build a lattice Matrix33 from a flat 9-element JS array [a0,a1,a2, b0,b1,b2, c0,c1,c2].
pub fn lattice_from_flat(v: &[f64]) -> Matrix33 {
    assert_eq!(v.len(), 9, "lattice must have 9 elements");
    Matrix33::new([
        [v[0], v[1], v[2]],
        [v[3], v[4], v[5]],
        [v[6], v[7], v[8]],
    ])
}

/// Convert a slice of fractional coords (flat: x0,y0,z0, x1,...) to Cartesian.
pub fn frac_to_cart_flat(frac: &[f64], lattice: &Matrix33) -> Vec<f64> {
    frac.chunks_exact(3)
        .flat_map(|c| {
            let v = lattice.mul_vec(Vec3::new(c[0], c[1], c[2]));
            [v.x, v.y, v.z]
        })
        .collect()
}

/// Convert a Cartesian Vec3 to fractional coordinates given lattice and its inverse.
#[inline]
pub fn cart_to_frac(cart: Vec3, lat_inv: &Matrix33) -> Vec3 {
    lat_inv.mul_vec(cart)
}
