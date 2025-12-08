import { app, groups, structureData, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';
import {getBondCutoff} from '../modules/BondsModule.js';
import { updateVisualization } from '../crystal-viewer.js';

export function resetBondLengths() {
  for (const pair in general.defaultBondLengths) {
    general.bondLengths[pair] = general.defaultBondLengths[pair];
  }
  createBondLengthControls();
  updateVisualization();
}

export function createBondLengthControls() {
  const bondControls = document.getElementById('bondControls');
  if (!bondControls) return;
  bondControls.innerHTML = '';

  if (!structureData) return;

  const uniqueElements = [...new Set(structureData.elements)];
  const pairs = [];

  // Generate all unique pairs
  for (let i = 0; i < uniqueElements.length; i++) {
    for (let j = i; j < uniqueElements.length; j++) {
      const pair = uniqueElements[i] + '-' + uniqueElements[j];
      pairs.push(pair);

      if (!general.bondLengths[pair]) {
        const defaultRadius = (atomicRadii[uniqueElements[i]] || 1.0) + (atomicRadii[uniqueElements[j]] || 1.0);
        const defaultValue = Math.min(defaultRadius * 1.0, 6.0);
        general.bondLengths[pair] = defaultValue;
        general.defaultBondLengths[pair] = defaultValue; // Store default
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
      updateVisualization();
    };

    const checkboxLabel = document.createElement('label');
    checkboxLabel.textContent = `Show ${pair} bonds`;
    checkboxLabel.style.fontSize = '12px';
    checkboxLabel.style.color = '#ccc';
    checkboxLabel.style.margin = '0';

    checkboxDiv.appendChild(checkbox);
    checkboxDiv.appendChild(checkboxLabel);

    const label = document.createElement('div');
    label.className = 'bond-label';
    label.textContent = `${pair}: `;

    const valueSpan = document.createElement('span');
    valueSpan.className = 'slider-value';
    valueSpan.textContent = `${general.bondLengths[pair].toFixed(2)} Å`;
    label.appendChild(valueSpan);

    const controlsRow = document.createElement('div');
    controlsRow.style.display = 'flex';
    controlsRow.style.gap = '8px';
    controlsRow.style.alignItems = 'center';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.0';
    slider.max = '6.0';
    slider.step = '0.1' ;
    slider.value = general.bondLengths[pair];
    slider.style.flex = '1';

    const textInput = document.createElement('input');
    textInput.type = 'number';
    textInput.min = '0.0';
    textInput.max = '6.0';
    textInput.step = '0.01';
    textInput.value = general.bondLengths[pair];
    textInput.style.width = '70px';
    textInput.style.padding = '4px';
    textInput.style.background = 'rgba(255,255,255,0.1)';
    textInput.style.border = '1px solid rgba(255,255,255,0.2)';
    textInput.style.borderRadius = '4px';
    textInput.style.color = '#fff';

    function updateValue(newValue) {
      const val = parseFloat(newValue);
      general.bondLengths[pair] = val;

      // Update display text with special message for disabled bonds
      if (val <= 0.01) {
        valueSpan.textContent = 'Disabled';
        valueSpan.style.color = '#ff6666';
      } else {
        valueSpan.textContent = `${val.toFixed(3)} Å`;
        valueSpan.style.color = 'rgba(6, 140, 50, 1)';
      }

      slider.value = val;
      textInput.value = val;
      updateVisualization();
    }

    slider.oninput = (e) => updateValue(e.target.value);
    textInput.onchange = (e) => {
      const val = Math.max(0.0, Math.min(10.0, parseFloat(e.target.value) || 0.0));
      updateValue(val);
    };

    controlsRow.appendChild(slider);
    controlsRow.appendChild(textInput);

    div.appendChild(checkboxDiv);
    div.appendChild(label);
    div.appendChild(controlsRow);
    bondControls.appendChild(div);
  });
}


