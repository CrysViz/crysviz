import { fileBrowser } from '../state/store.js';
import { captureState } from './ShareModule.js';

export function poscartoFile() {
  const structure = fileBrowser.selectedStructure;
  if (!structure || !structure.atoms?.length || !structure.elements?.length || !structure.lattice?.length) {
    throw new Error('No structure loaded.');
  }

  const comment = `POSCAR created with CrysViz ${new Date().toISOString()}`;

  const latticeLines = structure.lattice.map(v =>
    v.map(x => x.toFixed(8).padStart(18)).join('')
  );

  // unique elements preserving first-occurrence order
  const seen = new Set();
  const uniqueElements = [];
  for (const el of structure.elements) {
    if (!seen.has(el)) { seen.add(el); uniqueElements.push(el); }
  }

  const counts = uniqueElements.map(el => structure.elements.filter(e => e === el).length);

  // positions grouped by element (Direct / fractional)
  const posLines = [];
  for (const el of uniqueElements) {
    structure.atoms.forEach((atom, i) => {
      if (structure.elements[i] === el) {
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
    ? JSON.parse(fileBrowser.selectedRow.dataset.obj).name
    : 'structure';
  return rawName.replace(/\.[^.]+$/, '');
}

/** Trigger a browser download of a Blob under the given file name. */
export function downloadBlob(fileName, blob) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
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
      const state = captureState();
      if (!state) { alert('No structure loaded.'); return; }
      downloadTextFile(currentBaseName() + '.crysviz',
        JSON.stringify({ format: 'crysviz', ...state }, null, 2));
    });
  }
}

