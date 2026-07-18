import {fileBrowser, general, structureShip} from '../../state/store.js';


import {collapseAllAtomExpansions} from '../../ui/WindowAndSceneControls.js'
import { createCompositionRow, createWyckoffCompositionRow, clearCompositionRowRegistry} from './Species.js'
import { createBondLengthControls} from '../BondLengthPanel.js'
import { createPolyhedraListControls } from '../PolyhedraListPanel.js'
import { clearAllHighlights } from '../SelectAndHighlightModule.js'
import { getPanel } from '../panels/PanelManager.js'
import { latticeVolume } from '../../math/index.js';
import { updateVisualization } from '../../core/crystal-viewer.js';
import { atomForceToColor } from '../ColorPanel.js';
import { updateForces, updateSpins } from '../../render/index.js';

// The per-structure style-override stores (all survive rebuilds; see Structure.js).
const ALL_STYLE_STORES = ['atomImageStyles', 'bondUserStyles', 'bondCategoryStyles',
                          'polyhedraUserStyles', 'polyhedraCategoryStyles'];

/** Reset every COLOR customization; alpha/size/visibility overrides survive. */
function resetAllColorStyling(structure) {
  const forceMode = general.atomsColor === 'force';
  structure.atoms.forEach((atom, i) => {
    delete atom.forceColor;
    atom.resetToDefaultColor(); // color + elementColor -> map default, userColor = null
    if (forceMode) {
      // Force-color mode repaints from force magnitudes (mirrors ColorEditor's reset).
      const f = structure.forces?.[i]?.vector;
      if (f?.length >= 3) {
        atom.color = atomForceToColor(Math.hypot(f[0], f[1], f[2]), general.ForceMin, general.ForceMax);
      }
    }
  });
  for (const storeName of ALL_STYLE_STORES) {
    const store = structure[storeName] ?? {};
    for (const [key, entry] of Object.entries(store)) {
      delete entry.color;
      delete entry.edgeColor;
      // Drop entries with no remaining overrides (element/elements are metadata;
      // keep visible-only category entries and ray-tracing materials).
      if (entry.alpha == null && entry.edgeAlpha == null
          && entry.radiusScale == null && entry.visible == null
          && entry.material == null) {
        delete store[key];
      }
    }
  }
  // Force/spin arrows: strip the same per-arrow color pin (StructureInfoPanel's
  // Spin/Force row editor "Color" button) atoms/bonds get stripped above.
  // Vector/scaling (real data) and hidden (visibility) are left alone here —
  // resetAllStyling() below also clears hidden, matching its broader scope.
  structure.forces?.forEach((force) => { force.userColor = null; });
  structure.spins?.forEach((spin) => { spin.userColor = null; });
}

/** Re-render force/spin arrows (if shown) and any currently-open Structure
 *  Info Spin/Force row editor after a bulk edit to structure.forces/spins —
 *  shared by the Reset Colors and Reset Styling buttons below. */
function refreshForceSpinArrows() {
  if (general.forcesActive) updateForces(general.forceScale ?? 1.0, general.forceColorMap ?? 'heatmap');
  if (general.spinsActive) updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap ?? 'none');
  document.querySelectorAll('.atom-spin-editor').forEach((el) => {
    if (el.style.display !== 'none') /** @type {any} */ (el).refresh?.();
  });
}

/** Reset everything the tabs can set — colors, alpha/size, per-element
 *  visibility, cut-plane immunities, category styles. Never touches positions.
 *  Per-pair bondVisibility/bondLengths are intentionally kept (the Bonds tab
 *  has its own "Reset to Defaults" for those). */
function resetAllStyling(structure) {
  resetAllColorStyling(structure);
  structure.atoms.forEach((atom) => {
    atom.setElementOpacity(1);
    atom.setOpacity(1);
    atom.resetRadiusScale();
    atom.setCutPlaneImmune(false);
  });
  for (const storeName of ALL_STYLE_STORES) structure[storeName] = {};
  // Ray/path-tracing materials (species + per-atom) reset with everything else;
  // bond/poly materials went with their user/category stores above.
  structure.atomMaterials = {};
  structure.atomUserMaterials = {};
  general.atomVisibility = {};
  general.bondCutImmunity = {};
  // Force/spin arrows: un-hide every individually-hidden arrow (that atom's
  // own row "Hide arrow" checkbox) — the arrow counterpart of the atom/bond/
  // polyhedra visibility overrides cleared above.
  structure.forces?.forEach((force) => { force.hidden = false; });
  structure.spins?.forEach((spin) => { spin.hidden = false; });
}

