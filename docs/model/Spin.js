import { ColoredObject } from './ColoredObject.js';
import {getColorFromMap} from '../defaults/color_texture_defaults.js'
import * as THREE from '../external/three/three.module.js';


export class Spin extends ColoredObject {
  /** @param {{vector?:any, scaling?:any, color?:any, atomIndex?:any, element?:any, position?:any}} [opts] */
  constructor({ vector = [], scaling = null, color = [], atomIndex = null, element = null, position = null } = {}) {
        const colorObj = color ?
      (color instanceof THREE.Color ? color : new THREE.Color(/** @type {any} */ (color))) :
      new THREE.Color("#008080");

    super({ color: colorObj, defaultColor: colorObj });

    // Store current values
    this.vector = vector;
    this.scaling = scaling;
    this.atomIndex = atomIndex;
    this.element = element;
    this.position = position;
    // Sticky per-arrow color pick (StructureInfoPanel's Spin/Force row
    // editor "Color" button) — same precedent as Atom.userColor: wins over
    // whatever the live colormap would otherwise compute, until cleared.
    this.userColor = null;
    // Per-atom arrow visibility (that row's "Hide" checkbox), independent of
    // the Spins panel's per-species show/hide toggles.
    this.hidden = false;
    // Store original values (immutable). color is colorObj (the resolved
    // THREE.Color), not the raw constructor param — that param defaults to
    // [] (an empty array, not a color), which reset() below would otherwise
    // hand back as this.color, breaking anything expecting a THREE.Color
    // (getHexString(), instance-buffer .r/.g/.b reads) until the next
    // colormap pass overwrote it.
    this.original = Object.freeze({
      vector: [...vector],
      scaling: scaling,
      color: colorObj,
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

  /** The color actually rendered: userColor when pinned, else the colormap-driven one. */
  getColor() {
    return this.userColor ?? this.color;
  }

  updateColor(value, colormap) {
    this.color = getColorFromMap(value, colormap);
  }

  reset() {
    // Restore from original data
    this.vector = [...this.original.vector];
    this.scaling = this.original.scaling;
    this.color = this.original.color;
    this.userColor = null;
    // Note: atomIndex, element, and position are typically immutable
  }
}
