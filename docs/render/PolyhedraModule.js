import * as THREE from '../external/three/three.module.js';
import { ConvexGeometry } from '../external/three/ConvexGeometry.js';
import {app,general,groups, fileBrowser} from '../state/store.js'
import { fracToCart, cartToFrac, invert3x3, transpose3x3 } from '../math/index.js'
import { getBondCutoff} from '../render/BondsFracUpdateModule.js'
import {disposeGroup} from '../ui/WindowAndSceneControls.js'
import { Polyhedra } from '../model/Polyhedra.js'
import { Polyhedron } from '../model/Polyhedron.js'

// ---------- STYLE (render) ----------
const FACE_OPACITY = 0.80;
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

// Distortion tolerance (applies to both centered and cages). Centered now uses
// the full coordination shell (no CN-downgrade), so this is only a skip gate —
// kept loose so genuinely distorted-but-complete shells are not dropped.
const MAX_EDGE_SPREAD = 1.60;      // max(edge)/min(edge) ≤ 1.60
const MIN_THICKNESS_RATIO = 0.08;  // very lenient anti-flatness (e_min / e_max)

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

  // Guaranteed-complete image range per axis: how many cells (in each lattice
  // direction) the largest bond cutoff can reach, using the cell's perpendicular
  // widths d = V/|b×c| so no neighbour image is ever missed, even for skewed cells.
  const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || {}).map(v => (typeof v === 'number' ? v : (v?.max ?? 0))), 0.0);
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
  function neighborImages(P, elem) {
    const fp = cartToFrac([P.x, P.y, P.z], lattice, latInv);
    const out = [];
    for (let j = 0; j < nAtoms; j++) {
      const ej = elements[j];
      const cutoff = getBondCutoff(elem, ej);
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

  // Source-level adjacency (for the cage induced-degree test) + the complete
  // first-coordination shell of each primary atom (reused for centered hulls).
  /** @type {Map<number, Set<number>>} */
  const adjacency = new Map();
  function addBond(u, v) {
    if (!adjacency.has(u)) adjacency.set(u, new Set());
    if (!adjacency.has(v)) adjacency.set(v, new Set());
    adjacency.get(u).add(v); adjacency.get(v).add(u);
  }
  /** @type {Map<number, Array<{srcJ:number, shift:[number,number,number], pos:THREE.Vector3, d:number}>>} */
  const primaryShell = new Map();
  for (let i = 0; i < nAtoms; i++) {
    const shell = neighborImages(baseCart[i], elements[i]);
    primaryShell.set(i, shell);
    for (const o of shell) addBond(i, o.srcJ);
  }

  // ---------- Build candidates ----------
  /** @type {Array<{
   *   kind: 'centered'|'cage',
   *   colorElem: string,
   *   centerSrc?: number,
   *   centerPos?: THREE.Vector3,
   *   posList: THREE.Vector3[],
   *   vertexSrcList: number[],
   *   vertexImageList: Array<{src:number, shift:[number,number,number]}>,
   *   refPoint: THREE.Vector3,
   * }>} */
  const candidates = [];

  // ---- Centered: one full-shell polyhedron per primary atom (no CN downgrade) ----
  for (let i=0; i<nAtoms; i++) {
    const centerPos = baseCart[i];
    const centerElem = elements[i];

    // Complete first-coordination shell: nearest image per coordinating source atom.
    const bySrc = new Map();
    for (const o of (primaryShell.get(i) || [])) {
      const prev = bySrc.get(o.srcJ);
      if (!prev || o.d < prev.d) bySrc.set(o.srcJ, o);
    }
    const entries = Array.from(bySrc.values());
    if (entries.length < 3) continue; // cannot form a polyhedron

    const posList = entries.map(o => o.pos);
    let geom;
    try { geom = new ConvexGeomCtor(posList); } catch { continue; }
    const okThick = thicknessRatio(posList) >= MIN_THICKNESS_RATIO;
    const okSpread = edgeSpreadOK(geom);
    geom.dispose();
    if (!okThick || !okSpread) continue; // full-or-none: skip, never downgrade

    candidates.push({
      kind: 'centered',
      colorElem: centerElem,
      centerSrc: i,
      centerPos,
      posList,
      vertexSrcList: entries.map(o => o.srcJ),
      vertexImageList: entries.map(o => ({ src: o.srcJ, shift: o.shift })),
      refPoint: centerPos.clone(),
    });
  }

  // ---- Cages (uncentered): includes N=20 dodecahedra; largest-first ----
  if (ALLOW_CAGES) {
    // BFS in image space: each node is a concrete periodic image keyed by
    // (src, shift), so a boundary-straddling shell stays spatially contiguous
    // (the old in-cell pool was the main source of partial cages).
    function buildPoolForSeed(seedI, depthMax) {
      const startKey = `${seedI}:0,0,0`;
      /** @type {Map<string, {pos:THREE.Vector3, src:number, shift:[number,number,number], depth:number}>} */
      const visited = new Map();
      visited.set(startKey, { pos: baseCart[seedI], src: seedI, shift: [0,0,0], depth: 0 });
      const queue = [startKey];
      while (queue.length) {
        const node = visited.get(queue.shift());
        if (!node || node.depth === depthMax) continue;
        for (const o of neighborImages(node.pos, elements[node.src])) {
          const k = `${o.srcJ}:${o.shift[0]},${o.shift[1]},${o.shift[2]}`;
          if (!visited.has(k)) {
            visited.set(k, { pos: o.pos, src: o.srcJ, shift: o.shift, depth: node.depth + 1 });
            queue.push(k);
          }
        }
      }
      return Array.from(visited.values()); // [{pos, src, shift, depth}]
    }

    for (let seedI=0; seedI<nAtoms; seedI++) {
      const seedElem = elements[seedI];

      // expand pool up to depth until we have plenty of candidates for N=20
      let depth = 3;
      let pool = buildPoolForSeed(seedI, depth);
      while (pool.length < 40 && depth < CAGE_BFS_DEPTH) { // heuristic ≥2×N
        depth++;
        pool = buildPoolForSeed(seedI, depth);
      }
      if (pool.length < 4) continue;

      // reference: centroid of pool (better shell center)
      const centroid = pool.reduce((acc,o)=>acc.add(o.pos), new THREE.Vector3()).multiplyScalar(1/pool.length);
      const dists = pool.map(o => o.pos.distanceTo(centroid)).sort((a,b)=>a-b);
      const q30 = quantile(dists, 0.30), q70 = quantile(dists, 0.70);
      const q25 = quantile(dists, 0.25), q75 = quantile(dists, 0.75);
      const q20 = quantile(dists, 0.20), q80 = quantile(dists, 0.80);

      for (const N of CAGE_TARGET_NS_DESC) {
        // band widths (narrow → wide)
        const bands = [
          [q30, q70],
          [q25, q75],
          [q20, q80],
        ];
        let builtThisN = false;

        for (const [lo, hi] of bands) {
          const band = pool.filter(o => {
            const r = o.pos.distanceTo(centroid);
            return r >= lo && r <= hi;
          });
          if (band.length < N) continue;

          // Hull of band → extract hull vertices → possibly reduce to N by spread
          let geomBand;
          try { geomBand = new ConvexGeomCtor(band.map(o=>o.pos)); } catch { geomBand = null; }
          if (!geomBand) continue;
          geomBand.computeVertexNormals();

          const posAttr = geomBand.getAttribute('position');
          const hullPts = [];
          for (let k=0;k<posAttr.count;k++) hullPts.push(new THREE.Vector3().fromBufferAttribute(posAttr, k));

          // Unique nearest mapping back to band entries
          const chosenMap = new Map(); // band index -> band entry
          for (const hp of hullPts) {
            let bi=-1, best=Infinity;
            for (let j=0; j<band.length; j++) {
              const dd = hp.distanceToSquared(band[j].pos);
              if (dd < best) { best=dd; bi=j; }
            }
            if (bi>=0 && !chosenMap.has(bi)) chosenMap.set(bi, band[bi]);
          }
          let verts = Array.from(chosenMap.values()); // {wi,pos,src}[]

          if (verts.length !== N) {
            if (verts.length < N) { geomBand.dispose(); continue; }
            // reduce to N by spread
            const subset = pickSpreadSubset(verts.map(o=>o.pos), N);
            if (!subset) { geomBand.dispose(); continue; }
            verts = subset.map(p => {
              let best=null, bestD=Infinity;
              for (const o of band) {
                const dd = p.distanceToSquared(o.pos);
                if (dd < bestD) { bestD = dd; best = o; }
              }
              return best;
            });
          }

          // Build candidate hull on selected N verts
          const posList = verts.map(o=>o.pos);
          const selSrcs = verts.map(o=>o.src);   // source atom index per selected vertex
          let geom;
          try { geom = new ConvexGeomCtor(posList); } catch { geom = null; }
          if (!geom) { geomBand.dispose(); continue; }

          geom.computeVertexNormals();
          // ---- CAGE acceptance: induced-degree rule instead of hull-edges-as-bonds ----

          // 1) Mild shape sanity (keep your existing checks)
          const okSpread = edgeSpreadOK(geom);                   // max(edge)/min(edge) ≤ 1.30
          const okThick  = thicknessRatio(posList) >= 0.08;      // very lenient anti-flatness
          if (!(okSpread && okThick)) { geom.dispose(); continue; }

          // 2) Induced-degree in the selected vertex set (B12 needs 5)
          const minDeg = minVertexDegreeForCageSize(posList.length);
          if (!inducedDegreeOK(adjacency, selSrcs, minDeg)) {
            geom.dispose(); continue;
          }
          // 3) Accept cage candidate (push into candidates with posList/selSrcs/refPoint as you already do)


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
          geomBand.dispose();
          builtThisN = true;
          break; // move to next N (largest-first, one per band here)
        } // bands
        // (optionally keep building more cages per seed/N; current strategy keeps it moderate)
        if (builtThisN) continue;
      } // Ns
    } // seeds
  } // cages enabled

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

    // Update constraint sets — the center sits at its primary cell (shift 0,0,0)
    if (cand.kind === 'centered' && typeof cand.centerSrc === 'number') {
      acceptedCenterImageKeys.add(`${cand.centerSrc}:0,0,0`);
    }
    acceptedHulls.push(geom); // keep for future inside tests (disposed below)
  }

  // Dispose the transient validation hulls — render rebuilds its own.
  for (const g of acceptedHulls) g.dispose();

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

  structure.polyhedra = computePolyhedra(structure);
  renderPolyhedra(structure);

  app.scene.add(groups.polyhedraGroup);
}
