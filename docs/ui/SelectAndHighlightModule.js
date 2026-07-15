import {groups,highlightHover,fileBrowser,atomSelection,general} from '../state/store.js';
import {collapseAllAtomExpansions} from './WindowAndSceneControls.js';
import {setStructurePanelOpen} from './StructureInfoPanel/General.js';
import * as THREE from '../external/three/three.module.js';
import {updateAtoms} from '../render/index.js';
import {updateBonds, bondKey, bondGroupKey, polyhedronGroupKey} from '../render/index.js';
import {updateForces, updateSpins} from '../render/index.js';

const ATOM_HIGHLIGHT_COLOR = new THREE.Color(0xFF8C00);
// Same emissive glow atoms/bonds get when selected (AtomsFracUpdateModule.js/
// BondsFracUpdateModule.js use this exact RGB + intensity) — arrows reuse it
// so a highlighted arrow visually matches a highlighted atom/bond.
const HIGHLIGHT_EMISSIVE = { r: 1, g: 0.549, b: 0 };
const HIGHLIGHT_EMISSIVE_INTENSITY = 2.0;

function getEventModifiers(event) {
  return {
    shiftKey: Boolean(event?.shiftKey),
    ctrlKey: Boolean(event?.ctrlKey),
    metaKey: Boolean(event?.metaKey),
    altKey: Boolean(event?.altKey),
  };
}

function cloneSelectionAtom(atom) {
  return {
    selectionOrder: atom.selectionOrder,
    instanceId: atom.instanceId,
    sourceIndex: atom.sourceIndex,
    element: atom.element,
    position: atom.position?.clone?.() ?? atom.position ?? null,
    object: atom.object ?? null,
    hit: atom.hit ?? null,
  };
}

function snapshotSelectedAtoms() {
  return atomSelection.selectedAtoms.map(cloneSelectionAtom);
}

function reindexSelection(selection) {
  selection.forEach((atom, index) => {
    atom.selectionOrder = index + 1;
  });
  return selection;
}

function dispatchSelectionChange(eventInfo) {
  const payload = {
    selectedAtoms: snapshotSelectedAtoms(),
    event: eventInfo,
  };

  atomSelection.subscribers.forEach((subscriber) => {
    try {
      subscriber(payload);
    } catch (error) {
      console.error('Atom selection subscriber failed', error);
    }
  });
}

export function getSelectedAtoms() {
  return snapshotSelectedAtoms();
}

export function subscribeToAtomSelection(subscriber, options = {}) {
  atomSelection.subscribers.add(subscriber);

  if (options.emitCurrent) {
    subscriber({
      selectedAtoms: snapshotSelectedAtoms(),
      event: {
        action: 'snapshot',
        atom: null,
        atoms: [],
        addedAtoms: [],
        removedAtoms: [],
        modifiers: getEventModifiers(null),
        sourceEvent: null,
      },
    });
  }

  return () => {
    atomSelection.subscribers.delete(subscriber);
  };
}

export function clearHighlightAtom() {
  updateAtoms(1.0);
  clearForceSpinHighlight();
}

// Force/spin arrows are drawn once per SOURCE atom, never once per periodic
// image (ForceModule.js/SpinModule.js's `seen` de-dupe in their build loop),
// unlike the atoms mesh — so highlighting them needs each instance id
// resolved back to its source atom first.
function sourceIndicesForInstances(instanceIds) {
  const srcIndexArr = fileBrowser.selectedStructure?.periodic?.wrapped?.srcIndex;
  const unique = new Set();
  instanceIds.forEach((id) => unique.add(srcIndexArr ? srcIndexArr[id] : id));
  return [...unique];
}

// Glows an arrow instance the same way a selected atom/bond glows — sets
// instanceEmissive/instanceEmissiveIntensity only, leaving instanceColor (and
// so the arrow's real colormap-driven or userColor color) untouched.
function setArrowEmissiveGlow(shaftMesh, tipMesh, arrowIndex) {
  if (arrowIndex == null || !shaftMesh || !tipMesh) return;
  const shaftEmissive = shaftMesh.geometry.attributes.instanceEmissive;
  const shaftIntensity = shaftMesh.geometry.attributes.instanceEmissiveIntensity;
  const tipEmissive = tipMesh.geometry.attributes.instanceEmissive;
  const tipIntensity = tipMesh.geometry.attributes.instanceEmissiveIntensity;
  if (!shaftEmissive || !shaftIntensity || !tipEmissive || !tipIntensity) return;

  const { r, g, b } = HIGHLIGHT_EMISSIVE;
  shaftEmissive.setXYZ(arrowIndex * 2, r, g, b);
  shaftEmissive.setXYZ(arrowIndex * 2 + 1, r, g, b);
  shaftIntensity.setX(arrowIndex * 2, HIGHLIGHT_EMISSIVE_INTENSITY);
  shaftIntensity.setX(arrowIndex * 2 + 1, HIGHLIGHT_EMISSIVE_INTENSITY);
  tipEmissive.setXYZ(arrowIndex, r, g, b);
  tipIntensity.setX(arrowIndex, HIGHLIGHT_EMISSIVE_INTENSITY);

  shaftEmissive.needsUpdate = true;
  shaftIntensity.needsUpdate = true;
  tipEmissive.needsUpdate = true;
  tipIntensity.needsUpdate = true;
}

