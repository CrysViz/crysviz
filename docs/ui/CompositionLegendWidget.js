// Composition Display: a movable legend mapping each atom colour in the scene
// to its element — one row per distinct site kind, a 3D sphere swatch plus a
// label. Meant to be dropped next to the structure for figure-making, so the
// swatches don't approximate the atoms: they are rendered with the SAME
// material factory (MaterialStyles.createStyledMaterial + getAtomVisSettings),
// lighting rig and renderer colour pipeline as the main view (the
// PolyhedronMiniRenderer precedent), and a disordered site's swatch is built
// from wedgeDataForAtom's own slots — the exact colours and occupancy
// fractions the wedge shader draws — with the fractions written under the
// label.
//
// It is a SCENE WIDGET, not a panel window: the same float/dock/resize
// machinery the colour bars use (ui/ColorBarDrag.js), so it drags around the
// view anchored to #view's edges, survives the view resizing under it, and
// uses a long-press menu plus corner resize handle. Dragging
// it off the scene puts it away; ❖ in the Structure Info header brings it
// back. It was a PanelWindow before — a title bar and a dock slot are chrome
// for a thing that only ever wants to sit over the structure.
//
// Figure-making affordances: every label is contenteditable (edits survive
// refreshes for the session), the box resizes from its corner and its contents
// scale with the width, and the long-press menu offers a transparent mode that strips
// the surface so only swatches and text overlay the scene.
//
// One shared offscreen WebGL renderer paints every swatch and each row keeps
// only a 2D canvas copy: N rows cost one GL context, torn down when the legend
// closes. Rows refresh on 'crysviz:colors-changed' / 'crysviz:atoms-changed'
// (recolours, occupancy edits, render-style switches) and on the Structure
// Info panel's own re-render (refreshCompositionLegend), so a structure switch
// rebuilds them.

import * as THREE from '../external/three/three.module.js';
import { getPanelPref, setPanelPref } from './panels/PanelManager.js';
import { makeColorBarDraggable } from './ColorBarDrag.js';
import { wireLongPress } from '../utils/index.js';
import { currentContrastColor } from './ColorBarWidget.js';
import { createStyledMaterial } from '../render/MaterialStyles.js';
import { getAtomVisSettings } from '../defaults/color_texture_defaults.js';
import { wedgeDataForAtom } from '../render/WedgeAtoms.js';
import { fileBrowser } from '../state/store.js';

const FLOATING_ID = 'compositionLegendFloating';
const SWATCH_PX = 30;   // on-screen swatch size at scale 1
const RENDER_PX = 256;  // offscreen render size — headroom for scaled-up boxes
const MAX_RENDER_PX = 1024; // ceiling when the PNG export asks for more
// Opens legible at figure size rather than at whatever is smallest — the
// legend is meant to be read next to the structure, and it's easier to drag
// smaller than to notice it could be bigger.
const DEFAULT_SCALE = 1.5;
const MIN_SCALE = 0.6;
const MAX_SCALE = 5;

// ---- shared swatch renderer -------------------------------------------------

/** @type {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, size: number } | null} */
let gl = null;

/** What each live swatch canvas was painted from, so the PNG export can
 *  repaint it at the output's resolution instead of upscaling a 30px sphere. */
/** @type {WeakMap<HTMLCanvasElement, Array<{color: number, fraction: number}>>} */
const swatchSlices = new WeakMap();

/** The one offscreen renderer, grown (never shrunk) to whatever the largest
 *  swatch asked for — the PNG export repaints at its own output resolution,
 *  which is normally well past RENDER_PX. */
function ensureGL(px = RENDER_PX) {
  if (gl) {
    const want = Math.min(MAX_RENDER_PX, Math.max(RENDER_PX, Math.ceil(px)));
    if (want > gl.size) {
      gl.renderer.setSize(want, want, false);
      gl.size = want;
    }
    return gl;
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
  camera.position.set(0, 0, 4.2);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  // Same colour pipeline as the main viewer — without it the swatches read
  // flat next to the scene even with identical materials (see the same note
  // in PolyhedronMiniRenderer.js).
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  const size = Math.min(MAX_RENDER_PX, Math.max(RENDER_PX, Math.ceil(px)));
  renderer.setSize(size, size, false);

  // Main-view lighting rig: soft ambient fill + one strong key light parked
  // upper-front-right of the camera (static here — the swatch never orbits).
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 5.0);
  keyLight.position.copy(camera.position).add(new THREE.Vector3(3, 4, 3));
  scene.add(keyLight);
  scene.add(keyLight.target);

  gl = { renderer, scene, camera, size };
  return gl;
}

