// AddStructureModule.js
//
// The two structure editors, both built from the same body
// (StructureEditorPanel.js) and separated only by what they commit to:
//
//   initAddStructureButton()    - the Files panel's ".add-structure-button":
//                                 build a BRAND-NEW structure from scratch and
//                                 register it as its own file-browser row.
//   initModifyStructureButton() - the Structure Info panel's "#addButton":
//                                 edit the structure that is already loaded -
//                                 its lattice, its atoms, and any atoms added
//                                 or removed - then write it back in place.
//
// They are deliberately two panels rather than one with a mode switch: "this
// changes what you are looking at" and "this makes a new thing" are different
// enough intents that mixing them behind a toggle is how you overwrite a
// structure you meant to keep.
//
// The add side carries a second top-level tab, "Symmetry (Wyckoff)" (space
// group + Wyckoff sites, see SymmetryWyckoffTab.js), which owns its own
// Lattice section rather than sharing the Atoms tab's: symmetry-based
// generation constrains and derives the lattice, free-form manual entry does
// not, so the two modes cannot share one.
//
// On the modify side a structure that already carries a Wyckoff lock gets the
// orbit editor instead of the atom table - see WyckoffOrbitEditor.js for why
// free-form atom editing is not offered there.

import { registerPanel, removePanel } from '../panels/PanelManager.js';
import { createTabSwitcher } from '../TabSwitcher.js';
import { createSymmetryWyckoffTab } from './SymmetryWyckoffTab.js';
import { buildStructureEditor } from './StructureEditorPanel.js';
import { buildWyckoffOrbitEditor } from './WyckoffOrbitEditor.js';
import { createNewStructureFromAtoms } from './CommitAtoms.js';
import { defaultFloatingAnchor } from './floatingPanelAnchor.js';
import { fileBrowser } from '../../state/store.js';

const ADD_PANEL_ID = 'addStructure';
const MODIFY_PANEL_ID = 'modifyStructure';

export function initAddStructureButton(buttonSelector = '.add-structure-button') {
  const button = document.querySelector(buttonSelector);
  if (!button) {
    console.warn(`No element matching '${buttonSelector}' found.`);
    return;
  }

  button.addEventListener('click', () => {
    removePanel(ADD_PANEL_ID); // idempotent re-open

    /** @type {{dispose: () => void} | null} */
    let editor = null;

    registerPanel({
      id: ADD_PANEL_ID,
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
            render: (tabBody) => {
              editor = buildStructureEditor(tabBody, {
                commitLabel: 'Create Structure',
                anywayLabel: 'Create Anyway',
                onCommit: ({ atoms, lattice }) => {
                  createNewStructureFromAtoms(atoms, { lattice });
                  removePanel(ADD_PANEL_ID);
                },
              });
            },
          },
          {
            id: 'symmetry',
            label: 'Symmetry (Wyckoff)',
            render: (tabBody) => createSymmetryWyckoffTab(tabBody, () => removePanel(ADD_PANEL_ID)),
          },
        ]);
      },
      onDestroyContent() {
        editor?.dispose();
        editor = null;
      },
      defaults: { docked: false, collapsed: false, barCollapsed: false, anchor: defaultFloatingAnchor() },
    });
  });
}

export function initModifyStructureButton(buttonId = 'addButton') {
  const button = document.getElementById(buttonId);
  if (!button) {
    console.warn(`No element with id '${buttonId}' found.`);
    return;
  }

  button.addEventListener('click', () => {
    removePanel(MODIFY_PANEL_ID); // idempotent re-open

    const structure = fileBrowser.selectedStructure;
    if (!structure) {
      console.warn('Modify structure: no structure selected.');
      return;
    }
    const wyckoffLocked = structure.symmetry?.mode === 'wyckoff';

    /** @type {{dispose: () => void} | null} */
    let editor = null;

    registerPanel({
      id: MODIFY_PANEL_ID,
      title: wyckoffLocked ? 'Modify Wyckoff Orbits' : 'Modify Structure',
      lifecycle: 'persistent',
      closable: true,
      persist: false,
      buildContent(body) {
        body.style.cssText = 'width: min(90vw, 560px);';

        if (wyckoffLocked) {
          editor = buildWyckoffOrbitEditor(body);
          return;
        }

        // The Modify editor is LIVE: it edits `structure` in place as changes
        // are made (no commit), and its button reverts instead. See
        // StructureEditorPanel.js's buildModifyEditor.
        editor = buildStructureEditor(body, { source: structure });
      },
      onDestroyContent() {
        editor?.dispose();
        editor = null;
      },
      defaults: { docked: false, collapsed: false, barCollapsed: false, anchor: defaultFloatingAnchor() },
    });
  });
}
