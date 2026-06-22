mod linalg;

use linalg::{cart_to_frac, frac_to_cart_flat, lattice_from_flat, Matrix33, Vec3};
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Wrap a single fractional coordinate component into [0, 1).
#[inline]
fn wrap1(x: f64) -> f64 {
    x - x.floor()
}

/// Wrap a Vec3 of fractional coords into [0,1)^3.
#[inline]
fn wrap_frac(v: Vec3) -> Vec3 {
    Vec3::new(wrap1(v.x), wrap1(v.y), wrap1(v.z))
}

// ---------------------------------------------------------------------------
// Output struct
// ---------------------------------------------------------------------------

/// The flat arrays returned to JavaScript.
/// Each atom occupies one slot:
///   elements[i]         – element index (u32, mirrors the input u32 array)
///   frac[3*i..3*i+3]    – fractional coordinates
///   cart[3*i..3*i+3]    – Cartesian coordinates
///   src_index[i]        – index into original atoms array
#[wasm_bindgen]
pub struct PeriodicResult {
    elements: Vec<u32>,
    frac: Vec<f64>,
    cart: Vec<f64>,
    src_index: Vec<u32>,
}

#[wasm_bindgen]
impl PeriodicResult {
    // Expose each field as a copied JS typed-array.
    pub fn elements(&self) -> Vec<u32> {
        self.elements.clone()
    }
    pub fn frac(&self) -> Vec<f64> {
        self.frac.clone()
    }
    pub fn cart(&self) -> Vec<f64> {
        self.cart.clone()
    }
    pub fn src_index(&self) -> Vec<u32> {
        self.src_index.clone()
    }
    pub fn len(&self) -> usize {
        self.elements.len()
    }
}

// ---------------------------------------------------------------------------
// Thin wrapper around a bond-cutoff table passed from JS
// ---------------------------------------------------------------------------

/// `bond_table` is a flat array of length `n_elem * n_elem` giving the
/// maximum bond distance between element-pair (i, j).  Pass 0.0 for pairs
/// that should not form bonds.  n_elem is the number of distinct element
/// species (indices used in the `elements` array must be < n_elem).
fn get_bond_cutoff(bond_table: &[f64], n_elem: usize, ei: usize, ej: usize) -> f64 {
    if ei < n_elem && ej < n_elem {
        bond_table[ei * n_elem + ej]
    } else {
        0.0
    }
}

// ---------------------------------------------------------------------------
// Core: periodic wrapping + ghost-atom generation
// ---------------------------------------------------------------------------

