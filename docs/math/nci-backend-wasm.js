import createNciModule from '../compiled/nci_backend.js';
import { BOHR_TO_ANGSTROM } from '../io/cubeParse.js';

/**
 * JS adapter for the NCI WASM backend (`docs/compiled/nci_backend.c`).
 *
 * Same arrangement as `math/wave-backend-wasm.js`: the C owns the numerics,
 * this file owns units, periodic images and marshalling, and nothing above it
 * touches a raw pointer. There is no JS fallback; if the module is missing,
 * `getNciBackend()` rejects with a message pointing at the build step:
 *   cd docs/compiled && make wasm-nci
 *
 * Units: the grid comes in as CrysViz stores it (voxel vectors in Angstrom) and
 * is converted to bohr here; the density must be in e/bohr^3 after
 * multiplying by `valueScale` (0.148185 = bohr^3/Angstrom^3 for a field in
 * e/Angstrom^3, 1 for a Gaussian cube). The outputs are the reduced density
 * gradient s (dimensionless) and sign(lambda2)*rho in e/bohr^3.
 *
 * Memory: every call allocates and frees its own heap buffers (see
 * withMemory), so nothing large outlives a call. *
 * Credits: the NCI method is by E. R. Johnson, S. Keinan, P. Mori-Sánchez,
 * J. Contreras-García, A. J. Cohen and W. Yang (J. Am. Chem. Soc. 132, 6498
 * (2010)) and NCIPLOT by J. Contreras-García, E. R. Johnson, S. Keinan,
 * R. Chaudret, J.-P. Piquemal, D. N. Beratan and W. Yang (J. Chem. Theory
 * Comput. 7, 625 (2011)), whose promolecular densities are used; the numerics
 * are ported from Jmol's NciCalculation by Bob Hanson. Full references in
 * docs/compiled/nci_backend.c.
 */

/** Angstrom per bohr. The same constant `io/cubeParse.js` converts cube
 *  files with, so a cube's own bohr grid round-trips exactly. */
export const ANGSTROM_PER_BOHR = BOHR_TO_ANGSTROM;

/** NCI defaults. Jmol's (NciCalculation.java), except the promolecular
 *  density cut: Jmol uses 0.07, but at 0.07 the promolecular density leaves
 *  wide low-s sheets around covalent bonds, so 0.05 as for SCF (the value
 *  Rzepa's cub2nci page passes for both variants). */
export const NCI_DEFAULTS = Object.freeze({
  rhoMin: 1e-5,
  rhoPlotScf: 0.05,
  rhoPlotPromolecular: 0.05,
  sCap: 2.0,
});

/** Largest atomic number with promolecular parameters; heavier atoms are
 *  treated as argon, as Jmol does. */
export const PROMOLECULAR_MAX_Z = 18;

/** Jmol's per-element dMax (bohr) for Z = 0..18: the half-width of the box
 *  outside which an atom's promolecular density is ignored. Kept in sync with
 *  the table in nci_backend.c; only used here to size the periodic images. */
const D_MAX_BOHR = [
  0, 2.982502423, 2.635120936,
  4.144887422, 4.105800759, 3.576656363, 3.872424373, 3.497503547,
  3.165369971, 3.204214082, 3.051069564,
  4.251312809, 4.503309314, 4.047465141, 4.666024968, 4.265151411,
  3.955710076, 4.040067606, 3.776022242,
];

const ELEMENT_SYMBOLS = (
  'X H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu '
  + 'Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La '
  + 'Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At '
  + 'Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh '
  + 'Fl Mc Lv Ts Og').split(' ');

/** @type {Promise<any> | null} */
let modulePromise = null;

/**
 * Instantiate (once) and return the WASM module.
 * @returns {Promise<any>}
 */
export function getNciBackend() {
  if (!modulePromise) {
    modulePromise = createNciModule().catch((error) => {
      // Let a later call retry rather than caching the failure forever.
      modulePromise = null;
      throw new Error(
        'The NCI WASM backend failed to load. Build it with '
        + `"cd docs/compiled && make wasm-nci". (${error && error.message})`);
    });
  }
  return modulePromise;
}

