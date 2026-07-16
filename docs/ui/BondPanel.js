import { addBondLengthHistogramPanel } from './AnalysisPanels/BondLengthHistogram.js';
import { addCoordinationHistogramPanel } from './AnalysisPanels/CoordinationHistogram.js';
import { makeSectionHeadline } from './panels/sectionHeadline.js';

// The Bonds window body: flat headline + content sections (the window itself
// is collapsible, so the sections are not). The per-pair min/max bond-length
// sliders live in the Structure window's Bonds tab (BondLengthPanel.js into
// #infoBondControls), not here.

export function addBondPanel(target = "cvPanelBody-bonds") {
  const targetPanel = document.getElementById(target);

  const group = document.createElement("div");
  group.id = "bondControlsGroup";
  group.style.padding = "10px";

  // --- Histograms ---
  // One button per histogram: each opens ONE ordinary panel window
  // (AnalysisPanels/BondLengthHistogram.js, CoordinationHistogram.js) that
  // defaults to the right dock — from there the user drags its tab out to
  // float, or into the left bar, like any other window.
  const histogramsPanel = document.createElement("div");
  histogramsPanel.id = "histogramsPanel";
  histogramsPanel.style.marginBottom = "10px";
  histogramsPanel.appendChild(makeSectionHeadline("Histograms"));

  function addHistogramRow(label, buttonId, openWindow) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "8px";
    row.style.marginBottom = "6px";

    const nameLabel = document.createElement("span");
    nameLabel.textContent = label;
    nameLabel.style.cssText = "font-size:12px; color:#ccc;";

    const openBtn = document.createElement("button");
    openBtn.id = buttonId;
    openBtn.className = "btn-mini highlight";
    openBtn.textContent = "Open";
    openBtn.title = `Open the ${label} window`;
    openBtn.style.fontSize = "12px";
    openBtn.onclick = openWindow;

    row.append(nameLabel, openBtn);
    histogramsPanel.appendChild(row);
  }

  addHistogramRow("Bond Length", "openBondLengthHistogram", addBondLengthHistogramPanel);
  addHistogramRow("Coordination Number", "openCoordinationHistogram", addCoordinationHistogramPanel);

  // --- Draw Bonds ---
  // Hidden for now: the draw/undo/delete-bond buttons are non-functional stubs
  // (they only console.warn). Re-enable this section once the feature exists.

  // --- Build structure ---
  group.appendChild(histogramsPanel);
  targetPanel.appendChild(group);
}



export function removeBondPanel() {
  const panel = document.getElementById("bondControlsGroup");
  if (panel) {
    panel.remove();
  } else {
    console.warn("Bond Controls panel does not exist.");
  }
}
