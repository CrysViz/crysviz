// Shared "Auto Range" formula for every magnitude-driven color bar (Forces,
// Spins, Atoms-by-force, Bonds-by-length): pads the data's own min/max by
// `pad` (default 20%) of its span on each side, so the bar's displayed
// extremes sit a bit past the actual data instead of clipping right at the
// edges (a value exactly at the old max reads as "maxed out"/off-scale
// otherwise, both visually and in a log-scale bar's tick spacing).

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

/**
 * @param {number[]} values raw magnitudes (not yet filtered/finite-checked)
 * @param {number} [pad] fraction of the data span to pad on each side
 * @param {{clampMinAtZero?: boolean}} [opts] clampMinAtZero — floor the
 *   padded min at 0 rather than letting it pad below. For quantities that
 *   can never be negative (force/spin magnitude, bond length), a small
 *   data-min close to 0 would otherwise pad into negative territory, which
 *   makes no physical sense — e.g. a spin magnitude of -0.8 μB. Off by
 *   default: PlanesPanel.js's scalar field values (the one other caller)
 *   can genuinely be negative.
 * @returns {{min: number, max: number} | null} null if there's no usable
 *   (finite) data to range over at all.
 */
export function computeAutoRange(values, pad = 0.2, { clampMinAtZero = false } = {}) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;

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

  return { min: roundToSigFigs(min), max: roundToSigFigs(max) };
}
