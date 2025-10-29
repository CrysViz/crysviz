import { ColoredObject } from './ColoredObject.js';

export class Spin extends ColoredObject {
  constructor({ spins = [], scaling = [], colors = [], spinGroup = null } = {}) {
    super({ colors, defaultColors });
    this.spins = spins;      // 3×N
    this.scaling = scaling;  // N
    this.spinGroup = spinGroup
  }



  get N() {
    return this.scaling.length;
  }
}

