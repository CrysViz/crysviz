// Host command registry: one handler per command, shared by every transport
// (the pywebview bridge in BrowserHost.js today; Electron and the MCP App
// later). Each command's description, argument schema and tier live in
// commands.json, which the Python MCP server reads without opening a window;
// tools/unittest/hostcommands.test.mjs keeps the two in step.
import {
  getActiveStructure,
  getContainerById,
  getContainerForStructure,
  getContainerId,
  getContainers,
} from '../state/structures.js';
import { app, general } from '../state/store.js';
import { atomIds, structureRevision } from '../model/structureRevision.js';
import { assertNoJob, cancelJob, jobView, listJobs, startJob, waitJob } from './jobs.js';
import { cartToFractional, fracToCartPoint } from '../math/index.js';
import { findVoidCentres } from '../render/voidSearch.js';
import { clickControl, getControl, listWindows, readWindow, searchControls, setControl } from './controls.js';
import { apply, exportStructure, find, getBonding, resolveTargets, savedUserSelections, selectionOrigin, userPick, userSelection } from './query.js';
import * as tools from './structureTools.js';

export const PIPELINE_IDS = new Set(['depthpeel', 'wboit', 'forward', 'raytrace', 'pathtrace', 'split-atoms', 'sorted-atoms']);

export function errorRecord(code, message, details = undefined) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return error;
}

function safeJsonValue(value, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (depth > 4) return '[Truncated]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => safeJsonValue(item, seen, depth + 1));
  const result = {};
  for (const key of Object.keys(value).slice(0, 32)) {
    result[key] = safeJsonValue(value[key], seen, depth + 1);
  }
  return result;
}

export function safeError(error, fallbackCode = 'COMMAND_FAILED') {
  const code = typeof error?.code === 'string' ? error.code : fallbackCode;
  const message = String(error?.message || error || fallbackCode);
  const details = error?.details === undefined ? undefined : safeJsonValue(error.details);
  return errorRecord(code, message, details);
}

export function commandError(code, message, details = undefined) {
  /** @type {any} */
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

/** `periodic` is an optional literal boolean; the string "false", 0 and null are all rejected. */
export function requirePeriodicOption(value) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw commandError('INVALID_ARGS', 'load.periodic must be boolean');
  }
}

export function safeName(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBufferData(value) {
  return typeof value === 'string'
    || (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer)
    || (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array)
    || (typeof Blob !== 'undefined' && value instanceof Blob);
}

export function snapshotForContainer(container, activeStructure) {
  const active = container?.structures.indexOf(activeStructure);
  return {
    id: getContainerId(container),
    name: String(container.fileName),
    frames: container.structures.length,
    active: active >= 0,
    activeFrame: active >= 0 ? active : null,
  };
}

export function sameOriginURL(value, origin) {
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url : null;
  } catch {
    return null;
  }
}

export async function responseOrThrow(response, code, message) {
  if (!response.ok) throw commandError(code, `${message} (HTTP ${response.status})`);
  return response;
}

export function strictFetch(url, options = {}) {
  return fetch(url, { ...options, redirect: 'error' });
}

/** The host's one-use upload URL for a command's output (save_image, export_structure), validated. */
function managedOutputUrl(raw, origin) {
  const outputUrl = sameOriginURL(raw, origin);
  if (!outputUrl || outputUrl.username || outputUrl.password || outputUrl.search || outputUrl.hash
    || outputUrl.href !== raw
    || !/^\/_crysviz\/output\/[A-Za-z0-9_-]{32,}$/.test(outputUrl.pathname)) {
    throw commandError('INVALID_OUTPUT_URL', 'Managed output URL is invalid');
  }
  return outputUrl;
}

async function uploadOutput(outputUrl, body, contentType) {
  const response = await strictFetch(outputUrl, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  await responseOrThrow(response, 'OUTPUT_UPLOAD_FAILED', 'Could not upload managed output');
}

/**
 * save_image's size when width or height is left out: the view as the user
 * sees it (CSS size x devicePixelRatio, or the given side at the view's
 * aspect), scaled down to fit maxSide. Same aspect as the view, so the user's
 * framing comes out without letterbox bands.
 */
export function fitImageSize({ viewWidth, viewHeight, dpr = 1, width, height, maxSide }) {
  const aspect = viewWidth > 0 && viewHeight > 0 ? viewWidth / viewHeight : 4 / 3;
  let w = width ?? (height !== undefined ? height * aspect : viewWidth * dpr);
  let h = height ?? (width !== undefined ? width / aspect : viewHeight * dpr);
  const limit = Math.min(maxSide ?? 16384, 16384);
  const scale = Math.min(1, limit / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  return { width: w, height: h };
}

function requireArgs(args, name) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw commandError('INVALID_ARGS', `${name} requires an object args value`);
  }
  return args;
}

function requireOptionalArgs(args, name) {
  if (args !== undefined) requireArgs(args, name);
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * A Cartesian vector for set_view: a lattice vector name, a world axis name,
 * or three numbers, read as a lattice direction [u, v, w] = u*a + v*b + w*c,
 * or with `cartesian` as x, y, z (what get_state reports).
 * @param {unknown} direction
 * @param {number[][]|undefined} lattice rows a, b, c
 * @param {{cartesian?: boolean, name?: string}} [options]
 * @returns {number[]}
 */
export function viewDirection(direction, lattice, { cartesian = false, name = 'set_view.direction' } = {}) {
  const world = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  if (typeof direction === 'string' && world[direction]) return world[direction];
  const uvw = typeof direction === 'string' ? { a: [1, 0, 0], b: [0, 1, 0], c: [0, 0, 1] }[direction] : direction;
  if (!Array.isArray(uvw) || uvw.length !== 3 || !uvw.every(isFiniteNumber)) {
    throw commandError('INVALID_ARGS', `${name} must be a, b, c, x, y, z or three finite numbers`);
  }
  if (cartesian && typeof direction !== 'string') {
    if (Math.hypot(...uvw) < 1e-9) throw commandError('INVALID_ARGS', `${name} must be nonzero`);
    return [...uvw];
  }
  if (!Array.isArray(lattice) || lattice.length !== 3
    || lattice.some((row) => !Array.isArray(row) || row.length !== 3 || !row.every(isFiniteNumber))) {
    throw commandError('NO_LATTICE', 'The active structure has no lattice');
  }
  const vector = [0, 1, 2].map((k) => uvw[0] * lattice[0][k] + uvw[1] * lattice[1][k] + uvw[2] * lattice[2][k]);
  if (Math.hypot(...vector) < 1e-9) throw commandError('INVALID_ARGS', `${name} must be nonzero`);
  return vector;
}

/**
 * The part of `up` perpendicular to `direction`, as a unit vector: the screen's
 * up for a camera looking along `direction`.
 * @param {number[]} up
 * @param {number[]} direction
 */
export function screenUp(up, direction) {
  const n = Math.hypot(...direction);
  const d = direction.map((x) => x / n);
  const along = up[0] * d[0] + up[1] * d[1] + up[2] * d[2];
  const perp = up.map((x, i) => x - along * d[i]);
  const length = Math.hypot(...perp);
  if (length < 1e-6 * Math.hypot(...up)) throw commandError('INVALID_ARGS', 'set_view.up must not be parallel to direction');
  return perp.map((x) => x / length);
}

// Structures whose positions update_fractional_positions changed on the fast
// path only: bonds and derived data still describe the old positions.
const uncommitted = new WeakSet();

/** Max atom indices get_state lists for the user's selection, so a big one stays small. */
export const MAX_STATE_ATOMS = 500;

const round = (value) => Math.round(value * 1e6) / 1e6;
const unit = (v) => { const n = Math.hypot(...v); return n > 0 ? v.map((x) => round(x / n)) : v; };

/**
 * a, b, c (Angstrom) and alpha, beta, gamma (degrees) of lattice rows a, b, c.
 * @param {number[][]} lattice
 */
export function latticeParameters(lattice) {
  const [a, b, c] = lattice;
  const len = (v) => Math.hypot(...v);
  const angle = (u, v) => Math.acos(Math.max(-1, Math.min(1,
    (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len(u) * len(v))))) * 180 / Math.PI;
  return {
    a: round(len(a)), b: round(len(b)), c: round(len(c)),
    alpha: round(angle(b, c)), beta: round(angle(a, c)), gamma: round(angle(a, b)),
  };
}

/**
 * Element counts (summed occupancies) and a formula in first-appearance order.
 * @param {{species: {element: string, occupancy: number}[]}[]} atoms
 */
export function composition(atoms) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const atom of atoms) {
    for (const s of atom.species || []) counts[s.element] = (counts[s.element] || 0) + s.occupancy;
  }
  for (const element of Object.keys(counts)) counts[element] = round(counts[element]);
  const formula = Object.entries(counts).map(([el, n]) => (n === 1 ? el : `${el}${n}`)).join('');
  return { counts, formula };
}

// Revision tokens live in model/structureRevision.js (shared with the structure editor).
export { structureRevision, structureContent, atomIdentity } from '../model/structureRevision.js';


/**
 * The expectedRevision guard (host dispatch, every command). A call that
 * addresses atoms by index runs as long as those indices still point at the
 * same atoms as at `expected`, even if the user changed other atoms meanwhile
 * (sinceLastCall reports that); `exact` demands the whole revision unchanged.
 * @param {string} expected a revision the caller saw (get_state, find, a result)
 * @param {number[]} indices the atom indices the call addresses (may be empty)
 * @param {(revision: string) => string[] | undefined} idsAt atom ids at a revision this host reported
 * @param {boolean} [exact]
 */
