// MLIPRunner — ES-module adapter around the vendored mlip.js (mlip.cpp) WASM
// bindings, exposing the same interface the CrysViz app already consumes from
// NEPWasmRunner (docs/external/nep_wasm/nep_simple.js):
//
//   runner.modelInfo.element_list : string[]  (symbol -> type index via buildNEPStructure)
//   await runner.compute({ lattice, positions, types })
//       -> { total_energy, energy_per_atom, forces: Nx3, stress: { matrix3x3, voigt } }
//
// Unlike NEP, mlip.js is pure ESM, so this adapter dynamic-imports the loader
// directly (no window-global / loadScript hack). Models are PET-MAD GGUF weights
// fetched at runtime from Hugging Face and cached in the browser Cache API.
//
// ---------------------------------------------------------------------------
// Verified conventions (node smoke tests: mlip.js@0.1.1, then the source-built
// 0.1.2 vendored here — see ./README.md for build provenance; PET-MAD-xs):
//   * positions/forces are flat row-major per atom: [x0,y0,z0, x1,y1,z1, ...].
//     (central finite-difference dE/dx matched analytic forces to ~7e-4 eV/Å).
//   * cell is row-major with rows = lattice vectors a,b,c in the SAME cartesian
//     frame as positions, flat [a0,a1,a2, b0,b1,b2, c0,c1,c2] (rotation-invariance
//     held to ~4e-3 eV, while feeding the transpose shifted E by ~1.4e-1 eV).
//   * STRESS: the source-built wasm emits Voigt stress [xx,yy,zz,yz,xz,xy]
//     (eV/Å³, Float32Array, periodic systems only). Sign verified against -dE/dV
//     (isotropic ±0.2% strain, agreement to 2.4e-6 eV/Å³): tension-positive,
//     P = -tr(σ)/3 > 0 under compression — SAME as the NEP path, so the values
//     pass through stressFromMlipVoigt() unconverted. (npm 0.1.1 emitted no
//     stress at all; the zero-tensor fallback below covers any build that
//     doesn't, leaving the relaxer's cell step a no-op in that case.)
//   * forces/stress arrive as Float32Array at runtime (the upstream .d.ts says
//     Float64Array); the converters below are typed-array agnostic.
// ---------------------------------------------------------------------------

// Element symbols for Z = 1..103. element_list[i] has atomic number Z = i + 1, so
// buildNEPStructure's symbol->index mapping yields type index = Z - 1, and this
// adapter recovers Z = typeIndex + 1 in compute().
const ELEMENTS_Z1_TO_103 = [
  'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
  'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
  'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr',
  'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn',
  'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd',
  'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb',
  'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg',
  'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th',
  'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm',
  'Md', 'No', 'Lr',
];

const MODEL_CACHE_NAME = 'crysviz-mlip-models';
const DEFAULT_MODEL_URL =
  'https://huggingface.co/peterspackman/mlip-gguf/resolve/main/pet-mad-xs.gguf';

// ggml reports fatal conditions (OOM, WebGPU device errors) only on stderr —
// the embind promise often rejects with an opaque abort. Patterns that turn a
// captured stderr line into an actionable user-facing message.
const OOM_RE = /insufficient memory|failed to allocate/i;
const GPU_ERR_RE = /ggml_webgpu: Device error|device lost/i;
const OOM_HINT = 'PET-MAD ran out of WASM memory (4 GB address-space limit). '
  + 'Reduce the number of atoms or use the smaller pet-mad-xs model.';

/**
 * Convert an mlip Voigt stress vector [xx, yy, zz, yz, xz, xy] (eV/Å³) into the
 * NEP-style { matrix3x3, voigt } shape. When mlip does not provide stress
 * (current 0.1.1 PET-MAD build) this returns a zero tensor.
 * @param {Float64Array|number[]|null|undefined} voigt
 * @returns {{ matrix3x3: number[][], voigt: number[], available: boolean }}
 */
