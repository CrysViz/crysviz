//! "Complete Rings & Fragments": the atoms that fragments and small rings cut by a cell
//! face need from the neighbouring cells. A fragment is a finite bonded group — a
//! dimer, a molecule, a molecular ion; layers and frameworks have none, only rings.
//!
//! The wrapped set draws every atom inside the cell, so a fragment that straddles a face
//! is split: part of it is drawn on the far side of the cell, away from its bond
//! partners. Neighbour Bonds adds one bond's worth of partners, which closes a dimer but
//! leaves a ring open whenever two or more consecutive ring atoms lie outside.
//!
//! This pass works on the bond graph of the primary atoms under periodic boundary
//! conditions:
//!   1. every bond (i, j, cell shift) within the pair cutoff. The caller zeroes the
//!      cutoff of any pair that should not define fragments (bonds to metals by
//!      default, hidden pairs always);
//!   2. connected components, each atom carrying the cell shift that puts its component
//!      back together. A bond that closes onto a *translated* copy of an atom means the
//!      component repeats with the lattice (chain, layer, framework) and can never be
//!      drawn whole;
//!   3. finite components (fragments: dimers, molecules, molecular ions) are drawn whole for
//!      every copy that has at least one displayed atom;
//!   4. in extended components, the smallest rings of up to `max_ring` atoms through
//!      each bond that leaves the displayed set are drawn whole — the 6-rings of a
//!      graphite sheet cut by a cell face. Only atoms with at most four fragment bonds
//!      take part, so close-packed structures (12-coordinate metals, rock salt with its
//!      bonds kept) do not sprout a shell of 3- and 4-rings.
//!
//! Everything is O(atoms × neighbours) except step 4, which is bounded per boundary bond
//! (a breadth-first search at most `max_ring - 1` bonds deep over atoms of degree ≤ 4).
//! `periodicWrappedJS` in render/FragmentCompletion.js mirrors this file.

use crate::cell_list::{BinMode, CellList};
use crate::linalg::Vec3;
use std::collections::{HashMap, HashSet};

/// Integer lattice translation of an atom image.
pub type Shift = [i32; 3];

/// Ring atoms may have at most this many fragment bonds.
const MAX_RING_DEGREE: usize = 4;
/// Equally short rings through one bond (graphite: 2). Guards against a pathological
/// number of shortest paths in an unusual network.
const MAX_RINGS_PER_BOND: usize = 8;
/// Coincident atoms (duplicated sites) are not bonded — same floor as the ghost search.
const MIN_BOND_D2: f64 = 0.005 * 0.005;
/// Hard upper bound on the ring size, whatever the caller asks for.
pub const MAX_RING_LIMIT: usize = 12;

