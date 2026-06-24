import * as THREE from '../external/three/three.module.js';
import { ConvexGeometry } from '../external/three/ConvexGeometry.js';
import { ConvexHull } from '../external/three/ConvexHull.js';
import {app,general,groups, fileBrowser} from '../state/store.js'
import { fracToCart, cartToFrac, invert3x3, transpose3x3 } from '../math/index.js'
import { getBondCutoff} from '../render/BondsFracUpdateModule.js'
import {disposeGroup} from '../ui/WindowAndSceneControls.js'
import { Polyhedra } from '../model/Polyhedra.js'
import { Polyhedron } from '../model/Polyhedron.js'
import { getCutPlaneMaskSign } from '../model/Plane.js'
import { voronoiNeighbours } from '../render/VoronoiNeighbours.js'
import { atomicRadii } from '../defaults/radii_defaults.js'
import { electronegativity } from '../defaults/electronegativity_defaults.js'
import { computePolyhedraWasm } from '../compiled/polyhedraWasm.js'

// ---------- STYLE (render) ----------
const FACE_OPACITY = 0.50;
const EDGE_OPACITY = Math.min(1, FACE_OPACITY + 0.35);
const FACE_FALLBACK_COLOR = 0x00aaff;
const EDGE_COLOR = 0x006c99;
const EDGE_ANGLE = 18;
const DOUBLE_SIDE = true;
const DEPTH_WRITE = false;
const POLY_OFFSET = true;
const POLY_OFFSET_FACTOR = 1;
const POLY_OFFSET_UNITS = 1;

// ---------- BEHAVIOR (compute) ----------
// Cages (uncentered): **includes N = 20 dodecahedra**
const ALLOW_CAGES = true;
const CAGE_TARGET_NS_DESC = [20, 12, 10, 8, 6, 4]; // 20 first for dodecahedron cages
const CAGE_BFS_DEPTH = 5; // a bit deeper to ensure we hit full N=20 shells

// Distortion tolerance (cages only — see centered note below). Kept loose so
// genuinely distorted-but-complete shells are not dropped.
const MAX_EDGE_SPREAD = 1.60;      // max(edge)/min(edge) ≤ 1.60
const MIN_THICKNESS_RATIO = 0.08;  // very lenient anti-flatness (e_min / e_max)
const MIN_CENTER_FACE_CLEARANCE_REL = 0.10; // min portion of atomic radius between center and any face (to avoid near-degenerate centered polyhedra)

// Centered neighbour selection: radical Voronoi + solid-angle (see VoronoiNeighbours.js).
// There is no universal "official" cutoff — these are the tunables.
const VORONOI_RADICAL = true;       // weight planes by atomic radii (power/radical Voronoi)
const VORONOI_SOLID_ANGLE_REL = 0.10; // keep faces ≥ this fraction of the largest face
// Candidate-gather radius around a centre (all species, so closer atoms can shadow
// farther ones). Generous enough to bound the Voronoi cell; the cell math then
// ignores far atoms. Clamped so it stays cheap.
function searchRadius(maxCutoff) {
  return Math.min(8.0, Math.max(4.0, 2.5 * maxCutoff));
}

// Chemical filter: a polyhedron vertex must be MORE electronegative than the
// centre, i.e. the anion/ligand coordinates the cation (and a cation never
// coordinates another cation, nor does an anion-centred polyhedron form). When an
// electronegativity value is missing for either element, fall back to requiring a
// different species (which at least blocks the Ti-around-Ti case).
function isLigandOf(nbrElem, centerElem, filterByElectronegativity = true) {
  const enN = electronegativity[nbrElem];
  const enC = electronegativity[centerElem];
  if (enN === undefined || enC === undefined || enN === 0 || enC === 0 || !filterByElectronegativity) {
    return nbrElem !== centerElem;
  }
  return enN > enC + 1e-6;
}

// ConvexGeometry constructor (vendored addon; fall back to THREE.ConvexGeometry if present)
const ConvexGeomCtor = (typeof ConvexGeometry !== 'undefined')
  ? ConvexGeometry
  : (THREE && THREE.ConvexGeometry ? THREE.ConvexGeometry : null);

// Face color for a coordination polyhedron: the central element's atom color
// (falls back to the default blue if unavailable). Previously referenced via a
// `typeof getElementColor === 'function'` guard but never actually defined, so
// polyhedra always rendered with the fallback color.
function getElementColor(element) {
  const colors = fileBrowser.selectedStructure?.getElementColors?.()[element];
  return (colors && colors.length) ? colors[0] : FACE_FALLBACK_COLOR;
}

// Minimal induced degree per cage size (tune as needed)
function minVertexDegreeForCageSize(N) {
  if (N === 12) return 5; // B12 icosahedral cage in boron carbide
  if (N === 20) return 3; // 20-vertex dodecahedron (degree 3)
  if (N === 10) return 3;
  if (N === 8)  return 3;
  if (N === 6)  return 3;
  if (N === 4)  return 2;
  return 3;
}

// ---------- Helpers ----------
function thicknessRatio(points) {
  const mean = points.reduce((acc,p)=>acc.add(p), new THREE.Vector3()).multiplyScalar(1/points.length);
  const rel  = points.map(p=>p.clone().sub(mean));
  let xx=0,xy=0,xz=0, yy=0,yz=0, zz=0;
  for (const v of rel) { const x=v.x,y=v.y,z=v.z; xx+=x*x; xy+=x*y; xz+=x*z; yy+=y*y; yz+=y*z; zz+=z*z; }
  const n = Math.max(1, rel.length);
  xx/=n; xy/=n; xz/=n; yy/=n; yz/=n; zz/=n;
  const m00=xx, m01=xy, m02=xz, m11=yy, m12=yz, m22=zz;
  const p1 = m01*m01 + m02*m02 + m12*m12;
  let eMin=0,eMax=0;
  if (p1 <= 1e-18) { const e=[m00,m11,m22].sort((a,b)=>a-b); eMin=e[0]; eMax=e[2]; }
  else {
    const q=(m00+m11+m22)/3;
    let p2=(m00-q)*(m00-q)+(m11-q)*(m11-q)+(m22-q)*(m22-q)+2*p1;
    const p=Math.sqrt(p2/6);
    const b00=(m00-q)/p, b01=m01/p,   b02=m02/p;
    const b10=m01/p,   b11=(m11-q)/p, b12=m12/p;
    const b20=m02/p,   b21=m12/p,     b22=(m22-q)/p;
    const detB = b00*(b11*b22-b12*b21)-b01*(b10*b22-b12*b20)+b02*(b10*b21-b11*b20);
    const r = Math.max(-1, Math.min(1, detB/2));
    const phi = Math.acos(r)/3;
    const eig1 = q + 2*p*Math.cos(phi);
    const eig3 = q + 2*p*Math.cos(phi + 2*Math.PI/3);
    const eig2 = 3*q - eig1 - eig3;
    const ev=[eig1,eig2,eig3].sort((a,b)=>a-b);
    eMin=ev[0]; eMax=ev[2];
  }
  return eMin / Math.max(1e-12, eMax);
}

