// Comparison controls: bond visibility for the comparison structure, the
// lattice-comparison popup toggle, and the main/comparison opacity slider.
// Hosted by the unified "Comparison" panel window (ui/panels/defaultPanels.js).
// The comparison structure itself is picked via the checkbox in the structure
// table (ui/FileBrowswerPanel.js); `general.comparisonActive` tracks whether
// the lattice-comparison popup should follow structure/frame changes.
//
// Classic, single-structure mode: exactly one checked row becomes the
// comparison structure (fileBrowser.overlayEntries[0] — same underlying
// engine the Multi-Structure Overlay panel uses, see ui/OverlayPanel.js).
// Mutually exclusive with that panel — both interpret the same file-browser
// checkboxes, so only one mode's rules ("exactly one" vs "any number") can be
// in effect at a time. Enabling this one turns Overlay off, and vice versa.

import { general, fileBrowser } from '../state/store.js';
import { removeLatticeComparisonPopup } from './LatticeComparisonPanel.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { syncOverlayFromCheckboxes, refreshOverlayLatticePlots } from './FileBrowswerPanel.js';

/**
 * Build a labeled toggle switch (the pill-shaped checkbox used throughout
 * this panel). Returns the input element so callers can wire `change`.
 */
function createToggleSwitch(id, labelText, checked) {
  const container = document.createElement("label");
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.margin = "10px 0";

  const switchEl = document.createElement("span");
  switchEl.style.position = "relative";
  switchEl.style.display = "inline-block";
  switchEl.style.width = "50px";
  switchEl.style.height = "24px";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = checked;
  input.style.opacity = "0";
  input.style.width = "0";
  input.style.height = "0";

  const slider = document.createElement("span");
  slider.className = "toggle_slider";
  slider.style.position = "absolute";
  slider.style.cursor = "pointer";
  slider.style.top = "0";
  slider.style.left = "0";
  slider.style.right = "0";
  slider.style.bottom = "0";
  slider.style.backgroundColor = "#ccc";
  slider.style.transition = ".4s";
  slider.style.borderRadius = "24px";

  const sliderInner = document.createElement("span");
  sliderInner.style.position = "absolute";
  sliderInner.style.height = "16px";
  sliderInner.style.width = "16px";
  sliderInner.style.left = "4px";
  sliderInner.style.bottom = "4px";
  sliderInner.style.backgroundColor = "white";
  sliderInner.style.transition = ".4s";
  sliderInner.style.borderRadius = "50%";

  slider.appendChild(sliderInner);
  switchEl.appendChild(input);
  switchEl.appendChild(slider);

  const text = document.createElement("span");
  text.textContent = labelText;
  text.style.marginLeft = "10px";

  container.appendChild(switchEl);
  container.appendChild(text);

  return { container, input };
}

/**
 * Build the comparison panel controls into the given container (one tab's
 * body inside the unified Comparison/Overlay panel — see
 * ui/ComparisonOverlayPanel.js).
 */
