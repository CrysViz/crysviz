// Spin remapping for widget-mode cell swaps (ui/WidgetMode.js).
//
// When the widget swaps the loaded cell for its conventional or primitive
// standardisation (via moyo), the magnetic moments must move with the atoms.
// moyo standardises only the NUCLEAR structure (it ignores moments), so the
// output cell is a rigid rotation R of the input crystal: an atom's Cartesian
// moment m becomes R·m, and the atom the output site came from is found by
// point-set registration under that same rotation.
//
// computeSpinRemap() is pure (no THREE / Spin / DOM) so it can be node-tested
// directly (tools/browsertest is browser-only). remapSpinsForVariant() wraps it
// for the app, building the Spin objects.
//
// Empirically verified against the vendored moyo WASM (docs/external/moyo-test):
//   * dataset.std_rotation_matrix R maps input Cartesian → standardised
//     Cartesian (v_std = R·v_input), for BOTH positions and moments;
//   * dataset.mapping_std_prim maps std_cell → prim_std_cell sites (NOT the
//     input), so it is unused here — registration is done straight against the
//     input for both variants, which also handles supercell input.
//
// The linear algebra is local (3×3 inverse + frac/cart conversions) rather than
// pulled from math/backend-*.js so this module stays dependency-free and
// node-runnable; ponytail: ~30 lines, not worth a wasm-backend coupling. This
// module imports NOTHING (no THREE / Spin / DOM) on purpose — WidgetMode.js
// wraps computeSpinRemap()'s plain vectors into Spin objects.

// ── tiny 3×3 / vector helpers (row-major matrices; lattices are rows a,b,c) ──

/** @param {number[][]} A @param {number[]} v */
function matVec(A, v) {
  return [
    A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
    A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
    A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
  ];
}

/** @param {number[][]} A */
function transpose(A) {
  return [
    [A[0][0], A[1][0], A[2][0]],
    [A[0][1], A[1][1], A[2][1]],
    [A[0][2], A[1][2], A[2][2]],
  ];
}

/** @param {number[][]} m */
function inverse(m) {
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) return null;
  return [
    [A / det, D / det, G / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det],
  ];
}

/** Fractional (row vector) → Cartesian, with lattice rows a,b,c: x = fa·a+fb·b+fc·c. */
function fracToCart(f, L) {
  return [
    f[0] * L[0][0] + f[1] * L[1][0] + f[2] * L[2][0],
    f[0] * L[0][1] + f[1] * L[1][1] + f[2] * L[2][1],
    f[0] * L[0][2] + f[1] * L[1][2] + f[2] * L[2][2],
  ];
}

/** Cartesian → fractional in lattice L (rows a,b,c): x = L^T·f ⟹ f = (L^T)^-1·x. */
function cartToFrac(x, L) {
  const inv = inverse(transpose(L));
  return inv ? matVec(inv, x) : [0, 0, 0];
}

/** Wrap a fractional component into (-0.5, 0.5]. */
function wrap(v) {
  let r = v - Math.floor(v);
  if (r > 0.5) r -= 1;
  return r;
}

/**
 * Compute the Cartesian moment for every output-cell site by registering the
 * output sites against the input atoms under the rigid rotation R.
 *
 * @param {{
 *   inputFrac:number[][], inputElements:string[], inputLattice:number[][],
 *   inputMoments:number[][],
 *   outputFrac:number[][], outputElements:string[], outputLattice:number[][],
 *   rotation:number[][], tol:number
 * }} p
 * @returns {{ok:boolean, moments?:number[][], reason?:string}}
 */
