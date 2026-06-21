import { read_cif } from "./cif_reader.js";
import {
  Fraction,
  parse_asu_cell,
  parse_cif_float,
  parse_structural_modulation,
  parse_linear_expr,
} from "./cif_parser.js";

/**
 * op: e.g. 'x-y,x,-z+1/2,-1'
 * Returns [R, t, time] where:
 *  - R is 3x3 (list of rows), t is length-3, time is +1/-1 (mcif) or 0/1 (spglib mapping)
 *
 * Mirrors _parse_xyzt_op.
 *
 * @param {string} op
 * @param {boolean} use_fractions
 * @param {"mcif"|"spglib"} time_reversal_convention
 * @returns {[any[], any[], number]}
 */
export function _parse_xyzt_op(op, use_fractions = false, time_reversal_convention = "mcif") {
  const parts = String(op).split(",").map((p) => p.trim());
  if (parts.length !== 4) {
    throw new Error(`Unexpected op format: ${op}`);
  }
  const [px, py, pz, tsRaw] = parts;

  const [rx, tx] = parse_linear_expr(px, use_fractions);
  const [ry, ty] = parse_linear_expr(py, use_fractions);
  const [rz, tz] = parse_linear_expr(pz, use_fractions);

  let ts;
  if (time_reversal_convention === "mcif") {
    ts = parseInt(tsRaw, 10);
  } else if (time_reversal_convention === "spglib") {
    // Python: int((1-int(ts))/2)
    ts = Math.trunc((1 - parseInt(tsRaw, 10)) / 2);
  } else {
    throw new Error("Unrecognized time reversal convention.");
  }

  return [[rx, ry, rz], [tx, ty, tz], ts];
}

/**
 * Mirrors xyzt_symops_to_matrix.
 * @param {string[]} symops_xyzt
 * @param {boolean} use_fractions
 * @param {"mcif"|"spglib"} time_reversal_convention
 * @returns {Array<[any[], any[], number]>}
 */
export function xyzt_symops_to_matrix(symops_xyzt, use_fractions = false, time_reversal_convention = "mcif") {
  return symops_xyzt.map((s) => _parse_xyzt_op(s, use_fractions, time_reversal_convention));
}

/**
 * Compose symmetry ops with centering ops.
 * Mirrors _compose_ops_with_centerings.
 *
 * ops: list of [R, t, time_flag]
 * centerings: list of [Rc, c, time_c]
 *
 * Returns new list [R, t', time'] where:
 *  t' = t + c
 *  time' = (time_flag + time_c) % 2   (spglib convention)
 *
 * @param {Array<[any[], any[], number]>} ops
 * @param {Array<[any[], any[], number]>} centerings
 * @returns {Array<[any[], any[], number]>}
 */
export function _compose_ops_with_centerings(ops, centerings) {
  const composed = [];
  const I = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (const [R, t, time_flag] of ops) {
    for (const [Rc, c, time_c] of centerings) {
      if (!_matEq(Rc, I)) {
        throw new Error("Centering symop that includes rotation is invalid");
      }
      const t_new = [t[0].add ? t[0].add(c[0]) : t[0] + c[0],
                     t[1].add ? t[1].add(c[1]) : t[1] + c[1],
                     t[2].add ? t[2].add(c[2]) : t[2] + c[2]];
      const time_new = ((time_flag + time_c) % 2 + 2) % 2;
      composed.push([R, t_new, time_new]);
    }
  }
  return /** @type {any} */ (composed);
}

/** @param {any} A @param {any} B */
function _matEq(A, B) {
  // Only used to validate identity in centerings. Handles numbers and Fractions.
  if (!Array.isArray(A) || !Array.isArray(B) || A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    if (!Array.isArray(A[i]) || !Array.isArray(B[i]) || A[i].length !== B[i].length) return false;
    for (let j = 0; j < A[i].length; j++) {
      if (!_valEq(A[i][j], B[i][j])) return false;
    }
  }
  return true;
}

/** @param {any} a @param {any} b */
function _valEq(a, b) {
  if (a instanceof Fraction && b instanceof Fraction) return a.n === b.n && a.d === b.d;
  if (a instanceof Fraction) return a.d === 1n && Number(a.n) === b;
  if (b instanceof Fraction) return b.d === 1n && Number(b.n) === a;
  return a === b;
}

/**
 * Extract magnetic moments from a mcif block.
 * Mirrors _parse_moments.
 *
 * If resolution=false: returns [moments, labels, spin_basis]
 * If resolution=true : returns [moments, labels, spin_basis, grid_dens]
 *
 * @param {Map<string, any>} block
 * @param {{k_sigma?: number, equalize?: boolean, resolution?: boolean}=} opts
 * @returns {any}
 */
