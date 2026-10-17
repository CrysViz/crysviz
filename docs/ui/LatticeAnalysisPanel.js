// Lattice Analysis control window: reads the unit-cell parameters (a, b, c,
// α, β, γ) of a set of points and plots them — against the points' own order,
// against a per-frame property (energy, max force, pressure, volume, file
// name) chosen in "Sort by", or against a user-typed "custom x axis" (a
// pressure series, a temperature ramp, ...) with its own label and unit.
//
// Two sources of points:
//   - trajectory: every frame of the SELECTED row (a file with 2+ frames);
//   - selected:   the CHECKED rows of the Files table, each at the frame its
//                 step box currently shows — so a set of separately loaded
//                 structures (an EOS series in separate files, several
//                 relaxations) can be compared, always at their shown frame.
//
// The plots live in their own window (LatticePlotsPanel.js, defaulting to
// the wide side dock), opened from THIS window's "Show plots" button — never
// by itself — and following the selection once open; clicking a plotted
// point shows that frame (and row) in the viewer,
// and the point on screen is ringed in every plot. Both windows are
// available only while some source has points: the selected row is a
// trajectory, or two or more rows are checked.

import {
  latticePointSeries, parseCustomAxisValues, customAxisTitle, LATTICE_QUANTITIES, SORT_PROPERTIES,
  latticeCsv, latticeTableRows, latticeTableText,
} from '../lattice/latticeSeries.js';
import { downloadBlob } from './SavePanel.js';
import { plotLatticeSeries, onLatticePointClick } from '../lattice/latticePlots.js';
import { setRedrawHandler, LATTICE_PLOT_CARDS, LATTICE_PLOT_IDS } from './LatticePlotsPanel.js';
import { openPanel, refreshPanelAvailability } from './panels/PanelManager.js';
import { selectStructure } from './FileBrowswerPanel.js';
import { onActiveStructureChange } from '../state/structures.js';
import { fileBrowser, structureShip } from '../state/store.js';

const PANEL_BODY_ID = 'cvPanelBody-latticeAnalysis';

/** @typedef {{container: object, step: number, rowIndex: number, name: string}} LatticePoint */

const state = {
  /** 'trajectory' | 'selected' — the source the plots currently show. */
  source: null,
  /** The trajectory container (trajectory source), for the series cache. */
  container: null,
  /** @type {LatticePoint[]} the plotted points, in source order */
  points: [],
  /** Their series (latticeSeries.js LatticeSeries), 1:1 with points. */
  series: null,
  /** Only the newest series computation may land (rapid switches). */
  loadToken: 0,
};

// The user's choices, kept across rebuilds (a structure switch rebuilds this
// window's body): the source ('auto' follows what has data), the sort key,
// the folded state of the custom-axis form and its draft label/unit.
let sourceChoice = 'auto';
let sortBy = 'order';
let customAxisOpen = false;
let draftLabel = 'Pressure';
let draftUnit = 'GPa';

// Per-trajectory memory, keyed on the container object so a row switch and
// back finds its series and its custom axis again, and a deleted row's
// entries just fall out of scope. The checked-structures source has one
// custom axis, valid while the point count matches.
/** @type {WeakMap<object, {frameCount: number, series: object}>} */
const seriesCache = new WeakMap();
/** @type {WeakMap<object, {values: number[], label: string, unit: string}>} */
const customAxes = new WeakMap();
/** @type {{values: number[], label: string, unit: string} | null} */
let selectedCustomAxis = null;

let unsubscribeActiveChange = null;

// ---- sources ----------------------------------------------------------------

/** The selected row's container when it is a trajectory (2+ frames), else null. */
export function selectedTrajectoryContainer() {
  const container = structureShip.container[fileBrowser.selectedRowIndex];
  return container && container.structures.length > 1 ? container : null;
}

function rowName(row) {
  return row?.querySelector('.name-inner')?.textContent?.trim() || 'structure';
}

/** The checked Files-table rows as points, each at the frame its step box
 *  shows (clamped into the row's frames), in table order. */
