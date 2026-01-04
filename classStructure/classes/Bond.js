import { general, defaultColorMap, jmolColorMap} from '../store.js';


export class Bond {
  constructor({
    elements = [],
    vector = [],
    idcs_unique = [],
    idcs_wrapped = [],
    length = null,
    origin = null, // can be cell, periodic, drawn
    defaultColors = [],
  } = {}) {
    // Safely set default colors for the bond
    const color1 = elements.length > 0 ? (colorScheme[elements[0]] || 0x808080) : 0x808080;
    const color2 = elements.length > 1 ? (colorScheme[elements[1]] || 0x808080) : 0x808080;
    this.defaultColor = [color1, color2];
    this.color = this.defaultColor;

  }
}