function stressFromMlipVoigt(voigt) {
  if (!voigt || voigt.length < 6) {
    const zero3 = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    return { matrix3x3: zero3, voigt: [0, 0, 0, 0, 0, 0], available: false };
  }
  const xx = voigt[0];
  const yy = voigt[1];
  const zz = voigt[2];
  const yz = voigt[3];
  const xz = voigt[4];
  const xy = voigt[5];
  return {
    matrix3x3: [
      [xx, xy, xz],
      [xy, yy, yz],
      [xz, yz, zz],
    ],
    // Same Voigt ordering as NEP's stressFromVirial: [xx, yy, zz, yz, xz, xy].
    voigt: [xx, yy, zz, yz, xz, xy],
    available: true,
  };
}

/**
 * Flatten an Nx3 array of cartesian positions into a row-major Float64Array
 * [x0,y0,z0, x1,y1,z1, ...] as expected by AtomicSystem.create.
 * @param {number[][]} positions
 * @returns {Float64Array}
 */
function positionsToFlat(positions) {
  const n = positions.length;
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    out[i * 3] = positions[i][0];
    out[i * 3 + 1] = positions[i][1];
    out[i * 3 + 2] = positions[i][2];
  }
  return out;
}

/**
 * Rebuild an Nx3 forces array from mlip's flat row-major Float64Array.
 * @param {Float64Array} flat
 * @param {number} n
 * @returns {number[][]}
 */
function forcesFromFlat(flat, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]];
  }
  return out;
}

export class MLIPRunner {
  /**
   * @param {{ backend?: 'cpu'|'webgpu'|'auto', defaultModelUrl?: string }} [options]
   */
  constructor(options = {}) {
    this.backend = options.backend || 'cpu';
    this.defaultModelUrl = options.defaultModelUrl || DEFAULT_MODEL_URL;
    this.module = null;
    this.model = null;
    this.modelInfo = null;
    // Ring buffer of recent wasm stderr lines (ggml logs OOM / WebGPU device
    // errors there while the embind promise rejects with an opaque abort).
    /** @type {string[]} */
    this._errLines = [];
    // Total stderr lines ever captured; lets _enrich(mark) address lines even
    // after the ring buffer has dropped old ones.
    this._errTotal = 0;
    // The vendored source-built wasm emits real stress for periodic PET-MAD
    // systems (see header). UI code shows pressure as n/a for runners where
    // this is false (NEPWasmRunner has no such flag, i.e.
    // `runner.supportsStress !== false` marks a real-stress runner).
    this.supportsStress = true;
  }

  /**
   * Dynamic-import the vendored mlip.js loader and instantiate the WASM module.
   * WASM URLs are resolved relative to this module so it works from any page path.
   * @returns {Promise<MLIPRunner>}
   */
  async init() {
    if (!this.module) {
      if (this.backend === 'webgpu'
          && (typeof navigator === 'undefined' || !('gpu' in navigator))) {
        throw new Error(
          'WebGPU is not available in this browser. Use the cpu backend, or a '
          + 'browser with WebGPU enabled (Chrome/Edge 113+, Safari 18+, or '
          + 'Firefox with dom.webgpu.enabled).',
        );
      }
      const loader = await import('./index.browser.js');
      const createMlipcpp = loader.default || loader.createMlipcpp;
      const cpuWasmUrl = new URL('./cpu/mlipcpp_wasm.wasm', import.meta.url).href;
      const gpuWasmUrl = new URL('./gpu/mlipcpp_wasm.wasm', import.meta.url).href;
      try {
        this.module = await createMlipcpp({
          backend: this.backend,
          cpuWasmUrl,
          gpuWasmUrl,
          printErr: (text) => this._captureErr(text),
        });
      } catch (error) {
        throw this._enrich(error, `PET-MAD ${this.backend} module init failed`);
      }
    }
    return this;
  }

  /**
   * Record a wasm stderr line (keep the tail) and mirror it to the console so
   * nothing that used to be visible in devtools is lost.
   * @param {string} text
   */
  _captureErr(text) {
    this._errLines.push(String(text));
    this._errTotal += 1;
    if (this._errLines.length > 20) this._errLines.shift();
    console.error('[mlip]', text);
  }

