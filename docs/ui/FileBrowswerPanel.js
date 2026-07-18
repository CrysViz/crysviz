import {groups,app, general, structureShip, fileBrowser} from '../state/store.js';
import {updateVisualization} from '../core/crystal-viewer.js';
import { refreshActivePanels, refreshPanelAvailability, rebuildPanel } from './panels/PanelManager.js';
import {createBondLengthControls} from './BondLengthPanel.js';
import {updateSpins} from '../render/index.js';
import {updateForces} from '../render/index.js';
import {fieldBrowser} from './FieldPanel.js';
import { setActiveField, updateField, deleteField} from '../render/index.js';
import {updateLatticeComparisonPanel} from './LatticeComparisonPanel.js';
import { syncPlanesForSelectedStructure } from './PlanesPanel.js';
import {Structure} from '../model/index.js';
import { refreshBackendTheme } from './BackendPanel/BackendTheme.js';
import { recenterCamera } from './WindowAndSceneControls.js';
import { notifyActiveStructureChange } from '../state/structures.js';

export function showError(message) {
  errorPanel.textContent = message;
  errorPanel.style.display = "block";
  setTimeout(() => (errorPanel.style.display = "none"), 2000);
}

export function countChecked() {
  return [...document.querySelectorAll('#objectTable tbody input[type="checkbox"]')]
    .filter((cb) => cb.checked).length;
}

/** Enable the combine button only when there's something to combine. */
export function updateCombineButtonState() {
  const btn = document.getElementById('combineTrajectoriesButton');
  if (!btn) return;
  btn.disabled = countChecked() < 2;
}

