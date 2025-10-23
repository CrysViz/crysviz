import { ColoredComponent } from './ColoredComponent.js';

class Spin extends ColoredComponent {
  constructor({ spins = [], scaling = [], colors = [] } = {}) {
    super({ colors });
    this.spins = spins;      // 3×N
    this.scaling = scaling;  // N
  }

  get N() {
    return this.scaling.length;
  }
}

