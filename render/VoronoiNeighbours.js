import * as THREE from '../external/three/three.module.js';
import { ConvexHull } from '../external/three/ConvexHull.js';
import { invert3x3 } from '../math/index.js';

// Robust, distance-independent coordination-neighbour selection for a single
// central atom, using a (radical) Voronoi/Dirichlet criterion weighted by the
// solid angle each Voronoi face subtends. This keeps elongated coordination
// (long axial bonds stay) and rejects atoms "shadowed" behind the shell (a far
// metal behind the anion cage is not a neighbour), which a nearest-distance rule
// cannot do reliably. See VESTA / pymatgen VoronoiNN / ChemEnv for the method.
//
// Implementation note: the cell is found via the half-space-intersection ↔
// convex-hull duality. With the centre at the origin, each candidate k defines a
// half-space n_k·x ≤ c_k; its dual point is q_k = n_k / c_k. Candidate k is a
// Voronoi neighbour iff q_k is a vertex of conv({q_j}); each hull facet maps to a
// Voronoi-cell vertex (the meeting point of that facet's planes). This reuses the
// vendored ConvexHull instead of hand-rolled polytope clipping.

const FOUR_PI = 4 * Math.PI;

/** Solid angle of a triangle (vectors from the origin) — Van Oosterom–Strackee. */
function triSolidAngle(A, B, C) {
  const la = A.length(), lb = B.length(), lc = C.length();
  if (la < 1e-9 || lb < 1e-9 || lc < 1e-9) return 0;
  const num = Math.abs(A.dot(new THREE.Vector3().crossVectors(B, C)));
  const den = la * lb * lc + A.dot(B) * lc + A.dot(C) * lb + B.dot(C) * la;
  return 2 * Math.atan2(num, den); // atan2 keeps it correct for obtuse (den<0)
}

/** Solid angle of a planar polygon (ordered, vectors from the origin). */
function polygonSolidAngle(poly) {
  let omega = 0;
  for (let i = 1; i + 1 < poly.length; i++) omega += triSolidAngle(poly[0], poly[i], poly[i + 1]);
  return omega;
}

/** Order coplanar points CCW around an axis `n` (for face polygon assembly). */
function orderAroundNormal(verts, n) {
  const uniq = [];
  for (const v of verts) {
    if (!uniq.some(u => u.distanceToSquared(v) < 1e-10)) uniq.push(v);
  }
  if (uniq.length < 3) return uniq;
  const cent = uniq.reduce((acc, v) => acc.add(v.clone()), new THREE.Vector3()).multiplyScalar(1 / uniq.length);
  let u = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  u = u.sub(n.clone().multiplyScalar(n.dot(u))).normalize();
  const w = new THREE.Vector3().crossVectors(n, u);
  return uniq.slice().sort((p, q) => {
    const dp = p.clone().sub(cent), dq = q.clone().sub(cent);
    return Math.atan2(w.dot(dp), u.dot(dp)) - Math.atan2(w.dot(dq), u.dot(dq));
  });
}

/** Intersection point of three planes {n_i·x = c_i}; null if near-singular. */
function intersect3Planes(p0, p1, p2) {
  const M = [
    [p0.n.x, p0.n.y, p0.n.z],
    [p1.n.x, p1.n.y, p1.n.z],
    [p2.n.x, p2.n.y, p2.n.z],
  ];
  let inv;
  try { inv = invert3x3(M); } catch { return null; }
  const c = [p0.c, p1.c, p2.c];
  return new THREE.Vector3(
    inv[0][0] * c[0] + inv[0][1] * c[1] + inv[0][2] * c[2],
    inv[1][0] * c[0] + inv[1][1] * c[1] + inv[1][2] * c[2],
    inv[2][0] * c[0] + inv[2][1] * c[1] + inv[2][2] * c[2],
  );
}

