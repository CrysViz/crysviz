// Host commands for symmetry, phonons, volumetric fields, slabs and trajectory
// export (commands.js wires them). Each goes through the code the app's own
// windows use; the UI modules are imported on first use so this module stays
// importable in Node for the unit tests.

import { getActiveStructure, getContainerForStructure } from '../state/structures.js';
import { commandError, rowEnvelope } from './commands.js';
import { buildSlab } from '../model/slab.js';

const round = (x, digits = 6) => Math.round(x * 10 ** digits) / 10 ** digits;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function activeStructure() {
  const structure = getActiveStructure();
  if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  return structure;
}

function requirePeriodic(structure) {
  if (!Array.isArray(structure.lattice) || structure.lattice.length !== 3 || structure.periodic === false) {
    throw commandError('NO_LATTICE', 'This needs a periodic structure');
  }
}

const elementOf = (structure, i) => structure.atoms[i]?.getRepresentativeElement?.() ?? structure.elements[i];

// ---- symmetry ----------------------------------------------------------------

async function moyo(tolerance) {
  const sym = await import('../ui/SymmetryEditModule.js');
  const tol = tolerance ?? sym.defaultSymprec();
  if (!isFiniteNumber(tol) || tol <= 0) throw commandError('INVALID_ARGS', 'tolerance must be a positive number (Å)');
  const moyoModule = await import('../ui/BackendPanel/MoyoWASM.js');
  await moyoModule.ensureMoyoReady();
  return { ...moyoModule, tol, describe: (error) => sym.describeMoyoFailure(error, tol) };
}

/** Atom indices by Wyckoff letter (hidden atoms are not part of the analysis). */
export function wyckoffSites(structure, letters) {
  const visible = structure.atoms.map((atom, i) => (atom.hidden ? -1 : i)).filter((i) => i >= 0);
  /** @type {Record<string, number[]>} */
  const sites = {};
  (letters || []).forEach((letter, k) => { (sites[letter] ||= []).push(visible[k]); });
  return { sites, hiddenExcluded: structure.atoms.length - visible.length };
}

export async function getSymmetry(args) {
  const structure = activeStructure();
  requirePeriodic(structure);
  const m = await moyo(args?.tolerance);
  let info;
  try {
    info = m.callMoyo('getSymmetryInfo', m.tol, structure);
  } catch (error) {
    throw commandError('SYMMETRY_FAILED', m.describe(error));
  }
  const { sites, hiddenExcluded } = wyckoffSites(structure, info.wyckoffs);
  // Counts by default: a big cell lists hundreds of indices per letter.
  const wyckoff = args?.listAtoms === true ? sites
    : Object.fromEntries(Object.entries(sites).map(([letter, atoms]) => [letter, atoms.length]));
  return {
    tolerance: m.tol, number: info.spg_number, symbol: info.spg_symbol, hall: info.hall_number,
    pearson: info.pearson, protostructure: info.protostructure, wyckoff, hiddenExcluded,
  };
}

export async function buildSymmetrized(args) {
  const structure = activeStructure();
  requirePeriodic(structure);
  const cell = args?.cell ?? 'conventional';
  if (cell !== 'conventional' && cell !== 'primitive') throw commandError('INVALID_ARGS', 'cell must be conventional or primitive');
  const m = await moyo(args?.tolerance);
  let result;
  try {
    result = m.callMoyo(cell === 'primitive' ? 'getPrimUnit' : 'getConvUnit', m.tol, structure);
  } catch (error) {
    throw commandError('SYMMETRY_FAILED', m.describe(error));
  }
  // The Prim./Conv. Cell buttons' own path: a new, selected row.
  const container = m.newContainerFromSymmetrisation(cell === 'primitive' ? 'prim' : 'conv', result.positions, result.lattice, result.elements);
  return { ...rowEnvelope(container), tolerance: m.tol, number: result.spg_number, symbol: result.spg_symbol };
}

// ---- phonons -------------------------------------------------------------------

const phonons = () => import('../phonon/phononSession.js');

/** The q-point index for an index, "Gamma"/"Γ", or a band-path label. */
export function resolveQPoint(dataset, qpoint) {
  const n = dataset.qpoints.length;
  if (Number.isInteger(qpoint)) {
    if (qpoint < 0 || qpoint >= n) throw commandError('INVALID_ARGS', `qpoint must be 0 to ${n - 1}`);
    return qpoint;
  }
  const name = String(qpoint ?? '').trim();
  if (/^(gamma|γ|g|Γ)$/i.test(name)) {
    const iq = dataset.qpoints.findIndex((q) => q.q.every((x) => Math.abs(x) < 1e-8));
    if (iq < 0) throw commandError('QPOINT_NOT_FOUND', 'This dataset has no Γ point');
    return iq;
  }
  const labelled = labelledQPoints(dataset).find((p) => p.label.toLowerCase() === name.toLowerCase());
  if (!labelled) throw commandError('QPOINT_NOT_FOUND', `No q-point labelled ${name}`);
  return labelled.index;
}

