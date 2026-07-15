// Makes the axes gizmo (#axesGizmo + #axesLegend, built by
// WindowAndSceneControls.initAxesGizmo) draggable anywhere over the 3D
// scene, and adds a small hamburger menu for the "labels on arrows" toggle.
// Mirrors the drag mechanics of ui/ColorBarDrag.js (edge anchor relative to
// #view, pointer-capture drag-threshold gesture) but simpler: the gizmo has
// no docked/floating distinction to switch between, it's always an overlay
// positioned by CSS custom properties (--gizmo-left/--gizmo-bottom) until
// the user drags it, at which point inline left/top styles (which win over
// those CSS rules) take over.

import { general } from '../state/store.js';
import { setGizmoLabelsOnArrows, resizeGizmoRenderer } from './WindowAndSceneControls.js';
import { currentContrastColor } from './ColorBarWidget.js';

const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag
const STRIP_GAP = 8; // gizmo top edge -> bottom of the hover-revealed strip
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
// #axesGizmo has pointer-events:none (deliberately — clicks pass through to
// rotate the scene behind it), so it can never receive its own hover events;
// this padding extends the "still counts as hovering" zone below the strip
// so hovering the box itself (checked via plain coordinate math, not CSS
// :hover) reveals the strip above it, with no dead gap between the two.
const HOVER_BRIDGE = 4;

