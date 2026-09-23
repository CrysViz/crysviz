// Share-link envelope (issue #144): the bytes that travel in a share URL's
// fragment, plus the text encodings that put them there.
//
//   byte 0   codec | flags     CODEC_FULL_JSON  = deflate-raw(full v2 JSON)
//                              CODEC_COMPACT_V3 = deflate-raw(compact v3 JSON)
//                              FLAG_ENCRYPTED   = the rest is encrypted
//   plain:      deflate-raw(json)
//   encrypted:  salt(16) | iv(12) | AES-256-GCM(deflate-raw(json)), byte 0 as AAD
//
// The copy link carries it base64url-encoded (#z=), the QR code base32-encoded
// (#q=) so the payload fits QR alphanumeric mode. Both alphabets are
// URL-unreserved, so no app ever percent-encodes them.
//
// Pure module: no DOM, no app state. Compression goes through CompressionStream
// by default; Node tests inject zlib with setCompressionBackend (Node 18 has no
// 'deflate-raw' stream).
//
// The legacy ?e= decrypt (links made before the envelope) lives here too so all
// password crypto is in one place: its plaintext is a 1-byte "deflated?" flag
// followed by the payload, and it has no additional data.

export const CODEC_FULL_JSON = 1;
export const CODEC_COMPACT_V3 = 2;
export const FLAG_ENCRYPTED = 0x80;
const CODEC_MASK = 0x7f;

// AES-256-GCM with a PBKDF2-derived key. All standard Web Crypto, no deps.
const PBKDF2_ITERS = 250000; // ~a few hundred ms on a phone; a real brute-force cost
const SALT_BYTES = 16;
const IV_BYTES = 12;  // 96-bit nonce, the size AES-GCM is defined for

// Inflated payloads above this are refused: a share link is untrusted input and
// a few KB of deflate can expand to gigabytes.
const DEFAULT_MAX_INFLATE = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Text encodings
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes */
export function bytesToB64URL(bytes) {
  // Chunked so a large payload can't blow the argument limit of String.fromCharCode.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** base64url, or legacy standard base64 (+ / =, and '+' turned into ' ' by a
 *  form decoder), to bytes. Throws on invalid input.
 *  @param {string} str */
export function b64URLToBytes(str) {
  const normalized = String(str).trim()
    .replace(/ /g, '+')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '');
  const pad = normalized.length % 4;
  const b64 = pad ? normalized + '='.repeat(4 - pad) : normalized;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, uppercase, no padding. @param {Uint8Array} bytes */
export function bytesToBase32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Inverse of bytesToBase32; case-insensitive, padding tolerated. Throws on
 *  characters outside the alphabet. @param {string} str */
