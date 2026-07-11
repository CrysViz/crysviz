//! Neighbour-bond pair finder. The display ("wrapped") atom set already has all periodic
//! ghosts materialised, so finding bonds is just an all-pairs-within-cutoff search over a
//! flat Cartesian point cloud — O(n) with the shared `CellList` (Cartesian mode) instead
//! of the previous O(n²) double loop. Returns the bonding pairs (i, j) with i < j; the JS
//! side builds the `Bond` objects (colours, ids) from them.

use crate::cell_list::{BinMode, CellList};
use crate::linalg::Vec3;

pub struct BondPairs {
    pub i: Vec<u32>,
    pub j: Vec<u32>,
}

/// Find bonding pairs among `cart` (flat x,y,z) over the atom range `[i_start,i_end)` —
/// each pair is owned by the partition holding its lower index `i`, so concatenating
/// partitions yields every pair exactly once. `cutoff_sq`/`min_cutoff_sq` are the
/// per-element-pair squared cutoffs (n_elem × n_elem); `max_cutoff` sizes the grid cell.
#[allow(clippy::too_many_arguments)]
pub fn compute_bond_pairs(
    cart: &[f64],
    elem_idx: &[u32],
    cutoff_sq: &[f64],
    min_cutoff_sq: &[f64],
    n_elem: usize,
    min_dist_sq: f64,
    max_cutoff: f64,
    i_start: usize,
    i_end: usize,
) -> BondPairs {
    let n = elem_idx.len();
    let points: Vec<Vec3> = (0..n)
        .map(|k| Vec3::new(cart[3 * k], cart[3 * k + 1], cart[3 * k + 2]))
        .collect();

    let mut out = BondPairs { i: Vec::new(), j: Vec::new() };
    if n == 0 || i_start >= i_end {
        return out;
    }

    // Bounding box → Cartesian grid with cell size = max_cutoff (so any bonded pair lies
    // in the query cell or an immediate neighbour → halo 1).
    let mut mn = points[0];
    let mut mx = points[0];
    for p in &points {
        mn = Vec3::new(mn.x.min(p.x), mn.y.min(p.y), mn.z.min(p.z));
        mx = Vec3::new(mx.x.max(p.x), mx.y.max(p.y), mx.z.max(p.z));
    }
    let cs = max_cutoff.max(1e-3);
    let inv = 1.0 / cs;
    let gx = 1.max(((mx.x - mn.x) * inv).ceil() as i32);
    let gy = 1.max(((mx.y - mn.y) * inv).ceil() as i32);
    let gz = 1.max(((mx.z - mn.z) * inv).ceil() as i32);
    let mut grid = CellList::new(
        &points,
        gx,
        gy,
        gz,
        BinMode::Cart { origin: mn, inv_size: Vec3::new(inv, inv, inv) },
    );

    let cutoff = |a: usize, b: usize| if a < n_elem && b < n_elem { cutoff_sq[a * n_elem + b] } else { 0.0 };
    let min_cut = |a: usize, b: usize| if a < n_elem && b < n_elem { min_cutoff_sq[a * n_elem + b] } else { 0.0 };

    let mut scratch: Vec<usize> = Vec::new();
    for i in i_start..i_end {
        let pi = points[i];
        let ai = elem_idx[i] as usize;
        grid.candidates(pi, 1, 1, 1, &mut scratch);
        // Ascending order so the emitted pair order matches the serial JS double loop.
        scratch.sort_unstable();
        for &j in scratch.iter() {
            if j <= i {
                continue;
            }
            let bj = elem_idx[j] as usize;
            let cut_sq = cutoff(ai, bj);
            if cut_sq <= 0.0001 {
                continue;
            }
            let d = pi.sub(points[j]);
            let dsq = d.dot(d);
            if dsq > cut_sq || dsq < min_dist_sq || dsq < min_cut(ai, bj) {
                continue;
            }
            out.i.push(i as u32);
            out.j.push(j as u32);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 3×3×3 simple-cubic block (spacing 1, one element). Each interior atom bonds to its
    // 6 axis neighbours; the cell list must find exactly the same pairs as a brute-force
    // O(n²) scan, and partitioning the i-range must give the same set.
    fn cubic() -> (Vec<f64>, Vec<u32>) {
        let mut cart = Vec::new();
        for x in 0..3 {
            for y in 0..3 {
                for z in 0..3 {
                    cart.extend_from_slice(&[x as f64, y as f64, z as f64]);
                }
            }
        }
        let elem = vec![0u32; 27];
        (cart, elem)
    }

    fn brute(cart: &[f64], cut: f64) -> Vec<(u32, u32)> {
        let n = cart.len() / 3;
        let mut v = Vec::new();
        for i in 0..n {
            for j in (i + 1)..n {
                let dx = cart[3 * i] - cart[3 * j];
                let dy = cart[3 * i + 1] - cart[3 * j + 1];
                let dz = cart[3 * i + 2] - cart[3 * j + 2];
                let dsq = dx * dx + dy * dy + dz * dz;
                if dsq <= cut * cut && dsq >= 1e-6 {
                    v.push((i as u32, j as u32));
                }
            }
        }
        v
    }

    fn pairs_set(p: &BondPairs) -> std::collections::HashSet<(u32, u32)> {
        p.i.iter().zip(p.j.iter()).map(|(&a, &b)| (a, b)).collect()
    }

    #[test]
    fn matches_bruteforce() {
        let (cart, elem) = cubic();
        let cut = 1.1; // first shell only
        let csq = vec![cut * cut];
        let mcsq = vec![0.0];
        let r = compute_bond_pairs(&cart, &elem, &csq, &mcsq, 1, 1e-6, cut, 0, 27);
        let want: std::collections::HashSet<_> = brute(&cart, cut).into_iter().collect();
        assert_eq!(pairs_set(&r), want);
        // 54 bonds in a 3×3×3 simple cubic (interior connections).
        assert_eq!(r.i.len(), want.len());
    }

    #[test]
    fn partition_matches_full() {
        let (cart, elem) = cubic();
        let cut = 1.1;
        let csq = vec![cut * cut];
        let mcsq = vec![0.0];
        let full = compute_bond_pairs(&cart, &elem, &csq, &mcsq, 1, 1e-6, cut, 0, 27);
        let p0 = compute_bond_pairs(&cart, &elem, &csq, &mcsq, 1, 1e-6, cut, 0, 13);
        let p1 = compute_bond_pairs(&cart, &elem, &csq, &mcsq, 1, 1e-6, cut, 13, 27);
        let mut merged = pairs_set(&p0);
        merged.extend(pairs_set(&p1));
        assert_eq!(merged, pairs_set(&full));
        assert_eq!(p0.i.len() + p1.i.len(), full.i.len());
    }
}
