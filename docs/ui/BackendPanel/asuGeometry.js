// asuGeometry.js
//
// The real-space asymmetric unit of a space group - the "irreducible wedge" -
// turned from its textbook inequality list into a polyhedron ready to draw.
//
// data/symmetry_basics.json describes the asymmetric unit of all 530 Hall
// settings as a list of half-space "cuts", each with an integer/fraction
// `normal` and `const` under the convention
//
//     normal . r + const >= 0            (r fractional, conventional cell)
//
// so `x>=0` is normal [1,0,0] const 0, and `x+z<=1/2` is normal [-1,0,-1]
// const 1/2. Intersecting them gives the wedge. Every setting is bounded and
// has 4-9 faces, so the vertex-enumeration below (all plane triples, keep the
// feasible ones) is both exact and trivially cheap - no hull library needed.
//
// Two entries per setting exist and only one is drawable:
//
//   asu.cuts             the full asymmetric unit. Its cuts carry `condition`
//                        clauses ("x<=1/2 [y<=0]") whose whole job is to hand
//                        a shared BOUNDARY face to exactly one of the copies
//                        that meet there. That makes the region non-convex,
//                        and the difference is a measure-zero surface - it has
//                        no visible extent at any zoom.
//   asu.shape_only_cuts  the same body with those clauses dropped: a convex
//                        polyhedron of exactly the right volume. This is the
//                        one that gets rendered; `asu_str` stays as the label.
//
// All the combinatorics here run in FRACTIONAL space, never Cartesian. That is
// deliberate and it is exact: which vertices lie on which face is an affine
// property, so it survives the fractional -> Cartesian map unchanged. Callers
// transform the finished vertices through the conventional lattice. It also
// means `polyhedronVolume` comes out directly as a fraction of the unit cell.

import { getSpaceGroupEntryByHallNumber } from '../addToStructureModule/WyckoffProjector.js';

// Fractional-space distance below which a point counts as "on" a plane or as a
// duplicate of another vertex. The inputs are exact small fractions and each
// vertex costs one 3x3 solve, so the error here is a few ULP; these are loose
// by orders of magnitude and still nowhere near merging distinct vertices
// (the closest distinct pair across all 530 settings is 1/12 apart).
const ON_PLANE_TOL = 1e-9;
const MERGE_TOL = 1e-7;

