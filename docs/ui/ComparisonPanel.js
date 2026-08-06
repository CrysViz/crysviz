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
  container.className = "cmp-toggle-row";

  const switchEl = document.createElement("span");
  switchEl.className = "cmp-toggle-switch";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = checked;
  input.className = "cmp-toggle-checkbox";

  // className stays "toggle_slider" (not renamed/extended) — the checked-state
  // rules below key off this exact class via `#id:checked + .toggle_slider`.
  // Its box styling (position/background/etc.) is scoped in CSS under
  // .cmp-toggle-switch so it wins over toggle_styles.css's own `.toggle_slider`
  // rule regardless of stylesheet load order.
  const slider = document.createElement("span");
  slider.className = "toggle_slider";

  const sliderInner = document.createElement("span");
  sliderInner.className = "cmp-toggle-knob";

  slider.appendChild(sliderInner);
  switchEl.appendChild(input);
  switchEl.appendChild(slider);

  const text = document.createElement("span");
  text.textContent = labelText;
  text.className = "cmp-toggle-label";

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
  comparisonError.className = "cmp-comparison-error";
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
  opacitySliderContainer.className = "cmp-opacity-container";

  // Create slider labels container
  const sliderLabels = document.createElement("div");
  sliderLabels.className = "cmp-opacity-labels";

  // Create left label
  const leftLabel = document.createElement("span");
  leftLabel.textContent = "Main";
  leftLabel.className = "cmp-opacity-label--left";

  // Create right label
  const rightLabel = document.createElement("span");
  rightLabel.textContent = "Comp";
  rightLabel.className = "cmp-opacity-label--right";

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
  opacitySlider.className = "cmp-opacity-slider";
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
    polyhedraNote.className = "cmp-polyhedra-note";
    container.appendChild(polyhedraNote);
  }

  // Checked-state colours for the three toggles above live in
  // analysisPanels.css (.cmp- rules) — previously a <style> block re-injected
  // into <head> on every addCompPanel() call (once per panel open).

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
