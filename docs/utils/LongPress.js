// Small pointer gesture shared by scene-resident widgets.  It deliberately
// does not capture the pointer: the widget's drag handler owns capture once a
// press crosses the drag threshold.

const DRAG_THRESHOLD = 4;
const LONG_PRESS_MS = 500;
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, [contenteditable]:not([contenteditable="false"])';

function isInteractiveTarget(element, target) {
  return target instanceof Element
    && element.contains(target)
    && !!target.closest(INTERACTIVE_SELECTOR);
}

function matchesIgnoredTarget(element, target, ignoreSelector) {
  return !!ignoreSelector
    && target instanceof Element
    && element.contains(target)
    && !!target.closest(ignoreSelector);
}

/**
 * @param {HTMLElement} element
 * @param {(coords: {clientX: number, clientY: number, pointerId: number, pointerType: string}) => void} onLongPress
 * @param {{ threshold?: number, delay?: number, ignoreSelector?: string,
 *   onFire?: (coords: {pointerId: number, pointerType: string}) => void }} [opts]
 * @returns {() => void} removes the listeners
 */
export function wireLongPress(element, onLongPress, opts = {}) {
  const threshold = opts.threshold ?? DRAG_THRESHOLD;
  const delay = opts.delay ?? LONG_PRESS_MS;
  let pending = null;
  let timer = null;
  let suppressClick = false;
  let suppressContextMenu = false;

  const clearPending = () => {
    if (timer != null) window.clearTimeout(timer);
    timer = null;
    pending = null;
  };

  const clearSuppression = () => {
    suppressClick = false;
    suppressContextMenu = false;
  };

  const cancelForPointer = (pointerId) => {
    if (pending?.pointerId === pointerId) clearPending();
  };

  const onPointerDown = (event) => {
    // A new physical press starts a new compatibility-event sequence. Do not
    // let a delayed event from an earlier press consume this press's guard.
    clearSuppression();
    if (isInteractiveTarget(element, event.target)
      || matchesIgnoredTarget(element, event.target, opts.ignoreSelector)) {
      clearPending();
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.pointerType !== 'mouse' && event.pointerType !== 'touch') return;
    if (event.pointerType === 'touch' && pending?.pointerType === 'touch') {
      clearPending();
      return;
    }

    clearPending();
    const target = event.target instanceof Element ? event.target : element;
    pending = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      target,
    };
    timer = window.setTimeout(() => {
      if (!pending) return;
      const press = pending;
      clearPending();
      suppressClick = true;
      suppressContextMenu = true;
      // Abort/release the widget's active drag or resize before opening the
      // menu. The widget roots supply touch-action: none, so no late
      // preventDefault on the saved pointerdown is needed here.
      opts.onFire?.({ pointerId: press.pointerId, pointerType: press.pointerType });
      onLongPress({
        clientX: press.startX,
        clientY: press.startY,
        pointerId: press.pointerId,
        pointerType: press.pointerType,
      });
    }, delay);
  };

  const onPointerMove = (event) => {
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) >= threshold) {
      clearPending();
    }
  };

  const onPointerEnd = (event) => cancelForPointer(event.pointerId);

  const onAnyPointerDown = () => clearSuppression();

  const onClick = (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick = false;
  };

  const onContextMenu = (event) => {
    if (!suppressContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    suppressContextMenu = false;
  };

  element.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerdown', onAnyPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerEnd, true);
  document.addEventListener('pointercancel', onPointerEnd, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('contextmenu', onContextMenu, true);

  return () => {
    clearPending();
    clearSuppression();
    element.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointerdown', onAnyPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerEnd, true);
    document.removeEventListener('pointercancel', onPointerEnd, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
  };
}