export function _parse_moments(block, opts = {}) {
  const k_sigma = opts.k_sigma !== undefined ? opts.k_sigma : 2.0;
  const equalize = opts.equalize !== undefined ? !!opts.equalize : true;
  const resolution = opts.resolution !== undefined ? !!opts.resolution : true;

  const _get = (name) => {
    const v = block.get(name);
    return v == null ? [] : Array.from(v);
  };

  const _len_ok = (xs, ys, zs, n) => xs.length === ys.length && ys.length === zs.length && n > 0 && xs.length === n;

  const labels = _get("atom_site_moment.label");
  const n = labels.length;

  if (n === 0) {
    if (resolution) return [[], [], "crystal", null];
    return [[], [], "crystal"];
  }

  // Try crystal basis first
  let xs = _get("atom_site_moment.crystalaxis_x");
  let ys = _get("atom_site_moment.crystalaxis_y");
  let zs = _get("atom_site_moment.crystalaxis_z");
  let spin_basis = "crystal";

  if (!_len_ok(xs, ys, zs, n)) {
    xs = _get("atom_site_moment.Cartn_x");
    ys = _get("atom_site_moment.Cartn_y");
    zs = _get("atom_site_moment.Cartn_z");
    spin_basis = "cartesian";
    if (!_len_ok(xs, ys, zs, n)) {
      return resolution ? [null, null, null, null] : null;
    }
  }

  // Labels must be unique
  if (n !== new Set(labels).size) {
    throw new Error("Non-equivalent sites share the same moment label in CIF data.");
  }

  // Read optional equalization metadata only if needed
  const forms = equalize ? _get("atom_site_moment.symmform") : [];
  const mags = equalize ? _get("atom_site_moment.magnitude") : [];

  const moments = [];
  const component_resolutions = [];

  for (let i = 0; i < n; i++) {
    let mx, my, mz;

    if (resolution) {
      const [mxv, mx_meta] = parse_cif_float(xs[i], { meta: true });
      const [myv, my_meta] = parse_cif_float(ys[i], { meta: true });
      const [mzv, mz_meta] = parse_cif_float(zs[i], { meta: true });
      mx = mxv; my = myv; mz = mzv;

      component_resolutions.push(mx_meta.resolution, my_meta.resolution, mz_meta.resolution);
    } else {
      mx = parse_cif_float(xs[i], { meta: false });
      my = parse_cif_float(ys[i], { meta: false });
      mz = parse_cif_float(zs[i], { meta: false });
    }

    // Equalization
    if (equalize && i < forms.length) {
      const form = forms[i] ? String(forms[i]).replaceAll(" ", "").toLowerCase() : null;

      let m_esd = null;
      if (i < mags.length && mags[i] != null && !["?", ".", ""].includes(String(mags[i]).trim())) {
        const [, m_meta] = parse_cif_float(mags[i], { meta: true });
        m_esd = (m_meta && m_meta.esd != null) ? m_meta.esd : null;
      }

      if (
        (form === "mx,mx,mx" || form === "my,my,my" || form === "mz,mz,mz") &&
        m_esd != null && m_esd > 0.0
      ) {
        const sigma_comp = m_esd / Math.sqrt(3.0);
        const mean_comp = (mx + my + mz) / 3.0;
        const maxdev = Math.max(Math.abs(mx - mean_comp), Math.abs(my - mean_comp), Math.abs(mz - mean_comp));
        if (maxdev <= k_sigma * sigma_comp) {
          mx = mean_comp; my = mean_comp; mz = mean_comp;
        }
      }
    }

    moments.push([mx, my, mz]);
  }

  // Fast path: no grid resolution requested
  if (!resolution) {
    return [moments, labels, spin_basis];
  }

  // 1) Data resolution = largest implied resolution from written precision
  const data_resolution = component_resolutions.length ? Math.max(...component_resolutions) : 0.0;

  // 2) Separation resolution (non-periodic for moments)
  let separation_resolution;
  if (n > 1) {
    const diffs = [];
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const [mx1, my1, mz1] = moments[a];
        const [mx2, my2, mz2] = moments[b];
        for (const d of [Math.abs(mx1 - mx2), Math.abs(my1 - my2), Math.abs(mz1 - mz2)]) {
          if (d > data_resolution) diffs.push(d);
        }
      }
    }
    separation_resolution = diffs.length ? (Math.min(...diffs) / 2.0) : Infinity;
  } else {
    separation_resolution = Infinity;
  }

  let mag_res;
  if (separation_resolution === Infinity) {
    mag_res = data_resolution;
  } else if (data_resolution === 0.0) {
    mag_res = separation_resolution;
  } else {
    mag_res = Math.min(data_resolution, separation_resolution);
  }

  return [moments, labels, spin_basis, mag_res];
}

