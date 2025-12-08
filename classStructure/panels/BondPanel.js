import { app,bondLengths, groups, general, structureData, mode, atomicRadii,getLatticeVisSettings,getAtomVisSettings} from '../store.js';
import {resetBondLengths,createBondLengthControls} from './BondLengthPanel.js';
import { addHistogramPanel,removeHistogramPanel } from './AnalysisPanels/BondAnalysisPanel.js';

export function addBondPanel(target = "BondLatticeContainer") {
  const targetPanel = document.getElementById(target);
  if (document.getElementById("bondControlsGroup")) {
    console.warn("Bond Controls already exist.");
    return;
  }

  // --- Outer wrapper ---
  const group = document.createElement("div");
  group.id = "bondControlsGroup";

  // --- Panel ---
  const panel = document.createElement("div");
  panel.id = "bondPanel";

  // --- Toggle ---
  const toggle = document.createElement("div");
  toggle.id = "bondToggle";
  toggle.className = "bond-toggle";
  toggle.setAttribute("role", "button");
  toggle.setAttribute("tabindex", "0");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "bondControlsContent");

  const title = document.createElement("h4");
  title.textContent = "Bond Length Controls";

  const icon = document.createElement("div");
  icon.id = "bondToggleIcon";
  icon.className = "toggle-icon";
  icon.textContent = "+";

  toggle.appendChild(title);
  toggle.appendChild(icon);

  // --- Collapsible content ---
  const content = document.createElement("div");
  content.id = "bondControlsContent";
  content.className = "collapsible-content";
  content.setAttribute("aria-hidden", "true");

  // --- Reset wrapper + button ---
  const resetWrapper = document.createElement("div");
  resetWrapper.id = "resetBondLenghtsWrapper";
  resetWrapper.className = "bottonWrapper";
  resetWrapper.setAttribute("aria-hidden", "true");
  resetWrapper.style.display = "flex";
  resetWrapper.style.gap = "8px";

  const resetBtn = document.createElement("button");
  resetBtn.id = "resetBondLengths";
  resetBtn.className = "reset-btn";
  resetBtn.textContent = "Reset to Defaults";
  resetWrapper.style.fonsize = "12px";

  resetBtn.onclick = resetBondLengths;

  const histogramBtn = document.createElement("button");
  histogramBtn.id = "bondHistogram";
  histogramBtn.className = "btn-mini highlight";
  histogramBtn.textContent = "Histogram";
  histogramBtn.style.fonsize = "12px";

  histogramBtn.onclick = () => {
      const dataArrays = Object.values(bondLengths);
      const labelsArray = Object.keys(bondLengths);
    addHistogramPanel(dataArrays, labelsArray);

  }  

  resetWrapper.appendChild(resetBtn);
  resetWrapper.appendChild(histogramBtn);

  // --- Bond Controls container ---
  const controls = document.createElement("div");
  controls.id = "bondControls";

  // Build structure
  content.appendChild(resetWrapper);
  content.appendChild(controls);

  panel.appendChild(toggle);
  panel.appendChild(content);

  group.appendChild(panel);

  // Insert into DOM
  targetPanel.appendChild(group);

  // --- Toggle script (same logic as spin panel) ---

  function setOpen(open) {
    if (open) {
      content.classList.add("open");
      content.setAttribute("aria-hidden", "false");
      icon.textContent = "−";
      toggle.setAttribute("aria-expanded", "true");
    } else {
      content.classList.remove("open");
      content.setAttribute("aria-hidden", "true");
      icon.textContent = "+";
      toggle.setAttribute("aria-expanded", "false");
    }
  }

  setOpen(false);

  toggle.addEventListener("click", () =>
    setOpen(!content.classList.contains("open"))
  );

  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(!content.classList.contains("open"));
    }
  });
  createBondLengthControls()
}


export function removeBondPanel() {
  const panel = document.getElementById("bondControlsGroup");
  if (panel) {
    panel.remove();
  } else {
    console.warn("Bond Controls panel does not exist.");
  }
}