function edgeSpreadOK(geom) {
  const egeom = new THREE.EdgesGeometry(geom, EDGE_ANGLE);
  const pos = egeom.getAttribute('position');
  let minL = Infinity, maxL = 0;
  for (let i=0; i<pos.count; i+=2) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, i);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i+1);
    const L = a.distanceTo(b);
    if (L < minL) minL = L;
    if (L > maxL) maxL = L;
  }
  egeom.dispose();
  if (!isFinite(minL) || minL <= 1e-9) return false;
  return (maxL / minL) <= MAX_EDGE_SPREAD;
}

function pointInsideConvexGeometry(p, geom, eps=1e-6) {
  const pos = geom.getAttribute('position');
  const idx = geom.getIndex();
  if (!pos) return false;
  const pc = new THREE.Vector3();
  for (let i=0;i<pos.count;i++) pc.add(new THREE.Vector3().fromBufferAttribute(pos, i));
  pc.multiplyScalar(1/pos.count);
  const triCount = idx ? idx.count/3 : pos.count/3;
  for (let t=0; t<triCount; t++) {
    const i0 = idx ? idx.getX(3*t+0) : 3*t+0;
    const i1 = idx ? idx.getX(3*t+1) : 3*t+1;
    const i2 = idx ? idx.getX(3*t+2) : 3*t+2;
    const a = new THREE.Vector3().fromBufferAttribute(pos, i0);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, i2);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.lengthSq() < 1e-18) continue;
    const outward = Math.sign(n.dot(a.clone().sub(pc))) || 1;
    n.multiplyScalar(outward);
    const s = n.dot(new THREE.Vector3().subVectors(p, a));
    if (s > eps) return false;
  }
  return true;
}

function centeredHullIsAcceptable(centerPos, centerRadius, posList, eps = 1e-6) {
  const hull = new ConvexHull().setFromPoints(posList);
  if (!hull.containsPoint(centerPos)) return false;

  const minClearance = MIN_CENTER_FACE_CLEARANCE_REL * Math.max(centerRadius, 0);
  for (const face of hull.faces) {
    const signedDistance = face.distanceToPoint(centerPos);
    if (signedDistance > eps) return false;
    if (-signedDistance < minClearance - eps) return false;
  }

  return true;
}

function imageKey(src, shift) {
  return `${src}:${shift[0]},${shift[1]},${shift[2]}`;
}

function getActiveCutPlanes() {
  return (general.atomCutPlanes || []).filter((plane) => plane?.enabled);
}

function normalizeCutPlaneNormal(x = 1, y = 0, z = 0) {
  const nx = Number(x) || 0;
  const ny = Number(y) || 0;
  const nz = Number(z) || 0;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-8) return [1, 0, 0];
  return [nx / length, ny / length, nz / length];
}

function isPointCutByPlanes(position, cutPlanes) {
  if (!Array.isArray(position) || position.length < 3) return false;
  return cutPlanes.some((plane) => {
    const [nx, ny, nz] = normalizeCutPlaneNormal(plane.x, plane.y, plane.z);
    const maskSign = getCutPlaneMaskSign(plane.side);
    const planeSide = ((position[0] * nx) + (position[1] * ny) + (position[2] * nz) - (Number(plane.r) || 0)) * maskSign;
    return planeSide > 0;
  });
}

function isAtomImageVisible(position, atom, cutPlanes) {
  if (!cutPlanes.length) return true;
  if (atom?.cutPlaneImmune) return true;
  return !isPointCutByPlanes(position, cutPlanes);
}

