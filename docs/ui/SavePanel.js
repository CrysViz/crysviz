import { fileBrowser } from '../state/store.js';
import { captureState } from './ShareModule.js';
import { structureHasFractionalOccupancy } from './DisorderWarningBanner.js';
import { isVacancy } from '../render/VacancyMarkerModule.js';
import { latticeParameters } from '../math/index.js';
import { elementData } from './PeriodicTablePickerCore.js';
import { showQEInputModal } from './QEInputModal.js';
import { buildCifText } from '../io/cif/cif_writer.js';
import { prepareSymmetricCif } from './CifSymmetryExport.js';
import { showCifExportModal } from './CifExportModal.js';

/** The selected structure plus a keep-mask that drops vacancy markers, or a
 *  thrown error when nothing is loaded / only vacancies remain. Shared by the
 *  structure-file exporters (CASTEP .cell, FHI-aims geometry.in, both CIFs). */
export function selectedForExport() {
  const structure = fileBrowser.selectedStructure;
  if (!structure || !structure.atoms?.length || !structure.elements?.length || !structure.lattice?.length) {
    throw new Error('No structure loaded.');
  }
  const keep = structure.atoms.map((_, i) => !isVacancy(structure.elements[i]));
  if (!keep.some(Boolean)) {
    throw new Error('Structure has only vacancies — nothing to export.');
  }
  return { structure, keep };
}

// High-precision, fixed-point (never exponential) number formatting for every
// structure export. 12 decimals is ~1e-12 — far below any symmetry tolerance —
// so a symmetric cell exported here stays symmetric even at tight symprec: we
// never round coordinates or cell parameters down to a lossy width.
const hp = (x) => Number(x).toFixed(12);
const hpCol = (x) => hp(x).padStart(20);

/**
 * A CASTEP `.cell` (LATTICE_CART Å + POSITIONS_FRAC). Majority species per site,
 * like the POSCAR export — CASTEP mixture syntax for partial occupancy is not
 * emitted.
 */
export function cellToFile() {
  const { structure, keep } = selectedForExport();
  const lattice = structure.lattice.map((v) => '  ' + v.map(hpCol).join(' '));
  const positions = [];
  structure.atoms.forEach((atom, i) => {
    if (!keep[i]) return;
    positions.push('  ' + String(structure.elements[i]).padEnd(3)
      + ' ' + atom.position.map(hpCol).join(' '));
  });
  return [
    `# CASTEP cell created with CrysViz ${new Date().toISOString()}`,
    '%BLOCK LATTICE_CART',
    ...lattice,
    '%ENDBLOCK LATTICE_CART',
    '',
    '%BLOCK POSITIONS_FRAC',
    ...positions,
    '%ENDBLOCK POSITIONS_FRAC',
    '',
  ].join('\n');
}

/** A collinear initial_moment for aims from a spin vector: the signed z-value
 *  for a z-collinear spin (CrysViz's import convention), else the signed
 *  magnitude. null when there is no meaningful moment. */
function collinearMoment(structure, i) {
  const v = structure.spins?.[i]?.vector;
  if (!Array.isArray(v)) return null;
  const [x = 0, y = 0, z = 0] = v;
  const mag = Math.hypot(x, y, z);
  if (mag < 1e-6) return null;
  if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6) return z;
  const dom = [x, y, z].reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  return Math.sign(dom) * mag;
}

/**
 * An FHI-aims `geometry.in` (lattice_vector Å + atom_frac). Per-atom
 * `initial_moment` is written when the structure carries spins.
 */
export function aimsGeometryToFile() {
  const { structure, keep } = selectedForExport();
  const lines = [`# FHI-aims geometry.in created with CrysViz ${new Date().toISOString()}`];
  structure.lattice.forEach((v) => lines.push('lattice_vector ' + v.map(hp).join(' ')));
  structure.atoms.forEach((atom, i) => {
    if (!keep[i]) return;
    lines.push('atom_frac ' + atom.position.map(hp).join(' ') + ' ' + structure.elements[i]);
    const m = collinearMoment(structure, i);
    if (m !== null) lines.push('initial_moment ' + hp(m));
  });
  return lines.join('\n') + '\n';
}

/** The species occupying a site as [{ element, occupancy }], vacancy markers
 *  dropped: the atom's own `species` list when it has one (a disordered site),
 *  else the structure's element for that atom at full occupancy. */
export function siteSpecies(structure, atom, i) {
  const species = (atom.species && atom.species.length)
    ? atom.species
    : [{ element: structure.elements[i], occupancy: 1 }];
  return species
    .map((s) => ({
      element: s.element || structure.elements[i],
      occupancy: Number.isFinite(s.occupancy) ? s.occupancy : 1,
    }))
    .filter((s) => !isVacancy(s.element));
}

/** `_atom_site` rows for one site: one per species, sharing the coordinates,
 *  labelled El1, El2, ... per element via the shared `counters`. */
