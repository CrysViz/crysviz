// The phonon feature's shared state and behaviour: which phonopy dataset is
// loaded, which supercell is shown for it, which mode is selected, and the
// animation that drives the shown atoms. Both the controls window
// (ui/PhononPanel.js) and the plots window (ui/PhononPlotsPanel.js) read this
// state and subscribe to its changes; core/crystal-viewer.js hands phonopy
// files to loadPhonopyFile when the format detector recognises them.
//
// The displayed structure is an ordinary file-browser row ("phonon_<file>_
// n1xn2xn3") holding the primitive cell tiled to the chosen supercell. Mode
// animation writes displaced fractional positions into that structure and
// pushes them through the same in-place fast path MD streaming uses
// (render/FastFrameModule.js) — no topology rebuild per frame.

import { Structure, Atom, StructureContainer } from '../model/index.js';
import { fileBrowser, structureShip, general, measurements } from '../state/store.js';
import { updateAllMeasurements } from '../render/MeasurementModule.js';
import { fitCameraToCurrentStructure } from '../ui/WindowAndSceneControls.js';
import { onActiveStructureChange } from '../state/structures.js';
import { initializeUIOnLoad } from '../ui/StructureInputModule.js';
import { selectStructure, updateRow } from '../ui/FileBrowswerPanel.js';
import { applyFrameFast, requestRender } from '../render/index.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { generateID } from '../utils/UUIDModule.js';
import { updatePhononArrows, removePhononArrows } from '../render/PhononArrowModule.js';
import { refreshPanelAvailability } from '../ui/panels/PanelManager.js';
import {
  parsePhonopyModes, parsePhonopyCells, parsePhonopyDos, withCell, listImaginaryModes,
  scaleCell, BOHR_TO_ANGSTROM,
} from './phonopyReader.js';
import { assessLengthUnit, describeReadings, unitLabel } from './lengthUnitGuess.js';
import { atomicRadii } from '../defaults/radii_defaults.js';
import { choiceDialog } from '../ui/ConfirmModal.js';
import {
  buildSupercell, modePattern, animationDisplacement, cartToFracWithInverse, invert3x3,
  isCommensurate, commensurateDims,
} from './phononMath.js';

/** Default arrow colour: an orange that reads against every atom palette. */
export const DEFAULT_ARROW_COLOR = '#ff8c00';

export const phononState = {
  /** @type {import('./phonopyReader.js').PhononDataset|null} */
  dataset: null,
  /** @type {{frequencies:number[], total:number[], columns:number[][]}|null} */
  dos: null,
  /** @type {ReturnType<typeof parsePhonopyCells>|null} */
  cells: null,
  sourceName: '',
  /** 'auto' follows phonopy.yaml (or Å when none is loaded); the user can force Å / Bohr. */
  lengthUnit: /** @type {'auto'|'angstrom'|'bohr'} */ ('auto'),
  /** @type {'angstrom'|'bohr'|null} the unit the cells were found to be in (see detectedUnitSource) */
  detectedUnit: null,
  /** How detectedUnit was settled: 'phonopy.yaml' (declared by the file), 'user' (confirmed
   *  in the load-time dialog), 'geometry' (inferred from the interatomic distances, dialog
   *  dismissed) or null. @type {'phonopy.yaml'|'user'|'geometry'|null} */
  detectedUnitSource: null,
  /** The last geometry assessment (phonon/lengthUnitGuess.js), for the panel. @type {any} */
  unitAssessment: null,
  dims: [1, 1, 1],
  /** @type {{iq:number, ib:number}|null} */
  selected: null,
  amplitude: 0.4,   // Å — largest atomic excursion of the animated mode
  speed: 1.0,       // visual cycles per second
  argumentDeg: 0,   // phase argument of the frozen pattern (phonopy MODULATION convention)
  showArrows: true,
  // Arrow styling mirrors the Forces panel (ui/ForcePanel.js): the same
  // length window scaled by arrowScale (optionally log), the same diameter
  // range, and the same colour modes with a colour bar over [arrowMin,
  // arrowMax] Å of displacement.
  arrowScale: 1.0,
  arrowRadius: 0.08,
  arrowLengthLog: false,
  arrowColor: DEFAULT_ARROW_COLOR,
  /** 'solid' | 'direction' | 'plusminus' | a scalar colour-map name */
  arrowColorMap: 'solid',
  arrowMin: 0,
  arrowMax: 0.5,
  /** true until the user edits the colour-bar limits: the range then follows
   *  the mode's displacements (Auto Range turns it back on). */
  arrowRangeAuto: true,
  arrowColorScale: /** @type {'linear'|'log'} */ ('linear'),
  /** colour-bar layout, carried across rebuilds like general.forceColorBar* */
  arrowBar: { orientation: 'horizontal', flipSide: false, size: null, legend: null, floating: false, floatPos: null, locked: false },
  playing: false,
  phase: 0,
  /** @type {StructureContainer|null} the file-browser row holding the supercell */
  container: null,
  /** @type {any} the row's phonon record the live state mirrors (see RECORD_FIELDS) */
  record: null,
  /** @type {Structure|null} */
  structure: null,
  /** @type {import('./phononMath.js').PhononSupercell|null} */
  supercell: null,
  /** @type {import('./phononMath.js').ModePattern|null} */
  pattern: null,
  commensurate: true,
  /** last mode-map scan (owned by ui/PhononPanel.js, kept here so both windows see it) */
  modeMap: null,
  /** Mode-map x axis: the normal-mode coordinate (Σ m u² = Q²) or phonopy's
   *  MODULATION amplitude (u = A·Re c/√N), which is what ModeMap plots. */
  qConvention: /** @type {'normal'|'phonopy'} */ ('normal'),
  /** Mode-map y axis per atom of the scan supercell instead of per supercell. */
  energyPerAtom: false,
};

