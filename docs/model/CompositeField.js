import { Field } from './Field.js';

/**
 * Weighted combination of volumetric fields, plus the shared statistics helper
 * every field producer needs.
 *
 * Two things live here because they are the same concern:
 *
 *  - `computeFieldStats` is the min/max/absMin/absMax reduction that
 *    `io/ReadChgcarModule.js` had open-coded six times and that every new field
 *    source needs. `ui/FieldPanel.js`'s slider mapping reads all four.
 *  - `combineFields` is sum(w_i * field_i). It backs the derived-field UI, and
 *    it also expresses the spin up/down split CHGCAR already did by hand:
 *    up = 0.5*rho + 0.5*s, down = 0.5*rho - 0.5*s.
 *  - `magnitudeField` is sqrt(sum f_i^2), the one derivation a noncollinear
 *    CHGCAR needs that a weighted sum cannot express.
 *
 * A composite is an ordinary `Field` — same class, same `values` — so
 * isosurfaces, cut planes and both tracer pipelines consume it with no special
 * casing. The only additions are `derivedFrom`, which records the terms so the
 * field can be rebuilt if one of them changes, and `derivedOp`, which says how
 * they were combined.
 */

/**
 * Reduce a field's values to the four extremes `Field` carries.
 *
 * Written as one pass with plain comparisons rather than four `Array.reduce`
 * calls: these arrays run to millions of entries, and the reduce-based version
 * this replaces walked them four times over.
 *
 * @param {Float32Array | Float64Array | number[]} values
 * @returns {{minValue: number, maxValue: number, absMinValue: number, absMaxValue: number}}
 */
export function computeFieldStats(values) {
  if (!values || values.length === 0) {
    return { minValue: 0, maxValue: 0, absMinValue: 0, absMaxValue: 0 };
  }

  let minValue = Infinity;
  let maxValue = -Infinity;
  let absMinValue = Infinity;
  let absMaxValue = 0;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const a = Math.abs(v);
    if (v < minValue) minValue = v;
    if (v > maxValue) maxValue = v;
    if (a < absMinValue) absMinValue = a;
    if (a > absMaxValue) absMaxValue = a;
  }

  // An all-NaN field would leave the sentinels in place; report zeros so the
  // slider mapping gets finite numbers rather than Infinity.
  if (!Number.isFinite(minValue)) minValue = 0;
  if (!Number.isFinite(maxValue)) maxValue = 0;
  if (!Number.isFinite(absMinValue)) absMinValue = 0;

  return { minValue, maxValue, absMinValue, absMaxValue };
}

/**
 * A stride for walking `count` points that visits every one of them before
 * repeating — i.e. one coprime with `count`.
 *
 * Sampling every k-th point of a 3D grid laid out x-fastest means a stride
 * sharing a factor with nx keeps landing on the same lattice planes, so the
 * "sample" describes a slice rather than the cell. Any stride coprime with the
 * total point count cycles through all of them instead, which also rules out
 * the degenerate case (a stride that divides the count visits a handful of
 * indices over and over).
 *
 * @param {number} count
 * @returns {number}
 */
function coprimeStride(count) {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  let stride = (1000003 % count) || 1;
  // Coprimality is dense, so this walks at most a few steps.
  while (stride < count && gcd(stride, count) !== 1) stride++;
  return stride < count ? stride : 1;
}

/**
 * A first isosurface level that actually shows something.
 *
 * The old rule — halfway between the field's minimum and maximum — assumes the
 * values are spread evenly over their range. ELF is like that (bounded, broad),
 * which is why the midpoint looked fine there: on a real ELFCAR it encloses
 * about a quarter of the cell. Nothing else is. A charge density's maximum is a
 * rare spike at a nucleus, so on a real CHGCAR the midpoint encloses 0.15% of
 * the cell — a few specks — and a wavefunction is worse still, because |psi|^2
 * concentrates in a handful of lobes with a long, near-empty tail.
 *
 * So pick the level by *how much of the cell it encloses* instead: the value
 * exceeded by `volumeFraction` of the grid points. That is scale-free (it does
 * not care whether the numbers are 1e-3 or 1e3), it can never produce an empty
 * surface or one that swallows the box, and on the cases that already worked it
 * lands where a user would have dragged the slider anyway — 0.71 for ELF, right
 * in the 0.7-0.85 range that shows bonds and lone pairs.
 *
 * Magnitudes are used, so a signed field (Re psi, a difference of two
 * densities) gets one level for the pair of +/- surfaces the renderer draws.
 *
 * @param {Field} field
 * @param {{volumeFraction?: number, samples?: number}} [options]
 *   volumeFraction - target fraction of the cell inside the surface (default 5%)
 *   samples - how many grid points to look at (default 100k)
 * @returns {number} an iso value > 0, or 0 for an empty/degenerate field
 */
