import { fileBrowser } from '../state/store.js';
import { captureState } from './ShareModule.js';
import { structureHasFractionalOccupancy } from './DisorderWarningBanner.js';
import { isVacancy } from '../render/VacancyMarkerModule.js';

export function poscartoFile() {
  const structure = fileBrowser.selectedStructure;
  if (!structure || !structure.atoms?.length || !structure.elements?.length || !structure.lattice?.length) {
    throw new Error('No structure loaded.');
  }

  const comment = `POSCAR created with CrysViz ${new Date().toISOString()}`;

  const latticeLines = structure.lattice.map(v =>
    v.map(x => x.toFixed(8).padStart(18)).join('')
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
        posLines.push(atom.position.map(v => v.toFixed(8).padStart(18)).join(''));
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

function downloadTextFile(fileName, content) {
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
