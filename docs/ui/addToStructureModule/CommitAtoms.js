// CommitAtoms.js
//
// The ways an edited atom list ends up in the app's state: applied to the
// currently-loaded Structure (Modify Structure), or used to build a brand-new
// Structure that gets registered as its own file-browser row (Add Structure).
// Both paths are pulled out here, decoupled from any particular panel's UI, so
// the two structure editors and (later) a symmetry/Wyckoff generator can all
// call the same commit logic after running AtomCollisionCheck.js.

import { Atom, Structure, StructureContainer } from '../../model/index.js';
import { fileBrowser, structureShip } from '../../state/store.js';
import { createRow, selectLastAddedRow } from '../FileBrowswerPanel.js';
import { generateID } from '../../utils/index.js';
import { recenterCamera } from '../WindowAndSceneControls.js';

// Parse a "#rrggbb" string to a numeric color, or undefined (=> element default).
export function parseColorHexToInt(hex) {
  if (typeof hex !== 'string') return undefined;
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return undefined;
  return parseInt(h, 16);
}

// Push new atoms (fractional x/y/z inputs, used as-is) into an already-loaded
// Structure. Pushes onto the parallel atoms/elements arrays and recomputes
// uniqueElements. Caller is responsible for refreshing bond controls and
// re-rendering (createBondLengthControls() + updateVisualization({
// reRenderAtoms:true, reRenderBonds:true})).
export function addAtomsToExistingStructure(structure, atomsToAdd) {
  for (const a of atomsToAdd) {
    structure.atoms.push(new Atom({
      position: [a.x, a.y, a.z],
      element: a.element,
      color: parseColorHexToInt(a.color),
      uuid: generateID([a.element]),
    }));
    structure.elements.push(a.element);
  }
  structure.uniqueElements = [...new Set(structure.elements)];
}

// Apply one round of edits from the Modify Structure panel's atom table.
//
// `atoms` is the FINAL atom list in table order: an entry with a uuid is the
// existing atom of that uuid (possibly moved/recoloured/re-elemented), an
// entry without one is new, and any atom of `structure` missing from the list
// is deleted. Rebuilding the arrays from the table beats replaying individual
// add/move/remove operations — every atom-indexed thing in the app
// (atomImages, bonds, selection) is derived from these arrays anyway, and a
// rebuild can't drift out of order the way an operation replay can.
//
// Caller re-renders (createBondLengthControls() + updateVisualization({
// reRenderAtoms:true, reRenderBonds:true, reRenderComposition:"open" })).
// Returns { added, removed } counts.
/**
 * @param {any} structure
 * @param {{atoms: Array<{uuid: string|null, element: string, x: number, y: number, z: number, color?: string}>, lattice?: number[][]}} edits
 */
export function applyStructureEdits(structure, { atoms, lattice }) {
  const byUuid = new Map(structure.atoms.map((atom) => [atom.uuid, atom]));
  // Element lives on the parallel `elements` array, not on the Atom (see
  // model/Atom.js — the constructor only uses `element` to derive colours).
  const elementByUuid = new Map(structure.atoms.map((atom, i) => [atom.uuid, structure.elements[i]]));
  const keptUuids = new Set();

  const nextAtoms = atoms.map((entry) => {
    const existing = entry.uuid ? byUuid.get(entry.uuid) : null;
    if (!existing) {
      return new Atom({
        position: [entry.x, entry.y, entry.z],
        element: entry.element,
        color: parseColorHexToInt(entry.color),
        // Honour a uuid the table already assigned to a new row: the live
        // Modify editor re-runs this on every keystroke, so a stable uuid is
        // what keeps a just-added atom the SAME atom across edits (and lets
        // the New/Removed diff tell it from the originals).
        uuid: entry.uuid || generateID([entry.element]),
      });
    }
    keptUuids.add(entry.uuid);
    // A changed element changes the atom's default/element colour and radius,
    // which the Atom constructor derives once — so re-make it rather than
    // patch it, keeping the uuid so later edits still find the same row.
    const atom = elementByUuid.get(entry.uuid) === entry.element
      ? existing
      : new Atom({ position: existing.position, element: entry.element, uuid: existing.uuid });
    atom.position = [entry.x, entry.y, entry.z];
    // Only write the colour when the user actually picked a different one:
    // the table is prefilled with each atom's *effective* colour, so writing
    // it back unconditionally would pin every atom to a user colour and stop
    // it following its element/colour-map default.
    if (entry.color && entry.color.toLowerCase() !== colorToHex(atom.getColor()).toLowerCase()) {
      atom.userColor = entry.color;
      atom.setColor(entry.color);
    }
    return atom;
  });

  const removed = structure.atoms.length - keptUuids.size;
  const added = nextAtoms.length - keptUuids.size;

  structure.atoms = nextAtoms;
  structure.elements = atoms.map((entry) => entry.element);
  structure.uniqueElements = [...new Set(structure.elements)];
  if (lattice) structure.lattice = lattice.map((row) => [...row]);

  // A Wyckoff lock stores raw atom indices (orbitGroups.atomIndices), so it is
  // meaningless the moment atoms are added or removed — drop it instead of
  // letting the composition panel index past the end of structure.atoms.
  if ((added || removed) && structure.symmetry?.mode === 'wyckoff') structure.symmetry = null;

  return { added, removed };
}

