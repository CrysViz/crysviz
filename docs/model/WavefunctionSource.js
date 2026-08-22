import { Field } from './Field.js';
import { LruByteCache, DEFAULT_CACHE_BUDGET_BYTES } from './LruByteCache.js';
import {
  GammaMode,
  WaveQuantity,
  getWaveBackend,
  countGvecs,
  generateGvecs,
  kgridSizeFor,
  reciprocalTimes2Pi,
  smoothDims,
  transformToRealSpace,
} from '../math/wave-backend-wasm.js';
import { runWavefunctionTransform } from '../workers/waveTasks.js';

/**
 * A lazily-read set of plane-wave wavefunctions — the proxy object a WAVECAR
 * becomes.
 *
 * The file is never held in memory. `io/ReadWavecarModule.js` decodes the two
 * header records and hands the geometry plus a record-position function here;
 * everything after that is read on demand, one band at a time, through
 * `io/FileSource.js`.
 *
 * Turning a band into something the isosurface code can draw is three steps:
 *
 *   coefficients (read from the file)
 *     -> scattered into an FFT box at their G-vectors
 *     -> inverse 3D FFT, reduced to a real scalar
 *
 * All three run in `docs/compiled/wave_backend.c`, off the main thread when a
 * worker is available. The result is an ordinary `model/Field.js`, so nothing
 * downstream — marching cubes, cut planes, either tracer — knows a wavefunction
 * is involved.
 *
 * Both the raw coefficients and the expanded fields are cached under one shared
 * byte budget (`model/LruByteCache.js`), because they differ in size by orders
 * of magnitude and counting entries would manage the wrong thing.
 *
 * Structured after httk's `PlaneWaveFunctions`
 * (httk/atomistic/wavefunction.py), with two deliberate differences: httk's
 * cache is unbounded, and httk transforms on a box of exactly 2*kgrid whereas
 * this pads up to a 5-smooth size (see the C).
 */

/** Coefficients on disk are float32 (RTAG 45200) or float64 (45210). */
export const RTAG_SINGLE = 45200;
export const RTAG_DOUBLE = 45210;

export class WavefunctionSource {
  /**
   * @param {object} header decoded by io/ReadWavecarModule.js
   * @param {import('../io/FileSource.js').FileSource} header.fileSource
   * @param {string} header.fileName
   * @param {number} header.nspin
   * @param {number} header.nkpts
   * @param {number} header.nbands
   * @param {number} header.encut in eV
   * @param {number[][]} header.lattice rows are a, b, c in Angstrom
   * @param {number[][]} header.kpoints fractional, one per k-point
   * @param {number[]} header.nplws plane-wave count per k-point
   * @param {number[][][]} header.eigenvalues [spin][kpt][band], eV
   * @param {number[][][]} header.occupations [spin][kpt][band]
   * @param {boolean} header.doublePrecision
   * @param {(spin: number, kpt: number, band: number) => number} header.recordPosition 1-indexed
   * @param {number} [header.cacheBudgetBytes]
   */
  constructor(header) {
    // Assigned one by one rather than via Object.assign so the type checker can
    // see the shape of the object (tsc --checkJs infers nothing from a spread).
    this.fileSource = header.fileSource;
    this.fileName = header.fileName;
    this.nspin = header.nspin;
    this.nkpts = header.nkpts;
    this.nbands = header.nbands;
    this.encut = header.encut;
    this.lattice = header.lattice;
    this.kpoints = header.kpoints;
    this.nplws = header.nplws;
    this.eigenvalues = header.eigenvalues;
    this.occupations = header.occupations;
    this.doublePrecision = header.doublePrecision;
    this.recordPosition = header.recordPosition;

    /** @type {number} WF_GAMMA_*, resolved by init() */
    this.gammaMode = GammaMode.NONE;
    /** @type {number[] | null} reciprocal ladder extent, resolved by init() */
    this.kgridSize = null;
    /** @type {number[] | null} real-space FFT box, resolved by init() */
    this.fftDims = null;
    /** @type {Float64Array | null} 2*pi * reciprocal lattice, rows are b_j */
    this.recip = null;
    /** @type {boolean} */
    this.initialized = false;

    // The cell the field is DRAWN in. Normally the WAVECAR's own, but when the
    // user chooses to attach the file to a structure whose cell differs
    // (render/Render3DFieldModule.js parseWavecarFile), the grid has to be
    // expressed in the host cell or the isosurface would sit in a box of its
    // own. Set once at load, before any field is realised — changing it later
    // would leave already-cached fields with a stale voxel matrix.
    this.displayLattice = header.lattice;

    /**
     * Called when the budget was hit and older wavefunctions had to be
     * discarded to make room. Set by the UI layer
     * (render/Render3DFieldModule.js) so the user is told once rather than
     * silently losing work; the model itself must not reach into the UI.
     * @type {((info: {freed: number, bytes: number}) => void) | null}
     */
    this.onEvicted = null;

    // Accumulates across one synchronous eviction sweep so a single insert that
    // drops several entries produces one notification rather than one per entry.
    let evictedThisSweep = 0;
    let evictedBytes = 0;
    let notifyScheduled = false;

    this.cache = new LruByteCache({
      budgetBytes: header.cacheBudgetBytes ?? DEFAULT_CACHE_BUDGET_BYTES,
      onEvict: (key, value) => {
        // Coefficient arrays are cheap to re-read from disk; only the expanded
        // real-space fields represent work the user will notice losing.
        if (!key.startsWith('f:')) return;
        evictedThisSweep++;
        evictedBytes += value?.values?.byteLength ?? 0;
        if (notifyScheduled) return;
        notifyScheduled = true;
        queueMicrotask(() => {
          const info = { freed: evictedThisSweep, bytes: evictedBytes };
          evictedThisSweep = 0;
          evictedBytes = 0;
          notifyScheduled = false;
          if (this.onEvicted) this.onEvicted(info);
        });
      },
    });

    // G-vectors are kept outside the LRU: they are shared by every band at a
    // k-point, cost ~200 kB each, and are bounded by nkpts. Evicting them would
    // force a full regeneration for the next band at the same k-point.
    /** @type {Map<number, Int32Array>} */
    this.gvecCache = new Map();
  }

