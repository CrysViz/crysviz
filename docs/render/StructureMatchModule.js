// Do two structures describe the same crystal closely enough to compare their
// geometry atom by atom — experiment vs DFT, before vs after a relaxation —
// and which atom of the second is each atom of the first? For the Selection
// Inspector's comparison (ui/AnalysisPanels/SelectionInspector.js). Pure data.
//
// The heuristic, in order:
//  1. Same composition: the same number of atoms of each element.
//  2. Comparable cells: lengths within 15 %, angles within 10°. Positions are
//     compared in fractional coordinates, so a relaxed cell a few % off, or a
//     slightly sheared one, still matches.
//  3. A one-to-one atom map: by file order when the two element sequences
//     agree (a relaxation keeps the order), and otherwise by the nearest
//     same-element atom after the best rigid shift — a different origin
//     choice — trying each atom of the rarest element as the anchor. Both are
//     scored and the closer one kept. The rigid shift is removed either way.
//  4. Close enough: every atom within `tol` of its partner, where tol is 40 %
//     of the shortest interatomic distance in the first structure, at most
//     1 Å. Below that the partner is unambiguous and each bond of the first
//     structure has exactly one counterpart in the second.
// Displacements are measured in the first structure's cell.

import { cartToFrac, invert3x3, transpose3x3 } from '../math/index.js';

const LENGTH_TOL = 0.15;
const ANGLE_TOL_DEG = 10;
const TOL_FRACTION = 0.4;
const TOL_CAP = 1.0;
// The nearest-atom map costs O(n²) per anchor; beyond this only file order.
const NEAREST_MAX_ATOMS = 1500;
const MAX_ANCHORS = 12;

const wrapHalf = (x) => x - Math.round(x);

function toCart(L, f) {
  return [
    f[0] * L[0][0] + f[1] * L[1][0] + f[2] * L[2][0],
    f[0] * L[0][1] + f[1] * L[1][1] + f[2] * L[2][1],
    f[0] * L[0][2] + f[1] * L[1][2] + f[2] * L[2][2],
  ];
}

const norm = (v) => Math.hypot(v[0], v[1], v[2]);

function cellParams(L) {
  const len = L.map(norm);
  const ang = (u, v, nu, nv) => Math.acos(Math.max(-1, Math.min(1,
    (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)))) * 180 / Math.PI;
  return {
    len,
    ang: [ang(L[1], L[2], len[1], len[2]), ang(L[0], L[2], len[0], len[2]), ang(L[0], L[1], len[0], len[1])],
  };
}

function formula(elements) {
  const counts = new Map();
  for (const e of elements) counts.set(e, (counts.get(e) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([e, n]) => (n > 1 ? `${e}${n}` : e)).join('');
}

/** Mean of fractional offsets per axis, as an angle mean so offsets either
 *  side of 0/1 average to the right place. */
function circularMean(offsets) {
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let s = 0, c = 0;
    for (const d of offsets) { s += Math.sin(2 * Math.PI * d[k]); c += Math.cos(2 * Math.PI * d[k]); }
    out[k] = Math.atan2(s, c) / (2 * Math.PI);
  }
  return out;
}

/** Displacement of every atom from its partner, after removing `shift`. */
function score(fa, fb, map, shift, L) {
  let max = 0, sum2 = 0, worst = -1;
  for (let i = 0; i < fa.length; i++) {
    const g = fb[map[i]];
    const d = norm(toCart(L, [
      wrapHalf(g[0] - fa[i][0] - shift[0]),
      wrapHalf(g[1] - fa[i][1] - shift[1]),
      wrapHalf(g[2] - fa[i][2] - shift[2]),
    ]));
    sum2 += d * d;
    if (d > max) { max = d; worst = i; }
  }
  return { max, rms: Math.sqrt(sum2 / Math.max(1, fa.length)), worst };
}

/** Rigid shift that best overlays the mapped atoms. Atoms that moved further
 *  than `tol` under the first estimate are left out of a second one, so a
 *  single displaced atom neither drags the others off nor hides how far it
 *  moved itself. */
function bestShift(fa, fb, map, L, tol) {
  const offsets = fa.map((f, i) => {
    const g = fb[map[i]];
    return [wrapHalf(g[0] - f[0]), wrapHalf(g[1] - f[1]), wrapHalf(g[2] - f[2])];
  });
  const shift = circularMean(offsets);
  const inliers = offsets.filter((d) => norm(toCart(L, [
    wrapHalf(d[0] - shift[0]), wrapHalf(d[1] - shift[1]), wrapHalf(d[2] - shift[2]),
  ])) <= tol);
  return inliers.length >= offsets.length / 2 && inliers.length < offsets.length ? circularMean(inliers) : shift;
}

/** Nearest same-element partner of each atom under `shift`; null unless one
 *  to one. */
function nearestMap(fa, fb, ea, byElementB, shift, L) {
  const map = new Array(fa.length);
  const taken = new Set();
  for (let i = 0; i < fa.length; i++) {
    let best = -1, bestD = Infinity;
    for (const j of byElementB.get(ea[i]) ?? []) {
      const g = fb[j];
      const d = norm(toCart(L, [
        wrapHalf(g[0] - fa[i][0] - shift[0]),
        wrapHalf(g[1] - fa[i][1] - shift[1]),
        wrapHalf(g[2] - fa[i][2] - shift[2]),
      ]));
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best < 0 || taken.has(best)) return null;
    taken.add(best);
    map[i] = best;
  }
  return map;
}