export function cifSiteRows(species, position, counters, extra = {}) {
  return species.map(({ element, occupancy }) => {
    counters[element] = (counters[element] || 0) + 1;
    return { label: `${element}${counters[element]}`, symbol: element, position, occupancy, ...extra };
  });
}

export function cifBlockName() {
  return (currentBaseName() || 'structure').replace(/\s+/g, '_') || 'structure';
}

/**
 * A P1 CIF (no symmetry beyond the identity) of the current cell exactly as it
 * is. Fractional occupancies ARE kept: a mixed site is written as one
 * `_atom_site` row per species sharing the same coordinates, so disorder
 * survives the export (unlike POSCAR/.cell).
 */
export function cifToFile() {
  const { structure, keep } = selectedForExport();
  const counters = {};
  const sites = [];
  structure.atoms.forEach((atom, i) => {
    if (!keep[i]) return;
    sites.push(...cifSiteRows(siteSpecies(structure, atom, i), atom.position, counters));
  });
  return buildCifText({
    name: cifBlockName(),
    created: new Date().toISOString(),
    cell: latticeParameters(structure.lattice),
    spaceGroup: { hm: 'P 1', number: 1 },
    symopsXyz: ['x, y, z'],
    sites,
  });
}

/**
 * A CIF with the space group of the cell AS DISPLAYED — see
 * CifSymmetryExport.js. The Download-menu button goes through the export
 * dialog (tolerance + preview); this direct form is for callers and tests.
 * @param {number} [tolerance] symprec in Å; the Symmetry panel's by default
 */
export async function cifSymmetricToFile(tolerance) {
  return (await prepareSymmetricCif(tolerance)).text;
}

export function poscartoFile() {
  const structure = fileBrowser.selectedStructure;
  if (!structure || !structure.atoms?.length || !structure.elements?.length || !structure.lattice?.length) {
    throw new Error('No structure loaded.');
  }

  const comment = `POSCAR created with CrysViz ${new Date().toISOString()}`;

  const latticeLines = structure.lattice.map(v =>
    v.map(hpCol).join('')
  );

  // A POSCAR is a list of real atoms with no way to say "a site is empty", so
  // vacancy markers ("Va") are dropped — writing them would make VASP read a
  // made-up element. The .crysviz save keeps them (see ShareModule.buildPOSCAR).
  const keep = structure.atoms.map((_, i) => !isVacancy(structure.elements[i]));

  // unique elements preserving first-occurrence order
  const seen = new Set();
  const uniqueElements = [];
  structure.elements.forEach((el, i) => {
    if (!keep[i] || seen.has(el)) return;
    seen.add(el); uniqueElements.push(el);
  });

  if (!uniqueElements.length) {
    throw new Error('Structure has only vacancies — nothing to write to a POSCAR.');
  }

  const counts = uniqueElements.map(el => structure.elements.filter((e, i) => keep[i] && e === el).length);

  // positions grouped by element (Direct / fractional)
  const posLines = [];
  for (const el of uniqueElements) {
    structure.atoms.forEach((atom, i) => {
      if (keep[i] && structure.elements[i] === el) {
        posLines.push(atom.position.map(hpCol).join(''));
      }
    });
  }

  return [
    comment,
    '   1.0',
    ...latticeLines,
    '   ' + uniqueElements.join('   '),
    '   ' + counts.join('   '),
    'Direct',
    ...posLines,
  ].join('\n');
}



/**
 * The STRUCTURAL cards of a Quantum ESPRESSO pw.x input — ATOMIC_SPECIES,
 * CELL_PARAMETERS (Å) and ATOMIC_POSITIONS (crystal/fractional) — as text to
 * paste into an scf.in. Not a full input: the namelists, pseudopotentials and
 * K_POINTS are the user's, so this is shown for copying rather than downloaded.
 * Masses come from the periodic-table data; pseudopotential names are `El.UPF`
 * placeholders.
 */
export function qeInputBlock() {
  const { structure, keep } = selectedForExport();
  const keptElements = structure.elements.filter((_, i) => keep[i]);
  const unique = [...new Set(keptElements)];

  const species = unique.map((el) => {
    const mass = elementData[el]?.mass ?? '0.0';
    return `  ${String(el).padEnd(3)} ${String(mass).padStart(9)}  ${el}.UPF`;
  });
  const cell = structure.lattice.map((v) => '  ' + v.map(hp).join('  '));
  const positions = [];
  structure.atoms.forEach((atom, i) => {
    if (!keep[i]) return;
    positions.push('  ' + String(structure.elements[i]).padEnd(3) + ' ' + atom.position.map(hp).join('  '));
  });

  return [
    '! Structural cards for a Quantum ESPRESSO pw.x input (scf.in), from CrysViz.',
    '! Paste below your &CONTROL / &SYSTEM / &ELECTRONS namelists. In &SYSTEM set:',
    '!     ibrav = 0',
    `!     nat   = ${keptElements.length}`,
    `!     ntyp  = ${unique.length}`,
    '! Replace the placeholder masses / *.UPF pseudopotentials and add a K_POINTS card.',
    '',
    'ATOMIC_SPECIES',
    ...species,
    '',
    'CELL_PARAMETERS angstrom',
    ...cell,
    '',
    'ATOMIC_POSITIONS crystal',
    ...positions,
    '',
  ].join('\n');
}

