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
import { detectFormat } from './formats.js';

/*
 * The idea is that parse_any will eventually take over all parsing
 * of any kind of structure data and return back a StructureContainer
 */
export async function parse_any(content, fileName = '', isDefault = false) {

  const contentString = typeof content === 'string' ? content : '';

  // Which format this is, is decided in one place (io/formats.js) rather than
  // by a chain of booleans here. The registry is name-based today; the content
  // sniffers below are the exception, and are the first thing that will move
  // onto the registry when detection switches to inspecting file contents.
  let formatId = detectFormat({ fileName }).id;

  // CIF content sniffing outranks every name-based match except .traj. That is
  // the precedence the original boolean chain had (treatAsCIF and treatAsmagCIF
  // were tested before the QE / OUTCAR / XYZ names, and both ORed the content
  // sniffer into the name test), and CIFs do arrive under uninformative names
  // often enough that dropping it would be a regression.
  //
  // Order between the two matters: isLikelymagCIFContent also returns true for
  // the generic `data_` / `_cell_length_` markers every CIF has, so testing it
  // first would route ordinary CIFs into the magnetic parser. Testing plain CIF
  // first works because it explicitly bails out on the magnetic markers.
  // `.res` and `.cell` carry distinctive extensions and their own block markers,
  // so a positive name match is authoritative — don't let the CIF sniffers
  // reroute them on an incidental `data_`/`_cell_` token in a comment.
  const nameAuthoritative = formatId === 'traj' || formatId === 'cif'
    || formatId === 'mcif' || formatId === 'res' || formatId === 'castep-cell'
    || formatId === 'castep-geom' || formatId === 'aims-geometry' || formatId === 'aims-out';
  if (!nameAuthoritative) {
    if (isLikelyCIFContent(contentString)) formatId = 'cif';
    else if (isLikelymagCIFContent(contentString)) formatId = 'mcif';
  }

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

export function isLikelyCIFContent(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  const firstLine = content.split(/\r?\n/).find(line => line.trim().length > 0);
  if (firstLine === "##CIF_2.0") return false; // We cannot parse CIF2.0 as non-magCIF, so we'll always defer them there
  const t = trimmed.toLowerCase();
  // Defer if there are any magCIF keys
  if (t.includes("_space_group_symop_magn_operation") ||
      t.includes("_space_group_magn_number_bns") ||
      t.includes("_space_group_magn.number_bns") ||
      t.includes("_parent_space_group")) return false;
  if (/^\s*data_/i.test(t)) return true;
  if (/_cell_(length|angle)_[abc]/i.test(t)) return true;
  if (/_symmetry_space_group_name_h-m/i.test(t)) return true;
  return false;
}

export function isLikelymagCIFContent(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  const firstLine = content.split(/\r?\n/).find(line => line.trim().length > 0);
  if (firstLine === "##CIF_2.0") return true;
  const t = trimmed.toLowerCase();
  if (t.includes("_space_group_symop_magn_operation") ||
      t.includes("_space_group_magn_number_bns") ||
      t.includes("_space_group_magn.number_bns") ||
      t.includes("_parent_space_group")) return true;
  if (/^\s*data_/i.test(t)) return true;
  if (/_cell_(length|angle)_[abc]/i.test(t)) return true;
  if (/_symmetry_space_group_name_h-m/i.test(t)) return true;
  return false;
}

export function isLikelyOUTCARContent(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/Startparameter/i.test(trimmed)) return true;
  if (/Iteration:/i.test(trimmed)) return true;
  return false;
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

