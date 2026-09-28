// Per-point unit-cell parameters for the Lattice Analysis windows
// (docs/ui/LatticeAnalysisPanel.js / LatticePlotsPanel.js). A "point" is one
// frame of one container — every frame of the selected trajectory, or the
// frame each checked Files-table row is showing. For each point: the lengths
// a, b, c (Å), the angles α, β, γ (degrees), the volume (Å³), and the
// sortable per-frame properties (energy, max force, pressure) read straight
// from the frame's stored physics — no frame is materialised into a
// Structure for it. No DOM here.
//
// Also owns the "custom x axis" parser: the user types one x value per point
// (a pressure series, a temperature ramp, ...) plus a label and a unit, and
// every plot's x axis becomes that instead of the frame number.

import { latticeParameters } from '../math/index.js';
import { stressMean } from '../atomistic/relaxer.js';

/** One array per quantity, 1:1 with the points, plus the point count.
 *  @typedef {{a: number[], b: number[], c: number[], alpha: number[],
 *             beta: number[], gamma: number[], volume: number[],
 *             energy: number[], maxForce: number[], pressure: number[],
 *             frameCount: number}} LatticeSeries */

/** Series keys in display order, with their plot labels and units. */
export const LATTICE_QUANTITIES = /** @type {const} */ ([
  { key: 'a', label: 'a', unit: 'Å' },
  { key: 'b', label: 'b', unit: 'Å' },
  { key: 'c', label: 'c', unit: 'Å' },
  { key: 'alpha', label: 'α', unit: '°' },
  { key: 'beta', label: 'β', unit: '°' },
  { key: 'gamma', label: 'γ', unit: '°' },
]);

/** What the points can be sorted by (and plotted against). `order` is the
 *  points' own order (frame number / Files-table order), `name` the row's
 *  file name (checked-structures source only); the rest are per-frame
 *  numbers that may be absent for some or all points. Pressure follows the
 *  Trajectory plot's convention: the stress tensor's trace / 3, labelled in
 *  GPa like there. */
/** @type {{key: string, label: string, unit: string}[]} */
export const SORT_PROPERTIES = [
  { key: 'order', label: 'Order', unit: '' },
  { key: 'name', label: 'Filename', unit: '' },
  { key: 'energy', label: 'Energy', unit: 'eV' },
  { key: 'maxForce', label: 'Max force', unit: 'eV/Å' },
  { key: 'pressure', label: 'Pressure', unit: 'GPa' },
  { key: 'volume', label: 'Volume', unit: 'Å³' },
];

const SERIES_KEYS = ['a', 'b', 'c', 'alpha', 'beta', 'gamma', 'volume', 'energy', 'maxForce', 'pressure'];

function validLattice(lattice) {
  return Array.isArray(lattice) && lattice.length === 3
    && lattice.every((row) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite));
}

/** Largest per-atom |F| over a flat xyz array (store-backed frame) or an
 *  array of {vector} (a Structure's forces); NaN when there are none. */
function maxForceOf(forces) {
  if (!forces) return NaN;
  let max = -Infinity;
  if (forces instanceof Float64Array || forces instanceof Float32Array) {
    for (let i = 0; i + 2 < forces.length; i += 3) {
      max = Math.max(max, Math.hypot(forces[i], forces[i + 1], forces[i + 2]));
    }
  } else if (Array.isArray(forces)) {
    for (const f of forces) {
      const v = f?.vector ?? f;
      if (Array.isArray(v) && v.length >= 3) max = Math.max(max, Math.hypot(v[0], v[1], v[2]));
    }
  }
  return max === -Infinity ? NaN : max;
}

/**
 * One frame's physics — {lattice, energy, forces, stress} in a shape shared by
 * both container kinds: a store-backed trajectory answers from its packed
 * frame record (which may be a Promise for frames still on disk); a plain
 * container from the Structure in that slot. Anything missing is null.
 * @returns {Promise<{lattice: number[][] | null, energy: number | null,
 *                    forces: any, stress: number[][] | null}>}
 */
async function framePhysics(container, step) {
  if (container?.store && typeof container.store.getFramePhysics === 'function') {
    // `await` on a plain record is a no-op; on a pending frame it waits.
    const ph = await container.store.getFramePhysics(step);
    return {
      lattice: ph?.lattice ?? null,
      energy: ph?.energy ?? null,
      forces: ph?.forces ?? null,
      stress: ph?.stress ?? null,
    };
  }
  const structure = container?.structures?.[step];
  return {
    lattice: structure?.lattice ?? null,
    energy: structure?.energy ?? null,
    forces: structure?.forces ?? null,
    stress: structure?.stress?.tensor ?? null,
  };
}

/**
 * The lattice series of a list of points. Async because a frame source
 * backed by the file on disk hands out its physics as Promises; in-memory
 * frames resolve on the next microtask. A point without a usable lattice
 * contributes NaN cell parameters (a gap in the line), never a throw; a
 * property a frame does not carry (no energy, no forces, no stress) is NaN.
 * @param {{container: object, step: number}[]} points
 * @returns {Promise<LatticeSeries>}
 */
