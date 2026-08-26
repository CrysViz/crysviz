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
 *
 * A composite is an ordinary `Field` — same class, same `values` — so
 * isosurfaces, cut planes and both tracer pipelines consume it with no special
 * casing. The only addition is `derivedFrom`, which records the recipe so the
 * field can be rebuilt if a term changes.
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

  return field;
}

/**
 * Rebuild a composite in place from its recorded recipe.
 *
 * Used when a term's data was reloaded (a WAVECAR band re-expanded after
 * eviction) and the derived field must follow.
 *
 * @param {Field} composite a field produced by combineFields
 * @returns {Field} the same object, with fresh values and stats
 */
export function recomputeComposite(composite) {
  if (!composite || !Array.isArray(composite.derivedFrom) || composite.derivedFrom.length === 0) {
    throw new Error('recomputeComposite: field carries no derivedFrom recipe');
  }

  const rebuilt = combineFields(composite.derivedFrom, {
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
