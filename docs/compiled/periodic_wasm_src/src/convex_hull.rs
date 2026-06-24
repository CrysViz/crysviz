//! Minimal robust 3D convex hull (incremental / Beneath-Beyond), enough to back
//! the polyhedra computation: it returns the hull's triangular faces (with
//! outward unit normals + plane offsets) and the set of input points that lie on
//! the hull. Degenerate inputs (fewer than 4 points, or all coincident /
//! collinear / coplanar) yield `None`, mirroring the JS path's behaviour of
//! treating a non-constructible hull as "skip this candidate".

use crate::linalg::Vec3;
use std::collections::HashSet;

#[inline]
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    Vec3::new(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    )
}

/// One triangular hull face. The plane is `normal · x = offset`, with `normal`
/// the outward unit normal, so `normal · p - offset` is the signed distance of
/// `p` from the face (positive = outside the hull).
#[derive(Clone, Copy)]
pub struct Face {
    pub v: [usize; 3],
    pub normal: Vec3,
    pub offset: f64,
}

pub struct Hull {
    pub faces: Vec<Face>,
    /// Unique input indices that ended up on the hull.
    pub vertices: Vec<usize>,
}

impl Hull {
    /// Signed distance of `p` from `face` (positive outside).
    #[inline]
    pub fn face_distance(face: &Face, p: Vec3) -> f64 {
        face.normal.dot(p) - face.offset
    }

    /// True iff `p` is inside (or on, within `tol`) every face.
    pub fn contains(&self, p: Vec3, tol: f64) -> bool {
        self.faces.iter().all(|f| Self::face_distance(f, p) <= tol)
    }
}

/// Build a face from three vertex indices, oriented so its normal points away
/// from `interior`. Returns `None` if the three points are (near-)collinear.
fn make_face(i: usize, j: usize, k: usize, pts: &[Vec3], interior: Vec3) -> Option<Face> {
    let (mut vj, mut vk) = (j, k);
    let n0 = cross(pts[vj].sub(pts[i]), pts[vk].sub(pts[i]));
    // Flip winding if the interior point is on the "outward" side.
    if n0.dot(interior.sub(pts[i])) > 0.0 {
        std::mem::swap(&mut vj, &mut vk);
    }
    let n = cross(pts[vj].sub(pts[i]), pts[vk].sub(pts[i]));
    let len = n.norm();
    if len <= 1e-18 {
        return None;
    }
    let un = n.scale(1.0 / len);
    Some(Face {
        v: [i, vj, vk],
        normal: un,
        offset: un.dot(pts[i]),
    })
}

