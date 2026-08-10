// Makes the axes gizmo (#axesGizmo + #axesLegend, built by
// WindowAndSceneControls.initAxesGizmo) draggable anywhere over the 3D
// scene, with a long-press menu for the "labels on arrows" toggle.
// Mirrors the drag mechanics of ui/ColorBarDrag.js (edge anchor relative to
// #view, pointer-capture drag-threshold gesture) but simpler: the gizmo has
// no docked/floating distinction to switch between, it's always an overlay
// positioned by CSS custom properties (--gizmo-left/--gizmo-bottom) until
// the user drags it, at which point inline left/top styles (which win over
// those CSS rules) take over.

import { general } from '../state/store.js';
import { setGizmoLabelsOnArrows, resizeGizmoRenderer } from './WindowAndSceneControls.js';
import { currentContrastColor } from './ColorBarWidget.js';
import { captureAnchor, clampToScene, getViewRect, positionFromAnchor } from './GizmoLayout.js';
import { wireLongPress } from '../utils/index.js';
import { requestRender, renderFrameNow } from '../render/index.js';

const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag
const MIN_GIZMO_SIZE = 50;
const MAX_GIZMO_SIZE = 260;
// The CSS default (--gizmo-size, theme.css) — the baseline applySize()'s
// scale factor for #axesLegend is relative to.
const DEFAULT_GIZMO_SIZE = 90;
// #axesLegend's own CSS defaults (styles.css), scaled by the same factor as
// the gizmo box so the legend grows/shrinks with it instead of staying a
// fixed size next to a bigger or smaller gizmo.
const LEGEND_BASE_FONT = 12;
const LEGEND_BASE_PAD_Y = 6;
const LEGEND_BASE_PAD_X = 8;
const LEGEND_BASE_RADIUS = 8;
const LEGEND_BASE_DOT = 10;
const LEGEND_BASE_GAP = 6;
/** Wire up dragging + the layout menu for the axes gizmo. Call once at
 *  startup, after WindowAndSceneControls.initAxesGizmo has built the gizmo
 *  canvas (so #axesGizmo/#axesLegend exist in the DOM). */
