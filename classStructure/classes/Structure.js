import { ColoredComponent } from './ColoredComponent.js';
class Structure extends ColoredComponent {
  constructor({ elements = [], lattice = [], positions = [], colors = [] } = {}) {
    super({ colors });
    this.elements = elements;
    this.lattice = lattice;   // 3×3
    this.positions = positions; // 3×N
  }

  get N() {
    return this.elements.length;
  }

  validate() {
    if (this.positions.length !== 3 * this.N)
      throw new Error("Positions must be 3×N");
    if (this.lattice.length !== 9)
      throw new Error("Lattice must be 3×3");
  }
}

