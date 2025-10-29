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
