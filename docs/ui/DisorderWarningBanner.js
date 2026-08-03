// Top-center banner over the 3D view (#view), shown when the selected structure
// has fractionally occupied sites and a feature that cannot represent them is
// active.
//
// Interatomic potentials and ML force fields need one definite species per
// site: there is no defined force on an atom that is half Fe and half Ni, so
// MD and relaxation are disabled outright rather than quietly returning numbers
// for a structure they cannot describe. Polyhedra are disabled for the same
// family of reason - a coordination polyhedron's identity comes from its centre
// and ligand species, which a mixed site does not have a single answer for.
//
// Reactive: call updateDisorderWarning() wherever the selected structure or
// those flags can change.

import { general, fileBrowser } from '../state/store.js';

let banner = null;

/**
 * True when any visible atom of the selected structure is a mixed or partially
 * occupied site. Cached per structure — occupancy only changes when the
 * structure itself is edited or reloaded.
 *
 * @param {any} [structure]
 * @returns {boolean}
 */
export function structureHasFractionalOccupancy(structure = fileBrowser.selectedStructure) {
  if (!structure?.atoms?.length) return false;
  if (structure._hasFractionalOccupancy === undefined) {
    structure._hasFractionalOccupancy = structure.atoms.some((a) => a.isDisordered?.());
  }
  return !!structure._hasFractionalOccupancy;
}

/** Drop the cached flag after a structure edit. */
export function invalidateFractionalOccupancyCache(structure = fileBrowser.selectedStructure) {
  if (structure) structure._hasFractionalOccupancy = undefined;
}

function ensureBanner() {
  if (banner) return banner;
  const view = document.getElementById('view');
  if (!view) return null;

  banner = document.createElement('div');
  banner.className = 'cv-disorder-warning';
  banner.style.cssText = `
    position: absolute;
    top: 5px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2000;
    padding: 6px 14px;
    border-radius: 6px;
    background: rgba(40, 30, 0, 0.85);
    border: 1px solid rgba(255, 193, 7, 0.6);
    color: #ffc107;
    font-size: 12px;
    font-family: inherit;
    font-weight: 500;
    white-space: nowrap;
    pointer-events: none;
    display: none;
  `;
  view.appendChild(banner);
  return banner;
}

export function updateDisorderWarning() {
  const el = ensureBanner();
  if (!el) return;
  const disordered = structureHasFractionalOccupancy();
  if (!disordered) { el.style.display = 'none'; return; }

  const blocked = [];
  if (general.showPolyhedra) blocked.push('Polyhedra');
  if (!blocked.length) { el.style.display = 'none'; return; }

  // textContent replaces all children, so the action button below is never
  // appended twice across repeated calls.
  el.textContent = `⚠ ${blocked.join(' and ')} unavailable for fractionally occupied sites`;
  // The banner is the one place the user is already looking when disorder
  // blocks something, so it carries the way out rather than making them hunt
  // for it in a menu.
  const action = document.createElement('button');
  action.textContent = 'Order structure…';
  action.style.cssText = `
    margin-left: 10px; pointer-events: auto; cursor: pointer;
    background: rgba(255,193,7,0.18); border: 1px solid rgba(255,193,7,0.6);
    color: #ffc107; border-radius: 4px; font-size: 11px; padding: 2px 8px;
    font-family: inherit;
  `;
  action.onclick = () => openOrderStructureDialog();
  el.appendChild(action);
  el.style.display = 'block';
}

// --- Method-choice modal (Random / Use Majority / Cancel) ---
// Same "png-export-modal card + paste-modal-actions row" convention as the
// app's other confirm dialogs (see ConfirmModal.js, RaytraceWarningModal.js);
// built lazily once and reused, hidden between shows. window.confirm() was
// the original choice here, but a two-way OK/Cancel doesn't have a slot for a
// plain "Cancel out of this entirely" option once each answer is a named
// method — three named outcomes need three named buttons.
let methodModal = null;
let methodTitleEl = null;
let methodMessageEl = null;
let choiceActions = null;
let methodRandomBtn = null;
let methodMajorityBtn = null;
let methodCancelBtn = null;
let sizeRow = null;
let sizeSelect = null;
let previewActions = null;
let previewRerollBtn = null;
let previewAcceptBtn = null;
let previewDiscardBtn = null;
let methodPreviousFocus = null;
let methodResolve = null;
// Set only while the preview row (see previewRandomOrdering) is open, so a
// stray Escape/backdrop-click routes to "discard the preview" instead of the
// choice modal's "cancel out entirely" — the two states share one dialog.
let discardPreview = null;

