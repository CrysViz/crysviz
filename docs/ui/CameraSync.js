// Camera sync between CrysViz tabs and windows of one browser (Camera panel ▸
// "Sync camera across tabs"). Each tab that has sync on follows the others:
// turning or zooming one turns and zooms the rest.
//
// Modes (a choice per tab):
//   'view'   the same view: the same angle and zoom as the other tabs,
//            measured against each tab's own structure (ui/CameraView.js), so
//            different structures turn together. With "Also match pan and
//            rotation centre" (for the same structure in several tabs) also
//            those.
//   'turns'  the same turns: this tab keeps its own angle and zoom, and turns
//            and zooms by as much as the others. It stores an offset from the
//            shared view (a rotation and a zoom factor), taken when it joins
//            and kept until "Line up all tabs with this one" drops it.
//
// The offset: every tab sends the shared view, its own camera with its offset
// taken off, and follows the shared view with its offset put back on. A
// 'view' tab has no offset. The rotation offset L sits on the world side
// (own = L · shared), so a drag that turns one tab's picture to the left turns
// every tab's picture to the left, whatever its own angle.
//
// Transport and security
//   * BroadcastChannel: the browser delivers messages only to pages of the
//     same origin in the same browser profile. Nothing goes over the network
//     or to disk, and no other site can read or post on the channel.
//   * Off by default and per tab, never remembered across a reload: a tab
//     sends or follows only while its user has switched it on.
//   * Messages carry camera numbers only, no structure data. Every message
//     is checked (version, shape, finite numbers in range) before use;
//     anything else is dropped.
//
// Protocol (channel 'crysviz-camera-sync')
//   { v:1, type:'hello', from }                      a tab switched sync on: synced tabs answer with a pose
//   { v:1, type:'bye', from }                        a tab switched sync off or closed
//   { v:1, type:'pose', from, to?, align?, view, target, pan, projection, touchedAt }
//                                                    a tab's shared view: a CameraView `view`, plus its
//                                                    rotation centre [x,y,z] and pan {x,y} for 'view'
//                                                    mode, 'parallel' or 'perspective', and when its
//                                                    user last touched it (ms since 1970); `to` (the
//                                                    answer to a hello) is for that tab only; `align`
//                                                    tells 'turns' tabs to drop their offsets
//
// A parallel camera zooms with its zoom factor, a perspective one by moving in.
// Both are measured against the view fitted to the structure, so a pose from
// the other kind of camera is converted: zoom 2 there is half the fitted
// distance here, and the other way round.
//
// A tab spinning by itself (Camera ▸ Random) hands over when another tab
// sends it a pose: it then undoes its own spin each frame and follows,
// until its user touches it again (a press, a wheel turn or a key in that
// tab) and it leads, spin and all. While it leads, it ignores poses from a
// tab touched before it was: those were sent before that tab heard it, and
// the tab touched last wins. Without this, two spinning tabs would each lead
// and the others would jump between them every frame.
//
// Smoothness: one animation-frame loop runs while sync is on. Each frame it
// compares the camera with the pose it last sent or applied. A difference is
// this tab's own move (a drag, its momentum, a View button, a new structure):
// it is sent, at most once per frame, and drops any pose being followed, so
// the tab you touch leads. Otherwise the camera eases toward the latest pose
// from another tab (exponentially, time constant TAU_S), so a jump in the
// leading tab glides here and tabs with different frame rates stay smooth.

import * as THREE from '../external/three/three.module.js';
import { app, general } from '../state/store.js';
import { cameraView, applyView } from './CameraView.js';
import { getPanelPref, setPanelPref, onPanelsReset } from './panels/PanelManager.js';

const CHANNEL = 'crysviz-camera-sync';
const VERSION = 1;
/** Easing time constant toward another tab's pose, in seconds. */
const TAU_S = 0.04;
export const CAMERA_SYNC_MODES = ['view', 'turns'];

const tabId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 64);

/** @type {BroadcastChannel|null} */
let channel = null;
let mode = 'view';
/** 'view' mode copies the rotation centre and the pan too (a panelPref). */
let centre = getPanelPref('cameraSyncCentre') === true;
/** This tab's offset from the shared view: own orientation = rotation · shared, own magnification = zoom × shared. */
const offset = { rotation: new THREE.Quaternion(), zoom: 1 };
/** The latest pose from another tab, eased toward until reached. */
let goal = null;
/** The camera as last sent or applied, as numbers (see rawPose). */
let last = null;
let frame = 0;
let lastTime = 0;
/** A pose came from another tab since this tab's user last touched it. */
let following = false;
/** When this tab's user last touched it (Date.now()), sent with each pose. */
let touchedAt = 0;
const listeners = new Set();
/** Other tabs with sync on, as heard (hello, pose) until they say bye. */
const peers = new Set();
const MAX_PEERS = 64;

