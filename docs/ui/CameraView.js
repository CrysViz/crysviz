// A relative camera `view`, shared by the two ways CrysViz links cameras: a
// widget host page linking embedded widgets (ui/WidgetControl.js) and tabs of
// the same browser following each other (ui/CameraSync.js).
//
// A `view` is relative, so it carries over between two different structures:
//   direction [x,y,z]  unit vector from the rotation centre (the structure's centre) to the camera
//   up        [x,y,z]  the camera's up, perpendicular to direction
//   distance           camera distance along direction over the distance that fits the shown structure
//   zoom               the camera's zoom (orthographic: on top of the frustum fitted to the shown structure)

import * as THREE from '../external/three/three.module.js';
import { app } from '../state/store.js';
import { stopCameraMomentum } from './WindowAndSceneControls.js';
import { requestRender, getCellCenterAndDist } from '../render/index.js';

const panRight = new THREE.Vector3();
const panUp = new THREE.Vector3();

/** The current view. Read from the camera's orientation, so the user's pan (a sideways
 *  shift of the camera, perpendicular to its axis) changes nothing. */
export function cameraView() {
  const camera = app.camera;
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const axial = camera.position.clone().sub(app.controls.target).dot(back);
  return {
    direction: back.toArray(),
    up: up.toArray(),
    distance: axial / getCellCenterAndDist().dist,
    zoom: camera.zoom,
  };
}

/** Move the camera sideways by (x, y) in its own right/up axes (the user's pan). */
function shiftCamera(x, y) {
  if (x === 0 && y === 0) return;
  const camera = app.camera;
  camera.updateMatrixWorld(true);
  panRight.setFromMatrixColumn(camera.matrixWorld, 0);
  panUp.setFromMatrixColumn(camera.matrixWorld, 1);
  camera.position.addScaledVector(panRight, x).addScaledVector(panUp, y);
  camera.updateMatrixWorld(true);
}

function vector3(value) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return null;
  return new THREE.Vector3(value[0], value[1], value[2]);
}

/**
 * Turn and zoom the camera to `view`, around this window's own rotation centre; keeps the pan.
 * `absolute` ({ target: [x,y,z], pan: {x, y} }, both optional) also moves the rotation centre
 * and sets the pan, for a view copied whole between two windows showing the same structure.
 */
export function applyView(view, absolute = null) {
  const camera = app.camera;
  const controls = app.controls;
  if (!camera || !controls || !view || typeof view !== 'object') return;
  const direction = vector3(view.direction);
  const up = vector3(view.up);
  if (!direction || !up || direction.lengthSq() === 0) return;
  direction.normalize();
  up.addScaledVector(direction, -up.dot(direction));  // perpendicular to the direction
  if (up.lengthSq() < 1e-12) return;
  up.normalize();

  // Take the pan off, re-aim, then put the pan back in the new camera axes (as applyCameraSnapshot does).
  shiftCamera(-app.cameraPan.x, -app.cameraPan.y);
  const target = vector3(absolute?.target);
  if (target) {
    camera.position.add(target.clone().sub(controls.target));
    controls.target.copy(target);
  }
  const pan = absolute?.pan;
  if (pan && Number.isFinite(pan.x) && Number.isFinite(pan.y)) {
    app.cameraPan.x = pan.x;
    app.cameraPan.y = pan.y;
  }
  let distance = camera.position.distanceTo(controls.target);
  if (Number.isFinite(view.distance) && view.distance > 0) {
    distance = view.distance * getCellCenterAndDist().dist;
  }
  camera.position.copy(controls.target).addScaledVector(direction, distance);
  camera.up.copy(up);
  if (camera.isOrthographicCamera && Number.isFinite(view.zoom) && view.zoom > 0) {
    camera.zoom = THREE.MathUtils.clamp(view.zoom, controls.minZoom, controls.maxZoom);
    camera.updateProjectionMatrix();
  }
  // Drop any rotation/zoom momentum, so the view sticks.
  stopCameraMomentum();
  controls.update();  // lookAt the target
  shiftCamera(app.cameraPan.x, app.cameraPan.y);
  requestRender();
}
