/**
 * Frame physics served straight from the OUTCAR file on disk.
 *
 * Where TrajectoryFrameStore holds a whole trajectory's physics in RAM
 * (~76 MB for a 110 MB MD run), this source holds only the INDEX — one byte
 * offset plus lattice/energy/stress per frame, a few hundred bytes each — and
 * re-reads a small window of the file whenever a frame's positions, forces or
 * moments are actually needed. Retained memory is therefore near zero and
 * independent of trajectory length; the price is that getFramePhysics is
 * asynchronous on a cache miss (one Blob slice of ~2 frames plus a seeded
 * re-parse, single-digit milliseconds), which the containers and their
 * rewired call sites already tolerate.
 *
 * THE FILE MUST NOT CHANGE ON DISK while it is loaded: the browser keeps the
 * File handle, and a modified/removed file makes later reads fail (Chromium
 * reports ERR_UPLOAD_FILE_CHANGED). That trade-off is accepted deliberately —
 * it is what makes arbitrarily long MD runs viewable at all. A failed window
 * read surfaces as a load error naming this cause.
 *
 * Duck-compatible with TrajectoryFrameStore where TrajectoryContainer needs
 * it: getFramePhysics (async), peekFramePhysics (the sync recent-window cache
 * that keeps eviction's pristine comparison possible), energySeries,
 * hasSpins/hasForces, natoms/frameCount/elements/uniqueElements/spinFrame,
 * and the `forces`/`stresses` fields stepStatsSeries consults (mean force
 * would need a full-file pass and is left out; energy and pressure come from
 * the index).
 */

import { parseOutcarBlob } from './outcarParse.js';
import { multiplyMatVec } from '../math/backend-js.js';

/** @typedef {import('../model/TrajectoryFrameStore.js').FramePhysics} FramePhysics */

/** Recently-read frames kept as FramePhysics. Sized above the containers'
 *  Structure cache so eviction's peek almost always hits (~90 KB each). */
const DEFAULT_PHYSICS_CACHE = 64;

export class StreamingOutcarSource {
  /**
   * @param {{blob: Blob,
   *          index: {frames: Array<{offsetBytes: number, lattice: number[][],
   *                                 energy: number | null, stress: number[][] | null}>,
   *                  elements: string[], uniqueElements: string[],
   *                  ionsPerType: number[], natoms: number},
   *          saxisMatrix: number[][], saxis: number[],
   *          cacheLimit?: number}} init
   */
  constructor({ blob, index, saxisMatrix, saxis, cacheLimit = DEFAULT_PHYSICS_CACHE }) {
    this.blob = blob;
    this._frames = index.frames;
    this.natoms = index.natoms;
    this.frameCount = index.frames.length;
    this.elements = [...index.elements];
    this.uniqueElements = [...index.uniqueElements];
    this._ionsPerType = [...index.ionsPerType];
    this.spinFrame = { fileSaxis: [...saxis] };
    this._saxisMatrix = saxisMatrix;

    // The parser always emits per-atom moment/force records (zeros when the
    // run is non-magnetic), so parity with the RAM store means both true.
    this.hasSpins = true;
    this.hasForces = true;
    // stepStatsSeries reads these fields: bulk per-atom arrays don't exist
    // here (mean force would need a full-file pass), but the per-frame
    // scalars do.
    this.forces = null;
    this.spinVectors = null;
    this.spinRaw = null;
    this.positions = null;
    this.energies = new Float64Array(this.frameCount).fill(NaN);
    this.stresses = index.frames.some(f => f.stress)
      ? new Float64Array(this.frameCount * 9).fill(NaN)
      : null;
    index.frames.forEach((f, i) => {
      if (Number.isFinite(f.energy)) this.energies[i] = f.energy;
      if (this.stresses && f.stress) {
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
          this.stresses[i * 9 + r * 3 + c] = f.stress[r][c];
        }
      }
    });

