import {bondLengths} from '../state/store.js';
import { addHistogramPanel } from './AnalysisPanels/BondAnalysisPanel.js';

export function addBondPanel(target = "BondLatticeContainer") {
  const targetPanel = document.getElementById(target);

  //if (document.getElementById("bondControlsGroup")) {
  //  console.warn("Bond Controls already exist.");
  //  return;
   // }

  // --- Outer wrapper (dark grey background) ---
  const group = document.createElement("div");
  group.id = "bondControlsGroup";
  group.style.padding = "10px";
   // group.style.borderRadius = "5px";
  //group.style.border = "1px solid rgba(255, 255, 255, 0.3)";
  //group.style.backgroundColor = "#333"; // Added for consistency

  // --- Histograms Panel ---
  const histogramsPanel = document.createElement("div");
  histogramsPanel.id = "histogramsPanel";
  histogramsPanel.style.marginBottom = "10px";

  const histogramsToggle = document.createElement("div");
  histogramsToggle.id = "histogramsToggle";
  histogramsToggle.className = "bond-toggle";
  histogramsToggle.setAttribute("role", "button");
  histogramsToggle.setAttribute("tabindex", "0");
  histogramsToggle.setAttribute("aria-expanded", "false");
  histogramsToggle.setAttribute("aria-controls", "histogramsContent");

  const histogramsTitle = document.createElement("h4");
  histogramsTitle.textContent = "Histograms";

  const histogramsIcon = document.createElement("div");
  histogramsIcon.id = "histogramsToggleIcon";
  histogramsIcon.className = "toggle-icon";
  histogramsIcon.textContent = "+";

  histogramsToggle.appendChild(histogramsTitle);
  histogramsToggle.appendChild(histogramsIcon);

  const histogramsContent = document.createElement("div");
  histogramsContent.id = "histogramsContent";
  histogramsContent.className = "collapsible-content"; // Fixed: className instead of classname
  histogramsContent.setAttribute("aria-hidden", "true");

  // --- Histogram buttons row (centered) ---
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

  const angleHistogramBtn = document.createElement("button");
  angleHistogramBtn.id = "angleHistogram";
  angleHistogramBtn.className = "btn-mini highlight";
  angleHistogramBtn.textContent = "Angle Histogram";
  angleHistogramBtn.style.fontSize = "12px";

  angleHistogramBtn.onclick = () => {
    console.warn("Clicked Angle Histogram button");
    // Add your logic for angle histogram here
  };

  const coordinationNumberBtn = document.createElement("button");
  coordinationNumberBtn.id = "coordinationNumber";
  coordinationNumberBtn.className = "btn-mini highlight";
  coordinationNumberBtn.textContent = "Coordination Number";
  coordinationNumberBtn.style.fontSize = "12px";

  coordinationNumberBtn.onclick = () => {
    console.warn("Clicked Coordination Number button");
    // Add your logic for coordination number here
  };

  histogramButtonsRow.appendChild(histogramBtn);
  histogramButtonsRow.appendChild(angleHistogramBtn);
  histogramButtonsRow.appendChild(coordinationNumberBtn);

  histogramsContent.appendChild(histogramButtonsRow);

  histogramsPanel.appendChild(histogramsToggle);
  histogramsPanel.appendChild(histogramsContent);

  // --- Draw Bonds Panel ---
  const drawBondsPanel = document.createElement("div");
  drawBondsPanel.id = "drawBondsPanel";
  drawBondsPanel.style.marginBottom = "10px";

  const drawBondsToggle = document.createElement("div");
  drawBondsToggle.id = "drawBondsToggle";
  drawBondsToggle.className = "bond-toggle";
  drawBondsToggle.setAttribute("role", "button");
  drawBondsToggle.setAttribute("tabindex", "0");
  drawBondsToggle.setAttribute("aria-expanded", "false");
  drawBondsToggle.setAttribute("aria-controls", "drawBondsContent");

  const drawBondsTitle = document.createElement("h4");
  drawBondsTitle.textContent = "Draw Bonds";

  const drawBondsIcon = document.createElement("div");
  drawBondsIcon.id = "drawBondsToggleIcon";
  drawBondsIcon.className = "toggle-icon";
  drawBondsIcon.textContent = "+";

  drawBondsToggle.appendChild(drawBondsTitle);
  drawBondsToggle.appendChild(drawBondsIcon);

  const drawBondsContent = document.createElement("div");
  drawBondsContent.id = "drawBondsContent";
  drawBondsContent.className = "collapsible-content";
  drawBondsContent.setAttribute("aria-hidden", "true");

  // --- Draw/undo/delete buttons row (centered) ---
  const drawBondWrapper = document.createElement("div");
  drawBondWrapper.id = "drawBondWrapper";
  drawBondWrapper.className = "drawBondWrapper";
  drawBondWrapper.style.display = "flex";
  drawBondWrapper.style.gap = "8px";
  drawBondWrapper.style.justifyContent = "center";

  const drawBondsBtn = document.createElement("button");
  drawBondsBtn.id = "drawBondBtn";
  drawBondsBtn.className = "btn-mini highlight";
  drawBondsBtn.textContent = "🖋️";
  drawBondsBtn.style.fontSize = "24px";

  drawBondsBtn.onclick = () => {
    console.warn("Clicked draw bonds button");
  };

  const undoDrawBtn = document.createElement("button");
  undoDrawBtn.id = "undoDrawBtn";
  undoDrawBtn.className = "btn-mini highlight";
  undoDrawBtn.textContent = "↩";
  undoDrawBtn.style.fontSize = "24px";

  undoDrawBtn.onclick = () => {
    console.warn("Clicked undo draw bonds button");
  };

  const deleteDrawBtn = document.createElement("button");
  deleteDrawBtn.id = "deleteDrawBtn";
  deleteDrawBtn.className = "btn-mini highlight";
  deleteDrawBtn.textContent = "🗑️";
  deleteDrawBtn.style.fontSize = "24px";

  deleteDrawBtn.onclick = () => {
    console.warn("Clicked delete draw bonds button");
  };

  drawBondWrapper.appendChild(drawBondsBtn);
  drawBondWrapper.appendChild(undoDrawBtn);
  drawBondWrapper.appendChild(deleteDrawBtn);

  drawBondsContent.appendChild(drawBondWrapper);

  drawBondsPanel.appendChild(drawBondsToggle);
  drawBondsPanel.appendChild(drawBondsContent);

  // --- Bond Length Controls Panel ---
  const bondLengthPanel = document.createElement("div");
  bondLengthPanel.id = "bondLengthPanel";

  const bondLengthToggle = document.createElement("div");
  bondLengthToggle.id = "bondLengthToggle";
  bondLengthToggle.className = "bond-toggle";
  bondLengthToggle.setAttribute("role", "button");
  bondLengthToggle.setAttribute("tabindex", "0");
  bondLengthToggle.setAttribute("aria-expanded", "false");
  bondLengthToggle.setAttribute("aria-controls", "bondLengthContent");



  // --- Toggle logic for Histograms ---
  function setHistogramsOpen(open) {
    if (open) {
      histogramsContent.classList.add("open");
      histogramsContent.setAttribute("aria-hidden", "false");
      histogramsIcon.textContent = "−";
      histogramsToggle.setAttribute("aria-expanded", "true");
    } else {
      histogramsContent.classList.remove("open");
      histogramsContent.setAttribute("aria-hidden", "true");
      histogramsIcon.textContent = "+";
      histogramsToggle.setAttribute("aria-expanded", "false");
    }
  }

  histogramsToggle.addEventListener("click", () =>
    setHistogramsOpen(!histogramsContent.classList.contains("open"))
  );

  histogramsToggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setHistogramsOpen(!histogramsContent.classList.contains("open"));
    }
  });

  // --- Toggle logic for Draw Bonds ---
  function setDrawBondsOpen(open) {
    if (open) {
      drawBondsContent.classList.add("open");
      drawBondsContent.setAttribute("aria-hidden", "false");
      drawBondsIcon.textContent = "−";
      drawBondsToggle.setAttribute("aria-expanded", "true");
    } else {
      drawBondsContent.classList.remove("open");
      drawBondsContent.setAttribute("aria-hidden", "true");
      drawBondsIcon.textContent = "+";
      drawBondsToggle.setAttribute("aria-expanded", "false");
    }
  }

  setDrawBondsOpen(false);

  drawBondsToggle.addEventListener("click", () =>
    setDrawBondsOpen(!drawBondsContent.classList.contains("open"))
  );

  drawBondsToggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setDrawBondsOpen(!drawBondsContent.classList.contains("open"));
    }
  });


  // --- Build structure ---
  group.appendChild(histogramsPanel);
  group.appendChild(drawBondsPanel);
  targetPanel.appendChild(group);

  // Open histograms immediately — bypass CSS transition by setting inline style
  setHistogramsOpen(true);
  histogramsContent.style.maxHeight = "600px";

  // --- Create bond controls ---
}



export function removeBondPanel() {
  const panel = document.getElementById("bondControlsGroup");
  if (panel) {
    panel.remove();
  } else {
    console.warn("Bond Controls panel does not exist.");
  }
}

