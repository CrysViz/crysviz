// Turn a fractionally occupied structure into an ordered one, so it can be fed
// to MD/relaxation (which need a definite species per site) or exported to
// formats that cannot express occupancy.
//
// Two methods, and the difference between them matters:
//
//   'random'   - size a supercell so the occupancies come out as whole numbers
//                of atoms, then decorate it to hit those exact counts, nudged
//                by a first-neighbor-shell swap search (see
//                optimizeImageAssignment) toward the same-species-neighbor
//                statistics a genuinely uncorrelated random alloy would show,
//                rather than whatever a plain shuffle happens to land on
//                (which, especially in a small cell, often clusters like
//                species together purely by chance). Stoichiometry is
//                preserved. Seeded, so a run is reproducible.
//
//   'majority' - give every site its most-occupied species. Cheap and needs no
//                supercell, but it DESTROYS stoichiometry: a 50/50 Fe/Ni alloy
//                becomes 100% Fe. It looks plausible and is chemically wrong,
//                which is why it is never the default and is reported loudly.
//
// Neither is a special quasirandom structure. A real SQS explicitly optimises
// multi-shell cluster correlation functions against target values (ATAT
// mcsqs, icet territory), typically searching across the WHOLE cell rather
// than one site's own images. This is a much smaller, first-shell-only
// heuristic - said plainly in the UI so nobody over-trusts the output.

import { Atom } from '../model/index.js';
import { generateID } from '../utils/index.js';
import { isVacancy } from '../render/VacancyMarkerModule.js';

/** Largest supercell multiplier considered when solving for whole-atom counts. */
const MAX_MULTIPLIER = 12;

/** True when scaling every occupancy by n lands on a whole number, within tolerance. */
function isExactAtMultiplier(occupancies, n, tol = 1e-3) {
  return occupancies.every((o) => {
    const scaled = o * n;
    return Math.abs(scaled - Math.round(scaled)) <= tol * n;
  });
}

/** Every species/vacancy occupancy on this structure's disordered sites, the
 *  shared input smallestExactMultiplier/listMultiplierOptions/
 *  buildOrderedStructure all check exactness against. */
function collectOccupancies(structure) {
  const occupancies = [];
  for (const atom of structure.atoms) {
    if (!atom.isDisordered?.()) continue;
    for (const s of atom.species) occupancies.push(s.occupancy);
    const vac = atom.getVacancyFraction();
    if (vac > 1e-6) occupancies.push(vac);
  }
  return occupancies;
}

/**
 * Smallest n in [1, max] making every occupancy an integer count, or null if
 * none does within tolerance.
 *
 * @param {number[]} occupancies
 * @param {number} [tol]
 * @param {number} [max]
 * @returns {number|null}
 */
export function smallestExactMultiplier(occupancies, tol = 1e-3, max = MAX_MULTIPLIER) {
  for (let n = 1; n <= max; n++) if (isExactAtMultiplier(occupancies, n, tol)) return n;
  return null;
}

/**
 * Choose a supercell shape for a multiplier, keeping it as close to cubic as
 * the factorisation allows so the cell does not become a long thin slab.
 *
 * @param {number} multiplier
 * @returns {[number, number, number]}
 */
export function supercellShapeFor(multiplier) {
  let best = [multiplier, 1, 1];
  let bestSpread = Infinity;
  for (let a = 1; a <= multiplier; a++) {
    if (multiplier % a) continue;
    const rest = multiplier / a;
    for (let b = 1; b <= rest; b++) {
      if (rest % b) continue;
      const c = rest / b;
      const spread = Math.max(a, b, c) - Math.min(a, b, c);
      if (spread < bestSpread) { bestSpread = spread; best = [a, b, c]; }
    }
  }
  return /** @type {[number,number,number]} */ (best);
}

/**
 * Deterministic PRNG so a seeded run reproduces exactly.
 *
 * The seed is run through an integer-mixing hash before becoming the
 * xorshift32 state, not used directly: xorshift32 seeded straight from a
 * small integer needs several outputs before its state has "mixed" — its raw
 * first output is roughly seed/15873, so every seed from 1 to ~7935 (i.e.
 * the whole range every caller here actually uses: seed=1,2,3,... from a
 * reroll or a multi-sample compare) yields the SAME first draw. That is
 * silently fatal for a 2-image site's Fisher-Yates shuffle (decorateSite),
 * which needs exactly one draw and a threshold at 0.5 - every "different"
 * seed produced the identical decoration. The hash below (splitmix32-style
 * finalizer) decorrelates adjacent seeds from the very first draw while
 * keeping the same seed reproducible.
 */
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  s = (s ^ (s >>> 16)) >>> 0 || 1; // xorshift needs a nonzero state
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Plan an ordering without performing it — what supercell would be needed, how
 * many atoms that is, and how far off the composition would be if capped.
 *
 * @param {any} structure
 * @param {{maxAtoms?: number}} [opts]
 */
