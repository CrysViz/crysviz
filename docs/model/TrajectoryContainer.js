/**
 * A StructureContainer that renders a whole trajectory through ONE Structure.
 *
 * Frame physics lives compactly in a TrajectoryFrameStore (flat typed arrays,
 * ~76 MB for a 110 MB / 1790-frame MD OUTCAR where eager per-frame Structures
 * measured ~1.8 GB). Exactly one live Structure exists for rendering; showing
 * another frame PARKS the current one — its user deviations are extracted
 * into a sparse per-frame style record (model/materializeFrame.js) — then
 * writes the new frame's physics into the same objects and re-applies that
 * frame's stored record. Per-frame styling therefore survives with no frame
 * kept resident and no frame-to-frame comparison anywhere; an untouched
 * frame stores nothing at all.
 *
 * `structures` is kept as a SPARSE array of frameCount slots whose single
 * occupied slot is the live Structure at its current step. That invariant is
 * what keeps the rest of the app working unaudited: length-only consumers
 * (slider maxima, `available()` predicates) and identity consumers
 * (`structures.includes(...)` for structure->container lookups) read correct
 * values for free, while the sites that index or iterate frames go through
 * the frame seam on StructureContainer.
 *
 * The frame source is duck-typed: any object exposing the
 * TrajectoryFrameStore accessor surface works. A source whose
 * getFramePhysics returns a Promise (frames read from the file on disk)
 * makes frameAt and friends return Promises too — the callers tolerate that.
 */

import { StructureContainer } from './StructureContainer.js';
import {
  materializeFrame, applyFramePhysics, extractFrameStyles, applyFrameStyles,
} from './materializeFrame.js';

/** @typedef {import('./Structure.js').Structure} Structure */
/** @typedef {import('./TrajectoryFrameStore.js').FramePhysics} FramePhysics */
/** @typedef {import('./materializeFrame.js').FrameStyleRecord} FrameStyleRecord */

/**
 * Duck-typed asynchrony test with narrowing: a frame source backed by the
 * file on disk returns Promises where the RAM store returns values.
 * @param {any} value
 * @returns {value is Promise<any>}
 */
function isPending(value) {
  return !!value && typeof value.then === 'function';
}

export class TrajectoryContainer extends StructureContainer {
  /**
   * @param {{fileName?: string,
   *          store: import('./TrajectoryFrameStore.js').TrajectoryFrameStore}} init
   */
  constructor({ fileName = null, store }) {
    super({ fileName, structures: [] });
    this.store = store;
    /** Sparse: one occupied slot — the live Structure at its current step. */
    this.structures = new Array(store.frameCount);
    /** @type {Structure | null} the one Structure used for rendering */
    this._live = null;
    this._liveStep = -1;
    /** @type {Map<number, FrameStyleRecord>} step -> that frame's deviations */
    this._frameStyles = new Map();
  }

  get frameCount() {
    return this.store.frameCount;
  }

  /**
   * Extract the live frame's deviations into its sparse record (or clear the
   * record if it has none). Called before the live Structure moves on and
   * before anything reads per-frame data of the shown frame from records.
   * @param {FramePhysics} ph the LIVE step's physics
   */
  _parkLive(ph) {
    if (!this._live || this._liveStep < 0) return;
    const rec = extractFrameStyles(this._live, ph);
    if (rec) this._frameStyles.set(this._liveStep, rec);
    else this._frameStyles.delete(this._liveStep);
  }

  /**
   * @param {number} step
   * @param {FramePhysics} ph
   * @returns {Structure}
   */
  _showFrame(step, ph) {
    if (this._live && this._liveStep >= 0 && this._liveStep !== step) {
      const livePh = this.store.getFramePhysics(this._liveStep);
      // A sync source (the RAM store) always parks; an async source that
      // cannot provide the outgoing physics synchronously cannot detect
      // position edits at park time — style deviations still park fine.
      if (!isPending(livePh)) this._parkLive(/** @type {FramePhysics} */(livePh));
    }
    if (!this._live || this._live.atoms.length !== this.store.natoms) {
      if (this._live) {
        console.warn('Trajectory: the structure was edited structurally (atom count '
          + 'changed); switching frames rebuilds it and the edit is dropped.');
      }
      this._live = materializeFrame(this.store, ph);
    } else {
      applyFramePhysics(this._live, ph);
    }
    applyFrameStyles(this._live, this._frameStyles.get(step) ?? null);
    this._installLazyAsLoaded(this._live, step);

    if (this._liveStep >= 0) delete this.structures[this._liveStep];
    this.structures[step] = this._live;
    this._liveStep = step;
    return this._live;
  }