    /** @type {Map<number, FramePhysics>} step -> recently-read physics */
    this._cache = new Map();
    /** @type {Map<number, Promise<FramePhysics>>} in-flight window reads */
    this._inflight = new Map();
    this._cacheLimit = Math.max(4, cacheLimit);
  }

  /** Per-frame energies for plots; NaN where the file gave none. */
  energySeries() {
    return Array.from(this.energies);
  }

  /**
   * The synchronous side: a frame's physics if a recent read still holds it,
   * else null. Lets TrajectoryContainer's eviction run its pristine
   * comparison without forcing a disk read.
   * @param {number} i
   * @returns {FramePhysics | null}
   */
  peekFramePhysics(i) {
    const hit = this._cache.get(i);
    if (hit) {
      // Refresh recency (Map iteration order is insertion order).
      this._cache.delete(i);
      this._cache.set(i, hit);
    }
    return hit ?? null;
  }

  /**
   * One frame's physics. Synchronous on a cache hit; otherwise a Promise for
   * a window read + seeded re-parse. Concurrent requests for the same frame
   * share one read.
   * @param {number} i
   * @returns {FramePhysics | Promise<FramePhysics>}
   */
  getFramePhysics(i) {
    if (!(i >= 0 && i < this.frameCount)) {
      throw new Error(`StreamingOutcarSource: frame ${i} out of range 0..${this.frameCount - 1}`);
    }
    const hit = this.peekFramePhysics(i);
    if (hit) return hit;
    const inflight = this._inflight.get(i);
    if (inflight) return inflight;
    const read = this._readFrame(i).then(
      (ph) => {
        this._inflight.delete(i);
        this._cache.set(i, ph);
        while (this._cache.size > this._cacheLimit) {
          const oldest = this._cache.keys().next().value;
          this._cache.delete(oldest);
        }
        return ph;
      },
      (err) => {
        this._inflight.delete(i);
        throw err;
      },
    );
    this._inflight.set(i, read);
    return read;
  }

  /**
   * Read and parse the window around frame `i`: from the PREVIOUS frame's
   * POSITION line (so this frame's preceding magnetization block is included)
   * to the NEXT frame's (so its trailing energy/stress lines are). The window
   * parses with seeded header state; its leading partial frame is discarded
   * by taking the last parsed step.
   * @param {number} i
   * @returns {Promise<FramePhysics>}
   */
  async _readFrame(i) {
    const start = i > 0 ? this._frames[i - 1].offsetBytes : 0;
    const end = i + 1 < this.frameCount ? this._frames[i + 1].offsetBytes : this.blob.size;
    let steps;
    try {
      const result = await parseOutcarBlob(this.blob.slice(start, end), undefined, {
        seed: {
          elements: this.elements,
          ionsPerType: this._ionsPerType,
          lattice: this._frames[i].lattice,
        },
      });
      steps = result.structures;
    } catch (err) {
      throw new Error('OUTCAR stream: reading the file failed — if it was modified or '
        + `removed on disk since loading, reload it. (${(err && err.message) || err})`);
    }
    const step = steps && steps.length ? steps[steps.length - 1] : null;
    if (!step || step.atoms.length !== this.natoms) {
      throw new Error(`OUTCAR stream: frame ${i} did not parse from its indexed window — `
        + 'was the file modified on disk since loading?');
    }

    const n = this.natoms;
    const positions = new Float64Array(n * 3);
    const forces = new Float64Array(n * 3);
    const spinRaw = new Float64Array(n * 3);
    const spinVectors = new Float64Array(n * 3);
    for (let a = 0; a < n; a++) {
      const p = step.atoms[a].position;
      positions[a * 3] = p[0]; positions[a * 3 + 1] = p[1]; positions[a * 3 + 2] = p[2];
      const fv = step.forces[a]?.vector ?? [0, 0, 0];
      forces[a * 3] = fv[0]; forces[a * 3 + 1] = fv[1]; forces[a * 3 + 2] = fv[2];
      const raw = step.spins[a]?.rawVector ?? [0, 0, 0];
      spinRaw[a * 3] = raw[0]; spinRaw[a * 3 + 1] = raw[1]; spinRaw[a * 3 + 2] = raw[2];
      const v = multiplyMatVec(this._saxisMatrix, raw);
      spinVectors[a * 3] = v[0]; spinVectors[a * 3 + 1] = v[1]; spinVectors[a * 3 + 2] = v[2];
    }

    // Lattice/energy/stress come from the index — parsed once with full file
    // context, and authoritative even when the window truncates them.
    const meta = this._frames[i];
    return {
      lattice: meta.lattice.map(row => [...row]),
      positions,
      forces,
      spinVectors,
      spinRaw,
      energy: Number.isFinite(meta.energy) ? meta.energy : null,
      stress: meta.stress ? meta.stress.map(row => [...row]) : null,
    };
  }
}