function disposeGL() {
  if (!gl) return;
  gl.renderer.dispose();
  gl = null;
}

/**
 * Paint a sphere swatch into `canvas`. Multiple slices become longitude
 * wedges (SphereGeometry phiStart/phiLength) in the slice order the wedge
 * shader uses; together they always span the full sphere, so there are no
 * open shells to see into.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{color: number, fraction: number}>} slices
 */
function renderSwatchInto(canvas, slices) {
  swatchSlices.set(canvas, slices);
  const { renderer, scene, camera } = ensureGL(canvas.width);
  const group = new THREE.Group();
  let phi = 0;
  for (const s of slices) {
    const span = Math.max(s.fraction, 0.002) * Math.PI * 2;
    const geometry = new THREE.SphereGeometry(1, 48, 32, phi, span);
    const material = createStyledMaterial({ ...getAtomVisSettings(1.0), color: s.color });
    group.add(new THREE.Mesh(geometry, material));
    phi += span;
  }
  // Put the boundary between the first two wedges at the front-centre
  // meridian: the dominant slice fills the right half of the swatch and the
  // rest share the left, so every slice is visible. (SphereGeometry's phi=p
  // faces the +Z camera when p + rotation.y = π/2.)
  const firstSpan = Math.max(slices[0]?.fraction ?? 1, 0.002) * Math.PI * 2;
  group.rotation.y = Math.PI / 2 - firstSpan;
  scene.add(group);
  renderer.render(scene, camera);

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);

  scene.remove(group);
  for (const mesh of group.children) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

/**
 * Repaint every swatch with a `px`-square backing store, for the PNG export
 * (render/ImageExportModule.js), and return a restore(). Only the backing
 * store changes — CSS fixes the displayed size — so nothing moves on screen;
 * without it a figure exported at 4K gets the 30px on-screen sphere upscaled.
 * @param {number} px
 * @returns {() => void}
 */
export function repaintSwatchesForExport(px) {
  /** @type {Array<{canvas: HTMLCanvasElement, w: number, h: number}>} */
  const previous = [];
  const size = Math.min(MAX_RENDER_PX, Math.max(8, Math.round(px)));
  for (const canvas of document.querySelectorAll('.comp-legend-swatch')) {
    const el = /** @type {HTMLCanvasElement} */ (canvas);
    const slices = swatchSlices.get(el);
    if (!slices || el.width >= size) continue;
    previous.push({ canvas: el, w: el.width, h: el.height });
    el.width = size;
    el.height = size;
    renderSwatchInto(el, slices);
  }
  return () => {
    for (const { canvas, w, h } of previous) {
      canvas.width = w;
      canvas.height = h;
      renderSwatchInto(canvas, swatchSlices.get(canvas) ?? []);
    }
  };
}

// ---- legend data ------------------------------------------------------------

/**
 * One entry per distinct site kind: ordered elements keyed by element+colour
 * (a custom-recoloured element gets its own row), disordered sites keyed by
 * their full slice signature so two different (K,Na) splits stay two rows.
 * @returns {Array<{key: string, label: string, sub: string | null, slices: Array<{color: number, fraction: number}>}>}
 */
function collectEntries(structure) {
  const entries = new Map();
  const atoms = structure?.atoms ?? [];
  const elements = structure?.elements ?? [];
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    const wedge = wedgeDataForAtom(atom);
    if (wedge?.slots?.length) {
      const total = wedge.slots.reduce((sum, s) => sum + s.occupancy, 0) || 1;
      const slices = wedge.slots.map((s) => ({
        color: s.color,
        fraction: s.occupancy / total,
        element: s.element,
      }));
      const key = `site:${slices.map((s) => `${s.element}:${s.fraction.toFixed(3)}:${s.color}`).join('|')}`;
      if (!entries.has(key)) {
        entries.set(key, {
          key,
          label: `(${slices.map((s) => s.element).join(', ')})`,
          sub: slices.map((s) => `${s.element} ${(s.fraction * 100).toFixed(0)}%`).join(' · '),
          slices,
        });
      }
    } else {
      const el = elements[i] ?? atom?.species?.[0]?.element ?? '?';
      const color = typeof atom?.getColor === 'function' ? atom.getColor() : 0x808080;
      const key = `el:${el}:${color}`;
      if (!entries.has(key)) {
        // Just the symbol: a figure legend reads "Si", not "Si Atom" — and
        // the label is editable if a caption wants more than that.
        entries.set(key, { key, label: el, sub: null, slices: [{ color, fraction: 1 }] });
      }
    }
  }
  return [...entries.values()];
}