// Which atom's arrow (if any) should be highlighted INSTEAD OF its atom
// sphere. Selecting an atom always glows its sphere by default — this
// override only engages while the Structure Info panel's Spin/Force row
// editor is open for that specific atom (see IndividualAtomRow.js's
// setActiveEditor and SpinForceEditor.js's mode switch), matching whichever
// of the two tabs (spin/force) the editor is currently showing.
let arrowHighlightOverride = null; // { atomIndex: number, kind: 'spin' | 'force' } | null

/** Engage the arrow-only highlight for one atom (SOURCE index) + arrow kind,
 *  re-applying the current 3D highlight immediately so the switch is live. */
export function setArrowHighlightOverride(atomIndex, kind) {
  arrowHighlightOverride = { atomIndex, kind };
  reapplyCurrentSelectionHighlight();
}

/** Undo setArrowHighlightOverride(): the highlighted atom's sphere glows
 *  again instead of its arrow. */
export function clearArrowHighlightOverride() {
  if (!arrowHighlightOverride) return;
  arrowHighlightOverride = null;
  reapplyCurrentSelectionHighlight();
}

function reapplyCurrentSelectionHighlight() {
  if (atomSelection.selectedAtoms.length) {
    applyAtomHighlightIndices(atomSelection.selectedAtoms.flatMap((atom) => instancesForSelectedAtom(atom)));
  }
}

/**
 * Highlights the ONE arrow the current override targets, if any of the given
 * ATOM INSTANCE ids resolve to its source atom — the arrow counterpart of
 * applyAtomHighlightIndices's own atom glow, called right alongside it.
 */
function applyForceSpinHighlightForInstances(instanceIds) {
  if (!arrowHighlightOverride) return;
  const { atomIndex, kind } = arrowHighlightOverride;
  if (!sourceIndicesForInstances(instanceIds).includes(atomIndex)) return;

  if (kind === 'force') {
    setArrowEmissiveGlow(groups.forcesShaftMesh, groups.forcesTipMesh, groups.forcesInstanceBySrcIndex?.get(atomIndex));
  } else {
    setArrowEmissiveGlow(groups.spinShaftMesh, groups.spinTipMesh, groups.spinsInstanceBySrcIndex?.get(atomIndex));
  }
}

// Restores the arrows' true colors — the arrow counterpart of
// clearHighlightAtom()'s own updateAtoms(1.0) full recolor. A full rebuild
// (not just re-painting the previously-highlighted instances) because the
// force/spin meshes can have been rebuilt with a different instance count
// since the highlight was applied (a colormap/log-scale change while an
// atom stayed selected) — anything less would risk repainting a stale or
// out-of-bounds index. Always reads structure.forces/spins — SpinPanel.js's
// separate "manual spins" textarea mode isn't reachable from here, so a
// highlighted-then-cleared atom while manual spins are showing briefly
// reverts to the structure's own spins until the next manual-mode redraw.
function clearForceSpinHighlight() {
  if (general.forcesActive) updateForces();
  if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap ?? 'none');
}

export function clearHighlightBond() {
  updateBonds(1.0);
}

function clearUIHighlight() {
  const rows = highlightHover.currentlyHighlightedRows?.length
    ? highlightHover.currentlyHighlightedRows
    : (highlightHover.currentlyHighlightedRow ? [highlightHover.currentlyHighlightedRow] : []);

  rows.forEach((row) => {
    row.style.backgroundColor = '';
    row.style.borderLeft = '';
    delete row.dataset.selectionOrder;
  });

  highlightHover.currentlyHighlightedRow = null;
  highlightHover.currentlyHighlightedRows = [];
}

function clear3DHighlights() {
  clearHighlightBond();
  clearHighlightAtom();
}