export function cameraSyncSupported() {
  return typeof BroadcastChannel === 'function';
}

export function isCameraSyncOn() {
  return channel != null;
}

export function getCameraSyncMode() {
  return mode;
}

/** How many other tabs this tab is synced with (0 while off). */
export function cameraSyncPeerCount() {
  return peers.size;
}

export function getCameraSyncCentre() {
  return centre;
}

/** Call `fn()` whenever sync is switched on or off or its mode or options change. */
export function onCameraSyncChange(fn) {
  listeners.add(fn);
}

function changed() {
  listeners.forEach((fn) => fn());
}

function dropOffset() {
  offset.rotation.identity();
  offset.zoom = 1;
}

/**
 * 'view' (the same view as the other tabs) or 'turns' (this tab's own angle and
 * zoom, turned along). Changing to 'view' while on glides to the others' view;
 * changing to 'turns' keeps the view (it is the shared one, no offset yet).
 */
export function setCameraSyncMode(next) {
  if (!CAMERA_SYNC_MODES.includes(next) || next === mode) return;
  mode = next;
  if (mode === 'view') {
    dropOffset();
    if (channel) post({ type: 'hello' });  // their answers bring the shared view
  }
  changed();
}

/** Whether 'view' mode also copies the rotation centre and the pan (remembered). */
export function setCameraSyncCentre(on) {
  centre = !!on;
  setPanelPref('cameraSyncCentre', centre);
  changed();
}

/** Turn the other synced tabs to this tab's view, and drop every tab's offset. */
export function lineUpCameraSync() {
  if (!channel) return;
  dropOffset();
  onUserInput();
  sendPose(undefined, { align: true });
}

/**
 * Switch sync on or off for this tab. Switching on follows the tabs already
 * in sync ('view'), or takes its offset from them ('turns'); `lead` instead
 * makes them follow this tab's current view, as lineUpCameraSync.
 */
export function setCameraSync(on, { lead = false } = {}) {
  if (on && !cameraSyncSupported()) return;
  if (!on) {
    if (!channel) return;
    post({ type: 'bye' });
    peers.clear();
    channel.close();
    channel = null;
    goal = null;
    USER_INPUT.forEach((type) => document.removeEventListener(type, onUserInput, true));
    cancelAnimationFrame(frame);
    frame = 0;
    changed();
    return;
  }
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = onMessage;
    following = false;
    dropOffset();
    USER_INPUT.forEach((type) => document.addEventListener(type, onUserInput, { capture: true, passive: true }));
    // The camera as it is now is not a move of ours: nothing to send yet.
    last = rawPose();
    lastTime = 0;
    frame = requestAnimationFrame(tick);
    if (!lead) post({ type: 'hello' });
    changed();
  }
  if (lead) lineUpCameraSync();
}

// A closing or reloading tab leaves (a crashed one stays counted until it is
// back); one restored from the back/forward cache says hello again.
globalThis.addEventListener?.('pagehide', () => { if (channel) post({ type: 'bye' }); });
globalThis.addEventListener?.('pageshow', (e) => { if (channel && e.persisted) post({ type: 'hello' }); });

onPanelsReset(() => {
  setCameraSync(false);
  setCameraSyncMode('view');
  setCameraSyncCentre(false);
});

/** Input that makes this tab lead again after following (see the header). */
const USER_INPUT = ['pointerdown', 'wheel', 'keydown'];

function onUserInput() {
  following = false;
  touchedAt = Date.now();
}

/** The Camera panel's Random spin is turning this tab's camera by itself. */
function spinning() {
  return !!general.autoRandomEnabled && (app.angularVelocity?.lengthSq() ?? 0) > 0;
}

function projectionOf(camera) {
  return camera.isOrthographicCamera ? 'parallel' : 'perspective';
}

function post(message) {
  try {
    channel?.postMessage({ v: VERSION, from: tabId, ...message });
  } catch { /* channel closed */ }
}

/** The camera as a flat list of numbers, to notice any move: position, orientation, zoom, centre, pan. */
function rawPose() {
  const camera = app.camera;
  const controls = app.controls;
  if (!camera || !controls) return null;
  return [
    ...camera.position.toArray(), ...camera.quaternion.toArray(), camera.zoom,
    ...controls.target.toArray(), app.cameraPan.x, app.cameraPan.y,
  ];
}

/** Put the camera back to a rawPose(). */
function restorePose(raw) {
  const camera = app.camera;
  camera.position.fromArray(raw, 0);
  camera.quaternion.fromArray(raw, 3);
  camera.zoom = raw[7];
  camera.updateProjectionMatrix();
  app.controls.target.fromArray(raw, 8);
  app.cameraPan.x = raw[11];
  app.cameraPan.y = raw[12];
  camera.updateMatrixWorld(true);
}

