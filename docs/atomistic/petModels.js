/**
 * PET models for the in-browser PET-MAD calculator, from anywhere:
 *
 * - the built-in PET-MAD xs / s (Hugging Face);
 * - catalogues: a JSON list of models (fine-tuned PET-MAD-XS and others) that
 *   anyone can host at any address (format: tools/pet_catalogue/README.md);
 * - a single model behind any link.
 *
 * Every download goes through fetchPetModel(): links to a file's web page
 * (Hugging Face, GitHub, GitLab, Dropbox) become direct links, a server that
 * does not allow downloads from other sites gets a message saying so, the
 * bytes must be a PET GGUF (not an HTML page), a catalogue's sha256 is
 * checked, and the file is cached (Cache API, the cache mlip_runner.js uses)
 * so a model downloads once. The result is a File the worker loads.
 */
import { SYMBOLS } from '../io/ulm.js';

/** Where the built-in PET-MAD GGUFs live (external/mlip_wasm/README.md). */
export const PET_MAD_BASE_URL = 'https://huggingface.co/peterspackman/mlip-gguf/resolve/main/';

/**
 * Catalogues every copy of CrysViz lists, before any the user adds. Add the
 * address of a hosted catalogue here to ship it with the app.
 * @type {string[]}
 */
export const DEFAULT_CATALOGUES = [];

// The cache external/mlip_wasm/mlip_runner.js reads through, so a model it
// downloaded is not downloaded again here (same key: the model's URL).
const MODEL_CACHE_NAME = 'crysviz-mlip-models';

const GGUF_MAGIC = 'GGUF';

/**
 * @typedef {object} PetModelEntry
 * @property {string} url          direct download link (absolute)
 * @property {string} name         shown in the model list
 * @property {string} [id]
 * @property {string} [sha256]     lowercase hex; checked after download
 * @property {number} [size]       bytes
 * @property {string} [base]       e.g. "PET-MAD-XS v1.5.0"
 * @property {string} [method]     fine-tuning method: full, lora, heads
 * @property {string[]} [elements] elements it was trained for
 * @property {string} [reference]  DFT level the energies refer to
 * @property {string} [description]
 * @property {string} [authors]
 * @property {string} [license]
 * @property {string} [citation]   DOI or link
 * @property {string} [data]       training data: DOI, link or words
 */

/**
 * @typedef {object} PetCatalogue
 * @property {string} url
 * @property {string} name
 * @property {string} [description]
 * @property {PetModelEntry[]} models
 * @property {string[]} warnings   entries left out, and why
 */

/**
 * Turn a link to a file's web page into a link to the file, for the hosts
 * people commonly share from. Anything else is returned resolved but as is.
 * @param {string} link
 * @param {string} [base] resolves relative links (a catalogue's own URL)
 * @returns {string}
 */
