import * as THREE from '../external/three/three.module.js'
import { general, groups, app, getAtomVisSettings, getBondVisSettings } from '../store.js';
import { switchCameraType } from '../panels/WindowAndSceneControls.js';
import { updateBonds} from '../modules/BondsFracUpdateModule.js'
import { updateAtoms} from '../modules/AtomsFracUpdateModule.js'



function createElement(tag, attributes = {}, styles = {}, textContent = "") {
  const el = document.createElement(tag);
  Object.entries(attributes).forEach(([k, v]) => el.setAttribute(k, v));
  Object.entries(styles).forEach(([k, v]) => (el.style[k] = v));
  if (textContent) el.textContent = textContent;
  return el;
}

// --- Color Bar ---
function createColorBar(container, colormap, minValue, maxValue,type) {
  const wrapper = createElement("div", {}, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: "100%",
    marginTop: "6px"
  });

  const barContainer = createElement("div", {}, {
    width: "120px",
    borderRadius: "3px",
    overflow: "hidden"
  });

  const canvas = createElement("canvas");
  canvas.width = 100;
  canvas.height = 20;
  barContainer.appendChild(canvas);

  const labels = createElement("div", {}, {
    display: "flex",
    justifyContent: "space-between",
    width: "120px",
    marginTop: "4px"
  });

  const inputStyle = {
    width: "25%",
    fontSize: "12px",
    padding: "2px 4px",
    background: "#555",
    color: "#fff",
    border: "1px solid #777",
    borderRadius: "3px",
    textAlign: "center"
  };

  const minInput = createElement("input", {
    type: "text",
    value: minValue
  }, inputStyle);

  const maxInput = createElement("input", {
    type: "text",
    value: maxValue
  }, inputStyle);

  labels.appendChild(minInput);
  labels.appendChild(maxInput);

  wrapper.appendChild(barContainer);
  wrapper.appendChild(labels);
  container.appendChild(wrapper);

  function render() {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let colors;
    switch (colormap) {
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
      grad.addColorStop(i / colors.length,
        `rgb(${c.r * 255 | 0}, ${c.g * 255 | 0}, ${c.b * 255 | 0})`);
    }

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function onLimitsChange() {
    const min = parseFloat(minInput.value);
    const max = parseFloat(maxInput.value);
    if (!isFinite(min) || !isFinite(max) || min >= max) return;

    if (type === "atoms") {
      general.ForceMin = min;
      general.ForceMax = max;
      updateAtoms();
    } else if (type === "bonds") {
      general.BondMin = min;
      general.BondMax = max;
      updateBonds();
    }
  }

  minInput.addEventListener("change", onLimitsChange);
  maxInput.addEventListener("change", onLimitsChange);

  render();

  return {
    update(cmap) {
      colormap = cmap;
      render();
    },
    remove() {
      wrapper.remove();
    }
  };
}

// --- Dropdown Creation ---
function createDropdown(id, labelText, options, onChange) {
  const block = createElement("div", { class: "menu_block" });
  const label = createElement("label", { for: id }, { display: "block", textAlign: "center", marginBottom: "5px", width: "100%" }, labelText);
  const select = createElement("select", { id }, { width: "100%", maxWidth: "120px", margin: "0 auto" });

  options.forEach((opt) => {
    const option = createElement("option", { value: opt.value }, {}, opt.text);
    if (opt.selected) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener("change", onChange);
  block.appendChild(label);
  block.appendChild(select);
  return block;
}

// --- Toggle Logic ---
function setupToggle(toggle, content) {
  let isOpen = false;
  const icon = toggle.querySelector(".toggle-icon");

  function setOpen(open) {
    isOpen = open;
    content.classList.toggle("open", open);
    content.setAttribute("aria-hidden", !open);
    icon.textContent = open ? "−" : "+";
    toggle.setAttribute("aria-expanded", open);
  }

  toggle.addEventListener("click", () => setOpen(!isOpen));
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(!isOpen);
    }
  });

  setOpen(false);
}