const listeners = new Set();
/** Subscribe to state changes: cb(event, phononState). Returns an unsubscribe fn. */
export function onPhononChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit(event) {
  saveToRecord();
  for (const cb of [...listeners]) {
    try { cb(event, phononState); } catch (error) { console.error(error); }
  }
}

// ---------------------------------------------------------------------------
// Binding to file-browser rows
//
// The phonon data belongs to the structure row it was loaded onto: the row's
// container carries a `phonon` record with everything the windows need, so
// the windows follow the selected row (unavailable — hence auto-closed — on
// another structure, back when the row is selected again), and several
// phonopy datasets can be loaded side by side. Rows the session derives from
// a dataset (mode-map scans, loaded minima) share the parent's record.
// ---------------------------------------------------------------------------

const RECORD_FIELDS = [
  'arrowColorMap', 'arrowScale', 'arrowRadius', 'arrowLengthLog', 'arrowColor', 'arrowMin', 'arrowMax', 'arrowColorScale', 'arrowBar',
  'arrowRangeAuto',
  'dataset', 'dos', 'cells', 'sourceName', 'lengthUnit', 'detectedUnit', 'detectedUnitSource', 'unitAssessment', 'dims', 'selected',
  'amplitude', 'speed', 'argumentDeg', 'modeMap', 'qConvention', 'energyPerAtom',
];

function activeContainer() {
  const idx = fileBrowser.selectedRowIndex;
  return Number.isInteger(idx) ? structureShip.container[idx] ?? null : null;
}

/** The phonon record of the selected row, or null when it has none. */
export function activePhononRecord() {
  const c = /** @type {any} */ (activeContainer());
  return c && c.phonon ? c.phonon : null;
}

/** Whether the Phonons windows have something to show for the selected row. */
export function phononAvailable() {
  return !!activePhononRecord();
}

/** Copy the live state into the record of the row it belongs to. */
function saveToRecord() {
  const record = phononState.record;
  if (!record) return;
  for (const key of RECORD_FIELDS) record[key] = phononState[key];
}

/** Make `record` the live state (the row that carries it is selected). */
function activateRecord(record) {
  if (phononState.record === record) return;
  saveToRecord();
  stopAnimation({ silent: true });
  removePhononArrows();
  phononState.record = record;
  for (const key of RECORD_FIELDS) phononState[key] = record[key];
  phononState.container = record.container;
  const structure = record.container?.structures?.[0] ?? null;
  phononState.structure = structure;
  if (phononState.dataset?.cell && structure) {
    const sc = buildSupercell(phononState.dataset.cell, phononState.dims);
    phononState.supercell = sc;
    phononState.invLattice = invert3x3(sc.lattice);
    phononState.uBuf = new Float64Array(sc.natom * 3);
    phononState.arrowBuf = new Float64Array(sc.natom * 3);
    recomputePattern();
  } else {
    phononState.supercell = null;
    phononState.pattern = null;
  }
  emit('dataset');
  emit('modemap');
}

