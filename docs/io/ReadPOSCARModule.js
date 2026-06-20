import { Structure } from "../model/index.js";
import { Atom } from "../model/index.js";
import { transpose3x3, invert3x3, normalizeFractional, cartToFractional } from "../math/index.js";
import { runPeriodicWrapped } from "../render/index.js";
import { generateID } from "../utils/index.js";

// Pure POSCAR/CONTCAR parser: parses the content and returns a Structure.
// (Moved out of ui/StructureInputModule so the io layer no longer depends on ui.)
export function readPOSCAR(content, fileName) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  let i = 0;

  i++; // skip the comment line
  const scale = parseFloat(lines[i++]);
  if (!Number.isFinite(scale)) throw new Error('POSCAR: missing scale factor');

  // --- lattice (3×3)
  const lattice = Array.from({ length: 3 }, () =>
    (lines[i++] || '').trim().split(/\s+/).slice(0, 3).map(v => parseFloat(v) * scale)
  );

  // --- element symbols + counts
  const elementLine = (lines[i++] || '').trim().split(/\s+/);
  const countLine = (lines[i++] || '').trim().split(/\s+/).map(x => parseInt(x, 10));

  if (
    !elementLine.length ||
    !countLine.length ||
    elementLine.length !== countLine.length
  ) {
    throw new Error('POSCAR: invalid element/count lines');
  }

  // --- flattened list of all atoms
  const elements = [];
  elementLine.forEach((el, idx) => {
    const repetitions = countLine[idx];
    if (!Number.isFinite(repetitions)) throw new Error('POSCAR: invalid atom count');
    for (let c = 0; c < repetitions; c++) elements.push(el);
  });

  // --- coordinate type (Direct/Cartesian)
  let coordType = (lines[i] || '').trim().toLowerCase();
  if (coordType.startsWith('s')) {
    i++;
    coordType = (lines[i] || '').trim().toLowerCase();
  }
  i++;

  const isCartesian = coordType.startsWith('c') || coordType.startsWith('k');
  const totalAtoms = countLine.reduce((a, b) => a + b, 0);

  // --- read raw positions
  const positionsRaw = [];
  for (let n = 0; n < totalAtoms; n++) {
    const tokens = (lines[i++] || '').trim().split(/\s+/);
    if (tokens.length < 3) throw new Error('POSCAR: atomic position line too short');
    positionsRaw.push(tokens.slice(0, 3).map(Number));
  }

  // --- convert cart → frac if needed
  const latticeInverse = isCartesian ? invert3x3(transpose3x3(lattice)) : null;
  const positions = (isCartesian
    ? positionsRaw.map(vec => cartToFractional(vec, lattice, latticeInverse))
    : positionsRaw
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
  uniqueElements: elementLine,
  lattice: lattice,
  atoms: atoms,
  periodic: periodic,
  volumetricFields:null
  });

  return structure
}
