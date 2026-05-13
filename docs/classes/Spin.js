import { ColoredObject } from './ColoredObject.js';
import {getColorFromMap} from '../defaults/color_texture_defaults.js'
import * as THREE from '../external/three/three.module.js';


export class Spin extends ColoredObject {
  constructor({ vector = [], scaling = null, color = [], atomIndex = null, element = null, position = null } = {}) {
        const colorObj = color ?
      (color instanceof THREE.Color ? color : new THREE.Color(color)) :
      new THREE.Color("#008080");

    super({ color: colorObj, defaultColor: colorObj });

    // Store current values
    this.vector = vector;
    this.scaling = scaling;
    this.atomIndex = atomIndex;
    this.element = element;
    this.position = position;
    // Store original values (immutable)
    this.original = Object.freeze({
      vector: [...vector],
      scaling: scaling,
      color: color,
      atomIndex: atomIndex,
      element: element,
      position: position ? [...position] : null
    });
  }

  get N() {
    return this.scaling ? this.scaling.length : 1;
  }

  setColor(color){
    this.color= color
  }

  updateColor(value, colormap) {
    this.color = getColorFromMap(value, colormap);
  }

  reset() {
    // Restore from original data
    this.vector = [...this.original.vector];
    this.scaling = this.original.scaling;
    this.color = this.original.color;
    // Note: atomIndex, element, and position are typically immutable
  }
}
