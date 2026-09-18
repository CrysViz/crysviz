// Widget mode (?widget=1): a stripped-down embed of the app showing only the
// 3D structure view, a locked composition legend, and a top-left CrysViz logo
// that IS the menu trigger — its dropdown carries Structures (cell choice),
// Presets (render style), Bonds/Polyhedra toggles, and "Open in CrysViz"
// (full UI, new tab). Everything here is additive and gated on body.widget-mode;
// the full app is untouched. See docs/styles/widgetMode.css for the chrome rules.

import { fileBrowser, general, structureShip } from '../state/store.js';
import { updateVisualization } from '../core/crystal-viewer.js';
import { setActivePipelineFromController } from './ColorPanel.js';
import { updateSpins, updatePolyhedra, autoSpinScale } from '../render/index.js';
import { recenterCamera, setGizmoLabelsOnArrows, resizeGizmoRenderer } from './WindowAndSceneControls.js';
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
 *  by ShareModule). When active, the Structures menu lists one entry per frame
 *  (value = its kind string) and selects frames instead of building variants
 *  with moyo. null = not in frames mode (fall back to moyo's loaded/conv/prim). */
/** @type {any} */
let framesContainer = null;

/** Launch URL (captured before the loader strips the hash) — the "Open in
 *  CrysViz" menu item opens it, minus the widget param, in a new tab. */
let capturedHref = '';

/** The boot atom-size / bond-diameter, captured in initWidgetMode as the
 *  "Normal" preset's restore target (see the note there). */
let defaultAtomSize = null;
let defaultBondRadius = null;

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
  // Magnetic unit cells from the database: show a spin arrow on every periodic
  // image, not just the primary atom (see general.showSpinsOnCopies).
  general.showSpinsOnCopies = true;
  // Capture the boot atom-size / bond-diameter as the "Normal" preset target.
  // (store.js's atomSize=1.0 / bondRadius=0.08 are overwritten at boot by the
  // #atomSize / #bondWidth sliders in initApp, so the live values here — not
  // the store constants — are the app defaults the widget actually shows.)
  defaultAtomSize = general.atomSize;
  defaultBondRadius = general.bondRadius;
  // Polyhedra default OFF in the embed regardless of the payload's display flag.
  general.showPolyhedra = false;
  updatePolyhedra();
  // Axes gizmo: always on, with the a/b/c letters integrated onto the arrows
  // instead of the separate #axesLegend box (see docs/styles/widgetMode.css
  // for the lower-left pin). A restored payload's showAxes=false (ShareModule)
  // would otherwise leave #axesGizmo's inline display from an earlier
  // ControlsWiring toggle at 'none', which the widget CSS can't out-specificity
  // since it never sets `display` for the gizmo — so clear it explicitly.
  general.showAxes = true;
  const gizmoDiv = document.getElementById('axesGizmo');
  if (gizmoDiv) gizmoDiv.style.display = '';
  setGizmoLabelsOnArrows(true);
  // Re-fit the renderer/camera to the div's actual box: a no-op on the common
  // boot path (initAxesGizmo already sized it correctly first paint), but
  // covers the display:'' clear above, which can change the box from 0x0.
  resizeGizmoRenderer();

  setupFramesMode();
  buildSettings(opts?.href ?? '');
  applyWidgetAutoScale();
  ensureSpinsRendered();
  openLockedLegend();
  // A widget .crysviz carries no camera pose, so loadStructure's crysviz branch
  // skipped its fit and left the orbit target at the OrbitControls default
  // (0,0,0 = a cell corner). Re-center on the structure like a cell swap does.
  // (initWidgetMode runs only in widget mode, so full-app restored-camera
  // sessions are never touched.)
  recenterCamera();
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
}

/** Menu label for a frame kind: "loaded" → "As loaded", anything else
 *  capitalized ("conventional" → "Conventional", arbitrary "foo" → "Foo"). */