export function defaultIsoValue(field, { volumeFraction = 0.05, samples = 100000 } = {}) {
  const values = field?.values;
  const count = values?.length ?? 0;
  if (!count) return 0;

  // Sampling, not a full sort: these arrays run to millions of entries and this
  // is called on every field selection. The stride is a prime walk rather than
  // `every k-th`, because a stride sharing a factor with nx would keep landing
  // on the same lattice planes and describe a slice of the cell instead of the
  // cell.
  const wanted = Math.min(count, Math.max(1, Math.floor(samples)));
  const sample = new Float64Array(wanted);
  const step = count <= wanted ? 1 : coprimeStride(count);
  let index = 0;
  let written = 0;
  for (let i = 0; i < wanted; i++) {
    const v = values[index];
    sample[written++] = Number.isFinite(v) ? Math.abs(v) : 0;
    index += step;
    if (index >= count) index -= count;
  }

  sample.sort();

  // The level exceeded by `volumeFraction` of the points. Clamped so a request
  // for 0% or 100% still returns a real sample rather than running off the end.
  const fraction = Math.min(0.999, Math.max(0.001, volumeFraction));
  const cut = Math.min(written - 1, Math.max(0, Math.floor((1 - fraction) * written)));
  const level = sample[cut];

  // A field that is flat, or whose top few percent are all zero, has no
  // meaningful percentile; fall back to something that at least renders.
  if (!(level > 0)) return Number.isFinite(field.absMaxValue) ? field.absMaxValue / 2 : 0;
  return level;
}

/** Format one term for the auto-generated label: 1 -> "A", -1 -> "A", 0.5 -> "0.5×A". */
function formatTerm(weight, label, isFirst) {
  const magnitude = Math.abs(weight);
  const sign = weight < 0 ? '−' : '+';
  // Trim float noise (0.30000000000000004) without losing genuine precision.
  const scale = magnitude === 1 ? '' : `${Number(magnitude.toPrecision(6))}×`;
  const body = `${scale}${label}`;
  if (isFirst) return weight < 0 ? `−${body}` : body;
  return ` ${sign} ${body}`;
}

/**
 * Build a label like "0.5×Charge Density − 0.5×Magnetization Density".
 * @param {Array<{field: Field, weight: number}>} terms
 */
export function describeCombination(terms) {
  return terms
    .map((term, i) => formatTerm(term.weight, term.field?.label || 'Field', i === 0))
    .join('');
}

/**
 * Sum a set of weighted fields into a new one.
 *
 * Every term must share the grid dimensions; a mismatch is a hard error because
 * the result would be meaningless rather than merely approximate. Voxel vectors
 * are only warned about — combining fields that came from the same structure
 * via different readers can leave float noise in the voxel matrix, and refusing
 * on that would block a legitimate combination.
 *
 * @param {Array<{field: Field, weight: number}>} terms
 * @param {{label?: string, component?: number, useAbsoluteIsoValue?: boolean|null}} [options]
 * @returns {Field}
 */
export function combineFields(terms, options = {}) {
  const usable = (terms || []).filter((t) => t && t.field && Number.isFinite(t.weight));
  if (usable.length === 0) {
    throw new Error('combineFields requires at least one term with a field and a finite weight');
  }

  const first = usable[0].field;
  const { nx, ny, nz } = first;
  const expected = nx * ny * nz;

  for (const { field } of usable) {
    if (field.nx !== nx || field.ny !== ny || field.nz !== nz) {
      throw new Error(
        `combineFields: grid mismatch — "${field.label}" is ${field.nx}×${field.ny}×${field.nz}, `
        + `expected ${nx}×${ny}×${nz}`);
    }
    if (!field.values) {
      throw new Error(`combineFields: "${field.label}" has no values loaded`);
    }
    if (field.values.length < expected) {
      throw new Error(`combineFields: "${field.label}" holds ${field.values.length} values, expected ${expected}`);
    }
    if (!voxelsMatch(field.voxel, first.voxel)) {
      console.warn(`combineFields: voxel vectors of "${field.label}" differ from "${first.label}"; `
        + 'using the first field\'s geometry.');
    }
  }

  const values = new Float32Array(expected);
  for (const { field, weight } of usable) {
    if (weight === 0) continue;
    const source = field.values;
    for (let i = 0; i < expected; i++) values[i] += weight * source[i];
  }

  const stats = computeFieldStats(values);
  const field = new Field({
    nx,
    ny,
    nz,
    origin: first.origin,
    voxel: first.voxel,
    values,
    component: options.component ?? 0,
    label: options.label || describeCombination(usable),
    // A difference of two fields straddles zero, so default to the signed
    // treatment unless the caller knows better. `setActiveField` does the same
    // inference when this is left null.
    useAbsoluteIsoValue: options.useAbsoluteIsoValue ?? null,
    ...stats,
  });

  // The recipe, so the field can be rebuilt when a term is reloaded. Fields are
  // held by reference; a term whose values were evicted makes `recomputeComposite`
  // fail loudly rather than produce a silently wrong sum.
  field.derivedFrom = usable.map(({ field: source, weight }) => ({ field: source, weight }));
  field.derivedOp = 'sum';

  return field;
}

