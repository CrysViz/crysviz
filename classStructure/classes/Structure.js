import { ColoredComponent } from './ColoredComponent.js';
import { general, defaultColorMap, jmolColorMap} from '../store.js';

export class Structure extends ColoredComponent {

  constructor({ elements = [], supercell={}, uniqueElements =[], lattice = [], positions = [], colors = [], atomsGroup = null, latticeGroup = null, } = {}) {
    super({ colors,defaultColors });
    this.elements = elements;
    this.supercell = supercell
    this.uniqueElements = [...new Set(elements)];
    this.lattice = lattice;   // 3×3
    this.positions = positions; // 3×N
    this.atomsGroup = atomsGroup; // THREE group for atoms
    this.latticeGroup = latticeGroup; // THREE group for lattice

    const colorScheme = general.useDefaultColors ? defaultColorMap : jmolColorMap;
    this.defaultColors = {};
    for (const element of this.elements) {
      this.defaultColors[element] = colorScheme[element] || 0x808080;
    }

    this.colors = this.defaultColors;
  }


  get NumberOfAtoms() {
    return this.positions.length;
    }

  validate() {
    if (this.positions.length !== 3 * this.NumberOfAtoms)
      throw new Error("positions must be 3×N");

    if (this.lattice.length !== 9)
      throw new Error("lattice must be 3×3");

    if (this.elements !== this.NumberOfAtoms);
      throw new Error("elements must be N");

    if (this.defaultColors.length !== this.NumberOfAtoms);
      throw new Error("defaultColors must be N");
    }
  }