/**
 * Parse a single algebraic coordinate expression from a superspace op.
 * Mirrors _parse_linear_expr_algebraic.
 *
 * @param {string} expr
 * @param {{allowed_vars?: string[], use_fractions?: boolean}=} opts
 * @returns {[number[], any]}
 */
export function _parse_linear_expr_algebraic(expr, opts = {}) {
  const allowed_vars = opts.allowed_vars ?? ["x1", "x2", "x3"];
  const use_fractions = !!opts.use_fractions;

  let s = String(expr).replaceAll(" ", "");
  if (!s) throw new Error("Empty expression");
  if (s[0] !== "+" && s[0] !== "-") s = "+" + s;

  // token_re in Python (note: used with finditer)
  const tokenRe = /([+-])(?:(?:(?:(\d+(?:\/\d+)?|\d*\.\d+)?)(x\d+))|((?:\d+\/\d+)|(?:\d+(?:\.\d+)?)))/g;

  /** @type {Record<string, number>} */
  const coeffs = {};
  for (const v of allowed_vars) coeffs[v] = 0;

  /** @type {any} */
  let constTerm = use_fractions ? new Fraction(0) : 0.0;

  let pos = 0;
  for (const m of s.matchAll(tokenRe)) {
    const start = /** @type {any} */ (m).index ?? 0;
    if (start !== pos) {
      throw new Error(`Unparsed tail in '${expr}' near '${s.slice(pos)}'`);
    }
    pos = start + m[0].length;

    const sign = m[1];
    const coef_str = m[2];
    const v = m[3];
    const num = m[4];
    const sgn = sign === "+" ? 1 : -1;

    if (v != null) {
      if (!allowed_vars.includes(v)) {
        throw new Error(`Expression '${expr}' references ${v}, not in allowed ${JSON.stringify(allowed_vars)}.`);
      }

      let coef_val;
      if (coef_str == null || coef_str === "") {
        coef_val = 1;
      } else {
        // Coefficients on variables must be integers
        const f = (coef_str.includes("/") || coef_str.includes("."))
          ? new Fraction(coef_str)
          : new Fraction(BigInt(parseInt(coef_str, 10)), 1n);

        if (f.d !== 1n) {
          throw new Error(`Non-integer coefficient ${coef_str} on ${v} in '${expr}'`);
        }
        coef_val = Number(f.n);
      }
      coeffs[v] += sgn * coef_val;
    } else {
      if (use_fractions) {
        const val = (num.includes("/") || num.includes(".")) ? new Fraction(num) : new Fraction(BigInt(parseInt(num, 10)), 1n);
        constTerm = sgn === 1 ? constTerm.add(val) : constTerm.sub(val);
      } else {
        const val = num.includes("/") ? new Fraction(num).toNumber() : Number(num);
        constTerm += sgn * val;
      }
    }
  }

  if (pos !== s.length) {
    throw new Error(`Unparsed tail in '${expr}' near '${s.slice(pos)}'`);
  }

  const row = allowed_vars.map((v) => Number(coeffs[v]));
  const const_out = use_fractions ? constTerm : Number(constTerm);
  return [row, const_out];
}

/**
 * Parse an msCIF `_space_group_symop_magn_ssg_operation.algebraic` op.
 * Mirrors parse_alg_op.
 *
 * Returns [R, t, time]
 *
 * @param {string} op
 * @param {boolean} use_fractions
 * @param {"mcif"|"spglib"} time_reversal_convention
 * @returns {[any[], any[], number]}
 */
export function parse_alg_op(op, use_fractions = false, time_reversal_convention = "mcif") {
  const parts = String(op).split(",").map((p) => p.trim());
  if (parts.length < 4) {
    throw new Error(`Unexpected op format (need at least 3 coords + time): ${op}`);
  }

  const ts_str = parts[parts.length - 1];
  const coord_parts = parts.slice(0, -1);

  if (coord_parts.length < 3) {
    throw new Error(`Need at least 3 coordinate expressions before time flag: ${op}`);
  }

  const [px, py, pz] = [coord_parts[0], coord_parts[1], coord_parts[2]];

  const allowed = ["x1", "x2", "x3"];
  const [rx, tx] = _parse_linear_expr_algebraic(px, { allowed_vars: allowed, use_fractions });
  const [ry, ty] = _parse_linear_expr_algebraic(py, { allowed_vars: allowed, use_fractions });
  const [rz, tz] = _parse_linear_expr_algebraic(pz, { allowed_vars: allowed, use_fractions });

  // time reversal
  const ts_val = parseInt(ts_str, 10);
  if (!(ts_val === -1 || ts_val === 1)) {
    throw new Error(`Invalid time-reversal flag at end of operation: '${ts_str}' in ${op}`);
  }

  let time;
  if (time_reversal_convention === "mcif") {
    time = ts_val;
  } else if (time_reversal_convention === "spglib") {
    // Map +1 -> 0, -1 -> 1
    time = Math.trunc((1 - ts_val) / 2);
  } else {
    throw new Error("Unrecognized time reversal convention. Use 'mcif' or 'spglib'.");
  }

  const t = use_fractions ? [tx, ty, tz] : [Number(tx), Number(ty), Number(tz)];
  const R = [rx, ry, rz];
  return [R, t, time];
}

