// Widget mode (?widget=1): a stripped-down embed of the app showing only the
// 3D structure view, a locked composition legend, a top-left CrysViz logo that
// opens the full UI, and a top-right settings menu (cell choice + rendering
// style). Everything here is additive and gated on body.widget-mode; the full
// app is untouched. See docs/styles/widgetMode.css for the chrome-hiding rules.

import { fileBrowser, general, structureShip } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { setActivePipelineFromController } from './ColorPanel.js';
import { updateSpins } from '../render/index.js';
import { recenterCamera } from './WindowAndSceneControls.js';
import { selectStructure, createRow } from './FileBrowswerPanel.js';
import { showTrajectoryFrame } from './TrajectoryPanel.js';
import { toggleCompositionLegend, isCompositionLegendOpen } from './CompositionLegendWidget.js';
import { ensureMoyoReady, moyoDataset, buildSymmetrisedContainer, PT } from './BackendPanel/MoyoWASM.js';
import { Spin } from '../model/index.js';
import { computeSpinRemap } from './WidgetSpinRemap.js';

const CHECK = '✓';

/** The structure the widget was launched with (its Files-table row index and
 *  the Structure object), captured at init so "As loaded" can return to it. */
let loadedRowIndex = 0;
let loadedStructure = null;

/** Cached row indices for the symmetrised variants, per kind. null = not yet
 *  built; -1 = unavailable for THIS kind (magnetic supercell / build error);
 *  >=0 = its Files-table row index. Kinds are handled independently: a prim
 *  refusal must not disable Conventional. */
const variantRow = { conv: null, prim: null };
/** In-flight build so two quick clicks share one moyo call + registration
 *  instead of racing across the ensureMoyoReady() await and duplicating rows. */
let buildPromise = null;

/** Frames mode: the database precomputed the cells and shipped them as frames
 *  of a multi-frame session (top-level `frameKinds`, stashed on the container
 *  by ShareModule). When active, the Cell menu selects frames instead of
 *  building variants with moyo — the moyo path (buildVariants/WidgetSpinRemap)
 *  is never invoked. null = not in frames mode (fall back to moyo). */
/** @type {import('../model/StructureContainer.js').StructureContainer|null} */
let framesContainer = null;
/** Cell-menu value → frame index in framesContainer.structures (-1 = kind not
 *  provided by the database → that entry is disabled). */
const frameForCell = { loaded: -1, conv: -1, prim: -1 };

/** The frameKinds string each Cell-menu value maps to. */
const CELL_TO_KIND = { loaded: 'loaded', conv: 'conventional', prim: 'primitive' };

/**
 * Initialise widget-mode UI. Runs once, after the authoritative bootstrap has
 * loaded the structure (so the composition legend and spin arrows have data).
 *
 * @param {{href:string}} opts href captured in host/early.js BEFORE the loader
 *   strips the location hash — the logo links back to the full UI with the same
 *   structure (same URL minus the `widget` param).
 */
export function initWidgetMode(opts) {
  loadedStructure = fileBrowser.selectedStructure ?? null;
  loadedRowIndex = fileBrowser.selectedRowIndex ?? 0;
  // Force the feature locks on. With a persisted featuresLocked=false (from
  // same-origin full-app use) a cell swap counts as a row change, and
  // updateStructureFromRowAndStep would run applyDefaultFeatureToggles —
  // FEATURE_TOGGLE_DEFAULTS turns showSpinsToggle off and erases the arrows.
  general.featuresLocked = true;

  setupFramesMode();
  buildLogo(opts?.href ?? '');
  buildSettings();
  ensureSpinsRendered();
  openLockedLegend();
}

/**
 * If the loaded container carries valid frameKinds (a database-precomputed
 * multi-frame session), enter frames mode: map each Cell-menu value to its
 * frame index. Kinds the database did not ship stay at -1 and get disabled in
 * buildSettings. Absent/invalid frameKinds leaves framesContainer null → the
 * moyo build path stays as the fallback.
 */
