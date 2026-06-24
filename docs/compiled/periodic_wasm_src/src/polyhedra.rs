//! Rust port of `computePolyhedra` (docs/render/PolyhedraModule.js). The JS side
//! prepares the cheap, display-coupled inputs (visible centre images, visible
//! image keys, cutoff/electronegativity/radius tables) and this does the heavy
//! geometry: cell-list neighbour search, radical-Voronoi coordination selection,
//! cage detection, and the global acceptance/nesting pass. Output is a flat set
//! of accepted polyhedra (vertices in Cartesian) that JS turns into the model.

use crate::convex_hull::{convex_hull, cross, Hull};
use crate::linalg::{Matrix33, Vec3};
/// Millisecond clock — `js_sys::Date::now()` on wasm, 0.0 under native `cargo test`
/// (where there is no JS host and it would panic). Timing is only used for the log.
#[cfg(target_arch = "wasm32")]
#[inline]
fn now() -> f64 {
    js_sys::Date::now()
}
#[cfg(not(target_arch = "wasm32"))]
#[inline]
fn now() -> f64 {
    0.0
}
use std::collections::{BTreeMap, HashMap, HashSet};

/// Cap on candidates fed to the radical-Voronoi cell per centre. The cell of a
/// centre is bounded entirely by its closest atoms; an atom farther than the
/// nearest ~100 (which already surround the centre in every direction) is always
/// shadowed and never contributes a face, so truncating to the nearest N leaves
/// the accepted coordination identical while keeping the dual hull small.
const VORONOI_MAX_CANDS: usize = 100;

/// Cap on the per-seed cage pool. The frontier BFS overshoots the "≥40 visible"
/// target by a whole depth level, which can leave hundreds of atoms in the pool;
/// the band hull + spread sampling are O(pool²), so trimming to the nearest ~64
/// (well above 2×20 for dodecahedra) restores the intended cost without dropping
/// any real coordination shell. Kept generous (≈5× the largest cage) so a sparse
/// cage interior or a clathrate guest atom can't push a shell atom out of range.
const POOL_CAP: usize = 96;

// ---- Behaviour constants (mirror the JS module) ----
const CAGE_TARGET_NS_DESC: [usize; 6] = [20, 12, 10, 8, 6, 4];
const CAGE_BFS_DEPTH: i32 = 5;
const MAX_EDGE_SPREAD: f64 = 1.60;
const MIN_THICKNESS_RATIO: f64 = 0.08;
const MIN_CENTER_FACE_CLEARANCE_REL: f64 = 0.10;
const VORONOI_SOLID_ANGLE_REL: f64 = 0.10;
const EDGE_ANGLE_DEG: f64 = 18.0;

#[inline]
fn search_radius(max_cutoff: f64) -> f64 {
    8.0_f64.min(4.0_f64.max(2.5 * max_cutoff))
}

fn min_vertex_degree_for_cage_size(n: usize) -> usize {
    match n {
        12 => 5,
        20 => 3,
        10 => 3,
        8 => 3,
        6 => 3,
        4 => 2,
        _ => 3,
    }
}

type Key = (u32, i32, i32, i32);

#[inline]
fn image_key(src: u32, shift: [i32; 3]) -> Key {
    (src, shift[0], shift[1], shift[2])
}

#[derive(Clone)]
struct Neighbor {
    src_j: u32,
    shift: [i32; 3],
    pos: Vec3,
}

#[derive(Clone)]
struct Cand {
    src_j: u32,
    shift: [i32; 3],
    pos: Vec3,
    d: f64,
    elem: usize,
    radius: f64,
}

#[derive(Clone)]
struct PoolEntry {
    pos: Vec3,
    src: u32,
    shift: [i32; 3],
}

pub struct Candidate {
    is_cage: bool,
    color_elem: u32,
    center_src: i32,
    center_shift: [i32; 3],
    pos_list: Vec<Vec3>,
    vertex_src_list: Vec<u32>,
    vertex_image_list: Vec<(u32, [i32; 3])>,
    ref_point: Vec3,
}

pub struct ComputedPolyhedra {
    pub kinds: Vec<u32>,       // 0 centered, 1 cage
    pub color_elem: Vec<u32>,
    pub center_src: Vec<i32>,  // -1 for cages
    pub vert_counts: Vec<u32>,
    pub vertices: Vec<f64>,    // flat cart, sum(N)*3
    pub vertex_srcs: Vec<u32>, // flat, sum(N)
    pub setup_ms: f64,
    pub centered_ms: f64,
    pub cages_ms: f64,
    pub cage_pool_ms: f64,
    pub cage_band_ms: f64,
    pub cage_nloop_ms: f64,
    pub accept_ms: f64,
    pub bands_built: u32,
    pub bands_skipped: u32,
}

// ---------------------------------------------------------------------------
// Spatial cell list (mirrors the JS grid)
// ---------------------------------------------------------------------------

struct Grid {
    gx: i32,
    gy: i32,
    gz: i32,
    bins: Vec<Vec<u32>>,
    stamp: Vec<i32>,
    qid: i32,
}

#[inline]
fn wrap_bin(f: f64, g: i32) -> i32 {
    let mut b = ((f - f.floor()) * g as f64).floor() as i32;
    if b >= g {
        b = g - 1;
    } else if b < 0 {
        b = 0;
    }
    b
}

fn axis_range(g: i32, halo: i32, total: i32) -> Vec<i32> {
    if 2 * halo + 1 >= total {
        (0..total).collect()
    } else {
        (-halo..=halo).map(|d| ((g + d) % total + total) % total).collect()
    }
}

impl Grid {
    fn build(positions: &[Vec3], widths: (f64, f64, f64), bin_radius: f64) -> Grid {
        let gx = 1.max((widths.0 / bin_radius).floor() as i32);
        let gy = 1.max((widths.1 / bin_radius).floor() as i32);
        let gz = 1.max((widths.2 / bin_radius).floor() as i32);
        let mut bins = vec![Vec::new(); (gx * gy * gz) as usize];
        for (j, p) in positions.iter().enumerate() {
            let bx = wrap_bin(p.x, gx);
            let by = wrap_bin(p.y, gy);
            let bz = wrap_bin(p.z, gz);
            bins[((bx * gy + by) * gz + bz) as usize].push(j as u32);
        }
        Grid {
            gx,
            gy,
            gz,
            bins,
            stamp: vec![-1; positions.len()],
            qid: 0,
        }
    }

