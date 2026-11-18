// Shared "Auto Range" formula for every magnitude-driven color bar (Forces,
// Spins, Atoms-by-force, Bonds-by-length): pads the data's own min/max by
// `pad` (default 20%) of its span on each side, so the bar's displayed
// extremes sit a bit past the actual data instead of clipping right at the
// edges (a value exactly at the old max reads as "maxed out"/off-scale
// otherwise, both visually and in a log-scale bar's tick spacing). On a
// log-scale bar the padding is in decades (opts.log below).

// Rounds to 3 significant figures (not 3 decimal places) — a plain
// toFixed(3)-style round would print "0.000" for anything under a
// millinewton-ish scale (log-scale force/spin ranges routinely are), losing
// every digit instead of keeping the first non-zero one and a couple after
// it. toPrecision naturally does this: toPrecision(3) on 0.0000481 gives
// "0.0000481" (3 sig figs starting at the first non-zero digit), not "0".
export function roundToSigFigs(value, sigFigs = 3) {
  if (!Number.isFinite(value) || value === 0) return 0;
  return parseFloat(value.toPrecision(sigFigs));
}

// Strip float noise (0.1 * 3 = 0.30000000000000004) from a value that is
// meant to be a clean multiple of a nice step.
const clean = (v) => parseFloat(v.toPrecision(12));

/** The largest 1, 2 or 5 × 10^k at or below v (v > 0). */
export function niceFloor125(v) {
  const e = Math.floor(Math.log10(v));
  for (const m of [5, 2, 1]) {
    const c = m * 10 ** e;
    if (c <= v * (1 + 1e-9)) return clean(c);
  }
  return clean(5 * 10 ** (e - 1));
}

/** The smallest 1, 2 or 5 × 10^k at or above v (v > 0). */
export function niceCeil125(v) {
  const e = Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) {
    const c = m * 10 ** e;
    if (c >= v * (1 - 1e-9)) return clean(c);
  }
  return clean(10 ** (e + 1));
}

// A log bar spans at most this many decades of DATA below the largest value
// (plus the padding): a value of 1e-9 next to forces of 0.1 is numerical
// noise, and ranging over it spent most of the bar on nothing. Smaller
// values sit on the bottom colour; a limit typed by hand still goes lower.
const MAX_LOG_DATA_DECADES = 4;

/**
 * @param {number[]} values raw magnitudes (not yet filtered/finite-checked)
 * @param {number} [pad] fraction of the data span to pad on each side
 * @param {{clampMinAtZero?: boolean, log?: boolean}} [opts] clampMinAtZero — floor the
 *   padded min at 0 rather than letting it pad below. For quantities that
 *   can never be negative (force/spin magnitude, bond length), a small
 *   data-min close to 0 would otherwise pad into negative territory, which
 *   makes no physical sense — e.g. a spin magnitude of -0.8 μB. Off by
 *   default: PlanesPanel.js's scalar field values (the one other caller)
 *   can genuinely be negative.
 *   log — the colour bar is on a log scale: range over the positive values
 *   only (at most MAX_LOG_DATA_DECADES below the largest), pad by half of
 *   `pad` of their span in DECADES (at least 0.05 decade), then round out
 *   to 1, 2 or 5 × 10^k, which adds up to ~0.4 decade more. So the bar
 *   starts just below the smallest value at a readable number (0.0005,
 *   not 0.000481) instead of at a linear-padded 0 that every log bar then
 *   replaced with an arbitrary 0.01. Falls back to the linear range when
 *   there is no positive value.
 *   Linear ranges are rounded out to a grid of a tenth of their span
 *   (1, 2 or 5 × 10^k): 0 .. 0.011 rather than 0 .. 0.0101.
 * @returns {{min: number, max: number} | null} null if there's no usable
 *   (finite) data to range over at all.
 */
export function computeAutoRange(values, pad = 0.2, { clampMinAtZero = false, log = false } = {}) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;

  if (log) {
    const positive = finite.filter((v) => v > 0);
    if (positive.length) {
      const hi = Math.log10(Math.max(...positive));
      const lo = Math.max(Math.log10(Math.min(...positive)), hi - MAX_LOG_DATA_DECADES);
      const span = hi - lo;
      const p = Math.max(0.5 * pad * span, 0.05);
      return { min: niceFloor125(10 ** (lo - p)), max: niceCeil125(10 ** (hi + p)) };
    }
  }

  const dataMin = Math.min(...finite);
  const dataMax = Math.max(...finite);
  const span = dataMax - dataMin;

  // A single distinct value (or all identical) has no span to pad a
  // percentage of — fall back to a small fixed absolute pad instead of
  // returning a zero-width range no color bar (especially log-scale) can
  // usefully render.
  let min = span <= 0 ? dataMin - 0.1 : dataMin - pad * span;
  let max = span <= 0 ? dataMax + 0.1 : dataMax + pad * span;
  if (clampMinAtZero && min < 0) min = 0;

  const step = niceFloor125((max - min) / 10);
  return {
    min: clean(Math.floor(min / step + 1e-9) * step),
    max: clean(Math.ceil(max / step - 1e-9) * step),
  };
}

/**
 * A positive lower limit for a bar switched to log scale while its min is
 * 0 or below (log10(0) is -Infinity): where the log Auto Range of `values`
 * would start, or three decades below `max` (rounded to 1, 2 or 5 × 10^k)
 * without data. Replaces a fixed 0.01, which sat above the whole range for
 * small values (0 .. 0.011 became 0.01 .. 0.011).
 * @param {number} max the bar's current max
 * @param {number[]} [values] the magnitudes the bar colours
 */
export function logScaleFloor(max, values = []) {
  const r = computeAutoRange(values, 0.2, { log: true });
  if (r && r.min > 0 && (!(max > 0) || r.min < max)) return r.min;
  if (max > 0) return niceFloor125(max / 1000);
  return 0.01;
}
