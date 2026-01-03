import {fileBrowser} from '../store.js';

//------------------------------------------------------------
// Convert current structure data to POSCAR string
//------------------------------------------------------------
export function poscartoFile() {
  if (!structureData.positions || !structureData.elements || !structureData.lattice) {
    throw new Error("Structure data incomplete: positions, elements, and lattice are required.");
  }
  const now = new Date();
  const comment = `POSCAR created with CrysViz ${now}`;
  const latticeScale = 1.0;

  // lattice vectors
  const latticeLines = structureData.lattice.map(v => v.map(x => x * latticeScale).join(' '));

  // elements (unique, ordered)
  const uniqueElements = [...new Set(structureData.elements)];

  // counts per element
  const counts = uniqueElements.map(el => structureData.elements.filter(e => e === el).length);

  // map element to indices
  const elementIndices = uniqueElements.map(el => structureData.elements.map((e,i) => e === el ? i : -1).filter(i => i >= 0));

  // direct coordinates
  const posLines = [];
  for (let idx of structureData.elements.map((_,i)=>i)) {
    const pos = structureData.positions[idx];
    posLines.push(pos.map(v => v.toFixed(6)).join(' '));
  }

  const lines = [];
  lines.push(comment);
  lines.push('1.0');
  lines.push(...latticeLines);
  lines.push(uniqueElements.join(' '));
  lines.push(counts.join(' '));
  lines.push('Direct');
  lines.push(...posLines);

  return lines.join('\n');
}



export function addSavePanel() {
  const button = document.getElementById('saveButton');

  if (!button) {
    console.warn('No element with id "saveButton" found.');
    return;
  }
  button.addEventListener('click', () => {
    const fileName = JSON.parse(fileBrowser.selectedRow.dataset.obj).name;
    console.warn(fileName)
    try {
      const content = poscartoFile();
      const blob = new Blob([content], { type: 'text/plain' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
  } catch (e) {
    alert(e.message);
  }
  });
}

