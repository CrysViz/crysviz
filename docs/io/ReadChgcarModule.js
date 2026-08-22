import { Field } from '../model/index.js'; // Adjust path as needed
import { FieldContainer } from '../model/index.js'; // Adjust path as needed
import { combineFields, computeFieldStats } from '../model/index.js';
import { readPOSCAR } from './ReadPOSCARModule.js';



/**
 * One parsed spin component as a Field.
 *
 * The two call sites below (a new grid header, and end-of-file) used to hold
 * byte-identical copies of this, each running four separate `reduce` passes over
 * the values — eight full walks of a multi-million-entry array per file.
 * `computeFieldStats` does it in one.
 *
 * @param {Float32Array} values
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {number} index position in the file: 0 is the charge density, 1+ spin
 * @returns {Field}
 */
function makeComponentField(values, nx, ny, nz, index) {
  return new Field({
    nx,
    ny,
    nz,
    origin: [0, 0, 0],
    voxel: null, // will set later
    values: new Float32Array(values),
    component: index, // 0 for charge density, 1+ for spin components
    label: index === 0 ? 'Charge Density' : 'Spin Density',
    ...computeFieldStats(values),
  });
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
        fields.push(makeComponentField(currentValues, nx, ny, nz, fields.length));
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
    fields.push(makeComponentField(currentValues, nx, ny, nz, fields.length));
  }

  // A spin-polarised CHGCAR stores (rho, s); the separately-visualisable spin
  // channels are the two halves of that sum. This is exactly the weighted
  // combination the derived-field UI offers, so it goes through the same helper
  // rather than open-coding the arithmetic and eight more reduce passes.
  if (fields.length == 2 && fields[0].label === 'Charge Density' && fields[1].label === 'Spin Density') {
    const [chargeField, spinField] = fields;
    fields.push(combineFields(
      [{ field: chargeField, weight: 0.5 }, { field: spinField, weight: 0.5 }],
      { label: 'Spin Up Density', component: fields.length }));
    fields.push(combineFields(
      [{ field: chargeField, weight: 0.5 }, { field: spinField, weight: -0.5 }],
      { label: 'Spin Down Density', component: fields.length }));
  }

  // Create volumetric field container with metadata
  const fieldContainer = new FieldContainer({
    fileName,
    source: source,
    fieldCount: fields.length,
    fields: fields
  });

  // Parse structure with volumetric fields included
  const structure_with_field = readPOSCAR(textBeforeEmpty, fileName);
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
