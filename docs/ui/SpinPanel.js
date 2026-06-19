import * as THREE from '../external/three/three.module.js';
import { updateSpins, deleteSpins } from '../render/index.js';
import { app, groups, fileBrowser, general } from '../state/store.js';
import {getColorFromMap,getHeatMapColors,getBatlowColors,getHawaiiColors,getManaguaColors,getViridisColors,getPlasmaColors,getSpectralRColors} from '../defaults/color_texture_defaults.js'
import { Spin } from '../model/Spin.js'; // Update path


// Helper function to create elements
function createElement(tag, attributes = {}, styles = {}, textContent = "") {
  const el = document.createElement(tag);
  Object.entries(attributes).forEach(([k, v]) => el.setAttribute(k, v));
  Object.entries(styles).forEach(([k, v]) => (el.style[k] = v));
  if (textContent) el.textContent = textContent;
  return el;
}

function createColorBar(container, colormap, minValue, maxValue, sourceSelect, parseManualSpins) {
  container.innerHTML = '';

  const wrapper = createElement("div", {}, {
    display: "flex",
    alignItems: "center",
    width: "100%",
    marginTop: "6px"
  });

  const minInput = createElement("input", {
    type: "number",
    value: minValue,
    step: "0.1"
  }, {
    width: "30px",
    fontSize: "12px",
    padding: "2px 4px",
    background: "#555",
    color: "#fff",
    border: "1px solid #777",
    borderRadius: "3px",
    textAlign: "center",
    marginRight: "6px",
    MozAppearance: "textfield"
  });
  minInput.style.setProperty('appearance', 'textfield', 'important');

  const canvas = createElement("canvas", {}, {
    width: "50px",
    height: "20px",
    margin: "0 6px",
    borderRadius: "3px"
  });

  const maxInput = createElement("input", {
    type: "number",
    value: maxValue,
    step: "0.1"
  }, {
    width: "30px",
    fontSize: "12px",
    padding: "2px 4px",
    background: "#555",
    color: "#fff",
    border: "1px solid #777",
    borderRadius: "3px",
    textAlign: "center",
    marginLeft: "6px",
    MozAppearance: "textfield"
  });
  maxInput.style.setProperty('appearance', 'textfield', 'important');

  const barContainer = createElement("div", {}, {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center"
  });

  const labelsWrapper = createElement("div", {}, {
    display: "flex",
    justifyContent: "space-between",
    width: "50px",
    marginTop: "2px"
  });

  const minLabel = createElement("div", {}, {
    fontSize: "10px",
    color: "white"
  }, "Min");

  const maxLabel = createElement("div", {}, {
    fontSize: "10px",
    color: "white"
  }, "Max");

  labelsWrapper.appendChild(minLabel);
  labelsWrapper.appendChild(maxLabel);

  barContainer.appendChild(canvas);
  barContainer.appendChild(labelsWrapper);

  wrapper.appendChild(minInput);
  wrapper.appendChild(barContainer);
  wrapper.appendChild(maxInput);
  container.appendChild(wrapper);

  function render(currentColormap) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let colors;
    switch (currentColormap) {
      case "batlow": colors = getBatlowColors(); break;
      case "hawaii": colors = getHawaiiColors(); break;
      case "managua": colors = getManaguaColors(); break;
      case "viridis": colors = getViridisColors(); break;
      case "plasma": colors = getPlasmaColors(); break;
      case "spectralR": colors = getSpectralRColors(); break;
      default: colors = getHeatMapColors();
    }

    const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
    const step = Math.max(1, Math.floor(colors.length / 20));

    for (let i = 0; i < colors.length; i += step) {
      const c = colors[i];
      grad.addColorStop(i / colors.length, `rgb(${c.r * 255 | 0}, ${c.g * 255 | 0}, ${c.b * 255 | 0})`);
    }

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function onLimitsChange(e) {
    e.stopPropagation();
    render(colormap);
  }

  function onLimitsBlur() {
    let min = parseFloat(minInput.value);
    let max = parseFloat(maxInput.value);

    if (isNaN(min) || minInput.value === "") min = general.spinMin || 0;
    if (isNaN(max) || maxInput.value === "") max = general.spinMax || 2;
    if (min >= max) {
      min = general.spinMin || 0;
      max = general.spinMax || 2;
    }

    minInput.value = min;
    maxInput.value = max;
    general.spinMin = min;
    general.spinMax = max;

    updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colormap);
    render(colormap);
  }

  function onLimitsKeyDown(e) {
    if (e.key === "Enter") {
      onLimitsBlur();
    }
  }

  minInput.addEventListener("input", onLimitsChange);
  maxInput.addEventListener("input", onLimitsChange);
  minInput.addEventListener("blur", onLimitsBlur);
  maxInput.addEventListener("blur", onLimitsBlur);
  minInput.addEventListener("keydown", onLimitsKeyDown);
  maxInput.addEventListener("keydown", onLimitsKeyDown);

  render(colormap);

  return {
    update(cmap) {
      render(cmap);
    },
    remove() {
      wrapper.remove();
    }
  };
}

