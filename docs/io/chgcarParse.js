/**
 * VASP CHGCAR / ELFCAR parsing, worker-safe half.
 *
 * A CHGCAR is a POSCAR header, a blank line, then one or more grid blocks
 * (`NGX NGY NGZ` followed by NGX·NGY·NGZ numbers), with augmentation
 * occupancies and a per-ion line between blocks. Turning that text into
 * numbers is the slow part of a load — seconds for a large grid — so it runs on
 * the shared worker pool (`workers/computeWorker.js`, task 'chgcarParse'),
 * which keeps the view responsive and lets the load-progress strip move.
 *
 * Nothing here touches the DOM or the model classes: the worker hands back the
 * header text and plain {nx, ny, nz, values, stats} blocks (their buffers
 * transferred), and io/ReadChgcarModule.js builds the Structure and the
 * labelled Fields from them on the main thread.
 *
 * The file is streamed from its Blob in bounded chunks and fed line by line
 * through one state machine, so neither the whole text nor an array of all its
 * lines is ever held at once. `parseChgcarText` drives the same machine from a
 * string, for callers that already have the text.
 */

import { computeFieldStats } from '../model/CompositeField.js';
import { latticeVolume } from '../math/backend-js.js';

const CHUNK_BYTES = 8 * 1024 * 1024;

/** Exactly three non-negative integers: a block's `NGX NGY NGZ` line. */
function isGridLine(tokens) {
  return tokens.length === 3 && tokens.every((t) => /^\d+$/.test(t));
}

