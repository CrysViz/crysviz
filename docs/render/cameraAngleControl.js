import * as THREE from '../external/three/three.module.js';
import {getCellCenterAndDist} from './LatticeModule.js'
import { app } from '../state/store.js';


// Helper to update the displayed angles
export function updateAngleDisplays() {

  const invCamQ = app.camera.quaternion.clone().invert();

  const euler = new THREE.Euler().setFromQuaternion(invCamQ, 'XYZ');

  let xAngleDeg = THREE.MathUtils.radToDeg(euler.x);
  let yAngleDeg = THREE.MathUtils.radToDeg(euler.y);
  let zAngleDeg = THREE.MathUtils.radToDeg(euler.z);
  
  if ( xAngleDeg=== 0 || xAngleDeg=== -0 ) { xAngleDeg=0 }
  if ( xAngleDeg=== 180 || xAngleDeg=== -180 ) { xAngleDeg=180 }
  if ( yAngleDeg=== 0 || yAngleDeg=== -0 ) { yAngleDeg=0 }
  if ( yAngleDeg=== 180 || yAngleDeg=== -180 ) { yAngleDeg=180 }
  if ( zAngleDeg=== 0 || zAngleDeg=== -0 ) { zAngleDeg=0 }
  if ( zAngleDeg=== 180 || zAngleDeg=== -180 ) { zAngleDeg=180 }


  /** @type {HTMLInputElement} */ (document.getElementById('xAngle')).value = xAngleDeg.toFixed(1);
  /** @type {HTMLInputElement} */ (document.getElementById('yAngle')).value = yAngleDeg.toFixed(1);
  /** @type {HTMLInputElement} */ (document.getElementById('zAngle')).value = zAngleDeg.toFixed(1);

}

export function applyRotationFromUI(directionDeg, axis) {
  const { center, dist } = getCellCenterAndDist();
  if (!app.camera) {
    console.warn("Why no camera??");
    return;
  }

  // 1) pick world axis
  const rotAxis =
    axis === 'x' ? new THREE.Vector3(1, 0, 0) :
    axis === 'y' ? new THREE.Vector3(0, 1, 0) :
                   new THREE.Vector3(0, 0, 1);

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
  //    (if you trust dist more than current |v|, re-normalize to dist)
  const radius = dist ?? v.length();
  if (radius > 0) v.setLength(radius);

  // 5) commit: position camera on rotated vector, look at center
  app.camera.position.copy(center).add(v);
  app.controls.target.copy(center);

  // 6) update controls/camera
  app.controls.update();
  app.camera.updateMatrixWorld(true);
}



// Example: setupAxisControls wiring
export function setupAxisControls(axis, controls, addOpts = {}) {
  const upBtn   = document.getElementById(`${axis}Up`);
  const downBtn = document.getElementById(`${axis}Down`);

  if (upBtn)   upBtn.addEventListener('click', () => applyRotationFromUI(+1,axis));
  if (downBtn) downBtn.addEventListener('click', () => applyRotationFromUI(-1,axis));
}
