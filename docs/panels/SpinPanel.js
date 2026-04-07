import * as THREE from '../external/three/three.module.js';
import { updateSpins, deleteSpins } from '../modules/SpinModule.js';
import { app, groups, fileBrowser, general } from '../store.js';

// Helper function to create elements
function createElement(tag, attributes = {}, styles = {}, textContent = "") {
  const el = document.createElement(tag);
  Object.entries(attributes).forEach(([k, v]) => el.setAttribute(k, v));
  Object.entries(styles).forEach(([k, v]) => (el.style[k] = v));
  if (textContent) el.textContent = textContent;
  return el;
}

function createColorBar(container, colormap, minValue, maxValue, sourceSelect, parseManualSpins) {
  // Clear previous color bar if it exists
  container.innerHTML = '';

  // Create main wrapper
  const wrapper = createElement("div", {}, {
    display: "flex",
    alignItems: "center",
    width: "100%",
    marginTop: "6px"
  });

  // Create min input
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

  // Create color bar canvas
  const canvas = createElement("canvas", {}, {
    width: "50px",
    height: "20px",
    margin: "0 6px",
    borderRadius: "3px"
  });

  // Create max input
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

  // Create container for the canvas and labels
  const barContainer = createElement("div", {}, {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center"
  });

  // Add labels under the color bar
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

  // Assemble components
  wrapper.appendChild(minInput);
  wrapper.appendChild(barContainer);
  wrapper.appendChild(maxInput);
  container.appendChild(wrapper);

  // Render function
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

  // Function to handle input changes (allow empty inputs)
  function onLimitsChange(e) {
    e.stopPropagation();
    render(colormap);
  }

  // Function to validate inputs on blur
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

  // Function to handle Enter key press
  function onLimitsKeyDown(e) {
    if (e.key === "Enter") {
      onLimitsBlur();
    }
  }

  // Attach event listeners
  minInput.addEventListener("input", onLimitsChange);
  maxInput.addEventListener("input", onLimitsChange);
  minInput.addEventListener("blur", onLimitsBlur);
  maxInput.addEventListener("blur", onLimitsBlur);
  minInput.addEventListener("keydown", onLimitsKeyDown);
  maxInput.addEventListener("keydown", onLimitsKeyDown);

  // Initial render
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




// Colormap functions
function getHeatMapColors() {
  const nBins = 50;
  const heatmapColors = [];
  for (let i = 0; i < nBins; i++) {
    const t = i / (nBins - 1);
    let color = new THREE.Color();
    if (t < 0.25) {
      color.lerpColors(new THREE.Color(0xffffff), new THREE.Color(0xffff00), t / 0.25);
    } else if (t < 0.5) {
      color.lerpColors(new THREE.Color(0xffff00), new THREE.Color(0xff9900), (t - 0.25) / 0.25);
    } else if (t < 0.75) {
      color.lerpColors(new THREE.Color(0xff9900), new THREE.Color(0xff0000), (t - 0.5) / 0.25);
    } else {
      color.lerpColors(new THREE.Color(0xff0000), new THREE.Color(0x000000), (t - 0.75) / 0.25);
    }
    heatmapColors.push(color);
  }
  return heatmapColors;
}

function getBatlowColors(nBins = 100) {
  const batlowStops = [
    [0.000000, 0.0588235, 0.3490196],
    [0.0256410, 0.0784314, 0.4196078],
    [0.0512821, 0.2596078, 0.5254902],
    [0.1111111, 0.5019608, 0.6352941],
    [0.2222222, 0.7450980, 0.7058824],
    [0.3333333, 0.8784314, 0.7686275],
    [0.4444444, 0.9705882, 0.8274510],
    [0.5555556, 0.9960784, 0.8745098],
    [0.6666667, 0.9529412, 0.9098039],
    [0.7777778, 0.8352941, 0.9215686],
    [0.8888889, 0.6862745, 0.9058824],
    [1.0000000, 0.5215686, 0.8588235]
  ];

  const colors = [];
  for (let i = 0; i < nBins; i++) {
    let t = i / (nBins - 1);

    let lower = batlowStops[0];
    let upper = batlowStops[batlowStops.length - 1];
    for (let j = 0; j < batlowStops.length - 1; j++) {
      if (t >= batlowStops[j][0] && t <= batlowStops[j + 1][0]) {
        lower = batlowStops[j];
        upper = batlowStops[j + 1];
        break;
      }
    }

    const range = upper[0] - lower[0];
    const localT = range <= 0 ? 0 : (t - lower[0]) / range;

    const r = lower[1] + (upper[1] - lower[1]) * localT;
    const g = lower[2] + (upper[2] - lower[2]) * localT;
    const b = lower[3] + (upper[3] - lower[3]) * localT;

    colors.push(new THREE.Color(r, g, b));
  }

  return colors;
}

function getHawaiiColors() {
  const nBins = 50;
  const hawaiiColors = [];
  const hawaiiStops = [
    { t: 0.0, r: 0, g: 0, b: 50 },
    { t: 0.1667, r: 0, g: 0, b: 200 },
    { t: 0.3333, r: 0, g: 100, b: 255 },
    { t: 0.5, r: 0, g: 200, b: 255 },
    { t: 0.6667, r: 255, g: 255, b: 0 },
    { t: 0.8333, r: 255, g: 100, b: 0 },
    { t: 1.0, r: 200, g: 0, b: 0 },
  ];

  for (let i = 0; i < nBins; i++) {
    const t = i / (nBins - 1);
    let r, g, b;

    let stop1, stop2;
    for (let j = 0; j < hawaiiStops.length - 1; j++) {
      if (t >= hawaiiStops[j].t && t <= hawaiiStops[j + 1].t) {
        stop1 = hawaiiStops[j];
        stop2 = hawaiiStops[j + 1];
        break;
      }
    }

    const localT = (t - stop1.t) / (stop2.t - stop1.t);
    r = Math.floor(stop1.r + (stop2.r - stop1.r) * localT);
    g = Math.floor(stop1.g + (stop2.g - stop1.g) * localT);
    b = Math.floor(stop1.b + (stop2.b - stop1.b) * localT);

    hawaiiColors.push(new THREE.Color(`rgb(${r}, ${g}, ${b})`));
  }

  return hawaiiColors;
}

function getManaguaColors() {
  const nBins = 50;
  const managuaColors = [];

  const managuaStops = [
    { t: 0.00, r: 1.000000, g: 0.812630, b: 0.404239 },
    { t: 0.02, r: 0.995163, g: 0.804546, b: 0.401552 },
    { t: 0.04, r: 0.990240, g: 0.796488, b: 0.398875 },
    { t: 0.06, r: 0.985323, g: 0.788476, b: 0.396216 },
    { t: 0.08, r: 0.980412, g: 0.780499, b: 0.393560 },
    { t: 0.10, r: 0.975507, g: 0.772566, b: 0.390930 },
    { t: 0.12, r: 0.970617, g: 0.764681, b: 0.388300 },
    { t: 0.14, r: 0.965734, g: 0.756837, b: 0.385681 },
    { t: 0.16, r: 0.960867, g: 0.749039, b: 0.383098 },
    { t: 0.18, r: 0.956008, g: 0.741291, b: 0.380517 },
    { t: 0.20, r: 0.951157, g: 0.733597, b: 0.377947 },
    { t: 0.22, r: 0.946314, g: 0.725951, b: 0.375393 },
    { t: 0.24, r: 0.941487, g: 0.718348, b: 0.372860 },
    { t: 0.26, r: 0.936674, g: 0.710803, b: 0.370341 },
    { t: 0.28, r: 0.931861, g: 0.703303, b: 0.367841 },
    { t: 0.30, r: 0.927063, g: 0.695854, b: 0.365358 },
    { t: 0.32, r: 0.922279, g: 0.688453, b: 0.362886 },
    { t: 0.34, r: 0.917502, g: 0.681092, b: 0.360425 },
    { t: 0.36, r: 0.912728, g: 0.673792, b: 0.358001 },
    { t: 0.38, r: 0.907969, g: 0.666530, b: 0.355581 },
    { t: 0.40, r: 0.903213, g: 0.659321, b: 0.353163 },
    { t: 0.42, r: 0.898462, g: 0.652158, b: 0.350776 },
    { t: 0.44, r: 0.893721, g: 0.645033, b: 0.348388 },
    { t: 0.46, r: 0.888989, g: 0.637961, b: 0.346011 },
    { t: 0.48, r: 0.884260, g: 0.630933, b: 0.343667 },
    { t: 0.50, r: 0.879531, g: 0.623946, b: 0.341336 },
    { t: 0.52, r: 0.874812, g: 0.616998, b: 0.339018 },
    { t: 0.54, r: 0.870093, g: 0.610091, b: 0.336701 },
    { t: 0.56, r: 0.865382, g: 0.603234, b: 0.334418 },
    { t: 0.58, r: 0.860673, g: 0.596415, b: 0.332135 },
    { t: 0.60, r: 0.855966, g: 0.589631, b: 0.329871 },
    { t: 0.62, r: 0.851254, g: 0.582896, b: 0.327604 },
    { t: 0.64, r: 0.846548, g: 0.576213, b: 0.325360 },
    { t: 0.66, r: 0.841847, g: 0.569544, b: 0.323151 },
    { t: 0.68, r: 0.837141, g: 0.562939, b: 0.320941 },
    { t: 0.70, r: 0.832431, g: 0.556354, b: 0.318738 },
    { t: 0.72, r: 0.827719, g: 0.549825, b: 0.316560 },
    { t: 0.74, r: 0.823010, g: 0.543331, b: 0.314381 },
    { t: 0.76, r: 0.818292, g: 0.536881, b: 0.312217 },
    { t: 0.78, r: 0.813575, g: 0.530459, b: 0.310103 },
    { t: 0.80, r: 0.808858, g: 0.524083, b: 0.307958 },
    { t: 0.82, r: 0.804130, g: 0.517752, b: 0.305871 },
    { t: 0.84, r: 0.799400, g: 0.511449, b: 0.303754 },
    { t: 0.86, r: 0.794659, g: 0.505193, b: 0.301670 },
    { t: 0.88, r: 0.789914, g: 0.498983, b: 0.299621 },
    { t: 0.90, r: 0.785165, g: 0.492803, b: 0.297568 },
    { t: 0.92, r: 0.780403, g: 0.486677, b: 0.295528 },
    { t: 0.94, r: 0.775635, g: 0.480583, b: 0.293510 },
    { t: 0.96, r: 0.770863, g: 0.474541, b: 0.291527 },
    { t: 0.98, r: 0.766076, g: 0.468526, b: 0.289539 },
    { t: 1.00, r: 0.761278, g: 0.462554, b: 0.287559 },
  ];

  for (let i = 0; i < nBins; i++) {
    const t = i / (nBins - 1);
    let r, g, b;

    let stop1, stop2;
    for (let j = 0; j < managuaStops.length - 1; j++) {
      if (t >= managuaStops[j].t && t <= managuaStops[j + 1].t) {
        stop1 = managuaStops[j];
        stop2 = managuaStops[j + 1];
        break;
      }
    }

    const localT = (t - stop1.t) / (stop2.t - stop1.t);
    r = Math.floor((stop1.r + (stop2.r - stop1.r) * localT) * 255);
    g = Math.floor((stop1.g + (stop2.g - stop1.g) * localT) * 255);
    b = Math.floor((stop1.b + (stop2.b - stop1.b) * localT) * 255);

    managuaColors.push(new THREE.Color(`rgb(${r}, ${g}, ${b})`));
  }

  return managuaColors;
}

function getViridisColors() {
  const nBins = 50;
  const viridisColors = [];
  const viridisStops = [
    { t: 0.0, r: 68, g: 1, b: 84 },
    { t: 0.1, r: 72, g: 33, b: 116 },
    { t: 0.2, r: 69, g: 67, b: 147 },
    { t: 0.3, r: 59, g: 82, b: 139 },
    { t: 0.4, r: 44, g: 101, b: 142 },
    { t: 0.5, r: 33, g: 123, b: 140 },
    { t: 0.6, r: 29, g: 145, b: 123 },
    { t: 0.7, r: 34, g: 168, b: 103 },
    { t: 0.8, r: 60, g: 189, b: 74 },
    { t: 0.9, r: 136, g: 204, b: 57 },
    { t: 1.0, r: 222, g: 217, b: 38 },
  ];

  for (let i = 0; i < nBins; i++) {
    const t = i / (nBins - 1);
    let r, g, b;

    let stop1, stop2;
    for (let j = 0; j < viridisStops.length - 1; j++) {
      if (t >= viridisStops[j].t && t <= viridisStops[j + 1].t) {
        stop1 = viridisStops[j];
        stop2 = viridisStops[j + 1];
        break;
      }
    }

    const localT = (t - stop1.t) / (stop2.t - stop1.t);
    r = Math.floor(stop1.r + (stop2.r - stop1.r) * localT);
    g = Math.floor(stop1.g + (stop2.g - stop1.g) * localT);
    b = Math.floor(stop1.b + (stop2.b - stop1.b) * localT);

    viridisColors.push(new THREE.Color(`rgb(${r}, ${g}, ${b})`));
  }

  return viridisColors;
}

function getPlasmaColors() {
  const nBins = 50;
  const plasmaColors = [];
  const plasmaStops = [
    { t: 0.0, r: 13, g: 8, b: 135 },
    { t: 0.1, r: 74, g: 21, b: 157 },
    { t: 0.2, r: 122, g: 41, b: 161 },
    { t: 0.3, r: 163, g: 59, b: 149 },
    { t: 0.4, r: 200, g: 80, b: 120 },
    { t: 0.5, r: 236, g: 112, b: 81 },
    { t: 0.6, r: 252, g: 159, b: 31 },
    { t: 0.7, r: 248, g: 202, b: 77 },
    { t: 0.8, r: 230, g: 230, b: 150 },
    { t: 0.9, r: 200, g: 240, b: 200 },
    { t: 1.0, r: 150, g: 255, b: 255 },
  ];

  for (let i = 0; i < nBins; i++) {
    const t = i / (nBins - 1);
    let r, g, b;

    let stop1, stop2;
    for (let j = 0; j < plasmaStops.length - 1; j++) {
      if (t >= plasmaStops[j].t && t <= plasmaStops[j + 1].t) {
        stop1 = plasmaStops[j];
        stop2 = plasmaStops[j + 1];
        break;
      }
    }

    const localT = (t - stop1.t) / (stop2.t - stop1.t);
    r = Math.floor(stop1.r + (stop2.r - stop1.r) * localT);
    g = Math.floor(stop1.g + (stop2.g - stop1.g) * localT);
    b = Math.floor(stop1.b + (stop2.b - stop1.b) * localT);

    plasmaColors.push(new THREE.Color(`rgb(${r}, ${g}, ${b})`));
  }

  return plasmaColors;
}

function getSpectralRColors() {
  const nBins = 50;
  const spectralRColors = [];
  const spectralRStops = [
    { t: 0.0, r: 255, g: 0, b: 0 },
    { t: 0.1, r: 255, g: 64, b: 0 },
    { t: 0.2, r: 255, g: 128, b: 0 },
    { t: 0.3, r: 255, g: 191, b: 0 },
    { t: 0.4, r: 255, g: 255, b: 0 },
    { t: 0.5, r: 191, g: 255, b: 0 },
    { t: 0.6, r: 128, g: 255, b: 0 },
    { t: 0.7, r: 64, g: 255, b: 0 },
    { t: 0.8, r: 0, g: 255, b: 64 },
    { t: 0.9, r: 0, g: 191, b: 255 },
    { t: 1.0, r: 0, g: 0, b: 255 },
  ];

  for (let i = 0; i < nBins; i++) {
    const t = i / (nBins - 1);
    let r, g, b;

    let stop1, stop2;
    for (let j = 0; j < spectralRStops.length - 1; j++) {
      if (t >= spectralRStops[j].t && t <= spectralRStops[j + 1].t) {
        stop1 = spectralRStops[j];
        stop2 = spectralRStops[j + 1];
        break;
      }
    }

    const localT = (t - stop1.t) / (stop2.t - stop1.t);
    r = Math.floor(stop1.r + (stop2.r - stop1.r) * localT);
    g = Math.floor(stop1.g + (stop2.g - stop1.g) * localT);
    b = Math.floor(stop1.b + (stop2.b - stop1.b) * localT);

    spectralRColors.push(new THREE.Color(`rgb(${r}, ${g}, ${b})`));
  }

  return spectralRColors;
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
  colorMapSelect.appendChild(heatMapOption);
  colorMapSelect.appendChild(directionMapOption);
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

  // Initialize min and max values for color bar
  general.spinMin = general.spinMin || 0;
  general.spinMax = general.spinMax || 2;

  // Function to create species visibility toggles
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

      // Create toggle switch container
      const toggleContainer = createElement("label", {}, {
        position: "relative",
        display: "inline-block",
        width: "40px",
        height: "20px",
        marginRight: "6px",
        cursor: "pointer"
      });

      // Create the actual checkbox (hidden)
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

      // Create the slider
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

      // Create the circle inside the slider
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

      // Add elements to the toggle container
      toggleContainer.appendChild(checkbox);
      toggleContainer.appendChild(slider);
      slider.appendChild(circle);

      // Create label for the element
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

      // Store the visibility state in general object if it doesn't exist
      if (typeof general.speciesVisibility === 'undefined') {
        general.speciesVisibility = {};
      }
      if (typeof general.speciesVisibility[element] === 'undefined') {
        general.speciesVisibility[element] = true;
      }

      // Set initial checkbox state based on stored value
      checkbox.checked = general.speciesVisibility[element];

      // Update the toggle appearance based on checkbox state
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

      // Initial toggle state
      updateToggle();

      // Add event listener to the checkbox
      checkbox.addEventListener("change", updateToggle);

      // Add click handler to the toggle container
      toggleContainer.addEventListener("click", (e) => {
        e.stopPropagation();
        checkbox.checked = !checkbox.checked;
        updateToggle();
      });

      // Add click handler to the label
      label.addEventListener("click", () => {
        checkbox.checked = !checkbox.checked;
        updateToggle();
      });
    });
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
  const isScalar = cmap !== "none" && cmap !== "direction";

  // Clear previous color bar if it exists
  colorBarContainer.innerHTML = '';

  if (isScalar) {
    colorBarContainer.style.display = "block";
    colorBar = createColorBar(
      colorBarContainer,
      cmap,
      general.spinMin,
      general.spinMax,
      sourceSelect,
      parseManualSpins
    );
  } else {
    colorBarContainer.style.display = "none";
    colorBar = null;
  }

  // Update spins with the new colormap
  updateSpins(general.spinScale ?? 1.0, sourceSelect.value === "manual", parseManualSpins(), cmap);
});

  overwriteBtn.addEventListener("click", () => {
    const structure = fileBrowser.selectedStructure;
    const manualSpins = parseManualSpins();
    const spins = [];

    for (let i = 0; i < structure.atoms.length; i++) {
      const manualSpin = manualSpins.find(spin => spin.atomIndex === i);
      if (manualSpin) {
        spins.push(manualSpin);
      } else {
        spins.push({ atomIndex: i, vector: [0, 0, 0], scaling: 1.0, color: "#008080" });
      }
    }

    structure.spins = spins;
    updateSpins(general.spinScale ?? 1.0, false, [], colorMapSelect.value);
    updateCurrentSpinsList();
    createSpeciesVisibilityToggles();
  });

  restoreBtn.addEventListener("click", () => {
    const structure = fileBrowser.selectedStructure;
    if (structure.original?.spins) {
      structure.spins = structure.original.spins.map(spin => ({ ...spin }));
      updateSpins(general.spinScale ?? 1.0, false, [], colorMapSelect.value);
      updateCurrentSpinsList();
      createSpeciesVisibilityToggles();
    }
  });

  // --- Function to parse manual spins ---
  function parseManualSpins() {
    const input = textarea.value.trim().split("\n").filter(Boolean);
    const spins = [];
    input.forEach((line, i) => {
      const p = line.trim().split(/\s+/);
      if (p.length < 3) return;
      const x = parseFloat(p[0]);
      const y = parseFloat(p[1]);
      const z = parseFloat(p[2]);
      let scale = 1.0;
      let color = "#008080";

      if (p.length > 3 && !isNaN(parseFloat(p[3]))) {
        scale = parseFloat(p[3]);
        if (p.length > 4) {
          color = p[4];
        }
      } else if (p.length > 3) {
        color = p[3];
      }

      if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
        spins.push({ atomIndex: i, vector: [x, y, z], scaling: scale, color });
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
        const color = spin.color ?? "#008080";
        return `${spin.vector.join(" ")} ${scale} ${color}`;
      });
      currentSpinsList.value = spinLines.join("\n");
    } else {
      currentSpinsList.value = "No spins available.";
    }
  }

  // Initialize species visibility toggles
  createSpeciesVisibilityToggles();
  updateCurrentSpinsList();
}
