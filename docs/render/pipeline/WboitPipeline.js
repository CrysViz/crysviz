// "Weight blended (WBOIT)" pipeline: order-independent transparency via the
// vendored three-wboit library (docs/external/three-wboit/ — McGuire & Bavoil
// weighted blended OIT). Every frame runs WboitPass's stages instead of a
// plain renderer.render: opaque pass → plain-transparent pass → WBOIT depth
// range → revealage → accumulation → full-screen composite. All transparent
// content blends order-independently — including ACROSS meshes. The
// accumulation weight is transmittance-interpolated (WboitUtils.js): each
// fragment is weighted by the estimated transmittance of the transparent
// fragments in front of it, derived from the pixel's revealage and its
// transparent depth range. That is exact for two fragments and for equally
// spaced stacks, and converges on the opaque rendering as alpha → 1 (no jump
// between alpha 0.99 and 1); unevenly spaced deep stacks remain approximate.
// The staging/split/overlay behaviour lives in StagedTransparencyPipeline;
// this class contributes the WBOIT material patch and the pass lifecycle.

import * as THREE from '../../external/three/three.module.js';
import { app } from '../../state/store.js';
import { WboitPass } from '../../external/three-wboit/WboitPass.js';
import { WboitUtils } from '../../external/three-wboit/WboitUtils.js';
import { renderCelOutlinePass } from '../CelOutlinePass.js';
import { StagedTransparencyPipeline } from './StagedTransparencyPipeline.js';

export class WboitPipeline extends StagedTransparencyPipeline {
  static id = 'wboit';
  static label = 'Weight blended (WBOIT)';

  id = WboitPipeline.id;
  label = WboitPipeline.label;

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
    super.dispose(); // overlays + alpha-pass resets for atoms AND bonds
    this._pass?.dispose();
    this._pass = null;
  }

  _patchTransparentMaterial(material) {
    WboitUtils.patch(material);
  }
}
