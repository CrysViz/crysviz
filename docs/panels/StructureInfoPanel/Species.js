import {structureShip,app, groups,fileBrowser, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../../store.js';

import { updateVisualization } from '../../crystal-viewer.js';

import {setAtomColor,getAtomColor,colorHexToCss,hexToRgba,createPieDot,updatePieDot} from '../../modules/ColorModule.js'
import { createColorPicker } from '../../modules/ColorPickerModule.js';
import { updateSingleBondColor } from '../../modules/BondsFracUpdateModule.js'
import { updateSingleAtomColor, updateSingleAtomOpacity} from '../../modules/AtomsFracUpdateModule.js'
import {createSupercell} from '../../modules/SuperCellModule.js';
import {resetView,collapseAllAtomExpansions} from '../../panels/WindowAndSceneControls.js'
import { applyWyckoffOrbitPosition } from '../../modules/SymmetryEditModule.js';

function clampOpacity(value) {
  const opacity = Number(value);
  if (!Number.isFinite(opacity)) return 1;
  return Math.max(0, Math.min(1, opacity));
}

function getElementAtomIndices(element) {
  const atomIndices = [];
  fileBrowser.selectedStructure.elements.forEach((currentElement, index) => {
    if (currentElement === element) {
      atomIndices.push(index);
    }
  });
  return atomIndices;
}

function getElementOpacityValues(element) {
  return Array.from(new Set(
    getElementAtomIndices(element).map((atomIndex) => {
      const atom = fileBrowser.selectedStructure.atoms[atomIndex];
      return atom.getOpacity?.() ?? atom.opacity ?? 1;
    })
  ));
}

function setSwatchOpacity(swatch, opacity) {
  swatch.style.opacity = `${clampOpacity(opacity)}`;
}

export function createCompositionRow(el, count, total) {
  const container = document.createElement('div');
  container.className = 'comp-container';

  const row = document.createElement('div');
  row.className = 'comp-row';
  row.style.cssText = 'display:grid; grid-template-columns: auto 1fr; align-items:center; column-gap:8px; row-gap:6px; cursor: pointer; transition: background-color 0.2s ease;';

  const left = document.createElement('div');
  left.className = 'comp-left';
  const currentColors = fileBrowser.selectedStructure.getElementColors()[el] || ['#808080'];
  const currentColor = currentColors[0];
  const currentOpacity = getElementOpacityValues(el)[0] ?? 1;
  const dot = createPieDot(currentColors, 20);
  dot.classList.add('dot');
  setSwatchOpacity(dot, currentOpacity);

  const name = document.createElement('span');
  name.textContent = el;

  const expandIcon = document.createElement('span');
  expandIcon.textContent = '▶';
  expandIcon.style.cssText = 'margin-left: 4px; font-size: 14px; transition: transform 0.2s ease; color: rgba(255,255,255,0.8); transform: rotate(0deg);';

  left.appendChild(dot);
  left.appendChild(name);
  left.appendChild(expandIcon);

  const right = document.createElement('span');
  const pct = (100*count/total).toFixed(1);
  right.textContent = `${count} (${pct}%)`;

  row.appendChild(left);
  row.appendChild(right);

  const atomsContainer = document.createElement('div');
  atomsContainer.className = 'individual-atoms';
  atomsContainer.style.cssText = 'display: none; margin-left: 20px; margin-top: 8px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 8px;';

  const elementAtomIndices = getElementAtomIndices(el);

  for (let i = 0; i < elementAtomIndices.length; i++) {
    const actualAtomIndex = elementAtomIndices[i];
    const atomRow = createIndividualAtomRow(el, actualAtomIndex, i + 1);
    atomsContainer.appendChild(atomRow);
  }

  row.addEventListener('mouseenter', () => {
    row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });
  row.addEventListener('mouseleave', () => {
    row.style.backgroundColor = 'transparent';
  });

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = atomsContainer.style.display !== 'none';
    atomsContainer.style.display = isExpanded ? 'none' : 'block';
    expandIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
  });

  container.appendChild(row);
  container.appendChild(atomsContainer);

  const editor = document.createElement('div');
  editor.style.cssText = 'display:none; grid-column:2; padding:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px;';
  editor.className = 'color-editor';

  const atomIndices = getElementAtomIndices(el);
  const picker = createColorPicker(currentColor, (hex) => {
    const structure = fileBrowser.selectedStructure;
    let indexset;
    atomIndices.forEach(atomIndex => {
        const atom = structure.atoms[atomIndex];
        const parsedHex = parseInt(hex.replace('#', ''), 16);
        atom.elementColor = parsedHex;
        structure.atomImages[atomIndex]?.forEach(imageIndex => {
          if (structure.bondMapping[imageIndex]) {
            structure.bondMapping[imageIndex].forEach(bondHalvIndex =>{
              updateSingleBondColor(bondHalvIndex, hex)
              indexset = structure.bondObjectMapping[bondHalvIndex]
              structure.bonds[indexset[0]].color[indexset[1]] = hex
              });
           }
            updateSingleAtomColor(atomIndex, imageIndex, el,hex)
          });
      });  

    groups.atomsMesh.instanceColor.needsUpdate = true;
    groups.bondsMesh.instanceColor.needsUpdate = true;
    updatePieDot(dot, fileBrowser.selectedStructure.getElementColors()[el] || [hex]);
  });

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
    let hex = cssHex.replace('#','');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0,2), 16);
    const g = parseInt(hex.slice(2,4), 16);
    const b = parseInt(hex.slice(4,6), 16);
    const yiq = (r*299 + g*587 + b*114) / 1000;
    return yiq >= 128 ? '#000' : '#fff';
  }
  dot.style.cursor = 'pointer';
  row.style.cursor = 'default';
  dot.title = 'Customize color';
  dot.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = (editor.style.display === 'none') ? 'flex' : 'none';
    if (editor.style.display === 'flex') editor.style.flexDirection = 'column';
  };

  function applyElementOpacity(rawValue) {
    const value = clampOpacity(rawValue);
    alphaSlider.value = String(value);
    alphaValue.value = value.toFixed(2);
    setSwatchOpacity(dot, value);
    atomIndices.forEach((atomIndex) => {
      fileBrowser.selectedStructure.atoms[atomIndex].setOpacity(value);
      fileBrowser.selectedStructure.atomImages[atomIndex]?.forEach((imageIndex) => {
        updateSingleAtomOpacity(imageIndex, value);
      });
    });
  }

  alphaSlider.oninput = (e) => applyElementOpacity(e.target.value);
  alphaValue.oninput = (e) => applyElementOpacity(e.target.value);

  const defaultColorCss = colorHexToCss(fileBrowser.selectedStructure.getDefaultElementColor(el));
  resetBtn.style.background = defaultColorCss;
  resetBtn.style.borderColor = 'rgba(0,0,0,0.15)';
  resetBtn.style.color = textColorForBg(defaultColorCss);

  resetBtn.onclick = () => {
    atomIndices.forEach((atomIndex) => {
      const atom = fileBrowser.selectedStructure.atoms[atomIndex];
      atom.resetToDefaultColor();
      atom.resetOpacity();
      fileBrowser.selectedStructure.atomImages[atomIndex]?.forEach((imageIndex) => {
        if (fileBrowser.selectedStructure.bondMapping[imageIndex]) {
          fileBrowser.selectedStructure.bondMapping[imageIndex].forEach((bondHalvIndex) => {
            updateSingleBondColor(bondHalvIndex, colorHexToCss(atom.getColor()));
            const indexset = fileBrowser.selectedStructure.bondObjectMapping[bondHalvIndex];
            fileBrowser.selectedStructure.bonds[indexset[0]].color[indexset[1]] = colorHexToCss(atom.getColor());
          });
        }
        updateSingleAtomColor(atomIndex, imageIndex, el);
        updateSingleAtomOpacity(imageIndex, atom.getOpacity());
      });
    });
    updatePieDot(dot, fileBrowser.selectedStructure.getElementColors()[el] || [defaultColorCss]);
    applyElementOpacity(1);
    updateVisualization({
          bondsUpdate:false,
          reRenderAtoms: false,
          reRenderBonds: false,
          reRenderLattice: false,
          reRenderOther: false,
          reRenderComposition : "open",
      });
  };

   applyBtn.onclick = () => {
      updatePieDot(dot, fileBrowser.selectedStructure.getElementColors()[el] || [picker.getHex()]);
      updateVisualization({
          bondsUpdate:false,
          reRenderAtoms: false,
          reRenderBonds: false,
          reRenderLattice: false,
          reRenderOther: false,
          reRenderComposition: "open",
        });
      structureShip.container[fileBrowser.selectedRowIndex].flushColorToAllStructures(fileBrowser.selectedStructure);
      editor.style.display = 'none';

  };
  container.appendChild(editor);

  return container;
}  

