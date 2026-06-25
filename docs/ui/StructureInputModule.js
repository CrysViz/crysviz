
import { StructureContainer } from '../model/index.js';
import { readPOSCAR } from '../io/ReadPOSCARModule.js';
const tableBody = document.querySelector("#objectTable tbody");
import {fileBrowser,structureShip} from '../state/store.js';
import {createRow,selectLastAddedRow} from './FileBrowswerPanel.js';
import {
  transpose3x3,
  invert3x3,
  multiplyMatVec,
  normalizeFractional,
  latticeFromCell,
  cartToFractional,
} from '../math/index.js';

export {
  transpose3x3,
  invert3x3,
  multiplyMatVec,
  normalizeFractional,
  latticeFromCell,
  cartToFractional,
};




export  function parsePOSCAR(content, fileName) {
   console.log(content)
  const structure = readPOSCAR(content, fileName);
  initializeWithPOSCAR(structure, fileName);  
}

export function initializeWithPOSCAR(structure, fileName) {
  const container = new StructureContainer({
    fileName: fileName,
    structures: [structure],
  });

  initializeUIOnLoad(container);
}





// export async function parseCIF(content) {
//   const result = parseCifFallback(content);
//   return result;
// }
//




// Direct fetch of optimade fails due to cors. Not sure what or why.





export function isLikelyCIFContent(content) {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/^\s*data_/i.test(trimmed)) return true;
  if (/_cell_(length|angle)_[abc]/i.test(trimmed)) return true;
  if (/_symmetry_space_group_name_h-m/i.test(trimmed)) return true;
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

export function initializeUIOnLoad(structureContainer) {
  console.log(structureContainer);
  const fileName = structureContainer.fileName;
  const structures = structureContainer.structures;

  const traj = structures.length;
  const step = traj;
  const row = createRow({ name: fileName, traj, step });
  tableBody.appendChild(row);
  fileBrowser.fileData.push({ idx: -1, name: fileName, traj, step });

  structureShip.container.push(structureContainer);
  selectLastAddedRow();
}