// Small switch row, same markup/classes as the toggles in PolyhedraPanel.js.
function createToggleRow({ id, label, checked, onChange }) {
  const row = document.createElement('label');
  row.className = 'toggle_row toggle_container';

  const switchWrap = document.createElement('span');
  switchWrap.className = 'toggle_switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;

  const slider = document.createElement('span');
  slider.className = 'toggle_slider';

  const text = document.createElement('span');
  text.className = 'toggle_text';
  text.textContent = label;

  input.addEventListener('change', onChange);

  switchWrap.appendChild(input);
  switchWrap.appendChild(slider);
  row.appendChild(switchWrap);
  row.appendChild(text);
  return row;
}

/**
 * Open/close the formula box inside the Structure window (the +/− expandable
 * composition details). Opening also expands the hosting panel window.
 */
export function setStructurePanelOpen(open) {
  const composition = document.getElementById('composition');
  if (!composition) return;
  composition.classList.toggle('open', open);
  composition.setAttribute('aria-hidden', String(!open));
  const icon = document.getElementById('structureToggleIcon');
  if (icon) {
    icon.textContent = open ? '−' : '+';
    icon.classList.toggle('open', open);
  }
  const toggle = document.getElementById('structureToggle');
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    const panel = getPanel('info');
    if (panel) panel.expand();
  } else {
    collapseAllAtomExpansions();
  }
}

/** Click/keyboard handler for the formula box header. */
export function handleStructurePanelToggle() {
  const composition = document.getElementById('composition');
  if (!composition) return;
  setStructurePanelOpen(!composition.classList.contains('open'));
}

export function getCompositionString() {
  function computeComposition() {
    if (!fileBrowser.selectedStructure) return {};
      const structure = fileBrowser.selectedStructure;
      const counts = {};
      structure.elements.forEach((e, i) => {
        if (structure.atoms[i]?.hidden) return;
        counts[e] = (counts[e] || 0) + 1;
      });
    return counts;
  }
  // Generate the chemical formula as a string
  const counts = computeComposition();
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const elements = Object.keys(counts).sort();

  let formula = '';

  // Iterate through the counts object and build the formula string
  for (const element in counts) {
    const count = counts[element];
    if (general.currentSupercell === null) {
      formula += element + (count > 1 ? `<sub>${count}</sub>` : ''); // Add subscript if count > 1
    } else {
      const supercellSize = general.currentSupercell.nx * general.currentSupercell.ny * general.currentSupercell.nz;
      // Divide the count by the supercell size
      const currCount = count / supercellSize;
      formula += element + (currCount > 1 ? `<sub>${Math.round(currCount)}</sub>` : ''); // Add subscript if count > 1
    }
  }

  // The chemical formula heads the +/− expandable box inside the window.
  const structureToggleHeading = document.querySelector('#structureToggle h4');
  if (structureToggleHeading) {
    structureToggleHeading.innerHTML = formula + ` (${total} Atoms)`; // Use innerHTML to allow HTML tags
  }

  // Display the chemical formula and the total number of atoms
  const compString = document.createElement('div');
  compString.innerHTML = `${formula} (${total} Atoms)`; // Use innerHTML to allow HTML tags
  compString.style.cssText = 'font-size:12px; font-weight:500; margin-bottom:10px;';

  const compWrapper = document.querySelector('#composition');
  compWrapper.appendChild(compString);

  // Return elements, counts, and total
  return { elements, counts, total };
}

