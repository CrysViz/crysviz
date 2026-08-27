// Bulk-visuals bar for the current multi-atom selection, docked at the top of
// the Structure Info panel. It is deliberately NOT a second per-species
// editor: it shows the live selection (however many elements it spans) and a
// small set of visual controls — color, alpha, size — that apply to EVERY
// selected atom at once. The per-row/per-species editors below stay the
// canonical place to style one thing; this bar is the "do it to all of these"
// surface.
//
// Selection itself lives in atomSelection (state/store.js) and is driven from
// the 3D view (double-click, Shift-add, Shift+drag marquee — see
// ui/SceneInteraction.js) and the panel rows. This module only subscribes to
// that selection and fans a chosen edit out over it; it never opens the panel
// or changes what is selected (except its own Clear button).

import { fileBrowser, groups, mode, general } from '../../state/store.js';
import { getAtomColor, setAtomColor, colorHexToCss, createPieDot, updatePieDot } from '../../utils/ColorModule.js';
import {
  updateSingleAtomColor, updateSingleAtomOpacity, updateSingleAtomDiameter,
  clearAtomImageStylesForAtom, setAtomImageStyle, clearAtomImageStyle,
  getAtomImageStyle, getAtomImageColor, updateSingleAtomImageColor,
} from '../../render/AtomsFracUpdateModule.js';
import { setSpeciesColorBulk, updatePolyhedraColors, scheduleBondRebuild } from '../../render/index.js';
import { updateMeasurementMarkers } from '../../render/MeasurementModule.js';
import { refreshGhostAtoms } from '../../render/GhostAtomsModule.js';
import { syncBondHalvesToImageColor } from '../ColorPanel.js';
import { openSwatchColorPicker } from '../SwatchColorPicker.js';
import {
  getSelectedAtoms, subscribeToAtomSelection, clearSelectedAtoms,
  suppressSelectionHighlightFor3D, restoreSelectionHighlight,
} from '../SelectAndHighlightModule.js';
import { setStructurePanelOpen } from './General.js';
import { collapseAllAtomExpansions } from '../WindowAndSceneControls.js';
import { clampOpacity, clampRadiusScale } from './components/utils.js';

const BAR_ID = 'selectionActionBar';
let coordinatesExpanded = false;

// Fired after a bulk alpha/size (or reset) edit so any open individual-atom
// rows re-read their alpha/size controls from the model — the counterpart of
// 'crysviz:colors-changed' for the two style fields that event doesn't cover.
// IndividualAtomRow.js registers the listener.
const ATOM_STYLE_CHANGED = 'crysviz:atom-style-changed';

// Ensure a valid CSS hex — same guard IndividualAtomRow uses for swatch colors.
function safeColor(color) {
  if (!color || color === '#') return '#808080';
  if (typeof color === 'number') return colorHexToCss(color);
  if (typeof color === 'string' && !color.startsWith('#')) return `#${color}`;
  return color;
}

// "Link periodic copies" governs whether a bulk edit fans out to every
// periodic image of a selected atom (linked, the default) or touches ONLY the
// selected on-screen copies (unlinked) — the same split the per-row editors
// make (IndividualAtomRow.js's linked vs perImage branches). A bulk edit must
// honour it too, or unlinking is meaningless: recolouring one copy would still
// recolour them all.
function atomLinked() {
  return general.linkPeriodicCopies !== false;
}

// Unique SOURCE indices of the current selection (one per physical atom).
function selectedSourceIndices(selected = getSelectedAtoms()) {
  const set = new Set();
  selected.forEach((atom) => {
    if (Number.isInteger(atom.sourceIndex)) set.add(atom.sourceIndex);
  });
  return [...set];
}

// Current color of each selected atom, in selection order — fed to the pie
// dot so a uniform selection reads as one solid dot and a mixed one as wedges
// (weighted by how many atoms carry each color, same language as the
// composition/atom-row pie dots). Linked reads the source atom's color;
// unlinked reads each selected copy's own (per-image) color.
function selectionColors(selected) {
  const structure = fileBrowser.selectedStructure;
  if (atomLinked()) {
    return selectedSourceIndices(selected).map((idx) => safeColor(getAtomColor(idx)));
  }
  return selected.map((atom) => safeColor(getAtomImageColor(structure, atom.instanceId)));
}

