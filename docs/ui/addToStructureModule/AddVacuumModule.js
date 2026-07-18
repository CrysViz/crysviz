// AddVacuumModule.js
//
// The "+" popup on the Structure Info panel: add atoms to the currently
// loaded structure, and grow the cell with vacuum. A real floating panel
// (docs/ui/panels/PanelManager.js), not a hand-rolled popup, so it gets the
// app's usual title bar/drag/close for free. Atom-table UI, collision
// checking, and structure-registration are all pulled from shared modules
// (AtomTableInput.js, AtomCollisionCheck.js, CommitAtoms.js,
// CollisionWarningUI.js) so the same pieces can be reused by
// AddStructureModule.js and, later, a symmetry/Wyckoff generator.

import { registerPanel, removePanel } from '../panels/PanelManager.js';
import { createTabSwitcher } from '../TabSwitcher.js';
import { createAtomTableEditor } from './AtomTableInput.js';
import { checkAtomCollisions, conflictingCandidateIndices } from './AtomCollisionCheck.js';
import { addAtomsToExistingStructure } from './CommitAtoms.js';
import { wireCollisionGuardedButton } from './CollisionWarningUI.js';
import { createBondLengthControls } from '../BondLengthPanel.js';
import { fileBrowser } from '../../state/store.js';
import { fracToCart, cartToFrac } from '../../render/index.js';
import { fracToCartPoint } from '../../math/index.js';
import { updateVisualization } from '../../core/crystal-viewer.js';
import { defaultFloatingAnchor } from './floatingPanelAnchor.js';
import { elementData } from '../PeriodicTablePickerCore.js';

// Rows with an element string that isn't a real periodic-table symbol, keyed
// by the atom-table row index (matches editor.getAtoms()/highlightConflicts).
function invalidElementMessage(atoms) {
  const bad = [...new Set(atoms.filter(a => !elementData[a.element]).map(a => a.element || '(empty)'))];
  if (!bad.length) return null;
  return `Not a recognized element: ${bad.join(', ')}. Use the periodic table picker (⚛) to pick one.`;
}

const PANEL_ID = 'addAtomsVacuum';
const COLLISION_THRESHOLD_ANGSTROM = 0.5;

// Grow the current structure's cell by the requested vacuum (Å) along each
// lattice vector, keeping the atoms' Cartesian positions fixed - a standard
// slab-with-vacuum construction (vacuum is added on one side only; atoms do
// not recenter, so their fractional coordinates compress toward the origin
// side of whichever vector(s) grew).
//
// _vacuumApplied is an in-memory (not saved/exported) bookkeeping field on
// the structure - the running total added per axis, plus the lattice as it
// was before any vacuum was ever applied to this structure - so the panel
// can show a running counter and Reset can undo the whole thing in one step
// (restoring baseLattice; atoms' Cartesian positions never changed, so their
// fractional coordinates just get recomputed against it).
function applyVacuumToStructure(vacX, vacY, vacZ) {
  const s = fileBrowser.selectedStructure;
  if (!s) {
    console.warn('Add vacuum: no structure selected.');
    return;
  }
  if (!vacX && !vacY && !vacZ) return;

  if (!s._vacuumApplied) {
    s._vacuumApplied = { x: 0, y: 0, z: 0, baseLattice: s.lattice.map(row => row.slice()) };
  }
  s._vacuumApplied.x += vacX;
  s._vacuumApplied.y += vacY;
  s._vacuumApplied.z += vacZ;

  const lattice = s.lattice;
  const vac = [vacX, vacY, vacZ];

  // Cartesian positions to preserve.
  const carts = fracToCart(s.atoms.map(a => a.position), lattice);

  // Scale each lattice vector's length by its added vacuum.
  const newLattice = lattice.map((row, i) => {
    const len = Math.hypot(row[0], row[1], row[2]);
    const k = (len > 0 && vac[i]) ? (len + vac[i]) / len : 1;
    return [row[0] * k, row[1] * k, row[2] * k];
  });

  s.atoms.forEach((atom, idx) => {
    atom.position = cartToFrac(carts[idx], newLattice);
  });

  s.lattice = newLattice;
  s.periodic = { wrapped: null, hash: null }; // force periodic-wrap recompute

  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
}

// Undoes every vacuum addition made so far on this structure in one step.
function resetVacuumForStructure(s) {
  if (!s || !s._vacuumApplied) return;
  const carts = fracToCart(s.atoms.map(a => a.position), s.lattice);
  s.lattice = s._vacuumApplied.baseLattice.map(row => row.slice());
  s.atoms.forEach((atom, idx) => {
    atom.position = cartToFrac(carts[idx], s.lattice);
  });
  s.periodic = { wrapped: null, hash: null };
  delete s._vacuumApplied;

  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
}

