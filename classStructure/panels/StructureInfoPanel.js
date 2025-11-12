import {app, groups, originalStructureData,structureData, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';

import { updateVisualization } from '../crystal-viewer.js';

import {colorHexToCss,hexToRgba,getElementColor,loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,createPieDot,clearIndividualAtomColor } from '../modules/ColorModule.js';

import { createColorPicker } from '../old_style/color-picker.js';
import { updateBonds } from '../modules/BondsModule.js'
import {createSupercell} from '../modules/SuperCellModule.js';
import {resetView,collapseAllAtomExpansions} from '../panels/WindowAndSceneControls.js'

export function createCompositionRow(el, count, total) {
  const container = document.createElement('div');
  container.className = 'comp-container';

  const row = document.createElement('div');
  row.className = 'comp-row';
  // Two-column grid: left (fixed auto), right (flex). Editor lives under right.
  row.style.cssText = 'display:grid; grid-template-columns: auto 1fr; align-items:center; column-gap:8px; row-gap:6px; cursor: pointer; transition: background-color 0.2s ease;';

  const left = document.createElement('div');
  left.className = 'comp-left';
  const currentColor = getElementDisplayColor(el);
  const curr_elem_colors = getElementDisplayColor(el);
  let dot;

  if (curr_elem_colors.length > 1) {
    dot = createPieDot(curr_elem_colors, 20);
    dot.classList.add('dot');
  } else {
    dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = curr_elem_colors[0];
  }

  const name = document.createElement('span');
  name.textContent = el;

  // Add expand/collapse indicator - starts collapsed
  const expandIcon = document.createElement('span');
  expandIcon.textContent = '▶';
  expandIcon.style.cssText = 'margin-left: 4px; font-size: 14px; transition: transform 0.2s ease; color: rgba(255,255,255,0.8); transform: rotate(0deg);';

  left.appendChild(dot);
  left.appendChild(name);
  left.appendChild(expandIcon);

  const right = document.createElement('span');
  const pct = (100*count/total).toFixed(1);
  right.textContent = `${count} (${pct}%)`;

  row.appendChild(left); // grid col 1
  row.appendChild(right); // grid col 2


  // Create individual atoms container (hidden by default)
  const atomsContainer = document.createElement('div');
  atomsContainer.className = 'individual-atoms';
  atomsContainer.style.cssText = 'display: none; margin-left: 20px; margin-top: 8px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 8px;';

  // Create individual atom rows - need to map element-specific indices to actual structure indices
  const elementAtomIndices = [];
  for (let i = 0; i < structureData.elements.length; i++) {
    if (structureData.elements[i] === el) {
      elementAtomIndices.push(i);
    }
  }

  for (let i = 0; i < elementAtomIndices.length; i++) {
    const actualAtomIndex = elementAtomIndices[i];
    const atomRow = createIndividualAtomRow(el, actualAtomIndex, i + 1); // Pass display number as well
    atomsContainer.appendChild(atomRow);
  }

  // Add hover effects
  row.addEventListener('mouseenter', () => {
    row.style.backgroundColor = 'rgba(255,255,255,0.03)';
  });
  row.addEventListener('mouseleave', () => {
    row.style.backgroundColor = 'transparent';
  });

  // Add click handler for expand/collapse
  row.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering parent events
    const isExpanded = atomsContainer.style.display !== 'none';

    // Toggle this element's expansion
    atomsContainer.style.display = isExpanded ? 'none' : 'block';
    expandIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
  });

  container.appendChild(row);
  container.appendChild(atomsContainer);

  // Inline color editor (hidden by default)
  const editor = document.createElement('div');
  // Make editor occupy only the right column and not depend on name length
  editor.style.cssText = 'display:none; grid-column:2; padding:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px;';
  editor.className = 'color-editor';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = currentColor;
  colorInput.style.cssText = 'width: 32px; height: 32px; border: none; background: transparent; cursor: pointer; flex-shrink: 0; margin: 0; padding: 0; box-sizing: border-box; vertical-align: top;';

  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.value = currentColor;
  hexInput.placeholder = '#RRGGBB';
  hexInput.style.cssText = 'width: 80px; height: 32px; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); color: #e7f5ff; font-size: 12px; margin: 0; box-sizing: border-box; vertical-align: top;';

  const mom_color = getElementDisplayColor(el);

  const picker = createColorPicker(mom_color[0], (hex) => {
    clearAllIndividualColorsForElement(el);      // Clear old color overrides
    const ok = setElementColorOverride(el, hex); // Apply new color override
    dot.style.background = hex;
      if (ok) {
        updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
      }
    });
  // Single line: color swatch + hex field + buttons
  const topRow = document.createElement('div');
  topRow.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  topRow.appendChild(picker.element);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.cssText = 'height: 32px; padding: 0 10px; font-size: 11px; margin-right: 4px; min-width: 44px;';

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  // Add buttons to the same row
  // Create separate button row
  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 6px;';
  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);

  // Assembly: two rows
  editor.appendChild(topRow);
  editor.appendChild(buttonRow);
  row.appendChild(editor);

  // Helper to decide readable text color over a background
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
  // Only sync inputs; application happens on Apply button
  colorInput.oninput = (e) => { hexInput.value = e.target.value; };
  hexInput.oninput = (e) => { colorInput.value = e.target.value; };

  // Style reset button with the element's default palette color
  const defaultColorCss = colorHexToCss(getDefaultElementColor(el));
  resetBtn.style.background = defaultColorCss;
  resetBtn.style.borderColor = 'rgba(0,0,0,0.15)';
  resetBtn.style.color = textColorForBg(defaultColorCss);

  // Reset clears both element-wide override AND all individual colors for this element
  resetBtn.onclick = () => {
    clearElementColorOverride(el);
    clearAllIndividualColorsForElement(el);
    updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
  };

   applyBtn.onclick = () => {
      dot.style.background = picker.getHex;
      renderComposition();
      updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
      editor.style.display = 'none';

  };
  // Add element-wide color editor to container (after individual atoms)
  container.appendChild(editor);

  return container;
}  

