// Public API barrel for the `utils/` domain (cross-cutting helpers).

// Stable id generation (UUIDModule -> state/store usedIDs):
export { generateID, generateCompactTimeUUID } from './UUIDModule.js';

// Share-state serialization (pure functions, no app dependencies):
export {
  captureCompleteState, createCompleteShareableURL, generatePOSCARString,
  createLegacyShareableURL, restoreCompleteState,
} from './shareutils.js';

// Shared "Auto Range" formula for magnitude-driven color bars:
export { computeAutoRange, roundToSigFigs } from './AutoRange.js';

// Shared bounded webfont loading for asynchronous rendering/export paths:
export { loadCrysVizFonts, crysVizFontsLoaded } from './FontLoading.js';

// Rich-text (HTML/LaTeX-shorthand) rendering for color-bar legends:
export {
  normalizeLegendMarkup, applyLegendHtml, legendPlainText,
  parseLegendSegments, drawLegendRichText,
} from './LegendRichText.js';

// Spin reference-frame (SAXIS) + decorative-rotation math:
export {
  applySpinFrame, frameMatrix, saxisToMatrix, crystalToMatrix,
  eulerToMatrix, quatToMatrix, multiply3x3, parseSaxis,
} from './spinFrame.js';
// Shared long-press gesture for scene-resident widgets:
export { wireLongPress } from './LongPress.js';
