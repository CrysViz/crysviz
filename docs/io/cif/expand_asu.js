import { single_asu_from_cif_file } from "./cif_parser.js";
import { single_mag_asu_from_mcif_file } from "./mcif_parser.js";

// ---------------- Vector helpers ----------------

/** @param {number[]|Float64Array} v */
function _wrap01(v) {
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = Number(v[i]);
    out[i] = x - Math.floor(x);
  }
  return out;
}

/**
 * Snap fractional coords to nearest multiple of 1/grid_den, wrap to [0,1).
 * Mirrors _snap_to_grid.
 *
 * @param {number[]|Float64Array} v
 * @param {number} grid_den
 * @param {number} tol
 * @returns {number[]}
 */
function _snap_to_grid(v, grid_den, tol = 1e-8) {
  const w = _wrap01(v);
  const out = new Array(w.length);
  for (let i = 0; i < w.length; i++) {
    let idx = Math.floor(w[i] * grid_den + 0.5);
    idx = ((idx % grid_den) + grid_den) % grid_den;
    out[i] = idx / grid_den;
  }
  return out;
}

/**
 * Hashable key for a position after snapping.
 * Mirrors pos_key.
 *
 * @param {number[]|Float64Array} v
 * @param {number} grid_den
 * @param {number} tol
 * @returns {[number, number, number]}
 */
export function pos_key(v, grid_den, tol = 1e-8) {
  const v_snap = _snap_to_grid(v, grid_den, tol);
  return /** @type {[number, number, number]} */ ([
    Math.round(v_snap[0] * grid_den),
    Math.round(v_snap[1] * grid_den),
    Math.round(v_snap[2] * grid_den),
  ]);
}

/** @param {[number,number,number]} k @param {[number,number,number]} delta @param {number} grid_dens */
function _wrap_neighbor_key(k, delta, grid_dens) {
  return /** @type {[number,number,number]} */ ([
    (k[0] + delta[0] + grid_dens) % grid_dens,
    (k[1] + delta[1] + grid_dens) % grid_dens,
    (k[2] + delta[2] + grid_dens) % grid_dens,
  ]);
}

/**
 * Look for k in pos_map; if missing, check the 26 neighbors
 * (Chebyshev distance 1) with periodic boundaries.
 * Return found key string or null.
 *
 * In Python, pos_map was either a set or dict; here we use Map keyed by string.
 *
 * Mirrors find_adjacent_key_wrap.
 *
 * @param {[number,number,number]} k
 * @param {Map<string, any>} pos_map
 * @param {number} grid_dens
 * @returns {string|null}
 */
export function find_adjacent_key_wrap(k, pos_map, grid_dens) {
  const kStr = _keyToStr(k);
  if (pos_map.has(kStr)) return kStr;

  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const k2 = _wrap_neighbor_key(k, [dx, dy, dz], grid_dens);
        const s2 = _keyToStr(k2);
        if (pos_map.has(s2)) return s2;
      }
    }
  }
  return null;
}

/** @param {[number,number,number]} k */
function _keyToStr(k) {
  return `${k[0]},${k[1]},${k[2]}`;
}

/**
 * Apply a (fractional) symmetry operation and wrap to [0,1).
 * Works with int-like R and float-like t/f.
 * Mirrors apply_op_frac.
 *
 * @param {any[][]} R 3x3 int-like
 * @param {any[]} t length-3 (number or Fraction-like)
 * @param {number[]} f length-3 numbers
 * @returns {number[]}
 */
export function apply_op_frac(R, t, f) {
  // g = R @ f + t
  const g = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let s = 0;
    for (let j = 0; j < 3; j++) {
      s += Number(R[i][j]) * Number(f[j]);
    }
    const ti = t[i];
    g[i] = (ti && typeof ti === "object" && "toNumber" in ti) ? s + ti.toNumber() : s + Number(ti);
  }
  return _wrap01(g);
}

// ---------- Species helpers ----------

