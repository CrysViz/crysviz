// Analysis over the current structure's coordination polyhedra (structure.polyhedra,
// computed by PolyhedraModule.js): which kinds exist (composition/type), full
// geometry + bond-length/bond-angle distortion metrics for a single selected
// polyhedron, and how neighbouring polyhedra connect (corner/edge/face
// vertex-sharing, plus bond-bridged links that don't share a vertex at all —
// see computePolyhedraConnectivity). Pure data: no rendering. Consumed by
// ui/AnalysisPanels/Polyhedra*Histogram.js and PolyhedronInspector.js.

import {
  centerAngleDeg, bondLengthDistortion, convexHullVolume as hullVolumeFlat,
  TETRAHEDRAL_IDEAL_DEG, OCTAHEDRAL_IDEAL_DEG,
} from '../model/polyhedraProperties.js';
import { invert3x3, transpose3x3, fracToCartPoint, cartToFrac } from '../math/index.js';
import { groupPolyhedraByCategory, resolvePolyhedronStyle } from './PolyhedraModule.js';
import { atomicRadii } from '../defaults/radii_defaults.js';
import { general } from '../state/store.js';

/** Rendered radius of a source atom, matching AtomsFracUpdateModule's
 *  updateSingleAtomDiameter so the inspector's spheres are sized like the main
 *  view's. */
export function renderedAtomRadius(structure, srcIndex, element) {
  const scale = structure?.atoms?.[srcIndex]?.getRadiusScale?.() ?? 1;
  return (atomicRadii[element] || 1.0) * (general.atomSize ?? 1) * scale;
}

/** Atom/bond colour storage is inconsistent about number vs. CSS-hex-string
 *  (an atom's own base `.color` is a parsed number, but the common
 *  updateSingleAtomColor(...,hex,userColor) path used by the atom colour
 *  picker sets `.userColor` — which getColor() prefers — as a raw string) —
 *  normalize either representation to the number THREE.Color expects. */