function createIndividualAtomRow(element, atomIndex, displayNumber = atomIndex + 1) {
  const row = document.createElement('div');
  row.className = 'individual-atom-row';
  row.style.cssText = 'display: grid; grid-template-columns: auto 1fr auto; align-items: center; column-gap: 20px; padding: 4px 0; font-size: 11px;';

  // Individual atom dot with its specific color
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; border: 1px solid rgba(255,255,255,0.4);';
  const currentColor = colorHexToCss(getIndividualAtomColor(element, atomIndex));
  dot.style.background = currentColor;

  // Atom name and coordinates container
  const nameContainer = document.createElement('div');
  nameContainer.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

  const name = document.createElement('span');
  name.textContent = `${element}${displayNumber}  `;
  name.style.color = '#ddd';

  // Coordinates display (fractional)
  const coords = structureData.positions[atomIndex];
  const coordsDisplay = document.createElement('span');
  coordsDisplay.style.cssText = 'font-size: 9px; color: rgba(255,255,255,0.8); font-family: monospace;';
  coordsDisplay.textContent = `(${coords[0].toFixed(3)}, ${coords[1].toFixed(3)}, ${coords[2].toFixed(3)})`;

  nameContainer.appendChild(name);
  nameContainer.appendChild(coordsDisplay);

  row.appendChild(nameContainer);
  // Button container
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = 'display: flex; gap: 10px;';

  // Color picker button
  const colorBtn = document.createElement('button');
  colorBtn.textContent = 'Color';
  colorBtn.style.cssText = 'border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; min-width: 22px;';
  const choosenColor = hexToRgba(colorHexToCss(getIndividualAtomColor(element, atomIndex)),0.8);
  colorBtn.style.background = choosenColor;
  colorBtn.title = `Change color for ${element}${displayNumber}`;

  // Coordinate edit button
  const coordBtn = document.createElement('button');
  coordBtn.textContent = 'Position';
  coordBtn.style.cssText = 'background: rgba(6,100,50,0.8); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; min-width: 22px;';
  coordBtn.title = `Edit coordinates for ${element}${displayNumber}`;

  buttonContainer.appendChild(colorBtn);
  buttonContainer.appendChild(coordBtn);

  row.appendChild(buttonContainer);

  // Create color editor for this individual atom
  const editor = document.createElement('div');
  editor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';
  const mom_color = colorHexToCss(getIndividualAtomColor(element, atomIndex))
  const picker = createColorPicker(mom_color, (hex) => {
    const ok = setIndividualAtomColor(element, atomIndex, hex);
    dot.style.background = hex;
      if (ok) {
        updateBonds()
        updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
      }
  });
const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'btn-mini';
  resetBtn.style.cssText = 'height: 32px; padding: 0 4px; font-size: 11px; min-width: 44px; width: 44px;';

  const editorControls = document.createElement('div');
  editorControls.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  // First row: color + hex
  const topRowIndiv = document.createElement('div');
  topRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px;';

  topRowIndiv.appendChild(picker.element);

  // Second row: buttons
  const buttonRowIndiv = document.createElement('div');
  buttonRowIndiv.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  buttonRowIndiv.appendChild(resetBtn);
  buttonRowIndiv.appendChild(applyBtn);

  editor.appendChild(topRowIndiv);
  editor.appendChild(buttonRowIndiv);

  // Create coordinate editor for this individual atom
  const coordEditor = document.createElement('div');
  coordEditor.style.cssText = 'display: none; grid-column: 1 / -1; margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;';

  const coordTitle = document.createElement('div');
  coordTitle.textContent = 'Fractional Coordinates';
  coordTitle.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.8); margin-bottom: 6px; font-weight: 500;';
  const xInput = document.createElement('input');
  xInput.type = 'number';
  xInput.value = coords[0].toFixed(6);
  xInput.step = '0.000001';
  xInput.style.cssText = 'width: 80px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  xInput.placeholder = 'x';

  const yInput = document.createElement('input');
  yInput.type = 'number';
  yInput.value = coords[1].toFixed(6);
  yInput.step = '0.000001';
  yInput.style.cssText = 'width: 80px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px; margin-right: 4px;';
  yInput.placeholder = 'y';

  const zInput = document.createElement('input');
  zInput.type = 'number';
  zInput.value = coords[2].toFixed(6);
  zInput.step = '0.000001';
  zInput.style.cssText = 'width: 80px; padding: 4px 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: white; font-size: 11px;';
  zInput.placeholder = 'z';

  const coordInputsRow = document.createElement('div');
  coordInputsRow.style.cssText = 'display: flex; align-items: center; gap: 4px; margin-bottom: 6px;';
  coordInputsRow.appendChild(xInput);
  coordInputsRow.appendChild(yInput);
  coordInputsRow.appendChild(zInput);
  const coordApplyBtn = document.createElement('button');
  coordApplyBtn.textContent = 'Apply';
  coordApplyBtn.className = 'btn-mini highlight';
  coordApplyBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px;';

  const coordResetBtn = document.createElement('button');
  coordResetBtn.textContent = 'Reset';
  coordResetBtn.className = 'btn-mini';
  coordResetBtn.style.cssText = 'height: 32px; padding: 0 8px; font-size: 11px; min-width: 50px; margin-right: 6px;';

  const coordButtonsRow = document.createElement('div');
  coordButtonsRow.style.cssText = 'display: flex; align-items: center; gap: 4px;';
  coordButtonsRow.appendChild(coordResetBtn);
  coordButtonsRow.appendChild(coordApplyBtn);

  coordEditor.appendChild(coordTitle);
  coordEditor.appendChild(coordInputsRow);
  coordEditor.appendChild(coordButtonsRow);

  //Event handlers
  colorBtn.onclick = (e) => {
      e.stopPropagation();
    coordEditor.style.display = 'none'; // Hide coord editor
    editor.style.display = (editor.style.display === 'none') ? 'block' : 'none';
  };


  coordBtn.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = 'none'; // Hide color editor
    coordEditor.style.display = (coordEditor.style.display === 'none') ? 'block' : 'none';
  };
  // Coordinate event handlers
  coordApplyBtn.onclick = () => {
    const newX = parseFloat(xInput.value);
    const newY = parseFloat(yInput.value);
    const newZ = parseFloat(zInput.value);

    if (!isNaN(newX) && !isNaN(newY) && !isNaN(newZ)) {
      updateAtomCoordinates(atomIndex, [newX, newY, newZ]);
      coordsDisplay.textContent = `(${newX.toFixed(3)}, ${newY.toFixed(3)}, ${newZ.toFixed(3)})`;
      coordEditor.style.display = 'none';
    }
  };

  coordResetBtn.onclick = () => {
    // Reset to original coordinates
    if (originalStructureData && originalStructureData.positions[atomIndex]) {
      const originalCoords = originalStructureData.positions[atomIndex];
      xInput.value = originalCoords[0].toFixed(6);
      yInput.value = originalCoords[1].toFixed(6);
      zInput.value = originalCoords[2].toFixed(6);
      updateAtomCoordinates(atomIndex, [...originalCoords]);
      coordsDisplay.textContent = `(${originalCoords[0].toFixed(3)}, ${originalCoords[1].toFixed(3)}, ${originalCoords[2].toFixed(3)})`;
      coordEditor.style.display = 'none';
    }
  };

  applyBtn.onclick = () => {
      dot.style.background = picker.getHex;
      renderComposition();
      editor.style.display = 'none';
  };

  resetBtn.onclick = () => {
    clearIndividualAtomColor(element, atomIndex);
    const newColor = colorHexToCss(getIndividualAtomColor(element, atomIndex));
    dot.style.background = newColor;
    //colorInput.value = newColor;
   // hexInput.value = newColor;
    updateVisualization();
    // Update the composition to refresh element colors
    renderComposition();
    editor.style.display = 'none';
  };

  row.appendChild(editor);
  row.appendChild(coordEditor);
  return row;
}

