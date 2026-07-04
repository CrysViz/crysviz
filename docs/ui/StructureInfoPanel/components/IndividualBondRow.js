import { fileBrowser, groups, highlightHover } from '../../../state/store.js';
import { colorHexToCss, hexToRgba } from '../../../utils/ColorModule.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { updateSingleBondColor, bondKey } from '../../../render/BondsFracUpdateModule.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { getElementAtomIndices } from './utils.js';
import { selectBondFromRow } from '../../SelectAndHighlightModule.js';

// Helper: Ensure color is always a valid CSS hex string
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

/**
 * Creates a row for one individual bond inside an expanded Bonds-tab category
 * (the bond analog of createIndividualAtomRow): label like "Cu1–O3" with the
 * bond length, a per-bond color editor, and click-to-highlight in the 3D view.
 * @param {any} bond - the Bond object (from structure.bonds)
 * @param {number} bondIndex - its index into structure.bonds
 * @returns {HTMLElement}
 */
export function createIndividualBondRow(bond, bondIndex) {
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
  row.dataset.bondKey = key;
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
  distDisplay.textContent = `${bond.dist.toFixed(3)} Å`;

  nameContainer.appendChild(name);
  nameContainer.appendChild(distDisplay);
  row.appendChild(nameContainer);

  // --- Color editor button ---
  const currentColor = safeColor(bond.userColor?.[0] ?? bond.color?.[0] ?? bond.defaultColor?.[0]);

  const colorBtn = document.createElement('button');
  colorBtn.textContent = 'Color';
  colorBtn.className = 'atom-editor-button';
  colorBtn.dataset.editorButton = 'color';
  colorBtn.style.cssText = 'border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px;';
  colorBtn.style.background = hexToRgba(currentColor, 0.8);
  colorBtn.title = `Change color for bond ${bondName}`;

  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = 'display: flex; gap: 10px;';
  buttonContainer.appendChild(colorBtn);
  row.appendChild(buttonContainer);

  // --- Hidden color editor panel ---
  const editor = document.createElement('div');
  editor.className = 'bond-color-editor';
  editor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const structure = fileBrowser.selectedStructure;

  const picker = createColorPicker(currentColor, (hex) => {
    // Persist across bond rebuilds (structure.bondUserColors survives them),
    // and apply live to both half-cylinders of this bond only.
    structure.bondUserColors[key] = { color: hex, elements: [...bond.elements] };
    bond.color = [hex, hex];
    bond.userColor = [hex, hex];
    if (bond.instanceIds && groups.bondsMesh) {
      updateSingleBondColor(bond.instanceIds[0], hex, true);
      updateSingleBondColor(bond.instanceIds[1], hex, true);
      groups.bondsMesh.instanceColor.needsUpdate = true;
    }
    colorBtn.style.background = hexToRgba(hex, 0.8);
  });

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
  resetBtn.title = `Remove the custom color for ${bondName} (revert to the bond color mode)`;
  resetBtn.onclick = (e) => {
    e.stopPropagation();
    delete structure.bondUserColors[key];
    // Rebuild bonds so the mode coloring (element/solid/length/...) reapplies.
    updateVisualization({ reRenderBonds: true, reRenderOther: false, reRenderComposition: false });
    // The rebuild invalidated every Bond object this list references — refresh
    // the (expanded) list so rows point at the fresh objects.
    /** @type {any} */ (row.closest('.individual-bonds'))?._populateBondRows?.();
  };

  const editorButtonRow = document.createElement('div');
  editorButtonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
  editorButtonRow.appendChild(resetBtn);
  editorButtonRow.appendChild(applyBtn);

  editor.appendChild(picker.element);
  editor.appendChild(editorButtonRow);
  editor.onclick = (e) => e.stopPropagation();
  row.appendChild(editor);

  colorBtn.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = (editor.style.display === 'none') ? 'block' : 'none';
  };

  // --- Selection / hover ---
  if (!bond.instanceIds) {
    row.title = 'Bond too short to render — cannot highlight in 3D';
    row.style.cursor = 'default';
  }

  const isSelected = () => highlightHover.currentlyHighlightedBond?.bondIndex === bondIndex;
  row.addEventListener('mouseenter', () => {
    if (!isSelected()) row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });
  row.addEventListener('mouseleave', () => {
    if (!isSelected()) row.style.backgroundColor = '';
  });

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!bond.instanceIds) return;
    selectBondFromRow(bondIndex, row);
  });

  return row;
}