export function species_to_numbers(species) {
  const uniq = Array.from(new Set(species)).sort();
  const species_to_number = new Map();
  const numbers_to_species = {};
  for (let i = 0; i < uniq.length; i++) {
    species_to_number.set(uniq[i], i + 1);
    numbers_to_species[i + 1] = uniq[i];
  }
  const numbers = species.map((sp) => species_to_number.get(sp));
  return [numbers, numbers_to_species];
}

/**
 * Optional helper: give each distinct *label* a unique number.
 * Mirrors asu_data_to_numbers_by_labels.
 *
 * @param {any} asu_data
 * @returns {[number[], Record<number,string>]}
 */
export function asu_data_to_numbers_by_labels(asu_data) {
  const labels_map = new Map();
  const numbers_to_species = {};
  const numbers = [];
  let next_id = 1;
  for (let i = 0; i < asu_data.symbols.length; i++) {
    const sym = asu_data.symbols[i];
    const lab = asu_data.labels[i];
    if (!labels_map.has(lab)) {
      labels_map.set(lab, next_id);
      numbers_to_species[next_id] = sym;
      next_id += 1;
    }
    numbers.push(labels_map.get(lab));
  }
  return [numbers, numbers_to_species];
}

// ---------- Generalized expander ----------

/**
 * Generalized ASU expansion.
 * Mirrors expand_asu in Python.
 *
 * Nonmag:
 *   returns [positions_full, species_full]
 *
 * Mag:
 *   returns [positions_full, species_full, moments_full, mom_classes, symops_classes]
 *
 * @param {Iterable<any>} positions_frac
 * @param {Iterable<any>} species
 * @param {Array<any>} ops
 * @param {{
 *   grid_dens?: number,
 *   tol?: number,
 *   moments?: any[]|null,
 *   apply_op_moment_fn?: Function|null,
 *   spin_basis?: string|null,
 *   basis?: any|null,
 *   mag_grid_dens?: number
 * }=} opts
 * @returns {any}
 */
