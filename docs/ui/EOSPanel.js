// EOS (Birch-Murnaghan equation-of-state) fitting control window: reads a
// Pressure/Energy/Volume dataset, fits it with SciPy (via Pyodide) and shows
// the fit parameters; the E-V/P-V plots live in their own window
// (EOSPlotsPanel.js, defaulting to the wide side dock), which THIS module
// activates whenever there is something to show — a dataset loaded or re-fit
// opens it, resetting the fit closes it.

import { CONVERSION_FACTORS, detectColumns, parseReferenceData, formatParam } from '../eos/eosMath.js';
import { fitEOS, fitReferencePV } from '../eos/eosFit.js';
import { plotEV, plotPV, clearPlot, onEOSPointClick } from '../eos/eosPlots.js';
import { runEOSScan } from '../eos/eosCompute.js';
import { setRedrawHandler, setPlotVisible, getShowErrorPlots } from './EOSPlotsPanel.js';
import { openPanel, closePanel } from './panels/PanelManager.js';
import { ensureActiveCalculator, snapshotCurrentStructure } from './BackendPanel/AtomisticPanels.js';
import { createRow, updateRow, selectStructure } from './FileBrowswerPanel.js';
import { StructureContainer } from '../model/index.js';
import { fileBrowser, structureShip, general } from '../state/store.js';

const state = {
  originalColumnData: null, // {volumes, energies, pressures, columnInfo} verbatim from file
  referenceRawParsed: null, // {volumes, pressures, errors} verbatim from reference file
  referenceRaw: null, // referenceRawParsed with volumes divided by referenceVolumeDivisor
  referenceVolumeDivisor: 1,
  volumes: null, energies: null, pressures: null, // SI, sorted by volume
  pvResult: null,
  evResult: null,
  referenceFit: null,
  minEnergy: null,
  units: { energy: 'eV', pressure: 'GPa', volume: 'Å³' },
  // Potential-computed scan (see ingestComputedScan): the per-point structures,
  // sorted by volume 1:1 with the plotted data (= plot customdata index), and
  // the "EOS scan (…)" file-browser <tr> they live under. The row's index is
  // re-derived from the table at click time — rows can be deleted/reordered.
  computedStructures: null,
  computedRow: null,
};

// Compute-from-potential run state. Module-level (not per-panel-build) so a
// panel rebuild mid-scan can't spawn a second concurrent run.
let computeRunning = false;
let computeStopRequested = false;

function toSI(columnData, units) {
  const hasEnergy = Array.isArray(columnData.energies);
  const volumes = columnData.volumes.map((v) => v * (CONVERSION_FACTORS.volume[units.volume] ?? 1));
  const energies = hasEnergy ? columnData.energies.map((e) => e * (CONVERSION_FACTORS.energy[units.energy] ?? 1)) : null;
  const pressures = columnData.pressures.map((p) => p * (CONVERSION_FACTORS.pressure[units.pressure] ?? 1));
  const combined = volumes.map((v, i) => ({ v, e: hasEnergy ? energies[i] : null, p: pressures[i] })).sort((a, b) => a.v - b.v);
  return {
    volumes: combined.map((d) => d.v),
    energies: hasEnergy ? combined.map((d) => d.e) : null,
    pressures: combined.map((d) => d.p),
  };
}

function setStatus(container, text) {
  const el = container.querySelector('.eos-status');
  if (el) el.textContent = text;
}

function setPyodideStatus(container, text) {
  const el = container.querySelector('.eos-pyodide-status');
  if (el) el.textContent = text;
}

function setComputeStatus(container, text) {
  const el = container.querySelector('.eos-compute-status');
  if (el) el.textContent = text;
}

function isPlotExpanded(plotId) {
  return !!document.getElementById(`${plotId}-wrapper`)?.classList.contains('expanded');
}

function safeRedraw(plotId) {
  redraw(plotId).catch((error) => console.error(error));
}

/** There is something to show: make sure the plots window is open (front tab
 *  of the side dock by default — or wherever the user last put it). */
function ensurePlotsWindowOpen() {
  openPanel('eosPlots');
}

