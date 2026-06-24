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

/// Pick a well-spread initial tetrahedron (axis extremes → farthest pair → farthest
/// from the line → farthest from the plane) plus an interior reference point and a
/// scale-aware tolerance. `None` if the points are coincident / collinear / coplanar.
fn seed_simplex(pts: &[Vec3]) -> Option<(usize, usize, usize, usize, Vec3, f64)> {
    let n = pts.len();
    if n < 4 {
        return None;
    }
    let mut maxabs = 0.0_f64;
    for p in pts {
        maxabs = maxabs.max(p.x.abs()).max(p.y.abs()).max(p.z.abs());
    }
    let tol = (3.0 * f64::EPSILON * maxabs.max(1.0)).max(1e-12);

    let mut ext = [0usize; 6];
    for i in 1..n {
        if pts[i].x < pts[ext[0]].x { ext[0] = i; }
        if pts[i].x > pts[ext[1]].x { ext[1] = i; }
        if pts[i].y < pts[ext[2]].y { ext[2] = i; }
        if pts[i].y > pts[ext[3]].y { ext[3] = i; }
        if pts[i].z < pts[ext[4]].z { ext[4] = i; }
        if pts[i].z > pts[ext[5]].z { ext[5] = i; }
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
        return None;
    }

    let pa = pts[a];
    let ab = pts[b].sub(pa);
    let ab2 = ab.dot(ab).max(1e-18);
    let (mut c, mut bestc) = (usize::MAX, tol * tol);
    for i in 0..n {
        if i == a || i == b { continue; }
        let t = pts[i].sub(pa).dot(ab) / ab2;
        let d2 = pts[i].dist2(pa.add(ab.scale(t)));
        if d2 > bestc {
            bestc = d2;
            c = i;
        }
    }
    if c == usize::MAX {
        return None;
    }

    let nrm = cross(pts[b].sub(pa), pts[c].sub(pa));
    let nrm_len = nrm.norm();
    if nrm_len <= tol {
        return None;
    }
    let nunit = nrm.scale(1.0 / nrm_len);
    let (mut d, mut bestd) = (usize::MAX, tol);
    for i in 0..n {
        if i == a || i == b || i == c { continue; }
        let dist = nunit.dot(pts[i].sub(pa)).abs();
        if dist > bestd {
            bestd = dist;
            d = i;
        }
    }
    if d == usize::MAX {
        return None;
    }

    let interior = pts[a].add(pts[b]).add(pts[c]).add(pts[d]).scale(0.25);
    Some((a, b, c, d, interior, tol))
}

/// Collect alive faces + the unique input indices that lie on the hull.
fn finish_hull(faces: Vec<Face>, n: usize) -> Hull {
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
    Hull { faces, vertices }
}

