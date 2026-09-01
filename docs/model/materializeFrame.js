/**
 * Trajectory frame life cycle: materialise a frame's Structure from its
 * physics, and capture/reproduce the user's per-frame changes as a SPARSE
 * style record.
 *
 * TrajectoryContainer keeps exactly ONE Structure alive for rendering. When
 * the shown frame changes, the outgoing frame's deviations from the
 * as-loaded defaults are extracted into a small plain record
 * (`extractFrameStyles`) and the incoming frame is reproduced by writing its
 * physics into the live Structure and re-applying its stored record
 * (`applyFrameStyles`). Nothing is ever compared BETWEEN frames and no
 * second Structure is built — an untouched frame extracts to `null` and
 * costs nothing.
 *
 * What a record captures (only when it deviates): per-atom style fields and
 * positions, per-arrow user overrides (userColor/userMaterial/hidden), the
 * per-structure style dicts, the lattice, polyhedra settings, and REFERENCES
 * to attached state (volumetric fields, planes, symmetry, velocities).
 * Deliberately NOT captured, because rendering recomputes them on every
 * display and recording them would bloat the records on plain playback:
 * bonds, the computed polyhedra model, colormap-driven spin/force `.color`
 * (a user's explicit pick lands in `userColor`, which IS captured),
 * atomImages/bondMapping/coordination/wyckoff caches, and spin vector
 * reprojections (recomputed from the raw file-frame moments).
 */

import { Structure } from './Structure.js';
import { Atom } from './Atom.js';
import { Spin } from './Spin.js';
import { Force } from './Force.js';
import { Stress } from './Stress.js';

/** @typedef {import('./TrajectoryFrameStore.js').FramePhysics} FramePhysics */

/**
 * Per-trajectory uuid base, minted once per frame source and NOT registered
 * anywhere. Deliberately not utils' generateID: that routes every id through
 * the global `usedIDs` Set, which is never pruned, and frames here are
 * rebuilt over and over. Atom uuids derive as `${element}-${base}-a${index}`:
 * stable across rebuilds (the same physical atom keeps its id), unique
 * within any structure by index, unique across coexisting structures by
 * base, and — with dashes stripped — within the 16-byte cap the GPU picking
 * attribute encodes (render/AtomsFracUpdateModule.js).
 * @param {object} store
 * @returns {string}
 */
function uuidBaseFor(store) {
  if (!store._frameUuidBase) {
    store._frameUuidBase = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  }
  return store._frameUuidBase;
}

/**
 * @param {{elements: string[], uniqueElements: string[],
 *          spinFrame: {fileSaxis: number[]}}} store the frame source's shared
 *   identity (a TrajectoryFrameStore or any duck-compatible source)
 * @param {FramePhysics} ph one frame's physics (already resolved — pass
 *   store.getFramePhysics(i), awaited if the source is asynchronous)
 * @returns {Structure}
 */
export function materializeFrame(store, ph) {
  const { elements, uniqueElements, spinFrame } = store;
  const uuidBase = uuidBaseFor(store);
  const atoms = elements.map((element, i) => new Atom({
    position: [ph.positions[i * 3], ph.positions[i * 3 + 1], ph.positions[i * 3 + 2]],
    element,
    uuid: `${element}-${uuidBase}-a${i}`,
  }));
  // Spin/Force construction mirrors io/ReadOutcarModule.js's eager path: the
  // teal default color, scaling 1.0, vector already rotated into global
  // Cartesian with rawVector keeping the file-frame components.
  const spins = ph.spinRaw
    ? elements.map((_, i) => new Spin({
      vector: [ph.spinVectors[i * 3], ph.spinVectors[i * 3 + 1], ph.spinVectors[i * 3 + 2]],
      rawVector: [ph.spinRaw[i * 3], ph.spinRaw[i * 3 + 1], ph.spinRaw[i * 3 + 2]],
      scaling: 1.0,
      color: "#008080",
    }))
    : [];
  const forces = ph.forces
    ? elements.map((_, i) => new Force({
      vector: [ph.forces[i * 3], ph.forces[i * 3 + 1], ph.forces[i * 3 + 2]],
      scaling: 1.0,
    }))
    : [];

  return new Structure({
    elements: store.elements,
    uniqueElements: [...uniqueElements],
    lattice: ph.lattice.map(row => [...row]),
    atoms,
    spins,
    spinFrame: { fileSaxis: [...spinFrame.fileSaxis] },
    forces,
    energy: ph.energy,
    stress: ph.stress ? new Stress({ tensor: ph.stress.map(row => [...row]) }) : null,
  });
}

