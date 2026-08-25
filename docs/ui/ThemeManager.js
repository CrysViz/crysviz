// CSS-file-based theme system.
//
// Theming is two axes:
//   PALETTE — the colour family (Default, Fluorite, …), picked from the
//             dropdown. Listed in themes/themes.json under `palettes`.
//   MODE    — light / dark, picked from the icon row, plus `auto`.
//
// Loads themes/themes.json, always applies the base theme (default/theme.css)
// plus the override file the selected palette lists for the *effective* mode,
// and drives the 3D scene colors (--scene-bg / --lattice-color, defined in the
// theme CSS) into three.js.
//
// Auto mode follows the OS prefers-color-scheme through the palette's own
// `auto` pair ([light-side mode, dark-side mode]), so a palette can name its
// own two sides. It is the default. While auto is selected the app re-resolves
// whenever the system flips.
//
// A palette only offers the modes it lists. The icon row disables the rest,
// and switching to a palette that lacks the current mode falls back through
// that palette's `auto` pair rather than leaving a dead selection.
//
// UI: the icon row (.theme-btn) highlights the *selected* mode; when that is
// `auto` the mode it currently resolves to is marked `.resolved` so the row
// still says which way auto went. The dropdown (#themeMenuToggle) lists every
// palette and highlights the selected one.
//
// Panel docking is no longer a theme concern: every panel window carries its
// own dock/undock toggle (ui/panels/), in every theme.
//
// To add a palette: drop its CSS files in docs/themes/<id>/ and add one entry
// to themes.json.

import * as THREE from '../external/three/three.module.js';
import { app, general } from '../state/store.js';
import { updateLattice, requestRender, setCelOutlineColor } from '../render/index.js';
import { refreshBackendTheme } from './BackendPanel/BackendTheme.js';

const THEMES_DIR = './themes/';
// The mode key is the historical 'theme' key: every value it ever held
// (auto/light/dark, and the retired twilight) maps onto a mode id, so old settings
// migrate by themselves onto the Default palette.
const MODE_KEY = 'theme';
const PALETTE_KEY = 'themePalette';

/** @typedef {{id:string, name:string, auto?:string[], modes:Record<string,?string>}} Palette */
/** @type {{base?:string, palettes:Palette[]}|null} */
let manifest = null;
let currentPalette = null; // palette id; persisted
let currentMode = null;    // selected mode id (may be "auto"); persisted

