/**
 * A trajectory rendered through ONE Structure.
 *
 * Where TrajectoryContainer materialises a Structure per viewed frame (so each
 * frame can carry its own styling), this container keeps a single live
 * Structure and, on every frame switch, writes the new frame's physics into
 * the existing objects in place: positions into the same position arrays,
 * moments and force vectors onto the same Spin/Force instances, lattice /
 * energy / stress onto the Structure. Atom, Spin and Force identity therefore
 * never changes across the trajectory — and with it, neither does any styling
 * the user applied: colors, per-atom overrides, bond styles and materials
 * simply persist while scrubbing, which treats styling as a property of the
 * SYSTEM rather than of the frame.
 *
 * Consequences, all deliberate:
 *  - per-frame styling does not exist in this mode; the press-and-hold
 *    "apply to trajectory" variants become synonyms of the plain click
 *    (forEachFrameMaterialized applies to the live structure and nothing
 *    else, and the whole-trajectory style flushes are no-ops);
 *  - overlay/comparison and copy operations materialise independent
 *    Structures and transplant the live styling onto them, so what the user
 *    sees is what gets overlaid/copied;
 *  - `original`/`originalSpins` are refreshed on every switch so the reset
 *    paths restore the CURRENT frame's as-loaded state, not frame 0's;
 *  - structural edits (adding/removing atoms) cannot survive a frame switch —
 *    the physics arrays are per-trajectory; the switch falls back to a fresh
 *    materialisation and warns.
 *
 * Frame-switch cost: one in-place physics write plus one pristine
 * materialisation for the original snapshots (~2.5 ms at 440 atoms) — well
 * under the full re-render the switch triggers anyway.
 */

import { TrajectoryContainer, isPending } from './TrajectoryContainer.js';
import { materializeFrame } from './materializeFrame.js';
import { Stress } from './Stress.js';

/** @typedef {import('./Structure.js').Structure} Structure */

/** The style stores whole-trajectory flushes copy; mirrored from
 *  StructureContainer.flushStylesToAllStructures. */
const STYLE_STORES = ['atomImageStyles', 'bondUserStyles', 'bondCategoryStyles',
  'polyhedraUserStyles', 'polyhedraCategoryStyles',
  'atomMaterials', 'atomUserMaterials',
  'spinCategoryStyles', 'forceCategoryStyles'];

export class UnifiedTrajectoryContainer extends TrajectoryContainer {
  /**
   * @param {{fileName?: string,
   *          store: import('./TrajectoryFrameStore.js').TrajectoryFrameStore}} init
   */
  constructor({ fileName = null, store }) {
    super({ fileName, store });
    /** @type {Structure | null} lazily created on first frameAt */
    this._live = null;
    this._liveStep = -1;
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
   * @param {number} step
   * @param {import('./TrajectoryFrameStore.js').FramePhysics} ph
   * @returns {Structure}
   */
  _showFrame(step, ph) {
    // The pristine build serves twice: as the live structure itself the first
    // time (or after a structural edit), and as the source of the as-loaded
    // original/originalSpins snapshots on every later switch.
    const pristine = materializeFrame(this.store, ph);

    if (!this._live || this._live.atoms.length !== this.store.natoms) {
      if (this._live) {
        console.warn('Unified trajectory: the structure was edited structurally '
          + '(atom count changed); switching frames rebuilds it and the edit is dropped.');
      }
      this._live = pristine;
    } else {
      const live = this._live;
      const n = this.store.natoms;
      for (let i = 0; i < n; i++) {
        // REPLACE the array rather than writing into it: Structure.original's
        // shallow atom copies alias the live position arrays and deepFreeze
        // froze them — which is also why every position edit in the app
        // assigns a fresh array (see e.g. StructureInfoPanel utils).
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
      // Reset paths must restore THIS frame's as-loaded state.
      live.original = pristine.original;
      live.originalSpins = pristine.originalSpins;
    }

    // Move the live structure to its new slot so identity lookups
    // (structures.includes, frameIndexOf) track the shown step.
    if (this._liveStep >= 0) delete this.structures[this._liveStep];
    this.structures[step] = this._live;
    this._liveStep = step;
    return this._live;
  }

  /**
   * Overlay/comparison and copies get an independent Structure carrying the
   * live styling — in unified mode the styling belongs to the system, so a
   * second rendering of another step should look the same.
   * @param {number} step
   */
  frameAtDetached(step) {
    const result = super.frameAtDetached(step);
    if (isPending(result)) {
      return result.then(frame => this._transplantLiveStyles(frame));
    }
    return this._transplantLiveStyles(result);
  }

  /** @param {Structure | undefined} frame @returns {Structure | undefined} */
  _transplantLiveStyles(frame) {
    const live = this._live;
    if (!frame || !live || frame.atoms.length !== live.atoms.length) return frame;
    frame.atoms.forEach((atom, i) => {
      const src = live.atoms[i];
      atom.color = src.color;
      atom.userColor = src.userColor;
      atom.elementColor = src.elementColor;
      atom.opacity = src.opacity;
      atom.elementOpacity = src.elementOpacity;
      atom.radiusScale = src.radiusScale;
      atom.cutPlaneImmune = src.cutPlaneImmune;
      atom.hidden = src.hidden;
    });
    const copyArrowStyle = (dst, src) => {
      dst.color = src.color;
      dst.userColor = src.userColor;
      dst.userMaterial = src.userMaterial;
      dst.hidden = src.hidden;
      dst.scaling = src.scaling;
    };
    if (frame.spins.length === live.spins.length) {
      frame.spins.forEach((s, i) => copyArrowStyle(s, live.spins[i]));
    }
    if (frame.forces.length === live.forces.length) {
      frame.forces.forEach((f, i) => copyArrowStyle(f, live.forces[i]));
    }
    for (const k of STYLE_STORES) {
      frame[k] = JSON.parse(JSON.stringify(live[k] ?? {}));
    }
    return frame;
  }

  /**
   * In unified mode "every frame" IS the live structure: the plain click
   * already changed it, so a whole-trajectory apply has nothing further to
   * visit (unless the caller mutated some other object and skips it).
   * @param {(frame: Structure, index: number) => void} fn
   * @param {{skip?: Structure}} [opts]
   */
  forEachFrameMaterialized(fn, opts = {}) {
    if (this._live && this._live !== opts.skip) fn(this._live, Math.max(0, this._liveStep));
  }

  /** Styling is already shared by construction. */
  flushColorToAllStructures() {}

  /** Styling is already shared by construction. */
  flushStylesToAllStructures() {}
}
