// Binned colour-map lookups, shared by the Colors panel (ui/ColorPanel.js),
// the bond builder's length colouring (BondsFracUpdateModule.js) and the
// per-frame recolouring of the playback fast path (FrameColorsModule.js): one
// binning everywhere, so a fast frame paints exactly what a full rebuild does.

import * as THREE from '../external/three/three.module.js';
import {
  getHeatMapColors, getBatlowColors, getHawaiiColors, getManaguaColors,
  getViridisColors, getPlasmaColors, getSpectralRColors, getJetColors,
} from '../defaults/color_texture_defaults.js';

/** The bins of a colour map (THREE.Color, linear). @param {string} [name] */
export function colorMapColors(name) {
  switch (name) {
    case "batlow": return getBatlowColors();
    case "hawaii": return getHawaiiColors();
    case "managua": return getManaguaColors();
    case "viridis": return getViridisColors();
    case "plasma": return getPlasmaColors();
    case "spectralR": return getSpectralRColors();
    case "jet": return getJetColors();
    default: return getHeatMapColors();
  }
}

const COLOR_LOG_EPS = 1e-6;

/**
 * The bin a value falls in, for a map of nBins colours over [minVal, maxVal]
 * (clamped; linear, or log10 with values floored at 1e-6).
 * @param {number} value @param {number} minVal @param {number} maxVal
 * @param {number} nBins @param {boolean} [useLog]
 */
export function colorBin(value, minVal, maxVal, nBins, useLog = false) {
  const clamped = Math.max(minVal, Math.min(maxVal, value));
  let t;
  if (useLog) {
    const lo = Math.log10(Math.max(minVal, COLOR_LOG_EPS));
    const hi = Math.log10(Math.max(maxVal, COLOR_LOG_EPS));
    const v = Math.log10(Math.max(clamped, COLOR_LOG_EPS));
    t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
  } else {
    t = (maxVal > minVal) ? (clamped - minVal) / (maxVal - minVal) : 0.5;
  }
  return Math.min(Math.max(0, Math.floor(t * nBins)), nBins - 1);
}

const tables = new Map();

/**
 * A colour map as the '#rrggbb' strings the model stores (atom.color,
 * bond.color) and the linear RGB an instance gets from those strings
 * (THREE.Color.set, as updateAtoms / updateSingleBondColor do).
 * getHexString(), not manual r*255 truncation: the bins hold linear colour,
 * the strings sRGB. The maps are fixed, so each table is built once and
 * shared — read it, don't modify it.
 * @param {string} [name]
 * @returns {{hex: string[], rgb: Float32Array, n: number}}
 */
export function colorMapTable(name) {
  let table = tables.get(name);
  if (!table) tables.set(name, table = buildColorMapTable(name));
  return table;
}

function buildColorMapTable(name) {
  const colors = colorMapColors(name) ?? [];
  const n = colors.length;
  const hex = new Array(n);
  const rgb = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let k = 0; k < n; k++) {
    hex[k] = `#${colors[k].getHexString()}`;
    c.set(hex[k]);
    rgb[k * 3] = c.r; rgb[k * 3 + 1] = c.g; rgb[k * 3 + 2] = c.b;
  }
  return { hex, rgb, n };
}
