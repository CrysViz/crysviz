/**
 * ASE ULM container reader — the format of ASE `.traj` files (ase/io/ulm.py),
 * over the file's bytes in memory.
 *
 * Layout:
 *    0: "- of Ulm"            magic, 8 bytes ascii ("AFFormat" for old files)
 *    8: tag                   16 bytes ascii ("ASE-Trajectory" for .traj)
 *   24: version  int64
 *   32: nitems   int64
 *   40: pos0     int64        file offset of the offsets table
 *   pos0: int64[nitems]       file offset of every item (one per frame)
 *   item: int64 n, then n bytes of JSON; "name." keys hold either a nested
 *         dict (a child writer, e.g. "calculator.") or
 *         {"ndarray": [shape, dtype, offset]} with an ABSOLUTE file offset.
 *         Integers are little-endian unless the item says
 *         "_little_endian": false.
 *
 * An ASE Trajectory writes the constant data (numbers, pbc, ...) into the
 * first item and positions / cell / calculator results into every item; a
 * frame's elements come from the last item that carried `numbers`
 * (variable-composition trajectories write them again).
 *
 * Frames come out as TrajectoryFrameStore records (FramePhysics): fractional
 * positions (not wrapped — an MD run's continuous motion stays continuous),
 * forces, energy, stress (ASE's tension-positive Voigt, converted by the
 * caller), magnetic moments as spins.
 *
 * Adapted from the large-trajectory branch's file-backed reader (same
 * layout handling), synchronous over an ArrayBuffer since the loader reads
 * the whole file.
 */

export const ULM_MAGIC = '- of Ulm';
/** The legacy AFF magic ASE also accepts. */
const AFF_MAGIC = 'AFFormat';

/** Atomic numbers -> symbols, index = Z. */
export const SYMBOLS = ['X',
  'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar',
  'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr',
  'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe',
  'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu',
  'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn',
  'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr',
  'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og'];

const asciiDecoder = new TextDecoder('ascii');
const utf8Decoder = new TextDecoder('utf-8');

/**
 * Does this file start like a ULM file?
 * @param {Uint8Array} bytes
 */
export function isUlm(bytes) {
  if (!bytes || bytes.byteLength < 8) return false;
  const text = asciiDecoder.decode(bytes.subarray(0, 8));
  return text === ULM_MAGIC || text === AFF_MAGIC;
}

/** int64 at byte `at` as a Number (file offsets fit comfortably). */
function int64At(dv, at, littleEndian = true) {
  return Number(dv.getBigInt64(at, littleEndian));
}

const ITEM_SIZES = { float64: 8, float32: 4, int64: 8, int32: 4, int16: 2, int8: 1, uint8: 1, bool: 1 };

/** 3x3 from a flat row-major 9-array or a nested [[..],[..],[..]]. */
function toMatrix3(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length === 3 && Array.isArray(value[0])) return value.map((r) => r.map(Number));
  const flat = Array.from(value, Number);
  if (flat.length !== 9) return null;
  return [flat.slice(0, 3), flat.slice(3, 6), flat.slice(6, 9)];
}

/** Inverse of a 3x3 (rows), or null when singular. */
function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-12)) return null;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  return [[A / det, D / det, G / det], [B / det, E / det, H / det], [C / det, F / det, I / det]];
}

/**
 * Cartesian -> fractional for a flat [n*3] array and a row-vector lattice
 * (x = f · L, so f = x · L^-1).
 * @param {Float64Array} cart @param {number[][]} lattice
 */
function cartesianToFractional(cart, lattice) {
  const inv = /** @type {number[][]} */ (invert3(lattice));
  const out = new Float64Array(cart.length);
  for (let a = 0; a < cart.length; a += 3) {
    const x = cart[a], y = cart[a + 1], z = cart[a + 2];
    out[a] = x * inv[0][0] + y * inv[1][0] + z * inv[2][0];
    out[a + 1] = x * inv[0][1] + y * inv[1][1] + z * inv[2][1];
    out[a + 2] = x * inv[0][2] + y * inv[1][2] + z * inv[2][2];
  }
  return out;
}

