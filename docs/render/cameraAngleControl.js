import * as THREE from '../external/three/three.module.js';
import { latticeDirs } from './LatticeModule.js'
import { app } from '../state/store.js';

// Degrees rotated per arrow-button click (a small, repeatable step).
const STEP_DEG = 5;
const cameraPanRight = new THREE.Vector3();
const cameraPanUp = new THREE.Vector3();
let stepButtonsMode = 'longpress';

export function setAxisStepButtonsMode(mode) {
  stepButtonsMode = mode === 'on' || mode === 'off' ? mode : 'longpress';
  document.querySelectorAll('#cameraTools .camera-axis-stack').forEach((stack) => {
    stack.classList.toggle('camera-axis-revealed', stepButtonsMode === 'on');
  });
  // In On mode the arrows are permanent, so the CSS lays them out in flow
  // (the toolbar grows to hold them); in Long press / Off they are transient
  // popovers overlaid above/below the letter, so the row stays one button
  // tall and matches the Measure toolbar.
  document.getElementById('cameraTools')?.classList.toggle('camera-axis-steps-on', stepButtonsMode === 'on');
}

/**
 * Rigidly rotate the camera a small step around an axis through the cell
 * center. Both the center→camera offset and camera.up get the same rotation:
 * only then is the move a rigid rotation, which keeps the chosen axis fixed
 * on screen (its view-space direction R′ᵀn = RᵀQᵀn = Rᵀn since Q fixes its
 * own axis) while everything else precesses around it. Rotating the position
 * alone lets the subsequent lookAt re-roll the camera to the stale up vector,
 * so the axis drifts.
 * @param {number} directionDeg signed step in degrees
 * @param {'x'|'y'|'z'|THREE.Vector3} axis world axis by name, or an explicit
 *   direction vector (used for the a/b/c crystallographic axes).
 */
export function applyRotationFromUI(directionDeg, axis) {
  if (!app.camera) {
    console.warn("Why no camera??");
    return;
  }

  // Orbit around whatever the controls are already looking at, not the cell
  // center at its fit distance: snapping to getCellCenterAndDist() here threw
  // away the user's zoom and pan on every arrow press, same as the alignment
  // buttons used to.
  const center = app.controls.target.clone();
  const panX = app.cameraPan.x;
  const panY = app.cameraPan.y;
  app.camera.updateMatrixWorld(true);
  cameraPanRight.setFromMatrixColumn(app.camera.matrixWorld, 0);
  cameraPanUp.setFromMatrixColumn(app.camera.matrixWorld, 1);
  app.camera.position.addScaledVector(cameraPanRight, -panX);
  app.camera.position.addScaledVector(cameraPanUp, -panY);

  // 1) pick the rotation axis: world x/y/z by name, or an explicit direction.
  const rotAxis =
    axis === 'x' ? new THREE.Vector3(1, 0, 0) :
    axis === 'y' ? new THREE.Vector3(0, 1, 0) :
    axis === 'z' ? new THREE.Vector3(0, 0, 1) :
    (axis && axis.isVector3 && axis.lengthSq() > 0)
      ? axis.clone().normalize()
      : new THREE.Vector3(0, 0, 1);

  // 2) build rotation (degrees → radians)
  const q = new THREE.Quaternion().setFromAxisAngle(
    rotAxis,
    THREE.MathUtils.degToRad(directionDeg)
  );

  // 3) rotate the vector from center to the CAMERA (not the target)
  //    (This orbits the camera around the center while looking at the center.)
  const v = app.camera.position.clone().sub(center); // do NOT mutate center
  v.applyQuaternion(q); // a rotation is length-preserving, so the radius stays

  // 4) commit: position camera on rotated vector, rotate up in lockstep,
  //    look at center
  app.camera.position.copy(center).add(v);
  app.camera.up.applyQuaternion(q).normalize();
  app.controls.target.copy(center);

  // 5) update controls/camera
  app.controls.update();
  app.camera.updateMatrixWorld(true);
  cameraPanRight.setFromMatrixColumn(app.camera.matrixWorld, 0);
  cameraPanUp.setFromMatrixColumn(app.camera.matrixWorld, 1);
  app.camera.position.addScaledVector(cameraPanRight, panX);
  app.camera.position.addScaledVector(cameraPanUp, panY);
  app.camera.updateMatrixWorld(true);
}


