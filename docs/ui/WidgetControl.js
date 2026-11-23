// Widget-mode live control channel (?widget=1&control=1).
//
// Lets the embedding website drive a loaded trajectory in real time over
// `postMessage`, with no iframe reload — so a host page can scrub or animate the
// frames of a multi-frame `.crysviz` session. It is host-only: the widget shows
// no playback UI of its own, it just obeys the parent page and reports back so
// the host's own controls can stay in sync. Setting a frame NEVER re-orients the
// camera (recenter:false), so the structure stays put while its coordinates
// update.
//
// It also reports the user's camera moves (`camera`) and takes a view from the
// host (`setCamera`), so a host page can link the cameras of two widgets that
// show different structures: turning one turns the other.
//
// Opt-in: nothing here runs unless the embed URL carries `control=1`, so a plain
// embed installs no message listener at all.
//
// Security model
// --------------
//   * Commands are accepted ONLY from `window.parent` (event.source check) — the
//     direct embedder. A different tab/site cannot obtain a postMessage handle
//     into this iframe without embedding it itself (at which point it *is* the
//     legitimate parent), and the browser sets event.source authentically, so it
//     cannot be forged.
//   * Every command must be a plain object tagged `{ target: 'crysviz-widget' }`
//     with a known `type`; anything else is ignored silently.
//   * Numeric params are validated and clamped; a bad message is a no-op.
//   * Outbound notifications go to the controller's captured origin once known
//     (falling back to '*' only for the initial "ready", which carries nothing
//     sensitive — just the frame count).
//
// Protocol
// --------
// host → widget  { target:'crysviz-widget', type, ... }
//   getState                         → widget replies `state`
//   setFrame  { index, recenter? }   show frame `index` (clamped); recenter:true also refits the
//                                    camera to the new frame (a different structure, not a trajectory step)
//   fitView                          recenter + refit the camera to the shown frame, keeping the direction
//   play      { fps?=10, loop?=true } start stepping frames
//   pause                            stop stepping
//   getCamera                        → widget replies `camera`
//   setCamera { view }               turn/zoom the camera to `view` (below); keeps this widget's own
//                                    rotation centre and pan, and is never reported back as `camera`
// widget → host  { source:'crysviz-widget', type, ... }
//   ready   { frameCount, index, camera:true }  posted once the trajectory is loaded; `camera`: this
//                                    widget reports camera moves and takes setCamera
//   state   { frameCount, index, playing, camera:true }  (camera as in `ready`, for a host
//                                    that attached its listener after `ready` was posted)
//   frame   { frameCount, index }    after every setFrame and play step
//   camera  { view }                 the user moved the camera (at most once per animation frame);
//                                    moves made by host commands (setFrame, fitView, setCamera) are
//                                    not reported, so two widgets linked through their host don't echo
//
// A `view` is relative, so it carries over between two different structures: see ui/CameraView.js.

import { app, fileBrowser, structureShip } from '../state/store.js';
import { showTrajectoryFrame } from './TrajectoryPanel.js';
import { fitCameraToCurrentStructure } from './WindowAndSceneControls.js';
import { requestRender } from '../render/index.js';
import { cameraView, applyView } from './CameraView.js';

const SRC = 'crysviz-widget';       // tag on messages we post to the host
const TARGET = 'crysviz-widget';    // tag we require on messages from the host
const PROTOCOL_VERSION = 1;

/** Captured on the first valid command; outbound messages target it thereafter. */
let controllerOrigin = null;
/** Frame currently shown (index into the loaded container's structures). */
let currentIndex = 0;
let playTimer = null;
let playLoop = true;
/** True while a host command moves the camera: such moves are not reported (no echo between linked widgets). */
let hostMove = false;
/** A `camera` report is waiting for the next animation frame (one per frame, however many moves). */
let cameraQueued = false;

/** The container holding the loaded trajectory's frames (the session the widget
 *  was launched with lives at the selected row). */
function liveContainer() {
  return structureShip.container[fileBrowser.selectedRowIndex] ?? null;
}

