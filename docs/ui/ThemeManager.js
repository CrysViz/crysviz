// CSS-file-based theme system.
//
// Loads themes/themes.json, always applies the base theme (default.css) plus an
// optional override file for the selected theme, and drives the 3D scene colors
// (--scene-bg / --lattice-color, defined in the theme CSS) into three.js.
//
// UI: the existing dark/twilight/light icon toggle (.theme-btn) is kept and works
// as before; a small dropdown arrow (#themeMenuToggle) lists ALL installed themes
// (including "docked"). Selecting dark/twilight/light highlights the matching
// toggle button; selecting any other theme leaves the toggle un-highlighted.
//
// Themes in DOCK_THEMES (e.g. "docked") also pull persistent floating panels
// (composition, trajectory controls, MD monitor) into #ui; other themes restore
// them to the body.
//
// To add a theme: drop a CSS file in docs/themes/ and add one entry to themes.json.

import * as THREE from '../external/three/three.module.js';
import { app, general } from '../state/store.js';
import { updateLattice } from '../render/index.js';

const THEMES_DIR = './themes/';
const STORAGE_KEY = 'theme';

// Persistent floating panels pulled into the side panel for docked themes, then
// restored to <body> for other themes. `afterId` places the panel right after
// that element; null appends it to the end of #ui. (Modal/transient dialogs —
// the periodic table, add-atoms/vacuum — are intentionally NOT listed; they stay
// floating in every theme.)
const DOCKABLE = [
  { id: 'infoPanel',        afterId: 'saveButton' },         // composition/atoms readout
  { id: 'TrajControlPanel', afterId: 'structureControls2' }, // below the Trajectory selector box
  { id: 'mdMonitorPanel',   afterId: 'backendControlGroup' },// below the backend/MD box
];
const DOCK_THEMES = new Set(['docked']);

/** @type {{base?:string, themes:{id:string,name:string,css:?string}[]}|null} */
let manifest = null;
let currentThemeId = null;

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

// Push the active theme's scene colors into three.js. Exported so the background
// color-picker can reset the scene background to the current theme default.
export function applySceneFromCSS() {
  const root = getComputedStyle(document.documentElement);
  const sceneBg = root.getPropertyValue('--scene-bg').trim();
  const latticeColor = root.getPropertyValue('--lattice-color').trim();

  if (sceneBg && app?.scene) {
    app.scene.background = new THREE.Color(sceneBg);
    general.defaultBackgroundColor = sceneBg;
  }
  if (latticeColor) {
    general.currentLatticeColor = latticeColor;
    const dot = document.getElementById('backgroundDot');
    if (dot) dot.style.border = `2px solid ${latticeColor}`;
    updateLattice();
  }
}

function applyToggleState(id) {
  // Highlight the matching dark/twilight/light toggle button (or none).
  document.querySelectorAll('.theme-btn').forEach(btn =>
    btn.classList.toggle('active', /** @type {HTMLElement} */ (btn).dataset.themeOption === id));
  document.querySelectorAll('.theme-menu-item').forEach(el =>
    el.classList.toggle('active', /** @type {HTMLElement} */ (el).dataset.themeId === id));
}

function applyDocking(id) {
  const docked = DOCK_THEMES.has(id);
  const ui = document.getElementById('ui');
  DOCKABLE.forEach(({ id: elId, afterId }) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (docked && ui) {
      const anchor = afterId ? document.getElementById(afterId) : null;
      if (anchor) {
        if (el.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', el);
      } else if (el.parentElement !== ui) {
        ui.appendChild(el);
      }
    } else if (el.parentElement !== document.body) {
      document.body.appendChild(el);
    }
  });
}

// Re-run docking for the active theme. Call after creating a dockable panel that
// did not exist when the theme was applied (e.g. the MD monitor, trajectory
// controls), so it docks immediately while a docked theme is active.
export function refreshDocking() {
  if (currentThemeId) applyDocking(currentThemeId);
}

export function applyTheme(id) {
  if (!manifest) return;
  const theme = manifest.themes.find(t => t.id === id) || manifest.themes[0];
  const link = getActiveLink();

  if (theme.css) {
    // Apply scene colors once the override stylesheet has loaded so
    // getComputedStyle sees the new --scene-bg / --lattice-color.
    const onLoad = () => { link.removeEventListener('load', onLoad); applySceneFromCSS(); };
    link.addEventListener('load', onLoad);
    link.setAttribute('href', THEMES_DIR + theme.css);
  } else {
    link.removeAttribute('href');
    applySceneFromCSS();
  }

  currentThemeId = theme.id;
  localStorage.setItem(STORAGE_KEY, theme.id);
  document.documentElement.setAttribute('data-theme', theme.id);
  applyToggleState(theme.id);
  applyDocking(theme.id);
}

function resolveInitialTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && manifest.themes.some(t => t.id === saved)) return saved;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (prefersDark && manifest.themes.some(t => t.id === 'dark')) return 'dark';
  return manifest.themes[0].id;
}

function wireThemeControls() {
  // Existing dark/twilight/light icon toggle.
  document.querySelectorAll('.theme-btn[data-theme-option]').forEach(btn =>
    btn.addEventListener('click', () => applyTheme(/** @type {HTMLElement} */ (btn).dataset.themeOption)));

  // Dropdown arrow + menu listing every installed theme.
  const toggle = document.getElementById('themeMenuToggle');
  const menu = document.getElementById('themeMenu');
  if (!toggle || !menu) return;

  menu.replaceChildren();
  manifest.themes.forEach(t => {
    const item = document.createElement('li');
    item.className = 'theme-menu-item';
    item.dataset.themeId = t.id;
    item.setAttribute('role', 'menuitem');
    item.tabIndex = 0;
    item.textContent = t.name;
    const choose = () => { applyTheme(t.id); closeMenu(); };
    item.addEventListener('click', choose);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
    });
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
  ensureBaseLink(manifest.base || 'default.css');
  wireThemeControls();
  applyTheme(resolveInitialTheme());
}
