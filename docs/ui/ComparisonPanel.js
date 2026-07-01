// Comparison controls: bond visibility for the comparison structure, the
// lattice-comparison popup toggle, and the main/comparison opacity slider.
// Hosted by the unified "Comparison" panel window (ui/panels/defaultPanels.js).
// The comparison structure itself is picked via the checkbox in the structure
// table (ui/FileBrowswerPanel.js); `general.comparisonActive` tracks whether
// the lattice-comparison popup should follow structure/frame changes.

import { general, fileBrowser } from '../state/store.js';
import { removeLatticeComparisonPopup, updateLatticeComparisonPanel } from './LatticeComparisonPanel.js';
import { updateVisualization } from '../core/crystal-viewer.js';

/**
 * Build the comparison panel controls into the given container.
 */
export function addCompPanel(target = "cvPanelBody-comparison") {
  const container = document.getElementById(target);
  if (!container) return;

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
  bondToggleInput.addEventListener('change', function() {
    general.showSecondBond = this.checked;
    updateVisualization({
      SecondBondsUpdate: true,
      //SecondReRenderBonds: true,
    });
  });

  // Event listener for lattice comparison toggle. The flag makes structure/
  // frame changes keep the popup in sync (ui/FileBrowswerPanel.js).
  latticeToggleInput.addEventListener('change', function() {
    general.comparisonActive = this.checked;
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

  opacitySlider.addEventListener('input', function() {
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
 * Tear down the comparison panel: clears the controls, closes the
 * lattice-comparison popup, and deactivates its follow-updates flag.
 */
export function removeCompPanel(target = "cvPanelBody-comparison") {
  const container = document.getElementById(target);
  if (container) container.innerHTML = "";
  general.comparisonActive = false;
  removeLatticeComparisonPopup();
}