function captureCompositionUiState() {
  const compDiv = document.getElementById('composition');
  if (!compDiv) {
    return { expandedElements: [], elementEditorsOpen: [], atomEditorsOpen: [], expandedBondPairs: [], bondEditorsOpen: [] };
  }

  const expandedElements = [];
  const elementEditorsOpen = [];
  const atomEditorsOpen = [];
  const expandedBondPairs = [];
  const bondEditorsOpen = [];
  const expandedPolyCategories = [];
  const polyEditorsOpen = [];
  const polyCatEditorsOpen = [];

  compDiv.querySelectorAll('.comp-container').forEach((container) => {
    const element = container.dataset.element;
    if (!element) return;

    const atomsContainer = container.querySelector('.individual-atoms');
    if (atomsContainer && atomsContainer.style.display !== 'none') {
      expandedElements.push(element);
    }

    const elementEditor = container.querySelector('.element-color-editor');
    if (elementEditor && elementEditor.style.display !== 'none') {
      elementEditorsOpen.push(element);
    }
  });

  compDiv.querySelectorAll('.individual-atom-row').forEach((row) => {
    const atomIndex = row.dataset.atomIndex;
    if (!atomIndex) return;

    const editorTypes = [
      ['color', '.atom-color-editor'],
      ['coord', '.atom-coord-editor'],
      ['spin', '.atom-spin-editor'],
    ];

    for (const [type, selector] of editorTypes) {
      const editor = row.querySelector(selector);
      if (editor && editor.style.display !== 'none') {
        atomEditorsOpen.push({ atomIndex, imageIndex: row.dataset.imageIndex ?? null, type });
        break;
      }
    }
  });

  compDiv.querySelectorAll('.bond-control').forEach((control) => {
    const pair = control.dataset.pair;
    if (!pair) return;
    const bondsContainer = control.querySelector('.individual-bonds');
    if (bondsContainer && bondsContainer.style.display !== 'none') {
      expandedBondPairs.push(pair);
    }
  });

  compDiv.querySelectorAll('.individual-bond-row').forEach((row) => {
    const bondRowKey = row.dataset.bondKey;
    if (!bondRowKey) return;
    const editor = row.querySelector('.bond-color-editor');
    if (editor && editor.style.display !== 'none') {
      bondEditorsOpen.push(bondRowKey);
    }
  });

  compDiv.querySelectorAll('.poly-control').forEach((control) => {
    const catKey = control.dataset.catKey;
    if (!catKey) return;
    const listContainer = control.querySelector('.individual-polyhedra');
    if (listContainer && listContainer.style.display !== 'none') {
      expandedPolyCategories.push(catKey);
    }
    const catEditor = control.querySelector('.poly-cat-editor');
    if (catEditor && catEditor.style.display !== 'none') {
      polyCatEditorsOpen.push(catKey);
    }
  });

  compDiv.querySelectorAll('.individual-polyhedron-row').forEach((row) => {
    const polyKey = row.dataset.polyKey;
    if (!polyKey) return;
    const editor = row.querySelector('.poly-color-editor');
    if (editor && editor.style.display !== 'none') {
      polyEditorsOpen.push(polyKey);
    }
  });

  return {
    expandedElements, elementEditorsOpen, atomEditorsOpen,
    expandedBondPairs, bondEditorsOpen,
    expandedPolyCategories, polyEditorsOpen, polyCatEditorsOpen,
  };
}

