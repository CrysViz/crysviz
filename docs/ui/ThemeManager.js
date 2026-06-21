// CSS-file-based theme system.
//
// Loads themes/themes.json, always applies the base theme (default.css) plus an
// optional override file for the selected theme, and drives the 3D scene colors
// (--scene-bg / --lattice-color, defined in the theme CSS) into three.js. Also
// builds the theme dropdown in the side panel. To add a theme, drop a CSS file
// in docs/themes/ and add one entry to themes.json — no JS changes needed.

import * as THREE from '../external/three/three.module.js';
import { app, general } from '../state/store.js';
import { updateLattice } from '../render/index.js';

const THEMES_DIR = './themes/';
const STORAGE_KEY = 'theme';

/** @type {{base?:string, themes:{id:string,name:string,css:?string}[]}|null} */
let manifest = null;

function ensureBaseLink(baseCss) {
  let link = document.getElementById('theme-base');
  if (!link) {
    link = document.createElement('link');
    link.id = 'theme-base';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  // index.html may already point this at default.css; only set if missing.
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

// Read the scene colors the active theme CSS resolved to and push them into the
// three.js scene + lattice. Exported so the background color-picker can use it
// to reset the scene background back to the current theme's default.
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

export function applyTheme(id) {
  if (!manifest) return;
  const theme = manifest.themes.find(t => t.id === id) || manifest.themes[0];
  const link = getActiveLink();

  if (theme.css) {
    // Apply the scene colors only once the override stylesheet has loaded, so
    // getComputedStyle sees the new --scene-bg / --lattice-color values.
    const onLoad = () => { link.removeEventListener('load', onLoad); applySceneFromCSS(); };
    link.addEventListener('load', onLoad);
    link.setAttribute('href', THEMES_DIR + theme.css);
  } else {
    // Base-only theme (e.g. "light"): drop any override and apply immediately.
    link.removeAttribute('href');
    applySceneFromCSS();
  }

  localStorage.setItem(STORAGE_KEY, id);

  document.querySelectorAll('.theme-menu-item').forEach(el =>
    el.classList.toggle('active', el.dataset.themeId === id));
  const label = document.getElementById('themeMenuLabel');
  if (label) label.textContent = theme.name;
}

function resolveInitialTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && manifest.themes.some(t => t.id === saved)) return saved;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (prefersDark && manifest.themes.some(t => t.id === 'dark')) return 'dark';
  return manifest.themes[0].id;
}

function buildDropdown() {
  const host = document.getElementById('themeSwitch');
  if (!host) return;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'themeMenuToggle';
  toggle.className = 'theme-menu-toggle';
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<span id="themeMenuLabel">Theme</span><span class="theme-menu-arrow" aria-hidden="true">▾</span>';

  const menu = document.createElement('ul');
  menu.id = 'themeMenu';
  menu.className = 'theme-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

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
    if (!host.contains(/** @type {Node} */ (e.target))) closeMenu();
  });

  host.replaceChildren(toggle, menu);
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
  buildDropdown();
  applyTheme(resolveInitialTheme());
}
