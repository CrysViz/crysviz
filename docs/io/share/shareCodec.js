// Compact share-link codec (format v3, ShareURLPlan.md section 2.4).
//
//   encodeCompact(captureState())  -> small plain object (JSON, then deflate)
//   expandCompact(object)          -> full captureState()-shaped v2 state
//
// The expanded state is what applySharedState() already consumes, so the
// loader and the .crysviz format are untouched. Expansion always produces a
// FULL state: the restore helpers keep the recipient's current value for any
// absent key, and recipients may carry custom colours/cutoffs in
// localStorage, so every omitted setting is filled from the frozen baseline
// the link names, and structure-derived tables are always written.
//
// PURE: no DOM, no three.js, no store. Links are untrusted input; everything
// read here is validated and bounded (see validate* helpers).

import { BASELINES, LATEST_BASELINE_ID, SETTING_KEYS, STRUCTURE_DERIVED_KEYS } from './shareBaselines.js';

export { LATEST_BASELINE_ID };

const FORMAT_VERSION = 3;
const STATE_VERSION = '2.16';
const MAX_ATOMS = 200000;
const MAX_SUPERCELL_PRODUCT = 1000;
const MAX_STRING = 256;
/** Cartesian accuracy of shared atom positions, Å (ShareURLPlan.md 2.5). */
export const POSITION_TOLERANCE_A = 1e-4;
const SECTIONS = /** @type {const} */ (['colors', 'display', 'style']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Per-structure style stores: captureState path -> short name inside `t`. */
const STORE_KEYS = /** @type {ReadonlyArray<readonly [string, string, string]>} */ ([
  ['colors', 'atomImageStyles', 'ai'],
  ['colors', 'bondUserStyles', 'bu'],
  ['colors', 'bondCategoryStyles', 'bc'],
  ['colors', 'polyhedraUserStyles', 'pu'],
  ['colors', 'polyhedraCategoryStyles', 'pc'],
  ['colors', 'atomMaterials', 'am'],
  ['colors', 'atomUserMaterials', 'au'],
  ['colors', 'spinCategoryStyles', 'sc'],
  ['colors', 'forceCategoryStyles', 'fc'],
  ['colors', 'fieldMaterial', 'fm'],
  ['display', 'focusRegions', 'fr'],
]);
/** Stores whose keys are atom indices; dropped when a referenced database
 *  entry changed underneath a link (indices may no longer line up). */
const ATOM_INDEXED_STORES = new Set(['ai', 'bu', 'pu', 'au']);

const PATH_TO_SHORT = new Map(SETTING_KEYS.map(([p, s]) => [p, s]));
const SHORT_TO_PATH = new Map(SETTING_KEYS.map(([p, s]) => [s, p]));
const DERIVED = new Set(STRUCTURE_DERIVED_KEYS);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Round a float to `digits` significant digits; integers pass untouched
 *  (colour ints must never be rounded). */
function roundSig(v, digits = 6) {
  if (typeof v !== 'number' || !Number.isFinite(v) || Number.isInteger(v)) return v;
  return Number(v.toPrecision(digits));
}

function roundDp(v, dp) {
  const r = Number(v.toFixed(dp));
  return Object.is(r, -0) ? 0 : r;
}

/** Deep copy with float rounding and unsafe keys dropped. */
function cleanValue(value, depth = 0) {
  if (depth > 32) throw new Error('Share link: value nested too deeply');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Share link: non-finite number');
    return roundSig(value);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 4096) throw new Error('Share link: string too long');
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => cleanValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(k) || v === undefined) continue;
      out[k] = cleanValue(v, depth + 1);
    }
    return out;
  }
  return undefined; // functions, symbols, undefined: not representable
}

