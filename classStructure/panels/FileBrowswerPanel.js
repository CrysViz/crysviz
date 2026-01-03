import {allAtoms,general,structureData,structureShip, fileBrowser} from '../store.js'
import {updateVisualization} from '../crystal-viewer.js'
import {resetView} from './WindowAndSceneControls.js'
import {resetModeSwitch, resetSpinForceSwitch} from './ControlPanel.js'
import {createBondLengthControls} from './BondLengthPanel.js'
import {createSpinControls} from './SpinPanel.js'
import {updateSpins} from '../modules/SpinModule.js'
import {updateForces} from '../modules/ForceModule.js'
import {getAllPeriodicImages,updateNeighborMap} from '../modules/BondsModule.js'

export function showError(message) {
    errorPanel.textContent = message;
    errorPanel.style.display = "block";
    setTimeout(() => (errorPanel.style.display = "none"), 2000);
  }

export function countChecked() {
    return [...document.querySelectorAll('#objectTable tbody input[type="checkbox"]')]
      .filter((cb) => cb.checked).length;
  }

// Function to create a new row in the table
export function createRow(obj) {
  const row = document.createElement("tr");
  row.classList.add("ftr");
  row.innerHTML = `
  <td class="ftd"><input type="checkbox"></td>
  <td class="ftd">
    <div class="name-cell">
      <span class="name-inner">${obj.name}</span>
      <span class="name-scroll">${obj.name}</span>
    </div>
  </td>
  <td class="ftd">${obj.traj}</td>
  <td class="ftd"><input type="number" min="1" max="${obj.traj}" value="${obj.step}" /></td>
  <td class="ftd icon copy"><img src="copy.png" alt="⿻"></td>
  <td class="ftd icon delete">×</td>
`;


  // Populate the row with the initial object data

  // Bind the checkbox limit logic
  const checkbox = row.querySelector('input[type="checkbox"]');
  checkbox.addEventListener("change", () => {
    const count = countChecked();
    if (count > 2) {
      checkbox.checked = false;
      showError("Only two structures can be compared");
    }
  });

  // Step input handler (validation and updates)
  const stepInput = row.querySelector('input[type="number"]');
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

  // Row click handler (to select the row)
  row.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT" || e.target.classList.contains("icon") || e.target.tagName === "IMG") return;

    if (fileBrowser.selectedRow) fileBrowser.selectedRow.classList.remove("selected");
    row.classList.add("selected");
    fileBrowser.selectedRow = row;

    const rowIndex = Array.from(row.parentElement.children).indexOf(row); // row index relative to tbody
    row.dataset.index = rowIndex; // store index on row
    updateStructureFromRowAndStep(rowIndex);

    let oldRowIndex = fileBrowser.selectedRowIndex;
    fileBrowser.selectedRowIndex = rowIndex;
  });

  // Duplicate (copy) logic
  row.querySelector(".copy").addEventListener("click", (e) => {
    e.stopPropagation();

    // Ensure we're working with the current row data
    const updatedObj = JSON.parse(row.dataset.obj); // Get the updated object from the row's data

    // Create a new row using the updated object
    const newRow = createRow(updatedObj);

    // Insert the new row after the current row
    row.insertAdjacentElement("afterend", newRow);

    console.log("Duplicated:", updatedObj);

    // Update the structure ship container correctly (adjusting for new row)
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    structureShip.len = structureShip.len + 1;
    structureShip.container.splice(rowIndex + 1, 0, structureShip.container[rowIndex]);
    selectLastAddedRow();
  });

  // Delete logic
  row.querySelector(".delete").addEventListener("click", (e) => {
    e.stopPropagation();

    // Get the index of the row before removing it
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    
    // Remove the row from the structure ship container
    structureShip.len = structureShip.len - 1;
    structureShip.container.splice(rowIndex, 1);
    
    // Now remove the row from the DOM
    row.remove();
    selectLastAddedRow();
    
    console.log("Deleted:", row);
  });

  // Store the updated object in the row's dataset (used for copying and other operations)
  row.dataset.obj = JSON.stringify(obj);

  return row;
}

export function selectLastAddedRow() {
  console.warn("selecting last row")
  const tbody = document.querySelector("#objectTable tbody");
  if (!tbody) return;

  const rows = tbody.querySelectorAll("tr");
  if (rows.length === 0) return;

  const row = rows[rows.length - 1]; // last row

  // Clear any previously selected row
  if (fileBrowser.selectedRow) {
    fileBrowser.selectedRow.classList.remove("selected");
  }

  // Mark this as selected
  row.classList.add("selected");
  fileBrowser.selectedRow = row;

  // Store the index
  const rowIndex = rows.length - 1;
  row.dataset.index = rowIndex;
  fileBrowser.selectedRowIndex = rowIndex;
  console.warn(`selecting row ${rowIndex}`)
  // Update structure panel
  updateStructureFromRowAndStep(rowIndex);

}