/**
 * Scratch allocation helper: a throw mid-computation still frees the buffers.
 * @template T
 * @param {any} module
 * @param {number[]} sizes byte sizes to allocate
 * @param {(pointers: number[]) => T} body
 * @returns {T}
 */
function withMemory(module, sizes, body) {
  const pointers = [];
  try {
    for (const size of sizes) {
      const ptr = module._malloc(Math.max(size, 8));
      if (!ptr) throw new Error(`NCI backend: failed to allocate ${size} bytes`);
      pointers.push(ptr);
    }
    return body(pointers);
  } finally {
    for (const ptr of pointers) module._free(ptr);
  }
}

// Heap views must be re-read after any allocation: ALLOW_MEMORY_GROWTH can
// detach the old ArrayBuffer.
const i32 = (module, ptr, length) => new Int32Array(module.HEAP32.buffer, ptr, length);
const f32 = (module, ptr, length) => new Float32Array(module.HEAPF32.buffer, ptr, length);
const f64 = (module, ptr, length) => new Float64Array(module.HEAPF64.buffer, ptr, length);

const STATUS_MESSAGES = {
  [-1]: 'invalid input',
  [-2]: 'the voxel vectors are singular',
  [-3]: 'out of memory',
};

function checkStatus(name, status) {
  if (status < 0) {
    throw new Error(`${name} failed: ${STATUS_MESSAGES[status] || `status ${status}`}`);
  }
  return status;
}

/**
 * @typedef {object} NciRequest
 * @property {'scf'|'promolecular'} kind
 * @property {number} nx
 * @property {number} ny
 * @property {number} nz
 * @property {number[][]} voxel 3x3, Angstrom, rows are the voxel vectors
 * @property {boolean} periodic
 * @property {Float32Array} [values] density grid, x fastest (required for 'scf')
 * @property {number} [valueScale] multiplies `values` into e/bohr^3 (default 1)
 * @property {{Z: number[], frac: number[][]}} [atoms] required for
 *   'promolecular'; fractional coordinates w.r.t. the field's own cell
 *   (lattice rows = n_i * voxel[i])
 * @property {{rhoMin?: number, rhoPlot?: number, sCap?: number}} [params]
 */

/**
 * @typedef {object} NciResult
 * @property {Float32Array} s reduced density gradient, sCap where excluded
 * @property {Float32Array} sl2rho sign(lambda2)*rho (e/bohr^3), 0 where excluded
 * @property {number} included number of points inside the rho window
 * @property {string[]} clampedElements symbols of atoms with Z > 18 that were
 *   treated as argon (promolecular only)
 */

/**
 * Compute the two NCI fields for a grid.
 * @param {NciRequest} req
 * @returns {Promise<NciResult>}
 */
export async function computeNci(req) {
  const module = await getNciBackend();
  return computeNciWithModule(module, req);
}

/**
 * Synchronous core of `computeNci` for an already-instantiated module.
 * @param {any} module
 * @param {NciRequest} req
 * @returns {NciResult}
 */
