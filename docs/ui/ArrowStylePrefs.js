import * as THREE from '../external/three/three.module.js';
import { fileBrowser, general } from '../state/store.js';
import { getContainerForStructure } from '../state/structures.js';
import {
  readStructurePrefs, saveStructurePref, scheduleStructurePrefSave,
  registerStructurePrefField, onClearLocalData,
} from '../state/structurePrefs.js';
import { updateSpins, updateForces, removeSpins, removeForces } from '../render/index.js';
import { rebuildPanel } from './panels/PanelManager.js';

// ---------------------------------------------------------------------------
// Per-structure spin / force arrow styles (issue #18), stored through
// state/structurePrefs.js under the fields `spinStyle` and `forceStyle`:
//
//   { scale?, radius?, tipLength? (spin only), lengthLogScale?, colorMap?,
//     min?, max?, colorScale?, legendText?,
//     categoryStyles?: { [element]: { color?, material? } },
//     arrowColors?: { [atomIndex]: '#rrggbb' }, hidden?: number[] }
//
// Only keys the user changed are kept: every save is a PATCH (the keys the
// edit touched) merged onto the stored value, then any key back at its
// store.js default is dropped, and the whole field once nothing is left.
// Saves come only from the user-edit handlers in SpinPanel.js /
// ForcePanel.js / SpinForceCategoryEditor.js / SpinForceEditor.js (rule 1
// in structurePrefs.js); updateSpins/updateForces, the panels' build paths
// and the share load never save.
// ---------------------------------------------------------------------------

const SPECS = {
  spin: {
    field: 'spinStyle',
    panel: 'spins',
    arrays: 'spins',
    stylesKey: 'spinCategoryStyles',
    defaultLegend: 'Spin (μB)',
    general: {
      scale: 'spinScale', radius: 'spinRadius', tipLength: 'spinTipLength',
      lengthLogScale: 'spinLengthLogScale', colorMap: 'spinColorMap',
      min: 'spinMin', max: 'spinMax', colorScale: 'spinColorScale',
      legendText: 'spinLegendText',
    },
    // Mirrors the `general` initialisers in state/store.js.
    defaults: {
      scale: 1.0, radius: 0.08, tipLength: 0.4, lengthLogScale: false,
      colorMap: 'none', min: 0, max: 2, colorScale: 'linear', legendText: null,
    },
  },
  force: {
    field: 'forceStyle',
    panel: 'forces',
    arrays: 'forces',
    stylesKey: 'forceCategoryStyles',
    defaultLegend: 'Force (eV/Å)',
    general: {
      scale: 'forceScale', radius: 'forceRadius',
      lengthLogScale: 'forceLengthLogScale', colorMap: 'forceColorMap',
      min: 'forceMin', max: 'forceMax', colorScale: 'forceColorScale',
      legendText: 'forceLegendText',
    },
    defaults: {
      scale: 1.0, radius: 0.08, lengthLogScale: false,
      colorMap: 'heatmap', min: 0, max: 2, colorScale: 'linear', legendText: null,
    },
  },
};

/** container -> { spin?: {min,max}, force?: {min,max} }: the colour range
 *  the user set (or that was restored) for that structure, so a panel
 *  (re)build shows it instead of recomputing one from the data. */
const userRanges = new WeakMap();

/** structure -> { spin: { keys, atoms }, force: { keys, atoms } }: what a
 *  debounced (slider / colour-drag) save still has to read, kept PER
 *  STRUCTURE — scheduleStructurePrefSave flushes a pending save of another
 *  structure first, and a shared set would be drained by that flush. */
const pendingByStructure = new WeakMap();
/** Bumped by clearLocalData: entries of an older generation are stale. */
let pendingGeneration = 0;

