import { Structure } from './Structure.js';

export class StructureContainer {
  constructor({
    fileName = null,
    structures = [],
    finalSCF = false,
  } = {}) {
    this.fileName = fileName ? fileName : "Unspecified";
    this.structures = this._ensureListOfClass(structures, Structure);
    this.finalSCF=finalSCF;
  }

  _ensureListOfClass(input, ClassType) {
    if (!Array.isArray(input)) {
      input = [input];
    }

    return input.map(item =>
      item instanceof ClassType ? item : new ClassType(item)
    );
  }
  flushColorToAllStructures(targetStructure) {
    this.structures.forEach(structure => {
      if (structure === targetStructure) return; // Skip the target itself

      // Copy atom colors
      structure.atoms.forEach((atom, atomIndex) => {
        if (targetStructure.atoms[atomIndex]) {
          atom.color = targetStructure.atoms[atomIndex].color;
          atom.opacity = targetStructure.atoms[atomIndex].opacity;
          atom.elementColor = targetStructure.atoms[atomIndex].elementColor;
          atom.elementOpacity = targetStructure.atoms[atomIndex].elementOpacity;
          atom.radiusScale = targetStructure.atoms[atomIndex].radiusScale ?? 1;
        }
      });

      // Copy bond colors
      structure.bonds.forEach((bond, bondIndex) => {
        if (targetStructure.bonds[bondIndex] && targetStructure.bonds[bondIndex].color) {
          bond.color = [...targetStructure.bonds[bondIndex].color]; // Deep copy if needed
        }
      });
    });
  }



}