// Function to update atom coordinates and refresh visualization
function updateAtomCoordinates(atomIndex, newCoords) {
  if (!structureData || !structureData.positions || atomIndex >= structureData.positions.length) {
    console.error('Invalid atom index or structure data');
    return;
  }

  // Update the coordinates in the structure data
  structureData.positions[atomIndex] = [...newCoords];

  // Refresh the visualization to show the updated position
  updateVisualization();

  console.log(`Updated atom ${atomIndex} coordinates to: ${newCoords.join(', ')}`);
};


// Function to handle structure panel toggle
export function handleStructurePanelToggle() {
  const composition = document.getElementById('composition');
  if (composition && !composition.classList.contains('open')) {
    // Structure panel is being collapsed, so collapse all atom expansions
    collapseAllAtomExpansions();
  }
};

export function getCompositionString() {
  function computeComposition() {
    if (!structureData) return {};
      const counts = {};
      structureData.elements.forEach(e => counts[e] = (counts[e] || 0) + 1);
    return counts;
  }
  // Generate the chemical formula as a string
  const counts = computeComposition();
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const elements = Object.keys(counts).sort();

  let formula = '';

  // Iterate through the counts object and build the formula string
  for (const element in counts) {
    const count = counts[element];
    if (general.currentSupercell === null) {
      formula += element + (count > 1 ? `<sub>${count}</sub>` : ''); // Add subscript if count > 1
    } else {
      const supercellSize = general.currentSupercell.nx * general.currentSupercell.ny * general.currentSupercell.nz;
      // Divide the count by the supercell size
      const currCount = count / supercellSize;
      formula += element + (currCount > 1 ? `<sub>${Math.round(currCount)}</sub>` : ''); // Add subscript if count > 1
    }
  }

  // Set the composition string in the 'h4' of the #structureToggle
  const structureToggleHeading = document.querySelector('#structureToggle h4');
  if (structureToggleHeading) {
    structureToggleHeading.innerHTML = formula + ` (${total} Atoms)`; // Use innerHTML to allow HTML tags
  }

  // Display the chemical formula and the total number of atoms
  const compString = document.createElement('div');
  compString.innerHTML = `${formula} (${total} Atoms)`; // Use innerHTML to allow HTML tags
  compString.style.cssText = 'font-size:12px; font-weight:500; margin-bottom:10px;';

  const compWrapper = document.querySelector('#composition');
  compWrapper.appendChild(compString);

  // Return elements, counts, and total
  return { elements, counts, total };
}


