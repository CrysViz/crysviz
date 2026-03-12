import * as THREE from '../external/three/three.module.js';
import { periodic,app, groups, general,fileBrowser, mode, atomicRadii,getLatticeVisSettings} from '../store.js';

import {disposeGroup} from '../panels/WindowAndSceneControls.js'
import {getBondCutoff} from './BondsModule.js'

import init, { periodic_wrapped } from '../compiled/periodic_wasm.js';
import { initPeriodicWasm, periodicWrapped as wasmPeriodicWrapped } from '../compiled/periodicWasm.js';

// Runs once when the module is first imported, before anything else
await initPeriodicWasm(
  init,
  periodic_wrapped,
  new URL('../compiled/periodic_wasm_bg.wasm', import.meta.url)
);

export function periodicWrapped(general, frac, elements, lattice) {
  return wasmPeriodicWrapped(general, frac, elements, lattice);
}

export function createLatticeLines(color = currentLatticeColor) {
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


// export function periodicWrapped(periodic, frac, elements, lattice) {
//   // Default options
//
//   const eps = 1e-6;
//   const newElements = [];
//   const newFcrds = [];
//   const newCcrds = [];
//   const newSrcIndex = [];
//
//   // Always wrap atoms, but only return wrapped or original based on showPeriodic
//   if (general.showPeriodic) {
//     for (let i = 0; i < frac.length; i++) {
//       const f = frac[i];
//       const atm = elements[i];
//
//       const offX = [0];
//       const offY = [0];
//       const offZ = [0];
//
//       if (f[0] < eps) offX.push(1 - eps);
//       if (f[0] > 1 - eps) offX.push(-1 + eps);
//       if (f[1] < eps) offY.push(1 - eps);
//       if (f[1] > 1 - eps) offY.push(-1 + eps);
//       if (f[2] < eps) offZ.push(1 - eps);
//       if (f[2] > 1 - eps) offZ.push(-1 + eps);
//
//       for (const dx of offX) {
//         for (const dy of offY) {
//           for (const dz of offZ) {
//             const nx = f[0] + dx;
//             const ny = f[1] + dy;
//             const nz = f[2] + dz;
//             if (nx >= -eps && nx < 1 - eps + eps &&
//                 ny >= -eps && ny < 1 - eps + eps &&
//                 nz >= -eps && nz < 1 - eps + eps) {
//               const cx = Math.min(Math.max(nx, 0), 1 - eps);
//               const cy = Math.min(Math.max(ny, 0), 1 - eps);
//               const cz = Math.min(Math.max(nz, 0), 1 - eps);
//               newElements.push(atm);
//               newFcrds.push([cx, cy, cz]);
//               newCcrds.push(fracToCart([[cx, cy, cz]],lattice)[0]);
//               newSrcIndex.push(i);
//             }
//           }
//         }
//       }
//     }
//   }
//   // If showPeriodic is false, return original frac and srcIndex
//   if (!general.showPeriodic) {
//     return {
//     elements: elements,
//     frac: frac,
//     cart: fracToCart(frac,lattice),
//     srcIndex: elements.map((_, index) => index),
//   };
//   }
//
//   // If showNeighbours is true, compute neighbors 
//   //
//   //
//   if (general.showPBCBonds) {
//
//   // Copy lattice and precompute inverse
//   const latticeInverse = invert3x3(transpose3x3(lattice));
//
//   // Convert wrapped fractional coords to Cartesian vectors
//   const wrappedCart = newFcrds.map(f => {
//     const cartArray = fracToCart([f], lattice)[0];
//     return new THREE.Vector3(cartArray[0], cartArray[1], cartArray[2]);
//   });
//
//   // Maximum bond cutoff from settings
//   const maxCutoff = Math.max(0.0, ...Object.values(general.bondLengths || { dummy: 0.0 }));
//
//   const a = new THREE.Vector3(...lattice[0]);
//   const b = new THREE.Vector3(...lattice[1]);
//   const c = new THREE.Vector3(...lattice[2]);
//
//   const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(a.length(), 1e-6))));
//   const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(b.length(), 1e-6))));
//   const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(c.length(), 1e-6))));
//
//   // Generate periodic shifts (excluding zero)
//   const shifts = [];
//   for (let dx = -ax; dx <= ax; dx++)
//     for (let dy = -by; dy <= by; dy++)
//       for (let dz = -cz; dz <= cz; dz++)
//         if (dx !== 0 || dy !== 0 || dz !== 0)
//           shifts.push([dx, dy, dz]);
//
//   const ghostAdded = new Set();
//
//   // Loop over all wrapped atoms
//   for (let i = 0; i < wrappedCart.length; i++) {
//     const pi = wrappedCart[i];
//     const ei = newElements[i];
//     const atomIndex_i = newSrcIndex[i];
//
//     // Loop over original atoms
//     for (let j = 0; j < frac.length; j++) {
//       const fj = frac[j];
//       const ej = elements[j];
//       const cutoff = getBondCutoff(ei, ej);
//       if (cutoff <= 0.01) continue;
//
//       // Convert fj to Cartesian coordinates
//       const fjCartArray = fracToCart([fj], lattice)[0];
//       const fjCart = new THREE.Vector3(fjCartArray[0], fjCartArray[1], fjCartArray[2]);
//
//       for (const [dx, dy, dz] of shifts) {
//         // Apply lattice shift
//         const shiftVec = new THREE.Vector3()
//           .addScaledVector(a, dx)
//           .addScaledVector(b, dy)
//           .addScaledVector(c, dz);
//
//         const candidateCart = fjCart.clone().add(shiftVec);
//         const d = pi.distanceTo(candidateCart);
//
//         if (d <= cutoff && d >= 0.005) {
//           const gkey = `${j}:${dx},${dy},${dz}`;
//           if (!ghostAdded.has(gkey)) {
//             // Convert back to fractional coordinates using robust function
//             const candidateFrac = cartToFrac(
//               [candidateCart.x, candidateCart.y, candidateCart.z],
//               lattice,
//               latticeInverse
//             );
//
//             // Add ghost atom
//             newElements.push(ej);
//             newFcrds.push(candidateFrac);
//             newCcrds.push([candidateCart.x, candidateCart.y, candidateCart.z]);
//             newSrcIndex.push(j);
//             ghostAdded.add(gkey);
//           }
//         }
//       }
//     }
//   }
// }
//
//   // Always return all wrapped frac coords and their original indices
//   return {
//     elements: newElements,
//     frac: newFcrds,
//     cart: newCcrds,
//     srcIndex: newSrcIndex,
//   };
// }
//
async function workerPeriodicWrapped(frac, elements, bondLenghts, showPeriodic,showPBCBonds, lattice) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
       new URL('./wrapWorker.js', import.meta.url),
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
    worker.postMessage({ functionName: "periodicWrapped", args: [frac, elements, bondLenghts, showPeriodic,showPBCBonds, lattice] });
  });
}