/**
 * Mirrors alg_symops_to_matrix.
 * @param {string[]} symops_alg
 * @param {boolean} use_fractions
 * @param {"mcif"|"spglib"} time_reversal_convention
 */
export function alg_symops_to_matrix(symops_alg, use_fractions = false, time_reversal_convention = "mcif") {
  return symops_alg.map((s) => parse_alg_op(s, use_fractions, time_reversal_convention));
}

/**
 * moments_cryst : list of N vectors [mx,my,mz] in crystal coordinates
 * basis         : 3x3 list with rows a,b,c in Cartesian
 * returns       : list of N vectors in Cartesian coordinates
 *
 * Mirrors crystal_to_cartesian.
 *
 * @param {Array<[number, number, number]>} moments_cryst
 * @param {number[][]} basis
 * @returns {Array<[number, number, number]>}
 */
export function crystal_to_cartesian(moments_cryst, basis) {
  const normalize = (v) => {
    const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
  };

  const a = basis[0];
  const b = basis[1];
  const c = basis[2];

  const ah = normalize(a);
  const bh = normalize(b);
  const ch = normalize(c);

  const result = [];
  for (const m of moments_cryst) {
    const [mx, my, mz] = m;

    const x = mx * ah[0] + my * bh[0] + mz * ch[0];
    const y = mx * ah[1] + my * bh[1] + mz * ch[1];
    const z = mx * ah[2] + my * bh[2] + mz * ch[2];

    result.push([x, y, z]);
  }
  return /** @type {any} */ (result);
}

/**
 * Parse magnetic ASU cell.
 * Mirrors _parse_mag_asu_cell.
 *
 * @param {Map<string, any>} cifblock
 * @param {{moment_equalization?: boolean}=} opts
 */
export function _parse_mag_asu_cell(cifblock, opts = {}) {
  const moment_equalization = opts.moment_equalization !== undefined ? !!opts.moment_equalization : true;

  const [basis, positions, res, symbols, labels, equivalent_atoms] = parse_asu_cell(cifblock);

  const [cif_moments0, momlabels, spin_basis0, magres] = _parse_moments(cifblock, {
    equalize: moment_equalization,
    resolution: true,
  });

  // If moments could not be extracted, default to zero moments (matches downstream expectations).
  // This avoids crashing on momlabels.length and allows caller to enforce error_on_nonmag if desired.
  if (cif_moments0 == null || momlabels == null || spin_basis0 == null) {
    const zero = [0.0, 0.0, 0.0];
    const magmoms = labels.map(() => zero.slice());
    return [basis, positions, res, magmoms, "cartesian", null, symbols, labels, equivalent_atoms];
  }

  let cif_moments = cif_moments0;
  let spin_basis = spin_basis0;

  if (spin_basis === "crystal") {
    cif_moments = crystal_to_cartesian(cif_moments, basis);
    spin_basis = "cartesian";
  }

  const moments_map = new Map();
  for (let i = 0; i < momlabels.length; i++) {
    const label = momlabels[i];
    const mom = cif_moments[i];
    moments_map.set(label, [mom[0], mom[1], mom[2]]);
  }

  const magmoms = labels.map((lab) => (moments_map.has(lab) ? moments_map.get(lab) : [0.0, 0.0, 0.0]));

  return [basis, positions, res, magmoms, spin_basis, magres, symbols, labels, equivalent_atoms];
}

/**
 * Mirrors _get_magnetic_fourier_info.
 * @param {Map<string, any>} cifblock
 * @returns {[boolean, string[]]}
 */
export function _get_magnetic_fourier_info(cifblock) {
  let has = false;
  const atoms = new Set();

  const labels = cifblock.get("_atom_site_moment_Fourier.atom_site_label");
  if (labels) {
    has = true;
    for (const l of labels) atoms.add(l);
  }

  return [has, Array.from(atoms).sort()];
}

