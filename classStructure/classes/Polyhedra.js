import { ColoredComponent } from './ColoredComponent.js';

export class Polyhedron {
  constructor({ name = "", vertices = [], centerIndex = null, type = null } = {}) {
    this.name = name;
    this.vertices = vertices;
    this.centerIndex = centerIndex;
    this.type = type;
  }

  get numVertices() {
    return this.vertices.length;
  }
}

class Polyhedra extends ColoredComponent {
  constructor({ items = [], colors = [] } = {}) {
    super({ colors });
    this.items = items.map(p => p instanceof Polyhedron ? p : new Polyhedron(p));
  }

  get M() {
    return this.items.length;
  }
}

