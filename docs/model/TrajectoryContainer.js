/**
 * A StructureContainer whose frames live compactly in a TrajectoryFrameStore
 * and become full Structures only on demand.
 *
 * `structures` is kept as a SPARSE array of frameCount slots — a hole means
 * "not materialised right now". That single invariant is what keeps the rest
 * of the app working unaudited: every length-only consumer
 * (`structures.length`, slider maxima, `available()` predicates) and every
 * identity consumer (`structures.includes(...)` for structure->container
 * lookups) reads correct values for free, while the sites that index or
 * iterate frames go through the frame seam on StructureContainer.
 *
 * Materialised frames are cached in those slots under an LRU cap. Eviction is
 * guarded by frameMatchesPristine: a frame is only dropped if it still equals
 * a fresh materialisation — user-styled or user-edited frames (and anything
 * carrying attached state like a volumetric field) stay resident, so scrubbing
 * through a long MD run costs a bounded number of clean frames while every
 * deliberate per-frame change survives. Memory pathology therefore degrades
 * toward today's behaviour (frames the user touched exist in full), never
 * toward data loss.
 *
 * The frame source is duck-typed: this class works with any object exposing
 * the TrajectoryFrameStore accessor surface. A source whose getFramePhysics
 * returns a Promise (frames read from the file on disk) makes frameAt and
 * friends return Promises too — the callers were rewired to tolerate that.
 */

import { StructureContainer } from './StructureContainer.js';
import { materializeFrame, frameMatchesPristine } from './materializeFrame.js';

/** @typedef {import('./Structure.js').Structure} Structure */
/** @typedef {import('./TrajectoryFrameStore.js').FramePhysics} FramePhysics */

/**
 * Duck-typed asynchrony test with narrowing: a frame source backed by the
 * file on disk returns Promises where the RAM store returns values. Exported
 * for the container subclasses that face the same duality.
 * @param {any} value
 * @returns {value is Promise<any>}
 */
export function isPending(value) {
  return !!value && typeof value.then === 'function';
}

/** Materialised frames kept per trajectory before clean ones are recycled.
 *  ~2.5 ms + ~1 MB each at 440 atoms; 24 covers scrubbing comfortably. */
const DEFAULT_FRAME_CACHE_LIMIT = 24;

export class TrajectoryContainer extends StructureContainer {
  /**
   * @param {{fileName?: string,
   *          store: import('./TrajectoryFrameStore.js').TrajectoryFrameStore,
   *          cacheLimit?: number}} init
   */
  constructor({ fileName = null, store, cacheLimit = DEFAULT_FRAME_CACHE_LIMIT }) {
    super({ fileName, structures: [] });
    this.store = store;
    /** Sparse materialisation cache; holes = frames existing only as physics. */
    this.structures = new Array(store.frameCount);
    /** @type {number[]} step indices, least-recently-used first */
    this._lru = [];
    this._cacheLimit = Math.max(2, cacheLimit);
    /** @type {Structure | null} the on-screen frame; never evicted. */
    this._displayed = null;
  }

  /**
   * Pin the frame currently on screen. Called from the frame-switch path;
   * identity lookups (ownsStructure, frameIndexOf) and eviction both depend
   * on the displayed frame staying in its slot.
   * @param {Structure | null} structure
   */
  setDisplayedFrame(structure) {
    this._displayed = structure;
  }

  get frameCount() {
    return this.store.frameCount;
  }

  /** @param {number} step */
  _touch(step) {
    const at = this._lru.indexOf(step);
    if (at !== -1) this._lru.splice(at, 1);
    this._lru.push(step);
  }