export function expand_asu(
  positions_frac,
  species,
  ops,
  opts = {}
) {
  const grid_dens = opts.grid_dens !== undefined ? opts.grid_dens : 16384;
  const mag_grid_dens = opts.mag_grid_dens !== undefined ? opts.mag_grid_dens : 16384;

  const posSeeds = Array.from(positions_frac);
  const spSeeds = Array.from(species);

  const momentsIn = opts.moments != null ? Array.from(opts.moments) : null;
  const apply_op_moment_fn = opts.apply_op_moment_fn ?? null;
  const spin_basis = opts.spin_basis ?? null;
  const basis = opts.basis ?? null;

  if (momentsIn != null) {
    if (posSeeds.length !== spSeeds.length || spSeeds.length !== momentsIn.length) {
      throw new Error("len(positions_frac), len(species), len(moments) must match");
    }
    if (!apply_op_moment_fn) throw new Error("moments provided but apply_op_moment_fn is None");
    if (!spin_basis) throw new Error("moments provided but spin_basis is None");
    if (!basis) throw new Error("moments provided but basis is None");
  }

  // For nonmag
  const seen_by_pos = new Map(); // keyStr -> true
  const pos_full = [];
  const species_full = [];

  // For mag
  const mom_full = [];
  const mom_classes = [];
  let mom_dirs = null;
  let ops_map = null;

  /** @type {Map<string, [any, any]>|null} */
  let seen_by_pos_mag = null;

  if (momentsIn != null) {
    let zero_spin;
    if (spin_basis === "cartesian" || spin_basis === "crystal") {
      zero_spin = [0, 0, 0];
    } else if (spin_basis === "collinear") {
      zero_spin = 0;
    } else {
      throw new Error("Unexpected spin_basis: " + String(spin_basis));
    }

    mom_dirs = [zero_spin]; // direction classes
    ops_map = Array.from({ length: ops.length }, () => ({}));
    seen_by_pos_mag = new Map(); // keyStr -> [moment, moment_class]

    /**
     * Mirrors get_snapped_magdir(...) nested in Python.
     *
     * @param {any} v
     * @param {number} mag_grid_dens
     * @param {string} spin_basis
     * @param {{tol?: number, int_mult_of_grid?: boolean}=} o
     * @returns {[any, number]}
     */
    const get_snapped_magdir = (v, mag_grid_dens, spin_basis, o = {}) => {
      const tol2 = o.tol !== undefined ? o.tol : 1e-8;
      const int_mult_of_grid = !!o.int_mult_of_grid;

      if (spin_basis === "collinear") {
        const vv = Number(v);
        if (Math.abs(vv) < tol2) return [0, 0];
        return [1, vv > 0 ? 1 : -1];
      }

      const vec = [Number(v[0]), Number(v[1]), Number(v[2])];
      const n = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);
      if (n < tol2) return [[0, 0, 0], 0];

      const magdir = [vec[0] / n, vec[1] / n, vec[2] / n];
      // Python trunc toward 0:
      const k = [
        Math.trunc(magdir[0] * mag_grid_dens),
        Math.trunc(magdir[1] * mag_grid_dens),
        Math.trunc(magdir[2] * mag_grid_dens),
      ];

      if (!(k[0] || k[1] || k[2])) return [[0, 0, 0], 0];

      const first_idx = k[0] !== 0 ? 0 : (k[1] !== 0 ? 1 : 2);
      let sig = k[first_idx] > 0 ? 1 : -1;
      if (sig < 0) {
        k[0] = -k[0]; k[1] = -k[1]; k[2] = -k[2];
      }

      if (int_mult_of_grid) return [/** @type {[number,number,number]} */ ([k[0], k[1], k[2]]), sig];

      return [[k[0] / mag_grid_dens, k[1] / mag_grid_dens, k[2] / mag_grid_dens], sig];
    };

    // attach helper to outer scope
    expand_asu._get_snapped_magdir = get_snapped_magdir;
  }

  for (let seed_idx = 0; seed_idx < posSeeds.length; seed_idx++) {
    const seed_pos = posSeeds[seed_idx];
    const specie = spSeeds[seed_idx];
    const f = [Number(seed_pos[0]), Number(seed_pos[1]), Number(seed_pos[2])];

    let m0 = null;
    let m0class = null;

    if (momentsIn != null) {
      m0 = momentsIn[seed_idx];
      const [m0dir, m0dir_sign] = expand_asu._get_snapped_magdir(m0, mag_grid_dens, spin_basis, {
        int_mult_of_grid: true,
      });

      const idx = _indexOfDir(mom_dirs, m0dir, spin_basis);
      if (idx === -1) mom_dirs.push(m0dir);
      const idx2 = _indexOfDir(mom_dirs, m0dir, spin_basis);
      m0class = idx2 * m0dir_sign;
    }

    for (let ops_idx = 0; ops_idx < ops.length; ops_idx++) {
      const op = ops[ops_idx];

      if (momentsIn == null) {
        // nonmag: op=(R,t)
        const [R, t] = op;
        const g = apply_op_frac(R, t, f);

        const k = pos_key(g, grid_dens, 1e-8);
        const kf = find_adjacent_key_wrap(k, seen_by_pos, grid_dens);
        if (kf != null && seen_by_pos.has(kf)) continue;

        seen_by_pos.set(_keyToStr(k), true);
        pos_full.push(g);
        species_full.push(specie);
        continue;
      }

      // mag: op=(R,t,time_flag)
      const [R, t, time_flag] = op;
      const g = apply_op_frac(R, t, f);
      let m = apply_op_moment_fn(R, time_flag, m0, basis, spin_basis);

      const k = pos_key(g, grid_dens, 1e-8);
      const kf = find_adjacent_key_wrap(k, seen_by_pos_mag, grid_dens);

      const [mdir, mdir_sign] = expand_asu._get_snapped_magdir(m, mag_grid_dens, spin_basis, {
        int_mult_of_grid: true,
      });

      if (_indexOfDir(mom_dirs, mdir, spin_basis) === -1) mom_dirs.push(mdir);
      const mclass = _indexOfDir(mom_dirs, mdir, spin_basis) * mdir_sign;

      // op spin mapping consistency (kept)
      if (!_isZeroDir(mdir, spin_basis) && m0class !== mclass) {
        const map = ops_map[ops_idx];
        if (Object.prototype.hasOwnProperty.call(map, m0class)) {
          if (map[m0class] !== mclass) {
            throw new Error(
              "Inconsistent op spin mapping: " +
                String(m0class) +
                "->" +
                String(map[m0class]) +
                " vs. " +
                String(mclass) +
                " for: " +
                String(op)
            );
          }
        } else {
          map[m0class] = mclass;
        }
      }

      if (kf != null && seen_by_pos_mag.has(kf)) {
        const [m_prev, m_prev_class] = seen_by_pos_mag.get(kf);
        if (!_allclose(m, m_prev, 1e-6) ) {
          if (spin_basis !== "collinear") {
            throw new Error(
              "Internally inconsistent positions and symmetry ops: " +
                String(op) +
                " transforms " +
                String(f) +
                ":" +
                String(m0) +
                " into " +
                String(g) +
                ":" +
                String(m) +
                " but site is: " +
                String(m_prev)
            );
          } else if (Math.abs(Math.abs(m) - Math.abs(m_prev)) < 1e-6) {
            m = m_prev;
            // keep previous class
             
            const _ = m_prev_class;
          } else {
            throw new Error(
              "Internally inconsistent positions and symmetry ops: " +
                String(op) +
                " transforms " +
                String(f) +
                ":" +
                String(m0) +
                " into " +
                String(g) +
                ":" +
                String(m) +
                " but site is: " +
                String(m_prev)
            );
          }
        }
        continue;
      }

      seen_by_pos_mag.set(_keyToStr(k), [m, mclass]);
      pos_full.push(g);
      species_full.push(specie);
      mom_full.push(spin_basis !== "collinear" ? [m[0], m[1], m[2]] : m);
      mom_classes.push(mclass);
    }
  }

  // Sort for reproducibility (z,y,x)
  const order = Array.from({ length: pos_full.length }, (_, i) => i).sort((i, j) => {
    const ai = pos_full[i], aj = pos_full[j];
    const keyi = [round6(ai[2]), round6(ai[1]), round6(ai[0])];
    const keyj = [round6(aj[2]), round6(aj[1]), round6(aj[0])];
    for (let k = 0; k < 3; k++) {
      if (keyi[k] < keyj[k]) return -1;
      if (keyi[k] > keyj[k]) return 1;
    }
    return 0;
  });

  const pos_sorted = order.map((i) => pos_full[i]);
  const sp_sorted = order.map((i) => species_full[i]);

  if (momentsIn == null) {
    return [pos_sorted, sp_sorted];
  }

  const mom_sorted = order.map((i) => mom_full[i]);
  const cls_sorted = order.map((i) => mom_classes[i]);
  const symops_classes = ops_map.map((m) =>
    Object.entries(m)
      .map(([k, v]) => [Number(k), v])
      .sort((a, b) => a[0] - b[0])
  );

  return [pos_sorted, sp_sorted, mom_sorted, cls_sorted, symops_classes];
}

