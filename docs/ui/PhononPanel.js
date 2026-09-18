// Phonon controls window ('phonon', main dock): load phonopy output, pick a
// mode (from the band plot in the Phonon Plots window, or from the list of
// imaginary modes here), animate it in the 3D viewer, and map the potential
// energy along the frozen mode with the in-browser potential — the ModeMap
// workflow (Skelton et al.) done live, with the displaced structures
// exportable as a POSCAR set for DFT. State lives in phonon/phononSession.js;
// the plots live in ui/PhononPlotsPanel.js, which this module opens whenever
// there is something to show.

import {
  phononState, onPhononChange, setOpenWindowsHook, setDims, suggestedDims,
  selectMode, clearMode, play, pause, stopAnimation, setAmplitude, setSpeed, setArgument,
  setShowArrows, setArrowScale, setArrowColor, imaginaryModes, selectedFrequency, selectedQPoint,
  qLabel, setModeMap, selectedEigenvector, setLengthUnit, effectiveLengthUnit,
  setQConvention, setEnergyPerAtom, adoptContainer, setArrowColorMap, setArrowRadius, setArrowLengthLog,
  setArrowRange, setArrowColorScale, arrowMagnitudes,
} from '../phonon/phononSession.js';
import { createColorSwatch } from './SwatchColorPicker.js';
import { isExperimentalMode } from '../debug/experimentalMode.js';
import { createColorBar } from './ColorBarWidget.js';
import { registerColorBarSource } from './ColorBarRegistry.js';
import { computeAutoRange } from '../utils/index.js';
import { isScalarArrowMap } from '../render/PhononArrowModule.js';
import { runModeMapScan, frozenGeometries, speciesToTypes } from '../phonon/modeMapScan.js';
import { fitPolynomial, analyzeFit, amplitudeGrid, thzToOmega2 } from '../phonon/modeMapFit.js';
import {
  toPOSCAR, qToPhonopyAmplitudeFactor, buildSupercell, modePattern, isCommensurate, commensurateDims,
  frozenDisplacement, maxDisplacement,
} from '../phonon/phononMath.js';
import { buildZip } from '../utils/zipWriter.js';
import { openPanel } from './panels/PanelManager.js';
import { setModeMapClickHandler, setModeMapCardHidden } from './PhononPlotsPanel.js';
import { ensureCalculatorRunner } from './BackendPanel/AtomisticPanels.js';
import { createRow, updateRow, selectStructure } from './FileBrowswerPanel.js';
import { initializeUIOnLoad } from './StructureInputModule.js';
import { downloadBlob } from './SavePanel.js';
import { Structure, Atom, Force, StructureContainer, TrajectoryContainer } from '../model/index.js';
import { structureShip, general } from '../state/store.js';
import { generateID } from '../utils/UUIDModule.js';

setOpenWindowsHook(() => {
  openPanel('phonon');
  openPanel('phononPlots');
});

// Mode-map run state is module-level (like the EOS scan) so a panel rebuild
// mid-run cannot start a second concurrent run.
let scanRunning = false;
let scanStopRequested = false;
let scanRow = null; // the file-browser <tr> holding the last scan's frames
let unsubscribe = null;
// The Q range follows the selected mode (a fixed default is meaningless: for
// a 40-atom cell Q = 2 amu^½·Å is a ~0.05 Å ripple, for a 1-atom cell a
// 2 Å catastrophe) until the user types a range of their own.
let qRangeTouched = false;
/** The auto range for a STABLE mode: harmonic energy ½ω²Q² of this much per
 *  atom at Q max — comfortably harmonic, which is what makes the fitted
 *  frequency comparable with phonopy's. */
const AUTO_RANGE_MEV_PER_ATOM = 1;
/** …never displacing any atom more than this (Å), whatever the frequency. */
const AUTO_RANGE_MAX_DISP = 0.5;
/** For an IMAGINARY mode the auto range is probed on Compute: starting where
 *  the inverted parabola is this deep per atom, Q doubles until the energy
 *  comes back above E(0), which brackets the well. */
const PROBE_START_MEV_PER_ATOM = 0.02;
const PROBE_MAX_DOUBLINGS = 14;


function q(container, sel) { return container.querySelector(sel); }
function setText(container, sel, text) { const el = q(container, sel); if (el) el.textContent = text; }
function fmt(v, digits = 3) { return Number.isFinite(v) ? Number(v).toFixed(digits) : '–'; }

// ---------------------------------------------------------------------------
// Frames / rows
// ---------------------------------------------------------------------------

function makeFrame(sc, frac, energy, forces) {
  const elements = [...sc.species];
  const structure = new Structure({
    elements,
    lattice: sc.lattice.map((row) => [...row]),
    atoms: frac.map((f, i) => new Atom({ position: [...f], element: elements[i], uuid: generateID([elements[i]]) })),
    forces: Array.isArray(forces) ? forces.map((v) => new Force({ vector: [...v] })) : [],
    periodic: { hash: 'None', wrapped: null },
  });
  structure.energy = Number.isFinite(energy) ? energy : null;
  return structure;
}

function modeTag() {
  const sel = phononState.selected;
  return sel ? `q${sel.iq + 1}b${sel.ib + 1}` : 'mode';
}

/** Register (or replace, on a re-run) the scan frames as one trajectory row. */
function registerScanRow(frames, potential, dims) {
  const tbody = document.querySelector('#objectTable tbody');
  if (!tbody) return null;
  const name = `modemap_${potential}_${phononState.sourceName}_${modeTag()}_${dims.join('x')}`;
  if (scanRow && scanRow.isConnected) {
    const rowIndex = Array.from(scanRow.parentElement.children).indexOf(scanRow);
    if (structureShip.container[rowIndex]) {
      const rebuilt = TrajectoryContainer.fromStructures(name, frames);
      adoptContainer(rebuilt);
      structureShip.container[rowIndex] = rebuilt;
      updateRow(scanRow, { name, traj: frames.length, step: 1 });
      return scanRow;
    }
  }
  const container = TrajectoryContainer.fromStructures(name, frames);
  adoptContainer(container);
  structureShip.container.push(container);
  scanRow = createRow({ name, traj: frames.length, step: 1 });
  tbody.appendChild(scanRow);
  return scanRow;
}

setModeMapClickHandler((index) => {
  if (!scanRow || !scanRow.isConnected) return;
  const rowIndex = Array.from(scanRow.parentElement.children).indexOf(scanRow);
  selectStructure(rowIndex, index);
});

// ---------------------------------------------------------------------------
// Mode map
// ---------------------------------------------------------------------------

function readScanSettings(container) {
  const num = (sel, fallback) => {
    const v = parseFloat(/** @type {HTMLInputElement} */ (q(container, sel))?.value);
    return Number.isFinite(v) ? v : fallback;
  };
  let qMin = num('#phQMin', -2);
  let qMax = num('#phQMax', 2);
  if (qMin > qMax) [qMin, qMax] = [qMax, qMin];
  if (qMin === qMax) qMax = qMin + 1;
  const nPoints = Math.max(3, Math.min(201, Math.round(num('#phQPoints', 15))));
  const degreeRaw = /** @type {HTMLSelectElement} */ (q(container, '#phFitDegree'))?.value ?? 'auto';
  const degree = degreeRaw === 'auto' ? 'auto' : Math.max(2, Math.min(12, Math.round(Number(degreeRaw) || 4)));
  const evenOnly = /** @type {HTMLInputElement} */ (q(container, '#phFitEven'))?.checked !== false;
  return { qMin, qMax, nPoints, degree, evenOnly, dims: readScanDims(container) };
}

/** The mode map's own supercell: the smallest one periodic for the selected
 *  q while "auto" is on, else what the user typed. Independent of the
 *  supercell shown in the viewer — a scan of a 4×4×1 zone-boundary mode does
 *  not need 64 atoms on screen. */
