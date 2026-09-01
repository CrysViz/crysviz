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
import {Structure, StructureContainer} from '../model/index.js';
import { refreshBackendTheme } from './BackendPanel/BackendTheme.js';
import { recenterCamera, captureCameraSnapshot, applyCameraSnapshot, fitCameraToCurrentStructure } from './WindowAndSceneControls.js';
import { notifyActiveStructureChange } from '../state/structures.js';
import { generateID } from '../utils/index.js';
import { snapshotFeatureToggles, applyFeatureToggles, applyDefaultFeatureToggles } from './FeatureLockModule.js';

const rowObjects = new WeakMap();

export function getRowObject(row) {
  return rowObjects.get(row) || null;
}

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

  const popup = document.createElement('div');
  popup.className = 'cv-fb-popup cv-fb-popup--modal';

  const label = document.createElement('div');
  label.textContent = 'Name for the combined trajectory:';
  label.className = 'cv-fb-popup-label';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combine-name-input cv-fb-popup-input';
  input.value = 'Combined Trajectory';

  const buttonRow = document.createElement('div');
  buttonRow.className = 'cv-fb-popup-btn-row';

  const confirmButton = document.createElement('button');
  confirmButton.textContent = 'Combine';
  confirmButton.className = 'cv-fb-popup-btn';

  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  cancelButton.className = 'cv-fb-popup-btn';

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
async function combineCheckedRows(name) {
  const tbody = document.querySelector('#objectTable tbody');
  const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
  const checkedRows = rows.filter((r) => r.querySelector('input[type="checkbox"]')?.checked);
  if (checkedRows.length < 2) return;

  const combinedStructures = [];
  for (const r of checkedRows) {
    const idx = rows.indexOf(r);
    const container = structureShip.container[idx];
    if (!container) continue;
    // framesSlice materialises store-backed trajectories (and may resolve
    // asynchronously when frames come from disk); the combined container is a
    // plain eager one either way — combining is an explicit request for
    // independent copies.
    const frames = await Promise.resolve(container.framesSlice());
    for (const structure of frames) combinedStructures.push(cloneStructure(structure));
  }
  if (!combinedStructures.length) return;

  const combinedName = (name && name.trim()) ? name.trim() : 'Combined Trajectory';
  const newRow = createRow({ name: combinedName, traj: combinedStructures.length, step: 1 });
  tbody.appendChild(newRow);
  structureShip.len += 1;
  structureShip.container.push(new StructureContainer({ fileName: combinedName, structures: combinedStructures }));

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

/** Frame copy for the row copy/combine actions: fresh Structure, own
 *  lattice/element arrays, no field. (Atoms are shared, as they always were.) */
function cloneStructure(structure) {
  return new Structure({
    elements: [...structure.elements],
    uniqueElements: [...structure.uniqueElements],
    lattice: structure.lattice.map(row => [...row]),
    atoms: [...structure.atoms],
    periodic: { ...structure.periodic },
    volumetricFields: null,
  });
}

/** copy_<n>_<source>, n one past the highest copy of that source in the table. */
function nextCopyName(sourceName) {
  const suffix = `_${sourceName}`;
  let n = 0;
  for (const el of document.querySelectorAll('#objectTable tbody tr .name-inner')) {
    const name = el.textContent ?? '';
    if (!name.startsWith('copy_') || !name.endsWith(suffix)) continue;
    const index = name.slice('copy_'.length, name.length - suffix.length);
    if (/^\d+$/.test(index)) n = Math.max(n, parseInt(index, 10));
  }
  return `copy_${n + 1}_${sourceName}`;
}

/** Insert a row holding copies of `structures` right after `row`, and select
 *  it. `step` is the frame the new row opens on. */
function insertCopyRow(row, structures, step = 1) {
  const rowIndex = Array.from(row.parentElement.children).indexOf(row);
  const name = nextCopyName(getRowObject(row)?.name ?? '');
  const newRow = createRow({ name, traj: structures.length, step: Math.min(step, structures.length) });
  row.insertAdjacentElement('afterend', newRow);
  structureShip.len += 1;
  structureShip.container.splice(rowIndex + 1, 0, new StructureContainer({ fileName: name, structures }));
  // The copy sits right after its source, not necessarily last in the table —
  // selectLastAddedRow() would pick whatever row is currently last instead.
  selectRow(newRow);
  return newRow;
}

/** Rename a row: the label, its row object and the container's fileName,
 *  which is what derived rows (relax_/md_/eos_/sym_/copy_) are named after. */
export function renameRow(row, name) {
  const trimmed = String(name ?? '').trim();
  const obj = getRowObject(row);
  if (!trimmed || !obj || trimmed === obj.name) return;
  const rowIndex = Array.from(row.parentElement.children).indexOf(row);
  const container = structureShip.container[rowIndex];
  if (container) container.fileName = trimmed;
  obj.name = trimmed;
  row.querySelector('.name-inner').textContent = trimmed;
  row.querySelector('.name-scroll').textContent = trimmed;
}

/** Inline rename: swap the name label for a text input until Enter/blur
 *  (commit) or Escape (cancel). */
function startRename(row) {
  const cell = row.querySelector('.name-cell');
  if (!cell || cell.classList.contains('is-editing')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cv-fb-rename';
  input.value = getRowObject(row)?.name ?? '';
  cell.classList.add('is-editing');
  cell.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) renameRow(row, input.value);
    input.remove();
    cell.classList.remove('is-editing');
  };
  input.addEventListener('keydown', (e) => {
    // Neither key may reach the app's shortcuts while a name is being typed.
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// Function to create a new row in the table
export function createRow(obj) {
  const row = document.createElement("tr");
  row.classList.add("ftr");
  row.innerHTML = `
    <td class="ftd"><input type="checkbox"></td>
    <td class="ftd">
      <div class="name-cell">
        <span class="name-inner"></span>
        <span class="name-scroll"></span>
      </div>
    </td>
    <td class="ftd"></td>
    <td class="ftd"><input type="number" min="1" /></td>
    <td class="ftd icon copy">⧉</td>
    <td class="ftd icon delete">×</td>
  `;

  row.querySelector('.name-inner').textContent = String(obj.name ?? '');
  row.querySelector('.name-scroll').textContent = String(obj.name ?? '');
  const nameCell = row.querySelector('.name-cell');
  nameCell.title = 'Double-click to rename';
  nameCell.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(row);
  });
  const trajectoryCell = row.querySelector('td:nth-child(3)');
  trajectoryCell.textContent = String(obj.traj ?? '');
  const initialStepInput = row.querySelector('input[type="number"]');
  initialStepInput.max = String(obj.traj ?? '');
  initialStepInput.value = String(obj.step ?? '');

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
  const updatedObj = getRowObject(row);
  // Check if Command (Mac) or Ctrl (Windows/Linux) is pressed
  const isCommandClick = e.metaKey || e.ctrlKey;

  if (isCommandClick) {
    e.stopPropagation();
    e.preventDefault();

    // Copy current step, no popup. framesSlice materialises the frame for a
    // store-backed trajectory and may resolve asynchronously.
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    const container = structureShip.container[rowIndex];
    const currentStep = parseInt(row.querySelector('input[type="number"]').value, 10) - 1;
    Promise.resolve(container.framesSlice(currentStep, currentStep + 1)).then((frames) => {
      if (frames.length) insertCopyRow(row, frames.map(cloneStructure));
    });
    return;
  }

  // If not a Command+Click, show the popup
  e.stopPropagation();

  // Create a popup container with your custom styling
  const popup = document.createElement("div");
  popup.className = "cv-fb-popup cv-fb-popup--anchored";

  // Create a dropdown for copy options
  const select = document.createElement("select");
  select.className = "cv-fb-copy-select";
  select.innerHTML = `
    <option value="current">Copy Current Step</option>
    <option value="all">Copy All Steps</option>
    <option value="range">Copy Range of Steps</option>
  `;

  // Create a container for range inputs (hidden by default)
  const rangeContainer = document.createElement("div");
  rangeContainer.className = "cv-fb-copy-range";

  const startStepContainer = document.createElement("div");
  startStepContainer.className = "cv-fb-copy-step-row";

  const startStepLabel = document.createElement("label");
  startStepLabel.textContent = "Start Step:";
  startStepLabel.className = "cv-fb-copy-step-label";

  const startStepInput = document.createElement("input");
  startStepInput.type = "number";
  startStepInput.id = "startStep";
  startStepInput.min = "1";
  startStepInput.max = updatedObj.traj;
  startStepInput.value = "1";
  startStepInput.className = "cv-fb-copy-step-input";

  startStepContainer.appendChild(startStepLabel);
  startStepContainer.appendChild(startStepInput);

  const endStepContainer = document.createElement("div");
  endStepContainer.className = "cv-fb-copy-step-row";

  const endStepLabel = document.createElement("label");
  endStepLabel.textContent = "End Step:";
  endStepLabel.className = "cv-fb-copy-step-label";

  const endStepInput = document.createElement("input");
  endStepInput.type = "number";
  endStepInput.id = "endStep";
  endStepInput.min = "1";
  endStepInput.max = updatedObj.traj;
  endStepInput.value = updatedObj.traj;
  endStepInput.className = "cv-fb-copy-step-input";

  endStepContainer.appendChild(endStepLabel);
  endStepContainer.appendChild(endStepInput);

  rangeContainer.appendChild(startStepContainer);
  rangeContainer.appendChild(endStepContainer);

  // Create buttons for confirmation and cancellation
  const confirmButton = document.createElement("button");
  confirmButton.textContent = "Copy";
  confirmButton.className = "cv-fb-popup-btn cv-fb-popup-btn--compact";

  const cancelButton = document.createElement("button");
  cancelButton.textContent = "Cancel";
  cancelButton.className = "cv-fb-popup-btn cv-fb-popup-btn--compact";

  // Append all elements to the popup
  popup.appendChild(select);
  popup.appendChild(rangeContainer);
  popup.appendChild(confirmButton);
  popup.appendChild(cancelButton);

  // Position the popup near the copy button, then clamp it into the viewport.
  // Docked right/bottom (or the mobile sheet) puts the button near an edge, so
  // anchoring naively at its left/bottom would spill the popup off-screen; must
  // measure it in the DOM first, hence append before positioning.
  const rect = e.target.getBoundingClientRect();
  document.body.appendChild(popup);
  const pr = popup.getBoundingClientRect();
  const margin = 8;
  let left = rect.left;
  if (left + pr.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - pr.width - margin);
  }
  let top = rect.bottom;
  if (top + pr.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - pr.height); // flip above the button
  }
  popup.style.left = `${left + window.scrollX}px`;
  popup.style.top = `${top + window.scrollY}px`;

  // Toggle range inputs based on selection
  select.addEventListener("change", () => {
    rangeContainer.classList.toggle("is-visible", select.value === "range");
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
  confirmButton.onclick = async () => {
    const option = select.value;
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    const container = structureShip.container[rowIndex];
    const stepInput = row.querySelector('input[type="number"]');
    const currentStep = parseInt(stepInput.value, 10);
    // framesSlice materialises store-backed trajectories (possibly
    // asynchronously); copies are explicit requests for independent frames.
    let frames;
    if (option === 'all') {
      frames = await Promise.resolve(container.framesSlice());
    } else if (option === 'range') {
      const startStep = parseInt(startStepInput.value, 10) - 1;
      const endStep = parseInt(endStepInput.value, 10) - 1;
      frames = await Promise.resolve(container.framesSlice(startStep, endStep + 1));
    } else {
      frames = await Promise.resolve(container.framesSlice(currentStep - 1, currentStep));
    }
    closePopup();
    // "All" reopens on the source's current frame; the others start at 1.
    insertCopyRow(row, frames.map(cloneStructure), option === 'all' ? currentStep : 1);
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

  rowObjects.set(row, obj);
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
  const overlayKey = row.dataset.overlayKey;
  // frameAtDetached: an independent Structure for the second rendering, so a
  // container that materialises frames (or renders all steps through one
  // Structure) can overlay two steps of the same trajectory. May resolve
  // asynchronously for a disk-backed trajectory — the entry is then pushed on
  // arrival and its meshes rendered right after.
  const pushEntry = (structure, rerenderNow) => {
    if (!structure) return;
    fileBrowser.overlayEntries.push({
      key: overlayKey,
      row,
      structure,
      opacity: defaultOpacity,
      // Comparison mode has exactly one entry, so its "Show Comparison Bonds"
      // toggle default (general.showSecondBond) applies directly; Overlay mode
      // always starts with bonds shown (each row has its own toggle to turn off).
      showBonds: general.compareModeOn ? general.showSecondBond : true,
    });
    if (rerenderNow) {
      updateVisualization({
        atomsUpdate: false,
        bondsUpdate: false,
        SecondAtomsUpdate: false,
        SecondReRenderAtoms: true,
        SecondBondsUpdate: false,
        SecondReRenderBonds: true,
      });
      refreshOverlayLatticePlots();
    }
  };
  const frameRef = container.frameAtDetached(step);
  if (frameRef && typeof frameRef.then === 'function') frameRef.then((s) => pushEntry(s, true));
  else pushEntry(frameRef, false);

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
      // Same detached-frame contract (and possible asynchrony) as when the
      // entry was created.
      const applyFrame = (structure) => {
        if (!structure) return;
        entry.structure = structure;
        updateVisualization({
          atomsUpdate: false,
          bondsUpdate: false,
          SecondAtomsUpdate: false,
          SecondReRenderAtoms: true,
          SecondBondsUpdate: false,
          SecondReRenderBonds: true,
        });
        refreshOverlayLatticePlots();
      };
      const nextFrame = cont.frameAtDetached(newStep);
      if (nextFrame && typeof nextFrame.then === 'function') nextFrame.then(applyFrame);
      else applyFrame(nextFrame);
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
  rowObjects.set(row, obj);
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

  // The frame may need materialising (store-backed trajectory) and can even
  // arrive asynchronously (frames read back from the file on disk). Rapid
  // scrubbing overlaps resolutions, so only the newest request may finish
  // the switch.
  const frameRef = container.frameAt(step);
  if (frameRef && typeof frameRef.then === 'function') {
    const token = ++frameSwitchToken;
    frameRef.then((resolved) => {
      if (token !== frameSwitchToken || !resolved) return;
      finishFrameSwitch(container, step, resolved, rowChanged);
    });
    return;
  }
  if (!frameRef) return;
  frameSwitchToken++; // a sync switch supersedes any in-flight async one
  finishFrameSwitch(container, step, frameRef, rowChanged);
}

// Lets a late async frame resolution detect that a newer selection has
// superseded it (see updateStructureFromRowAndStep).
let frameSwitchToken = 0;

// The tail of a frame switch, once the frame exists as a Structure.
function finishFrameSwitch(container, step, structure, rowChanged) {
  void step;
  fileBrowser.selectedStructure = structure;
  syncPlanesForSelectedStructure();
  refreshBackendTheme();
  let spins = fileBrowser.selectedStructure.spins?.map(spin => spin.vector ?? null) ?? null;
  if (spins != null && general.spinsActive) updateSpins();
  let forces = fileBrowser.selectedStructure.forces?.map(forces => forces.vector ?? null) ?? null;
  if (forces != null && general.forcesActive) updateForces();
  // Point the field browser at the newly selected structure's catalog. Going
  // through the catalog rather than the flat `fields` array matters for proxy
  // formats: a WAVECAR's `fields` is empty until a band is expanded, but the
  // catalog still lists everything the file offers, and switching back to that
  // structure must restore whatever the user had already loaded.
  const fieldCatalog = fileBrowser.selectedStructure.volumetricFields?.catalog ?? null;
  if (fieldCatalog && fieldCatalog.nodes.length > 0) {
    fieldBrowser.setCatalog(fieldCatalog);
    const selectedField = fieldBrowser.selectedField;
    if (selectedField) {
      // Honor the global "Show Volumetric Field" toggle (Features window).
      selectedField.isVisible = general.fieldActive;
      setActiveField(selectedField);
      updateField();
    } else {
      // A catalog with nothing expanded yet (a freshly-opened WAVECAR): there is
      // no isosurface to draw until the user picks a band.
      deleteField();
    }
  }
  else {
    fieldBrowser.setCatalog(null);
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