/** @param {number} x */
function round6(x) {
  return Math.round(Number(x) * 1e6) / 1e6;
}

/** @param {any} a @param {any} b @param {string} spin_basis */
function _dirEq(a, b, spin_basis) {
  if (spin_basis === "collinear") return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** @param {any[]} mom_dirs @param {any} dir @param {string} spin_basis */
function _indexOfDir(mom_dirs, dir, spin_basis) {
  for (let i = 0; i < mom_dirs.length; i++) {
    if (_dirEq(mom_dirs[i], dir, spin_basis)) return i;
  }
  return -1;
}

/** @param {any} dir @param {string} spin_basis */
function _isZeroDir(dir, spin_basis) {
  if (spin_basis === "collinear") return dir === 0;
  return dir[0] === 0 && dir[1] === 0 && dir[2] === 0;
}

/** @param {any} a @param {any} b @param {number} atol */
function _allclose(a, b, atol) {
  // rtol=0
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= atol;
  }
  // vectors
  return (
    Math.abs(Number(a[0]) - Number(b[0])) <= atol &&
    Math.abs(Number(a[1]) - Number(b[1])) <= atol &&
    Math.abs(Number(a[2]) - Number(b[2])) <= atol
  );
}

// ---------- Magnetic moment transforms ----------

/** @param {any[][]} R */
function _det_int3(R) {
  const a = Number(R[0][0]), b = Number(R[0][1]), c = Number(R[0][2]);
  const d = Number(R[1][0]), e = Number(R[1][1]), f = Number(R[1][2]);
  const g = Number(R[2][0]), h = Number(R[2][1]), i = Number(R[2][2]);
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  // should be ±1
  return Math.round(det);
}