export function addColorPanel(target = "colorContainer") {
  const targetPanel = document.getElementById(target);
  if (!targetPanel || document.getElementById("colorControlsGroup")) return;

  const group = createElement("div", { id: "colorControlsGroup" });
  const panel = createElement("div", { id: "colorSettingsPanel" });

  // --- Toggle ---
  const toggle = createElement("div", {
    id: "colorSettingsToggle",
    class: "spin-toggle",
    role: "button",
    tabindex: "0",
    "aria-expanded": "false",
    "aria-controls": "colorControlsContent"
  });

  toggle.appendChild(createElement("h4", {}, { margin: "0" }, "Color Map Settings"));
  toggle.appendChild(createElement("div", { class: "toggle-icon" }, {}, "+"));

  const content = createElement("div", {
    id: "colorControlsContent",
    class: "collapsible-content",
    "aria-hidden": "true"
  });


    // Drag/Auto Rotation Toggle
  const matteToggle = document.createElement("label");
  matteToggle.className = "camera_toggle";

  const metallicLabel = document.createElement("span");
  metallicLabel.className = "camera_label";
  metallicLabel.textContent = "Metallic";

  const matteSwitch = document.createElement("span");
  matteSwitch.className = "toggle_switch";

  const matteCheckbox = document.createElement("input");
  matteCheckbox.type = "checkbox";
  matteCheckbox.id = "matteColors";

  const matteSlider = document.createElement("span");
  matteSlider.className = "toggle_slider_dual";

  matteSwitch.appendChild(matteCheckbox);
  matteSwitch.appendChild(matteSlider);

  const matteLabel = document.createElement("span");
  matteLabel.className = "camera_label_r";
  matteLabel.textContent = "Matte";

  matteToggle.appendChild(metallicLabel);
  matteToggle.appendChild(matteSwitch);
  matteToggle.appendChild(matteLabel);

  content.appendChild(matteToggle);

  matteCheckbox.addEventListener("change", () => 
    {
    general.matte = !general.matte;
    let atomVisSettings = getAtomVisSettings();
    groups.atomsMesh.material.clearcoatRoughness = atomVisSettings.clearcoatRoughness
    groups.atomsMesh.material.clearcout =          atomVisSettings.clearcoat;
    groups.atomsMesh.material.metalness =          atomVisSettings.metalness;  
    groups.atomsMesh.material.roughness =          atomVisSettings.roughness;
    groups.atomsMesh.material.needsUpdate = true;
    //updateAtoms();
    let bondsVisSettings = getBondVisSettings();
    groups.bondsMesh.material.clearcoatRoughness = bondsVisSettings.clearcoatRoughness
    groups.bondsMesh.material.clearcout =          bondsVisSettings.clearcoat;
    groups.bondsMesh.material.metalness =          bondsVisSettings.metalness;
    groups.bondsMesh.material.roughness =          bondsVisSettings.roughness;


    groups.bondsMesh.material.needsUpdate = true;
    updateBonds();
  });



  const menusWrapper = createElement("div", { class: "menus_wrapper" });

  // =========================
  // ATOMS
  // =========================
  let atomsColorBar = null;

  const atomsMenuBlock = createElement("div", { class: "menu_block" });
  const atomsMenu = createDropdown("atomsMenu", "Atoms", [
    { value: "elements", text: "Element", selected: true },
    { value: "force", text: "Force" },
    { value: "localStress", text: "Local Stress" }
  ], onAtomsModeChange);

  const atomsElementColorMapBlock = createElement("div", { class: "menu_block" });
  const atomsElementColorMapMenu = createDropdown("atomsElementColorMapMenu", "Element Color Map", [
    { value: "default", text: "CrysViz Default", selected: true },
    { value: "jmol", text: "JMol-like" }
  ], () => {
    general.useDefaultColors =
      atomsElementColorMapMenu.querySelector("select").value === "default";
    updateAtoms();
  });

  const atomsColorMapBlock = createElement("div", {
    class: "menu_block",
    style: "display:none;"
  });

  const atomsColorMapMenu = createDropdown("atomsColorMapMenu", "Color Map", [
    { value: "heatmap", text: "Heatmap", selected: true },
    { value: "batlow", text: "Batlow" },
    { value: "hawaii", text: "Hawaii" },
    { value: "managua", text: "Managua" },
    { value: "viridis", text: "Viridis" },
    { value: "plasma", text: "Plasma" },
    { value: "spectralR", text: "Spectral R" }
  ], () => {
    const cmap = atomsColorMapMenu.querySelector("select").value;
    general.atomColorMap = cmap;
    atomsColorBar?.update(cmap);
    updateAtoms();
  });

  const atomsColorBarContainer = createElement("div", {}, {
    display: "none",
    marginTop: "8px"
  });

  atomsColorMapBlock.appendChild(atomsColorMapMenu);
  atomsColorMapBlock.appendChild(atomsColorBarContainer);

  atomsMenuBlock.appendChild(atomsMenu);
  atomsMenuBlock.appendChild(atomsElementColorMapBlock);
  atomsElementColorMapBlock.appendChild(atomsElementColorMapMenu);
  atomsMenuBlock.appendChild(atomsColorMapBlock);

  function onAtomsModeChange() {
    const mode = atomsMenu.querySelector("select").value;
    const isScalar = mode === "force" || mode === "localStress";

    atomsElementColorMapBlock.style.display = mode === "elements" ? "block" : "none";
    atomsColorMapBlock.style.display = isScalar ? "block" : "none";
    atomsColorBarContainer.style.display = isScalar ? "block" : "none";

    if (isScalar) {
      if (!atomsColorBar) {
        atomsColorBar = createColorBar(
          atomsColorBarContainer,
          general.atomColorMap,
          general.ForceMin,
          general.ForceMax,
          "atoms"
        );
      }
    } else {
      atomsColorBar?.remove();
      atomsColorBar = null;
    }

    general.atomsColor = mode;
    updateAtoms();
  }

  // =========================
  // BONDS
  // =========================
  let bondsColorBar = null;

  const bondsMenuBlock = createElement("div", { class: "menu_block" });
  const bondsMenu = createDropdown("bondsMenu", "Bonds", [
    { value: "elements", text: "Elements", selected: true },
    { value: "white", text: "White" },
    { value: "length", text: "Length" }
  ], onBondsModeChange);

  const bondsColorMapBlock = createElement("div", {
    class: "menu_block",
    style: "display:none;"
  });

  const bondsColorMapMenu = createDropdown("bondsColorMapMenu", "Color Map", [
    { value: "heatmap", text: "Heatmap", selected: true },
    { value: "batlow", text: "Batlow" },
    { value: "hawaii", text: "Hawaii" },
    { value: "managua", text: "Managua" },
    { value: "viridis", text: "Viridis" },
    { value: "plasma", text: "Plasma" },
    { value: "spectralR", text: "Spectral R" }
  ], () => {
    const cmap = bondsColorMapMenu.querySelector("select").value;
    general.bondsColorMap = cmap;
    bondsColorBar?.update(cmap);
    updateBonds();
  });

  const bondsColorBarContainer = createElement("div", {}, {
    display: "none",
    marginTop: "8px"
  });

  bondsColorMapBlock.appendChild(bondsColorMapMenu);
  bondsColorMapBlock.appendChild(bondsColorBarContainer);

  bondsMenuBlock.appendChild(bondsMenu);
  bondsMenuBlock.appendChild(bondsColorMapBlock);

  function onBondsModeChange() {
    const mode = bondsMenu.querySelector("select").value;
    const isLength = mode === "length";

    bondsColorMapBlock.style.display = isLength ? "block" : "none";
    bondsColorBarContainer.style.display = isLength ? "block" : "none";

    if (isLength) {
      if (!bondsColorBar) {
        bondsColorBar = createColorBar(
          bondsColorBarContainer,
          general.bondsColorMap,
          general.BondMin,
          general.BondMax,
          "bonds"
        );
      }
    } else {
      bondsColorBar?.remove();
      bondsColorBar = null;
    }

    general.bondsColor = mode;
    updateBonds();
  }

  // =========================
  // ASSEMBLE
  // =========================
  menusWrapper.appendChild(atomsMenuBlock);
  menusWrapper.appendChild(bondsMenuBlock);

  content.appendChild(menusWrapper);
  panel.appendChild(toggle);
  panel.appendChild(content);
  group.appendChild(panel);
  targetPanel.appendChild(group);

  setupToggle(toggle, content);
}