/**
 * Write one frame's physics into an existing live Structure, replacing what
 * the previous frame left there. Style state is NOT touched here —
 * applyFrameStyles owns that.
 *
 * Position arrays are REPLACED, never written into: Structure.original's
 * shallow atom copies alias them and deepFreeze froze them, which is also
 * why every position edit in the app assigns a fresh array.
 *
 * @param {Structure} live
 * @param {FramePhysics} ph
 */
export function applyFramePhysics(live, ph) {
  const n = live.atoms.length;
  for (let i = 0; i < n; i++) {
    live.atoms[i].position = [
      ph.positions[i * 3], ph.positions[i * 3 + 1], ph.positions[i * 3 + 2],
    ];
  }
  if (ph.spinRaw && live.spins.length === n) {
    for (let i = 0; i < n; i++) {
      const s = live.spins[i];
      s.vector = [ph.spinVectors[i * 3], ph.spinVectors[i * 3 + 1], ph.spinVectors[i * 3 + 2]];
      s.rawVector = [ph.spinRaw[i * 3], ph.spinRaw[i * 3 + 1], ph.spinRaw[i * 3 + 2]];
    }
  }
  if (ph.forces && live.forces.length === n) {
    for (let i = 0; i < n; i++) {
      live.forces[i].vector = [ph.forces[i * 3], ph.forces[i * 3 + 1], ph.forces[i * 3 + 2]];
    }
  }
  live.lattice = ph.lattice.map(row => [...row]);
  live.energy = ph.energy;
  live.stress = ph.stress ? new Stress({ tensor: ph.stress.map(row => [...row]) }) : null;
}

const nearlyEqual = (a, b) => a === b || Math.abs(a - b) < 1e-12;

/** The per-structure style dicts (mirrors StructureContainer's flush list). */
const STYLE_DICTS = ['bondUserStyles', 'bondCategoryStyles', 'polyhedraUserStyles',
  'polyhedraCategoryStyles', 'atomMaterials', 'atomUserMaterials',
  'spinCategoryStyles', 'forceCategoryStyles', 'atomImageStyles'];

/**
 * The sparse record of one frame's deviations from its as-loaded state.
 * Absent members mean "at default"; a frame with no deviations at all is
 * represented by no record (extract returns null).
 * @typedef {{
 *   atoms?: Map<number, object>,
 *   spins?: Map<number, object>,
 *   forces?: Map<number, object>,
 *   dicts?: Record<string, object>,
 *   lattice?: number[][],
 *   polyhedraSettings?: {useChemicalFilter: boolean, detectCages: boolean},
 *   attached?: {volumetricFields?: object, symmetry?: object,
 *               planes?: object[], velocities?: number[][]},
 * }} FrameStyleRecord
 */

/**
 * Capture a frame's user deviations before the live Structure moves on.
 * Compares only against the frame's own physics and the model classes'
 * construction defaults — never against another frame or a rebuilt copy.
 * ~0.2 ms at 440 atoms; returns null for an untouched frame.
 *
 * @param {Structure} frame the live Structure showing this frame
 * @param {FramePhysics} ph that frame's physics
 * @returns {FrameStyleRecord | null}
 */