function ensureBaseLink(baseCss) {
  let link = document.getElementById('theme-base');
  if (!link) {
    link = document.createElement('link');
    link.id = 'theme-base';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (!link.getAttribute('href')) link.setAttribute('href', THEMES_DIR + baseCss);
}

function getActiveLink() {
  let link = document.getElementById('theme-active');
  if (!link) {
    link = document.createElement('link');
    link.id = 'theme-active';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  return link;
}

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** @returns {Palette} */
function getPalette(id) {
  return manifest.palettes.find(p => p.id === id) || manifest.palettes[0];
}

function offersMode(palette, modeId) {
  return Object.prototype.hasOwnProperty.call(palette.modes, modeId);
}

// Resolve a selected mode to the concrete mode to display. `auto` follows the
// OS through the palette's pair; a mode the palette doesn't offer falls back
// the same way, so switching palettes can never strand the selection.
function effectiveMode(palette, modeId) {
  if (modeId !== 'auto' && offersMode(palette, modeId)) return modeId;
  const pair = Array.isArray(palette.auto) && palette.auto.length === 2
    ? palette.auto
    : ['light', 'dark'];
  const side = prefersDark() ? pair[1] : pair[0];
  return offersMode(palette, side) ? side : Object.keys(palette.modes)[0];
}

// Push the active theme's scene colors into three.js. Exported so the background
// color-picker can reset the scene background to the current theme default.
export function applySceneFromCSS() {
  const root = getComputedStyle(document.documentElement);
  const sceneBg = root.getPropertyValue('--scene-bg').trim();
  const latticeColor = root.getPropertyValue('--lattice-color').trim();

  if (sceneBg && app?.scene) {
    app.scene.background = new THREE.Color(sceneBg);
    general.defaultBackgroundColor = sceneBg;
    // Keep the Visual window's background swatch in sync with theme/reset.
    const swatch = document.getElementById('backgroundSwatch');
    if (swatch) swatch.style.background = '#' + app.scene.background.getHexString();
    // An 'auto' cel outline (hull mode) contrasts against the theme background.
    setCelOutlineColor();
  }
  if (latticeColor) {
    general.currentLatticeColor = latticeColor;
    const dot = document.getElementById('backgroundDot');
    if (dot) dot.style.border = `2px solid ${latticeColor}`;
    updateLattice();
  }
  // Theme CSS loads async, so this can run after the triggering click's frame.
  requestRender();
}

// Swap the active theme-override stylesheet to the given CSS file (null = none).
function applyConcreteVisuals(css) {
  const link = getActiveLink();
  // The logo has a dark-lettered twin for the light-panelled palettes, and
  // which one is right is a question about --color-scheme — so it can only be
  // asked once the override stylesheet is actually in effect, same as the
  // scene colours below.
  const applyThemedAssets = () => { applySceneFromCSS(); refreshBackendTheme(); };
  if (css) {
    // Apply scene colors once the override stylesheet has loaded so
    // getComputedStyle sees the new --scene-bg / --lattice-color.
    const onLoad = () => { link.removeEventListener('load', onLoad); applyThemedAssets(); };
    link.addEventListener('load', onLoad);
    link.setAttribute('href', THEMES_DIR + css);
  } else {
    link.removeAttribute('href');
    applyThemedAssets();
  }
}

// The icon row highlights the SELECTED mode, marks whichever mode `auto`
// currently resolves to, and disables the modes this palette doesn't offer.
function applyModeHighlight(palette, selectedMode, effMode) {
  document.querySelectorAll('.theme-btn[data-theme-option]').forEach(el => {
    const btn = /** @type {HTMLButtonElement} */ (el);
    const opt = btn.dataset.themeOption;
    btn.classList.toggle('active', opt === selectedMode);
    btn.classList.toggle('resolved', selectedMode === 'auto' && opt === effMode);
    btn.disabled = opt !== 'auto' && !offersMode(palette, opt);
  });
}

// The dropdown menu highlights the SELECTED palette.
function applyMenuHighlight(paletteId) {
  document.querySelectorAll('.theme-menu-item').forEach(el =>
    el.classList.toggle('active', /** @type {HTMLElement} */ (el).dataset.paletteId === paletteId));
}

// Select a palette + mode. Either may be omitted to keep the current one.
// Persists both; applies whichever concrete mode is in effect.
export function applyTheme(paletteId, modeId) {
  if (!manifest) return;
  const palette = getPalette(paletteId ?? currentPalette);
  const mode = modeId ?? currentMode ?? 'auto';
  const eff = effectiveMode(palette, mode);

  currentPalette = palette.id;
  currentMode = mode;

  applyConcreteVisuals(palette.modes[eff]);
  localStorage.setItem(PALETTE_KEY, palette.id);
  localStorage.setItem(MODE_KEY, mode);
  // data-theme stays the effective MODE so addons and any existing selector
  // keep working; the palette is a second attribute rather than a renaming.
  document.documentElement.setAttribute('data-theme', eff);
  document.documentElement.setAttribute('data-palette', palette.id);
  applyModeHighlight(palette, mode, eff);
  applyMenuHighlight(palette.id);
}

function resolveInitialSelection() {
  const savedPalette = localStorage.getItem(PALETTE_KEY);
  const savedMode = localStorage.getItem(MODE_KEY);
  const palette = manifest.palettes.some(p => p.id === savedPalette)
    ? savedPalette
    : manifest.palettes[0].id;
  // Anything not recognised (including a mode from a palette that has since
  // been removed) falls back to Auto, the intended default.
  const known = savedMode === 'auto' || manifest.palettes.some(p => offersMode(p, savedMode));
  return { palette, mode: known ? savedMode : 'auto' };
}

function wireThemeControls() {
  // Mode icon row — auto/light/dark, keeping the current palette.
  document.querySelectorAll('.theme-btn[data-theme-option]').forEach(btn =>
    btn.addEventListener('click', () => applyTheme(null, /** @type {HTMLElement} */ (btn).dataset.themeOption)));

  // Dropdown arrow + menu listing every installed palette.
  const toggle = document.getElementById('themeMenuToggle');
  const menu = document.getElementById('themeMenu');
  if (!toggle || !menu) return;

  menu.replaceChildren();
  manifest.palettes.forEach(p => {
    const item = document.createElement('li');
    item.className = 'theme-menu-item';
    item.dataset.paletteId = p.id;
    item.textContent = p.name;
    const choose = () => { applyTheme(p.id, null); closeMenu(); };
    item.addEventListener('click', choose);
    menu.appendChild(item);
  });

  const openMenu = () => { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); };
  function closeMenu() { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  document.addEventListener('click', (e) => {
    const sw = document.getElementById('themeSwitch');
    if (sw && !sw.contains(/** @type {Node} */ (e.target))) closeMenu();
  });
}

export async function setupThemeSystem() {
  try {
    const res = await fetch(THEMES_DIR + 'themes.json');
    manifest = await res.json();
  } catch (e) {
    console.warn('ThemeManager: could not load themes.json', e);
    return;
  }
  if (!manifest?.palettes?.length) {
    console.warn('ThemeManager: themes.json lists no palettes');
    return;
  }
  ensureBaseLink(manifest.base || 'default/theme.css');
  wireThemeControls();

  // While Auto is the selected mode, follow the OS light/dark setting live.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentMode === 'auto') applyTheme(null, 'auto');
  });

  const initial = resolveInitialSelection();
  applyTheme(initial.palette, initial.mode);
}