/** Small centered modal asking for a name; calls onConfirm(name) if confirmed. */
function openCombineNamePopup(onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'combine-name-popup-overlay';
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
  `;

  const popup = document.createElement('div');
  popup.style.cssText = `
    background: rgba(13,13,13,0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 16px;
    border-radius: 12px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 260px;
  `;

  const label = document.createElement('div');
  label.textContent = 'Name for the combined trajectory:';
  label.style.cssText = 'color: rgb(255,255,255); font-size: 12px;';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combine-name-input';
  input.value = 'Combined Trajectory';
  input.style.cssText = `
    background: var(--bg-color);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: rgb(255,255,255);
    border-radius: 4px;
    font-size: 12px;
    padding: 6px;
  `;

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'display:flex; gap:10px; justify-content:flex-end;';

  const buttonStyle = `
    background: var(--bg-color);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: rgb(255,255,255);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    padding: 6px 10px;
  `;
  const confirmButton = document.createElement('button');
  confirmButton.textContent = 'Combine';
  confirmButton.style.cssText = buttonStyle;

  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  cancelButton.style.cssText = buttonStyle;

  buttonRow.appendChild(cancelButton);
  buttonRow.appendChild(confirmButton);
  popup.appendChild(label);
  popup.appendChild(input);
  popup.appendChild(buttonRow);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);

  input.focus();
  input.select();

  const close = () => overlay.remove();
  cancelButton.onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const confirm = () => { onConfirm(input.value); close(); };
  confirmButton.onclick = confirm;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') close();
  });
}

/**
 * Concatenate every checked row's frames (in table order) into one new
 * trajectory row, appended after the existing rows (originals are kept).
 * Structures are cloned the same way the row "copy" action does, so the new
 * row doesn't share mutable state with the originals.
 */
function combineCheckedRows(name) {
  const tbody = document.querySelector('#objectTable tbody');
  const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
  const checkedRows = rows.filter((r) => r.querySelector('input[type="checkbox"]')?.checked);
  if (checkedRows.length < 2) return;

  const combinedStructures = [];
  for (const r of checkedRows) {
    const idx = rows.indexOf(r);
    const container = structureShip.container[idx];
    if (!container) continue;
    for (const structure of container.structures) {
      combinedStructures.push(new Structure({
        elements: [...structure.elements],
        uniqueElements: [...structure.uniqueElements],
        lattice: structure.lattice.map(row => [...row]),
        atoms: [...structure.atoms],
        periodic: { ...structure.periodic }, // Clone as object/Map
        volumetricFields: null
      }));
    }
  }
  if (!combinedStructures.length) return;

  const newObj = {
    name: (name && name.trim()) ? name.trim() : 'Combined Trajectory',
    traj: combinedStructures.length,
    step: 1,
    structures: combinedStructures,
  };

  const newRow = createRow(newObj);
  tbody.appendChild(newRow);
  structureShip.len += 1;
  structureShip.container.push(newObj);

  // Selected rows have been combined — uncheck them and re-sync the derived
  // UI state (combine button enablement, comparison structure).
  checkedRows.forEach((r) => {
    const cb = r.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  });
  updateCombineButtonState();
  syncComparisonFromCheckboxes();

  selectRow(newRow);
}

/** Wire the static combine button (index.html) once at startup. */
export function initCombineTrajectoriesButton() {
  const btn = document.getElementById('combineTrajectoriesButton');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const count = countChecked();
    if (count < 2) return; // guarded by the disabled state anyway
    if (count > 2 && general.compareModeOn) {
      showError('Comparison only supports one structure — turn off Comparison, or check only two rows to combine.');
      return;
    }
    openCombineNamePopup((name) => combineCheckedRows(name));
  });
  updateCombineButtonState();
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
    <td class="ftd icon copy">⧉</td>
    <td class="ftd icon delete">×</td>
  `;

  // Plain multi-select checkbox: feeds both "combine into one trajectory"
  // (any number checked) and the comparison structure (only meaningful when
  // exactly one is checked and general.compareModeOn is on — see
  // syncComparisonFromCheckboxes).
  const checkbox = row.querySelector('input[type="checkbox"]');
  checkbox.addEventListener("change", () => {
    updateCombineButtonState();
    syncComparisonFromCheckboxes();
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
    const t = /** @type {any} */ (e.target);
    if (t.tagName === "INPUT" || t.classList.contains("icon") || t.tagName === "IMG") return;

    if (fileBrowser.selectedRow) fileBrowser.selectedRow.classList.remove("selected");
    row.classList.add("selected");
    fileBrowser.selectedRow = row;

    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    row.dataset.index = String(rowIndex);
    fileBrowser.selectedRowIndex = rowIndex;
    updateStructureFromRowAndStep(rowIndex);

    recenterCamera(); // keep the user's rotation/zoom; only re-center on the new structure
    refreshActivePanels();
  });


// Duplicate (copy) logic
row.querySelector(".copy").addEventListener("click", (e) => {
  const updatedObj = JSON.parse(row.dataset.obj);
  // Check if Command (Mac) or Ctrl (Windows/Linux) is pressed
  const isCommandClick = e.metaKey || e.ctrlKey;

  if (isCommandClick) {
    e.stopPropagation();
    e.preventDefault();

    // Copy current step logic
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    const container = structureShip.container[rowIndex];
    const stepInput = row.querySelector('input[type="number"]');
    const currentStep = parseInt(stepInput.value, 10) - 1;
    const currentStructure = container.structures[currentStep];

    const newStructure = new Structure({
      elements: [...currentStructure.elements],
      uniqueElements: [...currentStructure.uniqueElements],
      lattice: currentStructure.lattice.map(row => [...row]),
      atoms: [...currentStructure.atoms],
      periodic: { ...currentStructure.periodic }, // Clone as object/Map
      volumetricFields: null
    });

    const newObj = {
      ...updatedObj,
      structures: [newStructure],
      traj: 1,
    };

    const newRow = createRow(newObj);
    row.insertAdjacentElement("afterend", newRow);
    structureShip.len += 1;
    structureShip.container.splice(rowIndex + 1, 0, newObj);

    // Select the row just created (inserted right after the source row, not
    // necessarily last in the table) — selectLastAddedRow() would pick
    // whatever row is currently last instead.
    selectRow(newRow);
    return;
  }

  // If not a Command+Click, show the popup
  e.stopPropagation();

  // Create a popup container with your custom styling
  const popup = document.createElement("div");
  popup.style.position = "absolute";
  popup.style.zIndex = "10000";
  popup.style.backgroundColor = "rgba(13,13,13,0.95)";
  popup.style.border = "1px solid rgba(255, 255, 255, 0.1)";
  popup.style.padding = "10px";
  popup.style.borderRadius = "12px";
  popup.style.boxShadow = "0 2px 5px rgba(0,0,0,0.2)";
  popup.style.display = "flex";
  popup.style.flexDirection = "column";
  popup.style.gap = "10px";

  // Create a dropdown for copy options
  const select = document.createElement("select");
  select.style.background = "var(--bg-color)";
  select.style.border = "1px solid rgba(255, 255, 255, 0.2)";
  select.style.color = "rgb(255, 255, 255)";
  select.style.borderRadius = "4px";
  select.style.cursor = "pointer";
  select.style.fontSize = "10px";
  select.style.padding = "4px";
  select.innerHTML = `
    <option value="all">Copy All Steps</option>
    <option value="current">Copy Current Step</option>
    <option value="range">Copy Range of Steps</option>
  `;

  // Create a container for range inputs (hidden by default)
  const rangeContainer = document.createElement("div");
  rangeContainer.style.display = "none";
  rangeContainer.style.gap = "10px";
  rangeContainer.style.flexDirection = "column";

  const startStepContainer = document.createElement("div");
  startStepContainer.style.display = "flex";
  startStepContainer.style.gap = "5px";
  startStepContainer.style.alignItems = "center";

  const startStepLabel = document.createElement("label");
  startStepLabel.textContent = "Start Step:";
  startStepLabel.style.color = "rgb(255, 255, 255)";
  startStepLabel.style.fontSize = "10px";

  const startStepInput = document.createElement("input");
  startStepInput.type = "number";
  startStepInput.id = "startStep";
  startStepInput.min = "1";
  startStepInput.max = updatedObj.traj;
  startStepInput.value = "1";
  startStepInput.style.background = "var(--bg-color)";
  startStepInput.style.border = "1px solid rgba(255, 255, 255, 0.2)";
  startStepInput.style.color = "rgb(255, 255, 255)";
  startStepInput.style.borderRadius = "4px";
  startStepInput.style.fontSize = "10px";
  startStepInput.style.width = "50px";
  startStepInput.style.padding = "4px";

  startStepContainer.appendChild(startStepLabel);
  startStepContainer.appendChild(startStepInput);

  const endStepContainer = document.createElement("div");
  endStepContainer.style.display = "flex";
  endStepContainer.style.gap = "5px";
  endStepContainer.style.alignItems = "center";

  const endStepLabel = document.createElement("label");
  endStepLabel.textContent = "End Step:";
  endStepLabel.style.color = "rgb(255, 255, 255)";
  endStepLabel.style.fontSize = "10px";

  const endStepInput = document.createElement("input");
  endStepInput.type = "number";
  endStepInput.id = "endStep";
  endStepInput.min = "1";
  endStepInput.max = updatedObj.traj;
  endStepInput.value = updatedObj.traj;
  endStepInput.style.background = "var(--bg-color)";
  endStepInput.style.border = "1px solid rgba(255, 255, 255, 0.2)";
  endStepInput.style.color = "rgb(255, 255, 255)";
  endStepInput.style.borderRadius = "4px";
  endStepInput.style.fontSize = "10px";
  endStepInput.style.width = "50px";
  endStepInput.style.padding = "4px";

  endStepContainer.appendChild(endStepLabel);
  endStepContainer.appendChild(endStepInput);

  rangeContainer.appendChild(startStepContainer);
  rangeContainer.appendChild(endStepContainer);

  // Create buttons for confirmation and cancellation
  const confirmButton = document.createElement("button");
  confirmButton.textContent = "Copy";
  confirmButton.style.background = "var(--bg-color)";
  confirmButton.style.border = "1px solid rgba(255, 255, 255, 0.2)";
  confirmButton.style.color = "rgb(255, 255, 255)";
  confirmButton.style.borderRadius = "4px";
  confirmButton.style.cursor = "pointer";
  confirmButton.style.fontSize = "10px";
  confirmButton.style.padding = "4px 8px";

  const cancelButton = document.createElement("button");
  cancelButton.textContent = "Cancel";
  cancelButton.style.background = "var(--bg-color)";
  cancelButton.style.border = "1px solid rgba(255, 255, 255, 0.2)";
  cancelButton.style.color = "rgb(255, 255, 255)";
  cancelButton.style.borderRadius = "4px";
  cancelButton.style.cursor = "pointer";
  cancelButton.style.fontSize = "10px";
  cancelButton.style.padding = "4px 8px";

  // Append all elements to the popup
  popup.appendChild(select);
  popup.appendChild(rangeContainer);
  popup.appendChild(confirmButton);
  popup.appendChild(cancelButton);

  // Position the popup near the copy button
  const rect = e.target.getBoundingClientRect();
  popup.style.left = `${rect.left + window.scrollX}px`;
  popup.style.top = `${rect.bottom + window.scrollY}px`;

  // Append the popup to the body
  document.body.appendChild(popup);

  // Toggle range inputs based on selection
  select.addEventListener("change", () => {
    if (select.value === "range") {
      rangeContainer.style.display = "flex";
    } else {
      rangeContainer.style.display = "none";
    }
  });

  // Function to close the popup
  const closePopup = () => {
    if (popup && popup.parentNode) {
      popup.remove();
    }
    document.removeEventListener("click", handleOutsideClick);
  };

  // Handle clicks outside the popup
  const handleOutsideClick = (event) => {
    if (!popup.contains(event.target)) {
      closePopup();
    }
  };

  // Add event listener to close popup when clicking outside
  setTimeout(() => {
    document.addEventListener("click", handleOutsideClick);
  }, 0);

  // Handle confirmation
  confirmButton.onclick = () => {
    const option = select.value;
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    const container = structureShip.container[rowIndex];
    let newRow;

    if (option === "all") {
      // Copy all steps: create a new container with new Structure objects
      const newStructures = container.structures.map(structure => {
        return new Structure({
          elements: [...structure.elements],
          uniqueElements: [...structure.uniqueElements],
          lattice: structure.lattice.map(row => [...row]),
          atoms: [...structure.atoms],
          periodic: { ...structure.periodic }, // Clone as object/Map
          volumetricFields: null
        });
      });

      const newObj = {
        ...updatedObj,
        structures: newStructures,
        traj: newStructures.length,
      };

      newRow = createRow(newObj);
      row.insertAdjacentElement("afterend", newRow);
      structureShip.len += 1;
      structureShip.container.splice(rowIndex + 1, 0, newObj);
    }
    else if (option === "current") {
      // Copy current step: create a new container with only the current structure
      const stepInput = row.querySelector('input[type="number"]');
      const currentStep = parseInt(stepInput.value, 10) - 1;
      const currentStructure = container.structures[currentStep];

      const newStructure = new Structure({
        elements: [...currentStructure.elements],
        uniqueElements: [...currentStructure.uniqueElements],
        lattice: currentStructure.lattice.map(row => [...row]),
        atoms: [...currentStructure.atoms],
        periodic: { ...currentStructure.periodic }, // Clone as object/Map
        volumetricFields: null
      });

      const newObj = {
        ...updatedObj,
        structures: [newStructure],
        traj: 1,
      };

      newRow = createRow(newObj);
      row.insertAdjacentElement("afterend", newRow);
      structureShip.len += 1;
      structureShip.container.splice(rowIndex + 1, 0, newObj);
    }
    else if (option === "range") {
      // Copy range of steps: create a new container with new Structure objects for the range
      const startStep = parseInt(startStepInput.value, 10) - 1;
      const endStep = parseInt(endStepInput.value, 10) - 1;
      const rangeStructures = container.structures.slice(startStep, endStep + 1);

      const newStructures = rangeStructures.map(structure => {
        return new Structure({
          elements: [...structure.elements],
          uniqueElements: [...structure.uniqueElements],
          lattice: structure.lattice.map(row => [...row]),
          atoms: [...structure.atoms],
          periodic: { ...structure.periodic }, // Clone as object/Map
          volumetricFields: null
        });
      });

      const newObj = {
        ...updatedObj,
        structures: newStructures,
        traj: newStructures.length,
      };

      newRow = createRow(newObj);
      row.insertAdjacentElement("afterend", newRow);
      structureShip.len += 1;
      structureShip.container.splice(rowIndex + 1, 0, newObj);
    }

    closePopup();
    // Select the row just created (inserted right after the source row, not
    // necessarily last in the table) — selectLastAddedRow() would pick
    // whatever row is currently last instead.
    selectRow(newRow);
  };

  // Handle cancellation
  cancelButton.onclick = () => {
    closePopup();
  };
});




  // Delete logic
  row.querySelector(".delete").addEventListener("click", (e) => {
    e.stopPropagation();
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    structureShip.len = structureShip.len - 1;
    structureShip.container.splice(rowIndex, 1);
    row.remove();
    selectLastAddedRow();
    // The removed row may have been checked — re-derive combine/comparison state.
    updateCombineButtonState();
    syncComparisonFromCheckboxes();
  });

  row.dataset.obj = JSON.stringify(obj);
  return row;
}

/** Select a specific row element (its current position in the table decides
 *  its index) — used after inserting a row that isn't necessarily last,
 *  e.g. a copy inserted right after its source row. */
function selectRow(row) {
  if (!row) return;
  const rowIndex = Array.from(row.parentElement.children).indexOf(row);
  if (fileBrowser.selectedRow) fileBrowser.selectedRow.classList.remove("selected");
  row.classList.add("selected");
  fileBrowser.selectedRow = row;
  row.dataset.index = String(rowIndex);
  fileBrowser.selectedRowIndex = rowIndex;
  updateStructureFromRowAndStep(rowIndex);
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

// Checkboxes in the file browser are a plain multi-select (needed so several
// rows can be picked for "combine into one trajectory"). They only drive the
// comparison structure when general.compareModeOn is also on — see
// syncComparisonFromCheckboxes(), the single place that reconciles "what's
// checked" + "is comparison mode on" into fileBrowser.comparisonStructure.

/** Drop the active comparison structure/meshes and reset the crossfade opacity. */
export function clearComparisonStructure() {
  if (!fileBrowser.comparisonRow && !fileBrowser.comparisonStructure) {
    refreshPanelAvailability();
    return;
  }
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
  // Comparison is gone — the crossfade slider no longer applies, so drop
  // both opacities back to the structure's own default instead of
  // leaving the main structure faded from wherever the slider was left.
  general.mainOpacity = 1.0;
  general.compOpacity = 1.0;
  updateVisualization({
    atomsUpdate: true,
    bondsUpdate: true,
    SecondAtomsUpdate: false,
    SecondReRenderAtoms: false,
    SecondBondsUpdate: false,
    SecondReRenderBonds: false,
    SecondReRenderLattice: false
  });
  // No comparison structure anymore — grey out the Comparison panel.
  refreshPanelAvailability();
}

/** Make `row` the active comparison structure (the single checked row). */
function setComparisonRow(row) {
  const rowIndex = Array.from(row.parentElement.children).indexOf(row);
  fileBrowser.comparisonRow = row;
  fileBrowser.comparisonRowIndex = rowIndex;
  const stepInput = row.querySelector('input[type="number"]');
  const container = structureShip.container[rowIndex];
  const step = parseInt(stepInput.value, 10) - 1;
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

  // Wire the step-input listener once per row (not once per check) — the old
  // per-check wiring stacked a new listener on every checkbox toggle.
  if (!row.dataset.comparisonStepWired) {
    row.dataset.comparisonStepWired = "1";
    stepInput.addEventListener("input", () => {
      if (fileBrowser.comparisonRow !== row) return; // no longer the active comparison row
      const idx = Array.from(row.parentElement.children).indexOf(row);
      const cont = structureShip.container[idx];
      const newStep = parseInt(stepInput.value, 10) - 1;
      if (!cont || newStep < 0 || newStep >= cont.structures.length) return;
      fileBrowser.comparisonStructure = cont.structures[newStep];
      updateVisualization({
        SecondAtomsUpdate: false,
        SecondReRenderAtoms: true,
        SecondBondsUpdate: false,
        SecondReRenderBonds: true,
        SecondReRenderLattice: false
      });
      if (fileBrowser.comparisonStructure && fileBrowser.selectedStructure && general.comparisonActive) {
        const L1 = fileBrowser.selectedStructure.lattice.map(r => [...r]);
        const L2 = fileBrowser.comparisonStructure.lattice.map(r => [...r]);
        updateLatticeComparisonPanel(L1, L2);
      }
    });
  }

  if (fileBrowser.comparisonStructure && fileBrowser.selectedStructure && general.comparisonActive) {
    const L1 = fileBrowser.selectedStructure.lattice.map(r => [...r]);
    const L2 = fileBrowser.comparisonStructure.lattice.map(r => [...r]);
    updateLatticeComparisonPanel(L1, L2);
  }
  // A comparison structure now exists — the Comparison panel becomes usable.
  refreshPanelAvailability();
}

/** Show/hide the persistent error line in the Comparison panel, if built. */
function setComparisonErrorText(text) {
  const el = document.getElementById('comparisonErrorField');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

/**
 * Reconcile "which rows are checked" + "is Comparison mode on" into the
 * active comparison structure. Call this on every checkbox change and
 * whenever general.compareModeOn changes (also called once from
 * ComparisonPanel.js's addCompPanel() so a fresh panel build shows the
 * right state immediately).
 */
export function syncComparisonFromCheckboxes() {
  const tbody = document.querySelector('#objectTable tbody');
  const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
  const checkedRows = rows.filter((r) => r.querySelector('input[type="checkbox"]')?.checked);

  if (!general.compareModeOn) {
    setComparisonErrorText(null);
    clearComparisonStructure();
    return;
  }

  if (checkedRows.length === 0) {
    clearComparisonStructure();
    setComparisonErrorText('Please select a structure to compare to.');
  } else if (checkedRows.length === 1) {
    setComparisonErrorText(null);
    setComparisonRow(checkedRows[0]);
  } else {
    clearComparisonStructure();
    setComparisonErrorText('Only one structure can be selected for comparison.');
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
  syncPlanesForSelectedStructure();
  refreshBackendTheme();
  let spins = fileBrowser.selectedStructure.spins?.map(spin => spin.vector ?? null) ?? null;
  if (spins != null && general.spinsActive) updateSpins();
  let forces = fileBrowser.selectedStructure.forces?.map(forces => forces.vector ?? null) ?? null;
  if (forces != null && general.forcesActive) updateForces();
  let fields = fileBrowser.selectedStructure.volumetricFields?.fields ?? null;
  if (fields && fields.length > 0) {
    fieldBrowser.setAvailableFields(fileBrowser.selectedStructure.volumetricFields.fields);
    fieldBrowser.setSelectedField(0);
    const selectedField = fieldBrowser.selectedField;
    // Honor the global "Show Volumetric Field" toggle (Features window).
    selectedField.isVisible = general.fieldActive;
    setActiveField(selectedField);
    updateField();
  }
  else {
    fieldBrowser.setAvailableFields();
    fieldBrowser.setSelectedField(null);
    deleteField();
  }
  //if (fileBrowser.selectedStructure.stress != null) stress = fileBrowser.selectedStructure.stress.map(r => r.tensor);
  createBondLengthControls();
  rebuildPanel('cell'); // lattice inputs follow the selected frame
  rebuildPanel('polyhedra');
  if (
    fileBrowser.comparisonStructure &&
    fileBrowser.selectedStructure &&
    general.comparisonActive // Only update if the lattice comparison popup is on
  ) {
    const L1 = fileBrowser.selectedStructure.lattice.map(row => [...row]);
    const L2 = fileBrowser.comparisonStructure.lattice.map(row => [...row]);
    updateLatticeComparisonPanel(L1, L2);
  }
  updateVisualization({reRenderAtoms: true, reRenderBonds: true, reRenderField: true, reRenderComposition: true});
  // Single choke point for every selection path (row click, step change,
  // programmatic selectStructure, load) — let subscribers (addons) react.
  notifyActiveStructureChange();
}

/**
 * Programmatically select a loaded structure — the same as a user clicking its
 * file-browser row (and setting its step). `rowIndex` is the container index
 * (see getContainers()/getStructures()); `step` is the 0-based frame within it.
 * Updates the browser highlight + 3D view and fires the active-structure
 * change. Returns false if the row/step is out of range. Intended for addons
 * that map their own UI (e.g. an EOS E–V point) to a loaded structure.
 */
export function selectStructure(rowIndex, step = 0) {
  const tbody = document.querySelector('#objectTable tbody');
  const rows = tbody ? tbody.querySelectorAll('tr') : [];
  const container = structureShip.container[rowIndex];
  if (rowIndex < 0 || rowIndex >= rows.length || !container) return false;
  const clampedStep = Math.max(0, Math.min(step, container.structures.length - 1));
  const row = rows[rowIndex];
  const stepInput = row.querySelector('input[type="number"]');
  if (stepInput) stepInput.value = String(clampedStep + 1); // step is 1-based in the UI
  if (fileBrowser.selectedRow) fileBrowser.selectedRow.classList.remove('selected');
  row.classList.add('selected');
  row.dataset.index = String(rowIndex);
  fileBrowser.selectedRow = row;
  fileBrowser.selectedRowIndex = rowIndex;
  updateStructureFromRowAndStep(rowIndex);
  return true;
}

/**
 * Select the next/previous row in the Files table (delta = +1/-1), wrapping
 * around at either end. Keeps the current trajectory step (clamped by
 * selectStructure if the new structure has fewer frames). Used by the
 * Shift+Arrow keyboard shortcut. No-op if fewer than two structures are loaded.
 */
export function selectAdjacentStructure(delta) {
  const tbody = document.querySelector('#objectTable tbody');
  const rows = tbody ? tbody.querySelectorAll('tr') : [];
  if (rows.length < 2) return false;
  const current = fileBrowser.selectedRowIndex ?? 0;
  const next = ((current + delta) % rows.length + rows.length) % rows.length;
  return selectStructure(next, fileBrowser.stepInput ?? 0);
}

/**
 * Step the CURRENTLY selected structure's trajectory frame by delta (+1/-1),
 * clamped to [1, traj] — unlike selectAdjacentStructure this does NOT wrap
 * (scrubbing past the last/first frame just stops, like a video scrubber).
 * Reuses the row's own step <input> and fires the same 'input' event a
 * manual edit would, so the existing stepInputValidation wiring (updateRow)
 * drives the actual structure update. No-op if the structure has one frame.
 */
export function selectAdjacentStep(delta) {
  const row = fileBrowser.selectedRow;
  const stepInput = row ? row.querySelector('input[type="number"]') : null;
  if (!stepInput) return false;
  const max = parseInt(stepInput.max, 10) || 1;
  if (max < 2) return false;
  const current = parseInt(stepInput.value, 10) || 1;
  const next = Math.min(Math.max(current + delta, 1), max);
  if (next === current) return false;
  stepInput.value = String(next);
  stepInput.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
