// Re-export the public API for backward compatibility and convenience
export { createCompositionRow, createWyckoffCompositionRow, clearCompositionRowRegistry } from './components/CompositionRow.js';
export { createIndividualAtomRow } from './components/IndividualAtomRow.js';
export { createTinyImmunityToggle } from './components/Immunity.js';
export { createElementColorEditor } from './components/ColorEditor.js';
export { createSpinForceEditor } from './components/SpinForceEditor.js';
export {
  clampOpacity,
  getElementAtomIndices,
  getElementOpacityValues,
  setSwatchOpacity,
  areAllAtomsCutPlaneImmune,
  setCutPlaneImmunityForAtoms,
  updateAtomCoordinates
} from './components/utils.js';
