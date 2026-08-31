/**
 * Compact storage for the physics of an MD/relaxation trajectory.
 *
 * A trajectory used to be stored as one fully-materialised Structure per frame
 * — measured on a 110 MB / 1790-frame OUTCAR that is ~1.8 GB of heap, of which
 * only ~57 MB is actual physics (positions, forces, moments as doubles). This
 * class keeps exactly that 57 MB: flat Float64Arrays over all frames, plus the
 * per-frame scalars (energy, stress, lattice) and the trajectory-wide
 * identity (elements, spin frame) that every frame shares.
 *
 * It stores no model objects and no styles. Frames become Structures on
 * demand through model/materializeFrame.js, and which frames exist as
 * Structures at any moment is the containing TrajectoryContainer's business.
 *
 * The accessor contract is deliberately duck-typed: `getFramePhysics(i)`
 * returns the FramePhysics record synchronously here, but a source that reads
 * frames from disk may return a Promise of one instead — callers that can meet
 * both go through TrajectoryContainer, which handles either.
 *
 * @typedef {{
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
// with its own module graph) and are trivial; the math/index.js facade's
// backend indirection buys nothing here.
import { multiplyMatVec } from '../math/backend-js.js';

export class TrajectoryFrameStore {
  /**
   * Prefer `fromParsedSteps`; this constructor takes already-packed arrays.
   * @param {{
   *   natoms: number,
   *   frameCount: number,
   *   elements: string[],
   *   uniqueElements: string[],
   *   spinFrame: {fileSaxis: number[]},
   *   positions: Float64Array,
   *   forces?: Float64Array | null,
   *   spinVectors?: Float64Array | null,
   *   spinRaw?: Float64Array | null,
   *   lattices: Float64Array,
   *   energies: Float64Array,
   *   stresses?: Float64Array | null,
   * }} init
   */
  constructor(init) {
    this.natoms = init.natoms;
    this.frameCount = init.frameCount;
    /** Shared across frames — a trajectory cannot change composition. */
    this.elements = init.elements;
    this.uniqueElements = init.uniqueElements;
    this.spinFrame = init.spinFrame;

    const per = this.natoms * 3;
    const expect = (arr, len, name) => {
      if (arr && arr.length !== len) {
        throw new Error(`TrajectoryFrameStore: ${name} has length ${arr.length}, expected ${len}`);
      }
    };
    expect(init.positions, per * this.frameCount, 'positions');
    expect(init.forces, per * this.frameCount, 'forces');
    expect(init.spinVectors, per * this.frameCount, 'spinVectors');
    expect(init.spinRaw, per * this.frameCount, 'spinRaw');
    expect(init.lattices, 9 * this.frameCount, 'lattices');
    expect(init.energies, this.frameCount, 'energies');
    expect(init.stresses, 9 * this.frameCount, 'stresses');

    /** @type {Float64Array} frameCount*natoms*3, fractional */
    this.positions = init.positions;
    /** @type {Float64Array | null} frameCount*natoms*3, eV/A cartesian */
    this.forces = init.forces ?? null;
    /** @type {Float64Array | null} frameCount*natoms*3, global cartesian */
    this.spinVectors = init.spinVectors ?? null;
    /** @type {Float64Array | null} frameCount*natoms*3, file (SAXIS) frame */
    this.spinRaw = init.spinRaw ?? null;
    /** @type {Float64Array} frameCount*9, row-major 3x3 per frame */
    this.lattices = init.lattices;
    /** @type {Float64Array} frameCount; NaN = unknown */
    this.energies = init.energies;
    /** @type {Float64Array | null} frameCount*9; all-NaN row = none */
    this.stresses = init.stresses ?? null;
  }

  get hasSpins() { return this.spinRaw !== null; }
  get hasForces() { return this.forces !== null; }

  /**
   * The physics of one frame, as zero-copy views into the flat arrays plus
   * small fresh objects for the 3x3s. Callers must not mutate the views.
   * @param {number} i
   * @returns {FramePhysics}
   */
  getFramePhysics(i) {
    if (!(i >= 0 && i < this.frameCount)) {
      throw new Error(`TrajectoryFrameStore: frame ${i} out of range 0..${this.frameCount - 1}`);
    }
    const per = this.natoms * 3;
    const a = i * per, b = a + per;
    const L = this.lattices.subarray(i * 9, i * 9 + 9);
    const lattice = [[L[0], L[1], L[2]], [L[3], L[4], L[5]], [L[6], L[7], L[8]]];
    let stress = null;
    if (this.stresses) {
      const S = this.stresses.subarray(i * 9, i * 9 + 9);
      if (Number.isFinite(S[0])) {
        stress = [[S[0], S[1], S[2]], [S[3], S[4], S[5]], [S[6], S[7], S[8]]];
      }
    }
    const e = this.energies[i];
    return {
      lattice,
      positions: this.positions.subarray(a, b),
      forces: this.forces ? this.forces.subarray(a, b) : null,
      spinVectors: this.spinVectors ? this.spinVectors.subarray(a, b) : null,
      spinRaw: this.spinRaw ? this.spinRaw.subarray(a, b) : null,
      energy: Number.isFinite(e) ? e : null,
      stress,
    };
  }

  /** Per-frame energies for plots; NaN where the file gave none. */
  energySeries() {
    return Array.from(this.energies);
  }

  /**
   * A new store over frames [start, end) — used by "copy trajectory rows".
   * The arrays are subarray views, so a slice costs nothing; the source store
   * stays alive as long as any slice of it does.
   * @param {number} start @param {number} end
   */
  slice(start, end) {
    const s = Math.max(0, start), e = Math.min(this.frameCount, end);
    const per = this.natoms * 3;
    const cut = (arr, w) => (arr ? arr.subarray(s * w, e * w) : null);
    return new TrajectoryFrameStore({
      natoms: this.natoms,
      frameCount: Math.max(0, e - s),
      elements: this.elements,
      uniqueElements: this.uniqueElements,
      spinFrame: { fileSaxis: [...this.spinFrame.fileSaxis] },
      positions: cut(this.positions, per),
      forces: cut(this.forces, per),
      spinVectors: cut(this.spinVectors, per),
      spinRaw: cut(this.spinRaw, per),
      lattices: cut(this.lattices, 9),
      energies: cut(this.energies, 1),
      stresses: cut(this.stresses, 9),
    });
  }

  /**
   * Pack the plain per-step records a trajectory parser produces (the shape
   * io/outcarParse.js returns: atoms as {position}, spins as {rawVector},
   * forces as {vector}) into one store. The global-Cartesian spin vectors are
   * computed here from the raw file-frame moments, exactly as the eager
   * loading path does per Spin.
   *
   * @param {Array<{lattice: number[][], atoms: {position: number[]}[],
   *                spins: {rawVector: number[]}[], forces: {vector: number[]}[],
   *                energy: number | null, stress: number[][] | null}>} steps
   * @param {{elements: string[], uniqueElements: string[],
   *          saxisMatrix: number[][], saxis: number[]}} meta
   * @returns {TrajectoryFrameStore}
   */
  static fromParsedSteps(steps, { elements, uniqueElements, saxisMatrix, saxis }) {
    const frameCount = steps.length;
    const natoms = elements.length;
    const per = natoms * 3;
    const positions = new Float64Array(frameCount * per);
    const hasForces = steps.some(s => s.forces && s.forces.length);
    const hasSpins = steps.some(s => s.spins && s.spins.length);
    const forces = hasForces ? new Float64Array(frameCount * per) : null;
    const spinVectors = hasSpins ? new Float64Array(frameCount * per) : null;
    const spinRaw = hasSpins ? new Float64Array(frameCount * per) : null;
    const lattices = new Float64Array(frameCount * 9);
    const energies = new Float64Array(frameCount).fill(NaN);
    const hasStress = steps.some(s => s.stress);
    const stresses = hasStress ? new Float64Array(frameCount * 9).fill(NaN) : null;

    steps.forEach((step, f) => {
      const base = f * per;
      step.atoms.forEach((a, i) => {
        positions[base + i * 3] = a.position[0];
        positions[base + i * 3 + 1] = a.position[1];
        positions[base + i * 3 + 2] = a.position[2];
      });
      if (forces) {
        step.forces.forEach((fo, i) => {
          forces[base + i * 3] = fo.vector[0];
          forces[base + i * 3 + 1] = fo.vector[1];
          forces[base + i * 3 + 2] = fo.vector[2];
        });
      }
      if (spinRaw) {
        step.spins.forEach((sp, i) => {
          const raw = sp.rawVector;
          spinRaw[base + i * 3] = raw[0];
          spinRaw[base + i * 3 + 1] = raw[1];
          spinRaw[base + i * 3 + 2] = raw[2];
          const v = multiplyMatVec(saxisMatrix, raw);
          spinVectors[base + i * 3] = v[0];
          spinVectors[base + i * 3 + 1] = v[1];
          spinVectors[base + i * 3 + 2] = v[2];
        });
      }
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        lattices[f * 9 + r * 3 + c] = step.lattice[r][c];
      }
      if (Number.isFinite(step.energy)) energies[f] = step.energy;
      if (stresses && step.stress) {
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
          stresses[f * 9 + r * 3 + c] = step.stress[r][c];
        }
      }
    });

    return new TrajectoryFrameStore({
      natoms, frameCount,
      elements: [...elements],
      uniqueElements: [...uniqueElements],
      spinFrame: { fileSaxis: [...saxis] },
      positions, forces, spinVectors, spinRaw, lattices, energies, stresses,
    });
  }
}
