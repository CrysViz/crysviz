// Colour-bar ticks: which round values to label between the Min and Max
// fields and how to print them. Shared by the live bar (ui/ColorBarWidget.js)
// and image export (render/ImageExportModule.js), so both show the same
// numbers.

// e-notation without padding: 2e-4, 2.5e-3, 1.23e5.
function sci(v, digits) {
  const [m, e] = v.toExponential(digits).split('e');
  return `${parseFloat(m)}e${parseInt(e, 10)}`;
}

// Below 0.001 a plain decimal is mostly zeros (0.0002, 0.00005): those, and
// values from 1e5 up, print in e-notation.
const needsSci = (a) => a !== 0 && (a < 1e-3 || a >= 1e5);

// `step`: the spacing of the ticks this value belongs to, so every tick gets
// the decimals its step needs (0.0025, 0.005, 0.0075 — not "0, 0.01, 0.01"
// from a fixed two decimals). Without a step: three significant figures.
export function formatTick(v, step = null) {
  if (!isFinite(v)) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (needsSci(a)) return sci(v, step ? 4 : 2);
  let decimals;
  if (step) {
    decimals = Math.max(0, -Math.floor(Math.log10(Math.abs(step)) + 1e-9));
    const mantissa = Math.abs(step) / 10 ** -decimals;
    if (Math.abs(mantissa - Math.round(mantissa)) > 1e-6) decimals += 1; // 2.5 × 10^k
  } else {
    decimals = Math.max(0, 2 - Math.floor(Math.log10(a)));
  }
  let s = v.toFixed(Math.min(decimals, 20));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** A Min/Max value set by the program (Auto Range, the log floor) as the
 *  field shows it: same notation rule as the ticks, up to four significant
 *  figures — 5e-5 rather than 0.00005, 0.011, 3.4. */
export function formatLimit(v) {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  if (needsSci(Math.abs(v))) return sci(v, 3);
  return String(parseFloat(v.toPrecision(4)));
}

// One notation per bar: if any tick needs e-notation, every tick from 0.001
// to 1e5 that isn't between 1 and 10 switches too (2e-4, 1e-3, 5e-3 — not
// 2e-4, 0.001, 0.005).
function unifyNotation(ticks) {
  if (!ticks.some(({ label }) => label.includes('e'))) return ticks;
  return ticks.map((t) => {
    const a = Math.abs(t.value);
    if (t.label.includes('e') || a === 0 || (a >= 1 && a < 10)) return t;
    return { ...t, label: sci(t.value, 4) };
  });
}

// log10(0) is -Infinity; clamp tick values below this floor before taking a
// log so a tick landing at/near 0 doesn't blow up its own position math.
const LOG_EPS = 1e-12;

const INNER_TICKS = 3; // most labeled ticks strictly between min and max (linear, or a log range of a decade or less)
const MAX_LOG_TICKS = 4; // decade ticks cap, not counting the min/max endpoints
// Inner ticks keep this fraction of the bar clear at both ends, where the
// Min/Max fields sit, so a round value next to an end doesn't print on top
// of them.
const END_CLEARANCE = 0.12;

const inZone = (f) => f >= END_CLEARANCE - 1e-9 && f <= 1 - END_CLEARANCE + 1e-9;
const cleanValue = (v) => parseFloat(v.toPrecision(12));

/** Round values (1, 2, 2.5 or 5 × 10^k apart) inside (min, max), positioned
 *  by `fracOf` and passed through `pick` (notation + what the bar can fit):
 *  as many as are left, up to INNER_TICKS, preferring 1-2-5 steps. */
function niceStepTicks(min, max, fracOf, pick) {
  const span = max - min;
  const e0 = Math.floor(Math.log10(span));
  let best = null;
  for (let e = e0 - 2; e <= e0 + 1; e++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * 10 ** e;
      const values = [];
      for (let k = Math.ceil(min / step - 1e-9); k * step <= max * (1 + 1e-12) + 1e-300 && values.length <= INNER_TICKS; k++) {
        const value = cleanValue(k * step);
        const frac = fracOf(value);
        if (Number.isFinite(frac) && inZone(frac)) values.push({ value, frac, label: formatTick(value, step) });
      }
      if (!values.length || values.length > INNER_TICKS) continue;
      const ticks = pick(values);
      if (!ticks.length) continue;
      const score = ticks.length * 10 + (m === 2.5 ? 0 : 1);
      if (!best || score > best.score || (score === best.score && step > best.step)) best = { score, step, ticks };
    }
  }
  return best ? best.ticks : [];
}

