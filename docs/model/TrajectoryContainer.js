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
import { TrajectoryFrameStore } from './TrajectoryFrameStore.js';
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

/**
 * Same composition? Reference-first (frames of one file intern their
 * elements array), content fallback (frames from different sources).
 * @param {string[] | null} a @param {string[]} b
 */
function sameElements(a, b) {
  if (a === b) return true;
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Largest per-atom displacement between consecutive frames (Å) that still
 * counts as ONE system in motion. MD/relax steps move atoms by hundredths of
 * an Ångström; unrelated structures packed into one file (AIRSS candidates, a
 * combined dataset) jump by bond lengths. Only motion may take the render
 * fast path, which keeps the periodic-image set and bond pairs frozen between
 * full rebuilds.
 */
export const MOTION_MAX_STEP = 1.0;

/**
 * Largest minimum-image displacement of any atom from frame `a` to frame `b`
 * (same composition), in Å, measured in `b`'s cell.
 * @param {FramePhysics} a @param {FramePhysics} b
 */
function maxDisplacement(a, b) {
  const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = b.lattice;
  const pa = a.positions, pb = b.positions;
  let maxSq = 0;
  for (let i = 0; i < pb.length; i += 3) {
    // Fractional delta wrapped into [-0.5, 0.5]: an atom leaving through one
    // face and re-entering at the other is motion, not a jump.
    let d0 = pb[i] - pa[i]; d0 -= Math.round(d0);
    let d1 = pb[i + 1] - pa[i + 1]; d1 -= Math.round(d1);
    let d2 = pb[i + 2] - pa[i + 2]; d2 -= Math.round(d2);
    const x = d0 * ax + d1 * bx + d2 * cx;
    const y = d0 * ay + d1 * by + d2 * cy;
    const z = d0 * az + d1 * bz + d2 * cz;
    const sq = x * x + y * y + z * z;
    if (sq > maxSq) maxSq = sq;
  }
  return Math.sqrt(maxSq);
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
    /** @type {string[] | null} composition the live Structure was built for */
    this._liveElements = null;
    /** @type {Map<number, FrameStyleRecord>} step -> that frame's deviations */
    this._frameStyles = new Map();
    /** Frame-switch counters for the Debug window (debug/memoryAccounting.js). */
    this.debugStats = { shown: 0, reused: 0, rebuilt: 0, detached: 0, pristine: 0 };
    /**
     * How the Trajectory player renders playback frames: 'auto' takes the
     * render fast path when motionProfile() says 'trajectory'; 'full' forces
     * the exact rebuild on every frame.
     * @type {'auto' | 'full'}
     */
    this.playbackMode = 'auto';
    /** @type {{kind: 'trajectory' | 'dataset', maxStep: number, frames: number} | null} */
    this._motionProfile = null;
  }

  /**
   * Build a store-backed trajectory from ready Structures (a parsed
   * multi-frame file, combined/copied rows, a finished run): each frame's
   * physics is packed and its user deviations from defaults become that
   * frame's sparse record; the Structures themselves are then droppable.
   * Frames may differ in composition — equal consecutive compositions share
   * one interned elements array.
   * @param {string} fileName
   * @param {Structure[]} structures
   * @returns {TrajectoryContainer}
   */
  static fromStructures(fileName, structures) {
    /** @type {Map<string, string[]>} one interned array per distinct composition */
    const interned = new Map();
    const frames = [];
    const records = new Map();
    structures.forEach((structure, i) => {
      const ph = TrajectoryFrameStore.packStructure(structure);
      const key = ph.elements.join('\0');
      const shared = interned.get(key);
      if (shared) ph.elements = shared;
      else interned.set(key, ph.elements);
      frames.push(ph);
      const rec = extractFrameStyles(structure, ph);
      if (rec) records.set(i, rec);
    });
    const container = new TrajectoryContainer({
      fileName, store: new TrajectoryFrameStore({ frames }),
    });
    container._frameStyles = records;
    return container;
  }

  /**
   * Append one frame — the live-run path (MD/relax steps, symmetrised
   * variants): pack the physics, keep only the deviations, drop the
   * Structure. The sparse `structures` array grows so every length-only
   * consumer (sliders, row counters) keeps reading the true frame count.
   * @param {Structure} structure
   * @returns {number} the new frame's index
   */
  appendFrame(structure) {
    const ph = TrajectoryFrameStore.packStructure(structure);
    const prev = this.frameCount ? this.store.getFramePhysics(this.frameCount - 1) : null;
    if (prev && sameElements(prev.elements, ph.elements)) ph.elements = prev.elements;
    this.store.append(ph);
    const step = this.frameCount - 1;
    const rec = extractFrameStyles(structure, ph);
    if (rec) this._frameStyles.set(step, rec);
    this.structures.length = this.frameCount;
    return step;
  }

  get frameCount() {
    return this.store.frameCount;
  }

  /**
   * Is this one system in motion ('trajectory': fixed composition, no atom
   * moves more than MOTION_MAX_STEP between consecutive frames) or a set of
   * unrelated structures ('dataset')? Answered from the typed arrays without
   * materialising a frame, and cached until the frame count changes. A frame
   * source that cannot be read synchronously is classified 'dataset' — the
   * exact path is always correct. A growing trajectory (a live run appending
   * frames; the Debug sampler asks every tick) only scans the new frames.
   * @returns {{kind: 'trajectory' | 'dataset', maxStep: number, frames: number}}
   */
  motionProfile() {
    const frames = this.frameCount;
    const cached = this._motionProfile;
    if (cached?.frames === frames) return cached;
    // Appending frames never turns a dataset back into motion.
    if (cached && cached.frames < frames && cached.kind === 'dataset') {
      this._motionProfile = { ...cached, frames };
      return this._motionProfile;
    }
    const extend = cached && cached.frames > 0 && cached.frames < frames && cached.kind === 'trajectory';
    let kind = /** @type {'trajectory' | 'dataset'} */ ('trajectory');
    let maxStep = extend ? cached.maxStep : 0;
    const from = extend ? cached.frames - 1 : 0;
    /** @type {FramePhysics | null} */
    let prev = null;
    for (let f = from; f < frames; f++) {
      const ph = this.store.getFramePhysics(f);
      if (isPending(ph)) { kind = 'dataset'; maxStep = NaN; break; }
      if (prev) {
        if (!sameElements(prev.elements, ph.elements)) { kind = 'dataset'; maxStep = Infinity; break; }
        maxStep = Math.max(maxStep, maxDisplacement(prev, ph));
      }
      prev = ph;
    }
    if (maxStep > MOTION_MAX_STEP) kind = 'dataset';
    this._motionProfile = { kind, maxStep, frames };
    return this._motionProfile;
  }

  /**
   * Does frame `step` carry a per-frame style record? A frame switch between
   * two unstyled frames changes physics only, which is what lets playback
   * move instances in place instead of rebuilding.
   * @param {number} step
   */
  hasFrameStyles(step) {
    return this._frameStyles.has(step);
  }

  /**
   * Extract the live frame's deviations into its sparse record (or clear the
   * record if it has none). Called before the live Structure moves on and
   * before anything reads per-frame data of the shown frame from records.
   * @param {FramePhysics} ph the LIVE step's physics
   */
  _parkLive(ph) {
    if (!this._live || this._liveStep < 0) return;
    if (this._live.atoms.length !== ph.elements.length) {
      // A structural edit (atoms added/removed on the shown frame) has no
      // per-index representation against this frame's physics.
      console.warn('Trajectory: the structure was edited structurally (atom count '
        + 'changed); switching frames rebuilds it and the edit is dropped.');
      return;
    }
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
    this.debugStats.shown += 1;
    if (this._live && this._liveStep >= 0 && this._liveStep !== step) {
      const livePh = this.store.getFramePhysics(this._liveStep);
      // A sync source (the RAM store) always parks; an async source that
      // cannot provide the outgoing physics synchronously cannot detect
      // position edits at park time — style deviations still park fine.
      if (!isPending(livePh)) this._parkLive(/** @type {FramePhysics} */(livePh));
    }
    // The live Structure's objects can be reused only while the composition
    // is unchanged; a frame with different elements (heterogeneous
    // trajectory) rebuilds it — the normal path there, not an error.
    if (this._live && sameElements(this._liveElements, ph.elements)
      && this._live.atoms.length === ph.elements.length) {
      applyFramePhysics(this._live, ph);
      this.debugStats.reused += 1;
    } else {
      this._live = materializeFrame(this.store, ph);
      this.debugStats.rebuilt += 1;
    }
    this._liveElements = ph.elements;
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
    const stats = this.debugStats;
    for (const name of ['original', 'originalSpins']) {
      Object.defineProperty(live, name, {
        configurable: true,
        enumerable: true,
        get() {
          stats.pristine += 1;
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
    this.debugStats.detached += 1;
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

  /**
   * Answered from the frame physics, never from the sparse `structures`
   * array: before the first frame is shown that array has no occupied slot,
   * so the base implementation would report a loaded trajectory as empty
   * (and the load path would reject the file as "no atoms found").
   */
  hasAtoms() {
    for (let i = 0; i < this.frameCount; i++) {
      const ph = this.store.getFramePhysics(i);
      // An async source (frames read from the file on disk) cannot be
      // inspected synchronously; it has frames, which is all this can say.
      if (isPending(ph)) return true;
      if (ph.elements.length > 0) return true;
    }
    return false;
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
    const fc = this.frameCount;
    const etotEv = this.store.energySeries();
    const meanForce = new Array(fc).fill(NaN);
    const pressure = new Array(fc).fill(NaN);
    let anyForce = false, anyStress = false;
    for (let f = 0; f < fc; f++) {
      const ph = this.store.getFramePhysics(f);
      if (isPending(ph)) continue;
      const n = ph.elements.length;
      if (ph.forces && n) {
        let sum = 0;
        for (let a = 0; a < n; a++) {
          sum += Math.hypot(ph.forces[a * 3], ph.forces[a * 3 + 1], ph.forces[a * 3 + 2]);
        }
        meanForce[f] = sum / n;
        anyForce = true;
      }
      if (ph.stress) {
        pressure[f] = (ph.stress[0][0] + ph.stress[1][1] + ph.stress[2][2]) / 3;
        anyStress = true;
      }
    }
    return {
      etotEv,
      meanForce: anyForce ? meanForce : null,
      pressure: anyStress ? pressure : null,
    };
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
    const n = ph.elements.length;
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
      elements: [...ph.elements],
      lattice: (rec?.lattice ?? ph.lattice).map(r => [...r]),
      positions,
      forces: arrows(ph.forces, rec?.forces, false),
      spins: ph.spinRaw ? arrows(ph.spinVectors, rec?.spins, true) : null,
    };
  }
}