function setupFramesMode() {
  const container = structureShip.container[fileBrowser.selectedRowIndex];
  const kinds = container?.frameKinds;
  if (!Array.isArray(kinds) || kinds.length !== container.structures.length) return;
  framesContainer = container;
  frameForCell.loaded = kinds.indexOf(CELL_TO_KIND.loaded);
  if (frameForCell.loaded < 0) frameForCell.loaded = 0; // fallback: frame 0 is "as loaded"
  frameForCell.conv = kinds.indexOf(CELL_TO_KIND.conv);
  frameForCell.prim = kinds.indexOf(CELL_TO_KIND.prim);
}

// ── Logo ─────────────────────────────────────────────────────────────────

function buildLogo(href) {
  const link = document.createElement('a');
  link.id = 'widgetLogo';
  link.target = '_blank';
  link.rel = 'noopener';
  link.href = fullUiHref(href);
  link.title = 'Open in CrysViz';
  const img = document.createElement('img');
  img.src = './data/CrysViz_logo_white_back_logo_only.png';
  img.alt = 'Open in CrysViz';
  link.appendChild(img);
  document.body.appendChild(link);
}

/** The launch URL with the `widget` param removed — same structure, full UI. */
function fullUiHref(href) {
  try {
    const url = new URL(href, window.location.href);
    url.searchParams.delete('widget');
    return url.toString();
  } catch {
    return href || './index.html';
  }
}

// ── Settings menu ──────────────────────────────────────────────────────────

const CELL_GROUP = {
  key: 'cell',
  label: 'Cell',
  items: [
    { value: 'loaded', label: 'As loaded' },
    { value: 'conv', label: 'Conventional' },
    { value: 'prim', label: 'Primitive' },
  ],
};

const RENDER_GROUP = {
  key: 'render',
  label: 'Rendering',
  items: [
    { value: 'normal', label: 'Normal' },
    { value: 'cel', label: 'Cel shading' },
    { value: 'raytrace', label: 'Ray tracing' },
    { value: 'pathtrace', label: 'Path tracing' },
  ],
};

/** Live per-group selection, kept in sync with the check marks. */
const selection = { cell: 'loaded', render: currentRenderValue() };

/** @type {HTMLElement|null} */ let menuEl = null;
/** @type {HTMLButtonElement|null} */ let buttonEl = null;

function buildSettings() {
  const host = document.createElement('div');
  host.id = 'widgetSettings';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'widget-settings-btn';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'Display settings');
  button.title = 'Display settings';
  button.textContent = '⚙';
  buttonEl = button;

  const menu = document.createElement('div');
  menu.className = 'widget-settings-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  menuEl = menu;

  renderGroup(menu, CELL_GROUP);
  // Frames mode: disable cell kinds the database did not ship.
  if (framesContainer) {
    for (const kind of ['conv', 'prim']) {
      if (frameForCell[kind] < 0) disableCellRow(kind, 'not provided by the database');
    }
  }
  const sep = document.createElement('div');
  sep.className = 'widget-menu-sep';
  menu.appendChild(sep);
  renderGroup(menu, RENDER_GROUP);

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  host.append(button, menu);
  document.body.appendChild(host);

  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (!host.contains(/** @type {Node} */ (e.target))) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });
}

function renderGroup(menu, group) {
  const label = document.createElement('div');
  label.className = 'widget-menu-group-label';
  label.textContent = group.label;
  menu.appendChild(label);

  for (const item of group.items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'widget-menu-item';
    row.setAttribute('role', 'menuitemradio');
    row.dataset.group = group.key;
    row.dataset.value = item.value;

    const check = document.createElement('span');
    check.className = 'widget-menu-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = CHECK;
    const text = document.createElement('span');
    text.className = 'widget-menu-text';
    text.textContent = item.label;
    row.append(check, text);

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (row.getAttribute('aria-disabled') === 'true') return;
      void onSelect(group.key, item.value);
    });
    menu.appendChild(row);
  }
  syncGroupChecks(group.key);
}