/**
 * Returns:
 *   basis: Array<[kx,ky,kz]>  or null if not present.
 *
 * Python uses cif_to_float(v); here we use parse_cif_float(v, {meta:false})
 * because it correctly supports fractions like '1/3'.
 *
 * @param {Map<string, any>} cifblock
 * @returns {Array<[number, number, number]> | null}
 */
export function extract_parent_q_basis(cifblock) {
  const k_vectors = cifblock.get("parent_propagation_vector.kxkykz");
  if (!k_vectors) return null;

  const basis = [];
  for (const row of k_vectors) {
    const r = Array.from(row);
    basis.push([
      parse_cif_float(r[0], { meta: false }),
      parse_cif_float(r[1], { meta: false }),
      parse_cif_float(r[2], { meta: false }),
    ]);
  }
  return /** @type {any} */ (basis);
}

/**
 * Returns:
 *   coeff_rows: Array<Array<number|Fraction|string>>   (each is [c1, c2, ..., cm])
 *   m:          number of q-vectors detected (>=0)
 *
 * Mirrors extract_fourier_coeffs.
 *
 * @param {Map<string, any>} cifblock
 * @param {number} max_q_guess
 * @returns {[Array<any[]>, number]}
 */
export function extract_fourier_coeffs(cifblock, max_q_guess = 12) {
  // discover which q*_coeff columns exist
  const present_cols = [];
  for (let i = 1; i <= max_q_guess; i++) {
    const key = `atom_site_Fourier_wave_vector.q${i}_coeff`;
    const col = cifblock.get(key);
    if (col != null) {
      present_cols.push([i, key, col]);
    }
  }

  if (present_cols.length === 0) return [[], 0];

  // permissive: pad shorter cols with zeros
  const max_len = Math.max(...present_cols.map(([, , col]) => col.length));
  const m = Math.max(...present_cols.map(([i]) => i));

  // dense columns array size m (1..m)
  /** @type {Array<any[] | null>} */
  const columns = Array.from({ length: m }, () => null);

  const norm = (x) => {
    // msCIF usually stores integer coeffs; permit '1', '-1', '0', '2/3', '0.5'
    const s = String(x).trim();
    if (s.includes("/")) {
      return new Fraction(s);
    }
    try {
      // prefer integers if possible
      if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
      const f = Number(s);
      if (Number.isFinite(f)) return f;
      return s;
    } catch {
      return s;
    }
  };

  for (const [i, _key, col] of present_cols) {
    let col_norm = Array.from(col).map(norm);
    if (col_norm.length < max_len) {
      col_norm = col_norm.concat(Array.from({ length: max_len - col_norm.length }, () => 0));
    }
    columns[i - 1] = col_norm;
  }

  // missing columns -> zeros
  for (let idx = 0; idx < m; idx++) {
    if (columns[idx] == null) {
      columns[idx] = Array.from({ length: max_len }, () => 0);
    }
  }

  // transpose columns -> rows
  /** @type {any[][]} */
  const rows = [];
  for (let r = 0; r < max_len; r++) {
    const row = [];
    for (let c = 0; c < m; c++) row.push(columns[c][r]);
    rows.push(row);
  }

  // deduplicate coefficient rows
  const coeff_rows = [];
  const seen = new Set();

  const keyOf = (v) => {
    if (v instanceof Fraction) return `F:${v.n.toString()}/${v.d.toString()}`;
    // distinguish numbers/strings a bit to avoid collisions
    return `${typeof v}:${String(v)}`;
  };

  for (const r of rows) {
    const key = r.map(keyOf).join("|");
    if (!seen.has(key)) {
      seen.add(key);
      coeff_rows.push(r.slice());
    }
  }

  return [coeff_rows, m];
}

/**
 * Returns:
 *   fourier: [basis, coeff_rows]  or null if insufficient data.
 *
 * Mirrors extract_fourier.
 *
 * @param {Map<string, any>} cifblock
 * @returns {[Array<[number, number, number]>, Array<any[]>] | null}
 */
export function extract_fourier(cifblock) {
  let basis = extract_parent_q_basis(cifblock);
  const [coeff_rows, m] = extract_fourier_coeffs(cifblock);

  if (!basis || coeff_rows.length === 0) return null;

  if (basis.length < m) {
    basis = basis.concat(Array.from({ length: m - basis.length }, () => [0.0, 0.0, 0.0]));
  } else if (basis.length > m) {
    basis = basis.slice(0, m);
  }

  return [basis, coeff_rows];
}

