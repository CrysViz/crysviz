import {
  getActiveStructure,
  getContainerById,
  getContainerForStructure,
  getContainerId,
  getContainers,
  onActiveStructureChange,
} from '../state/structures.js';

const PROTOCOL_VERSION = 1;
const COMMANDS = new Set([
  'load',
  'list_structures',
  'select',
  'update_fractional_positions',
  'commit_positions',
  'recenter_camera',
]);
const EVENT_NAMES = new Set([
  'ready',
  'structure_loaded',
  'active_structure_changed',
  'error',
  'closed',
]);

function errorRecord(code, message, details = undefined) {
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

function safeError(error, fallbackCode = 'COMMAND_FAILED') {
  const code = typeof error?.code === 'string' ? error.code : fallbackCode;
  const message = String(error?.message || error || fallbackCode);
  const details = error?.details === undefined ? undefined : safeJsonValue(error.details);
  return errorRecord(code, message, details);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function errorFromThrown(error, fallbackCode = 'COMMAND_FAILED') {
  return safeError(error, fallbackCode);
}

function commandError(code, message, details = undefined) {
  /** @type {any} */
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function safeName(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBufferData(value) {
  return typeof value === 'string'
    || (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer)
    || (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array);
}

function snapshotForContainer(container, activeStructure) {
  const active = container?.structures.indexOf(activeStructure);
  return {
    id: getContainerId(container),
    name: String(container.fileName),
    frames: container.structures.length,
    active: active >= 0,
    activeFrame: active >= 0 ? active : null,
  };
}

function activeSnapshot() {
  const structure = getActiveStructure();
  const container = getContainerForStructure(structure);
  if (!container) return null;
  const frame = container.structures.indexOf(structure);
  return { id: getContainerId(container), frame };
}

function normalizeEvent(event, data = undefined) {
  if (!EVENT_NAMES.has(event)) return null;
  const record = { event };
  if (data !== undefined) {
    if (event === 'error') record.data = safeError(data);
    else if (event === 'ready') record.data = { protocolVersion: PROTOCOL_VERSION };
    else if (event === 'structure_loaded') record.data = {
      id: String(data.id), name: String(data.name), frames: Number(data.frames),
      active: data.active === true, activeFrame: data.activeFrame == null ? null : Number(data.activeFrame),
    };
    else if (event === 'active_structure_changed') record.data = {
      id: String(data.id), frame: Number(data.frame),
    };
  }
  return deepFreeze(record);
}

function sameOriginURL(value, origin) {
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url : null;
  } catch {
    return null;
  }
}

function removeQueryParameter(name) {
  const url = new URL(window.location.href);
  url.searchParams.delete(name);
  window.history.replaceState({}, document.title, url.toString());
}

/**
 * Build and install the frozen browser host facade. The returned controller is
 * intentionally private to the bootstrap coordinator; only the frozen facade
 * is put on window.
 */
/** @param {{loadStructure?: Function, selectStructure?: Function, applyFrameFast?: Function, commitPositions?: Function, recenterCamera?: Function}} [deps] */
export function createBrowserHost({
  loadStructure,
  selectStructure,
  applyFrameFast,
  commitPositions,
  recenterCamera,
} = {}) {
  const initialOrigin = window.location.origin;
  const subscribers = new Set();
  const replay = new Map();
  let bridgeCapability;
  let bridgeReceiver = null;
  let ready = false;
  let closed = false;

  function configure(next = {}) {
    if (typeof next.loadStructure === 'function') loadStructure = next.loadStructure;
    if (typeof next.selectStructure === 'function') selectStructure = next.selectStructure;
    if (typeof next.applyFrameFast === 'function') applyFrameFast = next.applyFrameFast;
    if (typeof next.commitPositions === 'function') commitPositions = next.commitPositions;
    if (typeof next.recenterCamera === 'function') recenterCamera = next.recenterCamera;
  }

  function captureBridgeReceiver() {
    if (bridgeReceiver) return;
    const api = window.pywebview?.api;
    if (!api || typeof api.receive_event !== 'function') return;
    const receiveEvent = api.receive_event;
    bridgeReceiver = (capability, record) => receiveEvent.call(api, capability, record);
  }

  window.addEventListener('pywebviewready', captureBridgeReceiver);
  captureBridgeReceiver();

  function forwardToBridge(record) {
    if (!bridgeCapability) return;
    if (!bridgeReceiver) return;
    let current;
    try {
      current = new URL(window.location.href);
    } catch {
      return;
    }
    if (current.origin !== initialOrigin
      || !/^https?:$/.test(current.protocol)
      || !['127.0.0.1', 'localhost'].includes(current.hostname)) return;
    try {
      const result = bridgeReceiver(bridgeCapability, record);
      Promise.resolve(result).catch(() => console.warn('CrysViz host bridge callback failed'));
    } catch {
      console.warn('CrysViz host bridge callback failed');
    }
  }

  function emit(event, data = undefined) {
    const record = normalizeEvent(event, data);
    if (!record) return;
    if (event === 'ready' || event === 'closed') replay.set(event, record);
    forwardToBridge(record);
    for (const callback of [...subscribers]) {
      try { callback(record); } catch (error) { console.error('CrysViz host subscriber failed', error); }
    }
  }

  function reportError(error, code = 'BOOTSTRAP_FAILED') {
    const normalized = errorFromThrown(error, code);
    emit('error', normalized);
    return normalized;
  }

  function listStructures() {
    const active = getActiveStructure();
    return getContainers().map((container) => snapshotForContainer(container, active));
  }

  function requireArgs(args, name) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw commandError('INVALID_ARGS', `${name} requires an object args value`);
    }
    return args;
  }

  async function execute(command, args) {
    switch (command) {
      case 'list_structures':
        if (args !== undefined) requireArgs(args, command);
        return listStructures();
      case 'load': {
        const input = requireArgs(args, command);
        if (!safeName(input.name)) throw commandError('INVALID_ARGS', 'load.name must be nonempty');
        if (!isBufferData(input.data)) throw commandError('INVALID_ARGS', 'load.data must be text or binary data');
        if (input.format !== undefined && (!safeName(input.format) || input.format.includes('/'))) {
          throw commandError('INVALID_ARGS', 'load.format must be a nonempty format name');
        }
        if (input.binary !== undefined && typeof input.binary !== 'boolean') {
          throw commandError('INVALID_ARGS', 'load.binary must be boolean');
        }
        const data = input.data instanceof Uint8Array
          ? input.data.buffer.slice(input.data.byteOffset, input.data.byteOffset + input.data.byteLength)
          : input.data;
        const result = await loadStructure(data, input.name, false, input.format || '');
        const container = result?.container || null;
        if (!container) throw commandError('LOAD_FAILED', 'The structure loader returned no structure');
        emit('structure_loaded', snapshotForContainer(container, getActiveStructure()));
        return { id: getContainerId(container), ...snapshotForContainer(container, getActiveStructure()) };
      }
      case 'select': {
        const input = requireArgs(args, command);
        const container = getContainerById(input.id);
        if (!container) throw commandError('STRUCTURE_NOT_FOUND', 'Unknown structure id');
        const frame = input.frame === undefined ? 0 : input.frame;
        if (!Number.isInteger(frame) || frame < 0 || frame >= container.structures.length) {
          throw commandError('FRAME_OUT_OF_RANGE', 'Structure frame is out of range');
        }
        const rowIndex = getContainers().indexOf(container);
        if (!selectStructure(rowIndex, frame)) throw commandError('SELECT_FAILED', 'Structure selection failed');
        return true;
      }
      case 'update_fractional_positions': {
        const input = requireArgs(args, command);
        const structure = getActiveStructure();
        if (!structure) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
        if (!Array.isArray(input.positions) || input.positions.length !== structure.atoms.length) {
          throw commandError('INVALID_POSITIONS', 'positions must contain exactly one point per atom');
        }
        const positions = input.positions.map((point) => {
          if (!Array.isArray(point) || point.length !== 3 || point.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
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
          fastPathApplied = applyFrameFast(structure) === true;
          if (!fastPathApplied) fallbackReason = 'FAST_PATH_UNAVAILABLE';
        } catch {
          fallbackReason = 'FAST_PATH_FAILED';
        }
        let rebuilt = false;
        if (!fastPathApplied || input.commit === true) {
          try {
            if (commitPositions() === false) throw new Error('Full position commit was not applied');
          } catch (error) {
            throw commandError('POSITION_SYNC_FAILED', 'Position synchronization failed', {
              fallbackReason: fallbackReason || 'COMMIT_REQUESTED',
              cause: safeError(error, 'POSITION_SYNC_FAILED'),
            });
          }
          rebuilt = true;
        }
        return { atomCount: positions.length, fastPathApplied, rebuilt, ...(fallbackReason ? { fallbackReason } : {}) };
      }
      case 'commit_positions':
        if (args !== undefined) requireArgs(args, command);
        if (!getActiveStructure()) throw commandError('NO_ACTIVE_STRUCTURE', 'No active structure');
        commitPositions();
        return true;
      case 'recenter_camera':
        if (args !== undefined) requireArgs(args, command);
        recenterCamera();
        return true;
      default:
        throw commandError('UNKNOWN_COMMAND', `Unknown host command: ${command}`);
    }
  }

  async function dispatchRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || typeof request.command !== 'string') {
      const error = errorRecord('INVALID_REQUEST', 'Request must contain a command string');
      emit('error', error);
      return { ok: false, error };
    }
    if (!COMMANDS.has(request.command)) {
      const error = errorRecord('UNKNOWN_COMMAND', `Unknown host command: ${request.command}`);
      emit('error', error);
      return { ok: false, error };
    }
    try {
      return { ok: true, result: await execute(request.command, request.args) };
    } catch (error) {
      const normalized = errorFromThrown(error);
      emit('error', normalized);
      return { ok: false, error: normalized };
    }
  }

  async function dispatch(request) {
    if (closed) return { ok: false, error: errorRecord('VIEWER_CLOSED', 'Viewer host is closed') };
    if (!ready) return { ok: false, error: errorRecord('NOT_READY', 'Viewer host is not ready') };
    return dispatchRequest(request);
  }

  const facade = Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    dispatch,
    subscribe(callback) {
      if (typeof callback !== 'function') return () => {};
      for (const event of ['ready', 'closed']) {
        const record = replay.get(event);
        if (record) {
          try { callback(record); } catch (error) { console.error('CrysViz host subscriber failed', error); }
        }
      }
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  });

  function install(capability = undefined) {
    bridgeCapability = capability;
    Object.defineProperty(window, 'crysvizHost', {
      value: facade,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return facade;
  }

  function markReady() {
    if (closed || ready) return;
    ready = true;
    emit('ready', { protocolVersion: PROTOCOL_VERSION });
  }

  function emitLoaded(container) {
    if (container) emit('structure_loaded', snapshotForContainer(container, getActiveStructure()));
  }

  function close() {
    if (closed) return;
    closed = true;
    emit('closed');
  }

  window.addEventListener('pagehide', close, { once: true });

  function getFacade() { return facade; }

  return {
    facade,
    configure,
    install,
    dispatchInternal: dispatchRequest,
    markReady,
    emit,
    emitLoaded,
    reportError,
    close,
    getFacade,
    setBridgeCapability(value) {
      bridgeCapability = typeof value === 'string' ? value : undefined;
      captureBridgeReceiver();
    },
    observeSelection: onActiveStructureChange((structure) => {
      const snapshot = activeSnapshot();
      if (snapshot) emit('active_structure_changed', snapshot);
    }),
    removeQueryParameter,
    sameOriginURL,
  };
}

function manifestError(code, message) {
  /** @type {any} */
  const error = new Error(message);
  error.code = code;
  return error;
}

async function responseOrThrow(response, code, message) {
  if (!response.ok) throw manifestError(code, `${message} (HTTP ${response.status})`);
  return response;
}

function strictFetch(url, options = {}) {
  return fetch(url, { ...options, redirect: 'error' });
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw manifestError('INVALID_MANIFEST', 'Host manifest must be an object');
  }
  const manifestKeys = Object.keys(manifest);
  if (manifestKeys.some((key) => !['version', 'inputs', 'bridgeCapability'].includes(key))) {
    throw manifestError('INVALID_MANIFEST', 'Host manifest contains an unknown field');
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.inputs)) {
    throw manifestError('INVALID_MANIFEST', 'Host manifest is not a valid version 1 manifest');
  }
  if (manifest.bridgeCapability !== undefined && typeof manifest.bridgeCapability !== 'string') {
    throw manifestError('INVALID_MANIFEST', 'Host manifest bridgeCapability must be a string');
  }
  return manifest.inputs.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw manifestError('INVALID_MANIFEST', 'Host manifest input must be an object');
    }
    if (Object.keys(input).some((key) => !['url', 'name', 'format', 'binary'].includes(key))) {
      throw manifestError('INVALID_MANIFEST', 'Host manifest input contains an unknown field');
    }
    if (!safeName(input.name) || typeof input.url !== 'string') {
      throw manifestError('INVALID_MANIFEST', 'Host manifest input requires url and name');
    }
    const url = sameOriginURL(input.url, window.location.origin);
    if (!url || url.username || url.password) {
      throw manifestError('INVALID_MANIFEST', 'Host manifest input URL must be same-origin');
    }
    if (input.format !== undefined && (!safeName(input.format) || input.format.includes('/'))) {
      throw manifestError('INVALID_MANIFEST', 'Host manifest input format must be a nonempty format name');
    }
    if (input.binary !== undefined && typeof input.binary !== 'boolean') {
      throw manifestError('INVALID_MANIFEST', 'Host manifest input binary must be boolean');
    }
    return { url, name: input.name, format: input.format, binary: input.binary === true };
  });
}

