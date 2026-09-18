import {fileBrowser} from '../state/store.js';
import { readStructurePrefs, saveStructurePref, scheduleStructurePrefSave } from '../state/structurePrefs.js';


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

// ---------------------------------------------------------------------------
// Per-atom user colour persistence — the colours a user picks for individual
// atoms / whole elements survive a browser reload.
//
// History: the original save/load pair was switched off in 3ccec17 ("storing
// color is not switched on"), and its replacement (549ce34) was keyed on
// atom.uuid and never called from anywhere — nor could it have worked, since
// uuids are minted from Date.now() on every load (model/InstanceMeshManager.js).
// Storage now lives in state/structurePrefs.js, keyed on the structure's
// CONTENT (so the same file opened again is recognised) with one record per
// structure shared with the other per-structure preferences; this file only
// decides WHAT to store (atom.userColor, by atom index — never derived
// colours such as force mode or the element map) and how to re-apply it.
// ---------------------------------------------------------------------------

/** { [atomIndex]: '#rrggbb' } for every atom with an explicit user override. */
function collectUserColors(structure) {
  const colors = {};
  structure.atoms.forEach((atom, i) => {
    const c = atom.userColor;
    if (typeof c === 'string' ? c !== '' : typeof c === 'number') colors[i] = colorHexToCss(c);
  });
  return colors;
}

/**
 * Save this structure's per-atom user colours. No overrides left -> the
 * field is dropped, so a Reset clears storage too. Called by every colour
 * editor right after it writes atom.userColor; the pickers go through
 * scheduleAtomColorSave instead since they fire on every pointer move.
 * @param {any} [structure] defaults to the selected structure
 * @returns {boolean} whether storage changed
 */
export function saveAtomColors(structure = fileBrowser.selectedStructure) {
  if (!structure?.atoms) return false;
  return saveStructurePref(structure, 'colors', collectUserColors(structure));
}

/**
 * Debounced saveAtomColors for the colour pickers (one write per drag burst).
 * @param {any} [structure] defaults to the selected structure
 */
export function scheduleAtomColorSave(structure = fileBrowser.selectedStructure) {
  if (!structure?.atoms) return;
  scheduleStructurePrefSave(structure, 'colors', () => collectUserColors(structure));
}

/**
 * Re-apply the per-atom user colours saved for this container in an earlier
 * session, to every frame it holds — through the container's own
 * trajectory-wide primitive (forEachFrameMaterialized), so a store-backed
 * trajectory (sparse `structures`, frames materialised on demand) records the
 * colours per frame exactly as "Apply to Trajectory" would. Runs from the
 * single load funnel (ui/StructureInputModule.js initializeUIOnLoad) BEFORE
 * the structure is selected and rendered, so the first rebuild already paints
 * the colours and no extra GPU pass is needed. Returns the number of atom
 * colours applied synchronously (a frame source that reads from disk applies
 * the rest as its frames resolve).
 * @param {any} container a StructureContainer
 * @returns {number}
 */
export function restoreAtomColors(container) {
  const colors = readStructurePrefs(container)?.colors;
  if (!colors || typeof colors !== 'object' || typeof container?.forEachFrameMaterialized !== 'function') return 0;
  const entries = Object.entries(colors).filter(([, hex]) => typeof hex === 'string');
  if (!entries.length) return 0;
  let applied = 0;
  container.forEachFrameMaterialized((frame) => {
    for (const [idx, hex] of entries) {
      const atom = frame.atoms?.[Number(idx)];
      if (!atom) continue;
      // The same two writes every colour editor makes (ColorEditor.js,
      // IndividualAtomRow.js, SelectionActionBar.js): userColor is the
      // authoritative override getColor() reads; color keeps the plain
      // field in step for the paths that read it directly.
      atom.userColor = hex;
      if (atom.setColor(hex)) applied++;
    }
  });
  return applied;
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
  const dpr = window.devicePixelRatio || 1;
  // Backing store at device-pixel resolution, not just `size` (a 1:1 canvas
  // upscaled to its CSS size on any HiDPI display): at these dots' actual
  // on-screen size (18-32px) that upscaling visibly softened the border and
  // let the panel background bleed through right at the wedge seams, which
  // read as a border that "isn't centered" and colors mixing at the edges.
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  updatePieDot(canvas, colors);
  canvas.style.borderRadius = "50%";
  canvas.style.border = "1px solid #666";
  canvas.style.display = "inline-block";
  /** @type {any} */ (canvas)._colors = colors;
  return canvas;
}

export function updatePieDot(canvas, colors) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  // The backing store is size*dpr (see createPieDot); draw in logical
  // (CSS-pixel) coordinates via setTransform, which — unlike ctx.scale —
  // resets to exactly this transform each call rather than compounding on
  // top of a previous one, since this same canvas gets redrawn in place on
  // every recolor (see e.g. PolyhedraListPanel.js's polyCategorySwatchUpdateFunctions).
  const size = canvas.width / dpr;
  const center = size / 2;
  const radius = center;
  const normalizedColors = Array.isArray(colors) && colors.length ? colors : ['#808080'];

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