// ---- widget -----------------------------------------------------------------

/** The one live legend, or null while it's put away. */
/** @type {{ wrapper: HTMLElement, body: HTMLElement, list: HTMLElement, drag: ReturnType<typeof makeColorBarDraggable>, refresh: () => void, destroy: () => void } | null} */
let widget = null;
/** Session-only user text overrides, keyed by entry key — they survive
 *  refreshes and structure round-trips within the session, and reset with it
 *  (labels are structure-specific; persisting them globally would bleed one
 *  structure's edits into another). */
const customText = new Map();
/** Remembered scale and place, so putting the legend away and bringing it back
 *  keeps the user's figure layout for the session. The box's own size isn't
 *  remembered because it isn't chosen — it is whatever the rows need at the
 *  current scale (see wireResize). The anchor is ColorBarDrag's own
 *  #view-relative one, not page pixels — see floatAtAnchor. */
let legendScale = null;
let lastAnchor = null;

const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** contenteditable wiring: Enter commits, blur saves; clearing the text (or
 *  retyping the default) drops the override. */
function wireEditable(el, key, field, defaultText) {
  el.contentEditable = 'true';
  el.spellcheck = false;
  // The body is a drag handle (see extraHandles): without this, pressing on a
  // label starts a window drag and preventDefault()s the click that would
  // have put the caret in it — the same guard ColorBarWidget.js's Min/Max
  // inputs use against the gradient bar's own drag handle.
  el.addEventListener('pointerdown', (event) => event.stopPropagation());
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      el.blur();
    }
  });
  el.addEventListener('blur', () => {
    const text = el.textContent.trim();
    const overrides = customText.get(key) ?? {};
    if (!text || text === defaultText) {
      delete overrides[field];
      el.textContent = defaultText;
    } else {
      overrides[field] = text;
    }
    if (Object.keys(overrides).length) customText.set(key, overrides);
    else customText.delete(key);
  });
}