export function renderComposition() {

  const {elements, counts, total}=getCompositionString()

  const compDiv = document.getElementById('composition');
  compDiv.innerHTML = '';
   const compString = document.createElement('div');
  const compWrapper = document.createElement('div');
    compWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;


  const title = document.createElement('div');
  const titleWrapper = document.createElement('div');
    titleWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;

  title.textContent = 'Modify Color/Positions';
  title.style.cssText = 'font-size:14px; font-weight:500; margin-bottom:10px;';

  titleWrapper.appendChild(title);
  compDiv.appendChild(titleWrapper);

  // Ensure structure panel starts collapsed by default
  compDiv.classList.remove('open');
  compDiv.style.maxHeight = ''; // reset
  const toggleIcon = document.getElementById('structureToggleIcon');
  if (toggleIcon) {
    toggleIcon.textContent = '+';
    toggleIcon.classList.remove('open');
  }
  const structureToggle = document.getElementById('structureToggle');
  if (structureToggle) {
    structureToggle.setAttribute('aria-expanded', 'false');
    // Rebind listener cleanly
    structureToggle.removeEventListener('click', handleStructurePanelToggle);
    structureToggle.addEventListener('click', handleStructurePanelToggle);
  }



  // Render ALL rows directly (no “+N more” collapsing)
  elements.forEach(el => {
    const row = createCompositionRow(el, counts[el], total);
    compDiv.appendChild(row);
  });

  // Lattice parameters section
  addSupercellSection();
  addLatticeParametersSection();
}