  /**
   * Recycle least-recently-used clean frames down to the cache limit. A frame
   * that no longer matches its pristine rebuild is left alone (and taken out
   * of LRU consideration) — it holds user state that must not be lost.
   */
  _evictOverflow() {
    let cached = this._lru.length;
    for (let i = 0; i < this._lru.length && cached > this._cacheLimit;) {
      const step = this._lru[i];
      const frame = this.structures[step];
      if (!frame) { this._lru.splice(i, 1); cached--; continue; }
      if (frame === this._displayed) { i++; continue; }
      const physics = this.store.getFramePhysics(step);
      // A synchronous store is required for eviction checks; an async source
      // simply skips eviction here and relies on its own cache policy.
      if (isPending(physics)) return;
      if (frameMatchesPristine(frame, materializeFrame(this.store, physics))) {
        delete this.structures[step];
      }
      // Either recycled, or dirty and therefore pinned: in both cases the
      // step leaves LRU consideration (a pinned frame keeps its slot — it IS
      // the user's data now).
      this._lru.splice(i, 1);
      cached--;
    }
  }

  /**
   * @param {number} step
   * @returns {Structure | Promise<Structure> | undefined}
   */
  frameAt(step) {
    if (!(step >= 0 && step < this.frameCount)) return undefined;
    const cached = this.structures[step];
    if (cached) {
      this._touch(step);
      return cached;
    }
    const physics = this.store.getFramePhysics(step);
    if (isPending(physics)) {
      return physics.then(ph => {
        // Another caller may have won the race while we read.
        if (this.structures[step]) return this.structures[step];
        const frame = materializeFrame(this.store, ph);
        this.structures[step] = frame;
        this._touch(step);
        this._evictOverflow();
        return frame;
      });
    }
    const frame = materializeFrame(this.store, physics);
    this.structures[step] = frame;
    this._touch(step);
    this._evictOverflow();
    return frame;
  }

  /**
   * An independent Structure for overlay/comparison rendering — never the
   * cached object, so styling the overlaid copy cannot leak into the main
   * view of the same step, and never cached, so it lives exactly as long as
   * the overlay entry holding it.
   * @param {number} step
   */
  frameAtDetached(step) {
    if (!(step >= 0 && step < this.frameCount)) return undefined;
    const physics = this.store.getFramePhysics(step);
    if (isPending(physics)) {
      return physics.then(ph => materializeFrame(this.store, ph));
    }
    return materializeFrame(this.store, physics);
  }

  /**
   * Full Structures for [start, end) — clone/combine operations. Cached
   * (possibly user-styled) frames are handed out where they exist so copies
   * carry the user's styling, exactly as cloning did on eager containers;
   * holes are materialised fresh without entering the cache.
   * @param {number} [start] @param {number} [end]
   */
  framesSlice(start = 0, end = this.frameCount) {
    const s = Math.max(0, start), e = Math.min(this.frameCount, end);
    const out = [];
    let async = false;
    for (let i = s; i < e; i++) {
      const frame = this.structures[i] ?? this.frameAtDetached(i);
      if (isPending(frame)) async = true;
      out.push(frame);
    }
    return async ? Promise.all(out) : out;
  }

  /**
   * Materialise-and-visit every frame. Used by the trajectory-wide style
   * actions; each visited frame lands in the cache, and _evictOverflow's
   * pristine comparison afterwards keeps only the ones `fn` actually changed.
   * Returns a Promise when the source is asynchronous.
   * @param {(frame: Structure, index: number) => void} fn
   * @param {{skip?: Structure}} [opts]
   * @returns {Promise<void> | void}
   */
  forEachFrameMaterialized(fn, opts = {}) {
    /** @type {Promise<void> | null} */
    let chain = null;
    for (let i = 0; i < this.frameCount; i++) {
      const frame = this.frameAt(i);
      if (isPending(frame)) {
        const step = i;
        chain = (chain ?? Promise.resolve()).then(() => frame).then(f => {
          if (f && f !== opts.skip) fn(f, step);
        });
      } else if (frame && frame !== opts.skip) {
        fn(frame, i);
      }
    }
    if (chain) return chain.then(() => this._evictOverflow());
    this._evictOverflow();
  }

  energySeries() {
    return this.store.energySeries();
  }

