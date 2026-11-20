// Orange ghost overlay for the selection highlight: atoms as slightly larger
// spheres, bonds as fattened cylinders, polyhedra as ghost copies, drawn after
// the frame with the depth test off so the highlight shows through anything.
//
// Two users:
//   - the ray/path tracers draw it over every traced frame for EVERY
//     highlighted instance — their encoder ignores the raster recolor so a
//     selection never restarts the accumulation;
//   - the raster pipelines draw it for the highlighted instances that are
//     see-through (alpha below 1). The raster highlight is the instance's own
//     emissive glow and recolor, which fade with its alpha and vanish at 0 —
//     the ghost keeps a selected atom, bond or polyhedron marked at any
//     opacity, while opaque ones keep their usual glow unchanged.
// Reads the highlight instance ids recorded on the highlightHover store
// singleton (no ui-layer import).

import * as THREE from '../external/three/three.module.js';
import { groups, highlightHover } from '../state/store.js';

const HL = 0xFF8C00;
const TRANSLUCENT_BELOW = 0.999;

function instanceAlpha(mesh, i) {
  const attr = mesh.geometry?.attributes?.instanceOpacity;
  return (attr ? attr.getX(i) : 1) * (mesh.material?.opacity ?? 1);
}

export class HighlightOverlay {
  _scene = null;
  _atomsMesh = null;
  _bondsMesh = null;
  _polyMat = null;
  _polyGhosts = null;
  _mat = null;
  _scaleAtom = null;
  _scaleBond = null;

  _ensure() {
    if (this._scene) return;
    this._scene = new THREE.Scene();
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    const atomMat = new THREE.MeshBasicMaterial({
      color: HL, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false });
    this._atomsMesh = new THREE.InstancedMesh(sphere, atomMat, 8);
    this._atomsMesh.frustumCulled = false;
    this._atomsMesh.count = 0;
    this._scene.add(this._atomsMesh);
    // Unit cylinder matching the bonds mesh instance-matrix convention
    // (CylinderGeometry height 1, radius 1: local y in [-0.5, 0.5]).
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
    const bondMat = new THREE.MeshBasicMaterial({
      color: HL, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false });
    this._bondsMesh = new THREE.InstancedMesh(cyl, bondMat, 8);
    this._bondsMesh.frustumCulled = false;
    this._bondsMesh.count = 0;
    this._scene.add(this._bondsMesh);
    this._polyMat = new THREE.MeshBasicMaterial({
      color: HL, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false });
    this._polyGhosts = []; // reused Mesh pool (share the highlighted geometry)
    this._mat = new THREE.Matrix4();
    this._scaleAtom = new THREE.Matrix4().makeScale(1.12, 1.12, 1.12); // rim
    this._scaleBond = new THREE.Matrix4().makeScale(1.3, 1, 1.3);      // fatten radius only
  }

