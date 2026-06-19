import { app, groups, fileBrowser, general,mode, polyStyle} from '../store.js';
import { Structure} from '../model/Structure.js';
import { Atom} from '../model/Atom.js';
import { StructureContainer} from '../model/StructureContainer.js';
import {updateVisualization} from '../crystal-viewer.js'
import {generateID} from './UUIDModule.js'

export function createSupercell(nx = 1, ny = 1, nz = 1) {

  const basePositions = fileBrowser.selectedStructure.original.atoms.map(a => a.position)
  const baseElements = [...fileBrowser.selectedStructure.original.elements];

  let baseLattice;

  baseLattice = fileBrowser.selectedStructure.original.lattice.map(r => [...r]);;

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
  //
  const atoms = [];
    newPositions.forEach((pos, i) => {
    atoms.push(new Atom({
      position: pos,
      element: newElements[i],
      uuid: generateID([newElements[i]], "Atom-")
    }));
  });
  fileBrowser.selectedStructure.elements = newElements;
  fileBrowser.selectedStructure.atoms = atoms

  fileBrowser.selectedStructure.lattice = newLattice;
  fileBrowser.selectedStructure.supercell = { nx, ny, nz };


  // Re-render
  //
  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: true
  });
}