export function addCompPanel(container) {
  if (!container) return;

  // Clear existing content
  container.innerHTML = "";

  // Master toggle: checking a file-browser row no longer starts rendering
  // the comparison by itself — this must also be on (ui/FileBrowswerPanel.js's
  // syncOverlayFromCheckboxes reconciles the two).
  const { container: compareToggleContainer, input: compareToggleInput } =
    createToggleSwitch("enableComparisonToggle", "Enable Comparison", general.compareModeOn);
  container.appendChild(compareToggleContainer);

  // Persistent error line: "please select a structure" (nothing checked) or
  // "only one structure can be selected" (2+ checked), while comparison is on.
  // fileBrowser.overlayEntries/general.compareModeOn are kept consistent
  // continuously by syncOverlayFromCheckboxes (every checkbox change, row
  // delete, ...), so this only needs to reflect current state — it must NOT
  // call syncOverlayFromCheckboxes itself, which would rebuild this very
  // panel and recurse.
  const comparisonError = document.createElement("div");
  comparisonError.id = "comparisonErrorField";
  comparisonError.style.cssText = `
    font-size: 12px;
    color: #ff6b6b;
    margin: 0 0 10px 0;
    display: none;
  `;
  if (general.compareModeOn && fileBrowser.overlayEntries.length === 0) {
    // Distinguish "nothing checked" from "too many checked" the same way
    // syncOverlayFromCheckboxes does — both leave overlayEntries empty, so
    // that alone can't tell them apart (a rebuild right after a ">1 checked"
    // error would otherwise clobber it back to the generic "select a
    // structure" message).
    const checkedCount = document.querySelectorAll('#objectTable tbody input[type="checkbox"]:checked').length;
    comparisonError.textContent = checkedCount > 1
      ? 'Only one structure can be selected for comparison.'
      : 'Please select a structure to compare to.';
    comparisonError.style.display = 'block';
  }
  container.appendChild(comparisonError);

  // Add toggle for bonds
  const { container: bondToggleContainer, input: bondToggleInput } =
    createToggleSwitch("showComparisonBonds", "Show Comparison Bonds", general.showSecondBond);
  container.appendChild(bondToggleContainer);

  // Add toggle for lattice comparison
  const { container: latticeToggleContainer, input: latticeToggleInput } =
    createToggleSwitch("showLatticeComparison", "Show Lattice Comparison", general.comparisonActive);
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

  // Polyhedra aren't rendered for the comparison structure yet — the main
  // pipeline's WASM/worker compute, cage detection, and "Complete Polyhedra"
  // atom-completion aren't safely separable per-structure without more work,
  // so this is deferred rather than half-implemented. Only shown when
  // polyhedra are actually visible, so it doesn't clutter the panel otherwise.
  if (general.showPolyhedra) {
    const polyhedraNote = document.createElement("div");
    polyhedraNote.textContent = "Note: Polyhedra are not yet shown for the comparison structure.";
    polyhedraNote.style.fontSize = "12px";
    polyhedraNote.style.color = "#ccc";
    polyhedraNote.style.fontStyle = "italic";
    polyhedraNote.style.margin = "5px 0 10px 0";
    container.appendChild(polyhedraNote);
  }

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
    #enableComparisonToggle:checked + .toggle_slider {
      background-color: #4CAF50 !important;
    }
    #enableComparisonToggle:checked + .toggle_slider > span {
      transform: translateX(26px) !important;
    }
  `;
  document.head.appendChild(styleElement);

  // Add event listeners
  compareToggleInput.addEventListener('change', function() {
    general.compareModeOn = this.checked;
    // Mutually exclusive with the Multi-Structure Overlay panel — both
    // interpret the same file-browser checkboxes, so only one mode's rules
    // can apply.
    if (general.compareModeOn) general.overlayModeOn = false;
    syncOverlayFromCheckboxes();
  });

  bondToggleInput.addEventListener('change', function() {
    general.showSecondBond = this.checked;
    if (fileBrowser.overlayEntries[0]) fileBrowser.overlayEntries[0].showBonds = this.checked;
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
      refreshOverlayLatticePlots();
    } else {
      removeLatticeComparisonPopup();
    }
  });

  opacitySlider.addEventListener('input', function() {
    const value = parseFloat(this.value);
    let compOpacity;
    let mainOpacity;
    if (value < 0.5){
      compOpacity = 2*value
      mainOpacity = 1.0
      }
    else if (value > 0.5){
      mainOpacity = 1-2 * (value - 0.5)
      compOpacity = 1.0
      }
    else {
      compOpacity = 1.0
      mainOpacity = 1.0
    }

    general.mainOpacity = mainOpacity;
    if (fileBrowser.overlayEntries[0]) fileBrowser.overlayEntries[0].opacity = compOpacity;

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
export function removeCompPanel(container) {
  if (container) container.innerHTML = "";
  general.comparisonActive = false;
  removeLatticeComparisonPopup();
}
