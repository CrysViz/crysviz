import { read_cif } from "./cif_reader.js";

/**
 * Regexp close to https://www.iucr.org/__data/iucr/cifdic_html/2/cif_mm.dic/Dtypecodes.html
 * matches:  1.234(5), -12.3(12), 3(1)E2, 1.0e-3, +4.2, etc.
 *
 * Python:
 *   r'^(?P<sign>-)?'
 *   r'(?P<mant>(?:\d+\.?|\d*\.\d+))(\((?P<esd>\d+)\))?'
 *   r'(?:[eE](?P<exp>[+-]?\d+))?$'
 */
const _CIF_NUM_RE = /^(?<sign>-)?(?<mant>(?:\d+\.?|\d*\.\d+))(?:\((?<esd>\d+)\))?(?:[eE](?<exp>[+-]?\d+))?$/;

/**
 * A very small Fraction implementation for exact rational arithmetic.
 * Needed to preserve CIF parsing behavior for symmetry ops and literal resolution logic.
 */
export class Fraction {
  /**
   * @param {number|bigint|string|Fraction} value
   * @param {bigint=} den
   */
  constructor(value, den) {
    if (value instanceof Fraction) {
      this.n = value.n;
      this.d = value.d;
      return;
    }
    if (typeof den !== "undefined") {
      this.n = BigInt(value);
      this.d = BigInt(den);
      if (this.d === 0n) throw new Error("Zero denominator");
      this._normalize();
      return;
    }

    if (typeof value === "bigint") {
      this.n = value;
      this.d = 1n;
      return;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Non-finite number for Fraction");
      // Convert number -> rational via decimal string (exact for typical CIF inputs like 0.5, 1.25)
      const s = String(value);
      this._fromString(s);
      return;
    }

    if (typeof value === "string") {
      this._fromString(value);
      return;
    }

    // default 0
    this.n = 0n;
    this.d = 1n;
  }

  /** @param {string} s */
  _fromString(s) {
    const t = s.trim();
    if (!t) {
      this.n = 0n;
      this.d = 1n;
      return;
    }
    // sign
    let sign = 1n;
    let u = t;
    if (u[0] === "+") u = u.slice(1);
    else if (u[0] === "-") {
      sign = -1n;
      u = u.slice(1);
    }

    if (u.includes("/")) {
      const [a, b] = u.split("/", 2);
      if (!/^\d+$/.test(a.trim()) || !/^\d+$/.test(b.trim())) {
        throw new Error(`Invalid fraction literal: ${s}`);
      }
      this.n = sign * BigInt(a.trim());
      this.d = BigInt(b.trim());
      if (this.d === 0n) throw new Error("Zero denominator");
      this._normalize();
      return;
    }

    // Decimal literal
    if (u.includes(".")) {
      const [before, after] = u.split(".", 2);
      const digits = (before || "0") + (after || "");
      if (!/^\d+$/.test(digits)) throw new Error(`Invalid decimal literal: ${s}`);
      const scale = 10n ** BigInt(after.length);
      this.n = sign * BigInt(digits);
      this.d = scale;
      this._normalize();
      return;
    }

    // Integer
    if (!/^\d+$/.test(u)) throw new Error(`Invalid integer literal: ${s}`);
    this.n = sign * BigInt(u);
    this.d = 1n;
  }

  _normalize() {
    if (this.d < 0n) {
      this.n = -this.n;
      this.d = -this.d;
    }
    const g = _bigintGcd(this.n < 0n ? -this.n : this.n, this.d);
    this.n /= g;
    this.d /= g;
  }

