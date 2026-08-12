// "Download → PNG Image…" flow: a settings modal (output size/aspect ratio,
// transparency), then an interactive crop overlay
// (ui/CropOverlay.js) over the live 3D view to pick exactly what's exported
// — a high-resolution PNG via render/ImageExportModule.js, WYSIWYG (gizmo,
// floating color bars, measurements exactly as arranged on screen).
//
// The settings modal itself closes as soon as the crop overlay opens, so all
// export-in-progress UI (live "Rendering… N / target" text, Abort) lives on
// the crop overlay's own confirm/cancel buttons (ui/CropOverlay.js), driven
// by captureSceneToPng's onProgress/signal options.

import { captureSceneToPng } from '../render/index.js';
import { downloadBlob, currentBaseName } from './SavePanel.js';
import { openCropOverlay } from './CropOverlay.js';

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
        <label class="png-check"><input type="checkbox" id="pngTransparent">Transparent background</label>
      </div>
      <p class="png-note">Next, drag the crop area over the 3D view to choose exactly what's exported — the scene, the gizmo, and any floating color bars, right where they're currently arranged.</p>
      <div class="paste-modal-actions">
        <button type="button" id="pngDownloadBtn">Choose area…</button>
        <button type="button" id="pngCancelBtn">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const widthInput = document.getElementById('pngWidth');
  const heightInput = document.getElementById('pngHeight');
  const aspectSelect = document.getElementById('pngAspect');
  const lockInput = document.getElementById('pngLock');
  const transparentInput = document.getElementById('pngTransparent');
  const downloadBtn = document.getElementById('pngDownloadBtn');
  const cancelBtn = document.getElementById('pngCancelBtn');

  // aspectRatio is the enforced ratio while an explicit preset/view is chosen;
  // it is ignored in "free" mode (edit both dimensions independently).
  let aspectRatio = viewAspect();

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

  function chooseArea() {
    const width = Math.round(Number(widthInput.value) || 0);
    const height = Math.round(Number(heightInput.value) || 0);
    if (!(width > 0 && height > 0)) {
      alert('Enter a valid width and height.');
      return;
    }
    const transparent = transparentInput.checked;
    const free = isFree();
    closeModal();

    openCropOverlay({
      // The initial crop shape: the exact width/height ratio (Free mode fits
      // the view instead). Whether corner drags then PRESERVE that shape is
      // the Lock aspect toggle, carried into the overlay's own toolbar from
      // this dialog's checkbox and persisted back from there — unlocked,
      // the crop resizes to whatever shape the user wants, and width/
      // height's LARGER edge becomes the output's long edge with the other
      // edge derived from the shape actually drawn (see below).
      aspect: free ? null : width / height,
      locked: lockInput.checked,
      onLockChange: (locked) => savePrefs({ ...loadPrefs(), lock: locked }),
      // Tracer pipelines render to full convergence inside captureSceneToPng
      // (paced tiled rendering). onConfirm receives {signal, onProgress} from
      // the overlay's own confirm button — signal lets its Abort cancel the
      // capture mid-render, onProgress drives its live "Rendering… N / target"
      // text (ui/CropOverlay.js owns that UI; the settings modal is already
      // closed by the time this runs).
      onConfirm: async (crop, { signal, onProgress }) => {
        let outWidth = width;
        let outHeight = height;
        // A crop drawn at a different shape than width x height — Free mode,
        // or corners dragged with the overlay's Lock aspect toggle off —
        // must not be squeezed into the typed dimensions: keep their long
        // edge, derive the other side from the shape actually drawn. A crop
        // still at the dialog ratio keeps the exact typed dimensions.
        const target = width / height;
        if (Math.abs(crop.aspect - target) > target * 0.005) {
          const longEdge = Math.max(width, height);
          if (crop.aspect >= 1) {
            outWidth = Math.round(longEdge);
            outHeight = Math.round(longEdge / crop.aspect);
          } else {
            outHeight = Math.round(longEdge);
            outWidth = Math.round(longEdge * crop.aspect);
          }
        }
        const blob = await captureSceneToPng({
          width: outWidth, height: outHeight, transparent, crop, signal, onProgress,
        });
        downloadBlob(currentBaseName() + '.png', blob);
      },
      onCancel: () => {},
    });
  }

  trigger.addEventListener('click', openModal);
  cancelBtn.addEventListener('click', closeModal);
  downloadBtn.addEventListener('click', chooseArea);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(); // backdrop click
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}
