// The average structure: the mean of a set of frames (the Files window's
// ≡ ▸ Average Structure, ui/FileBrowswerPanel.js) — the time-averaged
// structure of an MD run, or the mean of several copies of one structure.
//
// Atoms are matched by index, so every frame must list the same species in
// the same order. Positions are averaged as fractional coordinates, each one
// first moved to its nearest periodic image of the FIRST frame's position
// (minimum image in fractional coordinates, the same convention as
// TrajectoryContainer's motion test): an atom that leaves through one face of
// the cell and comes back through the other is averaged about its site, not
// pulled to the middle of the cell. The cell is averaged component by
// component (constant-cell runs keep theirs exactly). Both are accumulated as
// offsets from the first frame, so whatever does not move stays bit-exact.
// Along the way each atom's largest move away from its first-frame position
// is kept, so the caller can warn about atoms that move more than
// LARGE_DISPLACEMENT of a cell axis: their mean can fall between sites.
//
// PURE: no DOM, no store, no model classes — frames go in as plain records
// (the shape StructureContainer.framePhysicsList() returns) and the mean
// comes out as one; the caller builds the Structure. Frames are added one at
// a time, so the caller need not hold every frame of every row at once.

import { normalizeFractional } from '../math/backend-js.js';

/**
 * Why a frame with `elements` cannot be averaged with frames of `ref`, or
 * null when it can (same atom count, same species in the same order).
 * @param {string[]} ref
 * @param {string[]} elements
 * @returns {string | null}
 */
export function compositionMismatch(ref, elements) {
  if (ref === elements) return null; // frames of one file share the array
  if (ref.length !== elements.length) {
    return `Average Structure needs the same atoms in every frame: one has ${ref.length} atoms, another ${elements.length}.`;
  }
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] !== elements[i]) {
      return `Average Structure needs the same atoms in the same order in every frame: atom ${i + 1} is ${ref[i]} in one and ${elements[i]} in another.`;
    }
  }
  return null;
}

/**
 * An atom that, in some frame, sits more than this fraction of a cell axis
 * (any of a, b, c; minimum image) away from where it is in the first frame
 * makes Average Structure warn before it averages: the mean of such an atom
 * can fall between sites (a hop, diffusion, frames that do not match atom
 * for atom).
 */
export const LARGE_DISPLACEMENT = 0.1;

const AXES = ['a', 'b', 'c'];

/**
 * @typedef {{
 *   elements: string[],
 *   lattice: number[][],
 *   positions: number[][],
 *   species?: Record<number, Array<object>> | null,
 * }} AverageFrame
 * One frame: per-atom elements, the cell as rows a, b, c (Å), fractional
 * positions, and optionally its mixed/partially occupied sites (the sparse
 * model/siteSpecies.js record).
 *
 * @typedef {{
 *   atom: number,
 *   fraction: number,
 *   axis: 'a' | 'b' | 'c',
 *   distance: number,
 *   frame: number,
 *   where: any,
 * }} AtomMove
 * One atom's largest move away from its first-frame position: the largest
 * fractional component of the minimum-image displacement (`fraction`, along
 * `axis`), the length of that displacement in Å in the frame's own cell
 * (`distance`), the frame it happens in (`frame`, counted from 0 over every
 * frame added) and the caller's tag for that frame (`where`, see add()).
 *
 * @typedef {{
 *   elements: string[],
 *   lattice: number[][],
 *   positions: number[][],
 *   species: Record<number, Array<object>> | null,
 *   frameCount: number,
 *   moves: AtomMove[],
 * }} AverageResult
 * The mean: positions wrapped into [0, 1); `species` is the first frame's;
 * `moves` the atoms whose largest move is over the threshold, largest first.
 */

/** Streaming mean of frames: add() each one, then result(). */
export class FrameAverage {
  constructor() {
    /** @type {AverageFrame | null} the first frame, the reference */
    this.ref = null;
    /** @type {Float64Array | null} Σ (minimum-image) offsets from ref, 3 per atom */
    this.offsets = null;
    /** Σ lattice offsets from ref, row-major */
    this.latticeOffsets = new Float64Array(9);
    this.frameCount = 0;
    // Per atom, its largest move so far (AtomMove's fields, column-wise).
    /** @type {Float64Array | null} */ this.moveFraction = null;
    /** @type {Uint8Array | null} */ this.moveAxis = null;
    /** @type {Float64Array | null} */ this.moveDistance = null;
    /** @type {Int32Array | null} */ this.moveFrame = null;
    /** @type {any[]} */ this.moveWhere = [];
  }