function normalizeColorHex(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const n = parseInt(raw.startsWith('#') ? raw.slice(1) : raw, 16);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Current colour of a source atom as a hex number (per-atom/user colour wins,
 *  else the element default) — same source the main atom mesh reads. */
export function atomColorHex(structure, srcIndex) {
  return normalizeColorHex(structure?.atoms?.[srcIndex]?.getColor?.());
}

// ---------------------------------------------------------------------------
// Shared geometry helpers
// ---------------------------------------------------------------------------

function dist3(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function centroidOf(points) {
  let x = 0, y = 0, z = 0;
  for (const p of points) { x += p[0]; y += p[1]; z += p[2]; }
  const n = points.length || 1;
  return [x / n, y / n, z / n];
}

// Positions from periodic-image instances of the SAME physical vertex/centre
// coincide to floating-point precision (exact lattice translations) — round to
// collapse them into one key without merging genuinely distinct atoms.
const POS_DECIMALS = 3;
export function posKey(p) {
  return `${p[0].toFixed(POS_DECIMALS)},${p[1].toFixed(POS_DECIMALS)},${p[2].toFixed(POS_DECIMALS)}`;
}

/** Look up the main view's own drawn bond between two placed atoms (matched
 *  by position, since a bond's two periodic-image positions ARE the two
 *  atoms' exact cartesian coordinates), for the inspectors to draw it the
 *  same way: the real rendered colour of each half — whatever produced it
 *  (element/force/length colour mode, category style, a per-bond override) —
 *  and where the main render starts the bond at each atom (model/Bond.js
 *  r1/r2, the distance from the atom's centre). Reusing those, rather than
 *  re-deriving them, keeps the inspectors in step with the main view's bond
 *  geometry. Builds an index of structure.bonds once; the returned function
 *  gives null for a pair with no drawn bond (e.g. bonds hidden/not yet built)
 *  so callers can fall back.
 *  @returns {(posA:number[], posB:number[]) => null | {hexA:number|null, hexB:number|null, trimA:number|null, trimB:number|null}} */
export function renderedBondLookup(structure) {
  const index = new Map();
  for (const bond of structure?.bonds ?? []) {
    const pos = bond?.positions;
    if (!pos || pos.length !== 2) continue;
    index.set(`${posKey(pos[0])}|${posKey(pos[1])}`, bond);
  }
  const colorAt = (bond, i) => normalizeColorHex(bond.userColor?.[i] ?? bond.color?.[i]);
  const trimAt = (bond, i) => {
    const t = i === 0 ? bond.r1 : bond.r2;
    return Number.isFinite(t) ? t : null;
  };
  return (posA, posB) => {
    const ka = posKey(posA), kb = posKey(posB);
    let bond = index.get(`${ka}|${kb}`);
    if (bond) return { hexA: colorAt(bond, 0), hexB: colorAt(bond, 1), trimA: trimAt(bond, 0), trimB: trimAt(bond, 1) };
    bond = index.get(`${kb}|${ka}`);
    if (bond) return { hexA: colorAt(bond, 1), hexB: colorAt(bond, 0), trimA: trimAt(bond, 1), trimB: trimAt(bond, 0) };
    return null;
  };
}

/** Angle p–centre–q in degrees (0 for a degenerate arm). The maths lives in
 *  model/polyhedraProperties.js, shared with the per-frame property colouring. */
export function angleAtCenterDeg(center, p, q) {
  return centerAngleDeg(center[0], center[1], center[2], p[0], p[1], p[2], q[0], q[1], q[2]);
}

/** Volume (Å³) of the convex hull of a polyhedron's vertex positions — the
 *  standard coordination-polyhedron volume. Delegates to the shared double-
 *  precision hull in model/polyhedraProperties.js (the per-frame colouring
 *  uses the same one). It used to triangulate with three.js ConvexGeometry,
 *  whose Float32 positions made the inspector's finite-difference CIF error of
 *  the volume wrong by tens of percent far from the origin. Returns null for
 *  fewer than 4 points or a degenerate (coplanar/collinear) set.
 *  @param {number[][]} vertexPositions cartesian [x,y,z] per vertex */
export function convexHullVolume(vertexPositions) {
  if (!vertexPositions || vertexPositions.length < 4) return null;
  const v = hullVolumeFlat(Float64Array.from(vertexPositions.flat()), 0, vertexPositions.length);
  return Number.isFinite(v) ? v : null;
}

/** Exact Cartesian position of a centered polyhedron's centre ATOM for this
 *  specific periodic-image instance (not the vertex centroid, which is only an
 *  approximation — distortion needs the real centre). Derives the image shift
 *  the same way PolyhedraModule's polyhedronIdentity() does: round the
 *  difference between the vertex-centroid's fractional coords and the centre
 *  atom's base fractional coords. */
function polyhedronCenterCart(structure, poly, lattice, latInv) {
  if (poly.type !== 'centered' || !Number.isInteger(poly.centerIndex)) return null;
  const atomFrac = structure.atoms[poly.centerIndex]?.position;
  if (!atomFrac) return null;
  const centroidFrac = cartToFrac(centroidOf(poly.vertices), lattice, latInv);
  const centerFrac = [0, 1, 2].map((k) => atomFrac[k] + Math.round(centroidFrac[k] - atomFrac[k]));
  return fracToCartPoint(centerFrac, lattice);
}

function sampleVariance(values, ideal) {
  if (values.length < 2) return null;
  const sq = values.reduce((s, v) => s + (v - ideal) ** 2, 0);
  return sq / (values.length - 1);
}

/**
 * Bond-length distortion index and bond-angle variance of a centred
 * polyhedron, from positions. One function for the inspector's numbers and
 * for their CIF errors (ui/AnalysisPanels/PolyhedronInspector.js propagates
 * through it with model/cifErrors.js), so both follow exactly the same maths.
 * @param {number[]} center cartesian centre
 * @param {number[][]} vertices cartesian vertices
 * @param {Array<{i:number, j:number, kind?:string|null}>} anglePairs the
 *   vertex pairs the variance is defined over (tetrahedralAngles /
 *   octahedralAngles: all for CN4, the cis ones for CN6)
 * @returns {{ bld: number|null, angleVariance: number|null }}
 */
export function polyhedronDistortion(center, vertices, anglePairs) {
  const cn = vertices.length;
  // Baur index from the shared kernel (same operation order as before).
  const d = bondLengthDistortion(center[0], center[1], center[2], Float64Array.from(vertices.flat()), 0, cn);
  const bld = Number.isFinite(d) ? d : null;
  const at = (a) => angleAtCenterDeg(center, vertices[a.i], vertices[a.j]);
  let angleVariance = null;
  if (cn === 4) angleVariance = sampleVariance(anglePairs.map(at), TETRAHEDRAL_IDEAL_DEG);
  else if (cn === 6) angleVariance = sampleVariance(anglePairs.filter((a) => a.kind === 'cis').map(at), OCTAHEDRAL_IDEAL_DEG);
  return { bld, angleVariance };
}

/** All 6 vertex-centre-vertex angles of a tetrahedral (CN4) shell, each tagged
 *  against the ideal 109.47° (Robinson et al. 1971's tetrahedral case — no
 *  cis/trans distinction, every pair is equivalent). */
function tetrahedralAngles(center, vertices) {
  const angles = [];
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      angles.push({ i, j, angleDeg: angleAtCenterDeg(center, vertices[i], vertices[j]), kind: null });
    }
  }
  return angles;
}

/** All 15 vertex-centre-vertex angles of an octahedral (CN6) shell, with the 3
 *  trans (~180°) pairs identified via greedy max-angle disjoint matching and
 *  tagged 'trans'; the remaining 12 are tagged 'cis' (~90°) — the set Robinson
 *  et al. 1971's Octahedral Angle Variance is defined over. */