  /** @param {Fraction|number|string} other */
  add(other) {
    const o = other instanceof Fraction ? other : new Fraction(other);
    return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  /** @param {Fraction|number|string} other */
  sub(other) {
    const o = other instanceof Fraction ? other : new Fraction(other);
    return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  /** @param {Fraction|number|string} other */
  mul(other) {
    const o = other instanceof Fraction ? other : new Fraction(other);
    return new Fraction(this.n * o.n, this.d * o.d);
  }

  /** @param {Fraction|number|string} other */
  div(other) {
    const o = other instanceof Fraction ? other : new Fraction(other);
    if (o.n === 0n) throw new Error("Division by zero");
    return new Fraction(this.n * o.d, this.d * o.n);
  }

  neg() {
    return new Fraction(-this.n, this.d);
  }

  toNumber() {
    return Number(this.n) / Number(this.d);
  }

  toString() {
    if (this.d === 1n) return this.n.toString();
    return `${this.n.toString()}/${this.d.toString()}`;
  }
}

/** @param {bigint} a @param {bigint} b */
function _bigintGcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/**
 * Resolution implied by the literal format of txt (no ESD logic).
 * @param {string|null|undefined} txt
 * @returns {number}
 */
export function _literal_resolution(txt) {
  if (txt == null) return 0.0;
  let s = String(txt).trim();
  if (!s) return 0.0;

  // Strip leading sign
  if (s[0] === "+" || s[0] === "-") s = s.slice(1);

  // Fractions -> exact (0.0), but only if valid
  if (s.includes("/")) {
    try {
      // validate
      new Fraction(s);
      return 0.0;
    } catch {
      return 0.0;
    }
  }

  // Be robust against exponent in the literal
  const lower = s.toLowerCase();
  if (lower.includes("e")) {
    s = lower.split("e", 2)[0];
  }

  if (s.includes(".")) {
    const parts = s.split(".", 2);
    const after = parts[1] ?? "";
    const digits = [...after].filter((ch) => ch >= "0" && ch <= "9").join("");
    if (!digits) {
      // '5.' or '.' or '.e3'
      return 1.0;
    }
    return 10.0 ** (-digits.length);
  }

  // Integer literal
  return 1.0;
}

/**
 * Parse a CIF numeric field. Mirrors parse_cif_float.
 *
 * If meta=false:
 *   returns number|null
 * If meta=true:
 *   returns [number|null, {esd: number|null, resolution: number}]
 *
 * @param {string} token
 * @param {{meta?: boolean, pragmatic?: boolean}=} opts
 * @returns {any}
 */
export function parse_cif_float(token, opts = {}) {
  const meta = !!opts.meta;
  const pragmatic = !!opts.pragmatic;

  if (token == null) {
    throw new Error("parse_cif_float parsing None");
  }

  let t = String(token).trim();
  if (t === "?") {
    if (meta) return [null, { esd: null, resolution: 0.0 }];
    return null;
  }

  if (t === "." || t === "") {
    throw new Error("Missing cif value cannot be conveted to float");
  }

  // Replace unicode minus
  if (t.includes("\u2212") || t.includes("\u2013") || t.includes("\u2014")) {
    if (pragmatic) {
      t = t.replaceAll("\u2212", "-").replaceAll("\u2013", "-").replaceAll("\u2014", "-");
    } else {
      throw new Error("Cif contains non-ascii minus sign: " + String(t));
    }
  }

  const m = t.match(_CIF_NUM_RE);

  if (!m) {
    // fractions allowed here too
    let val;
    try {
      if (t.includes("/")) {
        val = new Fraction(t).toNumber();
      } else {
        val = Number(t);
        if (!Number.isFinite(val)) throw new Error("NaN/Inf");
      }
    } catch {
      // last resort: grab first float-looking chunk
      // Python: float(re.split(r'([0-9]*(\.[0-9]+)?)', t)[1])
      const parts = t.split(/([0-9]*(\.[0-9]+)?)/);
      // parts[1] corresponds to first capturing group
      val = Number(parts[1]);
    }

    const res = _literal_resolution(t);
    if (meta) return [val, { esd: null, resolution: res }];
    return val;
  }

  // ---- Normal CIF number ----
  const groups = /** @type {any} */ (m.groups || {});
  const sign = groups.sign === "-" ? -1 : 1;
  const mant_str = groups.mant;

  // Use number arithmetic; CIF magnitudes are typically safe in JS Number.
  const mant = Number(mant_str);
  const exp = Number(groups.exp ?? "0");
  const val = sign * mant * (10 ** exp);

  // resolution from mantissa literal
  const res = _literal_resolution(mant_str) * (10.0 ** exp);

  const esd_str = groups.esd;

  if (!meta) {
    // Ignore esd; user didn't ask for meta info
    return val;
  }

  let esd_val = null;
  if (typeof esd_str !== "undefined" && esd_str !== null) {
    // Classic CIF esd logic
    let dec_places = 0;
    if (mant_str.includes(".")) {
      dec_places = mant_str.split(".", 2)[1].length;
    }
    const esd_abs = Number(esd_str) * (10 ** (exp - dec_places));
    esd_val = esd_abs;
  }

  return [val, { esd: esd_val, resolution: res }];
}

/**
 * Convert a CIF numeric token (e.g., '123(4)', '3E2', '1.0E3') to an int using the central value.
 * - strict=true: require the value to be exactly integral; otherwise throw.
 * - allow_round=true (only if strict=false): round half-even to nearest int (banker's rounding).
 *
 * @param {string} token
 * @param {{strict?: boolean, allow_round?: boolean}=} opts
 * @returns {number}
 */
export function parse_cif_int(token, opts = {}) {
  const strict = opts.strict !== undefined ? !!opts.strict : true;
  const allow_round = !!opts.allow_round;

  const t = String(token).trim();
  if (t === "." || t === "?" || t === "") {
    throw new Error("Missing CIF value cannot be converted to int");
  }

  const m = t.match(_CIF_NUM_RE);

  let val;
  if (!m) {
    // Fall back for plain integers without (esd)/exponent; will throw if not numeric-ish
    val = Number(t);
    if (!Number.isFinite(val)) throw new Error(`Invalid numeric token: ${token}`);
  } else {
    const g = /** @type {any} */ (m.groups || {});
    const sign = g.sign === "-" ? -1 : 1;
    const mant = Number(g.mant);
    const exp = Number(g.exp ?? "0");
    val = sign * mant * (10 ** exp);
  }

  const isIntegral = Number.isFinite(val) && Math.trunc(val) === val;

  if (strict) {
    if (isIntegral) return val;
    throw new Error(`Non-integer numeric cannot be coerced strictly: ${JSON.stringify(token)}`);
  }

  if (isIntegral) return val;

  if (allow_round) {
    // banker's rounding (half-even)
    const r = _roundHalfEven(val);
    return r;
  }

  throw new Error(`Non-integer numeric (set allow_round=True to round): ${JSON.stringify(token)}`);
}

/** @param {number} x */
function _roundHalfEven(x) {
  const f = Math.floor(x);
  const frac = x - f;
  if (frac < 0.5) return f;
  if (frac > 0.5) return f + 1;
  // exactly .5: to even
  return (f % 2 === 0) ? f : f + 1;
}

/**
 * expr: e.g. 'x-y', '-z+1/2', 'x', 'y', 'z-1', 'x-2y', '3x+1/2'
 * Returns [row, const] where row is [ax, ay, az] (numbers or Fractions),
 * and const is a number or Fraction depending on use_fractions.
 *
 * Mirrors parse_linear_expr.
 *
 * @param {string} expr
 * @param {boolean} use_fractions
 * @returns {[any[], any]}
 */
export function parse_linear_expr(expr, use_fractions = false) {
  let s = String(expr).replaceAll(" ", "");
  if (!s) throw new Error("Empty expression");
  if (s[0] !== "+" && s[0] !== "-") s = "+" + s;

  /** @type {{x:any,y:any,z:any}} */
  const coeffs = use_fractions
    ? { x: new Fraction(0), y: new Fraction(0), z: new Fraction(0) }
    : { x: 0, y: 0, z: 0 };

  let constTerm = use_fractions ? new Fraction(0) : 0.0;

  // Python token_re:
  // r'([+-])(?:(?:(?:(\d+(?:/\d+)?|\d*\.\d+)?)' \
  //    r'(x|y|z))|((?:\d+/\d+)|(?:\d+(?:\.\d+)?)))'
  const tokenRe = /([+-])(?:(?:(?:(\d+(?:\/\d+)?|\d*\.\d+)?)(x|y|z))|((?:\d+\/\d+)|(?:\d+(?:\.\d+)?)))/g;

  let pos = 0;
  for (const m of s.matchAll(tokenRe)) {
    const start = /** @type {any} */ (m).index ?? 0;
    if (start !== pos) {
      throw new Error(`Unparsed tail in '${expr}' near '${s.slice(pos)}'`);
    }
    pos = start + m[0].length;

    const signCh = m[1];
    const coef_str = m[2]; // may be ""/undefined
    const variable = m[3]; // x|y|z or undefined
    const num = m[4]; // standalone number or undefined
    const sgn = signCh === "+" ? 1 : -1;

    if (variable != null) {
      // variable term ± (coef or 1) * var
      let coef_val;
      if (coef_str == null || coef_str === "") {
        coef_val = use_fractions ? new Fraction(1) : 1;
      } else {
        if (coef_str.includes("/")) {
          coef_val = new Fraction(coef_str);
        } else {
          coef_val = use_fractions ? new Fraction(coef_str) : Number(coef_str);
        }
      }

      if (use_fractions) {
        const delta = (sgn === 1) ? coef_val : coef_val.neg();
        coeffs[variable] = coeffs[variable].add(delta);
      } else {
        coeffs[variable] += sgn * /** @type {number} */ (coef_val instanceof Fraction ? coef_val.toNumber() : coef_val);
      }
    } else {
      // standalone numeric translation
      if (use_fractions) {
        const val = new Fraction(num);
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

  const const_out = use_fractions ? constTerm : Number(constTerm);
  return [[coeffs.x, coeffs.y, coeffs.z], const_out];
}

/**
 * op: e.g. 'x-y,x,-z+1/2'
 * Returns [R, t] where R is 3x3 (list of rows), t is length-3.
 * Mirrors parse_xyz_op.
 *
 * @param {string} op
 * @param {boolean} use_fractions
 * @returns {[any[], any[]]}
 */
export function parse_xyz_op(op, use_fractions = false) {
  const parts = String(op).split(",").map((p) => p.trim());
  if (parts.length !== 3) throw new Error(`Unexpected op format: ${op}`);
  const [px, py, pz] = parts;
  const [rx, tx] = parse_linear_expr(px, use_fractions);
  const [ry, ty] = parse_linear_expr(py, use_fractions);
  const [rz, tz] = parse_linear_expr(pz, use_fractions);
  return [[rx, ry, rz], [tx, ty, tz]];
}

/**
 * @param {string[]} symops_xyz
 * @param {boolean} use_fractions
 * @returns {Array<[any[], any[]]>}
 */
export function xyz_symops_to_matrix(symops_xyz, use_fractions = false) {
  return symops_xyz.map((s) => parse_xyz_op(s, use_fractions));
}

/**
 * Internal: parse atoms from a cif block map.
 * Mirrors _parse_atoms.
 *
 * Returns:
 *   if resolution==false:
 *     [symbols, labels, positions, occupancies]
 *   else:
 *     [symbols, labels, positions, occupancies, res]
 *
 * positions: list of [x,y,z] numbers
 *
 * @param {Map<string, any>} block
 * @param {boolean} resolution
 * @returns {any[]}
 */
export function _parse_atoms(block, resolution = true) {
  const syms = block.get("atom_site_type_symbol");
  const lbs = block.get("atom_site_label");
  const xs = block.get("atom_site_fract_x");
  const ys = block.get("atom_site_fract_y");
  const zs = block.get("atom_site_fract_z");

  const n = xs.length;
  if (!(ys.length === zs.length && zs.length === lbs.length && lbs.length === syms.length && syms.length === n)) {
    throw new Error("Atom-site column length mismatch");
  }

  // Optional occupancy column
  const occ_col = block.get("atom_site_occupancy");
  let occs = null;
  if (occ_col != null) {
    occs = [];
    for (const t of occ_col) {
      const v = parse_cif_float(t, { meta: false, pragmatic: false });
      occs.push(v);
    }
  }

  const symbols = syms.map((s) => String(s).trim());
  const labels = lbs.map((l) => String(l).trim());

  if (!resolution) {
    const positions = xs.map((xi, i) => [
      parse_cif_float(xi, { meta: false, pragmatic: false }),
      parse_cif_float(ys[i], { meta: false, pragmatic: false }),
      parse_cif_float(zs[i], { meta: false, pragmatic: false }),
    ]);
    return [symbols, labels, positions, occs];
  }

  const positions = [];
  const coord_resolutions = [];

  for (let i = 0; i < n; i++) {
    const [vx, mx] = parse_cif_float(xs[i], { meta: true, pragmatic: false });
    const [vy, my] = parse_cif_float(ys[i], { meta: true, pragmatic: false });
    const [vz, mz] = parse_cif_float(zs[i], { meta: true, pragmatic: false });

    positions.push([vx, vy, vz]);
    coord_resolutions.push(
      (mx && mx.resolution != null) ? mx.resolution : 0.0,
      (my && my.resolution != null) ? my.resolution : 0.0,
      (mz && mz.resolution != null) ? mz.resolution : 0.0
    );
  }

  // 1) Data-implied resolution: coarsest (largest) non-zero resolution.
  const finite_res = coord_resolutions.filter((r) => r != null);
  const data_resolution = finite_res.length ? Math.max(...finite_res) : 0.0;

  // 2) Separation resolution from coordinates (fractional, periodic deltas)
  let separation_resolution;
  if (n > 1) {
    const periodic_delta = (a, b) => {
      const d = Math.abs(a - b);
      return Math.min(d, 1.0 - d);
    };

    const eps = data_resolution > 0.0 ? (data_resolution / 10.0) : 1e-12;

    const deltas_x = [];
    const deltas_y = [];
    const deltas_z = [];

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        deltas_x.push(periodic_delta(positions[i][0], positions[j][0]));
        deltas_y.push(periodic_delta(positions[i][1], positions[j][1]));
        deltas_z.push(periodic_delta(positions[i][2], positions[j][2]));
      }
    }

    const pos_x = deltas_x.filter((d) => d > eps);
    const pos_y = deltas_y.filter((d) => d > eps);
    const pos_z = deltas_z.filter((d) => d > eps);

    const sep_x = pos_x.length ? Math.min(...pos_x) : Infinity;
    const sep_y = pos_y.length ? Math.min(...pos_y) : Infinity;
    const sep_z = pos_z.length ? Math.min(...pos_z) : Infinity;

    const min_sep = Math.min(sep_x, sep_y, sep_z);
    separation_resolution = Number.isFinite(min_sep) ? (min_sep / 2.0) : Infinity;
  } else {
    separation_resolution = Infinity;
  }

  // 3) Final res
  let res;
  if (separation_resolution === Infinity) {
    res = data_resolution;
  } else if (data_resolution === 0.0) {
    res = separation_resolution;
  } else {
    res = Math.min(data_resolution, separation_resolution);
  }

  return [symbols, labels, positions, occs, res];
}

/**
 * Parse unit cell parameters from block.
 * Mirrors _parse_uc.
 * @param {Map<string, any>} block
 * @returns {[number, number, number, number, number, number]}
 */
export function _parse_uc(block) {
  const a = parse_cif_float(block.get("cell_length_a"), { meta: false, pragmatic: false });
  const b = parse_cif_float(block.get("cell_length_b"), { meta: false, pragmatic: false });
  const c = parse_cif_float(block.get("cell_length_c"), { meta: false, pragmatic: false });
  const alpha = parse_cif_float(block.get("cell_angle_alpha"), { meta: false, pragmatic: false });
  const beta = parse_cif_float(block.get("cell_angle_beta"), { meta: false, pragmatic: false });
  const gamma = parse_cif_float(block.get("cell_angle_gamma"), { meta: false, pragmatic: false });
  return [a, b, c, alpha, beta, gamma];
}

/**
 * Conventional 3x3 lattice (rows are a,b,c in Cartesian Å) from a,b,c (Å) and angles (deg).
 * Mirrors _basis_from_lengths_angles.
 */
export function _basis_from_lengths_angles(a, b, c, alpha, beta, gamma) {
  const _deg2rad = (d) => (d * Math.PI) / 180.0;

  const ar = _deg2rad(alpha);
  const br = _deg2rad(beta);
  const gr = _deg2rad(gamma);

  const ca = Math.cos(ar), cb = Math.cos(br), cg = Math.cos(gr);
  const sg = Math.sin(gr);

  const ax = a, ay = 0.0, az = 0.0;
  const bx = b * cg, by = b * sg, bz = 0.0;

  const cx = c * cb;
  const cy = c * (ca - cb * cg) / (Math.abs(sg) > 1e-12 ? sg : 1.0);
  const cz_sq = c * c - cx * cx - cy * cy;
  const cz = Math.sqrt(Math.max(cz_sq, 0.0));

  return [
    [ax, ay, az],
    [bx, by, bz],
    [cx, cy, cz],
  ];
}

/**
 * Parse ASU cell.
 * Mirrors parse_asu_cell.
 *
 * @param {Map<string, any>} cifblock
 */
export function parse_asu_cell(cifblock) {
  const [a, b, c, alpha, beta, gamma] = _parse_uc(cifblock);
  const basis = _basis_from_lengths_angles(a, b, c, alpha, beta, gamma);
  const [symbols, labels, positions, occs, res] = _parse_atoms(cifblock, true);

  // equivalent atoms based on labels
  const labels_map = new Map();
  const equivalent_atoms = [];
  let next_id = 1;
  for (const l of labels) {
    if (!labels_map.has(l)) {
      labels_map.set(l, next_id);
      next_id += 1;
    }
    equivalent_atoms.push(labels_map.get(l));
  }

  return [basis, positions, res, symbols, labels, equivalent_atoms];
}

/**
 * Extract structural superspace modulation information from a standard CIF.
 * Mirrors parse_structural_modulation.
 *
 * @param {Map<string, any>} cifblock
 * @returns {[any, number, boolean, string[]]}
 */
export function parse_structural_modulation(cifblock) {
  // modulation dimension (0 if absent)
  const mod_dim = Number(cifblock.get("cell_modulation_dimension") ?? 0);

  // structural_q from cell_wave_vector
  let structural_q = null;
  const qx = cifblock.get("_cell_wave_vector_x");
  const qy = cifblock.get("_cell_wave_vector_y");
  const qz = cifblock.get("_cell_wave_vector_z");
  if (qx && qy && qz) {
    structural_q = Array.from({ length: qx.length }, (_, i) => [
      Number(qx[i]),
      Number(qy[i]),
      Number(qz[i]),
    ]);
  }

  // detect structural Fourier modulations
  let has_struct_mod = false;
  const struct_mod_atoms = new Set();

  let labels = cifblock.get("_atom_site_displace_Fourier.atom_site_label");
  if (labels) {
    has_struct_mod = true;
    for (const l of labels) struct_mod_atoms.add(l);
  }

  labels = cifblock.get("_atom_site_occupancy_Fourier.atom_site_label");
  if (labels) {
    has_struct_mod = true;
    for (const l of labels) struct_mod_atoms.add(l);
  }

  const atoms_sorted = Array.from(struct_mod_atoms).sort();
  return [structural_q, mod_dim, has_struct_mod, atoms_sorted];
}

/**
 * Convert a cif block to ASU structure descriptor.
 * Mirrors cifblock_to_asu.
 *
 * @param {Map<string, any>} cifblock
 * @param {{return_single?: boolean}=} _opts
 * @returns {any}
 */
export function cifblock_to_asu(cifblock, _opts = {}) {
  // basic atom-site parsing
  const [basis, positions, resolution, symbols, labels, equivalent_atoms] = parse_asu_cell(cifblock);

  // standard space group symmetry
  let symops_xyz = cifblock.get("space_group_symop.operation_xyz");
  // Legacy keynames
  if (symops_xyz == null) {
    symops_xyz = cifblock.get("space_group_symop_operation_xyz");
  }
  if (symops_xyz == null) {
    symops_xyz = cifblock.get("_symmetry_equiv_pos_as_xyz");
  }
  if (symops_xyz == null) {
    throw new Error("No symmetry operations in CIF.");
  }

  const symops = xyz_symops_to_matrix(symops_xyz, true);

  // structural modulation
  const [structural_q, mod_dim, has_struct_mod, struct_atoms] = parse_structural_modulation(cifblock);

  // Build the incommensurate structure descriptor, or null
  let incomm = null;
  if (mod_dim > 0 || structural_q || has_struct_mod) {
    incomm = {
      structural_q,
      mod_dim,
      has_structural_modulation: has_struct_mod,
      structural_modulated_atoms: struct_atoms,
    };
  }

  const space_group_name_hm =
    cifblock.get("_space_group_name_H-M_alt") || cifblock.get("_symmetry_space_group_name_H-M");

  const space_group_name_hall =
    cifblock.get("_space_group_name_Hall") || cifblock.get("_symmetry_space_group_name_Hall");

  const space_group_nbr =
    cifblock.get("_space_group_IT_number") || cifblock.get("symmetry_space_group_IT_number");

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
    space_group_name_hall,
    icsd,
    doi,
    resolution,
    equivalent_atoms,
    labels,
  };
}

/**
 * Read all cif blocks from stream and convert each to ASU.
 * Mirrors asus_from_cif_file.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<any[]>}
 */
export async function asus_from_cif_file(stream) {
  const [cifblocks /*, header*/] = await read_cif(stream, true, false, false); // pragmatic default true, allow_cif2 false, use_types false

  const outputs = [];
  for (const [, cifblock] of cifblocks) {
    outputs.push(cifblock_to_asu(cifblock));
  }
  return outputs;
}

/**
 * Read CIF stream and return a single ASU from the first block with atom_site_label.
 * Mirrors single_asu_from_cif_file.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<any>}
 */
export async function single_asu_from_cif_file(stream) {
  const [cifblocks /*, header*/] = await read_cif(stream, true, false, false);

  // Get the first cifblock with atomic sites
  let chosen = null;
  for (const [, cifblock] of cifblocks) {
    if (cifblock.has("atom_site_label")) {
      chosen = cifblock;
      break;
    }
  }
  if (!chosen) throw new Error("No structural block found in CIF.");
  return cifblock_to_asu(chosen);
}
