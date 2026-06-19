import { general,bondLengths,fileBrowser} from '../state/store.js';
import { addTrajectoryPlayer,removeTrajectoryPlayer} from './TrajectoryPanel.js';
import {removeLatticeComparisonPopup, createLatticeComparisonPopup, updateLatticeComparisonPanel} from './LatticeComparisonPanel.js';
import { removeSpins,updateSpins } from '../render/index.js';
import { removeForces,updateForces } from '../render/index.js';
import { removeHistogramPanel } from './AnalysisPanels/BondAnalysisPanel.js';
import {addSpinPanel,removeSpinPanel} from './SpinPanel.js';
import {addForcePanel,removeForcePanel} from './ForcePanel.js';
import {addBondPanel,removeBondPanel} from './BondPanel.js';
import {addLatticeAndSupercellPanel, removeLatticeAndSupercellPanel} from './LatticeSupercellPanel.js';
import {addFieldPanel, removeFieldPanel} from './FieldPanel.js';
import { addCutPlanePanel, removeCutPlanePanel } from './CutPlanePanel.js';
import {updateVisualization} from '../core/crystal-viewer.js';

/**
 * Adds the comparison panel to the TrajectoryComparisonContainer.
 */
export function addCompPanel() {
  const container = document.getElementById("TrajectoryComparisonContainer");

  // Clear existing content
  container.innerHTML = "";

  // Add toggle for bonds
  const bondToggleContainer = document.createElement("label");
  bondToggleContainer.style.display = "flex";
  bondToggleContainer.style.alignItems = "center";
  bondToggleContainer.style.margin = "10px 0";

  const bondToggleSwitch = document.createElement("span");
  bondToggleSwitch.style.position = "relative";
  bondToggleSwitch.style.display = "inline-block";
  bondToggleSwitch.style.width = "50px";
  bondToggleSwitch.style.height = "24px";

  const bondToggleInput = document.createElement("input");
  bondToggleInput.type = "checkbox";
  bondToggleInput.id = "showComparisonBonds";
  bondToggleInput.checked = true;
  bondToggleInput.style.opacity = "0";
  bondToggleInput.style.width = "0";
  bondToggleInput.style.height = "0";

  const bondToggleSlider = document.createElement("span");
  bondToggleSlider.className = "toggle_slider";
  bondToggleSlider.style.position = "absolute";
  bondToggleSlider.style.cursor = "pointer";
  bondToggleSlider.style.top = "0";
  bondToggleSlider.style.left = "0";
  bondToggleSlider.style.right = "0";
  bondToggleSlider.style.bottom = "0";
  bondToggleSlider.style.backgroundColor = "#ccc";
  bondToggleSlider.style.transition = ".4s";
  bondToggleSlider.style.borderRadius = "24px";

  const bondToggleSliderInner = document.createElement("span");
  bondToggleSliderInner.style.position = "absolute";
  bondToggleSliderInner.style.height = "16px";
  bondToggleSliderInner.style.width = "16px";
  bondToggleSliderInner.style.left = "4px";
  bondToggleSliderInner.style.bottom = "4px";
  bondToggleSliderInner.style.backgroundColor = "white";
  bondToggleSliderInner.style.transition = ".4s";
  bondToggleSliderInner.style.borderRadius = "50%";

  bondToggleSlider.appendChild(bondToggleSliderInner);
  bondToggleSwitch.appendChild(bondToggleInput);
  bondToggleSwitch.appendChild(bondToggleSlider);

  const bondToggleText = document.createElement("span");
  bondToggleText.textContent = "Show Comparison Bonds";
  bondToggleText.style.marginLeft = "10px";

  bondToggleContainer.appendChild(bondToggleSwitch);
  bondToggleContainer.appendChild(bondToggleText);
  container.appendChild(bondToggleContainer);

  // Add toggle for lattice comparison
  const latticeToggleContainer = document.createElement("label");
  latticeToggleContainer.style.display = "flex";
  latticeToggleContainer.style.alignItems = "center";
  latticeToggleContainer.style.margin = "10px 0";

  const latticeToggleSwitch = document.createElement("span");
  latticeToggleSwitch.style.position = "relative";
  latticeToggleSwitch.style.display = "inline-block";
  latticeToggleSwitch.style.width = "50px";
  latticeToggleSwitch.style.height = "24px";

  const latticeToggleInput = document.createElement("input");
  latticeToggleInput.type = "checkbox";
  latticeToggleInput.id = "showLatticeComparison";
  latticeToggleInput.style.opacity = "0";
  latticeToggleInput.style.width = "0";
  latticeToggleInput.style.height = "0";

  const latticeToggleSlider = document.createElement("span");
  latticeToggleSlider.className = "toggle_slider";
  latticeToggleSlider.style.position = "absolute";
  latticeToggleSlider.style.cursor = "pointer";
  latticeToggleSlider.style.top = "0";
  latticeToggleSlider.style.left = "0";
  latticeToggleSlider.style.right = "0";
  latticeToggleSlider.style.bottom = "0";
  latticeToggleSlider.style.backgroundColor = "#ccc";
  latticeToggleSlider.style.transition = ".4s";
  latticeToggleSlider.style.borderRadius = "24px";

  const latticeToggleSliderInner = document.createElement("span");
  latticeToggleSliderInner.style.position = "absolute";
  latticeToggleSliderInner.style.height = "16px";
  latticeToggleSliderInner.style.width = "16px";
  latticeToggleSliderInner.style.left = "4px";
  latticeToggleSliderInner.style.bottom = "4px";
  latticeToggleSliderInner.style.backgroundColor = "white";
  latticeToggleSliderInner.style.transition = ".4s";
  latticeToggleSliderInner.style.borderRadius = "50%";

  latticeToggleSlider.appendChild(latticeToggleSliderInner);
  latticeToggleSwitch.appendChild(latticeToggleInput);
  latticeToggleSwitch.appendChild(latticeToggleSlider);

  const latticeToggleText = document.createElement("span");
  latticeToggleText.textContent = "Show Lattice Comparison";
  latticeToggleText.style.marginLeft = "10px";

  latticeToggleContainer.appendChild(latticeToggleSwitch);
  latticeToggleContainer.appendChild(latticeToggleText);
  container.appendChild(latticeToggleContainer);

  // Add slider for opacity
  const opacitySliderContainer = document.createElement("div");
  opacitySliderContainer.style.display = "flex";
  opacitySliderContainer.style.flexDirection = "column";
  opacitySliderContainer.style.margin = "15px 0";
  opacitySliderContainer.style.width = "100%";

  // Create slider labels container
  const sliderLabels = document.createElement("div");
  sliderLabels.style.display = "flex";
  sliderLabels.style.justifyContent = "space-between";
  sliderLabels.style.marginBottom = "5px";
  sliderLabels.style.fontSize = "12px";
  sliderLabels.style.color = "#ccc";

  // Create left label
  const leftLabel = document.createElement("span");
  leftLabel.textContent = "Main";
  leftLabel.style.textAlign = "left";

  // Create right label
  const rightLabel = document.createElement("span");
  rightLabel.textContent = "Comp";
  rightLabel.style.textAlign = "right";

  // Add labels to container
  sliderLabels.appendChild(leftLabel);
  sliderLabels.appendChild(rightLabel);
  opacitySliderContainer.appendChild(sliderLabels);

  // Create slider
  const opacitySlider = document.createElement("input");
  opacitySlider.type = "range";
  opacitySlider.id = "opacitySlider";
  opacitySlider.min = "0";
  opacitySlider.max = "1";
  opacitySlider.step = "0.01";
  opacitySlider.value = "0.5";
  opacitySlider.style.width = "100%";
  opacitySlider.style.margin = "5px 0";
  opacitySliderContainer.appendChild(opacitySlider);

  container.appendChild(opacitySliderContainer);

  // Add dynamic style for checked state
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    #showComparisonBonds:checked + .toggle_slider {
      background-color: #4CAF50 !important;
    }
    #showComparisonBonds:checked + .toggle_slider > span {
      transform: translateX(26px) !important;
    }
    #showLatticeComparison:checked + .toggle_slider {
      background-color: #4CAF50 !important;
    }
    #showLatticeComparison:checked + .toggle_slider > span {
      transform: translateX(26px) !important;
    }
  `;
  document.head.appendChild(styleElement);

  // Add event listeners
  document.getElementById('showComparisonBonds').addEventListener('change', function() {
    const isChecked = this.checked;
    general.showSecondBond = this.checked;
    updateVisualization({
      SecondBondsUpdate: true,
      //SecondReRenderBonds: true,
    });
  });

  // Event listener for lattice comparison toggle
  document.getElementById('showLatticeComparison').addEventListener('change', function() {
    if (this.checked) {
      // Create or update the lattice comparison popup
      if (fileBrowser.comparisonStructure && fileBrowser.selectedStructure) {
        const L1 = fileBrowser.selectedStructure.lattice.map(row => [...row]);
        const L2 = fileBrowser.comparisonStructure.lattice.map(row => [...row]);
        updateLatticeComparisonPanel(L1, L2);
      }
    } else {
      // Remove the lattice comparison popup
      removeLatticeComparisonPopup();
    }
  });

  const opacitySliderElement = document.getElementById('opacitySlider');

  opacitySliderElement.addEventListener('input', function() {
    const value = parseFloat(this.value);
    if (value < 0.5){
      general.compOpacity = 2*value
      general.mainOpacity = 1.0
      }
    else if (value > 0.5){
      general.mainOpacity = 1-2 * (value - 0.5)
      general.compOpacity = 1.0
      }
    else {
      general.compOpacity =1.0
      general.mainOpacity = 1.0
    }

    updateVisualization({
      atomsUpdate: true,
      bondsUpdate: true,
      SecondBondsUpdate: true,
      SecondAtomsUpdate: true,
    });
  });
}




/**
 * Remove the comparison panel from the TrajectoryComparisonContainer.
 */
export function removeCompPanel() {
  const container = document.getElementById("TrajectoryComparisonContainer");
  container.innerHTML = "";
}


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
      removeCutPlanePanel("TrajectoryComparisonContainer");
      removeCompPanel()
      removeLatticeComparisonPopup();
      console.log("Calling addTrajectoryPlayer()");
      const frames = Array.from({ length: 200 }, (_, i) => i * 0.05);
      addTrajectoryPlayer(frames);

    }
    else if (mode === "comparison") {
      removeCutPlanePanel("TrajectoryComparisonContainer");
      const trajPanel = document.getElementById("TrajControlPanel");
      updateVisualization({
        updateAtoms: true,
        updateBonds: false,
        SecondBondsUpdate: true,
        SecondAtomsUpdate: true,
      });

      if (trajPanel) {
        removeTrajectoryPlayer();
        updateVisualization({
          updateAtoms: true,
          updateBonds: true,
          SecondBondsUpdate: false,
          SecondAtomsUpdate: false,
          });
      }
      if (fileBrowser.comparisonStructure) {
        addCompPanel();
        updateVisualization({
          updateAtoms: true,
          updateBonds: true,
          SecondBondsUpdate: false,
          SecondAtomsUpdate: false,
          });
        console.log("Updating lattice comparison panel");
      }
    }
    else if (mode === "cutplanes") {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
      }
      removeCompPanel();
      removeLatticeComparisonPopup();
      addCutPlanePanel("TrajectoryComparisonContainer");
    }
    else {
      const trajPanel = document.getElementById("TrajControlPanel");
      if (trajPanel) {
        removeTrajectoryPlayer();
      }
      removeCutPlanePanel("TrajectoryComparisonContainer");
      removeCompPanel()
      removeLatticeComparisonPopup();
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

    updateControlSpinForcePanel(mode);
  });
}

export function updateControlSpinForcePanel(mode = general.spinForceState) {
  // Handle different modes
  if (mode == "Forces") {
    removeSpins();
    removeSpinPanel()
    removeFieldPanel();
    addForcePanel()
    updateForces();
    }
  else if (mode == "Spins") {
    console.log("Adding Spin Panel")
    removeForcePanel();
    removeFieldPanel();
    removeForces();
    addSpinPanel();
    updateSpins();
      }
  else if (mode == "Field") {
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
      
      removeCutPlanePanel()
      addLatticeAndSupercellPanel()
    }
    else if (general.analysisState == "Bonds") {
      removeBondPanel()
      addBondPanel()
      removeCutPlanePanel()
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
