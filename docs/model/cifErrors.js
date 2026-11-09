// "CIF errors" at run time: the standard uncertainty (s.u.) of a distance or
// an angle measured in a structure read from a CIF with its errors
// (io/cif/cif_errors.js builds the record, ui/CifSymmetryLoad.js asks whether
// to read it), and the crystallographic way of writing a value with its s.u.:
// 2.3456(12) Å, 109.47(3)°.
//
// Propagation is first order, through the parameters the file refines: the
// six cell parameters and the three fractional coordinates of every site
// involved, each with the s.u. the file gives and no covariances (a CIF does
// not carry them) — the same approximation crystallographic programs make
// without the variance–covariance matrix. Going through the SITE parameters
// rather than per-atom coordinates keeps symmetry copies of one site
// correlated: the bond between an atom and its own inversion image moves both
// ends at once. The derivatives are central differences, so any measurement
// written as a function of Cartesian positions gets an s.u. the same way.
//
// An atom keeps its error only while it is still where the CIF put it (within
// the precision the file gives — so symmetrising, which moves atoms by less
// than that, keeps them), and the cell only while its parameters are the
// file's. Moving, adding or replacing atoms, a strained cell, a relaxation:
// the measurement simply has no error any more, rather than a wrong one.
//
// A supercell keeps them: the record's `toCif` matrix takes the current cell's
// fractional coordinates to the CIF cell's (f_cif = f · toCif, so the current
// lattice is toCif · L_cif), and every copy of an atom keeps its site
// (ui/SuperCellModule.js). Without `toCif` the cell is the CIF's own.
//
// Pure functions of the structure: no app state. Callers decide whether the
// errors are shown (general.showCifErrors, the Features window's toggle).

/** Read errors, not just offered ones. */
export function hasCifErrors(structure) {
  return !!structure?.cifErrors && !structure.cifErrors.pending;
}

/** The load dialog said yes: the errors count from now on. */
export function acceptCifErrors(structure) {
  if (structure?.cifErrors) structure.cifErrors.pending = false;
}

/** The load dialog said no (or nobody asked): drop the record and the
 *  per-atom site references. */
export function discardCifErrors(structure) {
  if (!structure) return;
  structure.cifErrors = null;
  for (const atom of structure.atoms ?? []) {
    if (atom?.cifSite) atom.cifSite = null;
  }
}

// ---- small geometry --------------------------------------------------------

const DEG = Math.PI / 180;

/** Lattice rows from cell parameters (Å, degrees), a along x and b in the xy
 *  plane — the same construction the CIF reader uses. */
function basisFromCell([a, b, c, alpha, beta, gamma]) {
  const ca = Math.cos(alpha * DEG), cb = Math.cos(beta * DEG), cg = Math.cos(gamma * DEG);
  const sg = Math.sin(gamma * DEG);
  const cx = c * cb;
  const cy = c * (ca - cb * cg) / (Math.abs(sg) > 1e-12 ? sg : 1);
  const cz = Math.sqrt(Math.max(c * c - cx * cx - cy * cy, 0));
  return [[a, 0, 0], [b * cg, b * sg, 0], [cx, cy, cz]];
}

function cart(f, L) {
  return [0, 1, 2].map((i) => f[0] * L[0][i] + f[1] * L[1][i] + f[2] * L[2][i]);
}

const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];

