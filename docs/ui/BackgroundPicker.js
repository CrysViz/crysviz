// Scene background color picker.
// `createBackgroundControl` wires the "backgroundDot" element to open a color
// picker that live-previews and applies the three.js scene background (and keeps
// the lattice color readable). The theme system itself lives in
// ui/ThemeManager.js; the picker's Reset restores the active theme's scene color
// via `applySceneFromCSS`.

import * as THREE from '../external/three/three.module.js';
import { app, general } from '../state/store.js';
import { applySceneFromCSS } from './ThemeManager.js';
import { createColorPicker } from './ColorPickerModule.js';
import { updateLattice } from '../render/index.js';
import { captureAnchor, clampToScene, getViewRect, positionFromAnchor } from './GizmoLayout.js';
import { wireLockedWidgetForwarding } from './GizmoPointerForward.js';
import { wireLongPress } from '../utils/index.js';

const DEFAULT_DOT_SIZE = 54;
const MIN_DOT_SIZE = 36;
const MAX_DOT_SIZE = DEFAULT_DOT_SIZE * 3;
const DRAG_THRESHOLD = 4;

export function getLuminance(hex) {
  const c = hex.startsWith("#") ? hex.substring(1) : hex;
  const r = parseInt(c.substring(0, 2), 16) / 255;
  const g = parseInt(c.substring(2, 4), 16) / 255;
  const b = parseInt(c.substring(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function getContrastingBorder(hex) {
  const lum = getLuminance(hex);
  return lum > 0.5 ? "#333333" : "#ffffff";
}

/** Repaint the Visual window's background swatch from the current scene
 *  background, so it mirrors changes made anywhere (canvas dot, Apply, theme,
 *  Reset) — not just when the swatch itself was clicked. */
export function syncBackgroundSwatch() {
  const swatch = document.getElementById('backgroundSwatch');
  if (swatch && app?.scene?.background) {
    swatch.style.background = '#' + app.scene.background.getHexString();
  }
}

// The dot that currently owns an open picker (null = none). Clicking the same
// dot again closes its picker instead of rebuilding an identical one in place.
let activePicker = null;

function positionPickerPanel(dot, pickerPanel) {
  const rect = dot.getBoundingClientRect();
  const gap = 6;
  let topPosition = rect.bottom + window.scrollY + gap;
  const bottomSpace = window.innerHeight - (rect.bottom + window.scrollY + gap + pickerPanel.offsetHeight);
  if (bottomSpace < 40) topPosition = window.innerHeight - pickerPanel.offsetHeight - 65;

  // Keep the panel on screen for anchors near the left edge (the Visual
  // window's swatch sits in the dock column).
  pickerPanel.style.left = `${Math.max(8, rect.left + window.scrollX - 200)}px`;
  pickerPanel.style.top = `${topPosition}px`;
}

function openBackgroundColorPicker(dot) {
  if (activePicker) {
    const reopeningSameDot = activePicker.dot === dot;
    activePicker.close();
    if (reopeningSameDot) return; // second click on the same dot: just close
  }
  document.querySelectorAll(".spin-color-picker").forEach(p => p.remove());
  let currentHex = app.scene.background ? "#" + app.scene.background.getHexString() : "#090A09";
  let selectedHex = currentHex;

  const pickerPanel = document.createElement("div");
  pickerPanel.className = "spin-color-picker cv-background-picker-panel";

  const { element: pickerElement } = createColorPicker(currentHex, (hex) => {
    selectedHex = hex;
    const contrastColor = getContrastingBorder(selectedHex);
    dot.style.border = `2px solid ${contrastColor}`;
    general.currentLatticeColor = contrastColor;
    updateLattice(contrastColor);
    if (app?.scene) app.scene.background = new THREE.Color(hex);
    // Mirror the change onto the Visual swatch regardless of which dot opened
    // the picker (canvas dot or the swatch itself).
    syncBackgroundSwatch();
  });

  const buttonRow = document.createElement("div");
  buttonRow.className = "cv-background-picker-buttons";

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'reset-btn cv-background-picker-btn';
  resetBtn.style.background = general.defaultBackgroundColor;

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight cv-background-picker-btn';

  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);
  pickerPanel.appendChild(pickerElement);
  pickerPanel.appendChild(buttonRow);
  document.body.appendChild(pickerPanel);

  positionPickerPanel(dot, pickerPanel);

  const closePicker = () => {
    pickerPanel.remove();
    document.removeEventListener("mousedown", outsideClick);
    if (activePicker && activePicker.dot === dot) activePicker = null;
  };

  const outsideClick = (e) => {
    if (!pickerPanel.contains(e.target) && e.target !== dot) closePicker();
  };
  document.addEventListener("mousedown", outsideClick);
  pickerPanel.addEventListener("mousedown", (e) => e.stopPropagation());
  activePicker = {
    dot,
    close: closePicker,
    reposition: () => positionPickerPanel(dot, pickerPanel),
  };

  applyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`;
    if (app?.scene) app.scene.background = new THREE.Color(selectedHex);
    syncBackgroundSwatch();
    closePicker();
  });

  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePicker();
    // Restore the scene background to the active theme's default.
    applySceneFromCSS();
  });
}

export function createBackgroundControl() {
  const dot = document.getElementById("backgroundDot");
  if (!dot) {
    console.error("No element found with ID 'backgroundDot'");
    return;
  }
  // Position/z-index/border-radius/cursor already come from the .background-dot
  // class (index.html, styles/styles.css); the interaction styling and gizmo
  // handle are added in styles/sceneWidgets.css.
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'background-dot-resize-handle';
  resizeHandle.title = 'Drag to resize';
  dot.appendChild(resizeHandle);

  const menuWrap = document.createElement('div');
  menuWrap.className = 'cv-colorbar-menu-host background-dot-menu-wrap';
  const menu = document.createElement('div');
  menu.className = 'cv-colorbar-menu';
  const resetItem = document.createElement('button');
  resetItem.type = 'button';
  resetItem.className = 'cv-colorbar-menu-item';
  resetItem.textContent = 'Reset Layout';
  menu.appendChild(resetItem);
  const lockItem = document.createElement('button');
  lockItem.type = 'button';
  lockItem.className = 'cv-colorbar-menu-item';
  menu.appendChild(lockItem);
  menuWrap.appendChild(menu);
  document.body.appendChild(menuWrap);

  const closeMenu = () => menu.classList.remove('cv-colorbar-menu-open');
  const updateLockState = () => {
    lockItem.textContent = general.backgroundDotLocked ? 'Unlock' : 'Lock';
    lockItem.classList.toggle('cv-colorbar-menu-item-active', general.backgroundDotLocked);
    dot.classList.toggle('background-dot-locked', general.backgroundDotLocked);
  };
  updateLockState();
  const openMenuAt = (x, y) => {
    updateLockState();
    menu.classList.add('cv-colorbar-menu-open');
    const view = getViewRect();
    const rect = menu.getBoundingClientRect();
    const left = view ? Math.min(Math.max(x, view.left + 4), view.right - rect.width - 4) : x;
    const top = view ? Math.min(Math.max(y, view.top + 4), view.bottom - rect.height - 4) : y;
    menuWrap.style.left = `${left}px`;
    menuWrap.style.top = `${top}px`;
  };
  const onMenuPointerDown = (event) => {
    if (!menuWrap.contains(/** @type {Node} */ (event.target))) closeMenu();
  };
  const onMenuClick = (event) => {
    if (!menuWrap.contains(/** @type {Node} */ (event.target))) closeMenu();
  };
  const onMenuKeyDown = (event) => {
    if (event.key === 'Escape') closeMenu();
  };
  document.addEventListener('pointerdown', onMenuPointerDown);
  document.addEventListener('click', onMenuClick);
  document.addEventListener('keydown', onMenuKeyDown);
  menuWrap.addEventListener('pointerdown', (event) => event.stopPropagation());

  const applyDotSize = (size) => {
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    activePicker?.reposition();
  };
  const applyDotAnchor = () => {
    const position = positionFromAnchor(dot, general.backgroundDotPos);
    if (!position) return;
    dot.style.left = `${position.left}px`;
    dot.style.top = `${position.top}px`;
    dot.style.right = 'auto';
    dot.style.bottom = 'auto';
    activePicker?.reposition();
  };
  const resetDotLayout = () => {
    general.backgroundDotPos = null;
    general.backgroundDotSize = null;
    dot.style.left = '';
    dot.style.top = '';
    dot.style.right = '';
    dot.style.bottom = '';
    dot.style.width = '';
    dot.style.height = '';
    activePicker?.reposition();
  };
  resetItem.addEventListener('click', (event) => {
    event.stopPropagation();
    resetDotLayout();
    closeMenu();
  });
  lockItem.addEventListener('click', (event) => {
    event.stopPropagation();
    general.backgroundDotLocked = !general.backgroundDotLocked;
    abortActiveGesture?.();
    abortResize?.();
    abortForwardedGestures?.abortAll?.();
    updateLockState();
    closeMenu();
  });

  if (general.backgroundDotSize != null) applyDotSize(general.backgroundDotSize);
  if (general.backgroundDotPos) applyDotAnchor();

  let abortActiveGesture = null;
  let abortForwardedGestures = null;
  let suppressNextClick = false;
  const bindDrag = () => {
    dot.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.target !== dot) return;
      if (general.backgroundDotLocked) return;
      suppressNextClick = false;
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      let grabDX = 0;
      let grabDY = 0;
      let finished = false;

      try { dot.setPointerCapture(event.pointerId); } catch { /* synthetic events cannot capture */ }

      const onMove = (move) => {
        if (general.backgroundDotLocked) {
          abort(event.pointerId);
          return;
        }
        if (!dragging) {
          if (Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD) return;
          dragging = true;
          suppressNextClick = true;
          event.preventDefault();
          const rect = dot.getBoundingClientRect();
          grabDX = startX - rect.left;
          grabDY = startY - rect.top;
          dot.classList.add('background-dot-dragging');
          dot.style.right = 'auto';
          dot.style.bottom = 'auto';
        }
        const size = dot.offsetWidth;
        const position = clampToScene(move.clientX - grabDX, move.clientY - grabDY, size, size);
        dot.style.left = `${position.left}px`;
        dot.style.top = `${position.top}px`;
        activePicker?.reposition();
      };
      const cleanup = () => {
        if (finished) return;
        finished = true;
        dot.removeEventListener('pointermove', onMove);
        dot.removeEventListener('pointerup', onUp);
        dot.removeEventListener('pointercancel', onUp);
        try { dot.releasePointerCapture(event.pointerId); } catch { /* already released */ }
        if (abortActiveGesture === abort) abortActiveGesture = null;
      };
      const onUp = () => {
        cleanup();
        if (!dragging) return;
        dot.classList.remove('background-dot-dragging');
        general.backgroundDotPos = captureAnchor(dot);
      };
      const abort = (pointerId) => {
        if ((pointerId !== undefined && pointerId !== event.pointerId) || finished) return;
        cleanup();
        dot.classList.remove('background-dot-dragging');
      };
      dot.addEventListener('pointermove', onMove);
      dot.addEventListener('pointerup', onUp);
      dot.addEventListener('pointercancel', onUp);
      abortActiveGesture = abort;
    });
  };
  bindDrag();
  abortForwardedGestures = wireLockedWidgetForwarding(dot, () => general.backgroundDotLocked, {
    ignoreSelector: '.background-dot-resize-handle',
    onPromote: () => { suppressNextClick = true; },
  });

  let abortResize = null;
  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (general.backgroundDotLocked) return;
    event.preventDefault();
    event.stopPropagation();
    suppressNextClick = true;
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = dot.offsetWidth || DEFAULT_DOT_SIZE;
    const startRect = dot.getBoundingClientRect();
    const view = getViewRect();
    const maxByView = view ? Math.min(view.right - startRect.left, view.bottom - startRect.top) : MAX_DOT_SIZE;
    const maxSize = Math.min(MAX_DOT_SIZE, maxByView);
    let finished = false;

    dot.style.left = `${startRect.left}px`;
    dot.style.top = `${startRect.top}px`;
    dot.style.right = 'auto';
    dot.style.bottom = 'auto';
    try { resizeHandle.setPointerCapture(event.pointerId); } catch { /* synthetic events cannot capture */ }

    const onMove = (move) => {
      if (general.backgroundDotLocked) {
        abort(event.pointerId);
        return;
      }
      const delta = Math.max(move.clientX - startX, move.clientY - startY);
      applyDotSize(Math.min(Math.max(startSize + delta, MIN_DOT_SIZE), maxSize));
    };
    const cleanup = () => {
      if (finished) return;
      finished = true;
      resizeHandle.removeEventListener('pointermove', onMove);
      resizeHandle.removeEventListener('pointerup', onUp);
      resizeHandle.removeEventListener('pointercancel', onUp);
      try { resizeHandle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      if (abortResize === abort) abortResize = null;
    };
    const onUp = () => {
      cleanup();
      general.backgroundDotSize = dot.offsetWidth;
      general.backgroundDotPos = captureAnchor(dot);
      // Consume only the compatibility click belonging to this resize. If a
      // browser emits no click for the moved pointer, do not leave the next
      // deliberate dot click suppressed.
      setTimeout(() => { suppressNextClick = false; }, 0);
    };
    const abort = (pointerId) => {
      if ((pointerId !== undefined && pointerId !== event.pointerId) || finished) return;
      cleanup();
    };
    resizeHandle.addEventListener('pointermove', onMove);
    resizeHandle.addEventListener('pointerup', onUp);
    resizeHandle.addEventListener('pointercancel', onUp);
    abortResize = abort;
    abortActiveGesture = abort;
  });

  wireLongPress(dot, ({ clientX, clientY }) => openMenuAt(clientX, clientY), {
    ignoreSelector: '.background-dot-resize-handle',
    onFire: ({ pointerId }) => {
      abortActiveGesture?.(pointerId);
      abortResize?.(pointerId);
      abortForwardedGestures?.abortPointer(pointerId);
    },
  });

  dot.addEventListener("click", (event) => {
    if (event.target === resizeHandle || suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    openBackgroundColorPicker(dot);
  });

  const reapply = () => {
    if (general.backgroundDotPos) applyDotAnchor();
    else activePicker?.reposition();
  };
  const view = document.getElementById('view');
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reapply) : null;
  if (view && resizeObserver) resizeObserver.observe(view);
  window.addEventListener('resize', reapply);
}

/** Show/hide the on-canvas picker dot (the Visual window's toggle). */
export function setBackgroundDotVisible(visible) {
  const dot = document.getElementById('backgroundDot');
  if (dot) dot.style.display = visible ? '' : 'none';
}

export function isBackgroundDotVisible() {
  const dot = document.getElementById('backgroundDot');
  return !!dot && dot.style.display !== 'none';
}

/** A small round swatch button that opens the same background color picker,
 *  for use inside a panel body (Visual window). Its fill tracks the picked
 *  scene background. */
export function createBackgroundSwatch() {
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.id = 'backgroundSwatch';
  dot.title = 'Pick background color';
  dot.dataset.bgSwatch = '1';
  dot.className = 'cv-background-swatch';
  const syncFill = () => {
    if (app?.scene?.background) dot.style.background = '#' + app.scene.background.getHexString();
  };
  syncFill();
  dot.addEventListener('click', () => {
    syncFill(); // the background may have changed via the canvas dot or theme
    openBackgroundColorPicker(dot);
  });
  return dot;
}
