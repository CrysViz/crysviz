import { general,bondLengths,fileBrowser} from '../store.js';
import { addTrajectoryPlayer,removeTrajectoryPlayer} from './TrajectoryPanel.js';
import { createLatticeComparisonPopup, updateLatticeComparisonPanel} from './LatticeComparisonPanel.js';
import { removeSpins,updateSpins } from '../modules/SpinModule.js';
import { removeForces,updateForces } from '../modules/ForceModule.js';
import { removeHistogramPanel } from './AnalysisPanels/BondAnalysisPanel.js';
import {createSpinControls,addSpinPanel,removeSpinPanel} from './SpinPanel.js';
import {addForcePanel,removeForcePanel} from './ForcePanel.js';
import {addBondPanel,removeBondPanel} from './BondPanel.js';
import {addLatticeAndSupercellPanel, removeLatticeAndSupercellPanel} from './LatticeSupercellPanel.js';
import {addFieldPanel, removeFieldPanel} from './FieldPanel.js';
import {updateVisualization} from '../crystal-viewer.js';



const ControlPanelModeSwitch = document.getElementById("ControlPanelModeSwitch");
export function addControlPanelModeSwitch() {
  ControlPanelModeSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.mode) return;

    const mode = btn.dataset.mode;
    general.playerModeState = mode;

    // Update UI
    ControlPanelModeSwitch.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Handle different modes
    if (mode === "trajectory") {
      console.log("Calling addTrajectoryPlayer()");
      const frames = Array.from({ length: 200 }, (_, i) => i * 0.05);
      addTrajectoryPlayer(frames);
    }
    else if (mode === "comparison") {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
      }
      if (fileBrowser.comparisonStructure) {
        console.log("Updating lattice comparison panel");
        createLatticeComparisonPopup();
        const L1 = fileBrowser.selectedStructure.lattice.map(row => [...row]);
        const L2 = fileBrowser.comparisonStructure.lattice.map(row => [...row]);
        updateLatticeComparisonPanel(L1, L2);
      }
    }
    else {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
      }
    }
    console.log("Current mode:", general.playerModeState);
  });
}


const ControlPanelSpinForceSwitch = document.getElementById("ControlPanelSpinForceSwitch");
export function addControlPanelSpinForceSwitch() {

  ControlPanelSpinForceSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.mode) return;

    const mode = btn.dataset.mode;
    general.spinForceState = mode;

    // Update UI
    ControlPanelSpinForceSwitch.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Handle different modes
    if (general.spinForceState == "Forces") {
      removeSpins();
      removeSpinPanel()
      removeFieldPanel();
      addForcePanel()
      updateForces();
      }
    else if (general.spinForceState == "Spins") {
      //removeForces();
      addSpinPanel()
      createSpinControls();
      updateSpins();
      removeForcePanel();
      removeFieldPanel();
      removeForces()
        }
    else if (general.spinForceState == "Field") {
      removeSpinPanel();
      removeForcePanel();
      removeForces();
      removeSpins();
      addFieldPanel();
        }
    else {
      //removeForces
      removeSpins();
      removeSpinPanel();
      removeForcePanel();
      removeFieldPanel();
      removeForces()
      //remove  vectorFieldPanel();
    }
  });
}

export function addControlPanelAnalysisSwitch() {
  ControlPanelAnalysisSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !btn.dataset.mode) return;

    const mode = btn.dataset.mode;
    general.analysisState = mode;

    // Update UI
    ControlPanelAnalysisSwitch.querySelectorAll("button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Handle different modes
    if (general.analysisState == "Lattice") {
      console.warn("Lattice analysis not yet implemented!")
      removeHistogramPanel()
      removeBondPanel()
      addLatticeAndSupercellPanel()
    }
    else if (general.analysisState == "Bonds") {
      addBondPanel()
      removeLatticeAndSupercellPanel()
     }
    else if (general.analysisState == "Polyhedra") {
      removeBondPanel()
      console.warn("Polyhedera analysis not yet implemented!")
      removeHistogramPanel()
      removeLatticeAndSupercellPanel()
    }
    else {
      removeHistogramPanel()
      removeBondPanel()
      removeLatticeAndSupercellPanel()
    }
  });
}


export function resetSwitch(switchContainer, stateKey, defaultMode = "None") {
  // Update internal state
  general[stateKey] = defaultMode;

  // Remove active class from all buttons
  const buttons = switchContainer.querySelectorAll("button");
  buttons.forEach(btn => btn.classList.remove("active"));

  // Find button with matching data-mode (case-insensitive)
  const defaultBtn = Array.from(buttons).find(
    btn => btn.dataset.mode && btn.dataset.mode.trim().toLowerCase() === defaultMode.toLowerCase()
  );

  if (defaultBtn) {
    defaultBtn.classList.add("active");
  } else {
    console.warn(`No button with data-mode="${defaultMode}" found in`, switchContainer);
  }
}

// Convenience functions
export function resetSpinForceSwitch() {
  resetSwitch(ControlPanelSpinForceSwitch, "spinForceState", "None");
}

export function resetModeSwitch() {
  resetSwitch(ControlPanelModeSwitch, "modeState", "None");
  removeTrajectoryPlayer();
}



