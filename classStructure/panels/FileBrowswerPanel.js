import {structureData,structureShip, fileBrowser} from '../store.js'
import {updateVisualization} from '../crystal-viewer.js'
import {resetView} from './WindowAndSceneControls.js'

import {createBondLengthControls} from './BondLengthPanel.js'
import {createSpinControls} from './SpinPanel.js'

export function showError(message) {
    errorPanel.textContent = message;
    errorPanel.style.display = "block";
    setTimeout(() => (errorPanel.style.display = "none"), 2000);
  }

export function countChecked() {
    return [...document.querySelectorAll('#objectTable tbody input[type="checkbox"]')]
      .filter((cb) => cb.checked).length;
  }

export function createRow(obj) {
    const row = document.createElement("tr");

    row.innerHTML = `
      <td><input type="checkbox"></td>
      <td>
        <div class="name-cell">
          <span class="name-inner">${obj.name}</span>
          <span class="name-scroll">${obj.name}</span>
        </div>
      </td>
      <td>${obj.traj}</td>
      <td><input type="number" min="1" max="${obj.traj}" value="${obj.step}" /></td>
      <td class="icon copy"><img src="copy.png" alt="copy"></td>
      <td class="icon delete">×</td>
    `;

    // Checkbox limit logic
    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener("change", () => {
      const count = countChecked();
      if (count > 2) {
        checkbox.checked = false;
        showError("Only two structures can be compared");
      }
    });

    // Function to update the displayed structure based on row and step
function updateStructureFromRowAndStep(rowIndex) {
  const step = parseInt(stepInput.value, 10) - 1; // zero-based index
  const container = structureShip.container[rowIndex];
  if (!container || step < 0 || step >= container.structures.length) return;

  const selectedStructure = container.structures[step];

  // Assign arrays (make copies to avoid mutating original)
  structureData.positions = [...selectedStructure.positions];
  structureData.elements = [...selectedStructure.elements];
  structureData.lattice = selectedStructure.lattice.map(r => [...r]);

  createBondLengthControls();
  createSpinControls();
  updateVisualization();
  //resetView();
}

  // --------------------------------------
  // Row click handler
  // --------------------------------------
  row.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT" || e.target.classList.contains("icon") || e.target.tagName === "IMG") return;

    if (fileBrowser.selectedRow) fileBrowser.selectedRow.classList.remove("selected");
    row.classList.add("selected");
    fileBrowser.selectedRow = row;

    const rowIndex = Array.from(row.parentElement.children).indexOf(row); // row index relative to tbody
    row.dataset.index = rowIndex; // store index on row
    updateStructureFromRowAndStep(rowIndex);
  });

  // --------------------------------------
  // Step input handler
  // --------------------------------------
  //     // Step validation
    const stepInput = row.querySelector('input[type="number"]');
    fileBrowser.stepInput = stepInput
    console.warn("here")
    stepInput.addEventListener("input", () => {
      const val = parseInt(stepInput.value, 10);
      const strucIndex = fileBrowser.selectedRow ? parseInt(fileBrowser.selectedRow.dataset.index, 10) : 0;
      if (val < 1 || val > obj.traj) {
        stepInput.setCustomValidity(`Step must be between 1 and ${obj.traj}`);
      } else {
        stepInput.setCustomValidity("");
        updateStructureFromRowAndStep(strucIndex);
      }
     });


    // Duplicate (copy) logic
    row.querySelector(".copy").addEventListener("click", (e) => {
      e.stopPropagation();
      const cloneData = { ...obj };
      const newRow = createRow(cloneData);
      row.insertAdjacentElement("afterend", newRow);
      console.log("Duplicated:", cloneData);
      const rowIndex = Array.from(row.parentElement.children).indexOf(row);
      structureShip.len = structureShip.len+1
      structureShip.container.splice(rowIndex + 1, 0, structureShip.container[rowIndex]);

    });

    // Delete logic
    row.querySelector(".delete").addEventListener("click", (e) => {
      e.stopPropagation();
      console.log("Deleted:", obj);
      const rowIndex = Array.from(row.parentElement.children).indexOf(row);
      structureShip.len = structureShip.len-1
      structureShip.container.splice(rowIndex, 1)
      row.remove();

    });


    if (fileBrowser.selectedRow) fileBrowser.selectedRow.classList.remove("selected");
    row.classList.add("selected");
    fileBrowser.selectedRow = row;
    return row;
  }

