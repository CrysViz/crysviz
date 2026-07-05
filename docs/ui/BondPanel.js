import {bondLengths} from '../state/store.js';
import { addHistogramPanel } from './AnalysisPanels/BondAnalysisPanel.js';
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
  const histogramsPanel = document.createElement("div");
  histogramsPanel.id = "histogramsPanel";
  histogramsPanel.style.marginBottom = "10px";
  histogramsPanel.appendChild(makeSectionHeadline("Histograms"));

  const histogramButtonsRow = document.createElement("div");
  histogramButtonsRow.style.display = "flex";
  histogramButtonsRow.style.gap = "8px";
  histogramButtonsRow.style.justifyContent = "center";

  const histogramBtn = document.createElement("button");
  histogramBtn.id = "bondHistogram";
  histogramBtn.className = "btn-mini highlight";
  histogramBtn.textContent = "Histogram";
  histogramBtn.style.fontSize = "12px";

  histogramBtn.onclick = () => {
    const dataArrays = Object.values(bondLengths);
    const labelsArray = Object.keys(bondLengths);
    addHistogramPanel(dataArrays, labelsArray);
  };

  // (The Angle Histogram and Coordination Number buttons were removed: they
  // were unimplemented stubs. Re-add them here once the analysis exists —
  // BondAnalysisPanel's addHistogramPanel already takes arbitrary datasets
  // and axis labels.)

  histogramButtonsRow.appendChild(histogramBtn);
  histogramsPanel.appendChild(histogramButtonsRow);

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