export function checkExpectedRevision(expected, indices, idsAt, exact = false) {
  const structure = getActiveStructure();
  const current = structure ? structureRevision(structure) : null;
  if (expected === current) return;
  const atomCount = structure?.atoms.length ?? 0;
  const refuse = (why, extra = {}) => {
    throw commandError('STRUCTURE_CHANGED',
      `The structure changed since revision ${expected} (now ${current}, ${atomCount} atoms): ${why}. `
      + 'Call get_state or find again before acting on atom indices.',
      { revision: current, atomCount, ...extra });
  };
  if (exact) refuse('exactRevision asks for no change at all');
  if (!indices.length) return;
  const before = idsAt(expected);
  if (!before || !structure) refuse('that revision is not known here, so the atoms cannot be compared');
  const now = atomIds(structure);
  const moved = indices.filter((i) => i >= before.length || i >= now.length || before[i] !== now[i]);
  if (moved.length) refuse(`atom indices ${moved.slice(0, 20).join(', ')} now point at other atoms`, { movedAtoms: moved.slice(0, 50) });
}

/** Atom indices a command addresses directly (args.atoms as a list of indices). */
export function addressedIndices(args) {
  const atoms = args?.atoms;
  return Array.isArray(atoms) && atoms.every((i) => Number.isInteger(i)) ? atoms : [];
}

/**
 * Every error code a command can end with, classified. An `outcome` is the
 * world saying no to a well-formed call (the structure changed under it, a job
 * is running, atoms would collide): the host returns it as an ordinary result,
 * {applied: false, reason, code, ...details}, so a client does not report a
 * failed tool. An `error` is a call that was wrong, or a real failure. Codes
 * not listed are errors; tools/unittest/hostcommands.test.mjs keeps every code
 * the host can raise listed.
 */
export const ERROR_KINDS = Object.freeze({
  // outcomes: the call was fine, the situation refused it
  STRUCTURE_CHANGED: 'outcome', SELECTION_STALE: 'outcome', ATOMS_TOO_CLOSE: 'outcome', JOB_BUSY: 'outcome',
  NOTHING_TO_ORDER: 'outcome', CONTROL_DISABLED: 'outcome', CONTROL_UNAVAILABLE: 'outcome',
  NO_ACTIVE_STRUCTURE: 'outcome', NO_LATTICE: 'outcome', DISORDERED: 'outcome', NO_PHONONS: 'outcome',
  NO_EIGENVECTORS: 'outcome', NO_FIELD: 'outcome', TOO_LARGE: 'outcome', LOAD_CANCELLED: 'outcome',
  NO_MODE: 'outcome', PNG_CAPTURE_IN_PROGRESS: 'outcome', POTENTIAL_TOO_MANY_ATOMS: 'outcome', POTENTIAL_UNAVAILABLE: 'outcome',
  SYMMETRY_UNAVAILABLE: 'outcome', NOTHING_TO_REVERT: 'outcome',
  // errors: a wrong call
  INVALID_ARGS: 'error', INVALID_ELEMENT: 'error', INVALID_REQUEST: 'error', UNKNOWN_COMMAND: 'error',
  NOT_A_CONTROL: 'error', NOT_SETTABLE: 'error', CONTROL_NOT_FOUND: 'error', SELECTION_NOT_FOUND: 'error',
  STRUCTURE_NOT_FOUND: 'error', QPOINT_NOT_FOUND: 'error', FIELD_NOT_FOUND: 'error', FRAME_OUT_OF_RANGE: 'error',
  JOB_NOT_FOUND: 'error', INVALID_OUTPUT_URL: 'error', INVALID_INPUT_URL: 'error', INVALID_PIPELINE: 'error',
  // errors: a real failure
  COMMAND_FAILED: 'error', COMMAND_UNAVAILABLE: 'error', SYMMETRY_FAILED: 'error', SLAB_FAILED: 'error',
  SELECT_FAILED: 'error', POSITION_SYNC_FAILED: 'error', PIPELINE_FAILED: 'error', LOAD_FAILED: 'error',
  LATTICE_SYNC_FAILED: 'error', CONTROL_FAILED: 'error', CAPTURE_FAILED: 'error', HOST_COMMAND_FAILED: 'error',
  VIEWER_CLOSED: 'error', NOT_READY: 'error', JOB_FAILED: 'error',
  // errors of the launch path (bootstrap, manifest), never a command's
  INVALID_MANIFEST: 'error', MANIFEST_FETCH_FAILED: 'error', MANIFEST_COMPLETE_FAILED: 'error',
  INPUT_FETCH_FAILED: 'error', OUTPUT_UPLOAD_FAILED: 'error', BOOTSTRAP_FAILED: 'error', DOWNLOAD_UPLOAD_FAILED: 'error',
  DEFAULT_LOAD_UNAVAILABLE: 'error', SHARED_STATE_FAILED: 'error', HASH_LOAD_FAILED: 'error',
  OPTIMADE_CORS_OR_NETWORK: 'error',
});

/** A pressure in a structure's name ("... 112 GPa ..."), or null: a hint only, never acted on. */
export function namedPressureGPa(name) {
  // "112(3) GPa": a value with its uncertainty in brackets.
  const match = /(-?\d+(?:\.\d+)?)(?:\(\d+\))?\s*GPa/i.exec(String(name ?? ''));
  return match ? Number(match[1]) : null;
}

const colorHex = (c) => {
  if (typeof c === 'string') return (c.startsWith('#') ? c : `#${c}`).toLowerCase();
  if (Number.isFinite(c)) return `#${(c >>> 0).toString(16).padStart(6, '0')}`;
  if (c && typeof c.getHex === 'function') return `#${c.getHex().toString(16).padStart(6, '0')}`;
  return null;
};

/** Max atom indices listed per custom colour in get_state. */
const MAX_COLOR_SAMPLE = 20;

/**
 * Colours as text: each element's colour, and the per-atom colours that differ
 * from it (a user's or apply color's), grouped by colour. An atom is custom as
 * the structure editor judges it (a userColor, or a colour other than its
 * element colour); a disordered site counts when a species has its own colour.
 * @param {any} structure
 */
export function colorSummary(structure) {
  /** @type {Record<string, string|null>} */
  const elements = {};
  /** @type {Map<string, number[]>} */
  const custom = new Map();
  structure.atoms.forEach((atom, i) => {
    const element = atom.getRepresentativeElement?.() ?? structure.elements?.[i] ?? '';
    const disordered = (atom.species?.length ?? 1) > 1;
    const own = disordered
      ? atom.species.some((s) => s.color != null)
      : Boolean(atom.userColor) || colorHex(atom.color) !== colorHex(atom.elementColor);
    if (!own) { elements[element] ??= colorHex(atom.color); return; }
    const hex = colorHex(atom.getColor?.() ?? atom.color) ?? 'mixed';
    if (!custom.has(hex)) custom.set(hex, []);
    custom.get(hex).push(i);
  });
  return {
    elements,
    custom: [...custom].map(([color, atoms]) => ({
      color, count: atoms.length, atoms: atoms.slice(0, MAX_COLOR_SAMPLE),
      ...(atoms.length > MAX_COLOR_SAMPLE ? { truncated: true } : {}),
    })),
  };
}

function structureState(structure) {
  const container = getContainerForStructure(structure);
  const frame = container ? container.structures.indexOf(structure) : -1;
  const lattice = Array.isArray(structure.lattice) && structure.lattice.length === 3 ? structure.lattice : null;
  const { counts, formula } = composition(structure.atoms);
  return {
    id: container ? getContainerId(container) : null,
    name: container ? String(container.fileName) : null,
    frame: frame >= 0 ? frame : null,
    frames: container ? container.structures.length : 1,
    atomCount: structure.atoms.length,
    revision: structureRevision(structure),
    formula,
    composition: counts,
    periodic: structure.periodic !== false,
    lattice: lattice ? { vectors: lattice.map((row) => row.map(round)), ...latticeParameters(lattice) } : null,
    positionsCommitted: !uncommitted.has(structure),
    hiddenCount: structure.atoms.filter((atom) => atom.hidden).length,
  };
}

const wrap = (x) => { const w = round(x - Math.floor(x)); return w === 1 ? 0 : w; };

/**
 * The polyhedra the app built for `structure` (Show Polyhedra; cages with
 * Detect Cages), one per site: periodic images of the same polyhedron are
 * merged and counted.
 * @param {any} structure
 * @param {'centered'|'cage'|undefined} type
 */
export function polyhedraSummary(structure, type) {
  const element = (i) => structure.atoms[i]?.getRepresentativeElement?.() ?? structure.elements?.[i] ?? '';
  const sites = new Map();
  for (const p of structure.polyhedra?.polyhedra || []) {
    if (type && p.type !== type) continue;
    const n = p.vertices.length;
    if (!n) continue;
    const centroid = [0, 1, 2].map((k) => p.vertices.reduce((sum, v) => sum + v[k], 0) / n);
    const center = (p.type === 'centered' && structure.atoms[p.centerIndex]
      ? structure.atoms[p.centerIndex].position
      : cartToFractional(centroid, structure.lattice)).map(wrap);
    const key = `${p.type}|${p.centerIndex}|${center.map((x) => x.toFixed(3)).join(',')}`;
    const site = sites.get(key);
    if (site) { site.images += 1; continue; }
    /** @type {Record<string, number>} */
    const corners = {};
    for (const src of p.vertexSrcList) corners[element(src)] = (corners[element(src)] || 0) + 1;
    sites.set(key, {
      type: p.type,
      ...(p.type === 'centered' ? { centerAtom: p.centerIndex, centerElement: p.centerElement ?? element(p.centerIndex) } : {}),
      center,
      vertexCount: n,
      corners,
      cornerAtoms: [...new Set(p.vertexSrcList)],
      images: 1,
    });
  }
  return [...sites.values()];
}

