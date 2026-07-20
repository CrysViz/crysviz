
import * as THREE from '../external/three/three.module.js';

import { app, general} from '../state/store.js';
import {updateLattice,latticeDirsNorm} from './LatticeModule.js'
import { syncGroundPlaneVisibility } from './GroundPlaneModule.js'

import {updateRandomColors, startDisco, stopDisco} from '../ui/DiscoModule.js'


let isRendering = true;

// On-demand rendering: the rAF loop always runs (controls damping needs it),
// but the actual renderer/gizmo/label passes only happen when something
// invalidated the frame. Anything that changes what's on screen must call
// requestRender() — camera motion is covered by the TrackballControls 'change'
// event, scene changes by updateVisualization(), and synchronous UI-driven
// changes by the document-level catch-all listeners wired below.
let needsRender = true;

export function requestRender() {
  needsRender = true;
}

/** The actual pipeline/gizmo/label draw calls for one frame, with no camera/
 *  controls/lighting update — just paint whatever the scene currently holds.
 *  Used by the on-demand animate loop (interactive:true) and, synchronously,
 *  by resizeRenderer() (interactive:false) right after it resizes the canvas:
 *  resizing a canvas clears its WebGL drawing buffer immediately (and this
 *  renderer is alpha:true, so a cleared-but-unpainted canvas is transparent),
 *  so leaving the repaint to wait for needsRender's next throttled/queued rAF
 *  tick left a real gap the browser could composite in between — the cleared,
 *  transparent canvas revealing the page's background color underneath — on
 *  every resize event during a drag. Rendering immediately, in the same tick
 *  as the resize, closes that gap. */
export function renderFrameNow({ interactive = false } = {}) {
  if (!app.renderer || !app.pipeline || !app.scene || !app.camera) return;
  app.pipeline.render({ renderer: app.renderer, scene: app.scene, camera: app.camera, interactive });
  if (app.gizmoRenderer && app.gizmoScene && app.gizmoCamera) {
    const invCamQ = app.camera.quaternion.clone().invert();
    const { a, b, c } = latticeDirsNorm();
    app.gizmoScene.userData.aArrow.setDirection(a.clone().applyQuaternion(invCamQ));
    app.gizmoScene.userData.bArrow.setDirection(b.clone().applyQuaternion(invCamQ));
    app.gizmoScene.userData.cArrow.setDirection(c.clone().applyQuaternion(invCamQ));
    app.gizmoRenderer.render(app.gizmoScene, app.gizmoCamera);
  }
  if (app.labelRenderer) app.labelRenderer.render(app.scene, app.camera);
}

let renderOnDemandWired = false;

function wireRenderOnDemand() {
  if (renderOnDemandWired) return;
  renderOnDemandWired = true;

  // Catch-all: any user interaction that could change the scene arrives
  // through one of these. Capture phase so the flag is set even if a handler
  // stops propagation; the render itself happens on the next rAF tick, after
  // all handlers of the event have run.
  ['pointerup', 'click', 'input', 'change', 'keydown'].forEach((type) =>
    document.addEventListener(type, requestRender, { capture: true, passive: true }));

  // Deliberately NO pointermove listener: mice emit micro-move events almost
  // continuously while the cursor rests on the canvas, which would keep the
  // renderer hot. Plain hover only drives the DOM tooltip (no scene change);
  // camera drags are covered by the controls 'change' event. A future
  // hover-reactive *scene* effect must call requestRender() itself.

  window.addEventListener('resize', requestRender);
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', requestRender);
  }
}

export function pauseRendering() {
  if (!general.powerMode) {
    let now = getCurrentTime()
    //alert("Power saving mode is active. Click OK to resume rendering.");
    isRendering = false;
    console.warn(`Pause rendering ${now}`)
  }
  else{
    return;
  }
}

export function resumeRendering() {
  if (!isRendering) {
    let now = getCurrentTime()
    isRendering = true;
    needsRender = true;
    console.warn(`Resume rendering ${now}`)
    animation_update(); // restart loop
  }
}

function getCurrentTime() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');

  return `${hours}:${minutes}:${seconds}`;
}

let targetFPS = 80;           // desired max FPS
let lastFrameTime = 0;
let lastTime = performance.now();
let frames = 0;
let fps = 0;
let keyState={};
let isKeyComboActive = false;
// Disco mode requires holding the combo for DISCO_HOLD_MS before it engages —
// a bare press-and-release must not trigger it. comboHeldSince is the
// timestamp the combo most recently became active (null while inactive);
// discoEngaged tracks whether the hold threshold has actually been reached
// (and thus whether stopDisco() is owed on release).
const DISCO_HOLD_MS = 1000;
let comboHeldSince = null;
let discoEngaged = false;


let _counter = 1;


window.addEventListener('keydown', (event) => {
  keyState[event.code] = true;
  //console.log('Key pressed:', event.code, keyState);
});

window.addEventListener('keyup', (event) => {
  keyState[event.code] = false;
  //console.log('Key released:', event.code, keyState);
});

// A held combo's keyup can be missed if the window loses focus mid-hold (e.g.
// alt-tab) — clear all key state so a stuck combo (disco mode) exits on the
// next frame instead of leaving colors scrambled indefinitely.
window.addEventListener('blur', () => { keyState = {}; });

/** Zero the TrackballControls damping momentum once it is sub-perceptual.
 *  The residuals live in the (private) gap vectors `_moveCurr - _movePrev`,
 *  `_zoomEnd - _zoomStart`, `_panEnd - _panStart` and the decaying
 *  `_lastAngle`; each shrinks by dynamicDampingFactor per frame and only
 *  approaches zero asymptotically. Thresholds are chosen at the sub-pixel
 *  level (screen-normalized units / radians). No-op for staticMoving. */