/**
 * Select the coordination neighbours of `center` from `candidates` by radical
 * Voronoi + solid-angle weighting.
 *
 * @param {THREE.Vector3} center
 * @param {Array<{pos:THREE.Vector3, srcJ:number, shift:[number,number,number], elem:string, radius:number, d:number}>} candidates
 *        all nearby atom images (any species) — needed so closer atoms can shadow farther ones.
 * @param {{radical?:boolean, relMin?:number, absMin?:number, centerRadius?:number, accept?:(cand:any)=>boolean}} [opts]
 *        radical: use power/radical planes from atomic radii (default true);
 *        relMin: keep faces with solid angle ≥ relMin × largest *accepted* face (default 0.10);
 *        absMin: also require solid angle / 4π ≥ absMin (default 0);
 *        centerRadius: radius of the central atom (for radical planes);
 *        accept: chemical/cutoff filter deciding which candidates may be vertices.
 *          The cell is always built from ALL candidates (so shadowing is correct),
 *          but only accepted faces become vertices and set the solid-angle scale —
 *          this keeps a cation's large face from suppressing the real ligand faces.
 * @returns {Array<{cand:any, solidAngle:number}>} accepted neighbours with their face solid angle.
 */
export function voronoiNeighbours(center, candidates, opts = {}) {
  const radical = opts.radical !== false;
  const relMin = opts.relMin ?? 0.10;
  const absMin = opts.absMin ?? 0.0;
  const rc = opts.centerRadius ?? 1.0;
  const accept = opts.accept ?? (() => true);

  // Half-space n_k·x ≤ c_k per candidate, in the centre-origin frame.
  /** @type {Array<{n:THREE.Vector3, c:number, k:number}>} */
  const planes = [];
  for (let k = 0; k < candidates.length; k++) {
    const rel = candidates[k].pos.clone().sub(center);
    const d = rel.length();
    if (d < 1e-6) continue;
    const n = rel.multiplyScalar(1 / d);
    let c = d / 2;
    if (radical) {
      const rk = candidates[k].radius || 1.0;
      c = (d * d + rc * rc - rk * rk) / (2 * d); // radical (power) plane offset
    }
    if (c <= 1e-6) continue; // centre not on its own side (overlap) — ignore
    planes.push({ n, c, k });
  }
  if (planes.length < 4) return [];

  // Dual points q_k = n_k / c_k; convex hull → which half-spaces form facets.
  const dualPts = planes.map(p => p.n.clone().multiplyScalar(1 / p.c));
  /** @type {Map<THREE.Vector3, number>} dual point → planes[] index */
  const ptToPlane = new Map();
  dualPts.forEach((q, idx) => ptToPlane.set(q, idx));

  let hull;
  try { hull = new ConvexHull().setFromPoints(dualPts); } catch { return []; }

  // Each hull facet ↔ a Voronoi-cell vertex (meeting of that facet's planes);
  // gather the cell vertices incident to each neighbour plane.
  /** @type {Map<number, THREE.Vector3[]>} */
  const cellVertsByPlane = new Map();
  for (const face of hull.faces) {
    const planeIdxs = [];
    let edge = face.edge;
    do {
      const idx = ptToPlane.get(edge.head().point);
      if (idx !== undefined) planeIdxs.push(idx);
      edge = edge.next;
    } while (edge !== face.edge);
    if (planeIdxs.length < 3) continue;
    const v = intersect3Planes(planes[planeIdxs[0]], planes[planeIdxs[1]], planes[planeIdxs[2]]);
    if (!v) continue;
    for (const idx of planeIdxs) {
      if (!cellVertsByPlane.has(idx)) cellVertsByPlane.set(idx, []);
      cellVertsByPlane.get(idx).push(v);
    }
  }

  // Solid angle per neighbour face. Only candidates passing `accept` are eligible
  // to be vertices, and only those set the solid-angle scale (so e.g. a cation's
  // large Voronoi face cannot suppress the genuine anion faces of the shell).
  const weighed = [];
  let maxOmega = 0;
  for (const [idx, verts] of cellVertsByPlane) {
    if (verts.length < 3) continue;
    const cand = candidates[planes[idx].k];
    if (!accept(cand)) continue;
    const omega = polygonSolidAngle(orderAroundNormal(verts, planes[idx].n));
    if (omega <= 0) continue;
    weighed.push({ cand, omega });
    if (omega > maxOmega) maxOmega = omega;
  }
  if (maxOmega <= 0) return [];

  const accepted = [];
  for (const r of weighed) {
    if (r.omega >= relMin * maxOmega && r.omega / FOUR_PI >= absMin) {
      accepted.push({ cand: r.cand, solidAngle: r.omega });
    }
  }
  return accepted;
}