export function planOrdering(structure, opts = {}) {
  const maxAtoms = opts.maxAtoms ?? 2000;
  const occupancies = collectOccupancies(structure);

  const exact = occupancies.length ? smallestExactMultiplier(occupancies) : 1;
  const baseCount = structure.atoms.length;

  if (exact == null) {
    return {
      exact: false, multiplier: null, shape: null,
      atomCount: baseCount,
      reason: `No supercell up to ${MAX_MULTIPLIER}x gives whole-number counts for these occupancies. `
        + 'The nearest achievable composition will be used instead.',
    };
  }

  const atomCount = baseCount * exact;
  if (atomCount > maxAtoms) {
    return {
      exact: false, multiplier: exact, shape: supercellShapeFor(exact), atomCount,
      reason: `Exact stoichiometry needs ${exact}x (${atomCount} atoms), over the ${maxAtoms}-atom limit. `
        + 'A smaller cell will be used and the composition will be approximate.',
    };
  }

  return {
    exact: true, multiplier: exact, shape: supercellShapeFor(exact), atomCount,
    reason: exact === 1
      ? 'Occupancies are already whole numbers in this cell; no supercell needed.'
      : `Exact stoichiometry needs a ${supercellShapeFor(exact).join('x')} supercell (${atomCount} atoms).`,
  };
}

/** Minimum-image squared Cartesian distance between two supercell-fractional
 *  positions — checks the 26 neighboring periodic images plus itself, which is
 *  exact for any cell that isn't extremely skewed (fine here: these are
 *  positions within one site's own image set, always at least one full
 *  lattice vector apart from their own periodic copies). */
function minImageDistSq(fracA, fracB, lattice) {
  let best = Infinity;
  for (let da = -1; da <= 1; da++) {
    for (let db = -1; db <= 1; db++) {
      for (let dc = -1; dc <= 1; dc++) {
        const dx = fracA[0] - fracB[0] + da;
        const dy = fracA[1] - fracB[1] + db;
        const dz = fracA[2] - fracB[2] + dc;
        const cx = dx * lattice[0][0] + dy * lattice[1][0] + dz * lattice[2][0];
        const cy = dx * lattice[0][1] + dy * lattice[1][1] + dz * lattice[2][1];
        const cz = dx * lattice[0][2] + dy * lattice[1][2] + dz * lattice[2][2];
        const d2 = cx * cx + cy * cy + cz * cz;
        if (d2 < best) best = d2;
      }
    }
  }
  return best;
}

/** Pairs of images at the nearest nonzero distance found among them (within a
 *  15% tolerance, so a degenerate shell - e.g. a cubic lattice's 6 nearest
 *  neighbors - comes back whole rather than split by float noise). */
function firstShellPairs(positionsFrac, lattice) {
  const n = positionsFrac.length;
  const pairs = [];
  if (n < 2) return pairs;
  const distSq = Array.from({ length: n }, () => new Float64Array(n));
  let minSq = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d2 = minImageDistSq(positionsFrac[i], positionsFrac[j], lattice);
      distSq[i][j] = d2;
      distSq[j][i] = d2;
      if (d2 > 1e-8 && d2 < minSq) minSq = d2;
    }
  }
  if (!isFinite(minSq)) return pairs;
  const cutoffSq = minSq * 1.15 * 1.15;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (distSq[i][j] <= cutoffSq) pairs.push([i, j]);
    }
  }
  return pairs;
}

/** Largest image count this is worth running on — first-shell pair-finding is
 *  O(images^2); above this a plain shuffle is returned as-is rather than
 *  stalling the browser on a "Compute Again" click. */
const MAX_OPTIMIZE_IMAGES = 400;

/**
 * Nudge a per-image species assignment (already the right composition, from a
 * plain shuffle) toward the same-species-neighbor statistics a genuinely
 * uncorrelated random placement of that composition would show on average —
 * pushing apart same-species pairs that a small cell's shuffle otherwise often
 * clusters together purely by chance, without over-correcting into an
 * artificially checkerboarded arrangement (the target is the composition's own
 * expected same-species pair fraction, sum(x_s^2), not zero).
 *
 * A greedy first-neighbor-shell swap search, not a real SQS (see file header):
 * only this one site's own images are considered, and only the first shell.
 *
 * @param {Array<string|null>} pool one species (or null = vacancy) per image
 * @param {number[][]} positionsFrac supercell-fractional position per image
 * @param {number[][]} lattice the supercell lattice
 * @param {() => number} rng
 * @returns {Array<string|null>} the same array, reordered in place
 */