// --- Colormap Functions ---
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

    // find segment
    let lower = batlowStops[0];
    let upper = batlowStops[batlowStops.length - 1];
    for (let j = 0; j < batlowStops.length - 1; j++) {
      if (t >= batlowStops[j][0] && t <= batlowStops[j + 1][0]) {
        lower = batlowStops[j];
        upper = batlowStops[j + 1];
        break;
      }
    }

    // normalize between stops
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

    // Find the two closest stops
    let stop1, stop2;
    for (let j = 0; j < hawaiiStops.length - 1; j++) {
      if (t >= hawaiiStops[j].t && t <= hawaiiStops[j + 1].t) {
        stop1 = hawaiiStops[j];
        stop2 = hawaiiStops[j + 1];
        break;
      }
    }

    // Interpolate between the two stops
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

  // RGB values for the Managua colormap (normalized to 0-1 range)
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

    // Find the two closest stops
    let stop1, stop2;
    for (let j = 0; j < managuaStops.length - 1; j++) {
      if (t >= managuaStops[j].t && t <= managuaStops[j + 1].t) {
        stop1 = managuaStops[j];
        stop2 = managuaStops[j + 1];
        break;
      }
    }

    // Interpolate between the two stops
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

    // Find the two closest stops
    let stop1, stop2;
    for (let j = 0; j < viridisStops.length - 1; j++) {
      if (t >= viridisStops[j].t && t <= viridisStops[j + 1].t) {
        stop1 = viridisStops[j];
        stop2 = viridisStops[j + 1];
        break;
      }
    }

    // Interpolate between the two stops
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

    // Find the two closest stops
    let stop1, stop2;
    for (let j = 0; j < plasmaStops.length - 1; j++) {
      if (t >= plasmaStops[j].t && t <= plasmaStops[j + 1].t) {
        stop1 = plasmaStops[j];
        stop2 = plasmaStops[j + 1];
        break;
      }
    }

    // Interpolate between the two stops
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

    // Find the two closest stops
    let stop1, stop2;
    for (let j = 0; j < spectralRStops.length - 1; j++) {
      if (t >= spectralRStops[j].t && t <= spectralRStops[j + 1].t) {
        stop1 = spectralRStops[j];
        stop2 = spectralRStops[j + 1];
        break;
      }
    }

    // Interpolate between the two stops
    const localT = (t - stop1.t) / (stop2.t - stop1.t);
    r = Math.floor(stop1.r + (stop2.r - stop1.r) * localT);
    g = Math.floor(stop1.g + (stop2.g - stop1.g) * localT);
    b = Math.floor(stop1.b + (stop2.b - stop1.b) * localT);

    spectralRColors.push(new THREE.Color(`rgb(${r}, ${g}, ${b})`));
  }

  return spectralRColors;
}


