import * as THREE from 'three';
import { app, groups, general,structureData, mode, atomicRadii,getLatticeVisSettings} from '../store.js';

import {disposeGroup} from '../panels/WindowAndSceneControls.js'

export function createLatticeLines(structureData,color = currentLatticeColor) {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial(getLatticeVisSettings(color));

  const lattice = structureData.lattice;

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
    groups.latticeGroup = createLatticeLines(structureData,color);
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
  if (!structureData || !structureData.lattice) {
    cachedLatticeDirs = {
      a: new THREE.Vector3(1,0,0),
      b: new THREE.Vector3(0,1,0),
      c: new THREE.Vector3(0,0,1)
    };
    return;
  }
  const L = structureData.lattice;
  cachedLatticeDirs = {
    a: new THREE.Vector3(L[0][0], L[0][1], L[0][2]).normalize(),
    b: new THREE.Vector3(L[1][0], L[1][1], L[1][2]).normalize(),
    c: new THREE.Vector3(L[2][0], L[2][1], L[2][2]).normalize()
  };
}
export function latticeDirsNorm() { return cachedLatticeDirs; }


export function periodicWrapped(frac, elements) {
  // Build a fully "filled" unit cell by duplicating atoms that sit on
  // faces/edges/corners so that both sides of each face are populated.
  // We do this by adding, per-dimension, one extra image just inside the
  // opposite face when an atom is within eps of a boundary.
  const eps = 1e-6;
  const newElements = [];
  const newFcrds = [];
  const srcIndex = [];

  for (let i = 0; i < frac.length; i++) {
    const f = frac[i];
    const atm = elements[i];

    // Decide offsets for each axis
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
          // keep strictly inside [0, 1)
          if (nx >= -eps && nx < 1 - eps + eps &&
              ny >= -eps && ny < 1 - eps + eps &&
              nz >= -eps && nz < 1 - eps + eps) {
            // clamp into range [0, 1-eps]
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

  return { elements: newElements, frac: newFcrds, srcIndex };
}


export function getCellCenterAndDist() {
  const L = structureData?.lattice || [[10,0,0],[0,10,0],[0,0,10]];
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
  if (!structureData) return {a:[1,0,0], b:[0,1,0], c:[0,0,1]};
  const L = structureData.lattice;
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

export function cartToFrac(cartVec, lattice) {
  const inverse = invert3x3(transpose3x3(lattice));
  return multiplyMatVec(inverse, cartVec);
}
