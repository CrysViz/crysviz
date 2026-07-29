// StructureEditorPanel.js
//
// The one editor body behind both structure panels. They share the lattice
// inputs, the atom table, and the New/Removed readout, but differ in when
// edits take effect:
//
//   Add Structure (source=null)   - a STAGED editor. Nothing exists until the
//     commit button builds a brand-new file-browser entry from the table.
//
//   Modify Structure (source set) - a LIVE editor on the loaded structure.
//     Every edit (coordinate, colour, element, add, delete, lattice) is
//     applied to the structure as it is made and stays applied when the panel
//     is closed. There is no commit; the button instead REVERTS every change
//     back to the as-loaded structure (Structure.original), and the lattice
//     section has its own "Reset Lattice". The New/Removed lists are derived
//     from a persistent diff kept on the structure (structure._modify), so
//     they survive closing and reopening the panel.

import { createAtomTableEditor } from './AtomTableInput.js';
import { createLatticeInputPanel } from './LatticeInputPanel.js';
import { checkAtomCollisions, conflictingCandidateIndices } from './AtomCollisionCheck.js';
import { wireCollisionGuardedButton } from './CollisionWarningUI.js';
import {
  colorToHex,
  applyStructureEdits,
  revertStructureToOriginal,
  resetLatticeToOriginal,
} from './CommitAtoms.js';
import { fracToCartPoint } from '../../math/index.js';
import { elementData } from '../PeriodicTablePickerCore.js';
import { makeSectionHeadline } from '../panels/sectionHeadline.js';
import { generateID } from '../../utils/index.js';
import { updateVisualization } from '../../core/crystal-viewer.js';
import { createBondLengthControls } from '../BondLengthPanel.js';
import { highlightAtomsIn3D, clearHighlightAtom, subscribeToAtomSelection, clearSelectedAtoms } from '../SelectAndHighlightModule.js';

const COLLISION_THRESHOLD_ANGSTROM = 0.5;

const LIST_STYLE = 'max-height: 120px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px;';
const ENTRY_STYLE = 'display:flex; align-items:center; gap:8px; padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size:12px;';
const COORD_STYLE = 'font-family: monospace; color: rgba(255,255,255,0.7); flex-grow:1; text-align:right;';

// Rows with an element string that isn't a real periodic-table symbol.
function invalidElementMessage(atoms) {
  const bad = [...new Set(atoms.filter(a => !elementData[a.element]).map(a => a.element || '(empty)'))];
  if (!bad.length) return null;
  return `Not a recognized element: ${bad.join(', ')}. Use the periodic table picker (⚛) to pick one.`;
}

const round4 = (value) => Number(Number(value).toFixed(4));

// Every atom of `structure` as an atom-table row. The uuid is the handle the
// commit uses to tell "this is the atom that was already there" from "this is
// new", so an atom that somehow arrived without one (a structure built by a
// path that skips the loaders' generateID) gets one here rather than being
// silently treated as a brand-new atom on every commit.
export function structureToTableAtoms(structure) {
  return structure.atoms.map((atom, i) => {
    atom.uuid ??= generateID([structure.elements[i]]);
    return {
      uuid: atom.uuid,
      element: structure.elements[i],
      x: round4(atom.position[0]),
      y: round4(atom.position[1]),
      z: round4(atom.position[2]),
      color: colorToHex(atom.getColor()),
    };
  });
}

/**
 * Modify path (source set) needs no labels/commit - it edits live and reverts.
 * Add path (source null) uses commitLabel/anywayLabel/onCommit.
 * @param {HTMLElement} body
 * @param {{
 *   source?: any,
 *   commitLabel?: string,
 *   anywayLabel?: string,
 *   onCommit?: (edits: {atoms: Array<any>, deleted: Array<any>, lattice: number[][]}) => void,
 * }} options
 * @returns {{dispose: () => void}}
 */
export function buildStructureEditor(body, options) {
  return options.source ? buildModifyEditor(body, options.source) : buildAddEditor(body, options);
}

function makeListHeading(text) {
  const heading = document.createElement('div');
  heading.textContent = text;
  heading.style.cssText = 'font-size:11px; font-weight:600; color:#ccc; margin: 12px 0 4px 0;';
  return heading;
}