async function redraw(plotId) {
  const isExpanded = isPlotExpanded(plotId);
  if (plotId === 'ev-plot' && state.evResult) {
    await plotEV('ev-plot', { volumes: state.volumes, energies: state.energies, evParams: state.evResult.params }, isExpanded);
  } else if (plotId === 'pv-plot' && state.pvResult) {
    await plotPV('pv-plot', {
      volumes: state.volumes,
      pressures: state.pressures,
      pvParams: state.pvResult.params,
      evParams: state.evResult?.params,
      referenceData: state.referenceRaw,
      referenceFit: state.referenceFit,
      showErrorPlots: getShowErrorPlots(),
    }, isExpanded);
  }
}

function updateResultsUI(container) {
  const { pvResult, evResult } = state;
  if (!pvResult) return;

  const q = (sel) => container.querySelector(sel);
  q('#eos-pv-V0').textContent = `${formatParam(pvResult.params[0], pvResult.errors?.[0])} Å³`;
  q('#eos-pv-K0').textContent = `${formatParam(pvResult.params[1], pvResult.errors?.[1])} GPa`;
  q('#eos-pv-K0Prime').textContent = formatParam(pvResult.params[2], pvResult.errors?.[2]);
  q('#eos-pv-rms').textContent = `${pvResult.fitStats.rms.toFixed(6)} GPa`;
  q('#eos-pv-maxres').textContent = `${pvResult.fitStats.maxRes.toFixed(6)} GPa`;
  q('#eos-pv-points').textContent = String(pvResult.fitStats.nPoints);

  container.querySelector('.eos-ev-results').hidden = !evResult;
  if (evResult) {
    q('#eos-ev-E0').textContent = `${formatParam(evResult.params[0], evResult.errors?.[0])} eV`;
    q('#eos-ev-V0').textContent = `${formatParam(evResult.params[1], evResult.errors?.[1])} Å³`;
    q('#eos-ev-K0').textContent = `${formatParam(evResult.params[2], evResult.errors?.[2])} GPa`;
    q('#eos-ev-K0Prime').textContent = formatParam(evResult.params[3], evResult.errors?.[3]);
    q('#eos-ev-rms').textContent = `${evResult.fitStats.rms.toFixed(6)} eV`;
    q('#eos-ev-maxres').textContent = `${evResult.fitStats.maxRes.toFixed(6)} eV`;
    q('#eos-ev-points').textContent = String(evResult.fitStats.nPoints);
  }

  container.querySelector('.eos-results').hidden = false;
}

async function fitAndDisplay(container) {
  // A dataset is loaded (or re-fit) — open the plots window BEFORE drawing so
  // the plot elements exist and the user sees the result appear.
  ensurePlotsWindowOpen();
  try {
    const si = toSI(state.originalColumnData, state.units);
    const hasEnergy = Array.isArray(si.energies);
    state.volumes = si.volumes;
    state.energies = si.energies;
    state.pressures = si.pressures;
    state.minEnergy = hasEnergy ? Math.min(...si.energies) : null;

    setStatus(container, 'Fitting with SciPy…');
    const { pvResult, evResult } = await fitEOS(si.volumes, si.energies, si.pressures,
      (text) => setPyodideStatus(container, text));
    state.pvResult = pvResult;
    state.evResult = evResult;

    updateResultsUI(container);
    setPlotVisible('ev-plot', !!evResult);
    if (evResult) await redraw('ev-plot');
    await redraw('pv-plot');
    setStatus(container, 'Fit complete.');
  } catch (error) {
    setStatus(container, `Error: ${error.message}`);
    console.error(error);
  }
}

async function resetFit(container) {
  state.originalColumnData = null;
  state.volumes = null;
  state.energies = null;
  state.pressures = null;
  state.pvResult = null;
  state.evResult = null;
  state.minEnergy = null;
  // Computed-scan teardown: drop the structures and unhook the plot clicks.
  // The scan's file-browser row (a loaded trajectory like any other) stays —
  // Reset clears the FIT, and a re-run reuses/refreshes that row anyway.
  state.computedStructures = null;
  wireComputedPointClicks();
  setComputeStatus(container, '');
  const fileInput = container.querySelector('#eosFileInput');
  if (fileInput) fileInput.value = '';
  const info = container.querySelector('.eos-column-info');
  if (info) info.innerHTML = '';
  container.querySelector('.eos-results').hidden = true;
  setPlotVisible('ev-plot', false);
  // Nothing left to show — close the plots window immediately (it reopens on
  // the next fit); the plot clearing below may first await Plotly loading.
  closePanel('eosPlots');
  await Promise.all([clearPlot('ev-plot'), clearPlot('pv-plot')]);
  setStatus(container, 'Fit cleared.');
}

