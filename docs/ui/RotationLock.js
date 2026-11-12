// RotationLock.js
//
// Constrain mouse rotation of the 3D view to one axis: world x/y/z, lattice
// a/b/c, or a screen axis. Driven by the "Camera · mouse over structure"
// keyboard shortcuts (ui/KeyboardShortcuts.js): X/Y/Z/A/B/C lock, Space+X/Y/Z
// lock to the screen axes, R frees.
//
// A screen axis is taken from the camera at the moment it is locked — x to the
// right, y up, z out of the screen — and then stays that fixed direction in
// the scene. A rotation about an axis keeps that axis where it is on screen,
// so dragging keeps it pointing right / up / out until the view is changed
// some other way (an alignment button, a step arrow).
//
// While locked, TrackballControls' own rotation is switched off (noRotate) and
// a left-drag over the canvas becomes a rigid rotation about the locked axis
// (render/cameraAngleControl.js applyRotationFromUI, the same move the View
// window's step arrows make). Zoom, pan, clicks and box selection are left to
// their usual handlers. The rotation angle is the trackball's own rotation for
// that drag projected onto the axis, plus a "roll" part weighted by how much
// the axis faces the viewer — the only part left when the axis points out of
// the screen (Space+Z, or Z while viewing along z). The roll part depends on
// where the drag starts: well away from the rotation centre the drag works
// as a dial (the pointer's turn round the centre, so circling turns it 1:1);
// anywhere nearer it follows the horizontal drag at the trackball's speed,
// dragging right turning clockwise (the top of a dial pushed right). A dial
// alone made the common drag — grab the middle, pull outwards — radial, so it
// barely turned at all.
//
// The lock is a transient mode: it is not saved, and the badge in the view
// says it is on.

import * as THREE from '../external/three/three.module.js';
import { app, general } from '../state/store.js';
import { applyRotationFromUI, latticeDirs } from '../render/index.js';
import { stopCameraMomentum } from './WindowAndSceneControls.js';

/** @typedef {'x'|'y'|'z'|'a'|'b'|'c'|'screen-x'|'screen-y'|'screen-z'} LockAxis */

const AXES = /** @type {const} */ (['x', 'y', 'z', 'a', 'b', 'c', 'screen-x', 'screen-y', 'screen-z']);
// camera.matrixWorld column of each screen axis: right, up, out of the screen.
const SCREEN_COLUMN = { 'screen-x': 0, 'screen-y': 1, 'screen-z': 2 };
// A drag across the full height of the view turns 180°, scaled by the
// user's camera speed setting like the trackball.
const RADIANS_PER_VIEW_HEIGHT = Math.PI;

/** @type {LockAxis | null} */
let lockedAxis = null;
/** World direction of a screen axis, captured when it was locked. */
let screenAxis = null;
let pointerOverScene = false;
/** @type {{ id: number, x: number, y: number, dial: boolean } | null} */
let drag = null;
// A drag that starts at least this fraction of the view height away from the
// rotation centre rolls as a dial; nearer, the roll follows horizontal drag.
const DIAL_MIN_RADIUS = 1 / 8;
/** @type {HTMLElement | null} */
let badge = null;

const sceneCanvas = () => app.renderer?.domElement ?? null;

/** World direction of an axis right now (lattice axes follow the structure). */
function axisVector(axis) {
  if (axis in SCREEN_COLUMN) return screenAxis ? screenAxis.clone() : null;
  if (axis === 'x') return new THREE.Vector3(1, 0, 0);
  if (axis === 'y') return new THREE.Vector3(0, 1, 0);
  if (axis === 'z') return new THREE.Vector3(0, 0, 1);
  const d = latticeDirs()?.[axis];
  if (!Array.isArray(d)) return null;
  const v = new THREE.Vector3(d[0], d[1], d[2]);
  return v.lengthSq() > 0 ? v.normalize() : null;
}

/** Whether the mouse is over the 3D view itself (not a panel floating on it). */
export function isPointerOverScene() {
  return pointerOverScene;
}

/** @returns {LockAxis | null} */
export function getRotationLock() {
  return lockedAxis;
}

/**
 * Lock rotation to an axis, or free it (null).
 * @param {LockAxis | null} axis
 */
export function setRotationLock(axis) {
  const next = AXES.includes(/** @type {any} */ (axis)) ? axis : null;
  // Momentum from a drag just before the switch would otherwise carry on (or,
  // on unlock, resume) under the new mode.
  stopCameraMomentum();
  screenAxis = null;
  if (next in SCREEN_COLUMN) {
    if (!app.camera) return;
    app.camera.updateMatrixWorld(true);
    screenAxis = new THREE.Vector3().setFromMatrixColumn(app.camera.matrixWorld, SCREEN_COLUMN[next]).normalize();
  }
  lockedAxis = next;
  if (app.controls) app.controls.noRotate = lockedAxis !== null;
  drag = null;
  updateBadge();
}

