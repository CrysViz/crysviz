/**
 * Parser for CASTEP `.cell` input files.
 *
 * A .cell file describes the structure through paired %BLOCK … %ENDBLOCK
 * sections (see the CASTEP "cell file" reference). This reader understands the
 * structural blocks:
 *
 *   LATTICE_CART   optional units line, then 3 Cartesian lattice vectors (rows)
 *   LATTICE_ABC    optional units line, then "a b c" and "α β γ"
 *   POSITIONS_FRAC element x y z …            (fractional coordinates)
 *   POSITIONS_ABS  optional units line, element x y z … (Cartesian coordinates)
 *
 * Block/keyword names are case-insensitive and may use spaces or underscores;
 * `!` and `#` start end-of-line comments. Absolute positions are converted to
 * fractional against the lattice, matching how every other reader stores
 * coordinates.
 *
 * An AIRSS `buildcell` seed is also a `.cell`: it may carry POSITIONS_ABS with
 * NO lattice block (the cell is generated later from `#` build hints such as
 * TARGVOL / MINSEP). Such a file loads as a molecule in a centered bounding
 * box, exactly as the (ext)XYZ reader handles lattice-less input.
 *
 * The companion `.param` file holds only run parameters (task, xc functional,
 * cut-off …) and no geometry, so it is not a structural input.
 */

import { Structure, StructureContainer, Atom } from '../model/index.js';
import {
  latticeFromCell, transpose3x3, invert3x3, cartToFractional, normalizeFractional,
} from '../math/index.js';
import { runPeriodicWrapped } from '../render/index.js';
import { generateID } from '../utils/index.js';

// Length units CASTEP accepts on a block's units line, as factors to Ångström.
const LENGTH_TO_ANG = {
  ang: 1, a: 1, angstrom: 1,
  bohr: 0.52917721067, a0: 0.52917721067, atomic: 0.52917721067,
  nm: 10, pm: 0.01, m: 1e10, cm: 1e8,
};

