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
import { getAtomColor, setAtomColor, colorHexToCss, createPieDot, updatePieDot, saveAtomColors, scheduleAtomColorSave } from '../../utils/ColorModule.js';
import { saveAtomRadiusScales, scheduleAtomRadiusScaleSave } from '../SizePrefs.js';
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
  getSelectionView, setSelectionView, getSelectionViewSets, repaintSelectionView,
  getDirectSelection, clearAllHighlights, SELECTION_VIEW_CHANGED,
} from '../SelectAndHighlightModule.js';
import {
  updateSingleBondColor, updateSingleBondOpacity, applyBondRadius, bondKey, notifyColorsChanged,
} from '../../render/index.js';
import { scheduleBondStyleSave } from '../SizePrefs.js';
import {
  listSelectionGroups, saveSelectionGroup, restoreSelectionGroup, renameSelectionGroup,
  deleteSelectionGroup, updateSelectionGroup, nextSelectionGroupName, SELECTION_GROUPS_CHANGED,
} from './SelectionGroups.js';
import { isPanelActive } from '../panels/PanelManager.js';
import { collapseAllAtomExpansions } from '../WindowAndSceneControls.js';
import { clampOpacity, clampRadiusScale } from './components/utils.js';

const BAR_ID = 'selectionActionBar';
let coordinatesExpanded = false;
// Saved selections row: the chosen group (index into listSelectionGroups())
// and the inline name editor ('save' | 'rename' | null) survive refreshes.
let chosenGroup = -1;
let nameEditor = null;

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

/** What the box shows: tab-separated like the Copy text (so a selection of it
 *  still pastes into a spreadsheet as columns), at a precision that lets x, y
 *  and z fit the narrow window side by side (fractional 5 decimals, Cartesian
 *  4 — 0.1 mÅ); the box's tab stops line the columns up
 *  (structureInfoPanel.css). Copy still takes coordinateText's 8 decimals. */
function coordinateDisplayText(rows, key, digits) {
  const lines = rows.map((row) => {
    const values = row[key];
    return `${row.label}\t${values?.map((value) => Number(value).toFixed(digits)).join('\t') ?? 'unavailable'}`;
  });
  return ['Atom\tx\ty\tz', ...lines].join('\n');
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
  const addBlock = (title, key, unit = '', digits = 5) => {
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
    output.value = coordinateDisplayText(rows, key, digits);
    output.title = 'Copy puts every coordinate on the clipboard with 8 decimals, tab-separated';
    output.setAttribute('aria-label', `${title} coordinates of selected atoms`);
    block.append(heading, output);
    viewer.appendChild(block);
  };
  addBlock('Fractional', 'fractional', '', 5);
  addBlock('Cartesian', 'cartesian', 'Å', 4);
  return viewer;
}

// ---- bulk visual edits (fan one change out over every selected atom) --------
// Each mirrors IndividualAtomRow.js's own apply path: the linked branch matches
// its non-perImage (source-atom) path, the unlinked branch its perImage
// (one on-screen copy) path.

/**
 * Recolour source atoms (structure.atoms indices) and every on-screen copy of
 * them, their bond halves and disordered-site wedges, and keep the colours for
 * the next session. The selection bar's linked colour edit and the host's
 * apply command share it.
 * @param {number[]} indices
 * @param {string} hex '#rrggbb'
 */
