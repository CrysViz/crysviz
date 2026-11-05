import { fileBrowser, general } from '../state/store.js';
import { saveStructurePref, scheduleStructurePrefSave, registerStructurePrefField } from '../state/structurePrefs.js';
import { getDefaultBondCutoff } from '../defaults/radii_defaults.js';
import { sizeSliderToValue, sizeValueToSlider, ATOM_SIZE_RANGE, BOND_RADIUS_RANGE } from './ControlsWiring.js';

// ---------------------------------------------------------------------------
// Per-structure persistence (state/structurePrefs.js, issue #18) of the size
// settings: the Atom Size / Bond Diameter sliders, the per-atom radius scales,
// the per-pair / per-bond style stores (size, and with them colour/alpha/
// material, since they are one store) and the customised bond-length ranges.
//
// Stored fields (all dropped when back at default):
//   atomSize            number   general.atomSize
//   bondRadius          number   general.bondRadius
//   atomRadiusScales    { [atomIndex]: scale }   sparse, only != 1
//   bondCategoryStyles  structure.bondCategoryStyles ('El1-El2' -> style)
//   bondUserStyles      structure.bondUserStyles     (bondKey  -> style)
//   bondLengths         { 'El1-El2': {min, max} } only pairs of this structure
//                       that differ from the pair's default AND from the
//                       globally persisted Custom User Settings override.
//
// Atom Size / Bond Diameter are PER STRUCTURE, not global: each container
// keeps its own pair in container.displaySizes and general.atomSize /
// general.bondRadius only mirror the selected one (captureContainerSizes on
// leaving a row, applyContainerSizes on entering one — FileBrowswerPanel.js).
// Before this they were one global pair that was also saved per structure, so
// switching rows carried one structure's size over to the next and the next
// slider edit saved it there. (Deliberate design choice; revert this commit to
// go back to global sizes.)
//
// Every save below is called from a user-edit handler only (rule 1). All
// restorers run in the 'beforeSelect' phase: the first rebuild (atoms, bonds,
// Bonds tab) then already reads the restored values, so no extra render pass
// is needed. The per-structure bond length wins over a Custom User Settings
// override for the same pair (it is applied later, at load, and is the more
// specific edit).
// ---------------------------------------------------------------------------

const EPS = 1e-6;
const round = (v) => Math.round(v * 1e6) / 1e6;

/** The value an Atom Size / Bond Diameter slider starts at (its markup value). */
function sliderDefault(id, range, fallback) {
  const el = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
  const pos = parseFloat(el?.defaultValue ?? '');
  return Number.isFinite(pos) ? sizeSliderToValue(pos, range) : fallback;
}

const atomSizeValue = () =>
  (Math.abs(general.atomSize - sliderDefault('atomSize', ATOM_SIZE_RANGE, 1)) < EPS ? null : round(general.atomSize));
const bondRadiusValue = () =>
  (Math.abs(general.bondRadius - sliderDefault('bondWidth', BOND_RADIUS_RANGE, 0.08)) < EPS ? null : round(general.bondRadius));

/** Debounced save of general.atomSize (the #atomSize slider handler). */
export function scheduleAtomSizeSave(structure = fileBrowser.selectedStructure) {
  if (structure) scheduleStructurePrefSave(structure, 'atomSize', atomSizeValue);
}

/** Debounced save of general.bondRadius (the #bondWidth slider handler). */
export function scheduleBondRadiusSave(structure = fileBrowser.selectedStructure) {
  if (structure) scheduleStructurePrefSave(structure, 'bondRadius', bondRadiusValue);
}

// ---- per-atom radius scales ------------------------------------------------

function collectAtomRadiusScales(structure) {
  const out = {};
  structure.atoms.forEach((atom, i) => {
    const s = atom?.getRadiusScale?.() ?? 1;
    if (Math.abs(s - 1) > 1e-9) out[i] = round(s);
  });
  return out;
}

/** Save the displayed frame's per-atom radius scales now (discrete edits: resets). */
export function saveAtomRadiusScales(structure = fileBrowser.selectedStructure) {
  if (!structure?.atoms) return false;
  return saveStructurePref(structure, 'atomRadiusScales', collectAtomRadiusScales(structure));
}

