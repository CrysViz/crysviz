/**
 * The one table of file formats CrysViz recognises, and the detector that
 * decides which one a given file is.
 *
 * This replaces the `treatAsCube` / `treatAsCHGCAR` / `treatAsELFCAR` /
 * `treatAsCrysviz` chain that used to live in `core/crystal-viewer.js` and the
 * parallel chain in `io/load_structure.js`. Those two lists had drifted apart —
 * `loadStructure` knew about field files and `parse_any` knew about structure
 * files, and adding a format meant editing whichever one you happened to think
 * of first.
 *
 * ---------------------------------------------------------------------------
 * Detection: CONTENT first, filename second
 * ---------------------------------------------------------------------------
 * Filenames are a poor guide to what a file is. Every DFT code writes its main
 * output to something called `*.out`, so an FHI-aims run saved as `relax.out`
 * or `Si.scf.out` used to be sent to the Quantum ESPRESSO reader (or to the
 * POSCAR fallback) purely on the strength of its extension; CIFs arrive as
 * `download` or `structure.txt`; a CHGCAR is regularly renamed to keep several
 * of them apart.
 *
 * So `detectFormat` looks at the first `HEAD_BYTES` of the file before it looks
 * at the name. Every descriptor below carries a `sniff(head)` that answers
 * "does this look like my format?" from the markers each code cannot help
 * printing — `Invoking FHI-aims`, `Program PWSCF`, ` vasp.6`, `BEGIN header`,
 * `%BLOCK LATTICE_CART`, `data_` / `_cell_length_a`, the WAVECAR RTAG, and so
 * on. The rules are:
 *
 *   1. Every descriptor whose `sniff` accepts the head is a candidate.
 *   2. Exactly one candidate: that is the format, whatever the name says.
 *   3. Several candidates: the one whose `matchesName` also accepts the name
 *      wins (CHGCAR and ELFCAR are byte-for-byte the same layout, so only the
 *      name can tell them apart); failing that, the FIRST candidate in table
 *      order. Order therefore encodes "contains the other": an aims.out
 *      echoes geometry.in syntax, so `aims-out` precedes `aims-geometry`.
 *   4. No candidate: fall back to the filename, first `matchesName` wins,
 *      exactly as detection always worked.
 *   5. Nothing matched: POSCAR, which has neither a distinguishing extension
 *      nor a distinguishing header.
 *
 * The sniffers are deliberately conservative. A false negative costs nothing
 * (the name decides, as before); a false positive sends a file to the wrong
 * reader. So they key on line-anchored keywords a format cannot do without,
 * not on tokens that might appear in a comment.
 *
 * ---------------------------------------------------------------------------
 * Descriptor shape
 * ---------------------------------------------------------------------------
 *   id            stable identifier
 *   label         human-readable, used in messages
 *   kind          how the loader should supply the bytes:
 *                   'text'          - `readAllText()`, the historical default
 *                   'binary'        - `readAllBytes()` (ASE .traj)
 *                   'random-access' - the FileSource itself, never materialised
 *   matchesName   (lowercasedFileName) => boolean
 *   sniff         (head: Head) => boolean, see `prepareHead` for the shape
 *   handledBy     'viewer'    - core/crystal-viewer.js dispatches it directly
 *                               (field files and .crysviz sessions, which need
 *                               UI wiring rather than a pure parse)
 *                 'parse_any' - io/load_structure.js returns a StructureContainer
 */

import { RTAG_SINGLE, RTAG_DOUBLE } from '../model/WavefunctionSource.js';

/**
 * How much of a file the detector looks at.
 *
 * Big enough that the marker is in view for every text format we know: the
 * FHI-aims banner is on line 2, `Program PWSCF` on line 1, ` vasp.` on line 1,
 * and a CHGCAR's grid-dimension line follows a POSCAR header of a few hundred
 * atoms. Small enough that reading it is free even for a multi-GB WAVECAR
 * (one Blob slice) or a 17 MB cube held as a string (one `slice`).
 */
export const HEAD_BYTES = 32 * 1024;