  /**
   * `original`/`originalSpins` must reflect the SHOWN frame's as-loaded
   * state (every reset path reads them), but most frame switches never touch
   * them — so they are lazy: first access materialises a pristine copy of
   * this frame from the store (correct regardless of any edits made since
   * the switch) and caches its snapshots until the next switch.
   * @param {Structure} live @param {number} step
   */
  _installLazyAsLoaded(live, step) {
    const store = this.store;
    for (const name of ['original', 'originalSpins']) {
      Object.defineProperty(live, name, {
        configurable: true,
        enumerable: true,
        get() {
          const pristine = materializeFrame(store,
            /** @type {FramePhysics} */(store.getFramePhysics(step)));
          Object.defineProperty(live, 'original', {
            value: pristine.original, configurable: true, enumerable: true, writable: true,
          });
          Object.defineProperty(live, 'originalSpins', {
            value: pristine.originalSpins, configurable: true, enumerable: true, writable: true,
          });
          return name === 'original' ? pristine.original : pristine.originalSpins;
        },
      });
    }
  }

  /**
   * @param {number} step
   * @returns {Structure | Promise<Structure> | undefined}
   */
  frameAt(step) {
    if (!(step >= 0 && step < this.frameCount)) return undefined;
    if (step === this._liveStep && this._live) return this._live;
    const physics = this.store.getFramePhysics(step);
    if (isPending(physics)) {
      return physics.then(ph => this._showFrame(step, ph));
    }
    return this._showFrame(step, physics);
  }

  /**
   * An independent Structure for overlay/comparison rendering or copying —
   * a fresh materialisation carrying that frame's stored styles, so what the
   * user styled on the frame is what gets overlaid/copied. Never the live
   * object, never retained here.
   * @param {number} step
   * @returns {Structure | Promise<Structure> | undefined}
   */
  frameAtDetached(step) {
    if (!(step >= 0 && step < this.frameCount)) return undefined;
    if (step === this._liveStep && this._live) {
      // The live frame's record may be stale relative to on-screen edits.
      const livePh = this.store.getFramePhysics(step);
      if (!isPending(livePh)) this._parkLive(/** @type {FramePhysics} */(livePh));
    }
    const physics = this.store.getFramePhysics(step);
    const build = (/** @type {FramePhysics} */ ph) => {
      const frame = materializeFrame(this.store, ph);
      applyFrameStyles(frame, this._frameStyles.get(step) ?? null);
      return frame;
    };
    return isPending(physics) ? physics.then(build) : build(physics);
  }

  /**
   * Full Structures for [start, end) — clone/combine operations, each an
   * independent copy carrying its frame's stored styles.
   * @param {number} [start] @param {number} [end]
   * @returns {Structure[] | Promise<Structure[]>}
   */
  framesSlice(start = 0, end = this.frameCount) {
    const s = Math.max(0, start), e = Math.min(this.frameCount, end);
    const out = [];
    let async = false;
    for (let i = s; i < e; i++) {
      const frame = this.frameAtDetached(i);
      if (isPending(frame)) async = true;
      out.push(frame);
    }
    return async ? Promise.all(out) : /** @type {Structure[]} */ (out);
  }

