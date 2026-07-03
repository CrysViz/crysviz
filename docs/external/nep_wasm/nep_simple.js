(function () {
  'use strict';

  function parseElementList(text) {
    const first = text.split(/\r?\n/)[0].trim();
    const tokens = first.split(/\s+/);
    if (tokens.length < 3) return [];
    const n = Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(n) || n <= 0) return [];
    return tokens.slice(2, 2 + n);
  }

  function normalizeLegacyModelText(text) {
    // Supports legacy files that only have: cutoff rc_radial rc_angular
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (!t) continue;
      const tokens = t.split(/\s+/);
      if (tokens[0] === 'cutoff' && tokens.length === 3) {
        lines[i] = `${tokens[0]} ${tokens[1]} ${tokens[2]} 80 47`;
        return { text: lines.join('\n'), patched: true };
      }
      if (tokens[0] === 'cutoff') break;
    }
    return { text, patched: false };
  }

  function latticeToBox(lattice) {
    const a = lattice[0];
    const b = lattice[1];
    const c = lattice[2];
    return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
  }

  function positionsToNEP(positions) {
    const n = positions.length;
    const out = new Array(n * 3);
    for (let i = 0; i < n; i += 1) out[i] = positions[i][0];
    for (let i = 0; i < n; i += 1) out[n + i] = positions[i][1];
    for (let i = 0; i < n; i += 1) out[2 * n + i] = positions[i][2];
    return out;
  }

  function forcesFromNEP(nepForces, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i += 1) {
      out[i] = [nepForces[i], nepForces[n + i], nepForces[2 * n + i]];
    }
    return out;
  }

  function det3(m) {
    const a = m[0][0], b = m[0][1], c = m[0][2];
    const d = m[1][0], e = m[1][1], f = m[1][2];
    const g = m[2][0], h = m[2][1], i = m[2][2];
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  }

  function stressFromVirial(virial9, lattice) {
    const volume = det3(lattice);
    if (!Number.isFinite(volume) || Math.abs(volume) < 1e-12) {
      throw new Error('Invalid lattice volume.');
    }

    const v = virial9;
    const vt = [v[0], v[3], v[6], v[1], v[4], v[7], v[2], v[5], v[8]];
    const sym = new Array(9);
    for (let k = 0; k < 9; k += 1) sym[k] = -0.5 * (v[k] + vt[k]) / volume;

    return {
      matrix3x3: [
        [sym[0], sym[1], sym[2]],
        [sym[3], sym[4], sym[5]],
        [sym[6], sym[7], sym[8]],
      ],
      voigt: [sym[0], sym[4], sym[8], sym[5], sym[2], sym[1]],
    };
  }

  class NEPWasmRunner {
    constructor(options) {
      const opts = options || {};
      this.moduleFactory = opts.moduleFactory || window.NEPModule;
      this.defaultModelUrl = opts.defaultModelUrl || 'nep89_20250409.txt';
      this.module = null;
      this.handle = 0;
      this.modelInfo = null;
      // Cached scratch buffers for compute(), keyed by atom count. Reused
      // across calls to avoid a malloc/free storm every step (see freeBuffers).
      this.buffers = null;
    }

    ensureBuffers(nAtoms) {
      const b = this.buffers;
      if (b && b.nAtoms === nAtoms) return b;
      this.freeBuffers();
      const next = {
        nAtoms,
        ptrTypes: this.module._malloc(nAtoms * 4),
        ptrBox: this.module._malloc(9 * 8),
        ptrPos: this.module._malloc(nAtoms * 3 * 8),
        ptrForces: this.module._malloc(nAtoms * 3 * 8),
        ptrVirial: this.module._malloc(9 * 8),
      };
      this.buffers = next;
      return next;
    }

    freeBuffers() {
      const b = this.buffers;
      if (!b || !this.module) {
        this.buffers = null;
        return;
      }
      this.module._free(b.ptrTypes);
      this.module._free(b.ptrBox);
      this.module._free(b.ptrPos);
      this.module._free(b.ptrForces);
      this.module._free(b.ptrVirial);
      this.buffers = null;
    }

    async init() {
      if (!this.moduleFactory) {
        throw new Error('NEPModule factory is not available. Load nep_wasm.js first.');
      }
      if (!this.module) {
        this.module = await this.moduleFactory({});
      }
      return this;
    }

    async loadDefaultModel() {
      return this.loadModelFromUrl(this.defaultModelUrl);
    }

    async loadModelFromUrl(url) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch model: ${url}`);
      const text = await resp.text();
      return this.loadModelFromText(text, url.split('/').pop() || 'model.txt');
    }

    async loadModelFromFile(file) {
      const text = await file.text();
      return this.loadModelFromText(text, file.name || 'model.txt');
    }

    loadModelFromText(text, name) {
      if (!this.module) throw new Error('Module is not initialized. Call init() first.');

      const normalized = normalizeLegacyModelText(text);
      const elementList = parseElementList(normalized.text);

      if (!this.module.FS.analyzePath('/models').exists) this.module.FS.mkdir('/models');
      const path = `/models/${name}`;
      this.module.FS.writeFile(path, new TextEncoder().encode(normalized.text));

      const n = this.module.lengthBytesUTF8(path) + 1;
      const ptr = this.module._malloc(n);
      this.module.stringToUTF8(path, ptr, n);

      if (this.handle) this.module._nep_destroy(this.handle);
      this.handle = this.module._nep_create(ptr);
      this.module._free(ptr);

      if (!this.handle) throw new Error('Failed to create NEP model handle.');

      this.modelInfo = {
        name,
        path,
        element_list: elementList,
        legacy_cutoff_patched: normalized.patched,
      };
      return this.modelInfo;
    }

    compute(structure) {
      if (!this.module || !this.handle) {
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
      let types = s.types;
      if (!Array.isArray(types) && Array.isArray(s.symbols)) {
        const map = new Map((this.modelInfo.element_list || []).map((e, i) => [e, i]));
        types = s.symbols.map((sym) => {
          if (!map.has(sym)) throw new Error(`Unknown symbol: ${sym}`);
          return map.get(sym);
        });
      }

      if (!Array.isArray(types) || types.length !== nAtoms) {
        throw new Error('Provide structure.types or structure.symbols with length N.');
      }

      const box = latticeToBox(s.lattice);
      const pos = positionsToNEP(s.positions);

      const { ptrTypes, ptrBox, ptrPos, ptrForces, ptrVirial } = this.ensureBuffers(nAtoms);

      try {
        this.module.HEAP32.set(Int32Array.from(types), ptrTypes / 4);
        this.module.HEAPF64.set(Float64Array.from(box), ptrBox / 8);
        this.module.HEAPF64.set(Float64Array.from(pos), ptrPos / 8);

        this.module._nep_set_atoms(this.handle, nAtoms, ptrTypes, ptrBox, ptrPos);
        const totalEnergy = this.module._nep_total_energy(this.handle);
        this.module._nep_get_forces(this.handle, ptrForces);
        this.module._nep_get_virial(this.handle, ptrVirial);

        const f = this.module.HEAPF64.slice(ptrForces / 8, ptrForces / 8 + nAtoms * 3);
        const v = this.module.HEAPF64.slice(ptrVirial / 8, ptrVirial / 8 + 9);

        return {
          total_energy: totalEnergy,
          energy_per_atom: totalEnergy / nAtoms,
          forces: forcesFromNEP(f, nAtoms),
          stress: stressFromVirial(Array.from(v), s.lattice),
        };
      } finally {
        // Buffers persist on the instance (cached, keyed by nAtoms) and are
        // freed in freeBuffers()/destroy(); nothing to release here. Leaving
        // them allocated on an exception path is safe — the next call reuses
        // them (same nAtoms) or reallocs (freeing the old ones first).
      }
    }

    destroy() {
      this.freeBuffers();
      if (this.module && this.handle) {
        this.module._nep_destroy(this.handle);
      }
      this.handle = 0;
    }
  }

  window.NEPWasmRunner = NEPWasmRunner;
})();