async function handlePrimaryFile(container, file) {
  setStatus(container, 'Reading file…');
  const text = await file.text();
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  try {
    const columnData = detectColumns(lines);
    state.originalColumnData = columnData;

    const info = container.querySelector('.eos-column-info');
    const { p, e, v, headers, hasHeaders, hasEnergy } = columnData.columnInfo;
    info.innerHTML = `Detected columns — Pressure: ${p + 1}${hasHeaders ? ` ("${headers[p]}")` : ''},
      Volume: ${v + 1}${hasHeaders ? ` ("${headers[v]}")` : ''}${hasEnergy
        ? `, Energy: ${e + 1}${hasHeaders ? ` ("${headers[e]}")` : ''}`
        : ' — no Energy column found, P-V only'}`;
  } catch (error) {
    setStatus(container, `Error: ${error.message}`);
    console.error(error);
    return;
  }
  await fitAndDisplay(container);
}

/** Register (or refresh, on a re-run) the computed scan as a file-browser row
 *  named "EOS scan (<potential>)" — each point's structure is a frame, so the
 *  scan is scrubbable/selectable like any loaded trajectory. */
function registerScanRow(scan, potential) {
  const tbody = document.querySelector('#objectTable tbody');
  if (!tbody) return;
  const name = `EOS scan (${potential})`;
  const row = state.computedRow;
  if (row && row.isConnected) {
    // Re-run: swap the frames into the existing row's container instead of
    // piling up a new row per scan. The container index tracks the row's
    // live table position (row deletion splices both in step).
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    const container = structureShip.container[rowIndex];
    if (container) {
      container.fileName = name;
      container.structures = scan.structures;
      updateRow(row, { name, traj: scan.structures.length, step: 1 });
      return;
    }
  }
  const container = new StructureContainer({ fileName: name, structures: scan.structures });
  structureShip.container.push(container);
  const newRow = createRow({ name, traj: scan.structures.length, step: 1 });
  tbody.appendChild(newRow);
  state.computedRow = newRow;
}

/** Point plot clicks at the computed structures — or unhook them when there
 *  is no computed scan (file-loaded datasets have no structures to show). */
function wireComputedPointClicks() {
  if (!state.computedStructures) {
    onEOSPointClick('ev-plot', null);
    onEOSPointClick('pv-plot', null);
    return;
  }
  const handler = (pointIndex) => {
    const row = state.computedRow;
    if (!row || !row.isConnected) return;
    const rowIndex = Array.from(row.parentElement.children).indexOf(row);
    selectStructure(rowIndex, Number(pointIndex));
  };
  onEOSPointClick('ev-plot', handler);
  onEOSPointClick('pv-plot', handler);
}

/**
 * Feed a potential-computed scan (runEOSScan result, sorted by volume) into
 * the panel as if a file had been loaded. Computed data is already in
 * eV / GPa / Å³, so the unit selectors are reset to those (a leftover user
 * unit choice must not rescale calculator output). The dataset takes the
 * detectColumns shape so fitAndDisplay runs unchanged, the scan becomes a
 * file-browser row, and plot clicks map points to its frames. Exported
 * separately from the Compute button so tests can drive it with a synthetic
 * scan (no wasm).
 */
