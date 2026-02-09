import { ColoredObject } from './ColoredObject.js';
import { general, defaultColorMap, jmolColorMap} from '../store.js';
import {Wyckoff} from './Wyckoff.js'

export class Atom extends ColoredObject {
  constructor({
    element = [],
    position = [],
    coordination = [],
    color = null,
    defaultColor=null,
    hash = null,
    wyckoff = null,
    UUID = null,
  } = {}) {
    // Call parent constructor
    super({ color, defaultColor });
    // Mutable instance properties
    this.position = position;
    const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
    this.coordination = null;
    this.defaultColor = colorScheme[element] || 0x808080;
    // Current mutable colors
    this.color = this.defaultColor;
    this.UUID = UUID
    // Create an immutable snapshot of the original data
    this.original = Object.freeze({
      element:element,
      position: [...position], 
      color:color,
    });
   }
  }

