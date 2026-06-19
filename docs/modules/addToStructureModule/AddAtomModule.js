// AddVacuumModule.js
import { structureData } from '../../store.js';
import {createBondLengthControls} from '../../ui/BondLengthPanel.js'
import {updateVisualization} from '../../crystal-viewer.js'



export function addAtomPanel(buttonId = 'addButton') {
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
      panel.id = 'atomPanel';
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
        <!-- Element input in one line -->
        <label>Element: <input type="text" id="atomElement" value="H" maxlength="2" style="width: 50px;"></label><br>

        <!-- Coordinates in the next line -->
        <label>X: <input type="number" id="atomX" value="0" step="0.1" style="width: 60px;"></label>
        <label>Y: <input type="number" id="atomY" value="0" step="0.1" style="width: 60px;"></label>
        <label>Z: <input type="number" id="atomZ" value="0" step="0.1" style="width: 60px;"></label><br>

        <!-- Buttons in the last line -->
        <button id="addAtomButton" class="btn-mini highlight">Add</button>
        <button id="cancelAddAtomButton" class="btn-mini highlight">Remove</button>
      `;

    document.body.appendChild(panel);

    // Attach event listeners to the **new panel** each time
    const addAtomButton = document.getElementById('addAtomButton');
    const cancelAddAtomButto = document.getElementById('cancelAddAtomButto');

    applyButton.addEventListener('click', () => {
      console.warn("Trying to add atom")
    });

    cancelAddAtomButton.addEventListener('click', () => {
      // Remove panel and **all child elements** properly
      if (panel.parentNode) {
        panel.parentNode.removeChild(panel);
      }
    });
  });
}

