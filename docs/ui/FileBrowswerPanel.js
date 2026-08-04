import {app, general, structureShip, fileBrowser} from '../state/store.js';
import {updateVisualization} from '../core/crystal-viewer.js';
import { refreshActivePanels, refreshPanelAvailability, rebuildPanel } from './panels/PanelManager.js';
import {createBondLengthControls} from './BondLengthPanel.js';
import {updateSpins} from '../render/index.js';
import {updateForces} from '../render/index.js';
import {fieldBrowser} from './FieldPanel.js';
import { setActiveField, updateField, deleteField, disposeOverlayMeshes} from '../render/index.js';
import {updateLatticeComparisonPanel, removeLatticeComparisonPopup} from './LatticeComparisonPanel.js';
import { syncPlanesForSelectedStructure } from './PlanesPanel.js';
import {Structure} from '../model/index.js';
import { refreshBackendTheme } from './BackendPanel/BackendTheme.js';
import { recenterCamera, captureCameraSnapshot, applyCameraSnapshot, fitCameraToCurrentStructure } from './WindowAndSceneControls.js';
import { notifyActiveStructureChange } from '../state/structures.js';
import { generateID } from '../utils/index.js';
import { snapshotFeatureToggles, applyFeatureToggles, applyDefaultFeatureToggles } from './FeatureLockModule.js';

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
  syncOverlayFromCheckboxes();

  selectRow(newRow);
}