/** @param {any} x @returns {Fraction} */
function _to_fraction(x) {
  if (x instanceof Fraction) return x;

  // Normalize strings like '+1', '-1', ' 2/3 ', '0.5'
  if (typeof x === "string") {
    const s = x.trim();
    if (s === "") return new Fraction(0);
    // Fraction constructor already supports integer, decimal, and a/b
    return new Fraction(s);
  }

  // Integers/floats
  if (typeof x === "number") {
    // Preserve integers exactly
    if (Number.isInteger(x)) return new Fraction(BigInt(x), 1n);
    // For non-integers, use decimal-string conversion (Fraction does that)
    return new Fraction(String(x));
  }

  // Bigints
  if (typeof x === "bigint") return new Fraction(x, 1n);

  // Default: stringify (matches Python "accept rationals/strings" permissiveness)
  return new Fraction(String(x).trim());
}

/**
 * Sum of scaled vectors in Fraction space.
 * scale_vecs: Array<[Fraction coeff, [kx,ky,kz] q]>
 * returns [Fraction, Fraction, Fraction]
 *
 * @param {Array<[Fraction, any]>} scale_vecs
 * @returns {[Fraction, Fraction, Fraction]}
 */
function _vector_sum(scale_vecs) {
  let sx = new Fraction(0);
  let sy = new Fraction(0);
  let sz = new Fraction(0);

  for (const [c, q] of scale_vecs) {
    const qx = _to_fraction(q[0]);
    const qy = _to_fraction(q[1]);
    const qz = _to_fraction(q[2]);

    sx = sx.add(c.mul(qx));
    sy = sy.add(c.mul(qy));
    sz = sz.add(c.mul(qz));
  }
  return [sx, sy, sz];
}

/**
 * Normalize various 'Fourier_wave_vector' shapes into a list of 3-tuples of Fractions.
 *
 * Accepted shapes:
 * 1) Dict with explicit basis + list of coefficient vectors:
 *    { basis: [...], coeffs: [...] }
 * 2) List of per-wave dicts, each with q*_coeff and a shared basis:
 *    [ {q1_coeff:..., basis:[...]}, ...]
 * 3) Tuple (basis, coeffs)
 *
 * @param {any} fourier
 * @returns {Array<[Fraction, Fraction, Fraction]>}
 */
export function _collect_k_from_fourier(fourier) {
  if (fourier == null) return [];

  let basis;
  /** @type {any[]} */
  let coeff_list;

  // (3) Tuple (basis, coeffs) — in JS, represent as 2-element array
  if (
    Array.isArray(fourier) &&
    fourier.length === 2 &&
    Array.isArray(fourier[0]) &&
    fourier[0].length > 0 &&
    Array.isArray(fourier[0][0]) &&
    fourier[0][0].length === 3
  ) {
    // Treat as (basis, coeffs)
    basis = fourier[0];
    coeff_list = Array.from(fourier[1] ?? []);
  } else if (fourier && typeof fourier === "object" && !Array.isArray(fourier)) {
    // (1) Dict with basis + coeffs
    basis = fourier["basis"];
    coeff_list = Array.from(fourier["coeffs"] ?? []);
    if (basis == null || !Array.isArray(coeff_list)) {
      throw new Error("Fourier dict must contain 'basis' and 'coeffs'.");
    }
  } else if (Array.isArray(fourier) && fourier.length > 0 && fourier[0] && typeof fourier[0] === "object" && !Array.isArray(fourier[0])) {
    // (2) List of item dicts each with q*_coeff and a shared 'basis'
    basis = fourier[0]["basis"];
    if (basis == null) {
      throw new Error("Each Fourier-wave-vector item must include a shared 'basis'.");
    }
    const m = basis.length;
    const labels = Array.from({ length: m }, (_, i) => `q${i + 1}_coeff`);
    coeff_list = [];
    for (const item of fourier) {
      const ib = item["basis"];
      // Allow equal lists; just ensure same basis across entries
      // Python: item.get("basis") is not basis and item.get("basis") != basis
      if (ib !== basis && JSON.stringify(ib) !== JSON.stringify(basis)) {
        throw new Error("Inconsistent 'basis' among Fourier-wave-vector items.");
      }
      const coeffs = labels.map((lbl) => (item[lbl] !== undefined ? item[lbl] : 0));
      coeff_list.push(coeffs);
    }
  } else {
    throw new Error("Unsupported 'fourier' shape.");
  }

  // Validate basis is a list of (kx,ky,kz)
  basis = Array.from(basis);
  if (basis.length === 0 || basis.some((b) => !Array.isArray(b) || b.length !== 3)) {
    throw new Error("'basis' must be a non-empty list of 3-tuples (kx,ky,kz).");
  }

  // Build k = sum_i coeff_i * q_i for each coeff vector
  /** @type {Array<[Fraction, Fraction, Fraction]>} */
  const k_list = [];

  for (const coeffs of coeff_list) {
    const coeffArr = Array.from(coeffs);
    if (coeffArr.length !== basis.length) {
      throw new Error("Coefficient vector length does not match basis size.");
    }

    /** @type {Array<[Fraction, any]>} */
    const scale_vecs = [];
    for (let i = 0; i < basis.length; i++) {
      scale_vecs.push([_to_fraction(coeffArr[i]), basis[i]]);
    }

    const k_frac = _vector_sum(scale_vecs);
    k_list.push(k_frac);
  }

  return k_list;
}

