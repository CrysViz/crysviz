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
//
// The Modify editor has two bodies, picked by whether the structure carries a
// Wyckoff lock, and they offer the SAME set of edits - cell, element, colour,
// coordinates, add and remove - so that locking symmetry does not cost the user
// half the panel. What differs is the unit of editing: locked, the unit is a
// whole orbit (one representative row per orbit, its frozen axes disabled, add
// and delete acting on every image at once) and the cell is projected onto what
// the lock permits. Reverting stays in whichever mode it started in - locked, it
// re-locks the restored structure rather than dropping the user into the atom
// table - but the body is re-mounted either way, since a revert rebuilds
// structure.atoms and with it every index the orbit rows were built from.

import { createAtomTableEditor } from './AtomTableInput.js';
import { createLatticeInputPanel } from './LatticeInputPanel.js';
import { checkAtomCollisions, conflictingCandidateIndices } from './AtomCollisionCheck.js';
import { wireCollisionGuardedButton } from './CollisionWarningUI.js';
import { createLatticeConstraintController } from './WyckoffLatticeConstraints.js';
import {
  getWyckoffOrbitGroups,
  getOrbitAxisFreedom,
  applyWyckoffOrbitPosition,
  removeWyckoffOrbit,
  addWyckoffOrbit,
  previewWyckoffOrbit,
  setWyckoffOrbitElement,
  setWyckoffOrbitColor,
  setWyckoffOrbitSite,
  applyWyckoffLattice,
  wyckoffLatticeConstraints,
  activateWyckoffMode,
} from '../SymmetryEditModule.js';
import { loadSymmetryData, getWyckoffLetters, getSiteFreedom, constrainRepresentative } from './WyckoffProjector.js';
import { openPeriodicTable } from '../PeriodicTableSelectPanel.js';
import { createColorSwatch } from '../SwatchColorPicker.js';
import {
  colorToHex,
  applyStructureEdits,
  revertStructureToOriginal,
  resetLatticeToOriginal,
} from './CommitAtoms.js';
import { fracToCartPoint } from '../../math/index.js';
import { elementData } from '../PeriodicTablePickerCore.js';
import { getElementDefaultColor } from '../../defaults/color_texture_defaults.js';
import { makeSectionHeadline } from '../panels/sectionHeadline.js';
import { generateID } from '../../utils/index.js';
import { updateVisualization } from '../../core/crystal-viewer.js';
import { createBondLengthControls } from '../BondLengthPanel.js';
import { highlightAtomsIn3D, clearHighlightAtom, subscribeToAtomSelection, clearSelectedAtoms } from '../SelectAndHighlightModule.js';
import { invalidElementMessage, invalidElementIndices } from './ElementValidation.js';

const COLLISION_THRESHOLD_ANGSTROM = 0.5;

const round4 = (value) => Number(Number(value).toFixed(4));

/**
 * The colour a table row should show for one species of an atom.
 *
 * An ordered atom (one species) has exactly one row, and that row must keep
 * reading atom.getColor() - the userColor-aware whole-atom colour, which is
 * how an ordered atom has always been recoloured and the only place a
 * user-picked colour for it lives.
 *
 * A disordered atom has one row PER SPECIES, and every one of them was
 * showing the same atom.getColor() regardless of which species the row
 * actually was - since userColor is never set for a disordered atom (its
 * "Color" button shows per-species boxes instead of the single picker that
 * would set it), every row fell through to the same flat representative-
 * element default and looked identical no matter what had actually been
 * picked. Each row now reads its OWN species' colour instead.
 *
 * @param {any} atom
 * @param {Array<{element:string,color?:number|null}>} species
 * @param {number} speciesIndex
 * @returns {string}
 */
function tableRowColor(atom, species, speciesIndex) {
  if (species.length === 1) return colorToHex(atom.getColor());
  const s = species[speciesIndex];
  return colorToHex(s.color ?? getElementDefaultColor(s.element));
}

// Every atom of `structure` as an atom-table row. The uuid is the handle the
// commit uses to tell "this is the atom that was already there" from "this is
// new", so an atom that somehow arrived without one (a structure built by a
// path that skips the loaders' generateID) gets one here rather than being
// silently treated as a brand-new atom on every commit.
export function structureToTableAtoms(structure) {
  const rows = [];
  structure.atoms.forEach((atom, i) => {
    atom.uuid ??= generateID([structure.elements[i]]);
    const species = atom.species?.length
      ? atom.species
      : [{ element: structure.elements[i], occupancy: 1 }];

    // One row per SPECIES, not per site. A site that is half Na and half K
    // cannot be described by a single Element cell — collapsing it to the
    // representative would show "K, occupancy 1" and hide the Na entirely, and
    // any edit would then commit that fiction back over the real composition.
    // This mirrors how the CIF writes it: co-located rows, one per occupant.
    // The suffixed uuids let applyStructureEdits regroup them into one site.
    species.forEach((s, k) => {
      rows.push({
        uuid: k === 0 ? atom.uuid : `${atom.uuid}#${k}`,
        element: s.element,
        x: round4(atom.position[0]),
        y: round4(atom.position[1]),
        z: round4(atom.position[2]),
        occupancy: round4(s.occupancy),
        oxidationState: s.oxidationState,
        color: tableRowColor(atom, species, k),
      });
    });
  });
  return rows;
}

