/**
 * The one table of file formats CrysViz recognises.
 *
 * This replaces the `treatAsCube` / `treatAsCHGCAR` / `treatAsELFCAR` /
 * `treatAsCrysviz` chain that used to live in `core/crystal-viewer.js` and the
 * parallel chain in `io/load_structure.js`. Those two lists had drifted apart —
 * `loadStructure` knew about field files and `parse_any` knew about structure
 * files, and adding a format meant editing whichever one you happened to think
 * of first.
 *
 * ---------------------------------------------------------------------------
 * PLANNED DIRECTION: detect by CONTENT, not by filename
 * ---------------------------------------------------------------------------
 * Every descriptor below declares a `sniff(head)` hook alongside `matchesName`,
 * and `detectFormat` already receives a `head` (the first few KB, from
 * `FileSource.readHead()`) for every file regardless of source kind.
 *
 * `sniff` is deliberately NOT consulted yet — detection is still purely by
 * filename, exactly as before. The hook exists so that switching over is a
 * change to `detectFormat` alone rather than a rewrite of the call sites:
 *
 *   1. give `sniff` precedence over `matchesName` in `detectFormat`
 *   2. move the existing sniffers out of `io/load_structure.js`
 *      (`isLikelyCIFContent`, `isLikelymagCIFContent`, `isLikelyOUTCARContent`)
 *      onto the CIF / mCIF / OUTCAR descriptors — they are already written and
 *      already work, they are simply only reachable for those three formats
 *      today
 *   3. keep `matchesName` as the tiebreak for formats with no distinguishing
 *      content (POSCAR in particular, which is the fallback precisely because
 *      it has no header)
 *
 * `io/ReadWavecarModule.js` already exports a working `isLikelyWAVECARContent`
 * on the same basis, so the WAVECAR descriptor is ready for step 1 whenever it
 * happens.
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
 *   sniff         (head: {bytes, text}) => boolean   RESERVED, see above
 *   handledBy     'viewer'    - core/crystal-viewer.js dispatches it directly
 *                               (field files and .crysviz sessions, which need
 *                               UI wiring rather than a pure parse)
 *                 'parse_any' - io/load_structure.js returns a StructureContainer
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

/**
 * Ordered list — the first descriptor whose `matchesName` returns true wins, so
 * more specific patterns must come before more general ones. POSCAR is not in
 * this table at all; it is the fallback in `detectFormat`, because a POSCAR has
 * neither a distinguishing extension nor a distinguishing header.
 *
 * @type {Array<{id: string, label: string, kind: string, handledBy: string,
 *               matchesName: (lower: string) => boolean,
 *               sniff: ((head: {bytes: Uint8Array, text: string}) => boolean) | null}>}
 */
export const FORMATS = [
  {
    id: 'crysviz',
    label: 'CrysViz session',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.endsWith('.crysviz'),
    sniff: null,
  },
  {
    id: 'wavecar',
    label: 'VASP WAVECAR',
    // The whole point: opened by byte range, never read in full.
    kind: SourceKind.RANDOM_ACCESS,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.includes('wavecar'),
    // Wired up but not consulted; see the note at the top of this file.
    sniff: null,
  },
  {
    id: 'cube',
    label: 'Gaussian cube',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.includes('.cube'),
    sniff: null,
  },
  {
    id: 'chgcar',
    label: 'VASP CHGCAR',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.includes('chgcar'),
    sniff: null,
  },
  {
    id: 'elfcar',
    label: 'VASP ELFCAR',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.VIEWER,
    matchesName: (lower) => lower.includes('elfcar'),
    sniff: null,
  },
  {
    id: 'traj',
    label: 'ASE trajectory',
    // Binary ULM; the parser needs the raw float64 data, so this must not go
    // through a text decode.
    kind: SourceKind.BINARY,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.traj'),
    sniff: null,
  },
  {
    id: 'mcif',
    label: 'magnetic CIF',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('.mcif') || /(^|\W)mcif(\W|$)/.test(lower),
    sniff: null,
  },
  {
    id: 'cif',
    label: 'CIF',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('.cif') || /(^|\W)cif(\W|$)/.test(lower),
    sniff: null,
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
    sniff: null,
  },
  {
    id: 'pwscf-in',
    label: 'Quantum ESPRESSO input',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.scf.in') || lower.endsWith('.vcrx.in'),
    sniff: null,
  },
  {
    id: 'outcar',
    label: 'VASP OUTCAR',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('outcar') || lower.includes('.vasp.out'),
    sniff: null,
  },
  {
    id: 'xyz',
    label: '(ext)XYZ',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.xyz') || lower.endsWith('.exyz'),
    sniff: null,
  },
  {
    id: 'res',
    label: 'SHELX/AIRSS res',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.res'),
    sniff: null,
  },
  {
    id: 'castep-cell',
    label: 'CASTEP cell',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.cell'),
    sniff: null,
  },
  {
    id: 'castep-geom',
    label: 'CASTEP trajectory',
    // .geom (geometry opt), .md (molecular dynamics) and .ts (transition-state
    // search) share one tagged block format and one reader.
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.endsWith('.geom') || lower.endsWith('.md') || lower.endsWith('.ts'),
    sniff: null,
  },
  {
    id: 'aims-out',
    label: 'FHI-aims output',
    // Checked before the geometry input so an "aims.out" name never falls into
    // the geometry.in matcher.
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('aims.out') || lower.endsWith('.aims'),
    sniff: null,
  },
  {
    id: 'aims-geometry',
    label: 'FHI-aims geometry',
    kind: SourceKind.TEXT,
    handledBy: HandledBy.PARSE_ANY,
    matchesName: (lower) => lower.includes('geometry.in'),
    sniff: null,
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

/**
 * Identify a file's format.
 *
 * `head` is accepted and currently unused. It is part of the signature so that
 * enabling content-based detection later does not require touching any caller —
 * see the note at the top of this file.
 *
 * Note that `.mcif` is checked before `.cif` and both are checked before the
 * text sniffers that `io/load_structure.js` still applies. Those sniffers remain
 * where they are for now because a CIF is regularly uploaded under a name that
 * says nothing about its format, and dropping them would be a regression; they
 * are consulted by `parse_any` after this function returns the POSCAR fallback.
 *
 * @param {{fileName?: string, head?: {bytes: Uint8Array, text: string} | null}} params
 * @returns {typeof FORMATS[number]}
 */
export function detectFormat({ fileName = '', head = null } = {}) {
  void head; // reserved for content sniffing; see the header comment

  const lower = String(fileName || '').toLowerCase();
  for (const format of FORMATS) {
    if (format.matchesName(lower)) return format;
  }
  return POSCAR_FORMAT;
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
