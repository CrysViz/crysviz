// ReadCubeModule.js
// Parser for Gaussian .cube volumetric files + Marching Cubes isosurface extraction
// Exports: readCubeFile(), updateField()
//
import { Structure } from '../classes/Structure.js';
import { invert3x3, transpose3x3, cartToFractional, normalizeFractional } from './StructureInputModule.js';
import { runPeriodicWrapped } from './LatticeModule.js';
import { Field } from '../classes/Field.js';
import { FieldContainer } from '../classes/FieldContainer.js';
import { Atom } from '../classes/Atom.js';
import { generateID } from './UUIDModule.js';


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

export const Bohr2Angstrom = 0.529177249; // conversion factor from Bohr to Angstroms

//------------------------------------------------------------
//  readCubeFile(file) → { lattice, positions_cart, field }
//------------------------------------------------------------
export function readCubeFile(content,fileName) {

  const lines = content.trim().split(/\r?\n/).filter(l => l.trim());
  const label = lines.slice(0, 2).map(l => l.trim()).join(" ");
  let i = 2; // skip first 2 comment lines

  let line = lines[i].trim().split(/\s+/);
  const natoms = parseInt(line[0]);
  const origin = line.slice(1, 4).map(parseFloat);

  const density_lines = lines.slice(5 + natoms + 1, lines.length);
  const structure_lines = lines.slice(0, 5 + natoms + 1);

  let structure = readCubeStructure(structure_lines, fileName);

  let isBorh = [];
  let grid = [];
  for (let j = 0; j < 3; j++) {
    i++;
    line = lines[i].trim().split(/\s+/);
    const n = parseInt(line[0]);
    grid.push(n);
    isBorh.push(n >= 0); // If n is positive, it indicates that the units are in Bohr
  }
  const voxel = structure.lattice.map((vec, row) => vec.map(c => c / grid[row]));
  const npoints = grid.reduce((a, b) => a * b, 1);
  const zd = grid[0] * grid[1];
  const yd = grid[0];
  
  let lineIndex = 0;
  let indexInLine = 0;
  let gridIndex = 0;
  let element = 0;
  const field_values = new Float32Array(npoints); 
  line = density_lines[lineIndex].trim().split(/\s+/);
  // marching cubes expects iteration order of z,y,x (slowest to fastest)
  for (let x = 0; x < grid[2]; x++) {
    for (let y = 0; y < grid[1]; y++) {
      for (let z = 0; z < grid[0]; z++) {
        gridIndex = z * zd + y * yd + x;
        if (lineIndex >= density_lines.length) {
          console.error("Not enough lines in density data");
          break;
        }
        if (indexInLine >= line.length) {
          lineIndex++;
          indexInLine = 0;
          line = density_lines[lineIndex].trim().split(/\s+/);
        }
        element = parseFloat(line[indexInLine]);
        field_values[gridIndex] = element;
        indexInLine++;
      }
    }
  }

  const MaxValue = field_values.reduce((max, val) => Math.max(max, val), -Infinity);
  const MinValue = field_values.reduce((min, val) => Math.min(min, val), Infinity);
  const AbsMaxValue = field_values.reduce((max, val) => Math.max(max, Math.abs(val)), 0);
  const AbsMinValue = field_values.reduce((min, val) => Math.min(min, Math.abs(val)), Infinity);
  let fields = [];
  fields.push(new Field({
      nx: grid[0],
      ny: grid[1],
      nz: grid[2],
      origin: [0, 0, 0],
      voxel: voxel, 
      values: field_values,
      component: 0, 
      label: label,
      minValue: MinValue,
      maxValue: MaxValue,
      absMinValue: AbsMinValue,
      absMaxValue: AbsMaxValue
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

export function readCubeStructure(lines, filename) {
  let i = 2; // skip first 2 comment lines
  let line = lines[i].trim().split(/\s+/);
  const natoms = parseInt(line[0]);
  const origin = line.slice(1, 4).map(parseFloat);

  let isBorh = [];
  let lattice = [];
  for (let j = 0; j < 3; j++) {
    i++;
    line = lines[i].trim().split(/\s+/);
    const n = parseInt(line[0]);
    const vec = line.slice(1, 4).map(parseFloat);
    isBorh.push(n >= 0); // If n is positive, it indicates that the units are in Bohr
    lattice.push(vec.map(c => c * n * (isBorh[j] ? Bohr2Angstrom : 1))); // Store lattice vectors in Cartesian coordinates
  }

  const elements = [];
  const positions_cart = [];
  for (let j = 0; j < natoms; j++) {
    i++;
    line = lines[i].trim().split(/\s+/);
    const elementNum = parseInt(line[0]);
    const position = line.slice(2, 5).map((l, index) => (parseFloat(l) - origin[index]) * (isBorh[index] ? Bohr2Angstrom : 1)); // Convert to Cartesian coordinates and shift by origin
    positions_cart.push(position);
    elements.push(PT[elementNum] || "X");
  }

  // --- convert cart → frac if needed
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
      { hash: "None",wrapped: {}},
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
