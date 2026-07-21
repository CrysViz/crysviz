import * as THREE from '../external/three/three.module.js';

import {app, groups, fileBrowser, general} from '../state/store.js';
import {getLatticeVisSettings} from '../defaults/color_texture_defaults.js'

import {disposeGroup} from '../ui/WindowAndSceneControls.js'
import {getBondCutoff} from './BondsFracUpdateModule.js'
import {
  fracToCart,
  cartToFrac,
  transpose3x3,
  invert3x3,
} from '../math/index.js';

import init, { periodic_wrapped } from '../compiled/periodic_wasm.js';
import { initPeriodicWasm, periodicWrapped as wasmPeriodicWrapped } from '../compiled/periodicWasm.js';

// Runs once when the module is first imported, before anything else
await initPeriodicWasm(
  init,
  periodic_wrapped,
  new URL('../compiled/periodic_wasm_bg.wasm', import.meta.url)
);

export {
  fracToCart,
  cartToFrac,
  transpose3x3,
  invert3x3,
  multiplyMatVec,
} from '../math/index.js';

export function periodicWrapped(general, frac, elements, lattice) {
  if (general.useWasmPeriodic) {
    return wasmPeriodicWrapped(general, frac, elements, lattice);
  }
  return periodicWrappedJS(general, frac, elements, lattice);
}

export function createLatticeLines(color = general.currentLatticeColor) {
  const group = new THREE.Group();
  // The outline is drawn as thin cylinders instead of THREE.Line: WebGL
  // ignores LineBasicMaterial.linewidth, while the cylinder radius gives the
  // user-adjustable cell line width (general.latticeLineWidth, world units).
  const settings = getLatticeVisSettings(color);
  const radius = general.latticeLineWidth ?? 0.015;
  const material = new THREE.MeshBasicMaterial({
    color: settings.color,
    transparent: settings.transparent,
    opacity: settings.opacity,
  });
  const UP = new THREE.Vector3(0, 1, 0);

  const lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);

  // Define unit cell vertices
  const vertices = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(lattice[0][0], lattice[0][1], lattice[0][2]),
    new THREE.Vector3(lattice[1][0], lattice[1][1], lattice[1][2]),
    new THREE.Vector3(lattice[2][0], lattice[2][1], lattice[2][2]),
    new THREE.Vector3(lattice[0][0] + lattice[1][0], lattice[0][1] + lattice[1][1], lattice[0][2] + lattice[1][2]),
    new THREE.Vector3(lattice[0][0] + lattice[2][0], lattice[0][1] + lattice[2][1], lattice[0][2] + lattice[2][2]),
    new THREE.Vector3(lattice[1][0] + lattice[2][0], lattice[1][1] + lattice[2][1], lattice[1][2] + lattice[2][2]),
    new THREE.Vector3(lattice[0][0] + lattice[1][0] + lattice[2][0], lattice[0][1] + lattice[1][1] + lattice[2][1], lattice[0][2] + lattice[1][2] + lattice[2][2])
  ];

  // Define edges of unit cell
  const edges = [
    [0, 1], [0, 2], [0, 3], [1, 4], [1, 5], [2, 4], [2, 6], [3, 5], [3, 6], [4, 7], [5, 7], [6, 7]
  ];

  edges.forEach(edge => {
    const start = vertices[edge[0]];
    const dir = new THREE.Vector3().subVectors(vertices[edge[1]], start);
    const length = dir.length();
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8), material);
    cyl.position.copy(start).addScaledVector(dir, 0.5);
    cyl.quaternion.setFromUnitVectors(UP, dir.normalize());
    group.add(cyl);
  });

  return group;
}

export function updateLattice(color = general.currentLatticeColor) {
  disposeGroup(groups.latticeGroup);
  if (general.showLattice) {
    groups.latticeGroup = createLatticeLines(color);
    app.scene.add(groups.latticeGroup);
  }
}

// Cached normalized lattice directions for performance; recompute on structure change
let cachedLatticeDirs = {
  a: new THREE.Vector3(1,0,0),
  b: new THREE.Vector3(0,1,0),
  c: new THREE.Vector3(0,0,1)
};



export function recomputeLatticeDirs() {
  const L = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  cachedLatticeDirs = {
    a: new THREE.Vector3(L[0][0], L[0][1], L[0][2]).normalize(),
    b: new THREE.Vector3(L[1][0], L[1][1], L[1][2]).normalize(),
    c: new THREE.Vector3(L[2][0], L[2][1], L[2][2]).normalize()
  };
}
export function latticeDirsNorm() { return cachedLatticeDirs; }


