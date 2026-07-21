// @ts-nocheck
/**
 * Dedicated NEP force-evaluation worker (classic worker, not a module one).
 *
 * The NEP wasm glue is a plain script that declares `var NEPModule` at top
 * level and nep_simple.js hangs `NEPWasmRunner` off `window` — neither is an ES
 * module, so this has to be importScripts + a `window` alias rather than the
 * module worker used by computeWorker.js.
 *
 * Why a worker at all: one evaluation of a ~1300-atom cell is the single
 * biggest cost in an MD step by a wide margin. On the main thread it blocks
 * paint, so the render of frame N and the compute of frame N+1 run one after
 * the other and the viewer stutters at exactly the rate the physics advances.
 * Off-thread they overlap: wall-clock per step drops to the slower of the two
 * instead of their sum, and the UI keeps painting (and stays responsive to
 * camera drags) while the potential is being evaluated.
 *
 * Message in:  { reqId, type: 'init', base }
 *              { reqId, type: 'compute', lattice, positions: Float64Array, types: Int32Array }
 * Message out: { reqId, result } | { reqId, error }
 * Positions in and forces out travel as transferred Float64Arrays.
 */

// nep_simple.js reads window.NEPModule and writes window.NEPWasmRunner.
self.window = self;

let runner = null;
// types only change when the structure does; re-uploading them every step is
// pure waste, so the last set is cached and reused until it differs.
let cachedTypes = null;

async function handleInit(base) {
  self.importScripts(`${base}nep_wasm.js`, `${base}nep_simple.js`);
  // Emscripten derives its asset directory from document.currentScript, which
  // does not exist in a worker — it falls back to the worker's own URL and then
  // fetches /workers/nep_wasm.wasm, gets the dev server's 404 page and dies on
  // the MIME type. Point locateFile at the real directory instead.
  const moduleFactory = self.NEPModule;
  runner = new self.NEPWasmRunner({
    defaultModelUrl: `${base}nep89_20250409.txt`,
    moduleFactory: (options) => moduleFactory({ ...options, locateFile: (path) => `${base}${path}` }),
  });
  await runner.init();
  const info = await runner.loadDefaultModel();
  return { elementList: info.element_list, name: info.name };
}

function handleCompute({ lattice, positions, types }) {
  if (!runner) throw new Error('nepWorker: compute before init');
  const n = positions.length / 3;
  if (types) cachedTypes = Array.from(types);
  if (!cachedTypes || cachedTypes.length !== n) {
    throw new Error('nepWorker: types missing for this atom count');
  }

  const asRows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    asRows[i] = [positions[o], positions[o + 1], positions[o + 2]];
  }

  const out = runner.compute({ lattice, positions: asRows, types: cachedTypes });

  const forces = new Float64Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const f = out.forces[i];
    const o = i * 3;
    forces[o] = f[0];
    forces[o + 1] = f[1];
    forces[o + 2] = f[2];
  }
  return {
    forces,
    total_energy: out.total_energy,
    stress: out.stress,
  };
}

self.onmessage = async (event) => {
  const { reqId, type } = event.data;
  try {
    if (type === 'init') {
      const result = await handleInit(event.data.base);
      self.postMessage({ reqId, result });
      return;
    }
    if (type === 'compute') {
      const result = handleCompute(event.data);
      self.postMessage({ reqId, result }, [result.forces.buffer]);
      return;
    }
    throw new Error(`nepWorker: unknown message type ${type}`);
  } catch (error) {
    self.postMessage({ reqId, error: error?.message || String(error) });
  }
};
