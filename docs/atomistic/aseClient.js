/**
 * The ASE compute server (backend/server.py) as a calculator. `ASERunner` has
 * the surface of MLIPRunner / WorkerMLIPRunner (init, modelInfo, compute,
 * destroy, supportsStress, offThread), so EFS, relaxation, MD, EOS and phonons
 * run with whatever ASE calculator the server holds (MACE, PET-MAD in PyTorch,
 * Orb, SevenNet, ...) exactly as they do with the in-browser potentials.
 *
 * A server may offer several models (protocol 3: `models` in info, `select`
 * to load one); setModel() picks which one compute() uses.
 *
 * One Socket.IO request per evaluation, answered through the acknowledgement:
 * atomic numbers, positions and forces travel as binary arrays, so a step
 * costs the model's time plus a couple of milliseconds on localhost.
 */

import { loadSocketIO } from '../external/socket.io-loader.js';
import { SYMBOLS } from '../io/ulm.js';

export const DEFAULT_ASE_URL = 'http://localhost:5001';
// Protocol 3 added several models per server; a protocol 2 server (one model)
// still works.
const PROTOCOLS = [2, 3];
const CONNECT_TIMEOUT_MS = 3000;
// Loading a model can mean downloading its weights first.
const SELECT_TIMEOUT_MS = 20 * 60 * 1000;
// A large cell on a CPU-only server can take minutes per evaluation.
const COMPUTE_TIMEOUT_MS = 30 * 60 * 1000;

/** [xx, yy, zz, yz, xz, xy] (ASE Voigt) -> the runners' { matrix3x3, voigt }. */
function stressFromVoigt(voigt) {
  if (!Array.isArray(voigt) || voigt.length < 6) {
    return { matrix3x3: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], voigt: [0, 0, 0, 0, 0, 0], available: false };
  }
  const [xx, yy, zz, yz, xz, xy] = voigt;
  return { matrix3x3: [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]], voigt: [xx, yy, zz, yz, xz, xy], available: true };
}

export class ASERunner {
  /** @param {{ url?: string }} [options] */
  constructor(options = {}) {
    this.url = options.url || DEFAULT_ASE_URL;
    /** { name, element_list } once connected; element_list[i] has Z = i + 1. */
    this.modelInfo = null;
    /** The server's info reply: models, default, device, dtype, threads. */
    this.serverInfo = null;
    /**
     * Models the server offers: { id, label, loaded, elements, dtype, error }.
     * @type {{ id: string, label: string, loaded: boolean, elements: string[]|null, dtype: string|null, error?: string|null }[]}
     */
    this.models = [];
    /** The model compute() uses (an id of `models`; null on a protocol 2 server). @type {string|null} */
    this.modelId = null;
    /** Elements the current model has parameters for, when the server knows. @type {string[]|null} */
    this.modelElements = null;
    // ASE reports stress tension-positive like the other runners.
    this.supportsStress = true;
    // The evaluation runs elsewhere: MD yields with a macrotask, not a paint.
    this.offThread = true;
    /** @type {any} */
    this._socket = null;
    /** @type {((reason: string) => void)|null} */
    this.onDisconnect = null;
    this.lastTimings = null;
  }

  get connected() {
    return !!this._socket?.connected;
  }