function viewRect() {
  const view = document.getElementById('view');
  return view ? view.getBoundingClientRect() : null;
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

// Position remembered as an offset from the nearest edge of #view (same
// scheme as ColorBarDrag.js) rather than a raw page-pixel position, so it
// keeps tracking the same relative spot as #view resizes (side panel
// docking, window resize) instead of drifting.
function captureAnchor(gizmoDiv) {
  const rect = viewRect();
  if (!rect) return null;
  const gRect = gizmoDiv.getBoundingClientRect();
  const leftGap = gRect.left - rect.left;
  const rightGap = rect.right - gRect.right;
  const topGap = gRect.top - rect.top;
  const bottomGap = rect.bottom - gRect.bottom;
  return {
    edgeX: leftGap <= rightGap ? 'left' : 'right',
    offsetX: leftGap <= rightGap ? leftGap : rightGap,
    edgeY: topGap <= bottomGap ? 'top' : 'bottom',
    offsetY: topGap <= bottomGap ? topGap : bottomGap,
  };
}

function positionFromAnchor(gizmoDiv, anchor) {
  const rect = viewRect();
  if (!rect || !anchor) return null;
  const width = gizmoDiv.offsetWidth;
  const height = gizmoDiv.offsetHeight;
  const left = anchor.edgeX === 'left' ? rect.left + anchor.offsetX : rect.right - anchor.offsetX - width;
  const top = anchor.edgeY === 'top' ? rect.top + anchor.offsetY : rect.bottom - anchor.offsetY - height;
  return clampToScene(left, top, width, height);
}

/** Wire up dragging + the layout menu for the axes gizmo. Call once at
 *  startup, after WindowAndSceneControls.initAxesGizmo has built the gizmo
 *  canvas (so #axesGizmo/#axesLegend exist in the DOM). */
export function initGizmoDrag() {
  const gizmoDiv = document.getElementById('axesGizmo');
  const legendDiv = document.getElementById('axesLegend');
  if (!gizmoDiv) return;

  // The drag grip + hamburger menu live in their own body-level overlay
  // rather than as children of #axesGizmo: that box has overflow:hidden (it
  // clips the WebGL canvas to its rounded corners), which would also clip
  // the menu dropdown the instant it opened below the box. Reuses the color
  // bars' generic chrome classes (ui/ColorBarWidget.js / toggle_styles.css)
  // for the button/dropdown look rather than duplicating that CSS for a
  // second widget; only the wrapper/positioning classes are gizmo-specific,
  // since the color bars' equivalent wrapper class is hidden by default (it
  // only shows once a bar is undocked, a state the gizmo doesn't have).
  const controls = document.createElement('div');
  controls.className = 'cv-gizmo-controls';

  const grip = document.createElement('span');
  grip.className = 'cv-colorbar-grip';
  grip.textContent = '⦀';
  grip.title = 'Drag to reposition';
  controls.appendChild(grip);

  const menuWrap = document.createElement('div');
  menuWrap.className = 'cv-gizmo-menu-wrap';
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'cv-colorbar-menu-btn';
  menuBtn.title = 'Gizmo options';
  menuBtn.textContent = '☰';
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
  menuWrap.appendChild(menuBtn);
  menuWrap.appendChild(menu);
  controls.appendChild(menuWrap);

  document.body.appendChild(controls);

  // Resize handle: a child of #axesGizmo itself (not a body-level overlay
  // like `controls` above) — it sits fully within the box's own bounds, so
  // #axesGizmo's overflow:hidden (which forced the menu dropdown out to a
  // separate element) never clips it. #axesGizmo has pointer-events:none
  // (clicks pass through to rotate the scene), so this needs its own
  // pointer-events:auto (styles.css) the same way the menu/grip did before
  // they moved out.
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'cv-gizmo-resize-handle';
  resizeHandle.title = 'Drag to resize';
  gizmoDiv.appendChild(resizeHandle);

  // Keeps the (independently-positioned) controls overlay pinned just above
  // the gizmo, centered over it and matching its current width — same
  // "titlebar" placement the floating color bars use (styles/toggle_styles.css's
  // .cv-colorbar-floating .cv-colorbar-controls), wherever the gizmo
  // currently sits or however big ui/GizmoDrag.js's resize handle has made it.
  function positionControls() {
    const gRect = gizmoDiv.getBoundingClientRect();
    controls.style.left = `${gRect.left + gRect.width / 2}px`;
    controls.style.top = `${gRect.top - STRIP_GAP}px`;
    controls.style.width = `${gRect.width}px`;
  }

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
    positionControls();
    positionLegend();
  }

  // Hover-reveal, like a floating color bar's controls strip: hidden until
  // the pointer is over the gizmo box or the strip itself, so it doesn't sit
  // permanently on top of the 3D view. Driven by plain coordinate checks
  // against a document-level pointermove rather than CSS :hover, since
  // #axesGizmo's own pointer-events:none means it never fires hover events,
  // and the strip is a separate body-level element (not a CSS-adjacent
  // sibling #axesGizmo could reveal via a sibling selector either way — see
  // the overflow:hidden comment above).
  let hovering = false;
  let forcedVisible = false;
  function applyVisibility() {
    const visible = hovering || forcedVisible;
    controls.classList.toggle('cv-gizmo-controls-visible', visible);
    resizeHandle.classList.toggle('cv-gizmo-resize-handle-visible', visible);
  }
  function checkHover(x, y) {
    const gRect = gizmoDiv.getBoundingClientRect();
    const cRect = controls.getBoundingClientRect();
    const overGizmo = x >= gRect.left && x <= gRect.right
      && y >= gRect.top - HOVER_BRIDGE && y <= gRect.bottom;
    const overStrip = x >= cRect.left && x <= cRect.right && y >= cRect.top && y <= cRect.bottom;
    const next = overGizmo || overStrip;
    if (next !== hovering) {
      hovering = next;
      applyVisibility();
    }
  }
  document.addEventListener('pointermove', (e) => checkHover(e.clientX, e.clientY));
  // Stays visible while actively dragging or with the menu open, regardless
  // of exactly where the pointer strays mid-gesture.
  function setForcedVisible(value) {
    forcedVisible = value;
    applyVisibility();
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
    setForcedVisible(false);
  }
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !menu.classList.contains('cv-colorbar-menu-open');
    menu.classList.toggle('cv-colorbar-menu-open', opening);
    setForcedVisible(opening);
  });
  document.addEventListener('click', (e) => {
    if (!menuWrap.contains(/** @type {Node} */ (e.target))) closeMenu();
  });
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

  // Shared by the grip AND #axesGizmo itself (bound to both below) — the
  // whole box is a drag handle now, not just the ⦀ grip, so repositioning
  // doesn't require hovering to reveal the strip first and aiming for a
  // small target inside it.
  function bindDragHandle(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      handle.setPointerCapture(e.pointerId);

      let dragging = false;
      let grabDX = 0;
      let grabDY = 0;

      const onMove = (mv) => {
        if (!dragging) {
          if (Math.hypot(mv.clientX - startX, mv.clientY - startY) < DRAG_THRESHOLD) return;
          dragging = true;
          const rect = gizmoDiv.getBoundingClientRect();
          grabDX = startX - rect.left;
          grabDY = startY - rect.top;
          gizmoDiv.classList.add('cv-gizmo-dragging');
          setForcedVisible(true);
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
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        if (!dragging) return;
        gizmoDiv.classList.remove('cv-gizmo-dragging');
        general.gizmoPos = captureAnchor(gizmoDiv);
        setForcedVisible(false);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }
  bindDragHandle(grip);
  bindDragHandle(gizmoDiv);

  resizeHandle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeHandle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = gizmoDiv.offsetWidth;
    const startRect = gizmoDiv.getBoundingClientRect();
    const rect = viewRect();
    // Square stays anchored at its current top-left corner — only the
    // bottom-right one moves — so growth is capped by #view's own edges,
    // same as the drag-to-reposition gesture stays clamped to them.
    const maxByView = rect ? Math.min(rect.right - startRect.left, rect.bottom - startRect.top) : MAX_GIZMO_SIZE;
    const maxSize = Math.min(MAX_GIZMO_SIZE, maxByView);
    setForcedVisible(true);
    gizmoDiv.classList.add('cv-gizmo-dragging');

    const onMove = (mv) => {
      const delta = Math.max(mv.clientX - startX, mv.clientY - startY);
      const size = Math.min(Math.max(startSize + delta, MIN_GIZMO_SIZE), maxSize);
      applySize(size);
    };
    const onUp = () => {
      resizeHandle.removeEventListener('pointermove', onMove);
      resizeHandle.removeEventListener('pointerup', onUp);
      resizeHandle.removeEventListener('pointercancel', onUp);
      gizmoDiv.classList.remove('cv-gizmo-dragging');
      general.gizmoSize = gizmoDiv.offsetWidth;
      setForcedVisible(false);
    };
    resizeHandle.addEventListener('pointermove', onMove);
    resizeHandle.addEventListener('pointerup', onUp);
    resizeHandle.addEventListener('pointercancel', onUp);
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
