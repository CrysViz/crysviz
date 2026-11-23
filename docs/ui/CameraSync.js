// Camera sync between CrysViz tabs and windows of one browser (Camera panel ▸
// "Sync camera across tabs"). Each tab that has sync on follows the others:
// turning or zooming one turns and zooms the rest.
//
// Modes (what this tab copies from the others; a choice per tab):
//   'rotation'  direction, up and zoom, relative to each tab's own structure
//               (ui/CameraView.js), so different structures turn together
//   'view'      also the rotation centre and the pan: the whole view, for the
//               same structure shown two ways (renderer, colours, settings)
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
//   { v:1, type:'pose', from, view, target, pan }    a tab's camera: a CameraView `view`, plus its
//                                                    rotation centre [x,y,z] and pan {x,y} for 'view' mode
//
// Smoothness: one animation-frame loop runs while sync is on. Each frame it
// compares the camera with the pose it last sent or applied. A difference is
// this tab's own move (a drag, its momentum, a View button, a new structure):
// it is sent, at most once per frame, and drops any pose being followed, so
// the tab you touch leads. Otherwise the camera eases toward the latest pose
// from another tab (exponentially, time constant TAU_S), so a jump in the
// leading tab glides here and tabs with different frame rates stay smooth.

import * as THREE from '../external/three/three.module.js';
import { app } from '../state/store.js';
import { cameraView, applyView } from './CameraView.js';
import { getPanelPref, setPanelPref, onPanelsReset } from './panels/PanelManager.js';

const CHANNEL = 'crysviz-camera-sync';
const VERSION = 1;
/** Easing time constant toward another tab's pose, in seconds. */
const TAU_S = 0.04;
export const CAMERA_SYNC_MODES = ['rotation', 'view'];
const DEFAULT_MODE = 'rotation';

const tabId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 64);

/** @type {BroadcastChannel|null} */
let channel = null;
let mode = CAMERA_SYNC_MODES.includes(getPanelPref('cameraSyncMode')) ? getPanelPref('cameraSyncMode') : DEFAULT_MODE;
/** The latest pose from another tab, eased toward until reached. */
let goal = null;
/** The camera as last sent or applied, as numbers (see rawPose). */
let last = null;
let frame = 0;
let lastTime = 0;
const listeners = new Set();

export function cameraSyncSupported() {
  return typeof BroadcastChannel === 'function';
}

export function isCameraSyncOn() {
  return channel != null;
}

export function getCameraSyncMode() {
  return mode;
}

/** Call `fn()` whenever sync is switched on or off or its mode changes. */
export function onCameraSyncChange(fn) {
  listeners.add(fn);
}

function changed() {
  listeners.forEach((fn) => fn());
}

/** What this tab copies from the others: 'rotation' or 'view'. */
export function setCameraSyncMode(next) {
  if (!CAMERA_SYNC_MODES.includes(next)) return;
  mode = next;
  setPanelPref('cameraSyncMode', next);
  changed();
}

/**
 * Switch sync on or off for this tab. Switching on follows the tabs already
 * in sync; `lead` instead makes them follow this tab's current view (it also
 * works when sync is already on).
 */
export function setCameraSync(on, { lead = false } = {}) {
  if (on && !cameraSyncSupported()) return;
  if (!on) {
    if (!channel) return;
    channel.close();
    channel = null;
    goal = null;
    cancelAnimationFrame(frame);
    frame = 0;
    changed();
    return;
  }
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = onMessage;
    // The camera as it is now is not a move of ours: nothing to send yet.
    last = rawPose();
    lastTime = 0;
    frame = requestAnimationFrame(tick);
    if (!lead) post({ type: 'hello' });
    changed();
  }
  if (lead) sendPose();
}

onPanelsReset(() => {
  setCameraSync(false);
  setCameraSyncMode(DEFAULT_MODE);
});

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
    };
  } catch {
    return null;  // nothing loaded yet: no structure to measure the view against
  }
}

function sendPose() {
  const pose = currentPose();
  if (pose) post({ type: 'pose', ...pose });
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

function onMessage(event) {
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== VERSION) return;
  if (typeof data.from !== 'string' || data.from.length === 0 || data.from.length > 64 || data.from === tabId) return;
  if (data.type === 'hello') {
    sendPose();
  } else if (data.type === 'pose') {
    const pose = readPose(data);
    if (pose) goal = pose;
  }
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
  const absolute = mode === 'view';
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
  const pose = rawPose();
  if (!samePose(pose, last)) {
    // This tab moved by itself: it leads, and the others follow it.
    goal = null;
    sendPose();
  } else if (goal) {
    easeTowardGoal(1 - Math.exp(-dt / TAU_S));
    last = rawPose();
  }
}