function summaryEntry({ element, x, y, z }, onRestore) {
  const row = document.createElement('div');
  row.style.cssText = ENTRY_STYLE;

  const label = document.createElement('span');
  label.textContent = element;
  label.style.cssText = 'font-weight:600; flex-shrink:0;';
  row.appendChild(label);

  const coords = document.createElement('span');
  coords.textContent = `(${round4(x)}, ${round4(y)}, ${round4(z)})`;
  coords.style.cssText = COORD_STYLE;
  row.appendChild(coords);

  if (onRestore) {
    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = '↺';
    restoreBtn.title = 'Put this atom back';
    restoreBtn.className = 'btn-mini';
    restoreBtn.style.cssText = 'width:20px; height:20px; padding:0; line-height:0; display:flex; align-items:center; justify-content:center; flex-shrink:0;';
    restoreBtn.addEventListener('click', onRestore);
    row.appendChild(restoreBtn);
  }

  return row;
}

// ---------------------------------------------------------------------------
// Add Structure: staged editor (unchanged behaviour, commit builds a new file)
// ---------------------------------------------------------------------------
/**
 * @param {HTMLElement} body
 * @param {{commitLabel?: string, anywayLabel?: string, onCommit?: (edits: {atoms: Array<any>, deleted: Array<any>, lattice: number[][]}) => void}} options
 */
function buildAddEditor(body, { commitLabel = 'Create Structure', anywayLabel = 'Create Anyway', onCommit }) {
  const latticeHost = document.createElement('div');
  body.appendChild(latticeHost);
  const latticePanel = createLatticeInputPanel(latticeHost, {});

  body.appendChild(makeSectionHeadline('Atoms'));

  const editorHost = document.createElement('div');
  const warningHost = document.createElement('div');
  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'margin-top: 15px; text-align: right;';

  const commitBtn = document.createElement('button');
  commitBtn.id = 'commitStructureEdits';
  commitBtn.className = 'btn-mini highlight';
  commitBtn.textContent = commitLabel;
  buttonRow.appendChild(commitBtn);

  body.appendChild(editorHost);
  body.appendChild(warningHost);
  body.appendChild(buttonRow);

  const editor = createAtomTableEditor(editorHost, { initialAtoms: [], deletable: false });

  wireCollisionGuardedButton({
    button: commitBtn,
    warningContainer: warningHost,
    watchContainer: editorHost,
    defaultLabel: commitLabel,
    anywayLabel,
    validate: () => invalidElementMessage(editor.getAtoms()),
    checkCollisions: () => {
      const atoms = editor.getAtoms();
      if (!atoms.length) return { tooClose: [] };
      const lattice = latticePanel.getLattice();
      const candidateAtoms = atoms.map(a => ({ position: fracToCartPoint([a.x, a.y, a.z], lattice), element: a.element }));
      return checkAtomCollisions({ lattice, existingAtoms: [], candidateAtoms, thresholdAngstrom: COLLISION_THRESHOLD_ANGSTROM });
    },
    onWarn: (tooClose) => editor.highlightConflicts(conflictingCandidateIndices(tooClose)),
    onClear: () => editor.clearConflicts(),
    commit: () => {
      const atoms = editor.getAtoms();
      if (!atoms.length) return;
      onCommit?.({ atoms, deleted: editor.getDeleted(), lattice: latticePanel.getLattice() });
    },
  });

  return { dispose() {} };
}

// The persistent diff kept on the structure so New/Removed survive reopening.
// `baseline` is the uuid set of the originals (captured the first time Modify
// runs, after structureToTableAtoms has assigned uuids); an atom whose uuid is
// not in it is "new". `removed` maps a removed original's uuid to its snapshot.
function ensureModifyState(structure) {
  if (!structure._modify) {
    structure._modify = { baseline: new Set(structure.atoms.map((a) => a.uuid)), removed: new Map() };
  }
  return structure._modify;
}

