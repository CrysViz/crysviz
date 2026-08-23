// "Download → Image…" flow: a settings modal (PNG/SVG format, output
// size/aspect ratio, transparency), then either a direct capture or an
// interactive crop overlay (ui/CropOverlay.js) over the live 3D view to pick
// exactly what's exported — WYSIWYG (gizmo, floating color bars, measurements
// exactly as arranged on screen) via render/ImageExportModule.js (PNG) or
// render/SvgExportModule.js (SVG).
//
// One menu entry, one dialog for both formats (the Format select is
// remembered with the other prefs): everything except the "Structure as" row
// applies to both, so a second dialog would just duplicate the size/aspect/
// crop logic.
//
// The settings modal itself closes as soon as the crop overlay opens, so all
// export-in-progress UI (live "Rendering… N / target" text, Abort) lives on
// the crop overlay's own confirm/cancel buttons (ui/CropOverlay.js), driven
// by the capture's onProgress/signal options.

import {
  captureSceneToPng, captureSceneToSvg, computeContentScreenBox,
  estimateVectorPrimitiveCount, lastVectorExportInfo,
} from '../render/index.js';
import { downloadBlob, currentBaseName } from './SavePanel.js';
import { openCropOverlay } from './CropOverlay.js';
import { confirmDialog } from './ConfirmModal.js';
import { closeMobilePanel, isCompactViewport } from './MobileMenu.js';
import { isSideDockActive, setSideDockCollapsed, getSideDockLayout } from './panels/SideDock.js';

const PRESET_ASPECTS = {
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '1:1': 1,
};

const DEFAULT_LONG_EDGE = 3840; // 4K on the long edge by default

// Above this many vector shapes the file stops being pleasant to edit (and
// Inkscape stops being quick to open it), so the export asks first.
const VECTOR_SHAPE_WARN = 20000;

const PNG_NOTE = 'Save exports the whole view; Choose region lets you drag a crop area '
  + 'over the 3D view first.';
const SVG_NOTE = 'Labels, axes and colour bars are editable Inkscape layers; the structure '
  + 'is an embedded image unless you pick Vector shapes.';