export function colorSourceAtoms(indices, hex) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  const speciesTargets = [];
  indices.forEach((idx) => {
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
  scheduleAtomColorSave(structure); // keep the overrides for the next session
  if (speciesTargets.length) setSpeciesColorBulk(speciesTargets, hex); // broadcasts crysviz:colors-changed
  repaintAfterColorEdit();
}

/** Push recoloured instances to the GPU and tell the colour-dependent views. */
function repaintAfterColorEdit() {
  if (groups.atomsMesh?.instanceColor) groups.atomsMesh.instanceColor.needsUpdate = true;
  if (groups.bondsMesh?.instanceColor) groups.bondsMesh.instanceColor.needsUpdate = true;
  updatePolyhedraColors();
  if (mode.measureMode === 'hide' || mode.measureMode === 'restore') refreshGhostAtoms();
  document.dispatchEvent(new CustomEvent('crysviz:colors-changed'));
}

function applyBulkColor(selected, hex) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;

  if (atomLinked()) {
    colorSourceAtoms(selectedSourceIndices(selected), hex);
  } else {
    // Only the selected on-screen copies — persist per-image and paint those
    // instances, never the shared source atom or its other images.
    selected.forEach((atom) => {
      setAtomImageStyle(structure, atom.instanceId, { color: hex });
      updateSingleAtomImageColor(atom.instanceId, hex);
      syncBondHalvesToImageColor(structure, atom.instanceId, hex);
    });
    repaintAfterColorEdit();
  }
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
    scheduleAtomRadiusScaleSave(structure); // per-structure pref (ui/SizePrefs.js)
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
/**
 * Reset these source atoms to their element defaults in the model and on
 * every drawn copy: the colour, and unless colorOnly also the opacity and
 * size. The bar's Reset and the host's apply reset_color.
 */
function resetSourceAtoms(structure, indices, { colorOnly = false } = {}) {
  const speciesTargets = [];
  indices.forEach((idx) => {
    const atom = structure.atoms[idx];
    if (!atom) return;
    clearAtomImageStylesForAtom(structure, idx, colorOnly ? 'color' : undefined); // per-copy overrides
    if (atom.userColor !== undefined) delete atom.userColor;
    if (atom.forceColor !== undefined) delete atom.forceColor;
    atom.species?.forEach((s) => { s.color = null; });
    atom.color = structure.getDefaultElementColor(structure.elements[idx]);
    if (!colorOnly) {
      atom.resetToElementOpacity?.();
      atom.resetRadiusScale?.();
    }
    atom.species?.forEach((_, speciesIndex) => speciesTargets.push({ atomIndex: idx, speciesIndex }));
    structure.atomImages[idx]?.forEach((imgIndex) => {
      syncBondHalvesToImageColor(structure, imgIndex, safeColor(atom.getColor()));
      updateSingleAtomColor(idx, imgIndex, structure.elements[idx]);
      if (!colorOnly) {
        updateSingleAtomOpacity(imgIndex, atom.getOpacity?.() ?? 1);
        updateSingleAtomDiameter(imgIndex, structure.elements[idx], atom.getRadiusScale?.() ?? 1);
      }
    });
  });
  saveAtomColors(structure); // drops the cleared overrides from storage too
  if (!colorOnly) saveAtomRadiusScales(structure);
  if (speciesTargets.length) setSpeciesColorBulk(speciesTargets, null);
}

/** Back to the element colour for these source atoms (the host's apply reset_color). */
export function resetSourceAtomColors(indices) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  resetSourceAtoms(structure, indices, { colorOnly: true });
  repaintAfterColorEdit();
}

// bulk counterpart of a row's own Reset, scoped to the three things this bar
// controls (positions, spins, immunity are never touched).
function resetBulkStyle(selected) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;

  if (atomLinked()) {
    resetSourceAtoms(structure, selectedSourceIndices(selected));
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
// ---- the Bonds / Polyhedra views: bulk edits of the derived sets ----------
// (SelectAndHighlightModule setSelectionView: the bonds between the selected
// atoms, the polyhedra centred on them). Each edit writes the per-bond /
// per-polyhedron persistent style records the row editors use, so it survives
// rebuilds and travels with the structure.

function viewBonds() {
  const structure = fileBrowser.selectedStructure;
  return getSelectionViewSets().bonds.map((i) => structure?.bonds?.[i]).filter(Boolean);
}

function viewPolyhedra() {
  return getSelectionViewSets().polyhedra;
}

function bondStyleEntry(structure, b) {
  return structure.bondUserStyles[bondKey(b.indices)] ??= { elements: [...b.elements] };
}

function applyBulkBondColor(bonds, hex) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  for (const b of bonds) {
    bondStyleEntry(structure, b).color = hex;
    b.color = [hex, hex];
    b.userColor = [hex, hex];
    if (b.instanceIds && groups.bondsMesh) {
      updateSingleBondColor(b.instanceIds[0], hex, true);
      updateSingleBondColor(b.instanceIds[1], hex, true);
    }
  }
  if (groups.bondsMesh) groups.bondsMesh.instanceColor.needsUpdate = true;
  scheduleBondStyleSave(structure);
  notifyColorsChanged();
}

function applyBulkBondOpacity(bonds, value) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  for (const b of bonds) {
    bondStyleEntry(structure, b).alpha = value;
    b.alpha = value;
    if (b.instanceIds) {
      updateSingleBondOpacity(b.instanceIds[0], value);
      updateSingleBondOpacity(b.instanceIds[1], value);
    }
  }
  scheduleBondStyleSave(structure);
}

