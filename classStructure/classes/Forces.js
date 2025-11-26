import { ColoredObject } from './ColoredObject.js';

export class Forces extends ColoredObject {
  constructor({ vectors = [], scaling = [], colors = [], forcesGroup = null } = {}) {
    super({ colors, defaultColors });
    this.vectors = vectors;   // 3×N
    this.scaling = scaling; // N
    this.forcesGroup = forcesGroup;
  }

  get N() {
    return this.scaling.length;
  }
}

