import { Field } from '../model/index.js'; // Adjust path as needed
import { FieldContainer } from '../model/index.js'; // Adjust path as needed
import { combineFields, magnitudeField, computeFieldStats } from '../model/index.js';
import { readPOSCAR } from './ReadPOSCARModule.js';
import { latticeVolume } from '../math/index.js';



/**
 * One parsed data block as a Field.
 *
 * The two call sites below (a new grid header, and end-of-file) used to hold
 * byte-identical copies of this, each running four separate `reduce` passes over
 * the values — eight full walks of a multi-million-entry array per file.
 * `computeFieldStats` does it in one.
 *
 * Blocks are left unlabelled here and named by `labelFields` once the file has
 * been read: what a block *is* depends on the format and on how many blocks
 * turned up, neither of which is known while one is being parsed.
 *
 * @param {Float32Array} values
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {number} index position in the file
 * @param {number} [scale] factor applied while copying, for the density
 *   normalisation below; 1 leaves the file's numbers as they are
 * @returns {Field}
 */
function makeComponentField(values, nx, ny, nz, index, scale = 1) {
  // Scaling here rather than in a pass of its own: the copy into the field's
  // own buffer has to happen anyway, and computeFieldStats then sees the values
  // the panel will actually show.
  const scaled = new Float32Array(values.length);
  if (scale === 1) {
    scaled.set(values);
  } else {
    for (let i = 0; i < values.length; i++) scaled[i] = values[i] * scale;
  }

  return new Field({
    nx,
    ny,
    nz,
    origin: [0, 0, 0],
    voxel: null, // will set later
    values: scaled,
    component: index,
    label: `Block ${index + 1}`, // replaced by labelFields()
    ...computeFieldStats(scaled),
  });
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
 * @param {number[][]} lattice
 * @returns {number}
 */
function densityScale(source, lattice) {
  if (source === 'ELFCAR') return 1;
  const volume = latticeVolume(lattice);
  // A degenerate cell would turn every value into Infinity or NaN; showing the
  // file's raw numbers is the better failure.
  return Number.isFinite(volume) && volume > 0 ? 1 / volume : 1;
}

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

//------------------------------------------------------------
//  readCHGCAR(url) → { lattice, positions_cart, field }
//  Parser for VASP CHGCAR files (supports multiple spin components)
//------------------------------------------------------------
export function readCHGCAR(text, fileName, source = 'CHGCAR') {
  // Find first empty line and split, separates structure from charge density data
  const firstEmptyIndex = text.search(/\n\s*\n/);
  const textAfterEmpty = firstEmptyIndex !== -1 ? text.substring(firstEmptyIndex + 2) : text;
  const textBeforeEmpty = firstEmptyIndex !== -1 ? text.substring(0, firstEmptyIndex) : '';

  const lines = textAfterEmpty.trim().split(/\n/);

  // The structure half is parsed first because the density normalisation needs
  // the cell volume, and blocks are scaled as they are copied into their field.
  const structure_with_field = readPOSCAR(textBeforeEmpty, fileName);
  const scale = densityScale(source, structure_with_field.lattice);

  // Grid dimensions line (nx ny nz)
  let nx, ny, nz;
  let nvalues;

  // Read volumetric data (can be multiple blocks for spin-polarized)
  const fields = [];
  let fill_ind = 0;
  let currentValues = null;
  let i = 0;

  let line;
  while (i < lines.length) {
    // Check for augmentation charges section (skip it)
    let max_arg = 0;
    line = lines[i].trim();
    while (line.startsWith('augmentation')) {
      // Parse the augmentation line to get the count of numbers to skip
      const augTokens = line.split(/\s+/);
      const numToSkip = parseInt(augTokens[3], 10) || 0;
      max_arg = Math.max(max_arg, parseInt(augTokens[2], 10) || 0);
      
      // Skip the required number of values
      let skipped = 0;
      i++;
      while (i < lines.length && skipped < numToSkip) {
        const augLine = lines[i].trim();
        if (augLine === '') {
          i++;
          continue;
        }
        const augNums = augLine.split(/\s+/).filter(s => s.length > 0);
        skipped += augNums.length;
        i++;
      }
      if (i >= lines.length) break;
      line = lines[i].trim();
    }
    // skip any remaining augmentation lines if we had a max_arg
    const numToSkip = max_arg;
    let skipped = 0;
    while (i < lines.length && skipped < numToSkip) {
      const augLine = lines[i].trim();
      if (augLine === '') {
        i++;
        continue;
      }
      const augNums = augLine.split(/\s+/).filter(s => s.length > 0);
      skipped += augNums.length;
      i++;
    }

    if (i >= lines.length) break;
    

    // Check for new grid line (indicates another spin component)
    line = lines[i].trim();
    const tokens = line.split(/\s+/);
    if (tokens.length === 3 && tokens.every(t => /^\d+$/.test(t))) {
      // Save current field if we have data
      if (currentValues && currentValues.length > 0) {
        fields.push(makeComponentField(currentValues, nx, ny, nz, fields.length, scale));
      }
      fill_ind = 0;
      [nx, ny, nz] = tokens.map(Number);
      nvalues = nx * ny * nz;
      currentValues = new Float32Array(nvalues);
      i++;
      // Parse volumetric data, already in order of z,y,x (slowest to fastest)
      while (i < lines.length && fill_ind < nvalues) {
        line = lines[i].trim();
        const nums = line.split(/\s+/).filter(s => s.length > 0).map(Number);
        for (let j = 0; j < nums.length; j++) {
          if (!isNaN(nums[j]) && fill_ind < nvalues) currentValues[fill_ind++] = nums[j];
        }
        i++;
      }
      continue;
    }

    i++;
  }

  // Push final field
  if (currentValues && currentValues.length > 0) {
    fields.push(makeComponentField(currentValues, nx, ny, nz, fields.length, scale));
  }

  // Naming is deferred to here because it depends on the format and on how many
  // blocks the file actually held — and the derived combinations below are named
  // after the fields they are built from, so they must come second.
  labelFields(fields, source);
  fields.push(...deriveCombinations(fields, source));

  // Create volumetric field container with metadata
  const fieldContainer = new FieldContainer({
    fileName,
    source: source,
    fieldCount: fields.length,
    fields: fields
  });

  structure_with_field.volumetricFields = fieldContainer;

  // Update voxel field for each component based on structure lattice
  fieldContainer.fields.forEach(field => {
    field.voxel = [
      [structure_with_field.lattice[0][0] / field.nx, structure_with_field.lattice[0][1] / field.nx, structure_with_field.lattice[0][2] / field.nx],
      [structure_with_field.lattice[1][0] / field.ny, structure_with_field.lattice[1][1] / field.ny, structure_with_field.lattice[1][2] / field.ny],
      [structure_with_field.lattice[2][0] / field.nz, structure_with_field.lattice[2][1] / field.nz, structure_with_field.lattice[2][2] / field.nz]
    ];
  });

  return {
    fileName,
    structure_with_field
  };
}
