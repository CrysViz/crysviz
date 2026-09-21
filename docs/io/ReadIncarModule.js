/**
 * VASP INCAR reader — magnetic tags only.
 *
 * An INCAR has no structure in it, so unlike every other reader in io/ this
 * one does not return a StructureContainer. It extracts the initial magnetic
 * moments (MAGMOM, read in the light of LNONCOLLINEAR / LSORBIT / SAXIS) and
 * checks them against an atom count supplied by the caller; ui/IncarSpinImport.js
 * owns the dialogs and writes the result into the selected structure's spins.
 *
 * Pure: no DOM, no model classes, so it runs under Node (docs/tests).
 *
 * ---------------------------------------------------------------------------
 * INCAR syntax (vasp.at/wiki/INCAR)
 * ---------------------------------------------------------------------------
 *   TAG = value            one statement per line ...
 *   A = 1 ; B = 2          ... or several, separated by `;`
 *   # comment, ! comment   everything after either character is ignored
 *   MAGMOM = 1 2 \         a trailing backslash continues the statement on
 *            3 4           the next line
 *   TAG = "multi           a double-quoted value may span lines
 *          line"
 *   GROUP { TAG = v }      nested tags, equivalent to GROUP/TAG = v
 *
 * ---------------------------------------------------------------------------
 * MAGMOM (vasp.at/wiki/MAGMOM, vasp.at/wiki/SAXIS)
 * ---------------------------------------------------------------------------
 *   collinear (the default, LNONCOLLINEAR = .FALSE.):
 *       NIONS signed scalars in POSCAR order         MAGMOM = 1.0 -1.0
 *   non-collinear (LNONCOLLINEAR = .TRUE., or implied by LSORBIT = .TRUE.):
 *       3*NIONS values, (m1 m2 m3) per atom          MAGMOM = 0 0 1  0 0 -1
 *   either may be shortened with Fortran repeat counts: 24*0.0, 2*-1
 *
 * The components are given in the spinor basis defined by SAXIS (default
 * (0,0,1), where they coincide with Cartesian x,y,z) — the same frame an OUTCAR
 * reports its moments in, so they are kept as `rawVector` and rotated by
 * utils/spinFrame.js exactly as io/ReadOutcarModule.js does. A collinear moment
 * is a scalar along the quantisation axis, i.e. (0,0,m) in that frame.
 *
 * The VASP wiki also writes MAGMOM with a VARIABLE where only the pattern is
 * fixed and the magnitude is left open (`MAGMOM = m -m`,
 * `MAGMOM = 0 0 m  0 0 -m`). Such a file does not fully specify the moments;
 * the symbols are reported back so the caller can ask what to do about them.
 */

// A Fortran-flavoured float: `1`, `-0.5`, `.5`, `1.0E-3`, `1.0d-3`.
const FLOAT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][-+]?\d+)?$/;
// A signed variable: `m`, `-m`, `+mFe`, `m_1`.
const SYMBOL = /^([-+]?)([A-Za-z_]\w*)$/;
// `N*value`, the Fortran repeat count.
const REPEAT = /^(\d+)\*(.*)$/;

// A repeat count is user input; `999999999*0` must not allocate a billion
// entries before the atom-count check gets a chance to reject it.
const MAX_MAGMOM_VALUES = 3_000_000;

/** The tags that carry (or qualify) magnetic information. */
export const INCAR_MAGNETIC_TAGS = Object.freeze(['MAGMOM', 'LNONCOLLINEAR', 'LSORBIT', 'SAXIS', 'ISPIN']);

/** Why an INCAR's moments could not be used. Stable ids for callers and tests. */
export const IncarSpinProblem = Object.freeze({
  NO_MAGNETIC_TAGS: 'no-magnetic-tags',
  NO_MAGMOM: 'no-magmom',
  EMPTY_MAGMOM: 'empty-magmom',
  INVALID_MAGMOM: 'invalid-magmom',
  INVALID_SAXIS: 'invalid-saxis',
  NO_STRUCTURE: 'no-structure',
  COUNT_MISMATCH: 'count-mismatch',
});

// ---------------------------------------------------------------------------
// Statement level
// ---------------------------------------------------------------------------