export function computeNciWithModule(module, req) {
  const { nx, ny, nz } = checkGrid(req);
  const kind = req.kind;
  const params = req.params || {};
  const rhoMin = finiteOr(params.rhoMin, NCI_DEFAULTS.rhoMin);
  const rhoPlot = finiteOr(params.rhoPlot, kind === 'scf'
    ? NCI_DEFAULTS.rhoPlotScf : NCI_DEFAULTS.rhoPlotPromolecular);
  const sCap = finiteOr(params.sCap, NCI_DEFAULTS.sCap);
  const voxelBohr = voxelToBohr(req.voxel);
  const points = nx * ny * nz;

  if (kind === 'scf') {
    const values = req.values;
    if (!values || values.length !== points) {
      throw new Error(`computeNci: 'scf' needs ${points} values, got ${values ? values.length : 0}`);
    }
    const valueScale = finiteOr(req.valueScale, 1);
    return withMemory(module, [points * 4, 9 * 8, points * 4, points * 4],
      ([valuesPtr, voxelPtr, sPtr, lPtr]) => {
        f32(module, valuesPtr, points).set(values);
        f64(module, voxelPtr, 9).set(voxelBohr);
        const included = checkStatus('nci_scf', module._nci_scf(
          valuesPtr, nx, ny, nz, voxelPtr, req.periodic ? 1 : 0, valueScale,
          rhoMin, rhoPlot, sCap, sPtr, lPtr));
        return {
          s: new Float32Array(f32(module, sPtr, points)),
          sl2rho: new Float32Array(f32(module, lPtr, points)),
          included,
          clampedElements: [],
        };
      });
  }

  if (kind === 'promolecular') {
    const { Z, xyz, clampedElements } = promolecularAtoms(req, voxelBohr);
    const nAtoms = Z.length;
    return withMemory(module, [nAtoms * 4, nAtoms * 3 * 8, 9 * 8, points * 4, points * 4],
      ([zPtr, xyzPtr, voxelPtr, sPtr, lPtr]) => {
        i32(module, zPtr, nAtoms).set(Z);
        f64(module, xyzPtr, nAtoms * 3).set(xyz);
        f64(module, voxelPtr, 9).set(voxelBohr);
        const included = checkStatus('nci_promolecular', module._nci_promolecular(
          zPtr, xyzPtr, nAtoms, nx, ny, nz, voxelPtr, rhoMin, rhoPlot, sCap, sPtr, lPtr));
        return {
          s: new Float32Array(f32(module, sPtr, points)),
          sl2rho: new Float32Array(f32(module, lPtr, points)),
          included,
          clampedElements,
        };
      });
  }

  throw new Error(`computeNci: unknown kind ${JSON.stringify(kind)}`);
}

/**
 * The promolecular density itself (e/bohr^3) on the request's grid, with the
 * same atoms, periodic images and dMax truncation `computeNci` uses.
 * @param {any} module
 * @param {NciRequest} req `kind` is ignored
 * @returns {Float32Array}
 */
export function promolecularDensityWithModule(module, req) {
  const { nx, ny, nz } = checkGrid(req);
  const voxelBohr = voxelToBohr(req.voxel);
  const points = nx * ny * nz;
  const { Z, xyz } = promolecularAtoms(req, voxelBohr);
  const nAtoms = Z.length;
  return withMemory(module, [nAtoms * 4, nAtoms * 3 * 8, 9 * 8, points * 4],
    ([zPtr, xyzPtr, voxelPtr, outPtr]) => {
      i32(module, zPtr, nAtoms).set(Z);
      f64(module, xyzPtr, nAtoms * 3).set(xyz);
      f64(module, voxelPtr, 9).set(voxelBohr);
      checkStatus('nci_promolecular_density', module._nci_promolecular_density(
        zPtr, xyzPtr, nAtoms, nx, ny, nz, voxelPtr, outPtr));
      return new Float32Array(f32(module, outPtr, points));
    });
}

/**
 * Ascending eigenvalues of a symmetric 3x3 via the C solver (for tests).
 * @param {any} module
 * @param {number[]} a6 [a00, a11, a22, a01, a02, a12]
 * @returns {number[]}
 */
export function sym3EigvalsWithModule(module, a6) {
  return withMemory(module, [6 * 8, 3 * 8], ([aPtr, outPtr]) => {
    f64(module, aPtr, 6).set(a6);
    module._nci_sym3_eigvals(aPtr, outPtr);
    return Array.from(f64(module, outPtr, 3));
  });
}

/* ------------------------------------------------------------------ */

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function checkGrid(req) {
  if (!req || typeof req !== 'object') throw new Error('computeNci: missing request');
  const dims = [req.nx, req.ny, req.nz];
  if (!dims.every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error(`computeNci: bad grid size ${dims.join('x')}`);
  }
  const v = req.voxel;
  if (!Array.isArray(v) || v.length !== 3
      || !v.every((row) => row && row.length === 3 && Array.from(row).every(Number.isFinite))) {
    throw new Error('computeNci: voxel must be a 3x3 array of numbers');
  }
  return { nx: req.nx, ny: req.ny, nz: req.nz };
}

/** Flat row-major voxel matrix in bohr. */
function voxelToBohr(voxel) {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[3 * r + c] = voxel[r][c] / ANGSTROM_PER_BOHR;
  }
  return out;
}

