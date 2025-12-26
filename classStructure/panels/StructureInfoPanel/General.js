import {app, groups, originalStructureData,structureData, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../../store.js';

import { updateVisualization } from '../../crystal-viewer.js';

import {colorHexToCss,hexToRgba,getElementColor,loadColorOverrides,loadIndividualAtomColors,getIndividualAtomColor,getElementDisplayColor,getDefaultElementColor,clearAllIndividualColorsForElement,setElementColorOverride,clearElementColorOverride,setIndividualAtomColor,createPieDot,clearIndividualAtomColor } from '../../modules/ColorModule.js';

import { createColorPicker } from '../../old_style/color-picker.js';
import { updateBonds } from '../../modules/BondsModule.js'
import {createSupercell} from '../../modules/SuperCellModule.js';
import {resetView,collapseAllAtomExpansions} from '../../panels/WindowAndSceneControls.js'
import {createCompositionRow} from './Species.js'

import {createBondLengthControls} from '../BondLengthPanel.js'



// Function to handle structure panel toggle
export function handleStructurePanelToggle() {
  const composition = document.getElementById('composition');
  if (composition && !composition.classList.contains('open')) {
    // Structure panel is being collapsed, so collapse all atom expansions
    collapseAllAtomExpansions();
  }
};

export function getCompositionString() {
  function computeComposition() {
    if (!structureData) return {};
      const counts = {};
      structureData.elements.forEach(e => counts[e] = (counts[e] || 0) + 1);
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

  // Set the composition string in the 'h4' of the #structureToggle
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


export function renderComposition(panelState="closed") {

  const {elements, counts, total}=getCompositionString()

  const compDiv = document.getElementById('composition');
  compDiv.innerHTML = '';
  const compString = document.createElement('div');
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

   addButtonsRow.appendChild(addAtomButton)
  
  const title = document.createElement('div');
  const titleWrapper = document.createElement('div');
    titleWrapper.style.cssText = `
    display: flex;
    justify-content: space-between;
    gap:20px;
    margin-top: 2px;
  `;

  title.textContent = 'Modify Atoms/Bonds';
  title.style.cssText = 'font-size:14px; font-weight:500; margin-bottom:10px;';

  titleWrapper.appendChild(title);
  titleWrapper.appendChild(addButtonsRow);
  compDiv.appendChild(titleWrapper);


  // Ensure structure panel starts collapsed by default
  if (panelState != "open") {
    compDiv.classList.remove('open');
    compDiv.style.maxHeight = ''; // reset
    const toggleIcon = document.getElementById('structureToggleIcon');
    if (toggleIcon) {
      toggleIcon.textContent = '+';
      toggleIcon.classList.remove('open');
    }
    const structureToggle = document.getElementById('structureToggle');
    if (structureToggle) {
      structureToggle.setAttribute('aria-expanded', 'false');
      // Rebind listener cleanly
      structureToggle.removeEventListener('click', handleStructurePanelToggle);
      structureToggle.addEventListener('click', handleStructurePanelToggle);
    }
  }

// Create a new div element for the segmented control
const atomBondControl = document.createElement('div');
atomBondControl.id = 'atomBondControl';
atomBondControl.className = "atomBondControl";

// Add the segmented control to the div
const segmentedControl = addSegmentedControl(atomBondControl, 'atomBondControlSwitch');
// Append the div to compDiv
compDiv.appendChild(atomBondControl);

// Create atom panel
const atomPanel = document.createElement("div");
atomPanel.id = "atomPanel";
atomPanel.className = "atomBondClass"; // Add a class for styling
elements.forEach(el => {
  const row = createCompositionRow(el, counts[el], total);
  atomPanel.appendChild(row);
});

// Create bonds panel
const bondsPanel = document.createElement("div");
bondsPanel.id = "bondControls";
bondsPanel.className = "atomBondClass"; // Add a class for styling
// Append panels to compDiv
compDiv.appendChild(atomPanel);
compDiv.appendChild(bondsPanel);

createBondLengthControls("bondControls"); // Make sure to pass the panel element

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
      // You can decide what to show for trajectory mode
      // For now, let's show the atom panel
      showPanel('atomPanel');
    } else if (selectedMode === 'bonds') {
      console.log("mode bonds selected")
      // For comparison mode, maybe show both panels?
      // For now, let's show the bonds panel
      showPanel('bondControls');
    }
  });
});
// Let atoms button be active. Which is button 0 in the list
segmentedControl.querySelectorAll('button')[0].classList.add('active');
showPanel("atomPanel")

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
// Assuming `structureData.lattice` is available
  //
  const volumeDiv = document.createElement("div");
  volumeDiv.style.cssText = `
    margin-top: 8px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.8);
  `;


  compDiv.appendChild(volumeDiv);
  const volume = getLatticeVolume(structureData.lattice);
  console.log(`Lattice Volume: ${volume} Å³`);
  volumeDiv.textContent = `Volume: ${volume} Å³`;

}


function getLatticeVolume(lattice) {
  // Helper functions for vector math
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  // Calculate volume: |a · (b × c)|
  const volume = Math.abs(dot(lattice[0], cross(lattice[1], lattice[2])));
  return volume.toFixed(3); // Round to 3 decimal places
}


// Function to create the segmented control
function createSegmentedControl(containerId) {
  // Create the container div
  const container = document.createElement('div');
  container.className = 'segmented-control';
  container.id = containerId || 'ControlPanelModeSwitch';

  // Create the buttons

  const AtomsButton = document.createElement('button');
  AtomsButton.textContent = 'Atoms';
  AtomsButton.dataset.mode = 'atoms';

  const BondsButton = document.createElement('button');
  BondsButton.textContent = 'Bonds';
  BondsButton.dataset.mode = 'bonds';

  // Add buttons to the container
  container.appendChild(AtomsButton);
  container.appendChild(BondsButton);

  // Add event listeners for the buttons
  container.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', function() {
      // Remove active class from all buttons
      container.querySelectorAll('button').forEach(btn => {
        btn.classList.remove('active');
      });

      // Add active class to the clicked button
      this.classList.add('active');

      // You can add additional logic here to handle mode changes
      const selectedMode = this.dataset.mode;
      console.log(`Selected mode: ${selectedMode}`);
      // For example, you might want to call a function to handle the mode change
      // handleModeChange(selectedMode);
    });
  });

  return container;
}

// Function to add the segmented control to a specific element
function addSegmentedControl(parentElement, containerId) {
  const segmentedControl = createSegmentedControl(containerId);
  parentElement.appendChild(segmentedControl);
  return segmentedControl;
}

 
