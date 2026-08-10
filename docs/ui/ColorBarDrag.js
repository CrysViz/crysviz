// Lets a color-bar widget (built by SpinPanel/ForcePanel's createColorBar) be
// dragged out of its side-panel container and dropped onto the 3D scene
// (#view), where it becomes a small floating legend the user can reposition
// or send back to the panel. Mirrors the drag mechanics of
// ui/panels/PanelWindow.js (pointer capture on the drag handle, threshold
// before a press becomes a drag, viewport/scene clamping).

import { listActiveColorBars } from './ColorBarRegistry.js';

const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag
const OVERLAY_Z = 950; // above the canvas, below panel windows (which start at 1200)
const SNAP_THRESHOLD = 10; // px: how close two bars' centers must get before snapping

// Shared across every color bar (module scope, not per-instance) — mirrors
// ui/panels/PanelWindow.js's own floatZ counter exactly: whichever bar was
// most recently interacted with claims the next value, so it paints above
// every other floating bar instead of stacking purely by DOM/creation order
// (which doesn't track "the one I'm currently touching" once more than one
// bar is floating at the same time).
let colorBarFloatZ = OVERLAY_Z;

function viewRect() {
  const view = document.getElementById('view');
  return view ? view.getBoundingClientRect() : null;
}

function isOverScene(x, y) {
  const rect = viewRect();
  return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function clampToScene(left, top, width, height) {
  const rect = viewRect();
  if (!rect) return { left, top };
  const minLeft = rect.left + 4;
  const maxLeft = Math.max(minLeft, rect.right - width - 4);
  const minTop = rect.top + 4;
  const maxTop = Math.max(minTop, rect.bottom - height - 4);
  return {
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop),
  };
}

/**
 * @param {HTMLElement} wrapper the color-bar's outer element (becomes the
 *   floating, position:fixed node once dropped onto the scene)
 * @param {string} floatingId a DOM id to stamp on `wrapper` only while it is
 *   floating over the scene, so the owning panel can find-and-remove it on
 *   teardown even though it now lives outside the panel's DOM subtree.
 * @param {{ gripParent?: HTMLElement | null, onFloatChange?: (floating: boolean) => void,
 *   extraHandles?: HTMLElement[] }} [opts]
 *   gripParent: where to mount the drag grip (defaults to `wrapper` itself).
 *   onFloatChange: called right after floating starts/ends. extraHandles:
 *   additional elements (e.g. the gradient bar itself) that also start a
 *   drag on pointerdown, so the grip isn't the only way in. The returned
 *   `dockBack()` lets a caller (e.g. a "Dock" menu item) return the bar to
 *   its panel without a drag gesture.
 */