// Restore a structure to its as-loaded state (Structure.original, the frozen
// snapshot taken in the constructor). This is the Modify panel's "Revert
// Changes": the panel edits the structure live, so undoing everything means
// rebuilding the atom/element/lattice arrays from that snapshot. Fresh uuids
// are minted (the snapshot predates uuid assignment) - the caller drops any
// _modify diff state so the baseline is recaptured on the next open.
export function revertStructureToOriginal(structure) {
  const orig = structure.original;
  if (!orig) return;
  structure.atoms = orig.atoms.map((a, i) => {
    const atom = new Atom({
      position: [...a.position],
      element: orig.elements[i],
      uuid: generateID([orig.elements[i]]),
    });
    if (a.userColor) { atom.userColor = a.userColor; atom.setColor(a.userColor); }
    return atom;
  });
  structure.elements = [...orig.elements];
  structure.uniqueElements = [...new Set(orig.elements)];
  structure.lattice = orig.lattice.map((row) => [...row]);
  // Atom-index-based locks are meaningless against the rebuilt array.
  if (structure.symmetry) structure.symmetry = null;
}

// Restore only the cell to its as-loaded value - the lattice section's own
// "Reset Lattice", independent of the atom edits.
export function resetLatticeToOriginal(structure) {
  if (structure.original) structure.lattice = structure.original.lattice.map((row) => [...row]);
}

// Numeric colour (Atom.color) or css string (Atom.userColor) -> "#rrggbb".
export function colorToHex(color) {
  if (typeof color === 'string') return color.startsWith('#') ? color : `#${color}`;
  if (!Number.isFinite(color)) return '#808080';
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}

// Register a Structure as a new file-browser row, select it, and recenter
// the camera on it - selectLastAddedRow() re-renders but (unlike a normal
// row click, see FileBrowswerPanel.js's click handler) does not itself move
// the camera, so newly created structures would otherwise stay framed on
// whatever was in view before.
function registerNewStructure(structure, fileName = 'new_structure') {
  const container = new StructureContainer({ fileName, structures: [structure] });
  structureShip.container.push(container);

  const row = createRow({ name: fileName, traj: 1, step: 1 });
  document.querySelector('#objectTable tbody').appendChild(row);
  fileBrowser.fileData.push({ name: fileName, traj: 1, step: 1 });
  selectLastAddedRow(); // selects the row and triggers a render
  recenterCamera();
}

// Build a brand-new Structure from atoms entered in an atom-table editor
// (fractional x/y/z, used as-is) plus a lattice (3x3 Cartesian row-vector
// matrix, from LatticeInputPanel.js), and register it as a new file-browser row.
/**
 * @param {Array<{element: string, x: number, y: number, z: number, color?: string}>} atomsToAdd
 * @param {{lattice: number[][], fileName?: string}} options
 */
export function createNewStructureFromAtoms(atomsToAdd, { lattice, fileName = 'new_structure' }) {
  if (!atomsToAdd.length) {
    console.warn('Create structure: no atoms entered.');
    return;
  }

  const elements = atomsToAdd.map(a => a.element);
  const atoms = atomsToAdd.map(a => new Atom({
    position: [a.x, a.y, a.z],
    element: a.element,
    color: parseColorHexToInt(a.color),
    uuid: generateID([a.element]),
  }));

  const structure = new Structure({
    elements,
    uniqueElements: [...new Set(elements)],
    lattice,
    atoms,
  });

  registerNewStructure(structure, fileName);
}