// ---------------------------------------------------------------------------
// Modify Structure: live editor on the loaded structure
// ---------------------------------------------------------------------------
function buildModifyEditor(body, structure) {
  let initialAtoms = structureToTableAtoms(structure); // also assigns uuids
  let mod = ensureModifyState(structure);

  // --- Lattice section (with its own Reset) ---
  const latticeHost = document.createElement('div');
  body.appendChild(latticeHost);
  const latticePanel = createLatticeInputPanel(latticeHost, {
    initial: structure.lattice.map((row) => [...row]),
    onChange: () => scheduleApply(),
  });

  const resetLatticeRow = document.createElement('div');
  resetLatticeRow.style.cssText = 'text-align:right; margin-top:6px;';
  const resetLatticeBtn = document.createElement('button');
  resetLatticeBtn.textContent = 'Reset Lattice';
  resetLatticeBtn.className = 'btn-mini';
  resetLatticeBtn.title = 'Restore the cell to its as-loaded values';
  resetLatticeRow.appendChild(resetLatticeBtn);
  latticeHost.appendChild(resetLatticeRow);

  body.appendChild(makeSectionHeadline('Atoms'));

  const editorHost = document.createElement('div');
  const summaryHost = document.createElement('div');
  const warningHost = document.createElement('div');
  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'margin-top: 15px; text-align: right;';

  const revertBtn = document.createElement('button');
  revertBtn.id = 'commitStructureEdits';
  revertBtn.className = 'btn-mini';
  revertBtn.textContent = 'Revert Changes';
  revertBtn.title = 'Undo every change and restore the structure as it was loaded';
  buttonRow.appendChild(revertBtn);

  body.appendChild(editorHost);
  body.appendChild(summaryHost);
  body.appendChild(warningHost);
  body.appendChild(buttonRow);

  // Highlighting: the atom's index is resolved from its uuid at CLICK time,
  // never captured when the row was built - a live add/remove shifts indices.
  let highlightedUuid = null;
  function onRowActivate(uuid) {
    clearHighlightAtom();
    highlightedUuid = uuid;
    if (!uuid) return;
    const atomIndex = structure.atoms.findIndex((atom) => atom.uuid === uuid);
    if (atomIndex !== -1) highlightAtomsIn3D([atomIndex]);
  }

  const editor = createAtomTableEditor(editorHost, {
    initialAtoms,
    deletable: true,
    onRowActivate,
    onChange: () => scheduleApply(),
    // Only an original (baseline) atom going away is a "removal" worth listing
    // and restoring; deleting an atom you just added just drops it.
    onDelete: (snapshot) => { if (mod.baseline.has(snapshot.uuid)) mod.removed.set(snapshot.uuid, snapshot); },
  });

  // Coalesce a burst of input events (typing, a slider) into one apply/frame.
  let pendingFrame = null;
  function scheduleApply() {
    if (pendingFrame != null) return;
    pendingFrame = requestAnimationFrame(() => { pendingFrame = null; liveApply(); });
  }

  let lastUnique = structure.uniqueElements.join(',');
  function liveApply() {
    const atoms = editor.getAtoms();
    const lattice = latticePanel.getLattice();

    // An add or remove renumbers atom indices, so a kept selection would point
    // at the wrong (or a now-missing) atom. Drop it BEFORE the arrays change,
    // while the selection's indices still match the live mesh - clearing it
    // afterwards would index past the shrunk array inside updateAtoms. A pure
    // coordinate/colour edit leaves the set intact and keeps the selection.
    const tableUuids = new Set(atoms.map((a) => a.uuid));
    const setChanges = tableUuids.size !== structure.atoms.length
      || structure.atoms.some((a) => !tableUuids.has(a.uuid));
    if (setChanges) clearSelectedAtoms();

    applyStructureEdits(structure, { atoms, lattice });

    // A restored / re-added atom is back in the structure - it is no longer a
    // pending removal.
    const present = new Set(structure.atoms.map((a) => a.uuid));
    for (const uuid of [...mod.removed.keys()]) if (present.has(uuid)) mod.removed.delete(uuid);

    // Bond controls only need rebuilding when the element set actually changed.
    const uniqueNow = structure.uniqueElements.join(',');
    if (uniqueNow !== lastUnique) { createBondLengthControls(); lastUnique = uniqueNow; }

    updateVisualization({
      reRenderAtoms: true,
      reRenderBonds: true,
      reRenderLattice: true,
      reRenderOther: true,
      reRenderComposition: 'open',
    });
    renderSummary();
    runCollisionWarning(atoms, lattice);
  }

  // Splice a "Newly added" label row into the table just above the first atom
  // the user added (added atoms always land at the bottom, contiguous), so the
  // originals and the additions read as two groups. Rebuilt on every render
  // since rows come and go; the separator is inert to the table's own logic
  // (no element input - see nonEmptyRows).
  function markNewGap() {
    const tbody = editorHost.querySelector('#atomsTable tbody');
    tbody.querySelector('.atom-new-separator')?.remove();
    const rows = [...tbody.querySelectorAll('tr')];
    const firstNew = rows.find((r) => r.dataset.uuid && !mod.baseline.has(r.dataset.uuid));
    if (!firstNew) return;
    const colCount = editorHost.querySelectorAll('#atomsTable thead th').length;
    const sep = document.createElement('tr');
    sep.className = 'atom-new-separator';
    sep.innerHTML = `<td colspan="${colCount}" style="padding:9px 6px 3px; border-top:2px solid rgba(125,206,160,0.5); color:rgba(125,206,160,0.95); font-size:11px; font-weight:600; letter-spacing:0.03em;">Newly added</td>`;
    firstNew.parentNode.insertBefore(sep, firstNew);
  }

  function renderSummary() {
    summaryHost.innerHTML = '';
    markNewGap();

    // The additions are shown in the table itself (under the "Newly added"
    // separator), so the summary lists only removals - which have nowhere else
    // to appear, and carry the restore button.
    const removed = [...mod.removed.values()];

    if (removed.length) {
      summaryHost.appendChild(makeListHeading(`Removed atoms (${removed.length})`));
      const list = document.createElement('div');
      list.style.cssText = LIST_STYLE;
      removed.forEach((atom) => list.appendChild(summaryEntry(atom, () => {
        mod.removed.delete(atom.uuid);
        editor.addAtom(atom); // keeps the original uuid, so it re-enters as an original
      })));
      summaryHost.appendChild(list);
    }
  }

  function runCollisionWarning(atoms, lattice) {
    warningHost.innerHTML = '';
    editor.clearConflicts();
    if (atoms.length < 2) return;
    const candidateAtoms = atoms.map((a) => ({ position: fracToCartPoint([a.x, a.y, a.z], lattice), element: a.element }));
    const { tooClose } = checkAtomCollisions({ lattice, existingAtoms: [], candidateAtoms, thresholdAngstrom: COLLISION_THRESHOLD_ANGSTROM });
    if (!tooClose.length) return;
    editor.highlightConflicts(conflictingCandidateIndices(tooClose));
    const items = tooClose
      .map((t) => `<li>${t.a.element} (atom ${t.a.index + 1}) is ${t.distance.toFixed(3)} Å from ${t.b.element} (atom ${t.b.index + 1})</li>`)
      .join('');
    // Non-blocking: the edit is already applied; this only flags the overlap.
    warningHost.innerHTML = `<div class="collision-warning-banner"><strong>Warning:</strong> some atoms are closer than 0.5 Å.<ul>${items}</ul></div>`;
  }

  resetLatticeBtn.addEventListener('click', () => {
    resetLatticeToOriginal(structure);
    latticePanel.setLattice(structure.lattice);
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderLattice: true, reRenderOther: true, reRenderComposition: 'open' });
  });

  revertBtn.addEventListener('click', () => {
    // Reverting throws away every live edit, so make the user confirm.
    if (!window.confirm('Revert all changes? This restores the structure exactly as it was loaded and discards every edit (moved, added and removed atoms, and the lattice).')) return;
    // Clear the selection first, while it still matches the live mesh - the
    // revert rebuilds structure.atoms and updateVisualization only re-sizes the
    // mesh afterwards, so clearing in between would index the old, larger mesh.
    clearSelectedAtoms();
    revertStructureToOriginal(structure);
    delete structure._modify;
    initialAtoms = structureToTableAtoms(structure); // fresh uuids
    mod = ensureModifyState(structure);              // recapture baseline
    editor.reload(initialAtoms);
    latticePanel.setLattice(structure.lattice);
    createBondLengthControls();
    lastUnique = structure.uniqueElements.join(',');
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderLattice: true, reRenderOther: true, reRenderComposition: 'open' });
    renderSummary();
    warningHost.innerHTML = '';
    editor.clearConflicts();
  });

  // Inbound half of the two-way sync: a position slider or colour picker in the
  // Structure Info panel writes straight into structure.atoms, so mirror those
  // values into the matching (untouched) table rows.
  function syncFromStructure() {
    structure.atoms.forEach((atom) => {
      if (!atom.uuid) return;
      editor.syncRow(atom.uuid, {
        x: round4(atom.position[0]),
        y: round4(atom.position[1]),
        z: round4(atom.position[2]),
        color: colorToHex(atom.getColor()),
      });
    });
  }
  document.addEventListener('crysviz:atoms-changed', syncFromStructure);
  document.addEventListener('crysviz:colors-changed', syncFromStructure);

  // Reverse highlight: picking an atom in the 3D scene lights up its table row.
  const unsubscribeSelection = subscribeToAtomSelection(({ selectedAtoms }) => {
    const last = selectedAtoms[selectedAtoms.length - 1];
    const uuid = last ? structure.atoms?.[last.sourceIndex]?.uuid ?? null : null;
    editor.setActiveUuid(uuid);
  });

  renderSummary();

  return {
    dispose() {
      if (pendingFrame != null) cancelAnimationFrame(pendingFrame);
      document.removeEventListener('crysviz:atoms-changed', syncFromStructure);
      document.removeEventListener('crysviz:colors-changed', syncFromStructure);
      unsubscribeSelection?.();
      if (highlightedUuid) clearHighlightAtom();
    },
  };
}