export function makeColorBarDraggable(wrapper, floatingId, opts = {}) {
  const { gripParent = wrapper, onFloatChange, extraHandles = [] } = opts;

  // While dragging, pull the box toward center-alignment with any other
  // floating bar it passes near — "within 10px" reads as "snaps into
  // place" rather than the user having to eyeball pixel-perfect alignment.
  // Center-only for now (not edges): simpler, and covers the common case of
  // lining several legends up in a row/column.
  function snapToOtherBars(left, top, width, height) {
    // left/top (like everywhere else in this file) are CSS top/left values —
    // the margin-BOX position, not the rendered border box getBoundingClientRect
    // reports (a positioned element's top/left place its margin edge, per the
    // CSS spec, and this wrapper carries a non-zero marginTop for tick-row
    // clearance). Compare in rendered/visual space (+margin) so two bars'
    // margin boxes don't need to match for their visible bars to line up,
    // then convert the result back to style-space (-margin) before returning.
    const cs = getComputedStyle(wrapper);
    const marginLeft = parseFloat(cs.marginLeft) || 0;
    const marginTop = parseFloat(cs.marginTop) || 0;
    const centerX = left + marginLeft + width / 2;
    const centerY = top + marginTop + height / 2;
    let snappedLeft = left;
    let snappedTop = top;
    let bestDX = SNAP_THRESHOLD;
    let bestDY = SNAP_THRESHOLD;
    for (const bar of listActiveColorBars()) {
      if (bar.instance.getElement?.() === wrapper || !bar.instance.isFloating?.()) continue;
      const rect = bar.instance.getWrapperRect?.();
      if (!rect) continue;
      const otherCenterX = rect.left + rect.width / 2;
      const otherCenterY = rect.top + rect.height / 2;
      const dx = Math.abs(centerX - otherCenterX);
      if (dx < bestDX) { bestDX = dx; snappedLeft = otherCenterX - width / 2 - marginLeft; }
      const dy = Math.abs(centerY - otherCenterY);
      if (dy < bestDY) { bestDY = dy; snappedTop = otherCenterY - height / 2 - marginTop; }
    }
    return { left: snappedLeft, top: snappedTop };
  }

  const grip = gripParent ? document.createElement('span') : null;
  if (grip) {
    grip.className = 'cv-colorbar-grip';
    grip.textContent = '⦀';
    grip.title = 'Drag into the 3D scene';
    gripParent.insertBefore(grip, gripParent.firstChild);
  }

  let floating = false;
  let homeParent = wrapper.parentElement;
  let homeNextSibling = wrapper.nextSibling;

  function dockBack() {
    floating = false;
    wrapper.removeAttribute('id');
    wrapper.classList.remove('cv-colorbar-floating');
    wrapper.style.position = '';
    wrapper.style.left = '';
    wrapper.style.top = '';
    wrapper.style.width = '';
    wrapper.style.zIndex = '';
    if (homeNextSibling && homeNextSibling.parentElement === homeParent) {
      homeParent.insertBefore(wrapper, homeNextSibling);
    } else {
      homeParent.appendChild(wrapper);
    }
    onFloatChange?.(false);
  }

  // Where the bar sits is remembered as an offset from the nearest edge of
  // #view (left-or-right, top-or-bottom independently) rather than a raw
  // page-pixel position — the same scheme ui/panels/PanelWindow.js uses for
  // every other floating window. #view itself moves and resizes (docking a
  // side panel, collapsing the dock, resizing the browser window all change
  // its flex-computed width), and a page-pixel position doesn't track any of
  // that: the bar would visibly drift relative to the structure underneath
  // it even though nothing about the bar itself changed.
  let anchor = null;
  let activeAbort = null;

  function captureAnchor() {
    const rect = viewRect();
    if (!rect) { anchor = null; return; }
    const wRect = wrapper.getBoundingClientRect();
    const leftGap = wRect.left - rect.left;
    const rightGap = rect.right - wRect.right;
    const topGap = wRect.top - rect.top;
    const bottomGap = rect.bottom - wRect.bottom;
    anchor = {
      edgeX: leftGap <= rightGap ? 'left' : 'right',
      offsetX: leftGap <= rightGap ? leftGap : rightGap,
      edgeY: topGap <= bottomGap ? 'top' : 'bottom',
      offsetY: topGap <= bottomGap ? topGap : bottomGap,
    };
  }

  // Re-derive left/top from the anchor against #view's current rect. Called
  // after every drop/drag (via floatAt) and whenever #view itself changes.
  function applyAnchor() {
    if (!floating || !anchor) return;
    const rect = viewRect();
    if (!rect) return;
    const width = wrapper.offsetWidth;
    const height = wrapper.offsetHeight;
    // captureAnchor() measures offsetX/offsetY from getBoundingClientRect(),
    // which includes the wrapper's own margin (still applied for a
    // position:fixed box — margin isn't part of `top`/`left`, it pushes the
    // box further away from them). style.left/top, which we're about to
    // set, has no margin baked in, so writing the raw anchor-derived value
    // there double-counts the margin on top of what's already rendered —
    // subtract it back out so this reproduces the exact visual position the
    // anchor was captured from instead of drifting by the margin.
    const cs = getComputedStyle(wrapper);
    const marginLeft = parseFloat(cs.marginLeft) || 0;
    const marginTop = parseFloat(cs.marginTop) || 0;
    const left = (anchor.edgeX === 'left' ? rect.left + anchor.offsetX : rect.right - anchor.offsetX - width) - marginLeft;
    const top = (anchor.edgeY === 'top' ? rect.top + anchor.offsetY : rect.bottom - anchor.offsetY - height) - marginTop;
    const clamped = clampToScene(left, top, width, height);
    wrapper.style.left = `${clamped.left}px`;
    wrapper.style.top = `${clamped.top}px`;
  }

  // Claims the next shared z-index so this bar paints above every other
  // currently-floating one — see colorBarFloatZ's own comment.
  function raise() {
    colorBarFloatZ += 1;
    wrapper.style.zIndex = String(colorBarFloatZ);
  }

  // Shared setup for going floating, regardless of whether the target
  // position comes from a raw drop point (floatAt) or a previously captured
  // anchor (floatAtAnchor). Measures AFTER reparenting to body + going
  // position:fixed, not before: a wrapper built fresh for a colormap switch
  // is still sitting inside the docked panel with its constructor's
  // width:100%, so measuring offsetWidth first captures the docked panel's
  // width (e.g. 380px) instead of the bar's true content width — a vertical
  // bar would float at that stale wide box, stranding its centered controls
  // strip far from the narrow bar actually painted inside it. Clearing width
  // first lets position:fixed's shrink-to-fit measure the real size.
  function beginFloating() {
    floating = true;
    wrapper.id = floatingId;
    document.body.appendChild(wrapper);
    wrapper.classList.add('cv-colorbar-floating');
    wrapper.style.position = 'fixed';
    raise();
    wrapper.style.width = '';
    const width = wrapper.offsetWidth || 260;
    wrapper.style.width = `${width}px`;
  }

  function floatAt(left, top) {
    beginFloating();
    const width = wrapper.offsetWidth;
    const clamped = clampToScene(left, top, width, wrapper.offsetHeight || 40);
    wrapper.style.left = `${clamped.left}px`;
    wrapper.style.top = `${clamped.top}px`;
    captureAnchor();
    onFloatChange?.(true);
  }

  // Restore a previously captured anchor (edge offsets relative to #view)
  // rather than a raw page-pixel position. A caller persisting position
  // across a panel rebuild (e.g. a file change, which can shift #view's rect
  // through the reload's own transient layout changes before the rebuilt
  // widget gets a chance to re-float) needs the SAME view-relative tracking
  // floatAt already gets via captureAnchor/applyAnchor — restoring raw
  // left/top instead would target wherever #view happened to be at capture
  // time, not the current #view, drifting a little further off on every
  // rebuild even though nothing about the bar's placement actually changed.
  function floatAtAnchor(savedAnchor) {
    if (!savedAnchor) return;
    beginFloating();
    anchor = savedAnchor;
    applyAnchor();
    onFloatChange?.(true);
  }

  // Shared pointerdown gesture: `handle` is whichever element the press
  // started on (the grip, or one of extraHandles like the gradient bar
  // itself) — that's the element pointer capture is (re-)acquired on and the
  // one the pointermove/up listeners live on for the rest of the gesture.
  function onHandlePointerDown(handle, e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // The wrapper is the floating bar's body drag surface. Its descendants
    // that are controls keep their own behavior, while the bar/legend
    // surfaces still reach their dedicated handle listeners below.
    if (handle === wrapper && e.target !== wrapper) {
      const target = e.target instanceof Element ? e.target : null;
      if (target && extraHandles.some((extra) => extra !== wrapper && extra.contains(target))) return;
      if (target?.closest('button, input, select, textarea, [contenteditable]:not([contenteditable="false"]), .cv-colorbar-menu')) return;
    }
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    if (!floating) {
      homeParent = wrapper.parentElement;
      homeNextSibling = wrapper.nextSibling;
    }
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic events cannot capture */ }

    let dragging = false;
    let grabDX = 0;
    let grabDY = 0;
    let liftedWidth = 0;
    let liftedHeight = 0;
    let finished = false;

    const startDrag = () => {
      dragging = true;
      const rect = wrapper.getBoundingClientRect();
      grabDX = startX - rect.left;
      grabDY = startY - rect.top;
      liftedWidth = rect.width;
      liftedHeight = rect.height;
      if (!floating) {
        document.body.appendChild(wrapper);
        wrapper.style.position = 'fixed';
        raise();
        wrapper.style.width = `${liftedWidth}px`;
        wrapper.style.left = `${rect.left}px`;
        wrapper.style.top = `${rect.top}px`;
        // Reparenting mid-gesture can silently drop pointer capture in some
        // engines even though the node stays connected — re-acquire it so
        // the rest of the drag keeps reaching this handler regardless of
        // what's now under the cursor.
        try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic events cannot capture */ }
      }
      wrapper.classList.add('cv-colorbar-dragging');
    };

    const onMove = (mv) => {
      if (!dragging) {
        if (Math.hypot(mv.clientX - startX, mv.clientY - startY) < DRAG_THRESHOLD) return;
        startDrag();
      }
      const snapped = snapToOtherBars(mv.clientX - grabDX, mv.clientY - grabDY, liftedWidth, liftedHeight);
      wrapper.style.left = `${snapped.left}px`;
      wrapper.style.top = `${snapped.top}px`;
      const over = isOverScene(mv.clientX, mv.clientY);
      document.getElementById('view')?.classList.toggle('cv-drop-hover', over);
    };

    const onUp = (up) => {
      cleanup();
      if (!dragging) return; // plain click on the handle: no-op

      wrapper.classList.remove('cv-colorbar-dragging');
      const snapped = snapToOtherBars(up.clientX - grabDX, up.clientY - grabDY, liftedWidth, liftedHeight);

      if (isOverScene(up.clientX, up.clientY)) {
        floatAt(snapped.left, snapped.top);
      } else if (floating) {
        dockBack();
      } else {
        // Lifted but released outside the scene: snap back home.
        wrapper.style.position = '';
        wrapper.style.left = '';
        wrapper.style.top = '';
        wrapper.style.width = '';
        wrapper.style.zIndex = '';
        if (homeNextSibling && homeNextSibling.parentElement === homeParent) {
          homeParent.insertBefore(wrapper, homeNextSibling);
        } else {
          homeParent.appendChild(wrapper);
        }
      }
    };

    const cleanup = () => {
      if (finished) return;
      finished = true;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.getElementById('view')?.classList.remove('cv-drop-hover');
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (activeAbort === abort) activeAbort = null;
    };

    const abort = (pointerId) => {
      if (pointerId !== undefined && pointerId !== e.pointerId) return;
      if (finished) return;
      cleanup();
      wrapper.classList.remove('cv-colorbar-dragging');
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    activeAbort = abort;
  }

  grip?.addEventListener('pointerdown', (e) => onHandlePointerDown(grip, e));
  extraHandles.forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => onHandlePointerDown(handle, e));
  });

  // Raises on ANY interaction while floating (typing in Min/Max, opening the
  // menu, resizing — not just a drag gesture), mirroring PanelWindow.js's own
  // "pointerdown anywhere in the panel raises it". Capture phase, not
  // bubble: Min/Max's own pointerdown handler (ColorBarWidget.js)
  // deliberately stopPropagation()s so the drag handle on barOuter doesn't
  // steal their click-to-focus — that would also block a bubble-phase
  // listener here from ever seeing the event. Capture fires on the way
  // down, before any descendant gets a chance to stop it.
  wrapper.addEventListener('pointerdown', () => { if (floating) raise(); }, true);

  // #view resizes (and, via its flex:1 layout, moves) whenever a side panel
  // docks/undocks/resizes or the browser window itself resizes — anything
  // that would otherwise leave a floated bar's page-pixel position stranded
  // relative to the structure. A ResizeObserver on #view covers all of those
  // in one place, since every one of them changes #view's own box.
  const view = document.getElementById('view');
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => applyAnchor()) : null;
  if (view && resizeObserver) resizeObserver.observe(view);
  // Belt-and-braces: a window resize where #view's box happens not to change
  // (unusual, but not impossible depending on layout) still re-derives from
  // the anchor rather than leaving stale left/top in place.
  window.addEventListener('resize', applyAnchor);

  return {
    isFloating: () => floating,
    getFloatPos: () => (floating ? { left: parseFloat(wrapper.style.left), top: parseFloat(wrapper.style.top) } : null),
    getAnchor: () => (floating ? anchor : null),
    floatAt,
    floatAtAnchor,
    // Re-derive left/top from the already-captured anchor after the caller
    // changed the wrapper's own size (e.g. ColorBarWidget.js's resize
    // handle) — just the anchor math, not floatAt's full re-float (which
    // reparents to body, resets width, and fires onFloatChange, expensive
    // enough that calling it from every pointermove of a drag was the
    // resize handle's main source of lag).
    reapplyAnchor: () => { if (floating) applyAnchor(); },
    // Re-captures the anchor from the wrapper's CURRENT on-screen position —
    // for a caller (ColorBarWidget.js's resize handle) that moved the
    // wrapper itself outside the normal floatAt/applyAnchor path (pinning
    // its own corner explicitly during a resize drag, since the anchor's
    // edge — whichever of #view's edges was closer at drop time — isn't
    // necessarily the corner the resize handle keeps fixed). Without this,
    // the next #view resize (ResizeObserver/applyAnchor) would re-derive
    // position from the stale pre-resize anchor and visibly jump.
    recaptureAnchor: () => { if (floating) captureAnchor(); },
    abortPointer: (pointerId) => activeAbort?.(pointerId),
    dockBack,
    destroy: () => {
      activeAbort?.();
      window.removeEventListener('resize', applyAnchor);
      resizeObserver?.disconnect();
    },
  };
}
