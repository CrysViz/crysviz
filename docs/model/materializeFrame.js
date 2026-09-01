/**
 * Turn one frame of a TrajectoryFrameStore into an ordinary, fully-featured
 * Structure — the same objects the eager loading path builds, so nothing
 * downstream (rendering, styling panels, reset paths) can tell the difference.
 * Measured cost: ~2.5 ms for a 440-atom frame, invisible next to the full
 * re-render a frame switch already triggers.
 *
 * Also home to `frameMatchesPristine`, the guard that makes eviction safe:
 * a materialised frame may only be dropped from the cache if it still equals
 * what materialisation would rebuild — i.e. the user never styled or edited
 * it. Anything the comparison cannot vouch for keeps the frame resident;
 * losing memory savings is recoverable, losing a user's edits is not.
 */

import { Structure } from './Structure.js';
import { Atom } from './Atom.js';
import { Spin } from './Spin.js';
import { Force } from './Force.js';
import { Stress } from './Stress.js';

/**
 * Per-trajectory uuid base, minted once per frame source and NOT registered
 * anywhere. Deliberately not utils' generateID: that routes every id through
 * the global `usedIDs` Set, which is never pruned — and frames here are
 * materialised over and over (every view, plus a pristine copy per eviction
 * check), so playback was pumping ~900 never-released strings into that Set
 * per frame shown. Atom uuids derive as `${element}-${base}-a${index}`:
 * stable across rematerialisations (the same physical atom keeps its id),
 * unique within any structure by index, unique across coexisting structures
 * by base, and — with dashes stripped — within the 16-byte cap the GPU
 * picking attribute encodes (render/AtomsFracUpdateModule.js).
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
 * @param {import('./TrajectoryFrameStore.js').TrajectoryFrameStore} store
 * @param {import('./TrajectoryFrameStore.js').FramePhysics} ph one frame's
 *   physics (already resolved — pass store.getFramePhysics(i), awaited if the
 *   source is asynchronous)
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

const nearlyEqual = (a, b) => a === b || Math.abs(a - b) < 1e-12;

function sameVec3(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return nearlyEqual(a[0], b[0]) && nearlyEqual(a[1], b[1]) && nearlyEqual(a[2], b[2]);
}

function sameMat3(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    if (!nearlyEqual(a[r][c], b[r][c])) return false;
  }
  return true;
}

function emptyDict(d) {
  return !d || Object.keys(d).length === 0;
}

/**
 * Whether a materialised frame is still exactly what materialisation would
 * rebuild — no styling, no edits, nothing attached. Conservative by design:
 * any USER difference (or anything it does not model, like an attached
 * volumetric field) returns false and the frame stays resident.
 *
 * Deliberately IGNORED, because merely displaying a frame writes it and a
 * re-display recomputes it identically — treating it as dirt would pin every
 * frame the trajectory player ever showed and grow memory on plain playback:
 *  - `bonds` and `polyhedra`: rebuilt from scratch on every render; the
 *    user's bond/polyhedra styling persists in the style-store dicts, which
 *    ARE compared;
 *  - spin/force `.color`: colormap-driven at render time (Spin/ForceModule's
 *    updateColor); a user's explicit pick lands in `userColor`, which IS
 *    compared;
 *  - `atomImages`, `bondMapping`/`bondObjectMapping`, `periodic.wrapped`,
 *    `coordination`, `wyckoff`/`hash`: render/analysis caches.
 *
 * @param {Structure} frame the possibly-touched materialised frame
 * @param {Structure} pristine a freshly materialised copy of the same frame
 * @returns {boolean}
 */
export function frameMatchesPristine(frame, pristine) {
  try {
    if (frame.atoms.length !== pristine.atoms.length) return false;
    if (frame.spins.length !== pristine.spins.length) return false;
    if (frame.forces.length !== pristine.forces.length) return false;
    if (!sameMat3(frame.lattice, pristine.lattice)) return false;
    if (frame.energy !== pristine.energy && !(frame.energy == null && pristine.energy == null)) return false;

    // Attached or user-configured state pins the frame. (`polyhedra` — the
    // computed model — is derived and ignored; the SETTINGS are the user's.)
    if (frame.volumetricFields || frame.symmetry) return false;
    if (frame.planes?.length) return false;
    if (frame.velocities) return false;
    if (frame.polyhedraSettings?.useChemicalFilter !== pristine.polyhedraSettings?.useChemicalFilter
      || frame.polyhedraSettings?.detectCages !== pristine.polyhedraSettings?.detectCages) return false;
    for (const k of ['bondUserStyles', 'bondCategoryStyles', 'polyhedraUserStyles',
      'polyhedraCategoryStyles', 'atomMaterials', 'atomUserMaterials',
      'spinCategoryStyles', 'forceCategoryStyles', 'atomImageStyles']) {
      if (!emptyDict(frame[k])) return false;
    }

    for (let i = 0; i < frame.atoms.length; i++) {
      const a = frame.atoms[i], p = pristine.atoms[i];
      if (!sameVec3(a.position, p.position)) return false;
      if (a.element !== p.element) return false;
      if (a.userColor !== null || a.hidden || a.cutPlaneImmune) return false;
      if (a.color !== p.color || a.elementColor !== p.elementColor) return false;
      if (a.opacity !== p.opacity || a.elementOpacity !== p.elementOpacity) return false;
      if (a.radiusScale !== p.radiusScale) return false;
      if (a.species.length !== p.species.length) return false;
      for (let s = 0; s < a.species.length; s++) {
        const as = a.species[s], ps = p.species[s];
        if (as.element !== ps.element || as.occupancy !== ps.occupancy
          || as.oxidationState !== ps.oxidationState || as.color !== ps.color) return false;
      }
    }
    for (let i = 0; i < frame.spins.length; i++) {
      const s = frame.spins[i], p = pristine.spins[i];
      if (!sameVec3(s.vector, p.vector) || !sameVec3(s.rawVector, p.rawVector)) return false;
      if (s.userColor !== null || s.userMaterial !== null || s.hidden) return false;
      if (s.scaling !== p.scaling) return false;
    }
    for (let i = 0; i < frame.forces.length; i++) {
      const f = frame.forces[i], p = pristine.forces[i];
      if (!sameVec3(f.vector, p.vector)) return false;
      if (f.userColor !== null || f.userMaterial !== null || f.hidden) return false;
      if (f.scaling !== p.scaling) return false;
    }
    return true;
  } catch {
    // A comparison that cannot complete must never green-light an eviction.
    return false;
  }
}
