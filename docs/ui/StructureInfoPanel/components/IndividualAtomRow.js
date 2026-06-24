import { fileBrowser, groups, general } from '../../../state/store.js';
import { colorHexToCss, getAtomColor, hexToRgba } from '../../../utils/ColorModule.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { updateSingleAtomColor, updateSingleAtomOpacity } from '../../../render/AtomsFracUpdateModule.js';
import { updateSingleBondColor } from '../../../render/BondsFracUpdateModule.js';
import { clampOpacity, updateAtomCoordinates } from './utils.js';
import { createTinyImmunityToggle } from './Immunity.js';
import { createSpinForceEditor } from './SpinForceEditor.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { bondLengthToColor } from '../../ColorPanel.js';



// Helper to get the current color for an atom based on the active color mode


// Helper: Ensure color is always a valid CSS hex string
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

export function createIndividualAtomRow(element, atomIndex, displayNumber = atomIndex + 1, options = {}) {
  const linkedAtomIndices = options.linkedAtomIndices ?? [atomIndex];
  const positionUpdater = options.positionUpdater ?? ((coords) => updateAtomCoordinates(atomIndex, coords));
  const resetCoordsProvider = options.resetCoordsProvider ?? (() => fileBrowser.selectedStructure?.original?.atoms?.[atomIndex]?.position ?? null);
  const positionEditable = options.positionEditable ?? true;
  const onColorChange = options.onColorChange ?? (() => {}); // Callback for color changes

  const row = document.createElement('div');
  row.className = 'individual-atom-row';
  row.dataset.atomIndex = String(atomIndex);
  row.dataset.element = element;
  row.style.cssText = 'display: grid; grid-template-columns: 1fr auto auto; align-items: center; column-gap: 12px; padding: 4px 0; font-size: 11px;';

  const currentColor = safeColor(getAtomColor(atomIndex));
  const currentOpacity = fileBrowser.selectedStructure.atoms[atomIndex].getOpacity?.() ?? fileBrowser.selectedStructure.atoms[atomIndex].opacity ?? 1;

  // Atom name and coordinates container
  const nameContainer = document.createElement('div');
  nameContainer.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

  const name = document.createElement('span');
  name.textContent = options.label ?? `${element}${displayNumber}`;
  name.style.color = '#ddd';

  const coords = fileBrowser.selectedStructure.atoms.map(a => a.position)[atomIndex];
  const coordsDisplay = document.createElement('span');
  coordsDisplay.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.8); font-family: monospace;';
  coordsDisplay.textContent = `(${coords[0].toFixed(3)}, ${coords[1].toFixed(3)}, ${coords[2].toFixed(3)})`;

  nameContainer.appendChild(name);
  if (options.metaText) {
    const meta = document.createElement('span');
    meta.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.55);';
    meta.textContent = options.metaText;
    nameContainer.appendChild(meta);
  }
  nameContainer.appendChild(coordsDisplay);

  row.appendChild(nameContainer);

  // Button container
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = 'display: flex; gap: 10px;';

  const inactiveButtonBorder = '1px solid rgba(255,255,255,0.2)';
  const activeButtonBorder = '1px solid rgba(125, 206, 160, 0.95)';
  const activeButtonShadow = '0 0 0 1px rgba(125, 206, 160, 0.35), inset 0 0 0 1px rgba(125, 206, 160, 0.15)';

  // Color picker button
  const colorBtn = document.createElement('button');
  colorBtn.textContent = 'Color';
  colorBtn.className = 'atom-editor-button';
  colorBtn.dataset.editorButton = 'color';
  colorBtn.style.cssText = 'border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px;';
  colorBtn.style.background = hexToRgba(currentColor, 0.8);
  colorBtn.title = `Change color for ${element}${displayNumber}`;

  // Coordinate edit button
  const coordBtn = document.createElement('button');
  coordBtn.textContent = 'Position';
  coordBtn.className = 'atom-editor-button';
  coordBtn.dataset.editorButton = 'coord';
  coordBtn.style.cssText = 'background: var(--bg-color); border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 4px; cursor: pointer; font-size: 10px;';
  coordBtn.title = `Edit coordinates for ${element}${displayNumber}`;
  if (!positionEditable) {
    coordBtn.disabled = true;
    coordBtn.style.opacity = '0.45';
    coordBtn.style.cursor = 'not-allowed';
    coordBtn.title = `Position is fixed by symmetry for ${element}${displayNumber}`;
  }

  // Spin Edit button
  const spinBtn = document.createElement('button');
  spinBtn.textContent = 'Spin/Force';
  spinBtn.className = 'atom-editor-button';
  spinBtn.dataset.editorButton = 'spin';
  spinBtn.style.cssText = 'background: var(--bg-color); border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 4px; cursor: pointer; font-size: 10px;';
  spinBtn.title = `Edit Spin for ${element}${displayNumber}`;

  const keepToggle = createTinyImmunityToggle(linkedAtomIndices, `Keep ${element}${displayNumber} visible across cut planes`);

  buttonContainer.appendChild(colorBtn);
  buttonContainer.appendChild(coordBtn);
  buttonContainer.appendChild(spinBtn);

  row.appendChild(buttonContainer);
  row.appendChild(keepToggle.wrapper);

  // --- Editors ---
  const editor = document.createElement('div');
  editor.className = 'atom-color-editor';
  editor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const mom_color = safeColor(getAtomColor(atomIndex));
  const picker = createColorPicker(mom_color, (hex) => {
    let structure = fileBrowser.selectedStructure;
    let indexset;
    linkedAtomIndices.forEach((linkedAtomIndex) => {
      structure.atomImages[linkedAtomIndex]?.forEach(imageIndex => {
        if (structure.bondMapping[imageIndex]) {
          structure.bondMapping[imageIndex].forEach(bondHalvIndex => {
            updateSingleBondColor(bondHalvIndex, hex,true);
            indexset = structure.bondObjectMapping[bondHalvIndex];
            structure.bonds[indexset[0]].color[indexset[1]] = hex;
            structure.bonds[indexset[0]].userColor[indexset[1]] = hex;
          });
        }
        updateSingleAtomColor(linkedAtomIndex, imageIndex, structure.elements[linkedAtomIndex], hex, hex);
      });
    });
    groups.atomsMesh.instanceColor.needsUpdate = true;
    groups.bondsMesh.instanceColor.needsUpdate = true;
    colorBtn.style.background = hexToRgba(hex, 0.8);
    onColorChange(); // Notify parent to update pie dot
  });

  const AtomColorApplyBtn = document.createElement('button');
  AtomColorApplyBtn.textContent = 'Apply';
  AtomColorApplyBtn.className = 'btn-mini highlight';
  AtomColorApplyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  const AtomColorResetBtn = document.createElement('button');
  AtomColorResetBtn.textContent = 'Reset';
  AtomColorResetBtn.className = 'btn-mini';
  AtomColorResetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  // Get the default color for this element
  const defaultColor = safeColor(fileBrowser.selectedStructure.getDefaultElementColor(element));
  AtomColorResetBtn.style.background = hexToRgba(defaultColor, 0.8);

  const topRowIndiv = document.createElement('div');
  topRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';
  topRowIndiv.appendChild(picker.element);

  const buttonRowIndiv = document.createElement('div');
  buttonRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  buttonRowIndiv.appendChild(AtomColorResetBtn);
  buttonRowIndiv.appendChild(AtomColorApplyBtn);

  const atomAlphaRow = document.createElement('div');
  atomAlphaRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
  const atomAlphaLabel = document.createElement('span');
  atomAlphaLabel.textContent = 'Alpha';
  atomAlphaLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
  const atomAlphaSlider = document.createElement('input');
  atomAlphaSlider.type = 'range';
  atomAlphaSlider.min = '0.05';
  atomAlphaSlider.max = '1';
  atomAlphaSlider.step = '0.01';
  atomAlphaSlider.value = String(currentOpacity);
  atomAlphaSlider.style.cssText = 'flex:1;';
  const atomAlphaValue = document.createElement('input');
  atomAlphaValue.type = 'number';
  atomAlphaValue.min = '0.05';
  atomAlphaValue.max = '1';
  atomAlphaValue.step = '0.01';
  atomAlphaValue.value = currentOpacity.toFixed(2);
  atomAlphaValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
  atomAlphaRow.appendChild(atomAlphaLabel);
  atomAlphaRow.appendChild(atomAlphaSlider);
  atomAlphaRow.appendChild(atomAlphaValue);

  editor.appendChild(topRowIndiv);
  editor.appendChild(atomAlphaRow);
  editor.appendChild(buttonRowIndiv);

  // Coordinate editor
  const coordEditor = document.createElement('div');
  coordEditor.className = 'atom-coord-editor';
  coordEditor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const coordTitle = document.createElement('div');
  coordTitle.textContent = positionEditable ? 'Fractional Coordinates' : 'Fractional Coordinates (fixed by symmetry)';
  coordTitle.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.8); margin-bottom: 6px; font-weight: 500;';
  const xInput = document.createElement('input');
  xInput.type = 'number';
  xInput.value = coords[0].toFixed(6);
  xInput.step = '0.000001';
  xInput.style.cssText = 'width: 80px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  xInput.placeholder = 'x';
  xInput.disabled = !positionEditable;

  const yInput = document.createElement('input');
  yInput.type = 'number';
  yInput.value = coords[1].toFixed(6);
  yInput.step = '0.000001';
  yInput.style.cssText = 'width: 80px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  yInput.placeholder = 'y';
  yInput.disabled = !positionEditable;

  const zInput = document.createElement('input');
  zInput.type = 'number';
  zInput.value = coords[2].toFixed(6);
  zInput.step = '0.000001';
  zInput.style.cssText = 'width: 80px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px;';
  zInput.placeholder = 'z';
  zInput.disabled = !positionEditable;

  const coordInputsRow = document.createElement('div');
  coordInputsRow.style.cssText = 'display: flex; align-items: center; gap: 4px; margin-bottom: 6px;';
  coordInputsRow.appendChild(xInput);
  coordInputsRow.appendChild(yInput);
  coordInputsRow.appendChild(zInput);

  const coordApplyBtn = document.createElement('button');
  coordApplyBtn.textContent = 'Apply';
  coordApplyBtn.className = 'btn-mini highlight';
  coordApplyBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';
  coordApplyBtn.disabled = !positionEditable;

  const coordResetBtn = document.createElement('button');
  coordResetBtn.textContent = 'Reset';
  coordResetBtn.className = 'btn-mini';
  coordResetBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px; margin-right: 6px;';
  coordResetBtn.disabled = !positionEditable;

  const coordButtonsRow = document.createElement('div');
  coordButtonsRow.style.cssText = 'display: flex; align-items: center; gap: 4px;';
  coordButtonsRow.appendChild(coordResetBtn);
  coordButtonsRow.appendChild(coordApplyBtn);

  coordEditor.appendChild(coordTitle);
  coordEditor.appendChild(coordInputsRow);
  coordEditor.appendChild(coordButtonsRow);

  // Spin/Force editor
  const spinEditor = createSpinForceEditor(atomIndex, element);

  // --- Event Handlers ---
  function setButtonActive(button, isActive) {
    button.style.border = isActive ? activeButtonBorder : inactiveButtonBorder;
    button.style.boxShadow = isActive ? activeButtonShadow : 'none';
  }

  function setActiveEditor(editorType = null) {
    const editorMap = {
      color: editor,
      coord: coordEditor,
      spin: spinEditor,
    };

    const buttonMap = {
      color: colorBtn,
      coord: coordBtn,
      spin: spinBtn,
    };

    Object.entries(editorMap).forEach(([type, panel]) => {
      panel.style.display = type === editorType ? 'block' : 'none';
    });

    Object.entries(buttonMap).forEach(([type, button]) => {
      setButtonActive(button, type === editorType);
    });
  }

  function applyIndividualOpacity(rawValue) {
    const value = clampOpacity(rawValue);
    atomAlphaSlider.value = String(value);
    atomAlphaValue.value = value.toFixed(2);
    linkedAtomIndices.forEach((linkedAtomIndex) => {
      const atom = fileBrowser.selectedStructure.atoms[linkedAtomIndex];
      atom.setOpacity(value);
      fileBrowser.selectedStructure.atomImages[linkedAtomIndex]?.forEach((imageIndex) => {
        updateSingleAtomOpacity(imageIndex, value);
      });
    });
  }

  atomAlphaSlider.oninput = (e) => applyIndividualOpacity(/** @type {any} */ (e.target).value);
  atomAlphaValue.oninput = (e) => applyIndividualOpacity(/** @type {any} */ (e.target).value);

  colorBtn.onclick = (e) => {
    e.stopPropagation();
    const shouldOpen = editor.style.display === 'none';
    setActiveEditor(shouldOpen ? 'color' : null);
  };

  coordBtn.onclick = (e) => {
    if (!positionEditable) return;
    e.stopPropagation();
    const shouldOpen = coordEditor.style.display === 'none';
    setActiveEditor(shouldOpen ? 'coord' : null);
  };

  spinBtn.onclick = (e) => {
    e.stopPropagation();
    const shouldOpen = spinEditor.style.display === 'none';
    setActiveEditor(shouldOpen ? 'spin' : null);
  };

  coordApplyBtn.onclick = () => {
    const newX = parseFloat(xInput.value);
    const newY = parseFloat(yInput.value);
    const newZ = parseFloat(zInput.value);
    if (!isNaN(newX) && !isNaN(newY) && !isNaN(newZ)) {
      positionUpdater([newX, newY, newZ]);
      coordsDisplay.textContent = `(${newX.toFixed(3)}, ${newY.toFixed(3)}, ${newZ.toFixed(3)})`;
    }
  };

  coordResetBtn.onclick = () => {
    const originalCoords = resetCoordsProvider();
    if (originalCoords) {
      xInput.value = originalCoords[0].toFixed(6);
      yInput.value = originalCoords[1].toFixed(6);
      zInput.value = originalCoords[2].toFixed(6);
      positionUpdater([...originalCoords]);
      coordsDisplay.textContent = `(${originalCoords[0].toFixed(3)}, ${originalCoords[1].toFixed(3)}, ${originalCoords[2].toFixed(3)})`;
      setActiveEditor(null);
    }
  };

  AtomColorApplyBtn.onclick = () => {
    const currentColor = safeColor(getAtomColor(atomIndex));
    colorBtn.style.background = hexToRgba(currentColor, 0.8);
    setActiveEditor(null);
    onColorChange(); // Notify parent to update pie dot
    updateVisualization({
      bondsUpdate: false,
      reRenderAtoms: false,
      reRenderBonds: false,
      reRenderLattice: false,
      reRenderOther: false,
      reRenderComposition: "open",
    });
  };