  /**
   * Add one frame.
   * @param {AverageFrame} frame
   * @param {any} [where] the caller's tag for this frame (a row and a step),
   *   handed back in the moves of the atoms whose largest move it holds
   * @returns {string | null} why it could not be added (nothing changed), or null
   */
  add(frame, where = null) {
    const { elements, lattice, positions } = frame;
    if (!Array.isArray(elements) || !Array.isArray(positions) || positions.length !== elements.length) {
      return 'Average Structure: a frame has a different number of positions than atoms.';
    }
    if (!this.ref) {
      // A copy: the caller's arrays may be a live structure's.
      this.ref = {
        elements: [...elements],
        lattice: lattice.map((row) => [...row]),
        positions: positions.map((p) => [p[0], p[1], p[2]]),
        species: frame.species ?? null,
      };
      const n = elements.length;
      this.offsets = new Float64Array(n * 3);
      this.moveFraction = new Float64Array(n);
      this.moveAxis = new Uint8Array(n);
      this.moveDistance = new Float64Array(n);
      this.moveFrame = new Int32Array(n);
      this.moveWhere = new Array(n).fill(where);
      this.frameCount = 1;
      return null;
    }
    const why = compositionMismatch(this.ref.elements, elements);
    if (why) return why;

    const ref = this.ref;
    const offsets = /** @type {Float64Array} */ (this.offsets);
    const moveFraction = /** @type {Float64Array} */ (this.moveFraction);
    const d = [0, 0, 0];
    for (let a = 0; a < positions.length; a++) {
      const p = positions[a];
      const r = ref.positions[a];
      let largest = 0;
      let axis = 0;
      for (let k = 0; k < 3; k++) {
        d[k] = p[k] - r[k];
        d[k] -= Math.round(d[k]); // nearest periodic image of the first frame's position
        offsets[a * 3 + k] += d[k];
        if (Math.abs(d[k]) > largest) { largest = Math.abs(d[k]); axis = k; }
      }
      if (largest > moveFraction[a]) {
        moveFraction[a] = largest;
        /** @type {Uint8Array} */ (this.moveAxis)[a] = axis;
        /** @type {Float64Array} */ (this.moveDistance)[a] = cartesianLength(d, lattice);
        /** @type {Int32Array} */ (this.moveFrame)[a] = this.frameCount;
        this.moveWhere[a] = where;
      }
    }
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        this.latticeOffsets[i * 3 + j] += (lattice[i]?.[j] ?? 0) - (ref.lattice[i]?.[j] ?? 0);
      }
    }
    this.frameCount += 1;
    return null;
  }

  /**
   * The atoms whose largest move is over `threshold` (a fraction of a cell
   * axis), largest first (ties: the longer in Å, then the lower index).
   * @param {number} [threshold]
   * @returns {AtomMove[]}
   */
  largeMoves(threshold = LARGE_DISPLACEMENT) {
    const fraction = this.moveFraction;
    if (!fraction) return [];
    /** @type {AtomMove[]} */
    const moves = [];
    for (let a = 0; a < fraction.length; a++) {
      // Over by more than rounding: 0.95 -> 0.05 is a move of exactly 0.1,
      // which the subtraction makes 0.1000000000000001.
      if (!(fraction[a] > threshold + 1e-9)) continue;
      moves.push({
        atom: a,
        fraction: fraction[a],
        axis: /** @type {'a' | 'b' | 'c'} */ (AXES[/** @type {Uint8Array} */ (this.moveAxis)[a]]),
        distance: /** @type {Float64Array} */ (this.moveDistance)[a],
        frame: /** @type {Int32Array} */ (this.moveFrame)[a],
        where: this.moveWhere[a],
      });
    }
    return moves.sort((x, y) => (y.fraction - x.fraction) || (y.distance - x.distance) || (x.atom - y.atom));
  }

  /** The mean of the frames added so far, or null before the first.
   *  @param {number} [threshold] what counts as a large move (largeMoves)
   *  @returns {AverageResult | null} */
  result(threshold = LARGE_DISPLACEMENT) {
    const ref = this.ref;
    if (!ref) return null;
    const n = this.frameCount;
    const offsets = /** @type {Float64Array} */ (this.offsets);
    const positions = ref.positions.map((r, a) => [0, 1, 2].map((k) =>
      normalizeFractional(r[k] + offsets[a * 3 + k] / n)));
    const lattice = [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
      (ref.lattice[i]?.[j] ?? 0) + this.latticeOffsets[i * 3 + j] / n));
    return {
      elements: [...ref.elements],
      lattice,
      positions,
      species: ref.species,
      frameCount: n,
      moves: this.largeMoves(threshold),
    };
  }
}

/** Length in Å of the fractional displacement `d` in the cell `lattice`
 *  (rows a, b, c). */
function cartesianLength(d, lattice) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 3; k++) {
    const row = lattice[k] ?? [0, 0, 0];
    x += d[k] * (row[0] ?? 0);
    y += d[k] * (row[1] ?? 0);
    z += d[k] * (row[2] ?? 0);
  }
  return Math.hypot(x, y, z);
}

/**
 * The mean of `frames` in one go (see FrameAverage). Each frame's tag in
 * the moves is its index in `frames`.
 * @param {Iterable<AverageFrame>} frames
 * @param {number} [threshold] what counts as a large move
 * @returns {AverageResult | { error: string }}
 */
export function averageFrames(frames, threshold = LARGE_DISPLACEMENT) {
  const average = new FrameAverage();
  let i = 0;
  for (const frame of frames) {
    const error = average.add(frame, i++);
    if (error) return { error };
  }
  return average.result(threshold) ?? { error: 'Average Structure: there are no frames to average.' };
}