/**
 * Magnetic moment is an axial vector: m' = time * det(R) * R * m
 * Mirrors _apply_op_moment_crystal.
 *
 * @param {any[][]} R
 * @param {number} time_flag
 * @param {number[]} m
 * @returns {number[]}
 */
function _apply_op_moment_crystal(R, time_flag, m) {
  const detR = _det_int3(R); // ±1
  const s = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    s[i] = Number(R[i][0]) * m[0] + Number(R[i][1]) * m[1] + Number(R[i][2]) * m[2];
  }
  const factor = (time_flag !== 0 ? Number(time_flag) : 1.0) * detR;
  return [factor * s[0], factor * s[1], factor * s[2]];
}

/**
 * R: 3x3 int rotation in fractional basis
 * time_reversal: 0 or 1 (spglib convention)
 * m: 3-vector spin (Cartesian)
 * lattice: 3x3 lattice with row vectors [a;b;c] in Cartesian
 *
 * Mirrors _apply_op_moment_cartesian.
 *
 * @param {any[][]} R
 * @param {number} time_reversal
 * @param {number[]} m
 * @param {number[][]} lattice
 * @returns {number[]}
 */
function _apply_op_moment_cartesian(R, time_reversal, m, lattice) {
  // Build A with lattice vectors as columns: A = lattice^T
  const A = [
    [Number(lattice[0][0]), Number(lattice[1][0]), Number(lattice[2][0])],
    [Number(lattice[0][1]), Number(lattice[1][1]), Number(lattice[2][1])],
    [Number(lattice[0][2]), Number(lattice[1][2]), Number(lattice[2][2])],
  ];

  const Ainv = _inv3(A);
  const Rnum = _toNumMat3(R);
  const R_cart = _matMul3(_matMul3(A, Rnum), Ainv);

  const detR = _det_int3(Rnum); // ±1
  const s0 = _matVec3(_scaleMat3(R_cart, detR), m);

  // Spglib time reversal: 1 flips spin
  let s = s0;
  if (time_reversal === 1) {
    s = [-s0[0], -s0[1], -s0[2]];
  } else if (time_reversal !== 0) {
    throw new Error("Inconsitency error: unexpected time reversal flag:" + String(time_reversal));
  }

  // clean tiny noise
  for (let i = 0; i < 3; i++) {
    if (Math.abs(s[i]) <= 1e-12) s[i] = 0.0;
  }
  return s;
}

/**
 * Simplified collinear scalar transform.
 * Mirrors _apply_op_moment_collinear.
 *
 * @param {any[][]} R
 * @param {number} time_reversal
 * @param {number} m0
 * @returns {number}
 */
function _apply_op_moment_collinear(R, time_reversal, m0) {
  if (!(time_reversal === 0 || time_reversal === 1)) {
    throw new Error(`Unexpected time_reversal flag: ${JSON.stringify(time_reversal)}`);
  }
  const detR = _det_int3(R);
  const flips = (time_reversal + (detR === -1 ? 1 : 0)) % 2;
  return flips ? -m0 : m0;
}

/**
 * Public dispatcher. Mirrors apply_op_moment.
 *
 * @param {any[][]} R
 * @param {number} time_flag
 * @param {any} m
 * @param {number[][]} lattice
 * @param {string} spin_basis
 * @returns {any}
 */
