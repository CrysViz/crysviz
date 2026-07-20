import { fileBrowser, highlightHover } from '../../../state/store.js';
import { colorHexToCss, hexToRgba } from '../../../utils/ColorModule.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { updatePolyhedraColors, resolvePolyhedronStyle } from '../../../render/index.js';
import { getElementAtomIndices, clampOpacity, applyToOtherTrajectoryFrames, wirePressHoldPopup } from './utils.js';
import { selectPolyhedronFromRow } from '../../SelectAndHighlightModule.js';
import { createMaterialEditor } from './MaterialEditor.js';

// Helper: Ensure color is always a valid CSS hex string
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

// Each row's "Edit" button swatch previews the polyhedron's live face color,
// but a global recolor (atom color-map dropdown, mode switch, color-bar
// limits) never rebuilds these rows — refresh in place on the same event,
// mirroring createIndividualAtomRow/createIndividualBondRow's registries.
const polyRowSwatchUpdateFunctions = {};
document.addEventListener('crysviz:colors-changed', () => {
  Object.values(polyRowSwatchUpdateFunctions).forEach((updateFn) => updateFn());
});

/**
 * Creates a row for one individual polyhedron inside an expanded Poly-tab
 * category (the polyhedron analog of createIndividualBondRow): label like
 * "CuO6 #3" with the center atom (or cage info), a per-polyhedron color/alpha
 * editor, and click-to-highlight in the 3D view.
 * @param {any} poly - the Polyhedron object (from structure.polyhedra.polyhedra);
 *   the group's representative when options.linkedPolyIndexes is given
 * @param {number} polyIndex - its index into structure.polyhedra.polyhedra
 * @param {number} displayNumber - 1-based position within its category
 * @param {{linkedPolyIndexes?: number[], groupKey?: string}} [options] -
 *   linked mode ("Link periodic copies" on): linkedPolyIndexes lists ALL
 *   periodic-image copies of this physical polyhedron (incl. polyIndex);
 *   edits and Reset then fan out to every member.
 * @returns {HTMLElement}
 */
