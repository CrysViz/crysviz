// EOS (Birch-Murnaghan equation-of-state) fitting control panel: reads a
// Pressure/Energy/Volume dataset, fits it with SciPy (via Pyodide) and shows
// the fit parameters; the E-V/P-V plots themselves live in the split view
// (EOSSplitView.js) on the right side of the screen.

import { CONVERSION_FACTORS, detectColumns, parseReferenceData, formatParam } from '../eos/eosMath.js';
import { fitEOS, fitReferencePV } from '../eos/eosFit.js';
import { plotEV, plotPV, clearPlot } from '../eos/eosPlots.js';
import { setRedrawHandler, setPlotVisible, getShowErrorPlots } from './EOSSplitView.js';

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
};

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

function isPlotExpanded(plotId) {
  return !!document.getElementById(`${plotId}-wrapper`)?.classList.contains('expanded');
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
  const fileInput = container.querySelector('#eosFileInput');
  if (fileInput) fileInput.value = '';
  const info = container.querySelector('.eos-column-info');
  if (info) info.innerHTML = '';
  container.querySelector('.eos-results').hidden = true;
  setPlotVisible('ev-plot', false);
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
    if (state.evResult) redraw('ev-plot').catch((error) => console.error(error));
    redraw('pv-plot').catch((error) => console.error(error));
  }
}

export function removeEOSPanel() {
  // Fit data intentionally persists in module state across rebuilds (e.g. a
  // structure switch): the EOS dataset is independent of the loaded crystal
  // structure, so there is nothing structure-specific to tear down here.
}