/** The labelled ends of a band path's segments, as q-point indices. */
export function labelledQPoints(dataset) {
  const out = [];
  if (!dataset.labels || !dataset.segments) return out;
  let start = 0;
  dataset.segments.forEach((count, s) => {
    const [a, b] = dataset.labels[s] || [];
    if (a) out.push({ index: start, label: a });
    if (b) out.push({ index: start + count - 1, label: b });
    start += count;
  });
  return out.filter((p, i) => out.findIndex((o) => o.index === p.index) === i);
}

/** The first optical band: the lowest band above the three acoustic ones. */
export function resolveBand(dataset, band) {
  if (band === 'lowest_optical') {
    if (dataset.nbands <= 3) throw commandError('INVALID_ARGS', 'This structure has no optical bands');
    return 3;
  }
  if (!Number.isInteger(band) || band < 0 || band >= dataset.nbands) {
    throw commandError('INVALID_ARGS', `band must be 0 to ${dataset.nbands - 1} or "lowest_optical"`);
  }
  return band;
}

async function phononDataset() {
  const ph = await phonons();
  if (!ph.phononState.dataset) throw commandError('NO_PHONONS', 'No phonon data: load a phonopy band.yaml, mesh.yaml or qpoints.yaml first');
  return ph;
}

export async function getPhononState() {
  const ph = await phonons();
  const s = ph.phononState;
  if (!s.dataset) return { loaded: false };
  const ds = s.dataset;
  const iq = s.selected?.iq ?? resolveQPointSafe(ds);
  return {
    loaded: true, kind: ds.kind, source: s.sourceName, natom: ds.natom, nbands: ds.nbands,
    qpoints: ds.qpoints.length, labelled: labelledQPoints(ds),
    lengthUnit: { unit: s.detectedUnit, source: s.detectedUnitSource },
    hasEigenvectors: ds.hasEigenvectors,
    selected: s.selected ? { qpoint: s.selected.iq, band: s.selected.ib, frequencyTHz: round(ph.selectedFrequency(), 4) } : null,
    frequenciesTHz: { qpoint: iq, q: ds.qpoints[iq].q.map((x) => round(x, 4)), bands: [...ds.qpoints[iq].freqs].map((f) => round(f, 4)) },
    amplitude: s.amplitude, speed: s.speed, playing: s.playing, supercell: s.dims,
  };
}

function resolveQPointSafe(dataset) {
  try { return resolveQPoint(dataset, 'Gamma'); } catch { return 0; }
}

/**
 * set_phonon: the mode (qpoint, band), the animation (play, pause, stop) and
 * its amplitude and speed, in one call, as the Phonons window sets them. A
 * mode given without animate starts playing, as choosing it in the window does.
 */
export async function setPhonon(args) {
  const ph = await phononDataset();
  const ds = ph.phononState.dataset;
  const animate = args?.animate;
  if (animate !== undefined && !['play', 'pause', 'stop'].includes(animate)) throw commandError('INVALID_ARGS', 'set_phonon.animate must be play, pause or stop');
  if (args?.amplitude !== undefined) {
    if (!isFiniteNumber(args.amplitude) || args.amplitude < 0 || args.amplitude > 5) throw commandError('INVALID_ARGS', 'set_phonon.amplitude must be 0 to 5 Å');
    ph.setAmplitude(args.amplitude);
  }
  if (args?.speed !== undefined) {
    if (!isFiniteNumber(args.speed) || args.speed <= 0) throw commandError('INVALID_ARGS', 'set_phonon.speed must be a positive number of cycles per second');
    ph.setSpeed(args.speed);
  }
  if (args?.qpoint !== undefined || args?.band !== undefined) {
    if (!ds.hasEigenvectors) throw commandError('NO_EIGENVECTORS', 'This phonon file has no eigenvectors, so modes cannot be shown');
    const iq = resolveQPoint(ds, args.qpoint ?? 'Gamma');
    const ib = resolveBand(ds, args.band ?? 'lowest_optical');
    ph.selectMode(iq, ib, { autoplay: animate === undefined || animate === 'play' });
  }
  if (animate === 'play') ph.play();
  else if (animate === 'pause') ph.pause();
  else if (animate === 'stop') ph.stopAnimation();
  const st = ph.phononState;
  return {
    mode: st.selected ? {
      qpoint: st.selected.iq, band: st.selected.ib, q: ds.qpoints[st.selected.iq].q.map((x) => round(x, 4)),
      frequencyTHz: round(ph.selectedFrequency(), 4),
    } : null,
    commensurate: st.commensurate, supercell: st.dims, playing: st.playing, amplitude: st.amplitude, speed: st.speed,
  };
}

