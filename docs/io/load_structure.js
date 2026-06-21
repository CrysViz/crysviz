import { Structure } from "../model/index.js";
import { StructureContainer } from '../model/index.js';
import { Atom } from '../model/index.js';
import { cif_to_struct, mcif_to_magstruct } from './cif.js';
import { parsePWSCFin } from './ReadPWSCFinModule.js';
import { parsePWSCFout } from './ReadPWSCFoutModule.js';
import { parseOUTCAR } from './ReadOutcarModule.js';
import { parseXYZFile } from './ReadeXYZModule.js';
import { readPOSCAR } from './ReadPOSCARModule.js';
import {generateID} from '../utils/index.js'

/*
 * The idea is that parse_any will eventually take over all parsing
 * of any kind of structure data and return back a StructureContainer
 */
export async function parse_any(content, fileName = '', isDefault = false) {

  const lower = (fileName || '').toLowerCase();
  const contentString = typeof content === 'string' ? content : '';
  const treatAsCIF = lower.endsWith('.cif') ||
        lower.includes('.cif') ||
    /(^|\W)cif(\W|$)/.test(lower) ||
        isLikelyCIFContent(contentString);
  const treatAsmagCIF = lower.endsWith('.mcif') ||
        lower.includes('.mcif') ||
    /(^|\W)mcif(\W|$)/.test(lower) ||
        isLikelymagCIFContent(contentString);

  const treatAsOUTCAR = lower.endsWith('.vasp.out') ||
        lower.includes('.vasp.out') ||
        lower.includes('outcar');

  const treatAsPWSCFout = lower.endsWith(".scf.out") ||
        lower.endsWith(".scf.in.out") ||
        lower.endsWith(".vcrx.out") ||
        lower.endsWith(".vcrx.in.out") ||
        lower.includes('.scf.out') ||
        lower.includes('.scf.in.out') ||
        lower.includes(".vcrx.out") ||
        lower.includes(".vcrx.in.out");


  const treatAsPWSCFin = lower.endsWith(".scf.in") ||
        lower.endsWith(".vcrx.in");

  const treatAsEXZY = lower.endsWith(".xyz") ||
        lower.endsWith(".exyz");


  if (treatAsCIF) {
    console.log("This is probably a CIF file")
    return parse_cif(content, fileName, false)
  }

  if (treatAsmagCIF) {
    console.log("This is probably an magCIF file")
    return parse_cif(content, fileName, true)
  }

  else if (treatAsPWSCFin) {
    console.log("This is probably a QE input file");
    return parsePWSCFin(content, fileName);
  }

  else if (treatAsPWSCFout) {
    console.log("This is probably a QE output file");
    return parsePWSCFout(content, fileName);
  }

  else if (treatAsOUTCAR){
    console.log("This is probably an OUTCAR file");
    return parseOUTCAR(content, fileName);
  }

  else if (treatAsEXZY) {
    console.log("This is probably an (e)XYZ file");
    return parseXYZFile(content, fileName);
  }

  else {
    console.log("This is probably a POSCAR file")
    const structure = readPOSCAR(content, fileName);
    return new StructureContainer({
      fileName,
      structures: [structure],
    });
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

  const atoms = [];
  positions.forEach((pos, i) => {
    atoms.push(
      new Atom({
        position: pos,
        element: elements[i],
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

