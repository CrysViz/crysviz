import {groups,highlightHover,fileBrowser,atomSelection,general} from '../state/store.js';
import {collapseAllAtomExpansions} from './WindowAndSceneControls.js';
import {setStructurePanelOpen} from './StructureInfoPanel/General.js';
import * as THREE from '../external/three/three.module.js';
import {updateAtoms} from '../render/index.js';
import {updateBonds, bondKey, bondGroupKey, polyhedronGroupKey, isTracerPipelineActive} from '../render/index.js';
import {updateForces, updateSpins} from '../render/index.js';
import {onAtomsRebuilt} from '../render/atomsRebuildHook.js';

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

// Zero the emissive glow of only the instances we recorded as highlighted, with
// NO instanceColor / full-rebuild touch — the tracer path uses this so
// unhighlighting never bumps the SceneEncoder fingerprint (which would restart
// the accumulation). The highlight then shows via the tracer's post-present
// overlay instead of a recolor.
function clearAtomEmissiveOnly() {
  const mesh = groups.atomsMesh;
  const ids = highlightHover.currentlyHighlightedAtomInstances;
  if (mesh && ids?.length) {
    const em = mesh.geometry.attributes.instanceEmissive;
    const emI = mesh.geometry.attributes.instanceEmissiveIntensity;
    ids.forEach((index) => { em.setXYZ(index, 0, 0, 0); emI.setX(index, 0.0); });
    em.needsUpdate = true;
    emI.needsUpdate = true;
  }
  highlightHover.currentlyHighlightedAtomInstances = [];
}

function clearBondEmissiveOnly() {
  const mesh = groups.bondsMesh;
  const ids = highlightHover.currentlyHighlightedBondInstances;
  if (mesh && ids?.length) {
    const em = mesh.geometry.attributes.instanceEmissive;
    const emI = mesh.geometry.attributes.instanceEmissiveIntensity;
    ids.forEach((index) => { em.setXYZ(index, 0, 0, 0); emI.setX(index, 0.0); });
    em.needsUpdate = true;
    emI.needsUpdate = true;
  }
  highlightHover.currentlyHighlightedBondInstances = [];
}

/** Fired after an atom or bond highlight is cleared, whoever cleared it. A
 *  window that marks what it highlighted (the Bond Length and Force
 *  histograms outline the bar) compares highlightHover's instance lists with
 *  its own and drops the mark once its highlight is gone. */
export const HIGHLIGHT_CLEARED = 'crysviz:highlight-cleared';

function announceHighlightCleared() {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent(HIGHLIGHT_CLEARED));
}

export function clearHighlightAtom() {
  // Under a tracer, clear only the emissive attrs of the tracked instances (no
  // instanceColor bump → no accumulation restart). Raster pipelines keep the
  // classic full rebuild-from-model.
  if (isTracerPipelineActive()) {
    clearAtomEmissiveOnly();
    announceHighlightCleared();
    return;
  }
  highlightHover.currentlyHighlightedAtomInstances = [];
  updateAtoms(1.0);
  clearForceSpinHighlight();
  announceHighlightCleared();
}

// Force/spin arrows are drawn once per SOURCE atom, never once per periodic
// image (ForceModule.js/SpinModule.js's `seen` de-dupe in their build loop),
// unlike the atoms mesh — so highlighting them needs each instance id
// resolved back to its source atom first.
function sourceIndicesForInstances(instanceIds) {
  const srcIndexArr = fileBrowser.selectedStructure?.periodic?.visibleWrapped?.srcIndex;
  const unique = new Set();
  instanceIds.forEach((id) => unique.add(srcIndexArr ? srcIndexArr[id] : id));
  return [...unique];
}

// Glows an arrow instance the same way a selected atom/bond glows — sets
// instanceEmissive/instanceEmissiveIntensity only, leaving instanceColor (and
// so the arrow's real colormap-driven or userColor color) untouched.
function setArrowEmissiveGlow(shaftMesh, tipMesh, arrowIndices) {
  if (arrowIndices == null || !shaftMesh || !tipMesh) return;
  const shaftEmissive = shaftMesh.geometry.attributes.instanceEmissive;
  const shaftIntensity = shaftMesh.geometry.attributes.instanceEmissiveIntensity;
  const tipEmissive = tipMesh.geometry.attributes.instanceEmissive;
  const tipIntensity = tipMesh.geometry.attributes.instanceEmissiveIntensity;
  if (!shaftEmissive || !shaftIntensity || !tipEmissive || !tipIntensity) return;

  const { r, g, b } = HIGHLIGHT_EMISSIVE;
  // One atom owns one arrow per periodic image it is drawn at (SpinModule.js /
  // ForceModule.js keep the list), so every copy lights up together.
  for (const arrowIndex of (Array.isArray(arrowIndices) ? arrowIndices : [arrowIndices])) {
    shaftEmissive.setXYZ(arrowIndex * 2, r, g, b);
    shaftEmissive.setXYZ(arrowIndex * 2 + 1, r, g, b);
    shaftIntensity.setX(arrowIndex * 2, HIGHLIGHT_EMISSIVE_INTENSITY);
    shaftIntensity.setX(arrowIndex * 2 + 1, HIGHLIGHT_EMISSIVE_INTENSITY);
    tipEmissive.setXYZ(arrowIndex, r, g, b);
    tipIntensity.setX(arrowIndex, HIGHLIGHT_EMISSIVE_INTENSITY);
  }

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
  if (measurePaused) return;
  if (atomSelection.selectedAtoms.length) {
    applyAtomHighlightIndices(atomSelection.selectedAtoms.flatMap((atom) => instancesForSelectedAtom(atom)));
  }
}

/**
 * Highlights the arrows the current override targets — one per periodic image
 * the atom is drawn at — if any of the given ATOM INSTANCE ids resolve to its
 * source atom. The arrow counterpart of applyAtomHighlightIndices's own atom
 * glow, called right alongside it.
 */
