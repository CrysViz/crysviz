import { general,bondLengths} from '../store.js';
import { addTrajectoryPlayer,removeTrajectoryPlayer} from './TrajectoryPanel.js';
import { addLatticeComparisonPanel } from './LatticeComparisonPanel.js';
import { removeSpins,updateSpins } from '../modules/SpinModule.js';
import { addHistogramPanel,removeHistogramPanel } from './AnalysisPanels/BondAnalysisPanel.js';



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
    if (general.playerModeState == "trajectory") {
      console.log("calling addTrajectoryPlayer()")
        const frames = Array.from({ length: 200 }, (_, i) => i * 0.05);
        addTrajectoryPlayer(frames);
      } 
    else if (general.playerModeState == "comparison") {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
        }
      } 
    else {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
      }
    }

    console.log(general.playerModeState);
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
      //updateForces();
      }
    else if (general.spinForceState == "Spins") {
      //removeForces();
      console.log("updating spins")
      updateSpins();
        }
    else {
      //removeForces
      removeSpins();
    }
  });
}

const ControlPanelAnalysisSwitch = document.getElementById("ControlPanelAnalysisSwitch");
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
    }
    else if (general.analysisState == "Bonds") {
      const dataArrays = Object.values(bondLengths);
      const labelsArray = Object.keys(bondLengths);
      console.log(dataArrays)
      console.log(labelsArray)
      addHistogramPanel(dataArrays, labelsArray)
     }
    else if (general.analysisState == "TBD") {
      console.warn("TBD analysis not yet implemented!")
      removeHistogramPanel()
    }
    else {
      removeHistogramPanel()
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



