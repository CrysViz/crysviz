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
  }
}