function updateBadge() {
  const host = document.getElementById('view');
  if (!host) return;
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'cv-rotation-lock-badge';
    badge.setAttribute('role', 'status');
    host.appendChild(badge);
  }
  badge.hidden = lockedAxis === null;
  if (lockedAxis) {
    const name = lockedAxis in SCREEN_COLUMN ? `screen ${lockedAxis.slice(-1)}` : lockedAxis;
    badge.textContent = `Rotation locked to ${name} · R to free`;
  }
}

/** Signed rotation angle (radians, object frame) for a pointer move. */
/** The rotation centre (controls target) in client pixels, or null. */
function centreOnScreen(rect) {
  if (!app.camera || !app.controls) return null;
  const centre = app.controls.target.clone().project(app.camera);
  return {
    x: rect.left + (centre.x + 1) / 2 * rect.width,
    y: rect.top + (1 - centre.y) / 2 * rect.height,
  };
}

function dragAngle(axis, from, to, dial) {
  const camera = app.camera;
  const canvas = sceneCanvas();
  if (!camera || !canvas || !app.controls) return 0;
  const rect = canvas.getBoundingClientRect();
  if (!(rect.height > 0)) return 0;

  camera.updateMatrixWorld(true);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const toViewer = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2).normalize();

  // Trackball part: a drag d (screen right/up) turns the object about
  // toViewer × d by |d|·k. Its component along the lock axis is kept.
  const speed = Number.isFinite(general.cameraSpeedFactor) && general.cameraSpeedFactor > 0
    ? general.cameraSpeedFactor : 1;
  const k = (RADIANS_PER_VIEW_HEIGHT / rect.height) * speed;
  const dx = to.x - from.x;
  const dyUp = -(to.y - from.y);
  const dragWorld = right.clone().multiplyScalar(dx).addScaledVector(up, dyUp);
  const trackball = new THREE.Vector3().crossVectors(toViewer, dragWorld).dot(axis) * k;

  // Roll part (see the file header): counter-clockwise on screen is a
  // positive turn about the axis towards the viewer.
  const facing = toViewer.dot(axis);
  let roll = -dx * k; // horizontal drag: right = clockwise
  if (dial) {
    const c = centreOnScreen(rect);
    const a0 = c ? Math.atan2(-(from.y - c.y), from.x - c.x) : 0;
    const a1 = c ? Math.atan2(-(to.y - c.y), to.x - c.x) : 0;
    roll = a1 - a0;
    if (roll > Math.PI) roll -= 2 * Math.PI;
    if (roll < -Math.PI) roll += 2 * Math.PI;
  }

  return trackball + roll * facing;
}

function onPointerDown(event) {
  const canvas = sceneCanvas();
  if (!lockedAxis || !canvas || event.target !== canvas) return;
  // Re-assert on every press: switching camera type rebuilds the controls.
  if (app.controls) app.controls.noRotate = true;
  if (event.button !== 0 || event.pointerType === 'touch') return;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  if (app.controls && app.controls.enabled === false) return;
  const rect = canvas.getBoundingClientRect();
  const c = centreOnScreen(rect);
  const dial = !!c && Math.hypot(event.clientX - c.x, event.clientY - c.y) >= DIAL_MIN_RADIUS * rect.height;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dial };
}

function onPointerMove(event) {
  const canvas = sceneCanvas();
  pointerOverScene = !!canvas && event.target === canvas;
  if (!drag || event.pointerId !== drag.id || !lockedAxis) return;
  if (app.controls && app.controls.enabled === false) { drag = null; return; }
  const axis = axisVector(lockedAxis);
  const from = { x: drag.x, y: drag.y };
  const to = { x: event.clientX, y: event.clientY };
  drag.x = to.x;
  drag.y = to.y;
  if (!axis) return;
  const angle = dragAngle(axis, from, to, drag.dial);
  if (!angle) return;
  // The camera turns the other way round the axis for the object to turn by
  // `angle`.
  applyRotationFromUI(-THREE.MathUtils.radToDeg(angle), axis);
}

function onPointerEnd(event) {
  if (drag && event.pointerId === drag.id) drag = null;
}

let initialized = false;

export function initRotationLock() {
  if (initialized) return;
  initialized = true;
  // Capture phase on the window: runs before TrackballControls' own
  // pointerdown on the canvas, so noRotate is in place for this very press.
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerover', (event) => {
    const canvas = sceneCanvas();
    pointerOverScene = !!canvas && event.target === canvas;
  }, true);
  window.addEventListener('pointerup', onPointerEnd, true);
  window.addEventListener('pointercancel', onPointerEnd, true);
  document.documentElement.addEventListener('pointerleave', () => { pointerOverScene = false; });
  window.addEventListener('blur', () => { pointerOverScene = false; drag = null; });
}