function samePose(a, b) {
  if (!a || !b) return a === b;
  return a.every((value, i) => Math.abs(value - b[i]) <= 1e-7 * (1 + Math.abs(value)));
}

/** This tab's pose as sent to the others; null with no structure shown. */
function currentPose() {
  try {
    return {
      view: cameraView(),
      target: app.controls.target.toArray(),
      pan: { x: app.cameraPan.x, y: app.cameraPan.y },
      projection: projectionOf(app.camera),
    };
  } catch {
    return null;  // nothing loaded yet: no structure to measure the view against
  }
}

/** How much bigger than fitted the structure looks: a parallel camera's zoom, a perspective camera's zoom over its distance. */
function magnification(view, projection) {
  return projection === 'parallel' ? view.zoom : view.zoom / view.distance;
}

/** `pose` (this tab's camera kind) with the magnification times `factor`, turned by `rotation`. */
function transformed(pose, rotation, factor) {
  const view = pose.view;
  const parallel = projectionOf(app.camera) === 'parallel';
  return {
    ...pose,
    view: {
      direction: new THREE.Vector3().fromArray(view.direction).applyQuaternion(rotation).toArray(),
      up: new THREE.Vector3().fromArray(view.up).applyQuaternion(rotation).toArray(),
      distance: parallel ? view.distance : view.distance / factor,
      zoom: parallel ? view.zoom * factor : view.zoom,
    },
  };
}

const inverseRotation = new THREE.Quaternion();

/** This tab's pose with its offset taken off: what it sends. */
function toShared(pose) {
  return transformed(pose, inverseRotation.copy(offset.rotation).invert(), 1 / offset.zoom);
}

/** A shared pose (in this tab's camera kind) with this tab's offset put on: what it follows. */
function fromShared(pose) {
  return transformed(pose, offset.rotation, offset.zoom);
}

/** In 'turns' mode, the offset that keeps this tab where it is under the shared pose `shared`. */
function takeOffset(shared) {
  const here = currentPose();
  if (!here) return;
  const projection = projectionOf(app.camera);
  viewQuaternion(here.view, qTo);
  viewQuaternion(shared.view, qFrom);
  offset.rotation.copy(qTo).multiply(qFrom.invert());
  offset.zoom = clampRange(magnification(here.view, projection) / magnification(shared.view, projection), 1e-3, 1e3);
}

function sendPose(to = undefined, extra = {}) {
  const pose = currentPose();
  if (pose) post({ type: 'pose', ...toShared(pose), touchedAt, ...(to ? { to } : {}), ...extra });
  last = rawPose();
}

// ---- receiving -----------------------------------------------------------

const LIMIT = 1e7;

function inRange(value, lo, hi) {
  return typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
}

function finiteArray(value, length) {
  return Array.isArray(value) && value.length === length && value.every((v) => inRange(v, -LIMIT, LIMIT));
}

function unitArray(value) {
  if (!finiteArray(value, 3)) return null;
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length < 0.5 || length > 2) return null;
  return value.map((v) => v / length);
}

/** A checked copy of another tab's pose, or null when anything is off. */
function readPose(data) {
  const view = data.view;
  if (!view || typeof view !== 'object') return null;
  const direction = unitArray(view.direction);
  const up = unitArray(view.up);
  if (!direction || !up) return null;
  if (!inRange(view.distance, 1e-4, 1e4) || !inRange(view.zoom, 1e-4, 1e4)) return null;
  if (!finiteArray(data.target, 3)) return null;
  const pan = data.pan;
  if (!pan || typeof pan !== 'object' || !inRange(pan.x, -LIMIT, LIMIT) || !inRange(pan.y, -LIMIT, LIMIT)) return null;
  return {
    view: { direction, up, distance: view.distance, zoom: view.zoom },
    target: [...data.target],
    pan: { x: pan.x, y: pan.y },
  };
}

const clampRange = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/**
 * `pose` from a camera of the kind `projection`, with its zoom in this camera's
 * terms: the same magnification (1 when fitted, see magnification()).
 */
function inOwnProjection(pose, projection) {
  const own = projectionOf(app.camera);
  if ((projection !== 'parallel' && projection !== 'perspective') || projection === own) return pose;
  const view = pose.view;
  const seen = magnification(view, projection);
  if (own === 'parallel') {
    // A parallel view does not depend on the distance: this camera stays where it is.
    const here = currentPose();
    if (!here) return null;
    return { ...pose, view: { ...view, zoom: clampRange(seen, 1e-4, 1e4), distance: here.view.distance } };
  }
  const zoom = app.camera.zoom;
  return { ...pose, view: { ...view, zoom, distance: clampRange(zoom / seen, 1e-4, 1e4) } };
}

