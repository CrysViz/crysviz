import { ColoredObject } from './ColoredObject.js';
import { getColorFromMap } from '../defaults/color_texture_defaults.js';
import * as THREE from '../external/three/three.module.js';

export class Force extends ColoredObject {
  constructor({ vector = [], scaling = null, color = null } = {}) {
    const colorObj = color ?
      (color instanceof THREE.Color ? color : new THREE.Color(/** @type {any} */ (color))) :
      new THREE.Color('#cc4444');

    super({ color: colorObj, defaultColor: colorObj });

    this.vector = vector;
    this.scaling = scaling;
    // Sticky per-arrow color pick (StructureInfoPanel's Spin/Force row
    // editor "Color" button) — same precedent as Atom.userColor: wins over
    // whatever the live colormap would otherwise compute, until cleared.
    this.userColor = null;
    // Per-arrow ray/path-tracing material override; raster arrows ignore it.
    this.userMaterial = null;
    // Per-atom arrow visibility (that row's "Hide" checkbox), independent of
    // the Forces panel's per-species show/hide toggles.
    this.hidden = false;
  }

  /** The color actually rendered: userColor when pinned, else the colormap-driven one. */
  getColor() {
    return this.userColor ?? this.color;
  }

  updateColor(value, colormap) {
    this.color = getColorFromMap(value, colormap);
  }

  // NEW: get length of each vector
  getLength() {
    return this.vector.map((_, i) => {
      const x = this.vector[i];
      const y = this.vector[i];
      const z = this.vector[i];
      return Math.sqrt(x*x + y*y + z*z);
    });
  }
}