function restoreCompositionUiState(state) {
  if (!state) return;

  const compDiv = document.getElementById('composition');
  if (!compDiv) return;

  for (const element of state.expandedElements || []) {
    const container = compDiv.querySelector(`.comp-container[data-element="${element}"]`);
    if (!container) continue;
    const atomsContainer = container.querySelector('.individual-atoms');
    const expandIcon = container.querySelector('.comp-left span:last-child');
    atomsContainer?._populateAtomRows?.();
    if (atomsContainer) atomsContainer.style.display = 'block';
    if (expandIcon) expandIcon.style.transform = 'rotate(90deg)';
  }

  for (const pair of state.expandedBondPairs || []) {
    const control = compDiv.querySelector(`.bond-control[data-pair="${pair}"]`);
    if (!control) continue;
    const bondsContainer = control.querySelector('.individual-bonds');
    const expandIcon = control.querySelector('.bond-expand-icon');
    bondsContainer?._populateBondRows?.();
    if (bondsContainer) bondsContainer.style.display = 'block';
    if (expandIcon) expandIcon.style.transform = 'rotate(90deg)';
  }

  for (const bondRowKey of state.bondEditorsOpen || []) {
    const editor = compDiv.querySelector(`.individual-bond-row[data-bond-key="${bondRowKey}"] .bond-color-editor`);
    if (editor) editor.style.display = 'block';
  }

  for (const catKey of state.expandedPolyCategories || []) {
    const control = compDiv.querySelector(`.poly-control[data-cat-key="${catKey}"]`);
    if (!control) continue;
    const listContainer = control.querySelector('.individual-polyhedra');
    const expandIcon = control.querySelector('.poly-expand-icon');
    listContainer?._populatePolyhedronRows?.();
    if (listContainer) listContainer.style.display = 'block';
    if (expandIcon) expandIcon.style.transform = 'rotate(90deg)';
  }

  for (const catKey of state.polyCatEditorsOpen || []) {
    const editor = compDiv.querySelector(`.poly-control[data-cat-key="${catKey}"] .poly-cat-editor`);
    if (editor) editor.style.display = 'block';
  }

  for (const polyKey of state.polyEditorsOpen || []) {
    const editor = compDiv.querySelector(`.individual-polyhedron-row[data-poly-key="${polyKey}"] .poly-color-editor`);
    if (editor) editor.style.display = 'block';
  }

  for (const element of state.elementEditorsOpen || []) {
    const container = compDiv.querySelector(`.comp-container[data-element="${element}"]`);
    const editor = container?.querySelector('.element-color-editor');
    if (!editor) continue;
    editor.style.display = 'flex';
    editor.style.flexDirection = 'column';
  }

  for (const entry of state.atomEditorsOpen || []) {
    // Per-image rows are keyed by atom + image; fall back to the plain
    // per-atom selector (cross-mode restores simply miss, which is fine).
    const row = (entry.imageIndex != null
      ? compDiv.querySelector(`.individual-atom-row[data-atom-index="${entry.atomIndex}"][data-image-index="${entry.imageIndex}"]`)
      : null)
      ?? compDiv.querySelector(`.individual-atom-row[data-atom-index="${entry.atomIndex}"]`);
    if (!row) continue;

    const editors = {
      color: row.querySelector('.atom-color-editor'),
      coord: row.querySelector('.atom-coord-editor'),
      spin: row.querySelector('.atom-spin-editor'),
    };

    Object.values(editors).forEach((editor) => {
      if (editor) editor.style.display = 'none';
    });

    row.querySelectorAll('.atom-editor-button').forEach((button) => {
      button.style.border = '1px solid rgba(255,255,255,0.2)';
      button.style.boxShadow = 'none';
    });

    const target = editors[entry.type];
    if (target) target.style.display = 'block';

    const activeButton = row.querySelector(`.atom-editor-button[data-editor-button="${entry.type}"]`);
    if (activeButton) {
      activeButton.style.border = '1px solid rgba(125, 206, 160, 0.95)';
      activeButton.style.boxShadow = '0 0 0 1px rgba(125, 206, 160, 0.35), inset 0 0 0 1px rgba(125, 206, 160, 0.15)';
    }
  }
}