function applyForceSpinHighlightForInstances(instanceIds) {
  if (!arrowHighlightOverride) return;
  const { atomIndex, kind } = arrowHighlightOverride;
  if (!sourceIndicesForInstances(instanceIds).includes(atomIndex)) return;

  if (kind === 'force') {
    setArrowEmissiveGlow(groups.forcesShaftMesh, groups.forcesTipMesh, groups.forcesInstancesBySrcIndex?.get(atomIndex));
  } else {
    setArrowEmissiveGlow(groups.spinShaftMesh, groups.spinTipMesh, groups.spinsInstancesBySrcIndex?.get(atomIndex));
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
  if (isTracerPipelineActive()) {
    clearBondEmissiveOnly();
    announceHighlightCleared();
    return;
  }
  highlightHover.currentlyHighlightedBondInstances = [];
  updateBonds(1.0);
  announceHighlightCleared();
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
  clearPolyhedraMultiHighlight();
}

export function applyAtomHighlightIndices(indices) {
  clearHighlightAtom();

  if (!groups.atomsMesh || !indices.length) {
    highlightHover.currentlyHighlightedAtomInstances = [];
    return;
  }
  paintAtomHighlight(indices);
}

/** Paint the glow onto these instances, on top of whatever the atoms show
 *  now — no clearing first (applyAtomHighlightIndices clears). */
function paintAtomHighlight(indices) {
  // Normally every selected atom's sphere glows. The one exception: while
  // the Structure Info panel's Spin/Force editor is open for an atom
  // (arrowHighlightOverride), that atom's sphere is skipped here in favor of
  // its arrow, highlighted below by applyForceSpinHighlightForInstances.
  // Under a tracer, SKIP the setColorAt recolor: it bumps instanceColor.version,
  // which the SceneEncoder hashes into its fingerprint → a re-encode + hardReset
  // (accumulation restart). Keep the emissive attr writes (unhashed; they make
  // the raster preview / not-yet-traced frames glow) and record the instances so
  // clearAtomEmissiveOnly() and the tracer overlay can find them.
  const tracer = isTracerPipelineActive();
  let atomsChanged = false;
  indices.forEach((index) => {
    const srcIdx = sourceIndicesForInstances([index])[0];
    if (arrowHighlightOverride && arrowHighlightOverride.atomIndex === srcIdx) return;

    groups.atomsMesh.geometry.attributes.instanceEmissive.setXYZ(index, 1, 0.549, 0);
    groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.setX(index, 2.0);
    if (!tracer) groups.atomsMesh.setColorAt(index, ATOM_HIGHLIGHT_COLOR);
    atomsChanged = true;
  });

  if (atomsChanged) {
    groups.atomsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
    groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
    if (!tracer) groups.atomsMesh.instanceColor.needsUpdate = true;
  }
  highlightHover.currentlyHighlightedAtomInstances = indices.slice();

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
// While a colour editor has the glow off (suppressSelectionHighlightFor3D),
// a rebuild of the atoms mesh must not bring it back (carrySelectionAcross-
// Rebuild below); restoreSelectionHighlight or a new selection ends it.
let glowSuppressed = false;

// While a measure tool is on (ui/MeasurementToolbar.js setMeasureMode) the
// selection's glow is off: the atoms a measurement picks glow instead, and
// the selection's glow comes back when the tool is turned off. The selection
// itself is kept throughout (rows, inspectors); every path that would put its
// glow back — a new selection, a rebuild of the atoms mesh, a colour editor
// closing — waits for the tool to be turned off.
let measurePaused = false;

/**
 * The atoms were just refreshed in place (render updateAtoms, which turns
 * every glow off — core/crystal-viewer.js updateVisualization's non-rebuild
 * path, after a colour, alpha or size edit, a panel refresh, ...): paint the
 * selection's glow back on, unless a colour editor or a measure tool has it
 * off on purpose. Paint only, on the atoms as refreshed: going through
 * applyAtomHighlightIndices would refresh them again at full opacity.
 * (A rebuild of the mesh carries the glow over itself, carrySelectionAcrossRebuild.)
 */
export function repaintSelectionGlow() {
  if (glowSuppressed || measurePaused || !groups.atomsMesh || !atomSelection.selectedAtoms.length) return;
  if (selectionViewTab !== 'atoms') { paintSelectionView(); return; }
  paintAtomHighlight(atomSelection.selectedAtoms.flatMap((atom) => instancesForSelectedAtom(atom)));
}

/** A measure tool was turned on: take the selection's glow off. */
export function pauseSelectionGlowForMeasure() {
  if (measurePaused) return;
  measurePaused = true;
  clearHighlightAtom();
  clearHighlightBond();
  clearViewPolyhedraGlow();
}

/** The measure tool was turned off: the selection glows again (unless a
 *  colour editor still has it off, suppressSelectionHighlightFor3D). */
export function resumeSelectionGlowAfterMeasure() {
  if (!measurePaused) return;
  measurePaused = false;
  if (!glowSuppressed) restoreSelectionHighlight();
}

export function suppressSelectionHighlightFor3D() {
  glowSuppressed = true;
  clearHighlightAtom();
  clearHighlightBond();
  clearViewPolyhedraGlow();
}

/** Undo suppressSelectionHighlightFor3D(): reapplies the 3D glow for the
 *  current atom or bond selection. */
export function restoreSelectionHighlight() {
  glowSuppressed = false;
  if (measurePaused) return; // back when the measure tool is turned off
  if (atomSelection.selectedAtoms.length && selectionViewTab !== 'atoms') {
    paintSelectionView();
  } else if (atomSelection.selectedAtoms.length) {
    applyAtomHighlightIndices(atomSelection.selectedAtoms.flatMap((atom) => instancesForSelectedAtom(atom)));
  } else if (highlightHover.currentlyHighlightedBond) {
    highlightBondIn3D(highlightHover.currentlyHighlightedBond.instanceIds);
  }
}

export function highlightBondIn3D(indexList) {
  clear3DHighlights();

  // Under a tracer, SKIP setColorAt (fingerprint bump / accumulation restart) —
  // see applyAtomHighlightIndices. Emissive attr writes are kept and the
  // instances recorded for clearBondEmissiveOnly() + the tracer overlay.
  const tracer = isTracerPipelineActive();
  indexList.forEach((index) => {
    groups.bondsMesh.geometry.attributes.instanceEmissive.setXYZ(index, 1, 0.549, 0);
    groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity.setX(index, 2.0);
    if (!tracer) groups.bondsMesh.setColorAt(index, ATOM_HIGHLIGHT_COLOR);
  });

  groups.bondsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  if (!tracer) groups.bondsMesh.instanceColor.needsUpdate = true;
  highlightHover.currentlyHighlightedBondInstances = indexList.slice();
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
  if (directSelection.kind === 'bonds') resetDirectSelection();
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
  // BondLengthPanel.js). We expand programmatically here, so ensure they exist
  // and that a long list shows the page holding this bond.
  if (/** @type {any} */ (bondsContainer)._showBondRow) /** @type {any} */ (bondsContainer)._showBondRow(key, groupKey);
  else /** @type {any} */ (bondsContainer)._populateBondRows?.();

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
  directSelection = { kind: 'bonds', bonds: memberIndexes.slice(), polyKeys: [] };
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
  if (directSelection.kind === 'polyhedra' && !directApplying) resetDirectSelection();
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

  // Rows are populated lazily on first expand (see PolyhedraListPanel.js); a
  // long list shows the page holding this polyhedron.
  if (/** @type {any} */ (listContainer)._showPolyhedronRow) /** @type {any} */ (listContainer)._showPolyhedronRow(key, groupKey);
  else /** @type {any} */ (listContainer)._populatePolyhedronRows?.();

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
  if (!directApplying) directSelection = { kind: 'polyhedra', bonds: [], polyKeys: linking ? meshes.map((m) => m.userData.key) : [key] };

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

/** External→3D: glow a single polyhedron by key WITHOUT opening the Structure
 *  panel or scrolling to a row (openPanel is omitted). The Polyhedron
 *  Inspector's double-click uses this to point back at the polyhedron it is
 *  showing. Idempotent: if that polyhedron is already the selection this is a
 *  no-op (it stays glowing) rather than toggling off — double-clicking to
 *  highlight must not clear the very selection driving the inspector. */
export function highlightPolyhedronByKey(key, catKey = null) {
  const linking = general.linkPeriodicCopies !== false;
  const cur = highlightHover.currentlyHighlightedPolyhedron;
  const alreadySelected = cur
    && (linking ? cur.groupKey === polyhedronGroupKey(key) : cur.key === key);
  if (alreadySelected) return;
  const resolvedCat = catKey ?? findPolyhedronMesh(key)?.userData?.catKey;
  selectPolyhedronByKey(key, resolvedCat, {});
}

// =============================================
// SELECTION VIEWS — the selection bar's Atoms | Bonds | Polyhedra tabs
// =============================================
// The atom selection stays THE selection; the view says which set derived
// from it glows in the 3D view and which the bar's bulk controls edit:
//   atoms      the selected atoms (the usual glow)
//   bonds      the bonds whose two ends are selected copies — with "Link
//              periodic copies" every copy of a selected atom counts, so the
//              copies of those bonds glow too
//   polyhedra  the polyhedra centred on a selected atom, and the cages whose
//              corners are all selected
// A saved selection group (ui/StructureInfoPanel/SelectionGroups.js) can bring
// its own bond / polyhedron sets (viewExplicit); they hold until the atom
// selection changes, then the sets derive from the atoms again. Switching the
// view never changes the atom selection, so Atoms brings the atom glow back.
let selectionViewTab = 'atoms';
let viewBondIndexes = [];   // structure.bonds indexes glowing in the bonds view
let viewPolyMeshes = [];    // polyhedron meshes glowing in the polyhedra view
let viewExplicit = null;    // { bonds: number[], polyhedra: mesh[] } from a restored group

export const SELECTION_VIEW_CHANGED = 'crysviz:selection-view-changed';

/** The active view: 'atoms' | 'bonds' | 'polyhedra' (a bond or polyhedron
 *  set picked in the 3D view counts as its own kind). */
export function getSelectionView() {
  return directSelection.kind ?? selectionViewTab;
}

/** The three sets of the selection: atoms (instance ids), bonds
 *  (structure.bonds indexes) and polyhedra (meshes) — the active kind's own
 *  set and the two derived from it. */
export function getSelectionViewSets() {
  if (directSelection.kind) {
    const atoms = directAtomInstances();
    const selected = atoms.map((instanceId) => buildSelectionAtomFromHit({ instanceId, object: groups.atomsMesh })).filter(Boolean);
    return {
      atoms,
      bonds: directSelection.kind === 'bonds' ? directSelection.bonds.slice() : bondsAmongSelection(selected),
      polyhedra: directSelection.kind === 'polyhedra' ? directPolyMeshes() : polyhedraAmongSelection(selected),
    };
  }
  return {
    atoms: atomSelection.selectedAtoms.flatMap((atom) => instancesForSelectedAtom(atom)),
    bonds: selectionViewTab === 'bonds' ? viewBondIndexes.slice() : (viewExplicit?.bonds ?? bondsAmongSelection()),
    polyhedra: selectionViewTab === 'polyhedra' ? viewPolyMeshes.slice() : (viewExplicit?.polyhedra ?? polyhedraAmongSelection()),
  };
}

/** Indexes into structure.bonds of the bonds between the selected atoms
 *  (both ends selected copies; every copy with "Link periodic copies"). */
export function bondsAmongSelection(selected = atomSelection.selectedAtoms) {
  const structure = fileBrowser.selectedStructure;
  const bonds = structure?.bonds ?? [];
  if (!selected.length || !bonds.length) return [];
  const instances = new Set(selected.flatMap((atom) => instancesForSelectedAtom(atom)));
  const out = [];
  bonds.forEach((b, i) => {
    const idx = b.indices;
    if (idx && instances.has(idx[0]) && instances.has(idx[1]) && b.instanceIds?.length) out.push(i);
  });
  return out;
}

/** The drawn polyhedron meshes centred on a selected atom, plus the cages
 *  whose corners are all selected. */
export function polyhedraAmongSelection(selected = atomSelection.selectedAtoms) {
  const structure = fileBrowser.selectedStructure;
  const meshes = groups.polyhedraGroup?.children ?? [];
  if (!selected.length || !meshes.length) return [];
  const sources = new Set(selected.map((atom) => atom.sourceIndex));
  const out = [];
  for (const mesh of meshes) {
    const ud = mesh.userData;
    if (ud?.type !== 'polyhedron' || !mesh.visible || !mesh.material?.emissive) continue;
    if (Number.isInteger(ud.centerSrcIndex) && sources.has(ud.centerSrcIndex)) { out.push(mesh); continue; }
    const poly = structure?.polyhedra?.polyhedra?.[ud.polyIndex];
    const corners = poly?.vertexSrcList;
    if (corners?.length && corners.every((src) => sources.has(src))) out.push(mesh);
  }
  return out;
}

function clearViewPolyhedraGlow() {
  for (const mesh of viewPolyMeshes) {
    if (mesh?.material?.emissive) {
      mesh.material.emissive.set(0x000000);
      mesh.material.emissiveIntensity = 1;
    }
  }
  viewPolyMeshes = [];
  highlightHover.currentlyHighlightedPolyMeshes = [];
}

/** Glow the active view's set (the atoms' own glow is off in the other two). */
function paintSelectionView() {
  if (selectionViewTab === 'atoms' || glowSuppressed || measurePaused) return;
  clearHighlightAtom();
  clearHighlightBond();
  clearViewPolyhedraGlow();
  const structure = fileBrowser.selectedStructure;
  if (selectionViewTab === 'bonds') {
    viewBondIndexes = (viewExplicit?.bonds ?? bondsAmongSelection()).filter((i) => structure?.bonds?.[i]);
    const ids = viewBondIndexes.flatMap((i) => structure.bonds[i].instanceIds ?? []);
    if (ids.length && groups.bondsMesh) highlightBondIn3D(ids);
  } else {
    viewPolyMeshes = (viewExplicit?.polyhedra ?? polyhedraAmongSelection()).filter((m) => m?.material?.emissive);
    for (const mesh of viewPolyMeshes) {
      mesh.material.emissive.set(0xFF8C00);
      mesh.material.emissiveIntensity = 1.0;
    }
    // the tracers / raster ghost overlay read the meshes from here
    highlightHover.currentlyHighlightedPolyMeshes = viewPolyMeshes.slice();
  }
}

function resetSelectionView() {
  if (selectionViewTab !== 'atoms') clearHighlightBond();
  clearViewPolyhedraGlow();
  viewBondIndexes = [];
  viewExplicit = null;
  if (selectionViewTab !== 'atoms') {
    selectionViewTab = 'atoms';
    document.dispatchEvent(new CustomEvent(SELECTION_VIEW_CHANGED, { detail: { tab: 'atoms' } }));
  }
}

/**
 * Switch the selection's view. `explicit` (a restored group's own sets:
 * { bonds: structure.bonds indexes, polyhedra: meshes }) replaces the derived
 * sets until the atom selection changes.
 * @param {'atoms'|'bonds'|'polyhedra'} tab
 */
export function setSelectionView(tab, { explicit = null } = {}) {
  if (!['atoms', 'bonds', 'polyhedra'].includes(tab)) return;
  if (directSelection.kind) {
    // A picked bond/polyhedron set: the tab converts it to the derived set
    // of that kind (Atoms: the end / corner atoms become the atom selection).
    if (tab === directSelection.kind) return;
    const sets = getSelectionViewSets();
    if (tab === 'atoms') selectAtomsByInstances(sets.atoms, { reason: 'selection-tab' });
    else if (tab === 'bonds') selectBondsDirect(sets.bonds, { mode: 'replace', keepEmpty: true });
    else selectPolyhedraDirect(sets.polyhedra.map((m) => m.userData?.key).filter(Boolean), { mode: 'replace', keepEmpty: true });
    return;
  }
  const changed = tab !== selectionViewTab;
  selectionViewTab = tab;
  if (explicit) viewExplicit = explicit;
  clearHighlightBond();
  clearViewPolyhedraGlow();
  viewBondIndexes = [];
  if (tab === 'atoms') {
    if (!glowSuppressed && !measurePaused && atomSelection.selectedAtoms.length) {
      applyAtomHighlightIndices(atomSelection.selectedAtoms.flatMap((atom) => instancesForSelectedAtom(atom)));
    }
  } else {
    paintSelectionView();
  }
  if (changed) document.dispatchEvent(new CustomEvent(SELECTION_VIEW_CHANGED, { detail: { tab } }));
}

/** Re-glow the active view after a bond/polyhedra rebuild (instance ids and
 *  meshes are new). */
export function repaintSelectionView() {
  if (directSelection.kind) { paintDirectSelection(); return; }
  if (selectionViewTab !== 'atoms' && atomSelection.selectedAtoms.length) paintSelectionView();
}

// =============================================
// DIRECT BOND / POLYHEDRON SELECTIONS — picked in the 3D view
// =============================================
// A double-click on a bond or a polyhedron selects it (as before: one, with
// its row); Shift+double-click adds another of the same kind, Ctrl/⌘ toggles
// one. The set is the selection then — no atoms are selected — and the
// selection bar shows it under its own tab with bulk edits and Save. With
// "Link periodic copies" a pick means the whole group of copies. The other
// tabs convert it: Atoms selects the bonds' ends / the polyhedra's centres
// and corners, Bonds / Polyhedra the sets derived from those atoms.
let directSelection = { kind: /** @type {null|'bonds'|'polyhedra'} */ (null), bonds: /** @type {number[]} */ ([]), polyKeys: /** @type {string[]} */ ([]) };
let directApplying = false; // guards the clear hooks while a direct set is (re)applied

/** The picked bond/polyhedron set: kind null when the selection is atoms. */
export function getDirectSelection() {
  return { kind: directSelection.kind, bonds: directSelection.bonds.slice(), polyKeys: directSelection.polyKeys.slice() };
}

function resetDirectSelection() {
  if (!directSelection.kind) return;
  const kind = directSelection.kind;
  directSelection = { kind: null, bonds: [], polyKeys: [] };
  if (kind === 'bonds') clearHighlightBond();
  else clearViewPolyhedraGlow();
  document.dispatchEvent(new CustomEvent(SELECTION_VIEW_CHANGED, { detail: { tab: selectionViewTab } }));
}

function bondMembers(structure, bondIndex) {
  const bond = structure?.bonds?.[bondIndex];
  if (!bond) return [];
  if (general.linkPeriodicCopies === false) return [bondIndex];
  const key = bondGroupKey(structure, bond);
  return structure.bonds.reduce((acc, b, i) => { if (bondGroupKey(structure, b) === key) acc.push(i); return acc; }, []);
}

function polyMemberKeys(key) {
  if (general.linkPeriodicCopies === false) return findPolyhedronMesh(key) ? [key] : [];
  return findPolyhedronGroupMeshes(polyhedronGroupKey(key)).map((m) => m.userData.key);
}

function directPolyMeshes() {
  return directSelection.polyKeys.map((k) => findPolyhedronMesh(k)).filter((m) => m?.material?.emissive);
}

/** Atom instances of the picked set: the bonds' two ends, or each
 *  polyhedron's centre and corners (their copies, when linked). */
function directAtomInstances() {
  const structure = fileBrowser.selectedStructure;
  const out = new Set();
  if (directSelection.kind === 'bonds') {
    for (const i of directSelection.bonds) {
      const idx = structure?.bonds?.[i]?.indices;
      if (idx) { out.add(idx[0]); out.add(idx[1]); }
    }
  } else if (directSelection.kind === 'polyhedra') {
    const linked = general.linkPeriodicCopies !== false;
    const addSource = (src) => {
      const images = structure?.atomImages?.[src];
      if (!images?.length) return;
      if (linked) images.forEach((i) => out.add(i)); else out.add(images[0]);
    };
    for (const mesh of directPolyMeshes()) {
      const ud = mesh.userData;
      if (Number.isInteger(ud.centerSrcIndex)) addSource(ud.centerSrcIndex);
      for (const src of structure?.polyhedra?.polyhedra?.[ud.polyIndex]?.vertexSrcList ?? []) addSource(src);
    }
  }
  return [...out].filter((i) => Number.isInteger(i));
}

/** Union / difference of member groups for the three pick modes. */
function combineDirect(current, members, mode) {
  if (mode === 'add') return [...new Set([...current, ...members])];
  if (mode === 'toggle') {
    const allIn = members.length && members.every((m) => current.includes(m));
    return allIn ? current.filter((m) => !members.includes(m)) : [...new Set([...current, ...members])];
  }
  // replace: picking exactly the current set again deselects it
  const same = current.length === members.length && members.every((m) => current.includes(m));
  return same ? [] : members;
}

function paintDirectSelection() {
  if (glowSuppressed || measurePaused) return;
  const structure = fileBrowser.selectedStructure;
  if (directSelection.kind === 'bonds') {
    const ids = directSelection.bonds.flatMap((i) => structure?.bonds?.[i]?.instanceIds ?? []);
    if (ids.length && groups.bondsMesh) highlightBondIn3D(ids);
  } else if (directSelection.kind === 'polyhedra') {
    clearViewPolyhedraGlow();
    viewPolyMeshes = directPolyMeshes();
    for (const mesh of viewPolyMeshes) {
      mesh.material.emissive.set(0xFF8C00);
      mesh.material.emissiveIntensity = 1.0;
    }
    highlightHover.currentlyHighlightedPolyMeshes = viewPolyMeshes.slice();
  }
}

/**
 * Select bonds picked in the 3D view (structure.bonds indexes; each stands
 * for its group of copies when linked).
 * @param {number[]} bondIndexes
 * @param {{mode?: 'replace'|'add'|'toggle', scrollToSelection?: boolean, keepEmpty?: boolean}} [options]
 */
export function selectBondsDirect(bondIndexes, { mode = 'replace', scrollToSelection = false, keepEmpty = false } = {}) {
  const structure = fileBrowser.selectedStructure;
  if (!structure?.bonds) return;
  const members = [...new Set((bondIndexes ?? []).flatMap((i) => bondMembers(structure, i)))]
    .filter((i) => structure.bonds[i]?.instanceIds?.length);
  const current = directSelection.kind === 'bonds' ? directSelection.bonds : [];
  const next = combineDirect(current, members, mode);
  if (!next.length && !keepEmpty && !current.length) return;
  directApplying = true;
  clearSelectedAtoms({ reason: 'bond-select' });
  clearPolyhedronSelection();
  clearViewPolyhedraGlow();
  clearHighlightBond();
  clearUIHighlight();
  highlightHover.currentlyHighlightedBond = null;
  directApplying = false;
  if (!next.length) { resetDirectSelection(); directSelection = { kind: null, bonds: [], polyKeys: [] }; document.dispatchEvent(new CustomEvent(SELECTION_VIEW_CHANGED, { detail: { tab: 'atoms' } })); return; }
  directSelection = { kind: 'bonds', bonds: next, polyKeys: [] };
  // Exactly one bond (its copies): the classic single selection, with its row
  // in the Bonds tab, so the panel and the inspectors follow as before.
  const oneGroup = next.length === bondMembers(structure, next[0]).length && next.every((i) => bondMembers(structure, next[0]).includes(i));
  if (oneGroup) {
    const bond = structure.bonds[next[0]];
    const linking = general.linkPeriodicCopies !== false;
    const instanceIds = next.flatMap((i) => structure.bonds[i].instanceIds ?? []);
    highlightBondIn3D(instanceIds);
    highlightHover.currentlyHighlightedBond = {
      bondIndex: next[0], key: bondKey(bond.indices), pair: bondPairKeyOf(bond), instanceIds,
      groupKey: linking ? bondGroupKey(structure, bond) : null, bondIndexes: linking ? next.slice() : null,
    };
    collapseAllAtomExpansions();
    const row = findBondRow(highlightHover.currentlyHighlightedBond.pair, highlightHover.currentlyHighlightedBond.key,
      highlightHover.currentlyHighlightedBond.groupKey);
    if (row) {
      highlightAtomRow(row);
      if (scrollToSelection) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else {
    paintDirectSelection();
  }
  document.dispatchEvent(new CustomEvent(SELECTION_VIEW_CHANGED, { detail: { tab: 'bonds' } }));
}

/** 3D pick: the bond owning a bond-half instance, with the pick's modifiers.
 *  @param {number} instanceId
 *  @param {{mode?: 'replace'|'add'|'toggle', scrollToSelection?: boolean}} [options] */
export function selectBondsDirectFromInstance(instanceId, { mode = 'replace', scrollToSelection = true } = {}) {
  const mapping = fileBrowser.selectedStructure?.bondObjectMapping?.[instanceId];
  if (!mapping) return;
  selectBondsDirect([mapping[0]], { mode, scrollToSelection });
}

/**
 * Select polyhedra picked in the 3D view (stable keys; each stands for its
 * group of copies when linked).
 * @param {string[]} keys
 * @param {{mode?: 'replace'|'add'|'toggle', scrollToSelection?: boolean, keepEmpty?: boolean}} [options]
 */
export function selectPolyhedraDirect(keys, { mode = 'replace', scrollToSelection = false, keepEmpty = false } = {}) {
  const members = [...new Set((keys ?? []).flatMap((k) => polyMemberKeys(k)))];
  const current = directSelection.kind === 'polyhedra' ? directSelection.polyKeys : [];
  const next = combineDirect(current, members, mode);
  if (!next.length && !keepEmpty && !current.length) return;
  directApplying = true;
  clearSelectedAtoms({ reason: 'polyhedron-select' });
  clearBondSelection();
  clearPolyhedronSelection();
  clearViewPolyhedraGlow();
  directApplying = false;
  if (!next.length) { directSelection = { kind: null, bonds: [], polyKeys: [] }; document.dispatchEvent(new CustomEvent(SELECTION_VIEW_CHANGED, { detail: { tab: 'atoms' } })); return; }
  directSelection = { kind: 'polyhedra', bonds: [], polyKeys: next };
  const oneGroup = next.length === polyMemberKeys(next[0]).length && next.every((k) => polyMemberKeys(next[0]).includes(k));
  if (oneGroup) {
    // the classic single selection: its row, the Polyhedron Inspector's event
    const mesh = findPolyhedronMesh(next[0]);
    directApplying = true;
    selectPolyhedronByKey(next[0], mesh?.userData?.catKey, { openPanel: true, scrollToSelection });
    directApplying = false;
    if (!highlightHover.currentlyHighlightedPolyhedron) directSelection = { kind: null, bonds: [], polyKeys: [] };
  } else {
    paintDirectSelection();
  }
  document.dispatchEvent(new CustomEvent(SELECTION_VIEW_CHANGED, { detail: { tab: directSelection.kind ?? 'atoms' } }));
}

// ---- multi-polyhedron highlight (a histogram bin → many polyhedra at once) ----
// Kept separate from the single-select currentlyHighlightedPolyhedron above:
// this glows an arbitrary SET of polyhedra with no panel-row / selection
// semantics, the polyhedra analogue of highlightAtomsIn3D / highlightBondIn3D.
let highlightedPolyhedraMeshes = [];

function clearPolyhedraMultiHighlight() {
  for (const mesh of highlightedPolyhedraMeshes) {
    if (mesh?.material?.emissive) {
      mesh.material.emissive.set(0x000000);
      mesh.material.emissiveIntensity = 1;
    }
  }
  highlightedPolyhedraMeshes = [];
}

/**
 * Glow every polyhedron whose key is in `keys` (expanding each to its
 * periodic-image copies when "Link periodic copies" is on, same as the
 * single-select path). Clears any atom/bond/single-polyhedron selection first
 * and opens no panel — used by the volume histogram's click-to-highlight.
 */
export function highlightPolyhedraIn3D(keys) {
  clearSelectedAtoms({ reason: 'polyhedron-multi-select' });
  clearBondSelection();
  clearPolyhedronSelection();
  clearPolyhedraMultiHighlight();
  const linking = general.linkPeriodicCopies !== false;
  const seen = new Set();
  for (const key of keys ?? []) {
    const meshes = linking
      ? findPolyhedronGroupMeshes(polyhedronGroupKey(key))
      : [findPolyhedronMesh(key)].filter(Boolean);
    for (const mesh of meshes) {
      if (!mesh || seen.has(mesh) || !mesh.material?.emissive) continue;
      seen.add(mesh);
      mesh.material.emissive.set(0xFF8C00);
      mesh.material.emissiveIntensity = 1.0;
      highlightedPolyhedraMeshes.push(mesh);
    }
  }
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

// `reveal` false skips opening the panel / switching its tab entirely — used
// by a Shift-add 3D pick (building a multi-atom selection for e.g. the
// Planes panel's best-fit-plane calculation), which should still glow the
// atom in 3D but must not yank focus to the Structure panel on every click.
function ensureAtomPanelVisible(targetMode, targetPanelId, reveal = true) {
  const composition = document.getElementById('composition');
  if (!composition) return null;
  if (!reveal) return composition;

  setStructurePanelOpen(true);

  const panelSwitch = document.getElementById('atomBondControlSwitch');
  panelSwitch?.querySelectorAll('button').forEach((btn) => {
    btn.classList.remove('active');
  });
  panelSwitch?.querySelector(`button[data-mode="${targetMode}"]`)?.classList.add('active');
  showPanel(targetPanelId);
  return composition;
}

function findAtomRow(element, sourceIndex, instanceId = null, revealPanel = true) {
  const {targetAtomIndex, targetPanelId, targetMode} = getTargetAtomDetails(sourceIndex);
  const composition = ensureAtomPanelVisible(targetMode, targetPanelId, revealPanel);
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
  // By class, not `.comp-left span:last-child` - the latter matches the
  // visibility toggle's inner <span class="toggle_slider"> and rotates it.
  const expandIcon = targetContainer.querySelector('.comp-expand-icon');
  if (!atomsContainer) return null;

  // Individual atom rows are populated lazily on first expand (see
  // CompositionRow.js). We expand programmatically here, so ensure they exist.
  // A long list shows one page of rows (components/PagedRows.js): open it on
  // the atom's page — only when revealing, so a modifier pick leaves it alone.
  if (revealPanel && /** @type {any} */ (atomsContainer)._showAtomRow) {
    /** @type {any} */ (atomsContainer)._showAtomRow(targetAtomIndex, instanceId);
  } else {
    /** @type {any} */ (atomsContainer)._populateAtomRows?.();
  }

  // Only force the row list open when the caller actually wants the panel
  // revealed — a Shift-add pick still highlights the row once expanded
  // manually, it just doesn't un-collapse the list on its own.
  if (revealPanel && atomsContainer.style.display === 'none') {
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

  const revealPanel = options.revealPanel !== false;
  /** @type {any} */
  let lastRow = null;
  atomSelection.selectedAtoms.forEach((atom) => {
    const row = findAtomRow(atom.element, atom.sourceIndex, atom.instanceId, revealPanel);
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
  // The selection changed: a restored group's own bond/polyhedron sets no
  // longer apply (the view derives them from the atoms again).
  viewExplicit = null;
  // Measuring: the rows follow the selection, the 3D glow waits (measurePaused).
  if (!measurePaused) {
    if (selectionViewTab === 'atoms') applyAtomHighlightIndices(atomSelection.selectedAtoms.flatMap((atom) => instancesForSelectedAtom(atom)));
    else paintSelectionView();
  }
  syncSelectedAtomRows(options);
}

function buildSelectionAtomFromHit(hit) {
  if (!hit || hit.instanceId === undefined || hit.instanceId === null) {
    return null;
  }

  const wrapped = fileBrowser.selectedStructure?.periodic?.visibleWrapped;
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
  glowSuppressed = false; // the glow is applied again just below
  resetDirectSelection(); // an atom selection replaces a picked bond/polyhedron set
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
  resetSelectionView();
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
        { scrollToLast: false, revealPanel: options.revealPanel },
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
    { scrollToLast: options.scrollToSelection, revealPanel: options.revealPanel },
  );
}

/**
 * Batch-add many atoms to the current selection at once, given their mesh
 * INSTANCE ids (e.g. every atom a marquee rectangle covers). One commit for
 * the whole set — a per-hit loop would re-sync highlights and rebuild the
 * panel rows N times. Additive only (never replaces or toggles): instances
 * already selected are skipped, and with "Link periodic copies" on, images of
 * the same source atom collapse to a single selection entry (sameSelectionAtom).
 * Reveals/scrolls nothing by default so a shift-drag stays in the 3D view.
 */
export function addAtomsToSelectionByInstances(instanceIds, options = {}) {
  if (!instanceIds?.length || !groups.atomsMesh) return snapshotSelectedAtoms();

  const previousSelection = snapshotSelectedAtoms();
  const nextSelection = atomSelection.selectedAtoms.map(cloneSelectionAtom);
  const addedAtoms = [];

  for (const instanceId of instanceIds) {
    const selectionAtom = buildSelectionAtomFromHit({ instanceId, object: groups.atomsMesh });
    if (!selectionAtom) continue;
    if (nextSelection.some((atom) => sameSelectionAtom(atom, selectionAtom))) continue;
    nextSelection.push(selectionAtom);
    addedAtoms.push(selectionAtom);
  }

  if (!addedAtoms.length) return previousSelection;

  return commitSelection(
    reindexSelection(nextSelection),
    {
      action: 'selected',
      atom: null,
      atoms: addedAtoms.map(cloneSelectionAtom),
      addedAtoms: addedAtoms.map(cloneSelectionAtom),
      removedAtoms: [],
      modifiers: getEventModifiers(options.sourceEvent),
      sourceEvent: options.sourceEvent ?? null,
      reason: options.reason ?? 'marquee',
    },
    { scrollToLast: false, revealPanel: options.revealPanel ?? false },
  );
}

/**
 * The atom selection in a form that outlives the current mesh: each selected
 * atom's source index and on-screen copy. The Files list keeps one per
 * structure row (ui/FileBrowswerPanel.js), so switching structures neither
 * carries one structure's atoms over to another — the same instance numbers
 * are different atoms there — nor loses them when switching back.
 * @returns {Array<{sourceIndex: number, instanceId: number}>}
 */
export function captureSelectionSnapshot() {
  return atomSelection.selectedAtoms.map((a) => ({ sourceIndex: a.sourceIndex, instanceId: a.instanceId }));
}

/**
 * Restore a snapshot taken on the now-active structure (captureSelectionSnapshot),
 * or clear the selection when there is none. Each atom comes back as the same
 * copy if that copy is still displayed, otherwise as its first copy.
 * @param {Array<{sourceIndex: number, instanceId: number}>|null|undefined} snapshot
 */
export function restoreSelectionSnapshot(snapshot, { reason = 'structure-switch' } = {}) {
  const structure = fileBrowser.selectedStructure;
  const src = structure?.periodic?.visibleWrapped?.srcIndex;
  const ids = (snapshot ?? []).map(({ sourceIndex, instanceId }) => {
    if (src ? src[instanceId] === sourceIndex : instanceId === sourceIndex) return instanceId;
    return structure?.atomImages?.[sourceIndex]?.[0];
  }).filter((i) => Number.isInteger(i));
  if (!ids.length) {
    clearSelectedAtoms({ reason });
    return;
  }
  selectAtomsByInstances(ids, { reason });
}

/**
 * rebuildAtoms() replaced the main atoms mesh (render/atomsRebuildHook.js):
 * Neighbour Bonds, Show Periodic Images, the display boundary, Complete
 * Polyhedra, ... The selection entries still name the old mesh's instances,
 * whose glow went with it, and the new mesh may number the copies
 * differently. Each selected copy is found again by its source atom and
 * periodic offset; a copy no longer shown falls back to the atom's first
 * copy, and an atom no longer shown at all leaves the selection. Panels hear
 * of it only when something changed; otherwise the glow is just put back.
 * A rebuild for another structure (prevImageKeys null) is left alone: the
 * Files list restores that structure's own selection (restoreSelectionSnapshot).
 */
function carrySelectionAcrossRebuild({ prevMesh, prevImageKeys }) {
  if (!atomSelection.selectedAtoms.length || !prevImageKeys || !groups.atomsMesh) return;
  const structure = fileBrowser.selectedStructure;
  const byKey = new Map();
  (structure?.atomImageKeys ?? []).forEach((key, i) => { if (key != null && !byKey.has(key)) byKey.set(key, i); });
  const previous = snapshotSelectedAtoms();
  const next = [];
  let changed = false;
  for (const atom of atomSelection.selectedAtoms) {
    if (atom.object && atom.object !== prevMesh && atom.object !== groups.atomsMesh) {
      next.push(atom); // picked on some other mesh: not this rebuild's business
      continue;
    }
    const key = prevImageKeys[atom.instanceId];
    let id = key != null ? byKey.get(key) : undefined;
    if (id === undefined) id = structure?.atomImages?.[atom.sourceIndex]?.[0];
    const carried = id === undefined ? null : buildSelectionAtomFromHit({ instanceId: id, object: groups.atomsMesh });
    if (!carried || carried.sourceIndex !== atom.sourceIndex || next.some((a) => sameSelectionAtom(a, carried))) {
      changed = true;
      continue;
    }
    if (id !== atom.instanceId) changed = true;
    next.push(carried);
  }
  if (!changed) {
    atomSelection.selectedAtoms = reindexSelection(next);
    if (!glowSuppressed) syncSelectedAtomHighlights({ revealPanel: false });
    return;
  }
  const removedAtoms = previous.filter((a) => !next.some((b) => a.sourceIndex === b.sourceIndex));
  commitSelection(next, {
    action: 'replaced',
    atom: null,
    atoms: removedAtoms,
    addedAtoms: [],
    removedAtoms,
    modifiers: getEventModifiers(null),
    sourceEvent: null,
    reason: 'atoms-rebuilt',
  }, { scrollToLast: false, revealPanel: false });
}
onAtomsRebuilt(carrySelectionAcrossRebuild);

/**
 * Whatever is selected now (the atoms, or the one bond or polyhedron) in a
 * form that survives a rebuild of the Structure window's lists and a change
 * of "Link periodic copies" (reapplySelection).
 */
export function captureAnySelection() {
  const bond = highlightHover.currentlyHighlightedBond;
  const poly = highlightHover.currentlyHighlightedPolyhedron;
  return {
    atoms: captureSelectionSnapshot(),
    bondIndex: bond ? bond.bondIndex : null,
    poly: poly ? { key: poly.key, catKey: poly.catKey } : null,
  };
}

/**
 * Select again what captureAnySelection() kept, under the CURRENT "Link
 * periodic copies" setting: each atom stays the copy it was picked on (when
 * linking is switched on, copies of one atom merge into one entry, as a linked
 * pick would), and a bond or polyhedron becomes its group of copies, or its one
 * copy. Its row is marked in the rebuilt lists only when its tab is the one
 * shown, so this never switches tabs or opens the window.
 * @param {ReturnType<typeof captureAnySelection>} kept
 * @param {string} reason
 */
export function reapplySelection(kept, reason) {
  if (kept.atoms.length) {
    restoreSelectionSnapshot(kept.atoms, { reason });
  } else if (kept.bondIndex != null) {
    clearBondSelection();
    selectBondByIndex(kept.bondIndex, { openPanel: general.structurePanelMode === 'bonds' });
  } else if (kept.poly) {
    clearPolyhedronSelection();
    selectPolyhedronByKey(kept.poly.key, kept.poly.catKey, { openPanel: general.structurePanelMode === 'polyhedra' });
  }
}

/** Replace the current atom selection with a set of visible mesh instances.
 * Used by region-based tools that define a complete selection in one action. */
export function selectAtomsByInstances(instanceIds, options = {}) {
  if (!groups.atomsMesh) return snapshotSelectedAtoms();
  const previousSelection = snapshotSelectedAtoms();
  const nextSelection = [];
  for (const instanceId of instanceIds ?? []) {
    const selectionAtom = buildSelectionAtomFromHit({ instanceId, object: groups.atomsMesh });
    if (!selectionAtom || nextSelection.some((atom) => sameSelectionAtom(atom, selectionAtom))) continue;
    nextSelection.push(selectionAtom);
  }
  const removedAtoms = previousSelection
    .filter((atom) => !nextSelection.some((next) => sameSelectionAtom(atom, next)))
    .map(cloneSelectionAtom);
  const addedAtoms = nextSelection
    .filter((atom) => !previousSelection.some((previous) => sameSelectionAtom(atom, previous)))
    .map(cloneSelectionAtom);
  return commitSelection(reindexSelection(nextSelection), {
    action: previousSelection.length ? 'replaced' : 'selected',
    atom: null,
    atoms: [...addedAtoms, ...removedAtoms],
    addedAtoms,
    removedAtoms,
    modifiers: getEventModifiers(options.sourceEvent),
    sourceEvent: options.sourceEvent ?? null,
    reason: options.reason ?? 'batch',
  }, { scrollToLast: false, revealPanel: options.revealPanel ?? false });
}

/**
 * Panel→3D: select an atom from a click on its row in the Atoms/Wyckoff tab.
 * Runs through the same selection machinery as double-clicking the atom in the
 * 3D view (same modifier semantics: ctrl/cmd toggles, shift adds, plain click
 * replaces; clicking the sole selected atom deselects).
 */
export function selectAtomFromRow(atomIndex, sourceEvent = null, imageIndex = null) {
  const structure = fileBrowser.selectedStructure;
  // A Wyckoff-tab row stands for its whole orbit: select every atom of it.
  const orbit = imageIndex == null && structure?.symmetry?.mode === 'wyckoff'
    ? structure.symmetry.orbitGroups?.find((group) => group.representativeIndex === atomIndex)
    : null;
  if (orbit && orbit.atomIndices.length > 1) {
    selectOrbitFromRow(orbit, sourceEvent);
    return;
  }
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

/** selectAtomFromRow for a Wyckoff orbit row: the same modifier semantics,
 *  applied to the orbit's atoms together (a plain click on the row of the
 *  orbit that alone is selected deselects it; ctrl/cmd removes the orbit when
 *  all of it is selected, else adds it; shift adds it). */
function selectOrbitFromRow(orbit, sourceEvent) {
  const structure = fileBrowser.selectedStructure;
  if (!groups.atomsMesh) return;
  const members = orbit.atomIndices
    .map((index) => structure?.atomImages?.[index]?.[0])
    .filter((instanceId) => instanceId !== undefined);
  if (!members.length) return;
  const current = atomSelection.selectedAtoms;
  const inOrbit = (atom) => orbit.atomIndices.includes(atom.sourceIndex);
  const orbitSelected = orbit.atomIndices.every((index) => current.some((atom) => atom.sourceIndex === index));
  const mode = (sourceEvent?.ctrlKey || sourceEvent?.metaKey) ? 'toggle' : (sourceEvent?.shiftKey ? 'add' : 'replace');
  const kept = current.map((atom) => atom.instanceId);
  let next;
  if (mode === 'replace') next = orbitSelected && current.every(inOrbit) ? [] : members;
  else if (mode === 'toggle' && orbitSelected) next = current.filter((atom) => !inOrbit(atom)).map((atom) => atom.instanceId);
  else next = [...kept, ...members];
  clearBondSelection();
  clearPolyhedronSelection();
  if (next.length) selectAtomsByInstances(next, { sourceEvent, reason: 'row-click' });
  else clearSelectedAtoms({ sourceEvent, reason: 'row-click' });
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
  resetDirectSelection();
}

window.clearAtomHighlight = clearAllHighlights;