function settleControlsMomentum(controls) {
  if (!controls || controls.staticMoving || !controls._moveCurr) return;
  const GAP2 = 1e-8; // squared length of a ~1e-4 screen-units residual
  const ANGLE = 1e-4; // radians — sub-pixel rotation at typical view sizes
  if (controls._moveCurr.distanceToSquared(controls._movePrev) < GAP2
      && Math.abs(controls._lastAngle ?? 0) < ANGLE
      && controls._zoomEnd.distanceToSquared(controls._zoomStart) < GAP2
      && controls._panEnd.distanceToSquared(controls._panStart) < GAP2) {
    controls._movePrev.copy(controls._moveCurr);
    controls._zoomStart.copy(controls._zoomEnd);
    controls._panStart.copy(controls._panEnd);
    controls._lastAngle = 0;
  }
}

export function animation_update(time = 0) {
  if (_counter == 1){
     app.clock = new THREE.Clock();
     wireRenderOnDemand();
  }
  if (!isRendering) return;
  requestAnimationFrame(animation_update);
  const interval = 1000 / targetFPS;
  if (time - lastFrameTime < interval) return;
  lastFrameTime = time;

  // Always update controls: damping needs to keep progressing, and update()
  // fires the 'change' event (-> requestRender) whenever the camera actually
  // moved — including programmatic moves and the damping coast-down.
  app.controls.update();
  // Snap out the damping tail: TrackballControls' momentum decays
  // exponentially and never reaches zero on its own, so 'change' events (and
  // thus render-on-demand frames + tracer accumulation resets) trail on for
  // seconds at sub-pixel amplitude. Once every residual is below perception,
  // zero it EXACTLY so the camera is strictly static from then on.
  settleControlsMomentum(app.controls);

  // Offscreen capture in progress (PNG export): skip the pipeline/gizmo/label
  // passes for this tick so the export is the SOLE render driver. Otherwise an
  // interactive animate frame would take the tiled path, leave a round in
  // flight, and the export's next paced render would abandon it with
  // resetAccumulation() — the "Rendering… 4/8/4…" oscillation + permanent
  // stall. controls.update() above (damping) and the RAF chain stay live, and
  // needsRender is left untouched so the view resumes on the first free tick
  // (the export's finally also calls requestRender()).
  if (app.offscreenRenderHold) return;
  //if (_counter%60 === 0 || _counter=== 1) {
  //  console.log('[animate] rendered camera UUID:', camera.uuid, 'controls.object UUID:', controls.object?.uuid);
  //}

  // Continuous animations hold the render flag high while active.
  isKeyComboActive = keyState['ControlLeft'] && keyState['KeyD'];
  if (isKeyComboActive && comboHeldSince == null) {
    comboHeldSince = time; // rising edge — start timing the hold
  } else if (!isKeyComboActive) {
    if (discoEngaged) stopDisco();
    discoEngaged = false;
    comboHeldSince = null;
  } else if (!discoEngaged && time - comboHeldSince >= DISCO_HOLD_MS) {
    // Combo has been held continuously past the threshold — engage now,
    // rather than on a quick press-and-release.
    discoEngaged = true;
    startDisco();
  }
  const autoRotating = app.angularVelocity != null &&
    general.autoRandomEnabled && app.angularVelocity.lengthSq() > 0;
  if (autoRotating || isKeyComboActive) needsRender = true;

  if (!needsRender) {
    // Idle: skip all render work; restart the FPS window so the counter only
    // measures continuously rendered stretches.
    frames = 0;
    lastTime = time;
    return;
  }
  needsRender = false;

  frames++;
  const delta = time - lastTime;
  if (delta >= 1000) { // every 1 second
    fps = (frames / delta) * 1000;
    console.debug('FPS:', Math.round(fps));
    frames = 0;
    lastTime = time;
  }

  _counter = _counter+1;

  const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
   if (isDarkMode && general.currentLatticeColor === 0x090A09){
    app.scene.background = new THREE.Color(0x090A09)
    general.defaultBackgroundColor = 0x090A09
    general.currentLatticeColor = 0xE7E7E7
    updateLattice()
   }
   else if (!isDarkMode && general.currentLatticeColor === 0xE7E7E7)
   {
    app.scene.background = new THREE.Color(0xE7E7E7);
    general.defaultBackgroundColor = 0xE7E7E7
    general.currentLatticeColor = 0x090A09
    updateLattice()
   }
  
  // Update camera-relative lighting position
  const cameraPosition = app.camera.position.clone();

  // Single key light from upper front-right relative to camera
  app.keyLight.position.copy(cameraPosition).add(
    new THREE.Vector3(3, 4, 3).applyQuaternion(app.camera.quaternion)
  );

  // Keep the ground disc's visibility in sync with a possibly-direct
  // general.rtGroundPlane write (O(1); onBeforeRender can't un-hide a hidden mesh).
  syncGroundPlaneVisibility();

  renderFrameNow({ interactive: true });
  if (autoRotating) {
      const delta = app.clock.getDelta(); // seconds since last frame
      const axis = app.angularVelocity.clone().normalize();
      const angle = app.angularVelocity.length() * delta;

      const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);

      // Rotate camera position around the target
      app.camera.position.sub(app.controls.target);
      app.camera.position.applyQuaternion(q);
      app.camera.position.add(app.controls.target);

      // Rotate camera orientation
      app.camera.quaternion.premultiply(q);

      // Optionally add decay
      //app.angularVelocity.multiplyScalar(0.98); // damping if desired
    }

  //console.log(keyState)
  if (discoEngaged) {
    // Update colors every 20th timestep
    if (_counter >= 20) {
      if (_counter%10 == 0){
        updateRandomColors();
      }
    }
  }


  }