// Remembered across sessions so re-opening the dialog restores the last choice.
// The key is unchanged from the PNG-only days: the extra fields are additive,
// and an older stored value simply falls back to PNG.
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
  const trigger = document.getElementById('saveImageButton');
  if (!trigger) {
    console.warn('No element with id "saveImageButton" found.');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'pngExportModal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="png-export-modal" role="dialog" aria-modal="true" aria-label="Download image">
      <h3>Download image</h3>
      <div class="png-row png-row-single">
        <label>Format
          <select id="imgFormat">
            <option value="png">PNG (bitmap)</option>
            <option value="svg">SVG (vector, editable)</option>
          </select>
        </label>
      </div>
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
      <div class="png-row">
        <label class="png-check"><input type="checkbox" id="pngStructureOnly">Frame only structure (not axes, colorbars)</label>
      </div>
      <div class="png-row png-row-single" id="svgStructureRow">
        <label>Structure as
          <select id="svgStructure">
            <option value="raster">Embedded image (recommended)</option>
            <option value="vector">Vector shapes (editable atoms &amp; bonds; large cells get slow)</option>
          </select>
        </label>
      </div>
      <p class="png-note" id="imgExportNote"></p>
      <div class="paste-modal-actions">
        <button type="button" id="pngSaveBtn" class="png-primary">Save</button>
        <button type="button" id="pngDownloadBtn" class="png-primary">Choose region…</button>
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
  const structureOnlyInput = document.getElementById('pngStructureOnly');
  const formatSelect = document.getElementById('imgFormat');
  const svgStructureSelect = document.getElementById('svgStructure');
  const svgStructureRow = document.getElementById('svgStructureRow');
  const noteEl = document.getElementById('imgExportNote');
  const saveBtn = document.getElementById('pngSaveBtn');
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
      margin: Math.max(0, Math.round(Number(marginInput.value) || 0)),
      transparent: transparentInput.checked,
      structureOnly: structureOnlyInput.checked,
      format: formatSelect.value,
      svgStructure: svgStructureSelect.value,
    };
  }

  function isSvg() { return formatSelect.value === 'svg'; }

  function isVectorStructure() { return isSvg() && svgStructureSelect.value === 'vector'; }

  /** Show/hide the SVG-only row and swap the explanatory note. */
  function syncFormat() {
    svgStructureRow.hidden = !isSvg();
    let note = isSvg() ? SVG_NOTE : PNG_NOTE;
    // What the last vector export could not turn into shapes is worth
    // repeating here — the SVG's own <desc> says it too, but nobody reads
    // that before deciding.
    const info = isVectorStructure() ? lastVectorExportInfo() : null;
    if (info && info.skipped.length) {
      note += ` Last vector export left out: ${info.skipped.join('; ')}.`;
    }
    noteEl.textContent = note;
  }

  /** True to go ahead. Vector mode past the shape budget asks first. */
  async function confirmVectorSize() {
    if (!isVectorStructure()) return true;
    let shapes = 0;
    try {
      shapes = estimateVectorPrimitiveCount();
    } catch {
      shapes = 0; // an estimate we can't make is not a reason to block the export
    }
    if (!(shapes > VECTOR_SHAPE_WARN)) return true;
    return confirmDialog(
      `This view needs roughly ${shapes.toLocaleString()} vector shapes. The file will be large `
      + 'and slow to open in an editor — "Embedded image" stays small and still keeps every '
      + 'label editable.',
      { title: 'Large vector export', okLabel: 'Export anyway', cancelLabel: 'Cancel' });
  }

  /** The capture for the selected format. */
  function captureImage(opts) {
    if (!isSvg()) return captureSceneToPng(opts);
    return captureSceneToSvg({ ...opts, structure: svgStructureSelect.value });
  }

  function outputFileName() {
    return currentBaseName() + (isSvg() ? '.svg' : '.png');
  }

  function openModal() {
    const menu = document.getElementById('downloadMenu');
    if (menu) menu.hidden = true;

    const p = loadPrefs();
    formatSelect.value = p.format === 'svg' ? 'svg' : 'png';
    svgStructureSelect.value = p.svgStructure === 'vector' ? 'vector' : 'raster';
    syncFormat();
    const aspect = p.aspect || 'view';
    const free = aspect === 'free';
    aspectSelect.value = aspect;
    // Assigning an unknown value leaves the select on its first option ('view').
    if (aspectSelect.value !== aspect) aspectSelect.value = 'view';
    lockInput.disabled = free;
    lockInput.checked = free ? false : (p.lock !== false);
    marginInput.value = String(p.margin != null ? p.margin : 0);
    transparentInput.checked = !!p.transparent;
    structureOnlyInput.checked = !!p.structureOnly;

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

  formatSelect.addEventListener('change', syncFormat);
  svgStructureSelect.addEventListener('change', syncFormat);

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

  // Set while a direct Save capture runs: repurposes Cancel into Abort and
  // keeps the modal open (mirrors the crop overlay's own busy handling).
  let activeAbort = null;

  function readDims() {
    const width = Math.round(Number(widthInput.value) || 0);
    const height = Math.round(Number(heightInput.value) || 0);
    if (!(width > 0 && height > 0)) {
      alert('Enter a valid width and height.');
      return null;
    }
    return { width, height };
  }

  // "Save": the direct programmatic path — the whole view as-is (plus the
  // scene-border margin), no crop step. Exactly what the Python API's
  // save_image does, exercised from the dialog.
  async function saveDirect() {
    const dims = readDims();
    if (!dims) return;
    const margin = Math.max(0, Math.round(Number(marginInput.value) || 0));
    if (margin * 2 >= dims.width || margin * 2 >= dims.height) {
      alert('Margin is too large for the requested output size.');
      return;
    }
    if (!(await confirmVectorSize())) return;
    savePrefs(currentPrefs());
    saveBtn.disabled = true;
    downloadBtn.disabled = true;
    cancelBtn.textContent = 'Abort';
    saveBtn.textContent = 'Rendering…';
    activeAbort = new AbortController();
    try {
      const blob = await captureImage({
        width: dims.width, height: dims.height, margin,
        transparent: transparentInput.checked,
        structureOnly: structureOnlyInput.checked, signal: activeAbort.signal,
        onProgress: ({ current, target }) => {
          saveBtn.textContent = `Rendering… ${current} / ${target}`;
        },
      });
      downloadBlob(outputFileName(), blob);
      closeModal();
    } catch (e) {
      // Abort is a user action, not an error: stay open, selection intact.
      if (/** @type {any} */ (e)?.name !== 'AbortError') {
        alert(/** @type {any} */ (e)?.message || String(e));
      }
    } finally {
      activeAbort = null;
      saveBtn.disabled = false;
      downloadBtn.disabled = false;
      saveBtn.textContent = 'Save';
      cancelBtn.textContent = 'Cancel';
    }
  }

  // The automatic starting selection for "Choose region": frame the actual
  // content (structure + visible floating overlays), grown to the locked
  // aspect — but only when that box fits the view as it is; otherwise the
  // crop overlay keeps its own default (a centered inset box).
  function autoInitialRect(lockedAspect) {
    const box = computeContentScreenBox({ structureOnly: structureOnlyInput.checked });
    if (!box) return null;
    const view = document.getElementById('view');
    const vw = (view && view.clientWidth) || 0;
    const vh = (view && view.clientHeight) || 0;
    let { width: bw, height: bh } = box;
    if (lockedAspect) {
      if (bw / Math.max(bh, 1) > lockedAspect) bh = bw / lockedAspect;
      else bw = bh * lockedAspect;
    }
    if (!(bw > 0 && bh > 0) || bw > vw || bh > vh) return null;
    // centre the (possibly aspect-grown) box on the content, then shift it
    // fully into the view.
    let left = box.left + (box.width - bw) / 2;
    let top = box.top + (box.height - bh) / 2;
    left = Math.min(Math.max(left, 0), vw - bw);
    top = Math.min(Math.max(top, 0), vh - bh);
    return { left, top, width: bw, height: bh };
  }

  async function chooseArea() {
    const dims = readDims();
    if (!dims) return;
    if (!(await confirmVectorSize())) return;
    const { width, height } = dims;
    const transparent = transparentInput.checked;
    const structureOnly = structureOnlyInput.checked;
    const free = isFree();
    // Frozen before the modal closes: the crop overlay's confirm runs much
    // later, and the dialog's selects are free to change (or be reopened at
    // another format) in the meantime.
    const svg = isSvg();
    const structure = svgStructureSelect.value;
    const capture = (opts) => (svg
      ? captureSceneToSvg({ ...opts, structure })
      : captureSceneToPng(opts));
    const extension = svg ? '.svg' : '.png';
    closeModal();

    // On a compact viewport the panel sheet and the side dock cover most of
    // the view being framed, so fold them away for the selection. The dock is
    // put back the way it was once the overlay closes; the panel sheet isn't,
    // since reopening it is one tap and it would cover the result.
    let restoreDock = null;
    if (isCompactViewport()) {
      closeMobilePanel();
      if (isSideDockActive() && !getSideDockLayout().collapsed) {
        setSideDockCollapsed(true);
        restoreDock = () => setSideDockCollapsed(false);
      }
    }

    openCropOverlay({
      // The initial crop shape: the exact width/height ratio (Free mode fits
      // the view instead). Whether corner drags then PRESERVE that shape is
      // the Lock aspect toggle, carried into the overlay's own toolbar from
      // this dialog's checkbox and persisted back from there — unlocked,
      // the crop resizes to whatever shape the user wants, and width/
      // height's LARGER edge becomes the output's long edge with the other
      // edge derived from the shape actually drawn (see below).
      aspect: free ? null : width / height,
      initial: autoInitialRect(lockInput.checked && !free ? width / height : null),
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
        const blob = await capture({
          width: outWidth, height: outHeight, transparent, structureOnly, crop, signal, onProgress,
        });
        downloadBlob(currentBaseName() + extension, blob);
        restoreDock?.();
      },
      onCancel: () => { restoreDock?.(); },
    });
  }

  trigger.addEventListener('click', () => openModal());
  cancelBtn.addEventListener('click', () => {
    // While a Save capture runs, Cancel is "Abort": cancel it, stay open.
    if (activeAbort) { activeAbort.abort(); return; }
    closeModal();
  });
  saveBtn.addEventListener('click', saveDirect);
  downloadBtn.addEventListener('click', chooseArea);
  modal.addEventListener('click', (e) => {
    if (e.target === modal && !activeAbort) closeModal(); // backdrop click
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !activeAbort) closeModal();
  });
}