export async function buildPhononFrames(args) {
  const ph = await phononDataset();
  const count = args?.count ?? 10;
  if (!Number.isInteger(count) || count < 2 || count > 200) throw commandError('INVALID_ARGS', 'build_phonon_frames.count must be 2 to 200');
  if (args?.amplitude !== undefined) {
    if (!isFiniteNumber(args.amplitude) || args.amplitude < 0 || args.amplitude > 5) throw commandError('INVALID_ARGS', 'build_phonon_frames.amplitude must be 0 to 5 Å');
    ph.setAmplitude(args.amplitude);
  }
  if (!ph.phononState.selected) throw commandError('NO_MODE', 'Choose a mode first with set_phonon {qpoint, band}');
  ph.pause();
  const frames = ph.modeFrames(count);
  if (!frames) throw commandError('NO_MODE', 'The selected mode has no displacement pattern');
  const { iq, ib } = ph.phononState.selected;
  const { createTrajectoryFromFrames } = await import('../ui/addToStructureModule/CommitAtoms.js');
  const container = createTrajectoryFromFrames(frames, `${ph.phononState.sourceName || 'phonon'}_q${iq}_band${ib}`);
  return { ...rowEnvelope(container), amplitude: ph.phononState.amplitude };
}

// ---- volumetric fields -------------------------------------------------------------

async function fieldModule() {
  const field = await import('../ui/FieldPanel.js');
  if (!field.fieldBrowser.availableFields.length) throw commandError('NO_FIELD', 'The active structure has no volumetric field (load a CHGCAR, cube, ... file)');
  return field;
}

/** The field named `label` (made the shown one), or the shown one. */
function chooseField(fieldBrowser, label) {
  if (label === undefined) return fieldBrowser.selectedField ?? fieldBrowser.availableFields[0];
  const index = fieldBrowser.availableFields.findIndex((f) => f.label === label);
  if (index < 0) throw commandError('FIELD_NOT_FOUND', `No field ${label}; get_state include field lists them`);
  if (fieldBrowser.availableFields[index] !== fieldBrowser.selectedField) fieldBrowser.setSelectedField(index);
  return fieldBrowser.availableFields[index];
}

export async function getFieldInfo() {
  const { fieldBrowser } = await import('../ui/FieldPanel.js');
  const fields = fieldBrowser.availableFields;
  const f = fieldBrowser.selectedField;
  return {
    fields: fields.map((x) => x.label),
    selected: f ? { label: f.label, isoValue: f.isoValue, min: f.minValue, max: f.maxValue, grid: [f.nx, f.ny, f.nz], absolute: !!f.useAbsoluteIsoValue } : null,
  };
}

export async function setIsosurface(args) {
  if (!isFiniteNumber(args?.value)) throw commandError('INVALID_ARGS', 'value must be a number');
  const { fieldBrowser, setFieldIsoValue } = await fieldModule();
  const field = chooseField(fieldBrowser, args.field);
  const isoValue = setFieldIsoValue(field, args.value);
  return { field: field.label, isoValue, clamped: isoValue !== args.value, min: field.minValue, max: field.maxValue };
}

/**
 * A plane with Miller indices (h k l) as a unit normal and its distance from the
 * origin: through atom `throughAtom`, at `offset` Å along the normal, or (by
 * default) the first lattice plane.
 */
export function slicePlane(lattice, hkl, { point = null, offset = null } = {}) {
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const [a, b, c] = lattice;
  const [bc, ca, ab] = [cross(b, c), cross(c, a), cross(a, b)];
  const raw = [0, 1, 2].map((k) => hkl[0] * bc[k] + hkl[1] * ca[k] + hkl[2] * ab[k]);
  const len = Math.hypot(...raw);
  if (len < 1e-12) throw commandError('INVALID_ARGS', 'hkl must not be all zero');
  const normal = raw.map((x) => x / len);
  const volume = Math.abs(a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2]);
  let d = volume / len;
  if (point) d = normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2];
  else if (offset !== null) d = offset;
  return { normal, d };
}

/**
 * add_plane: a Crystal Planes plane (h k l) through an atom, at an offset (Å)
 * along its normal, or (default) the first lattice plane. show: "field" colours
 * it with a volumetric field (a 2D slice; field picks which), "plane" (default)
 * draws it plain; cut hides the atoms on one side.
 */