function buildMethodModal() {
  if (methodModal) return;
  methodModal = document.createElement('div');
  methodModal.id = 'orderStructureModal';
  methodModal.hidden = true;
  methodModal.innerHTML = `
    <div class="order-structure-modal png-export-modal" role="dialog" aria-modal="true" aria-labelledby="orderStructureModalTitle">
      <h3 id="orderStructureModalTitle">Order this structure?</h3>
      <p id="orderStructureModalMessage"></p>
      <div class="paste-modal-actions" id="orderStructureChoiceActions">
        <button type="button" id="orderStructureRandomBtn" title="Randomly assign one species per site, weighted to preserve the overall composition (recommended).">Random</button>
        <button type="button" id="orderStructureMajorityBtn" title="Every site takes its most-occupied species. Faster, but destroys stoichiometry — a 50/50 Fe/Ni alloy becomes pure Fe.">Use Majority</button>
        <button type="button" id="orderStructureCancelBtn">Cancel</button>
      </div>
      <div class="order-structure-size-row" id="orderStructureSizeRow" hidden>
        <label for="orderStructureMultiplierSelect">Supercell size</label>
        <select id="orderStructureMultiplierSelect"></select>
      </div>
      <div class="paste-modal-actions" id="orderStructurePreviewActions" hidden>
        <button type="button" id="orderStructureRerollBtn" title="Try a different random decoration at the same supercell size.">Compute Again</button>
        <button type="button" id="orderStructureAcceptBtn">Accept</button>
        <button type="button" id="orderStructureDiscardBtn">Discard</button>
      </div>
    </div>
  `;
  document.body.appendChild(methodModal);

  methodTitleEl = document.getElementById('orderStructureModalTitle');
  methodMessageEl = document.getElementById('orderStructureModalMessage');
  choiceActions = document.getElementById('orderStructureChoiceActions');
  methodRandomBtn = document.getElementById('orderStructureRandomBtn');
  methodMajorityBtn = document.getElementById('orderStructureMajorityBtn');
  methodCancelBtn = document.getElementById('orderStructureCancelBtn');
  sizeRow = document.getElementById('orderStructureSizeRow');
  sizeSelect = document.getElementById('orderStructureMultiplierSelect');
  previewActions = document.getElementById('orderStructurePreviewActions');
  previewRerollBtn = document.getElementById('orderStructureRerollBtn');
  previewAcceptBtn = document.getElementById('orderStructureAcceptBtn');
  previewDiscardBtn = document.getElementById('orderStructureDiscardBtn');

  methodRandomBtn.addEventListener('click', () => finishMethod('random'));
  methodMajorityBtn.addEventListener('click', () => finishMethod('majority'));
  methodCancelBtn.addEventListener('click', () => finishMethod(null));
  previewDiscardBtn.addEventListener('click', () => discardPreview?.());
  methodModal.addEventListener('click', (e) => {
    if (e.target !== methodModal) return;
    if (discardPreview) discardPreview(); else finishMethod(null);
  });
  methodModal.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (discardPreview) discardPreview(); else finishMethod(null);
  });
}

function finishMethod(choice) {
  if (!methodModal || methodModal.hidden) return;
  methodModal.hidden = true;
  const target = methodPreviousFocus;
  methodPreviousFocus = null;
  if (target && typeof target.focus === 'function') setTimeout(() => target.focus({ preventScroll: true }), 0);
  const resolve = methodResolve;
  methodResolve = null;
  if (resolve) resolve(choice);
}

/** Resolves to 'random' | 'majority' | null (Cancel, Escape, or backdrop click). */
function promptOrderingMethod(reason) {
  buildMethodModal();
  if (methodResolve) finishMethod(null);
  methodTitleEl.textContent = 'Order this structure?';
  choiceActions.hidden = false;
  sizeRow.hidden = true;
  previewActions.hidden = true;
  return new Promise((resolve) => {
    methodResolve = resolve;
    methodMessageEl.textContent = reason;
    methodPreviousFocus = document.activeElement;
    methodModal.hidden = false;
    setTimeout(() => methodRandomBtn.focus({ preventScroll: true }), 0);
  });
}

/**
 * Random decoration is randomised per call (a different seed gives a
 * different spatial arrangement of the same composition), so unlike Majority
 * it is worth letting the user look at more than one before committing. Swaps
 * the same modal into a "Compute Again / Accept / Discard" state: the
 * candidate is registered as a real, selected file-browser row immediately
 * (so it's visible in the 3D view and any other panel), Compute Again
 * re-decorates that same row in place with a new seed, Accept just closes the
 * dialog and leaves the row as the user's new structure, and Discard removes
 * the row and leaves the original disordered structure selected.
 */
