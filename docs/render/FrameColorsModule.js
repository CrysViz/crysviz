// Frame-dependent colour maps on the render fast path (FastFrameModule.js):
// atoms coloured by force, bonds coloured by length or following
// force-coloured atoms. From frame to frame only the colours change — the
// geometry is the positions-only update the fast path already does — so a
// fast frame recolours the instances it moves instead of falling back to a
// full rebuild (seconds per frame at 10^5 atoms).
//
// The colours are exactly a full rebuild's: the same binning
// (ColorMapBins.js), the same precedence — for atoms a per-copy style colour,
// then the atom's user colour, then the map; for bonds a bond user/category
// colour, then the atom's user colour, then the map — and the model
// (atom.color, bond.color) follows, so the panels read what is on screen.

import * as THREE from '../external/three/three.module.js';
import { general, highlightHover } from '../state/store.js';
import { colorMapTable, colorBin } from './ColorMapBins.js';
import { peekAtoms, pendingFrameForces, peekForces } from '../model/materializeFrame.js';
import { getAtomImageStyle, hasAtomImageStyles } from './AtomsFracUpdateModule.js';
import { isTracerPipelineActive } from './pipeline/index.js';

const _c = new THREE.Color();

/**
 * How the bonds take their colour from the frame: 'length' (bonds by length),
 * 'atoms' (bonds by element colour, which follows force-coloured atoms) or
 * null (static).
 * @returns {'length' | 'atoms' | null}
 */
export function bondFrameColorMode() {
  if (general.bondsColor === 'length') return 'length';
  const elementBonds = general.bondsColor === 'elements' || general.bondsColor == null;
  return general.atomsColor === 'force' && elementBonds ? 'atoms' : null;
}

/**
 * Each source atom's force-map bin for the frame on screen (-1: no force
 * vector, element colour), or null when the frame carries no forces for these
 * atoms — then the atoms keep the colours they have, as with
 * reapplyAtomForceColors on the full path. A frame still pending (model/materializeFrame.js) is read
 * from its force column, without building the per-atom objects.
 * @returns {Int32Array | null}
 */
function forceBins(structure, atoms, table) {
  const n = atoms.length;
  const min = general.ForceMin, max = general.ForceMax;
  const useLog = general.atomColorScale === 'log';
  const bins = new Int32Array(n);
  const column = pendingFrameForces(structure);
  if (column !== undefined) {
    // Applied to the Force objects on flush only when they match the atoms.
    if (!column || column.length < 3 * n || peekForces(structure)?.length !== n) return null;
    for (let i = 0; i < n; i++) {
      const fx = column[3 * i], fy = column[3 * i + 1], fz = column[3 * i + 2];
      bins[i] = colorBin(Math.sqrt(fx * fx + fy * fy + fz * fz), min, max, table.n, useLog);
    }
    return bins;
  }
  const forces = structure.forces;
  if (!forces || forces.length !== n) return null;
  for (let i = 0; i < n; i++) {
    const v = forces[i]?.vector;
    bins[i] = v && v.length >= 3
      ? colorBin(Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]), min, max, table.n, useLog)
      : -1;
  }
  return bins;
}

/** updateAtoms' colour for every instance: per-copy style, user colour, map
 *  (bins; null: the model's atom.color throughout). A selected atom keeps its
 *  highlight colour, as on a frame that only moves the atoms
 *  (ui/SelectAndHighlightModule.js applyAtomHighlightIndices; under a tracer
 *  the highlight is the emissive glow alone). */
function writeAtomColors(structure, wrapped, atomsMesh, atoms, table, bins) {
  const out = atomsMesh.instanceColor?.array;
  if (!out) return;
  const src = wrapped.srcIndex;
  const imageStyles = hasAtomImageStyles(structure);
  const highlighted = highlightHover.currentlyHighlightedAtomInstances;
  const keep = highlighted?.length && !isTracerPipelineActive() ? new Set(highlighted) : null;
  for (let i = 0; i < atomsMesh.count; i++) {
    if (keep?.has(i)) continue;
    const s = src[i];
    const atom = atoms[s];
    const imageColor = imageStyles ? getAtomImageStyle(structure, i)?.color : undefined;
    if (imageColor == null && !atom.userColor && bins && bins[s] >= 0) {
      const b = bins[s] * 3;
      out[i * 3] = table.rgb[b]; out[i * 3 + 1] = table.rgb[b + 1]; out[i * 3 + 2] = table.rgb[b + 2];
      continue;
    }
    _c.set(imageColor ?? atom.getColor());
    out[i * 3] = _c.r; out[i * 3 + 1] = _c.g; out[i * 3 + 2] = _c.b;
  }
  atomsMesh.instanceColor.needsUpdate = true;
}

