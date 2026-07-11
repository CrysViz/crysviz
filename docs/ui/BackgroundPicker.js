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

/** Whichever dot (canvas dot or Visual-window swatch) currently has the
 *  picker open, and how to close it — so a second click of that same dot
 *  toggles the picker closed instead of just tearing it down and rebuilding
 *  an identical one in place. */
let activePicker = null;

function openBackgroundColorPicker(dot) {
  if (activePicker) {
    const reopeningSameDot = activePicker.dot === dot;
    activePicker.close();
    if (reopeningSameDot) return;
  }
  let currentHex = app.scene.background ? "#" + app.scene.background.getHexString() : "#090A09";
  let selectedHex = currentHex;

  const pickerPanel = document.createElement("div");
  pickerPanel.className = "spin-color-picker";
  Object.assign(pickerPanel.style, {
    position: "absolute",
    background: "rgba(26,26,26,0.8)",
    border: "1px solid #ccc",
    padding: "10px",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    zIndex: 9999,
  });

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
  Object.assign(buttonRow.style, {
    display: "flex",
    justifyContent: "space-between",
    marginTop: "10px",
    gap: "8px"
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'reset-btn';
  resetBtn.style.cssText = 'height: 32px';
  resetBtn.style.background = general.defaultBackgroundColor;

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px';

  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);
  pickerPanel.appendChild(pickerElement);
  pickerPanel.appendChild(buttonRow);
  document.body.appendChild(pickerPanel);

  const rect = dot.getBoundingClientRect();
  let topPosition = rect.top + window.scrollY + 60;
  let bottomSpace = window.innerHeight - (rect.top + window.scrollY + 24 + pickerPanel.offsetHeight);
  if (bottomSpace < 40) topPosition = window.innerHeight - pickerPanel.offsetHeight - 65;

  // Keep the panel on screen for anchors near the left edge (the Visual
  // window's swatch sits in the dock column).
  pickerPanel.style.left = `${Math.max(8, rect.left + window.scrollX - 200)}px`;
  pickerPanel.style.top = `${topPosition}px`;

  const closePicker = () => {
    pickerPanel.remove();
    document.removeEventListener("mousedown", outsideClick);
    if (activePicker && activePicker.dot === dot) activePicker = null;
  };
  activePicker = { dot, close: closePicker };

  const outsideClick = (e) => {
    if (!pickerPanel.contains(e.target) && e.target !== dot) closePicker();
  };
  document.addEventListener("mousedown", outsideClick);
  pickerPanel.addEventListener("mousedown", (e) => e.stopPropagation());

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
  dot.style.position = "fixed";
  dot.style.zIndex = "999";
  dot.style.pointerEvents = "auto";
  dot.style.borderRadius = "50%";
  dot.style.cursor = "pointer";
  dot.addEventListener("click", () => openBackgroundColorPicker(dot));
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
  dot.style.cssText = 'width:26px; height:26px; border-radius:50%; cursor:pointer;'
    + ' border:2px solid rgba(255,255,255,0.5); padding:0; flex:none;';
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