export async function latticePointSeries(points) {
  /** @type {LatticeSeries} */
  const out = /** @type {any} */ ({ frameCount: points.length });
  for (const key of SERIES_KEYS) out[key] = [];
  for (const { container, step } of points) {
    const ph = await framePhysics(container, step);
    if (validLattice(ph.lattice)) {
      const p = latticeParameters(ph.lattice);
      out.a.push(p.a); out.b.push(p.b); out.c.push(p.c);
      out.alpha.push(p.alpha); out.beta.push(p.beta); out.gamma.push(p.gamma);
      out.volume.push(p.volume);
    } else {
      for (const key of ['a', 'b', 'c', 'alpha', 'beta', 'gamma', 'volume']) out[key].push(NaN);
    }
    out.energy.push(Number.isFinite(ph.energy) ? ph.energy : NaN);
    out.maxForce.push(maxForceOf(ph.forces));
    const pressure = stressMean(ph.stress);
    out.pressure.push(Number.isFinite(pressure) ? pressure : NaN);
  }
  return out;
}

/**
 * The lattice series of every frame in `container`, in frame order.
 * @returns {Promise<LatticeSeries>}
 */
export function latticeSeriesFromContainer(container) {
  const n = container?.structures?.length ?? 0;
  return latticePointSeries(Array.from({ length: n }, (_, step) => ({ container, step })));
}

/**
 * Parse the custom x-axis text: numbers separated by whitespace, commas or
 * semicolons, one per point (a trailing comment after '#' on a line is
 * ignored, so a pasted table column with a header comment works). Returns
 * the values, or throws with a message the status line can show verbatim.
 * @param {string} text
 * @param {number} count expected number of values
 * @param {string} [noun] what a value belongs to, for the message
 * @returns {number[]}
 */
export function parseCustomAxisValues(text, count, noun = 'frame') {
  const cleaned = String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join(' ');
  const tokens = cleaned.split(/[\s,;]+/).filter((t) => t.length > 0);
  if (!tokens.length) throw new Error('No x values given.');
  const values = tokens.map(Number);
  const bad = tokens.filter((_, i) => !Number.isFinite(values[i]));
  if (bad.length) throw new Error(`Not a number: "${bad[0]}".`);
  if (values.length !== count) {
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    throw new Error(`Need one value per ${noun}: ${plural(count, noun)}, got ${plural(values.length, 'value')}.`);
  }
  return values;
}

/** The x-axis title for a custom axis: "Pressure (GPa)", "Pressure" when the
 *  unit is blank, "x (GPa)" when the label is. */
export function customAxisTitle(label, unit) {
  const l = String(label ?? '').trim() || 'x';
  const u = String(unit ?? '').trim();
  return u ? `${l} (${u})` : l;
}

function csvCell(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const text = String(v ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The plotted points as CSV, one row per point in source order: the point's
 * label and frame number, the sortable properties (blank where a frame does
 * not carry one), the custom x axis when one is in force, then the six cell
 * parameters and the volume. Full precision — the table in the window rounds
 * for reading, a file should not.
 * @param {{labels: string[], steps: number[], series: LatticeSeries,
 *          customAxis?: {values: number[], label: string, unit: string} | null}} data
 * @returns {string}
 */
export function latticeCsv({ labels, steps, series, customAxis = null }) {
  const columns = [
    { header: 'point', get: (i) => labels[i] },
    { header: 'frame', get: (i) => steps[i] + 1 },
    ...SORT_PROPERTIES.filter((p) => p.key !== 'order' && p.key !== 'name')
      .map((p) => ({ header: `${p.label.toLowerCase()} (${p.unit})`, get: (i) => series[p.key][i] })),
  ];
  if (customAxis && customAxis.values.length === series.frameCount) {
    columns.push({ header: customAxisTitle(customAxis.label, customAxis.unit), get: (i) => customAxis.values[i] });
  }
  for (const { key, unit } of LATTICE_QUANTITIES) {
    columns.push({ header: `${key} (${unit === '°' ? 'deg' : unit})`, get: (i) => series[key][i] });
  }
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (let i = 0; i < series.frameCount; i++) {
    lines.push(columns.map((c) => csvCell(c.get(i))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The window's parameter table as rows of text — the shown point's value and
 * the min/max over all points per cell parameter — for the table itself and
 * for copying it as tab-separated text (pastes into a spreadsheet as cells).
 * @param {LatticeSeries} series
 * @param {number | null} shownIndex
 * @returns {{label: string, shown: string, min: string, max: string, unit: string}[]}
 */
export function latticeTableRows(series, shownIndex) {
  const fmt = (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : '');
  return LATTICE_QUANTITIES.map(({ key, label, unit }) => {
    const values = series[key];
    const finite = values.filter(Number.isFinite);
    const digits = unit === '°' ? 3 : 4;
    return {
      label,
      shown: fmt(shownIndex !== null && shownIndex !== undefined ? values[shownIndex] : NaN, digits),
      min: fmt(finite.length ? Math.min(...finite) : NaN, digits),
      max: fmt(finite.length ? Math.max(...finite) : NaN, digits),
      unit,
    };
  });
}

/** The table as tab-separated text with a header row. */
export function latticeTableText(series, shownIndex) {
  const rows = latticeTableRows(series, shownIndex);
  return ['\tShown\tMin\tMax\tUnit', ...rows.map((r) => [r.label, r.shown, r.min, r.max, r.unit].join('\t'))].join('\n');
}