export function createWyckoffCompositionRow(el, entries, total) {
  const container = document.createElement('div');
  container.className = 'comp-container';

  const row = document.createElement('div');
  row.className = 'comp-row';
  row.style.cssText = 'display:grid; grid-template-columns: auto 1fr; align-items:center; column-gap:8px; row-gap:6px; cursor: pointer; transition: background-color 0.2s ease;';

  const left = document.createElement('div');
  left.className = 'comp-left';
  const currElemColors = fileBrowser.selectedStructure.getElementColors()[el] || ['#808080'];
  const dot = createPieDot(currElemColors, 20);
  dot.classList.add('dot');
  setSwatchOpacity(dot, getElementOpacityValues(el)[0] ?? 1);

  const name = document.createElement('span');
  name.textContent = el;
  const expandIcon = document.createElement('span');
  expandIcon.textContent = '▶';
  expandIcon.style.cssText = 'margin-left: 4px; font-size: 14px; transition: transform 0.2s ease; color: rgba(255,255,255,0.8); transform: rotate(0deg);';

  left.appendChild(dot);
  left.appendChild(name);
  left.appendChild(expandIcon);

  const right = document.createElement('span');
  const pct = (100 * entries.length / total).toFixed(1);
  right.textContent = `${entries.length} (${pct}%)`;

  row.appendChild(left);
  row.appendChild(right);

  const atomsContainer = document.createElement('div');
  atomsContainer.className = 'individual-atoms';
  atomsContainer.style.cssText = 'display: none; margin-left: 20px; margin-top: 8px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 8px;';

  entries.forEach((entry, index) => {
    const atomRow = createIndividualAtomRow(el, entry.representativeIndex, index + 1, {
      linkedAtomIndices: entry.atomIndices,
      label: `${el}${index + 1}  ${entry.multiplicity}${entry.wyckoff}`,
      metaText: `${entry.siteSymmetry ? `${entry.siteSymmetry}  |  ` : ''}orbit ${entry.atomIndices.length}  |  ${entry.isFixed ? 'fixed' : `${entry.dofDimension} DOF`}`,
      positionUpdater: (coords) => applyWyckoffOrbitPosition(entry.representativeIndex, coords),
      resetCoordsProvider: () => fileBrowser.selectedStructure?.original?.atoms?.[entry.representativeIndex]?.position ?? null,
      positionEditable: !entry.isFixed,
    });
    atomsContainer.appendChild(atomRow);
  });

  row.addEventListener('mouseenter', () => {
    row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });
  row.addEventListener('mouseleave', () => {
    row.style.backgroundColor = 'transparent';
  });
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = atomsContainer.style.display !== 'none';
    atomsContainer.style.display = isExpanded ? 'none' : 'block';
    expandIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
  });

  container.appendChild(row);
  container.appendChild(atomsContainer);
  return container;
}

