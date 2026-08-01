import { general } from '../state/store.js';
import {loadStructure} from '../core/crystal-viewer.js';




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
  const [encodedFilename, encodedContent] = parts;
  const filename = decodeURIComponent(encodedFilename);
  const b64 = decodeURIComponent(encodedContent);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const content = new TextDecoder().decode(bytes);

  await loadStructure(content, filename, false);
  general.sharedStructureLoaded = true;
  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState({}, document.title, url.toString());
  console.warn('Loaded structure from URL');
  return true;
}
