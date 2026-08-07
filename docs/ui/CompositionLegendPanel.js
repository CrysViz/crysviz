// Composition Display: a movable legend window mapping each atom colour in
// the scene to its element — one row per distinct site kind, a 3D sphere
// swatch plus a label. Meant to be dropped next to the structure for
// figure-making, so the swatches don't approximate the atoms: they are
// rendered with the SAME material factory (MaterialStyles.createStyledMaterial
// + getAtomVisSettings), lighting rig and renderer colour pipeline as the main
// view (the PolyhedronMiniRenderer precedent), and a disordered site's swatch
// is built from wedgeDataForAtom's own slots — the exact colours and
// occupancy fractions the wedge shader draws — with the fractions written
// under the label.
//
// Figure-making affordances: every label is contenteditable (edits survive
// refreshes for the session), the body is CSS-resizable and its contents
// scale with the box width, and the ≡ menu offers a transparent mode that
// strips the window chrome so only swatches and text overlay the scene.
//
// One shared offscreen WebGL renderer paints every swatch and each row keeps
// only a 2D canvas copy: N rows cost one GL context, torn down when the
// window closes. Rows refresh on 'crysviz:colors-changed' /
// 'crysviz:atoms-changed' (recolours, occupancy edits, render-style switches)
// and the panel is lifecycle:'rebuild', so a structure switch rebuilds it.

import * as THREE from '../external/three/three.module.js';
import { registerPanel, getPanel, openPanel, getPanelPref, setPanelPref } from './panels/PanelManager.js';
import { createStyledMaterial } from '../render/MaterialStyles.js';
import { getAtomVisSettings } from '../defaults/color_texture_defaults.js';
import { wedgeDataForAtom } from '../render/WedgeAtoms.js';
import { fileBrowser } from '../state/store.js';

const PANEL_ID = 'compositionLegend';
const SWATCH_PX = 30;   // on-screen swatch size at scale 1
const RENDER_PX = 256;  // offscreen render size — headroom for scaled-up boxes
const MAX_RENDER_PX = 1024; // ceiling when the PNG export asks for more
const BASE_WIDTH = 210; // body width that maps to scale 1

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
        entries.set(key, { key, label: `${el} Atom`, sub: null, slices: [{ color, fraction: 1 }] });
      }
    }
  }
  return [...entries.values()];
}

// ---- panel ------------------------------------------------------------------

/** @type {(() => void) | null} */
let cleanup = null;
/** Session-only user text overrides, keyed by entry key — they survive
 *  refreshes and structure round-trips within the session, and reset with it
 *  (labels are structure-specific; persisting them globally would bleed one
 *  structure's edits into another). */
const customText = new Map();
/** Remembered box size (the CSS resize handle writes inline width/height),
 *  so close/reopen keeps the user's figure layout for the session. */
let boxSize = null;

/** contenteditable wiring: Enter commits, blur saves; clearing the text (or
 *  retyping the default) drops the override. */
function wireEditable(el, key, field, defaultText) {
  el.contentEditable = 'true';
  el.spellcheck = false;
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
  const scale = body ? currentScale(body) : 1;
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

/** Strip (or restore) the window chrome. Turning it on also shrinks the title
 *  bar to its hover-revealed handle, so nothing but swatches and text is left
 *  over the scene. */
function applyTransparent(on) {
  const panel = getPanel(PANEL_ID);
  panel?.el?.classList.toggle('comp-legend-transparent', !!on);
  if (on) panel?.collapseBar?.();
  setPanelPref('legendTransparent', on);
}

/** Open the Composition Display window (register on first use — same lazy
 *  pattern as addForceHistogramPanel). */
export function addCompositionLegendPanel() {
  if (getPanel(PANEL_ID)) {
    openPanel(PANEL_ID);
    return;
  }

  registerPanel({
    id: PANEL_ID,
    title: 'Composition Display',
    lifecycle: 'rebuild',
    hiddenUntilStructure: true,
    closable: true,
    available() { return !!fileBrowser.selectedStructure; },
    menuSections: () => [{
      title: 'Legend',
      items: [
        {
          label: 'Transparent background',
          checked: !!getPanelPref('legendTransparent'),
          onSelect: () => applyTransparent(!getPanelPref('legendTransparent')),
        },
        {
          label: 'Reset text edits',
          onSelect: () => {
            customText.clear();
            const list = document.querySelector('.comp-legend-body .comp-legend-list');
            if (list) renderRows(list);
          },
        },
      ],
    }],
    buildContent(body) {
      body.classList.add('comp-legend-body');
      body.closest('.cv-panel')?.classList.add('comp-legend-panel');
      if (boxSize) {
        body.style.width = `${boxSize.w}px`;
        body.style.height = `${boxSize.h}px`;
      }
      const list = document.createElement('div');
      list.className = 'comp-legend-list';
      body.appendChild(list);

      const refresh = () => {
        // Never rebuild under an in-progress text edit — the next event
        // (or reopen) re-syncs.
        if (list.contains(document.activeElement)) return;
        renderRows(list);
      };
      document.addEventListener('crysviz:colors-changed', refresh);
      document.addEventListener('crysviz:atoms-changed', refresh);

      // The CSS resize handle changes the box; contents follow the width.
      // Swatches re-render so they stay crisp instead of upscaling.
      let lastW = body.clientWidth;
      let raf = 0;
      const ro = new ResizeObserver(() => {
        const w = body.clientWidth;
        boxSize = { w: body.offsetWidth, h: body.offsetHeight };
        if (Math.abs(w - lastW) < 3) return;
        lastW = w;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const scale = Math.min(5, Math.max(0.6, w / BASE_WIDTH));
          body.style.setProperty('--legend-scale', String(scale));
          refresh();
        });
      });
      ro.observe(body);

      cleanup = () => {
        document.removeEventListener('crysviz:colors-changed', refresh);
        document.removeEventListener('crysviz:atoms-changed', refresh);
        ro.disconnect();
        cancelAnimationFrame(raf);
        cleanup = null;
      };

      if (getPanelPref('legendTransparent')) applyTransparent(true);
      renderRows(list);
    },
    onDestroyContent() { cleanup?.(); },
    onClose() {
      cleanup?.();
      disposeGL();
    },
    // Floats over the scene by default — it exists to be dragged next to the
    // structure for a figure; dock it from the ≡ menu like any window.
    defaults: { dock: false, anchor: { left: 470, top: 150 }, collapsed: false, barCollapsed: false },
  });
  openPanel(PANEL_ID);
}