function readScanDims(container) {
  const auto = /** @type {HTMLInputElement} */ (q(container, '#phScanDimsAuto'))?.checked !== false;
  const qp = selectedQPoint();
  if (auto && qp) return commensurateDims(qp.q);
  const dims = ['#phScanDim1', '#phScanDim2', '#phScanDim3'].map((sel) => {
    const v = parseInt(/** @type {HTMLInputElement} */ (q(container, sel))?.value, 10);
    return Number.isFinite(v) ? Math.min(12, Math.max(1, v)) : 1;
  });
  return dims;
}

/**
 * The supercell + frozen pattern a scan / export works on, built from the mode
 * map's own supercell inputs. Null without a selected mode with eigenvectors.
 */
function scanContext(container) {
  const qp = selectedQPoint();
  const eig = selectedEigenvector();
  const cell = phononState.dataset?.cell;
  if (!qp || !eig || !cell) return null;
  const dims = readScanDims(container);
  const sc = buildSupercell(cell, dims);
  const pattern = modePattern(sc, qp.q, eig, phononState.argumentDeg);
  // A (phonopy MODULATION amplitude) = Q · phonopyFactor.
  const phonopyFactor = qToPhonopyAmplitudeFactor(pattern, sc.masses);
  return { dims, sc, pattern, phonopyFactor, commensurate: isCommensurate(qp.q, dims) };
}

/** Q-range inputs are typed in the selected convention; the scan runs in Q. */
function inputToQ(value, ctx) {
  return phononState.qConvention === 'phonopy' && ctx?.phonopyFactor > 0 ? value / ctx.phonopyFactor : value;
}
function qToInput(Q, ctx) {
  return phononState.qConvention === 'phonopy' && ctx?.phonopyFactor > 0 ? Q * ctx.phonopyFactor : Q;
}
function qUnitLabel() {
  return phononState.qConvention === 'phonopy' ? 'A' : 'Q';
}

/** Largest atomic displacement (Å) at Q = 1 for the scan's supercell/pattern. */
function dispPerQ(ctx) {
  if (!ctx) return NaN;
  return maxDisplacement(frozenDisplacement(ctx.pattern, ctx.sc.masses, 1, new Float64Array(ctx.sc.natom * 3)));
}

/** Round to two significant digits (for a readable auto range). */
function round2sig(x) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x) - 1);
  return Math.round(x / p) * p;
}

/** Q at which the harmonic energy ½|ω²|Q² equals `mevPerAtom` per atom of the
 *  scan supercell (NaN when the mode is too soft to say). */
function harmonicQ(ctx, mevPerAtom) {
  const f = selectedFrequency();
  if (!(Math.abs(f) > 0.1)) return NaN;
  return Math.sqrt((2 * mevPerAtom * 1e-3 * ctx.sc.natom) / Math.abs(thzToOmega2(f)));
}

/** Static auto range (before any energy is computed): harmonic-energy
 *  criterion, capped by the displacement cap. The well of an imaginary mode
 *  is usually far inside this; Compute probes for it (probeWellRange). */
function staticAutoQMax(ctx) {
  const d = dispPerQ(ctx);
  const byDisp = d > 0 ? AUTO_RANGE_MAX_DISP / d : NaN;
  const byEnergy = harmonicQ(ctx, AUTO_RANGE_MEV_PER_ATOM);
  const qMax = Number.isFinite(byEnergy) ? Math.min(byEnergy, byDisp) : byDisp;
  return qMax > 0 ? qMax : NaN;
}

function setQRangeInputs(container, qMax, ctx) {
  const v = round2sig(qToInput(qMax, ctx));
  /** @type {HTMLInputElement} */ (q(container, '#phQMin')).value = String(-v);
  /** @type {HTMLInputElement} */ (q(container, '#phQMax')).value = String(v);
}

function autoQRange(container, ctx) {
  const qMax = staticAutoQMax(ctx);
  if (qMax > 0) setQRangeInputs(container, qMax, ctx);
}

/**
 * Bracket the well of an imaginary mode with a few single points: from a Q
 * where the inverted parabola is PROBE_START_MEV_PER_ATOM deep, double Q until
 * E(Q) rises back above E(0). Returns the Q max to scan (a little past the
 * crossing) or null when no crossing was found within the displacement cap.
 */
async function probeWellRange(runner, ctx, onProgress) {
  const { sc, pattern } = ctx;
  const types = speciesToTypes(runner, sc.species);
  const lattice = sc.lattice.map((row) => [...row]);
  const energyAt = async (Q) => {
    const [g] = frozenGeometries(sc, pattern, [Q]);
    const out = await runner.compute({ lattice, positions: g.positions, types });
    return Number(out.total_energy);
  };
  const e0 = await energyAt(0);
  const d = dispPerQ(ctx);
  const qCap = d > 0 ? AUTO_RANGE_MAX_DISP / d : Infinity;
  let Q = harmonicQ(ctx, PROBE_START_MEV_PER_ATOM);
  if (!(Q > 0)) return null;
  let lastBelow = 0;
  for (let k = 0; k < PROBE_MAX_DOUBLINGS && Q <= qCap; k++) {
    const dE = await energyAt(Q) - e0;
    onProgress(`probing the well: Q = ${Q.toPrecision(3)}, ΔE = ${(dE * 1000).toFixed(2)} meV`);
    if (dE > 0) {
      // Crossed back above the reference between lastBelow and Q: the minimum
      // lies in between; scan a little past the crossing.
      return Q * 1.15;
    }
    lastBelow = Q;
    Q *= 2;
  }
  return lastBelow > 0 ? Math.min(lastBelow * 2, qCap) : null;
}

function currentQGrid(container, ctx) {
  const mm = phononState.modeMap;
  if (mm && mm.Q?.length) return mm.Q.slice();
  const s = readScanSettings(container);
  return amplitudeGrid(inputToQ(s.qMin, ctx), inputToQ(s.qMax, ctx), s.nPoints);
}

function setScanStatus(container, text) { setText(container, '.ph-scan-status', text); }