/**
 * The Euclidean magnitude of a set of fields, sqrt(sum f_i^2).
 *
 * This exists for one case: the three magnetization blocks of a noncollinear
 * CHGCAR. |m| is what tells a user where the cell is magnetic at all, and it is
 * the only genuinely physical quantity of that file that the panel's "Combine
 * fields" section cannot produce — that section sums weighted terms, and no
 * weighting of m₁, m₂ and m₃ is their magnitude. The collinear case does not
 * need it, because there the magnetization is a single signed block and its
 * magnitude is just its absolute value.
 *
 * Same grid rules as `combineFields`, for the same reason.
 *
 * @param {Field[]} fields the components to square and sum
 * @param {{label?: string, component?: number}} [options]
 * @returns {Field}
 */
export function magnitudeField(fields, options = {}) {
  const usable = (fields || []).filter(Boolean);
  if (usable.length === 0) {
    throw new Error('magnitudeField requires at least one field');
  }

  const first = usable[0];
  const { nx, ny, nz } = first;
  const expected = nx * ny * nz;

  for (const field of usable) {
    if (field.nx !== nx || field.ny !== ny || field.nz !== nz) {
      throw new Error(
        `magnitudeField: grid mismatch — "${field.label}" is ${field.nx}×${field.ny}×${field.nz}, `
        + `expected ${nx}×${ny}×${nz}`);
    }
    if (!field.values || field.values.length < expected) {
      throw new Error(`magnitudeField: "${field.label}" does not hold ${expected} values`);
    }
    if (!voxelsMatch(field.voxel, first.voxel)) {
      console.warn(`magnitudeField: voxel vectors of "${field.label}" differ from `
        + `"${first.label}"; using the first field's geometry.`);
    }
  }

  // Squares accumulated in a float64 scratch and rooted at the end: summing
  // three squared densities in float32 loses precision exactly where the field
  // is largest, which is where the isosurface is.
  const squares = new Float64Array(expected);
  for (const field of usable) {
    const source = field.values;
    for (let i = 0; i < expected; i++) squares[i] += source[i] * source[i];
  }
  const values = new Float32Array(expected);
  for (let i = 0; i < expected; i++) values[i] = Math.sqrt(squares[i]);

  const field = new Field({
    nx,
    ny,
    nz,
    origin: first.origin,
    voxel: first.voxel,
    values,
    component: options.component ?? 0,
    label: options.label || `|${usable.map((f) => f.label || 'field').join(', ')}|`,
    // A magnitude is non-negative, so the signed treatment would spend half the
    // isovalue slider on a surface that can never exist.
    useAbsoluteIsoValue: false,
    ...computeFieldStats(values),
  });

  field.derivedFrom = usable.map((source) => ({ field: source, weight: 1 }));
  field.derivedOp = 'magnitude';

  return field;
}

/**
 * Rebuild a composite in place from its recorded recipe.
 *
 * Used when a term's data was reloaded (a WAVECAR band re-expanded after
 * eviction) and the derived field must follow.
 *
 * @param {Field} composite a field produced by combineFields or magnitudeField
 * @returns {Field} the same object, with fresh values and stats
 */
export function recomputeComposite(composite) {
  if (!composite || !Array.isArray(composite.derivedFrom) || composite.derivedFrom.length === 0) {
    throw new Error('recomputeComposite: field carries no derivedFrom recipe');
  }

  // `derivedOp` rather than inferring from the weights: a magnitude records its
  // terms with weight 1 so anything walking the dependency list still sees
  // them, and rebuilding it as a plain sum would be silently wrong.
  const rebuilt = composite.derivedOp === 'magnitude'
    ? magnitudeField(composite.derivedFrom.map((term) => term.field), {
      label: composite.label,
      component: composite.component,
    })
    : combineFields(composite.derivedFrom, {
      label: composite.label,
      component: composite.component,
      useAbsoluteIsoValue: composite.useAbsoluteIsoValue,
    });

  composite.values = rebuilt.values;
  composite.minValue = rebuilt.minValue;
  composite.maxValue = rebuilt.maxValue;
  composite.absMinValue = rebuilt.absMinValue;
  composite.absMaxValue = rebuilt.absMaxValue;
  return composite;
}

/** True when two 3×3 voxel matrices agree to within float noise. */
function voxelsMatch(a, b) {
  if (!a || !b) return true; // voxel is filled in after parsing; nothing to compare yet
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (Math.abs((a[i]?.[j] ?? 0) - (b[i]?.[j] ?? 0)) > 1e-9) return false;
    }
  }
  return true;
}
