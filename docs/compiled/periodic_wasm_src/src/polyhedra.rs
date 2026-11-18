//! Rust port of `computePolyhedra` (docs/render/PolyhedraModule.js). The JS side
//! prepares the cheap, display-coupled inputs (visible centre images, visible
//! image keys, cutoff/electronegativity/radius tables) and this does the heavy
//! geometry: cell-list neighbour search, radical-Voronoi coordination selection,
//! cage detection, and the global acceptance/nesting pass. Output is a flat set
//! of accepted polyhedra (vertices in Cartesian) that JS turns into the model.

use crate::cell_list::{BinMode, CellList};
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

// ---- Behaviour constants (mirror the JS module) ----
// Cages: empty shells of mutually bonded framework atoms, found from the empty
// space (see the cage block in build_candidates; mirrors findCages() and its
// CAGE_* constants in docs/render/PolyhedraModule.js).
const CAGE_GRID_STEP: f64 = 0.4;
const CAGE_GRID_MAX_POINTS: f64 = 400000.0;
const CAGE_SPLAT_RADIUS: f64 = 4.5;
const CAGE_MIN_VOID: f64 = 0.7;
const CAGE_SHELL_TOL: f64 = 1.35;
const CAGE_SHELL_PAD: f64 = 0.6;
const CAGE_SHELL_CAP: f64 = 6.5;
const CAGE_REFINE_ITERS: usize = 8;
const CAGE_MIN_SURFACE_SHARE: f64 = 0.6;
const CAGE_MIN_THICKNESS: f64 = 0.15;
const MIN_THICKNESS_RATIO: f64 = 0.08;
const MIN_CENTER_FACE_CLEARANCE_REL: f64 = 0.10;
const VORONOI_SOLID_ANGLE_REL: f64 = 0.10;

#[inline]
fn search_radius(max_cutoff: f64) -> f64 {
    8.0_f64.min(4.0_f64.max(2.5 * max_cutoff))
}

/// Nesting margin (Å): a point is inside a hull only when it is at least this far
/// inside every face. A point ON a face (MnAlCu2's Al centre is a corner of the
/// Mn polyhedron) is not nested; at a 1e-6 tolerance rounding decided it and the
/// JS and WASM paths kept different polyhedra. Mirrors NEST_MARGIN in
/// docs/render/PolyhedraModule.js.
const NEST_MARGIN: f64 = 0.01;

/// Slack on the candidate–anion bond in `is_bridged_cation`: the anion already
/// sits between candidate and centre, so this only reaches bonds the default
/// cutoffs make too short (Pb–O 2.9 Å in PbZrO3 vs a 2.54 Å cutoff). Mirrors
/// BRIDGE_BOND_SLACK in docs/render/PolyhedraModule.js.
const BRIDGE_BOND_SLACK: f64 = 1.25;

/// How much nearer the bridging anion must be than the candidate (see
/// `is_bridged_cation`). Mirrors BRIDGE_NEARER in docs/render/PolyhedraModule.js.
const BRIDGE_NEARER: f64 = 0.9;

type Key = (u32, i32, i32, i32);

#[inline]
fn image_key(src: u32, shift: [i32; 3]) -> Key {
    (src, shift[0], shift[1], shift[2])
}

#[inline]
fn point_cut_by_planes(position: Vec3, cut_planes: &[f64], cut_plane_count: usize) -> bool {
    for i in 0..cut_plane_count {
        let off = 5 * i;
        let nx = cut_planes[off];
        let ny = cut_planes[off + 1];
        let nz = cut_planes[off + 2];
        let r = cut_planes[off + 3];
        let mask_sign = cut_planes[off + 4];
        let plane_side = ((position.x * nx) + (position.y * ny) + (position.z * nz) - r) * mask_sign;
        if plane_side > 0.0 {
            return true;
        }
    }
    false
}

