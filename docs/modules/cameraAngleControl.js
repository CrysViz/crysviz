import * as THREE from '../backend/three/three.module.js';
import {getCellCenterAndDist} from './LatticeModule.js'
import { app } from '../store.js';

let currentX = 0;
let currentY = 0;
let currentZ = 0;


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


  document.getElementById('xAngle').value = xAngleDeg.toFixed(1);
  document.getElementById('yAngle').value = yAngleDeg.toFixed(1);
  document.getElementById('zAngle').value = zAngleDeg.toFixed(1);

  let currentX = xAngleDeg;
  let currentY = yAngleDeg;
  let currentZ = zAngleDeg;

}

  // Build a 3×3 rotation matrix for intrinsic XYZ (Rx * Ry * Rz)
  function rotationMatrixXYZ(rotXdeg, rotYdeg, rotZdeg) {

    // Degrees → radians
    const deg2rad = d => (d * Math.PI) / 180;

    const cx = Math.cos(deg2rad(rotXdeg)), sx = Math.sin(deg2rad(rotXdeg));
    const cy = Math.cos(deg2rad(rotYdeg)), sy = Math.sin(deg2rad(rotYdeg));
    const cz = Math.cos(deg2rad(rotZdeg)), sz = Math.sin(deg2rad(rotZdeg));

    // First M = Ry * Rx
    const m00 = cy*1 + 0*0 + sy*0;          // cy
    const m01 = cy*0 + 0*cx + sy*sx;        // sy*sx
    const m02 = cy*0 + 0*(-sx) + sy*cx;     // sy*cx

    const m10 = 0*1 + 1*0 + 0*0;            // 0
    const m11 = 0*0 + 1*cx + 0*sx;          // cx
    const m12 = 0*0 + 1*(-sx) + 0*cx;       // -sx
    const m20 = -sy*1 + 0*0 + cy*0;         // -sy
    const m21 = -sy*0 + 0*cx + cy*sx;       // cy*sx
    const m22 = -sy*0 + 0*(-sx) + cy*cx;    // cy*cx

    // Then R = Rz * M
    return [
      cz*m00 - sz*m10,    cz*m01 - sz*m11,    cz*m02 - sz*m12,
      sz*m00 + cz*m10,    sz*m01 + cz*m11,    sz*m02 + cz*m12,
             m20,                m21,                m22
    ];
  }
  function mulMat3Vec3(m, v) {
  const [x, y, z] = v;
  return [
    m[0]*x + m[1]*y + m[2]*z,
    m[3]*x + m[4]*y + m[5]*z,
    m[6]*x + m[7]*y + m[8]*z
  ];
}


function multiplyArray(arr, scalar) {
  return arr.map(value => value * scalar);
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
  const input   = document.getElementById(`${axis}Angle`);

  if (upBtn)   upBtn.addEventListener('click', () => applyRotationFromUI(+1,axis, controls));
  if (downBtn) downBtn.addEventListener('click', () => applyRotationFromUI(-1,axis,controls));
}