function applyBulkBondRadiusScale(bonds, value) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  for (const b of bonds) {
    bondStyleEntry(structure, b).radiusScale = value;
    applyBondRadius(b, general.bondRadius * value);
  }
  scheduleBondStyleSave(structure);
}

function resetBulkBondStyle(bonds) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  for (const b of bonds) delete structure.bondUserStyles[bondKey(b.indices)];
  scheduleBondStyleSave(structure);
  scheduleBondRebuild(); // rebuilt from the pair defaults
}

function polyKeys(meshes) {
  return meshes.map((m) => m.userData?.key).filter(Boolean);
}

function applyBulkPolyStyle(meshes, patch) {
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  structure.polyhedraUserStyles ??= {};
  for (const k of polyKeys(meshes)) Object.assign(structure.polyhedraUserStyles[k] ??= {}, patch);
  updatePolyhedraColors();
}

function resetBulkPolyStyle(meshes) {
  const structure = fileBrowser.selectedStructure;
  if (!structure?.polyhedraUserStyles) return;
  for (const k of polyKeys(meshes)) {
    const st = structure.polyhedraUserStyles[k];
    if (!st) continue;
    delete st.color; delete st.alpha;
    if (!Object.keys(st).length) delete structure.polyhedraUserStyles[k];
  }
  updatePolyhedraColors();
}

/** Colour swatch + Reset row shared by the three views: the swatch opens the
 *  bulk colour picker with the 3D glow off (so live changes show), Reset
 *  clears the bulk style. */