function onMessage(event) {
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== VERSION) return;
  if (typeof data.from !== 'string' || data.from.length === 0 || data.from.length > 64 || data.from === tabId) return;
  if (data.type === 'bye') {
    if (peers.delete(data.from)) changed();
  } else if (data.type === 'hello') {
    addPeer(data.from);
    sendPose(data.from);
  } else if (data.type === 'pose') {
    const read = readPose(data);
    if (!read) return;
    addPeer(data.from);
    if (data.to !== undefined && data.to !== tabId) return;  // an answer to another tab's hello
    const theirs = inRange(data.touchedAt, 0, Number.MAX_SAFE_INTEGER) ? data.touchedAt : 0;
    // Leading a spin, this tab was touched last: that tab has not heard it yet.
    if (!following && spinning() && theirs < touchedAt) return;
    const shared = inOwnProjection(read, data.projection);
    if (!shared) return;
    if (data.align === true) dropOffset();
    else if (mode === 'turns' && data.to === tabId) {
      // Joining in 'turns': keep this tab's view, and turn along from here.
      takeOffset(shared);
      return;
    }
    goal = fromShared(shared);
    following = true;
  }
}

/** Count `id` as a linked tab (a hello, or a pose that passed the checks). */
function addPeer(id) {
  if (peers.has(id) || peers.size >= MAX_PEERS) return;
  peers.add(id);
  changed();
}

// ---- the frame loop ------------------------------------------------------

const qFrom = new THREE.Quaternion();
const qTo = new THREE.Quaternion();
const basis = new THREE.Matrix4();
const ex = new THREE.Vector3();
const ey = new THREE.Vector3();
const ez = new THREE.Vector3();

/** The camera orientation that looks back along `view.direction` with `view.up` up. */
function viewQuaternion(view, out) {
  ez.fromArray(view.direction).normalize();
  ey.fromArray(view.up);
  ey.addScaledVector(ez, -ey.dot(ez)).normalize();
  ex.crossVectors(ey, ez);
  return out.setFromRotationMatrix(basis.makeBasis(ex, ey, ez));
}

/** Toward `to` by the fraction `a`, in ratio (for distances and zooms). */
const ratioLerp = (from, to, a) => from * (to / from) ** a;

/** Apply the goal pose, `a` of the way from the current one (1: all the way). */
function easeTowardGoal(a) {
  const absolute = mode === 'view' && centre;
  const from = currentPose();
  if (!from) return;
  viewQuaternion(from.view, qFrom);
  viewQuaternion(goal.view, qTo);
  const close = qFrom.angleTo(qTo) < 1e-4
    && Math.abs(from.view.distance / goal.view.distance - 1) < 1e-4
    && Math.abs(from.view.zoom / goal.view.zoom - 1) < 1e-4
    && (!absolute || (
      new THREE.Vector3().fromArray(from.target).distanceTo(new THREE.Vector3().fromArray(goal.target)) < 1e-4
      && Math.hypot(from.pan.x - goal.pan.x, from.pan.y - goal.pan.y) < 1e-4));
  if (a >= 0.999 || close) {
    applyView(goal.view, absolute ? goal : null);
    goal = null;
    return;
  }
  qFrom.slerp(qTo, a);
  const view = {
    direction: new THREE.Vector3(0, 0, 1).applyQuaternion(qFrom).toArray(),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(qFrom).toArray(),
    distance: ratioLerp(from.view.distance, goal.view.distance, a),
    zoom: ratioLerp(from.view.zoom, goal.view.zoom, a),
  };
  applyView(view, absolute ? {
    target: from.target.map((v, i) => v + (goal.target[i] - v) * a),
    pan: { x: from.pan.x + (goal.pan.x - from.pan.x) * a, y: from.pan.y + (goal.pan.y - from.pan.y) * a },
  } : null);
}

function tick(time) {
  if (!channel) return;
  frame = requestAnimationFrame(tick);
  const dt = lastTime ? Math.min((time - lastTime) / 1000, 1) : 1;
  lastTime = time;
  let pose = rawPose();
  if (last && !samePose(pose, last) && following && spinning()) {
    // Its own spin, while another tab leads: undo it, and follow as usual.
    restorePose(last);
    pose = last;
  }
  if (!samePose(pose, last)) {
    // This tab moved: it leads, and the others follow it.
    goal = null;
    following = false;
    sendPose();
  } else if (goal) {
    easeTowardGoal(1 - Math.exp(-dt / TAU_S));
    last = rawPose();
  }
}
