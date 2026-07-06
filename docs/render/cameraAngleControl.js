import * as THREE from '../external/three/three.module.js';
import { getCellCenterAndDist } from './LatticeModule.js'
import { latticeDirs } from './LatticeModule.js'
import { app } from '../state/store.js';

// Degrees rotated per arrow-button click (a small, repeatable step).
const STEP_DEG = 5;

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
  const { center, dist } = getCellCenterAndDist();
  if (!app.camera) {
    console.warn("Why no camera??");
    return;
  }

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
  v.applyQuaternion(q);

  // 4) keep the same radius if you have a canonical dist
  const radius = dist ?? v.length();
  if (radius > 0) v.setLength(radius);

  // 5) commit: position camera on rotated vector, rotate up in lockstep,
  //    look at center
  app.camera.position.copy(center).add(v);
  app.camera.up.applyQuaternion(q).normalize();
  app.controls.target.copy(center);

  // 6) update controls/camera
  app.controls.update();
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