function kindLabel(kind) {
  if (kind === 'loaded') return 'As loaded';
  const k = String(kind);
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** The Structures group's entries. Frames mode: one per shipped frame, value =
 *  its kind string. Moyo fallback: the fixed loaded/conventional/primitive. */
function structureItems() {
  if (framesContainer) {
    return framesContainer.frameKinds.map((/** @type {string} */ kind) => ({ value: kind, label: kindLabel(kind) }));
  }
  return [
    { value: 'loaded', label: 'As loaded' },
    { value: 'conv', label: 'Conventional' },
    { value: 'prim', label: 'Primitive' },
  ];
}

/** The Structures value currently shown (the checkmark's initial home). */
function initialStructureValue() {
  if (framesContainer) {
    const i = framesContainer.structures.indexOf(fileBrowser.selectedStructure);
    return framesContainer.frameKinds[i >= 0 ? i : 0];
  }
  return 'loaded';
}

// ── Logo trigger + dropdown menu ───────────────────────────────────────────
//
// The CrysViz logo (top-left) IS the menu trigger — no separate cog. Clicking
// it opens the dropdown below-left; the menu's last item ("Open in CrysViz")
// does what the old logo link did.

/** The launch URL with the widget param removed — same structure, full UI. */
function fullUiHref(href) {
  try {
    const url = new URL(href, window.location.href);
    url.searchParams.delete('widget');
    return url.toString();
  } catch {
    return href || './index.html';
  }
}

/** The launch URL with its payload's `selectedFrameIndex` rewritten to the
 *  frame currently on screen — the full app reloads FROM this payload (see
 *  ShareModule.applySharedState), so this is what makes "Open in CrysViz"
 *  open what the user is actually looking at instead of always the as-loaded
 *  frame. Moyo-built variants aren't in the launch payload at all (they're
 *  computed in-browser), so moyo fallback mode is out of scope and left
 *  unchanged; any parse hiccup also falls back to the unchanged href, since
 *  opening the as-loaded frame is a safe degradation and the menu action must
 *  never be blocked by it. */
function hrefForCurrentFrame(href) {
  if (!framesContainer) return href;
  const index = framesContainer.structures.indexOf(fileBrowser.selectedStructure);
  if (index < 0) return href;

  const hashIdx = href.indexOf('#load-file=');
  if (hashIdx < 0) return href;
  const rawHash = href.slice(hashIdx + '#load-file='.length);
  // Split BEFORE decoding, like FileURLLoader.js: an encoded filename pipe
  // (%7C) must not be mistaken for the separator.
  const parts = rawHash.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return href;
  const [encodedFilename, encodedContent] = parts;

  try {
    const b64 = decodeURIComponent(encodedContent);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const state = JSON.parse(new TextDecoder().decode(bytes));
    state.selectedFrameIndex = index;

    const newBytes = new TextEncoder().encode(JSON.stringify(state));
    // Chunked to dodge the String.fromCharCode argument-limit overflow on
    // large payloads (same pattern the altermagnets embedder uses).
    let binaryOut = '';
    for (let o = 0; o < newBytes.length; o += 0x8000) {
      binaryOut += String.fromCharCode.apply(null, newBytes.subarray(o, o + 0x8000));
    }
    const newEncodedContent = encodeURIComponent(btoa(binaryOut));
    return href.slice(0, hashIdx) + '#load-file=' + encodedFilename + '|' + newEncodedContent;
  } catch {
    return href;
  }
}

const PRESET_GROUP = {
  key: 'preset',
  label: 'Presets',
  items: [
    { value: 'normal', label: 'Normal' },
    { value: 'cel', label: 'Cel shading' },
    { value: 'raytrace', label: 'Ray tracing' },
    { value: 'pathtrace', label: 'Path tracing' },
  ],
};

/** Live radio selection per group (Structures = 'cell', Presets = 'preset').
 *  The check-toggles (Bonds/Polyhedra) read general.* directly instead. */
const selection = { cell: 'loaded', preset: currentPresetValue() };

/** @type {HTMLElement|null} */ let menuEl = null;
/** @type {HTMLElement|null} */ let buttonEl = null; // the logo trigger

function buildSettings(href) {
  capturedHref = href;
  selection.cell = initialStructureValue();

  const host = document.createElement('div');
  host.id = 'widgetSettings';

  const logo = document.createElement('button');
  logo.type = 'button';
  logo.id = 'widgetLogo';
  logo.setAttribute('aria-haspopup', 'menu');
  logo.setAttribute('aria-expanded', 'false');
  logo.setAttribute('aria-label', 'CrysViz menu');
  logo.title = 'CrysViz';
  const img = document.createElement('img');
  // Per applied theme (ThemeManager stamps <html data-theme>): a dark-ground
  // mark on dark, the white-ground one otherwise.
  const darkTheme = document.documentElement.getAttribute('data-theme') === 'dark';
  img.src = darkTheme
    ? './data/CrysViz_logo_black_back_logo_only.png'
    : './data/CrysViz_logo_white_back_logo_only.png';
  img.alt = 'CrysViz';
  logo.appendChild(img);
  buttonEl = logo;

  const menu = document.createElement('div');
  menu.className = 'widget-settings-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  menuEl = menu;

  // a. Structures (radio) — the cells the payload provides.
  renderRadioGroup(menu, 'cell', 'Structures', structureItems());
  menu.appendChild(makeSep());
  // b. Presets (radio) — render style; ray/path also bump atom + bond size.
  renderRadioGroup(menu, 'preset', PRESET_GROUP.label, PRESET_GROUP.items);
  menu.appendChild(makeSep());
  // c. Bonds / Polyhedra (check toggles, reflecting live state).
  menu.appendChild(makeToggleRow('bonds', 'Bonds', () => general.showBonds));
  menu.appendChild(makeToggleRow('poly', 'Polyhedra', () => general.showPolyhedra));
  // d. Embedder-supplied links (validated in ShareModule), if any.
  const links = structureShip.container[fileBrowser.selectedRowIndex]?.menuLinks;
  if (Array.isArray(links) && links.length) {
    menu.appendChild(makeSep());
    for (const l of links) menu.appendChild(makeLinkRow(l.label, l.url));
  }
  menu.appendChild(makeSep());
  // e. Open the same structure in the full UI (new tab).
  menu.appendChild(makeActionRow('Open in CrysViz', openFullUi));

  logo.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });

  host.append(logo, menu);
  document.body.appendChild(host);

  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (!host.contains(/** @type {Node} */ (e.target))) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });
}