  /** Connect and read the server's model; resolves with modelInfo. */
  async init() {
    if (this.connected && this.modelInfo) return this.modelInfo;
    const { io } = await loadSocketIO();
    const socket = io(this.url, {
      // WebSocket only: long polling adds a request per message.
      transports: ['websocket'],
      reconnection: false,
      timeout: CONNECT_TIMEOUT_MS,
    });
    this._socket = socket;
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', (/** @type {Error} */ error) => {
        reject(new Error(`no ASE server at ${this.url} (${error.message || error}). `
          + 'Start it with: python backend/server.py'));
      });
    }).catch((error) => {
      socket.close();
      this._socket = null;
      throw error;
    });
    socket.on('disconnect', (/** @type {string} */ reason) => {
      this.modelInfo = null;
      this.onDisconnect?.(reason);
    });
    const info = await socket.timeout(CONNECT_TIMEOUT_MS * 10).emitWithAck('info');
    if (!info || info.server !== 'crysviz-ase') {
      this.destroy();
      throw new Error(`${this.url} is not a CrysViz ASE server`);
    }
    if (!PROTOCOLS.includes(info.protocol)) {
      this.destroy();
      throw new Error(`the ASE server at ${this.url} speaks protocol ${info.protocol}, this page ${PROTOCOLS.join(' or ')}: `
        + 'update backend/server.py and the page to the same version');
    }
    this.serverInfo = info;
    this.models = Array.isArray(info.models) ? info.models
      : [{ id: '', label: info.model, loaded: true, elements: info.elements ?? null, dtype: info.dtype }];
    this.modelId = info.protocol >= 3 ? info.default : null;
    this._adopt(this.models.find((m) => m.id === (this.modelId ?? '')) || this.models[0]);
    return this.modelInfo;
  }

  /** The current model as modelInfo (name for status lines, every element). */
  _adopt(model) {
    this.modelInfo = {
      name: `${model.label} (${this.serverInfo.device}, ${model.dtype || this.serverInfo.dtype})`,
      // Every element, as for PET-MAD: the server (or compute's check of the
      // model's own list) says which it cannot do.
      element_list: SYMBOLS.slice(1),
    };
    this.modelElements = Array.isArray(model.elements) && model.elements.length ? model.elements : null;
  }

  /**
   * Switch to another model the server offers; the server loads it first if
   * needed (which can take minutes when it downloads weights).
   * @param {string} id
   */
  async setModel(id) {
    if (!this.connected || !this.serverInfo) throw new Error('ASE server not connected');
    if (this.modelId === null || id === this.modelId) return this.modelInfo;
    if (!this.models.some((m) => m.id === id)) {
      throw new Error(`the ASE server at ${this.url} does not offer ${id}; it offers ${this.models.map((m) => m.id).join(', ')}`);
    }
    const reply = await this._socket.timeout(SELECT_TIMEOUT_MS).emitWithAck('select', { model: id });
    if (!reply || reply.error) throw new Error(`ASE server: ${reply?.error || 'no answer'}`);
    this.models = this.models.map((m) => (m.id === id ? { ...m, ...reply } : m));
    this.modelId = id;
    this._adopt(reply);
    return this.modelInfo;
  }

  /**
   * Energy, forces and stress from the server (same contract as
   * MLIPRunner.compute): positions Cartesian (Å), lattice rows a, b, c, types
   * index modelInfo.element_list.
   * @param {{ lattice: number[][], positions: number[][], types: number[] }} structure
   */
  async compute(structure) {
    if (!this.connected || !this.modelInfo) {
      throw new Error(`ASE server not connected (${this.url}). Connect it in the ASE controls.`);
    }
    const { lattice, positions, types } = structure;
    const n = positions.length;
    const flat = new Float64Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      flat[i * 3] = positions[i][0];
      flat[i * 3 + 1] = positions[i][1];
      flat[i * 3 + 2] = positions[i][2];
    }
    const numbers = Int32Array.from(types, (t) => t + 1);
    if (this.modelElements) {
      const known = new Set(this.modelElements);
      const missing = [...new Set(Array.from(numbers, (z) => SYMBOLS[z]))].filter((e) => !known.has(e));
      if (missing.length) throw new Error(`${this.modelInfo.name} has no parameters for ${missing.join(', ')}`);
    }
    const cell = [...lattice[0], ...lattice[1], ...lattice[2]];
    const t0 = performance.now();
    /** @type {Record<string, any>} */
    const request = { numbers: numbers.buffer, positions: flat.buffer, cell, pbc: true, stress: true };
    if (this.modelId !== null) request.model = this.modelId;
    const reply = await this._socket.timeout(COMPUTE_TIMEOUT_MS).emitWithAck('compute', request);
    if (!reply || reply.error) throw new Error(`ASE server: ${reply?.error || 'no answer'}`);
    const f = new Float64Array(reply.forces);
    if (f.length !== n * 3) throw new Error(`ASE server returned ${f.length / 3} forces for ${n} atoms`);
    const forces = new Array(n);
    for (let i = 0; i < n; i += 1) forces[i] = [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
    this.lastTimings = { serverMs: reply.ms, roundTripMs: performance.now() - t0 };
    return {
      total_energy: reply.energy,
      energy_per_atom: reply.energy / n,
      forces,
      stress: stressFromVoigt(reply.stress),
    };
  }

  /** Close the connection. */
  destroy() {
    const socket = this._socket;
    this._socket = null;
    this.modelInfo = null;
    if (socket) {
      socket.off('disconnect');
      socket.close();
    }
  }
}

export default ASERunner;