// "6 selected · Fe×3, O×2, Na" — count plus a per-element tally so a
// multi-element selection reads at a glance without pretending one species is
// canonical.
function selectionSummary(selected) {
  const counts = {};
  selected.forEach((atom) => {
    const el = atom.element || '?';
    counts[el] = (counts[el] || 0) + 1;
  });
  const parts = Object.keys(counts).sort().map((el) => (counts[el] > 1 ? `${el}×${counts[el]}` : el));
  return `${selected.length} selected · ${parts.join(', ')}`;
}

function selectedCoordinateRows(selected) {
  const structure = fileBrowser.selectedStructure;
  const wrapped = structure?.periodic?.visibleWrapped;
  return selected.map((atom) => {
    const instanceId = atom.instanceId;
    const fractional = wrapped?.frac?.[instanceId] ?? structure?.atoms?.[atom.sourceIndex]?.position;
    const p = atom.position;
    const cartesian = wrapped?.cart?.[instanceId]
      ?? (p && [p.x, p.y, p.z].every(Number.isFinite) ? [p.x, p.y, p.z] : null);
    return {
      label: `${atom.element ?? '?'} ${Number(atom.sourceIndex) + 1}`,
      fractional,
      cartesian,
    };
  });
}

function coordinateText(rows, key) {
  const lines = rows.map((row) => {
    const values = row[key];
    return `${row.label}\t${values?.map((value) => Number(value).toFixed(8)).join('\t') ?? 'unavailable'}`;
  });
  return ['Atom\tx\ty\tz', ...lines].join('\n');
}

function copyText(text, button) {
  const copied = () => {
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1200);
  };
  const fallback = () => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    if (document.execCommand('copy')) copied();
    textarea.remove();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(copied, fallback);
  else fallback();
}

function buildCoordinateViewer(selected) {
  const rows = selectedCoordinateRows(selected);
  const viewer = document.createElement('div');
  viewer.className = 'si-selbar-coordinates';
  const addBlock = (title, key, unit = '') => {
    const block = document.createElement('section');
    const heading = document.createElement('div');
    heading.className = 'si-selbar-coordinate-heading';
    const label = document.createElement('strong');
    label.textContent = `${title}${unit ? ` (${unit})` : ''}`;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn-mini si-selbar-copy';
    copy.textContent = 'Copy';
    const text = coordinateText(rows, key);
    copy.onclick = () => copyText(text, copy);
    heading.append(label, copy);
    const output = document.createElement('textarea');
    output.readOnly = true;
    output.rows = Math.min(8, Math.max(2, rows.length + 1));
    output.value = text;
    output.setAttribute('aria-label', `${title} coordinates of selected atoms`);
    block.append(heading, output);
    viewer.appendChild(block);
  };
  addBlock('Fractional', 'fractional');
  addBlock('Cartesian', 'cartesian', 'Å');
  return viewer;
}

// ---- bulk visual edits (fan one change out over every selected atom) --------
// Each mirrors IndividualAtomRow.js's own apply path: the linked branch matches
// its non-perImage (source-atom) path, the unlinked branch its perImage
// (one on-screen copy) path.

function applyBulkColor(selected, hex) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;

  if (atomLinked()) {
    const speciesTargets = [];
    selectedSourceIndices(selected).forEach((idx) => {
      const atom = structure.atoms[idx];
      if (!atom) return;
      // A disordered site's wedges read species[i].color, never atom.userColor —
      // recolour every species so a bulk edit actually paints the sphere, the
      // same split the per-row species swatches make.
      if (atom.isDisordered?.()) {
        atom.species.forEach((_, speciesIndex) => speciesTargets.push({ atomIndex: idx, speciesIndex }));
      }
      atom.userColor = hex;
      setAtomColor(atom, hex);
      clearAtomImageStylesForAtom(structure, idx, 'color'); // newest edit wins over per-copy colors
      structure.atomImages[idx]?.forEach((imgIndex) => {
        syncBondHalvesToImageColor(structure, imgIndex, hex);
        updateSingleAtomColor(idx, imgIndex, structure.elements[idx], hex, hex);
      });
    });
    if (speciesTargets.length) setSpeciesColorBulk(speciesTargets, hex); // broadcasts crysviz:colors-changed
  } else {
    // Only the selected on-screen copies — persist per-image and paint those
    // instances, never the shared source atom or its other images.
    selected.forEach((atom) => {
      setAtomImageStyle(structure, atom.instanceId, { color: hex });
      updateSingleAtomImageColor(atom.instanceId, hex);
      syncBondHalvesToImageColor(structure, atom.instanceId, hex);
    });
  }

  if (groups.atomsMesh?.instanceColor) groups.atomsMesh.instanceColor.needsUpdate = true;
  if (groups.bondsMesh?.instanceColor) groups.bondsMesh.instanceColor.needsUpdate = true;
  updatePolyhedraColors();
  if (mode.measureMode === 'hide' || mode.measureMode === 'restore') refreshGhostAtoms();
  document.dispatchEvent(new CustomEvent('crysviz:colors-changed'));
}

