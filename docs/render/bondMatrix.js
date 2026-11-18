// Bond half-cylinder instance matrices, written straight into the
// InstancedMesh's matrix array.
//
// The cylinder geometry runs along +y; each half is placed at its centre,
// rotated from +y onto the bond direction and scaled (radius, halfLen,
// radius). This is exactly what
//   dummy.position.copy(c); dummy.scale.set(r, h, r);
//   dummy.quaternion.setFromUnitVectors(up, dir); dummy.updateMatrix();
//   mesh.setMatrixAt(slot, dummy.matrix);
// produces — the same operations in the same order (three.js
// Quaternion.setFromUnitVectors + normalize, Matrix4.compose) — minus the
// Object3D, the quaternion change callbacks and the matrix copy. At tens of
// thousands of bonds per frame those were most of the bond cost.

import { BOND_RECORD as R } from '../model/Bond.js';

/**
 * Write one half's matrix at `slot` (instance index) of a column-major
 * Float32Array of 4x4 matrices.
 * @param {Float32Array} array instanceMatrix.array
 * @param {number} slot
 * @param {number} cx @param {number} cy @param {number} cz half centre
 * @param {number} dx @param {number} dy @param {number} dz bond direction (any length)
 * @param {number} radius
 * @param {number} halfLen
 */
export function writeBondHalfMatrix(array, slot, cx, cy, cz, dx, dy, dz, radius, halfLen) {
  // Vector3.normalize: divide by the length (or 1 for a zero vector).
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const inv = 1 / len;
  const ux = dx * inv, uy = dy * inv, uz = dz * inv;

  // Quaternion.setFromUnitVectors((0,1,0), u), then normalize.
  let qx, qy, qz, qw;
  const r = uy + 1;
  if (r < 1e-8) {
    // Opposite directions; from = +y has |x| > |z| false.
    qx = 0; qy = 0; qz = 1; qw = 0;
  } else {
    qx = uz; qy = 0; qz = -ux; qw = r;
  }
  let ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  if (ql === 0) {
    qx = 0; qy = 0; qz = 0; qw = 1;
  } else {
    ql = 1 / ql;
    qx *= ql; qy *= ql; qz *= ql; qw *= ql;
  }

  // Matrix4.compose(position, quaternion, scale).
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  const o = slot * 16;
  array[o] = (1 - (yy + zz)) * radius;
  array[o + 1] = (xy + wz) * radius;
  array[o + 2] = (xz - wy) * radius;
  array[o + 3] = 0;
  array[o + 4] = (xy - wz) * halfLen;
  array[o + 5] = (1 - (xx + zz)) * halfLen;
  array[o + 6] = (yz + wx) * halfLen;
  array[o + 7] = 0;
  array[o + 8] = (xz + wy) * radius;
  array[o + 9] = (yz - wx) * radius;
  array[o + 10] = (1 - (xx + yy)) * radius;
  array[o + 11] = 0;
  array[o + 12] = cx;
  array[o + 13] = cy;
  array[o + 14] = cz;
  array[o + 15] = 1;
}

/**
 * Both halves of one bond from its record in a Float64Array (model/Bond.js
 * BOND_RECORD layout: half centres, direction, radius, halfLen at offset `o`)
 * — writeBondHalfMatrix's arithmetic with the rotation computed once (the
 * values are identical to two writeBondHalfMatrix calls). Reading the record
 * in place keeps the doubles unboxed.
 * @param {Float32Array} array
 * @param {number} slotA first half's instance index (the second is slotA + 1)
 * @param {Float64Array} rec @param {number} o
 */
export function writeBondPairMatricesFrom(array, slotA, rec, o) {
  const dx = rec[o + R.DX], dy = rec[o + R.DY], dz = rec[o + R.DZ];
  const radius = rec[o + R.RADIUS], halfLen = rec[o + R.HLEN];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const inv = 1 / len;
  const ux = dx * inv, uy = dy * inv, uz = dz * inv;
  let qx, qy, qz, qw;
  const r = uy + 1;
  if (r < 1e-8) {
    qx = 0; qy = 0; qz = 1; qw = 0;
  } else {
    qx = uz; qy = 0; qz = -ux; qw = r;
  }
  let ql = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  if (ql === 0) {
    qx = 0; qy = 0; qz = 0; qw = 1;
  } else {
    ql = 1 / ql;
    qx *= ql; qy *= ql; qz *= ql; qw *= ql;
  }
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  const m0 = (1 - (yy + zz)) * radius, m1 = (xy + wz) * radius, m2 = (xz - wy) * radius;
  const m4 = (xy - wz) * halfLen, m5 = (1 - (xx + zz)) * halfLen, m6 = (yz + wx) * halfLen;
  const m8 = (xz + wy) * radius, m9 = (yz - wx) * radius, m10 = (1 - (xx + yy)) * radius;
  let a = slotA * 16;
  for (let h = 0; h < 2; h++, a += 16) {
    array[a] = m0; array[a + 1] = m1; array[a + 2] = m2; array[a + 3] = 0;
    array[a + 4] = m4; array[a + 5] = m5; array[a + 6] = m6; array[a + 7] = 0;
    array[a + 8] = m8; array[a + 9] = m9; array[a + 10] = m10; array[a + 11] = 0;
    array[a + 15] = 1;
  }
  a = slotA * 16;
  array[a + 12] = rec[o + R.C1X]; array[a + 13] = rec[o + R.C1Y]; array[a + 14] = rec[o + R.C1Z];
  array[a + 28] = rec[o + R.C2X]; array[a + 29] = rec[o + R.C2Y]; array[a + 30] = rec[o + R.C2Z];
}

const scratch = new Float64Array(R.STRIDE);

/**
 * writeBondPairMatricesFrom for loose numbers.
 * @param {Float32Array} array
 * @param {number} slotA first half's instance index (the second is slotA + 1)
 * @param {number} ax @param {number} ay @param {number} az first half centre
 * @param {number} bx @param {number} by @param {number} bz second half centre
 * @param {number} dx @param {number} dy @param {number} dz bond direction (any length)
 * @param {number} radius
 * @param {number} halfLen
 */
export function writeBondPairMatrices(array, slotA, ax, ay, az, bx, by, bz, dx, dy, dz, radius, halfLen) {
  scratch[R.C1X] = ax; scratch[R.C1Y] = ay; scratch[R.C1Z] = az;
  scratch[R.C2X] = bx; scratch[R.C2Y] = by; scratch[R.C2Z] = bz;
  scratch[R.DX] = dx; scratch[R.DY] = dy; scratch[R.DZ] = dz;
  scratch[R.RADIUS] = radius; scratch[R.HLEN] = halfLen;
  writeBondPairMatricesFrom(array, slotA, scratch, 0);
}

/**
 * Collapse one half (a zero-scale matrix at the origin) — what hideSingleBond
 * writes through a dummy with scale 0 and the identity rotation.
 * @param {Float32Array} array @param {number} slot
 */
export function writeHiddenBondHalf(array, slot) {
  const o = slot * 16;
  for (let k = 0; k < 15; k++) array[o + k] = 0;
  array[o + 15] = 1;
}

/**
 * Both halves of a model/Bond at slots 2*index and 2*index+1, from its record.
 * @param {Float32Array} array @param {number} index @param {any} bond
 */
export function writeBondMatrices(array, index, bond) {
  writeBondPairMatricesFrom(array, index * 2, bond.recordArray, bond.recordOffset);
}
