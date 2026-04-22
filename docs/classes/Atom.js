import { ColoredObject } from './ColoredObject.js';

import {general} from '../store.js';
import {atomicRadii} from '../defaults/radii_defaults.js'
import {defaultColorMap, jmolColorMap} from '../defaults/color_texture_defaults.js'


import { Wyckoff } from './Wyckoff.js';

export class Atom extends ColoredObject {
  constructor({
    element = [],
    position = [],
    coordination = [],
    color = null,
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
    this.uuid = uuid;
    this.original = Object.freeze({
      element,
      position: [...position],
      color: color,
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

