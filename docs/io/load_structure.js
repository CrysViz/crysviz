import { Structure } from "../model/index.js";
import { StructureContainer } from '../model/index.js';
import { Atom } from '../model/index.js';
import { cif_to_struct, mcif_to_magstruct } from './cif.js';
import { parsePWSCFin } from './ReadPWSCFinModule.js';
import { parsePWSCFout } from './ReadPWSCFoutModule.js';
import { parseOUTCAR } from './ReadOutcarModule.js';
import { parseXYZFile } from './ReadeXYZModule.js';
import { parseResFile } from './ReadResModule.js';
import { parseCastepCell } from './ReadCastepCellModule.js';
import { parseCastepGeom } from './ReadCastepGeomModule.js';
import { parseAimsGeometry } from './ReadAimsGeometryModule.js';
import { parseAimsOut } from './ReadAimsOutModule.js';
import { readPOSCAR } from './ReadPOSCARModule.js';
import { parseASETrajectory } from './ReadASETrajectoryModule.js';
import {generateID} from '../utils/index.js'
import { detectFormat, headOf, looksLike } from './formats.js';

/*
 * The idea is that parse_any will eventually take over all parsing
 * of any kind of structure data and return back a StructureContainer
 */
export async function parse_any(content, fileName = '', isDefault = false) {

  // Which format this is, is decided in one place (io/formats.js): by the
  // file's contents first and by its name only as the tiebreak/fallback. The
  // CIF sniffers that used to be special-cased here now live on the registry
  // alongside a sniffer for every other format, so a QE run saved as
  // `relax.out`, an aims.out called `Si.scf.out`, or a CIF called `download`
  // all reach the right reader.
  const formatId = detectFormat({ fileName, head: headOf(content) }).id;

  switch (formatId) {
    case 'traj':
      // ASE ULM trajectories are binary; `content` arrives as an ArrayBuffer.
      console.log("This is probably an ASE trajectory file");
      return parseASETrajectory(content, fileName);

    case 'cif':
      console.log("This is probably a CIF file")
      return parse_cif(content, fileName, false)

    case 'mcif':
      console.log("This is probably an magCIF file")
      return parse_cif(content, fileName, true)

    case 'pwscf-in':
      console.log("This is probably a QE input file");
      return parsePWSCFin(content, fileName);

    case 'pwscf-out':
      console.log("This is probably a QE output file");
      return parsePWSCFout(content, fileName);

    case 'outcar':
      console.log("This is probably an OUTCAR file");
      return parseOUTCAR(content, fileName);

    case 'xyz':
      console.log("This is probably an (e)XYZ file");
      return parseXYZFile(content, fileName);

    case 'res':
      console.log("This is probably a SHELX/AIRSS .res file");
      return parseResFile(content, fileName);

    case 'castep-cell':
      console.log("This is probably a CASTEP .cell file");
      return parseCastepCell(content, fileName);

    case 'castep-geom':
      console.log("This is probably a CASTEP .geom/.md/.ts trajectory");
      return parseCastepGeom(content, fileName);

    case 'aims-geometry':
      console.log("This is probably an FHI-aims geometry.in file");
      return parseAimsGeometry(content, fileName);

    case 'aims-out':
      console.log("This is probably an FHI-aims output file");
      return parseAimsOut(content, fileName);

    default: {
      console.log("This is probably a POSCAR file")
      const structure = readPOSCAR(content, fileName);
      return new StructureContainer({
        fileName,
        structures: [structure],
      });
    }
  }
}

// ----------------- Sniffers ------------------------
//
// Kept for API compatibility (they are re-exported from io/index.js). The
// actual rules live on the descriptors in io/formats.js, next to the sniffers
// for every other format, so there is exactly one definition of "looks like a
// CIF" and it is the one `detectFormat` uses.

export function isLikelyCIFContent(content) {
  return looksLike('cif', content);
}

export function isLikelymagCIFContent(content) {
  return looksLike('mcif', content);
}

export function isLikelyOUTCARContent(content) {
  return looksLike('outcar', content);
}

// ---------------- Parsers ---------------

export async function parse_cif(content, fileName = '', mcif = false) {

  let cif_struct = null;

  if (!mcif) {
    cif_struct = await cif_to_struct(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },}));
  } else {
    cif_struct = await mcif_to_magstruct(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },}));
  }

  const elements = cif_struct["species_full"];
  const positions = cif_struct["positions_full"];
  const spins = cif_struct["moments_full"];

  // Full site composition, one entry per expanded atom. Present only for plain
  // CIFs — mCIF takes a different expansion path — in which case Atom falls
  // back to a single fully-occupied species built from `element`.
  const siteSpecies = cif_struct["site_species_full"];

  const atoms = [];
  positions.forEach((pos, i) => {
    atoms.push(
      new Atom({
        position: pos,
        element: elements[i],
        species: siteSpecies ? siteSpecies[i] : null,
        uuid: generateID([elements[i]])
      })
    );
  });

  const structure = new Structure({
    elements,
    uniqueElements: [...new Set(elements)].sort(),
    lattice: cif_struct["basis"],
    atoms,
    spins
  });

  const container = new StructureContainer({
    fileName,
    structures: [structure],
  });

  return container;
}