export function apply_op_moment(R, time_flag, m, lattice, spin_basis) {
  if (spin_basis === "collinear") return _apply_op_moment_collinear(R, time_flag, m);
  if (spin_basis === "cartesian") return _apply_op_moment_cartesian(R, time_flag, m, lattice);
  if (spin_basis === "crystal") return _apply_op_moment_crystal(R, time_flag, m);
  throw new Error("Unrecognized spin_basis: " + String(spin_basis));
}

/**
 * Numbering that separates non-equivalent atoms (labels).
 * Mirrors mag_asu_data_to_numbers.
 *
 * @param {any} mag_asu_data
 */
export function mag_asu_data_to_numbers(mag_asu_data) {
  const label_to_id = new Map();
  const numbers_to_species = {};
  const numbers = [];
  let next_id = 1;

  for (let i = 0; i < mag_asu_data.symbols.length; i++) {
    const sym = mag_asu_data.symbols[i];
    const lab = mag_asu_data.labels[i];
    if (!label_to_id.has(lab)) {
      label_to_id.set(lab, next_id);
      numbers_to_species[next_id] = sym;
      next_id += 1;
    }
    numbers.push(label_to_id.get(lab));
  }
  return [numbers, numbers_to_species];
}

// ---------- CIF convenience ----------

/**
 * Read a CIF stream, expand the asymmetric unit, and return the result.
 * Mirrors cif_to_struct.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{separate_noneq_atoms?: boolean, tol?: number}=} opts
 */
export async function cif_to_struct(stream, opts = {}) {
  const separate_noneq_atoms = !!opts.separate_noneq_atoms;
  const tol = opts.tol !== undefined ? opts.tol : 1e-6;

  const asu_data = await single_asu_from_cif_file(stream);

  const res = asu_data.resolution;
  const grid_dens = (res != null && res !== 0.0) ? Math.trunc(1.0 / res) : 16384;

  const [positions_full, species_full] = expand_asu(
    asu_data.positions,
    separate_noneq_atoms ? asu_data.labels : asu_data.symbols,
    asu_data.symops,
    { grid_dens, tol }
  );

  let numbers_full, numbers_to_species, species_meta;

  if (separate_noneq_atoms) {
    // each label is its own "species number", but map back to element symbol
    const [_asu_numbers, nts] = asu_data_to_numbers_by_labels(asu_data);
    numbers_to_species = nts;

    const uniqLabels = Array.from(new Set(asu_data.labels)).sort();
    const label_to_id = new Map(uniqLabels.map((lab, i) => [lab, i + 1]));
    numbers_full = species_full.map((lab) => label_to_id.get(lab));
    species_meta = numbers_full.map((i) => numbers_to_species[i]);
  } else {
    const [nums, nts] = species_to_numbers(species_full);
    numbers_full = nums;
    numbers_to_species = nts;
    species_meta = species_full;
  }

  asu_data.species = species_meta;
  asu_data.numbers_to_species = numbers_to_species;
  asu_data.grid_dens = grid_dens;

  asu_data.positions_full = positions_full;
  asu_data.numbers_full = numbers_full;
  asu_data.species_full = species_full;

  return asu_data;
}

/**
 * Read an mCIF stream, expand the asymmetric unit, and return the result.
 * Mirrors mcif_to_magstruct.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{
 *   separate_noneq_atoms?: boolean,
 *   error_on_nonmag?: boolean,
 *   tol?: number,
 *   mag_grid_dens?: number
 * }=} opts
 */