// ... (other colormap functions like getViridisColors, getPlasmaColors, getRainbowColors)

// --- Mapping Functions ---
export function forceLengthToColor(forceLength,minVal = 1e-4, maxVal = 2) {
  let colors;
  switch (general.bondsColorMap) {
    case "batlow":
      colors = getBatlowColors();
      break;
    case "hawaii":
      colors = getHawaiiColors();
      break;
    case "managua":
      colors = getManaguaColors();
      break;
    case "viridis":
      colors = getViridisColors();
      break;
    case "plasma":
      colors = getPlasmaColors();
      break;
    case "spectalR":
      colors = getSpectralRColors()
      break;
    default:
      colors = getHeatMapColors();
  }
  const nBins = colors.length;
  const clamped = Math.max(minVal, Math.min(maxVal, forceLength));
  const t = (Math.log10(clamped) - Math.log10(minVal)) / (Math.log10(maxVal) - Math.log10(minVal));
  const bin = Math.min(Math.floor(t * nBins), nBins - 1);
  return colors[bin];
}

export function bondLengthToColor(bondLength,minVal=general.BondMin,maxVal=general.BondMax) {
  let colors;
  switch (general.bondsColorMap) {
    case "batlow":
      colors = getBatlowColors();
      break;
    case "hawaii":
      colors = getHawaiiColors();
      break;
    case "managua":
      colors = getManaguaColors();
      break;
    case "viridis":
      colors = getViridisColors();
      break;
    case "plasma":
      colors = getPlasmaColors();
      break;
    case "spectralR":
      colors = getSpectralRColors()
      break;
    default:
      colors = getHeatMapColors();
  }
  const nBins = colors.length;
  const clamped = Math.max(minVal, Math.min(maxVal, bondLength));
  let t = (clamped - minVal) / (maxVal - minVal);
  const bin = Math.min(Math.floor(t * nBins), nBins - 1);
  return colors[bin];
}

