// Derived visibility for local environments in large cells. Focus regions do
// not mutate Atom.opacity: closing the panel or disabling every region must
// restore the authored appearance exactly.

import * as THREE from '../external/three/three.module.js';
import { fileBrowser, groups, general } from '../state/store.js';
import { readStructurePrefs, scheduleStructurePrefSave } from '../state/structurePrefs.js';
import { cartToFrac, fracToCart, invert3x3, transpose3x3 } from '../math/index.js';
import { applyTransparency } from '../utils/TransparencyPolicy.js';
import { requestRender } from './AnimateModule.js';
import { syncArrowTransparency } from './ArrowMaterial.js';
import { applyFocusToPolyhedra } from './PolyhedraModule.js';
import { applyFocusToChargeBadges } from './ChargeBadgeModule.js';
import { applyFocusToHydrogenBonds } from './HydrogenBondModule.js';

export const DEFAULT_FOCUS_REGION = Object.freeze({
  enabled: true,
  innerEnabled: true,
  innerRadius: 3.5,
  innerOpacity: 1,
  outerOpacity: 0.15,
  // Radial gradient (the default): the outer part of the inner sphere ramps
  // linearly from the inner opacity down to the outer opacity at the inner
  // radius. gradientFraction is the share of the inner radius that ramps
  // (0 = hard edge, 1 = ramp from the center). Off = the hard edge.
  gradientEnabled: true,
  gradientFraction: 0.5,
  // How a polyhedron follows the rule: 'average' of its atoms' focus opacity,
  // or the region rule evaluated at its own 'position' (centroid).
  polyhedraMode: 'average',
  excludedSourceIndices: [],
  centerOffsetFrac: [0, 0, 0],
});

export const POLYHEDRA_FOCUS_MODES = Object.freeze(['average', 'position']);

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

// ---- Lattice-periodic evaluation -------------------------------------------
// A focus region repeats with the lattice: the rule is evaluated at the
// minimum-image distance from the center, so every periodic image of the
// focus atom the display boundary reveals is the center of its own identical
// sphere, and all drawn images of any atom agree on one focus opacity. That
// agreement is what lets the field's boundary copies share one geometry and
// the arrows key on source atoms.

/** Real-space lattice plus the Cartesian->fractional inverse the distance
 * needs, or null for a structure without a usable cell (then plain distance). */
export function periodicBasis(lattice) {
  if (!Array.isArray(lattice) || lattice.length !== 3) return null;
  try {
    return { lattice, inverse: invert3x3(transpose3x3(lattice)) };
  } catch {
    return null;
  }
}

/** Minimum-image distance between two Cartesian points. The fractional
 * difference is wrapped to [-0.5, 0.5), then the 8 images reached by shifting
 * each component by a whole cell toward the origin are compared: for a
 * reduced cell the nearest image is always among them, which the wrapped
 * vector alone does not guarantee for skewed (e.g. hexagonal) cells. */
