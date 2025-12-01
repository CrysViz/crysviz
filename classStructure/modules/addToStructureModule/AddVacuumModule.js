// AddVacuumModule.js
import { structureData } from '../../store.js';
import {createBondLengthControls} from '../../panels/BondLengthPanel.js'
import {createSpinControls} from '../../panels/SpinPanel.js'
import {updateVisualization} from '../../crystal-viewer.js'

//------------------------------------------------------------
// Function: addVacuum
// Adds vacuum to the lattice and repositions atoms
//------------------------------------------------------------
//
//
//

function addVacuum(vacX = 0, vacY = 0, vacZ = 0) {
  if (!structureData.positions || !structureData.lattice) {
    throw new Error("Structure data incomplete: positions and lattice are required.");
  }

  const lattice = structureData.lattice.map(v => [...v]);
  const lengths = lattice.map(v => Math.hypot(...v));

  // Add vacuum symmetrically: increase lattice vector lengths
  lattice[0] = lattice[0].map(c => c + vacX * (c/lengths[0]));
  lattice[1] = lattice[1].map(c => c + vacY * (c/lengths[1]));
  lattice[2] = lattice[2].map(c => c + vacZ * (c/lengths[2]));

  // Shift fractional coordinates so atoms remain centered
  const shift = [
    vacX / (2 * (lengths[0] + vacX)),
    vacY / (2 * (lengths[1] + vacY)),
    vacZ / (2 * (lengths[2] + vacZ))
  ];

  const newPositions = structureData.positions.map(pos => [
    pos[0] * lengths[0]/(lengths[0]+vacX) + shift[0],
    pos[1] * lengths[1]/(lengths[1]+vacY) + shift[1],
    pos[2] * lengths[2]/(lengths[2]+vacZ) + shift[2]
  ]);

  structureData.lattice = lattice;
  structureData.positions = newPositions;

  createBondLengthControls?.();
  createSpinControls?.();
  updateVisualization?.();
}


// Function: addVacuumPanel
// Adds a floating panel with input boxes and button
//------------------------------------------------------------
export function addVacuumPanel(buttonId = 'addButton') {
  const button = document.getElementById(buttonId);
  if (!button) {
    console.warn(`No element with id '${buttonId}' found.`);
    return;
  }

  // Use a single listener that always recreates the panel
  button.addEventListener('click', () => {
    // Remove any existing panel
    const existingPanel = document.getElementById('vacuumPanel');
    if (existingPanel) {
      existingPanel.remove();
    }

    // Create a new panel
    const panel = document.createElement('div');
    panel.id = 'vacuumPanel';
    panel.style.cssText = `
      position: fixed;
      top: 150px;
      left: var(--popup-left);
      padding: 15px;
      background-color: rgba(26,26,26,1.0);
      color: white;
      border: 1px solid rgba(255,255,255,0.3);
      border-radius: 8px; 
      z-index: 999;
    `;

    panel.innerHTML = `
      <label>X (Å): <input type="number" id="vacX" value="0" step="1."></label><br>
      <label>Y (Å): <input type="number" id="vacY" value="0" step="1."></label><br>
      <label>Z (Å): <input type="number" id="vacZ" value="0" step="1."></label><br>
      <button id="applyVacuum" class="btn-mini highlight">Apply Vacuum</button>
      <button id="closeVacuumPanel" class="btn-mini highlight" >Close</button>
    `;

    document.body.appendChild(panel);

    // Attach event listeners to the **new panel** each time
    const applyButton = document.getElementById('applyVacuum');
    const closeButton = document.getElementById('closeVacuumPanel');

    applyButton.addEventListener('click', () => {
      const vacX = parseFloat(document.getElementById('vacX').value) || 0;
      const vacY = parseFloat(document.getElementById('vacY').value) || 0;
      const vacZ = parseFloat(document.getElementById('vacZ').value) || 0;
      addVacuum(vacX, vacY, vacZ);
    });

    closeButton.addEventListener('click', () => {
      // Remove panel and **all child elements** properly
      if (panel.parentNode) {
        panel.parentNode.removeChild(panel);
      }
    });
  });
}

