// Geometry and displacement maths for phonon modes. Pure functions, no DOM,
// no three.js — shared by the panel (animation), the mode-mapping scan and
// the browser tests, and small enough to run under node against
// phonopy-generated reference structures.
//
// Notation: a PhononCell (see phonopyReader.js) is the primitive cell the
// eigenvectors refer to. A supercell of it is described by integer diagonal
// dims [n1, n2, n3]. Every supercell atom j maps to a primitive atom p(j) and
// carries its position r_j in PRIMITIVE fractional coordinates (basis
// position plus integer translation) — that is the coordinate the Bloch
// phase exp(2πi q·r_j) needs, with q in reduced coordinates of the primitive
// reciprocal lattice (phonopy's convention: the phase includes the atom's
// basis position, not only the lattice translation).

export function invert3x3(m) {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) throw new Error('singular lattice');
  const inv = 1 / det;
  return [
    [A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv],
    [B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv],
    [C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv],
  ];
}

/** Cartesian = f · L with L rows = a, b, c. */
export function fracToCart(lattice, f) {
  return [
    f[0] * lattice[0][0] + f[1] * lattice[1][0] + f[2] * lattice[2][0],
    f[0] * lattice[0][1] + f[1] * lattice[1][1] + f[2] * lattice[2][1],
    f[0] * lattice[0][2] + f[1] * lattice[1][2] + f[2] * lattice[2][2],
  ];
}

/** Fractional = r · L⁻¹ (pass the precomputed inverse). */
export function cartToFracWithInverse(invLattice, r) {
  return [
    r[0] * invLattice[0][0] + r[1] * invLattice[1][0] + r[2] * invLattice[2][0],
    r[0] * invLattice[0][1] + r[1] * invLattice[1][1] + r[2] * invLattice[2][1],
    r[0] * invLattice[0][2] + r[1] * invLattice[1][2] + r[2] * invLattice[2][2],
  ];
}

/**
 * @typedef {Object} PhononSupercell
 * @property {number[][]} lattice    supercell lattice rows (Å)
 * @property {string[]} species
 * @property {number[]} masses
 * @property {number[][]} frac       supercell fractional coordinates
 * @property {Int32Array} primIndex  primitive atom of each supercell atom
 * @property {Float64Array} primFrac r_j in primitive fractional coordinates (3 per atom)
 * @property {number[]} dims
 * @property {number} natom
 */

/**
 * Tile a primitive cell into a diagonal supercell. Atom order: primitive atom
 * outermost, then translations with the third index fastest and (0,0,0)
 * first — the same grouping phonopy uses, so exported structures read
 * naturally, and every primitive atom's images are contiguous.
 * @param {import('./phonopyReader.js').PhononCell} cell
 * @param {number[]} dims
 * @returns {PhononSupercell}
 */
export function buildSupercell(cell, dims) {
  const [n1, n2, n3] = dims.map((n) => Math.max(1, Math.round(Number(n) || 1)));
  const nCells = n1 * n2 * n3;
  const nPrim = cell.species.length;
  const natom = nPrim * nCells;
  const lattice = [
    cell.lattice[0].map((v) => v * n1),
    cell.lattice[1].map((v) => v * n2),
    cell.lattice[2].map((v) => v * n3),
  ];
  const species = new Array(natom);
  const masses = new Array(natom);
  const frac = new Array(natom);
  const primIndex = new Int32Array(natom);
  const primFrac = new Float64Array(natom * 3);
  let j = 0;
  for (let p = 0; p < nPrim; p++) {
    const f = cell.frac[p];
    for (let i1 = 0; i1 < n1; i1++) {
      for (let i2 = 0; i2 < n2; i2++) {
        for (let i3 = 0; i3 < n3; i3++) {
          species[j] = cell.species[p];
          masses[j] = cell.masses[p];
          primIndex[j] = p;
          primFrac[j * 3] = f[0] + i1;
          primFrac[j * 3 + 1] = f[1] + i2;
          primFrac[j * 3 + 2] = f[2] + i3;
          frac[j] = [(f[0] + i1) / n1, (f[1] + i2) / n2, (f[2] + i3) / n3];
          j++;
        }
      }
    }
  }
  return { lattice, species, masses, frac, primIndex, primFrac, dims: [n1, n2, n3], natom };
}

/**
 * Smallest diagonal supercell in which a q-point's Bloch wave is periodic
 * (q_i · n_i integer), capped so an incommensurate q still yields something.
 */
export function commensurateDims(q, { maxN = 8, tol = 1e-4 } = {}) {
  return q.map((qi) => {
    for (let n = 1; n <= maxN; n++) {
      const x = qi * n;
      if (Math.abs(x - Math.round(x)) < tol) return n;
    }
    return maxN;
  });
}

/** Does exp(2πi q·R) close on itself in this supercell? */
export function isCommensurate(q, dims, tol = 1e-4) {
  return q.every((qi, k) => {
    const x = qi * dims[k];
    return Math.abs(x - Math.round(x)) < tol;
  });
}

