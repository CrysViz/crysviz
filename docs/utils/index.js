// Public API barrel for the `utils/` domain (cross-cutting helpers).

// Stable id generation (UUIDModule -> state/store usedIDs):
export { generateID, generateCompactTimeUUID } from './UUIDModule.js';

// Share-state serialization (pure functions, no app dependencies):
export {
  captureCompleteState, createCompleteShareableURL, generatePOSCARString,
  createLegacyShareableURL, restoreCompleteState,
} from './shareutils.js';
