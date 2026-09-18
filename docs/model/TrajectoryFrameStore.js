/**
 * Compact storage for the physics of a trajectory — one self-describing
 * record per frame.
 *
 * A trajectory used to be stored as one fully-materialised Structure per
 * frame — measured on a 110 MB / 1790-frame OUTCAR that is ~1.8 GB of heap,
 * of which only ~76 MB is actual physics. This class keeps exactly that
 * physics: per frame, the element list, a packed Float64Array each for
 * positions / forces / moments, and the small scalars (lattice, energy,
 * stress, spin frame).
 *
 * The layout is deliberately PER FRAME rather than one flat array with a
 * global stride: frames of one trajectory may differ in composition (a
 * combined trajectory, a multi-frame XYZ), and per-frame records support
 * that for a few hundred bytes of extra overhead per frame. Frames with
 * identical composition share their `elements` array by reference (the
 * builders intern it), so the common fixed-composition case pays nothing.
 *
 * It stores no model objects and no styles. Frames become Structures through
 * model/materializeFrame.js; users' per-frame changes live as sparse records
 * in TrajectoryContainer. Everything reproducible from physics + defaults
 * (default atom colors, arrow colors, bonds, ...) is NOT stored anywhere —
 * it is recomputed when the live rendering Structure changes frame.
 *
 * @typedef {{
 *   elements: string[],
 *   spinFrame: {fileSaxis: number[]},
 *   lattice: number[][],
 *   positions: Float64Array,
 *   forces: Float64Array | null,
 *   spinVectors: Float64Array | null,
 *   spinRaw: Float64Array | null,
 *   energy: number | null,
 *   stress: number[][] | null,
 * }} FramePhysics
 */

// Plain JS backend on purpose: these run during load (possibly in a worker
// with its own module graph) and are trivial.
import { multiplyMatVec } from '../math/backend-js.js';

export class TrajectoryFrameStore {
  /** @param {{frames: FramePhysics[]}} init */
  constructor({ frames }) {
    /** @type {FramePhysics[]} */
    this.frames = frames;
  }

  get frameCount() {
    return this.frames.length;
  }

  /**
   * One frame's physics record. Callers read it and must not mutate it —
   * the same record backs every rebuild of that frame.
   * @param {number} i
   * @returns {FramePhysics}
   */
  getFramePhysics(i) {
    const frame = this.frames[i];
    if (!frame) {
      throw new Error(`TrajectoryFrameStore: frame ${i} out of range 0..${this.frameCount - 1}`);
    }
    return frame;
  }

  /** Per-frame energies for plots; NaN where the source gave none. */
  energySeries() {
    return this.frames.map(f => (Number.isFinite(f.energy) ? /** @type {number} */ (f.energy) : NaN));
  }

  get hasSpins() {
    return this.frames.some(f => f.spinRaw !== null);
  }

  get hasForces() {
    return this.frames.some(f => f.forces !== null);
  }

  /** @param {FramePhysics} frame */
  append(frame) {
    this.frames.push(frame);
  }

  /**
   * Pack one ready Structure's physics into a frame record. Only physics —
   * user styling is extracted separately (materializeFrame's
   * extractFrameStyles) into the container's sparse per-frame records.
   * @param {import('./Structure.js').Structure} structure
   * @returns {FramePhysics}
   */
  static packStructure(structure) {
    const n = structure.atoms.length;
    const positions = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = structure.atoms[i].position;
      positions[i * 3] = p[0]; positions[i * 3 + 1] = p[1]; positions[i * 3 + 2] = p[2];
    }
    let forces = null;
    if (structure.forces?.length === n && n > 0) {
      forces = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        const v = structure.forces[i].vector ?? [0, 0, 0];
        forces[i * 3] = v[0]; forces[i * 3 + 1] = v[1]; forces[i * 3 + 2] = v[2];
      }
    }
    let spinVectors = null, spinRaw = null;
    if (structure.spins?.length === n && n > 0) {
      spinVectors = new Float64Array(n * 3);
      spinRaw = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        const s = structure.spins[i];
        const v = s.vector ?? [0, 0, 0];
        const r = s.rawVector ?? v;
        spinVectors[i * 3] = v[0]; spinVectors[i * 3 + 1] = v[1]; spinVectors[i * 3 + 2] = v[2];
        spinRaw[i * 3] = r[0]; spinRaw[i * 3 + 1] = r[1]; spinRaw[i * 3 + 2] = r[2];
      }
    }
    return {
      elements: [...structure.elements],
      spinFrame: { fileSaxis: [...(structure.spinFrame?.fileSaxis ?? [0, 0, 1])] },
      lattice: structure.lattice.map(row => [...row]),
      positions,
      forces,
      spinVectors,
      spinRaw,
      energy: Number.isFinite(structure.energy) ? structure.energy : null,
      stress: structure.stress?.tensor ? structure.stress.tensor.map(row => [...row]) : null,
    };
  }

  /**
   * Pack the plain per-step records a trajectory parser produces (the shape
   * io/outcarParse.js returns: atoms as {position}, spins as {rawVector},
   * forces as {vector}) into one store. The global-Cartesian spin vectors
   * are computed here from the raw file-frame moments. All steps of one
   * parsed file share composition, so every frame shares the one `elements`
   * array by reference.
   *
   * @param {Array<{lattice: number[][], atoms: {position: number[]}[],
   *                spins: {rawVector: number[]}[], forces: {vector: number[]}[],
   *                energy: number | null, stress: number[][] | null}>} steps
   * @param {{elements: string[], saxisMatrix: number[][], saxis: number[]}} meta
   * @returns {TrajectoryFrameStore}
   */
  static fromParsedSteps(steps, { elements, saxisMatrix, saxis }) {
    const natoms = elements.length;
    const sharedElements = [...elements];
    const frames = steps.map((step) => {
      const positions = new Float64Array(natoms * 3);
      step.atoms.forEach((a, i) => {
        positions[i * 3] = a.position[0];
        positions[i * 3 + 1] = a.position[1];
        positions[i * 3 + 2] = a.position[2];
      });
      let forces = null;
      if (step.forces?.length === natoms && natoms > 0) {
        forces = new Float64Array(natoms * 3);
        step.forces.forEach((fo, i) => {
          forces[i * 3] = fo.vector[0]; forces[i * 3 + 1] = fo.vector[1]; forces[i * 3 + 2] = fo.vector[2];
        });
      }
      let spinVectors = null, spinRaw = null;
      if (step.spins?.length === natoms && natoms > 0) {
        spinVectors = new Float64Array(natoms * 3);
        spinRaw = new Float64Array(natoms * 3);
        step.spins.forEach((sp, i) => {
          const raw = sp.rawVector;
          spinRaw[i * 3] = raw[0]; spinRaw[i * 3 + 1] = raw[1]; spinRaw[i * 3 + 2] = raw[2];
          const v = multiplyMatVec(saxisMatrix, raw);
          spinVectors[i * 3] = v[0]; spinVectors[i * 3 + 1] = v[1]; spinVectors[i * 3 + 2] = v[2];
        });
      }
      return {
        elements: sharedElements,
        spinFrame: { fileSaxis: [...saxis] },
        lattice: step.lattice.map(row => [...row]),
        positions,
        forces,
        spinVectors,
        spinRaw,
        energy: Number.isFinite(step.energy) ? step.energy : null,
        stress: step.stress ? step.stress.map(row => [...row]) : null,
      };
    });
    return new TrajectoryFrameStore({ frames });
  }
}
