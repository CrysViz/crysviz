import { Structure } from './Structure.js';

export class StructureContainer {
  constructor({
    fileName = null,
    structures = [],
    finalSCF = false,
  } = {}) {
    this.fileName = fileName ? fileName : "Unspecified";
    this.structures = this._ensureListOfClass(structures, Structure);
    this.finalSCF=finalSCF;
    // Per-frame plot series for the Trajectory panel (step / temperatureK /
    // etotEv / meanForce / pressure / ...), each a number[] 1:1 with structures.
    // Populated by live MD/relax and "Compute step stats"; null until then.
    /** @type {Record<string, number[]> | null} */
    this.plotSeries = null;
    // Per-structure camera/feature-toggle memory, used only while the
    // corresponding lock (state/store.js's app.cameraLocked / general.featuresLocked)
    // is off — see FileBrowswerPanel.js's updateStructureFromRowAndStep.
    this.cameraSnapshot = null;
    this.featureSnapshot = null;
    // Soft, non-fatal load warnings a reader attaches for data it could NOT
    // read even though the structure loaded (e.g. an FHI-aims run that is
    // spin-polarised but whose per-atom moments were in an unparsed format).
    // core/crystal-viewer.js surfaces these in the load-warning modal. null
    // when the load was clean.
    /** @type {string[] | null} */
    this.loadWarnings = null;
  }

  _ensureListOfClass(input, ClassType) {
    if (!Array.isArray(input)) {
      input = [input];
    }

    return input.map(item =>
      item instanceof ClassType ? item : new ClassType(item)
    );
  }

  // ---------------------------------------------------------------------
  // Frame access seam.
  //
  // Everything that used to index or iterate `container.structures` directly
  // goes through these methods, so a subclass can store a trajectory
  // differently (compact physics + on-demand Structures, a single updated
  // Structure, frames streamed from the file) without touching the callers.
  //
  // The base implementations preserve today's behaviour exactly: structures
  // is a plain eager array and every method is synchronous. Callers of
  // `frameAt`/`frameAtDetached`/`framesSlice` must tolerate a subclass
  // returning a Promise instead (a frame source backed by the file on disk
  // cannot be synchronous); the pattern is
  //   `const r = c.frameAt(i); if (r?.then) r.then(use); else use(r);`
  // Length-only and `.includes` consumers can keep reading `structures`
  // directly — subclasses guarantee `structures` stays an array of the right
  // length (sparsely populated when frames don't exist as objects yet).
  // ---------------------------------------------------------------------

  /** Number of frames in the trajectory. */
  get frameCount() {
    return this.structures.length;
  }

  /**
   * Append one frame to the trajectory. Every code path that grows a
   * trajectory (an MD/relax step, a symmetrised variant) goes through this
   * rather than pushing into `structures` directly, so a store-backed
   * container can pack the frame compactly instead of retaining it.
   * @param {Structure} structure
   * @returns {number} the new frame's index
   */
  appendFrame(structure) {
    this.structures.push(structure instanceof Structure ? structure : new Structure(structure));
    return this.structures.length - 1;
  }

  /**
   * The frame to display for `step`. May return a Promise in subclasses.
   * @param {number} step
   * @returns {Structure | Promise<Structure> | undefined}
   */
  frameAt(step) {
    return this.structures[step];
  }

  /**
   * A frame for a second, simultaneous rendering (overlay/comparison mode).
   * The base class hands out the same object `frameAt` would — matching the
   * old direct-indexing behaviour — while a subclass that renders all steps
   * through one Structure must return an independent object here, or
   * overlaying two steps of the same trajectory would show one geometry.
   * @param {number} step
   * @returns {Structure | Promise<Structure> | undefined}
   */
  frameAtDetached(step) {
    return this.structures[step];
  }

  /**
   * The frames [start, end) as full Structures, for copy/combine operations
   * that go on to clone them. May return a Promise in subclasses.
   * @param {number} [start] @param {number} [end]
   * @returns {Structure[] | Promise<Structure[]>}
   */
  framesSlice(start = 0, end = this.structures.length) {
    return this.structures.slice(start, end);
  }

  /** Index of a frame object in this trajectory, or -1. */
  frameIndexOf(structure) {
    return this.structures.indexOf(structure);
  }