export async function ingestComputedScan(scan, { potential = general.atomisticPotential || 'nep' } = {}) {
  const container = document.getElementById('cvPanelBody-eos');
  if (!container) throw new Error('EOS panel is not built — expand it first.');
  if (!scan || !Array.isArray(scan.volumes) || scan.volumes.length < 3) {
    throw new Error('EOS scan needs at least 3 points to fit.');
  }

  state.units = { energy: 'eV', pressure: 'GPa', volume: 'Å³' };
  for (const [id, value] of [['#eosEnergyUnits', 'eV'], ['#eosPressureUnits', 'GPa'], ['#eosVolumeUnits', 'Å³']]) {
    const sel = container.querySelector(id);
    if (sel) sel.value = value;
  }

  state.originalColumnData = {
    volumes: [...scan.volumes],
    energies: [...scan.energies],
    pressures: [...scan.pressures],
    columnInfo: { p: 2, e: 1, v: 0, headers: null, hasHeaders: false, hasEnergy: true },
  };
  state.computedStructures = Array.isArray(scan.structures) && scan.structures.length
    ? scan.structures
    : null;

  const info = container.querySelector('.eos-column-info');
  if (info) {
    info.textContent = `Computed from potential (${potential}): ${scan.volumes.length} points`
      + (state.computedStructures ? ' — click a plot point to view its structure.' : '');
  }

  if (state.computedStructures) registerScanRow(scan, potential);
  wireComputedPointClicks();
  await fitAndDisplay(container);
}

async function runComputeFromPotential(container) {
  if (computeRunning) return;
  const q = (sel) => container.querySelector(sel);
  const nPoints = Math.max(3, Math.min(21, parseInt(q('#eosComputePoints').value, 10) || 7));
  // `|| default` would turn a typed 0 GPa into the default — check finiteness.
  const pMinRaw = parseFloat(q('#eosComputePMin').value);
  const pMaxRaw = parseFloat(q('#eosComputePMax').value);
  const pMinGPa = Number.isFinite(pMinRaw) ? pMinRaw : -2;
  const pMaxGPa = Number.isFinite(pMaxRaw) ? pMaxRaw : 20;
  const fmaxTol = parseFloat(q('#eosComputeFmax').value) || 0.01;
  const maxSteps = Math.max(1, parseInt(q('#eosComputeMaxSteps').value, 10) || 200);

  if (pMinGPa >= pMaxGPa) {
    setComputeStatus(container, 'Error: P min must be below P max.');
    return;
  }
  if (!fileBrowser.selectedStructure) {
    setComputeStatus(container, 'Error: no structure loaded.');
    return;
  }

  computeRunning = true;
  computeStopRequested = false;
  /** @type {HTMLButtonElement} */ (q('#eosComputeBtn')).disabled = true;
  /** @type {HTMLButtonElement} */ (q('#eosComputeStopBtn')).disabled = false;

  try {
    const base = snapshotCurrentStructure();
    setComputeStatus(container, 'Preparing calculator…');
    const { runner, potential } = await ensureActiveCalculator((text) => setComputeStatus(container, text));
    const scan = await runEOSScan(runner, base, {
      nPoints, pMinGPa, pMaxGPa, fmaxTol, maxSteps,
      onProgress: (text) => setComputeStatus(container, text),
      shouldStop: () => computeStopRequested,
    });
    if (scan.volumes.length < 3) {
      setComputeStatus(container, `Stopped — only ${scan.volumes.length} point(s) computed, need 3 to fit.`);
      return;
    }
    await ingestComputedScan(scan, { potential });
    const unconverged = scan.converged.filter((c) => !c).length;
    const convergedNote = unconverged ? ` (${unconverged} did not converge)` : '';
    setComputeStatus(container, scan.stopped
      ? `Stopped — fitted the ${scan.volumes.length} completed points${convergedNote}.`
      : `Computed ${scan.volumes.length} points${convergedNote}.`);
  } catch (error) {
    // Everything the scan can throw (unsupported element, calculator init
    // failure, …) surfaces here, not just on the console.
    setComputeStatus(container, `Error: ${error.message || String(error)}`);
    console.error(error);
  } finally {
    computeRunning = false;
    computeStopRequested = false;
    // The panel may have been rebuilt mid-run — re-query, don't trust `q`.
    const live = document.getElementById('cvPanelBody-eos');
    const computeBtn = /** @type {HTMLButtonElement} */ (live?.querySelector('#eosComputeBtn'));
    const stopBtn = /** @type {HTMLButtonElement} */ (live?.querySelector('#eosComputeStopBtn'));
    if (computeBtn) computeBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
  }
}

