// Fitting and analysis of a mode map U(Q): the energy of a structure frozen
// along one phonon eigenvector as a function of the normal-mode coordinate Q
// (amu^½·Å, see phononMath.js frozenDisplacement). Pure functions.
//
// With Σ m u² = Q², a harmonic mode has U = ½ ω² Q², so the quadratic
// coefficient of a polynomial fit gives back a frequency directly comparable
// with the one phonopy computed — a positive check on a stable mode, and for an
// imaginary mode the depth and position of the double-well minima tell how far
// the structure wants to distort.

// 1 eV / (amu Å²) expressed in rad²/s²: e / (u · 1e-20 m²).
const EV_PER_AMU_A2_TO_RAD2_S2 = 1.602176634e-19 / (1.66053906660e-27 * 1e-20);

/** Angular frequency² in eV/(amu Å²) → frequency in THz, sign-preserving
 *  (negative result = imaginary frequency, phonopy's convention). */
export function omega2ToTHz(omega2) {
  const w = Math.sqrt(Math.abs(omega2) * EV_PER_AMU_A2_TO_RAD2_S2);
  const thz = w / (2 * Math.PI) / 1e12;
  return omega2 < 0 ? -thz : thz;
}

/** THz → ω² in eV/(amu Å²), sign-preserving. */
export function thzToOmega2(thz) {
  const w = Math.abs(thz) * 1e12 * 2 * Math.PI;
  const o2 = (w * w) / EV_PER_AMU_A2_TO_RAD2_S2;
  return thz < 0 ? -o2 : o2;
}

/** Solve the small dense system A x = b by Gaussian elimination with partial
 *  pivoting. A is destroyed. */
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-300) throw new Error('singular fit matrix');
    if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [b[p], b[c]] = [b[c], b[p]]; }
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/**
 * @typedef {Object} PolyFit
 * @property {number[]} powers        the Q powers used, e.g. [0, 2, 4]
 * @property {number[]} coefficients  one per power (eV / (amu^½ Å)^p)
 * @property {number} rms             rms residual (eV)
 * @property {number} maxResidual
 * @property {(Q:number)=>number} evaluate
 * @property {(Q:number)=>number} derivative
 */

/**
 * Least-squares polynomial U(Q) = Σ c_p Q^p. `evenOnly` keeps p ∈ {0,2,4,…}
 * (the physical form for a mode whose +Q and −Q patterns are symmetry
 * equivalent); otherwise all powers up to `degree` are fitted. The
 * coordinates are scaled to |Q| ≤ 1 internally so high orders stay
 * well-conditioned.
 * @param {ArrayLike<number>} Q
 * @param {ArrayLike<number>} E
 * @param {{degree?: number, evenOnly?: boolean}} [opts]
 * @returns {PolyFit}
 */
export function fitPolynomial(Q, E, { degree = 4, evenOnly = true } = {}) {
  const n = Q.length;
  const powers = [];
  for (let p = 0; p <= degree; p++) if (!evenOnly || p % 2 === 0) powers.push(p);
  if (n < powers.length) throw new Error(`need at least ${powers.length} points for this fit`);
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(Q[i]));
  if (!(scale > 0)) throw new Error('all Q are zero');
  const m = powers.length;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);
  for (let i = 0; i < n; i++) {
    const x = Q[i] / scale;
    const basis = powers.map((p) => x ** p);
    for (let r = 0; r < m; r++) {
      b[r] += basis[r] * E[i];
      for (let c = 0; c < m; c++) A[r][c] += basis[r] * basis[c];
    }
  }
  const scaled = solve(A, b);
  const coefficients = scaled.map((c, k) => c / scale ** powers[k]);
  const evaluate = (q) => coefficients.reduce((s, c, k) => s + c * q ** powers[k], 0);
  const derivative = (q) => coefficients.reduce((s, c, k) => (powers[k] === 0 ? s : s + c * powers[k] * q ** (powers[k] - 1)), 0);
  let ss = 0;
  let maxResidual = 0;
  for (let i = 0; i < n; i++) {
    const r = E[i] - evaluate(Q[i]);
    ss += r * r;
    maxResidual = Math.max(maxResidual, Math.abs(r));
  }
  return { powers, coefficients, rms: Math.sqrt(ss / n), maxResidual, evaluate, derivative };
}

/**
 * What the fitted surface says about the mode.
 * - `omega2`: 2·c₂ in eV/(amu Å²); `frequencyTHz`: its sign-preserving root.
 * - `minima`: stationary points with U'' > 0 inside the scanned Q range
 *   (excluding Q≈0 when it is a maximum), each { Q, energy, depth } where
 *   depth = U(0) − U(min) > 0 for a double well.
 * - `isDoubleWell`: the origin is a local maximum and at least one minimum lies
 *   inside the range.
 * @param {PolyFit} fit
 * @param {number} qMin
 * @param {number} qMax
 */
export function analyzeFit(fit, qMin, qMax) {
  const c2 = fit.coefficients[fit.powers.indexOf(2)] ?? 0;
  const omega2 = 2 * c2;
  const u0 = fit.evaluate(0);
  const minima = [];
  // Bracket roots of U' on a fine grid, then bisect.
  const N = 2000;
  let prevQ = qMin;
  let prevD = fit.derivative(prevQ);
  for (let i = 1; i <= N; i++) {
    const q = qMin + ((qMax - qMin) * i) / N;
    const d = fit.derivative(q);
    if (prevD < 0 && d >= 0) {
      let lo = prevQ;
      let hi = q;
      for (let k = 0; k < 60; k++) {
        const mid = 0.5 * (lo + hi);
        if (fit.derivative(mid) < 0) lo = mid; else hi = mid;
      }
      const qm = 0.5 * (lo + hi);
      const em = fit.evaluate(qm);
      minima.push({ Q: qm, energy: em, depth: u0 - em });
    }
    prevQ = q;
    prevD = d;
  }
  const originIsMaximum = c2 < 0;
  const offCentre = minima.filter((m) => Math.abs(m.Q) > 1e-6 * Math.max(1, Math.abs(qMax - qMin)));
  return {
    omega2,
    frequencyTHz: omega2ToTHz(omega2),
    minima,
    isDoubleWell: originIsMaximum && offCentre.length > 0,
    barrier: originIsMaximum && offCentre.length ? Math.max(...offCentre.map((m) => m.depth)) : 0,
  };
}

/** Evenly spaced Q values from qMin to qMax (inclusive), always containing 0
 *  when the range straddles it so the reference energy is measured, not
 *  interpolated. */
export function amplitudeGrid(qMin, qMax, nPoints) {
  const n = Math.max(2, Math.round(nPoints));
  const out = [];
  for (let i = 0; i < n; i++) out.push(qMin + ((qMax - qMin) * i) / (n - 1));
  if (qMin < 0 && qMax > 0 && !out.some((q) => Math.abs(q) < 1e-12)) {
    out.push(0);
    out.sort((a, b) => a - b);
  }
  return out;
}