function frameCount() {
  return liveContainer()?.structures?.length ?? 0;
}

/** Post a notification to the embedding page. */
function postToHost(type, extra = {}) {
  try {
    window.parent?.postMessage(
      { source: SRC, version: PROTOCOL_VERSION, type, ...extra },
      controllerOrigin || '*',
    );
  } catch { /* parent gone / cross-origin post rejected — nothing to do */ }
}

/** Recenter and refit the camera to the shown structure, keeping the viewing direction. */
function fitView() {
  fitCameraToCurrentStructure();
  requestRender();
}

/** TrackballControls 'change': report the user's camera moves to the host, once per animation frame. */
function onCameraChange() {
  if (hostMove || cameraQueued) return;
  cameraQueued = true;
  requestAnimationFrame(() => {
    cameraQueued = false;
    postToHost('camera', { view: cameraView() });
  });
}

/** Show a frame (re-orienting the camera only when `fit`), and tell the host. */
function applyFrame(index, fit = false) {
  const container = liveContainer();
  const n = container?.structures?.length ?? 0;
  if (!container || n === 0) return;
  const clamped = Math.max(0, Math.min(n - 1, index | 0));
  currentIndex = clamped;
  // recenter:false — new coordinates must not move/re-frame the camera.
  showTrajectoryFrame(clamped, container, { recenter: false });
  if (fit) fitView();
  postToHost('frame', { index: clamped, frameCount: n });
}

function stopPlay() {
  if (playTimer != null) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

function startPlay(fps, loop) {
  stopPlay();
  const n = frameCount();
  if (n <= 1) return;
  playLoop = loop !== false;
  const safeFps = Number.isFinite(fps) && fps > 0 ? Math.min(fps, 60) : 10;
  playTimer = setInterval(() => {
    let next = currentIndex + 1;
    if (next >= frameCount()) {
      if (!playLoop) { stopPlay(); return; }
      next = 0;
    }
    applyFrame(next);
  }, 1000 / safeFps);
}

function sendState() {
  postToHost('state', { index: currentIndex, frameCount: frameCount(), playing: playTimer != null, camera: true });
}

function onMessage(event) {
  // Only the direct embedder may drive the widget.
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.target !== TARGET) return;
  // Remember who is controlling us so replies go straight back to them.
  // An opaque-origin host (sandboxed / file://) reports 'null', which is not a
  // valid postMessage target — keep '*' for it (still only to window.parent).
  if (controllerOrigin == null && typeof event.origin === 'string' && event.origin !== 'null') {
    controllerOrigin = event.origin;
  }

  // Camera moves made while obeying a command are the host's, not the user's: not reported (see onCameraChange).
  hostMove = true;
  try {
    switch (data.type) {
      case 'getState':
        sendState();
        break;
      case 'setFrame':
        stopPlay();
        if (Number.isFinite(data.index)) applyFrame(data.index, data.recenter === true);
        break;
      case 'fitView':
        fitView();
        break;
      case 'play':
        startPlay(data.fps, data.loop);
        break;
      case 'pause':
        stopPlay();
        break;
      case 'getCamera':
        postToHost('camera', { view: cameraView() });
        break;
      case 'setCamera':
        applyView(data.view);
        break;
      default:
        break; // unknown type — ignore
    }
  } finally {
    hostMove = false;
  }
}

/**
 * Install the control channel when the embed opted in with `control=1`.
 * Runs once, from initWidgetMode after the trajectory has loaded.
 */
export function initWidgetControl() {
  let enabled = false;
  try {
    enabled = new URLSearchParams(window.location.search).get('control') === '1';
  } catch { /* no URL access — leave disabled */ }
  if (!enabled) return;

  const container = liveContainer();
  const i = container?.structures?.indexOf(fileBrowser.selectedStructure) ?? -1;
  currentIndex = i >= 0 ? i : 0;

  window.addEventListener('message', onMessage);
  app.controls?.addEventListener('change', onCameraChange);
  // Announce readiness so the host knows it can start sending commands.
  postToHost('ready', { index: currentIndex, frameCount: frameCount(), camera: true });
}