function currentScale(body) {
  const v = parseFloat(getComputedStyle(body).getPropertyValue('--legend-scale'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function renderRows(list) {
  list.innerHTML = '';
  const structure = fileBrowser.selectedStructure;
  const entries = collectEntries(structure);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'comp-legend-empty';
    empty.textContent = 'No structure loaded.';
    list.appendChild(empty);
    return;
  }
  const body = list.closest('.comp-legend-body');
  const scale = body ? currentScale(/** @type {HTMLElement} */ (body)) : 1;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.min(RENDER_PX, Math.max(8, Math.round(SWATCH_PX * scale * dpr)));
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'comp-legend-row';

    const canvas = document.createElement('canvas');
    canvas.className = 'comp-legend-swatch';
    canvas.width = px;
    canvas.height = px;
    renderSwatchInto(canvas, entry.slices);
    row.appendChild(canvas);

    const text = document.createElement('div');
    text.className = 'comp-legend-text';
    const label = document.createElement('div');
    label.className = 'comp-legend-label';
    label.textContent = customText.get(entry.key)?.label ?? entry.label;
    wireEditable(label, entry.key, 'label', entry.label);
    text.appendChild(label);
    if (entry.sub) {
      const sub = document.createElement('div');
      sub.className = 'comp-legend-sub';
      sub.textContent = customText.get(entry.key)?.sub ?? entry.sub;
      wireEditable(sub, entry.key, 'sub', entry.sub);
      text.appendChild(sub);
    }
    row.appendChild(text);
    list.appendChild(row);
  }
}

// The wrapper's `color` is the same contrast-safe colour the floating colour
// bars paint their ticks, frame and handle in (ColorBarWidget's
// currentContrastColor, tracking the live scene background — theme switch,
// colour-picker drag, auto day/night, none of which broadcast a change event,
// hence the poll). The resize frame and handle are currentColor, so they read
// against the scene wherever the legend is parked; the row text only takes it
// in transparent mode (styles/structureInfoPanel.css) — with the surface on,
// the box supplies its own contrast and --fg-1 is already right. That matters
// beyond the screen: the PNG export copies each label's computed colour, so
// this is what keeps the labels visible in a light-background figure.
let contrastRafId = null;
function tickContrast(wrapper) {
  wrapper.style.color = currentContrastColor() || '';
  contrastRafId = requestAnimationFrame(() => tickContrast(wrapper));
}

function stopContrastSync() {
  if (contrastRafId != null) cancelAnimationFrame(contrastRafId);
  contrastRafId = null;
}

/** Strip (or restore) the legend's own surface, leaving only swatches and
 *  text over the scene. */
function applyTransparent(on) {
  setPanelPref('legendTransparent', on);
  widget?.wrapper.classList.toggle('comp-legend-transparent', !!on);
}

/** The dropdown is opened by long press on the legend. */
function buildControls() {
  const menuWrap = document.createElement('div');
  menuWrap.className = 'cv-colorbar-menu-host';
  const menu = document.createElement('div');
  menu.className = 'cv-colorbar-menu';

  const item = (text, onSelect) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cv-colorbar-menu-item';
    button.textContent = text;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      menu.classList.remove('cv-colorbar-menu-open');
      onSelect();
    });
    menu.appendChild(button);
  };

  item('Transparent background', () => applyTransparent(!getPanelPref('legendTransparent')));
  item('Reset text edits', () => {
    customText.clear();
    if (widget) renderRows(widget.list);
  });
  item('Reset size', () => {
    if (!widget) return;
    legendScale = DEFAULT_SCALE;
    widget.body.style.setProperty('--legend-scale', String(DEFAULT_SCALE));
    renderRows(widget.list);
    widget.drag.recaptureAnchor();
  });
  item('Close', () => closeCompositionLegend());

  menuWrap.addEventListener('pointerdown', (event) => event.stopPropagation());
  const onDocumentPointerDown = (event) => {
    if (!menu.classList.contains('cv-colorbar-menu-open')) return;
    if (!menuWrap.contains(/** @type {Node} */ (event.target))) menu.classList.remove('cv-colorbar-menu-open');
  };
  const onDocumentClick = (event) => {
    if (!menu.classList.contains('cv-colorbar-menu-open')) return;
    if (!menuWrap.contains(/** @type {Node} */ (event.target))) menu.classList.remove('cv-colorbar-menu-open');
  };
  const onEscape = (event) => { if (event.key === 'Escape') menu.classList.remove('cv-colorbar-menu-open'); };
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onEscape);

  menuWrap.append(menu);
  return {
    menuWrap,
    menu,
    openAt(x, y) {
      menu.classList.add('cv-colorbar-menu-open');
      const view = document.getElementById('view')?.getBoundingClientRect();
      const rect = menu.getBoundingClientRect();
      const left = view ? Math.min(Math.max(x, view.left + 4), view.right - rect.width - 4) : x;
      const top = view ? Math.min(Math.max(y, view.top + 4), view.bottom - rect.height - 4) : y;
      menuWrap.style.left = `${left}px`;
      menuWrap.style.top = `${top}px`;
    },
    dispose: () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onEscape);
    },
  };
}

/** Resize, mirroring ColorBarWidget's handle: one axis, like the bar's own
 *  length drag. What the drag actually sets is --legend-scale — the box itself
 *  is never sized, it is always exactly what the rows need. Sizing the BOX
 *  instead (the obvious reading of a resize handle) left a legend of two short
 *  symbols sitting in a wide empty rectangle, and could be dragged smaller
 *  than its own text, which only cropped it.
 *
 *  The anchor is deliberately NOT re-derived mid-drag: with the legend parked
 *  nearer #view's right edge the anchor is a right-edge offset, and re-deriving
 *  from it holds that edge still, so the box grew leftwards out from under the
 *  cursor. The wrapper's inline left/top already pin its top-left corner, so
 *  growing does the expected thing; the anchor is re-taken on release, from
 *  wherever it ended up. */
function wireResize(handle, body, drag, redrawRows) {
  let activeAbort = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // never let this reach the wrapper's drag handles
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic events cannot capture */ }
    const startX = e.clientX;
    const startScale = currentScale(body);
    const startW = body.offsetWidth || 1;
    let raf = 0;
    let finished = false;

    const onMove = (mv) => {
      // Proportional to the box's own width, so the far edge tracks the
      // cursor however large the legend already is.
      const scale = clampScale(startScale * ((startW + mv.clientX - startX) / startW));
      body.style.setProperty('--legend-scale', String(scale));
      legendScale = scale;
      // The swatches are canvases: they have to be repainted at the new size
      // or they upscale into mush. One per frame, not one per pointermove.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(redrawRows);
    };
    const cleanup = () => {
      if (finished) return;
      finished = true;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(raf);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (activeAbort === abort) activeAbort = null;
    };
    const onUp = () => {
      cleanup();
      redrawRows();
      drag.recaptureAnchor();
    };
    const abort = (pointerId) => {
      if (pointerId !== undefined && pointerId !== e.pointerId) return;
      if (finished) return;
      cleanup();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    activeAbort = abort;
  });
  return { abortPointer: (pointerId) => activeAbort?.(pointerId) };
}