function applyBulkOpacity(selected, value) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  if (atomLinked()) {
    selectedSourceIndices(selected).forEach((idx) => {
      const atom = structure.atoms[idx];
      if (!atom) return;
      atom.setOpacity(value);
      clearAtomImageStylesForAtom(structure, idx, 'alpha');
      structure.atomImages[idx]?.forEach((imgIndex) => updateSingleAtomOpacity(imgIndex, value));
    });
  } else {
    selected.forEach((atom) => {
      setAtomImageStyle(structure, atom.instanceId, { alpha: value });
      updateSingleAtomOpacity(atom.instanceId, value);
    });
  }
  document.dispatchEvent(new CustomEvent(ATOM_STYLE_CHANGED)); // sync open atom rows
}

function applyBulkRadiusScale(selected, value) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  if (atomLinked()) {
    selectedSourceIndices(selected).forEach((idx) => {
      const atom = structure.atoms[idx];
      if (!atom) return;
      atom.setRadiusScale(value);
      clearAtomImageStylesForAtom(structure, idx, 'radiusScale');
      structure.atomImages[idx]?.forEach((imgIndex) => updateSingleAtomDiameter(imgIndex, structure.elements[idx], value));
    });
  } else {
    selected.forEach((atom) => {
      setAtomImageStyle(structure, atom.instanceId, { radiusScale: value });
      updateSingleAtomDiameter(atom.instanceId, structure.elements[atom.sourceIndex], value);
    });
  }
  if (groups.atomsMesh) groups.atomsMesh.instanceMatrix.needsUpdate = true;
  updateMeasurementMarkers();
  scheduleBondRebuild(); // bond visible lengths bake in the atom radii
  document.dispatchEvent(new CustomEvent(ATOM_STYLE_CHANGED)); // sync open atom rows
}

// Reset color + alpha + size of every selected atom to element defaults — the
// bulk counterpart of a row's own Reset, scoped to the three things this bar
// controls (positions, spins, immunity are never touched).
function resetBulkStyle(selected) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;

  if (atomLinked()) {
    const speciesTargets = [];
    selectedSourceIndices(selected).forEach((idx) => {
      const atom = structure.atoms[idx];
      if (!atom) return;
      clearAtomImageStylesForAtom(structure, idx); // all per-copy overrides
      if (atom.userColor !== undefined) delete atom.userColor;
      if (atom.forceColor !== undefined) delete atom.forceColor;
      atom.species?.forEach((s) => { s.color = null; });
      atom.color = structure.getDefaultElementColor(structure.elements[idx]);
      atom.resetToElementOpacity?.();
      atom.resetRadiusScale?.();
      atom.species?.forEach((_, speciesIndex) => speciesTargets.push({ atomIndex: idx, speciesIndex }));
      structure.atomImages[idx]?.forEach((imgIndex) => {
        syncBondHalvesToImageColor(structure, imgIndex, safeColor(atom.getColor()));
        updateSingleAtomColor(idx, imgIndex, structure.elements[idx]);
        updateSingleAtomOpacity(imgIndex, atom.getOpacity?.() ?? 1);
        updateSingleAtomDiameter(imgIndex, structure.elements[idx], atom.getRadiusScale?.() ?? 1);
      });
    });
    if (speciesTargets.length) setSpeciesColorBulk(speciesTargets, null);
  } else {
    // Drop only the selected copies' per-image overrides and repaint them from
    // the (unchanged) source atom's model values.
    selected.forEach((atom) => {
      const src = structure.atoms[atom.sourceIndex];
      const element = structure.elements[atom.sourceIndex];
      clearAtomImageStyle(structure, atom.instanceId);
      updateSingleAtomColor(atom.sourceIndex, atom.instanceId, element);
      updateSingleAtomOpacity(atom.instanceId, src?.getOpacity?.() ?? 1);
      updateSingleAtomDiameter(atom.instanceId, element, src?.getRadiusScale?.() ?? 1);
      syncBondHalvesToImageColor(structure, atom.instanceId, safeColor(src?.getColor()));
    });
  }

  if (groups.atomsMesh) {
    if (groups.atomsMesh.instanceColor) groups.atomsMesh.instanceColor.needsUpdate = true;
    groups.atomsMesh.instanceMatrix.needsUpdate = true;
  }
  if (groups.bondsMesh?.instanceColor) groups.bondsMesh.instanceColor.needsUpdate = true;
  updatePolyhedraColors();
  updateMeasurementMarkers();
  scheduleBondRebuild();
  if (mode.measureMode === 'hide' || mode.measureMode === 'restore') refreshGhostAtoms();
  document.dispatchEvent(new CustomEvent('crysviz:colors-changed'));
  document.dispatchEvent(new CustomEvent(ATOM_STYLE_CHANGED)); // reset also touched alpha/size
}