function makeSep() {
  const sep = document.createElement('div');
  sep.className = 'widget-menu-sep';
  return sep;
}

/** A menu row: a check column (shown when aria-checked) + a label. */
function makeRow(role, label) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'widget-menu-item';
  row.setAttribute('role', role);
  const check = document.createElement('span');
  check.className = 'widget-menu-check';
  check.setAttribute('aria-hidden', 'true');
  check.textContent = CHECK;
  const text = document.createElement('span');
  text.className = 'widget-menu-text';
  text.textContent = label;
  row.append(check, text);
  return row;
}

function renderRadioGroup(menu, groupKey, title, items) {
  const label = document.createElement('div');
  label.className = 'widget-menu-group-label';
  label.textContent = title;
  menu.appendChild(label);
  for (const item of items) {
    const row = makeRow('menuitemradio', item.label);
    row.dataset.group = groupKey;
    row.dataset.value = item.value;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (row.getAttribute('aria-disabled') === 'true') return;
      void onSelect(groupKey, item.value);
    });
    menu.appendChild(row);
  }
  syncGroupChecks(groupKey);
}

/** A live check-toggle (Bonds/Polyhedra): aria-checkbox reflecting `read()`. */
function makeToggleRow(key, label, read) {
  const row = makeRow('menuitemcheckbox', label);
  row.dataset.toggle = key;
  row.setAttribute('aria-checked', read() ? 'true' : 'false');
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    if (key === 'bonds') {
      general.showBonds = !general.showBonds;
      updateVisualization({ reRenderAtoms: !!general.showPBCBonds, reRenderBonds: true, bondsUpdate: false });
    } else {
      general.showPolyhedra = !general.showPolyhedra;
      updatePolyhedra();
    }
    row.setAttribute('aria-checked', read() ? 'true' : 'false');
  });
  return row;
}

/** An embedder link (role=menuitem): opens its url in a new tab. Same popup
 *  permission as "Open in CrysViz". */
function makeLinkRow(label, url) {
  const row = makeRow('menuitem', label);
  row.dataset.link = url;
  row.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); window.open(url, '_blank', 'noopener'); });
  return row;
}