// Spherical farthest-point sampling: pick N vertices well spread (angle-based)
function pickSpreadSubset(points, N) {
  if (points.length < N) return null;
  let aIdx = 0, bIdx = 1, best = -1;
  for (let i=0;i<points.length;i++) for (let j=i+1;j<points.length;j++) {
    const d = points[i].distanceToSquared(points[j]);
    if (d > best) { best = d; aIdx=i; bIdx=j; }
  }
  const chosenIdx = [aIdx, bIdx];
  while (chosenIdx.length < N) {
    let bestIdx=-1, bestScore=-Infinity;
    for (let i=0;i<points.length;i++) {
      if (chosenIdx.includes(i)) continue;
      let minD = Infinity;
      for (const j of chosenIdx) {
        const d = points[i].distanceToSquared(points[j]);
        if (d < minD) minD = d;
      }
      if (minD > bestScore) { bestScore = minD; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    chosenIdx.push(bestIdx);
  }
  if (chosenIdx.length < N) return null;
  return chosenIdx.map(k => points[k]);
}

function quantile(sortedArr, q) {
  if (!sortedArr.length) return 0;
  const i = (sortedArr.length - 1) * q;
  const i0 = Math.floor(i), i1 = Math.min(sortedArr.length - 1, i0 + 1);
  const t = i - i0;
  return sortedArr[i0] * (1 - t) + sortedArr[i1] * t;
}

function inducedDegreeOK(adjacency, selSrcs, minDeg) {
  const set = new Set(selSrcs);
  for (const u of selSrcs) {
    const nb = adjacency.get(u) || new Set();
    let deg = 0;
    for (const v of nb) if (set.has(v) && v !== u) deg++;
    if (deg < minDeg) return false;
  }
  return true;
}

/**
 * Compute coordination polyhedra for a structure and return them as a model
 * `Polyhedra` (plain data; no GPU resources). ConvexGeometry is used transiently
 * here only to validate shape and test nesting; the hull is rebuilt for display
 * in {@link renderPolyhedra}.
 *
 * @param {any} structure active Structure (needs `atoms`, `elements`, `lattice`)
 * @returns {Polyhedra}
 */
export function computePolyhedra(structure) {
  if (!ConvexGeomCtor) {
    console.error('[computePolyhedra] ConvexGeometry missing. Load examples/jsm/geometries/ConvexGeometry.js');
    return new Polyhedra({ polyhedra: [] });
  }

  const useChemicalFilter = structure?.polyhedraSettings?.useChemicalFilter !== false;
  const detectCages = structure?.polyhedraSettings?.detectCages !== false;

  // ---------- Perf timing ----------
  const _t0 = performance.now();
  let _tSetup = _t0, _tCentered = _t0, _tCages = _t0;
  let _cagePoolMs = 0; // time spent building per-seed BFS pools (subset of cages)

  // ---------- Periodic-image neighbour graph ----------
  const positions = structure.atoms.map(a => a.position); // fractional
  const elements = [...structure.elements];
  const lattice = structure.lattice.map(r => [...r]);

  // Lattice vectors + primary-cell Cartesian positions of every atom.
  const a = new THREE.Vector3(lattice[0][0], lattice[0][1], lattice[0][2]);
  const b = new THREE.Vector3(lattice[1][0], lattice[1][1], lattice[1][2]);
  const c = new THREE.Vector3(lattice[2][0], lattice[2][1], lattice[2][2]);
  const baseCart = fracToCart(positions, lattice).map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const nAtoms = baseCart.length;
  const latInv = invert3x3(transpose3x3(lattice));
  const dispWrapped = structure.periodic?.wrapped;
  const activeCutPlanes = getActiveCutPlanes();

  // Build the set of atom images that are actually visible to the user right now.
  // This comes only from `structure.periodic.wrapped`, which is the shared display
  // surface used by the atom renderer and is already expanded by the periodic-image
  // and neighbour-bond toggles upstream.
  //
  // Consequence for centered polyhedra:
  // - If a periodic image is present in `wrapped`, that image is allowed to act as
  //   its own vertex in a centered shell.
  // - If a periodic image is NOT present in `wrapped`, it is treated as invisible
  //   and is not allowed to create an extra shell vertex here.
  // - If there is no wrapped data at all, fall back to the primary-cell view only.
  const visibleImageKeys = new Set();
  const visibleImageCountsBySource = new Map();
  /** @type {Array<{cart:THREE.Vector3, src:number, shift:[number,number,number]}>} */
  let displayCenters = [];
  if (dispWrapped?.frac?.length && dispWrapped?.srcIndex?.length) {
    for (let i = 0; i < dispWrapped.frac.length; i++) {
      const src = dispWrapped.srcIndex[i];
      if (!Number.isInteger(src) || src < 0 || src >= positions.length) continue;
      const frac = dispWrapped.frac[i];
      if (!Array.isArray(frac) || frac.length < 3) continue;
      const cart = dispWrapped?.cart?.[i];
      const cartVec = cart instanceof THREE.Vector3
        ? cart.clone()
        : new THREE.Vector3(
            Number(cart?.[0] ?? frac[0]) || 0,
            Number(cart?.[1] ?? frac[1]) || 0,
            Number(cart?.[2] ?? frac[2]) || 0,
          );
      if (!isAtomImageVisible(cartVec.toArray(), structure.atoms[src], activeCutPlanes)) continue;
      const shift = /** @type {[number,number,number]} */ ([
        Math.round(frac[0] - positions[src][0]),
        Math.round(frac[1] - positions[src][1]),
        Math.round(frac[2] - positions[src][2]),
      ]);
      const key = imageKey(src, shift);
      visibleImageKeys.add(key);
      visibleImageCountsBySource.set(src, (visibleImageCountsBySource.get(src) || 0) + 1);
      displayCenters.push({ cart: cartVec, src, shift });
    }
  }
  if (!visibleImageKeys.size) {
    for (let i = 0; i < nAtoms; i++) {
      if (!isAtomImageVisible(baseCart[i].toArray(), structure.atoms[i], activeCutPlanes)) continue;
      visibleImageKeys.add(imageKey(i, [0, 0, 0]));
      visibleImageCountsBySource.set(i, 1);
      displayCenters.push({ cart: baseCart[i].clone(), src: i, shift: [0, 0, 0] });
    }
  }

  // Largest configured bond cutoff — bounds the neighbour-image search range.
  const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || {}).map(v => (typeof v === 'number' ? v : (v?.max ?? 0))), 0.0);

  // ---------- WASM compute path (toggle; falls back to JS below) ----------
  // The display-coupled prep above (displayCenters, visibleImageKeys, maxCutoff)
  // is shared; everything below is the heavy geometry, which the Rust port does
  // in one call. On any failure we fall through to the pure-JS implementation.
  if (general.useWasmPolyhedra) {
    try {
      const seedVisible = new Uint8Array(nAtoms);
      for (let i = 0; i < nAtoms; i++) {
        seedVisible[i] = isAtomImageVisible(baseCart[i].toArray(), structure.atoms[i], activeCutPlanes) ? 1 : 0;
      }
      const { polyhedra: wasmPolys, timing } = computePolyhedraWasm({
        positions, elements, lattice, maxCutoff,
        useChemicalFilter, detectCages,
        displayCenters, visibleImageKeys, seedVisible, getBondCutoff,
      });
      const accepted = wasmPolys.map(p => new Polyhedron(p));
      const ms = (x) => x.toFixed(1);
      console.log(
        `[polyhedra] WASM total=${ms(performance.now() - _t0)}ms ` +
        `(setup=${ms(timing.setup)} centered=${ms(timing.centered)}[voronoi=${ms(timing.centeredVoronoi)}] ` +
        `cages=${ms(timing.cages)}(pool=${ms(timing.cagePool)} band=${ms(timing.cageBand)}[kcore=${ms(timing.bandKcore)} built=${timing.bandsBuilt} skip=${timing.bandsSkipped}] nloop=${ms(timing.cageNloop)}) ` +
        `accept=${ms(timing.accept)}) | ` +
        `atoms=${nAtoms} centers=${displayCenters.length} ` +
        `accepted=${accepted.length} detectCages=${detectCages}`
      );
      return new Polyhedra({ polyhedra: accepted });
    } catch (err) {
      console.warn('[computePolyhedra] WASM path failed; falling back to JS:', err);
    }
  }

  // Guaranteed-complete image range per axis (JS path): how many cells the largest
  // bond cutoff can reach, using the cell's perpendicular widths d = V/|b×c| so no
  // neighbour image is ever missed, even for skewed cells.
  const cellVol = Math.abs(a.dot(new THREE.Vector3().crossVectors(b, c)));
  const widthA = cellVol / Math.max(new THREE.Vector3().crossVectors(b, c).length(), 1e-9);
  const widthB = cellVol / Math.max(new THREE.Vector3().crossVectors(c, a).length(), 1e-9);
  const widthC = cellVol / Math.max(new THREE.Vector3().crossVectors(a, b).length(), 1e-9);
  const nA = Math.max(1, Math.ceil(maxCutoff / Math.max(widthA, 1e-6)));
  const nB = Math.max(1, Math.ceil(maxCutoff / Math.max(widthB, 1e-6)));
  const nC = Math.max(1, Math.ceil(maxCutoff / Math.max(widthC, 1e-6)));

  /**
   * Every periodic image of any atom that lies within its bond cutoff of point P
   * (which may sit anywhere, not only in the primary cell). Searches the ±n image
   * ring around the cell containing P, so it stays complete even far from origin.
   * @param {THREE.Vector3} P
   * @param {string} elem element symbol at P (for the cutoff lookup)
   * @returns {Array<{srcJ:number, shift:[number,number,number], pos:THREE.Vector3, d:number}>}
   */
  // Per-center-element bond-cutoff rows, memoized. `getBondCutoff` rebuilds a
  // string key on every call and sits in the hottest neighbour loops, so cache
  // an nAtoms-long row of cutoffs for each distinct centre element.
  /** @type {Map<string, Float64Array>} */
  const cutoffRowCache = new Map();
  function cutoffRow(elem) {
    let row = cutoffRowCache.get(elem);
    if (!row) {
      row = new Float64Array(nAtoms);
      for (let j = 0; j < nAtoms; j++) row[j] = getBondCutoff(elem, elements[j]);
      cutoffRowCache.set(elem, row);
    }
    return row;
  }

  function neighborImages(P, elem) {
    const fp = cartToFrac([P.x, P.y, P.z], lattice, latInv);
    const out = [];
    const cuts = cutoffRow(elem);
    for (const j of cellCandidates(fp, nbHaloX, nbHaloY, nbHaloZ)) {
      const cutoff = cuts[j];
      if (cutoff <= 1e-3) continue;
      const fj = positions[j];
      const c0 = Math.round(fp[0] - fj[0]);
      const c1 = Math.round(fp[1] - fj[1]);
      const c2 = Math.round(fp[2] - fj[2]);
      for (let dx = c0 - nA; dx <= c0 + nA; dx++)
        for (let dy = c1 - nB; dy <= c1 + nB; dy++)
          for (let dz = c2 - nC; dz <= c2 + nC; dz++) {
            const q = baseCart[j].clone().addScaledVector(a, dx).addScaledVector(b, dy).addScaledVector(c, dz);
            const d = q.distanceTo(P);
            if (d > cutoff || d < 1e-4) continue;
            out.push({ srcJ: j, shift: /** @type {[number,number,number]} */ ([dx, dy, dz]), pos: q, d });
          }
    }
    return out;
  }

  // All atom images (any species) within `radius` of point P — used to gather
  // Voronoi candidates for a centre. Unlike neighborImages this is NOT limited to
  // bonded pairs, because a closer non-bonded atom must still be able to shadow a
  // farther one for the Voronoi cell to be correct.
  const R = searchRadius(maxCutoff);
  const mA = Math.max(1, Math.ceil(R / Math.max(widthA, 1e-6)));
  const mB = Math.max(1, Math.ceil(R / Math.max(widthB, 1e-6)));
  const mC = Math.max(1, Math.ceil(R / Math.max(widthC, 1e-6)));
  /**
   * @param {THREE.Vector3} P
   * @returns {Array<{srcJ:number, shift:[number,number,number], pos:THREE.Vector3, d:number, elem:string, radius:number}>}
   */
  function gatherWithin(P) {
    const fp = cartToFrac([P.x, P.y, P.z], lattice, latInv);
    const out = [];
    for (const j of cellCandidates(fp, gwHaloX, gwHaloY, gwHaloZ)) {
      const fj = positions[j];
      const c0 = Math.round(fp[0] - fj[0]);
      const c1 = Math.round(fp[1] - fj[1]);
      const c2 = Math.round(fp[2] - fj[2]);
      for (let dx = c0 - mA; dx <= c0 + mA; dx++)
        for (let dy = c1 - mB; dy <= c1 + mB; dy++)
          for (let dz = c2 - mC; dz <= c2 + mC; dz++) {
            const q = baseCart[j].clone().addScaledVector(a, dx).addScaledVector(b, dy).addScaledVector(c, dz);
            const d = q.distanceTo(P);
            if (d > R || d < 1e-4) continue;
            out.push({ srcJ: j, shift: /** @type {[number,number,number]} */ ([dx, dy, dz]), pos: q, d, elem: elements[j], radius: atomicRadii[elements[j]] || 1.0 });
          }
    }
    return out;
  }

  // ---------- Spatial cell list (shared neighbour acceleration) ----------
  // Both scans above are O(atoms) per query → O(atoms²) overall, which dominates
  // large structures. Bin every atom by its wrapped fractional cell into a grid,
  // then a query only inspects atoms in the surrounding ±halo bins (with periodic
  // wrap) instead of all of them. The grid is sized by the smaller (bond) radius so
  // the per-atom periodic-image distance test below is still run unchanged on each
  // candidate — so emitted neighbours are byte-for-byte identical, just far fewer
  // atoms are visited. The halo is computed from each query's own radius, so the
  // wide gatherWithin radius scans more bins than the tight neighborImages radius.
  const binRadius = Math.max(maxCutoff, 1.5);
  const Gx = Math.max(1, Math.floor(widthA / binRadius));
  const Gy = Math.max(1, Math.floor(widthB / binRadius));
  const Gz = Math.max(1, Math.floor(widthC / binRadius));
  const binWA = widthA / Gx, binWB = widthB / Gy, binWC = widthC / Gz;
  // Per-axis halo (in bins) for the two query radii. floor(ρ/binW)+1 is the exact
  // worst-case bin span (the +1 absorbs the floor-binning offset of the two points,
  // which a bare ceil would miss at integer ratios). For the tight bond radius this
  // is just 1, so the hot setup scan pays nothing extra.
  const nbHaloX = Math.floor(maxCutoff / binWA) + 1; // neighborImages (bond cutoff)
  const nbHaloY = Math.floor(maxCutoff / binWB) + 1;
  const nbHaloZ = Math.floor(maxCutoff / binWC) + 1;
  const gwHaloX = Math.floor(R / binWA) + 1;         // gatherWithin (search radius)
  const gwHaloY = Math.floor(R / binWB) + 1;
  const gwHaloZ = Math.floor(R / binWC) + 1;
  /** @type {number[][]} */
  const cellBins = new Array(Gx * Gy * Gz);
  for (let bi = 0; bi < cellBins.length; bi++) cellBins[bi] = [];
  const wrapBin = (f, G) => {
    let g = Math.floor((f - Math.floor(f)) * G);
    if (g >= G) g = G - 1; else if (g < 0) g = 0;
    return g;
  };
  for (let j = 0; j < nAtoms; j++) {
    const gx = wrapBin(positions[j][0], Gx);
    const gy = wrapBin(positions[j][1], Gy);
    const gz = wrapBin(positions[j][2], Gz);
    cellBins[(gx * Gy + gy) * Gz + gz].push(j);
  }
  // Per-query dedup via a stamp array (avoids allocating a Set per query).
  const _cellStamp = new Int32Array(nAtoms).fill(-1);
  let _cellQueryId = 0;
  const axisRange = (g, halo, G) => {
    if (2 * halo + 1 >= G) { const r = new Array(G); for (let i = 0; i < G; i++) r[i] = i; return r; }
    const r = new Array(2 * halo + 1);
    for (let d = -halo, k = 0; d <= halo; d++, k++) r[k] = ((g + d) % G + G) % G;
    return r;
  };
  /**
   * Atom indices whose nearest periodic image could lie within `halo` bins of
   * fractional point `fp`. Superset-correct: contains every true neighbour for the
   * radius the halo was derived from.
   * @param {number[]} fp fractional coordinates of the query point
   * @returns {number[]}
   */
  function cellCandidates(fp, hx, hy, hz) {
    const qid = _cellQueryId++;
    const xs = axisRange(wrapBin(fp[0], Gx), hx, Gx);
    const ys = axisRange(wrapBin(fp[1], Gy), hy, Gy);
    const zs = axisRange(wrapBin(fp[2], Gz), hz, Gz);
    const out = [];
    for (const gx of xs) for (const gy of ys) for (const gz of zs) {
      const bin = cellBins[(gx * Gy + gy) * Gz + gz];
      for (const j of bin) {
        if (_cellStamp[j] === qid) continue;
        _cellStamp[j] = qid;
        out.push(j);
      }
    }
    return out;
  }

  // Base-cell neighbour images per source atom + source-level adjacency. Both are
  // used ONLY by the cage path (the BFS pool and the induced-degree test), and
  // building them is the O(atoms²) neighbour scan — so skip it entirely when cage
  // detection is off (this is also the toggle you'd flip for speed).
  /** @type {Array<Array<{srcJ:number, shift:[number,number,number], pos:THREE.Vector3, d:number}>>} */
  let baseNeighbors = [];
  /** @type {Map<number, Set<number>>} */
  const adjacency = new Map();
  if (ALLOW_CAGES && detectCages) {
    // Every periodic image of an atom is just a lattice translation of its base
    // cell, so its neighbour images are this list shifted by the image's lattice
    // offset — letting the cage BFS avoid re-scanning all atoms for every node.
    baseNeighbors = new Array(nAtoms);
    for (let i = 0; i < nAtoms; i++) baseNeighbors[i] = neighborImages(baseCart[i], elements[i]);

    const addBond = (u, v) => {
      if (!adjacency.has(u)) adjacency.set(u, new Set());
      if (!adjacency.has(v)) adjacency.set(v, new Set());
      adjacency.get(u).add(v); adjacency.get(v).add(u);
    };
    for (let i = 0; i < nAtoms; i++) {
      for (const o of baseNeighbors[i]) addBond(i, o.srcJ);
    }
  }
  _tSetup = performance.now();

  // ---------- Build candidates ----------
  /** @type {Array<{
   *   kind: 'centered'|'cage',
   *   colorElem: string,
   *   centerSrc?: number,
   *   centerShift?: [number,number,number],
   *   centerPos?: THREE.Vector3,
   *   posList: THREE.Vector3[],
   *   vertexSrcList: number[],
   *   vertexImageList: Array<{src:number, shift:[number,number,number]}>,
   *   refPoint: THREE.Vector3,
   * }>} */
  const candidates = [];

  // ---- Centered: compute directly on the visible displayed center images. ----
  // This keeps plane-cut visibility and periodic-image visibility in the same
  // coordinate frame as the user-visible atoms, instead of computing once on the
  // primary atom and translating the result afterwards.
  for (const dc of displayCenters) {
    const centerPos = dc.cart;
    const centerElem = elements[dc.src];

    // Radical-Voronoi + solid-angle neighbour selection (distance-independent:
    // keeps elongated bonds, rejects shadowed far atoms). Candidates include all
    // species so closer atoms can shadow farther ones; a vertex must additionally
    // be a chemical ligand of the centre and within the visible bond cutoff.
    const cands = gatherWithin(centerPos);
    if (cands.length < 4) continue;
    const accept = (/** @type {any} */ cand) => {
      if (!isLigandOf(cand.elem, centerElem, useChemicalFilter)) return false;
      const cutoff = getBondCutoff(centerElem, cand.elem);
      return cutoff > 1e-3 && cand.d <= cutoff;
    };
    const vor = voronoiNeighbours(centerPos, cands, {
      radical: VORONOI_RADICAL,
      relMin: VORONOI_SOLID_ANGLE_REL,
      centerRadius: atomicRadii[centerElem] || 1.0,
      accept,
    });

    // Centered-shell image handling follows the current display state rather than a
    // purely source-level notion of coordination:
    //
    // - When the same source atom appears multiple times in the current wrapped
    //   display (for example because periodic images / neighbour-bond ghosts are
    //   visible), each visible image is allowed to survive as a distinct shell
    //   vertex, keyed by (src, lattice shift).
    // - Candidate images that exist geometrically but are not currently displayed
    //   are discarded here, so polyhedra do not gain vertices from hidden ghosts.
    // - If a source atom only has its primary image visible, the old behaviour is
    //   preserved in practice: there is still only one surviving candidate for that
    //   source.
    //
    // This is the intentional "as the user currently sees it" rule for periodic
    // images in centered polyhedra. Cages remain source/image-agnostic in their
    // own path below.
    const byVisibleImage = new Map();
    for (const { cand } of vor) {
      const key = imageKey(cand.srcJ, cand.shift);
      if (!visibleImageKeys.has(key)) continue;
      const prev = byVisibleImage.get(key);
      if (!prev || cand.d < prev.d) byVisibleImage.set(key, cand);
    }
    const entries = Array.from(byVisibleImage.values());
    if (entries.length < 4) continue; // need ≥4 non-coplanar points for a closed hull

    // Only remaining skip reason is geometric degeneracy (a near-planar set has no
    // volume). No distortion filter — the neighbour set is the genuine shell.
    // `centeredHullIsAcceptable` builds the (only) hull here; a non-constructible
    // point set throws and is skipped, so no separate constructibility probe is
    // needed (avoids an extra ConvexGeometry build per centre).
    const posList = entries.map(o => o.pos);
    if (thicknessRatio(posList) < MIN_THICKNESS_RATIO) continue;
    let centeredOK = false;
    try { centeredOK = centeredHullIsAcceptable(centerPos, atomicRadii[centerElem] || 1.0, posList); }
    catch { continue; }
    if (!centeredOK) continue;

    candidates.push({
      kind: 'centered',
      colorElem: centerElem,
      centerSrc: dc.src,
      centerShift: dc.shift,
      centerPos: centerPos.clone(),
      posList,
      vertexSrcList: entries.map(o => o.srcJ),
      vertexImageList: [],
      refPoint: centerPos.clone(),
    });
  }

  _tCentered = performance.now();

  // ---- Cages (uncentered): includes N=20 dodecahedra; largest-first ----
  if (ALLOW_CAGES && detectCages) {
    // BFS in image space: each node is a concrete periodic image keyed by
    // (src, shift), so a boundary-straddling shell stays spatially contiguous
    // (the old in-cell pool was the main source of partial cages).
    //
    // Expanded a single depth-level at a time (frontier BFS) and stopped at the
    // same depth as before (always ≥3, then deeper until ≥40 visible images or
    // CAGE_BFS_DEPTH). This visits each image once instead of rebuilding the whole
    // BFS from scratch for depth 3, then 4, then 5. The returned pool (visible
    // images only) is identical to the old code's final iteration.
    //
    // The neighbour images of a node are its source atom's cached base neighbours
    // translated by the node's own lattice shift — no per-node atom rescan.
    function buildPoolForSeed(seedI) {
      const startKey = `${seedI}:0,0,0`;
      /** @type {Map<string, {pos:THREE.Vector3, src:number, shift:[number,number,number], depth:number}>} */
      const visited = new Map();
      const start = { pos: baseCart[seedI], src: seedI, shift: /** @type {[number,number,number]} */ ([0, 0, 0]), depth: 0 };
      visited.set(startKey, start);
      let frontier = [start];
      let depth = 0;
      const expand = () => {
        const next = [];
        for (const node of frontier) {
          const sx = node.shift[0], sy = node.shift[1], sz = node.shift[2];
          for (const o of baseNeighbors[node.src]) {
            const ndx = o.shift[0] + sx, ndy = o.shift[1] + sy, ndz = o.shift[2] + sz;
            const k = `${o.srcJ}:${ndx},${ndy},${ndz}`;
            if (!visited.has(k)) {
              const pos = baseCart[o.srcJ].clone()
                .addScaledVector(a, ndx).addScaledVector(b, ndy).addScaledVector(c, ndz);
              const nn = { pos, src: o.srcJ, shift: /** @type {[number,number,number]} */ ([ndx, ndy, ndz]), depth: depth + 1 };
              visited.set(k, nn);
              next.push(nn);
            }
          }
        }
        frontier = next;
        depth++;
      };
      const visiblePool = () => Array.from(visited.values())
        .filter((e) => visibleImageKeys.has(imageKey(e.src, e.shift)));

      while (depth < 3 && frontier.length) expand(); // always reach depth 3
      let pool = visiblePool();
      while (pool.length < 40 && depth < CAGE_BFS_DEPTH && frontier.length) { // heuristic ≥2×N
        expand();
        pool = visiblePool();
      }
      return pool;
    }

    for (let seedI=0; seedI<nAtoms; seedI++) {
      if (!isAtomImageVisible(baseCart[seedI].toArray(), structure.atoms[seedI], activeCutPlanes)) continue;
      const seedElem = elements[seedI];

      const _p0 = performance.now();
      const pool = buildPoolForSeed(seedI);
      _cagePoolMs += performance.now() - _p0;
      if (pool.length < 4) continue;

      // reference: centroid of pool (better shell center)
      const centroid = pool.reduce((acc,o)=>acc.add(o.pos), new THREE.Vector3()).multiplyScalar(1/pool.length);
      const dists = pool.map(o => o.pos.distanceTo(centroid)).sort((a,b)=>a-b);
      const q30 = quantile(dists, 0.30), q70 = quantile(dists, 0.70);
      const q25 = quantile(dists, 0.25), q75 = quantile(dists, 0.75);
      const q20 = quantile(dists, 0.20), q80 = quantile(dists, 0.80);

      // Per-band hull vertex sets are N-independent: the 3 distance bands are the
      // same for every target N, and the band hull + its hull→band-entry mapping
      // depend only on the band, not on N. Build them ONCE per seed (narrow → wide)
      // instead of rebuilding inside the N loop — this collapses up to 18
      // ConvexGeometry builds per seed (3 bands × 6 N) down to 3. Only the
      // reduce-to-N step and acceptance below stay inside the N loop.
      const bands = [
        [q30, q70],
        [q25, q75],
        [q20, q80],
      ];
      const bandHulls = bands.map(([lo, hi]) => {
        const band = pool.filter(o => {
          const r = o.pos.distanceTo(centroid);
          return r >= lo && r <= hi;
        });
        if (band.length < 4) return { band, baseVerts: [] };
        let geomBand;
        try { geomBand = new ConvexGeomCtor(band.map(o => o.pos)); } catch { geomBand = null; }
        if (!geomBand) return { band, baseVerts: [] };

        const posAttr = geomBand.getAttribute('position');
        const hullPts = [];
        for (let k = 0; k < posAttr.count; k++) hullPts.push(new THREE.Vector3().fromBufferAttribute(posAttr, k));
        geomBand.dispose();

        // Unique nearest mapping back to band entries
        const chosenMap = new Map(); // band index -> band entry
        for (const hp of hullPts) {
          let bi = -1, best = Infinity;
          for (let j = 0; j < band.length; j++) {
            const dd = hp.distanceToSquared(band[j].pos);
            if (dd < best) { best = dd; bi = j; }
          }
          if (bi >= 0 && !chosenMap.has(bi)) chosenMap.set(bi, band[bi]);
        }
        return { band, baseVerts: Array.from(chosenMap.values()) }; // {pos,src,shift}[]
      });

      for (const N of CAGE_TARGET_NS_DESC) {
        let builtThisN = false;

        for (const { band, baseVerts } of bandHulls) {
          if (band.length < N) continue;
          if (baseVerts.length < N) continue; // hull too small (or failed to build)

          // Reduce to N by spread when the hull has more than N vertices.
          let verts = baseVerts;
          if (verts.length !== N) {
            const subset = pickSpreadSubset(verts.map(o => o.pos), N);
            if (!subset) continue;
            verts = subset.map(p => {
              let best = null, bestD = Infinity;
              for (const o of band) {
                const dd = p.distanceToSquared(o.pos);
                if (dd < bestD) { bestD = dd; best = o; }
              }
              return best;
            });
          }

          const posList = verts.map(o=>o.pos);
          const selSrcs = verts.map(o=>o.src);   // source atom index per selected vertex

          // ---- CAGE acceptance: cheap necessary conditions FIRST, so the
          // expensive hull / EdgesGeometry is only built for candidates that can
          // actually be accepted. Both checks are necessary (combined with the
          // edge-spread test via AND), so ordering them first doesn't change which
          // cages pass — it just skips the geometry for the common rejections
          // (e.g. a coordination shell whose ligands aren't bonded to each other).

          // 1) Anti-flatness — operates on the point set, no hull needed.
          if (thicknessRatio(posList) < 0.08) continue;          // very lenient

          // 2) Induced-degree in the selected vertex set (B12 needs 5) — combinatorial.
          const minDeg = minVertexDegreeForCageSize(posList.length);
          if (!inducedDegreeOK(adjacency, selSrcs, minDeg)) continue;

          // 3) Build the candidate hull only now, and run the edge-spread sanity.
          let geom;
          try { geom = new ConvexGeomCtor(posList); } catch { geom = null; }
          if (!geom) continue;
          geom.computeVertexNormals();
          if (!edgeSpreadOK(geom)) { geom.dispose(); continue; } // max(edge)/min(edge) ≤ 1.30

          // Accept candidate cage
          candidates.push({
            kind: 'cage',
            colorElem: seedElem,
            posList,
            vertexSrcList: selSrcs,
            vertexImageList: verts.map(o=>({ src:o.src, shift:o.shift })),
            refPoint: posList.reduce((acc,p)=>acc.add(p), new THREE.Vector3()).multiplyScalar(1/posList.length),
          });

          geom.dispose();
          builtThisN = true;
          break; // move to next N (largest-first, one per band here)
        } // bands
        if (builtThisN) continue;
      } // Ns
    } // seeds
  } // cages enabled
  _tCages = performance.now();

  // ---------- Global constraints & accept into model ----------
  // Image-level center-not-corner:
  //  - An accepted center image (src, shift) cannot appear as a cage vertex.
  const acceptedCenterImageKeys = new Set(); // '<src>:<dx>,<dy>,<dz>'
  const acceptedHulls = []; // transient geometries kept only for inside tests
 // Priority: larger N first; then centered over cages

  candidates.sort((A, B) => {
    const nA = A.posList.length, nB = B.posList.length;
    if (nA !== nB) return nB - nA; // larger first

    // For large shells, prefer cages (so they aren't blocked by centered selections)
    if (nA >= 12 && A.kind !== B.kind) {
      return (A.kind === 'cage' ? -1 : 1);
    }

    // Otherwise your previous preference (centered first)
    if (A.kind !== B.kind) return (A.kind === 'centered' ? -1 : 1);

    return 0;
  });

  /** @type {Polyhedron[]} */
  const accepted = [];

  for (const cand of candidates) {
    // Image-level center-not-corner
    if (cand.kind === 'cage' && cand.vertexImageList) {
      // A cage must not use an already-accepted center image as a vertex
      const conflict = cand.vertexImageList.some(
        v => acceptedCenterImageKeys.has(`${v.src}:${v.shift[0]},${v.shift[1]},${v.shift[2]}`)
      );
      if (conflict) continue;
    }

    // Build hull for shape + nesting tests
    let geom;
    try { geom = new ConvexGeomCtor(cand.posList); } catch { continue; }
    geom.computeVertexNormals();

    // No nesting: reference point not inside any accepted hull
    let inside = false;
    for (const g of acceptedHulls) {
      if (pointInsideConvexGeometry(cand.refPoint, g, 1e-6)) { inside = true; break; }
    }
    if (inside) { geom.dispose(); continue; }

    // Accept → record as plain-data model Polyhedron
    accepted.push(new Polyhedron({
      name: `${cand.colorElem}${cand.kind === 'centered' ? '' : '-cage'}-CN${cand.posList.length}`,
      type: cand.kind,
      centerIndex: (cand.kind === 'centered') ? (cand.centerSrc ?? null) : null,
      centerElement: (cand.kind === 'centered') ? cand.colorElem : null,
      colorElem: cand.colorElem,
      vertices: cand.posList.map(p => [p.x, p.y, p.z]),
      vertexSrcList: cand.vertexSrcList,
    }));

    // Update constraint sets — key the centre by its (src, image shift)
    if (cand.kind === 'centered' && typeof cand.centerSrc === 'number') {
      const cs = cand.centerShift || [0, 0, 0];
      acceptedCenterImageKeys.add(`${cand.centerSrc}:${cs[0]},${cs[1]},${cs[2]}`);
    }
    acceptedHulls.push(geom); // keep for future inside tests (disposed below)
  }

  // Dispose the transient validation hulls — render rebuilds its own.
  for (const g of acceptedHulls) g.dispose();

  const _tEnd = performance.now();
  const ms = (x) => x.toFixed(1);
  console.log(
    `[polyhedra] total=${ms(_tEnd - _t0)}ms ` +
    `setup=${ms(_tSetup - _t0)} centered=${ms(_tCentered - _tSetup)} ` +
    `cages=${ms(_tCages - _tCentered)}(pool=${ms(_cagePoolMs)}) accept=${ms(_tEnd - _tCages)} | ` +
    `atoms=${nAtoms} centers=${displayCenters.length} ` +
    `candidates=${candidates.length} accepted=${accepted.length} ` +
    `detectCages=${detectCages}`
  );

  return new Polyhedra({ polyhedra: accepted });
}

