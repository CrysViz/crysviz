// "Download → PNG Image…" modal: pick output dimensions (with an aspect-ratio
// helper), margins and transparency, then export a high-resolution PNG of the
// scene via render/ImageExportModule.js.
//
// While a (tracer) export runs, the Download button shows live "Rendering… N /
// target" progress and the modal is LOCKED: backdrop-click and Escape no longer
// dismiss it, and the Cancel button becomes "Abort", which cancels the capture
// (via an AbortController signal) and leaves the modal open with the live view
// intact. The click yields two animation frames before starting so the button
// state repaints instantly.

import { captureSceneToPng } from '../render/index.js';
import { downloadBlob, currentBaseName } from './SavePanel.js';

const PRESET_ASPECTS = {
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '1:1': 1,
};

const DEFAULT_LONG_EDGE = 3840; // 4K on the long edge by default

// Remembered across sessions so re-opening the dialog restores the last choice.
const PREFS_KEY = 'crysviz.pngExportPrefs.v1';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; }
  catch { return {}; }
}

function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
  catch { /* storage unavailable */ }
}

function viewAspect() {
  const v = document.getElementById('view');
  const w = (v && v.clientWidth) || 16;
  const h = (v && v.clientHeight) || 9;
  return w / h;
}

export function initImageExportPanel() {
  const trigger = document.getElementById('savePngButton');
  if (!trigger) {
    console.warn('No element with id "savePngButton" found.');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'pngExportModal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="png-export-modal" role="dialog" aria-modal="true" aria-label="Download PNG image">
      <h3>Download PNG image</h3>
      <div class="png-row">
        <label>Width<input type="number" id="pngWidth" min="16" max="16384" step="1"></label>
        <label>Height<input type="number" id="pngHeight" min="16" max="16384" step="1"></label>
      </div>
      <div class="png-row">
        <label>Aspect ratio
          <select id="pngAspect">
            <option value="view">Current view</option>
            <option value="16:9">16:9</option>
            <option value="4:3">4:3</option>
            <option value="3:2">3:2</option>
            <option value="1:1">1:1</option>
            <option value="free">Free</option>
          </select>
        </label>
        <label class="png-check"><input type="checkbox" id="pngLock" checked>Lock aspect</label>
      </div>
      <div class="png-row">
        <label>Margin (px)<input type="number" id="pngMargin" min="0" max="4096" step="1" value="0"></label>
        <label class="png-check"><input type="checkbox" id="pngTransparent">Transparent background</label>
      </div>
      <p class="png-note">The image is auto-framed to the visible structure. Floating panels are excluded; the axis gizmo and measurements are included.</p>
      <div class="paste-modal-actions">
        <button type="button" id="pngDownloadBtn">Download</button>
        <button type="button" id="pngCancelBtn">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const widthInput = document.getElementById('pngWidth');
  const heightInput = document.getElementById('pngHeight');
  const aspectSelect = document.getElementById('pngAspect');
  const lockInput = document.getElementById('pngLock');
  const marginInput = document.getElementById('pngMargin');
  const transparentInput = document.getElementById('pngTransparent');
  const downloadBtn = document.getElementById('pngDownloadBtn');
  const cancelBtn = document.getElementById('pngCancelBtn');

  // aspectRatio is the enforced ratio while an explicit preset/view is chosen;
  // it is ignored in "free" mode (edit both dimensions independently).
  let aspectRatio = viewAspect();

  // Export-in-progress state. While busy the modal must NOT close on a backdrop
  // click or Escape (the render keeps going invisibly otherwise); the Cancel
  // button becomes "Abort" and cancels the in-flight capture via the signal.
  let busy = false;
  let abortController = null;

  function isFree() { return aspectSelect.value === 'free'; }

  function fillFromAspect(longEdge) {
    if (aspectRatio >= 1) {
      widthInput.value = String(Math.round(longEdge));
      heightInput.value = String(Math.round(longEdge / aspectRatio));
    } else {
      heightInput.value = String(Math.round(longEdge));
      widthInput.value = String(Math.round(longEdge * aspectRatio));
    }
  }

  function currentPrefs() {
    return {
      aspect: aspectSelect.value,
      lock: lockInput.checked,
      width: Math.round(Number(widthInput.value) || 0),
      height: Math.round(Number(heightInput.value) || 0),
      margin: Math.max(0, Math.round(Number(marginInput.value) || 0)),
      transparent: transparentInput.checked,
    };
  }

  function openModal() {
    const menu = document.getElementById('downloadMenu');
    if (menu) menu.hidden = true;

    const p = loadPrefs();
    const aspect = p.aspect || 'view';
    const free = aspect === 'free';
    aspectSelect.value = aspect;
    // Assigning an unknown value leaves the select on its first option ('view').
    if (aspectSelect.value !== aspect) aspectSelect.value = 'view';
    lockInput.disabled = free;
    lockInput.checked = free ? false : (p.lock !== false);
    marginInput.value = String(p.margin != null ? p.margin : 0);
    transparentInput.checked = !!p.transparent;

    const longEdge = Math.max(Number(p.width) || 0, Number(p.height) || 0) || DEFAULT_LONG_EDGE;
    if (aspectSelect.value === 'free') {
      widthInput.value = String(Math.round(Number(p.width) || DEFAULT_LONG_EDGE));
      heightInput.value = String(Math.round(Number(p.height) || Math.round(DEFAULT_LONG_EDGE * 9 / 16)));
    } else if (aspectSelect.value === 'view') {
      aspectRatio = viewAspect();
      fillFromAspect(longEdge);
    } else {
      aspectRatio = PRESET_ASPECTS[aspectSelect.value] || 1;
      fillFromAspect(longEdge);
    }
    modal.hidden = false;
  }

  function closeModal() {
    savePrefs(currentPrefs());
    modal.hidden = true;
  }

  aspectSelect.addEventListener('change', () => {
    if (isFree()) {
      lockInput.checked = false;
      lockInput.disabled = true;
      return;
    }
    lockInput.disabled = false;
    lockInput.checked = true;
    aspectRatio = aspectSelect.value === 'view'
      ? viewAspect()
      : (PRESET_ASPECTS[aspectSelect.value] || 1);
    const longEdge = Math.max(Number(widthInput.value) || 0, Number(heightInput.value) || 0) || DEFAULT_LONG_EDGE;
    fillFromAspect(longEdge);
  });

  widthInput.addEventListener('input', () => {
    if (lockInput.checked && !isFree()) {
      const w = Number(widthInput.value) || 0;
      if (w > 0) heightInput.value = String(Math.round(w / aspectRatio));
    }
  });
  heightInput.addEventListener('input', () => {
    if (lockInput.checked && !isFree()) {
      const h = Number(heightInput.value) || 0;
      if (h > 0) widthInput.value = String(Math.round(h * aspectRatio));
    }
  });

  async function doDownload() {
    const width = Math.round(Number(widthInput.value) || 0);
    const height = Math.round(Number(heightInput.value) || 0);
    const margin = Math.max(0, Math.round(Number(marginInput.value) || 0));
    if (!(width > 0 && height > 0)) {
      alert('Enter a valid width and height.');
      return;
    }
    busy = true;
    abortController = new AbortController();
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Rendering…';
    cancelBtn.textContent = 'Abort'; // repurpose Cancel -> Abort while rendering
    // Yield two frames so the 'Rendering…' label (and the disabled state)
    // actually paint BEFORE the synchronous-until-its-first-await capture work
    // begins — the click must feel instant even for a long tracer export.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      // Tracer pipelines render to full convergence inside captureSceneToPng
      // (paced tiled rendering; the on-screen progress bar + this button both
      // track the accumulation). Raster pipelines never emit progress (the loop
      // is skipped), so the text stays 'Rendering…'. opts.signal lets Abort
      // cancel mid-render.
      const blob = await captureSceneToPng({
        width, height, margin, transparent: transparentInput.checked,
        signal: abortController.signal,
        onProgress: ({ current, target }) => {
          downloadBtn.textContent = `Rendering… ${current} / ${target}`;
        },
      });
      downloadBlob(currentBaseName() + '.png', blob);
      closeModal();
    } catch (e) {
      // Abort is a user action, not an error: swallow it silently and leave the
      // modal open (the live view is already restored by captureSceneToPng's
      // finally). Any other failure is surfaced.
      if (/** @type {any} */ (e)?.name !== 'AbortError') {
        alert(/** @type {any} */ (e)?.message || String(e));
      }
    } finally {
      busy = false;
      abortController = null;
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'Download';
      cancelBtn.textContent = 'Cancel';
    }
  }

  trigger.addEventListener('click', openModal);
  cancelBtn.addEventListener('click', () => {
    // While an export is running, Cancel is "Abort": cancel the capture and keep
    // the modal open. Otherwise it closes the dialog as before.
    if (busy) { abortController?.abort(); return; }
    closeModal();
  });
  downloadBtn.addEventListener('click', doDownload);
  modal.addEventListener('click', (e) => {
    if (busy) return; // don't dismiss a running export on a backdrop click
    if (e.target === modal) closeModal(); // backdrop click
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !busy) closeModal(); // Escape ignored while busy
  });
}