    /// Candidate atom indices whose nearest image could lie within `halo` bins.
    fn candidates(&mut self, fp: Vec3, hx: i32, hy: i32, hz: i32, out: &mut Vec<usize>) {
        out.clear();
        let qid = self.qid;
        self.qid += 1;
        let xs = axis_range(wrap_bin(fp.x, self.gx), hx, self.gx);
        let ys = axis_range(wrap_bin(fp.y, self.gy), hy, self.gy);
        let zs = axis_range(wrap_bin(fp.z, self.gz), hz, self.gz);
        for &bx in &xs {
            for &by in &ys {
                for &bz in &zs {
                    let bin = &self.bins[((bx * self.gy + by) * self.gz + bz) as usize];
                    for &ju in bin {
                        let j = ju as usize;
                        if self.stamp[j] == qid {
                            continue;
                        }
                        self.stamp[j] = qid;
                        out.push(j);
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Voronoi (port of VoronoiNeighbours.js)
// ---------------------------------------------------------------------------

struct Plane {
    n: Vec3,
    c: f64,
    k: usize,
}

fn intersect_3_planes(p0: &Plane, p1: &Plane, p2: &Plane) -> Option<Vec3> {
    let m = Matrix33::new([
        [p0.n.x, p0.n.y, p0.n.z],
        [p1.n.x, p1.n.y, p1.n.z],
        [p2.n.x, p2.n.y, p2.n.z],
    ]);
    let inv = m.inverse()?;
    let c = Vec3::new(p0.c, p1.c, p2.c);
    Some(inv.mul_vec(c))
}

fn tri_solid_angle(a: Vec3, b: Vec3, c: Vec3) -> f64 {
    let (la, lb, lc) = (a.norm(), b.norm(), c.norm());
    if la < 1e-9 || lb < 1e-9 || lc < 1e-9 {
        return 0.0;
    }
    let num = a.dot(cross(b, c)).abs();
    let den = la * lb * lc + a.dot(b) * lc + a.dot(c) * lb + b.dot(c) * la;
    2.0 * num.atan2(den)
}

fn polygon_solid_angle(poly: &[Vec3]) -> f64 {
    let mut omega = 0.0;
    let mut i = 1;
    while i + 1 < poly.len() {
        omega += tri_solid_angle(poly[0], poly[i], poly[i + 1]);
        i += 1;
    }
    omega
}

fn order_around_normal(verts: &[Vec3], n: Vec3) -> Vec<Vec3> {
    let mut uniq: Vec<Vec3> = Vec::new();
    for &v in verts {
        if !uniq.iter().any(|u| u.dist2(v) < 1e-10) {
            uniq.push(v);
        }
    }
    if uniq.len() < 3 {
        return uniq;
    }
    let cent = uniq
        .iter()
        .fold(Vec3::new(0.0, 0.0, 0.0), |a, &v| a.add(v))
        .scale(1.0 / uniq.len() as f64);
    let mut u = if n.x.abs() > 0.9 {
        Vec3::new(0.0, 1.0, 0.0)
    } else {
        Vec3::new(1.0, 0.0, 0.0)
    };
    u = u.sub(n.scale(n.dot(u)));
    let ul = u.norm().max(1e-12);
    u = u.scale(1.0 / ul);
    let w = cross(n, u);
    uniq.sort_by(|p, q| {
        let dp = p.sub(cent);
        let dq = q.sub(cent);
        let ap = w.dot(dp).atan2(u.dot(dp));
        let aq = w.dot(dq).atan2(u.dot(dq));
        ap.partial_cmp(&aq).unwrap_or(std::cmp::Ordering::Equal)
    });
    uniq
}

/// Returns the accepted candidate indices (into `cands`).
fn voronoi_neighbours(
    center: Vec3,
    cands: &[Cand],
    rc: f64,
    accept: &dyn Fn(&Cand) -> bool,
) -> Vec<usize> {
    let mut planes: Vec<Plane> = Vec::new();
    for (k, cand) in cands.iter().enumerate() {
        let rel = cand.pos.sub(center);
        let d = rel.norm();
        if d < 1e-6 {
            continue;
        }
        let n = rel.scale(1.0 / d);
        let rk = if cand.radius != 0.0 { cand.radius } else { 1.0 };
        let c = (d * d + rc * rc - rk * rk) / (2.0 * d); // radical plane offset
        if c <= 1e-6 {
            continue;
        }
        planes.push(Plane { n, c, k });
    }
    if planes.len() < 4 {
        return Vec::new();
    }

    let dual_pts: Vec<Vec3> = planes.iter().map(|p| p.n.scale(1.0 / p.c)).collect();
    let hull = match convex_hull(&dual_pts) {
        Some(h) => h,
        None => return Vec::new(),
    };

    // Each hull facet ↔ a Voronoi-cell vertex (meeting of that facet's planes).
    // BTreeMap (not HashMap) so iteration is by plane index — deterministic vertex
    // order, independent of hasher seed, so serial and parallel results are identical.
    let mut cell_verts: BTreeMap<usize, Vec<Vec3>> = BTreeMap::new();
    for f in &hull.faces {
        let idxs = [f.v[0], f.v[1], f.v[2]];
        if let Some(v) = intersect_3_planes(&planes[idxs[0]], &planes[idxs[1]], &planes[idxs[2]]) {
            for &idx in &idxs {
                cell_verts.entry(idx).or_default().push(v);
            }
        }
    }

    // Solid angle per accepted neighbour face; relative-threshold filter.
    let mut weighed: Vec<(usize, f64)> = Vec::new();
    let mut max_omega = 0.0_f64;
    for (idx, verts) in &cell_verts {
        if verts.len() < 3 {
            continue;
        }
        let cand = &cands[planes[*idx].k];
        if !accept(cand) {
            continue;
        }
        let ordered = order_around_normal(verts, planes[*idx].n);
        let omega = polygon_solid_angle(&ordered);
        if omega <= 0.0 {
            continue;
        }
        weighed.push((planes[*idx].k, omega));
        if omega > max_omega {
            max_omega = omega;
        }
    }
    if max_omega <= 0.0 {
        return Vec::new();
    }

    let mut accepted = Vec::new();
    for (k, omega) in weighed {
        if omega >= VORONOI_SOLID_ANGLE_REL * max_omega {
            accepted.push(k);
        }
    }
    accepted
}

// ---------------------------------------------------------------------------
// Geometry filters
// ---------------------------------------------------------------------------

fn thickness_ratio(points: &[Vec3]) -> f64 {
    let n = points.len().max(1) as f64;
    let mean = points
        .iter()
        .fold(Vec3::new(0.0, 0.0, 0.0), |a, &p| a.add(p))
        .scale(1.0 / points.len() as f64);
    let (mut xx, mut xy, mut xz, mut yy, mut yz, mut zz) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for p in points {
        let v = p.sub(mean);
        xx += v.x * v.x;
        xy += v.x * v.y;
        xz += v.x * v.z;
        yy += v.y * v.y;
        yz += v.y * v.z;
        zz += v.z * v.z;
    }
    xx /= n;
    xy /= n;
    xz /= n;
    yy /= n;
    yz /= n;
    zz /= n;
    let (m00, m01, m02, m11, m12, m22) = (xx, xy, xz, yy, yz, zz);
    let p1 = m01 * m01 + m02 * m02 + m12 * m12;
    let (e_min, e_max);
    if p1 <= 1e-18 {
        let mut e = [m00, m11, m22];
        e.sort_by(|a, b| a.partial_cmp(b).unwrap());
        e_min = e[0];
        e_max = e[2];
    } else {
        let q = (m00 + m11 + m22) / 3.0;
        let p2 = (m00 - q).powi(2) + (m11 - q).powi(2) + (m22 - q).powi(2) + 2.0 * p1;
        let p = (p2 / 6.0).sqrt();
        let b00 = (m00 - q) / p;
        let b11 = (m11 - q) / p;
        let b22 = (m22 - q) / p;
        let b01 = m01 / p;
        let b02 = m02 / p;
        let b12 = m12 / p;
        let det_b = b00 * (b11 * b22 - b12 * b12) - b01 * (b01 * b22 - b12 * b02)
            + b02 * (b01 * b12 - b11 * b02);
        let r = (det_b / 2.0).clamp(-1.0, 1.0);
        let phi = r.acos() / 3.0;
        let eig1 = q + 2.0 * p * phi.cos();
        let eig3 = q + 2.0 * p * (phi + 2.0 * std::f64::consts::PI / 3.0).cos();
        let eig2 = 3.0 * q - eig1 - eig3;
        let mut ev = [eig1, eig2, eig3];
        ev.sort_by(|a, b| a.partial_cmp(b).unwrap());
        e_min = ev[0];
        e_max = ev[2];
    }
    e_min / e_max.max(1e-12)
}

/// Edge-spread check over the hull's "real" edges (those whose two incident
/// faces differ by more than EDGE_ANGLE — coplanar triangulation seams excluded).
fn edge_spread_ok(hull: &Hull, pts: &[Vec3]) -> bool {
    let cos_thr = (EDGE_ANGLE_DEG * std::f64::consts::PI / 180.0).cos();
    // Undirected edge -> the (up to two) incident face indices.
    let mut edge_faces: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
    for (fi, f) in hull.faces.iter().enumerate() {
        for e in 0..3 {
            let a = f.v[e];
            let b = f.v[(e + 1) % 3];
            let key = if a < b { (a, b) } else { (b, a) };
            edge_faces.entry(key).or_default().push(fi);
        }
    }
    let (mut min_l, mut max_l) = (f64::INFINITY, 0.0_f64);
    for ((a, b), faces) in &edge_faces {
        let include = if faces.len() >= 2 {
            hull.faces[faces[0]].normal.dot(hull.faces[faces[1]].normal) < cos_thr
        } else {
            true // boundary edge (shouldn't happen on a closed hull)
        };
        if !include {
            continue;
        }
        let l = pts[*a].dist(pts[*b]);
        if l < min_l {
            min_l = l;
        }
        if l > max_l {
            max_l = l;
        }
    }
    if !min_l.is_finite() || min_l <= 1e-9 {
        return false;
    }
    (max_l / min_l) <= MAX_EDGE_SPREAD
}

/// Farthest-point spread sampling — returns N indices into `points`.
fn pick_spread_subset(points: &[Vec3], n: usize) -> Option<Vec<usize>> {
    if points.len() < n {
        return None;
    }
    let (mut a_idx, mut b_idx, mut best) = (0usize, 1usize, -1.0_f64);
    for i in 0..points.len() {
        for j in (i + 1)..points.len() {
            let d = points[i].dist2(points[j]);
            if d > best {
                best = d;
                a_idx = i;
                b_idx = j;
            }
        }
    }
    let mut chosen = vec![a_idx, b_idx];
    while chosen.len() < n {
        let (mut best_idx, mut best_score) = (usize::MAX, f64::NEG_INFINITY);
        for i in 0..points.len() {
            if chosen.contains(&i) {
                continue;
            }
            let mut min_d = f64::INFINITY;
            for &j in &chosen {
                let d = points[i].dist2(points[j]);
                if d < min_d {
                    min_d = d;
                }
            }
            if min_d > best_score {
                best_score = min_d;
                best_idx = i;
            }
        }
        if best_idx == usize::MAX {
            break;
        }
        chosen.push(best_idx);
    }
    if chosen.len() < n {
        None
    } else {
        Some(chosen)
    }
}

fn induced_degree_ok(adjacency: &[HashSet<u32>], sel: &[u32], min_deg: usize) -> bool {
    let set: HashSet<u32> = sel.iter().cloned().collect();
    for &u in sel {
        let nb = &adjacency[u as usize];
        let mut deg = 0;
        for &v in nb {
            if v != u && set.contains(&v) {
                deg += 1;
            }
        }
        if deg < min_deg {
            return false;
        }
    }
    true
}

/// Reusable scratch for the band 2-core test, so the per-band gate allocates nothing
/// on the hot path (`local` is sized once to n_atoms; the rest are cleared, not freed).
struct KCore {
    local: Vec<i32>, // src -> local band index, else -1; restored to -1 after each call
    srcs: Vec<u32>,
    deg: Vec<usize>,
    removed: Vec<bool>,
    stack: Vec<usize>,
}

impl KCore {
    fn new(n_atoms: usize) -> KCore {
        KCore {
            local: vec![-1; n_atoms],
            srcs: Vec::new(),
            deg: Vec::new(),
            removed: Vec::new(),
            stack: Vec::new(),
        }
    }

    /// Size of the 2-core of the band's induced bond subgraph (source-level). Any accepted
    /// cage's vertices form a min-degree-≥minDeg(N)≥2 subgraph of their band, so they lie
    /// in the band's 2-core; a band whose 2-core has < 4 atoms cannot yield any cage and
    /// its convex hull can be skipped. (Necessary condition — the precise per-N
    /// `induced_degree_ok` still runs on the selected vertices.)
    fn two_core_size(&mut self, band: &[PoolEntry], adjacency: &[HashSet<u32>]) -> usize {
        self.srcs.clear();
        for e in band {
            let s = e.src as usize;
            if self.local[s] < 0 {
                self.local[s] = self.srcs.len() as i32;
                self.srcs.push(e.src);
            }
        }
        let m = self.srcs.len();
        if m < 4 {
            for &s in &self.srcs {
                self.local[s as usize] = -1;
            }
            return m;
        }
        self.deg.clear();
        self.deg.resize(m, 0);
        self.removed.clear();
        self.removed.resize(m, false);
        for i in 0..m {
            let mut d = 0;
            for &t in &adjacency[self.srcs[i] as usize] {
                let li = self.local[t as usize];
                if li >= 0 && li as usize != i {
                    d += 1;
                }
            }
            self.deg[i] = d;
        }
        self.stack.clear();
        for i in 0..m {
            if self.deg[i] < 2 {
                self.stack.push(i);
            }
        }
        let mut alive = m;
        while let Some(u) = self.stack.pop() {
            if self.removed[u] {
                continue;
            }
            self.removed[u] = true;
            alive -= 1;
            for &t in &adjacency[self.srcs[u] as usize] {
                let li = self.local[t as usize];
                if li >= 0 {
                    let v = li as usize;
                    if v != u && !self.removed[v] {
                        self.deg[v] = self.deg[v].saturating_sub(1);
                        if self.deg[v] < 2 {
                            self.stack.push(v);
                        }
                    }
                }
            }
        }
        for &s in &self.srcs {
            self.local[s as usize] = -1;
        }
        alive
    }
}

fn centered_hull_acceptable(center: Vec3, center_radius: f64, pos_list: &[Vec3]) -> bool {
    let hull = match convex_hull(pos_list) {
        Some(h) => h,
        None => return false,
    };
    let eps = 1e-6;
    let min_clearance = MIN_CENTER_FACE_CLEARANCE_REL * center_radius.max(0.0);
    for f in &hull.faces {
        let sd = Hull::face_distance(f, center);
        if sd > eps {
            return false;
        }
        if -sd < min_clearance - eps {
            return false;
        }
    }
    true
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = (sorted.len() - 1) as f64 * q;
    let i0 = i.floor() as usize;
    let i1 = (i0 + 1).min(sorted.len() - 1);
    let t = i - i0 as f64;
    sorted[i0] * (1.0 - t) + sorted[i1] * t
}

fn is_ligand_of(nbr: usize, center: usize, electroneg: &[f64], filter: bool) -> bool {
    let en_n = electroneg[nbr];
    let en_c = electroneg[center];
    if en_n == 0.0 || en_c == 0.0 || !filter {
        return nbr != center;
    }
    en_n > en_c + 1e-6
}

// ---------------------------------------------------------------------------
// Main compute
// ---------------------------------------------------------------------------

/// Phase timings produced while building candidates (the serial path keeps them for
/// the diagnostic log; the parallel path ignores them).
pub struct BuildTiming {
    pub setup_ms: f64,
    pub centered_ms: f64,
    pub cages_ms: f64,
    pub cage_pool_ms: f64,
    pub cage_band_ms: f64,
    pub cage_nloop_ms: f64,
    pub bands_built: u32,
    pub bands_skipped: u32,
}

/// Generate the (unfiltered) candidate polyhedra for the centre range
/// `[center_start,center_end)` and the seed range `[seed_start,seed_end)`. Centred
/// candidates are pushed before cage candidates, so concatenating workers' results in
/// ascending range order reproduces the serial insertion order exactly.
#[allow(clippy::too_many_arguments)]
pub fn build_candidates(
    frac: &[f64],
    elem_idx: &[u32],
    lat: &[f64],
    cutoff_matrix: &[f64],
    n_elem: usize,
    electroneg: &[f64],
    radii: &[f64],
    max_cutoff: f64,
    use_chem_filter: bool,
    detect_cages: bool,
    center_src: &[u32],
    center_shift: &[i32],
    center_cart: &[f64],
    visible_keys: &[i32],
    seed_visible: &[u8],
    center_start: usize,
    center_end: usize,
    seed_start: usize,
    seed_end: usize,
) -> (Vec<Candidate>, BuildTiming) {
    let t0 = now();
    let n_atoms = elem_idx.len();
    let cutoff = |ei: usize, ej: usize| -> f64 {
        if ei < n_elem && ej < n_elem {
            cutoff_matrix[ei * n_elem + ej]
        } else {
            0.0
        }
    };

    // Lattice rows a,b,c; frac→cart = a*fx + b*fy + c*fz; cart→frac via (Lᵀ)⁻¹.
    let a = Vec3::new(lat[0], lat[1], lat[2]);
    let b = Vec3::new(lat[3], lat[4], lat[5]);
    let c = Vec3::new(lat[6], lat[7], lat[8]);
    let mt = Matrix33::new([
        [a.x, b.x, c.x],
        [a.y, b.y, c.y],
        [a.z, b.z, c.z],
    ]);
    let mt_inv = mt.inverse().unwrap_or(Matrix33::new([[0.0; 3]; 3]));
    let frac_to_cart = |f: Vec3| a.scale(f.x).add(b.scale(f.y)).add(c.scale(f.z));
    let cart_to_frac = |p: Vec3| mt_inv.mul_vec(p);

    let positions: Vec<Vec3> = (0..n_atoms)
        .map(|i| Vec3::new(frac[3 * i], frac[3 * i + 1], frac[3 * i + 2]))
        .collect();
    let base_cart: Vec<Vec3> = positions.iter().map(|&f| frac_to_cart(f)).collect();

    // Cell widths and image-ring half-windows (same metric as the JS code).
    let cell_vol = a.dot(cross(b, c)).abs();
    let width_a = cell_vol / cross(b, c).norm().max(1e-9);
    let width_b = cell_vol / cross(c, a).norm().max(1e-9);
    let width_c = cell_vol / cross(a, b).norm().max(1e-9);
    let na = 1.max((max_cutoff / width_a.max(1e-6)).ceil() as i32);
    let nb = 1.max((max_cutoff / width_b.max(1e-6)).ceil() as i32);
    let nc = 1.max((max_cutoff / width_c.max(1e-6)).ceil() as i32);
    let r_search = search_radius(max_cutoff);
    let ma = 1.max((r_search / width_a.max(1e-6)).ceil() as i32);
    let mb = 1.max((r_search / width_b.max(1e-6)).ceil() as i32);
    let mc = 1.max((r_search / width_c.max(1e-6)).ceil() as i32);

    // Spatial grid sized by the bond radius; per-radius halos.
    let bin_radius = max_cutoff.max(1.5);
    let mut grid = Grid::build(&positions, (width_a, width_b, width_c), bin_radius);
    let bin_wa = width_a / grid.gx as f64;
    let bin_wb = width_b / grid.gy as f64;
    let bin_wc = width_c / grid.gz as f64;
    let nb_halo = (
        (max_cutoff / bin_wa).floor() as i32 + 1,
        (max_cutoff / bin_wb).floor() as i32 + 1,
        (max_cutoff / bin_wc).floor() as i32 + 1,
    );
    let gw_halo = (
        (r_search / bin_wa).floor() as i32 + 1,
        (r_search / bin_wb).floor() as i32 + 1,
        (r_search / bin_wc).floor() as i32 + 1,
    );

    // Visible image set + per-source counts not needed beyond membership here.
    let mut visible: HashSet<Key> = HashSet::new();
    for chunk in visible_keys.chunks_exact(4) {
        visible.insert((chunk[0] as u32, chunk[1], chunk[2], chunk[3]));
    }

    let mut scratch: Vec<usize> = Vec::new();

    // neighborImages(P, elem) — bonded images within cutoff.
    let neighbor_images = |grid: &mut Grid, scratch: &mut Vec<usize>, p: Vec3, ei: usize| -> Vec<Neighbor> {
        let fp = cart_to_frac(p);
        grid.candidates(fp, nb_halo.0, nb_halo.1, nb_halo.2, scratch);
        let mut out = Vec::new();
        for &j in scratch.iter() {
            let cut = cutoff(ei, elem_idx[j] as usize);
            if cut <= 1e-3 {
                continue;
            }
            let fj = positions[j];
            let c0 = (fp.x - fj.x).round() as i32;
            let c1 = (fp.y - fj.y).round() as i32;
            let c2 = (fp.z - fj.z).round() as i32;
            for dx in (c0 - na)..=(c0 + na) {
                for dy in (c1 - nb)..=(c1 + nb) {
                    for dz in (c2 - nc)..=(c2 + nc) {
                        let q = base_cart[j]
                            .add(a.scale(dx as f64))
                            .add(b.scale(dy as f64))
                            .add(c.scale(dz as f64));
                        let d = q.dist(p);
                        if d > cut || d < 1e-4 {
                            continue;
                        }
                        out.push(Neighbor {
                            src_j: j as u32,
                            shift: [dx, dy, dz],
                            pos: q,
                        });
                    }
                }
            }
        }
        out
    };

    // gatherWithin(P) — all images within the search radius (any species).
    let gather_within = |grid: &mut Grid, scratch: &mut Vec<usize>, p: Vec3| -> Vec<Cand> {
        let fp = cart_to_frac(p);
        grid.candidates(fp, gw_halo.0, gw_halo.1, gw_halo.2, scratch);
        let mut out = Vec::new();
        for &j in scratch.iter() {
            let fj = positions[j];
            let c0 = (fp.x - fj.x).round() as i32;
            let c1 = (fp.y - fj.y).round() as i32;
            let c2 = (fp.z - fj.z).round() as i32;
            for dx in (c0 - ma)..=(c0 + ma) {
                for dy in (c1 - mb)..=(c1 + mb) {
                    for dz in (c2 - mc)..=(c2 + mc) {
                        let q = base_cart[j]
                            .add(a.scale(dx as f64))
                            .add(b.scale(dy as f64))
                            .add(c.scale(dz as f64));
                        let d = q.dist(p);
                        if d > r_search || d < 1e-4 {
                            continue;
                        }
                        let ej = elem_idx[j] as usize;
                        out.push(Cand {
                            src_j: j as u32,
                            shift: [dx, dy, dz],
                            pos: q,
                            d,
                            elem: ej,
                            radius: if ej < n_elem { radii[ej] } else { 1.0 },
                        });
                    }
                }
            }
        }
        out
    };

    // Base neighbours + adjacency (cage path only).
    let mut base_neighbors: Vec<Vec<Neighbor>> = Vec::new();
    let mut adjacency: Vec<HashSet<u32>> = vec![HashSet::new(); n_atoms];
    if detect_cages {
        base_neighbors = Vec::with_capacity(n_atoms);
        for i in 0..n_atoms {
            let nbrs = neighbor_images(&mut grid, &mut scratch, base_cart[i], elem_idx[i] as usize);
            for o in &nbrs {
                adjacency[i].insert(o.src_j);
                adjacency[o.src_j as usize].insert(i as u32);
            }
            base_neighbors.push(nbrs);
        }
    }

    let t_setup = now();
    let mut candidates: Vec<Candidate> = Vec::new();
    // Diagnostics (cheap counters; the gate's effectiveness on this structure).
    let mut bands_built: u32 = 0;
    let mut bands_skipped: u32 = 0;

    // ---- Centered ----
    for ci in center_start..center_end {
        let src = center_src[ci];
        let shift = [center_shift[3 * ci], center_shift[3 * ci + 1], center_shift[3 * ci + 2]];
        let center_pos = Vec3::new(center_cart[3 * ci], center_cart[3 * ci + 1], center_cart[3 * ci + 2]);
        let center_elem = elem_idx[src as usize] as usize;

        let mut cands = gather_within(&mut grid, &mut scratch, center_pos);
        if cands.len() < 4 {
            continue;
        }
        // Keep only the nearest VORONOI_MAX_CANDS (farther atoms are shadowed and
        // never form a cell face) so the dual hull stays small.
        if cands.len() > VORONOI_MAX_CANDS {
            cands.sort_by(|x, y| x.d.partial_cmp(&y.d).unwrap_or(std::cmp::Ordering::Equal));
            cands.truncate(VORONOI_MAX_CANDS);
        }
        let center_radius = if center_elem < n_elem { radii[center_elem] } else { 1.0 };
        let accept = |cand: &Cand| -> bool {
            if !is_ligand_of(cand.elem, center_elem, electroneg, use_chem_filter) {
                return false;
            }
            let cut = cutoff(center_elem, cand.elem);
            cut > 1e-3 && cand.d <= cut
        };
        let vor = voronoi_neighbours(center_pos, &cands, center_radius, &accept);

        // Keep one entry per visible image (nearest), discard non-displayed ghosts.
        let mut by_image: HashMap<Key, usize> = HashMap::new();
        let mut order: Vec<Key> = Vec::new();
        for &k in &vor {
            let cand = &cands[k];
            let key = image_key(cand.src_j, cand.shift);
            if !visible.contains(&key) {
                continue;
            }
            match by_image.get(&key) {
                Some(&prev) if cands[prev].d <= cand.d => {}
                Some(_) => {
                    by_image.insert(key, k);
                }
                None => {
                    by_image.insert(key, k);
                    order.push(key);
                }
            }
        }
        if order.len() < 4 {
            continue;
        }
        let entries: Vec<&Cand> = order.iter().map(|key| &cands[by_image[key]]).collect();
        let pos_list: Vec<Vec3> = entries.iter().map(|e| e.pos).collect();
        if thickness_ratio(&pos_list) < MIN_THICKNESS_RATIO {
            continue;
        }
        if !centered_hull_acceptable(center_pos, center_radius, &pos_list) {
            continue;
        }
        candidates.push(Candidate {
            is_cage: false,
            color_elem: center_elem as u32,
            center_src: src as i32,
            center_shift: shift,
            vertex_src_list: entries.iter().map(|e| e.src_j).collect(),
            vertex_image_list: Vec::new(),
            ref_point: center_pos,
            pos_list,
        });
    }

    let t_centered = now();

    // ---- Cages ----
    let mut cage_pool_ms = 0.0_f64;
    let mut cage_band_ms = 0.0_f64;
    let mut cage_nloop_ms = 0.0_f64;
    if detect_cages {
        // Buffers reused across seeds (cleared, not reallocated).
        let mut visited_set: HashSet<Key> = HashSet::new();
        let mut order: Vec<PoolEntry> = Vec::new();
        let mut frontier: Vec<PoolEntry> = Vec::new();
        let mut next_frontier: Vec<PoolEntry> = Vec::new();
        let mut kcore = KCore::new(n_atoms);

        for seed in seed_start..seed_end {
            if seed_visible[seed] == 0 {
                continue;
            }
            let seed_elem = elem_idx[seed] as u32;

            // Frontier BFS in image space: always reach depth 3, then keep going
            // until ≥40 visible images or CAGE_BFS_DEPTH. The visible count is
            // tracked incrementally, so we never re-scan/clone the pool mid-expand.
            let tp = now();
            visited_set.clear();
            order.clear();
            frontier.clear();
            let start = PoolEntry { pos: base_cart[seed], src: seed as u32, shift: [0, 0, 0] };
            visited_set.insert(image_key(seed as u32, [0, 0, 0]));
            order.push(start.clone());
            frontier.push(start);
            let mut depth = 0;
            let mut visible_count =
                if visible.contains(&image_key(seed as u32, [0, 0, 0])) { 1 } else { 0 };

            while !frontier.is_empty()
                && depth < CAGE_BFS_DEPTH
                && (depth < 3 || visible_count < 40)
            {
                next_frontier.clear();
                for node in frontier.iter() {
                    let (sx, sy, sz) = (node.shift[0], node.shift[1], node.shift[2]);
                    for o in &base_neighbors[node.src as usize] {
                        let nshift = [o.shift[0] + sx, o.shift[1] + sy, o.shift[2] + sz];
                        let key = image_key(o.src_j, nshift);
                        if visited_set.insert(key) {
                            let pos = base_cart[o.src_j as usize]
                                .add(a.scale(nshift[0] as f64))
                                .add(b.scale(nshift[1] as f64))
                                .add(c.scale(nshift[2] as f64));
                            if visible.contains(&key) {
                                visible_count += 1;
                            }
                            let e = PoolEntry { pos, src: o.src_j, shift: nshift };
                            order.push(e.clone());
                            next_frontier.push(e);
                        }
                    }
                }
                std::mem::swap(&mut frontier, &mut next_frontier);
                depth += 1;
            }

            let mut pool: Vec<PoolEntry> = order
                .iter()
                .filter(|e| visible.contains(&image_key(e.src, e.shift)))
                .cloned()
                .collect();
            cage_pool_ms += now() - tp;
            if pool.len() < 4 {
                continue;
            }

            let mean = |p: &[PoolEntry]| {
                p.iter()
                    .fold(Vec3::new(0.0, 0.0, 0.0), |acc, e| acc.add(e.pos))
                    .scale(1.0 / p.len() as f64)
            };
            let mut centroid = mean(&pool);
            if pool.len() > POOL_CAP {
                pool.sort_by(|x, y| {
                    x.pos
                        .dist2(centroid)
                        .partial_cmp(&y.pos.dist2(centroid))
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                pool.truncate(POOL_CAP);
                centroid = mean(&pool);
            }
            let mut dists: Vec<f64> = pool.iter().map(|e| e.pos.dist(centroid)).collect();
            dists.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let bands = [
                (quantile(&dists, 0.30), quantile(&dists, 0.70)),
                (quantile(&dists, 0.25), quantile(&dists, 0.75)),
                (quantile(&dists, 0.20), quantile(&dists, 0.80)),
            ];

            // Per-band hull vertex sets (N-independent), built once. `spread_order`
            // is the full farthest-first ordering of the hull vertices; since that
            // traversal is prefix-stable, the reduce-to-N step for every target N
            // is just a prefix of it — so it's computed once here instead of being
            // recomputed per N below.
            struct BandHull {
                band: Vec<PoolEntry>,
                base_verts: Vec<PoolEntry>,
                spread_order: Vec<usize>,
            }
            let tb = now();
            let mut band_hulls: Vec<BandHull> = Vec::with_capacity(bands.len());
            for &(lo, hi) in &bands {
                let band: Vec<PoolEntry> = pool
                    .iter()
                    .filter(|e| {
                        let r = e.pos.dist(centroid);
                        r >= lo && r <= hi
                    })
                    .cloned()
                    .collect();
                if band.len() < 4 {
                    band_hulls.push(BandHull { band, base_verts: Vec::new(), spread_order: Vec::new() });
                    continue;
                }
                // Necessary condition: a cage needs ≥4 atoms each bonded to ≥2 others
                // in the set, so a band whose induced bond 2-core is smaller can never
                // yield a cage — skip its (expensive) convex hull. Coordination shells
                // (no ligand–ligand bonds) have an empty 2-core and are skipped here.
                let core = kcore.two_core_size(&band, &adjacency);
                if core < 4 {
                    bands_skipped += 1;
                    band_hulls.push(BandHull { band, base_verts: Vec::new(), spread_order: Vec::new() });
                    continue;
                }
                bands_built += 1;
                let pts: Vec<Vec3> = band.iter().map(|e| e.pos).collect();
                let base_verts: Vec<PoolEntry> = match convex_hull(&pts) {
                    Some(h) => h.vertices.iter().map(|&vi| band[vi].clone()).collect(),
                    None => Vec::new(),
                };
                let spread_order = if base_verts.len() >= 2 {
                    let bv_pts: Vec<Vec3> = base_verts.iter().map(|e| e.pos).collect();
                    pick_spread_subset(&bv_pts, base_verts.len()).unwrap_or_default()
                } else {
                    Vec::new()
                };
                band_hulls.push(BandHull { band, base_verts, spread_order });
            }
            cage_band_ms += now() - tb;

            let tn = now();
            for &target in &CAGE_TARGET_NS_DESC {
                let mut built = false;
                for bh in &band_hulls {
                    if bh.band.len() < target || bh.base_verts.len() < target {
                        continue;
                    }
                    // Reduce to N by spread if needed — a prefix of the band's
                    // precomputed farthest-first ordering. The ordering indexes
                    // base_verts directly (which are band entries), so no nearest
                    // remapping is needed.
                    let verts: Vec<PoolEntry> = if bh.base_verts.len() == target {
                        bh.base_verts.clone()
                    } else {
                        if bh.spread_order.len() < target {
                            continue;
                        }
                        bh.spread_order[0..target]
                            .iter()
                            .map(|&si| bh.base_verts[si].clone())
                            .collect()
                    };

                    let pos_list: Vec<Vec3> = verts.iter().map(|e| e.pos).collect();
                    let sel_srcs: Vec<u32> = verts.iter().map(|e| e.src).collect();

                    // Cheap rejections first.
                    if thickness_ratio(&pos_list) < 0.08 {
                        continue;
                    }
                    let min_deg = min_vertex_degree_for_cage_size(pos_list.len());
                    if !induced_degree_ok(&adjacency, &sel_srcs, min_deg) {
                        continue;
                    }
                    let hull = match convex_hull(&pos_list) {
                        Some(h) => h,
                        None => continue,
                    };
                    if !edge_spread_ok(&hull, &pos_list) {
                        continue;
                    }

                    let ref_point = pos_list
                        .iter()
                        .fold(Vec3::new(0.0, 0.0, 0.0), |acc, &p| acc.add(p))
                        .scale(1.0 / pos_list.len() as f64);
                    candidates.push(Candidate {
                        is_cage: true,
                        color_elem: seed_elem,
                        center_src: -1,
                        center_shift: [0, 0, 0],
                        vertex_image_list: verts.iter().map(|e| (e.src, e.shift)).collect(),
                        vertex_src_list: sel_srcs,
                        ref_point,
                        pos_list,
                    });
                    built = true;
                    break;
                }
                let _ = built;
            }
            cage_nloop_ms += now() - tn;
        }
    }

    let t_cages = now();

    let timing = BuildTiming {
        setup_ms: t_setup - t0,
        centered_ms: t_centered - t_setup,
        cages_ms: t_cages - t_centered,
        cage_pool_ms,
        cage_band_ms,
        cage_nloop_ms,
        bands_built,
        bands_skipped,
    };
    (candidates, timing)
}

/// The bare accepted-polyhedra output (no timing).
pub struct AcceptOutput {
    pub kinds: Vec<u32>,
    pub color_elem: Vec<u32>,
    pub center_src: Vec<i32>,
    pub vert_counts: Vec<u32>,
    pub vertices: Vec<f64>,
    pub vertex_srcs: Vec<u32>,
}

/// Global acceptance: sort (larger-first, with the centred/cage tie rules), then keep a
/// candidate only if it isn't nested in an already-accepted hull and (for cages) uses no
/// already-accepted centre image. Order-sensitive — `candidates` must be in serial order.
pub fn accept(mut candidates: Vec<Candidate>) -> AcceptOutput {
    candidates.sort_by(|x, y| {
        let (na, nb) = (x.pos_list.len(), y.pos_list.len());
        if na != nb {
            return nb.cmp(&na); // larger first
        }
        if na >= 12 && x.is_cage != y.is_cage {
            // large shells: cages first
            return if x.is_cage {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        if x.is_cage != y.is_cage {
            // otherwise centered first
            return if !x.is_cage {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        std::cmp::Ordering::Equal
    });

    let mut accepted_center_keys: HashSet<Key> = HashSet::new();
    let mut accepted_hulls: Vec<Hull> = Vec::new();
    let mut out = AcceptOutput {
        kinds: Vec::new(),
        color_elem: Vec::new(),
        center_src: Vec::new(),
        vert_counts: Vec::new(),
        vertices: Vec::new(),
        vertex_srcs: Vec::new(),
    };

    for cand in &candidates {
        if cand.is_cage {
            let conflict = cand
                .vertex_image_list
                .iter()
                .any(|&(s, sh)| accepted_center_keys.contains(&image_key(s, sh)));
            if conflict {
                continue;
            }
        }
        let hull = match convex_hull(&cand.pos_list) {
            Some(h) => h,
            None => continue,
        };
        let inside = accepted_hulls.iter().any(|h| h.contains(cand.ref_point, 1e-6));
        if inside {
            continue;
        }

        out.kinds.push(if cand.is_cage { 1 } else { 0 });
        out.color_elem.push(cand.color_elem);
        out.center_src.push(if cand.is_cage { -1 } else { cand.center_src });
        out.vert_counts.push(cand.pos_list.len() as u32);
        for p in &cand.pos_list {
            out.vertices.push(p.x);
            out.vertices.push(p.y);
            out.vertices.push(p.z);
        }
        for &s in &cand.vertex_src_list {
            out.vertex_srcs.push(s);
        }

        if !cand.is_cage {
            accepted_center_keys.insert(image_key(cand.center_src as u32, cand.center_shift));
        }
        accepted_hulls.push(hull);
    }

    out
}

/// Serial entry: build all candidates then accept, with full timing for the diagnostic log.
#[allow(clippy::too_many_arguments)]
pub fn compute_polyhedra(
    frac: &[f64],
    elem_idx: &[u32],
    lat: &[f64],
    cutoff_matrix: &[f64],
    n_elem: usize,
    electroneg: &[f64],
    radii: &[f64],
    max_cutoff: f64,
    use_chem_filter: bool,
    detect_cages: bool,
    center_src: &[u32],
    center_shift: &[i32],
    center_cart: &[f64],
    visible_keys: &[i32],
    seed_visible: &[u8],
) -> ComputedPolyhedra {
    let n_atoms = elem_idx.len();
    let n_centers = center_src.len();
    let (candidates, bt) = build_candidates(
        frac, elem_idx, lat, cutoff_matrix, n_elem, electroneg, radii, max_cutoff,
        use_chem_filter, detect_cages, center_src, center_shift, center_cart, visible_keys,
        seed_visible, 0, n_centers, 0, n_atoms,
    );
    let ta = now();
    let acc = accept(candidates);
    let accept_ms = now() - ta;
    ComputedPolyhedra {
        kinds: acc.kinds,
        color_elem: acc.color_elem,
        center_src: acc.center_src,
        vert_counts: acc.vert_counts,
        vertices: acc.vertices,
        vertex_srcs: acc.vertex_srcs,
        setup_ms: bt.setup_ms,
        centered_ms: bt.centered_ms,
        cages_ms: bt.cages_ms,
        cage_pool_ms: bt.cage_pool_ms,
        cage_band_ms: bt.cage_band_ms,
        cage_nloop_ms: bt.cage_nloop_ms,
        accept_ms,
        bands_built: bt.bands_built,
        bands_skipped: bt.bands_skipped,
    }
}

/// Flat, JS-marshallable form of a candidate list. Centred candidates precede cage ones;
/// `n_centered` records the split so workers' results can be regrouped in serial order.
pub struct CandidateFlat {
    pub is_cage: Vec<u8>,
    pub color_elem: Vec<u32>,
    pub center_src: Vec<i32>,
    pub center_shift: Vec<i32>, // 3 per candidate
    pub ref_point: Vec<f64>,    // 3 per candidate
    pub vert_counts: Vec<u32>,
    pub vertices: Vec<f64>,     // 3 per vertex
    pub vertex_srcs: Vec<u32>,  // 1 per vertex
    pub vertex_shifts: Vec<i32>, // 3 per vertex (meaningful for cages)
    pub n_centered: u32,
}

pub fn flatten_candidates(candidates: &[Candidate]) -> CandidateFlat {
    let mut f = CandidateFlat {
        is_cage: Vec::new(),
        color_elem: Vec::new(),
        center_src: Vec::new(),
        center_shift: Vec::new(),
        ref_point: Vec::new(),
        vert_counts: Vec::new(),
        vertices: Vec::new(),
        vertex_srcs: Vec::new(),
        vertex_shifts: Vec::new(),
        n_centered: 0,
    };
    for c in candidates {
        if !c.is_cage {
            f.n_centered += 1;
        }
        f.is_cage.push(c.is_cage as u8);
        f.color_elem.push(c.color_elem);
        f.center_src.push(c.center_src);
        f.center_shift.extend_from_slice(&c.center_shift);
        f.ref_point.extend_from_slice(&[c.ref_point.x, c.ref_point.y, c.ref_point.z]);
        f.vert_counts.push(c.pos_list.len() as u32);
        for (vi, p) in c.pos_list.iter().enumerate() {
            f.vertices.extend_from_slice(&[p.x, p.y, p.z]);
            f.vertex_srcs.push(c.vertex_src_list[vi]);
            // Per-vertex shift: present for cages (center-not-corner needs it), 0 otherwise.
            let sh = c.vertex_image_list.get(vi).map(|&(_, s)| s).unwrap_or([0, 0, 0]);
            f.vertex_shifts.extend_from_slice(&sh);
        }
    }
    f
}

/// Inverse of `flatten_candidates` over a concatenation of worker results (already in
/// serial order). Slices are the flat arrays defined on `CandidateFlat`.
#[allow(clippy::too_many_arguments)]
pub fn unflatten_candidates(
    is_cage: &[u8],
    color_elem: &[u32],
    center_src: &[i32],
    center_shift: &[i32],
    ref_point: &[f64],
    vert_counts: &[u32],
    vertices: &[f64],
    vertex_srcs: &[u32],
    vertex_shifts: &[i32],
) -> Vec<Candidate> {
    let mut out = Vec::with_capacity(vert_counts.len());
    let mut voff = 0usize; // vertex offset
    for ci in 0..vert_counts.len() {
        let cage = is_cage[ci] != 0;
        let n = vert_counts[ci] as usize;
        let mut pos_list = Vec::with_capacity(n);
        let mut vertex_src_list = Vec::with_capacity(n);
        let mut vertex_image_list = Vec::new();
        for k in 0..n {
            let v = voff + k;
            pos_list.push(Vec3::new(vertices[3 * v], vertices[3 * v + 1], vertices[3 * v + 2]));
            vertex_src_list.push(vertex_srcs[v]);
            if cage {
                vertex_image_list.push((
                    vertex_srcs[v],
                    [vertex_shifts[3 * v], vertex_shifts[3 * v + 1], vertex_shifts[3 * v + 2]],
                ));
            }
        }
        voff += n;
        out.push(Candidate {
            is_cage: cage,
            color_elem: color_elem[ci],
            center_src: center_src[ci],
            center_shift: [center_shift[3 * ci], center_shift[3 * ci + 1], center_shift[3 * ci + 2]],
            pos_list,
            vertex_src_list,
            vertex_image_list,
            ref_point: Vec3::new(ref_point[3 * ci], ref_point[3 * ci + 1], ref_point[3 * ci + 2]),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cation octahedrally coordinated by 6 anions in a roomy 20 Å cell (no periodic
    /// images in range). Produces exactly one centred CN-6 polyhedron.
    struct Inputs {
        frac: Vec<f64>,
        elem: Vec<u32>,
        lat: Vec<f64>,
        cutoff: Vec<f64>,
        n_elem: usize,
        electroneg: Vec<f64>,
        radii: Vec<f64>,
        max_cutoff: f64,
        center_src: Vec<u32>,
        center_shift: Vec<i32>,
        center_cart: Vec<f64>,
        visible_keys: Vec<i32>,
        seed_visible: Vec<u8>,
    }

    fn octahedron() -> Inputs {
        let l = 20.0;
        // cation at centre, 6 anions ±2 Å along each axis.
        let frac = vec![
            0.5, 0.5, 0.5, // cation
            0.6, 0.5, 0.5, 0.4, 0.5, 0.5, // ±x
            0.5, 0.6, 0.5, 0.5, 0.4, 0.5, // ±y
            0.5, 0.5, 0.6, 0.5, 0.5, 0.4, // ±z
        ];
        let n = 7;
        let elem = vec![0u32, 1, 1, 1, 1, 1, 1];
        let lat = vec![l, 0.0, 0.0, 0.0, l, 0.0, 0.0, 0.0, l];
        // cutoff matrix 2×2: only cation(0)-anion(1) bond.
        let cutoff = vec![0.0, 2.5, 2.5, 0.0];
        let electroneg = vec![1.0, 3.0];
        let radii = vec![1.0, 1.0];
        let mut center_cart = vec![0.0; 3 * n];
        for i in 0..n {
            for d in 0..3 {
                center_cart[3 * i + d] = frac[3 * i + d] * l;
            }
        }
        let center_src: Vec<u32> = (0..n as u32).collect();
        let center_shift = vec![0i32; 3 * n];
        let mut visible_keys = Vec::new();
        for i in 0..n as i32 {
            visible_keys.extend_from_slice(&[i, 0, 0, 0]);
        }
        Inputs {
            frac,
            elem,
            lat,
            cutoff,
            n_elem: 2,
            electroneg,
            radii,
            max_cutoff: 2.5,
            center_src,
            center_shift,
            center_cart,
            visible_keys,
            seed_visible: vec![1u8; n],
        }
    }

    fn build(inp: &Inputs, cs: usize, ce: usize, ss: usize, se: usize) -> Vec<Candidate> {
        build_candidates(
            &inp.frac, &inp.elem, &inp.lat, &inp.cutoff, inp.n_elem, &inp.electroneg, &inp.radii,
            inp.max_cutoff, true, true, &inp.center_src, &inp.center_shift, &inp.center_cart,
            &inp.visible_keys, &inp.seed_visible, cs, ce, ss, se,
        )
        .0
    }

    fn assert_same(a: &AcceptOutput, b: &AcceptOutput) {
        assert_eq!(a.kinds, b.kinds, "kinds");
        assert_eq!(a.color_elem, b.color_elem, "color_elem");
        assert_eq!(a.center_src, b.center_src, "center_src");
        assert_eq!(a.vert_counts, b.vert_counts, "vert_counts");
        assert_eq!(a.vertex_srcs, b.vertex_srcs, "vertex_srcs");
        assert_eq!(a.vertices, b.vertices, "vertices");
    }

    /// Merge partitioned candidates into serial order (all centred, then all cage).
    fn merge_serial(parts: Vec<Vec<Candidate>>) -> Vec<Candidate> {
        let mut centered = Vec::new();
        let mut cage = Vec::new();
        for p in parts {
            for c in p {
                if c.is_cage {
                    cage.push(c);
                } else {
                    centered.push(c);
                }
            }
        }
        centered.extend(cage);
        centered
    }

    #[test]
    fn octahedron_is_found() {
        let inp = octahedron();
        let out = accept(build(&inp, 0, 7, 0, 7));
        assert_eq!(out.kinds, vec![0]); // one centred polyhedron
        assert_eq!(out.center_src, vec![0]); // around the cation
        assert_eq!(out.vert_counts, vec![6]); // CN-6
    }

    #[test]
    fn partitioned_matches_serial() {
        let inp = octahedron();
        let full = accept(build(&inp, 0, 7, 0, 7));
        // Split centres and seeds into two ranges.
        let p0 = build(&inp, 0, 3, 0, 3);
        let p1 = build(&inp, 3, 7, 3, 7);
        let merged = accept(merge_serial(vec![p0, p1]));
        assert_same(&full, &merged);
    }

    #[test]
    fn flatten_roundtrip_matches() {
        let inp = octahedron();
        let cands = build(&inp, 0, 7, 0, 7);
        let full = accept(build(&inp, 0, 7, 0, 7));
        let f = flatten_candidates(&cands);
        let restored = unflatten_candidates(
            &f.is_cage, &f.color_elem, &f.center_src, &f.center_shift, &f.ref_point,
            &f.vert_counts, &f.vertices, &f.vertex_srcs, &f.vertex_shifts,
        );
        assert_same(&full, &accept(restored));
    }

    #[test]
    fn flatten_roundtrip_preserves_cage_shifts() {
        // A hand-built cage candidate with non-zero per-vertex shifts must survive the
        // flatten/unflatten marshalling (the center-not-corner test depends on it).
        let cand = Candidate {
            is_cage: true,
            color_elem: 5,
            center_src: -1,
            center_shift: [0, 0, 0],
            pos_list: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
                Vec3::new(0.0, 0.0, 1.0),
            ],
            vertex_src_list: vec![3, 7, 2, 9],
            vertex_image_list: vec![(3, [1, 0, 0]), (7, [0, -1, 0]), (2, [0, 0, 1]), (9, [1, 1, -1])],
            ref_point: Vec3::new(0.25, 0.25, 0.25),
        };
        let f = flatten_candidates(std::slice::from_ref(&cand));
        let r = unflatten_candidates(
            &f.is_cage, &f.color_elem, &f.center_src, &f.center_shift, &f.ref_point,
            &f.vert_counts, &f.vertices, &f.vertex_srcs, &f.vertex_shifts,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].vertex_image_list, cand.vertex_image_list);
        assert_eq!(r[0].vertex_src_list, cand.vertex_src_list);
        assert_eq!(r[0].color_elem, cand.color_elem);
        assert!(r[0].is_cage);
    }
}
