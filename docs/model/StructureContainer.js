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
    // Per-frame plot series for the Trajectory panel (step / temperatureK /
    // etotEv / meanForce / pressure / ...), each a number[] 1:1 with structures.
    // Populated by live MD/relax and "Compute step stats"; null until then.
    /** @type {Record<string, number[]> | null} */
    this.plotSeries = null;
    // Per-structure camera/feature-toggle memory, used only while the
    // corresponding lock (state/store.js's app.cameraLocked / general.featuresLocked)
    // is off — see FileBrowswerPanel.js's updateStructureFromRowAndStep.
    this.cameraSnapshot = null;
    this.featureSnapshot = null;
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

  /**
   * Deep-copy every per-structure style store from targetStructure (the
   * current frame) to all other frames. Keys are index/geometry-derived and
   * assume frames share atom count/order (true for OUTCAR/eXYZ trajectories);
   * entries that go stale on a frame (e.g. atoms drifting across cell
   * boundaries change wrapped-index keys) are ignored by the stores'
   * element/geometry sanity checks at apply time.
   */
  flushStylesToAllStructures(targetStructure) {
    // atomMaterials/atomUserMaterials (per-species / per-atom ray-tracing
    // material overrides) travel alongside the style stores below — without
    // them here, no Apply/Reset action in the app ever propagated a material
    // override to other trajectory frames.
    const STORES = ['atomImageStyles', 'bondUserStyles', 'bondCategoryStyles',
                    'polyhedraUserStyles', 'polyhedraCategoryStyles',
                    'atomMaterials', 'atomUserMaterials',
                    'spinCategoryStyles', 'forceCategoryStyles'];
    this.structures.forEach(structure => {
      if (structure === targetStructure) return;
      for (const k of STORES) {
        structure[k] = JSON.parse(JSON.stringify(targetStructure[k] ?? {}));
      }
    });
  }

}
