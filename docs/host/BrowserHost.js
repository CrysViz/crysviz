import {
  getActiveStructure,
  getContainerForStructure,
  getContainerId,
  onActiveStructureChange,
} from '../state/structures.js';
import { LOAD_HASH_RE } from '../io/SessionReceiver.js';
import { structureContent } from '../model/structureRevision.js';
import {
  COMMAND_HANDLERS,
  checkExpectedRevision,
  commandError,
  errorRecord,
  requirePeriodicOption,
  responseOrThrow,
  safeError,
  safeName,
  sameOriginURL,
  snapshotForContainer,
  strictFetch,
} from './commands.js';

const PROTOCOL_VERSION = 1;
const EVENT_NAMES = new Set([
  'ready',
  'structure_loaded',
  'active_structure_changed',
  'error',
  'closed',
]);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function errorFromThrown(error, fallbackCode = 'COMMAND_FAILED') {
  return safeError(error, fallbackCode);
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
/** @param {{loadStructure?: Function, selectStructure?: Function, applyFrameFast?: Function, commitPositions?: Function, updateLattice?: Function, recenterCamera?: Function, rotateCamera?: Function, setViewDirection?: Function, setRenderPipeline?: Function, getRenderPipeline?: Function, requestRender?: Function, captureSceneToPng?: Function}} [initialDeps] */
export function createBrowserHost(initialDeps = {}) {
  const initialOrigin = window.location.origin;
  const subscribers = new Set();
  const replay = new Map();
  /** @type {Record<string, any>} the app functions the command handlers call */
  const deps = { ...initialDeps };
  let bridgeCapability;
  let bridgeReceiver = null;
  let ready = false;
  let closed = false;

  function configure(next = {}) {
    for (const [name, value] of Object.entries(next)) {
      if (typeof value === 'function') deps[name] = value;
    }
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

  async function dispatchRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || typeof request.command !== 'string') {
      const error = errorRecord('INVALID_REQUEST', 'Request must contain a command string');
      emit('error', error);
      return { ok: false, error };
    }
    if (!Object.hasOwn(COMMAND_HANDLERS, request.command)) {
      const error = errorRecord('UNKNOWN_COMMAND', `Unknown host command: ${request.command}`);
      emit('error', error);
      return { ok: false, error };
    }
    // A command that changed the structure without saying so (crysviz:atoms-changed) is
    // announced here, so open windows that mirror it, such as the structure editor, follow.
    const before = getActiveStructure();
    const beforeContent = before ? structureContent(before) : null;
    let announced = false;
    const heard = () => { announced = true; };
    document.addEventListener('crysviz:atoms-changed', heard);
    try {
      const ctx = { deps, emit, origin: window.location.origin };
      let args = request.args;
      // Any command may carry expectedRevision (get_state's structure.revision):
      // it runs only if the structure is still the one the caller looked at.
      if (args && typeof args === 'object' && !Array.isArray(args) && 'expectedRevision' in args) {
        const { expectedRevision, ...rest } = args;
        checkExpectedRevision(expectedRevision);
        args = rest;
      }
      return { ok: true, result: await COMMAND_HANDLERS[request.command](args, ctx) };
    } catch (error) {
      const normalized = errorFromThrown(error);
      emit('error', normalized);
      return { ok: false, error: normalized };
    } finally {
      document.removeEventListener('crysviz:atoms-changed', heard);
      if (!announced && before && getActiveStructure() === before && structureContent(before) !== beforeContent) {
        document.dispatchEvent(new CustomEvent('crysviz:atoms-changed'));
      }
      // The app redraws on demand, asked by a catch-all on the user's DOM
      // events (render/AnimateModule.js wireRenderOnDemand). A host command
      // has no such event, so it asks once itself, or a change it made (a
      // colour, a highlight) would show only on the user's next click.
      deps.requestRender?.();
    }
  }

  async function dispatch(request) {
    if (closed) return { ok: false, error: errorRecord('VIEWER_CLOSED', 'Viewer host is closed') };
    if (!ready) return { ok: false, error: errorRecord('NOT_READY', 'Viewer host is not ready') };
    return dispatchRequest(request);
  }

  // This is the sole Python-to-browser trigger. Python never interpolates a
  // command or data into JavaScript: the descriptor arrives through the
  // capability-protected pywebview API and binary content is fetched through
  // an exact loopback capability URL.
  async function processBridgeCommand() {
    captureBridgeReceiver();
    const api = window.pywebview?.api;
    if (!bridgeCapability || !api
      || typeof api.next_command !== 'function' || typeof api.command_result !== 'function') return;
    let descriptor;
    try {
      descriptor = await api.next_command(bridgeCapability);
      if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.request
        || typeof descriptor.request !== 'object') return;
      const request = descriptor.request;
      if (request.args?.inputUrl !== undefined) {
        if (request.command === 'load') requirePeriodicOption(request.args.periodic);
        const inputUrl = sameOriginURL(request.args.inputUrl, window.location.origin);
        if (!inputUrl || inputUrl.username || inputUrl.password) {
          throw commandError('INVALID_INPUT_URL', 'Managed input URL must be same-origin');
        }
        const response = await strictFetch(inputUrl);
        await responseOrThrow(response, 'INPUT_FETCH_FAILED', 'Could not fetch managed host input');
        // A Blob, as the file picker hands over: loadStructure reads it by its
        // detected format, so a random-access CHGCAR or WAVECAR is never made
        // one string (Chromium returns '' from text() past ~512 MiB).
        request.args = { ...request.args, data: await response.blob() };
        delete request.args.inputUrl;
      }
      const result = await dispatch(request);
      await api.command_result(bridgeCapability, descriptor.id, result);
    } catch (error) {
      const result = { ok: false, error: errorFromThrown(error, 'HOST_COMMAND_FAILED') };
      try {
        if (descriptor?.id) await api.command_result(bridgeCapability, descriptor.id, result);
      } catch { /* Parent will time out and poison the host. */ }
    }
  }

  const facade = Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    dispatch,
    processBridgeCommand,
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

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw commandError('INVALID_MANIFEST', 'Host manifest must be an object');
  }
  const manifestKeys = Object.keys(manifest);
  if (manifestKeys.some((key) => !['version', 'inputs', 'bridgeCapability'].includes(key))) {
    throw commandError('INVALID_MANIFEST', 'Host manifest contains an unknown field');
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.inputs)) {
    throw commandError('INVALID_MANIFEST', 'Host manifest is not a valid version 1 manifest');
  }
  if (manifest.bridgeCapability !== undefined && typeof manifest.bridgeCapability !== 'string') {
    throw commandError('INVALID_MANIFEST', 'Host manifest bridgeCapability must be a string');
  }
  return manifest.inputs.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw commandError('INVALID_MANIFEST', 'Host manifest input must be an object');
    }
    if (Object.keys(input).some((key) => !['url', 'name', 'format', 'binary'].includes(key))) {
      throw commandError('INVALID_MANIFEST', 'Host manifest input contains an unknown field');
    }
    if (!safeName(input.name) || typeof input.url !== 'string') {
      throw commandError('INVALID_MANIFEST', 'Host manifest input requires url and name');
    }
    const url = sameOriginURL(input.url, window.location.origin);
    if (!url || url.username || url.password) {
      throw commandError('INVALID_MANIFEST', 'Host manifest input URL must be same-origin');
    }
    if (input.format !== undefined && (!safeName(input.format) || input.format.includes('/'))) {
      throw commandError('INVALID_MANIFEST', 'Host manifest input format must be a nonempty format name');
    }
    if (input.binary !== undefined && typeof input.binary !== 'boolean') {
      throw commandError('INVALID_MANIFEST', 'Host manifest input binary must be boolean');
    }
    return { url, name: input.name, format: input.format, binary: input.binary === true };
  });
}

