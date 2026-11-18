// Supercell queries in the feature search (FeatureSearch.js): typing the
// factors offers to build that supercell of the selected structure.
//
//   "222", "232"                three digits, one factor each (1–9)
//   "2x2x2", "2×3×2", "2 3 2",  three numbers with x, ×, *, commas or spaces
//   "2,2,2", "10x1x1"           between them (factors up to MAX_FACTOR)
//   "supercell 232", "sc 2x2x1", "222 supercell"
//                               the same with the word before or after
//
// Always all three factors: one number ("2", "12", also "supercell 3") is not
// a supercell. It is not precise enough, and too often the start of
// something else ("2D", a Wyckoff letter's multiplicity, an atom number).

/** The largest factor a query may ask for along one axis. */
export const MAX_FACTOR = 50;

const WORD = String.raw`(?:super[\s-]*cells?|sc)`;
const LEADING = new RegExp(String.raw`^${WORD}\s*:?\s*`);
const TRAILING = new RegExp(String.raw`\s*${WORD}$`);
const SEPARATED = /^(\d{1,3})\s*(?:[x×*,]|\s)\s*(\d{1,3})\s*(?:[x×*,]|\s)\s*(\d{1,3})$/;

/**
 * The supercell factors a feature-search query asks for, or null.
 * @param {string} query what was typed
 * @returns {{nx: number, ny: number, nz: number} | null}
 */
export function parseSupercellQuery(query) {
  let q = String(query ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!q) return null;
  q = q.replace(LEADING, '').replace(TRAILING, '').trim();
  let factors = null;
  const separated = SEPARATED.exec(q);
  if (separated) factors = separated.slice(1, 4).map(Number);
  else if (/^[1-9]{3}$/.test(q)) factors = [...q].map(Number);
  if (!factors || factors.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_FACTOR)) return null;
  const [nx, ny, nz] = factors;
  return { nx, ny, nz };
}