/** One species at full occupancy: certainly not disordered (Atom.isDisordered
 *  is the full test, for everything else). */
const plainSite = (atom) => atom.species?.length === 1 && atom.species[0].occupancy === 1;

/** Linear RGB per source atom for a bond half that follows its atom
 *  (updateSingleBondColor in "elements" mode): its user colour, else its
 *  representative colour — the force colour, unless the site is disordered. */
function bondSourceColors(atoms, table, bins) {
  const out = new Float32Array(atoms.length * 3);
  for (let s = 0; s < atoms.length; s++) {
    const atom = atoms[s];
    if (atom.userColor == null && bins && bins[s] >= 0 && (plainSite(atom) || !atom.isDisordered())) {
      const b = bins[s] * 3;
      out[s * 3] = table.rgb[b]; out[s * 3 + 1] = table.rgb[b + 1]; out[s * 3 + 2] = table.rgb[b + 2];
      continue;
    }
    _c.set(atom.userColor != null ? atom.userColor : atom.getRepresentativeColor());
    out[s * 3] = _c.r; out[s * 3 + 1] = _c.g; out[s * 3 + 2] = _c.b;
  }
  return out;
}

/**
 * Recolour a fast frame's atom instances (and atom.color) for an active
 * force map, and return what the bond writer needs to colour this frame's
 * bonds (render/PlaybackBondsModule.js writePlaybackBonds), or null when the
 * bonds keep their colours.
 * @param {any} structure
 * @param {any} wrapped the wrapping whose instances atomsMesh draws
 * @param {any} atomsMesh
 * @returns {null | {mode: 'length', table: any, log: boolean} | {mode: 'atoms', rgb: Float32Array}}
 */
export function prepareFrameColors(structure, wrapped, atomsMesh) {
  const bondMode = bondFrameColorMode();
  const atoms = peekAtoms(structure);
  if (general.atomsColor === 'force' && atoms?.length) {
    const table = colorMapTable(general.atomColorMap || 'heatmap');
    // No forces for this frame: the colours the frame switch left on the
    // atoms (TrajectoryContainer resets them to the element defaults in
    // force mode), as the full path shows them.
    const bins = table.n ? forceBins(structure, atoms, table) : null;
    if (bins) {
      for (let s = 0; s < atoms.length; s++) {
        atoms[s].color = bins[s] >= 0 ? table.hex[bins[s]] : structure.getDefaultElementColor(structure.elements[s]);
      }
    }
    writeAtomColors(structure, wrapped, atomsMesh, atoms, table, bins);
    if (bondMode === 'atoms') return { mode: 'atoms', rgb: bondSourceColors(atoms, table, bins) };
  }
  if (bondMode === 'length') {
    const table = colorMapTable(general.bondsColorMap || 'heatmap');
    if (table.n) return { mode: 'length', table, log: general.bondColorScale === 'log' };
  }
  return null;
}

/**
 * Bring the model colours of bonds brought up to date lazily
 * (PlaybackBondsModule.js) in line with the frame: bond.color of every half
 * without a user/category colour, as the bond builder sets it.
 * @param {any} structure
 * @param {any[]} bonds
 */
export function syncBondModelColors(structure, bonds) {
  const mode = bondFrameColorMode();
  if (!mode) return;
  if (mode === 'length') {
    const table = colorMapTable(general.bondsColorMap || 'heatmap');
    if (!table.n || !(general.BondMin < general.BondMax)) return;
    const useLog = general.bondColorScale === 'log';
    for (const bond of bonds) {
      if (!bond?.color || bond.dist == null) continue;
      const hex = table.hex[colorBin(bond.dist, general.BondMin, general.BondMax, table.n, useLog)];
      if (bond.userColor?.[0] == null) bond.color[0] = hex;
      if (bond.userColor?.[1] == null) bond.color[1] = hex;
    }
    return;
  }
  const atoms = peekAtoms(structure);
  if (!atoms) return;
  for (const bond of bonds) {
    if (!bond?.color) continue;
    const a = atoms[bond.srcA], b = atoms[bond.srcB];
    if (a && bond.userColor?.[0] == null) bond.color[0] = a.getRepresentativeColor();
    if (b && bond.userColor?.[1] == null) bond.color[1] = b.getRepresentativeColor();
  }
}