// Function to update an existing row when the object (obj) changes
export function updateRow(row, obj) {

  // Update the name
  const nameInner = row.querySelector('.name-inner');
  const nameScroll = row.querySelector('.name-scroll');
  if (nameInner) nameInner.textContent = obj.name;
  if (nameScroll) nameScroll.textContent = obj.name;

  // Update the trajectory column
  const trajCell = row.querySelector('td:nth-child(3)');
  if (trajCell) trajCell.textContent = obj.traj;

  // Update the step input (adjust max value based on new traj)
  const stepInput = row.querySelector('input[type="number"]');
  if (stepInput) {
    stepInput.max = obj.traj;
    // If current step value exceeds the new traj, adjust it
    if (parseInt(stepInput.value, 10) > obj.traj) {
      stepInput.value = obj.traj;
    }
  }

  // Update the row's data attribute with the new object (for reference)
  row.dataset.obj = JSON.stringify(obj);

  // Rebind the step validation logic (ensure it reflects the new traj)
  if (stepInput) {
    stepInput.setCustomValidity("");  // Reset any previous validity warnings
    stepInput.removeEventListener("input", stepInputValidation);  // Remove old event listener
    stepInput.addEventListener("input", stepInputValidation);
  }

  // Checkbox limit logic (only allow up to 2 selected rows)
  const checkbox = row.querySelector('input[type="checkbox"]');
  if (checkbox) {
    checkbox.removeEventListener("change", checkboxLimitLogic);  // Remove old listener
    checkbox.addEventListener("change", checkboxLimitLogic);
  }

  // Function to validate step input within the allowed range
  function stepInputValidation() {
    const val = parseInt(stepInput.value, 10);
    const strucIndex = fileBrowser.selectedRow ? parseInt(fileBrowser.selectedRow.dataset.index, 10) : 0;
    if (val < 1 || val > obj.traj) {
      stepInput.setCustomValidity(`Step must be between 1 and ${obj.traj}`);
    } else {
      stepInput.setCustomValidity("");
      updateStructureFromRowAndStep(strucIndex);
    }
  }

  // Function to limit the checkbox selection to 2
  function checkboxLimitLogic() {
    const count = countChecked();
    if (count > 2) {
      checkbox.checked = false;
      showError("Only two structures can be compared");
    }
  }
}

// Function to update structure data from a row and its step input
function updateStructureFromRowAndStep(rowIndex) {
  const stepInput = fileBrowser.selectedRow.querySelector('input[type="number"]');  // Use the step input from the selected row
  const step = parseInt(stepInput.value, 10) - 1; // zero-based index
  const container = structureShip.container[rowIndex];
   
  if (!container || step < 0 || step >= container.structures.length) {
    if (!container){
     console.warn("Structure could not be selected: Container not found")
    }
    if (step < 0) {
     console.warn("Structure could not be selected:Step > 0 ")
    }
    if (step >= container.structures.length) {
    console.warn("Structure could not be selected: step >= container.structures.length")
    }
    return;
  }
  fileBrowser.selectedStructure = container.structures[step];

  updateNeighborMap(fileBrowser.selectedStructure)
  getAllPeriodicImages(fileBrowser.selectedStructure)
  console.warn(allAtoms)
  // Assign arrays (make copies to avoid mutating original)

  structureData.positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
  structureData.elements = [...fileBrowser.selectedStructure.elements];
  structureData.lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  structureData.spins = fileBrowser.selectedStructure.spins?.map(spin => spin.vector ?? null) ?? null;
  if (structureData.spin != null && general.spinForceState === "Spins") {
    updateSpins();
  }
  structureData.forces = fileBrowser.selectedStructure.forces?.map(forces => forces.vector ?? null) ?? null;
  if (structureData.forces != null && general.spinForceState === "Forces" ) {
    structureData.force_amps = fileBrowser.selectedStructure.forces?.map(length => force.length ?? null) ?? null;
    updateForces();
  }
  if (fileBrowser.selectedStructure.stress != null) {
     structureData.stress =  selectedStructure.stress.map(r => r.tensor);
  }  
  console.warn(fileBrowser.selectedStructure)
  createBondLengthControls();
  //createSpinControls();
  updateVisualization();
}