  /** Whether this container owns the given Structure. */
  ownsStructure(structure) {
    return this.structures.includes(structure);
  }

  /**
   * Run `fn(frame, index)` against every frame as a mutable Structure,
   * skipping `opts.skip` (typically the currently displayed frame, which the
   * caller already mutated). This is the propagation primitive behind every
   * "apply/reset whole trajectory" action, so a subclass with on-demand
   * frames must materialise each frame, apply, and keep the result.
   * @param {(frame: Structure, index: number) => void} fn
   * @param {{skip?: Structure}} [opts]
   */
  forEachFrameMaterialized(fn, opts = {}) {
    this.structures.forEach((frame, i) => {
      if (frame && frame !== opts.skip) fn(frame, i);
    });
  }

  /** Per-frame energies for plots; NaN where unknown. */
  energySeries() {
    return this.structures.map(s => (Number.isFinite(s?.energy) ? s.energy : NaN));
  }

  /** Whether any frame carries spin data. */
  hasSpins() {
    return this.structures.some(s => Array.isArray(s?.spins) && s.spins.length > 0);
  }

  /** Whether any frame carries force data. */
  hasForces() {
    return this.structures.some(s => Array.isArray(s?.forces) && s.forces.length > 0);
  }

  /**
   * Per-frame geometry/arrow data in plain form for session serialisation
   * (ShareModule's includeFrames path). May return a Promise in subclasses.
   * @returns {Array<{elements: string[], lattice: number[][],
   *   positions: number[][], forces: Force[] | null, spins: Spin[] | null}>
   *   | Promise<Array<object>>}
   */
  framePhysicsList() {
    return this.structures.map(frame => ({
      elements: [...frame.elements],
      lattice: frame.lattice.map(r => [...r]),
      positions: frame.atoms.map(a => [...a.position]),
      forces: frame.forces?.length ? frame.forces : null,
      spins: frame.spins?.length ? frame.spins : null,
    }));
  }
  flushColorToAllStructures(targetStructure) {
    // Through the frame seam so trajectory subclasses can materialise frames
    // as needed; for the plain eager container this visits structures as
    // before, skipping the target itself.
    this.forEachFrameMaterialized(structure => {
      // Copy atom colors
      structure.atoms.forEach((atom, atomIndex) => {
        if (targetStructure.atoms[atomIndex]) {
          atom.color = targetStructure.atoms[atomIndex].color;
          atom.opacity = targetStructure.atoms[atomIndex].opacity;
          atom.elementColor = targetStructure.atoms[atomIndex].elementColor;
          atom.elementOpacity = targetStructure.atoms[atomIndex].elementOpacity;
          atom.radiusScale = targetStructure.atoms[atomIndex].radiusScale ?? 1;
        }
      });

      // Copy bond colors
      structure.bonds.forEach((bond, bondIndex) => {
        if (targetStructure.bonds[bondIndex] && targetStructure.bonds[bondIndex].color) {
          bond.color = [...targetStructure.bonds[bondIndex].color]; // Deep copy if needed
        }
      });
    }, { skip: targetStructure });
  }

  /**
   * Deep-copy every per-structure style store from targetStructure (the
   * current frame) to all other frames. Keys are index/geometry-derived and
   * assume frames share atom count/order (true for OUTCAR/eXYZ trajectories);
   * entries that go stale on a frame (e.g. atoms drifting across cell
   * boundaries change wrapped-index keys) are ignored by the stores'
   * element/geometry sanity checks at apply time.
   */
  flushStylesToAllStructures(targetStructure) {
    // atomMaterials/atomUserMaterials (per-species / per-atom ray-tracing
    // material overrides) travel alongside the style stores below — without
    // them here, no Apply/Reset action in the app ever propagated a material
    // override to other trajectory frames.
    const STORES = ['atomImageStyles', 'bondUserStyles', 'bondCategoryStyles',
                    'polyhedraUserStyles', 'polyhedraCategoryStyles',
                    'atomMaterials', 'atomUserMaterials',
                    'spinCategoryStyles', 'forceCategoryStyles'];
    this.forEachFrameMaterialized(structure => {
      for (const k of STORES) {
        structure[k] = JSON.parse(JSON.stringify(targetStructure[k] ?? {}));
      }
    }, { skip: targetStructure });
  }

}
