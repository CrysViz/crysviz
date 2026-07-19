import { ColoredObject } from './ColoredObject.js';

import {getElementDefaultColor} from '../defaults/color_texture_defaults.js'



export class Atom extends ColoredObject {
  constructor({
    element = "",
    position = [],
    coordination = [],
    color = null,
    userColor=null,
    opacity = 1,
    elementOpacity = 1,
    defaultColor = null,
    elementColor = null,
    cutPlaneImmune = false,
    radiusScale = 1,
    hash = null,
    wyckoff = null,
    uuid = null,
  } = {}) {
    super({ color, defaultColor });
    this.position = position;
    // NOTE: the `coordination` constructor argument is intentionally ignored
    // here. Coordination is not known at construction time; it is filled in
    // later by neighbour/bond analysis, so the field just starts as null.
    this.coordination = null;
    this.defaultColor = getElementDefaultColor(element);
    this.userColor=null;
    this.elementColor = elementColor || this.defaultColor;
    const normalizedElementOpacity = Number.isFinite(elementOpacity) ? Math.max(0, Math.min(1, elementOpacity)) : 1;
    this.elementOpacity = normalizedElementOpacity;
    this.color = color || this.elementColor;
    this.opacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : this.elementOpacity;
    this.cutPlaneImmune = !!cutPlaneImmune;
    // Per-atom size multiplier on the element's default radius (1 = default).
    this.radiusScale = Number.isFinite(radiusScale) && radiusScale > 0 ? radiusScale : 1;
    this.uuid = uuid;
    // Hidden atoms are excluded from rendering and from every other panel
    // (composition, bonds, forces, spins, polyhedra, symmetry) but stay in
    // structure.atoms so they can be restored exactly as they were. Not part
    // of `original` below — hiding isn't something a reset-to-as-loaded
    // action should touch.
    this.hidden = false;
    this.original = Object.freeze({
      element,
      position: [...position],
      color: color,
      opacity: this.opacity,
      elementOpacity: this.elementOpacity,
      cutPlaneImmune: this.cutPlaneImmune,
      radiusScale: this.radiusScale,
    });
  }

  // Get the current color of the atom
  getColor() {
    if (!this.userColor) return this.color;
    else return this.userColor
  }

  // Set a custom color for the atom (accepts hex string or number)
  setColor(cssHex) {
    if (!cssHex) return false;
    let hex = cssHex.toString().trim();
    if (hex.startsWith('#')) hex = hex.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
    this.color = parseInt(hex, 16);
    return true;
  }

  getOpacity() {
    return this.opacity;
  }

  setOpacity(value) {
    const opacity = Number(value);
    if (!Number.isFinite(opacity)) return false;
    this.opacity = Math.max(0, Math.min(1, opacity));
    return true;
  }

  setElementOpacity(value) {
    const opacity = Number(value);
    if (!Number.isFinite(opacity)) return false;
    this.elementOpacity = Math.max(0, Math.min(1, opacity));
    return true;
  }

  resetOpacity() {
    this.opacity = this.original.opacity ?? 1;
    return true;
  }

  resetToElementOpacity() {
    this.opacity = this.elementOpacity ?? 1;
    return true;
  }

  getRadiusScale() {
    return this.radiusScale ?? 1;
  }

  setRadiusScale(value) {
    const scale = Number(value);
    if (!Number.isFinite(scale) || scale <= 0) return false;
    this.radiusScale = Math.min(scale, 10);
    return true;
  }

  resetRadiusScale() {
    this.radiusScale = this.original.radiusScale ?? 1;
    return true;
  }

  setCutPlaneImmune(value) {
    this.cutPlaneImmune = !!value;
    return true;
  }

  resetCutPlaneImmune() {
    this.cutPlaneImmune = this.original.cutPlaneImmune ?? false;
    return true;
  }

  // Reset to the element's custom color (if set), otherwise to default
  resetToElementColor() {
    this.color = this.elementColor;
    this.userColor=null;
    return true;
  }

  // Reset to the element's default color (from map)
  resetToDefaultColor() {
    this.color = getElementDefaultColor(this.original.element);
    this.elementColor = this.color;
    this.userColor=null;
    return true;
  }
}