// ---- bar DOM ---------------------------------------------------------------

function buildLabeledSlider(labelText, min, max, step, value, onInput) {
  const row = document.createElement('div');
  row.className = 'si-row';
  const label = document.createElement('span');
  label.textContent = labelText;
  label.className = 'si-row-label';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  const box = document.createElement('input');
  box.type = 'number';
  box.min = String(min);
  box.max = String(max);
  box.step = String(step);
  box.value = Number(value).toFixed(2);
  const push = (raw) => {
    const v = onInput(raw);
    slider.value = String(v);
    box.value = v.toFixed(2);
  };
  slider.oninput = (e) => push(/** @type {any} */ (e.target).value);
  box.oninput = (e) => push(/** @type {any} */ (e.target).value);
  row.appendChild(label);
  row.appendChild(slider);
  row.appendChild(box);
  return row;
}

// Rebuild the bar's contents from the current selection. Empty selection -> the
// container collapses (display:none) so it takes no room when unused.
function refreshSelectionActionBar() {
  const container = document.getElementById(BAR_ID);
  if (!container) return;

  const selected = getSelectedAtoms();
  container.innerHTML = '';
  if (!selected.length) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';

  const structure = fileBrowser.selectedStructure;
  const first = selected[0];
  const firstAtom = structure?.atoms?.[first?.sourceIndex];
  // Unlinked: seed the controls from the first selected COPY's own overrides so
  // the bar reflects what it is about to edit. Linked: the source atom's values.
  const firstImgStyle = atomLinked() ? null : getAtomImageStyle(structure, first?.instanceId);
  const currentAlpha = clampOpacity(firstImgStyle?.alpha ?? firstAtom?.getOpacity?.() ?? firstAtom?.opacity ?? 1);
  const currentSize = clampRadiusScale(firstImgStyle?.radiusScale ?? firstAtom?.getRadiusScale?.() ?? 1);
  const currentHex = atomLinked()
    ? safeColor(getAtomColor(first?.sourceIndex))
    : safeColor(getAtomImageColor(structure, first?.instanceId));

  // Header: summary + Clear
  const header = document.createElement('div');
  header.className = 'si-selbar-header';
  const summary = document.createElement('span');
  summary.className = 'si-selbar-summary';
  summary.textContent = selectionSummary(selected);
  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn-mini si-selbar-clear';
  clearBtn.textContent = 'Clear';
  clearBtn.title = 'Deselect all';
  clearBtn.onclick = () => clearSelectedAtoms({ reason: 'selection-bar-clear' });
  const coordinatesBtn = document.createElement('button');
  coordinatesBtn.className = 'btn-mini si-selbar-coordinates-toggle';
  coordinatesBtn.textContent = 'Coordinates';
  coordinatesBtn.setAttribute('aria-expanded', String(coordinatesExpanded));
  coordinatesBtn.onclick = () => {
    coordinatesExpanded = !coordinatesExpanded;
    refreshSelectionActionBar();
  };
  const headerActions = document.createElement('div');
  headerActions.className = 'si-selbar-header-actions';
  headerActions.append(coordinatesBtn, clearBtn);
  header.appendChild(summary);
  header.appendChild(headerActions);
  container.appendChild(header);

  if (coordinatesExpanded) container.appendChild(buildCoordinateViewer(selected));

  // Color row: a round color dot (bulk color picker) + Reset. The dot uses the
  // same pie-dot language as the atom/composition rows — one solid dot for a
  // uniform selection, wedges when the selection mixes colors.
  const colorRow = document.createElement('div');
  colorRow.className = 'si-selbar-color-row';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = 'Color';
  colorLabel.className = 'si-row-label';
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'si-selbar-swatch';
  swatch.title = 'Apply a color to every selected atom';
  swatch.dataset.hex = currentHex;
  const dot = createPieDot(selectionColors(selected), 22);
  dot.className = 'si-selbar-dot';
  dot.style.border = 'none'; // createPieDot sets an inline border; the button already draws one
  swatch.appendChild(dot);
  const refreshDot = () => updatePieDot(dot, selectionColors(selected));

  // The selection glow overwrites each atom's real color, so hide it while the
  // picker is open (live changes stay visible) and bring it back on close —
  // the same suppress/restore the per-row color editor does.
  let highlightSuppressed = false;
  swatch.onclick = () => {
    if (!highlightSuppressed) { suppressSelectionHighlightFor3D(); highlightSuppressed = true; }
    openSwatchColorPicker(swatch, swatch.dataset.hex, (hex) => {
      applyBulkColor(selected, hex);
      swatch.dataset.hex = hex;
      refreshDot();
    }, {
      onReset: () => {
        resetBulkStyle(selected);
        swatch.dataset.hex = selectionColors(selected)[0] ?? currentHex;
        refreshDot();
      },
      onClose: () => {
        if (highlightSuppressed) { restoreSelectionHighlight(); highlightSuppressed = false; }
      },
    });
  };

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn-mini si-selbar-reset';
  resetBtn.textContent = 'Reset';
  resetBtn.title = 'Reset color, alpha and size of every selected atom to element defaults';
  resetBtn.onclick = () => {
    resetBulkStyle(selected);
    // resetBulkStyle overwrites the instanceColor the glow was using — re-apply
    // it so the selection stays visible after a reset.
    restoreSelectionHighlight();
    refreshSelectionActionBar();
  };

  colorRow.appendChild(colorLabel);
  colorRow.appendChild(swatch);
  colorRow.appendChild(resetBtn);
  container.appendChild(colorRow);

  // Alpha + Size, applied live to the whole selection.
  container.appendChild(buildLabeledSlider('Alpha', 0.05, 1, 0.01, currentAlpha, (raw) => {
    const v = clampOpacity(raw);
    applyBulkOpacity(selected, v);
    return v;
  }));
  container.appendChild(buildLabeledSlider('Size', 0.2, 3, 0.05, currentSize, (raw) => {
    const v = clampRadiusScale(raw);
    applyBulkRadiusScale(selected, v);
    return v;
  }));
}