function completionError(original, completion) {
  return Object.assign(commandError(
    'MANIFEST_COMPLETE_FAILED',
    'Could not complete host manifest',
  ), {
    details: {
      original: errorFromThrown(original, 'BOOTSTRAP_FAILED'),
      completion: errorFromThrown(completion, 'MANIFEST_COMPLETE_FAILED'),
    },
  });
}

// Whether this session was launched by the desktop host (a _crysviz_manifest
// capability in the launch URL; host/early.js strips it before anything else
// runs). The Share dialog reads it: a desktop session is served from
// 127.0.0.1, which a share link must not name.
let launchedByHost = false;

/** True when the desktop/CLI host launched this session. */
export function wasLaunchedByHost() {
  return launchedByHost;
}

// A share link carries its payload in the fragment (#z= / #q=, ui/ShareModule.js).
const SHARE_FRAGMENT = /^#(z|q)=/;

/** @param {{host: any, launch: {present:boolean, capability:string|null}, initialize: Function, loadShared?: Function, loadHash?: Function, loadDefault?: Function}} deps */
export async function bootstrapAuthoritative(deps) {
  const { host, launch, initialize } = deps;
  launchedByHost = !!launch?.present;
  // Opening a share link in a tab that already shows CrysViz only changes the
  // fragment, which browsers treat as same-document navigation: no reload, so
  // the link would do nothing. Reload so it boots like a fresh open. The app's
  // own URL cleanup uses history.replaceState, which fires no hashchange.
  window.addEventListener('hashchange', () => {
    if (SHARE_FRAGMENT.test(window.location.hash)) window.location.reload();
  });
  if (launch?.present) {
    const capability = launch.capability;
    host.setBridgeCapability(undefined);
    const route = `${window.location.origin}/_crysviz/manifest/${encodeURIComponent(capability)}`;
    let terminalCompletionPosted = false;
    const postCompletion = async (body) => {
      if (terminalCompletionPosted) throw commandError('MANIFEST_COMPLETE_FAILED', 'Host manifest completion was already posted');
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
        const wrapped = commandError('MANIFEST_COMPLETE_FAILED', 'Could not complete host manifest');
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
        const result = await host.dispatchInternal({
          command: 'load',
          args: { name: input.name, data: await inputResponse.blob(), format: input.format, binary: input.binary },
        });
        if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
      }
      if (inputs.length === 0) {
        const loadDefault = initialized?.loadDefault || deps.loadDefault;
        if (typeof loadDefault !== 'function') {
          throw commandError('DEFAULT_LOAD_UNAVAILABLE', 'The built-in default structure loader is unavailable');
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

  // Share links: #z= / #q= in the fragment, or one of the pre-#144 query forms
  // (?z= deflated, ?state= plain, ?e= encrypted). ShareModule owns them all and
  // loadShared() picks whichever is present (encrypted ones prompt for the
  // password).
  const query = new URLSearchParams(window.location.search);
  if (SHARE_FRAGMENT.test(window.location.hash)
    || query.has('state') || query.has('z') || query.has('e')) {
    const result = await loadShared();
    if (!result) throw commandError('SHARED_STATE_FAILED', 'Shared state was present but could not be loaded');
    return { source: 'shared' };
  }
  if (LOAD_HASH_RE.test(window.location.hash)) {
    const result = await loadHash();
    if (result === 'cancelled') throw commandError('LOAD_CANCELLED', 'Load cancelled by the user');
    if (!result) throw commandError('HASH_LOAD_FAILED', 'The load hash was present but could not be loaded');
    return { source: 'hash' };
  }
  await loadDefault();
  return { source: 'default' };
}