/** Evenly thin a list down to at most n entries, keeping both ends. */
function thin(list, n) {
  if (list.length <= n) return list;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round(i * (list.length - 1) / (n - 1))]);
  return [...new Set(out)];
}

// Labeled ticks strictly between min and max, at round values.
// Log over a factor of 3 or more: the decades (0.01, 0.1, …) inside the
// bar; with fewer than two of those, 1, 2 and 5 × 10^k. A shorter log
// range, or a linear one: round steps (niceStepTicks), each placed at its
// true position on the bar. Nothing within END_CLEARANCE of either end.
// `clear` drops what the bar can't fit (ColorBarWidget passes
// ticksClearOfFields); the first set with two ticks left wins.
export function computeTicks(min, max, scale, clear = (ticks) => ticks) {
  if (!(isFinite(min) && isFinite(max) && max > min)) return [];
  const isLog = scale === 'log' && min > 0;
  const lo = isLog ? Math.log10(min) : 0;
  const hi = isLog ? Math.log10(max) : 0;
  const fracOf = isLog
    ? (v) => (v > 0 ? (Math.log10(Math.max(v, LOG_EPS)) - lo) / (hi - lo) : NaN)
    : (v) => (v - min) / (max - min);
  // Each candidate set is judged by what's left once the bar has dropped
  // the ticks it can't fit (`clear`: the widget's ticksClearOfFields), so a
  // decade lost under a wide Min field falls back to 1-2-5 values instead
  // of leaving a single tick.
  const pick = (ticks) => clear(unifyNotation(ticks));
  const sets = [];

  // From a factor of 3 up, 1-2-5 values spread evenly on a log bar; round
  // linear steps bunch up towards its top end — 1e-4 .. 1e-3 gave 0.0002,
  // 0.0004, 0.0006 with the last two touching.
  if (isLog && max / min > 3) {
    const decades = [];
    const steps125 = [];
    for (let k = Math.floor(lo) - 1; k <= Math.ceil(hi); k++) {
      for (const m of [1, 2, 5]) {
        const value = cleanValue(m * 10 ** k);
        const frac = fracOf(value);
        if (!inZone(frac)) continue;
        const tick = { value, frac, label: formatTick(value, value), rank: m === 1 ? 0 : 1 };
        steps125.push(tick);
        if (m === 1) decades.push(tick);
      }
    }
    sets.push(thin(pick(decades), MAX_LOG_TICKS));
    sets.push(thin(pick(steps125), INNER_TICKS));
  }
  sets.push(niceStepTicks(min, max, fracOf, pick));
  const good = sets.find((t) => t.length >= 2);
  if (good) return good;
  const most = sets.reduce((a, t) => (t.length > a.length ? t : a), []);
  if (most.length) return most;

  // Nothing round fits (a range far narrower than its values): evenly
  // spaced, three significant figures.
  const ticks = [];
  for (let i = 1; i <= INNER_TICKS; i++) {
    const frac = i / (INNER_TICKS + 1);
    const value = isLog ? 10 ** (lo + frac * (hi - lo)) : min + frac * (max - min);
    ticks.push({ value, frac, label: formatTick(value) });
  }
  return pick(ticks);
}

/**
 * Drop ticks whose label would touch the Min/Max fields or another tick's
 * label. Positions are in pixels along the bar, from the min end (0) to the
 * max end (`length`); `minSpan`/`maxSpan` are the fields' [start, end] along
 * the same axis. END_CLEARANCE alone can't know how wide a field is (5e-5
 * is wider than 0), so the widget measures and filters here. Ticks are kept
 * by rank first (decades before 2s and 5s), then left to right, and need
 * `tickGap` px between labels (about a character: 4px read as one label,
 * "1e-3 2e-3").
 * @param {{frac: number, label: string, rank?: number}[]} ticks
 * @param {{length: number, minSpan: number[], maxSpan: number[], labelSize: (label: string) => number, gap?: number, tickGap?: number}} geom
 */
export function ticksClearOfFields(ticks, { length, minSpan, maxSpan, labelSize, gap = 4, tickGap = 10 }) {
  if (!(length > 0)) return ticks;
  const kept = [];
  const order = [...ticks].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.frac - b.frac);
  for (const t of order) {
    const half = labelSize(t.label) / 2;
    const p = t.frac * length;
    const span = [p - half, p + half];
    if (span[0] < minSpan[1] + gap || span[1] > maxSpan[0] - gap) continue;
    if (kept.some(({ span: k }) => span[0] < k[1] + tickGap && k[0] < span[1] + tickGap)) continue;
    kept.push({ t, span });
  }
  return kept.map(({ t }) => t).sort((a, b) => a.frac - b.frac);
}