/** Reflect `selection[group]` onto that group's rows (aria-checked + tick). */
function syncGroupChecks(groupKey) {
  if (!menuEl) return;
  const rows = menuEl.querySelectorAll(`.widget-menu-item[data-group="${groupKey}"]`);
  rows.forEach((row) => {
    const el = /** @type {HTMLElement} */ (row);
    el.setAttribute('aria-checked', el.dataset.value === selection[groupKey] ? 'true' : 'false');
  });
}

/** Disable ONE cell-variant menu entry (Moyo failed / magnetic supercell for
 *  that kind), with a tooltip explaining why. */
function disableCellVariant(kind, reason) {
  variantRow[kind] = -1;
  disableCellRow(kind, reason);
}

/** Grey out one Cell-menu entry with a tooltip (no variantRow bookkeeping — used
 *  by both the moyo-refusal path and frames mode). */
function disableCellRow(kind, reason) {
  const row = menuEl?.querySelector(`.widget-menu-item[data-group="cell"][data-value="${kind}"]`);
  if (row) {
    row.setAttribute('aria-disabled', 'true');
    /** @type {HTMLElement} */ (row).title = reason;
  }
}

function toggleMenu() {
  if (!menuEl) return;
  menuEl.hidden ? openMenu() : closeMenu();
}
function openMenu() {
  if (!menuEl || !buttonEl) return;
  menuEl.hidden = false;
  buttonEl.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  if (!menuEl || !buttonEl) return;
  menuEl.hidden = true;
  buttonEl.setAttribute('aria-expanded', 'false');
}