export function checkedStructurePoints() {
  const rows = document.querySelectorAll('#objectTable tbody tr');
  /** @type {LatticePoint[]} */
  const points = [];
  rows.forEach((row, rowIndex) => {
    if (!row.querySelector('input[type="checkbox"]')?.checked) return;
    const container = structureShip.container[rowIndex];
    if (!container || !container.structures.length) return;
    const typed = parseInt(row.querySelector('input[type="number"]')?.value, 10);
    const step = Math.max(0, Math.min(container.structures.length - 1, (Number.isFinite(typed) ? typed : 1) - 1));
    points.push({ container, step, rowIndex, name: rowName(row) });
  });
  return points;
}

function trajectoryPoints(container) {
  const rowIndex = structureShip.container.indexOf(container);
  const name = rowName(document.querySelectorAll('#objectTable tbody tr')[rowIndex]);
  return Array.from({ length: container.structures.length }, (_, step) => ({ container, step, rowIndex, name }));
}

/** The source that has data under the user's choice: their pick when it has
 *  points, otherwise whichever does (trajectory first), else null. */
function effectiveSource() {
  const hasTrajectory = !!selectedTrajectoryContainer();
  const nChecked = checkedStructurePoints().length;
  if (sourceChoice === 'trajectory' && hasTrajectory) return 'trajectory';
  if (sourceChoice === 'selected' && nChecked >= 1) return 'selected';
  if (hasTrajectory) return 'trajectory';
  if (nChecked >= 2) return 'selected';
  return null;
}

/** available() for both Lattice Analysis windows. */
export function latticeAnalysisAvailable() {
  return effectiveSource() !== null;
}

/** The custom axis in force for the current source, or null — read by tests. */
export function getCustomAxis() {
  if (state.source === 'selected') return selectedCustomAxis;
  return state.container ? (customAxes.get(state.container) ?? null) : null;
}

/** The current sort key — read by tests. */
export function getSortBy() {
  return sortBy;
}

// ---- helpers ----------------------------------------------------------------

function q(sel) {
  return document.getElementById(PANEL_BODY_ID)?.querySelector(sel) ?? null;
}

