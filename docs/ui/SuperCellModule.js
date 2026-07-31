import { fileBrowser} from '../state/store.js';
import { Atom} from '../model/index.js';
import {updateVisualization} from '../core/crystal-viewer.js'
import {generateID} from '../utils/index.js'
import { fitCameraToCurrentStructure } from './WindowAndSceneControls.js';

// Clone an atom, carrying over the user-facing modifications (colour, opacity,
// cut-plane immunity, …) so they survive supercell (re)tiling. `element` and
// `position` are supplied explicitly because they live in the parallel
// `structure.elements` array / are recomputed per image.
function cloneAtom(src, element, position) {
  const atom = new Atom({
    element,
    position,
    color: src.color,
    opacity: src.opacity,
    elementOpacity: src.elementOpacity,
    elementColor: src.elementColor,
    cutPlaneImmune: src.cutPlaneImmune,
    uuid: generateID([element]),
  });
  // userColor is intentionally not a constructor argument, copy it directly.
  atom.userColor = src.userColor;
  return atom;
}

export function createSupercell(nx = 1, ny = 1, nz = 1) {

  const sel = fileBrowser.selectedStructure;

  // Current supercell factors of the *live* structure (defaults to 1×1×1).
  const cur = sel.supercell || {};
  const cx = Math.max(1, cur.nx || 1);
  const cy = Math.max(1, cur.ny || 1);
  const cz = Math.max(1, cur.nz || 1);
  const curProduct = cx * cy * cz;

  // Derive the (possibly user-modified) primitive cell from the LIVE structure
  // rather than the frozen as-loaded `.original` snapshot, so per-atom edits
  // (colour, opacity, element, moved positions) carry through. The tiling loop
  // below emits image (0,0,0) first, so the first `baseCount` live atoms are
  // exactly one copy of the unit cell — we recover their unit-cell fractional
  // coords by multiplying out the current supercell factors.
  const liveAtoms = sel.atoms;
  const liveElements = sel.elements;
  const rawBaseCount = liveAtoms.length / curProduct;

  let baseAtoms;
  let baseElements;
  let baseLattice;
  if (Number.isInteger(rawBaseCount) && rawBaseCount > 0) {
    baseLattice = sel.lattice.map((row, idx) => {
      const f = [cx, cy, cz][idx];
      return row.map(x => x / f);
    });
    baseElements = liveElements.slice(0, rawBaseCount);
    baseAtoms = liveAtoms.slice(0, rawBaseCount).map((a, p) => {
      const pos = a.position;
      return cloneAtom(a, baseElements[p], [pos[0] * cx, pos[1] * cy, pos[2] * cz]);
    });
  } else {
    // Atom count isn't a clean multiple of the current supercell (e.g. atoms
    // were added/removed) — treat the whole live cell as the base.
    baseLattice = sel.lattice.map(row => [...row]);
    baseElements = [...liveElements];
    baseAtoms = liveAtoms.map((a, p) => cloneAtom(a, baseElements[p], [...a.position]));
  }

  const newAtoms = [];
  const newElements = [];

  // Simple tiling — image (0,0,0) is emitted first (i=j=k=0).
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        for (let p = 0; p < baseAtoms.length; p++) {
          const base = baseAtoms[p];
          const pos = base.position;
          newAtoms.push(cloneAtom(base, baseElements[p], [
            (pos[0] + i) / nx,
            (pos[1] + j) / ny,
            (pos[2] + k) / nz
          ]));
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

  // Commit the new (modification-preserving) supercell to the live structure.
  sel.elements = newElements;
  sel.atoms = newAtoms;
  sel.lattice = newLattice;
  sel.supercell = { nx, ny, nz };

  // Re-render
  //
  updateVisualization({
    reRenderAtoms: true,
    reRenderBonds: true,
    reRenderLattice: true,
    reRenderComposition: true
  });

  // The tiled cell is usually a very different size than whatever the camera
  // was last fit to (bigger for nx*ny*nz > 1, smaller shrinking back down) —
  // always refit distance/zoom here rather than requiring a separate manual
  // Reset View click, keeping whatever direction the camera already looks
  // from.
  fitCameraToCurrentStructure();
}