/**
 * @typedef {Object} ModePattern
 * @property {Float64Array} re   Re c_j (3 per supercell atom), Å·amu^½ per unit eigenvector
 * @property {Float64Array} im   Im c_j
 * @property {number} maxNorm    max_j |c_j| — the largest complex displacement magnitude
 * @property {number} natom
 */

/**
 * The complex displacement pattern c_j = e_{p(j)} / √m_{p(j)} · exp(2πi q·r_j)
 * of one mode in a supercell, with the overall phase fixed the way phonopy's
 * MODULATION does: the element of largest magnitude is made real and positive,
 * then rotated by `argumentDeg`. Fixing the phase is what makes a "frozen"
 * pattern well defined for a q whose Bloch factors are complex.
 *
 * @param {PhononSupercell} sc
 * @param {number[]} q                reduced coordinates
 * @param {Float64Array|number[]} eigvec  6 per primitive atom: re,im for x,y,z
 * @param {number} [argumentDeg]
 * @returns {ModePattern}
 */
export function modePattern(sc, q, eigvec, argumentDeg = 0) {
  const n = sc.natom;
  const re = new Float64Array(n * 3);
  const im = new Float64Array(n * 3);
  let maxAbs = -1;
  let maxRe = 1;
  let maxIm = 0;
  for (let j = 0; j < n; j++) {
    const p = sc.primIndex[j];
    const invSqrtM = 1 / Math.sqrt(sc.masses[j]);
    const phase = 2 * Math.PI * (q[0] * sc.primFrac[j * 3] + q[1] * sc.primFrac[j * 3 + 1] + q[2] * sc.primFrac[j * 3 + 2]);
    const cp = Math.cos(phase);
    const sp = Math.sin(phase);
    for (let k = 0; k < 3; k++) {
      const er = eigvec[p * 6 + k * 2];
      const ei = eigvec[p * 6 + k * 2 + 1];
      // (er + i ei)(cp + i sp) / sqrt(m)
      const r = (er * cp - ei * sp) * invSqrtM;
      const i = (er * sp + ei * cp) * invSqrtM;
      re[j * 3 + k] = r;
      im[j * 3 + k] = i;
      const a = r * r + i * i;
      if (a > maxAbs) { maxAbs = a; maxRe = r; maxIm = i; }
    }
  }
  // Multiply every element by conj(max)/|max| · exp(i·arg) so the largest
  // element becomes real (then rotated by arg).
  const norm = Math.sqrt(maxRe * maxRe + maxIm * maxIm) || 1;
  const arg = (argumentDeg * Math.PI) / 180;
  const fr = (maxRe * Math.cos(arg) + maxIm * Math.sin(arg)) / norm;
  const fi = (maxRe * Math.sin(arg) - maxIm * Math.cos(arg)) / norm;
  let maxNorm = 0;
  for (let j = 0; j < n; j++) {
    let a = 0;
    for (let k = 0; k < 3; k++) {
      const r = re[j * 3 + k];
      const i = im[j * 3 + k];
      const nr = r * fr - i * fi;
      const ni = r * fi + i * fr;
      re[j * 3 + k] = nr;
      im[j * 3 + k] = ni;
      a += nr * nr + ni * ni;
    }
    maxNorm = Math.max(maxNorm, Math.sqrt(a));
  }
  return { re, im, maxNorm: maxNorm || 1, natom: n };
}

/**
 * Time-dependent displacement u_j(φ) = A · Re[c_j e^{-iφ}] / max|c|, so `A`
 * is (approximately — exactly for a linearly polarised mode) the largest
 * atomic excursion in Å. Writes 3 numbers per atom into `out`.
 */
export function animationDisplacement(pattern, phaseRad, amplitudeAng, out) {
  const s = amplitudeAng / pattern.maxNorm;
  const c = Math.cos(phaseRad) * s;
  const sn = Math.sin(phaseRad) * s;
  const { re, im } = pattern;
  for (let k = 0; k < re.length; k++) out[k] = re[k] * c + im[k] * sn;
  return out;
}

/**
 * Frozen (static) displacement for a normal-mode coordinate Q in amu^½·Å:
 * u_j = Q · Re c_j / √(Σ_k m_k |Re c_k|²), so Σ_j m_j u_j² = Q² exactly and a
 * harmonic mode has U(Q) = ½ ω² Q² — the definition that makes the frequency
 * fitted from a mode map directly comparable with the phonon frequency.
 */
export function frozenDisplacement(pattern, masses, Q, out) {
  const { re } = pattern;
  let norm = 0;
  for (let j = 0; j < pattern.natom; j++) {
    const m = masses[j];
    norm += m * (re[j * 3] ** 2 + re[j * 3 + 1] ** 2 + re[j * 3 + 2] ** 2);
  }
  const s = norm > 0 ? Q / Math.sqrt(norm) : 0;
  for (let k = 0; k < re.length; k++) out[k] = re[k] * s;
  return out;
}

/**
 * The same static pattern scaled the way phonopy's MODULATION tag does
 * (u = amplitude · Re c / √N_atoms), for users who want numbers matching
 * `phonopy -d`/MODULATION output or ModeMap runs.
 */