#[inline]
fn atom_image_visible(
    position: Vec3,
    src: u32,
    cut_plane_immune: &[u8],
    cut_planes: &[f64],
    cut_plane_count: usize,
) -> bool {
    if cut_plane_count == 0 {
        return true;
    }
    if cut_plane_immune.get(src as usize).copied().unwrap_or(0) != 0 {
        return true;
    }
    !point_cut_by_planes(position, cut_planes, cut_plane_count)
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

// The neighbour search uses the shared CellList in periodic (fractional) mode; see
// `cell_list.rs`. Grid dimensions are derived from the cell widths and bond radius below.

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

fn is_ligand_of(nbr: usize, center: usize, electroneg: &[f64], filter: bool) -> bool {
    let en_n = electroneg[nbr];
    let en_c = electroneg[center];
    if en_n == 0.0 || en_c == 0.0 || !filter {
        return nbr != center;
    }
    en_n > en_c + 1e-6
}

/// Second-shell cation: `cand` is bonded to a more electronegative ANION FORMER
/// (a nonmetal or metalloid, `anion_former[elem] != 0`) that sits clearly nearer
/// to the centre (d < BRIDGE_NEARER × cand.d), so it is a neighbouring cation
/// seen THROUGH that anion (Ca–O–Si in diopside, whose Ca polyhedron got 17
/// corners without this). Over 313 test structures cations behind an anion sat
/// at ratios ≤ 0.882, atoms of one anionic layer (LiBC's B and C) at ≥ 0.92. A
/// partner farther out (Fe–C≡N, M–C≡O) or a metal partner (alloys) never
/// counts. The bond gets BRIDGE_BOND_SLACK (Pb–O 2.9 Å vs a 2.54 Å cutoff).
/// Mirrors isBridgedCation in docs/render/PolyhedraModule.js.
fn is_bridged_cation(
    cand: &Cand,
    cands: &[Cand],
    electroneg: &[f64],
    anion_former: &[u8],
    cutoff: &dyn Fn(usize, usize) -> f64,
) -> bool {
    let en_b = electroneg.get(cand.elem).copied().unwrap_or(0.0);
    if en_b == 0.0 {
        return false;
    }
    cands.iter().any(|x| {
        if std::ptr::eq(x, cand) || anion_former.get(x.elem).copied().unwrap_or(0) == 0 {
            return false;
        }
        let en_x = electroneg.get(x.elem).copied().unwrap_or(0.0);
        if en_x == 0.0 || en_x <= en_b + 1e-6 {
            return false;
        }
        if !(x.d < BRIDGE_NEARER * cand.d) {
            return false;
        }
        let cut = cutoff(cand.elem, x.elem);
        cut > 1e-3 && x.pos.sub(cand.pos).norm() <= cut * BRIDGE_BOND_SLACK
    })
}

/// Framework bond for cage detection (chemical filter on): nonmetal–nonmetal
/// (Si–Si, B–B, C–C, P–P), or metal–metal unless both atoms bond to one more
/// electronegative anion former (two cations sharing an anion, Ti–O–Ti, which the
/// default cutoffs also call a bond). A metal–nonmetal bond is a coordination
/// bond, never framework. `nbr_i` are atom i's neighbour images, `pos_j` the
/// image of j. Mirrors isFrameworkBond in docs/render/PolyhedraModule.js.
fn is_framework_bond(
    ei: usize,
    ej: usize,
    nbr_i: &[Neighbor],
    pos_j: Vec3,
    elem_idx: &[u32],
    electroneg: &[f64],
    anion_former: &[u8],
    cutoff: &dyn Fn(usize, usize) -> f64,
) -> bool {
    let af = |e: usize| anion_former.get(e).copied().unwrap_or(0) != 0;
    let en = |e: usize| electroneg.get(e).copied().unwrap_or(0.0);
    if af(ei) != af(ej) {
        return false;
    }
    if af(ei) {
        return true;
    }
    let en_max = en(ei).max(en(ej));
    !nbr_i.iter().any(|x| {
        let ex = elem_idx[x.src_j as usize] as usize;
        if !af(ex) || en(ex) <= en_max + 1e-6 {
            return false;
        }
        let cut = cutoff(ej, ex);
        cut > 1e-3 && x.pos.sub(pos_j).norm() <= cut
    })
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
    anion_former: &[u8],
    radii: &[f64],
    max_cutoff: f64,
    use_chem_filter: bool,
    detect_cages: bool,
    center_src: &[u32],
    center_shift: &[i32],
    center_cart: &[f64],
    center_keys: &[i32],
    seed_visible: &[u8],
    cut_plane_immune: &[u8],
    cut_planes: &[f64],
    cut_plane_count: usize,
    cage_bounds: &[f64],
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

    let center_image_keys: HashSet<Key> = center_keys
        .chunks_exact(4)
        .map(|chunk| (chunk[0] as u32, chunk[1], chunk[2], chunk[3]))
        .collect();

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

    // Spatial grid sized by the bond radius; per-radius halos. Periodic (fractional) mode:
    // positions are fractional and the query wraps across cell boundaries.
    let bin_radius = max_cutoff.max(1.5);
    let grid_gx = 1.max((width_a / bin_radius).floor() as i32);
    let grid_gy = 1.max((width_b / bin_radius).floor() as i32);
    let grid_gz = 1.max((width_c / bin_radius).floor() as i32);
    let mut grid = CellList::new(&positions, grid_gx, grid_gy, grid_gz, BinMode::Frac);
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


    let mut scratch: Vec<usize> = Vec::new();

    // neighborImages(P, elem) — bonded images within cutoff.
    let neighbor_images = |grid: &mut CellList, scratch: &mut Vec<usize>, p: Vec3, ei: usize| -> Vec<Neighbor> {
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
    let gather_within = |grid: &mut CellList, scratch: &mut Vec<usize>, p: Vec3| -> Vec<Cand> {
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

    // All atom images within `r` of p, the atom AT p included (mirrors
    // gatherRadius in docs/render/PolyhedraModule.js). The image window gets
    // half a cell of slack so rounding of an exact .5 cannot drop an image.
    let gather_radius = |grid: &mut CellList, scratch: &mut Vec<usize>, p: Vec3, r: f64| -> Vec<(u32, [i32; 3], Vec3, f64)> {
        let fp = cart_to_frac(p);
        let hx = (r / bin_wa).floor() as i32 + 1;
        let hy = (r / bin_wb).floor() as i32 + 1;
        let hz = (r / bin_wc).floor() as i32 + 1;
        grid.candidates(fp, hx, hy, hz, scratch);
        let ia = 1.max((r / width_a.max(1e-6) + 0.5).ceil() as i32);
        let ib = 1.max((r / width_b.max(1e-6) + 0.5).ceil() as i32);
        let ic = 1.max((r / width_c.max(1e-6) + 0.5).ceil() as i32);
        let mut out = Vec::new();
        for &j in scratch.iter() {
            let fj = positions[j];
            let c0 = (fp.x - fj.x).round() as i32;
            let c1 = (fp.y - fj.y).round() as i32;
            let c2 = (fp.z - fj.z).round() as i32;
            for dx in (c0 - ia)..=(c0 + ia) {
                for dy in (c1 - ib)..=(c1 + ib) {
                    for dz in (c2 - ic)..=(c2 + ic) {
                        let q = base_cart[j]
                            .add(a.scale(dx as f64))
                            .add(b.scale(dy as f64))
                            .add(c.scale(dz as f64));
                        let d = q.dist(p);
                        if d > r {
                            continue;
                        }
                        out.push((j as u32, [dx, dy, dz], q, d));
                    }
                }
            }
        }
        out
    };

    // Framework graph for the cage search (cages on only): framework-bond
    // neighbour images per base atom as keys for an image-aware bond test, and
    // each atom's framework degree over non-terminal partners. Mirrors fwNbrs /
    // fwKeys / fwDeg in docs/render/PolyhedraModule.js.
    let mut fw_count: Vec<usize> = vec![0; n_atoms];
    let mut fw_keys: Vec<HashSet<Key>> = vec![HashSet::new(); n_atoms];
    let mut fw_deg: Vec<usize> = vec![0; n_atoms];
    let mut fw_lists: Vec<Vec<u32>> = vec![Vec::new(); n_atoms];
    // What in-shell bonds are measured against (mirrors shareDeg in the JS):
    // the framework degree, or for a metal under the chemical filter all its
    // metal–metal contacts (a carbide's Ti–Ti are mostly bridged by C).
    let mut share_deg: Vec<usize> = vec![0; n_atoms];
    let is_af = |e: usize| anion_former.get(e).copied().unwrap_or(0) != 0;
    if detect_cages {
        for i in 0..n_atoms {
            let nbrs = neighbor_images(&mut grid, &mut scratch, base_cart[i], elem_idx[i] as usize);
            if use_chem_filter && !is_af(elem_idx[i] as usize) {
                share_deg[i] = nbrs.iter().filter(|o| !is_af(elem_idx[o.src_j as usize] as usize)).count();
            }
            for o in &nbrs {
                if use_chem_filter
                    && !is_framework_bond(
                        elem_idx[i] as usize,
                        elem_idx[o.src_j as usize] as usize,
                        &nbrs,
                        o.pos,
                        elem_idx,
                        electroneg,
                        anion_former,
                        &cutoff,
                    )
                {
                    continue;
                }
                fw_keys[i].insert(image_key(o.src_j, o.shift));
                fw_lists[i].push(o.src_j);
            }
            fw_count[i] = fw_lists[i].len();
        }
        for i in 0..n_atoms {
            fw_deg[i] = fw_lists[i].iter().filter(|&&j| fw_count[j as usize] >= 2).count();
            if !(use_chem_filter && !is_af(elem_idx[i] as usize)) {
                share_deg[i] = fw_deg[i];
            }
        }
    }

    let t_setup = now();
    // Kept in the signature for the JS callers: the old seed-based cage search
    // skipped hidden seeds; the void search checks every cage vertex instead.
    let _ = seed_visible;
    let mut candidates: Vec<Candidate> = Vec::new();

    // ---- Centered ----
    for ci in center_start..center_end {
        let src = center_src[ci];
        let shift = [center_shift[3 * ci], center_shift[3 * ci + 1], center_shift[3 * ci + 2]];
        if !center_image_keys.contains(&image_key(src, shift)) {
            continue;
        }
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
        let is_ligand = |cand: &Cand| -> bool {
            if !is_ligand_of(cand.elem, center_elem, electroneg, use_chem_filter) {
                return false;
            }
            let cut = cutoff(center_elem, cand.elem);
            cut > 1e-3 && cand.d <= cut
        };
        let accept = |cand: &Cand| -> bool {
            is_ligand(cand)
                && !(use_chem_filter && is_bridged_cation(cand, &cands, electroneg, anion_former, &cutoff))
        };
        let vor = voronoi_neighbours(center_pos, &cands, center_radius, &accept);

        // Cut-plane visibility is tested directly on the candidate image,
        // independent of whether that periodic image exists in `wrapped`.
        let mut by_image: HashMap<Key, usize> = HashMap::new();
        let mut order: Vec<Key> = Vec::new();
        for &k in &vor {
            let cand = &cands[k];
            let key = image_key(cand.src_j, cand.shift);
            if !atom_image_visible(cand.pos, cand.src_j, cut_plane_immune, cut_planes, cut_plane_count) {
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

    // ---- Cages (uncentred): empty shells of mutually bonded framework atoms ----
    // Mirrors findCages() in docs/render/PolyhedraModule.js (see the notes
    // there). Only the partition that starts at seed 0 runs it, so a parallel
    // run yields the cages once, in the serial order.
    let mut cage_pool_ms = 0.0_f64;
    let mut cage_band_ms = 0.0_f64;
    let mut cage_nloop_ms = 0.0_f64;
    let mut bands_built: u32 = 0;
    let mut bands_skipped: u32 = 0;
    if detect_cages && seed_start == 0 && seed_end > seed_start && fw_deg.iter().any(|&d| d >= 3) {
        let tp = now();
        let mut h = CAGE_GRID_STEP;
        while cell_vol / (h * h * h) > CAGE_GRID_MAX_POINTS {
            h *= 1.25;
        }
        let n_a = 4.max((a.norm() / h).ceil() as i64);
        let n_b = 4.max((b.norm() / h).ceil() as i64);
        let n_c = 4.max((c.norm() / h).ceil() as i64);
        let mut field = vec![CAGE_SPLAT_RADIUS; (n_a * n_b * n_c) as usize];
        let at = |i: i64, j: i64, k: i64| -> usize {
            ((i.rem_euclid(n_a) * n_b + j.rem_euclid(n_b)) * n_c + k.rem_euclid(n_c)) as usize
        };
        let ea = ((CAGE_SPLAT_RADIUS / width_a) * n_a as f64).ceil() as i64 + 1;
        let eb = ((CAGE_SPLAT_RADIUS / width_b) * n_b as f64).ceil() as i64 + 1;
        let ec = ((CAGE_SPLAT_RADIUS / width_c) * n_c as f64).ceil() as i64 + 1;
        for j in 0..n_atoms {
            let f0 = positions[j].x - positions[j].x.floor();
            let f1 = positions[j].y - positions[j].y.floor();
            let f2 = positions[j].z - positions[j].z.floor();
            let px = a.x * f0 + b.x * f1 + c.x * f2;
            let py = a.y * f0 + b.y * f1 + c.y * f2;
            let pz = a.z * f0 + b.z * f1 + c.z * f2;
            let ci = (f0 * n_a as f64).round() as i64;
            let cj = (f1 * n_b as f64).round() as i64;
            let ck = (f2 * n_c as f64).round() as i64;
            for i in (ci - ea)..=(ci + ea) {
                let g0 = i as f64 / n_a as f64;
                for jj in (cj - eb)..=(cj + eb) {
                    let g1 = jj as f64 / n_b as f64;
                    for k in (ck - ec)..=(ck + ec) {
                        let g2 = k as f64 / n_c as f64;
                        let dx = a.x * g0 + b.x * g1 + c.x * g2 - px;
                        let dy = a.y * g0 + b.y * g1 + c.y * g2 - py;
                        let dz = a.z * g0 + b.z * g1 + c.z * g2 - pz;
                        let d = (dx * dx + dy * dy + dz * dz).sqrt();
                        if d >= CAGE_SPLAT_RADIUS {
                            continue;
                        }
                        let idx = at(i, jj, k);
                        if d < field[idx] {
                            field[idx] = d;
                        }
                    }
                }
            }
        }
        cage_pool_ms += now() - tp;

        let bonded = |u: &(u32, [i32; 3], Vec3, f64), w: &(u32, [i32; 3], Vec3, f64)| -> bool {
            fw_keys[u.0 as usize].contains(&image_key(w.0, [w.1[0] - u.1[0], w.1[1] - u.1[1], w.1[2] - u.1[2]]))
        };
        let by_image = |x: &(u32, [i32; 3], Vec3, f64), y: &(u32, [i32; 3], Vec3, f64)| {
            (x.0, x.1[0], x.1[1], x.1[2]).cmp(&(y.0, y.1[0], y.1[1], y.1[2]))
        };
        let mut seen: HashSet<Vec<Key>> = HashSet::new();
        for i in 0..n_a {
            for j in 0..n_b {
                for k in 0..n_c {
                    let v = field[((i * n_b + j) * n_c + k) as usize];
                    if v < CAGE_MIN_VOID || v >= CAGE_SPLAT_RADIUS {
                        continue;
                    }
                    let mut is_max = true;
                    'nb: for di in -1..=1 {
                        for dj in -1..=1 {
                            for dk in -1..=1 {
                                if (di != 0 || dj != 0 || dk != 0) && field[at(i + di, j + dj, k + dk)] > v {
                                    is_max = false;
                                    break 'nb;
                                }
                            }
                        }
                    }
                    if !is_max {
                        continue;
                    }
                    bands_built += 1;
                    let tb = now();

                    // the shell around this void, re-centred until it is stable
                    let mut p = a
                        .scale(i as f64 / n_a as f64)
                        .add(b.scale(j as f64 / n_b as f64))
                        .add(c.scale(k as f64 / n_c as f64));
                    let mut shell: Option<Vec<(u32, [i32; 3], Vec3, f64)>> = None;
                    let mut prev: Vec<Key> = Vec::new();
                    for _ in 0..CAGE_REFINE_ITERS {
                        let near = gather_radius(&mut grid, &mut scratch, p, CAGE_SHELL_CAP);
                        if near.is_empty() {
                            break;
                        }
                        let dmin = near.iter().fold(f64::INFINITY, |m, o| m.min(o.3));
                        let cut_r = (CAGE_SHELL_TOL * dmin).max(dmin + CAGE_SHELL_PAD);
                        let mut sh: Vec<(u32, [i32; 3], Vec3, f64)> = near
                            .into_iter()
                            .filter(|o| o.3 <= cut_r && fw_count[o.0 as usize] >= 2)
                            .collect();
                        sh.sort_by(by_image);
                        if sh.len() < 4 {
                            break;
                        }
                        let key: Vec<Key> = sh.iter().map(|o| image_key(o.0, o.1)).collect();
                        if key == prev {
                            shell = Some(sh);
                            break;
                        }
                        prev = key;
                        p = sh
                            .iter()
                            .fold(Vec3::new(0.0, 0.0, 0.0), |acc, o| acc.add(o.2))
                            .scale(1.0 / sh.len() as f64);
                    }
                    cage_band_ms += now() - tb;
                    let mut shell = match shell {
                        Some(s) => s,
                        None => continue,
                    };
                    let tn = now();

                    // translate so the centre lies in the cell; keep each cage once
                    let fc = cart_to_frac(p);
                    let t = [(fc.x + 1e-6).floor() as i32, (fc.y + 1e-6).floor() as i32, (fc.z + 1e-6).floor() as i32];
                    if t != [0, 0, 0] {
                        let off = a.scale(t[0] as f64).add(b.scale(t[1] as f64)).add(c.scale(t[2] as f64));
                        p = p.sub(off);
                        for o in shell.iter_mut() {
                            o.2 = o.2.sub(off);
                            o.1 = [o.1[0] - t[0], o.1[1] - t[1], o.1[2] - t[2]];
                        }
                    }
                    let cage_key: Vec<Key> = shell.iter().map(|o| image_key(o.0, o.1)).collect();
                    if !seen.insert(cage_key.clone()) {
                        cage_nloop_ms += now() - tn;
                        continue;
                    }

                    // is it a cage?
                    let n = shell.len();
                    let degree_ok = shell.iter().all(|u| {
                        let in_shell = shell.iter().filter(|w| !std::ptr::eq(*w, u) && bonded(u, w)).count();
                        in_shell >= 3 && (in_shell as f64) >= CAGE_MIN_SURFACE_SHARE * share_deg[u.0 as usize] as f64
                    });
                    let mut ok = degree_ok;
                    if ok {
                        let mut reached = vec![false; n];
                        reached[0] = true;
                        let mut stack = vec![0usize];
                        while let Some(u) = stack.pop() {
                            for w in 0..n {
                                if !reached[w] && bonded(&shell[u], &shell[w]) {
                                    reached[w] = true;
                                    stack.push(w);
                                }
                            }
                        }
                        ok = reached.iter().all(|&r| r);
                    }
                    let pos_list: Vec<Vec3> = shell.iter().map(|o| o.2).collect();
                    if ok && thickness_ratio(&pos_list) < CAGE_MIN_THICKNESS {
                        ok = false;
                    }
                    if ok {
                        ok = match convex_hull(&pos_list) {
                            Some(hull) => {
                                let inside = |q: Vec3| hull.contains(q, -NEST_MARGIN);
                                let r_max = shell.iter().fold(0.0_f64, |m, o| m.max(o.2.dist(p)));
                                let keys: HashSet<Key> = cage_key.iter().cloned().collect();
                                inside(p)
                                    && shell.iter().all(|o| !inside(o.2))
                                    && gather_radius(&mut grid, &mut scratch, p, r_max + 0.05)
                                        .iter()
                                        .all(|o| keys.contains(&image_key(o.0, o.1)) || !inside(o.2))
                            }
                            None => false,
                        };
                    }
                    cage_nloop_ms += now() - tn;
                    if !ok {
                        continue;
                    }
                    bands_skipped += 1;
                    // With periodic images shown, a cage on the cell boundary is
                    // drawn at every image the display bounds hold, like an atom
                    // there (render/LatticeModule.js): its centre's in-cell
                    // coordinate w gets every shift n with lo <= w + n <= hi.
                    // Without them, only the in-cell copy.
                    let fw = [fc.x - t[0] as f64, fc.y - t[1] as f64, fc.z - t[2] as f64];
                    let range = |k: usize| -> (i32, i32) {
                        if cage_bounds.len() == 6 {
                            ((cage_bounds[2 * k] - fw[k]).ceil() as i32, (cage_bounds[2 * k + 1] - fw[k]).floor() as i32)
                        } else {
                            (0, 0)
                        }
                    };
                    let (rx, ry, rz) = (range(0), range(1), range(2));
                    for nx in rx.0..=rx.1 {
                        for ny in ry.0..=ry.1 {
                            for nz in rz.0..=rz.1 {
                                let off = a.scale(nx as f64).add(b.scale(ny as f64)).add(c.scale(nz as f64));
                                let img: Vec<(u32, [i32; 3], Vec3)> = shell
                                    .iter()
                                    .map(|o| (o.0, [o.1[0] + nx, o.1[1] + ny, o.1[2] + nz], o.2.add(off)))
                                    .collect();
                                if !img.iter().all(|o| atom_image_visible(o.2, o.0, cut_plane_immune, cut_planes, cut_plane_count)) {
                                    continue;
                                }
                                candidates.push(Candidate {
                                    is_cage: true,
                                    color_elem: elem_idx[img[0].0 as usize],
                                    center_src: -1,
                                    center_shift: [0, 0, 0],
                                    vertex_image_list: img.iter().map(|o| (o.0, o.1)).collect(),
                                    vertex_src_list: img.iter().map(|o| o.0).collect(),
                                    ref_point: p.add(off),
                                    pos_list: img.iter().map(|o| o.2).collect(),
                                });
                            }
                        }
                    }
                }
            }
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
        let inside = accepted_hulls.iter().any(|h| h.contains(cand.ref_point, -NEST_MARGIN));
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
    anion_former: &[u8],
    radii: &[f64],
    max_cutoff: f64,
    use_chem_filter: bool,
    detect_cages: bool,
    center_src: &[u32],
    center_shift: &[i32],
    center_cart: &[f64],
    center_keys: &[i32],
    seed_visible: &[u8],
    cut_plane_immune: &[u8],
    cut_planes: &[f64],
    cut_plane_count: usize,
    cage_bounds: &[f64],
) -> ComputedPolyhedra {
    let n_atoms = elem_idx.len();
    let n_centers = center_src.len();
    let (candidates, bt) = build_candidates(
        frac, elem_idx, lat, cutoff_matrix, n_elem, electroneg, anion_former, radii, max_cutoff,
        use_chem_filter, detect_cages, center_src, center_shift, center_cart, center_keys,
        seed_visible, cut_plane_immune, cut_planes, cut_plane_count, cage_bounds, 0, n_centers, 0, n_atoms,
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
        anion_former: Vec<u8>,
        radii: Vec<f64>,
        max_cutoff: f64,
        center_src: Vec<u32>,
        center_shift: Vec<i32>,
        center_cart: Vec<f64>,
        center_keys: Vec<i32>,
        seed_visible: Vec<u8>,
        cut_plane_immune: Vec<u8>,
        cut_planes: Vec<f64>,
        cut_plane_count: usize,
        cage_bounds: Vec<f64>,
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
        let mut center_keys = Vec::new();
        for i in 0..n as i32 {
            center_keys.extend_from_slice(&[i, 0, 0, 0]);
        }
        Inputs {
            frac,
            elem,
            lat,
            cutoff,
            n_elem: 2,
            electroneg,
            anion_former: vec![0, 1],
            radii,
            max_cutoff: 2.5,
            center_src,
            center_shift,
            center_cart,
            center_keys,
            seed_visible: vec![1u8; n],
            cut_plane_immune: vec![0u8; n],
            cut_planes: Vec::new(),
            cut_plane_count: 0,
            cage_bounds: Vec::new(),
        }
    }

    fn build(inp: &Inputs, cs: usize, ce: usize, ss: usize, se: usize) -> Vec<Candidate> {
        build_candidates(
            &inp.frac, &inp.elem, &inp.lat, &inp.cutoff, inp.n_elem, &inp.electroneg, &inp.anion_former, &inp.radii,
            inp.max_cutoff, true, true, &inp.center_src, &inp.center_shift, &inp.center_cart,
            &inp.center_keys, &inp.seed_visible, &inp.cut_plane_immune, &inp.cut_planes,
            inp.cut_plane_count, &inp.cage_bounds, cs, ce, ss, se,
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

    /// The octahedron's atoms plus extra species, as cartesian offsets (Å) from
    /// the cation at the cell centre. `cut` and `en` are over all species.
    fn octahedron_with(
        extra: &[([f64; 3], u32)],
        n_elem: usize,
        cut: Vec<f64>,
        en: Vec<f64>,
        anion_former: Vec<u8>,
        max_cutoff: f64,
    ) -> Inputs {
        let mut inp = octahedron();
        let l = 20.0;
        for (off, e) in extra {
            for d in 0..3 {
                inp.frac.push(0.5 + off[d] / l);
            }
            inp.elem.push(*e);
        }
        let n = inp.elem.len();
        inp.n_elem = n_elem;
        inp.cutoff = cut;
        inp.electroneg = en;
        inp.anion_former = anion_former;
        inp.radii = vec![1.0; n_elem];
        inp.max_cutoff = max_cutoff;
        inp.center_cart = inp.frac.iter().map(|f| f * l).collect();
        inp.center_src = (0..n as u32).collect();
        inp.center_shift = vec![0i32; 3 * n];
        inp.center_keys = (0..n as i32).flat_map(|i| [i, 0, 0, 0]).collect();
        inp.seed_visible = vec![1u8; n];
        inp.cut_plane_immune = vec![0u8; n];
        inp
    }

    #[test]
    fn cation_reached_through_a_ligand_is_not_a_corner() {
        // Diopside's case in miniature: a second cation (species 2, more
        // electronegative than the centre, so the electronegativity rule alone
        // admits it) shares the +x/+y edge of the octahedron, 2.56 Å out and
        // inside the centre–cation cutoff. It used to become a 7th corner.
        let cut = vec![
            0.0, 2.5, 3.0, //
            2.5, 0.0, 2.2, //
            3.0, 2.2, 0.0,
        ];
        let inp = octahedron_with(&[([2.0, 1.6, 0.0], 2)], 3, cut, vec![1.0, 3.0, 2.0], vec![0, 1, 0], 3.0);
        let out = accept(build(&inp, 0, 1, 0, 0));
        assert_eq!(out.center_src, vec![0]);
        assert_eq!(out.vert_counts, vec![6], "the edge-sharing cation must not be a corner");
        assert!(out.vertex_srcs.iter().all(|&j| inp.elem[j as usize] == 1));
    }

    #[test]
    fn ligand_with_a_more_electronegative_partner_off_the_centre_stays() {
        // Prussian blue / carbonyl: the ligands (species 1) are each bonded to a
        // more electronegative atom (species 2) further out that is NOT a ligand
        // of the centre (beyond its cutoff). They remain the corners.
        let cut = vec![
            0.0, 2.5, 2.4, //
            2.5, 0.0, 1.4, //
            2.4, 1.4, 0.0,
        ];
        let far = 3.15;
        let extra = [
            ([far, 0.0, 0.0], 2), ([-far, 0.0, 0.0], 2),
            ([0.0, far, 0.0], 2), ([0.0, -far, 0.0], 2),
            ([0.0, 0.0, far], 2), ([0.0, 0.0, -far], 2),
        ];
        let inp = octahedron_with(&extra, 3, cut, vec![1.0, 2.5, 3.0], vec![0, 1, 1], 2.5);
        let out = accept(build(&inp, 0, 1, 0, 0));
        assert_eq!(out.center_src, vec![0]);
        assert_eq!(out.vert_counts, vec![6]);
    }

    #[test]
    fn a_metal_bridge_strips_no_corners() {
        // An alloy (CrFe11Ni3Mo): the corners (species 1, like Fe) touch a more
        // electronegative METAL (species 2, like Mo) that is also a ligand of
        // the centre. Metals are not anion formers, so all six corners stay.
        let cut = vec![
            0.0, 2.5, 3.0, //
            2.5, 0.0, 2.5, //
            3.0, 2.5, 0.0,
        ];
        let inp = octahedron_with(&[([1.6, 1.6, 1.6], 2)], 3, cut, vec![1.66, 1.83, 2.16], vec![0, 0, 0], 3.0);
        let out = accept(build(&inp, 0, 1, 0, 0));
        assert_eq!(out.center_src, vec![0]);
        let n_corner_metal = out.vertex_srcs.iter().filter(|&&j| inp.elem[j as usize] == 1).count();
        assert_eq!(n_corner_metal, 6, "every corner of the octahedron stays");
        // ... and even as an anion former it strips nothing: it sits farther
        // out (2.77 Å) than the corners it bonds to (2.0 Å), so it is no anion
        // between them and the centre (the carbonyl / Prussian-blue case).
        let cut = vec![
            0.0, 2.5, 3.0, //
            2.5, 0.0, 2.5, //
            3.0, 2.5, 0.0,
        ];
        let inp = octahedron_with(&[([1.6, 1.6, 1.6], 2)], 3, cut, vec![1.66, 1.83, 2.16], vec![0, 0, 1], 3.0);
        let out = accept(build(&inp, 0, 1, 0, 0));
        let n_corner_metal = out.vertex_srcs.iter().filter(|&&j| inp.elem[j as usize] == 1).count();
        assert_eq!(n_corner_metal, 6, "a partner farther out than the corners strips none");
    }

    /// Atoms at cartesian offsets (Å) from the centre of a 20 Å box.
    fn boxed(atoms: &[([f64; 3], u32)], n_elem: usize, cut: Vec<f64>, en: Vec<f64>, af: Vec<u8>, max_cutoff: f64) -> Inputs {
        let mut inp = octahedron();
        let l = 20.0;
        inp.frac = atoms.iter().flat_map(|(o, _)| [0.5 + o[0] / l, 0.5 + o[1] / l, 0.5 + o[2] / l]).collect();
        inp.elem = atoms.iter().map(|(_, e)| *e).collect();
        let n = inp.elem.len();
        inp.n_elem = n_elem;
        inp.cutoff = cut;
        inp.electroneg = en;
        inp.anion_former = af;
        inp.radii = vec![1.0; n_elem];
        inp.max_cutoff = max_cutoff;
        inp.center_cart = inp.frac.iter().map(|f| f * l).collect();
        inp.center_src = (0..n as u32).collect();
        inp.center_shift = vec![0i32; 3 * n];
        inp.center_keys = (0..n as i32).flat_map(|i| [i, 0, 0, 0]).collect();
        inp.seed_visible = vec![1u8; n];
        inp.cut_plane_immune = vec![0u8; n];
        inp
    }

    /// The 12 corners of an icosahedron with edge `e`.
    fn icosahedron(e: f64) -> Vec<[f64; 3]> {
        let phi = (1.0 + 5.0_f64.sqrt()) / 2.0;
        let s = e / 2.0;
        let mut v = Vec::new();
        for &a in &[-1.0, 1.0] {
            for &b in &[-1.0, 1.0] {
                v.push([0.0, a * s, b * s * phi]);
                v.push([a * s, b * s * phi, 0.0]);
                v.push([b * s * phi, 0.0, a * s]);
            }
        }
        v
    }

    #[test]
    fn empty_b12_icosahedron_is_a_cage() {
        // Boron-like (anion former, B–B bonds 1.75 Å): one cage, all 12 corners.
        let atoms: Vec<([f64; 3], u32)> = icosahedron(1.75).into_iter().map(|p| (p, 0)).collect();
        let inp = boxed(&atoms, 1, vec![2.1], vec![2.04], vec![1], 2.1);
        let n = inp.elem.len();
        let out = accept(build(&inp, 0, n, 0, n));
        assert_eq!(out.kinds, vec![1], "one cage");
        assert_eq!(out.vert_counts, vec![12]);
    }

    #[test]
    fn a_cage_on_a_cell_corner_is_drawn_at_every_corner_with_periodic_images() {
        // The same icosahedron centred on the box corner: one copy without
        // periodic images, all 8 corners with them (bounds [0,1] ± 1e-3).
        let atoms: Vec<([f64; 3], u32)> = icosahedron(1.75).into_iter().map(|p| (p, 0)).collect();
        let mut inp = boxed(&atoms, 1, vec![2.1], vec![2.04], vec![1], 2.1);
        for f in inp.frac.iter_mut() {
            *f -= 0.5;
        }
        inp.center_cart = inp.frac.iter().map(|f| f * 20.0).collect();
        let n = inp.elem.len();
        let one = accept(build(&inp, 0, n, 0, n));
        assert_eq!(one.kinds, vec![1], "one copy without periodic images");
        inp.cage_bounds = vec![-1e-3, 1.0 + 1e-3, -1e-3, 1.0 + 1e-3, -1e-3, 1.0 + 1e-3];
        let all = accept(build(&inp, 0, n, 0, n));
        assert_eq!(all.kinds, vec![1; 8], "a copy on every corner");
        assert!(all.vert_counts.iter().all(|&c| c == 12));
        // a cage in the middle of the cell stays single
        let mid = boxed(&atoms, 1, vec![2.1], vec![2.04], vec![1], 2.1);
        let mut mid = mid;
        mid.cage_bounds = inp.cage_bounds.clone();
        assert_eq!(accept(build(&mid, 0, n, 0, n)).kinds, vec![1]);
    }

    #[test]
    fn filled_icosahedron_is_its_guests_polyhedron() {
        // A guest at the centre (species 1, less electronegative): no cage, and
        // the guest gets the 12-corner centred polyhedron instead.
        let mut atoms: Vec<([f64; 3], u32)> = icosahedron(1.75).into_iter().map(|p| (p, 0)).collect();
        atoms.push(([0.0, 0.0, 0.0], 1));
        let cut = vec![2.1, 2.2, 2.2, 0.0];
        let inp = boxed(&atoms, 2, cut, vec![2.04, 0.9], vec![1, 0], 2.2);
        let n = inp.elem.len();
        let out = accept(build(&inp, 0, n, 0, n));
        assert_eq!(out.kinds, vec![0], "only the guest-centred polyhedron");
        assert_eq!(out.vert_counts, vec![12]);
        assert_eq!(out.center_src, vec![12]);
    }

    #[test]
    fn a_ring_is_no_cage() {
        // A hexagon of bonded atoms (degree 2, flat): nothing.
        let atoms: Vec<([f64; 3], u32)> = (0..6)
            .map(|k| {
                let t = k as f64 * std::f64::consts::PI / 3.0;
                ([1.4 * t.cos(), 1.4 * t.sin(), 0.0], 0)
            })
            .collect();
        let inp = boxed(&atoms, 1, vec![1.7], vec![2.55], vec![1], 1.7);
        let n = inp.elem.len();
        let out = accept(build(&inp, 0, n, 0, n));
        assert!(out.kinds.is_empty());
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