AtomColorResetBtn.onclick = () => {
  const structure = fileBrowser.selectedStructure;
  const currentMode = general.atomsColor; // current color mode

  linkedAtomIndices.forEach((linkedAtomIndex) => {
    const atom = structure.atoms[linkedAtomIndex];
    const element = structure.elements[linkedAtomIndex];

    // clear user-color flag only for these atoms
    if (atom.userColor !== undefined) delete atom.userColor;
    if (atom.forceColor !== undefined) delete atom.forceColor;

    // set color based on current mode
    if (currentMode === "force") {
      const forceObj = structure.forces?.[linkedAtomIndex];
      if (forceObj?.vector?.length >= 3) {
        const magnitude = Math.sqrt(
          forceObj.vector[0] ** 2 +
          forceObj.vector[1] ** 2 +
          forceObj.vector[2] ** 2
        );
        atom.color = bondLengthToColor(magnitude, general.ForceMin, general.ForceMax);
      } else {
        atom.color = structure.getDefaultElementColor(element);
      }
    } else {
      atom.color = structure.getDefaultElementColor(element);
    }

    atom.resetToElementOpacity();

    structure.atomImages[linkedAtomIndex]?.forEach((imageIndex) => {
      if (general.bondsColor == "elements") {
        if (structure.bondMapping[imageIndex]) {
          structure.bondMapping[imageIndex].forEach((bondHalvIndex) => {
            updateSingleBondColor(bondHalvIndex, safeColor(atom.getColor()));
            const indexset = structure.bondObjectMapping[bondHalvIndex];
            structure.bonds[indexset[0]].color[indexset[1]] = safeColor(atom.getColor());
            structure.bonds[indexset[0]].userColor[indexset[1]] = safeColor(atom.getColor());
          });
        }
      }
      updateSingleAtomColor(linkedAtomIndex, imageIndex, structure.elements[linkedAtomIndex]);
      updateSingleAtomOpacity(imageIndex, atom.getOpacity());
    });
  });

  // update button to show reset color
  const resetColor = currentMode === "force"
    ? bondLengthToColor(
        Math.sqrt(
          (fileBrowser.selectedStructure.forces?.[atomIndex]?.vector?.[0] || 0) ** 2 +
          (fileBrowser.selectedStructure.forces?.[atomIndex]?.vector?.[1] || 0) ** 2 +
          (fileBrowser.selectedStructure.forces?.[atomIndex]?.vector?.[2] || 0) ** 2
        ),
        general.ForceMin,
        general.ForceMax
      )
    : safeColor(fileBrowser.selectedStructure.getDefaultElementColor(element));

  colorBtn.style.background = hexToRgba(resetColor, 0.8);

  applyIndividualOpacity(fileBrowser.selectedStructure.atoms[atomIndex].getOpacity?.() ?? 1);
  onColorChange();
  updateVisualization({
    bondsUpdate: false,
    reRenderAtoms: false,
    reRenderBonds: false,
    reRenderLattice: false,
    reRenderOther: false,
    reRenderComposition: "open",
  });
  setActiveEditor(null);
};
  row.appendChild(editor);
  row.appendChild(coordEditor);
  row.appendChild(spinEditor);
  return row;
}
