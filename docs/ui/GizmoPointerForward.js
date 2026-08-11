// Promote a drag that starts on a locked scene widget to the main renderer.
// The GestureArbiter already treats pointer events whose target is the canvas
// as ordinary camera input; this module only supplies the equivalent event
// sequence after the widget's 4px drag threshold is crossed.

import { app } from '../state/store.js';
import { requestRender } from '../render/index.js';

const DRAG_THRESHOLD = 4;
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, [contenteditable]:not([contenteditable="false"])';

function isInteractiveTarget(element, target) {
  return target instanceof Element
    && element.contains(target)
    && !!target.closest(INTERACTIVE_SELECTOR);
}

function isIgnoredTarget(element, target, ignoreSelector) {
  return !!ignoreSelector
    && target instanceof Element
    && element.contains(target)
    && !!target.closest(ignoreSelector);
}

function pointerInit(source, type) {
  return {
    bubbles: true,
    cancelable: type !== 'pointercancel',
    pointerId: source.pointerId,
    pointerType: source.pointerType,
    isPrimary: source.isPrimary,
    clientX: source.clientX,
    clientY: source.clientY,
    pageX: source.pageX ?? source.clientX + window.scrollX,
    pageY: source.pageY ?? source.clientY + window.scrollY,
    screenX: source.screenX,
    screenY: source.screenY,
    button: source.button,
    buttons: source.buttons,
    pressure: source.pressure,
    width: source.width,
    height: source.height,
    tiltX: source.tiltX,
    tiltY: source.tiltY,
    twist: source.twist,
  };
}

function makeForwardedEvent(type, source) {
  const event = new PointerEvent(type, pointerInit(source, type));
  // The document move/up listeners below also see events dispatched on the
  // canvas. Mark these so they cannot redispatch themselves recursively.
  /** @type {any} */ (event)._cvLockedWidgetForward = true;
  return event;
}

/**
 * @param {HTMLElement} element locked widget root
 * @param {() => boolean} isLocked live lock predicate
 * @param {{ ignoreSelector?: string, onPromote?: (pointerId: number) => void }} [opts]
 * @returns {(() => void) & { abortPointer: (pointerId: number) => void, abortAll: () => void }} disposer
 */