async function onSelect(groupKey, value) {
  closeMenu();
  // Re-picking the already-checked entry is a no-op for BOTH groups (a repeat
  // cell pick would otherwise re-select + re-center pointlessly).
  if (selection[groupKey] === value) return;
  if (groupKey === 'render') {
    selection.render = value;
    syncGroupChecks('render');
    applyRendering(value);
    return;
  }
  // Cell group.
  const ok = await applyCell(value);
  if (ok) {
    selection.cell = value;
    syncGroupChecks('cell');
    ensureSpinsRendered();
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** The rendering menu value implied by the live pipeline/style (a loaded
 *  .crysviz may have restored a non-default pair). */
function currentRenderValue() {
  if (general.renderPipeline === 'raytrace') return 'raytrace';
  if (general.renderPipeline === 'pathtrace') return 'pathtrace';
  if (general.renderStyle === 'cel') return 'cel';
  return 'normal';
}

function applyRendering(value) {
  switch (value) {
    case 'normal':
      general.renderStyle = 'metallic';
      setActivePipelineFromController('depthpeel');
      restyleAtomsBonds();
      break;
    case 'cel':
      general.renderStyle = 'cel';
      setActivePipelineFromController('depthpeel');
      restyleAtomsBonds();
      break;
    case 'raytrace':
      // Programmatic path — tolerates the missing dropdown and does NOT raise
      // the tracer performance-warning modal (that fires only from ColorPanel's
      // own <select> change handler).
      setActivePipelineFromController('raytrace');
      break;
    case 'pathtrace':
      setActivePipelineFromController('pathtrace');
      break;
    default:
      break;
  }
}

/** Re-render atoms/bonds with the new material style and let colour-driven
 *  widgets (the composition legend) refresh. */
function restyleAtomsBonds() {
  updateVisualization({ reRenderAtoms: true, reRenderBonds: true });
  document.dispatchEvent(new CustomEvent('crysviz:colors-changed'));
}

// ── Cell swap ──────────────────────────────────────────────────────────────

/**
 * Apply a cell choice. "As loaded" returns to the launch structure; conv/prim
 * build (once) a symmetrised variant with remapped spins and select it.
 * Returns whether the selection took effect.
 *
 * @param {string} value 'loaded' | 'conv' | 'prim'
 * @returns {Promise<boolean>}
 */
async function applyCell(value) {
  // Frames mode: the database precomputed the cells. Select the matching frame
  // instead of building anything with moyo.
  if (framesContainer) return applyCellFrame(value);

  if (value === 'loaded') {
    selectStructure(loadedRowIndex);
    recenterCamera();
    return true;
  }

  const kind = value === 'conv' ? 'conv' : 'prim';
  // Build both variants once (they share a moyo dataset). Two quick clicks
  // share the same in-flight promise so they can't each build + duplicate rows.
  if (variantRow.conv == null && variantRow.prim == null) {
    buildPromise = buildPromise || (async () => {
      try {
        await ensureMoyoReady();
        buildVariants();
      } catch (error) {
        // Moyo init failed for the whole dataset → neither kind is available.
        console.warn('[widget] moyo unavailable:', error);
        disableCellVariant('conv', describeCellFailure(error));
        disableCellVariant('prim', describeCellFailure(error));
      }
    })();
    await buildPromise;
  }

  const rowIndex = variantRow[kind];
  if (rowIndex == null || rowIndex < 0) return false; // never built or unavailable
  selectStructure(rowIndex);
  recenterCamera();
  return true;
}

/**
 * Frames-mode cell swap: select the precomputed frame for this cell kind.
 * Recenters only when the cell dimensions change (loaded↔conventional may be
 * identical), mirroring the moyo path's post-swap recenter.
 *
 * @param {string} value 'loaded' | 'conv' | 'prim'
 * @returns {boolean}
 */
function applyCellFrame(value) {
  if (!framesContainer) return false;
  const index = frameForCell[value];
  if (index == null || index < 0) return false; // kind not provided by the database
  const before = fileBrowser.selectedStructure?.lattice;
  const after = framesContainer.structures[index]?.lattice;
  showTrajectoryFrame(index, framesContainer);
  if (latticeChanged(before, after)) recenterCamera();
  return true;
}

/** True if two 3×3 lattices differ beyond a tiny numeric tolerance (either
 *  missing → treat as changed). */
function latticeChanged(a, b) {
  if (!a || !b) return true;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (Math.abs((a[i]?.[j] ?? 0) - (b[i]?.[j] ?? 0)) > 1e-6) return true;
    }
  }
  return false;
}

/**
 * Build both symmetrised variants from ONE moyo call (they share the dataset).
 * Each kind is handled independently: a kind whose spin remap can't be
 * represented (magnetic supercell) is disabled and NOT registered, without
 * touching the other kind. Sets variantRow[kind] to the new row index or -1.
 */
function buildVariants() {
  const dataset = moyoDataset(loadedStructure, general.symmetryTolerance).dataset;

  for (const kind of ['conv', 'prim']) {
    try {
      const cell = kind === 'conv' ? dataset.std_cell : dataset.prim_std_cell;
      const flat = cell.lattice.basis;
      const lattice = [flat.slice(0, 3), flat.slice(3, 6), flat.slice(6, 9)];
      const elements = cell.numbers.map((/** @type {number} */ z) => PT[z] ?? String(z));
      const container = buildSymmetrisedContainer(`widget_${kind}`, cell.positions, lattice, elements);
      const structure = container.structures[0];

      if (loadedStructure?.spins?.length) {
        const remap = remapSpins(loadedStructure, structure, dataset);
        if (!remap.ok) {
          disableCellVariant(kind, remap.reason ?? describeCellFailure());
          continue; // leave the other kind alone; keep the container unregistered
        }
        structure.spins = remap.spins;
        structure.spinFrame = { fileSaxis: [0, 0, 1] }; // remapped vectors are Cartesian
        // Pre-seed visibleWrapped so the pre-render updateSpins() (fired inside
        // selectStructure before atoms render) has cart data to place arrows on.
        if (structure.periodic?.wrapped) {
          structure.periodic.visibleWrapped = structure.periodic.wrapped;
        }
      }
      variantRow[kind] = registerVariantRow(container);
    } catch (error) {
      console.warn(`[widget] ${kind} cell build failed:`, error);
      disableCellVariant(kind, describeCellFailure(error));
    }
  }
}

