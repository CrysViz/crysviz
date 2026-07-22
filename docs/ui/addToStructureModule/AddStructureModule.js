// AddStructureModule.js
//
// Wires the Files panel's ".add-structure-button" to a floating panel for
// building a brand-new structure from scratch. "Atoms" (manual entry,
// reusing the same table/bulk editor and periodic table picker as the
// add-atom panel) and "Symmetry (Wyckoff)" (space group + Wyckoff sites, see
// SymmetryWyckoffTab.js) are top-level
// tabs, each owning its own Lattice section (see LatticeInputPanel.js)
// rather than sharing one lattice above a nested mode switch - symmetry-based
// generation will constrain/derive the lattice differently than free-form
// manual entry, so each mode needs to be able to treat it independently.
// Atom entry shares the same collision-check + "Add Anyway"/highlight-
// conflicts UX as the add-atom panel (see AtomCollisionCheck.js,
// CollisionWarningUI.js).

import { registerPanel, removePanel } from '../panels/PanelManager.js';
import { createTabSwitcher } from '../TabSwitcher.js';
import { createAtomTableEditor } from './AtomTableInput.js';
import { createLatticeInputPanel } from './LatticeInputPanel.js';
import { createSymmetryWyckoffTab } from './SymmetryWyckoffTab.js';
import { checkAtomCollisions, conflictingCandidateIndices } from './AtomCollisionCheck.js';
import { createNewStructureFromAtoms } from './CommitAtoms.js';
import { wireCollisionGuardedButton } from './CollisionWarningUI.js';
import { defaultFloatingAnchor } from './floatingPanelAnchor.js';
import { fracToCartPoint } from '../../math/index.js';
import { elementData } from '../PeriodicTablePickerCore.js';

const PANEL_ID = 'addStructure';
const COLLISION_THRESHOLD_ANGSTROM = 0.5;

// Rows with an element string that isn't a real periodic-table symbol.
function invalidElementMessage(atoms) {
  const bad = [...new Set(atoms.filter(a => !elementData[a.element]).map(a => a.element || '(empty)'))];
  if (!bad.length) return null;
  return `Not a recognized element: ${bad.join(', ')}. Use the periodic table picker (⚛) to pick one.`;
}

function buildAtomsMode(body, onCreated) {
  const latticeHost = document.createElement('div');
  body.appendChild(latticeHost);
  const latticePanel = createLatticeInputPanel(latticeHost);

  const editorHost = document.createElement('div');
  const warningHost = document.createElement('div');
  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'margin-top: 15px; text-align: right;';

  const createBtn = document.createElement('button');
  createBtn.className = 'btn-mini highlight';
  createBtn.textContent = 'Create Structure';
  buttonRow.appendChild(createBtn);

  body.appendChild(editorHost);
  body.appendChild(warningHost);
  body.appendChild(buttonRow);

  const editor = createAtomTableEditor(editorHost);

  wireCollisionGuardedButton({
    button: createBtn,
    warningContainer: warningHost,
    watchContainer: editorHost,
    defaultLabel: 'Create Structure',
    anywayLabel: 'Create Anyway',
    validate: () => invalidElementMessage(editor.getAtoms()),
    checkCollisions: () => {
      const atoms = editor.getAtoms();
      if (!atoms.length) return { tooClose: [] };
      const lattice = latticePanel.getLattice();
      // The table's x/y/z are fractional — convert to Cartesian for the
      // distance-based collision check (checkAtomCollisions expects Cartesian).
      const candidateAtoms = atoms.map(a => ({ position: fracToCartPoint([a.x, a.y, a.z], lattice), element: a.element }));
      return checkAtomCollisions({
        lattice,
        existingAtoms: [],
        candidateAtoms,
        thresholdAngstrom: COLLISION_THRESHOLD_ANGSTROM,
      });
    },
    onWarn: (tooClose) => editor.highlightConflicts(conflictingCandidateIndices(tooClose)),
    onClear: () => editor.clearConflicts(),
    commit: () => {
      const atoms = editor.getAtoms();
      if (!atoms.length) return;
      createNewStructureFromAtoms(atoms, { lattice: latticePanel.getLattice() });
      onCreated();
    },
  });
}

export function initAddStructureButton(buttonSelector = '.add-structure-button') {
  const button = document.querySelector(buttonSelector);
  if (!button) {
    console.warn(`No element matching '${buttonSelector}' found.`);
    return;
  }

  button.addEventListener('click', () => {
    removePanel(PANEL_ID); // idempotent re-open

    registerPanel({
      id: PANEL_ID,
      title: 'Add Structure',
      lifecycle: 'persistent',
      closable: true,
      persist: false,
      buildContent(body) {
        body.style.cssText = 'width: min(90vw, 560px);';

        createTabSwitcher(body, [
          {
            id: 'atoms',
            label: 'Atoms',
            render: (tabBody) => buildAtomsMode(tabBody, () => removePanel(PANEL_ID)),
          },
          {
            id: 'symmetry',
            label: 'Symmetry (Wyckoff)',
            render: (tabBody) => createSymmetryWyckoffTab(tabBody, () => removePanel(PANEL_ID)),
          },
        ]);
      },
      defaults: { docked: false, collapsed: false, barCollapsed: false, anchor: defaultFloatingAnchor() },
    });
  });
}