// Three unit normals whose determinant is smaller than this are treated as
// meeting in a line or not at all rather than a point. A shallow-but-real
// corner stays well above it; anything below produces a point so far outside
// the cell that the feasibility test rejects it anyway.
const DET_EPS = 1e-9;

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scaled(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function length(a) { return Math.hypot(a[0], a[1], a[2]); }

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// The dataset writes normals and offsets as exact fractions ("1/2", "-1/3"),
// so they need parsing rather than a plain Number().
function parseFraction(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  if (text.includes('/')) {
    const [num, den] = text.split('/').map(Number);
    return den ? num / den : 0;
  }
  return Number(text) || 0;
}

/**
 * Normalise a cut list into unit-normal half-spaces.
 *
 * Dividing through by |normal| costs nothing and buys a lot: every later test
 * becomes a signed DISTANCE, so one tolerance is meaningful for all of them
 * regardless of whether a cut came in as `x>=0` or `-x-z+1/2>=0`.
 *
 * @param {Array<object>} cuts `asu.shape_only_cuts` (or `asu.cuts`)
 * @returns {Array<{normal: number[], offset: number, label: string}>}
 */
export function halfSpacesFromCuts(cuts) {
  const halfSpaces = [];

  for (const cut of cuts ?? []) {
    const raw = (cut?.normal ?? []).map(parseFraction);
    const len = length(raw);
    if (!(len > 0)) continue; // a zero normal is not a plane

    const candidate = {
      normal: scaled(raw, 1 / len),
      offset: parseFraction(cut.const) / len,
      label: String(cut.xyz ?? ''),
    };

    // A repeated cut would otherwise emit the same face twice, giving the mesh
    // coincident faces and the edge list duplicate lines.
    const repeat = halfSpaces.some((h) => (
      Math.abs(h.offset - candidate.offset) <= MERGE_TOL
      && length(sub(h.normal, candidate.normal)) <= MERGE_TOL
    ));
    if (!repeat) halfSpaces.push(candidate);
  }

  return halfSpaces;
}

// The single point on all three planes, or null when they do not meet in one.
// Cramer's rule: with n_i . r = -offset_i,
//   r = -(o1 (b x c) + o2 (c x a) + o3 (a x b)) / det[a b c]
function intersectThreePlanes(h1, h2, h3) {
  const a = h1.normal;
  const b = h2.normal;
  const c = h3.normal;

  const bc = cross(b, c);
  const det = dot(a, bc);
  if (Math.abs(det) < DET_EPS) return null;

  const ca = cross(c, a);
  const ab = cross(a, b);
  const s = -1 / det;

  return [
    s * (h1.offset * bc[0] + h2.offset * ca[0] + h3.offset * ab[0]),
    s * (h1.offset * bc[1] + h2.offset * ca[1] + h3.offset * ab[1]),
    s * (h1.offset * bc[2] + h2.offset * ca[2] + h3.offset * ab[2]),
  ];
}

// Cyclic order of one face's vertices, wound counter-clockwise as seen from
// OUTSIDE the body - the front-facing direction three.js expects.
//
// The interior satisfies normal . r + offset >= 0, so it lies on the +normal
// side of the face and the outward direction is -normal.
//
// Sorting by angle in a fractional-space basis is safe for the same reason the
// rest of this module works there: an affine map preserves the cyclic order of
// a convex polygon's vertices, so the loop is the same loop after the lattice
// transform, even though the individual angles are not.
function orderFaceLoop(ring, vertices, normal) {
  const centroid = [0, 0, 0];
  for (const index of ring) {
    centroid[0] += vertices[index][0];
    centroid[1] += vertices[index][1];
    centroid[2] += vertices[index][2];
  }
  const inv = 1 / ring.length;
  centroid[0] *= inv;
  centroid[1] *= inv;
  centroid[2] *= inv;

  const outward = scaled(normal, -1);
  // Both axes lie in the face: `u` joins two of its points, and `w` is
  // perpendicular to u within the plane.
  const spoke = sub(vertices[ring[0]], centroid);
  const u = scaled(spoke, 1 / length(spoke));
  const w = cross(outward, u);

  return ring
    .map((index) => {
      const d = sub(vertices[index], centroid);
      return { index, angle: Math.atan2(dot(d, w), dot(d, u)) };
    })
    .sort((p, q) => p.angle - q.angle)
    .map((p) => p.index);
}

/**
 * Intersect half-spaces into a polyhedron.
 *
 * @param {Array<{normal: number[], offset: number, label?: string}>} halfSpaces
 * @returns {{vertices: number[][], faces: Array<{loop: number[], normal: number[], label: string}>,
 *            triangles: number[][], edges: number[][]}}
 *   `vertices` are fractional coordinates; `triangles` and `edges` index into
 *   them. An empty vertex list means the half-spaces enclose nothing.
 */
export function polyhedronFromHalfSpaces(halfSpaces) {
  const count = halfSpaces.length;
  const vertices = [];

  const isInside = (p) => halfSpaces.every(
    (h) => dot(h.normal, p) + h.offset >= -ON_PLANE_TOL
  );

  // Every corner of a half-space intersection is the meeting point of three of
  // its planes, so enumerating triples finds all of them. 9 planes is 84
  // triples at worst.
  for (let i = 0; i < count - 2; i += 1) {
    for (let j = i + 1; j < count - 1; j += 1) {
      for (let k = j + 1; k < count; k += 1) {
        const point = intersectThreePlanes(halfSpaces[i], halfSpaces[j], halfSpaces[k]);
        // Triples also meet OUTSIDE the body (three of a cube's planes meet at
        // a corner it does not have); isInside is what keeps only real corners.
        if (!point || !isInside(point)) continue;
        // A corner where four or more planes meet - every ASU with a pyramid
        // apex has one - is found once per triple through it.
        const known = vertices.some((v) => length(sub(v, point)) <= MERGE_TOL);
        if (!known) vertices.push(point);
      }
    }
  }

  // Face membership is re-derived from scratch rather than accumulated above,
  // so a vertex that happens to lie on a plane none of its own three triples
  // named still gets counted on that face.
  const faces = [];
  for (const h of halfSpaces) {
    const ring = [];
    for (let v = 0; v < vertices.length; v += 1) {
      if (Math.abs(dot(h.normal, vertices[v]) + h.offset) <= MERGE_TOL) ring.push(v);
    }
    // Fewer than three means the cut is redundant: it bounds nothing the other
    // cuts had not already bounded, so it has no face on the body.
    if (ring.length < 3) continue;
    faces.push({ loop: orderFaceLoop(ring, vertices, h.normal), normal: h.normal, label: h.label });
  }

  // A half-space intersection is convex, so each face is a convex polygon and
  // a triangle fan from its first vertex is a valid triangulation.
  const triangles = [];
  for (const face of faces) {
    for (let t = 1; t + 1 < face.loop.length; t += 1) {
      triangles.push([face.loop[0], face.loop[t], face.loop[t + 1]]);
    }
  }

  // Each edge is shared by two faces; the seen-set keeps one copy.
  const seen = new Set();
  const edges = [];
  for (const face of faces) {
    const { loop } = face;
    for (let t = 0; t < loop.length; t += 1) {
      const a = loop[t];
      const b = loop[(t + 1) % loop.length];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a, b]);
    }
  }

  return { vertices, faces, triangles, edges };
}

