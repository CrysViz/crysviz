// Spin reference-frame + decorative-rotation math, shared by the readers
// (io/ReadOutcarModule.js, io/ReadPWSCFoutModule.js) and the Spins panel
// (ui/SpinPanel.js).
//
// The problem this solves: a magnetic moment is a Cartesian vector, but codes
// don't always report its components in the global Cartesian frame. VASP in
// particular reports the on-site magnetisation in the frame whose z-axis is
// SAXIS (INCAR tag, default (0,0,1)), so a non-default SAXIS means the printed
// (mx,my,mz) are NOT global x/y/z and must be rotated back. We keep every
// spin's as-read components in `spin.rawVector` and derive the rendered
// `spin.vector` by re-projecting from raw, so switching frames in the UI is
// always lossless (never rotating already-rotated data).

import { multiplyMatVec } from '../math/backend-js.js';

const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** A·B for two 3×3 row-major matrices. */
export function multiply3x3(A, B) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return out;
}

/**
 * Rotation mapping a vector expressed in VASP's SAXIS-local frame into the
 * global Cartesian frame. This is the exact transform from the VASP wiki
 * (SAXIS page):
 *
 *   m_global = R(alpha,beta) · m_saxis
 *   R = [ cosB·cosA   -sinA   sinB·cosA ]
 *       [ cosB·sinA    cosA   sinB·sinA ]
 *       [ -sinB         0     cosB      ]
 *
 * with SAXIS = (sinB·cosA, sinB·sinA, cosB): beta the polar angle from +z,
 * alpha the azimuth. At SAXIS=(0,0,1) this is the identity, so default files
 * are untouched. (A zero/degenerate SAXIS also collapses to the identity.)
 *
 * @param {number[]} saxis
 * @returns {number[][]}
 */
export function saxisToMatrix(saxis) {
  const sx = saxis?.[0] ?? 0, sy = saxis?.[1] ?? 0, sz = saxis?.[2] ?? 1;
  if (sx === 0 && sy === 0 && sz === 0) return IDENTITY.map(r => [...r]);
  const beta = Math.atan2(Math.hypot(sx, sy), sz); // polar angle from +z
  const alpha = Math.atan2(sy, sx);                // azimuth in the xy-plane
  const cA = Math.cos(alpha), sA = Math.sin(alpha);
  const cB = Math.cos(beta), sB = Math.sin(beta);
  return [
    [cB * cA, -sA, sB * cA],
    [cB * sA, cA, sB * sA],
    [-sB, 0, cB],
  ];
}

/**
 * Interpret raw components as fractions along the (normalised) crystal axes
 * a,b,c and return the matrix that takes them to Cartesian — same convention
 * as io/cif/mcif_parser.js's crystal_to_cartesian (directions only, lengths
 * normalised out, since a moment's magnitude is physical and shouldn't be
 * rescaled by the cell edge lengths).
 *
 * @param {number[][]} lattice rows a,b,c in Cartesian
 * @returns {number[][]}
 */
export function crystalToMatrix(lattice) {
  if (!lattice || lattice.length < 3) return IDENTITY.map(r => [...r]);
  const norm = (v) => {
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  const a = norm(lattice[0]), b = norm(lattice[1]), c = norm(lattice[2]);
  // Columns are the axis directions, so M·[fa,fb,fc] = fa·â + fb·b̂ + fc·ĉ.
  return [
    [a[0], b[0], c[0]],
    [a[1], b[1], c[1]],
    [a[2], b[2], c[2]],
  ];
}

/**
 * A purely decorative global rotation (intrinsic-free extrinsic XYZ order:
 * Rz·Ry·Rx) built from three angles in DEGREES — the Spins panel's "visual
 * rotation" sliders. Rotates the already-physical vectors for presentation
 * only; it does not change what the data means.
 *
 * @returns {number[][]}
 */
export function eulerToMatrix(rxDeg, ryDeg, rzDeg) {
  const d2r = Math.PI / 180;
  const rx = (rxDeg || 0) * d2r, ry = (ryDeg || 0) * d2r, rz = (rzDeg || 0) * d2r;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return multiply3x3(Rz, multiply3x3(Ry, Rx));
}

/**
 * Rotation matrix for a quaternion [x,y,z,w] (the Spins panel trackball's
 * accumulated orientation). Row-major, same layout as the other matrices here.
 *
 * @param {number[]} q
 * @returns {number[][]}
 */
export function quatToMatrix(q) {
  const x = q?.[0] ?? 0, y = q?.[1] ?? 0, z = q?.[2] ?? 0, w = q?.[3] ?? 1;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ];
}