/** Tag a container the session created (scan row, minimum) with the record so
 *  selecting it keeps the phonon windows open. */
export function adoptContainer(container) {
  if (container && phononState.record) /** @type {any} */ (container).phonon = phononState.record;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The unit the loaded cells are actually in, after auto-detection. */
export function effectiveLengthUnit() {
  return phononState.lengthUnit === 'auto' ? (phononState.detectedUnit || 'angstrom') : phononState.lengthUnit;
}

function unitFactor(unit = effectiveLengthUnit()) {
  return unit === 'bohr' ? BOHR_TO_ANGSTROM : 1;
}

const CALCULATORS = {
  angstrom: 'VASP, CASTEP, CP2K, FHI-aims, LAMMPS runs',
  bohr: 'Quantum ESPRESSO, abinit, siesta, elk, wien2k runs',
};

/**
 * A mode file (band/mesh/qpoints.yaml) or a phonopy.yaml without
 * `physical_unit` carries its cell in an unstated unit. Judge it from the
 * geometry (lengthUnitGuess.js) and, unless the user has forced a unit with
 * the Length unit selector, ask them to confirm — the guess is right for
 * every ordinary solid but a molecular crystal written in Bohr is genuinely
 * ambiguous, and getting it wrong scales the structure by 1.9x. Dismissing
 * the dialog (Escape, backdrop) takes the guess.
 * @param {any} cellRaw  the cell as written in the file
 * @param {string} fileName
 */
async function resolveUndeclaredUnit(cellRaw, fileName) {
  // Already judged (and possibly confirmed) for this very cell — e.g. an
  // undeclared phonopy.yaml followed by its band.yaml: do not ask twice.
  if (phononState.detectedUnit && sameLattice(phononState.unitAssessment?.lattice, cellRaw?.lattice)) return;
  const assessment = assessLengthUnit(cellRaw, (el) => atomicRadii[el] ?? 1.0);
  assessment.lattice = cellRaw?.lattice?.map((row) => [...row]) ?? null;
  phononState.unitAssessment = assessment;
  if (phononState.lengthUnit !== 'auto') {
    phononState.detectedUnit = assessment.guess;
    phononState.detectedUnitSource = 'geometry';
    return;
  }
  const chosen = await promptLengthUnit(assessment, fileName);
  phononState.detectedUnit = chosen ?? assessment.guess;
  phononState.detectedUnitSource = chosen ? 'user' : 'geometry';
}

function sameLattice(a, b) {
  if (!a || !b || a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) {
    if (Math.abs(a[i][k] - b[i][k]) > 1e-6 * Math.max(1, Math.abs(a[i][k]))) return false;
  }
  return true;
}

function promptLengthUnit(assessment, fileName) {
  const { guess, confidence } = assessment;
  const other = guess === 'angstrom' ? 'bohr' : 'angstrom';
  const name = String(fileName || 'This file').split(/[\\/]/).pop();
  const certainty = confidence === 'high' ? 'almost certainly' : 'probably';
  return choiceDialog(
    `${name} does not say which length unit its cell is in. phonopy keeps the calculator's own unit `
    + `(Å for VASP-family codes, Bohr for QE, abinit, siesta, …) and only phonopy.yaml records which. `
    + `Judged by the interatomic distances, this cell is ${certainty} in ${unitLabel(guess)}.`,
    {
      title: 'Phonon cell: length unit',
      detail: describeReadings(assessment),
      choices: [
        { value: guess, label: `Use ${unitLabel(guess)} (detected)`, description: CALCULATORS[guess] },
        { value: other, label: `Use ${unitLabel(other)}`, description: CALCULATORS[other] },
      ],
      cancelValue: null,
    },
  );
}

/** dataset.cell is always Å for the viewer; cellRaw keeps what the file said. */
function applyUnitsToDataset() {
  const ds = phononState.dataset;
  if (!ds) return;
  if (!ds.cellRaw) ds.cellRaw = ds.cell;
  ds.cell = scaleCell(ds.cellRaw, unitFactor());
  ds.lengthUnitApplied = effectiveLengthUnit();
}

/** Force the cell length unit ('auto' | 'angstrom' | 'bohr') and rebuild. */
export function setLengthUnit(unit) {
  const clean = unit === 'bohr' || unit === 'angstrom' ? unit : 'auto';
  if (clean === phononState.lengthUnit) return;
  phononState.lengthUnit = clean;
  if (phononState.dataset) {
    applyUnitsToDataset();
    rebuildDisplayed();
    // Bohr -> Å is a 1.9x change of the object on screen: refit the view.
    fitCameraToCurrentStructure();
  }
  emit('units');
}

function baseName(fileName) {
  return String(fileName || 'phonopy').split(/[\\/]/).pop().replace(/\.(ya?ml|dat)$/i, '');
}

function rowName() {
  const [n1, n2, n3] = phononState.dims;
  return `phonon_${phononState.sourceName}_${n1}x${n2}x${n3}`;
}

function buildStructure(sc) {
  const elements = [...sc.species];
  const atoms = sc.frac.map((f, i) => new Atom({
    position: [...f],
    element: elements[i],
    uuid: generateID([elements[i]]),
  }));
  return new Structure({
    elements,
    lattice: sc.lattice.map((row) => [...row]),
    atoms,
    periodic: { hash: 'None', wrapped: null },
  });
}

function containerRowIndex() {
  return phononState.container ? structureShip.container.indexOf(phononState.container) : -1;
}

/** Build (or rebuild, after a supercell change) the displayed structure and
 *  make sure it has a file-browser row that is selected. */
function rebuildDisplayed() {
  const { dataset } = phononState;
  if (!dataset?.cell) return null;
  const wasPlaying = phononState.playing;
  stopAnimation({ silent: true });
  const sc = buildSupercell(dataset.cell, phononState.dims);
  const structure = buildStructure(sc);
  phononState.supercell = sc;
  phononState.structure = structure;
  phononState.invLattice = invert3x3(sc.lattice);
  phononState.uBuf = new Float64Array(sc.natom * 3);
  phononState.arrowBuf = new Float64Array(sc.natom * 3);

  if (!phononState.record) phononState.record = {};
  const idx = containerRowIndex();
  if (idx >= 0) {
    const container = phononState.container;
    container.structures[0] = structure;
    container.fileName = rowName();
    const row = document.querySelectorAll('#objectTable tbody tr')[idx];
    if (row) updateRow(row, { name: container.fileName, traj: 1, step: 1 });
    selectStructure(idx, 0);
  } else {
    const container = new StructureContainer({ fileName: rowName(), structures: [structure] });
    // The record must be on the row BEFORE it is registered: registering
    // selects it, which re-evaluates the windows' availability.
    /** @type {any} */ (container).phonon = phononState.record;
    phononState.container = container;
    initializeUIOnLoad(container);
  }
  phononState.record.container = phononState.container;
  /** @type {any} */ (phononState.container).phonon = phononState.record;
  saveToRecord();
  recomputePattern();
  refreshPanelAvailability();
  // A supercell change is a re-tiling of the same mode: keep it moving.
  if (wasPlaying && phononState.pattern) play();
  return phononState.container;
}

/**
 * Entry point for the file loader: `kind` is the io/formats.js descriptor id
 * ('phonopy-modes' | 'phonopy-cells' | 'phonopy-dos'). Returns the
 * StructureContainer the viewer should treat as "what this file loaded".
 * @param {string} text
 * @param {string} fileName
 * @param {string} kind
 */
export async function loadPhonopyFile(text, fileName, kind) {
  if (kind === 'phonopy-dos') {
    phononState.dos = parsePhonopyDos(text);
    saveToRecord();
    emit('dos');
    const container = containerRowIndex() >= 0
      ? phononState.container
      : structureShip.container[fileBrowser.selectedRowIndex] ?? null;
    if (!container) throw new Error('Load the phonopy band.yaml / mesh.yaml before its DOS file.');
    openPhononWindows();
    return container;
  }
  if (kind === 'phonopy-cells') {
    const cells = parsePhonopyCells(text);
    phononState.cells = cells;
    if (cells.lengthUnit) {
      phononState.detectedUnit = cells.lengthUnit;
      phononState.detectedUnitSource = 'phonopy.yaml';
      phononState.unitAssessment = null;
    } else {
      // No physical_unit and an unknown (or absent) calculator: judge the cell.
      await resolveUndeclaredUnit(cells.unit || cells.primitive, fileName);
    }
    if (phononState.dataset && !phononState.dataset.cell) {
      phononState.dataset = withCell(phononState.dataset, cells);
      phononState.dataset.cellRaw = null;
      applyUnitsToDataset();
      const container = rebuildDisplayed();
      emit('dataset');
      openPhononWindows();
      return container;
    }
    if (phononState.dataset) {
      // The dataset was already shown with the assumed unit; phonopy.yaml now
      // says which one the calculator really used.
      applyUnitsToDataset();
      if (containerRowIndex() >= 0) rebuildDisplayed();
      emit('units');
      emit('cells');
      return phononState.container ?? structureShip.container[fileBrowser.selectedRowIndex] ?? null;
    }
    // No band data yet: phonopy.yaml on its own is still a structure file.
    const cell = cells.unit || cells.primitive;
    if (!cell) throw new Error('phonopy.yaml carries no unit_cell / primitive_cell.');
    const sc = buildSupercell(scaleCell(cell, unitFactor()), [1, 1, 1]);
    const container = new StructureContainer({ fileName: baseName(fileName) + ' (unit cell)', structures: [buildStructure(sc)] });
    initializeUIOnLoad(container);
    emit('cells');
    return container;
  }

  let dataset = parsePhonopyModes(text, fileName);
  if (!dataset.cell && phononState.cells) dataset = withCell(dataset, phononState.cells);
  if (!dataset.cell) {
    throw new Error('This phonopy file carries no cell (old phonopy version). Load phonopy.yaml first, then this file again.');
  }
  // Mode files never state their unit. A phonopy.yaml loaded earlier settles
  // it (declared, or already judged and confirmed); otherwise judge this cell.
  if (phononState.detectedUnitSource !== 'phonopy.yaml') {
    await resolveUndeclaredUnit(dataset.cell, fileName);
  }
  // A fresh dataset gets its own row and record; the previous one stays on
  // its row (select that row to get it back).
  saveToRecord();
  phononState.record = {};
  phononState.container = null;
  phononState.structure = null;
  phononState.dims = [1, 1, 1];
  phononState.dataset = dataset;
  applyUnitsToDataset();
  phononState.sourceName = baseName(fileName);
  phononState.selected = null;
  phononState.pattern = null;
  phononState.modeMap = null;
  removePhononArrows();
  const container = rebuildDisplayed();
  if (!dataset.hasEigenvectors) {
    container.loadWarnings = ['This file has frequencies but no eigenvectors, so modes can be plotted but not animated. Re-run phonopy with EIGENVECTORS = .TRUE. (or --eigvecs).'];
  }
  saveToRecord();
  emit('dataset');
  openPhononWindows();
  return container;
}

// Set by ui/PhononPanel.js: opens the controls + plots windows. Kept as a hook
// so this module does not import the panel manager (the panel imports us).
let openWindowsHook = () => {};
export function setOpenWindowsHook(fn) { openWindowsHook = typeof fn === 'function' ? fn : () => {}; }
function openPhononWindows() { openWindowsHook(); }

// ---------------------------------------------------------------------------
// Supercell / mode selection
// ---------------------------------------------------------------------------

export function setDims(dims) {
  const clean = dims.map((n) => Math.min(8, Math.max(1, Math.round(Number(n) || 1))));
  if (clean.every((n, k) => n === phononState.dims[k]) && containerRowIndex() >= 0) return;
  phononState.dims = clean;
  rebuildDisplayed();
  // A different supercell is a different-sized object: refit the view on it
  // (keeping the viewing direction) instead of leaving it half off-screen.
  fitCameraToCurrentStructure();
  emit('dims');
}

/** The dims that make the selected mode's q periodic. */
export function suggestedDims() {
  const sel = selectedQPoint();
  return sel ? commensurateDims(sel.q) : [1, 1, 1];
}

export function selectedQPoint() {
  const { dataset, selected } = phononState;
  if (!dataset || !selected) return null;
  return dataset.qpoints[selected.iq] ?? null;
}

export function selectedFrequency() {
  const qp = selectedQPoint();
  return qp ? qp.freqs[phononState.selected.ib] : NaN;
}

/** The selected mode's eigenvector (6 numbers per primitive atom) or null. */
export function selectedEigenvector() {
  const qp = selectedQPoint();
  if (!qp?.eigvecs) return null;
  const n = phononState.dataset.natom * 6;
  return qp.eigvecs.subarray(phononState.selected.ib * n, (phononState.selected.ib + 1) * n);
}

function recomputePattern() {
  const qp = selectedQPoint();
  const eig = selectedEigenvector();
  if (!qp || !eig || !phononState.supercell) {
    phononState.pattern = null;
    phononState.commensurate = true;
    return;
  }
  phononState.commensurate = isCommensurate(qp.q, phononState.dims);
  phononState.pattern = modePattern(phononState.supercell, qp.q, eig, phononState.argumentDeg);
  animationDisplacement(phononState.pattern, 0, phononState.amplitude, phononState.arrowBuf);
}

/** Select a mode by q-point index and band index; starts the animation. */
export function selectMode(iq, ib, { autoplay = true } = {}) {
  const { dataset } = phononState;
  if (!dataset) return;
  if (!dataset.qpoints[iq] || ib < 0 || ib >= dataset.nbands) return;
  if (containerRowIndex() < 0) rebuildDisplayed();
  phononState.selected = { iq, ib };
  recomputePattern();
  emit('mode');
  if (phononState.pattern && autoplay) play();
  else applyPhase(phononState.phase);
}

export function clearMode() {
  stopAnimation();
  phononState.selected = null;
  phononState.pattern = null;
  removePhononArrows();
  requestRender();
  emit('mode');
}

export function imaginaryModes(tolTHz = 0.05) {
  return phononState.dataset ? listImaginaryModes(phononState.dataset, tolTHz) : [];
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

let rafId = 0;
let lastTime = 0;

function isDisplayed() {
  return !!phononState.structure && fileBrowser.selectedStructure === phononState.structure && containerRowIndex() >= 0;
}

/** Write the mode's displacement at `phase` into the shown structure. */
function applyPhase(phase) {
  const { pattern, structure, supercell } = phononState;
  if (!pattern || !structure || !supercell || !isDisplayed()) return;
  const u = animationDisplacement(pattern, phase, phononState.amplitude, phononState.uBuf);
  const inv = phononState.invLattice;
  const atoms = structure.atoms;
  const base = supercell.frac;
  for (let j = 0; j < atoms.length; j++) {
    const du = cartToFracWithInverse(inv, [u[j * 3], u[j * 3 + 1], u[j * 3 + 2]]);
    // Replace, never mutate: the as-loaded snapshot aliases the initial arrays.
    atoms[j].position = [base[j][0] + du[0], base[j][1] + du[1], base[j][2] + du[2]];
  }
  if (!applyFrameFast(structure)) {
    updateVisualization({
      atomsUpdate: true, bondsUpdate: true, reRenderAtoms: true, reRenderBonds: true,
      reRenderLattice: false, reRenderOther: false, reRenderComposition: false,
      reRenderPolyhedra: general.showPolyhedra || general.completePolyhedra,
    });
  }
  refreshMeasurements();
  refreshArrows();
  requestRender();
}

/** Distance/angle measurements follow the moving atoms (the fast path only
 *  moves atoms and bonds; the full path refreshes them itself, but cheaply
 *  enough to just do it every frame). */
function refreshMeasurements() {
  if (measurements.measureLines.length) updateAllMeasurements();
}

function refreshArrows() {
  if (!phononState.pattern || !isDisplayed() || !phononState.showArrows) {
    removePhononArrows();
    return;
  }
  updatePhononArrows(phononState.structure, phononState.arrowBuf, {
    lengthFactor: phononState.arrowScale,
    radius: phononState.arrowRadius,
    colorHex: phononState.arrowColor,
    colorMap: phononState.arrowColorMap,
    min: phononState.arrowMin,
    max: phononState.arrowMax,
    logColor: phononState.arrowColorScale === 'log',
    logLength: phononState.arrowLengthLog,
  });
}

function tick(now) {
  if (!phononState.playing) { rafId = 0; return; }
  const dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0;
  lastTime = now;
  phononState.phase = (phononState.phase + 2 * Math.PI * phononState.speed * dt) % (2 * Math.PI);
  applyPhase(phononState.phase);
  rafId = requestAnimationFrame(tick);
}

export function play() {
  if (!phononState.pattern) return;
  if (phononState.playing) return;
  phononState.playing = true;
  lastTime = 0;
  if (!rafId) rafId = requestAnimationFrame(tick);
  emit('playing');
}

export function pause() {
  if (!phononState.playing) return;
  phononState.playing = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  emit('playing');
}

/** Stop and put the atoms back on their equilibrium sites. */
export function stopAnimation({ silent = false } = {}) {
  const wasPlaying = phononState.playing;
  phononState.playing = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  phononState.phase = 0;
  if (phononState.structure && phononState.supercell && isDisplayed()) {
    phononState.structure.atoms.forEach((atom, j) => { atom.position = [...phononState.supercell.frac[j]]; });
    if (!applyFrameFast(phononState.structure)) {
      updateVisualization({ atomsUpdate: true, bondsUpdate: true, reRenderAtoms: true, reRenderBonds: true, reRenderLattice: false, reRenderOther: false, reRenderComposition: false, reRenderPolyhedra: general.showPolyhedra || general.completePolyhedra });
    }
    refreshMeasurements();
    refreshArrows();
    requestRender();
  }
  if (!silent && wasPlaying) emit('playing');
}

export function setAmplitude(a) {
  phononState.amplitude = Math.max(0, Number(a) || 0);
  if (phononState.pattern) animationDisplacement(phononState.pattern, 0, phononState.amplitude, phononState.arrowBuf);
  if (!phononState.playing) applyPhase(phononState.phase);
  emit('amplitude');
}

export function setSpeed(s) {
  phononState.speed = Math.max(0.01, Number(s) || 1);
  emit('speed');
}

export function setArgument(deg) {
  phononState.argumentDeg = Number(deg) || 0;
  recomputePattern();
  if (!phononState.playing) applyPhase(phononState.phase);
  emit('mode');
}

export function setShowArrows(on) {
  phononState.showArrows = !!on;
  refreshArrows();
  requestRender();
  emit('arrows');
}

export function setArrowScale(s) {
  phononState.arrowScale = Math.max(0, Number(s) || 0);
  refreshArrows();
  requestRender();
  emit('arrows');
}

export function setArrowColorMap(name) {
  phononState.arrowColorMap = name ? String(name) : 'solid';
  refreshArrows();
  requestRender();
  emit('arrows');
}

export function setArrowRadius(r) {
  phononState.arrowRadius = Math.min(0.5, Math.max(0.005, Number(r) || 0.08));
  refreshArrows();
  requestRender();
  emit('arrows');
}

export function setArrowLengthLog(on) {
  phononState.arrowLengthLog = !!on;
  refreshArrows();
  requestRender();
  emit('arrows');
}

/** Colour/length range in Å of displacement. `auto` false marks a range the
 *  user typed (kept until Auto Range); true is a computed one. */
export function setArrowRange(min, max, { auto = false } = {}) {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  if (lo > hi) [lo, hi] = [hi, lo];
  phononState.arrowMin = lo;
  phononState.arrowMax = hi;
  phononState.arrowRangeAuto = !!auto;
  refreshArrows();
  requestRender();
  emit('arrows');
}

export function setArrowColorScale(scale) {
  phononState.arrowColorScale = scale === 'log' ? 'log' : 'linear';
  // log10(0) is -Infinity: floor the range the moment log turns on.
  if (phononState.arrowColorScale === 'log' && phononState.arrowMin <= 0) phononState.arrowMin = 0.001;
  refreshArrows();
  requestRender();
  emit('arrows');
}

/** Per-atom displacement magnitudes (Å) of the selected mode at phase 0 —
 *  what the arrows' length and colour are mapped from. */
export function arrowMagnitudes() {
  const buf = phononState.arrowBuf;
  if (!phononState.pattern || !buf) return [];
  const out = [];
  for (let j = 0; j + 2 < buf.length; j += 3) out.push(Math.sqrt(buf[j] ** 2 + buf[j + 1] ** 2 + buf[j + 2] ** 2));
  return out;
}

export function setArrowColor(hex) {
  phononState.arrowColor = String(hex || DEFAULT_ARROW_COLOR);
  refreshArrows();
  requestRender();
  emit('arrows');
}

/** Freeze the animation at the current phase (a static snapshot of the
 *  displaced structure the user can save with the normal Download menu). */
export function freezeAtPhase(phase) {
  pause();
  phononState.phase = Number(phase) || 0;
  applyPhase(phononState.phase);
}

// Arrows belong to OUR structure only: when the user switches to another row
// they must not float over it; when they come back the pattern is redrawn.
onActiveStructureChange(() => {
  const record = activePhononRecord();
  if (record && record !== phononState.record) activateRecord(record);
  if (isDisplayed()) {
    if (phononState.pattern) applyPhase(phononState.phase);
  } else {
    removePhononArrows();
  }
});

/** Human-readable label for a q-point ("Γ", "X" …) from band.yaml's labels,
 *  or its reduced coordinates. */
export function qLabel(iq) {
  const { dataset } = phononState;
  if (!dataset) return '';
  const qp = dataset.qpoints[iq];
  if (!qp) return '';
  const coords = `(${qp.q.map((v) => formatQ(v)).join(', ')})`;
  if (dataset.kind !== 'band' || !dataset.labels) return coords;
  let start = 0;
  for (let s = 0; s < dataset.segments.length; s++) {
    const n = dataset.segments[s];
    const [a, b] = dataset.labels[s] || [];
    if (iq === start && a) return `${prettyLabel(a)} ${coords}`;
    if (iq === start + n - 1 && b) return `${prettyLabel(b)} ${coords}`;
    start += n;
  }
  return coords;
}

const GREEK = {
  Gamma: 'Γ', Delta: 'Δ', Sigma: 'Σ', Lambda: 'Λ', Theta: 'Θ', Pi: 'Π', Omega: 'Ω', Phi: 'Φ', Psi: 'Ψ', Xi: 'Ξ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π',
  sigma: 'σ', omega: 'ω', phi: 'φ', psi: 'ψ', xi: 'ξ',
};
const SUBSCRIPT = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋',
  a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ', i: 'ᵢ', r: 'ᵣ', u: 'ᵤ', v: 'ᵥ', j: 'ⱼ',
};
const SUPERSCRIPT = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ',
};

