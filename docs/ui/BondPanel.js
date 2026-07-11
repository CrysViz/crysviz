import { addBondLengthHistogramPanel, openBondLengthHistogramSplitView } from './AnalysisPanels/BondLengthHistogram.js';
import { addCoordinationHistogramPanel, openCoordinationHistogramSplitView } from './AnalysisPanels/CoordinationHistogram.js';
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
  // Each histogram offers two independent, mutually non-exclusive entry
  // points: "Panel" opens the existing floating/dockable window; "Split
  // View" opens the same live chart in the shared split pane (the same
  // mechanism the EOS Fit and Energy Landscape panels use) — see
  // AnalysisPanels/BondLengthHistogram.js and CoordinationHistogram.js.
  const histogramsPanel = document.createElement("div");
  histogramsPanel.id = "histogramsPanel";
  histogramsPanel.style.marginBottom = "10px";
  histogramsPanel.appendChild(makeSectionHeadline("Histograms"));

  function addHistogramRow(label, openPanel, openSplitView) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "8px";
    row.style.marginBottom = "6px";

    const nameLabel = document.createElement("span");
    nameLabel.textContent = label;
    nameLabel.style.cssText = "font-size:12px; color:#ccc;";

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "6px";

    const panelBtn = document.createElement("button");
    panelBtn.className = "btn-mini highlight";
    panelBtn.textContent = "Panel";
    panelBtn.title = `Open ${label} as a floating window`;
    panelBtn.style.fontSize = "12px";
    panelBtn.onclick = openPanel;

    const splitBtn = document.createElement("button");
    splitBtn.className = "btn-mini";
    splitBtn.textContent = "Split View";
    splitBtn.title = `Open ${label} in the split view beside the 3D scene`;
    splitBtn.style.fontSize = "12px";
    splitBtn.onclick = openSplitView;

    btnRow.append(panelBtn, splitBtn);
    row.append(nameLabel, btnRow);
    histogramsPanel.appendChild(row);
  }

  addHistogramRow("Bond Length", addBondLengthHistogramPanel, openBondLengthHistogramSplitView);
  addHistogramRow("Coordination Number", addCoordinationHistogramPanel, openCoordinationHistogramSplitView);

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
