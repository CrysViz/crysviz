// "Weighted blended (WBOIT)" pipeline: order-independent transparency via the
// vendored three-wboit library (docs/external/three-wboit/ — McGuire & Bavoil
// weighted blended OIT). Every frame runs WboitPass's stages instead of a
// plain renderer.render: opaque pass → plain-transparent pass → WBOIT
// accumulation → revealage → full-screen composite. All transparent content
// blends order-independently — including ACROSS meshes (transparent atom over
// transparent bond over isosurface), the case no sorting-based pipeline fixes.
//
// Coverage:
// - Atoms AND bonds use the opaque/transparent instance split (uAlphaPass):
//   fully opaque instances stay in the crisp depth-written opaque pass (WBOIT
//   would give them slight artificial transparency), while the transparent
//   instances render in a WBOIT-patched overlay. Under whole-structure
//   transparency (opacity slider < 1) the entire mesh goes through WBOIT
//   instead — no legacy order-dependent carve-out.
// - Every uniform-opacity transparent surface (comparison meshes, polyhedra
//   faces/edges, isosurface, planes + borders, measurement ghosts) is
//   WBOIT-patched when transparent; when opaque it renders in the opaque pass
//   (WboitPass classifies patched-but-opaque materials as opaque).
//
// Overlays are parented to the SCENE, not to their source mesh: WboitPass
// drives its stages by toggling mesh.visible, and hiding the opaque source
// mesh would hide a child overlay with it. render() re-syncs each overlay's
// visibility with its source mesh (Show Atoms/Bonds toggles flip mesh.visible
// directly), and rebuild/dispose paths detach via overlay.parent.
//
// WBOIT is approximate: overlapping transparency composites smoothly but not
// exactly (high-alpha overlaps look softer than back-to-front compositing).
// The exact-but-order-dependent pipelines stay one dropdown click away.

import * as THREE from '../../external/three/three.module.js';
import { app, groups } from '../../state/store.js';
import { WboitPass } from '../../external/three-wboit/WboitPass.js';
import { WboitUtils } from '../../external/three-wboit/WboitUtils.js';
import { createAtomsMaterial } from '../AtomsFracUpdateModule.js';
import { createBondsMaterial } from '../BondsFracUpdateModule.js';
import { setAlphaPass } from '../MaterialStyles.js';
import { renderCelOutlinePass } from '../CelOutlinePass.js';
import { ForwardPipeline } from './ForwardPipeline.js';
import { SplitAtomsPipeline } from './SplitAtomsPipeline.js';

export class WboitPipeline extends SplitAtomsPipeline {
  static id = 'wboit';
  static label = 'Weighted blended (WBOIT)';

  id = WboitPipeline.id;
  label = WboitPipeline.label;

  // Order-independent — the isosurface CPU triangle sort is unnecessary.
  needsCpuTriangleSort = false;

  _pass = null;

  render({ renderer, scene, camera }) {
    if (!this._pass) {
      // Constructor probes render-target float support against the live renderer.
      this._pass = new WboitPass(renderer, scene, camera);
      // Clear the screen buffer each frame (WboitPass sets autoClear=false and
      // its opaque blit discards empty pixels, which would otherwise leave
      // stale pixels — or, for the PNG export's scene.background=null capture,
      // an opaque background). Transparent black composes correctly under both:
      // an opaque scene.background repaints every pixel anyway.
      this._pass.clearColor = new THREE.Color(0x000000);
      this._pass.clearAlpha = 0.0;
    }
    this._pass.scene = scene;
    this._pass.camera = camera;
    this._syncOverlayVisibility();
    this._pass.render(renderer);
    renderCelOutlinePass(renderer, scene, camera);
  }

  setSize(_width, _height) {
    // Authoritative device-pixel size: resizeRenderer passes CSS px while the
    // PNG export passes device px — the drawing buffer is always right.
    if (!this._pass || !app.renderer) return;
    const size = app.renderer.getDrawingBufferSize(new THREE.Vector2());
    this._pass.setSize(size.width, size.height);
  }

  dispose() {
    super.dispose(); // overlays + alpha-pass resets for atoms AND bonds (via _overlaySources)
    this._pass?.dispose();
    this._pass = null;
  }

  _overlaySources() {
    return [groups.atomsMesh, groups.bondsMesh].filter(Boolean);
  }

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
    // ...then transparent materials join the WBOIT stage (patched materials
    // that later turn opaque are classified back into the opaque pass).
    if (material.transparent) {
      WboitUtils.patch(material);
      material.depthWrite = false;
      material.needsUpdate = true;
    }
  }

  /** Atoms/bonds: whole mesh through WBOIT under global transparency,
   *  otherwise the opaque/transparent instance split with a WBOIT overlay. */
  _applyInstancedSplit(material, spec, makeMaterial) {
    const mesh = spec.mesh;
    const baseOpacity = spec.opacity ?? 1;
    const overlay = mesh.userData.transparentOverlay;
    if (baseOpacity < 0.999) {
      // Whole-structure transparency: everything blends — exactly what WBOIT
      // is for. Patch the main material and let all instances accumulate.
      WboitUtils.patch(material);
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

  /** Overlay materials participate in the WBOIT accumulation stage. */
  _patchOverlayMaterial(material) {
    WboitUtils.patch(material);
  }

  /** Scene-root parenting (see the header note on WboitPass visibility staging). */
  _attachOverlay(_mesh, overlay) {
    app.scene.add(overlay);
  }

  // Scene-root overlays don't inherit their source mesh's visibility (Show
  // Atoms/Bonds toggles flip mesh.visible directly) — re-sync per frame.
  _syncOverlayVisibility() {
    for (const mesh of this._overlaySources()) {
      const overlay = mesh.userData.transparentOverlay;
      if (overlay) overlay.visible = overlay.userData.wantsVisible === true && mesh.visible !== false;
    }
  }
}
