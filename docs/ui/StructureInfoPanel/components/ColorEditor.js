import { fileBrowser, groups, general, structureShip } from '../../../state/store.js';
import { colorHexToCss, getAtomColor } from '../../../utils/ColorModule.js';
import { clampOpacity } from './utils.js';
import { updateSingleAtomColor, updateSingleAtomOpacity } from '../../../render/AtomsFracUpdateModule.js';
import { updateSingleBondColor } from '../../../render/BondsFracUpdateModule.js';
import { updatePolyhedraColors } from '../../../render/index.js';
import { createColorPicker } from '../../ColorPickerModule.js';
import { updateVisualization } from '../../../core/crystal-viewer.js';
import { bondLengthToColor } from '../../ColorPanel.js';

// Helper function to get the current color for an atom based on the active mode

// Helper: Ensure color is always a valid CSS hex string
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

export function createElementColorEditor(el, updatePieDotCallback, atomIndices) {
  // Get the current colors of all atoms for this element
  const currentAtomColors = atomIndices.map(index => safeColor(getAtomColor(index)));
  const currentOpacity = fileBrowser.selectedStructure.atoms[atomIndices[0]]?.getOpacity?.() ?? 1;

  const editor = document.createElement('div');
  editor.className = 'element-color-editor';
  editor.style.cssText = 'display:none; grid-column:2; padding:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px;';

  const picker = createColorPicker(currentAtomColors[0], (hex) => {
    const structure = fileBrowser.selectedStructure;
    const parsedHex = parseInt(hex.replace('#', ''), 16);

    atomIndices.forEach(atomIndex => {
      const atom = structure.atoms[atomIndex];
      atom.elementColor = parsedHex;
      structure.atomImages[atomIndex]?.forEach(imageIndex => {
        if (general.bondsColor == "elements") {
          if (structure.bondMapping[imageIndex]) {
            structure.bondMapping[imageIndex].forEach(bondHalvIndex => {
              updateSingleBondColor(bondHalvIndex, parsedHex, true);
              const indexset = structure.bondObjectMapping[bondHalvIndex];
              structure.bonds[indexset[0]].color[indexset[1]] = parsedHex;
            });
          }
        }
        updateSingleAtomColor(atomIndex, imageIndex, el, hex, hex);
      });
    });

    groups.atomsMesh.instanceColor.needsUpdate = true;
    groups.bondsMesh.instanceColor.needsUpdate = true;
    updatePieDotCallback(); // Update the pie dot
    // Polyhedra faces are coloured by element; recolour them in place to match (cheap,
    // no geometry recompute). The picker updates atom/bond meshes directly and otherwise
    // never triggers a polyhedra update.
    updatePolyhedraColors();
  });

  // --- Editor UI ---
  const topRow = document.createElement('div');
  topRow.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  topRow.appendChild(picker.element);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.cssText = 'height: 32px; padding: 0 10px; font-size: 11px; margin-right: 4px; min-width: 44px;';

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply to Trajectory';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 88px;';

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);

  const alphaRow = document.createElement('div');
  alphaRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:8px;';
  const alphaLabel = document.createElement('span');
  alphaLabel.textContent = 'Alpha';
  alphaLabel.style.cssText = 'font-size:11px; color: rgba(255,255,255,0.82); min-width: 34px;';
  const alphaSlider = document.createElement('input');
  alphaSlider.type = 'range';
  alphaSlider.min = '0.05';
  alphaSlider.max = '1';
  alphaSlider.step = '0.01';
  alphaSlider.value = String(currentOpacity);
  alphaSlider.style.cssText = 'flex:1;';
  const alphaValue = document.createElement('input');
  alphaValue.type = 'number';
  alphaValue.min = '0.05';
  alphaValue.max = '1';
  alphaValue.step = '0.01';
  alphaValue.value = currentOpacity.toFixed(2);
  alphaValue.style.cssText = 'width:56px; height:28px; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 11px;';
  alphaRow.appendChild(alphaLabel);
  alphaRow.appendChild(alphaSlider);
  alphaRow.appendChild(alphaValue);

  editor.appendChild(topRow);
  editor.appendChild(alphaRow);
  editor.appendChild(buttonRow);

  function textColorForBg(cssHex) {
    let hex = cssHex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? '#000' : '#fff';
  }

  const defaultColor = fileBrowser.selectedStructure.getDefaultElementColor(el);
  const defaultColorCss = safeColor(defaultColor);
  resetBtn.style.background = defaultColorCss;
  resetBtn.style.borderColor = 'rgba(0,0,0,0.15)';
  resetBtn.style.color = textColorForBg(defaultColorCss);

  function applyElementOpacity(rawValue) {
    const value = clampOpacity(rawValue);
    alphaSlider.value = String(value);
    alphaValue.value = value.toFixed(2);
    atomIndices.forEach((atomIndex) => {
      fileBrowser.selectedStructure.atoms[atomIndex].setElementOpacity(value);
      fileBrowser.selectedStructure.atoms[atomIndex].setOpacity(value);
      fileBrowser.selectedStructure.atomImages[atomIndex]?.forEach((imageIndex) => {
        updateSingleAtomOpacity(imageIndex, value);
      });
    });
  }

  alphaSlider.oninput = (e) => applyElementOpacity(/** @type {any} */ (e.target).value);
  alphaValue.oninput = (e) => applyElementOpacity(/** @type {any} */ (e.target).value);


  resetBtn.onclick = () => {
  const structure = fileBrowser.selectedStructure;
  const currentMode = general.atomsColor; // current color mode

  atomIndices.forEach((atomIndex) => {
    const atom = structure.atoms[atomIndex];
    const element = structure.elements[atomIndex];

    // clear user-color flag only for these atoms
    if (atom.userColor !== undefined) delete atom.userColor;
    if (atom.forceColor !== undefined) delete atom.forceColor;

    // set color based on current mode
    if (currentMode === "force") {
      // For force mode: calculate force-based color
      const forceObj = structure.forces?.[atomIndex];
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
      // For elements/other modes: use element default color
      atom.color = structure.getDefaultElementColor(element);
    }

    atom.setElementOpacity(1);
    atom.setOpacity(1);

    structure.atomImages[atomIndex]?.forEach((imageIndex) => {
      if (structure.bondMapping[imageIndex]) {
        structure.bondMapping[imageIndex].forEach((bondHalvIndex) => {
          updateSingleBondColor(bondHalvIndex, safeColor(atom.getColor()));
          const indexset = structure.bondObjectMapping[bondHalvIndex];
          structure.bonds[indexset[0]].color[indexset[1]] = safeColor(atom.getColor());
        });
      }
      updateSingleAtomColor(atomIndex, imageIndex, el);
      updateSingleAtomOpacity(imageIndex, atom.getOpacity());
    });
  });

  updatePieDotCallback();
  applyElementOpacity(1);
  updateVisualization({
    bondsUpdate: false,
    reRenderAtoms: false,
    reRenderBonds: false,
    reRenderLattice: false,
    reRenderOther: false,
    reRenderComposition: "open",
  });
};

  applyBtn.onclick = () => {
    updatePieDotCallback(); // Update the pie dot
    updateVisualization({
      bondsUpdate: false,
      reRenderAtoms: false,
      reRenderBonds: false,
      reRenderLattice: false,
      reRenderOther: false,
      reRenderComposition: "open",
    });
    structureShip.container[fileBrowser.selectedRowIndex].flushColorToAllStructures(fileBrowser.selectedStructure);
    editor.style.display = 'none';
  };

  return editor;
}