/** Wire the static combine button (index.html) once at startup. */
export function initCombineTrajectoriesButton() {
  const btn = document.getElementById('combineTrajectoriesButton');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const count = countChecked();
    if (count < 2) return; // guarded by the disabled state anyway
    // Classic Comparison mode expects exactly one checked row; combining 3+
    // rows while it's on would also trip its own "only one" error. Overlay
    // mode has no such limit, so this only guards Comparison.
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
  // (any number checked) and the Structure Overlay module — every checked row
  // becomes one overlay entry while general.compareModeOn is on (see
  // syncOverlayFromCheckboxes).
  const checkbox = row.querySelector('input[type="checkbox"]');
  checkbox.addEventListener("change", () => {
    updateCombineButtonState();
    syncOverlayFromCheckboxes();
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
    syncOverlayFromCheckboxes();
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
// rows can be picked for "combine into one trajectory"). They drive
// fileBrowser.overlayEntries only when one of two mutually-exclusive modes is
// on: general.compareModeOn (classic Comparison panel — exactly one checked
// row, Main/Comp crossfade slider) or general.overlayModeOn (Multi-Structure
// Overlay panel — any number of checked rows, independent per-row controls).
// Both panels' own "Enable ___" toggle handlers turn the other mode off before
// calling syncOverlayFromCheckboxes() below, the single place that reconciles
// "what's checked" + "which mode is on" into fileBrowser.overlayEntries.

const DEFAULT_COMPARISON_OPACITY = 1.0; // classic Comparison: crossfade slider starts centered (both fully opaque)
const DEFAULT_OVERLAY_OPACITY = 0.6; // Multi-Structure Overlay: translucent by default, so overlaid structures are visible through each other

/** Name shown for an overlay entry in the Overlay panel's table and the
 *  lattice-overlay plots — the row's display name in the Files list. */
export function overlayEntryLabel(entry) {
  return entry.row?.querySelector('.name-inner')?.textContent || 'Structure';
}

/** Drop every overlay entry's meshes and empty fileBrowser.overlayEntries. */
export function clearAllOverlayStructures() {
  if (!fileBrowser.overlayEntries.length) {
    refreshPanelAvailability();
    return;
  }
  for (const entry of fileBrowser.overlayEntries) disposeOverlayMeshes(entry.key);
  fileBrowser.overlayEntries = [];

  updateVisualization({
    atomsUpdate: true,
    bondsUpdate: true,
    SecondAtomsUpdate: false,
    SecondReRenderAtoms: false,
    SecondBondsUpdate: false,
    SecondReRenderBonds: false,
  });
  removeLatticeComparisonPopup();
  // No overlay structures anymore — grey out the Overlay panel.
  refreshPanelAvailability();
}

/** Show/hide a panel's persistent error line, if built. `elementId` differs
 *  per panel: Comparison uses 'comparisonErrorField', Overlay uses
 *  'overlayErrorField' (two separate DOM panels, see ComparisonPanel.js /
 *  OverlayPanel.js). */
function setErrorText(elementId, text) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

/** Push the main structure's lattice + every overlay entry's lattice into the
 *  (possibly multi-block) lattice-overlay popup, or remove it if there's
 *  nothing to show. No-op if the popup isn't toggled on. */
export function refreshOverlayLatticePlots() {
  if (!general.comparisonActive) return;
  if (!fileBrowser.selectedStructure || !fileBrowser.overlayEntries.length) {
    removeLatticeComparisonPopup();
    return;
  }
  const L1 = fileBrowser.selectedStructure.lattice.map((r) => [...r]);
  const comparisons = fileBrowser.overlayEntries.map((entry) => ({
    label: overlayEntryLabel(entry),
    lattice: entry.structure.lattice.map((r) => [...r]),
  }));
  updateLatticeComparisonPanel(L1, comparisons);
}

/** Build a fresh overlay entry for a newly-checked row and render its meshes. */
function addOverlayEntryForRow(row, defaultOpacity) {
  const rowIndex = Array.from(row.parentElement.children).indexOf(row);
  const stepInput = row.querySelector('input[type="number"]');
  const container = structureShip.container[rowIndex];
  const step = parseInt(stepInput.value, 10) - 1;
  if (!container || step < 0 || step >= container.structures.length) return;

  if (!row.dataset.overlayKey) row.dataset.overlayKey = generateID(['overlay']);
  fileBrowser.overlayEntries.push({
    key: row.dataset.overlayKey,
    row,
    structure: container.structures[step],
    opacity: defaultOpacity,
    // Comparison mode has exactly one entry, so its "Show Comparison Bonds"
    // toggle default (general.showSecondBond) applies directly; Overlay mode
    // always starts with bonds shown (each row has its own toggle to turn off).
    showBonds: general.compareModeOn ? general.showSecondBond : true,
  });

  // Wire the step-input listener once per row (not once per check) — stacking
  // a new listener on every checkbox toggle would fire the update N times.
  if (!row.dataset.overlayStepWired) {
    row.dataset.overlayStepWired = "1";
    stepInput.addEventListener("input", () => {
      const entry = fileBrowser.overlayEntries.find((e) => e.row === row);
      if (!entry) return; // row is no longer overlaid
      const idx = Array.from(row.parentElement.children).indexOf(row);
      const cont = structureShip.container[idx];
      const newStep = parseInt(stepInput.value, 10) - 1;
      if (!cont || newStep < 0 || newStep >= cont.structures.length) return;
      entry.structure = cont.structures[newStep];
      updateVisualization({
        atomsUpdate: false,
        bondsUpdate: false,
        SecondAtomsUpdate: false,
        SecondReRenderAtoms: true,
        SecondBondsUpdate: false,
        SecondReRenderBonds: true,
      });
      refreshOverlayLatticePlots();
    });
  }
}

/** Drop entries for rows that got unchecked (or deleted), add entries for
 *  newly-checked rows — shared by both modes below, only the default opacity
 *  for freshly-created entries differs. */
function reconcileOverlayEntries(checkedRows, defaultOpacity) {
  fileBrowser.overlayEntries = fileBrowser.overlayEntries.filter((entry) => {
    if (checkedRows.includes(entry.row)) return true;
    disposeOverlayMeshes(entry.key);
    return false;
  });

  const existingRows = new Set(fileBrowser.overlayEntries.map((e) => e.row));
  for (const row of checkedRows) {
    if (existingRows.has(row)) continue;
    addOverlayEntryForRow(row, defaultOpacity);
  }
}

/**
 * Reconcile "which rows are checked" + "which of the two mutually-exclusive
 * overlay modes is on" into fileBrowser.overlayEntries. Call this on every
 * checkbox change and whenever general.compareModeOn / general.overlayModeOn
 * changes. Rebuilds both panels' tables (whichever is open) so they always
 * reflect the result — neither panel calls this from its own build, which
 * would recurse back into rebuildPanel.
 */
export function syncOverlayFromCheckboxes() {
  const tbody = document.querySelector('#objectTable tbody');
  const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
  const checkedRows = rows.filter((r) => r.querySelector('input[type="checkbox"]')?.checked);

  const finish = () => {
    refreshPanelAvailability();
    // Single unified panel now (both tabs live in the same DOM subtree) — see
    // ui/ComparisonOverlayPanel.js.
    rebuildPanel('comparison');
  };

  if (general.compareModeOn) {
    // Classic Comparison: exactly one checked row.
    setErrorText('overlayErrorField', null);
    if (checkedRows.length === 0) {
      clearAllOverlayStructures();
      setErrorText('comparisonErrorField', 'Please select a structure to compare to.');
      finish();
      return;
    }
    if (checkedRows.length > 1) {
      clearAllOverlayStructures();
      setErrorText('comparisonErrorField', 'Only one structure can be selected for comparison.');
      finish();
      return;
    }
    setErrorText('comparisonErrorField', null);
    reconcileOverlayEntries(checkedRows, DEFAULT_COMPARISON_OPACITY);
  } else if (general.overlayModeOn) {
    // Multi-Structure Overlay: any number of checked rows.
    setErrorText('comparisonErrorField', null);
    if (checkedRows.length === 0) {
      clearAllOverlayStructures();
      setErrorText('overlayErrorField', 'Check one or more structures below to overlay them.');
      finish();
      return;
    }
    setErrorText('overlayErrorField', null);
    reconcileOverlayEntries(checkedRows, DEFAULT_OVERLAY_OPACITY);
  } else {
    setErrorText('comparisonErrorField', null);
    setErrorText('overlayErrorField', null);
    clearAllOverlayStructures();
    finish();
    return;
  }

  updateVisualization({
    atomsUpdate: false,
    bondsUpdate: false,
    SecondAtomsUpdate: false,
    SecondReRenderAtoms: true,
    SecondBondsUpdate: false,
    SecondReRenderBonds: true,
  });
  refreshOverlayLatticePlots();
  finish();
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
    // Honor an explicit obj.step. Every caller is an MD/relax run that just
    // finished appending frames and passes the LAST one, wanting the row
    // parked there — but this used to only clamp downward, so the input kept
    // the 1 it was created with at the start of the run and a finished
    // 51-step relax opened on frame 1. selectLastAddedRow() reads this input
    // (via updateStructureFromRowAndStep), so setting it here is what puts
    // the viewer on the relaxed structure.
    if (obj.step !== undefined && obj.step !== null) {
      stepInput.value = String(Math.min(Math.max(1, obj.step), obj.traj));
    } else if (parseInt(stepInput.value, 10) > obj.traj) {
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
    // Plain multi-select, same as createRow()'s checkbox handler — see
    // syncOverlayFromCheckboxes for how checked rows map to overlay entries
    // (only meaningful with the Overlay toggle on).
    updateCombineButtonState();
    syncOverlayFromCheckboxes();
  }
}

// Tracks the container behind the previously active row (by reference, not
// index — indices shift when rows are deleted/inserted, an object reference
// doesn't) so updateStructureFromRowAndStep can tell a genuine row switch
// apart from a same-row trajectory step change, and knows which container to
// save the outgoing camera/feature snapshot onto. Stays null until the first
// switch actually happens.
let lastActiveContainer = null;

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

  // A genuine structure switch (different row/container), not just a
  // trajectory step change within the same one — the camera/feature locks
  // are deliberately per-structure, not per-step (see store.js's
  // cameraLocked/featuresLocked).
  const rowChanged = lastActiveContainer !== null && lastActiveContainer !== container;
  if (rowChanged) {
    if (!app.cameraLocked) lastActiveContainer.cameraSnapshot = captureCameraSnapshot();
    if (general.featuresLocked === false) lastActiveContainer.featureSnapshot = snapshotFeatureToggles();
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
  refreshOverlayLatticePlots(); // only updates if the lattice-overlay popup is on
  updateVisualization({reRenderAtoms: true, reRenderBonds: true, reRenderField: true, reRenderComposition: true});

  if (rowChanged) {
    if (!app.cameraLocked) {
      // A container this row has already shown (while unlocked) restores its
      // own remembered view; one never shown before resets to the canonical
      // direction instead of keeping whatever direction is currently active
      // — that current direction could belong to a DIFFERENT structure's own
      // customization (e.g. duplicate a structure, unlock, rotate the copy,
      // then visit the original for the first time since unlocking), and
      // inheriting it would read as "the original moved too".
      if (container.cameraSnapshot) applyCameraSnapshot(container.cameraSnapshot);
      else fitCameraToCurrentStructure({ resetDirection: true });
    }
    if (general.featuresLocked === false) {
      // Same reasoning as the camera fallback above: a container never
      // individually saved falls back to the app's own declared defaults,
      // not whatever the checkboxes currently read (which may reflect a
      // DIFFERENT structure's customization made after unlocking).
      if (container.featureSnapshot) applyFeatureToggles(container.featureSnapshot);
      else applyDefaultFeatureToggles();
    }
  }
  lastActiveContainer = container;

  // Every selection path funnels through here (row click, step change,
  // programmatic selectStructure, load) — re-evaluate panel availability here
  // too, not just in the row-click handler, so a panel gated on the selected
  // structure (e.g. Atomistic vs. fractional occupancy) can't be left stuck
  // greyed/un-greyed after a programmatic selection (selectLastAddedRow,
  // selectStructure) that skips that handler.
  refreshPanelAvailability();

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
