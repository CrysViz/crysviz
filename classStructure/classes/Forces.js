import { ColoredComponent } from './ColoredComponent.js';

class Forces extends ColoredComponent {
  constructor({ forces = [], scaling = [], colors = [] } = {}) {
    super({ colors });
    this.forces = forces;   // 3×N
    this.scaling = scaling; // N
  }

  get N() {
    return this.scaling.length;
  }
}

