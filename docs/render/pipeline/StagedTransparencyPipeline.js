// Shared base for pipelines that render transparency in offscreen stages
// driven by a scene-traversing pass (WBOIT, depth peeling). Extends the
// atoms split with:
//
// - the same opaque/transparent instance split for BONDS (both meshes carry
//   the uAlphaPass shader capability);
// - whole-mesh routing under global transparency (the opacity slider): the
//   whole point of these pipelines is order-independent blending, so there is
//   no legacy single-pass carve-out — the entire mesh joins the staged
//   transparent set;
// - patching of every uniform-opacity transparent surface via the abstract
//   `_patchTransparentMaterial(material)` hook (WBOIT patch / peel patch);
// - SCENE-ROOT overlays: staged passes drive their stages by toggling
//   mesh.visible, which would hide an overlay parented under its (opaque)
//   source mesh. Because scene-root overlays no longer inherit the source
//   mesh's visibility (Show Atoms/Bonds toggles flip mesh.visible directly),
//   subclasses call _syncOverlayVisibility() each frame before their pass.
//
// Subclasses provide: id/label statics, _patchTransparentMaterial(), render(),
// setSize(), and dispose() (call super.dispose() to clean the overlays).

import { app, groups } from '../../state/store.js';
import { createAtomsMaterial } from '../AtomsFracUpdateModule.js';
import { createBondsMaterial } from '../BondsFracUpdateModule.js';
import { setAlphaPass } from '../MaterialStyles.js';
import { ForwardPipeline } from './ForwardPipeline.js';
import { SplitAtomsPipeline } from './SplitAtomsPipeline.js';

export class StagedTransparencyPipeline extends SplitAtomsPipeline {
  // Staged pipelines are order-independent — the isosurface CPU triangle
  // sort is unnecessary.
  needsCpuTriangleSort = false;

  applyTransparency(material, spec = {}) {
    switch (spec.kind) {
      case 'atoms':
        if (spec.mesh) return this._applyInstancedSplit(material, spec, createAtomsMaterial);
        break;
      case 'bonds':
        if (spec.mesh) return this._applyInstancedSplit(material, spec, createBondsMaterial);
        break;
      default:
        break;
    }
    // Uniform-opacity kinds: forward semantics decide `transparent`/opacity
    // (skip SplitAtomsPipeline's dispatcher — it would re-route 'atoms')...
    ForwardPipeline.prototype.applyTransparency.call(this, material, spec);
    // ...then transparent materials join the staged transparent set (patched
    // materials that later turn opaque are classified back as opaque).
    if (material.transparent) {
      this._patchTransparentMaterial(material);
      material.depthWrite = false;
      material.needsUpdate = true;
    }
  }

  /** Atoms/bonds: whole mesh through the staged pass under global
   *  transparency, otherwise the opaque/transparent instance split with a
   *  patched overlay. */
  _applyInstancedSplit(material, spec, makeMaterial) {
    const mesh = spec.mesh;
    const baseOpacity = spec.opacity ?? 1;
    const overlay = mesh.userData.transparentOverlay;
    if (baseOpacity < 0.999) {
      // Whole-structure transparency: everything blends — exactly what an
      // order-independent pass is for. Patch the main material and let all
      // instances join the transparent stage.
      this._patchTransparentMaterial(material);
      material.transparent = true;
      material.depthWrite = false;
      setAlphaPass(material, 0);
      material.needsUpdate = true;
      if (overlay) {
        overlay.userData.wantsVisible = false;
        overlay.visible = false;
      }
      return;
    }
    const splitPasses = !!spec.needsTransparency;
    material.transparent = false;
    material.depthWrite = true;
    setAlphaPass(material, splitPasses ? 1 : 0);
    material.needsUpdate = true;
    const liveOverlay = splitPasses ? this._ensureOverlay(mesh, makeMaterial) : overlay;
    if (liveOverlay) {
      liveOverlay.userData.wantsVisible = splitPasses;
      liveOverlay.visible = splitPasses && mesh.visible !== false;
      liveOverlay.material.opacity = baseOpacity;
    }
  }

  /** Abstract: retrofit a material for this pipeline's transparent stage. */
  _patchTransparentMaterial(_material) {
    throw new Error('StagedTransparencyPipeline: _patchTransparentMaterial must be implemented');
  }

  /** Overlay materials participate in the staged transparent set too. */
  _patchOverlayMaterial(material) {
    this._patchTransparentMaterial(material);
  }

  /** Scene-root parenting (see the header note on visibility staging). */
  _attachOverlay(_mesh, overlay) {
    app.scene.add(overlay);
  }

  _overlaySources() {
    return [groups.atomsMesh, groups.bondsMesh].filter(Boolean);
  }

  /** Scene-root overlays don't inherit their source mesh's visibility —
   *  subclasses call this each frame before running their pass. */
  _syncOverlayVisibility() {
    for (const mesh of this._overlaySources()) {
      const overlay = mesh.userData.transparentOverlay;
      if (overlay) overlay.visible = overlay.userData.wantsVisible === true && mesh.visible !== false;
    }
  }
}