/**
 * The frame matrix (raw → global Cartesian) selected by the panel dropdown.
 *
 *  - 'cartesian': components are already global Cartesian (identity).
 *  - 'file'     : re-project from the SAXIS the file was written with.
 *  - 'custom'   : re-project from a user-entered SAXIS.
 *  - 'crystal'  : interpret components along the crystal axes.
 *
 * @param {string} mode
 * @param {{fileSaxis?:number[], customSaxis?:number[], lattice?:number[][]}} [opts]
 * @returns {number[][]}
 */
export function frameMatrix(mode, { fileSaxis = [0, 0, 1], customSaxis = [0, 0, 1], lattice = null } = {}) {
  switch (mode) {
    case 'cartesian': return IDENTITY.map(r => [...r]);
    case 'custom': return saxisToMatrix(customSaxis);
    case 'crystal': return crystalToMatrix(lattice);
    case 'file':
    default: return saxisToMatrix(fileSaxis);
  }
}

/**
 * Parse a VASP-style SAXIS line ("0 0 1", "SAXIS = 0.0 0.0 1.0", commas ok)
 * into a 3-vector, or null if it doesn't hold three finite numbers.
 *
 * @param {string} text
 * @returns {number[]|null}
 */
export function parseSaxis(text) {
  if (typeof text !== 'string') return null;
  const nums = text.replace(/saxis|=|,/gi, ' ').trim().split(/\s+/).map(Number).filter(Number.isFinite);
  return nums.length >= 3 ? nums.slice(0, 3) : null;
}

/**
 * Recompute every spin's rendered `spin.vector` from its immutable
 * `spin.rawVector`, applying the chosen reference frame and then the optional
 * decorative rotation. Structures whose spins predate rawVector fall back to
 * the current vector as raw, so this is safe to call on any structure.
 *
 * @param {any} structure
 * @param {{mode?:string, customSaxis?:number[], visualRot?:number[], visualMatrix?:number[][]}} [opts]
 */
export function applySpinFrame(structure, opts = {}) {
  if (!structure?.spins?.length) return;
  const mode = opts.mode ?? 'file';
  const fileSaxis = structure.spinFrame?.fileSaxis ?? [0, 0, 1];
  const F = frameMatrix(mode, {
    fileSaxis,
    customSaxis: opts.customSaxis ?? [0, 0, 1],
    lattice: structure.lattice,
  });
  // The decorative rotation: a precomputed matrix (the panel trackball's
  // quaternion) wins; otherwise fall back to the legacy Euler triple.
  let V = opts.visualMatrix ?? null;
  if (!V) {
    const rot = opts.visualRot ?? [0, 0, 0];
    if (rot[0] || rot[1] || rot[2]) V = eulerToMatrix(rot[0], rot[1], rot[2]);
  }
  const M = V ? multiply3x3(V, F) : F;

  for (const spin of structure.spins) {
    let raw = spin.rawVector;
    if (!raw || raw.length < 3) {
      // No stored raw (a spin built by a path that predates rawVector, or one
      // whose raw was lost in a copy). Pin the CURRENT vector as raw ONCE, so
      // every subsequent call transforms from this fixed source instead of
      // re-reading the already-transformed vector — without this, each frame/
      // rotation change compounds on the last (arrows spiral and never return).
      if (!spin.vector || spin.vector.length < 3) continue;
      raw = [...spin.vector];
      spin.rawVector = raw;
    }
    spin.vector = multiplyMatVec(M, raw);
  }
}