/**
 * Parse modulation info.
 * Mirrors _parse_modulation.
 *
 * @param {Map<string, any>} cifblock
 */
export function _parse_modulation(cifblock) {
  const [structural_q, mod_dim, has_struct_mod, struct_mod_atoms] = parse_structural_modulation(cifblock);

  let magnetic_q = null;

  // (A) magnetic superspace -> uses same q as structural superspace
  if (cifblock.has("_space_group.magn_ssg_name") && structural_q) {
    magnetic_q = structural_q;
  }
  // (B) commensurate magnetic propagation vector
  else if (cifblock.get("parent_propagation_vector.kxkykz")) {
    const rows = cifblock.get("parent_propagation_vector.kxkykz");
    // rows expected as list-of-lists (CIF2 list) or array-like
    // magnetic_q = Array.from(rows).map((row) => Array.from(row).map((v) => parse_cif_float(v, { meta: false })));
    magnetic_q = Array.from(rows).map((row) => Array.from(row).map((v) => _to_fraction(v)));
  }
  // (C) Fourier-defined magnetic propagation vector
  else {
    const fourier = extract_fourier(cifblock);
    if (fourier) {
      magnetic_q = _collect_k_from_fourier(fourier);
    }
  }

  const [has_mag_mod, mag_mod_atoms] = _get_magnetic_fourier_info(cifblock);

  return [structural_q, magnetic_q, mod_dim, has_struct_mod, has_mag_mod, struct_mod_atoms, mag_mod_atoms];
}

/**
 * Python:
 *   fx = Fraction(x).limit_denominator(max_den)
 *   return abs(float(fx) - x) < tol
 *
 * We approximate via continued fractions (sufficient for max_den <= 12 defaults).
 *
 * @param {number} x
 * @param {number} max_den
 * @param {number} tol
 * @returns {boolean}
 */
export function is_rational_component(x, max_den = 12, tol = 1e-6) {
  const xv = (/** @type {any} */ (x) instanceof Fraction) ? x.toNumber() : x;
  const fx = _limitDenominator(xv, max_den);
  return Math.abs(fx.toNumber() - xv) < tol;
}

/** @param {number} x @param {number} maxDen */
function _limitDenominator(x, maxDen) {
  if (!Number.isFinite(x)) return new Fraction(0);
  const sign = x < 0 ? -1 : 1;
  let value = Math.abs(x);

  // Continued fraction expansion
  let h1 = 1n, h0 = 0n;
  let k1 = 0n, k0 = 1n;

  let a = Math.floor(value);
  let frac = value - a;

  let h = BigInt(a) * h1 + h0;
  let k = BigInt(a) * k1 + k0;

  h0 = h1; h1 = h;
  k0 = k1; k1 = k;

  const maxK = BigInt(maxDen);

  while (frac > 0 && k1 <= maxK) {
    value = 1 / frac;
    a = Math.floor(value);
    frac = value - a;

    h = BigInt(a) * h1 + h0;
    k = BigInt(a) * k1 + k0;

    if (k > maxK) break;

    h0 = h1; h1 = h;
    k0 = k1; k1 = k;
  }

  const n = BigInt(sign) * h1;
  const d = k1 === 0n ? 1n : k1;
  return new Fraction(n, d);
}

/**
 * Convert a cifblock to magnetic ASU descriptor.
 * Mirrors cifblock_to_mag_asu.
 *
 * @param {Map<string, any>} cifblock
 * @param {{error_on_nonmag?: boolean}=} opts
 */
