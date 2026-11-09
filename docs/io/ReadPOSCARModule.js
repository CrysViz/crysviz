import { Structure } from "../model/index.js";
import { Atom } from "../model/index.js";
import { transpose3x3, invert3x3, normalizeFractional, cartToFractional, latticeVolume } from "../math/index.js";
import { runPeriodicWrapped } from "../render/index.js";
import { generateID } from "../utils/index.js";
import { PT } from "./ReadCubeModule.js";

const ELEMENT_SYMBOLS = new Set(Object.values(PT));
const LEADING_SYMBOL = /^([A-Z][a-z]?)/;

/**
 * Species of a VASP 4 POSCAR (no line of symbols), one per count group:
 *  1. the label after each atom's coordinates (AFLOW writes "0.0 0.5 0.25 C"),
 *     when every atom of a group carries the same element symbol;
 *  2. else the title, when its first word is a formula naming one element per
 *     group, in order ("C11N4 [TET,...]" with counts "11 4" -> C, N).
 * Anything else throws: a guessed species would show the wrong crystal.
 */
function speciesForVasp4(counts, labels, title) {
  const symbolOf = (label) => {
    const s = (label || '').match(LEADING_SYMBOL)?.[1];
    return s && ELEMENT_SYMBOLS.has(s) ? s : null;
  };
  let start = 0;
  const fromLabels = counts.map((n) => {
    const group = labels.slice(start, (start += n)).map(symbolOf);
    return group.length && group[0] && group.every((s) => s === group[0]) ? group[0] : null;
  });
  if (fromLabels.every(Boolean)) return fromLabels;

  const formula = String(title || '').trim().split(/\s+/)[0] || '';
  const fromTitle = /^([A-Z][a-z]?\d*(\.\d+)?)+$/.test(formula) ? formula.match(/[A-Z][a-z]?/g) : [];
  if (fromTitle.length === counts.length && fromTitle.every((s) => ELEMENT_SYMBOLS.has(s))) return fromTitle;

  throw new Error('POSCAR: no element names (VASP 4 format). Add a line of element symbols above the atom counts.');
}

// Pure POSCAR/CONTCAR parser: parses the content and returns a Structure.
// (Moved out of ui/StructureInputModule so the io layer no longer depends on ui.)
export function readPOSCAR(content, fileName) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  let i = 0;

  i++; // skip the comment line
  const scaleOrVolume = parseFloat(lines[i++]);
  if (!Number.isFinite(scaleOrVolume)) throw new Error('POSCAR: missing scale factor');

  // --- lattice (3×3)
  const lattice = Array.from({ length: 3 }, () =>
    (lines[i++] || '').trim().split(/\s+/).slice(0, 3).map(v => parseFloat(v))
  );

  // A negative scale factor is the target cell volume (VASP convention).
  // Scaling every lattice vector by s scales the volume by s³, so the linear
  // factor is the cube root of the volume ratio.
  let scale = scaleOrVolume;
  if (scaleOrVolume < 0) {
    const volume = latticeVolume(lattice);
    if (!(volume > 0)) throw new Error('POSCAR: degenerate lattice, cannot apply a target volume');
    scale = Math.cbrt(-scaleOrVolume / volume);
  }
  lattice.forEach((row) => row.forEach((v, c) => { row[c] = v * scale; }));

  // --- element symbols + counts
  // VASP 5 has a line of symbols before the counts. VASP 4 (still written by
  // AFLOW, and old CHGCAR headers) goes straight to the counts; its species
  // are then taken after the positions are read (speciesForVasp4).
  const speciesOrCounts = (lines[i++] || '').trim().split(/\s+/);
  const vasp4 = speciesOrCounts.every((t) => /^\d+$/.test(t));
  const elementLine = vasp4 ? null : speciesOrCounts;
  const countLine = (vasp4 ? speciesOrCounts : (lines[i++] || '').trim().split(/\s+/))
    .map(x => parseInt(x, 10));

  if (
    !countLine.length ||
    (elementLine && elementLine.length !== countLine.length)
  ) {
    throw new Error('POSCAR: invalid element/count lines');
  }
  if (!countLine.every(Number.isFinite)) throw new Error('POSCAR: invalid atom count');

  // --- coordinate type (Direct/Cartesian)
  let coordType = (lines[i] || '').trim().toLowerCase();
  if (coordType.startsWith('s')) {
    i++;
    coordType = (lines[i] || '').trim().toLowerCase();
  }
  i++;

  const isCartesian = coordType.startsWith('c') || coordType.startsWith('k');
  const totalAtoms = countLine.reduce((a, b) => a + b, 0);

  // --- read raw positions (and any per-atom label after them)
  const positionsRaw = [];
  const atomLabels = [];
  for (let n = 0; n < totalAtoms; n++) {
    const tokens = (lines[i++] || '').trim().split(/\s+/);
    if (tokens.length < 3) throw new Error('POSCAR: atomic position line too short');
    // Cartesian coordinates are in the same scaled units as the lattice.
    positionsRaw.push(tokens.slice(0, 3).map(v => (isCartesian ? Number(v) * scale : Number(v))));
    // Selective dynamics flags (T/F) come first when present; the label, if
    // any, is the first token after them.
    atomLabels.push(tokens.slice(3).find((t) => !/^[TF]$/.test(t)) ?? null);
  }

  // --- flattened list of all atoms
  const species = elementLine ?? speciesForVasp4(countLine, atomLabels, lines[0]);
  const elements = [];
  species.forEach((el, idx) => {
    for (let c = 0; c < countLine[idx]; c++) elements.push(el);
  });

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
  // Deduped, not elementLine: a POSCAR may legitimately list a symbol more than
  // once ("Ba Y Ba"), which CrysViz's own share export now does to preserve
  // atom order — elementLine would then hand every consumer a species list with
  // repeats in it.
  uniqueElements: [...new Set(elements)],
  lattice: lattice,
  atoms: atoms,
  periodic: periodic,
  volumetricFields:null
  });

  return structure
}
