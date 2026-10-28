// Fuzzy matching for the feature search palette (ui/FeatureSearch.js).
//
// Each query word must match somewhere in an entry (label, keywords or path);
// an entry's score is the sum of its words' best matches, so "bond hist"
// finds "Bond Length Histogram" and "hist bond" does too. Per word, the
// strongest kind of match wins:
//
//   exact word   "bonds"  -> "Show Bonds"
//   word prefix  "supe"   -> "Supercell"
//   substring    "cell"   -> "Supercell"
//   word form    "relaxation" -> "Relax", "vibrations" -> "vibrational",
//                "optimise" -> "optimize" (stem(): British/American spelling
//                            folded, common suffixes off)
//   initials     "blh"    -> "Bond Length Histogram"
//   subsequence  "phnn"   -> "Phonons" (fzf-style: in-order letters, scored
//                            up for word starts and runs of adjacent letters;
//                            too widely scattered letters don't count)
//   typo         "phonom" -> "Phonons" (one edit per ~4 letters, Damerau:
//                            a swapped pair counts as one edit)
//
// Matching is case- and accent-insensitive. Positions are returned for the
// label only, so the palette can bold the matched letters.
//
// An entry may also carry `aliases`: whole phrases it answers to (the search
// vocabulary, search/concepts.js). The query is scored against each phrase on
// its own, so "lattice vibrations" matches the alias "lattice vibrations" of
// Phonons although neither word is in its label; the best of label and
// aliases wins, and the result names the alias it matched.

/** Lower-case, accents stripped ("Å" -> "a"), so "angstrom" finds "Ångström". */
export function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Start offsets of the words in an already-normalized string. */
function wordStarts(text) {
  const starts = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!/[a-z0-9Ͱ-Ͽ]/.test(c)) continue;
    const prev = i ? text[i - 1] : ' ';
    if (!/[a-z0-9Ͱ-Ͽ]/.test(prev)) starts.push(i);
  }
  return starts;
}

function words(text) {
  return text.split(/[^a-z0-9Ͱ-Ͽ]+/).filter(Boolean);
}

/** Optimal-string-alignment distance, capped: returns max+1 as soon as the
 *  distance must exceed `max`. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// Suffixes stem() takes off, longest first.
const SUFFIXES = [
  'izations', 'ization', 'ational', 'ations', 'ation', 'izing', 'ized', 'izes', 'ize',
  'ings', 'ing', 'ions', 'ion', 'isms', 'ism', 'ists', 'ist', 'ers', 'er', 'ed', 'es', 'ic', 'al', 'ly', 'y', 's',
];

/** A word reduced to a crude stem, for matching word forms: British and
 *  American spellings folded (colour/color, optimise/optimize), plurals and
 *  common suffixes off — "optimisation", "optimizing" and "optimize" all
 *  become "optim"; "vibrations" and "vibrational" become "vibr". Never shorter
 *  than three letters. Not a linguistic stemmer: it only has to make the
 *  forms people type meet the forms the UI uses. */
export function stem(word) {
  const w = String(word)
    .replace(/our(s?)$/, 'or$1') // colour(s) -> color(s), neighbour -> neighbor
    .replace(/is(ations?|e|es|ed|ing)$/, 'iz$1') // optimise -> optimize
    .replace(/ies$/, 'y'); // densities -> density
  for (const suf of SUFFIXES) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}

function range(start, n) {
  return Array.from({ length: n }, (_, i) => start + i);
}

/**
 * Best match of one normalized query word in one normalized text.
 * @returns {{ score: number, positions: number[] } | null}
 */
