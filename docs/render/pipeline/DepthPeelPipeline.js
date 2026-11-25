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
import { prepareCelOutlinePass, renderCelOutlinePass } from '../CelOutlinePass.js';
import { renderRasterHighlightOverlay } from '../HighlightOverlay.js';
import { renderFocusPeaking } from '../FocusPlaneModule.js';
import { requestRender } from '../AnimateModule.js';
import { StagedTransparencyPipeline } from './StagedTransparencyPipeline.js';

export class DepthPeelPipeline extends StagedTransparencyPipeline {
  static id = 'depthpeel';
  static label = 'Depth peeling (default)';

  id = DepthPeelPipeline.id;
  label = DepthPeelPipeline.label;

  _pass = null;
  // Camera pose of the last interactive frame, to tell a moving camera (few
  // peel layers, see render) from one at rest (the full count).
  _lastCameraPose = null;
  _motionFrame = false; // test-inspectable: the last frame used the motion layer count

  /** Peel layers for this frame. While the camera moves in an interactive
   *  frame (the animate loop, the tracers' raster preview) only
   *  general.depthPeelMotionLayers are peeled — like the tracers' motion
   *  low-res — and one more frame is requested, so the first frame at rest
   *  re-renders with the full general.depthPeelLayers. PNG export and other
   *  non-interactive renders always peel the full count. */
  _layerCountFor(camera, interactive) {
    const full = general.depthPeelLayers ?? 15;
    const motion = Math.max(1, Math.min(full, general.depthPeelMotionLayers ?? full));
    if (!interactive || motion >= full) { this._motionFrame = false; return full; }
    camera.updateMatrixWorld();
    const pose = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements];
    const moved = !!this._lastCameraPose && pose.some((v, i) => v !== this._lastCameraPose[i]);
    this._lastCameraPose = pose;
    this._motionFrame = moved;
    if (moved) requestRender(); // the settle frame, at the full count
    return moved ? motion : full;
  }

  render({ renderer, scene, camera, interactive = false }) {
    if (!this._pass) {
      this._pass = new DepthPeelPass(renderer, scene, camera);
    }
    this._pass.scene = scene;
    this._pass.camera = camera;
    this._pass.setLayerCount(this._layerCountFor(camera, interactive));
    this._syncOverlayVisibility();
    prepareCelOutlinePass(renderer, scene, camera);
    this._pass.render(renderer);
    renderCelOutlinePass(renderer, scene, camera);
    renderRasterHighlightOverlay(renderer, camera); // see-through selection ghosts
    renderFocusPeaking(renderer, scene, camera); // DoF focus peaking while a DoF slider is dragged
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