let subscribed = false;
let prevSelectionCount = 0;

// On every selection change: when a 3D pick/marquee grows the selection into a
// MULTI-atom one (1 -> 2+), fold the per-atom lists and reveal the panel so the
// bulk bar (the "top section") is what the user sees — the per-atom rows aren't
// the right tool for a group edit. A single selection stays quiet (no panel
// pop), and additions made by clicking panel rows are left alone so the list
// the user is working in doesn't collapse under them.
function onSelectionChanged(payload) {
  const count = getSelectedAtoms().length;
  const reason = payload?.event?.reason;
  const from3D = reason === 'pick' || reason === 'marquee';
  if (from3D && count >= 2 && prevSelectionCount < 2) {
    collapseAllAtomExpansions();
    setStructurePanelOpen(true);
    document.getElementById(BAR_ID)?.scrollIntoView({ block: 'start' });
  }
  prevSelectionCount = count;
  refreshSelectionActionBar();
}

/**
 * Create (or reuse) the selection bar container inside `parent` and populate
 * it for the current selection. Called by renderComposition on every Structure
 * panel rebuild; the selection subscription is wired once, lazily, here (not at
 * module load) to keep import ordering simple.
 */
export function renderSelectionActionBarInto(parent) {
  if (!parent) return;
  let container = document.getElementById(BAR_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = BAR_ID;
    container.className = 'si-selection-bar';
  }
  parent.appendChild(container); // move into the freshly-rebuilt panel

  if (!subscribed) {
    subscribeToAtomSelection(onSelectionChanged);
    subscribed = true;
  }
  refreshSelectionActionBar();
}
