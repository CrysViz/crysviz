import { ColoredObject } from './ColoredObject.js';

export class Force extends ColoredObject {
  constructor({ vector = [], scaling = null, color = [], forcesGroup = null } = {}) {
    super({ color, defaultColor: color });
    this.vector = vector;   // 3
    this.scaling = scaling;   // number
    this.color = color;
    this.defaultColor = color;
  }

  // NEW: get length of each vector
  getLength() {
    return this.vector.map((_, i) => {
      const x = this.vectors[i];
      const y = this.vectors[i];
      const z = this.vectors[i];
      return Math.sqrt(x*x + y*y + z*z);
    });
  }
}

