import {structureShip,app, groups,fileBrowser, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../../store.js';

import { updateVisualization } from '../../crystal-viewer.js';

import {colorHexToCss,hexToRgba,getElementColor,loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,createPieDot,clearIndividualAtomColor } from '../../modules/ColorModule.js';

import { createColorPicker } from '../../old_style/color-picker.js';
import { updateBonds } from '../../modules/BondsModule.js'
import { updateSingleBondColor } from '../../modules/BondsFracUpdateModule.js'
import {createSupercell} from '../../modules/SuperCellModule.js';
import {resetView,collapseAllAtomExpansions} from '../../panels/WindowAndSceneControls.js'

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
  let elements = [...fileBrowser.selectedStructure.elements]
  for (let i = 0; i < elements.length; i++) {
    if (elements[i] === el) {
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
  let  atomIndices=[]
  fileBrowser.selectedStructure.elements.forEach((element, index)=> {
    if (element === el) {
       atomIndices.push(index)
    }
  });

  const picker = createColorPicker(mom_color[0], (hex) => {
    clearAllIndividualColorsForElement(el);      // Clear old color overrides
    const ok = setElementColorOverride(el, hex); // Apply new color override



    //FIXME: this needs to also update the atoms 
    atomIndices.forEach(atomIndex => {
      fileBrowser.selectedStructure.atomImages[atomIndex].forEach(imageIndex => {
        fileBrowser.selectedStructure.bondMapping[imageIndex].forEach(bondHalvIndex =>{
          console.log(bondHalvIndex)
          updateSingleBondColor(bondHalvIndex, hex)
          //updateSingleAtomColor(originalIndex=atomIndex, element=element, opacity = 1.0)
        });
      });
    });  
    groups.atomsMesh.instanceColor.needsUpdate = true;



    dot.style.background = hex;
      if (ok) {
        updateVisualization({
          atomsUpdate:true,
          bondsUpdate:false,
          reRenderAtoms: false,
          reRenderBonds: false,
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
          bondsUpdate:false,
          reRenderAtoms: false,
          reRenderBonds: false,
          reRenderLattice: false,
          reRenderOther: false,
          reRenderComposition : "open",
      });
  };

   applyBtn.onclick = () => {
      dot.style.background = picker.getHex;
      updateVisualization({
          bondsUpdate:false,
          reRenderAtoms: false,
          reRenderBonds: false,
          reRenderLattice: false,
          reRenderOther: false,
          reRenderComposition: "open",
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
  const coords = fileBrowser.selectedStructure.atoms.map(a => a.position)[atomIndex]
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
  colorBtn.style.cssText = 'border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px;';
  const choosenColor = hexToRgba(colorHexToCss(getIndividualAtomColor(element, atomIndex)),0.8);
  colorBtn.style.background = choosenColor;
  colorBtn.title = `Change color for ${element}${displayNumber}`;

  // Coordinate edit button
  const coordBtn = document.createElement('button');
  coordBtn.textContent = 'Position';
  coordBtn.style.cssText = 'background: var(--bg-color); border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 4px; cursor: pointer; font-size: 10px;';
  coordBtn.title = `Edit coordinates for ${element}${displayNumber}`;


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
  const mom_color = colorHexToCss(getIndividualAtomColor(element, atomIndex))
  const picker = createColorPicker(mom_color, (hex) => {
    const ok = setIndividualAtomColor(element, atomIndex, hex);

    //fileBrowser.selectedStructure.atoms[atomIndex].color = hex
    //updateSingleAtomColor(originalIndex=atomIndex, element=element, opacity = 1.0)
    //
    ////FIXME: this needs to also update the atoms
    console.log("atomIndex",atomIndex, "bondMap",fileBrowser.selectedStructure.bondMapping[atomIndex])
    fileBrowser.selectedStructure.atomImages[atomIndex].forEach(imageIndex => {
      fileBrowser.selectedStructure.bondMapping[imageIndex].forEach(bondHalvIndex =>{
        console.log(bondHalvIndex)
        updateSingleBondColor(bondHalvIndex, hex)
        //updateSingleAtomColor(originalIndex=atomIndex, element=element, opacity = 1.0)    
      });
    });  
    groups.atomsMesh.instanceColor.needsUpdate = true;

    dot.style.background = hex;
      if (ok) {
        //updateBonds()
        updateVisualization({
          bondsUpdate:false,
          reRenderAtoms: false,
          reRenderBonds: false,
          reRenderLattice: false,
          reRenderOther: false
        });
      }
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
  const mom_spin_color = colorHexToCss(getIndividualAtomColor(element, atomIndex))
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
    const ok = setIndividualAtomColor(element, atomIndex, hex);
    dot.style.background = hex;
      if (ok) {
        updateVisualization({
          bondsUpdate:false,
          reRenderAtoms: false,
          reRenderBonds: true,
          reRenderLattice: false,
          reRenderOther: false
        });
      }
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

  AtomColorApplyBtn.onclick = () => {
      dot.style.background = picker.getHex;
      editor.style.display = 'none';
      updateVisualization({
        bondsUpdate:false,
        reRenderAtoms: false,
        reRenderBonds : false,
        reRenderLattice : false,
        reRenderOther: false,
        reRenderComposition : true, 
      });
  };

  AtomColorResetBtn.onclick = () => {
    clearIndividualAtomColor(element, atomIndex);
    const newColor = colorHexToCss(getIndividualAtomColor(element, atomIndex));
    dot.style.background = newColor;
    //colorInput.value = newColor;
   // hexInput.value = newColor;
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
  console.warn("hahahah");
  if (!fileBrowser.selectedStructure) {
   console.error("updateAtomCoordinates: selected structure not found");
   return;
  };  
  if (atomIndex >= fileBrowser.selectedStructure.atoms.length) {
    console.error('Invalid atom index or structure data');
    return;
  };

  // Update the coordinates in the structure data
  
  fileBrowser.selectedStructure.atoms[atomIndex].postion = [...newCoords];
  structureShip.container[fileBrowser.selectedRowIndex].structures[fileBrowser.stepInput].atoms[atomIndex].position  = [...newCoords]; 

    //atoms[atomIndex].position)

    //= [...newCoords];

  // Refresh the visualization to show the updated position
      updateVisualization({
        bondsUpdate:false,
        reRenderAtoms: false,
        reRenderBonds : false,
        reRenderLattice : false,
        reRenderOther: false,
        reRenderComposition : true,
      });

  console.log(`Updated atom ${atomIndex} coordinates to: ${newCoords.join(', ')}`);
};