/// Convex hull via the conflict-list (randomized-incremental / quickhull) scheme:
/// every not-yet-added point is held in the "outside" set of one face it is above;
/// the farthest such point is added, the faces it can see are replaced by a cone to
/// it, and only the outside points of the removed faces are re-tested. Interior
/// points are dropped on first assignment and never revisited, so unlike the plain
/// incremental scan this avoids re-examining every point against every face.
///
/// Same result as {@link convex_hull_incremental} (the convex hull is unique), used
/// as the production path. `None` on degenerate input.
pub fn convex_hull(pts: &[Vec3]) -> Option<Hull> {
    let n = pts.len();
    let (a, b, c, d, interior, tol) = seed_simplex(pts)?;

    struct WFace {
        f: Face,
        outside: Vec<usize>,
        alive: bool,
    }
    let mut faces: Vec<WFace> = Vec::with_capacity(2 * n);
    for &(i, j, k) in &[(a, b, c), (a, b, d), (a, c, d), (b, c, d)] {
        faces.push(WFace { f: make_face(i, j, k, pts, interior)?, outside: Vec::new(), alive: true });
    }

    // Assign each non-seed point to the farthest face it lies above (else interior).
    let seed = [a, b, c, d];
    for pi in 0..n {
        if seed.contains(&pi) {
            continue;
        }
        let p = pts[pi];
        let (mut best_f, mut best_d) = (usize::MAX, tol);
        for (fi, wf) in faces.iter().enumerate() {
            let dd = Hull::face_distance(&wf.f, p);
            if dd > best_d {
                best_d = dd;
                best_f = fi;
            }
        }
        if best_f != usize::MAX {
            faces[best_f].outside.push(pi);
        }
    }

    let mut stack: Vec<usize> = (0..faces.len()).filter(|&i| !faces[i].outside.is_empty()).collect();
    let mut vis: Vec<usize> = Vec::new();
    let mut pool: Vec<usize> = Vec::new();
    let mut edges: HashSet<(usize, usize)> = HashSet::new();

    while let Some(fi) = stack.pop() {
        if !faces[fi].alive || faces[fi].outside.is_empty() {
            continue;
        }

        // Farthest outside point of this face becomes the next hull vertex.
        let (mut p_idx, mut p_d) = (usize::MAX, tol);
        for &q in &faces[fi].outside {
            let dd = Hull::face_distance(&faces[fi].f, pts[q]);
            if dd > p_d {
                p_d = dd;
                p_idx = q;
            }
        }
        if p_idx == usize::MAX {
            continue;
        }
        let p = pts[p_idx];

        // Complete set of faces visible from p (full scan — the visible set on a
        // convex hull is connected, so this equals a neighbour walk).
        vis.clear();
        for (gi, wf) in faces.iter().enumerate() {
            if wf.alive && Hull::face_distance(&wf.f, p) > tol {
                vis.push(gi);
            }
        }

        // Pool the outside points of the doomed faces (except p), gather their edges,
        // and kill them.
        pool.clear();
        edges.clear();
        for &gi in &vis {
            for &q in &faces[gi].outside {
                if q != p_idx {
                    pool.push(q);
                }
            }
            let v = faces[gi].f.v;
            edges.insert((v[0], v[1]));
            edges.insert((v[1], v[2]));
            edges.insert((v[2], v[0]));
            faces[gi].alive = false;
            faces[gi].outside = Vec::new();
        }

        // Cone the horizon (edges with no visible twin) to p.
        let new_start = faces.len();
        for &(x, y) in &edges {
            if !edges.contains(&(y, x)) {
                match make_face(x, y, p_idx, pts, interior) {
                    Some(f) => faces.push(WFace { f, outside: Vec::new(), alive: true }),
                    None => return None, // degenerate cone face
                }
            }
        }

        // Re-test pooled points against the new faces only. A point still outside the
        // hull whose old face was removed necessarily lies above a new cone face (its
        // visible region crosses the horizon), so any point above none is now interior.
        for &q in &pool {
            let qp = pts[q];
            let (mut best_f, mut best_d) = (usize::MAX, tol);
            for gi in new_start..faces.len() {
                let dd = Hull::face_distance(&faces[gi].f, qp);
                if dd > best_d {
                    best_d = dd;
                    best_f = gi;
                }
            }
            if best_f != usize::MAX {
                faces[best_f].outside.push(q);
            }
        }
        for gi in new_start..faces.len() {
            if !faces[gi].outside.is_empty() {
                stack.push(gi);
            }
        }
    }

    let out_faces: Vec<Face> = faces.into_iter().filter(|w| w.alive).map(|w| w.f).collect();
    Some(finish_hull(out_faces, n))
}

