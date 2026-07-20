import { fileBrowser, groups, highlightHover, general } from '../../../state/store.js';
import { colorHexToCss, hexToRgba } from '../../../utils/ColorModule.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { updateSingleBondColor, updateSingleBondOpacity, updateSingleBondDiameter, bondKey } from '../../../render/BondsFracUpdateModule.js';
import { createMaterialEditor } from './MaterialEditor.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { notifyColorsChanged } from '../../../render/index.js';
import { getElementAtomIndices, clampOpacity, clampRadiusScale, applyToOtherTrajectoryFrames, wirePressHoldPopup } from './utils.js';
import { selectBondFromRow, suppressSelectionHighlightFor3D, restoreSelectionHighlight } from '../../SelectAndHighlightModule.js';

// Helper: Ensure color is always a valid CSS hex string
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

// Each row's "Edit" button swatch previews the bond's live color, but a
// global recolor (Bonds color-map dropdown, mode switch, color-bar limits)
// never rebuilds these rows — refresh in place on the same event, mirroring
// createIndividualAtomRow's atomRowSwatchUpdateFunctions.
const bondRowSwatchUpdateFunctions = {};
document.addEventListener('crysviz:colors-changed', () => {
  Object.values(bondRowSwatchUpdateFunctions).forEach((updateFn) => updateFn());
});

/**
 * Creates a row for one individual bond inside an expanded Bonds-tab category
 * (the bond analog of createIndividualAtomRow): label like "Cu1–O3" with the
 * bond length, a per-bond color/alpha/size editor, and click-to-highlight in
 * the 3D view.
 * @param {any} bond - the Bond object (from structure.bonds); the group's
 *   representative when options.linkedBondIndexes is given
 * @param {number} bondIndex - its index into structure.bonds
 * @param {{linkedBondIndexes?: number[], groupKey?: string}} [options] -
 *   linked mode ("Link periodic copies" on): linkedBondIndexes lists ALL
 *   periodic-image copies of this physical bond (incl. bondIndex); edits,
 *   Reset and selection then fan out to every member.
 * @returns {HTMLElement}
 */
