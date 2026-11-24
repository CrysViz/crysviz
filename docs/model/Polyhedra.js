import { Polyhedron } from './Polyhedron.js';

export class Polyhedra {
  constructor({ polyhedra = [] } = {}) {
    if (!Array.isArray(polyhedra)) {
      throw new TypeError("polyhedra must be an array");
    }

    for (const item of polyhedra) {
      if (!(item instanceof Polyhedron)) {
        throw new TypeError("Each item in polyhedra must be an instance of Polyhedron");
      }
    }

    this.polyhedra = polyhedra;
    /** The cell the corners were computed in (rows a, b, c), stamped by
     *  render/PolyhedraModule.js updatePolyhedra; the MD fast path reads the
     *  corners back as fractional positions in it.
     *  @type {number[][] | null} */
    this.srcLattice = null;
    /** What the polyhedra were searched under besides the positions (bond
     *  cutoffs, search settings), stamped by updatePolyhedra: the bond
     *  breaking tolerance memory (render/PolyhedraFrameModule.js
     *  mergeToleranceHeldPolyhedra) is used only under the same.
     *  @type {string | null} */
    this.toleranceSig = null;
    /** Built with corners held by the bond breaking tolerance (playback):
     *  the next rebuild may use this model's polyhedra as its memory even
     *  without a fast frame in between. */
    this.toleranceCarry = false;
  }
}