function applyAtomHighlightIndices(indices) {
  clearHighlightAtom();

  if (!groups.atomsMesh || !indices.length) {
    return;
  }

  // Normally every selected atom's sphere glows. The one exception: while
  // the Structure Info panel's Spin/Force editor is open for an atom
  // (arrowHighlightOverride), that atom's sphere is skipped here in favor of
  // its arrow, highlighted below by applyForceSpinHighlightForInstances.
  let atomsChanged = false;
  indices.forEach((index) => {
    const srcIdx = sourceIndicesForInstances([index])[0];
    if (arrowHighlightOverride && arrowHighlightOverride.atomIndex === srcIdx) return;

    groups.atomsMesh.geometry.attributes.instanceEmissive.setXYZ(index, 1, 0.549, 0);
    groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.setX(index, 2.0);
    groups.atomsMesh.setColorAt(index, ATOM_HIGHLIGHT_COLOR);
    atomsChanged = true;
  });

  if (atomsChanged) {
    groups.atomsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
    groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
    groups.atomsMesh.instanceColor.needsUpdate = true;
  }

  applyForceSpinHighlightForInstances(indices);
}

export function highlightAtomIn3D(index) {
  clear3DHighlights();
  applyAtomHighlightIndices([index]);
}

/**
 * Highlight several atoms at once, given their SOURCE indices (structure.atoms
 * order — e.g. a group of atoms sharing a coordination number). Expands each
 * to every periodic-image instance via structure.atomImages, same as a
 * multi-atom selection does, so all copies glow, not just the primary cell's.
 */
export function highlightAtomsIn3D(sourceIndices) {
  clear3DHighlights();
  const structure = fileBrowser.selectedStructure;
  const instances = sourceIndices.flatMap((i) => structure?.atomImages?.[i] ?? [i]);
  applyAtomHighlightIndices(instances);
}

/**
 * Temporarily remove the 3D highlight glow/recolor from whatever is
 * currently selected, without touching the selection itself (row highlight,
 * atomSelection/currentlyHighlightedBond state) — so a color editor opened
 * for the selected atom/bond shows the real, live color underneath instead
 * of the orange highlight overlay. Pair with restoreSelectionHighlight().
 */
export function suppressSelectionHighlightFor3D() {
  clearHighlightAtom();
  clearHighlightBond();
}

/** Undo suppressSelectionHighlightFor3D(): reapplies the 3D glow for the
 *  current atom or bond selection. */
export function restoreSelectionHighlight() {
  if (atomSelection.selectedAtoms.length) {
    applyAtomHighlightIndices(atomSelection.selectedAtoms.flatMap((atom) => instancesForSelectedAtom(atom)));
  } else if (highlightHover.currentlyHighlightedBond) {
    highlightBondIn3D(highlightHover.currentlyHighlightedBond.instanceIds);
  }
}

export function highlightBondIn3D(indexList) {
  clear3DHighlights();

  indexList.forEach((index) => {
    groups.bondsMesh.geometry.attributes.instanceEmissive.setXYZ(index, 1, 0.549, 0);
    groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity.setX(index, 2.0);
    groups.bondsMesh.setColorAt(index, ATOM_HIGHLIGHT_COLOR);
  });

  groups.bondsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  groups.bondsMesh.instanceColor.needsUpdate = true;
}

function showPanel(panelId) {
  document.querySelectorAll('.atomBondClass').forEach((panel) => {
    panel.style.display = 'none';
  });

  const panelToShow = document.getElementById(panelId);
  if (panelToShow) {
    panelToShow.style.display = 'block';
  }
}

// =============================================
// BOND SELECTION (single-select)
// =============================================

/** Category key of a bond's species pair, matching the Bonds-tab row keys
 *  (alphabetical "ElA-ElB", same ordering as BondLengthPanel pair generation). */
function bondPairKeyOf(bond) {
  const [e1, e2] = bond.elements;
  return e1 < e2 ? `${e1}-${e2}` : `${e2}-${e1}`;
}

export function clearBondSelection() {
  clearHighlightBond();
  clearUIHighlight();
  highlightHover.currentlyHighlightedBond = null;
}

/** Locate (and if needed lazily build + expand) the Bonds-tab row for a bond
 *  (its group row when a groupKey is given — linked mode). */
