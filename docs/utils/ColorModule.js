import {fileBrowser} from '../state/store.js';


// Get the color for an atom (custom or default). Guards against a stale index —
// e.g. an instanced-mesh/comparison update iterating more atoms than the
// newly-selected structure has — by falling back to the default grey instead of
// throwing on atoms[index] being undefined.
export function getAtomColor(index) {
  const atom = fileBrowser.selectedStructure?.atoms?.[index];
  return atom ? atom.getColor() : 0x808080;
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
  updatePieDot(canvas, colors);
  canvas.style.borderRadius = "50%";
  canvas.style.border = "1px solid #666";
  canvas.style.display = "inline-block";
  /** @type {any} */ (canvas)._colors = colors;
  return canvas;
}

export function updatePieDot(canvas, colors) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const center = size / 2;
  const radius = center;
  const normalizedColors = Array.isArray(colors) && colors.length ? colors : ['#808080'];

  ctx.clearRect(0, 0, size, size);

  // Most atoms of an element share a single color, so draw one wedge per
  // *unique* color (angle proportional to its count) rather than one sub-pixel
  // slice per atom. For the common single-color case this is one fill instead
  // of thousands, which matters for large structures.
  const counts = new Map();
  for (const c of normalizedColors) counts.set(c, (counts.get(c) || 0) + 1);

  if (counts.size === 1) {
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, 2 * Math.PI);
    ctx.fillStyle = normalizedColors[0];
    ctx.fill();
  } else {
    const total = normalizedColors.length;
    let start = 0;
    for (const [color, count] of counts) {
      const end = start + (2 * Math.PI * count) / total;
      ctx.beginPath();
      ctx.moveTo(center, center);
      ctx.arc(center, center, radius, start, end);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      start = end;
    }
  }
  canvas._colors = normalizedColors;
}

// Helper: convert hex number to CSS string
export function colorHexToCss(hex) {
  // Atom colours are stored inconsistently: `atom.color` / default colours are numeric
  // hex, but `atom.userColor` (set by the colour picker) is a CSS string. getColor() can
  // return either, so normalise both to a valid `#rrggbb` here — otherwise a string input
  // hit `"#0000ff".toString(16)` → `"##0000ff"`, an invalid colour that rendered grey.
  if (typeof hex === 'string') {
    const t = hex.trim();
    if (t.startsWith('#')) return t;                 // already CSS hex
    if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t}`;  // bare 6-digit hex
    const n = Number(t);
    if (!Number.isFinite(n)) return t;               // named colour / rgb(...) — pass through
    hex = n;                                         // numeric string → fall through
  }
  const s = (Number(hex) >>> 0).toString(16).padStart(6, '0').slice(-6);
  return `#${s}`;
}

// Helper: convert CSS color to rgba
export function hexToRgba(color, alpha = 1) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = color;
  const computed = /** @type {string} */ (ctx.fillStyle);
  const r = parseInt(computed.substr(1, 2), 16);
  const g = parseInt(computed.substr(3, 2), 16);
  const b = parseInt(computed.substr(5, 2), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
