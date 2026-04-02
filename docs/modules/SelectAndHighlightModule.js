import {groups,highlightHover,fileBrowser} from '../store.js';
import {collapseAllAtomExpansions} from '../panels/WindowAndSceneControls.js';
import {updateBondControlPanel} from '../panels/StructureInfoPanel/Bonds.js';
import * as THREE from '../external/three/three.module.js';
import {updateAtoms} from './AtomsFracUpdateModule.js'
import {updateBonds} from './BondsFracUpdateModule.js'
import InstanceMeshManager from '../classes/InstanceMeshManager.js'
import {getUUIDFromGeometry} from './AtomsFracUpdateModule.js'

const ATOM_HIGHLIGHT_FADE_MS = 1200;
let clearAtomHighlightTimer = null;

export function clearHighlightAtom() {
  if (clearAtomHighlightTimer) {
    clearTimeout(clearAtomHighlightTimer);
    clearAtomHighlightTimer = null;
  }
  updateAtoms(1.0)
} 

export function clearHighlightBond() {
  updateBonds(1.0)
}

function clearUIHighlight() {
  if (highlightHover.currentlyHighlightedRow) {
    highlightHover.currentlyHighlightedRow.style.backgroundColor = '';
    highlightHover.currentlyHighlightedRow.style.borderLeft = '';
    highlightHover.currentlyHighlightedRow = null;
  }
}

function clear3DHighlights() {
  clearHighlightBond();
  clearHighlightAtom();
}

export function highlightAtomIn3D(index) {
  // Clear previous 3D highlight
  clear3DHighlights()

  // Update emissive color and intensity
  groups.atomsMesh.geometry.attributes.instanceEmissive.setXYZ(index, 1, 0.549, 0);
  groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.setX(index, 2.0);
  console.warn("atom UUID",groups.atomsMesh.userData.uuids[index])
  console.warn(getUUIDFromGeometry(index))
  // Update color if needed
  groups.atomsMesh.setColorAt(index, new THREE.Color(0xFF8C00));

  // Mark attributes as needing update
  groups.atomsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.atomsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  groups.atomsMesh.instanceColor.needsUpdate = true;

  clearAtomHighlightTimer = setTimeout(() => {
    clearAtomHighlightTimer = null;
    clearHighlightAtom();
  }, ATOM_HIGHLIGHT_FADE_MS);
}


export function highlightBondIn3D(indexList) {
  // Clear previous 3D highlight
  clear3DHighlights()

  // Update emissive color and intensity
  indexList.forEach(index => {
  groups.bondsMesh.geometry.attributes.instanceEmissive.setXYZ(index, 1, 0.549, 0);
  groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity.setX(index, 2.0);
  groups.bondsMesh.setColorAt(index, new THREE.Color(0xFF8C00));
    });  

  // Mark attributes as needing update
  groups.bondsMesh.geometry.attributes.instanceEmissive.needsUpdate = true;
  groups.bondsMesh.geometry.attributes.instanceEmissiveIntensity.needsUpdate = true;
  groups.bondsMesh.instanceColor.needsUpdate = true;
}


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

export function highlightBondInfoInStructurePanel(){
 const structureToggle = document.getElementById('structureToggle');
 // Check if structure panel is collapsed and expand it
 if (composition.classList.contains('collapsible-content') && !composition.classList.contains('open')) {
    const toggleIcon = document.getElementById('structureToggleIcon');
    composition.classList.add('open');
    // composition.setAttribute('aria-hidden', 'false'); // Removed to prevent focus issues
    if (toggleIcon) {
      toggleIcon.textContent = '−';
      toggleIcon.classList.add('open');
    }
    if (structureToggle) {
      structureToggle.setAttribute('aria-expanded', 'true');
    }
  }

  // select the bond information panel
  const panelSwitch = document.getElementById('atomBondControlSwitch')
  panelSwitch.querySelectorAll('button').forEach(btn => {
        btn.classList.remove('active');
      });
  panelSwitch.querySelectorAll('button')[1].classList.add('active');
  showPanel("bondControls")
}

export function highlightAtomInStructurePanel(element, sourceIndex) {
  // First, clear any existing highlights
  clearAllHighlights();
  const symmetry = fileBrowser.selectedStructure?.symmetry;
  const wyckoffOrbit = symmetry?.mode === 'wyckoff'
    ? symmetry.orbitGroups?.find((group) => group.atomIndices.includes(sourceIndex))
    : null;
  const targetAtomIndex = wyckoffOrbit?.representativeIndex ?? sourceIndex;
  const targetPanelId = wyckoffOrbit ? 'wyckoffPanel' : 'atomPanel';
  const targetMode = wyckoffOrbit ? 'wyckoff' : 'atoms';

  // Auto-expand the structure panel if it's collapsed
  const structureToggle = document.getElementById('structureToggle');
  const composition = document.getElementById('composition');
  if (!composition) return;

  // Collapse all other atom expansions first
  collapseAllAtomExpansions();

  // Check if structure panel is collapsed and expand it
  if (composition.classList.contains('collapsible-content') && !composition.classList.contains('open')) {
    const toggleIcon = document.getElementById('structureToggleIcon');
    composition.classList.add('open');
    if (toggleIcon) {
      toggleIcon.textContent = '−';
      toggleIcon.classList.add('open');
    }
    if (structureToggle) {
      structureToggle.setAttribute('aria-expanded', 'true');
    }
  }

  const panelSwitch = document.getElementById('atomBondControlSwitch');
  panelSwitch.querySelectorAll('button').forEach(btn => {
    btn.classList.remove('active');
  });
  const targetButton = panelSwitch.querySelector(`button[data-mode="${targetMode}"]`);
  targetButton?.classList.add('active');
  showPanel(targetPanelId);

  // Look for the element container
  const elementContainers = composition.querySelectorAll('.comp-container');
  let targetContainer = null;

  for (const container of elementContainers) {
    const elementName = container.querySelector('.comp-left span:nth-child(2)');
    if (elementName && elementName.textContent === element) {
      targetContainer = container;
      break;
    }
  }

  if (!targetContainer) return;

  // Auto-expand the element if not already expanded
  const atomsContainer = targetContainer.querySelector('.individual-atoms');
  const expandIcon = targetContainer.querySelector('.comp-left span:last-child');
  if (!atomsContainer) return;

  if (atomsContainer && atomsContainer.style.display === 'none') {
    atomsContainer.style.display = 'block';
    if (expandIcon) {
      expandIcon.style.transform = 'rotate(90deg)';
    }
  }

  // Find the specific individual atom row by sourceIndex
  const atomRows = atomsContainer.querySelectorAll('.individual-atom-row');
  for (let i = 0; i < atomRows.length; i++) {
    const row = atomRows[i];
    if (Number(row.dataset.atomIndex) === targetAtomIndex) {
      // Highlight this row
      highlightAtomRow(row);
      // Scroll into view
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    }
  }
}


export function highlightAtomRow(row) {
  // Clear previous highlight
  if (highlightHover.currentlyHighlightedRow) {
    highlightHover.currentlyHighlightedRow.style.backgroundColor = '';
    highlightHover.currentlyHighlightedRow.style.borderLeft = '';
  }

  // Add highlight to new row
  row.style.backgroundColor = 'rgba(255, 191, 0, 0.2)'; // Orange highlight
  row.style.borderLeft = '3px solid #FFB347';
  highlightHover.currentlyHighlightedRow = row;

}


export function clearAllHighlights() {
  clearUIHighlight();
  clear3DHighlights();
}

// Make clearAllHighlights available globally for manual clearing
window.clearAtomHighlight = clearAllHighlights;