  /**
   * Resolve the FFT geometry and detect gamma compression. Must be awaited
   * before any band is read; `io/ReadWavecarModule.js` does this at load time so
   * the failure surfaces while the file is being opened rather than on the first
   * click in the field panel.
   */
  async init() {
    if (this.initialized) return this;

    const module = await getWaveBackend();

    this.recip = reciprocalTimes2Pi(this.lattice);
    this.kgridSize = kgridSizeFor(this.lattice, this.encut);

    // Gamma detection: VASP writes only a half-space of coefficients for a
    // gamma-only run, so the file's own plane-wave count for the first k-point
    // identifies the layout. Both halving axes are tried because vasp_gam builds
    // differ in which one they use; httk assumes "x".
    //
    // Deviation from httk: the counts are evaluated at kpoints[0] rather than at
    // (0,0,0). Gamma compression can only occur when that k-point *is* gamma, so
    // the two agree whenever it matters, and using the real k-point avoids a
    // false gamma match on a file whose first k-point is elsewhere.
    const kvec = this.kpoints[0];
    const spec = { kgrid: this.kgridSize, kvec, recip: this.recip, encut: this.encut };
    const expected = this.nplws[0];

    const standard = countGvecs(module, { ...spec, gamma: GammaMode.NONE });
    if (standard === expected) {
      this.gammaMode = GammaMode.NONE;
    } else if (countGvecs(module, { ...spec, gamma: GammaMode.X }) === expected) {
      this.gammaMode = GammaMode.X;
    } else if (countGvecs(module, { ...spec, gamma: GammaMode.Z }) === expected) {
      this.gammaMode = GammaMode.Z;
    } else if (standard * 2 === expected) {
      // Non-collinear runs store a two-component spinor per plane wave. Reading
      // it as a scalar would silently render the wrong thing, so refuse.
      throw new Error(
        `${this.fileName}: this looks like a non-collinear (LNONCOLLINEAR) WAVECAR — `
        + `${expected} coefficients is exactly twice the ${standard} G-vectors in the cutoff. `
        + 'Spinor wavefunctions are not supported yet.');
    } else {
      throw new Error(
        `${this.fileName}: could not match the plane-wave count. The file reports `
        + `${expected} coefficients at the first k-point, but the ENCUT (${this.encut} eV) `
        + `and cell imply ${standard} G-vectors (or ${Math.ceil(standard / 2)} gamma-compressed). `
        + 'The header may be from an unsupported VASP version.');
    }

    // Real-space box: at least twice the ladder so nothing aliases, rounded up
    // to a radix-2/3/5 size. Padding past the minimum is exact interpolation.
    this.fftDims = smoothDims(module, this.kgridSize.map((n) => n * 2));
    this.initialized = true;
    return this;
  }

  /** Volume of the cell the field is drawn in, for the dV in the normalisation. */
  get cellVolume() {
    return Math.abs(tripleProduct(this.displayLattice));
  }

