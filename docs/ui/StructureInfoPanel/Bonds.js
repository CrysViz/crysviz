import { updateVisualization } from '../../core/crystal-viewer.js';

import {app, groups,fileBrowser, general, mode, highlightHover} from '../../state/store.js';
import {defaultColorMap, jmolColorMap,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../../defaults/color_texture_defaults.js'



import { createColorPicker } from '../ColorPickerModule.js';
import * as THREE from '../../external/three/three.module.js';
import {fracToCart} from '../../render/index.js'





import {clearAllHighlights} from '../SelectAndHighlightModule.js';


let placeholderMessage;
let detailsContainer;

// Call this once to create the bond control panel
export function createSpecificBondControl(containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.warn(`Container "${containerId}" not found`);
    return;
  }

  // Main panel
  const bondControlPanel = document.createElement("div");
  bondControlPanel.id = "bondControlPanel";
  bondControlPanel.style.border = "1px solid #333";
  bondControlPanel.style.padding = "12px";
  bondControlPanel.style.borderRadius = "6px";
  bondControlPanel.style.maxWidth = "300px";
  bondControlPanel.style.margin = "10px";
  bondControlPanel.style.background = "#1e1e1e";
  bondControlPanel.style.color = "#ffffff";
  bondControlPanel.style.fontFamily = "sans-serif";
  bondControlPanel.style.textAlign = "center";
  bondControlPanel.style.position = "relative";
  bondControlPanel.style.zIndex = "9999";

  // Placeholder message
  placeholderMessage = document.createElement("div");
  placeholderMessage.id = "bondPlaceholderMessage";
  placeholderMessage.textContent = "Select a bond";
  placeholderMessage.style.opacity = "0.8";
  placeholderMessage.style.marginBottom = "10px";
  bondControlPanel.appendChild(placeholderMessage);

  // Details container
  detailsContainer = document.createElement("div");
  detailsContainer.id = "bondDetails";
  detailsContainer.style.display = "flex";
  detailsContainer.style.flexDirection = "column";
  detailsContainer.style.alignItems = "center";
  detailsContainer.style.gap = "10px";
  bondControlPanel.appendChild(detailsContainer);

  container.appendChild(bondControlPanel);

  // Initial render
  updateBondControlPanel();
}

// Update the bond panel based on selected bonds
export function updateBondControlPanel(selectedBond) {
  if (!detailsContainer || !placeholderMessage) return;

  detailsContainer.innerHTML = "";

  // Use explicitly passed bonds or current highlighted bonds
  const bond = selectedBond || highlightHover.currentlyHighlightedBond;

  // If no bond is selected, show placeholder
  if (!bond || (Array.isArray(bond) && bond.length === 0)) {
    placeholderMessage.style.display = "block";
    return;
  }

  placeholderMessage.style.display = "none";

  // Always treat bonds as an array
  const bonds = Array.isArray(bond) ? bond : [bond];

  // Get unique colors
  const colors = getBondColors(bonds);

  // Wrapper for dot + text + picker
  const controlWrapper = document.createElement("div");
  controlWrapper.style.display = "contents";
  controlWrapper.style.alignItems = "center";
  controlWrapper.style.gap = "6px";

  // Row: dot + text
  const row = document.createElement("div");
  //row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "6px";

  const BondInfo = document.createElement("div");
  BondInfo.style.display = "flex";
  BondInfo.style.alignItems = "center";
  BondInfo.style.gap = "20px";


  const Info = document.createElement("div");
  Info.textContent = getBondInfo(bonds[0].name);
  Info.className = "BondInfoText"
  Info.Id = "BondInfoText"
  Info.style.fontSize="14px";
  Info.style.marginTop= "3px";

  const dot = createPieDot(colors, 20);
  dot.style.cursor = "pointer";

  const placeholderText = document.createElement("div");

  BondInfo.appendChild(dot);
  BondInfo.appendChild(Info);

  row.appendChild(BondInfo);

  // Picker panel (hidden by default)
  const pickerPanel = document.createElement("div");
  pickerPanel.style.display = "none";
  pickerPanel.style.marginTop = "4px";
  pickerPanel.style.padding = "6px";
  pickerPanel.style.background = "#2a2a2a";
  pickerPanel.style.borderRadius = "4px";
  pickerPanel.style.boxShadow = "0 2px 6px rgba(0,0,0,0.5)";
  pickerPanel.classList.add("picker-panel"); // for document click listener

  // Color picker
  const picker = createColorPicker(colors[0], (hex) => {
    updateBondColor(bonds, hex); // update all selected bonds
    updatePieDot(dot,[hex])
  });

  pickerPanel.appendChild(picker.element);

  // Show picker only on dot click
  dot.addEventListener("click", (e) => {
    pickerPanel.style.display =
      pickerPanel.style.display === "none" ? "block" : "none";
    e.stopPropagation();
  });

  // Assemble
  controlWrapper.appendChild(row);
  controlWrapper.appendChild(pickerPanel);
  detailsContainer.appendChild(controlWrapper);
}

// Helper: get unique colors of bonds
function getBondColors(bondMeshes) {
  if (!Array.isArray(bondMeshes)) return [];

  const colorsSet = new Set();

  bondMeshes.forEach((bond) => {
    if (bond?.material?.color) {
      const hex = `#${bond.material.color.getHexString()}`;
      colorsSet.add(hex);
    }
  });

  return Array.from(colorsSet);
}

// Helper: update color of all selected bonds
function updateBondColor(bondMeshes, colorHex) {
  if (!Array.isArray(bondMeshes) || bondMeshes.length === 0) return;

  const color = new THREE.Color(colorHex);

  bondMeshes.forEach((mesh) => {
    if (!mesh?.material?.color) return;

    mesh.material.color.set(color);
    mesh.material.needsUpdate = true;
    mesh.material.emissive.setHex(color);
    mesh.material.emissiveIntensity = 2.0;
  });
}

// Global document click listener to close any open picker
document.addEventListener("click", (e) => {
  const openPickers = document.querySelectorAll(".picker-panel");
  openPickers.forEach((pickerPanel) => {
    if (!pickerPanel.parentElement.contains(e.target)) {
      pickerPanel.style.display = "none";
    }
  });
});




function getBondInfo(key) {
  const [i, j] = key.split("-").map(Number);
  let elements = [...fileBrowser.selectedStructure.elements]
  let positions = fileBrowser.selectedStructure.atoms.map(a => a.position);
  let lattice = fileBrowser.selectedStructure.lattice.map(r => [...r]);
  const el1 = elements[i]
  const el2 = elements[j]
  
  const pos1 = fracToCart([positions[i]],lattice)[0]
  const pos2 = fracToCart([positions[j]],lattice)[0]
  const p1 = new THREE.Vector3(pos1[0], pos1[1], pos1[2]);
  const p2 = new THREE.Vector3(pos2[0], pos2[1], pos2[2]);
  const dist = distance(p1, p2).toFixed(3);

  return `${el1}-${el2} ${dist} Å`
}

function distance(pos1, pos2) {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

  