  /**
   * Wrap an opaque wasm/embind failure in an Error whose message includes the
   * matching ggml stderr diagnostics captured since `mark` (OOM gets a hint
   * with a concrete remedy).
   * @param {unknown} error
   * @param {string} context
   * @param {number} [mark] value of this._errTotal at call start
   * @returns {Error}
   */
  _enrich(error, context, mark = 0) {
    const dropped = this._errTotal - this._errLines.length;
    const recent = this._errLines.slice(Math.max(0, mark - dropped));
    const oomLine = recent.find((l) => OOM_RE.test(l));
    const gpuLine = recent.find((l) => GPU_ERR_RE.test(l));
    const base = error instanceof Error ? error.message : String(error);
    let msg = `${context}: ${base}`;
    if (oomLine) msg = `${context}: ${OOM_HINT} (${oomLine.trim()})`;
    else if (gpuLine) msg = `${context}: ${gpuLine.trim()}`;
    const out = new Error(msg);
    out.cause = error;
    return out;
  }

  /**
   * @param {(p: { loadedBytes: number, totalBytes: number }) => void} [onProgress]
   */
  async loadDefaultModel(onProgress) {
    return this.loadModelFromUrl(this.defaultModelUrl, onProgress);
  }

  /**
   * Fetch a GGUF model (through a Cache API read-through cache), streaming
   * download progress, then build the mlip model.
   * @param {string} url
   * @param {(p: { loadedBytes: number, totalBytes: number }) => void} [onProgress]
   */
  async loadModelFromUrl(url, onProgress) {
    const buffer = await this._fetchModelBuffer(url, onProgress);
    return this._buildModel(buffer, url.split('/').pop() || 'model.gguf');
  }

  /**
   * @param {File} file
   */
  async loadModelFromFile(file) {
    const buffer = await file.arrayBuffer();
    return this._buildModel(buffer, file.name || 'model.gguf');
  }

