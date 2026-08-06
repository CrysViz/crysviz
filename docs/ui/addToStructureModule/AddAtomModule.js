// AddAtomModule.js
//
// The "+" popup on the Structure Info panel: add atoms to the currently
// loaded structure. A real floating panel (docs/ui/panels/PanelManager.js),
// not a hand-rolled popup, so it gets the app's usual title bar/drag/close
// for free. Atom-table UI, collision checking, and structure-registration are
// all pulled from shared modules (AtomTableInput.js, AtomCollisionCheck.js,
// CommitAtoms.js, CollisionWarningUI.js) so the same pieces can be reused by
// AddStructureModule.js and, later, a symmetry/Wyckoff generator.
//
// "Add Vacuum" used to live here as a second tab, but growing the cell fits
// the Cell & Supercell panel's job much better than the add-atoms popup — see
// addVacuumSection() in ui/LatticeSupercellPanel.js.

import { registerPanel, removePanel } from '../panels/PanelManager.js';
import { createAtomTableEditor } from './AtomTableInput.js';
import { checkAtomCollisions, conflictingCandidateIndices } from './AtomCollisionCheck.js';
import { addAtomsToExistingStructure, removeSessionAddedAtom } from './CommitAtoms.js';
import { wireCollisionGuardedButton } from './CollisionWarningUI.js';
import { createBondLengthControls } from '../BondLengthPanel.js';
import { fileBrowser } from '../../state/store.js';
import { fracToCart } from '../../render/index.js';
import { fracToCartPoint } from '../../math/index.js';
import { updateVisualization } from '../../core/crystal-viewer.js';
import { defaultFloatingAnchor } from './floatingPanelAnchor.js';
import { highlightAtomsIn3D, clearHighlightAtom } from '../SelectAndHighlightModule.js';
import { invalidElementMessage } from './ElementValidation.js';

const PANEL_ID = 'addAtoms';
const COLLISION_THRESHOLD_ANGSTROM = 0.5;

// uuid of the atom currently highlighted from this list (if any), so a second
// click on the same row toggles the highlight off instead of just reapplying it.
let highlightedUuid = null;

// "Added this session" list: every atom pushed via addAtomsToExistingStructure
// this session (structure._sessionAddedAtoms, set by CommitAtoms.js) shown
// with its element, live fractional coordinates, and its own Remove button —
// so a just-added atom can be found and un-added again without hunting for it
// in the full atom list. Clicking a row highlights that atom in the 3D view
// (and the row itself) only, via highlightAtomsIn3D — deliberately NOT
// selectAtomFromRow/the selection machinery, which also expands/highlights the
// matching row in the Structure Info panel's own atom list; this list isn't that one.
function renderSessionAddedList(container) {
  container.innerHTML = '';
  const structure = fileBrowser.selectedStructure;
  const added = structure?._sessionAddedAtoms ?? [];
  if (!added.length) return;

  const heading = document.createElement('div');
  heading.textContent = 'Added this session';
  heading.className = 'addstructure-list-heading';
  container.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'addstructure-scroll-list addstructure-scroll-list--tall';

  const rowElements = []; // every row built this render, so a click can clear the others'

  added.forEach((entry) => {
    // Coordinates are read live off the atom (not snapshotted at add time) so
    // they stay correct if the atom is later moved via the Structure Info panel.
    const atomIndex = structure.atoms.findIndex((a) => a.uuid === entry.uuid);
    if (atomIndex === -1) return; // stale entry (shouldn't normally happen)
    const [x, y, z] = structure.atoms[atomIndex].position;

    const row = document.createElement('div');
    row.className = 'addstructure-session-row' + (entry.uuid === highlightedUuid ? ' is-active' : '');
    row.title = 'Click to highlight this atom in the 3D view';
    rowElements.push(row);
    row.addEventListener('click', () => {
      rowElements.forEach((r) => { r.classList.remove('is-active'); });
      if (highlightedUuid === entry.uuid) {
        clearHighlightAtom();
        highlightedUuid = null;
      } else {
        highlightAtomsIn3D([atomIndex]);
        highlightedUuid = entry.uuid;
        row.classList.add('is-active');
      }
    });

    const label = document.createElement('span');
    label.textContent = entry.element;
    label.className = 'addstructure-list-label';
    row.appendChild(label);

    const coords = document.createElement('span');
    coords.textContent = `(${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)})`;
    coords.className = 'addstructure-list-coord';
    row.appendChild(coords);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove this atom';
    removeBtn.className = 'btn-mini addstructure-icon-btn addstructure-icon-btn--shrink0';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also trigger the row's highlight click
      // Clear any 3D highlight BEFORE mutating structure.atoms: clearHighlightAtom()
      // re-reads colors off the CURRENT (still atom-count-matched) mesh/structure
      // pair, so it must run first. Doing it after removeSessionAddedAtom() reads
      // structure.atoms against a mesh still built for the old (pre-removal) atom
      // count/indices and throws - which then aborts the rest of this handler,
      // silently skipping the actual removal's re-render (the atom looked "stuck").
      // Any highlight is moot after this anyway - the reRenderAtoms rebuild below
      // creates a brand new mesh with no highlight state.
      clearHighlightAtom();
      highlightedUuid = null;
      if (!removeSessionAddedAtom(structure, entry.uuid)) return;
      createBondLengthControls();
      updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderComposition: "open" });
      renderSessionAddedList(container);
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  });

  container.appendChild(list);
}