export function directLink(link, base = undefined) {
  const text = String(link ?? '').trim();
  if (!text) throw new Error('No link given.');
  let u;
  try {
    u = new URL(text, base ?? (typeof document !== 'undefined' ? document.baseURI : undefined));
  } catch {
    throw new Error(`"${text}" is not a link.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`"${text}" is not an http(s) link.`);
  }
  // Hugging Face: /blob/ is the file's page, /resolve/ the file.
  if (u.hostname === 'huggingface.co' && u.pathname.includes('/blob/')) {
    u.pathname = u.pathname.replace('/blob/', '/resolve/');
  }
  // GitHub: github.com/owner/repo/blob/ref/path is a page; the file is on
  // raw.githubusercontent.com (which allows cross-site downloads).
  if (u.hostname === 'github.com') {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  // GitLab (gitlab.com and self-hosted): /-/blob/ -> /-/raw/.
  if (u.pathname.includes('/-/blob/')) u.pathname = u.pathname.replace('/-/blob/', '/-/raw/');
  // Dropbox share links show a page unless dl=1.
  if (u.hostname === 'dropbox.com' || u.hostname.endsWith('.dropbox.com')) u.searchParams.set('dl', '1');
  return u.href;
}

/** The last path segment, for names and messages. */
function fileNameOf(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'model.gguf';
  } catch {
    return 'model.gguf';
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * fetch() with messages a user can act on. A browser reports a server that
 * refuses cross-site downloads (no Access-Control-Allow-Origin) exactly like
 * an unreachable one, so the message names both.
 * @param {string} url
 * @param {string} what  "the model", "the catalogue"
 * @returns {Promise<Response>}
 */
async function fetchExplained(url, what) {
  let response;
  try {
    response = await fetch(url);
  } catch (_error) {
    throw new Error(
      `Could not download ${what} from ${hostOf(url)}. Either the link is wrong or the server is `
      + 'unreachable, or the server does not allow downloads from other websites (CORS): it has to send '
      + '"Access-Control-Allow-Origin: *", as Hugging Face and raw.githubusercontent.com do. '
      + 'You can also download the file and use local .gguf.');
  }
  if (!response.ok) {
    throw new Error(`${hostOf(url)} answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''} for ${what} (${url}).`);
  }
  return response;
}

/**
 * Read a response body into a Blob, reporting progress.
 * @param {Response} response
 * @param {(p: { loadedBytes: number, totalBytes: number }) => void} [onProgress]
 */
async function readWithProgress(response, onProgress) {
  const totalBytes = Number(response.headers.get('content-length')) || 0;
  if (!response.body || typeof response.body.getReader !== 'function') {
    const blob = await response.blob();
    onProgress?.({ loadedBytes: blob.size, totalBytes: totalBytes || blob.size });
    return blob;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loadedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.length;
    onProgress?.({ loadedBytes, totalBytes });
  }
  return new Blob(chunks);
}

/** sha256 of a Blob as lowercase hex, or null where Web Crypto is missing (http pages). */
export async function sha256Hex(blob) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- GGUF header

const GGUF_TYPE = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7,
  STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};
const SCALAR_BYTES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/**
 * The key/value metadata of a GGUF file (no tensors). Strings whose key
 * starts with "graph." (the embedded computation graph) are skipped.
 * @param {ArrayBuffer} buffer  at least the header; RangeError if too short
 * @returns {Map<string, any>}
 */
export function readGGUFMetadata(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  let p = 0;
  const need = (n) => { if (p + n > buffer.byteLength) throw new RangeError('GGUF header is longer than the bytes read'); };
  const u32 = () => { need(4); const v = view.getUint32(p, true); p += 4; return v; };
  const u64 = () => { need(8); const v = Number(view.getBigUint64(p, true)); p += 8; return v; };
  const str = (keep = true) => {
    const n = u64();
    need(n);
    const s = keep ? decoder.decode(bytes.subarray(p, p + n)) : null;
    p += n;
    return s;
  };
  const scalar = (type) => {
    need(SCALAR_BYTES[type]);
    let v;
    switch (type) {
      case GGUF_TYPE.UINT8: v = view.getUint8(p); break;
      case GGUF_TYPE.INT8: v = view.getInt8(p); break;
      case GGUF_TYPE.UINT16: v = view.getUint16(p, true); break;
      case GGUF_TYPE.INT16: v = view.getInt16(p, true); break;
      case GGUF_TYPE.UINT32: v = view.getUint32(p, true); break;
      case GGUF_TYPE.INT32: v = view.getInt32(p, true); break;
      case GGUF_TYPE.FLOAT32: v = view.getFloat32(p, true); break;
      case GGUF_TYPE.BOOL: v = view.getUint8(p) !== 0; break;
      case GGUF_TYPE.UINT64: v = Number(view.getBigUint64(p, true)); break;
      case GGUF_TYPE.INT64: v = Number(view.getBigInt64(p, true)); break;
      case GGUF_TYPE.FLOAT64: v = view.getFloat64(p, true); break;
      default: throw new Error(`GGUF: unknown value type ${type}`);
    }
    p += SCALAR_BYTES[type];
    return v;
  };
  const value = (type, keep) => {
    if (type === GGUF_TYPE.STRING) return str(keep);
    if (type === GGUF_TYPE.ARRAY) {
      const itemType = u32();
      const n = u64();
      const out = [];
      for (let i = 0; i < n; i += 1) out.push(value(itemType, keep));
      return out;
    }
    return scalar(type);
  };

  need(4);
  if (decoder.decode(bytes.subarray(0, 4)) !== GGUF_MAGIC) throw new Error('not a GGUF file');
  p = 4;
  const version = u32();
  if (version < 2) throw new Error(`GGUF version ${version} is too old`);
  u64(); // tensor count
  const kvCount = u64();
  const kv = new Map();
  for (let i = 0; i < kvCount; i += 1) {
    const key = str();
    const type = u32();
    const keep = !key.startsWith('graph.');
    const v = value(type, keep);
    if (keep) kv.set(key, v);
  }
  return kv;
}

/** Z -> symbol from a list of atomic numbers, unknown numbers dropped. */
function symbolsOf(numbers) {
  return (numbers || []).map((z) => SYMBOLS[z]).filter((s) => s && s !== 'X');
}

/**
 * What a PET GGUF says about itself. `species` are the elements it has
 * parameters for; `elements` the ones it was trained for, when the exporter
 * recorded them (tools/pet_catalogue/README.md).
 * @param {Map<string, any>} kv
 */
export function describeGGUF(kv) {
  const species = [];
  const map = kv.get('pet.species_map');
  if (Array.isArray(map)) for (let i = 0; i + 1 < map.length; i += 2) species.push(map[i]);
  const text = (key) => (typeof kv.get(key) === 'string' && kv.get(key) ? kv.get(key) : undefined);
  return {
    architecture: text('general.architecture'),
    name: text('general.name'),
    description: text('general.description'),
    license: text('general.license'),
    authors: text('general.author'),
    url: text('general.url'),
    version: text('general.version'),
    base: text('general.base_model.0.name'),
    species: symbolsOf(species),
    elements: symbolsOf(kv.get('pet.training_species')),
  };
}

/**
 * Check that a Blob is a PET model for mlip.cpp and read its metadata.
 * @param {Blob} blob
 * @param {string} url  for messages
 */
async function inspectModelBlob(blob, url) {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const start = new TextDecoder().decode(head).replace(/\s+/g, ' ').trim();
  if (start.slice(0, 4) !== GGUF_MAGIC) {
    const looksLikePage = /^(<!doctype|<html|<\?xml|<)/i.test(start);
    throw new Error(`${fileNameOf(url)} from ${hostOf(url)} is not a GGUF model`
      + (looksLikePage ? ': it is a web page. Use the link that downloads the file itself.' : `: it starts with "${start.slice(0, 24)}".`));
  }
  // The metadata sits at the front; the graph JSON makes it a few hundred KB.
  let kv;
  for (const n of [4 << 20, blob.size]) {
    try {
      kv = readGGUFMetadata(await blob.slice(0, n).arrayBuffer());
      break;
    } catch (error) {
      if (!(error instanceof RangeError) || n >= blob.size) throw new Error(`${fileNameOf(url)}: unreadable GGUF header (${error.message})`);
    }
  }
  const info = describeGGUF(/** @type {Map<string, any>} */ (kv));
  if (info.architecture !== 'pet-graph' && info.architecture !== 'pet') {
    throw new Error(`${fileNameOf(url)} is a GGUF file but not a PET model for mlip.cpp (architecture "${info.architecture || 'none'}").`);
  }
  return info;
}

/**
 * Download (or take from the cache) a PET model, check it, and return it as a
 * File for runner.loadModelFromFile.
 * @param {string} link
 * @param {{ sha256?: string, name?: string,
 *           onProgress?: (p: { loadedBytes: number, totalBytes: number }) => void }} [options]
 * @returns {Promise<{ file: File, url: string, info: ReturnType<typeof describeGGUF>, checked: boolean|null }>}
 *   checked: sha256 verified (true), none given (false), no Web Crypto (null)
 */
export async function fetchPetModel(link, { sha256, name, onProgress } = {}) {
  const url = directLink(link);
  const want = sha256 ? String(sha256).toLowerCase() : null;
  let cache = null;
  let blob = null;
  if (typeof caches !== 'undefined') {
    try {
      cache = await caches.open(MODEL_CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) blob = await hit.blob();
    } catch (_error) {
      cache = null;
    }
  }
  // A cached copy that is not what the catalogue lists (the file at the link
  // was replaced) is dropped and downloaded again.
  if (blob && want) {
    const got = await sha256Hex(blob);
    if (got && got !== want) {
      blob = null;
      try { await cache?.delete(url); } catch (_e) { /* best effort */ }
    }
  }
  const fromCache = Boolean(blob);
  if (!blob) blob = await readWithProgress(await fetchExplained(url, 'the model'), onProgress);

  const info = await inspectModelBlob(blob, url);
  let checked = false;
  if (want) {
    const got = await sha256Hex(blob);
    if (got === null) checked = null;
    else if (got !== want) {
      throw new Error(`${fileNameOf(url)}: checksum mismatch, so this is not the file the catalogue lists `
        + `(sha256 ${got.slice(0, 12)}…, expected ${want.slice(0, 12)}…).`);
    } else checked = true;
  }
  if (cache && !fromCache) {
    try {
      await cache.put(url, new Response(blob, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch (_error) { /* quota: caching is best effort */ }
  }
  const file = new File([blob], name || info.name || fileNameOf(url), { type: 'application/octet-stream' });
  return { file, url, info, checked };
}

/**
 * Metadata of a local .gguf (the panel's file input), with the same checks.
 * @param {File} file
 */
export async function inspectPetModelFile(file) {
  return inspectModelBlob(file, `file:///${file.name}`);
}

// ------------------------------------------------------------------ catalogues

const SYMBOL_SET = new Set(SYMBOLS.slice(1));
const optionalText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Validate a catalogue's JSON. Entries without a name or a link, or with a
 * malformed checksum, are left out with a warning; relative links resolve
 * against the catalogue's own URL.
 * @param {any} json  `{ name, description?, models: [...] }`, or just the models array
 * @param {string} url
 * @returns {PetCatalogue}
 */
export function parsePetCatalogue(json, url) {
  const list = Array.isArray(json) ? json : json?.models;
  if (!Array.isArray(list)) throw new Error('A catalogue is a JSON object with a "models" list.');
  const warnings = [];
  const models = [];
  const seen = new Set();
  list.forEach((raw, i) => {
    const label = optionalText(raw?.name) || optionalText(raw?.id) || `entry ${i + 1}`;
    if (!raw || typeof raw !== 'object') { warnings.push(`${label}: not an object`); return; }
    const name = optionalText(raw.name);
    if (!name) { warnings.push(`${label}: no "name"`); return; }
    let link;
    try { link = directLink(raw.url, url); } catch (error) { warnings.push(`${name}: ${error.message}`); return; }
    if (seen.has(link)) { warnings.push(`${name}: same link as an earlier entry`); return; }
    let sha256;
    if (raw.sha256 !== undefined) {
      sha256 = String(raw.sha256).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) { warnings.push(`${name}: "sha256" is not 64 hex digits`); return; }
    }
    const elements = Array.isArray(raw.elements)
      ? raw.elements.map((e) => String(e).trim()).filter((e) => SYMBOL_SET.has(e))
      : undefined;
    seen.add(link);
    models.push({
      url: link,
      name,
      id: optionalText(raw.id),
      sha256,
      size: Number.isFinite(Number(raw.size)) && Number(raw.size) > 0 ? Number(raw.size) : undefined,
      base: optionalText(raw.base),
      method: optionalText(raw.method),
      elements: elements && elements.length ? elements : undefined,
      reference: optionalText(raw.reference),
      description: optionalText(raw.description),
      authors: optionalText(raw.authors),
      license: optionalText(raw.license),
      citation: optionalText(raw.citation),
      data: optionalText(raw.data),
    });
  });
  return {
    url,
    name: optionalText(json?.name) || hostOf(url),
    description: optionalText(json?.description),
    models,
    warnings,
  };
}

