// Hide-mode ghost rendering: a translucent InstancedMesh showing every
// currently-hidden atom (Atom.hidden) at its true, periodic-aware position,
// shown only while mode.measureMode === 'hide'. Deliberately a much
// simpler standalone mesh than the real atoms mesh (render/AtomsFracUpdateModule.js)
// — plain MeshStandardMaterial, no cut-plane shader/pipeline integration — since
// this is a temporary picking aid for hide mode, not part of the main
// rendering pipeline's feature set.
//
// Ghosts are computed from structure.periodic.wrapped (the FULL, unfiltered
// cache — never structure.periodic.visibleWrapped, which excludes hidden
// atoms entirely) filtered to the inverse: keep only instances whose source
// atom IS hidden. Not stored on structure.periodic; recomputed fresh each
// call, since it's only needed transiently while hide mode is active.

import * as THREE from '../external/three/three.module.js';
import { app, groups, fileBrowser, general } from '../state/store.js';
import { getElementRadius } from '../defaults/radii_defaults.js';

const GHOST_OPACITY = 0.35;

function computeHiddenWrapped(structure) {
  const wrapped = structure?.periodic?.wrapped;
  const atoms = structure?.atoms;
  const srcIndex = wrapped?.srcIndex;
  if (!wrapped || !atoms || !srcIndex) return null;
  const elements = [], cart = [], srcOut = [];
  for (let i = 0; i < srcIndex.length; i++) {
    if (!atoms[srcIndex[i]]?.hidden) continue;
    elements.push(wrapped.elements[i]);
    cart.push(wrapped.cart[i]);
    srcOut.push(srcIndex[i]);
  }
  return { elements, cart, srcIndex: srcOut };
}

/** (Re)build the ghost mesh from the structure's current hidden atoms.
 *  Safe to call repeatedly (e.g. after every hide/restore click) — always
 *  disposes and rebuilds rather than trying to patch instance count in place. */
export function refreshGhostAtoms() {
  disposeGhostAtoms();
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  const hidden = computeHiddenWrapped(structure);
  if (!hidden || !hidden.elements.length) return;

  const count = hidden.elements.length;
  const geometry = new THREE.SphereGeometry(1, 16, 12);
  const material = new THREE.MeshStandardMaterial({
    transparent: true,
    opacity: GHOST_OPACITY,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3, false);

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const srcIdx = hidden.srcIndex[i];
    const atom = structure.atoms[srcIdx];
    const element = hidden.elements[i];
    const radius = getElementRadius(element) * (general.atomSize ?? 1) * (atom.getRadiusScale?.() ?? 1);
    const c = hidden.cart[i];
    dummy.position.set(c[0], c[1], c[2]);
    dummy.scale.setScalar(radius);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    color.set(atom.getColor());
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  // Consumed by SceneInteraction's hide-mode click handling to resolve a
  // ghost instance back to its source atom in structure.atoms.
  mesh.userData.srcIndex = hidden.srcIndex;

  app.scene.add(mesh);
  groups.ghostAtomsMesh = mesh;
}

export function disposeGhostAtoms() {
  const mesh = groups.ghostAtomsMesh;
  if (!mesh) return;
  app.scene.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
  groups.ghostAtomsMesh = null;
}

// Deliberately distinct from the app's other selection colors (the orange
// used by measurement picking and the Planes-panel atom-selection highlight)
// so a hide/restore flash never reads as "this is part of some other
// selection" — it means one thing only: about to be hidden or restored.
// Exported so SceneInteraction.js's real-atom flash uses the exact same hue.
export const HIDE_FLASH_COLOR = new THREE.Color(0x21D4FD);

/** Momentarily bump one ghost instance to the flash color. Never reverted
 *  explicitly — the caller commits the restore right after the flash
 *  window, which tears down and rebuilds this whole mesh via
 *  refreshGhostAtoms(), so the bumped color simply never survives. */
export function flashGhost(instanceId) {
  const mesh = groups.ghostAtomsMesh;
  if (!mesh || instanceId == null || instanceId < 0 || instanceId >= mesh.count) return;
  mesh.setColorAt(instanceId, HIDE_FLASH_COLOR);
  mesh.instanceColor.needsUpdate = true;
}