export function setupStructureInput({ onLoadStructure, setStatus }) {
  const fileInput = document.getElementById('fileInput');
  const fileLabel = document.getElementById('fileLabel');
  const inputModeButtons = Array.from(document.querySelectorAll('.input-mode-btn'));
  const fileInputContainer = document.getElementById('fileInputContainer');
  const textInputContainer = document.getElementById('textInputContainer');
  const structureText = document.getElementById('structureText');
  const loadTextButton = document.getElementById('loadTextButton');

  if (typeof onLoadStructure !== 'function') {
    throw new Error('setupStructureInput requires an onLoadStructure callback');
  }
  if (typeof setStatus !== 'function') {
    throw new Error('setupStructureInput requires a setStatus callback');
  }

  let currentInputMode = 'file';

  function setInputMode(mode) {
    if (!fileInputContainer || !textInputContainer) return;
    currentInputMode = mode === 'text' ? 'text' : 'file';
    const showText = currentInputMode === 'text';

    inputModeButtons.forEach(btn => {
      const isActive = btn.dataset.mode === currentInputMode;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      const controls = btn.getAttribute('aria-controls');
      if (controls) {
        const panel = document.getElementById(controls);
        if (panel) panel.setAttribute('tabindex', isActive ? '0' : '-1');
      }
    });

    if (showText) {
      fileInputContainer.setAttribute('hidden', '');
      fileInputContainer.setAttribute('aria-hidden', 'true');
      textInputContainer.removeAttribute('hidden');
      textInputContainer.setAttribute('aria-hidden', 'false');
      if (structureText && typeof structureText.focus === 'function') {
        setTimeout(() => structureText.focus({ preventScroll: true }), 0);
      }
    } else {
      textInputContainer.setAttribute('hidden', '');
      textInputContainer.setAttribute('aria-hidden', 'true');
      fileInputContainer.removeAttribute('hidden');
      fileInputContainer.setAttribute('aria-hidden', 'false');
    }
  }

  if (inputModeButtons.length > 0) {
    inputModeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode) setInputMode(mode);
      });
    });
  }

  setInputMode('file');

  async function loadStructureFromText() {
    if (!structureText) return;
    const raw = structureText.value.trim();
    if (!raw) {
      setStatus('Paste POSCAR, CIF, OPTIMADE URL, Materials Project mp-id, or Alexandria agm-id before loading.');
      structureText.focus({ preventScroll: true });
      return;
    }

    // ... (rest of your existing loadStructureFromText function)
  }

  if (loadTextButton) {
    loadTextButton.addEventListener('click', (event) => {
      event.preventDefault();
      loadStructureFromText();
    });
  }

  if (structureText) {
    structureText.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        loadStructureFromText();
      }
    });
  }

  if (fileInput) {
    fileInput.onchange = async (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;

      setStatus(`Loading ${files.length} structure(s)...`);
      let loadedCount = 0;

      try {
        for (const file of files) {
          setStatus(`Loading ${file.name} (${++loadedCount}/${files.length})...`);
          const reader = new FileReader();
          await new Promise((resolve, reject) => {
            reader.onload = (event) => {
              try {
                onLoadStructure(event.target.result, file.name);
                resolve();
              } catch (err) {
                reject(err);
              }
            };
            reader.onerror = (error) => reject(error);
            // ASE .traj files are binary ULM; read them as an ArrayBuffer so the
            // raw float64 data survives. Everything else is text.
            if (file.name.toLowerCase().endsWith('.traj')) {
              reader.readAsArrayBuffer(file);
            } else {
              reader.readAsText(file);
            }
          });
        }
        setStatus(`${files.length} structure(s) loaded!`);
      } catch (error) {
        console.error('Error loading structures:', error);
        setStatus('Error loading structures.');
      } finally {
        fileInput.value = '';
      }
    };
  }

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    document.body.addEventListener(eventName, preventDefaults, false);
    if (fileLabel) fileLabel.addEventListener(eventName, preventDefaults, false);
  });

  if (fileLabel) {
    ['dragenter', 'dragover'].forEach(eventName => {
      fileLabel.addEventListener(eventName, highlight, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      fileLabel.addEventListener(eventName, unhighlight, false);
    });

    fileLabel.addEventListener('drop', async (e) => {
      preventDefaults(e);
      unhighlight();

      const dt = e.dataTransfer;
      const files = Array.from(dt.files);
      if (files.length === 0) return;

      if (currentInputMode !== 'file') {
        setInputMode('file');
      }

      setStatus(`Loading ${files.length} structure(s)...`);
      let loadedCount = 0;

      try {
        for (const file of files) {
          setStatus(`Loading ${file.name} (${++loadedCount}/${files.length})...`);
          const reader = new FileReader();
          await new Promise((resolve, reject) => {
            reader.onload = (event) => {
              try {
                onLoadStructure(event.target.result, file.name);
                resolve();
              } catch (err) {
                reject(err);
              }
            };
            reader.onerror = (error) => reject(error);
            // ASE .traj files are binary ULM; read them as an ArrayBuffer so the
            // raw float64 data survives. Everything else is text.
            if (file.name.toLowerCase().endsWith('.traj')) {
              reader.readAsArrayBuffer(file);
            } else {
              reader.readAsText(file);
            }
          });
        }
        setStatus(`${files.length} structure(s) loaded!`);
      } catch (error) {
        console.error('Error loading structures:', error);
        setStatus('Error loading structures.');
      }
    });
  }

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function highlight() {
    if (!fileLabel || currentInputMode !== 'file') return;
    fileLabel.classList.add('dragover');
  }

  function unhighlight() {
    if (!fileLabel) return;
    fileLabel.classList.remove('dragover');
  }

  return {
    getCurrentInputMode: () => currentInputMode,
    setInputMode,
  };
}
