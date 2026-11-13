import { Field, FieldContainer, combineFields, magnitudeField } from '../model/index.js';
import { readPOSCAR } from './ReadPOSCARModule.js';
import { FileSource } from './FileSource.js';
import { parseChgcarBlob, parseChgcarText } from './chgcarParse.js';
import * as workerPool from '../workers/workerPool.js';

/*
 * CHGCAR / ELFCAR loading, main-thread half. Reading the grid numbers out of
 * the text lives in io/chgcarParse.js and runs on the shared worker pool (task
 * 'chgcarParse'); this module turns the parsed header and blocks into the
 * Structure and its labelled, derived Fields.
 */

/**
 * Name the parsed blocks for the format they came from.
 *
 * This parser serves both CHGCAR and ELFCAR because the file layout is the
 * same, but the quantities are not: a CHGCAR's blocks are a charge density
 * followed by its magnetization, while an ELFCAR's two blocks are the
 * localization function of each spin channel. Naming from the block index
 * alone (as this did) labelled every ELF grid "Charge Density".
 *
 * @param {Field[]} fields blocks in file order
 * @param {string} source the format the reader was handed ('CHGCAR', 'ELFCAR', …)
 */
function labelFields(fields, source) {
  if (source === 'ELFCAR') {
    // A non-spin-polarised run writes one ELF grid; ISPIN = 2 writes one per
    // spin channel, up first.
    if (fields.length === 1) {
      fields[0].label = 'ELF';
      return;
    }
    const spinLabels = ['ELF-up', 'ELF-down'];
    fields.forEach((field, i) => {
      field.label = spinLabels[i] || `ELF block ${i + 1}`;
    });
    return;
  }

  // CHGCAR, and anything else routed through this parser.
  fields.forEach((field, i) => {
    if (i === 0) {
      field.label = 'Charge Density';
    } else if (fields.length === 4) {
      // A noncollinear run writes three magnetization components after the
      // density, one per Pauli matrix in the spin-quantization frame; calling
      // all three "Magnetization Density" made them indistinguishable. The
      // subscripts are Unicode rather than markup because these labels are
      // rendered as plain text (the catalog list, the cut-plane dropdown).
      field.label = `Magnetization along σ${['₁', '₂', '₃'][i - 1]}`;
    } else {
      field.label = fields.length > 2 ? `Magnetization Density ${i}` : 'Magnetization Density';
    }
  });
}

/**
 * The fields a file gets derived for it on load.
 *
 * The rule is that a derivation is offered only when the result is a quantity
 * in its own right. A spin-polarised CHGCAR qualifies twice over; an ELFCAR
 * qualifies not at all, because no sum or difference of two localization
 * functions is itself a localization function, and anyone who wants one can
 * build it in the panel's "Combine fields" section.
 *
 * @param {Field[]} fields blocks in file order, already labelled
 * @param {string} source
 * @returns {Field[]} the derived fields, in the order they should be listed
 */
function deriveCombinations(fields, source) {
  if (source === 'ELFCAR') return [];

  /** @param {number} offset position among the derived fields */
  const at = (offset) => fields.length + offset;

  if (fields.length === 2) {
    // A spin-polarised CHGCAR stores (rho, s); the separately-visualisable spin
    // channels are the two halves of that sum, which is exactly what the panel's
    // "Combine fields" section builds by hand — so it goes through the same
    // helper rather than open-coding the arithmetic.
    const [first, second] = fields;
    return [
      combineFields([{ field: first, weight: 0.5 }, { field: second, weight: 0.5 }],
        { label: 'Spin Up Density', component: at(0) }),
      combineFields([{ field: first, weight: 0.5 }, { field: second, weight: -0.5 }],
        { label: 'Spin Down Density', component: at(1) }),
    ];
  }

  if (fields.length === 4) {
    // A noncollinear CHGCAR stores (rho, m₁, m₂, m₃). There is no global spin
    // axis to split the density along, so the collinear up/down pair has no
    // counterpart here — but |m| does, and it is the field that answers "where
    // is this cell magnetic at all", which none of the three components does on
    // its own (a moment lying in the σ₁σ₂ plane is invisible in σ₃).
    //
    // It is derived rather than left to the user because "Combine fields" sums
    // weighted terms and no weighting of m₁, m₂ and m₃ is their magnitude —
    // this is the one quantity of the file that cannot be built by hand.
    return [
      magnitudeField(fields.slice(1),
        { label: 'Magnetization Magnitude', component: at(0) }),
    ];
  }

  return [];
}