export function matchWord(word, text) {
  if (!word || !text) return null;
  const starts = wordStarts(text);

  // Exact word / word prefix / substring.
  const idx = text.indexOf(word);
  if (idx >= 0) {
    // Prefer an occurrence at a word start over the first occurrence.
    let at = idx;
    for (const s of starts) {
      if (text.startsWith(word, s)) { at = s; break; }
    }
    const atStart = starts.includes(at);
    const end = at + word.length;
    const wholeWord = atStart && (end === text.length || !/[a-z0-9Ͱ-Ͽ]/.test(text[end]));
    const base = wholeWord ? 100 : atStart ? 80 : 55;
    // Earlier and longer matches rank a little higher.
    return { score: base + Math.min(word.length, 10) - Math.min(at, 20) * 0.25, positions: range(at, word.length) };
  }

  // Word forms: "relaxation" -> "Relax", "vibrations" -> "vibrational",
  // "optimise" -> "optimize". A stem of four letters or more also matches the
  // start of a longer one ("crystal" -> "crystallography").
  if (word.length >= 3) {
    const sw = stem(word);
    let offset = 0;
    for (const w of words(text)) {
      const at = text.indexOf(w, offset);
      offset = at + w.length;
      const st = stem(w);
      if (st === sw) return { score: 74, positions: range(at, w.length) };
      if (sw.length >= 4 && st.startsWith(sw)) return { score: 66, positions: range(at, w.length) };
    }
  }

  // Initials: "blh" -> Bond Length Histogram.
  if (word.length >= 2 && starts.length >= word.length) {
    let si = 0;
    const pos = [];
    for (const c of word) {
      while (si < starts.length && text[starts[si]] !== c) si++;
      if (si >= starts.length) break;
      pos.push(starts[si]);
      si++;
    }
    if (pos.length === word.length) return { score: 60 + word.length, positions: pos };
  }

  // Subsequence, fzf-style.
  let ti = 0;
  const pos = [];
  for (const c of word) {
    while (ti < text.length && text[ti] !== c) ti++;
    if (ti >= text.length) { pos.length = 0; break; }
    pos.push(ti);
    ti++;
  }
  if (pos.length === word.length && word.length >= 2) {
    let bonus = 0;
    for (let i = 0; i < pos.length; i++) {
      if (starts.includes(pos[i])) bonus += 3;
      if (i && pos[i] === pos[i - 1] + 1) bonus += 2;
    }
    const spread = pos[pos.length - 1] - pos[0] + 1 - pos.length; // skipped letters
    // Letters scattered across a long label ("npt" in "and pan to") are
    // noise, not a match.
    if (spread <= Math.max(3, word.length * 1.5)) {
      const score = 20 + bonus + word.length - spread * 0.6;
      if (score > 18) return { score, positions: pos };
    }
  }

  // Typo tolerance against whole words (and their prefixes of the same
  // length, so "phonom" still hits "phonons").
  if (word.length >= 4) {
    const max = word.length >= 8 ? 2 : 1;
    let best = null;
    let offset = 0;
    for (const w of words(text)) {
      const at = text.indexOf(w, offset);
      offset = at + w.length;
      for (const cand of [w, w.slice(0, word.length)]) {
        const d = editDistance(word, cand, max);
        if (d <= max) {
          const score = 40 - d * 8;
          if (!best || score > best.score) best = { score, positions: range(at, Math.min(cand.length, w.length)) };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

// An alias match ranks a little under the same match on the label itself.
const ALIAS_WEIGHT = 0.9;

// In a phrase a word must match from a word start (whole word, prefix, word
// form, initials) — or, five letters or longer, as a typo or in-order letters.
// Without it short query words leak in through any long phrase ("cu" inside
// "occupancies", "rbl" in "variable").
const PHRASE_MIN_SCORE = 60;

/** Score a normalized query against one phrase on its own: every word must
 *  match in it; reading it from its start, and covering more of it, score up. */
function scorePhrase(q, text) {
  let total = 0;
  for (const word of q.split(/\s+/)) {
    const m = matchWord(word, text);
    if (!m || (m.score < PHRASE_MIN_SCORE && word.length < 5)) return 0;
    total += m.score;
  }
  if (text.startsWith(q)) total += 25 + 25 * Math.min(1, q.length / text.length);
  return total;
}

/**
 * Score an entry against a query: its label/keywords/path, or one of its
 * aliases, whichever matches better.
 * @param {string} query raw user text
 * @param {{ label: string, keywords?: string[], path?: string, pathSearchable?: boolean, aliases?: string[] }} entry
 * @returns {{ score: number, positions: number[], alias?: string } | null}
 *   positions index the label; alias is set when an alias won
 */
export function scoreEntry(query, entry) {
  const q = normalize(query).trim();
  if (!q) return null;
  let best = scoreLabel(q, entry);
  for (const alias of entry.aliases || []) {
    const score = scorePhrase(q, normalize(alias)) * ALIAS_WEIGHT;
    if (score && (!best || score > best.score)) best = { score, positions: [], alias };
  }
  return best;
}

/** The label/keywords/path score (each query word matched where it scores best). */
function scoreLabel(q, entry) {
  const label = normalize(entry.label);
  const keywords = (entry.keywords || []).map(normalize);
  // Structure results (search/structureEntries.js) do not match on where they
  // live: "atoms" would otherwise list every atom of the structure.
  const path = entry.pathSearchable === false ? '' : normalize(entry.path || '');
  let total = 0;
  const positions = [];
  for (const word of q.split(/\s+/)) {
    const onLabel = matchWord(word, label);
    let best = onLabel ? onLabel.score : 0;
    for (const kw of keywords) {
      const m = matchWord(word, kw);
      if (m) best = Math.max(best, m.score * 0.8);
    }
    const onPath = matchWord(word, path);
    if (onPath) best = Math.max(best, onPath.score * 0.55);
    if (!best) return null; // every word must match somewhere
    if (onLabel && onLabel.score >= best) positions.push(...onLabel.positions);
    total += best;
  }
  // The whole query reading the label from its start ("show bo" -> "Show
  // Bonds") beats the same words scattered around it, and the more of the
  // label the query covers, the closer the match ("bond": Bonds > Bond Diameter).
  if (label.startsWith(q)) total += 25 + 25 * Math.min(1, q.length / label.length);
  return { score: total, positions: [...new Set(positions)].sort((a, b) => a - b) };
}