function sameValue(a, b) {
  return JSON.stringify(cleanValue(a)) === JSON.stringify(cleanValue(b));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isColor(v) {
  return (Number.isInteger(v) && v >= 0 && v <= 0xffffff)
    || (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function assert(cond, message) {
  if (!cond) throw new Error(`Share link: ${message}`);
}

function speciesOf(elements) {
  return [...new Set(elements)];
}

function pairSpecies(key) {
  const m = /^(.+)-(.+)$/.exec(key);
  return m ? [m[1], m[2]] : null;
}

/** Keep only map entries whose element key (or both halves of an "A-B" pair
 *  key) are present. Keys that are neither are kept as they are. */
function filterBySpecies(map, species) {
  if (!isPlainObject(map)) return {};
  const present = new Set(species);
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (UNSAFE_KEYS.has(k) || v === undefined) continue;
    const pair = pairSpecies(k);
    if (present.has(k) || (pair && present.has(pair[0]) && present.has(pair[1]))) out[k] = v;
  }
  return out;
}

function vecLength(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Decimals per lattice axis so a fractional rounding error of half a unit in
 *  the last place stays below POSITION_TOLERANCE_A in Cartesian space. */
function positionDecimals(lattice) {
  return lattice.map((row) => {
    const len = vecLength(row);
    if (!(len > 0)) return 6;
    return Math.min(12, Math.max(0, Math.ceil(Math.log10((0.5 * len) / POSITION_TOLERANCE_A))));
  });
}

function speciesRuns(elements) {
  const runs = [];
  for (const e of elements) {
    const last = runs[runs.length - 1];
    if (last && last[0] === e) last[1]++;
    else runs.push([e, 1]);
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Quaternion helpers (x, y, z, w), plain arrays
// ---------------------------------------------------------------------------

function rotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

function normalizeQuat(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 0 ? q.map((c) => c / n) : [0, 0, 0, 1];
}

// ---------------------------------------------------------------------------
// Per-atom maps: {index: value} <-> [[value, [i | [from, to], ...]], ...]
// ---------------------------------------------------------------------------

function encodeAtomMap(map) {
  if (!isPlainObject(map)) return null;
  const groups = new Map();
  for (const [k, v] of Object.entries(map)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || v === undefined) continue;
    const value = cleanValue(v);
    const key = JSON.stringify(value);
    if (!groups.has(key)) groups.set(key, { value, idx: [] });
    groups.get(key).idx.push(i);
  }
  if (!groups.size) return null;
  const out = [];
  for (const { value, idx } of groups.values()) {
    idx.sort((a, b) => a - b);
    const list = [];
    for (let j = 0; j < idx.length;) {
      let end = j;
      while (end + 1 < idx.length && idx[end + 1] === idx[end] + 1) end++;
      if (end - j >= 2) list.push([idx[j], idx[end]]);
      else for (let t = j; t <= end; t++) list.push(idx[t]);
      j = end + 1;
    }
    out.push([value, list]);
  }
  return out;
}

function decodeAtomMap(encoded, n, checkValue, label) {
  const out = {};
  if (encoded == null) return out;
  assert(Array.isArray(encoded), `${label} must be a list`);
  let total = 0;
  for (const entry of encoded) {
    assert(Array.isArray(entry) && entry.length === 2 && Array.isArray(entry[1]), `bad ${label} entry`);
    const [value, list] = entry;
    assert(checkValue(value), `bad ${label} value`);
    for (const item of list) {
      const [from, to] = Array.isArray(item) ? item : [item, item];
      assert(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to < n,
        `${label} index out of range`);
      total += to - from + 1;
      assert(total <= n, `${label} lists more atoms than the structure has`);
      for (let i = from; i <= to; i++) out[i] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry fingerprint (database references)
// ---------------------------------------------------------------------------

/**
 * Short, stable fingerprint of a structure's geometry at link precision:
 * FNV-1a 32-bit over elements, lattice (6 dp) and positions wrapped to [0,1)
 * and rounded per axis like shared positions. Used to tell whether a
 * database structure is still exactly what was fetched.
 * @param {{elements: string[], lattice: number[][], positions: number[][]}} structure
 * @returns {string}
 */
export function geometryFingerprint({ elements, lattice, positions }) {
  const dps = positionDecimals(lattice);
  const parts = [elements.join(','), lattice.flat().map((v) => roundDp(v, 6).toFixed(6)).join(',')];
  for (const p of positions) {
    parts.push(p.map((v, axis) => {
      let f = v - Math.floor(v);
      f = roundDp(f, dps[axis]);
      if (f >= 1) f -= 1;
      return f.toFixed(dps[axis]);
    }).join(','));
  }
  const text = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// ---------------------------------------------------------------------------
// Supercell
// ---------------------------------------------------------------------------

/** Expand a base cell exactly like tileSupercell() (ui/SuperCellModule.js):
 *  i, j, k outer, atoms inner, image (0,0,0) first. */
function tile(base, [nx, ny, nz]) {
  const elements = [];
  const positions = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        for (let p = 0; p < base.positions.length; p++) {
          const pos = base.positions[p];
          elements.push(base.elements[p]);
          positions.push([(pos[0] + i) / nx, (pos[1] + j) / ny, (pos[2] + k) / nz]);
        }
      }
    }
  }
  const mult = [nx, ny, nz];
  return { elements, positions, lattice: base.lattice.map((row, a) => row.map((v) => v * mult[a])) };
}

/** The base cell of `structure` if it is exactly an nx×ny×nz tiling, else null. */
function baseCellOf(structure, supercell) {
  if (!supercell) return null;
  const mult = [supercell.nx, supercell.ny, supercell.nz];
  if (!mult.every((m) => Number.isInteger(m) && m >= 1)) return null;
  const product = mult[0] * mult[1] * mult[2];
  const n = structure.positions.length;
  if (product <= 1 || product > MAX_SUPERCELL_PRODUCT || n % product !== 0) return null;
  const count = n / product;
  const base = {
    elements: structure.elements.slice(0, count),
    positions: structure.positions.slice(0, count).map((p) => p.map((v, a) => v * mult[a])),
    lattice: structure.lattice.map((row, a) => row.map((v) => v / mult[a])),
  };
  const expanded = tile(base, /** @type {[number, number, number]} */ (mult));
  for (let i = 0; i < n; i++) {
    if (expanded.elements[i] !== structure.elements[i]) return null;
    for (let a = 0; a < 3; a++) {
      const d = expanded.positions[i][a] - structure.positions[i][a];
      if (Math.abs(d - Math.round(d)) > 1e-6) return null;
    }
  }
  return { base, mult };
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function encodeStructureBlock(structure) {
  const dps = positionDecimals(structure.lattice);
  return {
    e: speciesRuns(structure.elements),
    l: structure.lattice.flat().map((v) => roundDp(v, 6)),
    p: [0, 1, 2].map((a) => structure.positions.map((pos) => roundDp(pos[a], dps[a]))),
  };
}

function encodeCamera(cam) {
  if (!cam?.position || !cam?.target || !cam?.quaternion) return null;
  const q = normalizeQuat(cam.quaternion.map(Number));
  const t = cam.target;
  const offset = [0, 1, 2].map((a) => cam.position[a] - t[a]);
  const dist = vecLength(offset);
  const up = cam.up ?? [0, 1, 0];
  const rebuilt = rotate(q, [0, 0, 1]).map((v) => v * dist);
  const consistent = dist > 0 && vecLength(rebuilt.map((v, a) => v - offset[a])) <= 1e-3 * Math.max(dist, 1);
  let frustum = 0;
  if (cam.orthographic) frustum = isFiniteNumber(cam.frustumSize) && cam.frustumSize > 0 ? roundSig(cam.frustumSize, 6) : -1;
  const c = [
    ...q.map((v) => roundDp(v, 4)),
    ...t.map((v) => roundDp(v, 3)),
    roundDp(dist, 3),
    frustum,
    isFiniteNumber(cam.zoom) ? roundSig(cam.zoom, 4) : 1,
    ...(Array.isArray(cam.pan) ? cam.pan : [0, 0]).map((v) => roundDp(Number(v) || 0, 4)),
    ...up.map((v) => roundDp(v, 3)),
  ];
  if (!consistent) {
    // Camera not looking at its target: keep the explicit position.
    c.push(...cam.position.map((v) => roundDp(v, 3)));
    return c;
  }
  // Trim trailing defaults: up [0,1,0], pan 0, zoom 1.
  const defaults = [null, null, null, null, null, null, null, null, null, 1, 0, 0, 0, 1, 0];
  while (c.length > 9 && c[c.length - 1] === defaults[c.length - 1]) c.pop();
  return c;
}

function encodeRef(ref, elements) {
  if (!ref || !Number.isInteger(ref.atomIndex) || ref.atomIndex < 0 || ref.atomIndex >= elements.length) return null;
  // A ref whose element disagrees with the atom is stale (measurement labels
  // outlive a structure switch); the loader could never resolve it, so it is
  // dropped here rather than re-attached to whatever atom has that index now.
  if (ref.element && ref.element !== elements[ref.atomIndex]) return null;
  const off = Array.isArray(ref.imageOffset) ? ref.imageOffset.map((v) => Math.round(Number(v) || 0)) : [0, 0, 0];
  return [ref.atomIndex, ...off];
}

function encodeMeasurements(list, elements) {
  const out = [];
  for (const m of list ?? []) {
    if (m?.type === 'distance' || m?.type === 'angle') {
      const keys = m.type === 'distance' ? ['atom1Ref', 'atom2Ref'] : ['atom1Ref', 'atom2Ref', 'atom3Ref'];
      const refs = keys.map((k) => encodeRef(m[k], elements));
      if (refs.every(Boolean)) out.push([m.type === 'distance' ? 'd' : 'a', ...refs]);
    }
  }
  return out;
}

/**
 * Encode a captureState() snapshot into the compact v3 object.
 * @param {any} state captureState() output (single structure, v2 shape)
 * @param {{ supercell?: {nx:number, ny:number, nz:number} | null,
 *           reference?: ({kind: 'alexandria', id: string} | {kind: 'optimade', url: string}) & {fingerprint: string} | null,
 *           baselineId?: number }} [options]
 *   supercell: structure.supercell; the base cell + multipliers are written
 *   only if re-tiling reproduces the structure. reference: provenance of a
 *   database structure; used only if its fingerprint equals the (base-cell)
 *   geometry being shared, otherwise the structure is embedded.
 * @returns {Record<string, any>}
 */
export function encodeCompact(state, { supercell = null, reference = null, baselineId = LATEST_BASELINE_ID } = {}) {
  assert(state && isPlainObject(state.structure), 'state has no structure to share');
  const baseline = BASELINES[baselineId];
  assert(baseline, `unknown baseline ${baselineId}`);
  const structure = {
    elements: state.structure.elements,
    lattice: state.structure.lattice,
    positions: state.structure.positions,
  };
  const n = structure.positions.length;
  assert(n === structure.elements.length && n <= MAX_ATOMS, 'structure has an invalid atom count');
  const species = speciesOf(structure.elements);
  const colors = state.colors ?? {};
  const display = state.display ?? {};

  /** @type {Record<string, any>} */
  const out = { v: FORMAT_VERSION, b: baselineId };

  // --- structure: reference, supercell base cell, or full list ---
  const tiled = baseCellOf(structure, supercell);
  const cell = tiled ? tiled.base : structure;
  const useReference = reference && typeof reference.fingerprint === 'string'
    && geometryFingerprint(cell) === reference.fingerprint
    && ((reference.kind === 'alexandria' && typeof reference.id === 'string')
      || (reference.kind === 'optimade' && typeof reference.url === 'string'));
  if (useReference) {
    out.r = reference.kind === 'alexandria'
      ? { a: reference.id, k: reference.fingerprint }
      : { u: reference.url, k: reference.fingerprint };
    if (tiled) out.s = { x: tiled.mult };
  } else {
    out.s = encodeStructureBlock(cell);
    if (tiled) out.s.x = tiled.mult;
  }

  // --- camera ---
  const c = encodeCamera(state.camera);
  if (c) out.c = c;

  // --- species tables: always written (never taken from a baseline) ---
  out.ec = species.map((el) => cleanValue(colors.elementColors?.[el] ?? null));
  const bondLengths = filterBySpecies(display.bondLengths, species);
  const bondVisibility = filterBySpecies(display.bondVisibility, species);
  out.bl = Object.entries(bondLengths).map(([pair, v]) => {
    const entry = typeof v === 'number' ? { min: 0, max: v } : (v ?? {});
    const row = [pair, roundSig(Number(entry.max))];
    if (Number(entry.min)) row.push(roundSig(Number(entry.min)));
    return row;
  });
  const hidden = Object.entries(bondVisibility).filter(([, v]) => v === false).map(([k]) => k);
  if (hidden.length) out.bh = hidden;
  const av = filterBySpecies(display.atomVisibility, species);
  if (Object.keys(av).length) out.av = cleanValue(av);
  const ci = filterBySpecies(display.bondCutImmunity, species);
  if (Object.keys(ci).length) out.ci = cleanValue(ci);
  if (display.spinSpeciesVisibility) {
    const sv = filterBySpecies(display.spinSpeciesVisibility, species);
    if (Object.keys(sv).length) out.sv = cleanValue(sv);
  }

  // --- per-atom maps ---
  const ac = encodeAtomMap(colors.atomColors);
  if (ac) out.ac = ac;
  const ao = encodeAtomMap(colors.atomOpacities);
  if (ao) out.ao = ao;
  const ar = encodeAtomMap(colors.atomRadiusScales);
  if (ar) out.ar = ar;

  // --- per-structure style stores (sparse already) ---
  const t = {};
  for (const [sect, key, short] of STORE_KEYS) {
    const v = state[sect]?.[key];
    if (v == null) continue;
    if (Array.isArray(v) ? v.length : (isPlainObject(v) ? Object.keys(v).length : true)) t[short] = cleanValue(v);
  }
  if (Object.keys(t).length) out.t = t;

  // --- measurements ---
  const m = encodeMeasurements(state.measurements, structure.elements);
  if (m.length) out.m = m;

  // --- settings that differ from the baseline ---
  const o = {};
  const extra = {};
  for (const sect of SECTIONS) {
    for (const [key, value] of Object.entries(state[sect] ?? {})) {
      const path = `${sect}.${key}`;
      if (value === undefined || DERIVED.has(path)) continue;
      const short = PATH_TO_SHORT.get(path);
      if (short) {
        if (!sameValue(value, baseline[sect]?.[key])) o[short] = cleanValue(value);
      } else {
        extra[path] = cleanValue(value); // no short key yet: never drop it
      }
    }
  }
  if (Object.keys(o).length) out.o = o;
  if (Object.keys(extra).length) out.X = extra;
  return out;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * The database reference a compact link points at, or null.
 * @param {any} obj
 * @returns {({kind: 'alexandria', id: string} | {kind: 'optimade', url: string}) & {fingerprint: string, supercell: number[] | null} | null}
 */
export function compactReference(obj) {
  if (!isPlainObject(obj) || !isPlainObject(obj.r)) return null;
  const r = obj.r;
  const fingerprint = typeof r.k === 'string' ? r.k.slice(0, 32) : '';
  const supercell = Array.isArray(obj.s?.x) ? obj.s.x : null;
  if (typeof r.a === 'string' && r.a.length <= MAX_STRING) return { kind: 'alexandria', id: r.a, fingerprint, supercell };
  if (typeof r.u === 'string' && r.u.length <= 2048) return { kind: 'optimade', url: r.u, fingerprint, supercell };
  throw new Error('Share link: unrecognised database reference');
}

function validateStructureArrays({ elements, lattice, positions }, label) {
  assert(Array.isArray(elements) && Array.isArray(positions) && elements.length === positions.length,
    `${label}: elements and positions disagree`);
  assert(elements.length > 0 && elements.length <= MAX_ATOMS, `${label}: atom count out of range`);
  assert(Array.isArray(lattice) && lattice.length === 3
    && lattice.every((r) => Array.isArray(r) && r.length === 3 && r.every(isFiniteNumber)), `${label}: bad lattice`);
  for (const p of positions) assert(Array.isArray(p) && p.length === 3 && p.every(isFiniteNumber), `${label}: bad position`);
  for (const e of elements) assert(typeof e === 'string' && e.length > 0 && e.length <= 16 && !/\s/.test(e), `${label}: bad element`);
}

function decodeStructureBlock(s) {
  assert(isPlainObject(s), 'missing structure');
  assert(Array.isArray(s.e) && s.e.length > 0, 'missing species');
  const elements = [];
  for (const run of s.e) {
    assert(Array.isArray(run) && run.length === 2 && Number.isInteger(run[1]) && run[1] > 0, 'bad species run');
    assert(elements.length + run[1] <= MAX_ATOMS, 'too many atoms');
    for (let i = 0; i < run[1]; i++) elements.push(run[0]);
  }
  assert(Array.isArray(s.l) && s.l.length === 9 && s.l.every(isFiniteNumber), 'bad lattice');
  const lattice = [s.l.slice(0, 3), s.l.slice(3, 6), s.l.slice(6, 9)];
  assert(Array.isArray(s.p) && s.p.length === 3, 'bad positions');
  const n = elements.length;
  for (const axis of s.p) assert(Array.isArray(axis) && axis.length === n && axis.every(isFiniteNumber), 'bad positions');
  const positions = elements.map((_, i) => [s.p[0][i], s.p[1][i], s.p[2][i]]);
  return { elements, lattice, positions };
}

function decodeSupercell(x) {
  if (x == null) return null;
  assert(Array.isArray(x) && x.length === 3 && x.every((m) => Number.isInteger(m) && m >= 1 && m <= MAX_SUPERCELL_PRODUCT),
    'bad supercell multipliers');
  assert(x[0] * x[1] * x[2] <= MAX_SUPERCELL_PRODUCT, 'supercell too large');
  return /** @type {[number, number, number]} */ (x);
}

function decodeCamera(c) {
  const empty = { position: null, target: null, up: null, quaternion: null, pan: [0, 0], zoom: null, orthographic: false, frustumSize: null };
  if (c == null) return empty;
  assert(Array.isArray(c) && c.length >= 9 && c.length <= 18 && c.every(isFiniteNumber), 'bad camera');
  const q = normalizeQuat(c.slice(0, 4));
  const target = c.slice(4, 7);
  const dist = c[7];
  const frustum = c[8];
  const zoom = c.length > 9 ? c[9] : 1;
  const pan = [c.length > 10 ? c[10] : 0, c.length > 11 ? c[11] : 0];
  const up = c.length > 12 ? [c[12], c.length > 13 ? c[13] : 1, c.length > 14 ? c[14] : 0] : [0, 1, 0];
  const position = c.length >= 18
    ? c.slice(15, 18)
    : rotate(q, [0, 0, 1]).map((v, a) => target[a] + v * dist);
  return {
    position,
    target,
    up,
    quaternion: q,
    pan,
    zoom,
    orthographic: frustum !== 0,
    frustumSize: frustum > 0 ? frustum : null,
  };
}

function decodeMeasurements(m, structure) {
  if (m == null) return [];
  assert(Array.isArray(m), 'bad measurements');
  const n = structure.elements.length;
  const ref = (r) => {
    assert(Array.isArray(r) && r.length === 4 && r.every(Number.isInteger) && r[0] >= 0 && r[0] < n, 'bad measurement atom');
    const [atomIndex, ...imageOffset] = r;
    return {
      atomIndex,
      element: structure.elements[atomIndex],
      imageOffset,
      lastResolvedFrac: structure.positions[atomIndex].map((v, a) => v + imageOffset[a]),
    };
  };
  return m.map((entry) => {
    assert(Array.isArray(entry) && (entry[0] === 'd' || entry[0] === 'a'), 'bad measurement');
    if (entry[0] === 'd') {
      assert(entry.length === 3, 'bad distance measurement');
      return { type: 'distance', atom1Ref: ref(entry[1]), atom2Ref: ref(entry[2]) };
    }
    assert(entry.length === 4, 'bad angle measurement');
    return { type: 'angle', atom1Ref: ref(entry[1]), atom2Ref: ref(entry[2]), atom3Ref: ref(entry[3]) };
  });
}

/**
 * Validated shallow copy of a string-keyed map from a link; unsafe keys dropped.
 * @param {any} v
 * @param {string} label
 * @param {(value: any) => boolean} [checkValue]
 */
function safeMap(v, label, checkValue = (_value) => true) {
  if (v == null) return {};
  assert(isPlainObject(v), `bad ${label}`);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (UNSAFE_KEYS.has(k)) continue;
    assert(k.length <= MAX_STRING && checkValue(val), `bad ${label} entry`);
    out[k] = val;
  }
  return out;
}

/** Type check of a decoded setting against its baseline value. */
function settingAcceptable(value, baselineValue) {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value) && (baselineValue === null || typeof baselineValue === 'number');
  if (typeof value === 'string') return value.length <= MAX_STRING && (baselineValue === null || typeof baselineValue === 'string');
  if (typeof value === 'boolean') return baselineValue === null || typeof baselineValue === 'boolean';
  if (isPlainObject(value)) return isPlainObject(baselineValue) || baselineValue === null;
  return false;
}

/**
 * Expand a compact v3 object into a full captureState()-shaped state that
 * applySharedState() consumes unchanged.
 * @param {any} obj parsed compact JSON (untrusted)
 * @param {{ referenceStructure?: {elements: string[], lattice: number[][], positions: number[][]} | null }} [options]
 *   referenceStructure: the structure fetched for a database-reference link
 *   (required when compactReference(obj) is non-null).
 * @returns {Record<string, any>} full state; `shareWarnings` (string[]) is set
 *   when a referenced database entry no longer matches the link.
 */
export function expandCompact(obj, { referenceStructure = null } = {}) {
  assert(isPlainObject(obj), 'payload is not an object');
  assert(obj.v === FORMAT_VERSION, `unsupported format version ${String(obj.v).slice(0, 8)}`);
  const baseline = BASELINES[obj.b];
  assert(baseline, 'this link was made by a newer version of CrysViz (unknown settings baseline)');
  const warnings = [];

  // --- structure ---
  const reference = compactReference(obj);
  const mult = decodeSupercell(obj.s?.x);
  let cell;
  let referenceChanged = false;
  if (reference) {
    assert(referenceStructure, 'this link needs the referenced database structure');
    validateStructureArrays(referenceStructure, 'referenced structure');
    cell = {
      elements: [...referenceStructure.elements],
      lattice: referenceStructure.lattice.map((r) => [...r]),
      positions: referenceStructure.positions.map((p) => [...p]),
    };
    if (geometryFingerprint(cell) !== reference.fingerprint) {
      referenceChanged = true;
      warnings.push('The database entry changed since this link was made; per-atom styling was skipped.');
    }
  } else {
    cell = decodeStructureBlock(obj.s);
  }
  const structure = mult ? tile(cell, mult) : cell;
  assert(structure.elements.length <= MAX_ATOMS, 'too many atoms');
  const n = structure.elements.length;
  const species = speciesOf(structure.elements);

  // --- settings: baseline, then overrides ---
  /** @type {Record<string, any>} */
  const sections = {};
  for (const sect of SECTIONS) sections[sect] = JSON.parse(JSON.stringify(baseline[sect]));
  if (obj.o != null) {
    assert(isPlainObject(obj.o), 'bad settings');
    for (const [short, value] of Object.entries(obj.o)) {
      const path = SHORT_TO_PATH.get(short);
      if (!path) continue; // unknown short key: newer link, ignore
      const [sect, key] = path.split('.');
      assert(settingAcceptable(value, baseline[sect][key]), `bad value for ${path}`);
      sections[sect][key] = isPlainObject(value) ? safeMap(value, path, isFiniteNumber) : value;
    }
  }
  if (obj.X != null) {
    assert(isPlainObject(obj.X), 'bad extra settings');
    for (const [path, value] of Object.entries(obj.X)) {
      const m = /^(colors|display|style)\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(path);
      if (!m || UNSAFE_KEYS.has(m[2]) || DERIVED.has(path)) continue;
      sections[m[1]][m[2]] = cleanValue(value);
    }
  }
  const { colors, display, style } = sections;

  // --- species tables ---
  assert(Array.isArray(obj.ec) && obj.ec.length === species.length && obj.ec.every((c) => c === null || isColor(c)),
    'bad element colours');
  colors.elementColors = {};
  species.forEach((el, i) => { if (obj.ec[i] !== null) colors.elementColors[el] = obj.ec[i]; });
  display.bondLengths = {};
  display.bondVisibility = {};
  if (obj.bl != null) {
    assert(Array.isArray(obj.bl), 'bad bond cutoffs');
    for (const row of obj.bl) {
      assert(Array.isArray(row) && (row.length === 2 || row.length === 3) && typeof row[0] === 'string'
        && row[0].length <= 40 && !UNSAFE_KEYS.has(row[0]) && row.slice(1).every(isFiniteNumber), 'bad bond cutoff');
      display.bondLengths[row[0]] = { min: row.length === 3 ? row[2] : 0, max: row[1] };
      display.bondVisibility[row[0]] = true;
    }
  }
  if (obj.bh != null) {
    assert(Array.isArray(obj.bh) && obj.bh.every((p) => typeof p === 'string' && p.length <= 40), 'bad hidden bonds');
    for (const p of obj.bh) if (!UNSAFE_KEYS.has(p)) display.bondVisibility[p] = false;
  }
  display.atomVisibility = safeMap(obj.av, 'atom visibility', (v) => typeof v === 'boolean');
  display.bondCutImmunity = safeMap(obj.ci, 'bond cut immunity', (v) => typeof v === 'boolean');
  if (obj.sv != null) display.spinSpeciesVisibility = safeMap(obj.sv, 'spin species visibility', (v) => typeof v === 'boolean');

  // --- per-atom maps ---
  const perAtomOk = !referenceChanged;
  colors.atomColors = perAtomOk ? decodeAtomMap(obj.ac, n, isColor, 'atom colours') : {};
  colors.atomOpacities = perAtomOk ? decodeAtomMap(obj.ao, n, (v) => isFiniteNumber(v) && v >= 0 && v <= 1, 'atom opacities') : {};
  colors.atomRadiusScales = perAtomOk ? decodeAtomMap(obj.ar, n, (v) => isFiniteNumber(v) && v > 0 && v < 100, 'atom radius scales') : {};

  // --- per-structure stores ---
  if (obj.t != null) {
    assert(isPlainObject(obj.t), 'bad style stores');
    for (const [sect, key, short] of STORE_KEYS) {
      if (obj.t[short] == null) continue;
      if (referenceChanged && ATOM_INDEXED_STORES.has(short)) continue;
      sections[sect][key] = cleanValue(obj.t[short]);
    }
  }

  const state = {
    version: STATE_VERSION,
    structure,
    colors,
    display,
    style,
    camera: decodeCamera(obj.c),
    measurements: referenceChanged ? [] : decodeMeasurements(obj.m, structure),
  };
  if (warnings.length) state.shareWarnings = warnings;
  return state;
}
