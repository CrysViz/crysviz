// Public API barrel for the `utils/` domain (cross-cutting helpers).
//
// NOTE: wrapWorker.js is a Web Worker entry point (loaded via
// `new URL('../utils/wrapWorker.js', import.meta.url)`), not a module API, so it
// is intentionally NOT re-exported here.

// Stable id generation (UUIDModule -> state/store usedIDs):
export { generateID, generateCompactTimeUUID } from './UUIDModule.js';

// Share-state serialization (pure functions, no app dependencies):
export {
  captureCompleteState, createCompleteShareableURL, generatePOSCARString,
  createLegacyShareableURL, restoreCompleteState,
} from './shareutils.js';
