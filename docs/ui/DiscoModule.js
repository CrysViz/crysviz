import { updateSingleBondColor } from '../render/index.js'
import { updateSingleAtomColor } from '../render/index.js'
import {groups,fileBrowser} from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { setDiscoWarningVisible } from './DiscoWarningBanner.js';
import { showDiscoBall, hideDiscoBall } from './DiscoBallModule.js';
import { updatePolyhedraColors, paintPolyhedraColors } from '../render/PolyhedraModule.js';
import { setPolyPaintOverride } from '../render/PolyhedraMesh.js';


function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

export function updateRandomColors() {
  console.log("Disco!!!")
  fileBrowser.selectedStructure.atoms.forEach((atom, atomIndex) => {
    const element = fileBrowser.selectedStructure.elements[atomIndex]; // Assuming `atom` has an `element` property
    // Update atom color
 //   let ok = setIndividualAtomColor(element, atomIndex, hex);

    // Update associated bonds
    fileBrowser.selectedStructure.atomImages[atomIndex]?.forEach(imageIndex => {
      const hex = getRandomColor();
      updateSingleAtomColor(atomIndex, imageIndex, element, hex)
      fileBrowser.selectedStructure.bondMapping[imageIndex]?.forEach(bondHalvIndex => {
        // overwriteAtom: true — without it, updateSingleBondColor prefers
        // atom.userColor over the color passed in, so any atom with a
        // pre-existing custom color would keep its bonds frozen at that
        // color instead of joining the randomization (fully reversible
        // anyway: startDisco()/stopDisco() snapshot and restore userColor).
        updateSingleBondColor(bondHalvIndex, hex, true);
      });
    });
  });

  // Mark colors as needing update
  groups.atomsMesh.instanceColor.needsUpdate = true;
  groups.bondsMesh.instanceColor.needsUpdate = true;

  // Polyhedra: their faces' and edges' colour ranges in the one polyhedra
  // mesh are painted directly, same reversible approach as atoms/bonds:
  // never touches structure.polyhedraUserStyles/polyhedraCategoryStyles, so
  // stopDisco()'s updatePolyhedraColors() call restores the correct
  // per-polyhedron style from those untouched models.
  paintPolyhedraColors(() => getRandomColor());
}

// Snapshot of every atom's color/userColor from just before disco mode
// started, keyed by atom index into the structure that was active at the
// time — null when disco mode isn't running. updateRandomColors() mutates
// atom.color directly (via setAtomColor), so without this the randomized
// colors would stick around permanently once disco mode ends.
let colorSnapshot = null;
let snapshotStructure = null;

/** Call once when disco mode is entered (Ctrl+D pressed). Idempotent. */
export function startDisco() {
  if (colorSnapshot) return; // already running
  const structure = fileBrowser.selectedStructure;
  if (!structure) return;
  snapshotStructure = structure;
  colorSnapshot = structure.atoms.map((atom) => ({ color: atom.color, userColor: atom.userColor }));
  // Polyhedra rebuilt or restyled while disco runs (every playback frame
  // takes the full path once the atoms carry colours) are repainted by the
  // style writers through this override, so the paint does not vanish
  // between ticks (render/PolyhedraMesh.js).
  setPolyPaintOverride(() => getRandomColor());
  setDiscoWarningVisible(true);
  showDiscoBall();
}

/** Call once when disco mode is exited (Ctrl+D released). Idempotent. */
export function stopDisco() {
  if (!colorSnapshot) return; // wasn't running
  setPolyPaintOverride(null);
  setDiscoWarningVisible(false);
  hideDiscoBall();
  // The selected structure may have changed while disco was running (e.g. the
  // user switched files mid-hold) — restoring against a stale structure would
  // scribble over whatever is now selected, so just drop the snapshot instead.
  if (fileBrowser.selectedStructure === snapshotStructure) {
    snapshotStructure.atoms.forEach((atom, i) => {
      const saved = colorSnapshot[i];
      if (!saved) return;
      atom.color = saved.color;
      atom.userColor = saved.userColor;
    });
    // No reRenderComposition option here — notifyColorsChanged() (fired
    // unconditionally by every updateVisualization() call) already refreshes
    // the composition panel's pie-dot colors in place; passing a
    // reRenderComposition value would force that panel open/closed as a side
    // effect (see General.js's renderComposition(panelState)), which disco
    // mode has no business doing.
    updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
    // Polyhedra colors were painted directly into the mesh (never
    // touching the model), so restyle in place from the untouched
    // structure.polyhedraUserStyles/polyhedraCategoryStyles + centre-atom
    // colors instead of needing a full polyhedra recompute.
    updatePolyhedraColors();
  }
  colorSnapshot = null;
  snapshotStructure = null;
}
