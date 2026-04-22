import {app, groups,fileBrowser, general} from '../store.js';
import {defaultColorMap, jmolColorMap,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../defaults/color_texture_defaults.js'


// Get the color for an atom (custom or default)
export function getAtomColor(index) {
  return fileBrowser.selectedStructure.atoms[index].getColor();
}

// Set a custom color for an atom
export function setAtomColor(atom, cssHex) {
  return atom.setColor(cssHex);
}

// Reset an atom's color to its element's default
export function resetAtomColor(atom) {
  return atom.resetColor();
}

// Save all custom atom colors to localStorage
export function saveAtomColors(atoms) {
  try {
    const colors = atoms.reduce((acc, atom) => {
      if (atom.uuid && atom.getColor() !== atom.defaultColor) {
        acc[atom.uuid] = atom.getColor();
      }
      return acc;
    }, {});
    localStorage.setItem('atomColors', JSON.stringify(colors));
  } catch (_) {
    console.log("Failed to save atom colors");
  }
}

// Load custom atom colors from localStorage and apply them
export function loadAtomColors(atoms) {
  try {
    const raw = localStorage.getItem('atomColors');
    if (raw) {
      const colors = JSON.parse(raw);
      atoms.forEach(atom => {
        if (atom.uuid && colors[atom.uuid] !== undefined) {
          atom.setColor(colorHexToCss(colors[atom.uuid]));
        }
      });
    }
  } catch (_) {
    console.log("Failed to load atom colors");
  }
}

export function clearAtomColor(atom) {
  return atom.resetColor();
}

// Get all unique colors for atoms of a specific element (custom or default)
export function getAllAtomColorsForElement(atoms, element) {
  return atoms
    .filter(atom => atom.original.element === element)
    .map(atom => colorHexToCss(atom.getColor()));
}

// Check if any atom of the element has a custom color
export function hasCustomAtomColors(atoms, element) {
  return atoms.some(atom =>
    atom.original.element === element && atom.getColor() !== atom.defaultColor
  );
}

// Create a pie dot canvas for an element (showing all custom colors, or default if none)
export function createPieDot(colors, size = 200) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  drawPieDot(canvas, colors);
  canvas.style.borderRadius = "50%";
  canvas.style.border = "1px solid #666";
  canvas.style.display = "inline-block";
  canvas._colors = colors;
  return canvas;
}

// Helper: draw pie dot (unchanged)
function drawPieDot(canvas, colors) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const center = size / 2;
  const radius = center;
  const slice = (2 * Math.PI) / colors.length;

  ctx.clearRect(0, 0, size, size);
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

// Helper: convert hex number to CSS string
export function colorHexToCss(hex) {
  const s = hex.toString(16).padStart(6, '0');
  return `#${s}`;
}

// Helper: convert CSS color to rgba
export function hexToRgba(color, alpha = 1) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = color;
  const computed = ctx.fillStyle;
  const r = parseInt(computed.substr(1, 2), 16);
  const g = parseInt(computed.substr(3, 2), 16);
  const b = parseInt(computed.substr(5, 2), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

