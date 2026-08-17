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
// On the modify side a structure carrying a Wyckoff lock gets the same panel
// with orbit rows in place of atom rows - one editor, both modes. See
// StructureEditorPanel.js's buildWyckoffModifyEditor.

import { removePanel } from '../panels/PanelManager.js';
import { createTabSwitcher } from '../TabSwitcher.js';
import { createSymmetryWyckoffTab } from './SymmetryWyckoffTab.js';
import { buildStructureEditor } from './StructureEditorPanel.js';
import { createNewStructureFromAtoms } from './CommitAtoms.js';
import { openEditorPanel } from './floatingPanelAnchor.js';
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

    openEditorPanel({
      id: ADD_PANEL_ID,
      title: 'Add Structure',
      lifecycle: 'persistent',
      closable: true,
      persist: false,
      buildContent(body) {
        body.classList.add('addstructure-panel-body--lg');

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
    });
  });
}

// #addButton is destroyed and rebuilt by every renderComposition(), and not
// every caller of that goes through updateVisualization() — MoyoWASM.js's
// Wyckoff toggle calls it directly — so a listener bound to the live node was
// silently lost the moment symmetry was locked or unlocked, leaving the ✎
// button dead until some unrelated re-render happened to rewire it. Delegating
// from document survives every rebuild, and makes repeat calls harmless.
let modifyDelegationBoundFor = null;

export function initModifyStructureButton(buttonId = 'addButton') {
  if (modifyDelegationBoundFor === buttonId) return;
  modifyDelegationBoundFor = buttonId;

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(`#${buttonId}`)) return;

    removePanel(MODIFY_PANEL_ID); // idempotent re-open

    const structure = fileBrowser.selectedStructure;
    if (!structure) {
      console.warn('Modify structure: no structure selected.');
      return;
    }
    /** @type {{dispose: () => void} | null} */
    let editor = null;
    /** @type {((event: KeyboardEvent) => void) | null} */
    let onKeyDown = null;

    openEditorPanel({
      id: MODIFY_PANEL_ID,
      // One title for both modes: the panel offers the same edits either way,
      // and a Revert can drop the lock mid-session, which would leave a
      // mode-specific title lying.
      title: 'Modify Structure',
      lifecycle: 'persistent',
      closable: true,
      persist: false,
      buildContent(body) {
        body.classList.add('addstructure-panel-body--lg');

        // The Modify editor is LIVE: it edits `structure` in place as changes
        // are made (no commit), and its button reverts instead. It picks the
        // orbit-row or atom-row body from the structure's lock - see
        // StructureEditorPanel.js's buildModifyEditor.
        editor = buildStructureEditor(body, { source: structure });

        // Escape closes the panel. A picker popup opened from inside it (the
        // element periodic table, a colour swatch) owns the first Escape, so
        // skip while one is up - it dismisses itself, and the next Escape
        // reaches the panel.
        onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          if (document.getElementById('periodicTablePopup')
            || document.querySelector('.swatch-color-picker')) return;
          removePanel(MODIFY_PANEL_ID);
        };
        document.addEventListener('keydown', onKeyDown);
      },
      onDestroyContent() {
        if (onKeyDown) {
          document.removeEventListener('keydown', onKeyDown);
          onKeyDown = null;
        }
        editor?.dispose();
        editor = null;
      },
    });
  });
}
