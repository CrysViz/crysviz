
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
  const uploadButton = document.getElementById('uploadButton');
  const pasteTextButton = document.getElementById('pasteTextButton');
  const downloadButton = document.getElementById('downloadButton');
  const downloadMenu = document.getElementById('downloadMenu');

  if (typeof onLoadStructure !== 'function') {
    throw new Error('setupStructureInput requires an onLoadStructure callback');
  }
  if (typeof setStatus !== 'function') {
    throw new Error('setupStructureInput requires a setStatus callback');
  }

  // ---- shared file loader (file dialog + drag&drop) ----

  async function loadFiles(files) {
    if (!files || files.length === 0) return;
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
  }

  // ---- Upload: open the file dialog directly ----

  if (fileInput) {
    fileInput.onchange = async (e) => {
      await loadFiles(Array.from(e.target.files));
      fileInput.value = '';
    };
  }

  if (uploadButton && fileInput) {
    uploadButton.addEventListener('click', () => fileInput.click());
  }

  // ---- Paste Text: modal dialog with the paste field ----

  const pasteModal = document.createElement('div');
  pasteModal.id = 'pasteTextModal';
  pasteModal.hidden = true;
  pasteModal.innerHTML = `
    <div class="paste-modal" role="dialog" aria-modal="true" aria-label="Paste structure text">
      <textarea id="structureText" placeholder="Paste POSCAR/CIF content, OPTIMADE URL, Materials Project mp-id, or Alexandria agm-id"></textarea>
      <div class="paste-modal-actions">
        <button type="button" id="loadTextButton">Load Structure</button>
        <button type="button" id="cancelTextButton">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(pasteModal);
  const structureText = /** @type {HTMLTextAreaElement} */ (pasteModal.querySelector('#structureText'));
  const loadTextButton = pasteModal.querySelector('#loadTextButton');
  const cancelTextButton = pasteModal.querySelector('#cancelTextButton');

  function openPasteModal() {
    pasteModal.hidden = false;
    setTimeout(() => structureText.focus({ preventScroll: true }), 0);
  }

  function closePasteModal() {
    pasteModal.hidden = true;
  }

  async function loadStructureFromText() {
    const raw = structureText.value.trim();
    if (!raw) {
      setStatus('Paste POSCAR, CIF, OPTIMADE URL, Materials Project mp-id, or Alexandria agm-id before loading.');
      structureText.focus({ preventScroll: true });
      return;
    }
    closePasteModal();
    await onLoadStructure(raw, 'pasted');
    structureText.value = '';
  }

  if (pasteTextButton) pasteTextButton.addEventListener('click', openPasteModal);
  if (cancelTextButton) cancelTextButton.addEventListener('click', closePasteModal);
  pasteModal.addEventListener('click', (e) => {
    if (e.target === pasteModal) closePasteModal(); // backdrop click
  });
  pasteModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePasteModal();
  });

  if (loadTextButton) {
    loadTextButton.addEventListener('click', (event) => {
      event.preventDefault();
      loadStructureFromText();
    });
  }

  structureText.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      loadStructureFromText();
    }
  });

  // ---- Download: dropdown of export formats (#saveButton = POSCAR, wired
  //      by ui/SavePanel.js) ----

  if (downloadButton && downloadMenu) {
    downloadButton.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadMenu.hidden = !downloadMenu.hidden;
    });
    downloadMenu.addEventListener('click', () => { downloadMenu.hidden = true; });
    document.addEventListener('click', (e) => {
      if (!downloadMenu.hidden && !downloadButton.contains(/** @type {Node} */ (e.target))) {
        downloadMenu.hidden = true;
      }
    });
  }

  // ---- Drag & drop: the Files window and the 3D view are drop targets ----

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  /** The drop target under the pointer: the Files panel window or #view. */
  function dropTargetFor(eventTarget) {
    if (!(eventTarget instanceof Element)) return null;
    return eventTarget.closest('.cv-panel[data-panel-id="files"]')
      || eventTarget.closest('#view');
  }

  let dropHoverEl = null;
  function setDropHover(el) {
    if (dropHoverEl === el) return;
    if (dropHoverEl) dropHoverEl.classList.remove('cv-drop-hover');
    dropHoverEl = el;
    if (dropHoverEl) dropHoverEl.classList.add('cv-drop-hover');
  }

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    document.body.addEventListener(eventName, preventDefaults, false);
  });

  document.body.addEventListener('dragover', (e) => {
    setDropHover(dropTargetFor(e.target));
  });

  document.body.addEventListener('dragleave', (e) => {
    // Pointer left the window (or moved to browser chrome).
    if (!e.relatedTarget) setDropHover(null);
  });

  document.body.addEventListener('drop', async (e) => {
    const target = dropTargetFor(e.target);
    setDropHover(null);
    if (!target) return;
    await loadFiles(Array.from(e.dataTransfer.files));
  });
}