// Wire the up/down arrow pair flanking each axis button. World axes x/y/z
// rotate about the fixed world axes; lattice axes a/b/c rotate about the
// current crystallographic directions (fetched fresh per click, since they
// depend on the loaded structure).
export function setupAxisControls(axis) {
  const upBtn   = document.getElementById(`${axis}Up`);
  const downBtn = document.getElementById(`${axis}Down`);
  const isLattice = axis === 'a' || axis === 'b' || axis === 'c';
  // latticeDirs() returns plain [x,y,z] arrays; applyRotationFromUI wants a
  // THREE.Vector3 (an array would silently fail its axis check and fall back
  // to world z).
  const rotAxis = () => {
    if (!isLattice) return axis;
    const d = latticeDirs()?.[axis];
    return Array.isArray(d) ? new THREE.Vector3(d[0], d[1], d[2]) : axis;
  };

  // The buttons persist across camera switches, so guard against re-wiring
  // (this is called from both setupScene and switchCameraType).
  if (upBtn && !upBtn.dataset.axisWired) {
    upBtn.dataset.axisWired = '1';
    upBtn.addEventListener('click', () => applyRotationFromUI(+STEP_DEG, rotAxis()));
  }
  if (downBtn && !downBtn.dataset.axisWired) {
    downBtn.dataset.axisWired = '1';
    downBtn.addEventListener('click', () => applyRotationFromUI(-STEP_DEG, rotAxis()));
  }
}

// How long the main axis button (viewX/viewY/.../viewC) has to be held
// before the step-rotate arrows reveal themselves, and how long they stay
// revealed afterward with no further interaction — both tuned to feel
// deliberate rather than twitchy: long enough that a normal click to view
// along the axis never brushes it, short enough that holding on purpose
// doesn't feel like a delay.
const LONG_PRESS_MS = 450;
const REVEAL_HOLD_MS = 2500;

/**
 * Reveals the ▲/▼ step-rotate arrows flanking an axis button according to the
 * View window's "Stepwise buttons" menu option: Long press is the default,
 * On keeps them always visible, and Off disables them. In Long press mode,
 * the button's own "view along axis" click is suppressed when the press that
 * triggered the reveal releases, so long-pressing never also snaps the camera
 * to that axis.
 */
export function setupAxisLongPress(axis) {
  const stack = document.getElementById(`${axis}Up`)?.closest('.camera-axis-stack');
  const mainBtn = document.getElementById(`view${axis.toUpperCase()}`);
  if (!stack || !mainBtn || stack.dataset.longPressWired) return;
  stack.dataset.longPressWired = '1';

  let pressTimer = null;
  let longPressed = false;
  let hideTimer = null;

  function reveal() {
    if (stepButtonsMode !== 'longpress') return;
    stack.classList.add('camera-axis-revealed');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, REVEAL_HOLD_MS);
  }
  function hide() {
    if (stepButtonsMode !== 'longpress') return;
    stack.classList.remove('camera-axis-revealed');
    clearTimeout(hideTimer);
  }
  function cancelPendingReveal() {
    clearTimeout(pressTimer);
    pressTimer = null;
  }

  mainBtn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressed = false;
    cancelPendingReveal();
    if (stepButtonsMode !== 'longpress') return;
    pressTimer = setTimeout(() => {
      if (stepButtonsMode !== 'longpress') return;
      longPressed = true;
      reveal();
    }, LONG_PRESS_MS);
  });
  mainBtn.addEventListener('pointerup', cancelPendingReveal);
  mainBtn.addEventListener('pointerleave', cancelPendingReveal);
  mainBtn.addEventListener('pointercancel', cancelPendingReveal);
  // A long-press easily triggers the browser/OS's own context menu
  // (especially on touch) — that would fire mid-gesture and steal the
  // pointerup this relies on to know the press ended.
  mainBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  // Capture phase (not bubble): mainBtn's own "view along axis" handler
  // (WindowAndSceneControls.js's setupCameraButtons, a plain .onclick
  // assignment) fires during the target phase, which runs after any
  // capture-phase listener on an ancestor — this always gets first look at
  // the click regardless of which of the two was wired up first.
  stack.addEventListener('click', (e) => {
    if (!longPressed) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    longPressed = false;
  }, true);

  // Clicking a revealed arrow refreshes the hold timer instead of letting it
  // expire mid-click, so a couple of quick nudges don't need a fresh
  // long-press each time.
  stack.querySelectorAll('.axis-step').forEach((btn) => {
    btn.addEventListener('click', () => reveal());
  });

  // Pressing down anywhere outside this stack closes it immediately, same as
  // any other popover.
  document.addEventListener('pointerdown', (e) => {
    if (stack.classList.contains('camera-axis-revealed') && !stack.contains(/** @type {Node} */ (e.target))) {
      hide();
    }
  });
}