/** The site a table row belongs to — rows of one site share this. */
export function baseUuidOf(uuid) {
  return typeof uuid === 'string' ? uuid.split('#')[0] : uuid;
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

// Picks the locked or free-form body and can swap between them in place. The
// lock can come and go while the panel is open (a revert rebuilds it, the
// Symmetry panel's toggle can drop it), and re-mounting is cheaper to reason
// about than teaching one body to change shape underneath itself.
function buildModifyEditor(body, structure) {
  /** @type {{dispose: () => void} | null} */
  let inner = null;

  function mount() {
    inner?.dispose();
    body.innerHTML = '';
    inner = structure.symmetry?.mode === 'wyckoff'
      ? buildWyckoffModifyEditor(body, structure, mount)
      : buildFreeformModifyEditor(body, structure);
  }

  mount();
  return { dispose() { inner?.dispose(); } };
}

function makeListHeading(text) {
  const heading = document.createElement('div');
  heading.textContent = text;
  heading.className = 'addstructure-list-heading';
  return heading;
}

function summaryEntry({ element, x, y, z }, onRestore) {
  const row = document.createElement('div');
  row.className = 'addstructure-list-entry';

  const label = document.createElement('span');
  label.textContent = element;
  label.className = 'addstructure-list-label';
  row.appendChild(label);

  const coords = document.createElement('span');
  coords.textContent = `(${round4(x)}, ${round4(y)}, ${round4(z)})`;
  coords.className = 'addstructure-list-coord';
  row.appendChild(coords);

  if (onRestore) {
    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = '↺';
    restoreBtn.title = 'Put this atom back';
    restoreBtn.className = 'btn-mini addstructure-icon-btn addstructure-icon-btn--shrink0';
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
  buttonRow.className = 'addstructure-button-row';

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
      const candidateAtoms = atoms.map(a => ({
        position: fracToCartPoint([a.x, a.y, a.z], lattice),
        element: a.element, occupancy: a.occupancy ?? 1,
      }));
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
function buildFreeformModifyEditor(body, structure) {
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
  resetLatticeRow.className = 'addstructure-reset-row';
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
  buttonRow.className = 'addstructure-button-row';

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
    // and restoring; deleting an atom you just added just drops it. The
    // baseline holds base (unsuffixed) atom uuids, but a disordered site's
    // second-and-later species rows carry a suffixed uuid ("<base>#1") - strip
    // it before checking, or every non-first species row of an ORIGINAL mixed
    // site is misclassified as something the user just added.
    onDelete: (snapshot) => { if (mod.baseline.has(baseUuidOf(snapshot.uuid))) mod.removed.set(snapshot.uuid, snapshot); },
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
    // An element/count/occupancy edit here changes the composition — announce it
    // the same way a coordinate edit does (applyAtomCoordinates), so panels that
    // aren't part of the composition rebuild (e.g. Order Structure's size
    // options) can react instead of showing stale numbers.
    document.dispatchEvent(new CustomEvent('crysviz:atoms-changed'));
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
    // Same suffix-stripping as onDelete above, for the same reason: a mixed
    // site's second species row must not read as "newly added".
    const firstNew = rows.find((r) => r.dataset.uuid && !mod.baseline.has(baseUuidOf(r.dataset.uuid)));
    if (!firstNew) return;
    const colCount = editorHost.querySelectorAll('#atomsTable thead th').length;
    const sep = document.createElement('tr');
    sep.className = 'atom-new-separator';
    sep.innerHTML = `<td colspan="${colCount}">Newly added</td>`;
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
      list.className = 'addstructure-scroll-list';
      removed.forEach((atom) => list.appendChild(summaryEntry(atom, () => {
        mod.removed.delete(atom.uuid);
        editor.addAtom(atom); // keeps the original uuid, so it re-enters as an original
      })));
      summaryHost.appendChild(list);
    }
  }

  function runCollisionWarning(atoms, lattice) {
    editor.clearConflicts();

    // Live typing has no commit button to gate, so an invalid element name
    // (anything not a real periodic-table symbol or "Va") is flagged the same
    // non-blocking way a collision is — this table used to have no element
    // validation at all, unlike the "create new structure" flow's commit-time
    // check (invalidElementMessage/wireCollisionGuardedButton above).
    const badIndices = invalidElementIndices(atoms);
    const elementMsg = invalidElementMessage(atoms);

    let tooClose = [];
    if (atoms.length >= 2) {
      // occupancy has to travel with each row here — this re-checks the WHOLE
      // table (not just the newly added rows), so any pre-existing disordered
      // site (several rows sharing a position, each occupancy < 1) would
      // otherwise default to occupancy 1 apiece and get re-flagged as an
      // overfill every time, regardless of what was actually just edited.
      const candidateAtoms = atoms.map((a) => ({
        position: fracToCartPoint([a.x, a.y, a.z], lattice),
        element: a.element, occupancy: a.occupancy ?? 1,
      }));
      ({ tooClose } = checkAtomCollisions({ lattice, existingAtoms: [], candidateAtoms, thresholdAngstrom: COLLISION_THRESHOLD_ANGSTROM }));
    }

    const highlightIndices = new Set([...badIndices, ...conflictingCandidateIndices(tooClose)]);
    if (highlightIndices.size) editor.highlightConflicts([...highlightIndices]);

    // Non-blocking: the edit is already applied; this only flags the problem.
    let html = '';
    if (elementMsg) html += `<div class="collision-warning-banner"><strong>Warning:</strong> ${elementMsg}</div>`;
    if (tooClose.length) {
      const items = tooClose
        .map((t) => `<li>${t.a.element} (atom ${t.a.index + 1}) is ${t.distance.toFixed(3)} Å from ${t.b.element} (atom ${t.b.index + 1})</li>`)
        .join('');
      html += `<div class="collision-warning-banner"><strong>Warning:</strong> some atoms are closer than 0.5 Å.<ul>${items}</ul></div>`;
    }
    warningHost.innerHTML = html;
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
      // A disordered atom has more than one table row (one per species,
      // uuid "<base>#1", "#2", ...) - syncing only atom.uuid left every row
      // after the first permanently stale, never picking up a position or
      // per-species colour edit made elsewhere (the Structure Info panel).
      const species = atom.species?.length ? atom.species : [{ element: '', color: null }];
      species.forEach((s, k) => {
        editor.syncRow(k === 0 ? atom.uuid : `${atom.uuid}#${k}`, {
          x: round4(atom.position[0]),
          y: round4(atom.position[1]),
          z: round4(atom.position[2]),
          color: tableRowColor(atom, species, k),
        });
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

// ---------------------------------------------------------------------------
// Modify Structure, symmetry-locked: the same edits, one orbit at a time
// ---------------------------------------------------------------------------
const AXES = ['x', 'y', 'z'];
// Starting points for a site's free parameters, tried in order.
const SITE_SEEDS = [[0.123, 0.234, 0.345], [0.2, 0.3, 0.4], [0.31, 0.37, 0.43], [0.05, 0.11, 0.17]];

// The Newly-added / Removed diff for the locked body, kept on the structure so
// it survives closing and reopening the panel - same idea as the free-form
// body's `_modify`, but the unit is an orbit. It is tied to the lock object
// itself: re-locking (Get Wyckoff again) builds fresh orbitIds, at which point
// the old baseline would name orbits that no longer exist.
function ensureWyckoffModifyState(structure) {
  const lock = structure.symmetry;
  if (structure._wyckoffModify?.lock !== lock) {
    structure._wyckoffModify = {
      lock,
      baseline: new Set((lock.orbitGroups ?? []).map((orbit) => orbit.orbitId)),
      removed: new Map(),
      nextRemovedKey: 0,
    };
  }
  return structure._wyckoffModify;
}

/**
 * @param {HTMLElement} body
 * @param {any} structure
 * @param {() => void} remount Rebuild the body for the structure's current lock.
 * @returns {{dispose: () => void}}
 */
function buildWyckoffModifyEditor(body, structure, remount) {
  const symmetry = structure.symmetry;
  const mod = ensureWyckoffModifyState(structure);

  const heading = document.createElement('div');
  heading.className = 'wyckoff-lock-heading';
  heading.textContent = `Symmetry locked · ${symmetry.spaceGroup ?? '?'} (No. ${symmetry.number ?? '?'}) · tolerance ${symmetry.tolerance} Å`;
  body.appendChild(heading);

  // No intro text: every row edit acts on the whole orbit, and the disabled
  // inputs already show what the symmetry fixes.

  // --- Lattice, projected onto what the lock allows ---
  const latticeHost = document.createElement('div');
  body.appendChild(latticeHost);
  const latticePanel = createLatticeInputPanel(latticeHost, {
    initial: structure.lattice.map((row) => [...row]),
    onChange: () => scheduleLatticeApply(),
  });

  const latticeConstraints = createLatticeConstraintController(latticeHost);

  const latticeHint = document.createElement('div');
  latticeHint.className = 'wyckoff-hint';
  body.appendChild(latticeHint);

  const PARAM_SYMBOLS = { alpha: 'α', beta: 'β', gamma: 'γ' };

  // Locked parameters are disabled and DRIVEN from the free one they follow, so
  // a cubic cell cannot be given three different lengths - typing a re-writes b
  // and c. Same enforcement the add panel's Wyckoff tab uses; only the source of
  // the rules differs (measured from the lock, not the space-group table).
  function refreshLatticeConstraints() {
    const constraints = wyckoffLatticeConstraints(structure) ?? {};
    latticeConstraints.setConstraints(constraints);

    const described = Object.entries(constraints).map(([key, rule]) => {
      const name = PARAM_SYMBOLS[key] ?? key;
      return rule.mirror ? `${name} = ${PARAM_SYMBOLS[rule.mirror] ?? rule.mirror}` : `${name} = ${rule.fixed}`;
    });
    latticeHint.textContent = described.join(', ');
  }

  const resetLatticeRow = document.createElement('div');
  resetLatticeRow.className = 'addstructure-reset-row';
  const resetLatticeBtn = document.createElement('button');
  resetLatticeBtn.textContent = 'Reset Lattice';
  resetLatticeBtn.className = 'btn-mini';
  resetLatticeBtn.title = 'Restore the cell to its as-loaded values';
  resetLatticeRow.appendChild(resetLatticeBtn);
  latticeHost.appendChild(resetLatticeRow);

  // Coalesce a burst of keystrokes into one projection, and never rewrite the
  // box being typed in - the projection can change the value, and snapping it
  // back mid-word would make the field impossible to edit.
  let latticeFrame = null;
  function scheduleLatticeApply() {
    if (latticeFrame != null) return;
    latticeFrame = requestAnimationFrame(() => {
      latticeFrame = null;
      const landed = applyWyckoffLattice(latticePanel.getLattice(), structure);
      if (landed && !latticeHost.contains(document.activeElement)) latticePanel.setLattice(landed);
    });
  }

  // --- Orbits ---
  body.appendChild(makeSectionHeadline('Wyckoff Sites'));

  const sitesHost = document.createElement('div');
  sitesHost.innerHTML = `
    <div class="wyckoff-sites-scroll">
      <table class="addstructure-table">
        <thead>
          <tr>
            <th class="wyckoff-site-th">Element</th>
            <th class="wyckoff-site-th" title="Wyckoff letter, multiplicity and site symmetry as the lock reports them">Site</th>
            <th class="wyckoff-site-th" title="Fractional coordinate of the orbit's representative">X</th>
            <th class="wyckoff-site-th">Y</th>
            <th class="wyckoff-site-th">Z</th>
            <th class="wyckoff-site-th" title="Colour for every atom of this orbit">Col</th>
            <th class="wyckoff-site-th"></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  body.appendChild(sitesHost);
  const tbody = sitesHost.querySelector('tbody');

  const summaryHost = document.createElement('div');
  body.appendChild(summaryHost);

  const status = document.createElement('div');
  status.className = 'wyckoff-status';
  body.appendChild(status);

  let highlightedOrbitId = null;
  /** @type {Array<{orbitId: number, representativeIndex: number, inputs: HTMLInputElement[]}>} */
  let rows = [];

  function renderSites() {
    tbody.innerHTML = '';
    rows = [];
    const orbits = getWyckoffOrbitGroups(structure);

    orbits.forEach((orbit) => {
      // The lock reports an axis free whenever the site's freedom has any
      // component along it, so "x,x,x" comes back free on all three even though
      // only one is an independent input. Where the site is known, its own
      // hasFreedom is what the user can actually type into — same rule the Add
      // Site row follows.
      const siteLetter = siteLettersUsable && letterIsConsistent(orbit.wyckoff) ? orbit.wyckoff : '';
      const freedom = siteLetter
        ? getSiteFreedom(symmetry.number, siteLetter).hasFreedom
        : getOrbitAxisFreedom(orbit);
      const position = structure.atoms[orbit.representativeIndex].position;
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="addstructure-cell">
          <div class="addstructure-inline-row">
            <input type="text" class="orbit-element wyckoff-text-input" value="${orbit.element}"
              title="Element of every atom in this orbit">
            <button type="button" class="orbit-pick-element addstructure-pick-btn" title="Pick the element from the periodic table">⚛</button>
          </div>
        </td>
        <td class="addstructure-cell">
          <select class="orbit-site wyckoff-orbit-num-input"
            title="Wyckoff site. Changing it re-derives the position and the orbit size"></select>
          <div class="orbit-site-form wyckoff-site-form">${orbit.siteSymmetry}</div>
        </td>
        ${AXES.map((axis, index) => `
          <td class="addstructure-cell">
            <input type="number" step="0.01" class="orbit-${axis} coord-input wyckoff-orbit-num-input wyckoff-axis-input" value="${round4(position[index])}"
              ${freedom[index] ? '' : 'disabled'}
              ${freedom[index] ? `title="Free coordinate of this site; every image follows it"` : `title="${axis} is fixed by the site symmetry"`}>
          </td>`).join('')}
        <td class="orbit-color-cell addstructure-cell addstructure-center"></td>
        <td class="addstructure-cell addstructure-center">
          <button type="button" class="orbit-remove btn-mini addstructure-icon-btn">✕</button>
        </td>
      `;
      tbody.appendChild(row);

      // Dimming a frozen axis is now implied by its `disabled` attribute above
      // (see addStructure.css's .wyckoff-axis-input:disabled) - no JS needed.

      // Until the space-group tables land (or when they don't line up with this
      // cell) the site stays a read-only label showing what the lock reports.
      const siteSelect = /** @type {HTMLSelectElement} */ (row.querySelector('.orbit-site'));
      const currentLabel = `${orbit.multiplicity}${orbit.wyckoff}`;
      if (siteLettersUsable) {
        const known = getWyckoffLetters(symmetry.number).filter(letterIsConsistent);
        siteSelect.innerHTML = known.includes(orbit.wyckoff)
          ? siteOptions()
          : `<option value="">${currentLabel}</option>${siteOptions()}`;
        siteSelect.value = known.includes(orbit.wyckoff) ? orbit.wyckoff : '';
      } else {
        siteSelect.innerHTML = `<option value="">${currentLabel}</option>`;
        siteSelect.disabled = true;
      }

      siteSelect.addEventListener('change', () => {
        status.textContent = '';
        const letter = siteSelect.value;
        if (!letter) return;
        // The position is re-derived from the new site, never carried over:
        // the old one lands on a degenerate value (2a at 0,0,0 onto e's
        // "x,x,x" gives x=0, which is still site a) and the row would claim a
        // site it isn't on. Seeds are tried in turn because a particular free
        // parameter can put the site on top of its own images in a small cell.
        const labels = { wyckoff: letter, siteSymmetry: getSiteFreedom(symmetry.number, letter).siteSymmetry };
        /** @type {{ok: boolean, reason?: string, multiplicity?: number}} */
        let result = { ok: false };
        for (const seed of SITE_SEEDS) {
          result = setWyckoffOrbitSite(orbit.orbitId,
            constrainRepresentative(symmetry.number, letter, seed), labels, structure);
          if (result.ok) break;
        }
        if (!result.ok) {
          status.textContent = result.reason ?? 'Could not move the orbit to that site.';
          siteSelect.value = orbit.wyckoff;
          return;
        }
        afterStructureEdit();
      });

      const coordInputs = AXES.map((axis) => /** @type {HTMLInputElement} */ (row.querySelector(`.orbit-${axis}`)));
      const elementInput = /** @type {HTMLInputElement} */ (row.querySelector('.orbit-element'));
      const removeBtn = /** @type {HTMLButtonElement} */ (row.querySelector('.orbit-remove'));

      removeBtn.disabled = orbits.length <= 1;
      removeBtn.title = orbits.length <= 1
        ? 'The last orbit cannot be removed — it would leave an empty structure'
        : `Remove all ${orbit.multiplicity} ${orbit.element} atoms of this orbit`;

      function commitCoords() {
        status.textContent = '';
        const typed = coordInputs.map((input) => parseFloat(input.value) || 0);
        // The disabled axes are derived from the free ones, not read back.
        const target = siteLetter ? constrainRepresentative(symmetry.number, siteLetter, typed) : typed;
        if (!applyWyckoffOrbitPosition(orbit.representativeIndex, target, structure)) {
          status.textContent = orbit.isFixed
            ? 'This site has no free parameters.'
            : 'Move refused — it would collapse two sites onto each other.';
        }
        // Whether it landed or was refused, show where the atom actually is:
        // the move is projected onto the site's degrees of freedom, so the
        // typed value is rarely the value that results.
        syncCoordsFromStructure();
      }

      coordInputs.forEach((input) => input.addEventListener('change', commitCoords));

      elementInput.addEventListener('change', () => {
        status.textContent = '';
        const picked = elementInput.value.trim();
        if (!elementData[picked]) {
          status.textContent = `Not a recognized element: ${picked || '(empty)'}. Use the periodic table picker (⚛).`;
          elementInput.value = orbit.element;
          return;
        }
        if (setWyckoffOrbitElement(orbit.orbitId, picked, structure)) afterStructureEdit();
      });

      row.querySelector('.orbit-pick-element').addEventListener('click', () => {
        openPeriodicTable((picked) => {
          if (setWyckoffOrbitElement(orbit.orbitId, picked, structure)) afterStructureEdit();
        });
      });

      // The project's own swatch picker (SwatchColorPicker), same as the atom
      // table uses - not the browser's native <input type="color">.
      const colorCell = row.querySelector('.orbit-color-cell');
      const initialHex = colorToHex(structure.atoms[orbit.representativeIndex].getColor());
      colorCell.appendChild(createColorSwatch(initialHex, (hex) => {
        setWyckoffOrbitColor(orbit.orbitId, hex, structure);
      }));

      // Clicking the row (not one of its controls) highlights the whole orbit,
      // which is the only way to see which atoms a row actually owns.
      row.addEventListener('click', (event) => {
        if (/** @type {HTMLElement} */ (event.target).closest('button, input')) return;
        clearHighlightAtom();
        if (highlightedOrbitId === orbit.orbitId) {
          highlightedOrbitId = null;
          return;
        }
        highlightedOrbitId = orbit.orbitId;
        highlightAtomsIn3D(orbit.atomIndices);
      });

      removeBtn.addEventListener('click', () => {
        status.textContent = '';
        clearHighlightAtom();
        highlightedOrbitId = null;
        // Snapshot BEFORE the removal: afterwards the orbit is gone and its
        // representative index points at a different atom. Only an orbit that
        // was there when the lock was made is worth listing and restoring -
        // removing one you just added simply drops it.
        const wasOriginal = mod.baseline.has(orbit.orbitId);
        const snapshot = {
          key: mod.nextRemovedKey,
          element: orbit.element,
          wyckoff: orbit.wyckoff,
          siteSymmetry: orbit.siteSymmetry,
          multiplicity: orbit.multiplicity,
          representative: [...structure.atoms[orbit.representativeIndex].position],
        };
        if (!removeWyckoffOrbit(orbit.orbitId, structure)) return;
        if (wasOriginal) {
          mod.removed.set(snapshot.key, snapshot);
          mod.nextRemovedKey += 1;
        }
        afterStructureEdit();
      });

      rows.push({ orbitId: orbit.orbitId, representativeIndex: orbit.representativeIndex, inputs: coordInputs });
    });

    markNewOrbitGap();
  }

  // Splice a "Newly added" label row above the first orbit the user added, so
  // the originals and the additions read as two groups - the same idiom the
  // free-form body uses for atoms. Added orbits are always appended, so they
  // are contiguous at the bottom.
  function markNewOrbitGap() {
    const orbits = getWyckoffOrbitGroups(structure);
    const firstNewRow = [...tbody.querySelectorAll('tr')]
      .find((_, index) => orbits[index] && !mod.baseline.has(orbits[index].orbitId));
    if (!firstNewRow) return;
    const colCount = sitesHost.querySelectorAll('thead th').length;
    const separator = document.createElement('tr');
    separator.className = 'orbit-new-separator';
    separator.innerHTML = `<td colspan="${colCount}">Newly added</td>`;
    firstNewRow.parentNode.insertBefore(separator, firstNewRow);
  }

  // Removals have nowhere else to appear (the additions show up in the table
  // itself), and they carry the restore button. Restoring re-expands the orbit
  // from the lock's operations, so it comes back as the same set of atoms -
  // appended at the end rather than at its old indices, which removeWyckoffOrbit
  // has already renumbered away.
  function renderOrbitSummary() {
    summaryHost.innerHTML = '';
    const removed = [...mod.removed.values()];
    if (!removed.length) return;

    summaryHost.appendChild(makeListHeading(`Removed orbits (${removed.length})`));
    const list = document.createElement('div');
    list.className = 'addstructure-scroll-list';
    removed.forEach((snapshot) => {
      const [x, y, z] = snapshot.representative;
      const label = `${snapshot.element} ${snapshot.multiplicity}${snapshot.wyckoff}`;
      list.appendChild(summaryEntry({ element: label, x, y, z }, () => {
        status.textContent = '';
        const result = addWyckoffOrbit({
          element: snapshot.element,
          representative: snapshot.representative,
          wyckoff: snapshot.wyckoff,
          siteSymmetry: snapshot.siteSymmetry,
        }, structure);
        if (!result.ok) {
          status.textContent = result.reason ?? 'Could not restore the orbit.';
          return;
        }
        mod.removed.delete(snapshot.key);
        afterStructureEdit();
      }));
    });
    summaryHost.appendChild(list);
  }

  // --- Add a site ---
  body.appendChild(makeSectionHeadline('Add Site'));

  const addHost = document.createElement('div');
  addHost.innerHTML = `
    <table class="addstructure-table addstructure-table--spaced">
      <thead><tr>
        <th class="wyckoff-site-th">Element</th>
        <th class="wyckoff-site-th" title="Wyckoff site to place the new atom on">Site</th>
        <th class="wyckoff-site-th">X</th>
        <th class="wyckoff-site-th">Y</th>
        <th class="wyckoff-site-th">Z</th>
        <th class="wyckoff-site-th"></th>
      </tr></thead>
      <tbody><tr>
        <td class="addstructure-cell">
          <div class="addstructure-inline-row">
            <input type="text" id="wyckoffNewElement" title="Element for the new site" class="wyckoff-text-input">
            <button type="button" id="wyckoffNewPick" title="Pick the element from the periodic table" class="addstructure-pick-btn">⚛</button>
          </div>
        </td>
        <td class="addstructure-cell">
          <select id="wyckoffNewSite" class="wyckoff-orbit-num-input" disabled><option value="">…</option></select>
          <div id="wyckoffNewForm" class="wyckoff-site-form"></div>
        </td>
        ${AXES.map((axis) => `<td class="addstructure-cell"><input type="number" step="0.05" id="wyckoffNew${axis.toUpperCase()}" class="coord-input wyckoff-orbit-num-input wyckoff-axis-input" value="0"></td>`).join('')}
        <td class="addstructure-cell addstructure-center">
          <button type="button" id="wyckoffAddSite" class="btn-mini highlight addstructure-nowrap"
            title="Add this site and every symmetry image of it">+ Add</button>
        </td>
      </tr></tbody>
    </table>
  `;
  body.appendChild(addHost);

  const addPreview = document.createElement('div');
  addPreview.className = 'wyckoff-add-preview wyckoff-hint';
  body.appendChild(addPreview);

  const newElement = /** @type {HTMLInputElement} */ (addHost.querySelector('#wyckoffNewElement'));
  const newCoordInputs = AXES.map((axis) => /** @type {HTMLInputElement} */ (addHost.querySelector(`#wyckoffNew${axis.toUpperCase()}`)));
  const newSite = /** @type {HTMLSelectElement} */ (addHost.querySelector('#wyckoffNewSite'));
  const newSiteForm = /** @type {HTMLElement} */ (addHost.querySelector('#wyckoffNewForm'));
  const addBtn = /** @type {HTMLButtonElement} */ (addHost.querySelector('#wyckoffAddSite'));

  // Whether the site letters from symmetry_basics.json can be trusted for THIS
  // lock. They are two different worlds: the lock is moyo's, in moyo's setting
  // and in whatever cell was analysed, while the tables are keyed to one setting
  // per IT number. The one thing this panel asks of them is that
  // constrainRepresentative() be meaningful in the LOCK's coordinates, so that
  // is what gets tested - every labelled orbit's representative must already
  // satisfy the parametrisation the tables give its letter. A different setting
  // or a rotated standard cell fails that; a primitive or super cell does not,
  // which is the point.
  //
  // Multiplicity is deliberately NOT part of the test. It differs whenever the
  // analysed cell is not the conventional one - primitive Si is Fd-3m 8a with
  // two atoms in the cell, not eight - and requiring equality there rejected
  // every primitive structure even though its coordinates line up exactly. The
  // count the user is shown always comes from the lock, and refreshAddPreview
  // says so when it disagrees with the table.
  const SITE_MATCH_TOLERANCE = 1e-3;
  let siteLettersUsable = false;

  function lettersAgreeWithLock() {
    const labelled = getWyckoffOrbitGroups(structure)
      .filter((orbit) => /^[a-zA-Z]$/.test(orbit.wyckoff ?? ''));
    if (!labelled.length) return false;
    return labelled.every((orbit) => {
      try {
        const actual = structure.atoms[orbit.representativeIndex].position;
        const snapped = constrainRepresentative(symmetry.number, orbit.wyckoff, actual);
        return snapped.every((value, axis) => {
          let delta = value - actual[axis];
          delta -= Math.round(delta); // fractional coordinates wrap
          return Math.abs(delta) <= SITE_MATCH_TOLERANCE;
        });
      } catch {
        return false;
      }
    });
  }

  // How many atoms a site actually produces IN THIS CELL, measured by expanding
  // it under the lock rather than read off the table: a primitive cell holds
  // Fd-3m's 8a as two atoms, and labelling it "8a" in the menu would promise six
  // atoms that never arrive. Measured at a generic point of the site's
  // parametrisation - taking the tabulated representative with its free
  // parameters at zero can land on a higher-symmetry position and undercount.
  const GENERIC_POINT = [0.123, 0.234, 0.345];
  /** @type {Map<string, number>} */
  const siteMultiplicity = new Map();

  function measureSite(letter) {
    if (siteMultiplicity.has(letter)) return siteMultiplicity.get(letter);
    let measured = getSiteFreedom(symmetry.number, letter).multiplicity;
    try {
      const generic = constrainRepresentative(symmetry.number, letter, GENERIC_POINT);
      measured = previewWyckoffOrbit(generic, structure)?.multiplicity ?? measured;
    } catch (error) {
      console.warn(`Modify (Wyckoff): could not measure site ${letter}`, error);
    }
    siteMultiplicity.set(letter, measured);
    return measured;
  }

  // A letter is only offered when its tabulated coordinates still MEAN that site
  // in this cell, and the test is that the measured orbit size comes out at the
  // tabulated multiplicity scaled by the cell ratio. In a primitive
  // face-centred cell that keeps the sites whose parametrisation is invariant
  // under the centring transform - Fd-3m's 8a and 32e (x,x,x) become 2a and 8e -
  // and drops the ones whose coordinates would land somewhere else entirely
  // (8b, 16d, 48f), where an atom would be placed off the site it was named
  // after. Those come back when the structure is converted to its conventional
  // cell, which is also what the fallback note says.
  function letterIsConsistent(letter) {
    if (!/^[a-zA-Z]$/.test(letter ?? '')) return false; // an added orbit has no letter
    try {
      const expected = getSiteFreedom(symmetry.number, letter).multiplicity / (symmetry.conventionalCellRatio ?? 1);
      return Number.isInteger(expected) && expected === measureSite(letter);
    } catch {
      return false;
    }
  }

  function siteOptions() {
    return getWyckoffLetters(symmetry.number)
      .filter(letterIsConsistent)
      .map((letter) => {
        const { siteSymmetry } = getSiteFreedom(symmetry.number, letter);
        return `<option value="${letter}">${measureSite(letter)}${letter}${siteSymmetry ? ` (${siteSymmetry})` : ''}</option>`;
      })
      .join('');
  }

  // Disable the coordinates the chosen site does not leave free and show what
  // the symmetry makes of the typed values, so the boxes always hold the
  // position that will actually be generated. Mirrors the add panel's Wyckoff
  // tab (SymmetryWyckoffTab.js's syncRowFreedom).
  function syncNewSiteFreedom() {
    if (!siteLettersUsable || !newSite.value) {
      newCoordInputs.forEach((input) => { input.disabled = false; input.title = ''; });
      newSiteForm.textContent = '';
      return;
    }
    const { hasFreedom, firstOrbit } = getSiteFreedom(symmetry.number, newSite.value);
    const typed = newCoordInputs.map((input) => parseFloat(input.value) || 0);
    const actual = constrainRepresentative(symmetry.number, newSite.value, typed);

    newCoordInputs.forEach((input, index) => {
      const free = hasFreedom[index] !== false;
      input.disabled = !free;
      input.title = free ? '' : `Determined by site ${newSite.value} (${firstOrbit})`;
      if (!free) input.value = String(round4(actual[index]));
    });
    newSiteForm.textContent = firstOrbit;
  }

  // The multiplicity of a new site is not a lookup - it is however many distinct
  // images the lock's operations produce from these coordinates, which drops as
  // the position approaches a special one. So it is measured and shown before
  // the add, and the number here is the number that lands. When a letter is
  // chosen its table multiplicity is compared against that measurement, which is
  // what catches a site whose coordinates do not really sit on it.
  function refreshAddPreview() {
    const preview = previewWyckoffOrbit(newCoordInputs.map((input) => parseFloat(input.value) || 0), structure);
    if (!preview) {
      addPreview.textContent = '';
      return;
    }
    if (preview.collapses) {
      addPreview.textContent = `${preview.multiplicity} atoms — overlaps an existing atom, will be refused.`;
      return;
    }
    // Measured for THIS cell, not the table's count: they differ for any cell
    // that is not the conventional one.
    const expected = siteLettersUsable && newSite.value ? measureSite(newSite.value) : preview.multiplicity;
    addPreview.textContent = expected === preview.multiplicity
      ? `${preview.multiplicity} atom${preview.multiplicity === 1 ? '' : 's'}`
      : `${preview.multiplicity} atoms — not on site ${newSite.value}, which gives ${expected} here`;
  }

  function refreshNewSite() {
    syncNewSiteFreedom();
    refreshAddPreview();
  }

  newCoordInputs.forEach((input) => input.addEventListener('input', refreshAddPreview));
  newCoordInputs.forEach((input) => input.addEventListener('change', refreshNewSite));
  newSite.addEventListener('change', refreshNewSite);
  addHost.querySelector('#wyckoffNewPick').addEventListener('click', () => {
    openPeriodicTable((picked) => { newElement.value = picked; });
  });

  // ~8.9 MB of space-group tables, fetched only now that a locked structure is
  // actually being edited. Until it lands the chooser stays disabled and the
  // free-coordinate path works, so nothing here blocks on it.
  let disposed = false;
  loadSymmetryData()
    .then(() => {
      if (disposed) return;
      siteLettersUsable = lettersAgreeWithLock() && siteOptions() !== '';
      if (!siteLettersUsable) {
        newSite.innerHTML = '<option value="">free</option>';
        newSite.title = 'The tabulated Wyckoff sites for this space group do not line up with this cell (a different setting or origin), so coordinates are entered freely.';
        newSiteForm.textContent = 'free';
        return;
      }
      const offered = siteOptions();
      newSite.innerHTML = `<option value="">free</option>${offered}`;
      newSite.disabled = false;
      const dropped = getWyckoffLetters(symmetry.number).length - (offered.match(/<option/g)?.length ?? 0);
      newSite.title = dropped > 0
        ? `${dropped} of this group's sites are not expressible in this cell (it is not the conventional one) and are left out. Convert the structure to its conventional cell to get all of them; "free" always works.`
        : '';
      renderSites(); // the per-orbit site dropdowns were waiting on this
      refreshNewSite();
    })
    .catch((error) => {
      if (disposed) return;
      newSite.innerHTML = '<option value="">free</option>';
      newSiteForm.textContent = 'free';
      console.warn('Modify (Wyckoff): site list unavailable, using free coordinates', error);
    });

  addBtn.addEventListener('click', () => {
    status.textContent = '';
    const element = newElement.value.trim();
    if (!elementData[element]) {
      status.textContent = `Not a recognized element: ${element || '(empty)'}. Use the periodic table picker (⚛).`;
      return;
    }
    const typed = newCoordInputs.map((input) => parseFloat(input.value) || 0);
    // With a letter chosen, the representative is snapped onto that site first.
    // The orbit itself still comes from the lock's operations - the letter only
    // picks and constrains the representative, and labels the result.
    const letter = siteLettersUsable ? newSite.value : '';
    const representative = letter ? constrainRepresentative(symmetry.number, letter, typed) : typed;
    const result = addWyckoffOrbit({
      element,
      representative,
      wyckoff: letter,
      siteSymmetry: letter ? getSiteFreedom(symmetry.number, letter).siteSymmetry : '',
    }, structure);
    if (!result.ok) {
      status.textContent = result.reason ?? 'Could not add the site.';
      return;
    }
    afterStructureEdit();
  });

  // --- Revert ---
  const buttonRow = document.createElement('div');
  buttonRow.className = 'addstructure-button-row';
  const revertBtn = document.createElement('button');
  revertBtn.id = 'commitStructureEdits';
  revertBtn.className = 'btn-mini';
  revertBtn.textContent = 'Revert Changes';
  revertBtn.title = 'Undo every change and restore the structure as it was loaded, keeping symmetry locked';
  buttonRow.appendChild(revertBtn);
  body.appendChild(buttonRow);

  // Anything that changes which atoms exist invalidates the rows (orbit indices
  // and multiplicities move) and can change the element set, so bonds are
  // rebuilt too - the free-form body does the same after an add or delete.
  let lastUnique = structure.uniqueElements.join(',');
  function afterStructureEdit() {
    const uniqueNow = structure.uniqueElements.join(',');
    if (uniqueNow !== lastUnique) { createBondLengthControls(); lastUnique = uniqueNow; }
    renderSites();
    renderOrbitSummary();
    refreshAddPreview();
  }

  function syncCoordsFromStructure() {
    rows.forEach(({ representativeIndex, inputs }) => {
      const position = structure.atoms[representativeIndex]?.position;
      if (!position) return;
      inputs.forEach((input, index) => {
        if (input === document.activeElement) return;
        input.value = String(round4(position[index]));
      });
    });
  }

  // A coordinate changed elsewhere (the Structure Info panel's orbit sliders
  // drive the same applyWyckoffOrbitPosition) lands here. Rows are not rebuilt:
  // an external move never changes orbit membership, and rebuilding would tear
  // out a row mid-edit.
  function onExternalChange() {
    if (structure.symmetry?.mode !== 'wyckoff') {
      remount();
      return;
    }
    syncCoordsFromStructure();
  }
  document.addEventListener('crysviz:atoms-changed', onExternalChange);
  document.addEventListener('crysviz:colors-changed', syncCoordsFromStructure);

  resetLatticeBtn.addEventListener('click', () => {
    resetLatticeToOriginal(structure);
    latticePanel.setLattice(structure.lattice);
    refreshLatticeConstraints();
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderLattice: true, reRenderOther: true, reRenderComposition: 'open' });
  });

  revertBtn.addEventListener('click', async () => {
    if (!window.confirm('Revert all changes? This restores the structure exactly as it was loaded and discards every edit (moved, added and removed orbits, and the cell).')) return;
    // Same ordering constraint as the free-form body: the selection still
    // matches the live mesh here, and the revert rebuilds structure.atoms.
    clearSelectedAtoms();
    clearHighlightAtom();
    const tolerance = symmetry.tolerance;
    revertStructureToOriginal(structure); // drops structure.symmetry: the lock
    delete structure._modify;             // held indices into the old array
    delete structure._wyckoffModify;

    // Re-lock rather than fall back to the free-form table. Reverting restores
    // exactly the structure the lock was built from, so re-analysing at the same
    // tolerance reproduces that lock - and dropping to the atom table would be a
    // mode change the user did not ask for. Re-analysis is only unsafe on a
    // structure that has since been edited (it can reshuffle orbits), which is
    // precisely what a revert has just undone.
    try {
      await activateWyckoffMode(structure, tolerance);
    } catch (error) {
      console.warn('Modify (Wyckoff): could not re-lock after revert', error);
    }
    createBondLengthControls();
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderLattice: true, reRenderOther: true, reRenderComposition: 'open' });
    // Re-mount either way: with the lock back this rebuilds the orbit rows from
    // the fresh orbitIds, and without it falls back to the atom table.
    remount();
  });

  renderSites();
  renderOrbitSummary();
  refreshLatticeConstraints();
  refreshAddPreview();

  return {
    dispose() {
      disposed = true; // the symmetry-table fetch may still be in flight
      if (latticeFrame != null) cancelAnimationFrame(latticeFrame);
      document.removeEventListener('crysviz:atoms-changed', onExternalChange);
      document.removeEventListener('crysviz:colors-changed', syncCoordsFromStructure);
      if (highlightedOrbitId !== null) clearHighlightAtom();
    },
  };
}