function octahedralAngles(center, vertices) {
  const n = vertices.length;
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs.push({ i, j, angleDeg: angleAtCenterDeg(center, vertices[i], vertices[j]) });
    }
  }
  const bySizeDesc = [...pairs].sort((a, b) => b.angleDeg - a.angleDeg);
  const used = new Set();
  const transKeys = new Set();
  for (const p of bySizeDesc) {
    if (used.has(p.i) || used.has(p.j)) continue;
    used.add(p.i); used.add(p.j);
    transKeys.add(`${p.i}-${p.j}`);
    if (transKeys.size === 3) break;
  }
  return pairs.map((p) => ({ ...p, kind: transKeys.has(`${p.i}-${p.j}`) ? 'trans' : 'cis' }));
}

/** Whether vertices a and b span an EDGE of the convex hull of `points`.
 *
 *  Test: project every point along the line ab onto the plane perpendicular to
 *  it. Both a and b land on that plane's origin, so ab is a hull edge exactly
 *  when the origin sits on the boundary of the projected points' 2-D hull —
 *  i.e. when all of them fit in a closed half-plane through it, which is true
 *  iff the largest angular gap between consecutive projected directions is at
 *  least 180°. (The plane through a and b that closes that gap is then a
 *  supporting plane of the whole set.) */