/** Shortest distance between two atoms of the structure (minimum image). */
function shortestDistance(f, L) {
  const n = f.length;
  if (n > 2000) {
    // Too many pairs to check: estimate from the volume per atom.
    const [a, b, c] = L;
    const vol = Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
    return 0.9 * Math.cbrt(vol / n);
  }
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = norm(toCart(L, [wrapHalf(f[j][0] - f[i][0]), wrapHalf(f[j][1] - f[i][1]), wrapHalf(f[j][2] - f[i][2])]));
      if (d > 1e-3 && d < min) min = d;
    }
  }
  return Number.isFinite(min) ? min : 1;
}

/**
 * @param {any} A the inspected structure (atoms[].position fractional, elements, lattice rows)
 * @param {any} B the structure to compare with
 * @returns {{ ok: boolean, reason: string, map: number[]|null, shift: number[], method: string,
 *   rms: number, max: number, tol: number, worst: number,
 *   cell: { lengthPct: number, angleDeg: number } }}
 */
export function matchStructures(A, B) {
  const out = {
    ok: false, reason: '', map: null, shift: [0, 0, 0], method: '',
    rms: NaN, max: NaN, tol: NaN, worst: -1, cell: { lengthPct: NaN, angleDeg: NaN },
  };
  const ea = A?.elements ?? [], eb = B?.elements ?? [];
  if (!ea.length || !eb.length || !A.lattice || !B.lattice) { out.reason = 'missing structure'; return out; }
  if (ea.length !== eb.length || formula(ea) !== formula(eb)) {
    out.reason = `different composition (${formula(ea)} vs ${formula(eb)})`;
    return out;
  }

  const ca = cellParams(A.lattice), cb = cellParams(B.lattice);
  out.cell.lengthPct = 100 * Math.max(...[0, 1, 2].map((k) => Math.abs(cb.len[k] - ca.len[k]) / ca.len[k]));
  out.cell.angleDeg = Math.max(...[0, 1, 2].map((k) => Math.abs(cb.ang[k] - ca.ang[k])));
  if (out.cell.lengthPct > 100 * LENGTH_TOL || out.cell.angleDeg > ANGLE_TOL_DEG) {
    out.reason = `cells differ too much (${out.cell.lengthPct.toFixed(1)} % in length, ${out.cell.angleDeg.toFixed(1)}° in angle)`;
    return out;
  }

  const L = A.lattice;
  const fa = A.atoms.map((a) => a.position);
  const fb = B.atoms.map((a) => a.position);
  out.tol = Math.min(TOL_CAP, TOL_FRACTION * shortestDistance(fa, L));

  const candidates = [];
  if (ea.every((e, i) => e === eb[i])) {
    const map = ea.map((_, i) => i);
    const shift = bestShift(fa, fb, map, L, out.tol);
    candidates.push({ method: 'file order', map, shift, ...score(fa, fb, map, shift, L) });
  }
  const orderGood = candidates[0] && candidates[0].max <= out.tol;
  if (!orderGood && fa.length <= NEAREST_MAX_ATOMS) {
    const byElementB = new Map();
    eb.forEach((e, j) => { if (!byElementB.has(e)) byElementB.set(e, []); byElementB.get(e).push(j); });
    const counts = new Map();
    for (const e of ea) counts.set(e, (counts.get(e) ?? 0) + 1);
    const rare = [...counts.entries()].sort((x, y) => x[1] - y[1])[0][0];
    const a0 = ea.indexOf(rare);
    for (const b0 of byElementB.get(rare).slice(0, MAX_ANCHORS)) {
      const anchor = [0, 1, 2].map((k) => wrapHalf(fb[b0][k] - fa[a0][k]));
      const map = nearestMap(fa, fb, ea, byElementB, anchor, L);
      if (!map) continue;
      const shift = bestShift(fa, fb, map, L, out.tol);
      candidates.push({ method: 'nearest atom', map, shift, ...score(fa, fb, map, shift, L) });
    }
  }
  if (!candidates.length) {
    out.reason = 'no one-to-one atom match';
    return out;
  }
  const best = candidates.sort((x, y) => x.max - y.max)[0];
  Object.assign(out, { map: best.map, shift: best.shift, method: best.method, rms: best.rms, max: best.max, worst: best.worst });
  if (best.max > out.tol) {
    out.reason = `atoms moved too far (${A.elements[best.worst]}${best.worst + 1} by ${best.max.toFixed(2)} Å, limit ${out.tol.toFixed(2)} Å)`;
    return out;
  }
  out.ok = true;
  return out;
}

/**
 * Where a placed copy of atom `srcIndex` of A (at cartesian `cartA`) sits in B:
 * its partner, in the copy that overlays it.
 * @returns {number[]} cartesian position in B
 */
export function counterpartCart(match, A, B, srcIndex, cartA, latInvA = null) {
  const fA = cartToFrac(cartA, A.lattice, latInvA ?? invert3x3(transpose3x3(A.lattice)));
  const g = B.atoms[match.map[srcIndex]].position;
  const f = [0, 1, 2].map((k) => {
    const target = fA[k] + match.shift[k];
    return g[k] + Math.round(target - g[k]);
  });
  return toCart(B.lattice, f);
}
