import { general } from '../state/store.js';
import {loadStructure} from '../core/crystal-viewer.js';
import { receivedSession, startSessionReceiver } from './SessionReceiver.js';

// Structures named by the location hash:
//
//   #load-file=<filename>|<base64 content>   the file itself, in the URL
//   #load-url=<url>[|<filename>]             fetched from <url> (CORS; no cookies)
//   #load-message                            posted by the embedding page
//   #load-opener                             posted by the window that opened us
//
// The last two are received by io/SessionReceiver.js. Whatever arrived is kept
// (getLaunchSource) so the widget's "Open in CrysViz" can hand the same data to
// the full app without squeezing it into a URL.

/** @type {{kind:'file'|'url'|'message'|'opener', name:string, data:any, format:string, origin?:string}|null} */
let launchSource = null;

/** What the hash loaded, or null (nothing loaded from the hash yet). */
export function getLaunchSource() {
  return launchSource;
}

function decodeFileHash(raw) {
  // Split the raw payload first. Decoding before splitting would turn an
  // encoded filename pipe (%7C) into a second separator.
  const parts = raw.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('The load-file hash must contain exactly filename|content.');
  }
  const [encodedFilename, encodedContent] = parts;
  const filename = decodeURIComponent(encodedFilename);
  const b64 = decodeURIComponent(encodedContent);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { name: filename, data: new TextDecoder().decode(bytes), format: '' };
}

/** Fetch a `#load-url=` reference. Only http(s); relative URLs resolve against
 *  this page. Sent without cookies or credentials, so the data host must allow
 *  the request with CORS (`Access-Control-Allow-Origin`; `*` also covers the
 *  sandboxed widget, whose origin is opaque). */
async function fetchUrlHash(raw) {
  const parts = raw.split('|');
  if (parts.length > 2 || !parts[0]) {
    throw new Error('The load-url hash must contain url or url|filename.');
  }
  const url = new URL(decodeURIComponent(parts[0]), window.location.href);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The load-url hash only supports http(s) URLs.');
  }
  let name = parts[1] ? decodeURIComponent(parts[1]) : '';
  if (!name) {
    const last = url.pathname.split('/').filter(Boolean).pop();
    try { name = last ? decodeURIComponent(last) : ''; } catch { name = last || ''; }
  }
  const response = await fetch(url.toString(), { credentials: 'omit', mode: 'cors' });
  if (!response.ok) throw new Error(`Could not fetch ${url} (HTTP ${response.status})`);
  // Bytes, not text: binary formats (.traj) work too, and loadStructure detects
  // the format from the contents.
  return { name: name || 'structure', data: await response.arrayBuffer(), format: '' };
}

export async function loadFromFilePath() {
  const hash = window.location.hash;
  /** @type {NonNullable<typeof launchSource>} */
  let source;
  let match;
  if ((match = hash.match(/^#load-file=(.+)/))) {
    source = { kind: 'file', ...decodeFileHash(match[1]) };
  } else if ((match = hash.match(/^#load-url=(.+)/))) {
    source = { kind: 'url', ...(await fetchUrlHash(match[1])) };
  } else if (hash === '#load-message' || hash === '#load-opener') {
    const kind = /** @type {'message'|'opener'} */ (hash === '#load-message' ? 'message' : 'opener');
    // Normally already started by host/early.js; start it here otherwise.
    const session = await (receivedSession() ?? startSessionReceiver(kind));
    source = { kind, ...session };
  } else {
    return false;
  }

  await loadStructure(source.data, source.name, false, source.format);
  launchSource = source;
  general.sharedStructureLoaded = true;
  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState({}, document.title, url.toString());
  console.warn('Loaded structure from URL');
  return true;
}