/**
 * Atoms for the promolecular sum as int Z and Cartesian bohr in the grid
 * frame, with Z < 1 dropped and Z > 18 kept for the C to clamp (their symbols
 * are reported). For a periodic grid every image that can reach the cell is
 * added, see `periodicImages`.
 * @param {NciRequest} req
 * @param {Float64Array} voxelBohr
 */
function promolecularAtoms(req, voxelBohr) {
  const atoms = req.atoms;
  if (!atoms || !Array.isArray(atoms.Z) || !Array.isArray(atoms.frac)
      || atoms.Z.length !== atoms.frac.length) {
    throw new Error('computeNci: \'promolecular\' needs atoms {Z, frac} of equal length');
  }
  const n = [req.nx, req.ny, req.nz];
  // Lattice rows in bohr: the field's own cell, n_i * voxel_i.
  const lattice = [0, 1, 2].map((r) => [0, 1, 2].map((c) => n[r] * voxelBohr[3 * r + c]));

  /** @type {Set<string>} */
  const clamped = new Set();
  const Z = [];
  const frac = [];
  for (let a = 0; a < atoms.Z.length; a++) {
    const z = Math.round(Number(atoms.Z[a]));
    const f = atoms.frac[a];
    if (!(z >= 1) || !f || f.length < 3 || !Array.from(f).slice(0, 3).every(Number.isFinite)) continue;
    if (z > PROMOLECULAR_MAX_Z) clamped.add(ELEMENT_SYMBOLS[z] || `Z=${z}`);
    Z.push(z);
    frac.push([f[0], f[1], f[2]]);
  }

  const images = req.periodic ? periodicImages(Z, frac, lattice) : { Z, frac };
  const count = images.Z.length;
  const xyz = new Float64Array(count * 3);
  for (let a = 0; a < count; a++) {
    const [u, v, w] = images.frac[a];
    for (let c = 0; c < 3; c++) {
      xyz[3 * a + c] = u * lattice[0][c] + v * lattice[1][c] + w * lattice[2][c];
    }
  }
  return { Z: Int32Array.from(images.Z), xyz, clampedElements: [...clamped] };
}

/**
 * Expand atoms by lattice translations so that every image that can
 * contribute to a grid point in the cell is present.
 *
 * The C applies Jmol's box test (|dx|, |dy|, |dz| <= dMax), which passes for
 * points up to sqrt(3)*dMax away, so that is the reach used here. An image is
 * kept when its fractional coordinate along each axis lies within
 * reach * |b_i| of [0, 1] (b_i the reciprocal vectors, |b_i| = 1 / interplanar
 * spacing): a necessary condition for being within `reach` of the cell, so
 * nothing that matters is dropped and the few extras are rejected by the box
 * test in the C.
 *
 * @param {number[]} Z
 * @param {number[][]} frac
 * @param {number[][]} lattice rows, bohr
 */
function periodicImages(Z, frac, lattice) {
  const [a, b, c] = lattice;
  const cross = (u, v) => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const bc = cross(b, c);
  const volume = a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2];
  if (!Number.isFinite(volume) || volume === 0) throw new Error('computeNci: singular cell');
  // |b_i| = |a_j x a_k| / V
  const recipLen = [bc, cross(c, a), cross(a, b)].map((v) => Math.hypot(v[0], v[1], v[2]) / Math.abs(volume));

  const outZ = [];
  const outFrac = [];
  for (let n = 0; n < Z.length; n++) {
    const z = Math.min(Z[n], PROMOLECULAR_MAX_Z);
    const reach = Math.sqrt(3) * D_MAX_BOHR[z] * (1 + 1e-9);
    const f = frac[n].map((x) => x - Math.floor(x));
    const ranges = [0, 1, 2].map((i) => {
      const pad = reach * recipLen[i];
      return [Math.ceil(-pad - f[i]), Math.floor(1 + pad - f[i])];
    });
    for (let t0 = ranges[0][0]; t0 <= ranges[0][1]; t0++) {
      for (let t1 = ranges[1][0]; t1 <= ranges[1][1]; t1++) {
        for (let t2 = ranges[2][0]; t2 <= ranges[2][1]; t2++) {
          outZ.push(Z[n]);
          outFrac.push([f[0] + t0, f[1] + t1, f[2] + t2]);
        }
      }
    }
  }
  return { Z: outZ, frac: outFrac };
}