/// Rust implementation of `periodicWrapped`.
///
/// # Arguments
/// * `show_periodic` – if false, return atoms wrapped into unit cell (no ghosts).
/// * `show_pbc_bonds` – if true, append ghost atoms needed for cross-boundary bonds.
/// * `elements_in` – flat u32 array of element indices (length N).
/// * `frac_in`     – flat f64 array of fractional coords (length 3N, row-major).
/// * `lattice_flat`– flat f64 array, row-major 3×3 lattice matrix [a; b; c].
/// * `bond_table`  – flat f64 cutoff matrix, length n_elem × n_elem.
/// * `n_elem`      – number of element species.
/// * `face_tol`    – tolerance (fractional coords) for treating an atom as
///   sitting on a cell face/edge/corner. Real structures carry small offsets
///   from 0/1, so this must be looser than machine eps (default ~1e-3).
#[wasm_bindgen]
pub fn periodic_wrapped(
    show_periodic: bool,
    show_pbc_bonds: bool,
    elements_in: &[u32],
    frac_in: &[f64],
    lattice_flat: &[f64],
    bond_table: &[f64],
    n_elem: usize,
    face_tol: f64,
) -> PeriodicResult {
    let n = elements_in.len();
    assert_eq!(frac_in.len(), 3 * n);
    assert_eq!(lattice_flat.len(), 9);

    let lattice = lattice_from_flat(lattice_flat);
    let lat_inv = lattice
        .inverse()
        .expect("Lattice matrix must be invertible");

    // ------------------------------------------------------------------
    // Fast path: showPeriodic = false  →  just wrap atoms, no ghosts
    // ------------------------------------------------------------------
    if !show_periodic {
        let mut frac_out = Vec::with_capacity(3 * n);
        let mut cart_out = Vec::with_capacity(3 * n);
        let src_index: Vec<u32> = (0..n as u32).collect();

        for i in 0..n {
            let f = Vec3::new(frac_in[3 * i], frac_in[3 * i + 1], frac_in[3 * i + 2]);
            let fw = wrap_frac(f);
            let c = lattice.mul_vec(fw);
            frac_out.extend_from_slice(&[fw.x, fw.y, fw.z]);
            cart_out.extend_from_slice(&[c.x, c.y, c.z]);
        }

        return PeriodicResult {
            elements: elements_in.to_vec(),
            frac: frac_out,
            cart: cart_out,
            src_index,
        };
    }

    // ------------------------------------------------------------------
    // showPeriodic = true  →  wrap atoms and duplicate boundary atoms
    // ------------------------------------------------------------------
    // Detect which cell faces an atom sits on within `face_tol` (fractional);
    // each detected face contributes a mirror offset. Every combination is
    // emitted unconditionally — a corner atom lands on all 8 corners, an edge
    // atom on all 4 edges, a face atom on both faces. Mirrors are placed at the
    // true periodic position (f ± 1), with no re-detection or clamping of the
    // mirrored coordinate. Mirrors the JS implementation (periodicWrappedJS).
    let mut new_elements: Vec<u32> = Vec::with_capacity(n * 2);
    let mut new_frac: Vec<Vec3> = Vec::with_capacity(n * 2);
    let mut new_cart: Vec<Vec3> = Vec::with_capacity(n * 2);
    let mut new_src: Vec<u32> = Vec::with_capacity(n * 2);

    for i in 0..n {
        let f = Vec3::new(frac_in[3 * i], frac_in[3 * i + 1], frac_in[3 * i + 2]);
        let atm = elements_in[i];

        // Offsets to try on each axis: always include 0; add ±1 if near a face.
        let offs = |coord: f64| -> &'static [f64] {
            if coord < face_tol {
                &[0.0, 1.0]          // near 0 face → also mirror to +1
            } else if coord > 1.0 - face_tol {
                &[0.0, -1.0]         // near 1 face → also mirror to -1
            } else {
                &[0.0]
            }
        };

        for &dx in offs(f.x) {
            for &dy in offs(f.y) {
                for &dz in offs(f.z) {
                    let fw = Vec3::new(f.x + dx, f.y + dy, f.z + dz);
                    let c = lattice.mul_vec(fw);
                    new_elements.push(atm);
                    new_frac.push(fw);
                    new_cart.push(c);
                    new_src.push(i as u32);
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // showPBCBonds  →  ghost atoms for cross-boundary bonds
    // ------------------------------------------------------------------
    if show_pbc_bonds && !bond_table.is_empty() {
        let max_cutoff = bond_table
            .iter()
            .cloned()
            .fold(0.0_f64, f64::max);

        if max_cutoff > 1e-6 {
            // NOTE: `lattice` here is Lᵀ — periodicWasm.js sends the lattice
            // transposed so `mul_vec` yields correct Cartesian coords. The real
            // lattice vectors a/b/c are therefore the *columns* of `lattice.data`,
            // not its rows. (The JS reference uses the untransposed rows directly.)
            let real = lattice.transpose();
            let a = Vec3::new(real.data[0][0], real.data[0][1], real.data[0][2]);
            let b = Vec3::new(real.data[1][0], real.data[1][1], real.data[1][2]);
            let c = Vec3::new(real.data[2][0], real.data[2][1], real.data[2][2]);

            let ax = (max_cutoff / a.norm().max(1e-6)).ceil().clamp(1.0, 2.0) as i32;
            let by = (max_cutoff / b.norm().max(1e-6)).ceil().clamp(1.0, 2.0) as i32;
            let cz = (max_cutoff / c.norm().max(1e-6)).ceil().clamp(1.0, 2.0) as i32;

            // Pre-build shift vectors (exclude zero shift)
            let shifts: Vec<(i32, i32, i32, Vec3)> = {
                let mut s = Vec::new();
                for dx in -ax..=ax {
                    for dy in -by..=by {
                        for dz in -cz..=cz {
                            if dx == 0 && dy == 0 && dz == 0 {
                                continue;
                            }
                            let sv = a
                                .scale(dx as f64)
                                .add(b.scale(dy as f64))
                                .add(c.scale(dz as f64));
                            s.push((dx, dy, dz, sv));
                        }
                    }
                }
                s
            };

            // Snapshot the wrapped atoms before we start appending ghosts
            let wrapped_len = new_cart.len();

            // Pre-compute original atoms in Cartesian
            let orig_cart: Vec<Vec3> = (0..n)
                .map(|j| {
                    let f = Vec3::new(frac_in[3 * j], frac_in[3 * j + 1], frac_in[3 * j + 2]);
                    lattice.mul_vec(f)
                })
                .collect();

            // Encode ghost key as (j, dx+2, dy+2, dz+2) packed into a u32.
            // dx,dy,dz ∈ [-2,2] → offset by 2 → [0,4] → fits 3 bits each.
            // j fits in the upper bits if n < 2^23.
            let encode_key = |j: usize, dx: i32, dy: i32, dz: i32| -> u64 {
                let dx = (dx + 4) as u64; // offset so always >= 0
                let dy = (dy + 4) as u64;
                let dz = (dz + 4) as u64;
                ((j as u64) << 12) | (dx << 8) | (dy << 4) | dz
            };

            let mut ghost_added: HashSet<u64> = HashSet::new();

            for i in 0..wrapped_len {
                let pi = new_cart[i];
                let ei = new_elements[i] as usize;

                for j in 0..n {
                    let ej = elements_in[j] as usize;
                    let cutoff = get_bond_cutoff(bond_table, n_elem, ei, ej);
                    if cutoff <= 0.01 {
                        continue;
                    }

                    let fj_cart = orig_cart[j];

                    for &(dx, dy, dz, sv) in &shifts {
                        let candidate = fj_cart.add(sv);
                        let d = pi.dist(candidate);

                        if d <= cutoff && d >= 0.005 {
                            let key = encode_key(j, dx, dy, dz);
                            if ghost_added.insert(key) {
                                let cf = cart_to_frac(candidate, &lat_inv);
                                new_elements.push(elements_in[j]);
                                new_frac.push(cf);
                                new_cart.push(candidate);
                                new_src.push(j as u32);
                            }
                        }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Flatten to JS-friendly typed arrays
    // ------------------------------------------------------------------
    let frac_flat: Vec<f64> = new_frac
        .iter()
        .flat_map(|v| [v.x, v.y, v.z])
        .collect();
    let cart_flat: Vec<f64> = new_cart
        .iter()
        .flat_map(|v| [v.x, v.y, v.z])
        .collect();

    PeriodicResult {
        elements: new_elements,
        frac: frac_flat,
        cart: cart_flat,
        src_index: new_src,
    }
}