/**
 * Download and validate a catalogue.
 * @param {string} link
 * @returns {Promise<PetCatalogue>}
 */
export async function fetchPetCatalogue(link) {
  const url = directLink(link);
  const response = await fetchExplained(url, 'the catalogue');
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${fileNameOf(url)} from ${hostOf(url)} is not a catalogue: not valid JSON.`);
  }
  return parsePetCatalogue(json, url);
}

/**
 * One link, either kind: a GGUF model or a JSON catalogue, told apart by the
 * file's first bytes (one download; a model goes into the cache).
 * @param {string} link
 * @param {{ onProgress?: (p: { loadedBytes: number, totalBytes: number }) => void }} [options]
 * @returns {Promise<{ kind: 'model', url: string, name: string, info: ReturnType<typeof describeGGUF> }
 *                 | { kind: 'catalogue', catalogue: PetCatalogue }>}
 */
export async function openPetLink(link, { onProgress } = {}) {
  const url = directLink(link);
  const blob = await readWithProgress(await fetchExplained(url, 'the link'), onProgress);
  const start = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 64).arrayBuffer())).trimStart();
  if (start.startsWith('{') || start.startsWith('[')) {
    let json;
    try { json = JSON.parse(await blob.text()); } catch { throw new Error(`${fileNameOf(url)} is neither a GGUF model nor a valid JSON catalogue.`); }
    return { kind: 'catalogue', catalogue: parsePetCatalogue(json, url) };
  }
  const info = await inspectModelBlob(blob, url);
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(MODEL_CACHE_NAME);
      await cache.put(url, new Response(blob, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch (_error) { /* best effort */ }
  }
  return { kind: 'model', url, name: info.name || fileNameOf(url), info };
}

/**
 * Elements of `present` outside `allowed` (both symbol lists).
 * @param {string[]} present
 * @param {string[]|undefined} allowed
 */
export function elementsOutside(present, allowed) {
  if (!allowed || !allowed.length) return [];
  const ok = new Set(allowed);
  return [...new Set(present)].filter((e) => !ok.has(e));
}

/** "17 MB", "350 kB". */
export function formatBytes(bytes) {
  return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/**
 * One line about a model for the panel: origin, training domain, reference,
 * licence, citation.
 * @param {Partial<PetModelEntry>} m
 */
export function describePetModel(m) {
  const parts = [];
  if (m.base) parts.push(m.method ? `from ${m.base} (${m.method})` : `from ${m.base}`);
  if (m.elements?.length) parts.push(`trained for ${m.elements.join(', ')}`);
  if (m.reference) parts.push(m.reference);
  if (m.size) parts.push(formatBytes(m.size));
  if (m.license) parts.push(m.license);
  if (m.authors) parts.push(m.authors);
  if (m.citation) parts.push(`cite: ${m.citation}`);
  return parts.join(' · ');
}
