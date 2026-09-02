
import { StructureContainer } from '../model/index.js';
import { readPOSCAR } from '../io/ReadPOSCARModule.js';
import { FileSource } from '../io/FileSource.js';
const tableBody = document.querySelector("#objectTable tbody");
import {fileBrowser,structureShip} from '../state/store.js';
import {createRow,selectLastAddedRow} from './FileBrowswerPanel.js';
import { restoreAtomColors } from '../utils/ColorModule.js';
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




export  function parsePOSCAR(content, fileName, options = undefined) {
   console.log(content)
  const structure = readPOSCAR(content, fileName);
  return initializeWithPOSCAR(structure, fileName, options);
}

export function initializeWithPOSCAR(structure, fileName, options = undefined) {
  const container = new StructureContainer({
    fileName: fileName,
    structures: [structure],
  });

  return initializeUIOnLoad(container, options);
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

/**
 * Register a loaded container with the file browser and select it — every
 * load path funnels through here.
 * @param {any} structureContainer
 * @param {{ restoreStoredColors?: boolean }} [options] restoreStoredColors
 *   (default true) re-applies the per-atom user colours saved for this same
 *   file in an earlier session (utils/ColorModule.js). A share-URL / .crysviz
 *   load passes false: that state is a complete snapshot of the colours and
 *   must not have stored overrides mixed in underneath it.
 */
export function initializeUIOnLoad(structureContainer, { restoreStoredColors = true } = {}) {
  console.log(structureContainer);
  const fileName = structureContainer.fileName;
  const structures = structureContainer.structures;

  const traj = structures.length;
  const step = traj;
  const row = createRow({ name: fileName, traj, step });
  tableBody.appendChild(row);
  fileBrowser.fileData.push({ idx: -1, name: fileName, traj, step });

  // Before the row is selected (and rendered) below, so the first rebuild
  // already paints the restored colours.
  if (restoreStoredColors) restoreAtomColors(structureContainer);

  structureShip.container.push(structureContainer);
  selectLastAddedRow();
  return structureContainer;
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

    for (const file of files) {
      setStatus(`Loading ${file.name} (${++loadedCount}/${files.length})...`);
      // Hand over a lazy handle rather than the file's contents.
      //
      // This used to be a FileReader that read the whole file up front — as text,
      // or as an ArrayBuffer for the one binary format it knew about (.traj).
      // That forced a decision about how to read the file before anything had
      // decided what the file *was*, and it made a multi-GB WAVECAR impossible
      // to open at all.
      //
      // loadStructure now identifies the format first (io/formats.js) and reads
      // only what that format needs (io/formats.js `materialize`). Text formats
      // still get the entire file as a string, so nothing changes for them.
      await onLoadStructure(FileSource.fromFile(file), file.name);
    }
    setStatus(`${files.length} structure(s) loaded!`);
  }

  function reportFileLoadError(error) {
    console.error('Error loading structures:', error);
    setStatus('Error loading structures.');
  }

  // ---- Upload: open the file dialog directly ----

  if (fileInput) {
    fileInput.onchange = async (e) => {
      try {
        await loadFiles(Array.from(e.target.files));
      } catch (error) {
        reportFileLoadError(error);
      }
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
    try {
      await loadFiles(Array.from(e.dataTransfer.files));
    } catch (error) {
      reportFileLoadError(error);
    }
  });
}