export function removeSpinPanel() {
  const panel = document.getElementById("spinControlsGroup");
  if (panel) {
    const container = document.getElementById("SpinForceFieldContainer");
    if (container) container.style.display = "none";
    panel.remove();
  }
}

export function addSpinPanel(target = "SpinForceFieldContainer") {
  // Remove existing panel if any
  removeSpinPanel();

  const targetPanel = document.getElementById(target);
  if (!targetPanel) {
    console.error("Target container not found:", target);
    return;
  }

  // Force the container to be visible
  targetPanel.style.display = "block";

  // --- Outer wrapper ---
  const group = document.createElement("div");
  group.id = "spinControlsGroup";
  group.style.padding = "10px";
  group.style.color = "white";
  group.style.overflowX = "hidden";

  // --- Panel ---
  const panel = document.createElement("div");
  panel.id = "spinPanel";

  // --- Toggle header ---
  const toggle = document.createElement("div");
  toggle.className = "spin-toggle";
  toggle.setAttribute("role", "button");
  toggle.setAttribute("tabindex", "0");
  toggle.style.cursor = "pointer";
  toggle.style.display = "flex";
  toggle.style.alignItems = "center";
  toggle.style.justifyContent = "space-between";
  toggle.style.padding = "4px 8px";

  const title = document.createElement("h4");
  title.textContent = "Spin Controls";
  title.style.margin = "0";
  title.style.color = "white";

  const icon = document.createElement("div");
  icon.className = "toggle-icon";
  icon.textContent = "−";
  icon.style.color = "white";

  toggle.appendChild(title);
  toggle.appendChild(icon);

  // --- Collapsible content ---
  const content = document.createElement("div");
  content.id = "spinControlsContent";
  content.className = "collapsible-content";
  content.style.padding = "8px";
  content.style.backgroundColor = "#222";
  content.style.overflowY = "visible";
  content.style.overflowX = "hidden";

  // --- Global Scaling slider ---
  const lengthWrapper = document.createElement("div");
  lengthWrapper.style.marginBottom = "8px";

  const lengthLabel = document.createElement("label");
  lengthLabel.textContent = "Global Scaling (Length): ";
  lengthLabel.style.color = "white";

  const lengthValue = document.createElement("span");
  lengthValue.textContent = (general.spinScale ?? 1.0).toFixed(2);
  lengthValue.style.marginRight = "8px";
  lengthValue.style.color = "white";

  const lengthSlider = document.createElement("input");
  lengthSlider.type = "range";
  lengthSlider.min = 0.1;
  lengthSlider.max = 10;
  lengthSlider.step = 0.1;
  lengthSlider.value = general.spinScale ?? 1.0;

  lengthWrapper.appendChild(lengthLabel);
  lengthWrapper.appendChild(lengthValue);
  lengthWrapper.appendChild(lengthSlider);
  content.appendChild(lengthWrapper);

  // --- Size slider ---
  const sizeWrapper = document.createElement("div");
  sizeWrapper.style.marginBottom = "8px";

  const sizeLabel = document.createElement("label");
  sizeLabel.textContent = "Arrow Size (Diameter): ";
  sizeLabel.style.color = "white";

  const sizeValue = document.createElement("span");
  sizeValue.textContent = (general.spinRadius ?? 0.1).toFixed(2);
  sizeValue.style.marginRight = "8px";
  sizeValue.style.color = "white";

  const sizeSlider = document.createElement("input");
  sizeSlider.type = "range";
  sizeSlider.min = 0.01;
  sizeSlider.max = 0.15;
  sizeSlider.step = 0.01;
  sizeSlider.value = general.spinRadius ?? 0.1;

  sizeWrapper.appendChild(sizeLabel);
  sizeWrapper.appendChild(sizeValue);
  sizeWrapper.appendChild(sizeSlider);
  content.appendChild(sizeWrapper);

  // --- Species Visibility Panel ---
  const speciesVisibilityLabel = document.createElement("div");
  speciesVisibilityLabel.textContent = "Species Visibility:";
  speciesVisibilityLabel.style.fontSize = "11px";
  speciesVisibilityLabel.style.margin = "8px 0 4px";
  speciesVisibilityLabel.style.color = "white";
  content.appendChild(speciesVisibilityLabel);

  const speciesVisibilityContainer = document.createElement("div");
  speciesVisibilityContainer.id = "speciesVisibilityContainer";
  speciesVisibilityContainer.style.marginBottom = "8px";
  speciesVisibilityContainer.style.display = "grid";
  speciesVisibilityContainer.style.gridTemplateColumns = "repeat(4, 1fr)";
  speciesVisibilityContainer.style.gap = "4px 8px";
  speciesVisibilityContainer.style.alignItems = "center";
  content.appendChild(speciesVisibilityContainer);

  // --- Source and Color Map dropdowns wrapper ---
  const dropdownsWrapper = document.createElement("div");
  dropdownsWrapper.style.display = "flex";
  dropdownsWrapper.style.gap = "8px";
  dropdownsWrapper.style.marginBottom = "8px";

  // --- Spin Source dropdown ---
  const sourceWrapper = document.createElement("div");
  sourceWrapper.style.flex = "1";

  const sourceLabel = document.createElement("label");
  sourceLabel.textContent = "Spin Source: ";
  sourceLabel.style.color = "white";
  sourceLabel.style.display = "block";
  sourceLabel.style.marginBottom = "4px";

  const sourceSelect = document.createElement("select");
  sourceSelect.style.width = "100%";
  sourceSelect.style.padding = "4px";
  sourceSelect.style.background = "#333";
  sourceSelect.style.color = "white";
  sourceSelect.style.border = "1px solid #555";
  sourceSelect.style.borderRadius = "3px";

  const structureOption = document.createElement("option");
  structureOption.value = "structure";
  structureOption.textContent = "From Structure";

  const manualOption = document.createElement("option");
  manualOption.value = "manual";
  manualOption.textContent = "Manual";

  sourceSelect.appendChild(structureOption);
  sourceSelect.appendChild(manualOption);

  sourceWrapper.appendChild(sourceLabel);
  sourceWrapper.appendChild(sourceSelect);

  // --- Color Map dropdown and color bar container ---
  const colorMapWrapper = document.createElement("div");
  colorMapWrapper.style.flex = "1";
  colorMapWrapper.style.display = "flex";
  colorMapWrapper.style.flexDirection = "column";

  const colorMapLabel = document.createElement("label");
  colorMapLabel.textContent = "Color Map: ";
  colorMapLabel.style.color = "white";
  colorMapLabel.style.display = "block";
  colorMapLabel.style.marginBottom = "4px";

  const colorMapSelect = document.createElement("select");
  colorMapSelect.style.width = "100%";
  colorMapSelect.style.padding = "4px";
  colorMapSelect.style.background = "#333";
  colorMapSelect.style.color = "white";
  colorMapSelect.style.border = "1px solid #555";
  colorMapSelect.style.borderRadius = "3px";
  colorMapSelect.style.marginBottom = "4px";

  const noneOption = document.createElement("option");
  noneOption.value = "none";
  noneOption.textContent = "None (Default)";

  const heatMapOption = document.createElement("option");
  heatMapOption.value = "heatmap";
  heatMapOption.textContent = "Heat Map";

  const directionMapOption = document.createElement("option");
  directionMapOption.value = "direction";
  directionMapOption.textContent = "Direction Map";

  const plusminusMapOption = document.createElement("option");
  plusminusMapOption.value = "plusminus";
  plusminusMapOption.textContent = "Plus-Minus Map";

  const batlowOption = document.createElement("option");
  batlowOption.value = "batlow";
  batlowOption.textContent = "Batlow";

  const hawaiiOption = document.createElement("option");
  hawaiiOption.value = "hawaii";
  hawaiiOption.textContent = "Hawaii";

  const managuaOption = document.createElement("option");
  managuaOption.value = "managua";
  managuaOption.textContent = "Managua";

  const viridisOption = document.createElement("option");
  viridisOption.value = "viridis";
  viridisOption.textContent = "Viridis";

  const plasmaOption = document.createElement("option");
  plasmaOption.value = "plasma";
  plasmaOption.textContent = "Plasma";

  const spectralROption = document.createElement("option");
  spectralROption.value = "spectralR";
  spectralROption.textContent = "Spectral R";

  colorMapSelect.appendChild(noneOption);
  colorMapSelect.appendChild(directionMapOption);
  colorMapSelect.appendChild(plusminusMapOption);
  colorMapSelect.appendChild(heatMapOption);
  colorMapSelect.appendChild(batlowOption);
  colorMapSelect.appendChild(hawaiiOption);
  colorMapSelect.appendChild(managuaOption);
  colorMapSelect.appendChild(viridisOption);
  colorMapSelect.appendChild(plasmaOption);
  colorMapSelect.appendChild(spectralROption);

  // --- Color Bar Container ---
  const colorBarContainer = document.createElement("div");
  colorBarContainer.id = "spinColorBarContainer";
  colorBarContainer.style.display = "none";
  colorBarContainer.style.width = "100%";

  colorMapWrapper.appendChild(colorMapLabel);
  colorMapWrapper.appendChild(colorMapSelect);
  colorMapWrapper.appendChild(colorBarContainer);

  dropdownsWrapper.appendChild(sourceWrapper);
  dropdownsWrapper.appendChild(colorMapWrapper);
  content.appendChild(dropdownsWrapper);

  let colorBar = null;

  // --- Current Spins/Forces list ---
  const currentSpinsLabel = document.createElement("div");
  currentSpinsLabel.textContent = "Current Spins/Forces:";
  currentSpinsLabel.style.fontSize = "11px";
  currentSpinsLabel.style.margin = "8px 0 4px";
  currentSpinsLabel.style.color = "white";
  content.appendChild(currentSpinsLabel);

  const currentSpinsList = document.createElement("textarea");
  currentSpinsList.id = "currentSpinsList";
  currentSpinsList.style.width = "calc(100% - 16px)";
  currentSpinsList.style.minHeight = "60px";
  currentSpinsList.style.overflowY = "auto";
  currentSpinsList.style.backgroundColor = "rgba(16, 16, 16, 0.8)";
  currentSpinsList.style.color = "white";
  currentSpinsList.style.fontFamily = "monospace";
  currentSpinsList.style.fontSize = "12px";
  currentSpinsList.style.border = "1px solid #555";
  currentSpinsList.style.padding = "8px";
  currentSpinsList.style.resize = "vertical";
  currentSpinsList.readOnly = true;
  content.appendChild(currentSpinsList);

  // --- Manual spin text input ---
  const textLabel = document.createElement("div");
  textLabel.textContent = "Manual Spin Vectors (x y z [scale] [color]):";
  textLabel.style.fontSize = "11px";
  textLabel.style.margin = "8px 0 4px";
  textLabel.style.color = "white";
  content.appendChild(textLabel);

  const textarea = document.createElement("textarea");
  textarea.id = "spinTextInput";
  textarea.placeholder = "x y z [scale] [color]\nExample:\n1 1 1\n1 1 1 1.0 teal\n0 0 1 2.0 #0000ff";
  textarea.style.width = "calc(100% - 16px)";
  textarea.style.height = "100px";
  textarea.style.resize = "vertical";
  textarea.style.background = "rgba(16,16,16,0.8)";
  textarea.style.color = "rgb(255,255,255)";
  textarea.style.border = "1px solid #555";
  textarea.style.fontFamily = "monospace";
  textarea.style.fontSize = "12px";
  textarea.style.marginBottom = "8px";
  textarea.style.padding = "8px";
  content.appendChild(textarea);

  // --- Action buttons ---
  const buttonWrapper = document.createElement("div");
  buttonWrapper.style.marginTop = "8px";
  buttonWrapper.style.display = "flex";
  buttonWrapper.style.gap = "8px";

  const drawBtn = document.createElement("button");
  drawBtn.textContent = "Draw";
  drawBtn.className = "btn-mini highlight";
  drawBtn.style.flex = "1";

  const overwriteBtn = document.createElement("button");
  overwriteBtn.textContent = "Overwrite Structure";
  overwriteBtn.className = "btn-mini highlight";
  overwriteBtn.style.flex = "1";

  const restoreBtn = document.createElement("button");
  restoreBtn.textContent = "Restore";
  restoreBtn.className = "btn-mini highlight";
  restoreBtn.style.flex = "1";

  buttonWrapper.appendChild(drawBtn);
  buttonWrapper.appendChild(overwriteBtn);
  buttonWrapper.appendChild(restoreBtn);
  content.appendChild(buttonWrapper);

  // --- Build hierarchy ---
  panel.appendChild(toggle);
  panel.appendChild(content);
  group.appendChild(panel);
  targetPanel.appendChild(group);

  // --- Open immediately ---
  content.classList.add("open");
  content.style.display = "block";

  // --- Toggle open/close ---
  toggle.addEventListener("click", () => {
    const isOpen = content.classList.contains("open");
    if (isOpen) {
      content.classList.remove("open");
      content.style.display = "none";
      icon.textContent = "+";
    } else {
      content.classList.add("open");
      content.style.display = "block";
      icon.textContent = "−";
    }
  });

  function parseManualSpins() {
  const input = textarea.value.trim().split("\n").filter(Boolean);
  const spins = [];
  const structure = fileBrowser.selectedStructure;

  if (!structure) return spins;

  input.forEach((line, i) => {
    const p = line.trim().split(/\s+/);
    if (p.length < 3) return;

    const x = parseFloat(p[0]);
    const y = parseFloat(p[1]);
    const z = parseFloat(p[2]);
    let scale = 1.0;
    let color = new THREE.Color("#008080"); // Default to teal as THREE.Color

    if (p.length > 3 && !isNaN(parseFloat(p[3]))) {
      scale = parseFloat(p[3]);
      if (p.length > 4) {
        // Convert string color to THREE.Color if needed
        color = p[4] instanceof THREE.Color ?
          p[4] :
          new THREE.Color(p[4] || "#008080");
      }
    } else if (p.length > 3) {
      color = new THREE.Color(p[3] || "#008080");
    }

    if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
      // Get position from atoms array if it exists
      const position = structure.atoms[i]?.position ?
        [...structure.atoms[i].position] :
        null;

      spins.push(new Spin({
        atomIndex: i,
        vector: [x, y, z],
        scaling: scale,
        color: color,
        element: structure.elements[i],
        position: position
      }));
    }
  });
  return spins;
}


  // --- Function to update the current spins/forces list ---
  function updateCurrentSpinsList() {
  const structure = fileBrowser.selectedStructure;
  const useManualSpins = sourceSelect.value === "manual";
  const spins = useManualSpins ? parseManualSpins() : structure.spins;

  if (spins.length > 0) {
    const spinLines = spins.map(spin => {
      const scale = spin.scaling ?? 1.0;
      // Convert THREE.Color to hex string if needed
      const color = spin.color instanceof THREE.Color ?
        `#${spin.color.getHexString()}` :
        spin.color;
      return `${spin.vector.join(" ")} ${scale} ${color}`;
    });
    currentSpinsList.value = spinLines.join("\n");
  } else {
    currentSpinsList.value = "No spins available.";
  }
}

  // --- Event listeners ---
  lengthSlider.addEventListener("input", () => {
    const val = parseFloat(lengthSlider.value);
    lengthValue.textContent = val.toFixed(2);
    general.spinScale = val;
    updateSpins(val, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
  });

  sizeSlider.addEventListener("input", () => {
    const val = parseFloat(sizeSlider.value);
    sizeValue.textContent = val.toFixed(2);
    general.spinRadius = val;
    updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
  });

  sourceSelect.addEventListener("change", () => {
    updateCurrentSpinsList();
    updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
  });


colorMapSelect.addEventListener("change", () => {
  const cmap = colorMapSelect.value;
  const isScalar = cmap !== "none" && cmap !== "direction" && cmap !== "plusminus";

  colorBarContainer.innerHTML = '';

  if (isScalar) {
    colorBarContainer.style.display = "block";

    // Calculate dynamic min/max based on spin lengths
    const structure = fileBrowser.selectedStructure;
    let minValue = 0;
    let maxValue = 2;

    if (structure?.spins) {
      // Calculate lengths for all spins
      const lengths = structure.spins
        .map(spin => {
          if (!spin.vector) return 0;
          const mag = Math.sqrt(
            spin.vector[0] ** 2 +
            spin.vector[1] ** 2 +
            spin.vector[2] ** 2
          );
          return mag * (spin.scaling ?? 1.0);
        })
        .filter(len => len > 0.1); // Only consider lengths > 0.1

      if (lengths.length > 0) {
        minValue = Math.min(...lengths);
        maxValue = Math.max(...lengths);

        // Round up to 1 decimal place
        minValue = Math.ceil(minValue * 10) / 10;
        maxValue = Math.ceil(maxValue * 10) / 10;

        // Add a small buffer to max value (also rounded up)
        maxValue = Math.ceil(maxValue * 1.05 * 10) / 10;

        // Ensure min is less than max
        if (minValue >= maxValue) {
          minValue = Math.floor(maxValue * 0.9 * 10) / 10;
        }
      }
    }

    // Set default values if no valid spins found
    if (minValue >= maxValue) {
      minValue = 0;
      maxValue = 2;
    }

    // Update general values
    general.spinMin = minValue;
    general.spinMax = maxValue;

    // Show the color bar with calculated values
    colorBar = createColorBar(
      colorBarContainer,
      cmap,
      minValue,
      maxValue,
      sourceSelect,
      parseManualSpins
    );

  } else {
    colorBarContainer.style.display = "none";
    colorBar = null;

    // When "none" is selected, reset all spins to their original color or teal
    if (cmap === "none") {
      const structure = fileBrowser.selectedStructure;
      if (structure?.spins) {
        structure.spins.forEach(spin => {
          if (spin instanceof Spin && spin.original) {
            spin.color = spin.original.color;
          } else if (spin.color) {
            // Keep existing color if set
          } else {
            spin.color = "#008080"; // Default to teal
          }
        });
      }
    }
  }

  // Always update spins when changing color map
  updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), cmap);
});


  // --- Draw button ---
  drawBtn.addEventListener("click", () => {
    if (sourceSelect.value === "manual") {
      const manualSpins = parseManualSpins();
      updateSpins(general.spinScale ?? 1.0, true, manualSpins, colorMapSelect.value);
      updateCurrentSpinsList();
    }
  });

  // --- Overwrite button ---
  overwriteBtn.addEventListener("click", () => {
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;

    const manualSpins = parseManualSpins();
    const spins = [];

    for (let i = 0; i < structure.atoms.length; i++) {
      const manualSpin = manualSpins.find(s => s.atomIndex === i);
      if (manualSpin) {
        spins.push(new Spin({
          vector: manualSpin.vector,
          scaling: manualSpin.scaling ?? 1.0,
          color: manualSpin.color,
          atomIndex: i,
          element: structure.elements[i],
          position: structure.positions[i]
        }));
      } else {
        // Default to teal for new spins
        spins.push(new Spin({
          vector: [0, 0, 0],
          scaling: 1.0,
          color: "#008080", // Default teal
          atomIndex: i,
          element: structure.elements[i],
          position: structure.positions[i]
        }));
      }
    }

    // Store original spins if they don't exist
    if (!structure.originalSpins) {
      structure.originalSpins = spins.map(spin => ({
        vector: [...spin.vector],
        scaling: spin.scaling,
        color: spin.color,
        atomIndex: spin.atomIndex,
        element: spin.element,
        position: spin.position ? [...spin.position] : null
      }));
    }

    structure.spins = spins;
    updateSpins(general.spinScale ?? 1.0, false, [], colorMapSelect.value);
    updateCurrentSpinsList();
    createSpeciesVisibilityToggles();
  });

  // --- Restore button ---
  restoreBtn.addEventListener("click", () => {
    const structure = fileBrowser.selectedStructure;
    if (!structure?.originalSpins) return;

    // Restore original spins
    structure.spins = structure.originalSpins.map(original => {
      return new Spin({
        vector: [...original.vector],
        scaling: original.scaling,
        color: original.color || "#008080", // Fallback to teal if no color was stored
        atomIndex: original.atomIndex,
        element: original.element,
        position: original.position ? [...original.position] : null
      });
    });

    updateSpins(general.spinScale ?? 1.0, false, [], colorMapSelect.value);
    updateCurrentSpinsList();
    createSpeciesVisibilityToggles();
  });

  // --- Function to create species visibility toggles ---
  function createSpeciesVisibilityToggles() {
    const structure = fileBrowser.selectedStructure;
    if (!structure) return;

    // Clear existing toggles
    speciesVisibilityContainer.innerHTML = '';

    // Get unique elements
    const uniqueElements = [...new Set(structure.elements)];

    // Create a toggle for each element
    uniqueElements.forEach(element => {
      const toggleItem = createElement("div", {}, {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        height: "24px"
      });

      const toggleContainer = createElement("label", {}, {
        position: "relative",
        display: "inline-block",
        width: "40px",
        height: "20px",
        marginRight: "6px",
        cursor: "pointer"
      });

      const checkbox = createElement("input", {
        type: "checkbox",
        id: `species-${element}`,
        checked: "checked"
      }, {
        opacity: "0",
        width: "0",
        height: "0",
        position: "absolute"
      });

      const slider = createElement("span", {}, {
        position: "absolute",
        cursor: "pointer",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        backgroundColor: "#555",
        transition: "background-color 0.2s, box-shadow 0.2s",
        borderRadius: "20px"
      });

      const circle = createElement("span", {}, {
        position: "absolute",
        content: "",
        height: "16px",
        width: "16px",
        left: "2px",
        bottom: "2px",
        backgroundColor: "white",
        transition: "transform 0.2s, box-shadow 0.2s",
        borderRadius: "50%",
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)"
      });

      toggleContainer.appendChild(checkbox);
      toggleContainer.appendChild(slider);
      slider.appendChild(circle);

      const label = createElement("label", {
        for: `species-${element}`
      }, {
        color: "white",
        fontSize: "12px",
        fontFamily: "monospace",
        height: "24px",
        lineHeight: "24px",
        whiteSpace: "nowrap",
        cursor: "pointer"
      }, element);

      toggleItem.appendChild(toggleContainer);
      toggleItem.appendChild(label);
      speciesVisibilityContainer.appendChild(toggleItem);

      if (typeof general.speciesVisibility === 'undefined') {
        general.speciesVisibility = {};
      }
      if (typeof general.speciesVisibility[element] === 'undefined') {
        general.speciesVisibility[element] = true;
      }

      checkbox.checked = general.speciesVisibility[element];

      function updateToggle() {
        if (checkbox.checked) {
          slider.style.backgroundColor = "#00C851";
          circle.style.transform = "translateX(20px)";
          general.speciesVisibility[element] = true;
        } else {
          slider.style.backgroundColor = "#555";
          circle.style.transform = "translateX(0)";
          general.speciesVisibility[element] = false;
        }
        updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), colorMapSelect.value);
      }

      updateToggle();

      checkbox.addEventListener("change", updateToggle);
      toggleContainer.addEventListener("click", (e) => {
        e.stopPropagation();
        checkbox.checked = !checkbox.checked;
        updateToggle();
      });
      label.addEventListener("click", () => {
        checkbox.checked = !checkbox.checked;
        updateToggle();
      });
    });
  }

  // Initialize species visibility toggles and current spins list
  createSpeciesVisibilityToggles();
  updateCurrentSpinsList();
}
