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
import { cancelJob, getJob, jobView, listJobs, runningJob, startJob, waitJob } from './jobs.js';
import { cartToFractional, fracToCartPoint } from '../math/index.js';
import { findVoidCentres } from '../render/voidSearch.js';
import { clickControl, getControl, searchControls, setControl } from './controls.js';

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
    || (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array);
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

/** Max atoms get_state lists with atoms:true, so a big supercell stays small. */
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

function structureState(structure, includeAtoms) {
  const container = getContainerForStructure(structure);
  const frame = container ? container.structures.indexOf(structure) : -1;
  const lattice = Array.isArray(structure.lattice) && structure.lattice.length === 3 ? structure.lattice : null;
  const { counts, formula } = composition(structure.atoms);
  const state = {
    id: container ? getContainerId(container) : null,
    name: container ? String(container.fileName) : null,
    frame: frame >= 0 ? frame : null,
    frames: container ? container.structures.length : 1,
    atomCount: structure.atoms.length,
    formula,
    composition: counts,
    periodic: structure.periodic !== false,
    lattice: lattice ? { vectors: lattice.map((row) => row.map(round)), ...latticeParameters(lattice) } : null,
    positionsCommitted: !uncommitted.has(structure),
  };
  if (includeAtoms) {
    state.atoms = structure.atoms.slice(0, MAX_STATE_ATOMS).map((atom) => ({
      element: atom.getRepresentativeElement?.() ?? atom.species?.[0]?.element ?? '',
      position: atom.position.map(round),
    }));
    state.atomsTruncated = structure.atoms.length > MAX_STATE_ATOMS;
  }
  return state;
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

/** A void's neighbours: atom images within this factor of its nearest distance (the first shell). */
const VOID_SHELL_FACTOR = 1.15;

/** Periodic images of fractional point q within `cutoff` Å of p. */
function imagesWithin(p, q, lattice, cutoff) {
  const d = [0, 1, 2].map((k) => { const x = q[k] - p[k]; return x - Math.round(x); });
  let count = 0;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) {
    if (Math.hypot(...fracToCartPoint([d[0] + i, d[1] + j, d[2] + k], lattice)) <= cutoff) count++;
  }
  return count;
}

/**
 * Interstitial sites of `structure`: the void centres of the cage search
 * (render/voidSearch.js), one per void, largest first, with the atoms around
 * each.
 * @param {any} structure
 * @param {number} minRadius smallest distance (Å) from a site to every atom
 */
export function voidSites(structure, minRadius) {
  const positions = structure.atoms.map((atom) => atom.position);
  const { voids } = findVoidCentres(structure.lattice, positions, minRadius);
  voids.sort((p, q) => q.radius - p.radius);
  const element = (i) => structure.atoms[i]?.getRepresentativeElement?.() ?? structure.elements?.[i] ?? '';
  const sites = [];
  for (const v of voids) {
    // Grid points of one void (a flat maximum, or its periodic copy) merge into the largest.
    if (sites.some((s) => periodicDistance(s.position, v.frac, structure.lattice) < 0.5)) continue;
    /** @type {Record<string, number>} */
    const neighbours = {};
    positions.forEach((p, i) => {
      const n = imagesWithin(v.frac, p, structure.lattice, v.radius * VOID_SHELL_FACTOR);
      if (n) neighbours[element(i)] = (neighbours[element(i)] || 0) + n;
    });
    sites.push({ position: v.frac.map(wrap), radius: round(v.radius), neighbours });
  }
  return sites;
}