export function renderComposition(panelState="closed") {

  const priorUiState = captureCompositionUiState();

  const {elements, counts, total}=getCompositionString()
  const hasWyckoffPanel = fileBrowser.selectedStructure?.symmetry?.mode === 'wyckoff'
    && (fileBrowser.selectedStructure.symmetry.orbitGroups?.length ?? 0) > 0;
  // Keep the user's tab across re-renders; only fall back when the stored mode
  // isn't valid for this structure (e.g. 'atoms' in wyckoff mode, or an
  // unloaded state). This intentionally also lets Bonds/Poly persist.
  const validModes = hasWyckoffPanel
    ? ['wyckoff', 'bonds', 'polyhedra']
    : ['atoms', 'bonds', 'polyhedra'];
  if (!validModes.includes(general.structurePanelMode)) {
    general.structurePanelMode = hasWyckoffPanel ? 'wyckoff' : 'atoms';
  }

  const compDiv = document.getElementById('composition');
  compDiv.innerHTML = '';
  // Drop any row updaters left behind by a previously-selected structure —
  // see clearCompositionRowRegistry() for why stale entries crash.
  clearCompositionRowRegistry();
  const compWrapper = document.createElement('div');
    compWrapper.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 2px;
  `;



  // Button to add additional atoms to structure <- FIXME so far not working
  const addButtonsRow = document.createElement('div');
  addButtonsRow.style.cssText = 'display: flex; align-items: center; gap: 4px;';
  const addAtomButton = document.createElement('button');
  addAtomButton.id = 'addButton';
  addAtomButton.innerHTML = '+';               // icon only
  addAtomButton.className = 'btn-mini highlight';
  addAtomButton.style.cssText = `
    height: 26px;
    width: 26px;
    font-size: 16px;
    font-weight: 600;
    line-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255,255,255,0.08);  /* slightly darker square */
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 4px;
    color: white;
    cursor: pointer;
  `;

   if (!hasWyckoffPanel) addButtonsRow.appendChild(addAtomButton)
  
  const title = document.createElement('div');
  const titleWrapper = document.createElement('div');
    titleWrapper.style.cssText = `
    display: flex;
    justify-content: space-between;
    gap:20px;
    margin-top: 2px;
  `;

  title.textContent = hasWyckoffPanel ? 'Modify Wyckoff Orbits/Bonds' : 'Modify Atoms/Bonds';
  title.style.cssText = 'font-size:14px; font-weight:500; margin-bottom:10px;';

  titleWrapper.appendChild(title);
  titleWrapper.appendChild(addButtonsRow);
  compDiv.appendChild(titleWrapper);

  if (hasWyckoffPanel) {
    const symmetryBadge = document.createElement('div');
    symmetryBadge.textContent = 'Symmetry Locked  |  Wyckoff Mode Active';
    symmetryBadge.style.cssText = `
      margin: 0 0 10px 0;
      padding: 8px 10px;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(32,77,160,0.35), rgba(35,139,230,0.18));
      border: 1px solid rgba(91,168,255,0.45);
      color: #cfe6ff;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04);
    `;
    compDiv.appendChild(symmetryBadge);
  }


  // Sync the formula box: "open" keeps/forces it (and the hosting window)
  // expanded, anything else closes the box (matching the old default-closed
  // behavior on re-render). The window itself stays as the user left it.
  setStructurePanelOpen(panelState === "open");

// "Link periodic copies": governs the per-copy vs grouped behavior of ALL tabs
// below — Atoms per-image rows, Bonds/Poly grouped rows (general.linkPeriodicCopies).
// Wyckoff orbit rows are unaffected, but the toggle still applies to Bonds/Poly
// in wyckoff mode, so it is shown unconditionally above the tab selector.
const linkCopiesRow = createToggleRow({
  id: 'linkPeriodicCopiesToggle',
  label: 'Link periodic copies',
  checked: general.linkPeriodicCopies !== false,
  onChange: (e) => {
    general.linkPeriodicCopies = /** @type {any} */ (e.target).checked;
    // Selection rows go stale across the list rebuilds.
    clearAllHighlights({ reason: 'link-copies-toggle' });
    renderComposition("open");
  },
});
linkCopiesRow.style.margin = '6px 0 8px 0';
compDiv.appendChild(linkCopiesRow);

// One-click propagation of the current frame's styling to every trajectory
// frame (multi-frame files only). Mirrors the element editor's "Apply to
// Trajectory" but covers ALL style stores.
const trajContainer = structureShip.container[fileBrowser.selectedRowIndex];
if (trajContainer?.structures?.length > 1) {
  const applyStylesBtn = document.createElement('button');
  applyStylesBtn.id = 'applyStylesToTrajectoryBtn';
  applyStylesBtn.textContent = 'Apply styles to trajectory';
  applyStylesBtn.className = 'reset-btn';
  applyStylesBtn.title = 'Copy all atom/bond/polyhedra styling from this frame to every frame';
  applyStylesBtn.style.cssText = 'height: 28px; padding: 0 10px; font-size: 11px; margin: 0 0 8px 0;';
  applyStylesBtn.onclick = () => {
    trajContainer.flushStylesToAllStructures(fileBrowser.selectedStructure);
    trajContainer.flushColorToAllStructures(fileBrowser.selectedStructure); // atom model colors travel too
    const prior = applyStylesBtn.textContent;
    applyStylesBtn.textContent = 'Applied ✓';
    setTimeout(() => { if (applyStylesBtn.isConnected) applyStylesBtn.textContent = prior; }, 1200);
  };
  compDiv.appendChild(applyStylesBtn);
}

// Create a new div element for the segmented control
const atomBondControl = document.createElement('div');
atomBondControl.id = 'atomBondControl';
atomBondControl.className = "atomBondControl";

// Add the segmented control to the div
const segmentedControl = addSegmentedControl(atomBondControl, 'atomBondControlSwitch', hasWyckoffPanel);
if (hasWyckoffPanel) {
  segmentedControl.style.boxShadow = '0 0 0 1px rgba(91,168,255,0.35)';
  segmentedControl.style.background = 'rgba(25,55,110,0.28)';
}
// Append the div to compDiv
compDiv.appendChild(atomBondControl);

// Create atom panel
const atomPanel = document.createElement("div");
atomPanel.id = "atomPanel";
atomPanel.className = "atomBondClass"; // Add a class for styling
if (!hasWyckoffPanel) {
  elements.forEach(el => {
    const row = createCompositionRow(el, counts[el], total);
    atomPanel.appendChild(row);
  });
}

const ResetColorAtomsButtonRow = document.createElement('div');
ResetColorAtomsButtonRow.style.display = 'flex';
ResetColorAtomsButtonRow.style.justifyContent = 'center';
ResetColorAtomsButtonRow.style.marginTop = '20px';
ResetColorAtomsButtonRow.style.gap = '20px';


const resetAllColorsBtn = document.createElement('button');
resetAllColorsBtn.id="resetAllColorsBtn"
resetAllColorsBtn.textContent = 'Reset Colors';
resetAllColorsBtn.className = 'reset-btn';
resetAllColorsBtn.style.cssText = 'height: 32px; padding: 0 10px; font-size: 11px; margin-right: 4px; min-width: 44px;';
resetAllColorsBtn.title = 'Reset every color customization (atoms, per-copy, bond and polyhedra colors, individual force/spin arrow colors) to element defaults';
resetAllColorsBtn.onclick = () => {
  resetAllColorStyling(fileBrowser.selectedStructure);
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderOther: false, reRenderComposition: "open" });
  refreshForceSpinArrows();
};

// Historic id kept (never rename ids); label describes the actual behavior.
const resetAtomsBtn = document.createElement('button');
resetAtomsBtn.id = "resetAtomsBtn"
resetAtomsBtn.textContent = 'Reset Styling';
resetAtomsBtn.className = 'reset-btn';
resetAtomsBtn.style.cssText = 'height: 32px; padding: 0 10px; font-size: 11px; margin-right: 4px; min-width: 44px;';
resetAtomsBtn.title = 'Reset all atom/bond/polyhedra styling (colors, transparency, sizes, visibility, cut immunity) and unhide every individually-hidden force/spin arrow. Bond lengths/visibility keep their own reset in the Bonds tab.';
resetAtomsBtn.onclick = () => {
  resetAllStyling(fileBrowser.selectedStructure);
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true, reRenderOther: false, reRenderComposition: "open" });
  refreshForceSpinArrows();
};

ResetColorAtomsButtonRow.appendChild(resetAllColorsBtn)
ResetColorAtomsButtonRow.appendChild(resetAtomsBtn)


if (!hasWyckoffPanel) atomPanel.appendChild(ResetColorAtomsButtonRow)



// Create bonds panel
const bondsPanel = document.createElement("div");
bondsPanel.id = "infoBondControls";
bondsPanel.className = "atomBondClass"; // Add a class for styling

const wyckoffPanel = document.createElement("div");
wyckoffPanel.id = "wyckoffPanel";
wyckoffPanel.className = "atomBondClass";
if (hasWyckoffPanel) {
  const orbitGroups = fileBrowser.selectedStructure.symmetry.orbitGroups;
  const groupedByElement = orbitGroups.reduce((acc, group) => {
    (acc[group.element] ||= []).push(group);
    return acc;
  }, {});
  const totalOrbits = orbitGroups.length || 1;
  Object.keys(groupedByElement).sort().forEach((element) => {
    wyckoffPanel.appendChild(createWyckoffCompositionRow(element, groupedByElement[element], totalOrbits));
  });
}
// Create polyhedra panel
const polyPanel = document.createElement("div");
polyPanel.id = "infoPolyControls";
polyPanel.className = "atomBondClass";

// Append panels to compDiv
if (!hasWyckoffPanel) compDiv.appendChild(atomPanel);
compDiv.appendChild(bondsPanel);
compDiv.appendChild(polyPanel);
if (hasWyckoffPanel) compDiv.appendChild(wyckoffPanel);

createBondLengthControls("infoBondControls"); // Make sure to pass the panel element
createPolyhedraListControls("infoPolyControls");

// Function to show the selected panel and hide others
function showPanel(panelId) {
  // Hide all panels
  document.querySelectorAll('.atomBondClass').forEach(panel => {
    panel.style.display = 'none';
  });

  // Show the selected panel
  const panelToShow = document.getElementById(panelId);
  console.warn(panelId)
  if (panelToShow) {
    panelToShow.style.display = 'block';
  }
}

// Set up event listeners for the segmented control buttons
segmentedControl.querySelectorAll('button').forEach(button => {
  button.addEventListener('click', function() {
    // Remove active class from all buttons
    segmentedControl.querySelectorAll('button').forEach(btn => {
      btn.classList.remove('active');
    });

    // Add active class to the clicked button
    this.classList.add('active');
    // Show the appropriate panel based on the selected mode
    const selectedMode = this.dataset.mode;
    if (selectedMode === 'atoms') {
      general.structurePanelMode = 'atoms';
      showPanel('atomPanel');
    } else if (selectedMode === 'bonds') {
      general.structurePanelMode = 'bonds';
      showPanel('infoBondControls');
    } else if (selectedMode === 'polyhedra') {
      general.structurePanelMode = 'polyhedra';
      showPanel('infoPolyControls');
    } else if (selectedMode === 'wyckoff' && hasWyckoffPanel) {
      general.structurePanelMode = 'wyckoff';
      showPanel('wyckoffPanel');
    }
  });
});
const modePanelIds = {
  atoms: 'atomPanel',
  bonds: 'infoBondControls',
  polyhedra: 'infoPolyControls',
  wyckoff: 'wyckoffPanel',
};
const initialMode = general.structurePanelMode; // validated above
const initialButton = Array.from(segmentedControl.querySelectorAll('button'))
  .find((button) => button.dataset.mode === initialMode)
  || segmentedControl.querySelector(hasWyckoffPanel ? 'button[data-mode="wyckoff"]' : 'button[data-mode="atoms"]');
initialButton?.classList.add('active');
if (hasWyckoffPanel) {
  segmentedControl.querySelectorAll('button').forEach((button) => {
    if (button.dataset.mode === 'wyckoff') {
      button.textContent = 'Wyckoff *';
    }
    if (button.classList.contains('active')) {
      button.style.background = 'linear-gradient(135deg, #1c5fb8, #2493ff)';
      button.style.color = '#f5fbff';
      button.style.fontWeight = '700';
    }
  });
}
showPanel(modePanelIds[initialMode] ?? 'atomPanel')

  restoreCompositionUiState(priorUiState);

// CSS for the panels
const style = document.createElement('style');
style.textContent = `
  .control-panel {
    display: none; /* Initially hidden */
    margin-top: 10px;
    padding: 10px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background-color: rgba(26, 26, 26, 0.95);
  }
