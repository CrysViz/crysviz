// Which length unit is a phonopy cell written in when the file does not say?
//
// phonopy keeps every cell in the calculator's own unit and converts nothing:
// VASP-family runs are in Å, QE / abinit / siesta / elk runs are in Bohr, and
// only phonopy.yaml records which (`calculator`, `physical_unit`). A bare
// band.yaml / mesh.yaml / qpoints.yaml carries the numbers and nothing else,
// so the reader has to infer the unit from the geometry itself.
//
// The tell is the closest interatomic contact, measured against the sum of
// the two atoms' contact radii (single-bond covalent radii; van der Waals
// radii for the noble gases, which never bond). Read in the right unit that
// ratio sits near 1 for every real solid — ionic, metallic, covalent and
// molecular alike, roughly 0.7 to 1.35. Read a Bohr cell as Å and every
// distance is 1.89x too long: the closest contact lands at 1.6 or more, i.e.
// nothing touches anything. Read an Å cell as Bohr and everything is 0.53x
// too short: the closest contact drops below ~0.6, i.e. atoms interpenetrate,
// which no relaxed structure does. So the two misreadings fail in opposite
// directions and one reading is nearly always left standing.
//
// Pure: no app state, radii injected (phononSession passes the app's table).

import { BOHR_TO_ANGSTROM } from './phonopyReader.js';

/** @typedef {'angstrom'|'bohr'} LengthUnit */

/** Van der Waals radii (Å) for the elements that do not form bonds; the
 *  covalent table would call an Ar–Ar contact of 3.8 Å "nothing touching". */
const VDW_RADII = { He: 1.40, Ne: 1.54, Ar: 1.88, Kr: 2.02, Xe: 2.16, Rn: 2.20 };

/** Bands on ratio = d / (rA + rB), the closest contact relative to the
 *  radii sum. */
export const RATIO_OVERLAP = 0.62;  // below: atoms interpenetrate — not a real structure in this unit
export const RATIO_BONDED = 1.35;   // up to here: an ordinary bonded / packed contact
export const RATIO_ISOLATED = 1.6;  // above: nothing is in contact with anything

const MAX_ATOMS = 400; // pairwise scan cap; the closest contact is found long before that

/** Radius sum lookup with the noble-gas override. `radiusOf` is the app's
 *  per-element radius (single-bond covalent). */
function contactRadius(el, radiusOf) {
  return VDW_RADII[el] ?? radiusOf(el);
}

/**
 * The closest interatomic contact in the cell (periodic images included),
 * relative to the contact-radius sum of the pair. Returns null for an empty
 * cell.
 * @param {{lattice:number[][], species:string[], frac:number[][]}} cell
 * @param {(el: string) => number} radiusOf
 * @returns {{ d:number, ratio:number, i:number, j:number, pair:string }|null}
 *   d is in the cell's own (unknown) unit.
 */
export function closestContact(cell, radiusOf) {
  const n = Math.min(cell?.species?.length ?? 0, MAX_ATOMS);
  if (!n || !cell.lattice) return null;
  const L = cell.lattice;
  const cart = [];
  for (let i = 0; i < n; i++) {
    const f = cell.frac[i];
    cart.push([
      f[0] * L[0][0] + f[1] * L[1][0] + f[2] * L[2][0],
      f[0] * L[0][1] + f[1] * L[1][1] + f[2] * L[2][1],
      f[0] * L[0][2] + f[1] * L[1][2] + f[2] * L[2][2],
    ]);
  }
  const radii = cell.species.slice(0, n).map((el) => contactRadius(el, radiusOf));
  let best = null;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const rr = radii[i] + radii[j];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        if (i === j && a === 0 && b === 0 && c === 0) continue;
        const dx = cart[j][0] + a * L[0][0] + b * L[1][0] + c * L[2][0] - cart[i][0];
        const dy = cart[j][1] + a * L[0][1] + b * L[1][1] + c * L[2][1] - cart[i][1];
        const dz = cart[j][2] + a * L[0][2] + b * L[1][2] + c * L[2][2] - cart[i][2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-6) continue; // coincident sites (disorder / duplicated points)
        const ratio = d / rr;
        if (!best || ratio < best.ratio) best = { d, ratio, i, j, pair: `${cell.species[i]}–${cell.species[j]}` };
      }
    }
  }
  return best;
}

/** @typedef {'overlap'|'bonded'|'loose'|'isolated'} Verdict */

