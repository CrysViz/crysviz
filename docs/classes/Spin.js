import { ColoredObject } from './ColoredObject.js';

export class Spin extends ColoredObject {
  constructor({ vector = [], scaling = null, color = [], spinGroup = null } = {}) {
    super({ color, defaultColor: color });
    this.vector = vector;      // 3×N
    this.scaling = scaling;  // N
    this.color = color;
    this. defaultColor = color;
  }
  get N() {
    return this.scaling.length;
  }
}

