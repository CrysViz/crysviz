import {groups,highlightHover,fileBrowser,atomSelection,general} from '../state/store.js';
import {collapseAllAtomExpansions} from './WindowAndSceneControls.js';
import {setStructurePanelOpen} from './StructureInfoPanel/General.js';
import * as THREE from '../external/three/three.module.js';
import {updateAtoms} from '../render/index.js';
import {updateBonds, bondKey} from '../render/index.js';

const ATOM_HIGHLIGHT_COLOR = new THREE.Color(0xFF8C00);

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

  indices.forEach((index) => {
    groups.atomsMesh.geometry.attributes.instanceEmissive.setXYZ(index, 1, 0.549, 0);
    groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.setX(index, 2.0);
    groups.atomsMesh.setColorAt(index, ATOM_HIGHLIGHT_COLOR);
  });

  groups.atomsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  groups.atomsMesh.instanceColor.needsUpdate = true;
}

export function highlightAtomIn3D(index) {
  clear3DHighlights();
  applyAtomHighlightIndices([index]);
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

/** Locate (and if needed lazily build + expand) the Bonds-tab row for a bond. */
function findBondRow(pair, key) {
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
    if (/** @type {HTMLElement} */ (row).dataset.bondKey === key) {
      return /** @type {HTMLElement} */ (row);
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

  if (highlightHover.currentlyHighlightedBond?.bondIndex === bondIndex) {
    clearBondSelection();
    return;
  }
  if (!bond.instanceIds) return; // filtered out of the mesh (too short to render)

  clearSelectedAtoms({ reason: 'bond-select' });
  clearUIHighlight();

  highlightBondIn3D(bond.instanceIds); // clears prior 3D atom+bond highlights first
  highlightHover.currentlyHighlightedBond = {
    bondIndex,
    key: bondKey(bond.indices),
    pair: bondPairKeyOf(bond),
    instanceIds: [...bond.instanceIds],
  };

  let row = options.row ?? null;
  if (!row && options.openPanel) {
    collapseAllAtomExpansions();
    row = findBondRow(highlightHover.currentlyHighlightedBond.pair, highlightHover.currentlyHighlightedBond.key);
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

/** Panel→3D: select a bond from a click on its own row in the Bonds tab. */
export function selectBondFromRow(bondIndex, rowEl) {
  selectBondByIndex(bondIndex, { row: rowEl });
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

function findAtomRow(element, sourceIndex) {
  const {targetAtomIndex, targetPanelId, targetMode} = getTargetAtomDetails(sourceIndex);
  const composition = ensureAtomPanelVisible(targetMode, targetPanelId);
  if (!composition) return null;

  const elementContainers = composition.querySelectorAll('.comp-container');
  let targetContainer = null;

  for (const container of elementContainers) {
    const elementName = container.querySelector('.comp-left span:nth-child(2)');
    if (elementName && elementName.textContent === element) {
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
    if (Number(row.dataset.atomIndex) === targetAtomIndex) {
      return row;
    }
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
    const row = findAtomRow(atom.element, atom.sourceIndex);
    if (!row) return;
    highlightAtomRow(row, atom.selectionOrder);
    lastRow = row;
  });

  if (options.scrollToLast && lastRow) {
    lastRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function syncSelectedAtomHighlights(options = {}) {
  applyAtomHighlightIndices(atomSelection.selectedAtoms.map((atom) => atom.instanceId));
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

function commitSelection(nextSelection, eventInfo, options = {}) {
  atomSelection.selectedAtoms = reindexSelection(nextSelection);
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
    (atom) => atom.instanceId === selectionAtom.instanceId,
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
    removedAtoms = previousSelection.filter((atom) => atom.instanceId !== keptAtom.instanceId);
    nextSelection = [keptAtom];
    action = previousSelection.length ? 'replaced' : 'selected';
  }

  nextSelection = reindexSelection(nextSelection);

  const addedAtoms = nextSelection
    .filter((atom) => !previousSelection.some((selectedAtom) => selectedAtom.instanceId === atom.instanceId))
    .map(cloneSelectionAtom);
  const focusedAtom = nextSelection.find((atom) => atom.instanceId === selectionAtom.instanceId) ?? null;
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
export function selectAtomFromRow(atomIndex, sourceEvent = null) {
  const structure = fileBrowser.selectedStructure;
  const instanceId = structure?.atomImages?.[atomIndex]?.[0];
  if (instanceId === undefined || !groups.atomsMesh) return;
  clearBondSelection();
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
  clear3DHighlights();
}

window.clearAtomHighlight = clearAllHighlights;