/**
 * A box around Cartesian positions for a frame without a usable cell (a
 * molecule, pbc=False): cubic, the extent plus a margin, positions shifted to
 * its centre — the same idea as ReadeXYZModule's generateBox.
 * @param {Float64Array} cart
 */
function boxAround(cart) {
  const n = cart.length / 3;
  const com = [0, 0, 0];
  for (let a = 0; a < n; a++) for (let k = 0; k < 3; k++) com[k] += cart[a * 3 + k] / n;
  let maxMag = 0;
  for (let a = 0; a < n; a++) for (let k = 0; k < 3; k++) maxMag = Math.max(maxMag, Math.abs(cart[a * 3 + k] - com[k]));
  const size = 2 * (maxMag + 2);
  const out = new Float64Array(cart.length);
  for (let a = 0; a < n; a++) for (let k = 0; k < 3; k++) out[a * 3 + k] = cart[a * 3 + k] - com[k] + size / 2;
  return { lattice: [[size, 0, 0], [0, size, 0], [0, 0, size]], cart: out };
}

/** Voigt [xx, yy, zz, yz, xz, xy] -> 3x3. */
function voigtToTensor(v) {
  if (!v) return null;
  const arr = Array.from(v, Number);
  if (arr.length === 9) return [arr.slice(0, 3), arr.slice(3, 6), arr.slice(6, 9)];
  if (arr.length !== 6) return null;
  const [xx, yy, zz, yz, xz, xy] = arr;
  return [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
}

/**
 * Read every frame of an ASE trajectory.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{tag: string, frames: Array<{elements: string[], lattice: number[][], positions: Float64Array,
 *   forces: Float64Array | null, spins: Float64Array | null, energy: number | null,
 *   stress: number[][] | null}>}}
 */
export function readUlmTrajectory(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  if (!isUlm(bytes) || bytes.byteLength < 48) throw new Error('Not an ASE trajectory (ULM) file');
  const tag = asciiDecoder.decode(bytes.subarray(8, 24)).trim();
  const nitems = int64At(dv, 32);
  const pos0 = int64At(dv, 40);
  if (!(nitems >= 0) || !(pos0 >= 48) || pos0 + nitems * 8 > bytes.byteLength) {
    throw new Error('ASE trajectory: corrupt header');
  }
  if (nitems === 0) throw new Error('ASE trajectory: the file holds no frames');

  const readItem = (offset) => {
    const n = int64At(dv, offset);
    if (!(n > 0 && offset + 8 + n <= bytes.byteLength)) throw new Error(`ASE trajectory: bad item at ${offset}`);
    const data = JSON.parse(utf8Decoder.decode(bytes.subarray(offset + 8, offset + 8 + n)));
    const littleEndian = data._little_endian !== false;
    return { data, littleEndian };
  };
  /** A plain value, a child dict, or an ndarray reference under `name`. */
  const get = (data, name) => {
    if (!data) return null;
    if (name in data) return { kind: 'value', value: data[name] };
    const dotted = data[`${name}.`];
    if (dotted === undefined) return null;
    if (dotted && typeof dotted === 'object' && Array.isArray(dotted.ndarray)) return { kind: 'ndarray', value: dotted.ndarray };
    return { kind: 'child', value: dotted };
  };
  const readArray = (ref, littleEndian) => {
    const [shape, dtype, offset] = ref;
    const count = shape.reduce((a, b) => a * b, 1);
    const size = ITEM_SIZES[dtype];
    if (!size) throw new Error(`ASE trajectory: unsupported dtype ${dtype}`);
    if (offset + count * size > bytes.byteLength) throw new Error('ASE trajectory: array runs past the end of the file');
    const out = new Float64Array(count);
    switch (dtype) {
      case 'float64': for (let i = 0; i < count; i++) out[i] = dv.getFloat64(offset + i * 8, littleEndian); break;
      case 'float32': for (let i = 0; i < count; i++) out[i] = dv.getFloat32(offset + i * 4, littleEndian); break;
      case 'int64': for (let i = 0; i < count; i++) out[i] = Number(dv.getBigInt64(offset + i * 8, littleEndian)); break;
      case 'int32': for (let i = 0; i < count; i++) out[i] = dv.getInt32(offset + i * 4, littleEndian); break;
      case 'int16': for (let i = 0; i < count; i++) out[i] = dv.getInt16(offset + i * 2, littleEndian); break;
      case 'int8': for (let i = 0; i < count; i++) out[i] = dv.getInt8(offset + i); break;
      default: for (let i = 0; i < count; i++) out[i] = bytes[offset + i]; // uint8 / bool
    }
    return out;
  };
  const value = (entry, littleEndian) => (entry.kind === 'ndarray' ? readArray(entry.value, littleEndian) : entry.value);

  // Same-composition frames share one elements array by reference.
  const interned = new Map();
  const intern = (elements) => {
    const key = elements.join('\0');
    const shared = interned.get(key);
    if (shared) return shared;
    interned.set(key, elements);
    return elements;
  };

  const frames = [];
  let elements = null;
  for (let f = 0; f < nitems; f++) {
    const { data, littleEndian } = readItem(int64At(dv, pos0 + f * 8));
    const numbers = get(data, 'numbers');
    if (numbers) {
      elements = intern(Array.from(value(numbers, littleEndian), (z) => SYMBOLS[Math.round(z)] || 'X'));
    }
    if (!elements) throw new Error('ASE trajectory: no atomic numbers in the first frame');
    const n = elements.length;
    const posRef = get(data, 'positions');
    if (!posRef) throw new Error(`ASE trajectory: frame ${f + 1} has no positions`);
    let cart = Float64Array.from(value(posRef, littleEndian));
    if (cart.length !== n * 3) throw new Error(`ASE trajectory: frame ${f + 1} has ${cart.length / 3} positions for ${n} atoms`);

    const cellEntry = get(data, 'cell');
    let lattice = cellEntry ? toMatrix3(value(cellEntry, littleEndian)) : null;
    if (!lattice || !invert3(lattice)) {
      const boxed = boxAround(cart);
      lattice = boxed.lattice;
      cart = boxed.cart;
    }
    const positions = cartesianToFractional(cart, lattice);

    let forces = null, energy = null, stress = null;
    const calc = get(data, 'calculator');
    if (calc && calc.kind === 'child') {
      const fe = get(calc.value, 'forces');
      if (fe) {
        const arr = Float64Array.from(value(fe, littleEndian));
        if (arr.length === n * 3) forces = arr;
      }
      const e = get(calc.value, 'energy');
      if (e && Number.isFinite(Number(value(e, littleEndian)))) energy = Number(value(e, littleEndian));
      const s = get(calc.value, 'stress');
      if (s) stress = voigtToTensor(value(s, littleEndian));
    }

    // Magnetic moments (the atoms' initial ones, else the calculator's): a
    // scalar per atom is a z-moment, a 3-vector per atom is taken as is.
    let spins = null;
    const m = get(data, 'magmoms') || (calc && calc.kind === 'child' ? get(calc.value, 'magmoms') : null);
    if (m) {
      const arr = value(m, littleEndian);
      if (arr?.length === n) {
        spins = new Float64Array(n * 3);
        for (let a = 0; a < n; a++) spins[a * 3 + 2] = Number(arr[a]);
      } else if (arr?.length === n * 3) {
        spins = Float64Array.from(arr, Number);
      }
    }

    frames.push({ elements, lattice, positions, forces, spins, energy, stress });
  }
  return { tag, frames };
}
