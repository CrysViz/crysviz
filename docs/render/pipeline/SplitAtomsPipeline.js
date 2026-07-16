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
import { createAtomsMaterial } from '../AtomsFracUpdateModule.js';
import { setAlphaPass } from '../MaterialStyles.js';
import { ForwardPipeline } from './ForwardPipeline.js';

export class SplitAtomsPipeline extends ForwardPipeline {
  static id = 'split-atoms';
  static label = 'Split transparent atoms';
  // Superseded by wboit/depthpeel; kept registered for regression tests +
  // legacy sessions. Hidden from the GUI dropdown (unhide via general.showAllRenderPipelines).
  static hidden = true;

  id = SplitAtomsPipeline.id;
  label = SplitAtomsPipeline.label;
  hidden = SplitAtomsPipeline.hidden;

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
    setAlphaPass(material, splitPasses ? 1 : 0);
    material.needsUpdate = true;

    const overlay = splitPasses ? this._ensureOverlay(mesh) : mesh.userData.transparentOverlay;
    if (overlay) {
      overlay.visible = splitPasses;
      overlay.material.opacity = baseOpacity;
    }
  }

  /** Lazily create the transparent-pass overlay for an instanced mesh.
   *  `makeMaterial` builds a shader-compatible material (atoms by default;
   *  WboitPipeline reuses this for bonds with createBondsMaterial). */
  _ensureOverlay(mesh, makeMaterial = createAtomsMaterial) {
    let overlay = mesh.userData.transparentOverlay;
    if (overlay) return overlay;
    const material = makeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.userData.alphaPass = 2;
    this._patchOverlayMaterial(material);
    overlay = this._createOverlayMesh(mesh, material);
    overlay.raycast = () => {}; // never intercept picking
    overlay.name = 'transparentInstancesOverlay';
    mesh.userData.transparentOverlay = overlay;
    this._attachOverlay(mesh, overlay);
    return overlay;
  }

  /** Hook: extra treatment of a freshly created overlay material (WBOIT patch). */
  _patchOverlayMaterial(_material) {}

  /** Hook: where the overlay lives. Default: child of its source mesh, so
   *  visibility toggles and scene removal carry over for free. (WboitPipeline
   *  parents it to the scene instead — WboitPass drives its render stages by
   *  toggling mesh.visible, which would hide a child overlay along with its
   *  opaque parent.) */
  _attachOverlay(mesh, overlay) {
    mesh.add(overlay);
  }

  /** Overlay mesh construction — overridden by SortedAtomsPipeline. */
  _createOverlayMesh(mesh, material) {
    const overlay = new THREE.InstancedMesh(mesh.geometry, material, mesh.count);
    overlay.instanceMatrix = mesh.instanceMatrix; // shared — follows all updates
    overlay.instanceColor = mesh.instanceColor;
    overlay.frustumCulled = mesh.frustumCulled;
    return overlay;
  }

  /** The meshes this pipeline may have attached overlays/alpha passes to. */
  _overlaySources() {
    return [groups.atomsMesh].filter(Boolean);
  }

  /** Undo everything this pipeline attached, so the next pipeline starts from
   *  clean forward state. */
  dispose() {
    for (const mesh of this._overlaySources()) {
      setAlphaPass(mesh.material, 0);
      const overlay = mesh.userData.transparentOverlay;
      if (!overlay) continue;
      overlay.parent?.remove(overlay);
      if (overlay.geometry !== mesh.geometry) overlay.geometry.dispose();
      overlay.material.dispose();
      delete mesh.userData.transparentOverlay;
    }
  }
}