function setStatus(text, isError = false) {
  const el = q('#laStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('la-status-error', !!isError);
}

function isPlotExpanded(plotId) {
  return !!document.getElementById(`${plotId}-wrapper`)?.classList.contains('expanded');
}

function pointNoun() {
  return state.source === 'selected' ? 'structure' : 'frame';
}

/** Index of the point the viewer shows, or null: the shown frame of the
 *  trajectory, or the checked row that is selected (at its shown step). */
function shownPointIndex() {
  const { source, points, container } = state;
  const rowIndex = fileBrowser.selectedRowIndex;
  const step = Number.isInteger(fileBrowser.stepInput) ? fileBrowser.stepInput : 0;
  if (source === 'trajectory') {
    if (container !== structureShip.container[rowIndex]) return null;
    return step < points.length ? step : null;
  }
  const i = points.findIndex((p) => p.rowIndex === rowIndex);
  return i >= 0 ? i : null;
}

/** Labels for the hover: the frame number, or the row name (with its frame
 *  when the row is a trajectory). Names are made unique — Plotly folds equal
 *  category labels into one tick. */
function pointLabels() {
  const { source, points } = state;
  if (source === 'trajectory') return points.map((p) => `frame ${p.step + 1}`);
  const seen = new Map();
  return points.map((p) => {
    const n = (seen.get(p.name) ?? 0) + 1;
    seen.set(p.name, n);
    const base = n > 1 ? `${p.name} (${n})` : p.name;
    return p.container.structures.length > 1 ? `${base} · frame ${p.step + 1}` : base;
  });
}

/** Sort keys usable for the current points: `name` only for checked
 *  structures; a numeric property only when some point carries it. */
function availableSortKeys() {
  const { series, source } = state;
  return SORT_PROPERTIES.filter(({ key }) => {
    if (key === 'order') return true;
    if (key === 'name') return source === 'selected';
    return !!series && series[key].some(Number.isFinite);
  }).map(({ key }) => key);
}

/** The x axis: the custom axis when one is stored for this source and still
 *  matches the point count (a live run may have grown since), else the
 *  sort-by property, else the points' own order. */
function xAxis() {
  const { source, points, series, container } = state;
  const n = points.length;
  const custom = source === 'selected' ? selectedCustomAxis : (container ? customAxes.get(container) : null);
  if (custom && custom.values.length === n) {
    return { x: custom.values, xTitle: customAxisTitle(custom.label, custom.unit), sortByX: true, custom: true };
  }
  const key = availableSortKeys().includes(sortBy) ? sortBy : 'order';
  const labels = pointLabels();
  if (key === 'order') {
    return source === 'selected'
      ? { x: labels, xTitle: 'Structure', sortByX: false, custom: false }
      : { x: points.map((_, i) => i + 1), xTitle: 'Frame', sortByX: false, custom: false };
  }
  if (key === 'name') return { x: labels, xTitle: 'Structure', sortByX: true, custom: false };
  const prop = SORT_PROPERTIES.find((p) => p.key === key);
  return { x: series[key], xTitle: `${prop.label} (${prop.unit})`, sortByX: true, custom: false };
}

/** Show the clicked point: its row (looked up at click time — rows can be
 *  deleted or reordered under the plots) at its frame. */
function showPoint(pointIndex) {
  const point = state.points[Number(pointIndex)];
  if (!point) return;
  const rowIndex = structureShip.container.indexOf(point.container);
  if (rowIndex < 0) return;
  selectStructure(rowIndex, point.step);
}

async function redraw(plotId) {
  const card = LATTICE_PLOT_CARDS.find((c) => c.id === plotId);
  if (!card || !state.series || !state.points.length) return;
  if (!document.getElementById(plotId)) return;
  const { x, xTitle, sortByX } = xAxis();
  const series = card.series.map((key) => {
    const quantity = LATTICE_QUANTITIES.find((entry) => entry.key === key);
    return { key, label: quantity.label, unit: quantity.unit, values: state.series[key] };
  });
  await plotLatticeSeries(plotId, {
    x, xTitle, sortByX, labels: pointLabels(), series, yTitle: card.yTitle,
    currentIndex: shownPointIndex(),
  }, isPlotExpanded(plotId));
  onLatticePointClick(plotId, showPoint);
}

function redrawAll() {
  for (const id of LATTICE_PLOT_IDS) {
    redraw(id).catch((error) => {
      // Offline (Plotly comes from a CDN): the card shows the message in
      // place of the chart; a condition, not a defect.
      const offline = /unavailable offline/.test(error?.message || '');
      if (!offline) console.error(error);
      const el = document.getElementById(id);
      if (el && !el.querySelector('.js-plotly-plot')) el.textContent = error.message || String(error);
    });
  }
}

// ---- controls ---------------------------------------------------------------

/** Fill the parameter table: the shown point's value plus the min–max range
 *  over all points, one row per cell parameter. The cells are plain
 *  selectable text; "Copy table" takes the whole table. */
function updateTable() {
  const tbody = q('#laTableBody');
  if (!tbody) return;
  const { series } = state;
  const rows = series ? latticeTableRows(series, shownPointIndex()) : [];
  const cell = (text) => `<td>${text || '–'}</td>`;
  tbody.innerHTML = rows.map((r) => `<tr>
      <td>${r.label}</td>${cell(r.shown)}${cell(r.min)}${cell(r.max)}
      <td>${r.unit}</td>
    </tr>`).join('');
  const hasData = rows.length > 0;
  for (const id of ['#laCopyTableBtn', '#laExportCsvBtn']) {
    const btn = q(id);
    if (btn) btn.disabled = !hasData;
  }
}

function copyText(text, onDone) {
  if (!navigator.clipboard?.writeText) {
    setStatus('Clipboard is not available in this browser.', true);
    return;
  }
  navigator.clipboard.writeText(text).then(onDone).catch((error) => {
    setStatus('Copy failed.', true);
    console.error('Copy failed:', error);
  });
}

function copyTable() {
  if (!state.series) return;
  copyText(latticeTableText(state.series, shownPointIndex()), () => setStatus('Table copied (tab-separated).'));
}

/** Every plotted point with all its numbers, as a CSV download. */
function exportCsv() {
  const { series, points, source } = state;
  if (!series || !points.length) return;
  const csv = latticeCsv({
    labels: pointLabels(), steps: points.map((p) => p.step), series, customAxis: getCustomAxis(),
  });
  const base = source === 'trajectory'
    ? (state.container?.fileName ?? 'trajectory').replace(/[^\w.-]+/g, '_')
    : 'checked_structures';
  downloadBlob(`lattice_${base}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  setStatus(`Exported ${points.length} point${points.length === 1 ? '' : 's'} as CSV.`);
}

function updateSourceLine() {
  const name = q('#laSourceName');
  const meta = q('#laSourceMeta');
  if (!name || !meta) return;
  const { source, points, container } = state;
  if (!source || !points.length) {
    name.textContent = 'none';
    meta.textContent = '';
    return;
  }
  const axis = xAxis();
  const axisNote = axis.custom ? `custom x axis: ${axis.xTitle}` : `x axis: ${axis.xTitle.toLowerCase()}`;
  if (source === 'trajectory') {
    name.textContent = container?.fileName ?? 'trajectory';
    meta.textContent = `${points.length} frames — ${axisNote}`;
  } else {
    name.textContent = `${points.length} checked structure${points.length === 1 ? '' : 's'}`;
    meta.textContent = `each at its shown frame — ${axisNote}`;
  }
}

/** Reflect the source choice and the usable sort keys in the two selects. */
function updateSelects() {
  const sourceSel = q('#laSource');
  const sortSel = q('#laSortBy');
  if (sourceSel) {
    const nChecked = checkedStructurePoints().length;
    sourceSel.querySelector('option[value="trajectory"]').disabled = !selectedTrajectoryContainer();
    const selectedOpt = sourceSel.querySelector('option[value="selected"]');
    selectedOpt.disabled = nChecked === 0;
    selectedOpt.textContent = `Checked structures (${nChecked})`;
    sourceSel.value = state.source ?? (sourceChoice === 'auto' ? 'trajectory' : sourceChoice);
  }
  if (sortSel) {
    const usable = availableSortKeys();
    for (const opt of sortSel.querySelectorAll('option')) {
      opt.disabled = !usable.includes(opt.value);
    }
    sortSel.value = usable.includes(sortBy) ? sortBy : 'order';
  }
  const help = q('#laAxisHelpNoun');
  if (help) help.textContent = state.source === 'selected' ? 'checked structure, in Files-table order' : 'frame, in frame order';
}

/** Point the window at the current source: gather its points, compute (or
 *  recall) their series, and refresh the controls and the plots (when the
 *  plots window is open — it is never opened from here). */
async function sync() {
  const source = effectiveSource();
  state.source = source;
  if (!source) {
    state.container = null;
    state.points = [];
    state.series = null;
    updateSelects();
    updateSourceLine();
    updateTable();
    setStatus('Select a trajectory (a file with 2+ frames), or check two or more rows in the Files table.');
    return;
  }
  const token = ++state.loadToken;
  if (source === 'trajectory') {
    const container = selectedTrajectoryContainer();
    state.container = container;
    state.points = trajectoryPoints(container);
    const cached = seriesCache.get(container);
    if (cached && cached.frameCount === container.structures.length) {
      state.series = cached.series;
    } else {
      state.series = null;
      setStatus('Reading cell parameters…');
      const series = await latticePointSeries(state.points);
      if (token !== state.loadToken) return; // superseded by a newer selection
      seriesCache.set(container, { frameCount: series.frameCount, series });
      state.series = series;
      setStatus('');
    }
  } else {
    state.container = null;
    state.points = checkedStructurePoints();
    const series = await latticePointSeries(state.points);
    if (token !== state.loadToken) return;
    state.series = series;
    if (q('#laStatus')?.textContent === 'Reading cell parameters…') setStatus('');
  }
  updateSelects();
  updateSourceLine();
  updateTable();
  redrawAll();
}

function safeSync() {
  sync().catch((error) => {
    setStatus(`Error: ${error.message}`, true);
    console.error(error);
  });
}

/** A selection settled (row click, step box, scrubber release, a plot click):
 *  follow it. Same trajectory: just the ring moves. Anything else — another
 *  trajectory, a grown live run, the checked-structures source (whose points
 *  are the rows' SHOWN frames) — re-syncs. A selection no source can serve
 *  is left to the windows' availability gate (they grey out / close). */
function onActiveChange() {
  if (!document.getElementById(PANEL_BODY_ID)) return; // window not built
  const source = effectiveSource();
  if (!source) return;
  const sameTrajectory = source === 'trajectory' && state.source === 'trajectory'
    && state.container === selectedTrajectoryContainer() && state.series
    && state.series.frameCount === state.container.structures.length;
  if (!sameTrajectory) {
    safeSync();
    return;
  }
  updateTable();
  redrawAll();
}

// The Files table's checkboxes and step boxes are the checked-structures
// source's inputs, so their edits re-evaluate the windows' availability (a
// second checked row makes the windows available with no trajectory
// selected) and re-sync a built window. Delegated on the document, once at
// module load: the table body is rebuilt by the file browser, and the
// availability must follow even while this window was never built.
let filesTableSyncTimer = 0;
document.addEventListener('change', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
  if (!target.closest('#objectTable tbody')) return;
  refreshPanelAvailability();
  scheduleFilesTableSync();
});
document.addEventListener('input', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (!(target instanceof HTMLInputElement) || target.type !== 'number') return;
  if (!target.closest('#objectTable tbody')) return;
  scheduleFilesTableSync();
});
function scheduleFilesTableSync() {
  if (!document.getElementById(PANEL_BODY_ID)) return;
  clearTimeout(filesTableSyncTimer);
  filesTableSyncTimer = window.setTimeout(() => {
    if (!document.getElementById(PANEL_BODY_ID)) return;
    if (state.source === 'selected' || effectiveSource() !== state.source) safeSync();
    else updateSelects();
  }, 50);
}

function applyCustomAxis() {
  const { source, points } = state;
  if (!source || !points.length) {
    setStatus('Nothing to plot yet.', true);
    return;
  }
  const label = q('#laAxisLabel')?.value ?? '';
  const unit = q('#laAxisUnit')?.value ?? '';
  const text = q('#laAxisValues')?.value ?? '';
  let values;
  try {
    values = parseCustomAxisValues(text, points.length, pointNoun());
  } catch (error) {
    setStatus(error.message, true);
    return;
  }
  draftLabel = label;
  draftUnit = unit;
  const axis = { values, label, unit };
  if (source === 'selected') selectedCustomAxis = axis;
  else customAxes.set(state.container, axis);
  setStatus(`Custom x axis applied: ${customAxisTitle(label, unit)}.`);
  updateSourceLine();
  redrawAll();
}

function clearCustomAxis() {
  if (state.source === 'selected') selectedCustomAxis = null;
  else if (state.container) customAxes.delete(state.container);
  setStatus('Custom x axis cleared — plotting by "Sort by".');
  updateSourceLine();
  redrawAll();
}

function setCustomAxisOpen(open) {
  customAxisOpen = !!open;
  const section = q('#laCustomAxis');
  const btn = q('#laCustomAxisBtn');
  if (section) section.hidden = !customAxisOpen;
  if (btn) btn.setAttribute('aria-expanded', String(customAxisOpen));
}

/** Prefill the custom-axis fields for the current source: its stored axis
 *  wins, otherwise the last typed label/unit and an empty value box. */
function prefillCustomAxisForm() {
  const stored = getCustomAxis();
  const label = q('#laAxisLabel');
  const unit = q('#laAxisUnit');
  const values = q('#laAxisValues');
  if (!label || !unit || !values) return;
  label.value = stored ? stored.label : draftLabel;
  unit.value = stored ? stored.unit : draftUnit;
  values.value = stored ? stored.values.join(' ') : '';
  setCustomAxisOpen(customAxisOpen || !!stored);
}

export function addLatticeAnalysisPanel(target = PANEL_BODY_ID) {
  const body = document.getElementById(target);
  if (!body) return;

  const sortOptions = SORT_PROPERTIES.map(({ key, label, unit }) =>
    `<option value="${key}">${label}${unit ? ` (${unit})` : ''}</option>`).join('');

  body.innerHTML = `
    <div class="control-group la-source">
      <div class="la-source-line">Source: <span class="la-source-name" id="laSourceName">none</span></div>
      <div class="la-source-meta" id="laSourceMeta"></div>
      <div class="la-select-row">
        <label class="la-select" title="Which structures the points are: every frame of the selected trajectory, or the checked rows of the Files table at their shown frame">
          <span>Points</span>
          <select id="laSource">
            <option value="trajectory">Selected trajectory</option>
            <option value="selected">Checked structures (0)</option>
          </select>
        </label>
        <label class="la-select" title="Order the points by, and plot them against, this property; greyed entries are not available for these points">
          <span>Sort by</span>
          <select id="laSortBy">${sortOptions}</select>
        </label>
      </div>
    </div>

    <div class="control-group">
      <div class="la-actions-row">
        <button type="button" id="laShowPlotsBtn" class="btn-mini la-btn" title="Open the Lattice Plots window">Show plots</button>
        <button type="button" id="laCustomAxisBtn" class="btn-mini la-btn" aria-expanded="false"
          title="Plot against your own x values (e.g. the pressure of each point) instead of the Sort by property">Custom x axis</button>
      </div>
      <div class="la-custom-axis" id="laCustomAxis" hidden>
        <p class="la-help">One value per <span id="laAxisHelpNoun">frame, in frame order</span> — separated by spaces, commas or new lines. The plots are then drawn against these values, sorted; this overrides "Sort by".</p>
        <div class="la-field-row">
          <label class="la-field">
            <span>Label</span>
            <input type="text" id="laAxisLabel" placeholder="Pressure">
          </label>
          <label class="la-field">
            <span>Unit</span>
            <input type="text" id="laAxisUnit" placeholder="GPa">
          </label>
        </div>
        <label class="la-field la-field-values">
          <span>Values</span>
          <textarea id="laAxisValues" rows="4" spellcheck="false" placeholder="0 5 10 15 20"></textarea>
        </label>
        <div class="la-actions-row">
          <button type="button" id="laAxisApplyBtn" class="btn-mini la-btn">Apply</button>
          <button type="button" id="laAxisClearBtn" class="btn-mini la-btn" title="Back to the Sort by property">Clear</button>
        </div>
      </div>
      <div class="la-status" id="laStatus"></div>
    </div>

    <div class="control-group la-results">
      <div class="la-actions-row la-table-actions">
        <button type="button" id="laCopyTableBtn" class="btn-mini la-btn" title="Copy the table below as tab-separated text (pastes into a spreadsheet)" disabled>Copy table</button>
        <button type="button" id="laExportCsvBtn" class="btn-mini la-btn" title="Download every plotted point with its cell parameters and properties as CSV" disabled>Export CSV</button>
      </div>
      <table class="la-table">
        <thead>
          <tr><th></th><th>Shown</th><th>Min</th><th>Max</th><th></th></tr>
        </thead>
        <tbody id="laTableBody"></tbody>
      </table>
    </div>
  `;

  q('#laSource').addEventListener('change', (e) => {
    sourceChoice = /** @type {HTMLSelectElement} */ (e.target).value;
    safeSync();
    prefillCustomAxisForm();
  });
  q('#laSortBy').addEventListener('change', (e) => {
    sortBy = /** @type {HTMLSelectElement} */ (e.target).value;
    updateSourceLine();
    redrawAll();
  });
  q('#laShowPlotsBtn').addEventListener('click', () => {
    // Open BEFORE drawing so the plot elements exist (the plots window
    // builds on first open and draws through the redraw handler itself).
    openPanel('latticePlots');
    redrawAll();
  });
  q('#laCopyTableBtn').addEventListener('click', copyTable);
  q('#laExportCsvBtn').addEventListener('click', exportCsv);
  q('#laCustomAxisBtn').addEventListener('click', () => setCustomAxisOpen(!customAxisOpen));
  q('#laAxisApplyBtn').addEventListener('click', applyCustomAxis);
  q('#laAxisClearBtn').addEventListener('click', clearCustomAxis);
  // Enter in the label/unit boxes applies, like a form.
  for (const id of ['#laAxisLabel', '#laAxisUnit']) {
    q(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustomAxis(); });
  }

  setRedrawHandler(redraw);
  if (!unsubscribeActiveChange) unsubscribeActiveChange = onActiveStructureChange(onActiveChange);

  // The custom-axis form needs to know the source; set it synchronously
  // (the series may still be loading) so the prefill reads the right axis.
  state.source = effectiveSource();
  state.container = state.source === 'trajectory' ? selectedTrajectoryContainer() : null;
  prefillCustomAxisForm();

  // The plots window is NOT opened here — only "Show plots" does that (an
  // analysis window popping a second window open on expand was unwanted);
  // once open it follows the selection through the redraws below.
  safeSync();
}

export function removeLatticeAnalysisPanel() {
  // The series/axis memory intentionally persists across rebuilds — a
  // structure switch rebuilds this window and the plots must still know a
  // trajectory's axis when the user comes back to it. The active-change
  // subscription and the Files-table listeners stay too: they check for a
  // built body and no-op otherwise.
}