  /** InstancedMesh capacity grow (its capacity is fixed at construction). */
  _grow(mesh, needed) {
    if (needed <= mesh.instanceMatrix.count) return mesh;
    const cap = Math.max(needed, mesh.instanceMatrix.count * 2);
    const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material, cap);
    grown.frustumCulled = false;
    grown.count = 0;
    this._scene.remove(mesh);
    this._scene.add(grown);
    mesh.dispose();
    return grown;
  }

  /** Meshes of the currently-highlighted polyhedron (all periodic copies when
   *  linked). Matched by stable key or group key on the mesh userData. */
  static highlightedPolyMeshes() {
    const sel = highlightHover.currentlyHighlightedPolyhedron;
    const group = groups.polyhedraGroup;
    // the selection bar's Polyhedra view (a set of meshes, no single pick)
    const viewMeshes = (highlightHover.currentlyHighlightedPolyMeshes ?? []).filter((m) => m.visible && m.parent);
    if (!sel || !group) return viewMeshes;
    return group.children.filter((m) => m.userData?.type === 'polyhedron' && m.visible
      && (sel.groupKey ? m.userData.groupKey === sel.groupKey : m.userData.key === sel.key))
      .concat(viewMeshes.filter((m) => m.userData?.key !== sel.key));
  }

  /** Draw the ghosts over the current framebuffer (the caller leaves the
   *  render target at null and must not clear). `translucentOnly` limits
   *  the ghosts to instances drawn below alpha 1 (the raster pipelines). */
  render(renderer, camera, { translucentOnly = false } = {}) {
    const atomsMesh = groups.atomsMesh;
    const bondsMesh = groups.bondsMesh;
    const translucent = (mesh, id) => !translucentOnly || instanceAlpha(mesh, id) < TRANSLUCENT_BELOW;
    const atomIds = (highlightHover.currentlyHighlightedAtomInstances ?? [])
      .filter((id) => atomsMesh && id >= 0 && id < atomsMesh.count && translucent(atomsMesh, id));
    const bondIds = (highlightHover.currentlyHighlightedBond?.instanceIds
      ?? highlightHover.currentlyHighlightedBondInstances ?? [])
      .filter((id) => bondsMesh && id >= 0 && id < bondsMesh.count && translucent(bondsMesh, id));
    const polyMeshes = HighlightOverlay.highlightedPolyMeshes()
      .filter((m) => !translucentOnly || (m.material?.opacity ?? 1) < TRANSLUCENT_BELOW);
    if (!atomIds.length && !bondIds.length && !polyMeshes.length) {
      if (this._scene) { // nothing selected: make sure any stale ghosts are hidden
        this._atomsMesh.count = 0;
        this._bondsMesh.count = 0;
        for (const g of this._polyGhosts) g.visible = false;
      }
      return;
    }
    this._ensure();

    // atoms: copy each highlighted instance matrix, scaled up slightly
    if (atomIds.length) {
      this._atomsMesh = this._grow(this._atomsMesh, atomIds.length);
      let n = 0;
      for (const id of atomIds) {
        atomsMesh.getMatrixAt(id, this._mat);
        if (this._mat.elements[0] === 0) continue; // hidden (zero-scaled) instance
        this._mat.multiply(this._scaleAtom);
        this._atomsMesh.setMatrixAt(n++, this._mat);
      }
      this._atomsMesh.count = n;
      this._atomsMesh.instanceMatrix.needsUpdate = true;
    } else {
      this._atomsMesh.count = 0;
    }

    // bonds: copy each highlighted half's instance matrix, fatten the radius
    if (bondIds.length) {
      this._bondsMesh = this._grow(this._bondsMesh, bondIds.length);
      let n = 0;
      for (const id of bondIds) {
        bondsMesh.getMatrixAt(id, this._mat);
        if (this._mat.elements[0] === 0 && this._mat.elements[5] === 0) continue; // culled
        this._mat.multiply(this._scaleBond);
        this._bondsMesh.setMatrixAt(n++, this._mat);
      }
      this._bondsMesh.count = n;
      this._bondsMesh.instanceMatrix.needsUpdate = true;
    } else {
      this._bondsMesh.count = 0;
    }

    // polyhedra: ghost copies sharing the highlighted meshes' geometry
    for (const g of this._polyGhosts) g.visible = false;
    polyMeshes.forEach((pm, i) => {
      let ghost = this._polyGhosts[i];
      if (!ghost) {
        ghost = new THREE.Mesh(pm.geometry, this._polyMat);
        ghost.frustumCulled = false;
        ghost.matrixAutoUpdate = false;
        this._scene.add(ghost);
        this._polyGhosts[i] = ghost;
      }
      ghost.geometry = pm.geometry;
      pm.updateWorldMatrix(true, false);
      ghost.matrix.copy(pm.matrixWorld);
      ghost.visible = true;
    });

    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this._scene, camera);
    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    if (!this._scene) return;
    this._atomsMesh.geometry.dispose();
    this._atomsMesh.material.dispose();
    this._atomsMesh.dispose();
    this._bondsMesh.geometry.dispose();
    this._bondsMesh.material.dispose();
    this._bondsMesh.dispose();
    this._polyMat.dispose();
    this._scene = null;
    this._polyGhosts = null;
  }
}

// The raster pipelines share one overlay (they are swapped freely; the ghosts
// hold no pipeline state). Drawn after the outline pass, see-through
// highlights only.
let rasterOverlay = null;
export function renderRasterHighlightOverlay(renderer, camera) {
  if (!rasterOverlay) rasterOverlay = new HighlightOverlay();
  rasterOverlay.render(renderer, camera, { translucentOnly: true });
}