/** Recompute state.referenceRaw from the raw parsed file using the current
 *  volume divisor (primitive/conventional cell conversion). Pure/sync so
 *  callers can redraw the scatter immediately, without waiting on a re-fit. */
function rescaleReference() {
  if (!state.referenceRawParsed) return;
  const divisor = state.referenceVolumeDivisor > 0 ? state.referenceVolumeDivisor : 1;
  state.referenceRaw = {
    ...state.referenceRawParsed,
    volumes: state.referenceRawParsed.volumes.map((v) => v / divisor),
  };
}

/** Re-fit the reference P-V curve against the current (rescaled) reference
 *  data and redraw. */
async function refitReference(container) {
  if (!state.referenceRawParsed) return;
  // Reference curves render into the P-V plot, which only exists once a
  // primary fit produced something to show.
  if (state.pvResult) ensurePlotsWindowOpen();
  rescaleReference();
  // Move the scatter points immediately (doesn't need a re-fit); the fitted
  // reference curve below catches up once SciPy responds.
  await redraw('pv-plot');
  try {
    setPyodideStatus(container, 'Fitting reference…');
    state.referenceFit = await fitReferencePV(state.referenceRaw.volumes, state.referenceRaw.pressures,
      (text) => setPyodideStatus(container, text));
    await redraw('pv-plot');
    setStatus(container, 'Reference data loaded.');
  } catch (error) {
    setStatus(container, `Error loading reference: ${error.message}`);
    console.error(error);
  }
}

async function handleReferenceFile(container, file) {
  setStatus(container, 'Reading reference file…');
  const text = await file.text();
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  try {
    state.referenceRawParsed = parseReferenceData(lines);
  } catch (error) {
    setStatus(container, `Error loading reference: ${error.message}`);
    console.error(error);
    return;
  }
  await refitReference(container);
}

async function resetReference(container) {
  state.referenceRawParsed = null;
  state.referenceRaw = null;
  state.referenceFit = null;
  state.referenceVolumeDivisor = 1;
  const divisorInput = container.querySelector('#eosRefVolumeDivisor');
  if (divisorInput) divisorInput.value = '1';
  const refFileInput = container.querySelector('#eosRefFileInput');
  if (refFileInput) refFileInput.value = '';
  await redraw('pv-plot');
  setStatus(container, 'Reference data cleared.');
}

/** Click-to-copy on any result value: delegated so it survives the innerHTML
 *  rebuild each time addEOSPanel reruns. */
function wireCopyToClipboard(container) {
  container.addEventListener('click', (e) => {
    const cell = e.target.closest('.eos-copy-value');
    if (!cell) return;
    const text = cell.textContent.trim();
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      cell.classList.add('eos-copied');
      setTimeout(() => cell.classList.remove('eos-copied'), 900);
    }).catch((error) => console.error('Copy failed:', error));
  });
}

function wireDropZone(zone, input, onFile) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('highlight'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('highlight'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('highlight');
    if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
  });
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files.length) onFile(input.files[0]); });
}