#[inline]
fn add(a: Shift, b: Shift) -> Shift {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[inline]
fn sub(a: Shift, b: Shift) -> Shift {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn cross(a: Vec3, b: Vec3) -> Vec3 {
    Vec3::new(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
}

/// Packed (atom, cell shift) key: 10 bits per shift component (±512 cells) above the
/// atom index.
#[inline]
pub fn image_key(src: u32, s: Shift) -> u64 {
    let c = |v: i32| ((v + 512) as u64) & 0x3ff;
    ((src as u64) << 30) | (c(s[0]) << 20) | (c(s[1]) << 10) | c(s[2])
}

/// Bond graph of the primary atoms, CSR layout: the bonds of atom `i` are
/// `start[i]..start[i+1]`, each to the image of atom `nbr[k]` translated by `shift[k]`
/// cells (relative to atom `i`'s own image).
pub struct PeriodicGraph {
    start: Vec<usize>,
    nbr: Vec<u32>,
    shift: Vec<Shift>,
}

impl PeriodicGraph {
    #[inline]
    fn degree(&self, i: usize) -> usize {
        self.start[i + 1] - self.start[i]
    }

    #[inline]
    fn bonds(&self, i: usize) -> std::ops::Range<usize> {
        self.start[i]..self.start[i + 1]
    }
}

/// Build the periodic bond graph. `frac` are the primary atoms' fractional coordinates
/// as given (not wrapped), `rows` the lattice vectors a, b, c, `cutoff` the
/// `n_elem × n_elem` bond table (0 = no bond).
pub fn build_graph(
    frac: &[Vec3],
    elem: &[u32],
    rows: [Vec3; 3],
    cutoff: &[f64],
    n_elem: usize,
) -> PeriodicGraph {
    let n = frac.len();
    let mut g = PeriodicGraph { start: vec![0; n + 1], nbr: Vec::new(), shift: Vec::new() };
    let max_cut = cutoff.iter().cloned().fold(0.0_f64, f64::max);
    let [a, b, c] = rows;
    let vol = a.dot(cross(b, c)).abs();
    if n == 0 || max_cut <= 0.01 || vol <= 1e-9 {
        return g;
    }
    let cut = |ei: usize, ej: usize| -> f64 {
        if ei < n_elem && ej < n_elem {
            cutoff[ei * n_elem + ej]
        } else {
            0.0
        }
    };

    // Perpendicular cell widths, so no image within the cutoff is missed in a skewed or
    // thin cell (the ghost search's ±2 clamp would).
    let widths = [
        vol / cross(b, c).norm().max(1e-9),
        vol / cross(c, a).norm().max(1e-9),
        vol / cross(a, b).norm().max(1e-9),
    ];
    let reach: Vec<i32> = widths.iter().map(|w| ((max_cut / w).ceil() as i32).max(1)).collect();

    // Bins at least one cutoff wide, capped so a big vacuum cell does not allocate
    // millions of empty bins.
    let mut dims: Vec<i32> = widths.iter().map(|w| ((w / max_cut).floor() as i32).max(1)).collect();
    let max_bins = (8 * n).max(512) as f64;
    let total = (dims[0] as f64) * (dims[1] as f64) * (dims[2] as f64);
    if total > max_bins {
        let f = (total / max_bins).cbrt();
        for d in dims.iter_mut() {
            *d = ((*d as f64 / f).floor() as i32).max(1);
        }
    }
    let halo: Vec<i32> = (0..3)
        .map(|k| (max_cut / (widths[k] / dims[k] as f64)).floor() as i32 + 1)
        .collect();
    let mut grid = CellList::new(frac, dims[0], dims[1], dims[2], BinMode::Frac);

    let to_cart = |f: Vec3| a.scale(f.x).add(b.scale(f.y)).add(c.scale(f.z));
    let cart: Vec<Vec3> = frac.iter().map(|&f| to_cart(f)).collect();

    let mut scratch: Vec<usize> = Vec::new();
    for i in 0..n {
        let fi = frac[i];
        let ei = elem[i] as usize;
        grid.candidates(fi, halo[0], halo[1], halo[2], &mut scratch);
        for &j in scratch.iter() {
            let ct = cut(ei, elem[j] as usize);
            if ct <= 0.01 {
                continue;
            }
            let ct2 = ct * ct;
            let fj = frac[j];
            let c0 = (fi.x - fj.x).round() as i32;
            let c1 = (fi.y - fj.y).round() as i32;
            let c2 = (fi.z - fj.z).round() as i32;
            for dx in (c0 - reach[0])..=(c0 + reach[0]) {
                for dy in (c1 - reach[1])..=(c1 + reach[1]) {
                    for dz in (c2 - reach[2])..=(c2 + reach[2]) {
                        if j == i && dx == 0 && dy == 0 && dz == 0 {
                            continue;
                        }
                        let q = cart[j]
                            .add(a.scale(dx as f64))
                            .add(b.scale(dy as f64))
                            .add(c.scale(dz as f64));
                        let d2 = q.dist2(cart[i]);
                        if d2 <= ct2 && d2 >= MIN_BOND_D2 {
                            g.nbr.push(j as u32);
                            g.shift.push([dx, dy, dz]);
                        }
                    }
                }
            }
        }
        g.start[i + 1] = g.nbr.len();
    }
    g
}

/// Connected components of the periodic bond graph. `unwrap[i]` is the cell shift that
/// places atom `i` next to its bond partners within its component; `extended[c]` marks a
/// component that bonds to a translated copy of itself (infinite under PBC).
pub struct Components {
    comp: Vec<u32>,
    unwrap: Vec<Shift>,
    extended: Vec<bool>,
    start: Vec<usize>,
    members: Vec<u32>,
}

impl Components {
    #[inline]
    fn members(&self, c: usize) -> &[u32] {
        &self.members[self.start[c]..self.start[c + 1]]
    }
}

pub fn components(g: &PeriodicGraph) -> Components {
    let n = g.start.len() - 1;
    let mut out = Components {
        comp: vec![u32::MAX; n],
        unwrap: vec![[0; 3]; n],
        extended: Vec::new(),
        start: vec![0],
        members: Vec::with_capacity(n),
    };
    for r in 0..n {
        if out.comp[r] != u32::MAX {
            continue;
        }
        let id = out.extended.len() as u32;
        let mut ext = false;
        out.comp[r] = id;
        // Breadth-first, using the member list itself as the queue.
        let mut q = out.members.len();
        out.members.push(r as u32);
        while q < out.members.len() {
            let i = out.members[q] as usize;
            q += 1;
            for k in g.bonds(i) {
                let j = g.nbr[k] as usize;
                let want = add(out.unwrap[i], g.shift[k]);
                if out.comp[j] == u32::MAX {
                    out.comp[j] = id;
                    out.unwrap[j] = want;
                    out.members.push(j as u32);
                } else if out.unwrap[j] != want {
                    ext = true;
                }
            }
        }
        out.extended.push(ext);
        out.start.push(out.members.len());
    }
    out
}

/// The smallest rings (≤ `max_ring` atoms) through bond `k` of atom `i`, as
/// (atom, shift relative to atom `i`'s image) lists. Breadth-first from the far end of
/// the bond back to `i`, never stepping straight back across the bond itself; every
/// shortest path closes a ring.
fn smallest_rings(g: &PeriodicGraph, i: usize, k: usize, max_ring: usize) -> Vec<Vec<(u32, Shift)>> {
    let j = g.nbr[k] as usize;
    if g.degree(j) > MAX_RING_DEGREE {
        return Vec::new();
    }
    let target = image_key(i as u32, [0; 3]);
    let first = (j as u32, g.shift[k]);

    let mut nodes: Vec<(u32, Shift)> = vec![first];
    let mut parents: Vec<Vec<u32>> = vec![Vec::new()];
    let mut depth_of: Vec<usize> = vec![0];
    let mut index: HashMap<u64, u32> = HashMap::new();
    index.insert(image_key(first.0, first.1), 0);
    let mut layer: Vec<u32> = vec![0];
    let mut hit: Option<u32> = None;

    for depth in 1..max_ring {
        let mut next: Vec<u32> = Vec::new();
        for &ni in &layer {
            let (at, sa) = nodes[ni as usize];
            for e in g.bonds(at as usize) {
                let bt = g.nbr[e];
                let sb = add(sa, g.shift[e]);
                let key = image_key(bt, sb);
                if depth == 1 && key == target {
                    continue; // the bond itself
                }
                if key != target && g.degree(bt as usize) > MAX_RING_DEGREE {
                    continue;
                }
                match index.get(&key) {
                    None => {
                        let id = nodes.len() as u32;
                        nodes.push((bt, sb));
                        parents.push(vec![ni]);
                        depth_of.push(depth);
                        index.insert(key, id);
                        next.push(id);
                        if key == target {
                            hit = Some(id);
                        }
                    }
                    Some(&id) => {
                        if depth_of[id as usize] == depth {
                            parents[id as usize].push(ni);
                        }
                    }
                }
            }
        }
        if hit.is_some() || next.is_empty() {
            break;
        }
        layer = next;
    }

    let mut rings = Vec::new();
    if let Some(t) = hit {
        let mut path = vec![t];
        collect_paths(t, &parents, &nodes, &mut path, &mut rings);
    }
    rings
}

fn collect_paths(
    node: u32,
    parents: &[Vec<u32>],
    nodes: &[(u32, Shift)],
    path: &mut Vec<u32>,
    rings: &mut Vec<Vec<(u32, Shift)>>,
) {
    if rings.len() >= MAX_RINGS_PER_BOND {
        return;
    }
    if node == 0 {
        rings.push(path.iter().map(|&p| nodes[p as usize]).collect());
        return;
    }
    for &p in &parents[node as usize] {
        path.push(p);
        collect_paths(p, parents, nodes, path, rings);
        path.pop();
    }
}

/// Atoms to add, as (source atom, cell shift) pairs, given the displayed images `seeds`
/// in the same encoding. Each added image appears once and none repeats a seed.
pub fn complete(
    g: &PeriodicGraph,
    comps: &Components,
    seeds: &[(u32, Shift)],
    max_ring: usize,
) -> Vec<(u32, Shift)> {
    let base: HashSet<u64> = seeds.iter().map(|&(s, t)| image_key(s, t)).collect();
    let mut shown = base.clone();
    let mut out: Vec<(u32, Shift)> = Vec::new();

    // Finite fragments: every copy with a displayed atom is drawn whole. A copy is
    // identified by the cell shift of its component's unwrapped frame.
    let mut placed: HashSet<(u32, Shift)> = HashSet::new();
    for &(src, t) in seeds {
        let i = src as usize;
        let c = comps.comp[i] as usize;
        if comps.extended[c] || comps.members(c).len() < 2 {
            continue;
        }
        let origin = sub(t, comps.unwrap[i]);
        if !placed.insert((c as u32, origin)) {
            continue;
        }
        for &m in comps.members(c) {
            let s = add(origin, comps.unwrap[m as usize]);
            if shown.insert(image_key(m, s)) {
                out.push((m, s));
            }
        }
    }

    // Rings in extended components, through the bonds that leave the displayed set. The
    // test is against the seeds, not the growing set, so a ring added through one bond
    // does not hide a second ring that needs another.
    let max_ring = max_ring.min(MAX_RING_LIMIT);
    if max_ring >= 3 {
        let mut memo: HashMap<usize, Vec<Vec<(u32, Shift)>>> = HashMap::new();
        for &(src, t) in seeds {
            let i = src as usize;
            if !comps.extended[comps.comp[i] as usize] || g.degree(i) > MAX_RING_DEGREE {
                continue;
            }
            for k in g.bonds(i) {
                if base.contains(&image_key(g.nbr[k], add(t, g.shift[k]))) {
                    continue;
                }
                let rings = memo.entry(k).or_insert_with(|| smallest_rings(g, i, k, max_ring));
                for ring in rings.iter() {
                    for &(m, rs) in ring {
                        let s = add(t, rs);
                        if shown.insert(image_key(m, s)) {
                            out.push((m, s));
                        }
                    }
                }
            }
        }
    }
    out
}

/// One-call entry for `periodic_wrapped`: graph, components, completion.
pub fn complete_fragments(
    frac: &[Vec3],
    elem: &[u32],
    rows: [Vec3; 3],
    cutoff: &[f64],
    n_elem: usize,
    seeds: &[(u32, Shift)],
    max_ring: usize,
) -> Vec<(u32, Shift)> {
    let g = build_graph(frac, elem, rows, cutoff, n_elem);
    if g.nbr.is_empty() {
        return Vec::new();
    }
    let comps = components(&g);
    complete(&g, &comps, seeds, max_ring)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn ortho(a: f64, b: f64, c: f64) -> [Vec3; 3] {
        [Vec3::new(a, 0.0, 0.0), Vec3::new(0.0, b, 0.0), Vec3::new(0.0, 0.0, c)]
    }

    fn v(f: [f64; 3]) -> Vec3 {
        Vec3::new(f[0], f[1], f[2])
    }

    /// Seeds as the wrapped set draws them: every atom once, in the home cell.
    fn home_seeds(frac: &[Vec3]) -> Vec<(u32, Shift)> {
        frac.iter()
            .enumerate()
            .map(|(i, f)| (i as u32, [-(f.x.floor() as i32), -(f.y.floor() as i32), -(f.z.floor() as i32)]))
            .collect()
    }

    fn run(frac: &[Vec3], elem: &[u32], rows: [Vec3; 3], cutoff: &[f64], n_elem: usize, max_ring: usize) -> Vec<(u32, Shift)> {
        let seeds = home_seeds(frac);
        complete_fragments(frac, elem, rows, cutoff, n_elem, &seeds, max_ring)
    }

    /// Cartesian positions of seeds + added atoms.
    fn drawn(frac: &[Vec3], rows: [Vec3; 3], added: &[(u32, Shift)]) -> Vec<Vec3> {
        let to_cart = |f: Vec3| rows[0].scale(f.x).add(rows[1].scale(f.y)).add(rows[2].scale(f.z));
        let mut out: Vec<Vec3> = home_seeds(frac)
            .iter()
            .chain(added.iter())
            .map(|&(s, t)| {
                let f = frac[s as usize];
                to_cart(Vec3::new(f.x + t[0] as f64, f.y + t[1] as f64, f.z + t[2] as f64))
            })
            .collect();
        out.dedup();
        out
    }

    #[test]
    fn dimer_across_a_face_is_completed_from_both_sides() {
        // N2 (1.1 Å) across the x face of a 10 Å cell.
        let rows = ortho(10.0, 10.0, 10.0);
        let frac = vec![v([0.97, 0.5, 0.5]), v([0.08, 0.5, 0.5])];
        let added = run(&frac, &[0, 0], rows, &[1.3], 1, 6);
        let set: BTreeSet<(u32, Shift)> = added.into_iter().collect();
        // Partner of atom 0 at +x, partner of atom 1 at −x.
        let want: BTreeSet<(u32, Shift)> = [(1, [1, 0, 0]), (0, [-1, 0, 0])].into_iter().collect();
        assert_eq!(set, want);
    }

    #[test]
    fn whole_molecule_inside_the_cell_adds_nothing() {
        let rows = ortho(10.0, 10.0, 10.0);
        let frac = vec![v([0.45, 0.5, 0.5]), v([0.56, 0.5, 0.5])];
        assert!(run(&frac, &[0, 0], rows, &[1.3], 1, 6).is_empty());
    }

    fn hexagon(center: [f64; 3], r: f64, l: f64) -> Vec<Vec3> {
        (0..6)
            .map(|k| {
                let t = std::f64::consts::PI / 3.0 * k as f64;
                let x = center[0] + r * t.cos() / l;
                let y = center[1] + r * t.sin() / l;
                // Wrapped into the home cell, as a file would give it.
                v([x - x.floor(), y - y.floor(), center[2]])
            })
            .collect()
    }

    #[test]
    fn benzene_ring_across_a_corner_is_closed() {
        // C6 ring (1.4 Å) centred on the cell edge x = y = 0: the wrapped ring is split
        // over four corners of the cell.
        let l = 12.0;
        let rows = ortho(l, l, l);
        let frac = hexagon([0.0, 0.0, 0.5], 1.4, l);
        let added = run(&frac, &[0; 6], rows, &[1.6], 1, 6);
        // Each drawn copy is a full ring: every atom has two partners at 1.4 Å.
        let pts = drawn(&frac, rows, &added);
        for p in &pts {
            let partners = pts.iter().filter(|q| (q.dist(*p) - 1.4).abs() < 1e-6).count();
            assert_eq!(partners, 2, "ring atom with {partners} partners at {p:?}");
        }
        // One whole copy per corner the ring's atoms fall into.
        assert_eq!(pts.len(), 4 * 6);
    }

    #[test]
    fn s8_crown_completes_as_one_molecule() {
        // A puckered 8-ring of 2.05 Å S–S bonds straddling the y face.
        let l = 9.0;
        let rows = ortho(l, l, l);
        let r = 2.05 / (2.0 * (std::f64::consts::PI / 8.0).sin());
        let frac: Vec<Vec3> = (0..8)
            .map(|k| {
                let t = std::f64::consts::PI / 4.0 * k as f64;
                let z = if k % 2 == 0 { 0.4 } else { -0.4 };
                let y = (r * t.sin()) / l;
                v([0.5 + r * t.cos() / l, y - y.floor(), 0.5 + z / l])
            })
            .collect();
        let added = run(&frac, &[0; 8], rows, &[2.4], 1, 6);
        let pts = drawn(&frac, rows, &added);
        for p in &pts {
            let partners = pts
                .iter()
                .filter(|q| {
                    let d = q.dist(*p);
                    d > 0.1 && d < 2.4
                })
                .count();
            assert_eq!(partners, 2);
        }
    }

    #[test]
    fn infinite_chain_is_not_grown() {
        // A linear chain along x with one atom per 2 Å cell: bonds to its own image.
        let rows = ortho(2.0, 10.0, 10.0);
        let frac = vec![v([0.5, 0.5, 0.5])];
        assert!(run(&frac, &[0], rows, &[2.1], 1, 6).is_empty());
    }

    fn graphene_sheet(nx: usize, ny: usize) -> (Vec<Vec3>, [Vec3; 3]) {
        // Orthorhombic graphene supercell, C–C 1.42 Å, sheet at z = 0 (on the cell face).
        let cc = 1.42;
        let a = 3.0 * cc;
        let b = 3f64.sqrt() * cc;
        let rows = ortho(a * nx as f64, b * ny as f64, 6.7);
        let basis = [[0.0, 0.0], [cc, 0.0], [1.5 * cc, b / 2.0], [2.5 * cc, b / 2.0]];
        let mut frac = Vec::new();
        for ix in 0..nx {
            for iy in 0..ny {
                for p in basis {
                    frac.push(v([
                        (p[0] + a * ix as f64) / rows[0].x,
                        (p[1] + b * iy as f64) / rows[1].y,
                        0.0,
                    ]));
                }
            }
        }
        (frac, rows)
    }

    #[test]
    fn graphite_rings_through_the_boundary_are_closed() {
        let (frac, rows) = graphene_sheet(2, 2);
        let n = frac.len();
        let added = run(&frac, &vec![0; n], rows, &[1.6], 1, 6);
        assert!(!added.is_empty());
        let pts = drawn(&frac, rows, &added);
        // Every hexagon that has a home atom is drawn whole: each home atom's 3 partners
        // are drawn, and each of those has its ring partners too.
        let partners = |p: Vec3| pts.iter().filter(|q| (q.dist(p) - 1.42).abs() < 1e-3).count();
        for f in &frac {
            let p = rows[0].scale(f.x).add(rows[1].scale(f.y)).add(rows[2].scale(f.z));
            assert_eq!(partners(p), 3);
        }
        // Only the ring shell is added: a sheet is never grown wholesale. One ring
        // around the 4×(2×2) = 16-atom cell adds well under another 16 per side.
        assert!(added.len() < 4 * n, "added {}", added.len());
        // Every added atom lies on a closed ring next to the cell: two drawn partners at
        // least, never more than one cell away.
        for (k, &(s, t)) in added.iter().enumerate() {
            assert!(t.iter().all(|d| d.abs() <= 1), "{s} {t:?}");
            assert!(partners(pts[n + k]) >= 2, "dangling ring atom {s} {t:?}");
        }
    }

    #[test]
    fn ring_completion_off_leaves_sheet_alone() {
        let (frac, rows) = graphene_sheet(2, 2);
        let n = frac.len();
        assert!(run(&frac, &vec![0; n], rows, &[1.6], 1, 0).is_empty());
    }

    #[test]
    fn close_packed_metal_is_left_alone() {
        // fcc (a = 3.6 Å): 12 neighbours at 2.55 Å, all within the cutoff.
        let rows = ortho(3.6, 3.6, 3.6);
        let frac = vec![
            v([0.0, 0.0, 0.0]),
            v([0.5, 0.5, 0.0]),
            v([0.5, 0.0, 0.5]),
            v([0.0, 0.5, 0.5]),
        ];
        assert!(run(&frac, &[0; 4], rows, &[2.8], 1, 6).is_empty());
    }

    #[test]
    fn rock_salt_is_left_alone() {
        // NaCl with the Na–Cl bond kept (as when the metal filter is off): 6-coordinate.
        let rows = ortho(5.64, 5.64, 5.64);
        let mut frac = Vec::new();
        let mut elem = Vec::new();
        for f in [[0.0, 0.0, 0.0], [0.5, 0.5, 0.0], [0.5, 0.0, 0.5], [0.0, 0.5, 0.5]] {
            frac.push(v(f));
            elem.push(0);
            frac.push(v([(f[0] + 0.5) % 1.0, f[1], f[2]]));
            elem.push(1);
        }
        assert!(run(&frac, &elem, rows, &[0.0, 3.0, 3.0, 0.0], 2, 6).is_empty());
    }

    #[test]
    fn carbonate_completes_when_metal_bonds_are_dropped() {
        // CO3 straddling the x face next to a Ca. Elements: 0 = Ca, 1 = C, 2 = O.
        let l = 8.0;
        let rows = ortho(l, l, l);
        let co = 1.28;
        let mut frac = vec![v([0.0, 0.5, 0.5])]; // C on the face
        for k in 0..3 {
            let t = 2.0 * std::f64::consts::PI / 3.0 * k as f64;
            let x = co * t.cos() / l;
            frac.push(v([x - x.floor(), 0.5 + co * t.sin() / l, 0.5]));
        }
        frac.push(v([0.0, 0.5, 0.5 + 2.4 / l])); // Ca above the C
        let elem = [1, 2, 2, 2, 0];
        // C–O bonded; Ca–O zeroed by the caller's metal filter.
        let molecular = [0.0, 0.0, 0.0, 0.0, 0.0, 1.5, 0.0, 1.5, 0.0];
        let added = run(&frac, &elem, rows, &molecular, 3, 6);
        let pts = drawn(&frac, rows, &added);
        let c = rows[0].scale(frac[0].x).add(rows[1].scale(frac[0].y)).add(rows[2].scale(frac[0].z));
        let o_round_c = pts.iter().filter(|q| (q.dist(c) - co).abs() < 1e-6).count();
        assert_eq!(o_round_c, 3);
    }

    #[test]
    fn image_key_round_trips_distinct_shifts() {
        let mut seen = HashSet::new();
        for s in [-3, -1, 0, 1, 3] {
            for t in [-2, 0, 2] {
                assert!(seen.insert(image_key(7, [s, t, -s])));
            }
        }
        assert_ne!(image_key(1, [0, 0, 0]), image_key(0, [0, 0, 0]));
    }
}
