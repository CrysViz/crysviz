// Receive the launch session over postMessage instead of in the URL.
//
// A `#load-file=` URL carries the whole file (base64, then URI-encoded — about
// 1.4x the file size), so a large structure or a long trajectory hits the
// browser's URL-length limit. Two hash markers hand the data over as a message
// instead, which has no practical size limit and skips the encoding entirely:
//
//   #load-message  (widget embed)  the session comes from the embedding page
//                                  (window.parent).
//   #load-opener   (full app)      the session comes from the window that
//                                  opened this tab — the widget's "Open in
//                                  CrysViz" uses this for payloads that did not
//                                  arrive in (or would not fit in) a URL.
//
// Handshake: the receiver posts `{ source, version, type:'awaitingSession' }` to
// the sender window (target '*': it carries nothing), and accepts the first
// `{ target, type:'loadSession', name, data, format? }` whose event.source IS
// that window — the browser sets event.source, so no other page or frame can
// inject a session. `data` is a string, an ArrayBuffer or a typed-array view
// (transferable), or a Blob. A sender may also post loadSession without waiting
// for awaitingSession: the listener is installed from host/early.js, before the
// app module graph loads, so an early message is buffered rather than lost.
//
// This module has no imports on purpose: host/early.js loads it up front.

/** Matches every location hash the bootstrap treats as a structure to load. */
export const LOAD_HASH_RE = /^#load-(?:file=|url=|message$|opener$)/;

const CHANNELS = {
  message: { tag: 'crysviz-widget', from: () => (window.parent !== window ? window.parent : null), timeoutMs: 60000 },
  opener: { tag: 'crysviz-app', from: () => window.opener ?? null, timeoutMs: 30000 },
};

const PROTOCOL_VERSION = 1;
const MAX_NAME_LENGTH = 255;

/** @type {Promise<{name:string, data:any, format:string, origin:string}>|null} */
let pending = null;

/** Validate one loadSession message; returns the session or null. */
function readSession(d) {
  if (typeof d.name !== 'string' || !d.name || d.name.length > MAX_NAME_LENGTH) return null;
  let data = d.data;
  if (ArrayBuffer.isView(data)) {
    data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  const ok = typeof data === 'string'
    || data instanceof ArrayBuffer
    || (typeof Blob !== 'undefined' && data instanceof Blob);
  if (!ok) return null;
  const format = typeof d.format === 'string' && d.format.length <= 32 ? d.format : '';
  return { name: d.name, data, format };
}

/**
 * Start listening for the session. Idempotent; the kind comes from the location
 * hash ('message' or 'opener'). Called from host/early.js.
 * @param {'message'|'opener'} kind
 */
export function startSessionReceiver(kind) {
  if (pending) return pending;
  const channel = CHANNELS[kind];
  pending = new Promise((resolve, reject) => {
    const sender = channel?.from();
    if (!sender) {
      reject(new Error(kind === 'message'
        ? '#load-message needs an embedding page to send the structure'
        : '#load-opener needs the window that opened this tab to send the structure'));
      return;
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for the structure to be sent'));
    }, channel.timeoutMs);
    function onMessage(event) {
      if (event.source !== sender) return;
      const d = event.data;
      if (!d || typeof d !== 'object' || d.target !== channel.tag || d.type !== 'loadSession') return;
      const session = readSession(d);
      if (!session) {
        console.warn('[crysviz] ignored an invalid loadSession message');
        return;
      }
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve({ ...session, origin: typeof event.origin === 'string' ? event.origin : '' });
    }
    window.addEventListener('message', onMessage);
    try {
      sender.postMessage({ source: channel.tag, version: PROTOCOL_VERSION, type: 'awaitingSession' }, '*');
    } catch { /* sender gone — the timeout reports it */ }
  });
  // Avoid an unhandled-rejection report before the loader awaits it.
  pending.catch(() => {});
  return pending;
}

/** The session promise started by startSessionReceiver (null if never started). */
export function receivedSession() {
  return pending;
}