/** How many numbers a trimmed line holds (a blank line holds none). */
function countTokens(trimmed) {
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Volume of the cell a POSCAR header describes, read the way readPOSCAR reads
 * it: line 2 is the scale factor (negative: the target volume), lines 3-5 the
 * lattice vectors. NaN when the header is not readable; readPOSCAR then
 * rejects it on the main thread with a proper message.
 */
function headerCellVolume(header) {
  const lines = header.trim().split('\n').filter((l) => l.trim());
  const scaleOrVolume = parseFloat(lines[1]);
  if (!Number.isFinite(scaleOrVolume)) return NaN;
  if (scaleOrVolume < 0) return -scaleOrVolume;
  const lattice = [2, 3, 4].map((k) => (lines[k] || '').trim().split(/\s+/).slice(0, 3).map(parseFloat));
  return latticeVolume(lattice) * scaleOrVolume ** 3;
}

/**
 * The factor that turns a file's raw numbers into the quantity we want to show.
 *
 * VASP writes a CHGCAR as the charge density multiplied by the cell volume, so
 * the numbers in the file are electrons, not a density, and their magnitude
 * scales with the cell: the same physical density in a doubled cell prints
 * doubled numbers. Dividing by the volume gives e/Å³, which means the same
 * thing in every file. (Equivalently, in grid terms: a value divided by the
 * NGX·NGY·NGZ grid points is the charge in one voxel, and dividing that by the
 * voxel volume V/N is the same division by V.)
 *
 * The check that fixes the convention: summing a CHGCAR's values and dividing
 * by the number of grid points returns the electron count exactly, which only
 * holds if each value is ρ·V.
 *
 * ELF is dimensionless and bounded by 1 — it is not multiplied by anything and
 * must be left alone.
 *
 * @param {string} source
 * @param {string} header the POSCAR header text
 * @returns {number}
 */
function densityScale(source, header) {
  if (source === 'ELFCAR') return 1;
  const volume = headerCellVolume(header);
  // A degenerate cell would turn every value into Infinity or NaN; showing the
  // file's raw numbers is the better failure.
  return Number.isFinite(volume) && volume > 0 ? 1 / volume : 1;
}

/**
 * @typedef {object} ChgcarBlock
 * @property {number} nx @property {number} ny @property {number} nz
 * @property {Float32Array} values already scaled (see densityScale)
 * @property {number} minValue @property {number} maxValue
 * @property {number} absMinValue @property {number} absMaxValue
 */

/**
 * A line-fed CHGCAR parser.
 *
 * The states follow the file: the header up to the first blank line, then
 * between blocks ('seek') either a grid line, which starts a block ('data'), or
 * an `augmentation occupancies <ion> <count>` line, whose <count> numbers are
 * skipped ('aug'). After a run of augmentation sections, VASP writes one number
 * per ion (the largest <ion> seen) before the next grid line; those are skipped
 * too ('post'), and the line after them is only checked for a grid line
 * ('postCheck').
 *
 * @param {string} source 'CHGCAR', 'ELFCAR', … (decides the density scaling)
 */
function createChgcarParser(source) {
  const headerLines = [];
  let inHeader = true;
  let scale = 1;
  /** @type {ChgcarBlock[]} */
  const blocks = [];

  let mode = 'seek';
  let maxIon = 0;
  let skipLeft = 0;
  let nx = 0, ny = 0, nz = 0, nvalues = 0, fill = 0;
  /** @type {Float32Array | null} */
  let values = null;

  function closeBlock() {
    if (values && values.length > 0) {
      // Scaled in a pass of its own after the block is read (not per number as
      // it is parsed) so the stored float32 values are exactly what the former
      // main-thread parser produced: rounded once on read, once on scaling.
      if (scale !== 1) for (let i = 0; i < values.length; i++) values[i] *= scale;
      blocks.push({ nx, ny, nz, values, ...computeFieldStats(values) });
    }
    values = null;
  }

  /** @param {string[]} tokens a grid line */
  function openBlock(tokens) {
    closeBlock();
    [nx, ny, nz] = tokens.map(Number);
    nvalues = nx * ny * nz;
    values = new Float32Array(nvalues);
    fill = 0;
    mode = nvalues > 0 ? 'data' : 'seek';
  }

  /** @param {string} raw one line, without its newline */
  function line(raw) {
    if (inHeader) {
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      // The first line is the title and never ends the header, even blank.
      if (headerLines.length > 0 && text.trim() === '') {
        inHeader = false;
        scale = densityScale(source, headerLines.join('\n'));
      } else {
        headerLines.push(text);
      }
      return;
    }

    const t = raw.trim();
    switch (mode) {
      case 'data': {
        if (t !== '') {
          const parts = t.split(/\s+/);
          for (let j = 0; j < parts.length && fill < nvalues; j++) {
            const n = Number(parts[j]);
            if (!isNaN(n)) values[fill++] = n;
          }
        }
        if (fill >= nvalues) mode = 'seek';
        return;
      }
      case 'aug':
        skipLeft -= countTokens(t);
        if (skipLeft <= 0) mode = 'seek';
        return;
      case 'post':
        skipLeft -= countTokens(t);
        if (skipLeft <= 0) mode = 'postCheck';
        return;
      case 'postCheck': {
        mode = 'seek';
        const tokens = t.split(/\s+/);
        if (isGridLine(tokens)) openBlock(tokens);
        return;
      }
      default: { // 'seek'
        if (t.startsWith('augmentation')) {
          const tokens = t.split(/\s+/);
          skipLeft = parseInt(tokens[3], 10) || 0;
          maxIon = Math.max(maxIon, parseInt(tokens[2], 10) || 0);
          if (skipLeft > 0) mode = 'aug';
          return;
        }
        if (maxIon > 0) {
          // The augmentation run is over: this line starts the per-ion numbers.
          skipLeft = maxIon;
          maxIon = 0;
          mode = 'post';
          line(raw);
          return;
        }
        const tokens = t.split(/\s+/);
        if (isGridLine(tokens)) openBlock(tokens);
      }
    }
  }

  /** @returns {{header: string, blocks: ChgcarBlock[]}} */
  function finish() {
    closeBlock();
    // No blank line anywhere: there is no header to speak of, and readPOSCAR
    // rejects the empty one.
    return { header: inHeader ? '' : headerLines.join('\n'), blocks };
  }

  return { line, finish };
}

/**
 * Parse CHGCAR text that is already in memory.
 * @param {string} text
 * @param {string} [source]
 * @returns {{header: string, blocks: ChgcarBlock[]}}
 */
export function parseChgcarText(text, source = 'CHGCAR') {
  const parser = createChgcarParser(source);
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    parser.line(text.slice(start, end));
    start = end + 1;
  }
  return parser.finish();
}

/**
 * Stream-parse a CHGCAR from a Blob in bounded chunks.
 * @param {Blob} blob
 * @param {string} [source]
 * @param {(progress: number) => void} [onProgress] 0-100, by bytes read
 * @returns {Promise<{header: string, blocks: ChgcarBlock[]}>}
 */
export async function parseChgcarBlob(blob, source = 'CHGCAR', onProgress) {
  const parser = createChgcarParser(source);
  const total = blob.size;
  const decoder = new TextDecoder();
  let offset = 0;
  let carry = '';
  while (offset < total) {
    const buf = await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
    if (buf.byteLength === 0) break;
    offset += buf.byteLength;
    const last = offset >= total;
    const text = carry + decoder.decode(buf, { stream: !last });
    const parts = text.split('\n');
    // The last piece may continue in the next chunk; at the end of the file it
    // is the final (newline-less) line and is parsed with the rest.
    carry = last ? '' : parts.pop();
    for (const part of parts) parser.line(part);
    if (onProgress) onProgress((offset / total) * 100);
  }
  if (carry) parser.line(carry);
  return parser.finish();
}