function createIndividualAtomRow(element, atomIndex, displayNumber = atomIndex + 1, options = {}) {
  const linkedAtomIndices = options.linkedAtomIndices ?? [atomIndex];
  const positionUpdater = options.positionUpdater ?? ((coords) => updateAtomCoordinates(atomIndex, coords));
  const resetCoordsProvider = options.resetCoordsProvider ?? (() => fileBrowser.selectedStructure?.original?.atoms?.[atomIndex]?.position ?? null);
  const positionEditable = options.positionEditable ?? true;
  const row = document.createElement('div');
  row.className = 'individual-atom-row';
  row.dataset.atomIndex = String(atomIndex);
  row.dataset.element = element;
  row.style.cssText = 'display: grid; grid-template-columns: auto 1fr auto; align-items: center; column-gap: 20px; padding: 4px 0; font-size: 11px;';

  const currentColor = colorHexToCss(getAtomColor(atomIndex));
  const currentOpacity = fileBrowser.selectedStructure.atoms[atomIndex].getOpacity?.() ?? fileBrowser.selectedStructure.atoms[atomIndex].opacity ?? 1;
  const dot = createPieDot([currentColor], 20);
  dot.className = 'dot';
  dot.style.cssText = 'width: 8px; height: 8px; margin-right: 6px; border: 1px solid rgba(255,255,255,0.4);';
  setSwatchOpacity(dot, currentOpacity);

  // Atom name and coordinates container
  const nameContainer = document.createElement('div');
  nameContainer.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

  const name = document.createElement('span');
  name.textContent = options.label ?? `${element}${displayNumber}  `;
  name.style.color = '#ddd';

  // Coordinates display (fractional)
  const coords = fileBrowser.selectedStructure.atoms.map(a => a.position)[atomIndex]
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

  // Color picker button
  const colorBtn = document.createElement('button');
  colorBtn.textContent = 'Color';
  colorBtn.style.cssText = 'border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px;';
  const choosenColor = hexToRgba(colorHexToCss(getAtomColor(atomIndex)),0.8);
  colorBtn.style.background = choosenColor;
  colorBtn.title = `Change color for ${element}${displayNumber}`;

  // Coordinate edit button
  const coordBtn = document.createElement('button');
  coordBtn.textContent = 'Position';
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
  spinBtn.style.cssText = 'background: var(--bg-color); border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 4px; cursor: pointer; font-size: 10px;';
  spinBtn.title = `Edit Spin for ${element}${displayNumber}`;

  buttonContainer.appendChild(colorBtn);
  buttonContainer.appendChild(coordBtn);
  buttonContainer.appendChild(spinBtn);

  row.appendChild(buttonContainer);

  // Create color editor for this individual atom
  const editor = document.createElement('div');
  editor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';
  const mom_color = colorHexToCss(getAtomColor(atomIndex))
  const picker = createColorPicker(mom_color, (hex) => {
    let structure = fileBrowser.selectedStructure
    let indexset
    linkedAtomIndices.forEach((linkedAtomIndex) => {
      structure.atomImages[linkedAtomIndex]?.forEach(imageIndex => {
         if (structure.bondMapping[imageIndex]) {
           structure.bondMapping[imageIndex].forEach(bondHalvIndex =>{
             updateSingleBondColor(bondHalvIndex, hex)
             indexset = structure.bondObjectMapping[bondHalvIndex]
             structure.bonds[indexset[0]].color[indexset[1]] = hex
           });
         }
         updateSingleAtomColor(linkedAtomIndex, imageIndex, structure.elements[linkedAtomIndex], hex)
      });
    });

    groups.atomsMesh.instanceColor.needsUpdate = true;
    groups.bondsMesh.instanceColor.needsUpdate = true;
    updatePieDot(dot, [hex]);
  });
  const AtomColorApplyBtn = document.createElement('button');
  AtomColorApplyBtn.textContent = 'Apply';
  AtomColorApplyBtn.className = 'btn-mini highlight';
  AtomColorApplyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  const AtomColorResetBtn = document.createElement('button');
  AtomColorResetBtn.textContent = 'Reset';
  AtomColorResetBtn.className = 'btn-mini';
  AtomColorResetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  // First row: color + hex
  const topRowIndiv = document.createElement('div');
  topRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';

  topRowIndiv.appendChild(picker.element);

  // Second row: buttons
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

  // Create coordinate editor for this individual atom
  const coordEditor = document.createElement('div');
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



  const spinEditor = document.createElement('div');
  spinEditor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const switchWrapper = document.createElement('div');
switchWrapper.style.cssText = `
  display: inline-flex;
  background: #2d2d2d;
  border-radius: 10px;
  padding: 4px;
  gap: 4px;
  font-size: 11px;
   min-width:98%;
     margin-bottom: 10px;
`;

function makeSwitchButton(label, active = false) {
  const btn = document.createElement('div');
  btn.textContent = label;
  btn.style.cssText = `
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    transition: 0.15s ease;
    user-select: none;
    font-weight: 500;
    min-width:40%;
    justify-content: center;
    display: flex;
  `;
  if (active) {
    btn.style.background = "#0d8a36";   // green highlight
    btn.style.color = "#fff";
  } else {
    btn.style.color = "rgba(255,255,255,0.8)";
  }
  return btn;
}

const spinSelectBtn = makeSwitchButton("Spin", true);
const forceSelectBtn = makeSwitchButton("Force", false);

// click behavior
spinSelectBtn.onclick = () => {
  spinSelectBtn.style.background = "#0d8a36";
  spinSelectBtn.style.color = "#fff";
  forceSelectBtn.style.background = "transparent";
  forceSelectBtn.style.color = "rgba(255,255,255,0.8)";
};

forceSelectBtn.onclick = () => {
  forceSelectBtn.style.background = "#0d8a36";
  forceSelectBtn.style.color = "#fff";
  spinSelectBtn.style.background = "transparent";
  spinSelectBtn.style.color = "rgba(255,255,255,0.8)";
};

switchWrapper.appendChild(spinSelectBtn);
switchWrapper.appendChild(forceSelectBtn);

spinEditor.appendChild(switchWrapper);  // replace your old title



  const spinApplyBtn = document.createElement('button');
  spinApplyBtn.textContent = 'Apply';
  spinApplyBtn.className = 'btn-mini highlight';
  spinApplyBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';

  const spinColorBtn = document.createElement('button');
  spinColorBtn.textContent = 'Color';
  spinColorBtn.className = 'btn-mini highlight';
  spinColorBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';
  const mom_spin_color = colorHexToCss(getAtomColor(atomIndex))
  spinColorBtn.style.background =mom_spin_color;

  const spinResetBtn = document.createElement('button');
  spinResetBtn.textContent = 'Reset';
  spinResetBtn.className = 'btn-mini';
  spinResetBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px; margin-right: 6px;';

  const xSpinInput = document.createElement('input');
  xSpinInput.type = 'number';
  xSpinInput.value = "0"
  xSpinInput.step = '0.001';
  xSpinInput.style.cssText = 'width: 60px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  xSpinInput.style.webkitAppearance = "none";
  xSpinInput.style.MozAppearance = "textfield";
  xSpinInput.placeholder = 'x';

  const ySpinInput = document.createElement('input');
  ySpinInput.type = 'number';
  ySpinInput.value = "0"
  ySpinInput.step = '0.001';
  ySpinInput.style.cssText = 'width: 60px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  ySpinInput.style.webkitAppearance = "none";
  ySpinInput.style.MozAppearance = "textfield";
  ySpinInput.placeholder = 'y';

  const zSpinInput = document.createElement('input');
  zSpinInput.type = 'number';
  zSpinInput.value = "0"
  zSpinInput.step = '0.001';
  zSpinInput.style.cssText = 'width: 60px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px;';
  zSpinInput.style.webkitAppearance = "none";
  zSpinInput.style.MozAppearance = "textfield";
  zSpinInput.placeholder = 'z';


  const scaleSpinInput = document.createElement('input');
  scaleSpinInput.type = 'number';
  scaleSpinInput.value = "0"
  scaleSpinInput.step = '0.001';
  scaleSpinInput.style.cssText = 'width: 60px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px;';
  scaleSpinInput.placeholder = 'scale';


  const spinInputsRow = document.createElement('div');
  spinInputsRow.style.cssText = 'display: flex; align-items: center; gap: 4px; margin-bottom: 6px;justify-content:center;';
  spinInputsRow.className="SpinInputRow"
  spinInputsRow.appendChild(xSpinInput);
  spinInputsRow.appendChild(ySpinInput);
  spinInputsRow.appendChild(zSpinInput);
  spinInputsRow.appendChild(scaleSpinInput);

  const spinButtonsRow = document.createElement('div');
  spinButtonsRow.style.cssText = 'display: flex; align-items: center; gap: 4px;justify-content:center;';
  spinButtonsRow.appendChild(spinResetBtn);
  spinButtonsRow.appendChild(spinApplyBtn);
  spinButtonsRow.appendChild(spinColorBtn);

  spinEditor.appendChild(spinInputsRow);
  spinEditor.appendChild(spinButtonsRow);

  // Create color editor for this individual atom
  const spinColorEditor = document.createElement('div');
  spinColorEditor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';
  const spinColorPicker = createColorPicker(mom_spin_color, (hex) => {
    //const ok = setIndividualAtomColor(element, atomIndex, hex);
    updatePieDot(dot, [hex]);
    updateVisualization({
          bondsUpdate:false,
          reRenderAtoms: false,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
   });
  const spinColorApplyBtn = document.createElement('button');
  spinColorApplyBtn.textContent = 'Apply';
  spinColorApplyBtn.className = 'btn-mini highlight';
  spinColorApplyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  const spinColorResetBtn = document.createElement('button');
  spinColorResetBtn.textContent = 'Reset';
  spinColorResetBtn.className = 'btn-mini';
  spinColorResetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  const spinColorEditorControls = document.createElement('div');
  spinColorEditorControls.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  // First row: color + hex
  const spinTopRowIndiv = document.createElement('div');
  spinTopRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';
  spinTopRowIndiv.appendChild(spinColorPicker.element);

  // Second row: buttons
  const spinButtonRowIndiv = document.createElement('div');
  spinButtonRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  spinButtonRowIndiv.appendChild(spinColorResetBtn);
  spinButtonRowIndiv.appendChild(spinColorApplyBtn);

  spinColorEditor.appendChild(spinTopRowIndiv);
  spinColorEditor.appendChild(spinButtonRowIndiv);
  spinEditor.appendChild(spinColorEditor);

  function applyIndividualOpacity(rawValue) {
    const value = clampOpacity(rawValue);
    atomAlphaSlider.value = String(value);
    atomAlphaValue.value = value.toFixed(2);
    setSwatchOpacity(dot, value);
    linkedAtomIndices.forEach((linkedAtomIndex) => {
      const atom = fileBrowser.selectedStructure.atoms[linkedAtomIndex];
      atom.setOpacity(value);
      fileBrowser.selectedStructure.atomImages[linkedAtomIndex]?.forEach((imageIndex) => {
        updateSingleAtomOpacity(imageIndex, value);
      });
    });
  }

  atomAlphaSlider.oninput = (e) => applyIndividualOpacity(e.target.value);
  atomAlphaValue.oninput = (e) => applyIndividualOpacity(e.target.value);

  //Event handlers
  spinColorBtn.onclick = (e) => {
      e.stopPropagation();
    spinColorEditor.style.display = (spinColorEditor.style.display === 'none') ? 'block' : 'none';
  };


  //Event handlers
  colorBtn.onclick = (e) => {
      e.stopPropagation();
    coordEditor.style.display = 'none'; // Hide coord editor
    spinEditor.style.display = 'none'; // Hide coord editor
    editor.style.display = (editor.style.display === 'none') ? 'block' : 'none';
  };

  coordBtn.onclick = (e) => {
    if (!positionEditable) return;
    e.stopPropagation();
    editor.style.display = 'none'; // Hide color editor
    spinEditor.style.display = 'none'; // Hide color editor
    coordEditor.style.display = (coordEditor.style.display === 'none') ? 'block' : 'none';
  };



  spinBtn.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = 'none'; // Hide color editor
    coordEditor.style.display = 'none'; // Hide coord editor
    spinEditor.style.display = (spinEditor.style.display === 'none') ? 'block' : 'none';
  };
  // Coordinate event handlers
  coordApplyBtn.onclick = () => {
    const newX = parseFloat(xInput.value);
    const newY = parseFloat(yInput.value);
    const newZ = parseFloat(zInput.value);

    if (!isNaN(newX) && !isNaN(newY) && !isNaN(newZ)) {
      positionUpdater([newX, newY, newZ]);
      coordsDisplay.textContent = `(${newX.toFixed(3)}, ${newY.toFixed(3)}, ${newZ.toFixed(3)})`;
      coordEditor.style.display = 'none';
    }
  };

  coordResetBtn.onclick = () => {
    // Reset to original coordinates
    const originalCoords = resetCoordsProvider();
    if (originalCoords) {
      xInput.value = originalCoords[0].toFixed(6);
      yInput.value = originalCoords[1].toFixed(6);
      zInput.value = originalCoords[2].toFixed(6);
      positionUpdater([...originalCoords]);
      coordsDisplay.textContent = `(${originalCoords[0].toFixed(3)}, ${originalCoords[1].toFixed(3)}, ${originalCoords[2].toFixed(3)})`;
      coordEditor.style.display = 'none';
    }
  };

  AtomColorApplyBtn.onclick = () => {
      editor.style.display = 'none';
  };

  AtomColorResetBtn.onclick = () => {
    linkedAtomIndices.forEach((linkedAtomIndex) => {
      const atom = fileBrowser.selectedStructure.atoms[linkedAtomIndex];
      atom.resetToElementColor();
      atom.resetOpacity();
      fileBrowser.selectedStructure.atomImages[linkedAtomIndex]?.forEach((imageIndex) => {
        if (fileBrowser.selectedStructure.bondMapping[imageIndex]) {
          fileBrowser.selectedStructure.bondMapping[imageIndex].forEach((bondHalvIndex) => {
            updateSingleBondColor(bondHalvIndex, colorHexToCss(atom.getColor()));
            const indexset = fileBrowser.selectedStructure.bondObjectMapping[bondHalvIndex];
            fileBrowser.selectedStructure.bonds[indexset[0]].color[indexset[1]] = colorHexToCss(atom.getColor());
          });
        }
        updateSingleAtomColor(linkedAtomIndex, imageIndex, fileBrowser.selectedStructure.elements[linkedAtomIndex]);
        updateSingleAtomOpacity(imageIndex, atom.getOpacity());
      });
    });
    const newColor = colorHexToCss(getAtomColor(atomIndex));
    updatePieDot(dot, [newColor]);
    applyIndividualOpacity(fileBrowser.selectedStructure.atoms[atomIndex].getOpacity?.() ?? 1);
    updateVisualization({
        bondsUpdate:false,
        reRenderAtoms: false,
        reRenderBonds : false,
        reRenderLattice : false,
        reRenderOther: false,
        reRenderComposition : true,
      });
    // Update the composition to refresh element colors
    editor.style.display = 'none';
  };

  row.appendChild(editor);
  row.appendChild(coordEditor);
  row.appendChild(spinEditor);
  return row;
}

// Function to update atom coordinates and refresh visualization
function updateAtomCoordinates(atomIndex, newCoords) {
  if (!fileBrowser.selectedStructure) {
   console.error("updateAtomCoordinates: selected structure not found");
   return;
  };  
  if (atomIndex >= fileBrowser.selectedStructure.atoms.length) {
    console.error('Invalid atom index or structure data');
    return;
  };

  const orbit = fileBrowser.selectedStructure.symmetry?.mode === 'wyckoff'
    ? fileBrowser.selectedStructure.symmetry.orbitGroups?.find((group) => group.atomIndices.includes(atomIndex))
    : null;
  if (orbit) {
    applyWyckoffOrbitPosition(orbit.representativeIndex, newCoords);
    return;
  }

  // Update the coordinates in the structure data
  
  fileBrowser.selectedStructure.atoms[atomIndex].position = [...newCoords];
  structureShip.container[fileBrowser.selectedRowIndex].structures[fileBrowser.stepInput].atoms[atomIndex].position = [...newCoords];

  // Refresh the visualization to show the updated position
  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: false,
    reRenderOther: true,
    reRenderComposition: "open",
  });

};
