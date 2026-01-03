
import {groups,highlightHover,fileBrowser} from '../store.js';
import {collapseAllAtomExpansions} from '../panels/WindowAndSceneControls.js';
import {updateBondControlPanel} from '../panels/StructureInfoPanel/Bonds.js';


export function clearHighlightAtom(m) {
  if (!m || !m.material) return;

  // Find all atoms with the same name
  const atomName = m.name;
  const allAtoms = [];
  groups.atomsGroup.traverse((child) => {
    if (child.name === atomName) {
      allAtoms.push(child);
    }
  });

  // Restore original emissive properties for all matching atoms
  allAtoms.forEach((atom) => {
    if (!atom.material) return;
    if (atom.userData._origEmissive !== undefined) {
      atom.material.emissive.setHex(atom.userData._origEmissive);
      atom.material.emissiveIntensity = atom.userData._origEmissiveInt || 0;
      atom.material.needsUpdate = true;
    }
  });
}


export function HighlightAtom(m, hex){
  if(!m || !m.material) return;
  if(m.userData._origEmissive===undefined){
    m.userData._origEmissive = m.material.emissive.getHex();
    m.userData._origEmissiveInt = m.material.emissiveIntensity || 0;
  }
  m.material.emissive.setHex(hex);
  m.material.emissiveIntensity = 2.0; 

}

export function highlightAtomIn3D(atomMesh) {
  // Clear previous 3D highlight
  if (highlightHover.currentlyHighlightedAtom) {
    clearHighlightAtom(highlightHover.currentlyHighlightedAtom);
  }

  // Find all atoms with the same name (e.g., originalIndex)
  const atomName = atomMesh.name;
  const allAtoms = [];
  groups.atomsGroup.traverse((child) => {
    if (child.name === atomName) {
      allAtoms.push(child);
    }
  });

  // Apply highlight to all matching atoms
  allAtoms.forEach((atom) => {
    HighlightAtom(atom, 0xFFB347); // Orange glow
  });

  // Update the currently highlighted atom reference
  highlightHover.currentlyHighlightedAtom = atomMesh;
}


export function HighlightBond(m, hex){
  if(!m || !m.material) return;
  if(m.userData._origEmissive===undefined){
    m.userData._origEmissive = m.material.emissive.getHex();
    m.userData._origEmissiveInt = m.material.emissiveIntensity || 0;
  }
  m.material.emissive.setHex(hex);
  m.material.emissiveIntensity = 2.0; // MAXIMUM BLAZING GLOW!
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
    // composition.setAttribute('aria-hidden', 'false'); // Removed to prevent focus issues
    if (toggleIcon) {
      toggleIcon.textContent = '−';
      toggleIcon.classList.add('open');
    }
    if (structureToggle) {
      structureToggle.setAttribute('aria-expanded', 'true');
    }
  }

  const panelSwitch = document.getElementById('atomBondControlSwitch')
  panelSwitch.querySelectorAll('button').forEach(btn => {
        btn.classList.remove('active');
      });
  panelSwitch.querySelectorAll('button')[0].classList.add('active');
  showPanel("atomPanel")

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

  if (atomsContainer && atomsContainer.style.display === 'none') {
    atomsContainer.style.display = 'block';
    if (expandIcon) {
      expandIcon.style.transform = 'rotate(90deg)';
    }
  }

  // Find the specific individual atom row
  const atomRows = atomsContainer.querySelectorAll('.individual-atom-row');
  for (const row of atomRows) {
    const atomNameSpan = row.querySelector('span:nth-child(1)');  // was 2 which is the coordiante and not the name. therefore the highlight did not work
    if (atomNameSpan) {
      // Extract the atom index from the display name (e.g., "Ba1" -> check if this is sourceIndex 0)
      const actualIndex = getAtomActualIndex(element, atomNameSpan.textContent);
      if (actualIndex === sourceIndex) {
        // Highlight this row
        highlightAtomRow(row);
        // Scroll into view
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
    }
  }
}

export function getAtomActualIndex(element, displayName) {
  const displayNumber = parseInt(displayName.replace(element, ''));
  let elementCount = 0;
  let elements = [...fileBrowser.selectedStructure.elements];
  for (let i = 0; i < elements.length; i++) {
    if (elements[i] === element) {
      elementCount++;
      if (elementCount === displayNumber) {
        return i;
      }
    }
  }
  return -1;
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

  // Clear 3D highlight
  if (highlightHover.currentlyHighlightedAtom) {
    clearHighlightAtom(highlightHover.currentlyHighlightedAtom);
    highlightHover.currentlyHighlightedAtom = null;
  }
   // Clear 3D bond highlight
  if (highlightHover.currentlyHighlightedBond) {
    clearHighlightBond(highlightHover.currentlyHighlightedBond);
    highlightHover.currentlyHighlightedBond = [];
    updateBondControlPanel();
  }
}

// Make clearAllHighlights available globally for manual clearing
window.clearAtomHighlight = clearAllHighlights;

export function highlightBondIn3D(bondMesh) {
  const bondName = bondMesh.name;
  const allHalves = [];
  groups.bondsGroup.traverse((child) => {
    if (child.name === bondName) {
      allHalves.push(child);
    }
  });

  // Clear previous bond or atom highlight
  if (highlightHover.currentlyHighlightedBond) {
    clearHighlightBond(highlightHover.currentlyHighlightedBond);
  }
   if (highlightHover.currentlyHighlightedAtom) {
    clearAllHighlights();

  }

  // Apply highlight to all halves
  allHalves.forEach((half) => {
    half.userData._origEmissive = half.material.emissive.getHex();
    half.userData._origEmissiveInt = half.material.emissiveIntensity;
    half.material.emissive.setHex(0xFFB347); // Orange glow
    half.material.emissiveIntensity = 1.5;
    half.material.needsUpdate = true;
  });
  // Update the currently highlighted bond reference
  highlightHover.currentlyHighlightedBond = allHalves; // or allHalves[0], if you prefer
  updateBondControlPanel()
}

function clearHighlightBond(bondMesh) {
  if (!bondMesh) return;
  let bondName
  if (bondMesh.length > 0){
     bondName = bondMesh[0].name;
  }
  else {
    bondName = bondMesh.name;
  }
  const allHalves = [];

  // Use traverse to search recursively
  groups.bondsGroup.traverse((child) => {
    if (child.name === bondName) {
      allHalves.push(child);
    }
  });

  // Clear the highlight for all halves
  allHalves.forEach((half) => {
    if (!half || !half.material) return;

    // Restore original emissive properties if they were saved
    if (half.userData._origEmissive !== undefined) {
      half.material.emissive.setHex(half.userData._origEmissive);
      half.material.emissiveIntensity = half.userData._origEmissiveInt || 0;
    } else {
      // If no original emissive was saved, reset to default (no highlight)
      half.material.emissive.setHex(0x000000);
      half.material.emissiveIntensity = 0;
    }

    half.material.needsUpdate = true; // Ensure the material updates
  });
}