async function previewRandomOrdering(structure, plan) {
  const { buildOrderedStructure, listMultiplierOptions } = await import('../atomistic/order_structure.js');
  const { createNewStructureFromAtoms } = await import('./addToStructureModule/CommitAtoms.js');
  const { updateVisualization } = await import('../core/crystal-viewer.js');
  const { createBondLengthControls } = await import('./BondLengthPanel.js');
  const { recenterCamera } = await import('./WindowAndSceneControls.js');

  const sizeOptions = listMultiplierOptions(structure);
  let seed = 1;
  let multiplier = plan.multiplier ?? 1;
  const build = () => buildOrderedStructure(structure, { method: 'random', seed, multiplier });

  let result = build();
  createNewStructureFromAtoms(
    result.atoms.map((atom, i) => ({
      element: result.elements[i],
      x: atom.position[0], y: atom.position[1], z: atom.position[2],
      color: null,
    })),
    { lattice: result.lattice, fileName: 'ordered_structure' }
  );
  const previewStructure = fileBrowser.selectedStructure;
  const previewRow = fileBrowser.selectedRow;

  buildMethodModal();
  methodTitleEl.textContent = 'Previewing random decoration';
  choiceActions.hidden = true;
  sizeRow.hidden = false;
  previewActions.hidden = false;
  methodMessageEl.textContent = result.report;
  methodPreviousFocus = document.activeElement;
  methodModal.hidden = false;
  setTimeout(() => previewRerollBtn.focus({ preventScroll: true }), 0);

  sizeSelect.innerHTML = sizeOptions.map((o) =>
    `<option value="${o.multiplier}"${o.multiplier === multiplier ? ' selected' : ''}>`
    + `${o.shape.join('x')} (${o.atomCount} atoms)${o.exact ? '' : ' — approximate'}</option>`
  ).join('');

  return new Promise((resolve) => {
    const closeModal = () => {
      methodModal.hidden = true;
      discardPreview = null;
      const target = methodPreviousFocus;
      methodPreviousFocus = null;
      if (target && typeof target.focus === 'function') setTimeout(() => target.focus({ preventScroll: true }), 0);
    };

    const rebuild = () => {
      result = build();
      previewStructure.atoms = result.atoms;
      previewStructure.elements = result.elements;
      previewStructure.uniqueElements = [...new Set(result.elements)];
      previewStructure.lattice = result.lattice;
      previewStructure.periodic = { wrapped: null, hash: null };
      createBondLengthControls();
      updateVisualization({
        reRenderAtoms: true, reRenderBonds: true, reRenderLattice: true, reRenderComposition: 'open',
      });
      methodMessageEl.textContent = result.report;
    };

    previewRerollBtn.onclick = () => {
      seed += 1;
      rebuild();
    };

    sizeSelect.onchange = () => {
      multiplier = Number(sizeSelect.value);
      seed = 1; // a size change is a fresh comparison, not a continuation
      rebuild();
      recenterCamera(); // the cell itself changed shape/size, unlike a reroll
    };

    previewAcceptBtn.onclick = () => {
      closeModal();
      resolve(result);
    };

    discardPreview = () => {
      closeModal();
      // Mirrors the file-browser row's own delete button — removing the
      // preview row this way keeps every bit of bookkeeping it touches
      // (structureShip.container, combine/overlay state, reselecting the
      // previous row) in the one place that already owns it.
      previewRow.querySelector('.delete')?.click();
      recenterCamera(); // the row click handler that normally does this ran on a row that no longer exists
      resolve(null);
    };
  });
}

/**
 * Offer the ordering methods, then build the chosen one as a NEW file-browser
 * entry — never in place, so the disordered original stays available to compare
 * against and nothing is lost if the approximation is unsuitable.
 */
export async function openOrderStructureDialog() {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  if (!structureHasFractionalOccupancy(structure)) {
    alert('This structure has no fractionally occupied sites — there is nothing to order.');
    return;
  }

  const { planOrdering, buildOrderedStructure } = await import('../atomistic/order_structure.js');
  const { createNewStructureFromAtoms } = await import('./addToStructureModule/CommitAtoms.js');

  const plan = planOrdering(structure);
  const method = await promptOrderingMethod(plan.reason);
  if (!method) return;

  if (method === 'random') {
    await previewRandomOrdering(structure, plan);
    return;
  }

  const result = buildOrderedStructure(structure, { method, seed: 1 });

  createNewStructureFromAtoms(
    result.atoms.map((atom, i) => ({
      element: result.elements[i],
      x: atom.position[0], y: atom.position[1], z: atom.position[2],
      color: null,
    })),
    { lattice: result.lattice, fileName: 'majority_structure' }
  );

  alert(result.report);
}
