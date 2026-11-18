// The two annotation switches shown side by side wherever atoms can be
// annotated — the Structure window's title row (StructureInfoPanel/General.js)
// and the Selection and Polyhedron Inspectors' title rows:
//
//   Aₓ   atom labels (general.showAtomLabels): each atom's name on it, in the
//        main view (render/AtomLabelModule.js) and the inspectors;
//   Aˣ⁺  charges (general.showCharges, the same setting as Features ▸ Show
//        Charges): the oxidation states the file gives, as badges beside the
//        atoms (render/ChargeBadgeModule.js) and in the inspectors.
//
// Each is one setting with a button in every place: every button shows the
// same state (pressed while on), and pressing any of them switches it
// everywhere. The inspectors listen for 'crysviz:atom-labels-changed' and
// 'crysviz:charges-changed'.

import { general, fileBrowser } from '../state/store.js';
import { onActiveStructureChange } from '../state/structures.js';
import {
  rebuildAtomLabels, rebuildChargeBadges, updateChargeBadges, requestRender, MAX_LABELLED_ATOMS,
} from '../render/index.js';

const LABELS_CLASS = 'atom-labels-button';
const CHARGES_CLASS = 'charge-badges-button';

/** Whether any atom of the structure carries an oxidation state. */
function hasCharges(structure) {
  return !!structure?.atoms?.some((atom) => atom?.species?.some((s) => Number.isFinite(s.oxidationState)));
}

function syncPressed(button, on) {
  button.classList.toggle('active', on);
  button.setAttribute('aria-pressed', String(on));
}

/** An atom-label button's look and tooltip, for the setting's current state. */
function syncLabelsButton(button) {
  syncPressed(button, !!general.showAtomLabels);
  const tooMany = (fileBrowser.selectedStructure?.atoms?.length ?? 0) > MAX_LABELLED_ATOMS;
  button.title = 'Atom labels (Aₓ): write each atom\'s name (Fe1, O3) on it, in the 3D view and the inspectors'
    + (tooMany ? `\nNot drawn in the 3D view for more than ${MAX_LABELLED_ATOMS} atoms.` : '');
}

/** A charge button's look and tooltip. With no charge in the structure it
 *  is greyed out — unless it is on, so it can still be turned off. Not the
 *  `disabled` attribute: a disabled button shows no tooltip in some browsers,
 *  and this one has to say why it does nothing. */
function syncChargesButton(button) {
  const on = general.showCharges === true;
  syncPressed(button, on);
  const none = !hasCharges(fileBrowser.selectedStructure);
  const unavailable = none && !on;
  button.classList.toggle('is-unavailable', unavailable);
  button.setAttribute('aria-disabled', String(unavailable));
  button.title = 'Charges (Aˣ⁺): show the oxidation states the file gives beside the atoms, in the 3D view and the inspectors'
    + ' (the same switch as Features ▸ Show Charges)' + (none ? '\nThis structure has no charges.' : '');
}

/** Every Aₓ and Aˣ⁺ button on the page, in step with the settings. */
export function syncAnnotationButtons() {
  document.querySelectorAll(`.${LABELS_CLASS}`).forEach((b) => syncLabelsButton(/** @type {HTMLElement} */ (b)));
  document.querySelectorAll(`.${CHARGES_CLASS}`).forEach((b) => syncChargesButton(/** @type {HTMLButtonElement} */ (b)));
}

/** Show or hide the atom labels, everywhere. */
export function setAtomLabelsShown(on) {
  general.showAtomLabels = !!on;
  syncAnnotationButtons();
  rebuildAtomLabels();
  requestRender();
  document.dispatchEvent(new CustomEvent('crysviz:atom-labels-changed'));
}

/** Show or hide the charges, everywhere — through the Features window's
 *  Show Charges box when it exists, so its own wiring (ui/ControlsWiring.js)
 *  does the work and the box stays in step. */
export function setChargesShown(on) {
  const box = /** @type {HTMLInputElement|null} */ (document.getElementById('showCharges'));
  if (box) {
    box.checked = !!on;
    box.dispatchEvent(new Event('change')); // → chargesChanged() below, via the capture listener
    return;
  }
  general.showCharges = !!on;
  rebuildChargeBadges();
  updateChargeBadges();
  requestRender();
  chargesChanged();
}

function chargesChanged() {
  syncAnnotationButtons();
  document.dispatchEvent(new CustomEvent('crysviz:charges-changed'));
}

// The Features box flipped (by hand, or by setChargesShown): every button and
// inspector follows. Capture phase, so a change event that does not bubble
// is seen too — which runs BEFORE the box's own handler sets
// general.showCharges, hence the microtask.
document.addEventListener('change', (e) => {
  if (/** @type {HTMLElement} */ (e.target)?.id === 'showCharges') queueMicrotask(chargesChanged);
}, true);

// Another structure: the charge buttons grey out or come back with its charges.
onActiveStructureChange(() => syncAnnotationButtons());

function makeButton(id, html, className) {
  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.innerHTML = html;
  button.className = `btn-mini highlight structure-edit-button structure-labels-button ${className}`;
  return button;
}

/**
 * A new Aₓ button (atom labels), in the Structure window's small square-button look.
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
export function createAtomLabelsButton(id) {
  const button = makeButton(id, '<span class="annot-glyph">A<sub>x</sub></span>', LABELS_CLASS);
  syncLabelsButton(button);
  button.addEventListener('click', () => setAtomLabelsShown(!general.showAtomLabels));
  return button;
}

/**
 * A new Aˣ⁺ button (charges), beside the Aₓ one.
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
export function createChargesButton(id) {
  const button = makeButton(id, '<span class="annot-glyph">A<sup>x+</sup></span>', CHARGES_CLASS);
  syncChargesButton(button);
  button.addEventListener('click', () => {
    if (button.classList.contains('is-unavailable')) return; // nothing to show
    setChargesShown(general.showCharges !== true);
  });
  return button;
}