export function createIndividualBondRow(bond, bondIndex, options = {}) {
  const linked = Array.isArray(options.linkedBondIndexes) && options.linkedBondIndexes.length
    ? options.linkedBondIndexes : null;
  const groupKey = linked ? (options.groupKey ?? null) : null;
  const memberIndexes = linked ?? [bondIndex];
  const key = bondKey(bond.indices);
  const [el1, el2] = bond.elements;
  const pair = el1 < el2 ? `${el1}-${el2}` : `${el2}-${el1}`;
  // Same per-element display numbering as the Atoms tab (position within the
  // element's source-order atom list, 1-based), applied to the source atoms.
  const n1 = getElementAtomIndices(el1).indexOf(bond.srcIndices[0]) + 1;
  const n2 = getElementAtomIndices(el2).indexOf(bond.srcIndices[1]) + 1;
  const bondName = `${el1}${n1}–${el2}${n2}`;

  const row = document.createElement('div');
  row.className = 'individual-bond-row';
  row.dataset.bondKey = key; // representative's key (capture/restore keeps working)
  if (groupKey) row.dataset.groupKey = groupKey;
  row.dataset.pair = pair;
  row.style.cssText = 'display: grid; grid-template-columns: 1fr auto; align-items: center; column-gap: 12px; padding: 4px 0; font-size: 11px; cursor: pointer; transition: background-color 0.2s ease;';

  // --- Name + length ---
  const nameContainer = document.createElement('div');
  nameContainer.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

  const name = document.createElement('span');
  name.textContent = bondName;
  name.style.color = '#ddd';

  const distDisplay = document.createElement('span');
  distDisplay.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.8); font-family: monospace;';
  distDisplay.textContent = `${bond.dist.toFixed(3)} Å${linked && linked.length > 1 ? ` · ×${linked.length}` : ''}`;
  if (linked && linked.length > 1) {
    distDisplay.title = `${linked.length} periodic copies — edits apply to all`;
  }

  nameContainer.appendChild(name);
  nameContainer.appendChild(distDisplay);
  row.appendChild(nameContainer);

  // --- Color/alpha/size editor button (labeled "Edit", swatch previews the
  // bond color, matching the atom rows) ---
  const currentColor = safeColor(bond.userColor?.[0] ?? bond.color?.[0] ?? bond.defaultColor?.[0]);

  const colorBtn = document.createElement('button');
  colorBtn.textContent = 'Edit';
  colorBtn.className = 'atom-editor-button';
  colorBtn.dataset.editorButton = 'color';
  colorBtn.style.cssText = 'border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px;';
  colorBtn.title = `Edit color, alpha and size for bond ${bondName}`;
  function updateColorBtnSwatch() {
    const b = fileBrowser.selectedStructure?.bonds?.[bondIndex] ?? bond;
    colorBtn.style.background = hexToRgba(safeColor(b.userColor?.[0] ?? b.color?.[0] ?? b.defaultColor?.[0]), 0.8);
  }
  updateColorBtnSwatch();
  bondRowSwatchUpdateFunctions[groupKey ?? key] = updateColorBtnSwatch;

  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = 'display: flex; gap: 10px;';
  buttonContainer.appendChild(colorBtn);
  row.appendChild(buttonContainer);

  // --- Hidden color editor panel ---
  const editor = document.createElement('div');
  editor.className = 'bond-color-editor';
  editor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const structure = fileBrowser.selectedStructure;

  // Get-or-create a bond's persistent style record (survives rebuilds). In
  // linked mode edits fan out to every periodic copy's own record.
  function stylesEntryFor(b) {
    return structure.bondUserStyles[bondKey(b.indices)] ??= { elements: [...b.elements] };
  }
  function memberBonds() {
    return memberIndexes.map((i) => structure.bonds[i]).filter(Boolean);
  }

  const picker = createColorPicker(currentColor, (hex) => {
    // Persist across bond rebuilds (structure.bondUserStyles survives them),
    // and apply live to both half-cylinders of every member copy.
    for (const b of memberBonds()) {
      stylesEntryFor(b).color = hex;
      b.color = [hex, hex];
      b.userColor = [hex, hex];
      if (b.instanceIds && groups.bondsMesh) {
        updateSingleBondColor(b.instanceIds[0], hex, true);
        updateSingleBondColor(b.instanceIds[1], hex, true);
      }
    }
    if (groups.bondsMesh) groups.bondsMesh.instanceColor.needsUpdate = true;
    colorBtn.style.background = hexToRgba(hex, 0.8);
    // Nothing else here calls updateVisualization() (it's a direct instance-color
    // mutation, cheaper than a full re-render) — notify separately so anything
    // depending on live colours (e.g. the Polyhedron Inspector) still refreshes.
    notifyColorsChanged();
  });

  // --- Alpha row (same layout as the atom editor) ---
  const currentAlpha = clampOpacity(structure.bondUserStyles[key]?.alpha ?? bond.alpha ?? 1);
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

  function applyBondAlpha(rawValue) {
    const value = clampOpacity(rawValue);
    alphaSlider.value = String(value);
    alphaValue.value = value.toFixed(2);
    for (const b of memberBonds()) {
      stylesEntryFor(b).alpha = value;
      b.alpha = value;
      if (b.instanceIds) {
        updateSingleBondOpacity(b.instanceIds[0], value);
        updateSingleBondOpacity(b.instanceIds[1], value);
      }
    }
  }
  alphaSlider.oninput = (e) => applyBondAlpha(/** @type {any} */ (e.target).value);
  alphaValue.oninput = (e) => applyBondAlpha(/** @type {any} */ (e.target).value);

  // --- Size row (per-bond radius multiplier on the global bond diameter) ---
  const currentRadiusScale = clampRadiusScale(structure.bondUserStyles[key]?.radiusScale ?? 1);
  const sizeRow = document.createElement('div');
  sizeRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
  const sizeLabel = document.createElement('span');
  sizeLabel.textContent = 'Size';
  sizeLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range';
  sizeSlider.min = '0.2';
  sizeSlider.max = '3';
  sizeSlider.step = '0.05';
  sizeSlider.value = String(currentRadiusScale);
  sizeSlider.style.cssText = 'flex:1;';
  const sizeValue = document.createElement('input');
  sizeValue.type = 'number';
  sizeValue.min = '0.2';
  sizeValue.max = '3';
  sizeValue.step = '0.05';
  sizeValue.value = currentRadiusScale.toFixed(2);
  sizeValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
  sizeRow.appendChild(sizeLabel);
  sizeRow.appendChild(sizeSlider);
  sizeRow.appendChild(sizeValue);

  function applyBondRadiusScale(rawValue) {
    const value = clampRadiusScale(rawValue);
    sizeSlider.value = String(value);
    sizeValue.value = value.toFixed(2);
    for (const b of memberBonds()) {
      stylesEntryFor(b).radiusScale = value;
      // b.radius drives every repaint (updateSingleBond), so the live change
      // sticks; buildBondObjects re-derives it from the persisted scale.
      b.radius = general.bondRadius * value;
      if (b.instanceIds && groups.bondsMesh) {
        updateSingleBondDiameter(b.instanceIds[0], b.radius);
        updateSingleBondDiameter(b.instanceIds[1], b.radius);
      }
    }
  }
  sizeSlider.oninput = (e) => applyBondRadiusScale(/** @type {any} */ (e.target).value);
  sizeValue.oninput = (e) => applyBondRadiusScale(/** @type {any} */ (e.target).value);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 50px; width: 50px;';
  applyBtn.title = `Click: close. Press and hold: copy ${bondName}'s color/alpha/size to every trajectory frame.`;
  wirePressHoldPopup(applyBtn, {
    holdLabel: 'Apply to Trajectory',
    onPress: (e) => {
      e.stopPropagation();
      editor.style.display = 'none';
      restoreSelectionHighlight();
    },
    onConfirm: (e) => {
      e.stopPropagation();
      // Same key (bondKey), directly transplanted onto every other frame's
      // own bondUserStyles — matching how flushStylesToAllStructures already
      // treats these keys (index/geometry-derived, tolerated staleness if a
      // bond wraps differently on another frame; see its docstring).
      const entries = memberBonds().map((b) => [bondKey(b.indices), { ...stylesEntryFor(b) }]);
      applyToOtherTrajectoryFrames(structure, (frame) => {
        frame.bondUserStyles ??= {};
        for (const [k, style] of entries) frame.bondUserStyles[k] = { ...style };
      });
    },
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 50px; width: 50px;';
  resetBtn.title = `Remove the custom color, alpha and size for ${bondName}.\nClick: this frame. Press and hold: whole trajectory.`;
  wirePressHoldPopup(resetBtn, {
    holdLabel: 'Reset Trajectory',
    onPress: (e) => {
      e.stopPropagation();
      for (const b of memberBonds()) delete structure.bondUserStyles[bondKey(b.indices)];
      // Rebuild bonds so the mode coloring (element/solid/length/...) reapplies.
      updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
      // The rebuild invalidated every Bond object this list references — refresh
      // the (expanded) list so rows point at the fresh objects.
      /** @type {any} */ (row.closest('.individual-bonds'))?._populateBondRows?.();
    },
    onConfirm: (e) => {
      e.stopPropagation();
      const keys = memberBonds().map((b) => bondKey(b.indices));
      for (const k of keys) delete structure.bondUserStyles[k];
      applyToOtherTrajectoryFrames(structure, (frame) => {
        for (const k of keys) delete frame.bondUserStyles?.[k];
      });
      updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
      /** @type {any} */ (row.closest('.individual-bonds'))?._populateBondRows?.();
    },
  });

  const editorButtonRow = document.createElement('div');
  editorButtonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
  editorButtonRow.appendChild(resetBtn);
  editorButtonRow.appendChild(applyBtn);

  // Per-bond ray/path-tracing material override (wins over the pair entry);
  // fans out to every member copy's style record like the other fields.
  const materialEditor = createMaterialEditor(
    () => structure.bondUserStyles?.[key]?.material,
    (material) => {
      for (const b of memberBonds()) {
        if (material) stylesEntryFor(b).material = material;
        else delete stylesEntryFor(b).material;
      }
    });

  editor.appendChild(picker.element);
  editor.appendChild(alphaRow);
  editor.appendChild(sizeRow);
  editor.appendChild(materialEditor);
  editor.appendChild(editorButtonRow);
  editor.onclick = (e) => e.stopPropagation();
  row.appendChild(editor);

  colorBtn.onclick = (e) => {
    e.stopPropagation();
    const shouldOpen = editor.style.display === 'none';
    editor.style.display = shouldOpen ? 'block' : 'none';
    // The 3D selection glow overwrites the bond's real color — hide it while
    // the editor is open so a live color change is actually visible.
    if (shouldOpen) suppressSelectionHighlightFor3D();
    else restoreSelectionHighlight();
  };

  // --- Selection / hover ---
  const hasRenderable = () => memberBonds().some((b) => b.instanceIds);
  if (!hasRenderable()) {
    row.title = 'Bond too short to render — cannot highlight in 3D';
    row.style.cursor = 'default';
  }

  const isSelected = () => {
    const s = highlightHover.currentlyHighlightedBond;
    if (!s) return false;
    return groupKey ? s.groupKey === groupKey : s.bondIndex === bondIndex;
  };
  row.addEventListener('mouseenter', () => {
    if (!isSelected()) row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });
  row.addEventListener('mouseleave', () => {
    if (!isSelected()) row.style.backgroundColor = '';
  });

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!hasRenderable()) return;
    selectBondFromRow(bondIndex, row, linked);
  });

  return row;
}