function pendingFor(kind, structure) {
  let byKind = pendingByStructure.get(structure);
  if (!byKind || byKind.generation !== pendingGeneration) {
    byKind = { generation: pendingGeneration };
    pendingByStructure.set(structure, byKind);
  }
  return byKind[kind] ??= { keys: new Set(), atoms: new Set() };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function containerOf(structure) {
  if (!structure) return null;
  if (Array.isArray(structure.structures)) return structure;
  return getContainerForStructure(structure);
}

/** Drop default-valued / empty keys. Returns null when nothing is left. */
function normalize(kind, value) {
  const spec = SPECS[kind];
  const out = {};
  for (const [key, v] of Object.entries(value ?? {})) {
    if (v === undefined) continue;
    if (key === 'legendText') {
      if (v != null && v !== spec.defaultLegend) out.legendText = v;
    } else if (key === 'min' || key === 'max') {
      continue; // handled as a pair below
    } else if (key === 'categoryStyles') {
      const styles = {};
      for (const [el, st] of Object.entries(v ?? {})) {
        const s = {};
        if (st?.color != null) s.color = st.color;
        if (st?.material != null) s.material = st.material;
        if (Object.keys(s).length) styles[el] = s;
      }
      if (Object.keys(styles).length) out.categoryStyles = styles;
    } else if (key === 'arrowColors') {
      if (v && Object.keys(v).length) out.arrowColors = v;
    } else if (key === 'hidden') {
      if (Array.isArray(v) && v.length) out.hidden = [...new Set(v)].sort((a, b) => a - b);
    } else if (key in spec.defaults) {
      if (v !== spec.defaults[key]) out[key] = v;
    }
  }
  // The colour range only means something as a pair.
  const min = value?.min, max = value?.max;
  if (Number.isFinite(min) && Number.isFinite(max)
    && (min !== spec.defaults.min || max !== spec.defaults.max)) {
    out.min = min;
    out.max = max;
  }
  return Object.keys(out).length ? out : null;
}

/** The current value of each named key, read from `general` / the structure. */
function readKeys(kind, keys, structure) {
  const spec = SPECS[kind];
  const patch = {};
  for (const key of keys) {
    if (key === 'categoryStyles') patch.categoryStyles = clone(structure?.[spec.stylesKey] ?? {});
    else if (key in spec.general) patch[key] = general[spec.general[key]];
  }
  return patch;
}

function mergedValue(kind, structure, patch) {
  const spec = SPECS[kind];
  const stored = readStructurePrefs(containerOf(structure))?.[spec.field] ?? {};
  const next = normalize(kind, { ...stored, ...patch });
  if (next && 'min' in next) {
    const container = containerOf(structure);
    if (container) userRanges.set(container, { ...(userRanges.get(container) ?? {}), [kind]: { min: next.min, max: next.max } });
  }
  return next;
}

/**
 * Save the named keys of a user edit NOW (discrete edits: selects,
 * checkboxes, buttons, colour-bar commits). Keys: scale, radius, tipLength,
 * lengthLogScale, colorMap, min, max (both are read), colorScale,
 * legendText, categoryStyles.
 * @param {string} kind 'spin' | 'force'
 * @param {string[]} keys
 * @param {any} [structure]
 */
export function saveArrowStyle(kind, keys, structure = fileBrowser.selectedStructure) {
  if (!structure || !SPECS[kind]) return;
  const all = keys.includes('min') || keys.includes('max') ? [...keys, 'min', 'max'] : keys;
  saveStructurePref(structure, SPECS[kind].field, mergedValue(kind, structure, readKeys(kind, all, structure)));
}


function overridePatch(kind, structure, stored, atoms) {
  const spec = SPECS[kind];
  const arrowColors = { ...(stored.arrowColors ?? {}) };
  const hidden = new Set(stored.hidden ?? []);
  for (const atomIndex of atoms) {
    const obj = structure[spec.arrays]?.[atomIndex];
    const color = obj?.userColor;
    if (color) arrowColors[atomIndex] = color.isColor ? `#${color.getHexString()}` : String(color);
    else delete arrowColors[atomIndex];
    if (obj?.hidden) hidden.add(atomIndex);
    else hidden.delete(atomIndex);
  }
  return { arrowColors, hidden: [...hidden] };
}

// One debounced getValue per kind covers every slider key and every
// per-arrow colour drag of the burst (they share the stored field).
function schedule(kind, structure) {
  scheduleStructurePrefSave(structure, SPECS[kind].field, () => {
    const pending = pendingFor(kind, structure);
    const keys = [...pending.keys];
    const atoms = [...pending.atoms];
    pending.keys.clear();
    pending.atoms.clear();
    const stored = readStructurePrefs(containerOf(structure))?.[SPECS[kind].field] ?? {};
    const patch = readKeys(kind, keys, structure);
    if (atoms.length) Object.assign(patch, overridePatch(kind, structure, stored, atoms));
    return mergedValue(kind, structure, patch);
  });
}

/**
 * Debounced saveArrowStyle for sliders (one write per drag burst); the keys
 * of every slider touched in the burst are read at flush time.
 * @param {string} kind 'spin' | 'force'
 * @param {string[]} keys
 * @param {any} [structure]
 */
export function scheduleArrowStyleSave(kind, keys, structure = fileBrowser.selectedStructure) {
  if (!structure || !SPECS[kind]) return;
  const pending = pendingFor(kind, structure);
  keys.forEach((k) => pending.keys.add(k));
  schedule(kind, structure);
}

/**
 * Save one arrow's own overrides (userColor / hidden) after the per-atom
 * Spin/Force editor changed them.
 * @param {string} kind 'spin' | 'force'
 * @param {number} atomIndex
 * @param {any} [structure]
 */
export function saveArrowOverride(kind, atomIndex, structure = fileBrowser.selectedStructure) {
  const spec = SPECS[kind];
  if (!structure || !spec) return;
  const stored = readStructurePrefs(containerOf(structure))?.[spec.field] ?? {};
  saveStructurePref(structure, spec.field, mergedValue(kind, structure, overridePatch(kind, structure, stored, [atomIndex])));
}

/**
 * Re-collect EVERY per-arrow override and the category styles from the
 * structure's current state and save them (the Structure window's "Reset
 * Colors" / "Reset Styling" buttons, StructureInfoPanel/General.js, strip
 * them all at once). Reads the structure, not the stored record, so cleared
 * overrides are dropped from storage.
 * @param {string} kind 'spin' | 'force'
 * @param {any} [structure]
 */
export function saveArrowOverridesFromStructure(kind, structure = fileBrowser.selectedStructure) {
  const spec = SPECS[kind];
  if (!structure || !spec) return;
  const count = structure[spec.arrays]?.length ?? 0;
  const atoms = Array.from({ length: count }, (_, i) => i);
  const patch = { ...readKeys(kind, ['categoryStyles'], structure), ...overridePatch(kind, structure, {}, atoms) };
  saveStructurePref(structure, spec.field, mergedValue(kind, structure, patch));
}

/** Debounced saveArrowOverride for the per-arrow colour picker drags. */
export function scheduleArrowOverrideSave(kind, atomIndex, structure = fileBrowser.selectedStructure) {
  if (!structure || !SPECS[kind]) return;
  pendingFor(kind, structure).atoms.add(atomIndex);
  schedule(kind, structure);
}

/**
 * The colour range the user set (or that was restored) for the selected
 * structure, applied to general.*Min/*Max. Called by a panel's build so it
 * shows that range instead of recomputing one. Returns whether it applied.
 * @param {string} kind 'spin' | 'force'
 */
export function applyUserArrowRange(kind) {
  const spec = SPECS[kind];
  const range = userRanges.get(containerOf(fileBrowser.selectedStructure))?.[kind];
  if (!spec || !range || !(range.min < range.max)) return false;
  general[spec.general.min] = range.min;
  general[spec.general.max] = range.max;
  return true;
}

function redraw(kind, structure) {
  if (kind === 'spin') {
    if (general.spinsActive && structure?.spins?.length) updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap ?? 'none');
    else removeSpins();
  } else if (general.forcesActive && structure?.forces?.length) {
    updateForces(general.forceScale ?? 1.0, general.forceColorMap ?? 'heatmap');
  } else {
    removeForces();
  }
}

