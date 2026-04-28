import { ColoredObject } from './ColoredObject.js';
import { general, defaultColorMap, jmolColorMap } from '../store.js';
import { Wyckoff } from './Wyckoff.js';

export class Atom extends ColoredObject {
  constructor({
    element = [],
    position = [],
    coordination = [],
    color = null,
    opacity = 1,
    defaultColor = null,
    elementColor = null,
    hash = null,
    wyckoff = null,
    uuid = null,
  } = {}) {
    super({ color, defaultColor });
    this.position = position;
    this.coordination = null;
    const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
    this.defaultColor = colorScheme[element] || 0x808080;
    this.elementColor = elementColor || this.defaultColor;
    this.color = color || this.elementColor;
    this.opacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    this.uuid = uuid;
    this.original = Object.freeze({
      element,
      position: [...position],
      color: color,
      opacity: this.opacity,
    });
  }

  // Get the current color of the atom
  getColor() {
    return this.color;
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

  resetOpacity() {
    this.opacity = this.original.opacity ?? 1;
    return true;
  }

  // Reset to the element's custom color (if set), otherwise to default
  resetToElementColor() {
    this.color = this.elementColor;
    return true;
  }

  // Reset to the element's default color (from map)
  resetToDefaultColor() {
    const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
    this.color = colorScheme[this.original.element] || 0x808080;
    this.elementColor = this.color;
    return true;
  }
}
