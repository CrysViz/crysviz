// Polyhedra window ▸ Colour: colour the polyhedra by a per-polyhedron
// property (distortion, angle variance, elongation, volume, tilts), with a
// colour bar, recomputed on every MD / trajectory frame
// (render/PolyhedraFrameModule.js does the work; this is the UI).
//
// The bar follows the Colors window's Atoms-by-force bar (ColorPanel.js):
// docked under the controls, floatable over the scene, its layout kept in
// `general` across window rebuilds, listed for image export through
// ColorBarRegistry. The range is the render module's: fitted to the data
// when a property is chosen (and on Auto Range) — over the frames of a
// trajectory, a note under the bar says how many — then kept so frames stay
// comparable; typed limits on the bar replace it.
//
// Taking the Polyhedra window out of the sidebar (the feature store's
// remove, not a collapse or a structure switch's rebuild) switches the
// colouring off: Colour by goes back to Style, with the style colours.

import { general, savePolyhedraColorPrefs } from '../state/store.js';
import {
  updatePolyhedraColors, polyhedraTiltFrameInfo, polyhedraColorMapName, polyhedraColorRangeInfo,
} from '../render/index.js';
import { getPolyhedraProperty, isOrientationProperty } from '../model/polyhedraProperties.js';
import { createColorBar } from './ColorBarWidget.js';
import { registerColorBarSource } from './ColorBarRegistry.js';
import { makeSectionHeadline } from './panels/sectionHeadline.js';
import { onFeatureStoreChange } from './panels/featureStore.js';
import { createToggleRow } from './ToggleSwitch.js';

const FLOATING_ID = 'polyhedraColorBarFloating';

// Menu order. The wording is the registry's (label, and its description as
// the option's tooltip), the same names the colour bar and the Polyhedron
// Inspector show.
const COLOR_BY = [
  { value: 'style', text: 'Style', title: 'The category colours (per centre element and coordination)' },
  ...['bld', 'angleVariance', 'quadraticElongation', 'volume', 'tiltA', 'tiltB', 'tiltC', 'rotation'].map((id) => {
    const def = /** @type {NonNullable<ReturnType<typeof getPolyhedraProperty>>} */ (getPolyhedraProperty(id));
    return { value: id, text: def.label, title: def.description };
  }),
];
const COLOR_MAPS = [
  { value: 'auto', text: 'Automatic' },
  { value: 'viridis', text: 'Viridis' },
  { value: 'managua', text: 'Managua' },
  { value: 'spectralR', text: 'Spectral R' },
  { value: 'batlow', text: 'Batlow' },
  { value: 'hawaii', text: 'Hawaii' },
  { value: 'plasma', text: 'Plasma' },
  { value: 'heatmap', text: 'Heatmap' },
  { value: 'jet', text: 'Jet' },
];
const EDGE_MODES = [
  { value: 'grey', text: 'Grey', title: 'A neutral grey, darker than the grey of the polyhedra without a value' },
  { value: 'property', text: 'Property', title: "Each polyhedron's edges in its face colour" },
  { value: 'style', text: 'Style', title: 'The edge colours of the polyhedra styles' },
];
const TILT_FRAMES = [
  { value: 'auto', text: 'Automatic', title: 'Per polyhedron type, the mean orientation of its polyhedra (the untilted pseudo-cubic axes in any cell setting)' },
  { value: 'cell', text: 'Cell axes', title: "a, b made orthogonal to a (b'), and c' = a × b'" },
  { value: 'matrix', text: 'Matrix', title: 'Two axes typed in terms of a, b, c; the third is their cross product' },
];

let colorBar = null;
let barProperty = null;
/** @type {{ root: HTMLElement, select: HTMLSelectElement, mapRow: HTMLElement, greyRow: HTMLElement,
 *   edgesRow: HTMLElement, tiltRow: HTMLElement, matrix: HTMLElement, info: HTMLElement,
 *   barHost: HTMLElement, rangeNote: HTMLElement } | null} */
