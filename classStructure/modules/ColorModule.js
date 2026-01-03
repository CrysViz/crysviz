// store.js contains all state and default variables, e.g. three,js related, colors, default structure, etc.
import { app,structureData, groups, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';


export function getElementColor(element) {
  // Prefer user override if present
  if (general.userColorOverrides && general.userColorOverrides[element] !== undefined) {
    return general.userColorOverrides[element];
  }
  const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
  return colorScheme[element] || 0x808080;
}

export function getIndividualAtomColor(element, atomIndex) {
  // Check if individual atom has custom color
  const atomKey = `${element}_${atomIndex}`;
  if (general.individualAtomColors && general.individualAtomColors[atomKey] !== undefined) {
    return general.individualAtomColors[atomKey];
  }
  // Fall back to element-wide color
  return getElementColor(element);
}

// Get the default palette color for an element (ignores user overrides)
export function getDefaultElementColor(element) {
  const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
  return colorScheme[element] || 0x808080;
}


// This is why the colors are persistent. It is stored in the browser itself. The only thing we store is the customg color state!

export function saveColorOverrides() {
  try { localStorage.setItem('atomColorOverrides', JSON.stringify(general.userColorOverrides || {})); } catch (_) {}
}

export function loadColorOverrides() {
  try {
    const raw = localStorage.getItem('atomColorOverrides');
    if (raw) general.userColorOverrides = JSON.parse(raw) || {};
  } catch (_) { general.userColorOverrides = {}; }
}

export function saveIndividualAtomColors() {
  try { localStorage.setItem('individualAtomColors', JSON.stringify(general.individualAtomColors || {})); } catch (_) {}
}
export function loadIndividualAtomColors() {
  try {
    const raw = localStorage.getItem('individualAtomColors');
    if (raw) general.individualAtomColors = JSON.parse(raw) || {};
  } catch (_) { general.individualAtomColors = {}; }
}

export function setElementColorOverride(el, cssHex) {
  if (!cssHex) return false;
  let hex = cssHex.toString().trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  general.userColorOverrides[el] = parseInt(hex, 16);
  saveColorOverrides();
  return true;
}

export function clearElementColorOverride(el) {
  delete general.userColorOverrides[el];
  saveColorOverrides();
}


export function setIndividualAtomColor(element, atomIndex, cssHex) {
  if (!cssHex) return false;
  let hex = cssHex.toString().trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  const atomKey = `${element}_${atomIndex}`;
  general.individualAtomColors[atomKey] = parseInt(hex, 16);
  saveIndividualAtomColors();
  return true;
}

export function clearIndividualAtomColor(element, atomIndex) {
  const atomKey = `${element}_${atomIndex}`;
  delete general.individualAtomColors[atomKey];
  saveIndividualAtomColors();
}

export function hasIndividualColors(element) {
  if (!general.individualAtomColors) return false;
  return Object.keys(general.individualAtomColors).some(key => key.startsWith(`${element}_`));
}

export function getAllIndividualAtomColors(element) {
  if (!general.individualAtomColors) return [];

  // Collect all individual color overrides for the element
  const currentPalette = Object.entries(general.individualAtomColors)
    .filter(([key]) => key.startsWith(`${element}_`))
    .map(([, color]) => colorHexToCss(color));

  // Count how many atoms of this element are in the structure
  let elementCount = 0;
  for (let i = 0; i < structureData.elements.length; i++) {
    if (structureData.elements[i] === element) {
      elementCount++;
    }
  }

  // If not all atoms are overridden, add the default color too
  if (currentPalette.length < elementCount) {
    const defaultColor = colorHexToCss(getElementColor(element));
    currentPalette.push(defaultColor);
  }

  return currentPalette;
}


export function getElementDisplayColor(element) {
  if (hasIndividualColors(element)) {
    const colors = getAllIndividualAtomColors(element);
    // Defensive: ensure it's an array of strings
    if (Array.isArray(colors) && colors.every(c => typeof c === 'string')) {
      return colors;
    }
    // If not, fallback:
    return [colorHexToCss(getElementColor(element))];
  } else {
    return [colorHexToCss(getElementColor(element))];
  }
}

function drawPieDot(canvas, colors) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;

  ctx.clearRect(0, 0, size, size);

  const center = size / 2;
  const radius = center;
  const slice = (2 * Math.PI) / colors.length;

  colors.forEach((color, i) => {
    const start = i * slice;
    const end = start + slice;

    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.arc(center, center, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  });
}

export function createPieDot(colors, size = 200) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  drawPieDot(canvas, colors);

  canvas.style.borderRadius = "50%";
  canvas.style.border = "1px solid #666";
  canvas.style.display = "inline-block";

  // store colors for later reference (optional but useful)
  canvas._colors = colors;

  return canvas;
}

export function updatePieDot(canvas, newColors) {
  canvas._colors = newColors;
  drawPieDot(canvas, newColors);
}


export function clearAllIndividualColorsForElement(element) {
  if (!general.individualAtomColors) return;
  // Remove all individual colors for this element
  const keysToRemove = Object.keys(general.individualAtomColors).filter(key => key.startsWith(`${element}_`));
  keysToRemove.forEach(key => delete general.individualAtomColors[key]);
  saveIndividualAtomColors();
}

//this function exists twice. need to unified once the colors pickers are unified
export function colorHexToCss(hex) {
    const s = hex.toString(16).padStart(6,'0');
    return `#${s}`;
} 


export function hexToRgba(color, alpha = 1) {
  // Create a dummy element to let the browser parse the color
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = color;
  const computed = ctx.fillStyle; // normalized to #rrggbb

  // Extract RGB from normalized hex (#rrggbb)
  const r = parseInt(computed.substr(1, 2), 16);
  const g = parseInt(computed.substr(3, 2), 16);
  const b = parseInt(computed.substr(5, 2), 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;

}