function cameraState() {
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
 * Command handlers, keyed by the command name in commands.json. Each takes
 * (args, ctx): ctx.deps holds the app functions BrowserHost was configured
 * with, ctx.emit sends a host event, ctx.origin is the page's own origin.
 */
export const COMMAND_HANDLERS = Object.freeze({
  list_structures(args) {
    requireOptionalArgs(args, 'list_structures');
    const active = getActiveStructure();
    return getContainers().map((container) => snapshotForContainer(container, active));
  },

  get_state(args, { deps }) {
    requireOptionalArgs(args, 'get_state');
    const includeAtoms = args?.atoms ?? false;
    if (typeof includeAtoms !== 'boolean') throw commandError('INVALID_ARGS', 'get_state.atoms must be boolean');
    const structure = getActiveStructure();
    return {
      structureCount: getContainers().length,
      structure: structure ? structureState(structure, includeAtoms) : null,
      camera: cameraState(),
      renderPipeline: typeof deps.getRenderPipeline === 'function' ? deps.getRenderPipeline() : null,
      jobs: listJobs(),
    };
  },

  search_controls(args) {
    const input = requireArgs(args, 'search_controls');
    if (!safeName(input.query)) throw commandError('INVALID_ARGS', 'search_controls.query must be nonempty');
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw commandError('INVALID_ARGS', 'search_controls.limit must be 1 to 30');
    return searchControls(input.query, limit);
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

  get_polyhedra(args) {
    requireOptionalArgs(args, 'get_polyhedra');
    const type = args?.type;
    if (type !== undefined && type !== 'cage' && type !== 'centered') {
      throw commandError('INVALID_ARGS', 'get_polyhedra.type must be cage or centered');
    }
    const limit = args?.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw commandError('INVALID_ARGS', 'get_polyhedra.limit must be 1 to 500');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    const built = (structure.polyhedra?.polyhedra?.length ?? 0) > 0;
    const sites = polyhedraSummary(structure, type);
    return {
      built,
      detectCages: structure.polyhedraSettings?.detectCages !== false,
      total: sites.length,
      polyhedra: sites.slice(0, limit),
      ...(built ? {} : { hint: 'No polyhedra are built: switch on Show Polyhedra (search_controls "polyhedra on"), then call again.' }),
    };
  },

  get_voids(args) {
    requireOptionalArgs(args, 'get_voids');
    const limit = args?.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw commandError('INVALID_ARGS', 'get_voids.limit must be 1 to 100');
    const minRadius = args?.minRadius ?? 0.7;
    if (!isFiniteNumber(minRadius) || minRadius <= 0) throw commandError('INVALID_ARGS', 'get_voids.minRadius must be a positive number');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    if (!Array.isArray(structure.lattice) || structure.periodic === false) throw commandError('NO_LATTICE', 'Voids need a periodic structure');
    const sites = voidSites(structure, minRadius);
    return { total: sites.length, voids: sites.slice(0, limit) };
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
      if (typeof atom?.element !== 'string' || !Array.isArray(p) || p.length !== 3 || !p.every(isFiniteNumber)) {
        throw commandError('INVALID_ARGS', 'Every atom needs an element and a fractional position [x, y, z]');
      }
      const occupancy = atom.occupancy ?? 1;
      if (!isFiniteNumber(occupancy) || occupancy <= 0 || occupancy > 1) throw commandError('INVALID_ARGS', 'occupancy must be in (0, 1]');
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
    return { added: rows.length, atomCount: structure.atoms.length };
  },

  async build_supercell(args) {
    const input = requireArgs(args, 'build_supercell');
    const n = input.n;
    if (!Array.isArray(n) || n.length !== 3 || !n.every((k) => Number.isInteger(k) && k >= 1 && k <= 20)) {
      throw commandError('INVALID_ARGS', 'build_supercell.n must be three integers from 1 to 20');
    }
    if (!getActiveStructure()?.lattice) throw commandError('NO_LATTICE', 'The active structure has no lattice');
    // The same path as the Cell & Supercell window and the feature search's "222".
    await (await import('../ui/LatticeSupercellPanel.js')).applySupercell(n[0], n[1], n[2]);
    return { supercell: n, atomCount: getActiveStructure()?.atoms.length ?? 0 };
  },

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
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    const busy = runningJob('md');
    if (busy) throw commandError('JOB_BUSY', `MD job ${busy.id} is still running; wait for it or cancel_job`);
    const atomistic = await import('../ui/BackendPanel/AtomisticPanels.js');
    const { recommendedTimestepFs } = await import('../atomistic/MD.js');
    // Refused here, not inside the job, so a structure too big fails this call.
    atomistic.assertStructureFitsPotential(general.atomisticPotential || 'nep');
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
        onProgress: ({ step, temperatureK: t, text }) => { job.progress = { step, steps, temperatureK: round(t), text }; },
      });
      return {
        potential,
        trajectory: { id: getContainerId(result.container), name: String(result.container.fileName), frames: result.frames },
        finalStep: result.finalStep,
        stopped: result.stopped,
      };
    });
    return jobView(job);
  },

  job_status(args) {
    return jobView(getJob(requireArgs(args, 'job_status').jobId));
  },

  wait_job(args) {
    const input = requireArgs(args, 'wait_job');
    const timeoutS = input.timeoutS ?? 20;
    // The controller times a command out at 30 s; a wait must end before that.
    if (!isFiniteNumber(timeoutS) || timeoutS < 0 || timeoutS > 25) throw commandError('INVALID_ARGS', 'wait_job.timeoutS must be 0 to 25');
    return waitJob(input.jobId, timeoutS);
  },

  cancel_job(args) {
    return cancelJob(requireArgs(args, 'cancel_job').jobId);
  },

  async load(args, { deps, emit }) {
    const input = requireArgs(args, 'load');
    if (!safeName(input.name)) throw commandError('INVALID_ARGS', 'load.name must be nonempty');
    if (!isBufferData(input.data)) throw commandError('INVALID_ARGS', 'load.data must be text or binary data');
    if (input.format !== undefined && (!safeName(input.format) || input.format.includes('/'))) {
      throw commandError('INVALID_ARGS', 'load.format must be a nonempty format name');
    }
    if (input.binary !== undefined && typeof input.binary !== 'boolean') {
      throw commandError('INVALID_ARGS', 'load.binary must be boolean');
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
    return { id: getContainerId(container), ...snapshotForContainer(container, getActiveStructure()) };
  },

  select(args, { deps }) {
    const input = requireArgs(args, 'select');
    const container = getContainerById(input.id);
    if (!container) throw commandError('STRUCTURE_NOT_FOUND', 'Unknown structure id');
    const frame = input.frame === undefined ? 0 : input.frame;
    if (!Number.isInteger(frame) || frame < 0 || frame >= container.structures.length) {
      throw commandError('FRAME_OUT_OF_RANGE', 'Structure frame is out of range');
    }
    const rowIndex = getContainers().indexOf(container);
    if (!deps.selectStructure(rowIndex, frame)) throw commandError('SELECT_FAILED', 'Structure selection failed');
    return true;
  },

  update_fractional_positions(args, { deps }) {
    const input = requireArgs(args, 'update_fractional_positions');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    if (!Array.isArray(input.positions) || input.positions.length !== structure.atoms.length) {
      throw commandError('INVALID_POSITIONS', 'positions must contain exactly one point per atom');
    }
    const positions = input.positions.map((point) => {
      if (!Array.isArray(point) || point.length !== 3 || point.some((value) => !isFiniteNumber(value))) {
        throw commandError('INVALID_POSITIONS', 'Every position must be exactly three finite numbers');
      }
      return [...point];
    });
    if (input.commit !== undefined && typeof input.commit !== 'boolean') {
      throw commandError('INVALID_ARGS', 'commit must be boolean');
    }
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
    if (!fastPathApplied || input.commit === true) {
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
    return { atomCount: positions.length, fastPathApplied, rebuilt, ...(fallbackReason ? { fallbackReason } : {}) };
  },

  async update_lattice(args, { deps }) {
    const input = requireArgs(args, 'update_lattice');
    if (!getActiveStructure()) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    if (!Array.isArray(input.lattice) || input.lattice.length !== 3
      || input.lattice.some((row) => !Array.isArray(row) || row.length !== 3 || row.some((value) => !isFiniteNumber(value)))) {
      throw commandError('INVALID_LATTICE', 'lattice must be exactly three rows of three finite numbers');
    }
    const lattice = input.lattice.map((row) => [...row]);
    const determinant = lattice[0][0] * (lattice[1][1] * lattice[2][2] - lattice[1][2] * lattice[2][1])
      - lattice[0][1] * (lattice[1][0] * lattice[2][2] - lattice[1][2] * lattice[2][0])
      + lattice[0][2] * (lattice[1][0] * lattice[2][1] - lattice[1][1] * lattice[2][0]);
    if (Math.abs(determinant) < 1e-12) {
      throw commandError('INVALID_LATTICE', 'lattice must be nonsingular');
    }
    if (typeof deps.updateLattice !== 'function') {
      throw commandError('COMMAND_UNAVAILABLE', 'Lattice update is unavailable');
    }
    try {
      if (await deps.updateLattice(lattice) !== true) throw new Error('Lattice update was not applied');
    } catch (error) {
      throw commandError('LATTICE_SYNC_FAILED', 'Lattice synchronization failed', {
        cause: safeError(error, 'LATTICE_SYNC_FAILED'),
      });
    }
    return true;
  },

  commit_positions(args, { deps }) {
    requireOptionalArgs(args, 'commit_positions');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    deps.commitPositions();
    uncommitted.delete(structure);
    return true;
  },

  recenter_camera(args, { deps }) {
    requireOptionalArgs(args, 'recenter_camera');
    deps.recenterCamera();
    return true;
  },

  rotate_camera(args, { deps }) {
    const input = requireArgs(args, 'rotate_camera');
    if (!isFiniteNumber(input.angleDegrees)) {
      throw commandError('INVALID_ARGS', 'rotate_camera.angleDegrees must be a finite number');
    }
    if (!['x', 'y', 'z'].includes(input.axis)) {
      throw commandError('INVALID_ARGS', 'rotate_camera.axis must be x, y, or z');
    }
    if (typeof deps.rotateCamera !== 'function') throw commandError('COMMAND_UNAVAILABLE', 'Camera rotation is unavailable');
    deps.rotateCamera(input.angleDegrees, input.axis);
    return true;
  },

  set_view(args, { deps }) {
    const input = requireArgs(args, 'set_view');
    const structure = getActiveStructure();
    if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
    if (input.cartesian !== undefined && typeof input.cartesian !== 'boolean') {
      throw commandError('INVALID_ARGS', 'set_view.cartesian must be boolean');
    }
    if (input.zoom !== undefined && !(isFiniteNumber(input.zoom) && input.zoom > 0)) {
      throw commandError('INVALID_ARGS', 'set_view.zoom must be a positive number');
    }
    const cartesian = input.cartesian === true;
    const direction = viewDirection(input.direction, structure.lattice, { cartesian });
    const up = input.up === undefined ? undefined
      : screenUp(viewDirection(input.up, structure.lattice, { cartesian, name: 'set_view.up' }), direction);
    if (typeof deps.setViewDirection !== 'function') throw commandError('COMMAND_UNAVAILABLE', 'View direction is unavailable');
    deps.setViewDirection(direction, { up, zoom: input.zoom });
    return { direction, ...(up ? { up } : {}) };
  },

  set_render_pipeline(args, { deps }) {
    const input = requireArgs(args, 'set_render_pipeline');
    if (typeof input.pipelineId !== 'string' || !PIPELINE_IDS.has(input.pipelineId)) {
      throw commandError('INVALID_PIPELINE', 'Unknown rendering pipeline');
    }
    if (typeof deps.setRenderPipeline !== 'function') throw commandError('COMMAND_UNAVAILABLE', 'Pipeline selection is unavailable');
    const activeId = deps.setRenderPipeline(input.pipelineId);
    if (typeof activeId !== 'string' || !PIPELINE_IDS.has(activeId)) {
      throw commandError('PIPELINE_FAILED', 'Pipeline selection returned an invalid active id');
    }
    return activeId;
  },

  async save_image(args, { deps, origin }) {
    const input = requireArgs(args, 'save_image');
    const integerInRange = (value, min, max) => typeof value === 'number'
      && Number.isInteger(value) && value >= min && value <= max;
    if (!integerInRange(input.width, 1, 16384) || !integerInRange(input.height, 1, 16384)) {
      throw commandError('INVALID_ARGS', 'save_image dimensions must be integers from 1 through 16384');
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
    if (typeof deps.captureSceneToPng !== 'function') throw commandError('COMMAND_UNAVAILABLE', 'PNG capture is unavailable');
    const outputUrl = sameOriginURL(input.outputUrl, origin);
    if (!outputUrl || outputUrl.username || outputUrl.password || outputUrl.search || outputUrl.hash
      || outputUrl.href !== input.outputUrl
      || !/^\/_crysviz\/output\/[A-Za-z0-9_-]{32,}$/.test(outputUrl.pathname)) {
      throw commandError('INVALID_OUTPUT_URL', 'Managed output URL is invalid');
    }
    const blob = await deps.captureSceneToPng({
      width: input.width, height: input.height, margin: input.margin,
      transparent: input.transparent, structureOnly: input.structureOnly,
    });
    if (!(blob instanceof Blob) || blob.type !== 'image/png') {
      throw commandError('CAPTURE_FAILED', 'PNG capture did not return an image/png Blob');
    }
    const response = await strictFetch(outputUrl, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob,
    });
    await responseOrThrow(response, 'OUTPUT_UPLOAD_FAILED', 'Could not upload managed PNG');
    return { contentType: 'image/png', size: blob.size };
  },
});
