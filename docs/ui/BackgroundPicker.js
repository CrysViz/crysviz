// Scene background color picker UI.
// Extracted from crystal-viewer.js (Stage 3). `createBackgroundControl` wires the
// "backgroundDot" element to open a color picker that live-previews and applies
// the three.js scene background (and keeps the lattice color readable).

import * as THREE from '../external/three/three.module.js';
import { app, general } from '../state/store.js';
import { createColorPicker } from './ColorPickerModule.js';
import { updateLattice } from '../render/index.js';

function openBackgroundColorPicker(dot) {
  // Remove any existing picker first
  //
  let currentHex=null
  document.querySelectorAll(".spin-color-picker").forEach(p => p.remove());
  if (app.scene.background) currentHex = "#" + app.scene.background.getHexString();
  let selectedHex = currentHex;


  function getLuminance(hex) {
  // Convert hex to RGB
  const c = hex.startsWith("#") ? hex.substring(1) : hex;
  const r = parseInt(c.substring(0, 2), 16) / 255;
  const g = parseInt(c.substring(2, 4), 16) / 255;
  const b = parseInt(c.substring(4, 6), 16) / 255;

  // Perceived luminance formula
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function getContrastingBorder(hex) {
  const lum = getLuminance(hex);
  return lum > 0.5 ? "#333333" : "#ffffff"; // dark border for light bg, white for dark bg
}

  // --- Create main picker container ---
  const pickerPanel = document.createElement("div");
  pickerPanel.className = "spin-color-picker";
  Object.assign(pickerPanel.style, {
    position: "absolute",
    background: "rgba(26,26,26,0.8)",
    border: "1px solid #ccc",
    padding: "10px",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    zIndex: 9999,
  });

  // --- Create the color picker using existing helper ---
  const { element: pickerElement } = createColorPicker(currentHex, (hex) => {
    selectedHex = hex;
    let contrastColor = `${getContrastingBorder(selectedHex)}`

    dot.style.border = `2px solid ${contrastColor}`
    general.currentLatticeColor = contrastColor
    updateLattice(contrastColor)
    app.scene.background = new THREE.Color(hex);   // live preview in scene
  });


  //dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`;

  // --- Apply / Reset Buttons ---
  const buttonRow = document.createElement("div");
  Object.assign(buttonRow.style, {
    display: "flex",
    justifyContent: "space-between",
    marginTop: "10px",
    gap: "8px"
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.className = 'reset-btn';
  resetBtn.style.cssText = 'height: 32px';
  resetBtn.style.background = general.defaultBackgroundColor;

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  applyBtn.className = 'btn-mini highlight';
  applyBtn.style.cssText = 'height: 32px';


  buttonRow.appendChild(resetBtn);
  buttonRow.appendChild(applyBtn);

  pickerPanel.appendChild(pickerElement);
  pickerPanel.appendChild(buttonRow);
  document.body.appendChild(pickerPanel);

  // --- Position near the dot ---
  const rect = dot.getBoundingClientRect();
  let topPosition = rect.top + window.scrollY + 60;
  let bottomSpace = window.innerHeight - (rect.top + window.scrollY + 24 + pickerPanel.offsetHeight);
  if (bottomSpace < 40) topPosition = window.innerHeight - pickerPanel.offsetHeight - 65;

  pickerPanel.style.left = `${rect.left + window.scrollX - 200}px`;
  pickerPanel.style.top = `${topPosition}px`;

  // --- Close picker helper ---
  const closePicker = () => {
    pickerPanel.remove();
    document.removeEventListener("mousedown", outsideClick);
  };

  const outsideClick = (e) => {
    if (!pickerPanel.contains(e.target) && e.target !== dot) closePicker();
  };

  document.addEventListener("mousedown", outsideClick);
  pickerPanel.addEventListener("mousedown", (e) => e.stopPropagation());

  // --- Apply button behavior ---
  applyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`;
    app.scene.background = new THREE.Color(selectedHex); // lock in color
    closePicker();
  });

  // --- Reset button behavior ---
  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePicker();
    const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
   if (isDarkMode )
    {
    app.scene.background = new THREE.Color(0x090A09)
    general.currentLatticeColor = 0xE7E7E7;
    dot.style.border = `2px solid #E7E7E7`
    updateLattice()
   }
   else if (!isDarkMode )
   {
    app.scene.background = new THREE.Color(0xE7E7E7)
    general.currentLatticeColor = 0x090A09;
    dot.style.border = `2px solid #090A09`
    updateLattice()
   }

  });
}


export function createBackgroundControl() {
  const dot = document.getElementById("backgroundDot");
  if (!dot) {
    console.error("No element found with ID 'backgroundDot'");
    return;
  }

  let currentBackground = app.scene.background

  // Make it visible and clickable
  dot.style.position = "fixed";
  dot.style.zIndex = "999";
  dot.style.pointerEvents = "auto";
  dot.style.borderRadius = "50%";
  dot.style.cursor = "pointer";

  // Attach click listener directly
  dot.addEventListener("click", () => {
    console.warn("background dot clicked")
    openBackgroundColorPicker(dot); // uncomment when scene is ready
  });
}
