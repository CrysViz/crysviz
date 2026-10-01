import { general } from '../state/store.js';
import {loadStructure} from '../core/crystal-viewer.js';




/** Returned by loadFromFilePath() when the user cancels a load dialog (distinct from `false`, "nothing to load"). */
export const LOAD_CANCELLED = 'cancelled';

/** @returns {Promise<boolean | typeof LOAD_CANCELLED>} true loaded, false no #load-file hash, LOAD_CANCELLED user cancelled */
export async function loadFromFilePath() {

  const hash = window.location.hash;
  const match = hash.match(/^#load-file=(.+)/);
  if (!match) return false;

  // Split the raw payload first. Decoding before splitting would turn an
  // encoded filename pipe (%7C) into a second separator.
  const parts = match[1].split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('The load-file hash must contain exactly filename|content.');
  }
  // Optional ?cubePeriodic=true|false (search, not hash, so the filename|content split is untouched).
  const periodicParams = new URL(window.location.href).searchParams.getAll('cubePeriodic');
  if (periodicParams.length > 1 || (periodicParams.length === 1 && !['true', 'false'].includes(periodicParams[0]))) {
    throw new Error('The cubePeriodic parameter must be exactly true or false.');
  }
  const options = periodicParams.length ? { periodic: periodicParams[0] === 'true' } : {};
  const [encodedFilename, encodedContent] = parts;
  const filename = decodeURIComponent(encodedFilename);
  const b64 = decodeURIComponent(encodedContent);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const content = new TextDecoder().decode(bytes);

  const result = await loadStructure(content, filename, false, '', options);
  const url = new URL(window.location.href);
  url.hash = '';
  url.searchParams.delete('cubePeriodic'); // later share links must not carry it
  window.history.replaceState({}, document.title, url.toString());
  if (result?.cancelled) return LOAD_CANCELLED;
  general.sharedStructureLoaded = true;
  console.warn('Loaded structure from URL');
  return true;
}