export function computeSpinRemap(p) {
  const { inputFrac, inputElements, inputLattice, inputMoments,
    outputFrac, outputElements, outputLattice, rotation, tol } = p;

  const Rinv = inverse(rotation);
  if (!Rinv) return { ok: false, reason: 'cell choice unavailable for this structure' };

  // Match tolerance in Å. moyo decided the cells within `symprec`, so a match
  // should sit within a small multiple of it — 2×symprec (0.02 Å at the 0.01
  // default) admits float drift between the two cell descriptions while staying
  // far tighter than a supercell's atom spacing, so a spurious near-match can't
  // register. The 0.01 Å floor keeps a pathologically tiny symprec from
  // rejecting ordinary numerical noise.
  const tolCart = Math.max(0.01, 2 * (tol || 0.01));

  // Cartesian positions and (padded) rotated moments. inputMoments may be
  // shorter than the atom list (a .crysviz with fewer spins than atoms) — index
  // over inputFrac so missing entries read as a zero moment instead of undefined
  // (S3: undefined → NaN would slip through the moment gate and throw later).
  const inCart = inputFrac.map((f) => fracToCart(f, inputLattice));
  const outCart = outputFrac.map((f) => fracToCart(f, outputLattice));
  const rotated = inputFrac.map((_, i) => matVec(rotation, inputMoments[i] || [0, 0, 0]));
  let maxMag = 0;
  for (const m of rotated) maxMag = Math.max(maxMag, Math.hypot(m[0], m[1], m[2]));
  const momTol = 1e-3 * maxMag + 1e-9;

  // Output sites, rotated back into the input orientation, expressed in the
  // input fractional frame: gf_k ≡ x_input_j + s  (mod input lattice).
  const gf = outCart.map((c) => cartToFrac(matVec(Rinv, c), inputLattice));
  const xf = inputFrac; // already fractional in the input lattice

  const distIn = (df) => {
    const c = fracToCart([wrap(df[0]), wrap(df[1]), wrap(df[2])], inputLattice);
    return Math.hypot(c[0], c[1], c[2]);
  };
  const distOut = (df) => {
    const c = fracToCart([wrap(df[0]), wrap(df[1]), wrap(df[2])], outputLattice);
    return Math.hypot(c[0], c[1], c[2]);
  };

  // Candidate global shifts, one per element-matching (output, input) pair,
  // deduplicated. ponytail: O(n²) candidates × O(n²) verify = O(n⁴); fine for
  // the small (<~50-atom) widget cells, revisit if that ever changes.
  const seen = new Set();
  const cands = [];
  for (let k = 0; k < gf.length; k++) {
    for (let j = 0; j < xf.length; j++) {
      if (outputElements[k] !== inputElements[j]) continue;
      const s = [wrap(gf[k][0] - xf[j][0]), wrap(gf[k][1] - xf[j][1]), wrap(gf[k][2] - xf[j][2])];
      const key = s.map((v) => Math.round(v * 1e4)).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push(s);
    }
  }

  // A full-coverage shift alone is NOT enough: a nuclear (non-magnetic)
  // translation t added to the true shift also covers every site while landing
  // the moments on the WRONG sublattice (S1, the AFM/altermagnet case). So each
  // candidate must ALSO be moment-consistent — mapping every input atom (in the
  // output frame, y = R·x + T) onto a site whose assigned moment equals its own.
  // The correct shift is always among the candidates, so if none is consistent
  // the order genuinely can't live in this cell (a magnetic supercell).
  // Note: for EQUAL-SIZE cells this check is partly circular — the fold under a
  // candidate's own T reproduces assign⁻¹ — but that's harmless: an exact wrong
  // shift there is a rigid translation of the whole magnetic crystal (identical
  // physics), and pseudo-shifts are already excluded by the tightened tolCart.
  let anyFullCoverage = false;
  for (const s of cands) {
    const assign = new Array(gf.length).fill(-1);
    let cov = 0;
    for (let k = 0; k < gf.length; k++) {
      let bj = -1, bd = Infinity;
      for (let j = 0; j < xf.length; j++) {
        if (outputElements[k] !== inputElements[j]) continue;
        const d = distIn([gf[k][0] - xf[j][0] - s[0], gf[k][1] - xf[j][1] - s[1], gf[k][2] - xf[j][2] - s[2]]);
        if (d < bd) { bd = d; bj = j; }
      }
      if (bd < tolCart) { assign[k] = bj; cov++; }
    }
    if (cov < gf.length) continue;
    anyFullCoverage = true;

    // Output-frame offset T from the first registered pair.
    let T = [0, 0, 0];
    for (let k = 0; k < assign.length; k++) {
      if (assign[k] >= 0) {
        const rx = matVec(rotation, inCart[assign[k]]);
        T = [outCart[k][0] - rx[0], outCart[k][1] - rx[1], outCart[k][2] - rx[2]];
        break;
      }
    }
    const siteMoment = assign.map((j) => (j >= 0 ? rotated[j] : null));

    let consistent = true;
    for (let j = 0; j < inCart.length && consistent; j++) {
      const rx = matVec(rotation, inCart[j]);
      const yFrac = cartToFrac([rx[0] + T[0], rx[1] + T[1], rx[2] + T[2]], outputLattice);
      let bk = -1, bd = Infinity;
      for (let k = 0; k < outputFrac.length; k++) {
        if (outputElements[k] !== inputElements[j]) continue;
        const d = distOut([yFrac[0] - outputFrac[k][0], yFrac[1] - outputFrac[k][1], yFrac[2] - outputFrac[k][2]]);
        if (d < bd) { bd = d; bk = k; }
      }
      if (bd < tolCart && bk >= 0) {
        const sm = siteMoment[bk];
        if (sm && Math.hypot(rotated[j][0] - sm[0], rotated[j][1] - sm[1], rotated[j][2] - sm[2]) > momTol) {
          consistent = false;
        }
      }
    }

    if (consistent) return { ok: true, moments: assign.map((j) => rotated[j]) };
  }

  // Full nuclear coverage but no moment-consistent shift ⇒ the magnetic order
  // needs a larger cell than the standardised one; no coverage at all ⇒ the
  // geometry simply didn't line up.
  return {
    ok: false,
    reason: anyFullCoverage
      ? 'cell choice unavailable for this magnetic structure'
      : 'cell choice unavailable for this structure',
  };
}
