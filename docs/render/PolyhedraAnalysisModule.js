// Analysis over the current structure's coordination polyhedra (structure.polyhedra,
// computed by PolyhedraModule.js): which kinds exist (composition/type), full
// geometry + bond-length/bond-angle distortion metrics for a single selected
// polyhedron, and how neighbouring polyhedra connect (corner/edge/face
// vertex-sharing, plus bond-bridged links that don't share a vertex at all —
// see computePolyhedraConnectivity). Pure data: no rendering. Consumed by
// ui/AnalysisPanels/Polyhedra*Histogram.js and PolyhedronInspector.js.

import { invert3x3, transpose3x3, fracToCartPoint, cartToFrac } from '../math/index.js';
import { groupPolyhedraByCategory, resolvePolyhedronStyle } from './PolyhedraModule.js';
import { atomicRadii } from '../defaults/radii_defaults.js';
import { general } from '../state/store.js';

/** Rendered radius of a source atom, matching AtomsFracUpdateModule's
 *  updateSingleAtomDiameter so the inspector's spheres are sized like the main
 *  view's. */
function renderedAtomRadius(structure, srcIndex, element) {
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
function atomColorHex(structure, srcIndex) {
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
function posKey(p) {
  return `${p[0].toFixed(POS_DECIMALS)},${p[1].toFixed(POS_DECIMALS)},${p[2].toFixed(POS_DECIMALS)}`;
}

/** The real rendered colour of each half of the bond connecting `centerPos`
 *  to `vertexPos` (matched by position, since a bond's two periodic-image
 *  positions ARE the two atoms' exact cartesian coordinates) — respects
 *  whatever produced it (element/force/length colour mode, category style, or
 *  a per-bond override), same as the main view, rather than assuming a bond
 *  is always coloured by its endpoint atoms. Returns null if no matching bond
 *  is found (e.g. bonds hidden/not yet built), so callers can fall back. */
function findBondHalfColors(structure, centerPos, vertexPos) {
  const bonds = structure?.bonds;
  if (!bonds?.length) return null;
  const ck = posKey(centerPos);
  const vk = posKey(vertexPos);
  for (const bond of bonds) {
    const pos = bond?.positions;
    if (!pos || pos.length !== 2) continue;
    const k0 = posKey(pos[0]);
    const k1 = posKey(pos[1]);
    const colorAt = (i) => normalizeColorHex(bond.userColor?.[i] ?? bond.color?.[i]);
    if (k0 === ck && k1 === vk) return { centerHex: colorAt(0), vertexHex: colorAt(1) };
    if (k0 === vk && k1 === ck) return { centerHex: colorAt(1), vertexHex: colorAt(0) };
  }
  return null;
}

function angleAtCenterDeg(center, p, q) {
  const v1 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
  const v2 = [q[0] - center[0], q[1] - center[1], q[2] - center[2]];
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const n1 = Math.hypot(...v1), n2 = Math.hypot(...v2);
  if (n1 < 1e-9 || n2 < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (n1 * n2)));
  return Math.acos(cos) * (180 / Math.PI);
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

const TETRAHEDRAL_IDEAL_DEG = 109.4712206;
const OCTAHEDRAL_IDEAL_DEG = 90;

function sampleVariance(values, ideal) {
  if (values.length < 2) return null;
  const sq = values.reduce((s, v) => s + (v - ideal) ** 2, 0);
  return sq / (values.length - 1);
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
 *   bld:number|null, angleVariance:number|null, angleLabel:string|null} | null}
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
  const vertices = poly.vertices.map((pos, i) => {
    const srcIndex = vertexSrcList[i];
    const element = Number.isInteger(srcIndex) ? (structure.elements?.[srcIndex] ?? null) : null;
    const bondColors = centerCart ? findBondHalfColors(structure, centerCart, pos) : null;
    return {
      pos, srcIndex, element,
      bondLength: centerCart ? dist3(pos, centerCart) : null,
      color: Number.isInteger(srcIndex) ? atomColorHex(structure, srcIndex) : null,
      radius: Number.isInteger(srcIndex) ? renderedAtomRadius(structure, srcIndex, element) : 0.5,
      // The actual rendered bond half-colours (may differ from the endpoint
      // atoms' own colours — bond length/category/user-override colouring),
      // null when no matching bond is found so callers fall back to atom colour.
      bondColorNear: bondColors?.centerHex ?? null,
      bondColorFar: bondColors?.vertexHex ?? null,
    };
  });

  let angles = [];
  if (centerCart) {
    if (cn === 4) angles = tetrahedralAngles(centerCart, poly.vertices);
    else if (cn === 6) angles = octahedralAngles(centerCart, poly.vertices);
  }

  let bld = null;
  if (centerCart) {
    const dists = vertices.map((v) => v.bondLength);
    const avg = dists.reduce((a, b) => a + b, 0) / dists.length;
    bld = avg > 1e-9 ? dists.reduce((s, d) => s + Math.abs(d - avg), 0) / dists.length / avg : null;
  }
  let angleVariance = null, angleLabel = null;
  if (cn === 4 && centerCart) {
    angleVariance = sampleVariance(angles.map((a) => a.angleDeg), TETRAHEDRAL_IDEAL_DEG);
    angleLabel = 'TAV';
  } else if (cn === 6 && centerCart) {
    angleVariance = sampleVariance(angles.filter((a) => a.kind === 'cis').map((a) => a.angleDeg), OCTAHEDRAL_IDEAL_DEG);
    angleLabel = 'OAV';
  }

  const style = resolvePolyhedronStyle(
    structure, poly.key, poly.catKey, poly.type, poly.centerIndex, poly.colorElem);

  return {
    type: poly.type, cn, catKey: poly.catKey, catLabel: poly.catLabel,
    centerCart, centerElement: isCentered ? (poly.centerElement ?? null) : null,
    centerIndex: isCentered ? poly.centerIndex : null,
    centerColor: isCentered ? atomColorHex(structure, poly.centerIndex) : null,
    centerRadius: isCentered ? renderedAtomRadius(structure, poly.centerIndex, poly.centerElement) : null,
    faceColor: style.color, faceOpacity: style.opacity, edgeColor: style.edgeColor,
    vertices, angles, bld, angleVariance, angleLabel,
  };
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

/** @returns {Array<{sharing:string, catKeyA:string, catKeyB:string, labelA:string, labelB:string,
 *   polyIndexA:number, polyIndexB:number, sharedCount:number, bridgeAtomIndices:number[],
 *   highlightAtomIndices:number[], highlightBondInstanceIds:number[]}>} deduplicated
 *   distinct physical connections. For corner/edge/face sharing, highlightAtomIndices is
 *   just the shared vertex atom(s) (the "corners"); for bond1/bond2 bridges,
 *   highlightBondInstanceIds is the rendered bond instance id(s) that realize the link —
 *   the 3D highlight is meant to show the LINK itself, not every atom of both polyhedra. */
export function computePolyhedraConnectivity(structure) {
  const model = structure?.polyhedra;
  const polys = model?.polyhedra ?? [];
  if (polys.length < 2) return [];
  const bonds = structure?.bonds ?? [];
  const lattice = structure.lattice;
  const latInv = lattice ? invert3x3(transpose3x3(lattice)) : null;

  // ---- vertex-position index across all instances: posKey -> [polyIndex, ...] ----
  const vertexIndex = new Map();
  const vertexPosSets = new Array(polys.length); // polyIndex -> Set(posKey) of its own vertices
  const posToSrcAtom = new Map(); // posKey -> source atom index (same physical atom everywhere)
  // Own-atom position sets (vertices + centre, when present) — used to keep the
  // trimer bridge search from tracing a vertex back through its OWN polyhedron's
  // centre and back out again, which isn't a genuine third bridging atom.
  const ownPosSets = new Array(polys.length);
  // Every polyhedron's centre position, structure-wide — the trimer bridge
  // search excludes these as candidate intermediates (see below): hopping
  // through ANOTHER polyhedron's own centre is really two hops of
  // corner-sharing-like connectivity through a third coordination cluster, not
  // the free-ligand bridging atom the trimer category is meant to capture
  // (e.g. a bridging N in a nitride, which is a vertex/ligand species, not a
  // polyhedron centre itself).
  const allCenterPosKeys = new Set();
  polys.forEach((poly, polyIndex) => {
    const set = new Set();
    vertexPosSets[polyIndex] = set;
    poly.vertices.forEach((v, vi) => {
      const key = posKey(v);
      set.add(key);
      if (!vertexIndex.has(key)) vertexIndex.set(key, []);
      vertexIndex.get(key).push(polyIndex);
      const src = poly.vertexSrcList?.[vi];
      if (Number.isInteger(src)) posToSrcAtom.set(key, src);
    });
    const ownSet = new Set(set);
    if (latInv) {
      const centerCart = polyhedronCenterCart(structure, poly, lattice, latInv);
      if (centerCart) { ownSet.add(posKey(centerCart)); allCenterPosKeys.add(posKey(centerCart)); }
    }
    ownPosSets[polyIndex] = ownSet;
  });

  const pairKeyOf = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  // ---- shared-vertex positions per instance pair ----
  /** @type {Map<string, {a:number,b:number,posKeys:Set<string>}>} */
  const sharedByPair = new Map();
  for (const [key, polyIndices] of vertexIndex) {
    if (polyIndices.length < 2) continue;
    const uniq = [...new Set(polyIndices)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = uniq[i], b = uniq[j];
        const pk = pairKeyOf(a, b);
        let e = sharedByPair.get(pk);
        if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), posKeys: new Set() }; sharedByPair.set(pk, e); }
        e.posKeys.add(key);
      }
    }
  }

  // ---- bond graph by position (reuses the already-computed, periodic-correct
  //      rendered bonds — a bridge is only real if an actual bond realizes it). ----
  /** @type {Map<string, Array<{pos:number[], srcIdx:number, bond:any}>>} */
  const posToNeighbors = new Map();
  const addEdge = (fromKey, toPos, toSrc, bond) => {
    if (!posToNeighbors.has(fromKey)) posToNeighbors.set(fromKey, []);
    posToNeighbors.get(fromKey).push({ pos: toPos, srcIdx: toSrc, bond });
  };
  for (const bond of bonds) {
    if (!bond?.positions || bond.positions.length !== 2 || !bond.srcIndices) continue;
    const [p1, p2] = bond.positions;
    const [s1, s2] = bond.srcIndices;
    addEdge(posKey(p1), p2, s2, bond);
    addEdge(posKey(p2), p1, s1, bond);
  }

  // ---- centroid + reach (max centre-to-vertex distance) per instance, for a
  //      cheap prefilter before the bridge search. ----
  const centroids = polys.map((poly) => centroidOf(poly.vertices));
  const reach = polys.map((poly, i) => {
    const c = centroids[i];
    return poly.vertices.reduce((m, v) => Math.max(m, dist3(v, c)), 0);
  });
  const maxBondSpan = bonds.reduce((m, b) => Math.max(m, b.dist || 0), 0) || 3.5;
  const bridgeSearchSlack = 2 * maxBondSpan + 0.5;

  /** @type {Map<string, {sharing:string, a:number, b:number, sharedPosKeys:Set<string>,
   *   bridgeAtomIndices:Set<number>, bridgeBonds:Set<any>}>} */
  const rawConnections = new Map();
  for (const { a, b, posKeys } of sharedByPair.values()) {
    const sharing = posKeys.size >= 3 ? 'face' : posKeys.size === 2 ? 'edge' : 'corner';
    rawConnections.set(pairKeyOf(a, b), {
      sharing, a, b, sharedPosKeys: posKeys, bridgeAtomIndices: new Set(), bridgeBonds: new Set(),
    });
  }

  // ---- bond-bridge search for instance pairs that don't already share a vertex ----
  for (let a = 0; a < polys.length; a++) {
    for (let b = a + 1; b < polys.length; b++) {
      const key = pairKeyOf(a, b);
      if (rawConnections.has(key)) continue;
      const centroidDist = dist3(centroids[a], centroids[b]);
      if (centroidDist > reach[a] + reach[b] + bridgeSearchSlack) continue;

      const vertexSetB = vertexPosSets[b];
      const ownSetA = ownPosSets[a], ownSetB = ownPosSets[b];
      let bridge = null;

      // Direct (1-bond) bridge: a vertex of A is bonded straight to a vertex of B.
      outerDirect:
      for (const vA of polys[a].vertices) {
        const neighbors = posToNeighbors.get(posKey(vA));
        if (!neighbors) continue;
        for (const nb of neighbors) {
          if (vertexSetB.has(posKey(nb.pos))) {
            bridge = { sharing: 'bond1', srcs: [], bonds: [nb.bond] };
            break outerDirect;
          }
        }
      }

      // Trimer (2-bond) bridge via one intermediate atom that isn't itself part
      // of A or B (a vertex OR the centre — otherwise this would just retrace a
      // vertex back through its own polyhedron's centre and back out), and isn't
      // ANOTHER polyhedron's centre either (that would just be two hops through a
      // third coordination cluster, not a genuine free-ligand bridge).
      if (!bridge) {
        outerTrimer:
        for (const vA of polys[a].vertices) {
          const firstHop = posToNeighbors.get(posKey(vA));
          if (!firstHop) continue;
          for (const x of firstHop) {
            const xKey = posKey(x.pos);
            if (ownSetA.has(xKey) || ownSetB.has(xKey)) continue;
            if (allCenterPosKeys.has(xKey)) continue;
            const secondHop = posToNeighbors.get(xKey);
            if (!secondHop) continue;
            for (const nb of secondHop) {
              if (vertexSetB.has(posKey(nb.pos))) {
                bridge = { sharing: 'bond2', srcs: [x.srcIdx], bonds: [x.bond, nb.bond] };
                break outerTrimer;
              }
            }
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
  //      only the strongest finding is kept — never both. ----
  /** @type {Map<string, any>} */
  const dedup = new Map();
  for (const conn of rawConnections.values()) {
    const A = polys[conn.a], B = polys[conn.b];
    const gA = A.groupKey ?? `i:${conn.a}`, gB = B.groupKey ?? `i:${conn.b}`;
    let rel = [
      centroids[conn.b][0] - centroids[conn.a][0],
      centroids[conn.b][1] - centroids[conn.a][1],
      centroids[conn.b][2] - centroids[conn.a][2],
    ];
    let ga = gA, gb = gB, polyIndexA = conn.a, polyIndexB = conn.b, catA = A.catKey, catB = B.catKey,
      labelA = A.catLabel, labelB = B.catLabel;
    if (gA !== gB && gA > gB) {
      [ga, gb] = [gB, gA];
      rel = rel.map((x) => -x);
      [polyIndexA, polyIndexB] = [polyIndexB, polyIndexA];
      [catA, catB] = [catB, catA];
      [labelA, labelB] = [labelB, labelA];
    }
    const q = rel.map((x) => Math.round(x * 1000));
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
