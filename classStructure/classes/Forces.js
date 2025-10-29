import { ColoredObject } from './ColoredObject.js';

export class Forces extends ColoredObject {
  constructor({ forces = [], scaling = [], colors = [], forcesGroup = null } = {}) {
    super({ colors, defaultColors });
    this.forces = forces;   // 3×N
    this.scaling = scaling; // N
    this.forcesGroup = forcesGroup;
  }

  get N() {
    return this.scaling.length;
  }
}