export function addEOSPanel(target = 'cvPanelBody-eos') {
  const container = document.getElementById(target);
  if (!container) return;

  container.innerHTML = `
    <div class="control-group eos-units-group">
      <label class="eos-group-label">Input Units (results always shown in Å³ / eV / GPa)</label>
      <div class="eos-unit-list">
        <div class="eos-unit-row">
          <label for="eosEnergyUnits">Energy</label>
          <select id="eosEnergyUnits">
            <option value="eV">eV</option>
            <option value="Ry">Ry</option>
            <option value="Hartree">Hartree</option>
          </select>
        </div>
        <div class="eos-unit-row">
          <label for="eosPressureUnits">Pressure</label>
          <select id="eosPressureUnits">
            <option value="GPa">GPa</option>
            <option value="kBar">kBar</option>
          </select>
        </div>
        <div class="eos-unit-row">
          <label for="eosVolumeUnits">Volume</label>
          <select id="eosVolumeUnits">
            <option value="Å³">Å³</option>
            <option value="Bohr³">Bohr³</option>
          </select>
        </div>
      </div>
    </div>

    <details class="control-group eos-collapsible">
      <summary class="eos-collapsible-summary">
        <span class="eos-collapsible-arrow">▶</span>
        Compute from potential
      </summary>
      <div class="eos-collapsible-body">
        <div class="eos-unit-list">
          <div class="eos-unit-row">
            <label for="eosComputePoints">Points</label>
            <input type="number" id="eosComputePoints" value="7" min="3" max="21" step="1">
          </div>
          <div class="eos-unit-row">
            <label for="eosComputePMin">P min (GPa)</label>
            <input type="number" id="eosComputePMin" value="-2" step="any">
          </div>
          <div class="eos-unit-row">
            <label for="eosComputePMax">P max (GPa)</label>
            <input type="number" id="eosComputePMax" value="20" step="any">
          </div>
          <div class="eos-unit-row">
            <label for="eosComputeFmax">Force tol (eV/Å)</label>
            <input type="number" id="eosComputeFmax" value="0.01" min="0.0001" step="any">
          </div>
          <div class="eos-unit-row">
            <label for="eosComputeMaxSteps">Max relax steps</label>
            <input type="number" id="eosComputeMaxSteps" value="200" min="1" step="1">
          </div>
        </div>
        <div class="eos-primary-actions-row">
          <button type="button" id="eosComputeBtn" class="eos-pane-btn">Compute</button>
          <button type="button" id="eosComputeStopBtn" class="eos-pane-btn" disabled>Stop</button>
        </div>
        <div class="eos-compute-status"></div>
      </div>
    </details>

    <div class="control-group">
      <div class="eos-drop-zone" id="eosDropZone">Drop P/E/V data file here, or click to select</div>
      <input type="file" id="eosFileInput" accept=".txt,.dat,.csv" hidden>
      <div class="eos-column-info"></div>
      <div class="eos-primary-actions-row">
        <button type="button" id="eosResetFitBtn" class="eos-pane-btn">Reset</button>
      </div>
    </div>

    <details class="control-group eos-collapsible">
      <summary class="eos-collapsible-summary">
        <span class="eos-collapsible-arrow">▶</span>
        Reference data
      </summary>
      <div class="eos-collapsible-body">
        <div class="eos-drop-zone eos-drop-zone-ref" id="eosRefDropZone">Drop reference file (P V error), or click to select</div>
        <input type="file" id="eosRefFileInput" accept=".txt,.dat,.csv" hidden>
        <div class="eos-ref-divisor-row">
          <label for="eosRefVolumeDivisor">Divide reference volume by</label>
          <input type="number" id="eosRefVolumeDivisor" value="1" min="0.0001" step="any">
          <button type="button" id="eosRefResetBtn" class="eos-pane-btn">Reset</button>
        </div>
      </div>
    </details>

    <div class="control-group eos-status-group">
      <div class="eos-pyodide-status">Fit engine: SciPy (loads on first fit)</div>
      <div class="eos-status"></div>
    </div>

    <div class="eos-results control-group" hidden>
      <h4>P-V Fit (Birch-Murnaghan)</h4>
      <table class="result-table eos-result-table">
        <tr><th>Parameter</th><th>Value</th></tr>
        <tr><td>V₀</td><td class="eos-copy-value" title="Click to copy" id="eos-pv-V0"></td></tr>
        <tr><td>K₀</td><td class="eos-copy-value" title="Click to copy" id="eos-pv-K0"></td></tr>
        <tr><td>K₀′</td><td class="eos-copy-value" title="Click to copy" id="eos-pv-K0Prime"></td></tr>
      </table>
      <div class="eos-fit-stats">
        RMS Error: <span class="eos-copy-value" title="Click to copy" id="eos-pv-rms"></span><br>
        Max Residual: <span class="eos-copy-value" title="Click to copy" id="eos-pv-maxres"></span><br>
        Points: <span id="eos-pv-points"></span>
      </div>

      <div class="eos-ev-results">
        <h4>E-V Fit (Birch-Murnaghan)</h4>
        <table class="result-table eos-result-table">
          <tr><th>Parameter</th><th>Value</th></tr>
          <tr><td>E₀</td><td class="eos-copy-value" title="Click to copy" id="eos-ev-E0"></td></tr>
          <tr><td>V₀</td><td class="eos-copy-value" title="Click to copy" id="eos-ev-V0"></td></tr>
          <tr><td>K₀</td><td class="eos-copy-value" title="Click to copy" id="eos-ev-K0"></td></tr>
          <tr><td>K₀′</td><td class="eos-copy-value" title="Click to copy" id="eos-ev-K0Prime"></td></tr>
        </table>
        <div class="eos-fit-stats">
          RMS Error: <span class="eos-copy-value" title="Click to copy" id="eos-ev-rms"></span><br>
          Max Residual: <span class="eos-copy-value" title="Click to copy" id="eos-ev-maxres"></span><br>
          Points: <span id="eos-ev-points"></span>
        </div>
      </div>
    </div>
  `;

  const energySel = container.querySelector('#eosEnergyUnits');
  const pressureSel = container.querySelector('#eosPressureUnits');
  const volumeSel = container.querySelector('#eosVolumeUnits');
  energySel.value = state.units.energy;
  pressureSel.value = state.units.pressure;
  volumeSel.value = state.units.volume;

  const onUnitsChange = async () => {
    state.units = { energy: energySel.value, pressure: pressureSel.value, volume: volumeSel.value };
    if (state.originalColumnData) await fitAndDisplay(container);
  };
  energySel.addEventListener('change', onUnitsChange);
  pressureSel.addEventListener('change', onUnitsChange);
  volumeSel.addEventListener('change', onUnitsChange);

  wireDropZone(
    container.querySelector('#eosDropZone'),
    container.querySelector('#eosFileInput'),
    (file) => handlePrimaryFile(container, file),
  );
  container.querySelector('#eosResetFitBtn').addEventListener('click', () => resetFit(container));

  container.querySelector('#eosComputeBtn').addEventListener('click', () => runComputeFromPotential(container));
  container.querySelector('#eosComputeStopBtn').addEventListener('click', () => {
    computeStopRequested = true;
    setComputeStatus(container, 'Stopping…');
  });
  // A rebuild mid-scan must not re-enable Compute (the run is module-level).
  if (computeRunning) {
    /** @type {HTMLButtonElement} */ (container.querySelector('#eosComputeBtn')).disabled = true;
    /** @type {HTMLButtonElement} */ (container.querySelector('#eosComputeStopBtn')).disabled = false;
  }

  wireDropZone(
    container.querySelector('#eosRefDropZone'),
    container.querySelector('#eosRefFileInput'),
    (file) => handleReferenceFile(container, file),
  );

  const refDivisorInput = container.querySelector('#eosRefVolumeDivisor');
  refDivisorInput.value = String(state.referenceVolumeDivisor);
  let refDivisorDebounce = 0;
  // 'input' (not just 'change') so the scatter moves while typing/spinning,
  // not only after blur/Enter; the (slower) re-fit is debounced.
  refDivisorInput.addEventListener('input', () => {
    const value = parseFloat(refDivisorInput.value);
    state.referenceVolumeDivisor = Number.isFinite(value) && value > 0 ? value : 1;
    rescaleReference();
    redraw('pv-plot').catch((error) => console.error(error));
    clearTimeout(refDivisorDebounce);
    refDivisorDebounce = setTimeout(() => refitReference(container), 400);
  });

  container.querySelector('#eosRefResetBtn').addEventListener('click', () => resetReference(container));

  wireCopyToClipboard(container);

  setRedrawHandler(redraw);

  // Re-populate the panel from already-loaded data (e.g. re-expanding after a
  // structure switch rebuilt this panel's body).
  if (state.pvResult) {
    updateResultsUI(container);
    setPlotVisible('ev-plot', !!state.evResult);
    if (state.evResult) safeRedraw('ev-plot');
    safeRedraw('pv-plot');
  }
}

export function removeEOSPanel() {
  // Fit data intentionally persists in module state across rebuilds (e.g. a
  // structure switch): the EOS dataset is independent of the loaded crystal
  // structure, so there is nothing structure-specific to tear down here.
}
