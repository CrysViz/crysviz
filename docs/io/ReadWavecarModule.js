import { WavefunctionSource, RTAG_SINGLE, RTAG_DOUBLE } from '../model/WavefunctionSource.js';
import { Structure } from '../model/Structure.js';
import { FileSource } from './FileSource.js';
import { looksLike } from './formats.js';

/**
 * Reader for VASP WAVECAR files.
 *
 * Unlike every other reader in this directory, this one does not parse a file —
 * it opens one. A WAVECAR holds nspin × nkpts × nbands wavefunctions and is
 * routinely multi-GB, so only the two header records and the per-k-point
 * metadata are read here. Everything else is fetched on demand by
 * `model/WavefunctionSource.js`.
 *
 * Byte layout, transcribed from httk's `iface/vasp_if.py::read_wavecar`. Every
 * header number is a float64, including the ones that are logically integers.
 *
 *   offset 0     : 4 doubles  -> recl, nspin, rtag, (unused)
 *   offset recl  : 12 doubles -> nkpts, nbands, encut, then the 3×3 cell
 *   thereafter   : records of `recl` bytes, laid out as
 *
 *     for spin in 1..nspin:
 *       for kpt in 1..nkpts:
 *         one record: nplw, kx, ky, kz, then nbands × (eigRe, eigIm, occ)
 *         for band in 1..nbands:
 *           one record: the plane-wave coefficients
 *
 * `recl` is read from the file rather than assumed, because it varies between
 * VASP builds and configurations.
 *
 * A non-collinear (LNONCOLLINEAR) run fits this layout unchanged: it declares
 * nspin = 1 and writes 2 × nplw coefficients per band, the up component of the
 * spinor followed by the down component over the same G-vectors. Nothing here
 * has to know that — the doubled count is noticed against the cutoff sphere in
 * `WavefunctionSource.init()`, which is the only place that can tell the
 * difference.
 */

/** Bytes per float64 in the header records. */
const DOUBLE = 8;

/** Read `count` little-endian float64 values starting at `offset`. */
async function readDoubles(fileSource, offset, count) {
  const bytes = await fileSource.readBytes(offset, count * DOUBLE);
  if (bytes.byteLength < count * DOUBLE) {
    throw new Error(
      `WAVECAR is truncated: wanted ${count * DOUBLE} bytes at offset ${offset}, `
      + `got ${bytes.byteLength}.`);
  }
  // DataView because a Blob slice or subarray can start at any byte offset and
  // Float64Array requires 8-byte alignment. VASP writes native little-endian.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getFloat64(i * DOUBLE, true);
  return out;
}

/**
 * Open a WAVECAR and return a lazily-read wavefunction source plus the cell it
 * declares.
 *
 * The returned structure carries the lattice and no atoms — a WAVECAR simply
 * does not contain positions. Deciding what to do about that (attach to the
 * selected structure, or stand alone) is a UI concern and lives in
 * `render/Render3DFieldModule.js`.
 *
 * @param {FileSource | ArrayBuffer | Uint8Array} content
 * @param {string} fileName
 * @param {{cacheBudgetBytes?: number}} [options]
 * @returns {Promise<{fileName: string, source: WavefunctionSource, structure: Structure}>}
 */