function updateScanUI(container) {
  const mm = phononState.modeMap;
  const results = q(container, '.ph-scan-results');
  if (!results) return;
  results.hidden = !mm;
  const exportBtn = /** @type {HTMLButtonElement} */ (q(container, '#phExportBtn'));
  if (exportBtn) exportBtn.disabled = !phononState.pattern;
  // Supercell inputs follow the selected mode while "auto" is on.
  const auto = /** @type {HTMLInputElement} */ (q(container, '#phScanDimsAuto'));
  const dims = readScanDims(container);
  ['#phScanDim1', '#phScanDim2', '#phScanDim3'].forEach((sel, k) => {
    const inp = /** @type {HTMLInputElement} */ (q(container, sel));
    if (!inp) return;
    inp.disabled = !!auto?.checked;
    if (auto?.checked || document.activeElement !== inp) inp.value = String(dims[k]);
  });
  const qp = selectedQPoint();
  const natom = phononState.dataset ? phononState.dataset.natom * dims[0] * dims[1] * dims[2] : 0;
  setText(container, '#phScanDimsNote', qp
    ? `${natom} atoms${isCommensurate(qp.q, dims) ? '' : ' — not periodic for this q'}`
    : '');
  const ctx = scanContext(container);
  if (ctx && !qRangeTouched) autoQRange(container, ctx);
  const d = dispPerQ(ctx);
  const vMaxNow = Math.max(Math.abs(parseFloat(/** @type {HTMLInputElement} */ (q(container, '#phQMin'))?.value) || 0),
    Math.abs(parseFloat(/** @type {HTMLInputElement} */ (q(container, '#phQMax'))?.value) || 0));
  const qMaxNow = inputToQ(vMaxNow, ctx);
  const other = ctx && phononState.qConvention === 'phonopy'
    ? ` (Q = ${qMaxNow.toFixed(3)})`
    : (ctx ? ` (phonopy amplitude ${qToInput(qMaxNow, ctx).toFixed(3)})` : '');
  const autoNote = !qRangeTouched
    ? (selectedFrequency() < -0.05 ? ' · auto: Compute first probes for the well and adjusts the range' : ' · auto: harmonic-energy range')
    : '';
  setText(container, '#phQNote', d > 0 && vMaxNow > 0
    ? `at |${qUnitLabel()}| = ${vMaxNow}${other} the largest atom displacement is ${(d * qMaxNow).toFixed(3)} Å${autoNote}`
    : '');
  const convSel = /** @type {HTMLSelectElement} */ (q(container, '#phQConvention'));
  if (convSel) convSel.value = phononState.qConvention;
  const perAtom = /** @type {HTMLInputElement} */ (q(container, '#phPerAtom'));
  if (perAtom) perAtom.checked = phononState.energyPerAtom;
  const minBtn = /** @type {HTMLButtonElement} */ (q(container, '#phLoadMinBtn'));
  if (minBtn) minBtn.disabled = !(mm?.analysis?.isDoubleWell || mm?.dataMinimum?.offCentre);
  if (!mm) return;
  const an = mm.analysis;
  const conv = phononState.qConvention === 'phonopy' && mm.phonopyFactor > 0
    ? { label: 'A', scale: mm.phonopyFactor } : { label: 'Q', scale: 1 };
  const eScale = phononState.energyPerAtom && mm.supercell?.natom ? 1000 / mm.supercell.natom : 1000;
  const eUnit = phononState.energyPerAtom ? 'meV/atom' : 'meV';
  setText(container, '#ph-res-potential', `${mm.potential} · ${mm.dims.join('×')} supercell (${mm.supercell?.natom ?? '?'} atoms)`);
  setText(container, '#ph-res-points', `${mm.Q.length} (${conv.label} ${fmt(Math.min(...mm.Q) * conv.scale, 2)} … ${fmt(Math.max(...mm.Q) * conv.scale, 2)})`);
  setText(container, '#ph-res-wfit', `${fmt(an.frequencyTHz)} THz`);
  setText(container, '#ph-res-wph', `${fmt(mm.phononFreq)} THz`);
  setText(container, '#ph-res-rms', mm.fit ? `${(mm.fit.rms * 1000).toFixed(3)} meV (order ${Math.max(...mm.fit.powers)}${mm.settings?.degree === 'auto' ? ', auto' : ''})` : '–');
  const mins = an.minima.filter((m) => m.depth > 1e-9);
  setText(container, '#ph-res-minima', mins.length
    ? mins.map((m) => `${conv.label} = ${fmt(m.Q * conv.scale)} (ΔE = ${(-m.depth * eScale).toFixed(3)} ${eUnit})`).join('; ')
    : an.isDoubleWell ? '–' : 'none inside the scanned range (single well)');
  const dm = mm.dataMinimum;
  setText(container, '#ph-res-datamin', dm
    ? (dm.offCentre
      ? `${conv.label} = ${fmt(dm.Q * conv.scale)}: ${(-dm.depth * eScale).toFixed(3)} ${eUnit} below ${conv.label} = 0 (computed point, not the fit)`
      : `${conv.label} = 0 is the lowest computed point`)
    : '–');
  let shape = an.isDoubleWell
    ? `double well — barrier ${(an.barrier * eScale).toFixed(3)} ${eUnit} above the minima`
    : 'single well (harmonic-like)';
  const eRange = Math.max(...mm.energies) - Math.min(...mm.energies);
  if (mm.fit && eRange > 0 && mm.fit.rms > 0.05 * eRange) {
    shape = `poor fit (rms ${(mm.fit.rms * 1000).toFixed(1)} meV against a ${(eRange * 1000).toFixed(0)} meV range) — the polynomial does not describe these points; ${shape}`;
  }
  if (dm?.atEdge) {
    shape += ' — the energy is still falling at the edge of the range: widen it.';
  } else if (dm?.offCentre && !an.isDoubleWell) {
    shape += ' — but a computed point lies below Q = 0: the polynomial is missing the well. Zoom to the minimum or raise the fit order.';
  }
  setText(container, '#ph-res-shape', shape);
  const zoomBtn = /** @type {HTMLButtonElement} */ (q(container, '#phZoomMinBtn'));
  if (zoomBtn) zoomBtn.disabled = !(dm?.offCentre || mins.length);
}

async function runScan(container) {
  if (scanRunning) return;
  const ctx = scanContext(container);
  if (!ctx) {
    setScanStatus(container, 'Select a mode with eigenvectors first (click a point in the band plot).');
    return;
  }
  const { sc, pattern } = ctx;
  const settings = readScanSettings(container);
  scanRunning = true;
  scanStopRequested = false;
  /** @type {HTMLButtonElement} */ (q(container, '#phScanBtn')).disabled = true;
  /** @type {HTMLButtonElement} */ (q(container, '#phScanStopBtn')).disabled = false;
  try {
    stopAnimation();
    setScanStatus(container, ctx.commensurate
      ? `Preparing calculator (${ctx.dims.join('×')} supercell, ${sc.natom} atoms)…`
      : `Warning: q is not periodic in the ${ctx.dims.join('×')} supercell — the frozen pattern is not periodic. Preparing calculator…`);
    const { runner, potential } = await ensureCalculatorRunner((text) => setScanStatus(container, text));
    let qMin = inputToQ(settings.qMin, ctx);
    let qMax = inputToQ(settings.qMax, ctx);
    if (!qRangeTouched && selectedFrequency() < -0.05) {
      const probed = await probeWellRange(runner, ctx, (text) => setScanStatus(container, text));
      if (scanStopRequested) { setScanStatus(container, 'Stopped.'); return; }
      if (probed > 0) {
        qMin = -probed;
        qMax = probed;
        setQRangeInputs(container, probed, ctx);
      }
    }
    const Qs = amplitudeGrid(qMin, qMax, settings.nPoints);
    const scan = await runModeMapScan(runner, sc, pattern, Qs, {
      onProgress: (text) => setScanStatus(container, text),
      shouldStop: () => scanStopRequested,
    });
    if (scan.Q.length < 3) {
      setScanStatus(container, `Stopped — only ${scan.Q.length} point(s) computed, need 3 to fit.`);
      return;
    }
    ingestScan(scan, { potential, settings, supercell: sc, pattern, dims: ctx.dims, phonopyFactor: ctx.phonopyFactor });
    setScanStatus(container, scan.stopped
      ? `Stopped — fitted the ${scan.Q.length} completed points.`
      : `Computed ${scan.Q.length} points with ${potential}.`);
  } catch (error) {
    setScanStatus(container, `Error: ${error.message || String(error)}`);
    console.error(error);
  } finally {
    scanRunning = false;
    scanStopRequested = false;
    const live = document.getElementById('cvPanelBody-phonon');
    const runBtn = /** @type {HTMLButtonElement} */ (live?.querySelector('#phScanBtn'));
    const stopBtn = /** @type {HTMLButtonElement} */ (live?.querySelector('#phScanStopBtn'));
    if (runBtn) runBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
  }
}

/**
 * Fit at a fixed order, or ('auto') the lowest even order from 4 to 10 whose
 * rms residual is under 1 % of the energy range — a double well with a steep
 * anharmonic wall is badly served by a quartic, which flattens the well.
 */
function fitWithOrder(Q, E, degree, evenOnly) {
  if (degree !== 'auto') return fitPolynomial(Q, E, { degree, evenOnly });
  const range = Math.max(...E) - Math.min(...E);
  let best = null;
  for (const deg of [4, 6, 8, 10]) {
    const terms = evenOnly ? deg / 2 + 1 : deg + 1;
    if (Q.length < terms + 2) break;
    const fit = fitPolynomial(Q, E, { degree: deg, evenOnly });
    if (!best || fit.rms < best.rms) best = fit;
    if (fit.rms <= 0.01 * range) return fit;
  }
  return best || fitPolynomial(Q, E, { degree: 4, evenOnly });
}

/**
 * Turn a scan (runModeMapScan result) into the fitted mode map: polynomial
 * fit + analysis, a trajectory row of the displaced frames, and the plot.
 * Exported so the browser test can drive it with a synthetic potential.
 */
