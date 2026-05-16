import { app, groups,fileBrowser, general, mode, highlightHover} from '../../store.js';
import { defaultColorMap, jmolColorMap,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../../defaults/color_texture_defaults.js'
import { updateVisualization } from '../../crystal-viewer.js';


import { createColorPicker } from '../../modules/ColorPickerModule.js';
import { createSupercell} from '../../modules/SuperCellModule.js';
import { resetView,collapseAllAtomExpansions} from '../../panels/WindowAndSceneControls.js'
import { createCompositionRow, createWyckoffCompositionRow} from './Species.js'
import { createSpecificBondControl} from './Bonds.js'
import { createBondLengthControls} from '../BondLengthPanel.js'
import { latticeVolume } from '../../modules/math/index.js';


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
    if (!fileBrowser.selectedStructure) return {};
      const counts = {};
      fileBrowser.selectedStructure.elements.forEach(e => counts[e] = (counts[e] || 0) + 1);
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
  const hasWyckoffPanel = fileBrowser.selectedStructure?.symmetry?.mode === 'wyckoff'
    && (fileBrowser.selectedStructure.symmetry.orbitGroups?.length ?? 0) > 0;
  if (!hasWyckoffPanel || general.structurePanelMode === 'atoms') {
    general.structurePanelMode = hasWyckoffPanel ? 'wyckoff' : 'atoms';
  }

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

const resetAtomsBtn = document.createElement('button');
resetAtomsBtn.id = "resetAtomsBtn"
resetAtomsBtn.textContent = 'Reset Atoms';
resetAtomsBtn.className = 'reset-btn';
resetAtomsBtn.style.cssText = 'height: 32px; padding: 0 10px; font-size: 11px; margin-right: 4px; min-width: 44px;';

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
// Append panels to compDiv
if (!hasWyckoffPanel) compDiv.appendChild(atomPanel);
compDiv.appendChild(bondsPanel);
if (hasWyckoffPanel) compDiv.appendChild(wyckoffPanel);

createSpecificBondControl("infoBondControls");



createBondLengthControls("infoBondControls"); // Make sure to pass the panel element

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
    } else if (selectedMode === 'wyckoff' && hasWyckoffPanel) {
      general.structurePanelMode = 'wyckoff';
      showPanel('wyckoffPanel');
    }
  });
});
const initialMode = hasWyckoffPanel
  ? (general.structurePanelMode === 'bonds' ? 'bonds' : 'wyckoff')
  : (general.structurePanelMode === 'bonds' ? 'bonds' : 'atoms');
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
showPanel(initialMode === 'bonds' ? 'infoBondControls' : (initialMode === 'wyckoff' ? 'wyckoffPanel' : 'atomPanel'))

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

  const WyckoffButton = document.createElement('button');
  WyckoffButton.textContent = 'Wyckoff';
  WyckoffButton.dataset.mode = 'wyckoff';

  if (includeWyckoff) {
    container.appendChild(WyckoffButton);
    container.appendChild(BondsButton);
  } else {
    container.appendChild(AtomsButton);
    container.appendChild(BondsButton);
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

      // You can add additional logic here to handle mode changes
      const selectedMode = this.dataset.mode;
      // For example, you might want to call a function to handle the mode change
      // handleModeChange(selectedMode);
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

 
