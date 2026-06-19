// LatticeTransformModule.js
import { updateVisualization } from '../crystal-viewer.js';
import { resetView } from './WindowAndSceneControls.js';
import {fileBrowser} from '../store.js'

export function applyLatticeTransformation(matrix) {
  // Clone the lattice to avoid modifying the original directly
  const L = fileBrowser.selectedStructure.lattice.map(row => [...row]);
  const atoms = fileBrowser.selectedStructure.atoms;
  const newL = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

  // --- 1. Linear transformation (3x3 part) ---
  // Only transform the lattice vectors, not the fractional coordinates
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        newL[i][j] += matrix[i][k] * L[k][j];
      }
    }
  }

  // --- 2. Shift (translation) ---
  // Extract the shift vector from the last column of the matrix
  const shift = [matrix[0][3], matrix[1][3], matrix[2][3]];

  // Only apply shift to fractional coordinates (relative origin shift)
  if (shift.some(s => Math.abs(s) > 1e-6)) {
    for (let i = 0; i < atoms.length; i++) {
      // Assign a new array to position
      atoms[i].position = [
        atoms[i].position[0] - shift[0],
        atoms[i].position[1] - shift[1],
        atoms[i].position[2] - shift[2]
      ];
    }
  }

  // Update the structure
  fileBrowser.selectedStructure.lattice = newL;

  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: true,
    reRenderOther: false,
  });
  resetView();
  console.log("Transformation applied.", {shift, newL});
}
