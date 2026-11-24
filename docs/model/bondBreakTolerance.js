// Pure helpers of the bond breaking tolerance used during MD /
// trajectory playback: render/BondBreakTolerance.js (the setting, the bond memory
// across full rebuilds), render/PlaybackBondsModule.js (bonds per frame) and
// render/PolyhedraFrameModule.js (polyhedron corners per frame, the merge at
// a full rebuild). No imports, no DOM: unit-tested in
// tools/unittest/bondBreakTolerance.test.mjs.
//
// THE RULE. A bond, or a polyhedron corner, that exists keeps existing while
// its length is within cutoff × (1 + tol); one that does not exist forms
// once its length is within the plain cutoff. tol = 0 is the strict rule.

/**
 * Does a pair exist this frame? `wasOn`: it existed last frame.
 * `holdFactorSq` = (1 + tol)².
 * @param {boolean | number} wasOn @param {number} distSq
 * @param {number} cutSq @param {number} holdFactorSq
 */
export function pairExists(wasOn, distSq, cutSq, holdFactorSq) {
  return distSq <= (wasOn ? cutSq * holdFactorSq : cutSq);
}

let PERM = new Int32Array(64);
let TMP = new Float64Array(192);
/** @type {any[]} */
const TMP_PLAIN = [];

/**
 * Stable partition of the slots start … start+count−1 of every array in
 * `arrays`: the slots whose keep[k] is set first (in their order), the
 * others after (in theirs). Every array is permuted the same way; an array
 * with a stride moves `stride` values per slot. Typed or plain arrays (a
 * plain one may hold objects). Scratch grown once, no allocation otherwise.
 * @param {ArrayLike<number>} keep keep[k] for slot start+k
 * @param {number} start @param {number} count
 * @param {{data: any, stride?: number}[]} arrays
 * @returns {number} the number of kept slots (now at the front)
 */
export function compactActive(keep, start, count, arrays) {
  if (PERM.length < count) PERM = new Int32Array(Math.max(count, 2 * PERM.length));
  let na = 0;
  for (let k = 0; k < count; k++) if (keep[k]) PERM[na++] = k;
  let m = na;
  for (let k = 0; k < count; k++) if (!keep[k]) PERM[m++] = k;
  for (let a = 0; a < arrays.length; a++) {
    const data = arrays[a].data;
    if (!data) continue;
    const stride = arrays[a].stride ?? 1;
    const need = count * stride;
    let tmp;
    if (Array.isArray(data)) tmp = TMP_PLAIN;
    else {
      if (TMP.length < need) TMP = new Float64Array(Math.max(need, 2 * TMP.length));
      tmp = TMP;
    }
    for (let k = 0; k < count; k++) {
      const from = (start + PERM[k]) * stride, to = k * stride;
      for (let s = 0; s < stride; s++) tmp[to + s] = data[from + s];
    }
    const base = start * stride;
    for (let q = 0; q < need; q++) data[base + q] = tmp[q];
    if (tmp === TMP_PLAIN) TMP_PLAIN.length = 0;
  }
  return na;
}

/** Largest |component| a relative image shift may have in a bond key. */
const KEY_SHIFT_MAX = 7;

/**
 * Number key of a bond between source atoms a and b whose second end is
 * the first end's image shifted by (rx, ry, rz) cells relative to the
 * source positions: the same key for (b, a, −r). -1 when a shift is too
 * large to encode (never in practice: image shifts are ±3 at most).
 * @param {number} nSrc number of source atoms
 * @param {number} a @param {number} b
 * @param {number} rx @param {number} ry @param {number} rz
 */
export function bondPairKey(nSrc, a, b, rx, ry, rz) {
  if (a > b || (a === b && (rx < 0 || (rx === 0 && (ry < 0 || (ry === 0 && rz < 0)))))) {
    const t = a; a = b; b = t;
    rx = -rx; ry = -ry; rz = -rz;
  }
  if (Math.abs(rx) > KEY_SHIFT_MAX || Math.abs(ry) > KEY_SHIFT_MAX || Math.abs(rz) > KEY_SHIFT_MAX) return -1;
  return (a * nSrc + b) * 4096 + (rx + 8) * 256 + (ry + 8) * 16 + (rz + 8);
}

/** String key of a corner: its source atom and periodic image. */
export function cornerKey(src, ix, iy, iz) {
  return `${src}:${ix},${iy},${iz}`;
}

/**
 * Corners of a polyhedron after a full rebuild under the tolerance: the
 * fresh (strict) corners, plus every previously active corner whose
 * current length is still within its cutoff × (1 + tol) and which is not
 * already among the fresh ones (same source atom and periodic image).
 * Fresh corners keep their order; held ones follow in theirs.
 * @template T
 * @param {(T & {key: string})[]} fresh
 * @param {(T & {key: string, distSq: number, cutSq: number})[]} held
 * @param {number} holdFactorSq (1 + tol)²
 * @returns {T[]}
 */
export function mergeCorners(fresh, held, holdFactorSq) {
  const seen = new Set(fresh.map((c) => c.key));
  const out = fresh.slice();
  for (const c of held) {
    if (seen.has(c.key) || !(c.cutSq > 0) || !pairExists(true, c.distSq, c.cutSq, holdFactorSq)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

/**
 * Corners kept for return after a full rebuild: of a polyhedron's previous
 * corners, those not in use in the merged result (`inUse`, keys) whose bond
 * is broken now — beyond the cutoff (`cutSq`), within `reachSq`, near enough
 * to come back within the cutoff during the next frames. A corner within the
 * cutoff that the search left out was left out for another reason (the
 * Voronoi selection, the chemical filter) and is not kept. One per source
 * atom and periodic image.
 * @template T
 * @param {Iterable<string>} inUse keys of the corners in use
 * @param {(T & {key: string, distSq: number, cutSq: number, reachSq: number})[]} corners
 * @returns {T[]}
 */
export function reservedCorners(inUse, corners) {
  const seen = new Set(inUse);
  const out = [];
  for (const c of corners) {
    if (seen.has(c.key) || !(c.distSq > c.cutSq) || !(c.distSq <= c.reachSq)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

/**
 * Is a previous cage still held together? Every one of its hull edges
 * (captured at build) must be within that pair's cutoff × (1 + tol).
 * @param {ArrayLike<number>} edgeDistSq per edge, current length²
 * @param {ArrayLike<number>} edgeCutSq per edge, cutoff²
 * @param {number} holdFactorSq
 */
export function cageHeld(edgeDistSq, edgeCutSq, holdFactorSq) {
  if (!edgeDistSq.length) return false;
  for (let e = 0; e < edgeDistSq.length; e++) {
    if (!(edgeCutSq[e] > 0) || !pairExists(true, edgeDistSq[e], edgeCutSq[e], holdFactorSq)) return false;
  }
  return true;
}
