import * as THREE from '../external/three/three.module.js';
import {structureShip, measurements,app, groups,fileBrowser, general, mode, highlightHover} from '../store.js';
import {themes,defaultColorMap, jmolColorMap,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../defaults/color_texture_defaults.js'
import {updateLattice} from '../modules/LatticeModule.js'
import { createColorPicker } from './ColorPickerModule.js';

export function getLuminance(hex) {
  const c = hex.startsWith("#") ? hex.substring(1) : hex;
  const r = parseInt(c.substring(0, 2), 16) / 255;
  const g = parseInt(c.substring(2, 4), 16) / 255;
  const b = parseInt(c.substring(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function getContrastingBorder(hex) {
  const lum = getLuminance(hex);
  return lum > 0.5 ? "#333333" : "#ffffff";
}

export function applyTheme(themeName) {
  const theme = themes[themeName];
  if (!theme) return;
  console.log("applying theme",themeName)
  app.scene.background = new THREE.Color(theme.background);
  general.defaultBackgroundColor = theme.background;
  general.currentLatticeColor = theme.latticeColor;

  const dot = document.getElementById("backgroundDot");
  if (dot) {
    dot.style.border = `2px solid ${theme.latticeColor}`;
    updateLattice();
  }

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeOption === themeName);
  });

  localStorage.setItem('theme', themeName);
}

export function setupThemeSystem() {
  const userTheme = localStorage.getItem('theme');
  const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(userTheme || (isDarkMode ? 'dark' : 'light'));

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', (e) => {
    applyTheme(e.matches ? 'dark' : 'twilight');  
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeOption));
  });
}


export function openBackgroundColorPicker(dot) {
  document.querySelectorAll(".spin-color-picker").forEach(p => p.remove());
  let currentHex = app.scene.background ? "#" + app.scene.background.getHexString() : "#090A09";
  let selectedHex = currentHex;

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

  const { element: pickerElement } = createColorPicker(currentHex, (hex) => {
    selectedHex = hex;
    const contrastColor = getContrastingBorder(selectedHex);
    dot.style.border = `2px solid ${contrastColor}`;
    general.currentLatticeColor = contrastColor;
    updateLattice(contrastColor);
    if (app?.scene) app.scene.background = new THREE.Color(hex);
  });

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

  const rect = dot.getBoundingClientRect();
  let topPosition = rect.top + window.scrollY + 60;
  let bottomSpace = window.innerHeight - (rect.top + window.scrollY + 24 + pickerPanel.offsetHeight);
  if (bottomSpace < 40) topPosition = window.innerHeight - pickerPanel.offsetHeight - 65;

  pickerPanel.style.left = `${rect.left + window.scrollX - 200}px`;
  pickerPanel.style.top = `${topPosition}px`;

  const closePicker = () => {
    pickerPanel.remove();
    document.removeEventListener("mousedown", outsideClick);
  };

  const outsideClick = (e) => {
    if (!pickerPanel.contains(e.target) && e.target !== dot) closePicker();
  };
  document.addEventListener("mousedown", outsideClick);
  pickerPanel.addEventListener("mousedown", (e) => e.stopPropagation());

  applyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dot.style.border = `2px solid ${getContrastingBorder(selectedHex)}`;
    if (app?.scene) app.scene.background = new THREE.Color(selectedHex);
    closePicker();
  });

  resetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePicker();
    const currentTheme = localStorage.getItem('theme') ||
                       document.querySelector('.theme-btn.active')?.dataset.themeOption ||
                       (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(currentTheme);
  });
}

export function createBackgroundControl() {
  const dot = document.getElementById("backgroundDot");
  if (!dot) return;
  dot.style.position = "fixed";
  dot.style.zIndex = "999";
  dot.style.pointerEvents = "auto";
  dot.style.borderRadius = "50%";
  dot.style.cursor = "pointer";
  dot.addEventListener("click", () => openBackgroundColorPicker(dot));
}
