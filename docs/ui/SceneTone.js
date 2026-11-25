// Whether the 3D scene's background is light or dark, as an attribute on
// <html>: data-scene-tone="light" | "dark".
//
// The icon-only toolbar buttons (Settings ▸ Icon-only toolbars, and phones)
// have no chip of their own: they sit straight on the 3D scene, and their
// glyphs are white SVGs. Their polarity must follow the scene background,
// not the palette — the Default palette's light mode keeps dark chrome over a
// white scene, and any palette can be given a light background by hand — so
// the stylesheet (panelWindow.css) inverts them on a light scene.
//
// Call after anything sets app.scene.background. Same light/dark split as the
// lattice colour (BackgroundPicker.js getContrastingBorder), so the cell lines
// and these icons flip together.

import { app } from '../state/store.js';

export function syncSceneTone() {
  const bg = app?.scene?.background;
  if (!bg || !bg.isColor) return;
  const hex = bg.getHexString();
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 0.5;
  document.documentElement.dataset.sceneTone = light ? 'light' : 'dark';
}