export function addSupercellSection() {
  const compDiv = document.getElementById('composition');
  if (!compDiv || !structureData) return;
  const resetWrapper = document.createElement('div');
  resetWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 16px;
  `;

  const fullColorResetBtn = document.createElement('button');
  fullColorResetBtn.textContent = 'Reset All Colors';
  fullColorResetBtn.className = 'reset-btn';
  fullColorResetBtn.style.cssText = `
    height: 32px;
    padding: 6px 12px;
    font-size: 12px;
    min-width: 50px;
    cursor: pointer;
  `;

  fullColorResetBtn.onclick = () => {
    const uniqueElements = new Set(structureData.elements);
    for (const element of uniqueElements) {
      clearElementColorOverride(element);
      clearAllIndividualColorsForElement(element);
    }
    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: false,
      reRenderOther: true,
    });
  };
 resetWrapper.appendChild(fullColorResetBtn);
  compDiv.appendChild(resetWrapper);

  // Wrapper section
  const supercellSection = document.createElement('div');
  supercellSection.id = 'supercellSection';
  supercellSection.style.cssText = `
    border-top: 2px solid rgba(255,255,255,0.1);
    margin-top: 12px;
    padding-top: 12px;
    color: rgba(255,255,255,0.85);
  `;

  // Title
  const title = document.createElement('div');
  const titleWrapper = document.createElement('div');
    titleWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;

  title.textContent = 'Create Supercell';
  title.style.cssText = 'font-size:14px; font-weight:500; margin-bottom:10px;';

  titleWrapper.appendChild(title);
  supercellSection.appendChild(titleWrapper);

    // --- Initialize supercell values ---
  if (!structureData.supercell) structureData.supercell = { nx: 1, ny: 1, nz: 1 };
  const { nx,ny,nz } = structureData.supercell;

  // --- Input row ---
  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display:flex; gap:6px; margin-bottom:8px;justify-content: center;';
  const inputs = {};
  ['nx', 'ny', 'nz'].forEach(axis => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    if (general.currentSupercell != null) {
    input.value = general.currentSupercell[axis];
    }
    else{
      input.value = 1
    }
    input.style.cssText =
      'width:50px; text-align:center; border:none; border-radius:4px; background:rgba(255,255,255,0.1); color:white; font-family:monospace; padding:3px;';
    inputs[axis] = input;
    inputRow.appendChild(input);
  });
  supercellSection.appendChild(inputRow);

  // --- Buttons row ---
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px;';

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'mini-btn';
  applyBtn.style.cssText =
    'flex:1; background:rgba(255,255,255,0.15); border:none; border-radius:6px; color:white; height:28px; cursor:pointer;';


  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'reset-btn';
  resetBtn.style.cssText =
    'flex:1; border:none; border-radius:6px; color:white; height:28px; cursor:pointer;';


  btnRow.appendChild(applyBtn);
  btnRow.appendChild(resetBtn);
  supercellSection.appendChild(btnRow);
  // --- Apply logic ---
  applyBtn.onclick = () => {
    const newA = Math.max(1, parseInt(inputs.nx.value));
    const newB = Math.max(1, parseInt(inputs.ny.value));
    const newC = Math.max(1, parseInt(inputs.nz.value));
    structureData.supercell = { nx: newA, ny: newB, nz: newC };

    // Restore pristine structure from originalStructureData
    structureData.atoms = structuredClone(originalStructureData.atoms);
    structureData.lattice = structuredClone(originalStructureData.lattice);
    structureData.elements = structuredClone(originalStructureData.elements);

    // Build supercell
    createSupercell(newA, newB, newC);
    updateVisualization({
        reRenderAtoms: true,
        reRenderBonds: true,
        reRenderLattice: true
      });
    resetView()
  };

  resetBtn.onclick = () => {
    createSupercell(1, 1, 1);
    updateVisualization({
        reRenderAtoms: true,
        reRenderBonds: true,
        reRenderLattice: true
      });
    resetView()
  }
  // --- Attach section ---
  compDiv.appendChild(supercellSection);
}

// Function to add lattice parameters section to composition
//

function addLatticeParametersSection() {
  const compDiv = document.getElementById('composition');
  if (!compDiv || !structureData || !structureData.lattice) return;

  const oldSection = document.getElementById('latticeSection');
  if (oldSection) oldSection.remove();

  const latticeSection = document.createElement('div');
  latticeSection.id = 'latticeSection';
  latticeSection.style.cssText = `
    border-top: 2px solid rgba(255,255,255,0.1);
    margin-top: 12px;
    padding-top: 12px;
    color: rgba(255,255,255,0.85);
    font-size: 13px;
  `;


  const title = document.createElement('div');
  const titleWrapper = document.createElement('div');
    titleWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;

  title.textContent = 'Modify Lattice';
  title.style.cssText = 'font-size:14px; font-weight:500; margin-bottom:10px;';

  titleWrapper.appendChild(title);
  latticeSection.appendChild(titleWrapper);

   const latticeResetBtnWrapper = document.createElement('div');
    latticeResetBtnWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;

  const latticeResetBtn = document.createElement('button');
  latticeResetBtn.textContent = 'Reset Lattice';
  latticeResetBtn.className = 'reset-btn';
  latticeResetBtn.id = 'LatticeResetBtn';
  latticeResetBtn.style.cssText = `
    height: 28px;
    padding: 4px 10px;
    font-size: 12px;
    margin-bottom: 10px;
    cursor: pointer;
    border: none;
    border-radius: 4px;
    color: white;
  `;
  latticeResetBtnWrapper.appendChild(latticeResetBtn);
  latticeSection.appendChild(latticeResetBtnWrapper);

 // ---- Toggle controls ----
  const toggleRow = document.createElement('div');
  toggleRow.style.cssText = 'display:flex; justify-content:center; align-items:center; margin-bottom:8px;';

  const toggleLabel = document.createElement('span');
  toggleLabel.textContent = 'Input Option:    ';
  toggleLabel.style.cssText = 'font-weight:600; color:rgba(255,255,255,0.8);';

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Matrix';
  toggleBtn.className = 'mini-btn';
  toggleBtn.style.cssText = `
    height:24px; padding:2px 8px; font-size:12px; cursor:pointer;
    border:none; border-radius:4px; background:rgba(255,255,255,0.1); color:white;margin-left:8px;
  `;

  toggleRow.appendChild(toggleLabel);
  toggleRow.appendChild(toggleBtn);
  latticeSection.appendChild(toggleRow);


  // ---- Container for inputs ----
  const viewContainer = document.createElement('div');
  latticeSection.appendChild(viewContainer);

  // ---- Volume display ----
  const volumeDiv = document.createElement('div');
  volumeDiv.style.cssText = 'margin-top:8px; font-size:13px; color:rgba(255,255,255,0.8);';
  latticeSection.appendChild(volumeDiv);

  compDiv.appendChild(latticeSection);

  // ===== Helper math functions =====
  const norm = (v) => Math.hypot(v[0], v[1], v[2]);
  const dot = (u, v) => u[0]*v[0] + u[1]*v[1] + u[2]*v[2];
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const acosDeg = (x) => Math.acos(clamp(x, -1, 1)) * 180 / Math.PI;
  const deg2rad = (deg) => deg * Math.PI / 180;
  const cross = (a,b) => [
    a[1]*b[2]-a[2]*b[1],
    a[2]*b[0]-a[0]*b[2],
    a[0]*b[1]-a[1]*b[0]
  ];

  function updateVolumeDisplay(L) {
    const V = Math.abs(dot(L[0], cross(L[1], L[2])));
    volumeDiv.textContent = `Volume: ${V.toFixed(3)} Å³`;
  }

  // ===== Lattice Parameter View =====
  function renderLatticeParams() {
    viewContainer.innerHTML = '';
    const L = structureData.lattice;
    const a = norm(L[0]);
    const b = norm(L[1]);
    const c = norm(L[2]);
    const alpha = acosDeg(dot(L[1], L[2]) / (b * c || 1));
    const beta  = acosDeg(dot(L[0], L[2]) / (a * c || 1));
    const gamma = acosDeg(dot(L[0], L[1]) / (a * b || 1));

    const params = { a, b, c, alpha, beta, gamma };
    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';
    const tbody = document.createElement('tbody');

    for (const [key, val] of Object.entries(params)) {
      const tr = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.textContent = key;
      tdLabel.style.cssText = 'padding:4px;';

      const tdInput = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.value = val.toFixed(4);
      input.step = key.length === 1 ? '0.01' : '0.1';
      input.style.cssText = 'width:80px; text-align:right; font-family:monospace; padding:2px;';
      input.id = `${key}Input`;
      input.oninput = () => {
        const vals = {
          a: parseFloat(document.querySelector('#aInput').value),
          b: parseFloat(document.querySelector('#bInput').value),
          c: parseFloat(document.querySelector('#cInput').value),
          alpha: parseFloat(document.querySelector('#alphaInput').value),
          beta: parseFloat(document.querySelector('#betaInput').value),
          gamma: parseFloat(document.querySelector('#gammaInput').value),
        };
        if (Object.values(vals).some(v => !isFinite(v))) return;

        const { a, b, c, alpha, beta, gamma } = vals;
        const cosA = Math.cos(deg2rad(alpha));
        const cosB = Math.cos(deg2rad(beta));
        const cosG = Math.cos(deg2rad(gamma));
        const sinG = Math.sin(deg2rad(gamma));
        const Lnew = [
          [a, 0, 0],
          [b*cosG, b*sinG, 0],
          [c*cosB, c*(cosA - cosB*cosG)/sinG, c*Math.sqrt(1 - cosB**2 - ((cosA - cosB*cosG)/sinG)**2)]
        ];
        general.modifiedLattice = Lnew;
        structureData.lattice = Lnew;
        updateVisualization({
          reRenderAtoms: true,
          reRenderBonds: true,
          reRenderLattice: true,
          reRenderOther: false
        });
        updateVolumeDisplay(Lnew);
      };
      tdInput.appendChild(input);
      tr.appendChild(tdLabel);
      tr.appendChild(tdInput);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    viewContainer.appendChild(table);
    updateVolumeDisplay(L);
  }
  // ===== Matrix View =====
  function renderMatrixView() {
    viewContainer.innerHTML = '';
    const L = structureData.lattice;

    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:12px;';
    const tbody = document.createElement('tbody');

    for (let i = 0; i < 3; i++) {
      const tr = document.createElement('tr');
      for (let j = 0; j < 3; j++) {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'number';
        input.value = L[i][j].toFixed(4);
        input.step = '0.01';
        input.style.cssText = 'width:80px; text-align:right; font-family:monospace; padding:2px;';
        input.oninput = () => {
          const val = parseFloat(input.value);
          if (isFinite(val)) {
            structureData.lattice[i][j] = val;
            updateVisualization({
                        reRenderAtoms: true,
                        reRenderBonds: true,
                        reRenderLattice: true,
                        reRenderOther: false
            });
            updateVolumeDisplay(structureData.lattice);
          }
        };
        general.modifiedLattice = structureData.lattice
        td.appendChild(input);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    viewContainer.appendChild(table);
    updateVolumeDisplay(L);
  }

  // ===== Event Handlers =====
  let showMatrix = false;
  toggleBtn.onclick = () => {
    showMatrix = !showMatrix;
    toggleBtn.textContent = showMatrix ? 'Parameters' : 'Show Matrix';
    showMatrix ? renderMatrixView() : renderLatticeParams();
  };

  latticeResetBtn.onclick = () => {
    const originalData = JSON.parse(JSON.stringify(originalStructureData));
    //createSupercell(1,1,1)
    general.modifiedLattice = null
    structureData.lattice = originalData.lattice
    if (general.currentSupercell != null){
      createSupercell(general.currentSupercell.nx,general.currentSupercell.ny,general.currentSupercell.nz)
    }
    updateVisualization({ reRenderAtoms:true, reRenderBonds:true, reRenderLattice:true,reRenderOther:true });
    resetView();
    (showMatrix ? renderMatrixView : renderLatticeParams)();
  };

  // Initial render
  renderLatticeParams();

}  