function completionError(original, completion) {
  return Object.assign(manifestError(
    'MANIFEST_COMPLETE_FAILED',
    'Could not complete host manifest',
  ), {
    details: {
      original: errorFromThrown(original, 'BOOTSTRAP_FAILED'),
      completion: errorFromThrown(completion, 'MANIFEST_COMPLETE_FAILED'),
    },
  });
}

/** @param {{host: any, launch: {present:boolean, capability:string|null}, initialize: Function, loadShared?: Function, loadHash?: Function, loadDefault?: Function}} deps */
export async function bootstrapAuthoritative(deps) {
  const { host, launch, initialize } = deps;
  if (launch?.present) {
    const capability = launch.capability;
    host.setBridgeCapability(undefined);
    const route = `${window.location.origin}/_crysviz/manifest/${encodeURIComponent(capability)}`;
    let terminalCompletionPosted = false;
    const postCompletion = async (body) => {
      if (terminalCompletionPosted) throw manifestError('MANIFEST_COMPLETE_FAILED', 'Host manifest completion was already posted');
      terminalCompletionPosted = true;
      try {
        const response = await strictFetch(`${route}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        await responseOrThrow(response, 'MANIFEST_COMPLETE_FAILED', 'Could not complete host manifest');
      } catch (error) {
        if (error?.code === 'MANIFEST_COMPLETE_FAILED') throw error;
        const wrapped = manifestError('MANIFEST_COMPLETE_FAILED', 'Could not complete host manifest');
        wrapped.details = { cause: errorFromThrown(error, 'MANIFEST_COMPLETE_FAILED') };
        throw wrapped;
      }
    };
    try {
      const initialized = await initialize();
      const response = await responseOrThrow(
        await strictFetch(route), 'MANIFEST_FETCH_FAILED', 'Could not fetch host manifest');
      const manifest = await response.json();
      const inputs = validateManifest(manifest);
      host.setBridgeCapability(typeof manifest.bridgeCapability === 'string' ? manifest.bridgeCapability : undefined);
      for (const input of inputs) {
        const inputResponse = await responseOrThrow(
          await strictFetch(input.url), 'INPUT_FETCH_FAILED', `Could not fetch host input ${input.name}`);
        const data = input.binary ? await inputResponse.arrayBuffer() : await inputResponse.text();
        const result = await host.dispatchInternal({
          command: 'load',
          args: { name: input.name, data, format: input.format, binary: input.binary },
        });
        if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
      }
      if (inputs.length === 0) {
        const loadDefault = initialized?.loadDefault || deps.loadDefault;
        if (typeof loadDefault !== 'function') {
          throw manifestError('DEFAULT_LOAD_UNAVAILABLE', 'The built-in default structure loader is unavailable');
        }
        await loadDefault();
      }
      await postCompletion({ ok: true });
      return { source: 'host' };
    } catch (error) {
      if (!terminalCompletionPosted) {
        const original = errorFromThrown(error, 'BOOTSTRAP_FAILED');
        try {
          await postCompletion({ ok: false, error: original });
        } catch (completeError) {
          throw completionError(original, completeError);
        }
      }
      throw error;
    }
  }

  const initialized = await initialize();
  const loadShared = initialized?.loadShared || deps.loadShared;
  const loadHash = initialized?.loadHash || deps.loadHash;
  const loadDefault = initialized?.loadDefault || deps.loadDefault;

  if (new URLSearchParams(window.location.search).has('state')) {
    const result = await loadShared();
    if (!result) throw manifestError('SHARED_STATE_FAILED', 'Shared state was present but could not be loaded');
    return { source: 'shared' };
  }
  if (window.location.hash.startsWith('#load-file=')) {
    const result = await loadHash();
    if (!result) throw manifestError('HASH_LOAD_FAILED', 'The load-file hash was present but could not be loaded');
    return { source: 'hash' };
  }
  await loadDefault();
  return { source: 'default' };
}
