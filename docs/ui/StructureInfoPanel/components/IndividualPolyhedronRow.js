import { fileBrowser, highlightHover } from '../../../state/store.js';
import { colorHexToCss, hexToRgba } from '../../../utils/ColorModule.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { updatePolyhedraColors, resolvePolyhedronStyle } from '../../../render/index.js';
import { getElementAtomIndices, clampOpacity } from './utils.js';
import { selectPolyhedronFromRow } from '../../SelectAndHighlightModule.js';

// Helper: Ensure color is always a valid CSS hex string
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

/**
 * Creates a row for one individual polyhedron inside an expanded Poly-tab
 * category (the polyhedron analog of createIndividualBondRow): label like
 * "CuO6 #3" with the center atom (or cage info), a per-polyhedron color/alpha
 * editor, and click-to-highlight in the 3D view.
 * @param {any} poly - the Polyhedron object (from structure.polyhedra.polyhedra)
 * @param {number} polyIndex - its index into structure.polyhedra.polyhedra
 * @param {number} displayNumber - 1-based position within its category
 * @returns {HTMLElement}
 */
export function createIndividualPolyhedronRow(poly, polyIndex, displayNumber) {
  const structure = fileBrowser.selectedStructure;
  const key = poly.key;
  const catKey = poly.catKey;

  const row = document.createElement('div');
  row.className = 'individual-polyhedron-row';
  row.dataset.polyKey = key;
  row.dataset.catKey = catKey;
  row.style.cssText = 'display: grid; grid-template-columns: 1fr auto; align-items: center; column-gap: 12px; padding: 4px 0; font-size: 11px; cursor: pointer; transition: background-color 0.2s ease;';

  // --- Name + meta ---
  const nameContainer = document.createElement('div');
  nameContainer.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

  const name = document.createElement('span');
  name.textContent = `${poly.catLabel} #${displayNumber}`;
  name.style.color = '#ddd';

  const metaDisplay = document.createElement('span');
  metaDisplay.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.8); font-family: monospace;';
  if (poly.type === 'centered' && Number.isInteger(poly.centerIndex)) {
    const n = getElementAtomIndices(poly.centerElement).indexOf(poly.centerIndex) + 1;
    metaDisplay.textContent = `center ${poly.centerElement}${n}`;
  } else {
    metaDisplay.textContent = `cage · CN ${poly.numVertices}`;
  }

  nameContainer.appendChild(name);
  nameContainer.appendChild(metaDisplay);
  row.appendChild(nameContainer);

  // Get-or-create this polyhedron's persistent style record (survives rebuilds).
  function stylesEntry() {
    return structure.polyhedraUserStyles[key] ??= {};
  }

  const resolved = resolvePolyhedronStyle(
    structure, key, catKey, poly.type, poly.centerIndex, poly.colorElem);
  const currentColor = safeColor(resolved.color);
  const currentAlpha = clampOpacity(resolved.opacity);

  // --- Color/alpha editor button ("Edit", swatch previews the face color) ---
  const colorBtn = document.createElement('button');
  colorBtn.textContent = 'Edit';
  colorBtn.className = 'atom-editor-button';
  colorBtn.dataset.editorButton = 'color';
  colorBtn.style.cssText = 'border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px;';
  colorBtn.style.background = hexToRgba(currentColor, 0.8);
  colorBtn.title = `Edit color and alpha for ${poly.catLabel} #${displayNumber}`;

  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = 'display: flex; gap: 10px;';
  buttonContainer.appendChild(colorBtn);
  row.appendChild(buttonContainer);

  // --- Hidden editor panel ---
  const editor = document.createElement('div');
  editor.className = 'poly-color-editor';
  editor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const picker = createColorPicker(currentColor, (hex) => {
    // Persist across polyhedra rebuilds (structure.polyhedraUserStyles survives
    // them); restyle in place — no geometry recompute needed.
    stylesEntry().color = hex;
    updatePolyhedraColors();
    colorBtn.style.background = hexToRgba(hex, 0.8);
  });

  // Alpha row (same layout as the atom/bond editors)
  const alphaRow = document.createElement('div');
  alphaRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
  const alphaLabel = document.createElement('span');
  alphaLabel.textContent = 'Alpha';
  alphaLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
  const alphaSlider = document.createElement('input');
  alphaSlider.type = 'range';
  alphaSlider.min = '0.05';
  alphaSlider.max = '1';
  alphaSlider.step = '0.01';
  alphaSlider.value = String(currentAlpha);
  alphaSlider.style.cssText = 'flex:1;';
  const alphaValue = document.createElement('input');
  alphaValue.type = 'number';
  alphaValue.min = '0.05';
  alphaValue.max = '1';
  alphaValue.step = '0.01';
  alphaValue.value = currentAlpha.toFixed(2);
  alphaValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
  alphaRow.appendChild(alphaLabel);
  alphaRow.appendChild(alphaSlider);
  alphaRow.appendChild(alphaValue);

  function applyPolyAlpha(rawValue) {
    const value = clampOpacity(rawValue);
    alphaSlider.value = String(value);
    alphaValue.value = value.toFixed(2);
    stylesEntry().alpha = value;
    updatePolyhedraColors();
  }
  alphaSlider.oninput = (e) => applyPolyAlpha(/** @type {any} */ (e.target).value);
  alphaValue.oninput = (e) => applyPolyAlpha(/** @type {any} */ (e.target).value);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';
  applyBtn.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = 'none';
  };

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';
  resetBtn.title = `Remove the custom color and alpha for ${poly.catLabel} #${displayNumber}`;
  resetBtn.onclick = (e) => {
    e.stopPropagation();
    delete structure.polyhedraUserStyles[key];
    updatePolyhedraColors(); // in-place restyle; no rebuild needed
    // Refresh the (expanded) list so swatches reflect the reverted style.
    /** @type {any} */ (row.closest('.individual-polyhedra'))?._populatePolyhedronRows?.(true);
  };

  const editorButtonRow = document.createElement('div');
  editorButtonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
  editorButtonRow.appendChild(resetBtn);
  editorButtonRow.appendChild(applyBtn);

  editor.appendChild(picker.element);
  editor.appendChild(alphaRow);
  editor.appendChild(editorButtonRow);
  editor.onclick = (e) => e.stopPropagation();
  row.appendChild(editor);

  colorBtn.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = (editor.style.display === 'none') ? 'block' : 'none';
  };

  // --- Selection / hover ---
  const isSelected = () => highlightHover.currentlyHighlightedPolyhedron?.key === key;
  row.addEventListener('mouseenter', () => {
    if (!isSelected()) row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });
  row.addEventListener('mouseleave', () => {
    if (!isSelected()) row.style.backgroundColor = '';
  });

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    selectPolyhedronFromRow(key, row);
  });

  return row;
}