/** Build the legend and float it over the scene. */
function openCompositionLegend() {
  const wrapper = document.createElement('div');
  wrapper.className = 'comp-legend-widget';

  const { menuWrap, openAt, dispose: disposeControls } = buildControls();

  const body = document.createElement('div');
  body.className = 'comp-legend-body';
  const list = document.createElement('div');
  list.className = 'comp-legend-list';
  body.appendChild(list);
  body.style.setProperty('--legend-scale', String(legendScale ?? DEFAULT_SCALE));

  // The frame shows what the handle is about to resize around the box rather
  // than around a gradient strip and its tick labels.
  const resizeFrame = document.createElement('div');
  resizeFrame.className = 'cv-colorbar-resize-frame';
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'cv-colorbar-resize-handle cv-colorbar-resize-handle-se';
  resizeHandle.title = 'Drag to resize';
  resizeFrame.appendChild(resizeHandle);

  wrapper.append(menuWrap, body, resizeFrame);
  // makeColorBarDraggable reads wrapper.parentElement as the place to put the
  // widget back on a drop outside the scene — an own detached host, since
  // there is no panel to dock into: that drop means "put the legend away",
  // and onFloatChange(false) below finishes the job.
  const host = document.createElement('div');
  host.appendChild(wrapper);

  const drag = makeColorBarDraggable(wrapper, FLOATING_ID, {
    gripParent: null,
    extraHandles: [body],
    onFloatChange: (floating) => {
      if (!floating) { closeCompositionLegend(); return; }
      // beginFloating() pins the measured width inline; the legend keeps
      // shrink-wrapping its rows instead, which every scale change and every
      // structure switch resizes.
      wrapper.style.width = '';
    },
  });

  const refresh = () => {
    // Never rebuild under an in-progress text edit — the next event
    // (or reopen) re-syncs.
    if (list.contains(document.activeElement)) return;
    renderRows(list);
  };
  const resizeController = wireResize(resizeHandle, body, drag, refresh);
  const disposeLongPress = wireLongPress(wrapper, ({ clientX, clientY }) => openAt(clientX, clientY), {
    ignoreSelector: '.cv-colorbar-resize-handle',
    onFire: ({ pointerId }) => {
      drag.abortPointer(pointerId);
      resizeController.abortPointer(pointerId);
    },
  });
  document.addEventListener('crysviz:colors-changed', refresh);
  document.addEventListener('crysviz:atoms-changed', refresh);

  widget = {
    wrapper,
    body,
    list,
    drag,
    refresh,
    destroy() {
      document.removeEventListener('crysviz:colors-changed', refresh);
      document.removeEventListener('crysviz:atoms-changed', refresh);
      stopContrastSync();
      disposeLongPress();
      disposeControls();
      drag.destroy();
      wrapper.remove();
      host.remove();
      disposeGL();
    },
  };

  if (getPanelPref('legendTransparent')) applyTransparent(true);
  tickContrast(wrapper);
  renderRows(list);

  // Back where it was last, or a first-time spot clear of the scene's own
  // top-left furniture (the measurement toolbar).
  if (lastAnchor) {
    drag.floatAtAnchor(lastAnchor);
  } else {
    const view = document.getElementById('view')?.getBoundingClientRect();
    drag.floatAt((view?.left ?? 0) + 40, (view?.top ?? 0) + 200); // clear of the axis toolbar
  }
}

/** Put the legend away (the ❖ button brings it back where it was). */
export function closeCompositionLegend() {
  if (!widget) return;
  lastAnchor = widget.drag.getAnchor() ?? lastAnchor;
  const dying = widget;
  widget = null; // before destroy(): dockBack -> onFloatChange re-enters here
  dying.destroy();
}

/** Is the legend on the scene right now? */
export function isCompositionLegendOpen() {
  return !!widget;
}

/** The ❖ button in the Structure Info header. */
export function toggleCompositionLegend() {
  if (widget) closeCompositionLegend();
  else openCompositionLegend();
}

/** Re-read the structure — for callers that change it without broadcasting
 *  crysviz:atoms-changed (StructureInfoPanel's own re-render, i.e. a file
 *  switch). No-op while the legend is put away. */
export function refreshCompositionLegend() {
  widget?.refresh();
}
