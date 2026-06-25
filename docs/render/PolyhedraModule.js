import * as THREE from '../external/three/three.module.js';
import { ConvexGeometry } from '../external/three/ConvexGeometry.js';
import {app,general,groups, fileBrowser} from '../state/store.js'
import {periodicWrapped,fracToCart} from '../render/LatticeModule.js'
import { getBondCutoff} from '../render/BondsFracUpdateModule.js'
import {disposeGroup} from '../ui/WindowAndSceneControls.js'

// Face color for a coordination polyhedron: the central element's atom color
// (falls back to the default blue if unavailable). Previously referenced via a
// `typeof getElementColor === 'function'` guard but never actually defined, so
// polyhedra always rendered with the fallback color.
function getElementColor(element) {
  const colors = fileBrowser.selectedStructure?.getElementColors?.()[element];
  return (colors && colors.length) ? colors[0] : 0x00aaff;
}

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
  const _activeStructure = fileBrowser.selectedStructure;
  if (!_activeStructure || !_activeStructure.lattice || !_activeStructure.atoms) {
    app.scene.add(groups.polyhedraGroup);
    return;
  }

  // ---------- STYLE ----------
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

  // ---------- BEHAVIOR ----------
  // Centered CNs (largest-first prioritization is achieved later via candidate sort)
  const CENTERED_CNs_DESC = [12, 10, 8, 7, 6, 5, 4];

  // Cages (uncentered): **includes N = 20 dodecahedra**
  const ALLOW_CAGES = true;
  const CAGE_TARGET_NS_DESC = [20, 12, 10, 8, 6, 4]; // 20 first for dodecahedron cages
  const CAGE_BFS_DEPTH = 5; // a bit deeper to ensure we hit full N=20 shells

  // Mild distortion tolerance (applies to both centered and cages)
  const MAX_EDGE_SPREAD = 1.30;      // max(edge)/min(edge) ≤ 1.30  (~30%)
  const MIN_THICKNESS_RATIO = 0.08;  // very lenient anti-flatness (e_min / e_max)

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
 // ---------- SAFETY ----------
  const ConvexGeomCtor = (typeof ConvexGeometry !== 'undefined')
    ? ConvexGeometry
    : (THREE && THREE.ConvexGeometry ? THREE.ConvexGeometry : null);
  if (!ConvexGeomCtor) {
    console.error('[updatePolyhedra] ConvexGeometry missing. Load examples/jsm/geometries/ConvexGeometry.js');
    app.scene.add(groups.polyhedraGroup);
    return;
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

  function bfs(adjacency, srcStart, depthMax) {
    const visited = new Map(); // src -> depth
    const q = [[srcStart, 0]];
    visited.set(srcStart, 0);
    while (q.length) {
      const [u,d] = q.shift();
      if (d === depthMax) continue;
      for (const v of (adjacency.get(u) || [])) {
        if (!visited.has(v)) { visited.set(v, d+1); q.push([v,d+1]); }
      }
    }
    return visited;
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


  function inducedDegreeOK(selSrcs, minDeg) {
    const set = new Set(selSrcs);
    for (const u of selSrcs) {
      const nb = adjacency.get(u) || new Set();
      let deg = 0;
      for (const v of nb) if (set.has(v) && v !== u) deg++;
      if (deg < minDeg) return false;
    }
    return true;
  }

  // ---------- Build bond graph + per-center bonded images (with shifts) ----------

  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position)
  let elements = [...fileBrowser.selectedStructure.elements];
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);

  let  wrapped = periodicWrapped(positions, elements);
  let  wrappedCart = fracToCart(wrapped.frac, lattice); 

  const Wpos  = wrappedCart.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const Welem = wrapped.elements;
  const Wsrc  = wrapped.srcIndex;

  const a = new THREE.Vector3(lattice[0][0], lattice[0][1], lattice[0][2]);
  const b = new THREE.Vector3(lattice[1][0], lattice[1][1], lattice[1][2]);
  const c = new THREE.Vector3(lattice[2][0], lattice[2][1], lattice[2][2]);

  const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || {}).map(v => (typeof v === 'number' ? v : (v?.max ?? 0))), 0.0);
  const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(a.length(), 1e-6))));
  const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(b.length(), 1e-6))));
  const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(c.length(), 1e-6))));
  const shifts = [];
  for (let dx=-ax; dx<=ax; dx++)
    for (let dy=-by; dy<=by; dy++)
      for (let dz=-cz; dz<=cz; dz++)
        shifts.push([dx,dy,dz]);

  /** @type {Map<number, Set<number>>} */
  const adjacency = new Map();
  function addBond(u, v) {
    if (!adjacency.has(u)) adjacency.set(u, new Set());
    if (!adjacency.has(v)) adjacency.set(v, new Set());
    adjacency.get(u).add(v); adjacency.get(v).add(u);
  }

  /** @type {Map<number, Array<{pos:THREE.Vector3, srcJ:number, shift:[number,number,number], d:number}>>} */
  const perCenterImages = new Map();
  for (let i=0; i<Wpos.length; i++) {
    const pi = Wpos[i], ei = Welem[i], srcI = Wsrc[i];
    const bonded = [];
    for (let j=0; j<Wpos.length; j++) {
      if (j === i) continue;
      const pj = Wpos[j], ej = Welem[j], srcJ = Wsrc[j];
      const cutoff = getBondCutoff(ei, ej);
      if (cutoff <= 1e-3) continue;
      for (const [dx,dy,dz] of shifts) {
        const shiftVec = new THREE.Vector3().addScaledVector(a,dx).addScaledVector(b,dy).addScaledVector(c,dz);
        const q = pj.clone().add(shiftVec);
        const d = q.distanceTo(pi);
        if (d > cutoff || d < 1e-4) continue;
        addBond(srcI, srcJ);
        bonded.push({ pos: q, srcJ, shift:[dx,dy,dz], d });
      }
    }
    perCenterImages.set(i, /** @type {any} */ (bonded));
  }

  // Map src -> list of wrapped indices (to identify cage vertex images)
  const wrappedIdxBySrc = new Map();
  for (let wi=0; wi<Wsrc.length; wi++) {
    const s = Wsrc[wi];
    if (!wrappedIdxBySrc.has(s)) wrappedIdxBySrc.set(s, []);
    wrappedIdxBySrc.get(s).push(wi);
  }

  // ---------- Build candidates ----------
  /** @type {Array<{
   *   kind: 'centered'|'cage',
   *   colorElem: string,
   *   centerWrappedIdx?: number,
   *   centerSrc?: number,
   *   centerPos?: THREE.Vector3,
   *   posList: THREE.Vector3[],
   *   vertexSrcList: number[],
   *   vertexWrappedIdxList?: number[],              // cages
   *   vertexImageList?: Array<{src:number, shift:[number,number,number]}>, // centered
   *   refPoint: THREE.Vector3,
   * }>} */
  const candidates = [];

  // ---- Centered (one per center; try largest CNs first) ----
  for (let i=0; i<Wpos.length; i++) {
    const centerPos = Wpos[i], centerElem = Welem[i], centerSrc = Wsrc[i];
    const imgs = perCenterImages.get(i) || [];
    if (imgs.length < 3) continue;

    for (const N of CENTERED_CNs_DESC) {
      if (imgs.length < N) continue;

      const nearest = imgs.slice().sort((u,v)=>u.d - v.d).slice(0, N);
      const allPos = imgs.map(o=>o.pos);
      const spreadPos = (imgs.length > N) ? (pickSpreadSubset(allPos, N) || []) : nearest.map(o=>o.pos);

      const variants = [];
      variants.push(nearest);
      if (spreadPos.length === N) {
        // map spread positions back to entries
        const spreadEntries = spreadPos.map(p => {
          let best=null, bestD=Infinity;
          for (const o of imgs) {
            const dd = p.distanceToSquared(o.pos);
            if (dd < bestD) { bestD = dd; best = o; }
          }
          return best;
        });
        const nearestSet = new Set(nearest.map(o=>o.pos));
        if (spreadEntries.some(o => !nearestSet.has(o.pos))) variants.push(spreadEntries);
      }

      let acceptedVariant = null;
      for (const variant of variants) {
        const posList = variant.map(o=>o.pos);
        let geom;
        try { geom = new ConvexGeomCtor(posList); } catch { continue; }
        const okSpread = edgeSpreadOK(geom);
        const okThick  = thicknessRatio(posList) >= MIN_THICKNESS_RATIO;
        if (okSpread && okThick) { acceptedVariant = { posList, variant }; geom.dispose(); break; }
        geom.dispose();
      }
   if (acceptedVariant) {
        candidates.push({
          kind: 'centered',
          colorElem: centerElem,
          centerWrappedIdx: i,
          centerSrc,
          centerPos,
          posList: acceptedVariant.posList,
          vertexSrcList: acceptedVariant.variant.map(o=>o.srcJ),
          vertexImageList: acceptedVariant.variant.map(o=>({ src:o.srcJ, shift:o.shift })),
          refPoint: centerPos.clone(),
        });
        break; // only one centered candidate per center (largest-first)
      }
    }
  }

  // ---- Cages (uncentered): includes N=20 dodecahedra; largest-first ----
  if (ALLOW_CAGES) {
    function buildPoolForSeed(seedSrc, depthMax) {
      const reach = bfs(adjacency, seedSrc, depthMax);
      const pool = [];
      for (const s of reach.keys()) {
        const idxs = wrappedIdxBySrc.get(s) || [];
        for (const wi of idxs) pool.push({ wi, pos: Wpos[wi], src: Wsrc[wi] });
      }
      return pool;
    }

    for (let seedWi=0; seedWi<Wpos.length; seedWi++) {
      const seedSrc = Wsrc[seedWi];
      const seedElem = Welem[seedWi];

      // expand pool up to depth until we have plenty of candidates for N=20
      let depth = 3;
      let pool = buildPoolForSeed(seedSrc, depth);
      while (pool.length < 40 && depth < CAGE_BFS_DEPTH) { // heuristic ≥2×N
        depth++;
        pool = buildPoolForSeed(seedSrc, depth);
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
          const selSrcs = verts.map(o=>o.src);   // source atom index per selected vertex (parallel to vertexWrappedIdxList)
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
          if (!inducedDegreeOK(selSrcs, minDeg)) {
            geom.dispose(); continue;
          }
          // 3) Accept cage candidate (push into candidates with posList/selSrcs/refPoint as you already do)


          // Accept candidate cage
          candidates.push({
            kind: 'cage',
            colorElem: seedElem,
            posList,
            vertexSrcList: selSrcs,
            vertexWrappedIdxList: verts.map(o=>o.wi),
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

  // ---------- Global constraints & render ----------
  // Image-level center-not-corner:
  //  - The exact wrapped center image cannot appear as a vertex image elsewhere.
  const acceptedCenterWrappedKeys = new Set(); // 'wi:<wrappedIndex>'
  const acceptedHulls = []; // keep geometries for inside tests (do not dispose)
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


  const sharedEdgeMat = new THREE.LineBasicMaterial({
    color: EDGE_COLOR, transparent: true, opacity: EDGE_OPACITY,
  });

  for (const cand of candidates) {
    // Image-level center-not-corner
    if (cand.kind === 'cage' && cand.vertexWrappedIdxList) {
      // A cage must not use an already-accepted center image as a vertex
      const conflict = cand.vertexWrappedIdxList.some(wi => acceptedCenterWrappedKeys.has(`wi:${wi}`));
      if (conflict) continue;
    }

    // Build final hull
    let geom;
    try { geom = new ConvexGeomCtor(cand.posList); } catch { continue; }
    geom.computeVertexNormals();

    // No nesting: reference point not inside any accepted hull
    let inside = false;
    for (const g of acceptedHulls) {
      if (pointInsideConvexGeometry(cand.refPoint, g, 1e-6)) { inside = true; break; }
    }
    if (inside) { geom.dispose(); continue; }

    // Render
    const faceColor = (typeof getElementColor === 'function') ? getElementColor(cand.colorElem) : FACE_FALLBACK_COLOR;
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
      mode: cand.kind,
      cn: cand.posList.length,
      centerWrappedIdx: (cand.kind === 'centered') ? cand.centerWrappedIdx : undefined,
      centerSrcIndex:   (cand.kind === 'centered') ? cand.centerSrc : undefined,
      centerElement:    (cand.kind === 'centered') ? cand.colorElem : undefined,
      vertexSrcs: cand.vertexSrcList,
    };

    const egeom = new THREE.EdgesGeometry(geom, EDGE_ANGLE);
    mesh.add(new THREE.LineSegments(egeom, sharedEdgeMat));
    groups.polyhedraGroup.add(mesh);

    // Update constraint sets
    if (cand.kind === 'centered' && typeof cand.centerWrappedIdx === 'number') {
      acceptedCenterWrappedKeys.add(`wi:${cand.centerWrappedIdx}`);
    }
    acceptedHulls.push(geom); // keep for future inside tests
  }

  app.scene.add(groups.polyhedraGroup);
}