export function optimizeImageAssignment(pool, positionsFrac, lattice, rng) {
  const n = pool.length;
  if (n < 3 || n > MAX_OPTIMIZE_IMAGES) return pool;
  const pairs = firstShellPairs(positionsFrac, lattice);
  if (!pairs.length) return pool;

  const pairsTouching = Array.from({ length: n }, () => []);
  pairs.forEach(([i, j], pIdx) => { pairsTouching[i].push(pIdx); pairsTouching[j].push(pIdx); });

  const counts = new Map();
  for (const s of pool) counts.set(s, (counts.get(s) || 0) + 1);
  let idealSameFraction = 0;
  for (const c of counts.values()) idealSameFraction += (c / n) * (c / n);
  const idealSamePairs = idealSameFraction * pairs.length;

  const sameSum = (indices) => indices.reduce((sum, pIdx) => {
    const [i, j] = pairs[pIdx];
    return sum + (pool[i] === pool[j] ? 1 : 0);
  }, 0);

  let current = sameSum(pairs.map((_, i) => i));
  let score = Math.abs(current - idealSamePairs);

  const iterations = Math.min(4000, n * n * 4);
  for (let iter = 0; iter < iterations && score > 0; iter++) {
    const a = Math.floor(rng() * n);
    const b = Math.floor(rng() * n);
    if (a === b || pool[a] === pool[b]) continue; // no-op swap

    const touched = [...new Set([...pairsTouching[a], ...pairsTouching[b]])];
    const before = sameSum(touched);
    [pool[a], pool[b]] = [pool[b], pool[a]];
    const after = sameSum(touched);
    const newCurrent = current - before + after;
    const newScore = Math.abs(newCurrent - idealSamePairs);

    if (newScore <= score) {
      current = newCurrent;
      score = newScore;
    } else {
      [pool[a], pool[b]] = [pool[b], pool[a]]; // revert
    }
  }
  return pool;
}

/**
 * Every supercell multiplier from 1 to MAX_MULTIPLIER that stays within
 * maxAtoms, each flagged whether it gives whole-number occupancy counts
 * exactly. Feeds a size picker so the user isn't stuck with just the smallest
 * exact multiplier planOrdering() reaches for by default.
 *
 * @param {any} structure
 * @param {{maxAtoms?: number, max?: number}} [opts]
 * @returns {Array<{multiplier: number, shape: [number,number,number], atomCount: number, exact: boolean}>}
 */
export function listMultiplierOptions(structure, opts = {}) {
  const maxAtoms = opts.maxAtoms ?? 2000;
  const max = opts.max ?? MAX_MULTIPLIER;
  const occupancies = collectOccupancies(structure);
  const baseCount = structure.atoms.length;

  const options = [];
  for (let n = 1; n <= max; n++) {
    const atomCount = baseCount * n;
    if (atomCount > maxAtoms) break; // larger n only grows further, nothing past here fits
    const exact = !occupancies.length || isExactAtMultiplier(occupancies, n);
    options.push({ multiplier: n, shape: supercellShapeFor(n), atomCount, exact });
  }
  return options;
}

/**
 * Decide the species for every image of one disordered site.
 *
 * Counts are rounded to the nearest whole number of images and then reconciled
 * against the number actually available, so the result always fills exactly the
 * images that exist — a plain per-image random draw would let the realised
 * composition wander away from the requested one. The initial shuffle is then
 * improved by optimizeImageAssignment (see its own comment).
 *
 * @param {any} atom
 * @param {number[][]} positionsFrac supercell-fractional position of every
 *   image of this site, in a fixed order matching the returned array
 * @param {number[][]} lattice the supercell lattice
 * @param {() => number} rng
 * @returns {Array<string|null>} element per image, null meaning "leave vacant"
 */