function addVacuumPanel(container) {
  container.innerHTML = `
    <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
      <div style="display: flex; align-items: center;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">X (Å):</label>
        <input type="number" id="vacX" class="coord-input" value="0" step="0.1" style="width: 56px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <div style="display: flex; align-items: center;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">Y (Å):</label>
        <input type="number" id="vacY" class="coord-input" value="0" step="0.1" style="width: 56px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <div style="display: flex; align-items: center;">
        <label style="margin-right: 5px; white-space: nowrap; display: flex; align-items: center;">Z (Å):</label>
        <input type="number" id="vacZ" class="coord-input" value="0" step="0.1" style="width: 56px; background: #333; border: 1px solid #555; color: white; padding: 3px; height: 24px; box-sizing: border-box;">
      </div>

      <button id="applyVacuum" class="btn-mini highlight" style="padding: 5px 10px; background: var(--bg-color); color: white; cursor: pointer;">Apply Vacuum</button>
    </div>
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11px; color: rgba(255,255,255,0.7); border-top: 1px solid rgba(255,255,255,0.1); padding-top: 8px;">
      <span id="vacuumAppliedText"></span>
      <button id="resetVacuum" class="btn-mini" style="padding: 3px 10px; font-size: 11px;">Reset Vacuum</button>
    </div>
  `;

  const statusText = container.querySelector('#vacuumAppliedText');
  const resetBtn = container.querySelector('#resetVacuum');

  function refreshVacuumStatus() {
    const state = fileBrowser.selectedStructure?._vacuumApplied;
    const applied = state && (state.x || state.y || state.z);
    if (applied) {
      statusText.textContent = `Vacuum applied: X=${state.x.toFixed(2)} Å, Y=${state.y.toFixed(2)} Å, Z=${state.z.toFixed(2)} Å`;
    } else {
      statusText.textContent = 'No vacuum applied yet.';
    }
    resetBtn.disabled = !applied;
    resetBtn.style.opacity = applied ? '1' : '0.4';
    resetBtn.style.cursor = applied ? 'pointer' : 'default';
  }
  refreshVacuumStatus();

  container.querySelector('#applyVacuum').addEventListener('click', () => {
    const vacX = parseFloat(container.querySelector('#vacX').value) || 0;
    const vacY = parseFloat(container.querySelector('#vacY').value) || 0;
    const vacZ = parseFloat(container.querySelector('#vacZ').value) || 0;
    applyVacuumToStructure(vacX, vacY, vacZ);
    refreshVacuumStatus();
  });

  resetBtn.addEventListener('click', () => {
    resetVacuumForStructure(fileBrowser.selectedStructure);
    refreshVacuumStatus();
  });
}

function addAtomsPanel(container) {
  const editorHost = document.createElement('div');
  const warningHost = document.createElement('div');
  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'margin-top: 15px; text-align: right;';

  const addToStructureBtn = document.createElement('button');
  addToStructureBtn.id = 'addToStructure';
  addToStructureBtn.className = 'btn-mini highlight';
  addToStructureBtn.textContent = 'Add to Structure';
  buttonRow.appendChild(addToStructureBtn);

  container.appendChild(editorHost);
  container.appendChild(warningHost);
  container.appendChild(buttonRow);

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
      const existingAtoms = existingCart.map((position, i) => ({ position, element: structure.elements[i] }));
      // The table's x/y/z are fractional — convert to Cartesian for the
      // distance-based collision check (checkAtomCollisions expects Cartesian).
      const candidateAtoms = atoms.map(a => ({ position: fracToCartPoint([a.x, a.y, a.z], structure.lattice), element: a.element }));
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

export function addAtomVacuumPanel(buttonId = 'addButton') {
  const button = document.getElementById(buttonId);
  if (!button) {
    console.warn(`No element with id '${buttonId}' found.`);
    return;
  }

  button.addEventListener('click', () => {
    removePanel(PANEL_ID); // idempotent re-open

    registerPanel({
      id: PANEL_ID,
      title: 'Add Atoms / Vacuum',
      lifecycle: 'persistent',
      closable: true,
      persist: false,
      buildContent(body) {
        body.style.cssText = 'width: min(90vw, 460px);';
        const tabHost = document.createElement('div');
        body.appendChild(tabHost);
        createTabSwitcher(tabHost, [
          { id: 'atoms', label: 'Add Atoms', render: addAtomsPanel },
          { id: 'vacuum', label: 'Add Vacuum', render: addVacuumPanel },
        ]);
      },
      defaults: { docked: false, collapsed: false, barCollapsed: false, anchor: defaultFloatingAnchor() },
    });
  });
}
