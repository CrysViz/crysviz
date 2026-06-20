import * as THREE from '../external/three/three.module.js';
import {
  fracToCart,
  cartToFrac,
  transpose3x3,
  invert3x3,
} from '../math/index.js';

//imports in worker are relative to index!!

console.log = () => {};
console.warn = () => {};


self.onmessage = function(e) {
  const { functionName, args } = e.data;
  console.warn("wrapWorker recevied message...")

  if (functionName === 'periodicWrapped') {
    try {
      const result = periodicWrapped(...args);
      postMessage(result);
    } catch (error) {
      postMessage({ error: error.message });
    }
  }
};

function periodicWrapped(frac, elements, bondLengths, showPeriodic,showPBCBonds, lattice) {
  // Default options

  const eps = 1e-6;
  const newElements = [];
  const newFcrds = [];
  const newCcrds = [];
  const srcIndex = [];
  const latticeInverse = invert3x3(transpose3x3(lattice));

  // Always wrap atoms, but only return wrapped or original based on showPeriodic
  if (showPeriodic) {
    for (let i = 0; i < frac.length; i++) {
      const f = frac[i];
      const atm = elements[i];

      const offX = [0];
      const offY = [0];
      const offZ = [0];

      if (f[0] < eps) offX.push(1 - eps);
      if (f[0] > 1 - eps) offX.push(-1 + eps);
      if (f[1] < eps) offY.push(1 - eps);
      if (f[1] > 1 - eps) offY.push(-1 + eps);
      if (f[2] < eps) offZ.push(1 - eps);
      if (f[2] > 1 - eps) offZ.push(-1 + eps);

      for (const dx of offX) {
        for (const dy of offY) {
          for (const dz of offZ) {
            const nx = f[0] + dx;
            const ny = f[1] + dy;
            const nz = f[2] + dz;
            if (nx >= -eps && nx < 1 - eps + eps &&
                ny >= -eps && ny < 1 - eps + eps &&
                nz >= -eps && nz < 1 - eps + eps) {
              const cx = Math.min(Math.max(nx, 0), 1 - eps);
              const cy = Math.min(Math.max(ny, 0), 1 - eps);
              const cz = Math.min(Math.max(nz, 0), 1 - eps);
              newElements.push(atm);
              newFcrds.push([cx, cy, cz]);
              srcIndex.push(i);
            }
          }
        }
      }
    }
  }
  // If showPeriodic is false, return original frac and srcIndex
  if (!showPeriodic) {
    return {
      elements: elements,
      frac: frac,
      cart: fracToCart(frac,lattice),
      srcIndex: srcIndex
    };
  }

  // If showNeighbours is true, compute neighbors
  //
  //
  if (showPBCBonds) {
  // Copy lattice and precompute inverse

  // Convert wrapped fractional coords to Cartesian vectors
  const wrappedCart = newFcrds.map(f => {
    const cartArray = fracToCart([f], lattice)[0];
    return new THREE.Vector3(cartArray[0], cartArray[1], cartArray[2]);
  });

  // Maximum bond cutoff from settings
  const maxCutoff = Math.max(0.0, ...Object.values(bondLengths || {}).map(v => (typeof v === 'number' ? v : (v?.max ?? 0))), 0.0);

  const a = new THREE.Vector3(...lattice[0]);
  const b = new THREE.Vector3(...lattice[1]);
  const c = new THREE.Vector3(...lattice[2]);

  const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(a.length(), 1e-6))));
  const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(b.length(), 1e-6))));
  const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(c.length(), 1e-6))));

  // Generate periodic shifts (excluding zero)
  const shifts = [];
  for (let dx = -ax; dx <= ax; dx++)
    for (let dy = -by; dy <= by; dy++)
      for (let dz = -cz; dz <= cz; dz++)
        if (dx !== 0 || dy !== 0 || dz !== 0)
          shifts.push([dx, dy, dz]);

  const ghostAdded = new Set();

  // Loop over all wrapped atoms
  for (let i = 0; i < wrappedCart.length; i++) {
    const pi = wrappedCart[i];
    const ei = newElements[i];
    const atomIndex_i = srcIndex[i];

    // Loop over original atoms
    for (let j = 0; j < frac.length; j++) {
      const fj = frac[j];
      const ej = elements[j];
      const cutoff = getBondCutoff(ei, ej, bondLengths);
      if (cutoff <= 0.01) continue;

      // Convert fj to Cartesian coordinates
      const fjCartArray = fracToCart([fj], lattice)[0];
      const fjCart = new THREE.Vector3(fjCartArray[0], fjCartArray[1], fjCartArray[2]);

      for (const [dx, dy, dz] of shifts) {
        // Apply lattice shift
        const shiftVec = new THREE.Vector3()
          .addScaledVector(a, dx)
          .addScaledVector(b, dy)
          .addScaledVector(c, dz);

        const candidateCart = fjCart.clone().add(shiftVec);
        const d = pi.distanceTo(candidateCart);

        if (d <= cutoff && d >= 0.005) {
          const gkey = `${j}:${dx},${dy},${dz}`;
          if (!ghostAdded.has(gkey)) {
            // Convert back to fractional coordinates using robust function
            const candidateFrac = cartToFrac(
              [candidateCart.x, candidateCart.y, candidateCart.z],
              lattice,
              latticeInverse
            );

            // Add ghost atom
            newElements.push(ej);
            newFcrds.push(candidateFrac);
            srcIndex.push(j);

            ghostAdded.add(gkey);
          }
        }
      }
    }
  }
}

  // Always return all wrapped frac coords and their original indices

  return {
    elements: newElements,
    frac: newFcrds,
    cart: fracToCart(newFcrds,lattice),
    srcIndex: srcIndex,
  };
}





export function isOutsideUnitCell(cart, lattice, eps = 1e-6) {
  const f = cartToFrac(cart, lattice);
  return (f[0] < -eps || f[0] >= 1 + eps ||
          f[1] < -eps || f[1] >= 1 + eps ||
          f[2] < -eps || f[2] >= 1 + eps);
}



export function getBondCutoff(elem1, elem2, bondLengths) {
  const pair = elem1 < elem2 ? `${elem1}-${elem2}` : `${elem2}-${elem1}`;
  const v = bondLengths[pair];
  return (typeof v === 'number' ? v : (v?.max ?? 0)) || 0.0;
}