function findBondRow(pair, key, groupKey = null) {
  const composition = ensureAtomPanelVisible('bonds', 'infoBondControls');
  if (!composition) return null;
  general.structurePanelMode = 'bonds';

  const control = composition.querySelector(`.bond-control[data-pair="${pair}"]`);
  if (!control) return null;

  const bondsContainer = /** @type {HTMLElement} */ (control.querySelector('.individual-bonds'));
  if (!bondsContainer) return null;

  // Individual bond rows are populated lazily on first expand (see
  // BondLengthPanel.js). We expand programmatically here, so ensure they exist.
  /** @type {any} */ (bondsContainer)._populateBondRows?.();

  if (bondsContainer.style.display === 'none') {
    bondsContainer.style.display = 'block';
    const expandIcon = /** @type {HTMLElement} */ (control.querySelector('.bond-expand-icon'));
    if (expandIcon) expandIcon.style.transform = 'rotate(90deg)';
  }

  for (const row of bondsContainer.querySelectorAll('.individual-bond-row')) {
    const el = /** @type {HTMLElement} */ (row);
    if (groupKey ? el.dataset.groupKey === groupKey : el.dataset.bondKey === key) {
      return el;
    }
  }
  return null;
}

/**
 * Select a bond by its index into structure.bonds: orange 3D highlight +
 * amber panel-row highlight. Selecting the already-selected bond deselects.
 * options.row — the caller's own panel row (panel→3D path; skips panel lookup)
 * options.openPanel — open the Structure window / Bonds tab and find the row
 * options.scrollToSelection — scroll the row into view
 */