/// Compute the convex hull of `pts`. `None` on degenerate input.
pub fn convex_hull(pts: &[Vec3]) -> Option<Hull> {
    let n = pts.len();
    if n < 4 {
        return None;
    }

    // Scale-aware tolerance, similar in spirit to three.js's ConvexHull.
    let mut maxabs = 0.0_f64;
    for p in pts {
        maxabs = maxabs.max(p.x.abs()).max(p.y.abs()).max(p.z.abs());
    }
    let tol = (3.0 * f64::EPSILON * maxabs.max(1.0)).max(1e-12);

    // --- Seed simplex: pick a well-spread initial tetrahedron. ---
    // Axis-aligned extreme points, then the most distant pair among them.
    let mut ext = [0usize; 6];
    for i in 1..n {
        if pts[i].x < pts[ext[0]].x {
            ext[0] = i;
        }
        if pts[i].x > pts[ext[1]].x {
            ext[1] = i;
        }
        if pts[i].y < pts[ext[2]].y {
            ext[2] = i;
        }
        if pts[i].y > pts[ext[3]].y {
            ext[3] = i;
        }
        if pts[i].z < pts[ext[4]].z {
            ext[4] = i;
        }
        if pts[i].z > pts[ext[5]].z {
            ext[5] = i;
        }
    }
    let (mut a, mut b, mut best) = (0usize, 0usize, -1.0_f64);
    for i in 0..6 {
        for j in (i + 1)..6 {
            let d = pts[ext[i]].dist2(pts[ext[j]]);
            if d > best {
                best = d;
                a = ext[i];
                b = ext[j];
            }
        }
    }
    if best <= tol * tol {
        return None; // all coincident
    }

    // Third point: farthest from the line a-b.
    let pa = pts[a];
    let ab = pts[b].sub(pa);
    let ab2 = ab.dot(ab).max(1e-18);
    let (mut c, mut bestc) = (usize::MAX, tol * tol);
    for i in 0..n {
        if i == a || i == b {
            continue;
        }
        let t = pts[i].sub(pa).dot(ab) / ab2;
        let d2 = pts[i].dist2(pa.add(ab.scale(t)));
        if d2 > bestc {
            bestc = d2;
            c = i;
        }
    }
    let c = if c == usize::MAX {
        return None;
    } else {
        c
    };

    // Fourth point: farthest from the plane a-b-c.
    let nrm = cross(pts[b].sub(pa), pts[c].sub(pa));
    let nrm_len = nrm.norm();
    if nrm_len <= tol {
        return None;
    }
    let nunit = nrm.scale(1.0 / nrm_len);
    let (mut d, mut bestd) = (usize::MAX, tol);
    for i in 0..n {
        if i == a || i == b || i == c {
            continue;
        }
        let dist = nunit.dot(pts[i].sub(pa)).abs();
        if dist > bestd {
            bestd = dist;
            d = i;
        }
    }
    let d = if d == usize::MAX {
        return None;
    } else {
        d
    };

    // Interior reference point — stays strictly inside the growing hull.
    let interior = pts[a].add(pts[b]).add(pts[c]).add(pts[d]).scale(0.25);

    let mut faces: Vec<Face> = Vec::with_capacity(2 * n);
    for &(i, j, k) in &[(a, b, c), (a, b, d), (a, c, d), (b, c, d)] {
        faces.push(make_face(i, j, k, pts, interior)?);
    }

    let seed = [a, b, c, d];
    for pi in 0..n {
        if seed.contains(&pi) {
            continue;
        }
        let p = pts[pi];

        // Faces this point can "see" (lies outside of).
        let mut vis = vec![false; faces.len()];
        let mut any = false;
        for (fi, f) in faces.iter().enumerate() {
            if Hull::face_distance(f, p) > tol {
                vis[fi] = true;
                any = true;
            }
        }
        if !any {
            continue; // inside the current hull
        }

        // Horizon = directed edges of visible faces whose twin is not visible.
        let mut edges: HashSet<(usize, usize)> = HashSet::new();
        for (fi, f) in faces.iter().enumerate() {
            if vis[fi] {
                edges.insert((f.v[0], f.v[1]));
                edges.insert((f.v[1], f.v[2]));
                edges.insert((f.v[2], f.v[0]));
            }
        }
        let horizon: Vec<(usize, usize)> = edges
            .iter()
            .filter(|&&(x, y)| !edges.contains(&(y, x)))
            .cloned()
            .collect();

        // Drop visible faces, then cone the horizon to the new point.
        let mut kept: Vec<Face> = Vec::with_capacity(faces.len());
        for (fi, f) in faces.iter().enumerate() {
            if !vis[fi] {
                kept.push(*f);
            }
        }
        for (x, y) in horizon {
            kept.push(make_face(x, y, pi, pts, interior)?);
        }
        faces = kept;
    }

    // Collect unique hull vertices.
    let mut seen = vec![false; n];
    let mut vertices = Vec::new();
    for f in &faces {
        for &vi in &f.v {
            if !seen[vi] {
                seen[vi] = true;
                vertices.push(vi);
            }
        }
    }

    Some(Hull {
        faces,
        vertices,
    })
}