function periodicWrappedJS(general, frac, elements, lattice) {
  const newElements = [];
  const newFcrds = [];
  const newCcrds = [];
  const newSrcIndex = [];

  if (!general.showPeriodic) {
    return {
      elements: elements,
      frac: frac,
      cart: fracToCart(frac, lattice),
      srcIndex: elements.map((_, index) => index),
    };
  }

  const faceTol = general.periodicFaceTol ?? 1e-3;

  for (let i = 0; i < frac.length; i++) {
    const f = frac[i];
    const atm = elements[i];
    // Detect which cell faces this atom sits on (within faceTol, fractional).
    // Each detected face contributes a mirror offset; we then emit *every*
    // combination unconditionally — a corner atom lands on all 8 corners, an
    // edge atom on all 4 edges, a face atom on both faces. The mirror is placed
    // at the true periodic position (f ± 1), with no re-detection / clamping of
    // the mirrored coordinate.
    const offX = [0];
    const offY = [0];
    const offZ = [0];
    if (f[0] < faceTol) offX.push(1);
    if (f[0] > 1 - faceTol) offX.push(-1);
    if (f[1] < faceTol) offY.push(1);
    if (f[1] > 1 - faceTol) offY.push(-1);
    if (f[2] < faceTol) offZ.push(1);
    if (f[2] > 1 - faceTol) offZ.push(-1);
    for (const dx of offX) {
      for (const dy of offY) {
        for (const dz of offZ) {
          const m = [f[0] + dx, f[1] + dy, f[2] + dz];
          newElements.push(atm);
          newFcrds.push(m);
          newCcrds.push(fracToCart([m], lattice)[0]);
          newSrcIndex.push(i);
        }
      }
    }
  }

  if (general.showPBCBonds) {
    const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || {}).map(v => (typeof v === 'number' ? v : (v?.max ?? 0))), 0.0);
    if (maxCutoff > 1e-6) {
      const latticeInverse = invert3x3(transpose3x3(lattice));
      // Wrapped atoms already have their Cartesian coords in newCcrds (flat
      // [x,y,z] arrays). Snapshot the count before we append ghosts.
      const wrappedCart = newCcrds;
      const wrappedLen = wrappedCart.length;
      // Pre-build shift vectors as scalar arrays (no per-iteration allocations).
      const a = lattice[0], b = lattice[1], c = lattice[2];
      const alen = Math.hypot(a[0], a[1], a[2]);
      const blen = Math.hypot(b[0], b[1], b[2]);
      const clen = Math.hypot(c[0], c[1], c[2]);
      const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(alen, 1e-6))));
      const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(blen, 1e-6))));
      const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(clen, 1e-6))));
      const shifts = [];
      for (let dx = -ax; dx <= ax; dx++)
        for (let dy = -by; dy <= by; dy++)
          for (let dz = -cz; dz <= cz; dz++)
            if (dx !== 0 || dy !== 0 || dz !== 0)
              shifts.push([a[0]*dx + b[0]*dy + c[0]*dz, a[1]*dx + b[1]*dy + c[1]*dz, a[2]*dx + b[2]*dy + c[2]*dz]);

      const origCart = frac.map(f => fracToCart([f], lattice)[0]);

      // Spatial grid (cell list) over wrapped atoms; cell size = maxCutoff, so
      // any bonding partner of a query point sits in its cell or a neighbour.
      // Turns the ghost search from O(wrapped × atoms × shifts) into roughly
      // O(atoms × shifts × neighbours-per-cell).
      const invCell = 1.0 / maxCutoff;
      const grid = new Map();
      for (let i = 0; i < wrappedLen; i++) {
        const p = wrappedCart[i];
        const k = `${Math.floor(p[0]*invCell)},${Math.floor(p[1]*invCell)},${Math.floor(p[2]*invCell)}`;
        let bucket = grid.get(k);
        if (!bucket) { bucket = []; grid.set(k, bucket); }
        bucket.push(i);
      }
      const minD2 = 0.005 * 0.005;

      // Each (j, shift) candidate is visited once → add a ghost iff it bonds to
      // any wrapped atom (one match is enough; no dedup set needed).
      for (let j = 0; j < frac.length; j++) {
        const ej = elements[j];
        const fj = origCart[j];
        for (const sv of shifts) {
          const qx = fj[0] + sv[0], qy = fj[1] + sv[1], qz = fj[2] + sv[2];
          const cx = Math.floor(qx*invCell), cy = Math.floor(qy*invCell), cz0 = Math.floor(qz*invCell);
          let bonded = false;
          for (let gx = cx - 1; gx <= cx + 1 && !bonded; gx++)
            for (let gy = cy - 1; gy <= cy + 1 && !bonded; gy++)
              for (let gz = cz0 - 1; gz <= cz0 + 1 && !bonded; gz++) {
                const bucket = grid.get(`${gx},${gy},${gz}`);
                if (!bucket) continue;
                for (const i of bucket) {
                  const cutoff = getBondCutoff(newElements[i], ej);
                  if (cutoff <= 0.01) continue;
                  const p = wrappedCart[i];
                  const ddx = p[0] - qx, ddy = p[1] - qy, ddz = p[2] - qz;
                  const d2 = ddx*ddx + ddy*ddy + ddz*ddz;
                  if (d2 <= cutoff*cutoff && d2 >= minD2) { bonded = true; break; }
                }
              }
          if (bonded) {
            newElements.push(ej);
            newFcrds.push(cartToFrac([qx, qy, qz], lattice, latticeInverse));
            newCcrds.push([qx, qy, qz]);
            newSrcIndex.push(j);
          }
        }
      }
    }
  }

  return {
    elements: newElements,
    frac: newFcrds,
    cart: newCcrds,
    srcIndex: newSrcIndex,
  };
}

