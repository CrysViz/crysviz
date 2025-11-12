import { app, groups, structureData,originalStructureData, general,mode,defaultPOSCAR, polyStyle, defaultColorMap, jmolColorMap, atomicRadii,getAtomVisSettings,getBondVisSettings,getLatticeVisSettings} from '../store.js';
import { Structure} from '../classes/Structure.js';
import { StructureContainer} from '../classes/StructureContainer.js';
import {updateVisualization} from '../crystal-viewer.js'

export function createSupercell(nx = 1, ny = 1, nz = 1) {

  if (!originalStructureData) return;

  const basePositions = originalStructureData.positions;
  const baseElements = originalStructureData.elements;

  let baseLattice;

  if (general.modifiedLattice == null) {
    // No modified lattice → use original
    baseLattice = originalStructureData.lattice;
  } else {
    if (general.currentSupercell == null) {
      // No supercell info → use as-is
      baseLattice = general.modifiedLattice;
    } else {
      // Scale each lattice vector by its corresponding supercell multiplier
      const { nx, ny, nz } = general.currentSupercell;
      const scales = [nx, ny, nz];
      baseLattice = general.modifiedLattice.map((v, i) => v.map(x => x / scales[i]));
    }
  }

  const newPositions = [];
  const newElements = [];

  // Simple tiling
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        for (let p = 0; p < basePositions.length; p++) {
          const pos = basePositions[p];
          newPositions.push([
            (pos[0] + i) / nx,
            (pos[1] + j) / ny,
            (pos[2] + k) / nz
          ]);
          newElements.push(baseElements[p]);
        }
      }
    }
  }

  // Scale lattice vectors
  const newLattice = [
    baseLattice[0].map(x => x * nx),
    baseLattice[1].map(x => x * ny),
    baseLattice[2].map(x => x * nz)
  ];

  // Update structureData
  structureData.positions = newPositions;
  structureData.elements = newElements;
  structureData.lattice = newLattice;
  structureData.supercell = { nx, ny, nz };
  general.currentSupercell={ nx, ny, nz }


  // Re-render
  //
  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: true
  });
}
