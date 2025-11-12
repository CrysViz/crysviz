
import {highlightHover,structureData} from '../store.js';
import {collapseAllAtomExpansions} from '../panels/WindowAndSceneControls.js';

export function clearHighlightAtom(m){
  if(!m || !m.material) return;
  if(m.userData._origEmissive!==undefined){
    m.material.emissive.setHex(m.userData._origEmissive);
    m.material.emissiveIntensity = m.userData._origEmissiveInt || 0;
  }
}

export function HighlightAtom(m, hex){
  if(!m || !m.material) return;
  if(m.userData._origEmissive===undefined){
    m.userData._origEmissive = m.material.emissive.getHex();
    m.userData._origEmissiveInt = m.material.emissiveIntensity || 0;
  }
  m.material.emissive.setHex(hex);
  m.material.emissiveIntensity = 2.0; // MAXIMUM BLAZING GLOW!
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
  // Convert "Ba1" to actual index by finding all atoms of this element
  //if (!structureData) return -1;
  const displayNumber = parseInt(displayName.replace(element, ''));
  let elementCount = 0;

  for (let i = 0; i < structureData.elements.length; i++) {
    if (structureData.elements[i] === element) {
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
  console.log("Highlighting atom row")
  if (highlightHover.currentlyHighlightedRow) {
    highlightHover.currentlyHighlightedRow.style.backgroundColor = '';
    highlightHover.currentlyHighlightedRow.style.borderLeft = '';
  }

  // Add highlight to new row
  row.style.backgroundColor = 'rgba(255, 191, 0, 0.2)'; // Orange highlight
  row.style.borderLeft = '3px solid #FFB347';
  highlightHover.currentlyHighlightedRow = row;

}

export function highlightAtomIn3D(atomMesh) {
  // Clear previous 3D highlight
  if (highlightHover.currentlyHighlightedAtom) {
    clearHighlightAtom(highlightHover.currentlyHighlightedAtom);
  }

  // Add new highlight
  HighlightAtom(atomMesh, 0xFFB347); // Orange glow
  highlightHover.currentlyHighlightedAtom = atomMesh;

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
}

// Make clearAllHighlights available globally for manual clearing
window.clearAtomHighlight = clearAllHighlights;