// Per-instance integer cell offset: wrapped.frac[i] - frac[srcIndex[i]]. Both a
// face mirror and a PBC-bond ghost are their source atom translated by whole
// cells, so this is exact; anything else (a wrapping built for different
// coordinates) yields a non-integer and disables the fast path rather than
// rendering atoms in the wrong place.
function imageShiftsOf(wrapped, frac) {
  const { srcIndex, frac: wfrac } = wrapped
  if (!srcIndex || !wfrac) return null
  const n = srcIndex.length
  const shifts = new Int8Array(n * 3)
  for (let i = 0; i < n; i++) {
    const src = frac[srcIndex[i]]
    if (!src) return null
    for (let k = 0; k < 3; k++) {
      const delta = wfrac[i][k] - src[k]
      const rounded = Math.round(delta)
      if (Math.abs(delta - rounded) > 1e-6 || Math.abs(rounded) > 3) return null
      shifts[i * 3 + k] = rounded
    }
  }
  return shifts
}

export function runPeriodicWrapped(periodic, frac, elements,lattice) {

    let bondLenghts = general.bondLengths
    let showPBCBonds = general.showBonds && general.showPBCBonds
    let showPeriodic = general.showPeriodic
    let faceTol = general.periodicFaceTol

    let inputHash = hashInputFast(
      frac, elements, lattice, bondLenghts,
      showPeriodic, showPBCBonds, general.completePolyhedra, faceTol
    )

    if (periodic.hash != inputHash){
      periodic.wrapped = periodicWrapped({ ...general, showPBCBonds }, frac, elements,lattice)
      // Number of base atoms (periodic-image + PBC-bond ghosts), before any "Complete
      // Polyhedra" atoms which updatePolyhedra() appends. Polyhedra centers use only these.
      periodic.wrapped.baseCount = periodic.wrapped.elements.length
      // Integer lattice translation of each rendered instance from its source
      // atom. Recorded here, where `frac` and the wrapping are by construction
      // consistent — deriving it later (once the atoms have moved) would round
      // to the wrong cell for an atom that has since crossed a face. The MD /
      // relax render fast path replays these to move every instance without
      // re-deriving the image set (see render/FastFrameModule.js).
      periodic.wrapped.imageShifts = imageShiftsOf(periodic.wrapped, frac)
      periodic.hash = inputHash
    }
    return periodic
}

// ── Fast structural hash — no string / JSON allocation ────────────────────────
//
// Numeric djb2-style rolling hash (multiply-by-33 + XOR) over the raw inputs.
// Replaces the old JSON.stringify(serializeMap(...)) path, which allocated a
// multi-kB string over every frac position on every MD/relax step. Floats are
// folded in via their exact 64-bit IEEE representation (two 32-bit words) so a
// sub-ULP perturbation (e.g. 1e-6) changes the hash. MUST change whenever any of
// the previous hashInput inputs change (frac, elements, lattice, bondLengths,
// showPeriodic, showPBCBonds, completePolyhedra, faceTol).
const _hashF64 = new Float64Array(1);
const _hashU32 = new Uint32Array(_hashF64.buffer);