/**
 * @typedef {{bytes: Uint8Array | null, text: string, lines: string[]}} Head
 * `bytes` is null when the head came from an in-memory string (nothing binary
 * can be sniffed there, which is fine: binary formats never arrive as text).
 */

/** How the bytes should be handed to the reader. */
export const SourceKind = Object.freeze({
  TEXT: 'text',
  BINARY: 'binary',
  RANDOM_ACCESS: 'random-access',
});

/** Which layer owns the dispatch for a format. */
export const HandledBy = Object.freeze({
  VIEWER: 'viewer',
  PARSE_ANY: 'parse_any',
});

// ---------------------------------------------------------------------------
// Sniffer helpers
// ---------------------------------------------------------------------------

// A Fortran-flavoured float: `1`, `-0.5`, `.5`, `1.0E-3`, `1.0d-3`.
const FLOAT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][-+]?\d+)?$/;
const INT = /^[-+]?\d+$/;
const POSITIVE_INT = /^\d+$/;
// An element symbol as it appears in an XYZ atom line (case-insensitive: some
// codes write `FE`, others `fe`).
const SYMBOL = /^[A-Za-z]{1,2}$/;

/** @param {string} line */
function tokens(line) {
  const t = line.trim();
  return t ? t.split(/\s+/) : [];
}

/** First `n` tokens of the line are floats (extra tokens are allowed). */
function startsWithFloats(line, n) {
  const t = tokens(line);
  if (t.length < n) return false;
  for (let i = 0; i < n; i++) if (!FLOAT.test(t[i])) return false;
  return true;
}

/** `int f f f`, the shape of a cube header row (optionally more tokens). */
function isIntThenFloats(line) {
  const t = tokens(line);
  return t.length >= 4 && INT.test(t[0]) && FLOAT.test(t[1]) && FLOAT.test(t[2]) && FLOAT.test(t[3]);
}

/** A line that is nothing but one positive integer (an XYZ atom count). */
function isLoneInt(line) {
  const t = tokens(line);
  return t.length === 1 && POSITIVE_INT.test(t[0]);
}

/** Exactly three positive integers: a CHGCAR's `NGX NGY NGZ`. */
function isThreeInts(line) {
  const t = tokens(line);
  return t.length === 3 && t.every((x) => POSITIVE_INT.test(x));
}

/**
 * Lines 2..5 of a POSCAR: a scale factor, then three lattice rows. Shared by
 * the CHGCAR sniffer; a POSCAR proper is the fallback and is never sniffed.
 * @param {string[]} lines
 */
function hasPoscarHeader(lines) {
  return lines.length >= 5
    && startsWithFloats(lines[1], 1)
    && startsWithFloats(lines[2], 3)
    && startsWithFloats(lines[3], 3)
    && startsWithFloats(lines[4], 3);
}

const ULM_MAGIC = '- of Ulm';
const DOUBLE = 8;

// ---------------------------------------------------------------------------
// Sniffers, one per format (or per family, for CHGCAR/ELFCAR)
// ---------------------------------------------------------------------------