/**
 * Volume of a closed polyhedron, via the divergence theorem over its triangles.
 *
 * Because the vertices are fractional, the result is already the fraction of
 * the unit cell the wedge occupies - which for a correct asymmetric unit is
 * exactly 1/(number of symmetry operations in the conventional cell).
 *
 * @param {{vertices: number[][], triangles: number[][]}} polyhedron
 * @returns {number}
 */
export function polyhedronVolume(polyhedron) {
  let sum = 0;
  for (const [a, b, c] of polyhedron.triangles ?? []) {
    const A = polyhedron.vertices[a];
    const B = polyhedron.vertices[b];
    const C = polyhedron.vertices[c];
    sum += dot(A, cross(B, C));
  }
  return Math.abs(sum) / 6;
}

/**
 * Slack allowed by containsFractional, in fractional units.
 *
 * Exported because anything that PRE-FILTERS candidate points before calling
 * it has to allow at least as much, or the filter throws away points the
 * predicate would have accepted. That is not hypothetical: atoms on special
 * positions sit exactly on wedge boundaries by construction, so they land on
 * the filter's edge every time.
 */
export const CONTAINS_TOLERANCE = 1e-6;

/**
 * Whether a fractional point lies in the wedge.
 *
 * Asked of the HALF-SPACES rather than the mesh, which makes it both exact and
 * cheap: a handful of dot products with no ray casting and no triangle walk.
 * That is why `halfSpaces` is handed out alongside the polyhedron.
 *
 * The tolerance is positive, so a point exactly on a face counts as inside.
 * An atom sitting on a wedge boundary is the normal case, not the edge case -
 * boundaries of the asymmetric unit are where special positions live.
 *
 * @param {Array<{normal: number[], offset: number}>} halfSpaces
 * @param {number} x fractional coordinates in the conventional cell
 * @param {number} y
 * @param {number} z
 * @param {number} [tolerance] slack in fractional units
 * @returns {boolean}
 */
export function containsFractional(halfSpaces, x, y, z, tolerance = CONTAINS_TOLERANCE) {
  for (const h of halfSpaces) {
    const n = h.normal;
    if (n[0] * x + n[1] * y + n[2] * z + h.offset < -tolerance) return false;
  }
  return true;
}

/**
 * The asymmetric unit of one Hall setting, as geometry plus the text that
 * describes it.
 *
 * Requires `loadSymmetryData()` (WyckoffProjector.js) to have been awaited -
 * the 8.9 MB dataset is fetched lazily and this reads it synchronously.
 *
 * @param {number} hallNumber spglib Hall number, 1-530 (moyo's `hall_number`)
 * @returns {?{polyhedron: object, halfSpaces: object[], volumeFraction: number,
 *             symopCount: number, conditions: string, shapeConditions: string,
 *             hm: string, itNumber: number}}
 *   null when the Hall number is out of range or the row carries no ASU.
 *   `halfSpaces` comes back alongside the polyhedron because testing whether a
 *   point is in the wedge is a question for the inequalities, not the mesh:
 *   see containsFractional().
 */
export function asymmetricUnitForHallNumber(hallNumber) {
  const entry = getSpaceGroupEntryByHallNumber(hallNumber);
  if (!entry?.asu?.shape_only_cuts) return null;

  const halfSpaces = halfSpacesFromCuts(entry.asu.shape_only_cuts);
  const polyhedron = polyhedronFromHalfSpaces(halfSpaces);
  if (!polyhedron.vertices.length) return null;

  return {
    polyhedron,
    halfSpaces,
    volumeFraction: polyhedronVolume(polyhedron),
    symopCount: Number(entry.n_symops),
    conditions: String(entry.asu_str ?? ''),
    shapeConditions: String(entry.asu_shape_only_str ?? ''),
    hm: String(entry.hm_short ?? ''),
    itNumber: Number(entry.it_number),
  };
}