  /**
   * Visit every frame as a mutable Structure — the propagation primitive
   * behind "apply/reset whole trajectory". Non-shown frames are reproduced
   * from their records, mutated by `fn`, and re-parked; only the deviations
   * `fn` actually created are kept.
   * @param {(frame: Structure, index: number) => void} fn
   * @param {{skip?: Structure}} [opts]
   * @returns {Promise<void> | void}
   */
  forEachFrameMaterialized(fn, opts = {}) {
    /** @type {Promise<void> | null} */
    let chain = null;
    for (let step = 0; step < this.frameCount; step++) {
      const stepNow = step;
      const visit = (/** @type {FramePhysics} */ ph) => {
        if (stepNow === this._liveStep && this._live) {
          if (this._live !== opts.skip) fn(this._live, stepNow);
          return;
        }
        const frame = materializeFrame(this.store, ph);
        applyFrameStyles(frame, this._frameStyles.get(stepNow) ?? null);
        fn(frame, stepNow);
        const rec = extractFrameStyles(frame, ph);
        if (rec) this._frameStyles.set(stepNow, rec);
        else this._frameStyles.delete(stepNow);
      };
      const physics = this.store.getFramePhysics(stepNow);
      if (isPending(physics)) {
        chain = (chain ?? Promise.resolve()).then(() => physics).then(visit);
      } else {
        visit(physics);
      }
    }
    if (chain) return chain.then(() => undefined);
  }

  frameIndexOf(structure) {
    return structure === this._live ? this._liveStep : -1;
  }

  ownsStructure(structure) {
    return structure === this._live;
  }

  energySeries() {
    return this.store.energySeries();
  }

  hasSpins() {
    return this.store.hasSpins;
  }

  hasForces() {
    return this.store.hasForces;
  }

  /**
   * Per-frame {etotEv, meanForce, pressure} series straight from the typed
   * arrays — the store-backed answer to the Trajectory panel's "Compute step
   * stats", without building a single frame. Formulas match the panel's
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

  /**
   * Serialisation reads physics straight from the store; a frame's stored
   * position/lattice edits (and the live frame's current state, parked
   * first) take precedence so a user's edits serialise faithfully.
   */
  framePhysicsList() {
    if (this._live && this._liveStep >= 0) {
      const livePh = this.store.getFramePhysics(this._liveStep);
      if (!isPending(livePh)) this._parkLive(/** @type {FramePhysics} */(livePh));
    }
    const out = [];
    for (let i = 0; i < this.frameCount; i++) {
      const ph = this.store.getFramePhysics(i);
      if (isPending(ph)) {
        return this._framePhysicsListAsync(out, i);
      }
      out.push(this._physicsEntry(i, ph));
    }
    return out;
  }

  /** @param {Array<object>} head entries built so far @param {number} from */
  async _framePhysicsListAsync(head, from) {
    const out = head;
    for (let i = from; i < this.frameCount; i++) {
      out.push(this._physicsEntry(i, await this.store.getFramePhysics(i)));
    }
    return out;
  }

  /** @param {number} step @param {FramePhysics} ph */
  _physicsEntry(step, ph) {
    const n = this.store.natoms;
    const rec = this._frameStyles.get(step);
    const positions = [];
    for (let a = 0; a < n; a++) {
      const override = /** @type {any} */ (rec?.atoms?.get(a))?.position;
      positions.push(override
        ? [...override]
        : [ph.positions[a * 3], ph.positions[a * 3 + 1], ph.positions[a * 3 + 2]]);
    }
    const arrows = (/** @type {Float64Array | null} */ flat,
      /** @type {Map<number, any> | undefined} */ m,
      /** @type {boolean} */ isSpin) => {
      if (!flat) return null;
      const list = [];
      for (let a = 0; a < n; a++) {
        const d = m?.get(a);
        list.push({
          vector: [flat[a * 3], flat[a * 3 + 1], flat[a * 3 + 2]],
          scaling: 1.0,
          userColor: d?.userColor ?? null,
          userMaterial: d?.userMaterial ?? null,
          hidden: d?.hidden ?? false,
          ...(isSpin ? {
            rawVector: [ph.spinRaw[a * 3], ph.spinRaw[a * 3 + 1], ph.spinRaw[a * 3 + 2]],
          } : {}),
        });
      }
      return list;
    };
    return {
      elements: [...this.store.elements],
      lattice: (rec?.lattice ?? ph.lattice).map(r => [...r]),
      positions,
      forces: arrows(ph.forces, rec?.forces, false),
      spins: ph.spinRaw ? arrows(ph.spinVectors, rec?.spins, true) : null,
    };
  }
}
