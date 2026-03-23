import {groups,highlightHover,fileBrowser} from '../store.js';
import {collapseAllAtomExpansions} from '../panels/WindowAndSceneControls.js';
import {updateBondControlPanel} from '../panels/StructureInfoPanel/Bonds.js';
import * as THREE from '../external/three/three.module.js';
import {updateAtoms} from './AtomsFracUpdateModule.js'
import {updateBonds} from './BondsFracUpdateModule.js'
import InstanceMeshManager from '../classes/InstanceMeshManager.js'
import {getUUIDFromGeometry} from './AtomsFracUpdateModule.js'

export function clearHighlightAtom() {
  updateAtoms(1.0)
} 

export function clearHighlightBond() {
  updateBonds(1.0)
}


export function highlightAtomIn3D(index) {
  // Clear previous 3D highlight
  clearAllHighlights()

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
}


export function highlightBondIn3D(indexList) {
  // Clear previous 3D highlight
  clearAllHighlights()

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
  panelSwitch.querySelectorAll('button')[0].classList.add('active');
  showPanel("atomPanel");

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

  //if (!targetContainer) return;

  // Auto-expand the element if not already expanded
  const atomsContainer = targetContainer.querySelector('.individual-atoms');
  const expandIcon = targetContainer.querySelector('.comp-left span:last-child');

  if (atomsContainer && atomsContainer.style.display === 'none') {
    atomsContainer.style.display = 'block';
    if (expandIcon) {
      expandIcon.style.transform = 'rotate(90deg)';
    }
  }

  // Find the specific individual atom row by sourceIndex
  const atomRows = atomsContainer.querySelectorAll('.individual-atom-row');
  console.warn(atomRows.length)
  console.warn("Searching for row",sourceIndex)
  for (let i = 0; i < atomRows.length; i++) {
   sourceIndex=0
    const row = atomRows[i];
    // Use the row's data-index attribute or assume the order matches the global index
    // If rows are ordered the same as the global index, you can directly use sourceIndex
    if (i === sourceIndex) {
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
  // Clear UI highlight
  if (highlightHover.currentlyHighlightedRow) {
    highlightHover.currentlyHighlightedRow.style.backgroundColor = '';
    highlightHover.currentlyHighlightedRow.style.borderLeft = '';
    highlightHover.currentlyHighlightedRow = null;
  }
  clearHighlightBond();
  clearHighlightAtom();
}

// Make clearAllHighlights available globally for manual clearing
window.clearAtomHighlight = clearAllHighlights;