export function cifblock_to_mag_asu(cifblock, opts = {}) {
  const error_on_nonmag = !!opts.error_on_nonmag;

  const [basis, positions, res, magmoms, spin_basis, magres, symbols, labels, equivalent_atoms] = _parse_mag_asu_cell(
    cifblock,
    { moment_equalization: true }
  );

  const [structural_q, magnetic_q, mod_dim, has_struct_mod, has_mag_mod, struct_mod_atoms, mag_mod_atoms] =
    _parse_modulation(cifblock);

  if (error_on_nonmag && magmoms == null) {
    throw new Error("Could not extract magnetic moments from mcif file");
  }

  // Determine if magnetic q is incommensurate
  let mq_is_incomm = false;
  if (magnetic_q) {
    for (const q of magnetic_q) {
      if (q.some((x) => !is_rational_component(x))) {
        mq_is_incomm = true;
        break;
      }
    }
  }

  // Build incommensurate descriptor only when really needed
  let incomm = null;
  if (mod_dim > 0 || mq_is_incomm) {
    incomm = {
      structural_q,
      magnetic_q,
      mod_dim,
      has_structural_modulation: has_struct_mod,
      structural_modulated_atoms: struct_mod_atoms,
      has_magnetic_modulation: has_mag_mod,
      magnetic_modulated_atoms: mag_mod_atoms,
    };
  }

  // Symops: either xyz (4-part) or algebraic superspace
  const base_symops_xyzt = cifblock.get("space_group_symop_magn_operation.xyz");
  let base_symops;
  if (base_symops_xyzt == null) {
    const base_symops_alg = cifblock.get("space_group_symop_magn_ssg_operation.algebraic");
    if (base_symops_alg == null) {
      throw new Error("No symmetry operations in mcif");
    }
    base_symops = alg_symops_to_matrix(base_symops_alg, true, "spglib");
  } else {
    base_symops = xyzt_symops_to_matrix(base_symops_xyzt, true, "spglib");
  }

  const centering_symops_xyzt = cifblock.get("space_group_symop_magn_centering.xyz");
  let cent_symops;
  if (centering_symops_xyzt == null) {
    const centering_symops_alg = cifblock.get("space_group_symop_magn_ssg_centering.algebraic");
    if (centering_symops_alg == null) {
      // Default identity centering
      cent_symops = xyzt_symops_to_matrix(["x,y,z,+1"], true, "spglib");
    } else {
      cent_symops = alg_symops_to_matrix(centering_symops_alg, true, "spglib");
    }
  } else {
    cent_symops = xyzt_symops_to_matrix(centering_symops_xyzt, true, "spglib");
  }

  const symops = _compose_ops_with_centerings(base_symops, cent_symops);

  const bns_nbr = cifblock.get("space_group_magn.number_bns");
  const bns_name = cifblock.get("space_group_magn.name_bns");

  const parentHm = cifblock.get("parent_space_group.name_h-m_alt");
  const space_group_name_hm = parentHm ? String(parentHm).trim().replace(/  +/g, " ") : parentHm;

  const space_group_nbr = cifblock.get("parent_space_group.it_number");
  const icsd = cifblock.get("database_code_ICSD");
  const doi = cifblock.get("citation_doi");

  return {
    basis,
    positions,
    symbols,
    symops,
    incomm,
    space_group_nbr,
    space_group_name_hm,
    icsd,
    doi,
    spin_basis,
    magmoms,
    bns_nbr,
    bns_name,
    equivalent_atoms,
    resolution: res,
    magmom_resolution: magres,
    labels,
  };
}

/**
 * Read all cif blocks from mcif stream and convert each to magnetic ASU.
 * Mirrors mag_asus_from_mcif_file.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{error_on_nonmag?: boolean}=} opts
 */
export async function mag_asus_from_mcif_file(stream, opts = {}) {
  const error_on_nonmag = !!opts.error_on_nonmag;

  const [cifblocks /*, header*/] = await read_cif(stream, true, true, false); // pragmatic default true, allow_cif2 true, use_types false

  const outputs = [];
  for (const [, cifblock] of cifblocks) {
    outputs.push(cifblock_to_mag_asu(cifblock, { error_on_nonmag }));
  }
  return outputs;
}

/**
 * Read mcif stream and return a single magnetic ASU from the first block with atom_site_label.
 * Mirrors single_mag_asu_from_mcif_file.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{error_on_nonmag?: boolean}=} opts
 */
export async function single_mag_asu_from_mcif_file(stream, opts = {}) {
  const error_on_nonmag = !!opts.error_on_nonmag;

  const [cifblocks /*, header*/] = await read_cif(stream, true, true, false);

  let chosen = null;
  for (const [, cifblock] of cifblocks) {
    if (cifblock.has("atom_site_label")) {
      chosen = cifblock;
      break;
    }
  }
  if (!chosen) {
    throw new Error("No structural block found in CIF.");
  }

  return cifblock_to_mag_asu(chosen, { error_on_nonmag });
}

