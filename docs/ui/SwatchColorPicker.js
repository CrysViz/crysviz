// SwatchColorPicker.js
//
// A small clickable color swatch that opens the app's custom color picker
// (docs/ui/ColorPickerModule.js) in a small floating panel next to it,
// mirroring how the scene background color is picked (see
// docs/ui/BackgroundPicker.js's openBackgroundColorPicker) - rather than the
// browser's native <input type="color"> dialog. Used by the atom-table color
// column (AtomTableInput.js) and the Custom User Settings color/periodic
// table picker (CustomUserSettingsPanel.js).

import { createColorPicker } from './ColorPickerModule.js';

// Higher than periodic-table popups (1300) and floating panels (1200), so it
// always sits on top regardless of which panel it was opened from.
const Z_INDEX = 1400;

// The picker currently open (null = none). Clicking the same anchor again
// closes it instead of rebuilding an identical one in place.
let activePicker = null;

// openSwatchColorPicker(anchor, hex, onChange, { onReset }) - anchor is any
// element the picker positions itself next to; its .style.background and
// .dataset.hex are kept in sync as the color changes (harmless/useful
// whether anchor is a plain swatch button or an element tile in a periodic
// table). Pass onReset(closePanel) when the caller has a "default" to revert
// to (e.g. an element-color override) - it adds a Reset button; omit it for
// callers with no such concept (e.g. a plain atom-row swatch).
//
/**
* @param {HTMLElement} anchor
* @param {string|number} hex
* @param {(hex: string) => void} onChange
* @param {{onReset?: () => void}} options
*/
export function openSwatchColorPicker(anchor, hex, onChange, { onReset } = {}) {
  if (activePicker) {
    const reopeningSame = activePicker.anchor === anchor;
    activePicker.close();
    if (reopeningSame) return;
  }

  const panel = document.createElement('div');
  panel.className = 'swatch-color-picker';
  panel.style.cssText = `
    position: fixed;
    background: rgba(26,26,26,0.95);
    border: 1px solid #ccc;
    padding: 10px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    z-index: ${Z_INDEX};
  `;

  const { element: pickerElement } = createColorPicker(hex, (newHex) => {
    anchor.style.background = newHex;
    anchor.dataset.hex = newHex;
    onChange(newHex);
  });

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; gap: 6px; margin-top: 8px;';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.className = 'btn-mini highlight';
  closeBtn.style.cssText = 'height: 28px; flex: 1;';
  btnRow.appendChild(closeBtn);

  if (onReset) {
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset';
    resetBtn.className = 'btn-mini';
    resetBtn.style.cssText = 'height: 28px; flex: 1;';
    resetBtn.addEventListener('click', () => { onReset(); close(); });
    btnRow.appendChild(resetBtn);
  }

  panel.appendChild(pickerElement);
  panel.appendChild(btnRow);
  document.body.appendChild(panel);

  const rect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  let left = Math.min(rect.left, window.innerWidth - panelRect.width - 8);
  let top = rect.bottom + 6;
  if (top + panelRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - panelRect.height - 6);
  panel.style.left = `${Math.max(8, left)}px`;
  panel.style.top = `${top}px`;

  const close = () => {
    panel.remove();
    document.removeEventListener('mousedown', outsideClick);
    if (activePicker && activePicker.anchor === anchor) activePicker = null;
  };
  const outsideClick = (e) => {
    if (!panel.contains(e.target) && e.target !== anchor) close();
  };
  document.addEventListener('mousedown', outsideClick);
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  closeBtn.addEventListener('click', close);

  activePicker = { anchor, close };
}

// createColorSwatch(initialHex, onChange) -> the swatch <button> element.
// Read the current color from swatch.dataset.hex.
export function createColorSwatch(initialHex = '#000000', onChange = () => {}) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'color-swatch-btn';
  swatch.title = 'Pick color';
  swatch.dataset.hex = initialHex;
  swatch.style.cssText = `
    width: 24px;
    height: 24px;
    border-radius: 5px;
    border: 1px solid rgba(255,255,255,0.3);
    cursor: pointer;
    padding: 0;
    background: ${initialHex};
  `;
  swatch.addEventListener('click', (e) => {
    e.stopPropagation();
    openSwatchColorPicker(swatch, swatch.dataset.hex, onChange);
  });
  return swatch;
}