export function ingestScan(scan, {
  potential = general.atomisticPotential || 'nep', settings = null,
  supercell = phononState.supercell, pattern = phononState.pattern, dims = phononState.dims,
  phonopyFactor = null,
} = {}) {
  const container = document.getElementById('cvPanelBody-phonon');
  const s = settings || (container ? readScanSettings(container) : { degree: 'auto', evenOnly: true });
  const sc = supercell;
  if (!sc || !pattern) throw new Error('No mode selected.');
  let fit = null;
  let analysis = null;
  try {
    fit = fitWithOrder(scan.Q, scan.energies, s.degree, s.evenOnly);
    analysis = analyzeFit(fit, Math.min(...scan.Q), Math.max(...scan.Q));
  } catch (error) {
    console.error(error);
  }
  // Reference energy: the Q = 0 point when it was computed, else the fit's value there.
  let i0 = -1;
  let best = Infinity;
  scan.Q.forEach((Q, i) => { if (Math.abs(Q) < best) { best = Math.abs(Q); i0 = i; } });
  const reference = best < 1e-9 ? scan.energies[i0] : (fit ? fit.evaluate(0) : scan.energies[i0]);
  // The lowest COMPUTED point, independent of any fit: the fit can miss a
  // narrow well when the scanned range is much wider than the well.
  let iMin = 0;
  scan.energies.forEach((e, i) => { if (e < scan.energies[iMin]) iMin = i; });
  const dataMinimum = {
    Q: scan.Q[iMin], energy: scan.energies[iMin], depth: reference - scan.energies[iMin],
    offCentre: Math.abs(scan.Q[iMin]) > 1e-9 && reference - scan.energies[iMin] > 1e-6,
    atEdge: (iMin === 0 || iMin === scan.Q.length - 1) && reference - scan.energies[iMin] > 1e-6,
  };

  const frames = scan.fracs.map((frac, i) => makeFrame(sc, frac, scan.energies[i], scan.forces?.[i]));
  registerScanRow(frames, potential, dims);

  const sel = phononState.selected;
  const qp = selectedQPoint();
  setModeMap({
    Q: scan.Q.slice(), energies: scan.energies.slice(), maxDisp: scan.maxDisp.slice(), fracs: scan.fracs,
    fit, analysis, reference, potential, dataMinimum,
    phononFreq: selectedFrequency(),
    mode: sel ? { iq: sel.iq, ib: sel.ib, q: qp.q.slice(), label: qLabel(sel.iq) } : null,
    dims: dims.slice(),
    supercell: sc,
    pattern,
    phonopyFactor: phonopyFactor ?? qToPhonopyAmplitudeFactor(pattern, sc.masses),
    settings: { degree: s.degree, evenOnly: s.evenOnly },
  });
  if (container) updateScanUI(container);
  setModeMapCardHidden(false);
  openPanel('phononPlots');
  return phononState.modeMap;
}

/** Narrow the Q range to ±2.5× the deepest minimum (fit, else data) so the
 *  next Compute resolves the well instead of the walls. */
function zoomToMinimum(container) {
  const mm = phononState.modeMap;
  if (!mm) return;
  const mins = mm.analysis?.minima?.filter((m) => m.depth > 1e-9) ?? [];
  const cand = mins.length ? mins.reduce((a, b) => (b.depth > a.depth ? b : a)) : (mm.dataMinimum?.offCentre ? mm.dataMinimum : null);
  if (!cand) return;
  const ctx = scanContext(container);
  // 1.8× the minimum: for a quartic double well the wall there is ~4× the
  // depth (at 2.5× it would be ~27×, and the fit would again see mostly wall).
  const qMax = 1.8 * Math.abs(cand.Q);
  qRangeTouched = true;
  const v = Number(qToInput(qMax, ctx).toPrecision(3));
  /** @type {HTMLInputElement} */ (q(container, '#phQMin')).value = String(-v);
  /** @type {HTMLInputElement} */ (q(container, '#phQMax')).value = String(v);
  updateScanUI(container);
  setScanStatus(container, `Range set to ±${v} around the minimum — Compute again to resolve the well.`);
}

function loadMinimumStructure(container) {
  const mm = phononState.modeMap;
  const sc = mm?.supercell;
  const pattern = mm?.pattern;
  if (!mm?.analysis || !sc || !pattern) return;
  const mins = mm.analysis.minima.filter((m) => m.depth > 1e-9);
  // Prefer the fitted minimum; fall back to the lowest computed point when the
  // fit missed the well (see updateScanUI's disagreement note).
  const candidates = mins.length ? mins : (mm.dataMinimum?.offCentre ? [mm.dataMinimum] : []);
  if (!candidates.length) { setScanStatus(container, 'No off-centre minimum in the scanned range.'); return; }
  const deepest = candidates.reduce((a, b) => (b.depth > a.depth ? b : a));
  const [g] = frozenGeometries(sc, pattern, [deepest.Q]);
  const frame = makeFrame(sc, g.frac, mm.reference - deepest.depth, null);
  const name = `phonon_min_${phononState.sourceName}_${modeTag()}_Q${deepest.Q.toFixed(2)}`;
  const minContainer = new StructureContainer({ fileName: name, structures: [frame] });
  adoptContainer(minContainer);
  initializeUIOnLoad(minContainer);
  setScanStatus(container, `Loaded the Q = ${deepest.Q.toFixed(3)} minimum as "${name}" — relax it from the Atomistic window.`);
}