export async function mcif_to_magstruct(stream, opts = {}) {
  const separate_noneq_atoms = !!opts.separate_noneq_atoms;
  const error_on_nonmag = opts.error_on_nonmag !== undefined ? !!opts.error_on_nonmag : true;
  const tol = opts.tol !== undefined ? opts.tol : 1e-6;
  const mag_grid_dens = opts.mag_grid_dens !== undefined ? opts.mag_grid_dens : 16384;

  const mag_asu_data = await single_mag_asu_from_mcif_file(stream, { error_on_nonmag });

  const res = mag_asu_data.resolution;
  const grid_dens = (res != null && res !== 0.0) ? Math.trunc(1.0 / res) : 16384;

  let positions_full, numbers_full, moments_full, momclasses, symops_classes, species_full, numbers_to_species;

  if (separate_noneq_atoms) {
    const [asu_numbers, nts] = mag_asu_data_to_numbers(mag_asu_data);
    numbers_to_species = nts;

    const out = expand_asu(
      mag_asu_data.positions,
      asu_numbers,
      mag_asu_data.symops,
      {
        grid_dens,
        mag_grid_dens,
        tol,
        moments: mag_asu_data.magmoms,
        apply_op_moment_fn: apply_op_moment,
        spin_basis: mag_asu_data.spin_basis,
        basis: mag_asu_data.basis,
      }
    );

    [positions_full, numbers_full, moments_full, momclasses, symops_classes] = out;
    species_full = numbers_full.map((i) => numbers_to_species[i]);
  } else {
    const out = expand_asu(
      mag_asu_data.positions,
      mag_asu_data.symbols,
      mag_asu_data.symops,
      {
        grid_dens,
        mag_grid_dens,
        tol,
        moments: mag_asu_data.magmoms,
        apply_op_moment_fn: apply_op_moment,
        spin_basis: mag_asu_data.spin_basis,
        basis: mag_asu_data.basis,
      }
    );

    [positions_full, species_full, moments_full, momclasses, symops_classes] = out;
    const [nums, nts] = species_to_numbers(species_full);
    numbers_full = nums;
    numbers_to_species = nts;
  }

  mag_asu_data.species = species_full;
  mag_asu_data.numbers_to_species = numbers_to_species;
  mag_asu_data.grid_dens = grid_dens;
  mag_asu_data.momclasses = momclasses;
  mag_asu_data.symops_classes = symops_classes;
  mag_asu_data.mag_grid_dens = mag_grid_dens;

  mag_asu_data.positions_full = positions_full;
  mag_asu_data.numbers_full = numbers_full;
  mag_asu_data.moments_full = moments_full;
  mag_asu_data.species_full = species_full;

  return mag_asu_data;
}

// ---------------- 3x3 linear algebra ----------------

/** @param {any[][]} M */
function _toNumMat3(M) {
  return [
    [Number(M[0][0]), Number(M[0][1]), Number(M[0][2])],
    [Number(M[1][0]), Number(M[1][1]), Number(M[1][2])],
    [Number(M[2][0]), Number(M[2][1]), Number(M[2][2])],
  ];
}

/** @param {number[][]} A @param {number[][]} B */
function _matMul3(A, B) {
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return C;
}

/** @param {number[][]} A @param {number} s */
function _scaleMat3(A, s) {
  return [
    [A[0][0] * s, A[0][1] * s, A[0][2] * s],
    [A[1][0] * s, A[1][1] * s, A[1][2] * s],
    [A[2][0] * s, A[2][1] * s, A[2][2] * s],
  ];
}

/** @param {number[][]} A @param {number[]} v */
function _matVec3(A, v) {
  return [
    A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
    A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
    A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
  ];
}

/** @param {number[][]} A */
function _inv3(A) {
  const a = A[0][0], b = A[0][1], c = A[0][2];
  const d = A[1][0], e = A[1][1], f = A[1][2];
  const g = A[2][0], h = A[2][1], i = A[2][2];

  const A11 = e * i - f * h;
  const A12 = -(d * i - f * g);
  const A13 = d * h - e * g;

  const A21 = -(b * i - c * h);
  const A22 = a * i - c * g;
  const A23 = -(a * h - b * g);

  const A31 = b * f - c * e;
  const A32 = -(a * f - c * d);
  const A33 = a * e - b * d;

  const det = a * A11 + b * A12 + c * A13;
  if (Math.abs(det) < 1e-18) throw new Error("Singular matrix in _inv3");

  const invDet = 1.0 / det;

  // adj(A)^T / det
  return [
    [A11 * invDet, A21 * invDet, A31 * invDet],
    [A12 * invDet, A22 * invDet, A32 * invDet],
    [A13 * invDet, A23 * invDet, A33 * invDet],
  ];
}