function makeActionRow(label, onClick) {
  const row = makeRow('menuitem', label);
  row.dataset.action = 'open';
  row.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); onClick(); });
  return row;
}

/** "Open in CrysViz": the logo is no longer an <a>, so open via window.open
 *  (same target=_blank/noopener the old link used; needs the iframe's
 *  allow-popups, which the old link already required). */
function openFullUi() {
  window.open(fullUiHref(hrefForCurrentFrame(capturedHref)), '_blank', 'noopener');
}

/** Reflect `selection[group]` onto that group's rows (aria-checked + tick). */
function syncGroupChecks(groupKey) {
  if (!menuEl) return;
  menuEl.querySelectorAll(`.widget-menu-item[data-group="${groupKey}"]`).forEach((row) => {
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

/** Grey out one Structures entry with a tooltip. */
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
  // Re-picking the already-checked radio entry is a no-op.
  if (selection[groupKey] === value) return;
  if (groupKey === 'preset') {
    selection.preset = value;
    syncGroupChecks('preset');
    applyPreset(value);
    return;
  }
  // Structures group.
  const ok = await applyCell(value);
  if (ok) {
    selection.cell = value;
    syncGroupChecks('cell');
    applyWidgetAutoScale(); // each structure's spins/L_max differ
    ensureSpinsRendered();
  }
}

// ── Presets ──────────────────────────────────────────────────────────────

/** The preset implied by the live pipeline/style (a restored session may boot
 *  into a non-default pair). */
function currentPresetValue() {
  if (general.renderPipeline === 'raytrace') return 'raytrace';
  if (general.renderPipeline === 'pathtrace') return 'pathtrace';
  if (general.renderStyle === 'cel') return 'cel';
  return 'normal';
}

/** Ray/path tracing want larger spheres + fatter bonds; Normal restores the
 *  boot defaults. Cel shading deliberately does NOT touch sizes (per the user's
 *  letter) — so Ray→Cel keeps the big sizes until Normal is picked. */
const PRESET_ATOM_SIZE = 0.50;
const PRESET_BOND_RADIUS = 0.17;

function applyPreset(value) {
  switch (value) {
    case 'normal':
      general.renderStyle = 'metallic';
      general.atomSize = defaultAtomSize;
      general.bondRadius = defaultBondRadius;
      setActivePipelineFromController('depthpeel');
      restyleAtomsBonds();
      break;
    case 'cel':
      // Every preset carries its own look: Cel resets sizes to boot defaults too.
      general.renderStyle = 'cel';
      general.atomSize = defaultAtomSize;
      general.bondRadius = defaultBondRadius;
      setActivePipelineFromController('depthpeel');
      restyleAtomsBonds();
      break;
    case 'raytrace':
    case 'pathtrace':
      general.atomSize = PRESET_ATOM_SIZE;
      general.bondRadius = PRESET_BOND_RADIUS;
      // Programmatic path — tolerates the missing dropdown and does NOT raise
      // the tracer performance-warning modal (that fires only from ColorPanel's
      // own <select> change handler).
      setActivePipelineFromController(value);
      restyleAtomsBonds();
      break;
    default:
      break;
  }
}

/** Re-render atoms/bonds at the current sizes/style and let colour-driven
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
 * Frames-mode cell swap: `value` is the frame's kind string; select that frame.
 * Recenters only when the cell dimensions change (loaded↔conventional may be
 * identical), mirroring the moyo path's post-swap recenter.
 *
 * @param {string} value a frameKinds entry
 * @returns {boolean}
 */
function applyCellFrame(value) {
  if (!framesContainer) return false;
  const index = framesContainer.frameKinds.indexOf(value);
  if (index < 0) return false; // no such frame
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
/** Widget: set Global Scaling from the shared autoSpinScale for the current
 *  structure (clamped to the panel's [0.1, 10] slider range). No-op — keeps the
 *  current scale — when there is nothing to compute (no/zero spins). Applied at
 *  init and after every structure switch, since each structure's L_max differs. */
function applyWidgetAutoScale() {
  const scale = autoSpinScale(fileBrowser.selectedStructure);
  if (scale == null || !(scale > 0)) return;
  general.spinScale = Math.min(Math.max(scale, 0.1), 10);
}

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