  /** Bytes per complex coefficient on disk. */
  get bytesPerCoefficient() {
    return this.doublePrecision ? 16 : 8;
  }

  /** Human-readable summary for the field panel header. */
  describe() {
    const gamma = this.gammaMode === GammaMode.NONE
      ? 'standard'
      : `gamma-compressed (${this.gammaMode === GammaMode.X ? 'x' : 'z'})`;
    return `${this.nspin} spin × ${this.nkpts} k-points × ${this.nbands} bands, `
      + `ENCUT ${this.encut.toFixed(0)} eV, ${gamma}`;
  }

  /**
   * Validate a 1-indexed (spin, kpt, band) triple.
   * @param {number} spin @param {number} kpt @param {number} band
   */
  _assertIndices(spin, kpt, band) {
    if (!(spin >= 1 && spin <= this.nspin)) {
      throw new RangeError(`spin ${spin} out of range [1, ${this.nspin}]`);
    }
    if (!(kpt >= 1 && kpt <= this.nkpts)) {
      throw new RangeError(`k-point ${kpt} out of range [1, ${this.nkpts}]`);
    }
    if (!(band >= 1 && band <= this.nbands)) {
      throw new RangeError(`band ${band} out of range [1, ${this.nbands}]`);
    }
  }

  /**
   * Plane-wave coefficients for one band, as interleaved re/im float64.
   *
   * Exactly `nplw * bytesPerCoefficient` bytes are read at the band's record
   * offset — one ranged slice, never the whole file.
   *
   * @param {number} spin 1-indexed
   * @param {number} kpt 1-indexed
   * @param {number} band 1-indexed
   * @returns {Promise<Float64Array>}
   */
  async getCoefficients(spin, kpt, band) {
    this._assertIndices(spin, kpt, band);

    const key = `c:${spin}:${kpt}:${band}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const count = this.nplws[kpt - 1];
    const offset = this.recordPosition(spin, kpt, band);
    const byteLength = count * this.bytesPerCoefficient;
    const bytes = await this.fileSource.readBytes(offset, byteLength);

    if (bytes.byteLength < byteLength) {
      throw new Error(
        `${this.fileName}: truncated at spin ${spin}, k-point ${kpt}, band ${band} — `
        + `expected ${byteLength} bytes at offset ${offset}, got ${bytes.byteLength}.`);
    }

    // A DataView rather than a typed-array view: a Blob slice or a subarray can
    // start at any byte offset, and Float32Array/Float64Array require alignment.
    // VASP writes native little-endian.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const coeffs = new Float64Array(count * 2);
    if (this.doublePrecision) {
      for (let i = 0; i < count * 2; i++) coeffs[i] = view.getFloat64(i * 8, true);
    } else {
      for (let i = 0; i < count * 2; i++) coeffs[i] = view.getFloat32(i * 4, true);
    }

    this.cache.set(key, coeffs, coeffs.byteLength);
    return coeffs;
  }

  /**
   * G-vectors for a k-point, in the order VASP stores its coefficients.
   * @param {number} kpt 1-indexed
   * @returns {Promise<Int32Array>}
   */
  async getGvecs(kpt) {
    if (this.gvecCache.has(kpt)) return this.gvecCache.get(kpt);

    await this.init();
    const module = await getWaveBackend();
    const gvecs = generateGvecs(module, {
      kgrid: this.kgridSize,
      kvec: this.kpoints[kpt - 1],
      recip: this.recip,
      encut: this.encut,
      gamma: this.gammaMode,
    });

    const count = gvecs.length / 3;
    const expected = this.nplws[kpt - 1];
    if (count !== expected) {
      // A mismatch here means the cutoff sphere was reconstructed differently
      // from VASP's, and every coefficient would land on the wrong G. Refusing
      // is the only safe response: the render would look plausible and be wrong.
      throw new Error(
        `${this.fileName}: generated ${count} G-vectors for k-point ${kpt} but the file `
        + `stores ${expected} coefficients. Refusing to render a scrambled wavefunction.`);
    }

    this.gvecCache.set(kpt, gvecs);
    return gvecs;
  }

  /** Cache key for a realised field. */
  static fieldKey(spin, kpt, band, quantity) {
    return `f:${quantity}:${spin}:${kpt}:${band}`;
  }

  /**
   * The real-space scalar field for one band, ready to hand to the isosurface.
   *
   * @param {number} spin 1-indexed
   * @param {number} kpt 1-indexed
   * @param {number} band 1-indexed
   * @param {number} [quantity] WaveQuantity
   * @returns {Promise<Field>}
   */
  async getField(spin, kpt, band, quantity = WaveQuantity.DENSITY) {
    this._assertIndices(spin, kpt, band);
    await this.init();

    const key = WavefunctionSource.fieldKey(spin, kpt, band, quantity);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const [coeffs, gvecs] = await Promise.all([
      this.getCoefficients(spin, kpt, band),
      this.getGvecs(kpt),
    ]);

    const result = await runWavefunctionTransform({
      coeffs,
      gvecs,
      dims: this.fftDims,
      gamma: this.gammaMode,
      quantity,
      cellVolume: this.cellVolume,
    });

    const [nx, ny, nz] = this.fftDims;
    const field = new Field({
      nx,
      ny,
      nz,
      origin: [0, 0, 0],
      voxel: [
        this.displayLattice[0].map((v) => v / nx),
        this.displayLattice[1].map((v) => v / ny),
        this.displayLattice[2].map((v) => v / nz),
      ],
      values: result.values,
      component: 0,
      label: this.labelFor(spin, kpt, band, quantity),
      minValue: result.minValue,
      maxValue: result.maxValue,
      absMinValue: result.absMinValue,
      absMaxValue: result.absMaxValue,
      // |psi|^2 is non-negative, so the signed treatment would waste half the
      // isovalue slider on an empty negative surface. The amplitude modes do
      // straddle zero and want it.
      useAbsoluteIsoValue: quantity === WaveQuantity.DENSITY ? false : null,
    });

    // Provenance, so the catalog can find its way back to the source entry and
    // the panel can show the eigenvalue alongside the isosurface controls.
    field.wavefunction = { source: this, spin, kpt, band, quantity };

    this.cache.set(key, field, result.values.byteLength);
    return field;
  }

  /** @returns {string} e.g. "s1 k3 b12  (−4.82 eV, occ 1.00)" */
  labelFor(spin, kpt, band, quantity) {
    const eig = this.eigenvalues?.[spin - 1]?.[kpt - 1]?.[band - 1];
    const energy = Number.isFinite(eig) ? `, ${eig.toFixed(2)} eV` : '';
    const spinPart = this.nspin > 1 ? `spin ${spin} ` : '';
    const quantityPart = quantity === WaveQuantity.DENSITY ? '' : ` [${quantityName(quantity)}]`;
    return `${spinPart}k${kpt} band ${band}${energy}${quantityPart}`;
  }

  /**
   * Keep a field alive across evictions while it is on screen.
   * @param {number} spin @param {number} kpt @param {number} band @param {number} quantity
   * @param {boolean} [pinned]
   */
  pinField(spin, kpt, band, quantity, pinned = true) {
    this.cache.pin(WavefunctionSource.fieldKey(spin, kpt, band, quantity), pinned);
  }

  /**
   * The already-realised field for one band, or null. Never triggers a load and
   * never touches the file, so the catalog can call it while painting rows.
   * @returns {Field | null}
   */
  peekField(spin, kpt, band, quantity = WaveQuantity.DENSITY) {
    return this.cache.get(WavefunctionSource.fieldKey(spin, kpt, band, quantity)) || null;
  }

  /** True when this band's field is already realised (drives the catalog UI). */
  isFieldLoaded(spin, kpt, band, quantity = WaveQuantity.DENSITY) {
    return this.cache.has(WavefunctionSource.fieldKey(spin, kpt, band, quantity));
  }

  /** Every realised field, newest last. Backs `fieldBrowser.availableFields`. */
  loadedFields() {
    const out = [];
    for (const [key, entry] of this.cache._entries) {
      if (key.startsWith('f:')) out.push(entry.value);
    }
    return out;
  }

  /**
   * Cache occupancy. Not shown in the UI — the budget is fixed and eviction is
   * automatic — but useful from the console and for tests.
   */
  cacheStats() {
    return this.cache.stats();
  }

  /** Drop everything cached; the file handle stays usable. */
  clearCache() {
    this.cache.clear();
    this.gvecCache.clear();
  }
}

/** @param {number} quantity */
function quantityName(quantity) {
  switch (quantity) {
    case WaveQuantity.REAL: return 'Re ψ';
    case WaveQuantity.IMAG: return 'Im ψ';
    case WaveQuantity.SIGNED: return 'signed |ψ|';
    default: return '|ψ|²';
  }
}

/** Signed cell volume from lattice rows. */
function tripleProduct(lattice) {
  const [a, b, c] = lattice;
  return a[0] * (b[1] * c[2] - b[2] * c[1])
       - a[1] * (b[0] * c[2] - b[2] * c[0])
       + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

export { GammaMode, WaveQuantity, transformToRealSpace };