/** Push a prepared container into the ship and add a Files-table row via the
 *  shared createRow helper (rows are invisible chrome in widget mode, but
 *  selectStructure indexes rows against containers). Returns the new row index. */
function registerVariantRow(container) {
  structureShip.container.push(container);
  const row = createRow({ name: container.fileName, traj: 1, step: 1 });
  document.querySelector('#objectTable tbody')?.appendChild(row);
  return structureShip.container.length - 1;
}

/**
 * Wrap the pure remap (WidgetSpinRemap.computeSpinRemap) into Spin objects
 * index-aligned to the variant's atoms.
 *
 * @param {any} inputStructure launch structure (spins are Cartesian)
 * @param {any} variantStructure built std/prim structure
 * @param {any} dataset raw moyo dataset (std_rotation_matrix)
 * @returns {{ok:boolean, spins?:any[], reason?:string}}
 */
function remapSpins(inputStructure, variantStructure, dataset) {
  const flat = dataset.std_rotation_matrix;
  const rotation = [flat.slice(0, 3), flat.slice(3, 6), flat.slice(6, 9)];
  const result = computeSpinRemap({
    inputFrac: inputStructure.atoms.map((/** @type {any} */ a) => [...a.position]),
    inputElements: inputStructure.elements,
    inputLattice: inputStructure.lattice,
    inputMoments: inputStructure.spins.map((/** @type {any} */ s) => (s?.vector ? [...s.vector] : [0, 0, 0])),
    outputFrac: variantStructure.atoms.map((/** @type {any} */ a) => [...a.position]),
    outputElements: variantStructure.elements,
    outputLattice: variantStructure.lattice,
    rotation,
    tol: general.symmetryTolerance,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  const spins = result.moments.map((/** @type {number[]} */ v, /** @type {number} */ k) => new Spin({
    vector: [...v],
    rawVector: [...v],
    atomIndex: k,
    element: variantStructure.elements[k],
  }));
  return { ok: true, spins };
}

function describeCellFailure(_error) {
  return 'Conventional/primitive cell unavailable for this structure';
}

// ── Spins ────────────────────────────────────────────────────────────────

/** SpinModule only draws a species whose #speciesVisibilityContainer checkbox
 *  is checked — the Spins panel builds those, but in widget mode it may not be
 *  revealed. Ensure a checked checkbox exists per element, then (re)draw. */
function ensureSpinsRendered() {
  const structure = fileBrowser.selectedStructure;
  if (!structure?.spins?.length || !general.spinsActive) return;

  let container = document.getElementById('speciesVisibilityContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'speciesVisibilityContainer';
    container.hidden = true;
    document.body.appendChild(container);
  }
  for (const el of new Set(structure.elements)) {
    // CSS.escape: element strings with odd characters would otherwise break the
    // selector and throw (initWidgetMode is awaited in early.js's try → kills
    // the widget).
    if (!container.querySelector(`#species-${CSS.escape(String(el))}`)) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `species-${el}`;
      cb.checked = true;
      container.appendChild(cb);
    }
  }
  updateSpins(general.spinScale ?? 1.0, false, [], general.spinColorMap);
}

// ── Composition legend ─────────────────────────────────────────────────────

/** Lock BEFORE opening so dragging is disabled from the first frame (the drag
 *  helper reads general.compositionLegendLocked live). */
function openLockedLegend() {
  general.compositionLegendLocked = true;
  if (!isCompositionLegendOpen()) toggleCompositionLegend();
}
