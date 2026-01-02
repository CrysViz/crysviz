import * as THREE from '../backend/three/three.module.js'
import { general, app } from '../store.js';
import { switchCameraType } from '../panels/WindowAndSceneControls.js';
import { updateBonds} from '../modules/BondsModule.js'


// Standalone colorbar function with min/max labels
function createColorBar(container, colormap, minValue = "Min", maxValue = "Max") {
  // Create colorbar wrapper
  const colorBarWrapper = document.createElement("div");
  colorBarWrapper.style.display = "flex";
  colorBarWrapper.style.flexDirection = "column";
  colorBarWrapper.style.alignItems = "center";
  colorBarWrapper.style.width = "100%";
  colorBarWrapper.style.marginTop = "5px";

  // Create colorbar container
  const colorBarContainer = document.createElement("div");
  colorBarContainer.className = "colorbar-container";
  colorBarContainer.style.width = "120px";
  colorBarContainer.style.height = "40px";
  colorBarContainer.style.borderRadius = "3px";
  colorBarContainer.style.overflow = "hidden";

  // Create canvas for colorbar
  const canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  colorBarContainer.appendChild(canvas);

  // Set canvas dimensions
  canvas.width = 100;
  canvas.height = 20;

  // Create labels container (positioned under the colorbar)
  const labelsContainer = document.createElement("div");
  labelsContainer.style.display = "flex";
  labelsContainer.style.justifyContent = "space-between";
  labelsContainer.style.width = "100%";
  labelsContainer.style.marginTop = "3px";

  // Create min label
  const minLabel = document.createElement("div");
  minLabel.textContent = `${minValue} Å`;
  minLabel.style.fontSize = "12px";
  minLabel.style.color = "rgba(255,255,255,0.9)";

  // Create max label
  const maxLabel = document.createElement("div");
  maxLabel.textContent = `${maxValue} Å`;
  maxLabel.style.fontSize = "12px";
  maxLabel.style.color = "rgba(255,255,255,0.9)";

  // Add labels to container
  labelsContainer.appendChild(minLabel);
  labelsContainer.appendChild(maxLabel);

  // Add elements to wrapper
  colorBarWrapper.appendChild(colorBarContainer);
  colorBarWrapper.appendChild(labelsContainer);

  // Render the colorbar
  function renderColorBar() {
    const ctx = canvas.getContext("2d");
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

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
    const step = Math.max(1, Math.floor(colors.length / 20));

    for (let i = 0; i < colors.length; i += step) {
      const color = colors[i];
      const offset = i / colors.length;
      gradient.addColorStop(offset, `rgb(${Math.floor(color.r * 255)}, ${Math.floor(color.g * 255)}, ${Math.floor(color.b * 255)})`);
    }

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Initial render
  renderColorBar();

  // Add to parent container
  container.appendChild(colorBarWrapper);

  return {
    update: (newColormap) => {
      colormap = newColormap;
      renderColorBar();
    },
    setLabels: (newMin, newMax) => {
      minLabel.textContent = newMin;
      maxLabel.textContent = newMax;
    },
    remove: () => {
      colorBarWrapper.remove();
    }
  };
}

export function addColorPanel(target = "colorContainer") {
  console.warn("addColorPanel called");
  const targetPanel = document.getElementById(target);
  if (document.getElementById("colorControlsGroup")) {
    console.warn("Color Controls already exist.");
    return;
  }
  if (!targetPanel) {
    console.warn("colorContainer does not exist!");
    return;
  }

  // --- Outer wrapper ---
  const group = document.createElement("div");
  group.id = "colorControlsGroup";

  // --- Panel ---
  const panel = document.createElement("div");
  panel.id = "colorSettingsPanel";

  // --- Toggle ---
  const toggle = document.createElement("div");
  toggle.id = "colorSettingsToggle";
  toggle.className = "spin-toggle";
  toggle.setAttribute("role", "button");
  toggle.setAttribute("tabindex", "0");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "colorControlsContent");

  const title = document.createElement("h4");
  title.textContent = "Color Map Settings";
  title.style.width = "100%";
  title.style.margin = "0";

  const icon = document.createElement("div");
  icon.id = "colorToggleIcon";
  icon.className = "toggle-icon";
  icon.textContent = "+";

  toggle.appendChild(title);
  toggle.appendChild(icon);

  // --- Collapsible content ---
  const content = document.createElement("div");
  content.id = "colorControlsContent";
  content.className = "collapsible-content";
  content.setAttribute("aria-hidden", "true");

  // --- Menus wrapper ---
  const menusWrapper = document.createElement("div");
  menusWrapper.className = "menus_wrapper";
  menusWrapper.style.width = "100%";

  // --- Atoms menu block ---
  const atomsMenuBlock = document.createElement("div");
  atomsMenuBlock.className = "menu_block";
  atomsMenuBlock.style.width = "100%";
  atomsMenuBlock.style.marginBottom = "15px";

  const atomsLabel = document.createElement("label");
  atomsLabel.setAttribute("for", "atomsMenu");
  atomsLabel.textContent = "Atoms";
  atomsLabel.style.display = "block";
  atomsLabel.style.textAlign = "center";
  atomsLabel.style.marginBottom = "5px";
  atomsLabel.style.width = "100%";

  const atomsMenu = document.createElement("select");
  atomsMenu.id = "atomsMenu";
  atomsMenu.style.width = "100%";
  atomsMenu.style.maxWidth = "120px";
  atomsMenu.style.margin = "0 auto";

  const atomsOptions = [
    { value: "elements", text: "Element", selected: true },
    { value: "force", text: "Force" },
    { value: "localStress", text: "Local Stress" },
  ];

  atomsOptions.forEach((option) => {
    const optElement = document.createElement("option");
    optElement.value = option.value;
    optElement.textContent = option.text;
    if (option.selected) optElement.selected = true;
    atomsMenu.appendChild(optElement);
  });

  // --- Atoms Color Map Dropdown (hidden by default) ---
  const atomsColorMapBlock = document.createElement("div");
  atomsColorMapBlock.className = "menu_block";
  atomsColorMapBlock.style.display = "none";
  atomsColorMapBlock.style.width = "100%";
  atomsColorMapBlock.style.marginTop = "10px";
  atomsColorMapBlock.style.textAlign = "center";

  const atomsColorMapLabel = document.createElement("label");
  atomsColorMapLabel.setAttribute("for", "atomsColorMapMenu");
  atomsColorMapLabel.textContent = "Color Map";
  atomsColorMapLabel.style.display = "block";
  atomsColorMapLabel.style.textAlign = "center";
  atomsColorMapLabel.style.marginBottom = "5px";
  atomsColorMapLabel.style.width = "100%";

  const atomsColorMapMenu = document.createElement("select");
  atomsColorMapMenu.id = "atomsColorMapMenu";
  atomsColorMapMenu.style.width = "100%";
  atomsColorMapMenu.style.maxWidth = "120px";
  atomsColorMapMenu.style.margin = "0 auto";

  const atomsColorMapOptions = [
    { value: "heatmap", text: "Heatmap", selected: true },
    { value: "batlow", text: "Batlow" },
    { value: "hawaii", text: "Hawaii" },
    { value: "managua", text: "Managua" },
    { value: "viridis", text: "Viridis" },
    { value: "plasma", text: "Plasma" },
    { value: "spectralR", text: "Spectral R" },
  ];

  atomsColorMapOptions.forEach((option) => {
    const optElement = document.createElement("option");
    optElement.value = option.value;
    optElement.textContent = option.text;
    if (option.selected) optElement.selected = true;
    atomsColorMapMenu.appendChild(optElement);
  });

  // Create atoms colorbar container
  const atomsColorBarContainer = document.createElement("div");
  atomsColorBarContainer.style.display = "flex";
  atomsColorBarContainer.style.justifyContent = "center";
  atomsColorBarContainer.style.width = "100%";
  atomsColorBarContainer.style.marginTop = "5px";

  atomsColorMapBlock.appendChild(atomsColorMapLabel);
  atomsColorMapBlock.appendChild(atomsColorMapMenu);
  atomsColorMapBlock.appendChild(atomsColorBarContainer);

  // Create atoms colorbar
  let atomsColorBar;
  atomsColorMapMenu.addEventListener("change", () => {
    general.atomColorMap = atomsColorMapMenu.value;
    if (!atomsColorBar) {
      atomsColorBar = createColorBar(atomsColorBarContainer, atomsColorMapMenu.value, "1e-4", "2");
    } else {
      atomsColorBar.update(atomsColorMapMenu.value);
    }
    console.log("Atom colormap set to:", general.atomColorMap);
    updateAtoms();
  });

  // --- Bonds menu block ---
  const bondsMenuBlock = document.createElement("div");
  bondsMenuBlock.className = "menu_block";
  bondsMenuBlock.style.width = "100%";
  bondsMenuBlock.style.marginBottom = "15px";

  const bondsLabel = document.createElement("label");
  bondsLabel.setAttribute("for", "bondsMenu");
  bondsLabel.textContent = "Bonds";
  bondsLabel.style.display = "block";
  bondsLabel.style.textAlign = "center";
  bondsLabel.style.marginBottom = "5px";
  bondsLabel.style.width = "100%";

  const bondsMenu = document.createElement("select");
  bondsMenu.id = "bondsMenu";
  bondsMenu.style.width = "100%";
  bondsMenu.style.maxWidth = "120px";
  bondsMenu.style.margin = "0 auto";

  const bondsOptions = [
    { value: "elements", text: "Elements", selected: true },
    { value: "white", text: "White" },
    { value: "length", text: "Length" },
  ];

  bondsOptions.forEach((option) => {
    const optElement = document.createElement("option");
    optElement.value = option.value;
    optElement.textContent = option.text;
    if (option.selected) optElement.selected = true;
    bondsMenu.appendChild(optElement);
  });

  // --- Bonds Color Map Dropdown (hidden by default) ---
  const bondsColorMapBlock = document.createElement("div");
  bondsColorMapBlock.className = "menu_block";
  bondsColorMapBlock.style.display = "none";
  bondsColorMapBlock.style.width = "100%";
  bondsColorMapBlock.style.marginTop = "10px";
  bondsColorMapBlock.style.textAlign = "center";

  const bondsColorMapLabel = document.createElement("label");
  bondsColorMapLabel.setAttribute("for", "bondsColorMapMenu");
  bondsColorMapLabel.textContent = "Color Map";
  bondsColorMapLabel.style.display = "block";
  bondsColorMapLabel.style.textAlign = "center";
  bondsColorMapLabel.style.marginBottom = "5px";
  bondsColorMapLabel.style.width = "100%";

  const bondsColorMapMenu = document.createElement("select");
  bondsColorMapMenu.id = "bondsColorMapMenu";
  bondsColorMapMenu.style.width = "100%";
  bondsColorMapMenu.style.maxWidth = "120px";
  bondsColorMapMenu.style.margin = "0 auto";

  const bondsColorMapOptions = [
    { value: "heatmap", text: "Heatmap", selected: true },
    { value: "batlow", text: "Batlow" },
    { value: "hawaii", text: "Hawaii" },
    { value: "managua", text: "Managua" },
    { value: "viridis", text: "Viridis" },
    { value: "plasma", text: "Plasma" },
    { value: "spectralR", text: "Spectral R" },
  ];

  bondsColorMapOptions.forEach((option) => {
    const optElement = document.createElement("option");
    optElement.value = option.value;
    optElement.textContent = option.text;
    if (option.selected) optElement.selected = true;
    bondsColorMapMenu.appendChild(optElement);
  });

  // Create bonds colorbar container
  const bondsColorBarContainer = document.createElement("div");
  bondsColorBarContainer.style.display = "flex";
  bondsColorBarContainer.style.justifyContent = "center";
  bondsColorBarContainer.style.width = "100%";
  bondsColorBarContainer.style.marginTop = "5px";

  bondsColorMapBlock.appendChild(bondsColorMapLabel);
  bondsColorMapBlock.appendChild(bondsColorMapMenu);
  bondsColorMapBlock.appendChild(bondsColorBarContainer);

  // Create bonds colorbar
  let bondsColorBar;
  bondsColorMapMenu.addEventListener("change", () => {
    general.bondsColorMap = bondsColorMapMenu.value;
    if (!bondsColorBar) {
      bondsColorBar = createColorBar(bondsColorBarContainer, bondsColorMapMenu.value, "1.1", "5");
    } else {
      bondsColorBar.update(bondsColorMapMenu.value);
    }
    console.log("Bond colormap set to:", general.bondsColorMap);
    updateBonds();
  });

  // Append atoms and bonds blocks to wrapper
  atomsMenuBlock.appendChild(atomsLabel);
  atomsMenuBlock.appendChild(atomsMenu);
  atomsMenuBlock.appendChild(atomsColorMapBlock);

  bondsMenuBlock.appendChild(bondsLabel);
  bondsMenuBlock.appendChild(bondsMenu);
  bondsMenuBlock.appendChild(bondsColorMapBlock);

  menusWrapper.appendChild(atomsMenuBlock);
  menusWrapper.appendChild(bondsMenuBlock);

  // Toggle visibility of atoms color map dropdown and update general.atomsColor
  atomsMenu.addEventListener("change", () => {
    if (atomsMenu.value === "localStress" || atomsMenu.value === "force") {
      atomsColorMapBlock.style.display = "block";
      if (!atomsColorBar) {
        atomsColorBar = createColorBar(atomsColorBarContainer, atomsColorMapMenu.value, "1e-4", "2");
      }
    } else {
      atomsColorMapBlock.style.display = "none";
    }
    general.atomsColor = atomsMenu.value;
    console.log("Atom color mode set to:", general.atomsColor);
    updateAtoms();
  });

  // Toggle visibility of bonds color map dropdown and update general.bondsColor
  bondsMenu.addEventListener("change", () => {
    if (bondsMenu.value === "length") {
      bondsColorMapBlock.style.display = "block";
      if (!bondsColorBar) {
        bondsColorBar = createColorBar(bondsColorBarContainer, bondsColorMapMenu.value, "1.1", "5");
      }
    } else {
      bondsColorMapBlock.style.display = "none";
    }
    general.bondsColor = bondsMenu.value;
    console.log("Bond color mode set to:", general.bondsColor);
    updateBonds();
  });

  // Append menus wrapper to content
  content.appendChild(menusWrapper);

  // Build hierarchy
  panel.appendChild(toggle);
  panel.appendChild(content);
  group.appendChild(panel);

  // Insert into DOM
  targetPanel.appendChild(group);

  // --- Toggle logic ---
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

  // Default is closed
  setOpen(false);

  // Click to toggle
  toggle.addEventListener("click", () => setOpen(!content.classList.contains("open")));

  // Keyboard support
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(!content.classList.contains("open"));
    }
  });
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