function addAtomsPanel(container) {
  const editorHost = document.createElement('div');
  const warningHost = document.createElement('div');
  const buttonRow = document.createElement('div');
  buttonRow.className = 'addstructure-button-row';

  const addToStructureBtn = document.createElement('button');
  addToStructureBtn.id = 'addToStructure';
  addToStructureBtn.className = 'btn-mini highlight';
  addToStructureBtn.textContent = 'Add to Structure';
  buttonRow.appendChild(addToStructureBtn);

  const sessionListHost = document.createElement('div');

  container.appendChild(editorHost);
  container.appendChild(warningHost);
  container.appendChild(buttonRow);
  container.appendChild(sessionListHost);
  renderSessionAddedList(sessionListHost);

  const editor = createAtomTableEditor(editorHost);

  // Collision check compares new atoms against the existing ones and against
  // each other, but never re-checks existing pairs. On a warning, the
  // offending rows are highlighted so the user can fix them directly instead
  // of just forcing the add through.
  wireCollisionGuardedButton({
    button: addToStructureBtn,
    warningContainer: warningHost,
    watchContainer: editorHost,
    defaultLabel: 'Add to Structure',
    anywayLabel: 'Add Anyway',
    validate: () => invalidElementMessage(editor.getAtoms()),
    checkCollisions: () => {
      const structure = fileBrowser.selectedStructure;
      const atoms = editor.getAtoms();
      if (!structure || !atoms.length) return { tooClose: [] };
      const existingCart = fracToCart(structure.atoms.map(a => a.position), structure.lattice);
      const existingAtoms = existingCart.map((position, i) => ({
        position, element: structure.elements[i],
        occupancy: structure.atoms[i]?.getTotalOccupancy?.() ?? 1,
      }));
      // The table's x/y/z are fractional — convert to Cartesian for the
      // distance-based collision check (checkAtomCollisions expects Cartesian).
      const candidateAtoms = atoms.map(a => ({
        position: fracToCartPoint([a.x, a.y, a.z], structure.lattice),
        element: a.element, occupancy: a.occupancy ?? 1,
      }));
      return checkAtomCollisions({
        lattice: structure.lattice,
        existingAtoms,
        candidateAtoms,
        thresholdAngstrom: COLLISION_THRESHOLD_ANGSTROM,
      });
    },
    onWarn: (tooClose) => editor.highlightConflicts(conflictingCandidateIndices(tooClose)),
    onClear: () => editor.clearConflicts(),
    commit: () => {
      const structure = fileBrowser.selectedStructure;
      if (!structure) {
        console.warn('Add to structure: no structure selected.');
        return;
      }
      const atoms = editor.getAtoms();
      if (!atoms.length) return;
      addAtomsToExistingStructure(structure, atoms);
      createBondLengthControls();
      // reRenderComposition: "open" — the Structure Info panel otherwise
      // doesn't rebuild its composition/atom list at all (its default is
      // false), so newly-added atoms/elements wouldn't show up there until
      // some unrelated action happened to trigger a rebuild.
      updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderComposition: "open" });
      editor.clear();
      removePanel(PANEL_ID);
    },
  });
}

export function addAtomPanel(buttonId = 'addButton') {
  const button = document.getElementById(buttonId);
  if (!button) {
    console.warn(`No element with id '${buttonId}' found.`);
    return;
  }

  button.addEventListener('click', () => {
    removePanel(PANEL_ID); // idempotent re-open

    registerPanel({
      id: PANEL_ID,
      title: 'Add Atoms',
      lifecycle: 'persistent',
      closable: true,
      persist: false,
      buildContent(body) {
        body.classList.add('addstructure-panel-body--sm');
        addAtomsPanel(body);
      },
      defaults: { docked: false, collapsed: false, barCollapsed: false, anchor: defaultFloatingAnchor() },
    });
  });
}
