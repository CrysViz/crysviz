//! Generic spatial cell list shared by the neighbour searches (polyhedra) and the bond
//! pair finder. Points are binned into a Gx×Gy×Gz grid; a query returns the indices of
//! points in the surrounding ±halo bins, deduplicated cheaply with a per-query stamp.
//!
//! Two binning modes cover the callers' needs:
//!   - `Frac`: bin by **wrapped fractional** coordinate; queries wrap around (periodic) —
//!     used by the polyhedra neighbour search, which finds atoms across cell boundaries.
//!   - `Cart`: bin by **Cartesian** coordinate over a bounding box; queries clamp (no
//!     wrap) — used by the bond pair finder over the already-materialised wrapped set.

use crate::linalg::Vec3;

pub enum BinMode {
    /// Periodic: coordinate is fractional; bin = floor(wrap(f) * G); queries wrap.
    Frac,
    /// Non-periodic: bin = floor((cart - origin) * inv_size); queries clamp.
    Cart { origin: Vec3, inv_size: Vec3 },
}

pub struct CellList {
    pub gx: i32,
    pub gy: i32,
    pub gz: i32,
    bins: Vec<Vec<u32>>,
    stamp: Vec<i32>,
    qid: i32,
    mode: BinMode,
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

#[inline]
fn clamp_bin(b: i32, g: i32) -> i32 {
    b.clamp(0, g - 1)
}

/// Bins to visit along one axis: wrapped ±halo (periodic) or clamped ±halo (non-periodic).
fn axis_range(g: i32, halo: i32, total: i32, periodic: bool) -> Vec<i32> {
    if periodic {
        if 2 * halo + 1 >= total {
            (0..total).collect()
        } else {
            (-halo..=halo).map(|d| ((g + d) % total + total) % total).collect()
        }
    } else {
        ((g - halo).max(0)..=(g + halo).min(total - 1)).collect()
    }
}

impl CellList {
    /// Build a cell list over `points` with the given grid dimensions and binning mode.
    /// `points` are fractional for `Frac` and Cartesian for `Cart`.
    pub fn new(points: &[Vec3], gx: i32, gy: i32, gz: i32, mode: BinMode) -> CellList {
        let mut cl = CellList {
            gx,
            gy,
            gz,
            bins: vec![Vec::new(); (gx * gy * gz) as usize],
            stamp: vec![-1; points.len()],
            qid: 0,
            mode,
        };
        for (j, &p) in points.iter().enumerate() {
            let (bx, by, bz) = cl.bin_of(p);
            cl.bins[((bx * gy + by) * gz + bz) as usize].push(j as u32);
        }
        cl
    }

    #[inline]
    fn bin_of(&self, p: Vec3) -> (i32, i32, i32) {
        match &self.mode {
            BinMode::Frac => (wrap_bin(p.x, self.gx), wrap_bin(p.y, self.gy), wrap_bin(p.z, self.gz)),
            BinMode::Cart { origin, inv_size } => (
                clamp_bin(((p.x - origin.x) * inv_size.x).floor() as i32, self.gx),
                clamp_bin(((p.y - origin.y) * inv_size.y).floor() as i32, self.gy),
                clamp_bin(((p.z - origin.z) * inv_size.z).floor() as i32, self.gz),
            ),
        }
    }

    /// Indices of points within `±(hx,hy,hz)` bins of `p`, deduplicated. `p` is fractional
    /// for `Frac`, Cartesian for `Cart`. Results are appended to (the cleared) `out`.
    pub fn candidates(&mut self, p: Vec3, hx: i32, hy: i32, hz: i32, out: &mut Vec<usize>) {
        out.clear();
        let qid = self.qid;
        self.qid += 1;
        let periodic = matches!(self.mode, BinMode::Frac);
        let (bx, by, bz) = self.bin_of(p);
        let xs = axis_range(bx, hx, self.gx, periodic);
        let ys = axis_range(by, hy, self.gy, periodic);
        let zs = axis_range(bz, hz, self.gz, periodic);
        for &cx in &xs {
            for &cy in &ys {
                for &cz in &zs {
                    let bin = &self.bins[((cx * self.gy + cy) * self.gz + cz) as usize];
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
