import { app, groups, fileBrowser, general, mode, polyStyle } from '../store.js';
import { atomicRadii } from '../defaults/radii_defaults.js';
import { getBondCutoff } from '../modules/BondsFracUpdateModule.js';
import { updateVisualization } from '../crystal-viewer.js';
import { createPieDot } from '../modules/ColorModule.js';
import { clearAllHighlights } from '../modules/SelectAndHighlightModule.js';
import { updateBondControlPanel } from './StructureInfoPanel/Bonds.js';
import { openDoublePeriodicTable } from './PeriodicTableSelectTwoPanel.js';



// Inject CSS for the double slider
function injectDoubleSliderCSS() {
  const style = document.createElement('style');
  style.textContent = `
    .bond-range-slider {
      position: relative;
      width: 200px;
      height: 16px;
      margin: 0 8px;
    }
    .bond-range-slider .background-track {
      position: absolute;
      height: 4px;
      background: rgba(150, 150, 150, 0.5);
      border-radius: 2px;
      top: 50%;
      left: 0;
      right: 0;
      transform: translateY(-50%);
      z-index: -2;
      maring: 1px
    }
    .bond-range-slider .range-track {
      position: absolute;
      height: 4px;
      background: rgba(6, 140, 50, 0.8);
      border-radius: 2px;
      top: 50%;
      transform: translateY(-50%);
      z-index: -1;
    }
    .bond-range-slider input[type="range"] {
      position: absolute;
      width: 100%;
      height: 16px;
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      pointer-events: none;
    }
    .bond-range-slider input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      border: 1px solid #ccc;
      cursor: pointer;
      pointer-events: auto;
      margin-top: -6px;
    }
    .bond-range-slider input[type="range"]::-moz-range-thumb {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      border: 1px solid #ccc;
      cursor: pointer;
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);
}
injectDoubleSliderCSS();

export function resetBondLengths() {
  for (const pair in general.defaultBondLengths) {
    const defaultValue = general.defaultBondLengths[pair];
    general.bondLengths[pair] = { min: 0, max: defaultValue };
  }
  createBondLengthControls();
  updateVisualization({ reRenderOther: false, reRenderComposition: false });
}

export function createBondLengthControls(targetPanel = 'bondControls') {
  const bondControls = document.getElementById(targetPanel);
  if (!bondControls) {
    console.warn(`Could not find ${targetPanel}`);
    return;
  }

  if (!fileBrowser.selectedStructure) return;

  // Clear existing controls
  bondControls.innerHTML = '';

  // --- Reset and Add Custom Bond wrapper ---
  const controlsHeaderWrapper = document.createElement("div");
  controlsHeaderWrapper.className = "buttonWrapper";
  controlsHeaderWrapper.style.display = "flex";
  controlsHeaderWrapper.style.justifyContent = "center";
  controlsHeaderWrapper.style.gap = "8px";
  controlsHeaderWrapper.style.marginBottom = "8px";

  const resetBtn = document.createElement("button");
  resetBtn.id = "resetBondLengths";
  resetBtn.className = "reset-btn";
  resetBtn.textContent = "Reset to Defaults";
  resetBtn.style.fontSize = "12px";
  resetBtn.style.height = "22px";
  resetBtn.onclick = () => {
    resetBondLengths();
    clearAllHighlights();
  };

  const addCustomBondBtn = document.createElement("button");
  addCustomBondBtn.id = "addCustomBond";
  addCustomBondBtn.className = "reset-btn";
  addCustomBondBtn.textContent = "Add Custom Bond";
  addCustomBondBtn.style.fontSize = "12px";
  addCustomBondBtn.style.height = "22px";
  addCustomBondBtn.onclick = () => {
    openDoublePeriodicTable((pair) => {
      if (!general.bondLengths[pair]) {
        const [el1, el2] = pair.split('-');
        const defaultRadius = (atomicRadii[el1] || 1.0) + (atomicRadii[el2] || 1.0);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
        general.bondLengths[pair] = { min: 0, max: defaultValue };
        general.defaultBondLengths[pair] = defaultValue;
        general.bondVisibility[pair] = true;
        createBondLengthControls(targetPanel);
        updateVisualization({
          reRenderBonds: true,
          reRenderOther: false,
          reRenderComposition: false,
        });
      }
    });
  };

  controlsHeaderWrapper.appendChild(resetBtn);
  controlsHeaderWrapper.appendChild(addCustomBondBtn);
  bondControls.appendChild(controlsHeaderWrapper);


  let elements = [...fileBrowser.selectedStructure.elements];
  const uniqueElements = [...new Set(elements)];
  const pairs = [];

  // Generate all unique pairs
  for (let i = 0; i < uniqueElements.length; i++) {
    for (let j = i; j < uniqueElements.length; j++) {
      const pair = uniqueElements[i] < uniqueElements[j]
        ? `${uniqueElements[i]}-${uniqueElements[j]}`
        : `${uniqueElements[j]}-${uniqueElements[i]}`;
      pairs.push(pair);

      // Initialize bondLengths as { min: 0, max: defaultValue }
      if (!general.bondLengths[pair]) {
        const defaultRadius = (atomicRadii[uniqueElements[i]] || 1.0) + (atomicRadii[uniqueElements[j]] || 1.0);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
        general.bondLengths[pair] = { min: 0, max: defaultValue };
        general.defaultBondLengths[pair] = defaultValue; // Store default max
      } else if (typeof general.bondLengths[pair] === 'number') {
        // Migrate old single-value format to new { min, max } format
        general.bondLengths[pair] = { min: 0, max: general.bondLengths[pair] };
      }

      // Initialize bond visibility if not set
      if (general.bondVisibility[pair] === undefined) {
        general.bondVisibility[pair] = true;
      }
    }
  }

  pairs.forEach(pair => {
    const div = document.createElement('div');
    div.className = 'bond-control';

    // Add checkbox for bond visibility
    const checkboxDiv = document.createElement('div');
    checkboxDiv.className = 'bond-checkbox';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = general.bondVisibility[pair];
    checkbox.onchange = (e) => {
      general.bondVisibility[pair] = e.target.checked;
      updateVisualization({
        reRenderBonds: true,
        reRenderOther: false,
        reRenderComposition: false,
      });
    };

    const checkboxLabel = document.createElement('label');
    checkboxLabel.textContent = `Show ${pair} bonds`;
    checkboxLabel.style.padding="0px 0px 0px 4px";
    checkboxLabel.style.fontSize = '12px';
    checkboxLabel.style.color = '#ccc';
    checkboxLabel.style.margin = '0';

    let dot;
    let curr_bond_colors = ["#ccc", "#fff"];
    if (curr_bond_colors.length > 1) {
      dot = createPieDot(curr_bond_colors, 50);
      dot.classList.add('dot');
    } else {
      dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = curr_bond_colors[0];
    }

    checkboxDiv.appendChild(checkbox);
    checkboxDiv.appendChild(checkboxLabel);
    checkboxDiv.appendChild(dot);

    const label = document.createElement('div');
    label.className = 'bond-label';
    label.textContent = `${pair}: `;

    const valueSpan = document.createElement('span');
    valueSpan.className = 'slider-value';
    valueSpan.textContent = `${general.bondLengths[pair].min.toFixed(2)} - ${general.bondLengths[pair].max.toFixed(2)} Å`;
    label.appendChild(valueSpan);

    const controlsRow = document.createElement('div');
    controlsRow.style.display = 'flex';
    controlsRow.style.gap = '8px';
    controlsRow.style.alignItems = 'center';

    // Min value display
    const minValueSpan = document.createElement('span');
    minValueSpan.className = 'slider-value';
    minValueSpan.textContent = `${general.bondLengths[pair].min.toFixed(2)} Å`;
    minValueSpan.style.minWidth = '50px';
    minValueSpan.style.textAlign = 'right';

    // Max value display
    const maxValueSpan = document.createElement('span');
    maxValueSpan.className = 'slider-value';
    maxValueSpan.textContent = `${general.bondLengths[pair].max.toFixed(2)} Å`;
    maxValueSpan.style.minWidth = '50px';
    maxValueSpan.style.textAlign = 'left';

    // Double slider container
    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'bond-range-slider';

    // Background track (light grey)
    const backgroundTrack = document.createElement('div');
    backgroundTrack.className = 'background-track';
    sliderContainer.appendChild(backgroundTrack);

    // Selected range track (green)
    const track = document.createElement('div');
    track.className = 'range-track';
    track.style.left = '0%';
    track.style.width = '100%';
    sliderContainer.appendChild(track);

    // Min slider
    const minSlider = document.createElement('input');
    minSlider.type = 'range';
    minSlider.min = '0';
    minSlider.max = '6';
    minSlider.step = '0.1';
    minSlider.value = general.bondLengths[pair].min;
    minSlider.style.zIndex = '2';
    sliderContainer.appendChild(minSlider);

    // Max slider
    const maxSlider = document.createElement('input');
    maxSlider.type = 'range';
    maxSlider.min = '0';
    maxSlider.max = '6';
    maxSlider.step = '0.1';
    maxSlider.value = general.bondLengths[pair].max;
    maxSlider.style.zIndex = '1';
    sliderContainer.appendChild(maxSlider);

    // Update function for both sliders
    //
    function updateBondRange() {
      let minVal = parseFloat(minSlider.value);
      let maxVal = parseFloat(maxSlider.value);

      // Enforce a minimum range of 0.1
      if (maxVal - minVal < 0.1) {
        if (this === minSlider) {
          minVal = maxVal - 0.1;
          minSlider.value = minVal;
        } else {
          maxVal = minVal + 0.1;
          maxSlider.value = maxVal;
        }
      }

      // Ensure min <= max
      if (minVal > maxVal) {
        if (this === minSlider) {
          minVal = maxVal;
          minSlider.value = maxVal;
        } else {
          maxVal = minVal;
          maxSlider.value = minVal;
        }
      }

      // Rest of your update logic...
      const minPercent = (minVal / 6) * 100;
      const maxPercent = (maxVal / 6) * 100;
      track.style.left = `${minPercent}%`;
      track.style.width = `${maxPercent - minPercent}%`;

      minValueSpan.textContent = `${minVal.toFixed(2)} Å`;
      maxValueSpan.textContent = `${maxVal.toFixed(2)} Å`;
      valueSpan.textContent = `${minVal.toFixed(2)} - ${maxVal.toFixed(2)} Å`;

      general.bondLengths[pair].min = minVal;
      general.bondLengths[pair].max = maxVal;

      updateVisualization({
        reRenderBonds: true,
        reRenderOther: false,
        reRenderComposition: false,
      });
    }


    minSlider.oninput = updateBondRange;
    maxSlider.oninput = updateBondRange;

    // Initialize track
    const minPercent = (parseFloat(minSlider.value) / 6) * 100;
    const maxPercent = (parseFloat(maxSlider.value) / 6) * 100;
    track.style.left = `${minPercent}%`;
    track.style.width = `${maxPercent - minPercent}%`;

    controlsRow.appendChild(minValueSpan);
    controlsRow.appendChild(sliderContainer);
    controlsRow.appendChild(maxValueSpan);

    div.appendChild(checkboxDiv);
    div.appendChild(label);
    div.appendChild(controlsRow);
    bondControls.appendChild(div);
  });
}

function addFuncToBondColorSettings(){

  dot.onclick = (e) => {
    e.stopPropagation();
    editor.style.display = (editor.style.display === 'none') ? 'flex' : 'none';
    if (editor.style.display === 'flex') editor.style.flexDirection = 'column';
  };

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

  AtomColorApplyBtn.onclick = () => {
      dot.style.background = picker.getHex;
      editor.style.display = 'none';
      updateVisualization({
        reRenderAtoms: true,
        reRenderBonds : true,
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
        reRenderAtoms: true,
        reRenderBonds : true,
        reRenderLattice : false,
        reRenderOther: false,
        reRenderComposition : true,
      });
    // Update the composition to refresh element colors
    editor.style.display = 'none';
  };

}