export function runPeriodicWrapped(periodic, frac, elements,lattice) {

    let bondLenghts = general.bondLengths
    let showPBCBonds = general.showPBCBonds
    let showPeriodic = general.showPeriodic

    const map = new Map([
      ["frac", frac],
      ["elements", elements],
      ["bondLenghts", bondLenghts],
      ["lattice", lattice],
      ["showPeriodic",showPeriodic],
      ["showPBCBonds",showPBCBonds]
    ]);
    let inputHash = hashInput(map)

    console.warn("hashes",inputHash,periodic.hash)
    let result = null
    if (periodic.hash != inputHash){
      if(1==1){ //#(periodic.hash==="None") {
        console.warn("Calling sync periodicWrapped")
        result = periodicWrapped(periodic, frac, elements,lattice)
        periodic.wrapped = result
      }
      else{
        try {
          console.log("Calling workerPeriodicWrapped...")
          result = workerPeriodicWrapped(frac, elements, bondLenghts, showPeriodic,showPBCBonds, lattice);
          console.log(result)
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



export function fracToCart(frac, lattice) { // this should probably be moved to a utility file or the lattice module
  return frac.map(fc => [
    fc[0] * lattice[0][0] + fc[1] * lattice[1][0] + fc[2] * lattice[2][0],
    fc[0] * lattice[0][1] + fc[1] * lattice[1][1] + fc[2] * lattice[2][1],
    fc[0] * lattice[0][2] + fc[1] * lattice[1][2] + fc[2] * lattice[2][2]
  ]);
}

//export function cartToFrac(cartVec, lattice) {
//  const inverse = invert3x3(transpose3x3(lattice));
//  return multiplyMatVec(inverse, cartVec);
//}
//
//
//
export function cartToFrac(cartVec, lattice, precomputedInverse) {
  const inverse = precomputedInverse || invert3x3(transpose3x3(lattice));
  return multiplyMatVec(inverse, cartVec);
}

export function transpose3x3(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function invert3x3(m) {
  const [a, b, c] = m;
  const [A,B,C] = a, [D,E,F] = b, [G,H,I] = c;
  const det = A*(E*I - F*H) - B*(D*I - F*G) + C*(D*H - E*G);
  if (Math.abs(det) < 1e-12) throw new Error('Singular matrix');
  const invDet = 1 / det;
  return [
    [(E*I - F*H)*invDet, (C*H - B*I)*invDet, (B*F - C*E)*invDet],
    [(F*G - D*I)*invDet, (A*I - C*G)*invDet, (C*D - A*F)*invDet],
    [(D*H - E*G)*invDet, (B*G - A*H)*invDet, (A*E - B*D)*invDet],
  ];
}


export function multiplyMatVec(mat, vec) {
  return [
    mat[0][0] * vec[0] + mat[0][1] * vec[1] + mat[0][2] * vec[2],
    mat[1][0] * vec[0] + mat[1][1] * vec[1] + mat[1][2] * vec[2],
    mat[2][0] * vec[0] + mat[2][1] * vec[1] + mat[2][2] * vec[2],
  ];
}
