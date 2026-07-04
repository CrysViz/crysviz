// Public API barrel for the `render/` domain (three.js mesh + scene updates).
//
// Other domains should import render functionality from here, not from the
// individual module files, so the internal file layout can change without
// breaking consumers. Intra-render modules still import each other directly.
//
// This is a *curated* surface: only the symbols actually consumed by other
// domains are re-exported. Add to it when a new cross-domain function is needed.

export { pauseRendering, resumeRendering, animation_update } from './AnimateModule.js';

export {
  rebuildAtoms, updateAtoms, updateSingleAtomDiameter, updateSingleAtomColor,
  updateAtomCutPlaneState, getUUIDFromGeometry, updateSingleAtomOpacity,
  updateSingleAtomCutPlaneImmunity,
} from './AtomsFracUpdateModule.js';

export {
  getBondCutoff, updateBonds, rebuildBonds, buildBondObjects,
  updateSingleBondDiameter, disposeBondsMesh, updateSingleBondColor, bondKey,
} from './BondsFracUpdateModule.js';

export {
  rebuildSecondAtoms, updateSecondAtoms, updateSecondSingleAtomDiameter,
} from './CompAtomsFracUpdateModule.js';

export {
  updateSecondBonds, rebuildSecondBonds, buildSecondBondObjects,
  updateSecondSingleBondDiameter,
} from './CompBondsFracUpdateModule.js';

export { removeForces, updateForces } from './ForceModule.js';

export {
  runPeriodicWrapped, periodicWrapped, fracToCart, cartToFrac, updateLattice,
  recomputeLatticeDirs, latticeDirsNorm, latticeDirs, getCellCenterAndDist,
} from './LatticeModule.js';

export { updatePolyhedra, updatePolyhedraColors } from './PolyhedraModule.js';

export {
  updateField, setActiveField, toggleFieldVisibility, clearField, deleteField,
  parseCHGCARFile, parseCubeFile,
} from './Render3DFieldModule.js';

export { removeSpins, updateSpins, deleteSpins } from './SpinModule.js';

export { updateAngleDisplays, setupAxisControls } from './cameraAngleControl.js';

export { setCelHullWidth, setCelHullPolyWidth } from './MaterialStyles.js';