function exportStructures(container) {
  // A computed map exports exactly the geometries it computed; otherwise the
  // mode map's supercell inputs and Q range describe the set.
  const mm = phononState.modeMap;
  const ctx = mm?.supercell && mm.pattern ? { sc: mm.supercell, pattern: mm.pattern, dims: mm.dims } : scanContext(container);
  if (!ctx) return;
  const { sc, pattern, dims } = ctx;
  const Qs = currentQGrid(container, ctx);
  const geometries = frozenGeometries(sc, pattern, Qs);
  const qp = selectedQPoint();
  const freq = selectedFrequency();
  const factor = qToPhonopyAmplitudeFactor(pattern, sc.masses);
  const pad = (i) => String(i).padStart(3, '0');
  const stamp = new Date().toISOString();
  const entries = [];
  const csv = [
    ['index', 'Q_amu^0.5_A', 'phonopy_MODULATION_amplitude', 'max_displacement_A']
      .concat(mm ? ['energy_eV', 'dE_meV'] : []).join(','),
  ];
  geometries.forEach((g, i) => {
    const file = `POSCAR-${pad(i)}`;
    const comment = `${phononState.sourceName} mode ${modeTag()} q=(${qp.q.join(', ')}) ${fmt(freq)} THz  Q=${g.Q.toFixed(6)} amu^0.5 A  ${stamp}`;
    entries.push({ name: `structures/${file}`, data: toPOSCAR(comment, sc.lattice, sc.species, g.frac) });
    const row = [i, g.Q.toFixed(6), (g.Q * factor).toFixed(6), g.maxDisp.toFixed(6)];
    if (mm) {
      const k = mm.Q.findIndex((v) => Math.abs(v - g.Q) < 1e-12);
      row.push(k >= 0 ? mm.energies[k].toFixed(8) : '', k >= 0 ? ((mm.energies[k] - mm.reference) * 1000).toFixed(4) : '');
    }
    csv.push(row.join(','));
  });
  entries.push({ name: 'mode_map.csv', data: csv.join('\n') + '\n' });
  const readme = [
    `CrysViz phonon mode map — ${stamp}`,
    '',
    `source file      : ${phononState.dataset?.fileName ?? ''}`,
    `q-point          : ${qLabel(phononState.selected.iq)} (index ${phononState.selected.iq + 1}, reduced coordinates of the primitive reciprocal lattice)`,
    `band             : ${phononState.selected.ib + 1}`,
    `frequency        : ${fmt(freq, 6)} THz (negative = imaginary)`,
    `supercell        : ${dims.join(' x ')} of the primitive cell (${sc.natom} atoms)`,
    `length unit      : Å (cell read as ${effectiveLengthUnit()} from the phonopy file)`,
    `phase argument   : ${phononState.argumentDeg} deg`,
    mm ? `potential        : ${mm.potential}` : 'potential        : (no energies computed — structures only)',
    '',
    'Displacement of supercell atom j:',
    '  u_j = Q * Re[ e_p(j) / sqrt(m_p(j)) * exp(2 pi i q . r_j) * phase ] / sqrt( sum_k m_k |Re[...]_k|^2 )',
    'so that sum_j m_j |u_j|^2 = Q^2 exactly and a harmonic mode has U(Q) = 1/2 omega^2 Q^2.',
    'The phase is fixed as in phonopy MODULATION (largest element real, rotated by the argument).',
    'The phonopy_MODULATION_amplitude column is the equivalent amplitude for the MODULATION tag,',
    'which normalises by sqrt(N_atoms) instead (u = A * Re[...] / sqrt(N)).',
    '',
    'structures/POSCAR-### : displaced supercells, one per Q in mode_map.csv (Direct coordinates, wrapped to [0,1)).',
    'mode_map.csv          : index, Q, equivalent phonopy amplitude, largest atomic displacement' + (mm ? ', energy from the potential, energy relative to Q=0.' : '.'),
    mm && mm.fit ? `fit                   : polynomial powers [${mm.fit.powers.join(', ')}], coefficients [${mm.fit.coefficients.map((c) => c.toExponential(6)).join(', ')}] eV/(amu^0.5 A)^p; omega_fit = ${fmt(mm.analysis.frequencyTHz, 6)} THz` : '',
    '',
  ].join('\n');
  entries.push({ name: 'README.txt', data: readme });
  const zip = buildZip(entries);
  // Copy into a plain ArrayBuffer-backed view: BlobPart rejects the
  // ArrayBufferLike-typed Uint8Array the writer hands back.
  const bytes = new Uint8Array(zip.byteLength);
  bytes.set(zip);
  downloadBlob(`modemap_${phononState.sourceName}_${modeTag()}.zip`, new Blob([bytes], { type: 'application/zip' }));
  setScanStatus(container, `Exported ${geometries.length} structures.`);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function modeSummary() {
  const sel = phononState.selected;
  if (!sel || !phononState.dataset) return 'No mode selected — click a point in the band plot, or pick an imaginary mode below.';
  const f = selectedFrequency();
  const kind = f < -0.05 ? 'imaginary' : 'real';
  let text = `q = ${qLabel(sel.iq)}, band ${sel.ib + 1}: ${fmt(f)} THz (${kind})`;
  if (!phononState.pattern) text += ' — no eigenvectors in this file, cannot animate.';
  else if (!phononState.commensurate) text += ` — q is not periodic in the ${phononState.dims.join('×')} supercell; suggested ${suggestedDims().join('×')}.`;
  return text;
}

function refresh(container) {
  const { dataset, dos } = phononState;
  const loaded = q(container, '.ph-loaded');
  if (loaded) {
    loaded.textContent = dataset
      ? `${dataset.fileName} (${dataset.kind}): ${dataset.natom} atoms, ${dataset.nbands} bands, ${dataset.qpoints.length} q-points`
        + (dataset.hasEigenvectors ? '' : ', no eigenvectors') + (dos ? ` · DOS: ${dos.frequencies.length} points` : '')
      : 'No phonopy data on the selected structure. Drop band.yaml / mesh.yaml (and phonopy.yaml, total_dos.dat) on the 3D view or the Files window.';
  }
  const unitSel = /** @type {HTMLSelectElement} */ (q(container, '#phLengthUnit'));
  if (unitSel) unitSel.value = phononState.lengthUnit;
  const unitName = (u) => (u === 'bohr' ? 'Bohr' : 'Å');
  const unitSource = {
    'phonopy.yaml': `from phonopy.yaml${phononState.cells?.calculator ? ` (calculator: ${phononState.cells.calculator})` : ''}`,
    user: 'confirmed at load; the file declares no unit',
    geometry: 'judged from the interatomic distances; the file declares no unit',
  }[phononState.detectedUnitSource] || 'detected';
  setText(container, '#phUnitNote', phononState.lengthUnit === 'auto'
    ? (phononState.detectedUnit
      ? `${unitName(phononState.detectedUnit)} — ${unitSource}`
      : 'Å assumed — load phonopy.yaml to pick up the calculator\'s unit, or choose Bohr for QE / abinit / siesta runs.')
    : `cells read as ${unitName(effectiveLengthUnit())}`);
  const has = !!dataset;
  for (const el of container.querySelectorAll('.ph-needs-data')) /** @type {HTMLElement} */ (el).hidden = !has;
  setText(container, '.ph-mode-summary', modeSummary());
  const dimsInputs = ['#phDim1', '#phDim2', '#phDim3'].map((sel) => /** @type {HTMLInputElement} */ (q(container, sel)));
  dimsInputs.forEach((inp, k) => { if (inp && document.activeElement !== inp) inp.value = String(phononState.dims[k]); });
  const suggest = q(container, '#phDimsSuggest');
  if (suggest) {
    // Offer the smallest periodic supercell only while the current one is
    // not periodic for this q (a bigger commensurate cell is a valid choice).
    const sd = suggestedDims();
    suggest.hidden = !(phononState.selected && phononState.pattern && !phononState.commensurate);
    suggest.textContent = `Use ${sd.join('×')}`;
  }
  const canAnimate = !!phononState.pattern;
  for (const id of ['#phPlayBtn', '#phPauseBtn', '#phStopBtn']) {
    const b = /** @type {HTMLButtonElement} */ (q(container, id));
    if (b) b.disabled = !canAnimate;
  }
  const playBtn = q(container, '#phPlayBtn');
  if (playBtn) playBtn.classList.toggle('highlight', phononState.playing);
  const amp = /** @type {HTMLInputElement} */ (q(container, '#phAmplitude'));
  if (amp && document.activeElement !== amp) amp.value = String(phononState.amplitude);
  setText(container, '#phAmplitudeValue', `${phononState.amplitude.toFixed(2)} Å`);
  const spd = /** @type {HTMLInputElement} */ (q(container, '#phSpeed'));
  if (spd && document.activeElement !== spd) spd.value = String(phononState.speed);
  setText(container, '#phSpeedValue', `${phononState.speed.toFixed(2)} Hz`);
  arrowSection?.refresh();
  const arg = /** @type {HTMLInputElement} */ (q(container, '#phArgument'));
  if (arg && document.activeElement !== arg) arg.value = String(phononState.argumentDeg);

  // Imaginary modes list
  const list = /** @type {HTMLSelectElement} */ (q(container, '#phImaginaryList'));
  if (list) {
    const modes = imaginaryModes();
    const current = list.value;
    list.innerHTML = '';
    if (!modes.length) {
      const opt = document.createElement('option');
      opt.textContent = has ? 'No imaginary modes in this file.' : '—';
      opt.disabled = true;
      list.appendChild(opt);
    }
    for (const m of modes) {
      const opt = document.createElement('option');
      opt.value = `${m.iq}:${m.ib}`;
      opt.textContent = `${fmt(m.freq)} THz  ·  ${qLabel(m.iq)}  ·  band ${m.ib + 1}`;
      if (phononState.selected && phononState.selected.iq === m.iq && phononState.selected.ib === m.ib) opt.selected = true;
      list.appendChild(opt);
    }
    if (!list.value && current) list.value = current;
    setText(container, '.ph-imaginary-count', modes.length ? `${modes.length} imaginary mode${modes.length === 1 ? '' : 's'} (ω < −0.05 THz)` : '');
  }
  updateScanUI(container);
}

// ---------------------------------------------------------------------------
// Displacement arrows: the Forces panel's arrow section (ui/ForcePanel.js) for
// the mode's displacement field — length window + log length, diameter,
// colour modes, and a colour bar (range, log scale, auto range; floatable and
// exported with the scene through ColorBarRegistry).
// ---------------------------------------------------------------------------

const PHONON_COLORBAR_FLOATING_ID = 'phononColorBarFloating';
let colorBarInstance = null;
let arrowSection = null; // { refresh, dispose }

registerColorBarSource('phonon', 'Displacement (Å)', () => colorBarInstance);

function captureColorBarState() {
  if (!colorBarInstance) return;
  const settings = colorBarInstance.getSettings();
  const bar = phononState.arrowBar;
  bar.orientation = settings.orientation;
  bar.flipSide = settings.flipSide;
  bar.size = settings.size;
  bar.legend = settings.legend;
  bar.floating = colorBarInstance.isFloating();
  if (bar.floating) bar.floatPos = colorBarInstance.getAnchor();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildArrowSection(host) {
  if (!host) return;
  host.innerHTML = '';

  // Show toggle
  const showRow = el('div', 'ph-row');
  const showLabel = el('label', 'toggle_row toggle_container ph-toggle');
  showLabel.innerHTML = '<span class="toggle_switch toggle_switch--sm"><input type="checkbox" id="phArrows"><span class="toggle_slider"></span></span><span class="toggle_text">Show arrows</span>';
  showRow.appendChild(showLabel);
  host.appendChild(showRow);
  const showInput = /** @type {HTMLInputElement} */ (showLabel.querySelector('input'));
  showInput.addEventListener('change', () => setShowArrows(showInput.checked));

  // Global Scaling (Length) + log length
  const lenWrap = el('div', 'cv-force-row');
  const lenTop = el('div', 'cv-force-split-row');
  lenTop.appendChild(el('label', '', 'Global Scaling (Length): '));
  const logLenLabel = el('label', 'cv-force-check');
  const logLen = /** @type {HTMLInputElement} */ (el('input'));
  logLen.type = 'checkbox';
  logLen.id = 'phArrowLogLength';
  logLenLabel.appendChild(logLen);
  logLenLabel.appendChild(document.createTextNode('log length'));
  lenTop.appendChild(logLenLabel);
  lenWrap.appendChild(lenTop);
  const lenBottom = el('div', 'cv-force-split-row');
  const lenValue = el('span', 'cv-force-value');
  const lenSlider = /** @type {HTMLInputElement} */ (el('input'));
  lenSlider.type = 'range'; lenSlider.min = '0.1'; lenSlider.max = '10'; lenSlider.step = '0.1'; lenSlider.id = 'phArrowScale';
  lenBottom.appendChild(lenValue);
  lenBottom.appendChild(lenSlider);
  lenWrap.appendChild(lenBottom);
  host.appendChild(lenWrap);

  // Arrow Size (Diameter)
  const sizeWrap = el('div', 'cv-force-row');
  sizeWrap.appendChild(el('label', '', 'Arrow Size (Diameter): '));
  const sizeValue = el('span', 'cv-force-value');
  const sizeSlider = /** @type {HTMLInputElement} */ (el('input'));
  sizeSlider.type = 'range'; sizeSlider.min = '0.01'; sizeSlider.max = '0.15'; sizeSlider.step = '0.01'; sizeSlider.id = 'phArrowRadius';
  sizeWrap.appendChild(sizeValue);
  sizeWrap.appendChild(sizeSlider);
  host.appendChild(sizeWrap);

  // Color Map + swatch, bar controls, colour bar
  const cmapWrap = el('div', 'cv-force-row');
  cmapWrap.appendChild(el('label', 'cv-force-label-block', 'Color Map: '));
  const cmapRow = el('div', 'cv-force-colormap');
  const cmapSelect = /** @type {HTMLSelectElement} */ (el('select', 'cv-scene-select cv-scene-select--flex'));
  cmapSelect.id = 'phArrowColorMap';
  for (const [value, label] of [
    ['solid', 'Solid Color'], ['direction', 'Direction Map'], ['plusminus', 'Plus-Minus Map'],
    ['heatmap', 'Heatmap'], ['batlow', 'Batlow'], ['hawaii', 'Hawaii'], ['managua', 'Managua'],
    ['viridis', 'Viridis'], ['plasma', 'Plasma'], ['spectralR', 'Spectral R'], ['jet', 'Jet'],
  ]) {
    const opt = el('option', '', label);
    opt.value = value;
    cmapSelect.appendChild(opt);
  }
  cmapRow.appendChild(cmapSelect);
  // The app's own colour picker (a swatch opening the shared picker panel),
  // not the browser's native dialog.
  const swatch = createColorSwatch(phononState.arrowColor, (hex) => {
    swatch.dataset.hex = hex;
    swatch.style.background = hex;
    setArrowColor(hex);
  });
  swatch.id = 'phArrowColor';
  swatch.title = 'Arrow colour';
  cmapRow.appendChild(swatch);
  cmapWrap.appendChild(cmapRow);

  const barControls = el('div', 'cv-force-bar-controls cv-force-bar-controls--force');
  const logLabel = el('label', 'cv-force-check');
  const logBox = /** @type {HTMLInputElement} */ (el('input'));
  logBox.type = 'checkbox';
  logBox.id = 'phArrowLogScale';
  logLabel.appendChild(logBox);
  logLabel.appendChild(document.createTextNode('Log Scale'));
  const autoBtn = /** @type {HTMLButtonElement} */ (el('button', 'file-action-btn cv-auto-range-btn', 'Auto Range'));
  autoBtn.type = 'button';
  autoBtn.id = 'phArrowAutoRange';
  barControls.appendChild(logLabel);
  barControls.appendChild(autoBtn);
  cmapWrap.appendChild(barControls);
  const barContainer = el('div', 'cv-force-colorbar-container cv-force-hidden');
  barContainer.id = 'phononColorBarContainer';
  cmapWrap.appendChild(barContainer);
  host.appendChild(cmapWrap);

  function syncLogScaleLock() {
    const locked = phononState.arrowLengthLog;
    logBox.disabled = locked;
    logLabel.classList.toggle('cv-check-locked', locked);
    logLabel.title = locked ? '"log length" requires Log Scale — turn it off first to change this' : '';
  }

  function applyAutoRange() {
    const mags = arrowMagnitudes().filter((m) => m > 1e-9);
    const range = computeAutoRange(mags, 0.2, { clampMinAtZero: true });
    if (!range) return;
    let { min, max } = range;
    if (phononState.arrowColorScale === 'log' && min <= 0) min = Math.max(1e-3, max * 0.01);
    if (Math.abs(min - phononState.arrowMin) > 1e-12 || Math.abs(max - phononState.arrowMax) > 1e-12) {
      setArrowRange(min, max, { auto: true });
    } else {
      phononState.arrowRangeAuto = true;
    }
    colorBarInstance?.setRange(phononState.arrowMin, phononState.arrowMax);
  }

  function applyLogScale(isLog) {
    setArrowColorScale(isLog ? 'log' : 'linear');
    logBox.checked = phononState.arrowColorScale === 'log';
    colorBarInstance?.setRange(phononState.arrowMin, phononState.arrowMax);
    colorBarInstance?.update(phononState.arrowColorMap, phononState.arrowColorScale);
  }

  function rebuildColorBar() {
    const scalar = isScalarArrowMap(phononState.arrowColorMap);
    barControls.classList.toggle('cv-force-hidden', !scalar);
    captureColorBarState();
    colorBarInstance?.remove();
    colorBarInstance = null;
    barContainer.innerHTML = '';
    if (!scalar) { barContainer.classList.add('cv-force-hidden'); return; }
    barContainer.classList.remove('cv-force-hidden');
    const bar = phononState.arrowBar;
    colorBarInstance = createColorBar(barContainer, phononState.arrowColorMap, phononState.arrowMin, phononState.arrowMax, {
      floatingId: PHONON_COLORBAR_FLOATING_ID,
      fallbackMin: phononState.arrowMin,
      fallbackMax: phononState.arrowMax,
      legend: bar.legend ?? 'Displacement (Å)',
      scale: phononState.arrowColorScale,
      orientation: bar.orientation,
      flipSide: bar.flipSide,
      size: bar.size,
      isLocked: () => bar.locked,
      onLockChange: (locked) => { bar.locked = locked; },
      onLimitsCommit: (min, max) => setArrowRange(min, max),
      onScaleChange: (scale) => applyLogScale(scale === 'log'),
      onAutoRange: () => applyAutoRange(),
      onLegendChange: (text) => { bar.legend = text; },
      isScaleLocked: () => phononState.arrowLengthLog,
    });
    if (bar.floating && bar.floatPos) colorBarInstance.floatAtAnchor(bar.floatPos);
  }

  lenSlider.addEventListener('input', () => {
    let v = parseFloat(lenSlider.value);
    if (Math.abs(v - 1) < 0.05) v = 1;
    setArrowScale(v);
  });
  sizeSlider.addEventListener('input', () => setArrowRadius(parseFloat(sizeSlider.value)));
  logLen.addEventListener('change', () => {
    setArrowLengthLog(logLen.checked);
    if (logLen.checked) applyLogScale(true);
    syncLogScaleLock();
  });
  cmapSelect.addEventListener('change', () => {
    setArrowColorMap(cmapSelect.value);
    rebuildColorBar();
    if (isScalarArrowMap(cmapSelect.value) && phononState.arrowRangeAuto) applyAutoRange();
  });
  logBox.addEventListener('change', () => applyLogScale(logBox.checked));
  autoBtn.addEventListener('click', applyAutoRange);

  function refresh() {
    showInput.checked = phononState.showArrows;
    if (document.activeElement !== lenSlider) lenSlider.value = String(phononState.arrowScale);
    lenValue.textContent = phononState.arrowScale.toFixed(2);
    if (document.activeElement !== sizeSlider) sizeSlider.value = String(phononState.arrowRadius);
    sizeValue.textContent = phononState.arrowRadius.toFixed(2);
    logLen.checked = phononState.arrowLengthLog;
    logBox.checked = phononState.arrowColorScale === 'log';
    syncLogScaleLock();
    cmapSelect.value = phononState.arrowColorMap;
    swatch.hidden = phononState.arrowColorMap !== 'solid';
    swatch.dataset.hex = phononState.arrowColor;
    swatch.style.background = phononState.arrowColor;
    const scalar = isScalarArrowMap(phononState.arrowColorMap);
    if (scalar !== !!colorBarInstance || (colorBarInstance && colorBarInstance.getSettings().colormap !== phononState.arrowColorMap)) rebuildColorBar();
    // Until the user types limits, the range follows the displacements
    // (a new mode, another amplitude, a different supercell).
    if (scalar && phononState.arrowRangeAuto) applyAutoRange();
    colorBarInstance?.setRange(phononState.arrowMin, phononState.arrowMax);
  }

  arrowSection = {
    refresh,
    dispose() {
      captureColorBarState();
      colorBarInstance?.remove();
      colorBarInstance = null;
      arrowSection = null;
    },
  };
  refresh();
}

export function addPhononPanel(target = 'cvPanelBody-phonon') {
  const container = document.getElementById(target);
  if (!container) return;

  container.innerHTML = `
    <div class="control-group">
      <div class="ph-loaded ph-status"></div>
      <div class="ph-row ph-needs-data" hidden>
        <label for="phLengthUnit" title="phonopy writes cells in the calculator's length unit (Bohr for QE, abinit, siesta, …) and only phonopy.yaml records which">Length unit</label>
        <select id="phLengthUnit" class="ph-num">
          <option value="auto">Auto</option>
          <option value="angstrom">Å</option>
          <option value="bohr">Bohr</option>
        </select>
        <button type="button" id="phOpenPlotsBtn" class="btn-mini ph-btn" title="Open the Phonon Plots window">Show plots</button>
      </div>
      <div class="ph-status ph-needs-data" id="phUnitNote" hidden></div>
    </div>

    <div class="control-group ph-needs-data" hidden>
      <h4 class="ph-heading">Mode</h4>
      <div class="ph-mode-summary ph-status"></div>
      <div class="ph-row">
        <label>Supercell</label>
        <input type="number" id="phDim1" min="1" max="8" step="1" value="1" class="ph-dim">
        <span class="ph-times">×</span>
        <input type="number" id="phDim2" min="1" max="8" step="1" value="1" class="ph-dim">
        <span class="ph-times">×</span>
        <input type="number" id="phDim3" min="1" max="8" step="1" value="1" class="ph-dim">
        <button type="button" id="phDimsApply" class="btn-mini ph-btn">Apply</button>
        <button type="button" id="phDimsSuggest" class="btn-mini ph-btn" hidden></button>
      </div>
      <div class="ph-row">
        <label for="phAmplitude">Amplitude</label>
        <input type="range" id="phAmplitude" min="0" max="2" step="0.01" value="0.4">
        <span class="ph-value" id="phAmplitudeValue"></span>
      </div>
      <div class="ph-row">
        <label for="phSpeed">Speed</label>
        <input type="range" id="phSpeed" min="0.05" max="3" step="0.05" value="1">
        <span class="ph-value" id="phSpeedValue"></span>
      </div>
      <div class="ph-row ph-transport">
        <button type="button" id="phPlayBtn" class="btn-mini ph-btn" title="Play">▶</button>
        <button type="button" id="phPauseBtn" class="btn-mini ph-btn" title="Pause (freeze at the current phase)">❚❚</button>
        <button type="button" id="phStopBtn" class="btn-mini ph-btn" title="Stop and return to equilibrium">■</button>
        <button type="button" id="phClearBtn" class="btn-mini ph-btn" title="Deselect the mode">Clear</button>
      </div>
      <details class="ph-collapsible" id="phArrowDetails" open>
        <summary class="eos-collapsible-summary"><span class="eos-collapsible-arrow">▶</span>Displacement arrows</summary>
        <div id="phArrowHost" class="ph-arrow-host"></div>
      </details>
      <details class="ph-collapsible">
        <summary class="eos-collapsible-summary"><span class="eos-collapsible-arrow">▶</span>Advanced</summary>
        <div class="ph-row">
          <label for="phArgument" title="Phase argument of the frozen pattern (phonopy MODULATION convention)">Phase (°)</label>
          <input type="number" id="phArgument" min="-180" max="180" step="5" value="0" class="ph-num">
        </div>
      </details>
    </div>

    <div class="control-group ph-needs-data" hidden>
      <h4 class="ph-heading">Imaginary modes</h4>
      <div class="ph-imaginary-count ph-status"></div>
      <select id="phImaginaryList" size="5" class="ph-list"></select>
    </div>

    ${isExperimentalMode() ? `
    <details class="control-group ph-needs-data ph-collapsible-group" open hidden>
      <summary class="eos-collapsible-summary ph-group-summary"><span class="eos-collapsible-arrow">▶</span>Mode map (frozen phonon)</summary>
      <p class="ph-help">Freeze the selected mode into its own supercell at amplitudes Q, compute each
        structure with the active potential (NEP / PET-MAD, chosen in the Atomistic window), fit U(Q) and
        locate the minima. Q is the normal-mode coordinate with Σ m u² = Q², so a harmonic mode gives
        U = ½ω²Q².</p>
      <div class="ph-row">
        <label>Supercell</label>
        <input type="number" id="phScanDim1" min="1" max="12" step="1" value="1" class="ph-dim">
        <span class="ph-times">×</span>
        <input type="number" id="phScanDim2" min="1" max="12" step="1" value="1" class="ph-dim">
        <span class="ph-times">×</span>
        <input type="number" id="phScanDim3" min="1" max="12" step="1" value="1" class="ph-dim">
        <label class="toggle_row toggle_container ph-toggle ph-dims-auto" title="Smallest supercell in which the selected q is periodic">
          <span class="toggle_switch toggle_switch--sm"><input type="checkbox" id="phScanDimsAuto" checked><span class="toggle_slider"></span></span>
          <span class="toggle_text">auto</span>
        </label>
        <span class="ph-status" id="phScanDimsNote"></span>
      </div>
      <div class="ph-row">
        <label for="phQMin">Q range</label>
        <input type="number" id="phQMin" value="-2" step="0.1" class="ph-num">
        <span class="ph-times">…</span>
        <input type="number" id="phQMax" value="2" step="0.1" class="ph-num">
        <span class="ph-unit">amu<sup>½</sup>·Å</span>
        <button type="button" id="phQAuto" class="btn-mini ph-btn" title="Range at which the largest atom moves ~0.5 Å">Auto</button>
      </div>
      <div class="ph-status" id="phQNote"></div>
      <div class="ph-row">
        <label for="phQConvention" title="Normal-mode Q: Σ m u² = Q², so U = ½ω²Q². phonopy amplitude: u = A·Re c / √N as in the MODULATION tag and ModeMap's plots.">Axes</label>
        <select id="phQConvention" class="ph-num">
          <option value="normal">Q (Σ m u² = Q²)</option>
          <option value="phonopy">phonopy amplitude</option>
        </select>
        <label class="toggle_row toggle_container ph-toggle" title="Energies per atom of the scan supercell (ModeMap convention) instead of per supercell">
          <span class="toggle_switch toggle_switch--sm"><input type="checkbox" id="phPerAtom"><span class="toggle_slider"></span></span>
          <span class="toggle_text">meV / atom</span>
        </label>
      </div>
      <div class="ph-row">
        <label for="phQPoints">Points</label>
        <input type="number" id="phQPoints" value="15" min="3" max="201" step="2" class="ph-num">
        <label for="phFitDegree" class="ph-inline-label">Fit order</label>
        <select id="phFitDegree" class="ph-num" title="Polynomial order; auto picks the lowest even order (4–10) that fits the points to 1 % of their range">
          <option value="auto" selected>auto</option><option value="2">2</option><option value="4">4</option><option value="6">6</option><option value="8">8</option><option value="10">10</option>
        </select>
        <label class="toggle_row toggle_container ph-toggle" title="Fit only even powers of Q">
          <span class="toggle_switch toggle_switch--sm"><input type="checkbox" id="phFitEven" checked><span class="toggle_slider"></span></span>
          <span class="toggle_text">even</span>
        </label>
      </div>
      <div class="ph-actions">
        <button type="button" id="phScanBtn" class="btn-mini ph-btn">Compute</button>
        <button type="button" id="phScanStopBtn" class="btn-mini ph-btn" disabled>Stop</button>
        <button type="button" id="phExportBtn" class="btn-mini ph-btn" title="Download the displaced structures (POSCAR set + CSV) as a zip, for DFT single points" disabled>Export structures</button>
        <button type="button" id="phZoomMinBtn" class="btn-mini ph-btn" title="Narrow the Q range to ±1.8× the minimum, then Compute again" disabled>Zoom to minimum</button>
        <button type="button" id="phLoadMinBtn" class="btn-mini ph-btn" title="Add the deepest minimum as a new structure" disabled>Load minimum</button>
      </div>
      <div class="ph-scan-status ph-status"></div>
      <div class="ph-scan-results" hidden>
        <table class="result-table eos-result-table">
          <tr><td>Potential</td><td id="ph-res-potential"></td></tr>
          <tr><td>Points</td><td id="ph-res-points"></td></tr>
          <tr><td>ω from fit</td><td id="ph-res-wfit"></td></tr>
          <tr><td>ω from phonopy</td><td id="ph-res-wph"></td></tr>
          <tr><td>Fit rms</td><td id="ph-res-rms"></td></tr>
          <tr><td>Shape</td><td id="ph-res-shape"></td></tr>
          <tr><td>Fit minima</td><td id="ph-res-minima"></td></tr>
          <tr><td>Data minimum</td><td id="ph-res-datamin"></td></tr>
        </table>
      </div>
    </details>
    ` : ''}
  `;

  q(container, '#phOpenPlotsBtn').addEventListener('click', () => { setModeMapCardHidden(false); openPanel('phononPlots'); });

  const readDims = () => ['#phDim1', '#phDim2', '#phDim3'].map((sel) => parseInt(/** @type {HTMLInputElement} */ (q(container, sel)).value, 10) || 1);
  q(container, '#phDimsApply').addEventListener('click', () => setDims(readDims()));
  q(container, '#phDimsSuggest').addEventListener('click', () => setDims(suggestedDims()));
  for (const sel of ['#phDim1', '#phDim2', '#phDim3']) {
    q(container, sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') setDims(readDims()); });
  }
  q(container, '#phAmplitude').addEventListener('input', (e) => setAmplitude(/** @type {HTMLInputElement} */ (e.target).value));
  q(container, '#phSpeed').addEventListener('input', (e) => setSpeed(/** @type {HTMLInputElement} */ (e.target).value));
  q(container, '#phPlayBtn').addEventListener('click', () => play());
  q(container, '#phPauseBtn').addEventListener('click', () => pause());
  q(container, '#phStopBtn').addEventListener('click', () => stopAnimation());
  q(container, '#phClearBtn').addEventListener('click', () => clearMode());
  buildArrowSection(q(container, '#phArrowHost'));
  q(container, '#phArgument').addEventListener('change', (e) => setArgument(/** @type {HTMLInputElement} */ (e.target).value));
  q(container, '#phImaginaryList').addEventListener('change', (e) => {
    const [iq, ib] = String(/** @type {HTMLSelectElement} */ (e.target).value).split(':').map(Number);
    if (Number.isInteger(iq) && Number.isInteger(ib)) selectMode(iq, ib);
  });
  q(container, '#phLengthUnit').addEventListener('change', (e) => setLengthUnit(/** @type {HTMLSelectElement} */ (e.target).value));
  q(container, '#phScanDimsAuto')?.addEventListener('change', () => updateScanUI(container));
  for (const sel of ['#phQMin', '#phQMax']) {
    q(container, sel)?.addEventListener('input', () => { qRangeTouched = true; updateScanUI(container); });
  }
  q(container, '#phQAuto')?.addEventListener('click', () => { qRangeTouched = false; updateScanUI(container); });
  q(container, '#phQConvention')?.addEventListener('change', (e) => {
    // Re-express the typed range in the new convention so the scan is unchanged.
    const ctx = scanContext(container);
    const qMinNow = inputToQ(parseFloat(/** @type {HTMLInputElement} */ (q(container, '#phQMin')).value) || 0, ctx);
    const qMaxNow = inputToQ(parseFloat(/** @type {HTMLInputElement} */ (q(container, '#phQMax')).value) || 0, ctx);
    setQConvention(/** @type {HTMLSelectElement} */ (e.target).value);
    if (ctx) {
      /** @type {HTMLInputElement} */ (q(container, '#phQMin')).value = String(Number(qToInput(qMinNow, ctx).toPrecision(4)));
      /** @type {HTMLInputElement} */ (q(container, '#phQMax')).value = String(Number(qToInput(qMaxNow, ctx).toPrecision(4)));
    }
    updateScanUI(container);
  });
  q(container, '#phPerAtom')?.addEventListener('change', (e) => { setEnergyPerAtom(/** @type {HTMLInputElement} */ (e.target).checked); updateScanUI(container); });
  for (const sel of ['#phScanDim1', '#phScanDim2', '#phScanDim3']) {
    q(container, sel)?.addEventListener('change', () => updateScanUI(container));
  }
  q(container, '#phScanBtn')?.addEventListener('click', () => runScan(container));
  q(container, '#phScanStopBtn')?.addEventListener('click', () => { scanStopRequested = true; setScanStatus(container, 'Stopping…'); });
  q(container, '#phExportBtn')?.addEventListener('click', () => exportStructures(container));
  q(container, '#phLoadMinBtn')?.addEventListener('click', () => loadMinimumStructure(container));
  q(container, '#phZoomMinBtn')?.addEventListener('click', () => zoomToMinimum(container));
  if (scanRunning) {
    /** @type {HTMLButtonElement} */ (q(container, '#phScanBtn')).disabled = true;
    /** @type {HTMLButtonElement} */ (q(container, '#phScanStopBtn')).disabled = false;
  }
  if (phononState.modeMap?.settings && q(container, '#phFitDegree')) {
    /** @type {HTMLSelectElement} */ (q(container, '#phFitDegree')).value = String(phononState.modeMap.settings.degree);
    /** @type {HTMLInputElement} */ (q(container, '#phFitEven')).checked = phononState.modeMap.settings.evenOnly;
  }

  unsubscribe?.();
  unsubscribe = onPhononChange(() => refresh(container));
  refresh(container);
}

export function removePhononPanel() {
  unsubscribe?.();
  unsubscribe = null;
  arrowSection?.dispose();
}
