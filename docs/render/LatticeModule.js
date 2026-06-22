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
  const material = new THREE.LineBasicMaterial(getLatticeVisSettings(color));

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
    const geometry = new THREE.BufferGeometry().setFromPoints([
      vertices[edge[0]], vertices[edge[1]]
    ]);
    const line = new THREE.Line(geometry, material);
    group.add(line);
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

async function workerPeriodicWrapped(frac, elements, bondLenghts, showPeriodic,showPBCBonds, lattice, faceTol) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
       new URL('../utils/wrapWorker.js', import.meta.url),
       { type: 'module' }
    );
    worker.onmessage = (e) => {
      if (e.data.error) {
        reject(new Error(e.data.error));
      } else {
        resolve(e.data);
      }
      worker.terminate();
    };

    worker.onerror = (e) => {
      console.error("Worker reports error:", e);
      reject(e);
      worker.terminate();
    };
    worker.postMessage({ functionName: "periodicWrapped", args: [frac, elements, bondLenghts, showPeriodic,showPBCBonds, lattice, faceTol] });
  });
}



export function runPeriodicWrapped(periodic, frac, elements,lattice) {

    let bondLenghts = general.bondLengths
    let showPBCBonds = general.showBonds && general.showPBCBonds
    let showPeriodic = general.showPeriodic
    let faceTol = general.periodicFaceTol

    const map = new Map([
      ["frac", frac],
      ["elements", elements],
      ["bondLenghts", bondLenghts],
      ["lattice", lattice],
      ["showPeriodic",showPeriodic],
      ["showPBCBonds",showPBCBonds],
      ["faceTol",faceTol]
    ]);
    let inputHash = hashInput(map)

    console.warn("hashes",inputHash,periodic.hash)
    let result = null
    if (periodic.hash != inputHash){
      if(1==1){ //#(periodic.hash==="None") {
        console.warn("Calling sync periodicWrapped")
        result = periodicWrapped({ ...general, showPBCBonds }, frac, elements,lattice)
        periodic.wrapped = result
      }
      else{
        try {
          result = workerPeriodicWrapped(frac, elements, bondLenghts, showPeriodic,showPBCBonds, lattice, faceTol);
          periodic.wrapped = result
        } catch (error) {
          console.error('Error in worker:', error);
          throw error;
        }
      }
      periodic.hash = inputHash
      periodic.wrapped = result
      return periodic
    }
    else{
      return periodic
    }
}



// Simple fast hash for strings
function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
    hash |= 0; // convert to 32-bit integer
  }
  return hash >>> 0; // convert to unsigned
}

// Serialize Map or nested Map/arrays into deterministic string
function serializeMap(map) {
  const obj = {};
  for (const [key, value] of map) {
    if (value instanceof Map) {
      obj[key] = serializeMap(value); // recurse
    } else if (Array.isArray(value)) {
      obj[key] = value.map(v => (v instanceof Map ? serializeMap(v) : v));
    } else {
      obj[key] = value;
    }
  }
  // Sort keys for deterministic order
  const sortedObj = Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
  return JSON.stringify(sortedObj);
}

// Hash function for Map input
function hashInput(map) {
  const serialized = serializeMap(map);
  return simpleHash(serialized); // returns fixed-length hash string
}

// Alternative faster hash — no string allocation, O(N) over raw numbers.
// Replace hashInput(map) with hashInputFast(...) in runPeriodicWrapped to use this.



export function getCellCenterAndDist() {
  const L = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  const corner = new THREE.Vector3(
    L[0][0]+L[1][0]+L[2][0],
    L[0][1]+L[1][1]+L[2][1],
    L[0][2]+L[1][2]+L[2][2]
  );
  const center = corner.clone().multiplyScalar(0.5);
  const distBase = Math.max(corner.length()*2.5, 20);
  const dist = distBase * app.defaultZoomScale;
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