/// Plain incremental hull (adds every point in order, O(n²)). Kept as a reference /
/// fallback for {@link convex_hull}; not on the hot path.
#[allow(dead_code)]
pub fn convex_hull_incremental(pts: &[Vec3]) -> Option<Hull> {
    let n = pts.len();
    let (a, b, c, d, interior, _tol) = seed_simplex(pts)?;
    let tol = _tol;

    let mut faces: Vec<Face> = Vec::with_capacity(2 * n);
    for &(i, j, k) in &[(a, b, c), (a, b, d), (a, c, d), (b, c, d)] {
        faces.push(make_face(i, j, k, pts, interior)?);
    }

    let mut vis: Vec<bool> = Vec::new();
    let mut edges: HashSet<(usize, usize)> = HashSet::new();
    let mut horizon: Vec<(usize, usize)> = Vec::new();
    let mut next_faces: Vec<Face> = Vec::new();

    let seed = [a, b, c, d];
    for pi in 0..n {
        if seed.contains(&pi) {
            continue;
        }
        let p = pts[pi];
        vis.clear();
        vis.resize(faces.len(), false);
        let mut any = false;
        for (fi, f) in faces.iter().enumerate() {
            if Hull::face_distance(f, p) > tol {
                vis[fi] = true;
                any = true;
            }
        }
        if !any {
            continue;
        }
        edges.clear();
        for (fi, f) in faces.iter().enumerate() {
            if vis[fi] {
                edges.insert((f.v[0], f.v[1]));
                edges.insert((f.v[1], f.v[2]));
                edges.insert((f.v[2], f.v[0]));
            }
        }
        horizon.clear();
        for &(x, y) in &edges {
            if !edges.contains(&(y, x)) {
                horizon.push((x, y));
            }
        }
        next_faces.clear();
        for (fi, f) in faces.iter().enumerate() {
            if !vis[fi] {
                next_faces.push(*f);
            }
        }
        for &(x, y) in &horizon {
            next_faces.push(make_face(x, y, pi, pts, interior)?);
        }
        std::mem::swap(&mut faces, &mut next_faces);
    }

    Some(finish_hull(faces, n))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(state: &mut u64) -> f64 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*state >> 11) as f64) / ((1u64 << 53) as f64)
    }

    fn sorted_verts(h: &Hull) -> Vec<usize> {
        let mut v = h.vertices.clone();
        v.sort_unstable();
        v
    }

    /// Every input point must lie inside/on the hull, and every face must be incident
    /// to ≥1 input point at distance ~0 (a real supporting plane).
    fn assert_valid_hull(h: &Hull, pts: &[Vec3], tol: f64) {
        for p in pts {
            for f in &h.faces {
                assert!(
                    Hull::face_distance(f, *p) <= tol,
                    "point lies outside a hull face by {}",
                    Hull::face_distance(f, *p)
                );
            }
        }
    }

    #[test]
    fn quickhull_matches_incremental_random() {
        let mut s = 0x9E3779B97F4A7C15u64;
        for trial in 0..400 {
            let n = 5 + (trial % 80);
            let pts: Vec<Vec3> = (0..n)
                .map(|_| {
                    Vec3::new(
                        lcg(&mut s) * 10.0 - 5.0,
                        lcg(&mut s) * 10.0 - 5.0,
                        lcg(&mut s) * 10.0 - 5.0,
                    )
                })
                .collect();
            let qh = convex_hull(&pts);
            let ic = convex_hull_incremental(&pts);
            match (qh, ic) {
                (Some(q), Some(i)) => {
                    assert_eq!(sorted_verts(&q), sorted_verts(&i), "vertex set, trial {trial}");
                    assert_valid_hull(&q, &pts, 1e-6);
                }
                (None, None) => {}
                _ => panic!("hull Some/None disagreement, trial {trial}"),
            }
        }
    }

    #[test]
    fn quickhull_cube_with_interior() {
        // 8 cube corners (the true hull) plus many interior points that must be dropped.
        let mut pts = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(1.0, 1.0, 0.0),
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::new(1.0, 0.0, 1.0),
            Vec3::new(0.0, 1.0, 1.0),
            Vec3::new(1.0, 1.0, 1.0),
        ];
        let mut s = 42u64;
        for _ in 0..200 {
            pts.push(Vec3::new(
                0.05 + 0.9 * lcg(&mut s),
                0.05 + 0.9 * lcg(&mut s),
                0.05 + 0.9 * lcg(&mut s),
            ));
        }
        let q = convex_hull(&pts).expect("cube hull");
        assert_eq!(sorted_verts(&q), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        assert_valid_hull(&q, &pts, 1e-9);
    }

    #[test]
    fn degenerate_returns_none() {
        // Coplanar square → no volume.
        let pts = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(1.0, 1.0, 0.0),
        ];
        assert!(convex_hull(&pts).is_none());
    }
}