export function initGizmoDrag() {
  const gizmoDiv = document.getElementById('axesGizmo');
  const legendDiv = document.getElementById('axesLegend');
  if (!gizmoDiv) return;

  // Keep the menu outside the clipped WebGL box. It has no visible trigger:
  // a long press on the gizmo opens it at the press point.
  const menuWrap = document.createElement('div');
  menuWrap.className = 'cv-gizmo-menu-wrap';
  const menu = document.createElement('div');
  menu.className = 'cv-colorbar-menu';
  const menuLabels = document.createElement('button');
  menuLabels.type = 'button';
  menuLabels.className = 'cv-colorbar-menu-item';
  menuLabels.textContent = 'Integrate Labels';
  const menuReset = document.createElement('button');
  menuReset.type = 'button';
  menuReset.className = 'cv-colorbar-menu-item';
  menuReset.textContent = 'Reset';
  menu.appendChild(menuLabels);
  menu.appendChild(menuReset);
  menuWrap.appendChild(menu);
  document.body.appendChild(menuWrap);

  // The handle remains inside the clipped box; its hit zone is larger than
  // the visible corner mark.
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'cv-gizmo-resize-handle';
  resizeHandle.title = 'Drag to resize';
  gizmoDiv.appendChild(resizeHandle);

  // #axesLegend is a separate fixed-position element that normally tracks
  // the gizmo via CSS calc() against the same custom properties; once the
  // gizmo moves under inline styles that calc() no longer applies, so the
  // legend's own left/bottom have to be re-derived from the gizmo's actual
  // rect here.
  function positionLegend() {
    if (!legendDiv) return;
    const gRect = gizmoDiv.getBoundingClientRect();
    legendDiv.style.left = `${gRect.right + 8}px`;
    legendDiv.style.top = '';
    legendDiv.style.bottom = `${window.innerHeight - gRect.bottom}px`;
    // Some breakpoints (styles.css) nudge the legend with an extra
    // translateX() on top of `left`, tuned for the CSS default position —
    // once JS is driving `left` directly that extra shift would double up.
    legendDiv.style.transform = 'none';
  }

  // Scales #axesLegend's font/padding/dots to match the gizmo's current
  // size — its CSS is otherwise a fixed size regardless of how big
  // ui/GizmoDrag.js's resize handle has made the gizmo itself.
  function applyLegendScale(size) {
    if (!legendDiv) return;
    const scale = size / DEFAULT_GIZMO_SIZE;
    legendDiv.style.fontSize = `${LEGEND_BASE_FONT * scale}px`;
    legendDiv.style.padding = `${LEGEND_BASE_PAD_Y * scale}px ${LEGEND_BASE_PAD_X * scale}px`;
    legendDiv.style.borderRadius = `${LEGEND_BASE_RADIUS * scale}px`;
    legendDiv.querySelectorAll('.legend-row').forEach((row) => {
      row.style.gap = `${LEGEND_BASE_GAP * scale}px`;
    });
    legendDiv.querySelectorAll('.dot').forEach((dot) => {
      const dotSize = `${LEGEND_BASE_DOT * scale}px`;
      dot.style.width = dotSize;
      dot.style.height = dotSize;
    });
  }

  function syncOverlays() {
    positionLegend();
  }

  function applyAnchor(anchor) {
    const pos = positionFromAnchor(gizmoDiv, anchor);
    if (!pos) return;
    gizmoDiv.style.left = `${pos.left}px`;
    gizmoDiv.style.top = `${pos.top}px`;
    gizmoDiv.style.bottom = 'auto';
    syncOverlays();
  }

  function applySize(size) {
    gizmoDiv.style.width = `${size}px`;
    gizmoDiv.style.height = `${size}px`;
    resizeGizmoRenderer();
    applyLegendScale(size);
    syncOverlays();
  }

  function resetLayout() {
    general.gizmoPos = null;
    general.gizmoSize = null;
    gizmoDiv.style.left = '';
    gizmoDiv.style.top = '';
    gizmoDiv.style.bottom = '';
    gizmoDiv.style.width = '';
    gizmoDiv.style.height = '';
    resizeGizmoRenderer();
    if (legendDiv) {
      legendDiv.style.left = '';
      legendDiv.style.top = '';
      legendDiv.style.bottom = '';
      legendDiv.style.transform = '';
      legendDiv.style.fontSize = '';
      legendDiv.style.padding = '';
      legendDiv.style.borderRadius = '';
      legendDiv.querySelectorAll('.legend-row').forEach((row) => { row.style.gap = ''; });
      legendDiv.querySelectorAll('.dot').forEach((dot) => { dot.style.width = ''; dot.style.height = ''; });
    }
    syncOverlays();
  }

  function updateMenuState() {
    menuLabels.classList.toggle('cv-colorbar-menu-item-active', general.gizmoLabelsOnArrows);
  }
  updateMenuState();

  function closeMenu() {
    menu.classList.remove('cv-colorbar-menu-open');
  }
  function openMenuAt(x, y) {
    updateMenuState();
    menu.classList.add('cv-colorbar-menu-open');
    const view = getViewRect();
    const menuRect = menu.getBoundingClientRect();
    const left = view ? Math.min(Math.max(x, view.left + 4), view.right - menuRect.width - 4) : x;
    const top = view ? Math.min(Math.max(y, view.top + 4), view.bottom - menuRect.height - 4) : y;
    menuWrap.style.left = `${left}px`;
    menuWrap.style.top = `${top}px`;
  }
  const onMenuPointerDown = (e) => {
    if (!menuWrap.contains(/** @type {Node} */ (e.target))) closeMenu();
  };
  const onMenuClick = (e) => {
    if (!menuWrap.contains(/** @type {Node} */ (e.target))) closeMenu();
  };
  const onMenuKeyDown = (e) => {
    if (e.key === 'Escape') closeMenu();
  };
  document.addEventListener('pointerdown', onMenuPointerDown);
  document.addEventListener('click', onMenuClick);
  document.addEventListener('keydown', onMenuKeyDown);
  menuLabels.addEventListener('click', (e) => {
    e.stopPropagation();
    setGizmoLabelsOnArrows(!general.gizmoLabelsOnArrows);
    updateMenuState();
    closeMenu();
  });
  menuReset.addEventListener('click', (e) => {
    e.stopPropagation();
    resetLayout();
    closeMenu();
  });

  if (general.gizmoSize) {
    gizmoDiv.style.width = `${general.gizmoSize}px`;
    gizmoDiv.style.height = `${general.gizmoSize}px`;
    resizeGizmoRenderer();
    applyLegendScale(general.gizmoSize);
  }
  if (general.gizmoPos) {
    applyAnchor(general.gizmoPos);
  } else {
    syncOverlays();
  }

  // The whole box is the drag handle now, so repositioning does not require a
  // small visible control target.
  let abortActiveGesture = null;
  function bindDragHandle(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic events cannot capture */ }

      let dragging = false;
      let grabDX = 0;
      let grabDY = 0;
      let finished = false;

      const cleanup = () => {
        if (finished) return;
        finished = true;
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        if (abortActiveGesture === abort) abortActiveGesture = null;
      };

      const onMove = (mv) => {
        if (!dragging) {
          if (Math.hypot(mv.clientX - startX, mv.clientY - startY) < DRAG_THRESHOLD) return;
          dragging = true;
          const rect = gizmoDiv.getBoundingClientRect();
          grabDX = startX - rect.left;
          grabDY = startY - rect.top;
          gizmoDiv.classList.add('cv-gizmo-dragging');
        }
        const width = gizmoDiv.offsetWidth;
        const height = gizmoDiv.offsetHeight;
        const clamped = clampToScene(mv.clientX - grabDX, mv.clientY - grabDY, width, height);
        gizmoDiv.style.left = `${clamped.left}px`;
        gizmoDiv.style.top = `${clamped.top}px`;
        gizmoDiv.style.bottom = 'auto';
        syncOverlays();
      };

      const onUp = () => {
        cleanup();
        if (!dragging) return;
        gizmoDiv.classList.remove('cv-gizmo-dragging');
        general.gizmoPos = captureAnchor(gizmoDiv);
      };

      const abort = (pointerId) => {
        if (pointerId !== e.pointerId || finished) return;
        cleanup();
        gizmoDiv.classList.remove('cv-gizmo-dragging');
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
      abortActiveGesture = abort;
    });
  }
  bindDragHandle(gizmoDiv);
  wireLongPress(gizmoDiv, ({ clientX, clientY }) => openMenuAt(clientX, clientY), {
    ignoreSelector: '.cv-gizmo-resize-handle',
    onFire: ({ pointerId }) => abortActiveGesture?.(pointerId),
  });

  resizeHandle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { resizeHandle.setPointerCapture(e.pointerId); } catch { /* synthetic events cannot capture */ }
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = gizmoDiv.offsetWidth;
    const startRect = gizmoDiv.getBoundingClientRect();
    const rect = getViewRect();
    // Square stays anchored at its current top-left corner — only the
    // bottom-right one moves — so growth is capped by #view's own edges,
    // same as the drag-to-reposition gesture stays clamped to them.
    const maxByView = rect ? Math.min(rect.right - startRect.left, rect.bottom - startRect.top) : MAX_GIZMO_SIZE;
    const maxSize = Math.min(MAX_GIZMO_SIZE, maxByView);
    gizmoDiv.classList.add('cv-gizmo-dragging');
    let finished = false;

    const onMove = (mv) => {
      const delta = Math.max(mv.clientX - startX, mv.clientY - startY);
      const size = Math.min(Math.max(startSize + delta, MIN_GIZMO_SIZE), maxSize);
      applySize(size);
      // resizeGizmoRenderer clears the WebGL buffer; invalidate immediately so
      // the arrows and labels are painted during the live resize, not only on
      // pointerup.
      requestRender();
      renderFrameNow({ interactive: true });
    };
    const cleanup = () => {
      if (finished) return;
      finished = true;
      resizeHandle.removeEventListener('pointermove', onMove);
      resizeHandle.removeEventListener('pointerup', onUp);
      resizeHandle.removeEventListener('pointercancel', onUp);
      try { resizeHandle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (abortActiveGesture === abort) abortActiveGesture = null;
    };
    const onUp = () => {
      cleanup();
      gizmoDiv.classList.remove('cv-gizmo-dragging');
      general.gizmoSize = gizmoDiv.offsetWidth;
    };
    const abort = (pointerId) => {
      if (pointerId !== e.pointerId || finished) return;
      cleanup();
      gizmoDiv.classList.remove('cv-gizmo-dragging');
    };
    resizeHandle.addEventListener('pointermove', onMove);
    resizeHandle.addEventListener('pointerup', onUp);
    resizeHandle.addEventListener('pointercancel', onUp);
    abortActiveGesture = abort;
  });

  const view = document.getElementById('view');
  const reapply = () => {
    if (general.gizmoPos) applyAnchor(general.gizmoPos);
    else syncOverlays();
  };
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reapply) : null;
  if (view && resizeObserver) resizeObserver.observe(view);
  window.addEventListener('resize', reapply);

  // Keeps #axesGizmo's `color` matched to the same contrast-safe color the
  // floating color bars' tick labels track (ColorBarWidget.js's
  // currentContrastColor(), against general.currentLatticeColor) — the
  // resize handle's bracket (styles.css) reads it via currentColor. Unlike
  // the color bars this has no floating/docked toggle to start/stop the
  // poll around: the gizmo is always on screen, so this just runs for the
  // app's lifetime, same as the resize/pointermove listeners above it.
  (function syncGizmoContrast() {
    gizmoDiv.style.color = currentContrastColor() || '';
    requestAnimationFrame(syncGizmoContrast);
  })();
}
