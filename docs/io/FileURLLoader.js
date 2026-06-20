import { general } from '../state/store.js';
import {loadStructure} from '../core/crystal-viewer.js';




export function loadFromFilePath() {

  const hash = window.location.hash;
  const match = hash.match(/^#load-file=(.+)/);
  if (!match) return;

  try {
    // Split the hash into filename and content
    const [encodedFilename, encodedContent] = decodeURIComponent(match[1]).split('|');
    const filename = decodeURIComponent(encodedFilename);
    const b64 = decodeURIComponent(encodedContent);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const content = new TextDecoder().decode(bytes);

    // Call your function
    loadStructure(content, filename, false);

    //createBondLengthControls();
    general.sharedStructureLoaded = true;
    console.warn("Loaded structure from URL")
  } catch (e) {
    console.error('Failed to decode file:', e);
  }
}