/** @param {Head} head */
function sniffCrysviz(head) {
  return /^\s*\{/.test(head.text) && /"format"\s*:\s*"crysviz"/.test(head.text);
}

/**
 * The tell is the RTAG in the third float64: 45200 or 45210 is a very specific
 * bit pattern to hit by chance, and it sits alongside a plausible record length
 * and spin count. Layout per `model/WavefunctionSource.js`.
 * @param {Head} head
 */
function sniffWavecar(head) {
  const bytes = head.bytes;
  if (!bytes || bytes.byteLength < 4 * DOUBLE) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const recl = view.getFloat64(0, true);
  const nspin = view.getFloat64(DOUBLE, true);
  const rtag = Math.round(view.getFloat64(2 * DOUBLE, true));
  if (!(rtag === RTAG_SINGLE || rtag === RTAG_DOUBLE)) return false;
  if (!(recl > 0 && Number.isFinite(recl))) return false;
  return nspin === 1 || nspin === 2;
}

/**
 * A Gaussian cube: two free comment lines, then `natoms ox oy oz` and three
 * `n vx vy vz` rows. Four consecutive int-then-three-floats rows starting on
 * line 3 is not a shape any other text format here has, except an XYZ written
 * with atomic numbers — which is told apart by its lone-integer first line.
 * @param {Head} head
 */
function sniffCube(head) {
  const l = head.lines;
  if (l.length < 6) return false;
  if (isLoneInt(l[0])) return false;
  return isIntThenFloats(l[2]) && isIntThenFloats(l[3])
    && isIntThenFloats(l[4]) && isIntThenFloats(l[5]);
}

/**
 * CHGCAR / ELFCAR / LOCPOT and friends: a POSCAR header, a blank line, then
 * `NGX NGY NGZ`. Identical layouts, so this one sniffer serves both
 * descriptors and the name is the tiebreak (rule 3 above).
 * @param {Head} head
 */
function sniffVaspVolumetric(head) {
  const l = head.lines;
  if (!hasPoscarHeader(l)) return false;
  for (let i = 5; i + 1 < l.length; i++) {
    if (l[i].trim() === '' && isThreeInts(l[i + 1])) return true;
  }
  return false;
}

/**
 * ASE ULM: eight magic bytes `- of Ulm`. The reader here also accepts a file
 * whose JSON header (with its `descriptor` array) sits at byte 0, so that
 * shape is accepted too.
 * @param {Head} head
 */
function sniffTraj(head) {
  if (head.text.startsWith(ULM_MAGIC)) return true;
  return /^\s*\{/.test(head.text) && head.text.includes('"descriptor"');
}

// Tags only a magnetic CIF carries. `##CIF_2.0` is included because the plain
// CIF parser cannot read CIF 2.0 and the mCIF path can.
const MCIF_MARKERS = /^\s*(?:##CIF_2\.0\b|_space_group_symop_magn_operation|_space_group_magn[._]|_parent_space_group|_atom_site_moment)/im;
// Tags every CIF has at least one of. Line-anchored so an incidental `data_`
// in a comment elsewhere cannot trigger it.
const CIF_MARKERS = /^\s*(?:data_\S*\s*$|_cell_(?:length|angle)_[abc]\b|_symmetry_space_group_name_h-m\b|_space_group_name_h-m_alt\b|_atom_site_fract_[xyz]\b)/im;

/** @param {Head} head */
function sniffMagCIF(head) {
  return MCIF_MARKERS.test(head.text);
}

/**
 * A plain CIF: generic CIF tags and NONE of the magnetic ones. Disjoint from
 * `sniffMagCIF` on purpose, so a magnetic CIF is never a plain-CIF candidate.
 * @param {Head} head
 */
function sniffCIF(head) {
  return !MCIF_MARKERS.test(head.text) && CIF_MARKERS.test(head.text);
}

/**
 * pw.x output. `Program PWSCF` is line 1 of every run; the cell/alat lines
 * cover a file whose banner was trimmed off.
 * @param {Head} head
 */
function sniffPWSCFOut(head) {
  const t = head.text;
  if (/^\s*Program PWSCF\b/m.test(t)) return true;
  if (/bravais-lattice index/.test(t)) return true;
  if (/lattice parameter \(alat\)/.test(t)) return true;
  if (/celldm\(1\)=/.test(t) && /crystal axes:/.test(t)) return true;
  if (/End of self-consistent calculation/.test(t)) return true;
  return /^!\s+total energy\s+=/m.test(t);
}

/**
 * pw.x input: a Fortran namelist, or the ATOMIC_SPECIES + ATOMIC_POSITIONS
 * cards, or K_POINTS. ATOMIC_POSITIONS alone is not enough — the output echoes
 * it for every relaxation step (with `CELL_PARAMETERS`), which is exactly why
 * `pwscf-out` is tested first.
 * @param {Head} head
 */
function sniffPWSCFIn(head) {
  const t = head.text;
  if (/^\s*&(?:control|system|electrons|ions|cell)\b/im.test(t)) return true;
  if (/^\s*ATOMIC_SPECIES\b/im.test(t) && /^\s*ATOMIC_POSITIONS\b/im.test(t)) return true;
  return /^\s*K_POINTS\b/im.test(t);
}

/**
 * VASP OUTCAR: ` vasp.6.4.2 ...` on line 1, then the INCAR/POTCAR echo and
 * `Startparameter for this run`. Any one is decisive.
 * @param {Head} head
 */
function sniffOUTCAR(head) {
  const t = head.text;
  if (/^\s*vasp\.\d/m.test(t)) return true;
  if (/^\s*(?:POTCAR|INCAR):/m.test(t)) return true;
  if (/Startparameter for this run/.test(t)) return true;
  if (/VRHFIN\s*=/.test(t)) return true;
  return /POSITION\s+TOTAL-FORCE/.test(t);
}

/**
 * XYZ / extended XYZ: a lone atom count, a comment (the extxyz `Lattice=`
 * line), then `El x y z` or `Z x y z`.
 * @param {Head} head
 */
function sniffXYZ(head) {
  const l = head.lines;
  if (l.length < 3 || !isLoneInt(l[0])) return false;
  const t = tokens(l[2]);
  if (t.length < 4) return false;
  if (!(SYMBOL.test(t[0]) || POSITIVE_INT.test(t[0]))) return false;
  return FLOAT.test(t[1]) && FLOAT.test(t[2]) && FLOAT.test(t[3]);
}

/**
 * SHELX / AIRSS .res: `TITL` opens each block and `CELL`/`SFAC` follow.
 * @param {Head} head
 */
function sniffRes(head) {
  const t = head.text;
  return /^\s*TITL\b/m.test(t) && (/^\s*CELL\b/m.test(t) || /^\s*SFAC\b/m.test(t));
}

/**
 * CASTEP .cell: a `%BLOCK` opening one of the structural blocks (spaces and
 * underscores are interchangeable in CASTEP block names).
 * @param {Head} head
 */
function sniffCastepCell(head) {
  return /^\s*%BLOCK\s+(?:LATTICE[_ ]CART|LATTICE[_ ]ABC|POSITIONS[_ ]FRAC|POSITIONS[_ ]ABS)\b/im.test(head.text);
}

/**
 * CASTEP .geom / .md / .ts: `BEGIN header` preamble, `<-- E` / `<-- h` /
 * `<-- R` tagged rows.
 * @param {Head} head
 */
function sniffCastepGeom(head) {
  const t = head.text;
  return /^\s*BEGIN header\b/m.test(t) || /<--\s*[EhRFSTcv]\s*$/m.test(t);
}

/**
 * FHI-aims output. `Invoking FHI-aims ...` is line 2 of every run; the
 * geometry echo and update markers cover a trimmed file (and the test
 * fixtures, which start at `Input geometry:`).
 * @param {Head} head
 */
function sniffAimsOut(head) {
  const t = head.text;
  if (/Invoking FHI-aims/.test(t)) return true;
  if (/^\s*Input geometry:/m.test(t)) return true;
  if (/Updated atomic structure:/.test(t)) return true;
  if (/\|\s*Total energy\s+(?:un)?corrected\s*:/.test(t)) return true;
  return /Begin self-consistency (?:loop|iteration)/.test(t);
}

/**
 * FHI-aims geometry.in: `lattice_vector x y z`, `atom x y z El`,
 * `atom_frac x y z El`. An aims.out echoes exactly these lines, which is why
 * `aims-out` comes first in the table.
 * @param {Head} head
 */
function sniffAimsGeometry(head) {
  return /^\s*(?:lattice_vector|atom|atom_frac)\s+[-+.\dEeDd]+\s+[-+.\dEeDd]+\s+[-+.\dEeDd]+(?:\s|$)/m.test(head.text);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Ordered list. Order matters twice: among several content candidates with no
 * name match (rule 3), and for the filename fallback (rule 4), where the first
 * `matchesName` wins so more specific patterns come before more general ones.
 * POSCAR is not in this table at all; it is the fallback in `detectFormat`,
 * because a POSCAR has neither a distinguishing extension nor a
 * distinguishing header.
 *
 * @type {Array<{id: string, label: string, kind: string, handledBy: string,
 *               matchesName: (lower: string) => boolean,
 *               sniff: ((head: Head) => boolean) | null}>}
 */
export const FORMATS = [
  {
    id: 'crysviz',
    label: 'CrysViz session',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.endsWith('.crysviz'),
    sniff: sniffCrysviz,
  },
  {
    id: 'wavecar',
    label: 'VASP WAVECAR',
    // The whole point: opened by byte range, never read in full.
    kind: SourceKind.RANDOM_ACCESS,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.includes('wavecar'),
    sniff: sniffWavecar,
  },
  {
    id: 'traj',
    label: 'ASE trajectory',
    // Binary ULM; the parser needs the raw float64 data, so this must not go
    // through a text decode.
    kind: SourceKind.BINARY,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.traj'),
    sniff: sniffTraj,
  },
  {
    id: 'cube',
    label: 'Gaussian cube',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.includes('.cube'),
    sniff: sniffCube,
  },
  {
    id: 'chgcar',
    label: 'VASP CHGCAR',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.includes('chgcar'),
    // Same layout as ELFCAR; the name decides between them, CHGCAR by default.
    sniff: sniffVaspVolumetric,
  },
  {
    id: 'elfcar',
    label: 'VASP ELFCAR',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.includes('elfcar'),
    sniff: sniffVaspVolumetric,
  },
  {
    id: 'mcif',
    label: 'magnetic CIF',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('.mcif') || /(^|\W)mcif(\W|$)/.test(lower),
    sniff: sniffMagCIF,
  },
  {
    id: 'cif',
    label: 'CIF',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('.cif') || /(^|\W)cif(\W|$)/.test(lower),
    sniff: sniffCIF,
  },
  {
    id: 'pwscf-out',
    label: 'Quantum ESPRESSO output',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('.scf.out')
      || lower.includes('.scf.in.out')
      || lower.includes('.vcrx.out')
      || lower.includes('.vcrx.in.out'),
    sniff: sniffPWSCFOut,
  },
  {
    id: 'pwscf-in',
    label: 'Quantum ESPRESSO input',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.scf.in') || lower.endsWith('.vcrx.in'),
    sniff: sniffPWSCFIn,
  },
  {
    id: 'outcar',
    label: 'VASP OUTCAR',
    // An MD OUTCAR is routinely hundreds of MB of text. Reading it in full made
    // the load path hold ~4-5x the file size at once (the string, two line-array
    // splits and a structured clone into the parse worker), so the reader takes
    // the FileSource, hands its Blob to the worker by reference and parses it in
    // bounded chunks. See io/ReadOutcarModule.js.
    kind: SourceKind.RANDOM_ACCESS,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('outcar') || lower.includes('.vasp.out'),
    sniff: sniffOUTCAR,
  },
  {
    id: 'xyz',
    label: '(ext)XYZ',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.xyz') || lower.endsWith('.exyz'),
    sniff: sniffXYZ,
  },
  {
    id: 'res',
    label: 'SHELX/AIRSS res',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.res'),
    sniff: sniffRes,
  },
  {
    id: 'castep-cell',
    label: 'CASTEP cell',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.cell'),
    sniff: sniffCastepCell,
  },
  {
    id: 'castep-geom',
    label: 'CASTEP trajectory',
    // .geom (geometry opt), .md (molecular dynamics) and .ts (transition-state
    // search) share one tagged block format and one reader.
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.geom') || lower.endsWith('.md') || lower.endsWith('.ts'),
    sniff: sniffCastepGeom,
  },
  {
    id: 'aims-out',
    label: 'FHI-aims output',
    // Before the geometry input: an aims.out echoes geometry.in lines, so both
    // sniffers accept it and table order has to pick the output reader.
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('aims.out') || lower.endsWith('.aims'),
    sniff: sniffAimsOut,
  },
  {
    id: 'aims-geometry',
    label: 'FHI-aims geometry',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('geometry.in'),
    sniff: sniffAimsGeometry,
  },
];

/** The fallback when nothing matches: a POSCAR has no distinguishing marks. */
export const POSCAR_FORMAT = Object.freeze({
  id: 'poscar',
  label: 'POSCAR',
  kind: SourceKind.TEXT,
  handledBy: HandledBy.PARSE_ANY,
  matchesName: () => true,
  sniff: null,
});

// ---------------------------------------------------------------------------
// Heads
// ---------------------------------------------------------------------------

/** @type {TextDecoder | null} */
let sharedDecoder = null;

function decodeLossy(bytes) {
  if (!sharedDecoder) sharedDecoder = new TextDecoder('utf-8', { fatal: false });
  return sharedDecoder.decode(bytes);
}

/**
 * The first `HEAD_BYTES` of in-memory content, in the shape `detectFormat`
 * wants. The synchronous counterpart of `FileSource.readHead()` for callers
 * that already hold the whole file (`parse_any`, addons).
 *
 * @param {string | ArrayBuffer | Uint8Array | null | undefined} content
 * @returns {{bytes: Uint8Array | null, text: string} | null}
 */
export function headOf(content) {
  if (typeof content === 'string') return { bytes: null, text: content.slice(0, HEAD_BYTES) };
  if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
    const all = content instanceof Uint8Array ? content : new Uint8Array(content);
    const bytes = all.subarray(0, Math.min(HEAD_BYTES, all.byteLength));
    return { bytes, text: decodeLossy(bytes) };
  }
  return null;
}

/**
 * Normalise whatever a caller passed as `head` into a `Head`: a string, a
 * `{bytes, text}` from `FileSource.readHead()` / `headOf()`, or nothing.
 * Splits into lines once so every sniffer can index them for free.
 *
 * @param {string | {bytes?: Uint8Array | null, text?: string} | null | undefined} head
 * @returns {Head | null}
 */
export function prepareHead(head) {
  if (head === null || head === undefined) return null;
  if (typeof head === 'string') head = { bytes: null, text: head };
  const bytes = head.bytes instanceof Uint8Array ? head.bytes : null;
  let text = typeof head.text === 'string' ? head.text : (bytes ? decodeLossy(bytes) : '');
  if (text.length > HEAD_BYTES) text = text.slice(0, HEAD_BYTES);
  if (!text && !bytes) return null;
  return { bytes, text, lines: text.split(/\r?\n/) };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Identify a file's format from its contents, with the filename as the
 * tiebreak and the fallback. See the rules at the top of this file.
 *
 * @param {{fileName?: string,
 *          head?: string | {bytes?: Uint8Array | null, text?: string} | null}} params
 * @returns {typeof FORMATS[number]}
 */
export function detectFormat({ fileName = '', head = null } = {}) {
  const lower = String(fileName || '').toLowerCase();

  const prepared = prepareHead(head);
  if (prepared) {
    const candidates = FORMATS.filter((f) => f.sniff && f.sniff(prepared));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      return candidates.find((f) => f.matchesName(lower)) || candidates[0];
    }
  }

  for (const format of FORMATS) {
    if (format.matchesName(lower)) return format;
  }
  return POSCAR_FORMAT;
}

/**
 * Does this content look like the format `id`, going by content alone?
 * Backs the `isLikely*Content` helpers that `io/load_structure.js` still
 * exports.
 *
 * @param {string} id
 * @param {string | ArrayBuffer | Uint8Array | null | undefined} content
 * @returns {boolean}
 */
export function looksLike(id, content) {
  const format = formatById(id);
  if (!format || !format.sniff) return false;
  const prepared = prepareHead(headOf(content));
  return prepared ? format.sniff(prepared) : false;
}

/** @param {string} id @returns {typeof FORMATS[number] | null} */
export function formatById(id) {
  if (id === POSCAR_FORMAT.id) return POSCAR_FORMAT;
  return FORMATS.find((f) => f.id === id) || null;
}

/**
 * Materialise a FileSource in whatever shape the format's reader expects.
 *
 * This is the one place that decides whether a file gets read in full. A
 * random-access format gets the source itself and reads what it needs; every
 * other format gets exactly what it got before this seam existed.
 *
 * @param {import('./FileSource.js').FileSource} source
 * @param {{kind: string}} format
 * @returns {Promise<string | ArrayBuffer | import('./FileSource.js').FileSource>}
 */
export async function materialize(source, format) {
  switch (format.kind) {
    case SourceKind.RANDOM_ACCESS:
      return source;
    case SourceKind.BINARY:
      return source.readAllBytes();
    case SourceKind.TEXT:
    default:
      return source.readAllText();
  }
}