function hashFloat(h, x) {
  _hashF64[0] = x;
  h = (Math.imul(h, 33) ^ _hashU32[0]) >>> 0;
  h = (Math.imul(h, 33) ^ _hashU32[1]) >>> 0;
  return h;
}

function hashString(h, s) {
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  // Length-sensitive separator so ["ab","c"] != ["a","bc"].
  return (Math.imul(h, 33) ^ 0x1f) >>> 0;
}

function hashInputFast(frac, elements, lattice, bondLengths, showPeriodic, showPBCBonds, completePolyhedra, faceTol) {
  let h = 5381 >>> 0;
  h = (Math.imul(h, 33) ^ (showPeriodic ? 1 : 0)) >>> 0;
  h = (Math.imul(h, 33) ^ (showPBCBonds ? 1 : 0)) >>> 0;
  h = (Math.imul(h, 33) ^ (completePolyhedra ? 1 : 0)) >>> 0;
  h = hashFloat(h, faceTol ?? 1e-3);

  for (let i = 0; i < frac.length; i++) {
    const f = frac[i];
    h = hashFloat(h, f[0]); h = hashFloat(h, f[1]); h = hashFloat(h, f[2]);
  }
  for (let i = 0; i < elements.length; i++) {
    h = hashString(h, elements[i]);
  }
  for (let i = 0; i < lattice.length; i++) {
    const r = lattice[i];
    h = hashFloat(h, r[0]); h = hashFloat(h, r[1]); h = hashFloat(h, r[2]);
  }

  // bondLengths: object keyed by "El-El" -> {min, max} (or a bare number). Hash in
  // sorted-key order so it is deterministic regardless of insertion order.
  const bl = bondLengths || {};
  const keys = Object.keys(bl).sort();
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    h = hashString(h, key);
    const v = bl[key];
    if (typeof v === 'number') {
      h = hashFloat(h, v);
    } else {
      h = hashFloat(h, v?.min ?? 0);
      h = hashFloat(h, v?.max ?? 0);
    }
  }
  return h >>> 0;
}


export function getCellCenterAndDist() {
  const L = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  const a = new THREE.Vector3(L[0][0], L[0][1], L[0][2]);
  const b = new THREE.Vector3(L[1][0], L[1][1], L[1][2]);
  const c = new THREE.Vector3(L[2][0], L[2][1], L[2][2]);
  const corner = a.clone().add(b).add(c);
  const center = corner.clone().multiplyScalar(0.5);

  // Bounding radius: the farthest of the 8 parallelepiped vertices from the
  // center. Using just the diagonal corner (corner.length()/2) under-covers
  // oblique/skewed cells, where e.g. a+b or a alone can reach farther than
  // the main diagonal.
  const vertices = [
    new THREE.Vector3(0, 0, 0), a, b, c,
    a.clone().add(b), a.clone().add(c), b.clone().add(c), corner,
  ];
  let radius = 0;
  for (const v of vertices) radius = Math.max(radius, v.distanceTo(center));
  radius = Math.max(radius, 1); // guard a degenerate/zero-size cell

  // Distance so the bounding sphere fits entirely inside the perspective
  // camera's frustum (45° vertical FOV, matching switchCameraType's
  // PerspectiveCamera), with a small margin.
  const halfFovRad = (45 / 2) * Math.PI / 180;
  const fitDist = Math.max((radius / Math.sin(halfFovRad)) * 1.1, 20);
  // defaultZoomScale is a user zoom preference: it may pull the camera
  // further OUT, but never zooms in past the distance that guarantees the
  // whole structure is visible.
  const dist = fitDist * Math.max(1, app.defaultZoomScale);
  return { center, dist };
}

export function latticeDirs() {
  const L = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  return {
    a: [L[0][0], L[0][1], L[0][2]],
    b: [L[1][0], L[1][1], L[1][2]],
    c: [L[2][0], L[2][1], L[2][2]],
  };
}


export function isOutsideUnitCell(cart, lattice, eps = 1e-6) {
  const f = cartToFrac(cart, lattice);
  return (f[0] < -eps || f[0] >= 1 + eps ||
          f[1] < -eps || f[1] >= 1 + eps ||
          f[2] < -eps || f[2] >= 1 + eps);
}
