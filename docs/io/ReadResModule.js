/**
 * Parser for SHELX-style .res files (AIRSS / castep output), supporting
 * MANY structures concatenated in one file — the "bulk" case, e.g. an AIRSS
 * search dumping every candidate into a single .res. Each TITL…END block
 * becomes one Structure; the resulting multi-structure StructureContainer is
 * shown by the file browser as a stepped trajectory the user can page through.
 *
 * Recognised lines:
 *   TITL name pressure volume enthalpy spin modspin nAtoms (symmetry) … copies
 *   CELL wavelength a b c α β γ
 *   SFAC El1 El2 …            (maps the numeric SFAC index on each atom line)
 *   <label> SFAC# x y z [occ] (fractional coordinates)
 *   REM / END                 (comments / block terminator)
 *
 * Positions are fractional (wrapped into [0, 1)); the lattice is built from the
 * CELL parameters. The TITL enthalpy is carried onto Structure.energy so the
 * concatenated candidates can be compared in the trajectory/energy plot.
 */

import { generateID } from '../utils/index.js';
import { Structure, StructureContainer, Atom } from '../model/index.js';
import { latticeFromCell, normalizeFractional } from '../math/index.js';
import { runPeriodicWrapped } from '../render/index.js';

/** A fresh, empty accumulator for one TITL…END block. */
function emptyRecord() {
  return { title: null, cell: null, lattice: null, atoms: [], metadata: {}, species: [] };
}

/**
 * Parse .res content into an array of plain structure records (title, lattice,
 * atoms, metadata). Kept pure and export-free so parseResFile owns model
 * construction, mirroring the other readers.
 * @param {string} content
 * @returns {Array<object>}
 */
function parseResContent(content) {
  const lines = content.split(/\r?\n/);
  const results = [];
  let current = emptyRecord();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // A new TITL while atoms are already collected closes the previous block —
    // this is what lets a single file hold many structures back to back.
    if (/^TITL\b/i.test(trimmed) && current.atoms.length > 0) {
      results.push(current);
      current = emptyRecord();
    }

    if (/^TITL\b/i.test(trimmed)) {
      const parts = trimmed.split(/\s+/).slice(1);
      current.title = parts[0] || null;
      current.metadata = {
        name: parts[0],
        pressure: parseFloat(parts[1]),
        volume: parseFloat(parts[2]),
        enthalpy: parseFloat(parts[3]),
        spin: parseInt(parts[4], 10),
        modspin: parseInt(parts[5], 10),
        numIons: parseInt(parts[6], 10),
        symmetry: parts[7]?.replace(/[()]/g, '') || '',
        numCopies: parseInt(parts[9], 10),
      };
      continue;
    }

    // CELL: wavelength a b c α β γ
    if (/^CELL\b/i.test(trimmed)) {
      const values = trimmed.split(/\s+/).slice(1).map(parseFloat);
      if (values.length >= 7) {
        current.cell = {
          a: values[1], b: values[2], c: values[3],
          alpha: values[4], beta: values[5], gamma: values[6],
        };
        current.lattice = latticeFromCell(
          current.cell.a, current.cell.b, current.cell.c,
          current.cell.alpha, current.cell.beta, current.cell.gamma,
        );
      }
      continue;
    }

    // SFAC: the element table the numeric index on each atom line refers to.
    if (/^SFAC\b/i.test(trimmed)) {
      current.species = trimmed.split(/\s+/).slice(1);
      continue;
    }

    if (/^REM\b/i.test(trimmed)) continue;

    if (/^END\b/i.test(trimmed)) {
      if (current.atoms.length > 0) {
        results.push(current);
        current = emptyRecord();
      }
      continue;
    }

    // Atom line: "<label> <SFAC#> x y z [occ] …"
    if (/^[A-Za-z][A-Za-z0-9']*\s+\d+\s/.test(trimmed)) {
      const parts = trimmed.split(/\s+/);
      const label = parts[0];
      const sfacIndex = parseInt(parts[1], 10) - 1; // SHELX SFAC# is 1-indexed
      const x = normalizeFractional(parseFloat(parts[2]));
      const y = normalizeFractional(parseFloat(parts[3]));
      const z = normalizeFractional(parseFloat(parts[4]));
      if (![x, y, z].every(Number.isFinite)) continue;

      // Prefer the SFAC element; fall back to the atom label when SFAC is absent
      // or the index is out of range.
      const element = (sfacIndex >= 0 && sfacIndex < current.species.length)
        ? current.species[sfacIndex]
        : label.replace(/[0-9'].*$/, '');

      const occ = parts.length > 5 ? parseFloat(parts[5]) : 1.0;
      current.atoms.push({
        element,
        position: [x, y, z],
        occupancy: Number.isFinite(occ) ? occ : 1.0,
      });
    }
  }

  if (current.atoms.length > 0) results.push(current);
  return results;
}

/**
 * Parse a .res file (one or many structures) into a StructureContainer.
 * @param {string} content
 * @param {string} fileName
 * @returns {Promise<StructureContainer>}
 */
export function parseResFile(content, fileName) {
  return new Promise((resolve, reject) => {
    if (!content || typeof content !== 'string') {
      reject(new Error('Content must be a non-empty string'));
      return;
    }

    try {
      const parsed = parseResContent(content);
      if (parsed.length === 0) {
        reject(new Error('No valid structures found in .res file'));
        return;
      }

      const structures = parsed.map((record, idx) => {
        const { atoms: rawAtoms, lattice, metadata } = record;
        const elements = rawAtoms.map(a => a.element);
        const positions = rawAtoms.map(a => a.position);

        const atoms = rawAtoms.map((atom, atomIdx) => new Atom({
          element: atom.element,
          position: atom.position, // fractional, wrapped to [0, 1)
          occupancy: atom.occupancy,
          uuid: generateID([atom.element, atomIdx, idx]),
        }));

        const periodic = runPeriodicWrapped(
          { hash: 'None', wrapped: {} }, positions, elements, lattice,
        );

        return new Structure({
          elements,
          uniqueElements: [...new Set(elements)],
          lattice,
          atoms,
          periodic,
          // AIRSS ranks candidates by enthalpy; surfacing it as the frame energy
          // lets the trajectory/energy plot order the bulk set meaningfully.
          energy: Number.isFinite(metadata?.enthalpy) ? metadata.enthalpy : null,
        });
      });

      resolve(new StructureContainer({ fileName, structures }));
    } catch (error) {
      reject(error);
    }
  });
}