function buildColorRow({ colors, hex, onPick, onReset, swatchTitle, resetTitle }) {
  const colorRow = document.createElement('div');
  colorRow.className = 'si-selbar-color-row';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = 'Color';
  colorLabel.className = 'si-row-label';
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'si-selbar-swatch';
  swatch.title = swatchTitle;
  swatch.dataset.hex = hex;
  const dot = createPieDot(colors(), 22);
  dot.classList.add('si-selbar-dot'); // .cv-pie-dot.si-selbar-dot drops the border: the button draws one
  swatch.appendChild(dot);
  const refreshDot = () => updatePieDot(dot, colors());
  let highlightSuppressed = false;
  swatch.onclick = () => {
    if (!highlightSuppressed) { suppressSelectionHighlightFor3D(); highlightSuppressed = true; }
    openSwatchColorPicker(swatch, swatch.dataset.hex, (picked) => {
      onPick(picked);
      swatch.dataset.hex = picked;
      refreshDot();
    }, {
      onReset: () => {
        onReset();
        swatch.dataset.hex = colors()[0] ?? hex;
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
  resetBtn.title = resetTitle;
  resetBtn.onclick = () => {
    onReset();
    restoreSelectionHighlight();
    refreshSelectionActionBar();
  };
  colorRow.appendChild(colorLabel);
  colorRow.appendChild(swatch);
  colorRow.appendChild(resetBtn);
  return colorRow;
}

function buildViewHeader(container, text) {
  const header = document.createElement('div');
  header.className = 'si-selbar-header';
  const summary = document.createElement('span');
  summary.className = 'si-selbar-summary';
  summary.textContent = text;
  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn-mini si-selbar-clear';
  clearBtn.textContent = 'Clear';
  clearBtn.title = 'Deselect all';
  clearBtn.onclick = () => clearAllHighlights({ reason: 'selection-bar-clear' });
  const actions = document.createElement('div');
  actions.className = 'si-selbar-header-actions';
  if (!listSelectionGroups().length && !nameEditor) actions.appendChild(buildSaveButton());
  actions.appendChild(clearBtn);
  header.appendChild(summary);
  header.appendChild(actions);
  container.appendChild(header);
}

function buildBondsView(container) {
  const structure = fileBrowser.selectedStructure;
  const bonds = viewBonds();
  const n = bonds.length;
  const picked = getDirectSelection().kind === 'bonds';
  buildViewHeader(container, picked ? `${n} bond${n === 1 ? '' : 's'} selected`
    : (n ? `${n} bond${n === 1 ? '' : 's'} between the selected atoms` : 'No bonds between the selected atoms'));
  if (!n) return;
  const colors = () => {
    const seen = [];
    for (const b of bonds) {
      const c = safeColor(structure?.bondUserStyles?.[bondKey(b.indices)]?.color ?? b.color?.[0] ?? b.defaultColor?.[0]);
      if (!seen.includes(c)) seen.push(c);
    }
    return seen;
  };
  const firstStyle = structure?.bondUserStyles?.[bondKey(bonds[0].indices)];
  container.appendChild(buildColorRow({
    colors, hex: colors()[0] ?? '#808080',
    onPick: (hex) => applyBulkBondColor(bonds, hex),
    onReset: () => resetBulkBondStyle(bonds),
    swatchTitle: 'Apply a color to every bond between the selected atoms',
    resetTitle: 'Reset color, alpha and size of these bonds to their pair defaults',
  }));
  container.appendChild(buildLabeledSlider('Alpha', 0, 1, 0.01, clampOpacity(firstStyle?.alpha ?? bonds[0].alpha ?? 1), (raw) => {
    const v = clampOpacity(raw);
    applyBulkBondOpacity(bonds, v);
    return v;
  }));
  container.appendChild(buildLabeledSlider('Size', 0.2, 3, 0.05, clampRadiusScale(firstStyle?.radiusScale ?? 1), (raw) => {
    const v = clampRadiusScale(raw);
    applyBulkBondRadiusScale(bonds, v);
    return v;
  }));
}

function buildPolyhedraView(container) {
  const structure = fileBrowser.selectedStructure;
  const meshes = viewPolyhedra();
  const n = meshes.length;
  const picked = getDirectSelection().kind === 'polyhedra';
  buildViewHeader(container, picked ? `${n} polyhedr${n === 1 ? 'on' : 'a'} selected`
    : (n ? `${n} polyhedr${n === 1 ? 'on' : 'a'} of the selected atoms` : 'No polyhedra of the selected atoms'));
  if (!n) return;
  const colors = () => {
    const seen = [];
    for (const m of meshes) {
      const c = safeColor(structure?.polyhedraUserStyles?.[m.userData?.key]?.color ?? `#${m.material.color.getHexString()}`);
      if (!seen.includes(c)) seen.push(c);
    }
    return seen;
  };
  const firstAlpha = structure?.polyhedraUserStyles?.[meshes[0].userData?.key]?.alpha ?? meshes[0].userData?.baseOpacity ?? meshes[0].material.opacity;
  container.appendChild(buildColorRow({
    colors, hex: colors()[0] ?? '#808080',
    onPick: (hex) => applyBulkPolyStyle(meshes, { color: hex }),
    onReset: () => resetBulkPolyStyle(meshes),
    swatchTitle: 'Apply a face color to every polyhedron of the selected atoms',
    resetTitle: 'Reset color and alpha of these polyhedra to their category style',
  }));
  container.appendChild(buildLabeledSlider('Alpha', 0, 1, 0.01, clampOpacity(firstAlpha), (raw) => {
    const v = clampOpacity(raw);
    applyBulkPolyStyle(meshes, { alpha: v });
    return v;
  }));
}

/** Atoms | Bonds | Polyhedra — which set of the selection glows and is edited. */
function buildViewTabs() {
  const tabs = document.createElement('div');
  tabs.className = 'segmented-control si-selbar-tabs';
  tabs.id = 'selectionViewTabs';
  const sets = getSelectionViewSets();
  const active = getSelectionView();
  const direct = getDirectSelection().kind;
  const defs = [
    ['atoms', `Atoms (${direct ? sets.atoms.length : getSelectedAtoms().length})`,
      direct ? 'Select the atoms of the picked bonds / polyhedra instead' : 'The selected atoms'],
    ['bonds', `Bonds (${sets.bonds.length})`,
      direct === 'bonds' ? 'The picked bonds (Shift+double-click adds one, Ctrl/⌘ toggles)'
        : 'The bonds between the selected atoms: they glow and the controls edit them'],
    ['polyhedra', `Polyhedra (${sets.polyhedra.length})`,
      direct === 'polyhedra' ? 'The picked polyhedra (Shift+double-click adds one, Ctrl/⌘ toggles)'
        : 'The polyhedra centred on the selected atoms (and cages whose corners are all selected)'],
  ];
  for (const [tab, label, title] of defs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    btn.dataset.view = tab;
    if (tab === active) btn.classList.add('active');
    btn.onclick = () => setSelectionView(/** @type {any} */ (tab));
    tabs.appendChild(btn);
  }
  return tabs;
}

/** Saved selections (SelectionGroups.js): a dropdown of the structure's
 *  groups — choosing one selects it again — with Save / Add / Rename /
 *  Delete and an inline name editor. Shown even with nothing selected, so a
 *  group can be brought back. */
/** The header's Save button (the groups row's one when the row is not shown:
 *  no saved selection yet keeps the bar as short as before). */
function buildSaveButton() {
  const b = document.createElement('button');
  b.className = 'btn-mini si-selbar-save';
  b.id = 'selectionGroupSave';
  b.textContent = 'Save';
  b.title = 'Save the current selection (its atoms, with the bonds or polyhedra of the active tab) under a name';
  b.onclick = () => { nameEditor = 'save'; refreshSelectionActionBar(); };
  return b;
}

function buildGroupsRow(hasSelection) {
  const list = listSelectionGroups();
  if (chosenGroup >= list.length) chosenGroup = -1;
  if (!list.length && !nameEditor) return null; // Save sits in the header until a group exists
  const block = document.createElement('div');
  block.className = 'si-selbar-groups-block';
  const title = document.createElement('div');
  title.className = 'si-selbar-groups-title';
  title.textContent = 'Saved selections';
  block.appendChild(title);
  const row = document.createElement('div');
  row.className = 'si-selbar-groups';
  row.id = 'selectionGroupsRow';
  block.appendChild(row);

  if (nameEditor) {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'selectionGroupName';
    input.maxLength = 60;
    input.value = nameEditor === 'rename' ? (list[chosenGroup]?.name ?? '') : nextSelectionGroupName();
    input.placeholder = 'Name';
    const commit = () => {
      if (nameEditor === 'rename') renameSelectionGroup(chosenGroup, input.value);
      else { saveSelectionGroup(input.value); chosenGroup = listSelectionGroups().length - 1; }
      nameEditor = null;
      refreshSelectionActionBar();
    };
    const cancel = () => { nameEditor = null; refreshSelectionActionBar(); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    const ok = document.createElement('button');
    ok.className = 'btn-mini';
    ok.id = 'selectionGroupNameOk';
    ok.textContent = 'OK';
    ok.onclick = commit;
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-mini';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = cancel;
    row.append(input, ok, cancelBtn);
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return block;
  }

  const select = document.createElement('select');
  select.id = 'selectionGroupsSelect';
  select.title = 'Saved selections of this structure: choose one to select it again';
  const placeholder = document.createElement('option');
  placeholder.value = '-1';
  placeholder.textContent = list.length ? 'Saved selections…' : 'No saved selections';
  select.appendChild(placeholder);
  list.forEach((g, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    const n = g.atoms?.length ?? 0;
    opt.textContent = `${g.name} (${n} atom${n === 1 ? '' : 's'})`;
    select.appendChild(opt);
  });
  select.value = String(chosenGroup);
  select.disabled = !list.length;
  select.onchange = () => {
    chosenGroup = parseInt(select.value, 10);
    if (chosenGroup >= 0) restoreSelectionGroup(chosenGroup);
    refreshSelectionActionBar();
  };
  row.appendChild(select);

  const mk = (id, text, title, onclick, enabled = true) => {
    const b = document.createElement('button');
    b.className = 'btn-mini';
    b.id = id;
    b.textContent = text;
    b.title = title;
    b.disabled = !enabled;
    b.onclick = onclick;
    row.appendChild(b);
    return b;
  };
  // Show selects the chosen group again (the dropdown only fires on a new
  // choice: after Clear, the same entry needs a button).
  mk('selectionGroupShow', 'Show', 'Select the chosen saved selection',
    () => { restoreSelectionGroup(chosenGroup); }, chosenGroup >= 0);
  const save = buildSaveButton();
  save.disabled = !hasSelection;
  row.appendChild(save);
  mk('selectionGroupUpdate', 'Update', 'Replace the chosen saved selection with the current selection',
    () => { updateSelectionGroup(chosenGroup); refreshSelectionActionBar(); }, hasSelection && chosenGroup >= 0);
  mk('selectionGroupAdd', 'Add', 'Add the chosen saved selection\'s atoms to the current selection',
    () => { restoreSelectionGroup(chosenGroup, { add: true }); }, chosenGroup >= 0);
  mk('selectionGroupRename', 'Rename', 'Rename the chosen saved selection',
    () => { nameEditor = 'rename'; refreshSelectionActionBar(); }, chosenGroup >= 0);
  mk('selectionGroupDelete', 'Delete', 'Delete the chosen saved selection',
    () => { deleteSelectionGroup(chosenGroup); chosenGroup = -1; refreshSelectionActionBar(); }, chosenGroup >= 0);
  return block;
}

function refreshSelectionActionBar() {
  const container = document.getElementById(BAR_ID);
  if (!container) return;

  const selected = getSelectedAtoms();
  const direct = getDirectSelection().kind; // bonds / polyhedra picked in the 3D view
  container.innerHTML = '';
  if (!selected.length && !direct && !listSelectionGroups().length) {
    container.hidden = true;
    nameEditor = null;
    return;
  }
  container.hidden = false;
  if (!selected.length && !direct) {
    // Nothing selected: only the saved selections, to bring one back.
    const only = buildGroupsRow(false);
    if (only) container.appendChild(only);
    return;
  }

  container.appendChild(buildViewTabs());
  const view = getSelectionView();
  if (view === 'bonds') {
    buildBondsView(container);
    { const groupsRow = buildGroupsRow(true); if (groupsRow) container.appendChild(groupsRow); }
    return;
  }
  if (view === 'polyhedra') {
    buildPolyhedraView(container);
    { const groupsRow = buildGroupsRow(true); if (groupsRow) container.appendChild(groupsRow); }
    return;
  }

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
  // Opens the Selection Inspector: these atoms in their own 3D view with
  // bond lengths and angles. Loaded on demand — it imports the selection
  // module this bar is reached from, and nothing needs it until clicked.
  const inspectBtn = document.createElement('button');
  inspectBtn.className = 'btn-mini si-selbar-inspect';
  inspectBtn.id = 'selectionInspectBtn';
  inspectBtn.textContent = 'Inspect';
  inspectBtn.title = 'Selection Inspector: show the selected atoms in their own 3D view, with the bonds between them, every bond length and every bond angle. It follows the selection — Shift+double-click adds atoms, Ctrl/⌘+double-click removes them, Shift+drag selects a region.';
  inspectBtn.onclick = async () => {
    const { openSelectionInspector } = await import('../AnalysisPanels/SelectionInspector.js');
    openSelectionInspector();
  };
  const headerActions = document.createElement('div');
  headerActions.className = 'si-selbar-header-actions';
  headerActions.append(inspectBtn, coordinatesBtn);
  if (!listSelectionGroups().length && !nameEditor) headerActions.appendChild(buildSaveButton());
  headerActions.appendChild(clearBtn);
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
  dot.classList.add('si-selbar-dot'); // borderless: the button already draws one
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
  container.appendChild(buildLabeledSlider('Alpha', 0, 1, 0.01, currentAlpha, (raw) => {
    const v = clampOpacity(raw);
    applyBulkOpacity(selected, v);
    return v;
  }));
  container.appendChild(buildLabeledSlider('Size', 0.2, 3, 0.05, currentSize, (raw) => {
    const v = clampRadiusScale(raw);
    applyBulkRadiusScale(selected, v);
    return v;
  }));
  { const groupsRow = buildGroupsRow(true); if (groupsRow) container.appendChild(groupsRow); }
}

let subscribed = false;
let prevSelectionCount = 0;

// On every selection change: when a 3D pick/marquee grows the selection into a
// MULTI-atom one (1 -> 2+) while the Structure window's formula box is already
// showing, fold the per-atom lists so the bulk bar (the "top section") is what
// the user sees — the per-atom rows aren't the right tool for a group edit.
// It never OPENS the window: Ctrl/Shift-picking in the 3D view builds a
// selection there (for the Selection Inspector, the Planes panel, ...), and a
// window popping up on the second atom is in the way. A single selection
// stays quiet too, and additions made by clicking panel rows are left alone so
// the list the user is working in doesn't collapse under them.
function onSelectionChanged(payload) {
  const count = getSelectedAtoms().length;
  const reason = payload?.event?.reason;
  const from3D = reason === 'pick' || reason === 'marquee';
  const showing = isPanelActive('info')
    && !!document.getElementById('composition')?.classList.contains('open');
  if (from3D && showing && count >= 2 && prevSelectionCount < 2) {
    collapseAllAtomExpansions();
    document.getElementById(BAR_ID)?.scrollIntoView({ block: 'nearest' });
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
    document.addEventListener(SELECTION_VIEW_CHANGED, () => refreshSelectionActionBar());
    document.addEventListener(SELECTION_GROUPS_CHANGED, () => refreshSelectionActionBar());
    subscribed = true;
  }
  // The panel was rebuilt (a structure change or a bond/polyhedra rebuild):
  // the Bonds / Polyhedra view glows new instance ids and meshes.
  repaintSelectionView();
  refreshSelectionActionBar();
}