/** Shortest periodic distance (Å) between fractional points p and q. */
function periodicDistance(p, q, lattice) {
  const d = [0, 1, 2].map((k) => { const x = p[k] - q[k]; return x - Math.round(x); });
  let best = Infinity;
  // Neighbouring images too: in a skewed cell the rounded difference is not always the shortest.
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
    best = Math.min(best, Math.hypot(...fracToCartPoint([d[0] + i, d[1] + j, d[2] + k], lattice)));
  }
  return best;
}

/** Largest supercell set_supercell makes (atoms): it must finish well inside the host timeout. */
export const MAX_HOST_SUPERCELL_ATOMS = 300000;

/** A void's neighbours: atom images within this factor of its nearest distance (the first shell). */
const VOID_SHELL_FACTOR = 1.15;
/** Grid maxima this close (Å) are one void (a flat maximum spans several grid points). */
const VOID_MERGE = 0.5;

/** Perpendicular widths of the cell (Å): how many cells a distance can reach along each axis. */
function cellWidths(lattice) {
  const [a, b, c] = lattice;
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const volume = Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
  return [cross(b, c), cross(c, a), cross(a, b)].map((n) => volume / Math.max(Math.hypot(...n), 1e-9));
}

/** Periodic images of fractional point q within `cutoff` Å of p (only the cells the cutoff can reach). */
function imagesWithin(p, q, lattice, cutoff, widths) {
  const d = [0, 1, 2].map((k) => { const x = q[k] - p[k]; return x - Math.round(x); });
  const reach = widths.map((w) => Math.ceil(cutoff / w));
  let count = 0;
  for (let i = -reach[0]; i <= reach[0]; i++) for (let j = -reach[1]; j <= reach[1]; j++) for (let k = -reach[2]; k <= reach[2]; k++) {
    if (Math.hypot(...fracToCartPoint([d[0] + i, d[1] + j, d[2] + k], lattice)) <= cutoff) count++;
  }
  return count;
}

/**
 * Interstitial sites of `structure`: the void centres of the cage search
 * (render/voidSearch.js), one per void, largest first. `total` counts them
 * all; the first `limit` come with the atoms around each. Both steps scale
 * with the cell (grid-maxima merge through a spatial hash, neighbours only for
 * the sites returned): an all-pairs version took minutes on a 3600-atom cell.
 * @param {any} structure
 * @param {number} minRadius smallest distance (Å) from a site to every atom
 * @param {number} [limit] how many sites to describe
 * @returns {{total: number, sites: Array<{position: number[], radius: number, neighbours: Record<string, number>}>}}
 */