function isHullEdge(points, ai, bi) {
  const a = points[ai], b = points[bi];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const uLen = Math.hypot(...u);
  if (uLen < 1e-9) return false;
  const un = [u[0] / uLen, u[1] / uLen, u[2] / uLen];
  // Any two axes spanning the plane perpendicular to the line.
  const seed = Math.abs(un[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = [
    seed[1] * un[2] - seed[2] * un[1],
    seed[2] * un[0] - seed[0] * un[2],
    seed[0] * un[1] - seed[1] * un[0],
  ];
  const e1Len = Math.hypot(...e1);
  if (e1Len < 1e-9) return false;
  for (let k = 0; k < 3; k++) e1[k] /= e1Len;
  const e2 = [
    un[1] * e1[2] - un[2] * e1[1],
    un[2] * e1[0] - un[0] * e1[2],
    un[0] * e1[1] - un[1] * e1[0],
  ];

  const dirs = [];
  for (let i = 0; i < points.length; i++) {
    if (i === ai || i === bi) continue;
    const w = [points[i][0] - a[0], points[i][1] - a[1], points[i][2] - a[2]];
    const x = w[0] * e1[0] + w[1] * e1[1] + w[2] * e1[2];
    const y = w[0] * e2[0] + w[1] * e2[1] + w[2] * e2[2];
    // A point landing on the origin lies on line ab itself; it constrains
    // nothing about which side the supporting plane can face.
    if (Math.hypot(x, y) < 1e-9) continue;
    dirs.push(Math.atan2(y, x));
  }
  if (dirs.length < 2) return true;
  dirs.sort((p, q) => p - q);
  let maxGap = dirs[0] + 2 * Math.PI - dirs[dirs.length - 1]; // wrap-around gap
  for (let i = 1; i < dirs.length; i++) maxGap = Math.max(maxGap, dirs[i] - dirs[i - 1]);
  // Strictly greater than 180°: at exactly 180° the origin lies ON the 2-D
  // hull's boundary rather than at a corner of it, which is the signature of a
  // pair spanning a FLAT FACE instead of an edge — a square face's diagonal
  // projects its two neighbours to exactly opposite directions. Those cut
  // across the face and are not edges.
  return maxGap > Math.PI + 1e-7;
}

/** Vertex-centre-vertex angles for a shell of ANY coordination number, kept to
 *  the pairs of vertices that are actually adjacent — joined by an edge of the
 *  coordination polyhedron rather than reaching across its interior.
 *
 *  Every pair is useless past CN6: a CN8 shell has 28 of them, most cutting
 *  through the polyhedron's own middle, and the two hand-written cases already
 *  restrict themselves (CN6 drops its 3 trans pairs). Hull edges reproduce
 *  those exactly — 6 for a tetrahedron, the 12 cis pairs for an octahedron —
 *  and give the expected count elsewhere: 12 for a cube, 16 for a square
 *  antiprism, 9 for a trigonal bipyramid, 24 for a cuboctahedron.
 *
 *  Kept separate from tetrahedralAngles/octahedralAngles rather than replacing
 *  them: those feed the published TAV/OAV distortion indices, which are defined
 *  over a specific pair set, and a distorted shell would not necessarily
 *  reduce to the same set here. */
function adjacentAngles(center, vertices) {
  const out = [];
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      if (!isHullEdge(vertices, i, j)) continue;
      out.push({ i, j, angleDeg: angleAtCenterDeg(center, vertices[i], vertices[j]), kind: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1) Type / composition histogram data — thin wrapper over the existing
//    category grouping (Poly tab) so both stay in sync.
// ---------------------------------------------------------------------------

/** @returns {Array<{catKey:string, label:string, type:string, cn:number, count:number, atomIndices:number[]}>} */
export function computePolyhedraTypeGroups(structure) {
  const model = structure?.polyhedra;
  if (!model?.polyhedra?.length) return [];
  const categories = groupPolyhedraByCategory(structure);
  const out = [];
  categories.forEach((entry, catKey) => {
    const atomSet = new Set();
    for (const polyIndex of entry.indices) {
      const poly = model.polyhedra[polyIndex];
      if (Number.isInteger(poly.centerIndex)) atomSet.add(poly.centerIndex);
      for (const src of poly.vertexSrcList ?? []) atomSet.add(src);
    }
    out.push({
      catKey, label: entry.label, type: entry.type, cn: entry.cn,
      count: entry.indices.length, atomIndices: [...atomSet],
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// 2) Single-polyhedron detail — full geometry + per-bond/per-angle metrics for
//    ONE selected polyhedron (picked in the 3D view), consumed by
//    ui/AnalysisPanels/PolyhedronInspector.js's mini render + labels. Bond
//    length and angle data only apply to centered polyhedra (a cage has no
//    centre to measure from); angle data further only applies to CN4
//    (tetrahedral) and CN6 (octahedral) shells, per the standard Robinson et
//    al. 1971 definitions.
// ---------------------------------------------------------------------------

/** @param {any} structure
 *  @param {any} poly one entry of structure.polyhedra.polyhedra
 *  @returns {{type:string, cn:number, catKey:string, catLabel:string,
 *   centerCart:number[]|null, centerElement:string|null, centerIndex:number|null,
 *   centerColor:number|null, centerRadius:number|null,
 *   faceColor:(string|number), faceOpacity:number, edgeColor:(string|number),
 *   vertices: Array<{pos:number[], srcIndex:number, element:string|null,
 *     bondLength:number|null, color:number|null, radius:number,
 *     bondColorNear:number|null, bondColorFar:number|null}>,
 *   angles: Array<{i:number, j:number, angleDeg:number, kind:'cis'|'trans'|null}>,
 *   bld:number|null, angleVariance:number|null, angleLabel:string|null,
 *   key:string, volume:number|null} | null}
 *  Colours/radii mirror what the main viewer renders (per-atom colour + rendered
 *  radius, resolved polyhedron face/edge style) so the inspector's mini view
 *  looks like the same structure, not a generic diagram. */
export function computePolyhedronDetail(structure, poly) {
  if (!poly || !structure) return null;
  const lattice = structure.lattice;
  const latInv = lattice ? invert3x3(transpose3x3(lattice)) : null;
  const cn = poly.vertices.length;
  const isCentered = poly.type === 'centered' && Number.isInteger(poly.centerIndex) && !!latInv;
  const centerCart = isCentered ? polyhedronCenterCart(structure, poly, lattice, latInv) : null;

  const vertexSrcList = poly.vertexSrcList ?? [];
  const drawnBond = centerCart ? renderedBondLookup(structure) : null;
  const vertices = poly.vertices.map((pos, i) => {
    const srcIndex = vertexSrcList[i];
    const element = Number.isInteger(srcIndex) ? (structure.elements?.[srcIndex] ?? null) : null;
    const drawn = drawnBond ? drawnBond(centerCart, pos) : null;
    return {
      pos, srcIndex, element,
      bondLength: centerCart ? dist3(pos, centerCart) : null,
      color: Number.isInteger(srcIndex) ? atomColorHex(structure, srcIndex) : null,
      radius: Number.isInteger(srcIndex) ? renderedAtomRadius(structure, srcIndex, element) : 0.5,
      // The actual rendered bond half-colours (may differ from the endpoint
      // atoms' own colours — bond length/category/user-override colouring),
      // and where the main render starts the bond at each atom; null when no
      // matching bond is found so callers fall back.
      bondColorNear: drawn?.hexA ?? null,
      bondColorFar: drawn?.hexB ?? null,
      bondTrimNear: drawn?.trimA ?? null,
      bondTrimFar: drawn?.trimB ?? null,
    };
  });

  let angles = [];
  if (centerCart) {
    if (cn === 4) angles = tetrahedralAngles(centerCart, poly.vertices);
    else if (cn === 6) angles = octahedralAngles(centerCart, poly.vertices);
    else if (cn >= 2) angles = adjacentAngles(centerCart, poly.vertices);
  }

  let bld = null;
  let angleVariance = null, angleLabel = null;
  if (centerCart) {
    ({ bld, angleVariance } = polyhedronDistortion(centerCart, poly.vertices, angles));
    if (cn === 4) angleLabel = 'TAV';
    else if (cn === 6) angleLabel = 'OAV';
  }

  const style = resolvePolyhedronStyle(
    structure, poly.key, poly.catKey, poly.type, poly.centerIndex, poly.colorElem);

  return {
    key: poly.key, catKey: poly.catKey, catLabel: poly.catLabel,
    type: poly.type, cn,
    centerCart, centerElement: isCentered ? (poly.centerElement ?? null) : null,
    centerIndex: isCentered ? poly.centerIndex : null,
    centerColor: isCentered ? atomColorHex(structure, poly.centerIndex) : null,
    centerRadius: isCentered ? renderedAtomRadius(structure, poly.centerIndex, poly.centerElement) : null,
    faceColor: style.color, faceOpacity: style.opacity, edgeColor: style.edgeColor,
    vertices, angles, bld, angleVariance, angleLabel,
    volume: convexHullVolume(poly.vertices),
  };
}

/** Convex-hull volume (Å³) of every distinct physical polyhedron, one row per
 *  periodic-image GROUP (duplicates share a volume, so plotting each copy would
 *  just uniformly scale the distribution). Mirrors computePolyhedraTypeGroups'
 *  role for the type histogram; consumed by the volume histogram panel, which
 *  bins `volume` and highlights the polyhedra whose keys fall in a clicked bin.
 *  @returns {Array<{key:string, groupKey:string, catKey:string, catLabel:string,
 *   cn:number, centerIndex:number|null, label:string, volume:number}>} */
export function computePolyhedraVolumes(structure) {
  const polys = structure?.polyhedra?.polyhedra ?? [];
  if (!polys.length) return [];
  const seen = new Set();
  const out = [];
  for (const poly of polys) {
    const groupKey = poly.groupKey ?? poly.key;
    if (seen.has(groupKey)) continue; // one representative per physical polyhedron
    seen.add(groupKey);
    const volume = convexHullVolume(poly.vertices);
    if (volume == null) continue;
    // A short human label for the drill-down list: the centre atom for a
    // centered polyhedron (e.g. "Ba12"), else just the category (cages).
    const centered = Number.isInteger(poly.centerIndex);
    const label = centered
      ? `${poly.centerElement ?? structure.elements?.[poly.centerIndex] ?? '?'}${poly.centerIndex}`
      : (poly.catLabel ?? 'polyhedron');
    out.push({
      key: poly.key, groupKey, catKey: poly.catKey, catLabel: poly.catLabel,
      cn: poly.vertices.length,
      centerIndex: centered ? poly.centerIndex : null,
      label, volume,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3) Connectivity — corner/edge/face vertex-sharing between polyhedra, plus
//    two "bond-bridged" categories for polyhedra that don't share a vertex at
//    all but are chemically linked by real bonds (common in nitride-type
//    networks): 'bond1' = a vertex atom of one is directly bonded to a vertex
//    atom of the other; 'bond2' = the same but via exactly one intermediate
//    atom (vertex–bond–atom–bond–vertex, i.e. a bridging trimer).
//    Computed on the full set of periodic-image polyhedron INSTANCES (so
//    vertex-sharing is a genuine Cartesian-position test, not an index
//    coincidence), then deduplicated into distinct PHYSICAL connections via a
//    canonicalized (groupKey pair + relative centroid vector) key — the same
//    pattern used for the periodic bond-duplication fix in
//    BondsFracUpdateModule.js, and for the same reason: two instances that are
//    both periodic copies of the same physical connection must collapse to
//    one, while an atom/polyhedron's several genuinely distinct neighbours
//    must not be merged into each other.
// ---------------------------------------------------------------------------

// Strength order: when the same physical pair of neighbouring polyhedra would
// otherwise be reported under more than one sharing type (see dedup below),
// only the strongest survives — a directly-touching pair is never ALSO
// reported as bridged, which is what "corner-sharing counted as a trimer
// bridge too" was: a periodic-image duplicate instance pair found a 2-hop
// path where a different instance pair of the very same physical neighbours
// already shared a vertex directly.
const SHARING_ORDER = { face: 0, edge: 1, corner: 2, bond1: 3, bond2: 4 };

/** Fractional coordinates folded into [0,1) and rounded: one key for an atom
 *  site and every lattice translate of it. */
function wrappedFracKey(p, lattice, latInv) {
  return cartToFrac(p, lattice, latInv).map((x) => {
    const r = Math.round(x * 1e4) % 1e4;
    return r < 0 ? r + 1e4 : r;
  }).join(',');
}

/** The polyhedra the connectivity compares. In a crystal, one per physical
 *  polyhedron (periodic-image group) — its most complete drawn copy, moved so
 *  its centroid lies in the home cell — plus every lattice translate of those
 *  that could reach the home cell: the drawn copies alone miss connections,
 *  e.g. rutile's centre TiO6 shares edges along c with copies of itself one
 *  cell up and down, and none of those is drawn (Edge read 1 instead of 2).
 *  Without a lattice (a molecule), the drawn polyhedra as they are. */
function connectivityInstances(structure, drawn, lattice, latInv, reachLimit) {
  const toInstance = (poly, sourceIndex, shift, home) => {
    const vertices = shift ? poly.vertices.map((v) => [v[0] + shift[0], v[1] + shift[1], v[2] + shift[2]]) : poly.vertices;
    const center = latInv ? polyhedronCenterCart(structure, poly, lattice, latInv) : null;
    return {
      poly, sourceIndex, home, vertices,
      srcList: poly.vertexSrcList ?? [],
      groupKey: poly.groupKey ?? `i:${sourceIndex}`,
      center: center && shift ? [center[0] + shift[0], center[1] + shift[1], center[2] + shift[2]] : center,
    };
  };
  if (!latInv) return drawn.map((poly, index) => toInstance(poly, index, null, true));

  // The most complete drawn copy of each physical polyhedron.
  const reps = new Map();
  drawn.forEach((poly, index) => {
    const groupKey = poly.groupKey ?? `i:${index}`;
    const kept = reps.get(groupKey);
    if (!kept || poly.vertices.length > kept.poly.vertices.length) reps.set(groupKey, { poly, index });
  });
  const [a, b, c] = lattice;
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const volume = Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
  // Cell height along each axis: how far one lattice step moves a polyhedron
  // away from the home cell's faces.
  const heights = [cross(b, c), cross(c, a), cross(a, b)].map((n) => volume / (Math.hypot(...n) || 1));
  const margin = heights.map((h) => reachLimit / h);
  const steps = margin.map((m) => Math.min(6, Math.ceil(m) + 1));

  const instances = [];
  for (const { poly, index } of reps.values()) {
    const frac = cartToFrac(centroidOf(poly.vertices), lattice, latInv);
    const home = frac.map((x) => -Math.floor(x + 1e-9));
    const homeFrac = frac.map((x, k) => x + home[k]);
    const base = toInstance(poly, index, fracToCartPoint(home, lattice), true);
    for (let i = -steps[0]; i <= steps[0]; i++) {
      for (let j = -steps[1]; j <= steps[1]; j++) {
        for (let k = -steps[2]; k <= steps[2]; k++) {
          const t = [i, j, k];
          if (t.some((tk, axis) => homeFrac[axis] + tk < -margin[axis] || homeFrac[axis] + tk > 1 + margin[axis])) continue;
          if (i === 0 && j === 0 && k === 0) { instances.push(base); continue; }
          const [dx, dy, dz] = fracToCartPoint(t, lattice);
          instances.push({
            ...base,
            home: false,
            vertices: base.vertices.map((v) => [v[0] + dx, v[1] + dy, v[2] + dz]),
            center: base.center && [base.center[0] + dx, base.center[1] + dy, base.center[2] + dz],
          });
        }
      }
    }
  }
  return instances;
}

/** @returns {Array<{sharing:string, catKeyA:string, catKeyB:string, labelA:string, labelB:string,
 *   polyIndexA:number, polyIndexB:number, sharedCount:number, bridgeAtomIndices:number[],
 *   highlightAtomIndices:number[], highlightBondInstanceIds:number[]}>} deduplicated
 *   distinct physical connections (per cell, in a crystal). For corner/edge/face sharing,
 *   highlightAtomIndices is just the shared vertex atom(s) (the "corners"); for bond1/bond2
 *   bridges, highlightBondInstanceIds is the rendered bond instance id(s) that realize the
 *   link (one drawn copy of it) — the 3D highlight is meant to show the LINK itself, not
 *   every atom of both polyhedra. polyIndexA/B index the drawn polyhedron each side copies. */
export function computePolyhedraConnectivity(structure) {
  const model = structure?.polyhedra;
  const drawn = model?.polyhedra ?? [];
  if (!drawn.length) return [];
  const bonds = structure?.bonds ?? [];
  const lattice = structure.lattice;
  const inverse = lattice ? invert3x3(transpose3x3(lattice)) : null;
  const latInv = inverse?.every((row) => row.every(Number.isFinite)) ? inverse : null;

  const maxBondSpan = bonds.reduce((m, b) => Math.max(m, b.dist || 0), 0) || 3.5;
  const bridgeSearchSlack = 2 * maxBondSpan + 0.5;
  const drawnReach = (poly) => {
    const c = centroidOf(poly.vertices);
    return poly.vertices.reduce((m, v) => Math.max(m, dist3(v, c)), 0);
  };
  const reachLimit = 2 * drawn.reduce((m, poly) => Math.max(m, drawnReach(poly)), 0) + bridgeSearchSlack;
  const polys = connectivityInstances(structure, drawn, lattice, latInv, reachLimit);
  if (polys.length < 2) return [];

  // ---- vertex-position index across all instances: posKey -> [polyIndex, ...] ----
  const vertexIndex = new Map();
  const vertexPosSets = new Array(polys.length); // polyIndex -> Set(posKey) of its own vertices
  const posToSrcAtom = new Map(); // posKey -> source atom index (same physical atom everywhere)
  // Own-atom position sets (vertices + centre, when present) — used to keep the
  // trimer bridge search from tracing a vertex back through its OWN polyhedron's
  // centre and back out again, which isn't a genuine third bridging atom.
  const ownPosSets = new Array(polys.length);
  // Every polyhedron's centre site — the trimer bridge search excludes these as
  // candidate intermediates (see below): hopping through ANOTHER polyhedron's
  // own centre is really two hops of corner-sharing-like connectivity through a
  // third coordination cluster, not the free-ligand bridging atom the trimer
  // category is meant to capture (e.g. a bridging N in a nitride, which is a
  // vertex/ligand species, not a polyhedron centre itself). Keyed by site, so
  // every translate of a centre counts.
  const siteKey = latInv ? (p) => wrappedFracKey(p, lattice, latInv) : posKey;
  const allCenterSiteKeys = new Set();
  polys.forEach((poly, polyIndex) => {
    const set = new Set();
    vertexPosSets[polyIndex] = set;
    poly.vertices.forEach((v, vi) => {
      const key = posKey(v);
      set.add(key);
      if (!vertexIndex.has(key)) vertexIndex.set(key, []);
      vertexIndex.get(key).push(polyIndex);
      const src = poly.srcList[vi];
      if (Number.isInteger(src)) posToSrcAtom.set(key, src);
    });
    const ownSet = new Set(set);
    if (poly.center) {
      ownSet.add(posKey(poly.center));
      allCenterSiteKeys.add(siteKey(poly.center));
    }
    ownPosSets[polyIndex] = ownSet;
  });

  const pairKeyOf = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  // ---- shared-vertex positions per instance pair (one of them in the home
  //      cell: the others are translates of those) ----
  /** @type {Map<string, {a:number,b:number,posKeys:Set<string>}>} */
  const sharedByPair = new Map();
  for (const [key, polyIndices] of vertexIndex) {
    if (polyIndices.length < 2) continue;
    const uniq = [...new Set(polyIndices)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = uniq[i], b = uniq[j];
        if (!polys[a].home && !polys[b].home) continue;
        const pk = pairKeyOf(a, b);
        let e = sharedByPair.get(pk);
        if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), posKeys: new Set() }; sharedByPair.set(pk, e); }
        e.posKeys.add(key);
      }
    }
  }

  // ---- bond graph (reuses the already-computed, periodic-correct rendered
  //      bonds — a bridge is only real if an actual bond realizes it). In a
  //      crystal it is keyed by site, holding each bond as the step to its
  //      other end, so it reaches the translates too. ----
  /** @type {Map<string, Array<{d:number[], srcIdx:number, bond:any}>>} */
  const siteToSteps = new Map();
  const seenSteps = new Set();
  const addStep = (from, to, toSrc, bond) => {
    const fromKey = siteKey(from);
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const once = `${fromKey}|${d.map((x) => x.toFixed(POS_DECIMALS)).join(',')}`;
    if (seenSteps.has(once)) return;
    seenSteps.add(once);
    if (!siteToSteps.has(fromKey)) siteToSteps.set(fromKey, []);
    siteToSteps.get(fromKey).push({ d, srcIdx: toSrc, bond });
  };
  for (const bond of bonds) {
    if (!bond?.positions || bond.positions.length !== 2 || !bond.srcIndices) continue;
    const [p1, p2] = bond.positions;
    const [s1, s2] = bond.srcIndices;
    addStep(p1, p2, s2, bond);
    addStep(p2, p1, s1, bond);
  }
  const neighborsOf = (pos) => (siteToSteps.get(siteKey(pos)) ?? [])
    .map(({ d, srcIdx, bond }) => ({ pos: [pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]], srcIdx, bond }));

  // ---- centroid + reach (max centre-to-vertex distance) per instance, for a
  //      cheap prefilter before the bridge search, and a grid of centroids so
  //      each home polyhedron only looks at instances near it. ----
  const centroids = polys.map((poly) => centroidOf(poly.vertices));
  const reach = polys.map((poly, i) => {
    const c = centroids[i];
    return poly.vertices.reduce((m, v) => Math.max(m, dist3(v, c)), 0);
  });
  const cellSize = Math.max(reachLimit, 1);
  const cellOf = (p) => p.map((x) => Math.floor(x / cellSize));
  const grid = new Map();
  centroids.forEach((c, i) => {
    const key = cellOf(c).join(',');
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  const nearby = (i) => {
    const [x, y, z] = cellOf(centroids[i]);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      out.push(...(grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []));
    }
    return out;
  };

  /** @type {Map<string, {sharing:string, a:number, b:number, sharedPosKeys:Set<string>,
   *   bridgeAtomIndices:Set<number>, bridgeBonds:Set<any>}>} */
  const rawConnections = new Map();
  for (const { a, b, posKeys } of sharedByPair.values()) {
    const sharing = posKeys.size >= 3 ? 'face' : posKeys.size === 2 ? 'edge' : 'corner';
    rawConnections.set(pairKeyOf(a, b), {
      sharing, a, b, sharedPosKeys: posKeys, bridgeAtomIndices: new Set(), bridgeBonds: new Set(),
    });
  }

  // ---- bond-bridge search for instance pairs that don't already share a vertex.
  //      What a home polyhedron A reaches is worked out once, then looked up
  //      for each B near it:
  //      direct (1-bond): a vertex of A is bonded straight to a vertex of B;
  //      trimer (2-bond): via one intermediate atom that isn't itself part of A
  //      or B (a vertex OR the centre — otherwise this would just retrace a
  //      vertex back through its own polyhedron's centre and back out), and
  //      isn't ANOTHER polyhedron's centre either (that would just be two hops
  //      through a third coordination cluster, not a genuine free-ligand
  //      bridge). ----
  const stepsCache = new Map();
  const cachedNeighbors = (pos) => {
    const key = posKey(pos);
    let list = stepsCache.get(key);
    if (!list) { list = neighborsOf(pos).map((nb) => ({ ...nb, key: posKey(nb.pos) })); stepsCache.set(key, list); }
    return list;
  };
  for (let a = 0; a < polys.length; a++) {
    if (!polys[a].home) continue;
    const ownSetA = ownPosSets[a];
    /** @type {Map<string, any>} */
    const direct = new Map(); // reached posKey -> the bond
    /** @type {Map<string, Array<{xKey:string, srcIdx:number, bonds:any[]}>>} */
    const viaOne = new Map(); // reached posKey -> the bridging atoms
    for (const vA of polys[a].vertices) {
      for (const x of cachedNeighbors(vA)) {
        if (!direct.has(x.key)) direct.set(x.key, x.bond);
        if (ownSetA.has(x.key) || allCenterSiteKeys.has(siteKey(x.pos))) continue;
        for (const nb of cachedNeighbors(x.pos)) {
          if (!viaOne.has(nb.key)) viaOne.set(nb.key, []);
          viaOne.get(nb.key).push({ xKey: x.key, srcIdx: x.srcIdx, bonds: [x.bond, nb.bond] });
        }
      }
    }
    for (const b of nearby(a)) {
      if (b === a || (polys[b].home && b < a)) continue; // each pair once
      if (dist3(centroids[a], centroids[b]) > reach[a] + reach[b] + bridgeSearchSlack) continue;
      const key = pairKeyOf(a, b);
      if (rawConnections.has(key)) continue;

      const vertexKeysB = vertexPosSets[b];
      const ownSetB = ownPosSets[b];
      let bridge = null;
      for (const k of vertexKeysB) {
        if (direct.has(k)) { bridge = { sharing: 'bond1', srcs: [], bonds: [direct.get(k)] }; break; }
      }
      if (!bridge) {
        outerTrimer:
        for (const k of vertexKeysB) {
          for (const via of viaOne.get(k) ?? []) {
            if (ownSetB.has(via.xKey)) continue;
            bridge = { sharing: 'bond2', srcs: [via.srcIdx], bonds: via.bonds };
            break outerTrimer;
          }
        }
      }

      if (bridge) {
        rawConnections.set(key, {
          sharing: bridge.sharing, a, b, sharedPosKeys: new Set(),
          bridgeAtomIndices: new Set(bridge.srcs), bridgeBonds: new Set(bridge.bonds),
        });
      }
    }
  }

  // ---- deduplicate periodic-image copies of the same physical connection.
  //      Keyed on physical pair + relative direction ONLY (no sharing type) so
  //      that if different periodic-image instance pairs of the very same
  //      physical neighbours disagree on HOW they connect (e.g. one pair
  //      happens to share a vertex, another only finds a longer bridge path),
  //      only the strongest finding is kept — never both. Between two copies
  //      of ONE polyhedron the direction's sign is arbitrary (up from this
  //      copy is down from that one), so it is fixed: one connection, not two. ----
  /** @type {Map<string, any>} */
  const dedup = new Map();
  for (const conn of rawConnections.values()) {
    const A = polys[conn.a], B = polys[conn.b];
    const gA = A.groupKey, gB = B.groupKey;
    let rel = [
      centroids[conn.b][0] - centroids[conn.a][0],
      centroids[conn.b][1] - centroids[conn.a][1],
      centroids[conn.b][2] - centroids[conn.a][2],
    ];
    let ga = gA, gb = gB, polyIndexA = A.sourceIndex, polyIndexB = B.sourceIndex, catA = A.poly.catKey, catB = B.poly.catKey,
      labelA = A.poly.catLabel, labelB = B.poly.catLabel;
    if (gA !== gB && gA > gB) {
      [ga, gb] = [gB, gA];
      rel = rel.map((x) => -x);
      [polyIndexA, polyIndexB] = [polyIndexB, polyIndexA];
      [catA, catB] = [catB, catA];
      [labelA, labelB] = [labelB, labelA];
    }
    let q = rel.map((x) => Math.round(x * 1000));
    if (ga === gb && (q.find((x) => x !== 0) ?? 0) < 0) q = q.map((x) => -x);
    const dedupeKey = `${ga}|${gb}:${q.join(',')}`;

    const existing = dedup.get(dedupeKey);
    if (existing && SHARING_ORDER[existing.sharing] <= SHARING_ORDER[conn.sharing]) continue;

    const highlightAtomIndices = conn.sharedPosKeys.size
      ? [...conn.sharedPosKeys].map((k) => posToSrcAtom.get(k)).filter((i) => Number.isInteger(i))
      : [];
    const highlightBondInstanceIds = [...conn.bridgeBonds].flatMap((b) => b?.instanceIds ?? []);

    dedup.set(dedupeKey, {
      sharing: conn.sharing, catKeyA: catA, catKeyB: catB, labelA, labelB,
      polyIndexA, polyIndexB, sharedCount: conn.sharedPosKeys.size,
      bridgeAtomIndices: [...conn.bridgeAtomIndices],
      highlightAtomIndices, highlightBondInstanceIds,
    });
  }

  return [...dedup.values()].sort((x, y) => SHARING_ORDER[x.sharing] - SHARING_ORDER[y.sharing]);
}
