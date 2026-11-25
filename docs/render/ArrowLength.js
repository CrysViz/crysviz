// "Log length" for force and spin arrows: the log of the magnitude, placed
// against the file's OWN extent — the smallest and largest magnitude over
// every step of the file — never against the colour bar's range. It used to
// be mapped through the colour range, so Auto Range, a typed limit or a new
// range on reload rescaled every arrow. With the file's extent, an arrow's
// length depends only on its magnitude: the same force has the same length
// on every step and whatever the colour limits.

import { getContainerForStructure } from '../state/structures.js';

const LEN_MIN = 0.3; // Å at the file's smallest magnitude
const LEN_MAX = 2.0; // Å at its largest
// The extent covers at most this many decades below the largest magnitude
// (the colour Auto Range's cap): a 1e-9 eV/Å of numerical noise would
// otherwise squeeze every real force into the top of the scale.
const MAX_DECADES = 4;

/** container -> Map(`${kind}:${threshold}` -> { frames, min, max }) */
const cache = new WeakMap();

/**
 * Smallest and largest |v| (raw, above `threshold`) over every step of the
 * structure's file, plus the shown step's own vectors (which may have been
 * edited). Frames read asynchronously from disk and not loaded yet are
 * skipped. Cached per file and step count.
 * @param {'force'|'spin'} kind
 * @param {any} structure the displayed frame
 * @param {number} [threshold] magnitudes below this aren't drawn (spins: 0.05 μB)
 * @returns {{min: number, max: number} | null}
 */
export function fileMagnitudeExtent(kind, structure, threshold = 0) {
  let min = Infinity;
  let max = 0;
  const add = (m) => {
    if (!(m > 0) || m < threshold) return;
    if (m < min) min = m;
    if (m > max) max = m;
  };
  const listKey = kind === 'force' ? 'forces' : 'spins';
  const addList = (list) => {
    for (const a of list ?? []) {
      const v = a?.vector;
      if (v) add(Math.hypot(v[0], v[1], v[2]));
    }
  };

  const container = structure ? getContainerForStructure(structure) : null;
  if (container) {
    const store = container.store;
    const frames = typeof store?.getFramePhysics === 'function' ? (container.frameCount ?? store.frameCount ?? 0) : (container.structures?.length ?? 0);
    const key = `${kind}:${threshold}`;
    let byKind = cache.get(container);
    if (!byKind) cache.set(container, byKind = new Map());
    let hit = byKind.get(key);
    if (!hit || hit.frames !== frames) {
      const before = [min, max];
      if (typeof store?.getFramePhysics === 'function') {
        for (let f = 0; f < frames; f++) {
          const ph = store.getFramePhysics(f);
          if (!ph || typeof ph.then === 'function') continue;
          const arr = kind === 'force' ? ph.forces : ph.spinVectors;
          if (!arr) continue;
          for (let i = 0; i + 2 < arr.length; i += 3) add(Math.hypot(arr[i], arr[i + 1], arr[i + 2]));
        }
      } else {
        for (const s of container.structures ?? []) addList(s?.[listKey]);
      }
      hit = { frames, min, max };
      byKind.set(key, hit);
      [min, max] = before;
    }
    add(hit.min);
    add(hit.max);
  }
  addList(structure?.[listKey]);
  if (!(max > 0) || !Number.isFinite(min)) return null;
  return { min: Math.max(min, max * 10 ** -MAX_DECADES), max };
}

/**
 * Arrow length in Å (before Global Scaling) for a magnitude on "log length":
 * LEN_MIN at the extent's smallest magnitude, LEN_MAX at its largest,
 * logarithmic in between; clamped at both ends.
 * @param {number} mag
 * @param {{min: number, max: number} | null} extent from fileMagnitudeExtent
 */
export function logArrowLength(mag, extent) {
  if (!extent || !(mag > 0)) return LEN_MIN;
  const lo = Math.log10(extent.min);
  const hi = Math.log10(extent.max);
  if (!(hi > lo)) return (LEN_MIN + LEN_MAX) / 2;
  const t = Math.min(Math.max((Math.log10(mag) - lo) / (hi - lo), 0), 1);
  return LEN_MIN + t * (LEN_MAX - LEN_MIN);
}
