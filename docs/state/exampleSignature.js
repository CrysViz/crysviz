// A fingerprint of what a reload would lose of a structure container: its
// atoms and cell, the atoms' colours, opacity, size and hiding, the force and
// spin arrows, crystal planes, focus regions, the supercell, and the
// measurements on screen. Display toggles and the camera are not in it.
//
// The start-up example records it once loaded (core/crystal-viewer.js
// loadStructure, after its saved preferences are applied), so the reload guard
// (ui/LeaveGuard.js) can tell the untouched example — nothing to lose — from
// one the user has coloured, measured, edited or tiled.

import { measurements } from './store.js';

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(5) : String(v));

function arrowsKey(list) {
  if (!Array.isArray(list) || !list.length) return '0';
  return `${list.length}:${list.map((a) => [...(a?.vector ?? [])].map(num).join(',') + (a?.hidden ? 'h' : '') + (a?.userColor ? 'c' : '')).join(' ')}`;
}

/**
 * @param {any} container a StructureContainer
 * @returns {string}
 */
export function exampleSignature(container) {
  const parts = [];
  for (const s of container?.structures ?? []) {
    if (!s) continue;
    parts.push(`L${JSON.stringify(s.lattice ?? null)}`, `N${s.atoms?.length ?? 0}`);
    for (const a of s.atoms ?? []) {
      const p = Array.isArray(a?.position) ? a.position.map(num).join(',') : '';
      parts.push(`${a?.element}|${p}|${a?.color}|${a?.opacity}|${a?.radiusScale}|${a?.hidden ? 1 : 0}`);
    }
    parts.push(`F${arrowsKey(s.forces)}`, `S${arrowsKey(s.spins)}`,
      `P${JSON.stringify((s.planes ?? []).map((pl) => pl?.params ?? null))}`,
      `R${JSON.stringify(s.focusRegions ?? null)}`, `X${JSON.stringify(s.supercell ?? null)}`);
  }
  parts.push(`M${(measurements.measureLines ?? []).length}`);
  return fnv1a(parts.join(';'));
}
