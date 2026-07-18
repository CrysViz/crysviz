// CommitAtoms.js
//
// The two ways new atoms end up in the app's state: pushed into an existing,
// currently-loaded Structure, or used to build a brand-new Structure that
// gets registered as its own file-browser row. Both paths are pulled out
// here, decoupled from any particular panel's UI, so the add-atom panel, the
// add-structure modal, and (later) a symmetry/Wyckoff generator can all call
// the same commit logic after running AtomCollisionCheck.js.

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
// Structure. Mirrors the delete-atom mutation in SceneInteraction.js in
// reverse: pushes onto the parallel atoms/elements arrays and recomputes
// uniqueElements. Caller is responsible for refreshing bond controls and
// re-rendering (createBondLengthControls() + updateVisualization({
// reRenderAtoms:true, reRenderBonds:true})), same as the delete-atom path.
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
export function createNewStructureFromAtoms(atomsToAdd, { lattice, fileName = 'new_structure' } = {}) {
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