let ui = null;

registerColorBarSource('polyhedra', 'Polyhedra', () => colorBar);

function selectRow(id, label, options, value, onChange) {
  const row = document.createElement('div');
  row.className = 'control-row';
  const lab = document.createElement('label');
  lab.htmlFor = id;
  lab.textContent = label;
  const select = document.createElement('select');
  select.id = id;
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.text;
    if (opt.title) o.title = opt.title;
    select.appendChild(o);
  }
  select.value = value;
  // The chosen option's tooltip, also on the closed menu.
  const syncTitle = () => { select.title = options.find((o) => o.value === select.value)?.title ?? ''; };
  syncTitle();
  select.addEventListener('change', () => { syncTitle(); onChange(select.value); });
  row.append(lab, select);
  return row;
}

/** Legend for the bar: the property's name and unit. */
function legendFor(id) {
  const def = getPolyhedraProperty(id);
  const name = def?.label ?? id;
  return def?.unit ? `${name} (${def.unit})` : name;
}

function captureBarState() {
  if (!colorBar) return;
  const settings = colorBar.getSettings();
  general.polyColorBarOrientation = settings.orientation;
  general.polyColorBarFlipSide = settings.flipSide;
  general.colorBarSize = settings.size;
  general.polyColorLegendText = barProperty ? { id: barProperty, text: settings.legend } : null;
  general.polyColorBarFloating = colorBar.isFloating();
  if (general.polyColorBarFloating) general.polyColorBarFloatPos = colorBar.getAnchor();
}

function removeBar() {
  captureBarState();
  colorBar?.remove();
  colorBar = null;
  barProperty = null;
}

/** Recolour with the current settings (the render module refits a null
 *  range to the data). */
function recolor() {
  updatePolyhedraColors();
  syncInfo();
}

/** Make the bar match the mode: present for a property while polyhedra are
 *  shown, with that property's legend, map and range. */
function syncBar() {
  const id = general.polyhedraColor;
  const wanted = ui && id && id !== 'style' && !!getPolyhedraProperty(id) && general.showPolyhedra;
  if (!wanted) { removeBar(); return; }
  const cmap = polyhedraColorMapName(id);
  if (colorBar && barProperty === id && colorBar.getSettings().colormap === cmap) {
    syncRange();
    return;
  }
  removeBar();
  const saved = general.polyColorLegendText;
  const min = Number.isFinite(general.polyhedraColorMin) ? general.polyhedraColorMin : 0;
  const max = Number.isFinite(general.polyhedraColorMax) ? general.polyhedraColorMax : 1;
  colorBar = createColorBar(ui.barHost, cmap, min, max, {
    floatingId: FLOATING_ID,
    fallbackMin: min,
    fallbackMax: max,
    legend: saved?.id === id ? saved.text : legendFor(id),
    orientation: general.polyColorBarOrientation,
    flipSide: general.polyColorBarFlipSide,
    size: general.colorBarSize,
    isLocked: () => general.polyColorBarLocked,
    onLockChange: (locked) => { general.polyColorBarLocked = locked; },
    onLimitsCommit: (lo, hi) => {
      general.polyhedraColorMin = lo;
      general.polyhedraColorMax = hi;
      updatePolyhedraColors();
      syncRangeNote();
    },
    onAutoRange: () => {
      general.polyhedraColorMin = null;
      general.polyhedraColorMax = null;
      updatePolyhedraColors();
    },
  });
  barProperty = id;
  if (general.polyColorBarFloating && general.polyColorBarFloatPos) colorBar.floatAtAnchor(general.polyColorBarFloatPos);
}

function syncRange() {
  syncRangeNote();
  if (!colorBar) return;
  const { polyhedraColorMin: lo, polyhedraColorMax: hi } = general;
  if (Number.isFinite(lo) && Number.isFinite(hi)) colorBar.setRange(lo, hi);
}