/** Base name of the selected structure's file (extension stripped). */
export function currentBaseName() {
  const rawName = fileBrowser.selectedRow
    ? fileBrowser.selectedRow.querySelector('.name-inner')?.textContent
    : 'structure';
  return String(rawName || 'structure').replace(/\.[^.]+$/, '');
}

/** Trigger a browser download of a Blob under the given file name. */
export function downloadBlob(fileName, blob) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Native webview hosts (pywebview Qt/GTK) resolve the blob URL
  // asynchronously, potentially after a modal save dialog closes. Immediate
  // revocation can abort the download; ten minutes bounds memory use while
  // covering any realistic dialog time.
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
}

export function downloadTextFile(fileName, content) {
  downloadBlob(fileName, new Blob([content], { type: 'text/plain' }));
}

export function addSavePanel() {
  const button = document.getElementById('saveButton');
  if (!button) {
    console.warn('No element with id "saveButton" found.');
    return;
  }
  button.addEventListener('click', () => {
    try {
      // POSCAR has no way to express partial occupancy, so a disordered
      // structure would be written out as if it were ordered — silently, and
      // with each site collapsed to its majority species. Confirm rather than
      // lose that data without saying so.
      if (structureHasFractionalOccupancy() && !confirm(
        'This structure has fractionally occupied sites.\n\n'
        + 'The POSCAR format cannot express occupancy: each site will be written '
        + 'as its majority species and the disorder will be lost.\n\nExport anyway?'
      )) return;
      downloadTextFile(currentBaseName() + '.vasp', poscartoFile());
    } catch (e) {
      alert(e.message);
    }
  });

  // Plain structure-file exporters. Each writes the current frame's cell +
  // fractional positions; wire-up is uniform, only the builder + extension
  // differ. CIF keeps partial occupancy, so it needs no disorder confirmation;
  // .cell collapses a disordered site to its majority species like POSCAR.
  const exporters = [
    { id: 'saveCellButton', build: cellToFile, ext: '.cell', warnDisorder: true },
    { id: 'saveGeometryButton', build: aimsGeometryToFile, ext: '.in', warnDisorder: true, nameSuffix: 'geometry' },
    { id: 'saveCifButton', build: cifToFile, ext: '.cif', warnDisorder: false },
  ];
  for (const { id, build, ext, warnDisorder, nameSuffix } of exporters) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('click', () => {
      try {
        if (warnDisorder && structureHasFractionalOccupancy() && !confirm(
          'This structure has fractionally occupied sites.\n\n'
          + `The ${ext} format cannot express occupancy: each site will be written `
          + 'as its majority species and the disorder will be lost.\n\nExport anyway?'
        )) return;
        // FHI-aims geometry files are conventionally named "geometry.in", not
        // "<structure>.in".
        const base = nameSuffix === 'geometry' ? 'geometry' : currentBaseName();
        downloadTextFile(base + ext, build());
      } catch (e) {
        alert(e.message);
      }
    });
  }

  // CIF with symmetry: a dialog, not a direct download — the symmetry found
  // depends on a tolerance the user has to see (and can change) before the
  // file is written. See CifExportModal.js.
  const cifSymButton = document.getElementById('saveCifSymButton');
  if (cifSymButton) {
    cifSymButton.addEventListener('click', () => {
      try {
        selectedForExport(); // throws the "No structure loaded." message
        showCifExportModal();
      } catch (e) {
        alert(e.message);
      }
    });
  }

  // Quantum ESPRESSO: not a download — a full scf.in needs namelists /
  // pseudopotentials / k-points CrysViz doesn't have, so show the structural
  // cards as copyable text instead.
  const qeButton = document.getElementById('qeInputButton');
  if (qeButton) {
    qeButton.addEventListener('click', () => {
      try {
        showQEInputModal(qeInputBlock());
      } catch (e) {
        alert(e.message);
      }
    });
  }

  // .crysviz: the structure plus the complete visual state (ShareModule's
  // captureState — everything except window placements), as readable JSON.
  const crysvizButton = document.getElementById('saveCrysvizButton');
  if (crysvizButton) {
    crysvizButton.addEventListener('click', () => {
      const state = captureState({ includeFrames: true, includeFields: true });
      if (!state) { alert('No structure loaded.'); return; }
      downloadTextFile(currentBaseName() + '.crysviz',
        JSON.stringify({ format: 'crysviz', ...state }, null, 2));
    });
  }
}