export function createIndividualPolyhedronRow(poly, polyIndex, displayNumber, options = {}) {
  const structure = fileBrowser.selectedStructure;
  const key = poly.key;
  const catKey = poly.catKey;
  const linked = Array.isArray(options.linkedPolyIndexes) && options.linkedPolyIndexes.length
    ? options.linkedPolyIndexes : null;
  const groupKey = linked ? (options.groupKey ?? null) : null;
  const memberKeys = (linked ?? [polyIndex])
    .map((i) => structure.polyhedra?.polyhedra?.[i]?.key)
    .filter(Boolean);

  const row = document.createElement('div');
  row.className = 'individual-polyhedron-row';
  row.dataset.polyKey = key; // representative's key (capture/restore keeps working)
  if (groupKey) row.dataset.polyGroupKey = groupKey;
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
  const copySuffix = linked && linked.length > 1 ? ` · ×${linked.length}` : '';
  if (poly.type === 'centered' && Number.isInteger(poly.centerIndex)) {
    const n = getElementAtomIndices(poly.centerElement).indexOf(poly.centerIndex) + 1;
    metaDisplay.textContent = `center ${poly.centerElement}${n}${copySuffix}`;
  } else {
    metaDisplay.textContent = `cage · CN ${poly.numVertices}${copySuffix}`;
  }
  if (copySuffix) {
    metaDisplay.title = `${linked.length} periodic copies — edits apply to all`;
  }

  nameContainer.appendChild(name);
  nameContainer.appendChild(metaDisplay);
  row.appendChild(nameContainer);

  // Write style fields into every member's persistent record (survives
  // rebuilds). In linked mode this fans the edit out to all periodic copies.
  function setMemberStyles(patch) {
    for (const k of memberKeys) {
      Object.assign(structure.polyhedraUserStyles[k] ??= {}, patch);
    }
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
  colorBtn.title = `Edit color and alpha for ${poly.catLabel} #${displayNumber}`;
  function updateColorBtnSwatch() {
    const style = resolvePolyhedronStyle(
      fileBrowser.selectedStructure, key, catKey, poly.type, poly.centerIndex, poly.colorElem);
    colorBtn.style.background = hexToRgba(safeColor(style.color), 0.8);
  }
  updateColorBtnSwatch();
  polyRowSwatchUpdateFunctions[groupKey ?? key] = updateColorBtnSwatch;

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
    setMemberStyles({ color: hex });
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
    setMemberStyles({ alpha: value });
    updatePolyhedraColors();
  }
  alphaSlider.oninput = (e) => applyPolyAlpha(/** @type {any} */ (e.target).value);
  alphaValue.oninput = (e) => applyPolyAlpha(/** @type {any} */ (e.target).value);

  // --- Edge styling (color + alpha for this polyhedron's edge lines) ---
  const edgeHeader = document.createElement('div');
  edgeHeader.textContent = 'Edge';
  edgeHeader.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); margin-top: 8px;';

  const edgePicker = createColorPicker(safeColor(resolved.edgeColor), (hex) => {
    setMemberStyles({ edgeColor: hex });
    updatePolyhedraColors();
  });

  const currentEdgeAlpha = clampOpacity(resolved.edgeOpacity);
  const edgeAlphaRow = document.createElement('div');
  edgeAlphaRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
  const edgeAlphaLabel = document.createElement('span');
  edgeAlphaLabel.textContent = 'Edge alpha';
  edgeAlphaLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 58px;';
  const edgeAlphaSlider = document.createElement('input');
  edgeAlphaSlider.type = 'range';
  edgeAlphaSlider.min = '0.05';
  edgeAlphaSlider.max = '1';
  edgeAlphaSlider.step = '0.01';
  edgeAlphaSlider.value = String(currentEdgeAlpha);
  edgeAlphaSlider.style.cssText = 'flex:1;';
  const edgeAlphaValue = document.createElement('input');
  edgeAlphaValue.type = 'number';
  edgeAlphaValue.min = '0.05';
  edgeAlphaValue.max = '1';
  edgeAlphaValue.step = '0.01';
  edgeAlphaValue.value = currentEdgeAlpha.toFixed(2);
  edgeAlphaValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
  function applyPolyEdgeAlpha(rawValue) {
    const value = clampOpacity(rawValue);
    edgeAlphaSlider.value = String(value);
    edgeAlphaValue.value = value.toFixed(2);
    setMemberStyles({ edgeAlpha: value });
    updatePolyhedraColors();
  }
  edgeAlphaSlider.oninput = (e) => applyPolyEdgeAlpha(/** @type {any} */ (e.target).value);
  edgeAlphaValue.oninput = (e) => applyPolyEdgeAlpha(/** @type {any} */ (e.target).value);
  edgeAlphaRow.appendChild(edgeAlphaLabel);
  edgeAlphaRow.appendChild(edgeAlphaSlider);
  edgeAlphaRow.appendChild(edgeAlphaValue);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 50px; width: 50px;';
  applyBtn.title = `Click: close. Press and hold: copy ${poly.catLabel} #${displayNumber}'s color/alpha to every trajectory frame.`;
  wirePressHoldPopup(applyBtn, {
    holdLabel: 'Apply to Trajectory',
    onPress: (e) => {
      e.stopPropagation();
      editor.style.display = 'none';
    },
    onConfirm: (e) => {
      e.stopPropagation();
      // Same keys, directly transplanted onto every other frame's own
      // polyhedraUserStyles — matching how flushStylesToAllStructures already
      // treats these keys (index/geometry-derived, tolerated staleness).
      const entries = memberKeys.map((k) => [k, { ...structure.polyhedraUserStyles[k] }]);
      applyToOtherTrajectoryFrames(structure, (frame) => {
        frame.polyhedraUserStyles ??= {};
        for (const [k, style] of entries) frame.polyhedraUserStyles[k] = { ...style };
      });
    },
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 50px; width: 50px;';
  resetBtn.title = `Remove the custom color and alpha for ${poly.catLabel} #${displayNumber}.\nClick: this frame. Press and hold: whole trajectory.`;
  wirePressHoldPopup(resetBtn, {
    holdLabel: 'Reset Trajectory',
    onPress: (e) => {
      e.stopPropagation();
      for (const k of memberKeys) delete structure.polyhedraUserStyles[k];
      updatePolyhedraColors(); // in-place restyle; no rebuild needed
      // Refresh the (expanded) list so swatches reflect the reverted style.
      /** @type {any} */ (row.closest('.individual-polyhedra'))?._populatePolyhedronRows?.(true);
    },
    onConfirm: (e) => {
      e.stopPropagation();
      for (const k of memberKeys) delete structure.polyhedraUserStyles[k];
      applyToOtherTrajectoryFrames(structure, (frame) => {
        for (const k of memberKeys) delete frame.polyhedraUserStyles?.[k];
      });
      updatePolyhedraColors();
      /** @type {any} */ (row.closest('.individual-polyhedra'))?._populatePolyhedronRows?.(true);
    },
  });

  const editorButtonRow = document.createElement('div');
  editorButtonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
  editorButtonRow.appendChild(resetBtn);
  editorButtonRow.appendChild(applyBtn);

  // Per-polyhedron ray/path-tracing material override (wins over the
  // category entry); fans out to every linked member's style record.
  const materialEditor = createMaterialEditor(
    () => structure.polyhedraUserStyles?.[key]?.material,
    (material) => {
      for (const k of memberKeys) {
        const entry = (structure.polyhedraUserStyles[k] ??= {});
        if (material) entry.material = material;
        else delete entry.material;
      }
    });

  editor.appendChild(picker.element);
  editor.appendChild(alphaRow);
  editor.appendChild(edgeHeader);
  editor.appendChild(edgePicker.element);
  editor.appendChild(edgeAlphaRow);
  editor.appendChild(materialEditor);
  editor.appendChild(editorButtonRow);
  editor.onclick = (e) => e.stopPropagation();
  row.appendChild(editor);

  colorBtn.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = (editor.style.display === 'none') ? 'block' : 'none';
  };

  // --- Selection / hover ---
  const isSelected = () => {
    const s = highlightHover.currentlyHighlightedPolyhedron;
    if (!s) return false;
    return groupKey ? s.groupKey === groupKey : s.key === key;
  };
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
