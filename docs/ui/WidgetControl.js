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
//   setFrame  { index }              show frame `index` (clamped)
//   play      { fps?=10, loop?=true } start stepping frames
//   pause                            stop stepping
// widget → host  { source:'crysviz-widget', type, ... }
//   ready   { frameCount, index }    posted once the trajectory is loaded
//   state   { frameCount, index, playing }
//   frame   { frameCount, index }    whenever the shown frame changes

import { fileBrowser, structureShip } from '../state/store.js';
import { showTrajectoryFrame } from './TrajectoryPanel.js';

const SRC = 'crysviz-widget';       // tag on messages we post to the host
const TARGET = 'crysviz-widget';    // tag we require on messages from the host
const PROTOCOL_VERSION = 1;

/** Captured on the first valid command; outbound messages target it thereafter. */
let controllerOrigin = null;
/** Frame currently shown (index into the loaded container's structures). */
let currentIndex = 0;
let playTimer = null;
let playLoop = true;

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

/** Show a frame without ever re-orienting the camera, and tell the host. */
function applyFrame(index) {
  const container = liveContainer();
  const n = container?.structures?.length ?? 0;
  if (!container || n === 0) return;
  const clamped = Math.max(0, Math.min(n - 1, index | 0));
  currentIndex = clamped;
  // recenter:false — new coordinates must not move/re-frame the camera.
  showTrajectoryFrame(clamped, container, { recenter: false });
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
  postToHost('state', { index: currentIndex, frameCount: frameCount(), playing: playTimer != null });
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

  switch (data.type) {
    case 'getState':
      sendState();
      break;
    case 'setFrame':
      stopPlay();
      if (Number.isFinite(data.index)) applyFrame(data.index);
      break;
    case 'play':
      startPlay(data.fps, data.loop);
      break;
    case 'pause':
      stopPlay();
      break;
    default:
      break; // unknown type — ignore
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
  // Announce readiness so the host knows it can start sending commands.
  postToHost('ready', { index: currentIndex, frameCount: frameCount() });
}