/**
 * Build the structure and its field container from a parsed file.
 * @param {{header: string, blocks: import('./chgcarParse.js').ChgcarBlock[]}} parsed
 * @param {string} fileName
 * @param {string} source
 */
function buildChgcar({ header, blocks }, fileName, source) {
  const structure_with_field = readPOSCAR(header, fileName);

  // Blocks are left unlabelled until all of them are known: what a block *is*
  // depends on the format and on how many blocks turned up.
  const fields = blocks.map((block, index) => new Field({
    nx: block.nx,
    ny: block.ny,
    nz: block.nz,
    origin: [0, 0, 0],
    voxel: null, // set below from the lattice
    values: block.values,
    component: index,
    label: `Block ${index + 1}`, // replaced by labelFields()
    minValue: block.minValue,
    maxValue: block.maxValue,
    absMinValue: block.absMinValue,
    absMaxValue: block.absMaxValue,
  }));

  // The derived combinations are named after the fields they are built from,
  // so naming comes first.
  labelFields(fields, source);
  fields.push(...deriveCombinations(fields, source));

  const fieldContainer = new FieldContainer({
    fileName,
    source,
    fieldCount: fields.length,
    fields,
  });

  structure_with_field.volumetricFields = fieldContainer;

  // Voxel vectors of each component from the structure's lattice.
  const lattice = structure_with_field.lattice;
  fieldContainer.fields.forEach((field) => {
    field.voxel = [
      [lattice[0][0] / field.nx, lattice[0][1] / field.nx, lattice[0][2] / field.nx],
      [lattice[1][0] / field.ny, lattice[1][1] / field.ny, lattice[1][2] / field.ny],
      [lattice[2][0] / field.nz, lattice[2][1] / field.nz, lattice[2][2] / field.nz],
    ];
  });

  return { fileName, structure_with_field };
}

/**
 * Parse CHGCAR text synchronously, on the calling thread.
 * @param {string} text
 * @param {string} fileName
 * @param {string} [source] 'CHGCAR', 'ELFCAR', …
 */
export function readCHGCAR(text, fileName, source = 'CHGCAR') {
  return buildChgcar(parseChgcarText(text, source), fileName, source);
}

/**
 * Parse on the pool when possible, on the main thread when not — the same
 * dispatch shape as io/ReadOutcarModule.js: a pool that cannot start (module
 * worker unsupported, blocked by a CSP) must not take CHGCAR loading down with
 * it. The Blob goes to the worker by reference, so the file is read there and
 * never materialised as a string on the main thread.
 * @param {Blob} blob
 * @param {string} source
 * @param {(progress: number) => void} [onProgress]
 */
async function runParse(blob, source, onProgress) {
  if (workerPool.available()) {
    try {
      return await workerPool.run('chgcarParse', { blob, source }, undefined, onProgress);
    } catch (error) {
      console.warn('CHGCAR parse failed in a pool worker; falling back to the '
        + 'main thread. The UI will block while it runs.', error);
    }
  }
  return parseChgcarBlob(blob, source, onProgress);
}

/**
 * Parse a CHGCAR off the main thread.
 *
 * @param {FileSource | Blob | string} content normally the FileSource that
 *   io/formats.js passes through (CHGCAR is a random-access format)
 * @param {string} fileName
 * @param {string} [source] 'CHGCAR', 'ELFCAR', …
 * @param {(progress: number) => void} [onProgress] 0-100 while the file is read
 */
export async function readCHGCARAsync(content, fileName, source = 'CHGCAR', onProgress) {
  let blob;
  if (content instanceof FileSource) blob = content.asBlob();
  else if (content instanceof Blob) blob = content;
  else blob = new Blob([String(content ?? '')]);
  const parsed = await runParse(blob, source, onProgress);
  return buildChgcar(parsed, fileName, source);
}