/** Under the bar, on a trajectory: how many of its frames the fitted range
 *  read (or that it is being read). Not for typed limits. */
function syncRangeNote() {
  if (!ui) return;
  const id = general.polyhedraColor;
  const info = polyhedraColorRangeInfo();
  const fitted = info.pending
    || (info.min === general.polyhedraColorMin && info.max === general.polyhedraColorMax);
  const on = !!colorBar && id && id !== 'style' && info.of > 1 && fitted;
  ui.rangeNote.style.display = on ? '' : 'none';
  if (!on) return;
  ui.rangeNote.textContent = info.pending
    ? `Range of this frame; reading the trajectory (${info.of} frames)…`
    : info.frames >= info.of ? `Range over all ${info.of} frames`
      : info.frames > 1 ? `Range over ${info.frames} of ${info.of} frames, evenly spaced`
        : 'Range of this frame';
}

/** Pseudo-cubic axes of the automatic frame, e.g. "TiO6: 45° from a, b;
 *  along c". */
function describeAutoFrame() {
  const info = polyhedraTiltFrameInfo();
  if (!info.length) return 'Automatic: the mean orientation of each polyhedron type (no octahedra or tetrahedra to average yet).';
  const parts = info.map(({ label, axes }) => {
    const groups = new Map();
    for (const { axis, angle } of axes) {
      const deg = Math.round(angle);
      const key = deg < 1 ? 'along' : `${deg}° from`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(axis);
    }
    const text = [...groups].map(([k, list]) => `${k} ${list.join(', ')}`).join('; ');
    return info.length > 1 ? `${label}: ${text}` : text;
  });
  return `Pseudo-cubic axes ${parts.join(' · ')}`;
}

function syncInfo() {
  if (!ui) return;
  const id = general.polyhedraColor;
  const property = id && id !== 'style';
  // display, not [hidden]: .control-row sets display: grid, which wins
  // over the attribute.
  const show = (el, on) => { el.style.display = on ? '' : 'none'; };
  show(ui.mapRow, property);
  show(ui.greyRow, property);
  show(ui.edgesRow, property);
  const tilt = property && isOrientationProperty(id);
  show(ui.tiltRow, tilt);
  show(ui.matrix, tilt && general.polyhedraTiltFrame === 'matrix');
  syncMatrixNote();
  const auto = tilt && general.polyhedraTiltFrame === 'auto';
  show(ui.info, auto);
  if (auto) ui.info.textContent = describeAutoFrame();
  syncBar();
  syncRangeNote();
}

/** The two matrix rows used, as numbers (missing entries 0). */
function matrixRows() {
  const M = general.polyhedraTiltMatrix;
  return [0, 1].map((r) => [0, 1, 2].map((c) => Number(M?.[r]?.[c]) || 0));
}

/** Under the matrix: what the third axis is, or why the rows give no frame. */
function syncMatrixNote() {
  const note = ui?.matrix.querySelector('.cv-polyhedra-matrix-note');
  if (!note) return;
  const [u, v] = matrixRows();
  // Parallel (or zero) rows in a, b, c are parallel in Å too: no frame.
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const ok = Math.hypot(...cross) > 1e-9;
  note.textContent = ok
    ? 'Axis 2 is made orthogonal to axis 1, and axis 3 = axis 1 × axis 2: always right-handed. A left-handed set cannot be typed; to turn axis 3 round, swap rows 1 and 2 or negate one of them.'
    : 'Rows 1 and 2 are parallel or zero: no reference axes, so the tilts are not shown.';
  note.classList.toggle('cv-polyhedra-matrix-warn', !ok);
}

/**
 * The Matrix frame's input. Only two axes are typed (rows in terms of a, b,
 * c, as in the lattice transformation): the reference frame takes axis 1,
 * makes axis 2 orthogonal to it and sets axis 3 = axis 1 × axis 2
 * (cellReferenceFrame), so a typed third row would be ignored — it is shown
 * as computed instead. The stored matrix keeps three rows; the third is
 * left as it is.
 */