/**
 * Re-apply a stored spinStyle / forceStyle: general.* keys, the per-element
 * category styles and per-arrow overrides on every frame, the panel widgets
 * (the panel rebuilds from general.*), then the arrows. Never saves.
 * @param {string} kind 'spin' | 'force'
 * @param {any} container
 * @param {any} value
 * @param {any} structure the displayed frame
 */
export function restoreArrowStyle(kind, container, value, structure = fileBrowser.selectedStructure) {
  const spec = SPECS[kind];
  if (!spec || !value || typeof value !== 'object') return;
  for (const [key, genKey] of Object.entries(spec.general)) {
    if (key === 'min' || key === 'max') continue;
    if (value[key] !== undefined) general[genKey] = value[key];
  }
  if (value.lengthLogScale === true) general[spec.general.colorScale] = 'log';
  if (Number.isFinite(value.min) && Number.isFinite(value.max) && value.min < value.max) {
    general[spec.general.min] = value.min;
    general[spec.general.max] = value.max;
    if (container) userRanges.set(container, { ...(userRanges.get(container) ?? {}), [kind]: { min: value.min, max: value.max } });
  }

  const styles = value.categoryStyles && typeof value.categoryStyles === 'object' ? value.categoryStyles : null;
  const colors = value.arrowColors && typeof value.arrowColors === 'object' ? Object.entries(value.arrowColors) : [];
  const hidden = Array.isArray(value.hidden) ? value.hidden : [];
  const applyFrame = (frame) => {
    if (styles) frame[spec.stylesKey] = clone(styles);
    const arrows = frame[spec.arrays];
    if (!arrows) return;
    for (const [idx, hex] of colors) {
      const a = arrows[Number(idx)];
      if (a && typeof hex === 'string') a.userColor = new THREE.Color(hex);
    }
    for (const idx of hidden) {
      const a = arrows[idx];
      if (a) a.hidden = true;
    }
  };
  if (styles || colors.length || hidden.length) {
    if (typeof container?.forEachFrameMaterialized === 'function') container.forEachFrameMaterialized(applyFrame);
    else if (structure) applyFrame(structure);
  }

  // The panel reads general.* (and applyUserArrowRange) when it builds: a
  // built panel is rebuilt now, an unbuilt one picks the values up later.
  rebuildPanel(spec.panel);
  redraw(kind, structure ?? fileBrowser.selectedStructure);
}

registerStructurePrefField('spinStyle', (container, value, structure) => restoreArrowStyle('spin', container, value, structure));
registerStructurePrefField('forceStyle', (container, value, structure) => restoreArrowStyle('force', container, value, structure));

// clearLocalData cancels the timers that would read the pending sets; the
// generation bump makes every structure's leftover keys stale so the next
// user edit starts a fresh burst (a WeakMap cannot be iterated to clear).
onClearLocalData(() => { pendingGeneration++; });
