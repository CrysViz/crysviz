// "Split transparent atoms" pipeline: forward rendering plus a two-pass split
// of the main atoms mesh when individual atoms are transparent.
//
// Instances inside one InstancedMesh render in index order — three.js cannot
// depth-sort them — so the forward pipeline's single blended pass with depth
// writes off lets any later-indexed atom paint over a nearer one (a
// transparent atom visually "drops behind" opaque neighbours). This pipeline
// instead keeps the main atoms material OPAQUE with depth writes on and
// discards the transparent instances' fragments from it (uAlphaPass 1, see
// createAtomsMaterial in render/AtomsFracUpdateModule.js); the transparent
// instances render in an overlay child InstancedMesh (uAlphaPass 2, blended,
// depth-TESTED against the opaque pass). Opaque↔transparent occlusion then
// resolves per pixel via the depth buffer. Transparent-over-transparent
// overlap remains order-dependent — SortedAtomsPipeline fixes that too.
//
// The overlay shares the main mesh's geometry and instance buffers (the
// addCelOutline pattern): visibility toggles, scene removal, and every
// attribute update carry over for free. Whole-structure transparency (the
// opacity slider) keeps the legacy single blended pass — everything blends
// there, so per-pair order errors are much less visible than losing the
// see-through-everything look.
//
// All other transparency kinds behave exactly like the forward pipeline.

import * as THREE from '../../external/three/three.module.js';
import { groups } from '../../state/store.js';
import { createAtomsMaterial, setAtomAlphaPass } from '../AtomsFracUpdateModule.js';
import { ForwardPipeline } from './ForwardPipeline.js';

export class SplitAtomsPipeline extends ForwardPipeline {
  static id = 'split-atoms';
  static label = 'Split transparent atoms';

  id = SplitAtomsPipeline.id;
  label = SplitAtomsPipeline.label;

  applyTransparency(material, spec = {}) {
    if (spec.kind !== 'atoms' || !spec.mesh) {
      super.applyTransparency(material, spec);
      return;
    }
    const mesh = spec.mesh;
    const baseOpacity = spec.opacity ?? 1;
    const globalTransparency = baseOpacity < 0.999;
    const splitPasses = !globalTransparency && !!spec.needsTransparency;
    material.transparent = globalTransparency;
    material.depthWrite = !globalTransparency;
    setAtomAlphaPass(material, splitPasses ? 1 : 0);
    material.needsUpdate = true;

    const overlay = splitPasses ? this._ensureOverlay(mesh) : mesh.userData.transparentOverlay;
    if (overlay) {
      overlay.visible = splitPasses;
      overlay.material.opacity = baseOpacity;
    }
  }

  /** Lazily create the transparent-pass overlay child of the atoms mesh. */
  _ensureOverlay(mesh) {
    let overlay = mesh.userData.transparentOverlay;
    if (overlay) return overlay;
    const material = createAtomsMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.userData.alphaPass = 2;
    overlay = this._createOverlayMesh(mesh, material);
    overlay.raycast = () => {}; // never intercept picking
    overlay.name = 'transparentAtomsOverlay';
    mesh.userData.transparentOverlay = overlay;
    mesh.add(overlay);
    return overlay;
  }

  /** Overlay mesh construction — overridden by SortedAtomsPipeline. */
  _createOverlayMesh(mesh, material) {
    const overlay = new THREE.InstancedMesh(mesh.geometry, material, mesh.count);
    overlay.instanceMatrix = mesh.instanceMatrix; // shared — follows all updates
    overlay.instanceColor = mesh.instanceColor;
    overlay.frustumCulled = mesh.frustumCulled;
    return overlay;
  }

  /** Undo everything this pipeline attached to the atoms mesh, so the next
   *  pipeline starts from clean forward state. */
  dispose() {
    const mesh = groups.atomsMesh;
    if (!mesh) return;
    setAtomAlphaPass(mesh.material, 0);
    const overlay = mesh.userData.transparentOverlay;
    if (!overlay) return;
    mesh.remove(overlay);
    if (overlay.geometry !== mesh.geometry) overlay.geometry.dispose();
    overlay.material.dispose();
    delete mesh.userData.transparentOverlay;
  }
}