  /**
   * Cache-first fetch with streaming progress. Falls back to a plain fetch when
   * the Cache API is unavailable (e.g. insecure context / older runtimes).
   * @param {string} url
   * @param {(p: { loadedBytes: number, totalBytes: number }) => void} [onProgress]
   * @returns {Promise<ArrayBuffer>}
   */
  async _fetchModelBuffer(url, onProgress) {
    const hasCaches = typeof caches !== 'undefined';
    let cache = null;
    if (hasCaches) {
      try {
        cache = await caches.open(MODEL_CACHE_NAME);
        const cached = await cache.match(url);
        if (cached) return cached.arrayBuffer();
      } catch (_e) {
        cache = null; // Cache API present but unusable; fall back to fetch.
      }
    }

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch model: ${url} (${resp.status})`);

    // Stream the body so we can report progress when Content-Length is known.
    // The chunks go through a Blob (which references them without an eager
    // copy) so caching and the final ArrayBuffer need only one materialized
    // copy — buffer.slice() double-buffering here previously peaked at ~3x
    // the model size (~300 MB for pet-mad-s).
    const totalBytes = Number(resp.headers.get('content-length')) || 0;
    let blob;
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      const chunks = [];
      let loadedBytes = 0;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loadedBytes += value.length;
        if (typeof onProgress === 'function') onProgress({ loadedBytes, totalBytes });
      }
      blob = new Blob(chunks);
    } else {
      blob = await resp.blob();
      if (typeof onProgress === 'function') {
        onProgress({ loadedBytes: blob.size, totalBytes: totalBytes || blob.size });
      }
    }

    if (cache) {
      try {
        await cache.put(url, new Response(blob, {
          headers: { 'content-type': 'application/octet-stream' },
        }));
      } catch (_e) {
        // Caching is best-effort; ignore quota / opaque-response failures.
      }
    }
    return blob.arrayBuffer();
  }

  /**
   * @param {ArrayBuffer} buffer
   * @param {string} name
   */
  async _buildModel(buffer, name) {
    if (!this.module) throw new Error('Module is not initialized. Call init() first.');
    const M = this.module;
    const mark = this._errTotal;
    try {
      if (M.Model.loadFromBufferWithBackend) {
        this.model = await M.Model.loadFromBufferWithBackend(buffer, this.backend);
      } else {
        this.model = await M.Model.loadFromBuffer(buffer);
      }
    } catch (error) {
      throw this._enrich(error, `Loading ${name} failed`, mark);
    }
    this.modelInfo = {
      name,
      // Full periodic table so buildNEPStructure never rejects an element; the
      // model raises at predict() time for species it does not support.
      element_list: ELEMENTS_Z1_TO_103.slice(),
    };
    return this.modelInfo;
  }

  /**
   * Predict energy / forces / stress for a structure.
   * @param {{ lattice: number[][], positions: number[][], types: number[] }} structure
   * @returns {Promise<{ total_energy: number, energy_per_atom: number,
   *   forces: number[][], stress: { matrix3x3: number[][], voigt: number[] } }>}
   */
  async compute(structure) {
    if (!this.module || !this.model) {
      throw new Error('Model is not loaded. Call loadDefaultModel/loadModelFrom... first.');
    }
    const s = structure;
    if (!s || !Array.isArray(s.lattice) || s.lattice.length !== 3) {
      throw new Error('structure.lattice must be a 3x3 array.');
    }
    if (!Array.isArray(s.positions) || s.positions.length === 0) {
      throw new Error('structure.positions must be an Nx3 array.');
    }
    const nAtoms = s.positions.length;
    if (!Array.isArray(s.types) || s.types.length !== nAtoms) {
      throw new Error('Provide structure.types with length N.');
    }

    const positionsFlat = positionsToFlat(s.positions);
    // type index -> atomic number Z (element_list is Z = index + 1).
    const atomicNumbers = Int32Array.from(s.types, (t) => t + 1);
    // Row-major cell: rows a, b, c (verified convention; see header note).
    const cellFlat = new Float64Array([
      s.lattice[0][0], s.lattice[0][1], s.lattice[0][2],
      s.lattice[1][0], s.lattice[1][1], s.lattice[1][2],
      s.lattice[2][0], s.lattice[2][1], s.lattice[2][2],
    ]);

    const mark = this._errTotal;
    const sys = await this.module.AtomicSystem.create(positionsFlat, atomicNumbers, cellFlat, true);
    try {
      let r;
      try {
        r = await this.model.predict(sys);
      } catch (error) {
        throw this._enrich(error, `PET-MAD compute failed (${nAtoms} atoms)`, mark);
      }
      // WebGPU device errors are reported asynchronously on stderr while
      // predict() still resolves — the returned numbers are garbage. Detect
      // and fail loudly instead of feeding them to the relaxer/MD.
      if (this._errTotal > mark) {
        const gpuLine = this._errLines
          .slice(Math.max(0, mark - (this._errTotal - this._errLines.length)))
          .find((l) => GPU_ERR_RE.test(l));
        if (gpuLine) {
          throw new Error(`PET-MAD WebGPU device error during compute: ${gpuLine.trim()} `
            + '— results discarded. Try the cpu backend.');
        }
      }
      const forcesFlat = r.forces;
      const totalEnergy = r.energy;
      return {
        total_energy: totalEnergy,
        energy_per_atom: totalEnergy / nAtoms,
        forces: forcesFromFlat(forcesFlat, nAtoms),
        // mlip.cpp Voigt order [xx,yy,zz,yz,xz,xy] matches the repo's tension-positive
        // convention directly; zero tensor when the build does not emit stress.
        stress: stressFromMlipVoigt(r.stress),
      };
    } finally {
      // Release the embind-owned WASM heap allocation for this system.
      if (sys && typeof sys.delete === 'function') sys.delete();
    }
  }

  destroy() {
    if (this.model && typeof this.model.delete === 'function') {
      this.model.delete();
    }
    this.model = null;
    this.modelInfo = null;
  }
}

export default MLIPRunner;
