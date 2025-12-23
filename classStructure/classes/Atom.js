import { ColoredObject } from './ColoredObject.js';
import { general, defaultColorMap, jmolColorMap} from '../store.js';

export class Atom extends ColoredObject {
  constructor({
    element = [],
    position = [],
    coordination = [],
    color = null,
    defaultColor=null,
  } = {}) {
    // Call parent constructor
    super({ color, defaultColor });
    // Mutable instance properties
    this.position = position.map(c => ((c % 1) + 1) % 1);;   // 3×1
    const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
    this.coordination = null;
    this.defaultColor = null;
    this.defaultColor = colorScheme[element] || 0x808080;
    // Current mutable colors
    this.color = this.defaultColor;
    // Create an immutable snapshot of the original data
    this.original = Object.freeze({
      element:element,
      position: [...position], 
    });
   }
  }