`;
document.head.appendChild(style);



  // Example usage:
  //
  const volumeDiv = document.createElement("div");
  volumeDiv.style.cssText = `
    margin-top: 8px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.8);
  `;


  compDiv.appendChild(volumeDiv);
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  const volume = getLatticeVolume(lattice);
  volumeDiv.textContent = `Volume: ${volume} Å³`;

}


function getLatticeVolume(lattice) {
  return latticeVolume(lattice).toFixed(3);
}


// Function to create the segmented control
function createSegmentedControl(containerId, includeWyckoff = false) {
  // Create the container div
  const container = document.createElement('div');
  container.className = 'segmented-control';
  container.id = containerId; 

  // Create the buttons

  const AtomsButton = document.createElement('button');
  AtomsButton.textContent = 'Atoms';
  AtomsButton.dataset.mode = 'atoms';

  const BondsButton = document.createElement('button');
  BondsButton.textContent = 'Bonds';
  BondsButton.dataset.mode = 'bonds';

  const PolyButton = document.createElement('button');
  PolyButton.textContent = 'Poly';
  PolyButton.title = 'Polyhedra';
  PolyButton.dataset.mode = 'polyhedra';

  const WyckoffButton = document.createElement('button');
  WyckoffButton.textContent = 'Wyckoff';
  WyckoffButton.dataset.mode = 'wyckoff';

  if (includeWyckoff) {
    container.appendChild(WyckoffButton);
    container.appendChild(BondsButton);
    container.appendChild(PolyButton);
  } else {
    container.appendChild(AtomsButton);
    container.appendChild(BondsButton);
    container.appendChild(PolyButton);
  }

   // Add event listeners for the buttons
  container.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', function() {
      // Remove active class from all buttons
      container.querySelectorAll('button').forEach(btn => {
        btn.classList.remove('active');
      });

      // Add active class to the clicked button
      this.classList.add('active');
    });
  });

  return container;
}

// Function to add the segmented control to a specific element
function addSegmentedControl(parentElement, containerId, includeWyckoff = false) {
  const segmentedControl = createSegmentedControl(containerId, includeWyckoff);
  parentElement.appendChild(segmentedControl);
  return segmentedControl;
}

 