/** Debounced saveAtomRadiusScales for the size sliders. */
export function scheduleAtomRadiusScaleSave(structure = fileBrowser.selectedStructure) {
  if (!structure?.atoms) return;
  scheduleStructurePrefSave(structure, 'atomRadiusScales', () => collectAtomRadiusScales(structure));
}

// ---- bond style stores -------------------------------------------------------

/** Plain-JSON copy of a style store without entries that carry no style
 *  (a bondUserStyles entry is created as { elements } before its first field). */
function copyStyleStore(store) {
  const out = {};
  for (const [k, entry] of Object.entries(store ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Object.keys(entry).some((f) => f !== 'elements')) continue;
    out[k] = JSON.parse(JSON.stringify(entry));
  }
  return out;
}

/** Save both bond style stores of the displayed frame now. */
export function saveBondStyles(structure = fileBrowser.selectedStructure) {
  if (!structure) return false;
  const a = saveStructurePref(structure, 'bondCategoryStyles', copyStyleStore(structure.bondCategoryStyles));
  const b = saveStructurePref(structure, 'bondUserStyles', copyStyleStore(structure.bondUserStyles));
  return a || b;
}

/** Debounced saveBondStyles for sliders / colour pickers. */
export function scheduleBondStyleSave(structure = fileBrowser.selectedStructure) {
  if (!structure) return;
  scheduleStructurePrefSave(structure, 'bondCategoryStyles', () => copyStyleStore(structure.bondCategoryStyles));
  scheduleStructurePrefSave(structure, 'bondUserStyles', () => copyStyleStore(structure.bondUserStyles));
}

// ---- bond lengths ------------------------------------------------------------

function pairDefault(pair) {
  const d = general.defaultBondLengths?.[pair];
  if (d) return d;
  const [a, b] = pair.split('-');
  return { min: 0, max: getDefaultBondCutoff(a, b) };
}

const sameRange = (x, y) => !!x && !!y && Math.abs(x.min - y.min) < EPS && Math.abs(x.max - y.max) < EPS;

function collectBondLengths(structure) {
  const out = {};
  const els = [...new Set(structure.elements ?? [])];
  for (let i = 0; i < els.length; i++) {
    for (let j = i; j < els.length; j++) {
      const pair = els[i] < els[j] ? `${els[i]}-${els[j]}` : `${els[j]}-${els[i]}`;
      const v = general.bondLengths[pair];
      if (!v || sameRange(v, pairDefault(pair))) continue;
      // Already persisted globally by the Custom User Settings panel.
      if (sameRange(v, general.customBondLengths?.[pair])) continue;
      out[pair] = { min: round(v.min), max: round(v.max) };
    }
  }
  return out;
}

/** Save the customised bond-length ranges now (the Reset Bond Lengths button). */
export function saveBondLengths(structure = fileBrowser.selectedStructure) {
  if (!structure) return false;
  return saveStructurePref(structure, 'bondLengths', collectBondLengths(structure));
}

/** Debounced saveBondLengths for the Bonds-tab range sliders. */
export function scheduleBondLengthSave(structure = fileBrowser.selectedStructure) {
  if (!structure) return;
  scheduleStructurePrefSave(structure, 'bondLengths', () => collectBondLengths(structure));
}

// ---- restore -----------------------------------------------------------------

function setSizeSlider(id, labelId, value, range) {
  const slider = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
  if (slider) slider.value = String(sizeValueToSlider(value, range));
  const span = document.getElementById(labelId);
  if (span) span.textContent = Number(value).toFixed(2);
}

const clampSize = (v, range) => Math.min(range.max, Math.max(range.min, v));

/** The container's size pair, created at the slider defaults when missing. */
function ensureSizes(container) {
  if (!container.displaySizes) {
    container.displaySizes = {
      atomSize: sliderDefault('atomSize', ATOM_SIZE_RANGE, 1),
      bondRadius: sliderDefault('bondWidth', BOND_RADIUS_RANGE, 0.08),
    };
  }
  return container.displaySizes;
}