/**
 * Build three.js meshes for the polyhedra stored on `structure.polyhedra` and
 * add them to `groups.polyhedraGroup` (which the caller has already reset).
 *
 * @param {any} structure active Structure with a populated `polyhedra` model
 */
export function renderPolyhedra(structure) {
  const model = structure.polyhedra;
  if (!model || !model.polyhedra || !model.polyhedra.length) return;
  if (!ConvexGeomCtor) return;

  const sharedEdgeMat = new THREE.LineBasicMaterial({
    color: EDGE_COLOR, transparent: true, opacity: EDGE_OPACITY,
  });

  for (const poly of model.polyhedra) {
    const posList = poly.vertices.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    let geom;
    try { geom = new ConvexGeomCtor(posList); } catch { continue; }
    geom.computeVertexNormals();

    const faceColor = getElementColor(poly.colorElem);
    const mat = new THREE.MeshStandardMaterial({
      color: faceColor,
      transparent: true,
      opacity: FACE_OPACITY,
      metalness: 0.0,
      roughness: 1.0,
      side: DOUBLE_SIDE ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: DEPTH_WRITE,
      polygonOffset: POLY_OFFSET,
      polygonOffsetFactor: POLY_OFFSET ? POLY_OFFSET_FACTOR : 0,
      polygonOffsetUnits: POLY_OFFSET ? POLY_OFFSET_UNITS : 0,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData = {
      type: 'polyhedron',
      mode: poly.type,
      cn: posList.length,
      centerSrcIndex: (poly.type === 'centered') ? poly.centerIndex : undefined,
      centerElement:  (poly.type === 'centered') ? poly.centerElement : undefined,
      vertexSrcs: poly.vertexSrcList,
    };

    const egeom = new THREE.EdgesGeometry(geom, EDGE_ANGLE);
    mesh.add(new THREE.LineSegments(egeom, sharedEdgeMat));
    groups.polyhedraGroup.add(mesh);
  }
}

/**
 * Toggle/refresh entry point. Recomputes `structure.polyhedra` (so the model
 * mirrors the scene and bond-cutoff edits take effect) and renders it.
 */
export function updatePolyhedra() {
  // ---------- TOGGLE ----------
  if (groups.polyhedraGroup) disposeGroup(groups.polyhedraGroup);
  groups.polyhedraGroup = new THREE.Group();
  if (!general.showPolyhedra) {
    app.scene.add(groups.polyhedraGroup);
    return; // IMPORTANT: nothing drawn when hidden
  }

  // Nothing to build without an active structure + lattice (e.g. polyhedra
  // toggled/restored on before a structure is loaded). Without this guard the
  // code below calls fracToCart on an undefined lattice, which hard-crashes the
  // WASM math backend (the JS backend would silently produce NaN).
  const structure = fileBrowser.selectedStructure;
  if (!structure || !structure.lattice || !structure.atoms) {
    app.scene.add(groups.polyhedraGroup);
    return;
  }

  const _tc = performance.now();
  structure.polyhedra = computePolyhedra(structure);
  const _tr = performance.now();
  renderPolyhedra(structure);
  console.log(`[polyhedra] render=${(performance.now() - _tr).toFixed(1)}ms (compute+render=${(performance.now() - _tc).toFixed(1)}ms)`);

  app.scene.add(groups.polyhedraGroup);
}
