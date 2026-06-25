import { ColoredObject } from './ColoredObject.js';

export class Polyhedron extends ColoredObject {
  constructor({ name = "", vertices = [], centerIndex = null, type = null, polyhedraGroup=null } = {}) {
    super();
    this.name = name;
    this.vertices = vertices;
    this.centerIndex = centerIndex;
    this.type = type;
    this.polyhedraGroup = polyhedraGroup;
  }

  get numVertices() {
    return this.vertices.length;
  }
}