/**
 * Give a freshly loaded container the default sizes (called by
 * initializeUIOnLoad before the stored-prefs restorers, which may then
 * override them). A load that skips stored prefs (share link, .crysviz,
 * widget) leaves displaySizes null so the container adopts the sizes that
 * load just applied.
 */
export function seedContainerSizes(container) {
  if (container) { container.displaySizes = null; ensureSizes(container); }
}

/** Remember the live sizes on the container being left. */
export function captureContainerSizes(container) {
  if (container) container.displaySizes = { atomSize: general.atomSize, bondRadius: general.bondRadius };
}

/** Make the container's sizes live (general + sliders) before it is rendered;
 *  a container without its own pair adopts the live one. */
export function applyContainerSizes(container) {
  if (!container) return;
  if (!container.displaySizes) { captureContainerSizes(container); return; }
  const { atomSize, bondRadius } = container.displaySizes;
  general.atomSize = atomSize;
  general.bondRadius = bondRadius;
  setSizeSlider('atomSize', 'atomSizeValue', atomSize, ATOM_SIZE_RANGE);
  setSizeSlider('bondWidth', 'bondWidthValue', bondRadius, BOND_RADIUS_RANGE);
}

function restoreAtomSize(container, value) {
  const v = Number(value);
  if (!container || !Number.isFinite(v) || v <= 0) return;
  ensureSizes(container).atomSize = clampSize(v, ATOM_SIZE_RANGE);
}

function restoreBondRadius(container, value) {
  const v = Number(value);
  if (!container || !Number.isFinite(v) || v <= 0) return;
  ensureSizes(container).bondRadius = clampSize(v, BOND_RADIUS_RANGE);
}

function restoreAtomRadiusScales(container, value) {
  if (!value || typeof value !== 'object' || typeof container?.forEachFrameMaterialized !== 'function') return;
  const entries = Object.entries(value).filter(([, s]) => Number.isFinite(Number(s)));
  if (!entries.length) return;
  container.forEachFrameMaterialized((frame) => {
    for (const [idx, s] of entries) frame.atoms?.[Number(idx)]?.setRadiusScale?.(Number(s));
  });
}

function styleStoreRestorer(field) {
  return (container, value) => {
    if (!value || typeof value !== 'object' || typeof container?.forEachFrameMaterialized !== 'function') return;
    container.forEachFrameMaterialized((frame) => {
      frame[field] = { ...(frame[field] ?? {}), ...JSON.parse(JSON.stringify(value)) };
    });
  };
}

function restoreBondLengths(_container, value) {
  if (!value || typeof value !== 'object') return;
  for (const [pair, r] of Object.entries(value)) {
    const min = Number(r?.min);
    const max = Number(r?.max);
    if (!/^[A-Za-z]+-[A-Za-z]+$/.test(pair) || !Number.isFinite(min) || !Number.isFinite(max)) continue;
    // Seed the pair's default first: createBondLengthControls only seeds it
    // when the pair has no range yet, and Reset Bond Lengths resets to it.
    if (!general.defaultBondLengths[pair]) general.defaultBondLengths[pair] = pairDefault(pair);
    if (general.bondVisibility[pair] === undefined) general.bondVisibility[pair] = true;
    general.bondLengths[pair] = { min, max };
  }
}

registerStructurePrefField('atomSize', restoreAtomSize, { phase: 'beforeSelect' });
registerStructurePrefField('bondRadius', restoreBondRadius, { phase: 'beforeSelect' });
registerStructurePrefField('atomRadiusScales', restoreAtomRadiusScales, { phase: 'beforeSelect' });
registerStructurePrefField('bondCategoryStyles', styleStoreRestorer('bondCategoryStyles'), { phase: 'beforeSelect' });
registerStructurePrefField('bondUserStyles', styleStoreRestorer('bondUserStyles'), { phase: 'beforeSelect' });
registerStructurePrefField('bondLengths', restoreBondLengths, { phase: 'beforeSelect' });
