import * as THREE from '/external/three/three.module.js';

//imports in worker are relative to index!!


self.onmessage = function(e) {
  const { functionName, args } = e.data;
  console.warn("wrapWorker recevied message...")

  if (functionName === 'periodicWrapped') {
    try {
      console.log("calling periidicWrapped in worker")
      const result = periodicWrapped(...args);
      postMessage(result);
    } catch (error) {
      console.log("failed to call periidicWrapped in worker")
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
    console.log("worker calculates periodic bonds")
  // Copy lattice and precompute inverse

  // Convert wrapped fractional coords to Cartesian vectors
  const wrappedCart = newFcrds.map(f => {
    const cartArray = fracToCart([f], lattice)[0];
    return new THREE.Vector3(cartArray[0], cartArray[1], cartArray[2]);
  });

  // Maximum bond cutoff from settings
  const maxCutoff = Math.max(0.0, ...Object.values(bondLengths || { dummy: 0.0 }));

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


export function getBondCutoff(elem1, elem2, bondLengths) {
  const pair1 = elem1 + '-' + elem2;
  const pair2 = elem2 + '-' + elem1;
  return bondLengths[pair1] || bondLengths[pair2] || 0.0;
}