  /**
   * Per-frame {etotEv, meanForce, pressure} series straight from the typed
   * arrays — the store-backed answer to the Trajectory panel's "Compute step
   * stats", without materialising a single frame. Formulas match the panel's
   * eager path: mean per-atom |F|, and stress trace / 3 (relaxer.stressMean).
   * @returns {{etotEv: number[], meanForce: number[] | null, pressure: number[] | null}}
   */
  stepStatsSeries() {
    const n = this.store.natoms;
    const fc = this.frameCount;
    const etotEv = this.store.energySeries();
    let meanForce = null;
    const forces = this.store.forces;
    if (forces) {
      meanForce = new Array(fc);
      for (let f = 0; f < fc; f++) {
        const base = f * n * 3;
        let sum = 0;
        for (let a = 0; a < n; a++) {
          sum += Math.hypot(forces[base + a * 3], forces[base + a * 3 + 1], forces[base + a * 3 + 2]);
        }
        meanForce[f] = n ? sum / n : NaN;
      }
    }
    let pressure = null;
    const stresses = this.store.stresses;
    if (stresses) {
      pressure = new Array(fc);
      for (let f = 0; f < fc; f++) {
        const tr = stresses[f * 9] + stresses[f * 9 + 4] + stresses[f * 9 + 8];
        pressure[f] = Number.isFinite(tr) ? tr / 3 : NaN;
      }
    }
    return { etotEv, meanForce, pressure };
  }

  hasSpins() {
    return this.store.hasSpins;
  }

  hasForces() {
    return this.store.hasForces;
  }

  /**
   * Serialisation reads physics straight from the store — no frame needs to
   * exist as a Structure for a session save. Cached (possibly edited) frames
   * take precedence so a user's positional edits serialise faithfully.
   */
  framePhysicsList() {
    const out = [];
    for (let i = 0; i < this.frameCount; i++) {
      const cached = this.structures[i];
      if (cached) {
        out.push({
          elements: [...cached.elements],
          lattice: cached.lattice.map(r => [...r]),
          positions: cached.atoms.map(a => [...a.position]),
          forces: cached.forces?.length ? cached.forces : null,
          spins: cached.spins?.length ? cached.spins : null,
        });
        continue;
      }
      const ph = this.store.getFramePhysics(i);
      if (isPending(ph)) {
        // An async source resolves the remainder as a Promise of the list.
        return this._framePhysicsListAsync(out, i);
      }
      out.push(this._physicsEntry(ph));
    }
    return out;
  }

  /** @param {Array<object>} head entries built so far @param {number} from */
  async _framePhysicsListAsync(head, from) {
    const out = head;
    for (let i = from; i < this.frameCount; i++) {
      const cached = this.structures[i];
      if (cached) {
        out.push({
          elements: [...cached.elements],
          lattice: cached.lattice.map(r => [...r]),
          positions: cached.atoms.map(a => [...a.position]),
          forces: cached.forces?.length ? cached.forces : null,
          spins: cached.spins?.length ? cached.spins : null,
        });
      } else {
        out.push(this._physicsEntry(await this.store.getFramePhysics(i)));
      }
    }
    return out;
  }

  /** @param {import('./TrajectoryFrameStore.js').FramePhysics} ph */
  _physicsEntry(ph) {
    const n = this.store.natoms;
    const positions = [];
    for (let a = 0; a < n; a++) {
      positions.push([ph.positions[a * 3], ph.positions[a * 3 + 1], ph.positions[a * 3 + 2]]);
    }
    const arrows = (flat, extra) => {
      if (!flat) return null;
      const list = [];
      for (let a = 0; a < n; a++) {
        list.push({ vector: [flat[a * 3], flat[a * 3 + 1], flat[a * 3 + 2]], scaling: 1.0, ...extra });
      }
      return list;
    };
    return {
      elements: [...this.store.elements],
      lattice: ph.lattice.map(r => [...r]),
      positions,
      forces: arrows(ph.forces, {}),
      spins: ph.spinRaw
        ? Array.from({ length: n }, (_, a) => ({
          vector: [ph.spinVectors[a * 3], ph.spinVectors[a * 3 + 1], ph.spinVectors[a * 3 + 2]],
          rawVector: [ph.spinRaw[a * 3], ph.spinRaw[a * 3 + 1], ph.spinRaw[a * 3 + 2]],
          scaling: 1.0,
        }))
        : null,
    };
  }
}