/**
 * Turn phonopy's LaTeX-flavoured band labels ("$\Gamma$", "$\mathrm{P}_0$",
 * "X_1") into plain text (Unicode Greek and sub/superscripts) or, with
 * `html`, into Plotly-safe HTML with <sub>/<sup>.
 * @param {string} raw
 * @param {{html?: boolean}} [opts]
 */
export function prettyLabel(raw, { html = false } = {}) {
  let s = String(raw ?? '').replace(/\$/g, '');
  if (html) s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/\\(?:mathrm|mathit|mathbf|mathsf|text|textrm|rm|it|bf|overline|bar)\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\([A-Za-z]+)/g, (_, name) => GREEK[name] ?? name);
  const sub = (t) => (html ? `<sub>${t}</sub>` : [...t].map((c) => SUBSCRIPT[c] ?? c).join(''));
  const sup = (t) => (html ? `<sup>${t}</sup>` : [...t].map((c) => SUPERSCRIPT[c] ?? c).join(''));
  s = s.replace(/_\{([^{}]*)\}/g, (_, t) => sub(t)).replace(/_([A-Za-z0-9+-])/g, (_, t) => sub(t));
  s = s.replace(/\^\{([^{}]*)\}/g, (_, t) => sup(t)).replace(/\^([A-Za-z0-9+-])/g, (_, t) => sup(t));
  return s.replace(/[{}\\]/g, '').trim();
}

function formatQ(v) {
  const r = Math.round(v * 1e4) / 1e4;
  return String(Number.isInteger(r) ? r : r.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
}

export function setQConvention(conv) {
  phononState.qConvention = conv === 'phonopy' ? 'phonopy' : 'normal';
  emit('convention');
}

export function setEnergyPerAtom(on) {
  phononState.energyPerAtom = !!on;
  emit('convention');
}

/** Store the latest mode-map result (ui/PhononPanel.js) and tell the plots window. */
export function setModeMap(modeMap) {
  phononState.modeMap = modeMap;
  emit('modemap');
}

/** Whether a structure in the viewer is the phonon supercell row. */
export function isPhononStructure(structure) {
  return !!structure && structure === phononState.structure;
}
