// The colour ranges of the force and spin bars, owned per structure.
//
// general.forceMin/Max and spinMin/Max are global, but a range belongs to a
// structure: entering one (a load, a row click) gives the bar that
// structure's stored range (ui/ArrowStylePrefs.js, typed or Auto Range) or
// else its Auto Range. This used to happen only when the Forces/Spins window
// built its colour bar, and without redrawing the arrows: with the window
// closed the arrows kept the previous structure's range (or the default
// 0 .. 2), and opening the window could recolour them. Steps of the same
// trajectory keep the range; colours clamp at its ends.
//
// The range only sets colours. Arrow length is the magnitude (or its log,
// against the file's own extent — render/ArrowLength.js), never the range.

import { general } from '../state/store.js';
import { getContainerForStructure } from '../state/structures.js';
import { SPIN_DRAW_THRESHOLD } from '../render/index.js';
import { computeAutoRange, logScaleFloor } from '../utils/index.js';
import { applyUserArrowRange } from './ArrowStylePrefs.js';

const KEYS = {
  force: { min: 'forceMin', max: 'forceMax', scale: 'forceColorScale', list: 'forces' },
  spin: { min: 'spinMin', max: 'spinMax', scale: 'spinColorScale', list: 'spins' },
};

/** Which structure (container) each range currently belongs to. */
const owner = { force: null, spin: null };

/**
 * The magnitudes a bar colours: |v| × species scaling, one per arrow
 * (NaN where none is drawn — no vector, or a spin under the 0.05 μB draw
 * threshold of render/SpinModule.js).
 * @param {'force'|'spin'} kind
 * @param {any[] | null | undefined} vectors structure.forces / .spins (or manual spins)
 */
export function arrowMagnitudes(kind, vectors) {
  return (vectors ?? []).map((a) => {
    const v = a?.vector;
    if (!v) return NaN;
    const mag = Math.hypot(v[0], v[1], v[2]);
    if (kind === 'spin' && mag < SPIN_DRAW_THRESHOLD) return NaN;
    return mag * (a.scaling ?? 1.0);
  });
}

/**
 * Auto Range for a bar on the given scale, with the log floor applied, or
 * null without data.
 * @param {number[]} values
 * @param {boolean} isLog
 * @returns {{min: number, max: number} | null}
 */
export function autoArrowRange(values, isLog) {
  const range = computeAutoRange(values, 0.2, { clampMinAtZero: true, log: isLog });
  if (!range) return null;
  let { min, max } = range;
  if (isLog && min <= 0) min = logScaleFloor(max);
  return min < max ? { min, max } : null;
}

/**
 * Give each bar the range of the structure being entered, once per
 * structure: its stored range, else its Auto Range (current step). Steps of
 * the same trajectory keep the range. Returns true when a range changed.
 * @param {any} structure the displayed frame
 */
export function ensureArrowRanges(structure) {
  const container = structure ? (getContainerForStructure(structure) ?? structure) : null;
  if (!container) return false;
  let changed = false;
  for (const kind of /** @type {Array<'force'|'spin'>} */ (['force', 'spin'])) {
    if (owner[kind] === container) continue;
    owner[kind] = container;
    changed = true;
    if (applyUserArrowRange(kind)) continue;
    const k = KEYS[kind];
    const range = autoArrowRange(arrowMagnitudes(kind, structure[k.list]), general[k.scale] === 'log');
    if (range) {
      general[k.min] = range.min;
      general[k.max] = range.max;
    }
  }
  return changed;
}