export function wireLockedWidgetForwarding(element, isLocked, opts = {}) {
  /** @type {Map<number, { pointerId: number, pointerType: string, down: PointerEvent, last: PointerEvent, forwarded: boolean, target: HTMLElement }>} */
  const active = new Map();

  const dispatch = (state, type, source) => {
    const event = makeForwardedEvent(type, source);
    // TrackballControls captures the canvas on pointerdown. That would steal
    // the real pointer from the widget, causing lostpointercapture to cancel
    // this sequence while leaving Trackball's document listeners installed.
    // Keep capture on the widget for trusted and synthetic sources alike;
    // The forwarded pointerup still runs through Trackball's normal cleanup.
    const originalCapture = state.target.setPointerCapture;
    const originalReleaseCapture = state.target.releasePointerCapture;
    state.target.setPointerCapture = () => {};
    state.target.releasePointerCapture = () => {};
    try {
      state.target.dispatchEvent(event);
      if (type === 'pointermove') {
        // The original pointermove is captured by the widget, so it cannot
        // reach the normal render invalidation path. Advance Trackball's
        // pending delta immediately as well as invalidating the next frame;
        // this keeps a rapid promoted sequence from reaching pointerup
        // before the on-demand loop has had a chance to apply the rotation.
        app.controls?.update();
        requestRender();
      }
    } finally {
      state.target.setPointerCapture = originalCapture;
      state.target.releasePointerCapture = originalReleaseCapture;
    }
  };

  const forward = (state, source) => {
    if (state.forwarded) return;
    state.forwarded = true;
    opts.onPromote?.(state.pointerId);
    dispatch(state, 'pointerdown', state.down);
    dispatch(state, 'pointermove', source);
  };

  const removeState = (pointerId, endType, source, abort = false) => {
    const state = active.get(pointerId);
    if (!state) return;
    if (state.forwarded) dispatch(state, endType, source);
    if (state.forwarded && app.controls && abort) {
      // Forced termination must not leave a dynamic-damping tail behind when
      // a lock, long-press claim, cancellation, or capture loss aborts it.
      app.controls._movePrev.copy(app.controls._moveCurr);
      app.controls._lastAngle = 0;
    }
    active.delete(pointerId);
    try {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    } catch { /* capture may already have been lost */ }
  };

  const onPointerDown = (event) => {
    if (!isLocked()) return;
    if (event.pointerType !== 'mouse' && event.pointerType !== 'touch') return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isInteractiveTarget(element, event.target)
      || isIgnoredTarget(element, event.target, opts.ignoreSelector)) return;
    const target = app.renderer?.domElement;
    if (!target || target === element) return;

    const state = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      down: event,
      last: event,
      forwarded: false,
      target,
    };
    active.set(event.pointerId, state);
    try { element.setPointerCapture(event.pointerId); } catch { /* synthetic events cannot capture */ }
    // Stop the widget's normal bubble-phase drag handlers. Other listeners on
    // this same root, notably wireLongPress's capture listener, still run.
    event.stopPropagation();
  };

  const onPointerMove = (event) => {
    const forwardedEvent = /** @type {any} */ (event);
    if (forwardedEvent._cvLockedWidgetForward) return;
    const state = active.get(event.pointerId);
    if (!state) return;
    state.last = event;
    if (!isLocked()) {
      removeState(event.pointerId, 'pointerup', event, true);
      return;
    }
    if (!state.forwarded
      && Math.hypot(event.clientX - state.down.clientX, event.clientY - state.down.clientY) >= DRAG_THRESHOLD) {
      // Promote every held touch together when one crosses the threshold, so
      // a second finger that starts on the locked widget can form a pinch.
      if (state.pointerType === 'touch') {
        for (const held of active.values()) {
          if (held.pointerType === 'touch') forward(held, held === state ? event : held.last);
        }
      } else {
        forward(state, event);
      }
      event.preventDefault();
      return;
    }
    if (state.forwarded) {
      dispatch(state, 'pointermove', event);
      event.preventDefault();
    }
  };

  const onPointerUp = (event) => {
    const forwardedEvent = /** @type {any} */ (event);
    if (forwardedEvent._cvLockedWidgetForward) return;
    removeState(event.pointerId, 'pointerup', event);
  };

  const onPointerCancel = (event) => {
    const forwardedEvent = /** @type {any} */ (event);
    if (forwardedEvent._cvLockedWidgetForward) return;
    // TrackballControls' cancel path removes the pointer but leaves its
    // document listeners installed. A forwarded pointerup is the equivalent
    // termination that also runs its complete cleanup path.
    removeState(event.pointerId, 'pointerup', event, true);
  };

  const onLostPointerCapture = (event) => {
    const state = active.get(event.pointerId);
    if (state) removeState(event.pointerId, 'pointerup', state.last, true);
  };

  element.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  element.addEventListener('lostpointercapture', onLostPointerCapture);

  const dispose = () => {
    for (const state of active.values()) {
      if (state.forwarded) dispatch(state, 'pointerup', state.last);
      if (state.forwarded && app.controls) {
        app.controls._movePrev.copy(app.controls._moveCurr);
        app.controls._lastAngle = 0;
      }
      try {
        if (element.hasPointerCapture(state.pointerId)) element.releasePointerCapture(state.pointerId);
      } catch { /* already released */ }
    }
    active.clear();
    element.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', onPointerCancel, true);
    element.removeEventListener('lostpointercapture', onLostPointerCapture);
  };

  // Long-press consumes its held pointer before opening the menu. A lock
  // toggle also uses these methods so no gesture can straddle the state
  // change. Forwarded sequences receive pointerup so Trackball's complete
  // pointer/document-listener cleanup path runs.
  dispose.abortPointer = (pointerId) => removeState(pointerId, 'pointerup', active.get(pointerId)?.last, true);
  dispose.abortAll = () => {
    for (const state of [...active.values()]) {
      removeState(state.pointerId, 'pointerup', state.last, true);
    }
  };
  return dispose;
}
