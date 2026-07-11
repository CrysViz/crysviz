// "Depth peeling" pipeline: EXACT order-independent transparency up to N peel
// layers, via the adapted docs/external/three-depthpeeling/ (from
// gkjohnson/three-depthpeeling-demo). Each frame renders the opaque set once
// (capturing its depth), then peels the transparent set N times — every peel
// keeps the nearest fragments strictly behind the previous peel — and
// composites the peels back-to-front. Unlike WBOIT's soft weighted average
// this is true per-pixel compositing (including across meshes); the trade-off
// is N+1 scene renders per frame and that surfaces deeper than N layers are
// dropped. N is user-adjustable ("Peel layers" slider in the Visual window,
// general.depthPeelLayers). The staging/split/overlay behaviour lives in
// StagedTransparencyPipeline; this class contributes the peel material patch
// and the pass lifecycle.

import * as THREE from '../../external/three/three.module.js';
import { app, general } from '../../state/store.js';
import { DepthPeelPass } from '../../external/three-depthpeeling/DepthPeelPass.js';
import { DepthPeelUtils } from '../../external/three-depthpeeling/DepthPeelUtils.js';
import { renderCelOutlinePass } from '../CelOutlinePass.js';
import { StagedTransparencyPipeline } from './StagedTransparencyPipeline.js';

export class DepthPeelPipeline extends StagedTransparencyPipeline {
  static id = 'depthpeel';
  static label = 'Depth peeling';

  id = DepthPeelPipeline.id;
  label = DepthPeelPipeline.label;

  _pass = null;

  render({ renderer, scene, camera }) {
    if (!this._pass) {
      this._pass = new DepthPeelPass(renderer, scene, camera);
    }
    this._pass.scene = scene;
    this._pass.camera = camera;
    this._pass.setLayerCount(general.depthPeelLayers ?? 5);
    this._syncOverlayVisibility();
    this._pass.render(renderer);
    renderCelOutlinePass(renderer, scene, camera);
  }

  setSize(_width, _height) {
    // Authoritative device-pixel size (resize passes CSS px, export device px).
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
    DepthPeelUtils.patch(material);
  }
}