function selectBondByIndex(bondIndex, options = {}) {
  const structure = fileBrowser.selectedStructure;
  const bond = structure?.bonds?.[bondIndex];
  if (!bond) return;

  // "Link periodic copies" on: the selection unit is the whole group of
  // periodic-image copies of this physical bond — all copies glow, and the
  // grouped panel row is the target.
  const linking = general.linkPeriodicCopies !== false;
  let groupKey = null;
  let memberIndexes = [bondIndex];
  if (linking) {
    groupKey = bondGroupKey(structure, bond);
    memberIndexes = options.linkedBondIndexes
      ?? structure.bonds.reduce((acc, b, i) => {
        if (bondGroupKey(structure, b) === groupKey) acc.push(i);
        return acc;
      }, []);
  }

  const cur = highlightHover.currentlyHighlightedBond;
  if (cur && (linking ? cur.groupKey === groupKey : cur.bondIndex === bondIndex)) {
    clearBondSelection();
    return;
  }
  const instanceIds = memberIndexes.flatMap((i) => structure.bonds[i]?.instanceIds ?? []);
  if (!instanceIds.length) return; // nothing renderable (too short / filtered)

  clearSelectedAtoms({ reason: 'bond-select' });
  clearPolyhedronSelection();
  clearUIHighlight();

  highlightBondIn3D(instanceIds); // clears prior 3D atom+bond highlights first
  highlightHover.currentlyHighlightedBond = {
    bondIndex, // the clicked/representative member
    key: bondKey(bond.indices),
    pair: bondPairKeyOf(bond),
    instanceIds,
    groupKey, // null when unlinked
    bondIndexes: linking ? memberIndexes : null,
  };

  let row = options.row ?? null;
  if (!row && options.openPanel) {
    collapseAllAtomExpansions();
    row = findBondRow(
      highlightHover.currentlyHighlightedBond.pair,
      highlightHover.currentlyHighlightedBond.key,
      groupKey,
    );
  }
  if (row) {
    highlightAtomRow(row);
    if (options.scrollToSelection) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

/** 3D→panel: select the bond owning a picked bond-half instance id. */
export function selectBondFromInstance(instanceId, options = {}) {
  const mapping = fileBrowser.selectedStructure?.bondObjectMapping?.[instanceId];
  if (!mapping) return;
  selectBondByIndex(mapping[0], {
    openPanel: true,
    scrollToSelection: options.scrollToSelection !== false,
  });
}

/** Panel→3D: select a bond from a click on its own row in the Bonds tab.
 *  Grouped rows pass their member list so the group needn't be recomputed. */
export function selectBondFromRow(bondIndex, rowEl, linkedBondIndexes = null) {
  selectBondByIndex(bondIndex, { row: rowEl, linkedBondIndexes });
}

// =============================================
// POLYHEDRON SELECTION (single-select)
// =============================================

function findPolyhedronMesh(key) {
  return groups.polyhedraGroup?.children?.find((m) => m.userData?.key === key) ?? null;
}

/** All meshes belonging to a periodic-copy group of polyhedra. */
function findPolyhedronGroupMeshes(groupKey) {
  return (groups.polyhedraGroup?.children ?? []).filter((m) =>
    m.userData?.type === 'polyhedron'
    && (m.userData.groupKey ?? polyhedronGroupKey(m.userData.key ?? '')) === groupKey);
}

/** Notifies listeners (currently just AnalysisPanels/PolyhedronInspector.js)
 *  that the 3D-picked polyhedron selection changed — mirrors the
 *  'crysviz:polyhedra-rebuilt' event PolyhedraModule.js already dispatches. */
function dispatchPolyhedronSelectionEvent(detail) {
  document.dispatchEvent(new CustomEvent('crysviz:polyhedron-selection-changed', { detail }));
}

export function clearPolyhedronSelection() {
  const sel = highlightHover.currentlyHighlightedPolyhedron;
  if (sel) {
    // The meshes may already be gone after an async polyhedra rebuild — fine.
    const targets = sel.groupKey
      ? findPolyhedronGroupMeshes(sel.groupKey)
      : [findPolyhedronMesh(sel.key)].filter(Boolean);
    for (const mesh of targets) {
      if (mesh?.material?.emissive) {
        mesh.material.emissive.set(0x000000);
        mesh.material.emissiveIntensity = 1;
      }
    }
  }
  clearUIHighlight();
  highlightHover.currentlyHighlightedPolyhedron = null;
  if (sel) dispatchPolyhedronSelectionEvent(null);
}

/** Locate (and if needed lazily build + expand) the Poly-tab row for a
 *  polyhedron (its group row when a groupKey is given — linked mode). */
function findPolyhedronRow(catKey, key, groupKey = null) {
  const composition = ensureAtomPanelVisible('polyhedra', 'infoPolyControls');
  if (!composition) return null;
  general.structurePanelMode = 'polyhedra';

  const control = composition.querySelector(`.poly-control[data-cat-key="${catKey}"]`);
  if (!control) return null;

  const listContainer = /** @type {HTMLElement} */ (control.querySelector('.individual-polyhedra'));
  if (!listContainer) return null;

  // Rows are populated lazily on first expand (see PolyhedraListPanel.js).
  /** @type {any} */ (listContainer)._populatePolyhedronRows?.();

  if (listContainer.style.display === 'none') {
    listContainer.style.display = 'block';
    const expandIcon = /** @type {HTMLElement} */ (control.querySelector('.poly-expand-icon'));
    if (expandIcon) expandIcon.style.transform = 'rotate(90deg)';
  }

  for (const row of listContainer.querySelectorAll('.individual-polyhedron-row')) {
    const el = /** @type {HTMLElement} */ (row);
    // In linked mode a 3D pick may land on a non-representative copy — its
    // group row is matched by data-poly-group-key, not by the member key.
    if (groupKey ? el.dataset.polyGroupKey === groupKey : el.dataset.polyKey === key) {
      return el;
    }
  }
  return null;
}

/**
 * Select a polyhedron by its stable key: orange emissive glow on its mesh +
 * amber panel-row highlight. Selecting the already-selected one deselects.
 */
function selectPolyhedronByKey(key, catKey, options = {}) {
  // "Link periodic copies" on: the selection unit is the whole group of
  // periodic-image copies — all copies glow, and the grouped row is the target.
  const linking = general.linkPeriodicCopies !== false;
  const groupKey = linking ? polyhedronGroupKey(key) : null;

  const cur = highlightHover.currentlyHighlightedPolyhedron;
  if (cur && (linking ? cur.groupKey === groupKey : cur.key === key)) {
    clearPolyhedronSelection();
    return;
  }
  const meshes = linking
    ? findPolyhedronGroupMeshes(groupKey)
    : [findPolyhedronMesh(key)].filter(Boolean);
  if (!meshes.length || !meshes[0]?.material?.emissive) return;

  clearSelectedAtoms({ reason: 'polyhedron-select' });
  clearBondSelection();
  clearPolyhedronSelection(); // restores any previous polyhedron glow

  for (const mesh of meshes) {
    mesh.material.emissive.set(0xFF8C00);
    mesh.material.emissiveIntensity = 1.0;
  }
  highlightHover.currentlyHighlightedPolyhedron = { key, catKey, groupKey };
  dispatchPolyhedronSelectionEvent({ key, catKey, groupKey });

  let row = options.row ?? null;
  if (!row && options.openPanel) {
    collapseAllAtomExpansions();
    row = findPolyhedronRow(catKey, key, groupKey);
  }
  if (row) {
    highlightAtomRow(row);
    if (options.scrollToSelection) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

/** 3D→panel: select the polyhedron owning a picked face mesh. */
export function selectPolyhedronFromMesh(mesh, options = {}) {
  const ud = mesh?.userData;
  if (ud?.type !== 'polyhedron' || !ud.key) return;
  selectPolyhedronByKey(ud.key, ud.catKey, {
    openPanel: true,
    scrollToSelection: options.scrollToSelection !== false,
  });
}

/** Panel→3D: select a polyhedron from a click on its own row in the Poly tab. */
export function selectPolyhedronFromRow(key, rowEl) {
  const catKey = rowEl?.dataset?.catKey ?? findPolyhedronMesh(key)?.userData?.catKey;
  selectPolyhedronByKey(key, catKey, { row: rowEl });
}

function getTargetAtomDetails(sourceIndex) {
  const symmetry = fileBrowser.selectedStructure?.symmetry;
  const wyckoffOrbit = symmetry?.mode === 'wyckoff'
    ? symmetry.orbitGroups?.find((group) => group.atomIndices.includes(sourceIndex))
    : null;

  return {
    targetAtomIndex: wyckoffOrbit?.representativeIndex ?? sourceIndex,
    targetPanelId: wyckoffOrbit ? 'wyckoffPanel' : 'atomPanel',
    targetMode: wyckoffOrbit ? 'wyckoff' : 'atoms',
  };
}

function ensureAtomPanelVisible(targetMode, targetPanelId) {
  const composition = document.getElementById('composition');
  if (!composition) return null;

  setStructurePanelOpen(true);

  const panelSwitch = document.getElementById('atomBondControlSwitch');
  panelSwitch?.querySelectorAll('button').forEach((btn) => {
    btn.classList.remove('active');
  });
  panelSwitch?.querySelector(`button[data-mode="${targetMode}"]`)?.classList.add('active');
  showPanel(targetPanelId);
  return composition;
}

function findAtomRow(element, sourceIndex, instanceId = null) {
  const {targetAtomIndex, targetPanelId, targetMode} = getTargetAtomDetails(sourceIndex);
  const composition = ensureAtomPanelVisible(targetMode, targetPanelId);
  if (!composition) return null;

  const elementContainers = composition.querySelectorAll('.comp-container');
  let targetContainer = null;

  for (const container of elementContainers) {
    // Match by the data attribute — positional span selectors broke when the
    // header gained the visibility checkbox.
    if (/** @type {HTMLElement} */ (container).dataset.element === element) {
      targetContainer = container;
      break;
    }
  }

  if (!targetContainer) return null;

  const atomsContainer = targetContainer.querySelector('.individual-atoms');
  const expandIcon = targetContainer.querySelector('.comp-left span:last-child');
  if (!atomsContainer) return null;

  // Individual atom rows are populated lazily on first expand (see
  // CompositionRow.js). We expand programmatically here, so ensure they exist.
  /** @type {any} */ (atomsContainer)._populateAtomRows?.();

  if (atomsContainer.style.display === 'none') {
    atomsContainer.style.display = 'block';
    if (expandIcon) {
      expandIcon.style.transform = 'rotate(90deg)';
    }
  }

  for (const row of atomsContainer.querySelectorAll('.individual-atom-row')) {
    if (Number(row.dataset.atomIndex) !== targetAtomIndex) continue;
    // Per-image rows ("Link periodic copies" off) carry data-image-index —
    // match the exact on-screen copy when the caller knows the instance;
    // otherwise fall back to the first row of the source atom.
    if (row.dataset.imageIndex != null && instanceId != null
        && Number(row.dataset.imageIndex) !== instanceId) {
      continue;
    }
    return row;
  }

  return null;
}

export function highlightAtomInStructurePanel(element, sourceIndex) {
  clearUIHighlight();
  collapseAllAtomExpansions();
  const row = findAtomRow(element, sourceIndex);
  if (!row) return;
  highlightAtomRow(row, 1);
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function highlightAtomRow(row, selectionOrder = null) {
  row.style.backgroundColor = 'rgba(255, 191, 0, 0.2)';
  row.style.borderLeft = '3px solid #FFB347';
  if (selectionOrder !== null) {
    row.dataset.selectionOrder = String(selectionOrder);
  }
  highlightHover.currentlyHighlightedRow = row;
  if (!highlightHover.currentlyHighlightedRows.includes(row)) {
    highlightHover.currentlyHighlightedRows.push(row);
  }
}

function syncSelectedAtomRows(options = {}) {
  clearUIHighlight();

  if (!atomSelection.selectedAtoms.length) {
    return;
  }

  /** @type {any} */
  let lastRow = null;
  atomSelection.selectedAtoms.forEach((atom) => {
    const row = findAtomRow(atom.element, atom.sourceIndex, atom.instanceId);
    if (!row) return;
    highlightAtomRow(row, atom.selectionOrder);
    lastRow = row;
  });

  if (options.scrollToLast && lastRow) {
    lastRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// "Link periodic copies" on: an atom-selection entry represents ALL periodic
// copies of its source atom — identity is by source atom (selecting any copy
// of a selected atom toggles it off) and the 3D glow covers every copy, in
// parity with grouped bonds/polyhedra. Off: strictly per-instance.
function atomSelectionLinked() {
  return general.linkPeriodicCopies !== false;
}

function sameSelectionAtom(a, b) {
  return atomSelectionLinked()
    ? a.sourceIndex === b.sourceIndex
    : a.instanceId === b.instanceId;
}

/** The mesh instances an atom-selection entry should glow (all copies when linked). */
function instancesForSelectedAtom(atom) {
  if (!atomSelectionLinked()) return [atom.instanceId];
  const images = fileBrowser.selectedStructure?.atomImages?.[atom.sourceIndex];
  return images?.length ? images : [atom.instanceId];
}

function syncSelectedAtomHighlights(options = {}) {
  applyAtomHighlightIndices(atomSelection.selectedAtoms.flatMap((atom) => instancesForSelectedAtom(atom)));
  syncSelectedAtomRows(options);
}

function buildSelectionAtomFromHit(hit) {
  if (!hit || hit.instanceId === undefined || hit.instanceId === null) {
    return null;
  }

  const wrapped = fileBrowser.selectedStructure?.periodic?.wrapped;
  const instanceId = hit.instanceId;
  const sourceIndex = wrapped?.srcIndex ? wrapped.srcIndex[instanceId] : instanceId;
  const element = wrapped?.elements?.[instanceId]
    || groups.atomsMesh?.userData.elementNames?.[instanceId]
    || fileBrowser.selectedStructure?.elements?.[sourceIndex]
    || '?';
  const position = Array.isArray(wrapped?.cart?.[instanceId])
    ? new THREE.Vector3(...wrapped.cart[instanceId])
    : (hit.point?.clone?.() ?? null);

  return {
    selectionOrder: atomSelection.selectedAtoms.length + 1,
    instanceId,
    sourceIndex,
    element,
    position,
    object: hit.object ?? groups.atomsMesh ?? null,
    hit,
  };
}

// Closes the Structure Info panel's Spin/Force row editor DOM for one atom
// (SOURCE index) and resets its button's active styling — the out-of-closure
// equivalent of IndividualAtomRow.js's own setActiveEditor(null) for that
// row, callable from here where selection changes are centralized.
function closeSpinForceEditorDom(atomIndex) {
  const row = document.querySelector(`.individual-atom-row[data-atom-index="${atomIndex}"]`);
  if (!row) return;
  const editor = row.querySelector('.atom-spin-editor');
  if (editor) editor.style.display = 'none';
  const btn = row.querySelector('.atom-editor-button[data-editor-button="spin"]');
  if (btn) {
    btn.style.border = '1px solid rgba(255,255,255,0.2)';
    btn.style.boxShadow = 'none';
  }
}

function commitSelection(nextSelection, eventInfo, options = {}) {
  atomSelection.selectedAtoms = reindexSelection(nextSelection);
  // An open Spin/Force editor belongs to whichever atom it was opened for —
  // if the selection just moved to a different atom (or away entirely),
  // that editor is now showing stale data for something no longer selected.
  // Close it along with the arrow-highlight override it was driving.
  if (arrowHighlightOverride && !nextSelection.some((atom) => atom.sourceIndex === arrowHighlightOverride.atomIndex)) {
    closeSpinForceEditorDom(arrowHighlightOverride.atomIndex);
    arrowHighlightOverride = null;
  }
  syncSelectedAtomHighlights(options);
  if (!options.silent) {
    dispatchSelectionChange(eventInfo);
  }
  return snapshotSelectedAtoms();
}

export function clearSelectedAtoms(options = {}) {
  const removedAtoms = snapshotSelectedAtoms();
  atomSelection.selectedAtoms = [];
  clearUIHighlight();
  clearHighlightAtom();
  // Safety net: a full deselect should never leave a stale arrow-highlight
  // override (or its open editor) pointed at an atom that's no longer
  // selected (normally IndividualAtomRow.js's setActiveEditor already clears
  // it when its row's Spin/Force editor closes, but a deselect can happen
  // without that, e.g. clicking empty space in the 3D view while the editor
  // is still open).
  if (arrowHighlightOverride) closeSpinForceEditorDom(arrowHighlightOverride.atomIndex);
  arrowHighlightOverride = null;

  if (removedAtoms.length && !options.silent) {
    dispatchSelectionChange({
      action: 'cleared',
      atom: null,
      atoms: removedAtoms,
      addedAtoms: [],
      removedAtoms,
      modifiers: getEventModifiers(options.sourceEvent),
      sourceEvent: options.sourceEvent ?? null,
      reason: options.reason ?? 'clear',
    });
  }

  return removedAtoms;
}

export function updateAtomSelectionFrom3DHit(hit, options = {}) {
  const selectionAtom = buildSelectionAtomFromHit(hit);
  if (!selectionAtom) {
    return snapshotSelectedAtoms();
  }

  const previousSelection = snapshotSelectedAtoms();
  const existingIndex = atomSelection.selectedAtoms.findIndex(
    (atom) => sameSelectionAtom(atom, selectionAtom),
  );
  const existingAtom = existingIndex >= 0 ? cloneSelectionAtom(atomSelection.selectedAtoms[existingIndex]) : null;
  const selectionMode = options.selectionMode ?? 'replace';
  const sourceEvent = options.sourceEvent ?? null;

  let nextSelection = atomSelection.selectedAtoms.map(cloneSelectionAtom);
  let action = 'selected';
  let removedAtoms = [];

  if (selectionMode === 'toggle') {
    if (existingIndex >= 0) {
      removedAtoms = [existingAtom];
      nextSelection.splice(existingIndex, 1);
      action = 'deselected';
    } else {
      nextSelection.push(selectionAtom);
    }
  } else if (selectionMode === 'add') {
    if (existingIndex >= 0) {
      removedAtoms = [existingAtom];
      nextSelection.splice(existingIndex, 1);
      action = 'deselected';
    } else {
      nextSelection.push(selectionAtom);
    }
  } else {
    if (previousSelection.length === 1 && existingIndex === 0) {
      return commitSelection(
        [],
        {
          action: 'deselected',
          atom: existingAtom,
          atoms: existingAtom ? [existingAtom] : [],
          addedAtoms: [],
          removedAtoms: existingAtom ? [existingAtom] : [],
          modifiers: getEventModifiers(sourceEvent),
          sourceEvent,
          reason: options.reason ?? 'pick',
        },
        { scrollToLast: false },
      );
    }

    const keptAtom = existingAtom ?? selectionAtom;
    removedAtoms = previousSelection.filter((atom) => !sameSelectionAtom(atom, keptAtom));
    nextSelection = [keptAtom];
    action = previousSelection.length ? 'replaced' : 'selected';
  }

  nextSelection = reindexSelection(nextSelection);

  const addedAtoms = nextSelection
    .filter((atom) => !previousSelection.some((selectedAtom) => sameSelectionAtom(selectedAtom, atom)))
    .map(cloneSelectionAtom);
  const focusedAtom = nextSelection.find((atom) => sameSelectionAtom(atom, selectionAtom)) ?? null;
  const concernedAtoms = [...addedAtoms, ...removedAtoms];

  return commitSelection(
    nextSelection,
    {
      action,
      atom: focusedAtom ? cloneSelectionAtom(focusedAtom) : null,
      atoms: concernedAtoms,
      addedAtoms,
      removedAtoms,
      modifiers: getEventModifiers(sourceEvent),
      sourceEvent,
      reason: options.reason ?? 'pick',
    },
    { scrollToLast: options.scrollToSelection },
  );
}

/**
 * Panel→3D: select an atom from a click on its row in the Atoms/Wyckoff tab.
 * Runs through the same selection machinery as double-clicking the atom in the
 * 3D view (same modifier semantics: ctrl/cmd toggles, shift adds, plain click
 * replaces; clicking the sole selected atom deselects).
 */
export function selectAtomFromRow(atomIndex, sourceEvent = null, imageIndex = null) {
  const structure = fileBrowser.selectedStructure;
  // Per-image rows pass their own instance; linked rows use the canonical
  // first image of the source atom.
  const instanceId = imageIndex ?? structure?.atomImages?.[atomIndex]?.[0];
  if (instanceId === undefined || !groups.atomsMesh) return;
  clearBondSelection();
  clearPolyhedronSelection();
  updateAtomSelectionFrom3DHit(
    { instanceId, object: groups.atomsMesh },
    {
      selectionMode: (sourceEvent?.ctrlKey || sourceEvent?.metaKey) ? 'toggle' : (sourceEvent?.shiftKey ? 'add' : 'replace'),
      sourceEvent,
      scrollToSelection: false, // the user is already looking at the row
      reason: 'row-click',
    },
  );
}

export function clearAllHighlights(options = {}) {
  clearSelectedAtoms({
    sourceEvent: options.sourceEvent ?? null,
    reason: options.reason ?? 'clear-all',
    silent: options.silent ?? false,
  });
  highlightHover.currentlyHighlightedBond = null;
  clearPolyhedronSelection(); // also restores the emissive before nulling
  clear3DHighlights();
}

window.clearAtomHighlight = clearAllHighlights;