function matrixInput() {
  const table = document.createElement('table');
  table.className = 'lsc-transform-table';
  table.id = 'polyhedraTiltMatrix';
  table.title = 'Reference axes 1 and 2 as rows, in terms of the cell vectors a, b, c (as the lattice transformation); axis 3 is their cross product';
  const head = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const text of ['', 'a', 'b', 'c']) {
    const th = document.createElement('th');
    th.className = 'cv-polyhedra-matrix-head';
    th.textContent = text;
    hr.appendChild(th);
  }
  head.appendChild(hr);
  table.appendChild(head);
  const body = document.createElement('tbody');
  const M = general.polyhedraTiltMatrix;
  const rowLabel = (text) => {
    const th = document.createElement('th');
    th.scope = 'row';
    th.className = 'cv-polyhedra-matrix-head';
    th.textContent = text;
    return th;
  };
  for (let r = 0; r < 2; r++) {
    const tr = document.createElement('tr');
    tr.appendChild(rowLabel(`Axis ${r + 1}`));
    for (let c = 0; c < 3; c++) {
      const td = document.createElement('td');
      td.className = 'lsc-transform-cell';
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.5';
      input.className = 'lsc-transform-input';
      input.id = `polyhedraTiltMatrix_${r}_${c}`;
      input.setAttribute('aria-label', `Tilt axis ${r + 1}, component along ${'abc'[c]}`);
      input.value = String(M?.[r]?.[c] ?? (r === c ? 1 : 0));
      input.addEventListener('change', () => {
        const next = general.polyhedraTiltMatrix.map((row) => [...row]);
        const v = Number(input.value);
        next[r][c] = Number.isFinite(v) ? v : 0;
        general.polyhedraTiltMatrix = next;
        // New axes: the values mean something else, so fit the range
        // again, as a change of Tilt axes does.
        general.polyhedraColorMin = null;
        general.polyhedraColorMax = null;
        savePolyhedraColorPrefs();
        recolor();
      });
      td.appendChild(input);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  const tr = document.createElement('tr');
  tr.appendChild(rowLabel('Axis 3'));
  const td = document.createElement('td');
  td.colSpan = 3;
  td.className = 'lsc-transform-cell cv-polyhedra-matrix-computed';
  td.id = 'polyhedraTiltMatrixAxis3';
  td.textContent = 'axis 1 × axis 2 (computed)';
  tr.appendChild(td);
  body.appendChild(tr);
  table.appendChild(body);
  const note = document.createElement('div');
  note.className = 'cv-polyhedra-mode-note cv-polyhedra-matrix-note';
  const wrap = document.createElement('div');
  wrap.className = 'lsc-transform-matrix-container';
  wrap.append(table, note);
  return wrap;
}

/**
 * Build the Colour section into `container` (the Polyhedra window body). A
 * rebuild (structure switch) replaces the previous one; the bar's layout
 * carries over.
 * @param {HTMLElement} container
 */
export function buildPolyhedraColorControls(container) {
  removeBar();
  const root = document.createElement('div');
  root.id = 'polyhedraColorSection';
  root.className = 'cv-polyhedra-color-section';
  root.appendChild(makeSectionHeadline('Colour'));
  const byRow = selectRow('polyhedraColorBy', 'Colour by', COLOR_BY, general.polyhedraColor, (value) => {
    general.polyhedraColor = value;
    general.polyhedraColorMin = null; // fit the new property's range
    general.polyhedraColorMax = null;
    savePolyhedraColorPrefs();
    recolor();
  });
  root.appendChild(byRow);
  const mapRow = selectRow('polyhedraColorMap', 'Colour map', COLOR_MAPS, general.polyhedraColorMap || 'auto', (value) => {
    general.polyhedraColorMap = value;
    savePolyhedraColorPrefs();
    recolor();
  });
  mapRow.title = 'Automatic: a diverging map centred at 0 for the tilts, Viridis otherwise';
  root.appendChild(mapRow);
  const greyRow = createToggleRow({
    id: 'polyhedraColorGreyOthers',
    label: 'Grey the rest',
    checked: general.polyhedraColorGreyOthers !== false,
    onChange: (checked) => {
      general.polyhedraColorGreyOthers = checked;
      savePolyhedraColorPrefs();
      recolor();
    },
  }).row;
  greyRow.title = 'Polyhedra the property does not apply to (cages for the distortions, CN 8 for the tilts) in grey; off: in their style colour';
  root.appendChild(greyRow);
  const edgesRow = selectRow('polyhedraColorEdges', 'Edges', EDGE_MODES, general.polyhedraColorEdges || 'grey', (value) => {
    general.polyhedraColorEdges = value;
    savePolyhedraColorPrefs();
    recolor();
  });
  edgesRow.title = 'Edge colour of the polyhedra coloured by the property';
  root.appendChild(edgesRow);
  const tiltRow = selectRow('polyhedraTiltFrame', 'Tilt axes', TILT_FRAMES, general.polyhedraTiltFrame, (value) => {
    general.polyhedraTiltFrame = value;
    general.polyhedraColorMin = null;
    general.polyhedraColorMax = null;
    savePolyhedraColorPrefs();
    recolor();
  });
  tiltRow.title = 'The reference axes of the tilts and the total rotation. Automatic: per polyhedron type, the mean orientation of its polyhedra (the untilted pseudo-cubic axes in any cell setting)';
  root.appendChild(tiltRow);
  const matrix = matrixInput();
  root.appendChild(matrix);
  const info = document.createElement('div');
  info.id = 'polyhedraTiltAutoInfo';
  info.className = 'cv-polyhedra-mode-note';
  root.appendChild(info);
  const barHost = document.createElement('div');
  barHost.className = 'cv-polyhedra-color-bar';
  root.appendChild(barHost);
  const rangeNote = document.createElement('div');
  rangeNote.id = 'polyhedraColorRangeNote';
  rangeNote.className = 'cv-polyhedra-mode-note';
  root.appendChild(rangeNote);
  container.appendChild(root);
  const select = /** @type {HTMLSelectElement} */ (byRow.querySelector('select'));
  ui = { root, select, mapRow, greyRow, edgesRow, tiltRow, matrix, info, barHost, rangeNote };
  syncInfo();
}

/** The section's window is gone: drop the bar with it. */
export function removePolyhedraColorControls() {
  removeBar();
  ui = null;
}

/** The Polyhedra window was taken out of the sidebar: the colouring goes
 *  with it — back to Style (the style colours), no bar. */
export function resetPolyhedraColoring() {
  if (general.polyhedraColor !== 'style') {
    general.polyhedraColor = 'style';
    general.polyhedraColorMin = null;
    general.polyhedraColorMax = null;
    savePolyhedraColorPrefs();
    updatePolyhedraColors();
  }
  // the shelved window keeps its content: show it at Style
  if (ui) {
    ui.select.value = 'style';
    ui.select.title = ui.select.selectedOptions[0]?.title ?? '';
  }
  syncInfo();
  removeBar();
}

onFeatureStoreChange((id, inSidebar) => {
  if (id === 'polyhedra' && !inSidebar) resetPolyhedraColoring();
});

// A rebuild recomputed the property (and the automatic frame); the render
// module fitted a new range. Keep the bar and the frame line in step.
document.addEventListener('crysviz:polyhedra-rebuilt', () => {
  if (ui && !ui.root.isConnected) { removePolyhedraColorControls(); return; }
  syncInfo();
});
document.addEventListener('crysviz:polyhedra-color-range', syncRange);

/** For tests: the live bar (or null). */
export function polyhedraColorBar() {
  return colorBar;
}