export function base32ToBytes(str) {
  const clean = String(str).trim().toUpperCase().replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(clean.length * 5 / 8));
  let bits = 0;
  let value = 0;
  let n = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`Invalid base32 character '${ch}'`);
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[n++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out.subarray(0, n);
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/** @type {{ deflateRaw: (b: Uint8Array) => Promise<Uint8Array>|Uint8Array, inflateRaw: (b: Uint8Array, max: number) => Promise<Uint8Array>|Uint8Array } | null} */
let backend = null;

/** Replace the CompressionStream backend (Node tests pass zlib wrappers).
 *  `inflateRaw(bytes, maxBytes)` must throw above maxBytes. Pass null to reset. */
export function setCompressionBackend(next) {
  backend = next;
}

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
export async function deflateRaw(bytes) {
  if (backend) return new Uint8Array(await backend.deflateRaw(bytes));
  if (typeof CompressionStream === 'undefined') throw new Error('This browser cannot compress share links (no CompressionStream).');
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate, aborting once the output passes maxBytes.
 *  @param {Uint8Array} bytes @param {{ maxBytes?: number }} [opts] */
export async function inflateRaw(bytes, { maxBytes = DEFAULT_MAX_INFLATE } = {}) {
  if (backend) return new Uint8Array(await backend.inflateRaw(bytes, maxBytes));
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Share payload expands past ${Math.round(maxBytes / 1048576)} MB; refusing to load it.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

/** Whether the Web Crypto API is usable — false on insecure (plain http)
 *  origins, where crypto.subtle is undefined. localhost and https are fine. */
export function cryptoAvailable() {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

/** PBKDF2(password, salt) -> a 256-bit AES-GCM key. */
async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** salt || iv || AES-GCM(bytes). Salt and IV are fresh per call and non-secret. */
async function encryptBytes(bytes, password, aad = null) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const params = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, key, bytes));
  const out = new Uint8Array(SALT_BYTES + IV_BYTES + ct.length);
  out.set(salt, 0);
  out.set(iv, SALT_BYTES);
  out.set(ct, SALT_BYTES + IV_BYTES);
  return out;
}

/** Reverse encryptBytes. Rejects on the wrong password (GCM auth fails). */
async function decryptBytes(bytes, password, aad = null) {
  const salt = bytes.subarray(0, SALT_BYTES);
  const iv = bytes.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const ct = bytes.subarray(SALT_BYTES + IV_BYTES);
  const key = await deriveKey(password, salt);
  const params = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  return new Uint8Array(await crypto.subtle.decrypt(params, key, ct));
}

/** Ask for a password until it decrypts or the user cancels (null). */
async function decryptWithPrompt(bytes, requestPassword, aad) {
  if (!cryptoAvailable()) {
    throw new Error('This share link is password-encrypted, which needs a secure (https) context. Open the link over https and try again.');
  }
  if (typeof requestPassword !== 'function') throw new Error('This share link is password-protected.');
  for (let attempt = 0; ; attempt++) {
    const password = await requestPassword({ retry: attempt > 0 });
    if (password === null || password === undefined) return null;
    try { return await decryptBytes(bytes, password, aad); } catch { /* wrong password: ask again */ }
  }
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Wrap a JSON payload for a share URL.
 * @param {Uint8Array} jsonBytes UTF-8 JSON
 * @param {{ codec: number, password?: string|null }} opts
 * @returns {Promise<Uint8Array>}
 */
export async function sealEnvelope(jsonBytes, { codec, password = null }) {
  if (!Number.isInteger(codec) || codec < 1 || codec > CODEC_MASK) throw new Error(`Invalid share codec ${codec}`);
  const body = await deflateRaw(jsonBytes);
  const header = new Uint8Array([codec | (password ? FLAG_ENCRYPTED : 0)]);
  const rest = password ? await encryptBytes(body, password, header) : body;
  const out = new Uint8Array(1 + rest.length);
  out.set(header, 0);
  out.set(rest, 1);
  return out;
}

/**
 * Unwrap an envelope made by sealEnvelope.
 * @param {Uint8Array} bytes
 * @param {{ requestPassword?: (o: {retry: boolean}) => Promise<string|null>, maxBytes?: number }} [opts]
 * @returns {Promise<{ codec: number, json: Uint8Array } | null>} null when the
 *   user cancelled the password prompt
 */
export async function openEnvelope(bytes, { requestPassword, maxBytes } = {}) {
  if (!bytes || bytes.length < 2) throw new Error('Share link is empty or truncated.');
  const header = bytes.subarray(0, 1);
  const codec = header[0] & CODEC_MASK;
  if (codec !== CODEC_FULL_JSON && codec !== CODEC_COMPACT_V3) {
    throw new Error(`This share link uses an unknown format (${codec}); a newer CrysViz may be needed.`);
  }
  let body = bytes.subarray(1);
  if (header[0] & FLAG_ENCRYPTED) {
    if (body.length < SALT_BYTES + IV_BYTES + 16) throw new Error('Encrypted share link is truncated.');
    const plain = await decryptWithPrompt(body, requestPassword, new Uint8Array(header));
    if (plain === null) return null;
    body = plain;
  }
  return { codec, json: await inflateRaw(body, { maxBytes }) };
}

/**
 * Decrypt a legacy ?e= payload (pre-envelope links): salt|iv|AES-GCM of
 * [1-byte deflated flag | payload], no additional data.
 * @param {Uint8Array} bytes
 * @param {{ requestPassword?: (o: {retry: boolean}) => Promise<string|null>, maxBytes?: number }} [opts]
 * @returns {Promise<Uint8Array|null>} the JSON bytes, or null if cancelled
 */
export async function openLegacyEncrypted(bytes, { requestPassword, maxBytes } = {}) {
  const plain = await decryptWithPrompt(bytes, requestPassword, null);
  if (plain === null) return null;
  return plain[0] === 1 ? inflateRaw(plain.subarray(1), { maxBytes }) : plain.subarray(1);
}
