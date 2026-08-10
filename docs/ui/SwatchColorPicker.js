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
  panel.className = 'swatch-color-picker cv-swatch-picker-panel';

  const { element: pickerElement } = createColorPicker(hex, (newHex) => {
    anchor.style.background = newHex;
    anchor.dataset.hex = newHex;
    onChange(newHex);
  });

  const btnRow = document.createElement('div');
  btnRow.className = 'cv-swatch-picker-btn-row';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.className = 'btn-mini highlight cv-swatch-picker-btn';
  btnRow.appendChild(closeBtn);

  if (onReset) {
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset';
    resetBtn.className = 'btn-mini cv-swatch-picker-btn';
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
  // The one property that isn't chrome: the swatch's own fill IS the value
  // it represents, so it stays inline rather than in the class.
  swatch.style.background = initialHex;
  swatch.addEventListener('click', (e) => {
    e.stopPropagation();
    openSwatchColorPicker(swatch, swatch.dataset.hex, onChange);
  });
  return swatch;
}