export function minimumImageDistance(point, center, basis) {
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  const dz = point[2] - center[2];
  if (!basis) return Math.hypot(dx, dy, dz);
  const inv = basis.inverse;
  const L = basis.lattice;
  let fx = inv[0][0] * dx + inv[0][1] * dy + inv[0][2] * dz;
  let fy = inv[1][0] * dx + inv[1][1] * dy + inv[1][2] * dz;
  let fz = inv[2][0] * dx + inv[2][1] * dy + inv[2][2] * dz;
  fx -= Math.round(fx);
  fy -= Math.round(fy);
  fz -= Math.round(fz);
  const ax = fx > 0 ? fx - 1 : fx + 1;
  const ay = fy > 0 ? fy - 1 : fy + 1;
  const az = fz > 0 ? fz - 1 : fz + 1;
  let best = Infinity;
  for (let i = 0; i < 8; i++) {
    const u = (i & 1) ? ax : fx;
    const v = (i & 2) ? ay : fy;
    const w = (i & 4) ? az : fz;
    const cx = u * L[0][0] + v * L[1][0] + w * L[2][0];
    const cy = u * L[0][1] + v * L[1][1] + w * L[2][1];
    const cz = u * L[0][2] + v * L[1][2] + w * L[2][2];
    const d2 = cx * cx + cy * cy + cz * cz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Distance from a Cartesian point to the nearest periodic image of a region
 * center (plain distance for a structure without a cell). */
export function focusDistanceTo(point, region, structure = fileBrowser.selectedStructure) {
  if (!region?.center?.length) return Infinity;
  return minimumImageDistance(point, region.center, periodicBasis(structure?.lattice));
}

/** Visibility proposed by one region for a Cartesian point. `basis` (see
 * periodicBasis) makes the rule lattice-periodic; null evaluates it in open
 * space. The atoms a region was created from get no special treatment: they
 * sit at the center and follow the rule like every other inner atom. Only the
 * exclusion list exempts an atom. */
export function focusOpacityAt(point, region, sourceIndex = -1, basis = null) {
  if (!region?.enabled || !region.center?.length) return 1;
  if (region.excludedSourceIndices?.includes(sourceIndex)) return 1;
  const outerOpacity = clamp01(region.outerOpacity);
  if (!region.innerEnabled) return outerOpacity;
  const distance = minimumImageDistance(point, region.center, basis);
  const innerRadius = Math.max(0, Number(region.innerRadius) || 0);
  if (distance > innerRadius) return outerOpacity;
  const innerOpacity = clamp01(region.innerOpacity);
  // The gradient shell is the outer part of the inner sphere: full inner
  // opacity up to gradientStartRadius, then a linear ramp that reaches the
  // outer opacity exactly at the inner radius, so the boundary is seamless.
  const start = gradientStartRadius(region);
  if (!region.gradientEnabled || distance <= start || innerRadius <= start) return innerOpacity;
  const t = (distance - start) / (innerRadius - start);
  return innerOpacity + (outerOpacity - innerOpacity) * Math.max(0, Math.min(1, t));
}

/** Where the gradient ramp begins (Å from the center): the inner radius
 * minus the fraction of it given to the gradient. */
export function gradientStartRadius(region) {
  const innerRadius = Math.max(0, Number(region?.innerRadius) || 0);
  return innerRadius * (1 - clamp01(region?.gradientFraction ?? DEFAULT_FOCUS_REGION.gradientFraction));
}

/** Multiple regions combine by maximum visibility: importance in one region
 * cannot be cancelled by another region. */
export function combinedFocusOpacity(point, sourceIndex, regions, basis = null) {
  const enabled = (regions ?? []).filter((region) => region?.enabled && region.center?.length);
  if (!enabled.length) return 1;
  // Exclusions are global: an atom excluded in any region is never dimmed.
  if (enabled.some((region) => region.excludedSourceIndices?.includes(sourceIndex))) return 1;
  let opacity = 0;
  for (const region of enabled) opacity = Math.max(opacity, focusOpacityAt(point, region, sourceIndex, basis));
  return opacity;
}

export function getFocusRegions(structure = fileBrowser.selectedStructure) {
  const regions = structure?.focusRegions ?? [];
  for (const region of regions) {
    // One-development-version migration: the former three-zone model called
    // the true outside value `beyondOpacity` and used outerOpacity for a shell.
    if (Object.hasOwn(region, 'beyondOpacity')) {
      region.outerOpacity = clamp01(region.beyondOpacity);
      delete region.beyondOpacity;
      delete region.outerRadius;
    }
    // Regions saved before the gradient / polyhedra settings existed keep the
    // hard edge they were authored with; only new regions default to a gradient.
    if (typeof region.gradientEnabled !== 'boolean') region.gradientEnabled = false;
    // One-development-version migration: the gradient briefly extended
    // OUTSIDE the inner sphere to an absolute gradientRadius.
    if (Object.hasOwn(region, 'gradientRadius')) delete region.gradientRadius;
    if (!Number.isFinite(Number(region.gradientFraction))) {
      region.gradientFraction = DEFAULT_FOCUS_REGION.gradientFraction;
    }
    region.gradientFraction = clamp01(region.gradientFraction);
    if (!POLYHEDRA_FOCUS_MODES.includes(region.polyhedraMode)) region.polyhedraMode = 'average';
  }
  return regions;
}

/** True when at least one region can change what is drawn. */
export function focusRegionsActive(structure = fileBrowser.selectedStructure) {
  return getFocusRegions(structure).some((region) => region?.enabled !== false && region.center?.length);
}

/** Keep centers attached to their chosen periodic atom copies as coordinates
 * move. Stable image keys survive ordinary mesh rebuilds and trajectory frames. */
export function prepareFocusRegions(structure = fileBrowser.selectedStructure) {
  const wrapped = structure?.periodic?.visibleWrapped;
  if (!wrapped) return;
  for (const region of getFocusRegions(structure)) {
    const indices = (region.centerImageKeys ?? []).map((key) =>
      structure.atomImageKeys?.indexOf(key)).filter((index) => index >= 0);
    if (!indices.length) continue;
    const anchor = [0, 1, 2].map((axis) =>
      indices.reduce((sum, index) => sum + wrapped.cart[index][axis], 0) / indices.length);
    region.anchorCenterFrac = cartToFrac(anchor, structure.lattice);
    const offset = region.centerOffsetFrac?.length === 3 ? region.centerOffsetFrac : [0, 0, 0];
    region.centerFractional = region.anchorCenterFrac.map((value, axis) => value + Number(offset[axis] || 0));
    region.center = fracToCart([region.centerFractional], structure.lattice)[0];
  }
}

/** Move a region center in fractional coordinates while keeping it attached
 * to the selected atom-image centroid through subsequent frame updates. */
export function setFocusRegionCenterFractional(region, fractional,
  structure = fileBrowser.selectedStructure) {
  if (!region || !structure?.lattice || fractional?.length !== 3) return false;
  prepareFocusRegions(structure);
  const next = fractional.map(Number);
  if (!next.every(Number.isFinite)) return false;
  const anchor = region.anchorCenterFrac?.length === 3
    ? region.anchorCenterFrac : cartToFrac(region.center, structure.lattice);
  region.centerOffsetFrac = next.map((value, axis) => value - anchor[axis]);
  region.centerFractional = next;
  region.center = fracToCart([next], structure.lattice)[0];
  applyFocusRegions(structure);
  return true;
}

export function resetFocusRegionCenter(region, structure = fileBrowser.selectedStructure) {
  if (!region) return;
  region.centerOffsetFrac = [0, 0, 0];
  prepareFocusRegions(structure);
  applyFocusRegions(structure);
}

export function getFocusOpacityForInstance(instanceIndex, structure = fileBrowser.selectedStructure) {
  const wrapped = structure?.periodic?.visibleWrapped;
  const point = wrapped?.cart?.[instanceIndex];
  if (!point) return 1;
  return combinedFocusOpacity(point, wrapped.srcIndex?.[instanceIndex] ?? instanceIndex,
    getFocusRegions(structure), periodicBasis(structure.lattice));
}

/** Focus opacity of one polyhedron (model/Polyhedron: Cartesian `vertices`,
 * `vertexSrcList`, optional `centerIndex`). Each region proposes a value by
 * its own polyhedraMode — the mean of its atoms' focus opacity, or the rule at
 * the polyhedron centroid — and regions combine by maximum, as for atoms. */
export function focusOpacityForPolyhedron(poly, regions, basis = null) {
  const enabled = (regions ?? []).filter((region) => region?.enabled && region.center?.length);
  const vertices = poly?.vertices ?? [];
  if (!enabled.length || !vertices.length) return 1;
  const centroid = [0, 1, 2].map((axis) =>
    vertices.reduce((sum, vertex) => sum + Number(vertex[axis]), 0) / vertices.length);
  const centerSource = Number.isInteger(poly.centerIndex) ? poly.centerIndex : -1;
  const atoms = vertices.map((vertex, index) => ({
    point: vertex, source: poly.vertexSrcList?.[index] ?? -1,
  }));
  if (centerSource >= 0) atoms.push({ point: centroid, source: centerSource });
  // Exclusions are global (see combinedFocusOpacity).
  const isExcluded = (source) => source >= 0 && enabled.some((region) =>
    region.excludedSourceIndices?.includes(source));
  if (isExcluded(centerSource)) return 1;
  let opacity = 0;
  for (const region of enabled) {
    let proposal;
    if (region.polyhedraMode === 'position') {
      proposal = focusOpacityAt(centroid, region, centerSource, basis);
    } else {
      proposal = atoms.reduce((sum, atom) => sum
        + (isExcluded(atom.source) ? 1 : focusOpacityAt(atom.point, region, atom.source, basis)), 0) / atoms.length;
    }
    opacity = Math.max(opacity, proposal);
  }
  return clamp01(opacity);
}

export function getFocusOpacityForPolyhedron(poly, structure = fileBrowser.selectedStructure) {
  return focusOpacityForPolyhedron(poly, getFocusRegions(structure), periodicBasis(structure?.lattice));
}

export function createFocusRegion(centerAtoms, structure = fileBrowser.selectedStructure) {
  if (!structure || !centerAtoms?.length) return null;
  const positions = centerAtoms.map((atom) => {
    const p = atom.position;
    if (Array.isArray(p) && p.length >= 3) return p;
    if (p && [p.x, p.y, p.z].every(Number.isFinite)) return [p.x, p.y, p.z];
    return null;
  }).filter(Boolean);
  if (!positions.length) return null;
  const center = [0, 1, 2].map((axis) =>
    positions.reduce((sum, position) => sum + Number(position[axis]), 0) / positions.length);
  const region = {
    ...DEFAULT_FOCUS_REGION,
    id: `focus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    center,
    centerFractional: cartToFrac(center, structure.lattice),
    centerOffsetFrac: [0, 0, 0],
    centerSourceIndices: [...new Set(centerAtoms.map((atom) => atom.sourceIndex)
      .filter(Number.isInteger))],
    centerImageKeys: [...new Set(centerAtoms.map((atom) =>
      structure.atomImageKeys?.[atom.instanceId]).filter(Boolean))],
    excludedSourceIndices: [],
  };
  (structure.focusRegions ??= []).push(region);
  applyFocusRegions();
  return region;
}

/** The regions as plain JSON (what ShareModule's captureState stores too);
 *  [] when there are none, which drops the stored field. */
function serializeFocusRegions(structure) {
  const regions = structure?.focusRegions;
  return Array.isArray(regions) && regions.length ? JSON.parse(JSON.stringify(regions)) : [];
}

/**
 * Re-apply the focus regions saved for this container in an earlier session
 * to the frame now on screen. Regions live on the displayed Structure (not in
 * a trajectory's per-frame records), so unlike the atom colours this runs
 * AFTER the first frame exists — from ui/StructureInputModule.js's
 * initializeUIOnLoad, right after the row is selected — and repaints the
 * per-instance opacity itself. `structure` must belong to `container` (an
 * asynchronously materialised first frame isn't selected yet: nothing is
 * applied then). Returns the number of regions applied.
 * @param {any} container a StructureContainer
 * @param {any} [structure] the displayed frame
 * @returns {number}
 */
export function restoreFocusRegions(container, structure = fileBrowser.selectedStructure) {
  const regions = readStructurePrefs(container)?.focusRegions;
  if (!Array.isArray(regions) || !regions.length || !structure) return 0;
  const owns = typeof container?.ownsStructure === 'function'
    ? container.ownsStructure(structure) : !!container?.structures?.includes(structure);
  if (!owns) return 0;
  structure.focusRegions = JSON.parse(JSON.stringify(regions));
  applyFocusRegions(structure);
  return structure.focusRegions.length;
}

export function removeFocusRegion(id, structure = fileBrowser.selectedStructure) {
  if (!structure?.focusRegions) return;
  structure.focusRegions = structure.focusRegions.filter((region) => region.id !== id);
  applyFocusRegions();
}

export function clearFocusRegions(structure = fileBrowser.selectedStructure) {
  if (structure) structure.focusRegions = [];
  applyFocusRegions();
}

export function applyFocusRegions(structure = fileBrowser.selectedStructure) {
  // Every focus-region edit (panel sliders/toggles, create/remove/clear,
  // centre edits) ends here, so this is the one place the regions get
  // persisted for the next session (state/structurePrefs.js; debounced —
  // sliders fire per pointer move and fast-frame playback calls this per
  // frame). Stored by structure content, so the same file re-opened after a
  // reload gets its regions back (restoreFocusRegions below).
  if (structure) scheduleStructurePrefSave(structure, 'focusRegions', () => serializeFocusRegions(structure));
  const mesh = groups.atomsMesh;
  const wrapped = structure?.periodic?.visibleWrapped;
  const opacityAttr = mesh?.geometry?.attributes?.instanceOpacity;
  if (!wrapped) return;
  prepareFocusRegions(structure);
  if (mesh && opacityAttr) {
    let hasTransparency = general.mainOpacity < 0.999;
    for (let i = 0; i < wrapped.cart.length; i++) {
      const src = wrapped.srcIndex?.[i] ?? i;
      const atom = structure.atoms[src];
      const imageAlpha = structure.atomImageStyles?.[structure.atomImageKeys?.[i]]?.alpha;
      const authored = imageAlpha ?? atom?.getOpacity?.() ?? atom?.opacity ?? 1;
      const opacity = clamp01(authored) * getFocusOpacityForInstance(i, structure);
      opacityAttr.setX(i, opacity);
      if (opacity < 0.999) hasTransparency = true;
    }
    opacityAttr.needsUpdate = true;
    applyTransparency(mesh.material, {
      kind: 'atoms', opacity: general.mainOpacity, needsTransparency: hasTransparency,
      perInstanceOpacity: true, mesh,
    });
  }
  const bondMesh = groups.bondsMesh;
  if (bondMesh && structure.bonds?.length) {
    const bondOpacity = bondMesh.geometry?.attributes?.instanceOpacity;
    structure.bonds.filter((bond) => bond.visibleLen > 1e-3).forEach((bond, index) => {
      const focus = Math.min(
        getFocusOpacityForInstance(bond.indices[0], structure),
        getFocusOpacityForInstance(bond.indices[1], structure),
      );
      const opacity = clamp01(bond.alpha ?? 1) * focus;
      bondOpacity?.setX(index * 2, opacity);
      bondOpacity?.setX(index * 2 + 1, opacity);
    });
    if (bondOpacity) bondOpacity.needsUpdate = true;
    const focusTransparent = getFocusRegions(structure).some((region) =>
      region.enabled !== false && region.center?.length);
    applyTransparency(bondMesh.material, {
      kind: 'bonds', opacity: general.mainOpacity,
      needsTransparency: general.mainOpacity < 0.999 || focusTransparent,
      perInstanceOpacity: true, mesh: bondMesh,
    });
  }
  applyFocusToArrows(structure, 'forces');
  applyFocusToArrows(structure, 'spins');
  applyFocusToPolyhedra(structure);
  applyFocusToField(structure);
  applyFocusToChargeBadges(structure);
  applyFocusToHydrogenBonds(structure);
  requestRender();
}

const _fieldPoint = [0, 0, 0];

/** The volumetric field follows the region rule per vertex. The material keeps
 * the Field panel's opacity as the maximum; the focus factor is written to a
 * four-component vertex `color` attribute (three.js USE_COLOR_ALPHA), so the
 * isosurface fades exactly where the atoms around it do. Without active
 * regions the attribute is removed and the material is restored. */
export function applyFocusToField(structure = fileBrowser.selectedStructure) {
  const iso = groups.isosurfaceGroup;
  const meshes = iso?.meshes;
  if (!meshes) return;
  const regions = getFocusRegions(structure).filter((region) =>
    region?.enabled && region.center?.length);
  // The rule is lattice-periodic, so the alpha written for the base surface is
  // exactly right for the boundary copies that share its geometry too.
  const basis = periodicBasis(structure?.lattice);
  iso.updateMatrixWorld?.(true);
  for (const mesh of [meshes.positive, meshes.negative]) {
    const geometry = mesh?.geometry;
    const material = mesh?.material;
    if (!geometry || !material) continue;
    const position = geometry.getAttribute('position');
    if (!regions.length || !position?.count) {
      if (geometry.getAttribute('color')) geometry.deleteAttribute('color');
      if (material.vertexColors) {
        material.vertexColors = false;
        material.needsUpdate = true;
      }
      applyTransparency(material, { kind: 'isosurface', opacity: material.opacity, mesh });
      continue;
    }
    let color = geometry.getAttribute('color');
    if (!color || color.itemSize !== 4 || color.count !== position.count) {
      color = new THREE.BufferAttribute(new Float32Array(position.count * 4), 4);
      geometry.setAttribute('color', color);
    }
    const m = mesh.matrixWorld.elements;
    const src = position.array;
    const dst = /** @type {Float32Array} */ (color.array);
    let minAlpha = 1;
    for (let i = 0; i < position.count; i++) {
      const x = src[i * 3];
      const y = src[i * 3 + 1];
      const z = src[i * 3 + 2];
      _fieldPoint[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
      _fieldPoint[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      _fieldPoint[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      let alpha = 0;
      for (const region of regions) alpha = Math.max(alpha, focusOpacityAt(_fieldPoint, region, -1, basis));
      dst[i * 4] = 1;
      dst[i * 4 + 1] = 1;
      dst[i * 4 + 2] = 1;
      dst[i * 4 + 3] = alpha;
      if (alpha < minAlpha) minAlpha = alpha;
    }
    color.needsUpdate = true;
    if (!material.vertexColors) {
      material.vertexColors = true;
      material.needsUpdate = true;
    }
    applyTransparency(material, {
      kind: 'isosurface', opacity: material.opacity, needsTransparency: minAlpha < 0.999, mesh,
    });
  }
}

export function applyFocusToArrows(structure = fileBrowser.selectedStructure, kind) {
  const prefix = kind === 'forces' ? 'forces' : 'spin';
  // arrow indices per source atom (SpinModule/ForceModule: one arrow per drawn
  // atom image, so a LIST per atom)
  const lists = groups[`${kind}InstancesBySrcIndex`];
  const shaft = groups[`${prefix}ShaftMesh`];
  const tip = groups[`${prefix}TipMesh`];
  if (!lists || !shaft || !tip) return;
  const shaftOpacity = shaft.geometry?.attributes?.instanceOpacity;
  const tipOpacity = tip.geometry?.attributes?.instanceOpacity;
  const wrapped = structure?.periodic?.visibleWrapped;
  const firstInstance = new Map();
  wrapped?.srcIndex?.forEach((src, index) => { if (!firstInstance.has(src)) firstInstance.set(src, index); });
  let transparent = false;
  for (const [src, arrowIndices] of lists) {
    // The rule is lattice-periodic, so every drawn image of an atom shares one
    // focus opacity: any one atom instance stands for all of its arrows.
    const instance = firstInstance.get(src);
    const opacity = instance == null ? 1 : getFocusOpacityForInstance(instance, structure);
    for (const arrowIndex of arrowIndices) {
      shaftOpacity?.setX(arrowIndex * 2, opacity);
      shaftOpacity?.setX(arrowIndex * 2 + 1, opacity);
      tipOpacity?.setX(arrowIndex, opacity);
    }
    if (opacity < 0.999) transparent = true;
  }
  if (shaftOpacity) shaftOpacity.needsUpdate = true;
  if (tipOpacity) tipOpacity.needsUpdate = true;
  syncArrowTransparency(shaft, transparent);
  syncArrowTransparency(tip, transparent);
}
