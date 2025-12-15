import * as THREE from '../backend/three/three.module.js'
import { general, app } from '../store.js';
import { switchCameraType } from '../panels/WindowAndSceneControls.js';

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

  // --- Atoms menu block ---
  const atomsMenuBlock = document.createElement("div");
  atomsMenuBlock.className = "menu_block";

  const atomsLabel = document.createElement("label");
  atomsLabel.setAttribute("for", "atomsMenu");
  atomsLabel.textContent = "Atoms";

  const atomsMenu = document.createElement("select");
  atomsMenu.id = "atomsMenu";

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

  atomsMenuBlock.appendChild(atomsLabel);
  atomsMenuBlock.appendChild(atomsMenu);

  // --- Bonds menu block ---
  const bondsMenuBlock = document.createElement("div");
  bondsMenuBlock.className = "menu_block";

  const bondsLabel = document.createElement("label");
  bondsLabel.setAttribute("for", "bondsMenu");
  bondsLabel.textContent = "Bonds";

  const bondsMenu = document.createElement("select");
  bondsMenu.id = "bondsMenu";

  const bondsOptions = [
    { value: "elements", text: "Elements", selected: true },
    { value: "black", text: "Black" },
    { value: "length", text: "Length" },
  ];

  bondsOptions.forEach((option) => {
    const optElement = document.createElement("option");
    optElement.value = option.value;
    optElement.textContent = option.text;
    if (option.selected) optElement.selected = true;
    bondsMenu.appendChild(optElement);
  });

  bondsMenuBlock.appendChild(bondsLabel);
  bondsMenuBlock.appendChild(bondsMenu);

  // Append menus to wrapper
  menusWrapper.appendChild(atomsMenuBlock);
  menusWrapper.appendChild(bondsMenuBlock);

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




function getHeatMapColors() {
  const nBins = 50;
  const heatmapColors = [];

  for (let i = 0; i < nBins; i++) {
    const t = i / (nBins - 1); // 0..1

    let color = new THREE.Color();

    if (t < 0.25) {
      // White → Yellow
      color.lerpColors(new THREE.Color(0xffffff), new THREE.Color(0xffff00), t / 0.25);
    } else if (t < 0.5) {
      // Yellow → Orange
      color.lerpColors(new THREE.Color(0xffff00), new THREE.Color(0xff9900), (t - 0.25) / 0.25);
    } else if (t < 0.75) {
      // Orange → Red
      color.lerpColors(new THREE.Color(0xff9900), new THREE.Color(0xff0000), (t - 0.5) / 0.25);
    } else {
      // Red → Black
      color.lerpColors(new THREE.Color(0xff0000), new THREE.Color(0x000000), (t - 0.75) / 0.25);
    }

    heatmapColors.push(color);
  }

  return heatmapColors;
}

export function forceLengthToColor(forceLength) {
  const heatmapColors = getHeatMapColors();
  const nBins = heatmapColors.length;
  const minVal = 1e-4;
  const maxVal = 2;

  // Clamp value
  const clamped = Math.max(minVal, Math.min(maxVal, forceLength));

  // Normalize to 0..1 using log scale
  const t = (Math.log10(clamped) - Math.log10(minVal)) / (Math.log10(maxVal) - Math.log10(minVal));

  // Map to color bin
  const bin = Math.min(Math.floor(t * nBins), nBins - 1);
  return heatmapColors[bin];
}

