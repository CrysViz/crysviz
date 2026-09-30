// ReadCubeModule.js
// Gaussian .cube files → Structure + Fields (format parsing in cubeParse.js)
// Exports: readCubeFile(), readCubeStructure()
//
import { Structure } from '../model/index.js';
import { invert3x3, transpose3x3, cartToFractional, normalizeFractional } from '../math/index.js';
import { runPeriodicWrapped } from '../render/index.js';
import { Field } from '../model/index.js';
import { FieldContainer } from '../model/index.js';
import { computeFieldStats } from '../model/index.js';
import { Atom } from '../model/index.js';
import { generateID } from '../utils/index.js';
import { parseCube } from './cubeParse.js';


//------------------------------------------------------------
//  Periodic table (lookup table for cube files as it contains 
//                  only the element number) ! Check if everythig is correct!
//------------------------------------------------------------
export const PT = {
  1: "H",   2: "He",
  3: "Li",  4: "Be",  5: "B",   6: "C",   7: "N",   8: "O",   9: "F",   10: "Ne",
  11: "Na", 12: "Mg", 13: "Al", 14: "Si", 15: "P",  16: "S",  17: "Cl", 18: "Ar",
  19: "K",  20: "Ca", 21: "Sc", 22: "Ti", 23: "V",  24: "Cr", 25: "Mn", 26: "Fe",
  27: "Co", 28: "Ni", 29: "Cu", 30: "Zn", 31: "Ga", 32: "Ge", 33: "As", 34: "Se",
  35: "Br", 36: "Kr",
  37: "Rb", 38: "Sr", 39: "Y",  40: "Zr", 41: "Nb", 42: "Mo", 43: "Tc", 44: "Ru",
  45: "Rh", 46: "Pd", 47: "Ag", 48: "Cd", 49: "In", 50: "Sn", 51: "Sb", 52: "Te",
  53: "I",  54: "Xe",
  55: "Cs", 56: "Ba",
  // Lanthanides
  57: "La", 58: "Ce", 59: "Pr", 60: "Nd", 61: "Pm", 62: "Sm", 63: "Eu", 64: "Gd",
  65: "Tb", 66: "Dy", 67: "Ho", 68: "Er", 69: "Tm", 70: "Yb", 71: "Lu",
  // Transition continues
  72: "Hf", 73: "Ta", 74: "W",  75: "Re", 76: "Os", 77: "Ir", 78: "Pt", 79: "Au",
  80: "Hg", 81: "Tl", 82: "Pb", 83: "Bi", 84: "Po", 85: "At", 86: "Rn",
  87: "Fr", 88: "Ra",
  // Actinides
  89: "Ac", 90: "Th", 91: "Pa", 92: "U",  93: "Np", 94: "Pu", 95: "Am", 96: "Cm",
  97: "Bk", 98: "Cf", 99: "Es", 100: "Fm", 101: "Md", 102: "No", 103: "Lr",
  // Final row
  104: "Rf", 105: "Db", 106: "Sg", 107: "Bh", 108: "Hs", 109: "Mt", 110: "Ds",
  111: "Rg", 112: "Cn", 113: "Nh", 114: "Fl", 115: "Mc", 116: "Lv", 117: "Ts",
  118: "Og"
};

//------------------------------------------------------------
//  readCubeFile(content, fileName) → { fileName, structure_with_field }
//
//  Units and layout are handled by io/cubeParse.js; everything it returns is
//  in Angstrom. The system is shifted so the grid origin sits at the cell
//  corner (Field origin [0,0,0]), which is where the renderer draws the grid.
//  The cell is the grid box n_i * step_i: exact for periodic codes (CP2K,
//  Quantum ESPRESSO), and for a molecular Gaussian cube a box one voxel wider
//  than the sampled points, with the same spacing.
//------------------------------------------------------------
export function readCubeFile(content, fileName) {
  const cube = parseCube(content);
  const structure = readCubeStructure(cube);

  const fields = cube.values.map((values, index) => new Field({
    nx: cube.grid[0],
    ny: cube.grid[1],
    nz: cube.grid[2],
    origin: [0, 0, 0],
    voxel: cube.voxel,
    values,
    component: index,
    label: datasetLabel(cube, index),
    // One pass instead of the four separate `reduce` walks this used to do
    // over an array that runs to millions of entries.
    ...computeFieldStats(values),
  }));

  const container = new FieldContainer({
    fileName: fileName,
    source: "Cube",
    fields: fields,
    fieldCount: fields.length
  });

  structure.volumetricFields = container; // Attach field container to structure for easy access in rendering
  return {
    fileName,
    structure_with_field: structure
  };
}

/** The comment label, qualified by orbital id / value index when the file
 *  holds more than one dataset. */
function datasetLabel(cube, index) {
  if (cube.datasetIds) return `${cube.label} (MO ${cube.datasetIds[index]})`.trim();
  if (cube.values.length > 1) return `${cube.label} (value ${index + 1})`.trim();
  return cube.label;
}

/** @param {import('./cubeParse.js').CubeData} cube */
export function readCubeStructure(cube) {
  const lattice = cube.lattice;
  const elements = cube.atoms.map((a) => PT[a.atomicNumber] || "X");
  // Shift by the grid origin so atoms and field share the cell-corner frame.
  const positions_cart = cube.atoms.map((a) => a.position.map((c, k) => c - cube.origin[k]));

  // --- convert cart → frac
  const latticeInverse = invert3x3(transpose3x3(lattice));
  const positions = (
    positions_cart.map(vec => cartToFractional(vec, lattice, latticeInverse))
  ).map(pos => pos.map(normalizeFractional));

  const atoms = [];

  positions.forEach((pos, i) => {
    atoms.push(new Atom({
      position: pos,
      element: elements[i],
      uuid: generateID([elements[i]])
    }));
  });

  let periodic = runPeriodicWrapped(
    { hash: "None", wrapped: {} },
    positions,
    elements,
    lattice
  );

  const structure = new Structure({
    elements: elements,
    uniqueElements: [...new Set(elements)],
    lattice: lattice,
    atoms: atoms,
    periodic: periodic
  });

  return structure;
}