/** @param {number} ratio @returns {Verdict} */
export function verdictFor(ratio) {
  if (ratio < RATIO_OVERLAP) return 'overlap';
  if (ratio <= RATIO_BONDED) return 'bonded';
  if (ratio <= RATIO_ISOLATED) return 'loose';
  return 'isolated';
}

/**
 * @typedef {Object} UnitReading
 * @property {LengthUnit} unit
 * @property {number} factor     multiply the file's numbers by this to get Å
 * @property {number} dAngstrom  the closest contact read in this unit, in Å
 * @property {number} ratio      that contact over the radii sum
 * @property {Verdict} verdict
 */

/**
 * @typedef {Object} UnitAssessment
 * @property {LengthUnit} guess
 * @property {'high'|'low'} confidence  high when the other reading is physically ruled out
 * @property {string} pair               the closest pair, e.g. "Si–Si"
 * @property {Record<LengthUnit, UnitReading>} readings
 * @property {number[][]|null} [lattice]  the lattice that was judged (set by the caller, to skip re-asking for the same cell)
 */

/**
 * Decide between Å and Bohr for a cell whose file declares no unit.
 *
 * The reading whose closest contact sits nearest to ratio 1 (in log terms)
 * wins; confidence is high when the losing reading is either an overlap or
 * fully isolated, low when both readings are physically possible (a Bohr
 * cell of a molecular crystal reads as a loose Å cell, for instance).
 * Falls back to Å with low confidence when the cell gives nothing to go on.
 *
 * @param {{lattice:number[][], species:string[], frac:number[][]}|null} cell
 * @param {(el: string) => number} radiusOf
 * @returns {UnitAssessment}
 */
export function assessLengthUnit(cell, radiusOf) {
  const contact = cell ? closestContact(cell, radiusOf) : null;
  const factors = /** @type {Record<LengthUnit, number>} */ ({ angstrom: 1, bohr: BOHR_TO_ANGSTROM });
  const readings = /** @type {Record<LengthUnit, UnitReading>} */ ({});
  for (const unit of /** @type {LengthUnit[]} */ (['angstrom', 'bohr'])) {
    const factor = factors[unit];
    const ratio = contact ? contact.ratio * factor : NaN;
    readings[unit] = {
      unit, factor,
      dAngstrom: contact ? contact.d * factor : NaN,
      ratio,
      verdict: contact ? verdictFor(ratio) : 'isolated',
    };
  }
  if (!contact) return { guess: 'angstrom', confidence: 'low', pair: '', readings };

  const A = readings.angstrom;
  const B = readings.bohr;
  const possible = (r) => r.verdict === 'bonded' || r.verdict === 'loose';
  let guess = /** @type {LengthUnit} */ ('angstrom');
  if (possible(A) && !possible(B)) guess = 'angstrom';
  else if (possible(B) && !possible(A)) guess = 'bohr';
  else if (possible(A) && possible(B)) guess = Math.abs(Math.log(A.ratio)) <= Math.abs(Math.log(B.ratio)) ? 'angstrom' : 'bohr';
  else guess = 'angstrom'; // both impossible: the numbers are in neither unit; Å is phonopy's most common
  const other = guess === 'angstrom' ? B : A;
  const confidence = possible(readings[guess]) && !possible(other) ? 'high' : 'low';
  return { guess, confidence, pair: contact.pair, readings };
}

const UNIT_LABEL = { angstrom: 'Å', bohr: 'Bohr' };

/** One line per reading for the confirmation dialog, kept short enough for
 *  the dialog's monospace detail box (~60 columns), e.g.
 *  "as Bohr: Si–Si 2.35 Å (1.06 × radii sum), a normal contact". */
export function describeReadings(assessment) {
  const words = {
    overlap: 'atoms overlap',
    bonded: 'a normal contact',
    loose: 'loose, unusual',
    isolated: 'nothing touches',
  };
  return (/** @type {LengthUnit[]} */ (['angstrom', 'bohr'])).map((unit) => {
    const r = assessment.readings[unit];
    const head = `as ${UNIT_LABEL[unit].padEnd(4)}:`;
    if (!Number.isFinite(r.ratio)) return `${head} no interatomic distance to judge by`;
    return `${head} ${assessment.pair} ${r.dAngstrom.toFixed(2)} Å (${r.ratio.toFixed(2)} × radii sum), ${words[r.verdict]}`;
  }).join('\n');
}

export function unitLabel(unit) {
  return UNIT_LABEL[unit] ?? String(unit);
}
