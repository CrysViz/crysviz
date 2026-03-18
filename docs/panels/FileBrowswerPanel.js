import {groups,app,allAtoms, general, structureShip, fileBrowser} from '../store.js';
import {updateVisualization} from '../crystal-viewer.js';
import {resetView} from './WindowAndSceneControls.js';
import {resetModeSwitch, resetSpinForceSwitch} from './ControlPanel.js';
import {createBondLengthControls} from './BondLengthPanel.js';
import {createSpinControls} from './SpinPanel.js';
import {updateSpins} from '../modules/SpinModule.js';
import {updateForces} from '../modules/ForceModule.js';
import {fieldBrowser} from './FieldPanel.js';
import {toggleFieldVisibility, setActiveField, updateField} from '../modules/Render3DFieldModule.js';
import {updateLatticeComparisonPanel} from './LatticeComparisonPanel.js'

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
    <td class="ftd icon copy"><img src="copy.png" alt="⧉"></td>
    <td class="ftd icon delete">×</td>
  `;

  // Bind the checkbox limit logic
  const checkbox = row.querySelector('input[type="checkbox"]');
  checkbox.addEventListener("change", () => {
    const count = countChecked();
    if (count > 1) {
      checkbox.checked = false;
      showError("Only one structure can be selected for comparison");
      return;
    }
    updateComparisonStructure(row, checkbox.checked);
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

    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    row.dataset.index = rowIndex;
    fileBrowser.selectedRowIndex = rowIndex;
    updateStructureFromRowAndStep(rowIndex);

    if (fileBrowser.selectedStructure.volumetricFields && fileBrowser.selectedStructure.volumetricFields.fields.length > 0) {
      fieldBrowser.setAvailableFields(fileBrowser.selectedStructure.volumetricFields.fields);
      fieldBrowser.setSelectedField(0);
      const selectedField = fieldBrowser.selectedField;
      setActiveField(selectedField);
      updateField();
    }
  });

  // Duplicate (copy) logic
  row.querySelector(".copy").addEventListener("click", (e) => {
    e.stopPropagation();
    const updatedObj = JSON.parse(row.dataset.obj);
    const newRow = createRow(updatedObj);
    row.insertAdjacentElement("afterend", newRow);
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    structureShip.len = structureShip.len + 1;
    structureShip.container.splice(rowIndex + 1, 0, JSON.parse(JSON.stringify(structureShip.container[rowIndex])));
    selectLastAddedRow();
  });

  // Delete logic
  row.querySelector(".delete").addEventListener("click", (e) => {
    e.stopPropagation();
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    structureShip.len = structureShip.len - 1;
    structureShip.container.splice(rowIndex, 1);
    row.remove();
    selectLastAddedRow();
  });

  row.dataset.obj = JSON.stringify(obj);
  return row;
}

export function selectLastAddedRow() {
  const tbody = document.querySelector("#objectTable tbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll("tr");
  if (rows.length === 0) return;
  const row = rows[rows.length - 1];
  if (fileBrowser.selectedRow) fileBrowser.selectedRow.classList.remove("selected");
  row.classList.add("selected");
  fileBrowser.selectedRow = row;
  const rowIndex = rows.length - 1;
  row.dataset.index = rowIndex;
  fileBrowser.selectedRowIndex = rowIndex;
  updateStructureFromRowAndStep(rowIndex);
}

// Function to update the comparison structure when a checkbox is toggled
export function updateComparisonStructure(row, isChecked) {
  if (isChecked) {
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    fileBrowser.comparisonRow = row;
    fileBrowser.comparisonRowIndex = rowIndex;
    const stepInput = row.querySelector('input[type="number"]');
    const step = parseInt(stepInput.value, 10) - 1;
    const container = structureShip.container[rowIndex];
    if (container && step >= 0 && step < container.structures.length) {
      fileBrowser.comparisonStructure = container.structures[step];
      updateVisualization({
        SecondAtomsUpdate: false,
        SecondReRenderAtoms: true,
        SecondBondsUpdate: false,
        SecondReRenderBonds: true,
        SecondReRenderLattice: false
      });
    }

    // Add event listener for step input changes
    stepInput.addEventListener("input", () => {
      const newStep = parseInt(stepInput.value, 10) - 1;
      if (newStep >= 0 && newStep < container.structures.length) {
        fileBrowser.comparisonStructure = container.structures[newStep];
        updateVisualization({
          SecondAtomsUpdate: false,
          SecondReRenderAtoms: true,
          SecondBondsUpdate: false,
          SecondReRenderBonds: true,
          SecondReRenderLattice: false
        });

        // Update lattice comparison panel if in comparison mode
        if (
          fileBrowser.comparisonStructure &&
          fileBrowser.selectedStructure &&
          general.playerModeState === "comparison"
        ) {
          const L1 = fileBrowser.selectedStructure.lattice.map(row => [...row]);
          const L2 = fileBrowser.comparisonStructure.lattice.map(row => [...row]);
          updateLatticeComparisonPanel(L1, L2);
        }
      }
    });

    // Update lattice comparison panel if in comparison mode
    if (
      fileBrowser.comparisonStructure &&
      fileBrowser.selectedStructure &&
      general.playerModeState === "comparison"
    ) {
      const L1 = fileBrowser.selectedStructure.lattice.map(row => [...row]);
      const L2 = fileBrowser.comparisonStructure.lattice.map(row => [...row]);
      updateLatticeComparisonPanel(L1, L2);
    }
  }
  else {
    // If unchecked, clear the comparison structure if this row was the comparison row
    if (fileBrowser.comparisonRow === row) {
      fileBrowser.comparisonRow = null;
      fileBrowser.comparisonRowIndex = -1;
      fileBrowser.comparisonStructure = null;

      if (groups.secondAtomsMesh) {
        groups.secondAtomsMesh.geometry.dispose();
        groups.secondAtomsMesh.material.dispose();
        app.scene.remove(groups.secondAtomsMesh);
        groups.secondAtomsMesh = null;
      }
      if (groups.secondBondsMesh) {
        groups.secondBondsMesh.geometry.dispose();
        groups.secondBondsMesh.material.dispose();
        app.scene.remove(groups.secondBondsMesh);
        groups.secondBondsMesh = null;
      }
      updateVisualization({
        SecondAtomsUpdate: false,
        SecondReRenderAtoms: false,
        SecondBondsUpdate: false,
        SecondReRenderBonds: false,
        SecondReRenderLattice: false
      });
    }
  }
}


// Function to update an existing row when the object (obj) changes
export function updateRow(row, obj) {
  const nameInner = row.querySelector('.name-inner');
  const nameScroll = row.querySelector('.name-scroll');
  if (nameInner) nameInner.textContent = obj.name;
  if (nameScroll) nameScroll.textContent = obj.name;
  const trajCell = row.querySelector('td:nth-child(3)');
  if (trajCell) trajCell.textContent = obj.traj;
  const stepInput = row.querySelector('input[type="number"]');
  if (stepInput) {
    stepInput.max = obj.traj;
    if (parseInt(stepInput.value, 10) > obj.traj) {
      stepInput.value = obj.traj;
    }
  }
  row.dataset.obj = JSON.stringify(obj);
  if (stepInput) {
    stepInput.setCustomValidity("");
    stepInput.removeEventListener("input", stepInputValidation);
    stepInput.addEventListener("input", stepInputValidation);
  }
  const checkbox = row.querySelector('input[type="checkbox"]');
  if (checkbox) {
    checkbox.removeEventListener("change", checkboxLimitLogic);
    checkbox.addEventListener("change", checkboxLimitLogic);
  }
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
  function checkboxLimitLogic() {
    const count = countChecked();
    if (count > 1) {
      checkbox.checked = false;
      showError("Only two structures can be compared");
    }
    updateComparisonStructure(row, checkbox.checked);
  }
}

// Function to update structure data from a row and its step input
function updateStructureFromRowAndStep(rowIndex) {
  const stepInput = document.querySelector(`#objectTable tbody tr:nth-child(${rowIndex + 1}) input[type="number"]`);
  const step = parseInt(stepInput.value, 10) - 1;
  const container = structureShip.container[rowIndex];
  fileBrowser.stepInput = step;

  if (!container || step < 0 || step >= container.structures.length) {
    if (!container) console.warn("Structure could not be selected: Container not found");
    if (step < 0) console.warn("Structure could not be selected: Step > 0");
    if (step >= container.structures.length) console.warn("Structure could not be selected: step >= container.structures.length");
    return;
  }
  fileBrowser.selectedStructure = container.structures[step];
  let spins = fileBrowser.selectedStructure.spins?.map(spin => spin.vector ?? null) ?? null;
  if (spins != null && general.spinForceState === "Spins") updateSpins();
  let forces = fileBrowser.selectedStructure.forces?.map(forces => forces.vector ?? null) ?? null;
  if (forces != null && general.spinForceState === "Forces") updateForces();
  //if (fileBrowser.selectedStructure.stress != null) stress = fileBrowser.selectedStructure.stress.map(r => r.tensor);
  createBondLengthControls();
  if (document.getElementById('latticeAndSupercellGroup')) {
    removeLatticeAndSupercellPanel();
    addLatticeAndSupercellPanel();
  }
  if (
    fileBrowser.comparisonStructure &&
    fileBrowser.selectedStructure &&
    general.playerModeState === "comparison" // Only update if in comparison mode
  ) {
    const L1 = fileBrowser.selectedStructure.lattice.map(row => [...row]);
    const L2 = fileBrowser.comparisonStructure.lattice.map(row => [...row]);
    updateLatticeComparisonPanel(L1, L2);
  }
  updateVisualization({reRenderAtoms: true, reRenderBonds: true});
}

