import { ColoredObject } from './ColoredObject.js';

import {general} from '../state/store.js';
import {defaultColorMap, jmolColorMap} from '../defaults/color_texture_defaults.js'



export class Atom extends ColoredObject {
  constructor({
    element = [],
    position = [],
    coordination = [],
    color = null,
    userColor=null,
    opacity = 1,
    elementOpacity = 1,
    defaultColor = null,
    elementColor = null,
    cutPlaneImmune = false,
    hash = null,
    wyckoff = null,
    uuid = null,
  } = {}) {
    super({ color, defaultColor });
    this.position = position;
    this.coordination = null;
    const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
    this.defaultColor = colorScheme[element] || 0x808080;
    this.userColor=null;
    this.elementColor = elementColor || this.defaultColor;
    const normalizedElementOpacity = Number.isFinite(elementOpacity) ? Math.max(0, Math.min(1, elementOpacity)) : 1;
    this.elementOpacity = normalizedElementOpacity;
    this.color = color || this.elementColor;
    this.opacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : this.elementOpacity;
    this.cutPlaneImmune = !!cutPlaneImmune;
    this.uuid = uuid;
    this.original = Object.freeze({
      element,
      position: [...position],
      color: color,
      opacity: this.opacity,
      elementOpacity: this.elementOpacity,
      cutPlaneImmune: this.cutPlaneImmune,
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
    const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
    this.color = colorScheme[this.original.element] || 0x808080;
    this.elementColor = this.color;
    this.userColor=null;
    return true;
  }
}