export function decorateSite(atom, positionsFrac, lattice, rng) {
  const images = positionsFrac.length;
  const wanted = [];
  // An explicit "Va" species counts toward the vacancy pool (element null),
  // same as the derived vacancy fraction below — so a site written as
  // Fe 0.5 / Va 0.5 orders the same as Fe 0.5 with a bare 0.5 vacancy.
  for (const s of atom.species) wanted.push({ element: isVacancy(s.element) ? null : s.element, exact: s.occupancy * images });
  const vac = atom.getVacancyFraction();
  if (vac > 1e-6) wanted.push({ element: null, exact: vac * images });

  const counts = wanted.map((w) => ({ element: w.element, n: Math.floor(w.exact), frac: w.exact - Math.floor(w.exact) }));
  let assigned = counts.reduce((sum, c) => sum + c.n, 0);
  // Hand out the remaining images to whichever species were rounded down
  // hardest — largest-remainder, so the realised composition is the closest
  // achievable one rather than merely a plausible one.
  const byFrac = [...counts].sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (assigned < images && byFrac.length) {
    byFrac[k % byFrac.length].n++;
    assigned++;
    k++;
  }

  const pool = [];
  for (const c of counts) for (let i = 0; i < c.n; i++) pool.push(c.element);
  // Fisher-Yates with the seeded rng, so which image gets which species is
  // random but reproducible.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return optimizeImageAssignment(pool, positionsFrac, lattice, rng);
}

/**
 * Build an ordered copy of a structure.
 *
 * @param {any} structure
 * @param {{method?: 'random'|'majority', seed?: number, multiplier?: number, maxAtoms?: number}} [opts]
 * @returns {{atoms: any[], elements: string[], lattice: number[][], shape: [number,number,number], report: string}}
 */
export function buildOrderedStructure(structure, opts = {}) {
  const method = opts.method ?? 'random';
  const rng = makeRng(opts.seed ?? 1);

  if (method === 'majority') {
    // A site whose representative species is a vacancy stays a visible "Va"
    // atom, same as every other site — the potential ignores it later
    // (buildNEPStructure filters "Va"), but the ordered cell still shows it.
    const atoms = structure.atoms.map((a) => new Atom({
      position: [...a.position],
      element: a.getRepresentativeElement(),
      uuid: generateID([a.getRepresentativeElement()]),
    }));
    return {
      atoms,
      elements: atoms.map((_, i) => structure.atoms[i].getRepresentativeElement()),
      lattice: structure.lattice.map((r) => [...r]),
      shape: [1, 1, 1],
      report: 'Majority decoration: every site took its most-occupied species. '
        + 'Stoichiometry is NOT preserved — minority species are gone entirely.',
    };
  }

  const plan = planOrdering(structure, { maxAtoms: opts.maxAtoms });
  const multiplier = opts.multiplier ?? plan.multiplier ?? 1;
  // plan.exact is about the DEFAULT (smallest) multiplier; opts.multiplier can
  // pick a different one (e.g. the size dropdown), which needs its own check.
  const occupancies = collectOccupancies(structure);
  const chosenExact = !occupancies.length || isExactAtMultiplier(occupancies, multiplier);
  const shape = supercellShapeFor(multiplier);
  const [na, nb, nc] = shape;

  const lattice = structure.lattice.map((row, i) => row.map((v) => v * shape[i]));

  const atoms = [];
  const elements = [];

  for (const atom of structure.atoms) {
    // Every periodic image of this site in the supercell, in a fixed order.
    const offsets = [];
    for (let ia = 0; ia < na; ia++) {
      for (let ib = 0; ib < nb; ib++) {
        for (let ic = 0; ic < nc; ic++) offsets.push([ia, ib, ic]);
      }
    }
    const positionsFrac = offsets.map((off) => [
      (atom.position[0] + off[0]) / na,
      (atom.position[1] + off[1]) / nb,
      (atom.position[2] + off[2]) / nc,
    ]);

    const assignment = atom.isDisordered?.()
      ? decorateSite(atom, positionsFrac, lattice, rng)
      : positionsFrac.map(() => atom.getRepresentativeElement());

    positionsFrac.forEach((position, i) => {
      // A vacancy image (null from decorateSite, or an ordered "Va" site) is
      // kept as a visible "Va" atom: the user still sees where the vacancies
      // landed, and buildNEPStructure filters "Va" so the potential ignores it.
      const raw = assignment[i];
      const element = (!raw || isVacancy(raw)) ? 'Va' : raw;
      atoms.push(new Atom({ position, element, uuid: generateID([element]) }));
      elements.push(element);
    });
  }

  return {
    atoms, elements, lattice, shape,
    report: `${chosenExact ? 'Exact' : 'Approximate'} random decoration in a ${shape.join('x')} supercell `
      + `(${atoms.length} atoms, seed ${opts.seed ?? 1}). `
      + 'Nudged toward the composition\'s expected random-alloy neighbor statistics '
      + '(first shell only) — this is not a special quasirandom structure.',
  };
}