/**
 * Split an INCAR into `TAG = value` statements, honouring comments, `;`,
 * backslash continuation, quoted multi-line values and `{}` groups.
 *
 * Tag names are upper-cased. When a tag is repeated the FIRST assignment wins,
 * which is what VASP does; the repeats are listed in `duplicates`.
 *
 * @param {string} text
 * @returns {{tags: Map<string, string>, duplicates: string[]}}
 */
export function parseIncarTags(text) {
  const tags = new Map();
  const duplicates = [];
  const groups = [];
  let current = '';
  let inQuote = false;

  const flush = () => {
    const statement = current;
    current = '';
    const eq = statement.indexOf('=');
    if (eq < 0) return;
    const name = statement.slice(0, eq).trim().toUpperCase();
    if (!name || /\s/.test(name)) return;
    const full = [...groups, name].join('/');
    const value = statement.slice(eq + 1).replace(/\s+/g, ' ').trim();
    if (tags.has(full)) {
      if (!duplicates.includes(full)) duplicates.push(full);
    } else {
      tags.set(full, value);
    }
  };

  const src = String(text ?? '');
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (inQuote) {
      if (ch === '"') inQuote = false;
      else current += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === '#' || ch === '!') {
      // Comment: drop everything up to (not including) the newline, which
      // still has to end the statement.
      while (i + 1 < n && src[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '\\') {
      // Continuation only when nothing but blanks follows on this line.
      let j = i + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j++;
      if (j >= n || src[j] === '\n') {
        current += ' ';
        i = j;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '\n' || ch === ';') { flush(); continue; }
    if (ch === '{') {
      // `GROUP {` opens a nesting level; whatever preceded the brace is its name.
      groups.push(current.trim().toUpperCase());
      current = '';
      continue;
    }
    if (ch === '}') {
      flush();
      groups.pop();
      continue;
    }
    current += ch;
  }
  flush();

  return { tags, duplicates };
}

/**
 * A Fortran logical as VASP reads it: `.TRUE.`, `.T.`, `T`, `true`, and the
 * `F` counterparts. Anything else is null (not a logical).
 * @param {string | undefined} value
 * @returns {boolean | null}
 */
export function parseIncarLogical(value) {
  const m = /^\.?([tTfF])/.exec(String(value ?? '').trim());
  if (!m) return null;
  return m[1].toLowerCase() === 't';
}

function toNumber(token) {
  return Number(token.replace(/[dD]/, 'e'));
}

// ---------------------------------------------------------------------------
// MAGMOM
// ---------------------------------------------------------------------------

/**
 * @typedef {{kind: 'number', value: number}
 *         | {kind: 'symbol', name: string, sign: 1 | -1}} MagmomEntry
 */

/**
 * Expand a MAGMOM right-hand side into one entry per value.
 *
 * @param {string} value
 * @returns {{entries: MagmomEntry[], symbols: string[], invalid: string[]}}
 *   `symbols` are the distinct variable names in order of appearance;
 *   `invalid` the tokens that are neither a number nor a signed variable.
 */
export function parseMagmomValue(value) {
  /** @type {MagmomEntry[]} */
  const entries = [];
  const symbols = [];
  const invalid = [];

  // List-directed input allows commas; `3 * 1.0` is tolerated as `3*1.0`.
  const tokens = String(value ?? '')
    .replace(/,/g, ' ')
    .replace(/\s*\*\s*/g, '*')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    let count = 1;
    let body = token;
    const repeat = REPEAT.exec(token);
    if (repeat) {
      count = Number(repeat[1]);
      body = repeat[2];
    }

    /** @type {MagmomEntry | null} */
    let entry = null;
    if (FLOAT.test(body)) {
      const number = toNumber(body);
      if (Number.isFinite(number)) entry = { kind: 'number', value: number };
    } else {
      const symbol = SYMBOL.exec(body);
      if (symbol) {
        entry = { kind: 'symbol', name: symbol[2], sign: symbol[1] === '-' ? -1 : 1 };
        if (!symbols.includes(symbol[2])) symbols.push(symbol[2]);
      }
    }

    if (!entry || !Number.isSafeInteger(count) || entries.length + count > MAX_MAGMOM_VALUES) {
      invalid.push(token);
      continue;
    }
    for (let k = 0; k < count; k++) entries.push(entry);
  }

  return { entries, symbols, invalid };
}

/**
 * Everything in an INCAR that bears on the magnetic moments, as written — not
 * yet compared with any structure.
 *
 * @param {string} text
 * @returns {{
 *   present: Record<string, string>,
 *   duplicates: string[],
 *   noncollinear: boolean,
 *   lsorbit: boolean,
 *   ispin: number | null,
 *   saxis: number[] | null,
 *   saxisInvalid: boolean,
 *   magmom: ReturnType<typeof parseMagmomValue> | null,
 * }}
 *   `present` maps each magnetic tag that was set to its raw right-hand side.
 *   `saxis` is null when the tag is absent (the default (0,0,1) applies).
 */
export function readIncarMagnetism(text) {
  const { tags, duplicates } = parseIncarTags(text);

  /** @type {Record<string, string>} */
  const present = {};
  for (const tag of INCAR_MAGNETIC_TAGS) {
    if (tags.has(tag)) present[tag] = tags.get(tag);
  }

  const lsorbit = parseIncarLogical(present.LSORBIT) === true;
  // LSORBIT = .TRUE. switches LNONCOLLINEAR on by itself.
  const noncollinear = lsorbit || parseIncarLogical(present.LNONCOLLINEAR) === true;

  let ispin = null;
  if ('ISPIN' in present) {
    const parsed = parseInt(present.ISPIN, 10);
    if (Number.isFinite(parsed)) ispin = parsed;
  }

  let saxis = null;
  let saxisInvalid = false;
  if ('SAXIS' in present) {
    const parts = present.SAXIS.replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
    const numbers = parts.map((p) => (FLOAT.test(p) ? toNumber(p) : NaN));
    if (numbers.length === 3 && numbers.every(Number.isFinite) && numbers.some((v) => v !== 0)) {
      saxis = numbers;
    } else {
      saxisInvalid = true;
    }
  }

  return {
    present,
    duplicates: duplicates.filter((tag) => INCAR_MAGNETIC_TAGS.includes(tag)),
    noncollinear,
    lsorbit,
    ispin,
    saxis,
    saxisInvalid,
    magmom: 'MAGMOM' in present ? parseMagmomValue(present.MAGMOM) : null,
  };
}

// ---------------------------------------------------------------------------
// Against a structure
// ---------------------------------------------------------------------------

function shorten(text, max = 120) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Decide whether the INCAR's moments can be put on a structure of `natoms`
 * atoms, and if so lay them out per atom.
 *
 * @param {ReturnType<typeof readIncarMagnetism>} info
 * @param {number} natoms atoms in the structure the moments are meant for
 *   (0 / undefined when none is loaded)
 * @returns {{ok: false, problem: string, message: string}
 *         | {ok: true, noncollinear: boolean, saxis: number[], saxisIsDefault: boolean,
 *            perAtom: MagmomEntry[][], symbols: string[], notes: string[]}}
 *   `perAtom[i]` is the three SAXIS-frame components of atom i — (0,0,m) for a
 *   collinear moment — still possibly symbolic; see `incarRawVectors`.
 */
export function resolveIncarSpins(info, natoms) {
  const fail = (problem, message) => ({ ok: false, problem, message });
  const { present, magmom } = info;

  const setTags = ['MAGMOM', 'SAXIS', 'LNONCOLLINEAR'].filter((tag) => tag in present);
  if (!setTags.length) {
    return fail(IncarSpinProblem.NO_MAGNETIC_TAGS,
      'This INCAR sets none of MAGMOM, SAXIS or LNONCOLLINEAR, so it carries no magnetic information.');
  }
  if (!magmom) {
    return fail(IncarSpinProblem.NO_MAGMOM,
      `This INCAR sets ${setTags.join(' and ')} but not MAGMOM, so it has no per-atom moments to load. `
      + '(VASP would start every atom from its default of 1 μB, which says nothing about the magnetic structure.)');
  }
  if (magmom.invalid.length) {
    return fail(IncarSpinProblem.INVALID_MAGMOM,
      `MAGMOM contains ${magmom.invalid.length === 1 ? 'a value' : 'values'} that cannot be read: `
      + `${shorten(magmom.invalid.join(' '))}. Each value must be a number or a signed variable such as m or -m, `
      + 'optionally with a repeat count (4*1.5).');
  }
  if (!magmom.entries.length) {
    return fail(IncarSpinProblem.EMPTY_MAGMOM, 'MAGMOM is set but lists no values.');
  }
  if (info.saxisInvalid) {
    return fail(IncarSpinProblem.INVALID_SAXIS,
      `SAXIS is set to “${shorten(present.SAXIS)}”, which is not a non-zero vector of three numbers, `
      + 'so the direction of the moments cannot be determined.');
  }
  if (!natoms) {
    return fail(IncarSpinProblem.NO_STRUCTURE,
      'An INCAR holds magnetic moments but no atoms. Load the structure they belong to first '
      + '(for example the POSCAR of the same run), select it, and then load the INCAR.');
  }

  const noncollinear = info.noncollinear;
  const count = magmom.entries.length;
  const expected = noncollinear ? 3 * natoms : natoms;
  if (count !== expected) {
    const mode = noncollinear
      ? `three values per atom (${info.lsorbit && parseIncarLogical(present.LNONCOLLINEAR) !== true
        ? 'LSORBIT = .TRUE. implies a non-collinear run' : 'LNONCOLLINEAR = .TRUE.'})`
      : 'one value per atom (LNONCOLLINEAR is not .TRUE., so the run is collinear)';
    let hint = 'The INCAR probably belongs to a different structure.';
    if (!noncollinear && count === 3 * natoms) {
      hint = 'That is exactly three values per atom — the non-collinear layout — but this INCAR does not set '
        + 'LNONCOLLINEAR = .TRUE. (or LSORBIT = .TRUE.).';
    } else if (noncollinear && count === natoms) {
      hint = 'That is exactly one value per atom — the collinear layout — but this INCAR asks for a '
        + 'non-collinear run, which needs a 3-vector per atom.';
    }
    return fail(IncarSpinProblem.COUNT_MISMATCH,
      `MAGMOM lists ${count} value${count === 1 ? '' : 's'}, but the selected structure has ${natoms} `
      + `atom${natoms === 1 ? '' : 's'} and needs ${expected}: ${mode}. ${hint}`);
  }

  /** @type {MagmomEntry} */
  const zero = { kind: 'number', value: 0 };
  const perAtom = [];
  for (let i = 0; i < natoms; i++) {
    perAtom.push(noncollinear
      ? [magmom.entries[3 * i], magmom.entries[3 * i + 1], magmom.entries[3 * i + 2]]
      : [zero, zero, magmom.entries[i]]);
  }

  const notes = [];
  if (info.lsorbit && parseIncarLogical(present.LNONCOLLINEAR) !== true) {
    notes.push('LSORBIT = .TRUE. implies a non-collinear run, so MAGMOM was read as a 3-vector per atom.');
  }
  if (!noncollinear && info.ispin !== 2) {
    notes.push(`ISPIN is ${info.ispin === null ? 'not set' : `set to ${info.ispin}`}, not 2, `
      + 'so VASP itself would ignore MAGMOM in this run.');
  }
  if (!noncollinear) {
    notes.push('Collinear moments have no direction of their own; they are drawn along SAXIS.');
  }
  if (info.duplicates.length) {
    notes.push(`${info.duplicates.join(', ')} ${info.duplicates.length === 1 ? 'is' : 'are'} set more than once; `
      + 'the first assignment was used, as VASP does.');
  }
  if (magmom.entries.every((e) => e.kind === 'number' && e.value === 0)) {
    notes.push('Every moment is zero, so no arrows will be drawn.');
  }

  return {
    ok: true,
    noncollinear,
    saxis: info.saxis ? [...info.saxis] : [0, 0, 1],
    saxisIsDefault: !info.saxis,
    perAtom,
    symbols: [...magmom.symbols],
    notes,
  };
}

/**
 * Numeric SAXIS-frame vectors from `resolveIncarSpins().perAtom`, giving every
 * variable the magnitude `symbolValue` (its sign is kept: `-m` -> -symbolValue).
 *
 * @param {MagmomEntry[][]} perAtom
 * @param {number} [symbolValue]
 * @returns {number[][]}
 */
export function incarRawVectors(perAtom, symbolValue = 1) {
  return perAtom.map((components) => components.map(
    (entry) => (entry.kind === 'number' ? entry.value : entry.sign * symbolValue)));
}