export function phonopyModulationDisplacement(pattern, amplitude, out) {
  const s = amplitude / Math.sqrt(pattern.natom);
  const { re } = pattern;
  for (let k = 0; k < re.length; k++) out[k] = re[k] * s;
  return out;
}

/** Conversion between the two static amplitude conventions above:
 *  phonopyAmplitude = Q · convertQToPhonopy(pattern, masses). */
export function qToPhonopyAmplitudeFactor(pattern, masses) {
  const { re } = pattern;
  let norm = 0;
  for (let j = 0; j < pattern.natom; j++) {
    norm += masses[j] * (re[j * 3] ** 2 + re[j * 3 + 1] ** 2 + re[j * 3 + 2] ** 2);
  }
  return norm > 0 ? Math.sqrt(pattern.natom / norm) : 0;
}

/** Largest |u_j| of a displacement array (3 per atom), in Å. */
export function maxDisplacement(u) {
  let best = 0;
  for (let j = 0; j < u.length; j += 3) {
    best = Math.max(best, u[j] ** 2 + u[j + 1] ** 2 + u[j + 2] ** 2);
  }
  return Math.sqrt(best);
}

/**
 * Fractional coordinates of a supercell displaced by Cartesian u (3 per atom).
 * Not wrapped: an atom that crosses a cell face keeps moving smoothly instead
 * of jumping to the opposite side mid-animation.
 * @returns {number[][]}
 */
export function displacedFractional(sc, u, invLattice = invert3x3(sc.lattice)) {
  const out = new Array(sc.natom);
  for (let j = 0; j < sc.natom; j++) {
    const du = cartToFracWithInverse(invLattice, [u[j * 3], u[j * 3 + 1], u[j * 3 + 2]]);
    const f = sc.frac[j];
    out[j] = [f[0] + du[0], f[1] + du[1], f[2] + du[2]];
  }
  return out;
}

/** Cartesian positions of a (displaced) supercell, 3 per atom. */
export function cartesianPositions(sc, u = null) {
  const out = new Array(sc.natom);
  for (let j = 0; j < sc.natom; j++) {
    const r = fracToCart(sc.lattice, sc.frac[j]);
    if (u) { r[0] += u[j * 3]; r[1] += u[j * 3 + 1]; r[2] += u[j * 3 + 2]; }
    out[j] = r;
  }
  return out;
}

/**
 * VASP POSCAR (Direct) text for a set of atoms. Species are grouped in
 * first-occurrence order; coordinates are wrapped into [0, 1) since DFT codes
 * expect that and the frozen pattern has no animation continuity to keep.
 */
export function toPOSCAR(comment, lattice, species, frac, { wrap = true } = {}) {
  const fmt = (x) => {
    let s = Number(x).toFixed(16);
    if (s === '-0.0000000000000000') s = '0.0000000000000000';
    return s.padStart(22);
  };
  const order = [];
  const counts = new Map();
  for (const el of species) {
    if (!counts.has(el)) { counts.set(el, 0); order.push(el); }
    counts.set(el, counts.get(el) + 1);
  }
  const lines = [
    String(comment).replace(/[\r\n]+/g, ' '),
    '   1.0',
    ...lattice.map((row) => row.map(fmt).join('')),
    order.join(' '),
    order.map((el) => String(counts.get(el)).padStart(4)).join(''),
    'Direct',
  ];
  for (const el of order) {
    species.forEach((s, j) => {
      if (s !== el) return;
      const f = frac[j].map((x) => {
        if (!wrap) return x;
        let w = x - Math.floor(x);
        if (w > 1 - 1e-12) w = 0;
        return w;
      });
      lines.push(f.map(fmt).join(''));
    });
  }
  return lines.join('\n') + '\n';
}

/** Read a POSCAR/CONTCAR back into { lattice, species, frac } — used by the
 *  tests to compare against phonopy's MPOSCAR files. */
export function parsePOSCAR(text) {
  const lines = String(text).split(/\r?\n/);
  const scale = Number(lines[1].trim());
  const lattice = [2, 3, 4].map((i) => lines[i].trim().split(/\s+/).map((v) => Number(v) * scale));
  let row = 5;
  let names = lines[row].trim().split(/\s+/);
  if (names.every((t) => /^\d+$/.test(t))) throw new Error('POSCAR without species line');
  row++;
  const counts = lines[row++].trim().split(/\s+/).map(Number);
  if (/^s/i.test(lines[row].trim())) row++;
  const direct = !/^[ck]/i.test(lines[row].trim());
  row++;
  const species = [];
  const frac = [];
  const inv = invert3x3(lattice);
  names.forEach((el, k) => {
    for (let i = 0; i < counts[k]; i++) {
      const v = lines[row++].trim().split(/\s+/).slice(0, 3).map(Number);
      species.push(el);
      frac.push(direct ? v : cartToFracWithInverse(inv, v));
    }
  });
  return { lattice, species, frac };
}