function getBatlowColors() {
  const nBins = 100; // Number of color bins
  const batlowColors = [];

  // Normalized RGB stops for the Batlow colormap (0-1 range)
  const batlowStops = [
    { t: 0.00, r: 0.005193, g: 0.098238, b: 0.349842 },
    { t: 0.01, r: 0.009065, g: 0.104487, b: 0.350933 },
    { t: 0.02, r: 0.012963, g: 0.110779, b: 0.351992 },
    { t: 0.03, r: 0.016530, g: 0.116913, b: 0.353070 },
    { t: 0.04, r: 0.019936, g: 0.122985, b: 0.354120 },
    { t: 0.05, r: 0.023189, g: 0.129035, b: 0.355182 },
    { t: 0.06, r: 0.026291, g: 0.135044, b: 0.356210 },
    { t: 0.07, r: 0.029245, g: 0.140964, b: 0.357239 },
    { t: 0.08, r: 0.032053, g: 0.146774, b: 0.358239 },
    { t: 0.09, r: 0.034853, g: 0.152558, b: 0.359233 },
    { t: 0.10, r: 0.037449, g: 0.158313, b: 0.360216 },
    { t: 0.11, r: 0.039845, g: 0.163978, b: 0.361187 },
    { t: 0.12, r: 0.042104, g: 0.169557, b: 0.362151 },
    { t: 0.13, r: 0.044069, g: 0.175053, b: 0.363084 },
    { t: 0.14, r: 0.045905, g: 0.180460, b: 0.364007 },
    { t: 0.15, r: 0.047665, g: 0.185844, b: 0.364915 },
    { t: 0.16, r: 0.049378, g: 0.191076, b: 0.365810 },
    { t: 0.17, r: 0.050795, g: 0.196274, b: 0.366684 },
    { t: 0.18, r: 0.052164, g: 0.201323, b: 0.367524 },
    { t: 0.19, r: 0.053471, g: 0.206357, b: 0.368370 },
    { t: 0.20, r: 0.054721, g: 0.211234, b: 0.369184 },
    { t: 0.21, r: 0.055928, g: 0.216046, b: 0.369974 },
    { t: 0.22, r: 0.057033, g: 0.220754, b: 0.370750 },
    { t: 0.23, r: 0.058032, g: 0.225340, b: 0.371509 },
    { t: 0.24, r: 0.059164, g: 0.229842, b: 0.372252 },
    { t: 0.25, r: 0.060167, g: 0.234299, b: 0.372978 },
    { t: 0.26, r: 0.061052, g: 0.238625, b: 0.373691 },
    { t: 0.27, r: 0.062060, g: 0.242888, b: 0.374386 },
    { t: 0.28, r: 0.063071, g: 0.247085, b: 0.375050 },
    { t: 0.29, r: 0.063982, g: 0.251213, b: 0.375709 },
    { t: 0.30, r: 0.064936, g: 0.255264, b: 0.376362 },
    { t: 0.31, r: 0.065903, g: 0.259257, b: 0.376987 },
    { t: 0.32, r: 0.066899, g: 0.263188, b: 0.377594 },
    { t: 0.33, r: 0.067921, g: 0.267056, b: 0.378191 },
    { t: 0.34, r: 0.069002, g: 0.270922, b: 0.378774 },
    { t: 0.35, r: 0.070001, g: 0.274713, b: 0.379342 },
    { t: 0.36, r: 0.071115, g: 0.278497, b: 0.379895 },
    { t: 0.37, r: 0.072192, g: 0.282249, b: 0.380434 },
    { t: 0.38, r: 0.073440, g: 0.285942, b: 0.380957 },
    { t: 0.39, r: 0.074595, g: 0.289653, b: 0.381452 },
    { t: 0.40, r: 0.075833, g: 0.293321, b: 0.381922 },
    { t: 0.41, r: 0.077136, g: 0.296996, b: 0.382376 },
    { t: 0.42, r: 0.078517, g: 0.300622, b: 0.382814 },
    { t: 0.43, r: 0.079984, g: 0.304252, b: 0.383224 },
    { t: 0.44, r: 0.081553, g: 0.307858, b: 0.383598 },
    { t: 0.45, r: 0.083082, g: 0.311461, b: 0.383936 },
    { t: 0.46, r: 0.084778, g: 0.315043, b: 0.384240 },
    { t: 0.47, r: 0.086503, g: 0.318615, b: 0.384506 },
    { t: 0.48, r: 0.088353, g: 0.322167, b: 0.384731 },
    { t: 0.49, r: 0.090281, g: 0.325685, b: 0.384910 },
    { t: 0.50, r: 0.092304, g: 0.329220, b: 0.385040 },
    { t: 0.51, r: 0.094462, g: 0.332712, b: 0.385116 },
    { t: 0.52, r: 0.096618, g: 0.336161, b: 0.385134 },
    { t: 0.53, r: 0.098915, g: 0.339621, b: 0.385090 },
    { t: 0.54, r: 0.101481, g: 0.343036, b: 0.384981 },
    { t: 0.55, r: 0.104078, g: 0.346410, b: 0.384801 },
    { t: 0.56, r: 0.106842, g: 0.349774, b: 0.384548 },
    { t: 0.57, r: 0.109695, g: 0.353098, b: 0.384217 },
    { t: 0.58, r: 0.112655, g: 0.356391, b: 0.383807 },
    { t: 0.59, r: 0.115748, g: 0.359638, b: 0.383310 },
    { t: 0.60, r: 0.118992, g: 0.362849, b: 0.382713 },
    { t: 0.61, r: 0.122320, g: 0.366030, b: 0.382026 },
    { t: 0.62, r: 0.125889, g: 0.369160, b: 0.381259 },
    { t: 0.63, r: 0.129519, g: 0.372238, b: 0.380378 },
    { t: 0.64, r: 0.133298, g: 0.375282, b: 0.379395 },
    { t: 0.65, r: 0.137212, g: 0.378282, b: 0.378315 },
    { t: 0.66, r: 0.141260, g: 0.381240, b: 0.377135 },
    { t: 0.67, r: 0.145432, g: 0.384130, b: 0.375840 },
    { t: 0.68, r: 0.149706, g: 0.386975, b: 0.374449 },
    { t: 0.69, r: 0.154073, g: 0.389777, b: 0.372934 },
    { t: 0.70, r: 0.158620, g: 0.392531, b: 0.371320 },
    { t: 0.71, r: 0.163246, g: 0.395237, b: 0.369609 },
    { t: 0.72, r: 0.167952, g: 0.397889, b: 0.367784 },
    { t: 0.73, r: 0.172788, g: 0.400496, b: 0.365867 },
    { t: 0.74, r: 0.177752, g: 0.403041, b: 0.363833 },
    { t: 0.75, r: 0.182732, g: 0.405551, b: 0.361714 },
    { t: 0.76, r: 0.187886, g: 0.408003, b: 0.359484 },
    { t: 0.77, r: 0.193050, g: 0.410427, b: 0.357177 },
    { t: 0.78, r: 0.198310, g: 0.412798, b: 0.354767 },
    { t: 0.79, r: 0.203676, g: 0.415116, b: 0.352253 },
    { t: 0.80, r: 0.209075, g: 0.417412, b: 0.349677 },
    { t: 0.81, r: 0.214555, g: 0.419661, b: 0.347019 },
    { t: 0.82, r: 0.220112, g: 0.421864, b: 0.344261 },
    { t: 0.83, r: 0.225707, g: 0.424049, b: 0.341459 },
    { t: 0.84, r: 0.231362, g: 0.426197, b: 0.338572 },
    { t: 0.85, r: 0.237075, g: 0.428325, b: 0.335634 },
    { t: 0.86, r: 0.242795, g: 0.430418, b: 0.332635 },
    { t: 0.87, r: 0.248617, g: 0.432493, b: 0.329571 },
    { t: 0.88, r: 0.254452, g: 0.434529, b: 0.326434 },
    { t: 0.89, r: 0.260320, g: 0.436556, b: 0.323285 },
    { t: 0.90, r: 0.266241, g: 0.438555, b: 0.320085 },
    { t: 0.91, r: 0.272168, g: 0.440541, b: 0.316831 },
    { t: 0.92, r: 0.278171, g: 0.442524, b: 0.313552 },
    { t: 0.93, r: 0.284175, g: 0.444484, b: 0.310243 },
    { t: 0.94, r: 0.290214, g: 0.446420, b: 0.306889 },
    { t: 0.95, r: 0.296294, g: 0.448357, b: 0.303509 },
    { t: 0.96, r: 0.302379, g: 0.450282, b: 0.300122 },
    { t: 0.97, r: 0.308517, g: 0.452205, b: 0.296721 },
    { t: 0.98, r: 0.314648, g: 0.454107, b: 0.293279 },
    { t: 0.99, r: 0.320834, g: 0.456006, b: 0.289841 },
    { t: 1.00, r: 0.327007, g: 0.457900, b: 0.286377 }
  ];

  for (let i = 0; i < nBins; i++) {
    const t = i / (nBins - 1);
    let r, g, b;

    // Find the two closest stops
    let stop1, stop2;
    for (let j = 0; j < batlowStops.length - 1; j++) {
      if (t >= batlowStops[j].t && t <= batlowStops[j + 1].t) {
        stop1 = batlowStops[j];
        stop2 = batlowStops[j + 1];
        break;
      }
    }

    // Interpolate between the two stops
    const localT = (t - stop1.t) / (stop2.t - stop1.t);
    r = stop1.r + (stop2.r - stop1.r) * localT;
    g = stop1.g + (stop2.g - stop1.g) * localT;
    b = stop1.b + (stop2.b - stop1.b) * localT;

    // Create THREE.Color with normalized RGB values
    batlowColors.push(new THREE.Color(r, g, b));
  }

  return batlowColors;
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
export function forceLengthToColor(forceLength) {
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
  const minVal = 1e-4;
  const maxVal = 2;
  const clamped = Math.max(minVal, Math.min(maxVal, forceLength));
  const t = (Math.log10(clamped) - Math.log10(minVal)) / (Math.log10(maxVal) - Math.log10(minVal));
  const bin = Math.min(Math.floor(t * nBins), nBins - 1);
  return colors[bin];
}

export function bondLengthToColor(bondLength) {
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
  const minVal = 1.1;
  const maxVal = 4;
  const clamped = Math.max(minVal, Math.min(maxVal, bondLength));
  let t = (clamped - minVal) / (maxVal - minVal);
  t = 1 - t;
  const bin = Math.min(Math.floor(t * nBins), nBins - 1);
  return colors[bin];
}