export async function addPlane(args) {
  const structure = activeStructure();
  requirePeriodic(structure);
  const hkl = args?.hkl;
  if (!Array.isArray(hkl) || hkl.length !== 3 || !hkl.every(Number.isInteger)) throw commandError('INVALID_ARGS', 'add_plane.hkl must be three integers');
  const show = args.show ?? 'plane';
  if (show !== 'plane' && show !== 'field') throw commandError('INVALID_ARGS', 'add_plane.show must be plane or field');
  if (args.field !== undefined && show !== 'field') throw commandError('INVALID_ARGS', 'add_plane.field goes with show: "field"');
  const cut = args.cut ?? 'none';
  const { CutModes } = await import('../model/Plane.js');
  const cutMode = { none: CutModes.NONE, along: CutModes.ALONGN, opposite: CutModes.OPPOSITEN }[cut];
  if (cutMode === undefined) throw commandError('INVALID_ARGS', 'add_plane.cut must be none, along or opposite');
  if (args.throughAtom !== undefined && args.offset !== undefined) throw commandError('INVALID_ARGS', 'add_plane takes throughAtom or offset, not both');
  let point = null;
  if (args.throughAtom !== undefined) {
    const i = args.throughAtom;
    if (!Number.isInteger(i) || i < 0 || i >= structure.atoms.length) throw commandError('INVALID_ARGS', `add_plane.throughAtom must be 0 to ${structure.atoms.length - 1}`);
    const p = structure.atoms[i].position;
    point = [0, 1, 2].map((k) => p[0] * structure.lattice[0][k] + p[1] * structure.lattice[1][k] + p[2] * structure.lattice[2][k]);
  }
  if (args.offset !== undefined && !isFiniteNumber(args.offset)) throw commandError('INVALID_ARGS', 'add_plane.offset must be a number (Å)');
  const { normal, d } = slicePlane(structure.lattice, hkl, { point, offset: args.offset ?? null });
  let field = null;
  if (show === 'field') {
    const { fieldBrowser } = await fieldModule();
    field = chooseField(fieldBrowser, args.field);
  }
  const { addPlaneToStructure } = await import('../ui/PlanesPanel.js');
  addPlaneToStructure(structure, { type: 'uvwd', u: normal[0], v: normal[1], w: normal[2], d }, { field, cutMode });
  return { hkl, normal: normal.map((x) => round(x)), d: round(d), show, cut, field: field?.label ?? null, planeCount: structure.planes.length };
}

// ---- slabs -----------------------------------------------------------------------

export async function buildSlabCommand(args) {
  const structure = activeStructure();
  requirePeriodic(structure);
  const { hkl, layers = 4, vacuum = 15 } = args ?? {};
  if (!Array.isArray(hkl) || hkl.length !== 3 || !hkl.every(Number.isInteger) || hkl.every((x) => x === 0)) {
    throw commandError('INVALID_ARGS', 'hkl must be three integers, not all zero');
  }
  if (!Number.isInteger(layers) || layers < 1 || layers > 50) throw commandError('INVALID_ARGS', 'layers must be 1 to 50');
  if (!isFiniteNumber(vacuum) || vacuum < 0 || vacuum > 200) throw commandError('INVALID_ARGS', 'vacuum must be 0 to 200 Å');
  if (structure.atoms.some((atom) => atom.isDisordered?.())) {
    throw commandError('DISORDERED', 'Slabs need an ordered structure (use run_ordering first)');
  }
  let slab;
  try {
    slab = buildSlab({
      lattice: structure.lattice, positions: structure.atoms.map((a) => a.position),
      elements: structure.atoms.map((_, i) => elementOf(structure, i)),
    }, { hkl, layers, vacuum });
  } catch (error) {
    throw commandError('SLAB_FAILED', error.message);
  }
  if (slab.positions.length > 20000) throw commandError('TOO_LARGE', `The slab would have ${slab.positions.length} atoms`);
  const name = `slab_${hkl.join('')}_${String(getContainerForStructure(structure)?.fileName ?? 'structure')}`;
  const { createNewStructureFromAtoms } = await import('../ui/addToStructureModule/CommitAtoms.js');
  createNewStructureFromAtoms(slab.positions.map((p, i) => ({ element: slab.elements[i], x: p[0], y: p[1], z: p[2] })),
    { lattice: slab.lattice, fileName: name });
  return {
    ...rowEnvelope(getContainerForStructure(getActiveStructure())), layers,
    thickness: round(slab.thickness, 4), vacuum, c: round(slab.lattice[2][2], 4),
    note: 'c is along the surface normal; the slab sits centred with the vacuum as one gap along c.',
  };
}