/** Strip `!`/`#` comments and trim; returns '' for blank/comment-only lines. */
function clean(line) {
  const noComment = line.replace(/[!#].*$/, '');
  return noComment.trim();
}

/** Normalise a block name: uppercase, spaces→underscores (LATTICE CART == LATTICE_CART). */
function blockName(raw) {
  return raw.trim().toUpperCase().replace(/\s+/g, '_');
}

/**
 * Collect the %BLOCK sections of a .cell file into { NAME: [lines…] }, with
 * comments stripped and blank lines dropped.
 * @param {string[]} lines
 * @returns {Record<string, string[]>}
 */
function collectBlocks(lines) {
  /** @type {Record<string, string[]>} */
  const blocks = {};
  let name = null;
  let body = [];

  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;

    const begin = line.match(/^%BLOCK\s+(.+)$/i);
    if (begin) { name = blockName(begin[1]); body = []; continue; }

    const end = line.match(/^%ENDBLOCK\s+(.+)$/i);
    if (end) { if (name) blocks[name] = body; name = null; body = []; continue; }

    if (name) body.push(line);
  }
  return blocks;
}

/** If the first block line is a bare units token, return its Å factor and the
 *  remaining data lines; otherwise a factor of 1 and all the lines. */
function splitUnits(bodyLines) {
  if (bodyLines.length) {
    const token = bodyLines[0].split(/\s+/)[0]?.toLowerCase();
    if (token && Object.prototype.hasOwnProperty.call(LENGTH_TO_ANG, token)) {
      return { factor: LENGTH_TO_ANG[token], data: bodyLines.slice(1) };
    }
  }
  return { factor: 1, data: bodyLines };
}

/** Build the 3×3 lattice (Å) from whichever lattice block is present. */
function readLattice(blocks) {
  if (blocks.LATTICE_CART) {
    const { factor, data } = splitUnits(blocks.LATTICE_CART);
    const rows = data.slice(0, 3).map(l => l.split(/\s+/).slice(0, 3).map(Number));
    if (rows.length === 3 && rows.every(r => r.length === 3 && r.every(Number.isFinite))) {
      return rows.map(r => r.map(v => v * factor));
    }
  }
  if (blocks.LATTICE_ABC) {
    const { data } = splitUnits(blocks.LATTICE_ABC);
    const abc = (data[0] || '').split(/\s+/).map(Number);
    const ang = (data[1] || '').split(/\s+/).map(Number);
    if (abc.length >= 3 && ang.length >= 3) {
      return latticeFromCell(abc[0], abc[1], abc[2], ang[0], ang[1], ang[2]);
    }
  }
  return null;
}

/** Extract the leading element symbol from a positions line token (drops a
 *  trailing `:tag` label and any digits, e.g. `Fe:spin` → `Fe`, `H1` → `H`). */
function elementFromToken(token) {
  return token.split(':')[0].replace(/[0-9].*$/, '');
}

/** Fallback cell for a seed with absolute positions and NO lattice block — an
 *  AIRSS `buildcell` seed, where the cell is generated later from the build
 *  hints (TARGVOL, MINSEP, …) rather than given. Mirrors the (ext)XYZ reader:
 *  an orthorhombic box large enough to hold the molecule, with the centroid
 *  moved to the box center. Returns the box lattice and the centered positions.
 *  @param {number[][]} cart Cartesian positions (Å) */
function molecularBox(cart) {
  let maxMag = 0;
  const com = [0, 0, 0];
  for (const p of cart) {
    for (let k = 0; k < 3; k++) { maxMag = Math.max(maxMag, Math.abs(p[k])); com[k] += p[k]; }
  }
  const n = cart.length || 1;
  for (let k = 0; k < 3; k++) com[k] /= n;
  const size = 2 * (maxMag + 2); // max reach doubled, plus a 2 Å buffer
  const half = size / 2;
  const lattice = [[size, 0, 0], [0, size, 0], [0, 0, size]];
  const centered = cart.map((p) => [p[0] - com[0] + half, p[1] - com[1] + half, p[2] - com[2] + half]);
  return { lattice, centered };
}

/**
 * Parse a CASTEP .cell file into a single-structure StructureContainer.
 * @param {string} content
 * @param {string} fileName
 * @returns {Promise<StructureContainer>}
 */
export function parseCastepCell(content, fileName) {
  return new Promise((resolve, reject) => {
    if (!content || typeof content !== 'string') {
      reject(new Error('Content must be a non-empty string'));
      return;
    }

    try {
      const blocks = collectBlocks(content.split(/\r?\n/));

      let lattice = readLattice(blocks);
      const elements = [];
      const positions = [];

      if (blocks.POSITIONS_FRAC) {
        // Fractional coordinates are meaningless without a cell.
        if (!lattice) {
          reject(new Error('CASTEP .cell: POSITIONS_FRAC needs a LATTICE_CART or LATTICE_ABC block'));
          return;
        }
        for (const line of blocks.POSITIONS_FRAC) {
          const parts = line.split(/\s+/);
          if (parts.length < 4) continue;
          const coords = parts.slice(1, 4).map(Number);
          if (!coords.every(Number.isFinite)) continue;
          elements.push(elementFromToken(parts[0]));
          positions.push(coords.map(normalizeFractional));
        }
      } else if (blocks.POSITIONS_ABS) {
        const { factor, data } = splitUnits(blocks.POSITIONS_ABS);
        const cart = [];
        for (const line of data) {
          const parts = line.split(/\s+/);
          if (parts.length < 4) continue;
          const xyz = parts.slice(1, 4).map(Number);
          if (!xyz.every(Number.isFinite)) continue;
          elements.push(elementFromToken(parts[0]));
          cart.push(xyz.map((v) => v * factor));
        }
        // An AIRSS seed can carry absolute positions with no lattice (the cell
        // is built later from the # hints). Give it a centered bounding box so
        // it still loads as a molecule, exactly as the (ext)XYZ reader does.
        let boxed = cart;
        if (!lattice && cart.length) ({ lattice, centered: boxed } = molecularBox(cart));
        if (lattice) {
          const latticeInverse = invert3x3(transpose3x3(lattice));
          for (const c of boxed) {
            positions.push(cartToFractional(c, lattice, latticeInverse).map(normalizeFractional));
          }
        }
      }

      if (elements.length === 0) {
        reject(new Error('CASTEP .cell: no POSITIONS_FRAC or POSITIONS_ABS block found'));
        return;
      }
      if (!lattice) {
        reject(new Error('CASTEP .cell: no LATTICE_CART or LATTICE_ABC block found'));
        return;
      }

      const atoms = positions.map((position, i) => new Atom({
        position,
        element: elements[i],
        uuid: generateID([elements[i], i]),
      }));

      const periodic = runPeriodicWrapped(
        { hash: 'None', wrapped: {} }, positions, elements, lattice,
      );

      const structure = new Structure({
        elements,
        uniqueElements: [...new Set(elements)],
        lattice,
        atoms,
        periodic,
      });

      resolve(new StructureContainer({ fileName, structures: [structure] }));
    } catch (error) {
      reject(error);
    }
  });
}