export function voidSites(structure, minRadius, limit = Infinity) {
  const { lattice } = structure;
  const positions = structure.atoms.map((atom) => atom.position);
  const { voids } = findVoidCentres(lattice, positions, minRadius);
  voids.sort((p, q) => q.radius - p.radius);
  // Merge: bins at least VOID_MERGE wide along each axis, so a void only meets the sites in its own and adjacent bins.
  const widths = cellWidths(lattice);
  const bins = widths.map((w) => Math.max(1, Math.floor(w / VOID_MERGE)));
  const binOf = (f) => f.map((x, k) => Math.min(bins[k] - 1, Math.floor((x - Math.floor(x)) * bins[k])));
  /** @type {Map<string, number[][]>} */
  const byBin = new Map();
  const kept = [];
  for (const v of voids) {
    const [bi, bj, bk] = binOf(v.frac);
    let merged = false;
    const seen = new Set();
    for (let di = -1; di <= 1 && !merged; di++) for (let dj = -1; dj <= 1 && !merged; dj++) for (let dk = -1; dk <= 1 && !merged; dk++) {
      const key = `${(bi + di + bins[0]) % bins[0]},${(bj + dj + bins[1]) % bins[1]},${(bk + dk + bins[2]) % bins[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged = (byBin.get(key) || []).some((p) => periodicDistance(p, v.frac, lattice) < VOID_MERGE);
    }
    if (merged) continue;
    const key = `${bi},${bj},${bk}`;
    if (!byBin.has(key)) byBin.set(key, []);
    byBin.get(key).push(v.frac);
    kept.push(v);
  }
  const element = (i) => structure.atoms[i]?.getRepresentativeElement?.() ?? structure.elements?.[i] ?? '';
  const sites = kept.slice(0, limit).map((v) => {
    /** @type {Record<string, number>} */
    const neighbours = {};
    const cutoff = v.radius * VOID_SHELL_FACTOR;
    positions.forEach((p, i) => {
      const n = imagesWithin(v.frac, p, lattice, cutoff, widths);
      if (n) neighbours[element(i)] = (neighbours[element(i)] || 0) + n;
    });
    return { position: v.frac.map(wrap), radius: round(v.radius), neighbours };
  });
  return { total: kept.length, sites };
}

export function cameraState() {
  const camera = app.camera;
  const target = app.controls?.target;
  if (!camera || !target) return null;
  camera.updateMatrixWorld(true);
  const e = camera.matrixWorld.elements; // column 1 is the screen's up direction
  const offset = [camera.position.x - target.x, camera.position.y - target.y, camera.position.z - target.z];
  return {
    type: camera.isOrthographicCamera ? 'orthographic' : 'perspective',
    // Target to camera, the convention set_view takes: set_view c gives +c.
    direction: unit(offset),
    up: unit([e[4], e[5], e[6]]),
    target: [target.x, target.y, target.z].map(round),
    distance: round(Math.hypot(...offset)),
    zoom: round(camera.zoom),
  };
}

/**
 * What a command that made or selected a row reports, the same for all:
 * the row (structure: its id), its frames, the frame on show (activeFrame,
 * null when another row is shown), and that frame's atom count and revision.
 * @param {any} container
 */
export function rowEnvelope(container) {
  const active = getActiveStructure();
  const shownFrame = active ? container.structures.indexOf(active) : -1;
  const shown = shownFrame >= 0 ? active : (container.structures[0] ?? null);
  return {
    structure: getContainerId(container),
    name: String(container.fileName),
    frames: container.frameCount ?? container.structures.length,
    activeFrame: shownFrame >= 0 ? shownFrame : null,
    atomCount: shown ? shown.atoms.length : null,
    revision: shown ? structureRevision(shown) : null,
  };
}

/** What a structural edit reports: the active structure's atom count and its new revision. */
function structureEnvelope(structure = getActiveStructure()) {
  return { atomCount: structure ? structure.atoms.length : 0, revision: structure ? structureRevision(structure) : null };
}

/**
 * New positions (fractional, one per atom) or a new cell, committed as the
 * Modify Structure window commits an edit (setAtomGeometry): bonds and
 * polyhedra rebuilt, an open window's table updated. A failure is `code`.
 */
async function commitGeometry(structure, edit, code) {
  const { structureToTableAtoms } = await import('../ui/addToStructureModule/StructureEditorPanel.js');
  const { setAtomGeometry } = await import('../ui/addToStructureModule/CommitAtoms.js');
  try {
    setAtomGeometry(structure, structureToTableAtoms(structure), edit);
  } catch (error) {
    throw commandError(code, 'The edit could not be applied', { cause: safeError(error, code) });
  }
  uncommitted.delete(structure);
}

/**
 * Write fractional positions to every atom and redraw: the fast in-place path
 * (as MD streams frames), then the full rebuild (bonds, polyhedra) when the
 * fast path is unavailable or commit asks for it. Python's
 * update_fractional_positions, which streams many frames.
 */
function applyPositions(structure, positions, commit, deps) {
  for (let i = 0; i < positions.length; i++) structure.atoms[i].position = positions[i];
  let fastPathApplied = false;
  let fallbackReason;
  try {
    fastPathApplied = deps.applyFrameFast(structure) === true;
    if (!fastPathApplied) fallbackReason = 'FAST_PATH_UNAVAILABLE';
  } catch {
    fallbackReason = 'FAST_PATH_FAILED';
  }
  let rebuilt = false;
  if (!fastPathApplied || commit) {
    try {
      if (deps.commitPositions() === false) throw new Error('Full position commit was not applied');
    } catch (error) {
      throw commandError('POSITION_SYNC_FAILED', 'Position synchronization failed', {
        fallbackReason: fallbackReason || 'COMMIT_REQUESTED',
        cause: safeError(error, 'POSITION_SYNC_FAILED'),
      });
    }
    rebuilt = true;
  }
  if (rebuilt) uncommitted.delete(structure);
  else uncommitted.add(structure);
  return { fastPathApplied, rebuilt, ...(fallbackReason ? { fallbackReason } : {}) };
}

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);

/** A job starter's waitS: how long (0 to 25 s) the call waits for the job before returning it. */
function waitSeconds(input, name) {
  const waitS = input.waitS ?? 0;
  if (!isFiniteNumber(waitS) || waitS < 0 || waitS > 25) throw commandError('INVALID_ARGS', `${name}.waitS must be 0 to 25`);
  return waitS;
}

/** A job's `symmetry` argument: null (unconstrained), or the tolerance to lock at (null: the app's). */
function symmetryRequest(input, name) {
  const value = input.symmetry;
  if (value === undefined || value === false) return null;
  if (value === true) return { tolerance: null };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const tolerance = value.tolerance ?? null;
    if (tolerance !== null && !(isFiniteNumber(tolerance) && tolerance > 0)) {
      throw commandError('INVALID_ARGS', `${name}.symmetry.tolerance must be a positive number (Å)`);
    }
    return { tolerance };
  }
  throw commandError('INVALID_ARGS', `${name}.symmetry must be true or {tolerance}`);
}

/**
 * Lock the active structure to its symmetry before a symmetry-constrained job,
 * through the Symmetry window's own Wyckoff editor (the relaxer and MD keep a
 * locked structure's space group). A lock already on is kept as it is.
 * Returns what the job reports as `symmetry`, or null when not asked.
 */
async function lockSymmetry(request) {
  if (!request) return null;
  const structure = getActiveStructure();
  if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  const moyo = await import('../ui/BackendPanel/MoyoWASM.js');
  const { isWyckoffModeActive, defaultSymprec, describeMoyoFailure } = await import('../ui/SymmetryEditModule.js');
  if (isWyckoffModeActive(structure)) {
    const lock = structure.symmetry;
    return { constrained: true, number: lock.number, symbol: lock.spaceGroup, tolerance: lock.tolerance, lockedBefore: true };
  }
  const tolerance = request.tolerance ?? defaultSymprec();
  await moyo.ensureMoyoReady();
  try {
    const info = await moyo.enableWyckoffEditor(structure, tolerance);
    return { constrained: true, number: info.spg_number, symbol: info.spg_symbol, tolerance, lockedBefore: false };
  } catch (error) {
    throw commandError('SYMMETRY_UNAVAILABLE', `Cannot lock this structure's symmetry: ${describeMoyoFailure(error, tolerance)}`);
  }
}

/** The space group of the structure on show after a constrained job, against the one it was locked to. */
async function symmetryKept(symmetry) {
  const structure = getActiveStructure();
  const moyo = await import('../ui/BackendPanel/MoyoWASM.js');
  try {
    const info = moyo.callMoyo('getSymmetryInfo', symmetry.tolerance, structure);
    return { ...symmetry, kept: info.spg_number === symmetry.number, endNumber: info.spg_number, endSymbol: info.spg_symbol };
  } catch {
    return { ...symmetry, kept: false, endNumber: null, endSymbol: null };
  }
}

/** A started job as its starter returns it: at once, or once it ends within waitS. */
function started(job, waitS) {
  return waitS > 0 ? waitJob(job.id, waitS) : jobView(job);
}

/** A trajectory row a job made, as job results name it. */
function trajectoryOf(container, frames) {
  return { structure: getContainerId(container), name: String(container.fileName), frames };
}

// What a job reports while it runs and once it ends, the same for a host
// run_* and for a run started from its window (Relax, MD, EOS).

/** @param {{step: number, maxSteps: number, maxForce: number}} p a runRelax onProgress */
export function relaxProgress({ step, maxSteps, maxForce }) {
  return { step, maxSteps, fmax: round(maxForce) };
}

/** @param {{step: number, steps: number, temperatureK: number, text: string}} p a runMD onProgress */
export function mdProgress({ step, steps, temperatureK, text }) {
  return { step, steps, temperatureK: round(temperatureK), text };
}

/** A runRelax result as a job reports it (params as runRelax takes them). */
export function relaxJobResult(params, potential, result) {
  return {
    targetPressureGPa: params.targetPressure,
    relaxCell: params.relaxCell ?? true,
    potential: publicPotential(potential),
    trajectory: trajectoryOf(result.container, result.frames),
    steps: result.steps,
    converged: result.converged,
    stopped: result.stopped,
    fmax: round(result.maxForce),
    energy: round(result.energyEv),
    energyPerAtom: round(result.energyPerAtomEv),
    pressureGPa: result.pressureGPa === null ? null : round(result.pressureGPa),
  };
}

/** A runMD result as a job reports it. */
export function mdJobResult(potential, result) {
  return {
    potential: publicPotential(potential),
    trajectory: trajectoryOf(result.container, result.frames),
    finalStep: result.finalStep,
    stopped: result.stopped,
  };
}

/** A computeEOS scan and fit as a job reports it; no fit is a failed job. */
export function eosJobResult(scan, fit, byVolume, potential) {
  if (!fit) throw commandError(scan.volumes.length < 3 ? 'TOO_FEW_POINTS' : 'FIT_FAILED',
    scan.volumes.length < 3 ? `Only ${scan.volumes.length} point(s) computed; 3 are needed to fit`
      : 'The EOS fit could not run (it needs SciPy via Pyodide from the network); see the EOS window');
  const summary = eosFitSummary(fit);
  return {
    // Read first: false means the fit numbers are not a result (warnings say why).
    ...eosReliability(scan, summary.energyVolume),
    scan: { mode: byVolume ? 'volume' : 'pressure', points: scan.volumes.length, stopped: scan.stopped,
      unconverged: scan.converged.filter((c) => !c).length,
      volumes: scan.volumes.map(round), energies: scan.energies.map(round), pressuresGPa: scan.pressures.map(round) },
    fit: summary,
    potential: publicPotential(potential),
  };
}

/** get_state's sections: the active structure and renderer always, these on request. */
export const STATE_SECTIONS = Object.freeze(['structures', 'camera', 'selection', 'jobs', 'colors', 'phonons', 'field', 'windows']);
const DEFAULT_STATE_SECTIONS = ['camera', 'selection', 'jobs'];

/** The calculation tools' potential names, and the Atomistic window's for each. */
const POTENTIALS = Object.freeze({ nep: 'nep', 'pet-mad': 'mlip', ase: 'ase' });

/** The public name of one of the Atomistic window's potentials ('mlip' is pet-mad). */
export function publicPotential(potential) {
  return Object.keys(POTENTIALS).find((name) => POTENTIALS[name] === potential) ?? potential ?? null;
}

/** A run_*'s potential argument as the Atomistic window names it, or null (keep the window's choice). */
function potentialRequest(input, name) {
  if (input.potential === undefined) return null;
  if (!Object.hasOwn(POTENTIALS, input.potential)) {
    throw commandError('INVALID_ARGS', `${name}.potential must be one of ${Object.keys(POTENTIALS).join(', ')}`);
  }
  return POTENTIALS[input.potential];
}

/** Refuse a requested potential that cannot run: ASE without a connected server. */
function assertPotentialAvailable(atomistic, potential) {
  if (potential === 'ase' && !atomistic.aseConnected()) {
    throw commandError('POTENTIAL_UNAVAILABLE',
      'The ASE server is not connected: start python backend/server.py and press Connect in the Atomistic window');
  }
}

/**
 * Checks every calculator command makes before starting its job, then the
 * symmetry lock (symmetryRequest; null: none) and the requested potential
 * (null: the window's), picked as a click on the Atomistic window's "Choose
 * potential" does. Everything that can refuse comes first, so a refused call
 * changes nothing. Resolves to the Atomistic module and the job's symmetry.
 */
async function calculatorPrecheck(potential, symmetryAsked = null) {
  if (!getActiveStructure()) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
  assertNoJob();
  const atomistic = await import('../ui/BackendPanel/AtomisticPanels.js');
  // Refused here, not inside the job, so a structure too big fails this call.
  atomistic.assertStructureFitsPotential(potential ?? (general.atomisticPotential || 'nep'));
  assertPotentialAvailable(atomistic, potential);
  const symmetry = await lockSymmetry(symmetryAsked);
  if (potential) atomistic.selectPotential(potential);
  return { atomistic, symmetry };
}

/**
 * The EOS window's fit (fitEOS: E–V params [E0, V0, K0, K0'], P–V params
 * [V0, K0, K0'], K0 in GPa) as plain named numbers.
 * @param {{evResult: any, pvResult: any}} fit
 */
/**
 * Whether an EOS fit can be reported as a result, and why not. A fit to points
 * that did not converge, that do not bracket a minimum, or that lands outside
 * the scanned volumes is numbers, not a measurement.
 * @param {{volumes: number[], energies: number[], pressures: number[], converged: boolean[]}} scan
 * @param {{E0?: number, V0?: number, B0GPa?: number, B0Prime?: number, failed?: string}|null} ev the E(V) fit
 */
export function eosReliability(scan, ev) {
  const warnings = [];
  const unconverged = scan.converged.filter((c) => !c).length;
  if (unconverged) warnings.push(`${unconverged} of ${scan.converged.length} points did not converge (raise maxSteps or relax the start structure first)`);
  const order = scan.volumes.map((v, i) => i).sort((p, q) => scan.volumes[p] - scan.volumes[q]);
  const e = order.map((i) => scan.energies[i]);
  const v = order.map((i) => scan.volumes[i]);
  const lowest = e.indexOf(Math.min(...e));
  if (lowest === 0 || lowest === e.length - 1) {
    warnings.push('the lowest energy is at the edge of the scan: the minimum is not bracketed (shift or widen the range)');
  }
  const downhill = e.slice(0, lowest + 1).every((x, i, a) => i === 0 || x <= a[i - 1]);
  const uphill = e.slice(lowest).every((x, i, a) => i === 0 || x >= a[i - 1]);
  if (!downhill || !uphill) warnings.push('E(V) is not monotonic on either side of its minimum');
  if (scan.pressures.length && (scan.pressures.every((p) => p > 0) || scan.pressures.every((p) => p < 0))) {
    warnings.push('the pressure has one sign at every point: the scan does not include zero pressure, so the start structure is probably not relaxed');
  }
  if (!ev || ev.failed) {
    warnings.push(`the E(V) fit failed${ev?.failed ? `: ${ev.failed}` : ''}`);
  } else {
    if (!(ev.V0 >= v[0] && ev.V0 <= v[v.length - 1])) warnings.push(`V0 = ${ev.V0} lies outside the scanned volumes (${v[0]} to ${v[v.length - 1]})`);
    if (!(ev.B0GPa > 0)) warnings.push(`B0 = ${ev.B0GPa} GPa is not positive`);
    if (!(ev.B0Prime >= 1 && ev.B0Prime <= 15)) warnings.push(`B0' = ${ev.B0Prime} is outside the physical range (about 1 to 15)`);
  }
  return { fitReliable: warnings.length === 0, warnings };
}

export function eosFitSummary({ evResult, pvResult }) {
  const named = (r, keys) => (r ? {
    ...Object.fromEntries(keys.map((k, i) => [k, round(r.params[i])])),
    ...(r.failed ? { failed: r.failed } : {}),
    rms: r.fitStats ? round(r.fitStats.rms) : null,
  } : null);
  return {
    form: 'Birch–Murnaghan (3rd order)',
    energyVolume: named(evResult, ['E0', 'V0', 'B0GPa', 'B0Prime']),
    pressureVolume: named(pvResult, ['V0', 'B0GPa', 'B0Prime']),
  };
}

/**
 * Command handlers, keyed by the command name in commands.json. Each takes
 * (args, ctx): ctx.deps holds the app functions BrowserHost was configured
 * with, ctx.emit sends a host event, ctx.origin is the page's own origin.
 *
 * Names follow one rule: get_* and find read; set_* change the active
 * structure or view in place; build_* make a new row and select it; run_*
 * start a job; export_* and save_image write files. Atom-addressed commands
 * take atoms (indices) or selection (find id | "user" | "all") through
 * query.resolveTargets. Every result is an object; structural edits report
 * atomCount and revision, new rows rowEnvelope.
 */
export const COMMAND_HANDLERS = Object.freeze({
  async get_state(args, { deps }) {
    requireOptionalArgs(args, 'get_state');
    const include = args?.include ?? DEFAULT_STATE_SECTIONS;
    if (!Array.isArray(include) || include.some((section) => !STATE_SECTIONS.includes(section))) {
      throw commandError('INVALID_ARGS', `get_state.include takes ${STATE_SECTIONS.join(', ')}`);
    }
    const want = new Set(include);
    const structure = getActiveStructure();
    const state = {
      structure: structure ? structureState(structure) : null,
      renderer: typeof deps.getRenderPipeline === 'function' ? deps.getRenderPipeline() : null,
    };
    if (want.has('structures')) state.structures = getContainers().map((container) => snapshotForContainer(container, structure));
    if (want.has('camera')) state.camera = cameraState();
    if (want.has('selection')) {
      // What the user has selected in the window (atom-addressed commands also take selection: "user").
      const selected = structure ? await userSelection() : [];
      // origin: how the selection last changed. by "pick" is a click on one atom (atom),
      // others (marquee, focus-region, row-click, host, ...) select a group at once.
      const origin = selected.length ? await selectionOrigin() : null;
      // pick: bonds or polyhedra the user clicked (that replaces the atom selection);
      // saved: the user's named saved selections of this structure.
      const pick = structure ? await userPick() : null;
      const saved = structure ? await savedUserSelections() : [];
      state.selection = { count: selected.length, atoms: selected.slice(0, MAX_STATE_ATOMS),
        ...(selected.length > MAX_STATE_ATOMS ? { truncated: true } : {}), ...(origin ? { origin } : {}),
        ...(pick ? { pick } : {}),
        ...(saved.length ? { saved: saved.map((s) => ({ ...s, atoms: s.atoms.slice(0, MAX_STATE_ATOMS) })) } : {}) };
    }
    if (want.has('jobs')) state.jobs = listJobs();
    if (want.has('colors')) state.colors = structure ? colorSummary(structure) : null;
    if (want.has('phonons')) state.phonons = await tools.getPhononState();
    if (want.has('field')) state.field = structure ? await tools.getFieldInfo() : null;
    if (want.has('windows')) state.windows = await listWindows();
    return state;
  },

  async search_controls(args) {
    const input = requireArgs(args, 'search_controls');
    if (!safeName(input.query)) throw commandError('INVALID_ARGS', 'search_controls.query must be nonempty');
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw commandError('INVALID_ARGS', 'search_controls.limit must be 1 to 30');
    const controls = await searchControls(input.query, limit);
    return { count: controls.length, controls };
  },

  get_control(args) {
    return getControl(requireArgs(args, 'get_control').ref);
  },

  set_control(args) {
    const input = requireArgs(args, 'set_control');
    return setControl(input.ref, input.value);
  },

  click_control(args) {
    return clickControl(requireArgs(args, 'click_control').ref);
  },

  read_window(args) {
    return readWindow(requireArgs(args, 'read_window').panel);
  },

  find(args) {
    return find(requireArgs(args, 'find'), { polyhedraSummary, voidSites });
  },

  apply(args) {
    return apply(requireArgs(args, 'apply'));
  },

  get_bonding(args) {
    requireOptionalArgs(args, 'get_bonding');
    return getBonding();
  },

  get_symmetry(args) {
    requireOptionalArgs(args, 'get_symmetry');
    return tools.getSymmetry(args);
  },

  async export_structure(args, { origin }) {
    const input = requireArgs(args, 'export_structure');
    // From the host the text goes to its managed output URL (no IPC size limit); inline otherwise.
    const outputUrl = input.outputUrl === undefined ? null : managedOutputUrl(input.outputUrl, origin);
    const { text, ...result } = await exportStructure(input);
    if (!outputUrl) return { text, ...result };
    await uploadOutput(outputUrl, new Blob([text], { type: 'text/plain;charset=utf-8' }), 'text/plain; charset=utf-8');
    return result;
  },

  // ---- structure, in place ---------------------------------------------------------

  select_structure(args, { deps }) {
    const input = requireArgs(args, 'select_structure');
    const container = getContainerById(input.structure);
    if (!container) throw commandError('STRUCTURE_NOT_FOUND', `No structure ${input.structure}; get_state include structures lists them`);
    const frame = input.frame === undefined ? 0 : input.frame;
    const count = container.frameCount ?? container.structures.length;
    if (!Number.isInteger(frame) || frame < 0 || frame >= count) {
      throw commandError('FRAME_OUT_OF_RANGE', `select_structure.frame must be 0 to ${count - 1}`);
    }
    const rowIndex = getContainers().indexOf(container);
    if (!deps.selectStructure(rowIndex, frame)) throw commandError('SELECT_FAILED', 'Structure selection failed');
    return rowEnvelope(container);
  },

  async add_atoms(args) {
    const input = requireArgs(args, 'add_atoms');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    if (!Array.isArray(input.atoms) || input.atoms.length < 1 || input.atoms.length > 1000) {
      throw commandError('INVALID_ARGS', 'add_atoms.atoms must list 1 to 1000 atoms');
    }
    if (input.force !== undefined && typeof input.force !== 'boolean') throw commandError('INVALID_ARGS', 'add_atoms.force must be boolean');
    const rows = input.atoms.map((atom) => {
      const p = atom?.position;
      if (typeof atom?.element !== 'string' || !isVec3(p)) {
        throw commandError('INVALID_ARGS', 'add_atoms.atoms: every atom needs an element and a fractional position [x, y, z]');
      }
      const occupancy = atom.occupancy ?? 1;
      if (!isFiniteNumber(occupancy) || occupancy <= 0 || occupancy > 1) throw commandError('INVALID_ARGS', 'add_atoms.atoms: occupancy must be in (0, 1]');
      return { element: atom.element.trim(), x: p[0], y: p[1], z: p[2], occupancy };
    });
    const { invalidElementMessage } = await import('../ui/addToStructureModule/ElementValidation.js');
    const invalid = invalidElementMessage(rows);
    if (invalid) throw commandError('INVALID_ELEMENT', invalid);
    const { checkAddedAtomCollisions } = await import('../ui/addToStructureModule/AtomCollisionCheck.js');
    const { tooClose } = checkAddedAtomCollisions(structure, rows);
    if (tooClose.length && input.force !== true) {
      throw commandError('ATOMS_TOO_CLOSE', `${tooClose.length} pair(s) closer than 0.5 Å; move the atoms or pass force: true`,
        { tooClose: tooClose.slice(0, 10).map((t) => ({ ...t, distance: round(t.distance) })) });
    }
    const { commitAddedAtoms } = await import('../ui/addToStructureModule/CommitAtoms.js');
    commitAddedAtoms(structure, rows);
    return { added: rows.length, ...structureEnvelope(structure) };
  },

  async remove_atoms(args) {
    const input = requireArgs(args, 'remove_atoms');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    const indices = await resolveTargets(structure, input, 'remove_atoms');
    if (!indices.length) throw commandError('INVALID_ARGS', 'remove_atoms needs at least one atom');
    if (indices.length >= structure.atoms.length) throw commandError('INVALID_ARGS', 'remove_atoms cannot remove every atom');
    // What add_atoms needs to put them back.
    const removed = indices.sort((p, q) => p - q).map((i) => ({
      index: i,
      element: structure.atoms[i].getRepresentativeElement?.() ?? structure.elements[i],
      position: structure.atoms[i].position.map(round),
      occupancy: structure.atoms[i].getTotalOccupancy?.() ?? 1,
    }));
    const { commitRemovedAtoms } = await import('../ui/addToStructureModule/CommitAtoms.js');
    commitRemovedAtoms(structure, indices.map((i) => structure.atoms[i].uuid));
    return { removed, ...structureEnvelope(structure) };
  },

  async revert_structure(args) {
    requireOptionalArgs(args, 'revert_structure');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    // The Modify Structure window's "Revert Changes", without its confirm (a host call is not interactive).
    const { commitRevertToOriginal } = await import('../ui/addToStructureModule/CommitAtoms.js');
    if (!commitRevertToOriginal(structure)) throw commandError('NOTHING_TO_REVERT', 'This structure has no as-loaded state to go back to');
    return { reverted: true, ...structureEnvelope(structure) };
  },

  async set_element(args) {
    const input = requireArgs(args, 'set_element');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    if (typeof input.element !== 'string' || !input.element.trim()) throw commandError('INVALID_ARGS', 'set_element.element must be an element symbol');
    const element = input.element.trim();
    const { invalidElementMessage } = await import('../ui/addToStructureModule/ElementValidation.js');
    const invalid = invalidElementMessage([{ element }]);
    if (invalid) throw commandError('INVALID_ELEMENT', invalid);
    const indices = await resolveTargets(structure, input, 'set_element');
    if (!indices.length) throw commandError('INVALID_ARGS', 'set_element needs at least one atom');
    const disordered = indices.filter((i) => (structure.atoms[i].species?.length ?? 1) > 1);
    if (disordered.length) {
      throw commandError('DISORDERED', `Atoms ${disordered.slice(0, 10).join(', ')} are disordered sites; set their species in the structure editor`);
    }
    const { structureToTableAtoms } = await import('../ui/addToStructureModule/StructureEditorPanel.js');
    const { setAtomElements } = await import('../ui/addToStructureModule/CommitAtoms.js');
    setAtomElements(structure, indices, element, structureToTableAtoms(structure));
    return { changed: indices.length, element, ...structureEnvelope(structure) };
  },

  async move_atoms(args) {
    const input = requireArgs(args, 'move_atoms');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    const targets = await resolveTargets(structure, input, 'move_atoms');
    if ((input.to === undefined) === (input.by === undefined)) {
      throw commandError('INVALID_ARGS', 'move_atoms needs to (one [x, y, z] per atom) or by (one [dx, dy, dz] for all), not both');
    }
    if (input.cartesian !== undefined && typeof input.cartesian !== 'boolean') throw commandError('INVALID_ARGS', 'move_atoms.cartesian must be boolean');
    if (input.commit !== undefined && typeof input.commit !== 'boolean') throw commandError('INVALID_ARGS', 'move_atoms.commit must be boolean');
    if (input.cartesian && !Array.isArray(structure.lattice)) throw commandError('NO_LATTICE', 'Cartesian moves need a lattice');
    // Cartesian vectors (Å) to fractional; the map is linear, so it serves positions and shifts alike.
    const fractional = (v) => (input.cartesian ? cartToFractional(v, structure.lattice) : [...v]);
    const positions = structure.atoms.map((atom) => [...atom.position]);
    if (input.to !== undefined) {
      if (!Array.isArray(input.to) || input.to.length !== targets.length || !input.to.every(isVec3)) {
        throw commandError('INVALID_ARGS', `move_atoms.to needs one [x, y, z] per atom (${targets.length}), in the order of atoms`);
      }
      targets.forEach((i, k) => { positions[i] = fractional(input.to[k]); });
    } else {
      if (!isVec3(input.by)) throw commandError('INVALID_ARGS', 'move_atoms.by must be [dx, dy, dz]');
      const shift = fractional(input.by);
      for (const i of targets) positions[i] = positions[i].map((x, k) => x + shift[k]);
    }
    await commitGeometry(structure, { positions }, 'POSITION_SYNC_FAILED');
    // Always rebuilt now (commit is kept for old callers): committed stays true.
    return { moved: targets.length, committed: true, ...structureEnvelope(structure) };
  },

  async set_lattice(args) {
    const input = requireArgs(args, 'set_lattice');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    if (!Array.isArray(input.lattice) || input.lattice.length !== 3 || !input.lattice.every(isVec3)) {
      throw commandError('INVALID_ARGS', 'set_lattice.lattice must be exactly three rows of three finite numbers');
    }
    const lattice = input.lattice.map((row) => [...row]);
    const determinant = lattice[0][0] * (lattice[1][1] * lattice[2][2] - lattice[1][2] * lattice[2][1])
      - lattice[0][1] * (lattice[1][0] * lattice[2][2] - lattice[1][2] * lattice[2][0])
      + lattice[0][2] * (lattice[1][0] * lattice[2][1] - lattice[1][1] * lattice[2][0]);
    if (Math.abs(determinant) < 1e-12) {
      throw commandError('INVALID_ARGS', 'set_lattice.lattice must be nonsingular');
    }
    await commitGeometry(structure, { lattice }, 'LATTICE_SYNC_FAILED');
    return { lattice: latticeParameters(structure.lattice), ...structureEnvelope(structure) };
  },

  async set_supercell(args) {
    const input = requireArgs(args, 'set_supercell');
    const n = input.n;
    if (!Array.isArray(n) || n.length !== 3 || !n.every((k) => Number.isInteger(k) && k >= 1 && k <= 20)) {
      throw commandError('INVALID_ARGS', 'set_supercell.n must be three integers from 1 to 20');
    }
    const structure = getActiveStructure();
    if (!structure?.lattice) throw commandError('NO_LATTICE', 'The active structure has no lattice');
    // A host command must finish well inside its timeout, or the window is closed with
    // everything the user had open: 224 000 atoms build in ~6 s, a 20x20x20 of a big cell would not.
    const { supercellAtomCount } = await import('../ui/SuperCellModule.js');
    const atoms = supercellAtomCount(structure, n[0], n[1], n[2]);
    if (atoms > MAX_HOST_SUPERCELL_ATOMS) {
      throw commandError('TOO_LARGE', `A ${n.join('x')} supercell would have ${atoms} atoms; the limit here is ${MAX_HOST_SUPERCELL_ATOMS}`,
        { atoms, limit: MAX_HOST_SUPERCELL_ATOMS });
    }
    // The same path as the Cell & Supercell window and the feature search's "222".
    await (await import('../ui/LatticeSupercellPanel.js')).applySupercell(n[0], n[1], n[2]);
    return { supercell: n, ...structureEnvelope() };
  },

  // Python only ("mcp": false): the Viewer's released position API; MCP has move_atoms.
  update_fractional_positions(args, { deps }) {
    const input = requireArgs(args, 'update_fractional_positions');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    if (!Array.isArray(input.positions) || input.positions.length !== structure.atoms.length) {
      throw commandError('INVALID_ARGS', 'update_fractional_positions.positions must contain exactly one point per atom');
    }
    if (!input.positions.every(isVec3)) {
      throw commandError('INVALID_ARGS', 'update_fractional_positions.positions: every position must be exactly three finite numbers');
    }
    if (input.commit !== undefined && typeof input.commit !== 'boolean') {
      throw commandError('INVALID_ARGS', 'update_fractional_positions.commit must be boolean');
    }
    const result = applyPositions(structure, input.positions.map((point) => [...point]), input.commit === true, deps);
    return { ...result, ...structureEnvelope(structure) };
  },

  // Python only ("mcp": false): the full rebuild after update_fractional_positions with commit false.
  commit_positions(args, { deps }) {
    requireOptionalArgs(args, 'commit_positions');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    deps.commitPositions();
    uncommitted.delete(structure);
    return { committed: true, ...structureEnvelope(structure) };
  },

  // ---- new rows ----------------------------------------------------------------------

  build_slab(args) {
    return tools.buildSlabCommand(requireArgs(args, 'build_slab'));
  },

  build_symmetrized(args) {
    requireOptionalArgs(args, 'build_symmetrized');
    return tools.buildSymmetrized(args);
  },

  build_phonon_frames(args) {
    requireOptionalArgs(args, 'build_phonon_frames');
    return tools.buildPhononFrames(args);
  },

  // ---- view and display ----------------------------------------------------------------

  set_view(args, { deps }) {
    const input = requireArgs(args, 'set_view');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    const { direction: given, up: givenUp, zoom, cartesian = false, rotate, recenter } = input;
    if (given === undefined && givenUp === undefined && zoom === undefined && rotate === undefined && recenter === undefined) {
      throw commandError('INVALID_ARGS', 'set_view needs at least one of direction, up, zoom, rotate, recenter');
    }
    if (typeof cartesian !== 'boolean') throw commandError('INVALID_ARGS', 'set_view.cartesian must be boolean');
    if (zoom !== undefined && !(isFiniteNumber(zoom) && zoom > 0)) {
      throw commandError('INVALID_ARGS', 'set_view.zoom must be a positive number');
    }
    if (rotate !== undefined && !(rotate && typeof rotate === 'object' && ['x', 'y', 'z'].includes(rotate.axis) && isFiniteNumber(rotate.degrees))) {
      throw commandError('INVALID_ARGS', 'set_view.rotate must be {axis: x | y | z, degrees: number}');
    }
    if (recenter !== undefined && recenter !== true) throw commandError('INVALID_ARGS', 'set_view.recenter must be true');
    if (typeof deps.setViewDirection !== 'function') throw commandError('COMMAND_UNAVAILABLE', 'View direction is unavailable');
    // In order: aim (direction, up, zoom), then orbit, then recenter.
    if (given !== undefined || givenUp !== undefined || zoom !== undefined) {
      const direction = given === undefined ? null : viewDirection(given, structure.lattice, { cartesian });
      // up and zoom alone keep the direction the camera has now (and its pan: nothing is re-aimed).
      const along = direction ?? cameraState()?.direction;
      const up = givenUp === undefined ? undefined
        : screenUp(viewDirection(givenUp, structure.lattice, { cartesian, name: 'set_view.up' }), along);
      deps.setViewDirection(direction, { up, zoom });
    }
    if (rotate !== undefined) {
      if (typeof deps.rotateCamera !== 'function') throw commandError('COMMAND_UNAVAILABLE', 'Camera rotation is unavailable');
      deps.rotateCamera(rotate.degrees, rotate.axis);
    }
    if (recenter) deps.recenterCamera();
    return cameraState();
  },

  set_renderer(args, { deps }) {
    const input = requireArgs(args, 'set_renderer');
    if (typeof input.renderer !== 'string' || !PIPELINE_IDS.has(input.renderer)) {
      throw commandError('INVALID_ARGS', `set_renderer.renderer must be one of ${[...PIPELINE_IDS].join(', ')}`);
    }
    if (typeof deps.setRenderPipeline !== 'function') throw commandError('COMMAND_UNAVAILABLE', 'Renderer selection is unavailable');
    const activeId = deps.setRenderPipeline(input.renderer);
    if (typeof activeId !== 'string' || !PIPELINE_IDS.has(activeId)) {
      throw commandError('PIPELINE_FAILED', 'Renderer selection returned an invalid active id');
    }
    return { renderer: activeId };
  },

  set_phonon(args) {
    requireOptionalArgs(args, 'set_phonon');
    return tools.setPhonon(args);
  },

  set_isosurface(args) {
    return tools.setIsosurface(requireArgs(args, 'set_isosurface'));
  },

  add_plane(args) {
    return tools.addPlane(requireArgs(args, 'add_plane'));
  },

  // ---- jobs ------------------------------------------------------------------------------

  async run_md(args) {
    const input = args ?? {};
    requireOptionalArgs(args, 'run_md');
    const steps = input.steps ?? 500;
    if (!Number.isInteger(steps) || steps < 1 || steps > 100000) throw commandError('INVALID_ARGS', 'run_md.steps must be 1 to 100000');
    const temperatureK = input.temperatureK ?? 300;
    const saveStride = input.saveStride ?? 4;
    if (!Number.isInteger(saveStride) || saveStride < 1) throw commandError('INVALID_ARGS', 'run_md.saveStride must be a positive integer');
    const ensemble = input.ensemble ?? 'nvt';
    if (ensemble !== 'nvt' && ensemble !== 'npt') throw commandError('INVALID_ARGS', 'run_md.ensemble must be nvt or npt');
    for (const [name, value] of [['temperatureK', temperatureK], ['timestepFs', input.timestepFs], ['thermostatTauFs', input.thermostatTauFs]]) {
      if (value !== undefined && !(isFiniteNumber(value) && value > 0)) throw commandError('INVALID_ARGS', `run_md.${name} must be a positive number`);
    }
    if (input.pressureGPa !== undefined && !isFiniteNumber(input.pressureGPa)) throw commandError('INVALID_ARGS', 'run_md.pressureGPa must be a number');
    const waitS = waitSeconds(input, 'run_md');
    const symmetryAsked = symmetryRequest(input, 'run_md');
    const { atomistic, symmetry } = await calculatorPrecheck(potentialRequest(input, 'run_md'), symmetryAsked);
    const structure = getActiveStructure();
    const { recommendedTimestepFs } = await import('../atomistic/MD.js');
    const job = startJob('md', async (job) => {
      job.progress = { text: 'getting the potential ready' };
      const { runner, potential } = await atomistic.ensureActiveCalculator((text) => { job.progress = { text }; });
      const result = await atomistic.runMD({
        steps,
        dtFs: input.timestepFs ?? recommendedTimestepFs(structure.elements),
        startTemperatureK: temperatureK,
        useAnneal: false,
        useNpt: ensemble === 'npt',
        targetPressureGPa: input.pressureGPa ?? 0,
        thermostatTauFs: input.thermostatTauFs,
        saveStride,
      }, {
        runner,
        potential,
        shouldStop: () => job.cancelled,
        onProgress: (p) => { job.progress = mdProgress(p); },
      });
      return { ...mdJobResult(potential, result), ...(symmetry ? { symmetry: await symmetryKept(symmetry) } : {}) };
    });
    return started(job, waitS);
  },

  async run_relax(args) {
    const input = args ?? {};
    requireOptionalArgs(args, 'run_relax');
    const params = {
      forceTol: input.fmax ?? 0.01,
      maxSteps: input.maxSteps ?? 200,
      relaxCell: input.relaxCell ?? true,
      targetPressure: input.pressureGPa ?? 0,
      stressTol: input.pressureTolGPa ?? 0.2,
    };
    if (!(isFiniteNumber(params.forceTol) && params.forceTol > 0)) throw commandError('INVALID_ARGS', 'run_relax.fmax must be a positive number');
    if (!Number.isInteger(params.maxSteps) || params.maxSteps < 1 || params.maxSteps > 100000) throw commandError('INVALID_ARGS', 'run_relax.maxSteps must be 1 to 100000');
    if (typeof params.relaxCell !== 'boolean') throw commandError('INVALID_ARGS', 'run_relax.relaxCell must be boolean');
    if (!isFiniteNumber(params.targetPressure)) throw commandError('INVALID_ARGS', 'run_relax.pressureGPa must be a number');
    if (!(isFiniteNumber(params.stressTol) && params.stressTol > 0)) throw commandError('INVALID_ARGS', 'run_relax.pressureTolGPa must be a positive number');
    const waitS = waitSeconds(input, 'run_relax');
    const symmetryAsked = symmetryRequest(input, 'run_relax');
    const { atomistic, symmetry } = await calculatorPrecheck(potentialRequest(input, 'run_relax'), symmetryAsked);
    const pressureHint = namedPressureGPa(getContainerForStructure(getActiveStructure())?.fileName);
    const job = startJob('relax', async (job) => {
      job.progress = { text: 'getting the potential ready' };
      const { runner, potential } = await atomistic.ensureActiveCalculator((text) => { job.progress = { text }; });
      const result = await atomistic.runRelax(params, {
        runner,
        potential,
        shouldStop: () => job.cancelled,
        onProgress: (p) => { job.progress = relaxProgress(p); },
      });
      return {
        ...relaxJobResult(params, potential, result),
        ...(pressureHint !== null && pressureHint !== params.targetPressure
          ? { pressureHint: `The structure's name mentions ${pressureHint} GPa; this run used ${params.targetPressure} GPa (pressureGPa sets it).` }
          : {}),
        ...(symmetry ? { symmetry: await symmetryKept(symmetry) } : {}),
      };
    });
    return started(job, waitS);
  },

  async run_energy(args) {
    requireOptionalArgs(args, 'run_energy');
    const waitS = waitSeconds(args ?? {}, 'run_energy');
    const { atomistic } = await calculatorPrecheck(potentialRequest(args ?? {}, 'run_energy'));
    const job = startJob('energy', async (job) => {
      job.progress = { text: 'getting the potential ready' };
      const { runner, potential } = await atomistic.ensureActiveCalculator((text) => { job.progress = { text }; });
      const { out, maxForce, pressureGPa } = await atomistic.computeCurrentEFS(runner);
      return {
        potential: publicPotential(potential),
        energy: round(Number(out.total_energy)),
        energyPerAtom: round(Number(out.energy_per_atom)),
        fmax: round(maxForce),
        pressureGPa: pressureGPa === null ? null : round(pressureGPa),
      };
    });
    return started(job, waitS);
  },

  async run_eos(args) {
    const input = args ?? {};
    requireOptionalArgs(args, 'run_eos');
    const nPoints = input.points ?? 7;
    if (!Number.isInteger(nPoints) || nPoints < 3 || nPoints > 21) throw commandError('INVALID_ARGS', 'run_eos.points must be 3 to 21');
    const byVolume = input.volumeRangePct !== undefined;
    if (byVolume && !(isFiniteNumber(input.volumeRangePct) && input.volumeRangePct > 0 && input.volumeRangePct < 50)) {
      throw commandError('INVALID_ARGS', 'run_eos.volumeRangePct must be between 0 and 50');
    }
    const pMinGPa = input.pMinGPa ?? -2;
    const pMaxGPa = input.pMaxGPa ?? 20;
    if (!byVolume && !(isFiniteNumber(pMinGPa) && isFiniteNumber(pMaxGPa) && pMinGPa < pMaxGPa)) {
      throw commandError('INVALID_ARGS', 'run_eos needs pMinGPa < pMaxGPa, or volumeRangePct');
    }
    const waitS = waitSeconds(input, 'run_eos');
    const symmetryAsked = symmetryRequest(input, 'run_eos');
    // Every scan point relaxes the atoms through the relaxer, which keeps a locked structure's group.
    const { symmetry } = await calculatorPrecheck(potentialRequest(input, 'run_eos'), symmetryAsked);
    const job = startJob('eos', async (job) => {
      const { computeEOS } = await import('../ui/EOSPanel.js');
      const { scan, fit, potential } = await computeEOS({
        nPoints, pMinGPa, pMaxGPa, fmaxTol: input.fmax ?? 0.01, maxSteps: input.maxSteps ?? 200,
        ...(byVolume ? { volumeRangePct: input.volumeRangePct } : {}),
      }, {
        onProgress: (text) => { job.progress = { text }; },
        shouldStop: () => job.cancelled,
      });
      return { ...eosJobResult(scan, fit, byVolume, potential), ...(symmetry ? { symmetry } : {}) };
    });
    return started(job, waitS);
  },

  async run_ordering(args) {
    const input = args ?? {};
    requireOptionalArgs(args, 'run_ordering');
    const count = input.samples ?? 5;
    if (!Number.isInteger(count) || count < 1 || count > 30) throw commandError('INVALID_ARGS', 'run_ordering.samples must be 1 to 30');
    const multiplier = input.multiplier ?? 1;
    if (!Number.isInteger(multiplier) || multiplier < 1) throw commandError('INVALID_ARGS', 'run_ordering.multiplier must be a positive integer');
    const withEnergies = input.energies ?? true;
    if (typeof withEnergies !== 'boolean') throw commandError('INVALID_ARGS', 'run_ordering.energies must be boolean');
    const waitS = waitSeconds(input, 'run_ordering');
    const requested = potentialRequest(input, 'run_ordering');
    if (requested && !withEnergies) throw commandError('INVALID_ARGS', 'run_ordering.potential needs energies: true');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    assertNoJob();
    const panel = await import('../ui/LatticeSupercellPanel.js');
    // "Nothing to order" fails this call (zero samples is only the check); building the
    // samples can take long for a big multiplier, so that happens in the job.
    panel.buildOrderSamples(structure, 0, multiplier);
    if (requested) {
      const atomistic = await import('../ui/BackendPanel/AtomisticPanels.js');
      assertPotentialAvailable(atomistic, requested);
      atomistic.selectPotential(requested);
    }
    const job = startJob('order', async (job) => {
      job.progress = { text: `building ${count} ordered samples` };
      const samples = panel.buildOrderSamples(structure, count, multiplier);
      let potential = null;
      if (withEnergies) {
        ({ potential } = await panel.scoreOrderSamples(samples, {
          onProgress: (text) => { job.progress = { text }; },
          shouldStop: () => job.cancelled,
        }));
      }
      const { createTrajectoryFromFrames } = await import('../ui/addToStructureModule/CommitAtoms.js');
      const container = createTrajectoryFromFrames(panel.orderSampleFrames(samples), 'ordered_structures');
      return {
        potential: publicPotential(potential),
        trajectory: trajectoryOf(container, samples.length),
        atomsPerSample: samples[0].built.atoms.length,
        // Frame i of the trajectory is samples[i]; lowest energy first when computed.
        samples: samples.map((s, frame) => ({ frame, seed: s.seed, energyPerAtom: s.energyPerAtom === null ? null : round(s.energyPerAtom) })),
      };
    });
    return started(job, waitS);
  },

  wait_job(args) {
    const input = requireArgs(args, 'wait_job');
    const waitS = input.waitS ?? 20;
    // A wait ends well inside the controller's command timeout; 0 is a status check.
    if (!isFiniteNumber(waitS) || waitS < 0 || waitS > 25) throw commandError('INVALID_ARGS', 'wait_job.waitS must be 0 to 25');
    return waitJob(input.jobId, waitS);
  },

  cancel_job(args) {
    return cancelJob(requireArgs(args, 'cancel_job').jobId);
  },

  // ---- files: load, save_image (Python adds path/text and the managed upload) ---------

  async load(args, { deps, emit }) {
    const input = requireArgs(args, 'load');
    if (!safeName(input.name)) throw commandError('INVALID_ARGS', 'load.name must be nonempty');
    if (!isBufferData(input.data)) throw commandError('INVALID_ARGS', 'load.data must be text or binary data');
    if (input.format !== undefined && (!safeName(input.format) || input.format.includes('/'))) {
      throw commandError('INVALID_ARGS', 'load.format must be a nonempty format name');
    }
    requirePeriodicOption(input.periodic);
    if (input.interactive !== undefined && typeof input.interactive !== 'boolean') {
      throw commandError('INVALID_ARGS', 'load.interactive must be boolean');
    }
    const data = input.data instanceof Uint8Array
      ? input.data.buffer.slice(input.data.byteOffset, input.data.byteOffset + input.data.byteLength)
      : input.data;
    const result = await deps.loadStructure(data, input.name, false, input.format || '', {
      periodic: input.periodic, interactive: input.interactive,
    });
    if (result?.cancelled) throw commandError('LOAD_CANCELLED', 'Load cancelled by the user');
    const container = result?.container || null;
    if (!container) throw commandError('LOAD_FAILED', 'The structure loader returned no structure');
    emit('structure_loaded', snapshotForContainer(container, getActiveStructure()));
    const active = getActiveStructure();
    // The Cell & Supercell window restores a supercell it remembers for this structure: say so.
    const sc = active?.supercell;
    const restored = sc && ((sc.nx || 1) > 1 || (sc.ny || 1) > 1 || (sc.nz || 1) > 1)
      ? { supercell: [sc.nx || 1, sc.ny || 1, sc.nz || 1] } : null;
    return {
      ...rowEnvelope(container),
      formula: active ? composition(active.atoms).formula : null,
      ...(restored ? { restored } : {}),
    };
  },

  async save_image(args, { deps, origin }) {
    const input = requireArgs(args, 'save_image');
    const integerInRange = (value, min, max) => typeof value === 'number'
      && Number.isInteger(value) && value >= min && value <= max;
    for (const key of ['width', 'height']) {
      if (input[key] !== undefined && !integerInRange(input[key], 1, 16384)) {
        throw commandError('INVALID_ARGS', `save_image.${key} must be an integer from 1 through 16384`);
      }
    }
    if (input.maxSide !== undefined && !integerInRange(input.maxSide, 16, 16384)) {
      throw commandError('INVALID_ARGS', 'save_image.maxSide must be an integer from 16 through 16384');
    }
    if (input.width === undefined || input.height === undefined) {
      const view = (await import('../render/ImageExportModule.js')).mainExportSource().viewEl;
      Object.assign(input, fitImageSize({
        viewWidth: view?.clientWidth, viewHeight: view?.clientHeight, dpr: window.devicePixelRatio || 1,
        width: input.width, height: input.height, maxSide: input.maxSide,
      }));
    }
    if (!integerInRange(input.margin, 0, 4096)) {
      throw commandError('INVALID_ARGS', 'save_image.margin must be an integer from 0 through 4096');
    }
    if (input.margin * 2 >= input.width || input.margin * 2 >= input.height) {
      throw commandError('INVALID_ARGS', 'save_image.margin must be smaller than half of each dimension');
    }
    if (typeof input.transparent !== 'boolean') {
      throw commandError('INVALID_ARGS', 'save_image.transparent must be boolean');
    }
    if (typeof input.structureOnly !== 'boolean') {
      throw commandError('INVALID_ARGS', 'save_image.structureOnly must be boolean');
    }
    const format = input.format ?? 'png';
    if (format !== 'png' && format !== 'svg') throw commandError('INVALID_ARGS', 'save_image.format must be png or svg');
    if (input.vector !== undefined && (typeof input.vector !== 'boolean' || format !== 'svg')) {
      throw commandError('INVALID_ARGS', 'save_image.vector is a boolean for format svg');
    }
    const outputUrl = managedOutputUrl(input.outputUrl, origin);
    const options = {
      width: input.width, height: input.height, margin: input.margin,
      transparent: input.transparent, structureOnly: input.structureOnly,
    };
    // The Download Image window's own captures: PNG, or SVG with the structure as an
    // embedded image (labels, axes and colour bars editable) or, with vector, as shapes.
    const capture = format === 'svg' ? deps.captureSceneToSvg : deps.captureSceneToPng;
    if (typeof capture !== 'function') throw commandError('COMMAND_UNAVAILABLE', `${format.toUpperCase()} capture is unavailable`);
    // A size the GPU cannot hold fails with the app's own message, which says what it got.
    const blob = await capture(format === 'svg' ? { ...options, structure: input.vector ? 'vector' : 'raster' } : options);
    const contentType = format === 'svg' ? 'image/svg+xml' : 'image/png';
    if (!(blob instanceof Blob) || !blob.type.startsWith(contentType)) {
      throw commandError('CAPTURE_FAILED', `${format.toUpperCase()} capture did not return a ${contentType} Blob`);
    }
    await uploadOutput(outputUrl, blob, contentType);
    return { contentType, size: blob.size, width: input.width, height: input.height };
  },
});