export function extractFrameStyles(frame, ph) {
  /** @type {any} */
  const rec = {};

  /** @type {Map<number, object>} */
  const atoms = new Map();
  frame.atoms.forEach((a, i) => {
    /** @type {Record<string, any>} */
    const d = {};
    if (a.userColor !== null) d.userColor = a.userColor;
    if (a.hidden) d.hidden = true;
    if (a.cutPlaneImmune) d.cutPlaneImmune = true;
    if (a.color !== a.defaultColor) d.color = a.color;
    if (a.elementColor !== a.defaultColor) d.elementColor = a.elementColor;
    if (a.opacity !== 1) d.opacity = a.opacity;
    if (a.elementOpacity !== 1) d.elementOpacity = a.elementOpacity;
    if (a.radiusScale !== 1) d.radiusScale = a.radiusScale;
    const sp = a.species;
    if (sp.length !== 1 || sp[0].occupancy !== 1 || sp[0].oxidationState !== null
      || sp[0].color !== null) {
      d.species = sp.map(s => ({ ...s }));
    }
    const p = a.position;
    if (!nearlyEqual(p[0], ph.positions[i * 3])
      || !nearlyEqual(p[1], ph.positions[i * 3 + 1])
      || !nearlyEqual(p[2], ph.positions[i * 3 + 2])) {
      d.position = [...p];
    }
    if (Object.keys(d).length) atoms.set(i, d);
  });
  if (atoms.size) rec.atoms = atoms;

  const arrows = (list) => {
    /** @type {Map<number, object>} */
    const m = new Map();
    list.forEach((x, i) => {
      /** @type {Record<string, any>} */
      const d = {};
      if (x.userColor !== null) d.userColor = x.userColor;
      if (x.userMaterial !== null) d.userMaterial = x.userMaterial;
      if (x.hidden) d.hidden = true;
      if (Object.keys(d).length) m.set(i, d);
    });
    return m.size ? m : null;
  };
  const spins = arrows(frame.spins);
  if (spins) rec.spins = spins;
  const forces = arrows(frame.forces);
  if (forces) rec.forces = forces;

  for (const k of STYLE_DICTS) {
    const dict = frame[k];
    if (dict && Object.keys(dict).length) {
      (rec.dicts ??= {})[k] = dict;
    }
  }

  outer:
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (!nearlyEqual(frame.lattice[r][c], ph.lattice[r][c])) {
        rec.lattice = frame.lattice.map(row => [...row]);
        break outer;
      }
    }
  }

  const ps = frame.polyhedraSettings;
  if (ps && (ps.useChemicalFilter !== true || ps.detectCages !== true)) {
    rec.polyhedraSettings = { ...ps };
  }

  // Attached state travels by reference — it belongs to the frame, and
  // rebuilding it (a loaded WAVECAR band, a computed symmetry) is either
  // impossible or expensive.
  if (frame.volumetricFields || frame.symmetry || frame.planes?.length || frame.velocities) {
    rec.attached = {};
    if (frame.volumetricFields) rec.attached.volumetricFields = frame.volumetricFields;
    if (frame.symmetry) rec.attached.symmetry = frame.symmetry;
    if (frame.planes?.length) rec.attached.planes = frame.planes;
    if (frame.velocities) rec.attached.velocities = frame.velocities;
  }

  return Object.keys(rec).length ? rec : null;
}

/**
 * Reset a Structure's style state to as-loaded defaults, then reproduce the
 * frame's stored deviations. Always resets — the live Structure may carry
 * the previous frame's styles, and "no record" must mean "pristine".
 *
 * @param {Structure} frame
 * @param {FrameStyleRecord | null} rec
 */
export function applyFrameStyles(frame, rec) {
  frame.atoms.forEach((a, i) => {
    const d = /** @type {any} */ (rec?.atoms?.get(i));
    a.userColor = d?.userColor ?? null;
    a.hidden = d?.hidden ?? false;
    a.cutPlaneImmune = d?.cutPlaneImmune ?? false;
    a.color = d?.color ?? a.defaultColor;
    a.elementColor = d?.elementColor ?? a.defaultColor;
    a.opacity = d?.opacity ?? 1;
    a.elementOpacity = d?.elementOpacity ?? 1;
    a.radiusScale = d?.radiusScale ?? 1;
    if (d?.species) {
      a.species = d.species.map((/** @type {object} */ s) => ({ ...s }));
    } else if (a.species.length !== 1 || a.species[0].occupancy !== 1
      || a.species[0].oxidationState !== null || a.species[0].color !== null) {
      a.species = [{ element: frame.elements[i], occupancy: 1, oxidationState: null, color: null }];
    }
    if (d?.position) a.position = [...d.position];
  });
  const applyArrows = (/** @type {any[]} */ list, /** @type {Map<number, any> | null} */ m) => {
    list.forEach((x, i) => {
      const d = m?.get(i);
      x.userColor = d?.userColor ?? null;
      x.userMaterial = d?.userMaterial ?? null;
      x.hidden = d?.hidden ?? false;
    });
  };
  applyArrows(frame.spins, rec?.spins ?? null);
  applyArrows(frame.forces, rec?.forces ?? null);

  for (const k of STYLE_DICTS) {
    frame[k] = rec?.dicts?.[k] ?? {};
  }
  if (rec?.lattice) frame.lattice = rec.lattice.map(row => [...row]);
  frame.polyhedraSettings = rec?.polyhedraSettings
    ? { ...rec.polyhedraSettings }
    : { useChemicalFilter: true, detectCages: true };

  frame.volumetricFields = rec?.attached?.volumetricFields ?? null;
  frame.symmetry = rec?.attached?.symmetry ?? null;
  frame.planes = rec?.attached?.planes ?? [];
  frame.velocities = rec?.attached?.velocities ?? null;
  // Derived render/analysis state from the previous frame must not leak in.
  frame.polyhedra = null;
}