/** The cell parameters of a lattice (rows a, b, c). */
export function cellParameters(L) {
  const [va, vb, vc] = L;
  const a = norm(va), b = norm(vb), c = norm(vc);
  const ang = (p, q, np, nq) => Math.acos(Math.max(-1, Math.min(1,
    (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / (np * nq)))) / DEG;
  return [a, b, c, ang(vb, vc, b, c), ang(va, vc, a, c), ang(va, vb, a, b)];
}

/** Row vector f times 3×3 M. */
function rowTimes(f, M) {
  return [0, 1, 2].map((j) => f[0] * M[0][j] + f[1] * M[1][j] + f[2] * M[2][j]);
}

function inverse3(M) {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/** Current fractional coordinates → the CIF cell's. */
function toCifFrac(rec, f) {
  return rec?.toCif ? rowTimes(f, rec.toCif) : f;
}

/** Fractional coordinates of a Cartesian point. */
function toFrac(p, L) {
  // Solve f · L = p for the row vector f (L rows are the lattice vectors).
  const inv = inverse3(L);
  return inv ? rowTimes(p, inv) : null;
}

// ---- is it still the CIF's structure? -------------------------------------

/** How far a number may drift before it is no longer the file's: its s.u.,
 *  or half the last digit written when the file gives none (capped, so a
 *  "90" or "0.5" does not excuse a real edit). */
function slack(su, resolution, cap) {
  return Math.max(su > 0 ? su : 0, Math.min((resolution ?? 0) / 2, cap));
}

/** True while the structure's cell is still the one the CIF gives (or a
 *  supercell of it, through `toCif`). */
export function cellMatchesCif(structure) {
  const rec = structure?.cifErrors?.cell;
  let L = structure?.lattice;
  if (!rec || !Array.isArray(L) || L.length !== 3) return false;
  const toCif = structure.cifErrors.toCif;
  if (toCif) {
    // current lattice = toCif · L_cif
    const inv = inverse3(toCif);
    if (!inv) return false;
    L = [0, 1, 2].map((i) => rowTimes(inv[i], L));
  }
  const now = cellParameters(L);
  return now.every((v, k) => {
    const want = rec.values[k];
    const tol = slack(rec.su[k], rec.resolution[k], 1e-4 * Math.abs(want)) + 1e-9 * Math.max(1, Math.abs(want));
    return Number.isFinite(v) && Math.abs(v - want) <= tol;
  });
}

/** The atom's site reference while it is still where the CIF put it (up to a
 *  lattice translation), else null. */
export function atomCifSite(structure, atomIndex) {
  const atom = structure?.atoms?.[atomIndex];
  const ref = atom?.cifSite;
  const site = ref ? structure.cifErrors?.sites?.[ref.site] : null;
  if (!site || !Array.isArray(atom.position)) return null;
  const f = toCifFrac(structure.cifErrors, atom.position);
  for (let i = 0; i < 3; i++) {
    let d = f[i] - ref.frac[i];
    d -= Math.round(d);
    let tol = 1e-6;
    for (let j = 0; j < 3; j++) tol += Math.abs(ref.R[i][j]) * slack(site.su[j], site.resolution[j], 1e-3);
    if (!(Math.abs(d) <= tol)) return null;
  }
  return ref;
}

// ---- propagation -----------------------------------------------------------

/**
 * The s.u. of `fn` over the given atoms, or null when the structure has no
 * read errors, its cell is no longer the CIF's, or any atom has moved or did
 * not come from the CIF. 0 when nothing involved has an s.u. (an angle fixed
 * by symmetry, say).
 *
 * @param {any} structure
 * @param {Array<{atomIndex:number, frac:number[]}>} points the atoms as measured,
 *   at the fractional coordinates (of the structure's current cell) of the
 *   copies used, lattice translation included
 * @param {(cart:number[][]) => number} fn the measurement, from the points' Cartesian positions
 * @returns {number|null}
 */
export function propagateSu(structure, points, fn) {
  if (!hasCifErrors(structure) || !points.length || !cellMatchesCif(structure)) return null;
  const { cell, sites } = structure.cifErrors;
  const refs = points.map((p) => atomCifSite(structure, p.atomIndex));
  if (refs.some((r) => !r) || points.some((p) => !Array.isArray(p.frac) || p.frac.some((v) => !Number.isFinite(v)))) return null;

  const evaluate = (params, fracs) => {
    const L = basisFromCell(params);
    return fn(fracs.map((f) => cart(f, L)));
  };
  // Everything below works in the CIF's own cell, with its own parameters.
  const fracs = points.map((p) => toCifFrac(structure.cifErrors, p.frac));
  let variance = 0;

  const h = 1e-6;
  // Each free parameter of each site (its coordinates, or fewer on a special
  // position: siteDirections): moving it moves every copy of the site, each
  // through the rotation of the operation that made it.
  const siteIds = [...new Set(refs.map((r) => r.site))];
  for (const s of siteIds) {
    for (const { d, su: sigma } of siteDirections(sites[s])) {
      const shifted = (sign) => fracs.map((f, k) => {
        if (refs[k].site !== s) return f;
        const Rd = rowTimes(d, transpose(refs[k].R)); // R · d
        return f.map((v, i) => v + sign * h * Rd[i]);
      });
      const dfdt = (evaluate(cell.values, shifted(1)) - evaluate(cell.values, shifted(-1))) / (2 * h);
      variance += (dfdt * sigma) ** 2;
    }
  }
  // Each free cell parameter (a = b tied in a hexagonal cell, say:
  // cellDirections), at fixed fractional coordinates.
  for (const { d, su: sigma } of cellDirections(cell)) {
    const at = (sign) => cell.values.map((v, m) => v + sign * h * d[m]);
    const dfdt = (evaluate(at(1), fracs) - evaluate(at(-1), fracs)) / (2 * h);
    variance += (dfdt * sigma) ** 2;
  }
  return Number.isFinite(variance) ? Math.sqrt(variance) : null;
}

// ---- free parameters: special positions and symmetry-tied cells ----------
//
// A CIF lists every coordinate and cell parameter with its own s.u., but
// symmetry ties some of them: an atom at (x, 2x, z) has one parameter for x
// and y, and a hexagonal cell has a = b. Moving them one at a time would move
// the atom off its special position or break the cell's symmetry, so the
// error is propagated through the free parameters only — what a refinement
// program does with "correlations defined by crystal symmetry". Each free
// parameter is a direction in coordinate (or cell-parameter) space with the
// s.u. of its most precisely written component. On a general position and a
// triclinic or monoclinic cell this is the coordinates and parameters one by
// one, exactly as before.

const transpose = (M) => [0, 1, 2].map((i) => [M[0][i], M[1][i], M[2][i]]);
const unitDirections = (su, n) => Array.from({ length: n }, (_, k) => k)
  .filter((k) => su[k] > 0)
  .map((k) => ({ d: Array.from({ length: n }, (_, m) => (m === k ? 1 : 0)), su: su[k] }));

/** A site's free directions (fractional), each with its s.u. */
function siteDirections(site) {
  return Array.isArray(site.dirs) ? site.dirs : unitDirections(site.su, 3);
}

/** The cell's free directions (in a, b, c, α, β, γ), each with its s.u. */
function cellDirections(cell) {
  return Array.isArray(cell.dirs) ? cell.dirs : unitDirections(cell.su, 6);
}

/**
 * Independent directions from candidate vectors (one per parameter, already
 * projected onto what symmetry allows), each with an s.u.: that of its most
 * precisely written component, scaled to the direction's length along it.
 * Candidates are taken most precise first, so a dependent coordinate written
 * with a rounder s.u. never sets the error.
 * @param {number[][]} candidates
 * @param {number[]} su
 */
function independentDirections(candidates, su) {
  const order = candidates.map((_, k) => k).filter((k) => su[k] > 0).sort((p, q) => su[p] - su[q]);
  const basis = [];
  const dirs = [];
  for (const k of order) {
    const d = candidates[k];
    const size = Math.hypot(...d);
    if (!(size > 1e-9)) continue;
    let r = [...d];
    for (const q of basis) {
      const dot = r.reduce((acc, v, i) => acc + v * q[i], 0);
      r = r.map((v, i) => v - dot * q[i]);
    }
    const rest = Math.hypot(...r);
    if (rest < 1e-6 * size) continue; // a multiple of a direction already taken
    basis.push(r.map((v) => v / rest));
    let sigma = Infinity;
    d.forEach((v, i) => { if (Math.abs(v) > 1e-6 * size && su[i] > 0) sigma = Math.min(sigma, su[i] / Math.abs(v)); });
    if (Number.isFinite(sigma)) dirs.push({ d, su: sigma });
  }
  return dirs;
}

/**
 * The free directions of a site at fractional position `x` under the space
 * group's operations: the rotations of the operations that leave it in place
 * (up to a lattice translation) average to the projector onto the
 * displacements its site symmetry allows.
 * @param {number[]} x site position
 * @param {number[]} su s.u. of x, y, z (0 where none)
 * @param {Array<[number[][], number[]]>} ops (R, t), fractional
 * @param {number|null} [order] the CIF's _atom_site_site_symmetry_order, if given
 * @returns {Array<{d:number[], su:number}>}
 */
export function freeSiteDirections(x, su, ops, order = null) {
  if (!Array.isArray(ops) || ops.length < 2 || order === 1) return unitDirections(su, 3);
  // A coordinate is on the symmetry element when the image is within its
  // written precision (2σ of the difference, or 1e-4 for an exact number).
  const fixing = ops.filter(([R, t]) => [0, 1, 2].every((i) => {
    let d = R[i][0] * x[0] + R[i][1] * x[1] + R[i][2] * x[2] + t[i] - x[i];
    d -= Math.round(d);
    let s2 = su[i] ** 2;
    for (let j = 0; j < 3; j++) s2 += (R[i][j] * su[j]) ** 2;
    return Math.abs(d) <= Math.max(1e-4, 2 * Math.sqrt(s2));
  }));
  if (fixing.length < 2) return unitDirections(su, 3);
  const P = [0, 1, 2].map((i) => [0, 1, 2].map((j) => fixing.reduce((acc, [R]) => acc + R[i][j], 0) / fixing.length));
  return independentDirections([0, 1, 2].map((j) => [P[0][j], P[1][j], P[2][j]]), su);
}

/**
 * The free directions of the cell parameters under the point group of the
 * space-group operations: a perturbation of one parameter, symmetrised over
 * the metric (G' = mean of Rᵀ G R), says which parameters move with it.
 * @param {number[]} values a, b, c, α, β, γ
 * @param {number[]} su their s.u.s
 * @param {number[][][]} rotations the operations' rotation parts
 * @returns {Array<{d:number[], su:number}>}
 */
export function freeCellDirections(values, su, rotations) {
  if (!Array.isArray(rotations) || rotations.length < 2) return unitDirections(su, 6);
  const metric = (p) => {
    const L = basisFromCell(p);
    return [0, 1, 2].map((i) => [0, 1, 2].map((j) => L[i][0] * L[j][0] + L[i][1] * L[j][1] + L[i][2] * L[j][2]));
  };
  const params = (G) => {
    const [a, b, c] = [Math.sqrt(G[0][0]), Math.sqrt(G[1][1]), Math.sqrt(G[2][2])];
    const ang = (g, p, q) => Math.acos(Math.max(-1, Math.min(1, g / (p * q)))) / DEG;
    return [a, b, c, ang(G[1][2], b, c), ang(G[0][2], a, c), ang(G[0][1], a, b)];
  };
  const G0 = metric(values);
  const candidates = values.map((_, k) => {
    const h = 1e-6 * Math.max(1, Math.abs(values[k]));
    const dG = metric(values.map((v, m) => (m === k ? v + h : v))).map((row, i) => row.map((v, j) => v - G0[i][j]));
    const sym = [0, 1, 2].map(() => [0, 0, 0]);
    for (const R of rotations) {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let acc = 0;
        for (let m = 0; m < 3; m++) for (let n = 0; n < 3; n++) acc += R[m][i] * dG[m][n] * R[n][j];
        sym[i][j] += acc / rotations.length;
      }
    }
    const moved = params(G0.map((row, i) => row.map((v, j) => v + sym[i][j])));
    return moved.map((v, m) => {
      const dv = (v - values[m]) / h;
      return Math.abs(dv) < 1e-6 ? 0 : dv;
    });
  });
  return independentDirections(candidates, su);
}

/** Distance between Cartesian points 0 and 1. */
export const distanceOf = (P) => norm(sub(P[1], P[0]));

/** Angle at point 1 between points 0 and 2, in degrees. */
export function angleOf(P) {
  const u = sub(P[0], P[1]), v = sub(P[2], P[1]);
  const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (norm(u) * norm(v));
  return Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
}

/** s.u. of the distance between two atoms (measurement refs: atom index and
 *  the fractional position of the copy measured). */
export function distanceSu(structure, a, b) {
  return propagateSu(structure, [a, b], distanceOf);
}

/** s.u. of the angle a–vertex–c. */
export function angleSu(structure, a, vertex, c) {
  return propagateSu(structure, [a, vertex, c], angleOf);
}

/**
 * The s.u. of any value computed from placed atoms (Cartesian positions of
 * the copies shown, with their source atom), or null when an atom has no
 * error. `fn` gets the atoms' Cartesian positions in the same order. This is
 * how a derived value — a mean, a volume, a distortion index — gets its error
 * through exactly the maths that computes it.
 * @param {any} structure
 * @param {Array<{srcIndex?:number|null, pos:number[]}>} atoms
 * @param {(cart:number[][]) => number|null} fn
 * @returns {number|null}
 */
export function placedSu(structure, atoms, fn) {
  if (!hasCifErrors(structure) || !atoms.length) return null;
  const L = structure.lattice;
  const points = atoms.map((a) => (Number.isInteger(a.srcIndex) && a.pos
    ? { atomIndex: a.srcIndex, frac: toFrac(a.pos, L) } : null));
  if (points.some((p) => !p || !p.frac)) return null;
  return propagateSu(structure, points, (P) => {
    const v = fn(P);
    return Number.isFinite(v) ? v : NaN;
  });
}

/**
 * s.u.s for a mini-view model (the Selection and Polyhedron Inspectors):
 * atoms placed at Cartesian positions, bonds between two of them, angles at
 * one between two others. Entries are null where there is no error.
 *
 * @param {any} structure
 * @param {Array<{srcIndex?:number|null, pos:number[]}>} atoms
 * @param {Array<{a:number, b:number}>} bonds
 * @param {Array<{at:number, i:number, j:number}>} angles
 * @returns {{ bonds: Array<number|null>, angles: Array<number|null>, meanBond: number|null, any: boolean } | null}
 */
export function modelErrors(structure, atoms, bonds, angles) {
  if (!hasCifErrors(structure) || !cellMatchesCif(structure)) return null;
  const L = structure.lattice;
  const points = atoms.map((a) => (Number.isInteger(a.srcIndex) && a.pos
    ? { atomIndex: a.srcIndex, frac: toFrac(a.pos, L) } : null));
  const pick = (idx) => (idx.every((i) => points[i]) ? idx.map((i) => points[i]) : null);
  const bondSu = bonds.map((b) => {
    const p = pick([b.a, b.b]);
    return p ? propagateSu(structure, p, distanceOf) : null;
  });
  const angleSus = angles.map((g) => {
    const p = pick([g.i, g.at, g.j]);
    return p ? propagateSu(structure, p, angleOf) : null;
  });
  // The mean bond length is one more function of the same parameters: its
  // s.u. counts a site shared by several bonds once, correlated.
  let meanBond = null;
  if (bonds.length && bondSu.every((s) => s != null)) {
    // Only the atoms the bonds use: an unbonded atom without an error must
    // not take the mean's error away.
    const used = [...new Set(bonds.flatMap((b) => [b.a, b.b]))];
    const slot = new Map(used.map((i, k) => [i, k]));
    meanBond = placedSu(structure, used.map((i) => atoms[i]),
      (P) => bonds.reduce((sum, b) => sum + distanceOf([P[slot.get(b.a)], P[slot.get(b.b)]]), 0) / bonds.length);
  }
  const any = [...bondSu, ...angleSus].some((s) => s > 0);
  return { bonds: bondSu, angles: angleSus, meanBond, any };
}

// ---- writing a value with its s.u. -----------------------------------------

/**
 * A value with its s.u. in parentheses, as crystallographers write it: the
 * s.u. to one significant digit, or two when they start with 1 (the "rule of
 * 19": 0.0012 is written (12), 0.003 is (3)), and the value to the same last
 * digit. Without an s.u. (null or 0) the value is written to `digits`
 * decimals, as it would be without errors.
 *
 * @param {number} value
 * @param {number|null|undefined} su
 * @param {number} digits decimals when there is no s.u.
 * @returns {string}
 */
export function formatWithSu(value, su, digits) {
  if (!Number.isFinite(value)) return '—';
  if (!(Number.isFinite(su) && su > 0)) return value.toFixed(digits);
  const e = Math.floor(Math.log10(su));
  let decimals = 1 - e;                              // two significant digits
  let n = Math.round(su * 10 ** decimals);
  if (n > 19) { decimals = -e; n = Math.round(su * 10 ** decimals); }
  if (decimals < 0) { decimals = 0; n = Math.round(su); }
  if (decimals > 8) { decimals = 8; n = Math.max(1, Math.round(su * 1e8)); }
  return `${value.toFixed(decimals)}(${n})`;
}

// ---- saving with a session (.crysviz file, share link) ----------------------

/**
 * The read errors as a compact JSON record for a saved session, or null.
 * Per atom, aligned with structure.atoms: null for an atom without an error
 * (moved, added), else [site, rotation index], plus the offset from where the
 * atom now is to where the CIF puts it when that is not exactly zero — so a
 * restore that rebuilds the atoms from their positions gets every reference
 * back. Sites keep only what the propagation reads.
 * @param {any} structure
 */
export function serializeCifErrors(structure) {
  if (!hasCifErrors(structure)) return null;
  const rec = structure.cifErrors;
  const rotations = [];
  const rotationIndex = new Map();
  const atoms = (structure.atoms ?? []).map((atom, i) => {
    const ref = atomCifSite(structure, i);
    if (!ref) return null;
    const key = JSON.stringify(ref.R);
    if (!rotationIndex.has(key)) {
      rotationIndex.set(key, rotations.length);
      rotations.push(ref.R.map((row) => [...row]));
    }
    const entry = [ref.site, rotationIndex.get(key)];
    const f = toCifFrac(rec, atom.position);
    const offset = ref.frac.map((v, k) => { const d = v - f[k]; return d - Math.round(d); });
    if (offset.some((d) => Math.abs(d) > 1e-9)) entry.push(...offset.map((d) => Number(d.toPrecision(6))));
    return entry;
  });
  if (!atoms.some(Boolean)) return null;
  return {
    cell: {
      values: [...rec.cell.values], su: [...rec.cell.su], resolution: [...rec.cell.resolution],
      ...(rec.cell.dirs ? { dirs: rec.cell.dirs } : {}),
    },
    sites: rec.sites.map((site) => ({
      label: site.label, su: [...site.su], resolution: [...site.resolution],
      ...(site.dirs ? { dirs: site.dirs } : {}),
    })),
    rotations,
    atoms,
    ...(rec.toCif ? { toCif: rec.toCif.map((row) => [...row]) } : {}),
  };
}

/**
 * Put saved errors (serializeCifErrors) back on a restored structure whose
 * atoms are in the saved order. Read, not offered: the user read them before
 * saving. Returns whether anything was restored; a record that does not fit
 * the structure (atom count, sites) is ignored.
 * @param {any} structure
 * @param {any} saved
 */
export function restoreCifErrors(structure, saved) {
  const atoms = structure?.atoms;
  if (!saved || !Array.isArray(atoms) || !Array.isArray(saved.atoms) || saved.atoms.length !== atoms.length) return false;
  const sites = saved.sites;
  const rotations = saved.rotations;
  if (!Array.isArray(sites) || !Array.isArray(rotations) || !Array.isArray(saved.cell?.values)) return false;
  const rec = {
    cell: saved.cell,
    sites,
    pending: false,
    ...(Array.isArray(saved.toCif) ? { toCif: saved.toCif } : {}),
  };
  let restored = 0;
  atoms.forEach((atom, i) => {
    const entry = saved.atoms[i];
    const R = Array.isArray(entry) ? rotations[entry[1]] : null;
    if (!R || !sites[entry[0]] || !Array.isArray(atom?.position)) return;
    const f = toCifFrac(rec, atom.position);
    const offset = entry.length >= 5 ? entry.slice(2, 5) : [0, 0, 0];
    atom.cifSite = { site: entry[0], R, frac: f.map((v, k) => v + offset[k]) };
    restored++;
  });
  if (!restored) return false;
  structure.cifErrors = rec;
  return true;
}
