// Interactive, iOS-Photos-style crop selector over the live 3D view
// (#view): a draggable/resizable rectangle — locked to a chosen aspect
// ratio, or freeform — with the area outside it dimmed. Used by
// ui/ImageExportPanel.js right before rendering the PNG export
// (render/ImageExportModule.js), so the exported region is whatever the
// user frames here (scene, gizmo, color bars all exactly as arranged on
// screen) rather than an auto-detected content box.

const MIN_SIZE = 40; // px, floor so the rect can't be dragged to nothing

function currentViewRect() {
  const view = document.getElementById('view');
  if (!view) return null;
  const r = view.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * @param {{aspect: number|null,
 *   onConfirm: (crop: {x0:number,y0:number,x1:number,y1:number,aspect:number},
 *     opts: {signal: AbortSignal, onProgress: (p:{current:number, target:number})=>void}) => Promise<void>|void,
 *   onCancel: () => void}} opts
 *   aspect: width/height to lock the rect to, or null for freeform resize.
 *   onConfirm receives the chosen area as fractions (0..1) of #view's box,
 *   plus the rect's own on-screen pixel aspect ratio (== the `aspect` opt
 *   when one was given; freeform mode's only way to report what shape the
 *   user actually drew), plus a signal/onProgress pair for a long (tracer)
 *   capture: onProgress drives the confirm button's live "Rendering… N /
 *   target" text, and clicking Cancel while busy (repurposed as "Abort")
 *   fires the signal instead of closing the overlay. The overlay shows the
 *   busy state until the promise settles, and stays open (re-enabled) if it
 *   rejects — with no alert for a user-triggered abort — so the selection
 *   isn't lost.
 */
