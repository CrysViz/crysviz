
import { StructureContainer } from '../model/index.js';
import { readPOSCAR } from '../io/ReadPOSCARModule.js';
import { FileSource } from '../io/FileSource.js';
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
import {
  fetchAlexandriaStructure,
  fetchOptimadeStructure,
  isOptimadeStructureUrl,
  normalizeAlexandriaId,
} from '../io/OptimadeModule.js';

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
  return initializeWithPOSCAR(structure, fileName);
}

export function initializeWithPOSCAR(structure, fileName) {
  const container = new StructureContainer({
    fileName: fileName,
    structures: [structure],
  });

  return initializeUIOnLoad(container);
}





// export async function parseCIF(content) {
//   const result = parseCifFallback(content);
//   return result;
// }
//




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
      <textarea id="structureText" placeholder="Paste POSCAR/CIF content, an OPTIMADE structure URL, or an Alexandria agm-id"></textarea>
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

  const optimadeWarningDialog = document.createElement('dialog');
  optimadeWarningDialog.id = 'optimadeWarningDialog';
  optimadeWarningDialog.setAttribute('aria-labelledby', 'optimadeWarningTitle');
  optimadeWarningDialog.innerHTML = `
    <h2 id="optimadeWarningTitle">Structure could not be loaded</h2>
    <p>The provider's CORS policy blocks browser access. Download the structure and use Upload instead.</p>
    <button type="button" id="optimadeWarningClose">OK</button>
  `;
  document.body.appendChild(optimadeWarningDialog);
  const optimadeWarningClose = optimadeWarningDialog.querySelector('#optimadeWarningClose');
  let optimadeWarningTimer = null;

  function closeOptimadeWarning() {
    if (optimadeWarningTimer !== null) clearTimeout(optimadeWarningTimer);
    optimadeWarningTimer = null;
    if (optimadeWarningDialog.open) optimadeWarningDialog.close();
  }

  function showOptimadeWarning() {
    closeOptimadeWarning();
    optimadeWarningDialog.showModal();
    optimadeWarningTimer = setTimeout(closeOptimadeWarning, 5000);
  }

  optimadeWarningClose?.addEventListener('click', closeOptimadeWarning);

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
      setStatus('Paste POSCAR, CIF, an OPTIMADE structure URL, or an Alexandria agm-id before loading.');
      structureText.focus({ preventScroll: true });
      return;
    }
    closePasteModal();
    try {
      if (isOptimadeStructureUrl(raw)) {
        setStatus('Fetching structure from OPTIMADE...');
        const result = await fetchOptimadeStructure(raw);
        await onLoadStructure(result.content, result.fileName);
      } else if (normalizeAlexandriaId(raw)) {
        setStatus('Fetching structure from Alexandria...');
        const result = await fetchAlexandriaStructure(raw);
        await onLoadStructure(result.content, result.fileName);
      } else {
        await onLoadStructure(raw, 'pasted');
      }
      structureText.value = '';
    } catch (error) {
      console.warn('Could not load pasted structure:', error);
      if (error?.code === 'OPTIMADE_CORS_OR_NETWORK') {
        showOptimadeWarning();
      } else {
        setStatus(`Error: ${error.message}`);
      }
    }
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
    // Portal the menu to <body> and pin it under the button (position:fixed).
    // Left in the Files dock panel it can't escape that panel's stacking
    // context, so sibling dock panels painted over its lower entries.
    const openDownloadMenu = () => {
      if (downloadMenu.parentElement !== document.body) document.body.appendChild(downloadMenu);
      const r = downloadButton.getBoundingClientRect();
      downloadMenu.style.position = 'fixed';
      downloadMenu.style.top = `${Math.round(r.bottom + 4)}px`;
      downloadMenu.style.left = 'auto';
      downloadMenu.style.right = `${Math.round(window.innerWidth - r.right)}px`;
      downloadMenu.hidden = false;
    };
    const closeDownloadMenu = () => { downloadMenu.hidden = true; };

    downloadButton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (downloadMenu.hidden) openDownloadMenu(); else closeDownloadMenu();
    });
    downloadMenu.addEventListener('click', closeDownloadMenu);
    document.addEventListener('click', (e) => {
      const target = /** @type {Node} */ (e.target);
      if (!downloadMenu.hidden && !downloadButton.contains(target) && !downloadMenu.contains(target)) {
        closeDownloadMenu();
      }
    });
    // A fixed-position menu can't track the button — close it if the layout moves.
    window.addEventListener('resize', closeDownloadMenu);
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