export async function readWAVECAR(content, fileName, options = {}) {
  const fileSource = FileSource.from(content);

  // ---- record 0: geometry of the file itself -------------------------------
  const [reclRaw, nspinRaw, rtagRaw] = await readDoubles(fileSource, 0, 4);
  const recl = Math.round(reclRaw);
  const nspin = Math.round(nspinRaw);
  const rtag = Math.round(rtagRaw);

  if (!(recl > 0) || !Number.isFinite(recl)) {
    throw new Error(
      `${fileName}: the record length in the WAVECAR header is ${reclRaw}, which is not a `
      + 'usable value. This does not look like a WAVECAR.');
  }
  if (!(nspin === 1 || nspin === 2)) {
    throw new Error(`${fileName}: WAVECAR reports ${nspinRaw} spin channels; expected 1 or 2.`);
  }

  let doublePrecision;
  if (rtag === RTAG_SINGLE) {
    doublePrecision = false;
  } else if (rtag === RTAG_DOUBLE) {
    doublePrecision = true;
  } else {
    throw new Error(
      `${fileName}: unknown RTAG ${rtag} in the WAVECAR header. Expected ${RTAG_SINGLE} `
      + `(single precision) or ${RTAG_DOUBLE} (double). This is probably an unsupported `
      + 'VASP version.');
  }

  // ---- record 1: what the calculation was ----------------------------------
  const header = await readDoubles(fileSource, recl, 12);
  const nkpts = Math.round(header[0]);
  const nbands = Math.round(header[1]);
  const encut = header[2];

  if (!(nkpts > 0) || !(nbands > 0)) {
    throw new Error(
      `${fileName}: WAVECAR reports ${nkpts} k-points and ${nbands} bands; both must be positive.`);
  }
  if (!(encut > 0)) {
    throw new Error(`${fileName}: WAVECAR reports ENCUT = ${encut} eV, which cannot be used.`);
  }

  // Rows are the lattice vectors: cell[j][i] = header[3 + 3*j + i].
  const lattice = [0, 1, 2].map((j) => [0, 1, 2].map((i) => header[3 + 3 * j + i]));

  /**
   * Byte offset of the first coefficient of one band (all indices 1-based).
   * Two header records, then per spin: per k-point one metadata record followed
   * by `nbands` coefficient records.
   */
  const recordPosition = (spin, kpt, band) =>
    (2 + (spin - 1) * nkpts * (nbands + 1) + (kpt - 1) * (nbands + 1) + band) * recl;

  // ---- per-(spin, k-point) metadata records --------------------------------
  const entriesPerRecord = 4 + 3 * nbands;
  const requiredBytes = recordPosition(nspin, nkpts, nbands) + recl;
  if (fileSource.size > 0 && fileSource.size < requiredBytes) {
    throw new Error(
      `${fileName}: the header describes ${nspin}×${nkpts}×${nbands} wavefunctions, which needs `
      + `${requiredBytes} bytes, but the file is only ${fileSource.size}. It is truncated or `
      + 'the header is not a WAVECAR header.');
  }

  const nplws = new Array(nkpts).fill(0);
  const kpoints = new Array(nkpts).fill(null);
  const eigenvalues = makeCube(nspin, nkpts, nbands);
  const occupations = makeCube(nspin, nkpts, nbands);

  for (let spin = 1; spin <= nspin; spin++) {
    for (let kpt = 1; kpt <= nkpts; kpt++) {
      const offset = recordPosition(spin, kpt, 1) - recl;
      const record = await readDoubles(fileSource, offset, entriesPerRecord);

      if (spin === 1) {
        // The plane-wave count and k-vector are properties of the k-point, so
        // they are identical in the second spin channel's copy of this record.
        nplws[kpt - 1] = Math.round(record[0]);
        kpoints[kpt - 1] = [record[1], record[2], record[3]];
      }
      for (let band = 0; band < nbands; band++) {
        // Triples of (eigenvalue real, eigenvalue imaginary, occupation).
        eigenvalues[spin - 1][kpt - 1][band] = record[4 + band * 3];
        occupations[spin - 1][kpt - 1][band] = record[4 + band * 3 + 2];
      }
    }
  }

  if (!(nplws[0] > 0)) {
    throw new Error(
      `${fileName}: the first k-point reports ${nplws[0]} plane waves. The header is not `
      + 'being read correctly — the file may not be a WAVECAR.');
  }

  const source = new WavefunctionSource({
    fileSource,
    fileName,
    nspin,
    nkpts,
    nbands,
    encut,
    lattice,
    kpoints,
    nplws,
    eigenvalues,
    occupations,
    doublePrecision,
    recordPosition,
    cacheBudgetBytes: options.cacheBudgetBytes,
  });

  // Resolve the FFT geometry and gamma layout now rather than on the first
  // click: a mismatch between the file's plane-wave count and the cutoff sphere
  // means the whole file is unreadable, and that should surface while the user
  // is still thinking about the file they just opened.
  await source.init();

  // A WAVECAR has a cell and no atoms. The caller decides whether that stands
  // on its own or gets attached to an already-loaded structure.
  // No atoms: a lattice-only Structure. Callers identify that by the empty
  // `atoms` array rather than a marker property, so there is one source of truth.
  const structure = new Structure({
    elements: [],
    atoms: [],
    lattice,
  });

  return { fileName, source, structure };
}

/**
 * Sniff for a WAVECAR by its header rather than its name.
 *
 * The rule itself lives on the `wavecar` descriptor in `io/formats.js`, where
 * `detectFormat` consults it for every file; this is the same test exposed
 * under the name callers already import. The tell is the RTAG in the third
 * float64: 45200 or 45210 is a very specific bit pattern to hit by chance, and
 * it sits alongside a plausible record length and spin count.
 *
 * @param {Uint8Array} head first bytes of the file
 * @returns {boolean}
 */
export function isLikelyWAVECARContent(head) {
  return looksLike('wavecar', head);
}

/** [spin][kpt][band] filled with zeros. */
function makeCube(nspin, nkpts, nbands) {
  return Array.from({ length: nspin }, () =>
    Array.from({ length: nkpts }, () => new Array(nbands).fill(0)));
}