export function openCropOverlay({ aspect, onConfirm, onCancel }) {
  let vRect = currentViewRect();
  if (!vRect) { onCancel(); return; }

  const overlay = document.createElement('div');
  overlay.className = 'cv-crop-overlay';

  const maskTop = document.createElement('div');
  const maskBottom = document.createElement('div');
  const maskLeft = document.createElement('div');
  const maskRight = document.createElement('div');
  for (const m of [maskTop, maskBottom, maskLeft, maskRight]) {
    m.className = 'cv-crop-mask';
    overlay.appendChild(m);
  }

  const rectEl = document.createElement('div');
  rectEl.className = 'cv-crop-rect';
  const handles = {};
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const h = document.createElement('div');
    h.className = `cv-crop-handle cv-crop-handle-${corner}`;
    handles[corner] = h;
    rectEl.appendChild(h);
  }
  overlay.appendChild(rectEl);

  const toolbar = document.createElement('div');
  toolbar.className = 'cv-crop-toolbar';
  const hint = document.createElement('span');
  hint.className = 'cv-crop-hint';
  hint.textContent = 'Drag to reposition, corners to resize';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'cv-crop-cancel';
  cancelBtn.textContent = 'Cancel';
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'cv-crop-confirm';
  confirmBtn.textContent = 'Download';
  toolbar.appendChild(hint);
  toolbar.appendChild(cancelBtn);
  toolbar.appendChild(confirmBtn);
  overlay.appendChild(toolbar);

  document.body.appendChild(overlay);

  // Rect state in CSS px relative to the overlay (== relative to #view).
  function initialRect() {
    const inset = Math.min(vRect.width, vRect.height) * 0.08;
    let w = vRect.width - inset * 2;
    let h = vRect.height - inset * 2;
    if (aspect) {
      if (w / h > aspect) w = h * aspect; else h = w / aspect;
    }
    return { left: (vRect.width - w) / 2, top: (vRect.height - h) / 2, width: w, height: h };
  }
  let rect = initialRect();

  function clampRect(r) {
    let { left, top, width, height } = r;
    width = Math.min(width, vRect.width);
    height = Math.min(height, vRect.height);
    left = Math.min(Math.max(left, 0), vRect.width - width);
    top = Math.min(Math.max(top, 0), vRect.height - height);
    return { left, top, width, height };
  }

  function positionOverlay() {
    overlay.style.left = `${vRect.left}px`;
    overlay.style.top = `${vRect.top}px`;
    overlay.style.width = `${vRect.width}px`;
    overlay.style.height = `${vRect.height}px`;
  }

  function render() {
    rectEl.style.left = `${rect.left}px`;
    rectEl.style.top = `${rect.top}px`;
    rectEl.style.width = `${rect.width}px`;
    rectEl.style.height = `${rect.height}px`;

    maskTop.style.left = '0';
    maskTop.style.top = '0';
    maskTop.style.width = '100%';
    maskTop.style.height = `${rect.top}px`;

    maskBottom.style.left = '0';
    maskBottom.style.top = `${rect.top + rect.height}px`;
    maskBottom.style.width = '100%';
    maskBottom.style.height = `${Math.max(0, vRect.height - (rect.top + rect.height))}px`;

    maskLeft.style.left = '0';
    maskLeft.style.top = `${rect.top}px`;
    maskLeft.style.width = `${rect.left}px`;
    maskLeft.style.height = `${rect.height}px`;

    maskRight.style.left = `${rect.left + rect.width}px`;
    maskRight.style.top = `${rect.top}px`;
    maskRight.style.width = `${Math.max(0, vRect.width - (rect.left + rect.width))}px`;
    maskRight.style.height = `${rect.height}px`;

    // Toolbar sits just under the rect, or above it if there's no room below.
    const belowSpace = vRect.height - (rect.top + rect.height);
    if (belowSpace > 60) {
      toolbar.style.top = `${rect.top + rect.height + 10}px`;
      toolbar.style.bottom = '';
    } else {
      toolbar.style.top = '';
      toolbar.style.bottom = `${vRect.height - rect.top + 10}px`;
    }
    toolbar.style.left = `${rect.left + rect.width / 2}px`;
  }
  positionOverlay();
  render();

  // --- Drag the whole rect to reposition ---
  rectEl.addEventListener('pointerdown', (e) => {
    if (e.target !== rectEl) return; // a handle's own listener owns those
    e.preventDefault();
    rectEl.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = { ...rect };
    const onMove = (mv) => {
      rect = clampRect({
        ...startRect,
        left: startRect.left + (mv.clientX - startX),
        top: startRect.top + (mv.clientY - startY),
      });
      render();
    };
    const onUp = () => {
      rectEl.removeEventListener('pointermove', onMove);
      rectEl.removeEventListener('pointerup', onUp);
    };
    rectEl.addEventListener('pointermove', onMove);
    rectEl.addEventListener('pointerup', onUp);
  });

  // --- Resize from a corner, anchored at the opposite corner ---
  const OPPOSITE = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' };
  function cornerPoint(r, corner) {
    return {
      x: corner.includes('w') ? r.left : r.left + r.width,
      y: corner.includes('n') ? r.top : r.top + r.height,
    };
  }
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    handles[corner].addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handles[corner].setPointerCapture(e.pointerId);
      const anchor = cornerPoint(rect, OPPOSITE[corner]);
      const onMove = (mv) => {
        const x = Math.min(Math.max(mv.clientX - vRect.left, 0), vRect.width);
        const y = Math.min(Math.max(mv.clientY - vRect.top, 0), vRect.height);
        let w = Math.abs(x - anchor.x);
        let h = Math.abs(y - anchor.y);
        if (aspect) {
          if (w / Math.max(h, 1) > aspect) h = w / aspect; else w = h * aspect;
        }
        w = Math.max(w, MIN_SIZE);
        h = Math.max(h, aspect ? MIN_SIZE / aspect : MIN_SIZE);
        const left = corner.includes('w') ? anchor.x - w : anchor.x;
        const top = corner.includes('n') ? anchor.y - h : anchor.y;
        rect = clampRect({ left, top, width: w, height: h });
        render();
      };
      const onUp = () => {
        handles[corner].removeEventListener('pointermove', onMove);
        handles[corner].removeEventListener('pointerup', onUp);
      };
      handles[corner].addEventListener('pointermove', onMove);
      handles[corner].addEventListener('pointerup', onUp);
    });
  }

  function toFractionCrop() {
    return {
      x0: rect.left / vRect.width,
      y0: rect.top / vRect.height,
      x1: (rect.left + rect.width) / vRect.width,
      y1: (rect.top + rect.height) / vRect.height,
      // The rect's own on-screen pixel aspect — always equal to the `aspect`
      // opt when one was given, but freeform mode (aspect: null) has no
      // other way to tell the caller what shape the user actually drew.
      aspect: rect.width / rect.height,
    };
  }

  function close() {
    window.removeEventListener('resize', onViewResize);
    resizeObserver?.disconnect();
    overlay.remove();
  }

  // Set while a capture is in flight: repurposes Cancel into Abort (below)
  // and gates the Escape handler, same as the settings modal does while busy.
  let abortController = null;

  confirmBtn.addEventListener('click', async () => {
    const crop = toFractionCrop();
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Rendering…';
    cancelBtn.textContent = 'Abort';
    abortController = new AbortController();
    try {
      // Awaited so the overlay (and the user's crop selection) stays put
      // until the export actually finishes — captureSceneToPng can take a
      // while on tracer pipelines, and closing early would both lose the
      // selection on failure and hide that anything was still happening.
      await onConfirm(crop, {
        signal: abortController.signal,
        onProgress: ({ current, target }) => {
          confirmBtn.textContent = `Rendering… ${current} / ${target}`;
        },
      });
      close();
    } catch (e) {
      // Abort is a user action, not an error: swallow it silently and leave
      // the overlay open with the selection intact (the live view is already
      // restored by captureSceneToPng's finally). Any other failure alerts.
      if (/** @type {any} */ (e)?.name !== 'AbortError') {
        alert(/** @type {any} */ (e)?.message || String(e));
      }
    } finally {
      abortController = null;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Download';
      cancelBtn.textContent = 'Cancel';
    }
  });
  cancelBtn.addEventListener('click', () => {
    // While a capture is running, Cancel is "Abort": cancel it and keep the
    // overlay open. Otherwise it closes the overlay as before.
    if (abortController) { abortController.abort(); return; }
    close();
    onCancel();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (abortController) return; // ignore Escape while a capture is running
      close();
      onCancel();
    }
  });

  // Keep the overlay + rect tracking #view if it resizes mid-selection (side
  // panel toggled, browser window resized) — rescales the rect
  // proportionally so its relative framing survives instead of resetting.
  function onViewResize() {
    const next = currentViewRect();
    if (!next) return;
    const sx = next.width / vRect.width;
    const sy = next.height / vRect.height;
    rect = { left: rect.left * sx, top: rect.top * sy, width: rect.width * sx, height: rect.height * sy };
    vRect = next;
    positionOverlay();
    rect = clampRect(rect);
    render();
  }
  window.addEventListener('resize', onViewResize);
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onViewResize) : null;
  const viewEl = document.getElementById('view');
  if (viewEl && resizeObserver) resizeObserver.observe(viewEl);

  overlay.tabIndex = -1;
  overlay.focus();
}
